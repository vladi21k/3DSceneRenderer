"""Anatomical signed-distance bodies for the crowd figures.

Four base bodies are described with anthropometric numbers (metres): an adult man, an adult
woman, an older child (8-11 years) and a young child (4-6 years). Each is sculpted from the
same anatomical recipe with its own proportions and sex / age features:
  - a lofted torso core with the side-view S-curve (thoracic kyphosis, lumbar lordosis) and
    the frontal taper (men: broad chest and latissimus V to a narrow pelvis; women: narrow
    waist, wide hips; children: little waist, a rounder belly);
  - the back: the trapezius slope from the neck to the acromion, shoulder blades, erector
    columns either side of a spine furrow, the vertebra prominens, latissimus flare, glutes
    with the cleft and gluteal folds;
  - the front: pectorals (men) or breasts (women), the abdomen;
  - limbs with the deltoid cap, biceps / triceps, olecranon, forearm muscle bellies tapering
    to the wrist, the carrying angle (wider in women), thighs with the hamstring mass, the
    patella, two-headed calves tapering into the Achilles tendon.
Each primitive carries a body region (clothing masks at runtime) and skinning bone
influences. Runtime convention: +Y up, the figure faces -Z, its right side is +X ("R"
bones), left side -X ("L" bones). Rest pose: arms abducted ~17 degrees with slightly bent
elbows, legs slightly apart.

`build_body(kind, build)` returns (sdf_node, skeleton, info). `build` > 0 makes the heavy
variant used to derive the per-vertex "build" morph (men gain at the belly and waist, women
at the hips, thighs and seat); `belly` and `face_var` make the targets of the scalar shape
morphs (a belly; long / broad / older faces).
"""
import numpy as np
from humans_sdf import (Ellipsoid, RoundCone, Loft, RoundBox, Union, Subtract, Intersect, HalfSpace, Fn,
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
          'lips': 17, 'nose': 18, 'butt': 19, 'breast': 20, 'phone': 21, 'glasses': 22}


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def gauss(u, c, w):
    return np.exp(-((u - c) / w) ** 2)


# ----------------------------------------------------------------------------- templates
# torso: (y, half width, front z, back z) of the core from below the crotch up to the neck
# base (anatomical features are added on top); limbs: (t, half width, half depth, lateral
# offset, back offset) along the bone from the proximal joint (offsets: + = outwards / back)

MALE = dict(
    kind='male', sex='m', H=1.76,
    hip=(0.088, 0.915, 0.0), knee=(0.094, 0.500, -0.004), ankle=(0.098, 0.080, 0.024),
    heelZ=0.082, toeZ=-0.193, ballT=0.68,
    pelvis=(0, 0.965, 0.012), spine1=(0, 1.070, 0.028), spine2=(0, 1.250, 0.020),
    neck=(0, 1.466, 0.030), head=(0, 1.585, 0.012),
    clav=(0.020, 1.438, -0.010), shoulder=(0.180, 1.420, 0.018),
    Lu=0.312, Lf=0.255, abd=17.0, carry=0.07,
    headC=(0, 1.6467, 0.0), headS=1.03, face='male',
    torso=[(0.800, 0.108, -0.052, 0.060), (0.855, 0.144, -0.074, 0.074), (0.915, 0.158, -0.093, 0.078),
           (0.985, 0.152, -0.103, 0.064), (1.060, 0.145, -0.107, 0.058), (1.140, 0.149, -0.112, 0.072),
           (1.220, 0.161, -0.124, 0.090), (1.295, 0.168, -0.129, 0.100), (1.360, 0.164, -0.117, 0.100),
           (1.410, 0.136, -0.090, 0.090), (1.455, 0.080, -0.048, 0.072)],
    uarm=[(0.0, 0.050, 0.052, 0.004, 0.0), (0.30, 0.047, 0.050, 0.0, 0.004), (0.55, 0.043, 0.046, 0.0, 0.002),
          (0.80, 0.038, 0.040, 0.0, 0.0), (1.0, 0.035, 0.034, 0.0, -0.002)],
    farm=[(0.0, 0.039, 0.036, 0.0, 0.001), (0.20, 0.043, 0.039, 0.003, 0.0), (0.45, 0.038, 0.032, 0.002, 0.0),
          (0.75, 0.029, 0.023, 0.0, 0.0), (1.0, 0.0225, 0.0175, 0.0, 0.0)],
    thigh=[(0.0, 0.082, 0.088, 0.002, 0.006), (0.25, 0.080, 0.084, 0.003, 0.010), (0.55, 0.071, 0.074, 0.001, 0.008),
           (0.82, 0.060, 0.060, -0.002, 0.000), (1.0, 0.051, 0.052, 0.0, -0.002)],
    shin=[(0.0, 0.050, 0.049, 0.0, 0.002), (0.15, 0.048, 0.050, 0.0, 0.006), (0.40, 0.045, 0.046, -0.001, 0.008),
          (0.70, 0.032, 0.032, 0.0, 0.002), (0.88, 0.026, 0.026, 0.0, -0.001), (1.0, 0.027, 0.029, 0.0, 0.0)],
    calf=(0.040, 0.090, 0.034), calfL=(0.034, 0.075, 0.030),
    glute=(0.066, 0.893, 0.068, 0.080, 0.088, 0.060), fold=0.835,
    pec=(0.070, 1.302, 0.088, 0.060, 0.016), breast=None, lat=0.040, erector=(0.026, 0.13, 0.016),
    scap=(0.088, 0.096, 0.054, 0.080, 0.021), trap=(0.036, 0.024), neckR=(0.060, 0.062), kidBelly=None,
    delt=(0.040, 0.058, 0.050), handS=1.0, footS=1.0,
    sx=1.0, sy=1.0, sz=1.0,
)

FEMALE = dict(
    kind='female', sex='f', H=1.63,
    hip=(0.090, 0.845, 0.0), knee=(0.080, 0.462, -0.006), ankle=(0.088, 0.074, 0.022),
    heelZ=0.074, toeZ=-0.174, ballT=0.68,
    pelvis=(0, 0.893, 0.016), spine1=(0, 0.988, 0.030), spine2=(0, 1.152, 0.020),
    neck=(0, 1.356, 0.028), head=(0, 1.464, 0.012),
    clav=(0.018, 1.330, -0.008), shoulder=(0.156, 1.316, 0.016),
    Lu=0.287, Lf=0.229, abd=16.0, carry=0.12,
    headC=(0, 1.5246, 0.002), headS=0.96, face='female',
    torso=[(0.735, 0.116, -0.048, 0.062), (0.790, 0.153, -0.064, 0.078), (0.845, 0.164, -0.076, 0.078),
           (0.905, 0.164, -0.088, 0.070), (0.975, 0.130, -0.094, 0.054), (1.035, 0.131, -0.097, 0.060),
           (1.100, 0.140, -0.104, 0.074), (1.170, 0.148, -0.110, 0.086), (1.235, 0.149, -0.106, 0.090),
           (1.290, 0.134, -0.086, 0.084), (1.345, 0.068, -0.040, 0.064)],
    uarm=[(0.0, 0.044, 0.046, 0.003, 0.0), (0.30, 0.042, 0.045, 0.0, 0.005), (0.60, 0.038, 0.040, 0.0, 0.004),
          (1.0, 0.030, 0.029, 0.0, -0.001)],
    farm=[(0.0, 0.033, 0.030, 0.0, 0.001), (0.22, 0.036, 0.032, 0.002, 0.0), (0.55, 0.030, 0.025, 0.001, 0.0),
          (1.0, 0.0195, 0.0150, 0.0, 0.0)],
    thigh=[(0.0, 0.089, 0.090, 0.008, 0.010), (0.25, 0.085, 0.085, 0.006, 0.010), (0.55, 0.072, 0.072, 0.001, 0.006),
           (0.85, 0.056, 0.056, -0.003, 0.000), (1.0, 0.048, 0.050, 0.0, -0.002)],
    shin=[(0.0, 0.047, 0.046, 0.0, 0.002), (0.15, 0.045, 0.047, 0.0, 0.006), (0.40, 0.042, 0.043, -0.001, 0.007),
          (0.70, 0.029, 0.029, 0.0, 0.002), (0.88, 0.023, 0.024, 0.0, -0.001), (1.0, 0.024, 0.026, 0.0, 0.0)],
    calf=(0.037, 0.085, 0.031), calfL=(0.031, 0.070, 0.027),
    glute=(0.070, 0.814, 0.068, 0.082, 0.088, 0.064), fold=0.752,
    pec=None, breast=(0.058, 1.180, 0.057, 0.055, 0.049), lat=0.022, erector=(0.020, 0.10, 0.009),
    scap=(0.078, 0.088, 0.046, 0.068, 0.014), trap=(0.027, 0.020), neckR=(0.049, 0.051), kidBelly=None,
    delt=(0.033, 0.050, 0.042), handS=0.9, footS=0.91,
    sx=0.93, sy=0.926, sz=0.95,
)

