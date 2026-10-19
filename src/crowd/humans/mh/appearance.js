import * as THREE from 'three';
import { RNG } from '../../../core/rng.js';

// "Who is this person": the crowd's integer appearance seed picks one character of the cast
// (assets/humans_mh) by age class and sex, in street proportions, and varies it: garment colours
// from summer street palettes (the garment regions are tinted at runtime) with an occasional stripe,
// check or print, hair shade, skin brightness, a small height scale, a bag, and how the person
// stands, sits and walks. Deterministic: the same seed always gives the same person.
//
//   castAppearance(seed, cast) -> appearance (fields below)
//   castToddler(seed, cast, lying) -> a child riding in a stroller (toddler characters)
//
// Fields read by the crowd (population.js roleFits / alloc): age ('child' | 'teen' | 'adult' | 'old'),
// base ('male' | 'female' | 'child'), height, carry, phoneWalk, walkOld, skirtPart, sit.
// Fields read by the renderer: index (character), body (character id), scale, tints (Float32Array,
// REGION_COUNT x rgb, linear), pattern, bag, idle, sit, gait, stoop, longSkirt, seedT, faceK / ageF / moleSeed /
// lineK (the person's face), glasses / frameTone.

export const REGION_COUNT = 16;
// regions of the cast (cast.json regions) plus the runtime accessories (mh/parts.js)
export const REGION = { skin: 0, hair: 1, brows: 2, lashes: 3, eyes: 4, top: 5, top2: 6, bottom: 7, shoes: 8, socks: 9,
  hat: 10, beard: 11, prop: 12, screen: 13, bag: 14, strap: 15 };
export const BAG = { NONE: 0, BACKPACK: 1, SHOULDER: 2, SHOPPING: 3 };
export const PATTERN = { SOLID: 0, STRIPES: 1, CHECK: 2, PRINT: 3, PINSTRIPE: 4 };

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };   // sRGB hex -> linear
const P = (list) => list.map((x) => (Array.isArray(x) ? [lin(x[0]), x[1]] : [lin(x), 1]));

const TEE = P([['#f2f1ec', 16], ['#16171a', 12], ['#2a3346', 7], ['#8c9196', 6], ['#b9bcbd', 4], ['#8fb6d9', 6],
  ['#4f7fb4', 4], ['#3e8a4e', 5], ['#79b83a', 3], ['#c8352b', 4], ['#e9802a', 4], ['#e6c43a', 3],
  ['#6b6f3a', 4], ['#7a2534', 3], ['#2f8c8c', 3], ['#e7a3b8', 3], ['#9b6fb8', 2], ['#d9cdb0', 4]]);
const SHIRT = P([['#f4f4f1', 14], ['#bcd3ea', 12], ['#9dbbd9', 6], ['#e8e2d4', 5], ['#f2d4d6', 3],
  ['#3d5a80', 3], ['#2e2e33', 3], ['#c9d8c0', 3], ['#e9e3c9', 3]]);
const BLOUSE = P([['#f6f3ee', 12], ['#121214', 6], ['#e7b9c5', 4], ['#a9c9e4', 6], ['#f2d36b', 3], ['#e7e0cf', 5],
  ['#c94a3a', 3], ['#5fa58f', 3], ['#2c3f6b', 4], ['#d98a3d', 3], ['#b296c9', 2]]);
const DRESS = P([['#2a4a7a', 5], ['#f1eee6', 5], ['#141416', 6], ['#c23b3b', 3], ['#6aa4c8', 4], ['#e9c94e', 2],
  ['#4e7f4a', 3], ['#d7a1b6', 3], ['#e6dcc6', 3], ['#8a3a52', 2], ['#3a8a8a', 2]]);
