import * as THREE from 'three';
import { GeoWriter, sweepBar, box, simplify, lathe, shared } from './geo.js';
import { DESIGNS, RAIL_H } from './patterns.js';

// Wrought-iron railing assets built once at init:
//  - one instanced "bay" geometry per design (handrail, rails, bars, scrolls, collars, rosettes)
//  - corner / end posts with finials
//  - a railing-card atlas (alpha cut-out, coverage-preserving mip chain) for the far range

/** Smooth-ish closed section extruded along x from x0 to x1 (handrail).
 *  section: [[z, y], ...] counter-clockwise in the (z right, y up) plane. */
function extrudeX(W, section, x0, x1) {
  const n = section.length;
  const nrm = section.map((p, i) => {
    const a = section[(i - 1 + n) % n], b = section[(i + 1) % n];
    let dz = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dz, dy) || 1; dz /= l; dy /= l;
    return [dy, -dz]; // outward for a CCW loop in (z, y)
  });
  const base = W.count;
  for (const x of [x0, x1]) {
    for (let i = 0; i < n; i++) W.v(x, section[i][1], section[i][0], 0, nrm[i][1], nrm[i][0], x, i * 0.01);
  }
  for (let i = 0; i < n; i++) {
    const a = base + i, b = base + (i + 1) % n, c = base + n + (i + 1) % n, d = base + n + i;
    W.quad(a, d, c, b);
  }
}

/** Moulded handrail section: flat underside, rounded top (z = depth, y = height). */
function handSection(y0, y1, d) {
  const hz = d / 2, h = y1 - y0, pts = [];
  pts.push([-hz, y0], [hz, y0], [hz, y0 + h * 0.35]);
  for (let i = 1; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    pts.push([Math.cos(a) * hz, y0 + h * 0.35 + Math.sin(a) * h * 0.65]);
  }
  pts.push([-hz, y0 + h * 0.35]);
  return pts; // counter-clockwise in the (z right, y up) plane
}

/** Square bar along y with an optional twisted section. */
function twistedBar(W, x, y0, y1, s, [t0, t1, turns]) {
  const hs = s / 2;
  const ys = [y0, t0];
  const steps = Math.max(6, Math.round(turns * 8));
  for (let i = 1; i < steps; i++) ys.push(t0 + ((t1 - t0) * i) / steps);
  ys.push(t1, y1);
  const ang = (y) => (y <= t0 ? 0 : y >= t1 ? turns * Math.PI * 2 : ((y - t0) / (t1 - t0)) * turns * Math.PI * 2);
  const rings = ys.map((y) => {
    const a = ang(y), idx = [];
    for (let f = 0; f < 4; f++) {
      const a0 = a + Math.PI / 4 + (f * Math.PI) / 2, a1 = a0 + Math.PI / 2;
      const na = a0 + Math.PI / 4;
      const r = hs * Math.SQRT2;
      idx.push(W.v(x + Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(na), 0, Math.sin(na), f * s, y));
      idx.push(W.v(x + Math.cos(a1) * r, y, Math.sin(a1) * r, Math.cos(na), 0, Math.sin(na), (f + 1) * s, y));
    }
    return idx;
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let f = 0; f < 4; f++) {
      const a = rings[i][f * 2], b = rings[i][f * 2 + 1], c = rings[i + 1][f * 2 + 1], d = rings[i + 1][f * 2];
      W.quad(a, d, c, b);
    }
  }
}

/** Small cast rosette facing +z (petalled dome) with a flat back. */
function rosette(W, x, y, r, z0) {
  const seg = 32, base = W.count;
  W.v(x, y, z0 + r * 0.55, 0, 0, 1, 0, 0);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const pr = r * (0.72 + 0.28 * Math.abs(Math.cos(a * 4)));
    W.v(x + c * pr * 0.45, y + s * pr * 0.45, z0 + r * 0.42, c * 0.35, s * 0.35, 0.94, 0, 0);
    W.v(x + c * pr, y + s * pr, z0, c * 0.7, s * 0.7, 0.7, 0, 0);
  }
  for (let i = 0; i < seg; i++) {
    const m0 = base + 1 + i * 2, o0 = m0 + 1, m1 = m0 + 2, o1 = m0 + 3;
    W.tri(base, m0, m1);
    W.quad(m0, o0, o1, m1);
  }
}

