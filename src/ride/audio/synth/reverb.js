// Street-canyon impulse response for the convolution reverb.
// The tram runs between two roughly parallel limestone facades (about 24 m apart,
// listener 1.6 m right of centre), so the early part is a sparse train of facade
// reflections (a mild flutter between the walls), each smeared by balconies, cornices
// and openings. The late part is a diffuse, frequency-dependent decay: open to the
// sky, so it dies away fairly quickly, faster at high frequencies. The engine
// crossfades a narrow and a wide variant by the local facade spacing.
import { arng, Biquad, noiseGen } from '../dsp.js';

const C = 343;

export function streetIR(sr, opts = {}) {
  const { right = 10.3, left = 13.6, seconds = 2.2 } = opts;
  const n = Math.floor(seconds * sr);
  const rng = arng('ir', right, left);
  const L = new Float32Array(n), R = new Float32Array(n);
  const W = right + left;

  // ---- early reflections: 1-D image sources between the two facades
  const taps = [];
  for (let k = 0; k < 7; k++) {
    // paths that end on the right wall and on the left wall
    taps.push({ d: 2 * right + 2 * k * W, side: +1, order: 2 * k + 1 });
    taps.push({ d: 2 * left + 2 * k * W, side: -1, order: 2 * k + 1 });
    if (k > 0) taps.push({ d: 2 * k * W, side: 0, order: 2 * k });
  }
  const nz = noiseGen(rng);
  for (const tp of taps) {
    const t = tp.d / C;
    if (t > seconds - 0.1) continue;
    const absorb = Math.pow(0.72, tp.order);           // stone + openings + scattering per bounce
    const spread = 1 / (tp.d / 8);                     // spherical spreading (relative)
    const g = absorb * spread * 0.9;
    const smear = 0.0015 + tp.order * 0.0025;          // diffusion grows with each bounce
    const lp = new Biquad(sr, 'lowpass', Math.max(1800, 9000 / tp.order), 0.6);
    const lp2 = new Biquad(sr, 'lowpass', Math.max(1800, 9000 / tp.order), 0.6);
    const i0 = Math.floor(t * sr), m = Math.floor(smear * 5 * sr);
    const gl = tp.side > 0 ? 0.55 : tp.side < 0 ? 1 : 0.8;
    const gr = tp.side > 0 ? 1 : tp.side < 0 ? 0.55 : 0.8;
    for (let i = 0; i < m && i0 + i < n; i++) {
      const env = Math.exp(-i / (smear * sr));
      L[i0 + i] += lp.run(nz()) * env * g * gl;
      R[i0 + i] += lp2.run(nz()) * env * g * gr;
    }
  }

  // ---- late diffuse tail, three bands with their own decay times
  const bands = [
    { type: 'lowpass', f: 450, rt: 1.35, g: 1.0 },
    { type: 'bandpass', f: 1600, rt: 1.05, g: 0.8, q: 0.5 },
    { type: 'highpass', f: 4200, rt: 0.5, g: 0.45 },
  ];
  const onset = 0.035, rise = 0.06;
  for (const [ch, chan] of [[0, L], [1, R]]) {
    const nzc = noiseGen(arng('ir-tail', ch));
    for (const b of bands) {
      const f = new Biquad(sr, b.type, b.f, b.q || 0.7);
      const f2 = new Biquad(sr, b.type, b.f, b.q || 0.7);
      const k = -6.907755 / (b.rt * sr);
      for (let i = Math.floor(onset * sr); i < n; i++) {
        const t = i / sr;
        const fade = t < onset + rise ? 0.5 - 0.5 * Math.cos((Math.PI * (t - onset)) / rise) : 1;
        chan[i] += f2.run(f.run(nzc())) * Math.exp(k * i) * fade * b.g * 0.035;
      }
    }
  }
  // fade the very end so the convolver tail never truncates audibly
  const tail = Math.floor(0.03 * sr);
  for (let i = 0; i < tail; i++) { const w = i / tail; L[n - 1 - i] *= w; R[n - 1 - i] *= w; }

  // normalise to unit energy per channel; the sends set the level
  for (const c of [L, R]) {
    let e = 0; for (let i = 0; i < n; i++) e += c[i] * c[i];
    const g = 1 / Math.sqrt(e + 1e-12);
    for (let i = 0; i < n; i++) c[i] *= g;
  }
  return [L, R];
}

/**
 * Cab / saloon impulse response: a small, furnished metal-and-glass room. Dense early
 * reflections between 2 and 14 ms (walls, windscreen, ceiling, floor 1-3 m away),
 * then a short diffuse decay (RT60 ~0.2 s) losing its top end to the seats.
 */
export function cabIR(sr) {
  const seconds = 0.4, n = Math.floor(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rng = arng('ir-cab');
  for (const [c, chan] of [[0, L], [1, R]]) {
    const nz = noiseGen(arng('ir-cab', c));
    // early reflections: ~40 taps, each a tiny smeared click, louder for shorter paths
    for (let k = 0; k < 40; k++) {
      const t = rng.range(0.002, 0.014);
      const g = (0.0035 / t) * rng.range(0.3, 1) * (rng.chance(0.5) ? 1 : -1);
      const i0 = Math.floor(t * sr), w = Math.floor(rng.range(0.0002, 0.0008) * sr);
      for (let i = 0; i < w && i0 + i < n; i++) chan[i0 + i] += g * (1 - i / w) * (0.6 + 0.4 * nz());
    }
    // diffuse tail, darker as it decays
    const lp = new Biquad(sr, 'lowpass', 5200, 0.6);
    const k60 = -6.907755 / (0.2 * sr);
    for (let i = Math.floor(0.004 * sr); i < n; i++) {
      const t = i / sr, rise = Math.min(1, (t - 0.004) / 0.01);
      chan[i] += lp.run(nz()) * Math.exp(k60 * i) * rise * 0.25;
    }
  }
  const tail = Math.floor(0.02 * sr);
  for (let i = 0; i < tail; i++) { const w = i / tail; L[n - 1 - i] *= w; R[n - 1 - i] *= w; }
  for (const c of [L, R]) {
    let e = 0; for (let i = 0; i < n; i++) e += c[i] * c[i];
    const g = 1 / Math.sqrt(e + 1e-12);
    for (let i = 0; i < n; i++) c[i] *= g;
  }
  return [L, R];
}
