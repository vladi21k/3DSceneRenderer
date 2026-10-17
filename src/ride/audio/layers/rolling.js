// Wheel/rail rolling noise and impacts.
//  - Rolling: a synthesized texture loop whose playback rate follows speed (so
//    roughness, corrugation and wheel out-of-roundness all scale with v), level
//    ~ v^1.5 (30 log v), brightening with speed, rougher over some stretches and
//    through the crossovers. Fixed floor/body resonances are live filters.
//  - Impacts: every axle of the three bogies knocks over each rail joint and
//    turnout part at the right time (look-ahead scheduling on the audio clock),
//    giving the "clack-clack ... clack-clack" whose rate follows speed.
import { noise1 } from '../../../core/rng.js';
import { glide, clamp, smoothstep } from '../dsp.js';
import { ROLL_VREF } from '../synth/rail.js';
import { AXLES, nextFeatureIndex } from '../track.js';

const VMAX = 13.9;        // 50 km/h
const LOOKAHEAD = 0.16;   // s of impacts scheduled ahead of the audio clock

export class RollingLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    this.body = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 420, Q: 1.3, gain: 3.5 });
    this.lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 900, Q: 0.5 });
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 24, Q: 0.7 });
    this.gain = new GainNode(ctx, { gain: 0 });
    this.body.connect(this.lp).connect(this.hp).connect(this.gain).connect(e.bus.rolling);
    this.src = null;

    // impacts: near bogie bright-ish, the far bogies dull and quiet
    this.jNear = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4200, Q: 0.6 });
    this.jFar = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1100, Q: 0.6 });
    this.jNear.connect(e.bus.joints);
    this.jFar.connect(e.bus.joints);
    this.axles = AXLES.map((a) => ({ ...a, next: -1 }));
    this.prevS = null;
  }

  update(dt, st, now) {
    if (!this.src) this.src = this.e.loop('rolling', this.body, { rate: 0.1 });
    const v = st.speed, vn = v / VMAX;
    // rail condition varies along the line; turnouts are rough
    const rough = 1 + 0.2 * noise1(st.s / 41, 5) + 0.1 * noise1(st.s / 9.5, 6);
    const xo = this.e.layout.isInCrossover(st.s - 8, 6) ? 1.45 : 1;
    const g = 0.42 * Math.pow(vn, 1.5) * rough * xo * smoothstep(0.02, 0.7, v);
    glide(this.gain.gain, g, now, 0.08);
    if (this.src) glide(this.src.playbackRate, clamp(v / ROLL_VREF, 0.06, 2.2), now, 0.06);
    glide(this.lp.frequency, 520 + 2000 * clamp(vn, 0, 1.2) ** 1.2, now, 0.1);
    this._impacts(st, now);
  }

  _impacts(st, now) {
    const F = this.e.features, route = this.e.route, v = st.speed;
    if (!F.length) return;
    const jump = this.prevS === null || Math.abs(route.delta(this.prevS, st.s)) > 25;
    this.prevS = st.s;
    for (const ax of this.axles) {
      const sa = route.wrap(st.s - ax.o);
      if (jump || ax.next < 0) { ax.next = nextFeatureIndex(F, sa); continue; }
      for (let guard = 0; guard < 8; guard++) {
        const f = F[ax.next];
        const d = route.delta(sa, f.s); // metres until this axle reaches the feature
        if (d < -1) { ax.next = (ax.next + 1) % F.length; continue; } // rolled over it too slowly to hear
        if (v < 0.3 || d > v * LOOKAHEAD) break;
        this._impact(f, ax, now + Math.max(0, d) / v, v);
        ax.next = (ax.next + 1) % F.length;
      }
    }
  }

  _impact(f, ax, when, v) {
    const e = this.e;
    const vf = Math.pow(clamp(v / 8.3, 0, 1.7), 1.1);
    const dest = ax.far ? this.jFar : this.jNear;
    const jitter = 1 + e.rng.range(-0.03, 0.03);
    if (f.kind === 'check') {
      const buf = e.bank.get('scrape' + (ax.far ? 1 : 0));
      if (buf && v > 1) e.shot(buf, dest, when, 0.35 * f.sev * ax.w * vf, clamp(0.85 + v / 40, 0.85, 1.25));
      return;
    }
    const buf = e.bank.get((f.kind === 'frog' ? 'frog' : 'clack') + f.v);
    if (!buf) return;
    const gain = (f.kind === 'frog' ? 0.42 : 0.24) * f.sev * ax.w * vf;
    // harder hits sound a little brighter
    const rate = (0.92 + 0.1 * clamp(v / VMAX, 0, 1)) * jitter;
    e.shot(buf, dest, when, gain, rate);
  }
}
