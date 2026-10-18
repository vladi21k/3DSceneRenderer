"""Texture stage of the crowd character generator (run by mh_build.py, plain python3 + numpy/PIL).

Builds the shared texture arrays used by every character from the MakeHuman CC0 system assets:

  albedo array (1024 x 1024 layers, RGBA, sRGB):
    skin layers   ('color')  MakeHuman skin diffuse; skin tones are per-character tint gains
    garment layers('detail') neutral fabric detail (linear value = 0.5 * detail, mean ~0.5): folds from the
                             garment's ambient-occlusion map, denim fading from the jeans diffuse; logos and
                             trims are not carried over. The runtime tints them: albedo = 2 * texel * tint.
    hair layers   ('detail') luminance detail + coverage alpha (alpha bled into the transparent texels)
    misc layers               shoes (colour), fedora felt (detail), eyebrows / eyelashes (detail + alpha),
                             eyes (colour), beard / stubble (detail + alpha) packed into sub-rectangles
  normal array (1024 x 1024 layers, RGB tangent-space normals, OpenGL convention) for garments, shoes, hat.

Writes WebP strips (8 layers stacked vertically: 1024 x 8192) to assets/humans_mh/tex/ and the layer table
.work/mh/tex/layers.json (merged into the cast metadata by mh_export.py).
"""
import os
import sys
import json
import glob
import zlib
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mh_cast as CASTM  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
ASSETS = '/opt/mh/system_assets'
_WORK, _OUT = CASTM.stage_dirs()
RAW = os.path.join(_WORK, 'raw')
WORK = os.path.join(_WORK, 'tex')
OUT = os.path.join(_OUT, 'tex')
S = 1024          # layer size
STRIP = 8         # layers per WebP strip
Q_ALBEDO = 84
Q_NORMAL = 86

# roughness per layer kind (the runtime may refine per region)
ROUGH = {'skin': 0.52, 'cloth': 0.86, 'hair': 0.42, 'misc': 0.6}
SUIT_ROUGH = {'male_elegantsuit01': 0.72, 'female_elegantsuit01': 0.8, 'female_sportsuit01': 0.7}


def log(*a):
    print('[mh-tex]', *a, flush=True)


# ----------------------------------------------------------------------------- colour helpers

def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def hex_lin(h):
    h = h.lstrip('#')
    return srgb_to_lin(np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32))


