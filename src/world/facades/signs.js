import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { RNG } from '../../core/rng.js';
import { Tpl, lin } from './geo.js';
import { SHOP_LEVEL } from './interior.js';

// Shop signage: a canvas atlas of invented shop names (a Hebrew name over its English
// transliteration, each name in its own lettering), trade words (English and Hebrew),
// short lines (phone numbers, "since 19xx", taglines), logo marks, house number plaques,
// blade-sign faces and the shop window dressing (sale posters, price cards, door
// stickers), plus the geometry for fascia boards, light boxes, individual letters,
// projecting blades and discs and the cards stuck to the glass. A shop's sign is composed
// of its name, often a smaller second line (its trade, a phone number or a tagline) and
// now and then a logo mark; the boards fade, collect grime along their lower edge and hang
// a little out of true. Text quads are white glyphs tinted by vertex colour (full-colour
// cells take white); `aGlow` makes light boxes and neon letters glow at dusk.

const W = 2048, H = 8192;
const NAMES_Y = 6144, NAME_W = 512, NAME_H = 112;          // shop names: 15 rows of 4
const LINES_Y = 7824, LINE_W = 256, LINE_H = 60;           // short lines and wall tags: 4 rows of 8
const ICONS_Y = 8064, ICON = 128;                          // logo marks (white), the last cell solid white
const CELL_W = 512, CELL_H = 128, TEXT_ROWS = 12;          // text cells: rows 0..11
const PLAQUE = 128, PLAQUE_Y = TEXT_ROWS * CELL_H;        // 2 rows of 16 number plaques
const BLADE_W = 256, BLADE_H = 256, BLADE_Y = PLAQUE_Y + 2 * PLAQUE; // 2 rows of 8 blade faces
const DRESS_Y = BLADE_Y + 2 * BLADE_H;                     // posters 5 rows of 8 (256 px), price cards and stickers a row of 16 (128 px) each, banners 2 rows of 4 (512 x 128)
const WORDS2_Y = 4096;                                     // text cells 48..79: 8 more rows of 4
const BLADE2_Y = WORDS2_Y + 8 * CELL_H;                    // blade faces 16..31: 2 more rows of 8
const PRINT_Y = BLADE2_Y + 2 * BLADE_H;                    // goods-stand prints: a row of 16 papers (128 x 256), 2 rows of 16 price tags (128 x 128)

// Shop words and the interior each one implies (see interior.js SHOP_TYPES).
const WORDS = [
  [['CAFE'], 'cafe'], [['BOOKS'], 'books'], [['SHOES'], 'shoes'], [['JEWELRY'], 'jewellery'],
  [['BAKERY'], 'cafe'], [['PHARMACY'], 'pharmacy'], [['OPTICS'], 'jewellery'], [['FLOWERS'], 'flowers'],
  [['GIFTS'], 'general'], [['BISTRO'], 'cafe'], [['FALAFEL'], 'cafe'], [['PIZZA'], 'cafe'],
  [['JUICE BAR'], 'cafe'], [['FASHION'], 'clothing'], [['BOUTIQUE'], 'clothing'], [['TOYS'], 'general'],
  [['SWEETS'], 'general'], [['MARKET'], 'general'], [['EXCHANGE'], 'jewellery'], [['ESPRESSO'], 'cafe'],
  [['DELI'], 'cafe'], [['ICE CREAM'], 'cafe'], [['BAGELS'], 'cafe'], [['SOUVENIRS'], 'general'],
  [['קפה'], 'cafe'], [['ספרים'], 'books'], [['נעליים'], 'shoes'], [['תכשיטים'], 'jewellery'],
  [['מאפייה'], 'cafe'], [['בית מרקחת'], 'pharmacy'], [['אופטיקה'], 'jewellery'], [['פרחים'], 'flowers'],
  [['מתנות'], 'general'], [['פלאפל'], 'cafe'], [['מיצים'], 'cafe'], [['אופנה'], 'clothing'],
  [['ממתקים'], 'general'], [['גלידה'], 'cafe'], [['מסעדה'], 'cafe'], [['בגדים'], 'clothing'],
  [['קפה', 'CAFE'], 'cafe'], [['ספרים', 'BOOKS'], 'books'], [['תכשיטים', 'JEWELRY'], 'jewellery'], [['מאפייה', 'BAKERY'], 'cafe'],
  [['פרחים', 'FLOWERS'], 'flowers'], [['נעליים', 'SHOES'], 'shoes'], [['אופטיקה', 'OPTICS'], 'jewellery'], [['מתנות', 'GIFTS'], 'general'],
  // (a third entry narrows the trade: what the shop puts out on the pavement, stands.js)
  [['COFFEE'], 'cafe'], [['שווארמה'], 'cafe'], [['BURGER'], 'cafe'], [['חומוס'], 'cafe'],
  [['פיצה'], 'cafe'], [['קונדיטוריה'], 'cafe', 'bakery'], [['SUSHI'], 'cafe'], [['WINE BAR'], 'cafe'],
  [['MINI MARKET'], 'general', 'grocery'], [['מכולת'], 'general', 'grocery'], [['פירות וירקות'], 'general', 'grocery'], [['פיצוחים'], 'general', 'nuts'],
  [['תבלינים'], 'general', 'nuts'], [['PHONES'], 'general', 'phones'], [['סלולר'], 'general', 'phones'], [['קיוסק'], 'general', 'kiosk'],
  [['צעצועים'], 'general', 'toys'], [['JEANS'], 'clothing'], [['KIDS'], 'clothing'], [['אופנת נשים'], 'clothing'],
  [['SPORT'], 'clothing'], [['נעלי ספורט'], 'shoes'], [['SHOE STORE'], 'shoes'], [['GOLD'], 'jewellery'],
  [['שעונים'], 'jewellery'], [['WATCHES'], 'jewellery'], [['פארם'], 'pharmacy'], [['COSMETICS'], 'pharmacy'],
  [['JUDAICA'], 'books'], [['יודאיקה'], 'books'], [['כלי כתיבה'], 'books', 'kiosk'], [['FLORIST'], 'flowers'],
];
// the trade of the original words that put something particular out
const SUB = { BAKERY: 'bakery', 'מאפייה': 'bakery', BAGELS: 'bakery', MARKET: 'grocery', SWEETS: 'sweets', 'ממתקים': 'sweets', SOUVENIRS: 'toys', TOYS: 'toys', GIFTS: 'toys', 'מתנות': 'toys', 'ICE CREAM': 'icecream', 'גלידה': 'icecream', 'JUICE BAR': 'juice', 'מיצים': 'juice' };
/** Shop type implied by a sign's word cell. */
export const wordType = (cell) => WORDS[cell][1];
/** The narrower trade of a sign's word cell (grocery, bakery, nuts, phones, kiosk, toys, sweets, icecream, juice) or null. */
export const wordSub = (cell) => WORDS[cell][2] || SUB[WORDS[cell][0][0]] || SUB[WORDS[cell][0][1]] || null;
/** Word cells of a shop type. */
export function wordsOf(type) { const ok = []; WORDS.forEach(([, t], i) => { if (t === type) ok.push(i); }); return ok; }
/** Whether word cell i is in Hebrew. */
export const wordHebrew = (i) => /[֐-׿]/.test(WORDS[i][0][0]);
/** Single-line word cells of a shop type (a fascia's second line). */
export function subWordsOf(type) { const ok = []; WORDS.forEach(([l, t], i) => { if (t === type && l.length === 1) ok.push(i); }); return ok; }

// Invented shop names: [Hebrew, English, lettering style]. Family names, given names and
// plain words, as the street's shops are named (a family's, a founder's, a fruit's), each
// painted in one of the lettering styles below.
const NAMES = [
  ['אלמוג', 'Almog', 0], ['רימון', 'Rimon', 1], ['תמר', 'Tamar', 2], ['הדקל', 'HaDekel', 3], ['שקד', 'Shaked', 4],
  ['גולדמן', 'Goldman', 1], ['לוי ובניו', 'Levy & Sons', 5], ['כהן', 'Cohen', 0], ['מזרחי', 'Mizrahi', 4], ['פרץ', 'Peretz', 3],
  ['אזולאי', 'Azoulay', 2], ['פרידמן', 'Friedman', 1], ['שפירא', 'Shapira', 5], ['רוזן', 'Rosen', 0], ['בן דוד', 'Ben David', 4],
  ['מלכה', 'Malka', 2], ['גבאי', 'Gabay', 3], ['חדד', 'Hadad', 0], ['עמר', 'Amar', 4], ['אוחנה', 'Ohana', 1],
  ['דהן', 'Dahan', 5], ['ויס', 'Weiss', 3], ['קליין', 'Klein', 0], ['כץ', 'Katz', 4], ['ציון', 'Zion', 1],
  ['גליל', 'Galil', 2], ['נחמה', 'Nechama', 5], ['שושנה', 'Shoshana', 2], ['אורה', 'Ora', 3], ['מזל', 'Mazal', 0],
  ['הגפן', 'HaGefen', 1], ['הזית', 'HaZayit', 4], ['אבן חן', 'Even Hen', 5], ['כתר', 'Keter', 1], ['נוף', 'Nof', 3],
  ['שחר', 'Shachar', 0], ['טל', 'Tal', 2], ['יעלי', 'Yaeli', 4], ['בית אבי', 'Beit Avi', 5], ['האחים ברק', 'Barak Bros.', 0],
  ['סבינה', 'Sabina', 2], ['מרגלית', 'Margalit', 1], ['אריאל', 'Ariel', 3], ['הרמוניה', 'Harmonia', 2], ['לבנה', 'Levana', 4],
  ['פנינה', 'Pnina', 5], ['הכרמל', 'HaCarmel', 0], ['עדן', 'Eden', 3], ['אביב', 'Aviv', 1], ['סיגל', 'Sigal', 4],
  ['נועם', 'Noam', 2], ['מגדל', 'Migdal', 5], ['זהבי', 'Zehavi', 3], ['השקמה', 'HaShikma', 1],
  ['אלון', 'Alon', 0], ['רקפת', 'Rakefet', 2], ['ניסים', 'Nissim', 4], ['ירושלמי', 'Yerushalmi', 5], ['רז', 'Raz', 3], ['עופר', 'Ofer', 1],
];
/** Number of shop names. */
export const N_NAMES = NAMES.length;
// lettering styles: [Hebrew font, Latin font, upper-case, letter spacing (px)]
const NAME_STYLES = [
  ['900 Hpx "Noto Sans Hebrew", "Liberation Sans", sans-serif', '700 Hpx "Liberation Sans", Arial, sans-serif', true, 2],
  ['700 Hpx "Noto Serif Hebrew", "Liberation Serif", serif', '400 Hpx "Liberation Serif", Georgia, serif', true, 6],
  ['700 Hpx "Noto Rashi Hebrew", "Noto Serif Hebrew", serif', 'italic 700 Hpx "Liberation Serif", Georgia, serif', false, 0],
  ['400 Hpx "Noto Sans Hebrew", "DejaVu Sans", sans-serif', '400 Hpx "DejaVu Sans", Verdana, sans-serif', true, 4],
  ['700 Hpx "Noto Sans Hebrew", "Liberation Sans Narrow", sans-serif', '700 Hpx "Liberation Sans Narrow", "Arial Narrow", sans-serif', true, 1],
  ['600 Hpx "Noto Serif Hebrew", "Liberation Serif", serif', '700 Hpx "Liberation Serif", Georgia, serif', false, 1],
];
// Short lines (256 x 64 px, white): phone numbers, the year a shop was founded, taglines;
// then wall tags (full colour, for roller shutters)
const LINES = [
  '02-624 5517', '02-625 1180', '02-538 0942', '*6230', '054-776 1209', '052-318 4466', '02-622 7311', '*5594',
  '02-500 4128', '050-871 3302', '02-623 9065', '*9020', 'EST. 1952', 'SINCE 1968', 'מאז 1949', 'מאז 1923',
  'EST. 1936', 'מאז 1972', 'כשר', 'כשר למהדרין', 'TAX FREE', 'סיטונאות וקמעונאות', 'יבוא ושיווק', 'HANDMADE',
];
/** Line cells: phones 0-11, years 12-17, taglines 18-23, wall tags 24-31. */
export const LINE_KIND = { phone: [0, 11], year: [12, 17], tagline: [18, 23], tag: [24, 31] };
// Logo marks (white silhouettes) a trade's shops pick from; 15 is a solid cell
export const ICON_SOLID = 15;
const TRADE_ICONS = {
  cafe: [0, 1, 14], jewellery: [2, 3, 4, 12], clothing: [5, 6, 12, 13], shoes: [7, 13], books: [8, 13], flowers: [9, 14],
  pharmacy: [10, 10, 14], general: [11, 12, 13, 14], bakery: [1, 14], phones: [11], grocery: [14], toys: [13], sweets: [13],
};
/** A logo mark for a shop of type (narrower trade sub), drawn from r. */
export function tradeIcon(type, sub, r) { const l = (sub && TRADE_ICONS[sub]) || TRADE_ICONS[type] || TRADE_ICONS.general; return l[r.int(0, l.length - 1)]; }
const FONTS = [
  (px) => `700 ${px}px "Liberation Sans", "Noto Sans Hebrew", Arial, sans-serif`,
  (px) => `700 ${px}px "Liberation Serif", "Noto Serif Hebrew", Georgia, serif`,
  (px) => `700 ${px}px "Liberation Sans Narrow", "Nimbus Sans Narrow", "Arial Narrow", sans-serif`,
  (px) => `italic 700 ${px}px "Liberation Serif", "Noto Serif Hebrew", Georgia, serif`,
  (px) => `400 ${px}px "DejaVu Sans", "Noto Sans Hebrew", Verdana, sans-serif`,
];

export const SIGN_PALETTE = {
  boards: [0x1f3a2c, 0x1b2b45, 0x5a1a1c, 0x1d1d1f, 0xd9cfb6, 0xe8e4da, 0x6b4a2a, 0x24464a, 0xb8261e, 0xe8b820, 0x1f5f8a, 0x2f6e3a],
  letters: [0xd8b25a, 0xf2efe6, 0xe9dfc4, 0x1a1a1a, 0xb3261e, 0xf2c230],
  boxes: [0xf4f1e8, 0xf2d24a, 0xc8231c, 0x1f5fa8, 0x2a7a3a, 0xf4f1e8, 0xe8701c, 0x1e8a8a],
};
// painted fascia boards as on the street: half the classic black, dark green, oxblood and
// navy enamel (gold or cream letters), half the shopfitters' bright plastic and aluminium
// boards (red, white, blue, yellow, green, orange, the odd purple)
// (about half are saturated: signal red, royal blue, bottle green, mustard, orange, purple)
const BOARD_WEIGHTS = [[0x1d1d1f, 0.09], [0x1f3a2c, 0.07], [0x5a1a1c, 0.07], [0x1b2b45, 0.06], [0x24464a, 0.04], [0x6b4a2a, 0.04],
  [0xd9cfb6, 0.05], [0xe8e4da, 0.08], [0xb8261e, 0.12], [0x1f4fa0, 0.08], [0x1e6a36, 0.06], [0xe0a81c, 0.07],
  [0xe0641a, 0.05], [0x5a2a6a, 0.04], [0x2a8ac0, 0.03], [0xf2e14a, 0.03], [0xc2185b, 0.02]];
const LIGHT_BOARDS = new Set([0xd9cfb6, 0xe8e4da, 0xe0a81c, 0xf2e14a]);

let atlas = null;

/**
 * The atlas layout (every cell's UVs, a word's inked width) is computed at once; the
 * painting is deferred (atlas.draw(budget ms), time-sliced in idle time while the shaders
 * compile) and the texture is uploaded once it is complete (its version stays 0 until then,
 * so nothing half painted ever reaches the GPU).
 */
