import * as THREE from 'three';
import { RNG } from '../../core/rng.js';

// Large painted murals on blank gable and party walls (a few of the taller blocks that
// close the view down the street carry one, as in the photographs). Painted once at
// start-up on a canvas: a handful of compositions (a portrait, a city-and-hills scene,
// figures in a row, bold colour fields) in the muted, sun-faded palette of outdoor
// acrylic on render, then weathered: faded and chalky towards the top, mottled, rain
// streaks, peeled patches showing the pale render, a grimy band at the foot.
//
// The mural geometry (buildings sink key `mural<k>`) carries uv in 0..1 over the painted
// rectangle; the material is a plain matte standard material with the painting as map.

export const MURALS = 4;
const TW = 640, TH = 1024;

let mats = null;

/** Mural materials, one per composition (created once, registered with the library). */
export function muralMaterials(app) {
  if (mats) return mats;
  mats = [];
  for (let k = 0; k < MURALS; k++) {
    const tex = paint(k);
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.93, metalness: 0, name: `buildings:mural${k}` });
    if (app.materials.register) app.materials.register(m.name, m);
    mats.push(m);
  }
  return mats;
}

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const rgb = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

// faded outdoor paints (sRGB)
const PAL = {
  sky: [[118, 160, 182], [96, 140, 170], [140, 178, 190]],
  teal: [[58, 120, 122], [72, 138, 128]],
  ochre: [[214, 168, 88], [200, 142, 70], [226, 190, 110]],
  red: [[176, 70, 52], [190, 92, 60], [150, 58, 52]],
  green: [[96, 132, 84], [120, 150, 92]],
  blue: [[52, 82, 132], [70, 100, 150]],
  skin: [[206, 150, 112], [180, 124, 90], [140, 92, 66], [224, 176, 138]],
  dark: [[46, 42, 44], [60, 52, 50]],
  cream: [[232, 220, 196], [240, 232, 214]],
  violet: [[120, 92, 132], [140, 110, 150]],
};

