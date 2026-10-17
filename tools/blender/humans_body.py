"""Anatomical signed-distance bodies for the crowd figures.

Three base bodies (adult male, adult female, child) are described with anthropometric
numbers (metres). Each primitive carries a body region (used for clothing masks at
runtime) and skinning bone influences. Runtime convention: +Y up, the figure faces -Z,
its right side is +X ("R" bones), left side -X ("L" bones). Rest pose: arms abducted
~20 degrees with slightly bent elbows, legs slightly apart.

`build_body(kind, build)` returns (sdf_node, skeleton, info). `build` > 0 makes the heavy
variant used to derive the per-vertex "build" morph.
"""
import numpy as np
from humans_sdf import (Ellipsoid, RoundCone, Loft, RoundBox, Union, Subtract, Intersect, HalfSpace,
                        Xform, normalize, rot_xyz, v3)

BONES = ['root', 'pelvis', 'spine1', 'spine2', 'neck', 'head',
         'clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR',
         'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR']
PARENT = {'root': None, 'pelvis': 'root', 'spine1': 'pelvis', 'spine2': 'spine1', 'neck': 'spine2', 'head': 'neck',
          'clavL': 'spine2', 'armL': 'clavL', 'foreL': 'armL', 'handL': 'foreL',
          'clavR': 'spine2', 'armR': 'clavR', 'foreR': 'armR', 'handR': 'foreR',
          'thighL': 'pelvis', 'shinL': 'thighL', 'footL': 'shinL', 'toeL': 'footL',
          'thighR': 'pelvis', 'shinR': 'thighR', 'footR': 'shinR', 'toeR': 'footR'}

REGION = {'torso': 1, 'neck': 2, 'head': 3, 'uarm': 4, 'farm': 5, 'hand': 6, 'thigh': 7, 'shin': 8,
          'foot': 9, 'eye': 10, 'hair': 11, 'beard': 12, 'hat': 13, 'bag': 14, 'skirt': 15, 'ear': 16,
          'lips': 17, 'nose': 18, 'butt': 19, 'breast': 20}


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- templates

MALE = dict(
    H=1.76,
    hip=(0.088, 0.915, 0.0), knee=(0.097, 0.500, -0.004), ankle=(0.104, 0.080, 0.024),
    heelZ=0.088, toeZ=-0.205, ballT=0.68,
    pelvis=(0, 0.965, 0.012), spine1=(0, 1.070, 0.028), spine2=(0, 1.250, 0.020),
    neck=(0, 1.462, 0.030), head=(0, 1.580, 0.012),
    clav=(0.020, 1.440, -0.010), shoulder=(0.182, 1.425, 0.018),
    Lu=0.312, Lf=0.252, abd=19.0,
    headC=(0, 1.650, 0.0), headS=1.0, face='male',
    # torso loft keys: y, rx, rz, cz (centre z offset)
    torso=[(0.800, 0.095, 0.070, 0.012), (0.855, 0.150, 0.098, 0.014), (0.915, 0.168, 0.108, 0.014),
           (0.985, 0.160, 0.104, 0.006), (1.065, 0.146, 0.100, -0.002), (1.150, 0.150, 0.104, -0.008),
           (1.230, 0.160, 0.112, -0.012), (1.300, 0.167, 0.114, -0.008), (1.365, 0.170, 0.108, 0.000),
           (1.410, 0.140, 0.090, 0.010), (1.455, 0.085, 0.062, 0.022)],
    # limb keys: t, rx (lateral), rz (front-back), ox, oz
    uarm=[(0.0, 0.050, 0.052, 0.004, 0.0), (0.30, 0.046, 0.049, 0.0, -0.004), (0.62, 0.041, 0.043, 0.0, -0.002),
          (1.0, 0.036, 0.034, 0.0, 0.003)],
    farm=[(0.0, 0.040, 0.037, 0.0, 0.002), (0.22, 0.042, 0.040, 0.002, 0.0), (0.62, 0.032, 0.028, 0.0, 0.0),
          (1.0, 0.0195, 0.027, 0.0, 0.0)],
    thigh=[(0.0, 0.086, 0.088, 0.006, 0.004), (0.25, 0.083, 0.085, 0.004, -0.006), (0.60, 0.070, 0.074, 0.0, -0.010),
           (0.88, 0.057, 0.060, -0.002, -0.006), (1.0, 0.052, 0.054, 0.0, 0.0)],
    shin=[(0.0, 0.052, 0.050, 0.0, 0.002), (0.18, 0.050, 0.056, 0.0, 0.012), (0.38, 0.047, 0.054, -0.002, 0.012),
          (0.72, 0.034, 0.035, 0.0, 0.004), (1.0, 0.029, 0.031, 0.0, 0.0)],
    calf=(0.046, 0.085, 0.036), glute=(0.074, 0.086, 0.058), handS=1.0, footS=1.0,
    pec=(0.072, 0.052, 0.034), breast=None, belly=None, neckR=(0.058, 0.060),
    sx=1.0, sy=1.0, sz=1.0,
)