const JACKET = P([['#6b6f6a', 4], ['#2b2f38', 4], ['#5b5348', 3], ['#3b4a5c', 3], ['#8a7f6a', 2]]);
const JEANS = P([['#2f4a6e', 10], ['#3e5f88', 9], ['#5679a3', 6], ['#7f9cbe', 4], ['#1d2737', 6], ['#2b2c30', 3]]);
const TROUSERS = P([['#141416', 12], ['#2b2f38', 6], ['#5b5d61', 5], ['#c2b391', 7], ['#a8956c', 4], ['#e9e3d3', 3],
  ['#25324a', 5], ['#6b6750', 3]]);
const SHORTS = P([['#c2b18b', 10], ['#a39066', 5], ['#25324a', 6], ['#4a6f96', 6], ['#6f7377', 4], ['#576042', 4],
  ['#141416', 4], ['#e7e2d4', 2], ['#8d2f30', 2]]);
const SKIRT = P([['#141416', 8], ['#25324a', 7], ['#5d6066', 4], ['#4a6f96', 4], ['#c7b48f', 3], ['#9b3238', 2],
  ['#3f5f42', 2], ['#e8e2d4', 2], ['#6f4a6b', 2]]);
const SKIRT_LONG = P([['#141416', 10], ['#1f2a44', 9], ['#3b3f47', 5], ['#4a6f96', 4], ['#6b5a4a', 3], ['#535a4c', 2]]);
const LEGGINGS = P([['#121214', 6], ['#2b2c30', 2], ['#25324a', 1]]);
const KIDS = P([['#f4f2ec', 8], ['#bcd6ee', 5], ['#f6c3cf', 5], ['#f3df8f', 4], ['#c4e2b6', 4], ['#e9813c', 2],
  ['#5b8fd0', 3], ['#d8434a', 2], ['#9fd2d0', 2], ['#c5b3dd', 2]]);
const BAGS = P([['#18181a', 12], ['#3b2a20', 6], ['#5a3b24', 5], ['#5d6b52', 3], ['#2c3e5e', 4], ['#8a8f96', 3],
  ['#b2342e', 2], ['#d9c8a8', 3], ['#e57b2c', 1]]);
const PACKS = P([['#18181a', 10], ['#2c3e5e', 5], ['#5d6b52', 3], ['#8a8f96', 3], ['#b2342e', 2], ['#3b4a5c', 3],
  ['#e9802a', 1], ['#d9c8a8', 2]]);
const SHOPPING = P([['#e87b2a', 3], ['#f4f2ee', 5], ['#3a7bc0', 2], ['#d2302a', 2], ['#3c8a46', 1], ['#c9b48d', 3]]);
const PHONES = P([['#151517', 10], ['#e9e9e6', 3], ['#3a4a5e', 2], ['#c9b8a8', 2]]);
// hair shades by family (dark / brown / fair / grey): a person keeps the family of the character's hair
const HAIR = {
  dark: P(['#141110', '#1c1511', '#2a1d15']),
  brown: P(['#2a1d15', '#3d2a1b', '#45301f', '#5a3a22', '#6b3420']),
  fair: P(['#7d5c3c', '#8c7f6c', '#a68a5c', '#b8a07a']),
  grey: P(['#5c5955', '#8d8a85', '#a8a49d', '#bdb8b0', '#d9d6d0']),
};

const CLASS_W = [['child', 10], ['teen', 9], ['adult', 66], ['old', 15]];
// iris colours (sRGB): the street's crowd is mostly brown-eyed (dark brown ~65 %, hazel / green ~20 %,
// blue / grey ~15 %; almost all brown for African and East Asian faces)
const IRIS = {
  brown: P([['#3d2416', 4], ['#4e2f1b', 5], ['#5e3a20', 4], ['#6e4628', 2]]),
  hazel: P([['#7a6030', 3], ['#6b6a36', 2], ['#5d6a3d', 2], ['#8a6a34', 2]]),
  light: P([['#6a88a2', 3], ['#7d93a6', 2], ['#8d9aa0', 2], ['#5a7892', 2]]),
};
// shoe tints (multiplied with the shoe's own colours): sneakers come in many colours, leather a few shades
const SNEAKER_TINT = P([['#ffffff', 9], ['#c8c8c4', 3], ['#e9dcc4', 2], ['#3a3a3c', 3], ['#2b3550', 2], ['#7f8a96', 2], ['#b85a4a', 1]]);
const LEATHER_TINT = P([['#ffffff', 6], ['#d9c2a8', 2], ['#8a7a6a', 2], ['#5a4a40', 1]]);

