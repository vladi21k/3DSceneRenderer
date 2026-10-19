import { KIND, ST, TASK, MOB, settleShape } from './agent.js';
import { think, desired, timerDone, arrive } from './behaviour.js';
import { AGENT_R, CELL, GRID_D, RANGE_BEHIND, SIMPLE_BEYOND, TURN_RATE, WALL_GAP, RIDE_D, BAND, FOOT, CYCLE_FALLBACK } from './constants.js';
import { updateFoot, footGapQ, FQ, propPointQ, _foot, footBlend, footAt } from './footprint.js';
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
const SEP_GAP = 0.04;          // footprints with a stroller / bicycle are kept this far apart (hard)
const _sw = settleShape({ fp0s: 0, fp0d: 0, fp1s: 0, fp1d: 0, fpR: 0, extLo: 0, extHi: 0, extS: 0 }); // capsule of a facing being tried
const RECT_R = AGENT_R * 0.6;  // body radius against café furniture / platform edges
const PI = Math.PI;

/** Metres per unit of s at a's spot (offset lines on curves; out in a side street s is metric):
 *  worked out once per agent step into a.km, with the route's curvature looked up again only
 *  every half metre along it (it changes over tens of metres). */
function setKm(c, a) {
  if (a.inSide) { a.km = 1; return; }
  if (!(a.kapS - a.s < 0.5 && a.s - a.kapS < 0.5)) {
    // (through route.io when the route has it: no number boxed)
    if (c.io) { c.io[0] = a.s; c.route.sampleIO(); a.kap = c.io[4]; } else a.kap = c.route.curvature(a.s);
    a.kapS = a.s;
  }
  const k = 1 + a.kap * a.d;
  a.km = k > 0.5 ? k : 0.5;
}

export class Steering {
  constructor(c) {
    this.c = c;
    this.nx = Math.ceil((SIMPLE_BEYOND + RANGE_BEHIND + 30) / CELL);
    this.ny = Math.ceil((2 * GRID_D) / CELL);
    this.head = new Int32Array(this.nx * this.ny);
    this.propCell = new Uint8Array(this.nx * this.ny);   // a stroller / bicycle in this cell
    this.des = settleShape({ vs: 0, vd: 0, vmax: 1.6 });
    this.s0 = 0;
    this.frame = 0;
    this.maxC = 0.05;          // largest hard correction of this step (m)
    this.sepLim = 0.05;        // ... of the footprint separation (_separate)
    this.cGathered = false; this.cMoved = 0;   // _constrain: obstacle query still valid, and how far it moved since
    this.cPrevS = 0;           // ... and the agent's s before this step's move
    this.fs = 0; this.fd = 0;  // force of the last _social / _obstacles
    this._s0 = 0;
    this.dtA = 0;              // the step of the agent being moved (s)
    // a cyclist's line and speed (cyclist.rideTarget); g: the line or waypoint its rail guard heads for
    this.ride = settleShape({ d: 0, v: 0, ang: 0.45, hard: false, alpha: 0, avoid: 0, g: 0 });
    this.ride.alpha = null;
    settleShape(this, new Set(['frame', 'nx', 'ny']));
  }

  _cell(a) {
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    if (ix < 0 || ix >= this.nx || iy < 0 || iy >= this.ny) return -1;
    return ix * this.ny + iy;
  }

  buildGrid(agents) {
    this.head.fill(-1);
    this.propCell.fill(0);
    this.s0 = this.c.camU - RANGE_BEHIND - 8;
    for (let i = 0, n = agents.length; i < n; i++) {
      const a = agents[i];
      a.next = -1;
      if (!a.active) continue;
      const k = this._cell(a);
      if (k < 0) continue;
      a.next = this.head[k];
      this.head[k] = a.slot;
      if (a.mob) this.propCell[k] = 1;
    }
  }

  /** Is there a stroller / bicycle in the cells around a (where _separate has work to do)? */
  _propAround(a) {
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    for (let x = Math.max(0, ix - 2); x <= Math.min(this.nx - 1, ix + 2); x++) {
      for (let y = Math.max(0, iy - 2); y <= Math.min(this.ny - 1, iy + 2); y++) if (this.propCell[x * this.ny + y]) return true;
    }
    return false;
  }

