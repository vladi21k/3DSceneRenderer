"""Clay preview renders of a body mesh (OBJ) from several angles, for sculpting checks.

  tools/dk blender -b --factory-startup -P tools/blender/humans_preview.py -- in.obj out_prefix [zoom]
zoom: 'body' (default), 'head', 'hand', 'foot'
"""
import sys
import math
import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
zoom = argv[2] if len(argv) > 2 else 'body'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=src, forward_axis='NEGATIVE_Z', up_axis='Y')
obj = bpy.context.selected_objects[0]
bpy.ops.object.shade_smooth()
mat = bpy.data.materials.new('clay')
mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (0.55, 0.42, 0.34, 1)
bsdf.inputs['Roughness'].default_value = 0.55
obj.data.materials.append(mat)

scn = bpy.context.scene
scn.render.engine = 'CYCLES'
scn.cycles.samples = 24
scn.cycles.use_denoising = True
scn.render.resolution_x, scn.render.resolution_y = (420, 760) if zoom == 'body' else (520, 520)
world = bpy.data.worlds.new('w')
scn.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.6, 0.65, 0.7, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
scn.collection.objects.link(sun)

# Blender is Z-up after import: runtime (x, y, z) -> blender (x, -z, y)
targets = {'body': ((0, 0, 0.9), 4.6, 26), 'head': ((0, 0.0, 1.62), 0.9, 22),
           'hand': ((0.42, 0, 0.85), 0.8, 22), 'foot': ((0.1, 0, 0.08), 0.9, 24)}
tgt, dist, lens_fov = targets[zoom]
if len(argv) > 3:
    tgt = (tgt[0], tgt[1], float(argv[3]))
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
scn.collection.objects.link(cam)
scn.camera = cam
cam.data.angle = math.radians(lens_fov)
aim = bpy.data.objects.new('aim', None)
scn.collection.objects.link(aim)
aim.location = tgt
con = cam.constraints.new('TRACK_TO')
con.target = aim
con.track_axis = 'TRACK_NEGATIVE_Z'
con.up_axis = 'UP_Y'
views = {'front': 0, 'q34': 35, 'side': 90, 'back': 180}
for name, az in views.items():
    a = math.radians(az)
    # the figure faces -Z at runtime, which the OBJ importer maps to +Y in Blender
    cam.location = (tgt[0] + dist * math.sin(a), tgt[1] + dist * math.cos(a), tgt[2] + dist * 0.05)
    scn.render.filepath = f'{out}_{name}.png'
    bpy.ops.render.render(write_still=True)
