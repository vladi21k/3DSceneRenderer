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

Every fold is placed on its own (a deterministic draw per garment and feature picks its position, tilt,
length, width and depth; it tapers out at both ends and creases sharply along its feet), so nothing repeats
at a fixed period: a jeans hem breaks into two to four Z-tilted folds a few cm apart, a tee falls from the
armpits in fans of uneven folds, a skirt into flutes of uneven spacing. Folds are continuous across UV seams
(they are a function of the 3D point, not of the UV). Deterministic.
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

class Draw:
    """Deterministic uniform draws for one feature of one garment (a 32-bit hash of seed, tag, counter):
    every fold gets its own place, length, width and depth, the same on every run."""
    def __init__(self, seed, tag):
        h = 2166136261
        for ch in tag:
            h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
        self.s = (h ^ (int(seed) * 2654435761)) & 0xFFFFFFFF
        self.i = 0

    def u(self, a=0.0, b=1.0):
        self.i += 1
        h = (self.s + self.i * 0x9E3779B9) & 0xFFFFFFFF
        h = ((h ^ (h >> 16)) * 0x85EBCA6B) & 0xFFFFFFFF
        h = ((h ^ (h >> 13)) * 0xC2B2AE35) & 0xFFFFFFFF
        h ^= h >> 16
        return a + (b - a) * (h / 4294967296.0)

    def n(self, a, b):
        """An integer in a..b inclusive."""
        return int(min(b, a + int(self.u() * (b - a + 1))))

    def sgn(self):
        return 1.0 if self.u() < 0.5 else -1.0


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def crest(d, w):
    """A fold's cross-section at signed distance d (m) from its crest line, half width w: a rounded crest
    falling to a sharp crease at |d| = w (cloth turning into the valley). Returns (height 0..1, crease 0..1)."""
    x = np.abs(d) / np.maximum(w, 1e-6)
    h = np.clip(1.0 - x * x, 0.0, None) ** 1.15
    c = np.exp(-((x - 1.0) / 0.28) ** 2)
    return h, c


def taper(u, c, L):
    """Along a fold of half length L centred at c: 1 over its middle, easing to 0 at its two ends (folds die
    out into the cloth, never stop square)."""
    return ss(1.0, 0.4, np.abs(u - c) / np.maximum(L, 1e-6))


# depth of the drawn folds against their nominal amplitudes (the normal maps are seen at 3-25 m through
# the mips and the temporal resolve: shallower folds vanish into a smooth shell)
RELIEF_GAIN = 1.45


class Relief:
    """Accumulates fold heights and crease darkness."""
    def __init__(self, n):
        self.h = np.zeros(n)
        self.c = np.zeros(n)

    def fold(self, d, w, amp, a_ref=0.003):
        """Adds one fold: signed distance d from its crest (m), half width w, amplitude amp (m, array: the
        envelope already applied)."""
        h, c = crest(d, w)
        self.h += RELIEF_GAIN * amp * h
        self.c += c * np.clip(amp / a_ref, 0, 1.4)

    def ridged(self, q, amp, seed):
        """Fine crinkles of worn cloth: ridged noise (sharp creases where the noise crosses zero) at points q
        (already scaled to the crinkles' size)."""
        r = 1.0 - np.abs(fbm(q, seed, 2))
        r = r ** 8
        self.h -= amp * r
        self.c += 0.15 * r * np.clip(amp / 0.0004, 0, 1.2)


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

def _limbs(P, J, side, names):
    """Limb frames of both sides (arrays over all points; zeros where a point is on the other side)."""
    n = len(P)
    t, phi, te, L = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
    for s, S in ((-1, 'L'), (1, 'R')):
        m = side == s
        if not m.any():
            continue
        a, b, c = (np.array(J[nm + S]) for nm in names)
        tt, pp, rr, tb, LL = limb_frame(P[m], a, b, c, np.array([-s, 0.0, 0.0]), np.array([0.0, 0.0, -1.0]))
        t[m], phi[m], te[m], L[m] = tt, pp, tb, LL
    return t, phi, te, L


