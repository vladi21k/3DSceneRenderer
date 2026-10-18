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
_WORK, OUT = CASTM.stage_dirs()
RAW = os.path.join(_WORK, 'raw')
WORK = os.path.join(_WORK, 'lod')
TEXJ = os.path.join(_WORK, 'tex', 'layers.json')
VERSION = 2

# triangle budgets per part kind for LOD 0..3 (hair: one side; it is drawn double-sided by duplication)
BUDGET = {
    'body': (8500, 1700, 560, 210),
    'suit': (3600, 1100, 360, 130),
    'shoes': (700, 200, 60, 20),
    'hair': (2400, 900, 420, 0),
    'haircap': (0, 0, 0, 60),
    'hat': (500, 200, 110, 50),
    'eyes': (None, 40, 20, 12),
    'brows': (None, None, 0, 0),
    'lashes': (None, 0, 0, 0),
    'beard': (None, 160, 60, 0),
}
# simplifier options per part kind: lock the open borders (hems, cuffs, the hair's strand tips), keep
# small pieces (cards)
LOCK_BORDER = ('suit', 'shoes', 'hat', 'hair', 'beard')
# inner faces of garments near their openings (hems, cuffs, necklines), seen from below or through a
# sleeve: drawn in the garment's colour, darkened (flag 2 on a garment region), for LOD 0-1
HEM_RANGE = 0.045
HEM_LODS = (0, 1)
# far LODs: skin within GD_RANGE of a garment is pulled in under it by up to SHRINK[l] (m)
SHRINK = (0.0, 0.0, 0.004, 0.010)
GD_RANGE = 0.035
DOUBLE = ('hair', 'lashes', 'beard')
SIZE_SCALE = {'toddler': 0.7, 'child': 0.85}
FLAG_ALPHA, FLAG_BACK, FLAG_DETAIL, FLAG_SKIRT = 1, 2, 4, 8
ATTR_W = [0.35, 0.35, 0.35, 0.3, 0.3]     # simplifier weights: normal xyz, uv

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
  const att = new Float32Array(ab, j.n * 12, j.n * 5);
  const idx = new Uint32Array(ab, j.n * 32, j.t * 3);
  const res = [];
  // (no Permissive: collapses must not cross UV seams or region borders, which smears other
  // texels and garment colours over the surface)
  const fl = (j.cards ? [] : ['Prune']).concat(j.lockBorder ? ['LockBorder'] : []).concat(j.cards ? [] : ['Regularize']);
  let prev = idx;
  for (const t of j.targets) {
    if (t === null) { res.push(null); continue; }
    if (t === 0) { res.push([]); continue; }
    if (t >= j.t) { res.push(null); continue; }
    if (t * 3 >= prev.length) { res.push(Array.from(prev)); continue; }
    // each LOD simplifies the previous one (nested, so a LOD switch changes as little as possible)
    let [r] = S.simplifyWithAttributes(prev, pos, 3, att, 5, %(w)s, null, t * 3, 1.0, fl);
    if (r.length > t * 3 * 1.6 && j.lockBorder) {
      // borders too long to keep at this budget: let them simplify too (still no seam crossing)
      [r] = S.simplifyWithAttributes(prev, pos, 3, att, 5, %(w)s, null, t * 3, 1.0, fl.filter((f) => f !== 'LockBorder'));
    }
    res.push(Array.from(r));
    prev = r;
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
            for extra in ('gd', 'dec'):
                if k + '_' + extra in z:
                    d[extra] = z[k + '_' + extra]
            if p['kind'] == 'body':
                # enclosed skin never seen (inside of the mouth, eye sockets behind the eyes): AO ~ 0 near the eyes
                eyes = [q for q in meta['parts'] if q['kind'] == 'eyes']
                if eyes:
                    E = z[eyes[0]['key'] + '_co'].mean(0)
                    kk = meta['H'] / 1.75
                    tc = d['co'][d['idx']].mean(1)
                    near = (np.linalg.norm(tc - E, axis=1) < 0.06 * kk) & (tc[:, 1] > E[1] - 0.025 * kk)
                    tri_ao = d['ao'][d['idx']].max(1)
                    d['idx'] = d['idx'][~(near & (tri_ao < 0.04))]
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
                f.write(np.concatenate([d['nr'], d['uv']], 1).astype(np.float32).tobytes())
                f.write(d['idx'].astype(np.uint32).tobytes())
            jobs.append(dict(id=jid, file=fn, n=int(len(d['co'])), t=int(len(d['idx'])), targets=d['targets'],
                             cards=p['kind'] in ('hair', 'beard', 'lashes', 'brows'), lockBorder=p['kind'] in LOCK_BORDER))
        chars[cid] = (meta, parts)
    with open(os.path.join(WORK, 'jobs.json'), 'w') as f:
        json.dump(jobs, f)
    js = os.path.join(WORK, 'simplify.mjs')
    with open(js, 'w') as f:
        f.write(NODE_JS % {'lib': os.path.join(ROOT, 'vendor/three/addons/libs/meshopt_simplifier.module.js'), 'w': json.dumps(ATTR_W)})
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
        body_part = next((q for q in parts if q['kind'] == 'body'), None)
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
            fl = np.full(n, flags)
            if d['kind'] == 'suit' and d.get('suit') == 'female_elegantsuit01':
                fl = np.where(reg == CASTM.REGIONS['bottom'], fl | FLAG_SKIRT, fl)
            ta = np.stack([np.full(n, rm['layer']), np.full(n, 255 if rm['normal'] < 0 else rm['normal']), reg, fl], 1)
            if d['kind'] == 'body' and 'dec' in d:
                # skin: no normal layer; the channel carries the skin decals instead (128 none, above: beard
                # growth, below: hair-covered scalp)
                ta[:, 1] = d['dec']
            if d['kind'] == 'hair' and 'dec' in d:
                # hair: no normal layer; the channel carries the strand fade at cut ends (254 none)
                ta[:, 1] = d['dec']
            r = res[f'{cid}_{d["key"]}']
            lodidx = []
            for li in range(4):
                if r[li] is None:
                    ix = d['idx'].reshape(-1)
                else:
                    ix = np.array(r[li], np.int64)
                lodidx.append(ix)
            P.append(d['co']); N.append(d['nr']); UV.append(uv); W.append(d['w']); AO.append(d['ao']); TEXA.append(ta)
            base_nv = nv
            nv += n
            for li in range(4):
                if d['kind'] == 'body' and SHRINK[li] > 0 and 'gd' in d and len(lodidx[li]):
                    # a copy of the skin for this far LOD, pulled in under nearby garment edges
                    f = np.clip((GD_RANGE - d['gd']) / GD_RANGE, 0, 1)[:, None]
                    P.append(d['co'] - d['nr'] * SHRINK[li] * f); N.append(d['nr']); UV.append(uv); W.append(d['w'])
                    AO.append(d['ao']); TEXA.append(ta)
                    lods[li].append(lodidx[li] + nv)
                    nv += n
                else:
                    lods[li].append(lodidx[li] + base_nv)
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
            if d['kind'] == 'suit':
                # the inside of the garment near its openings, and faces turned towards the body (pocket
                # mouths, folds): seen from outside they would be see-through
                near = hem_distance(d['co'], d['idx']) < HEM_RANGE * max(0.6, meta['H'] / 1.75)
                near |= inward_vertices(d, body_part)
                if near.any():
                    P.append(d['co'] - d['nr'] * 0.0006); N.append(-d['nr']); UV.append(uv); W.append(d['w']); AO.append(d['ao'] * 0.7)
                    tb = ta.copy()
                    tb[:, 3] |= FLAG_BACK
                    TEXA.append(tb)
                    for li in HEM_LODS:
                        t3 = lodidx[li].reshape(-1, 3)
                        sel = near[t3].all(1)
                        if sel.any():
                            lods[li].append(t3[sel][:, ::-1].reshape(-1) + nv)
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
            anc=[round(float(x), 3) for x in spec['anc']], tone=spec.get('tone', 'base'),
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
        # decal: skin tex.y = skin decals (128 none, > 128 beard growth, < 128 hair-covered scalp); hair
        # tex.y = strand fade (254 none .. 0 cut strand ends);
        # innerHem: flag 2 on a garment region = inner face near an opening; beardShell: beards with volume only
        features=['decal', 'innerHem', 'beardShell'],
        format=FORMAT_DOC,
        license='Human figures: generated with MPFB2 from MakeHuman system assets, CC0 1.0',
        bones=CASTM_BONES(),
        regions=CASTM.REGIONS,
        # roughness by region where it should override the layer's (hair, brows, lashes, beard: matte fibres)
        regionRough={'hair': 0.58, 'brows': 0.8, 'lashes': 0.8, 'beard': 0.9, 'socks': 0.95, 'eyes': 0.15},
        flags=dict(alpha=FLAG_ALPHA, backface=FLAG_BACK, detail=FLAG_DETAIL, skirt=FLAG_SKIRT),
        lodPx=[300, 84, 26],
        textures=layer_table,
        byteLength=len(binary),
        characters=out_chars,
    )
    with open(os.path.join(OUT, 'cast.json'), 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    gz = os.path.getsize(os.path.join(OUT, 'cast.bin.gz'))
    log(f'wrote cast.json + cast.bin.gz ({len(binary) // 1024} KB raw, {gz // 1024} KB gz), {len(out_chars)} characters')


def inward_vertices(d, body):
    """Vertices of garment triangles that face the body (normal against the nearest skin normal):
    the inner walls of pocket mouths and folds."""
    out = np.zeros(len(d['co']), bool)
    if body is None:
        return out
    from scipy.spatial import cKDTree
    t = d['idx'].reshape(-1, 3)
    P = d['co'][t]
    fn = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    fn /= np.maximum(1e-12, np.linalg.norm(fn, axis=1, keepdims=True))
    c = P.mean(1)
    tree = cKDTree(body['co'])
    dist, j = tree.query(c)
    bn = body['nr'][j]
    inward = ((fn * bn).sum(1) < -0.3) & (dist < 0.06)
    out[t[inward].reshape(-1)] = True
    return out


def hem_distance(co, idx):
    """Per vertex: distance (m) to the nearest vertex on an open border of the part (positions welded, so
    UV seams and region borders are not borders)."""
    key = np.round(co * 2e4).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    t = weld[idx.reshape(-1, 3)]
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    e = np.sort(e, 1)
    e = e[e[:, 0] != e[:, 1]]
    ue, cnt = np.unique(e, axis=0, return_counts=True)
    bw = np.unique(ue[cnt == 1].reshape(-1))
    out = np.full(len(co), 1.0)
    if not len(bw):
        return out
    first = np.zeros(weld.max() + 1, np.int64)
    first[weld] = np.arange(len(co))
    B = co[first[bw]].astype(np.float64)
    C = co.astype(np.float64)
    for a in range(0, len(C), 4096):
        dd = ((C[a:a + 4096, None, :] - B[None, :, :]) ** 2).sum(-1)
        out[a:a + 4096] = np.sqrt(dd.min(1))
    return out


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
    # thigh capsules (radius at the hip and at the knee, per side): a renderer can keep skirts outside them
    thigh = {}
    for side, hb, kb in (('L', 'thighL', 'shinL'), ('R', 'thighR', 'shinR')):
        a, b = J[hb], J[kb]
        ab = b - a
        sk = (reg == CASTM.REGIONS['skin']) & (W[:, 14 if side == 'L' else 18] > 0.6)
        q = P[sk]
        if len(q) < 20:
            thigh[side] = [round(0.085 * k, 4), round(0.055 * k, 4)]
            continue
        t = np.clip(((q - a) @ ab) / (ab @ ab), 0, 1)
        dist = np.linalg.norm(q - (a + t[:, None] * ab), axis=1)
        r0 = np.percentile(dist[t < 0.25], 96) if (t < 0.25).sum() > 5 else 0.085 * k
        r1 = np.percentile(dist[t > 0.75], 96) if (t > 0.75).sum() > 5 else 0.055 * k
        thigh[side] = [round(float(r0), 4), round(float(r1), 4)]
    head = P[(W[:, 5] > 0.5) & (reg == CASTM.REGIONS['skin'])]
    eyes = P[reg == CASTM.REGIONS['eyes']]
    info = dict(H=round(H, 4), kind=meta['kind'], heelZ=round(heelZ, 4), toeZ=round(toeZ, 4), hang=hang,
                hip=[round(float(x), 4) for x in J['thighR']], knee=[round(float(x), 4) for x in J['shinR']],
                ankle=[round(float(x), 4) for x in J['footR']], shoulder=[round(float(x), 4) for x in J['armR']],
                waistY=round(float(waistY), 4), neckY=round(float(J['neck'][1]), 4), thigh=thigh,
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
  in indices); every index of LOD l is < lods[l].vertices (vertices are ordered coarsest-LOD-first, so a far
  LOD touches a short prefix). LOD 0 ~10-15k tris (full detail), 1 ~3-4k, 2 ~1-1.5k (hair cards kept, skin
  pulled in under garment edges), 3 ~250-450 (opaque hair cap instead of cards, no lashes / brows).
  lodPx = suggested figure heights on screen (px) above which LOD 0 / 1 / 2 are used.
  Attributes (byte offsets into the binary, vertexCount entries each):
    position  int16 x3 (6 bytes / vertex): p = min + (q + 32767) / 65534 * range
    normal    int8 x4 normalised: xyz = normal, w = baked ambient occlusion (0..1)
    uv        uint16 x2 normalised (0..1), v = 0 at the bottom row of the layer image
    skinIndex uint8 x4 (runtime bones), skinWeight uint8 x4 normalised (sum = 255)
    tex       uint8 x4 = (albedo layer, normal layer or 255 = none, region id, flags)
  index: u16 or u32, count indices (all LODs concatenated; triangle lists, CCW front faces).
flags: 1 alpha-tested coverage (hair, brows, lashes, beard), 2 duplicated back face of a double-sided card,
  4 detail texture: albedo_linear = 2 * texel_linear * tint_linear (else albedo = texel * tint),
  8 skirt / dress below the waist (weighted pelvis -> both thighs; a renderer may add its own sway or flare).
tints[region] = default linear RGB tint per region (regions{} ids); skin = tone gain on the skin layer.
regionRough[region] = roughness that overrides the layer's for those regions.
textures: albedo array = WebP strips (perStrip layers of size x size stacked vertically, top to bottom = layer
  order, RGB sRGB); a strip with alpha-tested layers has a second opaque image `alpha` whose red channel is the
  coverage (kept apart because browsers premultiply decoded alpha); normal array = WebP strips (RGB tangent
  space, OpenGL / +Y, linear).
  layers[i] = {kind, type ('color' | 'detail' | 'mixed'), rough, normal (normal layer index or -1), alpha}.
"""


if __name__ == '__main__':
    main()
