import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { lathe, sweep, tube, bar, rbox, extrude, xf, merge, makeGeo, rectProfile, quad, profileWall } from './kit.js';
import { proto, placeMatrix, segmentMatrix } from './instancer.js';
import { uvRect } from './prints.js';

// Café terraces: chairs (woven bistro, plastic shell, aluminium, wicker), bistro tables,
// square market umbrellas with sagging canopies and valances, freestanding canopies,
// tableware and A-frame menu boards. Geometry is authored once (front = +Z, y up, origin
// on the ground) and instanced per chunk at the exact layout positions.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const SEAT_H = 0.46;

// ------------------------------------------------------------------ chair geometry
function roundedRectShape(w, d, rf, rb, taper = 0) {
  // seat outline in (x, y=-z) with front (positive z, i.e. y = -d/2... ) handled by caller
  const s = new THREE.Shape();
  const wf = w / 2, wb = w / 2 - taper;
  s.moveTo(-wb + rb, -d / 2);
  s.lineTo(wb - rb, -d / 2); s.quadraticCurveTo(wb, -d / 2, wb, -d / 2 + rb);
  s.lineTo(wf, d / 2 - rf); s.quadraticCurveTo(wf, d / 2, wf - rf, d / 2);
  s.lineTo(-wf + rf, d / 2); s.quadraticCurveTo(-wf, d / 2, -wf, d / 2 - rf);
  s.lineTo(-wb, -d / 2 + rb); s.quadraticCurveTo(-wb, -d / 2, -wb + rb, -d / 2);
  return s;
}

/** Flat panel from a shape lying in XZ (shape y = item +z), top at height y. */
function seatPanel(shape, thick, y, bevel = 0.004, curveSegs = 4) {
  const g = extrude(shape, thick, { bevel, bevelSegs: 1, curveSegs });
  // rotate +90° about X: extrusion axis -> vertical, shape y -> item +z (front)
  xf(g, [0, y - thick / 2, 0], [Math.PI / 2, 0, 0]);
  return g;
}

/** Bend a geometry in plan: z += k·x² above height y0 (blending in over `blend`). */
function wrapBack(g, k, y0, blend) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), x = p.getX(i);
    const t = THREE.MathUtils.smoothstep(y, y0, y0 + blend);
    p.setZ(i, p.getZ(i) + k * x * x * t);
  }
  g.computeVertexNormals();
  return g;
}

/** Far-range chair (> 200 m, a few pixels tall): boxes with the right silhouette. */
function farChair(style) {
  const B = (w, h, d, x, y, z, rx = 0) => xf(rbox(w, h, d, 0), [x, y, z], [rx, 0, 0]);
  const legs = (t, tall = false) => [B(t, SEAT_H, t, -0.2, SEAT_H / 2, 0.18), B(t, SEAT_H, t, 0.2, SEAT_H / 2, 0.18),
    B(t, tall ? 0.82 : SEAT_H, t, -0.19, (tall ? 0.82 : SEAT_H) / 2, -0.2), B(t, tall ? 0.82 : SEAT_H, t, 0.19, (tall ? 0.82 : SEAT_H) / 2, -0.2)];
  const seat = B(0.44, 0.03, 0.42, 0, SEAT_H - 0.015, 0);
  if (style === 'wicker') {
    const tub = profileWall(6, (t) => { const a = THREE.MathUtils.lerp(-2.2, 2.2, t); return [Math.sin(a) * 0.25, -0.03 - Math.cos(a) * 0.23, Math.sin(a), -Math.cos(a)]; },
      (t) => { const H = 0.66 + 0.15 * Math.cos(THREE.MathUtils.lerp(-1, 1, t) * Math.PI / 2); return [[0.025, 0.36], [0.025, H], [-0.025, H], [-0.025, SEAT_H]]; });
    return { body: merge([tub, B(0.46, 0.08, 0.42, 0, SEAT_H - 0.04, 0.01), ...legs(0.035)]) };
  }
  const back = B(0.42, style === 'metal' ? 0.24 : 0.28, 0.03, 0, 0.68, -0.235, -0.18);
  if (style === 'bistro') return { frame: merge([...legs(0.027, true), B(0.47, 0.03, 0.03, 0, 0.8, -0.25)]), weave: merge([seat, back]) };
  return { shell: merge([seat, back, ...legs(0.028, true)]), frame: merge([seat, back, ...legs(0.024, true)]) };
}

