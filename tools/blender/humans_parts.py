"""Accessory parts for the crowd figures: hair styles, head scarf, beards, hats, bags.

Each part is a signed distance field placed on a base body (head parts in head-local
coordinates: origin at eye level, facing -Z, scaled with the head), meshed and decimated
like the body, then merged into the base's LOD meshes with a part id. At runtime a figure
enables at most one hair style, beard, hat and bag (look row), the rest are collapsed.

Hair is modelled as a volume: an envelope (the cranium pushed out by the hair's thickness,
and for longer styles the column of hair falling from the head) minus the body, so it
always covers the skull and lies on the neck, shoulders and back instead of floating or
cutting into them. Long hair, ponytails and curls carry clump grooves along the fall
direction and ragged ends.
"""
import numpy as np
import humans_sdf as S
from humans_sdf import Ellipsoid, RoundCone, Loft, RoundBox, Union, Subtract, Intersect, Fn, Xform, rot_xyz, normalize
from humans_body import REGION, TEMPLATES, YOUNG, sstep, cranium, arm_joints, surface_z

PART_IDS = {
    'hair_short': 1, 'hair_buzz': 2, 'hair_medium': 3, 'hair_curly': 4, 'hair_balding': 5,
    'hair_long': 6, 'hair_ponytail': 7, 'hair_bun': 8, 'hair_bob': 9, 'hair_pixie': 10, 'scarf': 11,
    'beard_full': 12, 'beard_short': 13, 'cap': 14, 'fedora': 15, 'sunhat': 16,
    'backpack': 17, 'shoulderbag': 18, 'shopping': 19, 'hair_side': 20, 'hair_receding': 21, 'glasses': 22,
    'hair_curlyf': 23, 'hair_wisp': 24,
}
# hat crowns stand this far off the cranium (head-local m); the runtime presses hair under
# them (material.js) and the build checks the result (humans_build.check_hats)
HAT_OFFSETS = {'cap': 0.016, 'sunhat': 0.020}
HAT_BANDS = {'cap': 0.042, 'sunhat': 0.040, 'fedora': 0.036}
CAP_BACK_DROP = 0.034     # a cap sits lower at the back (down to the occiput); material.js matches


def hat_band(name, P):
    """Head-local height of a hat's lower edge at each point (caps slope down towards the back)."""
    if name == 'cap':
        return HAT_BANDS['cap'] - CAP_BACK_DROP * sstep(-0.02, 0.09, P[:, 2])
    return np.full(len(P), HAT_BANDS[name])


PER_BASE = {
    'male': ['hair_short', 'hair_buzz', 'hair_medium', 'hair_curly', 'hair_balding', 'hair_side', 'hair_receding',
             'beard_full', 'beard_short',
             'cap', 'fedora', 'sunhat', 'backpack', 'shoulderbag', 'shopping', 'glasses'],
    'female': ['hair_long', 'hair_ponytail', 'hair_bun', 'hair_bob', 'hair_pixie', 'hair_curlyf', 'scarf', 'sunhat', 'cap',
               'backpack', 'shoulderbag', 'shopping', 'glasses'],
    'child': ['hair_short', 'hair_curly', 'hair_long', 'hair_ponytail', 'hair_bob', 'cap', 'backpack'],
    'kid': ['hair_short', 'hair_curly', 'hair_long', 'hair_ponytail', 'hair_bob', 'cap', 'backpack'],
    # toddlers (in strollers): fine short hair, curls, a little bob, wispy baby hair; a cotton sun hat
    'toddler': ['hair_short', 'hair_curly', 'hair_bob', 'hair_wisp', 'sunhat'],
}
LONG_STYLES = ('hair_long', 'hair_bob', 'scarf', 'hair_ponytail', 'hair_curlyf')
# triangles per LOD; 0 = the part is dropped at that LOD (too small to matter on screen)
LOD_TRIS = {'hair': (1500, 600, 200, 50, 16), 'long': (3200, 1100, 340, 90, 30), 'beard': (900, 320, 110, 24, 0),
            'hat': (1200, 450, 150, 40, 16), 'bag': (700, 260, 90, 24, 12), 'pack': (2400, 700, 170, 44, 14),
            'glasses': (900, 260, 70, 0, 0)}

# hairline (head-local y at the front / temples) of the men's and boys' short styles: a forehead
# of ~5 cm above the brows. The runtime paints the soft edge with the same numbers (material.js)
MALE_FRONT, MALE_TEMPLE = 0.066, 0.046

# cranium of the head sculpt the parts are being built for (humans_body.cranium; set per base)
CR_C, CR_R = cranium('male')
SH_Y = -0.20          # head-local height of the shoulder joints of the base being built


def set_cranium(face, sh_y=None):
    global CR_C, CR_R, SH_Y
    CR_C, CR_R = cranium(face)
    if sh_y is not None:
        SH_Y = sh_y


def _theta(P):
    """Azimuth around the head: 0 = front (-Z), +-pi/2 = sides, pi = back."""
    return np.arctan2(np.abs(P[:, 0]), -(P[:, 2] - 0.0))


def hairline(P, front=0.058, temple=0.036, side=0.022, burn=-0.014, back=-0.064, burn_w=1.0):
    """Height of the hairline (head-local y) as a function of azimuth, smooth around the head."""
    th = _theta(P)
    ks = np.array([0.0, 0.55, 1.05, 1.33, 1.58, 1.95, 2.5, np.pi])
    vs = np.array([front, temple, side, burn * burn_w + side * (1 - burn_w), 0.028, -0.030, back * 0.9, back])
    return np.interp(th, ks, vs)


def clump_noise(P, seed, freq=110.0, n=7):
    """Irregular smooth bumps (sum of randomly oriented waves), about [-1, 1]."""
    rng = np.random.default_rng(seed)
    acc = np.zeros(len(P))
    for _ in range(n):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        f = freq * rng.uniform(0.6, 1.4)
        acc += np.sin(P @ d * f + rng.uniform(0, 6.3))
    return acc / np.sqrt(n) * 0.7


def strand_noise(P, seed, freq=150.0, n=8, along=0.12):
    """Clump grooves running down the hair (waves across the fall direction, slow along it)."""
    rng = np.random.default_rng(seed)
    acc = np.zeros(len(P))
    for _ in range(n):
        a = rng.uniform(0, 2 * np.pi)
        d = np.array([np.cos(a), rng.uniform(-along, along), np.sin(a)])
        d /= np.linalg.norm(d)
        f = freq * rng.uniform(0.6, 1.5)
        acc += np.sin(P @ d * f + rng.uniform(0, 6.3))
    return acc / np.sqrt(n) * 0.7


