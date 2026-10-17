// Vehicle one-shots and loops: brake air, doors, passenger chimes and the
// auxiliary compressor (the HVAC fans are synthesized live in layers/traction.js).
import { arng, Biquad, Resonator, SlowNoise, addMode, noiseGen, normalize, normalizeRms, fadeEnds } from '../dsp.js';

/** Pneumatic exhaust. kind 'stop' (holding brake applied) or 'release' (short pfft). */
export function airHiss(sr, kind = 'stop', k = 0) {
  const rng = arng('hiss', kind, k);
  const long = kind === 'stop';
  const dur = long ? 1.9 : 0.75, n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const hp = new Biquad(sr, 'highpass', long ? 1500 : 2200, 0.7);
  const pk = new Biquad(sr, 'peaking', rng.range(4200, 6200), 1.2, 6);
  const lp = new Biquad(sr, 'lowpass', 11000, 0.7);
  const flutter = new SlowNoise(sr, 22, nz);
  const valve = new Biquad(sr, 'lowpass', 220, 0.9);
  const tau = long ? 0.55 : 0.16;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // valve opening: short loud burst, then a decaying exhaust
    const env = Math.min(1, t / 0.012) * (0.55 * Math.exp(-t / 0.05) + 0.6 * Math.exp(-t / tau));
    const fl = Math.max(0.2, 1 + 0.22 * flutter.run());
    let x = lp.run(pk.run(hp.run(nz()))) * env * fl;
    if (t < 0.08) x += valve.run(Math.sin(6.2832 * 74 * t) * Math.exp(-t / 0.02) + nz() * 0.3 * Math.exp(-t / 0.004)) * 0.5;
    out[i] = x;
  }
  fadeEnds(out, sr, 0.001, 0.1);
  normalize(out, 0.85);
  return out;
}

/** Electric plug door: lock release, drive motor run-up and run-down, leaf rumble, end stop. */
export function doorMotion(sr, open = true) {
  const rng = arng('door', open ? 1 : 0);
  const dur = 3.2, n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const mlp = new Biquad(sr, 'lowpass', 1100, 0.8);
  const rlp = new Biquad(sr, 'lowpass', 320, 0.7);
  const ghp = new Biquad(sr, 'bandpass', 1400, 4);
  const thump = new Biquad(sr, 'lowpass', 240, 0.9);
  const t0 = 0.12, t1 = open ? 2.35 : 2.25; // motion window
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = (t - t0) / (t1 - t0);
    const moving = u > 0 && u < 1;
    const sp = moving ? Math.sin(Math.PI * u) ** 0.6 : 0; // leaf speed profile
    const f = 70 + 120 * sp;
    ph += f / sr;
    const saw = 2 * (ph - Math.floor(ph)) - 1;
    let x = mlp.run(saw * sp) * 0.3;                       // drive motor
    x += ghp.run(nz()) * sp * 0.05;                        // gearbox whine/hiss
    x += rlp.run(nz()) * sp * 0.55;                        // rollers / leaf rumble
    out[i] = x;
  }
  // lock release (open) or bolt engage + seal (close)
  const hits = open ? [[0.0, 0.7], [t1, 0.45]] : [[t1, 1.0], [t1 + 0.09, 0.35]];
  for (const [ht, g] of hits) {
    const i0 = Math.floor(ht * sr);
    for (let i = 0; i < 0.12 * sr && i0 + i < n; i++) {
      const t = i / sr;
      out[i0 + i] += thump.run(Math.sin(6.2832 * 95 * t) * Math.exp(-t / 0.035) + nz() * Math.exp(-t / 0.005) * 0.6) * g;
    }
    addMode(out, sr, i0, rng.range(1300, 1900), 0.05 * g, 0.08);
  }
  fadeEnds(out, sr, 0.002, 0.15);
  normalize(out, 0.8);
  return out;
}

/** Passenger-compartment chime: two soft electronic bell tones through a small speaker. */
export function doorChime(sr) {
  const n = Math.floor(2.2 * sr);
  const out = new Float32Array(n);
  const notes = [[0, 831], [0.43, 659]];
  for (const [t, f] of notes) {
    const i0 = Math.floor(t * sr);
    addMode(out, sr, i0, f, 1.0, 1.5, 0.004);
    addMode(out, sr, i0, f * 2.0, 0.16, 0.9, 0.004);
    addMode(out, sr, i0, f * 3.0, 0.05, 0.6, 0.004);
    addMode(out, sr, i0, f * 4.13, 0.025, 0.3, 0.003);
  }
  const hp = new Biquad(sr, 'highpass', 380, 0.7), lp = new Biquad(sr, 'lowpass', 5500, 0.7);
  for (let i = 0; i < n; i++) out[i] = lp.run(hp.run(out[i]));
  fadeEnds(out, sr, 0.001, 0.2);
  normalize(out, 0.7);
  return out;
}

/** Door-closing warning beep (one pulse; the layer repeats it). */
export function doorBeep(sr) {
  const n = Math.floor(0.16 * sr);
  const out = new Float32Array(n);
  const f = 1180;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.006) * Math.min(1, (0.16 - t) / 0.012);
    out[i] = (Math.sin(6.2832 * f * t) + 0.22 * Math.sin(6.2832 * 3 * f * t) + 0.08 * Math.sin(6.2832 * 5 * f * t)) * env;
  }
  const hp = new Biquad(sr, 'highpass', 400, 0.7), lp = new Biquad(sr, 'lowpass', 6000, 0.7);
  for (let i = 0; i < n; i++) out[i] = lp.run(hp.run(out[i]));
  normalize(out, 0.5);
  return out;
}

/** Air-compressor loop (1 s, 24 piston strokes) with its motor hum: seamless. */
export function compressorLoop(sr) {
  const rng = arng('compressor');
  const n = sr; // exactly one second
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const strokes = 24;
  const rs = new Resonator(sr).set(140, 30);
  const rm = new Resonator(sr).set(520, 90);
  // strokes are written with wrap-around so the loop is seamless
  const tmp = new Float32Array(Math.floor(0.08 * sr));
  for (let k = 0; k < strokes; k++) {
    rs.y1 = rs.y2 = rm.y1 = rm.y2 = 0;
    const g = rng.range(0.8, 1.1);
    for (let i = 0; i < tmp.length; i++) {
      const t = i / sr;
      const x = (i < 3 ? 1 : 0) * g + nz() * 0.02 * Math.exp(-t / 0.01);
      tmp[i] = rs.run(x) * 3 + rm.run(x) * 1.2 + nz() * 0.08 * Math.exp(-t / 0.006) * g;
    }
    const i0 = Math.floor((k / strokes) * n);
    for (let i = 0; i < tmp.length; i++) out[(i0 + i) % n] += tmp[i];
  }
  // motor: 100 Hz hum + harmonics, plus a little bearing noise (period divides 1 s)
  const bn = new Biquad(sr, 'bandpass', 2600, 1.5);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] += 0.05 * Math.sin(6.2832 * 100 * t) + 0.025 * Math.sin(6.2832 * 200 * t) + 0.012 * Math.sin(6.2832 * 300 * t + 1) + bn.run(nz()) * 0.01;
  }
  normalizeRms(out, 0.2);
  return out;
}
