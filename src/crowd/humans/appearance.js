import * as THREE from 'three';
import { RNG } from '../../core/rng.js';

// Deterministic "who is this person" from the crowd's integer appearance seed:
// age group, sex, stature, build, skin, hair, outfit, accessories and gait style.
// Palettes are typical of a Mediterranean city street in summer: lots of white,
// light blue, black and denim, khaki shorts, bright tees, modest long skirts, dark
// suits with hats, sun hats for the elderly.

// garment type codes shared with the shader (material.js)
export const TOP = { TEE: 0, POLO: 1, SHIRT: 2, TANK: 3, BLOUSE: 4, JACKET: 5, LONGTEE: 6, DRESS: 7 };
export const BOTTOM = { JEANS: 0, TROUSERS: 1, SHORTS: 2, SKIRT: 3, LEGGINGS: 4, DRESS: 5 };
export const PATTERN = { SOLID: 0, STRIPES: 1, PINSTRIPE: 2, CHECK: 3, PRINT: 4, GRAPHIC: 5 };
export const SHOE = { SNEAKER: 0, LEATHER: 1, SANDAL: 2, FLAT: 3 };
export const FABRIC = { COTTON: 0, DENIM: 1, WOOL: 2, SYNTH: 3, LINEN: 4, KNIT: 5 };
export const ROW_TEXELS = 14;

const srgb = (hex) => new THREE.Color(hex);  // THREE.Color(hex) converts sRGB -> linear working space
const C = (list) => list.map((x) => (Array.isArray(x) ? [srgb(x[0]), x[1]] : [srgb(x), 1]));

// skin albedo in linear RGB (measured ranges: light ~0.55 red, deep ~0.1)
const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b);
const SKIN = [[lin(0.60, 0.45, 0.37), 7], [lin(0.55, 0.40, 0.31), 16], [lin(0.50, 0.36, 0.27), 22], [lin(0.44, 0.31, 0.22), 20],
  [lin(0.37, 0.25, 0.17), 14], [lin(0.27, 0.17, 0.11), 9], [lin(0.17, 0.10, 0.065), 7], [lin(0.095, 0.058, 0.042), 4]];
const HAIR = C([['#1c1511', 28], ['#2a1d14', 30], ['#3d2a1b', 14], ['#5a3e26', 9], ['#7a5a38', 5],
  ['#a3834f', 5], ['#5b2a17', 3], ['#332a24', 6]]);
const HAIR_OLD = C([['#9b958c', 3], ['#bdb7ad', 4], ['#d6d1c8', 3], ['#6f6860', 2]]);

const TEE = C([['#f2f1ec', 16], ['#16171a', 12], ['#2a3346', 7], ['#8c9196', 6], ['#b9bcbd', 4], ['#8fb6d9', 6],
  ['#4f7fb4', 4], ['#3e8a4e', 5], ['#79b83a', 3], ['#c8352b', 4], ['#e9802a', 4], ['#e6c43a', 3],
  ['#6b6f3a', 4], ['#7a2534', 3], ['#2f8c8c', 3], ['#e7a3b8', 3], ['#9b6fb8', 2], ['#d9cdb0', 4]]);
const SHIRT = C([['#f4f4f1', 14], ['#bcd3ea', 12], ['#9dbbd9', 6], ['#e8e2d4', 5], ['#f2d4d6', 3],
  ['#3d5a80', 3], ['#2e2e33', 3], ['#c9d8c0', 3], ['#e9e3c9', 3]]);
const POLO = C([['#1f2c4a', 6], ['#f2f2ee', 6], ['#2f7d3e', 4], ['#c4302b', 3], ['#5f87b5', 4], ['#e0d3b2', 3],
  ['#121214', 4], ['#e48a2c', 2], ['#7fb8c9', 3]]);
const BLOUSE = C([['#f6f3ee', 12], ['#121214', 6], ['#e7b9c5', 4], ['#a9c9e4', 6], ['#f2d36b', 3], ['#e7e0cf', 5],
  ['#c94a3a', 3], ['#5fa58f', 3], ['#2c3f6b', 4], ['#d98a3d', 3], ['#b296c9', 2]]);
