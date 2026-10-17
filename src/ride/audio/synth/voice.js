// Source-filter voice synthesis for the crowd. Voices are never heard up close: the
// ambience layer resequences a pool of utterances at runtime into conversations
// 9-40 m away (attached to the people standing and sitting around the street), plus
// a few distant laughs and calls.
//
// Each voice: a Rosenberg glottal pulse (flow derivative, per-speaker open quotient)
// with period jitter and amplitude shimmer, a continuous intonation contour (cosine
// interpolation through the syllable targets, declination, phrase-final fall or rise),
// pitch-synchronous aspiration noise, a cascade of five formant resonators (F1-F3
// gliding between vowel targets at syllable rate, F4/F5 fixed per speaker, all with
// per-speaker bandwidths), a nasal pole / zero pair that opens for nasal consonants,
// and fricative / stop-burst noise.
import { arng, Biquad, Resonator, AntiResonator, OnePole, noiseGen, normalizeRms, limit, clamp } from '../dsp.js';

// adult male formant targets F1-F3 (Hz)
const VOWELS = [
  [730, 1090, 2440], [530, 1840, 2480], [390, 1990, 2550], [270, 2290, 3010],
  [570, 840, 2410], [440, 1020, 2240], [300, 870, 2240], [500, 1500, 2500], [660, 1720, 2410],
];
export const SPEAKERS = 20;   // distinct voices in the utterance pool
export const UTT_PER = 3;     // utterances per voice

/** One period of the Rosenberg glottal flow derivative (opening Tp, closing Tn as fractions). */
function glottalTable(Tp, Tn, N = 512) {
  const t = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const x = (i % N) / N;
    let d = 0;
    if (x < Tp) d = ((0.5 * Math.PI) / Tp) * Math.sin((Math.PI * x) / Tp);
    else if (x < Tp + Tn) d = (-Math.PI / (2 * Tn)) * Math.sin((Math.PI * (x - Tp)) / (2 * Tn));
    t[i] = d * 0.12;
  }
  return t;
}

/** Make a speaker: sex, pitch, vocal-tract scale, speaking rate, voice quality. */
export function makeSpeaker(rng, opts = {}) {
  const female = opts.female ?? rng.chance(0.5);
  const child = opts.child ?? false;
  const scale = child ? rng.range(1.26, 1.36) : female ? rng.range(1.12, 1.2) : rng.range(0.95, 1.04);
  const oq = female || child ? rng.range(0.46, 0.56) : rng.range(0.38, 0.48); // open quotient
  return {
    female,
    f0: child ? rng.range(250, 320) : female ? rng.range(170, 235) : rng.range(92, 135),
    scale,
    rate: rng.range(3.8, 5.8),
    breath: rng.range(0.04, 0.12) + (female ? 0.03 : 0),
    range: rng.range(0.12, 0.3), // intonation range
    bw: [60, 90, 150, 250, 300].map((b) => b * rng.range(0.8, 1.2)),
    F45: [3300 * scale * rng.range(0.96, 1.04), 3750 * scale * rng.range(0.96, 1.04)],
    jitter: rng.range(0.005, 0.012),
    shimmer: rng.range(0.3, 0.6), // dB per period
    glot: glottalTable(oq * 0.74, oq * 0.26),
    Tc: oq,
  };
}

/**
 * Plan an utterance: a list of segments {dur, kind, F, amp, f0m, noiseF}.
 * kind: 'v' voiced vowel/sonorant, 'n' nasal, 'f' fricative, 's' stop closure (+burst),
 * 'h' breathy (laugh), 'p' pause.
 */
