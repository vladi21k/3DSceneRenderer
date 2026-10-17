import * as THREE from 'three';
import { RNG } from '../../core/rng.js';

// Atlas of shop merchandise "product shots", painted procedurally on a canvas: printed
// cartons, bottles and jars with labels, tins, pharmacy packs, shoes and folded clothes,
// each shaded as its shape catches a soft overhead light (cylinders darken towards their
// sides, cartons have a lit top edge). Alpha is the product's silhouette, so the shelf
// tracer in interior.js blends it (premultiplied) with the shelf behind: filtered, no
// hard cut-outs.
//
// 8 x 8 tiles of 128 px with a transparent 4 px margin; rows:
//   0-1 cartons   2-3 bottles   4 jars, tins and cups   5 pharmacy packs and pumps
//   6 shoes       7 folded clothes

export const GOODS_TILES = 8;
export const GOODS_PAD = 4 / 128;
const T = 128, P = 4, N = 8;

const BRAND = ['#a8231e', '#1d3c78', '#e2b630', '#2c6a3a', '#efe9dc', '#1c1c1e', '#d0672a', '#6b3a72',
  '#1f7a80', '#d8879a', '#7fb2d8', '#8a6a3a', '#c9c3b4', '#3d4a2a', '#b44a2c', '#2a5aa0'];
const SYL = ['ka', 'lo', 'ri', 'ne', 'ta', 'mo', 'vi', 'sa', 'do', 'pe', 'lu', 'ra', 'zo', 'mi', 'be', 'no', 'fa', 'ti'];

let tex = null;

/** The atlas texture (built once). */
export function goodsAtlas() {
  if (tex) return tex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = T * N;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const r = RNG.from('facades', 'goods');
  const word = (n = 2) => { let s = ''; for (let i = 0; i < n; i++) s += r.pick(SYL); return s.toUpperCase(); };
  const draws = [carton, carton, bottle, bottle, jar, pharm, shoe, stack];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const x = col * T + P, y = row * T + P, w = T - 2 * P, h = T - 2 * P;
      g.save();
      g.beginPath(); g.rect(x, y, w, h); g.clip();
      draws[row](g, x, y, w, h, r, word, col);
      g.restore();
    }
  }
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  // premultiplied, so the mip levels average colour and coverage together (no dark rims)
  tex.premultiplyAlpha = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ helpers
/** Horizontal shading of a cylinder: dark at the sides, a soft highlight left of centre. */
function cylShade(g, x, y, w, h, alpha = 1) {
  const gr = g.createLinearGradient(x, 0, x + w, 0);
  gr.addColorStop(0, `rgba(0,0,0,${0.55 * alpha})`);
  gr.addColorStop(0.22, `rgba(0,0,0,${0.08 * alpha})`);
  gr.addColorStop(0.34, `rgba(255,255,255,${0.28 * alpha})`);
  gr.addColorStop(0.42, `rgba(255,255,255,${0.05 * alpha})`);
  gr.addColorStop(0.8, `rgba(0,0,0,${0.22 * alpha})`);
  gr.addColorStop(1, `rgba(0,0,0,${0.6 * alpha})`);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}