def cranium_offset(off_fn):
    """Field of the cranium ellipsoid pushed out by a position-dependent offset (metres)."""
    cr = Ellipsoid(CR_C, CR_R)

    def f(P):
        return cr.eval(P) - off_fn(P)
    lo = CR_C - CR_R - 0.06
    hi = CR_C + CR_R + 0.06
    return Fn(f, lo, hi)


def ears_cut():
    ex = CR_R[0] + 0.0015
    return Union([Ellipsoid((s * ex, -0.010, 0.012), (0.016, 0.034, 0.024)) for s in (-1, 1)])


def cap_hair(thick_top, thick_side, region, front=0.058, temple=0.036, burn=-0.014, back=-0.064, fade=0.012,
             noise=0.0, seed=1, burn_w=1.0, thick_back=None, ragged=0.0):
    tb = thick_side if thick_back is None else thick_back

    def hl(P):
        # (ragged: the edge of the hair breaks up into small locks instead of a cut line)
        h = hairline(P, front, temple, 0.022, burn, back, burn_w)
        if ragged:
            h = h + ragged * clump_noise(P * np.array([1.0, 0.25, 1.0]), seed + 9, 170.0, 6)
        return h

    def off(P):
        u = np.clip((P[:, 1] + 0.02) / 0.11, 0, 1)
        # the back of the head carries more hair than the sides above the ears (occipital volume)
        ws = thick_side + (tb - thick_side) * sstep(0.01, 0.07, P[:, 2] - CR_C[2]) * sstep(-0.075, -0.03, P[:, 1])
        t = ws + (thick_top - ws) * u
        h = hl(P)
        t = t * (0.08 + 0.92 * sstep(h, h + fade, P[:, 1])) + 0.0010
        if noise:
            t = t + noise * clump_noise(P, seed) * sstep(h, h + fade, P[:, 1])
        return t
    shell = cranium_offset(off)

    def region_fn(P):
        return hl(P) - P[:, 1]
    reg = Fn(region_fn, shell.lo, shell.hi)
    hair = Intersect(shell, reg, k=0.004)
    hair = Subtract(hair, ears_cut(), k=0.006)
    hair.region = region
    return hair


def _tag(node, region, bones):
    for l in node.leaves():
        l.region = region
        if not l.bones:
            l.bones = bones
    return node


def local_body(body, hs, hc):
    """The body field in head-local coordinates (to rest long hair on the neck and back)."""
    hc = np.asarray(hc, dtype=np.float64)

    def f(P):
        return body.eval((P * hs + hc).astype(np.float32)) / hs
    return Fn(f, (body.lo - hc) / hs, (body.hi - hc) / hs)


def falling_hair(bl, length, width, thick, top, seed, wave=0.0, front_z=-0.004, spread=0.03, ends='U', sh_y=None):
    """Long hair below the crown: the column of hair that falls from the head over the nape and
    down the back to `length` (head-local y of the ends at the back), minus the body.
    width: half width at the ears; spread: extra half width where it falls on the upper back.
    Below the shoulder line (sh_y, head-local) the hair hangs behind the shoulders (on the back
    over the shoulder blades), never over the deltoids, so arms reaching forward stay clear of it.
    The returned node carries .tip(P): height above the ragged ends (for the alpha taper)."""
    L = -length
    yh = CR_C[1] - 0.02
    # (real thickness: ~2.5-3 cm of hair at the sides of the head, a full column down the back)
    keys = [(0.0, CR_R[0] + top * 0.8, CR_R[2] + top, 0, 0.0),
            (0.30, width, CR_R[2] * 0.82 + thick, 0, 0.012),
            (0.55, width + spread * 0.7, CR_R[2] * 0.68 + thick, 0, 0.024),
            (0.8, width + spread, CR_R[2] * 0.60 + thick * 0.9, 0, 0.034),
            (1.0, width + spread * 0.85, CR_R[2] * 0.54 + thick * 0.75, 0, 0.038)]
    # (Loft frame: x = +X, y = down, z = forward; keys' oz moves the column backwards)
    col = Loft((0, yh, CR_C[2]), (0, L, CR_C[2]), (1, 0, 0),
               [(t, rx, rz, 0, -oz) for t, rx, rz, _, oz in keys], n=2.4)
    head_env = cranium_offset(lambda P: top + 0.004 * sstep(0.0, 0.08, P[:, 1]))
    env = Union([head_env, col], k=0.03)
    shy = -0.20 if sh_y is None else sh_y

    def tipf(P):
        ax = np.abs(P[:, 0]) / max(width + spread, 1e-3)
        tip = L + (0.035 if ends == 'U' else 0.07) * ax ** 2 + 0.005 * clump_noise(P * np.array([1, 0.0, 1]), seed + 3, 70.0, 5)
        return P[:, 1] - tip

    def shape(P):
        d = env.eval(P)
        th = _theta(P)
        # clump grooves down the outside, stronger towards the ends; gentle waves for wavy hair
        dn = (0.0024 + 0.0022 * sstep(-0.05, -0.25, P[:, 1])) * strand_noise(P, seed)
        dw = wave * np.sin(P[:, 1] * 60.0 + 3.0 * np.sin(th * 3.0)) * sstep(-0.05, -0.2, P[:, 1])
        cut = -tipf(P)
        # keep in front of the ears clear of the curtain: the face and the cheeks
        fz = front_z + 0.03 * sstep(-0.02, -0.12, P[:, 1])
        front = fz - P[:, 2]
        # below the jaw the curtain goes back behind the shoulders (more so the further out it is)
        bz = 0.006 + 0.035 * sstep(0.06, 0.12, np.abs(P[:, 0]))
        behind = (bz - P[:, 2]) - 0.3 * (1.0 - sstep(shy + 0.10, shy + 0.02, P[:, 1]))
        return np.maximum(np.maximum(np.maximum(d - dn - dw, cut), front * (1.0 - sstep(0.03, 0.09, P[:, 1]))), behind)
    hair = Fn(shape, np.array([-0.2, -length - 0.05, -0.15]), np.array([0.2, 0.17, 0.2]))
    # minus the body inflated a little (hair lies on the skin and the clothes over it)
    hair = Subtract(hair, Fn(lambda P: bl.eval(P) - 0.006, bl.lo - 0.01, bl.hi + 0.01), k=0.006)
    hair.tip = tipf
    return hair


def face_clear(hair, kid=False):
    hair = Subtract(hair, Ellipsoid((0, -0.03, -0.085), (0.074, 0.090, 0.085)), k=0.01)
    return hair


