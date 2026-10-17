import * as THREE from 'three';
import { lathe, sweep, tube, bar, rbox, extrude, xf, merge, makeGeo, rectProfile, profileWall } from './kit.js';

// Café chairs: woven bistro armchair, one-piece moulded plastic shell chair, aluminium
// stacking armchair and wicker tub chair. Authoring frame: +Z = the chair's front (it
// faces its table), y up, origin on the ground. Three detail levels each: 0 close-up,
// 1 mid range (lighter tessellation, no ornaments), 2 far (a few boxes, right silhouette).

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const SEAT_H = 0.46;
const sstep = THREE.MathUtils.smoothstep;

/** Seat outline in the shape plane: x across, y towards the front (becomes +z). */
function roundedRectShape(w, d, rf, rb, taper = 0) {
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
  xf(g, [0, y - thick / 2, 0], [Math.PI / 2, 0, 0]);
  return g;
}

// ------------------------------------------------------------------ lofted moulded slab
/**
 * Thin moulded shell lofted along a side profile prof = [[z, y], ...]. hw(z, y) gives the
 * half width at a profile point, shape(xn, t) -> [dz, dy] bends the cross-section
 * (xn = -1..1 across, t = 0..1 along). Closed solid: top and bottom skins `thick` apart
 * and a rolled rim with a stiffening lip under the edge. UVs in metres.
 */
