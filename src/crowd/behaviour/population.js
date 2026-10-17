import { hash2, noise1 } from '../../core/rng.js';
import { TRACK_ZONE_HALF } from '../../core/config.js';
import { PLATFORM_W } from '../../world/layout.js';
import { Agent, KIND, ST, TASK, LANE } from './agent.js';
import { laneTarget, setLane, board } from './behaviour.js';
import {
  MAX_AGENTS, RANGE_BEHIND, RANGE_AHEAD, FAR_SPAWN_BAND, WALKER_DENSITY, MAX_SEATED, MAX_PASSENGERS, STANDER_TARGET,
  WALK_MEAN, WALK_SD, WALK_MIN, WALK_MAX, RIDE_D, BAND, AGENT_R, TRAM_LEN,
} from './constants.js';

// Who is on the street. Keeps the density target over the populated range,
// recycles people who fall behind the camera or walk out of range, and brings new
// ones in only where nobody is looking: at the far end of the range, beside / behind
// the camera, out of side streets and out of shop doors. Also seats café patrons,
// fills platforms and hands boarding / alighting passengers to the tram.

const BIN = 10;
const BENCH_RESERVE = 12;   // seated slots kept for people on benches
const PI = Math.PI;

export class Population {
  constructor(c) {
    this.c = c;
    this.agents = Array.from({ length: MAX_AGENTS }, (_, i) => { const a = new Agent(i); a.followers = []; return a; });
    this.free = [];
    for (let i = MAX_AGENTS - 1; i >= 0; i--) this.free.push(i);
    this.serial = 0;
    this.cafes = new Map();      // cafe id -> feature
    this.benches = new Map();    // furniture id -> feature
    this.benchList = c.layout.furniture.filter((f) => f.type === 'bench');
    this.stations = new Map();   // station id -> {right, left, served}
    this.featureT = 0;
    this.nBins = Math.ceil((RANGE_AHEAD + RANGE_BEHIND) / BIN);
    this.binCount = new Float32Array(this.nBins);
    this.binTarget = new Float32Array(this.nBins);
    this.walkerTarget = 0;
    this.stats = { spawned: 0, recycled: 0, vanished: 0, spawnFail: 0, bySource: { far: 0, near: 0, side: 0, door: 0, alight: 0, init: 0 } };
  }

  // ---------------------------------------------------------------- slots
  alloc(kind, src = 'walker') {
    if (!this.free.length) return null;
    const a = this.agents[this.free.pop()];
    const c = this.c, r = c.rng;
    a.active = true; a.serial = ++this.serial; a.kind = kind;
    a.state = ST.WALK; a.task = TASK.NONE; a.step = 0;
    a.vs = 0; a.vd = 0; a.leader = null; a.followers.length = 0; a.nFollow = 0; a.slotF = 0; a.slotR = 0;
    a.appearance = hash2(this.serial, c.seed * 7919 + 13) >>> 0;
    a.phase = r.next(); a.pose = 0; a.look = 0; a.lookGoal = 0; a.tramLookT = 0;
    a.clearing = false; a.noRect = false; a.inDoor = false; a.mouth = null; a.after = 0;
    a.feature = null; a.door = null; a.stuckT = 0; a.h = 0; a.timer = 0;
    a.thinkT = r.range(0.2, 1.5); a.simple = false; a.gTol = 0.3;
    a.v0 = Math.min(WALK_MAX, Math.max(WALK_MIN, r.normal(WALK_MEAN, WALK_SD)));
    a.dir = 1; a.side = 1; a.lane = LANE.SIDE; a.laneF = 0.5; a.laneD = 0;
    a.dreamy = r.chance(0.08); a.bellT = 0; a.tramLookS = 0;
    a.fresh = true; a.src = src; a.strideV = -1; a.afs = 0; a.afd = 0; a.laneTT = 0;
    this.stats.spawned++;
    return a;
  }

