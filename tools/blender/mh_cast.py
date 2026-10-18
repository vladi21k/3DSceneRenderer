"""The cast of crowd characters built by mh_build.py (MPFB2 / MakeHuman system assets, CC0).

Pure data, importable from Blender's Python and from plain python3.

Each character: sex, age (years), ancestry mix (MakeHuman race macro), skin texture + tone,
body macros (muscle, weight, height, proportions), extra shape targets (face and body variety),
an outfit made of garment pieces taken from the CC0 clothes (tops / bottoms of different suits
can be combined; sleeves and trouser legs can be cut, skirts lengthened) with default colours,
shoes, hair, eyebrows, eyelashes, eye colour and optional hat / beard.

Colours are sRGB hex. Garments, hair, brows, hats and beards are stored as neutral "detail"
textures and tinted (albedo = 2 * texel * tint, linear); skin, eyes, shoes and the black suit
keep their own colours (tint white).
"""
import os as _os
import sys as _sys

_ROOT = _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))


def stage_dirs(argv=None):
    """(work, out) directories of a pipeline run: --work DIR (raw/, tex/, lod/ inside; default .work/mh)
    and --out DIR (the web assets; default assets/humans_mh), read from a script's arguments."""
    argv = _sys.argv if argv is None else argv

    def opt(name, default):
        if name in argv and argv.index(name) + 1 < len(argv):
            return _os.path.abspath(argv[argv.index(name) + 1])
        return default
    return (opt('--work', _os.path.join(_ROOT, '.work', 'mh')),
            opt('--out', _os.path.join(_ROOT, 'assets', 'humans_mh')))

# ----------------------------------------------------------------------------- MakeHuman macro age

def mh_age(years):
    """MakeHuman age macro value for an age in years (0 -> 1 y, 0.1875 -> 11 y, 0.5 -> 25 y, 1 -> 90 y)."""
    y = float(years)
    if y < 11:
        return max(0.0, (y - 1.0) / 10.0 * 0.1875)
    if y < 25:
        return 0.1875 + (y - 11.0) / 14.0 * 0.3125
    return min(1.0, 0.5 + (y - 25.0) / 65.0 * 0.5)


# ----------------------------------------------------------------------------- garments
# Garment pieces: suit name + which part of it ('top' / 'bottom' / 'all').
# Part classification happens in the builder (connected pieces below the waist are bottoms).
# Texture type: 'detail' (tinted at runtime) or 'color' (kept).
SUITS = {
    'male_casualsuit01': {'tex': 'detail'},     # denim shirt + jeans (one piece: split per face)
    'male_casualsuit02': {'tex': 'detail'},     # long-sleeved tee + jeans
    'male_casualsuit03': {'tex': 'detail'},     # striped shirt + jeans
    'male_casualsuit04': {'tex': 'detail'},     # tee + jeans
    'male_casualsuit05': {'tex': 'detail'},     # jacket over a vest + jeans
    'male_casualsuit06': {'tex': 'detail'},     # white tee + jeans
    'male_elegantsuit01': {'tex': 'color'},     # black suit, white shirt, tie
    'female_casualsuit01': {'tex': 'detail'},   # tee + jeans
    'female_casualsuit02': {'tex': 'detail'},   # tee + denim shorts
    'female_elegantsuit01': {'tex': 'detail'},  # blouse + knee skirt
    'female_sportsuit01': {'tex': 'detail'},    # crop tee + leggings
}
SHOES = ['shoes01', 'shoes02', 'shoes03', 'shoes04', 'shoes05', 'shoes06']
# shoes01 brown leather, 02 worn trail shoes, 03 black boots, 04 black leather, 05 white sneakers, 06 blue sneakers
HAIRS = ['afro01', 'bob01', 'bob02', 'braid01', 'long01', 'ponytail01', 'short01', 'short02', 'short03', 'short04']
EYES = ['brown', 'brownlight', 'green', 'bluegreen', 'blue', 'grey']

# hair colours (sRGB)
HC = {
    'black': '#141110', 'darkbrown': '#2a1d15', 'brown': '#45301f', 'chestnut': '#5a3a22', 'lightbrown': '#7d5c3c',
    'auburn': '#6b3420', 'blonde': '#a68a5c', 'ash': '#8c7f6c', 'grey': '#8d8a85', 'silver': '#bdb8b0', 'white': '#d9d6d0',
    'saltpepper': '#5c5955',
}

# skin tones applied on top of a MakeHuman skin texture (target mean sRGB of the body skin)
TONES = {
    'base': None,
    'fair': '#e2b496',
    'olive': '#c69a7c',      # Mediterranean
    'tan': '#bd8f6f',        # Middle-Eastern / North African
    'brown': '#9a6c51',      # South-Asian / mixed
    'deep': '#5e3b2a',
}


