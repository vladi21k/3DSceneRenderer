// Wheel/rail one-shots: groove grit grains, weld thumps, the impact family (rail
// joints, switch frogs, check-rail scrape) and the brake stick-slip at standstill.
// The rolling noise itself is synthesized live (layers/rolling.js).
import { arng, Biquad, Resonator, SlowNoise, addMode, noiseGen, normalize, fadeEnds, smoothstep, TAU } from '../dsp.js';

export const WHEEL_CIRC = 2.07;          // m, 660 mm wheels
export const CREAK_LEAD = 1.3;           // s from the start of the brake creak to standstill

/**
 * Grit in the rail groove: one short crackle grain. The rolling layer fires these at
 * random, at a rate proportional to speed, so the crackle never forms a pattern.
 */
export function grit(sr, k) {
  const rng = arng('grit', k);
  const n = Math.floor(0.03 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const hp = new Biquad(sr, 'highpass', rng.range(1500, 2400), 0.7);
  const lp = new Biquad(sr, 'lowpass', rng.range(5000, 8500), 0.7);
  const hits = rng.int(1, 3);
  for (let h = 0; h < hits; h++) {
    const i0 = Math.floor(rng.range(0, 0.008) * sr), tau = rng.range(0.0008, 0.004) * sr, g = rng.range(0.4, 1);
    for (let i = i0; i < n; i++) out[i] += nz() * g * Math.exp(-(i - i0) / tau);
  }
  for (let i = 0; i < n; i++) out[i] = lp.run(hp.run(out[i]));
  fadeEnds(out, sr, 0.0002, 0.006);
  normalize(out, 0.9);
  return out;
}

/** A welded rail joint: no knock, only a faint low thump through the floor (< 300 Hz). */
export function thump(sr, k) {
  const rng = arng('thump', k);
  const n = Math.floor(0.25 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const f0 = rng.range(52, 84), tau = rng.range(0.025, 0.045);
  const lp = new Biquad(sr, 'lowpass', rng.range(220, 300), 0.7), lp2 = new Biquad(sr, 'lowpass', 300, 0.7);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (TAU * f0 * (1 + 0.4 * Math.exp(-t / 0.01))) / sr;
    out[i] = lp2.run(lp.run(Math.sin(ph) * Math.exp(-t / tau) + nz() * 0.5 * Math.exp(-t / 0.012)));
  }
  fadeEnds(out, sr, 0.001, 0.05);
  normalize(out, 0.9);
  return out;
}

/** Rail-joint impact as heard in the cab: floor thump, body knock, faint wheel ring. */
export function clack(sr, k) {
  const rng = arng('clack', k);
  const n = Math.floor(0.42 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const f0 = rng.range(68, 104);
  const dTh = rng.range(0.035, 0.06);
  let ph = 0;
  const body = new Biquad(sr, 'bandpass', rng.range(420, 780), 1.1);
  const click = new Biquad(sr, 'highpass', 1600, 0.7);
  const lp = new Biquad(sr, 'lowpass', 5200, 0.7);
  const second = Math.floor(rng.range(0.003, 0.009) * sr); // wheel lands on the far rail end
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (6.2832 * f0 * (1 + 0.6 * Math.exp(-t / 0.008))) / sr;
    let x = Math.sin(ph) * Math.exp(-t / dTh) * 1.0;
    x += body.run(nz()) * Math.exp(-t / 0.018) * 1.3;
    x += click.run(nz()) * Math.exp(-t / 0.0012) * 0.35;
    if (i >= second) x += body.run(nz()) * Math.exp(-(i - second) / (0.012 * sr)) * 0.7;
    out[i] = lp.run(x);
  }
  // wheel/rail ring
  for (let j = 0; j < 4; j++) addMode(out, sr, 0, rng.range(900, 1400) * (1 + j * 0.85), rng.range(0.02, 0.06), rng.range(0.05, 0.16));
  fadeEnds(out, sr, 0.0003, 0.05);
  normalize(out, 0.9);
  return out;
}

/** Switch frog: the wheel crosses the flangeway gap - a heavier double knock with ring. */
export function frog(sr, k) {
  const rng = arng('frog', k);
  const n = Math.floor(0.7 * sr);
  const out = new Float32Array(n);
  const a = clack(sr, 100 + k), b = clack(sr, 200 + k);
  const gap = Math.floor(rng.range(0.012, 0.03) * sr);
  for (let i = 0; i < a.length; i++) out[i] += a[i] * 0.8;
  for (let i = 0; i < b.length && i + gap < n; i++) out[i + gap] += b[i];
  for (let j = 0; j < 5; j++) addMode(out, sr, gap, rng.range(600, 950) * (1 + j * 0.9), rng.range(0.04, 0.09), rng.range(0.15, 0.35));
  fadeEnds(out, sr, 0.0003, 0.08);
  normalize(out, 0.95);
  return out;
}

/** Flange against a check rail / switch blade: a short grinding scrape. */
export function scrape(sr, k) {
  const rng = arng('scrape', k);
  const n = Math.floor(0.9 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const r1 = new Resonator(sr).set(rng.range(1700, 2300), 160);
  const r2 = new Resonator(sr).set(rng.range(2900, 3600), 260);
  const hp = new Biquad(sr, 'highpass', 900, 0.7);
  const jit = new SlowNoise(sr, 35, nz);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.35) / 0.18);
    const j = 0.4 + Math.abs(jit.run()) * 0.8;
    const x = nz() * j;
    out[i] = hp.run(r1.run(x) * 0.6 + r2.run(x) * 0.4 + x * 0.05) * env;
  }
  fadeEnds(out, sr, 0.002, 0.05);
  normalize(out, 0.8);
  return out;
}

