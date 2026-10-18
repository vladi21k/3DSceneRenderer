"""Preview of the exported crowd cast (assets/humans_mh) in Blender: a lineup rendered front / side / back.

  TRAM_TOOLS_IMAGE=tramline-mh:latest DK_GPU=1 tools/dk blender -b -P tools/blender/mh_preview.py -- \
      [--lod 0] [--only m01,f02] [--views front,side,back,threeq] [--out .work/mh/preview] [--samples 64] [--res 1800]
      [--rows 3] [--street]

Reads cast.json / cast.bin.gz and the WebP layer strips exactly as the runtime will (quantised positions,
uint8 skin weights are ignored: the rest pose is shown), shades with the runtime conventions: detail
layers albedo = 2 * texel * tint, colour layers texel * tint, baked AO multiplied in, alpha-tested cards.
"""
import os
import sys
import json
import gzip
import math
import argparse
import numpy as np
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, 'assets', 'humans_mh')
if '--src' in sys.argv:
    SRC = os.path.abspath(sys.argv[sys.argv.index('--src') + 1])


def args_():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--lod', type=int, default=0)
    p.add_argument('--src', default=SRC)
    p.add_argument('--only', default='')
    p.add_argument('--views', default='front,side,back')
    p.add_argument('--out', default=os.path.join(ROOT, '.work', 'mh', 'preview'))
    p.add_argument('--samples', type=int, default=48)
    p.add_argument('--res', type=int, default=2400)
    p.add_argument('--rows', type=int, default=3)
    p.add_argument('--street', action='store_true', help='also render a street-distance group shot')
    p.add_argument('--cpu', action='store_true')
    p.add_argument('--zoom', default='', help='y0,y1: frame a height band (single row)')
    p.add_argument('--debug', default='', help='albedo: unlit albedo; nonormal: no normal maps')
    return p.parse_args(a)