  /** Remove from the street (slot returns to the pool). */
  kill(a) {
    if (!a.active) return;
    a.active = false;
    if (a.feature) {
      if (a.feature.type === 'seat') this.releaseChair(a.feature);
      else if (a.feature.type === 'platform') a.feature.count--;
      a.feature = null;
    }
    if (a.leader) {
      const f = a.leader.followers, i = f.indexOf(a);
      if (i >= 0) f.splice(i, 1);
      a.leader.nFollow = f.length;
      a.leader = null;
    }
    for (const m of a.followers) { m.leader = null; if (m.state !== ST.GOTO) { m.state = ST.WALK; m.task = TASK.NONE; } }
    a.followers.length = 0; a.nFollow = 0;
    this.free.push(a.slot);
    this.c.onKill(a);
  }

  /** Leaves the street through a door / side street / tram door: the group follows. */
  vanish(a) {
    for (const m of a.followers) {
      m.leader = null;
      m.task = a.task; m.step = a.step; m.mouth = a.mouth; m.door = a.door; m.inDoor = a.inDoor;
      m.doorS0 = a.doorS0; m.doorS1 = a.doorS1; m.slotX = a.slotX;
      m.state = ST.GOTO; m.gs = a.s + (m.s - a.s) * 0.3; m.gd = a.d; m.gTol = 0.35;
      m.side = a.side;
    }
    a.followers.length = 0; a.nFollow = 0;
    this.stats.vanished++;
    this.kill(a);
  }

  /** Empty street (after a jump of the camera). */
  reset() {
    for (const a of this.agents) if (a.active) this.kill(a);
    this.cafes.clear();
    this.benches.clear();
    this.stations.clear();
  }

  groupOf(a) {
    const L = a.leader || a;
    return [L, ...L.followers];
  }

  // ---------------------------------------------------------------- density
  /** Walkers per metre on one side at unwrapped s. */
  density(sU, side) {
    const c = this.c, map = c.map;
    let m = 1;
    if (map.mouthAt(sU, side) || map.mouthAt(sU + 8, side) || map.mouthAt(sU - 8, side)) m += 0.35;
    if (map.stationAt(sU) || map.stationAt(sU + 20) || map.stationAt(sU - 20)) m += 0.15;
    m *= 0.75 + 0.5 * (0.5 + 0.5 * noise1(c.route.wrap(sU) / 70, side > 0 ? 401 : 403));
    // spend the budget where the cab view sees individuals: thin behind and beside the cab
    const rel = sU - c.camU;
    m *= rel < 0 ? 0.35 : rel < 30 ? 0.6 + 0.75 * (rel / 30) : rel < 200 ? 1.35 : rel < 300 ? 1.0 : 0.72;
    return WALKER_DENSITY * m;
  }

  _targets() {
    const c = this.c;
    let tot = 0;
    for (let b = 0; b < this.nBins; b++) {
      const sU = c.camU - RANGE_BEHIND + (b + 0.5) * BIN;
      const t = (this.density(sU, 1) + this.density(sU, -1)) * BIN;
      this.binTarget[b] = t; tot += t;
    }
    const nonWalk = c.counts.seated + c.counts.passenger;
    const cap = MAX_AGENTS - nonWalk - 6;
    this.walkerTarget = Math.min(tot, cap);
    const k = this.walkerTarget / Math.max(1, tot);
    for (let b = 0; b < this.nBins; b++) this.binTarget[b] *= k;
  }

  // ---------------------------------------------------------------- spawning walkers
  /** Places a fresh walker (and maybe its group). Returns the leader or null. */
  spawnWalker(sU, side, dir, opts = {}) {
    const c = this.c, r = c.rng;
    const a = this.alloc(opts.kind ?? KIND.WALKER, opts.src);
    if (!a) return null;
    a.s = sU; a.side = side; a.dir = dir;
    a.d = side * (c.map.bandInAt(sU, side) + 1); // provisional (lane choice looks at where the agent is)
    setLane(c, a, r);
    if (opts.lane !== undefined) { a.lane = opts.lane; if (a.lane === LANE.SIDE) a.laneF = r.range(0.04, 0.96); }
    a.d = opts.d ?? laneTarget(c, a);
    if (opts.d === undefined) a.d += r.range(-0.2, 0.2);
    a.alpha = dir > 0 ? 0 : PI;
    a.vs = dir * a.v0 * (opts.still ? 0 : 1);
    if (!opts.force && !this._placeOk(a)) { this.kill(a); this.stats.spawnFail++; this.stats.spawned--; return null; }
    const groupP = opts.group ?? 0.34;
    if (r.chance(groupP)) {
      const n = r.weighted([[1, 0.62], [2, 0.28], [3, 0.1]]);
      a.v0 = Math.max(WALK_MIN, a.v0 * 0.9);
      for (let k = 0; k < n && this.free.length > 4; k++) {
        const f = this.alloc(a.kind, opts.src);
        const slots = [[0.08, r.chance(0.5) ? 0.64 : -0.64], [0.0, 0], [-0.85, 0.3]];
        let [sf, sr] = slots[k];
        if (k === 1) sr = -slots[0][1];
        f.slotF = sf + r.range(-0.08, 0.08); f.slotR = sr + r.range(-0.06, 0.06);
        f.s = a.s + dir * f.slotF; f.d = a.d + dir * f.slotR;
        f.side = side; f.dir = dir; f.lane = a.lane; f.laneF = a.laneF; f.laneD = a.laneD;
        f.v0 = a.v0 * r.range(1.0, 1.06); f.alpha = a.alpha; f.vs = a.vs;
        if (!opts.force && !this._placeOk(f)) { this.kill(f); this.stats.spawned--; continue; }
        f.leader = a; a.followers.push(f);
        f.state = a.state;
      }
      a.nFollow = a.followers.length;
    }
    return a;
  }

