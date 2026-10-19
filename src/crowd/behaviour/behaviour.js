import { TRACK_ZONE_HALF } from '../../core/config.js';
import { lattice1, LATTICE } from '../../core/rng.js';
import { PLATFORM_W } from '../../world/layout.js';
import { KIND, ST, TASK, LANE, MOB, settleShape } from './agent.js';
import { EDGE_LANE, RIDE_D, BAND, STANDER_TARGET, STAND_NEAR, MAX_SEATED, MAX_PASSENGERS, RANGE_AHEAD, AGENT_R, CELL, GRID_D } from './constants.js';
import { thinkCycle, maybeMount } from './cyclist.js';
import { serveArrive } from './staff.js';
import { PAUSE } from './stance.js';

// Decisions and goals of individual pedestrians: lane walking, window shopping,
// entering shops, side streets, crossing the tracks, joining a platform, café seats,
// chats. `think` runs about once a second per agent; `desired` gives the preferred
// velocity every frame (steering adds avoidance on top). Parents with a stroller and people
// walking a bicycle keep to the sidewalks and the far half of the corridor and skip the
// errands a stroller or a bicycle does not fit (café seats, doors, platforms); cyclists are
// handled by cyclist.js.

const CORR_EDGE = TRACK_ZONE_HALF + 0.38;   // where people wait before crossing the corridor (left side)
const RIDE_EDGE = TRACK_ZONE_HALF + 1.1;    // ... and on the ride side: clear of the passing tram, outside the pole line
/** |d| of the spot where people wait to cross, on `side` (a stroller / bicycle a step further back). */
const crossEdge = (side, a = null) => (side > 0 ? RIDE_EDGE : CORR_EDGE) + (a && a.mob ? 0.9 : 0);
const UTURN_T = 1.35;                       // seconds for a turn-around while walking
const PI = Math.PI;
const tmpBand = settleShape({ lo: 0, hi: 0 });

// ------------------------------------------------------------------ lanes

/** Lateral target (signed d) for a lane-following walker (it leaves a.laneT as it was). */
export function laneTarget(c, a) {
  const keep = a.laneT;
  laneTargetA(c, a);
  const d = a.laneT;
  a.laneT = keep;
  return d;
}

/** laneTarget → a.laneT. (The lane helpers below hand the target on in a.laneT rather than as
 *  an argument and a result: a double passed to or returned from a call that is not inlined is
 *  boxed, and this runs for every walker a few times a second.) */
export function laneTargetA(c, a) {
  // (overtaking somebody slower: the passing line for a few seconds)
  if (a.ovT > c.time && a.state === ST.WALK) a.laneT = a.ovD; else rawLane(c, a);
  // nobody walks a ruler-straight line: a slow personal wander across the lane
  // (noise1(a.s / 8, a.wSeed) written out: see walkNoise)
  const x = a.s / 8, i = Math.floor(x), f = x - i;
  lattice1(i, i + 1, a.wSeed);
  a.laneT += 0.25 * (LATTICE[0] + (LATTICE[1] - LATTICE[0]) * (f * f * (3 - 2 * f)));
  if (a.dodgeT > c.time) a.laneT += a.dodge;
  tramLane(c, a);
}

/** While a tram is near (the cab tram, an oncoming unit, or both), lane targets (a.laneT) keep a
 *  comfortable distance from its track, on the side of the band the walker is already on
 *  (nobody aims across a closed band). */
function tramLane(c, a) {
  const tram = c.tram;
  a.laneUrgent = false;
  if (tram.near(a)) cabLane(c, a);
  if (!tram.units.length) return;
  const U = a.uI >= 0 ? tram.unitById(a.uI) : tram.uZone(a);
  if (!U) return;
  const iv = tram.keepOut(a, true);
  if (!iv) return;
  const lo = iv.lo, hi = iv.hi, d = a.laneT;
  // (standing too close to where a unit goes by: a brisker step out to the berth)
  a.laneUrgent = a.d > lo + 0.05 && a.d < hi - 0.05;
  const across = (a.d <= lo && d > lo) || (a.d >= hi && d < hi);
  if (!across && (d >= hi || d <= lo)) return;
  // (inside: over to the other track rather than off the corridor, unless that is much
  // further; with the cab near as well, the nearer edge)
  const pref = a.uSide ? a.uSide > 0 : tram.near(a) ? d >= (lo + hi) / 2 : hi - a.d <= a.d - lo + 1.5;
  const up = keepSide(c, a, pref);
  a.laneT = up ? hi + a.laneF * 0.35 : lo - a.laneF * 0.5;
}

/** Which side of the bands kept free for the trams person a is on (true: +d); inside them the
 *  side being cleared to, else `pref`. */
function keepSide(c, a, pref) {
  const b = c.tram.keepOut(a, false);
  if (!b) return pref;
  if (a.d >= b.hi) return true;
  if (a.d <= b.lo) return false;
  if (a.clearing) return a.clearTo > a.d;
  return pref;
}

/** The cab tram near: the lane target a.laneT kept off its berth. */
function cabLane(c, a) {
  const tram = c.tram, d = a.laneT;
  const pd = tram.passD;
  // a stroller / bicycle keeps the berth with its whole footprint
  const pdHi = pd + a.extLo, pdLo = pd + a.extHi;
  const dl = a.d - RIDE_D, tl = d - RIDE_D;
  // the lane lies across the ride track: walk on along this side until the tram has gone by
  const across = (dl <= -BAND && tl > -pdLo) || (dl >= BAND && tl < pdHi);
  if (!across && (tl >= pdHi || tl <= -pdLo)) return;
  let hi = dl > BAND ? true : dl < -BAND ? false : d >= RIDE_D;
  if (hi && a.kind !== KIND.PASSENGER) {
    const st = c.map.stationAtA(a) || c.map.stationAt(a.s + a.dir * 15);
    // beside a platform: behind it, up on it (caught at its edge), or between the tracks
    if (st) {
      if (dl <= BAND) { a.laneT = RIDE_D - pdLo - a.laneF * 1.1; return; }
      if (a.platformOK || a.d < TRACK_ZONE_HALF + 0.8) { a.laneT = Math.max(RIDE_D + pdHi, TRACK_ZONE_HALF + 0.6) + a.laneF * 0.8; return; }
      a.laneT = c.map.bandInAt(a.s + a.dir * 10, 1) + 0.3;
      return;
    }
  }
  // a stroller / walked bicycle on the ride side waits on the sidewalk proper, not among the poles
  if (hi && a.mob) {
    const k = c.map.idxA(a), bi = c.map.bandIn[1][k], bo = c.map.bandOut[1][k];
    if (bo - bi > 1.3) { a.laneT = Math.max(RIDE_D + pdHi, bi + 0.75); return; }
  }
  // (spread over the whole strip left of the ride track: no single file of everybody)
  a.laneT = hi ? RIDE_D + pdHi + a.laneF * 0.35 : Math.max(-(TRACK_ZONE_HALF - 0.45), RIDE_D - pdLo - a.laneF * 2.1);
}

/** The walker's own lane line (signed d) → a.laneT. */
function rawLane(c, a) {
  const side = a.side, map = c.map;
  const here = map.stationAtA(a);
  a.bandW = 9;
  // the raised platforms of a stop are the sidewalk there: nobody walks along the track bed
  // between them (people cross it only at the platform ends)
  if (platformLane(c, a, here)) return;
  if (a.lane === LANE.CORR) { a.laneT = a.laneD; return; }
  const lf = a.driftT > c.time ? a.driftF : a.laneF;
  const st = here || map.stationAt(a.s + a.dir * 20);
  if (a.lane === LANE.EDGE && !st) { a.laneT = side * (EDGE_LANE + 0.4 * lf); return; }
  // narrowest stretch of the sidewalk band around here (cafés, platforms), both ways
  const look = Math.max(7, 5 * a.v0);
  map.bandAhead(a.s - look, side, 2 * look, tmpBand);
  const w = tmpBand.hi - tmpBand.lo;
  a.bandW = w;
  if (w < 0.7) {
    // café furniture fills the sidewalk: people use the strip by the poles and trees, and on
    // the left also the track corridor
    if (st) a.laneT = side * (tmpBand.lo + 0.2);
    else if (side < 0 && a.laneF < 0.45) a.laneT = -(0.9 + a.laneF * 4.5);
    else a.laneT = side * (EDGE_LANE + 0.1 + lf * 0.45);
    return;
  }
  // a stroller or a walked bicycle keeps clear of the benches and trunks along the tree line; a
  // bicycle walked on the person's right keeps its whole length off the shop fronts (or the trees)
  let extra = a.mob ? Math.min(0.45, Math.max(0, w - 1.0)) : 0, keep = 0;
  if (a.mob === MOB.WALKBIKE) {
    const facadeSide = a.dir * side > 0;
    const need = Math.min(0.85, Math.max(0, w - 1.2));
    if (facadeSide) keep = need; else extra = Math.max(extra, need);
  }
  a.laneT = side * (tmpBand.lo + 0.3 + extra + Math.max(0, w - 0.6 - extra - keep) * lf);
}

/** b − a along the loop of length L, the shortest way (route.delta, worked out in place: small
 *  enough to be inlined, so the per-frame callers box no numbers). */
function loopDelta(L, a, b) {
  let d = (b - a) % L;
  if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
  return d;
}