CHILD = dict(
    kind='child', sex='c', H=1.36,
    hip=(0.064, 0.690, 0.0), knee=(0.066, 0.385, -0.004), ankle=(0.069, 0.060, 0.018),
    heelZ=0.062, toeZ=-0.150, ballT=0.68,
    pelvis=(0, 0.725, 0.010), spine1=(0, 0.800, 0.022), spine2=(0, 0.940, 0.016),
    neck=(0, 1.112, 0.022), head=(0, 1.198, 0.010),
    clav=(0.014, 1.088, -0.006), shoulder=(0.120, 1.073, 0.014),
    Lu=0.238, Lf=0.192, abd=17.0, carry=0.08,
    headC=(0, 1.252, 0.0), headS=0.95, face='child',
    torso=[(0.610, 0.084, -0.040, 0.048), (0.650, 0.106, -0.054, 0.058), (0.695, 0.114, -0.064, 0.062),
           (0.750, 0.111, -0.072, 0.054), (0.805, 0.105, -0.075, 0.050), (0.865, 0.108, -0.079, 0.058),
           (0.930, 0.114, -0.086, 0.068), (0.995, 0.119, -0.088, 0.075), (1.045, 0.114, -0.078, 0.075),
           (1.080, 0.094, -0.060, 0.068), (1.112, 0.052, -0.030, 0.052)],
    uarm=[(0.0, 0.036, 0.038, 0.003, 0.0), (0.30, 0.034, 0.036, 0.0, 0.003), (0.60, 0.031, 0.032, 0.0, 0.002),
          (1.0, 0.026, 0.025, 0.0, 0.0)],
    farm=[(0.0, 0.028, 0.026, 0.0, 0.001), (0.22, 0.030, 0.027, 0.002, 0.0), (0.55, 0.026, 0.021, 0.001, 0.0),
          (1.0, 0.0170, 0.0135, 0.0, 0.0)],
    thigh=[(0.0, 0.060, 0.064, 0.002, 0.005), (0.25, 0.058, 0.061, 0.003, 0.006), (0.55, 0.052, 0.054, 0.001, 0.005),
           (0.85, 0.043, 0.044, -0.002, 0.000), (1.0, 0.038, 0.040, 0.0, -0.001)],
    shin=[(0.0, 0.038, 0.037, 0.0, 0.001), (0.15, 0.036, 0.038, 0.0, 0.004), (0.40, 0.034, 0.035, -0.001, 0.005),
          (0.70, 0.025, 0.025, 0.0, 0.001), (0.88, 0.020, 0.020, 0.0, -0.001), (1.0, 0.021, 0.022, 0.0, 0.0)],
    calf=(0.029, 0.066, 0.025), calfL=(0.025, 0.056, 0.022),
    glute=(0.052, 0.672, 0.050, 0.060, 0.066, 0.046), fold=0.622,
    pec=None, breast=None, lat=0.014, erector=(0.017, 0.09, 0.008),
    scap=(0.066, 0.072, 0.040, 0.058, 0.016), trap=(0.024, 0.017), neckR=(0.041, 0.042), kidBelly=(0.072, 0.030),
    delt=(0.028, 0.042, 0.035), handS=0.76, footS=0.77,
    sx=0.75, sy=0.773, sz=0.76,
)

KID = dict(
    kind='kid', sex='c', H=1.10,
    hip=(0.052, 0.530, 0.0), knee=(0.054, 0.298, -0.004), ankle=(0.056, 0.048, 0.016),
    heelZ=0.050, toeZ=-0.122, ballT=0.68,
    pelvis=(0, 0.560, 0.010), spine1=(0, 0.622, 0.020), spine2=(0, 0.735, 0.014),
    neck=(0, 0.866, 0.018), head=(0, 0.928, 0.008),
    clav=(0.011, 0.846, -0.005), shoulder=(0.094, 0.834, 0.012),
    Lu=0.186, Lf=0.150, abd=18.0, carry=0.07,
    headC=(0, 0.988, 0.004), headS=0.92, face='kid',
    torso=[(0.465, 0.068, -0.034, 0.040), (0.500, 0.088, -0.047, 0.050), (0.535, 0.094, -0.058, 0.054),
           (0.580, 0.093, -0.067, 0.048), (0.625, 0.092, -0.073, 0.043), (0.675, 0.093, -0.075, 0.048),
           (0.725, 0.095, -0.074, 0.056), (0.775, 0.096, -0.069, 0.060), (0.815, 0.092, -0.060, 0.060),
           (0.845, 0.076, -0.047, 0.054), (0.870, 0.043, -0.024, 0.043)],
    uarm=[(0.0, 0.031, 0.032, 0.002, 0.0), (0.35, 0.030, 0.031, 0.0, 0.002), (0.65, 0.028, 0.028, 0.0, 0.001),
          (1.0, 0.024, 0.023, 0.0, 0.0)],
    farm=[(0.0, 0.025, 0.023, 0.0, 0.001), (0.25, 0.026, 0.024, 0.001, 0.0), (0.60, 0.023, 0.019, 0.001, 0.0),
          (1.0, 0.0160, 0.0125, 0.0, 0.0)],
    thigh=[(0.0, 0.050, 0.054, 0.002, 0.004), (0.25, 0.049, 0.052, 0.003, 0.005), (0.55, 0.045, 0.047, 0.001, 0.003),
           (0.85, 0.039, 0.040, -0.001, 0.000), (1.0, 0.034, 0.036, 0.0, -0.001)],
    shin=[(0.0, 0.034, 0.033, 0.0, 0.001), (0.15, 0.033, 0.034, 0.0, 0.003), (0.40, 0.031, 0.031, -0.001, 0.004),
          (0.70, 0.024, 0.024, 0.0, 0.001), (0.88, 0.019, 0.019, 0.0, 0.0), (1.0, 0.019, 0.020, 0.0, 0.0)],
    calf=(0.025, 0.050, 0.021), calfL=(0.022, 0.044, 0.019),
    glute=(0.044, 0.512, 0.044, 0.052, 0.054, 0.040), fold=0.472,
    pec=None, breast=None, lat=0.0, erector=None,
    scap=(0.054, 0.058, 0.032, 0.046, 0.014), trap=(0.021, 0.015), neckR=(0.036, 0.037), kidBelly=(0.082, 0.040),
    delt=(0.023, 0.034, 0.029), handS=0.62, footS=0.63,
    sx=0.62, sy=0.625, sz=0.66,
)