  /** Hard separation of footprints: a stroller or a bicycle never overlaps a body or another
   *  stroller / bicycle (capsule against body and capsule against capsule). Each agent of an
   *  overlapping pair takes half of the correction (all of it against someone seated), rate
   *  limited like every hard correction; this.sepLim caps it (a moving bicycle is barely shoved). */
  _separate(a) {
    const lim = this.sepLim;
    if (a.simple || a.state === ST.SEATED) return;
    if (!a.mob && !this._propAround(a)) return;
    const agents = this.c.population.agents;
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    const k = a.km;
    let done = 0;
    for (let x = Math.max(0, ix - 2); x <= Math.min(this.nx - 1, ix + 2); x++) {
      // (two cells either way: a stroller reaches 1.5 m ahead of its pusher)
      for (let y = Math.max(0, iy - 2); y <= Math.min(this.ny - 1, iy + 2); y++) {
        for (let j = this.head[x * this.ny + y]; j >= 0; j = agents[j].next) {
          const b = agents[j];
          if (b === a || !(a.mob || b.mob) || !b.active) continue;
          const dx = (b.s - a.s) * k, dy = b.d - a.d;
          if (dx * dx + dy * dy > 9) continue;
          FQ[0] = dx; FQ[1] = dy;
          const g = footGapQ(a, b);
          if (g.gap >= SEP_GAP) continue;
          // (all of it against someone seated, or held against a pole / wall / terrace)
          const share = b.state === ST.SEATED || b.simple || b.pinned ? 1 : 0.5;
          // (a touch is eased apart at walking pace; only a real overlap is pushed out briskly)
          const want = (SEP_GAP - g.gap) * share;
          const push = Math.min(lim - done, want, g.gap > -0.08 ? 1.5 * this.c.dt : lim);
          if (push <= 0) return;
          a.s += (g.ns * push) / k; a.d += g.nd * push;
          done += push;
        }
      }
    }
  }

  step(dt) {
    const c = this.c, agents = c.population.agents, tram = c.tram, des = this.des;
    this.buildGrid(agents);
    this.frame++;
    const dt1 = dt;
    for (let i = 0, n = agents.length; i < n; i++) {
      const a = agents[i];
      if (!a.active) continue;
      // out in a side street? (its own frame: s is metric there)
      c.side.mark(a);
      // far agents (a few pixels tall, far outside the tram's zone) step at half rate
      a.simple = a.s - c.camU > SIMPLE_BEYOND;
      dt = dt1;
      if (a.simple) { if (((this.frame + a.slot) & 1) === 1) continue; dt = dt1 * 2; }
      a.timer -= dt; a.thinkT -= dt;
      if (a.mob && a.footW < 1) { footBlend(a, c.time); updateFoot(a); }
      // stepping off a bicycle to its left: a short sideways step, nothing else
      this.dtA = dt;   // (this agent's step: half-rate far agents take two frames at once)
      if (a.stepT > 0) { setKm(c, a); this._stepOff(a); continue; }
      if (a.thinkT <= 0) think(c, a);
      if (!a.active) continue;
      if (a.state === ST.SEATED) { this._settle(a); continue; }
      setKm(c, a);
      if (a.timer <= 0 && (a.state === ST.STAND || a.state === ST.WAIT)) timerDone(c, a);
      if (!a.active) continue;
      if (a.mob === MOB.CYCLE) { this._stepCycle(a); continue; }
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
      let sp = Math.sqrt(a.vs * a.vs + a.vd * a.vd);
      const vmax = standing && !a.moving ? 0.6 : des.vmax;
      a.vmaxCur = vmax;
      if (sp > vmax) { a.vs *= vmax / sp; a.vd *= vmax / sp; sp = vmax; }
      // people standing still are not shuffled around by the forces: a dead band
      if (standing && !a.moving && sp < 0.3) { a.vs = 0; a.vd = 0; }

      const prevD = a.d, prevS = a.s;
      const k = a.km;
      a.s += (a.vs / k) * dt;
      a.d += a.vd * dt;
      // hard corrections never move anyone faster than a brisk step
      this.maxC = Math.max(0.02, 2 * Math.min(3.2, Math.max(1.6, vmax)) * dt);
      const s1 = a.s, d1 = a.d;
      this.sepLim = this.maxC;
      this._separate(a);
      const s2 = a.s, d2 = a.d;
      // (numbers handed over in fields: a double argument to a call that is not inlined is boxed)
      this.cGathered = gathered; this.cMoved = a.s - prevS; this.cPrevS = prevS;
      this._constrain(a);
      a.pinned = Math.abs(a.s - s2) + Math.abs(a.d - d2) > 0.004;
      // all corrections together stay within a brisk step too
      const cs = (a.s - s1) * k, cd = a.d - d1, cl = Math.sqrt(cs * cs + cd * cd);
      if (cl > this.maxC) { const f = this.maxC / cl; a.s = s1 + (a.s - s1) * f; a.d = d1 + cd * f; }
      a.prevD = prevD; a.stepDt = dt;
      tram.constrain(a);
      // velocity from the actual motion (constraints included): the gait follows what happened
      const ms = (a.s - prevS) * k, md = a.d - prevD;
      a.vs = ms / dt; a.vd = md / dt;
      const moved = Math.sqrt(ms * ms + md * md);

      // goals that cannot be reached (blocked by a crowd or a wall): give up after a while
      if (a.state === ST.GOTO) {
        if (moved < 0.12 * dt) { a.stuckT += dt; if (a.stuckT > 4) { a.stuckT = 0; arrive(c, a); } } else a.stuckT = Math.max(0, a.stuckT - dt);
      } else if (a.leader && a.state === ST.WALK) {
        // a group member held back (a pole, a narrow passage): fall in behind the leader for a while
        const want = Math.sqrt(des.vs * des.vs + des.vd * des.vd);
        if (want > 0.5 && moved < 0.35 * want * dt) { a.stuckF += dt; if (a.stuckF > 0.7) { a.stuckF = 0; a.singleT = c.time + c.rng.range(4, 7); } }
        else a.stuckF = Math.max(0, a.stuckF - dt);
      }
    }
  }

