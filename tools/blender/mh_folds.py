"""Cloth relief for the garment layers of the crowd cast (used by mh_tex.py; numpy only).

The MakeHuman garments are shrink-fitted shells with little or no fold detail in their normal maps (the
tees and blouses are flat). Real worn clothes fold where the body compresses or pulls them: under the
arms (bunching on the sleeve's underside, drape radiating from the armpit down the sides), in the crook
of the elbow, round the waist above a waistband or hem, across the lap, in the creases of the crotch,
behind the knee, stacked above the shoe, and in vertical drape on loose cloth (skirts: gored folds
widening towards the hem). This module synthesises that relief as a height field (metres) defined on the
body: each garment texel is rasterised from a reference character wearing the suit (its rest-pose 3D
position, normal, runtime bone weights and joints), the fold fields are evaluated in body-relative frames
(arm / leg / torso cylinders, radial fans from the armpits and the crotch), and the result is baked into
the suit's UV layout as

  normal   tangent-space normals (OpenGL, +Y = +v) of the relief, to be combined with the suit's own map
  cavity   0..1 crease darkness (narrow valleys of the folds), multiplied into the garment's detail albedo

Folds are continuous across UV seams (they are a function of the 3D point, not of the UV). Deterministic.
"""
import numpy as np

# runtime bones (src/crowd/humans/anim.js BONE)
B = {n: i for i, n in enumerate(['root', 'pelvis', 'spine1', 'spine2', 'neck', 'head', 'clavL', 'armL', 'foreL', 'handL',
                                 'clavR', 'armR', 'foreR', 'handR', 'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR',
                                 'footR', 'toeR'])}
REG_TOP, REG_TOP2, REG_BOTTOM = 5, 6, 7

# garment kinds per suit: (top, bottom)
SUIT_KIND = {
    'male_casualsuit01': ('shirt', 'jeans'), 'male_casualsuit02': ('tee', 'jeans'), 'male_casualsuit03': ('shirt', 'jeans'),
    'male_casualsuit04': ('tee', 'jeans'), 'male_casualsuit05': ('jacket', 'jeans'), 'male_casualsuit06': ('tee', 'jeans'),
    'male_elegantsuit01': ('jacket', 'trousers'), 'female_casualsuit01': ('tee', 'jeans'),
    'female_casualsuit02': ('tee', 'shorts'), 'female_elegantsuit01': ('blouse', 'skirt'),
    'female_sportsuit01': ('tee', 'leggings'),
}


# ----------------------------------------------------------------------------- noise

def _hash(ix, iy, iz, seed):
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + iz.astype(np.int64) * 2147483647 +
         seed * 1442695041) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(0xFFFFFF)


def vnoise(p, seed=0):
    """Smooth value noise in [0, 1] at points p (n, 3)."""
    q = np.floor(p)
    f = p - q
    f = f * f * (3 - 2 * f)
    ix, iy, iz = q[:, 0].astype(np.int64), q[:, 1].astype(np.int64), q[:, 2].astype(np.int64)
    out = 0.0
    for dx in (0, 1):
        wx = f[:, 0] if dx else 1 - f[:, 0]
        for dy in (0, 1):
            wy = f[:, 1] if dy else 1 - f[:, 1]
            for dz in (0, 1):
                wz = f[:, 2] if dz else 1 - f[:, 2]
                out = out + wx * wy * wz * _hash(ix + dx, iy + dy, iz + dz, seed)
    return out


def snoise(p, seed=0):
    """Value noise in [-1, 1]."""
    return vnoise(p, seed) * 2 - 1


def fbm(p, seed=0, octaves=3):
    s, a, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        s = s + a * snoise(p * (2.03 ** o), seed + 17 * o)
        tot += a
        a *= 0.5
    return s / tot


def ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- fold primitives

def fold(phase, amp):
    """Soft cloth folds: a rounded ridge and a slightly narrower valley per period. Returns (height,
    crease) for a phase in fold periods; height in [-amp, amp] (mean ~0), crease 0..1 in the valleys."""
    f = np.cos(2 * np.pi * phase)
    h = amp * (0.85 * f + 0.15 * (1 - 2 * ((1 - f) * 0.5) ** 2) - 0.07)
    return h, ((1 - f) * 0.5) ** 3 * (amp > 0)