/** Evenly resample a closed loop to n points (rings). */
function resampleLoop(pts, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pts[Math.floor((i / n) * pts.length)]);
  return out;
}

/** Instanced bay geometry for one design. lod 0 = full, 1 = coarse (fewer curve points). */
export function bayGeometry(design, lod = 0) {
  const W = new GeoWriter();
  const turn = lod ? 0.9 : 0.5, segLen = lod ? 0.16 : 0.08;
  for (const st of design.strokes) {
    switch (st.k) {
      case 'rail':
        if (st.hand) extrudeX(W, handSection(st.y0, st.y1, st.d), st.x0, st.x1);
        else box(W, (st.x0 + st.x1) / 2, (st.y0 + st.y1) / 2, 0, st.x1 - st.x0, st.y1 - st.y0, st.d);
        break;
      case 'bar':
        if (st.twist && !lod) twistedBar(W, st.x, st.y0, st.y1, st.s, st.twist);
        else box(W, st.x, (st.y0 + st.y1) / 2, 0, st.s, st.y1 - st.y0, st.s);
        break;
      case 'curve': {
        const p = st.closed ? resampleLoop(st.pts, lod ? 9 : 14) : simplify(st.pts, turn, segLen);
        sweepBar(W, p, st.w / 2, st.d / 2, { closed: st.closed, caps: false, backFace: false });
        break;
      }
      case 'collar':
        box(W, st.x, st.y, 0, st.w, st.h, st.d);
        break;
      case 'rosette':
        if (!lod) rosette(W, st.x, st.y, st.r, 0.008);
        break;
    }
  }
  const g = W.toGeometry({ colors: false });
  g.userData.design = design.id;
  return shared(g);
}

/** Corner / end post: square bar, collar, ball finial, small foot. Local origin at the foot. */
export function postGeometry(lod = 0) {
  const W = new GeoWriter();
  const s = 0.026;
  box(W, 0, RAIL_H / 2 + 0.01, 0, s, RAIL_H + 0.02, s);
  if (!lod) {
    box(W, 0, 0.006, 0, 0.06, 0.012, 0.06);                    // foot plate
    box(W, 0, RAIL_H + 0.026, 0, 0.038, 0.012, 0.038);         // collar
  }
  const seg = lod ? 6 : 8;
  const prof = [];
  const R = 0.027, cy = RAIL_H + 0.068;
  prof.push([0.008, RAIL_H + 0.03]);
  prof.push([0.011, RAIL_H + 0.042]);
  const nb = lod ? 3 : 6, a0 = -Math.PI / 2 + 0.42;
  for (let i = 0; i <= nb; i++) {
    const a = a0 + (i / nb) * (Math.PI / 2 - a0);
    prof.push([Math.max(0.0001, Math.cos(a) * R), cy + Math.sin(a) * R]);
  }
  lathe(W, prof, seg);
  return shared(W.toGeometry({ colors: false }));
}

// ---------------------------------------------------------------- card atlas
export const ATLAS = { TW: 128, ROW: 256, PAD: 24, ROWS: 8 };
const ATLAS_H = ATLAS.ROW * ATLAS.ROWS;

/** Texture v for design row `row` at railing height y (0..RAIL_H). */
export function atlasV(row, y) {
  const S = (ATLAS.ROW - 2 * ATLAS.PAD) / RAIL_H;
  return (row * ATLAS.ROW + ATLAS.ROW - ATLAS.PAD - y * S) / ATLAS_H;
}

