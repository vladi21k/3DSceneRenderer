import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { RNG } from '../../core/rng.js';
import { Tpl, lin } from './geo.js';

// Shop signage: a canvas atlas of invented generic shop words (English and Hebrew), house
// number plaques and blade-sign faces, plus the geometry for fascia boards, light boxes,
// individual letters and projecting blade signs. Text quads are white glyphs tinted by
// vertex colour; `aGlow` makes light boxes and neon letters glow at dusk.

const W = 2048, H = 2304;
const CELL_W = 512, CELL_H = 128, TEXT_ROWS = 12;          // text cells: rows 0..11
const PLAQUE = 128, PLAQUE_Y = TEXT_ROWS * CELL_H;        // 2 rows of 16 number plaques
const BLADE_W = 256, BLADE_H = 256, BLADE_Y = PLAQUE_Y + 2 * PLAQUE; // 2 rows of 8 blade faces

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
  boards: [0x1f3a2c, 0x1b2b45, 0x5a1a1c, 0x1d1d1f, 0xd9cfb6, 0xe8e4da, 0x6b4a2a, 0x24464a],
  letters: [0xd8b25a, 0xf2efe6, 0xe9dfc4, 0x1a1a1a, 0xb3261e],
  boxes: [0xf4f1e8, 0xf2d24a, 0xc8231c, 0x1f5fa8, 0x2a7a3a, 0xf4f1e8],
};

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
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, cells, plaques, blades };
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

/** Glow attribute support: emissive = albedo × aGlow × (day level + night boost). */
function addGlow(m, key) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey() : '';
  m.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(m, shader, r);
    shader.uniforms.uNight = U.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * ( 0.04 * ( 1.0 - uNight ) + 0.012 * uNight );');
  };
  m.customProgramCacheKey = () => prevKey + '|' + key;
  return m;
}

export function createSignMaterials(M) {
  if (!atlas) atlas = buildAtlas();
  // a private variant of the library panel (keeps its baked surface), plus the glow hook
  const board = M.get('sign.panel', { vertexColors: true, color: new THREE.Color(1, 1, 1), userData: { owner: 'facades.signBoard' } });
  addGlow(board, 'facades.signBoard.v1');
  const text = new THREE.MeshStandardMaterial({
    map: atlas.tex, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.4, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  text.name = 'facades.signText';
  addGlow(text, 'facades.signText.v1');
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
  t.ix(b, b + 1, b + 2, b, b + 2, b + 3);
}

/** Crop a text cell to its inked width so the quad keeps the glyph aspect. */
function inkCell(cell) {
  const du = (cell.u1 - cell.u0) * (1 - cell.ink) / 2;
  return { u0: cell.u0 + du, u1: cell.u1 - du, v0: cell.v0, v1: cell.v1, aspect: cell.aspect * cell.ink };
}

export function signDesign(seed, kindHint) {
  const r = new RNG(seed);
  const type = kindHint || r.weighted([['board', 0.45], ['lightbox', 0.3], ['letters', 0.25]]);
  const cell = r.int(0, WORDS.length - 1);
  let board, ink, glow;
  if (type === 'board') {
    board = r.pick(SIGN_PALETTE.boards);
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
    tt.ix(b, b + 1, b + 2, b, b + 2, b + 3);
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
