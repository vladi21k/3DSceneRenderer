import { TRACK_ZONE_HALF } from '../../core/config.js';
import { noise1 } from '../../core/rng.js';
import { ST, TASK, LANE, MOB } from './agent.js';
import { RIDE_D, BAND, AGENT_R, CELL, GRID_D, CYCLE_V, WALKBIKE_V, TRAM_LEN } from './constants.js';
import { footBandGap, footInBand, updateFoot, propPointDist2 } from './footprint.js';

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

const PI = Math.PI;
const CORR_LO = -(TRACK_ZONE_HALF - 0.42);  // riding lines inside the corridor (clear of the platform edges)
const CORR_HI = TRACK_ZONE_HALF - 0.42;
const HALF = 0.32;                          // half width of a bicycle with its rider (handlebar, elbows)
const NC = 9;                               // candidate lines for passing
const SPAN = 1.6;                           // ... spread over ±SPAN around the lane line
const cand = new Float32Array(NC), cost = new Float32Array(NC), blk = new Float32Array(NC), vblk = new Float32Array(NC);
const tmpBand = { lo: 0, hi: 0 };
const LN = { d: 0, lo: 0, hi: 0, narrow: false };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (u) => u * u * (3 - 2 * u);
const wrapAngle = (x) => { x = (x + PI) % (2 * PI); if (x < 0) x += 2 * PI; return x - PI; };

// ------------------------------------------------------------------ lanes

/** A riding line: mostly along the edges of the track corridor and between the tracks, some
 *  along the inner edge of a sidewalk. prefer (±1) keeps it on one side of the street. */
export function pickRideLane(c, a, r, prefer = 0) {
  for (let k = 0; k < 6; k++) {
    const p = r.next();
    let lane = LANE.CORR, d = 0, side = a.side;
    if (p < 0.26) d = -1.6 + r.range(-0.3, 0.3);                 // between the rails of the other track
    else if (p < 0.48) d = CORR_LO + r.range(0, 0.25);           // the left edge of the corridor
    else if (p < 0.58) d = r.range(-0.62, -0.38);                // between the tracks
    else if (p < 0.72) d = CORR_HI - r.range(0, 0.25);           // the right edge (moves over when the tram comes)
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
  const reach = tram.frontFor(a) * 1.25 + 25 + (far ? 60 : 0);
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
    const close = tram.near(a);
    const lim = close ? RIDE_D - tram.passD - a.extHi - 0.12 : RIDE_D - BAND - a.extHi - 0.35;
    LN.hi = Math.min(LN.hi, lim);
    if (LN.lo > LN.hi) LN.lo = LN.hi - 0.3;
  }
  LN.d = clamp(LN.d, LN.lo, LN.hi);
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
  let dL = LN.d, lo = LN.lo, hi = LN.hi, weave = true;
  if (a.mvOn && a.mvBand && !a.mvToBand) guardCrossing(c, a);
  if (a.mvOn) {
    const u = clamp((a.s - a.mvS0) / (a.mvS1 - a.mvS0), 0, 1);
    // a lane change towards the ride track is called off when the tram comes
    if (a.mvToBand && rideNear(c, a) && !(a.crossOK > c.time)) abortMove(c, a);
    else {
      dL = a.mvD0 + (a.mvD1 - a.mvD0) * smooth(u);
      lo = Math.min(dL, a.d) - 0.35; hi = Math.max(dL, a.d) + 0.35;
      weave = false;
      // steep enough to follow the ramp (its middle is 1.5 times the mean slope)
      T.ang = clamp(1.7 * Math.atan(Math.abs(a.mvD1 - a.mvD0) / Math.abs(a.mvS1 - a.mvS0)) + 0.1, 0.42, 0.8);
      if (u >= 1) finishMove(c, a);
    }
  }
  if (a.clearing && !(a.mvOn && a.crossOK > c.time)) {
    // out of the band, towards the other track (tram.js picked the side and the margin)
    dL = a.clearTo; T.ang = 0.62;
    if (a.clearTo < a.d) { hi = Math.min(hi, a.clearTo); lo = Math.min(lo, hi - 0.6); } else { lo = Math.max(lo, a.clearTo); hi = Math.max(hi, lo + 0.6); }
    vT = Math.max(vT, 2.6);
  }
  // poles, trunks, bins: steered round (a lane change crosses the line of them)
  if (Math.abs(a.d) > TRACK_ZONE_HALF - 0.1) T.avoid = avoidFixed(c, a);
  if (a.simple) { T.d = dL; T.v = vT; a.cT = dL; return; }
  // passing: the candidate line with the least conflict, slowing behind whoever is in the way
  const best = scan(c, a, dL, lo, hi, weave ? (a.lane === LANE.SIDE ? 2.4 : 1.6) : 0.25);
  T.d = cand[best];
  a.cT = T.d;
  // a lane change running into a bench or a trunk: called off, back to the old line
  if (a.mvOn && blk[best] < 2.5 && vblk[best] === 0 && blkStatic && !(a.crossOK > c.time)) { abortMove(c, a); c.tally('cycleMoveBlocked'); }
  const dbg = c.dbgCyc ? (a._dbg || (a._dbg = {})) : null;
  if (dbg) { dbg.v0 = vT; dbg.blk = blk[best]; dbg.vblk = vblk[best]; dbg.crowd = scanCrowd; dbg.td = T.d; dbg.d = a.d; dbg.lane = a.lane; dbg.laneD = a.laneD; dbg.lo = lo; dbg.hi = hi; dbg.mv = a.mvOn; dbg.clr = a.clearing; dbg.cost = Array.from(cost).map((x) => +x.toFixed(2)); dbg.cand = Array.from(cand).map((x) => +x.toFixed(2)); }
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
  if (dbg) dbg.vT = vT;
  // inside the band on a crossing: through it briskly (only someone right in front stops it)
  if (a.mvOn && a.crossOK > c.time && footBandGap(a) < 0.3 && !T.hard) vT = Math.max(vT, Math.min(a.v0, 2.6));
  T.v = Math.max(0, vT);
  // held to walking pace for a while: get off and walk (if the figures can show it)
  if (vT < 1.3 && !a.clearing) a.slowT += dt; else a.slowT = Math.max(0, a.slowT - 2 * dt);
  if (a.slowT > 1.8 && !(a.crossOK > c.time) && !a.mvOn) dismount(c, a);
}