  /** Spot is acceptable: no obstacle overlap, not in a café / platform, outside the tram's band. */
  _placeOk(a) {
    const c = this.c, map = c.map;
    const ad = Math.abs(a.d), side = Math.sign(a.d) || a.side;
    if (Math.abs(a.d - RIDE_D) < BAND + 0.1 && a.s - c.tram.trainU > -TRAM_LEN - 4 && a.s - c.tram.trainU < c.tram.clearAhead + 30) return false;
    if (!a.noRect && map.rectInner(a.s, side, ad + AGENT_R * 0.5)) return false;
    if (!a.inDoor && ad > map.wallAt(a.s, side) && !map.mouthAt(a.s, side)) return false;
    map.gatherCircles(a.s, 2);
    for (let k = 0; k < map.qN; k++) {
      const i = map.qI[k], ds = map.qDS[k], dd = map.cD[i] - a.d;
      if (ds * ds + dd * dd < (map.cR[i] + AGENT_R + 0.1) ** 2) return false;
    }
    return true;
  }

  /** Initial street: walkers over the whole range, chat groups, then the features. */
  fillInitial() {
    const c = this.c, r = c.rng;
    this.scanFeatures(true);
    this._targets();
    for (let b = 0; b < this.nBins; b++) {
      const s0 = c.camU - RANGE_BEHIND + b * BIN;
      let want = Math.round(this.binTarget[b] * r.range(0.85, 1.1));
      let guard = 0;
      while (want > 0 && guard++ < 40 && this.free.length > 8) {
        const side = r.chance(0.5) ? 1 : -1;
        const sU = s0 + r.next() * BIN;
        // some of them are standing talking
        if (r.chance(0.07) && c.counts.stand < STANDER_TARGET) {
          const n = this.spawnChat(sU, side);
          if (n) { want -= n; c.counts.stand += n; continue; }
        }
        const a = this.spawnWalker(sU, side, r.chance(0.5) ? 1 : -1);
        if (a) { want -= 1 + a.nFollow; this.stats.bySource.init += 1 + a.nFollow; }
      }
    }
  }

  /** A small group standing and talking on the sidewalk. Returns how many were placed. */
  spawnChat(sU, side) {
    const c = this.c, r = c.rng, map = c.map;
    const lo = map.bandInAt(sU, side), hi = map.bandOutAt(sU, side);
    if (hi - lo < 2.0) return 0;
    const cd = side * r.range(lo + 0.7, hi - 0.7);
    const n = r.weighted([[2, 0.6], [3, 0.3], [4, 0.1]]);
    const rad = n === 2 ? r.range(0.42, 0.55) : r.range(0.55, 0.7);
    const a0 = r.range(0, PI * 2);
    let leader = null, placed = 0;
    const dur = r.range(20, 150);
    for (let k = 0; k < n; k++) {
      const a = this.alloc(KIND.STANDER, 'chat');
      if (!a) break;
      const ang = a0 + (k / n) * PI * 2 + r.range(-0.25, 0.25);
      a.s = sU + Math.cos(ang) * rad; a.d = cd + Math.sin(ang) * rad;
      a.side = side; a.dir = r.chance(0.5) ? 1 : -1; a.lane = LANE.SIDE; a.laneF = r.next();
      if (!this._placeOk(a)) { this.kill(a); this.stats.spawned--; continue; }
      a.task = TASK.CHAT; a.state = ST.STAND; a.timer = dur;
      a.faceA = Math.atan2(cd - a.d, sU - a.s); a.alpha = a.faceA;
      a.vs = 0;
      if (!leader) leader = a;
      else { a.leader = leader; leader.followers.push(a); a.slotF = (a.s - leader.s) * leader.dir; a.slotR = (a.d - leader.d) * leader.dir; a.dir = leader.dir; }
      placed++;
    }
    if (leader) {
      leader.nFollow = leader.followers.length;
      if (placed < 2) { this.kill(leader); return 0; }
    }
    return placed;
  }

