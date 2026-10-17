import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { GeoBuilder, lathe, rod } from './geo.js';

// Vertical fabric banners hung between two short brackets on the sidewalk side of a pole.
// The banner plane contains the pole and the bracket, so it faces along the street and
// reads face-on from the tram. Prints are abstract city-event designs painted into a
// small canvas atlas (6 designs side by side), printed through (read correctly from both
// sides). Banners hang for months: the dyes are muted and sun-bleached (most at the top,
// which faces the sky), and each banner fades by its own amount (instance data, see
// patchBanner), the cloth hangs a little slack.

export const BANNER_Y0 = 2.55, BANNER_Y1 = 4.15;
export const BANNER_X0 = 0.13, BANNER_X1 = 0.73;   // distance from the pole axis (sidewalk side)
const DESIGNS = 6;

// generic event phrases (Hebrew title, English subtitle)
const EVENTS = [
  ['פסטיבל קיץ', 'SUMMER FESTIVAL'],
  ['שבוע הספר', 'BOOK WEEK'],
  ['תרבות ואמנות', 'CULTURE & ART'],
  ['לילה לבן', 'WHITE NIGHT'],
  ['מוזיקה ברחוב', 'MUSIC IN THE STREET'],
  ['בית פתוח', 'OPEN HOUSE'],
  ['שוק האוכל', 'FOOD MARKET'],
  ['מרתון העיר', 'CITY MARATHON'],
];

export function buildBannerBracket() {
  const b = new GeoBuilder();
  for (const y of [BANNER_Y0 - 0.03, BANNER_Y1 + 0.03]) {
    rod(b, [-0.06, y, 0], [-(BANNER_X1 + 0.07), y, 0], 0.012, 8);
    // ball finial
    const P = [];
    for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + (i / 8) * Math.PI; P.push([0.024 * Math.cos(a) + 1e-4, 0.024 * Math.sin(a)]); }
    const fb = new GeoBuilder();
    lathe(fb, P, 10, { tube: 0.024 });
    b.append(fb, new THREE.Matrix4().makeTranslation(-(BANNER_X1 + 0.1), y, 0));
    // clamp collar
    lathe(b, [[0.088, y - 0.04], [0.098, y - 0.032, true], [0.098, y + 0.032, true], [0.088, y + 0.04]], 16);
  }
  const g = b.toGeometry((x, y, z, nx, ny) => { const up = Math.max(0, ny - 0.5) / 0.5; return [1 + 0.3 * up, 1 + 0.28 * up, 1 + 0.2 * up]; });
  g.userData.shared = true;
  return g;
}

/** Banner cloth in pole-local space (x towards the street centre, so the cloth is at -x),
 *  shared by every banner: the print cell and the wind phase are chosen per instance (see
 *  patchBanner). Hem sleeves wrap the two rods; a static drape adds gathers
 *  near the rods, tension wrinkles from the pole-side corners and a curl on the free edge. */
export function buildBannerCloth() {
  const nu = 10, nv = 20;
  const RS = 0.016;                                   // sleeve radius around the 12 mm rods
  const yTop = BANNER_Y1 + 0.03, yBot = BANNER_Y0 - 0.03;
  const y0 = yBot + RS, y1 = yTop - RS;               // flat part between the sleeves
  const W = BANNER_X1 - BANNER_X0, H = y1 - y0;
  const cell = 1 / DESIGNS;
  // rows: bottom sleeve (wrapping under the rod), flat part, top sleeve (over the rod)
  const rows = [];
  for (const a of [120, 180, 250, 320, 390]) rows.push({ sleeve: -1, a: (a * Math.PI) / 180 });
  for (let j = 0; j <= nv; j++) rows.push({ v: j / nv });
  for (const a of [-30, 0, 60, 120, 200]) rows.push({ sleeve: 1, a: (a * Math.PI) / 180 });
  const drape = (u, v) => {
    const nearRod = Math.exp(-v * H / 0.16) + Math.exp(-(1 - v) * H / 0.16);
    let z = (0.012 * nearRod + 0.003) * Math.sin(3 * Math.PI * u + 0.7);
    // tension wrinkles running diagonally from the pole-side corners
    for (const [cv, sg] of [[0, 1], [1, -1]]) {
      const du = u * W, dv = Math.abs(v - cv) * H;
      const r = Math.hypot(du, dv);
      z += 0.005 * Math.sin((du * sg * (cv ? -1 : 1) + dv) / 0.05) * Math.exp(-r / 0.3) * Math.min(1, r / 0.05);
    }
    // free edge curls towards +z
    const e = THREE.MathUtils.smoothstep(u, 0.72, 1.0);
    z += 0.05 * e * e * (0.45 + 0.55 * Math.sin(Math.PI * v));
    // slack: the cloth has stretched a little and bellies out between the rods, with a
    // soft fold running down from the free top corner
    z += 0.022 * Math.sin(Math.PI * v) * (0.35 + 0.65 * u);
    z += 0.008 * Math.sin(Math.PI * v) * Math.sin(2 * Math.PI * (u * 0.6 + v * 0.8));
    return z;
  };
  const pos = [], uv = [], ab = [], idx = [];
  for (const row of rows) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const x = -(BANNER_X0 + W * u);
      let y, z, v, bv;
      if (row.sleeve) {
        const yc = row.sleeve > 0 ? yTop : yBot;
        y = yc + Math.sin(row.a) * RS; z = Math.cos(row.a) * RS;
        v = row.sleeve > 0 ? 0.985 : 0.015; bv = row.sleeve > 0 ? 1 : 0;
      } else {
        v = row.v; bv = v;
        // the slack free edge drops a little in the middle
        y = y0 + H * v - 0.018 * u * u * Math.sin(Math.PI * v); z = drape(u, v);
      }
      pos.push(x, y, z);
      // the print reads left to right on the +z face (u runs towards -x)
      uv.push((0.98 - u * 0.96) * cell, v);
      ab.push(u, bv, 0);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aBanner', new THREE.Float32BufferAttribute(ab, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.boundingSphere.radius += 0.4; // wind billow
  g.userData.shared = true;
  return g;
}

