import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { lathe, rbox, xf, merge, makeGeo } from './kit.js';
import { proto } from './instancer.js';

// Parked vehicles in the cross streets: a hatchback, a saloon (also as a taxi with its
// roof sign), a delivery van and a motor scooter, parked along the kerbs 15-60 m into the
// side streets (beyond the bollards and the crossing at the mouth), never on the tram
// street itself.
//
// Bodies are lofted: a side profile (roof / glasshouse line, belt line, sill line with the
// wheel arches cut into it) and a plan width give a cross-section ring every few
// centimetres; each ring is a rounded section (sill, body side with its widest point low,
// shoulder, glasshouse leaning in under the roof). Every quad of the loft takes its
// material from its place on the ring and along the body: paint, glass (windscreen, rear
// window, side windows between the pillars), black trim (window seals, underbody, bumper
// lips). Wheels (tyre, alloy rim, dark brake disc), wheel-house liners, lamps, number
// plates, grille, mirrors and handles are separate small parts. A soft contact shadow
// (ambient occlusion of the car on the asphalt) is a dark decal under each vehicle.
// Authoring frame (as all furniture): +Y up, +Z = the vehicle's front, origin on the road.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** Monotone cubic through keys [[x, y], ...] (no overshoot between keys). */
function mono(keys) {
  const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (xs[i + 1] < x) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// ------------------------------------------------------------------ models
// x: metres from the rear bumper; top / belt / bottom: heights; plan: half width.
// windscreen, rear: x ranges of the glazed roof-panel quads; side: x range of the side
// glazing, pillars: x ranges inside it that stay painted (B / C pillars).
const MODELS = {
  hatch: {
    L: 4.05, tumble: 0.17, shoulder: [0.014, 0.04], wheelR: 0.31, archR: 0.375, axles: [0.72, 3.28], tyreW: 0.2,
    top: [[0, 0.97], [0.06, 1.06], [0.4, 1.4], [0.62, 1.46], [2.05, 1.48], [2.3, 1.44], [3.02, 1.0], [3.15, 0.97], [3.75, 0.9], [3.95, 0.84], [4.05, 0.72]],
    belt: [[0, 0.95], [0.45, 0.99], [2.3, 0.97], [3.1, 0.93], [4.05, 0.74]],
    bottom: [[0, 0.36], [0.16, 0.27], [3.88, 0.27], [4.05, 0.38]],
    plan: [[0, 0.8], [0.14, 0.86], [0.45, 0.88], [3.5, 0.88], [3.9, 0.85], [4.05, 0.77]],
    windscreen: [2.28, 3.04], rear: [0.08, 0.6], side: [0.66, 2.96], pillars: [[0.66, 0.92], [1.76, 1.86]],
    lamps: { head: [0.69, 0.24, 0.3, 0.11], tail: [0.98, 0.3, 0.16, 0.2], plateF: 0.42, plateR: 0.62, grille: [0.6, 0.1], bumper: null },
  },
  saloon: {
    L: 4.72, tumble: 0.17, shoulder: [0.014, 0.04], wheelR: 0.32, archR: 0.385, axles: [1.0, 3.74], tyreW: 0.21,
    top: [[0, 0.92], [0.07, 1.02], [0.22, 1.07], [0.62, 1.09], [0.86, 1.12], [1.4, 1.42], [1.62, 1.46], [2.82, 1.46], [3.0, 1.42], [3.62, 1.0], [3.76, 0.97], [4.42, 0.9], [4.62, 0.84], [4.72, 0.72]],
    belt: [[0, 0.95], [0.7, 1.02], [1.3, 1.0], [3.7, 0.94], [4.72, 0.75]],
    bottom: [[0, 0.36], [0.2, 0.28], [4.52, 0.28], [4.72, 0.36]],
    plan: [[0, 0.82], [0.14, 0.88], [0.5, 0.9], [4.1, 0.9], [4.56, 0.86], [4.72, 0.78]],
    windscreen: [2.95, 3.66], rear: [0.84, 1.48], side: [1.38, 3.52], pillars: [[2.42, 2.52]],
    lamps: { head: [0.69, 0.25, 0.32, 0.11], tail: [0.97, 0.3, 0.2, 0.14], plateF: 0.42, plateR: 0.72, grille: [0.6, 0.11], bumper: null },
  },
  van: {
    L: 5.0, tumble: 0.035, shoulder: [0.004, 0.012], wheelR: 0.33, archR: 0.4, axles: [0.95, 3.95], tyreW: 0.215,
    top: [[0, 2.22], [0.05, 2.29], [0.2, 2.31], [3.55, 2.31], [3.72, 2.24], [4.18, 1.24], [4.32, 1.18], [4.82, 1.1], [4.96, 1.02], [5.0, 0.95]],
    belt: [[0, 1.12], [4.0, 1.12], [4.3, 1.08], [5.0, 0.93]],
    bottom: [[0, 0.42], [0.18, 0.36], [4.82, 0.36], [5.0, 0.42]],
    plan: [[0, 0.95], [0.08, 0.99], [4.3, 0.99], [4.8, 0.95], [5.0, 0.84]],
    windscreen: [3.78, 4.18], rear: [-1, -1], side: [3.5, 4.12], pillars: [],
    lamps: { head: [0.9, 0.24, 0.3, 0.17], tail: [1.0, 0.07, 0.11, 0.42], plateF: 0.5, plateR: 0.56, grille: [0.82, 0.17], bumper: [0.54, 0.3] },
  },
};

// material slots of the loft
const PAINT = 0, GLASS = 1, TRIM = 2;

/**
 * Lofted body of model M. Returns {paint, glass, trim} geometries. step: station
 * spacing (m) away from the arches and window edges.
 */
function loftBody(M, step) {
  const T = mono(M.top), B = mono(M.belt), Bo = mono(M.bottom), W = mono(M.plan);
  const L = M.L;
  // stations: regular, plus every material edge and dense through the wheel arches
  const xs = new Set();
  for (let x = 0; x <= L + 1e-6; x += step) xs.add(+x.toFixed(4));
  xs.add(L);
  const edges = [...M.windscreen, ...M.rear, ...M.side, ...M.pillars.flat(), 0.2, L - 0.2];
  for (const e of edges) if (e > 0 && e < L) { xs.add(+(e - 0.004).toFixed(4)); xs.add(+(e + 0.004).toFixed(4)); }
  for (const ax of M.axles) for (let k = 0; k <= 12; k++) xs.add(+(ax - M.archR + (2 * M.archR * k) / 12).toFixed(4));
  const X = [...xs].filter((x) => x >= 0 && x <= L).sort((a, b) => a - b);
  const ring = (x) => {
    const top = T(x), belt = Math.min(B(x), top - 0.012), hw = W(x);
    let yb = Bo(x);
    for (const ax of M.axles) {
      const dx = x - ax;
      if (Math.abs(dx) < M.archR) yb = Math.max(yb, M.wheelR + Math.sqrt(M.archR * M.archR - dx * dx));
    }
    const gh = smooth(0.06, 0.24, top - belt);
    const hwR = hw - lerp(0.05, M.tumble, gh);
    const p6y = Math.min(lerp(belt + 0.02, top - 0.05, gh), top - 0.004);
    const pts = [
      [0, yb], [hw * 0.9, yb], [hw - 0.025, yb + 0.06], [hw, yb + (belt - yb) * 0.42], [hw - M.shoulder[0], belt],
      [hw - M.shoulder[1], belt + 0.004 + 0.022 * gh], [hwR, p6y], [lerp(hw * 0.62, hwR - 0.085, gh), top - 0.008], [0, top + 0.012],
    ];
    // full ring: right side up, then the left side down (17 points, first = last)
    const out = [];
    for (let k = 0; k < 9; k++) out.push(pts[k]);
    for (let k = 7; k >= 0; k--) out.push([-pts[k][0], pts[k][1]]);
    return { pts: out, gh };
  };
  const rings = X.map((x) => ({ x, ...ring(x) }));
  const NR = 17, nS = rings.length;
  const P = (i, k) => { const r = rings[i]; const p = r.pts[k]; return V(p[0], p[1], r.x - L / 2); };
  // smooth normals from the grid (around the ring and along the body)
  const N = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < nS; i++) {
    const row = [];
    let cy = 0;
    for (let k = 0; k < NR; k++) cy += rings[i].pts[k][1];
    cy /= NR;
    for (let k = 0; k < NR; k++) {
      const kp = k === NR - 1 ? 1 : k + 1, km = k === 0 ? NR - 2 : k - 1;
      a.subVectors(P(i, kp), P(i, km));
      b.subVectors(P(Math.min(nS - 1, i + 1), k), P(Math.max(0, i - 1), k));
      c.crossVectors(a, b).normalize();
      const p = P(i, k);
      if (c.x * p.x + c.y * (p.y - cy) < 0) c.negate();
      row.push(c.clone());
    }
    N.push(row);
  }
  const seg = (k) => (k < 8 ? k : 15 - k);
  const inR = (x, r) => x > r[0] && x < r[1];
  const sideGlass = (x, gh) => gh > 0.5 && inR(x, M.side) && !M.pillars.some((r) => inR(x, r));
  const matOf = (k, x, gh) => {
    const s = seg(k);
    if (s === 0) return TRIM;
    if (s === 1) return x < 0.2 || x > L - 0.2 ? TRIM : PAINT;
    if (s === 4) return sideGlass(x, gh) ? TRIM : PAINT;
    if (s === 5) return sideGlass(x, gh) ? GLASS : PAINT;
    if (s === 7) return inR(x, M.windscreen) || inR(x, M.rear) ? GLASS : PAINT;
    return PAINT;
  };
  const bufs = [0, 1, 2].map(() => ({ pos: [], nor: [], uv: [], idx: [] }));
  const vert = (bf, p, n, u, v) => { bf.pos.push(p.x, p.y, p.z); bf.nor.push(n.x, n.y, n.z); bf.uv.push(u, v); return bf.pos.length / 3 - 1; };
  for (let i = 0; i < nS - 1; i++) {
    const xm = (rings[i].x + rings[i + 1].x) / 2, gh = (rings[i].gh + rings[i + 1].gh) / 2;
    let u = 0;
    for (let k = 0; k < NR - 1; k++) {
      const p00 = P(i, k), p01 = P(i, k + 1), p10 = P(i + 1, k), p11 = P(i + 1, k + 1);
      const du = p00.distanceTo(p01);
      const bf = bufs[matOf(k, xm, gh)];
      const v0 = rings[i].x, v1 = rings[i + 1].x;
      const A = vert(bf, p00, N[i][k], u, v0), Bv = vert(bf, p01, N[i][k + 1], u + du, v0);
      const C = vert(bf, p10, N[i + 1][k], u, v1), D = vert(bf, p11, N[i + 1][k + 1], u + du, v1);
      bf.idx.push(A, Bv, C, Bv, D, C);
      u += du;
    }
  }
  // end caps (flat, painted)
  for (const [i, sg] of [[0, -1], [nS - 1, 1]]) {
    const bf = bufs[PAINT], n = V(0, 0, sg);
    let cy = 0;
    for (let k = 0; k < NR - 1; k++) cy += rings[i].pts[k][1];
    cy /= NR - 1;
    const z = rings[i].x - L / 2;
    const c0 = vert(bf, V(0, cy, z), n, 0, cy);
    const ids = [];
    for (let k = 0; k < NR - 1; k++) { const p = P(i, k); ids.push(vert(bf, p, n, p.x, p.y)); }
    for (let k = 0; k < NR - 1; k++) {
      const k1 = (k + 1) % (NR - 1);
      if (sg > 0) bf.idx.push(c0, ids[k], ids[k1]); else bf.idx.push(c0, ids[k1], ids[k]);
    }
  }
  const g = (bf) => (bf.idx.length ? makeGeo(bf.pos, bf.nor, bf.uv, bf.idx) : null);
  return { paint: g(bufs[PAINT]), glass: g(bufs[GLASS]), trim: g(bufs[TRIM]), T, B, W, Bo };
}

