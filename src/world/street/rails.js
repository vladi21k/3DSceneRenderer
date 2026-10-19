import { RAIL_PROFILE, RAIL_X0, RAIL_X1, HEAD_HALF, GROOVE_DEPTH, GROUT_W, SEAL_TONE } from './constants.js';

// Embedded grooved rails as true 3D cross-sections swept along a centre line:
//  - the plain grooved rail (grey seals, bevelled head with a polished running band,
//    36 mm deep flangeway, guard lip), on the main tracks and through crossovers;
//  - switch tongues: a tapered head lying in the stock rail's groove;
//  - check rails: the guard lip raised and polished opposite a frog;
//  - railLinePoints(): centre-line points for the far-field anti-aliased overlay.

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// profile kinds drawn with rail.head, whose texture v the profile pins
const PINNED = new Set(['head', 'gauge', 'check', 'lip', 'side']);

/**
 * Profile segments grouped into runs that share vertices. Default: consecutive
 * same-kind segments meeting at a gentle corner (< 50°) share a smoothed normal, sharp
 * corners split. byKind: every same-kind sequence is one run with smoothed normals, so
 * the topology does not depend on the shape (tongues change shape along the sweep).
 */
function buildRuns(profile, byKind = false) {
  const segs = [];
  for (let j = 1; j < profile.length; j++) {
    const [x0, h0, , ao0, t0] = profile[j - 1], [x1, h1, kind, ao1, t1] = profile[j];
    const dx = x1 - x0, dh = h1 - h0, l = Math.hypot(dx, dh) || 1e-9;
    segs.push({ x0, h0, x1, h1, kind, ao0, ao1, t0, t1, nx: -dh / l, nh: dx / l, v0: 0, v1: 0 });
  }
  const cosLim = Math.cos((50 * Math.PI) / 180);
  for (const s of segs) { s.n0 = [s.nx, s.nh]; s.n1 = [s.nx, s.nh]; }
  for (let j = 0; j < segs.length - 1; j++) {
    const a = segs[j], b = segs[j + 1];
    const share = byKind ? a.kind === b.kind : a.nx * b.nx + a.nh * b.nh > cosLim;
    if (share) {
      let x = a.nx + b.nx, h = a.nh + b.nh;
      const l = Math.hypot(x, h) || 1; x /= l; h /= l;
      a.n1 = [x, h]; b.n0 = a.n1;
    }
  }
  // texture v: arc length from the field-side paving edge, unless the profile pins it
  // (the steel kinds are mapped onto their bands of the rail.head texture)
  let acc = 0;
  for (const s of segs) {
    s.v0 = acc; acc += Math.hypot(s.x1 - s.x0, s.h1 - s.h0); s.v1 = acc;
    if (PINNED.has(s.kind)) { s.v0 = s.t0 ?? s.v0; s.v1 = s.t1 ?? s.v1; }
  }
  const runs = [];
  let cur = null;
  for (let j = 0; j < segs.length; j++) {
    const sg = segs[j];
    if (cur && cur.kind === sg.kind && segs[j - 1].n1 === sg.n0) cur.segs.push(sg);
    else { cur = { kind: sg.kind, segs: [sg] }; runs.push(cur); }
  }
  for (const r of runs) {
    // vertex colour = cavity AO (× the seal tone on the seals, drawn with the mortar)
    const tone = r.kind === 'seal' ? SEAL_TONE : 1;
    const s0 = r.segs[0];
    r.pts = [{ x: s0.x0, h: s0.h0, n: s0.n0, v: s0.v0, c: s0.ao0 * tone }];
    for (const sg of r.segs) r.pts.push({ x: sg.x1, h: sg.h1, n: sg.n1, v: sg.v1, c: sg.ao1 * tone });
    delete r.segs;
  }
  return runs;
}

/** Plain grooved rail. */
export const RUNS_MAIN = buildRuns(RAIL_PROFILE);

/** Check rail: the guard lip opposite a frog is raised to the head and polished by the
 *  backs of the wheels (rail.head material). */
export const RUNS_CHECK = buildRuns(RAIL_PROFILE.map((p) => {
  if (p[0] > 0.0695 && p[0] < 0.07) return [p[0], p[1], p[2], p[3], 0.0435 + (p[0] - 0.0765) * 1.4];
  if (p[2] !== 'lip' || p[0] < 0.07) return p;
  const top = p[0] > 0.0705 && p[0] < 0.0825;
  return [p[0], top ? p[1] * 0.25 : p[1] * 0.85, 'check', p[3], 0.0435 + (p[0] - 0.0765) * 1.4];
}));

// groove wall, lip and gauge seal: the part of the plain profile a tongue keeps
const GAUGE_TAIL = RAIL_PROFILE.filter((p) => p[0] >= 0.0585 && p[0] > 0.05);

/**
 * Switch tongue (phase before it has its own field side): a tapered head of width w,
 * `drop` below the stock head, with vertical faces down to the switch-box floor on the
 * field side and into its own flangeway on the gauge side, then the plain profile's
 * groove wall, lip and gauge seal.
 */