def crown_volume(h):
    """A little lift at the crown behind the top of the head, with a cowlick whorl (short cuts)."""
    lift = Ellipsoid((0.0, CR_C[1] + CR_R[1] - 0.012, CR_C[2] + 0.030), (0.046, 0.010 + h, 0.048))
    whorl = Ellipsoid((0.014, CR_C[1] + CR_R[1] - 0.016, CR_C[2] + 0.050), (0.016, 0.006 + h * 0.6, 0.014),
                      R=rot_xyz(-30, 25, 0))
    return Union([lift, whorl], k=0.012)


def ribbon(path, width, thick, folds=0.0, seed=1, taper=0.25, tip_cut=0.6):
    """Flat band of cloth along a polyline `path` [(x, y, z)...]: `width` (half, m) across in x,
    `thick` (half) along the path's normal in the y-z plane; soft lengthwise folds (pleats) and a
    slanted cut end. Used for headscarf tails."""
    pts = np.asarray(path, dtype=np.float64)
    seg = pts[1:] - pts[:-1]
    segl = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0.0], np.cumsum(segl)])
    Ltot = cum[-1]
    lo = pts.min(0) - width - 0.03
    hi = pts.max(0) + width + 0.03

    def f(P):
        best = np.full(len(P), 1e9)
        for i in range(len(seg)):
            a = pts[i]
            d = seg[i] / segl[i]
            pa = P - a
            traw = pa @ d
            t = np.clip(traw, 0, segl[i])
            # normal of the band in the y-z plane (perpendicular to the segment)
            nyz = np.array([0.0, -d[2], d[1]])
            nyz /= max(np.linalg.norm(nyz), 1e-9)
            u = (cum[i] + t) / max(Ltot, 1e-6)
            ql = pa[:, 0] - d[0] * traw
            qn = pa @ nyz
            w = width * (1.0 - taper * u)
            # pleats: the cloth ripples across its width, more towards the end
            fold = folds * np.sin(ql / max(width, 1e-3) * 4.2 + seed) * (0.4 + 0.6 * u)
            e = np.maximum(np.maximum(-traw, traw - segl[i]), 0.0)
            dn = np.abs(qn - fold) - thick
            dl = np.abs(ql) - w
            out = np.sqrt(np.maximum(dn, 0) ** 2 + np.maximum(dl, 0) ** 2 + e ** 2) + np.minimum(np.maximum(dn, dl), 0)
            # slanted cut at the end of the last piece
            if i == len(seg) - 1:
                de = (cum[i] + traw) - (Ltot - tip_cut * width * (0.5 + 0.5 * ql / max(width, 1e-3)))
                out = np.maximum(out, de)
            best = np.minimum(best, out)
        return best - 0.0015
    return Fn(f, lo, hi)


def tichel(body_l):
    """Headscarf tied as a tichel: cloth over the whole head with ~2.5 cm of volume (gathered
    folds over the crown), the hair tucked in, a gathered knot / bun of fabric at the nape and
    two wide flat tails hanging from it down the back of the neck."""
    R = REGION['hair']
    base = cap_hair(0.024, 0.021, R, front=0.050, temple=0.042, burn=-0.004, back=-0.088, fade=0.006, burn_w=0.6,
                    thick_back=0.030, noise=0.0)
    # (cap_hair cuts round the ears; the scarf covers them: fill that back in)
    ears = Union([Ellipsoid((s * (CR_R[0] + 0.004), -0.010, 0.012), (0.018, 0.034, 0.026)) for s in (-1, 1)])
    base = Union([base, Intersect(ears, Fn(lambda P: hairline(P, 0.05, 0.042, 0.022, -0.004, -0.088, 0.6) - P[:, 1],
                                           (-0.2, -0.2, -0.2), (0.2, 0.2, 0.2)), k=0.004)], k=0.008)
    # gathered folds radiating over the crown towards the knot
    def folds(P):
        th = np.arctan2(P[:, 0], -(P[:, 2] - CR_C[2]))
        return 0.0028 * np.sin(th * 9.0 + 1.3 * np.sin(P[:, 1] * 40.0)) * sstep(-0.02, 0.06, P[:, 1])
    cap = Fn(lambda P: base.eval(P) - folds(P), base.lo - 0.01, base.hi + 0.01)
    zb = CR_C[2] + CR_R[2]
    # the knot sits low at the nape, gathered (twisted fabric), not a ball on the back of the head
    knot = Ellipsoid((0, -0.058, zb - 0.010), (0.044, 0.030, 0.028), R=rot_xyz(-20, 0, 0))
    knot2 = Ellipsoid((0.010, -0.040, zb - 0.006), (0.036, 0.024, 0.024), R=rot_xyz(-10, 0, 22))
    kn0 = Union([knot, knot2], k=0.012)
    kn = Fn(lambda P: kn0.eval(P) - 0.004 * clump_noise(P, 71, 120.0), kn0.lo - 0.01, kn0.hi + 0.01)
    tails = []
    for s, sd in ((-1, 3.0), (1, 5.0)):
        path = []
        for x, y, z in ((s * 0.014, -0.062, zb + 0.004), (s * 0.020, -0.105, zb), (s * 0.026, -0.150, zb),
                        (s * 0.032, -0.200, zb), (s * 0.036, -0.245, zb)):
            if body_l is not None and y < -0.07:
                # lying on the back of the neck and the upper back
                z = surface_z(body_l, x, y, +1, z0=0.0, zmax=0.3) + 0.010
            path.append((x, y, z))
        tails.append(ribbon(path, 0.034, 0.0045, folds=0.0065, seed=sd, taper=0.25))
    n = Union([cap, kn], k=0.012)
    n = Union([n] + tails, k=0.010)
    if body_l is not None:
        n = Subtract(n, Fn(lambda P: body_l.eval(P) - 0.004, body_l.lo, body_l.hi), k=0.006)
    return n