// ------------------------------------------------------------------ wheels
/** Tyre (rubber), rim (alloy) and the dark brake disc / hub behind the spokes, axle along
 *  +X, outer face at +X. */
function wheel(r, w, detail) {
  const seg = detail ? 14 : 28;
  const rr = r * 0.62;  // rim radius
  const tyre = lathe([[rr, -w / 2], [r - 0.03, -w / 2], [r - 0.006, -w / 2 + 0.03], [r, -w / 2 + 0.06], [r, w / 2 - 0.06], [r - 0.006, w / 2 - 0.03], [r - 0.03, w / 2], [rr, w / 2]], seg, { crease: 1.2 });
  xf(tyre, [0, 0, 0], [0, 0, -Math.PI / 2]);
  const rimP = [[rr, w / 2 - 0.004], [rr - 0.02, w / 2 - 0.01], [rr * 0.62, w / 2 - 0.035], [rr * 0.25, w / 2 - 0.02], [0.03, w / 2 - 0.012], [0, w / 2 - 0.01]];
  const rim = [xf(lathe(rimP, seg, { crease: 0.9 }), [0, 0, 0], [0, 0, -Math.PI / 2])];
  const dark = [];
  if (!detail) {
    // five spokes (proud of the dished face) and the dark openings between them
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const sp = rbox(0.012, rr * 0.78, 0.055, 0.006);
      xf(sp, [0, rr * 0.5, 0]);
      xf(sp, [w / 2 - 0.022, 0, 0], [a, 0, 0]);
      rim.push(sp);
    }
    const disc = xf(lathe([[0, -0.01], [rr * 0.9, -0.01], [rr * 0.9, 0.01], [0, 0.01]], 20), [0, 0, 0], [0, 0, -Math.PI / 2]);
    xf(disc, [w / 2 - 0.06, 0, 0]);
    dark.push(disc);
  } else {
    dark.push(xf(lathe([[rr * 0.92, w / 2 - 0.05], [rr * 0.92, w / 2 - 0.03]], seg), [0, 0, 0], [0, 0, -Math.PI / 2]));
  }
  return { tyre, rim: merge(rim), dark: merge(dark) };
}