  // ---------------------------------------------------------------- per-frame maintenance
  maintain(dt) {
    const c = this.c;
    this.featureT -= dt;
    if (this.featureT <= 0) { this.featureT = 0.3; this.scanFeatures(false); }
    this._stationEvents();
    // recycle
    const lo = c.camU - RANGE_BEHIND, hi = c.camU + RANGE_AHEAD + 14;
    for (const a of this.agents) {
      if (!a.active) continue;
      if (a.s < lo || a.s > hi) { this.stats.recycled++; this.kill(a); }
    }
    // spawn towards the target
    this._targets();
    this.binCount.fill(0);
    let walkers = 0;
    for (const a of this.agents) {
      if (!a.active || a.kind === KIND.SEATED || a.kind === KIND.PASSENGER) continue;
      walkers++;
      const b = Math.floor((a.s - lo) / BIN);
      if (b >= 0 && b < this.nBins) this.binCount[b]++;
    }
    let budget = 5, tries = 10;
    while (walkers < this.walkerTarget - 1 && budget > 0 && tries-- > 0 && this.free.length > 6) {
      const n = this._spawnOne();
      if (n) { walkers += n; budget--; }
    }
  }

  _spawnOne() {
    const c = this.c, r = c.rng;
    // pick a bin by deficit; far and near bins (where arrivals are hidden) are favoured
    let tot = 0;
    const w = this._w || (this._w = new Float32Array(this.nBins));
    for (let b = 0; b < this.nBins; b++) {
      const sRel = -RANGE_BEHIND + (b + 0.5) * BIN;
      const def = Math.max(0, this.binTarget[b] - this.binCount[b]);
      const k = sRel > RANGE_AHEAD - FAR_SPAWN_BAND ? 3 : sRel < 45 ? 1.5 : 1;
      w[b] = def * k; tot += w[b];
    }
    if (tot <= 0) return 0;
    let x = r.next() * tot, b = 0;
    for (; b < this.nBins - 1; b++) { x -= w[b]; if (x <= 0) break; }
    const sRel = -RANGE_BEHIND + (b + r.next()) * BIN;
    const sU = c.camU + sRel;
    const side = r.chance(0.5) ? 1 : -1;
    let a = null, src = '';
    if (sRel > RANGE_AHEAD - FAR_SPAWN_BAND) {
      // at the far end of the range: preferably out of a doorway / side street, else just there
      if (r.chance(0.5)) { a = this._spawnFromDoor(sU, side); src = 'door'; }
      if (!a) { a = this.spawnWalker(sU, side, r.chance(0.5) ? -1 : 1); src = 'far'; }
    } else if (sRel < 45) {
      a = this.spawnWalker(sU, side, r.chance(0.5) ? 1 : -1);
      if (a && !this._groupHidden(a)) { this._killGroup(a); a = null; }
      src = 'near';
    } else if (r.chance(0.45)) {
      a = this._spawnFromSideStreet(sU, side); src = 'side';
      if (!a) { a = this._spawnFromDoor(sU, side); src = 'door'; }
    } else {
      a = this._spawnFromDoor(sU, side); src = 'door';
      if (!a) { a = this._spawnFromSideStreet(sU, side); src = 'side'; }
    }
    if (!a) { this.stats.spawnFail++; return 0; }
    this.stats.bySource[src] += 1 + a.nFollow;
    return 1 + a.nFollow;
  }