/** Into / out of a side street: ride towards a point. */
function waypoint(c, a, T, vT) {
  const k = Math.max(0.5, 1 + c.route.curvature(a.s) * a.d);
  const es = (a.gs - a.s) * k, ed = a.gd - a.d, dist = Math.hypot(es, ed);
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
    if (a.step >= 3) {
      if (c.vis.hidden(a.s, a.d) || c.vis.distance(a.s) > 150) { c.population.vanish(a); return; }
      a.gs = c.unwrap(m.s) + a.slotX; a.gd = side * (line + 18); a.gTol = 0.8;
      return;
    }
    a.gs = c.unwrap(m.s) + a.slotX; a.gd = side * (line + 4 + a.step * 6); a.gTol = 0.9;
    return;
  }
  // (emerging) the turn onto the main street happens below
  // out of a side street: on along a lane of this side
  a.state = ST.WALK; a.task = TASK.NONE; a.step = 0;
  const side = a.d >= 0 ? 1 : -1;
  pickRideLane(c, a, r, side);
  const ln = laneLine(c, a);
  if (!planMove(c, a, ln.d, null)) { a.lane = LANE.SIDE; a.side = side; a.laneF = r.range(0.05, 0.5); }
}

let scanCrowd = 0;
/** Scores the candidate lines around dL (clamped to [lo, hi]) against the people and fixed
 *  obstacles ahead; returns the best index (blk / vblk: nearest conflict on each line). */
