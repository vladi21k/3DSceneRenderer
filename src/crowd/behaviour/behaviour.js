import { TRACK_ZONE_HALF } from '../../core/config.js';
import { noise1 } from '../../core/rng.js';
import { PLATFORM_W } from '../../world/layout.js';
import { KIND, ST, TASK, LANE, MOB } from './agent.js';
import { EDGE_LANE, RIDE_D, BAND, STANDER_TARGET, MAX_SEATED, MAX_PASSENGERS, RANGE_AHEAD } from './constants.js';
import { thinkCycle, maybeMount } from './cyclist.js';

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
const len2 = (x, y) => Math.sqrt(x * x + y * y);
const tmpBand = { lo: 0, hi: 0 };

// ------------------------------------------------------------------ lanes

/** Lateral target (signed d) for a lane-following walker. */
export function laneTarget(c, a) {
  let d = rawLane(c, a);
  // nobody walks a ruler-straight line: a slow personal wander across the lane
  d += 0.25 * noise1(a.s / 8, a.wSeed);
  if (a.dodgeT > c.time) d += a.dodge;
  return tramLane(c, a, d);
}

/** While the tram is near, lane targets keep a comfortable distance from the ride track, on
 *  the side of the band the walker is already on (nobody aims across a closed band). */
function tramLane(c, a, d) {
  const tram = c.tram;
  if (!tram.near(a)) return d;
  const pd = tram.passD;
  // a stroller / bicycle keeps the berth with its whole footprint
  const pdHi = pd + a.extLo, pdLo = pd + a.extHi;
  const dl = a.d - RIDE_D, tl = d - RIDE_D;
  // the lane lies across the ride track: walk on along this side until the tram has gone by
  const across = (dl <= -BAND && tl > -pdLo) || (dl >= BAND && tl < pdHi);
  if (!across && (tl >= pdHi || tl <= -pdLo)) return d;
  let hi = dl > BAND ? true : dl < -BAND ? false : d >= RIDE_D;
  if (hi && a.kind !== KIND.PASSENGER) {
    const st = c.map.stationAt(a.s) || c.map.stationAt(a.s + a.dir * 15);
    // beside a platform: behind it, up on it (caught at its edge), or between the tracks
    if (st) {
      if (dl <= BAND) return RIDE_D - pdLo - a.laneF * 1.1;
      if (a.platformOK || a.d < TRACK_ZONE_HALF + 0.8) return Math.max(RIDE_D + pdHi, TRACK_ZONE_HALF + 0.6) + a.laneF * 0.8;
      return c.map.bandInAt(a.s + a.dir * 10, 1) + 0.3;
    }
  }
  // a stroller / walked bicycle on the ride side waits on the sidewalk proper, not among the poles
  if (hi && a.mob) {
    const bi = c.map.bandInAt(a.s, 1), bo = c.map.bandOutAt(a.s, 1);
    if (bo - bi > 1.3) return Math.max(RIDE_D + pdHi, bi + 0.75);
  }
  return hi ? RIDE_D + pdHi + a.laneF * 0.35 : RIDE_D - pdLo - a.laneF * 1.1;
}

