"""Clay preview renders of the figure sculpts, for anatomy checks.

  tools/dk blender -b --factory-startup -P tools/blender/humans_preview.py -- \
      --bases male,female,child,kid [--parts hair_long,backpack] [--build 0] [--res 0.005] \
      [--zoom body|head|torso|legs] [--views front,side,back,q34] [--out .work/x.png]
  (legacy) ... -- in.obj out_prefix [zoom]

The bodies are meshed straight from the signed distance anatomy (humans_body.py) and drawn
side by side, one row per base and one column per view, at true relative scale under an
orthographic camera (front: facing the camera; side: the figure's right side; back; q34).
"""
import os
import sys
import math
import argparse
import numpy as np
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def setup_scene(w, h, samples=20):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'
    scn.cycles.samples = samples
    scn.cycles.use_denoising = True
    scn.render.resolution_x, scn.render.resolution_y = w, h
    scn.render.film_transparent = False
    world = bpy.data.worlds.new('w')
    scn.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.6, 0.66, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.55
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(3)
    sun.rotation_euler = (math.radians(42), math.radians(8), math.radians(28))
    scn.collection.objects.link(sun)
    return scn


def clay(name='clay', col=(0.55, 0.42, 0.34)):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*col, 1)
    bsdf.inputs['Roughness'].default_value = 0.55
    return mat


def mesh_object(name, V, T, mat):
    """Runtime coordinates (x, y up, z back) -> Blender (x, -z, y)."""
    me = bpy.data.meshes.new(name)
    Vb = np.stack([V[:, 0], -V[:, 2], V[:, 1]], 1).astype(np.float32)
    me.vertices.add(len(Vb))
    me.vertices.foreach_set('co', Vb.ravel())
    me.loops.add(len(T) * 3)
    me.loops.foreach_set('vertex_index', T.astype(np.int32).ravel())
    me.polygons.add(len(T))
    me.polygons.foreach_set('loop_start', np.arange(0, len(T) * 3, 3, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(T), 3, np.int32))
    me.update()
    me.validate()
    me.shade_smooth()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def legacy(src, out, zoom):
    scn = setup_scene(420 if zoom == 'body' else 520, 760 if zoom == 'body' else 520, 24)
    bpy.ops.wm.obj_import(filepath=src, forward_axis='NEGATIVE_Z', up_axis='Y')
    obj = bpy.context.selected_objects[0]
    bpy.ops.object.shade_smooth()
    obj.data.materials.append(clay())
    targets = {'body': ((0, 0, 0.9), 4.6, 26), 'head': ((0, 0.0, 1.62), 0.9, 22), 'face': ((0, 0.0, 1.615), 0.5, 26),
               'hand': ((0.42, 0, 0.85), 0.8, 22), 'foot': ((0.1, 0, 0.08), 0.9, 24)}
    tgt, dist, lens_fov = targets[zoom]
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
    for name, az in {'front': 0, 'q34': 35, 'side': 90, 'back': 180}.items():
        a = math.radians(az)
        cam.location = (tgt[0] + dist * math.sin(a), tgt[1] + dist * math.cos(a), tgt[2] + dist * 0.05)
        scn.render.filepath = f'{out}_{name}.png'
        bpy.ops.render.render(write_still=True)


def hands(a, bases, S, B):
    """The right hand of each base alone (wrist at the origin), one row per base."""
    views = {'front': 0, 'side': 90, 'back': 180, 'q34': 35, 'q34b': 145, 'side2': -90}
    vlist = [v for v in a.views.split(',') if v]
    colw, rowh = 0.18, 0.30
    W = colw * len(vlist)
    scn = setup_scene(int(W * 2400), int(rowh * 2400 * len(bases)), a.samples)
    mat = clay()
    for ri, kind in enumerate(bases):
        T = B.TEMPLATES[kind]
        _, sh, el, wr, du, df = B.arm_joints(T, 1)
        node = B.hand_sdf(T, 1, wr, df + np.array([0, 0, -0.05]), T['handS'])
        node = S.Union([node, S.RoundCone(wr - df * 0.06, wr, 0.024 * T['handS'], 0.021 * T['handS'])], k=0.008)
        F, org = S.eval_grid(node, node.lo - 0.01, node.hi + 0.01, a.res)
        V, Tr = S.surface_nets(F, org, a.res)
        V = S.project(node, V.astype(np.float32), 2).astype(np.float64)
        Tr, _ = S.fix_winding(node, V, Tr)
        V = V - wr + np.array([0, 0.11, 0])
        row_y = (len(bases) - 1 - ri) * rowh
        for ci, vname in enumerate(vlist):
            ob = mesh_object(f'h{kind}{vname}', V, Tr, mat)
            ob.rotation_euler = (0, 0, math.radians(views[vname]) + math.pi)
            ob.location = (ci * colw + colw / 2 - W / 2, 0, row_y)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam.data.type = 'ORTHO'
    tot_h = rowh * len(bases)
    cam.data.ortho_scale = max(W, tot_h)
    cam.location = (0, -10, tot_h / 2)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scn.render.filepath = os.path.abspath(a.out)
    bpy.ops.render.render(write_still=True)