let blkStatic = false;
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
function scan(c, a, dL, lo, hi, spread) {
  const st = c.steering, agents = c.population.agents, map = c.map;
  const v = Math.max(a.bikeV, 1.2), dir = a.dir;
  const look = 4 + 2.6 * v;
  blkStatic = false;
  for (let i = 0; i < NC; i++) {
    const dc = clamp(dL + ((i - (NC - 1) / 2) / ((NC - 1) / 2)) * spread, lo, hi);
    cand[i] = dc; off[i] = dc - dL;
    // stay near the lane line, and near the line already chosen (no dithering)
    cost[i] = 0.5 * Math.abs(dc - dL) + 0.7 * Math.abs(dc - a.cT);
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
        const xe = xb - (b.mob ? b.extS : 0) - 0.92;      // from our front wheel
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
    const xe = xb - r - 0.92, w = 3.2 / (1 + 0.3 * Math.max(0, xe));
    const p = xb > 0.3 ? pathAt(a, xb, dL) : dL;
    for (let i = 0; i < NC; i++) {
      const dc = p + off[i];
      if (dc + HALF + 0.2 > od - r && dc - HALF - 0.2 < od + r) {
        cost[i] += w * 1.5;
        if (xb > 0 && xe < blk[i]) { blk[i] = Math.max(0, xe); vblk[i] = 0; if (i === (NC - 1) / 2) blkStatic = true; }
      }
    }
  }
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
  const agents = c.population.agents, cs = Math.cos(a.alpha), sn = Math.sin(a.alpha);
  const look = 3 + 2 * a.bikeV;
  let best = 1e9;
  for (const b of agents) {
    if (!b.active || b === a) continue;
    const ds = b.s - a.s, dd = b.d - a.d;
    if (ds > look || ds < -look || dd > look || dd < -look) continue;
    const x = ds * cs + dd * sn, y = -ds * sn + dd * cs;
    if (x < 0 || x > look || Math.abs(y) > 0.75) continue;
    best = Math.min(best, x - 0.92);
  }
  return best;
}

// ------------------------------------------------------------------ lane changes

/** Plan a lane change from the present line to dTo along a shallow ramp, through a gap in the
 *  poles and trees and across the ride track only when the tram is far. The new lane (the
 *  agent's lane fields at call time, set by the caller) takes over at the end. */