const isDress = (char) => {
  const o = char.outfit;
  return !!(o.top && o.bottom && o.top.suit === 'female_elegantsuit01' && o.bottom.suit === o.top.suit &&
    char.tints.top.every((x, i) => Math.abs(x - char.tints.bottom[i]) < 1e-4));
};
const suitOf = (char, part) => (char.outfit[part] ? char.outfit[part].suit : '');

/** Garment kind of the character's top: tee | shirt | blouse | jacket | suit | dress | crop. */
function topKind(char) {
  const s = suitOf(char, 'top');
  if (s === 'male_elegantsuit01') return 'suit';
  if (isDress(char)) return 'dress';
  if (s === 'male_casualsuit05') return 'jacket';
  if (s === 'male_casualsuit01' || s === 'male_casualsuit03') return 'shirt';
  if (s === 'female_elegantsuit01') return 'blouse';
  return 'tee';
}

function garmentPalette(g, region, char) {
  if (!g) return null;
  const s = g.suit;
  if (s === 'male_elegantsuit01') return null;                     // black suits keep their colours
  const kid = char.ageClass === 'child' || char.ageClass === 'toddler';
  if (region === 'top') {
    const k = topKind(char);
    if (k === 'dress') return DRESS;
    if (kid) return KIDS;
    return k === 'jacket' ? JACKET : k === 'shirt' ? SHIRT : k === 'blouse' ? BLOUSE : TEE;
  }
  if (s === 'female_elegantsuit01') return g.cut === 'skirt' && (g.length ?? 0) > 0.5 ? SKIRT_LONG : SKIRT;
  if (s === 'female_sportsuit01') return LEGGINGS;
  if (g.cut === 'leg') return SHORTS;
  return char.ageClass === 'old' ? TROUSERS : JEANS;
}

function hairFamily(t) {
  const l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  const mx = Math.max(...t), mn = Math.min(...t);
  if (mx - mn < 0.12 * mx && l > 0.05) return 'grey';
  return l < 0.012 ? 'dark' : l < 0.06 ? 'brown' : 'fair';
}

function vary(r, char, kidTop) {
  const t = {};
  for (const [k, v] of Object.entries(char.tints)) t[k] = v.slice();
  const o = char.outfit;
  // garments: keep the character's own colour now and then, otherwise a palette colour, slightly jittered
  for (const region of ['top', 'bottom']) {
    const pal = garmentPalette(o[region], region, char);
    if (!pal || r.chance(0.1)) continue;
    const j = r.range(0.92, 1.06);
    t[region] = r.weighted(pal).map((x) => x * j);
  }
  if (isDress(char)) t.bottom = t.top.slice();                    // a dress is one colour top to bottom
  if (suitOf(char, 'top') === 'male_casualsuit05') t.top2 = r.weighted(SHIRT).slice();
  else if (suitOf(char, 'top') !== 'male_elegantsuit01') t.top2 = t.top.slice();
  // hair: another shade of the same family; brows and beard follow
  if (char.tints.hair && r.chance(0.85)) {
    const h = r.weighted(HAIR[hairFamily(char.tints.hair)]);
    t.hair = h.slice();
    t.brows = h.map((x) => x * 0.95);
    t.beard = h.map((x) => x * 0.95);
  }
  // brows: most of the hair's colour with a warm brown, never pure black (a black stroke reads as marker)
  if (t.hair) {
    const BR = [0.075, 0.05, 0.036];
    t.brows = t.hair.map((x, i) => Math.max(0.011, x * 0.7 + BR[i] * 0.3));
  }
  const sk = r.range(0.95, 1.05);                                  // skin brightness +-5 %
  const hue = r.range(-0.035, 0.035);                              // and a little warmer / cooler
  t.skin = (t.skin || [1, 1, 1]).map((x, i) => x * sk * (i === 0 ? 1 + hue : i === 2 ? 1 - hue : 1));
  if (kidTop && r.chance(0.6)) t.top = r.weighted(KIDS).slice();
  return t;
}