function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const jobs = [];
  const paint = (fn) => jobs.push(fn);
  const cells = [];
  // text cells: white glyphs on transparent
  WORDS.forEach(([lines], i) => {
    const cx = (i % 4) * CELL_W, cy = i < 48 ? Math.floor(i / 4) * CELL_H : WORDS2_Y + Math.floor((i - 48) / 4) * CELL_H;
    const font = FONTS[i % FONTS.length];
    let inkW = 0, sx = 1;
    if (lines.length === 1) {
      g.font = font(92);
      const m = g.measureText(lines[0]);
      sx = Math.min(1, (CELL_W - 24) / m.width);
      inkW = m.width * sx;
    } else {
      g.font = font(56);
      const m0 = g.measureText(lines[0]), m1 = g.measureText(lines[1]);
      sx = Math.min(1, (CELL_W - 24) / Math.max(m0.width, m1.width));
      inkW = Math.max(m0.width, m1.width) * sx;
    }
    paint(() => {
      g.save();
      g.beginPath(); g.rect(cx, cy, CELL_W, CELL_H); g.clip();
      g.fillStyle = '#fff';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (lines.length === 1) {
        g.font = font(92);
        g.translate(cx + CELL_W / 2, cy + CELL_H / 2 + 4);
        g.scale(sx, 1);
        g.fillText(lines[0], 0, 0);
      } else {
        g.font = font(56);
        g.translate(cx + CELL_W / 2, cy + CELL_H / 2);
        g.scale(sx, 1);
        g.fillText(lines[0], 0, -30);
        g.font = font(44);
        g.fillText(lines[1], 0, 34);
      }
      g.restore();
    });
    cells.push({ u0: cx / W, v0: 1 - (cy + CELL_H) / H, u1: (cx + CELL_W) / W, v1: 1 - cy / H, aspect: CELL_W / CELL_H, ink: Math.min(1, (inkW + 30) / CELL_W), lines: lines.length });
  });
  // house number plaques: blue enamel with a white border and number
  const plaques = [];
  for (let i = 0; i < 32; i++) {
    const x = (i % 16) * PLAQUE, y = PLAQUE_Y + Math.floor(i / 16) * PLAQUE;
    paint(() => {
      g.save();
      g.fillStyle = '#e9e6dc'; roundRect(g, x + 8, y + 22, PLAQUE - 16, PLAQUE - 44, 14); g.fill();
      g.fillStyle = i % 5 === 3 ? '#2d5a3a' : '#1d3f7a'; roundRect(g, x + 14, y + 28, PLAQUE - 28, PLAQUE - 56, 10); g.fill();
      g.fillStyle = '#f2efe6'; g.font = '700 50px "Liberation Sans", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(1 + ((i * 7) % 63)), x + PLAQUE / 2, y + PLAQUE / 2 + 2);
      g.restore();
    });
    plaques.push({ u0: x / W, v0: 1 - (y + PLAQUE - 22) / H, u1: (x + PLAQUE) / W, v1: 1 - (y + 22) / H });
  }
  // blade sign faces (full colour, generic pictograms)
  const blades = [];
  BLADE_FACES.forEach(([fn, , round], i) => {
    const x = (i % 8) * BLADE_W, y = (i < 16 ? BLADE_Y : BLADE2_Y - 2 * BLADE_H) + Math.floor(i / 8) * BLADE_H;
    paint(() => { g.save(); g.beginPath(); g.rect(x, y, BLADE_W, BLADE_H); g.clip(); fn(g, x, y); g.restore(); });
    blades.push({ u0: (x + 4) / W, v0: 1 - (y + BLADE_H - 4) / H, u1: (x + BLADE_W - 4) / W, v1: 1 - (y + 4) / H, round: !!round });
  });
  // goods-stand prints: folded newspapers and magazines, cardboard price tags
  const prints = { papers: [], tags: [] };
  PAPERS.forEach((fn, i) => {
    const x = i * 128, y = PRINT_Y;
    paint(() => { g.save(); g.beginPath(); g.rect(x, y, 128, 256); g.clip(); fn(g, x + 4, y + 4, 120, 248, i); g.restore(); });
    prints.papers.push({ u0: (x + 4.5) / W, v0: 1 - (y + 251.5) / H, u1: (x + 123.5) / W, v1: 1 - (y + 4.5) / H, aspect: 119 / 247 });
  });
  TAGS.forEach(([fn, a], i) => {
    const cx = (i % 16) * 128, cy = PRINT_Y + 256 + Math.floor(i / 16) * 128;
    const w = Math.min(120, 120 * a), h = w / a, x = cx + (128 - w) / 2, y = cy + (128 - h) / 2;
    paint(() => { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); fn(g, x, y, w, h, i); g.restore(); });
    prints.tags.push({ u0: (x + 1) / W, v0: 1 - (y + h - 1) / H, u1: (x + w - 1) / W, v1: 1 - (y + 1) / H, aspect: w / h });
  });
  // window dressing: each draws a card of aspect a (w / h) centred in its cell
  const dress = { posters: [], prices: [], stickers: [], banners: [] };
  let yy = DRESS_Y;
  for (const [key, list, CW, CH, per] of [['posters', POSTERS, 256, 256, 8], ['prices', PRICES, 128, 128, 16], ['stickers', STICKERS, 128, 128, 16], ['banners', BANNERS, 512, 128, 4]]) {
    const mg = CH >= 256 ? 6 : 4;
    list.forEach(([fn, a], i) => {
      const cx = (i % per) * CW, cy = yy + Math.floor(i / per) * CH;
      const w = Math.min(CW - 2 * mg, (CH - 2 * mg) * a), h = w / a;
      const x = cx + (CW - w) / 2, y = cy + (CH - h) / 2;
      paint(() => { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); fn(g, x, y, w, h); g.restore(); });
      dress[key].push({ u0: (x + 1) / W, v0: 1 - (y + h - 1) / H, u1: (x + w - 1) / W, v1: 1 - (y + 1) / H, aspect: w / h });
    });
    yy += Math.ceil(list.length / per) * CH;
  }
  if (yy > WORDS2_Y) console.warn('[facades] sign atlas overflow', yy);
  // shop names: the Hebrew name on top, its English form below; each line can be used on
  // its own (sub-cells cropped to the ink)
  const names = [];
  const cellOf = (x, y0, y1, inkW, cw) => {
    const pad = (cw - Math.min(cw, inkW + 16)) / 2;
    return { u0: (x + pad) / W, u1: (x + cw - pad) / W, v0: 1 - y1 / H, v1: 1 - y0 / H, aspect: Math.min(cw, inkW + 16) / (y1 - y0) };
  };
  NAMES.forEach(([he, en, st], i) => {
    const x = (i % 4) * NAME_W, y = NAMES_Y + Math.floor(i / 4) * NAME_H;
    const [fh, fl, upper, sp] = NAME_STYLES[st];
    const enT = upper ? en.toUpperCase() : en;
    g.font = fh.replace('Hpx', '62px');
    const wh = g.measureText(he).width, sxH = Math.min(1, (NAME_W - 28) / Math.max(1, wh));
    g.font = fl.replace('Hpx', '31px');
    g.letterSpacing = `${sp}px`;
    const we = g.measureText(enT).width, sxE = Math.min(1, (NAME_W - 28) / Math.max(1, we));
    g.letterSpacing = '0px';
    const iH = wh * sxH, iE = we * sxE;
    paint(() => {
      g.save();
      g.beginPath(); g.rect(x, y, NAME_W, NAME_H); g.clip();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.save(); g.font = fh.replace('Hpx', '62px'); g.direction = 'rtl'; g.translate(x + NAME_W / 2, y + 38); g.scale(sxH, 1); g.fillText(he, 0, 0); g.restore();
      g.save(); g.font = fl.replace('Hpx', '31px'); g.letterSpacing = `${sp}px`; g.translate(x + NAME_W / 2, y + 92); g.scale(sxE, 1); g.fillText(enT, 0, 0); g.restore();
      g.restore();
    });
    names.push({ full: cellOf(x, y, y + NAME_H, Math.max(iH, iE), NAME_W), he: cellOf(x, y + 2, y + 75, iH, NAME_W), en: cellOf(x, y + 75, y + NAME_H - 2, iE, NAME_W) });
  });
  // short lines (white) and wall tags (full colour)
  const lines = [];
  for (let i = 0; i < 32; i++) {
    const x = (i % 8) * LINE_W, y = LINES_Y + Math.floor(i / 8) * LINE_H;
    if (i < LINES.length) {
      const str = LINES[i];
      g.font = SANS(34);
      const wl = g.measureText(str).width, sx = Math.min(1, (LINE_W - 12) / Math.max(1, wl));
      paint(() => { g.save(); g.beginPath(); g.rect(x, y, LINE_W, LINE_H); g.clip(); g.fillStyle = '#fff'; g.font = SANS(34); g.textAlign = 'center'; g.textBaseline = 'middle'; g.translate(x + LINE_W / 2, y + LINE_H / 2 + 2); g.scale(sx, 1); g.fillText(str, 0, 0); g.restore(); });
      lines.push(cellOf(x, y + 6, y + LINE_H - 6, wl * sx, LINE_W));
    } else {
      paint(() => { g.save(); g.beginPath(); g.rect(x, y, LINE_W, LINE_H); g.clip(); wallTag(g, x, y, LINE_W, LINE_H, i); g.restore(); });
      lines.push({ u0: (x + 2) / W, u1: (x + LINE_W - 2) / W, v0: 1 - (y + LINE_H - 2) / H, v1: 1 - (y + 2) / H, aspect: (LINE_W - 4) / (LINE_H - 4) });
    }
  }
  // logo marks (white silhouettes) and a solid white cell
  const icons = [];
  for (let i = 0; i < 16; i++) {
    const x = i * ICON, y = ICONS_Y;
    paint(() => { g.save(); g.beginPath(); g.rect(x, y, ICON, ICON); g.clip(); g.fillStyle = '#fff'; g.strokeStyle = '#fff'; ICON_DRAW[i](g, x, y); g.restore(); });
    icons.push(i === ICON_SOLID ? { u0: (x + 32) / W, u1: (x + 96) / W, v0: 1 - (y + 96) / H, v1: 1 - (y + 32) / H, aspect: 1 }
      : { u0: (x + 2) / W, u1: (x + ICON - 2) / W, v0: 1 - (y + ICON - 2) / H, v1: 1 - (y + 2) / H, aspect: 1 });
  }
  // (a plain texture: version 0, not uploaded, until the painting is complete)
  const tex = new THREE.Texture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const out = { tex, cells, plaques, blades, dress, prints, names, lines, icons, done: false, ms: 0 };
  /** Paint for up to budget ms; true once the atlas is complete (and queued for upload). */
  out.draw = (budget = Infinity) => {
    if (out.done) return true;
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < budget) jobs.shift()();
    out.ms += performance.now() - t0;
    if (!jobs.length) { out.done = true; tex.needsUpdate = true; }
    return out.done;
  };
  return out;
}