/** Parisian woven bistro armchair: rattan frame, woven seat and curved back band. */
function bistroChair(lod) {
  if (lod) return farChair('bistro');
  const rad = 5, R = 0.0135;
  const frame = [], weave = [];
  const seat = roundedRectShape(0.44, 0.41, 0.07, 0.04, 0.035);
  weave.push(seatPanel(seat, 0.026, SEAT_H - 0.004, 0.004, 3));
  // seat rim
  const outline = seat.getSpacedPoints(18).slice(0, -1).map((p) => V(p.x * 1.02, SEAT_H - 0.01, p.y * 1.02));
  frame.push(tube(outline, R * 0.95, { radial: rad, closed: true, bend: 0.03 }));
  // legs (slight splay), rear legs rise into the back uprights
  for (const sx of [-1, 1]) {
    frame.push(tube([V(sx * 0.195, SEAT_H - 0.02, 0.165), V(sx * 0.212, 0.2, 0.19), V(sx * 0.22, 0.0, 0.205)], R, { radial: rad, bend: 0.2 }));
    frame.push(tube([V(sx * 0.17, 0.0, -0.245), V(sx * 0.165, 0.2, -0.215), V(sx * 0.16, SEAT_H, -0.19), V(sx * 0.17, 0.62, -0.215), V(sx * 0.18, 0.79, -0.24)], R, { radial: rad, bend: 0.25 }));
  }
  // stretcher ring + decorative curls under the seat front
  const ring = [V(-0.2, 0.17, 0.185), V(0.2, 0.17, 0.185), V(0.17, 0.17, -0.222), V(-0.17, 0.17, -0.222)];
  frame.push(tube(ring, R * 0.75, { radial: rad, closed: true, bend: 0.06 }));
  if (!lod) {
    for (const sx of [-1, 1]) {
      const c = [];
      for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI * 1.6; c.push(V(sx * (0.13 - 0.035 * Math.sin(a)), SEAT_H - 0.04 - 0.035 * (1 - Math.cos(a)), 0.19)); }
      frame.push(tube(c, R * 0.6, { radial: 4, bend: 0 }));
    }
  }
  // back + arms: continuous double rail from front leg tops round the back
  const back = (y, k = 1) => [
    V(-0.2, SEAT_H - 0.01, 0.16), V(-0.215, 0.6, 0.15), V(-0.235 * k, 0.665, 0.07), V(-0.24 * k, y, -0.12),
    V(-0.17 * k, y + 0.12, -0.24), V(0, y + 0.15, -0.285), V(0.17 * k, y + 0.12, -0.24), V(0.24 * k, y, -0.12),
    V(0.235 * k, 0.665, 0.07), V(0.215, 0.6, 0.15), V(0.2, SEAT_H - 0.01, 0.16),
  ];
  frame.push(tube(back(0.675), R, { radial: rad, bend: 0.09, bendSegs: 2 }));
  frame.push(tube(back(0.645, 0.985).slice(2, -2), R * 0.8, { radial: 4, bend: 0.09, bendSegs: 2 }));
  // woven back band under the rail: highest at the centre, following the rail in plan
  const band = profileWall(10, (t) => {
    const a = THREE.MathUtils.lerp(-0.95, 0.95, t);
    return [Math.sin(a) * 0.225, -0.04 - Math.cos(a) * 0.205, Math.sin(a), -Math.cos(a)];
  }, (t) => {
    const a = THREE.MathUtils.lerp(-0.95, 0.95, t);
    const yc = 0.555 + 0.17 * Math.pow(Math.cos(a), 1.5), h = 0.085, k = 0.03; // k: lean back at the top
    return [[0.006, yc - h], [0.006 + k, yc + h], [0, yc + h + 0.005], [-0.006 + k, yc + h], [-0.006, yc - h], [0, yc - h - 0.005], [0.006, yc - h]];
  });
  weave.push(band);
  return { frame: merge(frame), weave: merge(weave) };
}

/** Moulded polypropylene stacking chair: dished seat, curved back on the rear legs. */
function plasticChair(lod) {
  if (lod) return farChair('plastic');
  const parts = [];
  const seat = seatPanel(roundedRectShape(0.45, 0.43, 0.06, 0.05, 0.01), 0.018, SEAT_H, 0.005, 4);
  { // dish + waterfall front
    const p = seat.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, p.getY(i) - 0.012 * (1 - (x / 0.225) ** 2) * (1 - ((z + 0.02) / 0.23) ** 2) - (z > 0.15 ? (z - 0.15) * 0.35 : 0));
    }
    seat.computeVertexNormals();
  }
  parts.push(seat);
  const backS = new THREE.Shape();
  { const w = 0.42, h = 0.3, r = 0.06; backS.moveTo(-w / 2 + r, 0); backS.lineTo(w / 2 - r, 0); backS.quadraticCurveTo(w / 2, 0, w / 2, r); backS.lineTo(w / 2 + 0.01, h - r); backS.quadraticCurveTo(w / 2 + 0.01, h, w / 2 - r, h); backS.lineTo(-w / 2 + r, h); backS.quadraticCurveTo(-w / 2 - 0.01, h, -w / 2 - 0.01, h - r); backS.lineTo(-w / 2, r); backS.quadraticCurveTo(-w / 2, 0, -w / 2 + r, 0); }
  const backG = extrude(backS, 0.016, { bevel: 0.005, bevelSegs: 1, curveSegs: 4 });
  xf(backG, [0, 0.54, -0.235], [-0.2, 0, 0]);
  wrapBack(backG, 0.75, 0.0, 0.01);
  parts.push(backG);
  // legs: tapered rounded bars, rear legs continue up as the back uprights
  const legP = rectProfile(0.03, 0.024, 0.008, 1);
  const taper = (t) => 1 - 0.25 * (1 - t);
  for (const sx of [-1, 1]) {
    parts.push(sweep([V(sx * 0.225, 0, 0.235), V(sx * 0.2, SEAT_H - 0.01, 0.17)], legP, { bend: 0, scales: (t) => taper(t) }));
    parts.push(sweep([V(sx * 0.225, 0, -0.285), V(sx * 0.2, SEAT_H - 0.01, -0.19), V(sx * 0.212, 0.7, -0.255), V(sx * 0.21, 0.81, -0.28)], legP, { bend: 0.12, scales: (t) => taper(Math.min(1, t * 2.2)) }));
  }
  return { shell: merge(parts) };
}

