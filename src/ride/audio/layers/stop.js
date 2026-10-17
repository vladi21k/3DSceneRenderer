// Stopping and doors.
//  - Friction-brake squeal in the last few km/h (tonal, gliding down, intermittent),
//    the stick-slip creak and settle clunk right at standstill, the holding brake's
//    air exhaust after stopping and a short release "pfft" when moving off.
//  - Doors (event 'doors'): open = chime + door drive; close = warning beeps then
//    the drive and the bolt. The first door is just behind the cab on the right.
import { noise1 } from '../../../core/rng.js';
import { TRACK_OFFSET } from '../../../core/config.js';
import { glide, smoothstep, periodicWave } from '../dsp.js';

export class StopLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    // brake squeal voice
    this.sq = new OscillatorNode(ctx, { frequency: 1900 });
    this.sq.setPeriodicWave(periodicWave(ctx, [1, 0.12, 0.3, 0.05]));
    this.sqG = new GainNode(ctx, { gain: 0 });
    this.sqHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 800, Q: 0.7 });
    this.sq.connect(this.sqG).connect(this.sqHp).connect(e.bus.brakes);
    this.sq.start();
    this.under = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 9000, Q: 0.5 });
    this.under.connect(e.bus.brakes);

    // doors and chime are spatialised inside / beside the car body
    this.doorP = e.panner(1.5, 1);
    this.doorP.connect(e.bus.doors);
    this.chimeP = e.panner(1.2, 1);
    this.chimeP.connect(e.bus.doors);

    this.moving = false;
    this.creaked = false;
    this.released = true;
    this.stops = 0;
    this.fS = 1900;
  }

  update(dt, st, now) {
    const e = this.e, v = st.speed;
    const braking = st.throttle < -0.05 || st.accel < -0.25 || st.state === 'brake';

    // ---- squeal in the last few km/h
    const I = braking && v > 0.1 && v < 3.6 ? smoothstep(3.6, 1.0, v) : 0;
    const gate = smoothstep(-0.15, 0.3, noise1(st.t * 0.8, 17 + this.stops));
    const fl = 0.7 + 0.3 * noise1(st.t * 7, 3);
    glide(this.sqG.gain, 0.035 * I * gate * fl, now, 0.06, 1e-3);
    glide(this.sq.frequency, this.fS * (1 - 0.04 * smoothstep(3.6, 0, v)), now, 0.08);

    // ---- creak timed to end at standstill
    if (braking && !this.creaked && v > 0.05 && v < 1.0) {
      const tts = v / Math.max(0.3, -st.accel);
      if (tts < 1.05) {
        e.shot('creak' + (this.stops % 2), this.under, now + Math.max(0, tts - 1.0), 0.4);
        this.creaked = true;
      }
    }
    // ---- standstill / moving off
    if (this.moving && v < 0.02) {
      this.moving = false;
      this.released = false;
      e.shot('hissStop' + (this.stops % 2), this.under, now + 0.45, 0.32);
      this.stops++;
      this.fS = 1650 + 600 * ((this.stops * 0.618) % 1);
    } else if (!this.moving && v > 0.06) {
      this.moving = true;
      this.creaked = false;
      if (!this.released) e.shot('hissRelease' + (this.stops % 2), this.under, now, 0.22);
      this.released = true;
    }
    if (!this.moving && !this.released && st.throttle > 0.05) {
      e.shot('hissRelease' + (this.stops % 2), this.under, now, 0.22);
      this.released = true;
    }

    const pd = e.at(st.s - 4.2, TRACK_OFFSET + 1.3, 1.1);
    e.setPos(this.doorP, pd.x, pd.y, pd.z, now);
    const pc = e.at(st.s - 2.0, TRACK_OFFSET, 2.3);
    e.setPos(this.chimeP, pc.x, pc.y, pc.z, now);
  }

  doors(open, when) {
    const e = this.e;
    if (open) {
      e.shot('chime', this.chimeP, when, 0.3);
      e.shot('doorOpen', this.doorP, when + 0.35, 0.5);
      e.doorsOpen = true;
    } else {
      for (let i = 0; i < 6; i++) e.shot('beep', this.chimeP, when + i * 0.3, 0.28);
      e.shot('doorClose', this.doorP, when + 1.9, 0.5);
      e.doorsOpen = false;
    }
  }

  dispose() { this.sq.stop(); }
}