const DRESS = C([['#2a4a7a', 5], ['#f1eee6', 5], ['#141416', 6], ['#c23b3b', 3], ['#6aa4c8', 4], ['#e9c94e', 2],
  ['#4e7f4a', 3], ['#d7a1b6', 3], ['#e6dcc6', 3], ['#8a3a52', 2], ['#3a8a8a', 2]]);
const JEANS = C([['#2f4a6e', 10], ['#3e5f88', 9], ['#5679a3', 6], ['#7f9cbe', 4], ['#1d2737', 6], ['#2b2c30', 3]]);
const TROUSERS = C([['#141416', 12], ['#2b2f38', 6], ['#5b5d61', 5], ['#c2b391', 7], ['#a8956c', 4], ['#e9e3d3', 3],
  ['#25324a', 5], ['#6b6750', 3]]);
const SHORTS = C([['#c2b18b', 10], ['#a39066', 5], ['#25324a', 6], ['#4a6f96', 6], ['#6f7377', 4], ['#576042', 4],
  ['#141416', 4], ['#e7e2d4', 2], ['#8d2f30', 2]]);
const SKIRT = C([['#141416', 8], ['#25324a', 7], ['#5d6066', 4], ['#4a6f96', 4], ['#c7b48f', 3], ['#9b3238', 2],
  ['#3f5f42', 2], ['#e8e2d4', 2], ['#6f4a6b', 2]]);
const SKIRT_LONG = C([['#141416', 10], ['#1f2a44', 9], ['#3b3f47', 5], ['#4a6f96', 4], ['#6b5a4a', 3], ['#535a4c', 2]]);
const SHOES = C([['#f2f2ef', 9], ['#18181a', 10], ['#3b2a20', 6], ['#8a8f96', 4], ['#c7b9a2', 3], ['#2a3a5c', 2], ['#9a6a3e', 3]]);
const BAG = C([['#18181a', 12], ['#3b2a20', 6], ['#5a3b24', 5], ['#5d6b52', 3], ['#2c3e5e', 4], ['#8a8f96', 3],
  ['#b2342e', 2], ['#d9c8a8', 3], ['#e57b2c', 1]]);
const SHOPPING = C([['#e87b2a', 3], ['#f4f2ee', 4], ['#3a7bc0', 2], ['#d2302a', 2], ['#3c8a46', 1]]);
const CAP = C([['#18181a', 5], ['#f2f2ef', 3], ['#2a3a5c', 4], ['#b8352d', 2], ['#8b8f73', 2], ['#cdb991', 2]]);
const SUNHAT = C([['#e8dcc0', 5], ['#d8c49a', 4], ['#f4f1ea', 3], ['#1b1b1d', 1]]);
const SCARF = C([['#1d2337', 5], ['#3c3f46', 3], ['#5a3d52', 2], ['#7b6a5a', 2], ['#2e5a6a', 2], ['#e6e0d2', 2], ['#7a2a34', 2]]);

const pick = (r, list) => r.weighted(list).clone();
const jitter = (c, r, amt = 0.06) => {
  const hsl = {};
  c.getHSL(hsl);
  return c.setHSL(hsl.h + r.range(-0.012, 0.012), THREE.MathUtils.clamp(hsl.s * r.range(1 - amt * 2, 1 + amt), 0, 1),
    THREE.MathUtils.clamp(hsl.l * r.range(1 - amt, 1 + amt), 0, 1));
};

