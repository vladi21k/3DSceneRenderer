import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { lathe, tube, bar, rbox, xf, merge, makeGeo, quad } from './kit.js';
import { proto, placeMatrix, segmentMatrix } from './instancer.js';
import { uvRect, displayUV } from './prints.js';

// Tram stops: raised side platforms (cut limestone coping blocks on a mortar bed, tactile
// warning strip with a contrasting band, ramps at both ends, back kerb and railing) built
// per station from layout.stations, plus the fittings from layout.furniture: glazed
// shelters, ticket machines and stop poles with a pictogram sign and passenger display.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const RAMP = 2.5;        // ramp length at each end (inside the platform extent)
const COPING = 0.35;     // stone edge width
const TACTILE = [0.35, 0.75];
const BAND = 0.12;       // contrasting band behind the tactile strip (dark granite, flat part only)
const JOINT = 0.004;     // coping block joints

// ------------------------------------------------------------------ platform body
/** Strip of an open cross-section profile [[x, h]...] (x from the track edge) along sList.
 *  Heights scale with k(s) so the ramps fold the whole section down to the paving.
 *  opts: uvMode 'd' (u = s, v = d) or profile length; u0 offset; col(x, h) vertex colour. */
function sectionStrip(route, sList, dE, sgn, prof, k, { uvMode = null, u0 = 0, col = null } = {}) {
  const pos = [], uv = [], idx = [], cols = [];
  const p = new THREE.Vector3();
  const np = prof.length;
  for (const s of sList) {
    const kk = k(s);
    let acc = 0;
    prof.forEach(([x, h], j) => {
      if (j) acc += Math.hypot(x - prof[j - 1][0], h - prof[j - 1][1]);
      const d = dE + sgn * x;
      route.toWorld(s, d, h * kk, p);
      pos.push(p.x, p.y, p.z);
      uv.push(s + u0, uvMode === 'd' ? d : acc);
      if (col) cols.push(...col(x, h));
    });
  }
  for (let i = 0; i < sList.length - 1; i++) for (let j = 0; j < np - 1; j++) {
    const a = i * np + j, b = a + 1, c = a + np, d = c + 1;
    // profiles are listed counter-clockwise for the right side; mirrored on the left
    if (sgn > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx, col ? { color: { array: cols, size: 3 } } : null);
  g.computeVertexNormals();
  return g;
}

/** End cap of a profile closed through `close` (fan), facing -tangent (dir -1) or +tangent. */
function sectionCap(route, s, dE, sgn, prof, kk, close, dir, colv) {
  const pts = [...prof, close], pos = [], cols = [], uv = [], idx = [];
  const p = new THREE.Vector3();
  for (const [x, h] of pts) {
    route.toWorld(s, dE + sgn * x, h * kk, p);
    pos.push(p.x, p.y, p.z); uv.push(x, h); cols.push(...colv);
  }
  const n = pts.length - 1;
  for (let i = 0; i < n - 1; i++) {
    if ((dir > 0) === (sgn > 0)) idx.push(n, i, i + 1); else idx.push(n, i + 1, i);
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx, { color: { array: cols, size: 3 } });
  g.computeVertexNormals();
  return g;
}

function sRange(a, b, step) {
  const n = Math.max(1, Math.ceil((b - a) / step)), out = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

const bodyCache = new Map();

/** Cut-stone blocks (0.8-1.2 m) along a profile, each with its own tint and texture offset,
 *  4 mm joints, grime at the foot. Returns geometries. */
function stoneBlocks(route, pl, dE, sgn, prof, close, k, lod, seed, grime) {
  const rng = RNG.from(seed);
  const s0 = pl.s0, s1 = pl.s1, out = [];
  const kS = route.offsetScale((s0 + s1) / 2, dE);
  let a = s0;
  while (a < s1 - 0.05) {
    let L = rng.range(0.8, 1.2) / kS;
    if (s1 - (a + L) < 0.5 / kS) L = s1 - a;                 // no sliver at the end
    const b = Math.min(s1, a + L);
    const inRamp = a < s0 + RAMP || b > s1 - RAMP;
    const list = sRange(a, b - (b < s1 ? JOINT / kS : 0), inRamp && !lod ? 0.25 : 2);
    const v = rng.range(0.96, 1.04), h = rng.range(-0.02, 0.02);
    // cooler, paler stone than the facades (desaturated towards #cfc4ae), dirt at the foot
    const base = [0.97 * v * (1 + h), 0.97 * v, 1.0 * v * (1 - h)];
    const col = (x, hh) => { const f = grime(x, hh); return [base[0] * f, base[1] * f, base[2] * f]; };
    out.push(sectionStrip(route, list, dE, sgn, prof, k, { u0: rng.range(0, 20), col }));
    if (!lod) {
      if (a > s0 + 1e-6) out.push(sectionCap(route, list[0], dE, sgn, prof, k(list[0]), close, -1, base));
      if (b < s1 - 1e-6) out.push(sectionCap(route, list[list.length - 1], dE, sgn, prof, k(list[list.length - 1]), close, 1, base));
    }
    a = b;
  }
  return out;
}

/** Platform body geometry per material (cached per platform and LOD, shared). */
function platformBody(pl, app, F, lod) {
  const key = `${pl.s0.toFixed(2)}|${pl.side}|${lod}`;
  let out = bodyCache.get(key);
  if (out) return out;
  const { route } = app;
  const sgn = pl.side, dE = sgn > 0 ? pl.d0 : pl.d1, W = pl.d1 - pl.d0, top = pl.h;
  const s0 = pl.s0, s1 = pl.s1;
  const k = (s) => Math.max(0, Math.min(1, (s - s0) / RAMP, (s1 - s) / RAMP));
  const flat = sRange(s0 + RAMP, s1 - RAMP, lod ? 8 : 2);
  const rampA = sRange(s0, s0 + RAMP, lod ? RAMP : 0.5), rampB = sRange(s1 - RAMP, s1, lod ? RAMP : 0.5);
  const all = [...rampA, ...flat.slice(1, -1), ...rampB];
  const xb = W;
  const strip = (list, prof, opts) => sectionStrip(route, list, dE, sgn, prof, k, opts);
  const coping = [[COPING, top], [0.03, top], [0.012, top - 0.004], [0.003, top - 0.013], [0, top - 0.03], [0, 0]];
  const kerb = [[xb, 0], [xb, top - 0.02], [xb - 0.02, top], [xb - 0.26, top]];
  // tyre and shoe grime at the foot of the track face, scuffs along the nose
  const copingGrime = (x, h) => (x < 0.001 ? 0.72 + 0.28 * THREE.MathUtils.smoothstep(h, 0.0, 0.12) : x < 0.04 ? 0.94 : 1);
  const kerbGrime = (x, h) => (h < top - 0.03 ? 0.8 + 0.2 * THREE.MathUtils.smoothstep(h, 0, 0.15) : 1);
  const seed = `${pl.s0.toFixed(1)}|${pl.side}`;
  const stone = [
    ...stoneBlocks(route, pl, dE, sgn, coping, [COPING, 0], k, lod, `coping|${seed}`, copingGrime),
    ...stoneBlocks(route, pl, dE, sgn, kerb, [xb - 0.26, 0], k, lod, `kerb|${seed}`, kerbGrime),
  ];
  // dark mortar bed behind the coping joints
  const mortar = [[COPING - 0.01, top - 0.006], [0.006, top - 0.006], [0.006, 0]];
  const tactile = [[TACTILE[1], top], [TACTILE[0], top]];
  out = [
    [F.copingStone, merge(stone)],
    [F.mortar, merge([strip(all, mortar)])],
    [F.bandStone, merge([strip(flat, [[TACTILE[1] + BAND, top], [TACTILE[1], top]], { uvMode: 'd' })])],
    // walking surface; tactile warning strip and band along the flat part, plain paving on the ramps
    [F.platformPaving, merge([
      strip(all, [[xb - 0.26, top], [TACTILE[1] + BAND, top]], { uvMode: 'd' }),
      strip(rampA, [[TACTILE[1] + BAND, top], [TACTILE[0], top]], { uvMode: 'd' }),
      strip(rampB, [[TACTILE[1] + BAND, top], [TACTILE[0], top]], { uvMode: 'd' }),
    ])],
    [F.tactile, merge([strip(flat, tactile, { uvMode: 'd' })])],
  ];
  bodyCache.set(key, out);
  return out;
}

/** [material, geometry] pairs of a platform body (the per-site meshes, see buildPlatform):
 *  their programs are compiled up front from these (stations are often first streamed
 *  far beyond the start-up range). */
export function platformWarmupParts(app, F) {
  const st = app.layout.stations[0], pl = st && st.platforms[0];
  return pl ? platformBody(pl, app, F, 0) : [];
}

/** One side platform: cached body meshes plus instanced railing (open at the access gaps
 *  and behind the shelter). */
export function buildPlatform(pl, app, addMesh, F, lod, fittings, inst, PP) {
  for (const [mat, geo] of platformBody(pl, app, F, lod)) addMesh(geo, mat);
  const { route } = app;
  const sgn = pl.side, dE = sgn > 0 ? pl.d0 : pl.d1, W = pl.d1 - pl.d0, top = pl.h;
  const s0 = pl.s0, s1 = pl.s1;
  for (const s of [s0 + RAMP + 1.2, s1 - RAMP - 1.2]) inst.add(PP.lightColumn, placeMatrix(route, s, dE + sgn * (W - 0.25), top, sgn > 0 ? -Math.PI / 2 : Math.PI / 2, _m, 0.15));
  const xr = W - 0.09;
  const gaps = [[0.27, 0.33], [0.67, 0.73]].map(([a, b]) => [s0 + (s1 - s0) * a, s0 + (s1 - s0) * b]);
  for (const f of fittings) if (f.type === 'shelter') gaps.push([f.s - 2.75, f.s + 2.75]);
  const runs = [];
  let cur = [];
  for (let s = s0 + RAMP + 0.4; s <= s1 - RAMP - 0.4 + 1e-6; s += 0.5) {
    if (gaps.some(([a, b]) => s > a && s < b)) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push(s);
  }
  if (cur.length > 1) runs.push(cur);
  const P = (s, h) => route.toWorld(s, dE + sgn * xr, h, new THREE.Vector3());
  for (const run of runs) {
    const a = run[0], b = run[run.length - 1];
    const nPost = Math.max(1, Math.round((b - a) / 2.2));
    for (let i = 0; i <= nPost; i++) {
      const sa = a + ((b - a) * i) / nPost;
      inst.add(PP.post, placeMatrix(route, sa, dE + sgn * xr, top, 0, _m));
      if (i === nPost) break;
      const sb = a + ((b - a) * (i + 1)) / nPost;
      inst.add(PP.rail, segmentMatrix(P(sa, top + 1.02), P(sb, top + 1.02), _m));
      inst.add(PP.railMid, segmentMatrix(P(sa, top + 0.55), P(sb, top + 0.55), _m));
    }
  }
}

// ------------------------------------------------------------------ shelter
/** Glass pane with green-tinted edges and point clamps. UVs: u = metres across, v = metres
 *  of height (the decal's safety dots sit at true heights). */
function pane(w, h, t, cx, cy, cz, rotY, glass, edges, clamps, vOff = 0) {
  const g = rbox(w, h, t, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) + cy + vOff);
  glass.push(xf(g, [cx, cy, cz], [0, rotY, 0]));
  const e = 0.012;
  for (const [ew, eh, ex, ey] of [[w, e, 0, h / 2], [w, e, 0, -h / 2], [e, h, w / 2, 0], [e, h, -w / 2, 0]]) {
    edges.push(xf(xf(rbox(ew + 0.004, eh, t + 0.002, 0), [ex, ey, 0]), [cx, cy, cz], [0, rotY, 0]));
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    clamps.push(xf(xf(rbox(0.05, 0.05, t + 0.024, 0.006, 1), [sx * (w / 2 - 0.02), sy * (h / 2 - 0.12), 0]), [cx, cy, cz], [0, rotY, 0]));
  }
}

function shelter() {
  const frame = [], glass = [], edges = [], lit = [], print = [], disp = [], light = [], wood = [];
  const B = (w, h, d, x, y, z, r = 0.006, rx = 0) => xf(rbox(w, h, d, r), [x, y, z], [rx, 0, 0]);
  const zb = -0.62;                 // back wall plane
  const zB = -0.68, yB = 2.44, zF = 0.78, yF = 2.57, k = (yF - yB) / (zF - zB); // beam line
  const roofY = (z) => yB + (z - zB) * k + 0.035;
  for (const x of [-2.35, 0, 2.35]) {
    frame.push(B(0.12, 2.5, 0.08, x, 1.25, zb));
    frame.push(xf(lathe([[0.1, 0], [0.1, 0.012], [0.075, 0.02], [0, 0.02]], 4, { phi0: Math.PI / 4 }), [x, 0, zb]));
    frame.push(bar([V(x, yB, zB), V(x, yF, zF)], 0.13, 0.06, { up: [0, 1, 0], r: 0.006, bend: 0, scales: (t) => 1 - 0.45 * t }));
  }
  // roof glass on the beams, rising to the front fascia; drains to the back gutter
  const ang = -Math.atan(k);
  {
    const g = rbox(5.16, 0.012, 1.58, 0);
    const uv = g.attributes.uv, pos = g.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), 2.5 + (0.79 - pos.getZ(i)) * (1.5 / 1.58)); // decal roof region, drip line at the back
    glass.push(xf(g, [0, roofY(0.02) + 0.006, 0.02], [ang, 0, 0]));
  }
  frame.push(B(5.24, 0.17, 0.07, 0, 2.62, 0.8, 0.008));                 // front fascia
  frame.push(B(5.24, 0.09, 0.08, 0, 2.47, -0.76, 0.006));               // back gutter
  for (const sx of [-1, 1]) frame.push(xf(rbox(0.05, 0.06, 1.6, 0.006), [sx * 2.6, roofY(0.02), 0.02], [ang, 0, 0]));
  light.push(B(4.7, 0.012, 0.05, 0, 2.528, 0.74, 0));                  // LED strip under the fascia
  // glazed back wall (two panes) with rails and a lean bar
  const clamps = [];
  for (const [x0, x1] of [[-2.29, -0.06], [0.06, 2.29]]) pane(x1 - x0, 2.18, 0.01, (x0 + x1) / 2, 1.22, zb, 0, glass, edges, clamps);
  frame.push(B(4.7, 0.06, 0.05, 0, 0.1, zb, 0.004), B(4.7, 0.06, 0.05, 0, 2.33, zb, 0.004));
  frame.push(tube([V(-2.3, 1.02, zb + 0.09), V(2.3, 1.02, zb + 0.09)], 0.02, { radial: 8, bend: 0 }));
  for (const x of [-1.6, 0.5, 1.9]) frame.push(tube([V(x, 1.02, zb + 0.09), V(x, 1.02, zb + 0.005)], 0.012, { radial: 6, bend: 0 }));
  // glazed end screen
  pane(0.95, 2.18, 0.01, 2.4, 1.22, zb + 0.5, Math.PI / 2, glass, edges, clamps);
  frame.push(B(0.05, 0.06, 1.0, 2.4, 0.1, zb + 0.5, 0.004), B(0.05, 0.06, 1.0, 2.4, 2.33, zb + 0.5, 0.004), B(0.06, 2.3, 0.06, 2.4, 1.17, zb + 0.98, 0.006));
  frame.push(...clamps);
  // illuminated advertising case at the other end: posters behind 20 mm snap frames
  frame.push(B(0.17, 1.88, 1.28, -2.42, 1.1, zb + 0.6, 0.012));
  for (const sx of [-1, 1]) {
    const xf0 = -2.42 + sx * 0.088;
    lit.push(xf(quad(1.15, 1.72, uvRect(sx > 0 ? 'poster5' : 'poster2')), [xf0, 1.1, zb + 0.6], [0, sx * Math.PI / 2, 0]));
    const fx = -2.42 + sx * 0.092;
    for (const [w, h, y, z] of [[0.02, 1.76, 1.1, zb + 0.6 - 0.585], [0.02, 1.76, 1.1, zb + 0.6 + 0.585], [1.19, 0.02, 1.1 + 0.87, zb + 0.6], [1.19, 0.02, 1.1 - 0.87, zb + 0.6]]) {
      frame.push(xf(rbox(0.012, h, w, 0.003, 1), [fx, y, z]));
    }
  }
  // timber bench on cantilever brackets
  for (let i = 0; i < 3; i++) wood.push(B(2.6, 0.032, 0.085, 1.0, 0.465, zb + 0.14 + i * 0.1, 0.006));
  for (const x of [0.0, 2.0]) frame.push(B(0.05, 0.05, 0.38, x, 0.43, zb + 0.22, 0.005), B(0.05, 0.43, 0.05, x, 0.215, zb + 0.36, 0.005));
  // route map in a frame on the back wall (print 2.5 mm proud of the frame face)
  frame.push(B(0.76, 0.93, 0.02, -1.25, 1.5, zb + 0.002, 0.004));
  print.push(xf(quad(0.7, 0.875, uvRect('shelterInfo')), [-1.25, 1.5, zb + 0.0145]));
  // real-time display hung under the roof
  frame.push(B(1.0, 0.24, 0.1, 0.9, 2.26, 0.62, 0.012));
  for (const x of [0.6, 1.2]) frame.push(tube([V(x, 2.38, 0.62), V(x, roofY(0.62), 0.62)], 0.012, { radial: 6, bend: 0 }));
  for (const [sz, rot] of [[1, 0], [-1, Math.PI]]) disp.push(xf(quad(0.9, 0.2, displayUV('shelter')), [0.9, 2.26, 0.62 + sz * 0.053], [0, rot, 0]));
  return { frame: merge(frame), glass: merge(glass), edges: merge(edges), lit: merge(lit), print: merge(print), disp: merge(disp), light: merge(light), wood: merge(wood) };
}

