import * as THREE from 'three';
import { lathe, tube, bar, rbox, xf, merge, makeGeo } from './kit.js';

// Large square market umbrellas: 8 ribs (corners and side middles), fabric panels that
// sag 2-4 cm between the ribs in a catenary, with tension wrinkles fanning out from the
// rib-tip pockets, seams over the ribs and a 3 cm double-fabric hem, a soft valance that
// hangs in shallow waves and bellies a little between the rib tips (rolled hem at the
// bottom), a cloth vent hood over the top opening, the pole with hub, runner and
// stretchers, and the bases. Canopies carry 'aFlex' (0 rigid .. 1 free hem) for the wind
// flutter and vertex colours for seams, hem piping and grime.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const UMB_EDGE_H = 2.38;          // hem height of the canopy
export const UMB_RISE = 0.37;            // apex rise over the hem, in half sizes (about 20°)
const VALANCE_H = 0.22;
const R_VENT = 0.13;                     // top opening of the canopy (under the hood)
const CAT_C = 2.2;
const cat = (t) => 1 - (Math.cosh(CAT_C * (2 * t - 1)) - 1) / (Math.cosh(CAT_C) - 1);

/** Canopy shape for a size: rib tips and the surface function surf(k, r, t). */
export function canopyShape(size) {
  // pitch about 20° (UMB_RISE): from the 2.75 m cab eye the large canopies read as low
  // pyramids, not edge-on slivers
  const a = size / 2, rise = UMB_RISE * a, apex = UMB_EDGE_H + rise;
  const tips = [];
  for (let k = 0; k < 8; k++) {
    const ang = (k * Math.PI) / 4, c = Math.cos(ang), s = Math.sin(ang), m = Math.max(Math.abs(c), Math.abs(s));
    tips.push([(c / m) * a, (s / m) * a]);
  }
  const ribY = (rr) => apex - rise * rr + 0.028 * (size / 3.2) * Math.sin(Math.PI * rr); // ribs bow up under tension
  /** Fabric surface of panel k (between ribs k and k + 1) at r (0 vent .. 1 hem) and t
   *  (0 rib k .. 1 rib k + 1). fine: add the tension wrinkles (canopy cloth only). */
  const surf = (k, r, t, fine = false) => {
    const A = tips[k], B = tips[(k + 1) % 8];
    const ox = A[0] + (B[0] - A[0]) * t, oz = A[1] + (B[1] - A[1]) * t;
    const L = Math.hypot(ox, oz), r0 = R_VENT / L;
    const rr = r0 + r * (1 - r0);
    const hemChord = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const chord = hemChord * rr;
    // panels sag between the ribs (catenary across), most in mid-panel (2-4 cm on a 3 m
    // umbrella); the hem is tensioned and droops only a little between the rib tips
    let sag = (0.05 * chord * Math.pow(Math.sin(Math.PI * Math.min(1, rr * 1.1)), 0.6) + 0.008 * rr) * cat(t);
    if (fine) {
      // tension wrinkles: the rib tips pull the cloth into their pockets, so shallow folds
      // fan out from each tip into the panel (none on the ribs or along the hem)
      for (const [tt, ph] of [[t, 0.3], [1 - t, 1.7]]) {
        const dr = (1 - rr) * L, dl = tt * hemChord;
        const rho = Math.hypot(dr, dl), th = Math.atan2(dl, dr);
        sag += 0.0045 * Math.exp(-rho / 0.3) * Math.min(1, rho / 0.05) * Math.sin(2 * th) * Math.sin(9 * th + ph);
      }
    }
    return [ox * rr, ribY(rr) - sag, oz * rr];
  };
  return { a, rise, apex, tips, surf, ribY };
}

// radial rows (0 vent .. 1 hem); the finest level has a row at the 3 cm hem seam
const RS = [[...Array.from({ length: 16 }, (_, i) => i / 16), 0.982, 1], [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1], [0, 0.5, 1]];
const TS = [[0, 0.012, 0.04, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.96, 0.988, 1], [0, 0.04, 0.25, 0.5, 0.75, 0.96, 1], [0, 0.5, 1]];
const VROWS = [[0, 0.04, 0.2, 0.4, 0.6, 0.8, 0.9, 0.96, 1], [0, 0.85, 1], [0, 1]];
// valance columns: fine enough for its waves (~4.5 cm apart on a 3 m umbrella)
const VTS = [Array.from({ length: 33 }, (_, i) => i / 32), TS[1], TS[2]];