# a toddler of about two (rides in strollers): head ~1/4 of the stature, short legs, a long trunk
# with a round belly, chubby limbs, a short thick neck, short wide feet
TODDLER = dict(
    kind='toddler', sex='c', H=0.86,
    hip=(0.043, 0.378, 0.0), knee=(0.045, 0.212, -0.003), ankle=(0.047, 0.036, 0.013),
    heelZ=0.040, toeZ=-0.094, ballT=0.66,
    pelvis=(0, 0.402, 0.008), spine1=(0, 0.452, 0.014), spine2=(0, 0.532, 0.010),
    neck=(0, 0.630, 0.012), head=(0, 0.684, 0.006),
    clav=(0.009, 0.618, -0.004), shoulder=(0.073, 0.608, 0.010),
    Lu=0.142, Lf=0.112, abd=19.0, carry=0.06,
    headC=(0, 0.744, 0.006), headS=0.84, face='toddler',
    torso=[(0.346, 0.054, -0.028, 0.032), (0.374, 0.074, -0.040, 0.041), (0.404, 0.082, -0.052, 0.046),
           (0.440, 0.082, -0.062, 0.042), (0.476, 0.081, -0.067, 0.038), (0.512, 0.080, -0.065, 0.040),
           (0.546, 0.079, -0.061, 0.044), (0.576, 0.078, -0.056, 0.047), (0.600, 0.073, -0.050, 0.047),
           (0.618, 0.060, -0.040, 0.043), (0.634, 0.035, -0.020, 0.033)],
    uarm=[(0.0, 0.030, 0.030, 0.002, 0.0), (0.35, 0.029, 0.030, 0.0, 0.002), (0.65, 0.027, 0.027, 0.0, 0.001),
          (1.0, 0.022, 0.021, 0.0, 0.0)],
    farm=[(0.0, 0.023, 0.021, 0.0, 0.001), (0.25, 0.024, 0.022, 0.001, 0.0), (0.60, 0.022, 0.019, 0.001, 0.0),
          (1.0, 0.0165, 0.0135, 0.0, 0.0)],
    thigh=[(0.0, 0.046, 0.048, 0.002, 0.003), (0.25, 0.045, 0.047, 0.003, 0.004), (0.55, 0.042, 0.043, 0.001, 0.003),
           (0.85, 0.035, 0.036, -0.001, 0.000), (1.0, 0.031, 0.032, 0.0, -0.001)],
    shin=[(0.0, 0.030, 0.029, 0.0, 0.001), (0.15, 0.030, 0.030, 0.0, 0.003), (0.40, 0.029, 0.028, -0.001, 0.003),
          (0.70, 0.024, 0.023, 0.0, 0.001), (0.88, 0.020, 0.019, 0.0, 0.0), (1.0, 0.020, 0.020, 0.0, 0.0)],
    calf=(0.019, 0.034, 0.016), calfL=(0.017, 0.030, 0.014),
    glute=(0.037, 0.360, 0.036, 0.040, 0.040, 0.030), fold=0.326,
    pec=None, breast=None, lat=0.0, erector=None,
    scap=(0.043, 0.046, 0.025, 0.035, 0.010), trap=(0.017, 0.012), neckR=(0.034, 0.035), kidBelly=(0.072, 0.044),
    delt=(0.017, 0.026, 0.022), handS=0.52, footS=0.50,
    sx=0.52, sy=0.49, sz=0.58,
)

TEMPLATES = {'male': MALE, 'female': FEMALE, 'child': CHILD, 'kid': KID, 'toddler': TODDLER}
YOUNG = ('child', 'kid', 'toddler')


def cranium(face):
    """Cranium ellipsoid (centre, radii) of the head sculpt in head-local coordinates; hair and
    hats are built over it (humans_parts)."""
    # children: the brain case is large against a small face, so the eyes sit at or below the
    # middle of the head (the younger, the lower)
    if face == 'toddler':
        return np.array([0.0, 0.030, 0.010]), np.array([0.083, 0.111, 0.106])
    if face == 'kid':
        return np.array([0.0, 0.025, 0.009]), np.array([0.081, 0.108, 0.105])
    if face == 'child':
        return np.array([0.0, 0.019, 0.008]), np.array([0.0785, 0.1030, 0.1025])
    return np.array([0.0, 0.014, 0.006]), np.array([0.0745, 0.096, 0.098])


def arm_joints(T, s):
    """Rest-pose clavicle, shoulder, elbow and wrist of side s (+1 right) and the forearm axis."""
    abd = np.radians(T['abd'])
    sh = np.array([s * T['shoulder'][0], T['shoulder'][1], T['shoulder'][2]])
    cl = np.array([s * T['clav'][0], T['clav'][1], T['clav'][2]])
    du = np.array([s * np.sin(abd), -np.cos(abd), 0.0])
    el = sh + du * T['Lu'] + np.array([0, 0, 0.012 * T['sy']])
    # the forearm angles outwards at the elbow (carrying angle; wider in women) and a little forwards
    df = normalize(du + np.array([s * T['carry'], 0, -0.16]))
    wr = el + df * T['Lf']
    return cl, sh, el, wr, du, df


# ----------------------------------------------------------------------------- pieces

# head-local heights of the nostrils and the mouth line by face age (0 adult .. 1 toddler);
# the runtime paints the nostrils and the mouth line at the same heights (info faceY)
FACE_Y = {'nose': lambda yg: -0.0345 + 0.006 * yg, 'mouth': lambda yg: -0.0598 + 0.010 * yg}
FACE_AGE = {'child': 0.45, 'kid': 0.75, 'toddler': 1.0}


