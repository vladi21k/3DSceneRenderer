import { TRACK_OFFSET, RAIL_CENTER, MAIN_RAILS, RAIL_X0, RAIL_X1, HEAD_HALF, GROOVE_OUT, GROUT_W } from './constants.js';
import {
  RUNS_MAIN, RUNS_CHECK, MORTAR_FIELD, MORTAR_GAUGE, SEP_A, tongueRuns, tongueW, tongueDrop, sweepRuns, railLinePoints,
} from './rails.js';

// Single crossover between the two tracks, built from real 3D grooved rails.
//
// The diverging track is a reverse curve (two circular arcs of radius ~70 m joined by a
// straight) from one track centre to the other. Its two rails are swept with the full
// grooved profile along their own path, bedded in their own mortar strips. Where rails
// meet they interact through per-vertex cut attributes (shading.js patchCut):
//  - switches (both ends): one rail continues as the stock rail S; the other, the
//    tongue T, is born at the toe as a tapered head lying in S's groove, 1.5 mm below
//    the stock head, and widens into a full rail as it moves away. S keeps its head
//    while its groove wall, lip and seal open up wherever T (and T's flangeway) lies;
//    between the stock head and the tongue an open slot shows the switch-box floor.
//  - frogs (where a diverging rail crosses a main rail): the crossing flangeway is cut
//    through the main rail's head; the diverging rail's head and lip stop at the main
//    rail, its groove runs through.
//  - check rails opposite each frog: the guard lip raised and polished.
// A dark cast floor below the groove floors fills every opening.

const SPACING = 2 * TRACK_OFFSET;
const RANGE = 0.36;              // rails interact (cuts, floors) while closer than this
const CHECK_HALF = 2.4;          // check rails reach this far either side of a frog
export const FLOOR_H = -0.0372;  // cast floor of switch boxes and frogs (below the grooves)
const FLOOR_HALF = 0.45;

const FULL = [RAIL_X0 - GROUT_W, RAIL_X1 + GROUT_W];    // rail + mortar strips
const SPAN = [RAIL_X0, RAIL_X1];                        // rail incl. seals
const FLANGE = [HEAD_HALF, GROOVE_OUT];                 // flangeway
const NONE = [1, -1];
export const PAVE_CUT = [RAIL_X0 + 0.001, RAIL_X1 - 0.001]; // paving under the swept mortar

const RUNS_DIV = [...RUNS_MAIN, MORTAR_FIELD, MORTAR_GAUGE];
const RUNS_DIV_CHECK = [...RUNS_CHECK, MORTAR_FIELD, MORTAR_GAUGE];

/** Reverse-curve centre line y(x) (lateral offset from the start track, 0..SPACING). */
function solveCurve(L, Y) {
  // pick the radius so the straight in the middle stays >= 2 m
  let R = 70;
  let phi = 0;
  for (let it = 0; it < 8; it++) {
    // offset(phi) = 2R(1-cos) + (L - 2R sin) tan  -> bisection
    let lo = 1e-4, hi = 0.6;
    for (let k = 0; k < 60; k++) {
      const m = (lo + hi) / 2;
      const off = 2 * R * (1 - Math.cos(m)) + (L - 2 * R * Math.sin(m)) * Math.tan(m);
      if (off > Y) hi = m; else lo = m;
    }
    phi = (lo + hi) / 2;
    if (L - 2 * R * Math.sin(phi) >= 2) break;
    R *= 0.85;
  }
  const x1 = R * Math.sin(phi);
  const y1 = R * (1 - Math.cos(phi));
  const tp = Math.tan(phi);
  const y = (x) => {
    if (x <= 0) return 0;
    if (x >= L) return Y;
    if (x < x1) return R - Math.sqrt(R * R - x * x);
    if (x > L - x1) { const u = L - x; return Y - (R - Math.sqrt(R * R - u * u)); }
    return y1 + (x - x1) * tp;
  };
  const dy = (x) => {
    if (x <= 0 || x >= L) return 0;
    if (x < x1) return x / Math.sqrt(R * R - x * x);
    if (x > L - x1) { const u = L - x; return u / Math.sqrt(R * R - u * u); }
    return tp;
  };
  return { R, phi, y, dy, x1 };
}