export function tongueRuns(w, drop, floorH) {
  const a = w / 2;
  const top = -drop;
  const P = [
    [-a, floorH + 0.0004, null, 0.3],
    [-a, top - 0.0042, 'groove', 0.55],                   // field face (in the open slot)
    [-a + Math.min(0.0024, a * 0.5), top - 0.0011, 'head', 1, 0.0435 - a],
    [0, top, 'head', 1, 0.0435],
    [a - Math.min(0.0024, a * 0.5), top - 0.0011, 'head', 1, 0.0435 + a],
    [a, top - 0.0042, 'gauge', 0.92, 0.075],
    [a + 0.0004, -0.0115, 'gauge', 0.62, 0.079],
    [a + 0.001, -0.029, 'groove', 0.42],
    [a + 0.004, -0.0342, 'groove', 0.3],
    [Math.max(a + 0.011, 0.0395), -GROOVE_DEPTH, 'groove', 0.25],
    ...GAUGE_TAIL,
  ];
  return buildRuns(P, true);
}

/** Tongue head width (m) and depth below the stock head at separation sep from it. */
export const SEP_A = 0.115;     // from here the tongue has its full head and field side
export const tongueW = (sep) => 2 * HEAD_HALF * Math.min(1, 0.15 + sep / 0.05);
export const tongueDrop = (sep) => 0.0015 * (1 - smooth(sep / SEP_A));

// Mortar strips swept with a rail (crossovers, where the paving grid has none): flat at
// the paving level, overlapping the seal by 3 mm. Their material is drawn with a
// small polygon offset, so they cover the paving's (cut, aliased) edge and their own
// geometric, anti-aliased edges show instead, without z-fighting at any distance.
const mortarRun = (x0, x1, c0, c1) => ({
  kind: 'mortar',
  pts: [
    { x: x0, h: 0, n: [0, 1], v: x0, c: c0 },
    { x: (x0 + x1) / 2, h: 0, n: [0, 1], v: (x0 + x1) / 2, c: (c0 + c1) / 2 },
    { x: x1, h: 0, n: [0, 1], v: x1, c: c1 },
  ],
});
export const MORTAR_FIELD = mortarRun(RAIL_X0 - GROUT_W, RAIL_X0 + 0.003, 0.86, 0.97);
export const MORTAR_GAUGE = mortarRun(RAIL_X1 - 0.003, RAIL_X1 + GROUT_W, 0.97, 0.86);

/**
 * Sweep profile runs along a rail centre line.
 * pts[i]: {px, py, pz, rx, rz, u, s, d, dd, n}: centre point (world), the rail's own
 *   horizontal unit right vector, texture u along the rail, and route coordinates with
 *   the lateral slope dd = dd/ds and n = 1 / sqrt(1 + dd²).
 * g: gauge direction relative to the right vector.
 * runsAt(i): profile runs at sample i (the same topology for every sample).
 * mats: material per run kind. cut(i, kind, x, sv, dv, out4) (optional) fills the cut
 * attribute of the vertex at rail-local x and route position (sv, dv).
 */
export function sweepRuns(out, mats, pts, g, runsAt, cut = null) {
  const np = pts.length;
  if (np < 2) return;
  const R = new Array(np);
  for (let i = 0; i < np; i++) R[i] = runsAt(i);
  const c4 = [0, 0, 0, 0];
  for (let j = 0; j < R[0].length; j++) {
    const b = out.get(mats[R[0][j].kind], true);
    const kind = R[0][j].kind;
    let prev = -1;
    for (let i = 0; i < np; i++) {
      const p = pts[i];
      const P = R[i][j].pts;
      const first = b.n;
      for (let k = 0; k < P.length; k++) {
        const q = P[k];
        const ox = g * q.x, nx = g * q.n[0];
        const v = b.v(p.px + p.rx * ox, p.py + q.h, p.pz + p.rz * ox, p.rx * nx, q.n[1], p.rz * nx, p.u, q.v, q.c, q.c, q.c);
        if (cut) {
          const nn = p.n ?? 1;
          cut(i, kind, q.x, p.s - ox * (p.dd || 0) * nn, p.d + ox * nn, c4);
          b.setCut(v, c4[0], c4[1], c4[2], c4[3]);
        }
      }
      if (prev >= 0) {
        for (let k = 0; k < P.length - 1; k++) {
          const a0 = prev + k, a1 = prev + k + 1, b0 = first + k, b1 = first + k + 1;
          if (g > 0) b.quad(a0, a1, b1, b0);
          else b.quad(a1, a0, b0, b1);
        }
      }
      prev = first;
    }
  }
}

/** Points for a LineBuf ribbon centred on the rail profile (offset so the ribbon covers
 *  the rail and its mortar strips); returns [flat array, halfWidth, centreOffset]. The
 *  ribbon's right vector points to the gauge side. pts: {px, py, pz, rx, rz, u}. */
export function railLinePoints(pts, g) {
  const cOff = (RAIL_X0 + RAIL_X1) / 2, half = (RAIL_X1 - RAIL_X0) / 2 + GROUT_W;
  const n = pts.length;
  const arr = new Array(n * 6);
  for (let i = 0; i < n; i++) {
    // walk the path backwards when the gauge side is on its left, so the ribbon's
    // right vector (towards the gauge) is always the right of its direction
    const p = pts[g > 0 ? i : n - 1 - i], o = i * 6;
    // ribbon centre sits cOff towards the gauge side
    arr[o] = p.px + p.rx * g * cOff; arr[o + 1] = p.py; arr[o + 2] = p.pz + p.rz * g * cOff;
    arr[o + 3] = p.rx * g; arr[o + 4] = p.rz * g; arr[o + 5] = p.u;
  }
  return [arr, half, cOff];
}
