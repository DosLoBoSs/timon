# Exports one skull's rigged model as JSON (agent_<shape>.json), which gen-data.mjs quantises into the app's model data.
# Body: positions, normals, per-vertex fur length factor, ear id. Visor: positions, normals, UV. Atlas: data URI.
import bpy,bmesh,base64,json,math,sys
import numpy as np
from pathlib import Path
MASTER=sys.argv[sys.argv.index('--file')+1];OUT=Path(sys.argv[sys.argv.index('--out')+1]);OUT.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=MASTER)
dg=bpy.context.evaluated_depsgraph_get()
def to_three(a):return np.stack([a[:,0],a[:,2],-a[:,1]],1)  # Blender Z-up -> three.js Y-up
def b64(a,dt):return base64.b64encode(np.ascontiguousarray(a,dtype=dt).tobytes()).decode()
BONES=['body','top','ear.L','ear_tip.L','ear.R','ear_tip.R']
def mesh_arrays(obj,want_uv):
    ev=obj.evaluated_get(bpy.context.evaluated_depsgraph_get());me=ev.to_mesh();me.calc_loop_triangles()
    names=[g.name for g in obj.vertex_groups]
    # Two strongest bone influences per vertex (the rig never needs more).
    J=np.zeros((len(me.vertices),2));W=np.zeros((len(me.vertices),2))
    for v in me.vertices:
        gs=sorted([(g.weight,BONES.index(names[g.group])) for g in v.groups if names[g.group] in BONES],reverse=True)[:2]
        tot=sum(w for w,_ in gs) or 1
        for i,(w,b) in enumerate(gs):J[v.index,i]=b;W[v.index,i]=w/tot
    P=np.array([v.co for v in me.vertices]);LN=np.array([n.vector for n in me.corner_normals])
    UV=np.array([d.uv for d in me.uv_layers.active.data]) if want_uv else None
    key={};pos=[];nrm=[];uv=[];src=[];idx=[]
    for t in me.loop_triangles:
        for li in t.loops:
            vi=me.loops[li].vertex_index
            k=(vi,tuple(np.round(LN[li],3)))+((tuple(np.round(UV[li],5)),) if want_uv else ())
            if k not in key:
                key[k]=len(pos);pos.append(P[vi]);nrm.append(LN[li]);src.append(vi)
                if want_uv:uv.append(UV[li])
            idx.append(key[k])
    ev.to_mesh_clear();src=np.array(src)
    return np.array(pos),np.array(nrm),(np.array(uv) if want_uv else None),src,np.array(idx),J[src],W[src]
body=bpy.data.objects['Agent'];visor=bpy.data.objects['Agent_Visor']
# Islands: largest = head/body, the other two = ears.
bm=bmesh.new();bm.from_mesh(body.data);bm.verts.ensure_lookup_table()
island=np.full(len(bm.verts),-1);k=0
for v in bm.verts:
    if island[v.index]>=0:continue
    stack=[v]
    while stack:
        u=stack.pop()
        if island[u.index]>=0:continue
        island[u.index]=k;stack+=[e.other_vert(u) for e in u.link_edges]
    k+=1
bm.free()
sizes=np.bincount(island);main=int(np.argmax(sizes))
VC=(0.,body['visor'][0]);VW,VH,VN=body['visor'][1],body['visor'][2],3.2;SH=body['sh'];SHAPE=body['skull']
def fur_attrs(pos,nrm,isl,main):
    d=(np.abs(2*(pos[:,0]-VC[0])/VW)**VN+np.abs(2*(pos[:,2]-VC[1])/VH)**VN)**(1/VN)
    front=(nrm[:,1]<-.15)&(pos[:,1]<0)
    fur=np.where(front&(isl==main),np.where(d<1,0,np.clip(.35+(d-1)/.4*.65,.35,1)),1.0)
    fur*=1+.12*np.clip(.3-pos[:,2],0,1)/.3
    ear=np.zeros(len(pos))
    for i in set(isl.tolist()):
        if i==main:continue
        m=isl==i;fur[m]=.55;ear[m]=np.sign(pos[m,0].mean())
    return fur,ear
