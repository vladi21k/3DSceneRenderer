import { TRACK_ZONE_HALF } from '../../core/config.js';
import { PLATFORM_W } from '../../world/layout.js';
import { facadePlan } from '../../world/facadePlan.js';
import { AGENT_R, SIDEWALK_IN, WALL_GAP } from './constants.js';

// Walkability of the street for pedestrians, precomputed once from the layout at
// 1 m resolution along the route, per side (index 0 = left, 1 = right):
//   facade      |d| of the building line (exact, from the lot frames, so chords on curves are respected)
//   bandIn/Out  the shop-side walking band (between the tree line and the facade / café furniture)
//   mouth       cross street opening on this side (index into layout.crossStreets) or -1
//   station     station whose platform covers this s, or -1
// plus bucketed circle obstacles and true rectangles (café terraces, platforms) for fast
// local queries, and the shop / house doors of the ground floors.

const OPEN = 99;            // facade value inside a cross street mouth
const OB_CELL = 2;          // circle obstacle bucket size (m)
const Q_MAX = 64;           // max obstacles returned by one query

const sideIx = (side) => (side > 0 ? 1 : 0);
const RECT_REACH = 7;       // rect lookups cover this far beyond a footprint's s ends
const PLATFORM_RAMP = 2.5;  // ramp length at each platform end (furniture/platform.js)

export class StreetMap {
  /** opts.shopDecision: the facades' shopfront decision (door position and width, inset, lobby
   *  setback, roller shutter) for an opening of a plan, if available. */
  constructor(app, opts = {}) {
    this.shopDecision = opts.shopDecision || null;
    const { route, layout } = app;
    this.route = route;
    this.layout = layout;
    this.L = route.length;
    this.N = Math.ceil(this.L) + 1;
    const N = this.N;
    const mk = (F, v) => [new F(N).fill(v), new F(N).fill(v)];
    this.facade = mk(Float32Array, OPEN);
    this.bandIn = mk(Float32Array, SIDEWALK_IN);
    this.bandOut = mk(Float32Array, 0);
    this.cafeIn = mk(Float32Array, OPEN);
    this.cafeAt = mk(Int16Array, -1);
    this.mouth = mk(Int16Array, -1);
    this.cross = new Int16Array(N).fill(-1);   // cross street whose crossing (and pedestrian lights) covers this s, either side
    this.lotAt = mk(Int32Array, -1);
    this.station = new Int16Array(N).fill(-1);
    this._facades();
    this._mouths();
    this._cafes();
    this._stations();
    this._bands();
    this._circles();
    this._rects();
    this.openingCache = new Map();
    // (the building lines at every cross street's corners, now: added lazily, these fields
    // changed the class of the shared cross street objects mid-ride)
    for (const c of layout.crossStreets) { c._crowdLineR = this._mouthLine(c, 1); c._crowdLineL = this._mouthLine(c, -1); }
    // (qS / qR: the s and range of a query handed over in fields, doubles from the start)
    this.qI = new Int32Array(Q_MAX); this.qDS = new Float32Array(Q_MAX); this.qN = 0; this.qS = 0.5; this.qS = 0; this.qR = 0.5; this.qR = 0;
    // results of the per-agent queries (…A(a, …)): a number in a typed array is never boxed,
    // one returned from a call that is not inlined is
    this.R = new Float64Array(4);
    // a target spot for spotQuery: Q[0] s, Q[1] |d| in; Q[2] |d| out of the footprints, Q[3] wall out
    this.Q = new Float64Array(4);
  }

  /** Index of the 1 m sample under route s (the loop wrap worked out in place: route.wrap would
   *  return a boxed number whenever it is not inlined). */
  idx(s) {
    const L = this.L;
    let w = s % L; if (w < 0) w += L;
    const k = Math.floor(w);
    return k < this.N - 1 ? k : this.N - 1;
  }