// ------------------------------------------------------------------ window dressing
// Printed and hand-made cards for the shop windows, drawn once into the atlas: ~40
// posters (A4 notices to A1 photographs, portrait and landscape, a pair of A4 sheets, hand
// lettering in marker), 16 price cards, 16 door stickers and 8 sale banners. Posters carry
// a category (which shops put them up) and a paper size; dressing.js spreads them along
// the street so that no design shows twice within ~80 m of the same side.
const SANS = (px, wt = 700) => `${wt} ${px}px "Liberation Sans", "Noto Sans Hebrew", "DejaVu Sans", Arial, sans-serif`;
const SERIF = (px, wt = 700) => `${wt} ${px}px "Liberation Serif", "Noto Serif Hebrew", "DejaVu Serif", Georgia, serif`;
const COND = (px, wt = 700) => `${wt} ${px}px "Liberation Sans Narrow", "Nimbus Sans Narrow", "Noto Sans Hebrew", "Arial Narrow", sans-serif`;
/** Text fitted into maxW, centred at (cx, cy). */
function fit(g, str, cx, cy, maxW, px, color, wt = 700, font = SANS) {
  g.fillStyle = color; g.font = font(px, wt);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const m = g.measureText(str), sx = Math.min(1, maxW / Math.max(1, m.width));
  g.save(); g.translate(cx, cy); g.scale(sx, 1); g.fillText(str, 0, 0); g.restore();
}
/** Lines of small print (grey bars of varying length). */
function lines(g, x, y, w, n, color, lh) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) g.fillRect(x, y + i * lh, w * (0.5 + 0.5 * (((i * 37) % 7) / 6)), Math.max(2, lh * 0.35));
}
/** Right-aligned small print (Hebrew columns). */
function linesR(g, x, y, w, n, color, lh) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) { const l = w * (0.45 + 0.55 * (((i * 53) % 9) / 8)); g.fillRect(x + w - l, y + i * lh, l, Math.max(2, lh * 0.35)); }
}
/** Paper card: a slight sheen gradient over the ground colour (printed poster stock). */
function paper(g, x, y, w, h, bg) {
  g.fillStyle = bg; g.fillRect(x, y, w, h);
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.08)');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}
/** A white margin round a printed area (posters printed with a border). */
function margin(g, x, y, w, h, m = 0.035) {
  g.strokeStyle = '#f4f2ec'; g.lineWidth = Math.min(w, h) * m * 2; g.strokeRect(x, y, w, h);
}
function grad(g, x, y, w, h, c0, c1, horiz = false) {
  const gr = horiz ? g.createLinearGradient(x, y, x + w, y) : g.createLinearGradient(x, y, x, y + h);
  gr.addColorStop(0, c0); gr.addColorStop(1, c1); g.fillStyle = gr; g.fillRect(x, y, w, h);
}
function disc(g, cx, cy, r, color) { g.fillStyle = color; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); }
/** Starburst sticker shape. */
function burst(g, cx, cy, r0, r1, n, color) {
  g.fillStyle = color; g.beginPath();
  for (let i = 0; i < 2 * n; i++) { const a = (i / (2 * n)) * Math.PI * 2, r = i % 2 ? r0 : r1; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
  g.closePath(); g.fill();
}
/**
 * Hand lettering in marker: each glyph (Latin) or word (Hebrew, which the canvas lays out
 * right to left with its numbers) slightly turned and offset, stroked round.
 */
function hand(g, str, cx, cy, maxW, px, color, seed = 1) {
  const r = new RNG(seed);
  g.save();
  g.font = `700 ${px}px "DejaVu Sans", "Noto Sans Hebrew", "Liberation Sans", sans-serif`;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  const rtl = /[\u0590-\u05ff]/.test(str);
  // units laid out left to right on the card: glyphs, or the words in reverse for Hebrew
  const units = rtl ? str.split(' ').reverse() : [...str];
  const gap = rtl ? g.measureText(' ').width : 0;
  const ws = units.map((c) => g.measureText(c).width * (rtl ? 1 : 0.96));
  const tot = ws.reduce((a, b) => a + b, 0) + gap * (units.length - 1);
  const sx = Math.min(1, maxW / Math.max(1, tot));
  g.translate(cx, cy); g.scale(sx, 1); g.rotate(r.range(-0.04, 0.04));
  g.fillStyle = color; g.strokeStyle = color; g.lineWidth = px * 0.05; g.lineJoin = 'round';
  if (rtl) { g.direction = 'rtl'; g.textAlign = 'right'; }
  let x = -tot / 2;
  units.forEach((c, i) => {
    g.save();
    g.translate(x + (rtl ? ws[i] : 0) + r.range(-0.03, 0.03) * px, r.range(-0.05, 0.05) * px);
    g.rotate(r.range(rtl ? -0.04 : -0.07, rtl ? 0.04 : 0.07));
    g.fillText(c, 0, 0); g.strokeText(c, 0, 0);
    g.restore();
    x += ws[i] + gap;
  });
  g.restore();
}
/** A stylised figure for the fashion photographs (head, hair, garment, legs). */
function figure(g, cx, top, hgt, skin, hair, top_, low, dress = false) {
  const u = hgt / 8;
  disc(g, cx, top + u * 0.55, u * 0.5, hair);
  g.fillStyle = skin; g.beginPath(); g.ellipse(cx, top + u * 0.7, u * 0.38, u * 0.48, 0, 0, Math.PI * 2); g.fill();
  g.fillRect(cx - u * 0.13, top + u * 1.05, u * 0.26, u * 0.4);
  g.fillStyle = top_; g.beginPath();
  g.moveTo(cx - u * 0.95, top + u * 1.45); g.lineTo(cx + u * 0.95, top + u * 1.45);
  g.lineTo(cx + u * (dress ? 1.3 : 0.75), top + u * (dress ? 5.2 : 3.9)); g.lineTo(cx - u * (dress ? 1.3 : 0.75), top + u * (dress ? 5.2 : 3.9));
  g.closePath(); g.fill();
  g.fillStyle = dress ? skin : low;
  g.fillRect(cx - u * 0.62, top + u * (dress ? 5.2 : 3.9), u * 0.5, u * (dress ? 2.6 : 3.9));
  g.fillRect(cx + u * 0.12, top + u * (dress ? 5.2 : 3.9), u * 0.5, u * (dress ? 2.6 : 3.9));
}

// Posters: [draw, aspect (w / h), category, size: paper height class (A4 .. A1)].
// Categories: sale (discounts), fashion (photographs), food, culture (events), notice
// (hand-made and printed notices).
const POSTERS = [
  // ---- sale
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#c8201a'); fit(g, 'SALE', x + w / 2, y + h * 0.38, w * 0.86, h * 0.26, '#fff'); fit(g, 'UP TO 50%', x + w / 2, y + h * 0.62, w * 0.8, h * 0.09, '#fff'); lines(g, x + w * 0.2, y + h * 0.8, w * 0.6, 2, 'rgba(255,255,255,0.7)', h * 0.04); }, 0.707, 'sale', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4d01c'); fit(g, 'מבצע', x + w / 2, y + h * 0.36, w * 0.86, h * 0.26, '#c8201a'); fit(g, '%', x + w / 2, y + h * 0.66, w * 0.5, h * 0.24, '#1a1a1a'); }, 0.707, 'sale', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); fit(g, '-30%', x + w / 2, y + h * 0.42, w * 0.86, h * 0.24, '#d01e1a'); fit(g, 'הנחה', x + w / 2, y + h * 0.7, w * 0.6, h * 0.12, '#1a1a1a'); }, 0.707, 'sale', 'A3'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#e86a1a'); fit(g, '1+1', x + w / 2, y + h * 0.4, w * 0.8, h * 0.28, '#fff'); fit(g, 'על כל החנות', x + w / 2, y + h * 0.7, w * 0.8, h * 0.08, '#fff'); }, 0.707, 'sale', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#1e5fa0'); fit(g, 'SALE', x + w / 2, y + h * 0.3, w * 0.8, h * 0.18, '#f4d01c'); fit(g, '70%', x + w / 2, y + h * 0.56, w * 0.86, h * 0.26, '#fff'); }, 0.707, 'sale', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#141416'); fit(g, 'FINAL', x + w / 2, y + h * 0.2, w * 0.6, h * 0.08, '#f2efe6', 400); fit(g, 'SALE', x + w / 2, y + h * 0.38, w * 0.9, h * 0.22, '#f4d01c'); fit(g, '-60%', x + w / 2, y + h * 0.66, w * 0.7, h * 0.16, '#f2efe6'); }, 0.707, 'sale', 'A1'],
  [(g, x, y, w, h) => { grad(g, x, y, w, h, '#c2185b', '#880e4f'); fit(g, 'סוף עונה', x + w / 2, y + h * 0.34, w * 0.84, h * 0.15, '#fff'); fit(g, 'עד 50%', x + w / 2, y + h * 0.6, w * 0.8, h * 0.17, '#ffe066'); margin(g, x, y, w, h); }, 0.707, 'sale', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#2e7d32'); fit(g, '2', x + w * 0.3, y + h * 0.42, w * 0.4, h * 0.4, '#fff'); fit(g, 'ב-100', x + w * 0.66, y + h * 0.46, w * 0.5, h * 0.16, '#fff'); fit(g, '₪', x + w / 2, y + h * 0.78, w * 0.3, h * 0.12, '#c5e1a5'); }, 0.707, 'sale', 'A3'],
  [(g, x, y, w, h) => {
    g.fillStyle = '#f4d01c'; g.fillRect(x, y, w, h);
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.fillStyle = '#c8201a';
    for (let i = -h; i < w; i += h * 0.16) { g.beginPath(); g.moveTo(x + i, y); g.lineTo(x + i + h * 0.08, y); g.lineTo(x + i + h * 0.08 + h, y + h); g.lineTo(x + i + h, y + h); g.fill(); }
    g.restore(); paper(g, x + w * 0.07, y + h * 0.12, w * 0.86, h * 0.76, '#fff');
    fit(g, 'מחירי חיסול', x + w / 2, y + h * 0.4, w * 0.78, h * 0.26, '#c8201a'); fit(g, 'CLEARANCE', x + w / 2, y + h * 0.7, w * 0.5, h * 0.12, '#222');
  }, 1.414, 'sale', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); burst(g, x + w / 2, y + h / 2, w * 0.33, w * 0.47, 14, '#d01e1a'); fit(g, 'SALE', x + w / 2, y + h * 0.46, w * 0.5, h * 0.16, '#fff'); fit(g, '-40%', x + w / 2, y + h * 0.6, w * 0.34, h * 0.1, '#ffe066'); }, 1.0, 'sale', 'A3'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f8bbd0'); fit(g, '-20%', x + w / 2, y + h * 0.36, w * 0.8, h * 0.22, '#111'); fit(g, 'על הפריט השני', x + w / 2, y + h * 0.62, w * 0.82, h * 0.08, '#111', 400); lines(g, x + w * 0.25, y + h * 0.78, w * 0.5, 2, 'rgba(0,0,0,0.5)', h * 0.035); }, 0.707, 'sale', 'A3'],
  [(g, x, y, w, h) => { grad(g, x, y, w, h, '#4fc3f7', '#0288d1'); disc(g, x + w * 0.72, y + h * 0.22, w * 0.15, '#ffe066'); fit(g, 'מבצעי קיץ', x + w / 2, y + h * 0.52, w * 0.86, h * 0.14, '#fff'); fit(g, 'SUMMER DEALS', x + w / 2, y + h * 0.68, w * 0.7, h * 0.06, '#fff', 400); }, 0.707, 'sale', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); g.fillStyle = '#c8201a'; g.fillRect(x, y + h * 0.66, w, h * 0.34); fit(g, 'SALE', x + w * 0.3, y + h * 0.36, w * 0.5, h * 0.36, '#c8201a'); fit(g, '-40%', x + w * 0.76, y + h * 0.36, w * 0.36, h * 0.28, '#111'); fit(g, 'כל הקולקציה', x + w / 2, y + h * 0.83, w * 0.6, h * 0.14, '#fff'); }, 1.414, 'sale', 'A2'],
  [(g, x, y, w, h) => {
    // two A4 sheets taped side by side
    g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(x, y, w, h);
    for (const k of [0, 1]) { const sx = x + k * w * 0.505; paper(g, sx, y, w * 0.495, h, '#fbfaf6'); fit(g, k ? 'SALE' : '%', sx + w * 0.2475, y + h * 0.4, w * 0.4, h * (k ? 0.24 : 0.5), '#d01e1a'); fit(g, k ? 'מבצע' : '50', sx + w * 0.2475, y + h * 0.78, w * 0.34, h * 0.14, '#111'); }
  }, 1.414, 'sale', 'A4'],
  // ---- fashion photographs
  [(g, x, y, w, h) => { grad(g, x, y, w, h, '#d9b9a0', '#8a6a5a'); figure(g, x + w * 0.5, y + h * 0.1, h * 0.72, '#c89a7a', '#2a2224', '#e8e2d8', '#3a3a44'); fit(g, 'NEW COLLECTION', x + w / 2, y + h * 0.9, w * 0.86, h * 0.05, '#fff'); }, 0.707, 'fashion', 'A1'],
  [(g, x, y, w, h) => { grad(g, x, y, w, h, '#cfd2d4', '#9aa0a6'); figure(g, x + w * 0.33, y + h * 0.14, h * 0.7, '#e0b89a', '#6b4a2a', '#1d2a44', '#d8d2c4'); figure(g, x + w * 0.68, y + h * 0.1, h * 0.74, '#8a5a3c', '#141414', '#b8261e', '#e8e4da', true); fit(g, 'SUMMER', x + w / 2, y + h * 0.92, w * 0.6, h * 0.05, '#1a1a1a'); }, 0.707, 'fashion', 'A1'],
  [(g, x, y, w, h) => { grad(g, x, y, w, h, '#7fb2d8', '#e6dccb'); g.fillStyle = '#e8d8b8'; g.fillRect(x, y + h * 0.72, w, h * 0.28); figure(g, x + w * 0.36, y + h * 0.12, h * 0.78, '#d0a080', '#3a2a1a', '#f2efe6', '#7fb2d8', true); fit(g, 'קולקציה חדשה', x + w * 0.74, y + h * 0.4, w * 0.4, h * 0.1, '#fff'); }, 1.414, 'fashion', 'A1'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#e9e7e2'); g.fillStyle = '#151515'; g.beginPath(); g.ellipse(x + w * 0.5, y + h * 0.36, w * 0.3, h * 0.26, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = '#bdb6ac'; g.beginPath(); g.ellipse(x + w * 0.5, y + h * 0.42, w * 0.2, h * 0.2, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = '#151515'; g.fillRect(x + w * 0.2, y + h * 0.62, w * 0.6, h * 0.2); fit(g, 'ESSENTIALS', x + w / 2, y + h * 0.9, w * 0.7, h * 0.05, '#151515'); }, 0.707, 'fashion', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#6b6a3a'); g.fillStyle = '#e8dcc0'; g.beginPath(); g.moveTo(x + w * 0.15, y + h * 0.62); g.lineTo(x + w * 0.15, y + h * 0.4); g.lineTo(x + w * 0.42, y + h * 0.4); g.quadraticCurveTo(x + w * 0.48, y + h * 0.52, x + w * 0.66, y + h * 0.54); g.quadraticCurveTo(x + w * 0.88, y + h * 0.56, x + w * 0.86, y + h * 0.62); g.closePath(); g.fill(); g.fillStyle = '#2a2016'; g.fillRect(x + w * 0.14, y + h * 0.62, w * 0.73, h * 0.025); fit(g, 'NEW IN', x + w / 2, y + h * 0.22, w * 0.6, h * 0.1, '#f2efe6'); }, 0.707, 'fashion', 'A2'],
  [(g, x, y, w, h) => { grad(g, x, y, w, h, '#f2a65a', '#7a3a4a'); figure(g, x + w * 0.55, y + h * 0.16, h * 0.7, '#a86a4a', '#1a1010', '#1a1a1c', '#1a1a1c'); fit(g, 'LINEA', x + w * 0.3, y + h * 0.12, w * 0.4, h * 0.07, '#fff', 400, SERIF); }, 0.707, 'fashion', 'A1'],
  // ---- food
  [(g, x, y, w, h) => {
    const gr = g.createRadialGradient(x + w * 0.5, y + h * 0.45, 5, x + w * 0.5, y + h * 0.45, w * 0.7); gr.addColorStop(0, '#6a4a30'); gr.addColorStop(1, '#2a1a12');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = '#f2ece2'; g.beginPath(); g.ellipse(x + w * 0.5, y + h * 0.56, w * 0.32, h * 0.06, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ece6dc'; g.fillRect(x + w * 0.33, y + h * 0.36, w * 0.34, h * 0.18);
    g.fillStyle = '#5a3218'; g.beginPath(); g.ellipse(x + w * 0.5, y + h * 0.36, w * 0.17, h * 0.03, 0, 0, Math.PI * 2); g.fill();
    fit(g, 'קפה', x + w / 2, y + h * 0.8, w * 0.6, h * 0.12, '#f2d27a');
  }, 0.707, 'food', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#1d2420'); fit(g, 'תפריט', x + w / 2, y + h * 0.1, w * 0.5, h * 0.07, '#f2efe6', 400, SERIF); linesR(g, x + w * 0.3, y + h * 0.22, w * 0.6, 12, 'rgba(240,236,224,0.8)', h * 0.058); g.fillStyle = 'rgba(240,236,224,0.8)'; for (let i = 0; i < 12; i++) g.fillRect(x + w * 0.08, y + h * 0.22 + i * h * 0.058, w * 0.12, Math.max(2, h * 0.02)); }, 0.707, 'food', 'A3'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#efe4cf'); disc(g, x + w * 0.5, y + h * 0.42, w * 0.36, '#fafafa'); disc(g, x + w * 0.42, y + h * 0.4, w * 0.12, '#fffaf0'); disc(g, x + w * 0.42, y + h * 0.4, w * 0.05, '#f2b41c'); g.fillStyle = '#c8823a'; g.fillRect(x + w * 0.55, y + h * 0.34, w * 0.16, h * 0.12); disc(g, x + w * 0.5, y + h * 0.54, w * 0.06, '#c8201a'); fit(g, 'ארוחת בוקר', x + w / 2, y + h * 0.8, w * 0.8, h * 0.09, '#3a2a1a'); fit(g, '59', x + w * 0.84, y + h * 0.12, w * 0.2, h * 0.08, '#c8201a'); }, 0.707, 'food', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#fffbe8'); for (let i = 0; i < 5; i++) { disc(g, x + w * (0.22 + 0.15 * i), y + h * (0.32 + 0.08 * (i % 2)), w * 0.12, '#f28c1c'); disc(g, x + w * (0.22 + 0.15 * i), y + h * (0.32 + 0.08 * (i % 2)), w * 0.085, '#ffb84d'); } fit(g, 'מיץ טבעי', x + w / 2, y + h * 0.66, w * 0.8, h * 0.12, '#2e7d32'); fit(g, 'FRESH', x + w / 2, y + h * 0.82, w * 0.4, h * 0.06, '#f28c1c'); }, 0.707, 'food', 'A3'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#fbfaf6'); g.fillStyle = '#b3261e'; g.fillRect(x, y, w, h * 0.16); fit(g, 'BUSINESS LUNCH', x + w / 2, y + h * 0.08, w * 0.84, h * 0.08, '#fff'); linesR(g, x + w * 0.12, y + h * 0.26, w * 0.76, 9, 'rgba(20,20,20,0.7)', h * 0.068); fit(g, '49', x + w * 0.2, y + h * 0.88, w * 0.2, h * 0.08, '#b3261e'); }, 0.707, 'food', 'A4'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f6ead2'); g.fillStyle = '#b8742c'; for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(x + w * (0.28 + 0.22 * i), y + h * 0.42, w * 0.11, h * 0.07, 0.3 * (i - 1), 0, Math.PI * 2); g.fill(); } g.fillStyle = '#8a4e1a'; for (let i = 0; i < 3; i++) g.fillRect(x + w * (0.24 + 0.22 * i), y + h * 0.41, w * 0.08, h * 0.012); fit(g, 'מאפים טריים', x + w / 2, y + h * 0.7, w * 0.82, h * 0.1, '#5a3218'); }, 0.707, 'food', 'A3'],
  // ---- culture (events)
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#16213e'); const gr = g.createRadialGradient(x + w * 0.5, y + h * 0.36, 2, x + w * 0.5, y + h * 0.36, w * 0.4); gr.addColorStop(0, '#f2a65a'); gr.addColorStop(1, 'rgba(242,166,90,0)'); g.fillStyle = gr; g.fillRect(x, y, w, h); fit(g, 'JAZZ', x + w / 2, y + h * 0.36, w * 0.7, h * 0.16, '#f2efe6', 700, SERIF); lines(g, x + w * 0.2, y + h * 0.66, w * 0.6, 4, 'rgba(242,239,230,0.75)', h * 0.05); }, 0.707, 'culture', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#efeae0'); g.fillStyle = '#d0402a'; g.fillRect(x + w * 0.12, y + h * 0.12, w * 0.4, h * 0.3); g.fillStyle = '#1f4f8a'; disc(g, x + w * 0.64, y + h * 0.42, w * 0.2, '#1f4f8a'); g.fillStyle = '#e8b820'; g.fillRect(x + w * 0.3, y + h * 0.5, w * 0.18, h * 0.18); fit(g, 'תערוכה', x + w * 0.62, y + h * 0.82, w * 0.5, h * 0.08, '#111'); lines(g, x + w * 0.12, y + h * 0.78, w * 0.26, 3, 'rgba(0,0,0,0.6)', h * 0.035); }, 0.707, 'culture', 'A2'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#0e0e10'); g.fillStyle = 'rgba(255,240,200,0.22)'; g.beginPath(); g.moveTo(x + w * 0.46, y); g.lineTo(x + w * 0.54, y); g.lineTo(x + w * 0.8, y + h * 0.7); g.lineTo(x + w * 0.2, y + h * 0.7); g.closePath(); g.fill(); g.fillStyle = '#0e0e10'; g.beginPath(); g.ellipse(x + w * 0.5, y + h * 0.56, w * 0.07, h * 0.11, 0, 0, Math.PI * 2); g.fill(); fit(g, 'הצגה', x + w / 2, y + h * 0.8, w * 0.5, h * 0.09, '#e9dfc4', 700, SERIF); lines(g, x + w * 0.25, y + h * 0.88, w * 0.5, 2, 'rgba(233,223,196,0.6)', h * 0.03); }, 0.707, 'culture', 'A2'],
  [(g, x, y, w, h) => { const C = ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#e9c46a', '#8e44ad']; for (let i = 0; i < 6; i++) { g.fillStyle = C[i]; g.fillRect(x + (w * i) / 6, y, w / 6 + 1, h); } paper(g, x + w * 0.1, y + h * 0.36, w * 0.8, h * 0.26, '#fbfaf6'); fit(g, 'פסטיבל', x + w / 2, y + h * 0.46, w * 0.7, h * 0.12, '#264653'); lines(g, x + w * 0.2, y + h * 0.56, w * 0.6, 1, 'rgba(0,0,0,0.6)', h * 0.03); }, 0.707, 'culture', 'A1'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f3ead8'); g.fillStyle = '#1f3a2c'; g.fillRect(x + w * 0.3, y + h * 0.14, w * 0.4, h * 0.38); g.fillStyle = '#d8b25a'; g.fillRect(x + w * 0.36, y + h * 0.22, w * 0.28, h * 0.02); fit(g, 'ערב השקה', x + w / 2, y + h * 0.66, w * 0.76, h * 0.1, '#1f3a2c', 700, SERIF); linesR(g, x + w * 0.2, y + h * 0.76, w * 0.6, 3, 'rgba(0,0,0,0.55)', h * 0.04); }, 0.707, 'culture', 'A3'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#8a1414'); g.fillStyle = '#111'; g.fillRect(x, y + h * 0.18, w, h * 0.16); g.fillStyle = '#eee'; for (let i = 0; i < 9; i++) { g.fillRect(x + w * (0.04 + i * 0.11), y + h * 0.2, w * 0.05, h * 0.025); g.fillRect(x + w * (0.04 + i * 0.11), y + h * 0.3, w * 0.05, h * 0.025); } fit(g, 'CINEMA', x + w / 2, y + h * 0.56, w * 0.8, h * 0.13, '#f2efe6'); fit(g, 'קולנוע בחצר', x + w / 2, y + h * 0.72, w * 0.6, h * 0.07, '#f4d01c'); }, 0.707, 'culture', 'A2'],
  // ---- notices (printed and hand-made)
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#fbfaf6'); hand(g, 'דרושים/ות', x + w / 2, y + h * 0.3, w * 0.86, h * 0.16, '#1b3a8a', 11); hand(g, 'לעבודה', x + w / 2, y + h * 0.5, w * 0.6, h * 0.1, '#1b3a8a', 12); linesR(g, x + w * 0.2, y + h * 0.66, w * 0.6, 3, 'rgba(27,58,138,0.6)', h * 0.06); }, 0.707, 'notice', 'A4'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4d01c'); fit(g, 'להשכרה', x + w / 2, y + h * 0.32, w * 0.84, h * 0.2, '#c8201a'); fit(g, '050-555 0142', x + w / 2, y + h * 0.66, w * 0.76, h * 0.1, '#111'); }, 0.707, 'notice', 'A3'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#fbfaf6'); fit(g, 'שעות פתיחה', x + w / 2, y + h * 0.12, w * 0.7, h * 0.07, '#111'); g.fillStyle = 'rgba(20,20,20,0.75)'; for (let i = 0; i < 6; i++) { const yy = y + h * (0.26 + i * 0.1); g.fillRect(x + w * 0.58, yy, w * 0.28, Math.max(2, h * 0.025)); g.fillRect(x + w * 0.14, yy, w * 0.3, Math.max(2, h * 0.025)); } }, 0.707, 'notice', 'A4'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f6f04a'); hand(g, 'BACK IN', x + w / 2, y + h * 0.34, w * 0.7, h * 0.22, '#111', 31); hand(g, '10 MIN', x + w / 2, y + h * 0.66, w * 0.7, h * 0.24, '#c8201a', 32); }, 1.414, 'notice', 'A4'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#ff6fa8'); hand(g, 'מבצע!', x + w / 2, y + h * 0.3, w * 0.82, h * 0.2, '#111', 41); hand(g, '3 ב-50', x + w / 2, y + h * 0.62, w * 0.8, h * 0.2, '#111', 42); }, 0.707, 'notice', 'A4'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#fbfaf6'); g.strokeStyle = '#2d5a8a'; g.lineWidth = w * 0.02; g.strokeRect(x + w * 0.05, y + h * 0.04, w * 0.9, h * 0.92); g.strokeStyle = '#2d5a8a'; g.lineWidth = w * 0.012; g.beginPath(); g.arc(x + w * 0.5, y + h * 0.24, w * 0.13, 0, Math.PI * 2); g.stroke(); fit(g, 'תעודה', x + w / 2, y + h * 0.46, w * 0.5, h * 0.06, '#2d5a8a', 700, SERIF); linesR(g, x + w * 0.15, y + h * 0.56, w * 0.7, 6, 'rgba(20,20,20,0.6)', h * 0.05); disc(g, x + w * 0.72, y + h * 0.86, w * 0.07, 'rgba(160,30,30,0.7)'); }, 0.707, 'notice', 'A4'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f7f3ea'); fit(g, 'ברוכים הבאים', x + w / 2, y + h * 0.4, w * 0.8, h * 0.2, '#5a1a1c', 700, SERIF); fit(g, 'WELCOME', x + w / 2, y + h * 0.68, w * 0.4, h * 0.12, '#5a1a1c', 400, SERIF); }, 1.414, 'notice', 'A4'],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#fbfaf6'); fit(g, 'סגירת', x + w / 2, y + h * 0.24, w * 0.7, h * 0.13, '#c8201a', 700, COND); fit(g, 'עסק', x + w / 2, y + h * 0.42, w * 0.6, h * 0.16, '#c8201a', 700, COND); fit(g, 'הכל חייב להימכר', x + w / 2, y + h * 0.66, w * 0.82, h * 0.07, '#111'); }, 0.707, 'notice', 'A3'],
];
// Price cards and boards (fluorescent card, big numerals); 128 px cells.
const PRICE_DEFS = [
  ['#f6d21c', '69', '#c8201a', 0.8], ['#f6d21c', '29.90', '#111', 1.3], ['#d01e1a', '99', '#fff', 0.8], ['#ff8a1c', '19.90', '#111', 1.3],
  ['#f4f2ec', '10', '#c8201a', 0.8], ['#b8e02a', '49', '#111', 0.8], ['#f6d21c', '5.90', '#1e3f9a', 1.3], ['#ff6fa8', '39.90', '#111', 1.3],
  ['#f4f2ec', '149', '#1e3f9a', 1.0], ['#7fe3f0', '12', '#111', 0.8], ['#f6f04a', '79', '#c8201a', 0.8], ['#ff8a1c', '119', '#fff', 1.0],
  ['#fbfaf6', '14.90', '#c8201a', 1.3], ['#b8e02a', '9.90', '#111', 1.3], ['#d01e1a', '25', '#f6f04a', 0.8], ['#f4f2ec', '59', '#111', 0.8],
];
const PRICES = PRICE_DEFS.map(([bg, num, ink, a], i) => [(g, x, y, w, h) => {
  if (i % 5 === 4) { burst(g, x + w / 2, y + h / 2, Math.min(w, h) * 0.38, Math.min(w, h) * 0.5, 12, bg); }
  else if (i % 7 === 3) { g.fillStyle = bg; g.beginPath(); g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); g.fill(); }
  else paper(g, x, y, w, h, bg);
  fit(g, num, x + w / 2, y + h * 0.52, w * (i % 5 === 4 ? 0.62 : 0.86), h * (num.length > 3 ? 0.45 : 0.66), ink);
  if (i % 3 === 0) fit(g, '₪', x + w * 0.86, y + h * 0.2, w * 0.14, h * 0.18, ink);
}, a]);
// Door and window stickers; 128 px cells.
const STICKERS = [
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#c8201a'); fit(g, 'OPEN', x + w / 2, y + h * 0.52, w * 0.8, h * 0.6, '#fff'); }, 2.2],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); fit(g, 'פתוח', x + w / 2, y + h * 0.52, w * 0.7, h * 0.6, '#1e6a2a'); }, 2.2],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); fit(g, 'שעות פתיחה', x + w / 2, y + h * 0.14, w * 0.8, h * 0.09, '#111'); lines(g, x + w * 0.15, y + h * 0.3, w * 0.7, 7, 'rgba(20,20,20,0.75)', h * 0.085); }, 0.72],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#1e3f7a'); g.fillStyle = '#f4f2ec'; g.fillRect(x + w * 0.2, y + h * 0.25, w * 0.6, h * 0.36); g.fillStyle = '#1e3f7a'; g.fillRect(x + w * 0.2, y + h * 0.33, w * 0.6, h * 0.07); fit(g, 'CARDS', x + w / 2, y + h * 0.8, w * 0.7, h * 0.16, '#f4f2ec'); }, 1],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); fit(g, 'WiFi', x + w / 2, y + h * 0.55, w * 0.7, h * 0.4, '#1e5fa0'); }, 1],
  [(g, x, y, w, h) => { disc(g, x + w / 2, y + h / 2, w / 2, '#f4d01c'); fit(g, 'SALE', x + w / 2, y + h * 0.52, w * 0.7, h * 0.3, '#c8201a'); }, 1],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); g.strokeStyle = '#c8201a'; g.lineWidth = w * 0.08; g.beginPath(); g.ellipse(x + w / 2, y + h / 2, w * 0.36, h * 0.36, 0, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(x + w * 0.25, y + h * 0.25); g.lineTo(x + w * 0.75, y + h * 0.75); g.stroke(); g.fillStyle = '#111'; g.fillRect(x + w * 0.3, y + h * 0.47, w * 0.4, h * 0.07); }, 1],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#111'); fit(g, 'כניסה', x + w / 2, y + h * 0.52, w * 0.8, h * 0.55, '#f2efe6'); }, 2.2],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); fit(g, 'דחוף', x + w / 2, y + h * 0.52, w * 0.7, h * 0.6, '#111'); }, 2.2],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); fit(g, 'PULL', x + w / 2, y + h * 0.52, w * 0.7, h * 0.6, '#111'); }, 2.2],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#1f5fa8'); g.fillStyle = '#fff'; disc(g, x + w * 0.5, y + h * 0.22, w * 0.08, '#fff'); g.fillRect(x + w * 0.44, y + h * 0.32, w * 0.12, h * 0.3); g.lineWidth = w * 0.08; g.strokeStyle = '#fff'; g.beginPath(); g.arc(x + w * 0.5, y + h * 0.68, w * 0.2, 0.2, Math.PI * 1.4); g.stroke(); }, 1],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4d01c'); g.fillStyle = '#111'; g.fillRect(x + w * 0.25, y + h * 0.3, w * 0.36, h * 0.24); g.beginPath(); g.moveTo(x + w * 0.61, y + h * 0.36); g.lineTo(x + w * 0.78, y + h * 0.28); g.lineTo(x + w * 0.78, y + h * 0.56); g.lineTo(x + w * 0.61, y + h * 0.48); g.fill(); fit(g, 'CCTV', x + w / 2, y + h * 0.8, w * 0.6, h * 0.18, '#111'); }, 1],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#2e7d32'); fit(g, 'ברוכים הבאים', x + w / 2, y + h * 0.52, w * 0.86, h * 0.36, '#fff'); }, 2.2],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); const C = ['#1e3f9a', '#d01e1a', '#f4a01c', '#2e7d32']; for (let i = 0; i < 4; i++) { g.fillStyle = C[i]; g.fillRect(x + w * (0.08 + 0.22 * i), y + h * 0.3, w * 0.18, h * 0.4); } }, 2.2],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#fbfaf6'); hand(g, 'פתוח', x + w / 2, y + h * 0.5, w * 0.8, h * 0.55, '#c8201a', 77); }, 1.414],
  [(g, x, y, w, h) => { disc(g, x + w / 2, y + h / 2, w / 2, '#c8201a'); fit(g, '%', x + w / 2, y + h * 0.52, w * 0.6, h * 0.55, '#fff'); }, 1],
];
// Sale banners run along the top of a display window; 512 x 128 cells.
const BANNERS = [
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#c8201a'); fit(g, 'SALE  ·  SALE  ·  SALE', x + w / 2, y + h * 0.54, w * 0.92, h * 0.62, '#fff'); }, 4],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4d01c'); fit(g, 'מבצע  ·  מבצע  ·  מבצע', x + w / 2, y + h * 0.54, w * 0.92, h * 0.6, '#c8201a'); }, 4],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#151517'); fit(g, 'END OF SEASON SALE', x + w / 2, y + h * 0.54, w * 0.9, h * 0.5, '#f4d01c'); }, 4],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#f4f2ec'); fit(g, '-50%   -50%   -50%', x + w / 2, y + h * 0.54, w * 0.92, h * 0.62, '#d01e1a'); }, 4],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#1d2a44'); fit(g, 'NEW COLLECTION', x + w / 2, y + h * 0.54, w * 0.8, h * 0.5, '#f2efe6', 400, SERIF); }, 4],
  [(g, x, y, w, h) => { grad(g, x, y, w, h, '#4fc3f7', '#0288d1', true); fit(g, 'מבצעי קיץ  ·  SUMMER', x + w / 2, y + h * 0.54, w * 0.9, h * 0.56, '#fff'); }, 4],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#c2185b'); fit(g, 'עד 70% הנחה', x + w / 2, y + h * 0.54, w * 0.8, h * 0.6, '#fff'); }, 4],
  [(g, x, y, w, h) => { paper(g, x, y, w, h, '#e86a1a'); fit(g, '1+1  ·  1+1  ·  1+1', x + w / 2, y + h * 0.54, w * 0.92, h * 0.62, '#fff'); }, 4],
];

/** Window-dressing cells: kind 'posters' | 'prices' | 'stickers' | 'banners', index i (wraps). */
export function dressCell(kind, i) {
  const list = atlas.dress[kind];
  return list[((i % list.length) + list.length) % list.length];
}
/** Poster designs: [{cat, size, aspect}] in atlas order. */
export const POSTER_INFO = POSTERS.map(([, a, cat, size]) => ({ cat, size, aspect: a }));
export const N_PRICES = PRICES.length, N_STICKERS = STICKERS.length, N_BANNERS = BANNERS.length;

/**
 * A card of height h stuck to glass (or a wall) at local (x, y), facing +z at depth z: a
 * text-batch quad in full colour (vertex colour white).
 */
export function cardTpl(t, cell, x, y, h, z) {
  cellQuad(t, cell, x, y, h * cell.aspect, h, z);
}

/**
 * A sheet of paper taped to the glass: the card of height h at (x, y), turned by `tilt`
 * (rad), its face cockled (a few millimetres out of the plane, the shade varying with the
 * wrinkles); seed varies the wrinkles. Faces +z at depth z.
 */
export function sheetTpl(t, cell, x, y, h, z, tilt, seed, wrinkle = 1) {
  const w = h * cell.aspect, nx = wrinkle > 0 ? 3 : 1, ny = wrinkle > 0 ? 4 : 1;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const r = new RNG(seed);
  const ph = [r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28)];
  const b = t.count;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const u = i / nx, v = j / ny;
      const lx = (u - 0.5) * w, ly = (v - 0.5) * h;
      // cockling: low ridges across the sheet, the edges lifting a little off the glass
      const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
      const dz = wrinkle * (0.0012 * Math.sin(ly * 23 + ph[0] + lx * 4) + 0.0008 * Math.sin(lx * 31 + ph[1]) + 0.0015 * edge * edge);
      const gx = wrinkle * 0.06 * Math.cos(lx * 31 + ph[1]), gy = wrinkle * 0.08 * Math.cos(ly * 23 + ph[0] + lx * 4);
      const nl = Math.hypot(gx, gy, 1);
      const sh = 1 - wrinkle * (0.035 * (0.5 + 0.5 * Math.sin(ly * 23 + ph[0] + lx * 4 + 0.8)) + 0.02 * edge);
      t.v(x + lx * c - ly * s, y + lx * s + ly * c, z + dz, (-gx * c + gy * s) / nl, (-gx * s - gy * c) / nl, 1 / nl,
        cell.u0 + (cell.u1 - cell.u0) * u, cell.v0 + (cell.v1 - cell.v0) * v, sh);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = b + j * (nx + 1) + i;
      t.ix6(k, k + 1, k + nx + 2, k, k + nx + 2, k + nx + 1);
    }
  }
}

