import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { RNG } from '../../core/rng.js';
import { Tpl, lin } from './geo.js';
import { SHOP_LEVEL } from './interior.js';

// Shop signage: a canvas atlas of invented generic shop words (English and Hebrew), house
// number plaques, blade-sign faces and the shop window dressing (sale posters, price
// cards, door stickers), plus the geometry for fascia boards, light boxes, individual
// letters, projecting blade signs and the cards stuck to the glass. Text quads are white
// glyphs tinted by vertex colour (full-colour cells take white); `aGlow` makes light boxes
// and neon letters glow at dusk.

const W = 2048, H = 4096;
const CELL_W = 512, CELL_H = 128, TEXT_ROWS = 12;          // text cells: rows 0..11
const PLAQUE = 128, PLAQUE_Y = TEXT_ROWS * CELL_H;        // 2 rows of 16 number plaques
const BLADE_W = 256, BLADE_H = 256, BLADE_Y = PLAQUE_Y + 2 * PLAQUE; // 2 rows of 8 blade faces
const DRESS_Y = BLADE_Y + 2 * BLADE_H;                     // posters 5 rows of 8 (256 px), price cards and stickers a row of 16 (128 px) each, banners 2 rows of 4 (512 x 128)

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
];
/** Shop type implied by a sign's word cell. */
export const wordType = (cell) => WORDS[cell][1];
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
// painted fascia boards as on the street: mostly black, dark green, oxblood and navy
// enamel (gold or cream letters), a few pale, bright or wood-brown ones
const BOARD_WEIGHTS = [[0x1d1d1f, 0.2], [0x1f3a2c, 0.17], [0x5a1a1c, 0.14], [0x1b2b45, 0.12], [0x24464a, 0.07], [0x6b4a2a, 0.07],
  [0xd9cfb6, 0.05], [0xe8e4da, 0.04], [0xb8261e, 0.04], [0x1f5f8a, 0.04], [0x2f6e3a, 0.03], [0xe8b820, 0.03]];

let atlas = null;

