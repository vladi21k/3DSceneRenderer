// Wheel/rail rolling noise and impacts.
//  - Rolling: synthesized live from non-repeating noise (worklet), so no stretch of
//    the ride ever sounds like another. Components, all excited by the rolling speed:
//    structure-borne rumble (axle box -> bogie -> floor) modulated once and twice per
//    wheel revolution (out-of-roundness), the airborne rolling roar with a slow random
//    swell (rail roughness changes), quasi-tonal corrugation bands at v / lambda, and
//    grit in the groove as randomly timed crackle grains. Excitation bands move up
//    with speed; the cab body and floor resonances are fixed filters afterwards.
//    Level ~ v^1.5 (30 log v), rougher over some stretches and through crossovers.
//  - Impacts: every axle of the three bogies passes each weld, joint and turnout part
//    at the right time (look-ahead scheduling on the audio clock). Welds give only a
//    faint thump; the rare insulated / dipped joint knocks; the turnouts clatter.
import { noise1 } from '../../../core/rng.js';
import { glide, clamp, smoothstep } from '../dsp.js';
import { WHEEL_CIRC } from '../synth/rail.js';
import { AXLES, nextFeatureIndex } from '../track.js';

const VMAX = 13.9;        // 50 km/h
const VREF = 10;          // m/s at which the excitation frequencies below are given
const LOOKAHEAD = 0.16;   // s of impacts scheduled ahead of the audio clock
const GRIT_RATE = 26;     // crackle grains per second at VREF

