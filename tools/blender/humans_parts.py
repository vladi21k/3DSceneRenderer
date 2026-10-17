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
from humans_body import REGION, TEMPLATES, sstep, cranium, arm_joints

PART_IDS = {
    'hair_short': 1, 'hair_buzz': 2, 'hair_medium': 3, 'hair_curly': 4, 'hair_balding': 5,
    'hair_long': 6, 'hair_ponytail': 7, 'hair_bun': 8, 'hair_bob': 9, 'hair_pixie': 10, 'scarf': 11,
    'beard_full': 12, 'beard_short': 13, 'cap': 14, 'fedora': 15, 'sunhat': 16,
    'backpack': 17, 'shoulderbag': 18, 'shopping': 19, 'hair_side': 20, 'hair_receding': 21, 'glasses': 22,
    'hair_curlyf': 23,
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
}
LONG_STYLES = ('hair_long', 'hair_bob', 'scarf', 'hair_ponytail', 'hair_curlyf')
# triangles per LOD; 0 = the part is dropped at that LOD (too small to matter on screen)
LOD_TRIS = {'hair': (1400, 600, 200, 50, 16), 'long': (2600, 1000, 320, 90, 30), 'beard': (900, 320, 110, 24, 0),
            'hat': (1200, 450, 150, 40, 16), 'bag': (700, 260, 90, 24, 12), 'glasses': (900, 260, 70, 0, 0)}

# hairline (head-local y at the front / temples) of the men's and boys' short styles: a forehead
# of ~5 cm above the brows. The runtime paints the soft edge with the same numbers (material.js)
MALE_FRONT, MALE_TEMPLE = 0.066, 0.046

# cranium of the head sculpt the parts are being built for (humans_body.cranium; set per base)
CR_C, CR_R = cranium('male')


def set_cranium(face):
    global CR_C, CR_R
    CR_C, CR_R = cranium(face)


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
             noise=0.0, seed=1, burn_w=1.0, thick_back=None):
    tb = thick_side if thick_back is None else thick_back

    def off(P):
        u = np.clip((P[:, 1] + 0.02) / 0.11, 0, 1)
        # the back of the head carries more hair than the sides above the ears (occipital volume)
        ws = thick_side + (tb - thick_side) * sstep(0.01, 0.07, P[:, 2] - CR_C[2]) * sstep(-0.075, -0.03, P[:, 1])
        t = ws + (thick_top - ws) * u
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


def local_body(body, hs, hc):
    """The body field in head-local coordinates (to rest long hair on the neck and back)."""
    hc = np.asarray(hc, dtype=np.float64)

    def f(P):
        return body.eval((P * hs + hc).astype(np.float32)) / hs
    return Fn(f, (body.lo - hc) / hs, (body.hi - hc) / hs)


