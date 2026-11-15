# The job accessories of Timon's mascot, modelled in 3D, plus the pieces some of them wear (the teacher's mortarboard, hats).
# Each one follows the product's 2D drawing (app/src/components/mascot/mascot-accessories.tsx): same
# proportions and colours, in the drawing's own units (x right, y down, about +-14), with real volume.
# Writes Accessories.blend (one object per accessory, laid out in a grid), a contact sheet and accessories.json.
#   blender -b --factory-startup -P build_accessories.py -- --out <models dir> --data <json dir>
import bpy,bmesh,math,sys,json,base64
import numpy as np
from pathlib import Path
from mathutils import Vector,Matrix
def arg(k):return Path(sys.argv[sys.argv.index(k)+1])
OUT=arg('--out');DATA=arg('--data');OUT.mkdir(parents=True,exist_ok=True);DATA.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene

# ---------- 2D outlines, in drawing units ----------
def rr(x,y,w,h,r):
    r=min(r,w/2,h/2);pts=[]
    for cx,cy,a0 in ((x+w-r,y+r,-90),(x+w-r,y+h-r,0),(x+r,y+h-r,90),(x+r,y+r,180)):
        for i in range(5):
            a=math.radians(a0+i*22.5);pts.append((cx+r*math.cos(a),cy+r*math.sin(a)))
    return pts
def el(cx,cy,rx,ry=None,n=20):
    ry=rx if ry is None else ry
    return [(cx+rx*math.cos(2*math.pi*i/n),cy+ry*math.sin(2*math.pi*i/n)) for i in range(n)]
def qb(a,c,b,k=12):return [((1-t)**2*a[0]+2*(1-t)*t*c[0]+t*t*b[0],(1-t)**2*a[1]+2*(1-t)*t*c[1]+t*t*b[1]) for t in [i/(k-1) for i in range(k)]]
def cb(a,c1,c2,b,k=14):
    return [tuple((1-t)**3*a[j]+3*(1-t)**2*t*c1[j]+3*(1-t)*t*t*c2[j]+t**3*b[j] for j in (0,1)) for t in [i/(k-1) for i in range(k)]]
def st(line,hw):
    # A thick stroke along a polyline, round caps, as one closed outline.
    n=len(line);L=[];R=[]
    def d(i):
        a=line[max(0,i-1)];b=line[min(n-1,i+1)];v=Vector((b[0]-a[0],b[1]-a[1])).normalized();return v
    for i,p in enumerate(line):
        v=d(i);L.append((p[0]-v.y*hw,p[1]+v.x*hw));R.append((p[0]+v.y*hw,p[1]-v.x*hw))
    def cap(p,v):
        a0=math.atan2(v.x,-v.y);return [(p[0]+hw*math.cos(a0-i/8*math.pi),p[1]+hw*math.sin(a0-i/8*math.pi)) for i in range(1,8)]
    return L+cap(line[-1],d(n-1))+R[::-1]+cap(line[0],-d(0))

