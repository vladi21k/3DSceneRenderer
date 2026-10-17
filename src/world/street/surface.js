import { CHUNK_LEN } from '../../core/config.js';
import {
  railDist, BAND_IN, CORRIDOR, GUTTER_OUT, GUTTER_W, SIDEWALK_RISE, FACADE_OVERLAP, TRACK_OFFSET,
} from './constants.js';
import { PeriodicField } from './noise.js';
import { makeDelta } from './fast.js';

// The street surface as a function of route coordinates: height (camber, crown between
// the rails, dished gutters, sidewalk cross-fall, millimetre unevenness) and a dirt /
// wear multiplier used as paving vertex colour. Rail tops are at h = 0 and the paving
// meets them exactly, so the rail edges are pinned to zero.
//
// Ground contract: the large-scale ground shape outside the corridor is the shared
// route.surface(s, d) (applied by route.toWorld to everything placed on the street), so
// the paving adds it too. The street's own geometric relief stays within a few
// millimetres on the sidewalks and is flattened under cafés and street furniture, so
// objects placed at h = 0 neither sink nor float. Cast-iron covers and tree grates lie
// on a planar bed (the ground's mean slope over the cover), blended back into the
// ground just outside them, and over the last FACADE_BLEND metres the sidewalk meets
// each building's own ground line (its frame's chord), so facades stand on it exactly.
// The visible unevenness (settlement along the rails, dishing at gullies, undulating
// sheen) lives in a separate shading height that only drives the paving normals.
//
// Periodic street coordinate: textures and noise along the street use sp = s·Lp/L with
// Lp a multiple of 256 m that every noise table and paving tile divides, so the loop
// wraps from s = L to 0 without a seam.

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// cover beds blend back into the ground over this distance outside the cover (m)
const BED_BLEND = 0.45;
// the paving meets each building's ground line over this distance before its facade (m)
const FACADE_BLEND = 0.9;

export class Surface {
  constructor(route, layout) {
    this.route = route;
    this.layout = layout;
    this.dl = makeDelta(route.length);   // fast signed route distance
    // height unevenness: 16 m settlement down to 1 m undulation (cell 0.5 m, period 128 m)
    this.fH = new PeriodicField(11, { octaves: [[32, 1], [16, 0.55], [8, 0.3], [4, 0.16], [2, 0.06]] });
    // dirt / tone variation: broad patches and finer blotches
    this.fG = new PeriodicField(23, { octaves: [[64, 1], [32, 0.6], [16, 0.35], [8, 0.2], [4, 0.1]] });
    this.fD = new PeriodicField(37, { cell: 0.1, octaves: [[64, 1], [32, 0.6], [16, 0.4], [8, 0.25], [4, 0.15], [2, 0.08]] });
    // periodic coordinate and the lookup ratios that keep every noise field periodic in it
    const L = route.length;
    this.Lp = 256 * Math.max(1, Math.round(L / 256));
    this.kP = this.Lp / L;
    const per = (x, period) => Math.round((x * this.Lp) / period) / (this.Lp / period);
    this.kH = [per(0.613, 128), per(0.11, 128)];
    this.kD = [per(0.71, 25.6), per(0.13, 25.6)];
    this.kW = per(1.7, 128);
    this.hShade = 0;       // shading height of the last height() call
    this.spotCache = new Map();
    this.planner = null;     // (chunkIndex) => [{s, d, r}], set by the street module
    this._ri = {};
    // mouth geometry per (cross street, side), facade lines per lot
    this.mouths = new Map();
    this.lotLines = new Map();
  }

  // ------------------------------------------------------------------ per-row context
  /** Restrict per-row lookups to the crossovers / cross streets near [s0, s1] (set at
   *  the start of a chunk build; rows outside the window fall back to the full lists). */
  focus(s0, s1) {
    const dl = this.dl, L = this.layout;
    const mid = (s0 + s1) / 2, half = (s1 - s0) / 2 + 40;
    this.near = {
      mid, half,
      xo: L.crossovers.filter((c) => dl(mid, c.s0) < half + 6 && dl(mid, c.s1) > -half - 6),
      cs: L.crossStreets.filter((c) => Math.abs(dl(mid, c.s)) < half + c.width / 2 + 2),
    };
  }

