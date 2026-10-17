import { TRACK_OFFSET, RAIL_CENTER, MAIN_RAILS, RAIL_X0, RAIL_X1, HEAD_HALF, GROOVE_OUT, LIP_OUT } from './constants.js';
import { samplePath, inlayStrip, inlayRail, railLinePoints } from './rails.js';

// Single crossover between the two tracks: a reverse curve (two circular arcs of
// radius R joined by a straight) carrying the diverging track from one track centre to
// the other over the planned length, with
//  - switch blades: tapered tongues leaving the stock rails at both ends,
//  - two frogs where the diverging rails cross the main rails (flangeways cut through
//    the heads), on cast manganese-steel plates,
//  - check rails opposite each frog.
// Everything inside the crossover is drawn as coplanar inlays over flat paving using
// polygon-offset layers: plates < seals/heads < flangeways < switch tongues.

const SPACING = 2 * TRACK_OFFSET;

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

const cache = new Map();

/** Geometry description of a crossover (cached). */
export function crossoverPlan(c) {
  let p = cache.get(c);
  if (p) return p;
  const L = c.len;
  const d0 = c.from * TRACK_OFFSET, sgn = -c.from; // start track centre, direction of travel in d
  const cv = solveCurve(L, SPACING);
  const centre = (x) => ({ s: c.s0 + x, d: d0 + sgn * cv.y(x), dd: sgn * cv.dy(x) });
  // diverging rails: perpendicular offsets o (path right), gauge towards the path centre
  const rails = [-1, 1].map((side) => {
    const o = side * RAIL_CENTER;
    const fn = (x) => {
      const q = centre(x);
      const n = Math.sqrt(1 + q.dd * q.dd);
      return { s: q.s - (o * q.dd) / n, d: q.d + o / n, dd: q.dd };
    };
    return { side, o, g: -side, fn, dStart: d0 + o, dEnd: -d0 + o };
  });
  // frogs: diverging rail crossing a main rail
  const frogs = [];
  for (const r of rails) {
    for (const m of MAIN_RAILS) {
      // skip the rails it starts / ends on
      if (Math.abs(m.c - r.dStart) < 0.01 || Math.abs(m.c - r.dEnd) < 0.01) continue;
      // bisection on x for d_rail(x) = m.c
      const f = (x) => r.fn(x).d - m.c;
      let a = 0, b = L;
      if (Math.sign(f(a)) === Math.sign(f(b))) continue;
      for (let k = 0; k < 50; k++) { const mid = (a + b) / 2; if (Math.sign(f(mid)) === Math.sign(f(a))) a = mid; else b = mid; }
      const x = (a + b) / 2;
      frogs.push({ x, s: r.fn(x).s, rail: r, main: m });
    }
  }
  p = { c, L, d0, sgn, cv, centre, rails, frogs };
  cache.set(c, p);
  return p;
}

/**
 * Build the crossover inlays (lod 0) and its far-field rail lines (all lods).
 * ctx.inlayBufs(bufs) supplies the layered buffers: plate, main {seal, side, head,
 * groove}, tongue {side, head}, flange, check.
 */