/** Does a garment colour (linear) read as denim (blue or washed black)? Other colours get a calmer
 *  cloth detail (no fading, whiskers or worn patches). */
function denimLike(c) {
  const [r, g, b] = c, l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (b > r * 1.3 && b >= g && l < 0.3) || (l < 0.02 && b >= r * 0.9);
}
const DENIM_SUITS = new Set(['male_casualsuit01', 'male_casualsuit02', 'male_casualsuit03', 'male_casualsuit04', 'male_casualsuit05',
  'male_casualsuit06', 'female_casualsuit01', 'female_casualsuit02']);
const BEARD_DENS = { stubble: 0.55, short: 0.85, full: 1 };

function packTints(t) {
  const out = new Float32Array(REGION_COUNT * 3).fill(1);
  // grey beards read as salt and pepper (dark strands between the grey), never a pale mask
  if (t.beard) {
    const l = 0.2126 * t.beard[0] + 0.7152 * t.beard[1] + 0.0722 * t.beard[2];
    if (l > 0.16) t.beard = t.beard.map((x) => x * (0.16 / l));
    // (and a black beard is a very dark brown, so its strands and volume still shade)
    else if (l < 0.02) t.beard = t.beard.map((x) => x * (0.02 / Math.max(l, 1e-4)));
  }
  // black hair: very dark brown, never an ink-black helmet
  if (t.hair) {
    const l = 0.2126 * t.hair[0] + 0.7152 * t.hair[1] + 0.0722 * t.hair[2];
    if (l < 0.011) t.hair = t.hair.map((x) => x * (0.011 / Math.max(l, 1e-4)));
  }
  for (const [name, id] of Object.entries(REGION)) {
    const c = t[name];
    if (c) { out[id * 3] = c[0]; out[id * 3 + 1] = c[1]; out[id * 3 + 2] = c[2]; }
  }
  return out;
}

function charsOf(cast) { return cast.chars || cast.doc.characters; }