/** Root of f on [a, b] (f(a), f(b) of opposite sign). */
function bisect(f, a, b) {
  let fa = f(a);
  for (let k = 0; k < 48; k++) {
    const m = (a + b) / 2, fm = f(m);
    if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else b = m;
  }
  return (a + b) / 2;
}

const cache = new Map();

/**
 * Geometry and interactions of a crossover (cached).
 * rails[]: the two diverging rails: { g, at(x), xAt(s), local(s, d), ia[], checks[] }
 *   with ia = interaction ranges along the path parameter x (switch / frog).
 * mainIa: Map(main rail -> [{kind, s0, s1, rail, role, sA}]), mainChecks: Map(-> [[s0, s1]]).
 */
export function crossoverPlan(c, dl) {
  let p = cache.get(c);
  if (p) return p;
  const L = c.len;
  const d0 = c.from * TRACK_OFFSET, sgn = -c.from;   // start track centre, direction of travel in d
  const cv = solveCurve(L, SPACING);
  const rails = [-1, 1].map((side) => {
    const o = side * RAIL_CENTER;
    const r = { side, o, g: -side, dStart: d0 + o, dEnd: -d0 + o, ia: [], checks: [] };
    // point of the rail at path parameter x (straight beyond both ends)
    r.at = (x, out = {}) => {
      const xc = x < 0 ? 0 : x > L ? L : x;
      const dd = sgn * cv.dy(xc), n = 1 / Math.sqrt(1 + dd * dd);
      out.x = x; out.s = c.s0 + x - o * dd * n; out.d = d0 + sgn * cv.y(xc) + o * n; out.dd = dd; out.n = n;
      return out;
    };
    // path parameter at route s (inverts s(x))
    r.xAt = (s) => {
      const x0 = dl(c.s0, s);
      let x = x0;
      for (let k = 0; k < 3; k++) {
        const xc = x < 0 ? 0 : x > L ? L : x;
        const dd = sgn * cv.dy(xc);
        x = x0 + (o * dd) / Math.sqrt(1 + dd * dd);
      }
      return x;
    };
    // rail point at route s (cached: callers ask row by row)
    const q = {};
    let lastS = NaN;
    r.atS = (s) => {
      if (s !== lastS) { r.at(r.xAt(s), q); lastS = s; }
      return q;
    };
    // lateral coordinate of route point (s, d) in the rail's frame (+ towards its gauge)
    r.local = (s, d) => { const a = r.atS(s); return r.g * (d - a.d) * a.n; };
    return r;
  });

  const tmp = {};
  const mainIa = new Map(MAIN_RAILS.map((m) => [m, []]));
  const mainChecks = new Map(MAIN_RAILS.map((m) => [m, []]));
  const frogs = [];
  for (const r of rails) {
    const sep = (ref) => (x) => Math.abs(r.at(x, tmp).d - ref);
    const mS = MAIN_RAILS.find((m) => Math.abs(m.c - r.dStart) < 0.01);
    const mE = MAIN_RAILS.find((m) => Math.abs(m.c - r.dEnd) < 0.01);
    // switches: the diverging rail is the tongue when it moves towards the main rail's
    // gauge side (into its groove); otherwise it is the stock rail and the main rail
    // becomes the tongue
    {
      const f = sep(mS.c);
      const xR = bisect((x) => f(x) - RANGE, 0, L / 2), xA = bisect((x) => f(x) - SEP_A, 0, L / 2);
      const role = sgn === mS.g ? 'T' : 'S';
      r.ia.push({ kind: 'switch', x0: 0, x1: xR, xA, tongue: [0, xA], main: mS, role });
      mainIa.get(mS).push({ kind: 'switch', s0: c.s0, s1: r.at(xR, tmp).s, tongue: [c.s0, r.at(xA, tmp).s], rail: r, role: role === 'T' ? 'S' : 'T' });
    }
    {
      const f = sep(mE.c);
      const xR = bisect((x) => f(x) - RANGE, L / 2, L), xA = bisect((x) => f(x) - SEP_A, L / 2, L);
      const role = -sgn === mE.g ? 'T' : 'S';
      r.ia.push({ kind: 'switch', x0: xR, x1: L, xA, tongue: [xA, L], main: mE, role });
      mainIa.get(mE).push({ kind: 'switch', s0: r.at(xR, tmp).s, s1: c.s1, tongue: [r.at(xA, tmp).s, c.s1], rail: r, role: role === 'T' ? 'S' : 'T' });
    }
    // frogs: crossings of the other main rails
    for (const m of MAIN_RAILS) {
      if (m === mS || m === mE) continue;
      const f = (x) => r.at(x, tmp).d - m.c;
      if ((f(0) < 0) === (f(L) < 0)) continue;
      const xf = bisect(f, 0, L);
      const q = r.at(xf, {});
      const dx = (RANGE + 0.2) / Math.abs(q.dd);
      r.ia.push({ kind: 'frog', x0: xf - dx, x1: xf + dx, main: m });
      mainIa.get(m).push({ kind: 'frog', s0: q.s - dx, s1: q.s + dx, rail: r });
      frogs.push({ rail: r, main: m, s: q.s });
    }
    r.ia.sort((a, b) => a.x0 - b.x0);
  }
  // check rails opposite each frog, on both routes
  for (const f of frogs) {
    const oppMain = MAIN_RAILS.find((m) => m.track === f.main.track && m !== f.main);
    mainChecks.get(oppMain).push([f.s - CHECK_HALF, f.s + CHECK_HALF]);
    const oppRail = rails.find((r) => r !== f.rail);
    const xc = oppRail.xAt(f.s);
    oppRail.checks.push([xc - CHECK_HALF, xc + CHECK_HALF]);
  }
  // arc: length of the curved part at each end (the middle is straight)
  p = { c, L, arc: cv.x1, rails, mainIa, mainChecks, dl };
  cache.set(c, p);
  return p;
}

