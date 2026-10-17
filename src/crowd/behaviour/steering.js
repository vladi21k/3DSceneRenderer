import { KIND, ST, TASK } from './agent.js';
import { think, desired, timerDone, arrive } from './behaviour.js';
import { AGENT_R, CELL, GRID_D, RANGE_BEHIND, SIMPLE_BEYOND, TURN_RATE, WALL_GAP, RIDE_D, BAND } from './constants.js';

// Local motion: a social-force model with anticipatory sidestepping, on a uniform
// grid in route coordinates. Neighbours repel (stronger in front), people predict
// head-on encounters and step aside (keeping right), obstacles from the layout are
// avoided ahead of time and resolved as hard constraints (café terraces and platforms
// as true rectangles), facades are walls. Hard corrections are rate limited so nobody
// ever jumps, and velocities are taken from the actual motion after the constraints, so
// the gait (phase, speed) always matches what the body really does.

const TAU = 0.45;              // relaxation time towards the preferred velocity
const R2 = AGENT_R * 2;
const RECT_R = AGENT_R * 0.6;  // body radius against café furniture / platform edges
const PI = Math.PI;

const len2 = (x, y) => Math.sqrt(x * x + y * y);
const wrapAngle = (x) => { x = (x + PI) % (2 * PI); if (x < 0) x += 2 * PI; return x - PI; };

export class Steering {
  constructor(c) {
    this.c = c;
    this.nx = Math.ceil((SIMPLE_BEYOND + RANGE_BEHIND + 30) / CELL);
    this.ny = Math.ceil((2 * GRID_D) / CELL);
    this.head = new Int32Array(this.nx * this.ny);
    this.des = { vs: 0, vd: 0, vmax: 1.6 };
    this.s0 = 0;
    this.frame = 0;
    this.maxC = 0.05;          // largest hard correction of this step (m)
  }

  _cell(a) {
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    if (ix < 0 || ix >= this.nx || iy < 0 || iy >= this.ny) return -1;
    return ix * this.ny + iy;
  }

  buildGrid(agents) {
    this.head.fill(-1);
    this.s0 = this.c.camU - RANGE_BEHIND - 8;
    for (const a of agents) {
      a.next = -1;
      if (!a.active) continue;
      const k = this._cell(a);
      if (k < 0) continue;
      a.next = this.head[k];
      this.head[k] = a.slot;
    }
  }

  step(dt) {
    const c = this.c, agents = c.population.agents, tram = c.tram, des = this.des;
    this.buildGrid(agents);
    this.frame++;
    const dt1 = dt;
    for (const a of agents) {
      if (!a.active) continue;
      // far agents (a few pixels tall, far outside the tram's zone) step at half rate
      a.simple = a.s - c.camU > SIMPLE_BEYOND;
      dt = dt1;
      if (a.simple) { if (((this.frame + a.slot) & 1) === 1) continue; dt = dt1 * 2; }
      a.timer -= dt; a.thinkT -= dt;
      if (a.thinkT <= 0) think(c, a);
      if (!a.active) continue;
      if (a.state === ST.SEATED) { this._settle(a, dt); continue; }
      if (a.timer <= 0 && (a.state === ST.STAND || a.state === ST.WAIT)) timerDone(c, a);
      if (!a.active) continue;
      tram.preStep(a);
      desired(c, a, des);
      if (!a.active) continue;

      const standing = (a.state === ST.STAND || a.state === ST.WAIT || a.state === ST.PLATFORM) && !a.clearing;
      let fs = (des.vs - a.vs) / (standing ? 0.3 : TAU);
      let fd = (des.vd - a.vd) / (standing ? 0.3 : TAU);
      // avoidance forces at 30 Hz per agent (alternate frames), held in between
      let gathered = false;
      if (a.simple) { a.afs = 0; a.afd = 0; }
      else if (((this.frame + a.slot) & 1) === 0 || a.fresh) {
        this._social(a, standing);
        const s = this.fs, d = this.fd;
        this._obstacles(a, standing);
        a.afs = s + this.fs; a.afd = d + this.fd;
        gathered = true;
      }
      fs += a.afs; fd += a.afd;
      a.vs += fs * dt; a.vd += fd * dt;
      let sp = len2(a.vs, a.vd);
      const vmax = standing && !a.moving ? 0.6 : des.vmax;
      a.vmaxCur = vmax;
      if (sp > vmax) { a.vs *= vmax / sp; a.vd *= vmax / sp; sp = vmax; }
      // people standing still are not shuffled around by the forces: a dead band
      if (standing && !a.moving && sp < 0.3) { a.vs = 0; a.vd = 0; }

      const prevD = a.d, prevS = a.s;
      const k = Math.max(0.5, 1 + c.route.curvature(a.s) * a.d);
      a.s += (a.vs / k) * dt;
      a.d += a.vd * dt;
      // hard corrections never move anyone faster than a brisk step
      this.maxC = Math.max(0.02, 2 * Math.max(1.6, vmax) * dt);
      this._constrain(a, gathered, a.s - prevS);
      tram.constrain(a, prevD);
      // velocity from the actual motion (constraints included): the gait follows what happened
      const ms = (a.s - prevS) * k, md = a.d - prevD;
      a.vs = ms / dt; a.vd = md / dt;
      const moved = len2(ms, md);

      // goals that cannot be reached (blocked by a crowd or a wall): give up after a while
      if (a.state === ST.GOTO) {
        if (moved < 0.12 * dt) { a.stuckT += dt; if (a.stuckT > 4) { a.stuckT = 0; arrive(c, a); } } else a.stuckT = Math.max(0, a.stuckT - dt);
      } else if (a.leader && a.state === ST.WALK) {
        // a group member held back (a pole, a narrow passage): fall in behind the leader for a while
        const want = len2(des.vs, des.vd);
        if (want > 0.5 && moved < 0.35 * want * dt) { a.stuckF += dt; if (a.stuckF > 0.7) { a.stuckF = 0; a.singleT = c.time + c.rng.range(4, 7); } }
        else a.stuckF = Math.max(0, a.stuckF - dt);
      }
    }
  }