/** Slim platform light column with a flat LED luminaire on a short outreach arm. */
function lightColumn() {
  const pole = [lathe([[0.075, 0], [0.075, 0.03], [0.05, 0.05], [0.045, 0.1], [0.04, 3.55], [0.045, 3.56], [0, 3.58]], 10)];
  pole.push(bar([V(0, 3.45, 0), V(0, 3.47, 0.42)], 0.05, 0.04, { up: [0, 1, 0], r: 0.006, bend: 0 }));
  pole.push(xf(rbox(0.22, 0.07, 0.56, 0.015), [0, 3.47, 0.6], [-0.06, 0, 0]));
  const lamp = xf(rbox(0.17, 0.008, 0.48, 0), [0, 3.432, 0.6], [-0.06, 0, 0]);
  return { pole: merge(pole), lamp: merge([lamp]) };
}

function ticketMachine() {
  const paint = [], print = [], disp = [], dark = [], conc = [];
  conc.push(xf(rbox(0.64, 0.08, 0.44, 0.01), [0, 0.04, 0]));
  paint.push(xf(rbox(0.56, 1.6, 0.36, 0.025, 2), [0, 0.88, 0]));
  paint.push(xf(rbox(0.64, 0.06, 0.5, 0.015, 2), [0, 1.71, 0.05]));
  print.push(xf(quad(0.5, 0.75, uvRect('ticketFront')), [0, 1.13, 0.183]));
  disp.push(xf(quad(0.38, 0.21, displayUV('screen')), [0, 1.259, 0.186]));
  dark.push(xf(rbox(0.3, 0.09, 0.05, 0.01), [0, 0.64, 0.17]));
  return { paint: merge(paint), print: merge(print), disp: merge(disp), dark: merge(dark), conc: merge(conc) };
}