function loftSlab(prof, hw, shape, { nu = 12, thick = 0.006, rim = 0.0045, lip = 0.012 } = {}) {
  const nv = prof.length, h = thick / 2;
  const len = [0];
  for (let i = 1; i < nv; i++) len.push(len[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  const L = len[nv - 1];
  const P = [];
  for (let i = 0; i < nv; i++) {
    const [z, y] = prof[i], w = hw(z, y), t = len[i] / L, row = [];
    for (let j = 0; j <= nu; j++) {
      const xn = (2 * j) / nu - 1;
      const [dz, dy] = shape(xn, t);
      row.push(V(xn * w, y + dy, z + dz));
    }
    P.push(row);
  }
  const at = (i, j) => P[Math.max(0, Math.min(nv - 1, i))][Math.max(0, Math.min(nu, j))];
  const N = P.map((row, i) => row.map((p, j) => {
    const du = new THREE.Vector3().subVectors(at(i, j + 1), at(i, j - 1));
    const dv = new THREE.Vector3().subVectors(at(i + 1, j), at(i - 1, j));
    return du.cross(dv).normalize();
  }));
  const pos = [], uv = [], idx = [];
  const push = (p, u, v) => { pos.push(p.x, p.y, p.z); uv.push(u, v); return pos.length / 3 - 1; };
  // boundary loop (CCW seen from the top skin) with outward in-plane directions
  const loop = [];
  for (let j = 0; j < nu; j++) loop.push([0, j]);
  for (let i = 0; i < nv - 1; i++) loop.push([i, nu]);
  for (let j = nu; j > 0; j--) loop.push([nv - 1, j]);
  for (let i = nv - 1; i > 0; i--) loop.push([i, 0]);
  const outDir = (i, j) => {
    const o = new THREE.Vector3();
    if (i === 0) o.add(new THREE.Vector3().subVectors(P[0][j], P[1][j]).normalize());
    if (i === nv - 1) o.add(new THREE.Vector3().subVectors(P[nv - 1][j], P[nv - 2][j]).normalize());
    if (j === 0) o.add(new THREE.Vector3().subVectors(P[i][0], P[i][1]).normalize());
    if (j === nu) o.add(new THREE.Vector3().subVectors(P[i][nu], P[i][nu - 1]).normalize());
    const n = N[i][j];
    return o.addScaledVector(n, -o.dot(n)).normalize();
  };
  const isB = (i, j) => i === 0 || j === 0 || i === nv - 1 || j === nu;
  // skins
  for (const sgn of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i < nv; i++) for (let j = 0; j <= nu; j++) {
      const p = P[i][j].clone().addScaledVector(N[i][j], sgn * h);
      if (sgn < 0 && isB(i, j)) p.addScaledVector(outDir(i, j), -1.33 * rim);
      push(p, P[i][j].x, len[i]);
    }
    for (let i = 0; i < nv - 1; i++) for (let j = 0; j < nu; j++) {
      const a = base + i * (nu + 1) + j, b = a + 1, c = a + nu + 1, d = c + 1;
      if (sgn > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
  }
  // rim: top edge -> rolled bead -> lip under the edge -> back up to the bottom skin
  const rows = [[1, 0], [0.55, 0.8], [0, 1], [-0.7, 0.75], [-1 - lip / h, 0.45], [-1 - lip / h, -0.6], [-1, -1.33]];
  const rb = pos.length / 3, nl = loop.length;
  let acc = 0;
  for (let m = 0; m <= nl; m++) {
    const [i, j] = loop[m % nl];
    if (m) { const [pi, pj] = loop[m - 1]; acc += P[i][j].distanceTo(P[pi][pj]); }
    const o = outDir(i, j), n = N[i][j];
    rows.forEach(([kn, ko], r) => push(P[i][j].clone().addScaledVector(n, kn * h).addScaledVector(o, ko * rim), acc, r * 0.004));
  }
  const nr = rows.length;
  for (let m = 0; m < nl; m++) for (let r = 0; r < nr - 1; r++) {
    const a = rb + m * nr + r, b = a + 1, c = a + nr, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx);
  // make the rim face outwards (winding depends on the loop direction)
  const pa = new THREE.Vector3().fromArray(pos, (rb + 2) * 3), pb = new THREE.Vector3().fromArray(pos, (rb + nr + 2) * 3), pc = new THREE.Vector3().fromArray(pos, (rb + 3) * 3);
  const fn = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa));
  const [i0, j0] = loop[0];
  if (fn.dot(outDir(i0, j0)) < 0) {
    const ix = g.index.array;
    for (let q = 0; q < ix.length; q += 3) if (ix[q] >= rb) { const t = ix[q + 1]; ix[q + 1] = ix[q + 2]; ix[q + 2] = t; }
  }
  g.computeVertexNormals();
  return g;
}

/** Plan half width of a rounded-corner outline: corner radii rf (at zf end) and rb (at zb end). */
const roundedHW = (w0, w1, zf, zb, rf, rb) => (z) => {
  const t = (zf - z) / (zf - zb), w = THREE.MathUtils.lerp(w0, w1, t);
  const dzf = Math.max(0, z - (zf - rf)), dzb = Math.max(0, (zb + rb) - z);
  let hw = w;
  if (dzf > 0) hw = w - rf + Math.sqrt(Math.max(0, rf * rf - dzf * dzf));
  if (dzb > 0) hw = w - rb + Math.sqrt(Math.max(0, rb * rb - dzb * dzb));
  return Math.max(0.02, hw);
};

// ------------------------------------------------------------------ far chair
/** Far-range chair (> 130 m, a few pixels tall): boxes with the right silhouette. */
function farChair(style) {
  const B = (w, h, d, x, y, z, rx = 0) => xf(rbox(w, h, d, 0), [x, y, z], [rx, 0, 0]);
  const legs = (t, tall = false) => [B(t, SEAT_H, t, -0.2, SEAT_H / 2, 0.18), B(t, SEAT_H, t, 0.2, SEAT_H / 2, 0.18),
    B(t, tall ? 0.82 : SEAT_H, t, -0.19, (tall ? 0.82 : SEAT_H) / 2, -0.2), B(t, tall ? 0.82 : SEAT_H, t, 0.19, (tall ? 0.82 : SEAT_H) / 2, -0.2)];
  const seat = B(0.44, 0.03, 0.42, 0, SEAT_H - 0.015, 0);
  if (style === 'wicker') {
    const tub = profileWall(6, (t) => { const a = THREE.MathUtils.lerp(-2.2, 2.2, t); return [Math.sin(a) * 0.25, -0.03 - Math.cos(a) * 0.23, Math.sin(a), -Math.cos(a)]; },
      (t) => { const H = 0.64 + 0.13 * Math.cos(THREE.MathUtils.lerp(-1, 1, t) * Math.PI / 2); return [[0.025, 0.12], [0.025, H], [-0.025, H], [-0.025, SEAT_H]]; });
    return { body: merge([tub, B(0.44, SEAT_H - 0.1, 0.06, 0, (SEAT_H + 0.1) / 2, 0.2), B(0.46, 0.08, 0.42, 0, SEAT_H - 0.04, 0.01)]), cushion: merge([B(0.42, 0.05, 0.38, 0, SEAT_H + 0.02, 0.02)]) };
  }
  const back = B(0.42, style === 'metal' ? 0.24 : 0.28, 0.03, 0, 0.68, -0.235, -0.18);
  if (style === 'bistro') {
    const arms = [-1, 1].map((sx) => B(0.03, 0.03, 0.4, sx * 0.235, 0.665, -0.03));
    return { frame: merge([...legs(0.027, true), B(0.47, 0.03, 0.03, 0, 0.8, -0.25), ...arms]), weave: merge([seat, back]) };
  }
  if (style === 'metal') {
    const arms = [-1, 1].map((sx) => B(0.025, 0.025, 0.4, sx * 0.228, 0.665, -0.03));
    return { frame: merge([seat, back, ...legs(0.024, true), ...arms]) };
  }
  return { shell: merge([seat, back, ...legs(0.03, true)]) };
}

// ------------------------------------------------------------------ bistro armchair
/** Parisian woven bistro armchair: rattan frame, woven seat and curved back band. */
function bistroChair(detail) {
  if (detail >= 2) return farChair('bistro');
  const mid = detail === 1, rad = mid ? 4 : 5, R = 0.0135;
  const frame = [], weave = [];
  const seat = roundedRectShape(0.44, 0.41, 0.07, 0.04, 0.035);
  weave.push(seatPanel(seat, 0.026, SEAT_H - 0.004, mid ? 0 : 0.004, mid ? 2 : 3));
  const outline = seat.getSpacedPoints(mid ? 10 : 18).slice(0, -1).map((p) => V(p.x * 1.02, SEAT_H - 0.01, p.y * 1.02));
  frame.push(tube(outline, R * 0.95, { radial: rad, closed: true, bend: mid ? 0 : 0.03 }));
  for (const sx of [-1, 1]) {
    frame.push(tube([V(sx * 0.195, SEAT_H - 0.02, 0.165), V(sx * 0.212, 0.2, 0.19), V(sx * 0.22, 0.0, 0.205)], R, { radial: rad, bend: mid ? 0 : 0.2 }));
    frame.push(tube([V(sx * 0.17, 0.0, -0.245), V(sx * 0.165, 0.2, -0.215), V(sx * 0.16, SEAT_H, -0.19), V(sx * 0.17, 0.62, -0.215), V(sx * 0.18, 0.79, -0.24)], R, { radial: rad, bend: mid ? 0 : 0.25 }));
  }
  const ring = [V(-0.2, 0.17, 0.185), V(0.2, 0.17, 0.185), V(0.17, 0.17, -0.222), V(-0.17, 0.17, -0.222)];
  frame.push(tube(ring, R * 0.75, { radial: rad, closed: true, bend: mid ? 0 : 0.06 }));
  if (!mid) {
    for (const sx of [-1, 1]) {
      const c = [];
      for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI * 1.6; c.push(V(sx * (0.13 - 0.035 * Math.sin(a)), SEAT_H - 0.04 - 0.035 * (1 - Math.cos(a)), 0.19)); }
      frame.push(tube(c, R * 0.6, { radial: 4, bend: 0 }));
    }
  }
  const back = (y, k = 1) => [
    V(-0.2, SEAT_H - 0.01, 0.16), V(-0.215, 0.6, 0.15), V(-0.235 * k, 0.665, 0.07), V(-0.24 * k, y, -0.12),
    V(-0.17 * k, y + 0.12, -0.24), V(0, y + 0.15, -0.285), V(0.17 * k, y + 0.12, -0.24), V(0.24 * k, y, -0.12),
    V(0.235 * k, 0.665, 0.07), V(0.215, 0.6, 0.15), V(0.2, SEAT_H - 0.01, 0.16),
  ];
  frame.push(tube(back(0.675), R, { radial: rad, bend: mid ? 0 : 0.09, bendSegs: 2 }));
  if (!mid) frame.push(tube(back(0.645, 0.985).slice(2, -2), R * 0.8, { radial: 4, bend: 0.09, bendSegs: 2 }));
  const band = profileWall(mid ? 6 : 10, (t) => {
    const a = THREE.MathUtils.lerp(-0.95, 0.95, t);
    return [Math.sin(a) * 0.225, -0.04 - Math.cos(a) * 0.205, Math.sin(a), -Math.cos(a)];
  }, (t) => {
    const a = THREE.MathUtils.lerp(-0.95, 0.95, t);
    const yc = 0.555 + 0.17 * Math.pow(Math.cos(a), 1.5), h = 0.085, k = 0.03;
    return [[0.006, yc - h], [0.006 + k, yc + h], [0, yc + h + 0.005], [-0.006 + k, yc + h], [-0.006, yc - h], [0, yc - h - 0.005], [0.006, yc - h]];
  });
  weave.push(band);
  return { frame: merge(frame), weave: merge(weave) };
}