/** A walker in the track corridor reaching a stop (or caught beside its platform by the tram)
 *  steps up onto the platform on its side of the street and walks along it to the far end, then
 *  back down to its lane. Writes the lane target on the platform (signed d) to a.laneT and
 *  returns true, or returns false. */
function platformLane(c, a, here) {
  const map = c.map;
  if (!a.platformOK) {
    // (the cab-side step-ups to let the tram by are made in tram.js)
    if (a.lane !== LANE.CORR && !(here && Math.abs(a.d) < TRACK_ZONE_HALF + 0.25)) return false;
    const st = here || map.stationAt(a.s + a.dir * 9);
    if (!st) return false;
    const ds0 = loopDelta(c.route.length, st.s, a.s);
    if (Math.abs(ds0) > st.len / 2 + 12) return false;
    // past its middle and walking away from it: nothing to do
    if (!here && ds0 * a.dir > 0) return false;
    const ps = a.d > RIDE_D - BAND ? 1 : -1;
    let has = false;
    for (let i = 0; i < st.platforms.length; i++) if (st.platforms[i].side === ps) has = true;
    if (!has) return false;
    a.platformOK = true; a.platSt = st; a.platSide = ps;
    c.tally('platformWalk');
  }
  const st = a.platSt;
  if (!st) {
    if (!(here && a.d > 0)) return false;
    a.laneT = TRACK_ZONE_HALF + 0.6 + a.laneF * 1.4;
    return true;
  }
  // along the platform (off it again past its far end)
  const ds = loopDelta(c.route.length, st.s, a.s);
  if (Math.abs(ds) > st.len / 2 + 0.5 && ds * a.dir > 0) return false;
  a.laneT = (a.platSide || 1) * (TRACK_ZONE_HALF + 0.6 + a.laneF * 1.4);
  return true;
}

// ------------------------------------------------------------------ slow personal noise
// noise1(x, seed) of core/rng.js written out with its lattice values (the same numbers): these
// run a few times a second for every walker, and a noise call that is not inlined boxes its
// argument and its result.

/** A walker's pace drift (a.lnN) and heading jitter (a.lnJ) at the crowd's time. */
function walkNoise(c, a) {
  const t = c.time, L = LATTICE;
  let x = t / a.paceT, i = Math.floor(x), f = x - i;
  lattice1(i, i + 1, a.wSeed + 11);
  a.lnN = L[0] + (L[1] - L[0]) * (f * f * (3 - 2 * f));
  x = t * 0.5; i = Math.floor(x); f = x - i;
  lattice1(i, i + 1, a.wSeed + 23);
  const j = 0.045 * (L[0] + (L[1] - L[0]) * (f * f * (3 - 2 * f)));
  x = t * 1.3; i = Math.floor(x); f = x - i;
  lattice1(i, i + 1, a.wSeed + 29);
  a.lnJ = j + 0.025 * (L[0] + (L[1] - L[0]) * (f * f * (3 - 2 * f)));
}

/** A group member's slow wander about its slot (a.fwF along, a.fwR across) and pace (a.lnN). */
function followNoise(c, a) {
  const t = c.time, L = LATTICE;
  let x = t / a.wT, i = Math.floor(x), f = x - i;
  lattice1(i, i + 1, a.wSeed + 3);
  a.fwF = 0.3 * (L[0] + (L[1] - L[0]) * (f * f * (3 - 2 * f)));
  x = t / a.wT + 17.3; i = Math.floor(x); f = x - i;
  lattice1(i, i + 1, a.wSeed + 5);
  a.fwR = 0.15 * (L[0] + (L[1] - L[0]) * (f * f * (3 - 2 * f)));
  x = t / a.paceT; i = Math.floor(x); f = x - i;
  lattice1(i, i + 1, a.wSeed + 7);
  a.lnN = L[0] + (L[1] - L[0]) * (f * f * (3 - 2 * f));
}

// ------------------------------------------------------------------ desired velocity

/** Preferred velocity for this frame → out.vs, out.vd, out.vmax. */
export function desired(c, a, out) {
  out.vmax = a.v0 * 1.25;
  a.moving = true;
  if (a.leader && a.leader.active && (a.state === ST.WALK || a.state === ST.STAND || a.state === ST.WAIT)) {
    follow(c, a, out);
  } else {
    switch (a.state) {
      case ST.WALK: {
        // the lane only changes slowly along the street: refresh it a few times a second
        // (with the slow noise of pace and heading: they change over seconds, and the
        // velocity relaxes towards them anyway)
        a.laneTT -= c.dt;
        if (a.laneTT <= 0) {
          laneTargetA(c, a); a.laneTT = 0.25;
          walkNoise(c, a);
        }
        const e = a.laneT - a.d;
        // pace drifts a few percent over 5-15 s (and drops back / pulls ahead of a stranger
        // alongside); heading jitters a few degrees
        const pace = a.v0 * (1 + 0.06 * a.lnN) * (a.paceKT > c.time ? a.paceK : 1);
        const vdMax = a.laneUrgent ? 1.1 : 0.75;
        let vs = a.dir * pace, vd = Math.max(-vdMax, Math.min(vdMax, e * (a.laneUrgent ? 1.8 : 0.9)));
        const j = a.lnJ;
        const cj = Math.cos(j), sj = Math.sin(j);
        out.vs = vs * cj - vd * sj; out.vd = vs * sj + vd * cj;
        a.gd = a.laneT;
        headway(c, a, out);
        if (a.uturnT > 0) uturn(c, a, out);
        // a child fallen behind: slow down and wait for them, looking back
        if (a.nFollow) waitForChild(c, a, out);
        break;
      }
      case ST.GOTO: {
        const ds = a.gs - a.s, dd = a.gd - a.d;
        const dist = Math.sqrt(ds * ds + dd * dd);
        if (dist < a.gTol) { out.vs = 0; out.vd = 0; arrive(c, a); break; }
        const sp = Math.min(a.v0, dist * 1.3 + 0.25);
        out.vs = (ds / dist) * sp; out.vd = (dd / dist) * sp;
        break;
      }
      case ST.STAND:
        // a conversation circle: step into place first
        if (a.task === TASK.CHAT && !a.leader) { toSpot(a, a.chatS, a.chatD, out); break; }
        standStill(c, a, out);
        break;
      default:
        standStill(c, a, out);
    }
  }
  if (a.clearing) {
    const sp = c.tram.clearSpeed(a);
    out.vd = Math.sign(a.clearTo - a.d) * sp;
    // (walking the way the tram goes, people step aside and walk on; facing it they hesitate)
    out.vs *= a.vs * a.dir > 0.5 && a.dir > 0 ? 0.8 : 0.5;
    out.vmax = Math.max(out.vmax, sp * 1.1);
    a.moving = true;
  } else c.tram.filterDesired(a, out);
}

/** Walking behind slower people: a person or a group catching up with a slower one on the same
 *  strip passes beside it where there is room, else drops in straight behind it and keeps a time
 *  headway of about 1.3 s (rather than tucking in diagonally a metre behind, which turns two
 *  groups into one long row). The scan also measures the room the group has (its formation).
 *  Refreshed four times a second. */
function headway(c, a, out) {
  if (a.uturnT > 0 || a.clearing || a.simple || a.mob === MOB.CYCLE || a.inDoor) { a.hwV = 99; a.freeW = 9; return; }
  a.hwT -= c.dt;
  if (a.hwT <= 0) { a.hwT = 0.25; scanAhead(c, a); }
  const vs = out.vs * a.dir;
  if (a.hwV < 9 && vs > a.hwV) out.vs *= Math.max(0, a.hwV) / Math.max(1e-3, vs);
}

const _strip = settleShape({ lo: 0, hi: 0 });
/** The strip of street a lane walker (and its group) walks in, as signed d [lo, hi]. */
function stripOf(c, a) {
  const map = c.map;
  let lo, hi, side = a.side;
  if (a.platformOK && a.platSt) { lo = TRACK_ZONE_HALF + 0.3; hi = TRACK_ZONE_HALF + PLATFORM_W - 0.3; side = a.platSide || 1; }
  else if (a.lane === LANE.SIDE) { lo = map.bandInAt(a.s, side) + 0.15; hi = map.bandOutAt(a.s, side); }
  else if (a.lane === LANE.EDGE) { lo = TRACK_ZONE_HALF - 0.3; hi = map.bandInAt(a.s, side) + 0.3; }
  else {
    // the corridor less the bands kept free for the trams near
    lo = -TRACK_ZONE_HALF + 0.1; hi = TRACK_ZONE_HALF - 0.1;
    const iv = c.tram.keepOut(a, true);
    if (iv) { if (a.d <= iv.lo) hi = Math.min(hi, iv.lo); else if (a.d >= iv.hi) lo = Math.max(lo, iv.hi); else { lo = a.d - 0.3; hi = a.d + 0.3; } }
    _strip.lo = lo; _strip.hi = Math.max(lo, hi);
    return _strip;
  }
  if (side < 0) { const t = lo; lo = -hi; hi = -t; }
  _strip.lo = lo; _strip.hi = Math.max(lo, hi);
  return _strip;
}

