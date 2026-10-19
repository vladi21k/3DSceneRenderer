import * as THREE from 'three';
import { lattice1, lattice2, LATTICE } from '../core/rng.js';

// The tram line: a closed loop through the city built from straights, clothoid
// transitions and circular arcs, with gentle grades. Everything in the world is
// positioned in route coordinates (s, d, h):
//   s  distance along the street centre line (metres, wraps at route.length)
//   d  lateral offset, + to the right of the direction of travel
//   h  height above the street surface at that point
// The street surface is level across its width (no superelevation) and the rail
// tops are flush with the paving, so h = 0 is the rail-top / paving level.
//
// Heading convention: tangent T(θ) = (cos θ, 0, -sin θ); θ grows when turning
// left; curvature κ > 0 means a left-hand curve. right = (−Tz, 0, Tx).

const DS = 0.5; // table resolution (m)
const SURF_EDGE = 3.66; // ground shaping starts outside the corridor band + gutter
const SURF_FAR = 13.0;  // ...and levels off at about the facade line

// Plan of the loop. turn in degrees (+ left), radius in metres, trans = clothoid length.
// Two straights (chosen automatically) absorb the closure error; `min` bounds them.
const PLAN = [
  // main avenue (default start): the tracks bend gently right, then left, while the street climbs a hill
  { type: 'straight', len: 150, min: 110, keep: true, name: 'main avenue' },
  { type: 'curve', turn: -6, radius: 1100, trans: 40 },
  { type: 'straight', len: 110, keep: true },
  { type: 'curve', turn: 11, radius: 750, trans: 40 },
  { type: 'straight', len: 170 },
  { type: 'curve', turn: -5, radius: 900, trans: 30 },
  { type: 'straight', len: 200 },
  { type: 'curve', turn: 60, radius: 230, trans: 35 },
  { type: 'straight', len: 330 },
  { type: 'curve', turn: 6, radius: 700, trans: 25 },
  { type: 'straight', len: 120 },
  { type: 'curve', turn: 54, radius: 150, trans: 30 },
  { type: 'straight', len: 420 },
  { type: 'curve', turn: 60, radius: 58, trans: 18, junction: true },
  { type: 'straight', len: 380 },
  { type: 'curve', turn: -7, radius: 650, trans: 25 },
  { type: 'straight', len: 140 },
  { type: 'curve', turn: 7, radius: 650, trans: 25 },
  { type: 'straight', len: 200 },
  { type: 'curve', turn: 60, radius: 260, trans: 35 },
  { type: 'straight', len: 460 },
  { type: 'curve', turn: 60, radius: 180, trans: 30 },
  { type: 'straight', len: 300 },
  { type: 'curve', turn: 60, radius: 120, trans: 28 },
  { type: 'straight', len: 260 },
];

// Long straights get a gentle S-meander (net zero turn) so no street is ruler-straight.
function meander(plan) {
  const out = [];
  let k = 0;
  for (const seg of plan) {
    if (seg.type !== 'straight' || seg.keep || seg.len < 230) { out.push(seg); continue; }
    const turn = (k++ % 2 ? -1 : 1) * (2.5 + (k % 3) * 0.8);
    const R = 1400 + (k % 4) * 250, trans = 30;
    const arc = R * Math.abs(turn) * Math.PI / 180; // length of each bend
    const rest = Math.max(40, seg.len - 2 * arc);
    out.push({ ...seg, len: rest * 0.35 });
    out.push({ type: 'curve', turn, radius: R, trans });
    out.push({ type: 'straight', len: rest * 0.3, min: 20 });
    out.push({ type: 'curve', turn: -turn, radius: R, trans });
    out.push({ type: 'straight', len: rest * 0.35, min: 20 });
  }
  return out;
}

/** 0 → 1 over t ∈ [0, 1] with a constant slope in the middle; the slope eases in and out
 *  (smoothstep) over the first and last share `e`, so grade changes are vertical curves. */
