import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { FACES } from './mesh.js';

// Large painted murals on blank gable and party walls (a few of the walls and taller
// blocks that close the view down the street carry one, as in the photographs). Painted
// once at start-up on a canvas: a city panorama under a cloudy or an evening sky, a
// crowd of figures before old houses, a tree with birds; each built from many shaded shapes and brush strokes in the muted, sun-faded
// palette of outdoor acrylic on render. Then weathered: bleached towards the top,
// chalky grain, a few peeled and patched spots near the edges, rain streaks, a grimy
// foot.
//
// The mural geometry (buildings sink key `mural<k>`) carries uv in 0..1 over the painted
// rectangle; the material is a plain matte standard material with the painting as map.

export const MURALS = 4;
const TW = 640, TH = 1024;

let mats = null;

// Printed vinyl adverts on steel frames (the big exposed side walls that face back down
// the street carry some, as in the photographs): graphic designs with generic Hebrew
// headlines (no brands), sun-faded and grimy. Sink key `advert<k>`, uv 0..1 over the
// panel (portrait, ADVERT_ASPECT = width / height); lit by floodlights at night.
export const ADVERTS = 4;
export const ADVERT_ASPECT = 0.75;
const AW = 768, AH = 1024;
let ads = null;

/** Advert materials, one per design (created once, registered with the library). */
export function advertMaterials(app) {
  if (ads) return ads;
  ads = [];
  for (let k = 0; k < ADVERTS; k++) {
    const tex = paintAdvert(k);
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0, name: `buildings:advert${k}` });
    if (app.materials.register) app.materials.register(m.name, m);
    ads.push(m);
  }
  return ads;
}

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
const shade = (c, k) => c.map((x) => Math.min(255, x * k));

// muted outdoor paints (sRGB)
const PAL = {
  sky: [[126, 166, 188], [104, 148, 176], [150, 184, 196]],
  teal: [[64, 124, 126], [80, 140, 132]],
  ochre: [[210, 166, 92], [196, 140, 72], [222, 186, 112]],
  red: [[172, 72, 54], [186, 96, 64], [148, 62, 56]],
  green: [[92, 126, 80], [118, 146, 90], [70, 104, 70]],
  blue: [[56, 84, 130], [74, 104, 148]],
  skin: [[204, 152, 116], [178, 126, 92], [138, 94, 68], [222, 176, 140]],
  dark: [[50, 44, 46], [64, 56, 52]],
  cream: [[230, 218, 194], [238, 228, 208]],
  stone: [[214, 196, 160], [200, 180, 146], [226, 210, 178]],
  violet: [[118, 92, 128], [138, 110, 146]],
};

/** Shape filled with a linear gradient from a lit to a shaded tone (painted volume). */
function fillShaded(g, path, col, x0, y0, x1, y1, lit = 1.12, dark = 0.78) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  gr.addColorStop(0, rgb(shade(col, lit)));
  gr.addColorStop(1, rgb(shade(col, dark)));
  g.fillStyle = gr;
  path();
  g.fill();
}

/** Brush strokes of tone variation over the current clip. */
function strokes(g, r, x0, y0, x1, y1, col, n, w0 = 4, w1 = 14, a = [0.08, 0.22]) {
  for (let i = 0; i < n; i++) {
    g.strokeStyle = rgb(shade(col, r.range(0.82, 1.18)), r.range(a[0], a[1]));
    g.lineWidth = r.range(w0, w1);
    g.lineCap = 'round';
    const x = r.range(x0, x1), y = r.range(y0, y1), l = r.range(10, 50), an = r.range(-0.5, 0.5) + (r.chance(0.5) ? 0 : Math.PI / 2);
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(an) * l * 0.5 + r.range(-6, 6), y + Math.sin(an) * l * 0.5 + r.range(-6, 6), x + Math.cos(an) * l, y + Math.sin(an) * l);
    g.stroke();
  }
}