/** Derive the full description of a person. parts: name -> id from the asset metadata. */
export function deriveAppearance(seed, parts) {
  const r = new RNG((seed >>> 0) ^ 0x5bd1e995);
  const P = (name) => parts[name] || 0;
  const age = r.weighted([['child', 10], ['teen', 9], ['adult', 66], ['old', 15]]);
  const female = r.chance(0.5);
  const base = age === 'child' ? 'child' : female ? 'female' : 'male';
  let height;
  if (age === 'child') height = r.range(1.0, 1.50);
  else if (age === 'teen') height = female ? r.range(1.50, 1.70) : r.range(1.55, 1.80);
  else height = female ? r.normal(1.63, 0.06) : r.normal(1.765, 0.068);
  if (age === 'old') height -= r.range(0.01, 0.05);
  height = THREE.MathUtils.clamp(height, age === 'child' ? 1.0 : 1.48, 1.96);
  // build: < 0 slim, > 0 heavy (the street has plenty of heavy-set adults)
  let build = r.normal(0.15, 0.40) + (age === 'old' ? 0.2 : 0) - (age === 'teen' ? 0.3 : 0) - (age === 'child' ? 0.3 : 0);
  build = THREE.MathUtils.clamp(build, -0.55, 1.15);

  // the mesh: young children (4-6, up to ~1.22 m) have their own body (head 1/5 of the
  // stature, short legs, round belly); older children another (head ~1/6)
  const body = age === 'child' ? (height < 1.22 ? 'kid' : 'child') : base;
  const a = {
    seed, age, female, base, body, height, build,
    skin: jitter(pick(r, SKIN), r, 0.04),
    hair: null, hairPart: 0, beardPart: 0, hatPart: 0, bagPart: 0, skirtPart: 0,
    top: null, top2: null, topType: TOP.TEE, pattern: PATTERN.SOLID, sleeve: 0.3, topHem: 0, loose: 0.5,
    bottom: null, bottomType: BOTTOM.JEANS, hem: 0, looseB: 0.3, skirtLen: 0.5, skirtFlare: 0.5,
    shoes: null, sole: srgb('#ece9e2'), shoeType: SHOE.SNEAKER,
    bag: srgb('#18181a'), hat: srgb('#18181a'), glasses: 0, kippah: 0, beardAmt: 0,
    fabricTop: FABRIC.COTTON, fabricBottom: FABRIC.DENIM, wear: r.range(0, 1),
    walkOld: false, idle: r.weighted([[0, 45], [1, 25], [2, 15], [3, 15]]), sit: r.int(0, 2),
  };
  const old = age === 'old';
  a.hair = old && r.chance(0.8) ? jitter(pick(r, HAIR_OLD), r) : jitter(pick(r, HAIR), r);
  a.walkOld = old && r.chance(0.3);
  // gait style: 0 adult, 1 senior (shorter steps, less arm swing, a slight stoop), 2 frail (walkOld)
  a.gait = a.walkOld ? 2 : old ? 1 : 0;
  // forward stoop of the upper back (radians) carried into every pose
  a.stoop = old ? r.range(0.04, a.walkOld ? 0.16 : 0.10) : age === 'adult' ? r.range(0, 0.04) : 0;

  // --- hair & head
  if (base === 'male' || (base === 'child' && !female)) {
    const st = base === 'child' ? r.weighted([['hair_short', 6], ['hair_curly', 2]]) : old ? r.weighted([['hair_balding', 5], ['hair_receding', 4], ['hair_short', 2], ['hair_buzz', 2]])
      : r.weighted([['hair_short', 8], ['hair_side', 6], ['hair_buzz', 3], ['hair_medium', 3], ['hair_curly', 2], ['hair_receding', 2]]);
    a.hairPart = P(st);
    if (age !== 'child' && age !== 'teen') {
      if (r.chance(old ? 0.35 : 0.3)) a.beardPart = P(r.chance(0.55) ? 'beard_short' : 'beard_full');
      a.beardAmt = r.range(0.2, 1.0);
    }
  } else {
    const st = old ? r.weighted([['hair_pixie', 6], ['hair_bob', 3], ['hair_bun', 2], ['scarf', 2]])
      : age === 'child' ? r.weighted([['hair_ponytail', 4], ['hair_long', 4], ['hair_bob', 2]])
        : r.weighted([['hair_long', 9], ['hair_ponytail', 7], ['hair_bun', 4], ['hair_bob', 4], ['hair_pixie', 2], ['scarf', 2],
          ['hair_curlyf', 3]]);
    a.hairPart = P(st);
    if (st === 'scarf') a.hair = jitter(pick(r, SCARF), r);
  }

  // --- outfit
  const shoesDefault = () => {
    a.shoes = jitter(pick(r, SHOES), r);
    a.shoeType = r.weighted([[SHOE.SNEAKER, 7], [SHOE.LEATHER, 3], [SHOE.SANDAL, female ? 2 : 0.6]]);
  };
  shoesDefault();
  const setTop = (type, pal, sleeve, opts = {}) => {
    a.topType = type; a.top = jitter(pick(r, pal), r); a.sleeve = sleeve;
    a.loose = opts.loose ?? r.range(0.3, 0.8); a.topHem = opts.hem ?? r.range(0.0, 0.25);
    a.fabricTop = opts.fabric ?? FABRIC.COTTON;
  };
  const setBottom = (type, pal, hem, opts = {}) => {
    a.bottomType = type; a.bottom = jitter(pick(r, pal), r); a.hem = hem;
    a.looseB = opts.loose ?? r.range(0.2, 0.7); a.fabricBottom = opts.fabric ?? FABRIC.COTTON;
  };
  const patternMaybe = (p) => {
    if (!r.chance(p)) return;
    a.pattern = r.weighted([[PATTERN.STRIPES, 4], [PATTERN.CHECK, 2], [PATTERN.PRINT, 2], [PATTERN.GRAPHIC, 3], [PATTERN.PINSTRIPE, 1]]);
    a.top2 = a.top.clone().lerp(r.chance(0.5) ? srgb('#f4f4f0') : srgb('#141416'), r.range(0.55, 0.95));
    if (a.pattern === PATTERN.GRAPHIC || a.pattern === PATTERN.PRINT) a.top2 = jitter(pick(r, TEE), r);
  };
  a.top2 = srgb('#f4f4f0');

  if (base === 'male' && age !== 'child') {
    const o = old ? r.weighted([['shirt', 6], ['polo', 3], ['tee', 2], ['suit', 2]])
      : r.weighted([['teeJeans', 25], ['teeShorts', 16], ['polo', 10], ['shirt', 10], ['shirtLong', 8], ['suit', 9],
        ['tank', 3], ['sport', 4]]);
    if (o === 'teeJeans' || o === 'tee') { setTop(TOP.TEE, TEE, 0.30); patternMaybe(0.3); setBottom(BOTTOM.JEANS, JEANS, 0, { fabric: FABRIC.DENIM }); }
    else if (o === 'teeShorts') {
      setTop(TOP.TEE, TEE, 0.30); patternMaybe(0.3); setBottom(BOTTOM.SHORTS, SHORTS, r.range(0.55, 0.78), { loose: r.range(0.3, 0.9) });
      if (r.chance(0.2)) a.shoeType = SHOE.SANDAL;
    } else if (o === 'polo') {
      setTop(TOP.POLO, POLO, 0.30, { fabric: FABRIC.KNIT }); setBottom(BOTTOM.TROUSERS, TROUSERS, 0);
    } else if (o === 'shirt') {
      setTop(TOP.SHIRT, SHIRT, 0.34, { hem: r.chance(0.5) ? 0.5 : 0.15, fabric: FABRIC.LINEN });
      if (r.chance(0.25)) { a.pattern = r.chance(0.5) ? PATTERN.CHECK : PATTERN.PINSTRIPE; a.top2 = jitter(pick(r, SHIRT), r).multiplyScalar(0.6); }
      setBottom(BOTTOM.TROUSERS, TROUSERS, 0); if (!old && r.chance(0.3)) setBottom(BOTTOM.JEANS, JEANS, 0, { fabric: FABRIC.DENIM });
      a.shoeType = r.chance(0.6) ? SHOE.LEATHER : SHOE.SNEAKER;
    } else if (o === 'shirtLong') {
      setTop(TOP.SHIRT, SHIRT, r.chance(0.6) ? 0.62 : 0.98, { hem: r.chance(0.5) ? 0.5 : 0.15, fabric: FABRIC.LINEN });
      setBottom(r.chance(0.5) ? BOTTOM.JEANS : BOTTOM.TROUSERS, r.chance(0.5) ? JEANS : TROUSERS, 0);
    } else if (o === 'suit') {
      // dark suit, white shirt, dark hat: very common in the reference street
      a.topType = TOP.JACKET; a.top = srgb('#111113').lerp(srgb('#24262c'), r.next()); a.top2 = srgb('#f2f2ef');
      a.sleeve = 1.0; a.loose = r.range(0.5, 0.9); a.topHem = -0.55; a.fabricTop = FABRIC.WOOL;   // jacket ends below the seat
      setBottom(BOTTOM.TROUSERS, C(['#111113']), 0, { loose: r.range(0.5, 0.9), fabric: FABRIC.WOOL });
      a.bottom.copy(a.top);
      a.shoes = srgb('#121214'); a.shoeType = SHOE.LEATHER;
      if (r.chance(0.65)) { a.hatPart = P('fedora'); a.hat = srgb('#0e0e10'); }
      else a.kippah = 1;
      if (r.chance(0.35)) { a.skirtPart = P('skirt'); a.skirtLen = r.range(0.42, 0.55); a.skirtFlare = 0.25; } // long coat
      if (!a.beardPart && r.chance(0.7)) a.beardPart = P('beard_full');
      a.hair = srgb('#120d0a'); a.hairPart = P(r.chance(0.5) ? 'hair_short' : 'hair_buzz');
    } else if (o === 'tank') {
      setTop(TOP.TANK, TEE, 0.0); setBottom(BOTTOM.SHORTS, SHORTS, r.range(0.58, 0.78), { loose: 0.6 }); a.shoeType = SHOE.SANDAL;
    } else {
      setTop(TOP.TEE, TEE, 0.30, { fabric: FABRIC.SYNTH }); setBottom(r.chance(0.5) ? BOTTOM.SHORTS : BOTTOM.TROUSERS, C(['#18181a', '#25324a', '#5b5d61']), r.range(0.6, 0.78));
      a.shoeType = SHOE.SNEAKER;
    }
    if (a.topType !== TOP.JACKET && r.chance(old ? 0.25 : 0.05)) a.kippah = 1;
    if (!a.hatPart && r.chance(old ? 0.18 : 0.08)) { a.hatPart = P(old && r.chance(0.5) ? 'sunhat' : 'cap'); a.hat = jitter(pick(r, old ? SUNHAT : CAP), r); }
  } else if (base === 'female') {
    const o = old ? r.weighted([['blouseSkirtLong', 5], ['blouseTrousers', 4], ['dress', 2], ['blouseSkirt', 2]])
      : r.weighted([['topJeans', 18], ['blouseSkirt', 14], ['dress', 14], ['tankShorts', 8], ['topLeggings', 12],
        ['blouseSkirtLong', 12], ['blouseTrousers', 12]]);
    if (o === 'topJeans') { setTop(r.chance(0.5) ? TOP.TEE : TOP.BLOUSE, r.chance(0.5) ? TEE : BLOUSE, r.range(0.12, 0.35)); patternMaybe(0.3); setBottom(BOTTOM.JEANS, JEANS, 0, { fabric: FABRIC.DENIM, loose: 0.1 }); }
    else if (o === 'blouseSkirt') {
      setTop(TOP.BLOUSE, BLOUSE, r.range(0.1, 0.45)); patternMaybe(0.25);
      a.skirtPart = P('skirt'); setBottom(BOTTOM.SKIRT, SKIRT, 0); a.skirtLen = r.range(0.38, 0.62); a.skirtFlare = r.range(0.3, 0.9);
      a.shoeType = r.weighted([[SHOE.FLAT, 4], [SHOE.SANDAL, 3], [SHOE.SNEAKER, 2]]);
    } else if (o === 'dress') {
      a.topType = TOP.DRESS; a.top = jitter(pick(r, DRESS), r); a.sleeve = r.weighted([[0.0, 3], [0.15, 3], [0.3, 2], [0.6, 1]]);
      a.loose = 0.4; a.topHem = 0; a.bottomType = BOTTOM.DRESS; a.bottom = a.top.clone();
      if (r.chance(0.35)) { a.pattern = r.chance(0.6) ? PATTERN.PRINT : PATTERN.STRIPES; a.top2 = jitter(pick(r, BLOUSE), r); }
      a.skirtPart = P('skirt'); a.skirtLen = r.range(0.42, 0.85); a.skirtFlare = r.range(0.3, 1.0);
      a.shoeType = r.weighted([[SHOE.SANDAL, 4], [SHOE.FLAT, 3], [SHOE.SNEAKER, 2]]);
    } else if (o === 'tankShorts') {
      setTop(r.chance(0.6) ? TOP.TANK : TOP.TEE, TEE, r.chance(0.6) ? 0 : 0.18); setBottom(BOTTOM.SHORTS, r.chance(0.5) ? JEANS : SHORTS, r.range(0.72, 0.88), { loose: r.range(0.1, 0.5) });
      a.shoeType = r.chance(0.6) ? SHOE.SANDAL : SHOE.SNEAKER;
    } else if (o === 'topLeggings') {
      setTop(r.chance(0.5) ? TOP.TEE : TOP.TANK, TEE, r.range(0, 0.32), { hem: r.range(0, 0.15) }); patternMaybe(0.2);
      setBottom(BOTTOM.LEGGINGS, C([['#121214', 6], ['#2b2c30', 2], ['#25324a', 1]]), r.chance(0.3) ? r.range(0.18, 0.3) : 0, { loose: 0, fabric: FABRIC.SYNTH });
    } else if (o === 'blouseSkirtLong') {
      setTop(r.chance(0.5) ? TOP.BLOUSE : TOP.LONGTEE, BLOUSE, r.range(0.6, 1.0)); a.top = a.top.lerp(srgb('#2a2c33'), r.range(0, 0.6));
      a.skirtPart = P('skirt'); setBottom(BOTTOM.SKIRT, SKIRT_LONG, 0); a.skirtLen = r.range(0.85, 1.0); a.skirtFlare = r.range(0.3, 0.8);
      a.shoeType = r.chance(0.6) ? SHOE.FLAT : SHOE.SNEAKER; a.shoes = jitter(pick(r, C(['#18181a', '#3b2a20', '#2a2a30'])), r);
      if (!old && r.chance(0.35)) { a.hairPart = P('scarf'); a.hair = jitter(pick(r, SCARF), r); }
    } else {
      setTop(TOP.BLOUSE, BLOUSE, r.range(0.15, 0.6)); patternMaybe(0.2);
      setBottom(BOTTOM.TROUSERS, TROUSERS, r.chance(0.3) ? r.range(0.12, 0.25) : 0, { loose: r.range(0.4, 1.0), fabric: FABRIC.LINEN });
      a.shoeType = r.weighted([[SHOE.FLAT, 3], [SHOE.SANDAL, 3], [SHOE.SNEAKER, 2], [SHOE.LEATHER, 1]]);
    }
    if (r.chance(old ? 0.2 : 0.05)) { a.hatPart = P('sunhat'); a.hat = jitter(pick(r, SUNHAT), r); }
  } else {
    // children: bright tees, shorts, dresses
    const o = female ? r.weighted([['teeShorts', 4], ['dress', 4], ['teeSkirt', 2], ['teeLeggings', 2]])
      : r.weighted([['teeShorts', 6], ['teeJeans', 3], ['sport', 2]]);
    setTop(TOP.TEE, TEE, 0.30); patternMaybe(0.4);
    if (o === 'dress') {
      a.topType = TOP.DRESS; a.top = jitter(pick(r, DRESS), r); a.bottomType = BOTTOM.DRESS; a.bottom = a.top.clone();
      a.skirtPart = P('skirt'); a.skirtLen = r.range(0.4, 0.6); a.skirtFlare = r.range(0.6, 1.0); a.sleeve = r.range(0, 0.3);
    } else if (o === 'teeSkirt') { a.skirtPart = P('skirt'); setBottom(BOTTOM.SKIRT, SKIRT, 0); a.skirtLen = r.range(0.35, 0.5); a.skirtFlare = 0.8; }
    else if (o === 'teeLeggings') setBottom(BOTTOM.LEGGINGS, C(['#121214', '#25324a', '#c03a6a']), 0.2, { loose: 0 });
    else if (o === 'teeJeans') setBottom(BOTTOM.JEANS, JEANS, 0, { fabric: FABRIC.DENIM });
    else setBottom(r.chance(0.7) ? BOTTOM.SHORTS : BOTTOM.TROUSERS, SHORTS, r.range(0.5, 0.72), { loose: 0.6 });
    if (r.chance(0.3)) { a.bagPart = P('backpack'); a.bag = jitter(pick(r, TEE), r); }
  }

  // --- accessories (adults / teens)
  if (age !== 'child') {
    const bag = r.weighted([['none', female ? 48 : 66], ['backpack', age === 'teen' ? 30 : 11], ['shoulderbag', female ? 32 : 10],
      ['shopping', 7]]);
    if (bag !== 'none') {
      a.bagPart = P(bag);
      a.bag = jitter(pick(r, bag === 'shopping' ? SHOPPING : BAG), r);
    }
    a.glasses = r.chance(0.16) ? 1 : 0;
  }
  if (a.topType === TOP.JACKET && a.bagPart === P('shopping')) a.bagPart = 0;
  // walking variations: carrying a shopping bag damps the right arm; some walk looking at a phone
  a.carry = a.bagPart > 0 && a.bagPart === P('shopping');
  if (a.carry && a.idle !== 0) a.idle = 0;          // the bag hand hangs relaxed while standing
  a.phoneWalk = !a.carry && (age === 'adult' || age === 'teen') && r.chance(age === 'teen' ? 0.22 : 0.1);
  if (a.phoneWalk) a.idle = 1;                       // phone users keep looking at it when they stop
  if (age === 'child' && a.idle === 1) a.idle = 0;
  if (!a.top2) a.top2 = srgb('#f4f4f0');
  // blouses and tees worn with a skirt are tucked into its waistband
  if (a.skirtPart && a.bottomType === BOTTOM.SKIRT) a.topHem = 1;
  // crossed legs only in trousers: a skirt over a crossed knee cannot be shaped by the shell
  if (a.skirtPart && a.sit === 1) a.sit = 2;

  // ---- shape variety (drawn last so the outfits above stay stable)
  const grown = age === 'adult' || age === 'old';
  const mature = old || (age === 'adult' && r.chance(0.5));       // roughly "over 35"
  a.faceA = r.next() ** 1.5;                                       // long / narrow face
  a.faceB = r.next() ** 1.5 * (1 - 0.6 * a.faceA);                 // broad / round face
  a.faceOld = old ? r.range(0.55, 1.0) : mature ? r.range(0.0, 0.45) : 0;
  a.belly = grown && r.chance(old ? 0.35 : mature ? 0.3 : 0.08) ? r.range(0.35, 1.0) * (0.6 + 0.4 * Math.max(0, a.build)) : 0;
  // children have relatively bigger heads the younger (shorter) they are
  // (relative to the body mesh's own head: younger, shorter children have relatively bigger heads)
  a.headScale = (body === 'kid' ? Math.pow(1.10 / height, 0.5) : body === 'child' ? Math.pow(1.36 / height, 0.45)
    : age === 'teen' ? Math.pow((female ? 1.63 : 1.76) / height, 0.35) : 1) * r.range(0.97, 1.03);
  a.skirtFolds = r.int(6, 9);
  if (a.shoeType === SHOE.SANDAL) a.sole = srgb('#3a2c22');
  else if (a.shoeType === SHOE.LEATHER) a.sole = srgb('#2a2220');
  else if (a.shoeType === SHOE.FLAT) a.sole = a.shoes.clone().multiplyScalar(0.7);
  return a;
}

