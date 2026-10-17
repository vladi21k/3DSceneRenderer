// Traction and auxiliaries.
//  - Inverter (VVVF) whine under power or electric braking: asynchronous PWM with a
//    stepped fixed carrier at low speed, then synchronous modes whose carrier is a
//    multiple of the motor frequency (pitch rises with speed, then drops a step when
//    the pulse number changes). Sidebands at fc +- 2 fe from amplitude modulation.
//    Fades out when coasting.
//  - Motor magnetic noise (harmonics of the stator frequency) and gear mesh whine.
//  - Auxiliaries, always running: HVAC / cooling fans with blade tone, the static
//    converter's faint whistle and hum, and the compressor cycling while stopped.
import { noise1 } from '../../../core/rng.js';
import { glide, clamp, smoothstep, periodicWave } from '../dsp.js';

const FE_PER_MS = 6.0;     // stator frequency (Hz) per m/s: 660 mm wheels, 6.2:1 gearing, 4 poles
const GEAR_TEETH = 19;     // pinion teeth -> mesh frequency = teeth x motor rev/s
const VMAX = 13.9;

// asynchronous steps: [fe from, fe to, carrier Hz]
const ASYNC = [[0, 7.5, 740], [7.5, 14, 830], [14, 21, 990], [21, 29, 1110]];
// synchronous modes: [fe from, fe to, pulses per period]
const SYNC = [[29, 41, 33], [41, 55, 21], [55, 70, 15], [70, 1e9, 9]];

function carrier(fe) {
  for (let i = 0; i < ASYNC.length; i++) if (fe < ASYNC[i][1]) return [i, ASYNC[i][2]];
  for (let i = 0; i < SYNC.length; i++) if (fe < SYNC[i][1]) return [ASYNC.length + i, SYNC[i][2] * fe];
  return [9, 9 * fe];
}