def head_sdf(face, build=0.0, var=None):
    """Head in local coordinates (origin at eye level on the mid plane, facing -Z).

    Built like a sculpt: cranium + a wide shallow facial mask, then jaw, chin, cheekbones,
    brow, muzzle (maxilla), nose, lips, ears. The eyeballs sit under the brow in shallow
    sockets, framed by thin upper and lower lids (the lid opening matches the one the
    runtime shader paints iris / lash line into). `var` weights the face variants:
    'narrow' (long, narrow face), 'broad' (wide, round face), 'old' (sagging cheeks, jowls,
    nasolabial folds, eye bags); the cranium never changes, so hair and hats still fit."""
    var = var or {}
    nar, brd, old = var.get('narrow', 0.0), var.get('broad', 0.0), var.get('old', 0.0)
    fem = face == 'female'
    kid = face in YOUNG
    tiny = face in ('kid', 'toddler')
    # age of the face (0 adult .. 1 toddler): a short midface and lower face, a small chin and
    # jaw, a short upturned nose with a low flat bridge, full cheeks, a soft brow, shallow sockets
    yg = FACE_AGE.get(face, 0.0)
    jaw = (0.86 if fem else (1.0 - 0.34 * yg if kid else 1.0)) * (1 - 0.10 * nar + 0.10 * brd)
    full = build * 0.006 + 0.003 * brd + 0.004 * yg
    fw = 1 - 0.07 * nar + 0.07 * brd          # face width
    chin_dy = -0.010 * nar + 0.005 * brd + 0.016 * yg      # longer / shorter lower face
    H = {'head': 1}
    R = REGION['head']
    crc, crr = cranium(face)
    cr = Ellipsoid(crc, crr, region=R, bones=H)
    mask = Ellipsoid((0, -0.022 + chin_dy * 0.4, -0.044), (0.061 * fw + full, 0.083 - chin_dy * 0.4, 0.051), region=R, bones=H)
    jw = []
    for s in (-1, 1):
        # gonion ~5 cm off the mid plane (bigonial width ~10-11 cm): the jaw narrower than the cheekbones
        gon = (s * (0.047 * jaw + 0.004 + full), -0.068 + (1 - jaw) * 0.01 + chin_dy * 0.5 - 0.006 * old, 0.004)
        jw.append(RoundCone((s * (0.057 * fw + full), -0.012, 0.012), gon, 0.014 + full, 0.013 + full, region=R, bones=H))
        jw.append(RoundCone(gon, (s * 0.022 * (jaw + 0.1), -0.099 + (1 - jaw) * 0.01 + chin_dy, -0.066), 0.013 + full, 0.012,
                            region=R, bones=H))
    chin = Ellipsoid((0, -0.097 + (1 - jaw) * 0.01 + chin_dy, -0.0745 + 0.004 * yg),
                     (0.019 * jaw + 0.004 - 0.002 * yg, 0.018 - 0.003 * yg, 0.020 - 0.003 * yg), region=R, bones=H)
    # (children: rounder, fuller cheeks set lower and further forward: the "baby fat" of the face)
    cheeks = [Ellipsoid((s * (0.046 - 0.003 * yg) * fw, -0.016 - 0.009 * old - 0.010 * yg, -0.058 - 0.004 * yg),
                        (0.020 + 0.006 * yg, 0.015 + full + 0.004 * yg, 0.021 + full + 0.002 * yg), region=R, bones=H)
              for s in (-1, 1)]
    muzzle = Ellipsoid((0, -0.058 + 0.008 * yg, -0.070 + 0.002 * yg), (0.034 * fw + full * 0.5, 0.030 - 0.006 * yg, 0.028 - 0.002 * yg),
                       region=R, bones=H)
    bh = 0.0 if (fem or kid) else 0.002
    brow = Ellipsoid((0, 0.025, -0.074 - bh + 0.004 * yg), (0.054 - 0.006 * yg, 0.0165 - 0.004 * yg, 0.0165 + bh - 0.004 * yg),
                     region=R, bones=H)
    # zygomatic arches and temples bridge the cranium and the face (no crease in front of the ears)
    zyg = [Ellipsoid((s * 0.059 * fw, -0.010, -0.024), (0.0135, 0.011, 0.030), region=R, bones=H) for s in (-1, 1)]
    tmp = [Ellipsoid((s * 0.060, 0.022, -0.036), (0.012, 0.026, 0.030), region=R, bones=H) for s in (-1, 1)]
    parts = [cr, mask] + jw + [chin] + cheeks + [muzzle] + zyg + tmp
    if old > 0:
        # jowls just below the mouth corners along the jaw line
        parts += [Ellipsoid((s * 0.040, -0.083, -0.052), (0.014, 0.012, 0.013 * old), region=R, bones=H) for s in (-1, 1)]
    skull = Union(parts, k=0.024)
    skull = Union([skull, brow], k=0.024)
    if old > 0:
        # nasolabial folds from the nose wings down past the mouth corners, slightly hollow temples
        folds = Union([RoundCone((s * 0.017, -0.036, -0.089), (s * 0.029, -0.068, -0.079), 0.0022 * old, 0.0016 * old)
                       for s in (-1, 1)])
        skull = Subtract(skull, folds, k=0.004)
        temples = Union([Ellipsoid((s * 0.074, 0.03, -0.045), (0.006, 0.016, 0.014)) for s in (-1, 1)])
        skull = Subtract(skull, temples, k=0.01 * old + 1e-4)
    ez = -0.0745
    er = 0.0118
    # shallow sockets: the eye sits ~5 mm behind the brow, the hollow does not swallow it
    # (children: barely a hollow; the eye sits almost flush under a soft brow)
    sockets = Union([Ellipsoid((s * 0.0320, 0.001, ez - 0.0125 - 0.003 * yg), (0.0155, 0.011, 0.009 - 0.003 * yg)) for s in (-1, 1)])
    skull = Subtract(skull, sockets, k=0.010 - 0.003 * yg)
    eyes = [Ellipsoid((s * 0.0320, 0.0, ez), (er, er, er), region=REGION['eye'], bones=H) for s in (-1, 1)]
    # lids: shells over the eyeball outside the almond opening (upper lid thicker), so the eye
    # reads as an object set in the face rather than a painted socket
    lids = []
    for s in (-1, 1):
        cx = s * 0.0320

        def up(P, cx=cx):
            dx = P[:, 0] - cx
            return 0.0043 - 9.0 * dx * dx - P[:, 1]

        def lo(P, cx=cx):
            dx = P[:, 0] - cx
            return P[:, 1] - (-0.0036 + 7.0 * dx * dx)
        box = ((cx - 0.02, -0.02, ez - 0.02), (cx + 0.02, 0.02, ez + 0.01))
        upper = Intersect(Ellipsoid((cx, 0.0, ez), (er + 0.0016, er + 0.0016, er + 0.0016)), Fn(up, *box), k=0.0008)
        lower = Intersect(Ellipsoid((cx, 0.0, ez), (er + 0.0007, er + 0.0007, er + 0.0007)), Fn(lo, *box), k=0.0008)
        lids += [upper, lower]
        if old > 0:
            lids.append(Ellipsoid((cx, -0.0135, ez - 0.0085), (0.011, 0.0035, 0.0035 * old + 1e-4)))   # eye bags
    for l in lids:
        l.region, l.bones = R, H
    nsc = (0.9 if fem else (1.0 - 0.42 * yg if kid else 1.0)) * (1 + 0.08 * nar - 0.04 * brd)
    N = REGION['nose']
    # (children: a short button nose with a low, flat bridge, the tip turned up so the nostrils show)
    ny = FACE_Y['nose'](yg)
    bz = -0.0880 + 0.005 * yg
    nose = Union([
        Loft((0, 0.016 - 0.012 * yg, bz), (0, ny + 0.0035, bz - 0.026 * nsc), (1, 0, 0),
             [(0.0, 0.0072 - 0.001 * yg, 0.0060 - 0.002 * yg, 0, 0.0), (0.45, 0.0074 * nsc + 0.0008, 0.0068 - 0.001 * yg, 0, 0.0),
              (1.0, 0.0105 * nsc + 0.001 + 0.001 * yg, 0.0085 * nsc, 0, 0.0)], region=N, bones=H),
        Ellipsoid((0, ny + 0.004 + 0.002 * yg, -0.0865 - 0.022 * nsc + 0.004 * yg),
                  (0.0108 * nsc * (1 + 0.1 * brd) + 0.0015 * yg, 0.0092 * nsc, 0.0100 * nsc), region=N, bones=H),
        Ellipsoid((-0.0128 * nsc - 0.001 * yg, ny, -0.0965 + (1 - nsc) * 0.006 + 0.002 * yg), (0.0080, 0.0070, 0.0085), region=N, bones=H),
        Ellipsoid((0.0128 * nsc + 0.001 * yg, ny, -0.0965 + (1 - nsc) * 0.006 + 0.002 * yg), (0.0080, 0.0070, 0.0085), region=N, bones=H),
    ], k=0.005)
    lip = 1.15 if fem else (1.0 - 0.18 * yg if kid else 1.0)
    L = REGION['lips']
    # (children: a short philtrum, a small mouth)
    my = FACE_Y['mouth'](yg) + 0.0598
    lw = 1.0 - 0.16 * yg
    lips = Union([
        Ellipsoid((0, -0.0545 + my, -0.0955 + 0.004 * yg), (0.0215 * lw, 0.0058 * lip, 0.0070), region=L, bones=H),
        Ellipsoid((0, -0.0650 + my, -0.0935 + 0.004 * yg), (0.0190 * lw, 0.0068 * lip, 0.0078), region=L, bones=H),
    ], k=0.003)
    ears = []
    for s in (-1, 1):
        Rr = rot_xyz(0, -s * 18, s * 4)
        e = Ellipsoid((s * (0.0755 + (0.004 if tiny else 0.002 if kid else 0.0)), -0.010, 0.012),
                      (0.0075, 0.029 if not kid else 0.026, 0.0170), R=Rr,
                      region=REGION['ear'], bones=H)
        concha = Ellipsoid((s * (0.0815 + (0.004 if tiny else 0.002 if kid else 0.0)), -0.016, 0.009),
                           (0.0040, 0.011, 0.0070), R=Rr)
        ears.append(Subtract(e, concha, k=0.003))
    head = Union([skull, nose], k=0.009)
    head = Union([head, lips], k=0.005)
    head = Union([head] + ears, k=0.007)
    head = Union([head] + eyes, k=0.002)
    head = Union([head] + lids, k=0.0032)
    return head