// ------------------------------------------------------------------ moulded shell chair
// side profiles (z, y): seat from the waterfall lip back to the rear edge, back from its
// lower edge (an open slot above the seat) up to the rolled top edge
const SEAT_PROF = [[0.236, 0.416], [0.244, 0.436], [0.24, 0.454], [0.225, 0.466], [0.19, 0.47], [0.13, 0.465], [0.06, 0.458],
  [-0.01, 0.454], [-0.08, 0.455], [-0.13, 0.459], [-0.165, 0.466], [-0.187, 0.478]];
const BACK_PROF = [[-0.198, 0.54], [-0.204, 0.566], [-0.212, 0.605], [-0.222, 0.65], [-0.235, 0.7], [-0.249, 0.75], [-0.262, 0.795],
  [-0.271, 0.828], [-0.28, 0.846], [-0.294, 0.853]];

/** One-piece moulded polypropylene chair: dished seat with a waterfall front, reclined
 *  lumbar-curved back with a rolled top edge, open slot between them, flat tapered legs. */
function plasticChair(detail) {
  if (detail >= 2) return farChair('plastic');
  const mid = detail === 1;
  const sub = (a) => (mid ? a.filter((_, i) => i % 2 === 0 || i === a.length - 1) : a);
  const parts = [], glides = [];
  const seatHW = roundedHW(0.234, 0.214, 0.244, -0.187, 0.075, 0.05);
  parts.push(loftSlab(sub(SEAT_PROF), (z) => seatHW(z), (xn, t) => {
    const dish = 0.024 * Math.pow(Math.sin(Math.PI * THREE.MathUtils.clamp((t - 0.12) / 0.8, 0, 1)), 0.8);
    return [0, -dish * (1 - xn * xn) + 0.01 * sstep(Math.abs(xn), 0.75, 1) * (t > 0.2 ? 1 : 0)];
  }, { nu: mid ? 6 : 14, rim: mid ? 0.003 : 0.0045, lip: mid ? 0.008 : 0.012 }));
  // back: wider at the top with round corners, wrapped round the sitter in plan
  const backHW = (z, y) => {
    const w = THREE.MathUtils.lerp(0.19, 0.222, (y - 0.54) / 0.31), r = 0.075, dy = Math.max(0, y - (0.853 - r));
    return dy > 0 ? w - r + Math.sqrt(Math.max(0, r * r - dy * dy)) : w - 0.02 + 0.02 * Math.sqrt(Math.min(1, (y - 0.54) / 0.03));
  };
  parts.push(loftSlab(sub(BACK_PROF), backHW, (xn, t) => {
    const x = xn * 0.21;
    return [0.55 * x * x * (0.6 + 0.4 * Math.sin(Math.PI * t)), 0];
  }, { nu: mid ? 6 : 14, rim: mid ? 0.003 : 0.0045, lip: mid ? 0.008 : 0.012 }));
  // flat tapered blade legs, flared where they are moulded into the shell
  const legP = rectProfile(0.02, 0.045, mid ? 0.004 : 0.006, mid ? 1 : 2);
  for (const sx of [-1, 1]) {
    parts.push(sweep([V(sx * 0.222, 0, 0.252), V(sx * 0.21, 0.24, 0.205), V(sx * 0.196, 0.452, 0.16)], legP,
      { bend: mid ? 0 : 0.15, up: [1, 0, 0], scales: (t) => (0.68 + 0.32 * t) * (1 + 0.28 * sstep(t, 0.82, 1)) }));
    parts.push(sweep([V(sx * 0.226, 0, -0.312), V(sx * 0.208, 0.25, -0.24), V(sx * 0.198, 0.455, -0.19), V(sx * 0.188, 0.62, -0.208)], legP,
      { bend: mid ? 0 : 0.12, up: [1, 0, 0], scales: (t) => (0.68 + 0.32 * Math.min(1, t * 1.6)) * (1 + 0.22 * Math.exp(-(((t - 0.7) / 0.1) ** 2))) }));
    if (!mid) for (const z of [0.252, -0.312]) glides.push(xf(lathe([[0.0, 0], [0.013, 0], [0.014, 0.004], [0.011, 0.008], [0, 0.008]], 8), [sx * (z > 0 ? 0.222 : 0.226), 0, z]));
  }
  return { shell: merge(parts), glides: glides.length ? merge(glides) : null };
}

