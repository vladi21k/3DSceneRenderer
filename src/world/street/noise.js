import { hash2 } from '../../core/rng.js';

// Precomputed periodic fractal value noise sampled with bilinear filtering.
// Building the table once keeps per-vertex lookups cheap enough for chunk builds.
// The table tiles every n·cell metres; callers mix two differently scaled lookups
// so the period never shows.

export class PeriodicField {
  /** octaves: [[wavelength in cells (must divide n), amplitude], ...] */
  constructor(seed, { n = 256, cell = 0.5, octaves = [[32, 1], [16, 0.5], [8, 0.25], [4, 0.125]] } = {}) {
    this.n = n; this.cell = cell; this.inv = 1 / cell;
    const t = new Float32Array(n * n);
    let norm = 0;
    for (const [, a] of octaves) norm += a;
    for (let o = 0; o < octaves.length; o++) {
      const [wl, amp] = octaves[o];
      const P = Math.max(1, Math.round(n / wl));
      const lat = new Float32Array(P * P);
      for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) lat[j * P + i] = (hash2(hash2(i, j), seed * 131 + o) / 4294967296) * 2 - 1;
      for (let y = 0; y < n; y++) {
        const fy = y / wl, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
        const y0 = (iy % P) * P, y1 = ((iy + 1) % P) * P;
        for (let x = 0; x < n; x++) {
          const fx = x / wl, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
          const x0 = ix % P, x1 = (ix + 1) % P;
          const a = lat[y0 + x0] + (lat[y0 + x1] - lat[y0 + x0]) * sx;
          const b = lat[y1 + x0] + (lat[y1 + x1] - lat[y1 + x0]) * sx;
          t[y * n + x] += (a + (b - a) * sy) * amp / norm;
        }
      }
    }
    // stretch to roughly [-1, 1]
    let m = 0;
    for (let i = 0; i < t.length; i++) m = Math.max(m, Math.abs(t[i]));
    const k = m > 0 ? 1 / m : 1;
    for (let i = 0; i < t.length; i++) t[i] *= k;
    this.t = t;
  }

  /** Bilinear sample at (x, y) metres. */
  sample(x, y) {
    const n = this.n;
    let fx = x * this.inv, fy = y * this.inv;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    fx -= ix; fy -= iy;
    const x0 = ((ix % n) + n) % n, y0 = ((iy % n) + n) % n;
    const x1 = x0 + 1 === n ? 0 : x0 + 1, y1 = y0 + 1 === n ? 0 : y0 + 1;
    const t = this.t;
    const a = t[y0 * n + x0] + (t[y0 * n + x1] - t[y0 * n + x0]) * fx;
    const b = t[y1 * n + x0] + (t[y1 * n + x1] - t[y1 * n + x0]) * fx;
    return a + (b - a) * fy;
  }
}

/** Hash to [0, 1). */
export function h01(a, b) { return hash2(a | 0, b | 0) / 4294967296; }