def hair_part(name, body_l=None):
    H = {'head': 1}
    R = REGION['hair']
    mf, mt = MALE_FRONT, MALE_TEMPLE
    if name == 'hair_short':
        # the front edge thins out over ~2 cm (no bowl-cut ledge); a little lift on top; volume at
        # the crown with a cowlick whorl; a full occiput tapering to a clipper-faded nape
        n = cap_hair(0.013, 0.0055, R, front=mf, temple=mt, noise=0.0016, fade=0.02, thick_back=0.009, back=-0.070, ragged=0.004)
        n = Union([n, Ellipsoid((0.006, 0.086, -0.040), (0.050, 0.019, 0.032))], k=0.018)
        n = Union([n, crown_volume(0.006)], k=0.02)
    elif name == 'hair_buzz':
        n = cap_hair(0.0045, 0.0032, R, front=mf, temple=mt, fade=0.006, thick_back=0.004, back=-0.068)
    elif name == 'hair_medium':
        n = cap_hair(0.019, 0.010, R, front=mf - 0.004, temple=mt - 0.003, noise=0.0025, seed=3, fade=0.02,
                     thick_back=0.015, back=-0.078)
        n = Union([n, Ellipsoid((0.012, 0.086, -0.048), (0.050, 0.024, 0.030))], k=0.02)
        n = Union([n, crown_volume(0.008)], k=0.02)
    elif name == 'hair_wisp':
        # a toddler's fine, sparse baby hair: a thin cap, a few millimetres, wispy at the edges
        n = cap_hair(0.0065, 0.004, R, front=0.064, temple=0.048, noise=0.0018, seed=61, fade=0.016,
                     thick_back=0.006, back=-0.062)
    elif name == 'hair_curly':
        # tight curls: an even, bumpy volume all round (children: a shorter crop)
        k = 0.65 if CR_R[0] > 0.076 else 1.0
        n = cap_hair(0.026 * k, 0.016 * k, R, front=mf - 0.004, temple=mt - 0.003, noise=0.006 * k, seed=7, fade=0.016,
                     thick_back=0.022 * k, back=-0.072)
    elif name == 'hair_side':
        # side parting: fuller top swept to one side, short back and sides
        n = cap_hair(0.016, 0.006, R, front=mf - 0.002, temple=mt, noise=0.0016, seed=13, fade=0.02,
                     thick_back=0.010, back=-0.070)
        sweep = Ellipsoid((0.022, 0.086, -0.032), (0.058, 0.022, 0.058), R=rot_xyz(0, 0, -12))
        n = Union([n, sweep, crown_volume(0.006)], k=0.02)
    elif name == 'hair_receding':
        n = cap_hair(0.010, 0.006, R, front=0.074, temple=0.066, noise=0.0012, seed=17, thick_back=0.008)
    elif name == 'hair_balding':
        # a horseshoe fringe over the ears and round the back; nothing in front of the temples
        base = cap_hair(0.007, 0.006, R, front=0.15, temple=0.13, fade=0.01, thick_back=0.008)
        crown = Ellipsoid((0, 0.115, -0.025), (0.075, 0.072, 0.095))
        n = Subtract(base, crown, k=0.02)
    elif name == 'hair_pixie':
        n = cap_hair(0.022, 0.012, R, front=0.052, noise=0.0035, seed=5, back=-0.070, thick_back=0.016)
    elif name == 'scarf':
        n = tichel(body_l)
    elif name == 'hair_curlyf':
        # a full head of curls falling to the shoulders: big, bumpy, rounded volume
        capn = cap_hair(0.032, 0.026, R, front=0.052, temple=0.040, back=-0.060, noise=0.007, seed=29, thick_back=0.034)
        fall = falling_hair(body_l, 0.215, CR_R[0] + 0.040, 0.034, 0.034, 31, spread=0.030, wave=0.0, sh_y=SH_Y)
        bumps = Fn(lambda P: fall.eval(P) - 0.006 * clump_noise(P, 37, 75.0), fall.lo, fall.hi)
        n = face_clear(Union([capn, bumps], k=0.02))
        n.tip = fall.tip
    else:
        # longer female styles share a fuller cap
        capn = cap_hair(0.021, 0.013, R, front=0.054, temple=0.040, back=-0.060, noise=0.002, seed=11, thick_back=0.020)
        if name == 'hair_long':
            # falls past the shoulders onto the shoulder blades, behind the shoulders
            fall = falling_hair(body_l, 0.36, CR_R[0] + 0.027, 0.030, 0.024, 41, spread=0.026, wave=0.0015, sh_y=SH_Y)
            n = face_clear(Union([capn, fall], k=0.02))
            n.tip = fall.tip
        elif name == 'hair_ponytail':
            # hair drawn back tight to a tie at the back of the crown; the tail hangs from it and
            # rests on the nape and upper back
            tz = CR_C[2] + CR_R[2]
            tie = Ellipsoid((0, -0.004, tz - 0.006), (0.020, 0.020, 0.016))
            path = [(0, -0.004, tz + 0.004), (0, -0.045, tz + 0.016), (0, -0.105, tz + 0.016), (0, -0.170, tz + 0.006),
                    (0, -0.235, tz - 0.008)]
            rad = [0.022, 0.031, 0.029, 0.022, 0.009]
            rope = Union([RoundCone(path[i], path[i + 1], rad[i], rad[i + 1]) for i in range(len(path) - 1)], k=0.02)
            tail = Fn(lambda P: rope.eval(P) - 0.003 * strand_noise(P, 43, 200.0, along=0.06), rope.lo - 0.01, rope.hi + 0.01)
            if body_l is not None:
                tail = Subtract(tail, Fn(lambda P: body_l.eval(P) - 0.004, body_l.lo, body_l.hi), k=0.008)
            n = Union([cap_hair(0.014, 0.008, R, front=0.054, temple=0.040, back=-0.058, noise=0.001, seed=11,
                                thick_back=0.012), tie, tail], k=0.012)
        elif name == 'hair_bun':
            knob = Ellipsoid((0, 0.045, CR_C[2] + CR_R[2] + 0.004), (0.040, 0.036, 0.034))
            bun = Fn(lambda P: knob.eval(P) - 0.003 * clump_noise(P, 47, 160.0), knob.lo - 0.01, knob.hi + 0.01)
            n = Union([cap_hair(0.016, 0.010, R, front=0.054, temple=0.040, back=-0.060, noise=0.0015, seed=11,
                                thick_back=0.014), bun], k=0.012)
        elif name == 'hair_bob':
            # chin length all round: falls from the crown to just above the shoulders
            fall = falling_hair(body_l, 0.105, CR_R[0] + 0.020, 0.022, 0.022, 53, spread=0.008, ends='U', sh_y=SH_Y)
            n = face_clear(Union([capn, fall], k=0.02))
            n = Subtract(n, Ellipsoid((0, -0.028, -0.095), (0.078, 0.092, 0.095)), k=0.008)
            n.tip = fall.tip
    return _tag(n, REGION['hair'], H)


def hair_bones(hc, hs, sh_y):
    """Skin weights of a hair part: the head, and below the jaw more and more the chest (long
    hair lying on the back follows the upper body rather than the head)."""
    def f(P):
        y = P[:, 1]
        w = sstep(hc[1] - 0.10 * hs, sh_y - 0.05 * hs, y)
        return {'head': w, 'neck': 0.0 * w, 'spine2': 1 - w}
    return f



