"""Crowd character generator: MPFB2 (MakeHuman for Blender) driven headless -> assets/humans_mh/.

  TRAM_TOOLS_IMAGE=tramline-mh:latest tools/dk blender -b -P tools/blender/mh_build.py -- \
      [--stages chars,tex,export,preview] [--only m01,f02] [--jobs 8] [--blend]

Stages
  chars    one Blender process per character (mh_cast.CAST): MakeHuman body from macros + shape targets,
           the game_engine rig, CC0 clothes / hair / eyebrows / eyelashes / eyes / hat, garment edits
           (sleeves and trouser legs cut, skirts lengthened, mixed tops and bottoms, body skin hidden only
           where a kept garment covers it), then the rest pose of the runtime skeleton (arms hanging, elbows
           and fingers relaxed) is applied and the skin weights are converted to the runtime's 22 bones
           (src/crowd/humans/anim.js). Clean-up: pockets, slits and vents closed; skin kept under hems and
           cuffs (a raised arm opens a sleeve) and sunk under the cloth elsewhere; feet inside the shoes
           dropped; fringes trimmed clear of the eyes (strand ends fade); hats seated low on the brow; skin
           decals per vertex (beard growth, hair-coloured scalp) instead of stubble shells.
           Writes <work>/raw/<id>.npz + <id>.json (--work, default .work/mh; --out, default assets/humans_mh).
  tex      mh_tex.py: shared texture arrays (skins, garments, hair, misc atlas), WebP strips.
  export   mh_export.py: LODs (meshoptimizer), per-vertex AO, quantised geometry -> assets/humans_mh/.
  preview  mh_preview.py: Cycles lineup render of the exported cast (front / side / back).

Everything is deterministic (no random numbers; MPFB runs with fixed inputs).
"""
import os
import sys
import json
import math
import time
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mh_cast as CASTM  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
ASSETS = '/opt/mh/system_assets'
WORK, OUT = CASTM.stage_dirs()
RAW = os.path.join(WORK, 'raw')

# runtime skeleton (src/crowd/humans/anim.js BONE): L = the figure's left = -X in three.js
RT_BONES = ['root', 'pelvis', 'spine1', 'spine2', 'neck', 'head',
            'clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR',
            'thighL', 'shinL', 'footL', 'toeL', 'thighR', 'shinR', 'footR', 'toeR']
RT_PARENT = [-1, 0, 1, 2, 3, 4, 3, 6, 7, 8, 3, 10, 11, 12, 1, 14, 15, 16, 1, 18, 19, 20]
RB = {n: i for i, n in enumerate(RT_BONES)}

# MPFB game_engine bone -> runtime bone weights (fingers fold into the hand; spine_02 is shared by
# the lumbar and thoracic runtime bones). Blender '_l' is the character's left.
GE_MAP = {'Root': {'root': 1}, 'pelvis': {'pelvis': 1}, 'spine_01': {'spine1': 1}, 'spine_02': {'spine1': 0.5, 'spine2': 0.5},
          'spine_03': {'spine2': 1}, 'neck_01': {'neck': 1}, 'head': {'head': 1}}
for s, S in (('l', 'L'), ('r', 'R')):
    GE_MAP.update({f'clavicle_{s}': {f'clav{S}': 1}, f'upperarm_{s}': {f'arm{S}': 1}, f'lowerarm_{s}': {f'fore{S}': 1},
                   f'hand_{s}': {f'hand{S}': 1}, f'thigh_{s}': {f'thigh{S}': 1}, f'calf_{s}': {f'shin{S}': 1},
                   f'foot_{s}': {f'foot{S}': 1}, f'ball_{s}': {f'toe{S}': 1}})
    for f in ('thumb', 'index', 'middle', 'ring', 'pinky'):
        for j in (1, 2, 3):
            GE_MAP[f'{f}_0{j}_{s}'] = {f'hand{S}': 1}
# runtime joint <- game_engine bone head
RT_JOINT_SRC = {'pelvis': 'pelvis', 'spine1': 'spine_01', 'spine2': 'spine_03', 'neck': 'neck_01', 'head': 'head'}
for s, S in (('l', 'L'), ('r', 'R')):
    RT_JOINT_SRC.update({f'clav{S}': f'clavicle_{s}', f'arm{S}': f'upperarm_{s}', f'fore{S}': f'lowerarm_{s}',
                         f'hand{S}': f'hand_{s}', f'thigh{S}': f'thigh_{s}', f'shin{S}': f'calf_{s}',
                         f'foot{S}': f'foot_{s}', f'toe{S}': f'ball_{s}'})


def log(*a):
    print('[mh]', *a, flush=True)


def script_args():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else []


def parse(argv):
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--stages', default='chars,tex,export,preview')
    p.add_argument('--only', default='')
    p.add_argument('--jobs', type=int, default=8)
    p.add_argument('--one', default='')
    p.add_argument('--blend', action='store_true', help='also save .work/mh/raw/<id>.blend')
    p.add_argument('--work', default=WORK, help='working directory (raw/, tex/, lod/)')
    p.add_argument('--out', default=OUT, help='web asset directory')
    p.add_argument('--debug-holes', action='store_true', help='log the garments\' open loops')
    return p.parse_args(argv)


# ============================================================================= driver

def run_driver(args):
    ids = [i for i in args.only.split(',') if i] or list(CASTM.CAST.keys())
    stages = args.stages.split(',')
    t0 = time.time()
    if 'chars' in stages:
        os.makedirs(RAW, exist_ok=True)
        blender = None
        try:
            import bpy
            blender = bpy.app.binary_path
        except ImportError:
            blender = 'blender'
        pending = list(ids)
        running = []
        failed = []
        while pending or running:
            while pending and len(running) < args.jobs:
                cid = pending.pop(0)
                cmd = [blender, '-b', '-P', os.path.abspath(__file__), '--', '--one', cid, '--work', WORK] + (['--blend'] if args.blend else [])
                lf = open(os.path.join(RAW, cid + '.log'), 'w')
                running.append((cid, subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT), lf))
            time.sleep(0.5)
            for r in list(running):
                if r[1].poll() is not None:
                    r[2].close()
                    running.remove(r)
                    ok = r[1].returncode == 0 and os.path.exists(os.path.join(RAW, r[0] + '.json'))
                    log(f'char {r[0]} {"ok" if ok else "FAILED (see .work/mh/raw/" + r[0] + ".log)"}')
                    if not ok:
                        failed.append(r[0])
        if failed:
            raise SystemExit('characters failed: ' + ','.join(failed))
        log(f'chars done in {time.time() - t0:.0f}s')
    py = 'python3'
    if 'tex' in stages:
        subprocess.check_call([py, os.path.join(HERE, 'mh_tex.py'), '--work', WORK, '--out', OUT])
    if 'export' in stages:
        subprocess.check_call([py, os.path.join(HERE, 'mh_export.py'), '--work', WORK, '--out', OUT])
    if 'preview' in stages:
        subprocess.check_call([bpy_binary(), '-b', '-P', os.path.join(HERE, 'mh_preview.py'), '--', '--src', OUT])
    log(f'all done in {time.time() - t0:.0f}s')


def bpy_binary():
    try:
        import bpy
        return bpy.app.binary_path
    except ImportError:
        return 'blender'


# ============================================================================= one character (inside Blender)