/** A soft painterly blob: many overlapping translucent ellipses. */
function blob(g, r, x, y, rx, ry, col, n = 18, jitter = 0.18) {
  for (let i = 0; i < n; i++) {
    const a = r.range(0, Math.PI * 2), d = r.range(0, jitter);
    g.fillStyle = rgb(mix(col, [r.range(0, 255), r.range(0, 255), r.range(0, 255)], 0.06), r.range(0.18, 0.4));
    g.beginPath();
    g.ellipse(x + Math.cos(a) * rx * d, y + Math.sin(a) * ry * d, rx * r.range(0.8, 1.05), ry * r.range(0.8, 1.05), r.range(-0.2, 0.2), 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = rgb(col, 0.85);
  g.beginPath(); g.ellipse(x, y, rx * 0.86, ry * 0.86, 0, 0, Math.PI * 2); g.fill();
}

/** Brushy fill of a polygon: the flat colour, then strokes of lighter / darker tone. */
function brushPoly(g, r, pts, col, strokes = 40) {
  g.save();
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.closePath();
  g.fillStyle = rgb(col);
  g.fill();
  g.clip();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let i = 0; i < strokes; i++) {
    const t = r.range(-0.12, 0.12);
    g.strokeStyle = rgb(col.map((c) => c * (1 + t)), r.range(0.15, 0.35));
    g.lineWidth = r.range(6, 22);
    g.beginPath();
    const y = r.range(y0, y1), x = r.range(x0, x1);
    g.moveTo(x - r.range(20, 90), y + r.range(-10, 10));
    g.quadraticCurveTo(x, y + r.range(-25, 25), x + r.range(20, 90), y + r.range(-10, 10));
    g.stroke();
  }
  g.restore();
}

function background(g, r, top, bottom) {
  const gr = g.createLinearGradient(0, 0, 0, TH);
  gr.addColorStop(0, rgb(top));
  gr.addColorStop(1, rgb(bottom));
  g.fillStyle = gr;
  g.fillRect(0, 0, TW, TH);
  // brushy wash
  for (let i = 0; i < 220; i++) {
    const y = r.range(0, TH), c = mix(top, bottom, y / TH).map((x) => x * r.range(0.9, 1.1));
    g.strokeStyle = rgb(c, r.range(0.1, 0.25));
    g.lineWidth = r.range(10, 40);
    g.beginPath();
    const x = r.range(-50, TW);
    g.moveTo(x, y); g.lineTo(x + r.range(60, 220), y + r.range(-20, 20));
    g.stroke();
  }
}

/** Composition 0: a large portrait, head and shoulders, against split colour fields. */
function portrait(g, r) {
  const a = r.pick(PAL.teal), b = r.pick(PAL.ochre);
  background(g, r, a, mix(a, b, 0.7));
  brushPoly(g, r, [[0, TH * 0.55], [TW, TH * 0.42], [TW, TH], [0, TH]], r.pick(PAL.ochre), 60);
  const skin = r.pick(PAL.skin), cx = TW * r.range(0.42, 0.58), cy = TH * 0.4;
  // shoulders and garment
  const coat = r.pick([...PAL.red, ...PAL.blue, ...PAL.violet]);
  brushPoly(g, r, [[cx - TW * 0.45, TH], [cx - TW * 0.36, TH * 0.68], [cx - TW * 0.1, TH * 0.6], [cx + TW * 0.1, TH * 0.6], [cx + TW * 0.38, TH * 0.68], [cx + TW * 0.46, TH]], coat, 80);
  brushPoly(g, r, [[cx - TW * 0.07, TH * 0.6], [cx + TW * 0.07, TH * 0.6], [cx + TW * 0.05, TH * 0.5], [cx - TW * 0.05, TH * 0.5]], skin.map((c) => c * 0.88), 20);
  // hair behind, face, hair over
  const hair = r.pick([...PAL.dark, [110, 70, 40], [150, 120, 90]]);
  blob(g, r, cx, cy - TH * 0.03, TW * 0.24, TH * 0.17, hair);
  blob(g, r, cx, cy + TH * 0.02, TW * 0.17, TH * 0.15, skin);
  g.fillStyle = rgb(skin.map((c) => c * 0.82), 0.5);
  g.beginPath(); g.ellipse(cx + TW * 0.06, cy + TH * 0.04, TW * 0.08, TH * 0.11, 0.2, 0, Math.PI * 2); g.fill();
  blob(g, r, cx, cy - TH * 0.12, TW * 0.19, TH * 0.07, hair, 10);
  // eyes, brows, nose, mouth
  for (const s of [-1, 1]) {
    g.fillStyle = rgb([250, 244, 232], 0.9);
    g.beginPath(); g.ellipse(cx + s * TW * 0.065, cy, TW * 0.035, TH * 0.012, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = rgb(PAL.dark[0], 0.95);
    g.beginPath(); g.ellipse(cx + s * TW * 0.065, cy, TW * 0.016, TH * 0.011, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = rgb(hair, 0.9); g.lineWidth = 7;
    g.beginPath(); g.moveTo(cx + s * TW * 0.03, cy - TH * 0.03); g.lineTo(cx + s * TW * 0.11, cy - TH * 0.035); g.stroke();
  }
  g.strokeStyle = rgb(skin.map((c) => c * 0.7), 0.8); g.lineWidth = 5;
  g.beginPath(); g.moveTo(cx, cy + TH * 0.01); g.lineTo(cx - TW * 0.015, cy + TH * 0.06); g.lineTo(cx + TW * 0.02, cy + TH * 0.065); g.stroke();
  g.fillStyle = rgb(r.pick(PAL.red), 0.85);
  g.beginPath(); g.ellipse(cx, cy + TH * 0.1, TW * 0.05, TH * 0.012, 0, 0, Math.PI * 2); g.fill();
  // a few bold birds / leaves around
  for (let i = 0; i < 6; i++) leaf(g, r, r.range(0.05, 0.95) * TW, r.range(0.05, 0.3) * TH, r.pick([...PAL.cream, ...PAL.ochre]));
}

function leaf(g, r, x, y, col) {
  const s = r.range(20, 50), a = r.range(-0.6, 0.6);
  g.save(); g.translate(x, y); g.rotate(a);
  g.fillStyle = rgb(col, 0.9);
  g.beginPath(); g.moveTo(-s, 0); g.quadraticCurveTo(0, -s * 0.5, s, 0); g.quadraticCurveTo(0, s * 0.5, -s, 0); g.fill();
  g.restore();
}

/** Composition 1: hills, an old skyline of domes and towers, a big sun, sky. */
function cityscape(g, r) {
  const sky = r.pick(PAL.sky);
  background(g, r, mix(sky, [235, 225, 200], 0.2), mix(sky, [250, 220, 170], 0.6));
  blob(g, r, TW * r.range(0.25, 0.75), TH * r.range(0.12, 0.22), TW * 0.16, TW * 0.16, r.pick(PAL.ochre), 24);
  // hills in bands
  const bands = [[0.5, PAL.green[1]], [0.6, PAL.ochre[1]], [0.72, PAL.green[0]], [0.85, PAL.red[1]]];
  for (const [y, col] of bands) {
    const pts = [[0, TH]];
    for (let x = 0; x <= TW; x += 40) pts.push([x, TH * y + Math.sin(x * 0.01 + r.range(0, 6)) * 30 + r.range(-12, 12)]);
    pts.push([TW, TH]);
    brushPoly(g, r, pts, col.map((c) => c * r.range(0.9, 1.08)), 50);
  }
  // skyline: blocks, domes, towers
  for (let i = 0; i < 9; i++) {
    const x = r.range(0, TW), w = r.range(40, 110), h = r.range(60, 180), y0 = TH * 0.56;
    const col = r.pick([...PAL.cream, ...PAL.ochre]).map((c) => c * r.range(0.85, 1));
    brushPoly(g, r, [[x, y0], [x + w, y0], [x + w, y0 - h], [x, y0 - h]], col, 10);
    if (r.chance(0.4)) blob(g, r, x + w / 2, y0 - h, w * 0.42, w * 0.38, r.chance(0.5) ? [200, 170, 70] : col, 8);
    g.fillStyle = rgb(PAL.dark[1], 0.7);
    for (let k = 0; k < 3; k++) g.fillRect(x + w * (0.2 + 0.25 * k), y0 - h * 0.7, w * 0.1, h * 0.18);
  }
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = rgb(PAL.dark[0], 0.8); g.lineWidth = 4;
    const x = r.range(0, TW), y = r.range(0.05, 0.4) * TH, s = r.range(10, 22);
    g.beginPath(); g.moveTo(x - s, y); g.quadraticCurveTo(x - s / 2, y - s * 0.5, x, y); g.quadraticCurveTo(x + s / 2, y - s * 0.5, x + s, y); g.stroke();
  }
}

/** Composition 2: a row of tall stylised figures (musicians, walkers) on a light ground. */
function figures(g, r) {
  const ground = r.pick(PAL.cream), sky = r.pick([...PAL.sky, ...PAL.ochre]);
  background(g, r, sky, ground);
  brushPoly(g, r, [[0, TH * 0.8], [TW, TH * 0.76], [TW, TH], [0, TH]], r.pick(PAL.ochre), 40);
  const n = r.int(3, 4);
  for (let i = 0; i < n; i++) {
    const cx = TW * (i + 0.5) / n + r.range(-20, 20), top = TH * r.range(0.18, 0.3), foot = TH * 0.86;
    const w = TW / n * 0.42, coat = r.pick([...PAL.red, ...PAL.blue, ...PAL.teal, ...PAL.violet, ...PAL.green]);
    brushPoly(g, r, [[cx - w * 0.5, top + (foot - top) * 0.2], [cx + w * 0.5, top + (foot - top) * 0.2], [cx + w * 0.62, foot - (foot - top) * 0.25], [cx - w * 0.62, foot - (foot - top) * 0.25]], coat, 30);
    const leg = r.pick(PAL.dark);
    brushPoly(g, r, [[cx - w * 0.4, foot - (foot - top) * 0.26], [cx - w * 0.05, foot - (foot - top) * 0.26], [cx - w * 0.1, foot], [cx - w * 0.35, foot]], leg, 8);
    brushPoly(g, r, [[cx + w * 0.05, foot - (foot - top) * 0.26], [cx + w * 0.4, foot - (foot - top) * 0.26], [cx + w * 0.35, foot], [cx + w * 0.1, foot]], leg, 8);
    blob(g, r, cx, top + (foot - top) * 0.08, w * 0.3, w * 0.36, r.pick(PAL.skin), 10);
    blob(g, r, cx, top + (foot - top) * 0.02, w * 0.33, w * 0.22, r.pick(PAL.dark), 8);
    if (r.chance(0.6)) {
      // instrument / bag across the body
      g.fillStyle = rgb(r.pick([[160, 110, 60], [210, 180, 90]]), 0.95);
      g.beginPath(); g.ellipse(cx + w * 0.2, top + (foot - top) * 0.45, w * 0.28, w * 0.18, 0.6, 0, Math.PI * 2); g.fill();
    }
  }
}

/** Composition 3: bold overlapping colour fields and circles (a modern abstract). */
function abstract(g, r) {
  background(g, r, r.pick(PAL.cream), r.pick(PAL.cream));
  const cols = [...PAL.red, ...PAL.blue, ...PAL.ochre, ...PAL.teal, ...PAL.green];
  for (let i = 0; i < 7; i++) {
    const x = r.range(-0.2, 0.9) * TW, y = r.range(-0.1, 0.95) * TH, w = r.range(0.25, 0.7) * TW, h = r.range(0.08, 0.3) * TH;
    const sk = r.range(-60, 60);
    brushPoly(g, r, [[x, y], [x + w, y + sk], [x + w, y + sk + h], [x, y + h]], r.pick(cols), 30);
  }
  for (let i = 0; i < 5; i++) blob(g, r, r.range(0.1, 0.9) * TW, r.range(0.1, 0.9) * TH, r.range(50, 140), r.range(50, 140), r.pick(cols), 14);
  g.strokeStyle = rgb(PAL.dark[0], 0.85);
  for (let i = 0; i < 4; i++) {
    g.lineWidth = r.range(6, 14);
    g.beginPath(); g.moveTo(r.range(0, TW), r.range(0, TH));
    g.bezierCurveTo(r.range(0, TW), r.range(0, TH), r.range(0, TW), r.range(0, TH), r.range(0, TW), r.range(0, TH));
    g.stroke();
  }
}

/** Sun-fading, mottling, rain streaks, peeled patches, a grimy foot. */
function weather(g, r) {
  // fade (stronger at the top, which takes the sun)
  const fade = g.createLinearGradient(0, 0, 0, TH);
  fade.addColorStop(0, 'rgba(236,228,212,0.32)');
  fade.addColorStop(0.6, 'rgba(236,228,212,0.16)');
  fade.addColorStop(1, 'rgba(236,228,212,0.08)');
  g.fillStyle = fade;
  g.fillRect(0, 0, TW, TH);
  // mottling
  for (let i = 0; i < 500; i++) {
    const l = r.chance(0.5);
    g.fillStyle = l ? 'rgba(240,232,215,0.07)' : 'rgba(60,52,44,0.06)';
    g.beginPath(); g.ellipse(r.range(0, TW), r.range(0, TH), r.range(8, 50), r.range(6, 40), r.range(0, 3), 0, Math.PI * 2); g.fill();
  }
  // rain streaks from the top edge and from a few points
  for (let i = 0; i < 70; i++) {
    const x = r.range(0, TW), y = r.chance(0.6) ? 0 : r.range(0, TH * 0.6), len = r.range(80, 420);
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, `rgba(70,62,54,${r.range(0.08, 0.22)})`);
    gr.addColorStop(1, 'rgba(70,62,54,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, r.range(2, 9), len);
  }
  // peeled patches showing the pale render
  for (let i = 0; i < 26; i++) {
    const x = r.range(0, TW), y = r.range(0, TH), s = r.range(4, 22);
    g.fillStyle = `rgba(226,218,200,${r.range(0.5, 0.9)})`;
    g.beginPath();
    for (let k = 0; k < 7; k++) { const a = (k / 7) * Math.PI * 2; const d = s * r.range(0.5, 1.3); if (k) g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8); else g.moveTo(x + d, y); }
    g.closePath(); g.fill();
  }
  // splash and grime at the foot
  const foot = g.createLinearGradient(0, TH * 0.9, 0, TH);
  foot.addColorStop(0, 'rgba(60,54,48,0)');
  foot.addColorStop(1, 'rgba(60,54,48,0.3)');
  g.fillStyle = foot;
  g.fillRect(0, TH * 0.9, TW, TH * 0.1);
}

function paint(k) {
  const c = canvas(TW, TH);
  const g = c.getContext('2d');
  const r = RNG.from('buildings', 'mural', k);
  [portrait, cityscape, figures, abstract][k % 4](g, r);
  weather(g, r);
  // painted border (the edge of the primed render)
  g.strokeStyle = 'rgba(236,230,216,0.9)';
  g.lineWidth = 10;
  g.strokeRect(5, 5, TW - 10, TH - 10);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