def C(sex, age, *, anc, skin, tone='base', muscle=0.5, weight=0.5, height=0.5, prop=0.5, cup=0.5, firm=0.5,
      targets=None, top=None, bottom=None, shoes='shoes05', socks=None, hair=None, hair_color='brown', brows='eyebrow001',
      lashes='eyelashes01', eyes='brown', hat=None, hat_color='#111113', beard=None, kind=None, note=''):
    """One character. anc = (caucasian, african, asian) weights."""
    return dict(sex=sex, age=age, anc=anc, skin=skin, tone=tone, muscle=muscle, weight=weight, height=height, prop=prop,
                cup=cup, firm=firm, targets=targets or {}, top=top, bottom=bottom, shoes=shoes, socks=socks, hair=hair,
                hair_color=hair_color, brows=brows, lashes=lashes, eyes=eyes, hat=hat, hat_color=hat_color, beard=beard, kind=kind,
                note=note)


def G(suit, part, color, *, cut=None, length=None, style=None, color2=None):
    """A garment piece: `suit` part ('top'/'bottom'/'all'), sRGB colour (None keeps the texture), optional cut:
    'sleeve' (length 0..1 of the arm from the shoulder), 'leg' (0..1 of the leg from the hip), 'skirt' (hem height
    as a fraction of the knee -> ankle distance below the knee)."""
    return dict(suit=suit, part=part, color=color, cut=cut, length=length, style=style, color2=color2)


CAU, MED, MEA, AFR, ASI = (1.0, 0.0, 0.0), (0.85, 0.1, 0.05), (0.75, 0.2, 0.05), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)

# Face-shape targets: small, character specific amounts (the cast should not look like siblings)
F = lambda **kw: {k.replace('__', '/').replace('_', '-'): v for k, v in kw.items()}   # noqa: E731