def hand_sdf(T, s, wrist, a, scale):
    """Relaxed hand hanging from the wrist along axis a, palm facing the thigh: a palm that widens
    from the wrist to the knuckles with the thenar pad at the thumb's root, four three-jointed
    fingers curled a little more at each joint (the little finger most) and the thumb resting
    along the index finger."""
    a = normalize(a)
    pn = normalize(s * np.cross(a, [0, 0, 1.0]))     # palm normal (medial)
    wd = np.array([0, 0, -1.0])
    wd = normalize(wd - a * (wd @ a) - pn * (wd @ pn))  # towards the thumb (forward)
    side = 'R' if s > 0 else 'L'
    bw = {'hand' + side: 1}
    HR = REGION['hand']
    sc = scale
    slim = 0.92 if T['sex'] == 'f' else 0.95 if T['sex'] == 'c' else 1.0
    # palm: a loft from the wrist to the knuckle line (frame x across the hand, towards the thumb)
    zs = _zsign(wrist, wrist + a, wd)
    pk = [(0.0, 0.025, 0.0135, 0.0, 0.0), (0.35, 0.032, 0.0138, 0.002, 0.0015), (0.75, 0.038, 0.0122, 0.0, 0.0015),
          (1.0, 0.037, 0.0108, -0.001, 0.0)]
    pk = [(t, rx * sc * slim, rz * sc * slim, ox * sc, oz * sc * zs) for t, rx, rz, ox, oz in pk]
    palm = Loft(wrist - a * 0.004 * sc, wrist + a * 0.090 * sc, wd, pk, n=2.5, region=HR, bones=bw)
    # thenar pad at the root of the thumb, hypothenar along the outer edge (both on the palm side)
    Rh = np.stack([wd, a, pn], axis=1)
    then = Ellipsoid(wrist + (a * 0.034 + wd * 0.019 + pn * 0.006) * sc, np.array([0.015, 0.025, 0.011]) * sc * slim, R=Rh,
                     region=HR, bones=bw)
    hypo = Ellipsoid(wrist + (a * 0.042 - wd * 0.022 + pn * 0.004) * sc, np.array([0.011, 0.030, 0.009]) * sc * slim, R=Rh,
                     region=HR, bones=bw)
    fingers = []
    # (offset across the hand, knuckle position along it, phalanx lengths, radius, curl factor)
    # (relaxed: the fingers lie together, each a little more curled than the one before it,
    # MCP ~20, PIP ~36, DIP ~16 degrees; no gaps between them)
    spec = ((0.0235, 0.000, (0.042, 0.025, 0.020), 0.0090, 0.80), (0.0080, 0.004, (0.046, 0.028, 0.021), 0.0093, 1.0),
            (-0.0080, 0.000, (0.043, 0.027, 0.020), 0.0088, 1.1), (-0.0225, -0.008, (0.034, 0.021, 0.018), 0.0079, 1.25))
    for off, da, lens, r, curl in spec:
        r = r * slim
        p = wrist + (a * (0.088 + da) + wd * off + pn * 0.001) * sc
        ang = 0.0
        rr = r
        for k, (ln, f) in enumerate(zip(lens, (20.0, 36.0, 16.0))):
            ang += np.radians(f * curl)
            d = normalize(a * np.cos(ang) + pn * np.sin(ang) - wd * off * 0.35)
            q = p + d * ln * sc
            r1 = rr * (0.93 if k < 2 else 0.80)
            fingers.append(RoundCone(p, q, rr * sc, r1 * sc, region=HR, bones=bw))
            p, rr = q, r1 * 0.98
    # thumb: adducted, lying along the radial side of the index finger with its pad against the
    # index's proximal phalanx (not held out from the hand)
    t0 = wrist + (a * 0.022 + wd * 0.019 + pn * 0.006) * sc
    t1 = t0 + normalize(a * 0.90 + wd * 0.30 + pn * 0.10) * 0.042 * sc
    t2 = t1 + normalize(a * 0.97 + wd * 0.05 + pn * 0.22) * 0.031 * sc
    t3 = t2 + normalize(a * 0.96 - wd * 0.08 + pn * 0.26) * 0.024 * sc
    thumb = [RoundCone(t0, t1, 0.0135 * sc * slim, 0.0105 * sc * slim, region=HR, bones=bw),
             RoundCone(t1, t2, 0.0100 * sc * slim, 0.0090 * sc * slim, region=HR, bones=bw),
             RoundCone(t2, t3, 0.0088 * sc * slim, 0.0072 * sc * slim, region=HR, bones=bw)]
    body = Union([palm, then, hypo], k=0.010 * sc)
    body = Union([body] + thumb, k=0.008 * sc)
    return Union([body, Union(fingers, k=0.0015 * sc)], k=0.006 * sc)