  /** A cyclist: cyclist.js picks the line (lane, passing offset, lane change, clearing the
   *  tram) and the speed; a bicycle model follows it with a speed-dependent, smoothly
   *  changing turn rate, so the path is a sequence of physically plausible arcs. */
  _stepCycle(a) {
    const dt = this.dtA;
    const c = this.c, tram = c.tram, T = this.ride;
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
    alphaT += T.avoid;
    // (angles wrapped in place, and bikeTurnRate written out: a helper that is not inlined boxes
    // its number argument and result)
    let err = (alphaT - a.alpha + PI) % (2 * PI); if (err < 0) err += 2 * PI; err -= PI;
    // turn rate: lateral acceleration ≤ ~1.9 m/s², radius ≥ 2.3 m, and the rate itself changes
    // smoothly; a little tighter (and slower) when turning to cross a rail steeply
    const wMax = a.rx > 0 ? Math.min(2.6 / vv, vv / 1.5, 1.4) : Math.min(1.9 / vv, vv / 2.3, 1.3);
    let w = Math.max(-wMax, Math.min(wMax, (a.rx >= 2 ? 4 : 2.4) * err));
    const wAcc = a.rx >= 2 ? 5.0 : 3.0;
    w = a.yawW + Math.max(-wAcc * dt, Math.min(wAcc * dt, w - a.yawW));
    let na = (a.alpha + w * dt + PI) % (2 * PI); if (na < 0) na += 2 * PI; na -= PI;
    a.tryA = na;
    if (tram.turnBlockedA(a)) w = 0; else a.alpha = na;
    a.yawW = w;
    updateFoot(a);
    a.vs = v * Math.cos(a.alpha); a.vd = v * Math.sin(a.alpha);
    a.vmaxCur = Math.max(1.6, v);
    a.moving = v > 0.05;
    const prevD = a.d, prevS = a.s;
    const k = a.km;
    a.s += (a.vs / k) * dt;
    a.d += a.vd * dt;
    this.maxC = Math.max(0.02, 2 * Math.max(1.6, v) * dt);
    const s1 = a.s, d1 = a.d;
    this.sepLim = 0.5 * this.maxC;
    this._separate(a);
    const s2 = a.s, d2 = a.d;
    this.cGathered = false; this.cMoved = 0; this.cPrevS = prevS;
    this._constrain(a);
    a.pinned = Math.abs(a.s - s2) + Math.abs(a.d - d2) > 0.004;
    const cs = (a.s - s1) * k, cd = a.d - d1, cl = Math.sqrt(cs * cs + cd * cd);
    const lim = 0.5 * this.maxC;
    if (cl > lim) { const f = lim / cl; a.s = s1 + (a.s - s1) * f; a.d = d1 + cd * f; }
    a.prevD = prevD; a.stepDt = dt;
    tram.constrain(a);
    const ms = (a.s - prevS) * k, md = a.d - prevD;
    a.vs = ms / dt; a.vd = md / dt;
    // held back by a constraint: the bicycle really slows down
    const along = (ms * Math.cos(a.alpha) + md * Math.sin(a.alpha)) / dt;
    if (along < a.bikeV - 0.05) a.bikeV = Math.max(0, along);
  }