class Relief:
    """Accumulates fold heights and crease darkness."""
    def __init__(self, n):
        self.h = np.zeros(n)
        self.c = np.zeros(n)

    def add(self, phase, amp, a_ref=0.004):
        h, c = fold(phase, amp)
        self.h += h
        self.c += c * np.clip(amp / a_ref, 0, 1.5)


# ----------------------------------------------------------------------------- body frames

def _seg_param(P, a, b):
    d = b - a
    L = float(np.linalg.norm(d))
    u = d / max(L, 1e-6)
    t = np.clip((P - a) @ u, 0, L)
    c = a + t[:, None] * u
    return t, np.linalg.norm(P - c, axis=1), c, u, L


def limb_frame(P, a, b, c, inner, front):
    """Along / around coordinates of points P on a two-segment limb a -> b -> c: t (metres from a along the
    chain), phi (around the axis: 0 towards `inner`, +pi/2 towards `front`), r (distance to the axis),
    tb (t at the joint b), L (total length)."""
    t1, d1, c1, u1, L1 = _seg_param(P, a, b)
    t2, d2, c2, u2, L2 = _seg_param(P, b, c)
    use2 = (d2 < d1) & (t2 > 0)
    t = np.where(use2, L1 + t2, t1)
    cc = np.where(use2[:, None], c2, c1)
    uu = np.where(use2[:, None], u2[None, :], u1[None, :])
    r = P - cc
    r = r - (r * uu).sum(1)[:, None] * uu
    ri = inner[None, :] - (uu @ inner)[:, None] * uu
    rf = front[None, :] - (uu @ front)[:, None] * uu
    ri /= np.maximum(np.linalg.norm(ri, axis=1, keepdims=True), 1e-6)
    rf /= np.maximum(np.linalg.norm(rf, axis=1, keepdims=True), 1e-6)
    phi = np.arctan2((r * rf).sum(1), (r * ri).sum(1))
    return t, phi, np.linalg.norm(r, axis=1), L1, L1 + L2


# ----------------------------------------------------------------------------- the relief field