/** Aluminium stacking armchair: tubular frame, slatted seat and back. */
function metalChair(lod) {
  if (lod) return farChair('metal');
  const R = 0.0115, rad = 6;
  const parts = [];
  for (const sx of [-1, 1]) {
    const x = sx * 0.225;
    parts.push(tube([V(x, 0, 0.215), V(x, 0.635, 0.2), V(x * 1.02, 0.665, 0.05), V(x * 1.03, 0.665, -0.13), V(x, 0.835, -0.255)], R, { radial: rad, bend: 0.06 }));
    parts.push(tube([V(x * 1.04, 0, -0.31), V(x, SEAT_H - 0.02, -0.19)], R, { radial: rad, bend: 0 }));
  }
  // seat frame + slats
  parts.push(tube([V(-0.225, SEAT_H - 0.02, 0.2), V(0.225, SEAT_H - 0.02, 0.2), V(0.225, SEAT_H - 0.02, -0.195), V(-0.225, SEAT_H - 0.02, -0.195)], R * 0.85, { radial: rad, closed: true, bend: 0.03 }));
  const nS = lod ? 3 : 7;
  for (let i = 0; i < nS; i++) {
    const z = THREE.MathUtils.lerp(0.175, -0.17, i / (nS - 1));
    parts.push(bar([V(-0.225, SEAT_H - 0.004, z), V(0.225, SEAT_H - 0.004, z)], 0.006, lod ? 0.1 : 0.042, { r: 0.002, up: [0, 1, 0], bend: 0 }));
  }
  // curved back slats + top rail
  const backRow = (y, zc) => { const pts = []; for (let i = 0; i <= 6; i++) { const x = THREE.MathUtils.lerp(-0.228, 0.228, i / 6); pts.push(V(x, y, zc - 0.07 * (1 - (x / 0.228) ** 2))); } return pts; };
  parts.push(tube(backRow(0.835, -0.255), R, { radial: rad, bend: 0 }));
  const nB = lod ? 1 : 3;
  for (let i = 0; i < nB; i++) {
    const y = lod ? 0.7 : 0.6 + i * 0.075, zc = -0.215 - (y - 0.6) * 0.33;
    parts.push(bar(backRow(y, zc), 0.007, lod ? 0.2 : 0.05, { r: 0.002, up: [0, 0.35, 1], bend: 0 }));
  }
  return { frame: merge(parts) };
}

/** Woven wicker tub armchair. */
function wickerChair(lod) {
  if (lod) return farChair('wicker');
  const parts = [];
  // horseshoe wall whose height rises from the arms to the back
  const ang = (t) => THREE.MathUtils.lerp(-2.25, 2.25, t);
  parts.push(profileWall(18, (t) => {
    const a = ang(t);
    return [Math.sin(a) * 0.255, -0.03 - Math.cos(a) * 0.235, Math.sin(a), -Math.cos(a) * (0.235 / 0.255)];
  }, (t) => {
    const H = 0.66 + 0.15 * Math.pow(Math.cos((ang(t) / 2.25) * Math.PI / 2), 1.6);
    return [[0.026, 0.36], [0.026, H - 0.03], [0.018, H - 0.006], [0, H + 0.004], [-0.018, H - 0.006], [-0.026, H - 0.03], [-0.026, SEAT_H + 0.03]];
  }));
  parts.push(xf(rbox(0.46, 0.07, 0.42, 0.025, 1), [0, SEAT_H - 0.035, 0.01]));
  // legs wrapped in wicker
  for (const [x, z] of [[-0.2, 0.17], [0.2, 0.17], [-0.19, -0.2], [0.19, -0.2]]) {
    parts.push(tube([V(x * 1.08, 0, z * 1.1), V(x, 0.4, z)], 0.017, { radial: 6, bend: 0 }));
  }
  return { body: merge(parts) };
}

// ------------------------------------------------------------------ tables
function tableTop(shape, lod) {
  if (shape === 'round') {
    const r = 0.3;
    return merge([lathe([[0, 0.722], [r - 0.006, 0.722], [r, 0.727], [r, 0.745], [r - 0.004, 0.75], [0, 0.75]], lod ? 8 : 20)]);
  }
  return merge([xf(rbox(0.62, 0.028, 0.62, lod ? 0.002 : 0.006, lod ? 1 : 2), [0, 0.736, 0])]);
}

function tableBase(type, lod) {
  const seg = lod ? 6 : 12;
  if (type === 'iron') { // cast-iron pedestal with a domed round foot
    return merge([lathe([[0.215, 0], [0.215, 0.012], [0.19, 0.024], [0.11, 0.042], [0.05, 0.075], [0.034, 0.12], [0.046, 0.13], [0.046, 0.15], [0.03, 0.165],
      [0.026, 0.6], [0.04, 0.615], [0.04, 0.645], [0.03, 0.66], [0.032, 0.7], [0.11, 0.705], [0.11, 0.72], [0, 0.722]], seg)]);
  }
  // cross base: column + four flat feet with glides
  const parts = [lathe([[0.03, 0.02], [0.03, 0.7], [0.1, 0.705], [0.1, 0.72], [0, 0.722]], seg)];
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    const c = Math.cos(a), s = Math.sin(a);
    parts.push(bar([V(c * 0.02, 0.05, s * 0.02), V(c * 0.29, 0.022, s * 0.29)], 0.012, 0.045, { r: 0.004, up: [0, 1, 0], bend: 0 }));
    if (!lod) parts.push(xf(lathe([[0.018, 0], [0.018, 0.012], [0, 0.014]], 8), [c * 0.28, 0, s * 0.28]));
  }
  return merge(parts);
}

// ------------------------------------------------------------------ umbrellas
const UMB_EDGE_H = 2.38;

/** Square market umbrella canopy (8 ribs, sag between ribs, drooping edges, valance,
 *  wind vent), with an 'aFlex' attribute for flutter and seam darkening in vertex colours. */
