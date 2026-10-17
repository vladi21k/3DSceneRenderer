import {
  RIDE_D, BAND, BAND_LO, BAND_HI, TRAM_LEN, NO_GO_AHEAD, BRAKE_DECEL, SWEPT_HALF, SWEPT_AHEAD, AGENT_R, HURRY,
} from './constants.js';
import { KIND, ST } from './agent.js';

// Tram awareness. People keep out of the ride track's clearance band
// (|d − RIDE_D| < BAND) wherever the tram is close: from the end of its body up to
// `clearAhead` in front of the cab, which grows with speed. Inside that zone nobody
// may step into the band, people already in it hurry to the nearer safe side, and a
// final projection guarantees the cab's swept volume stays empty. Pedestrians close
// to the track inside the stopping distance ask the driver for the bell.

const REQ_HALF = 1.6;   // people this close to the ride track centre ask for the bell

export class TramWatch {
  constructor(crowd) {
    this.c = crowd;
    this.v = 0;               // tram speed (m/s, ≥ 0)
    this.trainU = 0;          // cab front, unwrapped crowd frame
    this.clearAhead = 20;
    this.stopDist = 0;
    this.reqReach = 12;
    this.stoppedAt = null;    // station the tram is standing at
    this.bellAt = -1e9;       // last bell heard
    this.reqUrgency = 0;
    this.lastReqT = -1e9;
    this.lastReqU = 0;
    this.stats = { violations: 0, rescues: 0, blocked: 0, bellRequests: 0, bells: 0, maxUrgency: 0 };
    this.violationLog = [];
    this.reqLog = [];
    this.rescueLog = [];
    this.reqWho = null; this.reqAhead = 0; this.reqDl = 0;
  }

  update(app, trainU) {
    const tr = app.train || {};
    this.trainU = trainU;
    this.v = Math.max(0, tr.speed || 0);
    const v = this.v;
    this.stopDist = (v * v) / (2 * BRAKE_DECEL) + v * 0.8;
    this.reqReach = this.stopDist * 1.3 + 12;
    // people start stepping off the track a couple of seconds before the driver would want the bell
    this.clearAhead = Math.max(NO_GO_AHEAD + 6, this.reqReach + v * 2 + 6);
    // standing at a platform?
    this.stoppedAt = null;
    if (v < 0.15 || tr.state === 'dwell') {
      for (const st of app.layout.stations) {
        if (Math.abs(app.route.delta(st.stopS, tr.s ?? 0)) < 9) { this.stoppedAt = st; break; }
      }
    }
    this.reqUrgency = 0;
  }

  /** Is the clearance band at `ahead` metres in front of the cab currently closed to pedestrians? */
  zone(ahead, front = 0) { return ahead > -(TRAM_LEN + 2) && ahead < this.clearAhead + front; }

  /** How far ahead of the cab this person starts getting off the track. A few are absorbed in
   *  their phone and react late (the driver then rings); the bell makes everyone move. */
  frontFor(a) {
    if (a.bellT > this.c.time) return this.clearAhead * 1.6 + 4;
    if (a.dreamy) return Math.max(this.v * 3.2 + 12, this.reqReach * 0.55);
    return this.clearAhead + 4;
  }

  /** May someone start crossing the band at s now, needing about tCross seconds to get through? */
  canEnterBand(s, tCross) {
    const ahead = s - this.trainU;
    if (ahead < -(TRAM_LEN + 3)) return true;
    if (ahead < NO_GO_AHEAD + 2) return false;
    return ahead > this.clearAhead + this.v * tCross * 0.6 + 4;
  }

  /** Before steering: flag agents that must leave the band and pick the side they go to. */
  preStep(a) {
    if (a.kind === KIND.SEATED) { a.clearing = false; return; }
    const dl = a.d - RIDE_D;
    const ahead = a.s - this.trainU;
    // bell request: someone on or right by the track within the stopping distance
    if (ahead > 2 && this.v > 0.5 && Math.abs(dl) < REQ_HALF) {
      const reach = this.reqReach;
      if (ahead < reach) {
        const inGauge = Math.abs(dl) < 0.9 ? 1 : 0.65;
        const u = Math.min(1, (1 - ahead / reach) * 1.25) * inGauge;
        if (u > this.reqUrgency) { this.reqUrgency = u; this.reqWho = a; this.reqAhead = ahead; this.reqDl = dl; }
      }
    }
    const front = this.frontFor(a);
    if (Math.abs(dl) >= BAND + 0.02 || ahead < -(TRAM_LEN + 7) || ahead > front) { a.clearing = false; return; }
    if (!a.clearing) {
      a.clearing = true;
      const toHi = BAND_HI - a.d, toLo = a.d - BAND_LO;
      let hi = toHi <= toLo;
      // keep going towards the destination when there is time for it
      const tta = ahead > 0 && this.v > 0.2 ? ahead / this.v : 1e9;
      const going = a.state === ST.GOTO;
      if (going && a.gd > RIDE_D + 1 && toHi / HURRY < tta - 2) hi = true;
      else if (going && a.gd < RIDE_D - 1 && toLo / HURRY < tta - 2) hi = false;
      // beside a platform the safe place is between the tracks (passengers are on the platform anyway)
      if (hi && a.kind !== KIND.PASSENGER && (this.c.map.stationAt(a.s) || this.c.map.stationAt(a.s + 6))) hi = false;
      // step well clear when there is time, just clear when there is not
      const spare = ahead > 0 && this.v > 0.2 ? Math.min(1, Math.max(0, (ahead / this.v - 3) / 4)) : 1;
      a.clearTo = hi ? BAND_HI + 0.06 + 0.25 * spare : BAND_LO - 0.06 - 0.45 * spare;
    }
  }

