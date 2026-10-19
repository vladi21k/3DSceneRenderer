import { hash2, noise1 } from '../../core/rng.js';
import { TRACK_ZONE_HALF, VIEW_AHEAD } from '../../core/config.js';
import { PLATFORM_W } from '../../world/layout.js';
import { Agent, KIND, ST, TASK, LANE, MOB, settleShape } from './agent.js';
import { laneTarget, setLane, board, doorOf } from './behaviour.js';
import {
  MAX_AGENTS, RANGE_BEHIND, RANGE_AHEAD, FAR_TAPER, FAR_SLACK, FAR_HARD, FAR_SPAWN_BAND, WALKER_DENSITY, MAX_SEATED,
  MAX_PASSENGERS, STANDER_TARGET, STAND_NEAR, WALK_BY, HURRY, HURRY_BY, RIDE_D, BAND, AGENT_R, TRAM_LEN,
  CLEAR_T, CLEAR_T_DREAMY, MOB_SHARE, STROLLER_V, WALKBIKE_V, CYCLE_V, CYCLE_CLEAR_T, FOOT,
} from './constants.js';
import { updateFoot, footBandGap, propPointDist2, footGap } from './footprint.js';
import { pickRideLane, rideNear, wayClear, rideLine } from './cyclist.js';
import { staffTick } from './staff.js';

// Who is on the street. Keeps the density target over the populated range,
// recycles people who fall behind the camera or walk out of range, and brings new
// ones in only where nobody is looking: beside / behind the camera, out of side
// streets and shop doors, or right behind somebody (or a kiosk) on the same line of
// sight far down the street. Also seats café patrons and bench sitters, fills
// platforms and hands boarding / alighting passengers to the tram. Children only
// appear with an adult. A share of the walkers have a stroller (often with a partner or
// a child walking alongside), ride a bicycle or walk one: spawned to keep their shares,
// only where the whole figure with its stroller / bicycle is out of sight.

const BIN = 10;
const BENCH_RESERVE = 12;   // seated slots kept for people on benches
// cafés / platforms are filled as their chunk is streamed in (the far edge of the built street)
const FEATURE_AHEAD = VIEW_AHEAD + 20;
const BENCH_SEAT_Z = -0.02;  // body origin of a bench sitter along the bench's facing (m, bench local)
const PI = Math.PI;
const MOB_LIST = [[MOB.CYCLE, MOB_SHARE.cycle], [MOB.STROLLER, MOB_SHARE.stroller], [MOB.WALKBIKE, MOB_SHARE.walkbike]];
// Who is who: the cast has a few dozen characters for several hundred people on the street, so
// each character turns up many times. New people take their appearance from a bank of seeds worked
// out once (character, age class, the roles each one suits, height): never a seed somebody in the
// populated range already has, and a character nobody within NEAR_R metres of the spot has (the
// people of the group being placed included) or will come that near in the next MEET_T seconds
// walking as they do, keeping the age class and sex first drawn so the mix of the street stays as
// it is. Where a class has too few characters for that (three old men,
// say), a twin as far away as possible.
const BANK_N = 4096;          // seeds in the bank (a power of two: the scan steps through it with an odd stride)
const BANK_SCAN = 400;        // entries looked at per new person
const NEAR_R = 20;            // nobody with the same character within this distance (m)
const SAME_CLASS = 8;         // a twin this much nearer is still preferred to another age class or sex
const MEET_T = 12;            // ... nor one the new person will walk past within this many seconds (m/s along s)
const ROLES = ['adult', 'child', 'any', 'elderly', 'parent', 'grandparent', 'rider', 'young', 'waiter'];
const ROLE_I = Object.fromEntries(ROLES.map((r, i) => [r, i]));
const AGE_I = { child: 0, teen: 1, adult: 2, old: 3, toddler: 4 };
const SHOPPING_BAG = 3;       // appearance bag: carrier bags in hand (humans/mh/appearance.js BAG.SHOPPING)
// A shopping street: on top of the appearance's own share (about one in thirteen), a walker
// arriving on the street carries what they bought one time in sixteen, and two in five of those
// stepping out of a shop do (the photographs show about one passer-by in six with carrier bags).
const SHOP_WISH = 0.06;

export class Population {
  constructor(c) {
    this.c = c;
    this.agents = Array.from({ length: MAX_AGENTS }, (_, i) => new Agent(i));
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
    this.seatRetry = [];         // café seats dropped for the budget (far terraces), offered again later
    this.featureT = 0;
    this.nBins = Math.ceil((RANGE_AHEAD + RANGE_BEHIND) / BIN);
    this.binCount = new Float32Array(this.nBins);
    this.binTarget = new Float32Array(this.nBins);
    this.walkerTarget = 0;
    this.targetT = 0;
    this.frame = 0;
    this.stats = { spawned: 0, recycled: 0, vanished: 0, spawnFail: 0, farHidden: 0, farForced: 0, seatCap: 0, vanishSeen: 0, bySource: { far: 0, behind: 0, near: 0, side: 0, door: 0, alight: 0, init: 0 } };
    this.popOut = [0, 0, 0, 0];  // removals of figures in plain view, by distance
    this.mobCount = [0, 0, 0, 0]; // people with a stroller / riding / walking a bicycle (by MOB)
    this._paceK = 1;             // time of day: walking pace factor (a little slower in the evening)
    this.tod = { t: 0, evening: 0, late: 0 };
    this._sun = null; this._smp = {}; this._w = null; this._cafeS = null; this._benchS = null;
    // appearance bank and the spot a new person is being placed at (set by the spawners before alloc)
    this.hint = settleShape({ on: false, s: 0, d: 0, v: 0 });
    this.charD = new Float32Array(256);
    this._lastBank = -1; this._fit = -1; this._cls = -1;
    this.bank = this._buildBank();
    // placements with a spot: no twin within NEAR_R / another age class or sex taken / a twin kept
    this.cloneN = new Int32Array(3);
    // (classes fixed up front: see settleShape)
    settleShape(this.tod); settleShape(this.stats); settleShape(this.stats.bySource);
    this.stats.chatHidden = 0; this.stats.mob = 0;
    settleShape(this, new Set(['serial', 'frame', 'nBins', '_lastBank', '_fit', '_cls']));
  }

  // ---------------------------------------------------------------- slots
  /** role: 'adult' (default), 'child' or 'any'. opt.maxH caps the height, opt.noCross avoids the
   *  crossed-legs sitting variant, opt.shop asks for somebody carrying shopping bags (as far as the
   *  appearance bank has one to hand). */
  alloc(kind, src = 'walker', role = 'adult', opt = null) {
    if (!this.free.length) { this.hint.on = false; return null; }
    const a = this.agents[this.free.pop()];
    const c = this.c, r = c.rng;
    a.active = true; a.serial = ++this.serial; a.kind = kind;
    a.state = ST.WALK; a.task = TASK.NONE; a.step = 0;
    a.vs = 0; a.vd = 0; a.leader = null; a.followers.length = 0; a.nFollow = 0; a.slotF = 0; a.slotR = 0;
    a.wards.length = 0; a.guardian = null;
    a.charI = -1;
    a.appearance = this._appearance(role, opt);
    a.bankI = this._lastBank;
    if (a.bankI >= 0) this.bank.use[a.bankI]++;
    const H = c.humans;
    // (café staff are drawn in the waiter's outfit, by a character that can wear it: humans.js)
    const ap = H && H.appearanceOf ? H.appearanceOf(a.appearance, role === 'waiter' ? 1 : 0) : null;
    a.charI = ap && Number.isInteger(ap.index) ? ap.index : -1;
    a.idle = -1; a.idleW = -1; a.idleK = -1; a.idleT = 0; a.pauseK = 0;
    a.isChild = ap ? ap.base === 'child' : false;
    a.height = ap ? ap.height : 1.72;
    a.phase = r.next(); a.pose = 0; a.look = 0; a.lookGoal = 0; a.tramLookT = 0;
    a.clearing = false; a.noRect = false; a.inDoor = false; a.mouth = null; a.after = 0;
    a.feature = null; a.door = null; a.stuckT = 0; a.h = 0; a.timer = 0;
    a.thinkT = r.range(0.2, 1.5); a.simple = false; a.gTol = 0.3;
    // walking pace by age class (the stooped elderly slowest), a little slower with shopping or
    // eyes on a phone; the elderly cannot trot off the track, and start leaving it earlier
    const ageK = !ap ? 'adult' : ap.walkOld ? 'walkOld' : ap.age === 'old' || ap.age === 'teen' || ap.age === 'child' ? ap.age : 'adult';
    const W = WALK_BY[ageK] || WALK_BY.adult;
    a.ageK = ageK;
    a.v0 = Math.min(W[3], Math.max(W[2], r.normal(W[0], W[1]))) * (ap && ap.carry ? 0.95 : 1) * (ap && ap.phoneWalk ? 0.88 : 1) * this._paceK;
    a.ownV0 = a.v0;
    a.hurry = HURRY_BY[ageK] || HURRY;
    a.dir = 1; a.side = 1; a.lane = LANE.SIDE; a.laneF = 0.5; a.laneD = 0;
    a.dreamy = r.chance(0.08); a.bellT = 0; a.tramLookS = 0;
    a.clearT = a.dreamy ? r.range(CLEAR_T_DREAMY[0], CLEAR_T_DREAMY[1]) : r.range(CLEAR_T[0], CLEAR_T[1]);
    if (HURRY_BY[ageK]) a.clearT += 1.5;
    a.needsBell = a.dreamy || r.chance(0.1);
    a.pair = 0; a.pSide = 0; a.pClr = false; a.abT = 0; a.paceK = 1; a.paceKT = 0; a.role = ''; a.cafeT = null; a.path = null; a.pathI = 0; a.inSide = false; a.sideX = 0; a.pauseT = 0; a.pauseFace = 0; a.sideA = 0; a.sideEnd = 0; a.stuckN = 0;
    a.dodge = 0; a.dodgeT = 0; a.passT = -1e9;
    a.fresh = true; a.src = src; a.strideB = -1; a.lwOk = false; a.afs = 0; a.afd = 0; a.laneTT = 0;
    a.pValid = false; a.speedA = 0; a.moving = false; a.uturnT = 0; a.driftT = 0;
    a.baseF = 0; a.baseR = 0; a.singleT = 0; a.stuckF = 0; a.bandW = 9;
    a.wSeed = hash2(this.serial, 977) & 0xffff;
    a.wT = r.range(4, 10); a.paceT = r.range(5, 15); a.faceJ = r.range(-0.25, 0.25);
    a.spawnHidden = false; a.seatS = 0; a.seatD = 0; a.crossOK = 0; a.bornT = c.time; a.platformOK = false;
    a.mob = MOB.NONE; a.propSeed = 0; a.lean = 0; a.fpR = 0; a.extLo = 0; a.extHi = 0; a.extS = 0;
    a.bikeV = 0; a.yawW = 0; a.cT = 0; a.slowT = 0; a.stallT = 0; a.mountT = 0; a.mvOn = false; a.mvBand = false;
    a.mvToBand = false; a.mvLane = null; a.nearT = 0; a.headValid = false; a.clearHi = false; a.clearSpare = 0;
    a.rx = 0; a.rxT = 0; a.rxSetupT = 0; a.rxHold = 0; a.stopT = 0; a.stopNP = 0; a.stallTry = 0; a.stallSeen = false; a.narrowS = null;
    a.mobPrev = 0; a.mobT = -1e9; a.footW = 1; a.stepT = 0; a.dmNext = 0; a.waitX = 0; a.waitXT = 0; a.pinned = false;
    a.uI = -1; a.uSide = 0; a.uClr = false; a.uOver = false; a.ubellT = 0; a.lookU = -1;
    a.wValid = false; a.rhValid = false; a.fwTT = 0; a.lnN = 0; a.lnJ = 0; a.kapS = -1e9; a.km = 1; a.frontN = -1; a.wvx = 0; a.wvz = 0; a.moveDist = 0; a.h = 0; a.hT = 0;
    a.hwT = r.range(0, 0.25); a.hwV = 99; a.ovT = 0; a.ovD = 0; a.freeW = 9; a.platSt = null; a.platSide = 1; a.boardU = -1; a.stnS = null;
    this.stats.spawned++;
    return a;
  }