def relief(P, ctx):
    """Fold height (m) and crease darkness at rest-pose garment points P (n, 3; three.js space: y up, the
    figure faces -z, its left at -x). ctx: J (joints), k (stature / 1.76), wa / wl (arm / leg membership
    0..1 per point), reg (region per point), kinds (top, bottom), female, hemTop (lowest y of the top),
    waistBot (top y of the bottom), seed.

    Every fold is its own: a crest line placed, tilted, sized and deepened by a deterministic draw, tapering
    out at both ends, with a sharp crease along each foot. Nothing repeats at a fixed period: worn cloth
    stacks and drapes irregularly (a jeans hem breaks into two to four Z-shaped folds a few cm apart, a tee
    falls from the armpits in fans of uneven folds)."""
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
    wob = fbm(Q * 7.0, seed + 1, 2)                          # crest lines wander a little (m, x scale)

    # ---- sleeves: bunching under the arm, the elbow's crook and its back, stacking above a long cuff, drape
    mA = (wa > 0.15) & is_top
    if mA.any():
        e = np.where(mA, np.clip(wa * 1.3, 0, 1), 0.0)
        at, aphi, ate, aL = _limbs(P, J, side, ('arm', 'fore', 'hand'))
        for s, S in ((-1, 'L'), (1, 'R')):
            ms = (side == s) & mA
            if not ms.any():
                continue
            es = np.where(ms, e, 0.0)
            D = Draw(seed, 'sleeve' + S)
            # under the arm: folds a few cm apart across the underside, tilted, each its own length round
            tj = 0.02 * k
            for j in range(D.n(4, 6)):
                tj += D.u(0.018, 0.04) * k
                pc, W = D.u(-0.5, 0.5), D.u(0.9, 2.2)
                tilt = D.u(-0.025, 0.025) * k
                dd = at - (tj + tilt * np.sin(aphi - pc) + 0.006 * k * wob)
                env = es * taper(wrap(aphi - pc), 0.0, W) * ss(0.22 * k, 0.05 * k, at)
                R.fold(dd, D.u(0.007, 0.014) * k, D.u(0.0014, 0.0032) * heavy * env)
            # the elbow's crook: short curved folds on the front and inner side, V-tilted, and a few behind
            for j in range(D.n(3, 4)):
                tj = ate + D.u(-0.07, 0.06) * k
                pc, W = D.u(0.4, 1.4), D.u(0.7, 1.5)
                v = D.sgn() * D.u(0.008, 0.02) * k
                dd = at - (tj + v * np.abs(wrap(aphi - pc)) + 0.005 * k * wob)
                env = es * taper(wrap(aphi - pc), 0.0, W)
                R.fold(dd, D.u(0.006, 0.011) * k, D.u(0.0015, 0.003) * heavy * env)
            for j in range(D.n(1, 2)):
                tj = ate + D.u(-0.03, 0.03) * k
                pc = np.pi + D.u(-0.6, 0.6)
                dd = at - (tj + D.u(-0.01, 0.01) * k * np.sin(aphi - pc))
                R.fold(dd, D.u(0.005, 0.009) * k, D.u(0.0008, 0.0016) * heavy * es * taper(wrap(aphi - pc), 0.0, D.u(0.6, 1.2)))
            # a long sleeve stacks above its cuff
            tj = 0.0
            for j in range(D.n(2, 3)):
                tj += D.u(0.025, 0.05) * k
                pc, W = D.u(-np.pi, np.pi), D.u(1.4, 2.8)
                dd = at - (aL - tj + D.sgn() * D.u(0.006, 0.016) * k * np.sin(aphi - pc))
                R.fold(dd, D.u(0.007, 0.012) * k, D.u(0.0014, 0.0026) * es * taper(wrap(aphi - pc), 0.0, W))
            # drape along the sleeve from the shoulder seam: long soft folds down the underside
            for j in range(D.n(2, 3)):
                pc = D.u(-1.0, 1.0)
                L0, L1 = D.u(0.02, 0.06) * k, D.u(0.1, 0.22) * k
                dd = wrap(aphi - (pc + D.u(-0.4, 0.4) * (at / (0.2 * k)))) * 0.045 * k
                R.fold(dd, D.u(0.008, 0.014) * k, D.u(0.0008, 0.0018) * es * taper(at, 0.5 * (L0 + L1), 0.5 * (L1 - L0)))

    # ---- torso
    zc = 0.5 * (J['spine2'][2] + J['pelvis'][2])
    th = np.arctan2(x, -(z - zc))                                # 0 front, +pi/2 the figure's right, +-pi back
    rt = np.maximum(np.hypot(x, z - zc), 0.08 * k)
    wt = np.clip(1 - wa - wl, 0, 1)
    yA = 0.5 * (J['armL'][1] + J['armR'][1]) - 0.085 * k         # armpit height
    yW = J['spine1'][1]                                          # waist
    yb = ctx['hemTop']
    mT = is_top & (wt > 0.05)
    if mT.any():
        e = np.where(mT, wt, 0.0)
        armside = 1.0 - 0.75 * ss(0.85, 0.98, np.abs(np.sin(th)))   # (little where the arms hang)
        # fans from each armpit, down the side and round onto the front and the back (tension of a
        # garment hanging from the shoulders): every fold its own angle, curve, length and depth
        for s, S in ((-1, 'L'), (1, 'R')):
            D = Draw(seed, 'fan' + S)
            dy = yA - y
            dth = wrap(th - s * np.pi / 2)
            dh = -s * dth * rt                                     # + towards the front (m)
            rq = np.hypot(dy, dh)
            fan = np.arctan2(dh, np.maximum(dy, 1e-4))             # 0 straight down
            m = ((side == s) | (np.abs(dth) < 1.3)) & (dy > -0.03 * k)
            for j in range(D.n(5, 8)):
                fj = D.u(-1.25, 1.25)
                bend = D.u(-0.35, 0.35)
                r0, r1 = D.u(0.025, 0.06) * k, D.u(0.11, 0.3) * k
                dd = wrap(fan - (fj + bend * (rq / (0.2 * k)))) * rq + 0.006 * k * wob
                env = e * m * taper(rq, 0.5 * (r0 + r1), 0.5 * (r1 - r0))
                R.fold(dd, D.u(0.008, 0.016) * k, D.u(0.0014, 0.0032) * heavy * env)
        # round the waist above an untucked hem (more at the sides and the back), or bloused over the
        # waistband of a tucked top: short, wavy, partial folds
        D = Draw(seed, 'waist')
        band = (0.16 if top_kind in ('shirt', 'blouse') else 0.13) * k
        for j in range(D.n(6, 9)):
            tc = D.u(-np.pi, np.pi)
            W = D.u(0.4, 1.2)
            yj = yb + D.u(0.02, 1.0) * band
            dd = y - (yj + D.u(-0.012, 0.012) * k * np.sin(th * D.u(2, 5) + D.u(0, 6.3)) + D.u(-0.03, 0.03) * k * wrap(th - tc) + 0.006 * k * wob)
            env = e * taper(wrap(th - tc), 0.0, W) * (0.6 + 0.4 * np.abs(np.sin(th))) * armside
            R.fold(dd, D.u(0.008, 0.016) * k, D.u(0.0015, 0.0034) * heavy * env)
        # the small of the back: the cloth gathers above the waist
        for j in range(D.n(2, 3)):
            tc = np.pi + D.u(-0.5, 0.5)
            dd = y - (yW + D.u(-0.06, 0.1) * k + D.u(-0.015, 0.015) * k * wrap(th - tc))
            R.fold(dd, D.u(0.007, 0.012) * k, D.u(0.001, 0.0022) * e * taper(wrap(th - tc), 0.0, D.u(0.4, 0.9)))
        # loose drape falling from the chest and the shoulder blades towards the hem: long, gently
        # curving folds that start and end at their own heights
        D = Draw(seed, 'drape')
        for j in range(D.n(9, 13)):
            tc = D.u(-np.pi, np.pi)
            if abs(np.sin(tc)) > 0.85:
                continue
            ya, yz = yb + D.u(0.0, 0.08) * k, yA - D.u(0.03, 0.15) * k
            bend = D.u(-0.6, 0.6)
            dd = wrap(th - (tc + bend * (y - yz) / max(0.1, yA - yb))) * rt + 0.006 * k * wob
            env = e * taper(y, 0.5 * (ya + yz), max(0.03 * k, 0.5 * (yz - ya))) * armside
            # (deeper towards the hem, where the cloth hangs free)
            R.fold(dd, D.u(0.012, 0.024) * k, D.u(0.0008, 0.0022) * env * (0.6 + 0.6 * ss(yz, ya, y)))
        if ctx['female'] and top_kind != 'jacket':
            # under the bust the cloth falls from its apex in a few folds fanning down and out (they start a
            # few cm below the apex: no point where all of them meet)
            for s in (-1, 1):
                D = Draw(seed, 'bust%d' % s)
                bx, by = s * 0.085 * k, yA - 0.07 * k
                dyb = by - y
                dxb = (x - bx) * s
                front = ss(0.8, 0.3, np.abs(th))
                ang = np.arctan2(dxb, np.maximum(dyb, 1e-4))
                rb = np.hypot(dxb, dyb)
                for j in range(D.n(2, 4)):
                    aj = D.u(-0.15, 0.95)
                    r0, r1 = D.u(0.035, 0.06) * k, D.u(0.1, 0.2) * k
                    dd = wrap(ang - aj) * rb
                    env = e * front * (dyb > 0) * taper(rb, 0.5 * (r0 + r1), 0.5 * (r1 - r0)) * (side * s > -0.3)
                    R.fold(dd, D.u(0.007, 0.012) * k, D.u(0.0008, 0.0016) * env)
        # the neckline and shoulders: a few small creases
        D = Draw(seed, 'neck')
        for j in range(D.n(4, 7)):
            tc = D.u(-np.pi, np.pi)
            dd = wrap(th - tc) * rt
            R.fold(dd, D.u(0.004, 0.008) * k, D.u(0.0003, 0.0008) * e * ss(yA + 0.1 * k, yA + 0.2 * k, y) * taper(y, yA + 0.2 * k, 0.07 * k))
        if top_kind == 'jacket':
            # a jacket's front: diagonal folds from the button at the waist up towards the shoulders
            D = Draw(seed, 'jacket')
            for j in range(D.n(3, 5)):
                s = D.sgn()
                c = D.u(0.02, 0.12) * k
                dd = (s * x * 0.8 - (y - yW) * 0.6 - c)
                env = e * ss(1.2, 0.4, np.abs(th)) * ss(yA, yW + 0.05 * k, y) * ss(yW - 0.08 * k, yW, y) * (side * s > 0)
                R.fold(dd, D.u(0.008, 0.014) * k, D.u(0.0012, 0.0022) * env)

    # ---- legs (trousers, jeans, shorts, leggings)
    if is_bot.any() and bot_kind != 'skirt':
        lt, lphi, ltk, lL = _limbs(P, J, side, ('thigh', 'shin', 'foot'))
        e = np.where(is_bot, np.clip(wl * 1.4, 0, 1), 0.0)
        tight = 0.45 if bot_kind == 'leggings' else 1.0
        fr = np.sin(lphi)                                        # +1 front, -1 back
        yw = ctx['waistBot']
        for s, S in ((-1, 'L'), (1, 'R')):
            ms = (side == s) & is_bot
            if not ms.any():
                continue
            es = np.where(ms, e, 0.0)
            D = Draw(seed, 'leg' + S)
            # crotch whiskers: a fan of uneven folds from the crotch over the front of the upper thigh
            if bot_kind != 'leggings':
                cy = 0.5 * (J['thighL'][1] + J['thighR'][1]) - 0.08 * k
                dyc = cy - y
                dxc = np.abs(x)
                ang = np.arctan2(dxc, np.maximum(dyc, 1e-4))
                rc = np.hypot(dxc, dyc)
                for j in range(D.n(3, 5)):
                    aj = D.u(0.25, 1.35)
                    r0, r1 = D.u(0.03, 0.05) * k, D.u(0.09, 0.22) * k
                    dd = wrap(ang - (aj + D.u(-0.2, 0.2) * rc / (0.15 * k))) * rc + 0.005 * k * wob
                    env = es * ss(-0.1, 0.5, fr) * taper(rc, 0.5 * (r0 + r1), 0.5 * (r1 - r0))
                    R.fold(dd, D.u(0.006, 0.012) * k, D.u(0.0012, 0.0028) * env)
            # behind the knee: bunched folds across the back; over the knee's front a couple of faint ones
            for j in range(D.n(3, 5)):
                tj = ltk + D.u(-0.06, 0.05) * k
                pc, W = -np.pi / 2 + D.u(-0.5, 0.5), D.u(0.7, 1.5)
                dd = lt - (tj + D.u(-0.02, 0.02) * k * wrap(lphi - pc) + 0.005 * k * wob)
                R.fold(dd, D.u(0.006, 0.011) * k, D.u(0.0016, 0.0032) * tight * es * taper(wrap(lphi - pc), 0.0, W))
            for j in range(D.n(1, 2)):
                tj = ltk + D.u(-0.08, 0.02) * k
                pc = np.pi / 2 + D.u(-0.4, 0.4)
                dd = lt - (tj + D.sgn() * D.u(0.01, 0.025) * k * wrap(lphi - pc))
                R.fold(dd, D.u(0.006, 0.01) * k, D.u(0.0006, 0.0014) * tight * es * taper(wrap(lphi - pc), 0.0, D.u(0.5, 1.0)))
            # the break over the shoe (long bottoms): two to four Z-shaped folds a few cm apart, each
            # tilted the other way, some all round the leg, some only part way
            if bot_kind != 'shorts':
                tj = D.u(0.012, 0.03) * k
                tl = 1.0
                for j in range(D.n(2, 4)):
                    tj += D.u(0.022, 0.06) * k
                    tl = -tl
                    pc, W = D.u(-np.pi, np.pi), D.u(1.3, 2.9)
                    A = tl * D.u(0.008, 0.022) * k
                    dd = lt - (lL - tj + A * np.sin(lphi - pc) + 0.004 * k * wob)
                    env = es * taper(wrap(lphi - pc), 0.0, W)
                    R.fold(dd, D.u(0.007, 0.013) * k * (0.7 if bot_kind == 'leggings' else 1.0), D.u(0.002, 0.0042) * tight * env)
            # long folds down the shin and soft diagonals over the thigh
            if bot_kind not in ('shorts', 'leggings'):
                for j in range(D.n(3, 4)):
                    pc = D.u(-np.pi, np.pi)
                    tw = D.u(-0.5, 0.5)
                    t0, t1 = ltk + D.u(0.0, 0.08) * k, lL - D.u(0.06, 0.16) * k
                    dd = wrap(lphi - (pc + tw * (lt - ltk) / (0.3 * k))) * 0.055 * k + 0.004 * k * wob
                    R.fold(dd, D.u(0.008, 0.014) * k, D.u(0.0008, 0.0018) * es * taper(lt, 0.5 * (t0 + t1), np.maximum(0.03 * k, 0.5 * (t1 - t0))))
            if bot_kind != 'leggings':
                for j in range(D.n(3, 4)):
                    pc = D.u(-np.pi, np.pi)
                    t0, t1 = D.u(0.05, 0.12) * k, ltk - D.u(0.02, 0.1) * k
                    dd = wrap(lphi - (pc + D.u(0.4, 1.2) * D.sgn() * (lt - t0) / (0.3 * k))) * 0.07 * k
                    R.fold(dd, D.u(0.009, 0.016) * k, D.u(0.0007, 0.0016) * es * taper(lt, 0.5 * (t0 + t1), np.maximum(0.03 * k, 0.5 * (t1 - t0))))
            # shorts: the leg's hem stands off and creases up from it
            if bot_kind == 'shorts':
                for j in range(D.n(2, 3)):
                    pc = D.u(-np.pi, np.pi)
                    dd = wrap(lphi - pc) * 0.07 * k
                    tmax = np.where(ms, lt, 0).max()
                    R.fold(dd, D.u(0.008, 0.014) * k, D.u(0.001, 0.002) * es * taper(lt, tmax - 0.04 * k, 0.06 * k))
        # round the waistband and over the seat: a few small irregular gathers
        if bot_kind != 'leggings':
            D = Draw(seed, 'band')
            for j in range(D.n(4, 6)):
                tc = D.u(-np.pi, np.pi)
                dd = y - (yw - D.u(0.02, 0.09) * k + D.u(-0.012, 0.012) * k * wrap(th - tc))
                R.fold(dd, D.u(0.005, 0.009) * k, D.u(0.0006, 0.0014) * np.where(is_bot, 1.0, 0.0) * taper(wrap(th - tc), 0.0, D.u(0.4, 1.0)))

    # ---- skirts: folds widening and deepening towards the hem (uneven spacing and depth), finer ones between
    # them near the hem, small gathers under the waistband
    if is_bot.any() and bot_kind == 'skirt':
        yh = 0.5 * (J['thighL'][1] + J['thighR'][1])
        e = np.where(is_bot, 1.0, 0.0)
        down = np.clip((yh + 0.03 * k - y) / (0.5 * k), 0, 1.5)
        thp = np.arctan2(x, -(z - J['pelvis'][2]))
        rp = np.maximum(np.hypot(x, z - J['pelvis'][2]), 0.1 * k)
        D = Draw(seed, 'skirt')
        nf = D.n(8, 11)
        a0 = D.u(0, 2 * np.pi)
        for j in range(nf):
            tc = a0 + 2 * np.pi * (j + D.u(-0.3, 0.3)) / nf
            dd = wrap(thp - tc - D.u(-0.15, 0.15) * down) * rp
            R.fold(dd, D.u(0.35, 0.5) * 2 * np.pi * rp / nf, D.u(0.0025, 0.006) * e * ss(0.0, 0.7, down))
        for j in range(D.n(10, 16)):
            tc = D.u(-np.pi, np.pi)
            dd = wrap(thp - tc) * rp
            R.fold(dd, D.u(0.008, 0.016) * k, D.u(0.0006, 0.0014) * e * ss(0.35, 1.0, down) * taper(down, 1.0, D.u(0.3, 0.6)))
        yw = ctx['waistBot']
        for j in range(D.n(8, 12)):
            tc = D.u(-np.pi, np.pi)
            dd = wrap(thp - tc) * rp
            R.fold(dd, D.u(0.004, 0.008) * k, D.u(0.0004, 0.0009) * e * ss(yw - 0.07 * k, yw - 0.01 * k, y))

    # ---- every garment: a little unevenness of the cloth and the fine crinkles of worn cotton (ridged noise
    # stretched along the cloth's hang; jackets and leggings smoother)
    cl = np.where(is_top | is_bot, 1.0, 0.0)
    R.h += 0.0009 * fbm(Q * 6.0, seed + 9, 3) * cl
    crink = 0.0002 if top_kind == 'jacket' or bot_kind == 'leggings' else 0.00035
    R.ridged(Q * np.array([42.0, 13.0, 42.0]), crink * cl * np.where(is_bot & (bot_kind == 'leggings'), 0.5, 1.0), seed + 21)
    return R.h, np.clip(R.c, 0, 1)


