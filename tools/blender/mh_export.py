"""Export stage of the crowd character generator (run by mh_build.py, plain python3 + numpy + node).

Reads the raw characters (.work/mh/raw) and the texture layer table (.work/mh/tex/layers.json), builds
LODs with meshoptimizer (vendor/three/addons/libs/meshopt_simplifier.module.js, run in node), quantises and
writes assets/humans_mh/cast.json + cast.bin.gz. The format is documented in cast.json['format'].
"""
import os
import sys
import json
import gzip
import struct
import subprocess
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mh_cast as CASTM  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
RAW = os.path.join(ROOT, '.work', 'mh', 'raw')
WORK = os.path.join(ROOT, '.work', 'mh', 'lod')
TEXJ = os.path.join(ROOT, '.work', 'mh', 'tex', 'layers.json')
OUT = os.path.join(ROOT, 'assets', 'humans_mh')
VERSION = 1

# triangle budgets per part kind for LOD 0..3 (hair: one side; it is drawn double-sided by duplication)
BUDGET = {
    'body': (5200, 1500, 420, 130),
    'suit': (3600, 1000, 300, 90),
    'shoes': (700, 200, 60, 20),
    'hair': (1700, 450, 130, 40),
    'hat': (500, 160, 50, 16),
    'eyes': (None, 40, 0, 0),
    'brows': (None, None, 0, 0),
    'lashes': (None, 0, 0, 0),
    'beard': (None, 120, 0, 0),
}
DOUBLE = ('hair', 'lashes', 'beard')
SIZE_SCALE = {'toddler': 0.7, 'child': 0.85}
FLAG_ALPHA, FLAG_BACK, FLAG_DETAIL = 1, 2, 4

NODE_JS = r"""
import { MeshoptSimplifier as S } from '%(lib)s';
import fs from 'fs';
await S.ready;
const dir = process.argv[2];
const jobs = JSON.parse(fs.readFileSync(dir + '/jobs.json', 'utf8'));
const out = {};
for (const j of jobs) {
  const b = fs.readFileSync(dir + '/' + j.file);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const pos = new Float32Array(ab, 0, j.n * 3);
  const att = new Float32Array(ab, j.n * 12, j.n * 3);
  const idx = new Uint32Array(ab, j.n * 24, j.t * 3);
  const res = [];
  for (const t of j.targets) {
    if (t === null) { res.push(null); continue; }
    if (t === 0) { res.push([]); continue; }
    if (t >= j.t) { res.push(null); continue; }
    let [r, err] = S.simplifyWithAttributes(idx, pos, 3, att, 3, [0.35, 0.35, 0.35], null, t * 3, 1.0, ['Prune']);
    if (r.length > t * 3 * 1.25) {
      [r, err] = S.simplifyWithAttributes(idx, pos, 3, att, 3, [0.2, 0.2, 0.2], null, t * 3, 1.0, ['Prune', 'Permissive']);
    }
    if (r.length > t * 3 * 1.5) [r, err] = S.simplifySloppy(idx, pos, 3, null, t * 3, 1.0);
    res.push(Array.from(r));
  }
  out[j.id] = res;
}
fs.writeFileSync(dir + '/result.json', JSON.stringify(out));
"""


def log(*a):
    print('[mh-export]', *a, flush=True)


def srgb_to_lin(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_lin(h):
    h = h.lstrip('#')
    return srgb_to_lin(np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])).round(4).tolist()


