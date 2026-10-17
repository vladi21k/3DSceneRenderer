import { TRACK_ZONE_HALF } from '../../core/config.js';
import { PLATFORM_W } from '../../world/layout.js';
import { KIND, ST, TASK } from './agent.js';
import { think, desired, timerDone, arrive } from './behaviour.js';
import { AGENT_R, CELL, GRID_D, RANGE_BEHIND, SIMPLE_BEYOND, TURN_RATE, WALL_GAP } from './constants.js';

// Local motion: a social-force model with anticipatory sidestepping, on a uniform
// grid in route coordinates. Neighbours repel (stronger in front), people predict
// head-on encounters and step aside (keeping right), obstacles from the layout are
// avoided ahead of time and resolved as hard constraints, facades are walls.

const TAU = 0.45;              // relaxation time towards the preferred velocity
const R2 = AGENT_R * 2;
const PI = Math.PI;

const wrapAngle = (x) => { x = (x + PI) % (2 * PI); if (x < 0) x += 2 * PI; return x - PI; };

export class Steering {
  constructor(c) {
    this.c = c;
    this.nx = Math.ceil((SIMPLE_BEYOND + RANGE_BEHIND + 30) / CELL);
    this.ny = Math.ceil((2 * GRID_D) / CELL);
    this.head = new Int32Array(this.nx * this.ny);
    this.des = { vs: 0, vd: 0, vmax: 1.6 };
    this.s0 = 0;
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
    for (const a of agents) {
      if (!a.active) continue;
      a.timer -= dt; a.thinkT -= dt;
      a.simple = a.s - c.camU > SIMPLE_BEYOND;
      if (a.thinkT <= 0) think(c, a);
      if (!a.active) continue;
      if (a.state === ST.SEATED) { a.vs = 0; a.vd = 0; continue; }
      if (a.timer <= 0 && (a.state === ST.STAND || a.state === ST.WAIT)) timerDone(c, a);
      if (!a.active) continue;
      tram.preStep(a);
      desired(c, a, des);
      if (!a.active) continue;

      const standing = (a.state === ST.STAND || a.state === ST.WAIT || a.state === ST.PLATFORM) && !a.clearing;
      let fs = (des.vs - a.vs) / (standing ? 0.3 : TAU);
      let fd = (des.vd - a.vd) / (standing ? 0.3 : TAU);
      if (!a.simple) {
        this._social(a, standing);
        fs += this.fs; fd += this.fd;
        this._obstacles(a, standing);
        fs += this.fs; fd += this.fd;
      }
      a.vs += fs * dt; a.vd += fd * dt;
      const sp = Math.hypot(a.vs, a.vd);
      const vmax = standing ? 0.6 : des.vmax;
      if (sp > vmax) { a.vs *= vmax / sp; a.vd *= vmax / sp; }

      const prevD = a.d, prevS = a.s;
      const k = 1 + c.route.curvature(a.s) * a.d;
      a.s += (a.vs / Math.max(0.5, k)) * dt;
      a.d += a.vd * dt;
      this._constrain(a);
      tram.constrain(a, prevD);

      // goals that cannot be reached (blocked by a crowd or a wall): give up after a while
      if (a.state === ST.GOTO) {
        const moved = Math.hypot(a.s - prevS, a.d - prevD);
        if (moved < 0.12 * dt) { a.stuckT += dt; if (a.stuckT > 4) { a.stuckT = 0; arrive(c, a); } } else a.stuckT = Math.max(0, a.stuckT - dt);
      }
    }
  }