function planUtterance(rng, sp, seconds, style = 'talk') {
  const segs = [];
  // one object shape for every segment keeps the render loop monomorphic
  const seg = (dur, kind, F, amp, f0m, noiseF = 0) => segs.push({ dur, kind, F, amp, f0m, noiseF });
  let t = 0;
  const vowel = () => VOWELS[rng.int(0, VOWELS.length - 1)].map((f) => f * sp.scale);
  while (t < seconds) {
    const words = rng.int(2, 9);
    const phraseLen = (words * 2.2) / sp.rate;
    const question = rng.chance(0.2);
    let pt = 0;
    for (let w = 0; w < words && t < seconds; w++) {
      const syl = style === 'laugh' ? 1 : rng.int(1, 3);
      for (let k = 0; k < syl; k++) {
        const decl = 1 - 0.18 * clamp(pt / phraseLen, 0, 1);
        const stress = k === 0 && rng.chance(0.45);
        const accent = stress ? 1 + sp.range * rng.range(0.4, 1) : 1 + rng.range(-0.05, 0.05);
        const f0m = decl * accent;
        const amp = rng.range(0.6, 1) * (stress ? 1.15 : 1);
        if (style === 'laugh') {
          seg(rng.range(0.05, 0.08), 'h', vowel(), amp * 0.7, f0m, 1500);
        } else if (rng.chance(0.78)) {
          const c = rng.weighted([['s', 0.35], ['f', 0.3], ['n', 0.2], ['l', 0.15]]);
          if (c === 's') seg(rng.range(0.03, 0.07), 's', vowel(), amp * 0.8, f0m, rng.range(1200, 3800) * sp.scale);
          else if (c === 'f') seg(rng.range(0.06, 0.12), 'f', vowel(), amp * 0.5, f0m, rng.pick([2600, 3800, 5200, 6400]) * sp.scale);
          else if (c === 'n') seg(rng.range(0.05, 0.08), 'n', [280, 1100, 2300].map((f) => f * sp.scale), amp * 0.45, f0m);
          else seg(rng.range(0.04, 0.07), 'v', [360, 1250, 2650].map((f) => f * sp.scale), amp * 0.6, f0m);
        }
        const vd = (style === 'laugh' ? rng.range(0.09, 0.13) : rng.range(0.07, 0.19) * (stress ? 1.3 : 1)) * (5 / sp.rate);
        seg(vd, 'v', vowel(), amp, f0m);
        t += vd + 0.06; pt += vd + 0.06;
      }
      if (rng.chance(0.25)) { const g = rng.range(0.02, 0.09); seg(g, 'p', null, 0, 1); t += g; pt += g; }
    }
    // phrase-final fall (or rise for a question) over the last two syllables
    const voiced = segs.filter((s) => s.kind === 'v');
    const fin = question ? 1.18 : 0.84;
    if (voiced.length) voiced[voiced.length - 1].f0m *= fin;
    if (voiced.length > 1) voiced[voiced.length - 2].f0m *= Math.sqrt(fin);
    const pause = style === 'laugh' ? rng.range(0.05, 0.12) : rng.range(0.25, 0.9);
    seg(pause, 'p', null, 0, 1);
    t += pause;
  }
  return segs;
}