/** Canopy geometry (fabric) at a detail level 0..2. */
export function canopyGeo(size, detail) {
  const S = canopyShape(size);
  const { a, apex, tips, surf } = S;
  const rs = RS[detail], nr = rs.length - 1, ts = TS[detail], nt = ts.length - 1;
  const pos = [], uv = [], col = [], flex = [], nor = [], idx = [];
  const push = (p, u, v, c, f, n = null) => {
    pos.push(p[0], p[1], p[2]); uv.push(u, v); col.push(c, c, c); flex.push(f);
    nor.push(...(n || [0, 1, 0]));
    return pos.length / 3 - 1;
  };
  const seamCol = (t) => { const e = Math.min(t, 1 - t); return e < 0.02 ? 0.84 : e < 0.05 ? 0.96 : 1; };
  const panelIdx = [];
  for (let k = 0; k < 8; k++) {
    const base = pos.length / 3;
    for (let i = 0; i <= nr; i++) for (let j = 0; j <= nt; j++) {
      const r = rs[i], t = ts[j];
      const p = surf(k, r, t, detail === 0);
      const grime = 1 - 0.05 * r * r;
      // the hem is a double layer of cloth: a touch darker (more so seen against the light)
      const hem = detail === 0 && r > 0.98 ? 0.9 : 1;
      push(p, p[0], p[2], seamCol(t) * grime * hem, 0.12 * Math.sin(Math.PI * t) * r);
    }
    for (let i = 0; i < nr; i++) for (let j = 0; j < nt; j++) {
      const a0 = base + i * (nt + 1) + j, b0 = a0 + 1, c0 = a0 + nt + 1, d0 = c0 + 1;
      panelIdx.push(a0, b0, c0, b0, d0, c0);
    }
  }
  // valance: hangs from the hem with a slight outward flare and wave, piped hem at the bottom
  const valIdx = [];
  const rows = VROWS[detail];
  for (let k = 0; k < 8; k++) {
    const A = tips[k], B = tips[(k + 1) % 8];
    const ex = B[0] - A[0], ez = B[1] - A[1], el = Math.hypot(ex, ez);
    const nx = ez / el, nz = -ex / el; // outward (tips run counter-clockwise seen from below)
    const sgn = nx * (A[0] + B[0]) + nz * (A[1] + B[1]) > 0 ? 1 : -1;
    const ox = nx * sgn, oz = nz * sgn;
    const vb = pos.length / 3;
    // soft cloth: shallow waves growing towards the free bottom edge, a slight belly between
    // the rib tips (the hem sags a centimetre or so), and a rolled hem that curls in
    const valPos = (vv, t) => {
      const e = surf(k, 1, t);
      const along = t * el + k * a;
      const ends = THREE.MathUtils.smoothstep(t, 0, 0.08) * THREE.MathUtils.smoothstep(1 - t, 0, 0.08); // held at the rib tips
      const wave = detail ? 0 : (0.009 * Math.sin((along / 0.27) * Math.PI * 2 + 0.6 * k) + 0.004 * Math.sin((along / 0.47) * Math.PI * 2 + 1.3 * k)) * Math.pow(vv, 1.3) * ends;
      const belly = cat(t) * vv;
      const roll = detail ? 0 : THREE.MathUtils.smoothstep(vv, 0.86, 1);
      const out = 0.016 * vv + wave + 0.01 * belly - 0.009 * roll;
      return [e[0] + ox * out, e[1] - VALANCE_H * vv - 0.012 * belly + 0.004 * roll * roll, e[2] + oz * out];
    };
    const dt = 0.01, dv = 0.02, n = new THREE.Vector3(), tu = new THREE.Vector3(), tv = new THREE.Vector3();
    const vts = VTS[detail], nvt = vts.length - 1;
    for (const vv of rows) for (let j = 0; j <= nvt; j++) {
      const t = vts[j], P = valPos(vv, t);
      const along = t * el + k * a;
      if (detail) n.set(ox, 0.07, oz).normalize();
      else {
        // normal of the waved cloth (finite differences), turned outwards
        const t0 = Math.max(0, t - dt), t1 = Math.min(1, t + dt), v0 = Math.max(0, vv - dv), v1 = Math.min(1, vv + dv);
        const pa = valPos(vv, t0), pb = valPos(vv, t1), pc = valPos(v0, t), pd = valPos(v1, t);
        tu.set(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
        tv.set(pd[0] - pc[0], pd[1] - pc[1], pd[2] - pc[2]);
        n.crossVectors(tu, tv).normalize();
        if (n.x * ox + n.z * oz < 0) n.negate();
      }
      push(P, along, -VALANCE_H * vv, vv > 0.93 ? 0.78 : vv < 0.05 ? 0.9 : 1, Math.min(1, 0.15 + vv), [n.x, n.y, n.z]);
    }
    const nc = nvt + 1;
    for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < nvt; j++) {
      const a0 = vb + i * nc + j, b0 = a0 + 1, c0 = a0 + nc, d0 = c0 + 1;
      valIdx.push(a0, b0, c0, b0, d0, c0);
    }
  }
  // cloth vent hood over the top opening: low pyramid with drooping corners and a skirt
  const hoodIdx = [];
  {
    const rho = 0.21, peak = apex + 0.11;
    const top = push([0, peak, 0], 0, 0, 1, 0.04);
    const rings = detail ? [1] : [0.5, 1];
    const ring = [];
    for (const f of rings) {
      const pts = [];
      for (let k = 0; k < 8; k++) {
        const [tx, tz] = tips[k], corner = k % 2 === 1;
        const px = (tx / a) * rho * f, pz = (tz / a) * rho * f;
        const L = Math.hypot(px, pz);
        const yc = S.ribY(L / Math.hypot(tx, tz)) + 0.025;               // 2.5 cm above the canopy
        const y = f < 1 ? THREE.MathUtils.lerp(peak, yc, 0.5) + 0.012 : yc - (corner ? 0.012 : 0);
        pts.push(push([px, y, pz], px, pz, 1, 0.06 * f));
      }
      ring.push(pts);
    }
    for (let k = 0; k < 8; k++) hoodIdx.push(top, ring[0][(k + 1) % 8], ring[0][k]);
    for (let q = 0; q < ring.length - 1; q++) for (let k = 0; k < 8; k++) {
      const a0 = ring[q][k], b0 = ring[q][(k + 1) % 8], c0 = ring[q + 1][k], d0 = ring[q + 1][(k + 1) % 8];
      hoodIdx.push(a0, b0, c0, b0, d0, c0);
    }
    // skirt
    const last = ring[ring.length - 1], skirt = [];
    for (let k = 0; k < 8; k++) {
      const i0 = last[k];
      skirt.push(push([pos[i0 * 3] * 1.02, pos[i0 * 3 + 1] - 0.035, pos[i0 * 3 + 2] * 1.02], pos[i0 * 3], pos[i0 * 3 + 2] - 0.035, 0.92, 0.1));
    }
    for (let k = 0; k < 8; k++) {
      const a0 = last[k], b0 = last[(k + 1) % 8], c0 = skirt[k], d0 = skirt[(k + 1) % 8];
      hoodIdx.push(a0, b0, c0, b0, d0, c0);
    }
  }
  // normals: smooth inside each panel (creased at the ribs), analytic on the valance
  const g = makeGeo(pos, nor, uv, [...panelIdx, ...hoodIdx], { color: { array: col, size: 3 }, aFlex: { array: flex, size: 1 } });
  const keep = new Float32Array(nor);
  g.computeVertexNormals();
  const na = g.attributes.normal;
  // computeVertexNormals ignored the valance (not indexed yet): restore its analytic normals
  g.setIndex([...panelIdx, ...hoodIdx, ...valIdx]);
  for (const vi of new Set(valIdx)) na.setXYZ(vi, keep[vi * 3], keep[vi * 3 + 1], keep[vi * 3 + 2]);
  na.needsUpdate = true;
  return merge([g]);
}