# ----------------------------------------------------------------------------- geometric drape

def _bulge(d, w):
    """A broad fold standing off the body: a rounded ridge of half width w (0 outside), its flanks easing
    into the cloth that lies on the body."""
    x = np.abs(d) / np.maximum(w, 1e-6)
    return np.clip(1.0 - x * x, 0.0, None) ** 1.6


DRAPE_GAIN = 1.6


def drape(P, ctx):
    """Outward offset (m, >= 0) of rest-pose garment points P (n, 3; three.js space) for the garments' own
    geometry: the broad folds a worn garment stands off the body in, which the normal maps alone cannot
    show (silhouettes, ridges catching the light, shade in the valleys). Folds 5 cm wide and more only
    (the meshes carry about a centimetre between vertices); the finer creases stay in relief(). Every fold
    is drawn on its own (place, width, depth, where it starts and dies out), so nothing repeats at a fixed
    spacing. ctx as for relief(), plus tuck (the top is tucked into its bottom) and long (the bottom
    reaches the ankle)."""
    J, k = ctx['J'], ctx['k']
    n = len(P)
    h = np.zeros(n)
    wa, wl, reg = ctx['wa'], ctx['wl'], ctx['reg']
    top_kind, bot_kind = ctx['kinds']
    seed = ctx['seed']
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    side = np.where(x < 0, -1.0, 1.0)
    is_top = (reg == REG_TOP) | (reg == REG_TOP2)
    is_bot = reg == REG_BOTTOM
    heavy = 0.6 if top_kind == 'jacket' else 1.0
    Q = P / k
    wob = fbm(Q * 4.0, seed + 31, 2)

    # ---- tops: the torso's cloth falls in broad folds from the chest and shoulder blades, deepening
    # towards an untucked hem (or bunching above the waistband of a tucked one); fans of drape from the
    # armpits; the hem itself stands off and waves unevenly
    zc = 0.5 * (J['spine2'][2] + J['pelvis'][2])
    th = np.arctan2(x, -(z - zc))
    rt = np.maximum(np.hypot(x, z - zc), 0.08 * k)
    wt = np.clip(1 - wa - wl, 0, 1)
    yA = 0.5 * (J['armL'][1] + J['armR'][1]) - 0.085 * k
    yb = ctx['hemTop']
    yw = ctx['waistBot']
    mT = is_top & (wt > 0.05)
    if mT.any():
        e = np.where(mT, wt, 0.0)
        # (less where the arms hang, and next to nothing right beside them: an arm held against the side,
        # arms folded, would show through cloth standing off there)
        sides = (1.0 - 0.55 * np.abs(np.sin(th)) ** 3) * (1.0 - 0.85 * ss(0.8, 0.97, np.abs(np.sin(th))))
        D = Draw(seed, 'gdrape')
        if ctx.get('tuck'):
            # tucked: the cloth blouses over the waistband in short soft folds, a few long ones above
            for j in range(D.n(6, 9)):
                tc = D.u(-np.pi, np.pi)
                dd = wrap(th - tc) * rt + 0.01 * k * wob
                h += D.u(0.002, 0.005) * heavy * e * sides * _bulge(dd, D.u(0.025, 0.045) * k) \
                    * taper(y, yw + D.u(0.03, 0.07) * k, D.u(0.04, 0.08) * k) * ss(yw - 0.02 * k, yw + 0.01 * k, y)
            for j in range(D.n(4, 6)):
                tc = D.u(-np.pi, np.pi)
                y1 = yA - D.u(0.05, 0.12) * k
                dd = wrap(th - tc - D.u(-0.3, 0.3) * (y1 - y) / (0.3 * k)) * rt + 0.01 * k * wob
                h += D.u(0.0015, 0.0035) * heavy * e * sides * _bulge(dd, D.u(0.03, 0.05) * k) * taper(y, 0.5 * (y1 + yw), 0.5 * (y1 - yw))
        else:
            down = np.clip((yA - 0.04 * k - y) / np.maximum(0.05, yA - 0.04 * k - yb), 0, 1)
            nf = D.n(7, 10) if top_kind != 'jacket' else D.n(5, 7)
            a0 = D.u(0, 2 * np.pi)
            for j in range(nf):
                tc = a0 + 2 * np.pi * (j + D.u(-0.35, 0.35)) / nf
                y1 = yA - D.u(0.03, 0.14) * k
                dd = wrap(th - tc - D.u(-0.35, 0.35) * (y1 - y) / max(0.1, y1 - yb)) * rt + 0.012 * k * wob
                env = e * sides * ss(y1, y1 - 0.12 * k, y) * (0.35 + 0.65 * down ** 1.2)
                h += D.u(0.003, 0.0095) * heavy * env * _bulge(dd, D.u(0.03, 0.055) * k)
            # the hem stands off the body and waves unevenly (never a ruled circle)
            env = e * ss(yb + 0.07 * k, yb, y) * sides
            wv = 0.5 + 0.5 * np.sin(th * D.u(2.5, 3.5) + D.u(0, 6.3)) * np.sin(th * D.u(5.5, 7.5) + D.u(0, 6.3))
            h += env * (0.0015 + 0.0035 * wv)
        # drape fans from the armpits, down the side and round onto the front and back
        for s, S in ((-1, 'L'), (1, 'R')):
            D = Draw(seed, 'gfan' + S)
            dy = yA - y
            dth = wrap(th - s * np.pi / 2)
            dh = -s * dth * rt
            rq = np.hypot(dy, dh)
            fan = np.arctan2(dh, np.maximum(dy, 1e-4))
            far = 1.0 - 0.8 * ss(0.85, 0.98, np.abs(np.sin(th)))
            for j in range(D.n(2, 3)):
                fj = D.u(-1.1, 1.1)
                r0, r1 = D.u(0.04, 0.07) * k, D.u(0.16, 0.3) * k
                dd = wrap(fan - fj - D.u(-0.3, 0.3) * rq / (0.2 * k)) * rq
                h += D.u(0.002, 0.004) * heavy * e * far * (dy > -0.02 * k) * _bulge(dd, D.u(0.025, 0.04) * k) \
                    * taper(rq, 0.5 * (r0 + r1), 0.5 * (r1 - r0))
        if ctx['female'] and top_kind != 'jacket':
            # under the bust the cloth falls from its apex: a few soft folds down and out (starting below it)
            for s in (-1, 1):
                D = Draw(seed, 'gbust%d' % s)
                bx, by = s * 0.085 * k, yA - 0.07 * k
                dyb = by - y
                dxb = (x - bx) * s
                front = ss(0.8, 0.3, np.abs(th))
                ang = np.arctan2(dxb, np.maximum(dyb, 1e-4))
                rb = np.hypot(dxb, dyb)
                for j in range(D.n(1, 2)):
                    aj = D.u(-0.5, 0.7)
                    r0, r1 = D.u(0.04, 0.07) * k, D.u(0.12, 0.2) * k
                    h += D.u(0.0015, 0.003) * e * front * (dyb > 0) * (side * s > -0.3) * _bulge(wrap(ang - aj) * rb, D.u(0.025, 0.035) * k) \
                        * taper(rb, 0.5 * (r0 + r1), 0.5 * (r1 - r0))

    # ---- sleeves: folds bunching under the arm near the armpit, the crook of a long sleeve's elbow and its
    # stack above the cuff; a short sleeve's opening stands off the arm a little, unevenly (no puff)
    mA = (wa > 0.15) & is_top
    if mA.any():
        e = np.where(mA, wa, 0.0)
        for s, S in ((-1, 'L'), (1, 'R')):
            m = (side == s) & mA
            if not m.any():
                continue
            a, b, c = (np.array(J[nm + S]) for nm in ('arm', 'fore', 'hand'))
            t, phi, r, tb, L = limb_frame(P[m], a, b, c, np.array([-s, 0.0, 0.0]), np.array([0.0, 0.0, -1.0]))
            D = Draw(seed, 'gsleeve' + S)
            em = e[m]
            hh = np.zeros(len(t))
            tj = 0.03 * k
            for j in range(D.n(2, 3)):
                tj += D.u(0.03, 0.06) * k
                pc, W = D.u(-0.6, 0.6), D.u(1.0, 2.2)
                dd = t - (tj + D.u(-0.02, 0.02) * k * np.sin(phi - pc))
                hh += D.u(0.0015, 0.0035) * heavy * em * _bulge(dd, D.u(0.022, 0.032) * k) * taper(wrap(phi - pc), 0.0, W)
            tmax = t.max()
            if tmax > tb + 0.08 * k:
                for j in range(D.n(2, 3)):
                    tj = tb + D.u(-0.06, 0.05) * k
                    pc, W = D.u(0.3, 1.4), D.u(0.8, 1.6)
                    dd = t - (tj + D.sgn() * D.u(0.01, 0.025) * k * np.abs(wrap(phi - pc)))
                    hh += D.u(0.0018, 0.0035) * heavy * em * _bulge(dd, D.u(0.022, 0.03) * k) * taper(wrap(phi - pc), 0.0, W)
                tj = 0.0
                for j in range(D.n(1, 2)):
                    tj += D.u(0.03, 0.06) * k
                    pc = D.u(-np.pi, np.pi)
                    dd = t - (tmax - tj + D.u(-0.015, 0.015) * k * np.sin(phi - pc))
                    hh += D.u(0.0015, 0.003) * em * _bulge(dd, D.u(0.022, 0.03) * k) * taper(wrap(phi - pc), 0.0, D.u(1.5, 2.9))
            else:
                # (the opening a little off the arm, more on the outer side and unevenly round it)
                inner = (1 + np.cos(phi)) * 0.5
                hh += em * ss(tmax - 0.05 * k, tmax, t) * (0.001 + 0.0018 * (1 - inner)) * (0.6 + 0.4 * np.sin(phi * 2 + D.u(0, 6.3)))
            h[m] += hh

    # ---- trousers, jeans, shorts (leggings stay smooth): bunching behind the knee, the break over the shoe
    # (two or three broad Z-tilted folds), a soft fold or two down the shin, a shorts' leg standing off the
    # thigh towards its hem
    if is_bot.any() and bot_kind not in ('skirt', 'leggings'):
        for s, S in ((-1, 'L'), (1, 'R')):
            m = (side == s) & is_bot & (wl > 0.3)
            if not m.any():
                continue
            a, b, c = (np.array(J[nm + S]) for nm in ('thigh', 'shin', 'foot'))
            t, phi, r, tk, L = limb_frame(P[m], a, b, c, np.array([-s, 0.0, 0.0]), np.array([0.0, 0.0, -1.0]))
            D = Draw(seed, 'gleg' + S)
            el = np.clip(wl[m] * 1.4, 0, 1)
            # (never at the waistband: it lies under the top's hem)
            el *= ss(yw - 0.06 * k, yw - 0.14 * k, y[m])
            hh = np.zeros(len(t))
            for j in range(D.n(2, 3)):
                tj = tk + D.u(-0.05, 0.04) * k
                pc, W = -np.pi / 2 + D.u(-0.5, 0.5), D.u(0.8, 1.6)
                dd = t - (tj + D.u(-0.02, 0.02) * k * wrap(phi - pc))
                hh += D.u(0.0018, 0.0035) * el * _bulge(dd, D.u(0.022, 0.03) * k) * taper(wrap(phi - pc), 0.0, W)
            tmax = t.max()
            if ctx.get('long'):
                tj, tl = D.u(0.01, 0.025) * k, 1.0
                for j in range(D.n(2, 3)):
                    tj += D.u(0.035, 0.065) * k
                    tl = -tl
                    pc, W = D.u(-np.pi, np.pi), D.u(1.4, 2.9)
                    dd = t - (tmax - tj + tl * D.u(0.01, 0.025) * k * np.sin(phi - pc))
                    hh += D.u(0.0025, 0.005) * el * _bulge(dd, D.u(0.022, 0.032) * k) * taper(wrap(phi - pc), 0.0, W)
            for j in range(D.n(1, 2)):
                pc = D.u(-np.pi, np.pi)
                t0, t1 = D.u(0.05, 0.15) * k, tmax - D.u(0.08, 0.2) * k
                dd = wrap(phi - pc - D.u(-0.5, 0.5) * (t - t0) / (0.4 * k)) * 0.06 * k
                hh += D.u(0.0015, 0.003) * el * _bulge(dd, D.u(0.025, 0.035) * k) * taper(t, 0.5 * (t0 + t1), max(0.04 * k, 0.5 * (t1 - t0)))
            if bot_kind == 'shorts' or tmax < tk + 0.05 * k:
                hem = ss(tmax - 0.18 * k, tmax, t)
                hh += el * hem * (0.004 + 0.007 * hem) * (0.75 + 0.25 * np.sin(phi * 2 + D.u(0, 6.3)))
            h[m] += hh
    # (deep enough to read at the distances people are seen from the cab: 5-25 m with a long lens)
    return h * DRAPE_GAIN


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
