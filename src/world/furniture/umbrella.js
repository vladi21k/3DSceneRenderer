import * as THREE from 'three';
import { lathe, tube, bar, rbox, xf, merge, makeGeo } from './kit.js';

// Market umbrellas, square (3-5 m) or rectangular (e.g. 3 x 4.5 m): 8 ribs (corners and
// side middles), fabric panels that sag 2-4 cm between the ribs in a catenary, with
// tension wrinkles fanning out from the rib-tip pockets, seams over the ribs and a 3 cm
// double-fabric hem, a soft valance that hangs in shallow waves and bellies a little
// between the rib tips (rolled hem at the bottom), a cloth vent hood over the top
// opening, the pole with hub, runner and stretchers, the bases, LED strips under the
// ribs (lit after dusk) and the warm pool they throw on the paving.
// Canopies carry 'aFlex' (0 rigid .. 1 free hem) for the wind flutter, vertex colours for
// seams, hem piping and grime, and 'aVal' for the fabric shader (materials.js
// patchCanopy): on the valance [side + 1, metres along the side (+ to the right seen from
// outside), depth 0..1 down the valance, side length]; on the panels [0, distance to the
// nearest rib (m), 0 vent .. 1 hem, 0].
// Every canopy is built with its hem at UMB_EDGE_H; an instance sinks by
// UMB_EDGE_H - hem to its café's hem height (the pole runs on below the paving).

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const UMB_EDGE_H = 2.7;           // hem height every canopy is built at (the highest a café uses)
export const UMB_HEM = [2.3, 2.7];       // café hem heights: the valance stays above 2.08 m
export const UMB_RISE = 0.37;            // apex rise over the hem, in mean half sizes (about 20°)
export const VALANCE_H = 0.22;
const R_VENT = 0.13;                     // top opening of the canopy (under the hood)
const CAT_C = 2.2;
const cat = (t) => 1 - (Math.cosh(CAT_C * (2 * t - 1)) - 1) / (Math.cosh(CAT_C) - 1);

/** Canopy shape for a size (su across, local x; sv along, local z): rib tips and the
 *  surface function surf(k, r, t). */
export function canopyShape(su, sv = su) {
  // pitch about 20° (UMB_RISE): from the 2.75 m cab eye the large canopies read as low
  // pyramids, not edge-on slivers; a rectangular canopy keeps one apex (its short-side
  // panels are steeper)
  const a = su / 2, b = sv / 2, m = Math.sqrt(a * b), rise = UMB_RISE * m, apex = UMB_EDGE_H + rise;
  const tips = [];
  for (let k = 0; k < 8; k++) {
    const ang = (k * Math.PI) / 4, c = Math.cos(ang), s = Math.sin(ang), mm = Math.max(Math.abs(c), Math.abs(s));
    tips.push([(c / mm) * a, (s / mm) * b]);
  }
  const ribY = (rr) => apex - rise * rr + 0.028 * (m / 1.6) * Math.sin(Math.PI * rr); // ribs bow up under tension
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
  return { a, b, m, rise, apex, tips, surf, ribY };
}

// radial rows (0 vent .. 1 hem); the finest level has a row at the 3 cm hem seam
const RS = [[...Array.from({ length: 16 }, (_, i) => i / 16), 0.982, 1], [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1], [0, 0.5, 1]];
const TS = [[0, 0.012, 0.04, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.96, 0.988, 1], [0, 0.04, 0.25, 0.5, 0.75, 0.96, 1], [0, 0.5, 1]];
const VROWS = [[0, 0.04, 0.2, 0.4, 0.6, 0.8, 0.9, 0.96, 1], [0, 0.85, 1], [0, 1]];

/** Side (0 +x, 1 +z, 2 -x, 3 -z) whose middle tip panel k touches. */
const sideOf = (k) => ((k % 2 ? k + 1 : k) % 8) / 2;