/** Pole, hub, runner, ribs and stretchers. */
export function umbrellaFrame(size, detail) {
  const { apex, surf } = canopyShape(size);
  const parts = [];
  const seg = [12, 7, 6][detail];
  const run = apex - 0.78;
  parts.push(lathe([[0.024, 0.0], [0.024, run - 0.05], [0.036, run - 0.045], [0.04, run], [0.04, run + 0.06], [0.026, run + 0.07],
    [0.024, apex - 0.09], [0.05, apex - 0.08], [0.05, apex + 0.0], [0.024, apex + 0.01], [0.022, apex + 0.12], [0.03, apex + 0.15], [0.028, apex + 0.19], [0, apex + 0.2]], seg));
  if (detail >= 2) return merge(parts);
  for (let k = 0; k < 8; k++) {
    const pts = [], n = detail ? 3 : 7;
    for (let i = 0; i <= n; i++) { const p = surf(k, Math.max(0.0, i / n), 0); pts.push(V(p[0], p[1] - 0.017, p[2])); }
    parts.push(bar(pts, 0.016, 0.022, { r: detail ? 0 : 0.003, up: [0, 1, 0], bend: 0 }));
    if (!detail) { // rib-end cap pushing into the hem pocket
      const e = surf(k, 1, 0), d = Math.hypot(e[0], e[2]);
      parts.push(tube([V(e[0] * (1 - 0.06 / d), e[1] - 0.016, e[2] * (1 - 0.06 / d)), V(e[0], e[1] - 0.012, e[2])], 0.0105, { radial: 6, bend: 0 }));
    }
    if (detail) continue;
    const m = surf(k, 0.46, 0);
    const ang = (k * Math.PI) / 4;
    parts.push(tube([V(Math.cos(ang) * 0.04, run + 0.03, Math.sin(ang) * 0.04), V(m[0], m[1] - 0.03, m[2])], 0.0075, { radial: 5, bend: 0 }));
  }
  return merge(parts);
}

