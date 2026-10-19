import { TRACK_ZONE_HALF, TRACK_OFFSET, RAIL_CENTER } from '../../core/config.js';
import { noise1 } from '../../core/rng.js';
import { ST, TASK, LANE, MOB, KIND, settleShape } from './agent.js';
import { RIDE_D, BAND, AGENT_R, CELL, GRID_D, CYCLE_V, WALKBIKE_V, TRAM_LEN, CYCLE_CLEAR_T, FOOT } from './constants.js';
import { footBandGap, footInBand, updateFoot, propPointDist2, propMoved } from './footprint.js';
import { startUturn, crossLight } from './behaviour.js';

// Cyclists in the shared pedestrian street. They ride 10-18 km/h in both directions, mostly
// along the edges of the track corridor, between the tracks and along the inner edge of a
// wide sidewalk. Every frame `rideTarget` picks the line to ride (the lane, a passing offset
// around slower people chosen from a handful of candidate lines, a lane change in progress,
// or the way out of the tram's band) and the speed (slowing behind people and groups when no
// line is free); steering.js follows it with a bicycle model. `thinkCycle` makes the slower
// decisions: lane changes and shallow street crossings (only through gaps in the poles and
// trees, and across the ride track only when the tram is far), turning into side streets,
// getting off to walk the bicycle through a crowd or a narrow stretch.
// The tram: a cyclist's line keeps clear of the ride track long before the tram arrives
// (their horizon is longer than a pedestrian's: they are faster), always towards the other
// track, since the pole line beside the ride track leaves no room for a bicycle.
// Grooved rails: riders keep their wheels out of the grooves. Riding lines stay at least
// RAIL_CLEAR from every rail (the gap between the tracks and the corridor edges are preferred
// to riding inside a track's gauge), and a line across a rail is reached with a short S-bend:
// slow down, swing away from the rail if there is no room to turn, then cross it at 45-50
// degrees (never a shallow angle that could trap the front wheel) and straighten out.
// A rider stopped for a few seconds with nobody in the way (wedged behind a kiosk, a café
// terrace across the sidewalk) gets off and walks the bicycle round it.

const PI = Math.PI;
const RAILS = [-TRACK_OFFSET - RAIL_CENTER, -TRACK_OFFSET + RAIL_CENTER, TRACK_OFFSET - RAIL_CENTER, TRACK_OFFSET + RAIL_CENTER];
const RAIL_CLEAR = 0.3;                     // riding lines keep the wheels this far from a rail
const VX = 2.4;                             // highest speed for crossing a rail (m/s)
const X_ANG = 0.82;                         // heading across a rail (rad from the street axis, ~47 deg)
const X_MIN = 0.72;                         // ... never crossed at less than this (~41 deg)
const WHEEL = 0.5;                          // wheel contact points ahead of / behind the rider's centre
const CORR_LO = -(TRACK_ZONE_HALF - 0.42);  // riding lines inside the corridor (clear of the platform edges)
const CORR_HI = TRACK_ZONE_HALF - 0.42;
const HALF = FOOT[MOB.CYCLE].r;             // half width of a bicycle with its rider (handlebar, elbows)
const NOSE = FOOT[MOB.CYCLE].f1 + HALF;     // front wheel ahead of the rider's centre
const NC = 9;                               // candidate lines for passing (spread around the lane line)
const cand = new Float32Array(NC), cost = new Float32Array(NC), blk = new Float32Array(NC), vblk = new Float32Array(NC);
const tmpBand = settleShape({ lo: 0, hi: 0 });
const LN = settleShape({ d: 0, lo: 0, hi: 0, narrow: false, uStop: false });
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** d moved out of the RAIL_CLEAR strip around any rail: to the nearer free side inside
 *  [lo, hi] (the side the rider is on, `here`, when both are as near). */
function offRail(d, lo = -99, hi = 99, here = d) {
  for (const r of RAILS) {
    if (Math.abs(d - r) >= RAIL_CLEAR) continue;
    const a = r - RAIL_CLEAR, b = r + RAIL_CLEAR;
    const aOk = a >= lo - 1e-6 && a <= hi + 1e-6, bOk = b >= lo - 1e-6 && b <= hi + 1e-6;
    if (aOk && bOk) return Math.abs(d - a) + (here > r ? 0.15 : 0) < Math.abs(d - b) + (here < r ? 0.15 : 0) ? a : b;
    return aOk ? a : bOk ? b : d;
  }
  return d;
}
/** Inside a track's gauge (between its two rails)? */
const inGauge = (d) => (d > RAILS[0] && d < RAILS[1]) || (d > RAILS[2] && d < RAILS[3]);
/** A riding line through d: inside the corridor [lo, hi], never along a track between its rails
 *  (there is no room to straighten out after crossing into a gauge; riders keep to the gap between
 *  the tracks and the corridor edges), and clear of the rails. */
export function rideLine(d, lo = CORR_LO, hi = CORR_HI) {
  d = clamp(d, lo, hi);
  if (freeLine(d, lo, hi)) return d;
  // the nearest free line: just outside a rail's strip, on the side away from its track
  let best = d, bd = 1e9;
  for (let i = 0; i < 8; i++) {
    const x = RAILS[i >> 1] + (i & 1 ? RAIL_CLEAR : -RAIL_CLEAR);
    if (freeLine(x, lo, hi) && Math.abs(x - d) < bd) { bd = Math.abs(x - d); best = x; }
  }
  return best;
}
function freeLine(x, lo, hi) {
  if (x < lo - 1e-6 || x > hi + 1e-6 || inGauge(x)) return false;
  for (const r of RAILS) if (Math.abs(x - r) < RAIL_CLEAR - 1e-6) return false;
  return true;
}
/** Rails strictly between d0 and d1 → number of them; _rx.first / _rx.last (in the direction of d1). */
const _rx = settleShape({ first: 0, last: 0 });
function railsBetween(d0, d1) {
  const lo = Math.min(d0, d1), hi = Math.max(d0, d1);
  let n = 0, first = 0, last = 0;
  for (const r of RAILS) {
    if (r <= lo || r >= hi) continue;
    if (!n || Math.abs(r - d0) < Math.abs(first - d0)) first = r;
    if (!n || Math.abs(r - d0) > Math.abs(last - d0)) last = r;
    n++;
  }
  _rx.first = first; _rx.last = last;
  return n;
}
/** Steering limits of a rider at speed v (turn rate rad/s); `tight` while crossing a rail. */
export function bikeTurnRate(v, tight) {
  const vv = Math.max(v, 0.6);
  return tight ? Math.min(2.6 / vv, vv / 1.5, 1.4) : Math.min(1.9 / vv, vv / 2.3, 1.3);
}
const smooth = (u) => u * u * (3 - 2 * u);
const wrapAngle = (x) => { x = (x + PI) % (2 * PI); if (x < 0) x += 2 * PI; return x - PI; };

// ------------------------------------------------------------------ lanes

/** A riding line: mostly along the edges of the track corridor and between the tracks, some
 *  along the inner edge of a sidewalk. prefer (±1) keeps it on one side of the street. */
export function pickRideLane(c, a, r, prefer = 0) {
  for (let k = 0; k < 6; k++) {
    const p = r.next();
    let lane = LANE.CORR, d = 0, side = a.side;
    // (each rider its own line across the free strip: no single 'bike lane')
    if (p < 0.33) d = CORR_LO + r.range(0, 0.33);                // the left edge of the corridor
    else if (p < 0.58) d = r.range(-0.52, 0.2);                  // between the tracks (clear of both rails)
    else if (p < 0.72) d = CORR_HI - r.range(0, 0.33);           // the right edge (moves over when the tram comes)
    else { lane = LANE.SIDE; side = prefer || (r.chance(0.5) ? 1 : -1); }
    // (on the ride side the corridor is also fine: its far half when the tram is near)
    if (prefer < 0 && lane === LANE.CORR && d > 0 && k < 5) continue;
    a.lane = lane;
    if (lane === LANE.CORR) { a.laneD = d; a.side = d >= 0 ? 1 : -1; }
    else { a.side = side; a.laneF = r.range(0.05, 0.8); }
    a.laneTT = 0;
    return;
  }
}

/** Is the tram close enough that this cyclist's line keeps off the ride track? (A longer
 *  horizon than the pedestrians', latched for a moment so the line does not flip.) */
export function rideNear(c, a, far = false) {
  const tram = c.tram;
  const ahead = a.s - tram.trainU;
  if (ahead < -(TRAM_LEN + 6)) return false;
  tram.front(a);
  const reach = a.front * 1.25 + 25 + (far ? 60 : 0);
  if (ahead < reach) { a.nearT = c.time + 3; return true; }
  return a.nearT > c.time;
}