def relief(P, ctx):
    """Fold height (m) and crease darkness at rest-pose garment points P (n, 3; three.js space: y up, the
    figure faces -z, its left at -x). ctx: J (joints), k (stature / 1.76), wa / wl (arm / leg membership
    0..1 per point), reg (region per point), kinds (top, bottom), female, hemTop (lowest y of the top),
    waistBot (top y of the bottom), seed."""
    J, k = ctx['J'], ctx['k']
    n = len(P)
    R = Relief(n)
    wa, wl, reg = ctx['wa'], ctx['wl'], ctx['reg']
    top_kind, bot_kind = ctx['kinds']
    seed = ctx['seed']
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    side = np.where(x < 0, -1.0, 1.0)
    is_top = (reg == REG_TOP) | (reg == REG_TOP2)
    is_bot = reg == REG_BOTTOM
    heavy = 0.7 if top_kind == 'jacket' else 1.0             # heavier cloth: fewer, softer folds
    Q = P / k
    warp = fbm(Q * 9.0, seed + 1, 2) * 0.55                  # breaks the folds' regularity (in periods)
    ampn = 0.55 + 0.9 * vnoise(Q * 14.0 + 3.1, seed + 2)     # per-fold strength

    # ---- arms (sleeves): bunching under the arm, the elbow's crook, stacking above a long sleeve's cuff
    arm_t = np.zeros(n)
    arm_phi = np.zeros(n)
    arm_te = np.zeros(n)
    arm_L = np.zeros(n)
    for s, S in ((-1, 'L'), (1, 'R')):
        m = side == s
        if not m.any():
            continue
        a, b, c = (np.array(J[nm + S]) for nm in ('arm', 'fore', 'hand'))
        t, phi, r, tb, L = limb_frame(P[m], a, b, c, np.array([-s, 0.0, 0.0]), np.array([0.0, 0.0, -1.0]))
        arm_t[m], arm_phi[m], arm_te[m], arm_L[m] = t, phi, tb, L
    turn = arm_phi / (2 * np.pi)                                 # turns round the sleeve (periodic phases use whole turns)
    inner = (1 + np.cos(arm_phi)) * 0.5                          # 1 on the side facing the body
    mA = (wa > 0.15) & is_top
    if mA.any():
        e = np.where(mA, wa, 0.0)
        # under the arm: diagonal rings near the armpit, mostly on the underside
        env = e * ss(0.2 * k, 0.02 * k, arm_t) * (0.25 + 0.75 * inner ** 1.5)
        ph = arm_t / (0.036 * k) + 2 * turn + warp
        R.add(ph, 0.003 * env * ampn * heavy)
        # the elbow's crook (front and inner side of the elbow) and its back
        de = arm_t - arm_te
        crook = (1 + np.cos(arm_phi - 0.9)) * 0.5
        env = e * ss(0.09 * k, 0.0, np.abs(de)) * (0.35 + 0.65 * crook ** 2)
        R.add(de / (0.03 * k) + 2 * turn + warp * 1.3, 0.003 * env * ampn * heavy)
        # long sleeves stack above the cuff
        env = e * ss(arm_L - 0.16 * k, arm_L - 0.03 * k, arm_t)
        R.add(arm_t / (0.028 * k) - 2 * turn + warp, 0.0022 * env * ampn)
        # soft twisting folds along the sleeve
        R.add(4 * turn - arm_t / (0.16 * k) + warp, 0.0008 * e * ampn)

    # ---- torso
    zc = 0.5 * (J['spine2'][2] + J['pelvis'][2])
    th = np.arctan2(x, -(z - zc))                                # 0 front, +pi/2 the figure's right, +-pi back
    rt = np.hypot(x, z - zc)
    arc = th * np.maximum(rt, 0.08 * k)                          # arc length round the torso (m)
    wt = np.clip(1 - wa - wl, 0, 1)
    yA = 0.5 * (J['armL'][1] + J['armR'][1]) - 0.085 * k         # armpit height
    yW = J['spine1'][1]                                          # waist
    mT = is_top & (wt > 0.05)
    if mT.any():
        e = np.where(mT, wt, 0.0)
        # drape fanning out from each armpit down the side and over the front and back
        for s, S in ((-1, 'L'), (1, 'R')):
            ax = abs(J['arm' + S][0]) - 0.06 * k
            qx, qz = s * ax, zc
            # surface coordinates relative to the armpit: down (m) and along the side (m, + towards the front)
            dy = yA - y
            ang0 = s * np.pi / 2
            dth = (th - ang0 + np.pi) % (2 * np.pi) - np.pi
            dh = -s * dth * np.maximum(rt, 0.08 * k)               # + towards the front
            rq = np.hypot(dy, dh)
            fan = np.arctan2(dh, np.maximum(dy, 1e-4))             # 0 straight down
            m = (side == s) | (np.abs(dth) < 1.2)
            env = e * m * ss(-0.02 * k, 0.04 * k, dy) * ss(0.02 * k, 0.06 * k, rq) * ss(0.3 * k, 0.1 * k, rq) * ss(1.25, 0.6, np.abs(fan))
            R.add(fan * 6.0 / np.pi + warp * 0.8 + rq / (0.35 * k), 0.003 * env * ampn * heavy)
        # round the waist: horizontal folds above the hem (untucked) or bloused over the waistband (tucked)
        yb = ctx['hemTop']
        band = 0.16 * k if top_kind in ('shirt', 'blouse') else 0.13 * k
        sides = 0.55 + 0.45 * np.abs(np.sin(th))
        back = 1.0 + 0.35 * ss(1.6, 2.6, np.abs(th))
        env = e * ss(yb + band, yb + 0.015 * k, y) * sides * back
        R.add((y + 0.015 * k * np.sin(th * 3 + seed)) / (0.045 * k) + warp * 1.4, 0.0032 * env * ampn * heavy)
        # the small of the back: the cloth gathers above the waist
        env = e * ss(yW + 0.16 * k, yW, y) * ss(yW - 0.12 * k, yW - 0.02 * k, y) * ss(2.2, 2.9, np.abs(th))
        R.add((y + 0.02 * k * np.sin(th * 5)) / (0.035 * k) + warp, 0.0018 * env * ampn)
        # loose vertical drape from the chest (and the bust) down to the hem
        env = e * ss(yA - 0.02 * k, yA - 0.14 * k, y) * ss(yb - 0.02 * k, yb + 0.08 * k, y)
        R.add(th * 9.0 / (2 * np.pi) + warp * 1.5 + 0.3 * y / k, 0.001 * env * ampn)
        if ctx['female'] and top_kind != 'jacket':
            # under the bust the cloth falls from its apex: folds fanning down and out
            for s in (-1, 1):
                bx, by = s * 0.085 * k, yA - 0.07 * k
                dyb = by - y
                dxb = (x - bx) * s
                front = ss(0.8, 0.3, np.abs(th))
                ang = np.arctan2(dxb, np.maximum(dyb, 1e-4))
                rb = np.hypot(dxb, dyb)
                env = e * front * ss(0.0, 0.05 * k, dyb) * ss(0.25 * k, 0.08 * k, rb) * (side * s > -0.3)
                R.add(ang * 5.0 / np.pi + warp, 0.0012 * env * ampn)
        # the neckline and shoulders: small creases
        env = e * ss(yA + 0.12 * k, yA + 0.2 * k, y)
        R.add(th * 21.0 / (2 * np.pi) + warp * 2.0, 0.0005 * env * ampn)
        if top_kind == 'jacket':
            # a jacket's front: diagonal folds from the button at the waist up towards the shoulders
            env = e * ss(1.2, 0.4, np.abs(th)) * ss(yA, yW + 0.05 * k, y) * ss(yW - 0.08 * k, yW, y)
            R.add((np.abs(x) * 1.2 + (y - yW) * 0.8) / (0.05 * k) + warp, 0.002 * env * ampn)

    # ---- legs (trousers, jeans, shorts, leggings)
    if is_bot.any() and bot_kind != 'skirt':
        leg_t = np.zeros(n)
        leg_phi = np.zeros(n)
        leg_tk = np.zeros(n)
        leg_L = np.zeros(n)
        for s, S in ((-1, 'L'), (1, 'R')):
            m = side == s
            a, b, c = (np.array(J[nm + S]) for nm in ('thigh', 'shin', 'foot'))
            t, phi, r, tb, L = limb_frame(P[m], a, b, c, np.array([-s, 0.0, 0.0]), np.array([0.0, 0.0, -1.0]))
            leg_t[m], leg_phi[m], leg_tk[m], leg_L[m] = t, phi, tb, L
        lturn = leg_phi / (2 * np.pi)
        e = np.where(is_bot, np.clip(wl * 1.4, 0, 1), 0.0)
        tight = 0.45 if bot_kind == 'leggings' else 1.0
        fr = np.sin(leg_phi)                                     # +1 front, -1 back
        # crotch whiskers: a fan from the crotch over the front of the upper thighs
        if bot_kind != 'leggings':
            cy = 0.5 * (J['thighL'][1] + J['thighR'][1]) - 0.08 * k
            dyc = cy - y
            dxc = np.abs(x)
            ang = np.arctan2(dxc, np.maximum(dyc, 1e-4))
            rc = np.hypot(dxc, dyc)
            env = e * ss(-0.1, 0.5, fr) * ss(0.02 * k, 0.05 * k, rc) * ss(0.24 * k, 0.08 * k, rc)
            R.add(ang * 8.0 / np.pi + warp, 0.0026 * env * ampn)
        # behind the knee and above it
        dk = leg_t - leg_tk
        back = ss(0.2, -0.7, fr)
        env = e * ss(0.1 * k, 0.0, np.abs(dk + 0.01 * k)) * (0.3 + 0.7 * back)
        R.add(dk / (0.024 * k) + 2 * lturn + warp * 1.2, 0.003 * env * ampn * tight)
        # stacking above the shoe (long legs only: the bottom reaches near the ankle)
        env = e * ss(leg_L - 0.2 * k, leg_L - 0.04 * k, leg_t) * (bot_kind != 'shorts')
        R.add(leg_t / (0.028 * k * (0.6 if bot_kind == 'leggings' else 1)) + 2 * lturn + warp * 1.5, 0.0035 * env * ampn * tight)
        # long vertical drape down the shin, soft diagonals over the thigh
        env = e * ss(leg_tk - 0.05 * k, leg_tk + 0.1 * k, leg_t) * (bot_kind not in ('shorts', 'leggings'))
        R.add(9 * lturn + warp * 1.2, 0.0013 * env * ampn)
        env = e * ss(leg_tk, leg_tk - 0.12 * k, leg_t) * (bot_kind != 'leggings')
        R.add(6 * lturn + leg_t / (0.12 * k) + warp, 0.0012 * env * ampn)
        # round the waistband and over the seat
        yw = ctx['waistBot']
        env = np.where(is_bot, 1.0, 0.0) * ss(yw - 0.12 * k, yw - 0.02 * k, y) * (bot_kind != 'leggings')
        R.add((y + 0.01 * k * np.sin(th * 4)) / (0.025 * k) + warp, 0.0012 * env * ampn)

    # ---- skirts: gored folds widening and deepening towards the hem, some diagonal drape
    if is_bot.any() and bot_kind == 'skirt':
        yh = 0.5 * (J['thighL'][1] + J['thighR'][1])
        e = np.where(is_bot, 1.0, 0.0)
        down = np.clip((yh + 0.03 * k - y) / (0.5 * k), 0, 1.5)
        thp = np.arctan2(x, -(z - J['pelvis'][2]))
        # (about ten gores round the skirt, each its own depth; finer folds between them near the hem)
        env = e * ss(0.0, 0.7, down)
        R.add(thp * 5.0 / np.pi + warp * 0.7, 0.005 * env * (0.4 + 0.8 * ampn))
        R.add(thp * 13.0 / np.pi + warp * 1.6 + y / (0.25 * k), 0.0012 * e * ss(0.3, 1.0, down) * ampn)
        # just under the waistband: small gathers
        yw = ctx['waistBot']
        env = e * ss(yw - 0.06 * k, yw - 0.01 * k, y)
        R.add(thp * 19.0 / np.pi + warp, 0.0007 * env * ampn)

    # ---- every garment: a little unevenness of the cloth
    R.h += 0.0009 * fbm(Q * 6.0, seed + 9, 3) * np.where(is_top | is_bot, 1.0, 0.0)
    return R.h, np.clip(R.c, 0, 1)