# ---------- 3D parts. A drawing point (x, y) at depth t (towards the viewer) is Blender (x, -t, -y). ----------
def P(x,y,t=0):return Vector((x,-t,-y))
class Tool:
    def __init__(s,depth=1):
        # `depth` thickens the flat tools: a slab two units thick reads as a sticker once on the character.
        s.depth=depth;s.bm=bmesh.new();s.pl=s.bm.verts.layers.float.new('par');s.mats=[];s.layer=s.bm.faces.layers.int.new('mat')
    def mat(s,hexc):
        if hexc not in s.mats:s.mats.append(hexc)
        return s.mats.index(hexc)
    def _add(s,verts,faces,col,M=None,par=None):
        # `par`: for each vertex, how far along a supple part it sits (0 = rigid, 1 = the tip); the app waves it.
        vs=[s.bm.verts.new(M@Vector(v) if M else v) for v in verts];m=s.mat(col)
        if par:
            for v,q in zip(vs,par):v[s.pl]=q
        for f in faces:
            try:s.bm.faces.new([vs[i] for i in f])[s.layer]=m
            except ValueError:pass
    def prism(s,pts,t0,t1,col):
        # A flat outline given thickness: from depth t0 (back) to t1 (front).
        t0*=s.depth;t1*=s.depth;n=len(pts);v=[P(x,y,t1) for x,y in pts]+[P(x,y,t0) for x,y in pts]
        s._add(v,[list(range(n)),list(range(2*n-1,n-1,-1))]+[(i,n+i,n+(i+1)%n,(i+1)%n) for i in range(n)],col)
    def lathe(s,a,b,ra,rb,col,seg=14,pa=0,pb=0):
        # A cylinder or cone between two 3D points, radius ra at a, rb at b.
        a=Vector(a);b=Vector(b);z=(b-a).normalized();x=z.orthogonal().normalized();y=z.cross(x)
        v=[];f=[]
        for i in range(seg):
            c=math.cos(2*math.pi*i/seg);sn=math.sin(2*math.pi*i/seg);dv=x*c+y*sn
            v.append(a+dv*max(ra,1e-3));v.append(b+dv*max(rb,1e-3))
        for i in range(seg):
            j=(i+1)%seg;f.append((2*i,2*j,2*j+1,2*i+1))
        f.append([2*i for i in range(seg-1,-1,-1)]);f.append([2*i+1 for i in range(seg)])
        s._add(v,f,col,par=[pa,pb]*seg if pa or pb else None)
    def revolve(s,cx,prof,col,seg=16,caps=True):
        # Rings about the vertical axis x = cx; prof = [(y, radius)...] in drawing units, top to bottom.
        v=[];f=[];n=len(prof)
        for y,r in prof:
            for j in range(seg):
                a=2*math.pi*j/seg;v.append(P(cx+max(r,1e-3)*math.cos(a),y,max(r,1e-3)*math.sin(a)))
        for i in range(n-1):
            for j in range(seg):
                k=(j+1)%seg;f.append((i*seg+j,(i+1)*seg+j,(i+1)*seg+k,i*seg+k))
        if caps:f.append(list(range(seg)));f.append([(n-1)*seg+j for j in range(seg-1,-1,-1)])
        s._add(v,f,col)
    def tube(s,p1,p2,r,col,t=0,r2=None):t*=s.depth;s.lathe(P(*p1,t),P(*p2,t),r,r if r2 is None else r2,col)
    def ball(s,c,r,col,scale=(1,1,1),seg=12,rings=7,par=0):
        v=[];f=[];c=Vector(c)
        for i in range(rings+1):
            ph=math.pi*i/rings
            for j in range(seg):
                th=2*math.pi*j/seg
                v.append(c+Vector((r*scale[0]*math.sin(ph)*math.cos(th),r*scale[1]*math.sin(ph)*math.sin(th),r*scale[2]*math.cos(ph))))
        for i in range(rings):
            for j in range(seg):
                k=(j+1)%seg;f.append((i*seg+j,(i+1)*seg+j,(i+1)*seg+k,i*seg+k))
        s._add(v,f,col,par=[par]*len(v) if par else None)
    def path(s,pts,r,col,seg=8,r2=None,par=None):
        # A round rod along a polyline of Blender points, radius r tapering to r2; `par` for each point.
        n=len(pts)-1;r2=r if r2 is None else r2
        for k in range(n):s.lathe(pts[k],pts[k+1],r+(r2-r)*k/n,r+(r2-r)*(k+1)/n,col,seg=seg,pa=par[k] if par else 0,pb=par[k+1] if par else 0)
    def torus(s,c,R,r,col,arc=(0,360),seg=30,tseg=8):
        # A ring facing the viewer, centred on the drawing point c.
        v=[];f=[];n=seg if arc==(0,360) else seg+1
        for i in range(n):
            a=math.radians(arc[0]+(arc[1]-arc[0])*i/seg)
            for j in range(tseg):
                b=2*math.pi*j/tseg;rad=R+r*math.cos(b)
                v.append(P(c[0]+rad*math.cos(a),c[1]+rad*math.sin(a),r*math.sin(b)))
        for i in range(seg):
            i2=(i+1)%n
            for j in range(tseg):
                k=(j+1)%tseg;f.append((i*tseg+j,i2*tseg+j,i2*tseg+k,i*tseg+k))
        s._add(v,f,col)
    def text(s,body,x,y,size,t,col):
        cu=bpy.data.curves.new('txt','FONT');cu.body=body;cu.size=size;cu.align_x='CENTER';cu.extrude=.25;cu.resolution_u=2
        o=bpy.data.objects.new('txt',cu);scene.collection.objects.link(o);bpy.context.view_layer.update()
        me=bpy.data.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        # Text lies in XY facing +Z: stand it up, facing the viewer.
        M=Matrix.Translation(P(x,y,t*s.depth if s.depth>1 else t))@Matrix.Rotation(math.radians(90),4,'X')
        s._add([v.co for v in me.vertices],[list(p.vertices) for p in me.polygons],col,M)
        bpy.data.objects.remove(o);bpy.data.curves.remove(cu);bpy.data.meshes.remove(me)
    def finish(s,name,bevel=.3):
        bm=s.bm;bmesh.ops.remove_doubles(bm,verts=bm.verts,dist=1e-4);bmesh.ops.recalc_face_normals(bm,faces=bm.faces)
        # Soften the hard edges of slabs and boxes; round parts are already smooth.
        hard=[e for e in bm.edges if len(e.link_faces)==2 and e.calc_face_angle(0)>math.radians(50)]
        if bevel and hard:
            try:bmesh.ops.bevel(bm,geom=hard,offset=bevel,offset_type='OFFSET',segments=1,profile=.5,affect='EDGES',clamp_overlap=True)
            except Exception as ex:print('bevel skipped',name,ex)
        me=bpy.data.meshes.new(name)
        for h in s.mats:
            m=bpy.data.materials.get('acc_'+h) or bpy.data.materials.new('acc_'+h)
            c=[int(h[i:i+2],16)/255 for i in (1,3,5)];lin=[x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in c]
            m.diffuse_color=(*lin,1);m.use_nodes=True
            b=m.node_tree.nodes['Principled BSDF'];b.inputs['Base Color'].default_value=(*lin,1);b.inputs['Roughness'].default_value=.55
            me.materials.append(m)
        lay=bm.faces.layers.int['mat']
        for f in bm.faces:f.material_index=f[lay];f.smooth=True
        bm.to_mesh(me);bm.free()
        me.set_sharp_from_angle(angle=math.radians(40))
        o=bpy.data.objects.new(name,me);scene.collection.objects.link(o);o['hex']=s.mats
        return o

WOOD,DARKWOOD,STEEL,GLASS,CREAM,RED,INK,GOLD='#9a6a3c','#7a4f2a','#b9bfc6','#cfe9ff','#f6f1e7','#e2463b','#2a2a30','#ffc233'
def loupe(t):
    t.tube((6,6),(15,15),2.5,DARKWOOD);t.torus((-1,-1),10,1.8,'#dfe3e8');t.prism(el(-1,-1,9.2),-.4,.4,GLASS)
def pen(t):
    t.tube((0,-13),(0,7),3,RED);t.tube((0,-14),(0,-8),3.25,'#b8322a');t.ball(P(0,-14),3.25,'#b8322a',(1,1,.5))
    t.prism(rr(2.6,-12,1.4,9,.7),-.8,.8,'#b8322a');t.tube((0,7),(0,12),3,'#f2d3b0',r2=1.1);t.tube((0,11.6),(0,14.2),1.25,'#cc2222',r2=.1)
def quill(t):
    t.prism(cb((0,12),(8,1),(7,-9),(1,-16))+cb((1,-16),(-6,-9),(-7,1),(0,12))[1:-1],-.45,.45,CREAM)
    t.tube((0,12),(1,-15),.6,'#b9ae9b',t=.3)
    for a,b in (((1,-4),(5.5,-6.5)),((1,-9),(4.5,-11.5)),((.6,0),(-3.9,-2.5))):t.prism(st([a,b],.4),.45,.6,'#cfc6b6')
    t.tube((0,11),(0,16),1.3,'#333333',r2=.1)
def hammer(t):
    t.tube((0,-6),(0,14),1.9,WOOD);t.tube((0,9),(0,14.2),2.2,DARKWOOD);t.prism(rr(-9,-12,18,7,1.8),-3.4,3.4,'#8e949c')
def wrench(t):
    # Open-end head: a disc with a round-bottomed slot cut from the top.
    c=(0,-9.5);R=7.2;hw=2.7;a0=math.asin(hw/R)
    ring=[(c[0]+R*math.sin(a),c[1]-R*math.cos(a)) for a in [a0+(2*math.pi-2*a0)*i/22 for i in range(23)]]
    slot=[(-hw,-11.2)]+[(hw*math.cos(math.pi-math.pi*i/8)*1.0,-11.2+hw*math.sin(math.pi*i/8)) for i in range(1,8)]+[(hw,-11.2)]
    t.prism(ring+slot,-1.5,1.5,STEEL);t.prism(rr(-2.3,-4.5,4.6,18.5,2.3),-1.45,1.45,STEEL);t.prism(rr(-1,2,2,9,1),1.45,1.7,'#8d939a')
def baton(t):
    t.tube((-10,11),(9,-10),.95,'#f4efe6');t.ball(P(-9.5,10.5),2.8,'#6b4a2b')
    t.ball(P(7,-15),2.2,GOLD,(1,.8,.75));t.tube((9,-15.3),(9,-21.5),.55,GOLD);t.tube((9,-21.5),(12,-20.3),.55,GOLD)