// Blade sign faces (draw function, shop type they advertise; null = not a shop).
const BLADE_FACES = [
  [(g, x, y) => { fill(g, '#f4f1e8', x, y); g.fillStyle = '#1f8a3a'; g.fillRect(x + 98, y + 48, 60, 160); g.fillRect(x + 48, y + 98, 160, 60); }, 'pharmacy'],
  [(g, x, y) => { fill(g, '#1b2b45', x, y); cup(g, x, y, '#e9dfc4'); }, 'cafe'],
  [(g, x, y) => { fill(g, '#5a1a1c', x, y); txt(g, 'BAR', x, y, '#e9c46a', 96); }, 'cafe'],
  [(g, x, y) => { fill(g, '#f2d24a', x, y); txt(g, 'קפה', x, y, '#1a1a1a', 110); }, 'cafe'],
  [(g, x, y) => { fill(g, '#1d1d1f', x, y); ring(g, x, y, '#d8b25a'); }, 'jewellery'],
  [(g, x, y) => { fill(g, '#24464a', x, y); txt(g, 'HOTEL', x, y, '#f2efe6', 64); }, null],
  [(g, x, y) => { fill(g, '#c8231c', x, y); txt(g, 'PIZZA', x, y, '#f4f1e8', 66); }, 'cafe'],
  [(g, x, y) => { fill(g, '#e8e4da', x, y); txt(g, 'ספרים', x, y, '#1b2b45', 84); }, 'books'],
  [(g, x, y) => { fill(g, '#e9e4d6', x, y); hanger(g, x, y, '#1d1d1f'); }, 'clothing'],
  [(g, x, y) => { fill(g, '#3b2a20', x, y); shoe(g, x, y, '#e9dfc4'); }, 'shoes'],
  [(g, x, y) => { fill(g, '#f2efe6', x, y); flower(g, x, y); }, 'flowers'],
  [(g, x, y) => { fill(g, '#1f3a2c', x, y); txt(g, 'GIFTS', x, y, '#e9c46a', 62); }, 'general'],
  [(g, x, y) => { fill(g, '#1b2b45', x, y); txt(g, 'BOOKS', x, y, '#f2efe6', 60); }, 'books'],
  [(g, x, y) => { fill(g, '#f4f1e8', x, y); txt(g, 'אופנה', x, y, '#5a1a1c', 84); }, 'clothing'],
  [(g, x, y) => { fill(g, '#24464a', x, y); txt(g, 'OPTICS', x, y, '#f2efe6', 56); }, 'jewellery'],
  [(g, x, y) => { fill(g, '#c49a42', x, y); txt(g, 'מתנות', x, y, '#1d1d1f', 84); }, 'general'],
  // round faces (discs: the corners stay transparent) and more square ones
  [(g, x, y) => { discFace(g, x, y, '#f4f1e8', '#1f8a3a'); g.fillStyle = '#1f8a3a'; g.fillRect(x + 104, y + 58, 48, 140); g.fillRect(x + 58, y + 104, 140, 48); }, 'pharmacy', true],
  [(g, x, y) => { discFace(g, x, y, '#4a2a18', '#e9dfc4'); cup(g, x + 4, y - 8, '#f2e6cc'); }, 'cafe', true],
  [(g, x, y) => { discFace(g, x, y, '#f7b8c8', '#ffffff'); cone(g, x, y); }, 'cafe', true],
  [(g, x, y) => { discFace(g, x, y, '#141416', '#d8b25a'); diamond(g, x, y, '#e8e4da'); }, 'jewellery', true],
  [(g, x, y) => { discFace(g, x, y, '#1f5fa8', '#f4f1e8'); phone(g, x, y, '#f4f1e8'); }, 'general', true],
  [(g, x, y) => { discFace(g, x, y, '#2a7a3a', '#f4f1e8'); tulip(g, x, y); }, 'flowers', true],
  [(g, x, y) => { discFace(g, x, y, '#c8231c', '#f4f1e8'); txt(g, 'SALE', x, y, '#f4f1e8', 70); }, 'clothing', true],
  [(g, x, y) => { discFace(g, x, y, '#e8b820', '#1d1d1f'); txt(g, '₪ $ €', x, y, '#1d1d1f', 54); }, 'jewellery', true],
  [(g, x, y) => { fill(g, '#1f5f8a', x, y); tee(g, x, y, '#f4f1e8'); }, 'clothing'],
  [(g, x, y) => { fill(g, '#c8231c', x, y); heel(g, x, y, '#f4f1e8'); }, 'shoes'],
  [(g, x, y) => { fill(g, '#2f6e3a', x, y); basket(g, x, y, '#f4f1e8'); }, 'general'],
  [(g, x, y) => { fill(g, '#5a1a1c', x, y); book(g, x, y, '#e9dfc4'); }, 'books'],
  [(g, x, y) => { fill(g, '#f2d24a', x, y); txt(g, 'פלאפל', x, y, '#b3261e', 92); }, 'cafe'],
  [(g, x, y) => { fill(g, '#e8701c', x, y); txt(g, 'פארם', x, y, '#f4f1e8', 100); }, 'pharmacy'],
  [(g, x, y) => { fill(g, '#1b2b45', x, y); watch(g, x, y, '#d8b25a'); }, 'jewellery'],
  [(g, x, y) => { discFace(g, x, y, '#1d3f7a', '#f4f1e8'); txt(g, 'HOTEL', x, y, '#f4f1e8', 58); }, null, true],
];