function canopyGeo(size, lod) {
  const a = size / 2, rise = 0.27 * a, apex = UMB_EDGE_H + rise;
  const nr = lod ? 2 : 8, nt = lod ? 2 : 6, val = 0.2;
  const pos = [], uv = [], col = [], flex = [], idx = [];
  const tips = [];
  for (let k = 0; k < 8; k++) {
    const ang = (k * Math.PI) / 4;
    const c = Math.cos(ang), s = Math.sin(ang);
    const m = Math.max(Math.abs(c), Math.abs(s));
    tips.push([(c / m) * a, (s / m) * a]);
  }
  const r0 = 0.07;
  const surf = (k, r, t) => {
    const A = tips[k], B = tips[(k + 1) % 8];
    const ox = A[0] + (B[0] - A[0]) * t, oz = A[1] + (B[1] - A[1]) * t;
    const rr = r0 / Math.hypot(ox, oz) + r * (1 - r0 / Math.hypot(ox, oz));
    const bow = 0.035 * Math.sin(Math.PI * rr);
    // fabric sags between the ribs, most in mid-panel; the hem is tensioned
    const sag = (0.03 * a * Math.pow(Math.sin(Math.PI * Math.min(1, rr * 1.1)), 0.8) + 0.016 * rr) * Math.sin(Math.PI * t);
    return [ox * rr, apex - rise * rr - bow - sag * (rr > 0.05 ? 1 : 0), oz * rr];
  };
  const push = (p, u, v, c, f) => { pos.push(p[0], p[1], p[2]); uv.push(u, v); col.push(c, c, c); flex.push(f); };
  for (let k = 0; k < 8; k++) {
    const base = pos.length / 3;
    for (let i = 0; i <= nr; i++) for (let j = 0; j <= nt; j++) {
      const r = i / nr, t = j / nt;
      const p = surf(k, r, t);
      const seam = 1 - 0.07 * (1 - THREE.MathUtils.smoothstep(Math.min(t, 1 - t), 0, 0.06));
      const dirt = 1 - 0.05 * r * r; // airborne grime collects towards the hem
      push(p, p[0], p[2], seam * dirt, 0.12 * Math.sin(Math.PI * t) * r);
    }
    for (let i = 0; i < nr; i++) for (let j = 0; j < nt; j++) {
      const a0 = base + i * (nt + 1) + j, b0 = a0 + 1, c0 = a0 + nt + 1, d0 = c0 + 1;
      idx.push(a0, b0, c0, b0, d0, c0);
    }
    // valance: hangs from the edge, slight outward flare, darker piping at the hem
    const vb = pos.length / 3;
    const rows = lod ? [0, 1] : [0, 0.45, 0.88, 1];
    for (const vv of rows) for (let j = 0; j <= nt; j++) {
      const t = j / nt, e = surf(k, 1, t);
      const A = tips[k], B = tips[(k + 1) % 8];
      const nx = (B[1] - A[1]), nz = -(B[0] - A[0]), nl = Math.hypot(nx, nz);
      const out = 0.012 * vv;
      const along = THREE.MathUtils.lerp(0, Math.hypot(B[0] - A[0], B[1] - A[1]), t) + k * a;
      push([e[0] + (nx / nl) * out, e[1] - val * vv, e[2] + (nz / nl) * out], along, -val * vv, vv > 0.9 ? 0.86 : 1, vv);
    }
    for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < nt; j++) {
      const a0 = vb + i * (nt + 1) + j, b0 = a0 + 1, c0 = a0 + nt + 1, d0 = c0 + 1;
      idx.push(a0, b0, c0, b0, d0, c0);
    }
  }
  // wind vent cap over the apex
  {
    const vb = pos.length / 3, vr = Math.max(0.2, a * 0.14), vy = apex + 0.075;
    push([0, vy + vr * 0.32, 0], 0, 0, 1, 0.05);
    for (let k = 0; k <= 8; k++) {
      const ang = (k * Math.PI) / 4, c = Math.cos(ang), s = Math.sin(ang), m = Math.max(Math.abs(c), Math.abs(s));
      push([(c / m) * vr, vy, (s / m) * vr], (c / m) * vr, (s / m) * vr, 1, 0.1);
    }
    for (let k = 0; k < 8; k++) idx.push(vb, vb + 2 + k, vb + 1 + k);
    const vs = pos.length / 3; // vent skirt
    for (let k = 0; k <= 8; k++) {
      const ang = (k * Math.PI) / 4, c = Math.cos(ang), s = Math.sin(ang), m = Math.max(Math.abs(c), Math.abs(s));
      push([(c / m) * vr, vy, (s / m) * vr], k * vr, 0, 1, 0.2);
      push([(c / m) * vr * 1.01, vy - 0.05, (s / m) * vr * 1.01], k * vr, -0.05, 0.9, 0.6);
    }
    for (let k = 0; k < 8; k++) { const a0 = vs + k * 2; idx.push(a0, a0 + 2, a0 + 1, a0 + 2, a0 + 3, a0 + 1); }
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx, { color: { array: col, size: 3 }, aFlex: { array: flex, size: 1 } });
  g.computeVertexNormals();
  return { geo: merge([g]), apex, rise, tips, surf };
}