FEMALE = dict(
    H=1.63,
    hip=(0.086, 0.848, 0.0), knee=(0.086, 0.462, -0.006), ankle=(0.094, 0.074, 0.022),
    heelZ=0.080, toeZ=-0.185, ballT=0.68,
    pelvis=(0, 0.895, 0.014), spine1=(0, 0.990, 0.028), spine2=(0, 1.155, 0.020),
    neck=(0, 1.352, 0.028), head=(0, 1.462, 0.012),
    clav=(0.018, 1.330, -0.008), shoulder=(0.160, 1.318, 0.016),
    Lu=0.288, Lf=0.230, abd=21.0,
    headC=(0, 1.528, 0.002), headS=0.935, face='female',
    torso=[(0.738, 0.095, 0.070, 0.014), (0.795, 0.150, 0.096, 0.016), (0.852, 0.168, 0.106, 0.018),
           (0.915, 0.157, 0.100, 0.010), (0.990, 0.128, 0.088, 0.000), (1.062, 0.131, 0.090, -0.006),
           (1.135, 0.139, 0.096, -0.010), (1.200, 0.144, 0.100, -0.008), (1.262, 0.148, 0.096, -0.002),
           (1.305, 0.126, 0.082, 0.008), (1.345, 0.078, 0.056, 0.020)],
    uarm=[(0.0, 0.044, 0.046, 0.003, 0.0), (0.30, 0.041, 0.043, 0.0, -0.002), (0.62, 0.037, 0.038, 0.0, 0.0),
          (1.0, 0.031, 0.030, 0.0, 0.003)],
    farm=[(0.0, 0.034, 0.032, 0.0, 0.002), (0.22, 0.036, 0.034, 0.002, 0.0), (0.62, 0.028, 0.024, 0.0, 0.0),
          (1.0, 0.0170, 0.024, 0.0, 0.0)],
    thigh=[(0.0, 0.092, 0.088, 0.012, 0.006), (0.25, 0.086, 0.084, 0.006, -0.004), (0.60, 0.069, 0.070, 0.0, -0.008),
           (0.88, 0.054, 0.056, -0.002, -0.006), (1.0, 0.049, 0.050, 0.0, 0.0)],
    shin=[(0.0, 0.048, 0.046, 0.0, 0.002), (0.18, 0.046, 0.051, 0.0, 0.011), (0.38, 0.043, 0.049, -0.002, 0.011),
          (0.72, 0.030, 0.031, 0.0, 0.004), (1.0, 0.025, 0.027, 0.0, 0.0)],
    calf=(0.042, 0.080, 0.033), glute=(0.074, 0.086, 0.058), handS=0.9, footS=0.91,
    pec=None, breast=(0.058, 0.056, 0.050), belly=None, neckR=(0.050, 0.052),
    sx=0.93, sy=0.926, sz=0.95,
)