def shoe_sdf(T, s, ankle, scale):
    """Closed shoe (sandals are a shading choice at runtime), shaped per body: a raised instep
    (~7.5 cm at the lacing on a man), a heel counter round the back of the heel, a heel block
    under it and toe spring at the front (the sole curves up ~1 cm). Men: leather-shoe / sneaker
    last with a 2 cm heel; women: narrower with a shorter, lower toe box (flats); children:
    chunky sneakers with a round toe and a thick sole."""
    side = 'R' if s > 0 else 'L'
    toe_out = np.radians(6.0) * s
    heel = np.array([ankle[0] - 0.004 * s, 0.0, T['heelZ']])
    fwd = np.array([np.sin(toe_out), 0, -np.cos(toe_out)])
    L = (T['heelZ'] - T['toeZ'])
    toe = heel + fwd * L
    fs = scale
    ball = T['ballT']
    kind = T['kind']
    young = kind in YOUNG

    def bones(P):
        t = ((P - heel) @ fwd) / L
        w_toe = sstep(ball - 0.06, ball + 0.06, t)
        w_shin = 1.0 - sstep(0.06, 0.11 * fs, P[:, 1])
        w_shin *= (1 - w_toe)
        return {'toe' + side: w_toe, 'foot' + side: (1 - w_toe) * (1 - w_shin * 0.35),
                'shin' + side: (1 - w_toe) * w_shin * 0.35}

    # per-body last: width, instep and toe-box height factors, sole thickness (m, before scale)
    # at the heel / ball, toe spring (m)
    W, Hi, Ht, sh, sb, spring = {
        'male': (1.0, 1.0, 1.0, 0.024, 0.012, 0.010),
        'female': (0.93, 0.97, 0.86, 0.018, 0.010, 0.008),
    }.get(kind, (1.07, 1.04, 1.12, 0.022, 0.017, 0.007))
    # upper: (t, half width, half height, lateral offset, centre height) from the heel to the toe
    keys = [(0.00, 0.031, 0.034, 0.0, 0.052), (0.06, 0.035, 0.044, 0.0, 0.060), (0.30, 0.040 * W, 0.050 * Hi, 0.0, 0.058),
            (0.55, 0.046 * W, 0.040 * Hi, 0.004 * s, 0.046), (0.75, 0.047 * W, 0.028 * Ht, 0.004 * s, 0.033),
            (0.90, 0.042 * W, 0.022 * Ht, 0.002 * s, 0.027), (1.00, (0.030 if not young else 0.034) * W, 0.016 * Ht, 0.0, 0.022 + spring * 0.6)]
    keys = [(t, rx * fs, rz * fs, ox * fs, oz * fs) for t, rx, rz, ox, oz in keys]
    upper = Loft(heel, toe, (1, 0, 0), keys, n=2.4, region=REGION['foot'], bones=bones)
    # sole: heel block (men's shoes: a distinct heel ending at the waist of the sole), thinner
    # under the ball, then curving up at the toe (toe spring)
    hb = sh - sb
    skeys = [(0.0, 0.034, sh / 2, 0, sh / 2), (0.15, 0.037, sh / 2, 0, sh / 2),
             (0.30, 0.038, (sb + hb * 0.55) / 2, 0.002 * s, (sb + hb * 0.55) / 2 + hb * 0.45),
             (0.45, 0.041, sb / 2 + 0.0005, 0.003 * s, sb / 2 + 0.0015), (0.75, 0.049 * W, sb / 2, 0.004 * s, sb / 2),
             (0.90, 0.044 * W, sb / 2, 0.002 * s, sb / 2 + spring * 0.35), (1.0, 0.032 * W, sb / 2, 0, sb / 2 + spring)]
    skeys = [(t, rx * fs, rz * fs, ox * fs, oz * fs) for t, rx, rz, ox, oz in skeys]
    sole = Loft(heel - fwd * 0.004, toe + fwd * 0.004, (1, 0, 0), skeys, n=3.0, region=REGION['foot'], bones=bones)
    # heel counter: the stiffened cup round the back of the heel
    counter = Ellipsoid(heel + fwd * 0.032 * fs + np.array([0, 0.042 * fs, 0]), np.array([0.033, 0.036, 0.034]) * fs,
                        region=REGION['foot'], bones=bones)
    shoe = Union([upper, counter], k=0.010 * fs)
    shoe = Union([shoe, sole], k=0.004)
    return Intersect(shoe, HalfSpace((0, 0.0, 0), (0, -1, 0)), k=0.002)


def _zsign(A, B, hint):
    """+1 when the loft frame z axis points backwards (+Z world) for this segment."""
    from humans_sdf import rot_frame
    return float(np.sign(rot_frame(np.asarray(B) - np.asarray(A), hint)[2][2]) or 1.0)


def surface_z(node, x, y, side, z0=0.0, zmax=0.35):
    """z of the surface of `node` crossed going from (x, y, z0) towards +Z (side +1) or -Z (-1)."""
    a, b = z0, z0 + side * zmax
    P = lambda z: np.array([[x, y, z]], np.float32)
    if node.eval(P(a))[0] > 0:
        return a
    for _ in range(40):
        m = 0.5 * (a + b)
        if node.eval(P(m))[0] < 0:
            a = m
        else:
            b = m
    return 0.5 * (a + b)


def limb_keys(rows, zsign, grow=(0.0, 0.0)):
    """Limb keys (t, rx, rz, lateral, back) -> loft keys in the segment frame (+ build growth)."""
    g0, g1 = grow
    return [(t, rx + g0 * (1 - t) + g1 * t, rz + g0 * (1 - t) + g1 * t, ox, oz * zsign) for t, rx, rz, ox, oz in rows]


