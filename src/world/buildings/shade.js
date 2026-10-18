// Vertex colour model for the masonry: per-building stone tint, baked ambient
// occlusion (under cornices and string courses, in reveals, at the base), and a
// per-vertex grime mask (out[3], the colour attribute's alpha) that tells the weathered stone
// materials (grime.js) where to put drip trails, rain-wash streaks and soot crusts:
// under cornice and course soffits, in the splash zone, and all over the facades of the
// few buildings that were never cleaned. out[4] is the building's dirtiness. The large
// soft patches of the stone, and the local variation of its dirtiness, are added per
// pixel by the stone materials. Colour factors are linear multipliers on the albedo.
//
// Run-off below balcony slabs and window sills (soffit occlusion, patchy soot, streaks,
// drip strips under the slab and sill ends) is shaded per pixel by the stone materials:
// FaceShade lists those occluders, and every vertex carries the one above it (aRun, see
// runAttr; a slab's zone reaches BAL_M beyond its ends, where its soot fades out), so
// the wall needs no extra geometry for them.

function ihash(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1]. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = ihash(ix, iy, seed), b = ihash(ix + 1, iy, seed), c = ihash(ix, iy + 1, seed), d = ihash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function hash1(x, seed = 0) { return ihash(x | 0, 0x3c6ef372, seed); }
/** Hash of two integers and a seed in [0, 1) (per-block variation). */
export function hash3(a, b, seed = 0) { return ihash(a | 0, b | 0, seed); }

/**
 * Per-building stone colour: a multiplier around 1 on the library albedo (the baked
 * texture carries the limestone colour). The plan's absolute tints are taken relative
 * to the cream reference, so cream = 1, honey/golden warmer, pale/grey cooler. Wide
 * enough that neighbours read as golden-honey, grey-white or dirty grey stone, as in
 * the street; about one building in seven was never cleaned (sooty grey, streaked).
 */
const CREAM = [0.86, 0.80, 0.68];
export function stoneStyle(plan, rng) {
  const t = plan.style.tint;
  const bright = rng.weighted([[rng.range(0.93, 1.05), 0.6], [rng.range(0.8, 0.92), 0.25], [rng.range(1.05, 1.12), 0.15]]);
  const warm = rng.range(-0.07, 0.07);
  const uncleaned = rng.chance(0.15) ? rng.range(0.7, 1) : 0;
  const tint = [0, 1, 2].map((i) => Math.pow(t[i] / CREAM[i], 1.25) * bright * (1 + warm * (1 - i)));
  return { tint, uncleaned };
}

// current dressed-block variation (see setBlock), applied by trimColor
let blockH = -1;
/** Per-block tone for the next trim stones (h in [0, 1), or -1 for none). */
export function setBlock(h) { blockH = h; }

/**
 * Shading context for one facade face (front or corner return). Precomputes a 1D
 * occlusion / grime table along v and bins the local occluders so per-vertex cost
 * stays tiny. opts: {dirt (0.6..1.3), uncleaned (0..1), sillExt (sill overhang beyond
 * the jambs, m)}.
 */
