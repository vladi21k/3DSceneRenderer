"""Accessory parts for the crowd figures: hair styles, head scarf, beards, hats, bags.

Each part is a signed distance field placed on a base body (head parts in head-local
coordinates: origin at eye level, facing -Z, scaled with the head), meshed and decimated
like the body, then merged into the base's LOD meshes with a part id. At runtime a figure
enables at most one hair style, beard, hat and bag (look row), the rest are collapsed.
"""
import numpy as np
import humans_sdf as S
from humans_sdf import Ellipsoid, RoundCone, Loft, RoundBox, Union, Subtract, Intersect, Fn, Xform, rot_xyz, normalize
from humans_body import REGION, TEMPLATES, sstep

PART_IDS = {
    'hair_short': 1, 'hair_buzz': 2, 'hair_medium': 3, 'hair_curly': 4, 'hair_balding': 5,
    'hair_long': 6, 'hair_ponytail': 7, 'hair_bun': 8, 'hair_bob': 9, 'hair_pixie': 10, 'scarf': 11,
    'beard_full': 12, 'beard_short': 13, 'cap': 14, 'fedora': 15, 'sunhat': 16,
    'backpack': 17, 'shoulderbag': 18, 'shopping': 19, 'hair_side': 20, 'hair_receding': 21, 'glasses': 22,
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
    'female': ['hair_long', 'hair_ponytail', 'hair_bun', 'hair_bob', 'hair_pixie', 'scarf', 'sunhat', 'cap',
               'backpack', 'shoulderbag', 'shopping', 'glasses'],
    'child': ['hair_short', 'hair_long', 'hair_ponytail', 'hair_bob', 'cap', 'backpack'],
}
# triangles per LOD; 0 = the part is dropped at that LOD (too small to matter on screen)
LOD_TRIS = {'hair': (1400, 600, 200, 50, 16), 'long': (2200, 900, 300, 80, 26), 'beard': (900, 320, 110, 24, 0),
            'hat': (1200, 450, 150, 40, 16), 'bag': (700, 260, 90, 24, 12), 'glasses': (900, 260, 70, 0, 0)}

# hairline (head-local y at the front / temples) of the men's and boys' short styles: a forehead
# of ~5 cm above the brows. The runtime paints the soft edge with the same numbers (material.js)
MALE_FRONT, MALE_TEMPLE = 0.066, 0.046

# cranium of the head sculpt (humans_body.head_sdf)
CR_C = np.array([0.0, 0.014, 0.006])
CR_R = np.array([0.0745, 0.096, 0.098])


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


def cranium_offset(off_fn):
    """Field of the cranium ellipsoid pushed out by a position-dependent offset (metres)."""
    cr = Ellipsoid(CR_C, CR_R)

    def f(P):
        return cr.eval(P) - off_fn(P)
    lo = CR_C - CR_R - 0.06
    hi = CR_C + CR_R + 0.06
    return Fn(f, lo, hi)


def ears_cut():
    return Union([Ellipsoid((s * 0.076, -0.010, 0.012), (0.016, 0.034, 0.024)) for s in (-1, 1)])


def cap_hair(thick_top, thick_side, region, front=0.058, temple=0.036, burn=-0.014, back=-0.064, fade=0.012,
             noise=0.0, seed=1, burn_w=1.0):
    def off(P):
        u = np.clip((P[:, 1] + 0.02) / 0.11, 0, 1)
        t = thick_side + (thick_top - thick_side) * u
        h = hairline(P, front, temple, 0.022, burn, back, burn_w)
        t = t * (0.08 + 0.92 * sstep(h, h + fade, P[:, 1])) + 0.0010
        if noise:
            t = t + noise * clump_noise(P, seed) * sstep(h, h + fade, P[:, 1])
        return t
    shell = cranium_offset(off)

    def region_fn(P):
        return hairline(P, front, temple, 0.022, burn, back, burn_w) - P[:, 1]
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