function scanAhead(c, a) {
  const st = c.steering, agents = c.population.agents, dir = a.dir || 1, t = c.time;
  // the group's lateral span and how far its members walk ahead of the leader
  let lo = a.d - AGENT_R - (a.mob ? a.extLo : 0), hi = a.d + AGENT_R + (a.mob ? a.extHi : 0), front = a.mob ? a.extS : 0;
  for (const f of a.followers) { lo = Math.min(lo, f.d - AGENT_R); hi = Math.max(hi, f.d + AGENT_R); front = Math.max(front, (f.s - a.s) * dir); }
  const v = a.v0, look = 2.4 + 2.0 * v + front;
  const sA = Math.min(a.s, a.s + dir * look) - 1.5, sB = Math.max(a.s, a.s + dir * look) + 1.5;
  const ix0 = Math.max(0, Math.floor((sA - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((sB - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((lo - 2.6 + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((hi + 2.6 + GRID_D) / CELL));
  let best = 1e9, bv = 0, blk = null, abreast = 0, stand = null, sGap = 1e9, twin = null, oncoming = 0;
  const avs = a.vs * dir;
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a || b.leader === a || !b.active || b.state === ST.SEATED) continue;
        const xb = (b.s - a.s) * dir;
        // people abreast of the group take room from it
        if (Math.abs(xb) < 1.2 && b.d > lo - 1.2 && b.d < hi + 1.2) {
          abreast++;
          // a stranger walking right beside it the same way at the same pace
          if (!twin && b.d > lo - 1.3 && b.d < hi + 1.3 && b.state === ST.WALK && Math.abs(b.vs * dir - avs) < 0.12 && avs > 0.5) twin = b;
        }
        if (xb < 0.3 || xb > look || b.mob === MOB.CYCLE) continue;
        const bv0 = b.vs * dir;
        // people coming the other way on the group's line: it closes up to let them by
        if (bv0 < -0.2 && xb < 4.5 && b.d > lo - 0.9 && b.d < hi + 0.9) oncoming++;
        if (bv0 < -0.2 || bv0 > v * 0.96) continue;     // coming the other way, or not slower
        let blo = b.d - AGENT_R, bhi = b.d + AGENT_R;
        if (b.mob) { blo -= b.extLo; bhi += b.extHi; }
        if (bhi < lo - 0.2 || blo > hi + 0.2) continue;
        const gap = xb - front - (b.mob ? b.extS : 0);
        // (somebody standing right in the way: walked round, not followed)
        if (bv0 < 0.2) { if (gap < 2.4 && gap < sGap) { sGap = gap; stand = b; } continue; }
        if (gap < best) { best = gap; bv = bv0; blk = b; }
      }
    }
  }
  // strangers do not walk on in step side by side for long: after a second and a half one of
  // them drifts ahead and the other drops back (the slower by nature falls in behind)
  if (twin) {
    a.abT += 0.25;
    if (a.abT > 1.5 && a.paceKT < t) {
      const B = twin.leader || twin;
      const slower = a.v0 < B.v0 - 0.01 || (Math.abs(a.v0 - B.v0) <= 0.01 && a.serial < B.serial);
      a.paceK = slower ? c.rng.range(0.86, 0.91) : c.rng.range(1.08, 1.12);
      a.paceKT = t + c.rng.range(5, 9);
      a.abT = 0;
      c.tally('unpair');
    }
  } else a.abT = Math.max(0, a.abT - 0.25);
  const strip = stripOf(c, a), sLo = strip.lo, sHi = strip.hi;
  a.freeW = Math.max(0.4, sHi - sLo - 0.6 * Math.max(0, abreast - 0) - 0.75 * oncoming);
  // somebody standing in the way before any slower walker: round them
  if (stand && sGap < best) { blk = stand; best = sGap; bv = 0; }
  if (!blk) { a.hwV = 99; return; }
  if (a.ovT > t) { a.hwV = Math.max(bv + 0.25, bv + (best - 0.9) * 0.8); return; }
  // room to pass beside it (and its group)? on its left first (people keep right)
  const B = blk.leader || blk;
  let glo = B.d - AGENT_R - (B.mob ? B.extLo : 0), ghi = B.d + AGENT_R + (B.mob ? B.extHi : 0);
  for (const m of B.followers) { glo = Math.min(glo, m.d - AGENT_R); ghi = Math.max(ghi, m.d + AGENT_R); }
  const half = (hi - lo) / 2, cOff = (lo + hi) / 2 - a.d;
  const pL = glo - half - 0.3, pH = ghi + half + 0.3;
  for (const cc of dir > 0 ? [pL, pH] : [pH, pL]) {
    if (cc - half < sLo || cc + half > sHi) continue;
    if (!lineFree(c, a, B, cc - half, cc + half, look + 3)) continue;
    a.ovD = cc - cOff; a.ovT = t + Math.min(8, Math.max(2.5, (best + 3 + 0.8 * B.followers.length) / Math.max(0.2, v - bv)));
    a.laneTT = 0; a.hwV = 99;
    c.tally('overtake');
    return;
  }
  // no room: straight behind it, about 1.3 s back (somebody standing: avoidance gets round)
  if (bv === 0) { a.hwV = 99; return; }
  const G = Math.max(1.5, 1.3 * bv);
  a.hwV = Math.max(0, Math.min(v * 1.2, bv + (best - G) * 0.8));
}

/** Is the line [dLo, dHi] free of people (not of a's group or group B) for len metres ahead of a? */
function lineFree(c, a, B, dLo, dHi, len) {
  const st = c.steering, agents = c.population.agents, dir = a.dir || 1;
  const sA = Math.min(a.s - dir, a.s + dir * len), sB = Math.max(a.s - dir, a.s + dir * len);
  const ix0 = Math.max(0, Math.floor((sA - st.s0) / CELL)), ix1 = Math.min(st.nx - 1, Math.floor((sB - st.s0) / CELL));
  const iy0 = Math.max(0, Math.floor((dLo - 1 + GRID_D) / CELL)), iy1 = Math.min(st.ny - 1, Math.floor((dHi + 1 + GRID_D) / CELL));
  for (let x = ix0; x <= ix1; x++) {
    for (let y = iy0; y <= iy1; y++) {
      for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
        const b = agents[j];
        if (b === a || b.leader === a || b === B || b.leader === B || !b.active) continue;
        const xb = (b.s - a.s) * dir;
        if (xb < -1 || xb > len) continue;
        if (b.d + AGENT_R > dLo && b.d - AGENT_R < dHi) return false;
      }
    }
  }
  // (and clear of poles and trunks along it)
  const n = c.map.gatherCircles(a.s + dir * len * 0.5, len * 0.5);
  for (let q = 0; q < n; q++) {
    const i = c.map.qI[q], od = c.map.cD[i], r = c.map.cR[i];
    if (od + r > dLo && od - r < dHi) return false;
  }
  return true;
}

/** Parents wait for a child that has fallen behind (a pole, a crowd, a corner). */
function waitForChild(c, a, out) {
  let far = 0, who = null;
  const F = a.followers;
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    if (!f.isChild) continue;
    const fs = f.s - a.s, fd = f.d - a.d, dd = Math.sqrt(fs * fs + fd * fd);
    if (dd > far) { far = dd; who = f; }
  }
  if (far < 2.6) return;
  const k = Math.max(0, 1 - (far - 2.6) / 1.6);
  out.vs *= k; out.vd *= k;
  if (who) a.lookGoal = Math.max(-1.1, Math.min(1.1, (Math.sign((who.d - a.d) * (a.dir || 1)) || 1) * 1.0));
}

/** Standing: no motion, except a short sidestep (the tram passing, the bell). */
function standStill(c, a, out) {
  out.vs = 0; out.vd = 0;
  if (a.dodgeT > c.time) {
    const e = a.dodgeD0 + a.dodge - a.d;
    if (Math.abs(e) > 0.05) { out.vd = Math.max(-0.7, Math.min(0.7, e * 2.5)); return; }
  }
  a.moving = false;
}

function toSpot(a, s, d, out) {
  const es = s - a.s, ed = d - a.d, e = Math.sqrt(es * es + ed * ed);
  if (e < 0.18) { out.vs = 0; out.vd = 0; a.moving = false; return; }
  const sp = Math.min(0.9, e * 1.6 + 0.2);
  out.vs = (es / e) * sp; out.vd = (ed / e) * sp;
}

/** A turn-around while walking: slow down, look round, walk a small arc. */
function uturn(c, a, out) {
  a.uturnT -= c.dt;
  const u = 1 - a.uturnT / UTURN_T;
  const dir0 = a.uturnDir;
  a.lookGoal = -a.uturnSgn * dir0 * 0.9;
  if (u < 0.22) {
    const k = 1 - (u / 0.22) * 0.65;
    out.vs = dir0 * a.v0 * k; out.vd *= 0.5;
  } else {
    const th = PI * Math.min(1, (u - 0.22) / 0.78);
    const sp = 0.42 + 0.25 * Math.abs(Math.cos(th));
    out.vs = dir0 * Math.cos(th) * sp;
    out.vd = a.uturnSgn * Math.sin(th) * sp;
  }
  if (a.uturnT <= 0) {
    a.uturnT = 0; a.dir = -dir0; a.laneTT = 0; a.lookGoal = 0;
    for (const f of a.followers) { f.baseF = -f.baseF; f.baseR = -f.baseR; }  // everyone turns where they are
  }
}

