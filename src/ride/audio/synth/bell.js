// Tram gong: a bronze/steel dome struck by a solenoid hammer under the cab front.
// Inharmonic shell modes, each a slightly split (degenerate) pair so the tail beats,
// with exponential decays that shorten as the mode order rises, plus the hammer
// contact noise, a spray of short high modes (the metallic "tick" of the strike)
// and the thump of the solenoid mechanism.
import { arng, addMode, Biquad, noiseGen, normalize, fadeEnds } from '../dsp.js';

const F1 = 642; // Hz, lowest shell mode

// ratio, amplitude, T60 (s)
const MODES = [
  [1.0, 1.0, 3.4],
  [1.506, 0.07, 1.6],
  [2.412, 0.62, 2.3],
  [2.951, 0.16, 1.5],
  [4.176, 0.38, 1.45],
  [5.093, 0.09, 1.0],
  [6.012, 0.25, 0.95],
  [8.231, 0.14, 0.62],
  [10.86, 0.075, 0.42],
  [13.74, 0.04, 0.26],
];

/** One hammer strike; variant k changes hardness, mode balance and beating slightly. */
export function bellStrike(sr, k = 0) {
  const rng = arng('bell', k);
  const n = Math.floor(3.8 * sr);
  const out = new Float32Array(n);
  const hard = [1.0, 0.86, 1.14, 0.95][k % 4];
  const i0 = Math.floor(0.004 * sr); // small pre-roll for the mechanism click

  for (const [ratio, amp, t60] of MODES) {
    const f = F1 * ratio * (1 + rng.range(-0.0012, 0.0012));
    const split = rng.range(0.45, 2.4) * (ratio > 3 ? 1.6 : 1);
    const a = amp * Math.pow(hard, Math.log2(ratio) * 1.3) * rng.range(0.9, 1.1);
    const bal = rng.range(0.22, 0.45);
    addMode(out, sr, i0, f, a * (1 - bal), t60 * rng.range(0.92, 1.06), 0.0007);
    addMode(out, sr, i0, f + split, a * bal, t60 * rng.range(0.8, 1.05), 0.0007);
  }
  // short-lived high modes: the bright, metallic strike transient
  for (let j = 0; j < 14; j++) {
    const f = rng.range(3200, 11500);
    addMode(out, sr, i0, f, rng.range(0.012, 0.05) * hard, rng.range(0.03, 0.14), 0.0003);
  }
  // hammer contact: a 2-3 ms band-limited noise burst
  const nz = noiseGen(rng);
  const bp = new Biquad(sr, 'bandpass', 3800 * hard, 0.7);
  const nc = Math.floor(0.012 * sr);
  for (let i = 0; i < nc; i++) out[i0 + i] += bp.run(nz()) * Math.exp(-i / (0.0022 * sr)) * 0.45 * hard;
  // solenoid / armature thump heard through the cab floor
  const lp = new Biquad(sr, 'lowpass', 260, 0.8);
  const nt = Math.floor(0.09 * sr);
  for (let i = 0; i < nt; i++) {
    const t = i / sr;
    const s = Math.sin(2 * Math.PI * (88 * t + 30 * (1 - Math.exp(-t / 0.01)) * 0.01)) * Math.exp(-t / 0.022);
    out[i] += lp.run(s * 0.16 + nz() * 0.05 * Math.exp(-t / 0.004));
  }
  fadeEnds(out, sr, 0.0005, 0.25);
  normalize(out, 0.9);
  return out;
}