function rawLane(c, a) {
  const side = a.side, map = c.map;
  const here = map.stationAt(a.s);
  a.bandW = 9;
  // stepped up onto a platform to let the tram by: walk on along it to its end
  if (a.platformOK && here) return TRACK_ZONE_HALF + 0.6 + a.laneF * 1.4;
  // alongside a platform people in the corridor stay in it (the platform is in the way)
  if (here && Math.abs(a.d) < TRACK_ZONE_HALF + 0.25) {
    if (a.lane === LANE.CORR) return a.laneD;
    return -(0.7 + a.laneF * (TRACK_ZONE_HALF - 1.2));
  }
  if (a.lane === LANE.CORR) return a.laneD;
  const lf = a.driftT > c.time ? a.driftF : a.laneF;
  const st = here || map.stationAt(a.s + a.dir * 20);
  if (a.lane === LANE.EDGE && !st) return side * (EDGE_LANE + 0.4 * lf);
  // narrowest stretch of the sidewalk band around here (cafés, platforms), both ways
  const look = Math.max(7, 5 * a.v0);
  map.bandAhead(a.s - look, side, 2 * look, tmpBand);
  const w = tmpBand.hi - tmpBand.lo;
  a.bandW = w;
  if (w < 0.7) {
    // café furniture fills the sidewalk: people use the strip by the poles and trees, and on
    // the left also the track corridor
    if (st) return side * (tmpBand.lo + 0.2);
    if (side < 0 && a.laneF < 0.45) return -(0.9 + a.laneF * 4.5);
    return side * (EDGE_LANE + 0.1 + lf * 0.45);
  }
  // a stroller or a walked bicycle keeps clear of the benches and trunks along the tree line; a
  // bicycle walked on the person's right keeps its whole length off the shop fronts (or the trees)
  let extra = a.mob ? Math.min(0.45, Math.max(0, w - 1.0)) : 0, keep = 0;
  if (a.mob === MOB.WALKBIKE) {
    const facadeSide = a.dir * side > 0;
    const need = Math.min(0.85, Math.max(0, w - 1.2));
    if (facadeSide) keep = need; else extra = Math.max(extra, need);
  }
  return side * (tmpBand.lo + 0.3 + extra + Math.max(0, w - 0.6 - extra - keep) * lf);
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
        a.laneTT -= c.dt;
        if (a.laneTT <= 0) { a.laneT = laneTarget(c, a); a.laneTT = 0.25; }
        const e = a.laneT - a.d;
        // pace drifts a few percent over 5-15 s; heading jitters a few degrees
        const pace = a.v0 * (1 + 0.06 * noise1(c.time / a.paceT, a.wSeed + 11));
        let vs = a.dir * pace, vd = Math.max(-0.75, Math.min(0.75, e * 0.9));
        const j = 0.045 * noise1(c.time * 0.5, a.wSeed + 23) + 0.025 * noise1(c.time * 1.3, a.wSeed + 29);
        const cj = Math.cos(j), sj = Math.sin(j);
        out.vs = vs * cj - vd * sj; out.vd = vs * sj + vd * cj;
        a.gd = a.laneT;
        if (a.uturnT > 0) uturn(c, a, out);
        // a child fallen behind: slow down and wait for them, looking back
        if (a.nFollow) waitForChild(c, a, out);
        break;
      }
      case ST.GOTO: {
        const ds = a.gs - a.s, dd = a.gd - a.d;
        const dist = len2(ds, dd);
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
    out.vs *= 0.5;
    out.vmax = Math.max(out.vmax, sp * 1.1);
    a.moving = true;
  } else c.tram.filterDesired(a, out);
}