def build_one(cid, save_blend=False):
    import bpy
    import numpy as np
    from mathutils import Vector, Matrix
    from mathutils.kdtree import KDTree
    from bl_ext.user_default.mpfb.services.humanservice import HumanService
    from bl_ext.user_default.mpfb.services.targetservice import TargetService
    from bl_ext.user_default.mpfb.services.locationservice import LocationService

    spec = CASTM.CAST[cid]
    t0 = time.time()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)

    # ---------------------------------------------------------------- body
    macro = TargetService.get_default_macro_info_dict()
    macro.update(gender=1.0 if spec['sex'] == 'm' else 0.0, age=CASTM.mh_age(spec['age']), muscle=spec['muscle'],
                 weight=spec['weight'], height=spec['height'], proportions=spec['prop'], cupsize=spec['cup'],
                 firmness=spec['firm'])
    cau, afr, asi = spec['anc']
    tot = cau + afr + asi
    macro['race'] = {'caucasian': cau / tot, 'african': afr / tot, 'asian': asi / tot}
    bm = HumanService.create_human(mask_helpers=False, detailed_helpers=True, extra_vertex_groups=True,
                                   feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
    tdir = LocationService.get_mpfb_data('targets')
    for name, w in sorted(spec['targets'].items()):
        path = os.path.join(tdir, name + '.target.gz')
        if not os.path.exists(path):
            raise IOError('missing target ' + name)
        TargetService.load_target(bm, path, weight=float(w), name=os.path.basename(name))
    fit_stature(bm, CASTM.stature(spec))
    rig = HumanService.add_builtin_rig(bm, 'game_engine', import_weights=True)

    # ---------------------------------------------------------------- assets
    def add(path, typ):
        return HumanService.add_mhclo_asset(path, bm, asset_type=typ, subdiv_levels=0, material_type='NONE')

    parts = []          # (object, kind, info)
    parts.append((add(f'{ASSETS}/eyes/low-poly/low-poly.mhclo', 'Eyes'), 'eyes', {}))
    if spec['brows']:
        parts.append((add(f'{ASSETS}/eyebrows/{spec["brows"]}/{spec["brows"]}.mhclo', 'Eyebrows'), 'brows', {}))
    if spec['lashes']:
        parts.append((add(f'{ASSETS}/eyelashes/{spec["lashes"]}/{spec["lashes"]}.mhclo', 'Eyelashes'), 'lashes', {}))
    if spec['hair']:
        parts.append((add(f'{ASSETS}/hair/{spec["hair"]}/{spec["hair"]}.mhclo', 'Hair'), 'hair', {}))
    suits = {}
    for g in (spec['top'], spec['bottom']):
        if g and g['suit'] not in suits:
            suits[g['suit']] = add(f'{ASSETS}/clothes/{g["suit"]}/{g["suit"]}.mhclo', 'Clothes')
    for name, ob in suits.items():
        parts.append((ob, 'suit', {'suit': name}))
    parts.append((add(f'{ASSETS}/clothes/{spec["shoes"]}/{spec["shoes"]}.mhclo', 'Clothes'), 'shoes', {}))
    if spec['hat']:
        parts.append((add(f'{ASSETS}/clothes/{spec["hat"]}/{spec["hat"]}.mhclo', 'Clothes'), 'hat', {}))
    for m in list(bm.modifiers):
        if m.type == 'MASK':
            bm.modifiers.remove(m)
    log(cid, f'assembled in {time.time() - t0:.1f}s')

    # ---------------------------------------------------------------- rest pose of the runtime skeleton
    pose_relaxed(rig, spec)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()

    def bone_head(name):
        return np.array(rig.matrix_world @ rig.pose.bones[name].head)

    def bone_tail(name):
        return np.array(rig.matrix_world @ rig.pose.bones[name].tail)

    bone_names = [b.name for b in rig.data.bones]

    def extract(ob):
        eo = ob.evaluated_get(dg)
        me = eo.to_mesh()
        n = len(me.vertices)
        co = np.zeros(n * 3, np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        nr = np.zeros(n * 3, np.float32)
        me.vertex_normals.foreach_get('vector', nr)
        nr = nr.reshape(-1, 3)
        mw = np.array(eo.matrix_world)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        nr = nr @ np.linalg.inv(mw[:3, :3])
        nr /= np.maximum(1e-9, np.linalg.norm(nr, axis=1, keepdims=True))
        eo.to_mesh_clear()
        src = ob.data
        if len(src.vertices) != n:
            raise RuntimeError(f'{ob.name}: evaluated vertex count differs ({n} vs {len(src.vertices)})')
        L = len(src.loops)
        vi = np.zeros(L, np.int32)
        src.loops.foreach_get('vertex_index', vi)
        uv = np.zeros(L * 2, np.float32)
        src.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        P = len(src.polygons)
        ls = np.zeros(P, np.int32)
        lt = np.zeros(P, np.int32)
        src.polygons.foreach_get('loop_start', ls)
        src.polygons.foreach_get('loop_total', lt)
        # bone weights (game_engine groups) -> dense (n, len(bone_names))
        gi = {g.index: g.name for g in ob.vertex_groups}
        bidx = {b: i for i, b in enumerate(bone_names)}
        W = np.zeros((n, len(bone_names)), np.float32)
        groups = {}
        for v in src.vertices:
            for g in v.groups:
                nm = gi.get(g.group)
                if nm in bidx:
                    W[v.index, bidx[nm]] = g.weight
                elif nm is not None and g.weight > 0:
                    groups.setdefault(nm, []).append((v.index, g.weight))
        return dict(co=co, nr=nr, vi=vi, uv=uv, ls=ls, lt=lt, W=W, groups=groups, name=ob.name)

    body = extract(bm)
    pdata = [(extract(ob), kind, info) for ob, kind, info in parts]
    kscale = max(0.45, CASTM.stature(spec) / 1.75)

    # joints (Blender space) for the runtime skeleton
    J = {}
    for rt, ge in RT_JOINT_SRC.items():
        J[rt] = bone_head(ge)
    J['root'] = np.array([0.0, 0.0, 0.0])
    toe_tip = {s: bone_tail(f'ball_{s}') for s in ('l', 'r')}
    head_top_bone = bone_tail('head')
    for d, kind, info in pdata:
        if kind == 'suit':
            n = fill_small_holes(d, 0.11 * kscale, J, kscale)
            if n:
                log(cid, f'{info["suit"]}: filled {n} holes (pockets, slits)')
            n = zip_slits(d, kscale, 0.5 * (J['thighL'][2] + J['thighR'][2]))
            if n:
                log(cid, f'{info["suit"]}: closed {n} notches')
    # head landmarks: the eyes' centre, the face's front surface (for hair and hats); head scale from the
    # distance between the eyes (children's heads are relatively big)
    eyes_co = [d for d, kind, _ in pdata if kind == 'eyes'][0]['co']
    E = eyes_co.mean(0)
    ipd = float(eyes_co[eyes_co[:, 0] > E[0], 0].mean() - eyes_co[eyes_co[:, 0] < E[0], 0].mean())
    hk = max(0.6, ipd / 0.064)
    for d, kind, info in pdata:
        if kind == 'hair':
            clear_face_window(d, body, E, hk, spec['hair'], cid)
        elif kind == 'hat':
            refit_hat(d, body, E, hk, cid)
    log(cid, f'extracted in {time.time() - t0:.1f}s')

    # ---------------------------------------------------------------- per-part processing
    ge_index = {b: i for i, b in enumerate(bone_names)}

    def share(W, names):
        idx = [ge_index[n] for n in names if n in ge_index]
        tot = W.sum(1) + 1e-9
        return W[:, idx].sum(1) / tot

    LEG = [b for b in bone_names if b.startswith(('thigh', 'calf', 'foot', 'ball'))]
    ARM = [b for b in bone_names if b.startswith(('upperarm', 'lowerarm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky'))]
    waist_z = float(J['spine1'][2])

    def components(d):
        """Connected components over polygons (vertex sharing)."""
        n = len(d['co'])
        parent = np.arange(n)

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        for p in range(len(d['ls'])):
            vs = d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]
            r0 = find(vs[0])
            for v in vs[1:]:
                r = find(v)
                if r != r0:
                    parent[r] = r0
        return np.array([find(i) for i in range(n)])

    def chain_t(co, a, b, c):
        """Parameter of points along the polyline a -> b -> c (0 at a, 0.5 at b, 1 at c)."""
        def seg(p0, p1):
            d = p1 - p0
            L2 = float(d @ d)
            t = np.clip(((co - p0) @ d) / L2, 0, 1)
            dist = np.linalg.norm(co - (p0 + t[:, None] * d), axis=1)
            return t, dist
        t1, d1 = seg(a, b)
        t2, d2 = seg(b, c)
        return np.where(d1 <= d2, 0.5 * t1, 0.5 + 0.5 * t2)

    out_parts = []      # dicts: name, region per poly, keep per poly, data
    delete_groups = {}

    def poly_vals(d, per_vertex, reduce='mean'):
        r = np.zeros(len(d['ls']), np.float32)
        for p in range(len(d['ls'])):
            vs = d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]
            r[p] = per_vertex[vs].mean() if reduce == 'mean' else per_vertex[vs].min()
        return r

    for d, kind, info in pdata:
        P = len(d['ls'])
        keep = np.ones(P, bool)
        region = np.zeros(P, np.int16)
        tex = None
        if kind == 'eyes':
            region[:] = CASTM.REGIONS['eyes']
            tex = 'eye:' + spec['eyes']
        elif kind == 'brows':
            region[:] = CASTM.REGIONS['brows']
            tex = 'brow:' + spec['brows']
        elif kind == 'lashes':
            region[:] = CASTM.REGIONS['lashes']
            tex = 'lash:' + spec['lashes']
        elif kind == 'hair':
            region[:] = CASTM.REGIONS['hair']
            tex = 'hair:' + spec['hair']
            fade_ch = np.round(254 * d.get('fade', np.ones(len(d['co']), np.float32))).astype(np.uint8)
        elif kind == 'hat':
            region[:] = CASTM.REGIONS['hat']
            tex = 'hat:fedora'
        elif kind == 'shoes':
            comp = components(d)
            zmax = {c: d['co'][comp == c, 2].max() for c in np.unique(comp)}
            csize = {c: int((comp == c).sum()) for c in np.unique(comp)}
            ankle = min(J['footL'][2], J['footR'][2])
            # socks: the small tubes rising above the ankle (the shoe shells are much bigger)
            vreg = np.array([CASTM.REGIONS['socks'] if (zmax[c] > ankle + 0.02 and csize[c] < 260) else CASTM.REGIONS['shoes']
                             for c in comp])
            region[:] = poly_vals(d, vreg.astype(np.float32)).round().astype(np.int16)
            tex = 'shoes:' + spec['shoes']
            socks = spec.get('socks')
            if socks is None:
                b = spec['bottom']
                short = b and (b['suit'] in ('female_elegantsuit01', 'female_casualsuit02') or b.get('cut') == 'leg')
                long_ = b and not short and not (b.get('cut') == 'skirt')
                # (socks under long trousers and leggings would poke through the hem at the ankle)
                # (the cast's sock tubes end in a torn, notched top edge: bare ankles in summer shoes instead)
                socks = 'none'
            if socks == 'none':
                keep &= region != CASTM.REGIONS['socks']
        elif kind == 'suit':
            suit = info['suit']
            comp = components(d)
            cl = np.unique(comp)
            vpart = np.zeros(len(d['co']), np.int8)          # 0 top, 1 bottom
            vtop2 = np.zeros(len(d['co']), bool)
            if len(cl) == 1:
                # one piece (shirt + jeans): split by UV island (each island is either shirt or trousers)
                leg = share(d['W'], LEG)
                isl = uv_islands(d)
                pbot = np.zeros(len(d['ls']), bool)
                for c in np.unique(isl):
                    pm = isl == c
                    vs = np.unique(np.concatenate([d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]] for p in np.where(pm)[0]]))
                    pbot[pm] = leg[vs].mean() > 0.5 or d['co'][vs, 2].mean() < waist_z - 0.1
                for p in np.where(pbot)[0]:
                    vpart[d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]] = 1
            else:
                sizes = []
                for c in cl:
                    m = comp == c
                    bottom = d['co'][m, 2].mean() < waist_z
                    vpart[m] = 1 if bottom else 0
                    if not bottom:
                        sizes.append((m.sum(), c))
                sizes.sort(reverse=True)
                for _, c in sizes[1:]:
                    vtop2[comp == c] = True
            ppart = pbot if len(cl) == 1 else poly_vals(d, vpart.astype(np.float32)) > 0.5
            ptop2 = poly_vals(d, vtop2.astype(np.float32)) > 0.5
            want_top = spec['top'] and spec['top']['suit'] == suit
            want_bot = spec['bottom'] and spec['bottom']['suit'] == suit
            keep &= np.where(ppart, bool(want_bot), bool(want_top))
            region[:] = np.where(ppart, CASTM.REGIONS['bottom'], np.where(ptop2, CASTM.REGIONS['top2'], CASTM.REGIONS['top']))
            tex = 'cloth:' + suit
            co = d['co']
            # cuts
            if want_top and spec['top'].get('cut') == 'sleeve':
                cut_tube(d, keep, ~ppart, share(d['W'], ARM) > 0.45, J, ('arm', 'fore', 'hand'), spec['top']['length'], poly_vals)
            if want_bot and spec['bottom'].get('cut') == 'leg':
                cut_tube(d, keep, ppart, share(d['W'], LEG) > 0.5, J, ('thigh', 'shin', 'foot'), spec['bottom']['length'], poly_vals)
            if want_bot and spec['bottom'].get('cut') == 'skirt':
                lengthen_skirt(d, vpart == 1, J, spec['bottom']['length'], waist_z)
            if want_bot and suit == 'female_elegantsuit01':
                skirt_clearance(d, vpart == 1, body, J, share(body['W'], LEG) > 0.6)
                n = level_hem(d, keep & ppart, 0.5 * (J['thighL'][2] + J['thighR'][2]))
                if n:
                    log(cid, f'skirt hem levelled ({n} vertices; back vent closed)')
        out_parts.append(dict(kind=kind, d=d, keep=keep, region=region, tex=tex, info=info))
        if kind == 'hair':
            out_parts[-1]['dec'] = fade_ch

    # mixed outfits (top and bottom from different suits): the top's hem is tucked into the bottom where
    # it hangs below the bottom's waistband (a top made for jeans would otherwise cut through a skirt)
    tops = [op for op in out_parts if op['kind'] == 'suit' and spec['top'] and op['info']['suit'] == spec['top']['suit']]
    bots = [op for op in out_parts if op['kind'] == 'suit' and spec['bottom'] and op['info']['suit'] == spec['bottom']['suit']]
    if tops and bots and tops[0] is not bots[0]:
        tuck_top(tops[0], bots[0], CASTM.REGIONS)

    # layered garments: the bottom's waistband under the top's hem sinks a few mm, so the simplified
    # LODs of the two never cross (the bottom would show through the top in patches)
    sink_under_tops(out_parts, CASTM.REGIONS, cid)

    # skirts: weights blend pelvis -> both thighs (no splitting between the legs)
    for op in out_parts:
        if op['kind'] == 'suit' and op['info']['suit'] == 'female_elegantsuit01':
            reweight_skirt(op, J, ge_index, waist_z)

    # hats: hair inside the crown goes
    hat = [op for op in out_parts if op['kind'] == 'hat']
    if hat:
        hco = hat[0]['d']['co']
        band = np.percentile(hco[:, 2], 8)
        for op in out_parts:
            if op['kind'] == 'hair':
                d = op['d']
                pz = poly_vals(d, d['co'][:, 2].astype(np.float32), 'min')
                op['keep'] &= pz < band - 0.004

    # ---------------------------------------------------------------- body: skin shown where no kept garment covers it
    in_body = np.zeros(len(body['co']), bool)
    for nm, lst in body['groups'].items():
        if nm == 'body':
            for i, w in lst:
                if w > 0.5:
                    in_body[i] = True
    deleted = np.zeros(len(body['co']), bool)
    from mathutils.bvhtree import BVHTree
    gv, gp, sp, goff = [], [], [], 0
    gface = []          # per garment face (gp): arm share, side (+1 the character's left)
    gsuit = []          # per garment face (gp): a suit's (not a shoe's or hat's)
    bnd = []            # open boundary vertices of the kept garments (hems, cuffs, necklines)
    for op in out_parts:
        if op['kind'] in ('suit', 'shoes', 'hat'):
            d = op['d']
            gv.append(d['co'])
            skirt = op['kind'] == 'suit' and op['info']['suit'] == 'female_elegantsuit01'
            arm_v = share(d['W'], ARM)
            margin_ok = op['kind'] == 'suit'      # (shoes hug the ankle: no skin margin at their opening)
            ecount = {}
            for p in np.where(op['keep'])[0]:
                vs = d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]
                f = [int(x) + goff for x in vs]
                if skirt and op['region'][p] == CASTM.REGIONS['bottom']:
                    sp.append(f)
                else:
                    gp.append(f)
                    gface.append((float(arm_v[vs].mean()), 1.0 if d['co'][vs, 0].mean() > 0 else -1.0))
                    gsuit.append(op['kind'] == 'suit')
                for kk in range(len(vs)):
                    e = (min(vs[kk], vs[(kk + 1) % len(vs)]), max(vs[kk], vs[(kk + 1) % len(vs)]))
                    ecount[e] = ecount.get(e, 0) + 1
            # open borders, per loop: only cuffs and hems (short loops) get a skin margin; the long
            # necklines and front openings do not (skin under a lapel would show through its gaps)
            bedges = [e for e, c in ecount.items() if c == 1]
            badj = {}
            for a_, b_ in bedges:
                badj.setdefault(a_, []).append(b_)
                badj.setdefault(b_, []).append(a_)
            bseen = set()
            for v0 in badj:
                if v0 in bseen:
                    continue
                comp, stack = [], [v0]
                bseen.add(v0)
                while stack:
                    v = stack.pop()
                    comp.append(v)
                    for w in badj[v]:
                        if w not in bseen:
                            bseen.add(w)
                            stack.append(w)
                cs = set(comp)
                per = sum(np.linalg.norm(d['co'][a_] - d['co'][b_]) for a_, b_ in bedges if a_ in cs)
                lc = d['co'][comp]
                # (and a top's hem / a bottom's waistband round the waist: level loops below the chest;
                # without skin under them a gap between the two shows the inside of the garment)
                waist = per < 1.5 * kscale and np.ptp(lc[:, 2]) < 0.09 * kscale and lc[:, 2].mean() < float(J['spine2'][2])
                if (per < 0.8 * kscale or waist) and margin_ok:
                    bnd.append(lc)
            goff += len(d['co'])
    GV = [Vector(v) for v in np.concatenate(gv).astype(np.float64)]
    gbvh = BVHTree.FromPolygons(GV, gp, epsilon=0.0)
    # legs under a skirt stay: a striding thigh may push through the skirt, and must show as a leg
    sbvh = BVHTree.FromPolygons(GV, sp, epsilon=0.0) if sp else None
    knee_z = 0.5 * (J['shinL'][2] + J['shinR'][2])
    legv = (share(body['W'], LEG) > 0.5) & (body['co'][:, 2] < knee_z + 0.04)
    del_any = np.zeros(len(body['co']), bool)
    for nm, lst in body['groups'].items():
        if nm.startswith('Delete.'):
            for i, w in lst:
                if w > 0.5:
                    del_any[i] = True
    # skin within a margin of a garment's hem, cuff or neckline stays (a raised arm or a striding leg
    # opens the hem: there must be skin, not a hole, under it)
    margin = 0.032 * kscale
    del_any0 = del_any.copy()
    if bnd:
        B = np.concatenate(bnd)
        kdb = KDTree(len(B))
        for j, c in enumerate(B):
            kdb.insert(Vector(c.tolist()), j)
        kdb.balance()
        for i in np.where(del_any)[0]:
            if kdb.find(Vector(body['co'][i].tolist()))[2] < margin:
                del_any[i] = False
    arm_b = share(body['W'], ARM)
    MAXD = 0.06 * kscale

    def fits(i, h):
        """A garment hit belongs to the same limb as the skin (an arm's skin is not hidden by the
        shirt's body across the gap, nor the torso's by a sleeve)."""
        if h[0] is None or h[2] is None or h[2] >= len(gface):
            return h[0] is not None
        fa, fs = gface[h[2]]
        if arm_b[i] > 0.5:
            return fa > 0.3 and fs == (1.0 if body['co'][i, 0] > 0 else -1.0)
        if arm_b[i] < 0.3:
            return fa < 0.6
        return True
    push = np.zeros(len(body['co']), np.float32)
    # a body vertex under a kept garment is hidden: a ray out along its normal meets the garment
    for i in np.where(del_any)[0]:
        n = Vector(body['nr'][i].tolist())
        o = Vector(body['co'][i].tolist())
        h = gbvh.ray_cast(o - n * 0.002, n, MAXD)
        if not fits(i, h):
            h = (None,)
            # tilted rays (armpits, crotch, folds where the normal looks at other skin)
            for tvec in ((0, 0, 1), (0, 0, -1)):
                dd = (n + Vector(tvec) * 0.6).normalized()
                h = gbvh.ray_cast(o - n * 0.002, dd, MAXD)
                if fits(i, h):
                    break
                h = (None,)
        if h[0] is None:
            # skin pushing through a tight garment: the garment surface lies just inside the skin (any
            # garment: this skin would show through it). It is pushed in under the garment as well (a
            # polygon stays while any of its vertices is uncovered)
            h = gbvh.ray_cast(o + n * 0.002, -n, 0.025)
            if h[0] is not None:
                push[i] = max(0.0, h[3] - 0.002) + 0.004
        if h[0] is None and sbvh is not None and not legv[i]:
            h = sbvh.ray_cast(o - n * 0.002, n, 0.16)
            if h[0] is None:
                h = sbvh.ray_cast(o + n * 0.002, -n, 0.025)
        if h[0] is not None:
            deleted[i] = True
    # (skin outside every garment's delete group can still poke through a tight one: same test; and
    # all skin under a garment sinks a few mm, so the simplified LODs' skin stays under the cloth)
    for i in np.where(push == 0)[0]:
        n = Vector(body['nr'][i].tolist())
        o = Vector(body['co'][i].tolist())
        out = gbvh.ray_cast(o - n * 0.002, n, 0.03)
        if fits(i, out) and out[0] is not None:
            push[i] = 0.0035
            continue
        h = gbvh.ray_cast(o + n * 0.002, -n, 0.025)
        if h[0] is not None and gbvh.ray_cast(o - n * 0.002, n, MAXD)[0] is None:
            push[i] = max(0.0, h[3] - 0.002) + 0.004
    # skin under a garment that stays (within the hem margin, a raised arm or a stride opens it): the far
    # LODs leave it out (mh_export.py), their simplified garments would show it through in patches
    # (any skin whose normal meets a suit's cloth: also skin outside the garments' delete groups, e.g. the
    # shoulders under a tee, which only sinks a few mm and would poke through a simplified sleeve)
    under = deleted.copy()
    for i in np.where(in_body & ~deleted)[0]:
        n = Vector(body['nr'][i].tolist())
        o = Vector(body['co'][i].tolist())
        # (skin within the margin of a hem stays: a gap between a top's hem and a waistband, or a sleeve
        # lifted by the arm, must show skin, not the street through the figure)
        if bnd and kdb.find(Vector(body['co'][i].tolist()))[2] < margin * 1.3:
            continue
        h = gbvh.ray_cast(o - n * 0.002, n, MAXD)
        if h[0] is not None and h[2] is not None and h[2] < len(gsuit) and gsuit[h[2]]:
            under[i] = True
    body['under'] = under
    # feet inside the shoes go (a heel or toe poking through the sole shows as a skin patch under it)
    shoes = [op for op in out_parts if op['kind'] == 'shoes']
    if shoes:
        sd = shoes[0]['d']
        sv = np.zeros(len(sd['co']), bool)
        for p in np.where(shoes[0]['keep'] & (shoes[0]['region'] == CASTM.REGIONS['shoes']))[0]:
            sv[sd['vi'][sd['ls'][p]:sd['ls'][p] + sd['lt'][p]]] = True
        footw = share(body['W'], [b for b in bone_names if b.startswith(('foot', 'ball'))])
        nfeet = 0
        for sgn in (1.0, -1.0):
            side_s = sv & (sd['co'][:, 0] * sgn > 0)
            if not side_s.any():
                continue
            top = float(np.percentile(sd['co'][side_s, 2], 97))
            m = (footw > 0.5) & (body['co'][:, 0] * sgn > 0) & (body['co'][:, 2] < top - 0.012)
            deleted |= m
            nfeet += int(m.sum())
        log(cid, f'{nfeet} foot vertices inside the shoes hidden')
    if push.any():
        body['co'] = body['co'] - body['nr'] * push[:, None]
        log(cid, f'skin pushed in under the garments at {int((push > 0).sum())} vertices')
    bkeep = np.zeros(len(body['ls']), bool)
    for p in range(len(body['ls'])):
        vs = body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]]
        bkeep[p] = in_body[vs].all() and not deleted[vs].all()
    out_parts.insert(0, dict(kind='body', d=body, keep=bkeep, region=np.zeros(len(body['ls']), np.int16),
                             tex=f'skin:{spec["skin"]}', info={}))
    # skin decals (per body vertex, for the skin shader): beard growth (stubble and the base of a beard:
    # the skin darkened towards the hair colour, soft-edged) and the scalp under the hair (hair-coloured,
    # so the skin between the hair cards never shows as a bald head)
    headw = share(body['W'], ['head', 'neck_01'])
    beard_cov = np.zeros(len(body['co']), np.float32)
    if spec.get('beard'):
        eyes = [op for op in out_parts if op['kind'] == 'eyes'][0]['d']['co']
        beard_cov = beard_coverage(body, spec['beard'], eyes, J, headw)
        if spec['beard'] != 'stubble':
            # beards with volume: a shell over the dense part, its strands thinning out towards its edge
            bd = beard_shell(body, bkeep, spec['beard'], beard_cov, eyes, J)
            if bd is not None:
                out_parts.append(dict(kind='beard', d=bd, keep=np.ones(len(bd['ls']), bool),
                                      region=np.full(len(bd['ls']), CASTM.REGIONS['beard'], np.int16),
                                      tex='beard:shell', info={}))
    hair = [op for op in out_parts if op['kind'] == 'hair' and op['keep'].any()]
    scalp_cov = scalp_coverage(body, bkeep, hair[0], headw, E, hk) if hair else np.zeros(len(body['co']), np.float32)
    dec = np.where(beard_cov >= scalp_cov, 128 + np.round(127 * np.clip(beard_cov, 0, 1)),
                   128 - np.round(127 * np.clip(scalp_cov, 0, 1))).astype(np.uint8)
    out_parts[0]['dec'] = dec
    log(cid, f'skin decals: beard {int((beard_cov > 0.05).sum())} / scalp {int((scalp_cov > 0.05).sum())} vertices')

    # far-LOD hair: an opaque cap over the scalp, pushed out to the hair's outer surface (alpha cards do not
    # survive heavy simplification; at a few pixels a hair-coloured silhouette is what reads)
    if hair:
        cap = hair_cap(body, bkeep, hair[0])
        if cap is not None:
            out_parts.append(dict(kind='haircap', d=cap, keep=np.ones(len(cap['ls']), bool),
                                  region=np.full(len(cap['ls']), CASTM.REGIONS['hair'], np.int16), tex='cap:solid', info={}))

    # ---------------------------------------------------------------- weights -> runtime bones
    M = np.zeros((len(bone_names), len(RT_BONES)), np.float32)
    for b, i in ge_index.items():
        for rt, w in GE_MAP.get(b, {}).items():
            M[i, RB[rt]] += w

    # ---------------------------------------------------------------- assemble triangles (split by UV), to three.js space
    ground = None
    for op in out_parts:
        d = op['d']
        if op['kind'] in ('shoes', 'body') and op['keep'].any():
            idx = np.unique(np.concatenate([d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]] for p in np.where(op['keep'])[0]]))
            z = d['co'][idx, 2].min()
            ground = z if ground is None else min(ground, z)
    shift = np.array([0.0, 0.0, -ground])

    def to3(p):   # Blender (x, y, z) -> three.js (-x, z, y): faces -Z, left = -X, up = +Y
        p = np.asarray(p, np.float64)
        return np.stack([-p[..., 0], p[..., 2], p[..., 1]], -1)

    raw = {}
    meta_parts = []
    for k, op in enumerate(out_parts):
        d = op['d']
        tris, tri_reg, loops = [], [], []
        for p in np.where(op['keep'])[0]:
            s, n = d['ls'][p], d['lt'][p]
            lp = list(range(s, s + n))
            if n == 4:
                v = d['co'][d['vi'][lp]]
                if np.linalg.norm(v[0] - v[2]) <= np.linalg.norm(v[1] - v[3]):
                    tt = [(lp[0], lp[1], lp[2]), (lp[0], lp[2], lp[3])]
                else:
                    tt = [(lp[0], lp[1], lp[3]), (lp[1], lp[2], lp[3])]
            else:
                tt = [(lp[0], lp[i], lp[i + 1]) for i in range(1, n - 1)]
            for t in tt:
                tris.append(t)
                tri_reg.append(op['region'][p])
        if not tris:
            continue
        tris = np.array(tris, np.int64)
        lv = tris.ravel()
        treg = np.repeat(np.array(tri_reg, np.int64), 3)
        key = np.stack([d['vi'][lv], np.round(d['uv'][lv, 0] * 8192).astype(np.int64), np.round(d['uv'][lv, 1] * 8192).astype(np.int64),
                        treg], 1)
        uk, inv = np.unique(key, axis=0, return_inverse=True)
        inv = inv.reshape(-1)
        first = np.zeros(len(uk), np.int64)
        first[inv[::-1]] = lv[::-1]
        vsrc = d['vi'][first]
        co = to3(d['co'][vsrc] + shift).astype(np.float32)
        nr = to3(d['nr'][vsrc]).astype(np.float32)
        uv = d['uv'][first].astype(np.float32)
        W = d['W'][vsrc] @ M
        sw = W.sum(1)
        bad = sw < 1e-4
        if bad.any():
            # unweighted vertices follow the nearest weighted one of this part (or the head)
            good = np.where(~bad)[0]
            if len(good):
                for i in np.where(bad)[0]:
                    j = good[np.argmin(np.linalg.norm(co[good] - co[i], axis=1))]
                    W[i] = W[j]
            else:
                W[bad, RB['head']] = 1
        W /= W.sum(1, keepdims=True)
        # vertex region: majority of the triangles using it
        vreg = np.zeros(len(uk), np.int16)
        tri_reg = np.array(tri_reg, np.int16)
        vreg[inv.reshape(-1, 3)[:, 0]] = tri_reg
        vreg[inv.reshape(-1, 3)[:, 1]] = tri_reg
        vreg[inv.reshape(-1, 3)[:, 2]] = tri_reg
        name = f'p{k}'
        raw[name + '_co'] = co
        raw[name + '_nr'] = nr
        raw[name + '_uv'] = uv
        raw[name + '_w'] = W.astype(np.float32)
        raw[name + '_idx'] = inv.reshape(-1, 3).astype(np.int32)
        raw[name + '_reg'] = vreg
        if 'dec' in op:
            raw[name + '_dec'] = op['dec'][vsrc]
        if op['kind'] == 'body' and 'under' in d:
            raw[name + '_under'] = d['under'][vsrc].astype(np.uint8)
        meta_parts.append(dict(key=name, kind=op['kind'], tex=op['tex'], verts=int(len(uk)), tris=int(len(tris)),
                               suit=op['info'].get('suit')))

    # ---------------------------------------------------------------- ambient occlusion per vertex (rest pose)
    ambient_occlusion(raw, meta_parts)
    garment_distance(raw, meta_parts)

    joints = {n: to3(J[n] + shift).tolist() for n in RT_BONES}
    joints['root'] = [0.0, 0.0, 0.0]
    # rest-pose landmarks
    allc = np.concatenate([raw[p['key'] + '_co'] for p in meta_parts if p['kind'] == 'body'])
    skin_top = float(allc[:, 1].max())
    allv = np.concatenate([raw[p['key'] + '_co'] for p in meta_parts])
    meta = dict(id=cid, spec=spec, ageClass=CASTM.age_class(spec), kind=CASTM.gait_kind(spec), joints=joints,
                parent=RT_PARENT, bones=RT_BONES, parts=meta_parts, H=skin_top, top=float(allv[:, 1].max()),
                toeTip={'L': to3(toe_tip['l'] + shift).tolist(), 'R': to3(toe_tip['r'] + shift).tolist()},
                headTopBone=to3(head_top_bone + shift).tolist(), time=round(time.time() - t0, 1))
    os.makedirs(RAW, exist_ok=True)
    np.savez_compressed(os.path.join(RAW, cid + '.npz'), **raw)
    with open(os.path.join(RAW, cid + '.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    if save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(RAW, cid + '.blend'))
    log(cid, f'H={skin_top:.3f} verts={sum(p["verts"] for p in meta_parts)} tris={sum(p["tris"] for p in meta_parts)} in {time.time() - t0:.1f}s')


def fit_stature(bm, target):
    """Set MakeHuman's height macro so the body's crown height matches `target` (m): MakeHuman children
    are short for their age, and the macro's metric scale differs between body types."""
    import bpy
    import numpy as np
    from bl_ext.user_default.mpfb.services.targetservice import TargetService
    from bl_ext.user_default.mpfb.entities.objectproperties import HumanObjectProperties
    gi = [g.index for g in bm.vertex_groups if g.name == 'body'][0]
    idx = np.array([v.index for v in bm.data.vertices if any(g.group == gi and g.weight > 0.5 for g in v.groups)])

    def measure(h):
        HumanObjectProperties.set_value('height', float(h), entity_reference=bm)
        TargetService.reapply_macro_details(bm)
        dg = bpy.context.evaluated_depsgraph_get()
        eo = bm.evaluated_get(dg)
        me = eo.to_mesh()
        co = np.zeros(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get('co', co)
        eo.to_mesh_clear()
        z = co.reshape(-1, 3)[idx, 2]
        return float(z.max() - z.min())
    h0 = 0.5
    H0 = measure(h0)
    h1 = 0.56 if target > H0 else 0.44
    H1 = measure(h1)
    for _ in range(4):
        if abs(H1 - H0) < 1e-6:
            break
        h2 = h1 + (target - H1) * (h1 - h0) / (H1 - H0)
        h2 = min(1.0, max(0.0, h2))
        h0, H0 = h1, H1
        h1, H1 = h2, measure(h2)
        if abs(H1 - target) < 0.002:
            break
    log(f'stature {H1:.3f} (target {target:.3f}, height macro {h1:.3f})')
    return h1


AO_RAYS = 40
AO_DIST = 0.30


def ambient_occlusion(raw, meta_parts):
    """Hemisphere occlusion by the whole dressed figure (hair, clothes, body), cosine weighted, within
    AO_DIST. Eyelashes and eyebrows do not occlude. Writes <part>_ao (0 = fully occluded .. 1 = open)."""
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    ARMB = [6, 7, 8, 9, 10, 11, 12, 13]      # runtime bones of the clavicles, arms, forearms, hands

    def bvh_of(skip, no_arms=False):
        verts, polys, off = [], [], 0
        for p in meta_parts:
            if p['kind'] in skip:
                continue
            co = raw[p['key'] + '_co']
            idx = raw[p['key'] + '_idx']
            if no_arms:
                w = raw[p['key'] + '_w']
                arm = w[:, ARMB[1:]].sum(1) > 0.5
                idx = idx[~arm[idx].all(1)]
            if 'skirt' in skip and p['kind'] == 'suit' and p.get('suit') == 'female_elegantsuit01':
                reg = raw[p['key'] + '_reg']
                idx = idx[reg[idx[:, 0]] != CASTM.REGIONS['bottom']]
            verts.append(co)
            polys.append(idx + off)
            off += len(co)
        V = np.concatenate(verts).astype(np.float64)
        T = np.concatenate(polys)
        return BVHTree.FromPolygons([Vector(v) for v in V], T.tolist(), all_triangles=True, epsilon=0.0)
    # the arms move away from the body: hands and forearms are occluded only by the arm itself
    def bvh_arms():
        verts, polys, off = [], [], 0
        for p in meta_parts:
            if p['kind'] in ('lashes', 'brows', 'hair', 'beard'):
                continue
            co = raw[p['key'] + '_co']
            idx = raw[p['key'] + '_idx']
            w = raw[p['key'] + '_w']
            arm = w[:, ARMB[1:]].sum(1) > 0.5
            idx = idx[arm[idx].all(1)]
            verts.append(co)
            polys.append(idx + off)
            off += len(co)
        T = np.concatenate(polys)
        V = np.concatenate(verts).astype(np.float64)
        return BVHTree.FromPolygons([Vector(v) for v in V], T.tolist(), all_triangles=True, epsilon=0.0)
    bvh_arm = bvh_arms()
    # the arms swing in the walk: they do not darken the torso, hips and thighs
    # (beards do not darken the skin under them: the beard's own shading does)
    bvh_noarm = bvh_of(('lashes', 'brows', 'beard'), True)
    bvh_noskirt = bvh_of(('lashes', 'brows', 'beard', 'skirt'), True)
    # hair cards do not darken each other much (light passes between strands): hair sees only the head
    bvh_nohair = bvh_of(('lashes', 'brows', 'hair', 'beard'))
    # fixed cosine-weighted directions (golden spiral)
    k = np.arange(AO_RAYS) + 0.5
    r = np.sqrt(k / AO_RAYS)
    th = k * math.pi * (3 - math.sqrt(5))
    dirs = np.stack([r * np.cos(th), r * np.sin(th), np.sqrt(1 - r * r)], 1)
    for p in meta_parts:
        co = raw[p['key'] + '_co'].astype(np.float64)
        nr = raw[p['key'] + '_nr'].astype(np.float64)
        ao = np.ones(len(co), np.float32)
        two = p['kind'] in ('hair', 'lashes')
        w = raw[p['key'] + '_w']
        on_arm = w[:, ARMB[1:]].sum(1) > 0.5
        on_leg = (w[:, [14, 15, 16, 17, 18, 19, 20, 21]].sum(1) > 0.5) if p['kind'] == 'body' else np.zeros(len(co), bool)
        # (the face and neck are not darkened by the hair cards: light passes between the strands, and a
        # trimmed fringe would leave its old shadow behind)
        head_v = (w[:, [4, 5]].sum(1) > 0.5) if p['kind'] == 'body' else np.zeros(len(co), bool)
        for i in range(len(co)):
            bvh = bvh_nohair if p['kind'] in ('hair', 'lashes', 'brows', 'body') and (p['kind'] != 'body' or head_v[i]) else (bvh_arm if on_arm[i] else bvh_noskirt if on_leg[i] else bvh_noarm)
            n = nr[i]
            a = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1.0, 0])
            t = np.cross(n, a)
            t /= np.linalg.norm(t) + 1e-12
            b = np.cross(n, t)
            hit = 0.0
            for side in ((1.0, -1.0) if two else (1.0,)):
                D = dirs[:, 0:1] * t + dirs[:, 1:2] * b + dirs[:, 2:3] * n * side
                o = co[i] + n * side * 0.0015
                for dvec in D:
                    h = bvh.ray_cast(Vector(o), Vector(dvec), AO_DIST)
                    if h[0] is not None:
                        hit += 1.0 - (h[3] / AO_DIST) ** 2 * 0.5
            ao[i] = 1.0 - hit / (len(dirs) * (2 if two else 1))
        raw[p['key'] + '_ao'] = ao


def pose_relaxed(rig, spec):
    """Rest pose of the runtime skeleton: arms hang beside the body (a little abducted, more for heavier
    builds and for women's hips), elbows slightly bent with the palms towards the thighs, fingers in a
    relaxed curl, legs straight under the hips."""
    import bpy
    from mathutils import Vector, Matrix
    import numpy as np

    def upd():
        bpy.context.view_layer.update()

    def rotate(name, q, pivot=None):
        pb = rig.pose.bones[name]
        M = pb.matrix.copy()
        h = pb.head.copy() if pivot is None else pivot
        pb.matrix = Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h) @ M
        upd()

    def aim(name, target):
        pb = rig.pose.bones[name]
        d = (pb.tail - pb.head).normalized()
        rotate(name, d.rotation_difference(Vector(target).normalized()))

    from mathutils import Quaternion
    child = CASTM.age_class(spec) in ('child', 'toddler')
    abd = 8.0 + 9.0 * max(0.0, spec['weight'] - 0.45) + (2.5 if spec['sex'] == 'f' else 0.0) + (3.0 if child else 0.0)
    for s, sx in (('l', 1.0), ('r', -1.0)):
        a = math.radians(abd)
        aim(f'upperarm_{s}', (sx * math.sin(a), 0.035, -math.cos(a)))
        # elbow: forearm bent ~14 degrees forward of the upper arm
        ua = rig.pose.bones[f'upperarm_{s}']
        du = (ua.tail - ua.head).normalized()
        fwd = Vector((0, -1, 0))
        fl = math.radians(14 if not child else 12)
        tgt = (du * math.cos(fl) + (fwd - du * du.dot(fwd)).normalized() * math.sin(fl))
        aim(f'lowerarm_{s}', tgt)
        # palm towards the thigh: twist the forearm about its axis so the palm normal points medially
        la = rig.pose.bones[f'lowerarm_{s}']
        hand = rig.pose.bones[f'hand_{s}']
        ax = (la.tail - la.head).normalized()
        i1 = rig.pose.bones[f'index_01_{s}'].head
        p1 = rig.pose.bones[f'pinky_01_{s}'].head
        across = (i1 - p1)                                  # index side - little-finger side
        across = (across - ax * across.dot(ax)).normalized()
        # the thumb / index side should face forward (-Y), so the palm faces the thigh
        want = (fwd - ax * fwd.dot(ax)).normalized()
        ang = math.atan2(ax.dot(across.cross(want)), across.dot(want))
        rotate(f'lowerarm_{s}', Quaternion(ax, ang * 0.85))
        # wrist: hand continues the forearm line with a slight flexion
        # fingers: relaxed curl towards the palm
        h = rig.pose.bones[f'hand_{s}']
        mid = rig.pose.bones[f'middle_01_{s}']
        i1 = rig.pose.bones[f'index_01_{s}'].head
        p1 = rig.pose.bones[f'pinky_01_{s}'].head
        hd = (mid.head - h.head).normalized()
        palm = (i1 - p1).cross(hd).normalized()
        # palm normal points to the body's midline (x -> 0)
        if palm.x * sx > 0:
            palm = -palm
        # fingers: closed up beside each other (MakeHuman's rest spreads them), then a relaxed curl that
        # grows towards the little finger; the thumb lies alongside the index finger
        dm = (mid.tail - mid.head).normalized()
        dmp = (dm - palm * dm.dot(palm)).normalized()
        for f, keep in (('index', 0.3), ('ring', 0.3), ('pinky', 0.4)):
            pb = rig.pose.bones[f'{f}_01_{s}']
            dvec = (pb.tail - pb.head).normalized()
            dp = (dvec - palm * dvec.dot(palm)).normalized()
            ang = math.atan2(palm.dot(dp.cross(dmp)), dp.dot(dmp))
            rotate(pb.name, Quaternion(palm, ang * (1 - keep)))
        for f, curl in (('index', (16, 24, 14)), ('middle', (20, 28, 16)), ('ring', (24, 32, 18)), ('pinky', (28, 34, 20))):
            for j, deg in enumerate(curl, 1):
                pb = rig.pose.bones[f'{f}_0{j}_{s}']
                dvec = (pb.tail - pb.head).normalized()
                k = dvec.cross(palm).normalized()
                rotate(pb.name, Quaternion(k, math.radians(deg)))
        # thumb: in towards the index finger's side (adducted), lightly flexed
        t1 = rig.pose.bones[f'thumb_01_{s}']
        ix = rig.pose.bones[f'index_01_{s}']
        dt = (t1.tail - t1.head).normalized()
        di = (ix.tail - ix.head).normalized()
        ax_ = dt.cross(di)
        if ax_.length > 1e-6:
            rotate(t1.name, Quaternion(ax_.normalized(), dt.angle(di) * 0.5))
        for j, deg in ((2, 14), (3, 16)):
            pb = rig.pose.bones[f'thumb_0{j}_{s}']
            dvec = (pb.tail - pb.head).normalized()
            k = dvec.cross(palm).normalized()
            rotate(pb.name, Quaternion(k, math.radians(deg)))
    # legs: ankles under the hips (MakeHuman's rest stands with the feet apart)
    for s, sx in (('l', 1.0), ('r', -1.0)):
        th = rig.pose.bones[f'thigh_{s}']
        ft = rig.pose.bones[f'foot_{s}']
        hip = th.head.copy()
        ank = ft.head.copy()
        # (women and girls a little wider: thighs that touch would otherwise turn the knees in)
        want_x = hip.x + sx * (0.012 + (0.010 if spec['sex'] == 'f' else 0.0)) * (rig.pose.bones['head'].tail.z / 1.75)
        v0 = (ank - hip)
        v1 = Vector((want_x - hip.x, v0.y, v0.z))
        rotate(f'thigh_{s}', v0.rotation_difference(v1))
        # keep the foot pointing as before (counter-rotate)
        rotate(f'foot_{s}', v0.rotation_difference(v1).inverted())