function sky(g, r, y1, warm = false) {
  const top = warm ? [214, 150, 112] : r.pick(PAL.sky), low = warm ? [246, 210, 150] : mix(top, [240, 226, 196], 0.55);
  const gr = g.createLinearGradient(0, 0, 0, y1);
  gr.addColorStop(0, rgb(shade(top, 0.92)));
  gr.addColorStop(1, rgb(low));
  g.fillStyle = gr;
  g.fillRect(0, 0, TW, y1);
  // soft clouds
  g.save();
  g.filter = 'blur(10px)';
  for (let i = 0; i < 14; i++) {
    g.fillStyle = `rgba(245,240,230,${r.range(0.25, 0.6)})`;
    const cx = r.range(-50, TW + 50), cy = r.range(0.05, 0.7) * y1;
    for (let k = 0; k < 5; k++) {
      g.beginPath(); g.ellipse(cx + r.range(-60, 60), cy + r.range(-12, 12), r.range(30, 80), r.range(12, 26), 0, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
  strokes(g, r, 0, 0, TW, y1, top, 160, 6, 18, [0.04, 0.12]);
}

/** Composition 0: a panorama of old houses, domes and towers on hills under a cloudy sky. */
function panorama(g, r, warm = false) {
  sky(g, r, TH * 0.55, warm);
  // far hills
  for (const [y, col, amp] of [[0.44, mix(PAL.sky[0], PAL.green[1], 0.45), 18], [0.5, mix(PAL.green[1], PAL.ochre[2], 0.35), 26]]) {
    const pts = [];
    for (let x = 0; x <= TW; x += 20) pts.push([x, TH * y + Math.sin(x * 0.012 + r.range(0, 6)) * amp + r.range(-5, 5)]);
    fillShaded(g, () => { g.beginPath(); g.moveTo(0, TH); for (const p of pts) g.lineTo(p[0], p[1]); g.lineTo(TW, TH); g.closePath(); }, col, 0, TH * y - amp, 0, TH, 1.05, 0.85);
  }
  // the city: rows of houses, back to front, lit from the left
  for (let row = 0; row < 5; row++) {
    const y0 = TH * (0.5 + row * 0.07), sc = 0.6 + row * 0.25;
    for (let x = -30; x < TW;) {
      const w = r.range(30, 80) * sc, h = r.range(30, 90) * sc, col = r.pick([...PAL.stone, ...PAL.stone, ...PAL.cream, PAL.ochre[2]]);
      const dpt = w * 0.25;
      // front and shaded side
      fillShaded(g, () => { g.beginPath(); g.rect(x, y0 - h, w, h + 60); }, col, x, y0 - h, x + w, y0, 1.08, 0.9);
      g.fillStyle = rgb(shade(col, 0.66));
      g.beginPath(); g.moveTo(x + w, y0 - h); g.lineTo(x + w + dpt, y0 - h - dpt * 0.3); g.lineTo(x + w + dpt, y0 + 60); g.lineTo(x + w, y0 + 60); g.fill();
      // windows and arches
      const nw = Math.max(1, Math.floor(w / (14 * sc))), nh = Math.max(1, Math.floor(h / (22 * sc)));
      for (let i = 0; i < nw; i++) for (let j = 0; j < nh; j++) {
        if (r.chance(0.25)) continue;
        g.fillStyle = rgb(shade(PAL.dark[r.int(0, 1)], r.range(0.8, 1.3)), 0.85);
        const wx = x + (i + 0.3) * (w / nw), wy = y0 - h + (j + 0.3) * (h / nh);
        g.fillRect(wx, wy, (w / nw) * 0.4, (h / nh) * 0.45);
      }
      // a dome, a tower or a tile roof now and then
      const roof = r.next();
      if (roof < 0.18) fillShaded(g, () => { g.beginPath(); g.ellipse(x + w / 2, y0 - h, w * 0.32, w * 0.3, 0, Math.PI, 0); g.closePath(); }, r.chance(0.5) ? [204, 172, 80] : shade(col, 1.05), x, y0 - h - w * 0.3, x + w, y0 - h, 1.25, 0.7);
      else if (roof < 0.3) fillShaded(g, () => { g.beginPath(); g.rect(x + w * 0.35, y0 - h - h * 0.8, w * 0.3, h * 0.8); }, shade(col, 1.04), x + w * 0.35, 0, x + w * 0.65, 0, 1.12, 0.75);
      else if (roof < 0.45) { g.fillStyle = rgb(shade(PAL.red[0], r.range(0.85, 1.05))); g.beginPath(); g.moveTo(x - 3, y0 - h); g.lineTo(x + w / 2, y0 - h - w * 0.28); g.lineTo(x + w + 3, y0 - h); g.fill(); }
      x += w + r.range(-8, 6);
    }
    // cypresses and olive trees between the rows
    for (let i = 0; i < 6 + row * 2; i++) {
      const tx = r.range(0, TW), th = r.range(20, 60) * sc;
      fillShaded(g, () => { g.beginPath(); g.ellipse(tx, y0 - th * 0.4, th * (r.chance(0.5) ? 0.18 : 0.45), th * 0.6, 0, 0, Math.PI * 2); }, r.pick(PAL.green), tx - th, 0, tx + th, 0, 1.15, 0.65);
    }
  }
  // birds
  g.strokeStyle = rgb(PAL.dark[0], 0.75); g.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    const x = r.range(0, TW), y = r.range(0.05, 0.35) * TH, s = r.range(8, 18);
    g.beginPath(); g.moveTo(x - s, y); g.quadraticCurveTo(x - s / 2, y - s * 0.5, x, y); g.quadraticCurveTo(x + s / 2, y - s * 0.5, x + s, y); g.stroke();
  }
}

/** Composition 1: a crowd of figures (a market, musicians) before old houses. */
function crowd(g, r) {
  sky(g, r, TH * 0.4);
  // house fronts behind
  for (let x = -20; x < TW;) {
    const w = r.range(110, 200), h = r.range(TH * 0.3, TH * 0.5), col = r.pick([...PAL.stone, ...PAL.cream, PAL.ochre[2]]);
    fillShaded(g, () => { g.beginPath(); g.rect(x, TH * 0.75 - h, w, h); }, col, x, 0, x + w, 0, 1.08, 0.86);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const wx = x + w * (0.12 + i * 0.3), wy = TH * 0.75 - h + h * (0.12 + j * 0.25);
      fillShaded(g, () => { g.beginPath(); g.moveTo(wx, wy + 40); g.lineTo(wx, wy + 12); g.arc(wx + 15, wy + 12, 15, Math.PI, 0); g.lineTo(wx + 30, wy + 40); g.closePath(); }, PAL.dark[1], wx, wy, wx + 30, wy + 40, 1.3, 0.8);
    }
    x += w;
  }
  fillShaded(g, () => { g.beginPath(); g.rect(0, TH * 0.75, TW, TH * 0.25); }, r.pick(PAL.stone), 0, TH * 0.75, 0, TH, 1.0, 0.75);
  // figures, back to front (larger), lit from the left
  const n = r.int(9, 13);
  for (let i = 0; i < n; i++) {
    const t = i / n, sc = 0.55 + t * 0.7, cx = r.range(0.05, 0.95) * TW, foot = TH * (0.8 + t * 0.17), hgt = TH * 0.32 * sc, w = hgt * 0.27;
    const coat = r.pick([...PAL.red, ...PAL.blue, ...PAL.teal, ...PAL.violet, ...PAL.green, ...PAL.ochre, ...PAL.cream]);
    const legs = r.pick([...PAL.dark, PAL.blue[0], [120, 100, 80]]);
    fillShaded(g, () => { g.beginPath(); g.rect(cx - w * 0.38, foot - hgt * 0.45, w * 0.32, hgt * 0.45); g.rect(cx + w * 0.06, foot - hgt * 0.45, w * 0.32, hgt * 0.45); }, legs, cx - w, 0, cx + w, 0, 1.15, 0.7);
    fillShaded(g, () => { g.beginPath(); g.moveTo(cx - w * 0.45, foot - hgt * 0.82); g.lineTo(cx + w * 0.45, foot - hgt * 0.82); g.lineTo(cx + w * 0.55, foot - hgt * 0.4); g.lineTo(cx - w * 0.55, foot - hgt * 0.4); g.closePath(); }, coat, cx - w * 0.5, 0, cx + w * 0.5, 0, 1.2, 0.65);
    const skin = r.pick(PAL.skin);
    fillShaded(g, () => { g.beginPath(); g.ellipse(cx, foot - hgt * 0.9, w * 0.2, w * 0.25, 0, 0, Math.PI * 2); }, skin, cx - w * 0.2, 0, cx + w * 0.2, 0, 1.2, 0.7);
    fillShaded(g, () => { g.beginPath(); g.ellipse(cx, foot - hgt * 0.95, w * 0.22, w * 0.15, 0, Math.PI, 0); g.closePath(); }, r.pick([...PAL.dark, [104, 70, 44]]), cx - w * 0.2, 0, cx + w * 0.2, 0, 1.2, 0.7);
    if (r.chance(0.4)) {
      fillShaded(g, () => { g.beginPath(); g.ellipse(cx + w * 0.25, foot - hgt * 0.55, w * 0.32, w * 0.2, 0.7, 0, Math.PI * 2); }, r.pick([[168, 114, 62], [206, 176, 92]]), cx, 0, cx + w * 0.6, 0, 1.25, 0.7);
    }
  }
}

/** Composition 2: a great tree with birds over a stylised landscape. */
function tree(g, r) {
  sky(g, r, TH * 0.75);
  fillShaded(g, () => { g.beginPath(); g.moveTo(0, TH * 0.8); g.quadraticCurveTo(TW * 0.5, TH * 0.72, TW, TH * 0.8); g.lineTo(TW, TH); g.lineTo(0, TH); g.closePath(); }, r.pick(PAL.ochre), 0, TH * 0.72, 0, TH, 1.1, 0.75);
  // trunk and branches
  const tx = TW * r.range(0.42, 0.58), bark = [96, 74, 56];
  fillShaded(g, () => { g.beginPath(); g.moveTo(tx - 40, TH * 0.84); g.bezierCurveTo(tx - 20, TH * 0.6, tx - 30, TH * 0.5, tx - 10, TH * 0.4); g.lineTo(tx + 14, TH * 0.4); g.bezierCurveTo(tx + 30, TH * 0.55, tx + 18, TH * 0.65, tx + 44, TH * 0.84); g.closePath(); }, bark, tx - 40, 0, tx + 40, 0, 1.3, 0.6);
  g.strokeStyle = rgb(shade(bark, 0.9)); g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    g.lineWidth = r.range(8, 18);
    g.beginPath(); g.moveTo(tx, TH * r.range(0.4, 0.5)); g.quadraticCurveTo(tx + r.range(-150, 150), TH * r.range(0.25, 0.4), tx + r.range(-260, 260), TH * r.range(0.12, 0.35)); g.stroke();
  }
  // foliage clusters
  for (let i = 0; i < 260; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next());
    const x = tx + Math.cos(a) * d * TW * 0.46, y = TH * 0.27 + Math.sin(a) * d * TH * 0.17, s = r.range(10, 34);
    fillShaded(g, () => { g.beginPath(); g.ellipse(x, y, s, s * 0.7, r.range(0, 3), 0, Math.PI * 2); }, r.pick(PAL.green), x - s, y - s, x + s, y + s, 1.25, 0.6);
  }
  for (let i = 0; i < 30; i++) {
    const x = tx + r.range(-0.4, 0.4) * TW, y = TH * r.range(0.14, 0.42);
    g.fillStyle = rgb(r.pick([...PAL.red, PAL.ochre[2], PAL.cream[1]]), 0.9);
    g.beginPath(); g.arc(x, y, r.range(4, 9), 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = rgb(PAL.dark[0], 0.8); g.lineWidth = 4;
  for (let i = 0; i < 9; i++) {
    const x = r.range(0, TW), y = r.range(0.04, 0.2) * TH, s = r.range(14, 26);
    g.beginPath(); g.moveTo(x - s, y); g.quadraticCurveTo(x - s / 2, y - s * 0.5, x, y); g.quadraticCurveTo(x + s / 2, y - s * 0.5, x + s, y); g.stroke();
  }
}

/** Bleaching, chalky grain, peeled and patched spots near the edges, streaks, grimy foot. */
function weather(g, r) {
  // sun-bleaching, strongest at the top
  const fade = g.createLinearGradient(0, 0, 0, TH);
  fade.addColorStop(0, 'rgba(236,228,212,0.3)');
  fade.addColorStop(0.5, 'rgba(236,228,212,0.14)');
  fade.addColorStop(1, 'rgba(236,228,212,0.06)');
  g.fillStyle = fade;
  g.fillRect(0, 0, TW, TH);
  // chalky grain and the render's texture showing through (per pixel): a grain layer
  // multiplied over the painting, then a faint chalky lift. (Composited on the canvas
  // rather than read back and written per pixel: a read-back rasterises the whole
  // painting on the main thread, about a quarter of a second per mural.)
  const gc = canvas(TW, TH), gg = gc.getContext('2d');
  const img = gg.createImageData(TW, TH), d = img.data;
  const n0 = new Float32Array(41 * 65);
  for (let i = 0; i < n0.length; i++) n0[i] = r.next();
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const fx = x / 16, fy = y / 16, ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
      const a = n0[iy * 41 + ix], b = n0[iy * 41 + ix + 1], c = n0[(iy + 1) * 41 + ix], e = n0[(iy + 1) * 41 + ix + 1];
      const low = a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
      const k = (0.91 + 0.08 * low + (((x * 73856093) ^ (y * 19349663)) & 255) / 255 * 0.06) / 1.05;
      const i = (y * TW + x) * 4, v = Math.min(255, k * 255);
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  gg.putImageData(img, 0, 0);
  g.save();
  g.globalCompositeOperation = 'multiply';
  g.drawImage(gc, 0, 0);
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgb(9,9,8)';
  g.fillRect(0, 0, TW, TH);
  g.restore();
  // rain streaks from the top edge
  for (let i = 0; i < 50; i++) {
    const x = r.range(0, TW), len = r.range(60, 380);
    const gr = g.createLinearGradient(0, 0, 0, len);
    gr.addColorStop(0, `rgba(80,70,60,${r.range(0.06, 0.18)})`);
    gr.addColorStop(1, 'rgba(80,70,60,0)');
    g.fillStyle = gr;
    g.fillRect(x, 0, r.range(2, 7), len);
  }
  // peeled spots and render patches, mostly near the edges and the foot
  for (let i = 0; i < 7; i++) {
    const edge = r.int(0, 3);
    const x = edge === 0 ? r.range(0, 60) : edge === 1 ? r.range(TW - 60, TW) : r.range(0, TW);
    const y = edge === 2 ? r.range(TH - 120, TH) : r.range(0, TH);
    const s = r.range(5, 16);
    g.fillStyle = `rgba(222,214,196,${r.range(0.45, 0.8)})`;
    g.beginPath();
    for (let k = 0; k < 9; k++) { const a = (k / 9) * Math.PI * 2, dd = s * r.range(0.5, 1.3); if (k) g.lineTo(x + Math.cos(a) * dd, y + Math.sin(a) * dd * 0.8); else g.moveTo(x + dd, y); }
    g.closePath(); g.fill();
  }
  const foot = g.createLinearGradient(0, TH * 0.88, 0, TH);
  foot.addColorStop(0, 'rgba(60,54,48,0)');
  foot.addColorStop(1, 'rgba(60,54,48,0.32)');
  g.fillStyle = foot;
  g.fillRect(0, TH * 0.88, TW, TH * 0.12);
}

function paint(k) {
  const c = canvas(TW, TH);
  const g = c.getContext('2d');
  const r = RNG.from('buildings', 'mural', k);
  [panorama, crowd, tree, (gg, rr) => panorama(gg, rr, true)][k % 4](g, r);
  weather(g, r);
  // the primed border
  g.strokeStyle = 'rgba(232,226,212,0.9)';
  g.lineWidth = 8;
  g.strokeRect(4, 4, TW - 8, TH - 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ adverts

const HEAD = ['מבצע קיץ', 'עכשיו בחנויות', 'הכי משתלם', 'חדש!', 'בלעדי', 'ליהנות מכל רגע', 'הקיץ שלך', 'פשוט לחיות'];
const SUB = ['רק החודש', 'בכל הסניפים', 'החל מ-', 'לפרטים נוספים', 'עד גמר המלאי', 'כל יום'];
const ESTATE = ['דירות למכירה', 'משרדים להשכרה', 'פרויקט חדש', 'דירות 4-5 חדרים'];
const FIELD = [[22, 62, 142], [196, 32, 44], [236, 118, 24], [18, 122, 72], [96, 40, 128], [24, 24, 30], [0, 140, 170]];
const HE = '"Liberation Sans", "Noto Sans Hebrew", "DejaVu Sans", Arial, sans-serif';

function text(g, str, x, y, px, col, align = 'right', weight = 700, maxW = AW * 0.86) {
  g.font = `${weight} ${px}px ${HE}`;
  g.direction = 'rtl';
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.fillStyle = col;
  const w = g.measureText(str).width;
  if (w > maxW) { g.save(); g.translate(x, y); g.scale(maxW / w, 1); g.fillText(str, 0, 0); g.restore(); } else g.fillText(str, x, y);
}

/** A white roundel with an abstract mark (no real logo). */
function badge(g, r, x, y, s, col) {
  g.fillStyle = 'rgba(255,255,255,0.96)';
  g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
  g.strokeStyle = rgb(col); g.lineWidth = s * 0.22; g.lineCap = 'round';
  const a = r.range(0, Math.PI);
  g.beginPath(); g.arc(x, y, s * 0.55, a, a + Math.PI * 1.2); g.stroke();
  g.fillStyle = rgb(col); g.beginPath(); g.arc(x, y, s * 0.18, 0, Math.PI * 2); g.fill();
}

/** Small print: grey bars. */
function legal(g, r, y, col) {
  g.fillStyle = col;
  for (let i = 0; i < 3; i++) { const w = r.range(0.3, 0.7) * AW; g.fillRect(AW * 0.93 - w, y + i * 14, w, 6); }
}

/** Design 0: a brand-colour field, a sweeping band, big headline and a percentage. */
function adField(g, r) {
  const col = r.pick(FIELD);
  const gr = g.createLinearGradient(0, 0, AW, AH);
  gr.addColorStop(0, rgb(shade(col, 1.15))); gr.addColorStop(1, rgb(shade(col, 0.8)));
  g.fillStyle = gr; g.fillRect(0, 0, AW, AH);
  // sweeping band
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.beginPath(); g.moveTo(0, AH * 0.62); g.quadraticCurveTo(AW * 0.5, AH * 0.42, AW, AH * 0.5); g.lineTo(AW, AH * 0.66); g.quadraticCurveTo(AW * 0.5, AH * 0.56, 0, AH * 0.78); g.fill();
  text(g, r.pick(HEAD), AW * 0.93, AH * 0.2, 118, '#ffffff');
  text(g, r.pick(SUB), AW * 0.93, AH * 0.3, 58, 'rgba(255,255,255,0.9)', 'right', 400);
  const big = r.pick(['50%', '1+1', '30%', '70%', '2=1']);
  g.font = `900 260px ${HE}`; g.direction = 'ltr'; g.textAlign = 'center'; g.fillStyle = r.pick(['#ffd400', '#ffffff', '#ffe066']);
  g.fillText(big, AW * 0.47, AH * 0.62);
  badge(g, r, AW * 0.16, AH * 0.88, 62, col);
  legal(g, r, AH * 0.86, 'rgba(255,255,255,0.55)');
}

/** Design 1: a product (a phone or a bottle) on a light gradient, a price, a brand strip. */
function adProduct(g, r) {
  const bgA = r.pick([[214, 232, 244], [246, 232, 210], [232, 240, 226], [244, 222, 226]]);
  const gr = g.createLinearGradient(0, 0, 0, AH);
  gr.addColorStop(0, rgb(shade(bgA, 1.04))); gr.addColorStop(1, rgb(shade(bgA, 0.86)));
  g.fillStyle = gr; g.fillRect(0, 0, AW, AH);
  const col = r.pick(FIELD);
  const cx = AW * r.range(0.3, 0.4), cy = AH * 0.52;
  // soft shadow
  g.save(); g.filter = 'blur(18px)'; g.fillStyle = 'rgba(0,0,0,0.28)';
  g.beginPath(); g.ellipse(cx + 20, cy + AH * 0.27, AW * 0.17, 20, 0, 0, Math.PI * 2); g.fill(); g.restore();
  if (r.chance(0.5)) {
    // phone: rounded slab, screen gradient
    const w = AW * 0.34, h = AH * 0.52, x = cx - w / 2, y = cy - h / 2;
    g.fillStyle = '#16171a'; roundRect(g, x, y, w, h, 34); g.fill();
    const sg = g.createLinearGradient(x, y, x + w, y + h);
    sg.addColorStop(0, rgb(shade(col, 1.3))); sg.addColorStop(0.5, rgb(r.pick(FIELD))); sg.addColorStop(1, rgb(shade(col, 0.6)));
    g.fillStyle = sg; roundRect(g, x + 12, y + 14, w - 24, h - 28, 24); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.moveTo(x + 12, y + 14); g.lineTo(x + w * 0.7, y + 14); g.lineTo(x + 12, y + h * 0.5); g.fill();
  } else {
    // bottle: body, shoulders, neck, cap and a label
    const w = AW * 0.2, h = AH * 0.5, x = cx - w / 2, y = cy - h / 2;
    const bg = g.createLinearGradient(x, 0, x + w, 0);
    const bc = r.pick([[40, 110, 60], [150, 60, 30], [30, 30, 36], [180, 196, 210]]);
    bg.addColorStop(0, rgb(shade(bc, 0.7))); bg.addColorStop(0.35, rgb(shade(bc, 1.4))); bg.addColorStop(1, rgb(shade(bc, 0.55)));
    g.fillStyle = bg;
    g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y + h * 0.38); g.quadraticCurveTo(x, y + h * 0.24, x + w * 0.36, y + h * 0.16); g.lineTo(x + w * 0.36, y + h * 0.02);
    g.lineTo(x + w * 0.64, y + h * 0.02); g.lineTo(x + w * 0.64, y + h * 0.16); g.quadraticCurveTo(x + w, y + h * 0.24, x + w, y + h * 0.38); g.lineTo(x + w, y + h); g.closePath(); g.fill();
    g.fillStyle = rgb(col); g.fillRect(x + w * 0.33, y - h * 0.02, w * 0.34, h * 0.06);
    g.fillStyle = '#f4efe2'; g.fillRect(x, y + h * 0.5, w, h * 0.24);
    g.fillStyle = rgb(col); g.fillRect(x, y + h * 0.56, w, h * 0.08);
  }
  text(g, r.pick(HEAD), AW * 0.94, AH * 0.16, 96, rgb(shade(col, 0.7)), 'right', 700, AW * 0.88);
  text(g, r.pick(SUB), AW * 0.94, AH * 0.36, 52, '#2a2a2e', 'right', 400, AW * 0.4);
  g.font = `900 120px ${HE}`; g.direction = 'ltr'; g.textAlign = 'right'; g.fillStyle = rgb(col);
  g.fillText(`₪${r.int(2, 9)}${r.chance(0.5) ? '9' : '0'}.90`, AW * 0.95, AH * 0.56);
  g.fillStyle = rgb(col); g.fillRect(0, AH * 0.84, AW, AH * 0.16);
  badge(g, r, AW * 0.84, AH * 0.92, 48, col);
  legal(g, r, AH * 0.89, 'rgba(255,255,255,0.6)');
}

/** Design 2: apartments for sale, a drawing of the new block, a phone strip. */
function adEstate(g, r) {
  g.fillStyle = r.chance(0.5) ? '#f7f4ec' : '#fff3c4'; g.fillRect(0, 0, AW, AH);
  const col = r.pick([[198, 30, 36], [22, 62, 142], [18, 110, 70]]);
  text(g, r.pick(ESTATE), AW * 0.93, AH * 0.14, 104, rgb(col));
  // the block as rendered by the architect: sky, a tall facade with a window grid, trees
  const x0 = AW * 0.1, x1 = AW * 0.9, y0 = AH * 0.2, y1 = AH * 0.74;
  const sg = g.createLinearGradient(0, y0, 0, y1);
  sg.addColorStop(0, '#7fb1d8'); sg.addColorStop(1, '#dfeaf0');
  g.fillStyle = sg; g.fillRect(x0, y0, x1 - x0, y1 - y0);
  const bx = AW * r.range(0.25, 0.35), bw = AW * 0.4, by = y0 + (y1 - y0) * 0.12;
  fillShaded(g, () => { g.beginPath(); g.rect(bx, by, bw, y1 - by); }, [226, 214, 188], bx, 0, bx + bw, 0, 1.08, 0.9);
  g.fillStyle = 'rgba(40,60,80,0.75)';
  for (let j = 0; j < 9; j++) for (let i = 0; i < 4; i++) g.fillRect(bx + 12 + i * (bw - 24) / 4, by + 14 + j * (y1 - by - 30) / 9, (bw - 24) / 4 - 14, (y1 - by - 30) / 9 - 14);
  fillShaded(g, () => { g.beginPath(); g.rect(bx + bw, by + 40, bw * 0.35, y1 - by - 40); }, [196, 184, 160], bx + bw, 0, bx + bw * 1.35, 0, 0.95, 0.8);
  for (let i = 0; i < 7; i++) {
    const tx = r.range(x0, x1), ts = r.range(18, 36);
    fillShaded(g, () => { g.beginPath(); g.ellipse(tx, y1 - ts * 0.8, ts, ts * 0.9, 0, 0, Math.PI * 2); }, r.pick(PAL.green), tx - ts, 0, tx + ts, 0, 1.2, 0.7);
  }
  g.fillStyle = rgb(col); g.fillRect(0, AH * 0.8, AW, AH * 0.2);
  text(g, r.pick(SUB), AW * 0.93, AH * 0.88, 60, '#ffffff', 'right', 700);
  badge(g, r, AW * 0.15, AH * 0.9, 54, col);
}

function roundRect(g, x, y, w, h, rr) {
  g.beginPath();
  g.moveTo(x + rr, y); g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr); g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h); g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y); g.closePath();
}