/** The person: character `index` varied by the rest of r's stream. */
function finish(seed, r, cast, index, toddler = false) {
  const char = charsOf(cast)[index];
  const cls = char.ageClass;
  const female = char.sex === 'f';
  const scale = 1 + THREE.MathUtils.clamp(r.normal(0, cls === 'child' ? 0.03 : 0.022), -0.05, 0.05);
  const t = vary(r, char, cls === 'toddler' || cls === 'child');
  const bot = char.outfit.bottom;
  const skirt = !!bot && bot.suit === 'female_elegantsuit01' && (bot.cut === 'skirt' || !bot.cut);
  const longSkirt = skirt && bot.cut === 'skirt' && (bot.length ?? 0) > 0.5;
  const kind = topKind(char);
  const old = cls === 'old', teen = cls === 'teen', adult = cls === 'adult', child = cls === 'child';
  const suit = kind === 'suit';
  // top patterns (in the garment's rest space): stripes on tees, checks and pinstripes on shirts,
  // small prints on blouses and dresses
  let pattern = PATTERN.SOLID, patScale = 1, patColor = [1, 1, 1];
  if (!suit) {
    const p = kind === 'tee' ? (child ? 0.3 : 0.16) : kind === 'shirt' ? 0.3 : kind === 'blouse' || kind === 'dress' ? 0.25 : 0;
    if (r.chance(p)) {
      pattern = kind === 'tee' ? PATTERN.STRIPES : kind === 'shirt' ? (r.chance(0.6) ? PATTERN.CHECK : PATTERN.PINSTRIPE) : PATTERN.PRINT;
      patScale = r.range(0.7, 1.5);
      const base = t.top;
      const lum = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2];
      patColor = r.chance(0.6) ? (lum > 0.3 ? [0.02, 0.025, 0.04].map((x) => x * r.range(0.6, 3)) : [0.85, 0.84, 0.8])
        : r.weighted(kind === 'tee' ? TEE : BLOUSE).slice();
    }
  }
  t.pattern = patColor;
  // bag
  let bag = BAG.NONE;
  if (!toddler && !suit) {
    bag = child ? r.weighted([[BAG.NONE, 70], [BAG.BACKPACK, 30]])
      : r.weighted([[BAG.NONE, female ? 46 : 64], [BAG.BACKPACK, teen ? 32 : old ? 2 : 12], [BAG.SHOULDER, female ? 32 : 8],
        [BAG.SHOPPING, old ? 14 : 6]]);
  }
  t.bag = r.weighted(bag === BAG.SHOPPING ? SHOPPING : bag === BAG.BACKPACK ? PACKS : BAGS).slice();
  t.strap = bag === BAG.SHOPPING ? t.bag.map((x) => x * 0.8) : t.bag.map((x) => x * 0.55);
  t.prop = r.weighted(PHONES).slice();
  t.screen = [1, 1, 1];
  // eyes: the iris colour (drawn over the eye texture's own)
  const anc = char.anc || [1, 0, 0];
  const dark = anc[1] > 0.5 || anc[2] > 0.5 || char.tone === 'brown' || char.tone === 'deep';
  const ik = r.weighted(dark ? [['brown', 96], ['hazel', 4]] : [['brown', 62], ['hazel', 22], ['light', 16]]);
  t.eyes = r.weighted(IRIS[ik]).map((x) => x * r.range(0.9, 1.1));
  // shoes: another colour of the same model now and then
  const sneaker = ['shoes02', 'shoes05', 'shoes06'].includes(char.outfit.shoes);
  t.shoes = r.chance(sneaker ? 0.6 : 0.4) ? r.weighted(sneaker ? SNEAKER_TINT : LEATHER_TINT).slice() : [1, 1, 1];
  // denim bottoms in a non-denim colour (chinos, khaki shorts): calm detail
  const botSuit = bot ? bot.suit : '';
  const detailBottom = DENIM_SUITS.has(botSuit) && t.bottom && !denimLike(t.bottom) ? 0.32 : 0;
  // beard growth: stubble varies from a shadow to a few days' growth
  const bk = char.outfit.beard;
  const beardDens = bk ? (bk === 'stubble' ? r.range(0.4, 0.7) : BEARD_DENS[bk] || 0.85) : 0;
  // how this person stands, walks and sits
  const carry = bag === BAG.SHOPPING;
  const walkOld = old && r.chance(0.3);
  // (talking, idle 6, is for people the crowd pairs up with a partner: set() field idle)
  const idle = toddler ? 0 : child ? r.weighted([[0, 55], [7, 40], [2, 5]])
    : old ? r.weighted([[0, 32], [2, 16], [5, female ? 6 : 30], [7, 20], [3, female ? 0 : 5], [4, female ? 8 : 0]])
      : r.weighted([[0, 28], [1, teen ? 26 : 16], [2, 12], [3, skirt ? 0 : 11], [4, female ? 13 : 4], [5, adult && !female ? 4 : 0],
        [7, 16]]);
  let sit = toddler ? 3 : child ? r.weighted([[0, 5], [2, 3], [7, 3]])
    : r.weighted([[0, 22], [1, longSkirt ? 0 : 14], [2, 14], [5, teen ? 30 : 18], [6, 16], [7, 16]]);
  const phoneWalk = !carry && (adult || teen) && r.chance(teen ? 0.22 : 0.1);
  const fv = faceVariety(seed, char);
  const a = {
    seed, index, body: char.id, char, age: cls === 'toddler' ? 'toddler' : cls, female,
    // the person's own face (mh/shading.js hFaceWarp: nose, jaw, chin, cheeks, lower face, brows, lips, face
    // width, eye spacing; then redness and freckles) and age lines
    faceK: fv.k, ageF: fv.age, moleSeed: fv.mole, lineK: fv.line,
    // glasses: 0 none, 1 sunglasses (by day), 2 a thin frame; frame tone 0 black .. 1 tortoiseshell
    glasses: toddler ? 0 : fv.glasses, frameTone: fv.frame,
    base: child ? 'child' : cls === 'toddler' ? 'toddler' : female ? 'female' : 'male',
    kind: char.kind, scale, height: char.height * scale,
    tints: packTints(t), pattern, patScale, patColor,
    bag, carry, walkOld, gait: walkOld ? 2 : old ? 1 : 0,
    // forward stoop of the upper back (radians) carried into every pose
    stoop: old ? (walkOld ? r.range(0.10, 0.2) : r.range(0.03, 0.11)) : adult ? r.range(0, 0.03) : 0,
    idle: phoneWalk ? 1 : carry && (idle === 1 || idle === 2 || idle === 4 || idle === 5) ? 0 : idle,
    sit, phoneWalk, skirtPart: skirt ? 1 : 0, longSkirt,
    hatPart: char.outfit.hat ? 1 : 0, beardPart: char.outfit.beard ? 1 : 0, hairPart: char.outfit.hair || '',
    topKind: kind, suit,
    // (idle and sitting cycles start at a phase of their own: neighbours never move in unison)
    build: buildOf(char), seedT: (Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 8) / 16777216,
    detailBottom, detailTop: 0, beardDens,
    // the iris is drawn in t.eyes; eyebrows' opacity on the skin (men fuller, children and the elderly
    // lighter, grey brows lighter still)
    irisOn: true,
    browOpacity: (child || cls === 'toddler' ? 0.55 : old ? 0.66 : teen ? 0.76 : female ? 0.84 : 0.94) *
      (t.hair && 0.2126 * t.hair[0] + 0.7152 * t.hair[1] + 0.0722 * t.hair[2] > 0.12 ? 0.75 : 1),
  };
  return a;
}

