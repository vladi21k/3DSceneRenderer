// Ashlar laid to the openings. The stone textures are row layouts (courses of blocks of
// random length) that the material shaders derive analytically from integer hashes;
// this is the same layout in JS, so the masonry can choose, per course and per run of
// wall between two openings, a texture transform that puts a head joint exactly on
// each jamb (or on the outer edge of a surround, pilaster or quoin block) instead of a
// few centimetres beside it. Runs between two jambs get a small stretch (a few percent)
// so both ends land on joints; runs with one jamb are only shifted.
//
// Layout (see the materials' row layout): rows of height rowH along tv; row r (tile row
// = global row mod rows) has n ∈ [segMin, segMax] segments with jittered boundaries,
// periodic in tu with the tile width W; each global row is shifted along tu by a hash.

// ---- the integer hashes of the material shaders (uint arithmetic)
function sfH(x) {
  x >>>= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
const sfH2 = (a, b, s) => sfH(((a + 0x20000000) >>> 0) ^ sfH((((b + 0x20000000) >>> 0) + sfH(s >>> 0)) >>> 0));
const sfHf = (h) => (h >>> 8) * (1 / 16777216);
const sfHash = (x, y, s) => sfHf(sfH2(x, y, s));
const sfMod = (a, m) => a - m * Math.floor(a / m);

/** Row layout of a library material from its live shader uniforms, or null. */
export function rowLayout(uniforms) {
  const t = uniforms && uniforms.sfTile && uniforms.sfTile.value;
  const l = uniforms && uniforms.sfLay && uniforms.sfLay.value;
  const l2 = uniforms && uniforms.sfLay2 && uniforms.sfLay2.value;
  if (!t || !l || !l2 || !(l.y > 0.5)) return null;
  return { W: t.z, rowH: l.x, rows: Math.round(l.y), segMin: Math.round(l.z), segMax: Math.round(l.w), jitter: l2.x, seed: Math.round(l2.y), shift: l2.z > 0.5 };
}

const jointCache = new Map();

/** Sorted head-joint positions (texture metres, within [0, W)) of global row rg. */
function rowJoints(lay, rg) {
  const key = `${lay.W}|${lay.seed}|${lay.rows}|${rg}`;
  let J = jointCache.get(key);
  if (J) return J;
  const r = sfMod(rg, lay.rows);
  const n = lay.segMin + Math.floor(sfHash(r, 977, lay.seed) * (lay.segMax - lay.segMin + 1) * 0.99999);
  const L = lay.W / n;
  const shift = lay.shift ? sfHash(rg, 4111, lay.seed + 7) * lay.W : 0;
  J = [];
  for (let k = 0; k < n; k++) {
    const b = (k + lay.jitter * (sfHash(r, sfMod(k, n), lay.seed + 31) - 0.5)) * L;
    J.push(sfMod(b - shift, lay.W));
  }
  J.sort((a, b) => a - b);
  if (jointCache.size > 4096) jointCache.clear();
  jointCache.set(key, J);
  return J;
}

/** The `n` joints of row rg nearest to texture position T (unwrapped), nearest first. */
function nearest(lay, J, T, n, out) {
  const W = lay.W, m = J.length;
  const base = Math.floor(T / W) * W, t = T - base;
  let lo = 0, hi = m;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (J[mid] < t) lo = mid + 1; else hi = mid; }
  // walk outwards from t over the periodic joint list (index k → J[k mod m] + ⌊k/m⌋ W)
  const at = (k) => base + J[((k % m) + m) % m] + Math.floor(k / m) * W;
  let r = lo, l = lo - 1;
  out.length = 0;
  while (out.length < n) {
    const xr = at(r), xl = at(l);
    if (xr - T <= T - xl) { out.push(xr); r++; } else { out.push(xl); l--; }
  }
  return out;
}
const _ca = [], _cb = [], _cc = [], _cd = [], _cn = [0, 0];

/**
 * Per-face joint fitter. uvx: the face's base transform [su, ou, sv, ov] (tu = u su + ou,
 * tv = v sv + ov); width: face width; rects: [{a, b, v0, v1}] facade-local areas the
 * wall does not show (openings widened by their surrounds, pilasters, quoin blocks);
 * their sides are the jambs runs are fitted to.
 */
export class JointFitter {
  constructor(lay, uvx, width, rects) {
    this.lay = lay;
    this.su = uvx[0]; this.ou = uvx[1]; this.sv = uvx[2]; this.ov = uvx[3];
    this.W = width;
    this.rects = rects;
    this.courses = new Map();
  }
  /** Global texture row of wall height v. */
  row(v) { return Math.floor((v * this.sv + this.ov) / this.lay.rowH); }
  /** Wall height of the bed joint below texture row rg. */
  bed(rg) { return (rg * this.lay.rowH - this.ov) / this.sv; }

  /** Fitted runs of course rg: [{a, b, k, off}] sorted by a (tu = u k + off). */
  runs(rg) {
    let R = this.courses.get(rg);
    if (R) return R;
    const vm = this.bed(rg + 0.5);
    const cut = [];
    for (const r of this.rects) if (vm > r.v0 && vm < r.v1 && r.b > 0 && r.a < this.W) cut.push(r);
    cut.sort((p, q) => p.a - q.a);
    R = [];
    let a = 0, ja = false;
    for (const r of cut) {
      if (r.a - a > 0.02) R.push(this.fit(rg, a, r.a, ja, true));
      if (r.b > a) { a = r.b; ja = true; }
    }
    if (this.W - a > 0.02) R.push(this.fit(rg, a, this.W, ja, false));
    this.courses.set(rg, R);
    return R;
  }

