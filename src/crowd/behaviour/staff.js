import { KIND, ST, TASK, LANE } from './agent.js';
import { doorOf } from './behaviour.js';

// Café staff: a waiter for each busy terrace near the camera. They come out of the café's door
// (only where nobody sees them appear), walk out to the walkway at the terrace's street edge,
// along it to a table people sit at (more often one not served yet), step up to it from the
// side its chairs leave free and stand there facing it for a few seconds (taking an order,
// bringing it), then go back the same way and in through the door again; out of sight in the
// doorway they are gone, to come out again a little later. Paths keep clear of the tables,
// chairs and free-standing umbrella bases.

const RANGE = [6, 220];       // terraces with a waiter (m ahead of the camera)
const MAX_STAFF = 7;
const PI = Math.PI;

/** Distance from point (px, py) to segment (ax, ay)-(bx, by). */
function segDist(ax, ay, bx, by, px, py) {
  const ux = bx - ax, uy = by - ay, l2 = ux * ux + uy * uy;
  let t = l2 > 1e-9 ? ((px - ax) * ux + (py - ay) * uy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + ux * t - px, ay + uy * t - py);
}

/** Is the walk (s0, d0) → (s1, d1) clear of café cafe's furniture (unwrapped s via unwrap)? */
function clearWalk(cafe, unwrap, s0, d0, s1, d1, skipTable = -1) {
  for (let ti = 0; ti < cafe.tables.length; ti++) {
    const t = cafe.tables[ti];
    if (ti !== skipTable && segDist(s0, d0, s1, d1, unwrap(t.s), t.d) < 0.62) return false;
    for (const ch of t.chairs) if (segDist(s0, d0, s1, d1, unwrap(ch.s), ch.d) < 0.46) return false;
  }
  for (const u of cafe.umbrellas || []) {
    const us = unwrap(u.s);
    // (a pole through a table's centre is the table's)
    if (cafe.tables.some((t) => Math.abs(unwrap(t.s) - us) < 0.2 && Math.abs(t.d - u.d) < 0.2)) continue;
    if (segDist(s0, d0, s1, d1, us, u.d) < 0.5) return false;
  }
  return true;
}

/** A spot to stand at table ti of the café, facing it: clear of its chairs and of the other
 *  tables, on the walkway side where possible. → {s, d, face} or null. */
function tableSpot(c, cafe, ti, r) {
  const t = cafe.tables[ti], side = cafe.side, ts = c.unwrap(t.s);
  const wall = c.map.wallAt(ts, side) - 0.3;
  let best = null, bs = -1e9;
  const a0 = r.range(0, 2 * PI);
  for (let k = 0; k < 12; k++) {
    const th = a0 + (k / 12) * 2 * PI;
    const s = ts + 0.78 * Math.cos(th), d = t.d + 0.78 * Math.sin(th);
    if (Math.abs(d) > wall) continue;
    let ok = true;
    for (const ch of t.chairs) if (Math.hypot(c.unwrap(ch.s) - s, ch.d - d) < 0.5) { ok = false; break; }
    if (!ok) continue;
    for (let tj = 0; tj < cafe.tables.length && ok; tj++) {
      if (tj === ti) continue;
      const o = cafe.tables[tj];
      if (Math.hypot(c.unwrap(o.s) - s, o.d - d) < 0.85) ok = false;
      for (const ch of o.chairs) if (Math.hypot(c.unwrap(ch.s) - s, ch.d - d) < 0.5) { ok = false; break; }
    }
    if (!ok) continue;
    // (the walkway side first: less weaving between the tables)
    const score = -Math.abs(d) * side * side + r.range(0, 0.3);
    if (score > bs) { bs = score; best = { s, d, face: Math.atan2(t.d - d, ts - s) }; }
  }
  return best;
}

/** Plan a waiter's round from the door to a table in use and back: a.path (list of [s, d]). */
export function planRound(c, a) {
  const feat = a.cafeT, cafe = feat && feat.cafe, dr = a.door;
  if (!cafe || !dr) return false;
  const r = c.rng, side = cafe.side, map = c.map, U = (s) => c.unwrap(s);
  const exitD = side * (map.wallMin(dr.s, side, 0.6) - 0.5);
  const aisleD = side * (cafe._crowdInner - 0.45);
  // tables people sit at: their order on its way, or (at a table not served yet: people who have
  // just sat down) the order to take, those twice as often
  const busy = [];
  for (const seat of feat.seats) {
    if (!feat.occ.has(seat.key) || busy.includes(seat.table)) continue;
    busy.push(seat.table);
    if (seat.dressed !== 2) busy.push(seat.table);
  }
  if (!busy.length) return false;
  for (let tries = 0; tries < 4; tries++) {
    const ti = r.pick(busy);
    const P = tableSpot(c, cafe, ti, r);
    if (!P) continue;
    // straight out of the door to the walkway, along it, and in to the table (or straight
    // across the terrace when that is clear)
    let path;
    if (clearWalk(cafe, U, dr.s, exitD, P.s, P.d, ti)) path = [[dr.s, exitD], [P.s, P.d]];
    else if (clearWalk(cafe, U, dr.s, exitD, dr.s, aisleD) && clearWalk(cafe, U, P.s, aisleD, P.s, P.d, ti)) path = [[dr.s, exitD], [dr.s, aisleD], [P.s, aisleD], [P.s, P.d]];
    else continue;
    a.path = path; a.pathI = 0; a.serveFace = P.face; a.serveTi = ti;
    return true;
  }
  return false;
}