function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const cells = [];
  // text cells: white glyphs on transparent
  WORDS.forEach(([lines], i) => {
    const cx = (i % 4) * CELL_W, cy = Math.floor(i / 4) * CELL_H;
    const font = FONTS[i % FONTS.length];
    g.save();
    g.beginPath(); g.rect(cx, cy, CELL_W, CELL_H); g.clip();
    g.fillStyle = '#fff';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let inkW = 0;
    if (lines.length === 1) {
      const px = 92;
      g.font = font(px);
      const m = g.measureText(lines[0]);
      const sx = Math.min(1, (CELL_W - 24) / m.width);
      g.translate(cx + CELL_W / 2, cy + CELL_H / 2 + 4);
      g.scale(sx, 1);
      g.fillText(lines[0], 0, 0);
      inkW = m.width * sx;
    } else {
      const px = 56;
      g.font = font(px);
      const m0 = g.measureText(lines[0]), m1 = g.measureText(lines[1]);
      const sx = Math.min(1, (CELL_W - 24) / Math.max(m0.width, m1.width));
      g.translate(cx + CELL_W / 2, cy + CELL_H / 2);
      g.scale(sx, 1);
      g.fillText(lines[0], 0, -30);
      g.font = font(44);
      g.fillText(lines[1], 0, 34);
      inkW = Math.max(m0.width, m1.width) * sx;
    }
    g.restore();
    cells.push({ u0: cx / W, v0: 1 - (cy + CELL_H) / H, u1: (cx + CELL_W) / W, v1: 1 - cy / H, aspect: CELL_W / CELL_H, ink: Math.min(1, (inkW + 30) / CELL_W), lines: lines.length });
  });
  // house number plaques: blue enamel with a white border and number
  const plaques = [];
  for (let i = 0; i < 32; i++) {
    const x = (i % 16) * PLAQUE, y = PLAQUE_Y + Math.floor(i / 16) * PLAQUE;
    g.save();
    g.fillStyle = '#e9e6dc'; roundRect(g, x + 8, y + 22, PLAQUE - 16, PLAQUE - 44, 14); g.fill();
    g.fillStyle = i % 5 === 3 ? '#2d5a3a' : '#1d3f7a'; roundRect(g, x + 14, y + 28, PLAQUE - 28, PLAQUE - 56, 10); g.fill();
    g.fillStyle = '#f2efe6'; g.font = '700 50px "Liberation Sans", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(1 + ((i * 7) % 63)), x + PLAQUE / 2, y + PLAQUE / 2 + 2);
    g.restore();
    plaques.push({ u0: x / W, v0: 1 - (y + PLAQUE - 22) / H, u1: (x + PLAQUE) / W, v1: 1 - (y + 22) / H });
  }
  // blade sign faces (full colour, generic pictograms)
  const blades = [];
  BLADE_FACES.forEach(([fn], i) => {
    const x = (i % 8) * BLADE_W, y = BLADE_Y + Math.floor(i / 8) * BLADE_H;
    g.save(); g.beginPath(); g.rect(x, y, BLADE_W, BLADE_H); g.clip(); fn(g, x, y); g.restore();
    blades.push({ u0: (x + 4) / W, v0: 1 - (y + BLADE_H - 4) / H, u1: (x + BLADE_W - 4) / W, v1: 1 - (y + 4) / H });
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
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); fn(g, x, y, w, h); g.restore();
      dress[key].push({ u0: (x + 1) / W, v0: 1 - (y + h - 1) / H, u1: (x + w - 1) / W, v1: 1 - (y + 1) / H, aspect: w / h });
    });
    yy += Math.ceil(list.length / per) * CH;
  }
  if (yy > H) console.warn('[facades] sign atlas overflow', yy);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, cells, plaques, blades, dress };
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
];

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
  if (!atlas) atlas = buildAtlas();
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
/** Text quad (atlas cell) in local xy at depth z, width w, height h, centred at (cx, cy). */
function cellQuad(t, cell, cx, cy, w, h, z, normalZ = 1) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const b = t.count;
  const s = normalZ;
  // u is mirrored for back faces so the text reads correctly from both sides
  const uA = s > 0 ? cell.u0 : cell.u1, uB = s > 0 ? cell.u1 : cell.u0;
  const xa = s > 0 ? x0 : x1, xb = s > 0 ? x1 : x0;
  t.v(xa, y0, z, 0, 0, s, uA, cell.v0); t.v(xb, y0, z, 0, 0, s, uB, cell.v0);
  t.v(xb, y1, z, 0, 0, s, uB, cell.v1); t.v(xa, y1, z, 0, 0, s, uA, cell.v1);
  t.ix6(b, b + 1, b + 2, b, b + 2, b + 3);
}

/** Crop a text cell to its inked width so the quad keeps the glyph aspect. */
function inkCell(cell) {
  const du = (cell.u1 - cell.u0) * (1 - cell.ink) / 2;
  return { u0: cell.u0 + du, u1: cell.u1 - du, v0: cell.v0, v1: cell.v1, aspect: cell.aspect * cell.ink };
}

/** Sign design for seed; kindHint forces board / lightbox / letters, shop a shop type's words. */
export function signDesign(seed, kindHint, shop = null) {
  const r = new RNG(seed);
  const type = kindHint || r.weighted([['board', 0.52], ['lightbox', 0.2], ['letters', 0.28]]);
  let cell = r.int(0, WORDS.length - 1);
  if (shop) {
    const ok = [];
    WORDS.forEach(([, t], i) => { if (t === shop) ok.push(i); });
    if (ok.length) cell = ok[cell % ok.length];
  }
  let board, ink, glow;
  if (type === 'board') {
    board = r.weighted(BOARD_WEIGHTS);
    const light = board === 0xd9cfb6 || board === 0xe8e4da;
    ink = light ? r.pick([0x1d1d1f, 0x1b2b45, 0x5a1a1c]) : r.pick([0xd8b25a, 0xf2efe6, 0xe9dfc4]);
    glow = 0;
  } else if (type === 'lightbox') {
    board = r.pick(SIGN_PALETTE.boxes);
    ink = board === 0xc8231c || board === 0x1f5fa8 || board === 0x2a7a3a ? 0xf4f1e8 : r.pick([0x1d1d1f, 0xb3261e, 0x1b2b45]);
    glow = 1;
  } else {
    board = null;
    ink = r.pick(SIGN_PALETTE.letters);
    glow = r.chance(0.4) ? 0.6 : 0;
  }
  return { type, cell, board, ink, glow };
}