function umbrellaFrame(size, lod, canopy) {
  const { apex, surf } = canopy;
  const parts = [];
  const seg = lod ? 6 : 10;
  // pole with top hub, runner, finial
  const run = apex - 0.78;
  parts.push(lathe([[0.024, 0.0], [0.024, run - 0.05], [0.036, run - 0.045], [0.04, run], [0.04, run + 0.06], [0.026, run + 0.07],
    [0.024, apex - 0.09], [0.05, apex - 0.08], [0.05, apex + 0.0], [0.024, apex + 0.01], [0.022, apex + 0.12], [0.03, apex + 0.15], [0.028, apex + 0.19], [0, apex + 0.2]], seg));
  if (lod) return merge(parts);
  // ribs under the fabric + stretchers from the runner
  for (let k = 0; k < 8; k++) {
    const pts = [];
    for (let i = 0; i <= 4; i++) { const p = surf(k, Math.max(0.02, i / 4), 0); pts.push(V(p[0], p[1] - 0.018, p[2])); }
    parts.push(bar(pts, 0.016, 0.022, { r: 0.004, up: [0, 1, 0], bend: 0 }));
    const m = surf(k, 0.46, 0);
    const ang = (k * Math.PI) / 4;
    parts.push(tube([V(Math.cos(ang) * 0.04, run + 0.03, Math.sin(ang) * 0.04), V(m[0], m[1] - 0.03, m[2])], 0.0075, { radial: 5, bend: 0 }));
  }
  return merge(parts);
}

function umbrellaBase(lod) {
  return merge([
    xf(rbox(0.56, 0.11, 0.56, 0.012, lod ? 1 : 2), [0, 0.055, 0]),
    lathe([[0.05, 0.11], [0.05, 0.3], [0.04, 0.31], [0.033, 0.31], [0, 0.31]], lod ? 6 : 14),
  ]);
}

/** Furled umbrella: spindle of folded fabric with a strap. */
function furledGeo(lod) {
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

// ------------------------------------------------------------------ tableware & menu boards
function cupSet() {
  const cer = merge([
    lathe([[0, 0], [0.05, 0], [0.068, 0.01], [0.066, 0.013], [0.048, 0.005], [0, 0.005]], 12),
    lathe([[0, 0.006], [0.025, 0.006], [0.036, 0.02], [0.04, 0.06], [0.037, 0.062], [0.034, 0.025], [0, 0.02]], 12),
    tube([V(0.038, 0.05, 0), V(0.058, 0.048, 0), V(0.058, 0.025, 0), V(0.037, 0.022, 0)], 0.004, { radial: 5, bend: 0.01 }),
  ]);
  const cof = merge([xf(new THREE.CircleGeometry(0.034, 14), [0, 0.054, 0], [-Math.PI / 2, 0, 0])]);
  return { cer, cof };
}
function waterGlass() {
  return merge([lathe([[0, 0], [0.03, 0], [0.036, 0.105], [0.0335, 0.105], [0.028, 0.004], [0, 0.004]], 12)]);
}
function napkinHolder() {
  return {
    steel: merge([xf(rbox(0.1, 0.012, 0.06, 0), [0, 0.006, 0]), xf(rbox(0.004, 0.08, 0.05, 0), [-0.025, 0.05, 0]), xf(rbox(0.004, 0.08, 0.05, 0), [0.025, 0.05, 0])]),
    paper: merge([xf(rbox(0.044, 0.09, 0.07, 0), [0, 0.057, 0])]),
  };
}

function menuBoard(variant) {
  // A-frame: two 0.6 x 0.85 panels hinged at the top, splayed ~22°
  const W = 0.6, H = 0.88, spl = 0.2;
  const wood = [], face = [];
  for (const side of [1, -1]) {
    const leg = (x) => bar([V(x, 0, side * 0.17), V(x, H, side * 0.012)], 0.03, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 });
    wood.push(leg(-W / 2 + 0.015), leg(W / 2 - 0.015));
    wood.push(bar([V(-W / 2, H - 0.02, side * 0.016), V(W / 2, H - 0.02, side * 0.016)], 0.04, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 }));
    wood.push(bar([V(-W / 2, 0.12, side * 0.148), V(W / 2, 0.12, side * 0.148)], 0.04, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 }));
    const q = quad(W - 0.06, H - 0.2, uvRect(`chalk${variant}`));
    xf(q, [0, 0.12 + (H - 0.14) / 2, side * 0.08], [-side * spl, side > 0 ? 0 : Math.PI, 0]);
    face.push(q);
  }
  return { wood: merge(wood), face: merge(face) };
}

// ------------------------------------------------------------------ prototypes
const PLASTIC = ['#86b5d3', '#cdbb9f', '#e6e3dc', '#d2492f', '#43474b', '#8a9a5b'];
const PLASTIC_PAIRS = [[0, 1], [0, 0], [2, 2], [3, 3], [4, 4], [5, 1], [1, 1]];
const UMB_COL = { cream: '#e6dcc4', white: '#efede6', navy: '#28324a', burgundy: '#6c2531', sand: '#cdb894' };
const srgb = (h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace);

