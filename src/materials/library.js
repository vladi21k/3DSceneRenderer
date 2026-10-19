// Material library definitions. Colours are LINEAR RGB. Textured materials keep
// colour = 1 (or a paint colour) and roughness = 1: the baked maps hold the values.
//
//   kind     'standard' | 'physical'
//   props    three.js material properties
//   bake     recipe name (recipes/*.js) providing albedo + surface maps
//   surf     runtime surface settings (see surface.js / surfaceUniforms)
//   fx       shader feature family (surface.js FAMILY): 'lite' | 'full'; by default
//            'full' when the material uses a row layout, detail, weathering or lanes
//   vc       vertex colour meaning for get(name, {vertexColors:true}):
//            'tint'   multiplier around 1 (per-building stone tint × baked AO)
//            'albedo' the paint / fabric colour itself (material colour reset to white)
//   meta     published in materials.meta[name] for other modules

// Per-building tints, multipliers on the baked limestone (which is itself a warm honey-cream,
// linear albedo ~(0.6, 0.47, 0.27)). Sunlit Jerusalem stone reads honey to golden in the
// photographs: honey / golden should go to about half the buildings, pale / grey to about
// a fifth (the pale ones need a clearly cooler tint than before to read pale cream).
const LIMESTONE_TINTS = {
  cream: [1.0, 1.0, 1.0],
  honey: [1.03, 0.97, 0.86],
  pale: [1.0, 1.04, 1.16],
  pinkish: [1.03, 0.95, 0.91],
  grey: [0.93, 0.97, 1.12],
  golden: [1.04, 0.97, 0.8],
  aged: [0.88, 0.85, 0.82],
};
const LIMESTONE_WEIGHTS = { honey: 0.3, golden: 0.2, cream: 0.2, pinkish: 0.1, pale: 0.12, grey: 0.08 };

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
// rock-faced bosses: fine pitting and small spalls at close range (the large fracture facets
// are in the rustic map), per block, faded on the drafted margin
const STONE_PITCH = { tex: 'pitch', tool: 'pitch', freq: 2.0, normal: 0.8, albedo: 0.5, rough: 0.05, share: 1.0, margin: 0.035, farVar: 0.008 };
// soiled ledges, sheltered soffits, faint vertical drip streaks
const STONE_WEATHER = { ledge: 0.22, streak: 0.08, threshold: 0.6, soffit: 0.1 };

// Granite setts: the tone drifts in runs, as quarry batches and dirt do: per sett, an
// independent ±7 % plus as much again from a 1-3 m noise sampled at the sett centre
// (total std ~7 %), the beige ↔ blue-grey drift following the same noise half way; a little
// banding per course, 1-4 m mottling and broad wear patches (macro), and ~3.5 % odd setts:
// darker replacements, warmer beige and cooler blue-grey ones.
const PAVING_CELL = {
  value: 0.07, hue: 0.65, rough: 0.08, row: 0.25, a: [1.06, 1.0, 0.93], b: [0.95, 0.99, 1.06],
  corr: 0.45, corrHue: 0.5, corrFreq: 1 / 6,
  out: { p: 0.035, fam: [[0.78, 0.78, 0.8], [1.08, 1.0, 0.88], [0.9, 0.95, 1.05]] },
};
// chewing gum: grey to grey-black blotches 0.6-3 cm across, clustered (3-8 m noise) where
// people stand and wait; on the street hardly any between and over the rails
const GUM = { radius: 0.0065, albedo: 0.67, rough: 0.5, cluster: { freq: 1 / 25, lo: 0.5, hi: 0.6 } };
// old spill blots soaked into the setts (oil, coffee, juice): 2-10 cm, soft, a darker tide
// line, most a little glossy (runtime, per global sett: never repeating with the tile)
const BLOT = { prob: 0.045, radius: 0.022, albedo: 0.8, rough: 0.82 };
const PAVING_MACRO = { f1: 1 / 2.5, f2: 1 / 20, albedo: 0.16, rough: 0.12, an1: [1, 1], an2: [0.12, 1.5] };
// crystals at close range (mica darker and glossy, feldspar pale), low contrast: fine
// grey granite, not terrazzo
const PAVING_DETAIL = { tex: 'granite', freq: 4, normal: 0.5, albedo: 0.35, rough: -0.6, farVar: 0.004 };
// cool grey granite (the baked map is already blue-grey; the street is a touch cooler)
const PAVING_TINT = [0.98, 1.0, 1.02];