  _lists(s) {
    const n = this.near;
    if (n && Math.abs(this.dl(n.mid, s)) < n.half) return n;
    return this._all || (this._all = { xo: this.layout.crossovers, cs: this.layout.crossStreets });
  }

  /** Everything that depends only on s; reuse `out` to avoid allocation. */
  rowInfo(s, out = {}) {
    const L = this.layout, dl = this.dl;
    const lists = this._lists(s);
    let xo = 0;
    for (const c of lists.xo) {
      const a = dl(c.s0, s), b = dl(c.s1, s);
      xo = Math.max(xo, smooth(Math.min(a + 4.5, 4.5 - b) / 2));
    }
    out.s = s;
    out.sp = s * this.kP;
    out.xo = xo;
    out.hwL = L.halfWidth(s, -1);
    out.hwR = L.halfWidth(s, 1);
    // facades, and the sidewalks' outer edges: under the facades (which can stand
    // beyond halfWidth, e.g. where it widens at stations), or along a mouth line
    const fL = out.fL = this.facadeAt(s, -1, out.fL || {});
    const fR = out.fR = this.facadeAt(s, 1, out.fR || {});
    out.edgeL = this.edgeD(s, -1, fL.d === fL.d ? Math.max(out.hwL, -fL.d) : out.hwL, lists.cs);
    out.edgeR = this.edgeD(s, 1, fR.d === fR.d ? Math.max(out.hwR, fR.d) : out.hwR, lists.cs);
    // flat spots (tree pits, covers) whose span overlaps this row
    const ci = L.chunkIndex(s);
    const list = out.spots || (out.spots = []);
    list.length = 0;
    for (let k = -1; k <= 1; k++) {
      const sp = this.spots(ci + k);
      for (let i = 0; i < sp.length; i++) {
        const p = sp[i];
        const ds = dl(p.s, s);
        if (ds < p.r + 0.7 && ds > -p.r - 0.7) list.push(p, ds);
      }
    }
    return out;
  }

  spots(ci) {
    const n = this.layout.nChunks;
    ci = ((ci % n) + n) % n;
    let v = this.spotCache.get(ci);
    if (!v) {
      v = this.planner ? this.planner(ci) : [];
      if (this.spotCache.size > 96) this.spotCache.delete(this.spotCache.keys().next().value);
      this.spotCache.set(ci, v);
    }
    return v;
  }

  // ------------------------------------------------------------------ mouths
  mouth(c, side) {
    const key = c.s * 4 + side;
    let m = this.mouths.get(key);
    if (!m) {
      const r = this.route, smp = r.sample(c.s, {});
      const hw = this.layout.halfWidth(c.s, side);
      const start = r.toWorld(c.s, side * hw, 0);
      const along = smp.tanH.clone();
      const out = smp.right.clone().multiplyScalar(side);
      const ca = Math.cos(c.angle || 0), sa = Math.sin(c.angle || 0);
      // rotate about +Y (same convention as Vector3.applyAxisAngle)
      const dirOut = { x: out.x * ca + out.z * sa, y: 0, z: -out.x * sa + out.z * ca };
      m = { c, side, hw, start, along, dirOut, len: c.depth + 16 + 30 };
      this.mouths.set(key, m);
    }
    return m;
  }

