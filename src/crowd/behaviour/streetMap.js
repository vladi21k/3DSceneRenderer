import { TRACK_ZONE_HALF } from '../../core/config.js';
import { RNG } from '../../core/rng.js';
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

export class StreetMap {
  /** opts.shopLayout: the shopfront layout function of the facades (door position, setback, shutter), if available. */
  constructor(app, opts = {}) {
    this.shopLayout = opts.shopLayout || null;
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
    this.qI = new Int32Array(Q_MAX); this.qDS = new Float32Array(Q_MAX); this.qN = 0;
  }

  idx(s) { const w = this.route.wrap(s); return Math.min(this.N - 1, Math.floor(w)); }

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
    const n = circ.length;
    this.cS = new Float64Array(n); this.cD = new Float32Array(n); this.cR = new Float32Array(n);
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
  gatherCircles(s, range) {
    const nb = this.nb, w = this.route.wrap(s), L = this.L;
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
    this.qN = n;
    return n;
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
  /** Building line |d| at the corners of a cross street mouth on `side`. */
  mouthLine(c, side) {
    const key = side > 0 ? '_crowdLineR' : '_crowdLineL';
    if (c[key] === undefined) {
      const w = c.width / 2 + 1.5;
      let v = Math.min(this.facadeAt(c.s - w, side), this.facadeAt(c.s + w, side));
      if (v >= OPEN) v = this.layout.halfWidth(c.s, side);
      c[key] = v;
    }
    return c[key];
  }
  mouthAt(s, side) { const ci = this.mouth[sideIx(side)][this.idx(s)]; return ci >= 0 ? this.layout.crossStreets[ci] : null; }
  cafeAtS(s, side) { const ci = this.cafeAt[sideIx(side)][this.idx(s)]; return ci >= 0 ? this.layout.cafes[ci] : null; }
  stationAt(s) { const i = this.station[this.idx(s)]; return i >= 0 ? this.layout.stations[i] : null; }
  bandInAt(s, side) { return this.bandIn[sideIx(side)][this.idx(s)]; }
  bandOutAt(s, side) { return this.bandOut[sideIx(side)][this.idx(s)]; }
  /** Narrowest shop-side band over [s, s + len] (len may be negative). */
  bandAhead(s, side, len, out) {
    const si = sideIx(side), step = len >= 0 ? 1 : -1, n = Math.abs(Math.round(len));
    let lo = 0, hi = OPEN;
    for (let j = 0; j <= n; j++) {
      const k = this.idx(s + j * step);
      lo = Math.max(lo, this.bandIn[si][k]);
      hi = Math.min(hi, this.bandOut[si][k]);
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
  platformAt(s, side, ad, margin = 0) {
    const st = this.stationAt(s);
    if (!st) return null;
    const ds = this.route.delta(st.s, s);
    if (Math.abs(ds) > st.len / 2 + margin) return null;
    if (ad < TRACK_ZONE_HALF - margin || ad > TRACK_ZONE_HALF + PLATFORM_W + margin) return null;
    return st.platforms.find((p) => p.side === side) || null;
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
        ops.push({ s: sc, half: (o.w / 2) * k, kind: o.kind, recess, d: lot.d, side: lot.side, door: this._door(o, sc, us, recess) });
      }
    } catch (e) { /* facade plan unavailable: no openings */ }
    this.openingCache.set(li, ops);
    return ops;
  }

  /** Where the door leaf of an opening is (the shopfront fills the rest of a shop opening). */
  _door(o, sc, us, recess) {
    if (o.kind === 'door') {
      const half = o.w / 2 - 0.1;
      return half > 0.4 ? { s: sc, half: half * Math.abs(us), depth: recess } : null;
    }
    if (o.kind !== 'shop') return null;
    // the facade plan may carry the door decision; otherwise ask the shopfront layout itself
    let L = o.shopDoor || null;
    if (!L && this.shopLayout) {
      try { L = this.shopLayout(o, RNG.from(o.id, 'shop')); } catch (e) { L = null; }
    }
    if (!L || !(L.doorW > 0.6) || L.shutterDown > 0) return null;
    return { s: sc + (L.dx || 0) * us, half: (L.doorW / 2) * Math.abs(us), depth: recess + (L.setback || 0) };
  }
}