def hair_part(name):
    H = {'head': 1}
    R = REGION['hair']
    mf, mt = MALE_FRONT, MALE_TEMPLE
    if name == 'hair_short':
        # the front edge thins out over ~2 cm (no bowl-cut ledge); a little lift on top
        n = cap_hair(0.013, 0.0055, R, front=mf, temple=mt, noise=0.0014, fade=0.02)
        n = Union([n, Ellipsoid((0.006, 0.086, -0.040), (0.050, 0.019, 0.032))], k=0.018)
    elif name == 'hair_buzz':
        n = cap_hair(0.0042, 0.0032, R, front=mf, temple=mt, fade=0.006)
    elif name == 'hair_medium':
        n = cap_hair(0.019, 0.010, R, front=mf - 0.004, temple=mt - 0.003, noise=0.0025, seed=3, fade=0.02)
        n = Union([n, Ellipsoid((0.012, 0.086, -0.048), (0.050, 0.024, 0.030))], k=0.02)
    elif name == 'hair_curly':
        n = cap_hair(0.026, 0.016, R, front=mf - 0.004, temple=mt - 0.003, noise=0.006, seed=7, fade=0.016)
    elif name == 'hair_side':
        # side parting: fuller top swept to one side, short back and sides
        n = cap_hair(0.016, 0.006, R, front=mf - 0.002, temple=mt, noise=0.0016, seed=13, fade=0.02)
        sweep = Ellipsoid((0.022, 0.086, -0.032), (0.058, 0.022, 0.058), R=rot_xyz(0, 0, -12))
        n = Union([n, sweep], k=0.02)
    elif name == 'hair_receding':
        n = cap_hair(0.010, 0.006, R, front=0.074, temple=0.066, noise=0.0012, seed=17)
    elif name == 'hair_balding':
        # a horseshoe fringe over the ears and round the back; nothing in front of the temples
        base = cap_hair(0.007, 0.006, R, front=0.15, temple=0.13, fade=0.01)
        crown = Ellipsoid((0, 0.115, -0.025), (0.075, 0.072, 0.095))
        n = Subtract(base, crown, k=0.02)
    elif name == 'hair_pixie':
        n = cap_hair(0.022, 0.012, R, front=0.052, noise=0.0035, seed=5, back=-0.055)
    elif name == 'scarf':
        n = cap_hair(0.014, 0.012, R, front=0.050, temple=0.040, burn=0.02, back=-0.07, fade=0.004, burn_w=0.0)
        knot = Ellipsoid((0, -0.045, 0.105), (0.040, 0.030, 0.030))
        tail = RoundCone((0, -0.05, 0.11), (0.02, -0.15, 0.10), 0.022, 0.012)
        n = Union([n, knot, tail], k=0.015)
    else:
        # longer female styles share a fuller cap
        capn = cap_hair(0.021, 0.013, R, front=0.054, temple=0.040, back=-0.060, noise=0.002, seed=11)
        if name == 'hair_long':
            back = Loft((0, 0.03, 0.055), (0, -0.25, 0.085), (1, 0, 0),
                        [(0, 0.080, 0.045, 0, 0.0), (0.35, 0.082, 0.040, 0, 0.004), (0.75, 0.090, 0.024, 0, 0.012),
                         (1.0, 0.075, 0.016, 0, 0.012)])
            sides = [RoundCone((s * 0.070, 0.02, -0.01), (s * 0.085, -0.13, 0.03), 0.020, 0.014) for s in (-1, 1)]
            n = Union([capn, back] + sides, k=0.03)
            n = Subtract(n, Ellipsoid((0, -0.03, -0.085), (0.074, 0.088, 0.085)), k=0.01)  # keep the face clear
            n = Subtract(n, Ellipsoid((0, -0.10, 0.0), (0.060, 0.055, 0.075)), k=0.01)    # and the neck
        elif name == 'hair_ponytail':
            tie = Ellipsoid((0, 0.005, 0.105), (0.020, 0.020, 0.018))
            tail = Union([RoundCone((0, 0.0, 0.115), (0, -0.07, 0.135), 0.024, 0.026),
                          RoundCone((0, -0.07, 0.135), (0, -0.19, 0.115), 0.026, 0.010)], k=0.02)
            n = Union([capn, tie, tail], k=0.012)
        elif name == 'hair_bun':
            bun = Ellipsoid((0, 0.045, 0.110), (0.040, 0.036, 0.034))
            n = Union([capn, bun], k=0.012)
        elif name == 'hair_bob':
            bulb = Ellipsoid((0, -0.004, 0.012), (0.092, 0.110, 0.112))
            # uneven, clumpy cut line rather than a perfect helmet rim
            low = Fn(lambda P: (-0.078 + 0.012 * (1 - np.cos(_theta(P))) + 0.005 * np.sin(_theta(P) * 11.0 + 0.7)
                                + 0.003 * np.sin(_theta(P) * 23.0)) - P[:, 1], (-0.2, -0.3, -0.2), (0.2, 0.3, 0.2))
            bob = Intersect(bulb, low, k=0.006)
            # open the face generously: thin curtains near the eyes bridge into sheets when decimated
            bob = Subtract(bob, Ellipsoid((0, -0.028, -0.095), (0.078, 0.092, 0.095)), k=0.008)
            bob = Subtract(bob, Ellipsoid((0, -0.1, 0.0), (0.058, 0.06, 0.07)), k=0.01)
            n = Union([capn, bob], k=0.015)
    return _tag(n, REGION['hair'], H)


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