def child_template():
    """8-10 year old: adult male body scaled down with a relatively large head."""
    k = dict(MALE)
    sx, sy, sz, sr = 0.70, 0.725, 0.72, 0.68

    def P(p):
        return (p[0] * sx, p[1] * sy, p[2] * sz)

    for key in ('hip', 'knee', 'ankle', 'pelvis', 'spine1', 'spine2', 'neck', 'head', 'clav', 'shoulder'):
        k[key] = P(MALE[key])
    k['H'] = 1.32
    k['heelZ'] = MALE['heelZ'] * 0.75
    k['toeZ'] = MALE['toeZ'] * 0.74
    k['Lu'], k['Lf'] = MALE['Lu'] * sy, MALE['Lf'] * sy
    k['torso'] = [(y * sy, rx * sx * 0.98, rz * sz * 0.96, cz * sz) for y, rx, rz, cz in MALE['torso']]
    for key in ('uarm', 'farm', 'thigh', 'shin'):
        k[key] = [(t, rx * sr, rz * sr, ox * sr, oz * sr) for t, rx, rz, ox, oz in MALE[key]]
    k['calf'] = tuple(np.array(MALE['calf']) * sr)
    k['glute'] = tuple(np.array(MALE['glute']) * sr)
    k['pec'] = None
    k['neckR'] = (0.044, 0.046)
    k['handS'], k['footS'] = 0.72, 0.74
    k['headS'] = 0.88
    k['headC'] = (0, 1.32 - (1.758 - 1.650) * 0.88, 0.0)
    k['head'] = (0, k['headC'][1] - 0.07 * 0.88, 0.010)
    k['face'] = 'child'
    k['sx'], k['sy'], k['sz'] = sx, sy, sz
    return k


TEMPLATES = {'male': MALE, 'female': FEMALE, 'child': child_template()}


# ----------------------------------------------------------------------------- pieces

def head_sdf(face, build=0.0):
    """Head in local coordinates (origin at eye level on the mid plane, facing -Z).

    Built like a sculpt: cranium + a wide shallow facial mask, then jaw, chin, cheekbones,
    brow, muzzle (maxilla), nose, lips, ears. The eyeballs sit flush under the brow in
    shallow sockets; eyelids / iris / lash line are painted by the runtime shader."""
    fem = face == 'female'
    kid = face == 'child'
    jaw = 0.86 if fem else (0.80 if kid else 1.0)
    full = build * 0.006
    H = {'head': 1}
    R = REGION['head']
    cr = Ellipsoid((0, 0.014, 0.006), (0.0745, 0.096, 0.098) if not kid else (0.077, 0.099, 0.101), region=R, bones=H)
    mask = Ellipsoid((0, -0.022, -0.044), (0.064 + full, 0.083, 0.051), region=R, bones=H)
    jw = []
    for s in (-1, 1):
        gon = (s * (0.052 * jaw + 0.004 + full), -0.068 + (1 - jaw) * 0.01, 0.004)
        jw.append(RoundCone((s * (0.057 + full), -0.012, 0.012), gon, 0.014 + full, 0.013 + full, region=R, bones=H))
        jw.append(RoundCone(gon, (s * 0.022 * (jaw + 0.1), -0.099 + (1 - jaw) * 0.01, -0.066), 0.013 + full, 0.012,
                            region=R, bones=H))
    chin = Ellipsoid((0, -0.097 + (1 - jaw) * 0.01, -0.0745), (0.019 * jaw + 0.004, 0.018, 0.020), region=R, bones=H)
    cheeks = [Ellipsoid((s * 0.047, -0.016, -0.060), (0.021, 0.015 + full, 0.022 + full), region=R, bones=H)
              for s in (-1, 1)]
    muzzle = Ellipsoid((0, -0.058, -0.070), (0.034 + full * 0.5, 0.030, 0.028), region=R, bones=H)
    bh = 0.0 if (fem or kid) else 0.002
    brow = Ellipsoid((0, 0.025, -0.074 - bh), (0.054, 0.0165, 0.0165 + bh), region=R, bones=H)
    skull = Union([cr, mask] + jw + [chin] + cheeks + [muzzle], k=0.022)
    skull = Union([skull, brow], k=0.024)
    ez = -0.0745
    sockets = Union([Ellipsoid((s * 0.0320, 0.002, ez - 0.0185), (0.0175, 0.0125, 0.0120)) for s in (-1, 1)])
    skull = Subtract(skull, sockets, k=0.009)
    eyes = [Ellipsoid((s * 0.0320, 0.0, ez), (0.0118, 0.0118, 0.0118), region=REGION['eye'], bones=H) for s in (-1, 1)]
    nsc = 0.9 if fem else (0.78 if kid else 1.0)
    N = REGION['nose']
    nose = Union([
        Loft((0, 0.016, -0.0880), (0, -0.031, -0.0880 - 0.026 * nsc), (1, 0, 0),
             [(0.0, 0.0072, 0.0060, 0, 0.0), (0.45, 0.0074 * nsc + 0.0008, 0.0068, 0, 0.0),
              (1.0, 0.0105 * nsc + 0.001, 0.0085 * nsc, 0, 0.0)], region=N, bones=H),
        Ellipsoid((0, -0.0305, -0.0865 - 0.022 * nsc), (0.0108 * nsc, 0.0092 * nsc, 0.0100 * nsc), region=N, bones=H),
        Ellipsoid((-0.0128 * nsc, -0.0345, -0.0965 + (1 - nsc) * 0.006), (0.0080, 0.0070, 0.0085), region=N, bones=H),
        Ellipsoid((0.0128 * nsc, -0.0345, -0.0965 + (1 - nsc) * 0.006), (0.0080, 0.0070, 0.0085), region=N, bones=H),
    ], k=0.005)
    lip = 1.15 if fem else (0.9 if kid else 1.0)
    L = REGION['lips']
    lips = Union([
        Ellipsoid((0, -0.0545, -0.0955), (0.0215, 0.0058 * lip, 0.0070), region=L, bones=H),
        Ellipsoid((0, -0.0650, -0.0935), (0.0190, 0.0068 * lip, 0.0078), region=L, bones=H),
    ], k=0.003)
    ears = []
    for s in (-1, 1):
        Rr = rot_xyz(0, -s * 18, s * 4)
        e = Ellipsoid((s * 0.0755, -0.010, 0.012), (0.0075, 0.029 if not kid else 0.026, 0.0170), R=Rr,
                      region=REGION['ear'], bones=H)
        concha = Ellipsoid((s * 0.0815, -0.016, 0.009), (0.0040, 0.011, 0.0070), R=Rr)
        ears.append(Subtract(e, concha, k=0.003))
    head = Union([skull, nose], k=0.009)
    head = Union([head, lips], k=0.005)
    head = Union([head] + ears, k=0.007)
    head = Union([head] + eyes, k=0.0045)
    return head