  /** Appearance seed for the role. Roles: 'adult' (default: teens, adults and the elderly),
   *  'child', 'any', 'elderly', 'parent' (an adult with free hands, to push a stroller),
   *  'grandparent', 'rider' (a teen or adult with free hands and no skirt or long coat, for a
   *  bicycle), 'young', 'waiter'. opt.maxH caps the height, opt.noCross avoids the crossed-legs
   *  sitting variant, opt.shop wishes for carrier bags in hand. From the bank (see BANK_N) with the spot in this.hint (consumed); this._lastBank
   *  is the bank entry taken (−1: none). */
  _appearance(role, opt) {
    const hint = this.hint, B = this.bank;
    const near = hint.on;
    hint.on = false;
    this._lastBank = -1;
    const ri = ROLE_I[role] ?? 0;
    if (!B || B.roleN[ri] < 8) return this._appearanceHash(role, opt);
    if (near) this._nearChars(hint.s, hint.d, hint.v);
    // (a wish for shopping bags is dropped rather than a twin or a seed in use taken for it)
    let best = this._scan(ri, opt, near, !!(opt && opt.shop));
    if (best < 0 && opt && opt.shop) best = this._scan(ri, opt, near, false);
    if (best < 0) best = this._fit;
    if (best < 0) return this._appearanceHash(role, opt);
    if (near) {
      const sc = this.charD[B.ch[best]];
      this.cloneN[sc < NEAR_R ? 2 : B.cls[best] === this._cls ? 0 : 1]++;
    }
    this._lastBank = best;
    return B.seed[best];
  }

  /** Bank entry for role index ri (−1: none free): the first free one that fits opt with no twin
   *  near (near: this.charD filled), else the best kept clear. this._fit is the first entry of the
   *  role at all, this._cls the age class and sex first drawn. */
  _scan(ri, opt, near, shop) {
    const B = this.bank, N = B.n, D = this.charD;
    const h0 = hash2(this.serial, this.c.seed * 7919 + 13);
    let k = h0 & (N - 1);
    const step = (((h0 >>> 12) & (N / 2 - 1)) << 1) | 1;
    let best = -1, bestSc = -1, cls = -1;
    this._fit = -1;
    for (let t = 0; t < BANK_SCAN; t++, k = (k + step) & (N - 1)) {
      if (((B.role[k] >> ri) & 1) === 0) continue;
      // (the role fits, the extra wishes or a free seed maybe not: kept should nothing else do)
      if (this._fit < 0) this._fit = k;
      if (opt && ((opt.maxH && B.h[k] > opt.maxH) || (opt.noCross && B.cross[k]))) continue;
      if (shop && B.bag[k] !== SHOPPING_BAG) continue;
      if (B.use[k]) continue;
      if (!near) { best = k; break; }
      if (cls < 0) cls = B.cls[k];
      const same = B.cls[k] === cls, sc = D[B.ch[k]];
      if (same && sc >= NEAR_R) { best = k; break; }
      const score = sc + (same ? SAME_CLASS : 0);
      if (score > bestSc) { bestSc = score; best = k; }
    }
    this._cls = cls;
    return best;
  }

  /** Spot of the next person to be placed (unwrapped s, d) and their walking speed along s
   *  (m/s, signed): their appearance keeps clear of the characters around it. */
  placeAt(s, d, v = 0) { const h = this.hint; h.on = true; h.s = s; h.d = d; h.v = v; }

  /** this.charD[character] = how near (m, up to NEAR_R) a person of that character is to (s, d),
   *  or comes within MEET_T seconds, walking at their speed along s while the new one walks at v. */
  _nearChars(s, d, v) {
    const D = this.charD, agents = this.agents;
    D.fill(NEAR_R);
    for (let i = 0, n = agents.length; i < n; i++) {
      const b = agents[i];
      if (!b.active || b.charI < 0 || b.charI >= D.length) continue;
      const ds0 = b.s - s, w = (b.state === ST.SEATED ? 0 : b.vs) - v;
      if (ds0 > NEAR_R + (w < 0 ? -w * MEET_T : 0) || ds0 < -NEAR_R - (w > 0 ? w * MEET_T : 0)) continue;
      // closest approach along s over the next MEET_T seconds
      let ds = ds0;
      if (w > 1e-3 || w < -1e-3) { let t = -ds0 / w; t = t < 0 ? 0 : t > MEET_T ? MEET_T : t; ds = ds0 + w * t; }
      const dd = b.d - d, r = Math.sqrt(ds * ds + dd * dd);
      if (r < D[b.charI]) D[b.charI] = r;
    }
  }

  /** Is somebody of character ch (other than `except`) within r metres of (s, d)? */
  charNear(ch, s, d, r, except = null) {
    if (ch < 0) return false;
    const agents = this.agents;
    for (let i = 0, n = agents.length; i < n; i++) {
      const b = agents[i];
      if (!b.active || b === except || b.charI !== ch) continue;
      const ds = b.s - s, dd = b.d - d;
      if (ds * ds + dd * dd < r * r) return true;
    }
    return false;
  }

  /** The bank of appearance seeds (null without the cast): per entry the seed, its character,
   *  age class and sex, the roles it suits (bit per ROLES entry), height, crossed-legs sitting, and
   *  how many people on the street have it now. */
  _buildBank() {
    const H = this.c.humans;
    if (!H || !H.appearanceOf || !H.cast) return null;
    const N = BANK_N;
    const B = { n: N, seed: new Uint32Array(N), ch: new Uint8Array(N), cls: new Uint8Array(N), role: new Uint16Array(N),
      h: new Float32Array(N), cross: new Uint8Array(N), bag: new Uint8Array(N), use: new Uint16Array(N), roleN: new Int32Array(ROLES.length), chars: 0 };
    const base = (this.c.seed * 7919 + 13) ^ 0x5bd1e995;
    let maxCh = 0;
    for (let k = 0; k < N; k++) {
      // (30-bit seeds: small integers to the engine, never boxed when handed around per frame)
      const seed = hash2(k + 1, base) & 0x3fffffff;
      const ap = H.appearanceOf(seed);
      if (!ap || !Number.isInteger(ap.index) || ap.index > 255) return null;
      B.seed[k] = seed; B.ch[k] = ap.index; maxCh = Math.max(maxCh, ap.index);
      B.cls[k] = (AGE_I[ap.age] ?? 2) * 2 + (ap.female ? 1 : 0);
      let m = 0;
      for (let r = 0; r < ROLES.length; r++) if (roleFits(ROLES[r], ap)) { m |= 1 << r; B.roleN[r]++; }
      B.role[k] = m; B.h[k] = ap.height; B.cross[k] = ap.sit === 1 ? 1 : 0; B.bag[k] = ap.bag | 0;
    }
    B.chars = maxCh + 1;
    return B;
  }

  /** Appearance seed without the bank: re-hashed until the body fits the role. */
  _appearanceHash(role, opt) {
    const H = this.c.humans;
    let seed = hash2(this.serial, this.c.seed * 7919 + 13) & 0x3fffffff;
    if (!H || !H.appearanceOf) return seed;
    let roleOk = -1;   // first seed of the right role, should nothing fit the extra wishes
    for (let k = 0; k < 64; k++) {
      const ap = H.appearanceOf(seed);
      if (roleFits(role, ap)) {
        if (!opt || ((!opt.maxH || ap.height <= opt.maxH) && (!opt.noCross || ap.sit !== 1))) return seed;
        if (roleOk < 0) roleOk = seed;
      }
      seed = hash2(seed, k + 101) & 0x3fffffff;
    }
    return roleOk >= 0 ? roleOk : seed;
  }

