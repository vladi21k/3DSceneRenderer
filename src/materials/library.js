// Material library definitions. Colours are LINEAR RGB. Textured materials keep
// colour = 1 (or a paint colour) and roughness = 1: the baked maps hold the values.
//
//   kind     'standard' | 'physical'
//   props    three.js material properties
//   bake     recipe name (recipes/*.js) providing albedo + surface maps
//   surf     runtime surface settings (see surface.js / surfaceUniforms)
//   vc       vertex colour meaning for get(name, {vertexColors:true}):
//            'tint'   multiplier around 1 (per-building stone tint × baked AO)
//            'albedo' the paint / fabric colour itself (material colour reset to white)
//   meta     published in materials.meta[name] for other modules

const LIMESTONE_TINTS = {
  cream: [1.0, 1.0, 1.0],
  honey: [1.03, 0.97, 0.86],
  pale: [1.05, 1.05, 1.06],
  pinkish: [1.03, 0.95, 0.91],
  grey: [0.95, 0.97, 1.01],
  golden: [1.04, 0.97, 0.8],
  aged: [0.88, 0.85, 0.8],
};

// Block patchwork: ±12 % value per block, honey ↔ grey-white hue drift, whole courses
// banded (row share), and 15 % outlier blocks from three families (pink, ochre, grey).
const STONE_CELL = {
  value: 0.12, hue: 0.9, rough: 0.06, row: 0.55, a: [1.06, 0.985, 0.86], b: [0.97, 0.985, 1.01],
  out: { p: 0.15, fam: [[1.04, 0.93, 0.88], [1.05, 0.97, 0.82], [0.9, 0.92, 0.95]] },
};
const STONE_MACRO = { f1: 1 / 4, f2: 1 / 17, albedo: 0.08, rough: 0.05, an1: [1, 1], an2: [2.2, 0.3] };
const STONE_DETAIL = { freq: 2.0, normal: 0.7, albedo: 0.3, rough: 0.05 };
// chisel dressing per block: 60 % taltish (tool map), the rest pecked or rubbed
const STONE_DRESS = { tex: 'peck', tool: 'tooling', freq: 1 / 0.64, normal: 1.0, albedo: 1.0, rough: 0.5, share: 0.6, margin: 0.025, farVar: 0.025 };
// soiled ledges, sheltered soffits, faint vertical drip streaks
const STONE_WEATHER = { ledge: 0.22, streak: 0.08, threshold: 0.6, soffit: 0.1 };

// Granite setts: tone varies in broad wear patches (macro), hardly per paver.
const PAVING_CELL = { value: 0.05, hue: 0.2, rough: 0.1, row: 0.3, a: [1.01, 1.0, 0.99], b: [0.98, 0.99, 1.02], out: [1.1, 1.1, 1.1, 0.02] };
const PAVING_MACRO = { f1: 1 / 4, f2: 1 / 20, albedo: 0.12, rough: 0.12, an1: [1, 1], an2: [0.12, 1.5] };
// crisp crystals at close range (mica dark and glossy, feldspar pale)
const PAVING_DETAIL = { tex: 'granite', freq: 4, normal: 0.5, albedo: 1.0, rough: -0.6, farVar: 0.004 };