export function startUturn(c, a) {
  if (a.uturnT > 0 || a.state !== ST.WALK) return;
  const side = a.side, map = c.map;
  const mid = side * (map.bandInAt(a.s, side) + map.bandOutAt(a.s, side)) / 2;
  a.uturnSgn = Math.sign(mid - a.d) || 1;
  a.uturnDir = a.dir;
  a.uturnT = UTURN_T;
  c.tally('uturn');
}

/** Group members keep a slot beside / behind their leader. The slot wanders slowly. The
 *  formation follows the room the group really has (the sidewalk band, or the strip of the
 *  corridor the trams leave free, less the people walking beside it): the loose formation,
 *  two abreast with the others a step behind, or single file (also when a member gets stuck). */
function follow(c, a, out) {
  const L = a.leader, t = c.time;
  // the slot's slow wander and the pace drift (periods of seconds): refreshed four times a second
  a.fwTT -= c.dt;
  if (a.fwTT <= 0) {
    a.fwTT = 0.25;
    followNoise(c, a);
  }
  // a leader committed to crossing the ride track takes the group across with it
  if (L.crossOK > t && a.crossOK < L.crossOK && Math.abs(a.d - L.d) < 3) a.crossOK = L.crossOK;
  // a leader walking along a platform takes the group up onto it
  if (L.platformOK && L.platSt && !a.platformOK) { a.platformOK = true; a.platSt = L.platSt; a.platSide = L.platSide; }
  const lStop = L.state === ST.STAND || L.state === ST.WAIT || L.state === ST.PLATFORM;
  let ts, td, own = false;
  if (lStop && L.task === TASK.CHAT && a.task === TASK.CHAT) { ts = a.chatS; td = a.chatD; }
  else {
    let F = a.baseF, R = a.baseR;
    const walking = L.state === ST.WALK, n = L.nFollow;
    const W = walking ? Math.min(L.bandW, L.freeW) : 9;
    const single = walking && W < (n >= 2 ? 1.8 : 1.4);
    const twoOne = walking && !single && n >= 2 && W < 2.6;
    const rank = Math.max(0, L.followers.indexOf(a));
    if (a.singleT > t || single) {
      F = a.isChild ? -0.55 : -0.85 * (rank + 1); R = 0;
    } else if (twoOne && rank > 0 && !a.isChild) {
      // two abreast, the others staggered 1.0-1.5 m behind them
      F = -(1.0 + 0.5 * ((a.wSeed & 15) / 15)) - 0.9 * (rank - 1); R = 0.3 * Math.sign(a.baseR || 1) * ((a.wSeed >> 4 & 1) ? 1 : -0.4);
    } else if (!lStop) {
      F += a.fwF;
      R += a.fwR;
    }
    // leader frame: walking direction on the lane, the body facing otherwise (crossing, browsing)
    const th = L.state === ST.WALK ? ((L.uturnT > 0 ? L.uturnDir : L.dir) > 0 ? 0 : PI) : L.alpha;
    const cf = Math.cos(th), sf = Math.sin(th);
    ts = L.s + cf * F - sf * R; td = L.d + sf * F + cf * R;
    // still inside a side street: out through its opening first (not into the corner)
    {
      const as = a.d >= 0 ? 1 : -1, m = c.map.mouthAtA(a);
      if (m && !a.inDoor && Math.abs(a.d) > c.map.mouthLine(m, as) + 0.15) {
        const ms = c.unwrap(m.s), half = Math.max(0.3, m.width / 2 - 1.6);
        if (Math.abs(a.s - ms) < m.width / 2) ts = Math.max(ms - half, Math.min(ms + half, ts));
      }
    }
    // keep the slot out of café / platform footprints and off the walls (outside a cross street
    // opening)
    const side = td >= 0 ? 1 : -1, map = c.map, Q = map.Q;
    Q[0] = ts; Q[1] = td >= 0 ? td : -td;
    map.spotQuery(side, 0.35);
    if (!a.noRect && Q[2] >= 0 && !(a.platformOK && map.stationAt(ts))) td = side * Q[2];
    const wall = Q[3] - 0.1;
    if (Math.abs(td) > wall && !a.inDoor) td = side * wall;
    // with a tram near (the cab's, an oncoming unit, or both), nobody's slot is next to its
    // track (or across it from this member)
    if (!a.clearing) {
      const iv = c.tram.keepOut(a, true);
      if (iv) {
        const lo = iv.lo, hi = iv.hi;
        const across = (a.d <= lo && td > lo) || (a.d >= hi && td < hi);
        if (across || (td > lo && td < hi)) {
          // on the side of the band this member is on (never across it to join the leader)
          const pref = L.d > (lo + hi) / 2 && !(c.map.stationAt(L.s) && a.kind !== KIND.PASSENGER && hi > RIDE_D + 1);
          td = keepSide(c, a, pref) ? hi + 0.1 : lo - 0.1;
          own = true;
        }
      }
    }
  }
  a.gd = td;
  const es = ts - a.s, ed = td - a.d;
  const k = 0.8;
  const pace = 1 + 0.04 * a.lnN;
  // the leader's sideways motion is copied only while the member is really in its slot
  out.vs = L.vs * pace + es * k; out.vd = (own ? 0 : L.vd) + ed * k;
  const sp = Math.sqrt(out.vs * out.vs + out.vd * out.vd);
  // (the leader's speed counts only up to a run: a shove it got is not copied)
  const lim = Math.max(a.v0 * 1.35, Math.min(2.6, Math.sqrt(L.vs * L.vs + L.vd * L.vd)) * 1.2);
  if (sp > lim) { out.vs *= lim / sp; out.vd *= lim / sp; }
  out.vmax = lim;
  // mirror the leader's stops
  a.state = lStop ? (L.state === ST.WAIT ? ST.WAIT : ST.STAND) : ST.WALK;
  if (lStop) {
    if (Math.sqrt(es * es + ed * ed) < 0.3) { out.vs = 0; out.vd = 0; a.moving = false; }
    // own facing: conversations and window shopping set it on arrival; otherwise near the leader's
    if (L.task !== TASK.CHAT && L.task !== TASK.BROWSE) a.faceA = L.faceA + a.faceJ;
    if (a.dodgeT > t && !a.moving) standStill(c, a, out);
  }
  a.dir = L.dir; a.side = L.side;
  if (a.clearing) {
    const sp2 = c.tram.clearSpeed(a);
    out.vd = Math.sign(a.clearTo - a.d) * sp2;
    out.vs *= 0.5;
    out.vmax = Math.max(out.vmax, sp2 * 1.1);
    a.moving = true;
  }
}

// ------------------------------------------------------------------ helpers

function goTo(a, s, d, tol = 0.3) { a.state = ST.GOTO; a.gs = s; a.gd = d; a.gTol = tol; }
// (inDoor is cleared by the steering once the body is out of the door recess)
function walk(a) { a.state = ST.WALK; a.task = TASK.NONE; a.step = 0; a.laneTT = 0; a.uturnT = 0; }
function stand(a, faceA, t) { a.state = ST.STAND; a.faceA = faceA; a.timer = t; }
const faceTowards = (fromS, fromD, toS, toD) => Math.atan2(toD - fromD, toS - fromS);
const faceFacade = (side) => (side > 0 ? PI / 2 : -PI / 2);
const faceStreet = (side) => (side > 0 ? -PI / 2 : PI / 2);
/** No stops close to the ride track (people do not linger beside a tram line). */
const nearRide = (a) => Math.abs(a.d - RIDE_D) < BAND + 1.2;

/** A point at (s, |d|) on side clear of circle obstacles (pole line, trees…)? */
function clearSpot(c, s, d, r = 0.62) {
  let ok = true;
  c.map.gatherCircles(s, 2.5);
  for (let k = 0; k < c.map.qN; k++) {
    const i = c.map.qI[k];
    const ds = c.map.qDS[k], dd = c.map.cD[i] - d;
    if (ds * ds + dd * dd < (c.map.cR[i] + r) ** 2) { ok = false; break; }
  }
  return ok;
}

const CROSS_OFFSETS = [0, 1.3, -1.3, 2.6];
function findCrossS(c, s, side, a = null) {
  for (const off of CROSS_OFFSETS) {
    if (clearSpot(c, s + off, side * crossEdge(side, a), a && a.mob ? 0.9 : 0.62)) return s + off;
  }
  return null;
}

/** Usable door of opening o (unwrapped door centre, half-range for a body, recess depth) or null. */
export function doorOf(c, o) {
  const dr = o.door;
  if (!dr || dr.half < 0.4) return null;
  const s = c.unwrap(dr.s);
  const half = Math.max(0.05, dr.half - 0.25);
  return { s, s0: s - half, s1: s + half, depth: dr.depth, o, oS: c.unwrap(o.s) };
}

// ------------------------------------------------------------------ think

