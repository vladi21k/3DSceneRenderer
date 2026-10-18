import * as THREE from 'three';
import { RNG } from '../../../core/rng.js';

// "Who is this person" for the MakeHuman-based cast (assets/humans_mh): the crowd's integer appearance
// seed picks one of the cast's characters (by age class and sex, in street proportions) and varies it:
// garment colours from summer street palettes (regions tinted at runtime), hair shade, skin brightness and
// a small height scale. Deterministic: the same seed always gives the same person.
//
//   castAppearance(seed, cast) -> { index, char, scale, height, tints: {region: [r, g, b] linear},
//                                   kind, senior, skirt, longSkirt, seedT }
//   castToddler(seed, cast)    -> the same for a child riding in a stroller (toddler characters)

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
// hair shades by family (dark / brown / fair / grey): a person keeps the family of the character's hair
const HAIR = {
  dark: P(['#141110', '#1c1511', '#2a1d15']),
  brown: P(['#2a1d15', '#3d2a1b', '#45301f', '#5a3a22', '#6b3420']),
  fair: P(['#7d5c3c', '#8c7f6c', '#a68a5c', '#b8a07a']),
  grey: P(['#5c5955', '#8d8a85', '#a8a49d', '#bdb8b0', '#d9d6d0']),
};

const CLASS_W = [['child', 10], ['teen', 9], ['adult', 66], ['old', 15]];

const isDress = (char) => {
  const o = char.outfit;
  return !!(o.top && o.bottom && o.top.suit === 'female_elegantsuit01' && o.bottom.suit === o.top.suit &&
    char.tints.top.every((x, i) => Math.abs(x - char.tints.bottom[i]) < 1e-4));
};

function garmentPalette(g, region, char) {
  if (!g) return null;
  const s = g.suit;
  if (s === 'male_elegantsuit01') return null;                     // black suits keep their colours
  const kid = char.ageClass === 'child' || char.ageClass === 'toddler';
  if (region === 'top') {
    if (isDress(char)) return DRESS;
    if (kid) return KIDS;
    if (s === 'male_casualsuit05') return JACKET;
    if (s === 'male_casualsuit01' || s === 'male_casualsuit03') return SHIRT;
    if (s === 'female_elegantsuit01') return BLOUSE;
    return TEE;
  }
  if (s === 'female_elegantsuit01') return g.cut === 'skirt' && (g.length ?? 0) > 0.5 ? SKIRT_LONG : SKIRT;
  if (s === 'female_sportsuit01') return LEGGINGS;
  if (g.cut === 'leg') return SHORTS;
  return char.ageClass === 'old' ? TROUSERS : JEANS;
}

function hairFamily(t) {
  const l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  const sat = Math.max(...t) - Math.min(...t);
  if (sat < 0.12 * Math.max(...t) && l > 0.05) return 'grey';
  return l < 0.012 ? 'dark' : l < 0.06 ? 'brown' : 'fair';
}

function vary(r, char, isToddler) {
  const t = {};
  for (const [k, v] of Object.entries(char.tints)) t[k] = v.slice();
  const o = char.outfit;
  // garments: keep the character's own colour now and then, otherwise a palette colour, slightly jittered
  for (const region of ['top', 'bottom']) {
    const pal = garmentPalette(o[region], region, char);
    if (!pal || r.chance(0.3)) continue;
    const j = r.range(0.92, 1.06);
    t[region] = r.weighted(pal).map((x) => x * j);
  }
  if (isDress(char)) t.bottom = t.top.slice();                    // a dress is one colour top to bottom
  if (o.top && o.top.suit === 'male_casualsuit05') t.top2 = r.weighted(SHIRT).slice();
  else if (o.top && o.top.suit !== 'male_elegantsuit01') t.top2 = t.top.slice();
  // hair: another shade of the same family; brows and beard follow
  if (r.chance(0.7)) {
    const h = r.weighted(HAIR[hairFamily(char.tints.hair)]);
    t.hair = h.slice();
    t.brows = h.map((x) => x * 0.75);
    t.beard = h.map((x) => x * 0.95);
  }
  const sk = r.range(0.95, 1.05);                                  // skin brightness +-5 %
  t.skin = t.skin.map((x) => x * sk);
  if (isToddler && r.chance(0.6)) t.top = r.weighted(KIDS).slice();
  return t;
}

function finish(seed, r, cast, index) {
  const char = cast.chars ? cast.chars[index] : cast.doc.characters[index];
  const scale = 1 + THREE.MathUtils.clamp(r.normal(0, char.ageClass === 'child' ? 0.03 : 0.022), -0.05, 0.05);
  const tints = vary(r, char, char.ageClass === 'toddler');
  const bot = char.outfit.bottom;
  const skirt = !!bot && bot.suit === 'female_elegantsuit01';
  return {
    seed, index, char, scale, height: char.height * scale, tints,
    kind: char.kind, senior: char.ageClass === 'old', skirt, longSkirt: skirt && bot.cut === 'skirt' && (bot.length ?? 0) > 0.5,
    seedT: ((seed >>> 0) % 997) / 997,
  };
}

/** A person of the street crowd (no toddlers: they ride in strollers). */
export function castAppearance(seed, cast) {
  const chars = cast.chars || cast.doc.characters;
  const r = new RNG((seed >>> 0) ^ 0x3c6ef372);
  const cls = r.weighted(CLASS_W);
  const sex = r.chance(0.5) ? 'f' : 'm';
  let pool = [];
  chars.forEach((c, i) => { if (c.ageClass === cls && c.sex === sex) pool.push(i); });
  if (!pool.length) chars.forEach((c, i) => { if (c.ageClass === cls) pool.push(i); });
  if (!pool.length) chars.forEach((c, i) => { if (c.ageClass !== 'toddler') pool.push(i); });
  return finish(seed, r, cast, pool[Math.floor(r.next() * pool.length)]);
}

/** A toddler riding in a stroller (seed: from the stroller's prop seed). */
export function castToddler(seed, cast) {
  const chars = cast.chars || cast.doc.characters;
  const r = new RNG((seed >>> 0) ^ 0x2c1b3a6f);
  const pool = [];
  chars.forEach((c, i) => { if (c.ageClass === 'toddler') pool.push(i); });
  if (!pool.length) return null;
  return finish(seed, r, cast, pool[Math.floor(r.next() * pool.length)]);
}