/** Canvas atlas with the banner prints. */
export function buildBannerAtlas(seed = 7) {
  const W = 256, H = 640;
  const cv = document.createElement('canvas');
  cv.width = W * DESIGNS; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true }); // read back below: CPU canvas, no GPU sync
  const rng = RNG.from(seed, 'bannerPrint');
  // muted, sun-worn dyes (desaturated about a third from fresh print colours)
  const mute = (hex, k = 0.32) => {
    const c = new THREE.Color(hex), l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    c.setRGB(c.r + (l - c.r) * k, c.g + (l - c.g) * k, c.b + (l - c.b) * k);
    return `#${c.getHexString()}`;
  };
  const palettes = [
    { bg: '#7a2a32', fg: '#ece2cc', ac: '#c99a4a' },
    { bg: '#28405e', fg: '#efeadf', ac: '#d3a24c' },
    { bg: '#3d6b62', fg: '#f0e8d6', ac: '#c46a4c' },
    { bg: '#c49a48', fg: '#2a3548', ac: '#f3ede0' },
    { bg: '#e6dfd0', fg: '#31475e', ac: '#a8473a' },
    { bg: '#55606b', fg: '#ede6d6', ac: '#d6b257' },
  ].map((p) => ({ bg: mute(p.bg), fg: mute(p.fg, 0.15), ac: mute(p.ac) }));
  for (let k = 0; k < DESIGNS; k++) {
    const p = palettes[k];
    const x0 = k * W;
    g.save();
    g.beginPath(); g.rect(x0, 0, W, H); g.clip();
    g.fillStyle = p.bg; g.fillRect(x0, 0, W, H);
    // hem pockets
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x0, 0, W, 14); g.fillRect(x0, H - 14, W, 14);
    const cx = x0 + W / 2;
    if (k === 0) {
      // rings emblem
      for (let r = 92; r > 20; r -= 18) { g.strokeStyle = r % 36 ? p.fg : p.ac; g.lineWidth = 7; g.beginPath(); g.arc(cx, 220, r, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = p.ac; g.beginPath(); g.arc(cx, 220, 14, 0, Math.PI * 2); g.fill();
      g.fillStyle = p.fg; g.fillRect(x0 + 18, 30, W - 36, 8); g.fillRect(x0 + 18, H - 40, W - 36, 8);
    } else if (k === 1) {
      // diagonal band
      g.fillStyle = p.ac; g.beginPath(); g.moveTo(x0, 330); g.lineTo(x0 + W, 210); g.lineTo(x0 + W, 280); g.lineTo(x0, 400); g.fill();
      g.fillStyle = p.fg; g.beginPath(); g.arc(cx, 130, 46, 0, Math.PI * 2); g.fill();
      g.fillStyle = p.bg; g.beginPath(); g.arc(cx + 14, 122, 40, 0, Math.PI * 2); g.fill();
    } else if (k === 2) {
      // arched window motif
      g.fillStyle = p.fg; g.beginPath(); g.moveTo(cx - 70, 330); g.lineTo(cx - 70, 190); g.arc(cx, 190, 70, Math.PI, 0); g.lineTo(cx + 70, 330); g.fill();
      g.fillStyle = p.bg; g.beginPath(); g.moveTo(cx - 50, 318); g.lineTo(cx - 50, 194); g.arc(cx, 194, 50, Math.PI, 0); g.lineTo(cx + 50, 318); g.fill();
      g.fillStyle = p.ac; g.fillRect(cx - 4, 140, 8, 178); g.fillRect(cx - 50, 250, 100, 7);
    } else if (k === 3) {
      // stripes and an eight-point rosette
      g.fillStyle = p.fg; for (let i = 0; i < 4; i++) g.fillRect(x0, 40 + i * 22, W, 9);
      g.save(); g.translate(cx, 270); g.fillStyle = p.fg;
      for (let i = 0; i < 2; i++) { g.rotate(Math.PI / 4); g.fillRect(-56, -56, 112, 112); }
      g.restore();
      g.fillStyle = p.ac; g.beginPath(); g.arc(cx, 270, 30, 0, Math.PI * 2); g.fill();
    } else if (k === 4) {
      // light ground: a row of stylised arches (a skyline) over a thin rule
      g.fillStyle = p.fg;
      for (let i = 0; i < 4; i++) {
        const ax = x0 + 30 + i * 52, ah = 120 + ((i * 37) % 60);
        g.beginPath(); g.moveTo(ax, 340); g.lineTo(ax, 340 - ah); g.arc(ax + 20, 340 - ah, 20, Math.PI, 0); g.lineTo(ax + 40, 340); g.fill();
      }
      g.fillStyle = p.ac; g.fillRect(x0 + 20, 352, W - 40, 6);
      g.fillStyle = p.ac; g.beginPath(); g.arc(cx + 60, 110, 26, 0, Math.PI * 2); g.fill();
    } else {
      // wide band with a running figure of dots (a route) and a ring
      g.fillStyle = p.fg; g.fillRect(x0, 150, W, 150);
      g.fillStyle = p.bg;
      for (let i = 0; i < 9; i++) { g.beginPath(); g.arc(x0 + 24 + i * 26, 225 + 34 * Math.sin(i * 0.9), 7, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = p.ac; g.lineWidth = 8; g.beginPath(); g.arc(cx, 90, 34, 0, Math.PI * 2); g.stroke();
    }
    // lettering in the street's bilingual sign convention: a generic event title in Hebrew,
    // an English subtitle and a date line in numerals
    const [he, en] = EVENTS[(k + Math.floor(rng.next() * EVENTS.length)) % EVENTS.length];
    const fit = (text, weight, size, maxW) => {
      const f = (px) => `${weight} ${px}px "Noto Sans Hebrew", "Liberation Sans", Arial, sans-serif`;
      g.font = f(size);
      const w = g.measureText(text).width;
      if (w > maxW) g.font = f(Math.floor((size * maxW) / w));
    };
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillStyle = p.fg; fit(he, 700, 50, W - 36); g.fillText(he, cx, 470);
    g.fillStyle = p.fg; fit(en, 600, 22, W - 44); g.fillText(en, cx, 504);
    const d1 = rng.int(1, 14), d2 = d1 + rng.int(3, 14), mo = String(rng.int(4, 10)).padStart(2, '0');
    const date = `${d1}\u2013${d2}.${mo}`;
    g.fillStyle = p.ac; fit(date, 700, 34, W - 60); g.fillText(date, cx, 552);
    g.fillStyle = p.fg; g.fillRect(cx - 40, 570, 80, 3);
    // weave and sun fading: fine noise; the dyes bleach towards a pale warm grey, most at
    // the top (it faces the sky), in soft vertical streaks where rain ran down the cloth
    const img = g.getImageData(x0, 0, W, H);
    const d = img.data;
    const streak = Array.from({ length: W }, (_, xx) => 0.5 + 0.5 * Math.sin(xx * 0.07 + k) * Math.sin(xx * 0.023 + 2 * k));
    for (let yy = 0; yy < H; yy++) {
      const top = 1 - yy / H;
      for (let xx = 0; xx < W; xx++) {
        const i = (yy * W + xx) * 4;
        const n = ((xx & 1) ^ (yy & 1) ? 1.03 : 0.97) * (0.96 + 0.08 * rng.next());
        const bleach = 0.08 + 0.2 * top * top + 0.05 * streak[xx];
        for (let c = 0; c < 3; c++) {
          const v = d[i + c] * n;
          d[i + c] = Math.min(255, v + (200 - v) * bleach * (c === 2 ? 0.9 : 1));
        }
      }
    }
    g.putImageData(img, x0, 0);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

export const BANNER_DESIGNS = DESIGNS;