// ------------------------------------------------------------------ vehicle prototype parts
function lampBox(w, h, d, col) {
  const g = rbox(w, h, d, Math.min(w, h, d) * 0.3, 2);
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(col, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

const C_HEAD = [0.3, 0.32, 0.35], C_TAIL = [0.42, 0.02, 0.015], C_AMBER = [0.75, 0.32, 0.02], C_PLATE = [0.82, 0.6, 0.04], C_SIGN = [0.88, 0.86, 0.8];

/** All parts of one car-like model at one detail level. */
function carParts(key, detail, taxi = false) {
  const M = MODELS[key];
  const body = loftBody(M, detail ? 0.26 : 0.1);
  const L = M.L, z = (x) => x - L / 2;
  const paint = [body.paint], glass = [body.glass], trim = [body.trim], alloy = [], rubber = [], lamp = [], dark = [];
  // wheels and wheel-house liners
  const wh = wheel(M.wheelR, M.tyreW, detail);
  for (const ax of M.axles) {
    const hw = body.W(ax);
    for (const sx of [-1, 1]) {
      const cx = sx * (hw - M.tyreW / 2 - 0.03);
      const flip = sx > 0 ? [0, 0, 0] : [0, Math.PI, 0];
      rubber.push(xf(wh.tyre.clone(), [cx, M.wheelR, z(ax)], flip));
      alloy.push(xf(wh.rim.clone(), [cx, M.wheelR, z(ax)], flip));
      dark.push(xf(wh.dark.clone(), [cx, M.wheelR, z(ax)], flip));
      // wheel-house liner: hides the view across under the car
      trim.push(xf(rbox(0.02, M.archR + 0.12, M.archR * 2, 0), [sx * (hw - M.tyreW - 0.08), M.wheelR + 0.06 + (M.archR - 0.12) / 2, z(ax)]));
    }
  }
  const lp = M.lamps;
  // front: headlamps under the bonnet edge, grille between them, indicators, lower intake
  // or a black bumper, plate (all a few millimetres proud of the nose)
  {
    const xF = L - 0.04, yH = lp.head[0], hw = body.W(xF), zF = z(L);
    for (const sx of [-1, 1]) {
      lamp.push(xf(lampBox(lp.head[2], lp.head[3], 0.16, C_HEAD), [sx * (hw - lp.head[1]), yH, zF - 0.075], [-0.2, sx * 0.12, 0]));
      if (!detail) lamp.push(xf(lampBox(0.06, 0.035, 0.12, C_AMBER), [sx * (hw - 0.06), yH - 0.03, zF - 0.09], [-0.2, sx * 0.5, 0]));
    }
    const gw = (hw - lp.head[1] - lp.head[2] / 2) * 2 + 0.02;
    trim.push(xf(rbox(gw, lp.grille[1], 0.12, 0.02), [0, lp.grille[0], zF - 0.055]));
    if (lp.bumper) {
      trim.push(xf(rbox(body.W(L - 0.06) * 2 + 0.02, lp.bumper[1], 0.16, 0.04), [0, lp.bumper[0], zF - 0.07]));
      trim.push(xf(rbox(body.W(0.06) * 2 + 0.02, lp.bumper[1], 0.14, 0.04), [0, lp.bumper[0] - 0.04, z(0) + 0.06]));
    } else trim.push(xf(rbox(body.W(L - 0.02) * 1.4, 0.12, 0.1, 0.02), [0, M.wheelR + 0.09, zF - 0.045]));   // lower intake
    if (!detail) lamp.push(xf(lampBox(0.52, 0.115, 0.012, C_PLATE), [0, lp.plateF, zF + 0.012 + (lp.bumper ? 0.01 : 0)]));
  }
  // rear: tail lamps on the corners, bumper lip, plate
  {
    const xR = 0.04, hw = body.W(xR);
    for (const sx of [-1, 1]) {
      lamp.push(xf(lampBox(lp.tail[2], lp.tail[3], 0.1, C_TAIL), [sx * (hw - lp.tail[1] * 0.5 - lp.tail[2] / 2 + 0.03), lp.tail[0], z(0) + 0.045], [0, sx * 0.2, 0]));
      // the lamp wraps round the corner onto the flank
      if (key !== 'van') lamp.push(xf(lampBox(0.05, lp.tail[3] * 0.8, 0.16, C_TAIL), [sx * (body.W(0.12) - 0.018), lp.tail[0], z(0.12)]));
    }
    if (!detail) lamp.push(xf(lampBox(0.52, 0.115, 0.012, C_PLATE), [0, lp.plateR, z(0) - 0.012]));
    if (!lp.bumper) trim.push(xf(rbox(body.W(0.05) * 1.7, 0.1, 0.06, 0.02), [0, body.Bo(0.05) + 0.06, z(0) + 0.02]));
  }
  if (key === 'van') {
    // black rubbing strips along the sides between the wheel arches
    for (const sx of [-1, 1]) {
      const a0 = M.axles[0] + M.archR + 0.04, a1 = M.axles[1] - M.archR - 0.04;
      trim.push(xf(rbox(0.03, 0.16, a1 - a0, 0.01), [sx * (body.W((a0 + a1) / 2) - 0.005), 0.62, z((a0 + a1) / 2)]));
    }
  }
  if (!detail) {
    // door mirrors at the front of the side glazing (black on the van), door handles
    const xm = M.side[1] - 0.12, hw = body.W(xm), yb = body.B(xm);
    for (const sx of [-1, 1]) {
      const mir = xf(rbox(key === 'van' ? 0.2 : 0.18, key === 'van' ? 0.24 : 0.11, 0.09, 0.03), [sx * (hw + 0.08), yb + (key === 'van' ? 0.16 : 0.08), z(xm)], [0, sx * 0.15, 0]);
      (key === 'van' ? trim : paint).push(mir);
      trim.push(xf(rbox(0.07, 0.04, 0.05, 0.01), [sx * (hw + 0.01), yb + 0.05, z(xm)]));
      const handles = key === 'van' ? [3.75, 3.2] : key === 'hatch' ? [1.65, 2.6] : [2.3, 3.2];
      for (const xh of handles) alloy.push(xf(rbox(0.016, 0.025, 0.13, 0.008), [sx * (body.W(xh) + 0.003), body.B(xh) - 0.06, z(xh)]));
    }
  }
  // van: the seam between the two rear doors
  if (key === 'van') trim.push(xf(rbox(0.012, 1.75, 0.006, 0), [0, 1.3, z(0) - 0.002]));
  if (taxi) {
    // roof sign on its base, at the middle of the roof
    const xs = (M.side[0] + M.side[1]) / 2, top = body.T(xs);
    lamp.push(xf(lampBox(0.62, 0.16, 0.24, C_SIGN), [0, top + 0.1, z(xs)]));
    trim.push(xf(rbox(0.5, 0.03, 0.2, 0.01), [0, top + 0.02, z(xs)]));
  }
  return { paint: merge(paint), glass: merge(glass), trim: merge(trim), alloy: merge(alloy), rubber: merge(rubber), lamp: merge(lamp), dark: merge(dark), L, W: body.W(L / 2) };
}

/** Motor scooter on its side stand (leaning ~6 degrees to its left), front = +Z. */
function scooterParts(detail) {
  const seg = detail ? 10 : 20;
  const paint = [], trim = [], alloy = [], rubber = [], lamp = [], dark = [];
  const R = 0.2, w = 0.1;
  for (const zz of [-0.62, 0.66]) {
    const t = lathe([[R - 0.07, -w / 2], [R - 0.01, -w / 2], [R, -w / 2 + 0.03], [R, w / 2 - 0.03], [R - 0.01, w / 2], [R - 0.07, w / 2]], seg, { crease: 1.2 });
    rubber.push(xf(t, [0, R, zz], [0, 0, -Math.PI / 2]));
    alloy.push(xf(lathe([[0, w / 2 - 0.02], [R - 0.07, w / 2 - 0.01], [R - 0.07, -w / 2 + 0.01], [0, -w / 2 + 0.02]], seg), [0, R, zz], [0, 0, -Math.PI / 2]));
  }
  // rear body (engine cowl) as a squashed ellipsoid, floorboard, leg shield, front fender
  const cowl = new THREE.SphereGeometry(0.5, seg, detail ? 6 : 12);
  xf(cowl, [0, 0.56, -0.42], [0, 0, 0], [0.36, 0.38, 0.95]);
  paint.push(cowl);
  trim.push(xf(rbox(0.3, 0.05, 0.62, 0.02), [0, 0.3, 0.1]));
  paint.push(xf(rbox(0.42, 0.62, 0.06, 0.05, 3), [0, 0.62, 0.42], [-0.22, 0, 0]));
  paint.push(xf(rbox(0.16, 0.08, 0.36, 0.04), [0, 0.42, 0.66], [0.1, 0, 0]));
  // steering column, handlebar with its headlamp housing, mirrors
  paint.push(xf(rbox(0.12, 0.42, 0.1, 0.03), [0, 0.92, 0.48], [-0.25, 0, 0]));
  paint.push(xf(rbox(0.56, 0.08, 0.12, 0.03), [0, 1.13, 0.44]));
  lamp.push(xf(lampBox(0.14, 0.09, 0.04, C_HEAD), [0, 1.11, 0.51]));
  if (!detail) for (const sx of [-1, 1]) alloy.push(xf(rbox(0.012, 0.18, 0.012, 0.004), [sx * 0.24, 1.24, 0.42], [0, 0, sx * 0.2]));
  // seat, tail lamp, plate
  trim.push(xf(rbox(0.3, 0.1, 0.7, 0.05, 3), [0, 0.84, -0.36]));
  lamp.push(xf(lampBox(0.14, 0.05, 0.04, C_TAIL), [0, 0.68, -0.88]));
  if (!detail) lamp.push(xf(lampBox(0.16, 0.12, 0.01, C_PLATE), [0, 0.5, -0.93]));
  dark.push(xf(rbox(0.1, 0.1, 0.32, 0.02), [0.12, 0.3, -0.5]));   // exhaust / engine
  const lean = (g) => (g ? xf(g, [0, 0, 0], [0, 0, 0.1]) : g);
  const out = { paint: merge(paint), trim: merge(trim), alloy: merge(alloy), rubber: merge(rubber), lamp: merge(lamp), dark: merge(dark), L: 1.85, W: 0.35 };
  for (const k of ['paint', 'trim', 'alloy', 'rubber', 'lamp', 'dark']) lean(out[k]);
  return out;
}

/** Contact shadow decal (a quad slightly above the road), sized to the footprint. */
function aoDecal(L, W) {
  const g = new THREE.PlaneGeometry(W + 0.32, L + 0.4);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.012, 0);
  return g;
}

/** Radial-ish contact shadow texture (rounded rectangle falloff). */
export function contactShadowTexture() {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = Math.abs((x + 0.5) / S - 0.5) * 2, v = Math.abs((y + 0.5) / S - 0.5) * 2;
    // distance outside an inner rounded box (0 inside, 1 at the edge)
    const du = Math.max(0, (u - 0.62) / 0.38), dv = Math.max(0, (v - 0.74) / 0.26);
    const d = Math.min(1, Math.hypot(du, dv));
    const a = Math.pow(1 - d, 1.6) * (0.55 + 0.45 * (1 - Math.max(u, v) ** 4));
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(255 * Math.min(1, a));
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/**
 * Prototypes: one per model and paint finish ({solid | metal}), at two detail levels
 * (switch at LOD_M metres).
 */
const LOD_M = [45];
export function buildVehicleProtos(F) {
  const P = {};
  const kinds = { hatch: () => [carParts('hatch', 0), carParts('hatch', 1)], saloon: () => [carParts('saloon', 0), carParts('saloon', 1)],
    taxi: () => [carParts('saloon', 0, true), carParts('saloon', 1, true)], van: () => [carParts('van', 0), carParts('van', 1)],
    scooter: () => [scooterParts(0), scooterParts(1)] };
  for (const [k, mk] of Object.entries(kinds)) {
    const lv = mk();
    const ao = aoDecal(lv[0].L, lv[0].W * 2);
    ao.userData.shared = true;
    for (const [fin, paintMat] of [['solid', F.carPaint], ['metal', F.carMetal]]) {
      const part = (geos, mat, extra = {}) => (geos.some(Boolean) ? { geo: geos, mat, ...extra } : null);
      P[`${k}_${fin}`] = proto(`vehicle_${k}_${fin}`, [
        part(lv.map((x) => x.paint), paintMat, { tint: true }),
        part(lv.map((x) => x.glass || null), F.carGlass),
        part(lv.map((x) => x.trim || null), F.carTrim),
        part(lv.map((x) => x.alloy || null), F.carAlloy),
        part(lv.map((x) => x.rubber || null), F.rubber),
        part(lv.map((x) => x.lamp || null), F.carLamp, { cast: false }),
        part(lv.map((x) => x.dark || null), F.carTrim, { cast: false }),
        part([ao, ao], F.contactShadow, { cast: false }),
      ], LOD_M);
      P[`${k}_${fin}`].dims = { L: lv[0].L, W: lv[0].W * 2 };
    }
  }
  return P;
}

// paint colours (linear albedo) and finishes
const COLOURS = [
  [[0.78, 0.78, 0.76], 'solid', 0.3],      // white
  [[0.42, 0.43, 0.44], 'metal', 0.22],     // silver
  [[0.16, 0.165, 0.17], 'metal', 0.12],    // graphite
  [[0.025, 0.025, 0.028], 'solid', 0.1],   // black
  [[0.04, 0.07, 0.16], 'metal', 0.08],     // dark blue
  [[0.36, 0.04, 0.03], 'solid', 0.06],     // red
  [[0.5, 0.44, 0.34], 'metal', 0.06],      // champagne
  [[0.1, 0.17, 0.12], 'metal', 0.04],      // dark green
];
const TAXI = [[0.8, 0.5, 0.03], 'solid'];   // yellow

const _m = new THREE.Matrix4(), _c = new THREE.Color(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _y = new THREE.Vector3(0, 1, 0);
const _plans = new Map();

/** Geometry of the side street of cross street c on `side` (as the street module builds it). */
function mouthFrame(route, layout, c, side) {
  const hw = layout.halfWidth(c.s, side);
  const smp = route.sample(c.s, {});
  const start = route.toWorld(c.s, side * hw, 0);
  const out = smp.right.clone().multiplyScalar(side);
  const ca = Math.cos(c.angle || 0), sa = Math.sin(c.angle || 0);
  const dirOut = new THREE.Vector3(out.x * ca + out.z * sa, 0, -out.x * sa + out.z * ca).normalize();
  const w = c.width, sw = Math.min(2.6, Math.max(1.6, w * 0.2));
  return { start, along: smp.tanH.clone().setY(0).normalize(), dirOut, road: w / 2 - sw, len: c.depth + 46 };
}

/** Parked vehicles of one cross-street mouth: [{proto key, a (across), x (out), yaw, colour}]. */
export function planMouth(layout, c, side) {
  const key = `${Math.round(c.s * 10)}:${side}`;
  let plan = _plans.get(key);
  if (plan) return plan;
  plan = [];
  const rng = RNG.from(layout.seed, 'vehicles', Math.round(c.s * 10), side);
  const w = c.width, sw = Math.min(2.6, Math.max(1.6, w * 0.2)), road = w / 2 - sw;
  const n = rng.weighted([[1, 0.3], [2, 0.4], [3, 0.3]]) + (c.junction ? 1 : 0);
  const xMax = Math.min(60, c.depth + 8);
  const taken = { '-1': [], '1': [] };
  for (let i = 0, tries = 0; i < n && tries < 30; tries++) {
    const kind = rng.weighted([['hatch', 0.36], ['saloon', 0.24], ['taxi', 0.07], ['van', 0.2], ['scooter', 0.13]]);
    const kerb = rng.chance(0.5) ? 1 : -1;
    const len = { hatch: 4.05, saloon: 4.72, taxi: 4.72, van: 5.0, scooter: 1.85 }[kind];
    const x = rng.range(15 + len / 2, xMax - len / 2);
    if (taken[kerb].some((o) => Math.abs(o.x - x) < (o.len + len) / 2 + rng.range(0.7, 1.6))) continue;
    taken[kerb].push({ x, len });
    const half = kind === 'scooter' ? 0.4 : kind === 'van' ? 0.99 : 0.9;
    // cars stand 0.2-0.35 m off the kerb; scooters on the sidewalk edge, nose to the kerb
    const a = kind === 'scooter' ? kerb * (road + 0.75) : kerb * (road - half - rng.range(0.2, 0.35));
    const facesOut = rng.chance(0.5);
    const yaw = kind === 'scooter' ? (kerb > 0 ? -1 : 1) * Math.PI / 2 + rng.range(-0.25, 0.25) : (facesOut ? 0 : Math.PI) + rng.range(-0.02, 0.02);
    let col, fin;
    if (kind === 'taxi') [col, fin] = rng.chance(0.6) ? TAXI : [[0.78, 0.78, 0.76], 'solid'];
    else if (kind === 'van') [col, fin] = rng.chance(0.7) ? [[0.8, 0.8, 0.78], 'solid'] : rng.chance(0.5) ? [[0.42, 0.43, 0.44], 'metal'] : [[0.03, 0.05, 0.12], 'metal'];
    else { const e = rng.weighted(COLOURS.map((c2) => [c2, c2[2]])); col = e[0]; fin = e[1]; }
    const v = rng.range(0.92, 1.05);
    plan.push({ key: `${kind}_${fin}`, a, x, yaw, col: [col[0] * v, col[1] * v, col[2] * v], scooter: kind === 'scooter' });
    i++;
  }
  _plans.set(key, plan);
  return plan;
}

/** Add the parked vehicles of the cross streets anchored in this chunk. */
export function placeVehicles(chunk, app, inst, P) {
  const { route, layout } = app;
  for (const c of layout.inChunk('crossStreets', chunk.index)) {
    for (const side of c.side === 0 ? [-1, 1] : [c.side]) {
      const f = mouthFrame(route, layout, c, side);
      for (const v of planMouth(layout, c, side)) {
        // road level beyond the ramp: the junction's level, kerb drop and camber
        // (crossStreets.js in the street module); scooters stand on the sidewalk
        const camber = 0.022 * (1 - Math.min(1, (v.a / f.road) ** 2));
        const y = f.start.y + (v.scooter ? 0 : -0.12 + camber);
        _p.copy(f.start).addScaledVector(f.along, v.a).addScaledVector(f.dirOut, v.x);
        _p.y = y;
        // local +Z (front) along dirOut turned by yaw
        const base = Math.atan2(f.dirOut.x, f.dirOut.z);
        _q.setFromAxisAngle(_y, base + v.yaw);
        _m.compose(_p, _q, new THREE.Vector3(1, 1, 1));
        inst.add(P[v.key], _m, _c.setRGB(v.col[0], v.col[1], v.col[2]));
      }
    }
  }
}