BEARD = {   # cheek beard length (m), lower reach under the chin (x head scale), cheek line below the eyes, chin volume (m)
    'stubble': (0.0, 0.026, 0.056, 0.0),
    'short': (0.0045, 0.024, 0.054, 0.004),
    'full': (0.011, 0.032, 0.050, 0.014),
}


def beard_coverage(body, style, eyes, J, headw):
    """Beard growth per body vertex (0..1): the cheeks below a line from the sideburns down towards the
    mouth corners, the moustache, the chin and down the throat; soft (1-2.5 cm) borders; bare lips."""
    import numpy as np
    co = body['co']
    _, reach, cheek, _ = BEARD[style]
    E = eyes.mean(0)
    k = max(0.5, (J['head'][2] + 0.25) / 1.75)
    lips = np.array([i for i, w in body['groups'].get('lips', []) if w > 0.5])
    L = co[lips].mean(0) if len(lips) else E + np.array([0, -0.01, -0.07])
    sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))  # noqa: E731
    x, y, z = co[:, 0] - E[0], co[:, 1] - E[1], co[:, 2] - E[2]
    ax = np.abs(x)
    # in front of the ears (y grows towards the back of the head)
    front = 1 - sm(0.050 * k, 0.075 * k, y)
    # cheek line: from the sideburns (high, in front of the ears) slanting down towards the mouth corners
    top_z = -(cheek + 0.010 * (1 - sm(0.03 * k, 0.07 * k, ax))) * k + 0.03 * k * sm(0.062 * k, 0.075 * k, ax) * sm(0.02 * k, 0.045 * k, y)
    top = (1 - sm(top_z - 0.014 * k, top_z + 0.006 * k, z)) * (0.55 + 0.45 * sm(top_z - 0.005 * k, top_z - 0.04 * k, z))
    # moustache: above the upper lip, below the nose, only near the middle
    lz = L[2] - E[2]
    mous = (1 - sm(0.022 * k, 0.034 * k, ax)) * sm(lz + 0.001, lz + 0.006 * k, z) * (1 - sm(lz + 0.016 * k, lz + 0.024 * k, z))
    # under the chin, down the throat to `reach` below the lips
    # (deepest under the chin, rising towards the jaw corners: a rounded beard, not an apron)
    rx = reach * (1.0 - 0.55 * np.clip(ax / (0.06 * k), 0, 1) ** 2)
    bottom = sm(lz - (0.05 + rx) * k, lz - (0.028 + rx) * k, z)
    # mouth corners: the moustache runs down into the beard
    corner = (1 - sm(0.040 * k, 0.05 * k, ax)) * sm(lz - 0.03 * k, lz - 0.02 * k, z) * (1 - sm(lz + 0.012 * k, lz + 0.02 * k, z)) * (y < 0.0)
    mous = np.maximum(mous, corner)
    cov = np.maximum(front * top, mous * (1 if style != 'stubble' else 0.8)) * bottom * np.clip((headw - 0.2) / 0.3, 0, 1)
    # bare lips and a little margin
    if len(lips):
        from mathutils import Vector
        from mathutils.kdtree import KDTree
        kd = KDTree(len(lips))
        for j, i in enumerate(lips):
            kd.insert(Vector(co[i].tolist()), j)
        kd.balance()
        for i in np.where(cov > 0)[0]:
            _, _, dist = kd.find(Vector(co[i].tolist()))
            cov[i] *= sm(0.0015, 0.0045 * k, dist)
    return cov.astype(np.float32)