def beard_part(name):
    H = {'head': 1}
    # (the male face of humans_body.head_sdf)
    face = Union([Ellipsoid((0, -0.022, -0.044), (0.061, 0.083, 0.051)),
                  RoundCone((0.057, -0.012, 0.012), (0.051, -0.068, 0.004), 0.014, 0.013),
                  RoundCone((-0.057, -0.012, 0.012), (-0.051, -0.068, 0.004), 0.014, 0.013),
                  RoundCone((0.051, -0.068, 0.004), (0.024, -0.099, -0.066), 0.013, 0.012),
                  RoundCone((-0.051, -0.068, 0.004), (-0.024, -0.099, -0.066), 0.013, 0.012),
                  Ellipsoid((0, -0.097, -0.0745), (0.023, 0.018, 0.020)),
                  Ellipsoid((0, -0.058, -0.070), (0.034, 0.030, 0.028))], k=0.02)
    full = name == 'beard_full'

    # region: cheek line from the sideburns down to the corners of the moustache
    def reg(P):
        th = _theta(P)
        top = np.interp(th, [0, 0.30, 0.55, 0.95, 1.30, 1.55], [-0.041, -0.044, -0.040, -0.024, -0.008, 0.012])
        return np.maximum(P[:, 1] - top, (th - 1.58) * 0.05)

    def taper(P):
        # the beard thins out over the last ~6 mm to its (ragged) edge: no hard ledge on the cheek
        return sstep(0.0, 0.006, -reg(P) + 0.0025 * clump_noise(P, 31, 260.0))

    def off(P):
        down = np.clip((-0.05 - P[:, 1]) / 0.07, 0, 1)
        base = (0.004 + 0.011 * down) if full else (0.0028 + 0.002 * down)
        return 0.0006 + (base + (0.0016 if full else 0.0005) * clump_noise(P, 21, 160.0)) * taper(P)
    shell = Fn(lambda P: face.eval(P) - off(P), face.lo - 0.05, face.hi + 0.05)
    if full:
        chin = Union([RoundCone((0, -0.098, -0.066), (0, -0.132, -0.062), 0.028, 0.022),
                      RoundCone((0, -0.132, -0.062), (0, -0.150, -0.056), 0.022, 0.012)], k=0.02)
        shell = Union([shell, chin], k=0.022)
    b = Intersect(shell, Fn(reg, (-0.2, -0.3, -0.2), (0.2, 0.2, 0.2)), k=0.003)
    mouth = Ellipsoid((0, -0.0605, -0.096), (0.020, 0.0055, 0.03))
    b = Subtract(b, mouth, k=0.003)
    b = _tag(b, REGION['beard'], H)
    b.edge = taper           # per-vertex edge fade for the shader (aux0)
    return b


def hat_part(name):
    H = {'head': 1}
    R = REGION['hat']
    if name == 'cap':
        # crown over the hair, a little taller than the head (a soft six-panel cap)
        co = HAT_OFFSETS['cap']
        crown = Fn(lambda P: Ellipsoid(CR_C + np.array([0, 0.004, 0]), CR_R + np.array([0, 0.004, 0])).eval(P) - co,
                   CR_C - CR_R - 0.04, CR_C + CR_R + 0.04)
        band = Fn(lambda P: hat_band('cap', P) - P[:, 1], (-0.2, -0.2, -0.2), (0.2, 0.3, 0.2))
        dome = Intersect(crown, band, k=0.004)
        brim = RoundBox((0, 0.040, -0.126), (0.062, 0.0025, 0.042), 0.002, R=rot_xyz(-8, 0, 0))
        brim = Intersect(brim, Ellipsoid((0, 0.04, -0.100), (0.088, 0.05, 0.078)), k=0.003)
        n = Union([dome, brim], k=0.006)
    elif name == 'fedora':
        crown = Loft((0, 0.035, 0.008), (0, 0.158, 0.012), (1, 0, 0),
                     [(0, 0.087, 0.104, 0, 0), (0.7, 0.082, 0.097, 0, 0), (1.0, 0.063, 0.078, 0, 0)], n=2.0, capr=0.4)
        dent = Ellipsoid((0, 0.165, 0.01), (0.03, 0.03, 0.065))
        crown = Subtract(crown, dent, k=0.012)
        # (the sides turn up a little; more reads as a cowboy hat edge-on)
        brim = Fn(lambda P: np.maximum(np.abs(P[:, 1] - 0.038 - 0.011 * (np.abs(P[:, 0]) / 0.16) ** 2) - 0.0038,
                                       np.sqrt((P[:, 0] / 0.155) ** 2 + ((P[:, 2] - 0.005) / 0.170) ** 2) * 0.155 - 0.155),
                  (-0.18, 0.0, -0.2), (0.18, 0.09, 0.2))
        n = Union([crown, brim], k=0.008)
    else:  # sunhat
        # straw sun hat: a rounded crown ~10 cm tall over the band, a brim that droops ~2.5 cm
        # over its 7-8 cm width
        so = HAT_OFFSETS['sunhat']
        crown = Loft((0, 0.030, 0.006), (0, 0.100, 0.006), (1, 0, 0),
                     [(0, 0.0745 + so, 0.098 + so, 0, 0), (0.6, 0.0725 + so, 0.095 + so, 0, 0),
                      (1.0, 0.080, 0.100, 0, 0)], n=2.0, capr=0.45)
        crown = Union([crown, Fn(lambda P: Ellipsoid(CR_C, CR_R).eval(P) - so, CR_C - CR_R - 0.04, CR_C + CR_R + 0.04)], k=0.01)
        crown = Intersect(crown, Fn(lambda P: 0.030 - P[:, 1], (-0.2, -0.2, -0.2), (0.2, 0.3, 0.2)), k=0.003)

        def brim_f(P):
            rr = np.hypot(P[:, 0] / 1.0, (P[:, 2] - 0.006) / 1.06)
            y0 = 0.040 - 0.33 * np.clip(rr - 0.092, 0, None) ** 1.15
            return np.maximum(np.abs(P[:, 1] - y0) - 0.0024, rr - 0.172)
        brim = Fn(brim_f, (-0.2, -0.04, -0.2), (0.2, 0.08, 0.2))
        n = Union([crown, brim], k=0.008)
    # solid: the head fills the inside, only the outer surface is ever seen
    return _tag(n, R, H)