def hand_sdf(T, s, wrist, a, scale):
    """Relaxed hand hanging from the wrist along axis a; palm facing the thigh."""
    a = normalize(a)
    pn = normalize(s * np.cross(a, [0, 0, 1.0]))     # palm normal (medial)
    wd = np.array([0, 0, -1.0])
    wd = normalize(wd - a * (wd @ a) - pn * (wd @ pn))  # towards the thumb (forward)
    side = 'R' if s > 0 else 'L'
    bw = {'hand' + side: 1}
    R = np.stack([pn, a, wd], axis=1)
    sc = scale
    palm = RoundBox(wrist + a * 0.046 * sc, (0.0115 * sc, 0.040 * sc, 0.036 * sc), 0.0105 * sc, R=R,
                    region=REGION['hand'], bones=bw)
    knuck = wrist + a * 0.090 * sc
    fingers = []
    for off, ln, r in ((0.026, 0.074, 0.0088), (0.0085, 0.081, 0.0090), (-0.0095, 0.076, 0.0086), (-0.026, 0.060, 0.0078)):
        b0 = knuck + wd * off * sc - pn * 0.001 + a * (0.004 if abs(off) > 0.02 else 0.0) * sc
        d1 = normalize(a + pn * 0.30 - wd * off * 1.5)
        d2 = normalize(a + pn * 0.95 - wd * off * 2.0)
        b1 = b0 + d1 * ln * 0.55 * sc
        b2 = b1 + d2 * ln * 0.45 * sc
        fingers.append(RoundCone(b0, b1, r * sc, r * 0.93 * sc, region=REGION['hand'], bones=bw))
        fingers.append(RoundCone(b1, b2, r * 0.92 * sc, r * 0.80 * sc, region=REGION['hand'], bones=bw))
    t0 = wrist + (a * 0.022 + wd * 0.026 + pn * 0.006) * sc
    td = normalize(a * 0.75 + wd * 0.45 + pn * 0.35)
    t1 = t0 + td * 0.042 * sc
    t2 = t1 + normalize(a * 0.85 + wd * 0.2 + pn * 0.5) * 0.033 * sc
    thumb = [RoundCone(t0, t1, 0.0125 * sc, 0.0105 * sc, region=REGION['hand'], bones=bw),
             RoundCone(t1, t2, 0.0100 * sc, 0.0082 * sc, region=REGION['hand'], bones=bw)]
    return Union([palm, Union(fingers + thumb, k=0.0)], k=0.007)


