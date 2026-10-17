import { CHUNK_LEN } from '../../core/config.js';
import {
  railDist, BAND_IN, CORRIDOR, GUTTER_OUT, GUTTER_W, SIDEWALK_RISE, FACADE_OVERLAP, TRACK_OFFSET,
} from './constants.js';
import { PeriodicField } from './noise.js';

// The street surface as a function of route coordinates: height (camber, crown between
// the rails, dished gutters, sidewalk cross-fall, millimetre unevenness) and a dirt /
// wear multiplier used as paving vertex colour. Rail tops are at h = 0 and the paving
// meets them exactly, so the rail edges are pinned to zero.

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class Surface {
  constructor(route, layout) {
    this.route = route;
    this.layout = layout;
    // height unevenness: 16 m settlement down to 1 m undulation (cell 0.5 m, period 128 m)
    this.fH = new PeriodicField(11, { octaves: [[32, 1], [16, 0.55], [8, 0.3], [4, 0.16], [2, 0.06]] });
    // dirt / tone variation: broad patches and finer blotches
    this.fG = new PeriodicField(23, { octaves: [[64, 1], [32, 0.6], [16, 0.35], [8, 0.2], [4, 0.1]] });
    this.fD = new PeriodicField(37, { cell: 0.1, octaves: [[64, 1], [32, 0.6], [16, 0.4], [8, 0.25], [4, 0.15], [2, 0.08]] });
    this.spotCache = new Map();
    this.planner = null;     // (chunkIndex) => [{s, d, r}], set by the street module
    this._ri = {};
    // mouth geometry per (cross street, side)
    this.mouths = new Map();
  }

  // ------------------------------------------------------------------ per-row context
  /** Everything that depends only on s; reuse `out` to avoid allocation. */
  rowInfo(s, out = {}) {
    const L = this.layout, r = this.route;
    let xo = 0;
    for (const c of L.crossovers) {
      const a = r.delta(c.s0, s), b = r.delta(c.s1, s);
      xo = Math.max(xo, smooth(Math.min(a + 4.5, 4.5 - b) / 2));
    }
    out.s = s;
    out.xo = xo;
    out.hwL = L.halfWidth(s, -1);
    out.hwR = L.halfWidth(s, 1);
    out.edgeL = this.edgeD(s, -1, out.hwL);
    out.edgeR = this.edgeD(s, 1, out.hwR);
    // flat spots (tree pits, covers) whose span overlaps this row
    const ci = L.chunkIndex(s);
    const list = out.spots || (out.spots = []);
    list.length = 0;
    for (let k = -1; k <= 1; k++) {
      for (const sp of this.spots(ci + k)) {
        const ds = r.delta(sp.s, s);
        if (Math.abs(ds) < sp.r + 0.6) list.push(sp, ds);
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
  edgeD(s, side, hw) {
    const c = this.layout.isInCrossStreet(s, side, 0);
    if (!c) return side * (hw + FACADE_OVERLAP);
    return this.mouthD(this.mouth(c, side), s);
  }

  /** Signed lateral offset where the cross-section at s meets the mouth line. */
  mouthD(m, s) {
    const smp = this.route.sample(s, this._smp || (this._smp = {}));
    const bx = m.start.x - smp.pos.x, bz = m.start.z - smp.pos.z;
    const rx = smp.right.x, rz = smp.right.z, ax = m.along.x, az = m.along.z;
    const det = -rx * az + ax * rz;
    return (-bx * az + ax * bz) / det;
  }

  // ------------------------------------------------------------------ height
  noiseH(s, d) {
    return 0.68 * this.fH.sample(s, d) + 0.32 * this.fH.sample(s * 0.613 + d * 0.11 + 71.3, d * 0.613 - s * 0.11 + 13.7);
  }

  /** Height above the route elevation at lateral offset d for the row `ri`. */
  height(ri, d) {
    const a = d < 0 ? -d : d;
    let h, amp, mask = 1;
    if (a < BAND_IN) {
      const e = railDist(d);
      h = 0.0035 * smooth(e / 0.45) * (1 - ri.xo);
      amp = 0.0022 * (1 - ri.xo);
      mask = smooth(e / 0.28);
    } else if (a < CORRIDOR) {
      const t = (a - BAND_IN) / (CORRIDOR - BAND_IN);
      h = 0.0035 - 0.0055 * t;
      amp = 0.0010;
    } else if (a < GUTTER_OUT) {
      const t = ((a - CORRIDOR) / GUTTER_W) * 2 - 1;
      h = -0.011 + 0.009 * t * t;
      amp = 0.0008;
    } else {
      const x = a - GUTTER_OUT;
      const rise = SIDEWALK_RISE + 0.002;
      h = -0.002 + rise * smooth(x / 4.4);
      amp = 0.0042;
      const edge = d > 0 ? ri.edgeR : -ri.edgeL;
      mask = smooth((edge - FACADE_OVERLAP * 0.5 - a) / 1.6);
    }
    if (mask > 0) {
      const sp = ri.spots;
      for (let i = 0; i < sp.length; i += 2) {
        const p = sp[i], ds = sp[i + 1], dd = d - p.d;
        const q = Math.sqrt(ds * ds + dd * dd) - p.r;
        if (q < 0.5) mask *= smooth(q / 0.5);
      }
      if (mask > 0) h += amp * mask * this.noiseH(ri.s, d);
    }
    return h;
  }

  /** Public: paving height above the route elevation at (s, d). */
  heightAt(s, d) { return this.height(this.rowInfo(s, this._ri), d); }

  // ------------------------------------------------------------------ dirt / tone
  /** Writes a paving colour multiplier for (row, d) into out[o..o+2]. */
  tone(ri, d, out, o) {
    const s = ri.s, a = d < 0 ? -d : d;
    const n1 = this.fG.sample(s * 0.5, d * 0.5 + 40);
    const n2 = this.fD.sample(s, d);
    let v = (1 + 0.075 * n1) * (1 + 0.06 * n2);
    let warm = 0;
    if (a < BAND_IN) {
      const e = railDist(d);
      const g1 = Math.exp(-e / 0.045), g2 = Math.exp(-e / 0.22);
      v *= 1 - 0.24 * g1 - 0.08 * g2;
      warm += 0.05 * g1 + 0.02 * g2;
      // oil drips along the middle of each track
      const dc = Math.abs(a - TRACK_OFFSET);
      v *= 1 - 0.07 * Math.exp(-(dc * dc) / 0.05) * (0.6 + 0.4 * n2);
      v *= 1 - 0.1 * ri.xo * Math.exp(-e / 0.1);
    } else if (a < CORRIDOR) {
      v *= 1 - 0.1 * smooth((a - BAND_IN) / (CORRIDOR - BAND_IN));
    } else if (a < GUTTER_OUT) {
      const t = ((a - CORRIDOR) / GUTTER_W) * 2 - 1;
      v *= 0.68 + 0.12 * t * t + 0.05 * n2;
      warm += 0.02;
    } else {
      const edge = d > 0 ? ri.edgeR : -ri.edgeL;
      const toFacade = edge - FACADE_OVERLAP - a;
      v *= 1 - 0.14 * Math.exp(-Math.max(0, toFacade) / 0.35);
      v *= 1 - 0.06 * Math.exp(-(a - GUTTER_OUT) / 0.25);
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

export { CHUNK_LEN };
