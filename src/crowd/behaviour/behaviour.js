import { TRACK_ZONE_HALF } from '../../core/config.js';
import { PLATFORM_W } from '../../world/layout.js';
import { KIND, ST, TASK, LANE } from './agent.js';
import { EDGE_LANE, RIDE_D, BAND_LO, BAND_HI, TRAM_LEN, STANDER_TARGET, MAX_SEATED, MAX_PASSENGERS } from './constants.js';

// Decisions and goals of individual pedestrians: lane walking, window shopping,
// entering shops, side streets, crossing the tracks, joining a platform, café seats,
// chats. `think` runs about once a second per agent; `desired` gives the preferred
// velocity every frame (steering adds avoidance on top).

const CORR_EDGE = TRACK_ZONE_HALF + 0.38;   // where people wait before crossing the corridor
const PI = Math.PI;
const len2 = (x, y) => Math.sqrt(x * x + y * y);
const tmpBand = { lo: 0, hi: 0 };

// ------------------------------------------------------------------ lanes

/** Lateral target (signed d) for a lane-following walker. */
export function laneTarget(c, a) {
  const d = rawLane(c, a);
  // while the tram is near, nobody aims for the ride track's clearance band
  const ahead = a.s - c.tram.trainU;
  if (d > BAND_LO - 0.3 && d < BAND_HI + 0.1 && ahead > -(TRAM_LEN + 4) && ahead < c.tram.frontFor(a) + 15) {
    const lo = d < RIDE_D || c.map.stationAt(a.s) || c.map.stationAt(a.s + a.dir * 15);
    return lo ? BAND_LO - 0.35 - a.laneF * 1.3 : BAND_HI + 0.1 + a.laneF * 0.3;
  }
  return d;
}

function rawLane(c, a) {
  const side = a.side, map = c.map;
  const here = map.stationAt(a.s);
  // alongside a platform people in the corridor stay in it (the platform is in the way)
  if (here && Math.abs(a.d) < TRACK_ZONE_HALF + 0.25) {
    if (a.lane === LANE.CORR) return a.laneD;
    return -(0.7 + a.laneF * (TRACK_ZONE_HALF - 1.2));
  }
  if (a.lane === LANE.CORR) return a.laneD;
  const st = here || map.stationAt(a.s + a.dir * 20);
  if (a.lane === LANE.EDGE && !st) return side * (TRACK_ZONE_HALF - 0.12 + 0.42 * a.laneF);
  map.bandAhead(a.s, side, a.dir * 7, tmpBand);
  const w = tmpBand.hi - tmpBand.lo;
  if (w < 0.7) {
    // café furniture fills the sidewalk: people spread over what is left, the strip by the
    // trees and (on the far side of the ride track) the track corridor itself
    if (st) return side * (tmpBand.lo + 0.2);
    if (side > 0) return EDGE_LANE + a.laneF * 1.15;
    return -(0.9 + a.laneF * (EDGE_LANE + 0.5 - 0.9));
  }
  return side * (tmpBand.lo + 0.3 + (w - 0.6) * a.laneF);
}

// ------------------------------------------------------------------ desired velocity