def telescope(t):
    t.tube((-13,0),(-4,0),3,'#c9a25a');t.tube((-5,0),(4,0),3.8,'#8a5a3b');t.tube((3.5,0),(12,0),4.7,'#c9a25a');t.tube((11.8,0),(13.2,0),4.3,GLASS)
def envelope(t):
    t.prism(rr(-12,-8,24,16,2),-1,1,CREAM);t.prism(st([(-11,-6.8),(0,1.5),(11,-6.8)],.55),1,1.3,'#cfc6b6');t.prism(el(0,1.5,2.6),1,1.9,RED)
def calendar(t):
    t.prism(rr(-10.5,-9,21,20,3),-1.2,1.2,'#ffffff');t.prism(rr(-10.9,-9.4,21.8,6.6,3),-1.38,1.6,RED)   # wraps the page: no face shared with it
    for x in (-5.1,5.1):t.tube((x,-11.5),(x,-7),.9,INK,t=1.6)
    t.text('12',0,8,10,1.2,INK)
def clipboard(t):
    t.prism(rr(-9.5,-11,19,24,2.5),-1,1,'#a87445');t.prism(rr(-7.5,-8,15,18.5,1),1,1.35,'#ffffff');t.prism(rr(-4.5,-13,9,4.5,1.4),-1.2,2,'#8e949c')
    for i,y in enumerate((-4,1,6)):
        t.prism(st([(-5.5,y),(-4.1,y+1.4),(-1.5,y-1.4)],.7),1.35,1.75,'#2fd4a5' if i<2 else '#cfcfcf');t.prism(rr(0,y-.65,5,1.3,.6),1.35,1.6,'#cfcfcf')
def glass_r(y):return 1.3+5.2*(abs(y)/9.5)**.75
def hourglass(t):
    t.tube((0,-12.5),(0,-9.5),7.6,'#8a5a3b');t.tube((0,9.5),(0,12.5),7.6,'#8a5a3b')
    for x in (-6.6,6.6):t.tube((x,-9.5),(x,9.5),.55,'#8a5a3b')
    # Sand first, glass last: the glass is see-through and must be drawn over what it holds.
    t.revolve(0,[(y,glass_r(y)*.86) for y in (-5.2,-4.1,-3,-1.9,-.9)],'#ffc233')
    t.revolve(0,[(5.5,.3),(7.4,3),(9.3,5.6)],'#ffc234')
    t.tube((0,-.9),(0,9.3),.32,'#ffc235')
    t.revolve(0,[(y,glass_r(y)) for y in (-9.5,-7.5,-5.5,-3.8,-2.2,-1,0,1,2.2,3.8,5.5,7.5,9.5)],GLASS,caps=False)
def teacher(t):
    t.prism(rr(-9,-11.5,17,23,2),-2,2,'#3f6fd8');t.prism(rr(5.4,-10,3.2,20,1),-1.55,1.55,CREAM)
    # The spine wraps the cover: no face shared with it.
    t.prism(rr(-9.4,-11.9,3.4,23.8,1.6),-2.3,2.3,'#2f57b0');t.prism(rr(-3.5,-5,8,3.4,1),2,2.35,GOLD)
def calculator(t):
    t.prism(rr(-8.5,-12,17,24,2.6),-1.2,1.2,'#3a3a42');t.prism(rr(-6.5,-9.8,13,5.4,1.1),1.2,1.45,'#9fe3b0')
    for r in range(3):
        for c in range(3):t.prism(rr(-6.5+c*4.6,-2+r*4.4,3.6,3.4,.8),1.2,1.95,'#ff8a3d' if r==2 and c==2 else '#c9ccd2')
def chart(t):
    t.prism(rr(-11.5,-9.5,23,19,2.6),-1,1,'#ffffff')
    for x,y,h,c in ((-7.5,1,5.5,'#3fa9ff'),(-2,-3,9.5,'#2fd4a5'),(3.5,-6.5,13,'#a35bff')):t.prism(rr(x,y,3.6,h,.8),1,1.7,c)
    t.prism(st([(-8,-1),(-1,-5),(5,-9)],.6),1.7,2.1,'#ff5a4f')
def brush(t):
    t.tube((0,-2),(0,15),1.7,'#c8763a');t.ball(P(0,15),1.7,'#c8763a');t.tube((0,-6.5),(0,-1.3),2.5,STEEL)
    t.tube((0,-6.5),(0,-11),2.6,'#ff5fbf',r2=3);t.tube((0,-11),(0,-16),3,'#ff5fbf',r2=.15)
# The globe's axis leans 23 degrees to the left, like a desk globe; the app turns it about that axis.
GLOBE_TILT=math.radians(23)
def gdir(lon,lat):
    lo,la=math.radians(lon),math.radians(lat);x,y,z=math.cos(la)*math.sin(lo),-math.cos(la)*math.cos(lo),math.sin(la)
    c,sn=math.cos(GLOBE_TILT),math.sin(GLOBE_TILT)
    return Vector((x*c-z*sn,y,x*sn+z*c))