export class FaceShade {
  constructor(face, tint, seed, opts = {}) {
    this.tint = tint;
    this.seed = seed | 0;
    this.groundAt = face.groundAt;
    this.width = face.width;
    this.dirt = opts.dirt ?? 1;
    this.unc = opts.uncleaned || 0;
    const top = face.cornice ? face.cornice.y : 20;
    this.corniceY = top;
    // 1D AO and grime tables along v (5 cm steps)
    const vMin = -3, vMax = top + 2, step = 0.05;
    const n = Math.ceil((vMax - vMin) / step) + 1;
    const ao = new Float32Array(n).fill(1), gm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = vMin + i * step;
      let a = 1, g = 0.06;
      const dc = top - v;
      if (dc >= 0) {
        a *= 1 - 0.30 * Math.exp(-dc / 0.45) - 0.06 * Math.exp(-dc / 2.0);
        // soot crust right under the cornice soffit, rain wash running down from it
        g += 0.7 * Math.exp(-dc / 0.7) + 0.3 * Math.exp(-dc / 3.5);
      }
      for (const c of face.courses || []) {
        const d = c.y - v;
        if (d >= 0 && d < 1.6) { a *= 1 - 0.13 * Math.exp(-d / 0.22); g += 0.38 * Math.exp(-d / 0.5); }
      }
      // never-cleaned facades: soot heavier towards the top, where rain does not wash
      if (this.unc) g += this.unc * (0.25 + 0.3 * Math.min(1, Math.max(0, v / top)));
      ao[i] = a; gm[i] = g;
    }
    this.ao = ao; this.gm = gm; this.vMin = vMin; this.step = step; this.n = n;
    // run-off occluders: balcony slabs (line = soffit) and window sills (line = underside),
    // with a random strength s and the attribute code (see runAttr)
    this.occ = [];
    const add = (bal, a, b, y, sv) => {
      const s = Math.min(1.98, Math.max(0.02, sv));
      // attribute codes (see runAttr): signed width in 1/64 m, strength in 1/63
      const wq = Math.min(32767, Math.max(1, Math.floor((b - a) * 64)));
      // m: how far beyond its ends an occluder still shades the wall (the soot under a
      // balcony slab spreads a little sideways and fades out there, see grime.js)
      this.occ.push({ bal, a, b, y, s, m: bal ? BAL_M : SILL_M, run: bal ? BAL_RUN : SILL_RUN, wq: bal ? wq : -wq, sq: Math.round(s * 63) });
    };
    for (const b of face.balconies || []) add(true, b.u0, b.u1, b.y - (b.slabT || 0.16), 0.7 + 0.6 * hash1(b.u0 * 31 + b.y * 5, seed));
    const ext = opts.sillExt ?? 0.15, sh = opts.sillH ?? 0.12;
    for (const o of face.openings || []) {
      if (o.kind === 'window') add(false, o.uc - o.w / 2 - ext, o.uc + o.w / 2 + ext, o.y - sh, 0.5 + 0.8 * hash1(o.uc * 13 + o.y * 7, seed));
    }
    this.occ.sort((p, q) => p.y - q.y);
  }

  /** Lines (v) where the run-off occluder above changes: wall rows are cut there. */
  occluderLines() { return this.occ.map((it) => it.y); }

  /** The nearest run-off occluder above (u, v) whose run reaches it, or null. */
  occluderAt(u, v) {
    for (const it of this.occ) {
      if (it.y < v - 1e-3 || it.y - v > it.run) continue;
      if (u > it.a - it.m && u < it.b + it.m) return it;
    }
    return null;
  }

  /**
   * Zones of the wall row va..vc by the occluder whose run-off shades them: the nearest
   * one above that covers u with its margin (a line inside the row counts as above: wall
   * rows are cut at the lines, or a few centimetres from them; of two at the same height
   * the one whose own extent is nearer, so the zone changes half-way across the gap,
   * where both fade out alike), else the horizontally nearest (its run-off is nil there;
   * this keeps one zone change per gap). Returns {cuts: [u1, ...], occ: [occ0, occ1,
   * ...]}: occ[k] holds between cuts[k-1] and cuts[k].
   */
  rowZones(va, vc) {
    const cand = _cand;
    cand.length = 0;
    for (const it of this.occ) if (it.y > va + 1e-3 && it.y - va < it.run) cand.push(it);
    if (!cand.length) return NO_ZONES;
    // (shared arrays: the result is valid until the next call)
    const xs = _xs, pts = _pts;
    xs.length = 0; pts.length = 0;
    for (const it of cand) xs.push(it.a - it.m, it.b + it.m);
    xs.sort(numAsc);
    pts.push(xs[0]);
    for (let i = 1; i < xs.length; i++) pts.push((xs[i - 1] + xs[i]) / 2, xs[i]);
    const cuts = _zones.cuts, occ = _zones.occ;
    cuts.length = 0; occ.length = 0;
    occ.push(zoneWinner(cand, pts[0] - 1));
    for (let i = 0; i < pts.length; i++) {
      const w = zoneWinner(cand, i + 1 < pts.length ? (pts[i] + pts[i + 1]) / 2 : pts[i] + 1);
      if (w !== occ[occ.length - 1]) { cuts.push(pts[i]); occ.push(w); }
    }
    return _zones;
  }

  /** Wall field colour at (u, v) into out[0..2], grime mask into out[3], dirtiness into out[4]. */
  wall(u, v, out) {
    const t = this.tint;
    let i = ((v - this.vMin) / this.step) | 0;
    if (i < 0) i = 0; else if (i >= this.n) i = this.n - 1;
    let a = this.ao[i];
    let g = this.gm[i];
    let r = t[0], gg = t[1], b = t[2];
    // splash zone near the paving: darker, greyer
    const hg = v - this.groundAt(u);
    const gz = hg < 3 ? Math.exp(-Math.max(0, hg) / 0.7) : 0;
    a *= 1 - 0.20 * Math.exp(-Math.max(0, hg) / 0.3);
    g += 0.55 * Math.exp(-Math.max(0, hg) / 0.5);
    g *= this.dirt;
    const grey = Math.min(0.7, 0.45 * gz * this.dirt + 0.35 * this.unc);
    const lum = (r + gg + b) / 3;
    r += (lum * 0.9 - r) * grey; gg += (lum * 0.9 - gg) * grey; b += (lum * 0.93 - b) * grey;
    // never-cleaned stone is darker overall, more so up under the cornice
    const sootK = this.unc ? 1 - this.unc * (0.12 + 0.12 * Math.min(1, Math.max(0, v / this.corniceY))) : 1;
    const dk = a * (1 - 0.18 * gz * this.dirt) * sootK;
    out[0] = r * dk; out[1] = gg * dk; out[2] = b * dk;
    out[3] = g;
    out[4] = this.dirt;
  }
}