export function buildCafeProtos(M, F) {
  const P = { chair: {}, top: {}, base: {}, umb: {}, misc: {} };
  for (const lod of [0, 1]) {
    const cast = true;
    const b = bistroChair(lod);
    P.chair[`bistro${lod}`] = F.weave.map((w, i) => proto(`chairBistro${i}`, [{ geo: b.frame, mat: F.rattan, cast }, { geo: b.weave, mat: w, cast }]));
    P.chair[`plastic${lod}`] = proto('chairPlastic', [{ geo: plasticChair(lod).shell, mat: F.plastic, tint: true, cast }]);
    const mc = metalChair(lod).frame;
    P.chair[`metal${lod}`] = proto('chairMetal', [{ geo: mc, mat: F.aluminium, cast }]);
    P.chair[`metalPaint${lod}`] = proto('chairMetalPaint', [{ geo: mc, mat: F.paint, tint: true, cast }]);
    P.chair[`wicker${lod}`] = proto('chairWicker', [{ geo: wickerChair(lod).body, mat: F.wicker, tint: true, cast }]);
    for (const shape of ['round', 'square']) {
      const g = tableTop(shape, lod);
      P.top[`${shape}stone${lod}`] = proto('tableTopStone', [{ geo: g, mat: F.tabletop, tint: true, cast }]);
      P.top[`${shape}alu${lod}`] = proto('tableTopAlu', [{ geo: g, mat: F.aluminium, cast }]);
      P.top[`${shape}wood${lod}`] = proto('tableTopWood', [{ geo: g, mat: M.get('wood.bench'), cast }]);
    }
    P.base[`iron${lod}`] = proto('tableBaseIron', [{ geo: tableBase('iron', lod), mat: M.get('metal.iron'), cast }]);
    P.base[`cross${lod}`] = proto('tableBaseCross', [{ geo: tableBase('cross', lod), mat: F.aluminium, cast }]);
    P.base[`crossDark${lod}`] = proto('tableBaseCrossDark', [{ geo: tableBase('cross', lod), mat: M.get('metal.iron'), cast }]);
    // umbrellas: canopy geometry per size bucket (0.1 m steps)
    for (let sz = 28; sz <= 36; sz++) {
      const cg = canopyGeo(sz / 10, lod);
      const fr = umbrellaFrame(sz / 10, lod, cg);
      P.umb[`${sz}_${lod}`] = {
        canopy: proto('umbrellaCanopy', [{ geo: cg.geo, mat: F.canopy, tint: true, cast: true }]),
        alu: proto('umbrellaFrameAlu', [{ geo: fr, mat: F.aluminium, cast }]),
        wood: proto('umbrellaFrameWood', [{ geo: fr, mat: M.get('wood.bench'), cast }]),
      };
    }
    P.umb[`base${lod}`] = proto('umbrellaBase', [{ geo: umbrellaBase(lod), mat: M.get('concrete'), cast }]);
    P.umb[`furled${lod}`] = proto('umbrellaFurled', [{ geo: furledGeo(lod), mat: F.canopy, tint: true, cast: true }]);
    P.umb[`furledPole${lod}`] = proto('umbrellaFurledPole', [{ geo: merge([lathe([[0.024, 0], [0.024, 2.9], [0.03, 2.93], [0.028, 2.98], [0, 2.99]], lod ? 6 : 12)]), mat: F.aluminium, cast }]);
  }
  const pole = M.get('metal.pole');
  const unit = (w, h) => merge([bar([V(0, 0, 0), V(0, 0, 1)], w, h, { up: [0, 1, 0], r: 0.006, bend: 0 })]);
  P.misc.post = proto('canopyPost', [{ geo: unit(0.07, 0.07), mat: pole }]);
  P.misc.rafter = proto('canopyRafter', [{ geo: unit(0.1, 0.05), mat: pole }]);
  P.misc.beam = proto('canopyBeam', [{ geo: unit(0.1, 0.06), mat: pole }]);
  const cs = cupSet();
  P.misc.cup = proto('cup', [{ geo: cs.cer, mat: F.ceramic, cast: false }, { geo: cs.cof, mat: F.coffee, cast: false }]);
  P.misc.glass = proto('glass', [{ geo: waterGlass(), mat: F.drinkGlass, cast: false }]);
  const nh = napkinHolder();
  P.misc.napkin = proto('napkin', [{ geo: nh.steel, mat: M.get('metal.steel'), cast: true }, { geo: nh.paper, mat: F.ceramic, cast: false }]);
  for (const v of [0, 1]) {
    const mb = menuBoard(v);
    P.misc[`menu${v}`] = proto('menuBoard', [{ geo: mb.wood, mat: M.get('wood.bench'), cast: true }, { geo: mb.face, mat: F.print, cast: true }]);
  }
  return P;
}

