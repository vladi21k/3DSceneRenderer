import {
  RIDE_D, BAND, BAND_LO, BAND_HI, TRAM_LEN, NO_GO_AHEAD, BRAKE_DECEL, SWEPT_HALF, SWEPT_AHEAD, AGENT_R, HURRY,
  PASS_BASE, PASS_PER_V, CLEAR_T,
} from './constants.js';
import { KIND, ST, TASK, MOB } from './agent.js';
import { MAX_SPEED, TRACK_ZONE_HALF } from '../../core/config.js';
import { footInBand, footBandGap, footAt } from './footprint.js';

// Tram awareness. Everybody judges the tram by time: a person on (or about to step onto)
// the ride track leaves its clearance band (|d − RIDE_D| < BAND) when the tram is their
// own `clearT` seconds away (3.5–6 s, absorbed people 2–3 s), so people step off at
// varied distances and the track ahead is used until then. Nobody steps into the band
// inside that zone, people keep a comfortable distance from the passing tram and take a
// small sidestep when it goes by, and a final projection guarantees the cab's swept
// volume stays empty. A few people only notice the tram when it rings: they ask the
// driver for the bell shortly before they would have to move.
// Strollers and bicycles count with their whole footprint: the band test, the kerb, the
// block and the final projection all use the body circle plus the prop capsule.

const _ft = { fp0s: 0, fp0d: 0, fp1s: 0, fp1d: 0, fpR: 0, extLo: 0, extHi: 0, extS: 0 };
const REQ_HALF = 1.6;   // people this close to the ride track centre may ask for the bell
const V_MAX = MAX_SPEED; // the tram's governed top speed (m/s)