  // ---------------------------------------------------------------- neighbours
  _social(a, standing) {
    let fs = 0, fd = 0;
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    const sp = Math.hypot(a.vs, a.vd);
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
            // body repulsion, anisotropic (people react to what is in front of them)
            const cosPhi = -(nx * es + ny * ed);
            const w = 0.3 + 0.7 * (1 + cosPhi) * 0.5;
            let A = mate ? 0.7 : 2.4;
            if (standing) A *= 0.12;
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
          const cd = Math.hypot(cx, cy);
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
    const map = this.c.map;
    let fs = 0, fd = 0;
    const n = map.gatherCircles(a.s, 3.5);
    const sp = Math.hypot(a.vs, a.vd);
    const es = sp > 0.1 ? a.vs / sp : 0, ed = sp > 0.1 ? a.vd / sp : 0;
    for (let q = 0; q < n; q++) {
      const i = map.qI[q];
      const dx = map.qDS[q], dy = map.cD[i] - a.d, r = map.cR[i];
      const dist = Math.hypot(dx, dy);
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
        const k = 1.5 * (1 - along / 3.8) * (1 - Math.abs(lat) / need + 0.3);
        fs += -ed * side * k; fd += es * side * k;
      }
    }
    this.fs = fs; this.fd = fd;
  }

  // ---------------------------------------------------------------- hard constraints
  _constrain(a) {
    const c = this.c, map = c.map;
    // circle obstacles: resolve overlaps
    const n = map.gatherCircles(a.s, 1.2);
    for (let q = 0; q < n; q++) {
      const i = map.qI[q];
      const dx = map.qDS[q], dy = map.cD[i] - a.d;
      const min = map.cR[i] + AGENT_R * 0.8;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min) {
        const dist = Math.sqrt(d2) || 1e-3;
        const push = min - dist;
        a.s -= (dx / dist) * push; a.d -= (dy / dist) * push;
      }
    }
    const side = a.d >= 0 ? 1 : -1, ad = Math.abs(a.d);
    // café and platform footprints
    if (!a.noRect) {
      const inner = map.rectInner(a.s, side, ad + AGENT_R * 0.6);
      if (inner > 0) {
        if (inner <= TRACK_ZONE_HALF + 0.01) {
          // platform: walkers stay behind it, or in the corridor if they came from there
          if (ad > TRACK_ZONE_HALF + 0.5) a.d = side * (TRACK_ZONE_HALF + PLATFORM_W + AGENT_R);
          else a.d = side * (TRACK_ZONE_HALF - AGENT_R * 0.6);
        } else a.d = side * (inner - AGENT_R * 0.6);
        a.vd *= 0.3;
      }
    }
    // facades and cross street mouths
    if (a.inDoor) {
      if (a.s < a.doorS0) a.s = a.doorS0; else if (a.s > a.doorS1) a.s = a.doorS1;
      const lim = a.door ? a.door.d + a.door.recess - 0.1 : map.facadeAt(a.s, side) + 0.25;
      if (Math.abs(a.d) > lim) a.d = side * lim;
      return;
    }
    const m = map.mouthAt(a.s, side);
    if (m) {
      const line = map.mouthLine(m, side);
      if (Math.abs(a.d) > line - WALL_GAP) {
        const ms = c.unwrap(m.s), half = m.width / 2 - 0.55;
        if (a.s < ms - half) a.s = ms - half; else if (a.s > ms + half) a.s = ms + half;
        if (Math.abs(a.d) > line + 22) a.d = side * (line + 22);
        return;
      }
    }
    const wall = map.wallAt(a.s, side);
    if (Math.abs(a.d) > wall) { a.d = side * wall; if (a.vd * side > 0) a.vd = 0; }
  }

  // ---------------------------------------------------------------- facing, gait, gaze
  animate(a, dt, humans) {
    const c = this.c;
    const sp = Math.hypot(a.vs, a.vd);
    a.speed = sp;
    const still = a.state === ST.SEATED || a.state === ST.PLATFORM || a.state === ST.STAND || a.state === ST.WAIT;
    let target = a.alpha;
    if (sp > 0.28 && !(still && sp < 0.5)) target = Math.atan2(a.vd, a.vs);
    else if (still) target = a.faceA;
    const diff = wrapAngle(target - a.alpha);
    const rate = TURN_RATE * (sp > 0.8 ? 1 : 0.7);
    a.alpha = wrapAngle(a.alpha + Math.max(-rate * dt, Math.min(rate * dt, diff)));
    // gait phase: advance by distance / stride length so feet do not slide
    if (sp > 0.02) {
      const stride = humans && humans.strideLength ? humans.strideLength(a.appearance, sp) : fallbackStride(sp);
      a.phase = (a.phase + (sp * dt) / Math.max(0.3, stride)) % 1;
    }
    a.pose = a.state === ST.SEATED ? 2 : (still && sp < 0.15 && a.task !== TASK.CROSS) ? 1 : 0;
    // gaze: the tram when it rings or when waiting to cross, otherwise idle glances
    let lookT = a.lookGoal;
    if (a.tramLookT > c.time || (a.state === ST.WAIT && a.task === TASK.CROSS)) lookT = c.lookAtTram(a);
    const ld = lookT - a.look;
    a.look += Math.max(-2.5 * dt, Math.min(2.5 * dt, ld));
  }
}

/** Stride (two steps) when the renderer does not provide one: ~1.5 m at 1.4 m/s. */
export function fallbackStride(v) { return 1.48 * (0.55 + 0.32 * v); }