// run-off: reach below the sill / slab line; zone margin beyond the occluder ends
// (the stone shader fades a slab's soot out by 1.05 m beyond its ends: keep BAL_M above that)
const SILL_RUN = 3.4, BAL_RUN = 3.8, SILL_M = 0.25, BAL_M = 1.1;
const NO_ZONES = { cuts: [], occ: [null] };
const _cand = [], _xs = [], _pts = [], _zones = { cuts: [], occ: [] };
const numAsc = (p, q) => p - q;
/**
 * The occluder whose run-off shades u: covering ones (within their margin) by height,
 * then by the distance to their own extent; else the horizontally nearest.
 */
function zoneWinner(cand, u) {
  let best = null, bd = Infinity;
  for (let i = 0; i < cand.length; i++) {
    const it = cand[i];
    const d = u < it.a - it.m ? it.a - it.m - u : u > it.b + it.m ? u - it.b - it.m : 0;
    const key = d > 0 ? 1e3 + d : it.y + 0.002 * (u < it.a ? it.a - u : u > it.b ? u - it.b : 0);
    if (key < bd) { bd = key; best = it; }
  }
  return best;
}

/**
 * aRun attribute (int16 × 4) of a vertex at facade (u, v) shaded by occluder `it` (null:
 * none): ((a − u) · 256, (line − v) · 256, ⌊dirtiness · 128⌉ · 128 + ⌊s · 63⌉, ±⌊width · 64⌋),
 * + balcony slab, − window sill, 0 none. Both offsets are affine in the position, so they
 * interpolate exactly over any face (4 mm steps, ±128 m); the shader (grime.js) decodes
 * the last two into the building's dirtiness and the occluder code.
 */
export function runAttr(it, u, v, dirt, out, k) {
  const dq = Math.round(dirt * 128);
  const z = (dq < 0 ? 0 : dq > 255 ? 255 : dq) * 128;
  if (!it) { out[k] = 0; out[k + 1] = 0; out[k + 2] = z; out[k + 3] = 0; return; }
  const x = (it.a - u) * 256, y = (it.y - v) * 256;
  out[k] = x > 32767 ? 32767 : x < -32767 ? -32767 : Math.round(x);
  out[k + 1] = y > 32767 ? 32767 : y < -32767 ? -32767 : Math.round(y);
  out[k + 2] = z + it.sq;
  out[k + 3] = it.wq;
}

/**
 * Colour of dressed trim stone (surrounds, mouldings): slightly lighter, soffits darker
 * and sootier, tops collecting dirt; per-block tone when setBlock() is active.
 */
export function trimColor(fs, u, v, nv, out, k = 1.04) {
  fs.wall(u, v, out);
  const soffit = nv < -0.3 ? 0.78 : 1;
  let kr = k * soffit, kg = kr, kb = kr;
  if (blockH >= 0) {
    // dressed blocks differ in tone from one another (different beds of the quarry)
    const s = 0.93 + 0.13 * blockH, wc = (hash1(blockH * 7919, 5) - 0.5) * 0.04;
    kr *= s * (1 + wc); kg *= s; kb *= s * (1 - wc);
  }
  out[0] *= kr; out[1] *= kg; out[2] *= kb;
  if (nv < -0.3) out[3] = Math.min(1, out[3] + 0.35);
  else if (nv > 0.5) out[3] = Math.min(1, out[3] + 0.25);
}