  _groupHidden(a) {
    const vis = this.c.vis;
    if (!vis.hidden(a.s, a.d)) return false;
    for (const f of a.followers) if (!vis.hidden(f.s, f.d)) return false;
    return true;
  }

  _killGroup(a) {
    for (const f of [...a.followers]) { this.kill(f); this.stats.spawned--; }
    this.kill(a); this.stats.spawned--;
  }

  _spawnFromSideStreet(sU, side) {
    const c = this.c, r = c.rng, map = c.map;
    for (let k = -2; k <= 2; k++) {
      const m = map.mouthAt(sU + k * 6, side);
      if (!m) continue;
      const ms = c.unwrap(m.s), line = map.mouthLine(m, side);
      const x = r.range(-1, 1) * (m.width / 2 - 1.4), depth = r.range(5, 10);
      const sp = ms + x, dp = side * (line + depth);
      if (!c.vis.hidden(sp, dp, side, line, ms - m.width / 2, ms + m.width / 2)) return null;
      const a = this.spawnWalker(sp, side, r.chance(0.5) ? 1 : -1, { d: dp, lane: LANE.SIDE, force: true, group: 0.3, src: 'side' });
      if (!a) return null;
      for (const f of a.followers) { f.d = dp + r.range(-0.4, 0.4); f.s = sp + (f.s - sp); }
      a.mouth = m; a.task = TASK.EMERGE; a.state = ST.GOTO;
      a.gs = sp + r.range(-1, 1); a.gd = side * (line - 1.0); a.gTol = 0.6;
      a.alpha = side > 0 ? -PI / 2 : PI / 2;
      a.vs = 0;
      return a;
    }
    return null;
  }

  _spawnFromDoor(sU, side) {
    const c = this.c, r = c.rng, map = c.map;
    const ops = map.openingsAt(sU, side);
    if (!ops || !ops.length) return null;
    const o = r.pick(ops);
    if (o.half < 0.45) return null;
    const sO = c.unwrap(o.s);
    if (map.cafeAtS(sO, side)) return null;
    const dIn = side * (o.d + Math.min(o.recess - 0.12, 0.3));
    if (!c.vis.hidden(sO, dIn, side, o.d, sO - o.half, sO + o.half)) return null;
    const a = this.spawnWalker(sO, side, r.chance(0.5) ? 1 : -1, { d: dIn, lane: LANE.SIDE, force: true, group: 0.12, src: 'door' });
    if (!a) return null;
    for (const f of a.followers) { f.s = sO + r.range(-0.3, 0.3); f.d = dIn; f.inDoor = true; f.doorS0 = sO - o.half + 0.25; f.doorS1 = sO + o.half - 0.25; }
    a.inDoor = true; a.doorS0 = sO - o.half + 0.25; a.doorS1 = sO + o.half - 0.25;
    a.task = TASK.EMERGE; a.state = ST.GOTO;
    a.gs = sO + a.dir * r.range(0.3, 1.2); a.gd = side * (map.wallAt(sO, side) - r.range(0.6, 1.2)); a.gTol = 0.4;
    a.alpha = side > 0 ? -PI / 2 : PI / 2; a.vs = 0;
    return a;
  }

  // ---------------------------------------------------------------- features: cafés, platforms
  scanFeatures(initial) {
    const c = this.c, L = c.layout;
    const lo = -RANGE_BEHIND + 4, hi = RANGE_AHEAD;
    for (const cafe of L.cafes) {
      const rel = c.unwrap((cafe.s0 + cafe.s1) / 2) - c.camU;
      const inRange = rel > lo && rel < hi;
      const f = this.cafes.get(cafe.id);
      if (inRange && !f) this._populateCafe(cafe);
      else if (!inRange && f && (rel < lo - 20 || rel > hi + 30)) this.cafes.delete(cafe.id);
    }
    for (const b of this.benchList) {
      const rel = c.unwrap(b.s) - c.camU;
      const inRange = rel > lo && rel < hi;
      const f = this.benches.get(b.id);
      if (inRange && !f) this._populateBench(b);
      else if (!inRange && f && (rel < lo - 20 || rel > hi + 30)) this.benches.delete(b.id);
    }
    for (const st of L.stations) {
      const rel = c.unwrap(st.s) - c.camU;
      const inRange = rel > lo - 30 && rel < hi;
      const f = this.stations.get(st.id);
      if (inRange && !f) this._populateStation(st, initial);
      else if (!inRange && f && (rel < lo - 60 || rel > hi + 60)) this.stations.delete(st.id);
    }
  }