def beard_shell(body, bkeep, style, cov, eyes, J):
    """The base of a short or full beard's volume: every skin polygon the beard grows on (its soft
    border included), 0.6 mm above the skin. The runtime grows shells from it (src/crowd/humans.js):
    uv u = the beard's length there (0..1 = 0..4 cm: longer at the chin and jaw, the volume hanging a
    little, falling to nothing at the border), v = growth density (the coverage); the shader draws the
    strands. Weights follow the skin."""
    import numpy as np
    co, nr = body['co'], body['nr']
    length, _, _, bulge = BEARD[style]
    E = eyes.mean(0)
    k = max(0.5, (J['head'][2] + 0.25) / 1.75)
    lips = np.array([i for i, w in body['groups'].get('lips', []) if w > 0.5])
    L = co[lips].mean(0) if len(lips) else E + np.array([0, -0.01, -0.07])
    sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))  # noqa: E731
    x, y, z = co[:, 0] - E[0], co[:, 1] - E[1], co[:, 2] - E[2]
    lz = L[2] - E[2]
    sel = []
    for p in np.where(bkeep)[0]:
        vs = body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]]
        if cov[vs].max() > 0.04:
            sel.append(p)
    if not sel:
        return None
    vids = np.unique(np.concatenate([body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]] for p in sel]))
    remap = -np.ones(len(co), np.int64)
    remap[vids] = np.arange(len(vids))
    c = np.clip(cov[vids], 0, 1)
    nco = co[vids] + nr[vids] * 0.0006
    # length: the cheeks' growth, the moustache a little shorter, the volume at the chin and jaw
    ax = np.abs(x[vids])
    # (longest round the chin and along the jaw's lower edge, short again down the throat)
    dz = lz - z[vids]
    under = sm(0.0, 0.035 * k, dz) * (1 - 0.65 * sm(0.055 * k, 0.08 * k, dz)) * (1 - 0.5 * sm(0.03 * k, 0.065 * k, ax))
    mous = (1 - sm(0.022 * k, 0.04 * k, ax)) * sm(lz - 0.004 * k, lz + 0.006 * k, z[vids]) * (1 - sm(lz + 0.02 * k, lz + 0.03 * k, z[vids]))
    T = length * (1 - 0.35 * mous) + bulge * under
    T = T * sm(0.04, 0.55, c)
    u = np.clip(T / 0.04, 0, 1)
    v = c
    vi, uvl, ls, lt = [], [], [], []
    for p in sel:
        vs = body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]]
        ls.append(len(vi))
        lt.append(len(vs))
        for vv in vs:
            vi.append(remap[vv])
            uvl.append((u[remap[vv]], v[remap[vv]]))
    log(f'  beard base: {len(sel)} polygons, length up to {T.max() * 100:.1f} cm')
    return dict(co=nco.astype(np.float32), nr=nr[vids], vi=np.array(vi, np.int32), uv=np.array(uvl, np.float32),
                ls=np.array(ls, np.int32), lt=np.array(lt, np.int32), W=body['W'][vids], groups={}, name='beard')


