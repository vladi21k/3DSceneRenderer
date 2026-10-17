import { hash2, noise1 } from '../../core/rng.js';
import { TRACK_ZONE_HALF } from '../../core/config.js';
import { PLATFORM_W } from '../../world/layout.js';
import { Agent, KIND, ST, TASK, LANE } from './agent.js';
import { laneTarget, setLane, board, doorOf } from './behaviour.js';
import {
  MAX_AGENTS, RANGE_BEHIND, RANGE_AHEAD, FAR_TAPER, FAR_SLACK, FAR_HARD, FAR_SPAWN_BAND, WALKER_DENSITY, MAX_SEATED,
  MAX_PASSENGERS, STANDER_TARGET, WALK_MEAN, WALK_SD, WALK_MIN, WALK_MAX, RIDE_D, BAND, AGENT_R, TRAM_LEN,
  CLEAR_T, CLEAR_T_DREAMY,
} from './constants.js';

// Who is on the street. Keeps the density target over the populated range,
// recycles people who fall behind the camera or walk out of range, and brings new
// ones in only where nobody is looking: beside / behind the camera, out of side
// streets and shop doors, or right behind somebody (or a kiosk) on the same line of
// sight far down the street. Also seats café patrons and bench sitters, fills
// platforms and hands boarding / alighting passengers to the tram. Children only
// appear with an adult.

const BIN = 10;
const BENCH_RESERVE = 12;   // seated slots kept for people on benches
const FEATURE_AHEAD = RANGE_AHEAD + 70;   // cafés / platforms are filled this far out (deep in the haze)
const BENCH_SEAT_Z = -0.02;  // body origin of a bench sitter along the bench's facing (m, bench local)
const PI = Math.PI;

export class Population {
  constructor(c) {
    this.c = c;
    this.agents = Array.from({ length: MAX_AGENTS }, (_, i) => { const a = new Agent(i); a.followers = []; a.wards = []; return a; });
    this.free = [];
    for (let i = MAX_AGENTS - 1; i >= 0; i--) this.free.push(i);
    this.serial = 0;
    this.cafes = new Map();      // cafe id -> feature
    this.benches = new Map();    // furniture id -> feature
    this.benchList = c.layout.furniture.filter((f) => f.type === 'bench');
    this.occluders = c.layout.furniture.filter((f) => f.type === 'kiosk' || f.type === 'advertColumn')
      .map((f) => ({ s: f.s, d: f.d, w: f.type === 'kiosk' ? 2.2 : 1.15 }));
    this.stations = new Map();   // station id -> {right, left, served}
    this.queue = [];             // seats / platform spots waiting to be filled (a few per frame)
    this.featureT = 0;
    this.nBins = Math.ceil((RANGE_AHEAD + RANGE_BEHIND) / BIN);
    this.binCount = new Float32Array(this.nBins);
    this.binTarget = new Float32Array(this.nBins);
    this.walkerTarget = 0;
    this.targetT = 0;
    this.frame = 0;
    this.stats = { spawned: 0, recycled: 0, vanished: 0, spawnFail: 0, farHidden: 0, farForced: 0, bySource: { far: 0, behind: 0, near: 0, side: 0, door: 0, alight: 0, init: 0 } };
    this.popOut = [0, 0, 0, 0];  // removals of figures in plain view, by distance
  }