function easedRamp(t, e) {
  let v;
  if (t <= 0) v = 0;
  else if (t < e) { const u = t / e; v = e * (u * u * u - (u * u * u * u) / 2); }
  else if (t < 1 - e) v = e / 2 + (t - e);
  else if (t < 1) { const u = (1 - t) / e; v = 1 - e - e * (u * u * u - (u * u * u * u) / 2); }
  else v = 1 - e;
  return v / (1 - e);
}

function curvatureProfile(plan) {
  // returns array of {s0, s1, k0, k1, seg} (linear curvature pieces) and total length
  const pieces = [];
  let s = 0;
  plan.forEach((seg, i) => {
    if (seg.type === 'straight') {
      pieces.push({ s0: s, s1: s + seg.len, k0: 0, k1: 0, seg: i });
      s += seg.len;
    } else {
      const th = (seg.turn * Math.PI) / 180;
      const sign = Math.sign(th);
      const R = seg.radius;
      let Lt = seg.trans;
      // arc body length; transitions each contribute Lt/(2R) of turn
      let body = R * Math.abs(th) - Lt;
      if (body < 0) { Lt = R * Math.abs(th); body = 0; }
      const k = sign / R;
      pieces.push({ s0: s, s1: s + Lt, k0: 0, k1: k, seg: i, part: 'in' }); s += Lt;
      if (body > 0) { pieces.push({ s0: s, s1: s + body, k0: k, k1: k, seg: i, part: 'arc' }); s += body; }
      pieces.push({ s0: s, s1: s + Lt, k0: k, k1: 0, seg: i, part: 'out' }); s += Lt;
    }
  });
  return { pieces, length: s };
}

function integrate(pieces, length) {
  const n = Math.ceil(length / DS) + 1;
  const x = new Float64Array(n), z = new Float64Array(n), th = new Float64Array(n), k = new Float64Array(n);
  let pi = 0;
  const kAt = (s) => {
    while (pi < pieces.length - 1 && s > pieces[pi].s1) pi++;
    const p = pieces[pi];
    const t = p.s1 > p.s0 ? Math.min(1, Math.max(0, (s - p.s0) / (p.s1 - p.s0))) : 0;
    return p.k0 + (p.k1 - p.k0) * t;
  };
  let cx = 0, cz = 0, ct = 0;
  const sub = 4, h = DS / sub;
  for (let i = 0; i < n; i++) {
    const s = i * DS;
    x[i] = cx; z[i] = cz; th[i] = ct; k[i] = kAt(Math.min(s, length));
    for (let j = 0; j < sub; j++) {
      const sa = s + j * h;
      const ka = kAt(Math.min(sa, length)), km = kAt(Math.min(sa + h / 2, length)), kb = kAt(Math.min(sa + h, length));
      const t0 = ct, tm = ct + (ka + km) * 0.25 * h, t1 = ct + (ka + 4 * km + kb) / 6 * h;
      // Simpson on the tangent
      cx += (Math.cos(t0) + 4 * Math.cos(tm) + Math.cos(t1)) / 6 * h;
      cz += (-Math.sin(t0) - 4 * Math.sin(tm) - Math.sin(t1)) / 6 * h;
      ct = t1;
    }
  }
  return { x, z, th, k, n };
}

