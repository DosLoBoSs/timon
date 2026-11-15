# Builds the 3D mascot for one of Timon's seven skulls (--shape): the same model, its proportions taken from the skull.
# Master model for the furry "Agent": clean quad body + ears, flush visor with expression atlas,
# groomable Hair Curves attached to the body surface (follows any future armature deformation).
import bpy,bmesh,math,sys
import numpy as np
from pathlib import Path
from mathutils import Vector,Matrix
from mathutils.bvhtree import BVHTree
def arg(k,d=None):return sys.argv[sys.argv.index(k)+1] if k in sys.argv else d
SHAPE=arg('--shape','squircle');ROOT=Path(arg('--out'));ROOT.mkdir(parents=True,exist_ok=True)
# Timon's skulls (app/src/components/mascot/mascot-geometry.ts): top width, bottom width, height, corner radius in a 100 x 100 box.
SKULLS={'squircle':(82,82,66,26),'tri':(62,88,70,24),'gem':(86,66,72,28),'round':(74,74,74,36),'bean':(94,94,54,24),'cloud':(62,66,82,28),'hex':(80,80,72,11)}
TW,BW,HH,RR=SKULLS[SHAPE]
# Ratios to the classic skull the model was sculpted as; SN = superellipse exponent of the front outline (2 = round, higher = squarer).
ST,SB,SH=TW/82,BW/82,HH/66;SN=2+max(0,24-RR)/13*2.5
def wscale(Z):return SB+(ST-SB)*min(1,max(0,Z/(.905*SH)))
STRANDS=int(sys.argv[sys.argv.index('--strands')+1]) if '--strands' in sys.argv else 150000
SEG=10
rng=np.random.default_rng(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene

# ---------- quad-sphere builder: 6 grid patches, each its own UV island ----------
def quad_sphere(n,shape,uv_cells):
    verts=[];faces=[];uvs=[]
    axes=[((1,0,0),(0,1,0),(0,0,1)),((-1,0,0),(0,0,1),(0,1,0)),((0,1,0),(0,0,1),(1,0,0)),
          ((0,-1,0),(1,0,0),(0,0,1)),((0,0,1),(1,0,0),(0,1,0)),((0,0,-1),(0,1,0),(1,0,0))]
    for fi,(nrm,t1,t2) in enumerate(axes):
        base=len(verts);nv=np.array(nrm,float);a=np.array(t1,float);b=np.array(t2,float)
        for i in range(n+1):
            for j in range(n+1):
                c=nv+(2*i/n-1)*a+(2*j/n-1)*b
                x,y,z=c
                # Spherified cube: even quad sizes over the sphere.
                s=np.array([x*math.sqrt(max(0,1-y*y/2-z*z/2+y*y*z*z/3)),y*math.sqrt(max(0,1-z*z/2-x*x/2+z*z*x*x/3)),z*math.sqrt(max(0,1-x*x/2-y*y/2+x*x*y*y/3))])
                verts.append(shape(s))
        u0,v0,du,dv=uv_cells[fi]
        for i in range(n):
            for j in range(n):
                q=(base+i*(n+1)+j,base+(i+1)*(n+1)+j,base+(i+1)*(n+1)+j+1,base+i*(n+1)+j+1)
                faces.append(q)
                m=.004
                uvs.append([(u0+m+(du-2*m)*ii/n,v0+m+(dv-2*m)*jj/n) for ii,jj in ((i,j),(i+1,j),(i+1,j+1),(i,j+1))])
    return verts,faces,uvs
def build_mesh(name,verts,faces,uvs):
    me=bpy.data.meshes.new(name);me.from_pydata([tuple(v) for v in verts],[],faces);me.update()
    uv=me.uv_layers.new(name='UVMap')
    for f,fu in zip(me.polygons,uvs):
        for li,c in zip(f.loop_indices,fu):uv.data[li].uv=c
    bm=bmesh.new();bm.from_mesh(me);bmesh.ops.remove_doubles(bm,verts=bm.verts,dist=1e-6)
    bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(me);bm.free()
    for p in me.polygons:p.use_smooth=True
    return me
def cells(row_v0,row_h):return [(k/6,row_v0,1/6,row_h) for k in range(6)]

# Body: rounded blob, wider low, flattened sitting base. Height ~0.92, origin at ground centre.
def body_shape(s):
    x,y,z=s
    if SN>2:
        th=math.atan2(z,x);f=(abs(math.cos(th))**SN+abs(math.sin(th))**SN)**(-1/SN);x*=f;z*=f
    w=1+.10*max(-z,0)-.05*max(z,0)
    Z=z*.50
    if Z<-.36:Z=-.36-(-.36-Z)*.3
    Z=(Z+.405)*SH;k=wscale(Z)
    # Depth follows the width only halfway: a wide skull is not a deep one.
    return (x*.60*w*k,y*.52*w*(1+k)/2,Z)
bv,bf,bu=quad_sphere(16,body_shape,cells(.4,.6))
body_me=build_mesh('Agent_Body',bv,bf,bu)
bvh_body=BVHTree.FromPolygons([tuple(v.co) for v in body_me.vertices],[tuple(p.vertices) for p in body_me.polygons])

# Ears: thick rounded discs facing forward, half sunk into the head.
EARS=[]
for side,row in ((1,.2),(-1,0.)):
    # Ears sit on the skull's side at their usual height, half sunk into it.
    hit=bvh_body.ray_cast(Vector((side*3,.04,.60*SH)),Vector((-side,0,0)))[0]
    c=Vector((hit.x+side*.012,.04,.60*SH));R=Matrix.Rotation(-side*math.radians(46),3,'Y')
    def ear_shape(s,c=c,R=R):return tuple(c+R@Vector((s[0]*.145,s[1]*.072,s[2]*.145)))
    ev,ef,eu=quad_sphere(6,ear_shape,cells(row,.2));EARS.append((c,R,ev,ef,eu))
allv=list(bv);allf=list(bf);allu=list(bu)
for c,R,ev,ef,eu in EARS:
    o=len(allv);allv+=ev;allf+=[tuple(i+o for i in f) for f in ef];allu+=eu
NB_MERGED=len(body_me.vertices)
bpy.data.meshes.remove(body_me)
me=build_mesh('Agent_Body',allv,allf,allu)
body=bpy.data.objects.new('Agent',me)
coll=bpy.data.collections.new('Agent');scene.collection.children.link(coll);coll.objects.link(body)
body['fur_color']=[.52,.26,.08];body['expression']=0
body.id_properties_ui('fur_color').update(subtype='COLOR',min=0,max=1,description='Base fur colour (roots darker, tips lighter, computed in the shader)')
body.id_properties_ui('expression').update(min=0,max=5,description='0 open, 1 happy, 2 neutral, 3 ^^, 4 wink, 5 hearts')
# Ear shells get their own vertex groups so a future rig can weight them directly.
nb=NB_MERGED
vg={'Ear.L':body.vertex_groups.new(name='Ear.L'),'Ear.R':body.vertex_groups.new(name='Ear.R')}
bmc=bmesh.new();bmc.from_mesh(me);bmc.verts.ensure_lookup_table()
for v in bmc.verts:
    if v.co.z>.4 and abs(v.co.x)>.35:
        d=[(v.co-Vector(c)).length for c,*_ in EARS]
        k=int(np.argmin(d))
        if d[k]<.2:vg['Ear.L' if EARS[k][0].x>0 else 'Ear.R'].add([v.index],1.0,'REPLACE')
bmc.free()

# ---------- Visor: superellipse shell projected onto the face, sitting in the fur ----------
# The visor (the mask-screen) is the same size on every skull: only its height on the face follows the skull.
# The web engine shrinks a skull too wide or too tall for the tile (engine.js, `k`); the visor is built larger
# by the same factor so it keeps the classic size on screen.
_AV=np.array(allv);KS=min(1,(.84*1.66)/(2*np.abs(_AV[:,0]).max()),(.8*1.66)/_AV[:,2].max())
VC=(0.,.52*SH);VW,VH,VN=.74/KS,.42/KS,3.2
body['skull']=SHAPE;body['sh']=SH;body['visor']=[VC[1],VW,VH];body['ear_x']=float(abs(EARS[0][0].x))
def sedist(x,z):return (np.abs(2*(x-VC[0])/VW)**VN+np.abs(2*(z-VC[1])/VH)**VN)**(1/VN)
# All-quad grid mapped square -> disc -> superellipse: no pole, clean reflections.
G=24;vverts=[];vuv=[]
for i in range(G+1):
    for j in range(G+1):
        u=2*i/G-1;v=2*j/G-1
        dx=u*math.sqrt(1-v*v/2);dz=v*math.sqrt(1-u*u/2)
        r=min(1.0,math.hypot(dx,dz));th=math.atan2(dz,dx);c,sn=math.cos(th),math.sin(th)
        px=VC[0]+r*VW/2*math.copysign(abs(c)**(2/VN),c);pz=VC[1]+r*VH/2*math.copysign(abs(sn)**(2/VN),sn)
        hit,_,_,_=bvh_body.ray_cast(Vector((px,-2,pz)),Vector((0,1,0)))
        # Offset along a smooth radial direction (not the faceted hit normal).
        nd=(hit-Vector((0,.12,VC[1]))).normalized()
        p=hit+nd*(.030+.022*(1-r*r))
        vverts.append(tuple(p));vuv.append(((px-VC[0])/VW+.5,(pz-VC[1])/VH+.5))
vfaces=[(i*(G+1)+j,(i+1)*(G+1)+j,(i+1)*(G+1)+j+1,i*(G+1)+j+1) for i in range(G) for j in range(G)]
vme=bpy.data.meshes.new('Agent_Visor');vme.from_pydata(vverts,[],vfaces);vme.update()
uvl=vme.uv_layers.new(name='UVMap')
for f in vme.polygons:
    for li in f.loop_indices:uvl.data[li].uv=vuv[vme.loops[li].vertex_index]
bm=bmesh.new();bm.from_mesh(vme)
inner=[v for v in bm.verts if not v.is_boundary]
for _ in range(4):bmesh.ops.smooth_vert(bm,verts=inner,factor=.5,use_axis_x=True,use_axis_y=True,use_axis_z=True)
bmesh.ops.recalc_face_normals(bm,faces=bm.faces)
if sum(f.normal.y for f in bm.faces)>0:bmesh.ops.reverse_faces(bm,faces=bm.faces)
bm.to_mesh(vme);bm.free()
for p in vme.polygons:p.use_smooth=True
visor=bpy.data.objects.new('Agent_Visor',vme);coll.objects.link(visor);visor.parent=body
so=visor.modifiers.new('Shell thickness','SOLIDIFY');so.thickness=.035;so.offset=-1;so.use_even_offset=True;so.use_rim=True
ss=visor.modifiers.new('Smooth','SUBSURF');ss.levels=1;ss.render_levels=2

# ---------- Expression atlas (3x2 cells, visor UV space). R = LED core, G = halo ----------
CW,CH=600,334;AW,AH=CW*3,CH*2
yy,xx=np.mgrid[0:CH,0:CW];U=(xx+.5)/CW;V=(yy+.5)/CH
X=(U-.5)*VW/VH;Y=V-.5
def ell(cx,cy,a,b):return (np.sqrt(((X-cx)/a)**2+((Y-cy)/b)**2)-1)*min(a,b)
def seg(ax,ay,bx,by,r):
    px,py=X-ax,Y-ay;dx,dy=bx-ax,by-ay;h=np.clip((px*dx+py*dy)/(dx*dx+dy*dy),0,1)
    return np.hypot(px-dx*h,py-dy*h)-r
def arc(cx,cy,R,r,up=True):
    d=np.abs(np.hypot(X-cx,Y-cy)-R)-r
    return np.where((Y-cy>=0) if up else (Y-cy<=0),d,np.minimum(seg(cx-R,cy,cx-R,cy,r),seg(cx+R,cy,cx+R,cy,r)))
def heart(cx,cy,s):
    # Classic implicit heart, turned into an approximate distance with its gradient.
    x=(X-cx)/s*1.25;y=(Y-cy)/s*1.25+.1
    f=(x*x+y*y-1)**3-x*x*y**3
    gy,gx=np.gradient(f,1/CH,1/CH)
    return f/(np.hypot(gx,gy)+1e-6)
EX,EY,EA,EB,ST=.30,.02,.085,.12,.026
shapes=[
 lambda:np.minimum(ell(-EX,EY,EA,EB),ell(EX,EY,EA,EB)),
 lambda:np.minimum(arc(-EX,EY-.03,.075,ST),arc(EX,EY-.03,.075,ST)),
 lambda:np.minimum(seg(-EX-.075,EY,-EX+.075,EY,ST),seg(EX-.075,EY,EX+.075,EY,ST)),
 lambda:np.minimum.reduce([seg(-EX-.075,EY-.045,-EX,EY+.05,ST),seg(-EX,EY+.05,-EX+.075,EY-.045,ST),seg(EX-.075,EY-.045,EX,EY+.05,ST),seg(EX,EY+.05,EX+.075,EY-.045,ST)]),
 lambda:np.minimum.reduce([seg(-EX-.06,EY+.06,-EX+.06,EY,ST),seg(-EX+.06,EY,-EX-.06,EY-.06,ST),ell(EX,EY,EA,EB)]),
 lambda:np.minimum(heart(-EX,EY,.15),heart(EX,EY,.15)),
]
atlas=np.zeros((AH,AW,4),np.float32);atlas[...,3]=1
px=1/CH
for e,fn in enumerate(shapes):
    d=fn();core=np.clip(.5-d/(1.5*px),0,1);halo=np.exp(-np.maximum(d,0)/.035)
    col,row=e%3,e//3
    # Image rows go bottom-up in Blender: row 0 of the atlas = top cells.
    y0=(1-row)*CH;atlas[y0:y0+CH,col*CW:(col+1)*CW,0]=core;atlas[y0:y0+CH,col*CW:(col+1)*CW,1]=halo
img=bpy.data.images.new('Visor_Expressions',AW,AH,alpha=False,float_buffer=False)
img.pixels.foreach_set(atlas.ravel());img.filepath_raw=str(ROOT/'visor_expressions.png');img.file_format='PNG';img.save();img.pack()
img.colorspace_settings.name='Non-Color'

# ---------- Materials ----------
def sock(node,name,io='inputs'):
    return next(x for x in getattr(node,io) if x.name==name and x.type=='RGBA')
def driven_prop(target,prop,n=None):
    for i in (range(n) if n else [None]):
        fc=target.driver_add('["%s"]'%prop,i) if i is not None else target.driver_add('["%s"]'%prop)
        d=fc.driver;d.type='AVERAGE';v=d.variables.new();v.type='SINGLE_PROP'
        v.targets[0].id=body;v.targets[0].data_path='["%s"]'%prop+('[%d]'%i if i is not None else '')
def math_node(nt,op,a,b=None,loc=(0,0)):
    m=nt.nodes.new('ShaderNodeMath');m.operation=op;m.location=loc
    (nt.links.new(a,m.inputs[0]) if not isinstance(a,(int,float)) else m.inputs[0].__setattr__('default_value',a))
    if b is not None:(nt.links.new(b,m.inputs[1]) if not isinstance(b,(int,float)) else m.inputs[1].__setattr__('default_value',b))
    return m.outputs[0]
visor['expression']=0;driven_prop(visor,'expression')
vm=bpy.data.materials.new('Visor_LED');vm.use_nodes=True;nt=vm.node_tree;N=nt.nodes;L=nt.links
bsdf=next(n for n in N if n.type=='BSDF_PRINCIPLED');out=next(n for n in N if n.type=='OUTPUT_MATERIAL')
bsdf.inputs['Base Color'].default_value=(.004,.004,.005,1);bsdf.inputs['Roughness'].default_value=.14
bsdf.inputs['Coat Weight'].default_value=1;bsdf.inputs['Coat Roughness'].default_value=.02
tc=N.new('ShaderNodeTexCoord');at=N.new('ShaderNodeAttribute');at.attribute_type='INSTANCER';at.attribute_name='expression'
sep=N.new('ShaderNodeSeparateXYZ');L.new(tc.outputs['UV'],sep.inputs[0])
e=at.outputs['Fac'];col=math_node(nt,'FLOORED_MODULO',e,3);row=math_node(nt,'FLOOR',math_node(nt,'DIVIDE',e,3))
cu=math_node(nt,'DIVIDE',math_node(nt,'ADD',math_node(nt,'MINIMUM',math_node(nt,'MAXIMUM',sep.outputs[0],0),1),col),3)
cv=math_node(nt,'DIVIDE',math_node(nt,'ADD',math_node(nt,'MINIMUM',math_node(nt,'MAXIMUM',sep.outputs[1],0),1),math_node(nt,'SUBTRACT',1,row)),2)
cmb=N.new('ShaderNodeCombineXYZ');L.new(cu,cmb.inputs[0]);L.new(cv,cmb.inputs[1])
ti=N.new('ShaderNodeTexImage');ti.image=img;ti.extension='EXTEND';L.new(cmb.outputs[0],ti.inputs[0])
sc=N.new('ShaderNodeSeparateColor');L.new(ti.outputs['Color'],sc.inputs[0])
strength=math_node(nt,'ADD',math_node(nt,'MULTIPLY',sc.outputs[0],18),math_node(nt,'MULTIPLY',math_node(nt,'POWER',sc.outputs[1],2.2),1.2))
bsdf.inputs['Emission Color'].default_value=(1.0,.66,.30,1);L.new(strength,bsdf.inputs['Emission Strength'])
visor.data.materials.append(vm)

# Skin under the fur: same driven colour, darker, so gaps never show grey.
body_m=bpy.data.materials.new('Fur_Skin');body_m.use_nodes=True;nt=body_m.node_tree
b=next(n for n in nt.nodes if n.type=='BSDF_PRINCIPLED');a=nt.nodes.new('ShaderNodeAttribute');a.attribute_type='INSTANCER';a.attribute_name='fur_color'
mx=nt.nodes.new('ShaderNodeMix');mx.data_type='RGBA';mx.blend_type='MULTIPLY';mx.inputs['Factor'].default_value=1;sock(mx,'B').default_value=(.55,.5,.47,1)
nt.links.new(a.outputs['Color'],sock(mx,'A'));nt.links.new(sock(mx,'Result','outputs'),b.inputs['Base Color']);b.inputs['Roughness'].default_value=.9
me.materials.append(body_m)

# ---------- Fur: groomable Hair Curves on the body surface ----------
mesh=body.data;mesh.calc_loop_triangles()
P=np.array([v.co for v in mesh.vertices]);VNrm=np.array([v.normal for v in mesh.vertices])
tri=np.array([t.vertices for t in mesh.loop_triangles]);tloops=np.array([t.loops for t in mesh.loop_triangles])
UVs=np.array([d.uv for d in mesh.uv_layers['UVMap'].data])
A=P[tri[:,0]];B=P[tri[:,1]];C=P[tri[:,2]]
area=np.linalg.norm(np.cross(B-A,C-A),axis=1)/2
n_try=int(STRANDS*1.5)
wt=area*np.where(tri[:,0]>=nb,2.6,1.0)
ti_=rng.choice(len(tri),n_try,p=wt/wt.sum())
r1=np.sqrt(rng.random(n_try));r2=rng.random(n_try)
w=np.stack([1-r1,r1*(1-r2),r1*r2],1)
root=(w[:,:,None]*P[tri[ti_]]).sum(1)
nrm=(w[:,:,None]*VNrm[tri[ti_]]).sum(1);nrm/=np.linalg.norm(nrm,axis=1,keepdims=True)
ruv=(w[:,:,None]*UVs[tloops[ti_]]).sum(1)
is_ear=tri[ti_,0]>=nb
keep=np.ones(n_try,bool)
# No fur under the visor; shorter fur framing it.
d=sedist(root[:,0],root[:,2]);front=(nrm[:,1]<-.15)&(root[:,1]<0)
keep&=~(front&(d<1.0)&~is_ear)
# Drop roots buried inside the other shell (body under the ears / ear inside the head).
for i in np.nonzero(keep)[0]:
    p=Vector(root[i])
    if is_ear[i]:
        loc,n_,_,_=bvh_body.find_nearest(p)
        if (p-loc).dot(n_)<0:keep[i]=False
    elif p.z>.25*SH and abs(p.x)>.25:
        for c,R,*_ in EARS:
            q=R.transposed()@(p-c)
            if (q.x/.145)**2+(q.y/.072)**2+(q.z/.145)**2<1:keep[i]=False
idx=np.nonzero(keep)[0][:STRANDS];root,nrm,ruv,is_ear,d,front=root[idx],nrm[idx],ruv[idx],is_ear[idx],d[idx],front[idx]
n=len(root)
# Flow: away from the face, then gravity; ears flow out from their centre.
F=np.array([0,-.65,.52*SH]);g=root-F;g/=np.linalg.norm(g,axis=1,keepdims=True);g+=np.array([0,0,-.55])
for c,R,*_ in EARS:
    m=is_ear&((root[:,0]>0)==(c.x>0));ge=root[m]-np.array(c);ge/=np.linalg.norm(ge,axis=1,keepdims=True)
    # Mostly downward with a little outward spread: no whorl in the middle of the ear.
    g[m]=.45*ge+np.array([0,.15,-1])
# Smooth random field for coherent tufts.
dirs=rng.normal(size=(8,3));dirs/=np.linalg.norm(dirs,axis=1,keepdims=True);ph=rng.random((8,3))*6.28;amp=rng.normal(size=(8,3))
tuft=sum(amp[k]*np.sin(root@dirs[k][:,None]*14+ph[k]) for k in range(8))/3
g+=.22*tuft
g-=nrm*(g*nrm).sum(1,keepdims=True);g/=np.linalg.norm(g,axis=1,keepdims=True)+1e-9
L_=np.where(is_ear,.05,.095)*(1+.22*rng.normal(size=n)).clip(.55,1.5)
L_*=np.where(front&~is_ear,np.clip(.35+(d-1)/.4*.65,.35,1),1)
L_*=1+.12*np.clip(.3-root[:,2],0,1)/.3
t=np.linspace(0,1,SEG)
lift=.42+.12*rng.random(n);bend=.85+.15*rng.random(n)
frz=rng.normal(size=(n,3))*.06
side=np.cross(nrm,g);wf=1.2+1.3*rng.random(n);wp=rng.random(n)*6.28;wa=.07+.05*rng.random(n)
wave=np.sin(np.pi*wf[:,None]*t[None,:]+wp[:,None])*wa[:,None]*t[None,:]
pts=(root[:,None,:]+L_[:,None,None]*(nrm[:,None,:]*(lift[:,None]*t)[:,:,None]+g[:,None,:]*(bend[:,None]*t**1.6)[:,:,None]+frz[:,None,:]*(t**2)[None,:,None]+side[:,None,:]*wave[:,:,None]))
# Clumping: every strand leans its tip toward the nearest clump guide -> soft locks instead of quills.
from mathutils.kdtree import KDTree
gi_=rng.choice(n,n//40,replace=False);kd=KDTree(len(gi_))
for k,i in enumerate(gi_):kd.insert(root[i],k)
kd.balance()
near=np.array([gi_[kd.find(root[i])[1]] for i in range(n)])
cl=(.30+.25*rng.random(n))[:,None]*t[None,:]**1.4
pts+=((pts[near]-root[near][:,None,:])-(pts-root[:,None,:]))*cl[:,:,None]
curves=bpy.data.hair_curves.new('Agent_Fur')
curves.add_curves([SEG]*n)
curves.position_data.foreach_set('vector',pts.reshape(-1).astype(np.float32))
rad=curves.attributes.get('radius') or curves.attributes.new('radius','FLOAT','POINT')
rad.data.foreach_set('value',np.tile(.0024*(1-t)**.9+.0003,n).astype(np.float32))
suv=curves.attributes.get('surface_uv_coordinate') or curves.attributes.new('surface_uv_coordinate','FLOAT2','CURVE')
suv.data.foreach_set('vector',ruv.reshape(-1).astype(np.float32))
curves.surface=body;curves.surface_uv_map='UVMap'
fur=bpy.data.objects.new('Agent_Fur',curves);coll.objects.link(fur);fur.parent=body
fur['fur_color']=[.52,.26,.08];driven_prop(fur,'fur_color',3)
gn=bpy.data.node_groups.new('Fur_Follow_Surface','GeometryNodeTree')
gn.interface.new_socket('Geometry',in_out='INPUT',socket_type='NodeSocketGeometry');gn.interface.new_socket('Geometry',in_out='OUTPUT',socket_type='NodeSocketGeometry')
gi=gn.nodes.new('NodeGroupInput');go=gn.nodes.new('NodeGroupOutput');df=gn.nodes.new('GeometryNodeDeformCurvesOnSurface')
gn.links.new(gi.outputs[0],df.inputs[0]);gn.links.new(df.outputs[0],go.inputs[0])
mod=fur.modifiers.new('Follow body (rig ready)','NODES');mod.node_group=gn
fm=bpy.data.materials.new('Fur_Hair');fm.use_nodes=True;nt=fm.node_tree;Nn=nt.nodes
for x in list(Nn):
    if x.type=='BSDF_PRINCIPLED':Nn.remove(x)
hb=Nn.new('ShaderNodeBsdfHairPrincipled');hb.parametrization='COLOR'
try:hb.model='HUANG'
except Exception:pass
o=next(x for x in Nn if x.type=='OUTPUT_MATERIAL');nt.links.new(hb.outputs[0],o.inputs['Surface'])
for k,v in (('Roughness',.32),('Radial Roughness',.55),('Coat',.15)):
    if k in hb.inputs:hb.inputs[k].default_value=v
fa=Nn.new('ShaderNodeAttribute');fa.attribute_type='INSTANCER';fa.attribute_name='fur_color'
hi=Nn.new('ShaderNodeHairInfo')
# Root darker -> tip lighter, small per-strand value jitter.
ramp=Nn.new('ShaderNodeMix');ramp.data_type='RGBA';ramp.blend_type='MULTIPLY'
mapr=Nn.new('ShaderNodeMapRange');mapr.inputs['To Min'].default_value=.55;mapr.inputs['To Max'].default_value=1.18
nt.links.new(hi.outputs['Intercept'],mapr.inputs['Value'])
jit=Nn.new('ShaderNodeMapRange');jit.inputs['To Min'].default_value=.9;jit.inputs['To Max'].default_value=1.08;nt.links.new(hi.outputs['Random'],jit.inputs['Value'])
mul=math_node(nt,'MULTIPLY',mapr.outputs[0],jit.outputs[0])
ramp.inputs['Factor'].default_value=1;nt.links.new(fa.outputs['Color'],sock(ramp,'A'))
cmb=Nn.new('ShaderNodeCombineColor');[nt.links.new(mul,cmb.inputs[i]) for i in range(3)]
nt.links.new(cmb.outputs[0],sock(ramp,'B'));nt.links.new(sock(ramp,'Result','outputs'),hb.inputs['Color'])
curves.materials.append(fm)
body['palette_presets']='beige .52 .26 .08 | roux .40 .11 .035 | bleu .22 .30 .42 | olive .30 .31 .05 | lilas .34 .20 .40 | creme .68 .58 .46 | anthracite .035 .032 .032'
print('STRANDS',n,'BODY_QUADS',len(mesh.polygons),'BODY_VERTS',len(mesh.vertices),'VISOR_FACES',len(vme.polygons),flush=True)
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/('Agent_%s.blend'%SHAPE)),compress=True)