  /** Outer edge of the sidewalk at s on `side` (signed d): under the facades, or the
   *  straight mouth line of a cross street. */
  edgeD(s, side, hw, list = this.layout.crossStreets) {
    // same test as layout.isInCrossStreet(s, side, 0), over a (pre-filtered) list
    let c = null;
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      if (x.side !== side && x.side !== 0) continue;
      if (Math.abs(this.dl(x.s, s)) < x.width / 2) { c = x; break; }
    }
    if (!c) return side * (hw + FACADE_OVERLAP);
    return this.mouthD(this.mouth(c, side), s);
  }

  // ------------------------------------------------------------------ facades
  /** Facade line of a main-street lot: its frame's chord and ground at both ends. */
  lotLine(lot) {
    let f = this.lotLines.get(lot);
    if (!f) {
      const F = lot.frame;
      f = { start: F.origin, along: F.uDir, width: F.width, g0: F.ground0, g1: F.ground1 };
      if (this.lotLines.size > 512) this.lotLines.delete(this.lotLines.keys().next().value);
      this.lotLines.set(lot, f);
    }
    return f;
  }

  /** Where the cross-section at s meets the facade of the lot fronting the street on
   *  `side`: out.d (signed lateral offset) and out.g (the building's own ground line
   *  there, above the route elevation: facades stand their thresholds on it); out.d is
   *  NaN in mouths and gaps. */
  facadeAt(s, side, out = {}) {
    const L = this.layout, ci = L.chunkIndex(s), dl = this.dl;
    out.d = NaN;
    for (let k = -1; k <= 1; k++) {
      for (const lot of L.inChunk('lots', ci + k)) {
        if (lot.side !== side) continue;
        const a = dl(lot.s0, s);
        if (a < 0 || a > lot.len) continue;
        const f = this.lotLine(lot);
        const d = this.mouthD(f, s), smp = this._smp;
        const u = (smp.pos.x + smp.right.x * d - f.start.x) * f.along.x + (smp.pos.z + smp.right.z * d - f.start.z) * f.along.z;
        const t = Math.max(0, Math.min(1, u / f.width));
        out.d = d;
        out.g = f.g0 + (f.g1 - f.g0) * t - smp.pos.y;
        return out;
      }
    }
    return out;
  }

  /** Signed lateral offset where the cross-section at s meets the line through m.start
   *  along m.along (a mouth line or a facade chord). */
  mouthD(m, s) {
    const smp = this.route.sample(s, this._smp || (this._smp = {}));
    const bx = m.start.x - smp.pos.x, bz = m.start.z - smp.pos.z;
    const rx = smp.right.x, rz = smp.right.z, ax = m.along.x, az = m.along.z;
    const det = -rx * az + ax * rz;
    return (-bx * az + ax * bz) / det;
  }

  // ------------------------------------------------------------------ height
  /** Periodic street coordinate of route s (for UVs along the street). */
  sp(s) { return s * this.kP; }

  noiseH(sp, d) {
    const k = this.kH;
    return 0.68 * this.fH.sample(sp, d) + 0.32 * this.fH.sample(sp * k[0] + d * 0.11 + 71.3, d * 0.613 - sp * k[1] + 13.7);
  }

  /** Height above the route elevation at lateral offset d for the row `ri`; also sets
   *  this.hShade (the height the paving normals are computed from).
   *  ci: colInfo(d) when the caller has it precomputed. */
  height(ri, d, ci = colInfo(d, this._ci || (this._ci = {}))) {
    let h = ci.h0, amp = ci.amp, mask = ci.mask, trough = ci.trough, sa = ci.shadeAmp;
    if (ci.zone === Z_CORR) { const k = 1 - ri.xo; h *= k; amp *= k; trough *= k; sa *= k; }
    else if (ci.zone === Z_WALK) {
      const edge = d > 0 ? ri.edgeR : -ri.edgeL;
      mask *= smooth((edge - FACADE_OVERLAP * 0.5 - (d < 0 ? -d : d)) / 1.6);
    }
    // flat spots (covers, tree pits, furniture, café floors) and dishing towards drains;
    // cast-iron covers lie on a planar bed (bedW: weight of the nearest bed)
    let dish = 0, bedW = 0, bedH = 0;
    const sp = ri.spots;
    for (let i = 0; i < sp.length; i += 2) {
      const p = sp[i], ds = sp[i + 1];
      let q;
      if (p.rect) q = Math.max(ds < 0 ? -ds - p.hs : ds - p.hs, p.d0 - d, d - p.d1);
      else { const dd = d - p.d; q = Math.sqrt(ds * ds + dd * dd) - p.r; }
      if (q < 0.5) mask *= smooth(q / 0.5);
      if (p.dish && q < 0.6) dish = Math.max(dish, 1 - smooth(q / 0.6));
      if (p.bed && q < BED_BLEND) {
        const w = 1 - smooth(q / BED_BLEND);
        if (w > bedW) { bedW = w; bedH = this.bedAt(p, ds, d); }
      }
    }
    let n = 0;
    if (mask > 0 && (amp > 0 || sa > 0)) n = this.noiseH(ri.sp, d);
    h += amp * mask * n;
    // mortar settlement trough along the rails, deeper in places
    const hs = sa * mask * n + trough * (0.65 + 0.35 * n) - 0.005 * dish;
    if (this.route.surfaceEnabled) {
      let g = this.ground(ri.s, d, ri);
      if (bedW > 0) g += (bedH - g) * bedW;
      h += g;
    }
    this.hShade = h + hs;
    return h;
  }

  /** The shared ground (route.surface) at (s, d), meeting each building's own ground
   *  line over the last FACADE_BLEND metres before (and under) its facade. ri: the row
   *  context of s when the caller has it. */
  ground(s, d, ri = null) {
    const g = this.route.surface(s, d);
    if (d > -GUTTER_OUT && d < GUTTER_OUT) return g;
    const f = ri ? (d > 0 ? ri.fR : ri.fL) : this.facadeAt(s, d > 0 ? 1 : -1, this._fa || (this._fa = {}));
    if (!(f.d === f.d)) return g;    // NaN: mouth or gap
    const x = (d > 0 ? d - f.d : f.d - d) + FACADE_BLEND;
    return x <= 0 ? g : g + (f.g - g) * smooth(x / FACADE_BLEND);
  }

  /** Height of the shared ground (route.surface) on the planar bed of cover spot p, at
   *  ds along the street from its centre and lateral offset d. The plane takes the
   *  ground's mean slope over the cover, so the cast iron lies flat and flush. */
  bedAt(p, ds, d) {
    let b = p.plane;
    if (!b) {
      const e = Math.max(0.3, p.r * 0.7);
      const g0 = this.ground(p.s, p.d);
      b = p.plane = [
        g0,
        (this.ground(p.s + e, p.d) - this.ground(p.s - e, p.d)) / (2 * e),
        (this.ground(p.s, p.d + e) - this.ground(p.s, p.d - e)) / (2 * e),
      ];
    }
    return b[0] + b[1] * ds + b[2] * (d - p.d);
  }

  /** Public: paving height above the route elevation at (s, d). */
  heightAt(s, d) { return this.height(this.rowInfo(s, this._ri), d); }

  // ------------------------------------------------------------------ dirt / tone
  /** Writes a paving colour multiplier for (row, d) into out[o..o+2]. */
  tone(ri, d, out, o, ci = colInfo(d, this._ci || (this._ci = {}))) {
    const s = ri.sp, k = this.kD;
    const n1 = this.fG.sample(s * 0.5, d * 0.5 + 40);
    // fine blotches: two differently scaled lookups so the 25.6 m table period never shows
    const n2 = 0.62 * this.fD.sample(s, d) + 0.38 * this.fD.sample(s * k[0] + d * 0.13 + 37.7, d * 0.71 - s * k[1] + 11.3);
    let v = (1 + 0.11 * n1) * (1 + 0.09 * n2) * ci.v;
    let warm = ci.warm;
    if (ci.zone === Z_CORR) {
      v *= (1 - ci.drip * (0.6 + 0.4 * n2)) * (1 - ri.xo * ci.xoTone);
    } else if (ci.zone === Z_GUTTER) {
      // damp, dirty streaks along the channel
      v *= (1 + 0.05 * n2) * (1 - 0.15 * smooth((n2 - 0.3) / 0.3));
    } else if (ci.zone === Z_WALK) {
      const a = d < 0 ? -d : d;
      const edge = d > 0 ? ri.edgeR : -ri.edgeL;
      // grime along the facades, heavier in patches (doorways, shop fronts)
      v *= 1 - (0.12 + 0.12 * smooth(n1 + 0.2)) * Math.exp(-Math.max(0, edge - FACADE_OVERLAP - a) / 0.45);
      // soil and leaf litter around tree pits
      const sp = ri.spots;
      for (let i = 0; i < sp.length; i += 2) {
        const p = sp[i];
        if (!p.tree) continue;
        const ds = sp[i + 1], dd = d - p.d;
        const q = Math.sqrt(ds * ds + dd * dd) - p.r;
        if (q < 1.2) { const k = 1 - smooth(q / 1.2); v *= 1 - 0.1 * k; warm += 0.04 * k; }
      }
    }
    const hue = 0.014 * n1;
    out[o] = v * (1 + hue + warm);
    out[o + 1] = v * (1 + warm * 0.25);
    out[o + 2] = v * (1 - hue - warm * 0.8);
  }
}