/** The lane line at the cyclist (signed d) and the lateral room around it → LN. */
function laneLine(c, a) {
  const map = c.map, tram = c.tram;
  if (a.lane === LANE.CORR) {
    LN.d = a.laneD + 0.14 * noise1(a.s / 16, a.wSeed);
    LN.lo = CORR_LO; LN.hi = CORR_HI; LN.narrow = false;
  } else {
    const side = a.side;
    map.bandAhead(a.s - a.dir * 3, side, a.dir * 30, tmpBand);
    const w = tmpBand.hi - tmpBand.lo;
    LN.narrow = w < 1.3;
    const lo = tmpBand.lo + 0.32, hi = Math.max(lo, tmpBand.hi - 0.45);
    LN.d = side * (lo + clamp(w - 1.1, 0, 1.0) * a.laneF);
    LN.lo = side > 0 ? lo : -hi; LN.hi = side > 0 ? hi : -lo;
  }
  // the tram coming: keep to the far side of the ride track, out of its band early and with
  // a comfortable berth once it is close
  if (rideNear(c, a) && a.d < RIDE_D + BAND) {
    const ahead = a.s - tram.trainU;
    tram.front(a);
    const close = ahead > -(TRAM_LEN + 4) && ahead < a.front * 1.3 + 15;
    const lim = close ? RIDE_D - tram.passD - a.extHi - 0.12 : RIDE_D - BAND - a.extHi - 0.2;
    // pushed off the line between the tracks by a tram passing close: over to the far edge of
    // the corridor, rather than along the other track between its rails
    if (close && LN.d > lim && a.lane === LANE.CORR) LN.d = CORR_LO + 0.04 + 0.2 * ((a.wSeed & 255) / 255);
    LN.hi = Math.min(LN.hi, lim);
    if (LN.lo > LN.hi) LN.lo = LN.hi - 0.3;
  }
  // an oncoming unit coming: pull over between the tracks, right of its band (a rider on the
  // left of it, by the pole line, keeps there)
  LN.uStop = false;
  const U = tram.units.length ? tram.uZone(a, 30) : null;
  if (U && Math.abs(a.d) < TRACK_ZONE_HALF + 0.5) {
    const lim = U.d + U.UB + a.extLo + 0.12;
    if (a.d > U.d - U.UB - a.extHi - 0.3 || LN.d > U.d - U.UB) {
      LN.lo = Math.max(LN.lo, lim);
      if (LN.d < LN.lo) LN.d = LN.lo;
      // squeezed between both trams: nowhere to ride (rideTarget gets off)
      if (LN.lo > LN.hi) { LN.hi = LN.lo; LN.uStop = true; }
    }
  }
  LN.d = clamp(LN.d, LN.lo, LN.hi);
  if (Math.abs(LN.d) < TRACK_ZONE_HALF) LN.d = rideLine(LN.d, LN.lo, LN.hi);
  return LN;
}

// ------------------------------------------------------------------ per frame

/** Line and speed of this frame → T.d (signed d) or T.alpha (heading), T.v, T.ang, T.hard. */
export function rideTarget(c, a, T) {
  T.alpha = null; T.hard = false; T.ang = 0.42; T.avoid = 0;
  const dt = c.dt;
  let vT = a.v0 * (1 + 0.05 * noise1(c.time / a.paceT, a.wSeed + 11));
  if (a.state === ST.GOTO) { waypoint(c, a, T, vT); return; }
  laneLine(c, a);
  // between an oncoming unit and the cab tram in the corridor: off the bicycle, out on foot
  if (LN.uStop && footBandGap(a) < 0.8 && dismount(c, a, true, true)) { c.tally('cycleOffForUnit'); return; }
  let dL = LN.d, lo = LN.lo, hi = LN.hi, weave = true;
  if (a.mvOn && a.mvBand && !a.mvToBand) guardCrossing(c, a);
  if (a.mvOn) {
    const u = clamp((a.s - a.mvS0) / (a.mvS1 - a.mvS0), 0, 1);
    // a lane change towards the ride track is called off when the tram comes
    if (a.mvToBand && rideNear(c, a) && !(a.crossOK > c.time)) abortMove(c, a);
    else {
      // (a ramp over rails would run along them: the rail crossing takes the rider straight to
      // the new line instead, steeply)
      dL = railsBetween(a.d, a.mvD1) ? a.mvD1 : a.mvD0 + (a.mvD1 - a.mvD0) * smooth(u);
      lo = Math.min(dL, a.d) - 0.35; hi = Math.max(dL, a.d) + 0.35;
      weave = false;
      // steep enough to follow the ramp (its middle is 1.5 times the mean slope)
      T.ang = clamp(1.7 * Math.atan(Math.abs(a.mvD1 - a.mvD0) / Math.abs(a.mvS1 - a.mvS0)) + 0.1, 0.42, 0.8);
      if (u >= 1) finishMove(c, a);
    }
  }
  if (a.clearing && !(a.mvOn && a.crossOK > c.time)) {
    // out of the band, towards the other track (tram.js picked the side and the margin), to a
    // line clear of the rails: just out of the band if that is free of them, else past the rail
    let to = a.clearTo;
    if (Math.abs(to) < TRACK_ZONE_HALF) to = a.clearTo < a.d ? rideLine(to, CORR_LO, a.clearTo + 0.45) : rideLine(to, a.clearTo - 0.45, CORR_HI);
    // (not into the other track's gauge: just between the tracks, or on to the corridor's edge)
    if (to < a.d && to < RAILS[1] && to > RAILS[0]) to = RAILS[1] + RAIL_CLEAR + 0.05 <= RIDE_D - BAND - a.extHi - 0.05 ? RAILS[1] + RAIL_CLEAR + 0.05 : CORR_LO + 0.1;
    dL = to; T.ang = 0.62;
    if (to < a.d) { hi = Math.min(hi, to); lo = Math.min(lo, hi - 0.6); } else { lo = Math.max(lo, to); hi = Math.max(hi, lo + 0.6); }
    vT = Math.max(vT, 2.6);
  }
  // a sidewalk ahead too narrow for a bicycle, with no way over to the corridor: slow down to get
  // off and walk it through (thinkCycle found the spot)
  if (a.narrowS !== null) {
    const dist = (a.narrowS - a.s) * a.dir;
    if (dist < -2 || a.lane !== LANE.SIDE || a.mvOn) a.narrowS = null;
    else {
      // stop a few metres short of it, and get off there (the bicycle still fits beside the rider)
      vT = Math.min(vT, 0.9 * Math.max(0, dist - 2.8));
      if (dist < 6 && a.bikeV < 1.8 && dismount(c, a)) { c.tally('cycleNarrowWalk'); return; }
    }
  }
  // a stop ahead: nobody rides along the track bed between its platforms; get off short of it
  // and walk the bicycle along the platform (thinkCycle found the spot)
  if (a.stnS !== null) {
    const dist = (a.stnS - a.s) * a.dir;
    if (dist < -3 || Math.abs(a.d) > TRACK_ZONE_HALF + 0.3) a.stnS = null;
    else {
      vT = Math.min(vT, 0.9 * Math.max(0, dist - 2.5));
      if (dist < 7 && a.bikeV < 1.8 && dismount(c, a, dist < 3)) { a.stnS = null; c.tally('cycleStationWalk'); return; }
    }
  }
  // poles, trunks, bins: steered round (a lane change crosses the line of them)
  if (Math.abs(a.d) > TRACK_ZONE_HALF - 0.1) T.avoid = avoidFixed(c, a);
  if (a.simple) { T.d = Math.abs(a.d) < TRACK_ZONE_HALF && railsBetween(a.d, dL) && !a.clearing ? a.d : dL; T.v = vT; a.cT = T.d; return; }
  // passing: the candidate line with the least conflict, slowing behind whoever is in the way
  let best = scan(c, a, dL, lo, hi, weave ? (a.lane === LANE.SIDE ? 2.4 : 1.6) : 0.25);
  // every line near the lane blocked by a kiosk / terrace / bench: look wider for a way round
  if (blkStatic && blk[best] < 8 && vblk[best] === 0 && !a.clearing) best = scan(c, a, dL, lo, hi, 4.6);
  // held up by someone in the corridor with no free line beside the rails (two riders meeting on
  // the corridor's edge): a line between the rails of a track, crossed into steeply, gets by
  else if (weave && a.lane === LANE.CORR && blk[best] < 2.5 + a.bikeV && !a.clearing && !inGauge(dL)) {
    const b0 = blk[best];
    const b1 = scan(c, a, dL, lo, hi, 2.0, true);
    if (blk[b1] > b0 + 1.5) best = b1; else best = scan(c, a, dL, lo, hi, weave ? 1.6 : 0.25);
  }
  T.d = cand[best];
  a.cT = T.d;
  // another rider level with this one on a parallel line, with people about: single file
  // (the one level or behind drops back)
  const nb = riderBeside(c, a);
  if (nb) { vT = Math.min(vT, Math.max(0.8, nb.bikeV - 0.6)); c.tally('cycleSingleFile'); }
  // a lane change running into a bench or a trunk: called off, back to the old line
  if (a.mvOn && blk[best] < 2.5 && vblk[best] === 0 && blkStatic && !(a.crossOK > c.time)) { abortMove(c, a); c.tally('cycleMoveBlocked'); }
  if (blk[best] < 1e8) {
    const gap = blk[best];
    const vF = vblk[best] + Math.max(0, gap - 0.8) * 0.9;
    if (vF < vT) vT = vF;
    if (gap < 0.45) T.hard = true;
  }
  // a crowd around: slower, more careful
  vT *= Math.max(0.55, 1 - 0.045 * scanCrowd);
  // turning across: a little slower
  vT *= 1 - 0.18 * Math.min(1, Math.abs(T.d - a.d) / 2);
  // inside the band on a crossing, or getting out of it for the tram: on briskly (people step
  // aside for a bicycle; only someone right in front stops it)
  if (((a.mvOn && a.crossOK > c.time) || a.clearing) && footBandGap(a) < 0.3 && !T.hard) vT = Math.max(vT, Math.min(a.v0, 2.4));
  T.v = Math.max(0, vT);
  // grooved rails: crossed steeply, after a swing away from the rail when there is no room
  railGuard(c, a, T, a.mvOn ? a.mvD1 : T.d);
  // held to walking pace for a while: get off and walk (if the figures can show it)
  if (vT < 1.3 && !a.clearing) a.slowT += dt; else a.slowT = Math.max(0, a.slowT - 2 * dt);
  if (a.slowT > 1.8 && !(a.crossOK > c.time) && !a.mvOn && a.rx === 0) dismount(c, a);
  if (a.mob !== MOB.CYCLE) return;
  // wedged (a pole, a crowd) next to the ride track with the tram coming: off, and walk it out
  if (a.bikeV < 0.3 && T.v < 0.5) a.stallT = (a.stallT || 0) + dt; else a.stallT = 0;
  if (a.stallT > 1.2 && footBandGap(a) < 0.8 && rideNear(c, a)) { dismount(c, a, true); if (a.mob !== MOB.CYCLE) return; }
  stalled(c, a, dt);
}