/** Preferred velocity for this frame → out.vs, out.vd, out.vmax. */
export function desired(c, a, out) {
  out.vmax = a.v0 * 1.25;
  if (a.leader && a.leader.active && (a.state === ST.WALK || a.state === ST.STAND || a.state === ST.WAIT)) return follow(c, a, out);
  switch (a.state) {
    case ST.WALK: {
      // the lane only changes slowly along the street: refresh it a few times a second
      a.laneTT -= c.dt;
      if (a.laneTT <= 0) { a.laneT = laneTarget(c, a); a.laneTT = 0.25; }
      const dt = a.laneT;
      a.gd = dt;
      out.vs = a.dir * a.v0;
      const e = dt - a.d;
      out.vd = Math.max(-0.75, Math.min(0.75, e * 0.9));
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
    default:
      out.vs = 0; out.vd = 0;
  }
  if (a.clearing) {
    const sp = c.tram.clearSpeed(a);
    out.vd = Math.sign(a.clearTo - a.d) * sp;
    out.vs *= 0.5;
    out.vmax = Math.max(out.vmax, sp * 1.1);
  }
}

/** Group members keep a slot beside / behind their leader. */
function follow(c, a, out) {
  const L = a.leader;
  const fs = L.dir, fdx = L.dir; // leader frame: forward along its walking direction, right = dir * +d
  const ts = L.s + fs * a.slotF, td = L.d + fdx * a.slotR;
  const es = ts - a.s, ed = td - a.d;
  const k = 1.1;
  out.vs = L.vs + es * k; out.vd = L.vd + ed * k;
  const sp = len2(out.vs, out.vd);
  const lim = Math.max(a.v0 * 1.35, len2(L.vs, L.vd) * 1.2);
  if (sp > lim) { out.vs *= lim / sp; out.vd *= lim / sp; }
  out.vmax = lim;
  // mirror the leader's stops
  const lStop = L.state === ST.STAND || L.state === ST.WAIT || L.state === ST.PLATFORM;
  a.state = lStop ? (L.state === ST.WAIT ? ST.WAIT : ST.STAND) : ST.WALK;
  if (lStop && len2(es, ed) < 0.45) {
    out.vs = 0; out.vd = 0;
    if (L.task !== TASK.CHAT) a.faceA = L.faceA;
  }
  a.dir = L.dir; a.side = L.side;
  if (a.clearing) {
    const sp2 = c.tram.clearSpeed(a);
    out.vd = Math.sign(a.clearTo - a.d) * sp2;
    out.vs *= 0.5;
    out.vmax = Math.max(out.vmax, sp2 * 1.1);
  }
}

// ------------------------------------------------------------------ helpers

function goTo(a, s, d, tol = 0.3) { a.state = ST.GOTO; a.gs = s; a.gd = d; a.gTol = tol; }
function walk(a) { a.state = ST.WALK; a.task = TASK.NONE; a.step = 0; a.inDoor = false; a.laneTT = 0; }
function stand(a, faceA, t) { a.state = ST.STAND; a.faceA = faceA; a.timer = t; }
const faceTowards = (fromS, fromD, toS, toD) => Math.atan2(toD - fromD, toS - fromS);
const faceFacade = (side) => (side > 0 ? PI / 2 : -PI / 2);
const faceStreet = (side) => (side > 0 ? -PI / 2 : PI / 2);

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
function findCrossS(c, s, side) {
  for (const off of CROSS_OFFSETS) {
    if (clearSpot(c, s + off, side * CORR_EDGE)) return s + off;
  }
  return null;
}

// ------------------------------------------------------------------ think

export function think(c, a) {
  const r = c.rng;
  a.thinkT = r.range(0.7, 1.3);
  if (a.simple) return;
  switch (a.state) {
    case ST.WALK: if (!a.leader) thinkWalk(c, a); break;
    case ST.SEATED:
      if (a.timer <= 0 && !a.leader) leaveSeat(c, a);
      else if (r.chance(0.08)) a.lookGoal = r.range(-0.9, 0.9);
      break;
    case ST.PLATFORM: thinkPassenger(c, a); break;
    case ST.STAND:
      if (r.chance(0.1)) a.lookGoal = r.range(-0.6, 0.6) * (a.task === TASK.CHAT ? 0.5 : 1);
      break;
    default: break;
  }
}

function thinkWalk(c, a) {
  const r = c.rng, map = c.map, side = a.side;
  if (a.lane !== LANE.CORR) {
    // cross streets just ahead
    const look = a.s + a.dir * 7;
    const mine = map.mouthAt(look, side), other = map.mouthAt(look, -side);
    if (mine && mine !== a.mouth) {
      a.mouth = mine;
      if (r.chance(0.28) && startSideOut(c, a, mine)) return;
      if (mine.side === 0 && r.chance(0.35) && startCross(c, a, c.unwrap(mine.s) + r.range(-1, 1) * mine.width * 0.3, TASK.SIDE_OUT, mine)) return;
      if (r.chance(0.3) && startCross(c, a, c.unwrap(mine.s) + r.range(-1, 1) * mine.width * 0.3, TASK.NONE, null)) return;
    } else if (other && other !== a.mouth) {
      a.mouth = other;
      if (r.chance(0.45) && startCross(c, a, c.unwrap(other.s) + r.range(-1, 1) * other.width * 0.3, r.chance(0.5) ? TASK.SIDE_OUT : TASK.NONE, other)) return;
    }
    if (a.lane === LANE.SIDE) {
      if (r.chance(0.016) && startBrowse(c, a)) return;
      if (r.chance(0.006) && startEnter(c, a)) return;
      if (a.nFollow === 0 && r.chance(0.02) && c.counts.seated < MAX_SEATED - 4 && startSit(c, a)) return;
    }
    if (a.nFollow === 0 && r.chance(0.06) && startPlatform(c, a)) return;
  }
  if (r.chance(0.0018) && startCross(c, a, a.s + a.dir * r.range(3, 8), TASK.NONE, null)) return;
  if (a.nFollow > 0 && r.chance(0.02) && c.counts.stand < STANDER_TARGET && startChat(c, a)) return;
  if (a.nFollow === 0 && r.chance(0.004)) { c.tally('pause'); a.task = TASK.PAUSE; stand(a, a.alpha + r.range(-1.2, 1.2), r.range(6, 24)); return; }
  // lane drift and the odd change of mind
  if (r.chance(0.05)) a.laneF = Math.min(0.97, Math.max(0.03, a.laneF + r.normal(0, 0.18)));
  if (r.chance(0.012)) setLane(c, a, r);
  if (r.chance(0.002)) a.dir = -a.dir;
  if (r.chance(0.12)) a.lookGoal = r.chance(0.5) ? (a.dir * side > 0 ? -1 : 1) * r.range(0.3, 0.9) : r.range(-0.35, 0.35);
  else if (r.chance(0.2)) a.lookGoal = 0;
}

/** Pick a lane for a walker on its current side. */
export function setLane(c, a, r, forceSide = false) {
  const p = r.next();
  a.laneTT = 0;
  if (forceSide || p < 0.66) { a.lane = LANE.SIDE; a.laneF = r.range(0.04, 0.96); }
  else if (p < 0.89) { a.lane = LANE.EDGE; a.laneF = r.next(); }
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
    const gs = sO + c.rng.range(-0.5, 0.5) * o.half, gd = side * (wall - 0.3);
    if (!clearSpot(c, gs, gd, 0.45)) continue;
    a.task = TASK.BROWSE; a.step = 0;
    goTo(a, gs, gd, 0.3);
    c.tally('browse');
    return true;
  }
  return false;
}