/**
 * Friction-brake stick-slip over the last metre or so before standstill: a low groan
 * whose pulse rate (its pitch) falls with the sliding speed, turning into the slow
 * creak of the last few centimetres, then the settle clunk as the body pitches back.
 * Standstill is at CREAK_LEAD seconds into the buffer.
 */
export function brakeCreak(sr, k) {
  const rng = arng('creak', k);
  const lead = CREAK_LEAD, dur = lead + 0.25, n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  // groan modes (pad / caliper / bogie frame) and the creak modes of the last centimetres
  const gF = [rng.range(165, 200), rng.range(270, 320), rng.range(390, 450)];
  const cF = [rng.range(150, 190), rng.range(380, 460), rng.range(1050, 1300)];
  const gR = gF.map((f, j) => new Resonator(sr).set(f, [18, 26, 40][j]));
  const cR = cF.map((f, j) => new Resonator(sr).set(f, [14, 22, 45][j]));
  // a unity-DC resonator rings with amplitude ~ omega, so divide that out to set the balance
  const gA = [1.0, 0.7, 0.35].map((a, j) => a / ((TAU * gF[j]) / sr));
  const cA = [1.0, 0.55, 0.22].map((a, j) => a / ((TAU * cF[j]) / sr));
  const r0 = rng.range(170, 230);
  const jit = new SlowNoise(sr, 30, nz);
  let ph = 0;
  const end = Math.floor(lead * sr);
  for (let i = 0; i < end; i++) {
    const t = i / sr, u = t / lead;
    // slip events per second fall with the sliding speed, with stick-slip irregularity
    const rate = (10 + r0 * Math.pow(1 - u, 1.7)) * (1 + 0.08 * jit.run());
    ph += rate / sr;
    let pulse = 0;
    if (ph >= 1) { ph -= 1; pulse = rng.range(0.55, 1.2); }
    const env = Math.pow(u, 0.7) * (0.6 + 0.4 * smoothstep(0, 0.4, u));
    const x = pulse * env + nz() * 0.004 * env;
    const w = smoothstep(0.55, 0.85, u); // groan -> creak
    let y = 0;
    for (let j = 0; j < 3; j++) y += gR[j].run(x) * gA[j] * (1 - w) * 0.8 + cR[j].run(x) * cA[j] * w;
    out[i] = y;
  }
  // settle clunk: the body pitches back as the tram comes to rest
  const lp = new Biquad(sr, 'lowpass', 180, 0.9);
  for (let i = 0; i < n - end; i++) {
    const t = i / sr;
    out[end + i] += lp.run(Math.sin(TAU * 62 * t) * Math.exp(-t / 0.06) + nz() * 0.2 * Math.exp(-t / 0.01)) * 0.9;
  }
  fadeEnds(out, sr, 0.02, 0.04);
  normalize(out, 0.85);
  return out;
}

/** Cab fittings rattling after a hard knock: a few tiny buzzy contacts of a loose panel. */
export function rattle(sr, k) {
  const rng = arng('rattle', k);
  const n = Math.floor(0.16 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const modes = [rng.range(1300, 2100), rng.range(2600, 3600), rng.range(4200, 5600)];
  const hits = rng.int(3, 7);
  let t = 0.002;
  for (let h = 0; h < hits && t < 0.1; h++) {
    const i0 = Math.floor(t * sr), g = rng.range(0.4, 1) * Math.exp(-t / 0.05);
    modes.forEach((f, j) => addMode(out, sr, i0, f * rng.range(0.98, 1.02), g * [1, 0.6, 0.3][j], rng.range(0.02, 0.05), 0.0002));
    for (let i = 0; i < 0.002 * sr && i0 + i < n; i++) out[i0 + i] += nz() * g * 0.3 * Math.exp(-i / (0.0004 * sr));
    t += rng.range(0.008, 0.025);
  }
  fadeEnds(out, sr, 0.0002, 0.02);
  normalize(out, 0.8);
  return out;
}