function drawDesign(ctx, d, row) {
  const S = (ATLAS.ROW - 2 * ATLAS.PAD) / RAIL_H;
  for (const shift of [-d.W, 0, d.W]) {
    ctx.setTransform(ATLAS.TW / d.W, 0, 0, -S, (shift * ATLAS.TW) / d.W, row * ATLAS.ROW + ATLAS.ROW - ATLAS.PAD);
    for (const st of d.strokes) {
      switch (st.k) {
        case 'rail': ctx.fillRect(st.x0, st.y0, st.x1 - st.x0, st.y1 - st.y0); break;
        case 'bar': {
          const w = st.twist ? st.s * 1.2 : st.s;
          ctx.fillRect(st.x - w / 2, st.y0, w, st.y1 - st.y0);
          break;
        }
        case 'collar': ctx.fillRect(st.x - st.w / 2, st.y - st.h / 2, st.w, st.h); break;
        case 'rosette': ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill(); break;
        case 'curve': {
          ctx.lineWidth = st.w * 1.15;
          ctx.beginPath();
          st.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          if (st.closed) ctx.closePath();
          ctx.stroke();
          break;
        }
      }
    }
  }
}

/** Coverage-preserving mip chain: each level's alpha is rescaled (per design row) so the
 *  fraction of texels passing the 0.5 alpha test matches the full-resolution coverage.
 *  Thin ironwork then keeps its true density at every distance instead of vanishing. */
function coverageMips(alpha0, w0, h0, levels) {
  const out = [];
  const rowsOf = (h) => h / ATLAS.ROWS;
  // base coverage per design row
  const cov = new Float32Array(ATLAS.ROWS);
  for (let r = 0; r < ATLAS.ROWS; r++) {
    let c = 0, n = 0;
    for (let y = r * ATLAS.ROW; y < (r + 1) * ATLAS.ROW; y++) for (let x = 0; x < w0; x++) { n++; if (alpha0[y * w0 + x] >= 0.5) c++; }
    cov[r] = c / n;
  }
  let cur = alpha0, w = w0, h = h0;
  out.push({ a: cur, w, h });
  for (let L = 1; L < levels; L++) {
    const nw = w >> 1, nh = h >> 1, nxt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * w + 2 * x;
      nxt[y * nw + x] = (cur[i] + cur[i + 1] + cur[i + w] + cur[i + w + 1]) * 0.25;
    }
    cur = nxt; w = nw; h = nh;
    // rescale per row
    const scaled = new Float32Array(nw * nh);
    const rh = rowsOf(nh);
    for (let r = 0; r < ATLAS.ROWS; r++) {
      const y0 = Math.floor(r * rh), y1 = Math.floor((r + 1) * rh);
      let lo = 0.25, hi = 24;
      const target = cov[r];
      const frac = (k) => { let c = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < nw; x++) { n++; if (cur[y * nw + x] * k >= 0.5) c++; } return n ? c / n : 0; };
      for (let it = 0; it < 18; it++) { const k = Math.sqrt(lo * hi); if (frac(k) > target) hi = k; else lo = k; }
      const k = Math.sqrt(lo * hi);
      for (let y = y0; y < y1; y++) for (let x = 0; x < nw; x++) scaled[y * nw + x] = Math.min(1, cur[y * nw + x] * k);
    }
    out.push({ a: scaled, w: nw, h: nh });
  }
  return out;
}

/** Builds the railing atlas DataTexture (RGBA: white, alpha = iron) with manual mips. */
export function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = ATLAS.TW; cv.height = ATLAS_H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  DESIGNS.forEach((d, i) => drawDesign(ctx, d, i));
  const img = ctx.getImageData(0, 0, ATLAS.TW, ATLAS_H).data;
  const a0 = new Float32Array(ATLAS.TW * ATLAS_H);
  for (let i = 0; i < a0.length; i++) a0[i] = img[i * 4 + 3] / 255;
  const levels = coverageMips(a0, ATLAS.TW, ATLAS_H, 6);
  const mipmaps = levels.map(({ a, w, h }) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = Math.round(a[i] * 255); }
    return { data, width: w, height: h };
  });
  const tex = new THREE.DataTexture(mipmaps[0].data, ATLAS.TW, ATLAS_H, THREE.RGBAFormat);
  tex.mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.userData.canvas = cv;
  return tex;
}