def load(path, size=S, mode='RGBA'):
    im = Image.open(path).convert(mode)
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def lum(lin):
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def push_pull(img, mask, levels=10):
    """Fill texels outside `mask` with a smooth extension of the texels inside (mip-safe padding)."""
    img = img.astype(np.float32)
    m = mask.astype(np.float32)
    if m.all():
        return img
    pyr = []
    cur, cm = img * m[..., None], m
    for _ in range(levels):
        pyr.append((cur, cm))
        if cur.shape[0] <= 2:
            break
        h, w = cur.shape[:2]
        cur = cur[:h // 2 * 2, :w // 2 * 2].reshape(h // 2, 2, w // 2, 2, -1).sum((1, 3))
        cm = cm[:h // 2 * 2, :w // 2 * 2].reshape(h // 2, 2, w // 2, 2).sum((1, 3))
    # normalise each level
    filled = None
    for cur, cm in reversed(pyr):
        val = cur / np.maximum(cm, 1e-6)[..., None]
        have = cm > 1e-6
        if filled is not None:
            up = np.repeat(np.repeat(filled, 2, 0), 2, 1)[:val.shape[0], :val.shape[1]]
            if up.shape[:2] != val.shape[:2]:
                up = np.pad(up, ((0, val.shape[0] - up.shape[0]), (0, val.shape[1] - up.shape[1]), (0, 0)), mode='edge')
            val = np.where(have[..., None], val, up)
        filled = val
    return np.where(mask[..., None], img, filled)


def raster_mask(tris_uv, size=S, labels=None, nlab=1):
    """Rasterise UV triangles (n, 3, 2) into a (size, size) mask (row 0 = v 1). With labels: per-label masks."""
    out = np.zeros((nlab, size, size), bool)
    if labels is None:
        labels = np.zeros(len(tris_uv), np.int32)
    P = tris_uv.copy()
    P[..., 0] = P[..., 0] * size - 0.5
    P[..., 1] = (1 - P[..., 1]) * size - 0.5
    for t, lab in zip(P, labels):
        x0, y0 = np.floor(t.min(0)).astype(int)
        x1, y1 = np.ceil(t.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        a, b, c = t
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
        l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
        l3 = 1 - l1 - l2
        e = -0.02
        inside = (l1 >= e) & (l2 >= e) & (l3 >= e)
        out[lab, ys[inside], xs[inside]] = True
    return out


def fabric_noise(seed, size=S):
    """Fine fabric grain + slow mottling (multiplicative, mean 1)."""
    rng = np.random.default_rng(seed)
    n1 = ndimage.gaussian_filter(rng.standard_normal((size, size)).astype(np.float32), 0.7)
    n2 = ndimage.gaussian_filter(rng.standard_normal((size, size)).astype(np.float32), 18)
    n1 /= n1.std() + 1e-6
    n2 /= n2.std() + 1e-6
    return 1 + 0.035 * n1 + 0.03 * n2


# ----------------------------------------------------------------------------- per texture kind

def skin_layer(name):
    files = glob.glob(f'{ASSETS}/skins/{name}/*.png')
    files = [f for f in files if not f.endswith('.thumb')]
    im = load(files[0], mode='RGB')
    lin = srgb_to_lin(im)
    # body skin reference colour: median over the torso / limbs area of the layout
    region = lin[int(S * 0.25):int(S * 0.75), int(S * 0.15):int(S * 0.55)]
    ref = np.median(region.reshape(-1, 3), axis=0)
    rgba = np.concatenate([im, np.ones(im.shape[:2] + (1,), np.float32)], -1)
    return rgba, dict(type='color', ref=ref.tolist())


def garment_layer(suit, masks):
    """masks: dict region -> bool mask of the texels the characters use."""
    d = f'{ASSETS}/clothes/{suit}'
    diff = srgb_to_lin(load(f'{d}/{suit}_diffuse.png', mode='RGB'))
    aop = f'{d}/{suit}_ao.png'
    ao = load(aop, mode='L')[..., 0] if os.path.exists(aop) else np.ones((S, S), np.float32)
    if CASTM.SUITS[suit]['tex'] == 'color':
        rgba = np.concatenate([lin_to_srgb(diff), np.ones((S, S, 1), np.float32)], -1)
        used = np.zeros((S, S), bool)
        for m in masks.values():
            used |= m
        rgba[..., :3] = push_pull(rgba[..., :3], ndimage.binary_dilation(used, iterations=2))
        return rgba, dict(type='color')
    L = lum(diff)
    detail = np.ones((S, S), np.float32)
    used = np.zeros((S, S), bool)
    noise = fabric_noise(zlib.crc32(suit.encode()) % 1000 + 7)
    aon = ao / max(1e-3, np.percentile(ao[ao > 0.05], 90)) if (ao > 0.05).any() else ao
    fold = np.clip(aon, 0, 1.05) ** 0.9
    for reg, m in masks.items():
        if not m.any():
            continue
        used |= m
        denim = reg == 'bottom' and suit not in ('female_elegantsuit01', 'female_sportsuit01', 'male_elegantsuit01')
        if denim:
            # stonewash: the broad fading kept (softened), small bright specks (rips, frayed hems,
            # scuffs) and dark grime clamped to the local level
            med = np.median(L[m])
            dd = np.clip(L / max(1e-4, med), 0.25, 1.9)
            mf = m.astype(np.float32)
            low = ndimage.gaussian_filter(dd * mf, 14) / np.maximum(ndimage.gaussian_filter(mf, 14), 1e-3)
            hi = np.clip(dd - low, -0.16, 0.10)
            dd = np.clip(1.0 + (low - 1.0) * 0.7 + hi, 0.6, 1.32)
            detail = np.where(m, dd * (0.75 + 0.25 * fold), detail)
        else:
            detail = np.where(m, (0.22 + 0.83 * fold) * noise, detail)
    # normalise the used texels to a mean detail of 1 (tint = the garment's mean colour)
    if used.any():
        for reg, m in masks.items():
            if m.any():
                detail = np.where(m, detail / max(1e-3, detail[m].mean()), detail)
    v = np.clip(0.5 * detail, 0, 1)
    v = push_pull(v[..., None], ndimage.binary_dilation(used, iterations=2))[..., 0]
    g = lin_to_srgb(v)
    rgba = np.stack([g, g, g, np.ones_like(g)], -1)
    return rgba, dict(type='detail')


def normal_from(path, size=S):
    if not os.path.exists(path):
        return None
    n = load(path, size, mode='RGB')
    return n


def alpha_detail(path, size, boost=(0.08, 0.55)):
    """Luminance detail + alpha for hair-like textures; colour bled into the transparent texels."""
    im = load(path, size, mode='RGBA')
    a = im[..., 3]
    lin = srgb_to_lin(im[..., :3])
    L = lum(lin)
    op = a > 0.5
    med = np.median(L[op]) if op.any() else 0.2
    detail = np.clip(L / max(1e-4, med), 0.15, 2.4)
    v = np.clip(0.5 * detail, 0, 1)
    v = push_pull(v[..., None], ndimage.binary_dilation(a > 0.3, iterations=1))[..., 0]
    # thicker coverage so distant hair (mip-mapped alpha) keeps its volume
    lo, hi = boost
    a2 = np.clip((a - lo) / (hi - lo), 0, 1)
    a2 = a2 * a2 * (3 - 2 * a2)
    g = lin_to_srgb(v)
    return np.stack([g, g, g, a2], -1)


def beard_tile(size, style, seed=11):
    """Beard shell: v = how deep inside the beard (row 0 = v 1). Coverage rises smoothly with v (the
    shader breaks it into strand clumps); the colour carries fine strands along the growth direction."""
    rng = np.random.default_rng(seed + (0 if style == 'stubble' else 5))
    vv = np.linspace(1.0, 0.0, size)[:, None] * np.ones((1, size), np.float32)
    a = np.clip((vv - 0.06) / 0.4, 0, 1)
    a = a * a * (3 - 2 * a)
    st = rng.standard_normal((size, size)).astype(np.float32)
    st = ndimage.gaussian_filter(st, (3.0, 0.6))
    st /= st.std() + 1e-6
    detail = np.clip(1.0 + 0.2 * st, 0.55, 1.45)
    g = lin_to_srgb(np.clip(0.5 * detail, 0, 1))
    return np.stack([g, g, g, a], -1)


# ----------------------------------------------------------------------------- main

def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    metas = {}
    for f in sorted(glob.glob(os.path.join(RAW, '*.json'))):
        cid = os.path.basename(f)[:-5]
        if cid in CASTM.CAST:
            metas[cid] = json.load(open(f))
    # texture keys in use, and the UV triangles (with regions) per key
    uvtris = {}
    for cid, m in metas.items():
        z = np.load(os.path.join(RAW, cid + '.npz'))
        for p in m['parts']:
            key = p['tex']
            uv = z[p['key'] + '_uv']
            idx = z[p['key'] + '_idx']
            reg = z[p['key'] + '_reg']
            uvtris.setdefault(key, []).append((uv[idx], reg[idx[:, 0]]))
    keys = sorted(uvtris)
    log('texture keys:', len(keys))

    layers = []      # dicts: key, type, rough, ...
    albedo = []      # arrays (S, S, 4) in [0, 1] sRGB
    normals = []     # arrays (S, S, 3)
    remap = {}       # key -> dict(layer, rect=[u0, v0, su, sv], normal=layer|-1)

    def add_layer(img, info, nimg=None):
        albedo.append(img)
        li = len(albedo) - 1
        ni = -1
        if nimg is not None:
            normals.append(nimg)
            ni = len(normals) - 1
        layers.append(dict(info, index=li, normal=ni))
        return li, ni

    # skins
    for key in [k for k in keys if k.startswith('skin:')]:
        img, info = skin_layer(key.split(':')[1])
        li, ni = add_layer(img, dict(info, key=key, kind='skin', rough=ROUGH['skin']))
        remap[key] = dict(layer=li, rect=[0, 0, 1, 1], normal=ni, type='color', ref=info['ref'])
    # garments
    for key in [k for k in keys if k.startswith('cloth:')]:
        suit = key.split(':')[1]
        tri = uvtris[key]
        allt = np.concatenate([t[0] for t in tri])
        allr = np.concatenate([t[1] for t in tri])
        regs = {r: n for n, r in CASTM.REGIONS.items()}
        labs = sorted(set(int(r) for r in allr))
        lm = {l: i for i, l in enumerate(labs)}
        mk = raster_mask(allt, labels=np.array([lm[int(r)] for r in allr]), nlab=len(labs))
        masks = {regs[l]: mk[lm[l]] for l in labs}
        img, info = garment_layer(suit, masks)
        nimg = normal_from(f'{ASSETS}/clothes/{suit}/{suit}_normal.png')
        li, ni = add_layer(img, dict(info, key=key, kind='cloth', rough=SUIT_ROUGH.get(suit, ROUGH['cloth'])), nimg)
        remap[key] = dict(layer=li, rect=[0, 0, 1, 1], normal=ni, type=info['type'])
        log('garment', suit, 'regions', list(masks))
    # hair
    for key in [k for k in keys if k.startswith('hair:')]:
        name = key.split(':')[1]
        fs = [f for f in glob.glob(f'{ASSETS}/hair/{name}/*diffuse.png')]
        img = alpha_detail(fs[0], S)
        li, ni = add_layer(img, dict(key=key, kind='hair', type='detail', rough=ROUGH['hair'], alpha=True))
        remap[key] = dict(layer=li, rect=[0, 0, 1, 1], normal=-1, type='detail', alpha=True)
    # misc atlas layers: cells of 512 (shoes, hat, beard) and 256 (brows, lashes, eyes)
    cells512 = [k for k in keys if k.startswith(('shoes:', 'hat:', 'beard:'))]
    cells256 = [k for k in keys if k.startswith(('brow:', 'lash:', 'eye:', 'cap:'))]
    flatn = np.zeros((S, S, 3), np.float32)
    flatn[..., 0] = 0.5
    flatn[..., 1] = 0.5
    flatn[..., 2] = 1.0

    def place(img, nimg, cell, slot, per):
        x = (slot % per) * cell
        y = (slot // per) * cell
        return x, y

    for group, cell in ((cells512, 512), (cells256, 256)):
        per = S // cell
        cap = per * per
        for g0 in range(0, len(group), cap):
            chunk = group[g0:g0 + cap]
            img = np.zeros((S, S, 4), np.float32)
            nimg = flatn.copy()
            has_n = False
            types = {}
            for slot, key in enumerate(chunk):
                kind, name = key.split(':')
                x, y = place(None, None, cell, slot, per)
                nsub = None
                if kind == 'shoes':
                    sub = load(f'{ASSETS}/clothes/{name}/{name}_diffuse.png', cell, mode='RGBA')
                    sub[..., 3] = 1
                    nsub = normal_from(f'{ASSETS}/clothes/{name}/{name}_normal.png', cell)
                    t = 'color'
                elif kind == 'hat':
                    src = load(f'{ASSETS}/clothes/fedora01/fedora_diffuse.png', cell, mode='RGBA')
                    L = lum(srgb_to_lin(src[..., :3]))
                    dd = np.clip(L / max(1e-4, np.median(L[src[..., 3] > 0.5])), 0.3, 1.8)
                    g = lin_to_srgb(0.5 * dd)
                    sub = np.stack([g, g, g, np.ones_like(g)], -1)
                    nsub = normal_from(f'{ASSETS}/clothes/fedora01/fedora_normal.png', cell)
                    t = 'detail'
                elif kind == 'beard':
                    sub = beard_tile(cell, name)
                    t = 'detail'
                elif kind == 'brow':
                    # (the painted hairs stay apart: a soft ramp, not a filled stroke)
                    sub = alpha_detail(f'{ASSETS}/eyebrows/{name}/{name}.png', cell, boost=(0.1, 0.75))
                    t = 'detail'
                elif kind == 'lash':
                    sub = alpha_detail(f'{ASSETS}/eyelashes/{name}/{name}.png', cell, boost=(0.05, 0.5))
                    t = 'detail'
                elif kind == 'cap':
                    # far-LOD hair cap: plain hair-coloured detail with a faint strand grain
                    rng = np.random.default_rng(3)
                    gr = ndimage.gaussian_filter(rng.standard_normal((cell, cell)).astype(np.float32), (0.6, 4.0))
                    g = lin_to_srgb(np.clip(0.5 * (1 + 0.08 * gr / (gr.std() + 1e-6)), 0, 1))
                    sub = np.stack([g, g, g, np.ones_like(g)], -1)
                    t = 'detail'
                elif kind == 'eye':
                    sub = load(f'{ASSETS}/eyes/materials/{name}_eye.png', cell, mode='RGBA')
                    sub[..., 3] = 1
                    t = 'color'
                # 1-texel inset against bleeding between cells is handled by the UV rect below
                img[y:y + cell, x:x + cell] = sub
                if nsub is not None:
                    nimg[y:y + cell, x:x + cell] = nsub
                    has_n = True
                types[key] = (t, x, y)
            li, ni = add_layer(img, dict(key='misc%d_%d' % (cell, g0 // cap), kind='misc', type='mixed', rough=ROUGH['misc'],
                                         alpha=any(k.startswith(('brow:', 'lash:', 'beard:')) for k in chunk)),
                               nimg if has_n else None)
            for key, (t, x, y) in types.items():
                pad = 1.5 / S
                remap[key] = dict(layer=li, rect=[x / S + pad, 1 - (y + cell) / S + pad, cell / S - 2 * pad, cell / S - 2 * pad],
                                  normal=ni if (has_n and key.startswith(('shoes:', 'hat:'))) else -1, type=t,
                                  alpha=key.startswith(('brow:', 'lash:', 'beard:')))

    # skin tone gains per character
    tones = {}
    for cid, m in metas.items():
        sp = m['spec']
        ref = np.array(remap['skin:' + sp['skin']]['ref'])
        tgt = CASTM.TONES.get(sp['tone'])
        if tgt is None:
            gain = np.ones(3)
        else:
            gain = hex_lin(tgt) / np.maximum(ref, 1e-4)
            # keep the texture's own hue a little (only part of the hue shift)
            g = gain.mean()
            gain = g + (gain - g) * 0.8
            gain = np.clip(gain, 0.15, 1.6)
        tones[cid] = gain.round(4).tolist()

    # ---------------------------------------------------------------- write strips
    for f in glob.glob(os.path.join(OUT, '*.webp')):
        os.remove(f)
    files = {'albedo': [], 'normal': []}
    for kind, arrs, q in (('albedo', albedo, Q_ALBEDO), ('normal', normals, Q_NORMAL)):
        for s0 in range(0, len(arrs), STRIP):
            chunk = arrs[s0:s0 + STRIP]
            strip = np.concatenate(chunk, 0)
            u8 = np.round(np.clip(strip, 0, 1) * 255).astype(np.uint8)
            name = f'{kind}_{s0 // STRIP}.webp'
            entry = dict(file='tex/' + name, layers=len(chunk))
            # colour and coverage go in separate opaque images: browsers premultiply alpha when decoding,
            # which would wipe the colour bled into transparent hair texels
            Image.fromarray(np.ascontiguousarray(u8[..., :3]), 'RGB').save(os.path.join(OUT, name), 'WEBP', quality=q, method=6)
            if kind == 'albedo' and (strip[..., 3] < 0.999).any():
                aname = f'alpha_{s0 // STRIP}.webp'
                a3 = np.repeat(u8[..., 3:4], 3, axis=2)
                Image.fromarray(np.ascontiguousarray(a3), 'RGB').save(os.path.join(OUT, aname), 'WEBP', quality=90, method=6)
                entry['alpha'] = 'tex/' + aname
                log('wrote', aname, os.path.getsize(os.path.join(OUT, aname)) // 1024, 'KB')
            files[kind].append(entry)
            log('wrote', name, len(chunk), 'layers', os.path.getsize(os.path.join(OUT, name)) // 1024, 'KB')
    table = dict(size=S, strip=STRIP, files=files, layers=layers, nAlbedo=len(albedo), nNormal=len(normals),
                 remap=remap, tones=tones)
    with open(os.path.join(WORK, 'layers.json'), 'w') as f:
        json.dump(table, f, indent=1)
    log('layers', len(albedo), 'albedo /', len(normals), 'normal')


if __name__ == '__main__':
    main()