export function planMove(c, a, dTo, old = null) {
  const map = c.map, tram = c.tram, r = c.rng;
  const v = Math.max(2.2, a.bikeV);
  const dd = dTo - a.d;
  const lane = { lane: a.lane, laneD: a.laneD, side: a.side, laneF: a.laneF };
  if (Math.abs(dd) < 0.25) { a.mvOn = false; return true; }
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
        if (Math.abs(pd - RIDE_D) < BAND + 0.5) { if (bIn === null) bIn = ps; bOut = ps; }
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
  const toIn = (a.mvBIn - a.s) * a.dir, toOut = (a.mvBOut - a.s) * a.dir;
  const T = Math.max(0, toOut) / vEst + 1.5;
  const inside = footBandGap(a) < 0.2;
  if (!inside && toIn > 0.5) {
    if (!tram.canEnterBand(a, a.mvBIn, T) || !tram.canEnterBand(a, a.mvBOut, T)) { abortMove(c, a); return; }
    a.crossOK = c.time + T + 1;
  } else if (inside || toOut > -1) a.crossOK = Math.max(a.crossOK, c.time + T + 0.5);
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
  if (Math.abs(a.d) < TRACK_ZONE_HALF) { a.lane = LANE.CORR; a.laneD = clamp(a.d, CORR_LO, CORR_HI); a.side = a.d >= 0 ? 1 : -1; }
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
      const m = a.mouth, line = map.mouthLine(m, a.side), ms = c.unwrap(m.s);
      if (c.vis.bodyHidden(a.s, a.d, a.side, line, ms - m.width / 2, ms + m.width / 2) && Math.abs(a.d) > line + 2.2) c.population.vanish(a);
    }
    return;
  }
  if (a.simple || a.mvOn) return;
  // the old lane keeps until a change is planned: remember it to restore on failure
  const keep = { lane: a.lane, laneD: a.laneD, side: a.side, laneF: a.laneF };
  const restore = () => { a.lane = keep.lane; a.laneD = keep.laneD; a.side = keep.side; a.laneF = keep.laneF; };
  // a narrow sidewalk ahead (café terraces, a platform): over to the corridor, or get off
  if (a.lane === LANE.SIDE) {
    laneLine(c, a);
    if (LN.narrow) {
      a.lane = LANE.CORR; a.laneD = a.side < 0 ? CORR_LO + r.range(0, 0.25) : CORR_HI - r.range(0, 0.25);
      if (a.side > 0 && rideNear(c, a, true)) a.laneD = -1.6 + r.range(-0.3, 0.3);
      if (planMove(c, a, a.laneD, keep)) { c.tally('cycleLaneNarrow'); return; }
      restore();
      // nowhere to go: walk the bicycle through when it gets tight
      map.bandAhead(a.s, a.side, a.dir * 8, tmpBand);
      if (tmpBand.hi - tmpBand.lo < 1.0) dismount(c, a);
      return;
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
    if (Math.abs(pd - RIDE_D) < BAND + 0.5) { if (bIn === null) bIn = ps; bOut = ps; }
  }
  if (bIn !== null) {
    const T = Math.abs(bOut - a.s) / Math.max(2, a.bikeV) + 1.5;
    if (!tram.canEnterBand(a, bIn, T) || !tram.canEnterBand(a, bOut, T)) return false;
    a.crossOK = c.time + T + 1;
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
  const n = map.gatherCircles(a.s, 1.6);
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
export function dismount(c, a) {
  if (!c.mobOK(MOB.WALKBIKE) || a.state !== ST.WALK) return false;
  const r = c.rng;
  const prev = a.alpha;
  a.mob = MOB.WALKBIKE;
  updateFoot(a);
  // the bicycle moves to the person's side: not into the tram's band, a pole, a bench or a facade
  if ((footInBand(a) && c.tram.near(a)) || !propClear(c, a)) { a.mob = MOB.CYCLE; a.alpha = prev; updateFoot(a); a.slowT = 1.0; return false; }
  a.state = ST.WALK; a.task = TASK.NONE; a.mvOn = false; a.slowT = 0;
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
  c.tally('dismount');
  return true;
}

/** Get back on: walking a bicycle on a free stretch. */
export function maybeMount(c, a) {
  if (a.mob !== MOB.WALKBIKE || !c.mobOK(MOB.CYCLE) || a.state !== ST.WALK || a.leader || a.nFollow || a.task !== TASK.NONE) return false;
  if (c.time < a.mountT || a.uturnT > 0 || a.clearing) return false;
  const dir = Math.cos(a.alpha) >= 0 ? 1 : -1;
  if (Math.abs(Math.sin(a.alpha)) > 0.35 || dir !== a.dir) return false;
  // not in the tram's band or beside the ride track while it is near
  if (footBandGap(a) < 0.6 && c.tram.near(a)) return false;
  // nobody right in front
  const agents = c.population.agents;
  for (const b of agents) {
    if (!b.active || b === a) continue;
    const x = (b.s - a.s) * dir;
    if (x > -0.5 && x < 9 && Math.abs(b.d - a.d) < 1.3) { a.mountT = c.time + 2; return false; }
  }
  a.mob = MOB.CYCLE;
  updateFoot(a);
  if (!propClear(c, a)) { a.mob = MOB.WALKBIKE; updateFoot(a); a.mountT = c.time + 2; return false; }
  const r = c.rng;
  a.v0 = r.range(CYCLE_V[0], CYCLE_V[1]);
  a.bikeV = Math.max(0.8, a.speedA);
  a.yawW = 0; a.slowT = 0; a.cT = a.d; a.mvOn = false; a.uturnT = 0;
  // ride on along a line through where they are
  if (Math.abs(a.d) < TRACK_ZONE_HALF) { a.lane = LANE.CORR; a.laneD = clamp(a.d, CORR_LO, CORR_HI); }
  else { a.lane = LANE.SIDE; a.side = a.d >= 0 ? 1 : -1; a.laneF = r.range(0.05, 0.6); }
  updateFoot(a);
  c.tally('mount');
  return true;
}
