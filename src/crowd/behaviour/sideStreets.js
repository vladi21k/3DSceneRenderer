import * as THREE from 'three';
import { SIDE_LOT_START } from '../../world/layout.js';
import { KIND, ST, TASK, LANE, settleShape } from './agent.js';
import { PAUSE } from './stance.js';

// The side streets. People walk them the way they do the main street, in route coordinates:
// inside a cross street's opening, beyond the main building line, s runs across the side
// street (metres from its centre line, `a`) and |d| − hw along it (`x`, metres from the main
// building line). Positions there are drawn in the side street's own frame (it leaves the main
// street at an angle, and keeps the junction's level beyond its ramp), blended in over the
// first BLEND metres so nobody jumps at the corner.
//
// Each side street near the camera keeps light two-way traffic on its sidewalks, 50-60 m deep:
// people coming out (spawned deep in it, out of sight) who join the main street, people going in
// (main-street walkers turning into it, or out of sight already) who walk on 40-60 m and are gone
// once out of sight, the odd pair, and somebody standing at a doorway. Nobody walks the side
// street's carriageway (parked cars stand along its kerbs).

const BLEND = 4;            // metres beyond the main building line over which the frame turns
const KERB_W = 0.16;
const KERB_H = 0.12;
const NEAR = [-30, 420];    // side streets populated within this range of the camera (mouth s, m)
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const PI = Math.PI;

export class SideStreets {
  constructor(c) {
    this.c = c;
    this.geo = new Map();
    this.t = 0;
    this.n = new Map();       // people out in each side street (counted every maintenance pass)
    this.stats = settleShape({ spawnIn: 0, spawnOut: 0, spawnStand: 0, gone: 0, fail: 0 }, new Set(['spawnIn', 'spawnOut', 'spawnStand', 'gone', 'fail']));
    settleShape(this);
  }

  /** Frame and levels of cross street cs on `side` (cached). */
  get(cs, side) {
    // (keyed by the cross street object: a number key would be boxed on every lookup)
    let e = this.geo.get(cs);
    if (!e) { e = [null, null]; this.geo.set(cs, e); }
    let g = e[side > 0 ? 1 : 0];
    if (g) return g;
    const key = cs.s * 4 + side;
    const c = this.c, route = c.route, L = c.layout;
    // the street module's own mouth frame and paving (sidewalks, kerbs, crown, the ramp up to the
    // side street's ground) when it offers them; else the same frame worked out here
    const st = c.app.systems && c.app.systems.street;
    let M = null;
    if (st && !st.disabled && typeof st.mouth === 'function') { try { M = st.mouth(cs, side); } catch (e) { M = null; } }
    const street = M && typeof st.sideHeightAt === 'function' ? st : null;
    const smp = route.sample(cs.s, {});
    const hw = M ? M.hw : L.halfWidth(cs.s, side);
    const start = M ? M.start : route.toWorld(cs.s, side * hw, 0, new THREE.Vector3());
    const along = M ? M.along : smp.tanH.clone();
    let dirOut = M ? M.dirOut : null;
    if (!dirOut) {
      const out = smp.right.clone().multiplyScalar(side);
      const ca = Math.cos(cs.angle || 0), sa = Math.sin(cs.angle || 0);
      // (rotated about +Y like Vector3.applyAxisAngle: the street module's mouth frame)
      dirOut = new THREE.Vector3(out.x * ca + out.z * sa, 0, -out.x * sa + out.z * ca);
    }
    const n = new THREE.Vector3(-along.z, 0, along.x);
    if (n.dot(dirOut) < 0) n.negate();
    const half = M && M.half > 0 ? M.half : cs.width / 2;
    const sw = M && M.sw > 0 ? M.sw : Math.min(2.6, Math.max(1.6, cs.width * 0.2));
    const road = M && M.road > 0 ? M.road : half - sw;
    // main paving height along the mouth line (every half metre), which the side street ramps
    // from to the junction's level over SIDE_LOT_START metres (street/crossStreets.js)
    const base = [];
    if (!street) {
      for (let a = -half - 0.5; a <= half + 0.51; a += 0.5) {
        const s = cs.s + a;
        let y;
        try { y = st && st.heightAt ? route.elevation(s) + st.heightAt(s, side * hw) : route.toWorld(s, side * hw, 0, _v).y; } catch (e) { y = route.toWorld(s, side * hw, 0, _v).y; }
        base.push(y);
      }
    }
    g = { cs, side, hw, start, along, dirOut, n, half, sw, road, base, level: start.y, len: (cs.depth || 60) + 16 + 30, line: c.map.mouthLine(cs, side), key, street };
    e[side > 0 ? 1 : 0] = g;
    return g;
  }