function stopPole() {
  const pole = [lathe([[0.065, 0], [0.065, 0.06], [0.045, 0.085], [0.038, 0.1], [0.038, 3.02], [0.045, 3.03], [0.045, 3.06], [0, 3.07]], 12)];
  const print = [], disp = [];
  for (const sz of [1, -1]) {
    pole.push(xf(rbox(0.5, 0.5, 0.022, 0.01), [0, 2.72, sz * 0.05]));
    print.push(xf(quad(0.48, 0.48, uvRect('tramSign')), [0, 2.72, sz * 0.0635], [0, sz > 0 ? 0 : Math.PI, 0]));
    disp.push(xf(quad(0.7, 0.175, displayUV('stop')), [0, 2.28, sz * 0.048], [0, sz > 0 ? 0 : Math.PI, 0]));
  }
  pole.push(xf(rbox(0.76, 0.21, 0.09, 0.012), [0, 2.28, 0]));
  pole.push(xf(rbox(0.36, 0.52, 0.04, 0.008), [0, 1.45, 0.06]));
  print.push(xf(quad(0.32, 0.48, uvRect('timetable')), [0, 1.45, 0.083]));
  return { pole: merge(pole), print: merge(print), disp: merge(disp) };
}

export function buildPlatformProtos(M, F) {
  const P = {};
  const pole = F.pole;
  const sh = shelter();
  P.shelter = proto('shelter', [{ geo: sh.frame, mat: pole }, { geo: sh.glass, mat: F.shelterGlass, cast: false }, { geo: sh.edges, mat: F.glassEdge, cast: false },
    { geo: sh.lit, mat: F.printLit }, { geo: sh.print, mat: F.print }, { geo: sh.disp, mat: F.display }, { geo: sh.light, mat: F.light }, { geo: sh.wood, mat: F.timber }]);
  const lc = lightColumn();
  P.lightColumn = proto('lightColumn', [{ geo: lc.pole, mat: pole }, { geo: lc.lamp, mat: F.light }]);
  const tm = ticketMachine();
  P.ticket = proto('ticketMachine', [{ geo: tm.paint, mat: F.paint, tint: true }, { geo: tm.print, mat: F.print }, { geo: tm.disp, mat: F.display },
    { geo: tm.dark, mat: F.rubber }, { geo: tm.conc, mat: F.concrete }]);
  const unitTube = (r, radial) => merge([tube([V(0, 0, 0), V(0, 0, 1)], r, { radial, bend: 0, caps: false })]);
  P.rail = proto('rail', [{ geo: [unitTube(0.024, 8), unitTube(0.024, 4)], mat: pole }], [50]);
  P.railMid = proto('railMid', [{ geo: [unitTube(0.015, 8), unitTube(0.015, 4)], mat: pole }], [50]);
  P.post = proto('railPost', [{ geo: [merge([tube([V(0, -0.02, 0), V(0, 1.02, 0)], 0.022, { radial: 8, bend: 0 }), lathe([[0.055, 0], [0.055, 0.012], [0.03, 0.02], [0, 0.02]], 10)]),
    merge([tube([V(0, 0, 0), V(0, 1.02, 0)], 0.022, { radial: 4, bend: 0, caps: false })])], mat: pole }], [50]);
  const sp = stopPole();
  P.stop = proto('stopPole', [{ geo: sp.pole, mat: pole }, { geo: sp.print, mat: F.print }, { geo: sp.disp, mat: F.display }]);
  return P;
}