/**
 * Per-person face variety, from its own stream of the seed (so the rest of the appearance is unchanged):
 * shape coefficients -1..1 (children's faces vary less), redness and freckles 0..1, the age lines'
 * strength from the character's age with a personal spread, a seed for moles.
 */
function faceVariety(seed, char) {
  const r = new RNG((seed >>> 0) ^ 0x68e31da4);
  const kid = char.ageClass === 'child' || char.ageClass === 'toddler';
  const amp = kid ? 0.55 : 1.0;
  const k = new Float32Array(12);
  for (let i = 0; i < 10; i++) k[i] = THREE.MathUtils.clamp(r.normal(0, 0.62), -1, 1) * amp;
  const anc = char.anc || [1, 0, 0];
  const light = anc[0] > 0.7 && (char.tone === 'fair' || char.tone === 'base' || !char.tone);
  k[10] = THREE.MathUtils.clamp(r.normal(light ? 0.5 : 0.3, 0.22), 0, 1);
  k[11] = light && r.chance(kid ? 0.35 : 0.18) ? r.range(0.3, 1) : 0;
  const y = char.age || 30;
  // (the elderly characters' own skin textures are lined already: less on top of them)
  const age = kid ? 0 : THREE.MathUtils.clamp(((y - 26) / 36) * (y >= 60 ? 0.55 : 1) + r.normal(0, 0.08), 0, 1);
  const mole = r.next() * 997, line = r.range(0.7, 1.3);
  // glasses (a summer street: many sunglasses; spectacles more often with age)
  const cls = char.ageClass;
  const pSun = cls === 'child' ? 0.05 : cls === 'old' ? 0.14 : cls === 'teen' ? 0.16 : 0.22;
  const pClear = cls === 'child' ? 0.04 : cls === 'old' ? 0.34 : cls === 'teen' ? 0.08 : 0.11;
  const g = r.next();
  const glasses = g < pSun ? 1 : g < pSun + pClear ? 2 : 0;
  return { k, age, mole, line, glasses, frame: r.chance(0.3) ? r.range(0.5, 1) : r.range(0, 0.15) };
}