def falling_hair(bl, length, width, thick, top, seed, wave=0.0, front_z=-0.004, spread=0.03, ends='U'):
    """Long hair below the crown: the column of hair that falls from the head over the nape and
    the shoulders down to `length` (head-local y of the ends at the back), minus the body.
    width: half width at the ears; spread: extra half width where it falls over the shoulders."""
    L = -length
    yh = CR_C[1] - 0.02
    keys = [(0.0, CR_R[0] + top * 0.8, CR_R[2] + top, 0, 0.0),
            (0.30, width, CR_R[2] * 0.82 + thick, 0, 0.012),
            (0.55, width + spread * 0.7, CR_R[2] * 0.66 + thick, 0, 0.022),
            (0.8, width + spread, CR_R[2] * 0.58 + thick * 0.9, 0, 0.030),
            (1.0, width + spread * 0.9, CR_R[2] * 0.52 + thick * 0.7, 0, 0.032)]
    # (Loft frame: x = +X, y = down, z = forward; keys' oz moves the column backwards)
    col = Loft((0, yh, CR_C[2]), (0, -L + 0.0, CR_C[2]), (1, 0, 0),
               [(t, rx, rz, 0, -oz) for t, rx, rz, _, oz in keys], n=2.4)
    head_env = cranium_offset(lambda P: top + 0.004 * sstep(0.0, 0.08, P[:, 1]))
    env = Union([head_env, col], k=0.03)

    def shape(P):
        d = env.eval(P)
        th = _theta(P)
        # clump grooves down the outside, stronger towards the ends; gentle waves for wavy hair
        dn = (0.0028 + 0.0028 * sstep(-0.05, -0.25, P[:, 1])) * strand_noise(P, seed)
        dw = wave * np.sin(P[:, 1] * 60.0 + 3.0 * np.sin(th * 3.0)) * sstep(-0.05, -0.2, P[:, 1])
        # ragged U / V shaped ends, the sides a little shorter than the back
        ax = np.abs(P[:, 0]) / max(width + spread, 1e-3)
        tip = L + (0.035 if ends == 'U' else 0.07) * ax ** 2 + 0.012 * clump_noise(P * np.array([1, 0.1, 1]), seed + 3, 90.0)
        cut = tip - P[:, 1]
        # keep in front of the ears clear of the curtain: the face and the cheeks
        fz = front_z + 0.03 * sstep(-0.02, -0.12, P[:, 1])
        front = fz - P[:, 2]
        return np.maximum(np.maximum(d - dn - dw, cut), front * (1.0 - sstep(0.03, 0.09, P[:, 1])))
    hair = Fn(shape, np.array([-0.2, -length - 0.05, -0.15]), np.array([0.2, 0.17, 0.2]))
    # minus the body inflated a little (hair lies on the skin and the clothes over it)
    hair = Subtract(hair, Fn(lambda P: bl.eval(P) - 0.004, bl.lo - 0.01, bl.hi + 0.01), k=0.006)
    return hair


def face_clear(hair, kid=False):
    hair = Subtract(hair, Ellipsoid((0, -0.03, -0.085), (0.074, 0.090, 0.085)), k=0.01)
    return hair