/** Stopped with nobody in the way (wedged behind a kiosk, a terrace across the sidewalk, a pole
 *  on the other side): after a couple of seconds get off and walk the bicycle round it. */
function stalled(c, a, dt) {
  if (a.bikeV >= 0.1) { a.stopT = 0; a.stopNP = 0; a.stallTry = 0; a.askT = 0; a.stallSeen = false; return; }
  a.stopT += dt;
  if (a.stopT < 0.8 || a.state !== ST.WALK) return;
  // held up by people standing in the way: they notice the waiting bicycle and make room
  if (a.stopT > 2.5 && a.stopT - a.askT > 4) { a.askT = a.stopT; askWay(c, a); }
  // nobody in the way: the counter runs; someone passing through the look-ahead only holds it
  if (!peopleAhead(c, a, 4.5, 1.4) && !(a.waitX > c.time)) a.stopNP += dt;
  if (a.stopNP > 5 && !a.stallSeen) { a.stallSeen = true; c.tally('cycleStall5s'); }
  // wedged with nobody in the way for a couple of seconds, or held up for long anyway (a crowd
  // standing round a bench): get off, and walk the bicycle round it
  if ((a.stopNP < 2.2 && a.stopT < 7) || (a.stopT - a.stallTry) < 1) return;
  a.stallTry = a.stopT;
  if (dismount(c, a, true)) { c.tally('cycleUnstick'); return; }
  // wedged by fixed things with no room to put the bicycle down beside the rider: get off anyway
  // (the bicycle is walked clear of what it touches) and turn it round, back the way they came
  if (a.stopNP >= 2.2 && a.stopT > 4 && dismount(c, a, true, true)) { startUturn(c, a); c.tally('cycleTurnBack'); }
}

/** People standing or dawdling in front of a waiting rider step aside from its line for a few
 *  seconds. */