export const LIBRARY = {
  // ---------------------------------------------------------------- stone
  'stone.ashlar': {
    props: { roughness: 1 },
    bake: 'ashlar',
    surf: { cell: STONE_CELL, macro: STONE_MACRO, detail: STONE_DRESS, weather: STONE_WEATHER, microShadow: 1, mirror: 0.75 },
    vc: 'tint',
    meta: {
      courseH: 0.35, blockL: 0.7, blockRange: [0.36, 1.2], courses: 12, joint: 0.006,
      uv: 'u along the wall, v up (m). Course joints at v = k × courseH. Scale v by meta.courseH / plan.courseH (and u by blockL / plan.blockL) to match a building style; offset v by a random whole number of courses and u by a random amount per lot so neighbours differ.',
      dressing: 'per block at runtime: 60 % taltish comb strokes (vertical or diagonal), 25 % pecked, 15 % rubbed; 20-35 mm finer drafted margin',
      weather: { ...STONE_WEATHER, note: 'albedo darkening on up-facing ledges (ledge), down-facing soffits (soffit) and vertical drip streaks (streak), from world normal / position. The splash zone near the paving is left to vertex colours.' },
      tints: LIMESTONE_TINTS,
      tintWeights: LIMESTONE_WEIGHTS,
      albedo: [0.6, 0.47, 0.27], // mean linear albedo of the baked limestone (before tints): far-field stand-ins should match it
    },
  },
  'stone.dirty': {
    props: { roughness: 1, color: [0.84, 0.8, 0.74] },
    bake: 'ashlar',
    surf: {
      cell: STONE_CELL, macro: { ...STONE_MACRO, albedo: 0.12, rough: 0.08 }, detail: STONE_DRESS, mirror: 0.75,
      // stains on the walls read as run-off: faint, sparse and stretched 1:6 down the face
      // (the patchy dirt stays on the ledges, the weathering's ledge term)
      weather: { ...STONE_WEATHER, ledge: 0.3, streak: 0.14, soffit: 0.16 }, stain: { amount: 0.05, freq: 0.6, threshold: 0.75, stretch: 6 },
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
    fx: 'relief',
    surf: {
      cell: { ...STONE_CELL, value: 0.09 }, macro: STONE_MACRO, detail: STONE_PITCH, weather: STONE_WEATHER, mirror: 0.75,
      // deep joints and hollows: the baked occlusion counts in full even while SSAO runs
      ao: 1.6,
      // parallax-occlusion relief of the bosses (height in the albedo alpha): full within
      // 20 m, gone by 35 m; self-shadowing towards the sun
      relief: { near: 20, far: 35, steps: [12, 24], shadowSteps: 14, shadow: 1 },
    },
    vc: 'tint',
    meta: { courseH: 0.5, blockL: 0.8, blockRange: [0.5, 1.3], courses: 4, joint: 0.012, relief: [0, 0.095], uv: 'as stone.ashlar (rock-faced rustication: a rounded boss with 3-5 large struck planes and one or two conchoidal scars, 5-9 cm proud of the drafted margin, which lies in the polygon plane (15-25 mm wide); deep joints 2 cm behind it. Rendered with parallax-occlusion relief and self-shadowing within ~35 m, so the bosses stand out of the polygon (meta.relief: m in front of the polygon) and break the outline inside a face; the outline of the mesh itself (pier corners, reveals) stays as modelled. Each block\'s boss differs, and its relief is mirrored at random per block at runtime; fine 2-5 mm pitting added within ~6 m)', weather: STONE_WEATHER, tints: LIMESTONE_TINTS },
  },

  // ---------------------------------------------------------------- paving
  'paving.street': {
    props: { roughness: 1, color: PAVING_TINT },
    bake: 'paving',
    surf: {
      swap: true, cell: PAVING_CELL, macro: { ...PAVING_MACRO, an2: [1.5, 0.12] }, detail: PAVING_DETAIL, mirror: 0.75,
      spots: { ...GUM, prob: 0.12, laneClear: 3.0, blot: BLOT },
      stain: { amount: 0.2, freq: 0.5, threshold: 0.66 },
      // soft grime either side of each rail's mortar strip (brake dust, oil, the dirt the
      // flanges throw out of the grooves), and a slightly darker four-foot (drips; a real
      // track zone is never paler than the paving beside it), a little smoother
      lanes: { track: 1.6, rail: 0.7455, grime: 0.18, wear: -0.03, grimeBand: [0.05, 0.35], laneBand: [0.25, 0.55] },
    },
    vc: 'tint',
    meta: {
      albedo: [0.157, 0.168, 0.192], // mean linear albedo (setts + joints, before vertex tint): cool mid-grey granite
      paver: [0.4, 0.2], rows: 'across',
      uv: 'u = metres along the street, v = metres across = route offset d (ribbon UVs). Courses run across the street: the continuous, nearly invisible sand-filled bed joints lie across the track and the short dark head joints read as dashes along it. v = d also places the grime along the rails (d = ±1.6 ± 0.7455).',
      laneAttr: 'get(\'paving.street\', {vertexColors: true, laneAttr: true}) takes the rail-lane grime position from a float vertex attribute aLaneD (route offset d, m) instead of v, so v can be set out freely (e.g. courses started from the rail mortar strips). One extra program.',
    },
  },
  'paving.sidewalk': {
    props: { roughness: 1, color: PAVING_TINT },
    bake: 'paving',
    surf: {
      scale: 1.25, cell: { ...PAVING_CELL, value: 0.06 }, macro: PAVING_MACRO, detail: PAVING_DETAIL, mirror: 0.75,
      spots: { ...GUM, prob: 0.22, blot: { ...BLOT, prob: 0.06 } },
      stain: { amount: 0.22, freq: 0.5, threshold: 0.64 },
      // v = metres from the gutter: grime along the kerb edge (and ~7 m in, at the building
      // line), a darker trodden pedestrian lane round 3.6 m
      lanes: { track: 3.6, rail: 3.6, grime: 0.06, wear: -0.045, grimeBand: [0.1, 0.6], laneBand: [0.7, 2.0] },
    },
    vc: 'tint',
    meta: { albedo: [0.157, 0.168, 0.192], paver: [0.5, 0.25], rows: 'along u', uv: 'u along the street, v across (m): metres from the gutter edge on the main sidewalks (places the kerb grime and the trodden lane)' },
  },
  'paving.band': {
    props: { roughness: 1 },
    bake: 'band',
    surf: { cell: { value: 0.085, hue: 0.3, rough: 0.08, row: 0, a: [1.03, 1.0, 0.97], b: [0.98, 0.99, 1.02] }, macro: { ...PAVING_MACRO, albedo: 0.1 }, detail: { ...STONE_DETAIL, normal: 0.3, albedo: 0.2 }, stain: { amount: 0.16, freq: 0.5, threshold: 0.68 } },
    vc: 'tint',
    meta: { albedo: [0.21, 0.209, 0.203], slab: [0.7, 'full band width'], uv: 'u along the band, v across; no lengthwise joints' },
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
    // The environment cube already holds the street canyon (env), but it is captured well
    // above the paving: a rail head lying in the street sees the narrow sky slot down the
    // street through less solid angle than the cube's centre does, and nothing in the cube
    // occludes it locally. envMapIntensity 0.55 stands for that (street's RAIL_HEAD_ENV and
    // its far-field line overlay use the same value).
    props: { metalness: 1, roughness: 1, envMapIntensity: 0.55 },
    bake: 'railhead',
    surf: { macro: { f1: 1 / 5, f2: 1 / 13, albedo: 0.06, rough: 0.2, an1: [0.3, 3], an2: [0.2, 2] } },
    meta: {
      uv: 'u along the rail (m), v across the head (m), tile 0.25 m across. A 21-29 mm running band on the head is the only bright part (satin steel, albedo ~0.45, roughness 0.5-0.7 with fine lengthwise streaks, 2-10 cm patches, 10-50 cm dull stretches, duller burn patches and fine fatigue pits, never a mirror; metal 1). Swept profile: the head top (x -25 .. 21.5 mm) must stay pinned onto v 0.031-0.0543 (half a metre of v per metre of head, centre x = 0 at v = 0.0435), so the band covers v 0.0373-0.0498. Off the band the head is oxidised: the shoulders either side of the band under a thin brown-grey oxide (albedo ~(0.235, 0.205, 0.175), roughness ~0.66, metal 0.55), the field-side bevel (v 0.017-0.031) and the gauge corner (v 0.054-0.071) under a rust-brown film (albedo ~(0.2, 0.155, 0.11), roughness ~0.72, metal 0.4); the upper gauge face (v ~0.076) lightly polished (roughness ~0.5), the guard lip (v 0.1-0.13) dull dusty oxide (albedo ~0.15, roughness ~0.72, metal 0.4). Flat inlays: v = rail-local x (1:1), band centred at v = 0, worn steel within |x| < 27 mm. The base values are final: no roughness multiplier is needed. envMapIntensity 0.55.',
      band: { centres: [0.0435, 0], halfWidth: 0.0125, vPerM: [0.5, 1], gaugeCorner: 0.076, lip: [0.1, 0.13] },
      // mean far-field values per zone (street's line overlay should match them)
      zones: { band: { albedo: [0.451, 0.446, 0.436], rough: 0.57, metal: 1 }, shoulder: { albedo: [0.254, 0.226, 0.2], rough: 0.64, metal: 0.59 }, bevel: { albedo: [0.204, 0.161, 0.118], rough: 0.72, metal: 0.41 }, lip: { albedo: [0.16, 0.145, 0.125], rough: 0.72, metal: 0.4 } },
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
    props: { color: [0.125, 0.152, 0.148], roughness: 1.3 },
    bake: 'paint',
    surf: { macro: { albedo: 0.1, rough: 0.12, f1: 1 / 2, f2: 1 / 7 } },
    vc: 'albedo',
    meta: { note: 'grey-green satin street-iron paint (lamp / catenary poles): linear (0.125, 0.152, 0.148), effective roughness ~0.5 (the roughness property multiplies the baked paint roughness ~0.4: pass 1.3 or omit it, not 0.5)' },
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
    meta: { note: 'opaque dark reflective plate glass: dielectric F0 0.04, roughness ~0.03 (dust up to ~0.1 low on the pane), full environment reflection with no AO or micro-shadowing on the specular path; the diffuse colour stands for the dim interior behind it' },
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
    // water marks and dirt at decimetre scale, a little run-off stretch down the cloth
    surf: { macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.08, rough: 0.05 }, stain: { amount: 0.1, freq: 0.9, threshold: 0.6, stretch: 1.6, matt: true }, trans: [0.3, 0.27, 0.22] },
    vc: 'albedo',
    meta: { uv: 'metres', note: 'acrylic canvas with heathered weave, soiling, sheen and back-lit translucency' },
  },
  'fabric.umbrella': {
    kind: 'physical',
    props: { color: [0.7, 0.66, 0.57], roughness: 1, sheen: 0.6, sheenRoughness: 0.65, sheenColor: [0.5, 0.48, 0.44], side: 'double' },
    bake: 'canvas',
    surf: { macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.07, rough: 0.05 }, stain: { amount: 0.08, freq: 0.9, threshold: 0.62, matt: true }, trans: [0.38, 0.35, 0.3] },
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
  'wood.shutterDetail': {
    props: { color: [0.035, 0.085, 0.055], roughness: 1 },
    bake: 'paintwooddetail',
    surf: { macro: { f1: 1 / 1.2, f2: 1 / 3, albedo: 0.08, rough: 0.1 } },
    vc: 'albedo',
    meta: {
      uv: 'metres, grain along u (louvres horizontal), tile 1 m; offset u / v randomly per shutter',
      note: 'close-range painted timber: grain telegraphing, brush marks and paint cracks along the grain, elongated chips showing primer / grey weathered wood (not tinted by the paint colour), faint lighter bead lines along u. Vertex colour = paint colour.',
    },
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
  'paint.frameDetail': {
    props: { color: [0.03, 0.055, 0.042], roughness: 1 },
    bake: 'paintdetail',
    surf: { macro: { f1: 1 / 1.3, f2: 1 / 3.5, albedo: 0.06, rough: 0.1 } },
    vc: 'albedo',
    meta: {
      uv: 'metres (tile 1 m)',
      note: 'close-range painted joinery: brush marks (stroke along u or v in patches), chipped paint showing pale primer and, in deeper chips, grey weathered wood (not tinted by the paint colour), a lighter putty fillet at v 0-10 mm and a bead line at v ≈ 18 mm of every 1 m tile row: lay frame UVs out as u along the member and v = metres from the glass edge to put them at the glass, and offset u by a random amount per opening so neighbours differ. Vertex colour = paint colour.',
    },
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
    meta: { uv: 'u around the trunk, v up (m), tile 0.8 × 1.6 m', note: 'grey-brown bark with long, shallow, interlacing vertical fissures (normal + AO relief, 6-18 mm wide, 1.5-5 mm deep; lens-shaped plates 4-10 cm across, 0.3-1 m long), fine cracks on the ridges, pale lenticel dashes and grey-green lichen patches. For trunks under ~25 cm and branches, bark.smooth.' },
  },
  'bark.smooth': {
    props: { roughness: 1 },
    bake: 'barksmooth',
    surf: { macro: { f1: 1 / 1.5, f2: 1 / 4, albedo: 0.08, rough: 0.04 } },
    vc: 'tint',
    meta: { uv: 'as bark', note: 'smooth grey young bark: faint vertical striation, a few long shallow splits, horizontal lenticel dashes (3-8 mm), lichen patches (young street trees, branches)' },
  },
  'leaf': {
    // the values vegetation's own leaf shader settled on (waxy cuticle, bright back-lit green)
    props: { color: [0.06, 0.12, 0.028], roughness: 0.45, side: 'double' },
    surf: { trans: [0.45, 0.7, 0.15] },
    vc: 'albedo',
    meta: { note: 'base leaf: diffuse translucency for back-lit foliage. Vertex colour = leaf colour.' },
  },
};