/** Parents wait for a child that has fallen behind (a pole, a crowd, a corner). */
function waitForChild(c, a, out) {
  let far = 0, who = null;
  for (const f of a.followers) {
    if (!f.isChild) continue;
    const dd = Math.hypot(f.s - a.s, f.d - a.d);
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
  const es = s - a.s, ed = d - a.d, e = len2(es, ed);
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

/** Group members keep a slot beside / behind their leader. The slot wanders slowly, the
 *  group goes single file where the sidewalk is narrow or a member gets stuck. */
function follow(c, a, out) {
  const L = a.leader, t = c.time;
  // a leader committed to crossing the ride track takes the group across with it
  if (L.crossOK > t && a.crossOK < L.crossOK && Math.abs(a.d - L.d) < 3) a.crossOK = L.crossOK;
  const lStop = L.state === ST.STAND || L.state === ST.WAIT || L.state === ST.PLATFORM;
  let ts, td, own = false;
  if (lStop && L.task === TASK.CHAT && a.task === TASK.CHAT) { ts = a.chatS; td = a.chatD; }
  else {
    let F = a.baseF, R = a.baseR;
    const narrow = L.bandW < (L.nFollow >= 2 ? 2.1 : 1.6) && L.state === ST.WALK;
    if (a.singleT > t || narrow) {
      const rank = Math.max(0, L.followers.indexOf(a));
      F = a.isChild ? -0.55 : -0.85 * (rank + 1); R = 0;
    } else if (!lStop) {
      F += 0.3 * noise1(t / a.wT, a.wSeed + 3);
      R += 0.15 * noise1(t / a.wT + 17.3, a.wSeed + 5);
    }
    // leader frame: walking direction on the lane, the body facing otherwise (crossing, browsing)
    const th = L.state === ST.WALK ? ((L.uturnT > 0 ? L.uturnDir : L.dir) > 0 ? 0 : PI) : L.alpha;
    const cf = Math.cos(th), sf = Math.sin(th);
    ts = L.s + cf * F - sf * R; td = L.d + sf * F + cf * R;
    // still inside a side street: out through its opening first (not into the corner)
    {
      const as = a.d >= 0 ? 1 : -1, m = c.map.mouthAt(a.s, as);
      if (m && !a.inDoor && Math.abs(a.d) > c.map.mouthLine(m, as) + 0.15) {
        const ms = c.unwrap(m.s), half = Math.max(0.3, m.width / 2 - 1.6);
        if (Math.abs(a.s - ms) < m.width / 2) ts = Math.max(ms - half, Math.min(ms + half, ts));
      }
    }
    // keep the slot out of café / platform footprints and off the walls
    const side = td >= 0 ? 1 : -1;
    const cl = c.map.clearOfRects(ts, side, Math.abs(td), 0.35);
    if (cl >= 0 && !a.noRect) td = side * cl;
    const wall = c.map.wallAt(ts, side) - 0.1;
    if (Math.abs(td) > wall && !c.map.mouthAt(ts, side) && !a.inDoor) td = side * wall;
    // with the tram near, nobody's slot is next to its track (or across it from this member)
    const tram = c.tram;
    if (tram.near(a) && !a.clearing) {
      const dl = a.d - RIDE_D, tl = td - RIDE_D, pd = tram.passD;
      const across = (dl <= -BAND && tl > -pd) || (dl >= BAND && tl < pd);
      if (across || Math.abs(tl) < pd) {
        // on the side of the band this member is on (never across it to join the leader)
        const hi = dl > BAND ? true : dl < -BAND ? false : L.d > RIDE_D && !(c.map.stationAt(L.s) && a.kind !== KIND.PASSENGER);
        td = hi ? RIDE_D + pd + 0.1 : RIDE_D - pd - 0.1;
        own = true;
      }
    }
  }
  a.gd = td;
  const es = ts - a.s, ed = td - a.d;
  const k = 0.8;
  const pace = 1 + 0.04 * noise1(t / a.paceT, a.wSeed + 7);
  // the leader's sideways motion is copied only while the member is really in its slot
  out.vs = L.vs * pace + es * k; out.vd = (own ? 0 : L.vd) + ed * k;
  const sp = len2(out.vs, out.vd);
  const lim = Math.max(a.v0 * 1.35, len2(L.vs, L.vd) * 1.2);
  if (sp > lim) { out.vs *= lim / sp; out.vd *= lim / sp; }
  out.vmax = lim;
  // mirror the leader's stops
  a.state = lStop ? (L.state === ST.WAIT ? ST.WAIT : ST.STAND) : ST.WALK;
  if (lStop) {
    if (len2(es, ed) < 0.3) { out.vs = 0; out.vd = 0; a.moving = false; }
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
    const others = [L, ...L.followers].filter((m) => m !== a);
    const o = r.pick(others);
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
      if (r.chance(mob ? 0.2 : 0.28) && startSideOut(c, a, mine)) return;
      if (mine.side === 0 && r.chance(0.35) && startCross(c, a, c.unwrap(mine.s) + r.range(-1, 1) * mine.width * 0.3, TASK.SIDE_OUT, mine)) return;
      if (r.chance(0.3) && startCross(c, a, c.unwrap(mine.s) + r.range(-1, 1) * mine.width * 0.3, TASK.NONE, null)) return;
      if (r.chance(0.06)) { startUturn(c, a); return; }  // changed their mind at the corner
    } else if (other && other !== a.mouth) {
      a.mouth = other;
      if (r.chance(0.45) && startCross(c, a, c.unwrap(other.s) + r.range(-1, 1) * other.width * 0.3, r.chance(0.5) ? TASK.SIDE_OUT : TASK.NONE, other)) return;
    }
    if (a.lane === LANE.SIDE) {
      if (mob !== MOB.WALKBIKE && r.chance(0.016) && startBrowse(c, a)) return;
      if (!mob && r.chance(0.006) && startEnter(c, a)) return;
      if (!mob && a.nFollow === 0 && r.chance(0.02) && c.counts.seated < MAX_SEATED - 4 && startSit(c, a)) return;
      // drift over to the shop windows for a few steps, without stopping (not with a bicycle)
      if (mob !== MOB.WALKBIKE && r.chance(0.02) && a.driftT < c.time) { a.driftT = c.time + r.range(3, 7); a.driftF = r.range(0.8, 0.97); a.lookGoal = (a.dir * side > 0 ? -1 : 1) * r.range(0.5, 1.0); }
    }
    if (!mob && a.nFollow === 0 && r.chance(0.06) && startPlatform(c, a)) return;
  }
  // (with a stroller: no crossing in the middle of a block)
  if (mob !== MOB.STROLLER && r.chance(0.0018) && startCross(c, a, a.s + a.dir * r.range(3, 8), TASK.NONE, null)) return;
  if (!mob && a.nFollow > 0 && r.chance(0.02) && c.counts.stand < STANDER_TARGET && startChat(c, a)) return;
  if (a.nFollow === 0 && r.chance(0.004) && !nearRide(a) && Math.abs(a.d) > TRACK_ZONE_HALF) {
    c.tally('pause'); a.task = TASK.PAUSE; stand(a, a.alpha + r.range(-1.2, 1.2), r.range(6, 24)); return;
  }
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
  if (forceSide || p < 0.6) { a.lane = LANE.SIDE; a.laneF = r.range(0.04, 0.96); }
  else if (p < 0.8) { a.lane = LANE.EDGE; a.laneF = r.next(); }
  else {
    a.lane = LANE.CORR;
    // the shared track corridor; the ride track's half is cleared whenever the tram comes
    a.laneD = a.side * r.range(0.35, TRACK_ZONE_HALF - 0.45);
  }
}

// ------------------------------------------------------------------ tasks

function startBrowse(c, a) {
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
    a.task = TASK.BROWSE; a.step = 0;
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
  const t = c.rng.range(15, 75);
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
  goTo(a, doorS + c.rng.range(-0.5, 0.5), TRACK_ZONE_HALF + 0.3, 0.3);
}

// ------------------------------------------------------------------ arrival

export function arrive(c, a) {
  const r = c.rng, map = c.map, side = a.side;
  switch (a.task) {
    case TASK.BROWSE:
      a.step = 1;
      stand(a, faceFacade(side) + r.range(-0.25, 0.25), r.range(4, 20));
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
      const m = a.mouth, line = map.mouthLine(m, side);
      const ms = c.unwrap(m.s);
      if (a.step < 6) {
        if (a.step > 0 && groupGone(c, a, side, line, ms - m.width / 2, ms + m.width / 2)) { c.population.vanish(a); return; }
        a.step++;
        const depth = Math.min(16, 3 + a.step * 2.6);
        goTo(a, ms + a.slotX, side * (line + depth), 0.5);
        return;
      }
      if (c.vis.hidden(a.s, a.d) || c.vis.distance(a.s) > 120) { c.population.vanish(a); return; }
      stand(a, faceStreet(side), 2); // rare: in plain view at the end of the side street, wait
      return;
    }
    case TASK.EMERGE:
      walk(a);
      // still in the recess (gave up on a blocked goal): the door keeps bounding them until out
      a.inDoor = Math.abs(a.d) > map.facadeAt(a.s, side) - 0.35;
      if (r.chance(0.25) && startCross(c, a, a.s + a.dir * r.range(2, 6), TASK.NONE, null)) return;
      return;
    case TASK.CROSS: {
      if (a.step === 0 || a.step === 1) {
        // at the corridor edge (or already inside): wait for a safe gap, unless already past the band
        const past = side > 0 ? a.d < RIDE_D - BAND : a.d > RIDE_D + BAND;
        if (!past && (!c.tram.canEnterBand(a, a.s) || !c.tram.canEnterBand(a, a.crossS))) {
          if (a.step === 0) c.tally('waitForTram');
          waitToCross(c, a, side);
          return;
        }
        a.step = 2;
        a.crossOK = past ? 0 : c.time + c.tram.timeThrough(a) + 1.5;   // committed: walks through the band
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
        goTo(a, end, TRACK_ZONE_HALF + PLATFORM_W * (a.after > 0 ? 0.62 : 0.5), 0.7);
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
      if (a.task === TASK.ENTER || a.task === TASK.SIDE_OUT || a.task === TASK.BOARD) { a.state = ST.GOTO; arrive(c, a); return; }
      if (a.task === TASK.CHAT) {
        if (a.leader) return; // followers resume with their leader
        if (a.kind === KIND.STANDER) a.kind = KIND.WALKER;
        for (const m of c.population.groupOf(a)) { if (m !== a) { m.task = TASK.NONE; m.state = ST.WALK; if (m.kind === KIND.STANDER) m.kind = KIND.WALKER; } }
        if (r.chance(0.35)) flipGroup(a);
      } else if (a.task === TASK.BROWSE && r.chance(0.3)) flipGroup(a);
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

