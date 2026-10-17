import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { GeoBuilder, lathe, rod } from './geo.js';

// Vertical fabric banners hung between two short brackets on the sidewalk side of a pole.
// The banner plane contains the pole and the bracket, so it faces along the street and
// reads face-on from the tram. Prints are abstract city-festival designs painted into a
// small canvas atlas (4 designs side by side).

export const BANNER_Y0 = 2.55, BANNER_Y1 = 4.15;
export const BANNER_X0 = 0.13, BANNER_X1 = 0.73;   // distance from the pole axis (sidewalk side)
const DESIGNS = 4;

// generic event phrases (Hebrew title, English subtitle)
const EVENTS = [
  ['פסטיבל קיץ', 'SUMMER FESTIVAL'],
  ['שבוע הספר', 'BOOK WEEK'],
  ['תרבות ואמנות', 'CULTURE & ART'],
  ['לילה לבן', 'WHITE NIGHT'],
  ['מוזיקה ברחוב', 'MUSIC IN THE STREET'],
  ['בית פתוח', 'OPEN HOUSE'],
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

/** Banner cloth in pole-local space (x towards the street centre, so the cloth is at -x). */
export function buildBannerCloth(design, phase) {
  const nu = 6, nv = 12;
  const pos = [], nor = [], uv = [], ab = [], idx = [];
  const cell = 1 / DESIGNS;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      const x = -(BANNER_X0 + (BANNER_X1 - BANNER_X0) * u);
      // hem pockets wrap the rods: pull the top and bottom rows onto them
      const y = BANNER_Y0 + (BANNER_Y1 - BANNER_Y0) * v;
      pos.push(x, y, 0); nor.push(0, 0, 1);
      uv.push((design + 0.02 + u * 0.96) * cell, v);
      ab.push(u, v, phase);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aBanner', new THREE.Float32BufferAttribute(ab, 3));
  g.setIndex(idx);
  return g;
}

/** Canvas atlas with the banner prints. */
export function buildBannerAtlas(seed = 7) {
  const W = 256, H = 640;
  const cv = document.createElement('canvas');
  cv.width = W * DESIGNS; cv.height = H;
  const g = cv.getContext('2d');
  const rng = RNG.from(seed, 'bannerPrint');
  const palettes = [
    { bg: '#7a1f2b', fg: '#efe3c8', ac: '#d9a441' },
    { bg: '#1f3557', fg: '#f1ece0', ac: '#e0a63a' },
    { bg: '#2c6a63', fg: '#f3ead6', ac: '#c9583c' },
    { bg: '#d39a2e', fg: '#20304d', ac: '#f6efe0' },
  ];
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
    } else {
      // stripes and an eight-point rosette
      g.fillStyle = p.fg; for (let i = 0; i < 4; i++) g.fillRect(x0, 40 + i * 22, W, 9);
      g.save(); g.translate(cx, 270); g.fillStyle = p.fg;
      for (let i = 0; i < 2; i++) { g.rotate(Math.PI / 4); g.fillRect(-56, -56, 112, 112); }
      g.restore();
      g.fillStyle = p.ac; g.beginPath(); g.arc(cx, 270, 30, 0, Math.PI * 2); g.fill();
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
    // weave and fading: fine noise, slightly sun-bleached top
    const img = g.getImageData(x0, 0, W, H);
    const d = img.data;
    for (let yy = 0; yy < H; yy++) {
      const fade = 1 + 0.06 * (1 - yy / H);
      for (let xx = 0; xx < W; xx++) {
        const i = (yy * W + xx) * 4;
        const n = ((xx & 1) ^ (yy & 1) ? 1.03 : 0.97) * (0.96 + 0.08 * rng.next());
        d[i] = Math.min(255, d[i] * n * fade); d[i + 1] = Math.min(255, d[i + 1] * n * fade); d[i + 2] = Math.min(255, d[i + 2] * n * fade);
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