def shoe_sdf(T, s, ankle, scale):
    """Closed shoe (generic lace-up / sneaker shape); sandals are a shading choice at runtime."""
    side = 'R' if s > 0 else 'L'
    toe_out = np.radians(6.0) * s
    heel = np.array([ankle[0] - 0.004 * s, 0.0, T['heelZ']])
    fwd = np.array([np.sin(toe_out), 0, -np.cos(toe_out)])
    L = (T['heelZ'] - T['toeZ'])
    toe = heel + fwd * L
    fs = scale
    ball = T['ballT']

    def bones(P):
        t = ((P - heel) @ fwd) / L
        w_toe = sstep(ball - 0.06, ball + 0.06, t)
        w_shin = 1.0 - sstep(0.06, 0.11 * fs, P[:, 1])
        w_shin *= (1 - w_toe)
        return {'toe' + side: w_toe, 'foot' + side: (1 - w_toe) * (1 - w_shin * 0.35),
                'shin' + side: (1 - w_toe) * w_shin * 0.35}

    keys = [(0.00, 0.031, 0.042, 0.0, 0.049), (0.10, 0.036, 0.056, 0.0, 0.058), (0.30, 0.040, 0.050, 0.0, 0.052),
            (0.55, 0.046, 0.036, 0.004 * s, 0.038), (0.75, 0.047, 0.027, 0.004 * s, 0.029),
            (0.92, 0.040, 0.020, 0.002 * s, 0.022), (1.00, 0.028, 0.016, 0.0, 0.019)]
    keys = [(t, rx * fs, rz * fs, ox * fs, oz * fs) for t, rx, rz, ox, oz in keys]
    upper = Loft(heel, toe, (1, 0, 0), keys, n=2.4, region=REGION['foot'], bones=bones)
    skeys = [(0.0, 0.034, 0.013, 0, 0.013), (0.15, 0.037, 0.013, 0, 0.013), (0.45, 0.041, 0.012, 0.003 * s, 0.012),
             (0.75, 0.049, 0.012, 0.004 * s, 0.012), (0.95, 0.040, 0.012, 0.002 * s, 0.013), (1.0, 0.030, 0.012, 0, 0.014)]
    skeys = [(t, rx * fs, rz, ox * fs, oz) for t, rx, rz, ox, oz in skeys]
    sole = Loft(heel - fwd * 0.004, toe + fwd * 0.004, (1, 0, 0), skeys, n=3.0, region=REGION['foot'], bones=bones)
    shoe = Union([upper, sole], k=0.006)
    return Intersect(shoe, HalfSpace((0, 0.0, 0), (0, -1, 0)), k=0.002)


def _zsign(A, B, hint):
    """+1 when the loft frame z axis points backwards (+Z world) for this segment."""
    from humans_sdf import rot_frame
    return float(np.sign(rot_frame(np.asarray(B) - np.asarray(A), hint)[2][2]) or 1.0)


