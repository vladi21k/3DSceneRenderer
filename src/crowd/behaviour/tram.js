import {
  RIDE_D, BAND, BAND_LO, BAND_HI, TRAM_LEN, NO_GO_AHEAD, BRAKE_DECEL, SWEPT_HALF, SWEPT_AHEAD, AGENT_R,
  PASS_BASE, PASS_PER_V, CLEAR_T,
} from './constants.js';
import { KIND, ST, TASK, MOB, settleShape } from './agent.js';
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

// Oncoming trams (app.trams.units, on the left track, running towards −s with the nose at u.s
// and the body trailing towards +s): the same rules mirrored around their track. Each unit is a
// tracker; a person in its band (|d − u.d| < UB) leaves it when the unit is their own reaction
// time away (a little earlier than for the cab: the unit's driver brakes for anybody on its
// track ahead), towards whichever side is open (between the tracks, or the left edge of the
// corridor when the cab tram is near as well), nobody steps into its band in front of it or
// beside it, crossers wait for a safe gap, and a final projection keeps its body empty. A unit
// ringing ('tram-bell') wakes up the absorbed.
// Both trams at once: when the cab and a unit will pass a person's spot within 3 s of each other
// there is no room between the two bodies (0.55 m), so nobody waits between the tracks: everyone
// in the corridor goes out to one of its edges (|d| > TRACK_ZONE_HALF + 0.4), the side they can
// reach before the tram on the way arrives (pair rules, _pairPre). While a unit is within 120 m,
// the strip between the tracks (|d| < 0.9) is no refuge from the cab either.
// Deadlines: out of the cab's band CLEAR_DEADLINE seconds before it arrives (dreamy or not),
// absorbed people get a bell request 5 s before, and the cab's driver brakes (Tram.obstacle) for
// anybody who cannot make it out any more.