  // ---------------------------------------------------------------- building line
  _facades() {
    const { route, layout } = this;
    const smp = {};
    layout.lots.forEach((lot, li) => {
      const si = sideIx(lot.side);
      const f = lot.frame;
      const i0 = Math.floor(lot.s0), i1 = Math.ceil(lot.s1);
      for (let i = i0; i <= i1; i++) {
        const k = this.idx(i);
        route.sample(i, smp);
        // intersect the cross-section line at s with the facade plane: dot(c + r t − o, n) = 0
        const ox = f.origin.x - smp.pos.x, oz = f.origin.z - smp.pos.z;
        const rn = smp.right.x * f.nDir.x + smp.right.z * f.nDir.z;
        if (Math.abs(rn) < 0.2) continue;
        const t = (ox * f.nDir.x + oz * f.nDir.z) / rn;
        const dd = Math.abs(t);
        // lots share end samples: keep the closer (conservative) building line
        if (i > i0 && i < i1) { this.facade[si][k] = dd; this.lotAt[si][k] = li; }
        else if (dd < this.facade[si][k]) { this.facade[si][k] = dd; if (this.lotAt[si][k] < 0) this.lotAt[si][k] = li; }
      }
    });
  }

  _mouths() {
    const { layout } = this;
    layout.crossStreets.forEach((c, ci) => {
      for (const side of [-1, 1]) {
        if (c.side !== 0 && c.side !== side) continue;
        const si = sideIx(side);
        for (let x = -c.width / 2 - 3; x <= c.width / 2 + 3; x += 1) {
          const k = this.idx(c.s + x);
          this.mouth[si][k] = ci;
          if (Math.abs(x) < c.width / 2 - 0.5) this.facade[si][k] = OPEN;
        }
      }
      // (the crossing at the junction: lights at both kerbs whichever sides the street opens to)
      for (let x = -c.width / 2 - 4; x <= c.width / 2 + 4; x += 1) this.cross[this.idx(c.s + x)] = ci;
    });
  }

  _cafes() {
    this.layout.cafes.forEach((c, ci) => {
      const si = sideIx(c.side);
      let inner = Math.abs(c.dOut);
      for (const t of c.tables) inner = Math.min(inner, Math.abs(t.d) - 0.95);
      for (const u of c.umbrellas) inner = Math.min(inner, Math.abs(u.d) - 0.3);
      c._crowdInner = inner;
      for (let s = Math.floor(c.s0 - 0.3); s <= Math.ceil(c.s1 + 0.3); s++) {
        const k = this.idx(s);
        this.cafeIn[si][k] = Math.min(this.cafeIn[si][k], inner);
        this.cafeAt[si][k] = ci;
      }
    });
  }

  _stations() {
    this.layout.stations.forEach((st, i) => {
      for (let s = Math.floor(st.s - st.len / 2) - 1; s <= Math.ceil(st.s + st.len / 2) + 1; s++) this.station[this.idx(s)] = i;
    });
  }

  _bands() {
    const platOut = TRACK_ZONE_HALF + PLATFORM_W + 0.95; // behind the platform and its pole line
    for (const si of [0, 1]) {
      const side = si ? 1 : -1;
      for (let k = 0; k < this.N; k++) {
        const fac = this.facade[si][k] >= OPEN ? this.layout.halfWidth(k, side) : this.facade[si][k];
        let out = fac - 0.55;
        if (this.cafeIn[si][k] < OPEN) out = Math.min(out, this.cafeIn[si][k] - AGENT_R - 0.12);
        this.bandOut[si][k] = out;
        this.bandIn[si][k] = this.station[k] >= 0 ? platOut : SIDEWALK_IN;
      }
    }
  }