export function think(c, a) {
  const r = c.rng;
  if (a.mob === MOB.CYCLE) { thinkCycle(c, a); return; }
  a.thinkT = r.range(0.7, 1.3);
  // far up a side street and out of sight: gone
  if (a.task === TASK.SIDE_OUT && a.step >= 2 && a.sideX > 34 && !a.leader && c.side.groupHidden(a)) { c.population.vanish(a); return; }
  // (walking a lane out in a side street, after a task gave up there: on along the side street)
  if (a.inSide && a.sideX > 2 && a.state === ST.WALK && !a.leader && !a.mob && c.side.resume(a)) return;
  if (a.simple) { thinkFar(c, a); return; }
  switch (a.state) {
    case ST.WALK:
      if (!a.leader) thinkWalk(c, a);
      else thinkFollower(c, a);
      break;
    case ST.SEATED:
      if (a.timer <= 0 && !a.leader && !a.guardian) leaveSeat(c, a);
      else if (r.chance(0.08)) a.lookGoal = r.range(-0.9, 0.9);
      break;
    case ST.PLATFORM: thinkPassenger(c, a); break;
    case ST.STAND:
      if (a.task === TASK.CHAT) {
        // turn to whoever is talking now and then
        if (r.chance(0.18)) a.lookGoal = r.range(-0.7, 0.7);
      } else if (r.chance(0.1)) a.lookGoal = r.range(-0.6, 0.6);
      break;
    default: break;
  }
}

/** Far away (a few pixels tall): only leaving the street beyond the populated range. */
function thinkFar(c, a) {
  if (a.state !== ST.WALK || a.leader || a.task !== TASK.NONE || a.kind !== KIND.WALKER) return;
  if (a.mob) { maybeMount(c, a); return; }
  if (a.s - c.camU < RANGE_AHEAD - 30 || a.dir < 0) return;
  const r = c.rng;
  const m = c.map.mouthAt(a.s + a.dir * 7, a.side);
  if (m && m !== a.mouth) { a.mouth = m; if (r.chance(0.7) && startSideOut(c, a, m)) return; }
  if (r.chance(0.35)) startEnter(c, a);
}

/** Group members chat while walking: heads turn to a neighbour now and then. */
function thinkFollower(c, a) {
  const r = c.rng, L = a.leader;
  if (r.chance(0.22)) {
    // one of the others (the leader or another follower)
    const F = L.followers, n = F.length;
    let k = Math.floor(r.next() * n);
    const o = k >= n || F[k] === a ? L : F[k];
    const oR = o === L ? 0 : o.baseR;
    a.lookGoal = (Math.sign(a.baseR - oR) || 1) * r.range(0.3, 0.8);
  } else if (r.chance(0.3)) a.lookGoal = 0;
}

function thinkWalk(c, a) {
  const r = c.rng, map = c.map, side = a.side;
  if (a.uturnT > 0 || a.inDoor) return;
  const mob = a.mob;
  // walking a bicycle: back on it where the way is free
  if (mob === MOB.WALKBIKE && maybeMount(c, a)) return;
  // a stroller / bicycle does not fit between packed café tables and the poles: the far half of
  // the corridor (left side), over to the other side, or back the way they came
  if (mob && a.lane === LANE.SIDE && !a.leader && avoidNarrow(c, a)) return;
  // waiting on the far side of the ride track for the tram to pass: no sidewalk errands yet
  const offSide = a.side > 0 ? a.d < RIDE_D + BAND : a.d > RIDE_D - BAND;
  if (a.lane !== LANE.CORR && !offSide) {
    // cross streets just ahead
    const look = a.s + a.dir * 7;
    const mine = map.mouthAt(look, side), other = map.mouthAt(look, -side);
    if (mine && mine !== a.mouth) {
      a.mouth = mine;
      if (r.chance(mob ? 0.2 : 0.32) && startSideOut(c, a, mine)) return;
      if (mine.side === 0 && r.chance(0.35) && startCross(c, a, c.unwrap(mine.s) + r.range(-1, 1) * mine.width * 0.3, TASK.SIDE_OUT, mine)) return;
      if (r.chance(0.3) && startCross(c, a, c.unwrap(mine.s) + r.range(-1, 1) * mine.width * 0.3, TASK.NONE, null)) return;
      if (r.chance(0.06)) { startUturn(c, a); return; }  // changed their mind at the corner
    } else if (other && other !== a.mouth) {
      a.mouth = other;
      if (r.chance(0.45) && startCross(c, a, c.unwrap(other.s) + r.range(-1, 1) * other.width * 0.3, r.chance(0.5) ? TASK.SIDE_OUT : TASK.NONE, other)) return;
    }
    if (a.lane === LANE.SIDE) {
      // (in the evening fewer errands in the shops)
      const ev = c.population.tod.evening;
      if (mob !== MOB.WALKBIKE && r.chance(0.016 * (1 - 0.4 * ev)) && startBrowse(c, a)) return;
      if (!mob && r.chance(0.006 * (1 - 0.5 * ev)) && startEnter(c, a)) return;
      if (!mob && a.nFollow === 0 && r.chance(0.02) && c.counts.seated < MAX_SEATED - 4 && startSit(c, a)) return;
      // drift over to the shop windows for a few steps, without stopping (not with a bicycle)
      if (mob !== MOB.WALKBIKE && r.chance(0.02) && a.driftT < c.time) { a.driftT = c.time + r.range(3, 7); a.driftF = r.range(0.8, 0.97); a.lookGoal = (a.dir * side > 0 ? -1 : 1) * r.range(0.5, 1.0); }
    }
    if (!mob && a.nFollow === 0 && r.chance(0.06) && startPlatform(c, a)) return;
  }
  // (with a stroller: no crossing in the middle of a block)
  if (mob !== MOB.STROLLER && r.chance(0.0018) && startCross(c, a, a.s + a.dir * r.range(3, 8), TASK.NONE, null)) return;
  // people stop to talk, wait for somebody, take a call: more often while too few are standing
  // about near the camera (the street ahead should always have its share of standing people)
  const need = Math.max(0, (STAND_NEAR - c.counts.stand300 - 0.3 * c.counts.standFar) / STAND_NEAR) * (a.s - c.camU > 0 ? 1 : 0);
  if (!mob && a.nFollow > 0 && r.chance(0.001 + 0.03 * need) && c.counts.stand < STANDER_TARGET * 2 && startChat(c, a)) return;
  if (!mob && a.nFollow === 0 && r.chance(0.001 + 0.015 * need) && !nearRide(a) && Math.abs(a.d) > TRACK_ZONE_HALF && startPause(c, a)) return;
  // lane drift and the odd change of mind
  if (r.chance(0.05)) a.laneF = Math.min(0.97, Math.max(0.03, a.laneF + r.normal(0, 0.18)));
  if (r.chance(0.012)) setLane(c, a, r);
  if (r.chance(0.0003)) { startUturn(c, a); return; }
  if (a.driftT > c.time) return;
  if (a.nFollow > 0 && r.chance(0.15)) {
    const f = r.pick(a.followers);
    a.lookGoal = (Math.sign(-f.baseR) || 1) * r.range(0.3, 0.8);
  } else if (r.chance(0.12)) a.lookGoal = r.chance(0.5) ? (a.dir * side > 0 ? -1 : 1) * r.range(0.3, 0.9) : r.range(-0.35, 0.35);
  else if (r.chance(0.2)) a.lookGoal = 0;
}

/** A narrow sidewalk (café terrace up to the tree line) ahead of a stroller / walked bicycle. */
function avoidNarrow(c, a) {
  const map = c.map, side = a.side, r = c.rng;
  map.bandAhead(a.s, side, a.dir * 16, tmpBand);
  if (tmpBand.hi - tmpBand.lo > 1.3) return false;
  if (side < 0) {
    a.lane = LANE.CORR; a.laneD = -r.range(1.0, TRACK_ZONE_HALF - 0.6); a.laneTT = 0;
    c.tally('mobToCorridor');
    return true;
  }
  if (startCross(c, a, a.s - a.dir * 2, TASK.NONE, null)) { c.tally('mobCrossNarrow'); return true; }
  startUturn(c, a);
  c.tally('mobTurnNarrow');
  return a.uturnT > 0;
}

/** Pick a lane for a walker on its current side. */
export function setLane(c, a, r, forceSide = false) {
  const p = r.next();
  a.laneTT = 0;
  if (a.mob === MOB.CYCLE) return;
  if (a.mob) {
    // a stroller / a walked bicycle: the sidewalk, or (on the left) the far half of the corridor
    if (forceSide || a.side > 0 || p < 0.78) { a.lane = LANE.SIDE; a.laneF = r.range(0.06, 0.9); }
    else { a.lane = LANE.CORR; a.laneD = -r.range(1.0, TRACK_ZONE_HALF - 0.55); }
    return;
  }
  // (a hot day: on the sunlit side people keep to the shade of the tree crowns)
  const sun = !forceSide && c.population._shadeK(a.s, a.side) < 0.97;
  if (forceSide || p < (sun ? 0.5 : 0.6)) { a.lane = LANE.SIDE; a.laneF = sun ? r.range(0.04, 0.45) : r.range(0.04, 0.96); }
  else if (p < 0.8) { a.lane = LANE.EDGE; a.laneF = r.next(); }
  else {
    a.lane = LANE.CORR;
    // the shared track corridor; the ride track's half is cleared whenever the tram comes
    a.laneD = a.side * r.range(0.35, TRACK_ZONE_HALF - 0.45);
  }
}

// ------------------------------------------------------------------ tasks

/** A walker stops for a while out of the walking line: waiting by a door, leaning by a pole or
 *  tree, at a shop window for longer than a glance, or on the phone at the edge of the sidewalk. */