export class Route {
  constructor() {
    this._f = 0;   // scratch of _at()
    // number passing without heap numbers (see toWorldOf / toWorldIO): the public slots and
    // the internal ones of toWorld and surface
    this.io = new Float64Array(8);
    this._sio = new Float64Array(8);
    let plan = meander(PLAN.map((p) => ({ ...p })));
    // Closure: pick the pair of straights whose length change closes the loop with the
    // smallest total adjustment while respecting minimum lengths (heading closes by design).
    {
      const { pieces, length } = curvatureProfile(plan);
      const t = integrate(pieces, length);
      const ex = t.x[t.n - 1] - t.x[0], ez = t.z[t.n - 1] - t.z[0];
      const straights = plan.map((p, i) => (p.type === 'straight' ? i : -1)).filter((i) => i >= 0);
      const dirOf = (i) => {
        const piece = pieces.find((pc) => pc.seg === i);
        const j = Math.min(t.n - 1, Math.round(piece.s0 / DS));
        return [Math.cos(t.th[j]), -Math.sin(t.th[j])];
      };
      let best = null;
      for (const i of straights) for (const j of straights) {
        if (j <= i) continue;
        const A = dirOf(i), B = dirOf(j);
        const det = A[0] * B[1] - A[1] * B[0];
        if (Math.abs(det) < 0.3) continue;
        const da = (-ex * B[1] + ez * B[0]) / det;
        const db = (-A[0] * ez + A[1] * ex) / det;
        if (plan[i].len + da < (plan[i].min ?? 140) || plan[j].len + db < (plan[j].min ?? 140)) continue;
        const score = Math.abs(da) + Math.abs(db);
        if (!best || score < best.score) best = { i, j, da, db, score };
      }
      if (best) { plan[best.i].len += best.da; plan[best.j].len += best.db; }
      else console.warn('[route] loop closure failed');
    }
    const { pieces, length } = curvatureProfile(plan);
    this.plan = plan;
    this.pieces = pieces;
    this.length = length;
    const t = integrate(pieces, length);
    this.surfaceEnabled = true; // toWorld / groundY include surface(s, d); the paving mesh follows it
    // cell counts of surface()'s loop noises (wavelengths 320, 6.5 and 2.3 m), as loopNoise1/2 compute them
    this._surfCells = [320, 6.5, 2.3].map((w) => Math.max(1, Math.round(length / w)));
    this.n = t.n;
    this.x = t.x; this.z = t.z; this.th = t.th; this.k = t.k;
    // distribute the tiny residual (table end overshoot) so the seam at s = L is exact
    {
      const f = length / DS, i = Math.min(t.n - 2, Math.floor(f)), u = f - i;
      const ex = t.x[i] + (t.x[i + 1] - t.x[i]) * u - t.x[0];
      const ez = t.z[i] + (t.z[i + 1] - t.z[i]) * u - t.z[0];
      for (let j = 0; j < t.n; j++) { const w = (j * DS) / length; t.x[j] -= ex * w; t.z[j] -= ez * w; }
    }

    // segments in s for layout decisions
    this.segments = [];
    let s = 0;
    for (let i = 0; i < plan.length; i++) {
      const ps = pieces.filter((p) => p.seg === i);
      const s0 = ps[0].s0, s1 = ps[ps.length - 1].s1;
      this.segments.push({ index: i, type: plan[i].type, s0, s1, radius: plan[i].radius || Infinity, turn: plan[i].turn || 0, junction: !!plan[i].junction });
      s = s1;
    }

    // elevation: gentle periodic rolling, designed hills (periodic bumps) and mesas (an eased
    // climb at a steady grade, a level top, an eased descent). Grades stay ≤ 6.5 %.
    // The default start sits in a shallow sag at the foot of the main avenue; from about 130 m
    // ahead the street climbs 21 m, at ~5.8 % from 240 m to 510 m (a rising ramp of paving that
    // fills ~15 % of the frame down the long lens, as in the reference views), and levels off
    // at ~600 m, where the first stop is.
    const L = length;
    this.elevTerms = [
      { a: 1.6, k: 2, p: 0.35 },
      { a: 0.9, k: 5, p: 2.1 },
      { a: 0.3, k: 13, p: 4.0 },
    ];
    this.mesas = [
      // climb s0→s1, level top, descend s2→s3; h metres; e = eased share of each ramp
      { s0: 150, s1: 600, s2: 740, s3: 1300, h: 21, e: 0.2 },
    ];
    this.hills = [
      { c: 30, a: -1.2, w: 55 },     // the sag the default start stands in
      { c: 1650, a: -5.5, w: 260 },
      { c: 2700, a: 6.5, w: 240 },
      { c: 3900, a: -4.5, w: 300 },
      { c: 5000, a: 5.0, w: 230 },
    ];
    this.y = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) this.y[i] = this.elevationRaw(i * DS);
    void L;
  }

  elevationRaw(s) {
    const L = this.length;
    let y = 0;
    for (const e of this.elevTerms) y += e.a * Math.sin((2 * Math.PI * e.k * s) / L + e.p);
    for (const h of this.hills) {
      // periodic (von Mises) bump of width ≈ w metres
      const kappa = (L / (2 * Math.PI * h.w)) ** 2;
      y += h.a * Math.exp(kappa * (Math.cos((2 * Math.PI * (s - h.c)) / L) - 1));
    }
    for (const m of this.mesas) {
      // evaluated at the copy of s nearest the mesa so the loop has no seam (net rise is zero)
      const c = (m.s0 + m.s3) / 2;
      const x = c + ((((s - c) % L) + L * 1.5) % L) - L / 2;
      y += m.h * (easedRamp((x - m.s0) / (m.s1 - m.s0), m.e) - easedRamp((x - m.s2) / (m.s3 - m.s2), m.e));
    }
    return y;
  }

  wrap(s) { const L = this.length; return ((s % L) + L) % L; }

  /** Shortest signed distance along the loop from a to b (b - a). */
  delta(a, b) { const L = this.length; let d = this.wrap(b) - this.wrap(a); if (d > L / 2) d -= L; if (d < -L / 2) d += L; return d; }

  /** Table index at s; the fraction past it goes to this._f (read it at once). Allocation
   *  free: the route is sampled per vertex, per agent and per frame. */
  _at(s) {
    const L = this.length;
    const f = (((s % L) + L) % L) / DS;
    const i = Math.min(this.n - 2, Math.floor(f));
    this._f = f - i;
    return i;
  }

  _idx(s) { const i = this._at(s); return [i, this._f]; }

  heading(s) { const i = this._at(s), f = this._f; return this.th[i] + (this.th[i + 1] - this.th[i]) * f; }
  curvature(s) { const i = this._at(s), f = this._f; return this.k[i] + (this.k[i + 1] - this.k[i]) * f; }
  elevation(s) { const i = this._at(s), f = this._f; return this.y[i] + (this.y[i + 1] - this.y[i]) * f; }
  grade(s) { return (this.elevation(s + 0.5) - this.elevation(s - 0.5)); }

  /** Writes the centre-line sample into `out` (allocation free once `out` holds its vectors:
   *  field writes and inline maths, no calls that would box a computed number). */
  sample(s, out = {}) {
    const L = this.length, w = ((s % L) + L) % L, fi = w / DS;
    const i = Math.min(this.n - 2, Math.floor(fi)), f = fi - i;
    const th = this.th[i] + (this.th[i + 1] - this.th[i]) * f;
    const tx = Math.cos(th), tz = -Math.sin(th);
    const y = this.y[i] + (this.y[i + 1] - this.y[i]) * f;
    // grade(s) = elevation(s + 0.5) − elevation(s − 0.5), written out
    const fa = (((s + 0.5) % L + L) % L) / DS, ia = Math.min(this.n - 2, Math.floor(fa)), ua = fa - ia;
    const fb = (((s - 0.5) % L + L) % L) / DS, ib = Math.min(this.n - 2, Math.floor(fb)), ub = fb - ib;
    const g = (this.y[ia] + (this.y[ia + 1] - this.y[ia]) * ua) - (this.y[ib] + (this.y[ib + 1] - this.y[ib]) * ub);
    out.s = w;
    const p = out.pos || (out.pos = new THREE.Vector3());
    p.x = this.x[i] + (this.x[i + 1] - this.x[i]) * f; p.y = y; p.z = this.z[i] + (this.z[i + 1] - this.z[i]) * f;
    const h = out.tanH || (out.tanH = new THREE.Vector3());
    h.x = tx; h.y = 0; h.z = tz;
    const t = out.tan || (out.tan = new THREE.Vector3());
    const inv = 1 / (Math.sqrt(tx * tx + g * g + tz * tz) || 1);   // (as Vector3.normalize)
    t.x = tx * inv; t.y = g * inv; t.z = tz * inv;
    const r = out.right || (out.right = new THREE.Vector3());
    r.x = -tz; r.y = 0; r.z = tx;
    out.heading = th;
    out.curvature = this.k[i] + (this.k[i + 1] - this.k[i]) * f;
    out.grade = g;
    return out;
  }

  /** Ground shape across the street, metres above the centre-line elevation at (s, d).
   *  The track corridor (rail level) stays at 0; outside it the sidewalks rise towards the
   *  facades (drainage cross-fall), the whole street sits on a slowly varying hillside tilt
   *  (one side higher than the other) and the paving has gentle settlement undulation.
   *  Fine millimetre detail (gutters, crowns) is added by the street mesh on top. */
  surface(s, d) {
    const a = this._sio;
    a[0] = s; a[1] = d;
    this._surf(a);
    return a[7];
  }

  /** surface(a[0], a[1]) into a[7] (a: a Float64Array, so no number is boxed on the way). */
  _surf(a) {
    a[7] = 0;
    if (!this.surfaceEnabled) return;
    const s = a[0], d = a[1];
    // shaping runs from the corridor edge to about the facade line, then stays level
    // (side streets continue at the height of their mouth)
    const ad = Math.min(Math.abs(d), SURF_FAR) - SURF_EDGE;
    if (ad <= 0) return;
    const L = this.length, sw = ((s % L) + L) % L;
    const ramp = Math.min(1, ad / 1.2);                      // ease in from the corridor edge
    const fall = ad * 0.016;                                 // ~1.6 % rise towards the facades
    // all noise is periodic in L so the loop has no seam: loopNoise1(sw, L, 320, 101) and
    // loopNoise2(sw, dd, L, 6.5, 5.5, 7) / (…, 2.3, 2.1, 13), written out here with their
    // cell counts precomputed (the same values: this runs per agent and per vertex, and a
    // noise call that is not inlined boxes its float arguments and result; the lattice
    // coordinates are passed as int32, which stay unboxed)
    const c = this._surfCells, Q = LATTICE;
    const sd = d < 0 ? -1 : 1;
    const dd = sd * (ad + SURF_EDGE);
    // hillside: ±1.3 %
    let n = c[0], x = (sw / L) * n, i = Math.floor(x), f = x - i;
    lattice1((((i % n) + n) % n) | 0, ((((i + 1) % n) + n) % n) | 0, 101);
    const tilt = sd * ad * 0.013 * (Q[0] + (Q[1] - Q[0]) * (f * f * (3 - 2 * f)));
    // settlement undulation: two octaves of 2D noise
    n = c[1]; x = (sw / L) * n; i = Math.floor(x); f = x - i;
    let y = dd / 5.5, j = Math.floor(y), g = y - j;
    let ux = f * f * (3 - 2 * f), uy = g * g * (3 - 2 * g);
    lattice2((((i % n) + n) % n) | 0, ((((i + 1) % n) + n) % n) | 0, j | 0, (j + 1) | 0, 7);
    const s1 = Q[0] + (Q[1] - Q[0]) * ux + (Q[2] - Q[0]) * uy + (Q[0] - Q[1] - Q[2] + Q[3]) * ux * uy;
    n = c[2]; x = (sw / L) * n; i = Math.floor(x); f = x - i;
    y = dd / 2.1; j = Math.floor(y); g = y - j;
    ux = f * f * (3 - 2 * f); uy = g * g * (3 - 2 * g);
    lattice2((((i % n) + n) % n) | 0, ((((i + 1) % n) + n) % n) | 0, j | 0, (j + 1) | 0, 13);
    const s2 = Q[0] + (Q[1] - Q[0]) * ux + (Q[2] - Q[0]) * uy + (Q[0] - Q[1] - Q[2] + Q[3]) * ux * uy;
    const settle = 0.02 * s1 + 0.01 * s2;
    a[7] = fall + tilt + settle * ramp * ramp;
  }

  /** World height of the paving at route coordinate (s, d). */
  groundY(s, d = 0) { return this.elevation(s) + this.surface(s, d); }

  /** World position of route coordinate (s, d, h); h is height above the local ground. */
  toWorld(s, d = 0, h = 0, out = new THREE.Vector3()) {
    const a = this._sio;
    a[0] = s; a[1] = d; a[2] = h;
    return this._world(a, out);
  }

  /**
   * Allocation-free entry points for per-agent and per-vertex loops. A call that is not
   * inlined boxes each float argument and a float result (a heap number each), so these
   * take their numbers from an object's fields or from `route.io` (a Float64Array) and
   * write their results into `out` or `route.io`:
   *   route.toWorldOf(o, out)   toWorld(o.s, o.d, o.h ?? 0, out), read from o's fields
   *   io[0] = s; io[1] = d; io[2] = h; route.toWorldIO(out)   the same through route.io
   *   io[0] = s; route.sampleIO()   io[3] heading, io[4] curvature, io[5] elevation, io[6] grade
   * (io[7] is scratch.)
   */
  toWorldOf(o, out) {
    const a = this._sio;
    a[0] = o.s; a[1] = o.d; a[2] = o.h === undefined ? 0 : o.h;
    return this._world(a, out);
  }

  toWorldIO(out) { return this._world(this.io, out); }

  sampleIO() {
    const a = this.io, s = a[0], L = this.length;
    const fi = (((s % L) + L) % L) / DS, i = Math.min(this.n - 2, Math.floor(fi)), f = fi - i;
    a[3] = this.th[i] + (this.th[i + 1] - this.th[i]) * f;
    a[4] = this.k[i] + (this.k[i + 1] - this.k[i]) * f;
    a[5] = this.y[i] + (this.y[i + 1] - this.y[i]) * f;
    const fa = (((s + 0.5) % L + L) % L) / DS, ia = Math.min(this.n - 2, Math.floor(fa)), ua = fa - ia;
    const fb = (((s - 0.5) % L + L) % L) / DS, ib = Math.min(this.n - 2, Math.floor(fb)), ub = fb - ib;
    a[6] = (this.y[ia] + (this.y[ia + 1] - this.y[ia]) * ua) - (this.y[ib] + (this.y[ib + 1] - this.y[ib]) * ub);
  }

  /** World position of (a[0], a[1], a[2]) = (s, d, h) into out (a: a Float64Array). */
  _world(a, out) {
    const s = a[0], d = a[1], L = this.length;
    const fi = (((s % L) + L) % L) / DS, i = Math.min(this.n - 2, Math.floor(fi)), f = fi - i;
    const th = this.th[i] + (this.th[i + 1] - this.th[i]) * f;
    const tx = Math.cos(th), tz = -Math.sin(th);
    // (field writes, not out.set(x, y, z): a call that is not inlined boxes its double arguments)
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * f - tz * d;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * f + tx * d;
    let y = this.y[i] + (this.y[i + 1] - this.y[i]) * f + a[2];
    if (this.surfaceEnabled && (d > SURF_EDGE || d < -SURF_EDGE)) { this._surf(a); y += a[7]; }
    out.y = y;
    return out;
  }

  /** Arc-length scale of an offset line: ds_offset = (1 + κ·d) ds. */
  offsetScale(s, d) { return 1 + this.curvature(s) * d; }

  /** rotation.y that makes an object's local -Z axis point along the route at s
   *  (its local +X then points to the right, d+). Use heading(s) itself to align local +X with travel. */
  yawAt(s) { return this.heading(s) - Math.PI / 2; }

  /** Nearest route coordinate to a world xz point, searching around sHint (±range). */
  project(x, z, sHint, range = 30) {
    let best = sHint, bestD = Infinity;
    for (let ds = -range; ds <= range; ds += 1) {
      const p = this.toWorld(sHint + ds, 0, 0, _v);
      const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (dd < bestD) { bestD = dd; best = sHint + ds; }
    }
    // refine
    let step = 0.5;
    for (let it = 0; it < 12; it++) {
      const b0 = best;
      for (let k = 0; k < 2; k++) {
        const c = k ? b0 + step : b0 - step;
        const p = this.toWorld(c, 0, 0, _v);
        const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (dd < bestD) { bestD = dd; best = c; }
      }
      step *= 0.5;
    }
    const smp = this.sample(best, _smp);
    const d = (x - smp.pos.x) * smp.right.x + (z - smp.pos.z) * smp.right.z;
    return { s: this.wrap(best), d };
  }

  /** Segment info at s. */
  segmentAt(s) {
    s = this.wrap(s);
    for (const seg of this.segments) if (s >= seg.s0 && s < seg.s1) return seg;
    return this.segments[this.segments.length - 1];
  }
}

const _v = new THREE.Vector3();
const _smp = {};