/** Render an utterance into a new mono Float32Array (sr). */
export function renderUtterance(rng, sr, sp, seconds, style = 'talk') {
  const segs = planUtterance(rng, sp, seconds, style);
  // f0 targets at the centre of every voiced segment, interpolated continuously
  const knots = [];
  let tt = 0;
  for (const sg of segs) {
    if (sg.kind === 'v' || sg.kind === 'h' || sg.kind === 'n') knots.push(tt + sg.dur / 2, sp.f0 * sg.f0m);
    tt += sg.dur;
  }
  if (!knots.length) knots.push(0, sp.f0);
  const total = tt;
  const n = Math.ceil((total + 0.15) * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const R = [0, 1, 2, 3, 4].map(() => new Resonator(sr));
  R[3].set(sp.F45[0], sp.bw[3]); R[4].set(sp.F45[1], sp.bw[4]);
  const NP = new Resonator(sr).set(270, 100), NZ = new AntiResonator(sr).set(270, 100);
  const fr = new Resonator(sr), frHp = new Biquad(sr, 'highpass', 1700, 0.7), frHp2 = new Biquad(sr, 'highpass', 1700, 0.7);
  const dcb = new Biquad(sr, 'highpass', 70, 0.7);
  const env = new OnePole(sr, 28), nenv = new OnePole(sr, 45);
  const F = [500 * sp.scale, 1500 * sp.scale, 2500 * sp.scale];
  const fTarget = F.slice();
  let nzF = 270, nzT = 270;
  const G = sp.glot, GN = G.length - 1;
  let ph = 0, f0 = sp.f0, per = 1, amp = 1;
  let i = 0, k = 0;
  const BLOCK = 32;
  for (const sg of segs) {
    const m = Math.floor(sg.dur * sr);
    if (sg.F) for (let j = 0; j < 3; j++) fTarget[j] = sg.F[j];
    nzT = sg.kind === 'n' ? 750 * sp.scale : 270;
    const voiced = sg.kind === 'v' || sg.kind === 'n';
    const vAmp = voiced ? sg.amp : sg.kind === 'h' ? sg.amp * 0.25 : sg.kind === 'f' ? sg.amp * 0.08 : 0;
    const nAmp = sg.kind === 'f' ? sg.amp * 0.5 : sg.kind === 'h' ? sg.amp * 0.6 : 0;
    if (sg.kind === 'f' || sg.kind === 'h') fr.set(sg.noiseF, sg.kind === 'h' ? 1800 : 1400);
    const burstAt = sg.kind === 's' ? m - Math.floor(0.012 * sr) : -1;
    if (sg.kind === 's') fr.set(sg.noiseF, 2000);
    for (let j = 0; j < m && i < n; j++, i++) {
      if ((i & (BLOCK - 1)) === 0) {
        // coarticulation: formants and the nasal zero glide towards their targets (~25 ms)
        for (let q = 0; q < 3; q++) { F[q] += (fTarget[q] - F[q]) * 0.07; R[q].set(F[q], sp.bw[q]); }
        nzF += (nzT - nzF) * 0.1; NZ.set(nzF, 100);
        // intonation: cosine interpolation between the syllable targets
        const t = i / sr;
        while (k < knots.length - 4 && knots[k + 2] < t) k += 2;
        const t0 = knots[k], t1 = knots[k + 2] ?? t0;
        const u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
        const w = 0.5 - 0.5 * Math.cos(Math.PI * u);
        f0 = knots[k + 1] + ((knots[k + 3] ?? knots[k + 1]) - knots[k + 1]) * w;
      }
      ph += (f0 * per) / sr;
      if (ph >= 1) {
        // a new glottal period: jitter its length, shimmer its amplitude
        ph -= 1;
        per = 1 + nz() * sp.jitter;
        amp = Math.pow(10, (nz() * sp.shimmer) / 20);
      }
      const x = ph * GN, xi = x | 0;
      const glot = dcb.run((G[xi] + (G[xi + 1] - G[xi]) * (x - xi)) * amp);
      const e = env.run(vAmp);
      const ne = nenv.run(nAmp);
      // aspiration is louder while the glottis is open
      const asp = nz() * sp.breath * e * (ph < sp.Tc ? 1 : 0.35);
      let y = glot * e + asp;
      for (let q = 0; q < 5; q++) y = R[q].run(y);
      y = NZ.run(NP.run(y));
      // frication and stop bursts: band-limited noise, well below the vowels
      let nx = ne > 1e-4 ? nz() * ne * 0.045 : 0;
      if (sg.kind === 's' && j >= burstAt) nx += nz() * sg.amp * Math.exp(-(j - burstAt) / (0.004 * sr)) * 0.06;
      out[i] = y + frHp2.run(frHp.run(fr.run(nx)));
    }
  }
  return out;
}

/** The voice of pool speaker `spk` (deterministic): one in ten is a child. */
export function poolSpeaker(spk) {
  return makeSpeaker(arng('speaker', spk), { child: spk % 10 === 9, female: spk % 10 === 9 ? undefined : spk % 2 === 0 });
}

/**
 * Pool utterance k of speaker `spk`: 2.6-4.4 s of conversational speech, RMS-normalised
 * (so the runtime can set levels by distance) with a natural crest factor.
 */
export function utterance(sr, spk, k) {
  const rng = arng('utt', spk, k);
  const out = renderUtterance(rng, sr, poolSpeaker(spk), rng.range(2.6, 4.4));
  new Biquad(sr, 'lowpass', Math.min(7000, sr * 0.42), 0.7).process(out);
  normalizeRms(out, 0.1);
  limit(out, sr, 0.1 * 4.5);
  return out;
}

/** Distant vocal one-shots: 'laugh' or 'call' (a short shout across the street). */
export function voiceShot(sr, kind, k) {
  const rng = arng('vshot', kind, k);
  let out;
  if (kind === 'laugh') {
    const sp = makeSpeaker(rng);
    sp.breath += 0.12; sp.f0 *= 1.15;
    out = renderUtterance(rng, sr, sp, rng.range(0.7, 1.3), 'laugh');
  } else {
    const sp = makeSpeaker(rng, { child: rng.chance(0.3) });
    sp.f0 *= 1.35; sp.range = 0.4; sp.rate = 3.2;
    out = renderUtterance(rng, sr, sp, rng.range(0.35, 0.7));
  }
  new Biquad(sr, 'lowpass', Math.min(7000, sr * 0.42), 0.7).process(out);
  normalizeRms(out, 0.12);
  limit(out, sr, 0.12 * 4.5); // natural speech crest factor (~13 dB)
  normalizeRms(out, 0.12);
  return out;
}
