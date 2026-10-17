import { KIND, ST, TASK, MOB } from './agent.js';
import { think, desired, timerDone, arrive } from './behaviour.js';
import { AGENT_R, CELL, GRID_D, RANGE_BEHIND, SIMPLE_BEYOND, TURN_RATE, WALL_GAP, RIDE_D, BAND, FOOT, CYCLE_FALLBACK } from './constants.js';
import { updateFoot, footGap, propPointDist2, _foot } from './footprint.js';
import { rideTarget } from './cyclist.js';

// Local motion: a social-force model with anticipatory sidestepping, on a uniform
// grid in route coordinates. Neighbours repel (stronger in front), people predict
// head-on encounters and step aside (keeping right), obstacles from the layout are
// avoided ahead of time and resolved as hard constraints (café terraces and platforms
// as true rectangles), facades are walls. Hard corrections are rate limited so nobody
// ever jumps, and velocities are taken from the actual motion after the constraints, so
// the gait (phase, speed) always matches what the body really does.
// People with a stroller or a bicycle avoid with their whole footprint (body + prop
// capsule); cyclists are steered by a bicycle model instead (cyclist.js chooses the line
// and the speed, the model turns with a limited, smoothly changing yaw rate).

const TAU = 0.45;              // relaxation time towards the preferred velocity
// prop footprint in the person's frame for the look-ahead: lateral centre (+ right) and half width
const FOOT_LAT = FOOT.map((F) => (F ? (F.l + (F.l > 0 ? F.r - AGENT_R : 0)) / 2 : 0));
const FOOT_HALF = FOOT.map((F) => (F ? Math.max(AGENT_R, (Math.abs(F.l) + F.r + AGENT_R) / 2) : AGENT_R));
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
      if (a.mob === MOB.CYCLE) { this._stepCycle(a, dt); continue; }
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
      const s1 = a.s, d1 = a.d;
      this._constrain(a, gathered, a.s - prevS);
      // all corrections together stay within a brisk step too
      const cs = (a.s - s1) * k, cd = a.d - d1, cl = len2(cs, cd);
      if (cl > this.maxC) { const f = this.maxC / cl; a.s = s1 + (a.s - s1) * f; a.d = d1 + cd * f; }
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

  /** A cyclist: cyclist.js picks the line (lane, passing offset, lane change, clearing the
   *  tram) and the speed; a bicycle model follows it with a speed-dependent, smoothly
   *  changing turn rate, so the path is a sequence of physically plausible arcs. */
  _stepCycle(a, dt) {
    const c = this.c, tram = c.tram, T = this.ride || (this.ride = { d: 0, v: 0, ang: 0.45, hard: false, alpha: null });
    tram.preStep(a);
    rideTarget(c, a, T);
    if (!a.active || a.mob !== MOB.CYCLE) return;
    // speed: gentle acceleration, firm braking when something is right in front
    const dv = T.v - a.bikeV;
    a.bikeV = Math.max(0, a.bikeV + Math.max(-(T.hard ? 3.6 : 1.7) * dt, Math.min(0.75 * dt, dv)));
    const v = a.bikeV, vv = Math.max(v, 0.6);
    // steering: pure pursuit of the target line (or a heading given directly)
    let alphaT;
    if (T.alpha !== null) alphaT = T.alpha;
    else {
      const L = Math.min(8, Math.max(2.6, 1.25 * vv + 1.6));
      const psi = Math.max(-T.ang, Math.min(T.ang, Math.atan2(T.d - a.d, L)));
      alphaT = a.dir > 0 ? psi : PI - psi;
    }
    const err = wrapAngle(alphaT - a.alpha);
    // turn rate: lateral acceleration ≤ ~1.9 m/s², radius ≥ 2.3 m, and the rate itself changes smoothly
    const wMax = Math.min(1.9 / vv, vv / 2.3, 1.3);
    let w = Math.max(-wMax, Math.min(wMax, 2.4 * err));
    w = a.yawW + Math.max(-3.0 * dt, Math.min(3.0 * dt, w - a.yawW));
    const na = wrapAngle(a.alpha + w * dt);
    if (tram.turnBlocked(a, na)) w = 0; else a.alpha = na;
    a.yawW = w;
    updateFoot(a);
    a.vs = v * Math.cos(a.alpha); a.vd = v * Math.sin(a.alpha);
    a.vmaxCur = Math.max(1.6, v);
    a.moving = v > 0.05;
    const prevD = a.d, prevS = a.s;
    const k = Math.max(0.5, 1 + c.route.curvature(a.s) * a.d);
    a.s += (a.vs / k) * dt;
    a.d += a.vd * dt;
    this.maxC = Math.max(0.02, 2 * Math.max(1.6, v) * dt);
    const s1 = a.s, d1 = a.d;
    this._constrain(a, false, 0);
    const cs = (a.s - s1) * k, cd = a.d - d1, cl = len2(cs, cd);
    const lim = 0.5 * this.maxC;
    if (cl > lim) { const f = lim / cl; a.s = s1 + (a.s - s1) * f; a.d = d1 + cd * f; }
    tram.constrain(a, prevD);
    const ms = (a.s - prevS) * k, md = a.d - prevD;
    a.vs = ms / dt; a.vd = md / dt;
    // held back by a constraint: the bicycle really slows down
    const along = (ms * Math.cos(a.alpha) + md * Math.sin(a.alpha)) / dt;
    if (along < a.bikeV - 0.05) a.bikeV = Math.max(0, along);
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
          let nx = -dx / dist, ny = -dy / dist; // from b to a
          let gap = dist - R2;
          // strollers and bicycles: the gap between the whole footprints
          if ((a.mob || b.mob) && dist < 3.4) { const g = footGap(a, b, dx, dy); gap = g.gap; nx = g.ns; ny = g.nd; }
          const mate = (b.leader || b) === L;
          if (gap < 1.64) {
            // body repulsion, anisotropic (people react to what is in front of them). Standing
            // people only make room for real overlaps: the walkers go round them.
            const cosPhi = -(nx * es + ny * ed);
            const w = 0.3 + 0.7 * (1 + cosPhi) * 0.5;
            let A = mate ? 0.7 : b.mob === MOB.CYCLE ? 3.2 : 2.4;
            if (standing) A = gap < 0 ? 0.5 : 0;
            if (b.kind === KIND.SEATED) A *= 0.6;
            const f = A * Math.exp((0.06 - gap) / 0.3) * w;
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
          const reach = 0.85 + (a.mob ? 0.3 : 0) + (b.mob ? (b.mob === MOB.CYCLE ? 0.45 : 0.3) : 0);
          if (cd > reach) continue;
          const k = 1.7 * (1 - tc / 3) * (reach - cd) / reach;
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
    const sp = len2(a.vs, a.vd), des = this.des, dsp = len2(des.vs, des.vd);
    // heading for the look-ahead: the actual motion, or where they want to go when (nearly) stopped
    let es = 0, ed = 0;
    if (sp > 0.2) { es = a.vs / sp; ed = a.vd / sp; } else if (dsp > 0.2) { es = des.vs / dsp; ed = des.vd / dsp; }
    const heading = sp > 0.2 || dsp > 0.2;
    const goalD = a.clearing ? a.clearTo : a.gd;
    const mob = a.mob, F = FOOT[mob];
    for (let q = 0; q < n; q++) {
      const i = map.qI[q];
      const dx = map.qDS[q], dy = map.cD[i] - a.d, r = map.cR[i];
      const dist = len2(dx, dy);
      const gap = dist - r - AGENT_R;
      if (mob && F) {
        // the stroller / bicycle is kept off the pole too
        const pd2 = propPointDist2(a, dx, dy), pdist = Math.sqrt(pd2), pg = pdist - r - a.fpR;
        if (pg < 0.5 && pdist > 1e-4) {
          const f = Math.min(6, 2.6 * Math.exp(-pg / 0.16));
          fs -= ((dx - _foot.s) / pdist) * f; fd -= ((dy - _foot.d) / pdist) * f;
        }
      }
      if (gap < 0.6 && dist > 1e-4) {
        const f = Math.min(6, 2.6 * Math.exp(-gap / 0.16));
        fs -= (dx / dist) * f; fd -= (dy / dist) * f;
        // the way out to the side is behind this pole / trunk: slide along it to get round it
        if (!standing && Math.abs(dx) < r + AGENT_R + 0.1 && dy * (goalD - a.d) > 0 && Math.abs(goalD - a.d) > Math.abs(dy) - r) {
          const away = dx > 0.02 ? -1 : dx < -0.02 ? 1 : (a.dir || 1);
          fs += away * 1.6 * (1 - Math.abs(dx) / (r + AGENT_R + 0.1) + 0.3);
        }
      }
      if (standing || !heading) continue;
      // look ahead: an obstacle across the path is passed on the side with more room
      // (measured from the front of a stroller, around the middle of a person + bicycle)
      const along = dx * es + dy * ed - (mob && F ? Math.max(0, F.f1) * 0.85 : 0);
      const lat = -dx * ed + dy * es - FOOT_LAT[mob];  // + = obstacle to the walker's right
      const need = r + FOOT_HALF[mob] + 0.22;
      if (along > 0 && along < 3.8 && Math.abs(lat) < need) {
        let side;
        if (lat > 0.04) side = -1;           // obstacle to the right: pass on the left
        else if (lat < -0.04) side = 1;
        else side = (a.gd - a.d) * (es >= 0 ? 1 : -1) >= 0 ? 1 : -1; // dead ahead: towards the lane
        let brake = 0;
        if (tramNear && !a.clearing && Math.abs(map.cD[i] - RIDE_D) < BAND + 1.3 && Math.sign(es * side) === Math.sign(RIDE_D - a.d)) {
          // never between a pole and the passing tram: round its far side, or wait behind it
          // (people getting off the track are never held back)
          side = -side;
          if (along < 1.8) brake = (a.v0 / TAU) * Math.min(1.15, (1.8 - along) / 0.9);
        }
        const k = 1.5 * (1 - along / 3.8) * (1 - Math.abs(lat) / need + 0.3);
        fs += -ed * side * k - es * brake; fd += es * side * k - ed * brake;
      }
    }
    // café terraces and platforms ahead: their ends are walls across the path, passed on the
    // open side (the corridor side of a terrace, whichever side is nearer for a platform)
    if (!a.noRect && !standing && sp > 0.2 && Math.abs(es) > 0.3) {
      const side = a.d >= 0 ? 1 : -1, ad = Math.abs(a.d);
      const nr = map.rectsNear(a.s, side);
      for (let q = 0; q < nr; q++) {
        const r = map.rq[q];
        if (a.platformOK && r.kind === 'platform') continue;
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
    this._s0 = a.s;
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
    // the stroller / bicycle: out of poles and trunks too (the person is moved with it)
    if (a.mob && a.fpR > 0) {
      for (let q = 0; q < n; q++) {
        const i = map.qI[q];
        const dx = map.qDS[q] - shift - (a.s - this._s0), dy = map.cD[i] - a.d;
        const r = map.cR[i];
        const pd2 = propPointDist2(a, dx, dy);
        const min = r + a.fpR * 0.85;
        if (pd2 < min * min) {
          const pdist = Math.sqrt(pd2) || 1e-3;
          const push = Math.min(maxC, min - pdist);
          a.s -= ((dx - _foot.s) / pdist) * push; a.d -= ((dy - _foot.d) / pdist) * push;
        }
      }
    }
    const side = a.d >= 0 ? 1 : -1;
    // café terraces and platforms: out through the nearest edge
    if (!a.noRect) { this._rects(a, side, maxC); if (a.mob && a.fpR > 0) this._propRects(a, side, maxC); }
    // facades and cross street mouths
    if (a.inDoor) {
      const dr = a.door;
      const lim = dr && dr.o ? dr.o.d + dr.depth - 0.1 : map.facadeAt(a.s, side) + 0.25;
      // out of the recess again (people coming out of a door): an ordinary walker
      if (a.task !== TASK.ENTER && Math.abs(a.d) < map.facadeAt(a.s, side) - 0.35) a.inDoor = false;
      else {
        // the facade opens only at the door leaf; inside the recess the jambs bound s
        const wall = map.wallAt(a.s, side), ad = Math.abs(a.d);
        const inRange = a.s >= a.doorS0 - 0.02 && a.s <= a.doorS1 + 0.02;
        if (ad > wall && !inRange) {
          // at the corner of the opening: out through the smaller overlap (facade or jamb)
          const ps = a.s < a.doorS0 ? a.doorS0 - a.s : a.s - a.doorS1;
          if (ad - wall < ps) a.d = side * Math.max(wall, ad - maxC);
          else if (a.s < a.doorS0) a.s += Math.min(maxC, ps);
          else a.s -= Math.min(maxC, ps);
        }
        if (Math.abs(a.d) > lim) a.d = side * Math.max(lim, Math.abs(a.d) - maxC);
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
        if (Math.abs(a.d) > line + 22) a.d = side * Math.max(line + 22, Math.abs(a.d) - maxC);
        return;
      }
    }
    const wall = map.wallAt(a.s, side);
    if (Math.abs(a.d) > wall) { a.d = side * Math.max(wall, Math.abs(a.d) - Math.max(maxC, 0.06)); if (a.vd * side > 0) a.vd = 0; }
    // the prop is kept off the facade as well
    if (a.mob && a.fpR > 0) {
      const out = side > 0 ? Math.max(a.fp0d, a.fp1d) : -Math.min(a.fp0d, a.fp1d);
      const lim = map.facadeAt(a.s, side) - 0.06 - a.fpR;
      const over = Math.abs(a.d) + out - lim;
      if (over > 0) a.d -= side * Math.min(Math.max(maxC, 0.06), over);
    }
  }

  /** The ends of a stroller / bicycle against café terraces and platforms. */
  _propRects(a, side, maxC) {
    const map = this.c.map;
    const nr = map.rectsNear(a.s, side);
    const pr = a.fpR * 0.6;
    for (let q = 0; q < nr; q++) {
      const r = map.rq[q];
      if (a.platformOK && r.kind === 'platform') continue;
      for (let e = 0; e < 2; e++) {
        const ps = a.s + (e ? a.fp1s : a.fp0s), pd = a.d + (e ? a.fp1d : a.fp0d);
        const ds = map.rectDS(r, ps), ad = pd * side;
        if (ds < -pr || ds > r.len + pr || ad < r.inner - pr || ad > r.outer + pr) continue;
        const p0 = ds + pr, p1 = r.len + pr - ds, pIn = ad - (r.inner - pr), pOut = r.outer < 90 ? r.outer + pr - ad : 1e9;
        const m = Math.min(p0, p1, pIn, pOut), step = Math.min(maxC, m);
        if (m === p0) a.s -= step; else if (m === p1) a.s += step;
        else if (m === pIn) a.d -= side * step; else a.d += side * step;
      }
    }
  }

  /** Push a body out of café / platform footprints through the edge of least penetration. */
  _rects(a, side, maxC) {
    const map = this.c.map;
    const nr = map.rectsNear(a.s, side);
    for (let q = 0; q < nr; q++) {
      const r = map.rq[q];
      const ds = map.rectDS(r, a.s), ad = Math.abs(a.d);
      if (ds < -RECT_R || ds > r.len + RECT_R || ad < r.inner - RECT_R || ad > r.outer + RECT_R) continue;
      if (a.platformOK && r.kind === 'platform') {
        // up on the platform: only its back kerb and railing are a wall
        const lim = r.outer - RECT_R;
        if (ad > lim) { a.d = side * Math.max(lim, ad - maxC); if (a.vd * side > 0) a.vd = 0; }
        continue;
      }
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
    if (a.mob === MOB.CYCLE) {
      // the bicycle model owns the heading; the cranks turn with the distance ridden
      a.pose = 0;
      if (dist > 1e-5) {
        const cl = humans && humans.cycleLength ? humans.cycleLength(a.appearance) : CYCLE_FALLBACK;
        a.phase = (a.phase + dist / Math.max(1, cl || CYCLE_FALLBACK)) % 1;
      }
      a.look += Math.max(-2.5 * dt, Math.min(2.5 * dt, (a.tramLookT > c.time ? c.lookAtTram(a) : a.lookGoal) - a.look));
      return;
    }
    let target = a.alpha;
    if (sp > 0.28 && !(still && !a.moving)) target = Math.atan2(a.vd, a.vs);
    else if (still) target = a.faceA;
    const diff = wrapAngle(target - a.alpha);
    // a stroller or a bicycle at one's side turns more slowly than a body alone
    const rate = TURN_RATE * (sp > 0.8 ? 1 : 0.7) * (a.mob ? 0.6 : 1);
    const na = wrapAngle(a.alpha + Math.max(-rate * dt, Math.min(rate * dt, diff)));
    if (a.mob) {
      // the prop is never swung into the tram's band
      if (!c.tram.turnBlocked(a, na)) a.alpha = na;
      updateFoot(a);
    } else a.alpha = na;
    a.pose = a.state === ST.SEATED ? 2 : (still && !a.moving && sp < 0.6) ? 1 : 0;
    // gait phase: advance by the distance actually covered / stride length, so feet do not slide
    if ((a.pose === 0 || a.mob) && dist > 1e-5) {
      // the renderer's stride for this body and speed (re-queried only when the speed changes)
      if (Math.abs(sp - a.strideV) > 0.04) {
        a.strideV = sp;
        a.stride = Math.max(0.3, humans && humans.strideLength ? humans.strideLength(a.appearance, Math.max(0.05, sp), c.poseOf(a)) : fallbackStride(sp));
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
