// Curve squeal: in tight curves (|curvature| > 1/150 m^-1, above 8 km/h) the wheels
// stick-slip laterally and an axial wheel mode rings: a narrowband tone in the 2-6 kHz
// range. It is a limit cycle, so it is pitch-stable (only small irregular jitter),
// switches on abruptly, comes and goes in bursts at the same spots of the curve, and
// usually only one wheel mode wins at a time, hopping between two candidates. The tone
// is amplitude-modulated at the wheel rotation rate, with a weak, slightly detuned
// second harmonic. Intensity follows curvature x speed. A broadband flange-rubbing
// hiss accompanies any noticeable curve. Emitted from the front bogie's outer wheel.
import { noise1, hash2 } from '../../../core/rng.js';
import { glide, clamp, smoothstep } from '../dsp.js';
import { WHEEL_CIRC } from '../synth/rail.js';
import { AXLES } from '../track.js';

const K_MIN = 1 / 150, K_MAX = 1 / 55;
const V_MIN = 8 / 3.6;
const BOGIE = (AXLES[0].o + AXLES[1].o) / 2;

export class SquealLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    // wheel-rate amplitude modulation, then the outer wheel of the front bogie
    this.am = new GainNode(ctx, { gain: 1 });
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 1200, Q: 0.7 });
    // equal-power: a loud narrowband tone from below would be coloured unpredictably by HRTF notches
    this.panner = e.vehiclePanner(0.72, 0.4, BOGIE, 2, 'equalpower');
    this.am.connect(this.hp).connect(this.panner).connect(e.bus.squeal);
    this.wheel = new OscillatorNode(ctx, { frequency: 2 });
    this.amDepth = new GainNode(ctx, { gain: 0.3 });
    this.wheel.connect(this.amDepth).connect(this.am.gain);

    // two candidate wheel modes; each: fundamental + weak detuned 2nd harmonic,
    // frequency jitter from band-limited noise (no periodic vibrato)
    this.modes = [0, 1].map((i) => {
      const osc = new OscillatorNode(ctx, { frequency: 3000 + 900 * i });
      const osc2 = new OscillatorNode(ctx, { frequency: 6000 + 1800 * i });
      const h2 = new GainNode(ctx, { gain: 0.07 });
      const g = new GainNode(ctx, { gain: 0 });
      osc.connect(g); osc2.connect(h2).connect(g);
      g.connect(this.am);
      const jit = e.drift(11 + 4 * i);
      const jd = new GainNode(ctx, { gain: 0 }), jd2 = new GainNode(ctx, { gain: 0 });
      jit.connect(jd).connect(osc.frequency);
      jit.connect(jd2).connect(osc2.frequency);
      osc.start(); osc2.start();
      return { osc, osc2, g, jd, jd2, on: false, f: 3000 };
    });
    // rough narrowband noise riding on the winning tone
    this.nbp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3000, Q: 28 });
    this.ng = new GainNode(ctx, { gain: 0 });
    e.noise().connect(this.nbp).connect(this.ng).connect(this.am);
    // flange rubbing hiss
    this.fbp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3600, Q: 0.8 });
    this.fg = new GainNode(ctx, { gain: 0 });
    e.noise().connect(this.fbp).connect(this.fg).connect(this.am);

    this.curve = -1;
    this.f0 = [3000, 4200];
    this.gate = false;
    this.dom = 0;
    this.side = 1;
    this.idle = true;
  }

  update(dt, st, now) {
    const e = this.e;
    const sb = st.s - BOGIE;
    const k = e.route.curvature(sb), ka = Math.abs(k), v = st.speed;
    const excess = clamp((ka - K_MIN) / (K_MAX - K_MIN), 0, 1);
    const vf = smoothstep(V_MIN, V_MIN + 2.5, v) * clamp(v / 7, 0, 1.5);
    const I = ka > K_MIN ? Math.pow(excess, 0.6) * vf : 0;
    const rub = clamp((ka - 1 / 400) / (1 / 60), 0, 1) * clamp(v / 9, 0, 1.4);
    // nothing to do on straight track once everything has faded out
    if (I <= 0 && rub <= 0) {
      if (!this.idle) {
        this.idle = true;
        for (const m of this.modes) { m.on = false; glide(m.g.gain, 0, now, 0.03, 0); }
        glide(this.ng.gain, 0, now, 0.03, 0);
        glide(this.fg.gain, 0, now, 0.2, 0);
        this.gate = false;
      }
      return;
    }
    this.idle = false;

    // each curve has its own pair of wheel modes
    const seg = e.route.segmentAt(sb);
    if (seg.index !== this.curve) {
      this.curve = seg.index;
      const h1 = hash2(seg.index, 77) / 4294967296, h2 = hash2(seg.index, 78) / 4294967296;
      this.f0 = [2500 + 2600 * h1, 0];
      this.f0[1] = this.f0[0] * (h2 < 0.5 ? 1.37 + 0.2 * h2 : 0.62 + 0.1 * h2);
      this.seed = seg.index * 13 + 5;
    }
    // outer wheel of the front bogie
    const side = k > 0 ? 1 : -1;
    if (side !== this.side) { this.side = side; e.setLocal(this.panner, side * 0.72, 0.4, BOGIE); }

    // bursts tied to position on the curve (the same spots squeal every lap), with
    // hysteresis: the limit cycle starts abruptly and holds until well below threshold
    const sp = noise1(sb / 3.4, this.seed) + 0.6 * (I - 0.35);
    const gate = I > 0 && (this.gate ? sp > 0.02 : sp > 0.22);
    // which mode wins (also with hysteresis); hops are fast
    const w = noise1(sb / 1.9 + 50, this.seed + 7);
    const dom = this.dom === 0 ? (w > 0.25 ? 1 : 0) : (w < -0.25 ? 0 : 1);
    const level = 0.4 * I * (0.75 + 0.25 * noise1(st.t * 1.3, this.seed + 2));
    for (let i = 0; i < 2; i++) {
      const m = this.modes[i];
      const on = gate && i === dom;
      const f = this.f0[i] * (1 + 0.0015 * noise1(st.t * 0.25, this.seed + 4 + i) + 0.003 * excess);
      const f2 = 2 * f * (i ? 0.9972 : 1.0031);
      if (on && !m.on) {
        // the limit cycle starts at its own pitch: no glide into it
        for (const [o, v] of [[m.osc, f], [m.osc2, f2]]) { o.frequency.cancelScheduledValues(now); o.frequency.setValueAtTime(v, now); o.frequency.__last = v; }
      }
      if (on || m.on) {
        glide(m.osc.frequency, f, now, 0.05);
        glide(m.osc2.frequency, f2, now, 0.05);
        glide(m.jd.gain, f * 0.0008, now, 0.2);
        glide(m.jd2.gain, f * 0.0016, now, 0.2);
      }
      if (on && !m.on) { m.g.gain.cancelScheduledValues(now); m.g.gain.setTargetAtTime(level, now, 0.004); m.g.gain.__last = level; }
      else if (!on && m.on) { m.g.gain.cancelScheduledValues(now); m.g.gain.setTargetAtTime(0, now, this.gate && gate ? 0.012 : 0.03); m.g.gain.__last = 0; }
      else if (on) glide(m.g.gain, level, now, 0.08, 1e-3);
      m.on = on;
      if (on) m.f = f;
    }
    this.gate = gate;
    this.dom = dom;
    glide(this.nbp.frequency, this.modes[dom].f, now, 0.02);
    glide(this.ng.gain, gate ? level * 1.6 : 0, now, gate ? 0.006 : 0.03, 1e-3);
    // AM at the wheel rotation rate (20-40 %)
    glide(this.wheel.frequency, Math.max(0.5, v / WHEEL_CIRC), now, 0.1);
    glide(this.amDepth.gain, 0.2 + 0.2 * clamp(0.5 + 0.5 * noise1(sb / 7, this.seed + 3), 0, 1), now, 0.3);
    // flange rubbing in any curve tighter than ~400 m
    glide(this.fg.gain, 0.1 * rub, now, 0.2, 1e-3);
  }

  dispose() {
    this.wheel.stop();
    for (const m of this.modes) { m.osc.stop(); m.osc2.stop(); }
  }
}