def bag_part(name, T):
    sx, sy, sz = T['sx'], T['sy'], T['sz']
    R = REGION['bag']
    shY = T['shoulder'][1]
    if name == 'backpack':
        c = (0, shY - 0.20 * sy, 0.165 * sz)
        body = RoundBox(c, (0.125 * sx, 0.175 * sy, 0.045 * sz), 0.03 * sz, R=rot_xyz(-6, 0, 0),
                        region=R, bones={'spine2': 0.85, 'spine1': 0.15})
        pocket = RoundBox((0, shY - 0.29 * sy, 0.225 * sz), (0.09 * sx, 0.07 * sy, 0.02 * sz), 0.015,
                          region=R, bones={'spine2': 0.8, 'spine1': 0.2})
        handle = RoundCone((-0.03 * sx, shY - 0.01 * sy, 0.13 * sz), (0.03 * sx, shY - 0.01 * sy, 0.13 * sz), 0.008, 0.008,
                           region=R, bones={'spine2': 1})
        straps = [RoundCone((s * 0.085 * sx, shY + 0.005 * sy, 0.06 * sz), (s * 0.095 * sx, shY - 0.03 * sy, -0.02 * sz),
                            0.012, 0.012, region=R, bones={'spine2': 1}) for s in (-1, 1)]
        return Union([body, pocket, handle] + straps, k=0.01)
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
    abd = np.radians(T['abd'])
    sh = np.array(T['shoulder'], dtype=float)
    du = np.array([np.sin(abd), -np.cos(abd), 0.0])
    el = sh + du * T['Lu']
    df = normalize(du + np.array([0.02, 0, -0.16]))
    wr = el + df * T['Lf']
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


def build_parts(kind, body, info, res, mesh_fn=None, decimate_fn=None, attr_fn=None):
    """Returns [{'id', 'name', 'kind', 'lods': [(attrs, tris) x 3]}] (needs the builder's helpers)."""
    if mesh_fn is None:
        return []
    T = TEMPLATES[kind]
    hs, hc = T['headS'], np.array(T['headC'], dtype=float)
    out = []
    for name in PER_BASE[kind]:
        if name.startswith('hair') or name == 'scarf':
            node, group, hres = Xform(hair_part(name), hs, hc), ('long' if name in ('hair_long', 'hair_bob', 'scarf', 'hair_ponytail') else 'hair'), res * 0.75
        elif name.startswith('beard'):
            node, group, hres = Xform(beard_part(name), hs, hc), 'beard', res * 0.7
        elif name in ('cap', 'fedora', 'sunhat'):
            node, group, hres = Xform(hat_part(name), hs, hc), 'hat', res * 0.7
        elif name == 'glasses':
            g = glasses_part()
            node, group, hres = Xform(g, hs, hc), 'glasses', 0.00045
            lens_n, frame_n = Xform(g.lens, hs, hc), Xform(g.frame, hs, hc)
        else:
            node, group, hres = bag_part(name, T), 'bag', res
        lo, hi = node.lo - 0.01, node.hi + 0.01
        V, Tr = mesh_fn(node, lo, hi, hres)
        if len(Tr) == 0:
            continue
        targets = LOD_TRIS[group]
        lods = decimate_fn(V, Tr, [t if t else 8 for t in targets])
        lod_attrs = []
        for li, (Vl, Tl) in enumerate(lods):
            if not targets[li]:
                lod_attrs.append(None)
                continue
            a = attr_fn(node, body, Vl, Tl, head=group != 'bag')
            if name in ('cap', 'fedora', 'sunhat'):
                # hat band (dark ribbon above the brim) for the shader
                y = (Vl[:, 1] - hc[1]) / hs
                band = ((y > 0.042) & (y < 0.062)) if name == 'fedora' else np.zeros(len(Vl), bool)
                a['aux'] = np.stack([np.zeros(len(Vl)), band.astype(float)], 1)
            elif name == 'glasses':
                P32 = a['P'].astype(np.float32)
                lens = lens_n.eval(P32) < frame_n.eval(P32) - 0.0002
                a['aux'] = np.stack([lens.astype(float), np.zeros(len(Vl))], 1)
            elif name.startswith('beard'):
                # edge fade (0 at the beard's edge) in head-local coordinates
                ql = ((a['P'] - hc) / hs).astype(np.float32)
                a['aux'] = np.stack([np.clip(node.child.edge(ql), 0, 1), np.zeros(len(Vl))], 1)
            lod_attrs.append((a, Tl))
        out.append({'id': PART_IDS[name], 'name': name, 'kind': group, 'lods': lod_attrs})
    return out