def tints_for(spec, gain):
    hair = spec['hair_color']
    hc = CASTM.HC.get(hair, hair)
    hl = np.array(hex_lin(hc))
    t = {
        'skin': list(gain),
        'hair': hl.round(4).tolist(),
        'brows': (hl * 0.75).round(4).tolist(),
        'lashes': hex_lin('#191410'),
        'beard': (hl * 0.95).round(4).tolist(),
        'eyes': [1, 1, 1],
        'shoes': [1, 1, 1],
        'socks': [1, 1, 1],
        'hat': hex_lin(spec.get('hat_color') or '#111113'),
    }
    for reg, g in (('top', spec['top']), ('bottom', spec['bottom'])):
        if g and g['color'] and CASTM.SUITS[g['suit']]['tex'] == 'detail':
            t[reg] = hex_lin(g['color'])
        elif g and CASTM.SUITS[g['suit']]['tex'] == 'detail':
            t[reg] = hex_lin('#808080')
        else:
            t[reg] = [1, 1, 1]
    top = spec['top']
    t['top2'] = hex_lin(top['color2']) if top and top.get('color2') else (t['top'] if top and CASTM.SUITS[top['suit']]['tex'] == 'detail' else [1, 1, 1])
    return t


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    tex = json.load(open(TEXJ))
    remap = tex['remap']
    ids = [c for c in CASTM.CAST if os.path.exists(os.path.join(RAW, c + '.json'))]
    chars = {}
    jobs = []
    for cid in ids:
        meta = json.load(open(os.path.join(RAW, cid + '.json')))
        z = np.load(os.path.join(RAW, cid + '.npz'))
        sc = SIZE_SCALE.get(meta['ageClass'], 1.0)
        parts = []
        suit_tris = sum(p['tris'] for p in meta['parts'] if p['kind'] == 'suit')
        for p in meta['parts']:
            k = p['key']
            d = {a: z[k + '_' + a] for a in ('co', 'nr', 'uv', 'w', 'idx', 'reg', 'ao')}
            d.update(p)
            bud = BUDGET[p['kind']]
            if p['kind'] == 'suit':
                f = p['tris'] / max(1, suit_tris)
                bud = tuple(None if b is None else int(b * f) for b in bud)
            d['targets'] = [None if b is None else (0 if b == 0 else max(8, int(b * sc))) for b in bud]
            parts.append(d)
            jid = f'{cid}_{k}'
            fn = jid + '.bin'
            with open(os.path.join(WORK, fn), 'wb') as f:
                f.write(d['co'].astype(np.float32).tobytes())
                f.write(d['nr'].astype(np.float32).tobytes())
                f.write(d['idx'].astype(np.uint32).tobytes())
            jobs.append(dict(id=jid, file=fn, n=int(len(d['co'])), t=int(len(d['idx'])), targets=d['targets']))
        chars[cid] = (meta, parts)
    with open(os.path.join(WORK, 'jobs.json'), 'w') as f:
        json.dump(jobs, f)
    js = os.path.join(WORK, 'simplify.mjs')
    with open(js, 'w') as f:
        f.write(NODE_JS % {'lib': os.path.join(ROOT, 'vendor/three/addons/libs/meshopt_simplifier.module.js')})
    subprocess.check_call(['node', js, WORK])
    res = json.load(open(os.path.join(WORK, 'result.json')))
    log('simplified', len(jobs), 'parts')

    bin_chunks = []
    offset = 0

    def put(arr):
        nonlocal offset
        b = arr.tobytes()
        pad = (-len(b)) % 4
        o = offset
        bin_chunks.append(b + b'\0' * pad)
        offset += len(b) + pad
        return o

    out_chars = []
    for cid in ids:
        meta, parts = chars[cid]
        spec = meta['spec']
        # ---------------------------------------------------------------- merge parts, LOD index lists
        P, N, UV, W, AO, TEXA = [], [], [], [], [], []
        lods = [[], [], [], []]
        nv = 0
        for d in parts:
            rm = remap[d['tex']]
            u0, v0, su, sv = rm['rect']
            uv = d['uv'].astype(np.float64).copy()
            uv[:, 0] = u0 + np.clip(uv[:, 0], 0, 1) * su
            uv[:, 1] = v0 + np.clip(uv[:, 1], 0, 1) * sv
            flags = (FLAG_ALPHA if rm.get('alpha') else 0) | (FLAG_DETAIL if rm['type'] == 'detail' else 0)
            n = len(d['co'])
            reg = d['reg'].astype(np.int64)
            ta = np.stack([np.full(n, rm['layer']), np.full(n, 255 if rm['normal'] < 0 else rm['normal']), reg,
                           np.full(n, flags)], 1)
            r = res[f'{cid}_{d["key"]}']
            lodidx = []
            for li in range(4):
                if r[li] is None:
                    ix = d['idx'].reshape(-1)
                else:
                    ix = np.array(r[li], np.int64)
                lodidx.append(ix)
            P.append(d['co']); N.append(d['nr']); UV.append(uv); W.append(d['w']); AO.append(d['ao']); TEXA.append(ta)
            for li in range(4):
                lods[li].append(lodidx[li] + nv)
            nv += n
            if d['kind'] in DOUBLE:
                # back faces: duplicated vertices with flipped normals, reversed winding
                P.append(d['co']); N.append(-d['nr']); UV.append(uv); W.append(d['w']); AO.append(d['ao'])
                tb = ta.copy()
                tb[:, 3] |= FLAG_BACK
                TEXA.append(tb)
                for li in range(4):
                    ix = lodidx[li].reshape(-1, 3)[:, ::-1].reshape(-1)
                    lods[li].append(ix + nv)
                nv += n
        P = np.concatenate(P); N = np.concatenate(N); UV = np.concatenate(UV); W = np.concatenate(W)
        AO = np.concatenate(AO); TEXA = np.concatenate(TEXA)
        lods = [np.concatenate(l) if l else np.zeros(0, np.int64) for l in lods]
        # vertex order: vertices of the coarsest LOD first (far LODs touch a compact prefix); drop unused
        rank2 = np.full(len(P), -1)
        for li in range(4):
            rank2[np.unique(lods[li])] = li          # the coarsest LOD using the vertex
        keep = rank2 >= 0
        order = np.lexsort((np.arange(len(P)), -rank2))
        order = order[keep[order]]
        newi = np.full(len(P), -1)
        newi[order] = np.arange(len(order))
        P, N, UV, W, AO, TEXA = P[order], N[order], UV[order], W[order], AO[order], TEXA[order]
        lods = [newi[l] for l in lods]
        vcount_lod = [int(l.max() + 1) if len(l) else 0 for l in lods]
        nvert = len(P)
        # ---------------------------------------------------------------- quantise
        pmin = P.min(0) - 1e-4
        prng = P.max(0) + 1e-4 - pmin
        q = np.round((P - pmin) / prng * 65534 - 32767).astype(np.int16)
        Nn = N / np.maximum(1e-9, np.linalg.norm(N, axis=1, keepdims=True))
        nq = np.concatenate([np.round(Nn * 127), np.round(np.clip(AO, 0, 1) * 127)[:, None]], 1).astype(np.int8)
        uq = np.round(np.clip(UV, 0, 1) * 65535).astype(np.uint16)
        top = np.argsort(-W, axis=1)[:, :4]
        tw = np.take_along_axis(W, top, 1)
        tw = tw / np.maximum(1e-9, tw.sum(1, keepdims=True))
        wq = np.floor(tw * 255).astype(np.int64)
        rem = 255 - wq.sum(1)
        frac = tw * 255 - wq
        for i in np.where(rem > 0)[0]:
            for j in np.argsort(-frac[i])[:rem[i]]:
                wq[i, j] += 1
        bi = np.where(wq > 0, top, 0).astype(np.uint8)
        wq = wq.astype(np.uint8)
        ta = TEXA.astype(np.uint8)
        itype = np.uint16 if nvert < 65536 else np.uint32
        idx_all = np.concatenate(lods).astype(itype)
        offs = dict(position=put(q), normal=put(nq), uv=put(uq), skinIndex=put(bi), skinWeight=put(wq), tex=put(ta))
        ioff = put(idx_all)
        lod_meta = []
        s = 0
        for li in range(4):
            lod_meta.append(dict(start=s, count=int(len(lods[li])), tris=int(len(lods[li]) // 3), vertices=vcount_lod[li]))
            s += len(lods[li])
        # ---------------------------------------------------------------- landmarks / runtime rig info
        info = landmarks(meta, P, W, TEXA)
        out_chars.append(dict(
            id=cid, note=spec.get('note', ''), sex=spec['sex'], age=spec['age'], ageClass=meta['ageClass'], kind=meta['kind'],
            senior=meta['ageClass'] == 'old', height=round(meta['H'], 4), top=round(float(P[:, 1].max()), 4),
            skeleton=dict(parent=meta['parent'], joints=[[round(v, 5) for v in meta['joints'][b]] for b in meta['bones']]),
            info=info,
            tints=tints_for(spec, tex['tones'][cid]),
            outfit=dict(top=garment_desc(spec['top']), bottom=garment_desc(spec['bottom']), shoes=spec['shoes'],
                        hair=spec['hair'], hat=spec['hat'], beard=spec.get('beard')),
            regions=sorted(set(int(r) for r in TEXA[:, 2])),
            vertexCount=nvert,
            position=dict(offset=offs['position'], min=[round(float(x), 6) for x in pmin], range=[round(float(x), 6) for x in prng]),
            attributes={k: offs[k] for k in ('normal', 'uv', 'skinIndex', 'skinWeight', 'tex')},
            index=dict(offset=ioff, type='u16' if itype == np.uint16 else 'u32', count=int(len(idx_all))),
            lods=lod_meta,
        ))
        log(cid, f'{nvert} verts, LOD tris', [l['tris'] for l in lod_meta], f'H={meta["H"]:.3f}')

    binary = b''.join(bin_chunks)
    with open(os.path.join(OUT, 'cast.bin.gz'), 'wb') as f:
        with gzip.GzipFile(filename='', mode='wb', fileobj=f, mtime=0, compresslevel=9) as g:
            g.write(binary)
    layer_table = dict(size=tex['size'], perStrip=tex['strip'], albedo=tex['files']['albedo'], normal=tex['files']['normal'],
                       nAlbedo=tex['nAlbedo'], nNormal=tex['nNormal'],
                       layers=[dict(index=l['index'], key=l['key'], kind=l['kind'], type=l['type'], rough=l['rough'],
                                    normal=l['normal'], alpha=bool(l.get('alpha'))) for l in tex['layers']])
    doc = dict(
        version=VERSION,
        format=FORMAT_DOC,
        license='Human figures: generated with MPFB2 from MakeHuman system assets, CC0 1.0',
        bones=CASTM_BONES(),
        regions=CASTM.REGIONS,
        flags=dict(alpha=FLAG_ALPHA, backface=FLAG_BACK, detail=FLAG_DETAIL),
        textures=layer_table,
        byteLength=len(binary),
        characters=out_chars,
    )
    with open(os.path.join(OUT, 'cast.json'), 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    gz = os.path.getsize(os.path.join(OUT, 'cast.bin.gz'))
    log(f'wrote cast.json + cast.bin.gz ({len(binary) // 1024} KB raw, {gz // 1024} KB gz), {len(out_chars)} characters')


def CASTM_BONES():
    sys.path.insert(0, HERE)
    from mh_build import RT_BONES
    return RT_BONES


def garment_desc(g):
    if not g:
        return None
    return dict(suit=g['suit'], part=g['part'], cut=g.get('cut'), length=g.get('length'))


def landmarks(meta, P, W, TEXA):
    """Fields the runtime rig (anim.js Rig) and poser read from info: H, kind, heelZ, toeZ, hang (crossed-arm
    torso rings [y, halfWidth, zFront, zBack]) and a few more landmarks."""
    J = {b: np.array(meta['joints'][b]) for b in meta['bones']}
    reg = TEXA[:, 2]
    H = meta['H']
    k = H / 1.76
    feet = np.isin(reg, [CASTM.REGIONS['shoes'], CASTM.REGIONS['skin']]) & (P[:, 1] < 0.05 * max(k, 0.5))
    fp = P[feet]
    heelZ = float(np.percentile(fp[:, 2], 99.5)) if len(fp) else 0.08 * k
    toeZ = float(np.percentile(fp[:, 2], 0.5)) if len(fp) else -0.19 * k
    # torso (no arms): weights mostly on the trunk bones
    trunk = W[:, [1, 2, 3, 4, 6, 10]].sum(1) > 0.7
    torso = trunk & ~np.isin(reg, [CASTM.REGIONS['hair'], CASTM.REGIONS['beard']])
    T = P[torso]
    shY = 0.5 * (J['armL'][1] + J['armR'][1])
    hipY = 0.5 * (J['thighL'][1] + J['thighR'][1])
    waistY = J['spine1'][1]
    hang = []
    for y in (shY - 0.125 * k, waistY, hipY, hipY - 0.085 * k):
        s = T[np.abs(T[:, 1] - y) < 0.015 * max(k, 0.5)]
        s = s[np.abs(s[:, 0]) < 0.2 * k] if len(s) else s
        if len(s) < 4:
            hang.append([round(float(y), 4), 0.16 * k, -0.12 * k, 0.1 * k])
            continue
        hang.append([round(float(y), 4), round(float(np.abs(s[:, 0]).max()), 4), round(float(s[:, 2].min()), 4),
                     round(float(s[:, 2].max()), 4)])
    head = P[(W[:, 5] > 0.5) & (reg == CASTM.REGIONS['skin'])]
    eyes = P[reg == CASTM.REGIONS['eyes']]
    info = dict(H=round(H, 4), kind=meta['kind'], heelZ=round(heelZ, 4), toeZ=round(toeZ, 4), hang=hang,
                hip=[round(float(x), 4) for x in J['thighR']], knee=[round(float(x), 4) for x in J['shinR']],
                ankle=[round(float(x), 4) for x in J['footR']], shoulder=[round(float(x), 4) for x in J['armR']],
                waistY=round(float(waistY), 4), neckY=round(float(J['neck'][1]), 4),
                headC=[round(float(x), 4) for x in (head.mean(0) if len(head) else J['head'])],
                eyeL=[round(float(x), 4) for x in (eyes[eyes[:, 0] < 0].mean(0) if len(eyes) else J['head'])],
                eyeR=[round(float(x), 4) for x in (eyes[eyes[:, 0] > 0].mean(0) if len(eyes) else J['head'])],
                top=round(float(P[:, 1].max()), 4))
    return info


FORMAT_DOC = """\
cast.json + cast.bin.gz (gzip of one little-endian binary; byteLength = unzipped size).
characters[i]: one dressed character in the rest pose of the runtime skeleton (src/crowd/humans/anim.js):
  model space metres, +Y up, facing -Z, the figure's left at -X; soles at y = 0. All bone rest
  orientations are identity (skin matrix = [R | p - R * restJoint]); skeleton.joints[b] = rest joint b,
  skeleton.parent = bone parents (bones[] names). info = fields the runtime Rig reads (H, kind, heelZ, toeZ, hang) + landmarks.
  Geometry: one vertex set shared by the 4 LODs; lods[l] = {start, count} into the index list (draw range,
  in indices), lods[l].vertices = vertex prefix length used by that LOD (coarser LODs use a prefix).
  Attributes (byte offsets into the binary, vertexCount entries each):
    position  int16 x3 (6 bytes / vertex): p = min + (q + 32767) / 65534 * range
    normal    int8 x4 normalised: xyz = normal, w = baked ambient occlusion (0..1)
    uv        uint16 x2 normalised (0..1), v = 0 at the bottom row of the layer image
    skinIndex uint8 x4 (runtime bones), skinWeight uint8 x4 normalised (sum = 255)
    tex       uint8 x4 = (albedo layer, normal layer or 255 = none, region id, flags)
  index: u16 or u32, count indices (all LODs concatenated; triangle lists, CCW front faces).
flags: 1 alpha-tested coverage (hair, brows, lashes, beard), 2 duplicated back face of a double-sided card,
  4 detail texture: albedo_linear = 2 * texel_linear * tint_linear (else albedo = texel * tint).
tints[region] = default linear RGB tint per region (regions{} ids); skin = tone gain on the skin layer.
textures: albedo array = WebP strips (perStrip layers of size x size stacked vertically, top to bottom = layer
  order, RGBA sRGB; strips without alpha are RGB); normal array the same (RGB tangent space, OpenGL / +Y).
  layers[i] = {kind, type ('color' | 'detail' | 'mixed'), rough, normal (normal layer index or -1), alpha}.
"""


if __name__ == '__main__':
    main()