const _ft = settleShape({ fp0s: 0, fp0d: 0, fp1s: 0, fp1d: 0, fpR: 0, extLo: 0, extHi: 0, extS: 0 });
const REQ_HALF = 1.6;   // people this close to the ride track centre may ask for the bell
const V_MAX = MAX_SPEED; // the tram's governed top speed (m/s)
const UB_EXTRA = AGENT_R + 0.15;  // unit band: body half width + this (its driver brakes for centres within half + 0.38, or heading in)
const U_CLEAR = 40;               // a unit's track is kept clear at least this far ahead of its nose (it needs the room to get going)
const U_EARLY = 2.5;              // people leave a unit's track this many seconds earlier than the cab's
const CLEAR_DEADLINE = 4.0;       // out of the cab's band at least this many seconds before it arrives
const PAIR_GAP = 3.0;             // the two trams pass a spot within this many seconds of each other: a pair
const PAIR_EDGE = TRACK_ZONE_HALF + 0.4;   // ... and the corridor is left to beyond |d| = PAIR_EDGE
const CENTRE_REFUGE = 0.9;        // the strip |d| < this between the tracks is no refuge with a unit near
const _iv = settleShape({ lo: 0, hi: 0 });
const _pw = settleShape({ T: null, tc0: 0, tc1: 0, tu0: 0, tu1: 0 });

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
    this.stats = { violations: 0, rescues: 0, blocked: 0, tramSide: 0, bellRequests: 0, bells: 0, maxUrgency: 0, sidesteps: 0, pairClears: 0, cabBrake: 0, squeeze: 0 };
    this.obstacle = Infinity;  // the nearest person the cab must brake for this frame (m ahead of its front)
    this.n = 0;               // frame counter
    this.violationLog = [];
    this.reqLog = [];
    this.rescueLog = [];
    this.blockLog = [];
    this.reqWho = null; this.reqAhead = 0; this.reqDl = 0;
    // oncoming units: trackers rebuilt every frame (crowd frame, unwrapped s)
    this.units = [];
    this.uStats = { leftTrack: 0, leftTrackLog: [], blockedS: 0, clears: 0, rescues: 0, rescueLog: [], blocked: 0, boarded: 0, alighted: 0, bells: 0, sidesteps: 0 };
    this._uPool = [];
    this._cabRescue = false; this._obsWas = Infinity;
    // results of _uFront / _uDeadline (fields: a number returned from a call that is not inlined
    // is boxed, and these are asked for per agent, unit and frame)
    this.uf = 0; this.uvc = 0; this.ud = 0;
    // (numbers as doubles from the start: c.tram is read by nearly every crowd function, and its
    // first fraction (the tram's first acceleration) would change its class mid-ride)
    settleShape(this, new Set(['n']));
  }

  /** The oncoming units near the populated range, as trackers: nose sU (unwrapped), speed v
   *  (≥ 0, towards −s), body length, half width, track centre d, band UB (centres) and the
   *  comfortable passing distance pass. */
  _units(app) {
    const c = this.c, U = app.trams && app.trams.units, out = this.units;
    out.length = 0;
    if (!U || !U.length || c.camU === null) return;
    for (const u of U) {
      if (!u || u.active === false || !Number.isFinite(u.s)) continue;
      const sU = c.camU + app.route.delta(c.camW, u.s);
      const rel = sU - c.camU;
      if (rel < -120 || rel > 820) continue;
      const v = Math.max(0, u.speed || 0), half = u.halfWidth || 1.325;
      const T = this._uPool[u.id] || (this._uPool[u.id] = newTracker());
      T.i = u.id; T.sU = sU; T.v = v; T.acc = Math.max(0, u.accel || 0); T.len = u.length || 32; T.half = half;
      T.d = Number.isFinite(u.d) ? u.d : -RIDE_D; T.state = u.state; T.UB = half + UB_EXTRA;
      // (passing it, nobody walks closer than 0.9 m to the street's centre line either)
      T.pass = Math.max(T.UB + 0.3 + 0.03 * v, Math.abs(T.d) + CENTRE_REFUGE + 0.12);
      // where its driver would start braking for somebody on the track (stopping distance + gap)
      // (not shrinking as it slows down: it will want to get going again)
      const vb = Math.max(v, 5);
      T.brakeAt = (vb * vb) / 1.7 + 6 + 2 * vb;
      T.reach = half + 0.38;          // its driver's scan: centres within this of its track, or heading in
      out.push(T);
      // unit standing with people on its track ahead (statistics)
      if (app.dt > 0 && v < 0.5 && u.state !== 'dwell' && u.obs < 40) this.uStats.blockedS += app.dt;
    }
  }

  update(app, trainU) {
    const tr = app.train || {};
    this._units(app);
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
    this.obstacle = Infinity;
    this.n++;                 // frame counter (per-agent caches such as a.front)
  }

  /** Speed at which the tram closes in on this person (m/s); a tram pulling away counts with
   *  the speed it will have a couple of seconds from now. */
  closing(a) { return Math.max(0, Math.min(V_MAX, this.v + 2 * this.acc) - a.vs); }

  /** How far ahead of the cab this person starts getting off the track: their own reaction
   *  time at the closing speed. The bell makes people move earlier. */
  frontFor(a) { this.front(a); return a.front; }

  /** frontFor into a.front, worked out once per agent and frame (it is asked for half a dozen
   *  times in a step; a number returned from a call that is not inlined is boxed). */
  front(a) {
    if (a.frontN === this.n) return;
    a.frontN = this.n;
    const vc = Math.max(0, Math.min(V_MAX, this.v + 2 * this.acc) - a.vs);
    // (whoever they are, out of the band CLEAR_DEADLINE seconds before the tram is there; exitT(a)
    // written out)
    const adl = Math.abs(a.d - RIDE_D);
    const exit = adl >= BAND ? 0 : (BAND + 0.1 - adl + (a.mob ? 0.7 : 0)) / Math.max(1, a.hurry) + 0.5;
    let f = Math.max(SWEPT_AHEAD + 6, vc * Math.max(a.clearT, CLEAR_DEADLINE + exit) + 4);
    // a tram gathering speed is noticed a little earlier (it will be faster than it looks)
    if (this.acc > 0.2) f = Math.max(f, 12 + vc * 2.4);
    if (a.bellT > this.c.time) f = Math.max(f, vc * (a.clearT + 2.5) + 10);
    a.front = f;
  }

  /** Seconds a person needs to get out of the cab's band from where they are (at their brisk pace). */
  exitT(a) {
    const adl = Math.abs(a.d - RIDE_D);
    if (adl >= BAND) return 0;
    return (BAND + 0.1 - adl + (a.mob ? 0.7 : 0)) / Math.max(1, a.hurry) + 0.5;
  }

  /** Is the tram close enough at this person for the clearance rules to apply? */
  near(a) {
    this.front(a);
    const ahead = a.s - this.trainU;
    return ahead > -(TRAM_LEN + 4) && ahead < a.front;
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

  /** Before steering: flag agents that must leave a band (the cab's, an oncoming unit's) and
   *  pick the side they go to, sidesteps for the passing tram and bell requests. */
  preStep(a) {
    // clearing for a unit (and for both trams at once) is decided afresh every frame (after the cab's rules)
    if (a.uClr) { a.clearing = false; a.uClr = false; }
    if (a.pClr) { a.clearing = false; a.pClr = false; }
    a.uOver = false; a.uHold = false;
    this._cabPre(a);
    this._unitPre(a);
    this._pairPre(a);
  }

  // ---------------------------------------------------------------- both trams at once
  /** When do the cab and the oncoming units occupy person a's s? The unit whose window comes
   *  within PAIR_GAP seconds of the cab's → _pw {T, tc0, tc1, tu0, tu1} (seconds from now), or null. */
  pairWindow(a) {
    if (!this.units.length) return null;
    // (a tram standing still is no part of a pair: when it moves off, its own rules apply)
    if (this.v < 0.5 && this.acc < 0.2) return null;
    const ahead = a.s - this.trainU;
    if (ahead < -(TRAM_LEN + 2) - a.extS) return null;                 // the cab has gone by
    const vc = Math.max(Math.min(V_MAX, this.v + 2 * this.acc) - a.vs, 0.5);   // closing(a), at least 0.5
    const tc0 = ahead > 0 ? ahead / vc : 0, tc1 = (ahead + TRAM_LEN + 2) / vc;
    let best = null, bt = 1e9;
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui];
      const ah = T.sU - a.s;
      if (ah < -(T.len + 2) - a.extS || ah > 260) continue;
      // (a unit standing beside them is a wall the cab passes; one standing ahead is no pair yet)
      const still = T.v < 0.5 && T.acc < 0.2;
      if (still && ah > 0) continue;
      const vu = Math.max(Math.min(V_MAX, T.v + 2 * T.acc) + a.vs, 0.5);   // uClosing(T, a), at least 0.5
      const tu0 = ah > 0 ? ah / vu : 0;
      const tu1 = still ? 1e9 : (ah + T.len + 2) / vu;
      if (tc0 > tu1 + PAIR_GAP || tu0 > tc1 + PAIR_GAP) continue;
      const t = Math.min(tc0, tu0);
      if (t < bt) { bt = t; best = T; _pw.tu0 = tu0; _pw.tu1 = tu1; }
    }
    if (!best) return null;
    _pw.T = best; _pw.tc0 = tc0; _pw.tc1 = tc1;
    return _pw;
  }

  /** Both trams pass a's spot close together: nobody stays in the corridor between them. A
   *  person in it goes out to the edge they can reach before the tram on the way arrives (the
   *  one they were heading for, else the nearer one), briskly. */
  _pairPre(a) {
    a.pair = 0;
    if (!this.units.length || a.kind === KIND.SEATED || a.mob === MOB.CYCLE || Math.abs(a.d) > TRACK_ZONE_HALF + 3.5) { a.pSide = 0; return; }
    // (up on a platform: the platform is the refuge)
    if (a.state === ST.PLATFORM || (a.platformOK && Math.abs(a.d) > TRACK_ZONE_HALF)) { a.pSide = 0; return; }
    const w = this.pairWindow(a);
    if (!w) { a.pSide = 0; return; }
    const T = w.T, t0 = Math.min(w.tc0, w.tu0);
    const vH = Math.max(1, a.hurry);
    // out to the left through (or from) the unit's band before its driver would brake for them;
    // out to the right through the cab's band CLEAR_DEADLINE seconds before the cab is there
    const uOutL = T.d - T.UB - a.extHi - 0.05, cOutR = RIDE_D + BAND + a.extLo + 0.05;
    const needL = a.d > uOutL ? (a.d - uOutL) / vH + 0.6 : 0;
    const needR = a.d < cOutR ? (cOutR - a.d) / vH + 0.6 : 0;
    let dL = -99;
    if (T.sU - a.s > 0) { this._uDeadline(a, T); dL = this.ud; }
    const dR = w.tc0 <= 0 ? -99 : w.tc0 - CLEAR_DEADLINE;
    const slackL = a.d <= uOutL ? 99 : dL - needL;
    const slackR = a.d >= cOutR ? 99 : dR - needR;
    // (in time: while either way out is still open, with a reaction's margin)
    if (t0 > a.clearT + U_EARLY + 1 && Math.max(slackL, slackR) > 2.5) return;
    a.pair = T.i + 1; a.uI = T.i;
    const L = -(PAIR_EDGE + a.extHi), R = PAIR_EDGE + a.extLo;
    if (a.d <= L + 0.05 || a.d >= R - 0.05) { a.pSide = 0; return; }   // out at an edge already
    const time = this.c.time;
    let side = a.pSide;
    if (!side || (side > 0 ? slackR : slackL) < -0.5) {
      const okL = slackL > 0.3, okR = slackR > 0.3;
      if (okL && okR) {
        // where they were going (a crossing, their sidewalk), else the nearer edge
        const goal = a.state === ST.GOTO ? a.gd : a.clearing && !a.uClr ? a.clearTo : a.side * 9;
        const nearR = R - a.d < a.d - L;
        side = Math.abs(goal) > TRACK_ZONE_HALF ? (goal > 0 ? 1 : -1) : nearR ? 1 : -1;
        // (a group goes out with its leader)
        const Ld = a.leader;
        if (Ld && Ld.active && Ld.pSide && (Ld.pSide > 0 ? slackR : slackL) > 0.3) side = Ld.pSide;
      } else if (okL || okR) side = okR ? 1 : -1;
      else side = slackR >= slackL ? 1 : -1;
      if (side !== a.pSide) this.stats.pairClears++;
      a.pSide = side;
    }
    const spare = Math.min(1, Math.max(0, (t0 - 2) / 3));
    a.clearing = true; a.pClr = true; a.clearHi = side > 0; a.clearSpare = spare;
    a.clearTo = side > 0 ? R + 0.15 * spare : L - 0.15 * spare;
    a.uI = T.i;
    // walking through the band on the way out is allowed (the slack was checked)
    const need = side > 0 ? needR : needL;
    if (need > 0 && (side > 0 ? slackR : slackL) > 0) a.crossOK = Math.max(a.crossOK, time + need + 0.4);
  }

  // ---------------------------------------------------------------- oncoming units
  unitById(i) { const U = this.units; for (let k = 0; k < U.length; k++) if (U[k].i === i) return U[k]; return null; }
  /** Speed at which unit T closes in on person a (m/s). */
  uClosing(T, a) { return Math.max(0, Math.min(V_MAX, T.v + 2 * T.acc) + a.vs); }
  /** How far ahead of unit T's nose person a starts getting off its track. */
  uFront(T, a) { this._uFront(T, a); return this.uf; }
  /** uFront → this.uf, and uClosing → this.uvc. */
  _uFront(T, a) {
    const vc = Math.max(0, Math.min(V_MAX, T.v + 2 * T.acc) + a.vs);
    // (whatever its speed: a standing unit needs a clear stretch ahead to move off again)
    let f = Math.max(U_CLEAR, T.brakeAt + 12, vc * (a.clearT + U_EARLY) + 10);
    if (a.ubellT > this.c.time) f = Math.max(f, vc * (a.clearT + U_EARLY + 2) + 16);
    this.uvc = vc; this.uf = f;
  }
  /** The unit whose zone person a is in (the soonest to arrive), or null. */
  uZone(a, extra = 0) {
    let best = null, bt = 1e9;
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui];
      const ah = T.sU - a.s;
      if (ah < -(T.len + 4) - a.extS) continue;
      this._uFront(T, a);
      if (ah > this.uf + extra) continue;
      const t = ah / Math.max(0.5, this.uvc);
      if (t < bt) { bt = t; best = T; }
    }
    return best;
  }
  /** Distance of a's footprint (body centre at d) from the edge of unit T's band (≥ 0 outside).
   *  (The per-frame code works this out in place: a double passed to or returned from a call that
   *  is not inlined is boxed.) */
  uGap(a, T, d = a.d) {
    const dl = d - T.d;
    return dl >= 0 ? dl - a.extLo - T.UB : -dl - a.extHi - T.UB;
  }
  /** Seconds before the unit's driver would have to brake for person a (its stopping distance plus
   *  the gap it keeps): the deadline for being out of its band. */
  uDeadline(a, T) { this._uDeadline(a, T); return this.ud; }
  /** uDeadline → this.ud. */
  _uDeadline(a, T) {
    const ah = T.sU - a.s, vc = Math.max(0, Math.min(V_MAX, T.v + 2 * T.acc) + a.vs);
    // (a standing unit: out within a couple of seconds all the same)
    this.ud = ah <= 0 ? 0 : Math.min((ah - T.brakeAt) / Math.max(0.5, vc), 2 + (ah - 10) / 12);
  }

  /** Clearing for the oncoming units: out of the band of the unit whose zone this is, to the
   *  open side (between the tracks, or the left edge of the corridor when the cab is near too). */
  _unitPre(a) {
    a.uI = -1;
    if (!this.units.length || a.kind === KIND.SEATED) { a.uSide = 0; return; }
    const T = this.uZone(a);
    if (!T) { a.uSide = 0; return; }
    a.uI = T.i;
    const cabNear = this.near(a);
    // the unit going by close: a small step away and a glance at it
    const ah0 = T.sU - a.s, adl0 = Math.abs(a.d - T.d), time = this.c.time;
    if (T.v > 3 && ah0 > -6 && ah0 < 12 && adl0 >= T.UB && adl0 < T.UB + 3 && time - a.passT > 25 && a.mob !== MOB.CYCLE && !a.clearing) {
      a.passT = time;
      const r = this.c.rng;
      // (a step back only for those it really goes by close; most keep a berth anyway)
      if (a.state !== ST.WAIT && r.chance(adl0 < T.UB + 0.35 ? 0.6 : adl0 < T.pass + 0.2 ? 0.25 : 0.04)) {
        this.uStats.sidesteps++;
        a.dodge = Math.sign(a.d - T.d) * r.range(0.3, 0.6); a.dodgeT = time + r.range(1.8, 3.0); a.dodgeD0 = a.d;
      }
      if (r.chance(0.55)) { a.tramLookS = time + r.range(0, 0.3); a.tramLookT = a.tramLookS + r.range(0.6, 1.4); a.lookU = T.i; }
    }
    this._uDeadline(a, T);
    const tta = Math.max(0, this.ud);
    const spare = Math.min(1, Math.max(0, (tta - 1) / 3));
    // (between the tracks: at least CENTRE_REFUGE from the street's centre line)
    const loT = T.d - T.UB - a.extHi - 0.15 - 0.5 * spare;
    const hiT = Math.max(T.d + T.UB + a.extLo + 0.2 + 0.4 * spare, Math.sign(-T.d) * CENTRE_REFUGE + a.extLo);
    if (a.clearing) {
      // already clearing for the cab: its target must be outside this band too. Across it to
      // the left edge while there is time to be through before its driver would brake; else
      // (its body beside them, its nose close) wait clear of it on this side until it has gone
      // by (the cab is far enough: were it not, the pair rules would have taken over)
      const dlc = a.clearTo - T.d;
      if ((dlc >= 0 ? dlc - a.extLo - T.UB : -dlc - a.extHi - T.UB) < 0.02) {
        const through = (a.d - loT) / Math.max(1, a.hurry) + 0.6;
        this._uDeadline(a, T);
        if (T.sU - a.s > 0 && this.ud > through + 0.3) a.clearTo = loT;
        else if (a.d > T.d) { a.clearTo = Math.max(T.d + T.pass, hiT) + a.extLo; a.uHold = true; }
        else a.clearTo = loT;
        a.uOver = true;
      }
      return;
    }
    const dln = a.d - T.d;
    if ((dln >= 0 ? dln - a.extLo - T.UB : -dln - a.extHi - T.UB) >= 0.02) { a.uSide = 0; return; }
    if (!a.uSide) {
      // (over to the other track rather than off the corridor, unless that is much further)
      let hi = hiT - a.d <= a.d - loT + 0.9;
      // with the cab near the only way out is to the left (no crossing of its track)
      if (cabNear) hi = false;
      else {
        // a cyclist pulls over between the tracks (the pole line leaves no room on the left)
        if (a.mob === MOB.CYCLE) hi = true;
        // keep going towards the destination when there is time
        else if (a.state === ST.GOTO && a.gd > hiT && (hiT - a.d) / a.hurry < tta) hi = true;
        else if (a.state === ST.GOTO && a.gd < loT && (a.d - loT) / a.hurry < tta) hi = false;
        // a group goes to the side its leader goes to, or is on (families stay together)
        const L = a.leader;
        if (L && L.active && Math.abs(L.d - a.d) < 3.5) {
          const lHi = L.uSide ? L.uSide > 0 : L.clearing ? L.clearTo > T.d : L.d > T.d;
          if ((lHi ? hiT - a.d : a.d - loT) / a.hurry < tta + 1.5) hi = lHi;
        }
      }
      a.uSide = hi ? 1 : -1;
      this.uStats.clears++;
    }
    if (a.uSide > 0 && cabNear) a.uSide = -1;
    a.clearing = true; a.uClr = true;
    a.clearHi = a.uSide > 0; a.clearSpare = spare;
    a.clearTo = a.uSide > 0 ? hiT : loT;
  }

  /** Lateral interval (signed d, body centre) kept free for the trams near person a, merged:
   *  the cab's band with its passing berth, and the nearest unit's. Returns null when none is
   *  near. `pass`: with the comfortable distance (lane targets) or just the band. */
  keepOut(a, pass = true) {
    let lo = 1e9, hi = -1e9;
    if (this.near(a) || a.pair) {
      const pd = pass ? this.passD : BAND;
      lo = RIDE_D - pd - a.extHi; hi = RIDE_D + pd + a.extLo;
    }
    const T = a.pair ? this.unitById(a.pair - 1) : a.uI >= 0 ? this.unitById(a.uI) : this.uZone(a);
    if (T) {
      const pd = pass ? T.pass : T.UB;
      const l = T.d - pd - a.extHi, h = T.d + pd + a.extLo;
      if (lo > hi) { lo = l; hi = h; }
      // (both trams passing close together: the whole corridor between them)
      else if (a.pair || (l <= hi + 0.6 && h >= lo - 0.6)) { lo = Math.min(lo, l); hi = Math.max(hi, h); }
      else if (Math.abs(a.d - T.d) < Math.abs(a.d - RIDE_D)) { lo = l; hi = h; }  // (apart: the nearer one)
    }
    if (a.pair) { lo = Math.min(lo, -(PAIR_EDGE + a.extHi)); hi = Math.max(hi, PAIR_EDGE + a.extLo); }
    if (lo > hi) return null;
    _iv.lo = lo; _iv.hi = hi;
    return _iv;
  }

  /** May person a start crossing the unit bands at s now (the time to get through measured from
   *  where they stand)? A unit standing at a stop counts as about to start. */
  canEnterUnit(a, s, T0 = 0) {
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui];
      const ah = T.sU - s;
      if (ah < -(T.len + 3)) continue;
      if (ah < NO_GO_AHEAD + 4) return false;
      const careful = a.mob === MOB.STROLLER || a.mob === MOB.WALKBIKE, cyc = a.mob === MOB.CYCLE;
      const prop = a.mob === MOB.STROLLER ? 1.2 : a.mob === MOB.WALKBIKE ? 0.9 : cyc ? 1.0 : 0;
      const t0 = T0 || (Math.abs(a.d - T.d) + T.UB + 0.3 + prop) / Math.max(0.9, a.v0) + 0.8;
      const tt = t0 * (careful ? 1.6 : cyc ? 1.3 : 1) + (careful ? 4 : cyc ? 3 : 2);
      const reach = Math.min(T.v * tt + 0.6 * tt * tt, Math.max(T.v, V_MAX) * tt) + (T.v * T.v) / 1.7 + (careful ? 40 : cyc ? 30 : 18);
      if (ah < reach) return false;
    }
    return true;
  }

  /** The units' bands: nobody steps in inside a unit's zone (unless committed to a crossing),
   *  and its body (with a couple of metres in front of the nose) is never entered. */
  _uConstrain(a) {
    const prevD = a.prevD, dt = a.stepDt;
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui];
      const ah = T.sU - a.s;
      if (ah < -(T.len + 3) - a.extS || ah > 260) continue;
      this._uFront(T, a);
      const inZone = ah < Math.max(this.uf - 4, 10) + a.extS;
      // (the footprint's gap to its band now and before this step, worked out in place)
      const dg = a.d - T.d, dgp = prevD - T.d;
      const gap = dg >= 0 ? dg - a.extLo - T.UB : -dg - a.extHi - T.UB;
      const gapPrev = dgp >= 0 ? dgp - a.extLo - T.UB : -dgp - a.extHi - T.UB;
      if (gap >= 0) {
        // beside its band: never heading in fast enough to look like stepping in front of it
        // (its driver reads a person moving towards the track as about to be on it)
        if (!inZone || a.crossOK > this.c.time || a.clearing || !(dt > 0) || ah > 175) continue;
        const dl = a.d - T.d, sgn = dl > 0 ? -1 : 1;
        const step = (a.d - prevD) * sgn;
        if (step <= 0) continue;
        const room = Math.abs(dl) - (a.mob ? (dl > 0 ? a.extLo : a.extHi) : 0) - T.reach - 0.04;
        const lim = Math.max(0, room / 1.6) * dt;
        if (step > lim) { a.d = prevD + sgn * lim; a.vd = sgn * lim / dt; }
        continue;
      }
      if (inZone && !this._cabRescue && gapPrev >= -1e-4 && !(a.crossOK > this.c.time)) {
        a.d = prevD; a.vd = 0;
        if (T.v >= 0.3) this.uStats.blocked++;
        continue;
      }
      if (ah > 1.5 + 0.5 * T.v + AGENT_R + a.extS) continue;
      const dl = a.d - T.d;
      const hard = a.mob ? gap < -(UB_EXTRA - AGENT_R) - 0.03 : Math.abs(dl) < T.half + AGENT_R;
      if (!hard) {
        // still in its band beside the body (or right at its nose): a quick step out to the
        // nearer edge, as fast as a startled person moves (its driver brakes for them)
        if (!(dt > 0)) continue;
        const sg = dl >= 0 ? 1 : -1, edge = T.d + sg * (T.UB + (sg > 0 ? a.extLo : a.extHi) + 0.02);
        const step = Math.min(2.2 * dt, Math.abs(edge - a.d));
        if (step > 1e-4) { a.d += sg * step; a.vd = sg * 2.2; this.uStats.sidesteps++; }
        continue;
      }
      this.uStats.rescues++;
      if (this.uStats.rescueLog.length < 8) this.uStats.rescueLog.push({ t: +this.c.time.toFixed(1), unit: T.i, ah: +ah.toFixed(1), dl: +dl.toFixed(2), pd: +(prevD - T.d).toFixed(2), v: +T.v.toFixed(1), st: a.state, task: a.task, mob: a.mob, kind: a.kind, clr: a.clearing, uClr: a.uClr, pClr: a.pClr, cross: +(a.crossOK - this.c.time).toFixed(1), lead: !!a.leader });
      // out through the nearer side (the smallest jump), in view at a startled person's pace;
      // the full projection only out of sight
      const hi = dl >= 0;
      const tgt = hi ? T.d + T.half + AGENT_R + 0.01 + a.extLo : T.d - T.half - AGENT_R - 0.01 - a.extHi;
      if (this.c.vis.hidden(a.s, a.d) || !(dt > 0)) a.d = tgt;
      else a.d += Math.sign(tgt - a.d) * Math.min(Math.abs(tgt - a.d), Math.max(2.2 * dt, 0.12));
      a.vd = 0;
    }
  }

  /** The unit standing (doors open) at station st's left platform, or null. A unit stops with
   *  its nose as far into the left platform as the cab does on the right one. */
  unitDwelling(st) {
    const route = this.c.route, nose = 2 * st.s - st.stopS;
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui];
      if (T.state !== 'dwell' && !(T.v < 0.15 && T.state === 'depart')) continue;
      if (Math.abs(route.delta(route.wrap(nose), route.wrap(T.sU))) < 10) return T;
    }
    return null;
  }

  /** Is the point (s, d) (a figure on the left platform) hidden from the camera behind a unit's
   *  body standing between them? The sight lines to both shoulders, at head height, must pass
   *  through the body (in plan, below its roof). */
  behindUnit(s, d) {
    const c = this.c, vis = c.vis, cd = vis.camD, cu = vis.camU;
    let hc = 2.75;
    try { hc = vis.camPos.y - c.route.groundY(c.route.wrap(cu), cd); } catch (e) { hc = 2.75; }
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui];
      let ok = true;
      for (const ds of [-0.3, 0.3]) {
        if (!rayThroughBox(cu, cd, hc, s + ds, d, 1.55, T.sU + 0.4, T.sU + T.len - 0.4, T.d - T.half + 0.1, T.d + T.half - 0.1, 3.2)) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  /** A unit rang: people on or beside its track ahead look round, and the absorbed wake up. */
  onUnitBell(e, time) {
    const T = this.unitById(e && Number.isInteger(e.unit) ? e.unit : -1);
    if (!T) return;
    this.uStats.bells++;
    const r = this.c.rng, reach = 60 + 3 * T.v;
    for (let ii = 0, AG = this.c.population.agents, nn = AG.length; ii < nn; ii++) {
      const a = AG[ii];
      if (!a.active || a.state === ST.SEATED) continue;
      const ah = T.sU - a.s;
      if (ah < -6 || ah > reach) continue;
      // (waiting on a platform: a few look up the track at the sound)
      if (a.state === ST.PLATFORM) {
        if (!r.chance(0.2)) continue;
        a.tramLookS = time + r.range(0.2, 1.0); a.tramLookT = a.tramLookS + r.range(1.5, 3.5); a.lookU = T.i;
        continue;
      }
      const near = Math.abs(a.d - T.d) < 3.6;
      if (!r.chance(near ? 0.85 : 0.08)) continue;
      const delay = Math.max(0, ah) / 340 + r.range(0.2, 1.1);
      a.tramLookS = time + delay; a.tramLookT = a.tramLookS + (near ? r.range(1.0, 2.2) : r.range(0.4, 0.9));
      a.lookU = T.i;
      if (near) a.ubellT = time + delay + 5;
    }
  }

  _cabPre(a) {
    if (a.kind === KIND.SEATED) { a.clearing = false; return; }
    const c = this.c, time = c.time;
    const dl = a.d - RIDE_D, adl = Math.abs(dl);
    const ahead = a.s - this.trainU;
    // beside a platform there is no room between the ride track and the platform edge: people
    // caught there step up onto the platform (they leave it again along the platform)
    if (!a.noRect) {
      if (a.platformOK) this._platformKeep(a);
      // (or on the way there, clearing towards it: nobody is held in the band by the platform edge)
      else if ((dl > BAND - 0.06 || a.clearing && a.clearHi && dl > 0.6) && a.d < TRACK_ZONE_HALF + 0.8 && c.map.platformAtA(a, 1, 0.35) && this.near(a)) {
        a.platformOK = true; a.platSt = c.map.stationAtA(a); a.platSide = 1;
      }
    }
    // the tram going by close: a small step away and a glance at it
    if (this.v > 3 && ahead > -6 && ahead < 12 && adl >= BAND && adl < BAND + 3 && time - a.passT > 25 && a.mob !== MOB.CYCLE) {
      a.passT = time;
      const r = c.rng;
      // (a step back only for those it really goes by close; most keep a berth anyway)
      if (a.state !== ST.WAIT && r.chance(adl < BAND + 0.35 ? 0.6 : adl < this.passD + 0.2 ? 0.25 : 0.04)) {
        this.stats.sidesteps++;
        a.dodge = Math.sign(dl) * r.range(0.3, 0.6); a.dodgeT = time + r.range(1.8, 3.0); a.dodgeD0 = a.d;
      }
      if (r.chance(0.55)) { a.tramLookS = time + r.range(0, 0.3); a.tramLookT = a.tramLookS + r.range(0.6, 1.4); }
    }
    // bell request: someone on the track who has not noticed the tram, shortly before they must move
    // (closing(a) written out below: per agent and frame)
    const vClose = Math.max(0, Math.min(V_MAX, this.v + 2 * this.acc) - a.vs);
    if (a.needsBell && !a.mob && !a.clearing && ahead > 2 && this.v > 0.5 && adl < REQ_HALF && ahead < this.stopDist && a.bellT <= time) {
      const tta = ahead / Math.max(0.3, vClose);
      // (5 s ahead: the look up and the step off happen while the tram is still well away)
      const lim = Math.max(5, a.clearT + 1);
      if (tta < lim) {
        const inGauge = adl < 0.9 ? 1 : 0.65;
        const u = Math.min(1, Math.max(0, 1.15 - tta / lim)) * inGauge;
        if (u > this.reqUrgency) { this.reqUrgency = u; this.reqWho = a; this.reqAhead = ahead; this.reqDl = dl; }
      }
    }
    this.front(a);
    const front = a.front;
    // (the footprint's gap to the band worked out in place: footBandGap returns a boxed number)
    const inside = a.mob ? (dl >= 0 ? dl - a.extLo - BAND : -dl - a.extHi - BAND) < 0.02 : adl < BAND + 0.02;
    // somebody who cannot be out of the band before the cab is there any more: its driver brakes
    if (inside && ahead > 0 && this.v > 0.5 && ahead < this.obstacle) {
      const tta = ahead / Math.max(0.3, vClose);
      const exit = adl >= BAND ? 0 : (BAND + 0.1 - adl + (a.mob ? 0.7 : 0)) / Math.max(1, a.hurry) + 0.5;   // exitT(a)
      if (tta < CLEAR_DEADLINE - 0.5 && exit + 0.6 > tta) this.obstacle = ahead;
    }
    if (!inside || ahead < -(TRAM_LEN + 7) - a.extS || ahead > front) { a.clearing = false; return; }
    if (a.clearing && a.mob) { this._clearTo(a); return; }
    if (!a.clearing) {
      a.clearing = true;
      const toHi = BAND_HI - a.d, toLo = a.d - BAND_LO;
      let hi = toHi <= toLo;
      // walking along the corridor: over to its left strip and on (rather than off the
      // corridor), when that is not much further
      if (a.state === ST.WALK && !a.mob && toLo < toHi + 1.2) hi = false;
      // keep going towards the destination when there is time for it
      const tta = ahead > 0 && this.v > 0.2 ? ahead / this.v : 1e9;
      const going = a.state === ST.GOTO;
      if (going && a.gd > RIDE_D + 1 && toHi / a.hurry < tta - 2) hi = true;
      else if (going && a.gd < RIDE_D - 1 && toLo / a.hurry < tta - 2) hi = false;
      // a group steps off to the same side as its leader when there is time (families stay together)
      const L = a.leader;
      if (L && L.active && Math.abs(L.d - a.d) < 3.5) {
        // (a leader crossing the street is headed for its far side)
        const lHi = L.clearing ? L.clearTo > RIDE_D : L.task === TASK.CROSS && L.state === ST.GOTO ? L.gd > RIDE_D : L.d > RIDE_D;
        const dist = lHi ? toHi : toLo;
        if (dist / a.hurry < tta - 1.5) hi = lHi;
      }
      // beside a platform the safe place is between the tracks (passengers are on the platform anyway)
      const toPlatform = a.kind === KIND.PASSENGER || a.task === TASK.TO_PLATFORM || a.task === TASK.BOARD;
      // (someone already at the platform edge steps up onto it instead)
      if (hi && !toPlatform && dl < BAND - 0.3 && (c.map.stationAtA(a) || c.map.stationAt(a.s + 6))) hi = false;
      // cyclists cannot get out through the pole line: they always leave towards the other track
      // (one crossing the street keeps going the way it is crossing)
      if (a.mob === MOB.CYCLE) hi = a.state === ST.GOTO ? a.gd > a.d : a.mvOn && a.mvBand ? a.mvD1 > a.d : false;
      // step well clear when there is time, just clear when there is not
      const spare = ahead > 0 && this.v > 0.2 ? Math.min(1, Math.max(0, (ahead / this.v - 2) / 3)) : 1;
      a.clearHi = hi; a.clearSpare = spare;
      a.cabTo = hi ? BAND_HI + 0.08 + 0.35 * spare : BAND_LO - 0.08 - 0.6 * spare;
      if (a.mob) this._clearTo(a);
    }
    // (the cab's target, which a unit's rules may change for a frame)
    if (!a.mob) a.clearTo = a.cabTo;
    // with a unit coming, between the tracks means beyond the centre strip (it may soon need the
    // rest of the corridor too: the pair rules take over then)
    if (!a.clearHi && a.clearTo > -CENTRE_REFUGE - a.extHi && this.unitNearA(a, 120)) a.clearTo = -CENTRE_REFUGE - a.extHi - 0.1 * a.clearSpare;
  }

  /** unitNear(a.s, reach) (a's own s: nothing boxed). */
  unitNearA(a, reach) {
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui], ah = T.sU - a.s;
      if (ah > -(T.len + 2) && ah < reach) return true;
    }
    return false;
  }

  /** Is an oncoming unit within `reach` metres ahead of s (or beside it)? */
  unitNear(s, reach) {
    for (let ui = 0; ui < this.units.length; ui++) {
      const T = this.units[ui], ah = T.sU - s;
      if (ah > -(T.len + 2) && ah < reach) return true;
    }
    return false;
  }

  /** A walker using a platform as the sidewalk (or stepped up onto it to let the tram by) keeps
   *  doing so while on it or about to be, and steps down again past its far end. */
  _platformKeep(a) {
    const c = this.c, st = a.platSt;
    const ad = a.d >= 0 ? a.d : -a.d;
    if (!st) { if (!c.map.platformAtA(a, a.d >= 0 ? 1 : -1, 0.6)) a.platformOK = false; return; }
    if (c.map.platformAtA(a, a.platSide || 1, 0.8)) return;
    // (route.delta(st.s, a.s) worked out in place: no numbers boxed per agent and frame)
    const L = c.route.length;
    let ds = (a.s - st.s) % L;
    if (ds < -L / 2) ds += L; else if (ds > L / 2) ds -= L;
    if ((ds >= 0 ? ds : -ds) > st.len / 2 + (ds * (a.dir || 1) < 0 ? 12 : 2)) { a.platformOK = false; a.platSt = null; }
  }

  /** Clearing target of a person with a stroller / bicycle: the prop has to be out too
   *  (its reach for the facing it will have while moving out of the band). */
  _clearTo(a) {
    const hi = a.clearHi, spare = a.clearSpare;
    const f = footAt(a, hi ? 0.6 * (a.dir >= 0 ? 1 : -1) + (a.dir >= 0 ? 0 : Math.PI) : -0.6 * (a.dir >= 0 ? 1 : -1) + (a.dir >= 0 ? 0 : Math.PI), _ft);
    const eLo = Math.max(a.extLo, f.extLo), eHi = Math.max(a.extHi, f.extHi);
    a.clearTo = hi ? BAND_HI + 0.1 + 0.35 * spare + eLo : BAND_LO - 0.1 - 0.6 * spare - eHi;
    if (!hi && a.clearTo > -CENTRE_REFUGE - eHi && this.unitNearA(a, 120)) a.clearTo = -CENTRE_REFUGE - eHi;
  }

  /** Lateral speed needed to get out of the band in time. */
  clearSpeed(a) {
    const dist = Math.abs(a.clearTo - a.d);
    const H = a.hurry;
    // (stepping back from a unit going by, to cross behind it: no hurry)
    if (a.uHold) return Math.min(a.v0, 0.4 + dist * 1.5);
    if (a.pClr) {
      // both trams: out of the corridor at a brisk pace, at a trot when it gets close
      const w = this.pairWindow(a);
      let left = 6;
      if (w) left = a.pSide > 0 ? w.tc0 - CLEAR_DEADLINE : w.T.sU - a.s > 0 ? this.uDeadline(a, w.T) : 0;
      const need = dist / Math.max(0.6, left + 0.6);
      return Math.min(H * 1.2, Math.max(Math.min(H, a.v0 * 1.25), need, left < 1.5 ? H : 0));
    }
    let left = 6;
    if (!a.uClr) {
      const ahead = a.s - this.trainU, vc = this.closing(a);
      left = (ahead > 0 && vc > 0.2 ? ahead / vc : 6) - 1.5;
    }
    // (a unit's driver brakes for anybody still on its track: out before that)
    if ((a.uClr || a.uOver) && a.uI >= 0) { const T = this.unitById(a.uI); if (T) left = Math.min(left, this.uDeadline(a, T)); }
    const need = dist / Math.max(0.6, left);
    // (past the deadline: at a trot, whoever it is)
    const late = !a.uClr && left < CLEAR_DEADLINE - 0.5;
    return Math.min(H * 1.2, Math.max(a.v0 * 0.95, need, late ? H : 0));
  }

  /** Desired velocity filter: while the tram is near, the band edge acts like a kerb people do
   *  not step over (they slow their sideways approach to zero at it). Crossers that were let
   *  through and people clearing are exempt. */
  filterDesired(a, out) {
    if (a.clearing || out.vd === 0 || a.crossOK > this.c.time) return;
    this._cabKerb(a, out);
    // the same kerb at the band of an oncoming unit
    const T = a.uI >= 0 ? this.unitById(a.uI) : null;
    if (!T) return;
    const dg = a.d - T.d, gap = dg >= 0 ? dg - a.extLo - T.UB : -dg - a.extHi - T.UB;
    if (gap < 0 || gap > 2.5) return;
    const sgn = a.d > T.d ? -1 : 1;                 // d direction towards its band
    const toward = sgn * out.vd;
    if (toward <= 0) return;
    const kerb = 0.04 + Math.min(1, T.v / 3) * Math.max(0, T.pass - T.UB - 0.25);
    const lim = Math.max(0, (gap - kerb) * 1.6);
    if (toward > lim) out.vd = sgn * lim;
  }

  _cabKerb(a, out) {
    const dl = a.d - RIDE_D;
    // distance of the footprint's near edge, in body-centre terms (|dl| for a plain body)
    // (footBandGap(a) + BAND written out)
    const adl = a.mob ? (dl >= 0 ? dl - a.extLo : -dl - a.extHi) : Math.abs(dl);
    if (adl < BAND || adl > BAND + 2.5) return;
    const ahead = a.s - this.trainU;
    if (!a.pair) { this.front(a); if (ahead < -(TRAM_LEN + 3) || ahead > a.front + 3) return; }
    const toward = -Math.sign(dl) * out.vd;      // > 0: moving towards the band
    if (toward <= 0) return;
    // a moving tram is given a comfortable berth; beside a standing one the band edge will do
    const kerb = BAND + 0.04 + Math.min(1, this.v / 3) * Math.max(0, this.passD - BAND - 0.25);
    const lim = Math.max(0, (adl - kerb) * 1.6);
    if (toward > lim) out.vd = -Math.sign(dl) * lim;
  }

  /** After integration: never let anyone into the band inside the zone; hard guarantee for the swept volume.
   *  The lateral position before this step and the step's dt come from the agent's fields a.prevD /
   *  a.stepDt: a double handed to a call that is not inlined is boxed (garbage per agent and frame). */
  constrain(a) {
    this._cabRescue = false;
    this._cabConstrain(a);
    if (this.units.length) this._uConstrain(a);
  }

  _cabConstrain(a) {
    const prevD = a.prevD;
    const dl = a.d - RIDE_D;
    // (footInBand(a) written out)
    if (a.mob ? !(dl + a.extHi > -BAND && dl - a.extLo < BAND) : Math.abs(dl) >= BAND) return;
    const ahead = a.s - this.trainU;
    this.front(a);
    const inZone = ahead > -(TRAM_LEN + 2) - a.extS && ahead < Math.max(a.front - 4, SWEPT_AHEAD + 2) + a.extS;
    const dlp = prevD - RIDE_D;
    const wasOut = a.mob ? (dlp >= 0 ? dlp - a.extLo - BAND : -dlp - a.extHi - BAND) >= -1e-4 : Math.abs(dlp) >= BAND - 1e-4;
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
      this._cabRescue = true;
      if (this.rescueLog.length < 12) this.rescueLog.push({ slot: a.slot, t: +this.c.time.toFixed(1), ahead: +ahead.toFixed(1), dl: +dl.toFixed(2), pd: +(prevD - RIDE_D).toFixed(2), st: a.state, task: a.task, step: a.step, kind: a.kind, mob: a.mob, clr: a.clearing, lead: !!a.leader });
      // out through the nearer edge (beside a platform: up onto its edge), never across the track,
      // and never into the body of an oncoming unit beside it
      let hi = dl >= 0;
      if (!hi && this.unitNearA(a, 10)) hi = true;
      if (hi && !a.noRect && this.c.map.platformAt(a.s, 1, BAND_HI + 0.05, 0.35)) { a.platformOK = true; a.platSt = this.c.map.stationAt(a.s); a.platSide = 1; }
      a.d = hi ? BAND_HI + 0.01 + a.extLo : BAND_LO - 0.01 - a.extHi;
      a.vd = 0;
    }
  }

  /** Would turning a person with a stroller / bicycle to `alpha` swing the prop into the band
   *  inside the tram's zone (when it is out of it now)? */
  turnBlocked(a, alpha) { a.tryA = alpha; return this.turnBlockedA(a); }
  /** turnBlocked for the facing in a.tryA (the per-frame callers: no number argument to box). */
  turnBlockedA(a) {
    const alpha = a.tryA;
    if (!a.mob || a.crossOK > this.c.time) return false;
    const ahead = a.s - this.trainU;
    this.front(a);
    if (ahead < -(TRAM_LEN + 3) - 1 || ahead > Math.max(a.front, SWEPT_AHEAD + 2) + 2) return false;
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

  /** Emit at most one bell request every couple of seconds (sooner when it gets more urgent), and
   *  hand the cab's driver the nearest person it must brake for (its obstacle; Infinity: none). */
  flushRequests(app, time) {
    const tr = app.train, cab = tr && tr.tram;
    // (the crowd frame is the camera's: the driver measures from the cab front)
    if (tr && typeof tr.setObstacle === 'function') tr.setObstacle(this.obstacle, 'crowd');
    else if (cab && 'obstacle' in cab) cab.obstacle = this.obstacle;
    if (this.obstacle < 1e9 && !(this._obsWas < 1e9)) this.stats.cabBrake++;
    this._obsWas = this.obstacle;
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

/** An oncoming unit's tracker (fields fixed up front, see settleShape). */
function newTracker() {
  return settleShape({ i: 0, sU: 0, v: 0, acc: 0, len: 32, half: 1.325, d: 0, state: '', UB: 0, pass: 0, brakeAt: 0, reach: 0 }, new Set(['i']));
}

/** Does the sight line from (s0, d0, height h0) to (s1, d1, h1) pass through the box
 *  [sa, sb] × [da, db] below height top (before reaching its end point)? */
function rayThroughBox(s0, d0, h0, s1, d1, h1, sa, sb, da, db, top) {
  let t0 = 0, t1 = 0.97;
  const ds = s1 - s0, dd = d1 - d0;
  for (const [p, q, lo, hi] of [[s0, ds, sa, sb], [d0, dd, da, db]]) {
    if (Math.abs(q) < 1e-9) { if (p < lo || p > hi) return false; continue; }
    let a = (lo - p) / q, b = (hi - p) / q;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  // (the sight line enters the body below its roof)
  return h0 + (h1 - h0) * t0 < top;
}