/** Canopy geometry (fabric) at a detail level 0..2. */
export function canopyGeo(su, sv, detail) {
  const S = canopyShape(su, sv);
  const { a, b, apex, tips, surf } = S;
  const rs = RS[detail], nr = rs.length - 1, ts = TS[detail], nt = ts.length - 1;
  const pos = [], uv = [], col = [], flex = [], nor = [], val = [], idx = [];
  const push = (p, u, v, c, f, n = null, w = null) => {
    pos.push(p[0], p[1], p[2]); uv.push(u, v); col.push(c, c, c); flex.push(f);
    nor.push(...(n || [0, 1, 0]));
    val.push(...(w || [0, 1, 0, 0]));
    return pos.length / 3 - 1;
  };
  const seamCol = (t) => { const e = Math.min(t, 1 - t); return e < 0.02 ? 0.84 : e < 0.05 ? 0.96 : 1; };
  const panelIdx = [];
  for (let k = 0; k < 8; k++) {
    const base = pos.length / 3;
    const A = tips[k], B = tips[(k + 1) % 8], hemChord = Math.hypot(B[0] - A[0], B[1] - A[1]);
    for (let i = 0; i <= nr; i++) for (let j = 0; j <= nt; j++) {
      const r = rs[i], t = ts[j];
      const p = surf(k, r, t, detail === 0);
      const grime = 1 - 0.05 * r * r;
      // the hem is a double layer of cloth: a touch darker (more so seen against the light)
      const hem = detail === 0 && r > 0.98 ? 0.9 : 1;
      push(p, p[0], p[2], seamCol(t) * grime * hem, 0.12 * Math.sin(Math.PI * t) * r, null, [0, Math.min(t, 1 - t) * hemChord * Math.max(r, 0.1), r, 0]);
    }
    for (let i = 0; i < nr; i++) for (let j = 0; j < nt; j++) {
      const a0 = base + i * (nt + 1) + j, b0 = a0 + 1, c0 = a0 + nt + 1, d0 = c0 + 1;
      panelIdx.push(a0, b0, c0, b0, d0, c0);
    }
  }
  // valance: hangs from the hem with a slight outward flare and wave, piped hem at the bottom
  const valIdx = [];
  const rows = VROWS[detail];
  const halfMean = (a + b) / 2;
  for (let k = 0; k < 8; k++) {
    const A = tips[k], B = tips[(k + 1) % 8];
    const ex = B[0] - A[0], ez = B[1] - A[1], el = Math.hypot(ex, ez);
    const side = sideOf(k), ox = [1, 0, -1, 0][side], oz = [0, 1, 0, -1][side];
    const sideLen = side % 2 ? 2 * a : 2 * b;
    const vb = pos.length / 3;
    // columns fine enough for the waves (~4.5 cm apart)
    const nvt = detail === 0 ? Math.max(16, Math.ceil(el / 0.045)) : detail === 1 ? 6 : 2;
    // soft cloth: shallow waves growing towards the free bottom edge, a slight belly between
    // the rib tips (the hem sags a centimetre or so), and a rolled hem that curls in
    const valPos = (vv, t) => {
      const e = surf(k, 1, t);
      const along = t * el + k * halfMean;
      const ends = THREE.MathUtils.smoothstep(t, 0, 0.08) * THREE.MathUtils.smoothstep(1 - t, 0, 0.08); // held at the rib tips
      const wave = detail ? 0 : (0.009 * Math.sin((along / 0.27) * Math.PI * 2 + 0.6 * k) + 0.004 * Math.sin((along / 0.47) * Math.PI * 2 + 1.3 * k)) * Math.pow(vv, 1.3) * ends;
      const belly = cat(t) * vv;
      const roll = detail ? 0 : THREE.MathUtils.smoothstep(vv, 0.86, 1);
      const out = 0.016 * vv + wave + 0.01 * belly - 0.009 * roll;
      return [e[0] + ox * out, e[1] - VALANCE_H * vv - 0.012 * belly + 0.004 * roll * roll, e[2] + oz * out];
    };
    const dt = 0.01, dv = 0.02, n = new THREE.Vector3(), tu = new THREE.Vector3(), tv = new THREE.Vector3();
    for (const vv of rows) for (let j = 0; j <= nvt; j++) {
      const t = j / nvt, P = valPos(vv, t);
      const along = t * el + k * halfMean;
      if (detail) n.set(ox, 0.07, oz).normalize();
      else {
        // normal of the waved cloth (finite differences), turned outwards and eased halfway
        // to the plain flare, so the shading keeps the folds soft
        const t0 = Math.max(0, t - dt), t1 = Math.min(1, t + dt), v0 = Math.max(0, vv - dv), v1 = Math.min(1, vv + dv);
        const pa = valPos(vv, t0), pb = valPos(vv, t1), pc = valPos(v0, t), pd = valPos(v1, t);
        tu.set(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
        tv.set(pd[0] - pc[0], pd[1] - pc[1], pd[2] - pc[2]);
        n.crossVectors(tu, tv).normalize();
        if (n.x * ox + n.z * oz < 0) n.negate();
        n.lerp(tu.set(ox, 0.07, oz).normalize(), 0.5).normalize();
      }
      const sAlong = P[0] * oz - P[2] * ox;
      push(P, along, -VALANCE_H * vv, vv > 0.93 ? 0.78 : vv < 0.05 ? 0.9 : 1, Math.min(1, 0.15 + vv), [n.x, n.y, n.z], [side + 1, sAlong, vv, sideLen]);
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
        const px = (tx / a) * rho * f, pz = (tz / b) * rho * f;
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
  const g = makeGeo(pos, nor, uv, [...panelIdx, ...hoodIdx], { color: { array: col, size: 3 }, aFlex: { array: flex, size: 1 }, aVal: { array: val, size: 4 } });
  const keep = new Float32Array(nor);
  g.computeVertexNormals();
  const na = g.attributes.normal;
  // computeVertexNormals ignored the valance (not indexed yet): restore its analytic normals
  g.setIndex([...panelIdx, ...hoodIdx, ...valIdx]);
  for (const vi of new Set(valIdx)) na.setXYZ(vi, keep[vi * 3], keep[vi * 3 + 1], keep[vi * 3 + 2]);
  na.needsUpdate = true;
  return merge([g]);
}

/** Pole, hub, runner, ribs and stretchers (large canopies stand on a heavier pole). */
export function umbrellaFrame(su, sv, detail) {
  const { apex, surf, m } = canopyShape(su, sv);
  const parts = [];
  const seg = [14, 8, 6][detail];
  const run = apex - 0.78 - 0.25 * Math.max(0, m - 1.6);
  const k = m > 2.05 ? 1.3 : 1, r = 0.024 * k;
  parts.push(lathe([[r, 0.0], [r, run - 0.05], [0.036 * k, run - 0.045], [0.04 * k, run], [0.04 * k, run + 0.06], [0.026 * k, run + 0.07],
    [r, apex - 0.09], [0.05 * k, apex - 0.08], [0.05 * k, apex + 0.0], [r, apex + 0.01], [0.022 * k, apex + 0.12], [0.03 * k, apex + 0.15], [0.028 * k, apex + 0.19], [0, apex + 0.2]], seg));
  if (detail >= 2) return merge(parts);
  const rw = 0.016 * Math.sqrt(k), rh = 0.022 * Math.sqrt(k);
  for (let q = 0; q < 8; q++) {
    const pts = [], n = detail ? 3 : 7;
    for (let i = 0; i <= n; i++) { const p = surf(q, Math.max(0.0, i / n), 0); pts.push(V(p[0], p[1] - 0.017, p[2])); }
    parts.push(bar(pts, rw, rh, { r: detail ? 0 : 0.003, up: [0, 1, 0], bend: 0 }));
    if (!detail) { // rib-end cap pushing into the hem pocket
      const e = surf(q, 1, 0), d = Math.hypot(e[0], e[2]);
      parts.push(tube([V(e[0] * (1 - 0.06 / d), e[1] - 0.016, e[2] * (1 - 0.06 / d)), V(e[0], e[1] - 0.012, e[2])], 0.0105, { radial: 12, bend: 0 }));
    }
    if (detail) continue;
    const mm = surf(q, 0.46, 0);
    const ang = Math.atan2(mm[2], mm[0]);
    parts.push(tube([V(Math.cos(ang) * 0.04 * k, run + 0.03, Math.sin(ang) * 0.04 * k), V(mm[0], mm[1] - 0.03, mm[2])], 0.0075 * Math.sqrt(k), { radial: 6, bend: 0 }));
  }
  return merge(parts);
}

/** LED strips clipped under the ribs (thin flat bars from the hub to near the tips). */
export function ledGeo(su, sv, detail) {
  if (detail >= 2) return null;
  const { surf } = canopyShape(su, sv);
  const parts = [];
  for (let q = 0; q < 8; q++) {
    const pts = [], n = detail ? 2 : 6;
    for (let i = 0; i <= n; i++) { const p = surf(q, 0.12 + 0.8 * (i / n), 0); pts.push(V(p[0], p[1] - 0.034, p[2])); }
    parts.push(bar(pts, 0.011, 0.005, { r: 0.0015, up: [0, 1, 0], bend: 0 }));
  }
  return merge(parts);
}

/** Warm light pool under a lit canopy: a unit square on the paving (scaled per instance)
 *  whose UVs run 0..1 over it (the pool texture falls off radially). */
export function poolGeo() {
  const g = new THREE.PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2).translate(0, 0.012, 0);
  return merge([g]);
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

// furled umbrella: rib tips at FY0, hub at FY1
const FY0 = 1.2, FY1 = 2.86, STRAP_Y = 1.98;
const ribR = (y) => THREE.MathUtils.lerp(0.046, 0.026, THREE.MathUtils.smoothstep(y, FY0, FY1));
const twistAt = (y) => 0.32 * (FY1 - y) / (FY1 - FY0);
/** How far the gathered cloth stands out beyond the ribs at height y (cinched by the strap). */
function bulgeAt(y) {
  const t = (FY1 - y) / (FY1 - FY0);                             // 0 hub .. 1 tips
  const body = 0.04 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.78 + 0.08)), 0.7);
  const strap = 1 - 0.8 * Math.exp(-(((y - STRAP_Y) / 0.07) ** 2));
  return body * strap;
}