def main():
    if argv and not argv[0].startswith('--'):
        legacy(argv[0], argv[1], argv[2] if len(argv) > 2 else 'body')
        return
    import humans_sdf as S
    import humans_body as B
    import humans_parts as PARTS
    ap = argparse.ArgumentParser()
    ap.add_argument('--bases', default='male,female,child,kid')
    ap.add_argument('--parts', default='')
    ap.add_argument('--build', type=float, default=0.0)
    ap.add_argument('--belly', type=float, default=0.0)
    ap.add_argument('--res', type=float, default=0.005)
    ap.add_argument('--zoom', default='body')
    ap.add_argument('--views', default='front,side,back,q34')
    ap.add_argument('--px', type=int, default=300, help='pixels per metre')
    ap.add_argument('--samples', type=int, default=20)
    ap.add_argument('--out', default='.work/shots/anat/clay.png')
    a = ap.parse_args(argv)
    bases = [b for b in a.bases.split(',') if b]
    views = {'front': 0, 'side': 90, 'back': 180, 'q34': 35, 'q34b': 145, 'side2': -90}
    vlist = [v for v in a.views.split(',') if v]
    if a.zoom == 'hand':
        return hands(a, bases, S, B)
    zoom = {'body': (0.0, 1.0), 'head': (0.80, 1.02), 'torso': (0.45, 0.92), 'legs': (0.0, 0.58), 'upper': (0.55, 1.02)}[a.zoom]
    row_parts = a.parts.split(';')
    Hmax = max(B.TEMPLATES[b]['H'] for b in bases)
    y0, y1 = zoom[0] * Hmax - 0.03, zoom[1] * Hmax + 0.02
    colw = 0.75 if a.zoom == 'body' else 0.55
    if a.zoom == 'upper':
        colw = 0.6
    if a.zoom == 'head':
        colw = 0.42
    W = colw * len(vlist)
    Hh = (y1 - y0)
    ppm = a.px if a.zoom == 'body' else a.px * (1.6 if a.zoom == 'upper' else 2.2)
    scn = setup_scene(int(W * ppm), int(Hh * ppm * len(bases)), a.samples)
    mat = clay()
    mat_p = clay('part', (0.18, 0.15, 0.13))
    for ri, kind in enumerate(bases):
        node, skel, info = B.build_body(kind, a.build, a.belly)
        H = info['H']
        lo = np.array([-0.62, -0.004, -0.3]) * max(H / 1.76, 0.6)
        hi = np.array([0.62 * max(H / 1.76, 0.6), H + 0.01, 0.3 * max(H / 1.76, 0.6)])
        if a.zoom != 'body':
            lo[1] = max(lo[1], y0 - 0.05)
            hi[1] = min(hi[1], y1 + 0.05)
        F, org = S.eval_grid(node, lo, hi, a.res)
        V, T = S.surface_nets(F, org, a.res)
        V = S.project(node, V.astype(np.float32), 2).astype(np.float64)
        T, _ = S.fix_winding(node, V, T)
        objs = [(V, T, mat)]
        for pname in [p for p in row_parts[min(ri, len(row_parts) - 1)].split(',') if p]:
            pn, _, _ = PARTS.part_node(kind, pname, node)
            Fp, op = S.eval_grid(pn, pn.lo - 0.01, pn.hi + 0.01, a.res * 0.7)
            if (Fp < 0).sum() == 0:
                continue
            Vp, Tp = S.surface_nets(Fp, op, a.res * 0.7)
            Vp = S.project(pn, Vp.astype(np.float32), 2).astype(np.float64)
            Tp, _ = S.fix_winding(pn, Vp, Tp)
            objs.append((Vp, Tp, mat_p))
        row_y = (len(bases) - 1 - ri) * Hh
        for ci, vname in enumerate(vlist):
            az = math.radians(views[vname])
            for (Vm, Tm, mm) in objs:
                ob = mesh_object(f'{kind}_{vname}', Vm, Tm, mm)
                ob.rotation_euler = (0, 0, az + math.pi)   # front view: figure faces the camera (-Y)
                ob.location = (ci * colw + colw / 2 - W / 2, 0, row_y - y0)
        print('[preview]', kind, 'H', H, 'verts', len(V), flush=True)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam)
    scn.camera = cam
    cam.data.type = 'ORTHO'
    tot_h = Hh * len(bases)
    cam.data.ortho_scale = max(W, tot_h)
    cam.location = (0, -10, tot_h / 2)
    cam.rotation_euler = (math.radians(90), 0, 0)
    # ground line
    scn.render.filepath = os.path.abspath(a.out)
    bpy.ops.render.render(write_still=True)
    print('[preview] wrote', a.out, flush=True)


main()