  /** Seated: ease the last centimetres onto the chair. */
  _settle(a, dt) {
    a.vs = 0; a.vd = 0;
    if (a.seatS === undefined || a.seatD === undefined) return;
    const es = a.seatS - a.s, ed = a.seatD - a.d, e = len2(es, ed);
    if (e < 1e-3) return;
    const st = Math.min(1, (0.5 * dt) / e);
    a.s += es * st; a.d += ed * st;
  }

  // ---------------------------------------------------------------- neighbours
  _social(a, standing) {
    let fs = 0, fd = 0;
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    const sp = len2(a.vs, a.vd);
    const es = sp > 0.1 ? a.vs / sp : Math.cos(a.alpha), ed = sp > 0.1 ? a.vd / sp : Math.sin(a.alpha);
    const agents = this.c.population.agents;
    const L = a.leader || a;
    for (let x = ix - 2; x <= ix + 2; x++) {
      if (x < 0 || x >= this.nx) continue;
      for (let y = iy - 1; y <= iy + 1; y++) {
        if (y < 0 || y >= this.ny) continue;
        for (let j = this.head[x * this.ny + y]; j >= 0; j = agents[j].next) {
          const b = agents[j];
          if (b === a) continue;
          const dx = b.s - a.s, dy = b.d - a.d;
          const d2 = dx * dx + dy * dy;
          if (d2 > 16 || d2 < 1e-6) continue;
          const dist = Math.sqrt(d2);
          const nx = -dx / dist, ny = -dy / dist; // from b to a
          const mate = (b.leader || b) === L;
          if (dist < 2.2) {
            // body repulsion, anisotropic (people react to what is in front of them). Standing
            // people only make room for real overlaps: the walkers go round them.
            const cosPhi = -(nx * es + ny * ed);
            const w = 0.3 + 0.7 * (1 + cosPhi) * 0.5;
            let A = mate ? 0.7 : 2.4;
            if (standing) A = dist < R2 ? 0.5 : 0;
            if (b.kind === KIND.SEATED) A *= 0.6;
            const f = A * Math.exp((R2 + 0.06 - dist) / 0.3) * w;
            fs += nx * f; fd += ny * f;
          }
          if (standing || mate || sp < 0.3) continue;
          // anticipation: time to closest approach with the relative velocity
          const rvs = a.vs - b.vs, rvd = a.vd - b.vd;
          const vv = rvs * rvs + rvd * rvd;
          if (vv < 0.04) continue;
          const tc = (dx * rvs + dy * rvd) / vv;
          if (tc <= 0 || tc > 3) continue;
          const cx = dx - rvs * tc, cy = dy - rvd * tc;   // b relative to a at closest approach
          const cd = len2(cx, cy);
          if (cd > 0.85) continue;
          const k = 1.7 * (1 - tc / 3) * (0.85 - cd) / 0.85;
          if (cd < 0.08) { fs += -ed * k; fd += es * k; } // dead ahead: step to the right
          else {
            // step away, with a bias to the walker's right
            fs += (-cx / cd) * k - ed * k * 0.35; fd += (-cy / cd) * k + es * k * 0.35;
          }
        }
      }
    }
    this.fs = fs; this.fd = fd;
  }