/** Writes one appearance into the float row of the look texture (ROW_TEXELS RGBA texels). */
export function writeRow(data, row, a) {
  const o = row * ROW_TEXELS * 4;
  const put = (i, c, w) => { data[o + i * 4] = c.r; data[o + i * 4 + 1] = c.g; data[o + i * 4 + 2] = c.b; data[o + i * 4 + 3] = w; };
  const put4 = (i, x, y, z, w) => { data[o + i * 4] = x; data[o + i * 4 + 1] = y; data[o + i * 4 + 2] = z; data[o + i * 4 + 3] = w; };
  put(0, a.skin, a.build);
  put(1, a.hair, a.beardAmt);
  put(2, a.top, a.topType);
  put(3, a.top2, a.pattern);
  put(4, a.bottom, a.bottomType);
  put(5, a.shoes, a.shoeType);
  put(6, a.bag, a.glasses);
  put(7, a.hat, a.kippah);
  put4(8, a.sleeve, a.topHem, a.hem, a.loose);
  put4(9, a.looseB, a.skirtLen, a.skirtFlare, a.wear);
  put(10, a.sole, a.fabricTop + a.fabricBottom * 8);
  put4(11, a.hairPart, a.beardPart, a.hatPart, a.bagPart + a.skirtPart * 256);
  put4(12, a.faceA, a.faceB, a.faceOld, a.belly);
  put4(13, a.headScale, a.skirtFolds, a.topHem >= 0.45 ? 1 : 0, 0);
}