  _populateCafe(cafe) {
    const c = this.c;
    const r = c.featureRng('cafe', cafe.id);
    const feat = { type: 'cafe', cafe, occ: new Set(), seats: [] };
    this.cafes.set(cafe.id, feat);
    const busy = r.range(0.35, 0.8);
    cafe.tables.forEach((t, ti) => {
      const used = r.chance(busy);
      t.chairs.forEach((ch, ci) => {
        const key = ti * 8 + ci;
        const s = c.unwrap(ch.s), ts = c.unwrap(t.s);
        const seat = { type: 'seat', cafe, feat, key, s, d: ch.d, side: cafe.side, faceA: Math.atan2(t.d - ch.d, ts - s), exitD: cafe.side * (cafe._crowdInner - 0.5) };
        feat.seats.push(seat);
        if (!used || !r.chance(0.72) || c.counts.seated >= MAX_SEATED - BENCH_RESERVE) return;
        this._seat(seat, r);
      });
    });
  }

  /** People resting on the street benches (facing the sidewalk, away from the tracks). */
  _populateBench(b) {
    const c = this.c;
    const r = c.featureRng('bench', b.id);
    const side = Math.sign(b.d) || 1;
    const feat = { type: 'bench', occ: new Set(), seats: [] };
    this.benches.set(b.id, feat);
    const n = r.weighted([[0, 0.5], [1, 0.32], [2, 0.18]]);
    const slots = [-0.55, 0, 0.55];
    const first = r.int(0, 2);
    for (let k = 0; k < 3; k++) {
      const x = slots[k];
      const seat = { type: 'seat', cafe: null, feat, key: k, s: c.unwrap(b.s) + x, d: b.d - side * 0.04, side, faceA: side > 0 ? PI / 2 : -PI / 2, exitD: b.d + side * 0.95 };
      feat.seats.push(seat);
    }
    const order = n === 2 ? [0, 2] : [first];
    for (let k = 0; k < n && c.counts.seated < MAX_SEATED; k++) this._seat(feat.seats[order[k]], r);
  }

  _seat(seat, r) {
    const c = this.c;
    const a = this.alloc(KIND.SEATED, 'seat');
    if (!a) return null;
    a.state = ST.SEATED; a.s = seat.s; a.d = seat.d; a.side = seat.side; a.noRect = true;
    a.faceA = seat.faceA + r.range(-0.15, 0.15);
    a.alpha = a.faceA;
    a.timer = r.range(30, 900);
    a.feature = seat; seat.feat.occ.add(seat.key);
    a.dir = r.chance(0.5) ? 1 : -1;
    c.counts.seated++;
    return a;
  }

  /** A free chair of a café near the agent (unwrapped copy) or null. */
  freeChair(cafe, a) {
    const feat = this.cafes.get(cafe.id);
    if (!feat) return null;
    let best = null, bd = 6;
    for (const seat of feat.seats) {
      if (feat.occ.has(seat.key)) continue;
      const dd = Math.abs(seat.s - a.s);
      if (dd < bd) { bd = dd; best = seat; }
    }
    if (best) feat.occ.add(best.key);
    return best;
  }

  releaseChair(seat) { seat.feat.occ.delete(seat.key); }

  _populateStation(st, initial) {
    const c = this.c;
    const r = c.featureRng('station', st.id, Math.floor(c.time / 300));
    const entry = { station: st, served: false, feats: {} };
    this.stations.set(st.id, entry);
    for (const pl of st.platforms) {
      const feat = { type: 'platform', station: st, platform: pl, side: pl.side, count: 0, cap: pl.side > 0 ? 18 : 13 };
      entry.feats[pl.side] = feat;
      const n = pl.side > 0 ? r.int(6, 13) : r.int(4, 10);
      for (let k = 0; k < n && c.counts.passenger < MAX_PASSENGERS; k++) {
        const spot = this.platformSpot(feat, r);
        if (!spot) continue;
        const a = this.alloc(KIND.PASSENGER, 'platform');
        if (!a) break;
        a.state = ST.PLATFORM; a.s = spot.s; a.d = spot.d; a.side = pl.side; a.noRect = true;
        a.faceA = this.passengerFacing(pl.side, r); a.alpha = a.faceA;
        a.timer = r.range(20, 240);
        a.feature = feat; feat.count++;
        c.counts.passenger++;
      }
    }
    void initial;
  }