function startPause(c, a) {
  const r = c.rng, map = c.map, side = a.side;
  if (a.lane === LANE.CORR || a.platformOK || a.inDoor || a.inSide || map.stationAt(a.s)) return false;
  const u = r.next(), at = a.s + a.dir * 6;
  if (u < 0.28) {
    // by a door, waiting for somebody
    const ops = map.openingsAt(at, side);
    if (ops) {
      for (const o of ops) {
        const dr = doorOf(c, o);
        if (!dr) continue;
        const ahead = (dr.s - a.s) * a.dir;
        if (ahead < 2 || ahead > 12 || map.cafeAtS(dr.s, side)) continue;
        const js = dr.s + (r.chance(0.5) ? 1 : -1) * (dr.s1 - dr.s + 0.7);
        const gd = side * (map.wallMin(js, side, 0.4) - 0.1);
        if (!clearSpot(c, js, gd, 0.45) || map.rectInner(js, side, Math.abs(gd), 0.3)) continue;
        a.task = TASK.PAUSE; a.step = 0; a.pauseFace = faceStreet(side) + r.range(-0.6, 0.6); a.pauseT = r.range(15, 60);
        a.pauseK = PAUSE.DOOR;
        goTo(a, js, gd, 0.3);
        c.tally('pauseDoor');
        return true;
      }
    }
  } else if (u < 0.45) {
    // beside a pole or a tree trunk, on the sidewalk side of it
    const n = map.gatherCircles(at, 5);
    for (let q = 0; q < n; q++) {
      const i = map.qI[q], od = map.cD[i], cr = map.cR[i];
      if ((od >= 0 ? 1 : -1) !== side || Math.abs(od) < TRACK_ZONE_HALF + 0.3 || cr > 0.45) continue;
      const os = at + map.qDS[q], ahead = (os - a.s) * a.dir;
      if (ahead < 2 || ahead > 11) continue;
      const gs = os + r.range(-0.12, 0.12), gd = od + side * (cr + AGENT_R + 0.17);
      if (Math.abs(gd) > map.wallAt(gs, side) - 0.6 || map.rectInner(gs, side, Math.abs(gd), 0.35)) continue;
      a.task = TASK.PAUSE; a.step = 0; a.pauseT = r.range(10, 45); a.pauseK = PAUSE.POLE;
      a.pauseFace = r.chance(0.5) ? faceStreet(side) + r.range(-0.7, 0.7) : (a.dir > 0 ? 0 : PI) + r.range(-0.8, 0.8);
      goTo(a, gs, gd, 0.25);
      c.tally('pausePole');
      return true;
    }
  } else if (u < 0.62 && startBrowse(c, a, r.range(12, 35))) return true;
  // on the phone (or just waiting) where they are, stepped out of the walking line
  const bi = map.bandInAt(a.s, side), bo = map.bandOutAt(a.s, side);
  if (bo - bi < 1.6) return false;
  const toFac = r.chance(0.55);
  const gs = a.s + a.dir * r.range(1.2, 2.5), gd = side * (toFac ? bo - 0.1 : bi + 0.35);
  if (!clearSpot(c, gs, gd, 0.5)) return false;
  a.task = TASK.PAUSE; a.step = 0; a.pauseT = r.range(12, 50); a.pauseK = PAUSE.PHONE;
  a.pauseFace = toFac ? faceStreet(side) + r.range(-0.9, 0.9) : r.range(-PI, PI);
  goTo(a, gs, gd, 0.35);
  c.tally('pausePhone');
  return true;
}

function startBrowse(c, a, dur = 0) {
  const map = c.map, side = a.side;
  const ops = map.openingsAt(a.s + a.dir * 6, side);
  if (!ops) return false;
  for (const o of ops) {
    const sO = c.unwrap(o.s);
    const ahead = (sO - a.s) * a.dir;
    if (o.kind !== 'shop' || ahead < 2 || ahead > 11) continue;
    if (map.cafeAtS(sO, side)) continue;
    const wall = map.wallAt(sO, side);
    if (map.bandOutAt(sO, side) < wall - 0.9) continue;
    // with a stroller: a step back, the stroller between them and the window
    const back = a.mob === MOB.STROLLER ? 1.4 : 0.3;
    const gs = sO + c.rng.range(-0.5, 0.5) * o.half, gd = side * ((a.mob ? map.wallMin(sO, side, 1.5) : wall) - back);
    if (!clearSpot(c, gs, gd, 0.45)) continue;
    a.task = TASK.BROWSE; a.step = 0; a.pauseT = dur;
    goTo(a, gs, gd, 0.3);
    c.tally('browse');
    return true;
  }
  return false;
}

/** Walk to a shop / house door ahead and go in (only where nobody sees the body go through it). */
export function startEnter(c, a) {
  const map = c.map, side = a.side;
  if (a.inDoor) return false;
  const ops = map.openingsAt(a.s + a.dir * 6, side);
  if (!ops) return false;
  for (const o of ops) {
    const dr = doorOf(c, o);
    if (!dr) continue;
    const ahead = (dr.s - a.s) * a.dir;
    if (ahead < 2 || ahead > 12) continue;
    if (map.cafeAtS(dr.s, side)) continue;
    const wall = map.wallAt(dr.s, side);
    if (!clearSpot(c, dr.s, side * (wall - 0.3), 0.45)) continue;
    a.task = TASK.ENTER; a.step = 0;
    c.tally('enterShop');
    a.door = dr; a.doorS0 = dr.s0; a.doorS1 = dr.s1;
    goTo(a, dr.s, side * (wall - 0.2), 0.3);
    return true;
  }
  return false;
}

/** Turn into a side street on the agent's side and vanish there once out of sight. */
export function startSideOut(c, a, m) {
  const side = a.side;
  const ms = c.unwrap(m.s);
  const line = c.map.mouthLine(m, side);
  let slotX = c.rng.range(-1, 1) * (m.width / 2 - 1.4);
  // with a stroller / bicycle: in through a gap in the bollards across the mouth wide enough for it
  if (a.mob) {
    const gx = c.population._mouthGap(ms, m, side, line, slotX, a.mob, false);
    if (gx === null) return false;
    slotX = gx;
  }
  a.mouth = m; a.task = TASK.SIDE_OUT; a.step = 0;
  c.tally('intoSideStreet');
  a.slotX = slotX;
  goTo(a, ms + a.slotX, side * (line - 0.7), 0.6);
  return true;
}

/** Cross the track corridor at sE (diagonally), then continue with `after`. */
export function startCross(c, a, sE, after, mouth) {
  const map = c.map;
  // cross from the side of the ride track the agent is really on
  const side = a.d > RIDE_D + BAND ? 1 : a.d < RIDE_D - BAND ? -1 : a.side;
  if (map.stationAt(sE) || map.stationAt(sE + a.dir * 12)) return false;
  const s0 = findCrossS(c, sE, side, a);
  if (s0 === null) return false;
  const sT = mouth ? c.unwrap(mouth.s) + c.rng.range(-1, 1) * (mouth.width / 2 - 1.5) : s0 + a.dir * c.rng.range(0, 11);
  const s1 = findCrossS(c, sT, -side, a);
  if (s1 === null || map.stationAt(s1)) return false;
  a.task = TASK.CROSS; a.after = after; a.mouth = mouth || a.mouth;
  a.crossS = s1; a.side = side;
  c.tally(mouth || map.mouthAt(sE, side) || map.mouthAt(sE, -side) ? 'crossAtCrossStreet' : 'crossMidBlock');
  if (Math.abs(a.d) < TRACK_ZONE_HALF) { a.step = 1; arrive(c, a); return true; } // already in the corridor
  a.step = 0;
  goTo(a, s0, side * crossEdge(side, a), 0.45);
  return true;
}

function startPlatform(c, a) {
  const st = c.map.stationAt(a.s + a.dir * 25);
  if (!st || c.counts.passenger >= MAX_PASSENGERS) return false;
  if (a.side > 0 && a.d < RIDE_D + BAND + 0.3) return false;   // not across the ride track
  const pl = st.platforms.find((p) => p.side === a.side);
  const feat = c.population.platformFeature(st, a.side);
  if (!pl || !feat || feat.count >= feat.cap) return false;
  const s0 = c.unwrap(pl.s0), s1 = s0 + (pl.s1 - pl.s0);
  const endS = a.dir > 0 ? s0 - 0.9 : s1 + 0.9;
  if ((endS - a.s) * a.dir < 2) return false;
  a.task = TASK.TO_PLATFORM; a.step = 0; c.population.joinPlatform(a, feat);
  c.tally('toPlatform');
  goTo(a, endS, a.side * (TRACK_ZONE_HALF + PLATFORM_W * 0.6), 0.6);
  return true;
}

function startSit(c, a) {
  if (a.isChild) return false;
  const cafe = c.map.cafeAtS(a.s + a.dir * 4, a.side);
  if (!cafe) return false;
  // (not at a terrace where somebody of the same character already sits or stands)
  if (c.population.charNear(a.charI, a.s + a.dir * 4, a.d, 9, a)) { c.tally('sitTwinSkipped'); return false; }
  const seat = c.population.freeChair(cafe, a);
  if (!seat) return false;
  a.task = TASK.SIT; a.step = 0; a.feature = seat;
  c.tally('takeSeat');
  goTo(a, seat.s, a.side * (cafe._crowdInner - 0.35), 0.5);
  return true;
}