def scalp_coverage(body, bkeep, hair, headw, E, hk):
    """How much the hair covers each head vertex (1 under the hair .. 0 bare): a ray out along the skin
    normal meets the hair within 6 cm; the face below the hairline stays bare; eased over the mesh."""
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    co, nr = body['co'], body['nr']
    n = len(co)
    cov = np.zeros(n, np.float32)
    hd = hair['d']
    hf = [[int(x) for x in hd['vi'][hd['ls'][p]:hd['ls'][p] + hd['lt'][p]]] for p in np.where(hair['keep'])[0]]
    if not hf:
        return cov
    bvh = BVHTree.FromPolygons([Vector(v) for v in hd['co'].astype(np.float64)], hf, epsilon=0.0)
    used = np.zeros(n, bool)
    for p in np.where(bkeep)[0]:
        used[body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]]] = True
    face = (co[:, 1] < E[1] + 0.035 * hk) & (co[:, 2] < E[2] + 0.045 * hk)
    cand = np.where(used & (headw > 0.5) & ~face & (co[:, 2] > E[2] - 0.07 * hk))[0]
    push = np.zeros(n, np.float32)
    for i in cand:
        nn = Vector(nr[i].tolist())
        o = Vector(co[i].tolist()) + nn * 0.001
        h = bvh.ray_cast(o, nn, 0.06)
        if h[0] is not None:
            cov[i] = 1.0
            if h[3] < 0.004:
                push[i] = 0.004 - h[3]
            continue
        # hair lying just inside the scalp (a tight cap fitted under the skin): the scalp goes under it
        h = bvh.ray_cast(o, -nn, 0.008)
        if h[0] is not None:
            cov[i] = 1.0
            push[i] = h[3] + 0.003
    log(f'  scalp: {len(cand)} candidates, {int((cov > 0).sum())} under hair, {int((push > 0).sum())} pushed in (max {push.max() * 100:.1f} cm)')
    if push.any():
        body['co'] = co - nr * push[:, None]
        co = body['co']
    # ease the border over the mesh (two rings), so the hairline is soft
    nb = [[] for _ in range(n)]
    for p in np.where(bkeep)[0]:
        vs = body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]]
        for a in vs:
            nb[a].extend(int(b) for b in vs if b != a)
    for _ in range(2):
        nxt = cov.copy()
        for i in np.where(used & (headw > 0.3))[0]:
            if nb[i]:
                nxt[i] = 0.5 * cov[i] + 0.5 * cov[nb[i]].mean()
        cov = nxt
    # (the forehead stays skin up to the hairline, with or without a fringe in front of it)
    fz = np.clip((co[:, 2] - (E[2] + 0.062 * hk)) / (0.02 * hk), 0, 1)
    cov = np.where(face | (co[:, 1] < E[1] + 0.05 * hk), cov * fz, cov)
    # (isolated covered vertices would show as hair-coloured diamonds: they need covered neighbours)
    nm = np.array([cov[nb[i]].mean() if nb[i] else 0.0 for i in range(n)], np.float32)
    cov = cov * np.clip((nm - 0.25) / 0.3, 0, 1)
    return cov