/** Furled umbrella: the cloth hangs in eight gathered folds between the ribs (ridges at the
 *  ribs, irregular folds between them), cinched by a tie strap, its hem sagging in scallops
 *  between the rib tips, with a small cloth cap over the hub. About 0.18 m across. */
export function furledGeo(lod) {
  const per = lod ? 2 : 8, segs = 8 * per;
  const ys = lod ? [FY0, 1.5, STRAP_Y, 2.4, FY1] : [FY0, 1.24, 1.3, 1.4, 1.52, 1.64, 1.76, 1.86, 1.92, STRAP_Y - 0.03, STRAP_Y, STRAP_Y + 0.03, 2.05, 2.14, 2.26, 2.4, 2.54, 2.66, 2.76, 2.82, FY1];
  const amp = [1.0, 0.75, 1.2, 0.9, 1.1, 0.8, 1.25, 0.95], ph = [0.05, -0.06, 0.02, 0.08, -0.03, 0.04, -0.07, 0.0];
  const pos = [], uv = [], idx = [], col = [], flex = [];
  const at = (i, y) => {
    const k = Math.floor(i / per) % 8, u = (i % per) / per;
    const phi = (i / segs) * Math.PI * 2 + twistAt(y);
    const lobe = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, u + ph[k] * Math.sin(Math.PI * u)))), 0.75);
    const r = ribR(y) + 0.004 + bulgeAt(y) * amp[k] * lobe;
    // hem scallops: the cloth between two rib tips hangs lower than the tips
    const yy = y === FY0 ? y - 0.075 * Math.sin(Math.PI * u) * amp[k] : y;
    return [Math.sin(phi) * r, yy, Math.cos(phi) * r];
  };
  for (let j = 0; j < ys.length; j++) {
    const y = ys[j];
    const strapRow = Math.abs(y - STRAP_Y) < 0.035;
    for (let i = 0; i <= segs; i++) {
      const p = at(i, y);
      pos.push(...p);
      uv.push((i / segs) * 0.5, y);
      const c = strapRow ? 0.8 : y === FY0 ? 0.88 : 0.96;
      col.push(c, c, c); flex.push(0);
    }
  }
  for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < segs; i++) {
    const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx, { color: { array: col, size: 3 }, aFlex: { array: flex, size: 1 } });
  g.computeVertexNormals();
  const parts = [g];
  // tie strap: a 3 cm band standing a few millimetres proud of the folds
  if (!lod) {
    const sp = [], su = [], si = [], sc = [], sf = [];
    const n = 40, rOf = (phi) => {
      let best = 0;
      for (const y of [STRAP_Y - 0.015, STRAP_Y, STRAP_Y + 0.015]) {
        const i = ((phi - twistAt(y)) / (Math.PI * 2)) * segs;
        const p = at(((Math.round(i) % segs) + segs) % segs, y);
        best = Math.max(best, Math.hypot(p[0], p[2]));
      }
      return best + 0.004;
    };
    for (let i = 0; i <= n; i++) {
      const phi = (i / n) * Math.PI * 2, r = rOf(phi);
      for (const [dy, dr] of [[-0.016, -0.003], [-0.015, 0], [0.015, 0], [0.016, -0.003]]) {
        sp.push(Math.sin(phi) * (r + dr), STRAP_Y + dy, Math.cos(phi) * (r + dr));
        su.push(phi * r, dy); sc.push(0.72, 0.72, 0.72); sf.push(0);
      }
    }
    for (let i = 0; i < n; i++) for (let q = 0; q < 3; q++) {
      const a = i * 4 + q, b = a + 1, c = a + 4, d = c + 1;
      si.push(a, c, b, b, c, d);
    }
    const s = makeGeo(sp, new Array(sp.length).fill(0), su, si, { color: { array: sc, size: 3 }, aFlex: { array: sf, size: 1 } });
    s.computeVertexNormals();
    parts.push(s);
  }
  // cloth cap over the hub
  const cap = lathe([[ribR(FY1) + 0.012, FY1 - 0.03], [0.04, FY1 + 0.01], [0.03, FY1 + 0.05], [0, FY1 + 0.07]], lod ? 8 : 16);
  const cn = cap.attributes.position.count;
  cap.setAttribute('color', new THREE.Float32BufferAttribute(new Array(cn * 3).fill(0.94), 3));
  cap.setAttribute('aFlex', new THREE.Float32BufferAttribute(new Array(cn).fill(0), 1));
  parts.push(cap);
  return merge(parts);
}

/** Pole of a furled umbrella: runner pushed down, rib-tip caps under the folds, finial. */
export function furledPoleGeo(lod) {
  const parts = [lathe([[0.024, 0], [0.024, 1.02], [0.038, 1.03], [0.04, 1.1], [0.026, 1.11], [0.024, FY1 + 0.06], [0.012, FY1 + 0.08], [0.012, FY1 + 0.11],
    [0.028, FY1 + 0.125], [0.032, FY1 + 0.15], [0.026, FY1 + 0.175], [0.008, FY1 + 0.19], [0, FY1 + 0.195]], lod ? 8 : 14)];
  if (!lod) {
    for (let k = 0; k < 8; k++) {
      const phi = (k / 8) * Math.PI * 2 + twistAt(FY0), r = ribR(FY0);
      parts.push(tube([V(Math.sin(phi) * r, FY0 + 0.04, Math.cos(phi) * r), V(Math.sin(phi) * r * 0.97, FY0 - 0.012, Math.cos(phi) * r * 0.97)], 0.0085, { radial: 10, bend: 0 }));
    }
  }
  return merge(parts);
}
