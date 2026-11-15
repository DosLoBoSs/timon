# Adds a light animation rig to a skull's Agent_<shape>.blend (run after build_agent.py):
# root > body (lower half, squash) > top (upper half, lean/turn) > ear.L/ear_tip.L, ear.R/ear_tip.R.
# The visor rides on 'top'; the fur follows through its Deform Curves on Surface modifier.
# Also authors the "hop" action (in place: horizontal travel and the jump arc are driven by the app).
import bpy,math
import numpy as np
from mathutils import Vector,Matrix,Quaternion
from pathlib import Path
import sys
F=Path(sys.argv[sys.argv.index('--file')+1])
bpy.ops.wm.open_mainfile(filepath=str(F))
s=bpy.context.scene;s.render.fps=30
body=bpy.data.objects['Agent'];SH=body['sh'];visor=bpy.data.objects['Agent_Visor'];coll=bpy.data.collections['Agent']
# Re-runnable: detach everything from a previous rig (keeping world transforms) before deleting it.
for o in (body,visor,bpy.data.objects['Agent_Fur']):
    mw=o.matrix_world.copy();o.parent=None;o.parent_type='OBJECT';o.matrix_parent_inverse.identity();o.matrix_world=mw
for o in [o for o in bpy.data.objects if o.type=='ARMATURE']:bpy.data.objects.remove(o)
arm=bpy.data.armatures.new('Agent_Rig');rig=bpy.data.objects.new('Agent_Rig',arm);coll.objects.link(rig)
rig.show_in_front=True;arm.display_type='OCTAHEDRAL'
bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT')
EB=arm.edit_bones
def bone(name,h,t,parent=None,deform=True):
    b=EB.new(name);b.head=h;b.tail=t;b.roll=0;b.use_deform=deform
    if parent:b.parent=EB[parent];b.use_connect=False
    return b
bone('root',(0,0,0),(0,0,.18),deform=False)
bone('body',(0,0,.04*SH),(0,0,.44*SH),'root')
bone('top',(0,0,.44*SH),(0,0,.86*SH),'body')
EX=body['ear_x'];EARC={'L':Vector((EX,.04,.60*SH)),'R':Vector((-EX,.04,.60*SH))}
EARD={k:Vector((.85 if k=='L' else -.85,0,.53)).normalized() for k in EARC}
for k in 'LR':
    c,d=EARC[k],EARD[k];b0=c-d*.10;m=c+d*.02;t=c+d*.14
    bone('ear.'+k,b0,m,'top');bone('ear_tip.'+k,m,t,'ear.'+k)
bpy.ops.object.mode_set(mode='OBJECT')

# ---------- weights ----------
me=body.data
for vg in list(body.vertex_groups):body.vertex_groups.remove(vg)
G={n:body.vertex_groups.new(name=n) for n in ('body','top','ear.L','ear_tip.L','ear.R','ear_tip.R')}
def sstep(a,b,x):t=min(1,max(0,(x-a)/(b-a)));return t*t*(3-2*t)
VC=(0.,body['visor'][0]);VW,VH,VN=body['visor'][1],body['visor'][2],3.2
# Islands: largest = head, others = ears.
import bmesh
bm=bmesh.new();bm.from_mesh(me);bm.verts.ensure_lookup_table()
isl=[-1]*len(bm.verts);k=0
for v in bm.verts:
    if isl[v.index]>=0:continue
    st=[v]
    while st:
        u=st.pop()
        if isl[u.index]>=0:continue
        isl[u.index]=k;st+=[e.other_vert(u) for e in u.link_edges]
    k+=1
bm.free();main=int(np.argmax(np.bincount(isl)))
for v in me.vertices:
    p=v.co
    if isl[v.index]==main:
        wt=sstep(.2*SH,.62*SH,p.z)
        # Keep the face around the visor rigid with 'top' so the visor never separates from the fur.
        d=(abs(2*(p.x-VC[0])/VW)**VN+abs(2*(p.z-VC[1])/VH)**VN)**(1/VN)
        if p.y<0:wt=max(wt,1-sstep(1.05,1.5,d))
        if wt<.999:G['body'].add([v.index],1-wt,'REPLACE')
        if wt>.001:G['top'].add([v.index],wt,'REPLACE')
    else:
        kk='L' if p.x>0 else 'R';c,dv=EARC[kk],EARD[kk]
        t=(p-(c-dv*.10)).dot(dv)/.24
        wtip=sstep(.42,.72,t)
        if wtip<.999:G['ear.'+kk].add([v.index],1-wtip,'REPLACE')
        if wtip>.001:G['ear_tip.'+kk].add([v.index],wtip,'REPLACE')
for m in [m for m in body.modifiers if m.type=='ARMATURE']:body.modifiers.remove(m)
am=body.modifiers.new('Rig','ARMATURE');am.object=rig
if body.modifiers.find('Rig')>0:body.modifiers.move(body.modifiers.find('Rig'),0)
body.parent=rig
# Needed by Deform Curves on Surface: the fur compares rest vs deformed surface.
body.add_rest_position_attribute=True
# Visor rides on the top bone.
mw=visor.matrix_world.copy();visor.parent=rig;visor.parent_type='BONE';visor.parent_bone='top';visor.matrix_world=mw
fur=bpy.data.objects['Agent_Fur'];mwf=fur.matrix_world.copy();fur.parent=body;fur.matrix_world=mwf