def garment_distance(raw, meta_parts):
    """<body>_gd: distance (m) from each body vertex to the nearest garment / shoe / hat vertex. Far LODs pull
    skin near a garment edge in under it (simplified meshes would otherwise poke through each other)."""
    import numpy as np
    from mathutils import Vector
    from mathutils.kdtree import KDTree
    g = [raw[p['key'] + '_co'] for p in meta_parts if p['kind'] in ('suit', 'shoes', 'hat')]
    for p in meta_parts:
        if p['kind'] != 'body':
            continue
        co = raw[p['key'] + '_co']
        gd = np.full(len(co), 1.0, np.float32)
        if g:
            G = np.concatenate(g)
            kd = KDTree(len(G))
            for i, c in enumerate(G):
                kd.insert(Vector(c.tolist()), i)
            kd.balance()
            for i, c in enumerate(co):
                gd[i] = kd.find(Vector(c.tolist()))[2]
        raw[p['key'] + '_gd'] = gd


def hair_cap(body, bkeep, hair):
    """Scalp polygons of the body, each vertex moved out along its normal to the outermost hair card."""
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    sc = np.zeros(len(body['co']), bool)
    for i, w in body['groups'].get('scalp', []):
        if w > 0.3:
            sc[i] = True
    hd = hair['d']
    hf = [[int(x) for x in hd['vi'][hd['ls'][p]:hd['ls'][p] + hd['lt'][p]]] for p in np.where(hair['keep'])[0]]
    if not hf or not sc.any():
        return None
    bvh = BVHTree.FromPolygons([Vector(v) for v in hd['co'].astype(np.float64)], hf, epsilon=0.0)
    sel = []
    for p in np.where(bkeep)[0]:
        vs = body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]]
        if sc[vs].all():
            sel.append(p)
    if not sel:
        return None
    vids = np.unique(np.concatenate([body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]] for p in sel]))
    remap = -np.ones(len(body['co']), np.int64)
    remap[vids] = np.arange(len(vids))
    nco = body['co'][vids].astype(np.float64).copy()
    for k, i in enumerate(vids):
        n = Vector(body['nr'][i].tolist())
        o = Vector(body['co'][i].tolist())
        far = 0.0
        # outermost hair surface along the normal (march through the card layers)
        start = o + n * 0.001
        for _ in range(12):
            h = bvh.ray_cast(start, n, 0.2)
            if h[0] is None:
                break
            far = (h[0] - o).length
            start = h[0] + n * 0.0015
        nco[k] = np.array(o + n * max(0.0, far - 0.003))
    # smooth the offsets a little (card layers are uneven)
    off = np.linalg.norm(nco - body['co'][vids], axis=1)
    vi, ls, lt = [], [], []
    for p in sel:
        vs = body['vi'][body['ls'][p]:body['ls'][p] + body['lt'][p]]
        ls.append(len(vi))
        lt.append(len(vs))
        vi += [int(remap[v]) for v in vs]
    nb = [[] for _ in range(len(vids))]
    for p in range(len(ls)):
        f = vi[ls[p]:ls[p] + lt[p]]
        for a in f:
            nb[a] += f
    for _ in range(3):
        off = np.array([np.mean(off[nb[a]]) if nb[a] else off[a] for a in range(len(vids))])
    nco = body['co'][vids] + body['nr'][vids] * off[:, None]
    return dict(co=nco.astype(np.float32), nr=body['nr'][vids], vi=np.array(vi, np.int32),
                uv=np.full((len(vi), 2), 0.5, np.float32), ls=np.array(ls, np.int32), lt=np.array(lt, np.int32),
                W=body['W'][vids], groups={}, name='haircap')


def sink_under_tops(out_parts, REG, cid):
    """Bottom-garment vertices covered by a top garment (a ray out along the normal meets the top within
    3 cm) move 4 mm in."""
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    suits = [op for op in out_parts if op['kind'] == 'suit']
    tv, tf, off = [], [], 0
    for op in suits:
        d = op['d']
        for p in np.where(op['keep'] & (op['region'] != REG['bottom']))[0]:
            tf.append([int(x) + off for x in d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]])
        tv.append(d['co'])
        off += len(d['co'])
    if not tf:
        return 0
    bvh = BVHTree.FromPolygons([Vector(v) for v in np.concatenate(tv).astype(np.float64)], tf, epsilon=0.0)
    moved = 0
    for op in suits:
        d = op['d']
        vb = np.zeros(len(d['co']), bool)
        for p in np.where(op['keep'] & (op['region'] == REG['bottom']))[0]:
            vb[d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]] = True
        for i in np.where(vb)[0]:
            n = Vector(d['nr'][i].tolist())
            o = Vector(d['co'][i].tolist())
            if bvh.ray_cast(o + n * 0.0005, n, 0.03)[0] is not None:
                d['co'][i] = d['co'][i] - d['nr'][i] * 0.004
                moved += 1
    if moved:
        log(cid, f'{moved} bottom-garment vertices sunk under the top')
    return moved


def tuck_top(top, bot, REG):
    """Push the kept top-garment vertices that lie below the bottom garment's waistband to just inside it."""
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    bd = bot['d']
    faces = []
    for p in np.where(bot['keep'] & (bot['region'] == REG['bottom']))[0]:
        faces.append([int(x) for x in bd['vi'][bd['ls'][p]:bd['ls'][p] + bd['lt'][p]]])
    if not faces:
        return
    used = np.unique(np.concatenate(faces))
    waist = bd['co'][used, 2].max()
    bvh = BVHTree.FromPolygons([Vector(v) for v in bd['co'].astype(np.float64)], faces, epsilon=0.0)
    td = top['d']
    tv = np.zeros(len(td['co']), bool)
    for p in np.where(top['keep'] & (top['region'] != REG['bottom']))[0]:
        tv[td['vi'][td['ls'][p]:td['ls'][p] + td['lt'][p]]] = True
    moved = 0
    for i in np.where(tv & (td['co'][:, 2] < waist + 0.004))[0]:
        p = Vector(td['co'][i].tolist())
        q, n, _, dist = bvh.find_nearest(p, 0.12)
        if q is None:
            continue
        # the bottom's outward normal: from the body axis through q (face normals may be flipped)
        out = Vector((q.x, q.y + 0.0, 0.0))
        if n.dot(Vector((q.x, q.y, 0))) < 0:
            n = -n
        if (p - q).dot(n) > -0.006:
            depth = 0.008 if p.z < waist - 0.01 else 0.004
            td['co'][i] = np.array(q - n * depth)
            moved += 1
    return moved


def fill_small_holes(d, max_perimeter, J=None, k=1.0):
    """Close the openings of a garment that are not cuffs, hems or the neckline: small loops (button
    holes and the like) and slit pockets (long, thin loops on the chest, hips or thighs), with a fan
    around the loop centre (UVs and weights averaged; the fan faces the way the garment does)."""
    import numpy as np
    from collections import defaultdict
    debug = '--debug-holes' in sys.argv
    E = defaultdict(list)
    for p in range(len(d['ls'])):
        s, n = d['ls'][p], d['lt'][p]
        for kk in range(n):
            a, b = d['vi'][s + kk], d['vi'][s + (kk + 1) % n]
            E[(min(a, b), max(a, b))].append((s + kk, s + (kk + 1) % n, a, b))
    adj = defaultdict(list)
    vuv = {}
    for key, lst in E.items():
        if len(lst) == 1:
            la, lb, a, b = lst[0]
            adj[a].append(b)
            adj[b].append(a)
            vuv.setdefault(a, d['uv'][la])
            vuv.setdefault(b, d['uv'][lb])
    seen = set()
    new_co, new_nr, new_W = [], [], []
    add_vi, add_uv, add_ls, add_lt = [], [], [], []
    nv = len(d['co'])
    filled = 0
    for start in list(adj):
        if start in seen:
            continue
        # the boundary component (undirected walk)
        comp, stack = [], [start]
        seen.add(start)
        while stack:
            v = stack.pop()
            comp.append(v)
            for w in adj[v]:
                if w not in seen:
                    seen.add(w)
                    stack.append(w)
        if len(comp) < 3 or len(comp) > 160 or any(len(adj[v]) != 2 for v in comp):
            if debug:
                log(f'  boundary component skipped: n={len(comp)} (not a simple loop)')
            continue
        loop = [start]
        prev, cur = None, start
        while True:
            nx = adj[cur][0] if adj[cur][0] != prev else adj[cur][1]
            if nx == start:
                break
            loop.append(nx)
            prev, cur = cur, nx
            if len(loop) > len(comp):
                break
        if len(loop) != len(comp):
            continue
        pts = d['co'][loop]
        per = np.linalg.norm(pts - np.roll(pts, -1, 0), axis=1).sum()
        c = pts.mean(0)
        if per > max_perimeter:
            # a slit pocket: thin (area small for its perimeter), on the trunk or thighs, well away from
            # the neck and the wrists / ankles
            if J is None or per > 0.42 * k:
                if debug:
                    log(f'  open loop (long): n={len(loop)} per={per:.3f} c={c.round(3).tolist()}')
                continue
            cr = np.cross(pts - c, np.roll(pts, -1, 0) - c)
            area = 0.5 * np.linalg.norm(cr.sum(0))
            iso = 4 * np.pi * area / (per * per)
            sh_z = 0.5 * (J['armL'][2] + J['armR'][2])
            near = min(np.linalg.norm(c - J[j]) for j in ('neck', 'handL', 'handR', 'footL', 'footR', 'foreL', 'foreR'))
            if iso > 0.22 or c[2] > sh_z - 0.06 * k or near < 0.12 * k:
                if debug:
                    log(f'  open loop kept: n={len(loop)} per={per:.3f} iso={iso:.3f} z-sh={c[2] - sh_z:+.3f} near={near:.3f}')
                continue
        uvs = np.array([vuv[v] for v in loop])
        cu = uvs.mean(0)
        ci = nv + len(new_co)
        new_co.append(c)
        nrm = d['nr'][loop].mean(0)
        nrm = nrm / (np.linalg.norm(nrm) + 1e-9)
        new_nr.append(nrm)
        new_W.append(d['W'][loop].mean(0))
        # orientation: the fan's normal along the garment's
        fan_n = np.cross(pts - c, np.roll(pts, -1, 0) - c).sum(0)
        order = list(range(len(loop))) if fan_n @ nrm >= 0 else list(range(len(loop)))[::-1]
        for ii in range(len(order)):
            i0, i1 = order[ii], order[(ii + 1) % len(order)]
            a, b = loop[i0], loop[i1]
            add_ls.append(len(d['vi']) + len(add_vi))
            add_lt.append(3)
            add_vi += [a, b, ci]
            add_uv += [vuv[a], vuv[b], cu]
        filled += 1
        if debug:
            log(f'  filled loop: n={len(loop)} per={per:.3f}')
    if filled:
        d['co'] = np.concatenate([d['co'], np.array(new_co, np.float32)])
        d['nr'] = np.concatenate([d['nr'], np.array(new_nr, np.float32)])
        d['W'] = np.concatenate([d['W'], np.array(new_W, np.float32)])
        d['vi'] = np.concatenate([d['vi'], np.array(add_vi, np.int32)])
        d['uv'] = np.concatenate([d['uv'], np.array(add_uv, np.float32)])
        d['ls'] = np.concatenate([d['ls'], np.array(add_ls, np.int32)])
        d['lt'] = np.concatenate([d['lt'], np.array(add_lt, np.int32)])
    return filled