/** Sun-fade, grime along the foot, a few streaks and the vinyl's seams. */
function weatherAdvert(g, r) {
  g.fillStyle = 'rgba(236,230,214,0.12)'; g.fillRect(0, 0, AW, AH);
  const foot = g.createLinearGradient(0, AH * 0.85, 0, AH);
  foot.addColorStop(0, 'rgba(50,46,40,0)'); foot.addColorStop(1, 'rgba(50,46,40,0.22)');
  g.fillStyle = foot; g.fillRect(0, AH * 0.85, AW, AH * 0.15);
  for (let i = 0; i < 14; i++) {
    const x = r.range(0, AW), len = r.range(40, 220);
    const gr = g.createLinearGradient(0, 0, 0, len);
    gr.addColorStop(0, `rgba(70,64,56,${r.range(0.05, 0.14)})`); gr.addColorStop(1, 'rgba(70,64,56,0)');
    g.fillStyle = gr; g.fillRect(x, 0, r.range(2, 5), len);
  }
  // the printed strips are joined in vertical seams
  g.fillStyle = 'rgba(0,0,0,0.07)';
  for (let x = AW / 3; x < AW - 1; x += AW / 3) g.fillRect(x - 1, 0, 2, AH);
}

function paintAdvert(k) {
  const c = canvas(AW, AH);
  const g = c.getContext('2d');
  const r = RNG.from('buildings', 'advert', k);
  [adField, adProduct, adEstate, adField][k % 4](g, r);
  weatherAdvert(g, r);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Printed advert on a steel frame standing off the wall (side-wall frame, a: {u0, u1,
 * v0, v1, k}): the vinyl face, the frame's edges, and floodlights on arms over the top.
 */
export function advertPanel(B, sinks, a, q) {
  const W = 0.16, s = B.sink(`advert${a.k}`);
  B.shade = null; B.flat = [1, 1, 1];
  s.reserve(4, 6);
  const i0 = B.v(s, a.u0, a.v0, W, 0, 0, 1, 0, 0), i1 = B.v(s, a.u1, a.v0, W, 0, 0, 1, 1, 0);
  const i2 = B.v(s, a.u1, a.v1, W, 0, 0, 1, 1, 1), i3 = B.v(s, a.u0, a.v1, W, 0, 0, 1, 0, 1);
  B.quadIdx(s, i0, i1, i2, i3);
  // the frame: galvanised channel round the edge, its sides back to the wall
  const m = sinks.paint, e = 0.05;
  B.flat = [0.36, 0.36, 0.35];
  B.box(m, a.u0 - e, a.u0, a.v0 - e, a.v1 + e, 0.02, W + 0.012, FACES.FRONT | FACES.LEFT | FACES.TOP | FACES.BOTTOM);
  B.box(m, a.u1, a.u1 + e, a.v0 - e, a.v1 + e, 0.02, W + 0.012, FACES.FRONT | FACES.RIGHT | FACES.TOP | FACES.BOTTOM);
  B.box(m, a.u0, a.u1, a.v1, a.v1 + e, 0.02, W + 0.012, FACES.FRONT | FACES.TOP);
  B.box(m, a.u0, a.u1, a.v0 - e, a.v0, 0.02, W + 0.012, FACES.FRONT | FACES.BOTTOM);
  if (!q.lod) {
    // floodlights on arms reaching out over the top edge
    const n = Math.max(2, Math.round((a.u1 - a.u0) / 3));
    for (let i = 0; i < n; i++) {
      const u = a.u0 + ((a.u1 - a.u0) * (i + 0.5)) / n;
      B.flat = [0.3, 0.3, 0.3];
      B.box(sinks.metal || m, u - 0.025, u + 0.025, a.v1 + 0.05, a.v1 + 0.1, W, W + 0.85, FACES.ALL & ~FACES.BACK);
      B.flat = [0.22, 0.22, 0.23];
      B.box(m, u - 0.14, u + 0.14, a.v1 - 0.08, a.v1 + 0.1, W + 0.75, W + 1.0, FACES.ALL);
    }
  }
  B.flat = [1, 1, 1];
}