export class RollingLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    // fixed cab response
    this.body = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 420, Q: 1.3, gain: 3.5 });
    this.floor = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 140, gain: 5 });
    this.lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 900, Q: 0.6 });
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 24, Q: 0.7 });
    this.gain = new GainNode(ctx, { gain: 0 });
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.merge.connect(this.body).connect(this.floor).connect(this.lp).connect(this.hp).connect(this.gain).connect(e.bus.rolling);
    const both = (node) => { node.connect(this.merge, 0, 0); node.connect(this.merge, 0, 1); };

    // wheel out-of-roundness: once and twice per revolution
    this.wheel = new OscillatorNode(ctx, { frequency: 1 });
    this.wheel.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0]), new Float32Array([0, 0.13, 0.05]), { disableNormalization: true }));
    this.wheel.start();

    // structure-borne rumble (mono, both ears)
    this.sbLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 190, Q: 0.9 });
    this.sbHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 28, Q: 0.7 });
    this.sbMod = new GainNode(ctx, { gain: 1 });
    this.sbG = new GainNode(ctx, { gain: 0.33 });
    e.noise().connect(this.sbLp).connect(this.sbHp).connect(this.sbMod).connect(this.sbG);
    this.wheel.connect(this.sbMod.gain);
    both(this.sbG);

    // airborne roar: decorrelated left / right ears, slow random swell
    this.abMerge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.drift = new GainNode(ctx, { gain: 1 });
    const dr = e.drift(2.5), drDepth = new GainNode(ctx, { gain: 0.18 });
    dr.connect(drDepth).connect(this.drift.gain);
    this.ab = [0, 1].map((ch) => {
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 620, Q: 0.55 });
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2400, Q: 0.7 });
      const g = new GainNode(ctx, { gain: 0.11 });
      e.noise().connect(bp).connect(lp).connect(g).connect(this.abMerge, 0, ch);
      return { bp, lp, g };
    });
    this.abMerge.connect(this.drift).connect(this.body);

    // corrugation: narrow bands at v / 45 mm and its second harmonic
    this.cor = [[222, 10, 0.03], [445, 11, 0.016]].map(([f, Q, g0]) => {
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: f, Q });
      const g = new GainNode(ctx, { gain: g0 });
      e.noise().connect(bp).connect(g).connect(this.sbMod);
      return { bp, f, g };
    });

    // groove grit grains (mono)
    this.gritBus = new GainNode(ctx, { gain: 1 });
    both(this.gritBus);
    this.gritT = 0;

    // impacts: near bogie bright-ish, the far bogies dull and quiet
    this.jNear = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4200, Q: 0.6 });
    this.jFar = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1100, Q: 0.6 });
    this.jNear.connect(e.bus.joints);
    this.jFar.connect(e.bus.joints);
    this.axles = AXLES.map((a) => ({ ...a, next: -1 }));
    this.prevS = null;
    this.idle = false;
  }

  update(dt, st, now) {
    const e = this.e, v = st.speed, vn = v / VMAX;
    // rail condition varies along the line; turnouts are rough
    const rough = 1 + 0.2 * noise1(st.s / 41, 5) + 0.1 * noise1(st.s / 9.5, 6);
    const xo = e.layout.isInCrossover(st.s - 8, 6) ? 1.45 : 1;
    const g = 1.95 * Math.pow(vn, 1.5) * rough * xo * smoothstep(0.02, 0.7, v);
    glide(this.gain.gain, g, now, 0.08, 1e-3);
    if (g < 1e-4 && this.idle) { this._impacts(st, now); return; }
    this.idle = g < 1e-4;

    // excitation moves up with speed (roughness wavelengths -> frequencies)
    const k = clamp(v / VREF, 0.12, 2.2), kb = Math.pow(k, 0.75);
    glide(this.wheel.frequency, Math.max(0.05, v / WHEEL_CIRC), now, 0.05);
    glide(this.sbLp.frequency, 190 * kb, now, 0.1);
    for (const a of this.ab) {
      glide(a.bp.frequency, 620 * kb, now, 0.1);
      glide(a.lp.frequency, 2400 * kb, now, 0.1);
    }
    for (const c of this.cor) glide(c.bp.frequency, c.f * k, now, 0.06);
    glide(this.lp.frequency, 450 + 1100 * clamp(vn, 0, 1.2) ** 1.2, now, 0.1);

    // grit: Poisson grains, rate ~ speed (scheduled a frame ahead)
    if (dt > 0 && v > 0.5) {
      const rate = GRIT_RATE * (v / VREF) * rough;
      const grains = e.bank.variants('grit');
      if (grains.length) {
        let t = this.gritT > now ? this.gritT : now + 0.02;
        const horizon = now + dt + 0.05;
        while (t < horizon) {
          const a = e.rng.range(0.2, 1);
          e.shot(e.rng.pick(grains), this.gritBus, t, 0.09 * a * a, 0.9 + e.rng.range(0, 0.25));
          t += -Math.log(1 - e.rng.next() * 0.999) / rate;
        }
        this.gritT = t;
      }
    }
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
    if (f.kind === 'joint' && f.sev < 0.25) {
      // a weld: only a low thump through the floor
      const buf = e.bank.get('thump' + (f.v % 4));
      if (buf) e.shot(buf, this.jNear, when, 0.9 * f.sev * ax.w * vf, jitter);
      return;
    }
    const buf = e.bank.get((f.kind === 'frog' ? 'frog' : 'clack') + f.v);
    if (!buf) return;
    // turnout parts clatter; a plain-line insulated / dipped joint is a duller knock
    const gain = (f.kind === 'frog' ? 0.42 : f.xo ? 0.24 : 0.1) * f.sev * ax.w * vf;
    // harder hits sound a little brighter
    const rate = (0.92 + 0.1 * clamp(v / VMAX, 0, 1)) * jitter;
    e.shot(buf, dest, when, gain, rate);
    // a hard knock under the cab sets some fitting rattling
    if (!ax.far && f.xo && f.sev * vf > 0.45 && e.rng.chance(0.4)) {
      const r = e.bank.variants('rattle');
      if (r.length) e.shot(e.rng.pick(r), this.jNear, when + 0.004, 0.05 * f.sev * vf, 1 + e.rng.range(-0.05, 0.05));
    }
  }

  dispose() { this.wheel.stop(); }
}