  // ---------------------------------------------------------------- obstacles
  _obstacles(a, standing) {
    const c = this.c, map = c.map;
    let fs = 0, fd = 0;
    // with the tram near, obstacles by the ride track are passed on the side away from it
    const tramNear = c.tram.near(a);
    const n = map.gatherCircles(a.s, 3.5);
    const sp = len2(a.vs, a.vd);
    const es = sp > 0.1 ? a.vs / sp : 0, ed = sp > 0.1 ? a.vd / sp : 0;
    for (let q = 0; q < n; q++) {
      const i = map.qI[q];
      const dx = map.qDS[q], dy = map.cD[i] - a.d, r = map.cR[i];
      const dist = len2(dx, dy);
      const gap = dist - r - AGENT_R;
      if (gap < 0.6 && dist > 1e-4) {
        const f = Math.min(6, 2.6 * Math.exp(-gap / 0.16));
        fs -= (dx / dist) * f; fd -= (dy / dist) * f;
      }
      if (standing || sp < 0.2) continue;
      // look ahead: an obstacle across the path is passed on the side with more room
      const along = dx * es + dy * ed;
      const lat = -dx * ed + dy * es;  // + = obstacle to the walker's right
      const need = r + AGENT_R + 0.22;
      if (along > 0 && along < 3.8 && Math.abs(lat) < need) {
        let side;
        if (lat > 0.04) side = -1;           // obstacle to the right: pass on the left
        else if (lat < -0.04) side = 1;
        else side = (a.gd - a.d) * (es >= 0 ? 1 : -1) >= 0 ? 1 : -1; // dead ahead: towards the lane
        if (tramNear && Math.abs(map.cD[i] - RIDE_D) < BAND + 1.3 && Math.sign(es * side) === Math.sign(RIDE_D - a.d)) side = -side;
        const k = 1.5 * (1 - along / 3.8) * (1 - Math.abs(lat) / need + 0.3);
        fs += -ed * side * k; fd += es * side * k;
      }
    }
    // café terraces and platforms ahead: their ends are walls across the path, passed on the
    // open side (the corridor side of a terrace, whichever side is nearer for a platform)
    if (!a.noRect && !standing && sp > 0.2 && Math.abs(es) > 0.3) {
      const side = a.d >= 0 ? 1 : -1, ad = Math.abs(a.d);
      const nr = map.rectsNear(a.s, side);
      for (let q = 0; q < nr; q++) {
        const r = map.rq[q];
        const ds = map.rectDS(r, a.s);
        // distance to the end the walker is heading for
        const along = es > 0 ? -ds : ds - r.len;
        if (along < -RECT_R || along > 4.5) continue;
        if (ad < r.inner - RECT_R - 0.25 || ad > r.outer + RECT_R + 0.25) continue;
        const out = r.outer < 90 && ad - r.inner > r.outer - ad;   // nearer to the platform's back edge
        const dirD = (out ? 1 : -1) * side;                          // signed d direction to the free side
        const k = 2.2 * (1 - Math.max(0, along) / 4.5);
        fd += dirD * k * Math.abs(es);
        fs -= es * 0.6 * k * (along < 0.6 ? 1 : 0.3);               // and slow down rather than press on
      }
    }
    this.fs = fs; this.fd = fd;
  }