def glasses_part():
    """Sunglasses: two slightly wrapped dark lenses in thin rims, a bridge arching over the
    nose and temples running back over the ears (head-local)."""
    H = {'head': 1}
    R = REGION['glasses']
    lz, ly, lx, a, b = -0.1000, -0.0010, 0.0330, 0.0240, 0.0180
    lenses, rims = [], []
    for s in (-1, 1):
        c = np.array([s * lx, ly, lz + 0.0015])
        Rr = rot_xyz(0, -s * 9, 0)
        lenses.append(Ellipsoid(c, (a, b, 0.0011), R=Rr, region=R, bones=H))

        def ring(P, c=c, Rr=Rr):
            q = (P - c) @ Rr
            e = (np.sqrt((q[:, 0] / a) ** 2 + (q[:, 1] / b) ** 2) - 1.0) * b
            return np.sqrt(e * e + q[:, 2] ** 2) - 0.00135
        rims.append(Fn(ring, c - 0.04, c + 0.04, region=R, bones=H))
    bridge = RoundCone((-0.0095, 0.0045, lz + 0.0005), (0.0095, 0.0045, lz + 0.0005), 0.0013, 0.0013, region=R, bones=H)
    bridge = Union([bridge, Ellipsoid((0, 0.0062, lz - 0.0012), (0.006, 0.0018, 0.0016), region=R, bones=H)], k=0.002)
    temples = []
    for s in (-1, 1):
        pts = [(s * 0.0570, 0.0050, lz + 0.0035), (s * 0.0715, 0.0045, -0.075), (s * 0.0770, 0.0030, -0.035),
               (s * 0.0790, 0.0000, 0.004), (s * 0.0770, -0.0080, 0.016)]
        for p0, p1 in zip(pts[:-1], pts[1:]):
            temples.append(RoundCone(p0, p1, 0.0012, 0.0012, region=R, bones=H))
    frame = Union(rims + [bridge] + temples, k=0.0012)
    n = Union([frame] + lenses, k=0.0008)
    n.lens = Union(lenses)
    n.frame = frame
    return n




def strap(pts, nrm, width, thick, bones, region):
    """Flat strap along a polyline: half width across (perpendicular to the path and to the
    surface normal at each point), half thickness along the normal; rounded edges."""
    P0 = np.asarray(pts, dtype=np.float64)
    N0 = np.asarray(nrm, dtype=np.float64)
    seg = P0[1:] - P0[:-1]
    segl = np.linalg.norm(seg, axis=1)
    lo = P0.min(0) - width - 0.02
    hi = P0.max(0) + width + 0.02

    def f(P):
        best = np.full(len(P), 1e9, np.float64)
        for i in range(len(seg)):
            d = seg[i] / segl[i]
            n = N0[i] + N0[i + 1]
            n = n - d * (n @ d)
            n /= max(np.linalg.norm(n), 1e-9)
            b = np.cross(d, n)
            pa = P - P0[i]
            t = pa @ d
            e = np.maximum(np.maximum(-t, t - segl[i]), 0.0)
            qn = np.abs(pa @ n) - thick
            qb = np.abs(pa @ b) - width
            q = np.stack([np.maximum(qn + 0.002, 0), np.maximum(qb + 0.002, 0), e], 1)
            dd = np.linalg.norm(q, axis=1) + np.minimum(np.maximum(qn, qb) + 0.002, 0) - 0.002
            best = np.minimum(best, dd)
        return best
    return Fn(f, lo, hi, region=region, bones=bones)


def on_surface(body, p, off, n_hint):
    """Point on the body's surface (pushed out by off) nearest to p, and the surface normal there."""
    q = np.asarray(p, dtype=np.float64)[None, :].astype(np.float32)
    node = S.Fn(lambda P: body.eval(P) - off, body.lo - off, body.hi + off)
    q = S.project(node, q, 6)
    n = S.normals(body, q.astype(np.float32))[0]
    if n @ np.asarray(n_hint) < 0:
        n = -n
    return q[0].astype(np.float64), n


