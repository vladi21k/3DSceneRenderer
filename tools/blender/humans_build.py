"""Builds the crowd figure meshes: assets/humans/humans.json + humans.bin

  tools/dk blender -b --factory-startup -P tools/blender/humans_build.py -- [--bases male,female,child] [--res 0.0035]

Per base body (adult male, adult female, child):
  1. signed distance anatomy (humans_body.py) -> surface nets mesh -> Newton projection
  2. Blender collapse decimation into 3 LODs (face and hands keep more detail)
  3. per vertex: SDF-gradient normal, SDF ambient occlusion, skin weights from primitive
     influences (smoothed over the mesh), body region, and a "heavy build" morph delta
  4. accessory parts (hair styles, beards, hats, bags, skirt) meshed the same way, tagged by part id
All bases share one bone layout (humans_body.BONES); rest pose joints are exported.
"""
import os
import sys
import json
import time
import argparse
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import humans_sdf as S          # noqa: E402
import humans_body as B         # noqa: E402
import humans_parts as PARTS    # noqa: E402

try:
    import bpy                  # noqa: E402
except ImportError:             # allows dry runs of the SDF stages outside Blender
    bpy = None

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'assets', 'humans')

LOD_TRIS = {'body': (15000, 3200, 760)}
MORPH_SCALE = 0.08


def log(*a):
    print('[humans]', *a, flush=True)


# ----------------------------------------------------------------------------- meshing

def mesh_sdf(node, lo, hi, h):
    t = time.time()
    F, org = S.eval_grid(node, lo, hi, h)
    V, T = S.surface_nets(F, org, h)
    V = S.project(node, V.astype(np.float32), 2)
    T, _ = S.fix_winding(node, V.astype(np.float64), T)
    log(f'  sdf mesh {len(V)} verts {len(T)} tris in {time.time() - t:.1f}s')
    return V.astype(np.float64), T


