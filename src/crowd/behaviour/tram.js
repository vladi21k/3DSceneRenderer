import {
  RIDE_D, BAND, BAND_LO, BAND_HI, TRAM_LEN, NO_GO_AHEAD, BRAKE_DECEL, SWEPT_HALF, SWEPT_AHEAD, AGENT_R, HURRY,
  PASS_BASE, PASS_PER_V, CLEAR_T,
} from './constants.js';
import { KIND, ST, TASK } from './agent.js';

// Tram awareness. Everybody judges the tram by time: a person on (or about to step onto)
// the ride track leaves its clearance band (|d − RIDE_D| < BAND) when the tram is their
// own `clearT` seconds away (3.5–6 s, absorbed people 2–3 s), so people step off at
// varied distances and the track ahead is used until then. Nobody steps into the band
// inside that zone, people keep a comfortable distance from the passing tram and take a
// small sidestep when it goes by, and a final projection guarantees the cab's swept
// volume stays empty. A few people only notice the tram when it rings: they ask the
// driver for the bell shortly before they would have to move.

const REQ_HALF = 1.6;   // people this close to the ride track centre may ask for the bell

export class TramWatch {
  constructor(crowd) {
    this.c = crowd;
    this.v = 0;               // tram speed (m/s, ≥ 0)
    this.trainU = 0;          // cab front, unwrapped crowd frame
    this.clearAhead = 20;     // reach of the zone for the most cautious people (statistics)
    this.stopDist = 0;
    this.passD = PASS_BASE;   // comfortable centre distance from the ride track while the tram is near
    this.stoppedAt = null;    // station the tram is standing at
    this.bellAt = -1e9;       // last bell heard
    this.reqUrgency = 0;
    this.lastReqT = -1e9;
    this.lastReqU = 0;
    this.stats = { violations: 0, rescues: 0, blocked: 0, bellRequests: 0, bells: 0, maxUrgency: 0, sidesteps: 0 };
    this.violationLog = [];
    this.reqLog = [];
    this.rescueLog = [];
    this.blockLog = [];
    this.reqWho = null; this.reqAhead = 0; this.reqDl = 0;
  }

  update(app, trainU) {
    const tr = app.train || {};
    this.trainU = trainU;
    this.v = Math.max(0, tr.speed || 0);
    const v = this.v;
    this.stopDist = (v * v) / (2 * BRAKE_DECEL) + v * 0.8;
    this.passD = PASS_BASE + PASS_PER_V * v;
    this.clearAhead = Math.max(SWEPT_AHEAD + 6, v * CLEAR_T[1] + 4);
    // standing at a platform?
    this.stoppedAt = null;
    if (v < 0.15 || tr.state === 'dwell') {
      for (const st of app.layout.stations) {
        if (Math.abs(app.route.delta(st.stopS, tr.s ?? 0)) < 9) { this.stoppedAt = st; break; }
      }
    }
    this.reqUrgency = 0;
  }

  /** Speed at which the tram closes in on this person (m/s). */
  closing(a) { return Math.max(0, this.v - a.vs); }

  /** How far ahead of the cab this person starts getting off the track: their own reaction
   *  time at the closing speed. The bell makes people move earlier. */
  frontFor(a) {
    const vc = this.closing(a);
    let f = Math.max(SWEPT_AHEAD + 6, vc * a.clearT + 4);
    if (a.bellT > this.c.time) f = Math.max(f, vc * (a.clearT + 2.5) + 10);
    return f;
  }

  /** Is the tram close enough at this person for the clearance rules to apply? */
  near(a) {
    const ahead = a.s - this.trainU;
    return ahead > -(TRAM_LEN + 4) && ahead < this.frontFor(a);
  }

  /** May someone start crossing the band at s now, needing about tCross seconds to get through? */
  canEnterBand(s, tCross) {
    const ahead = s - this.trainU;
    if (ahead < -(TRAM_LEN + 3)) return true;
    if (ahead < NO_GO_AHEAD + 2) return false;
    return ahead > this.v * (tCross + 2.5) + 8;
  }