  // ---------------------------------------------------------------- obstacles
  _circles() {
    const circ = this.layout.obstacles.filter((o) => o.kind === 'circle' && o.r > 0);
    // small free-standing rects other modules register (A-frame boards, goods stands: layout
    // addObstacles), as rows of circles along their long side; café terraces, platforms and
    // shelters are handled on their own below
    for (const o of this.layout.obstacles) {
      if (o.kind !== 'rect' || 'cafe' in o || 'platform' in o || 'shelter' in o) continue;
      const ls = Math.abs(o.s1 - o.s0), ld = Math.abs(o.d1 - o.d0);
      if (!(ls > 0) || !(ld > 0) || ls > 12 || ld > 6) continue;
      const sm = (o.s0 + o.s1) / 2, dm = (o.d0 + o.d1) / 2, along = ls >= ld, len = along ? ls : ld, r = (along ? ld : ls) / 2;
      const n = Math.max(1, Math.ceil(len / (1.4 * r)));
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : (i / (n - 1) - 0.5) * (len - 2 * r);
        // (radius to the rect's corners between the circles)
        const rr = Math.min(Math.hypot(r, len / (2 * n)), r * 1.42);
        circ.push({ kind: 'circle', s: along ? sm + u : sm, d: along ? dm : dm + u, r: rr, rect: true });
      }
    }
    // platform shelters (a rect in the layout): their glazed back wall with the bench, the end
    // screen and the advertising case, as rows of circles (people stand in front, under the roof)
    for (const f of this.layout.furniture) {
      if (f.type !== 'shelter') continue;
      const side = f.d >= 0 ? 1 : -1;
      // shelter local x runs towards −s on the right platform, +s on the left; z towards the tracks
      const at = (x, z, r) => circ.push({ kind: 'circle', s: f.s - side * x, d: f.d - side * z, r, shelter: true });
      for (const x of [-1.9, -0.95, 0, 0.95, 1.9]) at(x, -0.42, 0.3);
      for (const z of [-0.35, 0.1, 0.5]) at(-2.42, z, 0.24);
      for (const z of [-0.35, 0.15]) at(2.4, z, 0.2);
    }
    const n = circ.length;
    // (one more slot: the free inspection camera, when there is one)
    this.camI = n; this.camOn = false;
    this.cS = new Float64Array(n + 1); this.cD = new Float32Array(n + 1); this.cR = new Float32Array(n + 1);
    const nb = Math.ceil(this.L / OB_CELL);
    this.nb = nb;
    const lists = Array.from({ length: nb }, () => []);
    let maxR = 0;
    circ.forEach((o, i) => {
      this.cS[i] = this.route.wrap(o.s); this.cD[i] = o.d; this.cR[i] = o.r;
      maxR = Math.max(maxR, o.r);
      lists[Math.floor(this.cS[i] / OB_CELL) % nb].push(i); // one bucket per obstacle (its centre)
    });
    this.maxR = maxR;
    // flatten into CSR arrays
    this.bStart = new Int32Array(nb + 1);
    let tot = 0;
    for (let j = 0; j < nb; j++) { this.bStart[j] = tot; tot += lists[j].length; }
    this.bStart[nb] = tot;
    this.bItems = new Int32Array(tot);
    for (let j = 0, p = 0; j < nb; j++) for (const i of lists[j]) this.bItems[p++] = i;
  }

  /** Café terraces and platforms as rectangles in (s, |d|): {side, s0 (wrapped), len, inner, outer, kind, ref}. */
  _rects() {
    const { layout, route } = this;
    const rects = [];
    for (const c of layout.cafes) {
      rects.push({ side: c.side, s0: route.wrap(c.s0 - 0.2), len: c.s1 - c.s0 + 0.4, inner: c._crowdInner, outer: OPEN, kind: 'cafe', ref: c });
    }
    for (const st of layout.stations) {
      for (const pl of st.platforms) {
        rects.push({ side: pl.side, s0: route.wrap(pl.s0), len: pl.s1 - pl.s0, inner: TRACK_ZONE_HALF, outer: TRACK_ZONE_HALF + PLATFORM_W, kind: 'platform', ref: pl });
      }
    }
    this.rects = rects;
    // per metre: up to two rects whose footprint (± RECT_REACH) covers it
    this.rectA = [new Int16Array(this.N).fill(-1), new Int16Array(this.N).fill(-1)];
    this.rectB = [new Int16Array(this.N).fill(-1), new Int16Array(this.N).fill(-1)];
    rects.forEach((r, i) => {
      const si = sideIx(r.side);
      for (let s = Math.floor(r.s0 - RECT_REACH); s <= Math.ceil(r.s0 + r.len + RECT_REACH); s++) {
        const k = this.idx(s);
        if (this.rectA[si][k] < 0) this.rectA[si][k] = i;
        else if (this.rectA[si][k] !== i && this.rectB[si][k] < 0) this.rectB[si][k] = i;
      }
    });
    this.rq = [null, null]; this.rqN = 0;
  }

  /** Rects on `side` within RECT_REACH of s → this.rq[0..rqN). */
  rectsNear(s, side) {
    const si = sideIx(side), k = this.idx(s);
    const a = this.rectA[si][k], b = this.rectB[si][k];
    let n = 0;
    if (a >= 0) this.rq[n++] = this.rects[a];
    if (b >= 0) this.rq[n++] = this.rects[b];
    this.rqN = n;
    return n;
  }

  /** rectsNear(this.qS, side) (the s handed over in a field: nothing boxed). */
  rectsNearQ(side) {
    const si = side > 0 ? 1 : 0, k = this.idx(this.qS);
    const a = this.rectA[si][k], b = this.rectB[si][k];
    let n = 0;
    if (a >= 0) this.rq[n++] = this.rects[a];
    if (b >= 0) this.rq[n++] = this.rects[b];
    this.rqN = n;
    return n;
  }

  /** s offset of `s` from the start of rect r (unwrapped across the loop seam). */
  rectDS(r, s) { return this.route.delta(r.s0, s); }

  /** Nearest |d| outside the footprints at (s, side) for a body of radius rad, or -1 when not inside one.
   *  Only the long edges are considered (used for targets, not for bodies). */
  clearOfRects(s, side, ad, rad = 0.35) {
    const n = this.rectsNear(s, side);
    for (let q = 0; q < n; q++) {
      const r = this.rq[q];
      const ds = this.rectDS(r, s);
      if (ds < -rad || ds > r.len + rad || ad < r.inner - rad || ad > r.outer + rad) continue;
      if (r.outer >= OPEN || ad - (r.inner - rad) < r.outer + rad - ad) return r.inner - rad;
      return r.outer + rad;
    }
    return -1;
  }

  /** Collects circle obstacles whose centre lies within range + maxR of s into qI / qDS (ds = obstacle s − s); returns the count. */
  gatherCircles(s, range) { this.qS = s; this.qR = range; return this._gather(); }
  /** gatherCircles around agent a (its own s: nothing to box per call). */
  gatherAt(a, range) { this.qS = a.s; this.qR = range; return this._gather(); }
  /** gatherCircles(this.qS, this.qR): the per-frame callers hand their numbers over in the fields. */
  gatherQ() { return this._gather(); }
  _gather() {
    const nb = this.nb, L = this.L, range = this.qR;
    let w = this.qS % L; if (w < 0) w += L; if (w >= L) w -= L;
    const a = Math.floor((w - range - this.maxR) / OB_CELL), b = Math.floor((w + range + this.maxR) / OB_CELL);
    let n = 0;
    for (let j = a; j <= b; j++) {
      const jj = ((j % nb) + nb) % nb;
      for (let p = this.bStart[jj]; p < this.bStart[jj + 1] && n < Q_MAX; p++) {
        const i = this.bItems[p];
        let ds = this.cS[i] - w;
        if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
        this.qI[n] = i; this.qDS[n] = ds; n++;
      }
    }
    // the inspection camera: avoided like a pole
    if (this.camOn && n < Q_MAX) {
      let ds = this.cS[this.camI] - w;
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      if (Math.abs(ds) <= range + this.cR[this.camI]) { this.qI[n] = this.camI; this.qDS[n] = ds; n++; }
    }
    this.qN = n;
    return n;
  }

  /** The free inspection camera stands at (s, d) (route coords): nobody walks through it. r = 0 removes it. */
  setCamera(s, d, r) {
    const i = this.camI;
    this.cS[i] = this.route.wrap(s); this.cD[i] = d; this.cR[i] = r;
    this.camOn = r > 0;
  }

  // ---------------------------------------------------------------- queries
  /** Building line |d| on `side` at s (OPEN inside a cross street mouth). Conservative between samples. */
  facadeAt(s, side) {
    const si = sideIx(side), f = this.facade[si];
    const w = this.route.wrap(s), k = Math.min(this.N - 1, Math.floor(w)), k1 = k + 1 < this.N ? k + 1 : 0;
    return Math.min(f[k], f[k1]);
  }
  /** Max |d| an agent centre may reach on this side at s (wall clearance applied). */
  wallAt(s, side) { return this.facadeAt(s, side) - WALL_GAP; }
  /** Lowest wallAt over [s − half, s + half] (facades of neighbouring lots may step forward). */
  wallMin(s, side, half) {
    let w = this.wallAt(s, side);
    for (let x = -half; x <= half; x += 0.5) w = Math.min(w, this.wallAt(s + x, side));
    return w;
  }
  /** Max |d| of a walkable spot at unwrapped s: into a side street only inside its opening. */
  reachAt(s, side, unwrap) {
    const m = this.mouthAt(s, side);
    if (m && Math.abs(s - unwrap(m.s)) < m.width / 2 - 0.55) return this.mouthLine(m, side) + 22;
    return Math.min(this.wallAt(s, side), m ? this.mouthLine(m, side) - WALL_GAP : 99);
  }
  /** Building line |d| at the corners of a cross street mouth on `side`. */
  mouthLine(c, side) { return side > 0 ? c._crowdLineR : c._crowdLineL; }
  _mouthLine(c, side) {
    const w = c.width / 2 + 1.5;
    const v = Math.min(this.facadeAt(c.s - w, side), this.facadeAt(c.s + w, side));
    return v >= OPEN ? this.layout.halfWidth(c.s, side) : v;
  }
  mouthAt(s, side) { const ci = this.mouth[sideIx(side)][this.idx(s)]; return ci >= 0 ? this.layout.crossStreets[ci] : null; }
  /** Index of the 1 m sample under agent a (its own s: no number argument to box). */
  idxA(a) { const L = this.L; let w = a.s % L; if (w < 0) w += L; const k = Math.floor(w); return k < this.N - 1 ? k : this.N - 1; }
  /** The cross street opening on agent a's side of the street at its s, or null. */
  mouthAtA(a) { const ci = this.mouth[a.d >= 0 ? 1 : 0][this.idxA(a)]; return ci >= 0 ? this.layout.crossStreets[ci] : null; }
  /** ... on `side`. */
  mouthAtAS(a, side) { const ci = this.mouth[side > 0 ? 1 : 0][this.idxA(a)]; return ci >= 0 ? this.layout.crossStreets[ci] : null; }
  /** facadeAt(a.s, side) → R[0] (and the wall line, wallAt, → R[1]). */
  facadeA(a, side) {
    const f = this.facade[side > 0 ? 1 : 0], k = this.idxA(a), k1 = k + 1 < this.N ? k + 1 : 0;
    const v = f[k] < f[k1] ? f[k] : f[k1];
    this.R[0] = v; this.R[1] = v - WALL_GAP;
  }
  /** Building line at s = this.qS on `side` → R[0] (OPEN in a cross street opening), and R[3] = 1
   *  inside a cross street mouth, else 0 (mouthAt / facadeAt with the s handed over in a field). */
  facadeQS(side) {
    const si = side > 0 ? 1 : 0, k = this.idx(this.qS), k1 = k + 1 < this.N ? k + 1 : 0, f = this.facade[si];
    this.R[0] = f[k] < f[k1] ? f[k] : f[k1];
    this.R[3] = this.mouth[si][k] >= 0 ? 1 : 0;
  }
  /** stationAt(a.s). */
  stationAtA(a) { const i = this.station[this.idxA(a)]; return i >= 0 ? this.layout.stations[i] : null; }
  /** platformAt(a.s, side, |a.d|, margin) (agent a's own numbers: nothing boxed). */
  platformAtA(a, side, margin) {
    const st = this.stationAtA(a);
    if (!st) return null;
    const L = this.L, ad = a.d >= 0 ? a.d : -a.d;
    let ds = (a.s - st.s) % L;
    if (ds < -L / 2) ds += L; else if (ds > L / 2) ds -= L;
    if (ds > st.len / 2 + margin || ds < -st.len / 2 - margin) return null;
    if (ad < TRACK_ZONE_HALF - margin || ad > TRACK_ZONE_HALF + PLATFORM_W + margin) return null;
    const P = st.platforms;
    for (let i = 0; i < P.length; i++) if (P[i].side === side) return P[i];
    return null;
  }
  /** rectsNear(a.s, side). */
  rectsNearA(a, side) {
    const si = side > 0 ? 1 : 0, k = this.idxA(a);
    const ra = this.rectA[si][k], rb = this.rectB[si][k];
    let n = 0;
    if (ra >= 0) this.rq[n++] = this.rects[ra];
    if (rb >= 0) this.rq[n++] = this.rects[rb];
    this.rqN = n;
    return n;
  }
  /** For the target spot (s, |d|) in Q[0], Q[1] on `side`: Q[2] = clearOfRects(s, side, |d|, rad)
   *  (the nearest |d| outside a café / platform footprint, -1 when not inside one), Q[3] = wallAt(s,
   *  side) (99 inside a cross street opening). Numbers in and out through Q: nothing to box. */
  spotQuery(side, rad) {
    const Q = this.Q, s = Q[0], ad = Q[1], L = this.L, si = side > 0 ? 1 : 0;
    let w = s % L; if (w < 0) w += L; if (w >= L) w -= L;
    let k = Math.floor(w); if (k > this.N - 1) k = this.N - 1;
    const k1 = k + 1 < this.N ? k + 1 : 0;
    Q[2] = -1;
    for (let e = 0; e < 2; e++) {
      const ri = e ? this.rectB[si][k] : this.rectA[si][k];
      if (ri < 0) continue;
      const r = this.rects[ri];
      let ds = w - r.s0;
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      if (ds < -rad || ds > r.len + rad || ad < r.inner - rad || ad > r.outer + rad) continue;
      Q[2] = r.outer >= OPEN || ad - (r.inner - rad) < r.outer + rad - ad ? r.inner - rad : r.outer + rad;
      break;
    }
    const f = this.facade[si];
    Q[3] = this.mouth[si][k] >= 0 ? 99 : (f[k] < f[k1] ? f[k] : f[k1]) - WALL_GAP;
  }
  /** rectDS(r, a.s) → R[2]. */
  rectDSA(r, a) {
    const L = this.L;
    let w = a.s % L; if (w < 0) w += L;
    let d = w - r.s0;
    if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
    this.R[2] = d;
  }
  /** The cross street whose crossing covers s (either side of the street), or null. */
  crossAt(s) { const ci = this.cross[this.idx(s)]; return ci >= 0 ? this.layout.crossStreets[ci] : null; }
  cafeAtS(s, side) { const ci = this.cafeAt[sideIx(side)][this.idx(s)]; return ci >= 0 ? this.layout.cafes[ci] : null; }
  stationAt(s) { const i = this.station[this.idx(s)]; return i >= 0 ? this.layout.stations[i] : null; }
  bandInAt(s, side) { return this.bandIn[sideIx(side)][this.idx(s)]; }
  bandOutAt(s, side) { return this.bandOut[sideIx(side)][this.idx(s)]; }
  /** Narrowest shop-side band over [s, s + len] (len may be negative). */
  bandAhead(s, side, len, out) {
    const si = sideIx(side), step = len >= 0 ? 1 : -1, n = Math.abs(Math.round(len)), L = this.L, N1 = this.N - 1;
    const bi = this.bandIn[si], bo = this.bandOut[si];
    let lo = 0, hi = OPEN;
    // (the sample index stepped along in place: no call per metre)
    let w = s % L; if (w < 0) w += L;
    for (let j = 0; j <= n; j++) {
      let x = w + j * step;
      if (x >= L) x -= L; else if (x < 0) x += L;
      let k = Math.floor(x); if (k > N1) k = N1;
      if (bi[k] > lo) lo = bi[k];
      if (bo[k] < hi) hi = bo[k];
    }
    out.lo = lo; out.hi = hi;
    return out;
  }
  /** Is |d| on this side inside a café or platform footprint at s (grown by `grow`)? Returns the inner edge |d| or 0. */
  rectInner(s, side, ad, grow = 0) {
    const n = this.rectsNear(s, side);
    for (let q = 0; q < n; q++) {
      const r = this.rq[q];
      const ds = this.rectDS(r, s);
      if (ds > -grow && ds < r.len + grow && ad > r.inner - grow && ad < r.outer + grow) return r.inner;
    }
    return 0;
  }
  /** Height of the platform surface under a body at (s, |d|) on side, with the ramps at both
   *  ends (as built by the furniture), or 0 off the platform. */
  platformHeight(s, side, ad) {
    if (ad < TRACK_ZONE_HALF + 0.05) return 0;
    const pl = this.platformAt(s, side, ad, 0);
    if (!pl) return 0;
    const ds = this.route.delta(pl.s0, s), len = pl.s1 - pl.s0;
    return pl.h * Math.max(0, Math.min(1, ds / PLATFORM_RAMP, (len - ds) / PLATFORM_RAMP));
  }
  /** platformHeight under agent a (its own s, side and |d|: no number arguments to box). */
  platformHeightA(a) { return this.platformHeight(a.s, a.d >= 0 ? 1 : -1, a.d >= 0 ? a.d : -a.d); }
  platformAt(s, side, ad, margin = 0) {
    const st = this.stationAt(s);
    if (!st) return null;
    // (the loop distance worked out in place, and no closure: this runs per agent and per frame)
    const L = this.route.length;
    let ds = (s - st.s) % L;
    if (ds < -L / 2) ds += L; else if (ds > L / 2) ds -= L;
    if (ds > st.len / 2 + margin || ds < -st.len / 2 - margin) return null;
    if (ad < TRACK_ZONE_HALF - margin || ad > TRACK_ZONE_HALF + PLATFORM_W + margin) return null;
    const P = st.platforms;
    for (let i = 0; i < P.length; i++) if (P[i].side === side) return P[i];
    return null;
  }

  /** Ground-floor openings (shop windows / doors) of the lot at s on side, in route coordinates:
   *  {s, half (opening centre / half-width), kind, recess, d (building line |d|), side,
   *   door: {s, half, depth} or null when there is no usable door (unknown layout, shutter down)}. */
  openingsAt(s, side) {
    const li = this.lotAt[sideIx(side)][this.idx(s)];
    if (li < 0) return null;
    let ops = this.openingCache.get(li);
    if (ops) return ops;
    const lot = this.layout.lots[li];
    ops = [];
    try {
      const plan = facadePlan(lot);
      const k = lot.len / Math.max(1e-3, lot.frame.width);
      // u runs to decreasing s on the right side
      const us = lot.side > 0 ? -k : k;
      for (const o of plan.openings) {
        if (o.floor !== 0) continue;
        const sc = lot.side > 0 ? lot.s1 - o.uc * k : lot.s0 + o.uc * k;
        const recess = o.recess || 0.3;
        ops.push({ s: sc, half: (o.w / 2) * k, kind: o.kind, recess, d: lot.d, side: lot.side, door: this._door(plan, o, sc, us, recess) });
      }
    } catch (e) { /* facade plan unavailable: no openings */ }
    this.openingCache.set(li, ops);
    return ops;
  }

  /** Where the door leaf of an opening is (the shopfront fills the rest of a shop opening). */
  _door(plan, o, sc, us, recess) {
    if (o.kind === 'door') {
      const half = o.w / 2 - 0.1;
      return half > 0.4 ? { s: sc, half: half * Math.abs(us), depth: recess } : null;
    }
    if (o.kind !== 'shop') return null;
    // the facades' own decision for this shopfront (the call they draw it with)
    let L = null;
    if (this.shopDecision) { try { L = this.shopDecision(plan, o); } catch (e) { L = null; } }
    if (!L || !(L.doorW > 0.6)) return null;
    // a roller shutter part way down: the door is used only while there is head room under it
    // (its bottom edge as the facades draw it: the box under the opening's head, 0.22 m deep)
    const sd = L.shutterDown || 0;
    if (sd > 0 && ((L.arched ? L.yT : o.h - 0.085) - 0.22) * (1 - sd) < 2.05) return null;
    // the door leaf stands the shopfront's inset behind the wall face, and a lobby's setback further
    return { s: sc + (L.dx || 0) * us, half: (L.doorW / 2) * Math.abs(us), depth: recess + (L.inset || 0) + (L.setback || 0) };
  }
}