# ----------------------------------------------------------------------------- baking into UV space

def raster_attr(uv, idx, S, co=None):
    """Rasterise UV triangles: per texel (row 0 = v 1) the triangle index and barycentrics.
    Returns (tri (S, S) int, -1 = none; bary (S, S, 3)). With co: triangles whose texel density is far
    from the part's typical one are left out (hole-filling fans whose UVs reach across the layout)."""
    tri = np.full((S, S), -1, np.int64)
    bary = np.zeros((S, S, 3))
    T = uv[idx].astype(np.float64)                      # (m, 3, 2)
    X = T[..., 0] * S - 0.5
    Y = (1 - T[..., 1]) * S - 0.5
    skip = np.zeros(len(idx), bool)
    if co is not None:
        C = co[idx].astype(np.float64)
        a3 = np.linalg.norm(np.cross(C[:, 1] - C[:, 0], C[:, 2] - C[:, 0]), axis=1)
        d1, d2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
        a2 = np.abs(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0])
        dens = np.sqrt(a2 / np.maximum(a3, 1e-14))
        med = np.median(dens[a3 > 1e-10]) if (a3 > 1e-10).any() else 1.0
        skip = (dens > 3.0 * med) | (a3 < 1e-12)
    for f in range(len(idx)):
        if skip[f]:
            continue
        xa, ya = X[f], Y[f]
        x0, x1 = max(int(np.floor(xa.min())), 0), min(int(np.ceil(xa.max())), S - 1)
        y0, y1 = max(int(np.floor(ya.min())), 0), min(int(np.ceil(ya.max())), S - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        d = (ya[1] - ya[2]) * (xa[0] - xa[2]) + (xa[2] - xa[1]) * (ya[0] - ya[2])
        if abs(d) < 1e-12:
            continue
        l1 = ((ya[1] - ya[2]) * (xs - xa[2]) + (xa[2] - xa[1]) * (ys - ya[2])) / d
        l2 = ((ya[2] - ya[0]) * (xs - xa[2]) + (xa[0] - xa[2]) * (ys - ya[2])) / d
        l3 = 1 - l1 - l2
        e = -0.03
        ins = (l1 >= e) & (l2 >= e) & (l3 >= e)
        tri[ys[ins], xs[ins]] = f
        bary[ys[ins], xs[ins]] = np.stack([l1[ins], l2[ins], l3[ins]], -1)
    return tri, bary


def tri_frames(co, uv, idx):
    """Per triangle: unit gradients of u and v on the surface (the runtime's cotangent frame) and the face normal."""
    p0, p1, p2 = co[idx[:, 0]], co[idx[:, 1]], co[idx[:, 2]]
    t0, t1, t2 = uv[idx[:, 0]], uv[idx[:, 1]], uv[idx[:, 2]]
    e1, e2 = p1 - p0, p2 - p0
    d1, d2 = t1 - t0, t2 - t0
    nf = np.cross(e1, e2)
    nf /= np.maximum(np.linalg.norm(nf, axis=1, keepdims=True), 1e-12)
    # gradient of a scalar f on the triangle: grad = (f1 - f0) * g1 + (f2 - f0) * g2 with g1, g2 the dual basis
    a11 = (e1 * e1).sum(1); a12 = (e1 * e2).sum(1); a22 = (e2 * e2).sum(1)
    det = np.maximum(a11 * a22 - a12 * a12, 1e-20)
    g1 = (a22[:, None] * e1 - a12[:, None] * e2) / det[:, None]
    g2 = (a11[:, None] * e2 - a12[:, None] * e1) / det[:, None]
    gu = d1[:, 0:1] * g1 + d2[:, 0:1] * g2
    gv = d1[:, 1:2] * g1 + d2[:, 1:2] * g2
    gu /= np.maximum(np.linalg.norm(gu, axis=1, keepdims=True), 1e-12)
    gv /= np.maximum(np.linalg.norm(gv, axis=1, keepdims=True), 1e-12)
    return gu, gv, nf


def bake(entries, S):
    """entries: [dict(co, nr, uv, idx, reg, w (n, 22), J, k, kinds, female, seed)] in priority order (texels
    already baked by an earlier entry are kept). Returns (normal (S, S, 3) in -1..1, cavity (S, S), mask)."""
    nrm = np.zeros((S, S, 3))
    nrm[..., 2] = 1
    cav = np.zeros((S, S))
    done = np.zeros((S, S), bool)
    for E in entries:
        co, uv, idx, reg, w = E['co'].astype(np.float64), E['uv'].astype(np.float64), E['idx'], E['reg'], E['w']
        tri, bary = raster_attr(uv, idx, S, co)
        new = (tri >= 0) & ~done
        if not new.any():
            continue
        f = tri[new]
        bc = bary[new]
        vi = idx[f]
        P = (co[vi] * bc[..., None]).sum(1)
        vn = (E['nr'][vi].astype(np.float64) * bc[..., None]).sum(1)
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-9)
        W = (w[vi].astype(np.float64) * bc[..., None]).sum(1)
        wa = W[:, [B['armL'], B['foreL'], B['handL'], B['armR'], B['foreR'], B['handR']]].sum(1) + 0.5 * W[:, [B['clavL'], B['clavR']]].sum(1)
        wl = W[:, [B['thighL'], B['shinL'], B['footL'], B['thighR'], B['shinR'], B['footR']]].sum(1)
        rg = reg[vi[:, 0]]
        gu, gv, nf = tri_frames(co, uv, idx)
        Tu, Tv = gu[f], gv[f]
        ctx = dict(J=E['J'], k=E['k'], wa=wa, wl=wl, reg=rg, kinds=E['kinds'], female=E['female'], seed=E['seed'],
                   hemTop=E['hemTop'], waistBot=E['waistBot'])
        h0, c0 = relief(P, ctx)
        eps = 0.0015
        hu, _ = relief(P + Tu * eps, ctx)
        hv, _ = relief(P + Tv * eps, ctx)
        su, sv = (hu - h0) / eps, (hv - h0) / eps
        nn = np.stack([-su, -sv, np.ones_like(su)], -1)
        nn /= np.linalg.norm(nn, axis=1, keepdims=True)
        nrm[new] = nn
        cav[new] = c0
        done |= new
    return nrm, cav, done