  // ---------------------------------------------------------------- slots
  /** role: 'adult' (default), 'child' or 'any'. opt.maxH caps the height, opt.noCross avoids the crossed-legs sitting variant. */
  alloc(kind, src = 'walker', role = 'adult', opt = null) {
    if (!this.free.length) return null;
    const a = this.agents[this.free.pop()];
    const c = this.c, r = c.rng;
    a.active = true; a.serial = ++this.serial; a.kind = kind;
    a.state = ST.WALK; a.task = TASK.NONE; a.step = 0;
    a.vs = 0; a.vd = 0; a.leader = null; a.followers.length = 0; a.nFollow = 0; a.slotF = 0; a.slotR = 0;
    a.wards.length = 0; a.guardian = null;
    a.appearance = this._appearance(role, opt);
    const H = c.humans;
    const ap = H && H.appearanceOf ? H.appearanceOf(a.appearance) : null;
    a.isChild = ap ? ap.base === 'child' : false;
    a.height = ap ? ap.height : 1.72;
    a.phase = r.next(); a.pose = 0; a.look = 0; a.lookGoal = 0; a.tramLookT = 0;
    a.clearing = false; a.noRect = false; a.inDoor = false; a.mouth = null; a.after = 0;
    a.feature = null; a.door = null; a.stuckT = 0; a.h = 0; a.timer = 0;
    a.thinkT = r.range(0.2, 1.5); a.simple = false; a.gTol = 0.3;
    a.v0 = Math.min(WALK_MAX, Math.max(WALK_MIN, r.normal(WALK_MEAN, WALK_SD)));
    a.dir = 1; a.side = 1; a.lane = LANE.SIDE; a.laneF = 0.5; a.laneD = 0;
    a.dreamy = r.chance(0.08); a.bellT = 0; a.tramLookS = 0;
    a.clearT = a.dreamy ? r.range(CLEAR_T_DREAMY[0], CLEAR_T_DREAMY[1]) : r.range(CLEAR_T[0], CLEAR_T[1]);
    a.needsBell = a.dreamy || r.chance(0.1);
    a.dodge = 0; a.dodgeT = 0; a.passT = -1e9;
    a.fresh = true; a.src = src; a.strideV = -1; a.afs = 0; a.afd = 0; a.laneTT = 0;
    a.pValid = false; a.speedA = 0; a.moving = false; a.uturnT = 0; a.driftT = 0;
    a.baseF = 0; a.baseR = 0; a.singleT = 0; a.stuckF = 0; a.bandW = 9;
    a.wSeed = hash2(this.serial, 977) & 0xffff;
    a.wT = r.range(4, 10); a.paceT = r.range(5, 15); a.faceJ = r.range(-0.25, 0.25);
    a.spawnHidden = false; a.seatS = 0; a.seatD = 0;
    this.stats.spawned++;
    return a;
  }

  /** Appearance seed for the role: re-hashed until the body fits (adult / child, height, sitting style). */
  _appearance(role, opt) {
    const H = this.c.humans;
    let seed = hash2(this.serial, this.c.seed * 7919 + 13) >>> 0;
    if (!H || !H.appearanceOf) return seed;
    for (let k = 0; k < 48; k++) {
      const ap = H.appearanceOf(seed);
      const child = ap.base === 'child';
      const ok = (role === 'any' || (role === 'child') === child)
        && (!opt || ((!opt.maxH || ap.height <= opt.maxH) && (!opt.noCross || ap.sit !== 1)));
      if (ok) break;
      seed = hash2(seed, k + 101) >>> 0;
    }
    return seed;
  }

  /** Remove from the street (slot returns to the pool). reason 'recycle' counts removals in plain view. */
  kill(a, reason = '') {
    if (!a.active) return;
    if (reason === 'recycle') this._noteGone(a);
    a.active = false;
    if (a.feature) {
      if (a.feature.type === 'seat') this.releaseChair(a.feature);
      else if (a.feature.type === 'platform') this.leavePlatform(a);
      a.feature = null;
    }
    if (a.leader) {
      const f = a.leader.followers, i = f.indexOf(a);
      if (i >= 0) f.splice(i, 1);
      a.leader.nFollow = f.length;
      a.leader = null;
    }
    if (a.guardian) { const w = a.guardian.wards, i = w.indexOf(a); if (i >= 0) w.splice(i, 1); a.guardian = null; }
    // children never stay behind on their own
    for (const w of [...a.wards]) this.kill(w, reason);
    a.wards.length = 0;
    const fol = [...a.followers];
    a.followers.length = 0; a.nFollow = 0;
    for (const m of fol) {
      m.leader = null;
      if (m.isChild) { this.kill(m, reason); continue; }
      if (m.state !== ST.GOTO) { m.state = ST.WALK; m.task = TASK.NONE; }
    }
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
    this.queue.length = 0;
  }

  groupOf(a) {
    const L = a.leader || a;
    return [L, ...L.followers];
  }

  // ---------------------------------------------------------------- visibility of arrivals / departures
  /** A removal that someone could see (in the frustum, not masked by a facade or an occluder). */
  _noteGone(a) {
    const c = this.c, vis = c.vis;
    if (a.state === ST.SEATED || !vis.inView(a.s, a.d)) return;
    const side = a.d >= 0 ? 1 : -1;
    if (Math.abs(a.d) > c.map.facadeAt(a.s, side) - 0.2) return;
    if (this._occluded(a)) return;
    const dist = Math.abs(a.s - c.camU);
    this.popOut[dist < 100 ? 0 : dist < 250 ? 1 : dist < 450 ? 2 : 3]++;
  }