/** Spawn and keep the waiters (one per busy terrace near the camera). */
export function staffTick(c) {
  const pop = c.population, r = c.rng;
  let n = 0;
  for (const f of pop.cafes.values()) if (f.staff && f.staff.active && f.staff.role === 'staff' && f.staff.cafeT === f) n++; else f.staff = null;
  if (n >= MAX_STAFF || pop.free.length < 20) return;
  for (const f of pop.cafes.values()) {
    if (f.staff || c.time < (f.staffT || 0)) continue;
    const cafe = f.cafe, mid = c.unwrap((cafe.s0 + cafe.s1) / 2), rel = mid - c.camU;
    if (rel < RANGE[0] || rel > RANGE[1]) continue;
    let busy = 0;
    for (const seat of f.seats) if (f.occ.has(seat.key)) busy++;
    if (busy < 2) { f.staffT = c.time + 4; continue; }
    const w = spawnWaiter(c, f);
    f.staffT = c.time + (w ? r.range(20, 40) : 6);
    if (w) { f.staff = w; c.tally('waiter'); if (++n >= MAX_STAFF) return; }
  }
}

/** A waiter coming out of the café's door (hidden in its recess), or null. */
function spawnWaiter(c, feat) {
  const pop = c.population, map = c.map, r = c.rng, cafe = feat.cafe, side = cafe.side;
  const ops = map.openingsAt(c.unwrap((cafe.s0 + cafe.s1) / 2), side);
  if (!ops || !ops.length) return null;
  const doors = [];
  for (const o of ops) {
    const dr = doorOf(c, o);
    if (!dr) continue;
    // (a door behind this terrace)
    if (dr.s < c.unwrap(cafe.s0) - 1 || dr.s > c.unwrap(cafe.s1) + 1) continue;
    doors.push(dr);
  }
  if (!doors.length) return null;
  const dr = r.pick(doors);
  const dIn = side * (dr.o.d + dr.depth - 0.15);
  if (!c.vis.bodyHidden(dr.s, dIn, side, dr.o.d, dr.oS - dr.o.half, dr.oS + dr.o.half)) return null;
  pop.placeAt(dr.s, dIn);
  const a = pop.alloc(KIND.WALKER, 'staff', 'waiter');
  if (!a) return null;
  a.s = dr.s; a.d = dIn; a.side = side; a.dir = 1; a.lane = LANE.SIDE; a.laneF = 0.9;
  a.role = 'staff'; a.cafeT = feat; a.noRect = true;
  a.inDoor = true; a.door = dr; a.doorS0 = dr.s0; a.doorS1 = dr.s1;
  a.v0 = r.range(1.12, 1.3); a.alpha = side > 0 ? -PI / 2 : PI / 2; a.vs = 0; a.spawnHidden = true;
  a.dreamy = false; a.needsBell = false;
  if (!planRound(c, a)) { pop._unspawn(a); return null; }
  a.task = TASK.SERVE; a.step = 0; a.state = ST.GOTO;
  const p = a.path[0];
  a.gs = p[0]; a.gd = p[1]; a.gTol = 0.25;
  return a;
}

/** A waiter reached its next waypoint (or finished standing at the table / in the doorway). */
export function serveArrive(c, a) {
  const r = c.rng, side = a.side, dr = a.door;
  if (!a.path || !dr) { c.population.kill(a); return; }
  if (a.step === 0) {
    // out to the table
    a.pathI++;
    if (a.pathI < a.path.length) { const p = a.path[a.pathI]; goTo(a, p[0], p[1], a.pathI === a.path.length - 1 ? 0.15 : 0.3); return; }
    a.step = 1;
    a.state = ST.STAND; a.faceA = a.serveFace; a.timer = r.range(3, 8);
    return;
  }
  if (a.step === 1) {
    // back to the door the same way
    a.step = 2; a.pathI = a.path.length - 1;
  }
  if (a.step === 2) {
    a.pathI--;
    if (a.pathI >= 0) { const p = a.path[a.pathI]; goTo(a, p[0], p[1], 0.3); return; }
    a.step = 3; a.inDoor = true; a.doorS0 = dr.s0; a.doorS1 = dr.s1;
    goTo(a, dr.s, side * (dr.o.d + dr.depth - 0.15), 0.15);
    return;
  }
  if (a.step === 3) {
    // in the doorway: gone when nobody sees it, else out to another table after a moment
    if (c.vis.bodyHidden(a.s, a.d, side, dr.o.d, dr.oS - dr.o.half, dr.oS + dr.o.half)) {
      if (a.cafeT) a.cafeT.staffT = c.time + r.range(4, 14);
      c.population.kill(a);
      return;
    }
    a.step = 4; a.state = ST.STAND; a.faceA = side > 0 ? -PI / 2 : PI / 2; a.timer = r.range(2, 5);
    return;
  }
  // (step 4: stood in the doorway in plain view) a new round
  if (!planRound(c, a)) { a.state = ST.STAND; a.step = 4; a.timer = r.range(3, 6); return; }
  a.step = 0;
  const p = a.path[0];
  goTo(a, p[0], p[1], 0.3);
}

function goTo(a, s, d, tol) { a.state = ST.GOTO; a.gs = s; a.gd = d; a.gTol = tol; }
