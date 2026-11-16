# Front and three-quarter renders of one skull, to check a build by eye.
import bpy,sys,math
from pathlib import Path
F=Path(sys.argv[sys.argv.index('--file')+1]);OUT=Path(sys.argv[sys.argv.index('--out')+1])
bpy.ops.wm.open_mainfile(filepath=str(F))
s=bpy.context.scene;s.render.engine='BLENDER_EEVEE_NEXT';s.render.resolution_x=s.render.resolution_y=420;s.render.film_transparent=False
w=bpy.data.worlds.new('w');s.world=w;w.use_nodes=True;w.node_tree.nodes['Background'].inputs[0].default_value=(.02,.02,.022,1);w.node_tree.nodes['Background'].inputs[1].default_value=1
for rot,e in (((math.radians(50),0,math.radians(-35)),4),((math.radians(70),0,math.radians(140)),1.5)):
    l=bpy.data.lights.new('sun','SUN');l.energy=e;o=bpy.data.objects.new('sun',l);o.rotation_euler=rot;s.collection.objects.link(o)
cam=bpy.data.cameras.new('c');cam.type='ORTHO';cam.ortho_scale=1.9;co=bpy.data.objects.new('c',cam);s.collection.objects.link(co);s.camera=co
h=bpy.data.objects['Agent']['sh']*.905/2
for name,a in (('face',0),('34',35)):
    r=math.radians(a);co.location=(4*math.sin(r),-4*math.cos(r),h+.05);co.rotation_euler=(math.radians(90),0,r)
    s.render.filepath=str(OUT/(F.stem+'_'+name+'.png'));bpy.ops.render.render(write_still=True)