def zip_slits(d, k=1.0, hip_z=None):
    """Close V-shaped notches of a garment's open borders (lapel notches, vents, darts): where the
    border runs into a tip with the cloth on the outside of the V on both arms, the V is stitched
    shut from the tip outwards while its mouth stays narrower than ~4.5 cm (the notch would show the
    skin through the garment)."""
    import numpy as np
    from collections import defaultdict
    debug = '--debug-holes' in sys.argv
    E = defaultdict(list)
    for p in range(len(d['ls'])):
        s0, n = d['ls'][p], d['lt'][p]
        for kk in range(n):
            a, b = d['vi'][s0 + kk], d['vi'][s0 + (kk + 1) % n]
            E[(min(a, b), max(a, b))].append((p, s0 + kk, s0 + (kk + 1) % n, a, b))
    adj = defaultdict(list)
    vuv = {}
    eface = {}
    for key, lst in E.items():
        if len(lst) == 1:
            p, la, lb, a, b = lst[0]
            adj[a].append(b)
            adj[b].append(a)
            vuv.setdefault(a, d['uv'][la])
            vuv.setdefault(b, d['uv'][lb])
            eface[key] = p
    co = d['co']

    def fcent(p):
        return co[d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]].mean(0)
    seen = set()
    add_vi, add_uv = [], []
    zipped = 0
    for start in list(adj):
        if start in seen or len(adj[start]) != 2:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        ok = True
        while True:
            if len(adj[cur]) != 2:
                ok = False
                break
            nx = adj[cur][0] if adj[cur][0] != prev else adj[cur][1]
            if nx == start:
                break
            if nx in seen:
                ok = False
                break
            loop.append(nx)
            seen.add(nx)
            prev, cur = cur, nx
        n = len(loop)
        if not ok or n < 12:
            continue
        P = co[loop]
        used = np.zeros(n, bool)
        for i in range(n):
            if used[i]:
                continue
            a, b = P[(i - 1) % n] - P[i], P[(i + 1) % n] - P[i]
            la, lb = np.linalg.norm(a), np.linalg.norm(b)
            if la < 1e-6 or lb < 1e-6:
                continue
            ang = np.degrees(np.arccos(np.clip((a @ b) / (la * lb), -1, 1)))
            if ang > 85:
                continue
            u = a / la + b / lb
            u /= np.linalg.norm(u) + 1e-12
            # the cloth beside each arm lies outside the V (else this is a pointed corner of the cloth)
            gap = True
            for nb, arm in ((loop[(i - 1) % n], a / la), (loop[(i + 1) % n], b / lb)):
                f = eface.get((min(loop[i], nb), max(loop[i], nb)))
                if f is None:
                    gap = False
                    break
                w = u - arm * (u @ arm)
                w /= np.linalg.norm(w) + 1e-12
                m = 0.5 * (P[i] + co[nb])
                if debug:
                    fc = fcent(f)
                    log(f'    arm len {np.linalg.norm(co[nb] - P[i]):.3f} side {(fc - m) @ w:+.4f} off {np.linalg.norm(fc - m):.4f}')
                if (fcent(f) - m) @ w > 0:
                    gap = False
                    break
            # (narrow vents and small notches with overlapping cloth are closed anyway)
            gap = gap or ang < 25 or (la < 0.015 * k and lb < 0.015 * k and ang < 70)
            if debug:
                log(f'  tip: angle {ang:.0f} gap {gap} at {P[i].round(3).tolist()}')
            if not gap:
                continue
            depth = 0
            # (a skirt's back vent opens wider towards the flared hem: it is closed all the way down)
            vent = hip_z is not None and P[i][2] < hip_z and ang < 30
            for j in range(1, 24):
                if used[(i - j) % n] or used[(i + j) % n] or (i - j) % n == (i + j) % n:
                    break
                if np.linalg.norm(P[(i - j) % n] - P[(i + j) % n]) > (0.12 if vent else 0.05) * k:
                    break
                depth = j
            if debug:
                log(f'  notch: angle {ang:.0f} depth {depth} vent {vent} at {P[i].round(3).tolist()}')
                for j in range(1, 14):
                    log(f'    j={j} gap {np.linalg.norm(P[(i - j) % n] - P[(i + j) % n]):.3f} used {used[(i - j) % n]} {used[(i + j) % n]} z {P[(i - j) % n][2]:.3f}')
            if depth < 1:
                continue
            for j in range(-depth, depth + 1):
                used[(i + j) % n] = True
            for j in range(depth):
                l0, l1 = loop[(i - j) % n], loop[(i - j - 1) % n]
                r0, r1 = loop[(i + j) % n], loop[(i + j + 1) % n]
                tris = [(l1, r1, l0)] if j == 0 else [(l1, r1, l0), (l0, r1, r0)]
                for t in tris:
                    add_vi += list(t)
                    add_uv += [vuv[t[0]], vuv[t[1]], vuv[t[2]]]
            zipped += 1
    if zipped:
        # orient the new triangles like the garment around them (by vertex normals)
        vi = np.array(add_vi, np.int64).reshape(-1, 3)
        uv = np.array(add_uv, np.float32).reshape(-1, 3, 2)
        p0, p1, p2 = co[vi[:, 0]], co[vi[:, 1]], co[vi[:, 2]]
        fn = np.cross(p1 - p0, p2 - p0)
        vn = d['nr'][vi].sum(1)
        flip = (fn * vn).sum(1) < 0
        vi[flip] = vi[flip][:, ::-1]
        uv[flip] = uv[flip][:, ::-1]
        nt = len(vi)
        d['ls'] = np.concatenate([d['ls'], (len(d['vi']) + 3 * np.arange(nt)).astype(np.int32)])
        d['lt'] = np.concatenate([d['lt'], np.full(nt, 3, np.int32)])
        d['vi'] = np.concatenate([d['vi'], vi.reshape(-1).astype(np.int32)])
        d['uv'] = np.concatenate([d['uv'], uv.reshape(-1, 2)])
    return zipped


def drop_polys(d, drop):
    """Remove polygons (mask) from an extracted part (vertices stay)."""
    import numpy as np
    keep = np.where(~drop)[0]
    if len(keep) == len(d['ls']):
        return
    idx = np.concatenate([np.arange(d['ls'][p], d['ls'][p] + d['lt'][p]) for p in keep]) if len(keep) else np.zeros(0, np.int64)
    d['vi'] = d['vi'][idx]
    d['uv'] = d['uv'][idx]
    d['lt'] = d['lt'][keep]
    d['ls'] = (np.cumsum(d['lt']) - d['lt']).astype(np.int32)


def face_front(body, E, hk):
    """front(x, z) -> the frontmost (min y) head skin depth near (x, z), or None (Blender space)."""
    import numpy as np
    from mathutils import Vector
    from mathutils.kdtree import KDTree
    bc = body['co']
    head = np.where((bc[:, 2] > E[2] - 0.13 * hk) & (bc[:, 2] < E[2] + 0.14 * hk) & (bc[:, 1] < E[1] + 0.07 * hk)
                    & (np.abs(bc[:, 0] - E[0]) < 0.10 * hk))[0]
    kd = KDTree(len(head))
    for j, i in enumerate(head):
        kd.insert(Vector((float(bc[i, 0]), float(bc[i, 2]), 0.0)), j)
    kd.balance()

    def front(x, z, r=0.012):
        hits = kd.find_range(Vector((float(x), float(z), 0.0)), r * hk)
        if not hits:
            return None
        return min(float(bc[head[j], 1]) for _, j, _ in hits)
    return front


def clear_face_window(d, body, E, hk, style, cid):
    """Trim hair that hangs in front of the eyes and brows (side-swept fringes) with a soft cut: a
    window in front of the face (from the cheekbones up to a hairline ~4 cm above the eye centres,
    between the temples). Each hair vertex gets its signed distance to the window; the hair fades out
    (strand ends, broken up by the shader) over the last FADE outside it, polygons wholly inside go.
    The fade is linear across each polygon, so the fringe ends in a smooth line (never a sawtooth of
    removed quads)."""
    import numpy as np
    co = d['co']
    front = face_front(body, E, hk)
    hl = E[2] + 0.040 * hk           # hairline (the brows are ~2 cm above the eye centres)
    lo = E[2] - 0.075 * hk
    wx = 0.064 * hk
    FADE = 0.016 * hk
    n = len(co)
    sd = np.ones(n, np.float64)      # signed distance to the window (m), < 0 inside
    for i in range(n):
        x, y, z = co[i]
        cx = min(max(x, E[0] - wx), E[0] + wx)
        cz = min(max(z, lo), hl)
        fy = front(cx, cz)
        if fy is None:
            continue
        # (rounded box: above the hairline / beside the temples / below the cheekbones / behind the
        # plane 1.8 cm in front of the face are outside)
        sd[i] = max(z - hl, abs(x - E[0]) - wx, lo - z, y - (fy + 0.018 * hk))
    inwin = sd <= 0
    if not inwin.any():
        return 0
    fade_v = np.clip(sd / FADE, 0.0, 1.0)
    # polygons wholly inside the window go; long cards hanging across the window in front of the
    # face too (their corners lie outside it)
    drop = np.zeros(len(d['ls']), bool)
    for p in range(len(d['ls'])):
        vs = d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]
        if inwin[vs].all():
            drop[p] = True
            continue
        if inwin[vs].any():
            continue
        pv = co[vs]
        zmin, zmax = pv[:, 2].min(), pv[:, 2].max()
        c = pv.mean(0)
        if zmin < hl and zmax > lo and abs(c[0] - E[0]) < wx:
            front_all = True
            for v in pv:
                fy = front(min(max(v[0], E[0] - wx), E[0] + wx), min(max(v[2], lo), hl))
                if fy is None or v[1] > fy + 0.018 * hk:
                    front_all = False
                    break
            if front_all:
                drop[p] = True
    # small pieces left over in front of the forehead (stubs of trimmed cards lying on the skin) go too
    par = np.arange(n)

    def find(a_):
        while par[a_] != a_:
            par[a_] = par[par[a_]]
            a_ = par[a_]
        return a_
    for p in np.where(~drop)[0]:
        vs = d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]
        r0 = find(vs[0])
        for v in vs[1:]:
            r1 = find(v)
            if r1 != r0:
                par[r1] = r0
    comp = {}
    for p in np.where(~drop)[0]:
        comp.setdefault(find(d['vi'][d['ls'][p]]), []).append(p)
    for ps in comp.values():
        if len(ps) > 10:
            continue
        c = np.concatenate([co[d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]] for p in ps]).mean(0)
        if abs(c[0] - E[0]) < 0.085 * hk and lo < c[2] < E[2] + 0.11 * hk:
            fy = front(c[0], min(c[2], E[2] + 0.13 * hk), 0.02)
            if fy is not None and c[1] < fy + 0.03 * hk:
                drop[ps] = True
    used = np.zeros(n, bool)
    for p in np.where(~drop)[0]:
        used[d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]] = True
    # strand ends at the cut fade out (the shader breaks the fade into strands of uneven length);
    # the kept polygons' vertices on the border of a dropped card (a card hanging across the window)
    # fade too
    fade = fade_v.astype(np.float32)
    for p in np.where(drop)[0]:
        for v in d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]:
            if used[v] and not inwin[v]:
                fade[v] = min(fade[v], 0.0)
    d['fade'] = fade
    drop_polys(d, drop)
    log(cid, f'hair {style}: face window cut ({int(drop.sum())} polygons dropped, {int(((fade > 0) & (fade < 1) & used).sum())} vertices fading)')
    return int(drop.sum())