rig=bpy.data.objects['Agent_Rig'];rig.animation_data_create();rig.animation_data.action=None
for pb in rig.pose.bones:pb.matrix_basis.identity()
bpy.context.view_layer.update()
pos,nrm,_,src,idx,bj,bw=mesh_arrays(body,False)
fur,ear=fur_attrs(pos,nrm,island[src],main)
# Light body for the mid/low quality tiers: same shape, ~1/4 of the triangles.
lo=body.copy();lo.data=body.data.copy();bpy.context.scene.collection.objects.link(lo)
dm=lo.modifiers.new('lo','DECIMATE');dm.ratio=.25
lpos,lnrm,_,lsrc,lidx,lj,lw=mesh_arrays(lo,False)
# Islands survive decimation; recover them by nearest original vertex.
from mathutils.kdtree import KDTree
kd=KDTree(len(body.data.vertices))
for v in body.data.vertices:kd.insert(v.co,v.index)
kd.balance()
lisl=np.array([island[kd.find(p)[1]] for p in lpos])
lfur,lear=fur_attrs(lpos,lnrm,lisl,main)
# The visor's subdivision is for Cycles close-ups: at avatar sizes its 24 x 24 grid is smooth enough, at a quarter of the weight.
for m in visor.modifiers:
    if m.type=='SUBSURF':m.show_viewport=False
bpy.context.view_layer.update()
vpos,vnrm,vuv,_,vidx,_,_=mesh_arrays(visor,True)
# Bone pose texture: row 0 = rest, then one row per frame of each clip; 6 bones x 4 texels (mat4 columns).
C=np.array([[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]],float);Ci=np.linalg.inv(C)
def pose_row():
    bpy.context.view_layer.update();row=[]
    for n in BONES:
        pb=rig.pose.bones[n];M=np.array(pb.matrix@pb.bone.matrix_local.inverted())
        row.append((C@M@Ci).T.reshape(-1))     # column-major for GLSL mat4
    return np.concatenate(row)
rows=[pose_row()];clips={}
for name in ('hop','hop_big','startle','grab','happy'):
    act=bpy.data.actions[name];rig.animation_data.action=act;f0,f1=[int(x) for x in act.frame_range]
    clips[name]={'row':len(rows),'frames':f1-f0+1}
    for f in range(f0,f1+1):bpy.context.scene.frame_set(f);rows.append(pose_row())
rig.animation_data.action=None
anim=np.array(rows,np.float32)
atlas=bpy.data.images['Visor_Expressions'];atlas.filepath_raw=str(OUT/'atlas_tmp.png');atlas.file_format='PNG';atlas.save()
data={'body':{'pos':b64(to_three(pos),'<f4'),'nrm':b64(to_three(nrm),'<f4'),'fur':b64(fur,'<f4'),'ear':b64(ear,'<f4'),'idx':b64(idx,'<u4'),'j':b64(bj,'<f4'),'w':b64(bw,'<f4')},
      'bodyLo':{'pos':b64(to_three(lpos),'<f4'),'nrm':b64(to_three(lnrm),'<f4'),'fur':b64(lfur,'<f4'),'ear':b64(lear,'<f4'),'idx':b64(lidx,'<u4'),'j':b64(lj,'<f4'),'w':b64(lw,'<f4')},
      'anim':{'bones':len(BONES),'rows':len(rows),'data':b64(anim,'<f4'),'clips':clips,'fps':30},
      'visor':{'pos':b64(to_three(vpos),'<f4'),'nrm':b64(to_three(vnrm),'<f4'),'uv':b64(vuv,'<f4'),'idx':b64(vidx,'<u4')},
      'atlas':'data:image/png;base64,'+base64.b64encode((OUT/'atlas_tmp.png').read_bytes()).decode(),
      # Ear pivots (three.js space): base of each ear where it meets the head.
      'earPivot':{k:[float(h.x),float(h.z),float(-h.y)] for k in 'LR' for h in [rig.data.bones['ear.'+k].head_local]},'furLength':.095,'height':float(pos[:,2].max()),'halfWidth':float(np.abs(pos[:,0]).max()),
      # Where the head turns (the 'top' bone root) and the visor's aspect against the classic one: the eyes keep their shape on every skull.
      'headPivot':.44*SH,'visorAspect':(VW/VH)/(.74/.42)}
(OUT/'atlas_tmp.png').unlink()
del data['atlas']   # the app draws Timon's own eye glyphs on the visor
(OUT/('agent_%s.json'%SHAPE)).write_text(json.dumps(data))
print('EXPORT body verts',len(pos),'tris',len(idx)//3,'lo tris',len(lidx)//3,'visor verts',len(vpos),'tris',len(vidx)//3,'kB',(OUT/('agent_%s.json'%SHAPE)).stat().st_size//1024,flush=True)