  platformFeature(st, side) { const e = this.stations.get(st.id); return e ? e.feats[side] : null; }

  /** A free standing spot on a platform (unwrapped s, signed d). */
  platformSpot(feat, r = this.c.rng) {
    const c = this.c, pl = feat.platform, st = feat.station;
    const s0 = c.unwrap(pl.s0), len = pl.s1 - pl.s0;
    const shelterS = c.unwrap(st.s) + (pl.side > 0 ? 6 : -6);
    for (let tries = 0; tries < 12; tries++) {
      const s = s0 + r.range(2.2, len - 2.2);
      const u = r.next();
      let ad = TRACK_ZONE_HALF + 0.42 + u * u * (PLATFORM_W - 0.85);
      if (Math.abs(s - shelterS) < 3.2) ad = Math.min(ad, TRACK_ZONE_HALF + 1.3);
      const d = pl.side * ad;
      let ok = true;
      for (const a of this.agents) {
        if (!a.active || a.feature !== feat) continue;
        if ((a.s - s) ** 2 + (a.d - d) ** 2 < 0.65 * 0.65) { ok = false; break; }
      }
      if (!ok) continue;
      c.map.gatherCircles(s, 1.5);
      for (let k = 0; k < c.map.qN && ok; k++) {
        const i = c.map.qI[k], ds = c.map.qDS[k], dd = c.map.cD[i] - d;
        if (ds * ds + dd * dd < (c.map.cR[i] + 0.4) ** 2) ok = false;
      }
      if (ok) return { s, d };
    }
    return null;
  }

  /** Waiting passengers face the track or the direction their tram comes from. */
  passengerFacing(side, r = this.c.rng) {
    return side > 0 ? -PI / 2 - r.range(-0.35, 1.25) : PI / 2 - r.range(-0.35, 1.25);
  }

  /** Boarding / alighting when the tram stands at a platform. */
  _stationEvents() {
    const c = this.c, tram = c.tram;
    for (const entry of this.stations.values()) {
      const here = tram.stoppedAt === entry.station;
      if (!here) { if (entry.served && tram.v > 1) entry.served = false; continue; }
      if (entry.served) continue;
      entry.served = true;
      const feat = entry.feats[1];
      if (!feat) continue;
      const pl = feat.platform;
      const s0 = c.unwrap(pl.s0), s1 = s0 + (pl.s1 - pl.s0);
      const doors = [];
      for (const off of [3.5, 10.5, 17.5, 24.5, 31.5]) { const s = tram.trainU - off; if (s > s0 + 0.8 && s < s1 - 0.8) doors.push(s); }
      if (!doors.length) continue;
      const r = c.rng;
      for (const a of this.agents) {
        if (!a.active || a.feature !== feat || a.state !== ST.PLATFORM) continue;
        let best = doors[0];
        for (const s of doors) if (Math.abs(s - a.s) < Math.abs(best - a.s)) best = s;
        a.timer = 0;
        board(c, a, best);
      }
      // people getting off walk away towards the platform end behind the cab
      const n = r.int(2, 7);
      for (let k = 0; k < n; k++) {
        const ds = r.pick(doors);
        const a = this.alloc(KIND.PASSENGER, 'alight');
        if (!a) break;
        a.s = ds + r.range(-0.4, 0.4); a.d = TRACK_ZONE_HALF + 0.45; a.side = 1; a.noRect = true;
        if (!c.vis.hidden(a.s, a.d)) { this.kill(a); this.stats.spawned--; continue; }
        a.feature = feat; feat.count++;
        a.task = TASK.ALIGHT; a.step = 0; a.state = ST.GOTO;
        a.gs = s0 - 1.0; a.gd = TRACK_ZONE_HALF + PLATFORM_W * 0.5; a.gTol = 0.7;
        a.alpha = PI;
        this.stats.bySource.alight++;
      }
    }
  }
}