def build_body(kind='male', build=0.0):
    T = TEMPLATES[kind]
    b = build
    fem = kind == 'female'
    kid = kind == 'child'
    sx, sy, sz = T['sx'], T['sy'], T['sz']
    H = T['H']
    J = {'root': np.zeros(3)}
    for k in ('pelvis', 'spine1', 'spine2', 'neck', 'head'):
        J[k] = v3(T[k])
    shoulder_y = T['shoulder'][1]

    # ---- torso: a lofted superellipse along +Y (frame z = +Z world, so cz is a world z offset)
    ys = np.array([k[0] for k in T['torso']])
    y0, y1 = ys[0], ys[-1]
    keys = []
    for y, rx, rz, cz in T['torso']:
        u = (y - y0) / (y1 - y0)
        g = b * (0.020 + 0.030 * np.exp(-((u - 0.40) / 0.22) ** 2))      # heavy: waist / hips fill out
        gz = b * (0.012 + 0.045 * np.exp(-((u - 0.36) / 0.20) ** 2))     # heavy: belly forward
        keys.append((u, rx + g * sx, rz + gz * sz, 0.0, cz - gz * 0.55))

    def torso_bones(P):
        y = P[:, 1]
        wp = 1 - sstep(J['pelvis'][1], J['spine1'][1] + 0.03 * sy, y)
        ws2 = sstep(J['spine1'][1] + 0.06 * sy, J['spine2'][1] + 0.02 * sy, y)
        ws1 = np.clip(1 - wp - ws2, 0, 1)
        wc = sstep(shoulder_y - 0.07 * sy, shoulder_y - 0.01 * sy, y) * sstep(0.07 * sx, 0.14 * sx, np.abs(P[:, 0])) * 0.7
        return {'pelvis': wp * (1 - wc), 'spine1': ws1 * (1 - wc), 'spine2': ws2 * (1 - wc),
                'clavL': np.where(P[:, 0] < 0, wc, 0.0), 'clavR': np.where(P[:, 0] >= 0, wc, 0.0)}

    torso = Loft((0, y0, 0), (0, y1, 0), (1, 0, 0), keys, n=2.25, region=REGION['torso'], bones=torso_bones)
    tparts = [torso]
    for s in (-1, 1):
        side = 'R' if s > 0 else 'L'
        gx, gy, gz = T['glute']
        tparts.append(Ellipsoid((s * 0.058 * sx * (1.05 if fem else 1.0), T['hip'][1] - 0.035 * sy, 0.060 * sz + b * 0.01),
                                (gx + b * 0.01, gy + b * 0.01, gz + b * 0.012), region=REGION['butt'],
                                bones={'pelvis': 0.65, 'thigh' + side: 0.35}))
        if T['pec']:
            px, py, pz = T['pec']
            tparts.append(Ellipsoid((s * 0.068, 1.300, -0.088 - b * 0.012), (px + b * 0.008, py + b * 0.01, pz + b * 0.01),
                                    R=rot_xyz(0, 0, s * 12), region=REGION['torso'], bones={'spine2': 1}))
        if T['breast']:
            bx, by, bz = T['breast']
            tparts.append(Ellipsoid((s * 0.056, 1.192, -0.074 - b * 0.006), (bx + b * 0.01, by + b * 0.008, bz + b * 0.01),
                                    R=rot_xyz(-14, s * 10, 0), region=REGION['breast'], bones={'spine2': 1}))
        # shoulder blades
        tparts.append(Ellipsoid((s * 0.080 * sx, shoulder_y - 0.10 * sy, 0.072 * sz * (0.92 if fem else 1.0)),
                                (0.062 * sx, 0.085 * sy, 0.032 * sz), R=rot_xyz(0, s * 18, 0), region=REGION['torso'],
                                bones={'spine2': 1}))
    if b > 0:
        tparts.append(Ellipsoid((0, T['hip'][1] + 0.17 * sy, -0.05 * sz), (0.12 * sx, 0.12 * sy, (0.085 * b + 0.02) * sz),
                                region=REGION['torso'], bones={'pelvis': 0.4, 'spine1': 0.6}))
    torso = Union(tparts, k=0.035 * sy)

    # ---- neck, trapezius slope
    nr = T['neckR']
    nb = J['neck'] + np.array([0, -0.02, -0.004]) * sy
    nt = J['head'] + np.array([0, 0.035, -0.012]) * T['headS']

    def neck_bones(P):
        u = np.clip((P[:, 1] - nb[1]) / (nt[1] - nb[1]), 0, 1)
        wh = sstep(0.55, 1.0, u)
        ws = 1 - sstep(0.0, 0.35, u)
        return {'head': wh, 'neck': np.clip(1 - wh - ws, 0, 1), 'spine2': ws}

    neck = Loft(nb, nt, (1, 0, 0), [(0, nr[0] + b * 0.012, nr[1] + b * 0.012, 0, 0.004),
                                    (0.5, nr[0] * 0.96 + b * 0.01, nr[1] * 0.97 + b * 0.012, 0, 0.0),
                                    (1.0, nr[0] * 0.92 + b * 0.008, nr[1] * 0.95 + b * 0.012, 0, -0.004)],
                region=REGION['neck'], bones=neck_bones)
    traps = []
    for s in (-1, 1):
        side = 'R' if s > 0 else 'L'
        sh = np.array([s * T['shoulder'][0], T['shoulder'][1], T['shoulder'][2]])
        a = np.array([s * 0.028 * sx, J['neck'][1] + 0.025 * sy, 0.035 * sz])
        bpt = sh + np.array([-s * 0.03 * sx, 0.022 * sy, 0.0])
        traps.append(RoundCone(a, bpt, 0.040 * sy + b * 0.008, 0.034 * sy + b * 0.006, region=REGION['torso'],
                               bones={'spine2': 0.55, 'clav' + side: 0.45}))
    torso = Union([torso, Union(traps, k=0.02)], k=0.03)
    body = Union([torso, neck], k=0.03)

    # ---- head
    head = Xform(head_sdf(T['face'], b), T['headS'], T['headC'])
    body = Union([body, head], k=0.022 * T['headS'])

    # ---- arms (A-pose)
    abd = np.radians(T['abd'])
    arms = []
    for s in (-1, 1):
        side = 'R' if s > 0 else 'L'
        sh = np.array([s * T['shoulder'][0], T['shoulder'][1], T['shoulder'][2]])
        cl = np.array([s * T['clav'][0], T['clav'][1], T['clav'][2]])
        du = np.array([s * np.sin(abd), -np.cos(abd), 0.0])
        el = sh + du * T['Lu'] + np.array([0, 0, 0.012 * sy])
        df = normalize(du + np.array([s * 0.02, 0, -0.16]))
        wr = el + df * T['Lf']
        J['clav' + side], J['arm' + side], J['fore' + side], J['hand' + side] = cl, sh, el, wr
        zu = _zsign(sh, el, (s, 0, 0))
        zf = _zsign(el, wr, (s, 0, 0))
        uk = [(t, rx + b * 0.012 * (1 - t * 0.5), rz + b * 0.012 * (1 - t * 0.5), ox, oz * zu) for t, rx, rz, ox, oz in T['uarm']]
        fk = [(t, rx + b * 0.006 * (1 - t), rz + b * 0.006 * (1 - t), ox, oz * zf) for t, rx, rz, ox, oz in T['farm']]
        ua = Loft(sh + du * 0.01, el, (s, 0, 0), uk, region=REGION['uarm'], bones={'arm' + side: 1})
        delt = Ellipsoid(sh + du * 0.025 + np.array([s * 0.004 * sx, 0.004 * sy, 0.0]),
                         (0.042 * sy + b * 0.008, 0.068 * sy, 0.052 * sy + b * 0.006),
                         R=rot_xyz(0, 0, s * T['abd']), region=REGION['uarm'],
                         bones={'arm' + side: 0.7, 'clav' + side: 0.3})
        fa = Loft(el, wr, (s, 0, 0), fk, region=REGION['farm'], bones={'fore' + side: 1})
        hand = hand_sdf(T, s, wr, df + np.array([0, 0, -0.05]), T['handS'])
        arm = Union([Union([delt, ua], k=0.03 * sy), fa], k=0.008 * sy)
        arm = Union([arm, hand], k=0.008 * T['handS'])
        arms.append(arm)
    body = Union([body] + arms, k=0.022 * sy)

    # ---- legs
    legs = []
    for s in (-1, 1):
        side = 'R' if s > 0 else 'L'
        hp = np.array([s * T['hip'][0], T['hip'][1], T['hip'][2]])
        kn = np.array([s * T['knee'][0], T['knee'][1], T['knee'][2]])
        an = np.array([s * T['ankle'][0], T['ankle'][1], T['ankle'][2]])
        J['thigh' + side], J['shin' + side], J['foot' + side] = hp, kn, an
        toe_out = np.radians(6.0) * s
        fwd = np.array([np.sin(toe_out), 0, -np.cos(toe_out)])
        heel = np.array([an[0] - 0.004 * s, 0.0, T['heelZ']])
        J['toe' + side] = heel + fwd * (T['heelZ'] - T['toeZ']) * T['ballT'] + np.array([0, 0.022 * T['footS'], 0])
        top = hp + np.array([s * 0.004, 0.09 * sy, 0])
        zt = _zsign(top, kn, (s, 0, 0))
        t0 = (top[1] - hp[1]) / (top[1] - kn[1])   # thigh keys are given from the hip joint down
        zs = _zsign(kn, an, (s, 0, 0))
        tk = [(0.0, 0.050 * sx, 0.060 * sz, 0.0, 0.0)]
        tk += [(t0 + t * (1 - t0), rx + b * 0.022 * (1 - t * 0.7), rz + b * 0.020 * (1 - t * 0.7), ox, oz * zt)
               for t, rx, rz, ox, oz in T['thigh']]
        sk = [(t, rx + b * 0.008 * (1 - t), rz + b * 0.010 * (1 - t), ox, oz * zs) for t, rx, rz, ox, oz in T['shin']]
        th = Loft(top, kn, (s, 0, 0), tk, region=REGION['thigh'], bones={'thigh' + side: 1})
        pat = Ellipsoid(kn + np.array([0, 0.012 * sy, -0.040 * sz]), (0.026 * sx, 0.030 * sy, 0.016 * sz),
                        region=REGION['thigh'], bones={'thigh' + side: 0.45, 'shin' + side: 0.55})
        sh_ = Loft(kn, an + np.array([0, -0.01, 0]), (s, 0, 0), sk, region=REGION['shin'], bones={'shin' + side: 1})
        cx, cy, cz = T['calf']
        calf = Ellipsoid(kn + np.array([-s * 0.006 * sx, -0.125 * sy, 0.026 * sz]), (cx + b * 0.006, cy, cz + b * 0.006),
                         region=REGION['shin'], bones={'shin' + side: 1})
        leg = Union([th, pat], k=0.02 * sy)
        leg = Union([leg, Union([sh_, calf], k=0.03 * sy)], k=0.008 * sy)
        leg = Union([leg, shoe_sdf(T, s, an, T['footS'])], k=0.008)
        legs.append(leg)
    body = Union([body, Union(legs, k=0.0)], k=0.03 * sy)

    skel = {'bones': BONES, 'parent': [BONES.index(PARENT[n]) if PARENT[n] else -1 for n in BONES],
            'joints': [[float(x) for x in J[n]] for n in BONES]}
    hc = np.array(T['headC'], dtype=float)
    hs = T['headS']
    eye = lambda s: (hc + hs * np.array([s * 0.0320, 0.0, -0.0745])).tolist()
    info = {'H': H, 'kind': kind, 'headC': hc.tolist(), 'headS': hs, 'eyeL': eye(-1), 'eyeR': eye(1),
            'eyeRadius': 0.0118 * hs, 'face': T['face'], 'sx': sx, 'sy': sy,
            'hip': list(T['hip']), 'knee': list(T['knee']), 'ankle': list(T['ankle']), 'shoulder': list(T['shoulder']),
            'waistY': float(y0 + (y1 - y0) * keys[4][0]), 'neckY': float(J['neck'][1]), 'torsoY': [float(y0), float(y1)],
            'heelZ': T['heelZ'], 'toeZ': T['toeZ'], 'Lu': T['Lu'], 'Lf': T['Lf'], 'abd': T['abd']}
    return body, skel, info