  /** Paving height (world y) at (a, x) of side street g. */
  height(g, a, x) {
    if (g.street) return g.street.sideHeightAt(g.cs, g.side, a, x);
    const i = Math.max(0, Math.min(g.base.length - 1.001, (a + g.half + 0.5) / 0.5));
    const i0 = Math.floor(i), f = i - i0;
    const b = g.base[i0] + (g.base[Math.min(g.base.length - 1, i0 + 1)] - g.base[i0]) * f;
    let y = b + (g.level - b) * Math.min(1, Math.max(0, x) / SIDE_LOT_START);
    // the carriageway (a kerb down), from a few metres in
    const aa = Math.abs(a);
    if (aa < g.road) y += (-KERB_H + 0.022 * (1 - (aa / g.road) ** 2)) * smooth((x - 2.5) / 5);
    return y;
  }

  /** The side street a point (unwrapped s, signed d) is out in: {g, a, x} or null. */
  locate(s, d, out) {
    const side = d >= 0 ? 1 : -1;
    const cs = this.c.map.mouthAt(s, side);
    if (!cs) return null;
    const g = this.get(cs, side);
    const x = side * d - g.hw;
    if (x <= 0) return null;
    const a = s - this.c.unwrap(cs.s);
    if (Math.abs(a) > g.half + 1) return null;
    out.g = g; out.a = a; out.x = x;
    return out;
  }

  /** locate for agent a, from its own s and d: the mouth from its 1 m sample and the loop
   *  distance worked out in place (a double handed to or returned from a call that is not inlined
   *  is boxed, and this runs per agent and frame near the mouths). */
  locateA(a, out) {
    const c = this.c, side = a.d >= 0 ? 1 : -1;
    const cs = c.map.mouthAtA(a);
    if (!cs) return null;
    const g = this.get(cs, side);
    const x = side * a.d - g.hw;
    if (x <= 0) return null;
    // a.s − c.unwrap(cs.s)
    const L = c.route.length;
    let w = cs.s % L; if (w < 0) w += L;
    let dd = w - c.camW; if (dd > L / 2) dd -= L; if (dd < -L / 2) dd += L;
    const da = a.s - c.camU - dd;
    if (da > g.half + 1 || da < -(g.half + 1)) return null;
    out.g = g; out.a = da; out.x = x;
    return out;
  }

  /** route.toWorld that follows the side streets. */
  toWorld(s, d, h, out) {
    const route = this.c.route, io = this.c.io;
    // (through route.io where there is one: no number handed on to box)
    if (io) { io[0] = s; io[1] = d; io[2] = h; route.toWorldIO(out); } else route.toWorld(s, d, h, out);
    const L = this.locate(s, d, _loc);
    if (!L) return out;
    const g = L.g, b = smooth(L.x / BLEND);
    const px = g.start.x + g.along.x * L.a + g.dirOut.x * L.x, pz = g.start.z + g.along.z * L.a + g.dirOut.z * L.x;
    const py = this.height(g, L.a, L.x) + h;
    out.x += (px - out.x) * b; out.y += (py - out.y) * b; out.z += (pz - out.z) * b;
    return out;
  }

  /** toWorld(a.s, a.d, a.h, out) for agent a (its numbers read from its fields: nothing boxed). */
  toWorldA(a, out) {
    const c = this.c, route = c.route, io = c.io;
    if (io) { io[0] = a.s; io[1] = a.d; io[2] = a.h; route.toWorldIO(out); } else route.toWorld(a.s, a.d, a.h, out);
    const L = this.locateA(a, _loc);
    if (!L) return out;
    const g = L.g, b = smooth(L.x / BLEND);
    const px = g.start.x + g.along.x * L.a + g.dirOut.x * L.x, pz = g.start.z + g.along.z * L.a + g.dirOut.z * L.x;
    const py = this.height(g, L.a, L.x) + a.h;
    out.x += (px - out.x) * b; out.y += (py - out.y) * b; out.z += (pz - out.z) * b;
    return out;
  }