function startChat(c, a) {
  const band = c.map.bandOutAt(a.s, a.side) - c.map.bandInAt(a.s, a.side);
  if (band < 2.2 || a.lane !== LANE.SIDE || nearRide(a)) return false;
  const members = c.population.groupOf(a);
  let cs = 0, cd = 0;
  for (const m of members) { cs += m.s; cd += m.d; }
  cs /= members.length; cd /= members.length;
  const t = c.rng.range(12, 60);
  const rad = members.length === 2 ? 0.45 : 0.58;
  for (const m of members) {
    m.task = TASK.CHAT;
    // a loose circle around the middle of the group, everyone facing it
    const ang = Math.atan2(m.d - cd, m.s - cs) + c.rng.range(-0.15, 0.15);
    m.chatS = cs + Math.cos(ang) * rad; m.chatD = cd + Math.sin(ang) * rad;
    stand(m, faceTowards(m.chatS, m.chatD, cs, cd) + c.rng.range(-0.2, 0.2), t);
  }
  a.task = TASK.CHAT;
  c.tally('chat');
  return true;
}

function leaveSeat(c, a) {
  const seat = a.feature;
  if (!seat) { walk(a); return; }
  c.population.releaseChair(seat);
  a.feature = null;
  a.kind = KIND.WALKER;
  a.task = TASK.LEAVE_SEAT; a.step = 0; a.noRect = true;
  c.tally('leaveSeat');
  goTo(a, seat.s + c.rng.range(-0.6, 0.6), seat.exitD, 0.4);
  // children at the table come along
  c.population.releaseWards(a);
}

function thinkPassenger(c, a) {
  const r = c.rng;
  if (r.chance(0.07)) a.faceA += r.range(-0.4, 0.4);
  if (r.chance(0.12)) a.lookGoal = r.chance(0.6) ? (a.side > 0 ? -1 : 1) * r.range(0.4, 1.1) : r.range(-0.5, 0.5);
  // the left platform is served by trams in the other direction: people come and go
  if (a.side < 0 && a.timer <= 0) {
    const pl = a.feature && a.feature.platform;
    if (!pl) return;
    const s0 = c.unwrap(pl.s0), s1 = s0 + (pl.s1 - pl.s0);
    a.task = TASK.ALIGHT; a.step = 0;
    goTo(a, a.s - s0 < s1 - a.s ? s0 - 1.0 : s1 + 1.0, -(TRACK_ZONE_HALF + PLATFORM_W * 0.5), 0.6);
  }
}

/** Passengers on the ride side board when the tram stands at their platform. */
export function board(c, a, doorS) {
  a.task = TASK.BOARD; a.step = 0;
  c.tally('board');
  goTo(a, doorS + c.rng.range(-0.5, 0.5), (a.side < 0 ? -1 : 1) * (TRACK_ZONE_HALF + 0.3), 0.3);
}

// ------------------------------------------------------------------ arrival

export function arrive(c, a) {
  const r = c.rng, map = c.map, side = a.side;
  switch (a.task) {
    case TASK.PAUSE:
      stand(a, a.pauseFace, a.pauseT > 0 ? a.pauseT : r.range(8, 25));
      a.step = 1; a.pauseT = 0;
      return;
    case TASK.BROWSE:
      a.step = 1;
      stand(a, faceFacade(side) + r.range(-0.25, 0.25), a.pauseT > 0 ? a.pauseT : r.range(4, 20));
      a.pauseT = 0;
      // companions look at their own bit of the window
      for (const f of a.followers) f.faceA = faceFacade(side) + r.range(-0.4, 0.4);
      return;
    case TASK.ENTER: {
      const dr = a.door;
      if (!dr) { walk(a); return; }
      if (a.step === 0) {
        a.step = 1; a.inDoor = true;
        // children go in hand in hand with their adult
        for (const f of a.followers) {
          if (!f.isChild) continue;
          f.task = TASK.ENTER; f.inDoor = true; f.door = dr; f.doorS0 = dr.s0; f.doorS1 = dr.s1;
        }
        goTo(a, dr.s, side * (dr.o.d + dr.depth - 0.1), 0.15);
        return;
      }
      if (a.step >= 1 && a.step < 20) {
        if (groupGone(c, a, side, dr.o.d, dr.oS - dr.o.half, dr.oS + dr.o.half)) { c.population.vanish(a); return; }
        // somebody is watching: wait at the door a little, then give up
        a.step++;
        stand(a, faceFacade(side), 1.2);
        return;
      }
      a.step = 0;
      a.task = TASK.EMERGE; a.door = null;
      for (const f of a.followers) f.task = TASK.NONE;
      goTo(a, a.s, side * (map.wallMin(a.s, side, 2) - 0.8), 0.4);
      return;
    }
    case TASK.SIDE_OUT: {
      // into the side street: across its mouth onto one of its sidewalks, then up it 40-60 m,
      // gone once out of sight there (or further on, at its far end at the latest)
      const m = a.mouth, ms = c.unwrap(m.s), sd = side > 0 ? 1 : -1;
      const g = c.side.get(m, sd);
      if (a.step === 0) {
        a.step = 1;
        a.sideA = c.side.laneA(g, r, Math.sign(a.slotX) || 0);
        goTo(a, ms + a.sideA, sd * (g.hw + 3.6), 0.6);
        return;
      }
      if (a.step === 1) {
        a.step = 2;
        a.sideEnd = r.range(40, 60);
        goTo(a, ms + a.sideA, sd * (g.hw + a.sideEnd), 0.8);
        return;
      }
      if (c.side.groupHidden(a)) { c.population.vanish(a); return; }
      if (a.step < 5) {
        a.step++;
        a.sideEnd = Math.min(g.len - 6, a.sideEnd + 15);
        goTo(a, ms + a.sideA, sd * (g.hw + a.sideEnd), 0.8);
        return;
      }
      if (c.vis.distance(a.s) > 140 || a.sideX > 80) { c.population.vanish(a); return; }
      stand(a, faceStreet(side), 2); // rare: in plain view at the far end of the side street, wait
      return;
    }
    case TASK.EMERGE:
      // out of a side street: along its sidewalk to the mouth first, then onto the main sidewalk
      if (a.step === -1 && a.mouth) {
        const m = a.mouth, line = map.mouthLine(m, side);
        // (held up on the way down the sidewalk: on along it first, not across the carriageway)
        if (a.sideX > 3 && (a.stuckN = (a.stuckN || 0) + 1) < 3) { goTo(a, a.gs, a.gd, 0.6); return; }
        a.stuckN = 0;
        a.step = 0;
        goTo(a, c.unwrap(m.s) + Math.max(-1, Math.min(1, (a.sideA || 0) / Math.max(1, m.width / 2))) * (m.width / 2 - 1.4) * r.range(0.4, 1), side * (line - r.range(0.8, 1.6)), 0.6);
        return;
      }
      walk(a);
      // still in the recess (gave up on a blocked goal): the door keeps bounding them until out
      a.inDoor = Math.abs(a.d) > map.facadeAt(a.s, side) - 0.35;
      if (r.chance(0.25) && startCross(c, a, a.s + a.dir * r.range(2, 6), TASK.NONE, null)) return;
      // out on the street: any lane of this side, the track corridor too (people arriving from
      // the far end walk the corridor as much as those coming up from behind the cab)
      if (!a.inDoor && !a.mob) setLane(c, a, r);
      return;
    case TASK.CROSS: {
      if (a.step === 0 || a.step === 1) {
        // at the corridor edge (or already inside): wait for a safe gap, unless already past the band
        const past = side > 0 ? a.d < RIDE_D - BAND : a.d > RIDE_D + BAND;
        // (and the oncoming units' track: crossed only with a safe gap too)
        const pastU = side < 0 && a.d > -RIDE_D + BAND;
        // at a junction the lights rule: wait at the kerb on red, and do not start on a flashing
        // green (whoever is already out on the corridor goes on across)
        if (!(past && pastU) && Math.abs(a.d) > TRACK_ZONE_HALF - 0.3) {
          const light = crossLight(c, a.s);
          if (light < 2) {
            if (a.step === 0) c.tally(light ? 'waitForFlash' : 'waitForRed');
            waitToCross(c, a, side);
            return;
          }
        }
        if ((!past && (!c.tram.canEnterBand(a, a.s) || !c.tram.canEnterBand(a, a.crossS)))
          || (!pastU && (!c.tram.canEnterUnit(a, a.s) || !c.tram.canEnterUnit(a, a.crossS)))) {
          if (a.step === 0) c.tally('waitForTram');
          waitToCross(c, a, side);
          return;
        }
        a.step = 2;
        // committed: walks through the bands (both tracks: the whole corridor)
        a.crossOK = past && pastU ? 0 : c.time + Math.max(c.tram.timeThrough(a), (Math.abs(a.d) + TRACK_ZONE_HALF + 0.6) / Math.max(0.9, a.v0) + 0.8) + 1.5;
        goTo(a, a.crossS, -side * crossEdge(-side, a), 0.5);
        return;
      }
      // gave up half way (stopped at the band by the tram): back to waiting on this side
      if (Math.sign(a.d) !== -side || Math.abs(a.d) < TRACK_ZONE_HALF - 0.5) {
        c.tally('crossRetry');
        waitToCross(c, a, side);
        return;
      }
      // reached the far side
      a.side = -side;
      if (a.after === TASK.SIDE_OUT && a.mouth && map.mouthAt(a.mouth.s, a.side) && startSideOut(c, a, a.mouth)) return;
      walk(a);
      setLane(c, a, r, true);
      if (r.chance(0.5)) a.dir = -a.dir;
      return;
    }
    case TASK.TO_PLATFORM: {
      const feat = a.feature;
      if (a.step === 0 && feat) {
        const spot = c.population.platformSpot(feat);
        if (!spot) { c.population.leavePlatform(a); walk(a); a.noRect = false; return; }
        a.step = 1; a.noRect = true;
        goTo(a, spot.s, spot.d, 0.3);
        return;
      }
      a.kind = KIND.PASSENGER; a.task = TASK.NONE;
      a.state = ST.PLATFORM;
      a.faceA = c.population.passengerFacing(side);
      a.timer = r.range(40, 200);
      return;
    }
    case TASK.BOARD: {
      if (c.vis.hidden(a.s, a.d)) { c.population.vanish(a); return; }
      const tram = c.tram;
      if (a.side < 0) {
        // an oncoming unit at the left platform: in through its doors where its body hides them
        const T = a.boardU >= 0 ? tram.unitById(a.boardU) : null;
        const pl = a.feature && a.feature.platform;
        if (T && pl && tram.unitDwelling(a.feature.station) === T) {
          if (tram.behindUnit(a.s, a.d)) { c.population.vanish(a); return; }
          // in view: along to a door further back (towards its rear, +s)
          const sMax = c.unwrap(pl.s1) - 1.2;
          const gs = Math.min(sMax, Math.max(a.s, T.sU + 3.5) + r.range(5, 8));
          a.step++;
          if (gs < a.s + 0.6 || a.step > 8) { stand(a, PI / 2, 0.8); return; }
          goTo(a, gs, -(TRACK_ZONE_HALF + 0.3), 0.35);
          return;
        }
        // it left without them: back to waiting
        a.boardU = -1;
        const spot = a.feature && c.population.platformSpot(a.feature);
        a.task = TASK.TO_PLATFORM; a.step = 1;
        if (spot) goTo(a, spot.s, spot.d, 0.3); else { a.state = ST.PLATFORM; a.task = TASK.NONE; a.timer = r.range(30, 120); }
        return;
      }
      if (!tram.stoppedAt) {
        // the tram left without them: back to waiting
        const spot = a.feature && c.population.platformSpot(a.feature);
        a.task = TASK.TO_PLATFORM; a.step = 1;
        if (spot) goTo(a, spot.s, spot.d, 0.3); else { a.state = ST.PLATFORM; a.task = TASK.NONE; a.timer = r.range(30, 120); }
        return;
      }
      // in view of the camera: walk on along the platform to a door further back
      const pl = a.feature && a.feature.platform;
      const sMin = pl ? c.unwrap(pl.s0) + 1.2 : a.s - 20;
      const gs = Math.max(sMin, Math.min(a.s, tram.trainU - 3.5) - r.range(5, 8));
      a.step++;
      if (gs > a.s - 0.6) { stand(a, PI, 0.8); return; }   // end of the platform: wait to be out of sight
      goTo(a, gs, TRACK_ZONE_HALF + 0.3, 0.35);
      return;
    }
    case TASK.ALIGHT: {
      if (a.step < 0) {
        // stepped off the tram: away from the platform edge first, then along to an end
        const pl = a.feature && a.feature.platform;
        a.step = 0;
        const end = !pl ? a.s - 20 : a.after > 0 ? c.unwrap(pl.s1) + 1.0 : c.unwrap(pl.s0) - 1.0;
        goTo(a, end, (side < 0 ? -1 : 1) * (TRACK_ZONE_HALF + PLATFORM_W * (a.after > 0 ? 0.62 : 0.5)), 0.7);
        return;
      }
      if (a.step === 0) {
        a.step = 1;
        const out = map.bandInAt(a.s, side) + 0.8;
        const pl = a.feature && a.feature.platform;
        const away = pl && a.s > c.unwrap((pl.s0 + pl.s1) / 2) ? 1.5 : -1.5;
        goTo(a, a.s + away, side * out, 0.6);
        return;
      }
      c.population.leavePlatform(a);
      a.kind = KIND.WALKER; a.noRect = false;
      walk(a);
      setLane(c, a, r, true);
      a.dir = r.chance(0.5) ? 1 : -1;
      return;
    }
    case TASK.SIT: {
      const seat = a.feature;
      if (a.step === 0 && seat) { a.step = 1; a.noRect = true; goTo(a, seat.s, seat.d, 0.12); return; }
      if (!seat) { walk(a); a.noRect = false; return; }
      a.kind = KIND.SEATED; a.state = ST.SEATED; a.task = TASK.NONE;
      a.vs = 0; a.vd = 0;
      a.seatS = seat.s; a.seatD = seat.d;   // the last few centimetres are eased in by the steering
      a.faceA = seat.faceA;
      a.timer = r.range(60, 600);
      return;
    }
    case TASK.SERVE:
      serveArrive(c, a);
      return;
    case TASK.LEAVE_SEAT:
      a.noRect = false;
      for (const f of a.followers) f.noRect = false;
      walk(a);
      setLane(c, a, r, true);
      a.dir = r.chance(0.5) ? 1 : -1;
      return;
    default:
      walk(a);
  }
}