  /** Transform for run [a, b] of row rg with jambs at its start (ja) and/or end (jb). */
  fit(rg, a, b, ja, jb) {
    const { su, ou, lay } = this;
    const run = { a, b, k: su, off: ou };
    if (!ja && !jb) return run;
    const J = rowJoints(lay, rg);
    if (ja !== jb) {
      // one jamb: shift the nearest joint onto it
      const u = ja ? a : b;
      const x = nearest(lay, J, u * su + ou, 1, _ca)[0];
      run.off = x - u * su;
      return run;
    }
    // two jambs: both ends on joints with the least stretch, or one end on a joint and
    // the other well clear of the nearest joint (no sliver)
    const len = b - a, Ta = a * su + ou;
    let best = Infinity;
    for (const xa of nearest(lay, J, Ta, 4, _cd)) {
      const drift = Math.abs(xa - Ta) * 0.02;
      for (const xb of nearest(lay, J, xa + len * su, 3, _cb)) {
        if (xb <= xa + 0.05) continue;
        const k = (xb - xa) / len;
        const c = Math.abs(Math.log(k / su)) * 2.5 + drift;
        if (c < best) { best = c; run.k = k; run.off = xa - a * k; }
      }
      const xe = xa + len * su;
      const d = Math.abs(nearest(lay, J, xe, 1, _cc)[0] - xe) / su;
      const c = (d < 0.004 ? 0 : d < 0.15 ? 1.2 - d * 4 : 0.3) + drift;
      if (c < best) { best = c; run.k = su; run.off = xa - a * su; }
    }
    return run;
  }

  /**
   * Split wall run [ra, rb] of course rg into pieces with their transforms, appended to
   * out as [pa, pb, k, off, ...]. Parts hidden behind a widened rect (under a surround,
   * below a sill) continue the nearer fitted run.
   */
  pieces(rg, ra, rb, out) {
    out.length = 0;
    const R = this.runs(rg);
    if (!R.length) { out.push(ra, rb, this.su, this.ou); return out; }
    let cur = ra;
    for (let i = 0; i < R.length && cur < rb - 1e-4; i++) {
      const r = R[i];
      if (r.b <= cur + 1e-4) continue;
      if (r.a > cur + 1e-4) {
        // gap (hidden part): continue the nearer neighbour
        const g1 = Math.min(rb, r.a), prev = R[i - 1];
        const usePrev = prev && (cur - prev.b) <= (r.a - g1);
        const t = usePrev ? prev : r;
        out.push(cur, g1, t.k, t.off);
        cur = g1;
        if (cur >= rb - 1e-4) break;
      }
      const e = Math.min(rb, r.b);
      out.push(cur, e, r.k, r.off);
      cur = e;
    }
    if (cur < rb - 1e-4) { const t = R[R.length - 1]; out.push(cur, rb, t.k, t.off); }
    return out;
  }

  /**
   * Wall u of the first head joint of course rg past u in direction dir (±1), at least
   * minGap away, with the fitted transform at u; u + dir · maxLen when there is none.
   */
  nextJoint(rg, u, dir, minGap = 0.2, maxLen = 2) {
    const tr = this.at(rg, u, _cn);
    const k = tr[0], off = tr[1], T = u * k + off;
    const J = rowJoints(this.lay, rg);
    let best = Infinity;
    for (const x of nearest(this.lay, J, T + dir * (minGap + 0.3) * k, 8, _cc)) {
      const d = ((x - T) * dir) / k;
      if (d >= minGap && d < best) best = d;
    }
    return u + dir * Math.min(best, maxLen);
  }

  /**
   * Wall u of the head joints of course rg strictly inside (ua, ub) under the piece
   * transform tu = u k + off (k > 0), appended to out in order.
   */
  headJoints(rg, ua, ub, k, off, out) {
    const W = this.lay.W, J = rowJoints(this.lay, rg);
    const Ta = ua * k + off, Tb = ub * k + off;
    for (let t = Math.floor(Ta / W); t * W < Tb; t++) {
      for (let i = 0; i < J.length; i++) {
        const T = t * W + J[i];
        if (T > Ta + 1e-4 && T < Tb - 1e-4) out.push((T - off) / k);
      }
    }
    return out;
  }

  /** Integer id of the texture block of course rg at wall u (transform tu = u k + off). */
  blockId(rg, u, k, off) {
    const W = this.lay.W, J = rowJoints(this.lay, rg), T = u * k + off;
    const t = Math.floor(T / W), x = T - t * W;
    let i = 0;
    while (i < J.length && J[i] <= x) i++;
    return t * J.length + i;
  }

  /** Transform at u in course rg (for spandrel pieces): [k, off]. */
  at(rg, u, out) {
    const R = this.runs(rg);
    let t = null, bd = Infinity;
    for (const r of R) {
      const d = u < r.a ? r.a - u : u > r.b ? u - r.b : 0;
      if (d < bd) { bd = d; t = r; }
    }
    out[0] = t ? t.k : this.su; out[1] = t ? t.off : this.ou;
    return out;
  }
}