/**
 * Fascia sign of width w and height h centred at the local origin (x across, y up), the
 * wall face at z = 0. Adds to the `board` and `text` batches via callbacks.
 */
export function fasciaTpls(design, w, h, q, z0 = 0.055) {
  // stand-off clear of the ground-floor relief (lintels, keystones, rustication: ≤ 5 cm)
  const tb = new Tpl(), tt = new Tpl();
  const cell = inkCell(atlas.cells[design.cell]);
  let zText;
  if (design.type === 'board') {
    const d = 0.05, b = 0.03;
    tb.box(-w / 2, -h / 2, z0, w / 2, h / 2, z0 + d, 1 | 4 | 8 | 16 | 32, 0.85, 0.95);
    if (q >= 0.5) {
      // raised moulded border
      tb.box(-w / 2, h / 2 - b, z0 + d, w / 2, h / 2, z0 + d + 0.012, 1 | 16 | 32, 0.9, 1);
      tb.box(-w / 2, -h / 2, z0 + d, w / 2, -h / 2 + b, z0 + d + 0.012, 1 | 16 | 32, 0.8, 0.9);
      tb.box(-w / 2, -h / 2 + b, z0 + d, -w / 2 + b, h / 2 - b, z0 + d + 0.012, 1 | 8, 0.85, 0.95);
      tb.box(w / 2 - b, -h / 2 + b, z0 + d, w / 2, h / 2 - b, z0 + d + 0.012, 1 | 4, 0.85, 0.95);
    }
    zText = z0 + d + 0.002;
  } else if (design.type === 'lightbox') {
    const d = 0.13;
    tb.box(-w / 2, -h / 2, z0, w / 2, h / 2, z0 + d, 1 | 4 | 8 | 16 | 32, 0.95, 1);
    zText = z0 + d + 0.002;
  } else {
    zText = z0 + 0.02;   // individual letters on stand-off pins
  }
  const th = h * (design.type === 'letters' ? 0.95 : 0.78);
  const tw = Math.min(w * 0.92, th * cell.aspect);
  const thFit = Math.min(th, tw / cell.aspect);
  cellQuad(tt, cell, 0, 0, tw, thFit, zText);
  return { board: design.board !== null ? tb.bake() : null, text: tt.bake() };
}

/** Blade face index advertising shop type `type` (null: no shop below, e.g. a hotel). */
export function bladeFace(seed, type) {
  const r = new RNG(seed);
  const ok = [];
  BLADE_FACES.forEach(([, t], i) => { if (t === type) ok.push(i); });
  if (!ok.length) BLADE_FACES.forEach(([, t], i) => { if (t === null) ok.push(i); });
  return ok[r.int(0, ok.length - 1)];
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
    const uA = sx > 0 ? face.u0 : face.u0, uB = sx > 0 ? face.u1 : face.u1;
    tt.v(x, 0.02, zA, sx, 0, 0, uA, face.v0); tt.v(x, 0.02, zB, sx, 0, 0, uB, face.v0);
    tt.v(x, h - 0.02, zB, sx, 0, 0, uB, face.v1); tt.v(x, h - 0.02, zA, sx, 0, 0, uA, face.v1);
    tt.ix6(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  quad(1); quad(-1);
  // bracket: wall plate and two arms (metal batch)
  tm.box(-0.05, h - 0.1, 0, 0.05, h + 0.12, 0.02, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  tm.box(-0.012, h + 0.03, 0.0, 0.012, h + 0.055, z1 + 0.05, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  if (q >= 0.5) {
    tm.box(-0.01, h - 0.03, 0.0, 0.01, h - 0.005, z0, 1 | 4 | 8 | 16 | 32, 0.9, 1);
    for (const zz of [z0 + 0.08, z1 - 0.08]) tm.box(-0.006, h, zz - 0.006, 0.006, h + 0.035, zz + 0.006, 4 | 8 | 1 | 2, 0.9, 1);
  }
  return { board: tb.bake(), text: tt.bake(), metal: tm.bake() };
}

/** Enamel house number plaque (0.2 × 0.13 m) on the wall face. */
export function plaqueTpl(seed) {
  const p = atlas.plaques[seed % atlas.plaques.length];
  const t = new Tpl();
  cellQuad(t, p, 0, 0, 0.2, 0.13, 0.012);
  return t.bake();
}

export function signColor(hex) { return lin(hex); }