  // ---------------------------------------------------------------- hard constraints
  /** `gathered`: the obstacle query of this step (around the position before the move, which
   *  was `moved` metres ago along s) is still in map.q*. Corrections are rate limited. */
  _constrain(a, gathered = false, moved = 0) {
    const c = this.c, map = c.map, maxC = this.maxC;
    // circle obstacles: resolve overlaps
    const n = gathered ? map.qN : map.gatherCircles(a.s, 1.2);
    const shift = gathered ? moved : 0;
    for (let q = 0; q < n; q++) {
      const i = map.qI[q];
      const dx = map.qDS[q] - shift, dy = map.cD[i] - a.d;
      const min = map.cR[i] + AGENT_R * 0.8;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min) {
        const dist = Math.sqrt(d2) || 1e-3;
        const push = Math.min(maxC, min - dist);
        a.s -= (dx / dist) * push; a.d -= (dy / dist) * push;
      }
    }
    const side = a.d >= 0 ? 1 : -1;
    // café terraces and platforms: out through the nearest edge
    if (!a.noRect) this._rects(a, side, maxC);
    // facades and cross street mouths
    if (a.inDoor) {
      const dr = a.door;
      const lim = dr && dr.o ? dr.o.d + dr.depth - 0.1 : map.facadeAt(a.s, side) + 0.25;
      // out of the recess again (people coming out of a door): an ordinary walker
      if (a.task !== TASK.ENTER && Math.abs(a.d) < map.facadeAt(a.s, side) - 0.35) a.inDoor = false;
      else {
        if (a.s < a.doorS0) a.s += Math.min(maxC, a.doorS0 - a.s); else if (a.s > a.doorS1) a.s -= Math.min(maxC, a.s - a.doorS1);
        if (Math.abs(a.d) > lim) a.d = side * lim;
        return;
      }
    }
    const m = map.mouthAt(a.s, side);
    if (m) {
      // inside the side street opening the side walls bound s; elsewhere the facade bounds d
      const line = map.mouthLine(m, side);
      const ms = c.unwrap(m.s), half = m.width / 2 - 0.55;
      if (Math.abs(a.d) > line - WALL_GAP && Math.abs(a.s - ms) < half + 0.4) {
        if (a.s < ms - half) a.s += Math.min(maxC, ms - half - a.s); else if (a.s > ms + half) a.s -= Math.min(maxC, a.s - ms - half);
        if (Math.abs(a.d) > line + 22) a.d = side * (line + 22);
        return;
      }
    }
    const wall = map.wallAt(a.s, side);
    if (Math.abs(a.d) > wall) { a.d = side * Math.max(wall, Math.abs(a.d) - Math.max(maxC, 0.06)); if (a.vd * side > 0) a.vd = 0; }
  }

  /** Push a body out of café / platform footprints through the edge of least penetration. */
  _rects(a, side, maxC) {
    const map = this.c.map;
    const nr = map.rectsNear(a.s, side);
    for (let q = 0; q < nr; q++) {
      const r = map.rq[q];
      const ds = map.rectDS(r, a.s), ad = Math.abs(a.d);
      if (ds < -RECT_R || ds > r.len + RECT_R || ad < r.inner - RECT_R || ad > r.outer + RECT_R) continue;
      const p0 = ds + RECT_R, p1 = r.len + RECT_R - ds;          // out through the s ends
      const pIn = ad - (r.inner - RECT_R);                         // towards the track corridor
      const pOut = r.outer < 90 ? r.outer + RECT_R - ad : 1e9;     // behind a platform
      const m = Math.min(p0, p1, pIn, pOut);
      const step = Math.min(maxC, m);
      if (m === p0) { a.s -= step; if (a.vs > 0) a.vs = 0; }
      else if (m === p1) { a.s += step; if (a.vs < 0) a.vs = 0; }
      else if (m === pIn) { a.d -= side * step; if (a.vd * side > 0) a.vd = 0; }
      else { a.d += side * step; if (a.vd * side < 0) a.vd = 0; }
    }
  }

  // ---------------------------------------------------------------- facing, gait, gaze
  /** dist: horizontal distance the figure actually moved since the last output. */
  animate(a, dt, humans, dist) {
    const c = this.c;
    const still = a.state === ST.SEATED || a.state === ST.PLATFORM || a.state === ST.STAND || a.state === ST.WAIT;
    // smoothed actual speed (the steering velocity is the real displacement rate)
    const spRaw = a.state === ST.SEATED ? 0 : len2(a.vs, a.vd);
    a.speedA += (spRaw - a.speedA) * Math.min(1, dt * 8);
    if (dt === 0 || a.fresh) a.speedA = spRaw;
    const sp = a.speedA;
    a.speed = sp;
    let target = a.alpha;
    if (sp > 0.28 && !(still && !a.moving)) target = Math.atan2(a.vd, a.vs);
    else if (still) target = a.faceA;
    const diff = wrapAngle(target - a.alpha);
    const rate = TURN_RATE * (sp > 0.8 ? 1 : 0.7);
    a.alpha = wrapAngle(a.alpha + Math.max(-rate * dt, Math.min(rate * dt, diff)));
    a.pose = a.state === ST.SEATED ? 2 : (still && !a.moving && sp < 0.6) ? 1 : 0;
    // gait phase: advance by the distance actually covered / stride length, so feet do not slide
    if (a.pose === 0 && dist > 1e-5) {
      // the renderer's stride for this body and speed (re-queried only when the speed changes)
      if (Math.abs(sp - a.strideV) > 0.04) {
        a.strideV = sp;
        a.stride = Math.max(0.3, humans && humans.strideLength ? humans.strideLength(a.appearance, Math.max(0.05, sp)) : fallbackStride(sp));
      }
      a.phase = (a.phase + dist / a.stride) % 1;
    }
    // gaze: the tram when it rings or when waiting to cross, otherwise idle glances
    let lookT = a.lookGoal;
    if (a.tramLookT > c.time || (a.state === ST.WAIT && a.task === TASK.CROSS)) lookT = c.lookAtTram(a);
    const ld = lookT - a.look;
    a.look += Math.max(-2.5 * dt, Math.min(2.5 * dt, ld));
  }
}

/** Stride (two steps) when the renderer does not provide one: ~1.5 m at 1.4 m/s. */
export function fallbackStride(v) { return 1.48 * (0.55 + 0.32 * v); }