/** Rough build of a character from its waist girth relative to its height (< 0 slim, > 0 heavy). */
function buildOf(char) {
  const h = char.info && char.info.hang;
  if (!h) return 0;
  return THREE.MathUtils.clamp((h[1][1] / char.height - 0.085) / 0.025, -0.6, 1.4);
}

/** How often a character turns up (ancestry / skin tone mix of the street crowd). */
function mixWeight(c) {
  const anc = c.anc || [1, 0, 0];
  if (anc[1] > 0.5) return 0.45;
  if (c.tone === 'brown' || c.tone === 'deep') return 0.7;
  return 1;
}

/** A person of the street crowd (no toddlers: they ride in strollers). */
export function castAppearance(seed, cast) {
  const chars = charsOf(cast);
  const r = new RNG((seed >>> 0) ^ 0x3c6ef372);
  const cls = r.weighted(CLASS_W);
  const sex = r.chance(0.5) ? 'f' : 'm';
  let pool = [];
  chars.forEach((c, i) => { if (c.ageClass === cls && c.sex === sex) pool.push(i); });
  if (!pool.length) chars.forEach((c, i) => { if (c.ageClass === cls) pool.push(i); });
  if (!pool.length) chars.forEach((c, i) => { if (c.ageClass !== 'toddler') pool.push(i); });
  // the street's crowd is mostly light and olive Mediterranean / Middle-Eastern skin; darker skin is
  // there, less often
  const w = pool.map((i) => [i, mixWeight(chars[i])]);
  return finish(seed, r, cast, r.weighted(w));
}

/** A toddler riding in a stroller (seed: from the stroller's prop seed); lying: a baby in a pram
 *  (the toddler drawn smaller). */
export function castToddler(seed, cast, lying = false) {
  const chars = charsOf(cast);
  const r = new RNG((seed >>> 0) ^ 0x2c1b3a6f);
  const pool = [];
  chars.forEach((c, i) => { if (c.ageClass === 'toddler') pool.push(i); });
  if (!pool.length) return null;
  const a = finish(seed, r, cast, pool[Math.floor(r.next() * pool.length)], true);
  a.sit = lying ? 4 : 3;
  if (lying) { a.scale *= 0.74; a.height = a.char.height * a.scale; }
  return a;
}

// café staff (set() field outfit: 'waiter'): a white or light shirt, dark trousers, a long waist apron
const WAITER_SHIRT = P([['#f4f4f1', 12], ['#ecebe6', 5], ['#e3e8ee', 2], ['#efeadf', 2]]);
const WAITER_TROUSERS = P([['#141416', 9], ['#1c1e23', 4], ['#232a3a', 2]]);
const APRON = P([['#121214', 12], ['#2b1f18', 3], ['#1e2a22', 2], ['#3a1a20', 2], ['#e9e6df', 1]]);
const WAITER_SHOES = P([['#3a3a3c', 3], ['#2a2a2c', 2]]);

/** Can this character be dressed as a waiter (an adult in a shirt, blouse or tee over long trousers)? */
export function waiterFits(char) {
  if (char.ageClass !== 'adult' || !char.outfit || !char.outfit.top || !char.outfit.bottom || char.outfit.hat) return false;
  const k = topKind(char);
  if (k !== 'shirt' && k !== 'tee' && k !== 'blouse') return false;
  // (never a crop-length sports top: an apron under a bare midriff)
  if (char.outfit.top.suit === 'female_sportsuit01') return false;
  const b = char.outfit.bottom;
  return b.cut !== 'leg' && b.cut !== 'skirt' && b.suit !== 'female_elegantsuit01' && b.suit !== 'female_casualsuit02';
}