  /** Getting off a bicycle on its left side: the rider steps over while the renderer slides the
   *  bicycle from under them to their right, so the bicycle itself stays where it was. */
  _stepOff(a) {
    const dt = this.dtA;
    const c = this.c, T = 0.75, sm = (u) => u * u * (3 - 2 * u);
    const u0 = 1 - a.stepT / T;
    a.stepT = Math.max(0, a.stepT - dt);
    const f = sm(1 - a.stepT / T) - sm(u0);
    const prevS = a.s, prevD = a.d;
    const k = a.km;
    a.s += (a.stepS * f) / k; a.d += a.stepD * f;
    updateFoot(a);
    a.prevD = prevD; a.stepDt = dt;
    c.tram.constrain(a);
    a.vs = ((a.s - prevS) * k) / dt; a.vd = (a.d - prevD) / dt;
    a.moving = true; a.vmaxCur = 1.6;
  }

  /** Would turning a (with its stroller / bicycle) to facing na bring the prop closer into
   *  somebody than it is now (people only step aside from a prop that moves along, not one that
   *  sweeps round)? */
  _swingBlocked(a) {
    const na = a.tryA;
    if (a.fpR <= 0 || a.simple) return false;
    const agents = this.c.population.agents;
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    const k = a.km;
    const o0s = a.fp0s, o0d = a.fp0d, o1s = a.fp1s, o1d = a.fp1d;
    footAt(a, na, _sw);
    let blocked = false;
    for (let x = Math.max(0, ix - 1); x <= Math.min(this.nx - 1, ix + 1) && !blocked; x++) {
      for (let y = Math.max(0, iy - 1); y <= Math.min(this.ny - 1, iy + 1) && !blocked; y++) {
        for (let j = this.head[x * this.ny + y]; j >= 0; j = agents[j].next) {
          const b = agents[j];
          if (b === a || !b.active) continue;
          const dx = (b.s - a.s) * k, dy = b.d - a.d;
          if (dx * dx + dy * dy > 6.25) continue;
          a.fp0s = o0s; a.fp0d = o0d; a.fp1s = o1s; a.fp1d = o1d;
          FQ[0] = dx; FQ[1] = dy;
          const g0 = footGapQ(a, b).gap;
          a.fp0s = _sw.fp0s; a.fp0d = _sw.fp0d; a.fp1s = _sw.fp1s; a.fp1d = _sw.fp1d;
          FQ[0] = dx; FQ[1] = dy;
          const g1 = footGapQ(a, b).gap;
          if (g1 < SEP_GAP && g1 < g0 - 0.002) { blocked = true; break; }
        }
      }
    }
    a.fp0s = o0s; a.fp0d = o0d; a.fp1s = o1s; a.fp1d = o1d;
    return blocked;
  }

  /** Seated: ease the last centimetres onto the chair. */
  _settle(a) {
    const dt = this.dtA;
    a.vs = 0; a.vd = 0;
    if (a.seatS === undefined || a.seatD === undefined) return;
    const es = a.seatS - a.s, ed = a.seatD - a.d, e = Math.sqrt(es * es + ed * ed);
    if (e < 1e-3) return;
    const st = Math.min(1, (0.5 * dt) / e);
    a.s += es * st; a.d += ed * st;
  }