function startEnter(c, a) {
  const map = c.map, side = a.side;
  const ops = map.openingsAt(a.s + a.dir * 6, side);
  if (!ops) return false;
  for (const o of ops) {
    const sO = c.unwrap(o.s);
    const ahead = (sO - a.s) * a.dir;
    if (ahead < 2 || ahead > 12 || o.half < 0.45) continue;
    if (map.cafeAtS(sO, side)) continue;
    const wall = map.wallAt(sO, side);
    if (!clearSpot(c, sO, side * (wall - 0.3), 0.45)) continue;
    a.task = TASK.ENTER; a.step = 0;
    c.tally('enterShop');
    a.door = o; a.doorS0 = sO - o.half + 0.3; a.doorS1 = sO + o.half - 0.3;
    goTo(a, sO, side * (wall - 0.2), 0.3);
    return true;
  }
  return false;
}

/** Turn into a side street on the agent's side and vanish there once out of sight. */
export function startSideOut(c, a, m) {
  const side = a.side;
  const ms = c.unwrap(m.s);
  const line = c.map.mouthLine(m, side);
  a.mouth = m; a.task = TASK.SIDE_OUT; a.step = 0;
  c.tally('intoSideStreet');
  a.slotX = c.rng.range(-1, 1) * (m.width / 2 - 1.4);
  goTo(a, ms + a.slotX, side * (line - 0.7), 0.6);
  return true;
}