// ------------------------------------------------------------------ per-café style (cached)
const styleCache = new Map();
function cafeStyle(cafe, seed) {
  let st = styleCache.get(cafe);
  if (st) return st;
  const rng = RNG.from(seed, 'cafeStyle', cafe.id);
  st = { rng };
  switch (cafe.chairStyle) {
    case 'bistro': st.weave = rng.int(0, 3); st.top = rng.pick(['stone', 'stone', 'wood']); st.base = 'iron'; st.topTint = srgb(rng.pick(['#ece9e2', '#d9d5cc', '#2b2b2a'])); break;
    case 'plastic': {
      const pr = rng.pick(PLASTIC_PAIRS);
      st.plastic = pr.map((i) => srgb(PLASTIC[i]));
      st.top = rng.pick(['stone', 'alu']); st.base = rng.pick(['cross', 'crossDark']); st.topTint = srgb(rng.pick(['#e4e1da', '#3a3b3c']));
      break;
    }
    case 'metal': st.paint = rng.chance(0.35) ? srgb(rng.pick(['#e9e7e1', '#3b3e41', '#6f7a72'])) : null; st.top = rng.pick(['alu', 'stone']); st.base = 'cross'; st.topTint = srgb('#d6d3cc'); break;
    default: st.wicker = srgb(rng.pick(['#ffffff', '#ffffff', '#8a7563', '#b9b2a8'])); st.top = rng.pick(['stone', 'wood']); st.base = rng.pick(['iron', 'crossDark']); st.topTint = srgb(rng.pick(['#2f2f2e', '#e9e6df'])); break;
  }
  st.frameWood = rng.chance(0.4);
  // umbrella poles: dodge chairs and tables by sliding along the street
  // one fabric colour per terrace (as cafés buy matching sets); a few mix two
  const mixed = rng.chance(0.12);
  st.umbrellas = cafe.umbrellas.map((u, i) => {
    let best = u.s, bestScore = -1;
    for (let k = 0; k <= 16; k++) {
      const s = u.s + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.1;
      let clear = 9;
      for (const t of cafe.tables) {
        clear = Math.min(clear, Math.hypot(t.s - s, t.d - u.d) - 0.38);
        for (const c of t.chairs) clear = Math.min(clear, Math.hypot(c.s - s, c.d - u.d) - 0.3);
      }
      if (clear > bestScore + 0.02) { bestScore = clear; best = s; }
      if (clear > 0.12) break;
    }
    const r2 = RNG.from(seed, 'umb', cafe.id, i);
    const col = mixed ? u.color : cafe.umbrellas[0].color;
    return { s: best, d: u.d, size: u.size, color: srgb(UMB_COL[col] || UMB_COL.cream).multiplyScalar(r2.range(0.96, 1.02)), furled: r2.chance(0.07), yaw: r2.range(-0.03, 0.03) };
  });
  // menu board: a free spot along the walkway edge or the café ends
  {
    const side = cafe.side, cand = [];
    const dEdge = cafe.dIn + side * 0.3;
    for (let k = 0; k < 8; k++) cand.push([cafe.s0 + 0.3 + (cafe.s1 - cafe.s0 - 0.6) * (k / 7), dEdge]);
    cand.push([cafe.s0 + 0.25, (cafe.dIn + cafe.dOut) / 2], [cafe.s1 - 0.25, (cafe.dIn + cafe.dOut) / 2]);
    let best = null, bestC = 0.45;
    for (const [s, d] of cand) {
      let clear = 9;
      for (const t of cafe.tables) { clear = Math.min(clear, Math.hypot(t.s - s, t.d - d) - 0.35); for (const c of t.chairs) clear = Math.min(clear, Math.hypot(c.s - s, c.d - d) - 0.3); }
      for (const u of st.umbrellas) clear = Math.min(clear, Math.hypot(u.s - s, u.d - d) - 0.4);
      if (clear > bestC) { bestC = clear; best = [s, d]; }
    }
    st.menu = best && rng.chance(0.8) ? { s: best[0], d: best[1], yaw: rng.range(-0.4, 0.4), v: rng.int(0, 1) } : null;
  }
  styleCache.set(cafe, st);
  return st;
}

const _m = new THREE.Matrix4(), _c = new THREE.Color();

/** Add all cafés anchored in this chunk to the instancer. */
export function placeCafes(chunk, app, inst, P, extra) {
  const { route, layout } = app;
  const lod = chunk.lod;
  for (const cafe of layout.inChunk('cafes', chunk.index)) {
    const st = cafeStyle(cafe, layout.seed);
    const rng = RNG.from(layout.seed, 'cafeItems', cafe.id);
    // chairs
    for (const t of cafe.tables) {
      for (const ch of t.chairs) {
        const yaw = Math.atan2(t.d - ch.d, t.s - ch.s) + rng.range(-0.12, 0.12);
        placeMatrix(route, ch.s, ch.d, 0, yaw, _m);
        switch (cafe.chairStyle) {
          case 'bistro': inst.add(P.chair[`bistro${lod}`][st.weave], _m); break;
          case 'plastic': inst.add(P.chair[`plastic${lod}`], _m, _c.copy(st.plastic[rng.chance(0.5) ? 0 : 1]).multiplyScalar(rng.range(0.94, 1.03))); break;
          case 'metal': if (st.paint) inst.add(P.chair[`metalPaint${lod}`], _m, st.paint); else inst.add(P.chair[`metal${lod}`], _m); break;
          default: inst.add(P.chair[`wicker${lod}`], _m, _c.copy(st.wicker).multiplyScalar(rng.range(0.9, 1.05)));
        }
      }
      // table
      const tyaw = t.shape === 'square' ? rng.range(-0.08, 0.08) : rng.range(0, 6.28);
      placeMatrix(route, t.s, t.d, 0, tyaw, _m);
      inst.add(P.top[`${t.shape}${st.top}${lod}`], _m, _c.copy(st.topTint).multiplyScalar(rng.range(0.95, 1.04)));
      inst.add(P.base[`${st.base}${lod}`], _m);
      if (lod === 0) placeTableware(route, t, rng, inst, P);
    }
    // umbrellas
    for (const u of st.umbrellas) {
      const sz = THREE.MathUtils.clamp(Math.round(u.size * 10), 28, 36);
      placeMatrix(route, u.s, u.d, 0, u.yaw, _m);
      inst.add(P.umb[`base${lod}`], _m);
      if (u.furled) {
        inst.add(P.umb[`furledPole${lod}`], _m);
        inst.add(P.umb[`furled${lod}`], _m, u.color);
      } else {
        const U = P.umb[`${sz}_${lod}`];
        inst.add(U.canopy, _m, u.color);
        inst.add(st.frameWood ? U.wood : U.alu, _m);
      }
    }
    if (st.menu && lod === 0) {
      placeMatrix(route, st.menu.s, st.menu.d, 0, (cafe.side > 0 ? -Math.PI / 2 : Math.PI / 2) + st.menu.yaw, _m);
      inst.add(P.misc[`menu${st.menu.v}`], _m);
    }
    if (cafe.style === 'awning' && cafe.tables.length >= 6 && extra) extra.push(cafe);
  }
}