export function buildCrossover(ctx, c, chunk, bufs, lineBuf) {
  const { route } = ctx;
  const p = crossoverPlan(c);
  const pad = ctx.inlayPad;
  const L = p.L;

  // --- far-field overlay lines for the two diverging rails
  for (const r of p.rails) {
    const pts = samplePath(route, null, r.fn, 0.4, L - 0.4, chunk.lod === 0 ? 0.5 : 1.5);
    const [arr, half, cOff] = railLinePoints(pts, r.g);
    lineBuf.add(arr, half, cOff);
  }
  if (chunk.lod > 0) return;

  const B = ctx.inlayBufs(bufs);

  // --- main rails as inlays over the whole zone (paving is continuous here)
  for (const m of MAIN_RAILS) {
    const fn = (x) => ({ s: c.s0 + x, d: m.c, dd: 0 });
    const pts = samplePath(route, null, fn, -pad, L + pad, 0.5);
    inlayRail(B.main, pts, m.g);
  }

  // --- diverging rails: tongues near the ends, full profile once clear of the stock rail
  for (const r of p.rails) {
    const sepAt = (x) => {
      const d = r.fn(x).d;
      return Math.min(Math.abs(d - r.dStart), Math.abs(d - r.dEnd));
    };
    const pts = samplePath(route, null, r.fn, 0, L, 0.25);
    for (const q of pts) q.sep = sepAt(q.t);
    const clear = (q) => q.sep > 0.115;
    // full rail where clear of the stock rail
    inlayRail(B.main, pts, r.g, { mask: (q) => (clear(q) ? 1 : 0) });
    // tongue: tapered head lying against / in the stock rail's groove
    inlayRail(B.tongue, pts, r.g, {
      mask: (q, band) => {
        if (clear(q)) return 0;
        if (band !== 'head' && band !== 'cornerF') return 0;
        return Math.min(1, 0.15 + q.sep / 0.05);
      },
    });
    // cast switch plate under the tongue
    plateAlong(B.plate, (q) => q.sep < 0.2, pts, r);
  }

  // --- frogs: cast plates, flangeways over both heads, check rails opposite
  for (const f of p.frogs) {
    const half = 1.3;
    const fnMain = (x) => ({ s: c.s0 + x, d: f.main.c, dd: 0 });
    const ptsM = samplePath(route, null, fnMain, f.x - half, f.x + half, 0.2);
    // plate: around the main rail, wide enough to hold the crossing rail
    const plateHalf = (q) => 0.1 + Math.abs(f.rail.fn(q.t).d - f.main.c) * 0.9 + 0.02 * (1 - Math.abs(q.t - f.x) / half);
    inlayStrip(B.plate, ptsM, (q) => -plateHalf(q), plateHalf);
    // flangeway of the main rail cut through the crossing rail's head (above heads)
    const ptsG = samplePath(route, null, fnMain, f.x - half, f.x + half, 0.25);
    inlayStrip(B.flange, ptsG, () => (f.main.g > 0 ? HEAD_HALF : -GROOVE_OUT), () => (f.main.g > 0 ? GROOVE_OUT : -HEAD_HALF));
    const ptsR = samplePath(route, null, f.rail.fn, f.x - half, f.x + half, 0.25);
    inlayStrip(B.flange, ptsR, () => (f.rail.g > 0 ? HEAD_HALF : -GROOVE_OUT), () => (f.rail.g > 0 ? GROOVE_OUT : -HEAD_HALF));
    // check rails: widened polished guard on the opposite rails of both routes
    const oppMain = MAIN_RAILS.find((m) => m.track === f.main.track && m !== f.main);
    const oppRail = p.rails.find((r) => r !== f.rail);
    checkRail(B.check, samplePath(route, null, (x) => ({ s: c.s0 + x, d: oppMain.c, dd: 0 }), f.x - 2.4, f.x + 2.4, 0.2), oppMain.g, f.x);
    checkRail(B.check, samplePath(route, null, oppRail.fn, f.x - 2.4, f.x + 2.4, 0.2), oppRail.g, f.x);
  }
}

/** Cast plate under a switch tongue: spans the stock rail and the tongue while `test`
 *  holds (one run at each end of the crossover). */
function plateAlong(buf, test, pts, r) {
  const stockA = MAIN_RAILS.find((m) => Math.abs(m.c - r.dStart) < 0.01);
  const stockB = MAIN_RAILS.find((m) => Math.abs(m.c - r.dEnd) < 0.01);
  const tlo = r.g > 0 ? RAIL_X0 : -RAIL_X1, thi = r.g > 0 ? RAIL_X1 : -RAIL_X0;
  const ext = (q) => {
    const m = Math.abs(q.d - r.dStart) < Math.abs(q.d - r.dEnd) ? stockA : stockB;
    return [Math.min(tlo, m.lo - q.d) - 0.025, Math.max(thi, m.hi - q.d) + 0.025];
  };
  const runs = [];
  let cur = [];
  for (const q of pts) {
    if (test(q)) cur.push(q);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  for (const run of runs) if (run.length > 1) inlayStrip(buf, run, (q) => ext(q)[0], (q) => ext(q)[1]);
}

/** Check rail: a wider, polished guard face along the lip, flared at both ends. */
function checkRail(buf, pts, g, xc) {
  inlayStrip(buf, pts, (q) => {
    const e = Math.min(1, (2.4 - Math.abs(q.t - xc)) / 0.5);
    const a = GROOVE_OUT - 0.004 * e, b = LIP_OUT + 0.012 * e;
    return g > 0 ? a : -b;
  }, (q) => {
    const e = Math.min(1, (2.4 - Math.abs(q.t - xc)) / 0.5);
    const a = GROOVE_OUT - 0.004 * e, b = LIP_OUT + 0.012 * e;
    return g > 0 ? b : -a;
  });
}