  /** Remove from the street (slot returns to the pool). reason 'recycle' counts removals in plain view. */
  kill(a, reason = '') {
    if (!a.active) return;
    if (reason === 'recycle') this._noteGone(a);
    a.active = false;
    if (a.bankI >= 0) { if (this.bank) this.bank.use[a.bankI]--; a.bankI = -1; }
    if (a.feature) {
      if (a.feature.type === 'seat' && a.feature.platform) { const L = a.feature.platform.sitters, i = L.indexOf(a); if (i >= 0) L.splice(i, 1); }
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
    for (const m of [...a.followers]) {
      // children go with their adult (the caller checked that they are out of sight too)
      if (m.isChild) { m.leader = null; this.kill(m); continue; }
      m.leader = null;
      m.task = a.task; m.step = a.step; m.mouth = a.mouth; m.door = a.door; m.inDoor = a.inDoor;
      m.doorS0 = a.doorS0; m.doorS1 = a.doorS1; m.slotX = a.slotX;
      m.state = ST.GOTO; m.gs = a.s + (m.s - a.s) * 0.3; m.gd = a.d; m.gTol = 0.35;
      m.side = a.side;
    }
    a.followers.length = 0; a.nFollow = 0;
    this.stats.vanished++;
    // statistics: leaving through a door or into a side street happens behind the building line
    const side = a.d >= 0 ? 1 : -1, c = this.c;
    if (a.inSide ? !c.side.hidden(a.s, a.d, 0) : c.vis.inView(a.s, a.d) && !c.map.mouthAt(a.s, side) && Math.abs(a.d) < c.map.facadeAt(a.s, side) - 0.2 && !this._occluded(a)) this.stats.vanishSeen++;
    this.kill(a);
  }

  /** Empty street (after a jump of the camera). */
  reset() {
    for (const a of this.agents) if (a.active) this.kill(a);
    this.cafes.clear();
    this.benches.clear();
    this.stations.clear();
    this.queue.length = 0;
    this.seatRetry.length = 0;
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
    for (let ii = 0, AG = this.agents, nn = AG.length; ii < nn; ii++) {
      const b = AG[ii];
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
    // thin behind and beside the cab (out of view); level from 30 m to 400 m, which the telephoto
    // view frames as a packed street (it must read at least as busy as the foreground), easing
    // off only at the far end of the populated range
    const rel = sU - c.camU;
    // (the free inspection camera looks any way: no thinning around it)
    const free = !!c.app.params.view;
    m *= rel < 0 ? (free ? 1.0 : 0.35) : rel < 30 ? (free ? 1.05 : 0.6 + 0.5 * (rel / 30)) : rel < 120 ? 1.1 : rel < 160 ? 1.1 - 0.1 * ((rel - 120) / 40)
      : rel < FAR_TAPER - 50 ? 1.0 : rel < FAR_TAPER ? 1.0 - 0.25 * ((rel - FAR_TAPER + 50) / 50) : 0.75;
    // a hot day: more people on the shaded sidewalk than on the sunlit one
    m *= this._shadeK(sU, side);
    return WALKER_DENSITY * m;
  }

  /** Sun and shade: with the sun up (day), the sidewalk whose buildings stand between it and the
   *  sun is shaded and draws people (×1.2), the sunlit one loses some (×0.85). */
  _shadeK(sU, side) {
    const sh = this._sun;
    if (!sh || sh.w <= 0) return 1;
    const smp = this.c.route.sample(this.c.route.wrap(sU), this._smp || (this._smp = {}));
    const r = smp.right, sr = (sh.x * r.x + sh.z * r.z) / sh.h;     // + : the sun is on the right
    const w = sh.w * Math.min(1, Math.abs(sr) * 1.5);
    return Math.sign(sr) === side ? 1 + 0.2 * w : 1 - 0.15 * w;
  }

  /** Sun direction for the shade preference (refreshed with the targets). */
  _sunNow() {
    const env = this.c.app.env || (this.c.app.systems && this.c.app.systems.env);
    const st = env && env.state, dir = st && st.sunDir;
    if (!dir || !(st.t < 0.45) || (st.night || 0) > 0.3 || dir.y < 0.2) { this._sun = null; return; }
    const h = Math.hypot(dir.x, dir.z);
    if (h < 0.05) { this._sun = null; return; }
    // fades out from tod 0.35 (low sun: long shadows over the whole street anyway)
    this._sun = { x: dir.x, z: dir.z, h, w: Math.min(1, Math.max(0, (0.45 - st.t) / 0.1)) };
  }

  /** Time of day for the crowd's mix: `evening` from t 0.55 to 0.65 (busier terraces, fewer
   *  errands in the shops), `late` from t 0.8 to 0.88 (fewer strollers and children, more young
   *  people in groups, a slower pace). */
  _todNow() {
    const env = this.c.app.env || (this.c.app.systems && this.c.app.systems.env);
    const t = env && env.state && Number.isFinite(env.state.t) ? env.state.t : 0;
    const sm = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
    this.tod.t = t; this.tod.evening = sm((t - 0.55) / 0.1); this.tod.late = sm((t - 0.8) / 0.08);
    this._paceK = 1 - 0.05 * this.tod.late;
  }

  _targets() {
    const c = this.c;
    this._sunNow();
    this._todNow();
    let tot = 0;
    for (let b = 0; b < this.nBins; b++) {
      const sU = c.camU - RANGE_BEHIND + (b + 0.5) * BIN;
      const t = (this.density(sU, 1) + this.density(sU, -1)) * BIN;
      this.binTarget[b] = t; tot += t;
    }
    const nonWalk = c.counts.seated + c.counts.passenger + (c.counts.side || 0);
    const cap = MAX_AGENTS - nonWalk - 6;
    this.walkerTarget = Math.min(tot, cap);
    const k = this.walkerTarget / Math.max(1, tot);
    for (let b = 0; b < this.nBins; b++) this.binTarget[b] *= k;
  }

  // ---------------------------------------------------------------- spawning walkers
  /** Places a fresh walker (and maybe its group). Returns the leader or null. */
  spawnWalker(sU, side, dir, opts = {}) {
    const c = this.c, r = c.rng;
    const mob = opts.mob || MOB.NONE;
    const role = mob === MOB.STROLLER ? (r.chance(0.12) ? 'grandparent' : 'parent') : mob ? 'rider' : 'adult';
    this.placeAt(sU, opts.d ?? side * (c.map.bandInAt(sU, side) + 1), opts.still ? 0 : dir * (mob === MOB.CYCLE ? 3.8 : 1.3));
    const a = this.alloc(opts.kind ?? KIND.WALKER, opts.src, role, opts.maxH || opts.shop ? { maxH: opts.maxH || 0, shop: !!opts.shop && !mob } : null);
    if (!a) return null;
    // hidden behind a figure: only someone shorter than it
    if (opts.maxH && a.height > opts.maxH) { this._unspawn(a); this.stats.spawnFail++; return null; }
    a.s = sU; a.side = side; a.dir = dir;
    a.d = side * (c.map.bandInAt(sU, side) + 1); // provisional (lane choice looks at where the agent is)
    if (mob) this._setMob(a, mob);
    setLane(c, a, r);
    if (mob === MOB.CYCLE) pickRideLane(c, a, r, opts.d !== undefined ? side : 0);
    if (opts.lane !== undefined && mob !== MOB.CYCLE) { a.lane = opts.lane; if (a.lane === LANE.SIDE) a.laneF = r.range(0.04, 0.96); }
    if (opts.laneD !== undefined && !mob) { a.lane = LANE.CORR; a.laneD = opts.laneD; }
    // (a corridor walker is placed from its own line: kept clear of a tram's track on its side)
    if (a.lane === LANE.CORR && opts.d === undefined) a.d = a.laneD;
    a.d = opts.d ?? (mob === MOB.CYCLE ? this._rideLineAt(a) : laneTarget(c, a));
    if (opts.d === undefined) a.d += r.range(-0.2, 0.2);
    a.alpha = dir > 0 ? 0 : PI;
    a.vs = dir * a.v0 * (opts.still ? 0 : 1);
    if (mob) { a.bikeV = mob === MOB.CYCLE && !opts.still ? a.v0 : 0; a.cT = a.d; updateFoot(a); }
    if (!opts.force && !this._placeOk(a)) { this._unspawn(a); this.stats.spawnFail++; return null; }
    this.mobCount[mob]++;
    // (late in the evening more people out in company)
    const groupP = opts.group === 0 ? 0 : mob === MOB.STROLLER ? 0.62 : mob ? 0 : (opts.group ?? 0.34 + 0.12 * this.tod.late);
    // (no group right beside another one on the same strip: two of them would walk on as one row)
    if (r.chance(groupP) && !this._groupNear(a)) { if (mob === MOB.STROLLER) this._makeStrollerGroup(a, opts); else this._makeGroup(a, opts); }
    return a;
  }

  /** Another group within 6 m along the street on the same strip (|Δd| < 2 m)? */
  _groupNear(a) {
    for (let ii = 0, AG = this.agents, nn = AG.length; ii < nn; ii++) {
      const b = AG[ii];
      if (!b.active || b === a || !b.followers.length || b.kind === KIND.SEATED) continue;
      if (Math.abs(b.s - a.s) < 6 && Math.abs(b.d - a.d) < 2) return true;
    }
    return false;
  }

  /** Give a fresh walker a stroller or a bicycle: pace, tram caution, model of the prop. */
  _setMob(a, mob) {
    const r = this.c.rng;
    a.mob = mob;
    a.propSeed = hash2(a.serial, 3301) & 0xffff;
    if (mob === MOB.STROLLER) a.v0 = r.range(STROLLER_V[0], STROLLER_V[1]);
    else if (mob === MOB.WALKBIKE) a.v0 = r.range(WALKBIKE_V[0], WALKBIKE_V[1]);
    else {
      a.v0 = r.range(CYCLE_V[0], CYCLE_V[1]);
      // riders keep an eye and an ear on the tram, and get off its track early
      a.dreamy = false; a.needsBell = false;
      a.clearT = r.range(CYCLE_CLEAR_T[0], CYCLE_CLEAR_T[1]);
    }
    if (mob !== MOB.CYCLE) { a.dreamy = a.dreamy && r.chance(0.3); a.needsBell = a.dreamy; }
    a.mountT = this.c.time + r.range(5, 20);
  }

  /** The riding line through where a cyclist is put. */
  _rideLineAt(a) {
    const c = this.c, map = c.map;
    if (a.lane === LANE.CORR) {
      // the tram near: the far side of the ride track
      if (rideNear(c, a) && a.laneD > RIDE_D - c.tram.passD - 0.6) return rideLine(RIDE_D - c.tram.passD - 0.7 - this.c.rng.range(0, 0.8), -9, RIDE_D - c.tram.passD - 0.6);
      return a.laneD;
    }
    const lo = map.bandInAt(a.s, a.side), hi = map.bandOutAt(a.s, a.side);
    return a.side * Math.min(lo + 0.32 + Math.max(0, hi - lo - 1.1) * a.laneF, Math.max(lo + 0.32, hi - 0.45));
  }

  /** A parent with a stroller: often a partner alongside, or a child holding on beside it. */
  _makeStrollerGroup(a, opts) {
    const c = this.c, r = c.rng;
    const sideA = r.chance(0.5) ? 1 : -1;                 // which side the partner walks on
    const partner = r.chance(0.45);
    const kids = partner ? (r.chance(0.3) ? 1 : 0) : 1;
    const slots = [];
    if (partner) slots.push({ role: r.chance(0.15) ? 'elderly' : 'any', F: r.range(-0.25, 0.05), R: sideA * r.range(0.68, 0.8) });
    for (let k = 0; k < kids; k++) {
      // beside the stroller with a hand on it, or beside the parent on the free side
      if (r.chance(0.5)) slots.push({ role: 'child', F: r.range(0.32, 0.55), R: -sideA * r.range(0.6, 0.68), maxH: 1.35 });
      else slots.push({ role: 'child', F: r.range(-0.12, 0.08), R: -sideA * r.range(0.44, 0.52) });
    }
    a.v0 = Math.max(0.9, a.v0 * (kids ? 0.94 : 1));
    // (a grandparent pushing walks at their own pace)
    if (a.ageK === 'old' || a.ageK === 'walkOld') a.v0 = Math.min(a.v0, WALK_BY[a.ageK][0] * this.c.rng.range(0.92, 1.02));
    for (const sl of slots) {
      if (this.free.length <= 4) break;
      this.placeAt(a.s, a.d, a.vs);
      const f = this.alloc(a.kind, opts.src, sl.role, sl.maxH ? { maxH: sl.maxH } : null);
      if (!f) break;
      if (sl.role === 'any' && f.isChild) { this._unspawn(f); continue; }
      f.baseF = sl.F; f.baseR = sl.R;
      const th = a.dir > 0 ? 0 : PI, cf = Math.cos(th), sf = Math.sin(th);
      f.s = a.s + cf * sl.F - sf * sl.R; f.d = a.d + sf * sl.F + cf * sl.R;
      f.side = a.side; f.dir = a.dir; f.lane = a.lane; f.laneF = a.laneF; f.laneD = a.laneD;
      f.v0 = a.v0 * r.range(1.0, 1.06); f.alpha = a.alpha; f.vs = a.vs;
      f.inDoor = a.inDoor;
      if (!opts.force && !this._placeOk(f)) { this._unspawn(f); continue; }
      f.leader = a; a.followers.push(f);
      f.state = a.state;
    }
    a.nFollow = a.followers.length;
    // the group walks at its slowest adult's pace
    for (const f of a.followers) if (!f.isChild && f.ownV0 < a.v0) a.v0 = Math.max(0.85, f.ownV0);
    for (const f of a.followers) f.v0 = a.v0 * r.range(1.0, 1.06);
  }

  /** Companions for leader a: couples side by side, threes in a loose V / U, fours in pairs,
   *  sometimes a family with children holding on beside an adult. */
  _makeGroup(a, opts) {
    const c = this.c, r = c.rng;
    // (late in the evening: bigger groups of young people, half as many children)
    const late = this.tod.late;
    const n = r.weighted([[1, 0.62 - 0.17 * late], [2, 0.28 + 0.07 * late], [3, 0.1 + 0.1 * late]]);
    const kids = r.chance(0.2 * (1 - 0.5 * late)) ? (n >= 2 && r.chance(0.4) ? 2 : 1) : 0;
    const young = late > 0.5 && !kids && r.chance(0.6 * late);
    // (each group its own pace: two groups never settle into the same speed side by side)
    const gk = (kids ? 0.82 : 0.9) * r.range(0.94, 1.06);
    a.v0 = Math.max(0.85, a.v0 * gk);
    const R1 = r.range(0.56, 0.72) * (r.chance(0.5) ? 1 : -1);
    let slots;
    if (n === 1) slots = [[r.range(-0.15, 0.15), R1]];
    else if (n === 2) {
      // threes: mostly two abreast with the third a step behind, or a V with one ahead; now and
      // then all three abreast (a staggered group reads as a group, a rank as a parade)
      const f = r.weighted([[0, 0.55], [1, 0.33], [2, 0.12]]);
      if (f === 0) slots = [[r.range(-0.12, 0.12), R1], [-r.range(1.1, 1.45), R1 * 0.5 + r.range(-0.1, 0.1)]];
      else if (f === 1) { const V = -r.range(1.0, 1.3); slots = [[V, R1], [V + r.range(-0.1, 0.1), -R1 * r.range(0.9, 1.1)]]; }
      else { const V = (r.chance(0.7) ? 1 : -1) * r.range(0.3, 0.5); slots = [[V + r.range(-0.08, 0.08), R1], [V + r.range(-0.08, 0.08), -R1 * r.range(0.9, 1.1)]]; }
    } else slots = [[r.range(-0.12, 0.12), R1], [-r.range(1.1, 1.4), -R1 * 0.5 + r.range(-0.1, 0.1)], [-r.range(1.1, 1.4), R1 * 0.5 + r.range(-0.1, 0.1)]];
    // children take the slots right beside the leader (hand-holding distance)
    const kidR = [-Math.sign(R1) * r.range(0.38, 0.46), Math.sign(R1) * r.range(0.38, 0.46)];
    for (let k = 0; k < n && this.free.length > 4; k++) {
      const child = k >= n - kids;
      this.placeAt(a.s, a.d, a.vs);
      const f = this.alloc(a.kind, opts.src, child ? 'child' : young ? 'young' : 'any');
      if (!f) break;
      let [F, R] = slots[k];
      if (child) { F = r.range(-0.05, 0.12); R = kidR[(n - 1 - k) % 2]; }
      // (adults a little ahead or behind: a loose group, never a rank)
      else F += r.range(-0.2, 0.2);
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
    // the group walks at its slowest adult's pace
    for (const f of a.followers) if (!f.isChild && f.ownV0 * gk < a.v0) a.v0 = Math.max(0.85, f.ownV0 * gk);
    for (const f of a.followers) f.v0 = a.v0 * r.range(1.0, 1.06);
  }

  /** Undo an alloc that found no room (not counted as a spawn). */
  _unspawn(a) { this.kill(a); this.stats.spawned--; }

  /** Spot is acceptable: no obstacle overlap, not in a café / platform, outside the tram's band. */
  _placeOk(a) {
    const c = this.c, map = c.map;
    const ad = Math.abs(a.d), side = Math.sign(a.d) || a.side;
    const ahead = a.s - c.tram.trainU;
    const inBand = a.mob ? footBandGap(a) < 0.1 + (a.mob === MOB.CYCLE ? 0.6 : 0) : Math.abs(a.d - RIDE_D) < BAND + 0.1;
    if (inBand && ahead > -TRAM_LEN - 4 - a.extS && ahead < c.tram.clearAhead + 30 + (a.mob === MOB.CYCLE ? 80 : 0)) return false;
    // nor in an oncoming unit's band anywhere near it (ahead of it or beside it)
    for (const T of c.tram.units) {
      const ah = T.sU - a.s;
      if (ah > -(T.len + 6) - a.extS && ah < c.tram.uFront(T, a) + 12 + (a.mob === MOB.CYCLE ? 60 : 0) && c.tram.uGap(a, T) < 0.15) return false;
    }
    // no corridor spawns inside a stop (the platforms are the sidewalk there), and no riders
    // next to each other on one line
    if (ad < TRACK_ZONE_HALF && map.stationAt(a.s)) return false;
    if (a.mob === MOB.CYCLE) {
      for (let ii = 0, AG = this.agents, nn = AG.length; ii < nn; ii++) {
        const b = AG[ii];
        if (b.active && b !== a && b.mob === MOB.CYCLE && Math.abs(b.s - a.s) < 4 && Math.abs(b.d - a.d) < 0.9) return false;
      }
    }
    if (!a.noRect && map.rectInner(a.s, side, ad, AGENT_R * 0.5)) return false;
    if (!a.inDoor && ad > map.reachAt(a.s, side, (x) => c.unwrap(x))) return false;
    map.gatherAt(a, 2);
    for (let k = 0; k < map.qN; k++) {
      const i = map.qI[k], ds = map.qDS[k], dd = map.cD[i] - a.d;
      if (ds * ds + dd * dd < (map.cR[i] + AGENT_R + 0.1) ** 2) return false;
      if (a.mob && a.fpR > 0 && propPointDist2(a, ds, dd) < (map.cR[i] + a.fpR + 0.1) ** 2) return false;
    }
    if (a.mob && a.fpR > 0) {
      for (let e = 0; e < 2; e++) {
        const ps = a.s + (e ? a.fp1s : a.fp0s), pd = a.d + (e ? a.fp1d : a.fp0d), ps2 = Math.sign(pd) || side;
        if (map.rectInner(ps, ps2, Math.abs(pd), a.fpR * 0.6)) return false;
        if (Math.abs(pd) > map.wallAt(ps, ps2) - a.fpR && !map.mouthAt(ps, ps2)) return false;
      }
    }
    // not on top of someone else's stroller / bicycle (nor with one's own on top of someone; a
    // rider with room to spare)
    return !this.propClash(a, a.mob === MOB.CYCLE ? 0.3 : 0.05);
  }

  /** Does a's footprint overlap a stroller / bicycle footprint, or a's own prop overlap anyone
   *  (group members included: nobody is placed inside a stroller)? */
  propClash(a, margin = 0.05) {
    const k = this.c.route.offsetScale(a.s, a.d);
    for (let ii = 0, AG = this.agents, nn = AG.length; ii < nn; ii++) {
      const b = AG[ii];
      if (!b.active || b === a || !(a.mob || b.mob)) continue;
      const ds = (b.s - a.s) * k, dd = b.d - a.d;
      if (ds * ds + dd * dd < 9 && footGap(a, b, ds, dd).gap < margin) return true;
    }
    return false;
  }

  /** Initial street: walkers over the whole range, chat groups, then the features. */
  fillInitial() {
    const c = this.c, r = c.rng;
    this.mobCount.fill(0);
    this._count();
    this._todNow();
    this.scanFeatures();
    // (the seating budget goes to the terraces nearest the camera first)
    const relQ = (q) => (q.type === 'seat' ? Math.abs(q.seat.s - c.camU) : 0);
    this.queue.sort((p, q) => relQ(p) - relQ(q));
    this._fillQueue(1e9);
    this._count();
    this._targets();
    // bins in a shuffled order, and a plain per-walker draw of the stroller / bicycle roles (no
    // deficit term: the first bins filled would otherwise take every role)
    const order = Array.from({ length: this.nBins }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = r.int(0, i); const t = order[i]; order[i] = order[j]; order[j] = t; }
    for (const b of order) {
      const s0 = c.camU - RANGE_BEHIND + b * BIN;
      let want = Math.round(this.binTarget[b] * r.range(0.85, 1.1));
      let guard = 0;
      while (want > 0 && guard++ < 40 && this.free.length > 8) {
        const side = r.chance(0.5) ? 1 : -1;
        const sU = s0 + r.next() * BIN;
        // some of them are standing talking
        if (r.chance(0.085) && c.counts.stand < STANDER_TARGET * 1.3 && sU - c.camU < RANGE_AHEAD - 60) {
          const n = this.spawnChat(sU, side);
          if (n) { want -= n; c.counts.stand += n; continue; }
        }
        const a = this.spawnWalker(sU, side, r.chance(0.5) ? 1 : -1, { mob: this._drawMob(r), shop: r.chance(SHOP_WISH) });
        if (a) { want -= 1 + a.nFollow; this.stats.bySource.init += 1 + a.nFollow; }
      }
    }
    // the side streets near the camera with their own people
    c.side.fill();
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
      this.placeAt(sU, cd);
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
  /** The per-frame pass over the agents: recycling, head counts by kind (c.counts) and walkers
   *  per bin. Returns the walkers on the main street. (A method of its own: the loop is compiled
   *  on its own, and the rest of maintain never runs in code compiled in the middle of it.) */
  _census() {
    const c = this.c;
    const lo = c.camU - RANGE_BEHIND;
    const k = c.counts;
    k.seated = 0; k.passenger = 0; k.stand = 0; k.walker = 0; k.stand300 = 0; k.walk300 = 0; k.side = 0; k.standFar = 0;
    this.binCount.fill(0);
    this.mobCount.fill(0);
    let walkers = 0;
    const agents = this.agents;
    for (let i = 0, n = agents.length; i < n; i++) {
      const a = agents[i];
      if (!a.active) continue;
      const rel = a.s - c.camU;
      this.mobCount[a.mob]++;
      if (a.s < lo) { this.stats.recycled++; this.kill(a, 'recycle'); continue; }
      // (far up a side street and out of sight: gone; very far: gone regardless)
      if (a.inSide && a.sideX > 64 && !a.leader && ((this.frame + a.slot) % 15 === 0 && c.side.groupHidden(a) || a.sideX > 90)) {
        this.stats.recycled++; c.side.stats.gone++; this.kill(a); continue;
      }
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
        if (rel > -5 && rel < 300) { k.walk300++; if (a.state === ST.STAND && !a.inSide) k.stand300++; }
        else if (rel >= 300 && a.state === ST.STAND && !a.inSide) k.standFar++;
        // (people out in the side streets are counted apart: the main street's density stays as it is)
        if (a.inSide) { k.side++; walkers--; continue; }
        const b = Math.floor((a.s - lo) / BIN);
        if (b >= 0 && b < this.nBins) this.binCount[b]++;
      }
    }
    return walkers;
  }

  maintain(dt) {
    const c = this.c;
    this.frame++;
    this.featureT -= dt;
    if (this.featureT <= 0) { this.featureT = 0.3; this.scanFeatures(); this._retrySeats(); }
    this._fillQueue(3);
    this._stationEvents();
    if ((this.frame % 90) === 11) this._platformArrivals();
    if ((this.frame % 45) === 23) staffTick(c);
    // one pass: recycling, head counts by kind and walkers per bin
    let walkers = this._census();
    const k = c.counts;
    // spawn towards the target (targets follow the camera slowly: refresh twice a second)
    this.targetT -= dt;
    if (this.targetT <= 0) { this.targetT = 0.5; this._targets(); }
    let budget = 2, tries = 3;
    while (walkers < this.walkerTarget - 1 && budget > 0 && tries-- > 0 && this.free.length > 6) {
      const n = this._spawnOne();
      if (n) { walkers += n; budget--; }
    }
    // people standing about (talking, waiting, on the phone): a pair stepping out from behind
    // somebody far down the street now and then when there are too few
    // (counting those standing further down the street too: they come within 300 m soon)
    if (k.stand300 + 0.6 * k.standFar < STAND_NEAR * 1.25 && k.stand300 < STAND_NEAR && (this.frame % 20) === 7 && this.free.length > 12) this._spawnChatHidden();
    c.side.maintain(dt);
  }

  /** Two or three people standing and talking, far down the street, placed along the line of
   *  sight behind a kiosk / advertising column or a taller figure (so the group appears from
   *  behind it). Returns how many were placed. */
  _spawnChatHidden() {
    const c = this.c, r = c.rng, vis = c.vis, map = c.map;
    const sU = c.camU + r.range(300, 520), side = r.chance(0.5) ? 1 : -1;
    let os, od, w, maxH = 0;
    let occ = null, n = 0;
    for (let ii = 0, AG = this.agents, nn = AG.length; ii < nn; ii++) {
      const b = AG[ii];
      if (!b.active || b.kind === KIND.SEATED || b.isChild || b.height < 1.7 || b.inDoor || b.inSide) continue;
      if (Math.abs(b.s - sU) > 25 || (b.d >= 0 ? 1 : -1) !== side) continue;
      if (Math.abs(b.d) < map.bandInAt(b.s, side) - 0.3) continue;      // (on the sidewalk proper)
      if (r.next() * ++n < 1) occ = b;
    }
    if (occ) { os = occ.s; od = occ.d; w = 0.42; maxH = occ.height - 0.05; }
    else {
      for (const o of this.occluders) {
        const so = c.unwrap(o.s);
        if (Math.abs(so - sU) > 40 || (o.d >= 0 ? 1 : -1) !== side) continue;
        if (r.next() * ++n < 1) { os = so; od = o.d; w = o.w; }
      }
      if (os === undefined) return 0;
    }
    // the pair (or three) stand along the ray behind it, facing each other across it
    const k = r.weighted([[2, 0.7], [3, 0.3]]);
    const b0 = occ ? r.range(2.2, 3.2) : w / 2 + r.range(0.6, 1.2);
    const placed = [];
    for (let i = 0; i < k; i++) {
      const behind = b0 + i * r.range(0.75, 0.95);
      const s = os + behind, d = vis.rayBehind(os, od, behind);
      if (Math.abs(d) < map.bandInAt(s, side) + 0.3 || Math.abs(d) > map.wallAt(s, side) - 0.4) break;
      if (vis.rayOffset(s, d, os, od) > Math.max(0.04, w / 2 - 0.3)) break;
      this.placeAt(s, d);
      const a = this.alloc(KIND.STANDER, 'chat', 'adult', maxH ? { maxH } : null);
      if (!a) break;
      if (maxH && a.height > maxH) { this._unspawn(a); break; }
      a.s = s; a.d = d; a.side = side; a.dir = r.chance(0.5) ? 1 : -1; a.lane = LANE.SIDE; a.laneF = r.next();
      if (!this._placeOk(a)) { this._unspawn(a); break; }
      placed.push(a);
    }
    if (placed.length < 2) { for (const a of placed) this._unspawn(a); return 0; }
    // a loose ring around their middle
    let cs = 0, cd = 0;
    for (const a of placed) { cs += a.s; cd += a.d; }
    cs /= placed.length; cd /= placed.length;
    const dur = r.range(20, 80), L = placed[0];
    for (const a of placed) {
      a.task = TASK.CHAT; a.state = ST.STAND; a.timer = dur; a.chatS = a.s; a.chatD = a.d;
      a.faceA = Math.atan2(cd - a.d, cs - a.s) + r.range(-0.2, 0.2); a.alpha = a.faceA; a.vs = 0;
      a.spawnHidden = true;
      if (a !== L) {
        a.leader = L; L.followers.push(a); a.dir = L.dir;
        const k2 = L.followers.length;
        a.baseF = k2 === 1 ? r.range(-0.15, 0.15) : -r.range(0.8, 1.0);
        a.baseR = (k2 % 2 ? 1 : -1) * r.range(0.55, 0.7);
      }
    }
    L.nFollow = L.followers.length;
    this.stats.chatHidden = (this.stats.chatHidden || 0) + 1;
    return placed.length;
  }

  /** Head counts (outside the per-frame pass: start-up). */
  _count() {
    const k = this.c.counts;
    k.seated = 0; k.passenger = 0; k.stand = 0; k.walker = 0;
    for (let ii = 0, AG = this.agents, nn = AG.length; ii < nn; ii++) {
      const a = AG[ii];
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
    // a stroller or a bicycle, to keep their shares (only where the whole figure can arrive unseen;
    // beside the cab only while it stands: riding, those would only ever be seen leaving)
    const mob = sRel > 100 || c.tram.v < 1 ? this._pickMob(r) : MOB.NONE;
    if (mob) {
      if (sRel < 45) {
        a = this.spawnWalker(sU, side, r.chance(0.5) ? 1 : -1, { mob, src: 'near' });
        if (a && !this._groupHidden(a)) { this._killGroup(a); a = null; }
        else if (a) a.spawnHidden = true;
        src = 'near';
      } else {
        // far down the street right behind somebody, else out of a side street anywhere in range
        if (sRel > 300) { a = this._spawnBehind(sU, side, mob); src = 'behind'; }
        if (!a) { a = this._spawnMobSide(mob); src = 'side'; }
      }
      if (a) { this.stats.bySource[src] += 1 + a.nFollow; this.stats.mob = (this.stats.mob || 0) + 1; return 1 + a.nFollow; }
    }
    if (sRel > RANGE_AHEAD - FAR_SPAWN_BAND) {
      // far down the street: out of a doorway or side street, else right behind somebody
      a = this._spawnFromDoor(sU, side); src = 'door';
      if (!a) { a = this._spawnFromSideStreet(sU, side); src = 'side'; }
      if (!a) { a = this._spawnBehind(sU, side); src = 'behind'; }
    } else if (sRel < 45) {
      a = this.spawnWalker(sU, side, r.chance(0.5) ? 1 : -1, { shop: r.chance(SHOP_WISH) });
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
    // the far end of a stroller / bicycle too
    if (a.mob && a.fpR > 0 && (!vis.hidden(a.s + a.fp0s, a.d + a.fp0d) || !vis.hidden(a.s + a.fp1s, a.d + a.fp1d))) return false;
    for (const f of a.followers) if (!vis.hidden(f.s, f.d)) return false;
    return true;
  }

  /** Stroller / bicycle role for the next arrival, by how far each share is below its target
   *  (at most twice the share itself, so the props never bunch where the street refills). */
  _pickMob(r) {
    const c = this.c;
    if (!c.mobOn) return MOB.NONE;
    const W = Math.max(60, this.walkerTarget);
    for (const [m, share0] of MOB_LIST) {
      if (!c.mobOK(m)) continue;
      // (fewer strollers out late in the evening)
      const share = m === MOB.STROLLER ? share0 * (1 - 0.7 * this.tod.late) : share0;
      const want = share * W * c.mobX, def = want - this.mobCount[m];
      if (def <= 0.5) continue;
      if (r.chance(Math.min(0.6, Math.min(1, def / want) * 2 * share * c.mobX))) return m;
    }
    return MOB.NONE;
  }

  /** Plain draw of the role of one walker at its share (the first fill of the street). */
  _drawMob(r) {
    const c = this.c;
    if (!c.mobOn) return MOB.NONE;
    for (const [m, share] of MOB_LIST) if (c.mobOK(m) && r.chance(Math.min(0.5, share * c.mobX * (m === MOB.STROLLER ? 1 - 0.7 * this.tod.late : 1)))) return m;
    return MOB.NONE;
  }

  /** Out of any side street in the populated range whose inside the camera cannot see. */
  _spawnMobSide(mob) {
    const c = this.c, r = c.rng, L = c.layout.crossStreets;
    const n = L.length, k0 = r.int(0, n - 1);
    for (let k = 0; k < n; k++) {
      const m = L[(k0 + k) % n];
      const rel = c.unwrap(m.s) - c.camU;
      if (rel < 50 || rel > RANGE_AHEAD - 10) continue;
      const sides = m.side === 0 ? (r.chance(0.5) ? [1, -1] : [-1, 1]) : [m.side];
      for (const side of sides) {
        const a = this._spawnFromSideStreet(c.unwrap(m.s), side, mob);
        if (a) return a;
      }
    }
    return null;
  }

  _killGroup(a) {
    for (const f of [...a.followers]) this._unspawn(f);
    this._unspawn(a);
  }

  _spawnFromSideStreet(sU, side, mob = MOB.NONE) {
    const c = this.c, r = c.rng, map = c.map;
    for (let k = -2; k <= 2; k++) {
      const m = map.mouthAt(sU + k * 6, side);
      if (!m) continue;
      const ms = c.unwrap(m.s), line = map.mouthLine(m, side);
      let x = r.range(-1, 1) * (m.width / 2 - (mob ? 2.0 : 1.4));
      const depth = r.range(5, 10) + (mob ? 2.5 : 0);
      // a stroller / walked bicycle comes out straight through a gap in the bollards across the
      // mouth, if there is one wide enough
      if (mob === MOB.STROLLER || mob === MOB.WALKBIKE) {
        const gx = this._mouthGap(ms, m, side, line, x, mob);
        if (gx === null) return null;
        x = gx;
      }
      const sp = ms + x, dp = side * (line + depth);
      if (!c.side.hidden(sp, dp, 0.6)) return null;
      // a stroller / bicycle points out of the side street: its front must be hidden too
      if (mob && !c.side.hidden(sp, dp - side * 1.3, 0.6)) return null;
      const a = this.spawnWalker(sp, side, r.chance(0.5) ? 1 : -1, { d: dp, lane: LANE.SIDE, force: true, group: 0.3, src: 'side', mob, shop: r.chance(SHOP_WISH) });
      if (!a) return null;
      for (const f of [...a.followers]) {
        f.d = dp + side * r.range(0.4, 1.2); f.s = sp + r.range(-0.5, 0.5);
        if (!c.side.hidden(f.s, f.d, 0.6)) this._unspawn(f);
      }
      a.nFollow = a.followers.length;
      a.mouth = m; a.task = TASK.EMERGE; a.state = ST.GOTO;
      a.gs = mob ? sp : sp + r.range(-1, 1); a.gd = side * (line - 1.0); a.gTol = 0.6;
      a.alpha = side > 0 ? -PI / 2 : PI / 2;
      a.vs = 0; a.spawnHidden = true;
      if (mob === MOB.CYCLE) {
        // rides out of the side street and turns onto the main street (a way clear of the bollards)
        a.gs = sp + r.range(-0.5, 0.5); a.gd = side * (line - 1.6); a.gTol = 1.2;
        a.bikeV = r.range(2.0, 2.8); a.cT = a.d;
        if (!wayClear(c, sp, dp, a.gs, a.gd, 0.3) || !wayClear(c, a.gs, a.gd, a.gs + a.dir * 4, a.gd - side * 2.5, 0.3)) { this._killGroup(a); return null; }
      }
      if (mob) updateFoot(a);
      // nobody placed on a stroller / bicycle, nor one placed on somebody
      if (this.propClash(a)) { this._killGroup(a); return null; }
      for (const f of [...a.followers]) if (this.propClash(f)) this._unspawn(f);
      a.nFollow = a.followers.length;
      return a;
    }
    return null;
  }

  /** Offset along the mouth (from its centre ms) at which a person with a stroller / walked
   *  bicycle walks straight out through the bollards across it: the middle of the gap nearest
   *  to x that the person and the prop fit through (x itself if there are no bollards), or null. */
  _mouthGap(ms, m, side, line, x, mob, out = true) {
    const map = this.c.map, half = m.width / 2;
    const n = map.gatherCircles(ms, half + 1);
    const xs = [];
    for (let q = 0; q < n; q++) {
      const i = map.qI[q], ad = map.cD[i] * side;
      if (ad > line - 2.5 && ad < line + 3) xs.push([map.qDS[q] - map.cR[i], map.qDS[q] + map.cR[i]]);
    }
    if (!xs.length) return x;
    xs.sort((p, q) => p[0] - q[0]);
    // walking out (towards −d·side) the walked bicycle is on the person's right: +s on the right
    // side of the street, −s on the left; the pair is centred that far from the person
    // (walking in, the other way round)
    const off = mob === MOB.WALKBIKE ? (out ? 1 : -1) * side * (FOOT[MOB.WALKBIKE].l + FOOT[MOB.WALKBIKE].r - AGENT_R) / 2 : 0;
    const need = mob === MOB.WALKBIKE ? FOOT[MOB.WALKBIKE].l + FOOT[MOB.WALKBIKE].r + AGENT_R + 0.2 : 2 * FOOT[MOB.STROLLER].r + 0.2;
    let best = null, bd = 1e9, lo = -half + 0.6;
    for (let j = 0; j <= xs.length; j++) {
      const hi = j < xs.length ? xs[j][0] : half - 0.6;
      if (hi - lo >= need) {
        const cx = (lo + hi) / 2 - off;
        if (Math.abs(cx - x) < bd) { bd = Math.abs(cx - x); best = cx; }
      }
      if (j < xs.length) lo = Math.max(lo, xs[j][1]);
    }
    return best;
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
      // (out of a shop: often with what they bought)
      const a = this.spawnWalker(s, side, r.chance(0.5) ? 1 : -1, { d: dIn, lane: LANE.SIDE, force: true, group: 0, src: 'door', shop: o.kind === 'shop' && r.chance(0.4) });
      if (!a) return null;
      if (this.propClash(a)) { this._unspawn(a); return null; }
      a.inDoor = true; a.door = dr; a.doorS0 = dr.s0; a.doorS1 = dr.s1;
      a.task = TASK.EMERGE; a.state = ST.GOTO;
      a.gs = dr.s + a.dir * r.range(0.3, 1.2); a.gd = side * (map.wallMin(dr.s, side, 2) - r.range(0.6, 1.2)); a.gTol = 0.4;
      a.alpha = side > 0 ? -PI / 2 : PI / 2; a.vs = 0; a.spawnHidden = true;
      return a;
    }
    return null;
  }

  /** Far down the street: a figure that steps out from behind another (taller) figure or a kiosk
   *  on the same line of sight, a few metres further away. */
  _spawnBehind(sU, side, mob = MOB.NONE) {
    const c = this.c, r = c.rng, vis = c.vis, map = c.map;
    // a random occluder near sU on this side (reservoir pick over people, then street furniture)
    let occ = null, n = 0;
    for (let ii = 0, AG = this.agents, nn = AG.length; ii < nn; ii++) {
      const b = AG[ii];
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
    // a bicycle / stroller only on a clear line: the corridor or the sidewalk, not among the poles and trees
    if (mob && Math.abs(d) > TRACK_ZONE_HALF - 0.45 && Math.abs(d) < map.bandInAt(s, side) + (mob === MOB.CYCLE ? 0.5 : 0.35)) return null;
    // (a stroller / walked bicycle in the corridor only on its far half)
    if (mob && mob !== MOB.CYCLE && Math.abs(d) < TRACK_ZONE_HALF && d > -0.9) return null;
    if (vis.rayOffset(s, d, os, od) > Math.max(0.03, w / 2 - 0.26)) return null;
    const a = this.spawnWalker(s, side, dir, { d, force: false, group: 0, src: 'behind', maxH: maxH || undefined, laneD: Math.abs(d) < TRACK_ZONE_HALF ? d : undefined, mob, shop: r.chance(SHOP_WISH) });
    if (!a) return null;
    if (mob) {
      // the stroller / bicycle lies along the line of sight: hidden as long as it is no wider
      // (than the figure in front, or the kiosk / advertising column)
      const lim = occ ? 0.12 : Math.max(0.12, w / 2 - 0.3 - a.fpR);
      if (vis.rayOffset(a.s + a.fp0s, a.d + a.fp0d, os, od) > lim || vis.rayOffset(a.s + a.fp1s, a.d + a.fp1d, os, od) > lim) { this._killGroup(a); return null; }
      if (mob === MOB.CYCLE) {
        // ride on along a line through the spot
        if (Math.abs(d) < TRACK_ZONE_HALF) { a.lane = LANE.CORR; a.laneD = rideLine(d); }
        else { a.lane = LANE.SIDE; a.side = side; a.laneF = 0.3; }
      } else if (Math.abs(d) < TRACK_ZONE_HALF) { a.lane = LANE.CORR; a.laneD = d; }
      a.spawnHidden = true;
      return a;
    }
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
    // (wrapped s of every café middle and bench, once: the scan runs three times a second over
    // the whole loop, and works out the distances in place)
    if (!this._cafeS) {
      this._cafeS = Float64Array.from(L.cafes, (cf) => c.route.wrap((cf.s0 + cf.s1) / 2));
      this._benchS = Float64Array.from(this.benchList, (b) => c.route.wrap(b.s));
    }
    const RL = c.route.length, cw = c.camW;
    for (let i = 0; i < L.cafes.length; i++) {
      const cafe = L.cafes[i];
      let rel = this._cafeS[i] - cw;
      if (rel > RL / 2) rel -= RL; else if (rel < -RL / 2) rel += RL;
      const inRange = rel > lo && rel < hi;
      if (inRange === this.cafes.has(cafe.id)) continue;
      if (inRange) this._populateCafe(cafe);
      else if (rel < lo - 20 || rel > hi + 30) this.cafes.delete(cafe.id);
    }
    for (let i = 0; i < this.benchList.length; i++) {
      const b = this.benchList[i];
      let rel = this._benchS[i] - cw;
      if (rel > RL / 2) rel -= RL; else if (rel < -RL / 2) rel += RL;
      const inRange = rel > lo && rel < hi;
      if (inRange === this.benches.has(b.id)) continue;
      if (inRange) this._populateBench(b);
      else if (rel < lo - 20 || rel > hi + 30) this.benches.delete(b.id);
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
        // (the terraces near the camera come first: far ones leave a reserve for them)
        const far = !q.bench && q.seat.s - c.camU > 300;
        if (c.counts.seated >= (q.bench ? MAX_SEATED : MAX_SEATED - BENCH_RESERVE - (far ? 14 : 0))) {
          this.stats.seatCap++;
          if (far && q.seat.cafe && this.seatRetry.length < 200) this.seatRetry.push(q);
          continue;
        }
        if (q.seat.feat.occ.has(q.seat.key)) continue;
        let guardian = null;
        if (q.role === 'child') {
          guardian = q.seat.feat.adults && q.seat.feat.adults[q.table];
          if (!guardian || !guardian.active || guardian.state !== ST.SEATED) continue;
        }
        const a = this._seat(q.seat, c.rng, q.role, guardian);
        if (a && q.role === 'adult' && q.table !== undefined) q.seat.feat.adults[q.table] = a;
      } else if (q.type === 'passenger') this._placePassenger(q.feat, q.r, q.first);
    }
  }

  _populateCafe(cafe) {
    const c = this.c;
    const r = c.featureRng('cafe', cafe.id);
    const feat = { type: 'cafe', cafe, occ: new Set(), seats: [], adults: [], staff: null, staffT: 0 };
    this.cafes.set(cafe.id, feat);
    // patrons sit where the tables are set: a table in use (cups, plates: dressed 2) nearly
    // always has its people at it, one per place set (now and then a companion with no order
    // yet), a laid table (dressed 1) only now and then somebody who has just sat down, a bare
    // one never. In the evening the terraces are busier.
    const ev = this.tod.evening, kidK = 1 - 0.5 * this.tod.late;
    cafe.tables.forEach((t, ti) => {
      const dressed = t.dressed ?? 1;
      const seats = t.chairs.map((ch, ci) => {
        const key = ti * 8 + ci;
        const s = c.unwrap(ch.s), ts = c.unwrap(t.s);
        const seat = { type: 'seat', cafe, feat, key, s, d: ch.d, side: cafe.side, faceA: Math.atan2(t.d - ch.d, ts - s), exitD: cafe.side * (cafe._crowdInner - 0.5), dressed, table: ti };
        feat.seats.push(seat);
        return seat;
      });
      if (!dressed || !seats.length) return;
      let n = 0;
      if (dressed === 2) {
        if (!r.chance(0.95)) return;
        // (the places set: from the furniture when it says, else about two in three chairs, at least one)
        const places = Array.isArray(t.places) ? t.places.length : Math.max(1, Math.round(seats.length * r.range(0.7, 1.0)));
        n = places + (r.chance(0.4 + 0.25 * ev) ? 1 : 0);
      } else {
        // (a laid table: people who have just sat down, the menu still open)
        if (!r.chance(0.3 + 0.2 * ev)) return;
        n = r.chance(0.55) ? 1 : 2;
      }
      n = Math.min(n, seats.length);
      // which chairs: the set places first, the others in a random order
      const order = seats.map((x, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = r.int(0, i); const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
      if (Array.isArray(t.places)) order.sort((x, y) => (t.places.includes(y) ? 1 : 0) - (t.places.includes(x) ? 1 : 0));
      for (let k = 0; k < n; k++) {
        // children only at a table where an adult already sits
        const role = k > 0 && r.chance(0.14 * kidK) ? 'child' : 'adult';
        this.queue.push({ type: 'seat', seat: seats[order[k]], role, table: ti });
      }
    });
  }

  /** Seats dropped for the seating budget (far terraces) are offered again once there is room,
   *  while the terrace is still far down the street. */
  _retrySeats() {
    const c = this.c, L = this.seatRetry;
    if (!L.length || c.counts.seated > MAX_SEATED - BENCH_RESERVE - 16) return;
    for (let i = L.length - 1; i >= 0 && c.counts.seated < MAX_SEATED - BENCH_RESERVE - 16; i--) {
      const q = L[i];
      const rel = q.seat.s - c.camU;
      if (rel < 300 || this.cafes.get(q.seat.cafe.id) !== q.seat.feat) { L.splice(i, 1); continue; }
      if (rel < 420 && !c.vis.hidden(q.seat.s, q.seat.d)) continue;
      L.splice(i, 1);
      this.queue.push(q);
    }
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
    this.placeAt(seat.s, seat.d);
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
    // on a stop's shelter bench: waiting for the tram (boards with the others)
    if (seat.platform) { a.timer = 1e9; seat.platform.sitters.push(a); }
    c.counts.seated++;
    return a;
  }

  /** A free chair of a café near the agent (unwrapped copy) or null. */
  freeChair(cafe, a) {
    const feat = this.cafes.get(cafe.id);
    if (!feat) return null;
    let best = null, bd = 6;
    for (const seat of feat.seats) {
      // (a table in use or laid; nobody sits down at a bare one)
      if (feat.occ.has(seat.key) || !seat.dressed) continue;
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
    const entry = { station: st, served: false, servedL: false, feats: {} };
    this.stations.set(st.id, entry);
    for (const pl of st.platforms) {
      const feat = { type: 'platform', station: st, platform: pl, side: pl.side, count: 0, cap: 15, members: new Set(),
        occ: new Set(), seats: [], sitters: [], shelterS: null, ticket: null };
      entry.feats[pl.side] = feat;
      // the shelter (its bench) and the ticket machine of this platform
      for (const f of c.layout.furniture) {
        if (f.station !== st.id || (f.d > 0 ? 1 : -1) !== pl.side) continue;
        if (f.type === 'shelter') {
          feat.shelterS = c.unwrap(f.s);
          // bench seats along the back wall, the sitter facing the tracks (as built by the
          // furniture: local x towards −s on the right platform, +s on the left)
          for (const [k, x] of [0.3, 1.0, 1.7].entries()) {
            const seat = { type: 'seat', cafe: null, feat, key: k, s: c.unwrap(f.s) - pl.side * x, d: f.d + pl.side * 0.38, side: pl.side,
              faceA: -pl.side * PI / 2, exitD: pl.side * (TRACK_ZONE_HALF + 1.2), bench: true, platH: pl.h ?? 0.3, platform: feat };
            feat.seats.push(seat);
          }
        } else if (f.type === 'ticketMachine') feat.ticket = { s: c.unwrap(f.s), d: f.d - pl.side * 1.0 };
      }
      // where the first doors stop (the cab's nose at stopS on the right platform; a unit's at the
      // mirrored point on the left one): people wait there and by the shelter
      const nose = pl.side > 0 ? c.unwrap(st.stopS) : c.unwrap(2 * st.s - st.stopS);
      feat.doorS = [nose - pl.side * 3.5, nose - pl.side * 10.5];
      // people gather with the time since the last tram (about two a minute, up to 15 standing):
      // the last one left 1-6 minutes ago; 1-3 of them on the shelter bench (often)
      const since = r.range(1, 6);
      const n = Math.min(15, Math.round(2 * since * r.range(0.8, 1.25)) + 2);
      feat.servedT = c.time - since * 60;
      const sit = feat.seats.length && r.chance(0.8) ? Math.min(3, r.int(1, 3)) : 0;
      const order = r.chance(0.5) ? [1, 0, 2] : [1, 2, 0];
      for (let k = 0; k < sit; k++) this.queue.push({ type: 'seat', seat: feat.seats[order[k]], role: 'adult', bench: true });
      for (let k = 0; k < n; k++) this.queue.push({ type: 'passenger', feat, r, first: k === 0 });
    }
  }

  /** More people arrive at the platforms while no tram comes (about two a minute each, up to
   *  15 standing): placed where nobody is looking (in view, walkers joining do it). */
  _platformArrivals() {
    const c = this.c, r = c.rng;
    for (const e of this.stations.values()) {
      const rel = c.unwrap(e.station.s) - c.camU;
      if (rel < -20 || rel > RANGE_AHEAD) continue;
      for (const feat of Object.values(e.feats)) {
        const want = Math.min(15, 2 + Math.floor((2 * (c.time - (feat.servedT ?? c.time))) / 60));
        if (feat.count >= Math.min(want, feat.cap) || c.counts.passenger >= MAX_PASSENGERS) continue;
        const spot = this.platformSpot(feat, r);
        if (!spot || !c.vis.hidden(spot.s, spot.d)) continue;
        this._placePassenger(feat, r, false, spot);
      }
    }
  }

  _placePassenger(feat, r, first = false, at = null) {
    const c = this.c, pl = feat.platform;
    if (c.counts.passenger >= MAX_PASSENGERS) return;
    // someone at the ticket machine (standing side-on to the street, facing it)
    let spot = null, faceA = null;
    if (first && feat.ticket && r.chance(0.45) && this._spotFree(feat, feat.ticket.s, feat.ticket.d, 0.8)) {
      spot = feat.ticket; faceA = pl.side * PI / 2 + r.range(-0.2, 0.2);
    }
    spot = spot || at || this.platformSpot(feat, r);
    if (!spot) return;
    this.placeAt(spot.s, spot.d);
    const a = this.alloc(KIND.PASSENGER, 'platform');
    if (!a) return;
    a.state = ST.PLATFORM; a.s = spot.s; a.d = spot.d; a.side = pl.side; a.noRect = true;
    a.faceA = faceA ?? this.passengerFacing(pl.side, r); a.alpha = a.faceA;
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

  /** Nobody of this platform within `gap` of (s, d)? */
  _spotFree(feat, s, d, gap) {
    for (const a of feat.members) if ((a.s - s) ** 2 + (a.d - d) ** 2 < gap * gap) return false;
    for (const a of feat.sitters) if (a.active && (a.s - s) ** 2 + (a.d - d) ** 2 < gap * gap) return false;
    return true;
  }

  /** A free standing spot on a platform (unwrapped s, signed d), behind the edge line. People
   *  bunch the way they do at real stops: half of them by the shelter (under its roof when they
   *  can: the shade), a third near the end the trams come in at, the rest anywhere; 0.8-1.2 m
   *  apart. */
  platformSpot(feat, r = this.c.rng) {
    const c = this.c, pl = feat.platform, side = pl.side;
    const s0 = c.unwrap(pl.s0), len = pl.s1 - pl.s0;
    const sh = feat.shelterS;
    const inward = side > 0 ? 1 : -1, entryS = side > 0 ? s0 : s0 + len;
    for (let tries = 0; tries < 14; tries++) {
      const u = r.next(), w = r.next();
      let s, ad;
      if (u < 0.5 && sh !== null) {
        if (w < 0.55) { s = sh + r.range(-2.2, 2.2); ad = r.range(TRACK_ZONE_HALF + 1.35, TRACK_ZONE_HALF + 1.85); }   // under the roof
        else { s = sh + r.range(-7, 7); ad = TRACK_ZONE_HALF + 0.6 + w * w * 0.9; }                                  // in front of it, beside it
      } else if (u < 0.8) {
        // where the first two doors will stop
        s = feat.doorS ? feat.doorS[r.chance(0.55) ? 0 : 1] + r.range(-1.3, 1.3) : entryS + inward * r.range(2.2, 8.5);
        ad = TRACK_ZONE_HALF + 0.6 + w * w * (PLATFORM_W - 1.0);
      } else {
        s = s0 + r.range(2.2, len - 2.2); ad = TRACK_ZONE_HALF + 0.6 + w * w * (PLATFORM_W - 1.0);
      }
      if (s < s0 + 2.0 || s > s0 + len - 2.0) continue;
      const d = side * ad;
      if (!this._spotFree(feat, s, d, r.range(0.8, 1.2))) continue;
      let ok = true;
      c.map.gatherCircles(s, 1.5);
      for (let k = 0; k < c.map.qN && ok; k++) {
        const i = c.map.qI[k], ds = c.map.qDS[k], dd = c.map.cD[i] - d;
        if (ds * ds + dd * dd < (c.map.cR[i] + 0.36) ** 2) ok = false;
      }
      if (ok) return { s, d };
    }
    return null;
  }

  /** Waiting passengers face the track or the direction their tram comes from. */
  passengerFacing(side, r = this.c.rng) {
    return side > 0 ? -PI / 2 - r.range(-0.35, 1.25) : PI / 2 - r.range(-0.35, 1.25);
  }

  /** Boarding / alighting when the tram stands at a platform (the cab tram at the right
   *  platform, an oncoming unit at the left one). */
  _stationEvents() {
    const c = this.c, tram = c.tram;
    for (const entry of this.stations.values()) {
      if (tram.units.length) this._unitStop(entry);
      const here = tram.stoppedAt === entry.station;
      if (!here) { if (entry.served && tram.v > 1) entry.served = false; continue; }
      if (entry.served) continue;
      entry.served = true;
      const feat = entry.feats[1];
      if (!feat) continue;
      feat.servedT = c.time;
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
      this._boardSitters(feat, doors, -1);
      // people getting off walk away towards the platform end behind the cab
      const n = r.int(2, 7);
      for (let k = 0; k < n; k++) {
        const ds = r.pick(doors);
        this.placeAt(ds, TRACK_ZONE_HALF + 0.45);
        const a = this.alloc(KIND.PASSENGER, 'alight');
        if (!a) break;
        a.s = ds + r.range(-0.4, 0.4); a.d = TRACK_ZONE_HALF + 0.45; a.side = 1; a.noRect = true;
        if (!c.vis.hidden(a.s, a.d)) { this._unspawn(a); continue; }
        this.joinPlatform(a, feat);
        // most head for the rear end of the platform, some walk on past the cab
        a.task = TASK.ALIGHT; a.step = -1; a.state = ST.GOTO; a.after = r.chance(0.35) ? 1 : -1;
        a.gs = a.s - r.range(0.8, 1.8); a.gd = TRACK_ZONE_HALF + r.range(1.2, 1.9); a.gTol = 0.4;
        a.alpha = PI; a.spawnHidden = true;
        this.stats.bySource.alight++;
      }
    }
  }

  /** The people on the shelter bench get up and board too. */
  _boardSitters(feat, doors, unit) {
    const c = this.c;
    for (const a of [...feat.sitters]) {
      if (!a.active || a.state !== ST.SEATED || a.feature?.platform !== feat) continue;
      this.releaseChair(a.feature);
      const i = feat.sitters.indexOf(a); if (i >= 0) feat.sitters.splice(i, 1);
      a.feature = null; a.kind = KIND.PASSENGER;
      c.counts.seated--; c.counts.passenger++;
      this.joinPlatform(a, feat);
      let best = doors[0];
      for (const s of doors) if (Math.abs(s - a.s) < Math.abs(best - a.s)) best = s;
      a.boardU = unit; a.timer = 0; a.side = feat.side;
      board(c, a, best);
    }
  }

  /** An oncoming unit standing at the left platform: the people waiting there board at its
   *  doors (going in out of sight behind its body), and a few get off, appearing behind it. */
  _unitStop(entry) {
    const c = this.c, tram = c.tram, feat = entry.feats[-1];
    if (!feat) return;
    const T = tram.unitDwelling(entry.station);
    if (!T) { entry.servedL = false; return; }
    if (entry.servedL) return;
    entry.servedL = true;
    feat.servedT = c.time;
    const pl = feat.platform;
    const s0 = c.unwrap(pl.s0), s1 = s0 + (pl.s1 - pl.s0);
    const doors = [];
    for (const off of [3.5, 10.5, 17.5, 24.5, 31.5]) { const s = T.sU + off; if (s > s0 + 0.8 && s < s1 - 0.8) doors.push(s); }
    if (!doors.length) return;
    const r = c.rng;
    for (const a of [...feat.members]) {
      if (!a.active || a.state !== ST.PLATFORM) continue;
      let best = doors[0];
      for (const s of doors) if (Math.abs(s - a.s) < Math.abs(best - a.s)) best = s;
      a.timer = 0; a.boardU = T.i;
      board(c, a, best);
      tram.uStats.boarded++;
    }
    this._boardSitters(feat, doors, T.i);
    // people getting off walk away from the platform edge, then to either end
    const n = r.int(2, 7);
    for (let k = 0; k < n; k++) {
      const ds = r.pick(doors);
      this.placeAt(ds, -(TRACK_ZONE_HALF + 0.45));
      const a = this.alloc(KIND.PASSENGER, 'alight');
      if (!a) break;
      a.s = ds + r.range(-0.4, 0.4); a.d = -(TRACK_ZONE_HALF + 0.45); a.side = -1; a.noRect = true;
      if (!c.vis.hidden(a.s, a.d) && !tram.behindUnit(a.s, a.d)) { this._unspawn(a); continue; }
      this.joinPlatform(a, feat);
      a.task = TASK.ALIGHT; a.step = -1; a.state = ST.GOTO; a.after = r.chance(0.5) ? 1 : -1;
      a.gs = a.s + r.range(-0.8, 0.8); a.gd = -(TRACK_ZONE_HALF + r.range(1.2, 1.9)); a.gTol = 0.4;
      a.alpha = -PI / 2; a.spawnHidden = true;
      this.stats.bySource.alight++;
      tram.uStats.alighted++;
    }
  }
}

/** Light top (a white / pale shirt) and light bottoms of an appearance, from its garment tints. */
const tintLum = (ap, region) => {
  const t = ap.tints;
  if (!t || t.length < (region + 1) * 3) return 0.5;
  return 0.2126 * t[region * 3] + 0.7152 * t[region * 3 + 1] + 0.0722 * t[region * 3 + 2];
};
const lightTop = (ap) => tintLum(ap, 5) > 0.6;
const lightBottom = (ap) => tintLum(ap, 7) > 0.12;

/** Does an appearance suit a role (see Population._appearance)? */
function roleFits(role, ap) {
  const age = ap.age || (ap.base === 'child' ? 'child' : 'adult');
  switch (role) {
    case 'any': return true;
    case 'child': return ap.base === 'child';
    case 'elderly': return age === 'old';
    case 'parent': return age === 'adult' && !ap.carry && !ap.phoneWalk;
    case 'grandparent': return age === 'old' && !ap.walkOld && !ap.carry && !ap.phoneWalk;
    case 'rider': return (age === 'adult' || age === 'teen') && !ap.carry && !ap.phoneWalk && !ap.skirtPart;
    case 'young': return age === 'adult' || age === 'teen';
    case 'waiter': return age === 'adult' && !ap.carry && !ap.phoneWalk && !ap.bag && !ap.skirtPart && (ap.topKind === 'shirt' || ap.topKind === 'tee') && lightTop(ap) && !lightBottom(ap);
    default: return ap.base !== 'child';
  }
}

/** Footprints of a and b (b at ds, dd from a) apart? */