function placeTableware(route, t, rng, inst, P) {
  if (rng.chance(0.35)) return;
  if (rng.chance(0.55)) { // napkin holder at the centre
    placeMatrix(route, t.s + rng.range(-0.04, 0.04), t.d + rng.range(-0.04, 0.04), 0.75, rng.range(0, 3.14), _m);
    inst.add(P.misc.napkin, _m);
  }
  for (const ch of t.chairs) {
    if (!rng.chance(0.45)) continue;
    const dx = ch.s - t.s, dd = ch.d - t.d, l = Math.hypot(dx, dd) || 1;
    const r = rng.range(0.15, 0.2), side = rng.range(-0.08, 0.08);
    const s = t.s + (dx / l) * r - (dd / l) * side, d = t.d + (dd / l) * r + (dx / l) * side;
    placeMatrix(route, s, d, 0.75, rng.range(0, 6.28), _m);
    inst.add(rng.chance(0.6) ? P.misc.cup : P.misc.glass, _m);
  }
}

/** Freestanding canopy over an 'awning' style terrace: steel posts and rafters (instanced),
 *  a fabric roof sagging between the rafters with a valance (merged, cached per café). */
const roofCache = new Map();
export function buildCafeCanopy(cafe, app, addMesh, F, inst, P) {
  const { route, layout } = app;
  const s0 = cafe.s0 - 0.1, s1 = cafe.s1 + 0.1, dIn = cafe.dIn, dOut = cafe.dOut;
  const hIn = 2.55, hOut = 2.95;
  const nBays = Math.max(1, Math.round((s1 - s0) / 3.2));
  const pt = (s, d, h) => route.toWorld(s, d, h, new THREE.Vector3());
  for (let i = 0; i <= nBays; i++) {
    const s = s0 + ((s1 - s0) * i) / nBays;
    inst.add(P.misc.post, segmentMatrix(pt(s, dIn, 0), pt(s, dIn, hIn), _m));
    if (i === 0 || i === nBays) inst.add(P.misc.post, segmentMatrix(pt(s, dOut, 0), pt(s, dOut, hOut), _m));
    inst.add(P.misc.rafter, segmentMatrix(pt(s, dIn, hIn), pt(s, dOut, hOut), _m));
  }
  inst.add(P.misc.beam, segmentMatrix(pt(s0, dIn, hIn - 0.05), pt(s1, dIn, hIn - 0.05), _m));
  inst.add(P.misc.beam, segmentMatrix(pt(s0, dOut, hOut - 0.05), pt(s1, dOut, hOut - 0.05), _m));
  let g = roofCache.get(cafe);
  if (!g) {
    g = canopyRoof(cafe, app, s0, s1, dIn, dOut, hIn, hOut, nBays);
    roofCache.set(cafe, g);
  }
  addMesh(g, F.canopy);
}

function canopyRoof(cafe, app, s0, s1, dIn, dOut, hIn, hOut, nBays) {
  const { route, layout } = app;
  const rng = RNG.from(layout.seed, 'cafeCanopy', cafe.id);
  const side = cafe.side;
  const color = srgb(rng.pick(['#e6dcc4', '#efede6', '#5d2a2c', '#2f3f37', '#cdb894']));
  const p = new THREE.Vector3();
  const ns = nBays * 6, nd = 6;
  const pos = [], uv = [], col = [], flex = [], idx = [];
  const c = [color.r, color.g, color.b];
  for (let i = 0; i <= ns; i++) for (let j = 0; j <= nd; j++) {
    const s = s0 + ((s1 - s0) * i) / ns, f = j / nd;
    const d = THREE.MathUtils.lerp(dIn, dOut, f);
    const bayT = (i % 6) / 6;
    const sag = 0.06 * Math.sin(Math.PI * bayT) * Math.sin(Math.PI * Math.min(1, f * 1.05 + 0.02));
    route.toWorld(s, d, THREE.MathUtils.lerp(hIn, hOut, f) + 0.05 - sag, p);
    pos.push(p.x, p.y, p.z); uv.push(s, d); col.push(...c); flex.push(0.05 * Math.sin(Math.PI * bayT));
  }
  const W = nd + 1;
  for (let i = 0; i < ns; i++) for (let j = 0; j < nd; j++) {
    const a = i * W + j, b = a + 1, cc = a + W, d = cc + 1;
    if (side > 0) idx.push(a, b, cc, b, d, cc); else idx.push(a, cc, b, b, cc, d);
  }
  // valance on the street side
  const vb = pos.length / 3;
  for (let i = 0; i <= ns; i++) for (const v of [0, 0.85, 1]) {
    const s = s0 + ((s1 - s0) * i) / ns;
    route.toWorld(s, dIn - side * 0.01, hIn + 0.05 - v * 0.25, p);
    pos.push(p.x, p.y, p.z); uv.push(s, -v * 0.25);
    const k = v > 0.9 ? 0.85 : 1; col.push(c[0] * k, c[1] * k, c[2] * k); flex.push(v);
  }
  for (let i = 0; i < ns; i++) for (let j = 0; j < 2; j++) {
    const a = vb + i * 3 + j, b = a + 1, cc = a + 3, d = cc + 1;
    if (side < 0) idx.push(a, b, cc, b, d, cc); else idx.push(a, cc, b, b, cc, d);
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx, { color: { array: col, size: 3 }, aFlex: { array: flex, size: 1 } });
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.userData.shared = true;
  return g;
}