/** The leader and the children at their side are all masked by the facade around an opening
 *  [sa, sb] in the building line lineD (children never stay behind on their own). */
function groupGone(c, a, side, lineD, sa, sb) {
  if (!c.vis.bodyHidden(a.s, a.d, side, lineD, sa, sb)) return false;
  for (const f of a.followers) if (f.isChild && !c.vis.bodyHidden(f.s, f.d, side, lineD, sa, sb)) return false;
  return true;
}

/** The pedestrian lights at the crossing of a cross street at s (catenary.pedState): 2 green
 *  (also where there are none), 1 flashing green (red within a few seconds), 0 red. Red while a
 *  tram is near the crossing or over it. */
export function crossLight(c, s) {
  const m = c.map.crossAt(s);
  if (!m) return 2;
  const cat = c.app.systems && c.app.systems.catenary;
  if (!cat || cat.disabled) return 2;
  try {
    if (typeof cat.pedState === 'function') { const v = cat.pedState(m.s); return v === 0 || v === 1 ? v : 2; }
    if (typeof cat.signalAt === 'function') { const v = cat.signalAt(m.s); return v === 'red' ? 0 : v === 'flash' ? 1 : 2; }
  } catch (e) { /* no lights */ }
  return 2;
}

/** Wait at the edge of the band, half turned towards the oncoming tram. Too close to the ride
 *  track (crossers that were inside the corridor): first back off to the waiting spot on the
 *  side of the band they are on. */
function waitToCross(c, a, side) {
  if (Math.abs(a.d - RIDE_D) < c.tram.passD + 0.2) {
    const cs = a.d > RIDE_D ? 1 : -1, wd = cs * crossEdge(cs, a);
    // a spot clear of the poles and trees (the way there passes between them)
    if (Math.abs(a.d - wd) > 0.4) { a.step = 0; goTo(a, findCrossS(c, a.s + a.dir * 0.5, cs, a) ?? a.s + a.dir * 2.2, wd, 0.45); return; }
  }
  a.step = 1;
  a.state = ST.WAIT; a.timer = 0.35;
  a.faceA = faceStreet(side) + (side > 0 ? -0.5 : 0.5);
  // a stroller or a bicycle waits alongside the corridor, not pointing into it
  if (a.mob) a.faceA = a.dir > 0 ? 0 : PI;
}

/** Countdown expiry for standing states. */
export function timerDone(c, a) {
  const r = c.rng;
  switch (a.state) {
    case ST.STAND:
      if (a.task === TASK.ENTER || a.task === TASK.SIDE_OUT || a.task === TASK.BOARD || a.task === TASK.SERVE) { a.state = ST.GOTO; arrive(c, a); return; }
      if (a.task === TASK.CHAT) {
        if (a.leader) return; // followers resume with their leader
        if (a.kind === KIND.STANDER) a.kind = KIND.WALKER;
        for (const m of c.population.groupOf(a)) { if (m !== a) { m.task = TASK.NONE; m.state = ST.WALK; if (m.kind === KIND.STANDER) m.kind = KIND.WALKER; } }
        if (r.chance(0.35)) flipGroup(a);
      } else if (a.task === TASK.BROWSE && r.chance(0.3)) flipGroup(a);
      // (a pause out in a side street: on along it)
      if (a.inSide && a.task === TASK.PAUSE && !a.leader && c.side.resume(a)) return;
      walk(a);
      if (a.lane === LANE.CORR && Math.abs(a.d) > TRACK_ZONE_HALF) setLane(c, a, r, true);
      return;
    case ST.WAIT:
      a.state = ST.GOTO;
      arrive(c, a);
      return;
    default: break;
  }
}

/** Standing group walks back the way it came: everyone turns where they stand. */
function flipGroup(a) {
  a.dir = -a.dir;
  for (const f of a.followers) { f.baseF = -f.baseF; f.baseR = -f.baseR; }
}

