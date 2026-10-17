// Curve squeal: in tight curves (|curvature| > 1/150 m^-1, above 8 km/h) the
// wheels stick-slip laterally and an axial wheel mode rings: a narrowband tone in
// the 2-6 kHz range, slowly wandering, often hopping between two modes, coming and
// going in bursts. Intensity follows curvature x speed. A broadband flange-rubbing
// hiss accompanies any noticeable curve. Emitted from the front bogie's outer wheel.
import { noise1, hash2 } from '../../../core/rng.js';
import { TRACK_OFFSET } from '../../../core/config.js';
import { glide, clamp, smoothstep, periodicWave } from '../dsp.js';

const K_MIN = 1 / 150, K_MAX = 1 / 55;
const V_MIN = 8 / 3.6;

export class SquealLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    const wave = periodicWave(ctx, [1, 0.22, 0.07, 0.03]);
    this.out = new GainNode(ctx, { gain: 1 });
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 1200, Q: 0.7 });
    // equal-power: a loud narrowband tone from below would be coloured unpredictably by HRTF notches
    this.panner = e.panner(2, 1, 'equalpower');
    this.out.connect(this.hp).connect(this.panner).connect(e.bus.squeal);

    // two competing wheel modes, each with a slow vibrato LFO at audio rate
    this.modes = [0, 1].map((i) => {
      const osc = new OscillatorNode(ctx, { frequency: 3000 + 900 * i });
      osc.setPeriodicWave(wave);
      const lfo = new OscillatorNode(ctx, { frequency: 4.3 + i * 1.7 });
      const depth = new GainNode(ctx, { gain: 0 });
      lfo.connect(depth).connect(osc.frequency);
      const g = new GainNode(ctx, { gain: 0 });
      osc.connect(g).connect(this.out);
      osc.start(); lfo.start();
      return { osc, lfo, depth, g };
    });
    // rough narrowband noise riding on the tone
    this.nbp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3000, Q: 28 });
    this.ng = new GainNode(ctx, { gain: 0 });
    this.nbp.connect(this.ng).connect(this.out);
    // flange rubbing hiss
    this.fbp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3600, Q: 0.8 });
    this.fg = new GainNode(ctx, { gain: 0 });
    this.fbp.connect(this.fg).connect(this.out);
    this.noise = null;
    this.flange = null;
    this.curve = -1;
    this.f0 = [3000, 4200];
  }

  update(dt, st, now) {
    const e = this.e;
    if (!this.noise) this.noise = e.loop('noiseW', this.nbp);
    if (!this.flange) this.flange = e.loop('noiseP', this.fbp);

    const sb = st.s - 2.2;                       // front bogie
    const k = e.route.curvature(sb), ka = Math.abs(k), v = st.speed;
    // each curve gets its own pair of squeal modes
    const seg = e.route.segmentAt(sb);
    if (seg.index !== this.curve) {
      this.curve = seg.index;
      const h1 = hash2(seg.index, 77) / 4294967296, h2 = hash2(seg.index, 78) / 4294967296;
      this.f0 = [2500 + 2600 * h1, 0];
      this.f0[1] = this.f0[0] * (h2 < 0.5 ? 1.37 + 0.2 * h2 : 0.62 + 0.1 * h2);
      this.seed = seg.index * 13 + 5;
    }
    const excess = clamp((ka - K_MIN) / (K_MAX - K_MIN), 0, 1);
    const vf = smoothstep(V_MIN, V_MIN + 2.5, v) * clamp(v / 7, 0, 1.5);
    const I = ka > K_MIN ? Math.pow(excess, 0.6) * vf : 0;
    // bursts: tied to position on the curve (same spots squeal each lap) plus a slow
    // temporal flutter so long squeals breathe
    const sp = noise1(sb / 3.4, this.seed) + 0.6 * (I - 0.35);
    const gateA = smoothstep(-0.05, 0.3, sp);
    const gateB = smoothstep(0.15, 0.45, noise1(sb / 2.3 + 40, this.seed + 1) + 0.4 * (I - 0.5));
    const t = st.t;
    const flut = 0.7 + 0.3 * noise1(t * 5.5, this.seed + 2);
    const ga = 0.16 * I * gateA * flut;
    const gb = 0.09 * I * gateB * (0.6 + 0.4 * noise1(t * 4.1, this.seed + 3));
    const fA = this.f0[0] * (1 + 0.006 * noise1(t * 0.7, this.seed + 4) + 0.004 * excess);
    const fB = this.f0[1] * (1 + 0.005 * noise1(t * 0.9, this.seed + 5));
    const [A, B] = this.modes;
    glide(A.osc.frequency, fA, now, 0.04);
    glide(B.osc.frequency, fB, now, 0.04);
    glide(A.depth.gain, fA * 0.0022, now, 0.2);
    glide(B.depth.gain, fB * 0.0018, now, 0.2);
    glide(A.g.gain, ga, now, ga > A.g.gain.__last ? 0.05 : 0.12, 1e-3);
    glide(B.g.gain, gb, now, 0.08, 1e-3);
    glide(this.nbp.frequency, fA, now, 0.04);
    glide(this.ng.gain, ga * 1.6, now, 0.08, 1e-3);
    // flange rubbing in any curve tighter than ~400 m
    const rub = clamp((ka - 1 / 400) / (1 / 60), 0, 1) * clamp(v / 9, 0, 1.4);
    glide(this.fg.gain, 0.1 * rub, now, 0.2, 1e-3);

    // outer wheel of the front bogie
    const side = k > 0 ? 1 : -1;
    const p = e.at(sb, TRACK_OFFSET + side * 0.72, 0.4);
    e.setPos(this.panner, p.x, p.y, p.z, now);
  }

  dispose() { for (const m of this.modes) { m.osc.stop(); m.lfo.stop(); } }
}