  // ---------------------------------------------------------------- neighbours
  _social(a, standing) {
    let fs = 0, fd = 0;
    const ix = Math.floor((a.s - this.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    const sp = Math.sqrt(a.vs * a.vs + a.vd * a.vd);
    const es = sp > 0.1 ? a.vs / sp : Math.cos(a.alpha), ed = sp > 0.1 ? a.vd / sp : Math.sin(a.alpha);
    const agents = this.c.population.agents;
    const L = a.leader || a;
    const km = a.km;   // metres per unit of s here
    // (strollers and bicycles reach further: their neighbours two cells away across the street too)
    const yr = a.mob || this._propAround(a) ? 2 : 1;
    for (let x = ix - 2; x <= ix + 2; x++) {
      if (x < 0 || x >= this.nx) continue;
      for (let y = iy - yr; y <= iy + yr; y++) {
        if (y < 0 || y >= this.ny) continue;
        for (let j = this.head[x * this.ny + y]; j >= 0; j = agents[j].next) {
          const b = agents[j];
          if (b === a) continue;
          const dx = (b.s - a.s) * km, dy = b.d - a.d;
          const d2 = dx * dx + dy * dy;
          if (d2 > 16 || d2 < 1e-6) continue;
          // people talking in a ring are walked round, not through (anticipated like a person,
          // the whole ring at once: from its first member, the leader)
          if (!standing && !a.mob && sp >= 0.3 && b.task === TASK.CHAT && b.state === ST.STAND && !b.leader && b.nFollow > 0 && L !== b) {
            this._chatCircle(b);
            const gx = (b.ccS - a.s) * km, gy = b.ccD - a.d;
            const tc = (gx * a.vs + gy * a.vd) / (sp * sp);
            if (tc > 0 && tc < 3) {
              const cx = gx - a.vs * tc, cy = gy - a.vd * tc, cd = Math.sqrt(cx * cx + cy * cy);
              const reach = b.ccR + AGENT_R + 0.35;
              if (cd < reach) {
                const k = 2.2 * (1 - tc / 3) * (reach - cd) / reach;
                if (cd < 0.08) { fs += -ed * k; fd += es * k; } else { fs += (-cx / cd) * k; fd += (-cy / cd) * k; }
              }
            }
          }
          const dist = Math.sqrt(d2);
          let nx = -dx / dist, ny = -dy / dist; // from b to a
          let gap = dist - R2;
          // strollers and bicycles: the gap between the whole footprints
          if ((a.mob || b.mob) && dist < 3.4) { FQ[0] = dx; FQ[1] = dy; const g = footGapQ(a, b); gap = g.gap; nx = g.ns; ny = g.nd; }
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
          if (a.mob || b.mob) {
            // a stroller / bicycle: the gap between the whole footprints at the closest approach
            // (facings held), passed with a margin that grows with the speed of the encounter
            FQ[0] = cx; FQ[1] = cy;
            const g = footGapQ(a, b), want = 0.3 + 0.08 * Math.sqrt(vv);
            if (g.gap > want) continue;
            const k = 1.9 * (1 - tc / 3) * Math.min(1, (want - g.gap) / 0.55);
            fs += g.ns * k - ed * k * 0.3; fd += g.nd * k + es * k * 0.3;
            continue;
          }
          const cd = Math.sqrt(cx * cx + cy * cy);
          const reach = 0.85;
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

  /** The ring a conversation stands in (leader b): centre (b.ccS, b.ccD) and radius b.ccR to the
   *  outermost member, worked out once per frame. */
  _chatCircle(b) {
    if (b.ccN === this.frame) return;
    b.ccN = this.frame;
    const F = b.followers;
    let cs = b.s, cd = b.d;
    for (let i = 0; i < F.length; i++) { cs += F[i].s; cd += F[i].d; }
    cs /= F.length + 1; cd /= F.length + 1;
    const km = b.km;
    let r = (b.s - cs) * km * (b.s - cs) * km + (b.d - cd) * (b.d - cd);
    for (let i = 0; i < F.length; i++) {
      const ds = (F[i].s - cs) * km, dd = F[i].d - cd, q = ds * ds + dd * dd;
      if (q > r) r = q;
    }
    b.ccS = cs; b.ccD = cd; b.ccR = Math.sqrt(r);
  }

  // ---------------------------------------------------------------- obstacles
  _obstacles(a, standing) {
    const c = this.c, map = c.map;
    let fs = 0, fd = 0;
    // with the tram near, obstacles by the ride track are passed on the side away from it
    const tramNear = c.tram.near(a);
    const U = a.uI >= 0 ? c.tram.unitById(a.uI) : null;   // an oncoming unit near too
    const n = map.gatherAt(a, 3.5);
    const sp = Math.sqrt(a.vs * a.vs + a.vd * a.vd), des = this.des, dsp = Math.sqrt(des.vs * des.vs + des.vd * des.vd);
    // heading for the look-ahead: the actual motion, or where they want to go when (nearly) stopped
    let es = 0, ed = 0;
    if (sp > 0.2) { es = a.vs / sp; ed = a.vd / sp; } else if (dsp > 0.2) { es = des.vs / dsp; ed = des.vd / dsp; }
    const heading = sp > 0.2 || dsp > 0.2;
    const goalD = a.clearing ? a.clearTo : a.gd;
    const mob = a.mob, F = FOOT[mob];
    for (let q = 0; q < n; q++) {
      const i = map.qI[q];
      const dx = map.qDS[q], dy = map.cD[i] - a.d, r = map.cR[i];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const gap = dist - r - AGENT_R;
      if (mob && F) {
        // the stroller / bicycle is kept off the pole too
        FQ[0] = dx; FQ[1] = dy; propPointQ(a);
        const pdist = Math.sqrt(_foot.q), pg = pdist - r - a.fpR;
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
          // (a group member held back slides the way it wants to go: away from a dead end)
          const held = a.leader && (a.singleT > c.time || a.stuckF > 0.3) && Math.abs(des.vs) > 0.1;
          const away = held ? Math.sign(des.vs) : dx > 0.02 ? -1 : dx < -0.02 ? 1 : (a.dir || 1);
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
        } else if (U && !a.clearing && Math.abs(map.cD[i] - U.d) < U.UB + 1.3 && Math.sign(es * side) === Math.sign(U.d - a.d)) {
          // (the same beside an oncoming unit's track: round the pole on the far side from it)
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
      const nr = map.rectsNearA(a, side);
      for (let q = 0; q < nr; q++) {
        const r = map.rq[q];
        if (a.platformOK && r.kind === 'platform') continue;
        map.rectDSA(r, a);
        const ds = map.R[2];
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
  /** this.cGathered: the obstacle query of this step (around the position before the move, which
   *  was this.cMoved metres ago along s) is still in map.q*; this.cPrevS: s before the move.
   *  Corrections are rate limited. */
  _constrain(a) {
    const c = this.c, map = c.map, maxC = this.maxC, gathered = this.cGathered;
    this._s0 = a.s;
    // circle obstacles: resolve overlaps
    const n = gathered ? map.qN : map.gatherAt(a, 1.2);
    const shift = gathered ? this.cMoved : 0;
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
        FQ[0] = dx; FQ[1] = dy; propPointQ(a);
        const pd2 = _foot.q;
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
    if (!a.noRect) { this._rects(a, side); if (a.mob && a.fpR > 0) this._propRects(a, side); }
    // facades and cross street mouths
    if (a.inDoor) {
      const dr = a.door;
      // (facadeAt / wallAt at a.s through map.R: nothing boxed)
      map.facadeA(a, side);
      const fac = map.R[0], wall = map.R[1];
      const lim = dr && dr.o ? dr.o.d + dr.depth - 0.1 : fac + 0.25;
      // out of the recess again (people coming out of a door): an ordinary walker
      if (a.task !== TASK.ENTER && !(a.task === TASK.SERVE && a.step === 3) && Math.abs(a.d) < fac - 0.35) { a.inDoor = false; a.doorOutT = c.time; }
      else {
        // the facade opens only at the door leaf; inside the recess the jambs bound s
        const ad = Math.abs(a.d);
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
    const m = map.mouthAtAS(a, side);
    if (m) {
      // inside the side street opening the side walls bound s; elsewhere the facade bounds d
      // (map.mouthLine and c.unwrap(m.s) worked out in place: nothing boxed)
      const line = side > 0 ? m._crowdLineR : m._crowdLineL;
      const L = c.route.length;
      let mw = m.s % L; if (mw < 0) mw += L;
      let mdd = mw - c.camW; if (mdd > L / 2) mdd -= L; if (mdd < -L / 2) mdd += L;
      const ms = c.camU + mdd, half = m.width / 2 - 0.55;
      // (well inside the side street its walls bound s whatever happened before)
      if (Math.abs(a.d) > line - WALL_GAP && (Math.abs(a.s - ms) < half + 0.4 || a.inSide && a.sideX > 1)) {
        if (a.s < ms - half) a.s += Math.min(maxC, ms - half - a.s); else if (a.s > ms + half) a.s -= Math.min(maxC, a.s - ms - half);
        const deep = line + (m.depth || 60) + 40;
        if (Math.abs(a.d) > deep) a.d = side * Math.max(deep, Math.abs(a.d) - maxC);
        // (up the side street people keep to its sidewalks)
        c.side.roadPushA(a);
        return;
      }
    }
    map.facadeA(a, side);
    const wall = map.R[1], ad = Math.abs(a.d);
    if (ad > wall) {
      // the building line steps forward here (the next lot's face, a corner pier): coming along
      // the street from where it stood further back (out of a recessed shop door, along a recessed
      // lot), the step's side face bounds s: the walker stays on this side of it until it is out
      // past the line, rather than being drawn through the corner
      map.qS = this.cPrevS; map.facadeQS(side);
      if (map.R[3] === 0 && ad <= map.R[0] - WALL_GAP + 0.02 && this.cPrevS !== a.s) {
        a.s = this.cPrevS;
        if (a.vs * (a.s - this._s0) < 0) a.vs = 0;
      } else { a.d = side * Math.max(wall, ad - Math.max(maxC, 0.06)); if (a.vd * side > 0) a.vd = 0; }
    }
    // the prop is kept off the facade as well
    if (a.mob && a.fpR > 0) {
      // (at the prop's own s: facades step forward at lot boundaries)
      let over = 0;
      for (let e = 0; e < 2; e++) {
        map.qS = a.s + (e ? a.fp1s : a.fp0s);
        const pd = side * (a.d + (e ? a.fp1d : a.fp0d));
        map.facadeQS(side);
        if (map.R[3] > 0) continue;
        const o = pd + a.fpR - (map.R[0] - 0.06);
        if (o > over) over = o;
      }
      if (over > 0) a.d -= side * Math.min(Math.max(maxC, 0.06), over);
    }
  }

  /** The ends of a stroller / bicycle against café terraces and platforms. */
  _propRects(a, side) {
    const map = this.c.map, maxC = this.maxC;
    const nr = map.rectsNearA(a, side);
    const pr = a.fpR * 0.6;
    for (let q = 0; q < nr; q++) {
      const r = map.rq[q];
      if (a.platformOK && r.kind === 'platform') continue;
      for (let e = 0; e < 2; e++) {
        const ps = a.s + (e ? a.fp1s : a.fp0s), pd = a.d + (e ? a.fp1d : a.fp0d);
        // (map.rectDS(r, ps): the loop distance worked out in place)
        const L = map.L;
        let w = ps % L; if (w < 0) w += L;
        let ds = w - r.s0; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
        const ad = pd * side;
        if (ds < -pr || ds > r.len + pr || ad < r.inner - pr || ad > r.outer + pr) continue;
        const p0 = ds + pr, p1 = r.len + pr - ds, pIn = ad - (r.inner - pr), pOut = r.outer < 90 ? r.outer + pr - ad : 1e9;
        const m = Math.min(p0, p1, pIn, pOut), step = Math.min(maxC, m);
        if (m === p0) a.s -= step; else if (m === p1) a.s += step;
        else if (m === pIn) a.d -= side * step; else a.d += side * step;
      }
    }
  }

  /** Push a body out of café / platform footprints through the edge of least penetration. */
  _rects(a, side) {
    const map = this.c.map, maxC = this.maxC;
    const nr = map.rectsNearA(a, side);
    for (let q = 0; q < nr; q++) {
      const r = map.rq[q];
      map.rectDSA(r, a);
      const ds = map.R[2], ad = Math.abs(a.d);
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
  /** a.moveDist: horizontal distance the figure actually moved since the last output (dt: the
   *  crowd's frame step). */
  animate(a, humans) {
    const c = this.c, dt = c.dt, dist = a.moveDist;
    const still = a.state === ST.SEATED || a.state === ST.PLATFORM || a.state === ST.STAND || a.state === ST.WAIT;
    // smoothed actual speed (the steering velocity is the real displacement rate)
    const spRaw = a.state === ST.SEATED ? 0 : Math.sqrt(a.vs * a.vs + a.vd * a.vd);
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
      let lt = a.lookGoal;
      if (a.tramLookT > c.time) { c.lookAtTram(a); lt = a.lookTram; }
      a.look += Math.max(-2.5 * dt, Math.min(2.5 * dt, lt - a.look));
      return;
    }
    let target = a.alpha;
    if (sp > 0.28 && !(still && !a.moving)) {
      target = Math.atan2(a.vd, a.vs);
      // pushing a stroller / a bicycle one steers rather than sidesteps: along a lane the
      // facing stays near the walking direction
      // (far off the lane, e.g. just out of a side street, they head for it at a real angle)
      if (a.mob && a.state === ST.WALK && !a.clearing && a.uturnT <= 0) {
        const base = a.dir > 0 ? 0 : PI, lim = Math.abs(a.laneT - a.d) > 0.9 && !a.leader ? 1.15 : 0.45;
        let dv = (target - base + PI) % (2 * PI); if (dv < 0) dv += 2 * PI; dv -= PI;
        target = base + (dv < -lim ? -lim : dv > lim ? lim : dv);
      }
    } else if (still) target = a.faceA;
    // (angles wrapped in place: a helper that is not inlined boxes its number argument and result)
    let diff = (target - a.alpha + PI) % (2 * PI); if (diff < 0) diff += 2 * PI; diff -= PI;
    // a stroller or a bicycle at one's side turns more slowly than a body alone
    const rate = TURN_RATE * (sp > 0.8 ? 1 : 0.7) * (a.mob ? 0.6 : 1);
    const turn = rate * dt, dTurn = diff < -turn ? -turn : diff > turn ? turn : diff;
    let na = (a.alpha + dTurn + PI) % (2 * PI); if (na < 0) na += 2 * PI; na -= PI;
    if (a.mob) {
      // the prop is never swung into the tram's band, nor into somebody standing or sitting there
      a.tryA = na;
      if (!c.tram.turnBlockedA(a) && !this._swingBlocked(a)) a.alpha = na;
      updateFoot(a);
    } else a.alpha = na;
    a.pose = a.state === ST.SEATED ? 2 : (still && !a.moving && sp < 0.6) ? 1 : 0;
    // gait phase: advance by the distance actually covered / stride length, so feet do not slide
    if ((a.pose === 0 || a.mob) && dist > 1e-5) {
      // the renderer's stride for this body and speed: asked for at the ends of the 0.2 m/s band
      // the speed is in, and interpolated between them (re-asked only when the band or the pose
      // changes: a call that is not inlined boxes the speed and the stride)
      const pose = c.poseOf(a), b = Math.floor(sp * 5);
      if (b !== a.strideB || pose !== a.strideP) {
        a.strideB = b; a.strideP = pose;
        const v0 = b * 0.2;
        if (humans && humans.strideLength) {
          a.strideS0 = humans.strideLength(a.appearance, v0 > 0.05 ? v0 : 0.05, pose);
          a.strideS1 = humans.strideLength(a.appearance, v0 + 0.2, pose);
        } else { a.strideS0 = fallbackStride(v0 > 0.05 ? v0 : 0.05); a.strideS1 = fallbackStride(v0 + 0.2); }
      }
      const st = a.strideS0 + (a.strideS1 - a.strideS0) * (sp * 5 - b);
      a.stride = st > 0.3 ? st : 0.3;
      a.phase = (a.phase + dist / a.stride) % 1;
    }
    // gaze: the tram when it rings or when waiting to cross, otherwise idle glances
    let lookT = a.lookGoal;
    if (a.tramLookT > c.time || (a.state === ST.WAIT && a.task === TASK.CROSS)) { c.lookAtTram(a); lookT = a.lookTram; }
    const ld = lookT - a.look;
    a.look += Math.max(-2.5 * dt, Math.min(2.5 * dt, ld));
  }
}

/** Stride (two steps) when the renderer does not provide one: ~1.5 m at 1.4 m/s. */
export function fallbackStride(v) { return 1.48 * (0.55 + 0.32 * v); }