def backpack_part(T, body):
    """Backpack fitted to this body: a soft pack (bulging back panel, sagging bottom, rounded
    top) resting on the shoulder blades, and two padded straps from its top corners over the
    trapezius, down the front of the chest and back under the arms to its lower corners."""
    sx, sy, sz = T['sx'], T['sy'], T['sz']
    R = REGION['bag']
    shY = T['shoulder'][1]
    shx = T['shoulder'][0]
    k = T['H'] / 1.76
    young = T['kind'] in YOUNG
    # pack size: an adult day pack ~42 x 30 x 13 cm; children's school packs relatively bigger
    hh, hw, hd = (0.185 * sy, 0.135 * sx, 0.050 * sz) if not young else (0.20 * sy, 0.15 * sx, 0.06 * sz)
    yc = shY - 0.035 * sy - hh
    # the back surface (with clothes) at the pack's top and bottom: the pack's front plane leans on both
    yt, yb = yc + hh * 0.75, yc - hh * 0.8
    zt = max(surface_z(body, x, yt, +1) for x in np.linspace(-hw * 0.7, hw * 0.7, 5)) + 0.012 * k
    zbm = max(surface_z(body, x, yb, +1) for x in np.linspace(-hw * 0.7, hw * 0.7, 5)) + 0.012 * k
    tilt = np.degrees(np.arctan2(zt - zbm, yt - yb))          # + : the top further back than the bottom
    zc = 0.5 * (zt + zbm) + hd
    Rp = rot_xyz(tilt, 0, 0)
    # (a soft pack bends with the back: its top follows the chest, its bottom the lumbar spine)
    bones = lambda P: (lambda w: {'spine2': w, 'spine1': 1.0 - w})(0.3 + 0.7 * sstep(yc - hh * 0.9, yc + hh * 0.5, P[:, 1]))
    up = Rp @ np.array([0.0, 1.0, 0.0])
    back = Rp @ np.array([0.0, 0.0, 1.0])
    c = np.array([0.0, yc, zc])
    # soft body: a rounded box, its back panel bulging, the load sagging into the bottom
    shell = RoundBox(c, (hw - 0.03 * k, hh - 0.03 * k, hd * 0.55), 0.034 * k, R=Rp)
    belly = Ellipsoid(c + back * (hd * 0.30) - up * (hh * 0.15), (hw * 0.92, hh * 0.86, hd * 0.95), R=Rp)
    sag = Ellipsoid(c - up * (hh * 0.62) + back * (hd * 0.15), (hw * 0.95, hh * 0.32, hd * 1.02), R=Rp)
    flat = Fn(lambda P: (P - c) @ (-back) - hd * 0.92, c - 0.5, c + 0.5)          # the front panel lies flat on the back
    pack = Union([shell, belly, sag], k=0.03 * k)
    pack = Intersect(pack, flat, k=0.012 * k)
    # front pocket and the grab handle at the top
    pocket = Ellipsoid(c + back * (hd * 1.05) - up * (hh * 0.42), (hw * 0.68, hh * 0.36, hd * 0.42), R=Rp)
    pack = Union([pack, pocket], k=0.02 * k)
    top = c + up * (hh * 0.98) + back * (hd * 0.1)
    handle = RoundCone(top + np.array([-0.028 * k, 0, 0]), top + np.array([0.028 * k, 0.004 * k, 0]), 0.0065 * k, 0.0065 * k)
    pack = Union([pack, handle], k=0.006 * k)
    pack = Fn(pack.eval, pack.lo, pack.hi, region=R, bones=bones)
    # straps: from the top corners over the trapezius, down the chest, under the arm to the bottom
    straps = []
    off = 0.014 * k
    zf_front = lambda x, y: surface_z(body, x, y, -1)
    for s_ in (-1, 1):
        side = 'R' if s_ > 0 else 'L'
        xm = s_ * (shx * 0.55)
        ctrl = [
            (c + up * (hh * 0.86) - back * (hd * 0.6) + np.array([s_ * hw * 0.42, 0, 0]), (0, 0.3, 1)),
            (np.array([xm, shY + 0.05 * sy, 0.05 * sz]), (0, 1, 0.4)),
            (np.array([xm * 1.04, shY + 0.045 * sy, -0.01 * sz]), (0, 1, -0.3)),
            (np.array([xm * 1.12, shY - 0.03 * sy, zf_front(xm * 1.12, shY - 0.03 * sy)]), (0, 0.2, -1)),
            (np.array([xm * 1.28, shY - 0.13 * sy, zf_front(xm * 1.28, shY - 0.13 * sy)]), (s_ * 0.2, 0, -1)),
            (np.array([s_ * shx * 0.93, shY - 0.22 * sy, -0.02 * sz]), (s_, 0, -0.2)),
            (np.array([s_ * shx * 0.80, yc - hh * 0.55, zbm + 0.02 * sz]), (s_, 0, 0.6)),
            (c - up * (hh * 0.78) - back * (hd * 0.5) + np.array([s_ * hw * 0.72, 0, 0]), (s_ * 0.5, 0, 1)),
        ]
        pts, nrm = [], []
        for i, (p, h) in enumerate(ctrl):
            if 0 < i < len(ctrl) - 1:
                # (over the chest and under the arm the strap lies on the clothes, which stand off
                # the skin there more than on the shoulders)
                p, n = on_surface(body, p, off if i <= 2 else max(off * 1.3, 0.02), h)
            else:
                n = np.asarray(h, dtype=np.float64)
                n = n / np.linalg.norm(n)
            pts.append(p)
            nrm.append(n)
        sb = (lambda P, sd=side: (lambda w: {'spine2': 1.0 - w, 'clav' + sd: w})(
            0.35 * sstep(shY - 0.10 * sy, shY + 0.02 * sy, P[:, 1]) * sstep(0.02, -0.03, P[:, 2])))
        straps.append(strap(pts, nrm, max(0.021 * k, 0.016) if not young else max(0.019 * k, 0.015), max(0.0042 * k, 0.0038), sb, R))
    out = Union([pack] + straps, k=0.008 * k)
    # the pack's frame (centre y, z; half width, height, depth; tilt) for the runtime zips and
    # seams, and which surface is strap webbing
    out.frame = [float(yc), float(zc), float(hw), float(hh), float(hd), float(np.radians(tilt))]
    out.pack_body = pack
    out.straps = Union(straps)
    return out


def bag_part(name, T, body=None):
    sx, sy, sz = T['sx'], T['sy'], T['sz']
    R = REGION['bag']
    shY = T['shoulder'][1]
    if name == 'backpack':
        if body is not None:
            return backpack_part(T, body)
        c = (0, shY - 0.20 * sy, 0.165 * sz)
        body_ = RoundBox(c, (0.125 * sx, 0.175 * sy, 0.045 * sz), 0.03 * sz, R=rot_xyz(-6, 0, 0),
                         region=R, bones={'spine2': 0.85, 'spine1': 0.15})
        return body_
    if name == 'shoulderbag':
        hipY = T['hip'][1]
        c = (-0.205 * sx, hipY + 0.04 * sy, 0.01 * sz)
        # soft leather bag: well rounded, sagging a little at the bottom
        b = RoundBox(c, (0.020 * sx, 0.085 * sy, 0.112 * sz), 0.026, R=rot_xyz(0, 0, -6),
                     region=R, bones={'pelvis': 0.7, 'spine1': 0.3})
        sag = Ellipsoid((c[0], c[1] - 0.07 * sy, c[2]), (0.040 * sx, 0.04 * sy, 0.13 * sz),
                        region=R, bones={'pelvis': 0.7, 'spine1': 0.3})
        b = Union([b, sag], k=0.02)
        flap = RoundBox((c[0] - 0.026 * sx, c[1] + 0.045 * sy, c[2]), (0.006, 0.05 * sy, 0.12 * sz), 0.006,
                        region=R, bones={'pelvis': 0.7, 'spine1': 0.3})
        return Union([b, flap], k=0.006)
    # shopping bag hanging from the right hand (rest pose hand)
    _, sh, el, wr, du, df = arm_joints(T, 1)
    hand = wr + df * 0.08 * T['handS']
    # a filled plastic carrier bag: gathered at the handles, bulging towards the bottom
    top = hand + np.array([0.004, -0.07, 0.0]) * sy
    bot = hand + np.array([0.008, -0.40, 0.0]) * sy
    body = Loft(top, bot, (1, 0, 0), [(0.0, 0.012, 0.050, 0, 0), (0.25, 0.035, 0.115, 0, 0), (0.7, 0.050, 0.150, 0, 0),
                                       (1.0, 0.042, 0.140, 0, 0)], n=2.6, capr=0.35, region=R, bones={'handR': 1})
    handle = RoundCone(hand + np.array([0, 0.005, -0.012]), top + np.array([0, 0.01, -0.035]), 0.005, 0.007,
                       region=R, bones={'handR': 1})
    handle2 = RoundCone(hand + np.array([0, 0.005, 0.012]), top + np.array([0, 0.01, 0.035]), 0.005, 0.007,
                        region=R, bones={'handR': 1})
    return Union([body, handle, handle2], k=0.012)