// ------------------------------------------------------------------ cut rules

/** Band (in the other rail's frame) that cuts a surface of `kind` (rail-local x) for a
 *  rail playing `role` ('S' stock, 'T' tongue, 'FM' main at a frog, 'FD' diverging rail
 *  at a frog). sep: separation of the switch rails (S role). */
function band(role, kind, x, sep) {
  switch (role) {
    case 'S':
      // the stock head stays; its groove wall, lip, seal and mortar open where the
      // tongue (head + flangeway + lip + seal) lies
      if (kind === 'head' || kind === 'gauge' || kind === 'side' || kind === 'check') return NONE;
      return [sep < SEP_A ? -tongueW(sep) / 2 : RAIL_X0, RAIL_X1];
    case 'T':
      // the tongue and its gauge side replace the stock rail's; its field side (once it
      // has one) and its mortar give way to the stock rail
      if (kind === 'mortar') return FULL;
      if (kind === 'side' || (kind === 'seal' && x < 0)) return SPAN;
      return NONE;
    case 'FM':
      return kind === 'mortar' ? SPAN : FLANGE;
    case 'FD':
      if (kind === 'groove') return FLANGE;
      return kind === 'mortar' ? FULL : SPAN;
    default:
      return NONE;
  }
}

function setCut(out, xo, b) { out[0] = xo; out[1] = b[0]; out[2] = b[1]; out[3] = 1; }

/** Interaction of main rail m at route s, or null. */
function mainIaAt(p, m, s) {
  const list = p.mainIa.get(m);
  for (let i = 0; i < list.length; i++) {
    const ia = list[i];
    if (p.dl(ia.s0, s) >= 0 && p.dl(ia.s1, s) <= 0) return ia;
  }
  return null;
}