  /** Is a's figure hidden right behind a taller figure or a kiosk / advert column (same line of sight)? */
  _occluded(a) {
    const c = this.c, vis = c.vis;
    for (const b of this.agents) {
      if (!b.active || b === a || b.kind === KIND.SEATED || b.height < a.height - 0.02) continue;
      if (Math.abs(b.s - a.s) > 14 || b.s > a.s - 0.8) continue;
      if (vis.rayOffset(a.s, a.d, b.s, b.d) < 0.1) return true;
    }
    for (const o of this.occluders) {
      const so = c.unwrap(o.s);
      if (Math.abs(so - a.s) > 12) continue;
      if (vis.rayOffset(a.s, a.d, so, o.d) < o.w / 2 - 0.26) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- density
  /** Walkers per metre on one side at unwrapped s. */
  density(sU, side) {
    const c = this.c, map = c.map;
    let m = 1;
    if (map.mouthAt(sU, side) || map.mouthAt(sU + 8, side) || map.mouthAt(sU - 8, side)) m += 0.35;
    if (map.stationAt(sU) || map.stationAt(sU + 20) || map.stationAt(sU - 20)) m += 0.15;
    m *= 0.75 + 0.5 * (0.5 + 0.5 * noise1(c.route.wrap(sU) / 70, side > 0 ? 401 : 403));
    // spend the budget where the cab view sees individuals: thin behind and beside the cab,
    // tapering off far down the street where figures are a few pixels in the haze
    const rel = sU - c.camU;
    m *= rel < 0 ? 0.35 : rel < 30 ? 0.6 + 0.75 * (rel / 30) : rel < 200 ? 1.35 : rel < 300 ? 1.0 : rel < FAR_TAPER ? 0.72 : 0.42;
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
    const a = this.alloc(opts.kind ?? KIND.WALKER, opts.src, 'adult', opts.maxH ? { maxH: opts.maxH } : null);
    if (!a) return null;
    a.s = sU; a.side = side; a.dir = dir;
    a.d = side * (c.map.bandInAt(sU, side) + 1); // provisional (lane choice looks at where the agent is)
    setLane(c, a, r);
    if (opts.lane !== undefined) { a.lane = opts.lane; if (a.lane === LANE.SIDE) a.laneF = r.range(0.04, 0.96); }
    if (opts.laneD !== undefined) { a.lane = LANE.CORR; a.laneD = opts.laneD; }
    a.d = opts.d ?? laneTarget(c, a);
    if (opts.d === undefined) a.d += r.range(-0.2, 0.2);
    a.alpha = dir > 0 ? 0 : PI;
    a.vs = dir * a.v0 * (opts.still ? 0 : 1);
    if (!opts.force && !this._placeOk(a)) { this._unspawn(a); this.stats.spawnFail++; return null; }
    const groupP = opts.group ?? 0.34;
    if (r.chance(groupP)) this._makeGroup(a, opts);
    return a;
  }

  /** Companions for leader a: couples side by side, threes in a loose V / U, fours in pairs,
   *  sometimes a family with children holding on beside an adult. */
  _makeGroup(a, opts) {
    const c = this.c, r = c.rng;
    const n = r.weighted([[1, 0.62], [2, 0.28], [3, 0.1]]);
    const kids = r.chance(0.2) ? (n >= 2 && r.chance(0.4) ? 2 : 1) : 0;
    a.v0 = Math.max(WALK_MIN, a.v0 * (kids ? 0.82 : 0.9));
    const R1 = r.range(0.56, 0.72) * (r.chance(0.5) ? 1 : -1);
    const V = (r.chance(0.7) ? 1 : -1) * r.range(0.3, 0.5);
    let slots;
    if (n === 1) slots = [[r.range(-0.15, 0.15), R1]];
    else if (n === 2) slots = [[V + r.range(-0.08, 0.08), R1], [V + r.range(-0.08, 0.08), -R1 * r.range(0.9, 1.1)]];
    else slots = [[r.range(-0.12, 0.12), R1], [-r.range(0.85, 1.0), -R1 * 0.5 + r.range(-0.1, 0.1)], [-r.range(0.85, 1.0), R1 * 0.5 + r.range(-0.1, 0.1)]];
    // children take the slots right beside the leader (hand-holding distance)
    const kidR = [-Math.sign(R1) * r.range(0.38, 0.46), Math.sign(R1) * r.range(0.38, 0.46)];
    for (let k = 0; k < n && this.free.length > 4; k++) {
      const child = k >= n - kids;
      const f = this.alloc(a.kind, opts.src, child ? 'child' : 'any');
      if (!f) break;
      let [F, R] = slots[k];
      if (child) { F = r.range(-0.05, 0.12); R = kidR[(n - 1 - k) % 2]; }
      f.baseF = F; f.baseR = R;
      const th = a.dir > 0 ? 0 : PI, cf = Math.cos(th), sf = Math.sin(th);
      f.s = a.s + cf * F - sf * R; f.d = a.d + sf * F + cf * R;
      f.side = a.side; f.dir = a.dir; f.lane = a.lane; f.laneF = a.laneF; f.laneD = a.laneD;
      f.v0 = a.v0 * r.range(1.0, 1.06); f.alpha = a.alpha; f.vs = a.vs;
      f.inDoor = a.inDoor;
      if (!opts.force && !this._placeOk(f)) { this._unspawn(f); continue; }
      f.leader = a; a.followers.push(f);
      f.state = a.state;
    }
    a.nFollow = a.followers.length;
  }

  /** Undo an alloc that found no room (not counted as a spawn). */
  _unspawn(a) { this.kill(a); this.stats.spawned--; }

  /** Spot is acceptable: no obstacle overlap, not in a café / platform, outside the tram's band. */
  _placeOk(a) {
    const c = this.c, map = c.map;
    const ad = Math.abs(a.d), side = Math.sign(a.d) || a.side;
    const ahead = a.s - c.tram.trainU;
    if (Math.abs(a.d - RIDE_D) < BAND + 0.1 && ahead > -TRAM_LEN - 4 && ahead < c.tram.clearAhead + 30) return false;
    if (!a.noRect && map.rectInner(a.s, side, ad, AGENT_R * 0.5)) return false;
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
    this._count();
    this.scanFeatures();
    this._fillQueue(1e9);
    this._count();
    this._targets();
    for (let b = 0; b < this.nBins; b++) {
      const s0 = c.camU - RANGE_BEHIND + b * BIN;
      let want = Math.round(this.binTarget[b] * r.range(0.85, 1.1));
      let guard = 0;
      while (want > 0 && guard++ < 40 && this.free.length > 8) {
        const side = r.chance(0.5) ? 1 : -1;
        const sU = s0 + r.next() * BIN;
        // some of them are standing talking
        if (r.chance(0.07) && c.counts.stand < STANDER_TARGET && sU - c.camU < RANGE_AHEAD - 60) {
          const n = this.spawnChat(sU, side);
          if (n) { want -= n; c.counts.stand += n; continue; }
        }
        const a = this.spawnWalker(sU, side, r.chance(0.5) ? 1 : -1);
        if (a) { want -= 1 + a.nFollow; this.stats.bySource.init += 1 + a.nFollow; }
      }
    }
    for (const a of this.agents) a.fresh = false;
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
      if (!this._placeOk(a)) { this._unspawn(a); continue; }
      a.task = TASK.CHAT; a.state = ST.STAND; a.timer = dur;
      a.chatS = a.s; a.chatD = a.d;
      a.faceA = Math.atan2(cd - a.d, sU - a.s) + r.range(-0.2, 0.2); a.alpha = a.faceA;
      a.vs = 0;
      if (!leader) leader = a;
      else {
        a.leader = leader; leader.followers.push(a); a.dir = leader.dir;
        // walking slots for when the chat ends: side by side, then behind
        const k2 = leader.followers.length;
        a.baseF = k2 === 1 ? r.range(-0.15, 0.15) : -r.range(0.8, 1.0);
        a.baseR = (k2 % 2 ? 1 : -1) * r.range(0.55, 0.7);
      }
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
    this.frame++;
    this.featureT -= dt;
    if (this.featureT <= 0) { this.featureT = 0.3; this.scanFeatures(); }
    this._fillQueue(3);
    this._stationEvents();
    // one pass: recycling, head counts by kind and walkers per bin
    const lo = c.camU - RANGE_BEHIND;
    const k = c.counts;
    k.seated = 0; k.passenger = 0; k.stand = 0; k.walker = 0;
    this.binCount.fill(0);
    let walkers = 0;
    for (const a of this.agents) {
      if (!a.active) continue;
      const rel = a.s - c.camU;
      if (a.s < lo) { this.stats.recycled++; this.kill(a, 'recycle'); continue; }
      if (rel > RANGE_AHEAD + FAR_SLACK && !a.leader && a.kind !== KIND.SEATED && a.kind !== KIND.PASSENGER) {
        // far beyond the range: leave only unseen (or, rarely, when much too far)
        const hard = rel > RANGE_AHEAD + FAR_HARD;
        if (hard || ((this.frame + a.slot) % 12 === 0 && this._groupHiddenFar(a))) {
          this.stats.recycled++;
          if (hard) this.stats.farForced++; else this.stats.farHidden++;
          this.kill(a, hard ? 'recycle' : '');
          continue;
        }
      }
      if (a.kind === KIND.SEATED) k.seated++;
      else if (a.kind === KIND.PASSENGER) k.passenger++;
      else {
        k.walker++; walkers++;
        if (a.state === ST.STAND) k.stand++;
        const b = Math.floor((a.s - lo) / BIN);
        if (b >= 0 && b < this.nBins) this.binCount[b]++;
      }
    }
    // spawn towards the target (targets follow the camera slowly: refresh twice a second)
    this.targetT -= dt;
    if (this.targetT <= 0) { this.targetT = 0.5; this._targets(); }
    let budget = 2, tries = 3;
    while (walkers < this.walkerTarget - 1 && budget > 0 && tries-- > 0 && this.free.length > 6) {
      const n = this._spawnOne();
      if (n) { walkers += n; budget--; }
    }
  }

  /** Head counts (outside the per-frame pass: start-up). */
  _count() {
    const k = this.c.counts;
    k.seated = 0; k.passenger = 0; k.stand = 0; k.walker = 0;
    for (const a of this.agents) {
      if (!a.active) continue;
      if (a.kind === KIND.SEATED) k.seated++;
      else if (a.kind === KIND.PASSENGER) k.passenger++;
      else { k.walker++; if (a.state === ST.STAND) k.stand++; }
    }
  }

  _groupHiddenFar(a) {
    const vis = this.c.vis;
    for (const m of this.groupOf(a)) if (vis.inView(m.s, m.d) && !this._occluded(m)) return false;
    return true;
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
      // far down the street: out of a doorway or side street, else right behind somebody
      a = this._spawnFromDoor(sU, side); src = 'door';
      if (!a) { a = this._spawnFromSideStreet(sU, side); src = 'side'; }
      if (!a) { a = this._spawnBehind(sU, side); src = 'behind'; }
    } else if (sRel < 45) {
      a = this.spawnWalker(sU, side, r.chance(0.5) ? 1 : -1);
      if (a && !this._groupHidden(a)) { this._killGroup(a); a = null; }
      else if (a) a.spawnHidden = true;
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
    for (const f of [...a.followers]) this._unspawn(f);
    this._unspawn(a);
  }

  _spawnFromSideStreet(sU, side) {
    const c = this.c, r = c.rng, map = c.map;
    for (let k = -2; k <= 2; k++) {
      const m = map.mouthAt(sU + k * 6, side);
      if (!m) continue;
      const ms = c.unwrap(m.s), line = map.mouthLine(m, side);
      const x = r.range(-1, 1) * (m.width / 2 - 1.4), depth = r.range(5, 10);
      const sp = ms + x, dp = side * (line + depth);
      const sa = ms - m.width / 2, sb = ms + m.width / 2;
      if (!c.vis.bodyHidden(sp, dp, side, line, sa, sb)) return null;
      const a = this.spawnWalker(sp, side, r.chance(0.5) ? 1 : -1, { d: dp, lane: LANE.SIDE, force: true, group: 0.3, src: 'side' });
      if (!a) return null;
      for (const f of [...a.followers]) {
        f.d = dp + side * r.range(0.4, 1.2); f.s = sp + r.range(-0.5, 0.5);
        if (!c.vis.bodyHidden(f.s, f.d, side, line, sa, sb)) this._unspawn(f);
      }
      a.nFollow = a.followers.length;
      a.mouth = m; a.task = TASK.EMERGE; a.state = ST.GOTO;
      a.gs = sp + r.range(-1, 1); a.gd = side * (line - 1.0); a.gTol = 0.6;
      a.alpha = side > 0 ? -PI / 2 : PI / 2;
      a.vs = 0; a.spawnHidden = true;
      return a;
    }
    return null;
  }

  /** Out of a shop / house door (the door leaf itself, never through display glass or a shutter). */
  _spawnFromDoor(sU, side) {
    const c = this.c, r = c.rng, map = c.map;
    const ops = map.openingsAt(sU, side);
    if (!ops || !ops.length) return null;
    for (let t = 0; t < 3; t++) {
      const o = r.pick(ops);
      const dr = doorOf(c, o);
      if (!dr || map.cafeAtS(dr.s, side)) continue;
      const dIn = side * (o.d + dr.depth - 0.1);
      const s = dr.s + r.range(-0.6, 0.6) * (dr.s1 - dr.s);
      if (!c.vis.bodyHidden(s, dIn, side, o.d, dr.oS - o.half, dr.oS + o.half)) continue;
      const a = this.spawnWalker(s, side, r.chance(0.5) ? 1 : -1, { d: dIn, lane: LANE.SIDE, force: true, group: 0, src: 'door' });
      if (!a) return null;
      a.inDoor = true; a.door = dr; a.doorS0 = dr.s0; a.doorS1 = dr.s1;
      a.task = TASK.EMERGE; a.state = ST.GOTO;
      a.gs = dr.s + a.dir * r.range(0.3, 1.2); a.gd = side * (map.wallAt(dr.s, side) - r.range(0.6, 1.2)); a.gTol = 0.4;
      a.alpha = side > 0 ? -PI / 2 : PI / 2; a.vs = 0; a.spawnHidden = true;
      return a;
    }
    return null;
  }

  /** Far down the street: a figure that steps out from behind another (taller) figure or a kiosk
   *  on the same line of sight, a few metres further away. */
  _spawnBehind(sU, side) {
    const c = this.c, r = c.rng, vis = c.vis, map = c.map;
    // a random occluder near sU on this side (reservoir pick over people, then street furniture)
    let occ = null, n = 0;
    for (const b of this.agents) {
      if (!b.active || b.kind === KIND.SEATED || b.isChild || b.height < 1.58 || b.inDoor) continue;
      if (Math.abs(b.s - sU) > 18 || (b.d >= 0 ? 1 : -1) !== side || b.s - c.camU < 300) continue;
      if (r.next() * ++n < 1) occ = b;
    }
    let os, od, w, maxH, dir;
    if (occ) { os = occ.s; od = occ.d; w = 0.46; maxH = occ.height - 0.03; dir = r.chance(0.6) ? occ.dir : -occ.dir; }
    else {
      for (const o of this.occluders) {
        const so = c.unwrap(o.s);
        if (Math.abs(so - sU) > 25 || (o.d >= 0 ? 1 : -1) !== side) continue;
        if (r.next() * ++n < 1) { os = so; od = o.d; w = o.w; }
      }
      if (os === undefined) return null;
      maxH = 0; dir = r.chance(0.5) ? 1 : -1;
    }
    const behind = occ ? r.range(2.5, 8) : r.range(w / 2 + 0.6, w / 2 + 2.5);
    const s = os + behind, d = vis.rayBehind(os, od, behind);
    if (vis.rayOffset(s, d, os, od) > Math.max(0.03, w / 2 - 0.26)) return null;
    const a = this.spawnWalker(s, side, dir, { d, force: false, group: 0, src: 'behind', maxH: maxH || undefined, laneD: Math.abs(d) < TRACK_ZONE_HALF ? d : undefined });
    if (!a) return null;
    // walk on from where they stand: lane chosen to match the spot
    if (a.lane !== LANE.CORR) {
      const ad = Math.abs(d), bi = map.bandInAt(s, side), bo = map.bandOutAt(s, side);
      if (ad >= bi - 0.2) { a.lane = LANE.SIDE; a.laneF = Math.min(0.96, Math.max(0.04, (ad - bi - 0.3) / Math.max(0.3, bo - bi - 0.6))); }
      else { a.lane = LANE.EDGE; a.laneF = Math.min(1, Math.max(0, (ad - TRACK_ZONE_HALF - 0.55) / 0.4)); }
    }
    a.spawnHidden = true;
    return a;
  }

  // ---------------------------------------------------------------- features: cafés, benches, platforms
  scanFeatures() {
    const c = this.c, L = c.layout;
    const lo = -RANGE_BEHIND + 4, hi = FEATURE_AHEAD;
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
      if (inRange && !f) this._populateStation(st);
      else if (!inRange && f && (rel < lo - 60 || rel > hi + 60)) this.stations.delete(st.id);
    }
  }

  /** Seat / place up to n queued people (features are filled over a few frames). */
  _fillQueue(n) {
    const c = this.c;
    while (n-- > 0 && this.queue.length) {
      const q = this.queue.shift();
      if (q.type === 'seat') {
        if (c.counts.seated >= (q.bench ? MAX_SEATED : MAX_SEATED - BENCH_RESERVE)) continue;
        if (q.seat.feat.occ.has(q.seat.key)) continue;
        let guardian = null;
        if (q.role === 'child') {
          guardian = q.seat.feat.adults && q.seat.feat.adults[q.table];
          if (!guardian || !guardian.active || guardian.state !== ST.SEATED) continue;
        }
        const a = this._seat(q.seat, c.rng, q.role, guardian);
        if (a && q.role === 'adult' && q.table !== undefined) q.seat.feat.adults[q.table] = a;
      } else if (q.type === 'passenger') this._placePassenger(q.feat, q.r);
    }
  }

  _populateCafe(cafe) {
    const c = this.c;
    const r = c.featureRng('cafe', cafe.id);
    const feat = { type: 'cafe', cafe, occ: new Set(), seats: [], adults: [] };
    this.cafes.set(cafe.id, feat);
    const busy = r.range(0.35, 0.8);
    cafe.tables.forEach((t, ti) => {
      const used = r.chance(busy);
      let first = true;
      t.chairs.forEach((ch, ci) => {
        const key = ti * 8 + ci;
        const s = c.unwrap(ch.s), ts = c.unwrap(t.s);
        const seat = { type: 'seat', cafe, feat, key, s, d: ch.d, side: cafe.side, faceA: Math.atan2(t.d - ch.d, ts - s), exitD: cafe.side * (cafe._crowdInner - 0.5) };
        feat.seats.push(seat);
        if (!used || !r.chance(0.72)) return;
        // children only at a table where an adult already sits
        const role = !first && r.chance(0.14) ? 'child' : 'adult';
        this.queue.push({ type: 'seat', seat, role, table: ti });
        if (role === 'adult') first = false;
      });
    });
  }

  /** People resting on the street benches, facing the way the bench faces. */
  _populateBench(b) {
    const c = this.c, route = c.route;
    const r = c.featureRng('bench', b.id);
    const side = Math.sign(b.d) || 1;
    const feat = { type: 'bench', occ: new Set(), seats: [] };
    this.benches.set(b.id, feat);
    // the renderer turns the bench to yaw + π/2 (route-relative heading, + towards +d)
    const out = b.yaw + PI / 2;
    const fs = Math.cos(out), fd = Math.sin(out);
    const n = r.weighted([[0, 0.5], [1, 0.32], [2, 0.18]]);
    const xs = n === 2 ? [-0.45, 0.45] : [0];
    const sb = c.unwrap(b.s);
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k];
      // seat point: along the bench (perpendicular to its facing) and a little towards its front
      const s = sb - fd * x + fs * BENCH_SEAT_Z, d = b.d + fs * x + fd * BENCH_SEAT_Z;
      const k2 = 1 + route.curvature(b.s) * d;
      const seat = { type: 'seat', cafe: null, feat, key: k, s: sb + (s - sb) / Math.max(0.5, k2), d, side, faceA: out, exitD: b.d + side * 0.95, bench: true, end: n === 2 };
      feat.seats.push(seat);
    }
    for (let k = 0; k < n; k++) this.queue.push({ type: 'seat', seat: feat.seats[k], role: 'adult', bench: true });
  }

  _seat(seat, r, role = 'adult', guardian = null) {
    const c = this.c;
    const a = this.alloc(KIND.SEATED, 'seat', role, seat.end ? { noCross: true } : null);
    if (!a) return null;
    a.state = ST.SEATED; a.s = seat.s; a.d = seat.d; a.side = seat.side; a.noRect = true;
    a.seatS = seat.s; a.seatD = seat.d;
    a.faceA = seat.faceA + (seat.bench ? 0 : r.range(-0.15, 0.15));
    a.alpha = a.faceA;
    a.timer = r.range(30, 900);
    a.feature = seat; seat.feat.occ.add(seat.key);
    a.dir = r.chance(0.5) ? 1 : -1;
    a.spawnHidden = true;    // statistics: feature arrivals are counted apart
    if (guardian) { a.guardian = guardian; guardian.wards.push(a); a.timer = 1e9; }
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

  /** The children at an adult's table get up with them and walk along at their side. */
  releaseWards(adult) {
    const r = this.c.rng;
    for (const w of [...adult.wards]) {
      if (!w.active) continue;
      if (w.feature) { this.releaseChair(w.feature); w.feature = null; }
      w.guardian = null;
      w.kind = KIND.WALKER; w.state = ST.WALK; w.task = TASK.NONE; w.noRect = true;
      w.leader = adult; adult.followers.push(w);
      w.baseF = r.range(-0.05, 0.1); w.baseR = (adult.followers.length % 2 ? 1 : -1) * r.range(0.38, 0.46);
      w.dir = adult.dir; w.side = adult.side;
    }
    adult.wards.length = 0;
    adult.nFollow = adult.followers.length;
  }

  _populateStation(st) {
    const c = this.c;
    const r = c.featureRng('station', st.id, Math.floor(c.time / 300));
    const entry = { station: st, served: false, feats: {} };
    this.stations.set(st.id, entry);
    for (const pl of st.platforms) {
      const feat = { type: 'platform', station: st, platform: pl, side: pl.side, count: 0, cap: pl.side > 0 ? 18 : 13, members: new Set() };
      entry.feats[pl.side] = feat;
      const n = pl.side > 0 ? r.int(6, 13) : r.int(4, 10);
      for (let k = 0; k < n; k++) this.queue.push({ type: 'passenger', feat, r });
    }
  }

  _placePassenger(feat, r) {
    const c = this.c, pl = feat.platform;
    if (c.counts.passenger >= MAX_PASSENGERS) return;
    const spot = this.platformSpot(feat, r);
    if (!spot) return;
    const a = this.alloc(KIND.PASSENGER, 'platform');
    if (!a) return;
    a.state = ST.PLATFORM; a.s = spot.s; a.d = spot.d; a.side = pl.side; a.noRect = true;
    a.faceA = this.passengerFacing(pl.side, r); a.alpha = a.faceA;
    a.timer = r.range(20, 240);
    a.spawnHidden = true;
    this.joinPlatform(a, feat);
    c.counts.passenger++;
  }

  platformFeature(st, side) { const e = this.stations.get(st.id); return e ? e.feats[side] : null; }
  joinPlatform(a, feat) { a.feature = feat; feat.count++; feat.members.add(a); }
  leavePlatform(a) {
    const f = a.feature;
    if (!f || f.type !== 'platform') return;
    f.count--; f.members.delete(a);
    a.feature = null;
  }

  /** A free standing spot on a platform (unwrapped s, signed d), behind the edge line. */
  platformSpot(feat, r = this.c.rng) {
    const c = this.c, pl = feat.platform, st = feat.station;
    const s0 = c.unwrap(pl.s0), len = pl.s1 - pl.s0;
    const shelterS = c.unwrap(st.s) + (pl.side > 0 ? 6 : -6);
    for (let tries = 0; tries < 12; tries++) {
      const s = s0 + r.range(2.2, len - 2.2);
      const u = r.next();
      let ad = TRACK_ZONE_HALF + 0.6 + u * u * (PLATFORM_W - 1.0);
      if (Math.abs(s - shelterS) < 3.2) ad = Math.min(ad, TRACK_ZONE_HALF + 1.3);
      const d = pl.side * ad;
      let ok = true;
      for (const a of feat.members) {
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
      for (const a of [...feat.members]) {
        if (!a.active || a.state !== ST.PLATFORM) continue;
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
        if (!c.vis.hidden(a.s, a.d)) { this._unspawn(a); continue; }
        this.joinPlatform(a, feat);
        a.task = TASK.ALIGHT; a.step = 0; a.state = ST.GOTO;
        a.gs = s0 - 1.0; a.gd = TRACK_ZONE_HALF + PLATFORM_W * 0.5; a.gTol = 0.7;
        a.alpha = PI; a.spawnHidden = true;
        this.stats.bySource.alight++;
      }
    }
  }
}