  /** Lateral speed needed to get out of the band in time. */
  clearSpeed(a) {
    const ahead = a.s - this.trainU;
    const dist = Math.abs(a.clearTo - a.d);
    const tta = ahead > 0 && this.v > 0.2 ? ahead / this.v : 6;
    const need = dist / Math.max(0.6, tta - 1.5);
    return Math.min(HURRY * 1.2, Math.max(a.v0 * 0.95, need));
  }

  /** After integration: never let anyone into the band inside the zone; hard guarantee for the swept volume. */
  constrain(a, prevD) {
    const dl = a.d - RIDE_D;
    if (Math.abs(dl) >= BAND) return;
    const ahead = a.s - this.trainU;
    if (ahead < -(TRAM_LEN + 2) || ahead > this.frontFor(a) - 4) return;
    if (Math.abs(prevD - RIDE_D) >= BAND - 1e-4) {
      // was outside: block the step into the band
      a.d = prevD; a.vd = 0;
      this.stats.blocked++;
      return;
    }
    if (ahead > -(TRAM_LEN + 1) && ahead < SWEPT_AHEAD + 0.6) {
      // emergency: should never happen if the behaviour above works. Count and project out.
      if (ahead > -AGENT_R && ahead < SWEPT_AHEAD + AGENT_R && Math.abs(dl) < SWEPT_HALF + AGENT_R) this._violation(a, ahead, dl);
      this.stats.rescues++;
      if (this.rescueLog.length < 12) this.rescueLog.push({ t: +this.c.time.toFixed(1), ahead: +ahead.toFixed(1), dl: +dl.toFixed(2), pd: +(prevD - RIDE_D).toFixed(2), st: a.state, task: a.task, step: a.step, kind: a.kind, clr: a.clearing, lead: !!a.leader });
      a.d = dl >= 0 && !this.c.map.stationAt(a.s) ? BAND_HI + 0.01 : BAND_LO - 0.01;
      if (a.kind === KIND.PASSENGER && dl >= 0) a.d = BAND_HI + 0.01;
      a.vd = 0;
    }
  }

  _violation(a, ahead, dl) {
    this.stats.violations++;
    if (this.violationLog.length < 20) {
      this.violationLog.push({ t: +this.c.time.toFixed(2), slot: a.slot, ahead: +ahead.toFixed(2), dl: +dl.toFixed(2), state: a.state, task: a.task, kind: a.kind, v: +this.v.toFixed(2) });
      console.warn('[crowd] swept-volume violation', JSON.stringify(this.violationLog[this.violationLog.length - 1]));
    }
  }

  /** Emit at most one bell request every couple of seconds (sooner when it gets more urgent). */
  flushRequests(app, time) {
    const u = this.reqUrgency;
    if (u > this.stats.maxUrgency) this.stats.maxUrgency = u;
    if (u < 0.2) return;
    if (time - this.lastReqT > 2.5 || u > this.lastReqU + 0.3) {
      this.lastReqT = time; this.lastReqU = u;
      this.stats.bellRequests++;
      const w = this.reqWho;
      if (this.reqLog.length < 12 && w) this.reqLog.push({ t: +time.toFixed(1), u: +u.toFixed(2), ahead: +this.reqAhead.toFixed(1), dl: +this.reqDl.toFixed(2), st: w.state, task: w.task, step: w.step, kind: w.kind, clr: w.clearing, lane: w.lane, lead: !!w.leader });
      app.events.emit('bell-request', { urgency: +u.toFixed(2) });
    } else if (time - this.lastReqT > 1) this.lastReqU = Math.min(this.lastReqU, u);
  }

  onBell(time) { this.bellAt = time; this.stats.bells++; }
}