def blender_decimate(V, T, targets, detail=None, symmetric=True):
    """Collapse-decimate (V, T) to each triangle target. Returns [(V, T)]."""
    out = []
    for target in targets:
        if target >= len(T):
            out.append((V.copy(), T.copy()))
            continue
        me = bpy.data.meshes.new('m')
        me.vertices.add(len(V))
        me.vertices.foreach_set('co', V.astype(np.float32).ravel())
        me.loops.add(len(T) * 3)
        me.loops.foreach_set('vertex_index', T.astype(np.int32).ravel())
        me.polygons.add(len(T))
        me.polygons.foreach_set('loop_start', np.arange(0, len(T) * 3, 3, dtype=np.int32))
        me.polygons.foreach_set('loop_total', np.full(len(T), 3, np.int32))
        me.update()
        me.validate()
        ob = bpy.data.objects.new('o', me)
        bpy.context.scene.collection.objects.link(ob)
        mod = ob.modifiers.new('dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = target / len(T)
        mod.use_collapse_triangulate = True
        if symmetric:
            mod.use_symmetry = True
            mod.symmetry_axis = 'X'
        if detail is not None:
            # the decimator collapses weighted vertices: weight 1 = free, lower = preserved
            vg = ob.vertex_groups.new(name='detail')
            wq = np.round(1.0 - 0.5 * np.clip(detail, 0, 1), 2)
            for w in np.unique(wq):
                idx = np.nonzero(wq == w)[0].tolist()
                vg.add(idx, float(w), 'REPLACE')
            mod.vertex_group = 'detail'
            mod.vertex_group_factor = 1.0
        dg = bpy.context.evaluated_depsgraph_get()
        ev = ob.evaluated_get(dg)
        m2 = ev.to_mesh()
        m2.calc_loop_triangles()
        nv = len(m2.vertices)
        Vo = np.empty(nv * 3, np.float32)
        m2.vertices.foreach_get('co', Vo)
        tri = np.empty(len(m2.loop_triangles) * 3, np.int32)
        m2.loop_triangles.foreach_get('vertices', tri)
        out.append((Vo.reshape(-1, 3).astype(np.float64), tri.reshape(-1, 3)))
        ev.to_mesh_clear()
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
    return out


def adjacency(T, nv):
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    E = np.concatenate([E, E[:, ::-1]])
    E = np.unique(E, axis=0)
    deg = np.bincount(E[:, 0], minlength=nv).astype(np.float64)
    return E, np.maximum(deg, 1)


def smooth_field(X, E, deg, iters=3, f=0.5):
    X = X.astype(np.float64).copy()
    for _ in range(iters):
        acc = np.zeros_like(X)
        np.add.at(acc, E[:, 0], X[E[:, 1]])
        X = X * (1 - f) + f * acc / deg[:, None]
    return X


# ----------------------------------------------------------------------------- attributes

def bone_side(name):
    return -1 if name.endswith('L') else (1 if name.endswith('R') else 0)


def skin_weights(node, P, T, sigma, bones=B.BONES):
    leaves = node.leaves()
    P32 = P.astype(np.float32)
    D = np.stack([l.eval(P32) for l in leaves], axis=1).astype(np.float64)
    dmin = D.min(1, keepdims=True)
    infl = np.exp(-np.clip(D - dmin, 0, None) / sigma)
    infl[D - dmin > 6 * sigma] = 0
    W = np.zeros((len(P), len(bones)))
    x = P[:, 0]
    for j, l in enumerate(leaves):
        if not infl[:, j].any():
            continue
        bw = l.bone_weights(P32)
        sides = {bone_side(b) for b in bw}
        f = infl[:, j]
        if sides == {-1}:
            f = f * np.clip(0.5 - x / 0.012, 0, 1)
        elif sides == {1}:
            f = f * np.clip(0.5 + x / 0.012, 0, 1)
        for b, w in bw.items():
            W[:, bones.index(b)] += f * w
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    region = np.array([leaves[i].region or 0 for i in np.argmin(D, 1)], np.uint8)
    return W, region


def quantize_weights(W, E, deg, smooth_iters=2):
    if smooth_iters:
        W = smooth_field(W, E, deg, smooth_iters, 0.5)
    idx = np.argsort(-W, axis=1)[:, :4]
    w = np.take_along_axis(W, idx, 1)
    w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
    q = np.floor(w * 255 + 0.5).astype(np.int32)
    q[:, 0] += 255 - q.sum(1)
    idx[q == 0] = 0
    return idx.astype(np.uint8), np.clip(q, 0, 255).astype(np.uint8)


def morph_to(node_heavy, P, N, lo=-0.02, hi=0.10):
    t = np.zeros(len(P))
    for _ in range(8):
        d = node_heavy.eval((P + N * t[:, None]).astype(np.float32)).astype(np.float64)
        t = np.clip(t - d, lo, hi)
    return N * t[:, None]


def vertex_attributes(node, heavy, P, T, sigma, detail_regions=None):
    P = S.project(node, P.astype(np.float32), 2).astype(np.float64)
    N = S.normals(node, P.astype(np.float32))
    ao = S.sdf_ao(node, P, N)
    E, deg = adjacency(T, len(P))
    W, region = skin_weights(node, P, T, sigma)
    si, sw = quantize_weights(W, E, deg)
    M = morph_to(heavy, P, N) if heavy is not None else np.zeros_like(P)
    if heavy is not None:
        M = smooth_field(M, E, deg, 2, 0.5)
    return dict(P=P, N=N, ao=ao, si=si, sw=sw, region=region, M=M)


def part_attributes(node, body, P, T):
    """Attributes of an accessory part: its own SDF for shape and weights, body + part for AO."""
    P = S.project(node, P.astype(np.float32), 2).astype(np.float64)
    N = S.normals(node, P.astype(np.float32))
    ao = S.sdf_ao(S.Union([body, node]), P, N)
    E, deg = adjacency(T, len(P))
    W, region = skin_weights(node, P, T, 0.01)
    si, sw = quantize_weights(W, E, deg, 1)
    return dict(P=P, N=N, ao=ao, si=si, sw=sw, region=region, M=np.zeros_like(P))


# ----------------------------------------------------------------------------- packing

class Packer:
    def __init__(self):
        self.buf = bytearray()

    def add(self, arr):
        while len(self.buf) % 4:
            self.buf.append(0)
        off = len(self.buf)
        self.buf += np.ascontiguousarray(arr).tobytes()
        return off


def pack_lod(pk, attrs, T, part_ids):
    n = len(attrs['P'])
    nrm = np.zeros((n, 4), np.int8)
    nrm[:, :3] = np.clip(np.round(attrs['N'] * 127), -127, 127)
    nrm[:, 3] = np.clip(np.round(attrs['ao'] * 127), 0, 127)
    mor = np.zeros((n, 4), np.int8)
    mor[:, :3] = np.clip(np.round(attrs['M'] / MORPH_SCALE * 127), -127, 127)
    body = np.zeros((n, 4), np.uint8)
    body[:, 0] = attrs['region']
    body[:, 1] = part_ids
    body[:, 2] = np.clip(np.round(attrs.get('aux', np.zeros((n, 2)))[:, 0] * 255), 0, 255)
    body[:, 3] = np.clip(np.round(attrs.get('aux', np.zeros((n, 2)))[:, 1] * 255), 0, 255)
    itype = 'u16' if n < 65536 else 'u32'
    idx = T.astype(np.uint16 if itype == 'u16' else np.uint32).ravel()
    return {
        'count': n,
        'index': {'offset': pk.add(idx), 'count': int(len(idx)), 'type': itype},
        'attributes': {
            'position': {'offset': pk.add(attrs['P'].astype(np.float32)), 'type': 'f32', 'size': 3},
            'normal': {'offset': pk.add(nrm), 'type': 'i8', 'size': 4, 'normalized': True},
            'skinIndex': {'offset': pk.add(attrs['si']), 'type': 'u8', 'size': 4},
            'skinWeight': {'offset': pk.add(attrs['sw']), 'type': 'u8', 'size': 4, 'normalized': True},
            'morph': {'offset': pk.add(mor), 'type': 'i8', 'size': 4, 'normalized': True},
            'body': {'offset': pk.add(body), 'type': 'u8', 'size': 4},
        },
    }


def concat_attrs(items):
    out = {}
    for k in items[0][0]:
        out[k] = np.concatenate([it[0][k] for it in items])
    tris, off = [], 0
    for it in items:
        tris.append(it[1] + off)
        off += len(it[0]['P'])
    return out, np.concatenate(tris)


# ----------------------------------------------------------------------------- main

def build_base(kind, res, pk):
    log(f'base {kind}')
    node, skel, info = B.build_body(kind, 0.0)
    heavy, _, _ = B.build_body(kind, 1.0 if kind != 'child' else 0.7)
    H = info['H']
    sc = H / 1.76
    lo = np.array([-0.62 * sc, -0.004, -0.27 * sc])
    hi = np.array([0.62 * sc, H + 0.01, 0.21 * sc])
    V, T = mesh_sdf(node, lo, hi, res * (0.85 if kind == 'child' else 1.0))
    # decimation detail weights: face, ears and hands are protected
    _, reg = skin_weights(node, V[:: 1], T, 0.01)
    detail = np.zeros(len(V))
    for r, w in ((B.REGION['nose'], 1.0), (B.REGION['lips'], 1.0), (B.REGION['eye'], 1.0), (B.REGION['ear'], 0.7),
                 (B.REGION['head'], 0.55), (B.REGION['hand'], 0.5), (B.REGION['foot'], 0.15)):
        detail[reg == r] = w
    hy = info['headC'][1]
    face = (V[:, 2] < -0.03 * sc) & (np.abs(V[:, 1] - hy + 0.03 * sc) < 0.085 * sc)
    detail[face] = np.maximum(detail[face], 0.9)
    lods_mesh = blender_decimate(V, T, LOD_TRIS['body'], detail)
    parts = PARTS.build_parts(kind, node, info, res, mesh_fn=mesh_sdf,
                              decimate_fn=lambda V_, T_, tg: blender_decimate(V_, T_, tg, None, symmetric=False),
                              attr_fn=part_attributes)
    sigma = 0.010 * sc
    lods = []
    for li, (Vl, Tl) in enumerate(lods_mesh):
        t = time.time()
        a = vertex_attributes(node, heavy, Vl, Tl, sigma)
        items = [(a, Tl)]
        pids = [np.zeros(len(Vl), np.uint8)]
        for p in parts:
            pa, pt = p['lods'][li]
            items.append((pa, pt))
            pids.append(np.full(len(pa['P']), p['id'], np.uint8))
        for it in items:
            it[0].setdefault('aux', np.zeros((len(it[0]['P']), 2)))
        attrs, tris = concat_attrs(items)
        lods.append(pack_lod(pk, attrs, tris, np.concatenate(pids)))
        log(f'  lod{li}: {len(attrs["P"])} verts {len(tris)} tris (body {len(Tl)}) {time.time() - t:.1f}s')
    return {'info': info, 'skeleton': skel, 'lods': lods,
            'parts': [{k: p[k] for k in ('id', 'name', 'kind')} for p in parts]}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--bases', default='male,female,child')
    ap.add_argument('--res', type=float, default=0.0035)
    a = ap.parse_args(argv)
    os.makedirs(OUT, exist_ok=True)
    pk = Packer()
    meta = {'version': 1, 'bones': B.BONES, 'regions': B.REGION, 'parts': PARTS.PART_IDS,
            'morphScale': MORPH_SCALE, 'bases': {}}
    t0 = time.time()
    for kind in a.bases.split(','):
        meta['bases'][kind] = build_base(kind, a.res, pk)
    with open(os.path.join(OUT, 'humans.bin'), 'wb') as f:
        f.write(pk.buf)
    meta['byteLength'] = len(pk.buf)
    with open(os.path.join(OUT, 'humans.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'))
    log(f'wrote {len(pk.buf) / 1e6:.2f} MB in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