CAST = {
    # ------------------------------------------------------------------ men
    'm01': C('m', 24, anc=CAU, skin='young_caucasian_male', tone='fair', muscle=0.55, weight=0.42, height=0.62,
             targets=F(nose__nose_scale_vert_incr=0.3, chin__chin_prominent_incr=0.3, head__head_oval=0.4),
             top=G('male_casualsuit06', 'top', '#f1f0ea'), bottom=G('male_casualsuit06', 'bottom', '#3b5878'),
             shoes='shoes05', hair='short02', hair_color='chestnut', brows='eyebrow003', eyes='bluegreen',
             note='young man, white tee, jeans'),
    'm02': C('m', 31, anc=MED, skin='young_caucasian_male', tone='olive', muscle=0.6, weight=0.55, height=0.5,
             targets=F(nose__nose_hump_incr=0.4, nose__nose_scale_horiz_incr=0.2, head__head_square=0.4, eyebrows__eyebrows_trans_down=0.3),
             top=G('male_casualsuit04', 'top', '#25324a'), bottom=G('male_casualsuit04', 'bottom', '#b9a77f', cut='leg', length=0.42),
             shoes='shoes02', hair='short01', hair_color='black', brows='eyebrow007', eyes='brown',
             note='navy tee, khaki shorts'),
    'm03': C('m', 27, anc=AFR, skin='young_african_male', muscle=0.7, weight=0.5, height=0.66,
             targets=F(nose__nose_flaring_incr=0.3, mouth__mouth_lowerlip_volume_incr=0.3, head__head_round=0.3),
             top=G('male_casualsuit04', 'top', '#3e8a4e'), bottom=G('male_casualsuit04', 'bottom', '#2f3f5c'),
             shoes='shoes05', hair='short04', hair_color='black', brows='eyebrow010', eyes='brown',
             note='green tee, dark jeans'),
    'm04': C('m', 46, anc=MEA, skin='middleage_caucasian_male', tone='tan', muscle=0.45, weight=0.82, height=0.45,
             targets=F(stomach__stomach_pregnant_incr=0.45, neck__neck_double_incr=0.4, nose__nose_volume_incr=0.4, head__head_fat_incr=0.3),
             top=G('male_casualsuit03', 'top', '#bcd3ea', cut='sleeve', length=0.62), bottom=G('male_casualsuit03', 'bottom', '#5b5d61'),
             shoes='shoes01', hair='short02', hair_color='saltpepper', brows='eyebrow006', eyes='brown',
             beard='stubble', note='heavy, light-blue shirt rolled sleeves, grey trousers'),
    'm05': C('m', 23, anc=ASI, skin='young_asian_male', muscle=0.45, weight=0.35, height=0.4,
             targets=F(head__head_oval=0.3, nose__nose_scale_vert_decr=0.2),
             top=G('male_casualsuit06', 'top', '#17181b'), bottom=G('male_casualsuit06', 'bottom', '#4a6f96'),
             shoes='shoes06', hair='short04', hair_color='black', brows='eyebrow011', eyes='brown',
             note='slim, black tee, light jeans'),
    'm06': C('m', 38, anc=CAU, skin='middleage_caucasian_male', tone='fair', muscle=0.45, weight=0.5, height=0.55,
             targets=F(nose__nose_hump_incr=0.3, head__head_oval=0.5, chin__chin_width_decr=0.2),
             top=G('male_elegantsuit01', 'top', None), bottom=G('male_elegantsuit01', 'bottom', None),
             shoes='shoes04', hat='fedora01', hair='short04', hair_color='darkbrown', brows='eyebrow005', eyes='grey',
             beard='full', note='black suit, black hat, beard'),
    'm07': C('m', 25, anc=MED, skin='young_caucasian_male', tone='olive', muscle=0.4, weight=0.38, height=0.58,
             targets=F(head__head_scale_vert_incr=0.2, nose__nose_point_width_decr=0.3),
             top=G('male_elegantsuit01', 'top', None), bottom=G('male_elegantsuit01', 'bottom', None),
             shoes='shoes03', hat='fedora_cocked', hair='short04', hair_color='black', brows='eyebrow007', eyes='brown',
             beard='short', note='young man, black suit, black hat'),
    'm08': C('m', 56, anc=CAU, skin='old_caucasian_male', muscle=0.4, weight=0.7, height=0.45,
             targets=F(stomach__stomach_pregnant_incr=0.3, neck__neck_double_incr=0.3, nose__nose_volume_incr=0.3),
             top=G('male_elegantsuit01', 'top', None), bottom=G('male_elegantsuit01', 'bottom', None),
             shoes='shoes04', hat='fedora01', hair='short04', hair_color='grey', brows='eyebrow006', eyes='blue',
             beard='full', note='older man, black suit and hat, grey beard'),
    'm09': C('m', 35, anc=CAU, skin='middleage_caucasian_male', muscle=0.5, weight=0.78, height=0.5,
             targets=F(stomach__stomach_pregnant_incr=0.35, head__head_round=0.4, cheek__l_cheek_volume_incr=0.3, cheek__r_cheek_volume_incr=0.3),
             top=G('male_casualsuit06', 'top', '#c8352b'), bottom=G('male_casualsuit06', 'bottom', '#5679a3', cut='leg', length=0.45),
             shoes='shoes02', hair='short02', hair_color='lightbrown', brows='eyebrow002', eyes='blue',
             note='heavy, red tee, denim shorts'),
    'm10': C('m', 29, anc=MED, skin='young_caucasian_male2', tone='olive', muscle=0.6, weight=0.5, height=0.6,
             targets=F(nose__nose_greek_incr=0.4, chin__chin_prominent_incr=0.4, head__head_rectangular=0.3),
             top=G('male_casualsuit01', 'top', '#9dbbd9', cut='sleeve', length=0.32), bottom=G('male_casualsuit01', 'bottom', '#2f4a6e'),
             shoes='shoes01', hair='short01', hair_color='darkbrown', brows='eyebrow009', eyes='brownlight',
             beard='stubble', note='light-blue short-sleeved shirt, jeans'),
    'm11': C('m', 21, anc=AFR, skin='young_african_male', muscle=0.55, weight=0.4, height=0.7,
             targets=F(head__head_oval=0.3, nose__nose_width2_incr=0.3),
             top=G('male_casualsuit06', 'top', '#f2f1ec'), bottom=G('male_casualsuit06', 'bottom', '#1f2126'),
             shoes='shoes05', hair='afro01', hair_color='black', brows='eyebrow010', eyes='brown',
             note='tall, white tee, black jeans, afro'),
    'm12': C('m', 52, anc=MEA, skin='middleage_caucasian_male', tone='tan', muscle=0.45, weight=0.62, height=0.42,
             targets=F(nose__nose_hump_incr=0.5, nose__nose_scale_vert_incr=0.3, head__head_square=0.3, eyes__l_eye_bag_incr=0.4, eyes__r_eye_bag_incr=0.4),
             top=G('male_casualsuit02', 'top', '#3f5a3a', cut='sleeve', length=0.3), bottom=G('male_casualsuit02', 'bottom', '#c2b391'),
             shoes='shoes01', hair='short02', hair_color='saltpepper', brows='eyebrow006', eyes='brown',
             beard='short', note='olive polo-like tee, beige trousers'),
    'm13': C('m', 34, anc=(0.2, 0.0, 0.8), skin='middleage_asian_male', tone='brown', muscle=0.5, weight=0.55, height=0.48,
             targets=F(head__head_round=0.3),
             top=G('male_casualsuit03', 'top', '#e9e3c9', cut='sleeve', length=0.32), bottom=G('male_casualsuit03', 'bottom', '#141416'),
             shoes='shoes04', hair='short01', hair_color='black', brows='eyebrow004', eyes='brown',
             note='cream short-sleeved shirt, black trousers'),
    'm14': C('m', 41, anc=MED, skin='middleage_caucasian_male', tone='olive', muscle=0.5, weight=0.6, height=0.52,
             targets=F(nose__nose_hump_incr=0.2, nose__nose_scale_vert_incr=0.2, head__head_square=0.2, chin__chin_width_incr=0.3),
             top=G('male_casualsuit01', 'top', '#f4f4f1', cut='sleeve', length=0.62), bottom=G('male_casualsuit01', 'bottom', '#25324a'),
             shoes='shoes04', hair='short04', hair_color='darkbrown', brows='eyebrow005', eyes='brownlight',
             beard='stubble', note='white shirt rolled sleeves, navy trousers'),
    'm15': C('m', 28, anc=MEA, skin='young_caucasian_male2', tone='olive', muscle=0.5, weight=0.42, height=0.48,
             targets=F(head__head_oval=0.3, nose__nose_greek_incr=0.3, mouth__mouth_lowerlip_volume_incr=0.2),
             top=G('male_casualsuit04', 'top', '#16171a'), bottom=G('male_casualsuit04', 'bottom', '#3e5f88'),
             shoes='shoes05', hair='short02', hair_color='black', brows='eyebrow007', eyes='brown',
             note='slim, black tee, jeans'),
    'm16': C('m', 57, anc=CAU, skin='old_caucasian_male', tone='fair', muscle=0.4, weight=0.66, height=0.5,
             targets=F(stomach__stomach_pregnant_incr=0.25, nose__nose_volume_incr=0.2, head__head_round=0.3),
             top=G('male_casualsuit02', 'top', '#c9d8c0', cut='sleeve', length=0.3), bottom=G('male_casualsuit02', 'bottom', '#a8956c'),
             shoes='shoes01', hair='short04', hair_color='grey', brows='eyebrow006', eyes='blue',
             note='older man, pale green tee, khaki trousers'),
    # ------------------------------------------------------------------ women
    'f12': C('f', 35, anc=MED, skin='middleage_caucasian_female', tone='olive', muscle=0.4, weight=0.52, height=0.5, cup=0.55,
             targets=F(nose__nose_hump_incr=0.2, head__head_oval=0.2, mouth__mouth_upperlip_volume_incr=0.2),
             top=G('female_casualsuit01', 'top', '#f6f3ee', cut='sleeve', length=0.62), bottom=G('female_elegantsuit01', 'bottom', '#1f2a44', cut='skirt', length=0.8),
             shoes='shoes04', hair='ponytail01', hair_color='darkbrown', brows='eyebrow002', eyes='brown',
             note='modest: white top, long navy skirt'),
    'f13': C('f', 27, anc=CAU, skin='young_caucasian_female2', muscle=0.45, weight=0.44, height=0.58, cup=0.5,
             targets=F(nose__nose_point_up=0.2, head__head_oval=0.2, chin__chin_prominent_incr=0.2),
             top=G('female_casualsuit02', 'top', '#2a3346'), bottom=G('female_casualsuit02', 'bottom', '#7f9cbe'),
             shoes='shoes05', hair='long01', hair_color='blonde', brows='eyebrow001', eyes='blue',
             note='navy tee, light denim shorts, long fair hair'),
    'f14': C('f', 47, anc=MEA, skin='middleage_caucasian_female', tone='tan', muscle=0.4, weight=0.62, height=0.45, cup=0.65, firm=0.35,
             targets=F(nose__nose_hump_incr=0.3, head__head_round=0.2, neck__neck_double_incr=0.15),
             top=G('female_elegantsuit01', 'top', '#2a4a7a', cut='sleeve', length=0.62), bottom=G('female_elegantsuit01', 'bottom', '#2a4a7a', cut='skirt', length=0.35),
             shoes='shoes04', hair='bob02', hair_color='darkbrown', brows='eyebrow008', eyes='brown',
             note='navy dress, dark bob'),
    'f01': C('f', 24, anc=CAU, skin='young_caucasian_female', tone='fair', muscle=0.45, weight=0.4, height=0.55, cup=0.45,
             targets=F(nose__nose_scale_horiz_decr=0.2, mouth__mouth_upperlip_volume_incr=0.3),
             top=G('female_casualsuit01', 'top', '#f2f0ea'), bottom=G('female_casualsuit01', 'bottom', '#3e5f88'),
             shoes='shoes05', hair='ponytail01', hair_color='chestnut', brows='eyebrow002', eyes='green',
             note='white tee, jeans, ponytail'),
    'f02': C('f', 30, anc=MED, skin='young_caucasian_female2', tone='olive', muscle=0.45, weight=0.5, height=0.5, cup=0.6,
             targets=F(nose__nose_hump_incr=0.25, head__head_oval=0.3),
             top=G('female_elegantsuit01', 'top', '#e7a3a0', cut='sleeve', length=0.2), bottom=G('female_casualsuit01', 'bottom', '#2f4a6e'),
             shoes='shoes02', hair='long01', hair_color='darkbrown', brows='eyebrow008', eyes='brown',
             note='coral blouse, jeans, long hair'),
    'f03': C('f', 27, anc=AFR, skin='young_african_female', muscle=0.5, weight=0.55, height=0.6, cup=0.55,
             targets=F(mouth__mouth_lowerlip_volume_incr=0.3, buttocks__buttocks_volume_incr=0.3),
             top=G('female_casualsuit02', 'top', '#e6c43a'), bottom=G('female_casualsuit02', 'bottom', '#5679a3'),
             shoes='shoes06', hair='braid01', hair_color='black', brows='eyebrow012', eyes='brown',
             note='yellow tee, denim shorts, braid'),
    'f04': C('f', 22, anc=ASI, skin='young_asian_female', muscle=0.4, weight=0.35, height=0.4, cup=0.4,
             targets=F(head__head_round=0.2),
             top=G('female_sportsuit01', 'top', '#16171a'), bottom=G('female_sportsuit01', 'bottom', '#141416'),
             shoes='shoes05', hair='bob01', hair_color='black', brows='eyebrow011', eyes='brown',
             note='slim, black crop tee, leggings, bob'),
    'f05': C('f', 36, anc=MEA, skin='middleage_caucasian_female', tone='tan', muscle=0.4, weight=0.6, height=0.45, cup=0.6, firm=0.4,
             targets=F(nose__nose_hump_incr=0.3, head__head_oval=0.3),
             top=G('female_elegantsuit01', 'top', '#2a3346', cut='sleeve', length=0.85), bottom=G('female_elegantsuit01', 'bottom', '#1d2337', cut='skirt', length=0.75),
             shoes='shoes04', hair='braid01', hair_color='black', brows='eyebrow008', eyes='brown',
             note='modest: long dark skirt, long-sleeved navy blouse'),
    'f06': C('f', 46, anc=CAU, skin='middleage_caucasian_female', muscle=0.4, weight=0.7, height=0.48, cup=0.7, firm=0.35,
             targets=F(stomach__stomach_pregnant_incr=0.2, neck__neck_double_incr=0.2, head__head_round=0.3),
             top=G('female_elegantsuit01', 'top', '#4a6f9e', cut='sleeve', length=0.18), bottom=G('female_elegantsuit01', 'bottom', '#4a6f9e', cut='skirt', length=0.2),
             shoes='shoes01', hair='bob02', hair_color='blonde', brows='eyebrow002', eyes='blue',
             note='blue dress, blonde bob'),
    'f07': C('f', 31, anc=MED, skin='young_caucasian_female', tone='olive', muscle=0.45, weight=0.45, height=0.55, cup=0.5,
             targets=F(nose__nose_scale_vert_incr=0.2, chin__chin_prominent_incr=0.2),
             top=G('female_elegantsuit01', 'top', None), bottom=G('female_elegantsuit01', 'bottom', '#141416'),
             shoes='shoes03', hair='ponytail01', hair_color='black', brows='eyebrow008', eyes='brownlight',
             note='striped blouse, black skirt'),
    'f08': C('f', 26, anc=MEA, skin='young_caucasian_female2', tone='tan', muscle=0.5, weight=0.45, height=0.5, cup=0.5,
             targets=F(head__head_oval=0.3, nose__nose_hump_incr=0.2),
             top=G('female_casualsuit01', 'top', '#2f8c8c'), bottom=G('female_sportsuit01', 'bottom', '#121214'),
             shoes='shoes06', hair='long01', hair_color='black', brows='eyebrow012', eyes='brown',
             note='teal tee, black leggings, long hair'),
    'f09': C('f', 33, anc=CAU, skin='young_caucasian_female2', muscle=0.4, weight=0.55, height=0.52, cup=0.55,
             targets=F(head__head_round=0.2, nose__nose_point_up=0.2),
             top=G('female_casualsuit01', 'top', '#e7e0cf', cut='sleeve', length=0.6), bottom=G('female_elegantsuit01', 'bottom', '#3b3f47', cut='skirt', length=0.9),
             shoes='shoes04', hair='ponytail01', hair_color='darkbrown', brows='eyebrow002', eyes='grey',
             note='modest: cream top, long grey skirt'),
    'f10': C('f', 41, anc=(0.1, 0.0, 0.9), skin='middleage_asian_female', muscle=0.45, weight=0.5, height=0.42, cup=0.45,
             top=G('female_elegantsuit01', 'top', '#f6f3ee', cut='sleeve', length=0.2), bottom=G('female_casualsuit01', 'bottom', '#c2b391'),
             shoes='shoes05', hair='bob02', hair_color='darkbrown', brows='eyebrow011', eyes='brown',
             note='white blouse, beige trousers'),
    'f11': C('f', 20, anc=(0.4, 0.6, 0.0), skin='young_african_female', tone='brown', muscle=0.45, weight=0.45, height=0.55, cup=0.5,
             top=G('female_sportsuit01', 'top', '#e7a3b8'), bottom=G('female_casualsuit01', 'bottom', '#5679a3'),
             shoes='shoes05', hair='afro01', hair_color='darkbrown', brows='eyebrow012', eyes='brown',
             note='pink crop tee, light jeans, curls'),
    # ------------------------------------------------------------------ elderly
    'o01': C('m', 72, anc=CAU, skin='old_caucasian_male', muscle=0.35, weight=0.6, height=0.42,
             targets=F(stomach__stomach_pregnant_incr=0.3, nose__nose_volume_incr=0.4, ears__l_ear_scale_incr=0.4, ears__r_ear_scale_incr=0.4),
             top=G('male_casualsuit03', 'top', '#c9d8e8', cut='sleeve', length=0.6), bottom=G('male_casualsuit03', 'bottom', '#c2b391'),
             shoes='shoes01', hair='short02', hair_color='silver', brows='eyebrow006', eyes='blue',
             note='elderly man, light shirt, beige trousers'),
    'o02': C('m', 68, anc=MED, skin='old_caucasian_male', tone='olive', muscle=0.35, weight=0.5, height=0.4,
             targets=F(nose__nose_hump_incr=0.4, ears__l_ear_scale_incr=0.3, ears__r_ear_scale_incr=0.3),
             top=G('male_casualsuit05', 'top', '#6b6f6a', color2='#e9e3d3'), bottom=G('male_casualsuit05', 'bottom', '#3b3f47'),
             shoes='shoes04', hat='fedora01', hat_color='#d8c49a', hair='short04', hair_color='grey', brows='eyebrow006', eyes='brown',
             note='elderly man, grey jacket, straw hat'),
    'o03': C('f', 71, anc=CAU, skin='old_caucasian_female', muscle=0.3, weight=0.6, height=0.38, cup=0.6, firm=0.2,
             targets=F(neck__neck_double_incr=0.3),
             top=G('female_elegantsuit01', 'top', '#d9cdb0', cut='sleeve', length=0.6), bottom=G('female_elegantsuit01', 'bottom', '#3b3f47', cut='skirt', length=0.6),
             shoes='shoes04', hair='bob02', hair_color='silver', brows='eyebrow002', eyes='grey',
             note='elderly woman, cream blouse, long grey skirt'),
    'o04': C('f', 66, anc=MEA, skin='old_caucasian_female', tone='tan', muscle=0.3, weight=0.7, height=0.35, cup=0.6, firm=0.2,
             targets=F(stomach__stomach_pregnant_incr=0.2),
             top=G('male_casualsuit02', 'top', '#5a3d52'), bottom=G('female_elegantsuit01', 'bottom', '#1d2337', cut='skirt', length=0.85),
             shoes='shoes04', hair='bob02', hair_color='grey', brows='eyebrow008', eyes='brown',
             note='elderly woman, plum long-sleeved top, long navy skirt'),
    'o05': C('m', 63, anc=AFR, skin='old_african_male', muscle=0.4, weight=0.55, height=0.5,
             top=G('male_casualsuit04', 'top', '#e0d3b2'), bottom=G('male_casualsuit04', 'bottom', '#3b3f47'),
             shoes='shoes01', hair='short04', hair_color='grey', brows='eyebrow010', eyes='brown',
             note='older man, beige tee, dark trousers'),
    'o06': C('f', 74, anc=(0.0, 0.0, 1.0), skin='old_asian_female', muscle=0.3, weight=0.45, height=0.3, cup=0.4, firm=0.2,
             top=G('female_casualsuit01', 'top', '#8fb6d9', cut='sleeve', length=0.6), bottom=G('female_sportsuit01', 'bottom', '#3b3f47'),
             shoes='shoes05', hair='short02', hair_color='white', brows='eyebrow011', eyes='brown',
             note='elderly woman, light-blue top, grey trousers'),
    # ------------------------------------------------------------------ teens
    't01': C('m', 15, anc=CAU, skin='young_caucasian_male', muscle=0.45, weight=0.4, height=0.55,
             top=G('male_casualsuit06', 'top', '#b296c9'), bottom=G('male_casualsuit06', 'bottom', '#7f9cbe'),
             shoes='shoes05', hair='short03', hair_color='brown', brows='eyebrow001', eyes='blue',
             note='teen boy, lilac tee, light jeans'),
    't02': C('f', 16, anc=MED, skin='young_caucasian_female', tone='olive', muscle=0.45, weight=0.42, height=0.5, cup=0.35,
             top=G('female_casualsuit02', 'top', '#f2f0ea'), bottom=G('female_casualsuit02', 'bottom', '#5679a3'),
             shoes='shoes06', hair='long01', hair_color='darkbrown', brows='eyebrow002', eyes='brown',
             note='teen girl, white tee, denim shorts'),
    't03': C('m', 14, anc=AFR, skin='young_african_male', muscle=0.5, weight=0.45, height=0.5,
             top=G('male_casualsuit04', 'top', '#e9802a'), bottom=G('male_casualsuit04', 'bottom', '#25324a', cut='leg', length=0.45),
             shoes='shoes06', hair='short04', hair_color='black', brows='eyebrow010', eyes='brown',
             note='teen boy, orange tee, navy shorts'),
    't04': C('f', 14, anc=ASI, skin='young_asian_female', muscle=0.4, weight=0.4, height=0.45, cup=0.25,
             top=G('female_casualsuit01', 'top', '#c94a3a'), bottom=G('female_sportsuit01', 'bottom', '#25324a'),
             shoes='shoes05', hair='ponytail01', hair_color='black', brows='eyebrow011', eyes='brown',
             note='teen girl, red tee, navy leggings'),
    # ------------------------------------------------------------------ children 4-10
    'c01': C('m', 9, anc=CAU, skin='young_caucasian_female', muscle=0.45, weight=0.45, height=0.5,
             top=G('male_casualsuit04', 'top', '#4f7fb4'), bottom=G('male_casualsuit04', 'bottom', '#576042', cut='leg', length=0.45),
             shoes='shoes05', hair='short02', hair_color='lightbrown', brows='eyebrow001', eyes='blue', kind='child',
             note='boy 9, blue tee, olive shorts'),
    'c02': C('f', 8, anc=MED, skin='young_caucasian_female', tone='olive', muscle=0.45, weight=0.45, height=0.5,
             top=G('female_elegantsuit01', 'top', '#e7b9c5', cut='sleeve', length=0.15), bottom=G('female_elegantsuit01', 'bottom', '#e7b9c5'),
             shoes='shoes06', hair='ponytail01', hair_color='darkbrown', brows='eyebrow002', eyes='brown', kind='child',
             note='girl 8, pink dress, ponytail'),
    'c03': C('m', 6, anc=AFR, skin='young_african_female', muscle=0.5, weight=0.5, height=0.5,
             top=G('male_casualsuit04', 'top', '#d8434a'), bottom=G('male_casualsuit04', 'bottom', '#3e5f88'),
             shoes='shoes02', hair='short04', hair_color='black', brows='eyebrow010', eyes='brown', kind='kid',
             note='boy 6, red tee, jeans'),
    'c04': C('f', 5, anc=ASI, skin='young_asian_female', muscle=0.45, weight=0.5, height=0.5,
             top=G('female_casualsuit02', 'top', '#f3df8f'), bottom=G('female_casualsuit02', 'bottom', '#5679a3'),
             shoes='shoes05', hair='bob01', hair_color='black', brows='eyebrow011', eyes='brown', kind='kid',
             note='girl 5, yellow tee, denim shorts, bob'),
    'c05': C('m', 7, anc=MEA, skin='young_caucasian_female', tone='tan', muscle=0.45, weight=0.45, height=0.5,
             top=G('male_casualsuit03', 'top', '#c4e2b6', cut='sleeve', length=0.3), bottom=G('male_casualsuit03', 'bottom', '#25324a', cut='leg', length=0.45),
             shoes='shoes06', hair='short01', hair_color='black', brows='eyebrow001', eyes='brown', kind='kid',
             note='boy 7, green shirt, navy shorts'),
    'c06': C('f', 10, anc=CAU, skin='young_caucasian_female', tone='fair', muscle=0.45, weight=0.42, height=0.55,
             top=G('female_casualsuit01', 'top', '#9fd2d0'), bottom=G('female_sportsuit01', 'bottom', '#c03a6a'),
             shoes='shoes05', hair='braid01', hair_color='blonde', brows='eyebrow002', eyes='bluegreen', kind='child',
             note='girl 10, aqua tee, pink leggings, braid'),
    # ------------------------------------------------------------------ toddlers (strollers)
    'd01': C('m', 2.0, anc=CAU, skin='young_caucasian_female', muscle=0.5, weight=0.55, height=0.5,
             top=G('male_casualsuit04', 'top', '#bcd6ee'), bottom=G('male_casualsuit04', 'bottom', '#f4f2ec', cut='leg', length=0.45),
             shoes='shoes05', hair='short02', hair_color='blonde', brows='eyebrow001', lashes=None, eyes='blue', kind='toddler',
             note='toddler boy, light-blue tee, white shorts'),
    'd02': C('f', 2.5, anc=MED, skin='young_caucasian_female', tone='olive', muscle=0.5, weight=0.55, height=0.5,
             top=G('female_elegantsuit01', 'top', '#f6c3cf', cut='sleeve', length=0.15), bottom=G('female_elegantsuit01', 'bottom', '#f6c3cf'),
             shoes='shoes06', hair='short02', hair_color='darkbrown', brows='eyebrow002', lashes=None, eyes='brown', kind='toddler',
             note='toddler girl, pink dress'),
    'd03': C('m', 1.8, anc=AFR, skin='young_african_female', muscle=0.5, weight=0.6, height=0.5,
             top=G('female_casualsuit02', 'top', '#f3df8f'), bottom=G('female_casualsuit02', 'bottom', '#3e5f88'),
             shoes='shoes06', hair='short04', hair_color='black', brows='eyebrow010', lashes=None, eyes='brown', kind='toddler',
             note='toddler, yellow tee, denim shorts'),
}


