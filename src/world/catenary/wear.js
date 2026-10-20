import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { shaftRadius } from './poleKit.js';

// Street wear on the lamp standards: stickers, flyer remnants and taped notices at hand
// height, all around the shaft (one to ten on every standard, most at 1-2 m). Each is a
// thin curved patch wrapped on the shaft with a print from a small canvas atlas, merged per
// chunk (full-detail range only). The scraped-off remnants, scuffs and grime under them
// are painted by the pole material (shaders.js STREET_WEAR).

const CELLS_X = 4, CELLS_Y = 2;

/** Merged sticker geometry for the poles of a chunk (world space), or null. */
export function buildStickers(poles, poleMatrix, seed) {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3();
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (const p of poles) {
    const rng = RNG.from(seed, 'stickers', Math.round(p.s * 10), p.side);
    const count = rng.weighted([[1, 0.12], [2, 0.18], [3, 0.2], [5, 0.22], [7, 0.16], [10, 0.12]]);
    if (!count) continue;
    poleMatrix(p, m);
    nm.getNormalMatrix(m);
    for (let k = 0; k < count; k++) {
      const y0 = rng.chance(0.8) ? rng.range(0.95, 1.95) : rng.range(1.95, 2.25);
      const h = rng.range(0.05, 0.17), w = rng.range(0.045, 0.12);
      const r = shaftRadius(y0) + 0.0012 + k * 0.0004;
      // anywhere around the shaft (passers-by on both sides of the pole line)
      const a0 = rng.range(0, Math.PI * 2);
      const span = w / r;
      const cell = rng.int(0, CELLS_X * CELLS_Y - 1);
      const cu = (cell % CELLS_X) / CELLS_X, cv = (CELLS_Y - 1 - Math.floor(cell / CELLS_X)) / CELLS_Y; // canvas rows (flipY)
      // sun fading / grime as a per-sticker tint
      const fade = rng.range(0.78, 1.0);
      const torn = rng.chance(0.35);
      const cols = 3, base = pos.length / 3;
      for (let j = 0; j <= 1; j++) {
        for (let i = 0; i <= cols; i++) {
          const u = i / cols;
          // torn remnants: ragged top edge
          const t = torn && j ? rng.range(0.45, 1) : 1;
          const yy = y0 + h * j * t;
          const a = a0 + (u - 0.5) * span;
          v.set(Math.cos(a) * r, yy, -Math.sin(a) * r).applyMatrix4(m);
          n.set(Math.cos(a), 0, -Math.sin(a)).applyMatrix3(nm).normalize();
          pos.push(v.x, v.y, v.z); nor.push(n.x, n.y, n.z);
          uv.push(cu + (0.06 + 0.88 * u) / CELLS_X, cv + (0.06 + 0.88 * j * t) / CELLS_Y);
          const g = fade * (0.9 + 0.1 * j);
          col.push(g, g, g * 0.97);
        }
      }
      for (let i = 0; i < cols; i++) {
        const a = base + i, b = a + 1, c2 = a + cols + 1, d = c2 + 1;
        idx.push(a, b, c2, b, d, c2);
      }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Canvas atlas of sticker / flyer prints (4 x 2 cells). */
export function buildStickerAtlas(seed = 7) {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S * CELLS_X; cv.height = S * CELLS_Y;
  const g = cv.getContext('2d', { willReadFrequently: true }); // read back below: CPU canvas, no GPU sync
  const rng = RNG.from(seed, 'stickerPrint');
  const lines = (x, y, w, n, color, hgt = 5) => {
    g.fillStyle = color;
    for (let i = 0; i < n; i++) {
      let xx = x;
      while (xx < x + w - 8) { const ww = rng.range(6, 22); if (xx + ww > x + w) break; g.fillRect(xx, y + i * (hgt + 5), ww, hgt); xx += ww + 4; }
    }
  };
  const cells = [
    // white sticker, black lettering and a rule
    (x, y) => { g.fillStyle = '#e8e6df'; g.fillRect(x, y, S, S); g.fillStyle = '#111'; g.font = '700 30px "Liberation Sans", Arial, sans-serif'; g.fillText('24/7', x + 14, y + 48); lines(x + 14, y + 66, S - 28, 3, '#333'); g.fillRect(x + 14, y + 104, S - 28, 4); },
    // yellow with a black disc logo
    (x, y) => { g.fillStyle = '#d9b21f'; g.fillRect(x, y, S, S); g.fillStyle = '#151515'; g.beginPath(); g.arc(x + S / 2, y + 52, 30, 0, Math.PI * 2); g.fill(); g.fillStyle = '#d9b21f'; g.beginPath(); g.arc(x + S / 2 + 8, y + 46, 12, 0, Math.PI * 2); g.fill(); lines(x + 16, y + 96, S - 32, 2, '#151515'); },
    // red band sticker
    (x, y) => { g.fillStyle = '#efe9dd'; g.fillRect(x, y, S, S); g.fillStyle = '#a3241a'; g.fillRect(x, y + 20, S, 44); lines(x + 12, y + 30, S - 24, 2, '#f3ece0', 7); lines(x + 12, y + 80, S - 24, 3, '#444'); },
    // blue flyer remnant with tape
    (x, y) => { g.fillStyle = '#c9cfd6'; g.fillRect(x, y, S, S); g.fillStyle = '#1f3c78'; g.fillRect(x + 10, y + 12, S - 20, 34); lines(x + 12, y + 56, S - 24, 6, '#3b4a63'); g.fillStyle = 'rgba(230,225,200,0.75)'; g.fillRect(x + 40, y, 48, 12); },
    // torn white paper with faded print
    (x, y) => { g.fillStyle = '#d6d2c6'; g.fillRect(x, y, S, S); lines(x + 10, y + 14, S - 20, 9, '#8d8a82', 4); },
    // black sticker, white ring
    (x, y) => { g.fillStyle = '#141414'; g.fillRect(x, y, S, S); g.strokeStyle = '#e6e6e6'; g.lineWidth = 8; g.beginPath(); g.arc(x + S / 2, y + 56, 30, 0, Math.PI * 2); g.stroke(); lines(x + 20, y + 100, S - 40, 1, '#e6e6e6'); },
    // code-style square pattern on white
    (x, y) => { g.fillStyle = '#ecebe6'; g.fillRect(x, y, S, S); g.fillStyle = '#111'; for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if (rng.chance(0.45) || (i < 3 && j < 3) || (i > 8 && j < 3) || (i < 3 && j > 8)) g.fillRect(x + 16 + i * 8, y + 16 + j * 8, 8, 8); },
    // sun-bleached beige notice
    (x, y) => { g.fillStyle = '#cbbfa4'; g.fillRect(x, y, S, S); g.fillStyle = '#9c4a3c'; g.font = '700 22px "Liberation Sans", Arial, sans-serif'; g.fillText('SALE', x + 14, y + 34); lines(x + 14, y + 48, S - 28, 6, '#6e6455', 4); },
  ];
  cells.forEach((f, i) => f((i % CELLS_X) * S, Math.floor(i / CELLS_X) * S));
  // grime, scuffs and paper texture over everything
  const img = g.getImageData(0, 0, cv.width, cv.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = 0.9 + 0.12 * rng.next();
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k * 0.98;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