def build_body(kind='male', build=0.0, belly=0.0, face_var=None):
    T = TEMPLATES[kind]
    b = build
    sex = T['sex']
    fem, child = sex == 'f', sex == 'c'
    sx, sy, sz = T['sx'], T['sy'], T['sz']
    H = T['H']
    J = {'root': np.zeros(3)}
    for k in ('pelvis', 'spine1', 'spine2', 'neck', 'head'):
        J[k] = v3(T[k])
    sh_y = T['shoulder'][1]
    hip_y = T['hip'][1]

    # ---- torso core: a lofted superellipse along +Y (frame z = +Z world, so offsets are world z)
    ys = np.array([k[0] for k in T['torso']])
    y0, y1 = ys[0], ys[-1]
    keys = []
    for y, rx, zf, zb in T['torso']:
        u = (y - y0) / (y1 - y0)
        if fem:     # heavy: hips, seat and thighs first, then the waist and the bust line
            gx = b * (0.012 + 0.030 * gauss(u, 0.18, 0.18) + 0.012 * gauss(u, 0.5, 0.2))
            gf = b * (0.010 + 0.034 * gauss(u, 0.40, 0.18))
            gb = b * (0.008 + 0.026 * gauss(u, 0.15, 0.17))
        else:       # heavy: belly and waist (the chest barely changes, the hips little)
            gx = b * (0.010 + 0.034 * gauss(u, 0.47, 0.20))
            gf = b * (0.010 + 0.052 * gauss(u, 0.40, 0.20))
            gb = b * (0.006 + 0.016 * gauss(u, 0.42, 0.22))
        zf2, zb2 = zf - gf * sz, zb + gb * sz
        keys.append((u, rx + gx * sx, 0.5 * (zb2 - zf2), 0.0, 0.5 * (zb2 + zf2)))

    def torso_bones(P):
        y = P[:, 1]
        wp = 1 - sstep(J['pelvis'][1], J['spine1'][1] + 0.03 * sy, y)
        ws2 = sstep(J['spine1'][1] + 0.06 * sy, J['spine2'][1] + 0.02 * sy, y)
        ws1 = np.clip(1 - wp - ws2, 0, 1)
        wc = sstep(sh_y - 0.09 * sy, sh_y - 0.01 * sy, y) * sstep(0.06 * sx, 0.14 * sx, np.abs(P[:, 0])) * 0.7
        return {'pelvis': wp * (1 - wc), 'spine1': ws1 * (1 - wc), 'spine2': ws2 * (1 - wc),
                'clavL': np.where(P[:, 0] < 0, wc, 0.0), 'clavR': np.where(P[:, 0] >= 0, wc, 0.0)}

    TR = REGION['torso']
    core = Loft((0, y0, 0), (0, y1, 0), (1, 0, 0), keys, n=2.2, region=TR, bones=torso_bones)
    zb_at = lambda y, x=0.0: surface_z(core, x, y, +1)
    zf_at = lambda y, x=0.0: surface_z(core, x, y, -1)
    waist_y = float(ys[4]) if not child else float(ys[4])
    tparts = [core]
    feats_back = []
    for s in (-1, 1):
        side = 'R' if s > 0 else 'L'
        # glutes: gluteus maximus, max projection a little below the hip joint; their lower edge
        # makes the gluteal fold over the hamstrings
        gx, gy, gz, rx, ry, rz = T['glute']
        # (men: a flatter seat than women's)
        gzc = zb_at(gy, s * gx) + (0.038 if fem else 0.031 if not child else 0.024) * sz - rz + b * (0.016 if fem else 0.008) * sz
        tparts.append(Ellipsoid((s * gx * (1 + 0.06 * b), gy, gzc),
                                (rx + b * 0.014 * sx, ry + b * 0.010 * sy, rz + b * 0.014 * sz),
                                R=rot_xyz(-8 if fem else -4, s * 10, 0), region=REGION['butt'],
                                bones={'pelvis': 0.65, 'thigh' + side: 0.35}))
        if T['pec']:
            px, py, prx, pry, prz = T['pec']
            tparts.append(Ellipsoid((s * px, py, zf_at(py, s * px) + prz - 0.0025 - b * 0.008),
                                    (prx + b * 0.008, pry + b * 0.012, prz + b * 0.01),
                                    R=rot_xyz(0, s * -10, s * 18), region=TR, bones={'spine2': 1}))
        if T['breast']:
            bx, by, brx, bry, brz = T['breast']
            tparts.append(Ellipsoid((s * bx, by, zf_at(by, s * bx) + brz - 0.036 - b * 0.006),
                                    (brx + b * 0.012, bry + b * 0.010, brz + b * 0.012),
                                    R=rot_xyz(-14, s * 12, 0), region=REGION['breast'], bones={'spine2': 1}))
        # shoulder blades: flat triangular plates over the ribs, the inferior angle tipped in
        # towards the spine; they ride with the clavicle a little
        cx, cyo, crx, cry, crz = T['scap']
        cy = sh_y - cyo
        feats_back.append(Ellipsoid((s * cx, cy, zb_at(cy, s * cx) - crz + (0.0032 if fem else 0.0045) * sz),
                                    (crx, cry, crz), R=rot_xyz(0, s * 12, s * -10), region=TR,
                                    bones={'spine2': 0.7, 'clav' + side: 0.3}))
        # latissimus: the V from under the arm pit to the waist (men most)
        if T['lat'] > 0:
            la = T['lat']
            ya, yb = sh_y - 0.125 * sy, waist_y + 0.07 * sy
            xa, xb = 0.140 * sx, 0.122 * sx
            feats_back.append(RoundCone((s * xa, ya, 0.42 * zb_at(ya, s * xa)), (s * xb, yb, 0.42 * zb_at(yb, s * xb)),
                                        la * 1.25, la * 0.75, region=TR, bones=torso_bones))
        # erector spinae: two columns either side of the lumbar spine
        if T['erector']:
            ex, eh, ez = T['erector']
            ey = waist_y + 0.01 * sy
            feats_back.append(Ellipsoid((s * ex * 1.25, ey, zb_at(ey, s * ex) + ez * 0.25), (ex, eh, ez),
                                        region=TR, bones=torso_bones))
    if T['kidBelly']:
        kr, kz = T['kidBelly']
        by = J['spine1'][1] - 0.02 * sy
        tparts.append(Ellipsoid((0, by, zf_at(by) + kz * 0.9), (kr, kr * 1.15, kz), region=TR,
                                bones={'pelvis': 0.4, 'spine1': 0.6}))
    if b > 0 and not fem:
        tparts.append(Ellipsoid((0, hip_y + 0.17 * sy, -0.05 * sz), (0.12 * sx, 0.12 * sy, (0.08 * b + 0.02) * sz),
                                region=TR, bones={'pelvis': 0.4, 'spine1': 0.6}))
    if belly > 0:
        # a round gut that sits on the belt line (the "belly" shape morph)
        tparts.append(Ellipsoid((0, hip_y + 0.16 * sy, -0.045 * sz), (0.125 * sx, 0.125 * sy, (0.10 * belly) * sz),
                                region=TR, bones={'pelvis': 0.4, 'spine1': 0.6}))
    torso = Union(tparts, k=0.032 * sy)
    if feats_back:
        torso = Union([torso] + feats_back, k=0.030 * sy)

    # ---- neck, vertebra prominens, trapezius slope (neck -> acromion)
    nr = T['neckR']
    nb = J['neck'] + np.array([0, -0.02, -0.004]) * sy
    nt = J['head'] + np.array([0, 0.035, -0.012]) * T['headS']

    def neck_bones(P):
        u = np.clip((P[:, 1] - nb[1]) / (nt[1] - nb[1]), 0, 1)
        wh = sstep(0.55, 1.0, u)
        ws = 1 - sstep(0.0, 0.35, u)
        return {'head': wh, 'neck': np.clip(1 - wh - ws, 0, 1), 'spine2': ws}

    # (men: the neck flares into the trapezius at its base, wider than it is higher up)
    flare = 0.010 if sex == 'm' else 0.004 if fem else 0.002
    neck = Loft(nb, nt, (1, 0, 0), [(0, nr[0] + flare + b * 0.012, nr[1] + b * 0.012, 0, 0.006),
                                    (0.3, nr[0] * 0.97 + flare * 0.3 + b * 0.011, nr[1] * 0.97 + b * 0.012, 0, 0.002),
                                    (0.6, nr[0] * 0.94 + b * 0.01, nr[1] * 0.96 + b * 0.012, 0, 0.0),
                                    (1.0, nr[0] * 0.92 + b * 0.008, nr[1] * 0.95 + b * 0.012, 0, -0.004)],
                region=REGION['neck'], bones=neck_bones)
    traps = []
    ta, tb = T['trap']
    # the upper trapezius: a sloping tent from high on the back of the neck down to the acromion
    # (about 18 degrees for men, 11 for women), so the shoulder line falls away from the neck
    # instead of running out level to a corner
    rise = 0.004 * sy if sex == 'm' else 0.0
    for s in (-1, 1):
        side = 'R' if s > 0 else 'L'
        a = np.array([s * nr[0] * 0.6, J['neck'][1] + rise, J['neck'][2] + nr[1] * 0.36])
        m = np.array([s * (nr[0] * 0.6 + 0.45 * (T['shoulder'][0] - nr[0] * 0.6)), J['neck'][1] + 0.35 * rise - 0.007 * sy,
                      J['neck'][2] + nr[1] * 0.24])
        bpt = np.array([s * (T['shoulder'][0] - 0.016 * sx), sh_y + 0.004 * sy, T['shoulder'][2] - 0.002])
        tw = {'bones': {'spine2': 0.55, 'clav' + side: 0.45}}
        traps.append(RoundCone(a, m, ta * 1.06 + b * 0.009, (ta + tb) * 0.5 + b * 0.007, region=TR, **tw))
        traps.append(RoundCone(m, bpt, (ta + tb) * 0.5 + b * 0.007, tb + b * 0.006, region=TR, **tw))
    c7 = Ellipsoid((0, J['neck'][1] - 0.004 * sy, J['neck'][2] + nr[1] * 0.78), (0.010 * sx, 0.012 * sy, 0.010 * sz),
                   region=TR, bones={'spine2': 1})
    torso = Union([torso, Union(traps, k=0.02 * sy)], k=0.028 * sy)
    body = Union([torso, neck], k=0.028 * sy)
    body = Union([body, c7], k=0.010 * sy)

    # ---- head
    head = Xform(head_sdf(T['face'], b, face_var), T['headS'], T['headC'])
    body = Union([body, head], k=0.022 * T['headS'])

    # ---- arms (A-pose)
    arms = []
    for s in (-1, 1):
        side = 'R' if s > 0 else 'L'
        cl, sh, el, wr, du, df = arm_joints(T, s)
        J['clav' + side], J['arm' + side], J['fore' + side], J['hand' + side] = cl, sh, el, wr
        zu = _zsign(sh, el, (s, 0, 0))
        zf = _zsign(el, wr, (s, 0, 0))
        uk = limb_keys(T['uarm'], zu, (b * 0.012, b * 0.006))
        fk = limb_keys(T['farm'], zf, (b * 0.006, 0.0))
        ua = Loft(sh + du * 0.01, el, (s, 0, 0), uk, region=REGION['uarm'], bones={'arm' + side: 1})
        # deltoid cap: its top stays ~3 cm above the joint so the shoulder line slopes below the neck
        dx, dy, dz = T['delt']
        # (the cap rounds the shoulder off below the acromion: about a third less lateral bulge
        # than a gym-built deltoid, so sleeves drape over it instead of stepping out)
        delt = Ellipsoid(sh + du * 0.030 + np.array([-s * 0.002 * sx, -0.012 * sy, 0.002]),
                         (dx * 0.68 + b * 0.008, dy * 0.95, dz * 0.88 + b * 0.006),
                         R=rot_xyz(0, 0, s * T['abd']), region=REGION['uarm'],
                         bones={'arm' + side: 0.7, 'clav' + side: 0.3})
        # olecranon: the point of the elbow behind the joint
        olec = Ellipsoid(el + np.array([0, 0.006 * sy, 0.024 * sz]), (0.017 * sx, 0.020 * sy, 0.011 * sz),
                         region=REGION['farm'], bones={'fore' + side: 0.6, 'arm' + side: 0.4})
        fa = Loft(el, wr, (s, 0, 0), fk, region=REGION['farm'], bones={'fore' + side: 1})
        hand = hand_sdf(T, s, wr, df + np.array([0, 0, -0.05]), T['handS'])
        arm = Union([Union([delt, ua], k=0.03 * sy), fa, olec], k=0.010 * sy)
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
        r0 = T['thigh'][0]
        tk = [(0.0, r0[1] * 0.6, r0[2] * 0.68, 0.0, 0.0)]
        gl = (b * (0.030 if fem else 0.013), b * 0.006)
        tk += [(t0 + t * (1 - t0), rx + gl[0] * (1 - t * 0.75), rz + gl[0] * (1 - t * 0.75), ox + (b * 0.008 if fem else 0) * (1 - t), oz * zt)
               for t, rx, rz, ox, oz in T['thigh']]
        sk = limb_keys(T['shin'], zs, (b * 0.008, b * 0.002))
        th = Loft(top, kn, (s, 0, 0), tk, region=REGION['thigh'], bones={'thigh' + side: 1})
        pat = Ellipsoid(kn + np.array([0, 0.012 * sy, -0.040 * sz]), (0.026 * sx, 0.030 * sy, 0.016 * sz),
                        region=REGION['thigh'], bones={'thigh' + side: 0.45, 'shin' + side: 0.55})
        # vastus medialis: the teardrop above the inner knee
        vm = Ellipsoid(kn + np.array([-s * 0.022 * sx, 0.075 * sy, -0.018 * sz]), (0.030 * sx, 0.055 * sy, 0.030 * sz),
                       region=REGION['thigh'], bones={'thigh' + side: 1})
        sh_ = Loft(kn, an + np.array([0, -0.01, 0]), (s, 0, 0), sk, region=REGION['shin'], bones={'shin' + side: 1})
        # two-headed calf: the inner (medial) head bigger and lower than the outer one
        cx, cy, cz = T['calf']
        lx, ly, lz = T['calfL']
        Ls = kn[1] - an[1]
        calf_m = Ellipsoid(kn + np.array([-s * 0.016 * sx, -0.30 * Ls, 0.030 * sz]), (cx + b * 0.006, cy, cz + b * 0.006),
                           R=rot_xyz(4, 0, 0), region=REGION['shin'], bones={'shin' + side: 1})
        calf_l = Ellipsoid(kn + np.array([s * 0.016 * sx, -0.25 * Ls, 0.026 * sz]), (lx + b * 0.005, ly, lz + b * 0.005),
                           R=rot_xyz(4, 0, 0), region=REGION['shin'], bones={'shin' + side: 1})
        leg = Union([th, pat, vm], k=0.02 * sy)
        leg = Union([leg, Union([sh_, calf_m, calf_l], k=0.026 * sy)], k=0.008 * sy)
        leg = Union([leg, shoe_sdf(T, s, an, T['footS'])], k=0.008)
        legs.append(leg)
    body = Union([body, Union(legs, k=0.0)], k=0.03 * sy)

    # ---- carved details: spine furrow, intergluteal cleft, gluteal folds
    cuts = []
    gx, gy, gz, grx, gry, grz = T['glute']
    yA, yB = hip_y + 0.06 * sy, J['neck'][1] - 0.05 * sy
    path_y = np.linspace(yA, yB, 7)
    pts = []
    for y in path_y:
        u = (y - yA) / (yB - yA)
        depth = (0.0032 if not child else 0.0015) * (0.7 if fem else 1.0) * (1 - sstep(0.25, 0.7, u)) + 0.0008
        r = 0.008 * sx
        pts.append((np.array([0.0, y, surface_z(body, 0.0, y, +1) + r - depth]), r))
    for (p0, r0_), (p1, r1_) in zip(pts[:-1], pts[1:]):
        cuts.append(RoundCone(p0, p1, r0_, r1_))
    body = Subtract(body, Union(cuts), k=0.010 * sx)
    cuts = []
    cleft_top, cleft_bot = gy + 0.070 * sy, T['fold'] - 0.005
    zc = surface_z(body, 0.0, 0.5 * (cleft_top + cleft_bot), +1)
    cuts.append(Ellipsoid((0, 0.5 * (cleft_top + cleft_bot), zc + 0.010), (0.0035 * sx, 0.5 * (cleft_top - cleft_bot), 0.018 * sz)))
    body = Subtract(body, Union(cuts), k=0.008 * sx)

    skel = {'bones': BONES, 'parent': [BONES.index(PARENT[n]) if PARENT[n] else -1 for n in BONES],
            'joints': [[float(x) for x in J[n]] for n in BONES]}
    hc = np.array(T['headC'], dtype=float)
    hs = T['headS']
    eye = lambda s: (hc + hs * np.array([s * 0.0320, 0.0, -0.0745])).tolist()
    crc, crr = cranium(T['face'])
    info = {'H': H, 'kind': kind, 'headC': hc.tolist(), 'headS': hs, 'eyeL': eye(-1), 'eyeR': eye(1),
            'eyeRadius': 0.0118 * hs, 'face': T['face'], 'sx': sx, 'sy': sy,
            'hip': list(T['hip']), 'knee': list(T['knee']), 'ankle': list(T['ankle']), 'shoulder': list(T['shoulder']),
            'waistY': float(waist_y), 'neckY': float(J['neck'][1]), 'torsoY': [float(y0), float(y1)],
            'heelZ': T['heelZ'], 'toeZ': T['toeZ'], 'Lu': T['Lu'], 'Lf': T['Lf'], 'abd': T['abd'],
            'cranium': [crc.tolist(), crr.tolist()],
            'faceY': [FACE_Y['nose'](FACE_AGE.get(T['face'], 0.0)), FACE_Y['mouth'](FACE_AGE.get(T['face'], 0.0)),
                      FACE_AGE.get(T['face'], 0.0)]}
    return body, skel, info