def age_class(c):
    a = c['age']
    if a < 3.5:
        return 'toddler'
    if a < 11:
        return 'child'
    if a < 18:
        return 'teen'
    if a < 60:
        return 'adult'
    return 'old'


def gait_kind(c):
    """Gait style of the runtime rig (anim.js GAIT): male / female / child / kid / toddler."""
    if c.get('kind'):
        return c['kind']
    return 'male' if c['sex'] == 'm' else 'female'


# ----------------------------------------------------------------------------- regions (vertex attribute)
REGIONS = {'skin': 0, 'hair': 1, 'brows': 2, 'lashes': 3, 'eyes': 4, 'top': 5, 'top2': 6, 'bottom': 7, 'shoes': 8,
           'socks': 9, 'hat': 10, 'beard': 11}


# ----------------------------------------------------------------------------- stature (crown height, m)
# mean heights by age (both sexes until 12, then boys / girls), adults 1.755 m men / 1.625 m women
_KID_H = [(1.5, 0.82), (2.0, 0.87), (2.5, 0.92), (3.0, 0.96), (4.0, 1.03), (5.0, 1.10), (6.0, 1.16), (7.0, 1.22),
          (8.0, 1.28), (9.0, 1.33), (10.0, 1.38), (11.0, 1.44), (12.0, 1.50)]
_TEEN_H = {'m': [(12, 1.50), (13, 1.56), (14, 1.63), (15, 1.69), (16, 1.73), (17, 1.75), (18, 1.755)],
           'f': [(12, 1.51), (13, 1.57), (14, 1.60), (15, 1.62), (16, 1.625), (17, 1.625), (18, 1.625)]}


def _interp(tab, x):
    if x <= tab[0][0]:
        return tab[0][1]
    for (x0, y0), (x1, y1) in zip(tab, tab[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return tab[-1][1]


def stature(c):
    """Target crown height (m, barefoot) of a character: the mean for its age and sex, shifted by its
    'height' value (0.5 = mean; +-0.2 = +-1 standard deviation)."""
    a = c['age']
    z = (c['height'] - 0.5) / 0.2
    if a < 12:
        m = _interp(_KID_H, a)
        return round(m * (1 + 0.04 * z), 4)
    if a < 18:
        m = _interp(_TEEN_H[c['sex']], a)
        return round(m + 0.06 * z, 4)
    m, sd = (1.755, 0.07) if c['sex'] == 'm' else (1.625, 0.065)
    shrink = max(0.0, a - 55) * 0.0018
    return round(m + sd * z - shrink, 4)
