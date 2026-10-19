"""Strand-card hair for the crowd cast (runs inside Blender for its BVH trees; numpy otherwise).

  TRAM_TOOLS_IMAGE=tramline-mh:latest tools/dk blender -b -P tools/blender/mh_hair.py -- \
      [--work DIR] [--only m01,f02] [--jobs 8]

The CC0 hair proxies are a few shells with painted strands: up close they read as helmets. This stage
grooms each character's hairstyle again as layered strand cards, using the proxy only as the envelope of
the style (how far the hair stands off the head, where it ends):

  roots      blue-noise points on the hair-covered scalp (the chars stage's scalp decal), per layer
  growth     each strand leaves its root along the style's flow (away from the crown whorl, sideways
             from a parting, back to a ponytail's tie, with some gravity), then follows the envelope: per
             step it is held at its layer's depth under the envelope's outer surface (measured along the
             normal of the skin or garment underneath) and it ends where the envelope ends (fringe line,
             a bob's hem, the length of long hair) or at its own, slightly random, length
  layers     a dense inner layer (wide cards: no scalp shows through), two strand layers, sparse flyaways
             just outside the envelope (a soft, broken silhouette)
  cards      every strand becomes a ribbon lying in the envelope's tangent plane, wider in the middle,
             narrowing to the tip, a little twisted; uv u = across the card inside one column of the strand
             atlas (mh_tex.py strands), v = root (1) .. tip (0); normals = the hair volume's smooth normal;
             occlusion from the depth in the volume and the root distance; skin weights from the proxy
  LODs       LOD 0 every card, LOD 1 a third of them, wider and with fewer segments; LOD 2-3 keep the proxy
             (simplified) and the opaque cap
  tails      a ponytail's tail and a braid stay the proxy's own geometry at LOD 0-1 (the scalp strands run
             to their tie)

Writes <work>/raw/<id>.cards.npz + <id>.cards.json (read by mh_tex.py and mh_export.py). Characters with a
style marked None (afro) keep the proxy. Deterministic (seeded by the character id).
"""
import os
import sys
import json
import math
import time
import zlib
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mh_cast as CASTM  # noqa: E402

WORK, OUT = CASTM.stage_dirs()
RAW = os.path.join(WORK, 'raw')
HEAD, NECK = 5, 4

# Groom per hairstyle (lengths in m for an adult head; scaled by the head size):
#   flow   'crown' (away from the whorl), 'part' (sideways from a parting, then down), 'tie' (to a tail's tie)
#   crown  whorl offset from the head centre (x, y, z: up, back), part = parting x offset
#   grav   pull down per step (0 stiff short hair .. 1 long hair), len = strand length range
#   thick  hair volume thickness under the envelope's outer surface, width = card width scale
#   fwd    forward sweep of the front hair (fringe), side = sideways sweep of the front hair
STYLE = {
    'short01': dict(flow='crown', crown=(0.01, 0.075, 0.05), grav=0.10, len=(0.045, 0.075), thick=0.022, width=0.7, fwd=0.15, side=0.5, twist=0.4, brow=0.058),
    'short02': dict(flow='crown', crown=(-0.01, 0.07, 0.055), grav=0.12, len=(0.05, 0.085), thick=0.024, width=0.72, fwd=0.15, side=-0.6, twist=0.4, brow=0.055),
    'short03': dict(flow='crown', crown=(0.0, 0.075, 0.05), grav=0.14, len=(0.06, 0.10), thick=0.028, width=0.8, fwd=0.3, side=0.6, twist=0.5, brow=0.05),
    'short04': dict(flow='crown', crown=(0.0, 0.08, 0.045), grav=0.06, len=(0.03, 0.055), thick=0.016, width=0.65, fwd=0.1, side=0.3, twist=0.3, brow=0.065),
    'bob01': dict(flow='part', crown=(0.0, 0.07, 0.06), part=0.022, grav=0.55, len=(0.16, 0.26), thick=0.02, width=1.0, fwd=0.6, side=0.6, blunt=True, jit=(-0.002, 0.004)),
    'bob02': dict(flow='part', crown=(0.0, 0.07, 0.06), part=0.022, grav=0.55, len=(0.16, 0.26), thick=0.02, width=1.0, fwd=0.6, side=0.6, blunt=True, jit=(-0.002, 0.004)),
    'long01': dict(flow='part', crown=(0.0, 0.07, 0.06), part=0.004, grav=0.75, len=(0.45, 0.75), thick=0.022, width=1.35, fwd=0.0, side=1.0),
    'ponytail01': dict(flow='tie', crown=(0.0, 0.07, 0.06), grav=0.05, len=(0.10, 0.24), thick=0.012, width=0.9, fwd=0.0, side=0.0),
    'braid01': dict(flow='tie', crown=(0.0, 0.07, 0.06), grav=0.05, len=(0.10, 0.26), thick=0.012, width=0.9, fwd=0.0, side=0.0),
    'afro01': None,
}
# layers: depth fraction under the outer surface (1 = the full thickness in, < 0 = outside), Poisson root
# spacing (m), card width (m), strand-atlas columns, LOD 1 share
LAYERS = [
    dict(name='base', depth=0.9, r=0.0125, w=0.026, cols=(0, 1), lod1=0.4),
    dict(name='mid', depth=0.5, r=0.0155, w=0.02, cols=(2, 3, 4, 5), lod1=0.35),
    dict(name='outer', depth=0.12, r=0.017, w=0.016, cols=(2, 3, 4, 5), lod1=0.3),
    dict(name='fly', depth=-0.12, r=0.03, w=0.01, cols=(6,), lod1=0.0),
]
STRAND_COLS = 8          # columns of the strand atlas layer
CLEAR = 0.0018           # strands stay this far off the skin / cloth (m)