/** Cross the track corridor at sE (diagonally), then continue with `after`. */
export function startCross(c, a, sE, after, mouth) {
  const map = c.map, side = a.side;
  if (map.stationAt(sE) || map.stationAt(sE + a.dir * 12)) return false;
  const s0 = findCrossS(c, sE, side);
  if (s0 === null) return false;
  const sT = mouth ? c.unwrap(mouth.s) + c.rng.range(-1, 1) * (mouth.width / 2 - 1.5) : s0 + a.dir * c.rng.range(0, 11);
  const s1 = findCrossS(c, sT, -side);
  if (s1 === null || map.stationAt(s1)) return false;
  a.task = TASK.CROSS; a.after = after; a.mouth = mouth || a.mouth;
  a.crossS = s1;
  c.tally(mouth || map.mouthAt(sE, side) || map.mouthAt(sE, -side) ? 'crossAtCrossStreet' : 'crossMidBlock');
  if (Math.abs(a.d) < TRACK_ZONE_HALF) { a.step = 1; arrive(c, a); return true; } // already in the corridor
  a.step = 0;
  goTo(a, s0, side * CORR_EDGE, 0.45);
  return true;
}

function startPlatform(c, a) {
  const st = c.map.stationAt(a.s + a.dir * 25);
  if (!st || c.counts.passenger >= MAX_PASSENGERS) return false;
  const pl = st.platforms.find((p) => p.side === a.side);
  const feat = c.population.platformFeature(st, a.side);
  if (!pl || !feat || feat.count >= feat.cap) return false;
  const s0 = c.unwrap(pl.s0), s1 = s0 + (pl.s1 - pl.s0);
  const endS = a.dir > 0 ? s0 - 0.9 : s1 + 0.9;
  if ((endS - a.s) * a.dir < 2) return false;
  a.task = TASK.TO_PLATFORM; a.step = 0; a.feature = feat; feat.count++;
  c.tally('toPlatform');
  goTo(a, endS, a.side * (TRACK_ZONE_HALF + PLATFORM_W * 0.55), 0.6);
  return true;
}