// ------------------------------------------------------------------ aluminium armchair
/** Aluminium stacking armchair: tubular frame, slatted seat and back. */
function metalChair(detail) {
  if (detail >= 2) return farChair('metal');
  const mid = detail === 1, R = 0.0115, rad = mid ? 4 : 6;
  const parts = [];
  for (const sx of [-1, 1]) {
    const x = sx * 0.225;
    parts.push(tube([V(x, 0, 0.215), V(x, 0.635, 0.2), V(x * 1.02, 0.665, 0.05), V(x * 1.03, 0.665, -0.13), V(x, 0.835, -0.255)], R, { radial: rad, bend: mid ? 0 : 0.06 }));
    parts.push(tube([V(x * 1.04, 0, -0.31), V(x, SEAT_H - 0.02, -0.19)], R, { radial: rad, bend: 0 }));
  }
  if (!mid) parts.push(tube([V(-0.225, SEAT_H - 0.02, 0.2), V(0.225, SEAT_H - 0.02, 0.2), V(0.225, SEAT_H - 0.02, -0.195), V(-0.225, SEAT_H - 0.02, -0.195)], R * 0.85, { radial: rad, closed: true, bend: 0.03 }));
  const nS = mid ? 4 : 7;
  for (let i = 0; i < nS; i++) {
    const z = THREE.MathUtils.lerp(0.175, -0.17, i / (nS - 1));
    parts.push(bar([V(-0.225, SEAT_H - 0.004, z), V(0.225, SEAT_H - 0.004, z)], 0.006, mid ? 0.075 : 0.042, { r: mid ? 0 : 0.0025, up: [0, 1, 0], bend: 0 }));
  }
  const nRow = mid ? 3 : 6;
  const backRow = (y, zc) => { const pts = []; for (let i = 0; i <= nRow; i++) { const x = THREE.MathUtils.lerp(-0.228, 0.228, i / nRow); pts.push(V(x, y, zc - 0.07 * (1 - (x / 0.228) ** 2))); } return pts; };
  parts.push(tube(backRow(0.835, -0.255), R, { radial: rad, bend: 0 }));
  const nB = mid ? 2 : 3;
  for (let i = 0; i < nB; i++) {
    const y = 0.6 + i * (mid ? 0.11 : 0.075), zc = -0.215 - (y - 0.6) * 0.33;
    parts.push(bar(backRow(y, zc), 0.007, mid ? 0.07 : 0.05, { r: mid ? 0 : 0.0025, up: [0, 0.35, 1], bend: 0 }));
  }
  return { frame: merge(parts) };
}