/** Cut attribute of a main-rail surface vertex (route s, d; rail-local x; run kind). */
export function mainCut(p, m, s, d, kind, x, out) {
  out[3] = 0;
  const ia = mainIaAt(p, m, s);
  if (!ia) return;
  const r = ia.rail;
  const sep = ia.kind === 'switch' ? Math.abs(r.atS(s).d - m.c) : 0;
  setCut(out, r.local(s, d), band(ia.kind === 'frog' ? 'FM' : ia.role, kind, x, sep));
}

/** Whether main rail m interacts with a diverging rail at s (cuts, tongue, check). */
export function mainBusy(p, m, s) {
  return !!mainIaAt(p, m, s) || mainClass(p, m, s) !== 'F';
}

/** Cut attribute of a diverging-rail surface vertex. q: the rail's path sample. */
function railCut(r, q, kind, x, sv, dv, out) {
  out[3] = 0;
  const ia = q.ia;
  if (!ia) return;
  const m = ia.main;
  const sep = ia.kind === 'switch' ? Math.abs(q.d - m.c) : 0;
  setCut(out, m.g * (dv - m.c), band(ia.kind === 'frog' ? 'FD' : ia.role, kind, x, sep));
}

/** Paving cut: lateral coordinates in both diverging rails' frames (band PAVE_CUT). */
export function paveCut(p, s, d, out) {
  out[0] = p.rails[0].local(s, d);
  out[1] = PAVE_CUT[0]; out[2] = PAVE_CUT[1];
  out[3] = p.rails[1].local(s, d);
}

/** Profile class of a main rail at s: 'T' tongue, 'C' check rail, 'F' plain. */
export function mainClass(p, m, s) {
  for (const ia of p.mainIa.get(m)) {
    if (ia.kind === 'switch' && ia.role === 'T' && p.dl(ia.tongue[0], s) >= 0 && p.dl(ia.tongue[1], s) <= 0) return 'T';
  }
  for (const [a, b] of p.mainChecks.get(m)) if (p.dl(a, s) >= 0 && p.dl(b, s) <= 0) return 'C';
  return 'F';
}

/** Profile runs of a main rail at s for its class. */
export function mainRuns(p, m, s, cls) {
  if (cls === 'C') return RUNS_CHECK;
  if (cls !== 'T') return RUNS_MAIN;
  const ia = mainIaAt(p, m, s);
  const sep = ia ? Math.abs(ia.rail.atS(s).d - m.c) : 0;
  return tongueRuns(tongueW(sep), tongueDrop(sep), FLOOR_H);
}

// ------------------------------------------------------------------ build

/** Samples of a diverging rail over path parameters [x0, x1] (world centre line, own
 *  right vector, texture u, route coordinates). */
function railSamples(ctx, p, r, x0, x1, step) {
  const { route, surface } = ctx;
  const n = Math.max(1, Math.ceil((x1 - x0) / step));
  const smp = {};
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const q = r.at(x, {});
    route.sample(q.s, smp);
    // world tangent of the rail: tanH + right * dd (per metre of s)
    let tx = smp.tanH.x + smp.right.x * q.dd, tz = smp.tanH.z + smp.right.z * q.dd;
    const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
    q.px = smp.pos.x + smp.right.x * q.d; q.py = smp.pos.y; q.pz = smp.pos.z + smp.right.z * q.d;
    q.rx = -tz; q.rz = tx;
    q.u = surface.sp(p.c.s0) + x;
    pts.push(q);
  }
  return pts;
}

/**
 * Build the parts of crossover c that fall inside the chunk: diverging rails (lod 0) and
 * their far-field lines (all lods), and the cast floor under the switches and frogs.
 * The main rails and the paving are built by the track / paving builders with the cut
 * attributes from mainCut / paveCut. Resumable (see street.js): yields 'crossover' after
 * each segment of a diverging rail.
 */