def log(*a):
    print('[mh-hair]', *a, flush=True)


def script_args():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else []


def parse(argv):
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--only', default='')
    p.add_argument('--jobs', type=int, default=8)
    p.add_argument('--one', default='')
    p.add_argument('--work', default=WORK)
    p.add_argument('--out', default=OUT)
    p.add_argument('--debug', action='store_true', help='also write <id>.strands.npz (the strand polylines)')
    return p.parse_args(argv)


DEBUG = [False]


def run_driver(args):
    import bpy
    ids = [i for i in args.only.split(',') if i] or [c for c in CASTM.CAST if os.path.exists(os.path.join(RAW, c + '.json'))]
    t0 = time.time()
    n = max(1, min(args.jobs, len(ids)))
    chunks = [ids[k::n] for k in range(n)]
    procs = []
    for ch in chunks:
        cmd = [bpy.app.binary_path, '-b', '-P', os.path.abspath(__file__), '--', '--one', ','.join(ch), '--work', WORK] + (['--debug'] if args.debug else [])
        lf = open(os.path.join(RAW, 'hair_%s.log' % ch[0]), 'w')
        procs.append((ch, subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT), lf))
    failed = []
    for ch, p, lf in procs:
        p.wait()
        lf.close()
        for c in ch:
            if p.returncode != 0 or not os.path.exists(os.path.join(RAW, c + '.cards.json')):
                failed.append(c)
    if failed:
        raise SystemExit('hair failed: ' + ','.join(failed))
    log(f'{len(ids)} characters groomed in {time.time() - t0:.0f}s')


# ============================================================================= one character