function textLines(g, x, y, w, n, color, lh = 4) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) g.fillRect(x, y + i * lh, w * (0.55 + 0.45 * ((i * 37) % 5) / 4), 1.6);
}
function brandText(g, s, x, y, w, px, color, font = 'sans-serif', weight = 700) {
  g.fillStyle = color;
  g.font = `${weight} ${px}px "Liberation Sans", "DejaVu Sans", ${font}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const m = g.measureText(s);
  const sx = Math.min(1, (w * 0.9) / Math.max(1, m.width));
  g.save(); g.translate(x, y); g.scale(sx, 1); g.fillText(s, 0, 0); g.restore();
}
const pickBrand = (r) => BRAND[Math.floor(r.next() * BRAND.length)];

// ------------------------------------------------------------------ products
/** Printed carton seen face-on: colour fields, a product picture, brand and copy. */
function carton(g, x, y, w, h, r, word) {
  const c1 = pickBrand(r), c2 = pickBrand(r);
  // cartons stand on the shelf: leave a little air above some of them
  const top = y + h * r.range(0, 0.12);
  const hh = y + h - top;
  g.fillStyle = c1; g.fillRect(x, top, w, hh);
  const style = r.int(0, 3);
  if (style === 0) { g.fillStyle = c2; g.fillRect(x, top + hh * 0.62, w, hh * 0.38); }
  else if (style === 1) { g.fillStyle = c2; g.beginPath(); g.moveTo(x, top + hh * 0.75); g.lineTo(x + w, top + hh * 0.45); g.lineTo(x + w, top + hh); g.lineTo(x, top + hh); g.fill(); }
  else if (style === 2) { g.fillStyle = c2; g.fillRect(x + w * 0.08, top + hh * 0.08, w * 0.84, hh * 0.18); }
  // product picture: a soft blob with a highlight
  const px = x + w * r.range(0.35, 0.65), py = top + hh * r.range(0.5, 0.7), pr = w * r.range(0.16, 0.3);
  const gr = g.createRadialGradient(px - pr * 0.3, py - pr * 0.3, pr * 0.1, px, py, pr);
  const pc = pickBrand(r);
  gr.addColorStop(0, '#fff8ea'); gr.addColorStop(0.25, pc); gr.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = gr; g.beginPath(); g.ellipse(px, py, pr, pr * r.range(0.7, 1.1), 0, 0, Math.PI * 2); g.fill();
  const ink = c1 === '#efe9dc' || c1 === '#e2b630' || c1 === '#c9c3b4' ? '#1c1c1e' : '#f4f0e6';
  brandText(g, word(r.int(1, 2)), x + w / 2, top + hh * 0.2, w, Math.round(w * 0.24), ink);
  textLines(g, x + w * 0.12, top + hh * 0.34, w * 0.5, 3, ink === '#1c1c1e' ? 'rgba(20,20,20,0.6)' : 'rgba(255,255,255,0.6)');
  // carton edges: lit top edge, shadowed sides
  g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(x, top, w, 2);
  const sh = g.createLinearGradient(x, 0, x + w, 0);
  sh.addColorStop(0, 'rgba(0,0,0,0.3)'); sh.addColorStop(0.1, 'rgba(0,0,0,0)'); sh.addColorStop(0.9, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = sh; g.fillRect(x, top, w, hh);
}

/** Bottle: wine / oil / soft drink, glass tinted, shoulders and neck, a label and a cap. */
function bottle(g, x, y, w, h, r, word) {
  const glass = r.pick(['#2f4a22', '#4a2a12', '#9fb6a6', '#1d2a1c', '#6b3a1a', '#c8d8d4', '#3a1416', '#22303a']);
  const bw = w * r.range(0.62, 0.86), bx = x + (w - bw) / 2;
  const neckW = bw * r.range(0.24, 0.34), shoulder = h * r.range(0.42, 0.6), neckTop = h * r.range(0.04, 0.1);
  const cx = x + w / 2;
  g.beginPath();
  g.moveTo(bx, y + h);
  g.lineTo(bx, y + shoulder);
  g.bezierCurveTo(bx, y + shoulder - h * 0.14, cx - neckW / 2, y + shoulder - h * 0.12, cx - neckW / 2, y + shoulder - h * 0.22);
  g.lineTo(cx - neckW / 2, y + neckTop);
  g.lineTo(cx + neckW / 2, y + neckTop);
  g.lineTo(cx + neckW / 2, y + shoulder - h * 0.22);
  g.bezierCurveTo(cx + neckW / 2, y + shoulder - h * 0.12, bx + bw, y + shoulder - h * 0.14, bx + bw, y + shoulder);
  g.lineTo(bx + bw, y + h);
  g.closePath();
  g.fillStyle = glass; g.fill();
  g.save(); g.clip();
  // label
  const lt = y + shoulder + h * r.range(0.04, 0.1), lh = h * r.range(0.22, 0.34);
  const lc = r.pick(['#efe7d2', '#f4f0e6', '#d8c79a', '#1c1c1e', '#a8231e', '#e2b630']);
  g.fillStyle = lc; g.fillRect(bx, lt, bw, lh);
  const ink = lc === '#1c1c1e' || lc === '#a8231e' ? '#e8d9a8' : '#2a1e14';
  brandText(g, word(2), cx, lt + lh * 0.38, bw, Math.round(bw * 0.26), ink, 'serif');
  textLines(g, bx + bw * 0.2, lt + lh * 0.62, bw * 0.6, 2, 'rgba(40,30,20,0.5)', 3);
  // cap / foil
  g.fillStyle = r.pick(['#8a1a1a', '#1c1c1e', '#c8a24a', '#d8d8d4', '#2a4a8a']);
  g.fillRect(cx - neckW / 2 - 1, y + neckTop, neckW + 2, h * 0.09);
  cylShade(g, bx, y, bw, h);
  g.restore();
}

/** Jar, tin or cup stack (cafes, delis, general stores). */
function jar(g, x, y, w, h, r, word, col) {
  const kind = col % 3;
  const bw = w * (kind === 2 ? 0.7 : r.range(0.78, 0.94)), bx = x + (w - bw) / 2;
  const top = y + h * (kind === 0 ? r.range(0.15, 0.35) : r.range(0.0, 0.15));
  g.save();
  g.beginPath(); g.roundRect(bx, top, bw, y + h - top, kind === 0 ? bw * 0.12 : 3); g.clip();
  if (kind === 0) {
    // glass jar: contents, lid, label
    g.fillStyle = r.pick(['#7a3a1a', '#c88a2a', '#5a2a1a', '#d8c08a', '#3a2a1a', '#9a1a1a']); g.fillRect(bx, top, bw, h);
    g.fillStyle = r.pick(['#c8a24a', '#1c1c1e', '#a8231e', '#e8e4da']); g.fillRect(bx, top, bw, (y + h - top) * 0.16);
    const lc = r.pick(['#f4f0e6', '#efe7d2', '#d8c79a']);
    g.fillStyle = lc; g.fillRect(bx, top + (y + h - top) * 0.38, bw, (y + h - top) * 0.36);
    brandText(g, word(1), x + w / 2, top + (y + h - top) * 0.52, bw, Math.round(bw * 0.24), '#2a1e14', 'serif');
  } else if (kind === 1) {
    // printed tin
    const c = pickBrand(r);
    g.fillStyle = c; g.fillRect(bx, top, bw, h);
    g.fillStyle = pickBrand(r); g.fillRect(bx, top + (y + h - top) * 0.3, bw, (y + h - top) * 0.3);
    brandText(g, word(2), x + w / 2, top + (y + h - top) * 0.45, bw, Math.round(bw * 0.2), '#f4f0e6');
    g.fillStyle = '#bdbdb8'; g.fillRect(bx, top, bw, 3); g.fillRect(bx, y + h - 3, bw, 3);
  } else {
    // stacked cups
    const n = r.int(3, 6), ch = (y + h - top) / n;
    const c = r.pick(['#f4f0e6', '#e8e4da', '#1c1c1e', '#7a8a7a']);
    for (let i = 0; i < n; i++) { g.fillStyle = c; g.fillRect(bx, top + i * ch, bw, ch - 1); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(bx, top + i * ch + ch - 3, bw, 2); }
  }
  cylShade(g, bx, top, bw, h, kind === 2 ? 0.7 : 1);
  g.restore();
}

/** Pharmacy: white packs with colour stripes, pump bottles and tubes. */
function pharm(g, x, y, w, h, r, word, col) {
  const accent = r.pick(['#1f6ab0', '#2a8a4a', '#c8231c', '#e88a1a', '#6b3a92', '#1f8a8a']);
  if (col % 2 === 0) {
    const top = y + h * r.range(0.1, 0.4);
    g.fillStyle = '#f2f2ee'; g.fillRect(x, top, w, y + h - top);
    g.fillStyle = accent; g.fillRect(x, top + (y + h - top) * 0.55, w, (y + h - top) * 0.16);
    g.beginPath(); g.moveTo(x, top + (y + h - top) * 0.2); g.lineTo(x + w * 0.4, top); g.lineTo(x + w * 0.6, top); g.lineTo(x, top + (y + h - top) * 0.35); g.fill();
    brandText(g, word(2), x + w / 2, top + (y + h - top) * 0.35, w, Math.round(w * 0.18), '#20242a');
    textLines(g, x + w * 0.12, top + (y + h - top) * 0.78, w * 0.6, 2, 'rgba(30,30,40,0.5)', 4);
    const sh = g.createLinearGradient(x, 0, x + w, 0);
    sh.addColorStop(0, 'rgba(0,0,0,0.22)'); sh.addColorStop(0.12, 'rgba(0,0,0,0)'); sh.addColorStop(0.88, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.28)');
    g.fillStyle = sh; g.fillRect(x, top, w, y + h - top);
  } else {
    // pump bottle
    const bw = w * 0.62, bx = x + (w - bw) / 2, top = y + h * 0.3;
    g.fillStyle = r.pick(['#f4f2ec', '#e8eef2', '#f2e8e0']);
    g.beginPath(); g.roundRect(bx, top, bw, y + h - top, 6); g.fill();
    g.fillStyle = accent; g.fillRect(bx, top + (y + h - top) * 0.4, bw, (y + h - top) * 0.25);
    g.fillStyle = '#e8e8e4'; g.fillRect(x + w / 2 - 4, y + h * 0.14, 8, h * 0.17);
    g.fillRect(x + w / 2 - 4, y + h * 0.12, w * 0.32, 6);
    g.save(); g.beginPath(); g.rect(bx, y, bw, h); g.clip(); cylShade(g, bx, y, bw, h, 0.8); g.restore();
  }
}

/** Shoe in side view: sneaker, leather shoe, boot or sandal. */
function shoe(g, x, y, w, h, r, word, col) {
  const kind = col % 4;
  const sole = kind === 0 ? '#f0eee8' : kind === 3 ? '#6a4a2a' : '#1c1a18';
  const upper = kind === 0 ? r.pick(['#f2f2ee', '#1c1c1e', '#2a4a8a', '#a8231e', '#8a8a86']) : kind === 1 ? r.pick(['#3a2214', '#1a1412', '#5a3418']) : kind === 2 ? r.pick(['#4a2e1a', '#1c1a18', '#7a5a3a']) : '#b88a5a';
  const top = kind === 2 ? y + h * 0.05 : y + h * 0.42;
  const sb = y + h, st = sb - h * (kind === 0 ? 0.16 : 0.09);
  // upper
  g.fillStyle = upper;
  g.beginPath();
  g.moveTo(x + w * 0.04, st);
  g.lineTo(x + w * 0.05, top + (kind === 2 ? 0 : h * 0.06));
  g.lineTo(x + w * (kind === 2 ? 0.42 : 0.3), top);
  g.quadraticCurveTo(x + w * 0.55, top + h * (kind === 2 ? 0.42 : 0.16), x + w * 0.75, st - h * 0.22);
  g.quadraticCurveTo(x + w * 0.98, st - h * 0.16, x + w * 0.97, st);
  g.closePath(); g.fill();
  if (kind === 3) { g.clearRect(x + w * 0.2, top + h * 0.12, w * 0.4, (st - top) * 0.55); }
  // sole
  g.fillStyle = sole; g.fillRect(x + w * 0.03, st, w * 0.95, sb - st);
  // laces / stitching / sheen
  g.strokeStyle = kind === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.18)'; g.lineWidth = 1.5;
  for (let i = 0; i < 4; i++) { const lx = x + w * (0.34 + i * 0.07); g.beginPath(); g.moveTo(lx, top + h * (0.05 + i * 0.04)); g.lineTo(lx + 5, top + h * (0.09 + i * 0.04)); g.stroke(); }
  const sh = g.createLinearGradient(0, top, 0, sb);
  sh.addColorStop(0, 'rgba(255,255,255,0.2)'); sh.addColorStop(0.5, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = sh; g.globalCompositeOperation = 'source-atop'; g.fillRect(x, top, w, sb - top); g.globalCompositeOperation = 'source-over';
}

/** A stack of folded garments: layers with fold rolls and slightly uneven edges. */
function stack(g, x, y, w, h, r) {
  const n = r.int(5, 9), lh = h / n;
  const base = r.pick(['#1c2a44', '#e8e4da', '#8a8a86', '#3a2a22', '#a8231e', '#2c6a3a', '#c9b08a', '#1c1c1e', '#7fb2d8', '#d8879a']);
  const mixed = r.chance(0.35);
  for (let i = 0; i < n; i++) {
    const c = mixed ? pickBrand(r) : base;
    const inset = r.range(0, 3), yy = y + h - (i + 1) * lh;
    g.fillStyle = c; g.fillRect(x + inset, yy, w - 2 * inset - r.range(0, 3), lh);
    // the fold: a rounded roll lit on top, shadow under it
    const gr = g.createLinearGradient(0, yy, 0, yy + lh);
    gr.addColorStop(0, 'rgba(255,255,255,0.25)'); gr.addColorStop(0.35, 'rgba(255,255,255,0)'); gr.addColorStop(0.85, 'rgba(0,0,0,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = gr; g.fillRect(x + inset, yy, w - 2 * inset, lh);
  }
  const sh = g.createLinearGradient(x, 0, x + w, 0);
  sh.addColorStop(0, 'rgba(0,0,0,0.25)'); sh.addColorStop(0.15, 'rgba(0,0,0,0)'); sh.addColorStop(0.85, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = sh; g.globalCompositeOperation = 'source-atop'; g.fillRect(x, y, w, h); g.globalCompositeOperation = 'source-over';
}