def refit_hat(d, body, E, hk, cid):
    """Black fedoras sit low and wide: scale the hat about its crown axis, widen the brim and lower it so
    the sweatband sits ~2.5 cm above the brows."""
    import numpy as np
    co = d['co']
    z = co[:, 2]
    band = float(np.percentile(z, 8))
    top = float(z.max())
    crown = co[(z > band + 0.03 * hk) & (z < top - 0.02 * hk)]
    cx, cy = float(crown[:, 0].mean()), float(crown[:, 1].mean())
    r = np.hypot(co[:, 0] - cx, co[:, 1] - cy)
    rc = float(np.percentile(np.hypot(crown[:, 0] - cx, crown[:, 1] - cy), 90))
    log(cid, f'hat: band {band - E[2]:+.3f} top {top - E[2]:+.3f} above the eyes, crown r {rc:.3f}, brim r {r.max():.3f}')
    s = 1.08
    P = np.array([cx, cy, band])
    co[:] = P + (co - P) * s
    z = co[:, 2]
    r = np.hypot(co[:, 0] - cx, co[:, 1] - cy)
    rc *= s
    brim = (z < band + 0.02 * hk) & (r > rc * 0.98)
    f = np.where(brim, 1.0 + 0.06 * np.clip((r - rc) / max(1e-3, r.max() - rc), 0, 1), 1.0)
    co[:, 0] = cx + (co[:, 0] - cx) * f
    co[:, 1] = cy + (co[:, 1] - cy) * f
    target = E[2] + 0.036 * hk
    co[:, 2] += target - band
    r = np.hypot(co[:, 0] - cx, co[:, 1] - cy)
    log(cid, f'hat refit: band {target - E[2]:+.3f}, brim r {r.max():.3f}, crown top {co[:, 2].max() - E[2]:+.3f}')


def uv_islands(d):
    """Polygon labels of UV islands (polygons sharing an edge with the same UVs on both sides)."""
    import numpy as np
    P = len(d['ls'])
    parent = np.arange(P)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    seen = {}
    for p in range(P):
        s, n = d['ls'][p], d['lt'][p]
        for k in range(n):
            l0, l1 = s + k, s + (k + 1) % n
            v0, v1 = d['vi'][l0], d['vi'][l1]
            u0 = tuple(np.round(d['uv'][l0] * 4096).astype(int))
            u1 = tuple(np.round(d['uv'][l1] * 4096).astype(int))
            key = (min((v0, u0), (v1, u1)), max((v0, u0), (v1, u1)))
            if key in seen:
                a, b = find(seen[key]), find(p)
                if a != b:
                    parent[a] = b
            else:
                seen[key] = p
    return np.array([find(p) for p in range(P)])


def skirt_clearance(d, vmask, body, J, legmask):
    """Keep a skirt clear of the legs in the rest pose (thighs bulge forward below the hips): skirt
    vertices closer than a clearance to the body's legs are pushed out horizontally."""
    import numpy as np
    from mathutils import Vector
    from mathutils.kdtree import KDTree
    co = d['co']
    hip = 0.5 * (J['thighL'][2] + J['thighR'][2])
    bc = body['co']
    legs = np.where((bc[:, 2] < hip + 0.02) & (bc[:, 2] > 0.05) & legmask)[0]
    kd = KDTree(len(legs))
    for k, i in enumerate(legs):
        kd.insert(Vector(bc[i].tolist()), k)
    kd.balance()
    idx = np.where(vmask & (co[:, 2] < hip + 0.01))[0]
    if not len(idx):
        return
    cy = 0.5 * (J['thighL'][1] + J['thighR'][1])
    # required radial growth per height band, then a smooth (monotone towards the hem) scale profile
    zs = co[idx, 2]
    bands = np.arange(zs.min() - 0.02, hip + 0.04, 0.02)
    need = np.ones(len(bands))
    for i in idx:
        p = co[i]
        u = np.clip((hip - p[2]) / 0.35, 0, 1)
        clear = 0.016 + 0.024 * u
        _, _, dist = kd.find(Vector(p.tolist()))
        if dist < clear:
            r = np.hypot(p[0], p[1] - cy)
            if r > 1e-3:
                b = int((p[2] - bands[0]) / 0.02)
                need[b] = max(need[b], (r + clear - dist) / r)
    # a skirt only widens downwards: carry the need from each band to the bands below it, smooth
    for b in range(len(need) - 2, -1, -1):
        need[b] = max(need[b], 1 + (need[b + 1] - 1) * 0.97)
    need = np.convolve(np.pad(need, 3, mode='edge'), np.ones(7) / 7, mode='valid')
    f = np.interp(zs, bands, need)
    co[idx, 0] = co[idx, 0] * f
    co[idx, 1] = cy + (co[idx, 1] - cy) * f


def cut_tube(d, keep, pmask, vmask, J, chain, length, poly_vals):
    """Cut a sleeve / trouser leg: faces of the part (pmask) on the limb (vmask) beyond `length` along the
    limb chain (0 at the shoulder / hip, 0.5 at the elbow / knee, 1 at the wrist / ankle) go, and the new
    hem ring is snapped to exactly that length, square to the limb."""
    import numpy as np
    co = d['co']
    t = np.zeros(len(co))
    seg = {}
    for s, S in (('l', 'L'), ('r', 'R')):
        side = (co[:, 0] > 0) if s == 'l' else (co[:, 0] <= 0)
        a, b, c = J[chain[0] + S], J[chain[1] + S], J[chain[2] + S]
        t1 = np.clip(((co - a) @ (b - a)) / ((b - a) @ (b - a)), 0, 1)
        t2 = np.clip(((co - b) @ (c - b)) / ((c - b) @ (c - b)), 0, 1)
        d1 = np.linalg.norm(co - (a + t1[:, None] * (b - a)), axis=1)
        d2 = np.linalg.norm(co - (b + t2[:, None] * (c - b)), axis=1)
        tt = np.where(d1 <= d2, 0.5 * t1, 0.5 + 0.5 * t2)
        t = np.where(side, tt, t)
        seg[s] = (a, b, c)
    tv = np.where(vmask, t, 0.0)
    pt = poly_vals(d, tv.astype(np.float32))
    remove = pmask & (pt > length) & keep
    keep &= ~remove
    # hem: vertices shared by kept and removed faces
    inkept = np.zeros(len(co), bool)
    inrem = np.zeros(len(co), bool)
    for p in np.where(pmask)[0]:
        vs = d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]
        if keep[p]:
            inkept[vs] = True
        elif remove[p]:
            inrem[vs] = True
    hem = np.where(inkept & inrem & vmask)[0]
    for i in hem:
        s = 'l' if co[i, 0] > 0 else 'r'
        a, b, c = seg[s]
        if length <= 0.5:
            p0, p1, tl, ti = a, b, length / 0.5, t[i] / 0.5
        else:
            p0, p1, tl, ti = b, c, (length - 0.5) / 0.5, (t[i] - 0.5) / 0.5
        L = np.linalg.norm(p1 - p0)
        mv = (tl - ti) * L
        if abs(mv) < 0.05:
            co[i] += (p1 - p0) / L * mv


def lengthen_skirt(d, vmask, J, length, waist_z):
    """Stretch the skirt part (vmask) of a garment downwards to a hem `length` of the way from the
    knee to the ankle, flaring towards the hem so it hangs clear of the calves."""
    import numpy as np
    co = d['co']
    idx = np.where(vmask)[0]
    z = co[idx, 2]
    hem = z.min()
    knee = 0.5 * (J['shinL'][2] + J['shinR'][2])
    ankle = 0.5 * (J['footL'][2] + J['footR'][2])
    target = knee - length * (knee - ankle)
    hip = 0.5 * (J['thighL'][2] + J['thighR'][2])
    top = hip + 0.02
    if target >= hem - 0.005:
        # shorter than the original: lift the hem
        pass
    s = (top - target) / max(1e-3, top - hem)
    zz = np.where(z < top, top - (top - z) * s, z)
    # flare below the hips (radial, about the body's vertical axis through the hip centre)
    cx = 0.0
    cy = 0.5 * (J['thighL'][1] + J['thighR'][1])
    u = np.clip((top - zz) / max(1e-3, top - target), 0, 1)
    flare = 1.0 + (0.10 + 0.22 * max(0.0, length)) * u ** 1.6
    co[idx, 0] = cx + (co[idx, 0] - cx) * flare
    co[idx, 1] = cy + (co[idx, 1] - cy) * flare
    co[idx, 2] = zz


def level_hem(d, pmask, hip_z):
    """A skirt's hem: the open border loop below the hips is levelled (the kick pleat's V at the back
    pulled down to the hem, so it closes) and relaxed along the loop (no sawtooth), and the flap of cloth
    behind the vent drops to the hem line too."""
    import numpy as np
    from collections import defaultdict
    co = d['co']
    cnt = defaultdict(int)
    for p in np.where(pmask)[0]:
        vs = d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]
        for k in range(len(vs)):
            a, b = int(vs[k]), int(vs[(k + 1) % len(vs)])
            cnt[(min(a, b), max(a, b))] += 1
    adj = defaultdict(list)
    for (a, b), c in cnt.items():
        if c == 1:
            adj[a].append(b)
            adj[b].append(a)
    seen = set()
    moved = 0
    hem_base = None
    for v0 in list(adj):
        if v0 in seen:
            continue
        comp, stack = [], [v0]
        seen.add(v0)
        while stack:
            v = stack.pop()
            comp.append(v)
            for w in adj[v]:
                if w not in seen:
                    seen.add(w)
                    stack.append(w)
        z = co[comp, 2]
        if z.min() > hip_z - 0.1 or len(comp) < 12:
            continue
        # the hem line: the loop's lowest band (a wrap's front edge or a vent may run up from it)
        low = z[z < z.min() + 0.05]
        base = float(np.median(low))
        hem_base = base if hem_base is None else min(hem_base, base)
        # level: nothing near the hem stays more than 6 mm above or below the hem line (the vent's V, a
        # pointed tab)
        for v in comp:
            dz = co[v, 2] - base
            if 0.006 < abs(dz) < 0.07:
                co[v, 2] = base + np.sign(dz) * 0.006 * (1 - np.exp(-(abs(dz)) / 0.006))
                moved += 1
        # relax along the loop (the loop's own neighbours), only when it is a simple loop
        if all(len(adj[v]) == 2 for v in comp) and np.ptp(co[comp, 2]) < 0.03:
            order = [comp[0]]
            prev = None
            while True:
                cur = order[-1]
                nx = adj[cur][0] if adj[cur][0] != prev else adj[cur][1]
                if nx == order[0] or len(order) > len(comp):
                    break
                order.append(nx)
                prev = cur
            if len(order) == len(comp):
                P = co[order].astype(np.float64)
                for _ in range(4):
                    P = 0.5 * P + 0.25 * (np.roll(P, 1, 0) + np.roll(P, -1, 0))
                co[order] = P
    # cloth inside the skirt hanging below its hem (a fan or fold of the original's slit): up to the hem
    if hem_base is not None:
        vs = np.unique(np.concatenate([d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]] for p in np.where(pmask)[0]]))
        for v in vs:
            if co[v, 2] < hem_base - 0.006:
                co[v, 2] = hem_base - 0.006
                moved += 1
    return moved


def reweight_skirt(op, J, ge_index, waist_z):
    """Skirt vertices: from the pelvis at the waistband to an even blend of both thighs at the hem, so
    the skirt sways with the stride instead of splitting between the legs."""
    import numpy as np
    d = op['d']
    co = d['co']
    reg = np.zeros(len(co), np.int16)
    for p in range(len(d['ls'])):
        reg[d['vi'][d['ls'][p]:d['ls'][p] + d['lt'][p]]] = op['region'][p]
    m = (reg == CASTM.REGIONS['bottom'])
    if not m.any():
        return
    hip = 0.5 * (J['thighL'][2] + J['thighR'][2])
    hem = co[m, 2].min()
    top = hip + 0.05
    u = np.clip((top - co[:, 2]) / max(1e-3, top - hem), 0, 1)
    W = d['W']
    pel = ge_index['pelvis']
    tl, tr = ge_index['thigh_l'], ge_index['thigh_r']
    s1 = ge_index['spine_01']
    side = np.clip(co[:, 0] / 0.10, -1, 1)          # +X = the character's left in Blender
    # the sides of a skirt move with the thigh beneath them, the middle front and back with both
    wl = 0.5 + 0.5 * np.sign(side) * np.abs(side) ** 0.8
    for i in np.where(m)[0]:
        if co[i, 2] > top + 0.02:
            continue
        a = u[i] ** 0.8
        row = np.zeros(W.shape[1], np.float32)
        row[pel] = 1 - a * 0.95
        row[tl] = a * 0.95 * wl[i]
        row[tr] = a * 0.95 * (1 - wl[i])
        if co[i, 2] > hip:
            row[s1] = 0.15 * (1 - a)
        W[i] = row


if __name__ == '__main__':
    args = parse(script_args())
    if args.one:
        try:
            build_one(args.one, args.blend)
        except Exception:
            import traceback
            traceback.print_exc()
            sys.stdout.flush()
            os._exit(1)
        sys.stdout.flush()
        os._exit(0)
    run_driver(args)