/** Weighted bases: square concrete slab (with a steel top plate) or round cast-iron disc. */
export function umbrellaBase(kind, lod) {
  if (kind === 'disc') {
    return {
      iron: merge([lathe([[0.23, 0], [0.23, 0.016], [0.222, 0.026], [0.19, 0.036], [0.12, 0.05], [0.075, 0.07], [0.056, 0.1], [0.05, 0.24], [0.058, 0.25],
        [0.058, 0.265], [0.04, 0.275], [0, 0.275]], lod ? 10 : 32)]),
    };
  }
  return {
    conc: merge([xf(rbox(0.56, 0.11, 0.56, lod ? 0.004 : 0.012, 1), [0, 0.055, 0])]),
    steel: merge([xf(rbox(0.2, 0.006, 0.2, 0.002, 1), [0, 0.113, 0]),
      lathe([[0.05, 0.11], [0.05, 0.3], [0.04, 0.31], [0.033, 0.31], [0, 0.31]], lod ? 6 : 14)]),
  };
}

/** Furled umbrella: a spindle of folded fabric (folds as a radial ripple). */
export function furledGeo(lod) {
  const segs = lod ? 6 : 24, pos = [], uv = [], idx = [], col = [], flex = [];
  const prof = [[0.026, 1.5], [0.06, 1.62], [0.1, 1.95], [0.11, 2.3], [0.085, 2.62], [0.05, 2.8], [0.03, 2.86]];
  for (let j = 0; j < prof.length; j++) {
    for (let i = 0; i <= segs; i++) {
      const ph = (i / segs) * Math.PI * 2;
      const fold = 1 + (lod ? 0 : 0.16 * Math.cos(ph * 8 + j * 0.6));
      const r = prof[j][0] * fold;
      pos.push(Math.sin(ph) * r, prof[j][1], Math.cos(ph) * r);
      uv.push(ph * 0.1, prof[j][1]); col.push(0.96, 0.96, 0.96); flex.push(0);
    }
  }
  for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < segs; i++) {
    const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx, { color: { array: col, size: 3 }, aFlex: { array: flex, size: 1 } });
  g.computeVertexNormals();
  return merge([g]);
}