const _m = new THREE.Matrix4();
const TICKET_COL = new THREE.Color().setStyle('#d9dad6', THREE.SRGBColorSpace);

/** Platforms of stations anchored in this chunk, and the platform fittings in it. */
export function placePlatforms(chunk, app, inst, addMesh, P, F) {
  const { route, layout } = app;
  const items = layout.inChunk('furniture', chunk.index);
  for (const st of layout.inChunk('stations', chunk.index)) {
    for (const pl of st.platforms) {
      const fittings = layout.furniture.filter((f) => f.station === st.id && (f.platformSide === pl.side || (f.d > 0) === (pl.side > 0)));
      buildPlatform(pl, app, addMesh, F, chunk.lod, fittings, inst, P);
    }
  }
  for (const f of items) {
    const h = f.h ?? 0.3, out = f.yaw + Math.PI / 2; // out: away from the tracks
    const side = f.d > 0 ? 1 : -1;
    switch (f.type) {
      case 'shelter': inst.add(P.shelter, placeMatrix(route, f.s, f.d, h, out + Math.PI, _m, 1.8)); break;
      case 'ticketMachine': inst.add(P.ticket, placeMatrix(route, f.s, f.d, h, out + Math.PI, _m, 0.35), TICKET_COL); break;
      case 'stopSign': inst.add(P.stop, placeMatrix(route, f.s, f.d, h, side > 0 ? Math.PI : 0, _m)); break;
      default: break;
    }
  }
}