export const Z_CORR = 0, Z_BAND = 1, Z_GUTTER = 2, Z_WALK = 3;

/** The s-independent part of the cross-section at d: base height (camber, crown between
 *  the rails, dished gutter, sidewalk cross-fall), noise amplitude and mask, and the
 *  static dirt factors (grime along the rails, oil drips, dark gutter). */
export function colInfo(d, out = {}) {
  const a = d < 0 ? -d : d;
  out.drip = 0; out.xoTone = 0; out.warm = 0; out.mask = 1; out.trough = 0;
  if (a < BAND_IN) {
    const e = railDist(d);
    const g1 = Math.exp(-e / 0.045), g2 = Math.exp(-e / 0.22);
    const dc = a - TRACK_OFFSET;
    out.zone = Z_CORR;
    out.h0 = 0.0035 * smooth(e / 0.45);
    out.amp = 0.0022;
    out.shadeAmp = 0.011;
    out.mask = smooth(e / 0.28);
    // settled setts 0.1-0.4 m beside the mortar strips (shading only)
    out.trough = -0.0045 * smooth((e - 0.07) / 0.09) * (1 - smooth((e - 0.24) / 0.3));
    out.v = 1 - 0.24 * g1 - 0.08 * g2;
    out.warm = 0.05 * g1 + 0.02 * g2;
    out.drip = 0.07 * Math.exp(-(dc * dc) / 0.05);
    out.xoTone = 0.1 * Math.exp(-e / 0.1);
  } else if (a < CORRIDOR) {
    const t = (a - BAND_IN) / (CORRIDOR - BAND_IN);
    out.zone = Z_BAND;
    out.h0 = 0.0035 - 0.0055 * t;
    out.amp = 0.001;
    out.shadeAmp = 0.004;
    out.v = 1 - 0.1 * smooth(t);
  } else if (a < GUTTER_OUT) {
    const t = ((a - CORRIDOR) / GUTTER_W) * 2 - 1;
    out.zone = Z_GUTTER;
    out.h0 = -0.006 + 0.004 * t * t;       // shallow V towards the gully grates
    out.amp = 0.0008;
    out.shadeAmp = 0.004;
    out.v = 0.7 + 0.08 * t * t;
    out.warm = 0.02;
  } else {
    out.zone = Z_WALK;
    // level walking surface (h = 0, where furniture, cafés and people stand), easing
    // down into the gutter; the cross-fall itself is left to route.surface
    out.h0 = SIDEWALK_RISE - 0.0025 * (1 - smooth((a - GUTTER_OUT) / 0.6));
    out.amp = 0.0015;      // geometric: objects stand at h = 0 within ±1.5 mm
    out.shadeAmp = 0.012;  // the visible unevenness is in the normals
    out.v = 1 - 0.06 * Math.exp(-(a - GUTTER_OUT) / 0.25);
  }
  return out;
}

export { CHUNK_LEN };