def hair_part(name, body_l=None):
    H = {'head': 1}
    R = REGION['hair']
    mf, mt = MALE_FRONT, MALE_TEMPLE
    if name == 'hair_short':
        # the front edge thins out over ~2 cm (no bowl-cut ledge); a little lift on top; a full
        # occiput tapering to a clipper-faded nape
        n = cap_hair(0.013, 0.0055, R, front=mf, temple=mt, noise=0.0014, fade=0.02, thick_back=0.009, back=-0.070)
        n = Union([n, Ellipsoid((0.006, 0.086, -0.040), (0.050, 0.019, 0.032))], k=0.018)
    elif name == 'hair_buzz':
        n = cap_hair(0.0045, 0.0032, R, front=mf, temple=mt, fade=0.006, thick_back=0.004, back=-0.068)
    elif name == 'hair_medium':
        n = cap_hair(0.019, 0.010, R, front=mf - 0.004, temple=mt - 0.003, noise=0.0025, seed=3, fade=0.02,
                     thick_back=0.015, back=-0.078)
        n = Union([n, Ellipsoid((0.012, 0.086, -0.048), (0.050, 0.024, 0.030))], k=0.02)
    elif name == 'hair_curly':
        # tight curls: an even, bumpy volume all round
        n = cap_hair(0.026, 0.016, R, front=mf - 0.004, temple=mt - 0.003, noise=0.006, seed=7, fade=0.016,
                     thick_back=0.022, back=-0.072)
    elif name == 'hair_side':
        # side parting: fuller top swept to one side, short back and sides
        n = cap_hair(0.016, 0.006, R, front=mf - 0.002, temple=mt, noise=0.0016, seed=13, fade=0.02,
                     thick_back=0.010, back=-0.070)
        sweep = Ellipsoid((0.022, 0.086, -0.032), (0.058, 0.022, 0.058), R=rot_xyz(0, 0, -12))
        n = Union([n, sweep], k=0.02)
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
        n = cap_hair(0.014, 0.012, R, front=0.050, temple=0.040, burn=0.02, back=-0.07, fade=0.004, burn_w=0.0,
                     thick_back=0.016)
        knot = Ellipsoid((0, -0.045, CR_C[2] + CR_R[2] + 0.002), (0.040, 0.030, 0.030))
        tail = RoundCone((0, -0.05, CR_C[2] + CR_R[2] + 0.008), (0.02, -0.15, CR_C[2] + CR_R[2]), 0.022, 0.012)
        n = Union([n, knot, tail], k=0.015)
        if body_l is not None:
            n = Subtract(n, Fn(lambda P: body_l.eval(P) - 0.003, body_l.lo, body_l.hi), k=0.006)
    elif name == 'hair_curlyf':
        # a full head of curls falling to the shoulders: big, bumpy, rounded volume
        capn = cap_hair(0.032, 0.026, R, front=0.052, temple=0.040, back=-0.060, noise=0.007, seed=29, thick_back=0.034)
        fall = falling_hair(body_l, 0.215, CR_R[0] + 0.040, 0.034, 0.034, 31, spread=0.035, wave=0.0)
        bumps = Fn(lambda P: fall.eval(P) - 0.006 * clump_noise(P, 37, 75.0), fall.lo, fall.hi)
        n = face_clear(Union([capn, bumps], k=0.02))
    else:
        # longer female styles share a fuller cap
        capn = cap_hair(0.021, 0.013, R, front=0.054, temple=0.040, back=-0.060, noise=0.002, seed=11, thick_back=0.020)
        if name == 'hair_long':
            # falls past the shoulders onto the shoulder blades
            fall = falling_hair(body_l, 0.36, CR_R[0] + 0.020, 0.022, 0.022, 41, spread=0.040, wave=0.0015)
            n = face_clear(Union([capn, fall], k=0.02))
        elif name == 'hair_ponytail':
            # hair drawn back tight to a tie at the back of the crown; the tail hangs from it and
            # rests on the nape and upper back
            tz = CR_C[2] + CR_R[2]
            tie = Ellipsoid((0, 0.012, tz - 0.004), (0.020, 0.020, 0.016))
            path = [(0, 0.014, tz + 0.006), (0, -0.030, tz + 0.026), (0, -0.090, tz + 0.030), (0, -0.160, tz + 0.020),
                    (0, -0.230, tz + 0.005)]
            rad = [0.020, 0.025, 0.024, 0.018, 0.007]
            tail = Union([RoundCone(path[i], path[i + 1], rad[i], rad[i + 1]) for i in range(len(path) - 1)], k=0.02)
            tail = Fn(lambda P: tail.eval(P) - 0.004 * strand_noise(P, 43, 180.0, along=0.25), tail.lo - 0.01, tail.hi + 0.01)
            if body_l is not None:
                tail = Subtract(tail, Fn(lambda P: body_l.eval(P) - 0.004, body_l.lo, body_l.hi), k=0.008)
            n = Union([cap_hair(0.014, 0.008, R, front=0.054, temple=0.040, back=-0.058, noise=0.001, seed=11,
                                thick_back=0.012), tie, tail], k=0.012)
        elif name == 'hair_bun':
            bun = Ellipsoid((0, 0.045, CR_C[2] + CR_R[2] + 0.004), (0.040, 0.036, 0.034))
            bun = Fn(lambda P: bun.eval(P) - 0.003 * clump_noise(P, 47, 160.0), bun.lo - 0.01, bun.hi + 0.01)
            n = Union([cap_hair(0.016, 0.010, R, front=0.054, temple=0.040, back=-0.060, noise=0.0015, seed=11,
                                thick_back=0.014), bun], k=0.012)
        elif name == 'hair_bob':
            # chin length all round: falls from the crown to just above the shoulders
            fall = falling_hair(body_l, 0.105, CR_R[0] + 0.017, 0.020, 0.020, 53, spread=0.008, ends='U')
            n = face_clear(Union([capn, fall], k=0.02))
            n = Subtract(n, Ellipsoid((0, -0.028, -0.095), (0.078, 0.092, 0.095)), k=0.008)
    return _tag(n, REGION['hair'], H)


def hair_bones(hc, hs, sh_y):
    """Skin weights of a hair part: the head, and below the jaw more and more the chest (long
    hair lying on the back follows the upper body rather than the head)."""
    def f(P):
        y = P[:, 1]
        w = sstep(hc[1] - 0.10 * hs, sh_y - 0.05 * hs, y)
        return {'head': w, 'neck': 0.0 * w, 'spine2': 1 - w}
    return f


__BEARD_HAT_GLASSES__