def part_node(kind, name, body=None):
    """Model-space field of part `name` on base `kind` (body: that base's field, for hair that
    rests on it). Returns (node, group, meshing resolution factor)."""
    T = TEMPLATES[kind]
    hs, hc = T['headS'], np.array(T['headC'], dtype=float)
    set_cranium(T['face'], (T['shoulder'][1] - hc[1]) / hs)
    if name.startswith('hair') or name == 'scarf':
        bl = local_body(body, hs, hc) if body is not None else None
        sh_l = (T['shoulder'][1] - hc[1]) / hs
        hb = lambda P: (lambda w: {'head': w, 'spine2': 1.0 - w})(sstep(sh_l + 0.02, -0.10, P[:, 1]))
        node = hair_part(name, bl)
        for l in node.leaves():
            if isinstance(l, Fn) and name in LONG_STYLES:
                l.bones = hb
        return Xform(node, hs, hc), ('long' if name in LONG_STYLES else 'hair'), 0.75
    if name.startswith('beard'):
        return Xform(beard_part(name), hs, hc), 'beard', 0.7
    if name in ('cap', 'fedora', 'sunhat'):
        return Xform(hat_part(name), hs, hc), 'hat', 0.7
    if name == 'glasses':
        g = glasses_part()
        x = Xform(g, hs, hc)
        x.lens, x.frame = Xform(g.lens, hs, hc), Xform(g.frame, hs, hc)
        return x, 'glasses', None
    return bag_part(name, T, body), ('pack' if name == 'backpack' else 'bag'), (0.45 if name == 'backpack' else 1.0)


def drop_islands(V, T, frac):
    """Remove connected pieces with fewer than frac x the largest piece's triangles."""
    n = len(V)
    parent = np.arange(n)

    def find(i):
        r = i
        while parent[r] != r:
            r = parent[r]
        while parent[i] != r:
            parent[i], i = r, parent[i]
        return r
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]]])
    for a, b in E:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = np.array([find(i) for i in range(n)])
    troot = roots[T[:, 0]]
    ids, cnt = np.unique(troot, return_counts=True)
    keep_ids = ids[cnt >= frac * cnt.max()]
    keep = np.isin(troot, keep_ids)
    Tk = T[keep]
    used = np.unique(Tk)
    remap = np.full(n, -1, np.int64)
    remap[used] = np.arange(len(used))
    if (~keep).any():
        print(f'[humans]   dropped {int((~keep).sum())} tris in {len(ids) - len(keep_ids)} islands', flush=True)
    return V[used], remap[Tk]


def build_parts(kind, body, info, res, mesh_fn=None, decimate_fn=None, attr_fn=None):
    """Returns [{'id', 'name', 'kind', 'lods': [(attrs, tris) x LODs]}] (needs the builder's helpers)."""
    if mesh_fn is None:
        return []
    T = TEMPLATES[kind]
    hs, hc = T['headS'], np.array(T['headC'], dtype=float)
    out = []
    for name in PER_BASE[kind]:
        node, group, rf = part_node(kind, name, body)
        hres = 0.00045 if group == 'glasses' else res * rf
        lo, hi = node.lo - 0.01, node.hi + 0.01
        if group in ('hair', 'long', 'beard', 'hat'):
            # head parts: limit the meshing box to the head and what hangs from it
            lo = np.maximum(lo, hc + np.array([-0.2, -0.5, -0.2]) * hs)
            hi = np.minimum(hi, hc + np.array([0.2, 0.2, 0.2]) * hs)
        V, Tr = mesh_fn(node, lo, hi, hres)
        if len(Tr) == 0:
            continue
        if group in ('hair', 'long', 'pack'):
            # no stray islands (a sliver of hair left between the curtain and the body would show
            # as a dark blob on the clothes)
            V, Tr = drop_islands(V, Tr, 0.02)
        targets = LOD_TRIS[group]
        lods = decimate_fn(V, Tr, [t if t else 8 for t in targets])
        if group == 'pack' and hasattr(node, 'pack_body'):
            # far LODs: the pack alone (its thin straps would stall the decimation, and a few
            # pixels of strap do not show)
            Vb, Tb = mesh_fn(node.pack_body, node.pack_body.lo - 0.01, node.pack_body.hi + 0.01, hres * 1.6)
            far = decimate_fn(Vb, Tb, [t if t else 8 for t in targets[3:]])
            lods = lods[:3] + far
        lod_attrs = []
        for li, (Vl, Tl) in enumerate(lods):
            if not targets[li]:
                lod_attrs.append(None)
                continue
            a = attr_fn(node, body, Vl, Tl, head=group in ('hair', 'long', 'beard', 'hat', 'glasses'))
            if name in ('cap', 'fedora', 'sunhat'):
                # hat band (dark ribbon above the brim) for the shader
                y = (Vl[:, 1] - hc[1]) / hs
                band = ((y > 0.042) & (y < 0.062)) if name == 'fedora' else np.zeros(len(Vl), bool)
                a['aux'] = np.stack([np.zeros(len(Vl)), band.astype(float)], 1)
            elif name == 'glasses':
                P32 = a['P'].astype(np.float32)
                lens = node.lens.eval(P32) < node.frame.eval(P32) - 0.0002
                a['aux'] = np.stack([lens.astype(float), np.zeros(len(Vl))], 1)
            elif name == 'backpack' and hasattr(node, 'frame'):
                P32 = a['P'].astype(np.float32)
                web = node.straps.eval(P32) < node.pack_body.eval(P32) - 0.001
                a['aux'] = np.stack([np.zeros(len(Vl)), web.astype(float)], 1)
                info['pack'] = node.frame
            elif name.startswith('beard'):
                # edge fade (0 at the beard's edge) in head-local coordinates
                ql = ((a['P'] - hc) / hs).astype(np.float32)
                a['aux'] = np.stack([np.clip(node.child.edge(ql), 0, 1), np.zeros(len(Vl))], 1)
            elif group in ('hair', 'long'):
                # aux0: how far down the hair hangs below the jaw (0 on the head .. 1 at the ends),
                # for the runtime sway with the gait; aux1: the last few centimetres above the
                # ragged ends (0 at the very end .. 1 at 4 cm up) for the thinning alpha taper
                yl = (a['P'][:, 1] - hc[1]) / hs
                tipd = np.ones(len(Vl))
                inner = getattr(node, 'child', None)
                if inner is not None and hasattr(inner, 'tip'):
                    ql = ((a['P'] - hc) / hs).astype(np.float64)
                    tipd = np.clip(inner.tip(ql) / 0.04, 0, 1)
                a['aux'] = np.stack([np.clip((-0.06 - yl) / 0.30, 0, 1), tipd], 1)
            lod_attrs.append((a, Tl))
        out.append({'id': PART_IDS[name], 'name': name, 'kind': group, 'lods': lod_attrs})
    return out