  /** Before steering: flag agents that must leave the band and pick the side they go to,
   *  sidesteps for the passing tram and bell requests. */
  preStep(a) {
    if (a.kind === KIND.SEATED) { a.clearing = false; return; }
    const c = this.c, time = c.time;
    const dl = a.d - RIDE_D, adl = Math.abs(dl);
    const ahead = a.s - this.trainU;
    // the tram going by close: a small step away and a glance at it
    if (this.v > 3 && ahead > -6 && ahead < 12 && adl >= BAND && adl < BAND + 3 && time - a.passT > 25) {
      a.passT = time;
      const r = c.rng;
      if (a.state !== ST.WAIT && r.chance(adl < this.passD + 0.6 ? 0.9 : 0.5)) {
        this.stats.sidesteps++;
        a.dodge = Math.sign(dl) * r.range(0.3, 0.6); a.dodgeT = time + r.range(1.8, 3.0); a.dodgeD0 = a.d;
      }
      if (r.chance(0.55)) { a.tramLookS = time + r.range(0, 0.3); a.tramLookT = a.tramLookS + r.range(0.6, 1.4); }
    }
    // bell request: someone on the track who has not noticed the tram, shortly before they must move
    if (a.needsBell && !a.clearing && ahead > 2 && this.v > 0.5 && adl < REQ_HALF && ahead < this.stopDist && a.bellT <= time) {
      const tta = ahead / Math.max(0.3, this.closing(a));
      const lim = a.clearT + 1;
      if (tta < lim) {
        const inGauge = adl < 0.9 ? 1 : 0.65;
        const u = Math.min(1, Math.max(0, 1.15 - tta / lim)) * inGauge;
        if (u > this.reqUrgency) { this.reqUrgency = u; this.reqWho = a; this.reqAhead = ahead; this.reqDl = dl; }
      }
    }
    const front = this.frontFor(a);
    if (adl >= BAND + 0.02 || ahead < -(TRAM_LEN + 7) || ahead > front) { a.clearing = false; return; }
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
      const toPlatform = a.kind === KIND.PASSENGER || a.task === TASK.TO_PLATFORM || a.task === TASK.BOARD;
      if (hi && !toPlatform && (c.map.stationAt(a.s) || c.map.stationAt(a.s + 6))) hi = false;
      // step well clear when there is time, just clear when there is not
      const spare = ahead > 0 && this.v > 0.2 ? Math.min(1, Math.max(0, (ahead / this.v - 2) / 3)) : 1;
      a.clearTo = hi ? BAND_HI + 0.08 + 0.35 * spare : BAND_LO - 0.08 - 0.6 * spare;
    }
  }

  /** Lateral speed needed to get out of the band in time. */
  clearSpeed(a) {
    const ahead = a.s - this.trainU;
    const dist = Math.abs(a.clearTo - a.d);
    const vc = this.closing(a);
    const tta = ahead > 0 && vc > 0.2 ? ahead / vc : 6;
    const need = dist / Math.max(0.6, tta - 1.5);
    return Math.min(HURRY * 1.2, Math.max(a.v0 * 0.95, need));
  }

  /** Desired velocity filter: while the tram is near, the band edge acts like a kerb people do
   *  not step over (they slow their sideways approach to zero at it). Crossers that were let
   *  through and people clearing are exempt. */
  filterDesired(a, out) {
    if (a.clearing || out.vd === 0) return;
    const dl = a.d - RIDE_D, adl = Math.abs(dl);
    if (adl < BAND || adl > BAND + 1.5) return;
    if (a.task === TASK.CROSS && a.step >= 2 && !this.near(a)) return;
    const ahead = a.s - this.trainU;
    if (ahead < -(TRAM_LEN + 3) || ahead > this.frontFor(a) + 3) return;
    const toward = -Math.sign(dl) * out.vd;      // > 0: moving towards the band
    if (toward <= 0) return;
    const lim = Math.max(0, (adl - BAND - 0.04) * 1.6);
    if (toward > lim) out.vd = -Math.sign(dl) * lim;
  }

  /** After integration: never let anyone into the band inside the zone; hard guarantee for the swept volume. */
  constrain(a, prevD) {
    const dl = a.d - RIDE_D;
    if (Math.abs(dl) >= BAND) return;
    const ahead = a.s - this.trainU;
    const inZone = ahead > -(TRAM_LEN + 2) && ahead < Math.max(this.frontFor(a) - 4, SWEPT_AHEAD + 2);
    if (inZone && Math.abs(prevD - RIDE_D) >= BAND - 1e-4) {
      // was outside: block the step into the band
      a.d = prevD; a.vd = 0;
      this.stats.blocked++;
      if (this.blockLog.length < 400) this.blockLog.push(`${a.state}/${a.task}/${a.step}/${a.lane}/${a.leader ? 'F' : 'L'}/${a.clearing ? 'C' : '-'}`);
      return;
    }
    // the cab's swept volume (and the tram body behind it) is never entered, whatever happened above
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
    if (u < 0.15) return;
    if (time - this.lastReqT > 2.5 || u > this.lastReqU + 0.3) {
      this.lastReqT = time; this.lastReqU = u;
      this.stats.bellRequests++;
      const w = this.reqWho;
      if (this.reqLog.length < 12 && w) this.reqLog.push({ t: +time.toFixed(1), u: +u.toFixed(2), ahead: +this.reqAhead.toFixed(1), dl: +this.reqDl.toFixed(2), st: w.state, task: w.task, step: w.step, kind: w.kind, lane: w.lane, dreamy: w.dreamy });
      app.events.emit('bell-request', { urgency: +u.toFixed(2) });
    } else if (time - this.lastReqT > 1) this.lastReqU = Math.min(this.lastReqU, u);
  }

  onBell(time) { this.bellAt = time; this.stats.bells++; }
}