export class TramWatch {
  constructor(crowd) {
    this.c = crowd;
    this.v = 0;               // tram speed (m/s, ≥ 0)
    this.acc = 0;             // its acceleration (m/s², ≥ 0)
    this.trainU = 0;          // cab front, unwrapped crowd frame
    this.clearAhead = 20;     // reach of the zone for the most cautious people (statistics)
    this.stopDist = 0;
    this.passD = PASS_BASE;   // comfortable centre distance from the ride track while the tram is near
    this.stoppedAt = null;    // station the tram is standing at
    this.bellAt = -1e9;       // last bell heard
    this.reqUrgency = 0;
    this.lastReqT = -1e9;
    this.lastReqU = 0;
    this.stats = { violations: 0, rescues: 0, blocked: 0, tramSide: 0, bellRequests: 0, bells: 0, maxUrgency: 0, sidesteps: 0 };
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
    this.acc = Math.max(0, tr.accel || 0);
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

  /** Speed at which the tram closes in on this person (m/s); a tram pulling away counts with
   *  the speed it will have a couple of seconds from now. */
  closing(a) { return Math.max(0, Math.min(V_MAX, this.v + 2 * this.acc) - a.vs); }

  /** How far ahead of the cab this person starts getting off the track: their own reaction
   *  time at the closing speed. The bell makes people move earlier. */
  frontFor(a) {
    const vc = this.closing(a);
    let f = Math.max(SWEPT_AHEAD + 6, vc * a.clearT + 4);
    // a tram gathering speed is noticed a little earlier (it will be faster than it looks)
    if (this.acc > 0.2) f = Math.max(f, 12 + vc * 2.4);
    if (a.bellT > this.c.time) f = Math.max(f, vc * (a.clearT + 2.5) + 10);
    return f;
  }

  /** Is the tram close enough at this person for the clearance rules to apply? */
  near(a) {
    const ahead = a.s - this.trainU;
    return ahead > -(TRAM_LEN + 4) && ahead < this.frontFor(a);
  }

  /** May person a start crossing the band at s now? Their time to get through it is measured
   *  from where they stand (people waiting on the far side of the left track need longer). */
  canEnterBand(a, s, T0 = 0) {
    const ahead = s - this.trainU;
    if (ahead < -(TRAM_LEN + 3)) return true;
    if (ahead < NO_GO_AHEAD + 2) return false;
    // where the tram could be by the time they are through, even if it pulls away meanwhile.
    // Parents with a stroller go only when it is clearly safe: a much bigger margin.
    // cyclists cross the ride track only with a wide margin too (they come back across often)
    const careful = a.mob === MOB.STROLLER || a.mob === MOB.WALKBIKE, cyc = a.mob === MOB.CYCLE;
    const T = (T0 || this.timeThrough(a)) * (careful ? 1.6 : cyc ? 1.3 : 1) + (careful ? 4 : cyc ? 3 : 2);
    return ahead > Math.min(this.v * T + 0.6 * T * T, Math.max(this.v, V_MAX) * T) + (careful ? 40 : cyc ? 30 : 14);
  }

  /** Seconds for a to walk out of the far side of the band from where they are. */
  timeThrough(a) {
    // a stroller enters the band ahead of its pusher; a walked bicycle is beside them
    const prop = a.mob === MOB.STROLLER ? 1.2 : a.mob === MOB.WALKBIKE ? 0.9 : a.mob === MOB.CYCLE ? 1.0 : 0;
    return (Math.abs(a.d - RIDE_D) + BAND + 0.3 + prop) / Math.max(0.9, a.v0) + 0.8;
  }

  /** Before steering: flag agents that must leave the band and pick the side they go to,
   *  sidesteps for the passing tram and bell requests. */
  preStep(a) {
    if (a.kind === KIND.SEATED) { a.clearing = false; return; }
    const c = this.c, time = c.time;
    const dl = a.d - RIDE_D, adl = Math.abs(dl);
    const ahead = a.s - this.trainU;
    // beside a platform there is no room between the ride track and the platform edge: people
    // caught there step up onto the platform (they leave it again along the platform)
    if (!a.noRect) {
      if (a.platformOK) { if (!c.map.platformAt(a.s, 1, a.d, 0.6)) a.platformOK = false; }
      // (or on the way there, clearing towards it: nobody is held in the band by the platform edge)
      else if ((dl > BAND - 0.06 || a.clearing && a.clearHi && dl > 0.6) && a.d < TRACK_ZONE_HALF + 0.8 && c.map.platformAt(a.s, 1, a.d, 0.35) && this.near(a)) a.platformOK = true;
    }
    // the tram going by close: a small step away and a glance at it
    if (this.v > 3 && ahead > -6 && ahead < 12 && adl >= BAND && adl < BAND + 3 && time - a.passT > 25 && a.mob !== MOB.CYCLE) {
      a.passT = time;
      const r = c.rng;
      if (a.state !== ST.WAIT && r.chance(adl < this.passD + 0.6 ? 0.9 : 0.5)) {
        this.stats.sidesteps++;
        a.dodge = Math.sign(dl) * r.range(0.3, 0.6); a.dodgeT = time + r.range(1.8, 3.0); a.dodgeD0 = a.d;
      }
      if (r.chance(0.55)) { a.tramLookS = time + r.range(0, 0.3); a.tramLookT = a.tramLookS + r.range(0.6, 1.4); }
    }
    // bell request: someone on the track who has not noticed the tram, shortly before they must move
    if (a.needsBell && !a.mob && !a.clearing && ahead > 2 && this.v > 0.5 && adl < REQ_HALF && ahead < this.stopDist && a.bellT <= time) {
      const tta = ahead / Math.max(0.3, this.closing(a));
      const lim = a.clearT + 1;
      if (tta < lim) {
        const inGauge = adl < 0.9 ? 1 : 0.65;
        const u = Math.min(1, Math.max(0, 1.15 - tta / lim)) * inGauge;
        if (u > this.reqUrgency) { this.reqUrgency = u; this.reqWho = a; this.reqAhead = ahead; this.reqDl = dl; }
      }
    }
    const front = this.frontFor(a);
    const inside = a.mob ? footBandGap(a) < 0.02 : adl < BAND + 0.02;
    if (!inside || ahead < -(TRAM_LEN + 7) - a.extS || ahead > front) { a.clearing = false; return; }
    if (a.clearing && a.mob) { this._clearTo(a); return; }
    if (!a.clearing) {
      a.clearing = true;
      const toHi = BAND_HI - a.d, toLo = a.d - BAND_LO;
      let hi = toHi <= toLo;
      // keep going towards the destination when there is time for it
      const tta = ahead > 0 && this.v > 0.2 ? ahead / this.v : 1e9;
      const going = a.state === ST.GOTO;
      if (going && a.gd > RIDE_D + 1 && toHi / HURRY < tta - 2) hi = true;
      else if (going && a.gd < RIDE_D - 1 && toLo / HURRY < tta - 2) hi = false;
      // a group steps off to the same side as its leader when there is time (families stay together)
      const L = a.leader;
      if (L && L.active && Math.abs(L.d - a.d) < 3.5) {
        // (a leader crossing the street is headed for its far side)
        const lHi = L.clearing ? L.clearTo > RIDE_D : L.task === TASK.CROSS && L.state === ST.GOTO ? L.gd > RIDE_D : L.d > RIDE_D;
        const dist = lHi ? toHi : toLo;
        if (dist / HURRY < tta - 1.5) hi = lHi;
      }
      // beside a platform the safe place is between the tracks (passengers are on the platform anyway)
      const toPlatform = a.kind === KIND.PASSENGER || a.task === TASK.TO_PLATFORM || a.task === TASK.BOARD;
      // (someone already at the platform edge steps up onto it instead)
      if (hi && !toPlatform && dl < BAND - 0.3 && (c.map.stationAt(a.s) || c.map.stationAt(a.s + 6))) hi = false;
      // cyclists cannot get out through the pole line: they always leave towards the other track
      // (one crossing the street keeps going the way it is crossing)
      if (a.mob === MOB.CYCLE) hi = a.state === ST.GOTO ? a.gd > a.d : a.mvOn && a.mvBand ? a.mvD1 > a.d : false;
      // step well clear when there is time, just clear when there is not
      const spare = ahead > 0 && this.v > 0.2 ? Math.min(1, Math.max(0, (ahead / this.v - 2) / 3)) : 1;
      a.clearHi = hi; a.clearSpare = spare;
      a.clearTo = hi ? BAND_HI + 0.08 + 0.35 * spare : BAND_LO - 0.08 - 0.6 * spare;
      if (a.mob) this._clearTo(a);
    }
  }

  /** Clearing target of a person with a stroller / bicycle: the prop has to be out too
   *  (its reach for the facing it will have while moving out of the band). */
  _clearTo(a) {
    const hi = a.clearHi, spare = a.clearSpare;
    const f = footAt(a, hi ? 0.6 * (a.dir >= 0 ? 1 : -1) + (a.dir >= 0 ? 0 : Math.PI) : -0.6 * (a.dir >= 0 ? 1 : -1) + (a.dir >= 0 ? 0 : Math.PI), _ft);
    const eLo = Math.max(a.extLo, f.extLo), eHi = Math.max(a.extHi, f.extHi);
    a.clearTo = hi ? BAND_HI + 0.1 + 0.35 * spare + eLo : BAND_LO - 0.1 - 0.6 * spare - eHi;
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
    if (a.clearing || out.vd === 0 || a.crossOK > this.c.time) return;
    const dl = a.d - RIDE_D;
    // distance of the footprint's near edge, in body-centre terms (|dl| for a plain body)
    const adl = a.mob ? footBandGap(a) + BAND : Math.abs(dl);
    if (adl < BAND || adl > BAND + 2.5) return;
    const ahead = a.s - this.trainU;
    if (ahead < -(TRAM_LEN + 3) || ahead > this.frontFor(a) + 3) return;
    const toward = -Math.sign(dl) * out.vd;      // > 0: moving towards the band
    if (toward <= 0) return;
    // a moving tram is given a comfortable berth; beside a standing one the band edge will do
    const kerb = BAND + 0.04 + Math.min(1, this.v / 3) * Math.max(0, this.passD - BAND - 0.25);
    const lim = Math.max(0, (adl - kerb) * 1.6);
    if (toward > lim) out.vd = -Math.sign(dl) * lim;
  }

  /** After integration: never let anyone into the band inside the zone; hard guarantee for the swept volume. */
  constrain(a, prevD) {
    const dl = a.d - RIDE_D;
    if (a.mob ? !footInBand(a) : Math.abs(dl) >= BAND) return;
    const ahead = a.s - this.trainU;
    const inZone = ahead > -(TRAM_LEN + 2) - a.extS && ahead < Math.max(this.frontFor(a) - 4, SWEPT_AHEAD + 2) + a.extS;
    const wasOut = a.mob ? footBandGap(a, prevD) >= -1e-4 : Math.abs(prevD - RIDE_D) >= BAND - 1e-4;
    if (inZone && wasOut && !(a.crossOK > this.c.time)) {
      // was outside: block the step into the band (beside a standing tram this is just its side)
      a.d = prevD; a.vd = 0;
      if (this.v < 0.3) { this.stats.tramSide++; return; }
      this.stats.blocked++;
      if (this.blockLog.length < 400) this.blockLog.push(`${a.state}/${a.task}/${a.step}/${a.lane}/${a.leader ? 'F' : 'L'}/${a.clearing ? 'C' : '-'}`);
      return;
    }
    // the cab's swept volume (and the tram body behind it) is never entered, whatever happened above
    if (ahead > -(TRAM_LEN + 1) - a.extS && ahead < SWEPT_AHEAD + 0.6 + a.extS) {
      // emergency: should never happen if the behaviour above works. Count and project out.
      const hard = a.mob ? footBandGap(a) < -(0.03 + 1e-3) : Math.abs(dl) < SWEPT_HALF + AGENT_R;
      if (ahead > -AGENT_R - a.extS && ahead < SWEPT_AHEAD + AGENT_R + a.extS && hard) this._violation(a, ahead, dl);
      this.stats.rescues++;
      if (this.rescueLog.length < 12) this.rescueLog.push({ slot: a.slot, t: +this.c.time.toFixed(1), ahead: +ahead.toFixed(1), dl: +dl.toFixed(2), pd: +(prevD - RIDE_D).toFixed(2), st: a.state, task: a.task, step: a.step, kind: a.kind, mob: a.mob, clr: a.clearing, lead: !!a.leader });
      // out through the nearer edge (beside a platform: up onto its edge), never across the track
      const hi = dl >= 0;
      if (hi && !a.noRect && this.c.map.platformAt(a.s, 1, BAND_HI + 0.05, 0.35)) a.platformOK = true;
      a.d = hi ? BAND_HI + 0.01 + a.extLo : BAND_LO - 0.01 - a.extHi;
      a.vd = 0;
    }
  }

  /** Would turning a person with a stroller / bicycle to `alpha` swing the prop into the band
   *  inside the tram's zone (when it is out of it now)? */
  turnBlocked(a, alpha) {
    if (!a.mob || a.crossOK > this.c.time) return false;
    const ahead = a.s - this.trainU;
    if (ahead < -(TRAM_LEN + 3) - 1 || ahead > Math.max(this.frontFor(a), SWEPT_AHEAD + 2) + 2) return false;
    if (footInBand(a)) return false;
    const f = footAt(a, alpha, _ft);
    const dl = a.d - RIDE_D;
    return dl + f.extHi > -BAND && dl - f.extLo < BAND;
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