export const LIBRARY = {
  // ---------------------------------------------------------------- stone
  'stone.ashlar': {
    props: { roughness: 1 },
    bake: 'ashlar',
    surf: { cell: STONE_CELL, macro: STONE_MACRO, detail: STONE_DRESS, weather: STONE_WEATHER, microShadow: 1 },
    vc: 'tint',
    meta: {
      courseH: 0.35, blockL: 0.7, blockRange: [0.36, 1.2], courses: 12, joint: 0.006,
      uv: 'u along the wall, v up (m). Course joints at v = k × courseH. Scale v by meta.courseH / plan.courseH (and u by blockL / plan.blockL) to match a building style; offset v by a random whole number of courses and u by a random amount per lot so neighbours differ.',
      dressing: 'per block at runtime: 60 % taltish comb strokes (vertical or diagonal), 25 % pecked, 15 % rubbed; 20-35 mm finer drafted margin',
      weather: { ...STONE_WEATHER, note: 'albedo darkening on up-facing ledges (ledge), down-facing soffits (soffit) and vertical drip streaks (streak), from world normal / position. The splash zone near the paving is left to vertex colours.' },
      tints: LIMESTONE_TINTS,
    },
  },
  'stone.dirty': {
    props: { roughness: 1, color: [0.84, 0.8, 0.74] },
    bake: 'ashlar',
    surf: {
      cell: STONE_CELL, macro: { ...STONE_MACRO, albedo: 0.12, rough: 0.08 }, detail: STONE_DRESS,
      weather: { ...STONE_WEATHER, ledge: 0.3, streak: 0.14, soffit: 0.16 }, stain: { amount: 0.18, freq: 0.6, threshold: 0.66 },
    },
    vc: 'tint',
    meta: { note: 'soiled variant of stone.ashlar (same layout / metrics)', tints: LIMESTONE_TINTS },
  },
  'stone.smooth': {
    props: { roughness: 1 },
    bake: 'smooth',
    surf: { macro: STONE_MACRO, detail: { ...STONE_DETAIL, normal: 0.35 }, weather: STONE_WEATHER },
    vc: 'tint',
    meta: { uv: 'metres, any orientation; jointless finely dressed stone for cornices, sills, arches, string courses', weather: STONE_WEATHER, tints: LIMESTONE_TINTS },
  },
  'stone.rough': {
    props: { roughness: 1 },
    bake: 'rustic',
    surf: { cell: { ...STONE_CELL, value: 0.09 }, macro: STONE_MACRO, detail: { ...STONE_DETAIL, normal: 0.5 }, weather: STONE_WEATHER },
    vc: 'tint',
    meta: { courseH: 0.5, blockL: 0.8, blockRange: [0.5, 1.3], courses: 4, joint: 0.012, uv: 'as stone.ashlar (rock-faced rustication, faceted boss, deep joints)', weather: STONE_WEATHER, tints: LIMESTONE_TINTS },
  },

  // ---------------------------------------------------------------- paving
  'paving.street': {
    props: { roughness: 1 },
    bake: 'paving',
    surf: {
      swap: true, cell: PAVING_CELL, macro: { ...PAVING_MACRO, an2: [1.5, 0.12] }, detail: PAVING_DETAIL,
      spots: { prob: 0.08, radius: 0.011, albedo: 0.5, rough: 0.5 },
      stain: { amount: 0.14, freq: 0.5, threshold: 0.7 },
      lanes: { track: 1.6, rail: 0.7455, grime: 0.07, wear: 0.05 },
    },
    vc: 'tint',
    meta: {
      paver: [0.4, 0.2], rows: 'across',
      uv: 'u = metres along the street, v = metres across = route offset d (ribbon UVs). Courses run across the street: the continuous, nearly invisible sand-filled bed joints lie across the track and the short dark head joints read as dashes along it. v = d also places the grime along the rails (d = ±1.6 ± 0.7455).',
    },
  },
  'paving.sidewalk': {
    props: { roughness: 1, color: [1.02, 1.01, 0.99] },
    bake: 'paving',
    surf: {
      scale: 1.25, cell: { ...PAVING_CELL, value: 0.06 }, macro: PAVING_MACRO, detail: PAVING_DETAIL,
      spots: { prob: 0.14, radius: 0.011, albedo: 0.48, rough: 0.5 },
      stain: { amount: 0.18, freq: 0.5, threshold: 0.66 },
    },
    vc: 'tint',
    meta: { paver: [0.5, 0.25], rows: 'along u', uv: 'u along the street, v across (m)' },
  },
  'paving.band': {
    props: { roughness: 1 },
    bake: 'band',
    surf: { cell: { value: 0.05, hue: 0.3, rough: 0.08, row: 0, a: [1.03, 1.0, 0.97], b: [0.98, 0.99, 1.02] }, macro: { ...PAVING_MACRO, albedo: 0.07 }, detail: { ...STONE_DETAIL, normal: 0.3, albedo: 0.15 }, stain: { amount: 0.12, freq: 0.5, threshold: 0.72 } },
    vc: 'tint',
    meta: { slab: [0.7, 'full band width'], uv: 'u along the band, v across; no lengthwise joints' },
  },
  'paving.platform': {
    props: { roughness: 1 },
    bake: 'platform',
    surf: { cell: { value: 0.05, hue: 0.3, rough: 0.08, row: 0.2, a: [1.02, 1.0, 0.98], b: [0.98, 0.99, 1.02] }, macro: PAVING_MACRO, detail: { ...STONE_DETAIL, albedo: 0.25 }, spots: { prob: 0.12, radius: 0.009, albedo: 0.62, rough: 0.55 } },
    vc: 'tint',
    meta: { slab: [0.4, 0.4], uv: 'u along the platform, v across (m)' },
  },
  'paving.tactile': {
    props: { roughness: 1 },
    bake: 'tactile',
    surf: { cell: { value: 0.04, hue: 0, rough: 0.05, row: 0 }, macro: PAVING_MACRO, detail: { ...STONE_DETAIL, normal: 0.3 } },
    vc: 'tint',
    meta: { tile: [0.3, 0.3], uv: 'metres; truncated domes on a 50 mm grid (warning strip at platform edges)' },
  },

  // ---------------------------------------------------------------- rail
  'rail.head': {
    props: { metalness: 1, roughness: 1 },
    bake: 'railhead',
    surf: { macro: { f1: 1 / 5, f2: 1 / 13, albedo: 0.05, rough: 0.25, an1: [0.3, 3], an2: [0.2, 2] } },
    meta: {
      uv: 'u along the rail (m), v across the head (m), tile 0.25 m across. Polished running band (21-30 mm, roughness ~0.15, metal 1) centred at v = 0.043 (swept profile: arc length from the field-side paving edge, head top centre) and at v = 0 (flat inlays: rail-local x); flange-polished gauge corner at v ~0.075; dull grey edge, brown oxide shoulders (roughness ~0.55, metal 0.6) and dusty steel elsewhere. The base values are final: no roughness multiplier is needed.',
      band: { centres: [0.043, 0], halfWidth: 0.0125, gaugeCorner: 0.075 },
    },
  },
  'rail.side': {
    props: { metalness: 1, roughness: 1 },
    bake: 'railside',
    surf: { macro: { albedo: 0.1, rough: 0.05 } },
  },
  'rail.groove': {
    props: { roughness: 1 },
    bake: 'railgroove',
    surf: { macro: { albedo: 0.2, rough: 0.1, an1: [0.3, 3], an2: [0.1, 1] } },
  },

  // ---------------------------------------------------------------- metal
  'metal.iron': {
    props: { color: [0.032, 0.032, 0.034], roughness: 1 },
    bake: 'paint',
    surf: { macro: { albedo: 0.08, rough: 0.12 } },
    vc: 'albedo',
    meta: { note: 'black painted wrought / cast iron (balconies, railings, lamp scrolls)' },
  },
  'metal.pole': {
    props: { color: [0.062, 0.067, 0.071], roughness: 1.15 },
    bake: 'paint',
    surf: { macro: { albedo: 0.1, rough: 0.12, f1: 1 / 2, f2: 1 / 7 } },
    vc: 'albedo',
    meta: { note: 'dark grey painted steel (lamp / catenary poles)' },
  },
  'metal.galvanized': {
    props: { metalness: 1, roughness: 1 },
    bake: 'galv',
    surf: { macro: { albedo: 0.06, rough: 0.12 } },
  },
  'metal.steel': {
    props: { metalness: 1, roughness: 1 },
    bake: 'brushed',
    surf: { macro: { albedo: 0.03, rough: 0.08 } },
  },
  'metal.wire': {
    props: { color: [0.3, 0.19, 0.125], metalness: 1, roughness: 0.45 },
    meta: { note: 'oxidised copper / bronze contact and span wire' },
  },
  'metal.rust': {
    props: { metalness: 1, roughness: 1 },
    bake: 'railside',
    surf: { macro: { albedo: 0.1, rough: 0.05 } },
    meta: { note: 'rusty iron (brackets, old fittings)' },
  },

  // ---------------------------------------------------------------- glass
  'glass.window': {
    props: { color: [0.028, 0.032, 0.035], roughness: 1, envMapIntensity: 1 },
    bake: 'glass',
    surf: { normal: 1.0, ao: 0, microShadow: 0, variance: 0 },
    meta: { note: 'opaque dark reflective glass; relies on the scene environment map. Slight waviness of old panes.' },
  },
  'glass.shop': {
    props: { color: [0.03, 0.034, 0.036], roughness: 1, envMapIntensity: 1 },
    bake: 'glass',
    surf: { scale: 2.5, normal: 0.35, ao: 0, microShadow: 0, variance: 0 },
    meta: { note: 'opaque dark reflective plate glass' },
  },
  'glass.clear': {
    props: { color: [0.6, 0.62, 0.62], roughness: 1, transparent: true, opacity: 0.06, premultipliedAlpha: true, depthWrite: false },
    bake: 'glass',
    surf: { scale: 2.5, normal: 0.35, ao: 0, microShadow: 0, variance: 0 },
    glassClear: true,
    meta: { note: 'transparent thin glass (premultiplied): full-strength Fresnel reflections, for glazing with something modelled behind it' },
  },
  'glass.lamp': {
    // milky diffuser body under a glossy outer skin: a sharp sky reflection by day; at
    // night a warm glow, brightest where we look through the diffuser at the lamp and
    // falling off towards the rim (moderate intensity so the hue survives the tone curve;
    // bloom supplies the glow)
    kind: 'physical',
    props: { color: [0.55, 0.545, 0.52], roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.08, emissive: [1.0, 0.6, 0.28], emissiveIntensity: 3.5 },
    night: true,
    surf: { emis: { rim: 0.65, exp: 0.6 } },
    meta: { note: 'frosted lantern glass (clearcoated); emissive scales with U.uNight × materials.uniforms.emissiveGain, with a core-to-rim falloff' },
  },
  'emissive.warm': {
    props: { color: [0, 0, 0], roughness: 0.6, emissive: [1.0, 0.75, 0.48], emissiveIntensity: 3 },
    night: true,
    meta: { note: 'warm lit interiors / signs; dark by day, emissive with U.uNight' },
  },

  // ---------------------------------------------------------------- fabric
  'fabric.awning': {
    kind: 'physical',
    props: { color: [0.6, 0.53, 0.4], roughness: 1, sheen: 0.6, sheenRoughness: 0.65, sheenColor: [0.5, 0.48, 0.44], side: 'double' },
    bake: 'canvas',
    surf: { macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.06, rough: 0.05 }, trans: [0.3, 0.27, 0.22] },
    vc: 'albedo',
    meta: { uv: 'metres', note: 'acrylic canvas with weave, sheen and back-lit translucency' },
  },
  'fabric.umbrella': {
    kind: 'physical',
    props: { color: [0.7, 0.66, 0.57], roughness: 1, sheen: 0.6, sheenRoughness: 0.65, sheenColor: [0.5, 0.48, 0.44], side: 'double' },
    bake: 'canvas',
    surf: { macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.05, rough: 0.05 }, trans: [0.38, 0.35, 0.3] },
    vc: 'albedo',
  },
  'fabric.flag': {
    kind: 'physical',
    props: { color: [0.82, 0.82, 0.82], roughness: 1, sheen: 0.5, sheenRoughness: 0.5, sheenColor: [0.6, 0.6, 0.6], side: 'double' },
    bake: 'canvas',
    surf: { scale: 0.5, normal: 0.5, trans: [0.65, 0.65, 0.65] },
    vc: 'albedo',
  },

  // ---------------------------------------------------------------- wood / paint / plastic
  'wood.shutter': {
    props: { color: [0.035, 0.085, 0.055], roughness: 1 },
    bake: 'paintwood',
    surf: { macro: { f1: 1 / 1.2, f2: 1 / 3, albedo: 0.08, rough: 0.1 } },
    vc: 'albedo',
    meta: { uv: 'grain along u (louvres horizontal)', note: 'painted timber; vertex colour = paint colour' },
  },
  'wood.door': {
    kind: 'physical',
    props: { color: [0.36, 0.28, 0.22], roughness: 1, clearcoat: 0.6, clearcoatRoughness: 0.25 },
    bake: 'wood',
    surf: { macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.06, rough: 0.06 } },
    vc: 'tint',
    meta: { uv: 'grain along v (vertical boards)', note: 'varnished hardwood (clearcoat), no weathering checks' },
  },
  'wood.bench': {
    props: { color: [0.78, 0.74, 0.68], roughness: 1.15 },
    bake: 'woodweathered',
    surf: { swap: true, macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.08, rough: 0.06 } },
    vc: 'tint',
    meta: { uv: 'grain along u (slats)', note: 'weathered timber with grain-aligned checks' },
  },
  'paint.frame': {
    props: { color: [0.03, 0.055, 0.042], roughness: 1 },
    bake: 'paint',
    surf: { scale: 0.5, macro: { albedo: 0.06, rough: 0.1 } },
    vc: 'albedo',
    meta: { note: 'painted window / shop frames; vertex colour = paint colour' },
  },
  'plastic.chair': {
    props: { color: [0.2, 0.42, 0.62], roughness: 1.05 },
    bake: 'plastic',
    surf: {},
    vc: 'albedo',
  },
  'sign.panel': {
    props: { color: [0.012, 0.06, 0.2], roughness: 0.8 },
    bake: 'paint',
    surf: { scale: 0.5 },
    vc: 'albedo',
  },
  'rubber': {
    props: { color: [0.022, 0.022, 0.022], roughness: 1.9 },
    bake: 'plastic',
    surf: {},
  },

  // ---------------------------------------------------------------- building / ground misc
  'concrete': {
    props: { roughness: 1 },
    bake: 'concrete',
    surf: { macro: { albedo: 0.07, rough: 0.05 }, detail: { ...STONE_DETAIL, albedo: 0.18 }, weather: { ...STONE_WEATHER, ledge: 0.18 } },
    vc: 'tint',
  },
  'plaster': {
    props: { roughness: 1 },
    bake: 'plaster',
    surf: { macro: { ...STONE_MACRO, albedo: 0.07 }, detail: { ...STONE_DETAIL, normal: 0.35, albedo: 0.15 }, weather: STONE_WEATHER },
    vc: 'tint',
  },
  'roof.tile': {
    props: { roughness: 1 },
    bake: 'rooftile',
    surf: { cell: { value: 0.15, hue: 0.9, rough: 0.08, row: 0.2, a: [1.08, 0.9, 0.82], b: [0.9, 0.95, 0.95], out: [0.7, 0.72, 0.72, 0.05] }, macro: { f1: 1 / 5, f2: 1 / 13, albedo: 0.1, rough: 0.06 } },
    vc: 'tint',
    meta: { tileSize: [0.24, 0.33], uv: 'u along the eaves, v up the slope (m)' },
  },
  'roof.membrane': {
    props: { roughness: 1 },
    bake: 'membrane',
    surf: { macro: { albedo: 0.1, rough: 0.05 } },
    vc: 'tint',
  },
  'asphalt': {
    props: { roughness: 1 },
    bake: 'asphalt',
    surf: { macro: { f1: 1 / 8, f2: 1 / 25, albedo: 0.12, rough: 0.06 }, stain: { amount: 0.2, freq: 0.4, threshold: 0.68 } },
    vc: 'tint',
  },
  'bark': {
    props: { roughness: 1 },
    bake: 'bark',
    surf: { macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.08, rough: 0.04 } },
    vc: 'tint',
    meta: { uv: 'u around the trunk, v up (m)' },
  },
  'leaf': {
    props: { color: [0.06, 0.12, 0.028], roughness: 0.55, side: 'double' },
    surf: { trans: [0.32, 0.55, 0.12] },
    vc: 'albedo',
    meta: { note: 'base leaf: diffuse translucency for back-lit foliage. Vertex colour = leaf colour.' },
  },
};