function askWay(c, a) {
  const st = c.steering, agents = c.population.agents, cs = Math.cos(a.alpha), sn = Math.sin(a.alpha), r = c.rng;
  const ix0 = Math.max(0, Math.floor((a.s - 5 - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((a.s + 5 - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((a.d - 5 + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((a.d + 5 + GRID_D) / CELL));
  let n = 0;
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a || b.mob || b.state === ST.SEATED || b.kind === KIND.PASSENGER || b.clearing) continue;
        const ds = b.s - a.s, dd = b.d - a.d;
        const xa = ds * cs + dd * sn, ya = -ds * sn + dd * cs;
        if (xa < -0.3 || xa > 4.5 || Math.abs(ya) > 1.4) continue;
        // away from the rider's line: the d-direction of its left / right
        const away = (ya >= 0 ? 1 : -1) * (cs >= 0 ? 1 : -1);
        b.dodge = away * r.range(0.5, 0.8); b.dodgeT = c.time + r.range(2.5, 4); b.dodgeD0 = b.d;
        n++;
      }
    }
  }
  if (n) c.tally('cycleAskWay');
}

/** A rider level with a (or just ahead) on a parallel line within 1.2 m, riding the same way,
 *  while pedestrians are within 10 m: the one a should drop in behind, else null. */
function riderBeside(c, a) {
  const st = c.steering, agents = c.population.agents, dir = a.dir;
  const ix0 = Math.max(0, Math.floor((a.s - 10 - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((a.s + 10 - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((a.d - 4 + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((a.d + 4 + GRID_D) / CELL));
  let rider = null, people = false;
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a || !b.active) continue;
        if (b.mob !== MOB.CYCLE) { if (b.state !== ST.SEATED) people = true; continue; }
        if (b.dir !== dir || b.state !== ST.WALK) continue;
        const xb = (b.s - a.s) * dir, dd = Math.abs(b.d - a.d);
        if (dd > 1.2 || dd < 0.2 || xb < -0.5 || xb > 2.2) continue;
        if (xb < 0.5 && a.slot < b.slot) continue;     // level: the other one yields
        rider = b;
      }
    }
  }
  return people ? rider : null;
}

/** Is anybody within `look` metres ahead of the rider (along its heading), `lat` to either side? */
function peopleAhead(c, a, look, lat) {
  const st = c.steering, agents = c.population.agents, cs = Math.cos(a.alpha), sn = Math.sin(a.alpha);
  const ix0 = Math.max(0, Math.floor((a.s - look - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((a.s + look - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((a.d - look + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((a.d + look + GRID_D) / CELL));
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a) continue;
        const ds = b.s - a.s, dd = b.d - a.d;
        const xa = ds * cs + dd * sn, ya = -ds * sn + dd * cs;
        if (xa > -0.3 && xa < look && Math.abs(ya) < lat) return true;
      }
    }
  }
  return false;
}

/** Rails between the rider and where it is heading (line or waypoint dGoal): ridden over at a
 *  steep angle. a.rx: 0 nothing to cross, 1 swinging away from the rail first (no room to turn
 *  steeply), 2 crossing (heading held across until past the last rail). Overrides T. */
function railGuard(c, a, T, dGoal) {
  if (a.simple) { a.rx = 0; return; }
  const v = a.bikeV;
  // astride a rail (one wheel on each side): always on across it, steeply, the way it is heading
  if (a.rx !== 2 && v > 0.05) {
    const sa = WHEEL * Math.sin(a.alpha), fw = a.d + sa, rw = a.d - sa;
    for (const r of RAILS) {
      if ((fw - r) * (rw - r) >= 0) continue;
      const sgn = sa > 0 ? 1 : -1;
      a.rxSgn = sgn; a.rxFirst = r; a.rxEnd = r + sgn * (WHEEL * Math.sin(X_ANG) + 0.1); a.rxV = VX;
      startCross(a, c, T, 'astride');
      return;
    }
  }
  if (a.rxHold > c.time) { a.rx = 0; return; }
  if (a.rx === 3) {
    // straightening out after the crossing (tight and slow, so the turn back does not reach the next
    // rail); a goal back across a rail is dealt with below like any other
    a.rxT += c.dt;
    if (Math.abs(Math.sin(a.alpha)) < 0.12 || a.rxT > 1.6) a.rx = 0;
    else if (!railsBetween(a.d, dGoal)) { T.v = Math.min(T.v, a.rxV + 0.2); return; }
  }
  if (a.rx === 2) {
    // both wheels over the last rail: straighten out
    if ((a.d - a.rxEnd) * a.rxSgn >= 0 || a.state === ST.GOTO && Math.abs(a.d - a.gd) < 0.3) { a.rx = 3; a.rxT = 0; rebaseMove(a); return; }
    // (it can be called off only while the front wheel is short of the first rail: a rider stopped
    // with the wheels over the rails goes on across at the same angle)
    const before = (a.rxFirst - (a.d + WHEEL * Math.abs(Math.sin(a.alpha)) * a.rxSgn)) * a.rxSgn > 0.05;
    // the goal moved back to this side: called off
    if (before && (dGoal - a.d) * a.rxSgn < 0) { a.rx = 0; return; }
    // held up for long (people in the way, or the edge of the tram's band): called off for a moment
    const atBand = a.rxSgn * (RIDE_D - a.d) > 0 && footBandGap(a) < 0.06 && c.tram.near(a) && !(a.crossOK > c.time);
    if (v < 0.4 || atBand) a.rxT += c.dt; else a.rxT = 0;
    if (before && a.rxT > (atBand ? 0.3 : 1.5)) { a.rx = 0; a.rxHold = c.time + 2; return; }
    crossHeading(c, a, T);
    return;
  }
  const n = Math.abs(a.d) < TRACK_ZONE_HALF + 0.5 || Math.abs(dGoal) < TRACK_ZONE_HALF ? railsBetween(a.d, dGoal) : 0;
  if (!n) { if (a.rx === 1 && (a.rxT -= c.dt) > 0) { holdSetup(a, T); return; } a.rx = 0; return; }
  if (a.rx !== 1) a.rxSetupT = 0;
  const sgn = dGoal > a.d ? 1 : -1, first = _rx.first;
  const dist = (first - a.d) * sgn;
  a.rxSgn = sgn; a.rxFirst = first; a.rxEnd = _rx.last + sgn * (WHEEL * Math.sin(X_ANG) + 0.1);
  // room on this side of the rail for the S-bend: up to the corridor edge, short of the next rail
  // behind, and out of the ride track's band while the tram is near
  let lim = sgn > 0 ? CORR_LO : CORR_HI;
  for (const r of RAILS) if ((r - a.d) * sgn < 0 && Math.abs(r - a.d) < Math.abs(lim - a.d)) lim = r + sgn * RAIL_CLEAR;
  if (sgn < 0 && a.d < RIDE_D - BAND && rideNear(c, a)) lim = Math.min(lim, RIDE_D - BAND - a.extHi - 0.05);
  const room = Math.max(dist, (first - lim) * sgn);
  // a speed at which a steep turn fits into that room, reached before the rail
  const vX = crossSpeed(room) + (a.clearing ? 0.3 : 0);
  a.rxV = vX;
  T.v = Math.min(T.v, vX + 0.8 * Math.max(0, dist - turnRoom(vX, 0)));
  // heading towards the rail now (rad from the street axis, + = towards it), less what it will
  // still turn away while the turn rate reverses
  let lat = Math.atan2(Math.sin(a.alpha) * sgn, Math.abs(Math.cos(a.alpha)));
  const wAway = Math.max(0, -a.yawW * sgn * (a.dir > 0 ? 1 : -1));
  lat -= (wAway * wAway) / (2 * 5.0);
  const slowEnough = v <= vX + 0.3;
  // (never into people: wait short of the rail until the way across is clear)
  // (getting out of the tram's way does not wait: people step aside, and whoever is right in
  // front still stops the bicycle)
  const wayFree = a.clearing || crossFree(c, a, sgn);
  if (!wayFree) {
    T.v = Math.min(T.v, 0.9 * Math.max(0, dist - 0.6)); a.waitX = c.time + 0.3;
    // a lane change held up like this for a while is given up: on along the present line
    if (a.mvOn && (a.waitXT += c.dt) > 1.6) { a.waitXT = 0; abortMove(c, a); a.rx = 0; return; }
  } else a.waitXT = 0;
  if (wayFree && (lat >= X_MIN || slowEnough && dist >= turnRoom(Math.max(v, vX), lat))) { startCross(a, c, T, lat >= X_MIN ? 'steep' : 'room'); return; }
  // the S-bend: swing away from the rail to where the steep turn fits
  let away = first - sgn * turnRoom(vX, 0);
  away = sgn > 0 ? Math.max(away, lim) : Math.min(away, lim);
  const there = (a.d - away) * sgn <= 0.08;
  // as far away as it goes (or tried for long enough): cross from here once slow enough
  if (wayFree && (there || a.rx === 1 && a.rxSetupT > 3) && slowEnough) { startCross(a, c, T, there ? 'there' : 'timeout'); return; }
  a.rx = 1; a.rxSetup = there ? a.d : away; a.rxT = 0.6; a.rxSetupT += c.dt;
  holdSetup(a, T);
}
/** Lateral room (from the rider's centre to the rail) a rider at speed v with heading lat (rad
 *  towards the rail) needs so that both wheels cross at X_MIN or more: the rear wheel crosses
 *  along the heading, once the centre is WHEEL·sin(heading) past the rail; the front wheel,
 *  steered into the turn, crosses steeper than the heading (a little room for it still). */
function turnRoom(v, lat) {
  const vv = Math.max(v, 1.0), R = vv / bikeTurnRate(vv, true);
  return Math.max(0.3, R * Math.max(0, Math.cos(Math.min(lat, X_MIN)) - Math.cos(X_MIN)) - WHEEL * Math.sin(X_MIN) + 0.2);
}
/** Fastest speed (≤ VX) at which a steep turn fits into `room`. */
function crossSpeed(room) {
  let v = VX;
  while (v > 1.2 && turnRoom(v, 0) > room) v -= 0.1;
  return v;
}
function startCross(a, c, T, why) {
  a.rx = 2; a.rxT = 0; a.rxWhy = why;
  c.tally('cycleRailCross');
  crossHeading(c, a, T);
}
/** Nobody on the way across (a strip X_ANG from the street axis towards sgn, a few metres long)? */
function crossFree(c, a, sgn) {
  const st = c.steering, agents = c.population.agents;
  const th = a.dir > 0 ? sgn * X_ANG : PI - sgn * X_ANG, cs = Math.cos(th), sn = Math.sin(th);
  const ix0 = Math.max(0, Math.floor((a.s - 4.5 - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((a.s + 4.5 - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((a.d - 4.5 + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((a.d + 4.5 + GRID_D) / CELL));
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a) continue;
        const ds = b.s - a.s, dd = b.d - a.d;
        const xa = ds * cs + dd * sn, ya = -ds * sn + dd * cs;
        if (xa > 0 && xa < 2.8 && Math.abs(ya) < 0.65 + (b.mob ? 0.45 : 0)) return false;
      }
    }
  }
  return true;
}
function holdSetup(a, T) {
  T.alpha = null; T.d = a.rxSetup; T.ang = Math.max(T.ang, 0.42);
  T.v = Math.min(T.v, a.rxV + 0.2);
}
/** Ride across: a heading of X_ANG from the street axis towards the far side. */
function crossHeading(c, a, T) {
  const dir = a.dir, sgn = a.rxSgn;
  T.alpha = dir > 0 ? sgn * X_ANG : PI - sgn * X_ANG;
  T.avoid = 0;
  T.v = Math.min(T.v, a.rxV + 0.2);
  const b = brakeAhead(c, a);
  if (b < 1e8) { T.v = Math.min(T.v, Math.max(0, b - 0.8) * 0.9); if (b < 0.45) T.hard = true; }
}
/** A lane change interrupted by a rail crossing goes on from where the rider is. */
function rebaseMove(a) {
  if (!a.mvOn) return;
  const left = (a.mvS1 - a.s) * a.dir;
  if (left < 1.5) return;
  a.mvS0 = a.s; a.mvD0 = a.d;
}

/** Into / out of a side street: ride towards a point. */
function waypoint(c, a, T, vT) {
  const k = a.inSide ? 1 : Math.max(0.5, 1 + c.route.curvature(a.s) * a.d);
  const es = (a.gs - a.s) * k, ed = a.gd - a.d, dist = Math.sqrt(es * es + ed * ed);
  if (dist < a.gTol) { arriveRide(c, a); T.d = a.d; T.v = Math.min(vT, 2.5); return; }
  T.alpha = Math.atan2(ed, es);
  T.avoid = avoidFixed(c, a);
  // crossing the ride track on the way into a side street: committed until out of the band
  if (a.crossOK > c.time - 0.5 && footBandGap(a) < 0.2) a.crossOK = Math.max(a.crossOK, c.time + 1.5);
  const err = Math.abs(wrapAngle(T.alpha - a.alpha));
  T.v = Math.min(vT, 2.2 + 0.35 * dist) * Math.max(0.55, Math.cos(Math.min(1.4, err)));
  // anyone right in front: brake
  const b = brakeAhead(c, a);
  if (b < 1e8) { T.v = Math.min(T.v, Math.max(0, b - 0.8) * 0.9); if (b < 0.45) T.hard = true; }
  a.cT = a.d;
  railGuard(c, a, T, a.gd);
}

/** Heading correction (rad) around a bollard / pole / trunk in the bicycle's way. */
function avoidFixed(c, a) {
  const map = c.map, cs = Math.cos(a.alpha), sn = Math.sin(a.alpha);
  const look = 2.5 + 1.2 * a.bikeV;
  const n = map.gatherCircles(a.s + cs * look * 0.5, look * 0.5 + 0.5);
  let turn = 0, best = 1e9;
  for (let q = 0; q < n; q++) {
    const i = map.qI[q];
    const ds = map.qDS[q] + cs * look * 0.5, dd = map.cD[i] - a.d;   // relative to the rider
    const x = ds * cs + dd * sn, y = -ds * sn + dd * cs;              // along / to the right
    const need = map.cR[i] + HALF + 0.3;
    if (x < 0 || x > look || Math.abs(y) > need || x > best) continue;
    best = x;
    // pass on the side it is not on, harder the closer it is
    turn = (y > 0 ? -1 : 1) * Math.min(0.7, ((need - Math.abs(y)) / need) * (1.4 - x / look));
  }
  return turn;
}

/** Is the straight way from (s0, d0) to (s1, d1) clear of fixed obstacles for a bicycle? */
export function wayClear(c, s0, d0, s1, d1, extra = 0.25) {
  const map = c.map;
  const n = Math.ceil(Math.hypot(s1 - s0, d1 - d0) / 0.7);
  for (let i = 0; i <= n; i++) {
    const u = i / n, ps = s0 + (s1 - s0) * u, pd = d0 + (d1 - d0) * u;
    const k = map.gatherCircles(ps, 0.9);
    for (let q = 0; q < k; q++) {
      const j = map.qI[q], ds = map.qDS[q], dq = map.cD[j] - pd, rr = map.cR[j] + HALF + extra;
      if (ds * ds + dq * dq < rr * rr) return false;
    }
  }
  return true;
}

/** Waypoint reached. */
function arriveRide(c, a) {
  const map = c.map, r = c.rng;
  if (a.task === TASK.SIDE_OUT) {
    const m = a.mouth, side = a.side, line = map.mouthLine(m, side);
    a.step++;
    // from about 15 m in, cars stand parked along both kerbs of the side street (furniture's
    // vehicles, 0.2-0.35 m off the kerb, up to 2 m wide): further in, up its middle
    const g = c.side.get(m, side), mid = Math.max(0, g.road - 2.6 - HALF);
    const deepX = Math.max(-mid, Math.min(mid, a.slotX));
    if (a.step >= 3) {
      if (c.side.hidden(a.s, a.d, 1.0) || c.vis.distance(a.s) > 150) { c.population.vanish(a); return; }
      a.gs = c.unwrap(m.s) + deepX; a.gd = side * (line + 18); a.gTol = 0.8;
      return;
    }
    a.gs = c.unwrap(m.s) + (a.step >= 2 ? deepX : a.slotX); a.gd = side * (line + 4 + a.step * 6); a.gTol = 0.9;
    return;
  }
  // out of a side street: on along a lane of this side (the turn onto it is the bicycle model's)
  a.state = ST.WALK; a.task = TASK.NONE; a.step = 0;
  const side = a.d >= 0 ? 1 : -1;
  pickRideLane(c, a, r, side);
  const ln = laneLine(c, a);
  if (!planMove(c, a, ln.d, null)) { a.lane = LANE.SIDE; a.side = side; a.laneF = r.range(0.05, 0.5); }
}

let scanCrowd = 0;      // people close around the rider (last scan)
let _rq0 = null, _rq1 = null; // rects already scored by this scan (both lookups may return them)
let blkStatic = false;  // the middle line is blocked by a fixed obstacle (last scan)
const off = new Float32Array(NC);
/** Lateral position of the path (lane line or lane-change ramp) x metres ahead. */
function pathAt(a, x, dL) {
  if (!a.mvOn) return dL;
  const u = clamp((a.s + a.dir * x - a.mvS0) / (a.mvS1 - a.mvS0), 0, 1);
  return a.mvD0 + (a.mvD1 - a.mvD0) * smooth(u);
}

/** Scores the candidate lines (offsets from the path, clamped to [lo, hi] here) against the
 *  people and fixed obstacles ahead; returns the best index (blk / vblk: nearest conflict on
 *  each line and its speed along our way). */
function scan(c, a, dL, lo, hi, spread, gauge = false) {
  const st = c.steering, agents = c.population.agents, map = c.map;
  const v = Math.max(a.bikeV, 1.2), dir = a.dir;
  const look = 4 + 2.6 * v;
  blkStatic = false;
  const nL = Math.abs(a.d) < TRACK_ZONE_HALF + 1 ? railsBetween(a.d, dL) : 0;
  for (let i = 0; i < NC; i++) {
    let dc = clamp(dL + ((i - (NC - 1) / 2) / ((NC - 1) / 2)) * spread, lo, hi);
    // (lines in the corridor: clear of the rails, and along a track only if the lane is there)
    // (passing someone it cannot get by otherwise, a line along a track will do)
    if (Math.abs(dc) < TRACK_ZONE_HALF) dc = inGauge(dL) || gauge ? offRail(dc, lo, hi, a.d) : rideLine(dc, lo, hi);
    cand[i] = dc; off[i] = dc - dL;
    // stay near the lane line, and near the line already chosen (no dithering)
    cost[i] = 0.5 * Math.abs(dc - dL) + 0.7 * Math.abs(dc - a.cT);
    // wheels out of the rail grooves, and no extra rail crossings just to pass someone
    if (Math.abs(dc) < TRACK_ZONE_HALF) {
      for (const r of RAILS) if (Math.abs(dc - r) < RAIL_CLEAR) cost[i] += 1.6 * (1 - Math.abs(dc - r) / RAIL_CLEAR) + 0.4;
      cost[i] += 2.0 * Math.abs(railsBetween(a.d, dc) - nL);
      if (inGauge(dc) && !inGauge(dL)) cost[i] += 2.0;
    }
    blk[i] = 1e9; vblk[i] = 0;
  }
  const clr = HALF + 0.12 + 0.035 * v;
  const sA = dir > 0 ? a.s - 1.5 : a.s - look, sB = dir > 0 ? a.s + look : a.s + 1.5;
  const pEnd = pathAt(a, look, dL);
  const dA = Math.min(lo, a.d, pEnd + off[0]) - 1.4, dB = Math.max(hi, a.d, pEnd + off[NC - 1]) + 1.4;
  const ix0 = Math.max(0, Math.floor((sA - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((sB - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((dA + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((dB + GRID_D) / CELL));
  let crowd = 0;
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a) continue;
        const xb = (b.s - a.s) * dir;
        if (xb < -1.2 || xb > look) continue;
        if (xb > -1 && xb < 7 && Math.abs(b.d - a.d) < 2.2) crowd++;
        const vbx = b.vs * dir, closing = v - vbx;
        if (closing < 0.25 && xb > 1.6) continue;          // keeping ahead of us anyway
        let blo = b.d - AGENT_R, bhi = b.d + AGENT_R;
        if (b.mob) { blo -= b.extLo; bhi += b.extHi; }
        // where they will be when we get there (sideways motion widens their interval that way)
        const t = closing > 0.25 ? Math.min(2.5, Math.max(0, xb - 1) / closing) : 0;
        const sh = b.vd * Math.min(t, 1.5);
        if (sh < 0) blo += sh; else bhi += sh;
        const xe = xb - (b.mob ? b.extS : 0) - NOSE;      // from our front wheel
        const w = 3.2 / (1 + 0.3 * Math.max(0, xe));
        // (people beside the rider are steered clear of, braking would not help)
        const ahead = xb > 0.35;
        const p = xb > 0.3 ? pathAt(a, xb, dL) : dL;
        for (let i = 0; i < NC; i++) {
          const dc = p + off[i];
          if (dc + clr > blo && dc - clr < bhi) {
            cost[i] += w;
            if (ahead && xe < blk[i]) { blk[i] = Math.max(0, xe); vblk[i] = Math.max(0, vbx); }
          }
        }
      }
    }
  }
  // fixed obstacles near the lines (benches, bins, trunks along the sidewalk edge)
  const sm = (sA + sB) / 2;
  const n = map.gatherCircles(sm, (sB - sA) / 2 + 0.5);
  for (let q = 0; q < n; q++) {
    const i0 = map.qI[q];
    const od = map.cD[i0], r = map.cR[i0];
    if (od + r < dA || od - r > dB) continue;
    const xb = (map.qDS[q] + sm - a.s) * dir;
    if (xb < -1.2 || xb > look) continue;
    const xe = xb - r - NOSE, w = 3.2 / (1 + 0.3 * Math.max(0, xe));
    const p = xb > 0.3 ? pathAt(a, xb, dL) : dL;
    for (let i = 0; i < NC; i++) {
      const dc = p + off[i];
      if (dc + HALF + 0.2 > od - r && dc - HALF - 0.2 < od + r) {
        cost[i] += w * 1.5;
        if (xb > 0 && xe < blk[i]) { blk[i] = Math.max(0, xe); vblk[i] = 0; if (i === (NC - 1) / 2) blkStatic = true; }
      }
    }
  }
  // café terraces (and platforms) across the lines: walls, like the fixed obstacles
  const sideR = dL >= 0 ? 1 : -1;
  for (let e = 0; e < 2; e++) {
    const nr = map.rectsNear(a.s + dir * (e ? look - 3 : 3), sideR);
    for (let q = 0; q < nr; q++) {
      const R = map.rq[q];
      if (R === _rq0 || R === _rq1) continue;
      if (!_rq0) _rq0 = R; else _rq1 = R;
      map.rectDSA(R, a);
      const ds0 = map.R[2];                                 // a.s from the rect's start
      const x0 = dir > 0 ? -ds0 : ds0 - R.len, x1 = dir > 0 ? R.len - ds0 : ds0;
      if (x1 < -1.2 || x0 > look) continue;
      const xe = Math.max(0, x0) - NOSE, w = 3.2 / (1 + 0.3 * Math.max(0, xe));
      for (let i = 0; i < NC; i++) {
        const ad = cand[i] * sideR;
        if (ad + HALF + 0.12 < R.inner || ad - HALF - 0.12 > R.outer) continue;
        cost[i] += w * 1.5;
        if (x1 > 0.3 && xe < blk[i]) { blk[i] = Math.max(0, xe); vblk[i] = 0; if (i === (NC - 1) / 2) blkStatic = true; }
      }
    }
  }
  _rq0 = null; _rq1 = null;
  scanCrowd = crowd;
  // a line blocked within the stopping distance is a poor choice
  const stop = 0.6 + (a.bikeV * a.bikeV) / 3.0;
  let best = 0, bc = 1e9;
  for (let i = 0; i < NC; i++) {
    const cc = cost[i] + (blk[i] < stop ? 6 : 0);
    if (cc < bc) { bc = cc; best = i; }
  }
  return best;
}

/** Nearest person in the bicycle's way along its heading (distance from the front wheel) or 1e9. */
function brakeAhead(c, a) {
  const st = c.steering, agents = c.population.agents, cs = Math.cos(a.alpha), sn = Math.sin(a.alpha);
  const look = 3 + 2 * a.bikeV;
  const ix0 = Math.max(0, Math.floor((a.s - look - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((a.s + look - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((a.d - look + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((a.d + look + GRID_D) / CELL));
  let best = 1e9;
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a) continue;
        const ds = b.s - a.s, dd = b.d - a.d;
        const xa = ds * cs + dd * sn, ya = -ds * sn + dd * cs;
        if (xa < 0 || xa > look || Math.abs(ya) > 0.75) continue;
        if (xa - NOSE < best) best = xa - NOSE;
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ lane changes

/** Plan a lane change from the present line to dTo along a shallow ramp, through a gap in the
 *  poles and trees and across the ride track only when the tram is far. The new lane (the
 *  agent's lane fields at call time, set by the caller) takes over at the end. */
export function planMove(c, a, dTo, old = null) {
  const map = c.map, tram = c.tram, r = c.rng;
  const dd = dTo - a.d;
  const lane = { lane: a.lane, laneD: a.laneD, side: a.side, laneF: a.laneF };
  if (Math.abs(dd) < 0.25) { a.mvOn = false; return true; }
  // not into (or across) an oncoming unit's band while one is coming
  const U = tram.units.length ? tram.uZone(a, 60) : null;
  if (U && (Math.abs(dTo - U.d) < U.UB + 0.4 || (a.d - U.d) * (dTo - U.d) < 0)) return false;
  const toBand = Math.abs(dTo - RIDE_D) < BAND + 0.5;
  // across the ride track: a steeper line (less time in the band)
  const across = !toBand && (a.d - RIDE_D) * (dTo - RIDE_D) < 0;
  const tgs = across ? [0.42 + r.range(0, 0.08), 0.56] : [0.2 + r.range(0, 0.06), 0.33];
  for (const start of [1.5, 5, 9, 14]) {
    for (const tg of tgs) {
      const len = Math.max(6, Math.abs(dd) / tg);
      const s0 = a.s + a.dir * start, s1 = s0 + a.dir * len;
      let ok = true, bIn = null, bOut = null;
      const n = Math.ceil(len / 0.8);
      for (let i = 0; i <= n && ok; i++) {
        const u = i / n, ps = s0 + (s1 - s0) * u, pd = a.d + dd * smooth(u);
        const side = pd >= 0 ? 1 : -1, ad = Math.abs(pd);
        const m = map.gatherCircles(ps, 1.0);
        for (let q = 0; q < m; q++) {
          const k = map.qI[q], ds = map.qDS[q], dq = map.cD[k] - pd, rr = map.cR[k] + HALF + 0.4;
          if (ds * ds + dq * dq < rr * rr) { ok = false; break; }
        }
        if (!ok) break;
        if (map.rectInner(ps, side, ad, 0.5)) { ok = false; break; }
        if (ad > map.wallAt(ps, side) - 0.5 && !map.mouthAt(ps, side)) { ok = false; break; }
        // the poles and trees beside the ride track are passed only at a side street opening
        // (no stalling between the tram's band and the pole line)
        if (side > 0 && ad > TRACK_ZONE_HALF - 0.2 && ad < map.bandInAt(ps, 1) + 0.1 && map.facadeAt(ps, 1) < 90) { ok = false; break; }
        if (Math.abs(pd - RIDE_D) < BAND + 0.5) { if (bIn === null) bIn = ps; bOut = ps; }
        // (never along the track bed between the platforms of a stop)
        if (ad < TRACK_ZONE_HALF + 0.2 && map.stationAt(ps)) { ok = false; break; }
      }
      if (!ok) continue;
      let T = 0;
      if (bIn !== null) {
        if (toBand) { if (rideNear(c, a, true)) continue; }
        else {
          // through the band and out the far side well before the tram could be there
          T = Math.abs(bOut - a.s) / (0.8 * Math.max(2.0, Math.min(a.v0, a.bikeV + 0.5))) + 1.5;
          if (!tram.canEnterBand(a, bIn, T) || !tram.canEnterBand(a, bOut, T) || rideNear(c, a) && a.d > RIDE_D - BAND - 0.6 && dTo > a.d) continue;
        }
      }
      a.mvOn = true; a.mvS0 = s0; a.mvS1 = s1; a.mvD0 = a.d; a.mvD1 = dTo;
      a.mvBand = bIn !== null; a.mvToBand = toBand; a.mvBIn = bIn ?? 0; a.mvBOut = bOut ?? 0;
      a.mvLane = lane; a.mvOld = old;
      if (a.mvBand && !toBand) a.crossOK = c.time + T + 1;
      return true;
    }
  }
  return false;
}

function finishMove(c, a) {
  a.mvOn = false;
  const L = a.mvLane;
  if (L) { a.lane = L.lane; a.laneD = L.laneD; a.side = L.side; a.laneF = L.laneF; }
  a.mvLane = null; a.mvOld = null;
}

/** A lane change across the ride track: before the band, re-checked against the tram every
 *  frame (called off if it is no longer clearly safe); once in it, committed until out of the
 *  far side, however long that takes. */
function guardCrossing(c, a) {
  const tram = c.tram;
  const vEst = 0.8 * Math.max(1.8, Math.min(a.v0, a.bikeV + 0.5));
  // progress judged by where the rider really is (they lag the ramp), not by the ramp's s
  const toward = a.mvD1 > a.d ? 1 : -1;
  const gap = footBandGap(a);
  const farEdge = toward > 0 ? RIDE_D + BAND + a.extLo + 0.1 : RIDE_D - BAND - a.extHi - 0.1;
  const lateral = Math.max(0, (farEdge - a.d) * toward);
  const latV = Math.max(0.5, vEst * Math.sin(0.45));
  const T = lateral / latV + 1.5;
  const sOut = a.s + a.dir * vEst * T;
  const before = gap > 0.2 && (a.d - RIDE_D) * toward < 0;
  if (before) {
    if (!tram.canEnterBand(a, a.s, T) || !tram.canEnterBand(a, sOut, T)) { abortMove(c, a); return; }
    a.crossOK = c.time + T + 1;
  } else if (gap < 0.3) a.crossOK = Math.max(a.crossOK, c.time + T + 0.5);
}

/** Call a lane change off: back to the lane it started from (or one through where they are). */
function abortMove(c, a) {
  a.mvOn = false;
  const L = a.mvOld;
  if (L) { a.lane = L.lane; a.laneD = L.laneD; a.side = L.side; a.laneF = L.laneF; }
  else laneHere(c, a);
  a.mvLane = null; a.mvOld = null;
  c.tally('cycleMoveAbort');
}

/** A lane through the cyclist's present position. */
function laneHere(c, a) {
  if (Math.abs(a.d) < TRACK_ZONE_HALF) {
    // (never a line in the ride track's band with the tram coming)
    const hi = rideNear(c, a, true) ? Math.max(CORR_LO, RIDE_D - BAND - 0.6 - a.extHi) : CORR_HI;
    a.lane = LANE.CORR; a.laneD = rideLine(a.d, CORR_LO, hi);
    a.side = a.laneD >= 0 ? 1 : -1;
  }
  else {
    a.lane = LANE.SIDE; a.side = a.d >= 0 ? 1 : -1;
    const lo = c.map.bandInAt(a.s, a.side), hi = c.map.bandOutAt(a.s, a.side);
    a.laneF = clamp((Math.abs(a.d) - lo - 0.32) / Math.max(0.3, hi - lo - 1.1), 0.03, 0.9);
  }
}

// ------------------------------------------------------------------ decisions

export function thinkCycle(c, a) {
  const r = c.rng, map = c.map;
  a.thinkT = r.range(0.4, 0.8);
  if (a.state === ST.GOTO) {
    // into a side street: gone once out of sight behind the corner
    if (a.task === TASK.SIDE_OUT && a.mouth && a.step >= 1) {
      const m = a.mouth, line = map.mouthLine(m, a.side);
      if (Math.abs(a.d) > line + 2.2 && c.side.hidden(a.s, a.d, 1.0) && c.side.hidden(a.s, a.d - a.side * 1.0, 1.0)) c.population.vanish(a);
    }
    return;
  }
  if (a.mvOn || a.simple && a.lane !== LANE.SIDE) return;
  // the old lane keeps until a change is planned: remember it to restore on failure
  const keep = { lane: a.lane, laneD: a.laneD, side: a.side, laneF: a.laneF };
  const restore = () => { a.lane = keep.lane; a.laneD = keep.laneD; a.side = keep.side; a.laneF = keep.laneF; };
  // a narrow sidewalk ahead (café terraces, a platform): over to the corridor, or get off
  if (a.lane === LANE.SIDE) {
    laneLine(c, a);
    if (LN.narrow) {
      a.lane = LANE.CORR; a.laneD = a.side < 0 ? CORR_LO + r.range(0, 0.25) : CORR_HI - r.range(0, 0.25);
      if (a.side > 0 && rideNear(c, a, true)) a.laneD = CORR_LO + r.range(0, 0.25);
      if (planMove(c, a, a.laneD, keep)) { c.tally('cycleLaneNarrow'); a.narrowS = null; return; }
      restore();
      // nowhere to go: slow down before the narrow stretch, get off and walk the bicycle through
      if (a.narrowS === null) {
        for (let j = 0; j <= 30; j++) {
          const sj = a.s + a.dir * j;
          if (map.bandOutAt(sj, a.side) - map.bandInAt(sj, a.side) < 1.3) { a.narrowS = sj; break; }
        }
      }
      map.bandAhead(a.s, a.side, a.dir * 8, tmpBand);
      if (tmpBand.hi - tmpBand.lo < 1.0) dismount(c, a);
      return;
    }
    a.narrowS = null;
  }
  if (a.simple) return;
  // a stop ahead with the rider in the track corridor: over to the sidewalk behind its platform
  // if there is a way, else get off before it
  if (Math.abs(a.d) < TRACK_ZONE_HALF + 0.2 && a.stnS === null) {
    let sE = null;
    for (let j = 0; j <= 34; j += 2) { if (map.stationAt(a.s + a.dir * j)) { sE = a.s + a.dir * j; break; } }
    if (sE !== null) {
      const side = a.d >= 0 ? 1 : -1;
      a.lane = LANE.SIDE; a.side = side; a.laneF = r.range(0.1, 0.5);
      const ln = laneLine(c, a);
      if (ln.d * side > TRACK_ZONE_HALF && planMove(c, a, ln.d, keep)) { c.tally('cycleStationSidewalk'); return; }
      restore();
      a.stnS = sE - a.dir * 1.0;
    }
  }
  // a side street just ahead: some turn into it
  const mouthS = a.s + a.dir * 18;
  for (const side of [-1, 1]) {
    const m = map.mouthAt(mouthS, side);
    if (!m || m === a.mouth) continue;
    a.mouth = m;
    if (r.chance(0.3) && startSideOutRide(c, a, m, side)) return;
  }
  // change lanes now and then, sometimes all the way across the street at a shallow angle
  // (riders on a crowded sidewalk go back to the corridor sooner)
  if (r.chance(a.lane === LANE.SIDE ? 0.07 : 0.03)) {
    pickRideLane(c, a, r, r.chance(0.75) ? 0 : (a.side || 1));
    const ln = laneLine(c, a);
    if (Math.abs(ln.d - a.d) > 0.6 && planMove(c, a, ln.d, keep)) { c.tally(Math.abs(ln.d - a.d) > 5 ? 'cycleCrossStreet' : 'cycleLaneChange'); return; }
    restore();
  }
  // well off the lane (after an aborted change, clearing the tram): back to it, or take a lane here
  {
    const ln = laneLine(c, a);
    if (Math.abs(ln.d - a.d) > 1.4 && Math.sign(ln.d) !== Math.sign(a.d) || Math.abs(ln.d - a.d) > 2.5) {
      if (!planMove(c, a, ln.d, keep)) { restore(); laneHere(c, a); }
    }
  }
  if (r.chance(0.05)) a.laneF = clamp(a.laneF + r.normal(0, 0.2), 0.03, 0.9);
  // glances
  if (r.chance(0.1)) a.lookGoal = r.range(-0.5, 0.5); else if (r.chance(0.3)) a.lookGoal = 0;
}

/** Turn into a side street on `side`, if a straight, clear way leads into its opening. */
function startSideOutRide(c, a, m, side) {
  const map = c.map, tram = c.tram, r = c.rng;
  const ms = c.unwrap(m.s), line = map.mouthLine(m, side);
  const slotX = r.range(-1, 1) * Math.max(0, m.width / 2 - 2.2);
  const gs = ms + slotX, gd = side * (line + 1.5);
  const ahead = (gs - a.s) * a.dir, lat = Math.abs(gd - a.d);
  if (ahead < 6 || lat / ahead > 1.3) return false;
  // a clear straight way (no pole, trunk, café or platform on it)
  const n = Math.ceil(Math.hypot(ahead, lat) / 0.8);
  let bIn = null, bOut = null;
  for (let i = 1; i <= n; i++) {
    const u = i / n, ps = a.s + (gs - a.s) * u, pd = a.d + (gd - a.d) * u, sd = pd >= 0 ? 1 : -1;
    const k = map.gatherCircles(ps, 1.0);
    for (let q = 0; q < k; q++) {
      const j = map.qI[q], ds = map.qDS[q], dq = map.cD[j] - pd, rr = map.cR[j] + HALF + 0.2;
      if (ds * ds + dq * dq < rr * rr) return false;
    }
    if (map.rectInner(ps, sd, Math.abs(pd), 0.45)) return false;
    if (sd > 0 && pd > TRACK_ZONE_HALF - 0.2 && pd < map.bandInAt(ps, 1) + 0.1 && map.facadeAt(ps, 1) < 90) return false;
    if (Math.abs(pd - RIDE_D) < BAND + 0.5) { if (bIn === null) bIn = ps; bOut = ps; }
  }
  // (across the tracks at a junction: only on a green light)
  if ((bIn !== null || (a.d + RIDE_D) * (gd + RIDE_D) < 0) && crossLight(c, ms) < 2) return false;
  if (bIn !== null) {
    const T = Math.abs(bOut - a.s) / Math.max(2, a.bikeV) + 1.5;
    if (!tram.canEnterBand(a, bIn, T) || !tram.canEnterBand(a, bOut, T)) return false;
    a.crossOK = c.time + T + 1;
  }
  // (across the oncoming units' track: only with a safe gap too)
  if (tram.units.length && (a.d + RIDE_D) * (gd + RIDE_D) < 0) {
    const T = Math.hypot(ahead, lat) / Math.max(2, a.bikeV) + 1.5;
    if (!tram.canEnterUnit(a, a.s, T) || !tram.canEnterUnit(a, gs, T)) return false;
    a.crossOK = Math.max(a.crossOK, c.time + T + 1);
  }
  a.state = ST.GOTO; a.task = TASK.SIDE_OUT; a.step = 0; a.mouth = m; a.side = side; a.slotX = slotX;
  a.gs = gs; a.gd = gd; a.gTol = 1.0; a.mvOn = false;
  c.tally('cycleIntoSideStreet');
  return true;
}

// ------------------------------------------------------------------ on and off the bicycle

/** Is a's stroller / bicycle (as placed now) clear of poles, trunks, benches, terraces and facades? */
export function propClear(c, a, margin = 0.08) {
  const map = c.map;
  const n = map.gatherAt(a, 1.6);
  for (let q = 0; q < n; q++) {
    const i = map.qI[q], rr = map.cR[i] + a.fpR + margin;
    if (propPointDist2(a, map.qDS[q], map.cD[i] - a.d) < rr * rr) return false;
  }
  for (let e = 0; e < 2; e++) {
    const ps = a.s + (e ? a.fp1s : a.fp0s), pd = a.d + (e ? a.fp1d : a.fp0d), side = pd >= 0 ? 1 : -1;
    if (map.rectInner(ps, side, Math.abs(pd), a.fpR * 0.6)) return false;
    if (Math.abs(pd) + a.fpR > map.facadeAt(ps, side) - 0.06 && !map.mouthAt(ps, side)) return false;
  }
  return true;
}

/** Get off and walk the bicycle (a crowd, a narrow stretch). Needs the walking-a-bicycle pose. */
export function dismount(c, a, stuck = false, anyway = false) {
  if (!c.mobOK(MOB.WALKBIKE) || a.state !== ST.WALK) return false;
  // (a failed try is not repeated every frame)
  if (c.time < a.dmNext && !anyway) return false;
  // not in the middle of the poles and trees, nor in the ride track's band (unless wedged there)
  const ad = Math.abs(a.d), gap0 = footBandGap(a);
  if (!stuck && ad > TRACK_ZONE_HALF - 0.3 && ad < c.map.bandInAt(a.s, a.d >= 0 ? 1 : -1) - 0.4) return false;
  if (!stuck && gap0 < 0.8) return false;
  const r = c.rng;
  const s0 = a.s, d0 = a.d;
  a.mob = MOB.WALKBIKE; a.footW = 1;
  updateFoot(a);
  // the bicycle goes to the rider's right: not into the tram's band, a pole, a bench, a facade or
  // anybody (wedged beside the band with the tram coming: anywhere not nearer to the band will do)
  const near = c.tram.near(a);
  const placeBad = () => {
    if (stuck && near ? footBandGap(a) < Math.min(gap0, 0.8) : footInBand(a) && near) return 'band';
    if (!anyway && !propClear(c, a)) return 'clear';
    return c.population.propClash(a) ? 'clash' : '';
  };
  let why = placeBad(), step = false;
  if (why && why !== 'band') {
    // no room there: the rider steps off to the left instead and the bicycle stays where it is
    const k = Math.max(0.5, c.route.offsetScale(a.s, a.d)), ls = Math.sin(a.alpha) * FOOT[MOB.WALKBIKE].l, ld = -Math.cos(a.alpha) * FOOT[MOB.WALKBIKE].l;
    a.s = s0 + ls / k; a.d = d0 + ld;
    updateFoot(a);
    if (!placeBad() && bodyClear(c, a)) { why = ''; step = true; }
    a.s = s0; a.d = d0;
    if (step) { a.stepT = 0.75; a.stepS = ls; a.stepD = ld; }
  }
  if (why) { a.mob = MOB.CYCLE; updateFoot(a); a.slowT = 1.0; a.dmNext = c.time + 0.6; c.tally('dismountNo_' + why); return false; }
  propMoved(a, MOB.CYCLE, c.time);
  a.state = ST.WALK; a.task = TASK.NONE; a.mvOn = false; a.slowT = 0; a.rx = 0; a.narrowS = null; a.stopT = 0; a.stopNP = 0;
  a.v0 = r.range(WALKBIKE_V[0], WALKBIKE_V[1]);
  a.mountT = c.time + r.range(6, 16);
  a.dir = Math.cos(a.alpha) >= 0 ? 1 : -1;
  a.side = a.d >= 0 ? 1 : -1;
  if (Math.abs(a.d) < TRACK_ZONE_HALF) { a.lane = LANE.CORR; a.laneD = clamp(a.d, CORR_LO, CORR_HI); }
  else {
    a.lane = LANE.SIDE;
    const lo = c.map.bandInAt(a.s, a.side), hi = c.map.bandOutAt(a.s, a.side);
    a.laneF = clamp((Math.abs(a.d) - lo - 0.3) / Math.max(0.3, hi - lo - 0.6), 0.04, 0.96);
  }
  a.laneTT = 0; a.strideV = -1; a.yawW = 0; a.uturnT = 0;
  c.tally(step ? 'dismountLeft' : 'dismount');
  return true;
}

/** Is a's body (at its present spot) clear of poles, trunks, benches and other people? */
function bodyClear(c, a) {
  const map = c.map;
  const n = map.gatherAt(a, 1.2);
  for (let q = 0; q < n; q++) {
    const i = map.qI[q], ds = map.qDS[q], dd = map.cD[i] - a.d, rr = map.cR[i] + AGENT_R;
    if (ds * ds + dd * dd < rr * rr) return false;
  }
  const side = a.d >= 0 ? 1 : -1;
  if (map.rectInner(a.s, side, Math.abs(a.d), AGENT_R * 0.5) || Math.abs(a.d) > map.wallAt(a.s, side)) return false;
  for (let ii = 0, AG = c.population.agents, nn = AG.length; ii < nn; ii++) {
    const b = AG[ii];
    if (!b.active || b === a || b.mob) continue;
    const ds = b.s - a.s, dd = b.d - a.d;
    if (ds * ds + dd * dd < (2 * AGENT_R) ** 2) return false;
  }
  return true;
}

/** Get back on: walking a bicycle on a free stretch. */
export function maybeMount(c, a) {
  if (a.mob !== MOB.WALKBIKE || !c.mobOK(MOB.CYCLE) || a.state !== ST.WALK || a.leader || a.nFollow || a.task !== TASK.NONE) return false;
  if (c.time < a.mountT || a.uturnT > 0 || a.clearing) return false;
  // (not along a stop: on again past its platforms)
  if (c.map.stationAt(a.s) || c.map.stationAt(a.s + a.dir * 12)) { a.mountT = c.time + 2; return false; }
  const dir = Math.cos(a.alpha) >= 0 ? 1 : -1;
  if (Math.abs(Math.sin(a.alpha)) > 0.35 || dir !== a.dir) return false;
  // not in the tram's band or beside the ride track while it is near
  if (footBandGap(a) < 0.6 && c.tram.near(a)) return false;
  // nobody right in front
  const agents = c.population.agents;
  for (let ii = 0, AG = agents, nn = AG.length; ii < nn; ii++) {
    const b = AG[ii];
    if (!b.active || b === a) continue;
    const x = (b.s - a.s) * dir;
    if (x > -0.5 && x < 9 && Math.abs(b.d - a.d) < 1.3) { a.mountT = c.time + 2; return false; }
  }
  a.mob = MOB.CYCLE; a.footW = 1;
  updateFoot(a);
  if (!propClear(c, a) || c.population.propClash(a)) { a.mob = MOB.WALKBIKE; updateFoot(a); a.mountT = c.time + 2; return false; }
  propMoved(a, MOB.WALKBIKE, c.time);
  const r = c.rng;
  a.v0 = r.range(CYCLE_V[0], CYCLE_V[1]);
  a.clearT = r.range(CYCLE_CLEAR_T[0], CYCLE_CLEAR_T[1]); a.needsBell = false; a.dreamy = false;
  a.bikeV = Math.max(0.8, a.speedA);
  a.yawW = 0; a.slowT = 0; a.cT = a.d; a.mvOn = false; a.uturnT = 0; a.rx = 0; a.narrowS = null; a.stopT = 0; a.stopNP = 0;
  // ride on along a line through where they are (clear of the rails)
  if (Math.abs(a.d) < TRACK_ZONE_HALF) { a.lane = LANE.CORR; a.laneD = rideLine(a.d); }
  else { a.lane = LANE.SIDE; a.side = a.d >= 0 ? 1 : -1; a.laneF = r.range(0.05, 0.6); }
  updateFoot(a);
  c.tally('mount');
  return true;
}