  /** heading(a.s, a.d, a.alpha) for agent a → a.heading (no number argument or result to box). */
  headingA(a) {
    const c = this.c;
    let rh;
    if (c.io) { c.io[0] = a.s; c.route.sampleIO(); rh = c.io[3]; } else rh = c.route.heading(a.s);
    const base = rh - PI / 2 - a.alpha;
    const L = this.locateA(a, _loc);
    if (!L) { a.heading = base; return; }
    const g = L.g, ca = Math.cos(a.alpha), sa = Math.sin(a.alpha) * g.side;
    const fx = g.along.x * ca + g.dirOut.x * sa, fz = g.along.z * ca + g.dirOut.z * sa;
    const hs = Math.atan2(-fx, -fz);
    let dh = hs - base;
    dh = ((dh + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI;
    a.heading = base + dh * smooth(L.x / BLEND);
  }

  /** World yaw (three.js, 0 faces −Z) of facing alpha at (s, d): turned into the side street's frame there. */
  heading(s, d, alpha) {
    const base = this.c.route.heading(s) - PI / 2 - alpha;
    const L = this.locate(s, d, _loc);
    if (!L) return base;
    const g = L.g, ca = Math.cos(alpha), sa = Math.sin(alpha) * g.side;
    const fx = g.along.x * ca + g.dirOut.x * sa, fz = g.along.z * ca + g.dirOut.z * sa;
    const hs = Math.atan2(-fx, -fz);
    let dh = hs - base;
    dh = ((dh + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI;
    return base + dh * smooth(L.x / BLEND);
  }

  /** Is a figure at (s, d) out in a side street hidden from the camera: out of the view, or behind
   *  the corner facades (the line of sight does not pass through the side street's opening)?
   *  `margin`: how far past the opening's edges the sight line must stay (a body's half width). */
  hidden(s, d, margin = 0.35) {
    const c = this.c, vis = c.vis;
    const L = this.locate(s, d, _loc2);
    if (!L) return vis.hidden(s, d);
    if (!vis.inView(s, d)) return true;
    const g = L.g, cam = vis.camPos;
    this.toWorld(s, d, 1.0, _w);
    const dc = (cam.x - g.start.x) * g.n.x + (cam.z - g.start.z) * g.n.z;
    const dp = (_w.x - g.start.x) * g.n.x + (_w.z - g.start.z) * g.n.z;
    if (dc >= -0.2 || dp <= 0) return false;            // (the camera itself up the side street)
    const t = dc / (dc - dp);
    const qx = cam.x + (_w.x - cam.x) * t, qz = cam.z + (_w.z - cam.z) * t;
    const aq = (qx - g.start.x) * g.along.x + (qz - g.start.z) * g.along.z;
    return Math.abs(aq) > g.half + margin;
  }

  /** A whole person (and the children with them) out in a side street hidden from the camera. */
  groupHidden(a) {
    if (!this.hidden(a.s, a.d, 0.6)) return false;
    for (const f of a.followers) if (!this.hidden(f.s, f.d, 0.6)) return false;
    return true;
  }

  /** A walking line on one of the side street's sidewalks (offset a from its centre line). */
  laneA(g, r, e = 0) {
    const sgn = e || (r.chance(0.5) ? 1 : -1);
    const lo = g.road + KERB_W + 0.3, hi = g.half - 0.4;
    return sgn * (hi > lo ? lo + (hi - lo) * r.range(0.1, 0.9) : (lo + hi) / 2);
  }

  /** Per frame, for each agent: out in a side street? (sets a.inSide / a.sideX). */
  mark(a) {
    // (nearly everybody is nowhere near a side street: settled without a number argument)
    if (!this.c.map.mouthAtA(a)) { a.inSide = false; a.sideX = 0; return null; }
    const L = this.locateA(a, _loc3);
    a.inSide = !!L; a.sideX = L ? L.x : 0;
    return L;
  }

  /** roadPush applied to a.s, with the step limit read from the steering (no number argument or
   *  result to box). */
  roadPushA(a) {
    if (!a.inSide || a.sideX < 3.2 || a.mob === 2) return;
    const L = this.locateA(a, _loc3);
    if (!L) return;
    const lim = L.g.road + KERB_W + 0.22, aa = Math.abs(L.a);
    if (aa >= lim) return;
    a.s += (L.a >= 0 ? 1 : -1) * Math.min(this.c.steering.maxC, 1.0 * this.c.dt, lim - aa);
  }

  /** Off the carriageway (kept to the sidewalks a few metres in): the push this step (signed s), or 0. */
  roadPush(a, maxC) {
    if (!a.inSide || a.sideX < 3.2 || a.mob === 2) return 0;   // (cyclists ride the carriageway)
    const L = this.locateA(a, _loc3);
    if (!L) return 0;
    const lim = L.g.road + KERB_W + 0.22, aa = Math.abs(L.a);
    if (aa >= lim) return 0;
    // (a step up onto the kerb at walking pace, never a shove)
    return (L.a >= 0 ? 1 : -1) * Math.min(maxC, 1.0 * this.c.dt, lim - aa);
  }

  // ---------------------------------------------------------------- population
  /** The cross streets (and sides) whose mouths are near the camera. */
  _near(fn) {
    const c = this.c;
    for (const cs of c.layout.crossStreets) {
      const rel = c.unwrap(cs.s) - c.camU;
      if (rel < NEAR[0] || rel > NEAR[1]) continue;
      for (const side of cs.side === 0 ? [-1, 1] : [cs.side]) fn(cs, side, rel);
    }
  }

  /** How many people a side street carries out to 55 m (a steady figure of its own: 5-11, the
   *  busier near the main street's busy stretch). */
  target(cs, side) {
    const r = this.c.featureRng('side', Math.round(cs.s), side);
    return Math.round(5 + 6 * r.next());
  }

  /** Initial street: the side streets near the camera with their people already about. */
  fill() {
    const c = this.c, r = c.rng;
    this._near((cs, side) => {
      const g = this.get(cs, side), want = this.target(cs, side);
      for (let k = 0, guard = 0; k < want && guard < want * 3; guard++) {
        const x = r.range(5, 55), u = r.next();
        const a = u < 0.15 ? this._stander(g, x) : this._walker(g, x, u < 0.6 ? -1 : 1);
        if (a) k += 1 + a.nFollow;
      }
    });
  }

  /** Keeps the side streets near the camera at their head counts: new people out of sight deep in
   *  them (walking out, or a few walking further in), now and then somebody at a doorway. */
  maintain(dt) {
    const c = this.c, pop = c.population;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.4;
    // head counts per side street
    this.n.clear();
    for (const a of pop.agents) {
      if (!a.active || !a.inSide || a.sideX < 2.5) continue;
      const L = this.locateA(a, _loc);
      if (L) this.n.set(L.g, (this.n.get(L.g) || 0) + 1);
    }
    if (pop.free.length < 24) return;
    const r = c.rng;
    let spawned = 0;
    this._near((cs, side) => {
      if (spawned >= 2) return;
      const g = this.get(cs, side), have = this.n.get(g) || 0, want = this.target(cs, side);
      if (have >= want) return;
      const u = r.next();
      let a = null;
      if (u < 0.12) { a = this._stander(g, r.range(16, 50), true); if (a) this.stats.spawnStand++; }
      else if (u < 0.82) { a = this._walker(g, r.range(36, 56), -1, true); if (a) this.stats.spawnIn++; }
      else { a = this._walker(g, r.range(14, 50), 1, true); if (a) this.stats.spawnOut++; }
      if (a) spawned++; else this.stats.fail++;
    });
  }

  /** A walker (and maybe a companion or two) x metres up side street g on a sidewalk, walking
   *  out to the main street (dir −1) or further in (dir +1). hidden: only where nobody sees it. */
  _walker(g, x, dir, hidden = false) {
    const c = this.c, r = c.rng, pop = c.population;
    const ms = c.unwrap(g.cs.s), side = g.side;
    const aL = this.laneA(g, r);
    const sp = ms + aL, dp = side * (g.hw + x);
    if (hidden && !this.hidden(sp, dp, 0.6)) return null;
    const a = pop.spawnWalker(sp, side, 1, { d: dp, lane: LANE.SIDE, force: true, group: 0.28, src: 'sideStreet' });
    if (!a) return null;
    a.mouth = g.cs; a.state = ST.GOTO; a.vs = 0; a.vd = 0; a.spawnHidden = true;
    a.sideA = aL;
    // facing along the side street, companions beside or a step behind on the same sidewalk
    a.alpha = (dir > 0 ? 1 : -1) * side * PI / 2;
    const inward = Math.sign(-aL) || 1;
    for (const f of [...a.followers]) {
      const k = a.followers.indexOf(f);
      f.s = sp + inward * (k === 0 ? 0.62 : 0.3);
      f.d = dp + side * (k === 0 ? -dir * 0.1 : -dir * 0.9);
      f.alpha = a.alpha; f.vs = 0; f.vd = 0;
      if (Math.abs(f.s - ms) > g.half - 0.35 || (hidden && !this.hidden(f.s, f.d, 0.6)) || pop.propClash(f)) pop._unspawn(f);
    }
    a.nFollow = a.followers.length;
    if (dir < 0) {
      // out to the main street: along the sidewalk to the mouth, then onto the main sidewalk
      a.task = TASK.EMERGE; a.step = -1;
      a.gs = ms + aL; a.gd = side * (g.hw + 2.0); a.gTol = 0.6;
    } else {
      a.task = TASK.SIDE_OUT; a.step = 2;
      a.sideEnd = Math.min(g.len - 6, Math.max(x + 12, r.range(40, 60)));
      a.gs = ms + aL; a.gd = side * (g.hw + a.sideEnd); a.gTol = 0.8;
    }
    return a;
  }

  /** Somebody standing at a doorway of side street g, x metres in (facing across the street). */
  _stander(g, x, hidden = false) {
    const c = this.c, r = c.rng, pop = c.population;
    const ms = c.unwrap(g.cs.s), side = g.side, e = r.chance(0.5) ? 1 : -1;
    const sp = ms + e * (g.half - 0.45), dp = side * (g.hw + x);
    if (hidden && !this.hidden(sp, dp, 0.6)) return null;
    const a = pop.spawnWalker(sp, side, 1, { d: dp, lane: LANE.SIDE, force: true, group: 0, src: 'sideStreet', still: true });
    if (!a) return null;
    a.mouth = g.cs; a.sideA = e * (g.half - 0.45);
    a.task = TASK.PAUSE; a.step = 1; a.state = ST.STAND; a.timer = r.range(20, 90); a.pauseK = PAUSE.SIDE;
    a.faceA = -e * PI / 2 + r.range(-0.5, 0.5); a.alpha = a.faceA; a.vs = 0; a.vd = 0;
    a.spawnHidden = true;
    return a;
  }

  /** A pause out in a side street is over: on out to the main street, or further in. */
  resume(a) {
    const c = this.c, r = c.rng;
    const L = this.locate(a.s, a.d, _loc);
    if (!L) return false;
    const g = L.g, ms = c.unwrap(g.cs.s);
    a.sideA = this.laneA(g, r, Math.sign(L.a) || 1);
    a.mouth = g.cs; a.side = g.side; a.state = ST.GOTO; a.kind = KIND.WALKER;
    if (r.chance(0.6)) { a.task = TASK.EMERGE; a.step = -1; a.gs = ms + a.sideA; a.gd = g.side * (g.hw + 2.0); a.gTol = 0.6; }
    else {
      a.task = TASK.SIDE_OUT; a.step = 2;
      a.sideEnd = Math.min(g.len - 6, L.x + r.range(15, 30));
      a.gs = ms + a.sideA; a.gd = g.side * (g.hw + a.sideEnd); a.gTol = 0.8;
    }
    return true;
  }

  /** People far out in a side street, out of sight and going no further anyway: gone. */
  far(a) { return a.inSide && a.sideX > 64; }

  /** People out in the side streets near the camera (last maintenance pass). */
  get count() { let n = 0; for (const v of this.n.values()) n += v; return n; }
}

const _loc = settleShape({ g: null, a: 0, x: 0 }), _loc2 = settleShape({ g: null, a: 0, x: 0 }), _loc3 = settleShape({ g: null, a: 0, x: 0 });