/** Round sign face: a disc with a rim; the corners of the cell stay transparent. */
function discFace(g, x, y, c, rim) {
  g.fillStyle = rim; g.beginPath(); g.arc(x + 128, y + 128, 122, 0, Math.PI * 2); g.fill();
  g.fillStyle = c; g.beginPath(); g.arc(x + 128, y + 128, 110, 0, Math.PI * 2); g.fill();
  const gr = g.createRadialGradient(x + 100, y + 96, 10, x + 128, y + 128, 112);
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = gr; g.beginPath(); g.arc(x + 128, y + 128, 110, 0, Math.PI * 2); g.fill();
}
function cone(g, x, y) {
  g.fillStyle = '#c8823a'; g.beginPath(); g.moveTo(x + 96, y + 128); g.lineTo(x + 160, y + 128); g.lineTo(x + 128, y + 212); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(90,50,20,0.6)'; g.lineWidth = 3;
  for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(x + 100 + k * 14, y + 132); g.lineTo(x + 128 + k * 6, y + 200); g.stroke(); }
  for (const [dx, dy, c] of [[-16, -6, '#f4e8d0'], [16, -6, '#8a4a2a'], [0, -34, '#e86a8a']]) { g.fillStyle = c; g.beginPath(); g.arc(x + 128 + dx, y + 118 + dy, 30, 0, Math.PI * 2); g.fill(); }
}
function diamond(g, x, y, c) {
  g.fillStyle = c; g.beginPath(); g.moveTo(x + 78, y + 104); g.lineTo(x + 100, y + 76); g.lineTo(x + 156, y + 76); g.lineTo(x + 178, y + 104); g.lineTo(x + 128, y + 182); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(x + 78, y + 104); g.lineTo(x + 178, y + 104); g.moveTo(x + 112, y + 76); g.lineTo(x + 104, y + 104); g.lineTo(x + 128, y + 182); g.lineTo(x + 152, y + 104); g.lineTo(x + 144, y + 76); g.stroke();
}
function phone(g, x, y, c) {
  g.fillStyle = c; roundRect(g, x + 98, y + 60, 60, 120, 10); g.fill();
  g.fillStyle = '#1f5fa8'; g.fillRect(x + 106, y + 74, 44, 82);
  g.fillStyle = c; g.beginPath(); g.arc(x + 128, y + 168, 5, 0, Math.PI * 2); g.fill();
}
function tulip(g, x, y) {
  g.strokeStyle = '#d8e8b0'; g.lineWidth = 8; g.beginPath(); g.moveTo(x + 128, y + 128); g.lineTo(x + 128, y + 200); g.stroke();
  g.fillStyle = '#d8e8b0'; g.beginPath(); g.ellipse(x + 104, y + 176, 22, 9, -0.6, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f2d24a'; g.beginPath(); g.moveTo(x + 98, y + 80); g.lineTo(x + 112, y + 100); g.lineTo(x + 128, y + 74); g.lineTo(x + 144, y + 100); g.lineTo(x + 158, y + 80); g.lineTo(x + 156, y + 120); g.quadraticCurveTo(x + 128, y + 148, x + 100, y + 120); g.closePath(); g.fill();
}
function tee(g, x, y, c) {
  g.fillStyle = c; g.beginPath();
  g.moveTo(x + 100, y + 62); g.quadraticCurveTo(x + 128, y + 80, x + 156, y + 62); g.lineTo(x + 206, y + 92); g.lineTo(x + 186, y + 124); g.lineTo(x + 168, y + 112);
  g.lineTo(x + 168, y + 196); g.lineTo(x + 88, y + 196); g.lineTo(x + 88, y + 112); g.lineTo(x + 70, y + 124); g.lineTo(x + 50, y + 92); g.closePath(); g.fill();
}
function heel(g, x, y, c) {
  g.fillStyle = c; g.beginPath();
  g.moveTo(x + 60, y + 104); g.quadraticCurveTo(x + 70, y + 92, x + 84, y + 100); g.quadraticCurveTo(x + 120, y + 150, x + 176, y + 152);
  g.quadraticCurveTo(x + 204, y + 156, x + 206, y + 176); g.lineTo(x + 120, y + 176); g.quadraticCurveTo(x + 96, y + 150, x + 78, y + 132); g.lineTo(x + 74, y + 190); g.lineTo(x + 66, y + 190); g.closePath(); g.fill();
}
function basket(g, x, y, c) {
  g.strokeStyle = c; g.fillStyle = c; g.lineWidth = 10; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x + 64, y + 104); g.lineTo(x + 192, y + 104); g.lineTo(x + 176, y + 180); g.lineTo(x + 80, y + 180); g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(x + 96, y + 104); g.lineTo(x + 120, y + 62); g.moveTo(x + 160, y + 104); g.lineTo(x + 136, y + 62); g.stroke();
  for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(x + 64 + k * 32, y + 110); g.lineTo(x + 70 + k * 29, y + 176); g.stroke(); }
}
function book(g, x, y, c) {
  g.fillStyle = c; g.beginPath(); g.moveTo(x + 128, y + 92); g.quadraticCurveTo(x + 92, y + 72, x + 52, y + 80); g.lineTo(x + 52, y + 180); g.quadraticCurveTo(x + 92, y + 172, x + 128, y + 190);
  g.quadraticCurveTo(x + 164, y + 172, x + 204, y + 180); g.lineTo(x + 204, y + 80); g.quadraticCurveTo(x + 164, y + 72, x + 128, y + 92); g.closePath(); g.fill();
  g.strokeStyle = '#5a1a1c'; g.lineWidth = 4; g.beginPath(); g.moveTo(x + 128, y + 94); g.lineTo(x + 128, y + 186); g.stroke();
}
function watch(g, x, y, c) {
  g.fillStyle = c; g.fillRect(x + 108, y + 46, 40, 164);
  g.beginPath(); g.arc(x + 128, y + 128, 48, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f4f1e8'; g.beginPath(); g.arc(x + 128, y + 128, 38, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#1d1d1f'; g.lineWidth = 5; g.beginPath(); g.moveTo(x + 128, y + 128); g.lineTo(x + 128, y + 100); g.moveTo(x + 128, y + 128); g.lineTo(x + 148, y + 136); g.stroke();
}

// ------------------------------------------------------------------ goods-stand prints
// Folded newspapers and magazines for the racks (portrait 120 x 248 px: the top half of a
// folded paper with its masthead and a photograph, or a magazine cover), and cardboard
// price tags for produce and sale bins (hand-lettered with a marker).
const PAPER_INK = ['#1a1a1a', '#b3261e', '#1b3a8a', '#1a1a1a'];
const PAPERS = Array.from({ length: 16 }, (_, i) => (g, x, y, w, h) => {
  const r = new RNG(9100 + i);
  if (i < 9) {
    // newspaper: masthead, headline, a photograph, columns of small print
    paper(g, x, y, w, h, '#ece8dc');
    const ink = PAPER_INK[i % 4];
    fit(g, ['חדשות', 'הבוקר', 'השבוע', 'יומון', 'CITY NEWS', 'DAILY', 'כלכלה', 'ספורט', 'ערב'][i], x + w / 2, y + h * 0.07, w * 0.86, h * 0.07, ink, 700, i % 2 ? SERIF : SANS);
    g.fillStyle = ink; g.fillRect(x + w * 0.06, y + h * 0.125, w * 0.88, 2);
    hand(g, r.pick(['הבחירות', 'מחר', 'BREAKING', 'הכותרת', 'גשם', 'MARKETS']), x + w / 2, y + h * 0.18, w * 0.82, h * 0.045, '#1a1a1a', i + 3);
    const ph = r.pick(['#7a8a9a', '#9a7a5a', '#5a6a4a', '#8a5a4a']);
    grad(g, x + w * 0.06, y + h * 0.23, w * 0.88, h * 0.22, ph, '#3a3a3a');
    disc(g, x + w * r.range(0.3, 0.7), y + h * 0.32, w * 0.1, 'rgba(230,200,170,0.8)');
    linesR(g, x + w * 0.06, y + h * 0.48, w * 0.42, 14, 'rgba(30,30,30,0.55)', h * 0.026);
    linesR(g, x + w * 0.52, y + h * 0.48, w * 0.42, 14, 'rgba(30,30,30,0.55)', h * 0.026);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, y + h * 0.5 - 1, w, 2);    // the fold
  } else {
    // magazine cover: a studio portrait full bleed (soft-focus skin, hair and clothes, a
    // backdrop falling off), the masthead across the top behind the head, a column of
    // cover lines in two weights, a coloured flash and the barcode
    const back = r.pick([['#d8c8b8', '#9a8878'], ['#a8c0d8', '#5a7088'], ['#e8d090', '#b08840'], ['#b8d0c0', '#6a8a78'], ['#e8b8b0', '#a87068'], ['#3a3a40', '#141418'], ['#f0ece4', '#c8c0b4']]);
    const gr = g.createRadialGradient(x + w * 0.55, y + h * 0.4, 4, x + w * 0.5, y + h * 0.5, h * 0.7);
    gr.addColorStop(0, back[0]); gr.addColorStop(1, back[1]); g.fillStyle = gr; g.fillRect(x, y, w, h);
    const skin = r.pick(['#e8c0a0', '#d8a888', '#c08868', '#8a5a40', '#f0d0b8']), hair = r.pick(['#2a1e18', '#4a3020', '#8a6040', '#c8a060', '#141010', '#6a2a1a']);
    const cloth = r.pick(['#b8261e', '#1d2a44', '#f2efe6', '#2f6e3a', '#e0a81c', '#141414', '#c2185b', '#6a8ab8']);
    const hx = x + w * r.range(0.42, 0.6), hy = y + h * r.range(0.3, 0.36), hr = w * r.range(0.2, 0.26);
    g.save();
    g.filter = 'blur(1.6px)';
    // shoulders and garment, neck, hair mass behind the face, the face lit from one side
    g.fillStyle = cloth; g.beginPath(); g.ellipse(hx, y + h * 0.92, w * 0.62, h * 0.32, 0, Math.PI, Math.PI * 2); g.fill(); g.fillRect(x, y + h * 0.9, w, h * 0.1);
    g.fillStyle = skin; g.fillRect(hx - hr * 0.36, hy + hr * 0.7, hr * 0.72, h * 0.18);
    g.fillStyle = hair; g.beginPath(); g.ellipse(hx, hy - hr * 0.08, hr * 1.18, hr * 1.32, 0, 0, Math.PI * 2); g.fill();
    if (r.chance(0.6)) { g.beginPath(); g.ellipse(hx + hr * 0.7, hy + hr * 1.3, hr * 0.5, hr * 1.4, -0.2, 0, Math.PI * 2); g.fill(); }
    const fg = g.createLinearGradient(hx - hr, hy, hx + hr, hy);
    fg.addColorStop(0, skin); fg.addColorStop(1, 'rgba(60,30,20,0.9)');
    g.fillStyle = skin; g.beginPath(); g.ellipse(hx, hy + hr * 0.12, hr * 0.78, hr, 0, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 0.35; g.fillStyle = fg; g.beginPath(); g.ellipse(hx, hy + hr * 0.12, hr * 0.78, hr, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    g.fillStyle = 'rgba(40,24,20,0.75)';
    for (const s of [-1, 1]) { g.beginPath(); g.ellipse(hx + s * hr * 0.32, hy, hr * 0.12, hr * 0.06, 0, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = 'rgba(150,50,50,0.7)'; g.beginPath(); g.ellipse(hx, hy + hr * 0.55, hr * 0.22, hr * 0.07, 0, 0, Math.PI * 2); g.fill();
    g.filter = 'none';
    g.restore();
    // masthead (behind the head's top on some covers), cover lines, a flash, the barcode
    const ink = back[0] === '#3a3a40' ? '#f4f2ec' : r.pick(['#c8201a', '#1a1a1a', '#f4f2ec']);
    fit(g, ['MODA', 'בית', 'STYLE', 'HOME', 'מטבח', 'CHEF', 'TRAVEL'][i - 9], x + w / 2, y + h * 0.085, w * 0.94, h * 0.13, ink, 900, SERIF);
    g.fillStyle = ink === '#1a1a1a' ? 'rgba(20,20,20,0.85)' : 'rgba(250,248,240,0.92)';
    for (let k = 0; k < 7; k++) g.fillRect(x + w * 0.05, y + h * (0.52 + k * 0.045), w * (0.18 + 0.16 * r.next()), Math.max(1.5, h * (k % 3 === 0 ? 0.022 : 0.012)));
    fit(g, r.pick(['קיץ 2026', 'NEW', '50 מתכונים', 'SPECIAL', 'מהדורה מיוחדת']), x + w * 0.3, y + h * 0.47, w * 0.5, h * 0.04, ink === '#1a1a1a' ? '#c8201a' : '#ffe066');
    if (r.chance(0.6)) { disc(g, x + w * 0.8, y + h * 0.66, w * 0.12, r.pick(['#ffe066', '#c8201a', '#f4f2ec'])); fit(g, '₪' + r.int(19, 39), x + w * 0.8, y + h * 0.66, w * 0.16, h * 0.035, '#1a1a1a'); }
    g.fillStyle = '#fff'; g.fillRect(x + w * 0.68, y + h * 0.88, w * 0.26, h * 0.08);
    g.fillStyle = '#111'; for (let k = 0; k < 14; k++) g.fillRect(x + w * (0.7 + k * 0.016), y + h * 0.895, w * (k % 3 ? 0.006 : 0.01), h * 0.055);
  }
});
// Price tags: [draw, aspect]; cardboard or fluorescent card, a price in marker
const TAG_DEFS = [['#d8c09a', '5.90'], ['#f6d21c', '9.90'], ['#ece8dc', '12'], ['#d8c09a', '7.90'], ['#ff8a1c', '3 ב-10'], ['#ece8dc', '19.90'], ['#b8e02a', '4.90'], ['#d8c09a', '14'],
  ['#ff6fa8', '2 ב-20'], ['#ece8dc', '6.90'], ['#f6d21c', '29'], ['#d8c09a', '8.90'], ['#ece8dc', '49'], ['#7fe3f0', '25'], ['#d8c09a', '3.90'], ['#f6d21c', '1+1']];
const TAGS = TAG_DEFS.map(([bg, num], i) => [(g, x, y, w, h) => {
  paper(g, x, y, w, h, bg);
  if (bg === '#d8c09a') { g.fillStyle = 'rgba(120,90,50,0.18)'; for (let k = 0; k < 5; k++) g.fillRect(x, y + h * (0.1 + k * 0.2), w, 1.5); }   // corrugation
  hand(g, num, x + w / 2, y + h * 0.48, w * 0.86, h * 0.48, i % 3 === 1 ? '#1b3a8a' : '#c8201a', 200 + i);
  hand(g, i % 2 ? 'לק"ג' : '₪', x + w * 0.5, y + h * 0.84, w * 0.5, h * 0.16, '#1a1a1a', 300 + i);
}, 1.35]);

function hanger(g, x, y, c) {
  g.strokeStyle = c; g.lineWidth = 11; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); g.arc(x + 128, y + 82, 18, Math.PI, Math.PI * 2.25); g.stroke();
  g.beginPath(); g.moveTo(x + 128, y + 104); g.lineTo(x + 48, y + 170); g.lineTo(x + 208, y + 170); g.closePath(); g.stroke();
}
function shoe(g, x, y, c) {
  g.fillStyle = c; g.beginPath();
  g.moveTo(x + 50, y + 170); g.lineTo(x + 50, y + 92); g.lineTo(x + 102, y + 92); g.quadraticCurveTo(x + 112, y + 128, x + 150, y + 134);
  g.quadraticCurveTo(x + 214, y + 142, x + 210, y + 170); g.closePath(); g.fill();
  g.fillRect(x + 46, y + 176, 168, 10);
}
function flower(g, x, y) {
  g.strokeStyle = '#2d6a35'; g.lineWidth = 10; g.beginPath(); g.moveTo(x + 128, y + 128); g.lineTo(x + 128, y + 212); g.stroke();
  g.fillStyle = '#c8231c';
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; g.beginPath(); g.arc(x + 128 + Math.cos(a) * 34, y + 98 + Math.sin(a) * 34, 26, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#f2d24a'; g.beginPath(); g.arc(x + 128, y + 98, 22, 0, Math.PI * 2); g.fill();
}

// ------------------------------------------------------------------ logo marks
// White silhouettes in a 128 px cell (x, y its corner), tinted by the sign's accent colour:
// cup, ring bread, cut stone, watch, spectacles, hanger, tee, shoe, open book, flower,
// cross, phone, crown, star, leaf sprig; the last cell is solid (tinted panels).
const cut = (g, fn) => { g.save(); g.globalCompositeOperation = 'destination-out'; fn(); g.restore(); };
const ICON_DRAW = [
  (g, x, y) => {   // cup and saucer with steam
    g.beginPath(); g.moveTo(x + 30, y + 52); g.lineTo(x + 92, y + 52); g.quadraticCurveTo(x + 90, y + 98, x + 61, y + 100); g.quadraticCurveTo(x + 32, y + 98, x + 30, y + 52); g.fill();
    g.lineWidth = 7; g.beginPath(); g.arc(x + 94, y + 68, 11, -1.5, 1.6); g.stroke();
    g.beginPath(); g.ellipse(x + 61, y + 106, 42, 6, 0, 0, Math.PI * 2); g.fill();
    g.lineWidth = 5; g.lineCap = 'round';
    for (const dx of [-12, 2, 16]) { g.beginPath(); g.moveTo(x + 58 + dx, y + 44); g.bezierCurveTo(x + 50 + dx, y + 34, x + 66 + dx, y + 28, x + 58 + dx, y + 16); g.stroke(); }
  },
  (g, x, y) => {   // ring bread with sesame
    g.beginPath(); g.ellipse(x + 64, y + 66, 50, 40, 0, 0, Math.PI * 2); g.fill();
    cut(g, () => { g.beginPath(); g.ellipse(x + 64, y + 66, 22, 15, 0, 0, Math.PI * 2); g.fill(); for (let k = 0; k < 22; k++) { const a = k * 2.4, r = 30 + (k % 3) * 6; g.beginPath(); g.ellipse(x + 64 + Math.cos(a) * r, y + 66 + Math.sin(a) * r * 0.8, 2.6, 1.4, a, 0, Math.PI * 2); g.fill(); } });
  },
  (g, x, y) => {   // brilliant-cut stone
    g.beginPath(); g.moveTo(x + 18, y + 48); g.lineTo(x + 38, y + 24); g.lineTo(x + 90, y + 24); g.lineTo(x + 110, y + 48); g.lineTo(x + 64, y + 110); g.closePath(); g.fill();
    cut(g, () => { g.lineWidth = 3; g.beginPath(); g.moveTo(x + 18, y + 48); g.lineTo(x + 110, y + 48); g.moveTo(x + 50, y + 24); g.lineTo(x + 42, y + 48); g.lineTo(x + 64, y + 108); g.lineTo(x + 86, y + 48); g.lineTo(x + 78, y + 24); g.stroke(); });
  },
  (g, x, y) => {   // wristwatch
    g.fillRect(x + 50, y + 8, 28, 112);
    g.beginPath(); g.arc(x + 64, y + 64, 32, 0, Math.PI * 2); g.fill();
    cut(g, () => { g.beginPath(); g.arc(x + 64, y + 64, 24, 0, Math.PI * 2); g.fill(); });
    g.lineWidth = 4; g.beginPath(); g.moveTo(x + 64, y + 64); g.lineTo(x + 64, y + 46); g.moveTo(x + 64, y + 64); g.lineTo(x + 77, y + 70); g.stroke();
  },
  (g, x, y) => {   // spectacles
    g.lineWidth = 9;
    for (const cx of [38, 90]) { g.beginPath(); g.ellipse(x + cx, y + 70, 22, 18, 0, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(x + 58, y + 64); g.quadraticCurveTo(x + 64, y + 56, x + 70, y + 64); g.stroke();
    g.beginPath(); g.moveTo(x + 16, y + 64); g.lineTo(x + 6, y + 52); g.moveTo(x + 112, y + 64); g.lineTo(x + 122, y + 52); g.stroke();
  },
  (g, x, y) => {   // coat hanger
    g.lineWidth = 8; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); g.arc(x + 64, y + 30, 11, Math.PI, Math.PI * 2.3); g.stroke();
    g.beginPath(); g.moveTo(x + 64, y + 44); g.lineTo(x + 12, y + 92); g.lineTo(x + 116, y + 92); g.closePath(); g.stroke();
  },
  (g, x, y) => {   // tee
    g.beginPath(); g.moveTo(x + 46, y + 22); g.quadraticCurveTo(x + 64, y + 34, x + 82, y + 22); g.lineTo(x + 116, y + 42); g.lineTo(x + 102, y + 64); g.lineTo(x + 90, y + 56);
    g.lineTo(x + 90, y + 112); g.lineTo(x + 38, y + 112); g.lineTo(x + 38, y + 56); g.lineTo(x + 26, y + 64); g.lineTo(x + 12, y + 42); g.closePath(); g.fill();
  },
  (g, x, y) => {   // shoe
    g.beginPath(); g.moveTo(x + 10, y + 92); g.lineTo(x + 12, y + 46); g.lineTo(x + 44, y + 44); g.quadraticCurveTo(x + 52, y + 64, x + 78, y + 68);
    g.quadraticCurveTo(x + 118, y + 74, x + 118, y + 92); g.closePath(); g.fill(); g.fillRect(x + 8, y + 96, 112, 7);
  },
  (g, x, y) => {   // open book
    g.beginPath(); g.moveTo(x + 64, y + 40); g.quadraticCurveTo(x + 40, y + 28, x + 10, y + 34); g.lineTo(x + 10, y + 100); g.quadraticCurveTo(x + 40, y + 94, x + 64, y + 108);
    g.quadraticCurveTo(x + 88, y + 94, x + 118, y + 100); g.lineTo(x + 118, y + 34); g.quadraticCurveTo(x + 88, y + 28, x + 64, y + 40); g.closePath(); g.fill();
    cut(g, () => { g.lineWidth = 3; g.beginPath(); g.moveTo(x + 64, y + 42); g.lineTo(x + 64, y + 104); g.stroke(); });
  },
  (g, x, y) => {   // flower
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; g.beginPath(); g.ellipse(x + 64 + Math.cos(a) * 24, y + 50 + Math.sin(a) * 24, 17, 11, a, 0, Math.PI * 2); g.fill(); }
    cut(g, () => { g.beginPath(); g.arc(x + 64, y + 50, 9, 0, Math.PI * 2); g.fill(); });
    g.lineWidth = 6; g.beginPath(); g.moveTo(x + 64, y + 76); g.quadraticCurveTo(x + 60, y + 100, x + 66, y + 122); g.stroke();
    g.beginPath(); g.ellipse(x + 48, y + 102, 13, 6, -0.5, 0, Math.PI * 2); g.fill();
  },
  (g, x, y) => { g.fillRect(x + 46, y + 14, 36, 100); g.fillRect(x + 14, y + 46, 100, 36); },   // cross
  (g, x, y) => {   // phone
    roundRect(g, x + 36, y + 10, 56, 108, 10); g.fill();
    cut(g, () => { g.fillRect(x + 42, y + 22, 44, 78); g.beginPath(); g.arc(x + 64, y + 109, 4, 0, Math.PI * 2); g.fill(); });
  },
  (g, x, y) => {   // crown
    g.beginPath(); g.moveTo(x + 14, y + 98); g.lineTo(x + 10, y + 38); g.lineTo(x + 38, y + 66); g.lineTo(x + 64, y + 26); g.lineTo(x + 90, y + 66); g.lineTo(x + 118, y + 38); g.lineTo(x + 114, y + 98); g.closePath(); g.fill();
    g.fillRect(x + 14, y + 104, 100, 10);
    for (const [cx, cy] of [[10, 34], [64, 20], [118, 34]]) { g.beginPath(); g.arc(x + cx, y + cy, 6, 0, Math.PI * 2); g.fill(); }
  },
  (g, x, y) => {   // six-pointed star
    for (const a0 of [-Math.PI / 2, Math.PI / 2]) { g.beginPath(); for (let k = 0; k < 3; k++) { const a = a0 + (k * 2 * Math.PI) / 3; g.lineTo(x + 64 + Math.cos(a) * 54, y + 66 + Math.sin(a) * 54); } g.closePath(); g.fill(); }
    cut(g, () => { g.lineWidth = 3; for (const a0 of [-Math.PI / 2, Math.PI / 2]) { g.beginPath(); for (let k = 0; k < 3; k++) { const a = a0 + (k * 2 * Math.PI) / 3; g.lineTo(x + 64 + Math.cos(a) * 40, y + 66 + Math.sin(a) * 40); } g.closePath(); g.stroke(); } });
  },
  (g, x, y) => {   // leaf sprig
    g.lineWidth = 5; g.beginPath(); g.moveTo(x + 24, y + 118); g.quadraticCurveTo(x + 60, y + 70, x + 104, y + 12); g.stroke();
    for (let k = 0; k < 5; k++) {
      const t = 0.15 + k * 0.17, px = x + 24 + 80 * t, py = y + 118 - 106 * t + 10 * t * (1 - t);
      for (const s of [-1, 1]) { g.beginPath(); g.ellipse(px + s * 14, py + 4, 15, 6, s * 0.7 - 0.6, 0, Math.PI * 2); g.fill(); }
    }
  },
  (g, x, y) => { g.fillRect(x + 24, y + 24, 80, 80); },   // solid (sampled inside)
];

/** A wall tag sprayed on a roller shutter (full colour, transparent ground), cell i. */
function wallTag(g, x, y, w, h, i) {
  const r = new RNG(5300 + i);
  const cols = ['#e8e4da', '#141414', '#c8231c', '#1f5fa8', '#e0a81c', '#2a7a3a', '#c2185b', '#7a3aa8'];
  const c1 = r.pick(cols), c2 = r.pick(cols.filter((c) => c !== c1));
  g.lineCap = 'round'; g.lineJoin = 'round';
  // a loose script of loops and slashes, outlined in a second colour
  const pts = [];
  let px = x + 14, py = y + h * 0.6;
  const n = r.int(5, 9);
  for (let k = 0; k < n; k++) {
    px += (w - 28) / n; py = y + h * r.range(0.25, 0.75);
    pts.push([px - r.range(0, 10), py, px + r.range(-18, 4), y + h * r.range(0.15, 0.85)]);
  }
  for (const [lw, col] of [[r.range(8, 11), c2], [r.range(4, 6), c1]]) {
    g.strokeStyle = col; g.lineWidth = lw;
    g.beginPath(); g.moveTo(x + 14, y + h * 0.6);
    for (const [ax, ay, bx, by] of pts) g.quadraticCurveTo(bx, by, ax, ay);
    g.stroke();
  }
  if (r.chance(0.5)) { g.fillStyle = c1; g.beginPath(); g.arc(px + 8, y + h * 0.3, 4, 0, Math.PI * 2); g.fill(); }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function fill(g, c, x, y) { g.fillStyle = c; g.fillRect(x, y, BLADE_W, BLADE_H); g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 10; g.strokeRect(x + 5, y + 5, BLADE_W - 10, BLADE_H - 10); }
function txt(g, s, x, y, c, px) {
  g.fillStyle = c; g.font = `700 ${px}px "Liberation Sans", "Noto Sans Hebrew", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const m = g.measureText(s), sx = Math.min(1, (BLADE_W - 40) / m.width);
  g.save(); g.translate(x + BLADE_W / 2, y + BLADE_H / 2 + 4); g.scale(sx, 1); g.fillText(s, 0, 0); g.restore();
}
function cup(g, x, y, c) {
  g.strokeStyle = c; g.fillStyle = c; g.lineWidth = 12;
  g.beginPath(); g.moveTo(x + 70, y + 100); g.lineTo(x + 80, y + 180); g.lineTo(x + 160, y + 180); g.lineTo(x + 170, y + 100); g.closePath(); g.fill();
  g.beginPath(); g.arc(x + 180, y + 135, 22, -1.4, 1.4); g.stroke();
  g.fillRect(x + 60, y + 190, 130, 10);
}
function ring(g, x, y, c) {
  g.strokeStyle = c; g.lineWidth = 14;
  g.beginPath(); g.arc(x + 128, y + 140, 55, 0, Math.PI * 2); g.stroke();
  g.fillStyle = c; g.beginPath(); g.moveTo(x + 128, y + 50); g.lineTo(x + 150, y + 80); g.lineTo(x + 128, y + 95); g.lineTo(x + 106, y + 80); g.closePath(); g.fill();
}

/** Glow attribute support: emissive = albedo × aGlow × (day level + night boost × gain). */
function addGlow(m, key, gain) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey() : '';
  m.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(m, shader, r);
    shader.uniforms.uNight = U.uNight;
    shader.uniforms.uEmGain = gain;
    shader.uniforms.uSignNight = SHOP_LEVEL.uSignNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uEmGain;\nuniform float uSignNight;\nvarying float vGlow;')
      // (at night the light boxes follow the exposure within a physical range: bright, but
      // their colour survives instead of burning out to a lemon or white patch)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * ( 0.04 * ( 1.0 - uNight ) + uSignNight * uNight * uEmGain );');
  };
  m.customProgramCacheKey = () => prevKey + '|' + key + '.v3';
  return m;
}

export function createSignMaterials(M) {
  if (!atlas) {
    const t0 = performance.now();
    atlas = buildAtlas();
    atlas.layoutMs = performance.now() - t0;
    // paint it in slices while the start-up continues (facades.update finishes it should
    // the first frame come first)
    const step = () => { if (!atlas.draw(6)) setTimeout(step, 0); };
    setTimeout(step, 0);
  }
  // a private variant of the library panel (keeps its baked surface), plus the glow hook
  const board = M.get('sign.panel', { vertexColors: true, color: new THREE.Color(1, 1, 1), userData: { owner: 'facades.signBoard' } });
  const gain = (M.uniforms && M.uniforms.emissiveGain) || { value: 1 };
  addGlow(board, 'facades.signBoard.v2', gain);
  const text = new THREE.MeshStandardMaterial({
    map: atlas.tex, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.4, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  text.name = 'facades.signText';
  addGlow(text, 'facades.signText.v2', gain);
  return { board, text, atlas };
}

// ------------------------------------------------------------------ geometry
/**
 * Text quad (atlas cell) in local xy at depth z, width w, height h, centred at (cx, cy);
 * sb: shade of its lower edge (the grime a sign collects along its bottom).
 */
function cellQuad(t, cell, cx, cy, w, h, z, normalZ = 1, sb = 1) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const b = t.count;
  const s = normalZ;
  // u is mirrored for back faces so the text reads correctly from both sides
  const uA = s > 0 ? cell.u0 : cell.u1, uB = s > 0 ? cell.u1 : cell.u0;
  const xa = s > 0 ? x0 : x1, xb = s > 0 ? x1 : x0;
  t.v(xa, y0, z, 0, 0, s, uA, cell.v0, sb); t.v(xb, y0, z, 0, 0, s, uB, cell.v0, sb);
  t.v(xb, y1, z, 0, 0, s, uB, cell.v1); t.v(xa, y1, z, 0, 0, s, uA, cell.v1);
  t.ix6(b, b + 1, b + 2, b, b + 2, b + 3);
}

/** Crop a text cell to its inked width so the quad keeps the glyph aspect. */
function inkCell(cell) {
  const du = (cell.u1 - cell.u0) * (1 - cell.ink) / 2;
  return { u0: cell.u0 + du, u1: cell.u1 - du, v0: cell.v0, v1: cell.v1, aspect: cell.aspect * cell.ink };
}

/** The name cell of a design: both lines (nv 0), the Hebrew (1) or the English (2) alone. */
function nameCell(design, single = false) {
  const n = atlas.names[((design.name % N_NAMES) + N_NAMES) % N_NAMES];
  const nv = single && design.nv === 0 ? 1 : design.nv;
  return nv === 1 ? n.he : nv === 2 ? n.en : n.full;
}
/** The second line of a design: a trade word ({w}) or a short line ({l}), or null. */
function subCell(sub) {
  if (!sub) return null;
  if (sub.w != null) return inkCell(atlas.cells[sub.w]);
  return atlas.lines[sub.l];
}
/** Logo mark i, solid cell 15. */
export function iconCell(i) { return atlas.icons[i]; }
/** Short-line cell i (phones, years, taglines; 24-31 wall tags). */
export function lineCell(i) { return atlas.lines[i % atlas.lines.length]; }

/**
 * Lay out a shop's sign text in a W × H area centred at (0, 0) of a face: its name, below
 * it a smaller second line, and the logo mark at one end when the area is wide enough.
 * compact: the name alone on one line (valances, vinyl). Returns quads
 * [{cell, x, y, w, h, accent}] (accent: drawn in the accent colour).
 */
function layoutText(design, Wa, Ha, compact = false) {
  const out = [];
  if (design.name == null) {
    const cell = inkCell(atlas.cells[design.cell]);
    const tw = Math.min(Wa, Ha * cell.aspect);
    out.push({ cell, x: 0, y: 0, w: tw, h: tw / cell.aspect });
    return out;
  }
  const nc = nameCell(design, compact && Ha < 0.3);
  let wA = Wa, xc = 0;
  if (!compact && design.logo >= 0 && Wa / Ha > 2.4) {
    const s = Ha * 0.9, side = design.logoRight ? 1 : -1;
    out.push({ cell: atlas.icons[design.logo], x: side * (Wa / 2 - s / 2), y: 0, w: s, h: s, accent: true });
    wA = Wa - s * 1.25; xc = -side * s * 0.625;
  }
  const sc = compact ? null : subCell(design.sub);
  if (sc) {
    let hn = Ha * 0.64, hs = Ha * 0.24;
    const gap = Ha * 0.08;
    const wn = Math.min(wA, hn * nc.aspect); hn = wn / nc.aspect;
    const ws = Math.min(wA * 0.86, hs * sc.aspect); hs = ws / sc.aspect;
    const top = (hn + gap + hs) / 2;
    out.push({ cell: nc, x: xc, y: top - hn / 2, w: wn, h: hn });
    out.push({ cell: sc, x: xc, y: top - hn - gap - hs / 2, w: ws, h: hs, accent: !!design.subAccent });
  } else {
    const wn = Math.min(wA, Ha * nc.aspect);
    out.push({ cell: nc, x: xc, y: 0, w: wn, h: wn / nc.aspect });
  }
  return out;
}

/** Sign design for seed; kindHint forces board / lightbox / letters, shop a shop type's words. */
export function signDesign(seed, kindHint, shop = null) {
  const r = new RNG(seed);
  const type = kindHint || r.weighted([['board', 0.42], ['lightbox', 0.33], ['letters', 0.25]]);
  let cell = r.int(0, WORDS.length - 1);
  if (shop) {
    const ok = wordsOf(shop);
    if (ok.length) cell = ok[cell % ok.length];
  }
  let board, ink, glow;
  if (type === 'board') {
    board = r.weighted(BOARD_WEIGHTS);
    ink = inkOn(board, r);
    glow = 0;
  } else if (type === 'lightbox') {
    board = r.pick(SIGN_PALETTE.boxes);
    ink = luma(board) < 0.5 ? 0xf4f1e8 : r.pick([0x1d1d1f, 0xb3261e, 0x1b2b45]);
    glow = 1;
  } else {
    board = null;
    ink = r.pick(SIGN_PALETTE.letters);
    glow = r.chance(0.4) ? 0.6 : 0;
  }
  return { type, cell, board, ink, glow };
}
/** sRGB luma (0..1) of a hex colour. */
export function luma(hex) { return (0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)) / 255; }
/** Lettering colour for a board of colour hex: dark on light boards, cream, white or gold on dark ones. */
export function inkOn(hex, r) {
  const l = luma(hex);
  if (l > 0.62) return r.pick([0x1d1d1f, 0x1b2b45, 0x5a1a1c, 0xb3261e]);
  if (l > 0.42) return r.pick([0xf4f1e8, 0x1d1d1f]);
  const sat = Math.max((hex >> 16) & 255, (hex >> 8) & 255, hex & 255) - Math.min((hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
  return sat > 90 ? r.pick([0xf4f1e8, 0xf4f1e8, 0xf2c230]) : r.pick([0xd8b25a, 0xf2efe6, 0xe9dfc4]);
}

/**
 * Fascia sign of width w and height h centred at the local origin (x across, y up), the
 * wall face at z = 0: the board (its face dirtier towards the bottom edge), and the text
 * (the shop's name and second line) with the logo mark apart, for the accent colour.
 * {board, text, accent}.
 */
export function fasciaTpls(design, w, h, q, z0 = 0.055, compact = false) {
  // stand-off clear of the ground-floor relief (lintels, keystones, rustication: ≤ 5 cm)
  const tb = new Tpl(), tt = new Tpl(), ta = new Tpl();
  let zText;
  const g0 = q >= 0.5 ? 0.8 : 0.9;            // grime along the bottom of the face
  if (design.type === 'board') {
    const d = 0.05, b = 0.03;
    tb.box(-w / 2, -h / 2, z0, w / 2, h / 2, z0 + d, 1 | 4 | 8 | 16 | 32, 0.85 * g0, 0.95);
    if (q >= 0.5) {
      // raised moulded border
      tb.box(-w / 2, h / 2 - b, z0 + d, w / 2, h / 2, z0 + d + 0.012, 1 | 16 | 32, 0.9, 1);
      tb.box(-w / 2, -h / 2, z0 + d, w / 2, -h / 2 + b, z0 + d + 0.012, 1 | 16 | 32, 0.66, 0.78);
      tb.box(-w / 2, -h / 2 + b, z0 + d, -w / 2 + b, h / 2 - b, z0 + d + 0.012, 1 | 8, 0.8, 0.95);
      tb.box(w / 2 - b, -h / 2 + b, z0 + d, w / 2, h / 2 - b, z0 + d + 0.012, 1 | 4, 0.8, 0.95);
    }
    zText = z0 + d + 0.002;
  } else if (design.type === 'lightbox') {
    const d = 0.13;
    tb.box(-w / 2, -h / 2, z0, w / 2, h / 2, z0 + d, 1 | 4 | 8 | 16 | 32, 0.95 * g0, 1);
    zText = z0 + d + 0.002;
  } else {
    zText = z0 + 0.02;   // individual letters on stand-off pins
  }
  const k = design.type === 'letters' ? 0.95 : 0.78;
  const Wa = w * (design.type === 'letters' ? 0.96 : 0.9), Ha = h * k;
  for (const p of layoutText(design, Wa, Ha, compact)) {
    const sb = design.type === 'letters' ? 1 : 1 - (1 - g0) * Math.max(0, (h / 2 - (p.y - p.h / 2)) / h - 0.4);
    cellQuad(p.accent ? ta : tt, p.cell, p.x, p.y, p.w, p.h, zText, 1, sb);
  }
  return { board: design.board !== null ? tb.bake() : null, text: tt.bake(), accent: ta.count ? ta.bake() : (ta.free(), null) };
}

/** Blade face index advertising shop type `type` (null: no shop below, e.g. a hotel). */
export function bladeFace(seed, type, round = null) {
  const r = new RNG(seed);
  let ok = [];
  // (the red sale disc only one time in eight it is drawn)
  BLADE_FACES.forEach(([, t, rd], i) => { if (t === type && (round === null || !!rd === round) && (i !== SALE_FACE || r.chance(0.125))) ok.push(i); });
  if (!ok.length) BLADE_FACES.forEach(([, t, rd], i) => { if (t === null && (round === null || !!rd === round)) ok.push(i); });
  if (!ok.length) BLADE_FACES.forEach(([, t], i) => { if (t === null) ok.push(i); });
  return ok[r.int(0, ok.length - 1)];
}
const SALE_FACE = 22;
/** Trade a stock blade face advertises (null: none), and whether it is the sale disc. */
export const bladeTrade = (i) => BLADE_FACES[i][1];
export const isSaleFace = (i) => i === SALE_FACE;
/** Whether blade face i is round (a disc sign). */
export const bladeRound = (i) => !!BLADE_FACES[i][2];
/** Goods-stand print cells: kind 'papers' | 'tags', index i (wraps). */
export function printCell(kind, i) {
  const list = atlas.prints[kind];
  return list[((i % list.length) + list.length) % list.length];
}

/** Double-sided projecting blade sign with an iron bracket; origin on the wall face. */
export function bladeTpls(faceIndex, w, h, q) {
  const face = atlas.blades[faceIndex];
  const tb = new Tpl(), tt = new Tpl(), tm = new Tpl();
  const z0 = 0.18, z1 = z0 + w, th = 0.06;
  // panel edge (board batch), faces carry the atlas picture (text batch)
  tb.box(-th / 2, 0, z0, th / 2, h, z1, 1 | 2 | 16 | 32, 0.85, 0.95);
  // faces are in the yz plane: build in xy then rotate by swapping coordinates
  const quad = (sx) => {
    const b = tt.count, x = sx * (th / 2 + 0.002);
    const zA = sx > 0 ? z1 : z0, zB = sx > 0 ? z0 : z1;
    const sb = q >= 0.5 ? 0.82 : 0.9;
    tt.v(x, 0.02, zA, sx, 0, 0, face.u0, face.v0, sb); tt.v(x, 0.02, zB, sx, 0, 0, face.u1, face.v0, sb);
    tt.v(x, h - 0.02, zB, sx, 0, 0, face.u1, face.v1); tt.v(x, h - 0.02, zA, sx, 0, 0, face.u0, face.v1);
    tt.ix6(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  quad(1); quad(-1);
  bladeBracket(tm, h, z0, z1, q);
  return { board: tb.bake(), text: tt.bake(), metal: tm.bake() };
}
function bladeBracket(tm, h, z0, z1, q) {
  // bracket: wall plate and two arms (metal batch)
  tm.box(-0.05, h - 0.1, 0, 0.05, h + 0.12, 0.02, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  tm.box(-0.012, h + 0.03, 0.0, 0.012, h + 0.055, z1 + 0.05, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  if (q >= 0.5) {
    tm.box(-0.01, h - 0.03, 0.0, 0.01, h - 0.005, z0, 1 | 4 | 8 | 16 | 32, 0.9, 1);
    for (const zz of [z0 + 0.08, z1 - 0.08]) tm.box(-0.006, h, zz - 0.006, 0.006, h + 0.035, zz + 0.006, 4 | 8 | 1 | 2, 0.9, 1);
  }
}

/** Face quad in the yz plane at x = sx·xo facing ±x (u mirrored so it reads from both sides). */
function sideQuad(t, cell, sx, xo, y0, y1, zA0, zA1, sb = 1) {
  const b = t.count, x = sx * xo;
  const zA = sx > 0 ? zA1 : zA0, zB = sx > 0 ? zA0 : zA1;
  t.v(x, y0, zA, sx, 0, 0, cell.u0, cell.v0, sb); t.v(x, y0, zB, sx, 0, 0, cell.u1, cell.v0, sb);
  t.v(x, y1, zB, sx, 0, 0, cell.u1, cell.v1); t.v(x, y1, zA, sx, 0, 0, cell.u0, cell.v1);
  t.ix6(b, b + 1, b + 2, b, b + 2, b + 3);
}
/**
 * Quads of a face layout (x across the face as its reader sees it, y up) on both faces of
 * a projecting sign whose face plane is yz at x = ±xo, centred at (zc, yc): the reader
 * on +x has the wall on the right, so face x runs against z there and with z on −x.
 */
function sideLayout(tt, ta, quads, xo, zc, yc, sbK = 1, hh = 1) {
  for (const sx of [-1, 1]) {
    for (const p of quads) {
      const z = zc - sx * p.x, sb = 1 - (1 - sbK) * Math.min(1, Math.max(0, (hh / 2 - (p.y - p.h / 2)) / hh));
      sideQuad(p.accent ? ta : tt, p.cell, sx, xo, yc + p.y - p.h / 2, yc + p.y + p.h / 2, z - p.w / 2, z + p.w / 2, sb);
    }
  }
}

/**
 * Projecting light box with the shop's name on both faces ("flag" sign): a box of length
 * L out from the wall (from z0), height h and thickness th, on a wall plate with a top
 * arm; origin on the wall face, the box's bottom at y = 0. {board (glowing box), text,
 * accent, metal}.
 */
export function flagTpls(design, L, h, th, q) {
  const tb = new Tpl(), tt = new Tpl(), ta = new Tpl(), tm = new Tpl();
  const z0 = 0.16, z1 = z0 + L;
  tb.box(-th / 2, 0, z0, th / 2, h, z1, 1 | 2 | 4 | 8 | 16 | 32, 0.82, 1);
  if (q >= 0.5) {
    // the box's frame: a darker extruded rim round each face
    for (const sx of [-1, 1]) {
      const x0 = sx > 0 ? th / 2 : -th / 2 - 0.006, x1 = x0 + 0.006;
      tb.box(x0, 0, z0, x1, 0.025, z1, 1 | 2 | 4 | 8 | 16 | 32, 0.45, 0.5);
      tb.box(x0, h - 0.025, z0, x1, h, z1, 1 | 2 | 4 | 8 | 16 | 32, 0.6, 0.65);
      tb.box(x0, 0.025, z1 - 0.025, x1, h - 0.025, z1, 1 | 2 | 4 | 8 | 16 | 32, 0.55, 0.6);
    }
  }
  const quads = layoutText({ ...design, logo: -1 }, L * 0.84, h * (design.name != null && !design.sub ? 0.74 : 0.8));
  sideLayout(tt, ta, quads, th / 2 + 0.003, (z0 + z1) / 2, h / 2, q >= 0.5 ? 0.85 : 1, h);
  // wall plate, the arm along the top and a stay
  tm.box(-0.05, -0.04, 0, 0.05, h + 0.08, 0.02, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  tm.box(-0.014, h, 0.0, 0.014, h + 0.03, z1 - 0.04, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  if (q >= 0.5) tm.box(-0.012, -0.03, 0.0, 0.012, 0.0, z0 + 0.04, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  return { board: tb.bake(), text: tt.bake(), accent: ta.count ? ta.bake() : (ta.free(), null), metal: tm.bake() };
}

/**
 * Projecting blade of the shop's own: a painted panel w out from the wall and h tall
 * (its lower edge dirtier) carrying its logo mark above its name (or the name with its
 * second line). Origin on the wall face, the panel's bottom at y = 0. {board, text,
 * accent, metal}.
 */
export function bladeNameTpls(design, w, h, q) {
  const tb = new Tpl(), tt = new Tpl(), ta = new Tpl(), tm = new Tpl();
  const z0 = 0.18, z1 = z0 + w, th = 0.05;
  tb.box(-th / 2, 0, z0, th / 2, h, z1, 1 | 2 | 4 | 8 | 16 | 32, q >= 0.5 ? 0.74 : 0.85, 1);
  if (q >= 0.5) {
    // a painted border, proud of the faces
    for (const sx of [-1, 1]) {
      const x0 = sx > 0 ? th / 2 : -th / 2 - 0.004, x1 = x0 + 0.004, b = 0.022;
      tb.box(x0, 0, z0, x1, b, z1, 1 | 2 | 4 | 8 | 16 | 32, 0.6, 0.7);
      tb.box(x0, h - b, z0, x1, h, z1, 1 | 2 | 4 | 8 | 16 | 32, 0.9, 1);
      tb.box(x0, b, z0, x1, h - b, z0 + b, 1 | 2 | 4 | 8 | 16 | 32, 0.8, 0.95);
      tb.box(x0, b, z1 - b, x1, h - b, z1, 1 | 2 | 4 | 8 | 16 | 32, 0.8, 0.95);
    }
  }
  let quads;
  const Wf = w * 0.82;
  if (design.logo >= 0) {
    const s = Math.min(h * 0.42, w * 0.5);
    const nq = layoutText({ ...design, logo: -1, sub: null }, Wf, h * 0.36);
    for (const p of nq) p.y += h * 0.27 - h / 2;
    quads = [{ cell: atlas.icons[design.logo], x: 0, y: h * 0.7 - h / 2, w: s, h: s, accent: true }, ...nq];
  } else quads = layoutText({ ...design, logo: -1 }, Wf, h * 0.66);
  sideLayout(tt, ta, quads, th / 2 + 0.006, (z0 + z1) / 2, h / 2, q >= 0.5 ? 0.82 : 1, h);
  bladeBracket(tm, h, z0, z1, q);
  return { board: tb.bake(), text: tt.bake(), accent: ta.count ? ta.bake() : (ta.free(), null), metal: tm.bake() };
}

/**
 * Round projecting sign (blade face i drawn as a disc) of diameter D on a bracket arm:
 * a disc rim of thickness th, both faces from the atlas. Origin on the wall face, the
 * disc's lowest point at y = 0. {board, text, metal}. With a design instead of a face
 * index, the disc is painted in the board colour and carries the shop's logo mark over
 * its name ({board, text, accent, metal}).
 */
export function discTpls(faceIndex, D, q, design = null) {
  const face = design ? null : atlas.blades[faceIndex];
  const tb = new Tpl(), tt = new Tpl(), ta = new Tpl(), tm = new Tpl();
  const R = D / 2, th = 0.07, zc = 0.2 + R, yc = R;
  const n = q >= 0.5 ? 32 : 12;
  // rim (outward normals) and the two faces of the disc just inside the printed quads; the
  // faces darker towards the bottom (grime)
  const g0 = q >= 0.5 ? 0.8 : 0.9, sh = (y) => g0 + (1 - g0) * Math.min(1, y / D);
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
    const y0 = yc + Math.sin(a0) * R, z0 = zc + Math.cos(a0) * R, y1 = yc + Math.sin(a1) * R, z1 = zc + Math.cos(a1) * R;
    tb.q4(-th / 2, y0, z0, th / 2, y0, z0, th / 2, y1, z1, -th / 2, y1, z1, 0.85 * sh(y0), 0.85 * sh(y1));
    // (faces as fans: shade per vertex by height)
    const fb = tb.count;
    tb.v(th / 2 - 0.001, yc, zc, 1, 0, 0, zc, yc, 0.9 * sh(yc)); tb.v(th / 2 - 0.001, y1, z1, 1, 0, 0, z1, y1, 0.9 * sh(y1)); tb.v(th / 2 - 0.001, y0, z0, 1, 0, 0, z0, y0, 0.9 * sh(y0));
    tb.tri(fb, fb + 1, fb + 2);
    const fc = tb.count;
    tb.v(-th / 2 + 0.001, yc, zc, -1, 0, 0, zc, yc, 0.9 * sh(yc)); tb.v(-th / 2 + 0.001, y0, z0, -1, 0, 0, z0, y0, 0.9 * sh(y0)); tb.v(-th / 2 + 0.001, y1, z1, -1, 0, 0, z1, y1, 0.9 * sh(y1));
    tb.tri(fc, fc + 1, fc + 2);
  }
  if (face) {
    const s = 0.996 * D;
    for (const sx of [-1, 1]) sideQuad(tt, face, sx, th / 2 + 0.002, yc - s / 2, yc + s / 2, zc - s / 2, zc + s / 2, g0 + 0.05);
  } else {
    // a ring painted inside the rim, the logo mark above the middle and the name across it
    const quads = [];
    if (design.logo >= 0) quads.push({ cell: atlas.icons[design.logo], x: 0, y: D * 0.17, w: D * 0.36, h: D * 0.36, accent: true });
    const nq = layoutText({ ...design, logo: -1, sub: null }, D * 0.76, D * (design.logo >= 0 ? 0.22 : 0.4));
    for (const p of nq) p.y += design.logo >= 0 ? -D * 0.17 : 0;
    quads.push(...nq);
    sideLayout(tt, ta, quads, th / 2 + 0.003, zc, yc, q >= 0.5 ? 0.85 : 1, D);
  }
  // bracket: wall plate, an arm over the disc with two short hangers
  tm.box(-0.05, yc + R - 0.12, 0, 0.05, yc + R + 0.14, 0.02, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  tm.box(-0.013, yc + R + 0.06, 0.0, 0.013, yc + R + 0.09, zc + R * 0.7, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  if (q >= 0.5) for (const zz of [zc - R * 0.55, zc + R * 0.55]) tm.box(-0.005, yc + Math.sqrt(Math.max(0, R * R - (zz - zc) * (zz - zc))) - 0.01, zz - 0.005, 0.005, yc + R + 0.06, zz + 0.005, 4 | 8 | 1 | 2, 0.9, 1);
  return { board: tb.bake(), text: tt.bake(), accent: ta.count ? ta.bake() : (ta.free(), null), metal: tm.bake() };
}

/**
 * Lettering of a shop's design in a W × H area (centred at the origin, facing +z at z),
 * as vinyl on glass or paint on a panel: {text, accent} templates (accent null when the
 * layout has no logo mark).
 */
export function letteringTpls(design, Wa, Ha, z, compact = false) {
  const tt = new Tpl(), ta = new Tpl();
  for (const p of layoutText(design, Wa, Ha, compact)) cellQuad(p.accent ? ta : tt, p.cell, p.x, p.y, p.w, p.h, z);
  return { text: tt.bake(), accent: ta.count ? ta.bake() : (ta.free(), null) };
}
/** A plain quad of cell (icon, line or solid) w × h centred at (x, y), facing +z at z. */
export function cellTpl(t, cell, x, y, w, h, z, sb = 1) { cellQuad(t, cell, x, y, w, h, z, 1, sb); }
/** Enamel house number plaque (0.2 × 0.13 m) on the wall face. */
export function plaqueTpl(seed) {
  const p = atlas.plaques[seed % atlas.plaques.length];
  const t = new Tpl();
  cellQuad(t, p, 0, 0, 0.2, 0.13, 0.012);
  return t.bake();
}

export function signColor(hex) { return lin(hex); }