def layer_images(doc, outdir):
    """Split the WebP strips into one PNG per layer (Blender image per layer)."""
    from_strips = {}
    tex = doc['textures']
    S = tex['size']
    os.makedirs(outdir, exist_ok=True)
    for kind in ('albedo', 'normal'):
        li = 0
        for st in tex[kind]:
            img = bpy.data.images.load(os.path.join(SRC, st['file']))
            w, h = img.size
            px = np.empty(w * h * 4, np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(h, w, 4)       # Blender rows: bottom to top
            if st.get('alpha'):
                aimg = bpy.data.images.load(os.path.join(SRC, st['alpha']))
                ap = np.empty(w * h * 4, np.float32)
                aimg.pixels.foreach_get(ap)
                px[..., 3] = ap.reshape(h, w, 4)[..., 0]
                bpy.data.images.remove(aimg)
            for k in range(st['layers']):
                # strip layer k occupies image rows [k*S, (k+1)*S) from the top
                y0 = h - (k + 1) * S
                sub = px[y0:y0 + S]
                im = bpy.data.images.new(f'{kind}_{li}', S, S, alpha=True, is_data=(kind == 'normal'))
                im.pixels.foreach_set(sub.ravel())
                im.pack()
                from_strips[(kind, li)] = im
                li += 1
            bpy.data.images.remove(img)
    return from_strips


def build_char(c, binary, lod, images, layers, name_x):
    n = c['vertexCount']
    pos = np.frombuffer(binary, np.int16, n * 3, c['position']['offset']).reshape(-1, 3).astype(np.float64)
    mn = np.array(c['position']['min'])
    rg = np.array(c['position']['range'])
    pos = mn + (pos + 32767) / 65534 * rg
    nrm = np.frombuffer(binary, np.int8, n * 4, c['attributes']['normal']).reshape(-1, 4).astype(np.float64) / 127
    uv = np.frombuffer(binary, np.uint16, n * 2, c['attributes']['uv']).reshape(-1, 2).astype(np.float64) / 65535
    tex = np.frombuffer(binary, np.uint8, n * 4, c['attributes']['tex']).reshape(-1, 4)
    it = np.uint16 if c['index']['type'] == 'u16' else np.uint32
    idx = np.frombuffer(binary, it, c['index']['count'], c['index']['offset']).astype(np.int64)
    L = c['lods'][lod]
    tri = idx[L['start']:L['start'] + L['count']].reshape(-1, 3)
    texv = np.frombuffer(binary, np.uint8, n * 4, c['attributes']['tex']).reshape(-1, 4)
    tri = tri[(texv[tri[:, 0], 3] & 2) == 0]
    # three.js (x, y, z) -> Blender (-x, z, y)
    V = np.stack([-pos[:, 0], pos[:, 2], pos[:, 1]], 1)
    me = bpy.data.meshes.new(c['id'])
    me.vertices.add(n)
    me.vertices.foreach_set('co', V.astype(np.float32).ravel())
    me.loops.add(len(tri) * 3)
    me.loops.foreach_set('vertex_index', tri.astype(np.int32).ravel())
    me.polygons.add(len(tri))
    me.polygons.foreach_set('loop_start', np.arange(0, len(tri) * 3, 3, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(tri), 3, np.int32))
    me.update()
    uvl = me.uv_layers.new(name='UV')
    uvl.data.foreach_set('uv', uv[tri.ravel()].astype(np.float32).ravel())
    # per-corner tint * (2 for detail) and AO
    regions = {v: k for k, v in DOC['regions'].items()}
    tints = c['tints']
    col = np.ones((n, 4), np.float32)
    for i in range(n):
        reg = regions.get(int(tex[i, 2]), 'skin')
        t = tints.get(reg, [1, 1, 1])
        f = 2.0 if tex[i, 3] & 4 else 1.0
        col[i, :3] = np.array(t) * f
    ao = np.clip(nrm[:, 3], 0, 1)
    ca = me.color_attributes.new('tint', 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set('color', col.ravel())
    cb = me.color_attributes.new('ao', 'FLOAT_COLOR', 'POINT')
    aoc = np.stack([ao, ao, ao, np.ones_like(ao)], 1).astype(np.float32)
    cb.data.foreach_set('color', aoc.ravel())
    # smooth normals from the stored ones
    me.normals_split_custom_set_from_vertices([tuple((-nrm[i, 0], nrm[i, 2], nrm[i, 1])) for i in range(n)])
    me.shade_smooth() if hasattr(me, 'shade_smooth') else None
    for p in me.polygons:
        p.use_smooth = True
    # materials per (albedo layer, normal layer, alpha)
    keys = {}
    mat_idx = np.zeros(len(tri), np.int32)
    t0 = tex[tri[:, 0]]
    for k, row in enumerate(t0):
        key = (int(row[0]), int(row[1]), bool(row[3] & 1))
        if key not in keys:
            keys[key] = len(keys)
            me.materials.append(material(key, images, layers))
        mat_idx[k] = keys[key]
    me.polygons.foreach_set('material_index', mat_idx)
    ob = bpy.data.objects.new(c['id'], me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


_mats = {}
DEBUG = ''


def material(key, images, layers):
    if key in _mats:
        return _mats[key]
    a, nidx, alpha = key
    m = bpy.data.materials.new(f'L{a}_{nidx}_{int(alpha)}')
    m.use_nodes = True
    nt = m.node_tree
    N = nt.nodes
    for x in list(N):
        N.remove(x)
    out = N.new('ShaderNodeOutputMaterial')
    bsdf = N.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    texn = N.new('ShaderNodeTexImage')
    texn.image = images[('albedo', a)]
    texn.interpolation = 'Cubic'
    tint = N.new('ShaderNodeVertexColor')
    tint.layer_name = 'tint'
    aon = N.new('ShaderNodeVertexColor')
    aon.layer_name = 'ao'
    mul = N.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs[0].default_value = 1.0
    nt.links.new(texn.outputs['Color'], mul.inputs[6])
    nt.links.new(tint.outputs['Color'], mul.inputs[7])
    mul2 = N.new('ShaderNodeMix')
    mul2.data_type = 'RGBA'
    mul2.blend_type = 'MULTIPLY'
    mul2.inputs[0].default_value = 0.85
    nt.links.new(mul.outputs[2], mul2.inputs[6])
    nt.links.new(aon.outputs['Color'], mul2.inputs[7])
    nt.links.new(mul2.outputs[2], bsdf.inputs['Base Color'])
    lay = layers[a]
    bsdf.inputs['Roughness'].default_value = lay['rough']
    if lay['kind'] == 'skin':
        bsdf.inputs['Subsurface Weight'].default_value = 0.25
        bsdf.inputs['Subsurface Radius'].default_value = (0.012, 0.005, 0.003)
        bsdf.inputs['Subsurface Scale'].default_value = 1.0
    if lay['kind'] == 'hair':
        bsdf.inputs['Roughness'].default_value = 0.55
        bsdf.inputs['Specular IOR Level'].default_value = 0.3
    if alpha:
        # alpha-tested coverage (the runtime uses alpha to coverage / a test at 0.5)
        mt = N.new('ShaderNodeMath')
        mt.operation = 'GREATER_THAN'
        mt.inputs[1].default_value = 0.45
        nt.links.new(texn.outputs['Alpha'], mt.inputs[0])
        nt.links.new(mt.outputs[0], bsdf.inputs['Alpha'])
    if DEBUG == 'albedo':
        em = N.new('ShaderNodeEmission')
        nt.links.new(mul2.outputs[2], em.inputs[0])
        nt.links.new(em.outputs[0], out.inputs[0])
    if nidx != 255 and DEBUG != 'nonormal':
        nimg = N.new('ShaderNodeTexImage')
        nimg.image = images[('normal', nidx)]
        nimg.interpolation = 'Cubic'
        nm = N.new('ShaderNodeNormalMap')
        nm.uv_map = 'UV'
        nm.inputs['Strength'].default_value = 1.0
        nt.links.new(nimg.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    _mats[key] = m
    return m


def scene_setup(a):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = a.samples
    sc.cycles.use_denoising = True
    try:
        if not a.cpu:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            prefs.compute_device_type = 'OPTIX'
            prefs.get_devices()
            for d in prefs.devices:
                d.use = d.type != 'CPU'
            sc.cycles.device = 'GPU' if any(d.use for d in prefs.devices) else 'CPU'
    except Exception as e:
        print('GPU setup failed', e)
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast' if 'AgX - Medium High Contrast' in [x.identifier for x in bpy.types.ColorManagedViewSettings.bl_rna.properties['look'].enum_items] else 'None'
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.50, 0.58, 0.72, 1)
    bg.inputs[1].default_value = 0.9
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.0
    sun.color = (1.0, 0.95, 0.88)
    sun.angle = math.radians(1.0)
    so = bpy.data.objects.new('sun', sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(42), 0, math.radians(-150))
    sc.view_settings.exposure = -0.3
    # paving
    bpy.ops.mesh.primitive_plane_add(size=80)
    pl = bpy.context.object
    pm = bpy.data.materials.new('paving')
    pm.use_nodes = True
    pm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.42, 0.40, 0.37, 1)
    pm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
    pl.data.materials.append(pm)
    return sc


def main():
    global DOC, DEBUG
    a = args_()
    DEBUG = a.debug
    os.makedirs(a.out, exist_ok=True)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    DOC = json.load(open(os.path.join(SRC, 'cast.json')))
    binary = gzip.open(os.path.join(SRC, 'cast.bin.gz')).read()
    images = layer_images(DOC, os.path.join(a.out, 'layers'))
    layers = DOC['textures']['layers']
    chars = DOC['characters']
    if a.only:
        want = a.only.split(',')
        chars = [c for c in chars if c['id'] in want]
    order = {'adult': 0, 'old': 1, 'teen': 2, 'child': 3, 'toddler': 4}
    chars = sorted(chars, key=lambda c: (order[c['ageClass']], c['sex'], c['id']))
    sc = scene_setup(a)
    rows = max(1, a.rows)
    per = math.ceil(len(chars) / rows)
    spacing = 0.78
    obs = [build_char(c, binary, a.lod, images, layers, 0) for c in chars]
    cam_d = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam_d.type = 'ORTHO'
    views = {
        'front': ((0, -30, 0.95), (math.radians(90), 0, 0)),
        'back': ((0, 30, 0.95), (math.radians(90), 0, math.radians(180))),
        'side': ((30, 0, 0.95), (math.radians(90), 0, math.radians(90))),
        'threeq': ((-21, -21, 0.95), (math.radians(90), 0, math.radians(-45))),
    }
    tallest = max(c['top'] for c in chars) + 0.08
    for r in range(rows):
        row = list(range(r * per, min(len(obs), (r + 1) * per)))
        for i, ob in enumerate(obs):
            ob.hide_render = i not in row
        for v in a.views.split(','):
            loc, rot = views[v]
            n = len(row)
            for k, i in enumerate(row):
                off = (k - (n - 1) / 2) * spacing
                if v == 'side':
                    obs[i].location = (0, off, 0)
                elif v == 'threeq':
                    obs[i].location = (off * 0.7071, -off * 0.7071, 0)
                else:
                    obs[i].location = (off, 0, 0)
            width = n * spacing + 0.4
            cam_d.ortho_scale = max(width, tallest)
            cam.location = (loc[0], loc[1], tallest / 2 - 0.02)
            cam.rotation_euler = rot
            sc.render.resolution_x = a.res
            sc.render.resolution_y = int(a.res * tallest / cam_d.ortho_scale)
            if a.zoom:
                z0, z1 = [float(x) for x in a.zoom.split(',')]
                cam_d.ortho_scale = max(z1 - z0, width)
                cam.location = (loc[0], loc[1], (z0 + z1) / 2)
                sc.render.resolution_y = int(a.res * (z1 - z0) / cam_d.ortho_scale)
            suffix = f'_row{r}' if rows > 1 else ''
            sc.render.filepath = os.path.join(a.out, f'lineup_{v}_lod{a.lod}{suffix}.png')
            bpy.ops.render.render(write_still=True)
            print('[mh-preview] wrote', sc.render.filepath, flush=True)


if __name__ == '__main__':
    main()