/**
 * A café waiter for appearance seed `seed`: the seed's own person when the character can wear the
 * outfit, else a character of the same sex that can (nearest in height, drawn at the seed's height
 * within +-10 %), in a white or light plain shirt, dark trousers, dark shoes and a long waist apron
 * (flag apron: the renderer draws the character's apron part; its colour is the socks region's tint),
 * no bag or phone, standing relaxed or with the hands behind the back.
 */
export function castWaiter(seed, cast) {
  const chars = charsOf(cast);
  const base = castAppearance(seed, cast);
  let index = base.index;
  if (!waiterFits(chars[index])) {
    const sex = chars[index].sex;
    let pool = [];
    chars.forEach((c, i) => { if (waiterFits(c) && c.sex === sex) pool.push(i); });
    if (!pool.length) chars.forEach((c, i) => { if (waiterFits(c)) pool.push(i); });
    if (!pool.length) return base;
    pool = pool.sort((x, y) => Math.abs(chars[x].height - base.height) - Math.abs(chars[y].height - base.height) || x - y).slice(0, 3);
    index = pool[(Math.imul((seed >>> 0) ^ 0x7f4a7c15, 0x2c1b3c6d) >>> 16) % pool.length];
  }
  const r = new RNG((seed >>> 0) ^ 0x51ed270b);
  const a = finish(seed, r, cast, index);
  const char = a.char;
  a.scale = THREE.MathUtils.clamp(base.height / char.height, 0.9, 1.1);
  a.height = char.height * a.scale;
  const T = a.tints;
  const put = (reg, c) => { T[reg * 3] = c[0]; T[reg * 3 + 1] = c[1]; T[reg * 3 + 2] = c[2]; };
  const shirt = r.weighted(WAITER_SHIRT), trousers = r.weighted(WAITER_TROUSERS);
  put(REGION.top, shirt); put(REGION.top2, shirt);
  put(REGION.bottom, trousers);
  put(REGION.socks, r.weighted(APRON));
  // (dark shoes: sneakers tinted down to charcoal, leather mostly black)
  const sneaker = ['shoes02', 'shoes05', 'shoes06'].includes(char.outfit.shoes);
  if (sneaker || r.chance(0.6)) put(REGION.shoes, r.weighted(WAITER_SHOES));
  a.pattern = PATTERN.SOLID; a.patScale = 1; a.patColor = [1, 1, 1];
  a.bag = BAG.NONE; a.carry = false; a.phoneWalk = false; a.walkOld = false;
  a.idle = r.weighted([[0, 40], [5, 35], [2, 10], [7, 15]]);
  // (plain pressed cloth: no denim fading on the trousers)
  a.detailBottom = 0.25; a.detailTop = 0.4;
  a.apron = true;
  a.waiter = true;
  if (a.glasses === 1) a.glasses = 0;        // (staff serve without sunglasses)
  return a;
}

/** Testing: character `index` itself (own: with its own colours), varied by the seed otherwise. */
export function castCharacter(seed, cast, index, own = false) {
  const r = new RNG((seed >>> 0) ^ 0x1b873593);
  const a = finish(seed, r, cast, index, charsOf(cast)[index].ageClass === 'toddler');
  if (own) {
    const char = a.char;
    const t = {};
    for (const [k, v] of Object.entries(char.tints)) t[k] = v.slice();
    t.bag = [0.05, 0.05, 0.06]; t.strap = [0.03, 0.03, 0.03]; t.prop = [0.02, 0.02, 0.02]; t.screen = [1, 1, 1];
    a.tints = packTints(t);
    a.irisOn = false;
    a.pattern = 0; a.scale = 1; a.height = char.height;
  }
  return a;
}