# ---------- actions (in place: travel and jump arcs are driven by the app) ----------
# Bone axes: body/top point up (local Y = up); local X rotation leans the top toward the face (+) or back (-).
def local_axis(bname,w):return (arm.bones[bname].matrix_local.to_3x3().inverted()@Vector(w)).normalized()
def ear_axis(k,b='ear.'):return local_axis(b+k,(0,1 if k=='L' else -1,0))   # + = ear flops outward/down
ROLL=local_axis('top',(0,1,0))                                                # + = top tilts toward screen right
P=rig.pose.bones
for pb in P:pb.rotation_mode='QUATERNION'
rig.animation_data_create()
def author(name,keys,note,cyclic=False):
    """keys: frame -> (body sxz, body sy, top lean, top roll, ear L, ear R, ear tip L, ear tip R)"""
    if name in bpy.data.actions:bpy.data.actions.remove(bpy.data.actions[name])
    act=bpy.data.actions.new(name);rig.animation_data.action=act
    for f,(sxz,sy,lean,roll,eL,eR,tL,tR) in keys.items():
        P['body'].scale=(sxz,sy,sxz);P['body'].keyframe_insert('scale',frame=f)
        P['top'].rotation_quaternion=Quaternion(ROLL,roll)@Quaternion((1,0,0),lean);P['top'].keyframe_insert('rotation_quaternion',frame=f)
        for k,e,t in (('L',eL,tL),('R',eR,tR)):
            P['ear.'+k].rotation_quaternion=Quaternion(ear_axis(k),e);P['ear.'+k].keyframe_insert('rotation_quaternion',frame=f)
            P['ear_tip.'+k].rotation_quaternion=Quaternion(ear_axis(k,'ear_tip.'),t);P['ear_tip.'+k].keyframe_insert('rotation_quaternion',frame=f)
    for fc in act.fcurves:
        for kp in fc.keyframe_points:kp.interpolation='BEZIER';kp.handle_left_type=kp.handle_right_type='AUTO_CLAMPED'
        if cyclic:fc.modifiers.new('CYCLES')
    act.use_fake_user=True;act['notes']=note;act['cyclic']=cyclic
    return act
R0=(1,1,0,0,0,0,0,0)
author('hop',{0:R0,
  4:(1.13,.78,.14,0,.30,.30,.25,.25),     # anticipation crouch, lean in, ears pressed down
  6:(.88,1.20,-.10,0,-.35,-.35,-.45,-.45),# take-off stretch, top lags back, ears trail up
  11:(.98,1.04,-.04,0,-.10,-.10,-.20,-.20),# apex
  15:(1.02,1.00,.02,0,.05,.05,.10,.10),
  16:(1.16,.76,.12,0,.40,.40,.55,.55),    # contact squash, follow-through, ears flop
  18:(.95,1.07,-.05,0,-.12,-.12,-.18,-.18),# rebound
  20:(1,1,0,0,0,0,.02,.02)},'0-4 crouch | 4-16 air (6 take-off, 11 apex) | 16 land | 16-20 recover')
author('hop_big',{0:R0,
  4:(1.18,.74,.18,0,.40,.40,.30,.30),
  6:(.80,1.32,-.18,0,-.60,-.60,-.70,-.70),# big stretch, ears laid back
  11:(.95,1.10,-.10,0,-.50,-.50,-.60,-.60),
  15:(1.00,1.02,0,0,-.20,-.20,-.20,-.20),
  16:(1.24,.70,.17,0,.50,.50,.65,.65),
  18:(.93,1.10,-.07,0,-.15,-.15,-.20,-.20),
  20:R0},'panic hop, same phases as hop')
author('startle',{0:R0,
  2:(1.06,.90,.06,0,.15,.15,.10,.10),     # flinch
  5:(.86,1.20,-.14,0,-.55,-.55,-.60,-.60),# shoots up, ears straight up
  8:(1.04,.95,-.04,0,-.30,-.30,-.25,-.25),
  11:(.97,1.04,-.07,0,-.42,-.42,-.40,-.40),
  14:(.99,1.02,-.05,0,-.38,-.38,-.35,-.35)},'one-shot, last frame = alert pose (hold it)')
author('grab',{0:(.88,1.20,-.04,0,.55,.55,.45,.45),  # held: body sags long, ears dangle, little wriggle
  6:(.87,1.22,-.02,.12,.45,.65,.35,.55),
  12:(.89,1.18,-.05,0,.60,.50,.50,.40),
  18:(.87,1.22,-.02,-.12,.65,.45,.55,.35),
  24:(.88,1.20,-.04,0,.55,.55,.45,.45)},'loop while held',cyclic=True)
author('happy',{0:R0,
  3:(1.06,.92,.03,.14,-.30,.10,-.35,.15),  # wiggle side to side, ears flick in turn
  6:(.96,1.07,0,.16,-.35,.05,-.40,.10),
  9:(1.06,.92,.03,-.14,.10,-.30,.15,-.35),
  12:(.96,1.07,0,-.16,.05,-.35,.10,-.40),
  15:(1.06,.92,.03,.12,-.30,.10,-.30,.10),
  18:(.97,1.05,0,.10,-.20,0,-.20,0),
  21:(1.03,.97,.01,-.05,-.05,-.10,-.05,-.10),
  24:R0},'one-shot joy wiggle')
s.frame_start=0;s.frame_end=20
rig.animation_data.action=None
for pb in P:pb.location=(0,0,0);pb.rotation_quaternion=(1,0,0,0);pb.scale=(1,1,1)
bpy.ops.wm.save_as_mainfile(filepath=str(F),compress=True)
print('RIG OK bones',len(arm.bones),'actions',{a.name:tuple(int(x) for x in a.frame_range) for a in bpy.data.actions},flush=True)