function startSit(c, a) {
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
  if (band < 2.2 || a.lane !== LANE.SIDE) return false;
  const members = c.population.groupOf(a);
  let cs = 0, cd = 0;
  for (const m of members) { cs += m.s; cd += m.d; }
  cs /= members.length; cd /= members.length;
  const t = c.rng.range(15, 75);
  for (const m of members) {
    m.task = TASK.CHAT;
    stand(m, faceTowards(m.s, m.d, cs, cd), t);
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
  goTo(a, doorS + c.rng.range(-0.5, 0.5), TRACK_ZONE_HALF + 0.24, 0.3);
}

// ------------------------------------------------------------------ arrival

export function arrive(c, a) {
  const r = c.rng, map = c.map, side = a.side;
  switch (a.task) {
    case TASK.BROWSE:
      a.step = 1;
      stand(a, faceFacade(side) + r.range(-0.25, 0.25), r.range(4, 20));
      return;
    case TASK.ENTER: {
      if (a.step === 0) {
        a.step = 1; a.inDoor = true;
        const o = a.door;
        goTo(a, (a.doorS0 + a.doorS1) / 2, side * (o.d + Math.min(o.recess - 0.12, 0.3)), 0.15);
        return;
      }
      if (a.step >= 1 && a.step < 20) {
        if (c.vis.hidden(a.s, a.d, side, a.door.d, a.doorS0 - 0.3, a.doorS1 + 0.3)) { c.population.vanish(a); return; }
        // somebody is watching: wait at the door a little, then give up
        a.step++;
        stand(a, faceFacade(side), 1.2);
        a.state = ST.STAND;
        return;
      }
      a.step = 0; a.inDoor = false;
      a.task = TASK.EMERGE; a.door = null;
      goTo(a, a.s, side * (map.wallAt(a.s, side) - 0.8), 0.4);
      return;
    }
    case TASK.SIDE_OUT: {
      const m = a.mouth, line = map.mouthLine(m, side);
      const ms = c.unwrap(m.s);
      if (a.step < 6) {
        if (a.step > 0 && c.vis.hidden(a.s, a.d, side, line, ms - m.width / 2, ms + m.width / 2)) { c.population.vanish(a); return; }
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
      a.inDoor = false;
      walk(a);
      if (r.chance(0.25) && startCross(c, a, a.s + a.dir * r.range(2, 6), TASK.NONE, null)) return;
      return;
    case TASK.CROSS: {
      if (a.step === 0 || a.step === 1) {
        // at the corridor edge (or already inside): wait for a safe gap
        const tCross = (BAND_HI - BAND_LO + 0.6) / a.v0 + 1.5;
        if (!c.tram.canEnterBand(a.s, tCross) || !c.tram.canEnterBand(a.crossS, tCross)) {
          if (a.step === 0) c.tally('waitForTram');
          a.step = 1;
          a.state = ST.WAIT; a.timer = 0.35;
          a.faceA = faceStreet(side) + (side > 0 ? -0.5 : 0.5); // half turned towards the oncoming tram
          return;
        }
        a.step = 2;
        goTo(a, a.crossS, -side * CORR_EDGE, 0.5);
        return;
      }
      // reached the far side
      a.side = -side;
      if (a.after === TASK.SIDE_OUT && a.mouth && map.mouthAt(a.mouth.s, a.side)) { startSideOut(c, a, a.mouth); return; }
      walk(a);
      setLane(c, a, r, true);
      if (r.chance(0.5)) a.dir = -a.dir;
      return;
    }
    case TASK.TO_PLATFORM: {
      const feat = a.feature;
      if (a.step === 0 && feat) {
        a.step = 1; a.noRect = true;
        const spot = c.population.platformSpot(feat);
        goTo(a, spot.s, spot.d, 0.3);
        return;
      }
      a.kind = KIND.PASSENGER; a.task = TASK.NONE;
      a.state = ST.PLATFORM;
      a.faceA = c.population.passengerFacing(side);
      a.timer = r.range(40, 200);
      return;
    }
    case TASK.BOARD:
      if (c.vis.hidden(a.s, a.d) || !c.tram.stoppedAt) { c.population.vanish(a); return; }
      stand(a, 0, 0.8);
      a.state = ST.STAND;
      a.task = TASK.BOARD;
      return;
    case TASK.ALIGHT: {
      if (a.step === 0) {
        a.step = 1;
        const out = map.bandInAt(a.s, side) + 0.8;
        const pl = a.feature && a.feature.platform;
        const away = pl && a.s > c.unwrap((pl.s0 + pl.s1) / 2) ? 1.5 : -1.5;
        goTo(a, a.s + away, side * out, 0.6);
        return;
      }
      if (a.feature) { a.feature.count--; a.feature = null; }
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
      a.s = seat.s; a.d = seat.d; a.vs = 0; a.vd = 0;
      a.faceA = seat.faceA;
      a.alpha = a.faceA;
      a.timer = r.range(60, 600);
      return;
    }
    case TASK.LEAVE_SEAT:
      a.noRect = false;
      walk(a);
      setLane(c, a, r, true);
      a.dir = r.chance(0.5) ? 1 : -1;
      return;
    default:
      walk(a);
  }
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
        if (r.chance(0.35)) a.dir = -a.dir;
      }
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