def groom(cid):
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree

    t0 = time.time()
    meta = json.load(open(os.path.join(RAW, cid + '.json')))
    z = np.load(os.path.join(RAW, cid + '.npz'))
    out_json = os.path.join(RAW, cid + '.cards.json')
    out_npz = os.path.join(RAW, cid + '.cards.npz')
    style_name = meta['spec'].get('hair')
    S = STYLE.get(style_name)
    hair_parts = [p for p in meta['parts'] if p['kind'] == 'hair']
    if not S or not hair_parts:
        json.dump(dict(id=cid, parts=[], style=style_name, cards=False), open(out_json, 'w'))
        np.savez_compressed(out_npz)
        log(cid, f'{style_name}: keeps the proxy')
        return
    rng = np.random.default_rng(zlib.crc32(('hair:' + cid).encode()))

    def part(p):
        k = p['key']
        return {a: z[k + '_' + a] for a in ('co', 'nr', 'uv', 'w', 'idx', 'ao') if k + '_' + a in z} | \
            ({'dec': z[k + '_dec']} if k + '_dec' in z else {})
    body_p = next(p for p in meta['parts'] if p['kind'] == 'body')
    body = part(body_p)
    hair = part(hair_parts[0])
    eyes = next((part(p) for p in meta['parts'] if p['kind'] == 'eyes'), None)
    E = eyes['co'].mean(0) if eyes is not None else None
    ipd = float(eyes['co'][eyes['co'][:, 0] > E[0], 0].mean() - eyes['co'][eyes['co'][:, 0] < E[0], 0].mean()) if eyes is not None else 0.064
    hk = max(0.6, ipd / 0.064)
    headv = body['w'][:, HEAD] > 0.5
    hc = body['co'][headv].mean(0)
    if E is None:
        E = hc + np.array([0, 0.02, -0.07])

    # ---------------------------------------------------------------- collision surface: skin, garments, shoes, hat
    cv, cf, cn, chd = [], [], [], []
    off = 0
    for p in meta['parts']:
        if p['kind'] in ('body', 'suit', 'shoes', 'hat', 'eyes'):
            d = part(p)
            cv.append(d['co'].astype(np.float64)); cn.append(d['nr'].astype(np.float64))
            cf.append(d['idx'].astype(np.int64) + off)
            # (the scalp: there the hair is measured from the skin out to the envelope; ears, face and neck
            # are not scalp, the hair beside them follows the envelope's sheets)
            if p['kind'] == 'body' and 'dec' in d:
                cv_ = np.clip((128.0 - d['dec'].astype(np.float64)) / 127.0, 0, 1)
                chd.append((d['w'][d['idx'], HEAD].mean(1) > 0.5) & (cv_[d['idx']].max(1) > 0.15))
            else:
                chd.append(np.zeros(len(d['idx']), bool))
            off += len(d['co'])
    CV = np.concatenate(cv); CN = np.concatenate(cn); CF = np.concatenate(cf); CHEAD = np.concatenate(chd)
    col = BVHTree.FromPolygons([Vector(v) for v in CV], CF.tolist(), epsilon=0.0)
    hat = next((part(p) for p in meta['parts'] if p['kind'] == 'hat'), None)
    band = float(np.percentile(hat['co'][:, 1], 8)) - 0.004 if hat is not None else 1e9

    # ---------------------------------------------------------------- envelope: the proxy without its tail
    HV = hair['co'].astype(np.float64)
    HI = hair['idx'].astype(np.int64)
    tail_tri = tail_mask(np, HV, HI, hc, hk, body['co'][headv]) if S['flow'] == 'tie' else np.zeros(len(HI), bool)
    tie = None
    if tail_tri.any():
        tv = HV[np.unique(HI[tail_tri])]
        top = tv[tv[:, 1] > tv[:, 1].max() - 0.02 * hk]
        tie = top.mean(0)
        tie[2] -= 0.006 * hk
    env_tris = HI[~tail_tri]
    env = BVHTree.FromPolygons([Vector(v) for v in HV], env_tris.tolist(), epsilon=0.0)
    kdh = KDTree(len(HV))
    for i, v in enumerate(HV):
        kdh.insert(Vector(v), i)
    kdh.balance()

    def smooth_normal(loc, ti):
        """Interpolated vertex normal of collision triangle ti at loc."""
        a, b, c = CF[ti]
        A, B, Cc = CV[a], CV[b], CV[c]
        v0, v1, v2 = B - A, Cc - A, np.asarray(loc) - A
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-18:
            n = CN[a]
        else:
            v_ = (d11 * d20 - d01 * d21) / den
            w_ = (d00 * d21 - d01 * d20) / den
            n = CN[a] * (1 - v_ - w_) + CN[b] * v_ + CN[c] * w_
        return n / max(1e-9, np.linalg.norm(n))

    def ground(p):
        """Nearest collision point under p: (location, outward normal, height of p above it, on the head)."""
        loc, fn, ti, dist = col.find_nearest(Vector(p), 0.5)
        if loc is None:
            return None
        L = np.array(loc)
        n = smooth_normal(L, ti)
        h = float((np.asarray(p) - L) @ n)
        return L, n, h, bool(CHEAD[ti])

    HN = hair['nr'].astype(np.float64)
    # the proxy's own strand direction per envelope triangle: its texture's strands run along v, so dP/dv
    # (oriented downwards) is how its sheets hang (used for hair below the scalp)
    HUV = hair['uv'].astype(np.float64)
    tp = HV[env_tris]
    tu = HUV[env_tris]
    e1, e2 = tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0]
    du1, dv1 = tu[:, 1, 0] - tu[:, 0, 0], tu[:, 1, 1] - tu[:, 0, 1]
    du2, dv2 = tu[:, 2, 0] - tu[:, 0, 0], tu[:, 2, 1] - tu[:, 0, 1]
    det = du1 * dv2 - du2 * dv1
    det = np.where(np.abs(det) < 1e-12, 1e-12, det)
    BV = (e2 * du1[:, None] - e1 * du2[:, None]) / det[:, None]
    BV /= np.maximum(1e-9, np.linalg.norm(BV, axis=1, keepdims=True))
    BV = np.where((BV[:, 1] > 0)[:, None], -BV, BV)
    ENV_DIR = BV

    LASTENV = [0]

    def envelope(p, reach=0.08):
        """Nearest envelope point to p and the proxy's interpolated normal there, or None."""
        loc, fn, ti, dist = env.find_nearest(Vector(p), reach)
        if loc is None:
            return None
        Lq = np.array(loc)
        LASTENV[0] = ti
        a, b, c = env_tris[ti]
        A_, B_, C_ = HV[a], HV[b], HV[c]
        v0, v1, v2 = B_ - A_, C_ - A_, Lq - A_
        d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-18:
            n = HN[a]
        else:
            vv = (d11 * d20 - d01 * d21) / den
            ww = (d00 * d21 - d01 * d20) / den
            n = HN[a] * (1 - vv - ww) + HN[b] * vv + HN[c] * ww
        return Lq, n / max(1e-9, np.linalg.norm(n)), dist

    def outer(L, n, reach=0.15):
        """Height of the envelope's outermost surface above L along n, or None."""
        o = Vector(L + n * 0.0012)
        dv = Vector(n)
        far = None
        start = o
        for _ in range(14):
            h = env.ray_cast(start, dv, reach)
            if h[0] is None:
                break
            far = float((np.array(h[0]) - L) @ n)
            start = h[0] + dv * 0.0012
        return far

    # ---------------------------------------------------------------- flow field
    crown = hc + np.array(S['crown']) * hk
    part_x = hc[0] + S.get('part', 0.0) * hk
    front_z = E[2] + 0.02 * hk           # (in front of this, the hairline region over the forehead)

    def flow(p, n):
        """Desired strand direction at p over a surface with normal n (unit, tangent to it)."""
        if S['flow'] == 'tie' and tie is not None:
            # (back over the top of the head to the tie: the front hair aims at the crown first)
            w = float(np.clip((p[2] - (crown[2] - 0.05 * hk)) / (0.06 * hk), 0, 1))
            a_ = crown + np.array([0.0, 0.01, 0.0]) * hk - p
            b_ = tie - p
            v = a_ / max(1e-6, np.linalg.norm(a_)) * (1 - w) + b_ / max(1e-6, np.linalg.norm(b_)) * w
        elif S['flow'] == 'part':
            lat = p[0] - part_x
            sgn = 1.0 if lat >= 0 else -1.0
            # (sideways from the parting on top; the back hangs down from the crown)
            v = np.array([sgn * (0.35 + 0.65 * min(1.0, abs(lat) / (0.03 * hk))), 0.0, 0.0])
            v = v + (p - crown) / max(1e-6, np.linalg.norm(p - crown)) * 0.6
        else:
            v = p - crown
            v = v / max(1e-6, np.linalg.norm(v))
        # front hair: swept forward and to the side (a fringe or a quiff lies over the forehead)
        fr = np.clip((front_z + 0.07 * hk - p[2]) / (0.05 * hk), 0.0, 1.0)
        if fr > 0 and S['flow'] != 'tie':
            # (parted styles sweep to either side of the parting, short ones all to one side)
            side = S.get('side', 0.0) * (np.sign(p[0] - part_x) or 1.0 if S['flow'] == 'part' else 1.0)
            v = v + fr * np.array([side, 0.0, -S.get('fwd', 0.0)])
        v = v - n * (v @ n)
        l = np.linalg.norm(v)
        return v / l if l > 1e-6 else np.array([0.0, -1.0, 0.0])

    # ---------------------------------------------------------------- roots on the hair-covered scalp
    BI = body['idx'].astype(np.int64)
    cov = np.clip((128.0 - body['dec'].astype(np.float64)) / 127.0, 0, 1) if 'dec' in body else np.zeros(len(body['co']))
    BC = body['co'].astype(np.float64)
    tri_cov = cov[BI].mean(1)
    sel = np.where((cov[BI].min(1) > 0.15) & (tri_cov > 0.3))[0]
    A = BC[BI[sel]]
    area = 0.5 * np.linalg.norm(np.cross(A[:, 1] - A[:, 0], A[:, 2] - A[:, 0]), axis=1)
    scalp_area = float((area * tri_cov[sel]).sum())

    # (greedy Poisson thinning on a hash grid: KDTree cannot be grown incrementally)
    class Grid(list):
        def __init__(self, r):
            super().__init__()
            self.r = r
            self.cells = {}

        def append(self, p):
            k = tuple(np.floor(p / self.r).astype(int))
            self.cells.setdefault(k, []).append(p)

    def kd_find(g, p, r):
        k = np.floor(p / g.r).astype(int)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for q in g.cells.get((k[0] + dx, k[1] + dy, k[2] + dz), ()):
                        if np.sum((q - p) ** 2) < r * r:
                            return True
        return False

    # ---------------------------------------------------------------- growth
    def grow(root, n0, depth, Lmax, rs):
        brow = (S.get('brow', 0.03) + rs.uniform(*S.get('jit', (-0.004, 0.012)))) * hk
        p = root + n0 * CLEAR
        d = flow(p, n0)
        pts = [p.copy()]
        nrm = [n0.copy()]
        hts = [CLEAR]
        dep = [0.02]          # depth under the envelope's outer surface (m)
        L = 0.0
        miss = 0
        why = 'steps'
        lastT = None
        hang = False
        for step in range(400):
            h = 0.003 if L < 0.03 else 0.005 if L < 0.12 else 0.01
            g = ground(p)
            if g is None:
                why = 'ground'
                break
            _, n, _, _ = g
            want = flow(p, n)
            down = np.array([0.0, -1.0, 0.0])
            if hang:
                # hanging hair: down the envelope's sheet (behind the shoulders, beside the neck)
                ee = envelope(p)
                if ee is not None:
                    w2 = ENV_DIR[LASTENV[0]] * 0.8 + down * 0.2
                    w2 = w2 - ee[1] * (w2 @ ee[1])
                    l2 = np.linalg.norm(w2)
                    if l2 > 1e-6:
                        want = 0.15 * want + 0.85 * w2 / l2
            # (a strand that keeps circling in one spot ends there)
            if len(pts) > 21 and np.linalg.norm(pts[-1] - pts[-21]) < 0.35 * 20 * h:
                why = 'stall'
                break
            # stiffness: a strand bends gradually; gravity grows along it (the root stands, the length hangs)
            gw = S['grav'] * min(1.0, L / (0.04 * hk) + 0.15)
            d = d * 0.55 + want * 0.45 + down * gw * 0.5
            d = d / np.linalg.norm(d)
            q = p + d * h
            g2 = ground(q)
            if g2 is None:
                why = 'ground'
                break
            L2, n2, hq, onhead = g2
            # (below the ears the hair hangs: it follows the envelope's sheets from there on)
            if q[1] < E[1] - 0.035 * hk:
                onhead = False
            T = outer(L2, n2) if onhead and not hang else None
            if T is None and (not onhead or hang or L > 0.02 * hk):
                # off the scalp: the strand follows the nearest sheet of the envelope at its layer's depth
                # (under the sheet's outer side), and ends where it has passed the sheet's edge
                hang = True
                ee = envelope(q)
                if ee is None:
                    why = 'edge'
                    break
                qe, ne, de = ee
                if ne @ n2 < 0:
                    ne = -ne
                off_ = q - qe
                tang = off_ - ne * (off_ @ ne)
                if np.linalg.norm(tang) > 0.004 * hk or de > 0.04 * hk:
                    why = 'edge'
                    break
                dz = depth * S['thick'] * 0.6 * hk if depth >= 0 else depth * 0.03 * hk
                tgt = qe - ne * dz
                q = q + (tgt - q) * 0.35
                g3 = ground(q)
                if g3 is not None and g3[2] < CLEAR:
                    q = q + g3[1] * (CLEAR - g3[2])
                seg = q - p
                sl = np.linalg.norm(seg)
                if sl < 1e-5:
                    why = 'stall'
                    break
                d = seg / sl
                p = q
                L += sl
                pts.append(p.copy()); nrm.append(ne.copy()); hts.append(0.0); dep.append(max(0.0, dz))
                if L >= Lmax:
                    why = 'length'
                    break
                continue
            if T is None or T < CLEAR:
                # (gaps between the proxy's cards: a few steps on at the last height; past its edge, the end)
                miss += 1
                if miss > 3 or lastT is None:
                    why = 'edge'
                    break
                T = lastT
            else:
                miss = 0
                lastT = T
            thick = min(max(T - CLEAR, 0.0), S['thick'] * hk)
            target = T - depth * thick if depth >= 0 else T - depth * 0.012 * hk
            target = max(CLEAR, target)
            # (the root rises to its layer over the first couple of centimetres)
            k = 0.35 if L > 0.01 else 0.2
            hn = max(CLEAR, hq + (target - hq) * k)
            # (only the height is corrected, along the normal: the step's travel along the surface stays,
            # so a strand never stalls in a hollow such as the nape)
            q = q + n2 * (hn - hq)
            seg = q - p
            sl = np.linalg.norm(seg)
            if sl < 1e-5:
                break
            d = seg / sl
            p = q
            L += sl
            pts.append(p.copy()); nrm.append(n2.copy()); hts.append(hn); dep.append(max(0.0, T - hn))
            if L >= Lmax or p[1] > band:
                why = 'length' if L >= Lmax else 'hat'
                break
            # in front of the forehead: the strand ends at the style's fringe line (short cuts high on the
            # forehead, bobs and long hair just above the brows)
            if p[1] < E[1] + brow and abs(p[0] - E[0]) < 0.068 * hk and p[2] < E[2] + 0.025 * hk:
                why = 'face'
                break
            if tie is not None and np.linalg.norm(p - tie) < 0.012 * hk:
                why = 'tie'
                break
        # (trailing steps past the envelope's edge are dropped)
        if why == 'edge' and miss > 0:
            k = len(pts) - miss
            pts, nrm, hts, dep = pts[:max(2, k)], nrm[:max(2, k)], hts[:max(2, k)], dep[:max(2, k)]
        WHY[why] = WHY.get(why, 0) + 1
        LASTWHY[0] = why
        return np.array(pts), np.array(nrm), np.array(dep), L

    strands = []          # (layer index, points, normals, depth, length, random)
    WHY = {}
    LASTWHY = ['']
    DBG = []
    for li, Ly in enumerate(LAYERS):
        rs = np.random.default_rng(zlib.crc32(f'{cid}:{Ly["name"]}'.encode()))
        chosen_kd = Grid(Ly['r'] * hk)
        dens = 3.0 / ((Ly['r'] * hk) ** 2)
        cnt = rs.poisson(area * dens)
        ti = np.repeat(np.arange(len(sel)), cnt)
        u = rs.random((len(ti), 2))
        flip = u.sum(1) > 1
        u[flip] = 1 - u[flip]
        tri = A[ti]
        pts = tri[:, 0] + (tri[:, 1] - tri[:, 0]) * u[:, :1] + (tri[:, 2] - tri[:, 0]) * u[:, 1:]
        cvx = cov[BI[sel[ti]]]
        c = cvx[:, 0] * (1 - u[:, 0] - u[:, 1]) + cvx[:, 1] * u[:, 0] + cvx[:, 2] * u[:, 1]
        keep = rs.random(len(pts)) < np.clip((c - 0.25) / 0.6, 0, 1) ** 1.5
        pts = pts[keep]
        pts = pts[pts[:, 1] < band]
        chosen = []
        for i in rs.permutation(len(pts)):
            if kd_find(chosen_kd, pts[i], Ly['r'] * hk):
                continue
            chosen.append(i)
            chosen_kd.append(pts[i])
        for i in chosen:
            p = pts[i]
            # (the dense inner layer stays off the hairline over the forehead: thin hair there)
            if Ly['name'] == 'base' and p[2] < E[2] + 0.035 * hk and p[1] < E[1] + 0.1 * hk:
                continue
            g = ground(p)
            if g is None:
                continue
            Lmax = rs.uniform(*S['len']) * hk * (0.6 if Ly['name'] == 'fly' else 1.0)
            sp, sn, sd, L = grow(g[0], g[1], Ly['depth'], Lmax, rs)
            if L < 0.012 * hk or len(sp) < 3:
                continue
            strands.append((li, sp, sn, sd, L, float(rs.random())))
            DBG.append((li, sp, LASTWHY[0]))
    log(cid, f'{style_name}: scalp {scalp_area * 1e4:.0f} cm2, {len(strands)} strands '
             f'({", ".join(str(sum(1 for s in strands if s[0] == i)) for i in range(len(LAYERS)))}) in {time.time() - t0:.1f}s; '
             f'ends {WHY}; length p50 {np.median([s[4] for s in strands]) * 100:.1f} p90 {np.percentile([s[4] for s in strands], 90) * 100:.1f} cm')

    # ---------------------------------------------------------------- cards
    HW = hair['w'].astype(np.float64)
    HAO = hair['ao'].astype(np.float64) if 'ao' in hair else np.ones(len(HV))

    def weights_at(p):
        hits = kdh.find_n(Vector(p), 4)
        ws, acc, ao = 0.0, np.zeros(HW.shape[1]), 0.0
        for _, j, dist in hits:
            w = 1.0 / (dist + 0.003)
            acc += HW[j] * w; ao += HAO[j] * w; ws += w
        acc /= max(ws, 1e-9)
        return acc / max(acc.sum(), 1e-9), ao / max(ws, 1e-9)

    def card(s, lod, rs):
        li, sp, sn, sd, L, rnd = s
        Ly = LAYERS[li]
        # smooth the strand (Laplacian, root fixed) and resample it by arc length
        q = sp.copy()
        for _ in range(3):
            q[1:-1] = 0.5 * q[1:-1] + 0.25 * (q[:-2] + q[2:])
        seglen = np.linalg.norm(np.diff(q, axis=0), axis=1)
        acc = np.concatenate([[0.0], np.cumsum(seglen)])
        tot = acc[-1]
        if lod == 0:
            nseg = int(np.clip(round(tot / (0.012 * hk)), 3, 14))
        else:
            nseg = int(np.clip(round(tot / (0.03 * hk)), 2, 6))
        ts = np.linspace(0, 1, nseg + 1)
        P = np.stack([np.interp(ts * tot, acc, q[:, k]) for k in range(3)], 1)
        N = np.stack([np.interp(ts * tot, acc, sn[:, k]) for k in range(3)], 1)
        D = np.interp(ts * tot, acc, np.clip(sd, 0.0, 0.1))
        N /= np.maximum(1e-9, np.linalg.norm(N, axis=1, keepdims=True))
        T = np.gradient(P, axis=0)
        T /= np.maximum(1e-9, np.linalg.norm(T, axis=1, keepdims=True))
        B = np.cross(T, N)
        B /= np.maximum(1e-9, np.linalg.norm(B, axis=1, keepdims=True))
        # a little twist about the strand (cards are not all flat on the volume)
        tw0, tw1 = rs.normal(0, 0.25) * S.get('twist', 1.0), rs.normal(0, 0.35) * S.get('twist', 1.0)
        ang = tw0 + tw1 * ts
        Nc = N * np.cos(ang)[:, None] - B * np.sin(ang)[:, None]
        Bc = np.cross(T, Nc)
        Bc /= np.maximum(1e-9, np.linalg.norm(Bc, axis=1, keepdims=True))
        w = Ly['w'] * hk * S['width'] * rs.uniform(0.8, 1.2) * (1.6 if lod == 1 else 1.0)
        # (fine locks along the front hairline and the fringe)
        if sp[0][2] < E[2] + 0.04 * hk:
            w *= 0.65
        prof = (0.75 + 0.25 * np.sin(np.pi * np.clip(ts * 1.7, 0, 1))) * (1.0 - 0.45 * np.clip((ts - 0.55) / 0.45, 0, 1))
        half = 0.5 * w * prof
        V = np.concatenate([P - Bc * half[:, None], P + Bc * half[:, None]])
        # volume normal: the surface normal under the hair, rounded towards the head centre on the head
        rad = P - hc
        rad /= np.maximum(1e-9, np.linalg.norm(rad, axis=1, keepdims=True))
        on_head = np.clip((P[:, 1] - (hc[1] - 0.09 * hk)) / (0.06 * hk), 0, 1)[:, None]
        Nv = N * (1 - 0.5 * on_head) + rad * 0.5 * on_head
        Nv /= np.maximum(1e-9, np.linalg.norm(Nv, axis=1, keepdims=True))
        Nn = np.concatenate([Nv, Nv])
        cols = Ly['cols']
        # (blunt cuts: strands ending together, a straight hem and fringe)
        if S.get('blunt') and Ly['name'] in ('mid', 'outer'):
            cols = (7, 7, 7, 2)
        cidx = cols[int(rnd * len(cols) * 0.9999)]
        cw = 1.0 / STRAND_COLS
        inset = 1.5 / 1024
        u0, u1 = cidx * cw + inset, (cidx + 1) * cw - inset
        v = 0.995 - 0.99 * ts
        UV = np.concatenate([np.stack([np.full_like(v, u0), v], 1), np.stack([np.full_like(v, u1), v], 1)])
        # occlusion: deeper in the volume and near the roots darker
        ao_d = 0.3 + 0.7 * np.exp(-D / 0.01)
        ao_r = 0.55 + 0.45 * np.clip(ts / 0.25, 0, 1)
        Wt, AOp = [], []
        for pnt in P:
            wv, ao = weights_at(pnt)
            Wt.append(wv); AOp.append(ao)
        Wt = np.array(Wt); AOp = np.array(AOp)
        ao = np.clip(ao_d * ao_r * (0.45 + 0.55 * AOp), 0.08, 1.0)
        m = nseg + 1
        tris = []
        for i in range(nseg):
            a, b, c, d = i, i + 1, m + i, m + i + 1
            # (front faces towards the outside: winding by the normal)
            tris.append((a, c, b)); tris.append((b, c, d))
        tris = np.array(tris, np.int64)
        # wind so the face normal agrees with the volume normal
        fa = V[tris[:, 1]] - V[tris[:, 0]]
        fb = V[tris[:, 2]] - V[tris[:, 0]]
        fn = np.cross(fa, fb)
        if (fn * Nn[tris[:, 0]]).sum() < 0:
            tris = tris[:, [0, 2, 1]]
        return dict(co=V, nr=Nn, uv=UV, w=np.concatenate([Wt, Wt]), ao=np.concatenate([ao, ao]), idx=tris,
                    rnd=int(rnd * 253))

    out = {}
    parts = []
    for lod in (0, 1):
        rs = np.random.default_rng(zlib.crc32(f'{cid}:cards{lod}'.encode()))
        chosen = []
        for s in strands:
            Ly = LAYERS[s[0]]
            if lod == 1:
                if Ly['lod1'] <= 0 or (s[5] * 997.0) % 1.0 > Ly['lod1']:
                    continue
            chosen.append(card(s, lod, rs))
        if not chosen:
            continue
        nv = 0
        co, nr, uv, w, ao, idx, dec = [], [], [], [], [], [], []
        for c in chosen:
            co.append(c['co']); nr.append(c['nr']); uv.append(c['uv']); w.append(c['w']); ao.append(c['ao'])
            idx.append(c['idx'] + nv); dec.append(np.full(len(c['co']), c['rnd'], np.uint8))
            nv += len(c['co'])
        key = f'c{lod}'
        out[key + '_co'] = np.concatenate(co).astype(np.float32)
        out[key + '_nr'] = np.concatenate(nr).astype(np.float32)
        out[key + '_uv'] = np.concatenate(uv).astype(np.float32)
        out[key + '_w'] = np.concatenate(w).astype(np.float32)
        out[key + '_ao'] = np.concatenate(ao).astype(np.float32)
        out[key + '_idx'] = np.concatenate(idx).astype(np.int32)
        out[key + '_reg'] = np.full(nv, CASTM.REGIONS['hair'], np.int16)
        out[key + '_dec'] = np.concatenate(dec)
        parts.append(dict(key=key, kind=f'cards{lod}', tex='strands:fine', verts=int(nv), tris=int(len(out[key + '_idx']))))
    # the tail (ponytail, braid): the proxy's own triangles at LOD 0-1
    if tail_tri.any():
        ti = HI[tail_tri]
        vs = np.unique(ti)
        remap = -np.ones(len(HV), np.int64)
        remap[vs] = np.arange(len(vs))
        key = 'ct'
        for a in ('co', 'nr', 'uv', 'w', 'ao', 'dec'):
            if a in hair:
                out[key + '_' + a] = hair[a][vs]
        out[key + '_idx'] = remap[ti].astype(np.int32)
        out[key + '_reg'] = np.full(len(vs), CASTM.REGIONS['hair'], np.int16)
        parts.append(dict(key=key, kind='hairtail', tex=hair_parts[0]['tex'], verts=int(len(vs)), tris=int(len(ti))))
    if DEBUG[0]:
        np.savez_compressed(os.path.join(RAW, cid + '.strands.npz'), pts=np.concatenate([d[1] for d in DBG]),
                            off=np.cumsum([0] + [len(d[1]) for d in DBG]), layer=np.array([d[0] for d in DBG]),
                            why=np.array([d[2] for d in DBG]))
    np.savez_compressed(out_npz, **out)
    json.dump(dict(id=cid, style=style_name, cards=True, parts=parts, tie=tie.tolist() if tie is not None else None,
                   strands=len(strands)), open(out_json, 'w'), indent=1)
    log(cid, 'cards', [(p['key'], p['verts'], p['tris']) for p in parts], f'in {time.time() - t0:.1f}s')


def tail_mask(np, HV, HI, hc, hk, head):
    """Triangles of the proxy's tail (ponytail, braid): connected pieces behind the head that reach well
    below its centre."""
    key = np.round(HV * 2e3).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    n = weld.max() + 1
    par = np.arange(n)

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    for t in HI:
        a, b, c = find(weld[t[0]]), find(weld[t[1]]), find(weld[t[2]])
        par[b] = a
        par[find(c)] = find(a)
    root = np.array([find(weld[i]) for i in range(len(HV))])
    back = float(np.percentile(head[:, 2], 99))
    tri_root = root[HI[:, 0]]
    out = np.zeros(len(HI), bool)
    for r in np.unique(root):
        vs = root == r
        c = HV[vs]
        if c[:, 2].min() > back - 0.035 * hk and c[:, 1].min() < hc[1] - 0.06 * hk:
            out |= tri_root == r
    return out


if __name__ == '__main__':
    args = parse(script_args())
    DEBUG[0] = args.debug
    if args.one:
        for cid in args.one.split(','):
            groom(cid)
    else:
        run_driver(args)