def land(t,outline,col,R=10.22):
    # A landmass lying on the sphere: its outline in (longitude, latitude), filled with rings that follow the curve,
    # and a skirt that sinks under the sea so no gap shows.
    pts=[]
    for k,(a,b) in enumerate(outline):
        c,d=outline[(k+1)%len(outline)];n=max(1,int(max(abs(c-a),abs(d-b))//9))
        pts+=[gdir(a+(c-a)*q/n,b+(d-b)*q/n) for q in range(n)]
    n=len(pts);cen=sum(pts,Vector()).normalized()
    v=[p*9.9 for p in pts]+[p*R for p in pts]+[(cen.lerp(p,.6)).normalized()*R*1.004 for p in pts]+[(cen.lerp(p,.25)).normalized()*R*1.006 for p in pts]+[cen*R*1.006]
    f=[]
    for ring in range(3):
        for k in range(n):
            q=(k+1)%n;f.append((ring*n+k,ring*n+q,(ring+1)*n+q,(ring+1)*n+k))
    f+=[(3*n+k,3*n+(k+1)%n,4*n) for k in range(n)]
    t._add(v,f,col)
def globe(t):
    SEA,LAND,ICE,WOOD2='#3f8fe0','#6cc45a','#f1f5f8','#8a5a3b'
    t.ball(P(0,0),10,SEA,seg=24,rings=14)
    for o in ([(-160,62),(-125,72),(-80,70),(-58,50),(-80,28),(-98,17),(-112,26),(-126,46)],            # North America
              [(-80,9),(-60,11),(-36,-6),(-41,-22),(-57,-38),(-70,-53),(-74,-30),(-81,-5)],              # South America
              [(-17,28),(10,36),(32,30),(50,11),(40,-13),(31,-31),(19,-34),(11,-4),(-8,5),(-17,15)],     # Africa
              [(-9,42),(1,50),(-4,58),(14,69),(40,66),(46,49),(29,41),(13,45),(2,43)],                   # Europe
              [(47,49),(42,66),(80,75),(130,72),(172,66),(142,48),(122,30),(108,12),(96,20),(79,8),(68,24),(53,28)],  # Asia
              [(114,-22),(130,-12),(146,-18),(153,-30),(139,-38),(116,-34)]):                             # Australia
        land(t,o,LAND)
    land(t,[(a,-72) for a in range(0,360,40)],ICE);land(t,[(a,78) for a in range(0,360,45)][::-1],ICE,R=10.2)
    # Stand: a meridian arc from pole to pole round the left, a pin at each pole, a stem and a turned base.
    a0=math.degrees(math.atan2(-math.cos(GLOBE_TILT),-math.sin(GLOBE_TILT)))%360
    arc=[(12*math.cos(math.radians(a)),12*math.sin(math.radians(a))) for a in [a0-(180)*q/22 for q in range(23)]]
    t.prism(st(arc,.95),-1,1,WOOD2)
    for sg in (-1,1):
        d=Vector((-math.sin(GLOBE_TILT),-math.cos(GLOBE_TILT)))*sg;t.tube((d.x*9.8,d.y*9.8),(d.x*12.6,d.y*12.6),.7,'#6b4a2b')
    t.tube((-4.6,11.1),(0,14.2),1.1,WOOD2);t.tube((0,14),(0,15),3.2,WOOD2,r2=6.4);t.tube((0,15),(0,16.4),6.6,'#6b4a2b')
def megaphone(t):
    t.tube((-7.5,0),(8,0),3.2,'#ff5a4f',r2=10.5);t.tube((7.6,0),(9,0),10.6,'#d9443b');t.tube((8.2,0),(9.2,0),9.2,'#8f2a25')
    t.tube((-11,0),(-7,0),3.4,INK);t.tube((-2.9,2.5),(-2.9,10),1.6,INK)
def shield(t):
    o=[(0,-12.5),(10.5,-8.5),(10.5,0)]+cb((10.5,0),(10.5,7),(5,11.5),(0,13.5))[1:]+cb((0,13.5),(-5,11.5),(-10.5,7),(-10.5,0))[1:]+[(-10.5,-8.5)]
    t.prism(o,-1.5,1.5,'#3fa9ff')
    i=[(0,-10),(8,-7),(8,0)]+cb((8,0),(8,5.5),(4,9),(0,10.8))[1:]
    t.prism(i,1.5,1.7,'#6fc0ff');t.prism(st([(-4.5,0),(-1.3,3.2),(4.7,-3.2)],1.2),1.7,2.3,'#ffffff')
def coffee(t):
    t.tube((-1.75,-6),(-1.75,9),6.75,CREAM);t.tube((-1.75,-6.25),(-1.75,-5.9),5.9,'#6b4a2b');t.torus((5.2,1.75),4.3,1.5,CREAM,arc=(-100,100))
    t.text('</>',-1.75,4.6,5.6,6.7,'#3fa9ff')
    for x in (-4.5,1):t.prism(st([(x,-9-i) for i in range(11)],.55),-.25,.25,'#fefefe')
def mortar(t):
    # Mortarboard, origin on top of the skull, in the same units: band, square board seen corner-on, button, tassel.
    t.lathe((0,0,-3.5),(0,0,3),11.5,11,'#1f1f24',seg=24)
    s=17;z0,z1=3,4.6;v=[(s,0,z0),(0,s,z0),(-s,0,z0),(0,-s,z0),(s,0,z1),(0,s,z1),(-s,0,z1),(0,-s,z1)]
    t._add([Vector(p) for p in v],[(3,2,1,0),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],'#2b2b30')
    t.ball((0,0,5),1.7,GOLD);t.lathe((0,0,5),(13.5,-3,5),.55,.55,GOLD,seg=8);t.lathe((13.5,-3,5),(13.5,-3,-4),.55,.55,GOLD,seg=8)
    t.lathe((13.5,-3,-4),(13.5,-3,-9),1.3,1.6,GOLD,seg=10)

# ---------- Worn pieces: what tells an agent's job at a glance on a character without hands ----------
# Hats are modelled in hat units: the brim is a circle of radius 10 at y = 0, the crown rises above it (y < 0 in
# drawing coordinates). The app scales each hat to the skull it sits on.
def dome(t,prof,col,seg=20):t.revolve(0,prof,col,seg=seg)
def hardhat(t):
    Y='#ffcf3a'
    dome(t,[(-8.2,.01),(-7.9,2.6),(-6.9,5.2),(-5.2,7.6),(-2.8,9.5),(-.4,10.6),(.5,10.8)],Y)
    t.lathe(P(0,.2,0),P(0,1.1,0),11.4,11.6,Y,seg=22)                      # brim all round
    t.ball(P(0,.6,9.2),5,Y,(1.2,1,.14))                                # peak
    t.prism(rr(-1.3,-8.6,2.6,8.2,1),-9.6,9.6,'#f2b61f')                   # ridge from front to back
def cap(col,badge=None):
    def f(t):
        dome(t,[(-6.4,.01),(-6.1,3.2),(-5,6.2),(-3.1,8.6),(-.6,10.1),(.6,10.3)],col)
        t.ball(P(0,-6.4,0),1,col,(1,1,.6));t.ball(P(0,.3,10.6),5.6,col,(1.15,1,.12))   # button, peak
        if badge:t.ball(P(0,-3.2,9.1),1.5,badge,(1,.4,1))
    return f
def beret(t):
    R='#c8372d'
    t.ball(P(1.6,-2.4,0),12,R,(1,1,.36),seg=18,rings=9);t.lathe(P(0,-.6,0),P(0,.9,0),9.8,10,'#3a2a2a',seg=20)
    t.lathe(P(1.6,-6.4,0),P(2.4,-8.6,0),.6,.45,R,seg=8)
def eyeshade(t):
    t.lathe(P(0,-1.2,0),P(0,.9,0),10.3,10.3,'#2a2a30',seg=22)             # headband
    # The green brim: a thick crescent tipped down over the eyes.
    t.ball(P(0,2.2,10.5),6.2,'#2fae6b',(1.45,1,.2))                          # green brim
def bowtie(t):
    R='#e2463b'
    t.prism([(0,-1.3),(8.4,-5.2),(9,-4.2),(9,4.2),(8.4,5.2),(0,1.3),(-8.4,5.2),(-9,4.2),(-9,-4.2),(-8.4,-5.2)],-1.5,1.5,R)
    t.ball(P(0,0,.4),2.7,'#b8322a',(1,.8,1))
def glasses(t):
    K='#23232a'
    for x in (-9.9,9.9):t.torus((x,0),6.4,1,K,seg=24)
    t.prism(st(qb((-3.6,-1.2),(0,-3.4),(3.6,-1.2),8),.8),-.7,.7,K)
    for sx in (-1,1):t.lathe(P(sx*16.2,-.6,0),P(sx*21,-1.4,-12),.75,.75,K,seg=8)   # arms, back towards the ears
def inkpot(t):
    B='#27326b'
    t.revolve(0,[(-1,2.2),(-.2,4.4),(1.2,5),(6.4,5),(7,4.4)],B,seg=14);t.tube((0,-3.2),(0,-.8),1.9,B);t.tube((0,-4),(0,-3),2.5,'#c9a25a')
    t.lathe(P(0,2.2,0),P(0,5,0),5.08,5.08,CREAM,seg=14)
def band(t):
    # Headphone band: a half ring of radius 10 over the head, stretched by the app from ear to ear.
    t.torus((0,0),10,1.15,'#23232a',arc=(180,360),seg=20);t.torus((0,0),9.6,1.3,'#4a4a55',arc=(245,295),seg=6)
def cup(t):
    # One ear cup, modelled facing the viewer; the app turns it onto each ear.
    t.lathe(P(0,0,-1.4),P(0,0,0),7.4,7.4,'#4a4a55');t.lathe(P(0,0,0),P(0,0,3.4),6.6,6,'#23232a');t.lathe(P(0,0,3.4),P(0,0,4),4.2,3.8,'#3fa9ff')

def whip(t):
    # A bullwhip: a short, thick, wrapped handle, then a long thin lash of one leather that swings out and
    # hangs in an S down to the cracker. Each ring of the lash knows how far along it sits: the app waves it.
    LEATHER,DARK,TAN='#8a5530','#3a2414','#f1e6cc'
    t.tube((0,14),(0,3.4),2.1,DARK);t.ball(P(0,14.4),2.7,'#8a5a3b',(1,1,.8))
    for y in (11.6,8.4):t.tube((0,y),(0,y-1.2),2.45,'#c9a25a')             # two brass bands on the grip
    t.tube((0,3.8),(0,2.2),2.6,'#8a5a3b')                                   # the collar where the lash starts
    path=[(0,2.4,0),(.5,-6,1.2),(3.5,-12.5,2.4),(9,-14.5,2.2),(14,-10.5,.6),(15.5,-3,-1.2),(13,4,-1.6),(14.5,9.5,-.4),(18.5,11,1)]
    pts=[]
    for k in range(len(path)-1):                                            # Catmull-Rom through the points, for a supple curve
        p0,p1,p2,p3=[Vector(path[max(0,min(len(path)-1,k+d))]) for d in (-1,0,1,2)]
        for q in range(5):
            u=q/5;pts.append(.5*((2*p1)+(-p0+p2)*u+(2*p0-5*p1+4*p2-p3)*u*u+(-p0+3*p1-3*p2+p3)*u**3))
    pts.append(Vector(path[-1]));n=len(pts)-1
    rad=lambda k:1.5*(1-k/n)**.9+.34
    for k in range(n):
        t.lathe(P(*pts[k]),P(*pts[k+1]),rad(k),rad(k+1),LEATHER,seg=7,pa=max(k/n,.004),pb=(k+1)/n)
    e=pts[-1];t.lathe(P(*e),P(e.x+2.4,e.y+.9,e.z+.5),.36,1,TAN,seg=6,pa=1,pb=1)   # the cracker

# ---------- More jobs: each one is an accessory of its own in the configurator ----------
def star(cx,cy,R,r=None,n=5,rot=-90):
    r=R*.45 if r is None else r
    return [(cx+(R if i%2==0 else r)*math.cos(math.radians(rot+180*i/n)),cy+(R if i%2==0 else r)*math.sin(math.radians(rot+180*i/n))) for i in range(2*n)]
def crv(path,k=5):
    # Catmull-Rom through drawing-space points (x, y, t), returned as Blender points.
    pts=[]
    for i in range(len(path)-1):
        p0,p1,p2,p3=[Vector(path[max(0,min(len(path)-1,i+d))]) for d in (-1,0,1,2)]
        for q in range(k):
            u=q/k;pts.append(.5*((2*p1)+(-p0+p2)*u+(2*p0-5*p1+4*p2-p3)*u*u+(-p0+3*p1-3*p2+p3)*u**3))
    pts.append(Vector(path[-1]));return [P(*v) for v in pts]
HAT_PATH=[(0,0,0),(0,-5,-.2),(.4,-9.5,-.7),(1.6,-13.5,-1.4),(3.8,-16.4,-2.2),(6.8,-17.6,-2.8),(9.4,-16.6,-3)]
def wizard_hat(t):
    # A wide brim, then a cone that rises and flops over to the right at its tip, swept as one smooth skin;
    # a gold band and stars.
    PU,PD,G='#5b3fa8','#46308a',GOLD
    t.lathe(P(0,-.4,0),P(0,.9,0),14.5,14.8,PD,seg=26)
    pts=crv(HAT_PATH,5);n=len(pts)-1;rad=lambda k:9.8*(1-k/n)**1.1+.3;seg=22
    v=[];f=[];prev=None
    for k,c in enumerate(pts):
        z=(pts[min(n,k+1)]-pts[max(0,k-1)]).normalized()
        x=(prev-prev.dot(z)*z).normalized() if prev else Vector((1,0,0));prev=x;y=z.cross(x)
        for j in range(seg):
            a=2*math.pi*j/seg;v.append(c+(x*math.cos(a)+y*math.sin(a))*rad(k))
    for k in range(n):
        for j in range(seg):
            q=(j+1)%seg;f.append((k*seg+j,k*seg+q,(k+1)*seg+q,(k+1)*seg+j))
    f.append([j for j in range(seg-1,-1,-1)]);f.append([n*seg+j for j in range(seg)])
    t._add(v,f,PU)
    t.lathe(P(0,-.2,0),P(0,-2.8,0),10,9.1,G,seg=24)
    t.ball(pts[-1],1.5,G)
    def surf(y):
        # The cone's centre and radius at height y (drawing units), read off the curve.
        k=min(range(n+1),key=lambda i:abs(-pts[i].z-y));return pts[k],rad(k)
    for x,y,R in ((-3.4,-6,1.8),(2.6,-9,1.4),(-.4,-12.2,1.1),(3.6,-4.4,1.1)):
        c,r_=surf(y);dx=x-c.x;z=-c.y+math.sqrt(max(.1,r_*r_-dx*dx))
        t.prism(star(x,y,R),z-.4,z+.3,'#ffd84a')
def wand(t):
    # A dark rod, a white tip and a gold star; the app spins the star ('#ffd84b') about the rod.
    t.tube((0,14),(0,-7),1.05,'#2a2a30',r2=.85);t.tube((0,-7),(0,-10.5),.85,'#f6f1e7',r2=.75)
    for y in (11,9.6):t.tube((0,y),(0,y-.7),1.25,GOLD)
    t.prism(star(0,-15,5.2,2.3),-1.1,1.1,'#ffd84b')
def toque(t):
    # A chef's hat in one smooth skin: a band of fine pleats, then a puffed top of eight soft lobes that overhangs it
    # and rounds off. Hat units: band radius 10 at y = 0.
    W='#fbfaf6';N=64
    prof=[(.6,10),(0,10),(-1.6,10.05),(-3.2,10.15),(-3.9,10.7),(-4.7,11.9),(-6,12.8),(-7.6,12.9),(-9.2,12.1),(-10.4,10.3),(-11.3,7.7),(-11.9,4.6),(-12.2,1.6),(-12.25,.01)]
    v=[];f=[];R=len(prof)
    for i in range(N):
        a=2*math.pi*i/N
        for y,r in prof:
            # Pleats on the band, lobes on the puff, fading out towards the crown of the hat.
            band=max(0,min(1,(y+3.6)/.6));puff=1-band
            m=1+.012*band*math.cos(24*a)+puff*.07*math.cos(8*a)*max(0,min(1,(r-1)/4))
            v.append(P(r*m*math.cos(a),y,r*m*math.sin(a)))
    for i in range(N):
        j=(i+1)%N
        for k in range(R-1):f.append((i*R+k,j*R+k,j*R+k+1,i*R+k+1))
    t._add(v,f,W)
    # A seam where the puff gathers onto the band.
    t.revolve(0,[(-3.9,10.4),(-3.5,10.55),(-3.1,10.4)],'#efede6',seg=48,caps=False)
def whisk(t):
    # A balloon whisk: a red handle, a steel collar and four wire loops turned about the handle.
    t.tube((0,14),(0,1.5),1.7,'#e2463b');t.ball(P(0,14),1.7,'#e2463b');t.tube((0,1.8),(0,-.6),1.9,STEEL)
    for k in range(4):
        ph=math.pi*k/4;pts=[]
        for q in range(29):
            a=2*math.pi*q/28;w=5.4*math.sin(a)*math.sin(a/2)**.8;y=-.6-14.5*(1-math.cos(a))/2
            pts.append(P(w*math.cos(ph),y,w*math.sin(ph)))
        t.path(pts,.34,STEEL,seg=5)
def crown(t):
    # A royal crown in hat units (band radius 10): a sheet of gold that flares a little as it rises, its top edge cut
    # into eight fleurons each tipped by a pearl, a rolled rim at the base, gems all round, a red velvet cap inside
    # and a gold orb with its cross on top.
    G,GD,VEL='#ffc233','#e0a21c','#a3182e'
    N,ROWS,TH=96,6,.55
    top=lambda a:-(3.6+5.2*(1-abs((((a-math.pi/2)*8/(2*math.pi)+.5)%1)-.5)*2)**1.7)
    rad=lambda a,y:10.05+.09*(-y)
    v=[];f=[]
    for side in (0,1):                                         # outer skin, then inner skin
        for i in range(N):
            a=2*math.pi*i/N;h=top(a)
            for r in range(ROWS+1):
                y=.4+(h-.4)*r/ROWS;R=rad(a,y)-(TH if side else 0)
                v.append(P(R*math.cos(a),y,R*math.sin(a)))
    idx=lambda side,i,r:side*N*(ROWS+1)+(i%N)*(ROWS+1)+r
    for i in range(N):
        for r in range(ROWS):
            f.append((idx(0,i,r),idx(0,i+1,r),idx(0,i+1,r+1),idx(0,i,r+1)))
            f.append((idx(1,i,r),idx(1,i,r+1),idx(1,i+1,r+1),idx(1,i+1,r)))
        f.append((idx(0,i,ROWS),idx(0,i+1,ROWS),idx(1,i+1,ROWS),idx(1,i,ROWS)))   # the cut edge
        f.append((idx(0,i,0),idx(1,i,0),idx(1,i+1,0),idx(0,i+1,0)))
    t._add(v,f,G)
    t.revolve(0,[(-.9,10.35),(-.3,10.75),(.5,10.8),(1.1,10.4)],GD,seg=48,caps=False)     # rolled rim
    t.revolve(0,[(-2.9,10.5),(-2.5,10.62),(-2.1,10.5)],GD,seg=48,caps=False)             # a fine moulding above the gems
    for k in range(8):
        a=math.pi/2+2*math.pi*k/8;h=top(a);R=rad(a,h)-TH/2
        t.ball(P(R*math.cos(a),h-.6,R*math.sin(a)),.8,'#fff4dc',seg=10,rings=6)
        # Gems: a big one under each fleuron, a small one between them.
        g=('#e2463b','#2fae6b','#3f8fe0','#9b4dd8')[k%4];Rg=10.55
        t.ball(P(Rg*math.cos(a),-1.4,Rg*math.sin(a)),1.25,g,(1,1,1),seg=10,rings=6)
        a2=math.pi/2+2*math.pi*(k+.5)/8;t.ball(P(Rg*math.cos(a2),-1.4,Rg*math.sin(a2)),.6,'#fff8e8',seg=8,rings=5)
    t.ball(P(0,-2.6,0),9.7,VEL,(1,1,.62),seg=24,rings=10)                                  # velvet cap
    t.ball(P(0,-9.4,0),1.5,G,seg=12,rings=7)                                               # orb
    t.lathe(P(0,-10.6,0),P(0,-13.4,0),.42,.42,G,seg=8);t.lathe(P(-1.3,-12.2,0),P(1.3,-12.2,0),.42,.42,G,seg=8)
def bulb(t):
    # A light bulb: its glass ('#ffe680', the app makes it glow and pulse), a screw base and a dark tip.
    t.revolve(0,[(-17,.6),(-16.4,4.2),(-14.5,7.6),(-11,9.4),(-7,9.3),(-3.6,7.4),(-.8,5),(1.2,4.6)],'#ffe680',seg=22)
    for y in (1.2,3,4.8):t.lathe(P(0,y,0),P(0,y+1.6,0),5,5,'#b9bfc6',seg=18);t.lathe(P(0,y+1.6,0),P(0,y+1.9,0),4.6,4.6,'#8e949c',seg=18)
    t.revolve(0,[(6.7,4.5),(8,3.2),(8.9,1.6),(9.2,.2)],'#5b5f66',seg=16)
    t.ball(P(-3.4,-11.5,7.6),1.8,'#ffffff',(1,.4,1.4))   # a highlight on the glass
def rocket(t):
    # A little rocket on three fins, a porthole, and a flame below that flickers ('#ff7a1a' and '#ffd23e').
    W,R='#f6f1e7','#e2463b'
    t.revolve(0,[(-17,.2),(-15.6,2),(-13,3.9),(-10,5)],R,seg=20)
    t.revolve(0,[(-10,5),(-6,5.6),(0,5.7),(5,5.3),(8,4.4)],W,seg=20)
    t.revolve(0,[(8,4.4),(9.4,3.6),(10.6,2.6)],'#8e949c',seg=16)
    for k in range(3):
        a=2*math.pi*k/3+math.pi/2;dx,dz=math.cos(a),math.sin(a)
        v=[P(5.2*dx,-.5,5.2*dz),P(5*dx,8,5*dz),P(10.5*dx,15.2,10.5*dz),P(10.5*dx,9.5,10.5*dz)];side=Vector((dz,dx,0))*.75
        t._add([x+side for x in v]+[x-side for x in v],[(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],R)
    t.lathe(P(0,-3,4.2),P(0,-3,6.2),3.3,3.1,'#8e949c',seg=20);t.ball(P(0,-3,6.2),2.5,'#3fa9ff',(1,.45,1),seg=16)
    t.ball(P(-.8,-3.8,7.2),.6,'#ffffff',(1,.4,1))
    t.revolve(0,[(10.4,2.6),(11.6,3.1),(12.8,2.6),(13.4,1.4)],'#ff7a1a',seg=14)
    t.revolve(0,[(12.4,1.9),(13.6,1.7),(14.6,1),(15.2,.15)],'#ffd23e',seg=12)
def flask(t):
    # An Erlenmeyer flask: green liquid, bubbles above it ('#c8ffe0', the app makes them rise out of the
    # neck), and the glass, drawn last.
    t.revolve(0,[(2.5,5),(4.5,7.2),(8,9.8),(10.4,10.1),(11.2,8.9)],'#3ddc84',seg=22)
    t.lathe(P(0,2.4,0),P(0,2.5,0),4.95,4.95,'#7af0b0',seg=22)
    for x,ph,r_ in ((-1,.04,.75),(1.1,.36,.6),(-.2,.7,.85),(.7,.2,.55),(-.7,.53,.65)):t.ball(P(x,0,(ph-.4)*1.5),r_,'#c8ffe0',par=ph)
    t.revolve(0,[(-12.6,2.9),(-6,2.6),(-1,2.8),(1.5,4.4),(4.5,7.6),(8,10.2),(10.6,10.6),(11.6,9.4)],GLASS,seg=22,caps=False)
    t.lathe(P(0,-13.2,0),P(0,-12.4,0),3.5,3.4,GLASS,seg=22)
def gamepad(t):
    # A game controller: a dark body with two grips, a cross, four coloured buttons and two sticks.
    K,KD='#3a3a42','#2a2a30'
    t.prism(rr(-12.5,-6.5,25,11,5.2),-1.6,1.6,K)
    for x in (-8.4,8.4):t.prism(el(x,3.6,4.6,6.4,22),-1.55,1.55,K)
    t.prism(rr(-10.6,-1.9,6.8,2.2,.6),1.6,2.15,KD);t.prism(rr(-8.3,-4.2,2.2,6.8,.6),1.6,2.15,KD)
    for (x,y),c in zip(((7.8,-3.6),(10.4,-1.1),(7.8,1.4),(5.2,-1.1)),('#2fd4a5','#e2463b','#3fa9ff','#ffc233')):t.lathe(P(x,y,2.4),P(x,y,3.5),1.15,1,c,seg=12)
    for x in (-3.4,3.4):t.lathe(P(x,2.6,2.4),P(x,2.6,3.6),2.1,1.8,KD,seg=14);t.lathe(P(x,2.6,3.6),P(x,2.6,4.1),1.7,1.6,'#4a4a55',seg=14)
    t.prism(rr(-1.6,-4.6,3.2,1.4,.6),1.6,1.9,'#a35bff')
def camera(t):
    # A camera: a dark body, a silver top, a big lens towards the viewer, a flash and a red button.
    K='#3a3a42'
    t.prism(rr(-12,-6,24,15,2.6),-2.5,2.5,K);t.prism(rr(-12.2,-6.2,24.4,4.6,2.2),-2.6,2.6,'#c9ccd2')
    t.prism(rr(-7.6,-9.6,7.6,4,1.2),-1.6,1.6,'#c9ccd2')
    t.lathe(P(1,2.4,2.8),P(1,2.4,6),6.2,5.6,'#23232a',seg=24);t.lathe(P(1,2.4,6),P(1,2.4,7),5.6,5.2,'#8e949c',seg=24)
    t.ball(P(1,2.4,6.8),4.4,'#3a6fb0',(1,.35,1),seg=18);t.ball(P(-.6,.8,8.2),1,'#ffffff',(1,.4,1))
    t.prism(rr(5.4,-5.4,5,2.6,.6),2.6,2.9,'#fff6c8');t.lathe(P(7.6,-6.2,0),P(7.6,-7.6,0),1.5,1.4,'#e2463b',seg=12)
def straw_hat(t):
    # A wide straw hat with a red band.
    S='#e8c77a'
    t.ball(P(0,.3,0),15.8,S,(1,1,.07),seg=28,rings=8)
    t.revolve(0,[(-7.4,5.4),(-7,7.6),(-5.6,9.4),(-3,10.2),(0,10.3)],S,seg=24)
    t.lathe(P(0,-3.2,0),P(0,-.4,0),10.5,10.45,'#e2463b',seg=24)
def plant(t):
    # A terracotta pot, its soil, and a young plant whose leaves sway: each leaf carries how much, the app waves it.
    T,TD,L,LD='#c8643c','#a94f2d','#5cbf4a','#3f9a3a'
    t.revolve(0,[(1,7.2),(3.2,7.2),(3.2,6.3),(14,4.8)],T,seg=20);t.revolve(0,[(1,7.5),(3.2,7.5)],TD,seg=20,caps=False)
    t.lathe(P(0,.5,0),P(0,1,0),6.6,6.6,'#5a3a22',seg=18)
    t.path([P(0,.8,0),P(.3,-4,0),P(-.4,-8.5,0),P(0,-12.4,0)],.55,LD,seg=6,par=[.01,.3,.65,1])
    for x,y,yaw,w in ((-3.6,-4,30,.35),(3.4,-6.6,-25,.6),(-3.2,-9.6,-20,.85),(2.8,-12,35,1)):
        old=set(t.bm.verts);t.ball(P(x,y,0),3.5,L,(1,.55,.3),seg=12,rings=6,par=w)
        new=[v for v in t.bm.verts if v not in old];tilt=-math.copysign(math.radians(28),x)
        bmesh.ops.rotate(t.bm,verts=new,cent=P(x,y,0),matrix=Matrix.Rotation(math.radians(yaw),3,'Z')@Matrix.Rotation(tilt,3,'Y'))
    t.ball(P(0,-13.6,0),2.1,'#ffcf3a',par=1);t.ball(P(0,-13.8,1.6),1,'#e2463b',(1,.6,1),par=1)
def guitar(t):
    # An acoustic guitar standing on its end: a body of two rounded halves and its sides, a sound hole, a bridge,
    # the neck, the head and its pegs, and six strings.
    B,BD,N='#e08a3a','#b86a28','#6b4a2b'
    t.prism(el(0,8.5,8.2,7.2,26),-2.2,2.2,B);t.prism(el(0,-1.2,6.4,5.6,24),-2.15,2.15,B)
    t.prism(el(0,8.5,8.55,7.55,26),-1.6,1.6,BD);t.prism(el(0,-1.2,6.75,5.95,24),-1.55,1.55,BD)
    t.prism(el(0,1.6,2.4),2.15,2.3,'#2a1a10');t.prism(rr(-3.4,10.6,6.8,1.8,.6),2.2,2.8,N)
    t.prism(rr(-1.5,-24,3,25,.8),1,2.6,N);t.prism(rr(-2.2,-29,4.4,5.4,1.2),.9,2.3,'#4a3220')
    for y in (-28,-26.4,-24.8):
        for sx in (-1,1):t.tube((sx*2.2,y),(sx*3.8,y),.55,'#d9dde2',t=1.6)
    for k in range(6):
        x=-1.05+.42*k;t.tube((x,-24),(x*1.6,11.4),.12,'#eef0f2',t=2.75)

# Name, builder, the drawing's tilt in degrees (clockwise).
TOOLS=[('loupe',loupe,0),('pen',pen,38),('quill',quill,32),('hammer',hammer,-32),('wrench',wrench,36),('baton',baton,0),('telescope',telescope,-28),
       ('envelope',envelope,-10),('calendar',calendar,-8),('clipboard',clipboard,-8),('hourglass',hourglass,-12),('teacher',teacher,-14),
       ('calculator',calculator,-10),('chart',chart,-8),('brush',brush,38),('globe',globe,0),('megaphone',megaphone,-14),('shield',shield,-6),
       ('coffee',coffee,0),('cap',mortar,0),('hardhat',hardhat,0),('cap_mech',cap('#5b7fa6'),0),('cap_post',cap('#2b3f73','#ffcf3a'),0),
       ('beret',beret,0),('bowtie',bowtie,0),('glasses',glasses,0),('inkpot',inkpot,0),('band',band,0),('cup',cup,0),('whip',whip,0),
       ('wizard_hat',wizard_hat,0),('wand',wand,0),('toque',toque,0),('whisk',whisk,0),('crown',crown,0),('bulb',bulb,0),('rocket',rocket,0),
       ('flask',flask,0),('gamepad',gamepad,-10),('camera',camera,-6),('straw_hat',straw_hat,0),('plant',plant,0),('guitar',guitar,-12)]
def b64(a,dt):return base64.b64encode(np.ascontiguousarray(a,dtype=dt).tobytes()).decode()
data={}
for i,(name,fn,deg) in enumerate(TOOLS):
    t=Tool({'bowtie':1.6,'envelope':2.2,'calendar':2.6,'clipboard':2.4,'teacher':2.2,'calculator':2.4,'chart':2.6,'shield':2.2,'wrench':1.7,'quill':1.4,'gamepad':1.6,'camera':1.3,'guitar':1.4}.get(name,1));fn(t);o=t.finish('Acc_'+name,bevel=0 if name in ('whip','whisk','plant','flask','wizard_hat','crown','toque','straw_hat','bulb','rocket','wand') else .3);o['tilt']=deg
    me=o.data;me.calc_loop_triangles()
    LN=np.array([n.vector for n in me.corner_normals]);PV=np.array([v.co for v in me.vertices])
    cols=np.array([[int(h[k:k+2],16) for k in (1,3,5)] for h in t.mats])
    par=me.attributes.get('par')
    key={};pos=[];nrm=[];col=[];idx=[]
    clear=lambda tr:t.mats[me.polygons[tr.polygon_index].material_index] in (GLASS,'#fefefe')
    for tr in sorted(me.loop_triangles,key=clear):
        c=cols[me.polygons[tr.polygon_index].material_index]
        for li in tr.loops:
            vi=me.loops[li].vertex_index;k=(vi,tuple(np.round(LN[li],2)),tr.material_index)
            if k not in key:key[k]=len(pos);pos.append(PV[vi]);nrm.append(LN[li]);col.append((*c,round(255*min(1,max(0,par.data[vi].value))) if par else 0))
            idx.append(key[k])
    pos=np.array(pos);nrm=np.array(nrm)
    # Blender Z-up -> three.js Y-up.
    three=lambda a:np.stack([a[:,0],a[:,2],-a[:,1]],1)
    data[name]={'tilt':deg,'pos':b64(three(pos),'<f4'),'nrm':b64(three(nrm),'<f4'),'col':b64(np.array(col),'u1'),'idx':b64(np.array(idx),'<u2')}
    print('ACC',name,'verts',len(pos),'tris',len(idx)//3,flush=True)
    # Lay the object out for the .blend and the contact sheet, tilted as the mascot holds it.
    o.location=((i%5)*36,0,-(i//5)*38);o.rotation_euler=(0,math.radians(deg),0)
(DATA/'accessories.json').write_text(json.dumps(data))

# ---------- contact sheet ----------
scene.render.engine='BLENDER_EEVEE_NEXT';scene.render.resolution_x=1500;scene.render.resolution_y=1800
w=bpy.data.worlds.new('w');scene.world=w;w.use_nodes=True;bg=w.node_tree.nodes['Background'];bg.inputs[0].default_value=(.03,.03,.035,1);bg.inputs[1].default_value=1.5
for rot,e in (((math.radians(55),0,math.radians(-30)),4),((math.radians(60),0,math.radians(150)),1.2)):
    l=bpy.data.lights.new('sun','SUN');l.energy=e;lo=bpy.data.objects.new('sun',l);lo.rotation_euler=rot;scene.collection.objects.link(lo)
cam=bpy.data.cameras.new('c');cam.type='ORTHO';cam.ortho_scale=190;co=bpy.data.objects.new('c',cam);scene.collection.objects.link(co);scene.camera=co
# A little from the right and above, so the volume shows.
co.location=(72+70,-300,-95+60);co.rotation_euler=(math.radians(90-11.3),0,math.radians(13.1))
scene.render.filepath=str(OUT/'renders'/'accessories_sheet.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'Accessories.blend'),compress=True)
print('ACCESSORIES OK',len(data),flush=True)