export class TractionLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    const bus = e.bus.traction;

    // ---- inverter carrier + sidebands
    this.invOut = new GainNode(ctx, { gain: 0 });
    this.invHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 200, Q: 0.7 });
    this.invLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6500, Q: 0.6 });
    this.invOut.connect(this.invHp).connect(this.invLp).connect(bus);
    this.car = new OscillatorNode(ctx, { frequency: 740 });
    this.car2 = new OscillatorNode(ctx, { frequency: 1480 });
    this.am = new GainNode(ctx, { gain: 0.7 });
    this.am2 = new GainNode(ctx, { gain: 0.18 });
    this.mod = new OscillatorNode(ctx, { frequency: 1 });
    this.modDepth = new GainNode(ctx, { gain: 0.45 });
    this.modDepth2 = new GainNode(ctx, { gain: 0.12 });
    this.mod.connect(this.modDepth).connect(this.am.gain);
    this.mod.connect(this.modDepth2).connect(this.am2.gain);
    this.car.connect(this.am).connect(this.invOut);
    this.car2.connect(this.am2).connect(this.invOut);

    // ---- motor magnetic noise and gear whine
    this.mag = new OscillatorNode(ctx, { frequency: 1 });
    this.mag.setPeriodicWave(periodicWave(ctx, [0, 0.25, 0, 0.15, 0, 0.5, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0.12, 0, 0, 0, 0, 0, 0.06]));
    this.magG = new GainNode(ctx, { gain: 0 });
    this.gear = new OscillatorNode(ctx, { frequency: 1 });
    this.gear.setPeriodicWave(periodicWave(ctx, [1, 0.32, 0.1]));
    this.gearG = new GainNode(ctx, { gain: 0 });
    this.mechLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3200, Q: 0.6 });
    this.mag.connect(this.magG).connect(this.mechLp);
    this.gear.connect(this.gearG).connect(this.mechLp);
    this.mechLp.connect(bus);
    for (const o of [this.car, this.car2, this.mod, this.mag, this.gear]) o.start();

    // ---- auxiliaries
    const aux = e.bus.aux;
    this.fanG = new GainNode(ctx, { gain: 0 });
    this.fanLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2800, Q: 0.5 });
    this.fanG.connect(this.fanLp).connect(aux);
    this.fan = null;
    this.conv = new OscillatorNode(ctx, { frequency: 4270 });
    this.convG = new GainNode(ctx, { gain: 0.0016 });
    this.hum = new OscillatorNode(ctx, { frequency: 100 });
    this.hum.setPeriodicWave(periodicWave(ctx, [1, 0.5, 0.3, 0.1]));
    this.humG = new GainNode(ctx, { gain: 0.006 });
    this.conv.connect(this.convG).connect(aux);
    this.hum.connect(this.humG).connect(aux);
    this.conv.start(); this.hum.start();
    this.compG = new GainNode(ctx, { gain: 0 });
    this.compLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1800, Q: 0.6 });
    this.compG.connect(this.compLp).connect(aux);
    this.comp = null;
    this.compOn = false;

    this.effort = 0;
    this.mode = -1;
    this.stillT = 0;
  }

  update(dt, st, now) {
    const e = this.e;
    const v = st.speed, fe = FE_PER_MS * v;
    // tractive / electric-braking effort, smoothed (fast up, slower down)
    let target = Math.abs(st.throttle);
    if (st.throttle < 0) target *= smoothstep(0.8, 2.2, v); // friction brakes take over at the end
    if (v < 0.05 && st.throttle <= 0) target = 0;
    const k = target > this.effort ? 1 - Math.exp(-dt / 0.12) : 1 - Math.exp(-dt / 0.4);
    this.effort += (target - this.effort) * (dt > 0 ? k : 0);
    const eff = this.effort;

    // ---- inverter
    const [mode, fc] = carrier(fe);
    const step = mode !== this.mode;
    this.mode = mode;
    const tc = step ? 0.006 : 0.03;
    glide(this.car.frequency, fc, now, tc);
    glide(this.car2.frequency, fc * 2, now, tc);
    glide(this.mod.frequency, Math.max(0.4, 2 * fe), now, 0.03);
    const load = 0.55 + 0.45 * clamp(Math.abs(st.accel) / 1.2, 0, 1);
    const inv = 0.05 * eff * load * (0.65 + 0.35 * smoothstep(0, 5, v));
    glide(this.invOut.gain, inv, now, 0.05, 1e-3);

    // ---- motor + gears
    glide(this.mag.frequency, Math.max(0.5, fe * 1.02), now, 0.03);
    glide(this.magG.gain, 0.05 * eff * smoothstep(0.5, 12, fe), now, 0.06, 1e-3);
    const fg = GEAR_TEETH * (fe / 2);
    glide(this.gear.frequency, Math.max(1, fg), now, 0.03);
    glide(this.gearG.gain, 0.022 * Math.pow(clamp(v / VMAX, 0, 1.2), 1.2) * (0.4 + 0.6 * eff) * smoothstep(0.2, 1.5, v), now, 0.08, 1e-3);

    // ---- auxiliaries
    if (!this.fan) this.fan = e.loop('fan', this.fanG);
    // HVAC switches between two fan speeds every minute or so
    const fanSpeed = noise1(st.t / 70, 31) > 0.1 ? 1 : 0.72;
    glide(this.fanG.gain, 0.05 * fanSpeed, now, 1.5, 1e-3);
    if (this.fan) glide(this.fan.playbackRate, 0.9 + 0.1 * fanSpeed, now, 1.5);

    // compressor: cuts in for ~15 s at a time while the tram stands
    this.stillT = v < 0.05 ? this.stillT + dt : 0;
    const cycle = (st.t + 23) % 64;
    const want = this.stillT > 2.5 && cycle < 16;
    if (want && !this.comp) this.comp = e.loop('compressor', this.compG, { offset: 0, rate: 0.6 });
    if (this.comp && want !== this.compOn) {
      this.compOn = want;
      this.comp.playbackRate.cancelScheduledValues(now);
      this.comp.playbackRate.setTargetAtTime(want ? 1 : 0.6, now, want ? 0.35 : 0.5);
      this.compG.gain.cancelScheduledValues(now);
      this.compG.gain.setTargetAtTime(want ? 0.05 : 0, now, want ? 0.25 : 0.4);
    }
  }

  dispose() { for (const o of [this.car, this.car2, this.mod, this.mag, this.gear, this.conv, this.hum]) o.stop(); }
}
