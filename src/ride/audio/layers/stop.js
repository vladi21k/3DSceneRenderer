// Stopping and doors.
//  - Friction-brake squeal in the last few km/h: two or three inharmonic pad / disc
//    modes (f, 1.47 f, 2.31 f) that switch on and off abruptly and independently,
//    pitch-stable with small random jitter (no glide). Below ~1.4 m/s the stick-slip
//    groan takes over, slowing into the creak and the settle clunk right at standstill
//    (one buffer, timed to end at the stop), then the holding brake's air exhaust;
//    a short release "pfft" when moving off.
//  - Doors (event 'doors'): open = chime + door drives; close = warning beeps, then
//    the drives and the bolts. Four doors along the right side, from just behind the
//    cab backwards, each a little later and quieter. Heard inside the car body (the
//    doors bus feeds the cab / saloon reverb, not the street).
import { noise1 } from '../../../core/rng.js';
import { glide, smoothstep, clamp } from '../dsp.js';
import { CREAK_LEAD } from '../synth/rail.js';

const RATIOS = [1, 1.47, 2.31];
const LEVELS = [0.035, 0.018, 0.009];
const DOORS = [[4.2, 0, 1], [10.5, 0.045, 0.5], [18.2, 0.08, 0.32], [26.0, 0.115, 0.2]]; // [m behind, delay s, gain]

export class StopLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    // brake squeal modes (under the floor)
    this.sqOut = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 800, Q: 0.7 });
    this.sqOut.connect(e.bus.brakes);
    const jit = e.drift(9);
    this.modes = RATIOS.map((r, i) => {
      const osc = new OscillatorNode(ctx, { frequency: 1900 * r });
      const g = new GainNode(ctx, { gain: 0 });
      const jd = new GainNode(ctx, { gain: 1900 * r * 0.0012 });
      jit.connect(jd).connect(osc.frequency);
      osc.connect(g).connect(this.sqOut);
      osc.start();
      return { osc, g, jd, on: false, r, i };
    });
    this.under = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000, Q: 0.5 });
    this.under.connect(e.bus.brakes);

    // doors (right side, behind the cab) and the saloon chime speaker
    this.doorP = DOORS.map(([z], i) => e.vehiclePanner(1.3, 1.1, z, 1.5, i ? 'equalpower' : 'HRTF'));
    for (const p of this.doorP) p.connect(e.bus.doors);
    this.chimeP = e.vehiclePanner(0, 2.3, 2.0, 1.2);
    this.chimeP.connect(e.bus.doors);

    this.moving = false;
    this.creaked = false;
    this.released = true;
    this.stops = 0;
    this.fS = 1900;
    this.squealing = false;
  }

  update(dt, st, now) {
    const e = this.e, v = st.speed;
    const braking = st.throttle < -0.05 || st.accel < -0.25 || st.state === 'brake';

    // ---- squeal in the last few km/h, handing over to the groan below ~1.4 m/s
    const I = braking && v > 0.1 ? smoothstep(3.6, 2.4, v) * smoothstep(0.8, 1.4, v) : 0;
    if (I > 0 || this.squealing) {
      this.squealing = I > 0;
      for (const m of this.modes) {
        const sp = noise1(st.t * (1.1 + 0.4 * m.i), 17 + this.stops * 5 + m.i);
        const on = I > 0 && (m.on ? sp > -0.1 : sp > 0.15 + 0.15 * m.i);
        const level = LEVELS[m.i] * I;
        if (on || m.on) glide(m.osc.frequency, this.fS * m.r * (1 + 0.003 * noise1(st.t * 0.4, 40 + m.i)), now, 0.05);
        if (on && !m.on) { m.g.gain.cancelScheduledValues(now); m.g.gain.setTargetAtTime(level, now, 0.004); m.g.gain.__last = level; }
        else if (!on && m.on) { m.g.gain.cancelScheduledValues(now); m.g.gain.setTargetAtTime(0, now, 0.025); m.g.gain.__last = 0; }
        else if (on) glide(m.g.gain, level, now, 0.06, 1e-3);
        m.on = on;
      }
    }

    // ---- stick-slip groan -> creak -> clunk, timed to end at standstill
    if (braking && !this.creaked && v > 0.05 && v < 2.5) {
      const tts = v / Math.max(0.3, -st.accel);
      if (tts < CREAK_LEAD + 0.05) {
        e.shot('creak' + (this.stops % 2), this.under, now + Math.max(0, tts - CREAK_LEAD), 0.2);
        this.creaked = true;
      }
    }
    // ---- standstill / moving off
    if (this.moving && v < 0.02) {
      this.moving = false;
      this.released = false;
      e.shot('hissStop' + (this.stops % 2), this.under, now + 0.45, 0.17);
      this.stops++;
      this.fS = 1650 + 600 * ((this.stops * 0.618) % 1);
    } else if (!this.moving && v > 0.06) {
      this.moving = true;
      this.creaked = false;
      if (!this.released) e.shot('hissRelease' + (this.stops % 2), this.under, now, 0.13);
      this.released = true;
    }
    if (!this.moving && !this.released && st.throttle > 0.05) {
      e.shot('hissRelease' + (this.stops % 2), this.under, now, 0.13);
      this.released = true;
    }
  }

  doors(open, when) {
    const e = this.e;
    const each = (name, t0) => DOORS.forEach(([, delay, g], i) => {
      e.shot(name, this.doorP[i], t0 + delay * (0.7 + 0.6 * e.rng.next()), 0.5 * g, 1 + clamp(e.rng.range(-0.03, 0.03), -0.03, 0.03));
    });
    if (open) {
      e.shot('chime', this.chimeP, when, 0.3);
      each('doorOpen', when + 0.35);
      e.doorsOpen = true;
    } else {
      for (let i = 0; i < 6; i++) e.shot('beep', this.chimeP, when + i * 0.3, 0.28);
      each('doorClose', when + 1.9);
      e.doorsOpen = false;
    }
  }

  dispose() { for (const m of this.modes) m.osc.stop(); }
}