export function* buildCrossover(ctx, c, chunk, bufs, lineBuf) {
  const p = crossoverPlan(c, ctx.delta);
  const mats = ctx.mats.cutDiv;
  for (const r of p.rails) {
    const xa = Math.max(0, r.xAt(chunk.s0)), xb = Math.min(p.L, r.xAt(chunk.s1));
    if (xb - xa < 1e-3) continue;
    const line = railSamples(ctx, p, r, xa, xb, chunk.lod === 0 ? 0.5 : 1.5);
    lineBuf.add(...railLinePoints(line, r.g));
    if (chunk.lod > 0) continue;

    // segments with one profile class each: tongue / check / plain
    const br = [xa, xb];
    const addBreak = (x) => { if (x > xa + 1e-4 && x < xb - 1e-4) br.push(x); };
    for (const ia of r.ia) { addBreak(ia.x0); addBreak(ia.x1); if (ia.tongue) { addBreak(ia.tongue[0]); addBreak(ia.tongue[1]); } }
    for (const [a, b] of r.checks) { addBreak(a); addBreak(b); }
    br.sort((a, b) => a - b);
    for (let k = 0; k < br.length - 1; k++) {
      const x0 = br[k], x1 = br[k + 1];
      if (x1 - x0 < 1e-3) continue;
      const mid = (x0 + x1) / 2;
      const iaMid = r.ia.find((ia) => mid >= ia.x0 && mid <= ia.x1) || null;
      const tongue = iaMid && iaMid.kind === 'switch' && iaMid.role === 'T' && mid >= iaMid.tongue[0] && mid <= iaMid.tongue[1];
      const check = !tongue && r.checks.some(([a, b]) => mid >= a && mid <= b);
      // (chord error at R 70 m: 0.45 mm for 0.5 m steps)
      const pts = railSamples(ctx, p, r, x0, x1, tongue ? 0.25 : 0.5);
      for (const q of pts) q.ia = iaMid;
      const runsAt = tongue
        ? (i) => {
          const sep = Math.abs(pts[i].d - iaMid.main.c);
          return [...tongueRuns(tongueW(sep), tongueDrop(sep), FLOOR_H), MORTAR_GAUGE];
        }
        : check ? () => RUNS_DIV_CHECK : () => RUNS_DIV;
      sweepRuns(bufs, mats, pts, r.g, runsAt, (i, kind, x, sv, dv, out) => railCut(r, pts[i], kind, x, sv, dv, out));
      yield 'crossover';
    }
    yield 'crossover';
  }
  if (chunk.lod === 0) buildFloors(ctx, p, chunk, bufs);
}

/** Dark cast floor (switch boxes, frogs) under every interaction range in the chunk. */
function buildFloors(ctx, p, chunk, bufs) {
  const { route } = ctx;
  const b = bufs.get(ctx.mats.cut.floor, true);
  const smp = {};
  const dl = ctx.delta;
  for (const [m, list] of p.mainIa) {
    for (const ia of list) {
      const a = Math.max(0, dl(chunk.s0, ia.s0)), e = Math.min(chunk.s1 - chunk.s0, dl(chunk.s0, ia.s1));
      if (e - a < 1e-3) continue;
      const n = Math.max(1, Math.ceil(e - a));
      let prev = -1;
      for (let i = 0; i <= n; i++) {
        const s = chunk.s0 + a + ((e - a) * i) / n;
        route.sample(s, smp);
        const y = smp.pos.y + FLOOR_H;
        const v = b.v(smp.pos.x + smp.right.x * (m.c - FLOOR_HALF), y, smp.pos.z + smp.right.z * (m.c - FLOOR_HALF), 0, 1, 0, s, 0, 0.32, 0.32, 0.32);
        b.v(smp.pos.x + smp.right.x * (m.c + FLOOR_HALF), y, smp.pos.z + smp.right.z * (m.c + FLOOR_HALF), 0, 1, 0, s, 2 * FLOOR_HALF, 0.32, 0.32, 0.32);
        if (prev >= 0) b.quad(prev, prev + 1, v + 1, v);
        prev = v;
      }
    }
  }
}