// ------------------------------------------------------------------ wicker tub chair
/** Woven wicker tub armchair: horseshoe wall and front apron woven down to a low skirt,
 *  short wrapped legs, loose seat cushion. */
function wickerChair(detail) {
  if (detail >= 2) return farChair('wicker');
  const mid = detail === 1;
  const parts = [], wrap = [];
  const Y0 = 0.1;
  const ang = (t) => THREE.MathUtils.lerp(-2.25, 2.25, t);
  // tub wall: tapering in towards the skirt, height rising from the arms to the back
  parts.push(profileWall(mid ? 10 : 20, (t) => {
    const a = ang(t);
    return [Math.sin(a) * 0.255, -0.03 - Math.cos(a) * 0.235, Math.sin(a), -Math.cos(a) * (0.235 / 0.255)];
  }, (t) => {
    const H = 0.64 + 0.15 * Math.pow(Math.cos((ang(t) / 2.25) * Math.PI / 2), 1.6);
    return mid ? [[0.012, Y0], [0.026, SEAT_H - 0.05], [0.026, H - 0.015], [0, H + 0.004], [-0.026, H - 0.015], [-0.026, SEAT_H + 0.03]]
      : [[0.008, Y0], [0.016, 0.22], [0.026, SEAT_H - 0.05], [0.026, H - 0.03], [0.018, H - 0.006], [0, H + 0.004], [-0.018, H - 0.006], [-0.026, H - 0.03], [-0.026, SEAT_H + 0.03]];
  }));
  // front apron under the seat (gently bowed)
  parts.push(profileWall(mid ? 4 : 8, (t) => {
    const x = THREE.MathUtils.lerp(0.2, -0.2, t); // right to left: outward faces the front
    return [x, 0.2 + 0.02 * (1 - (x / 0.2) ** 2), 0, 1];
  }, () => [[0.0, Y0 + 0.01], [0.012, SEAT_H - 0.07], [0.0, SEAT_H - 0.03], [-0.02, SEAT_H - 0.03]]));
  parts.push(xf(rbox(0.46, 0.06, 0.42, mid ? 0 : 0.02, 1), [0, SEAT_H - 0.05, 0.01]));
  // short splayed legs, wrapped in cane
  for (const [x, z] of [[-0.19, 0.17], [0.19, 0.17], [-0.18, -0.19], [0.18, -0.19]]) {
    wrap.push(tube([V(x * 1.07, 0, z * 1.07), V(x, Y0 + 0.04, z)], 0.017, { radial: mid ? 5 : 8, bend: 0 }));
  }
  const cushion = merge([xf(rbox(0.42, 0.06, 0.38, mid ? 0.012 : 0.025, mid ? 1 : 3), [0, SEAT_H + 0.005, 0.03])]);
  return { body: merge(parts), legs: merge(wrap), cushion };
}

/** All chair styles at three detail levels: {style: [level0, level1, level2]}. */
export function buildChairGeometry() {
  const lv = (fn) => [0, 1, 2].map((d) => fn(d));
  return { bistro: lv(bistroChair), plastic: lv(plasticChair), metal: lv(metalChair), wicker: lv(wickerChair) };
}
