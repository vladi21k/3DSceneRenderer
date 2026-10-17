import { RNG } from '../../core/rng.js';

// Café terrace planning: turns the layout's café (tables, chairs, umbrellas) into
// collision-free placements. Works in a local metric frame per café: x = metres along the
// street at the café's offset (s scaled by route.offsetScale), y = d.
//   1. chairs: neighbouring chairs (other tables, other chairs) are relaxed apart by small
//      moves around their own table, with a small random turn away from the neighbour
//   2. umbrellas: each canopy keeps clear of its neighbours (no interpenetrating fabric),
//      of the facade and of the street-tree crowns; the weighted base gets a footprint
//      that clears every chair and table foot, or the pole runs through a table's centre
//      hole; sizes step down when nothing fits
//   3. menu board: a free spot along the walkway edge
// Footprints are oriented rectangles {x, y, ux, uy, hu, hv} (u = forward axis) or circles.

// chair footprint per style: half width across, depth range along the facing direction
export const CHAIR_FOOT = {
  bistro: { hx: 0.25, z0: -0.3, z1: 0.22 },
  plastic: { hx: 0.25, z0: -0.31, z1: 0.25 },
  metal: { hx: 0.245, z0: -0.33, z1: 0.23 },
  wicker: { hx: 0.27, z0: -0.28, z1: 0.24 },
};
export const BASE_HALF = 0.28;        // square concrete umbrella base (half size)
export const DISC_R = 0.23;           // round cast-iron umbrella base
const TOP_R = 0.32;                   // table top (+ a little air) the pole must clear
const BASE_R = { iron: 0.215, cross: 0.3, crossDark: 0.3 };
const GAP = 0.03;                     // minimum air between footprints
const CANOPY_GAP = 0.1;               // minimum air between neighbouring canopies
const FACADE_GAP = 0.3;               // canopy edge to the facade line (plinths, pilasters)
const CROWN_K = 0.85;                 // share of a tree's crown radius the canopy must clear
const RELAX_ITERS = 40;               // chair relaxation passes
const MAX_SHIFT = 0.32;               // furthest a chair moves from its planned spot (m)
const VALANCE = 0.02;                 // valance flare beyond the nominal canopy size
export const UMB_SIZES = [24, 36];    // canopy size buckets (decimetres)

const rect = (x, y, yaw, hu, hv, du = 0) => {
  const ux = Math.cos(yaw), uy = Math.sin(yaw);
  return { x: x + ux * du, y: y + uy * du, ux, uy, hu, hv };
};

/** Separating-axis overlap of two oriented rectangles, each grown by `g`/2. */
function rectsOverlap(a, b, g) {
  const axes = [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]];
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [ax, ay] of axes) {
    const ra = a.hu * Math.abs(a.ux * ax + a.uy * ay) + a.hv * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = b.hu * Math.abs(b.ux * ax + b.uy * ay) + b.hv * Math.abs(-b.uy * ax + b.ux * ay);
    if (Math.abs(dx * ax + dy * ay) > ra + rb + g) return false;
  }
  return true;
}

/** Distance from a point to an oriented rectangle (0 inside). */
function rectDist(r, px, py) {
  const dx = px - r.x, dy = py - r.y;
  const u = Math.abs(dx * r.ux + dy * r.uy) - r.hu, v = Math.abs(-dx * r.uy + dy * r.ux) - r.hv;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0);
}

function chairRect(ch, f) {
  return rect(ch.x, ch.y, ch.yaw, (f.z1 - f.z0) / 2, f.hx, (f.z0 + f.z1) / 2);
}

/** Collision-free café plan. Mutates nothing in the layout except chair poses (see placeChairs).
 *  layout (optional): facade line and street trees the canopies keep clear of. */
export function planCafe(cafe, route, seed, baseType, layout = null) {
  const sMid = (cafe.s0 + cafe.s1) / 2;
  const dMid = (cafe.dIn + cafe.dOut) / 2;
  const k = route.offsetScale(sMid, dMid);
  // s <-> local metres along the terrace's offset line (the arc-length scale is integrated:
  // curvature can change along a terrace)
  const STEP = 0.25, a0 = route.delta(sMid, cafe.s0) - 6, n = Math.ceil((route.delta(cafe.s0, cafe.s1) + 12) / STEP);
  const cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) cum[i] = cum[i - 1] + STEP * route.offsetScale(sMid + a0 + (i - 0.5) * STEP, dMid);
  const x0 = cum[Math.round(-a0 / STEP)];
  const X = (s) => {                                  // s -> local metres
    const f = Math.min(n, Math.max(0, (route.delta(sMid, s) - a0) / STEP)), i = Math.min(n - 1, Math.floor(f));
    return cum[i] + (cum[i + 1] - cum[i]) * (f - i) - x0;
  };
  const S = (x) => {                                  // local metres -> s
    const c = x + x0;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= c) lo = m; else hi = m; }
    return sMid + a0 + (lo + (c - cum[lo]) / Math.max(1e-9, cum[lo + 1] - cum[lo])) * STEP;
  };
  const rng = RNG.from(seed, 'cafePlan', cafe.id);
  const foot = CHAIR_FOOT[cafe.chairStyle] || CHAIR_FOOT.bistro;
  const tables = cafe.tables.map((t, ti) => ({ ti, x: X(t.s), y: t.d, src: t }));

  // ---------------------------------------------------------------- 1. chairs
  const chairs = [];
  for (const t of tables) {
    t.src.chairs.forEach((c, ci) => {
      const x = X(c.s), y = c.d;
      const r = Math.hypot(x - t.x, y - t.y) || 0.62;
      chairs.push({ t, ci, src: c, x, y, x0: x, y0: y, r0: r, jit: rng.range(-0.12, 0.12), yaw: 0 });
    });
  }
  const face = (c) => { c.yaw = Math.atan2(c.t.y - c.y, c.t.x - c.x) + c.jit; };
  // the casual random turn goes away from the nearest neighbouring chair
  for (const c of chairs) {
    let nb = null, nd = 9;
    for (const o of chairs) { const dd = o === c ? 9 : Math.hypot(o.x - c.x, o.y - c.y); if (dd < nd) { nd = dd; nb = o; } }
    if (!nb) continue;
    const fx = c.t.x - c.x, fy = c.t.y - c.y, side = fx * (nb.y - c.y) - fy * (nb.x - c.x); // > 0: neighbour on the left
    c.jit = -Math.sign(side || 1) * Math.abs(c.jit);
  }
  chairs.forEach(face);
  // neighbour lists (chairs move at most MAX_SHIFT, so these stay complete)
  const reach = 1.0 + 2 * MAX_SHIFT;
  chairs.forEach((a, i) => {
    a.nb = [];
    for (let j = i + 1; j < chairs.length; j++) {
      const b = chairs[j];
      if (Math.abs(a.x - b.x) < reach && Math.abs(a.y - b.y) < reach) a.nb.push(b);
    }
    a.nt = tables.filter((t) => t !== a.t && Math.abs(t.x - a.x) < reach && Math.abs(t.y - a.y) < reach);
  });
  for (let it = 0; it < RELAX_ITERS; it++) {
    let moved = false;
    for (let i = 0; i < chairs.length; i++) {
      const a = chairs[i], ra = chairRect(a, foot);
      for (const b of a.nb) {
        if (Math.abs(a.x - b.x) > 1.0 || Math.abs(a.y - b.y) > 1.0) continue;
        if (!rectsOverlap(ra, chairRect(b, foot), 0.04)) continue;
        let nx = a.x - b.x, ny = a.y - b.y;
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        a.x += nx * 0.025; a.y += ny * 0.025; b.x -= nx * 0.025; b.y -= ny * 0.025;
        moved = true;
      }
      // other tables' tops and feet
      for (const t of a.nt) {
        if (Math.abs(t.x - a.x) > 1.0 || Math.abs(t.y - a.y) > 1.0) continue;
        const dd = rectDist(chairRect(a, foot), t.x, t.y);
        if (dd > TOP_R + 0.02) continue;
        let nx = a.x - t.x, ny = a.y - t.y;
        const l = Math.hypot(nx, ny) || 1;
        a.x += (nx / l) * 0.03; a.y += (ny / l) * 0.03;
        moved = true;
      }
    }
    // keep every chair at its own table (radius 0.46..0.8) and within MAX_SHIFT of its plan spot
    for (const c of chairs) {
      let dx = c.x - c.t.x, dy = c.y - c.t.y;
      const r = Math.hypot(dx, dy) || 1, rr = Math.max(0.46, Math.min(0.8, r));
      c.x = c.t.x + (dx / r) * rr; c.y = c.t.y + (dy / r) * rr;
      dx = c.x - c.x0; dy = c.y - c.y0;
      const m = Math.hypot(dx, dy);
      if (m > MAX_SHIFT) { c.x = c.x0 + (dx / m) * MAX_SHIFT; c.y = c.y0 + (dy / m) * MAX_SHIFT; }
      face(c);
    }
    if (!moved) break;
  }
  const chairRects = chairs.map((c) => chairRect(c, foot));

  // ---------------------------------------------------------------- 2. umbrellas
  const tBase = BASE_R[baseType] ?? 0.3;
  const usedTable = new Set();
  /** Clearance of a base candidate (or -1): footprint vs chairs and table feet, pole vs table tops. */
  const baseClear = (x, y, kind, yaw) => {
    let clear = 9;
    const shape = kind === 'disc' ? null : rect(x, y, yaw, BASE_HALF, BASE_HALF);
    for (const t of tables) {
      const dc = Math.hypot(t.x - x, t.y - y);
      if (dc > 1.6) continue;
      clear = Math.min(clear, dc - TOP_R - 0.05); // the pole (with its runner) must clear the top
      const db = shape ? rectDist(shape, t.x, t.y) - tBase : dc - DISC_R - tBase;
      clear = Math.min(clear, db);
    }
    for (const r of chairRects) {
      if (Math.abs(r.x - x) > 1.2 || Math.abs(r.y - y) > 1.2) continue;
      if (shape) { if (rectsOverlap(shape, r, GAP)) return -1; } else clear = Math.min(clear, rectDist(r, x, y) - DISC_R);
    }
    return clear;
  };
  // canopy keep-outs: the facade line and the crowns of the street trees on this side
  const crowns = [];
  if (layout) {
    const c0 = layout.chunkIndex(cafe.s0 - 6), c1 = layout.chunkIndex(cafe.s1 + 6);
    for (let c = c0; c <= c1; c++) {
      for (const t of layout.inChunk('trees', c)) if (t.side === cafe.side) crowns.push({ x: X(t.s), y: t.d, r: (t.crown || 3) * 0.5 * CROWN_K });
    }
  }
  const canopyFree = (x, y, half) => {
    if (layout) {
      const hw = Math.min(layout.halfWidth(S(x - half), cafe.side), layout.halfWidth(S(x), cafe.side), layout.halfWidth(S(x + half), cafe.side));
      if (Math.abs(y) + half > hw - FACADE_GAP) return false;
    }
    for (const c of crowns) {
      const ex = Math.max(0, Math.abs(c.x - x) - half), ey = Math.max(0, Math.abs(c.y - y) - half);
      if (ex * ex + ey * ey < c.r * c.r) return false;
    }
    return true;
  };
  const src = [...cafe.umbrellas].map((u, i) => ({ u, i, x: X(u.s) })).sort((a, b) => a.x - b.x);
  const xMin = X(cafe.s0) - 0.4, xMax = X(cafe.s1) + 0.4;  // canopy may overhang the terrace a little
  const placed = [];
  const mixed = rng.chance(0.12);
  for (let n = 0; n < src.length; n++) {
    const { u, i } = src[n];
    const prev = placed[placed.length - 1];
    const next = src[n + 1];
    let best = null;
    for (let sz = Math.min(UMB_SIZES[1], 2 * Math.round(u.size * 5)); sz >= UMB_SIZES[0] && !best; sz -= 2) {
      const half = sz / 20 + VALANCE;
      let lo = Math.max(xMin + half, prev ? prev.x + prev.half + half + CANOPY_GAP : -1e9);
      let hi = Math.min(xMax - half, next ? next.x - (next.u.size / 2 + VALANCE) - half - CANOPY_GAP + 0.6 : 1e9);
      if (hi < lo) continue;
      const x0 = Math.max(lo, Math.min(hi, src[n].x));
      // free-standing base: scan outwards from the planned spot
      const cands = [];
      for (let k2 = 0; k2 <= 40; k2++) {
        const dx = (k2 % 2 ? 1 : -1) * Math.ceil(k2 / 2) * 0.05;
        const x = x0 + dx;
        if (x < lo - 1e-6 || x > hi + 1e-6) continue;
        for (const dy of [0, 0.12, -0.12, 0.25, -0.25]) cands.push([x, u.d + dy, Math.abs(dx) + Math.abs(dy) * 1.5]);
      }
      cands.sort((a, b) => a[2] - b[2]);
      for (const [x, y] of cands) {
        if (!canopyFree(x, y, half)) continue;
        for (const [kind, yaw] of [['slab', 0], ['slab', Math.PI / 4], ['disc', 0]]) {
          if (baseClear(x, y, kind, yaw) >= GAP) { best = { x, y, sz, half, base: kind, baseYaw: yaw }; break; }
        }
        if (best) break;
      }
      if (best) break;
      // pole through the centre hole of a table inside the allowed range
      let bt = null, bd = 9;
      for (const t of tables) {
        if (usedTable.has(t) || t.x < lo || t.x > hi || Math.abs(t.y - u.d) > 0.9 || !canopyFree(t.x, t.y, half)) continue;
        const dd = Math.abs(t.x - x0) + Math.abs(t.y - u.d);
        if (dd < bd) { bd = dd; bt = t; }
      }
      if (bt) { usedTable.add(bt); best = { x: bt.x, y: bt.y, sz, half, base: 'table', table: bt.ti }; }
    }
    if (!best) continue; // nothing fits: this part of the terrace stays open to the sky
    const r2 = RNG.from(seed, 'umb', cafe.id, i);
    best.u = u;
    best.color = mixed ? u.color : cafe.umbrellas[0].color;
    best.tint = r2.range(0.96, 1.02);
    best.furled = r2.chance(0.07);
    best.yaw = r2.range(-0.012, 0.012);
    placed.push(best);
  }

  // ---------------------------------------------------------------- 3. menu board
  let menu = null;
  {
    const cand = [];
    const side = cafe.side, dEdge = cafe.dIn + side * 0.3, dm = (cafe.dIn + cafe.dOut) / 2;
    for (let q = 0; q < 10; q++) cand.push([xMin + 0.7 + (xMax - xMin - 1.4) * (q / 9), dEdge]);
    cand.push([X(cafe.s0) + 0.25, dm], [X(cafe.s1) - 0.25, dm]);
    let bestC = 0.12;
    for (const [x, y] of cand) {
      let clear = 9;
      const mr = rect(x, y, 0, 0.32, 0.3);
      for (const t of tables) clear = Math.min(clear, rectDist(mr, t.x, t.y) - TOP_R);
      for (const r of chairRects) if (rectsOverlap(mr, r, GAP)) clear = -1;
      for (const p of placed) {
        clear = Math.min(clear, Math.hypot(p.x - x, p.y - y) - 0.55);
      }
      if (clear > bestC) { bestC = clear; menu = { x, y }; }
    }
    if (menu && rng.chance(0.8)) menu = { s: S(menu.x), d: menu.y, yaw: rng.range(-0.35, 0.35), v: rng.int(0, 1) };
    else menu = null;
  }

  return {
    k,
    foot,
    chairs: chairs.map((c) => ({ ti: c.t.ti, ci: c.ci, s: S(c.x), d: c.y, yaw: c.yaw, moved: Math.hypot(c.x - c.x0, c.y - c.y0) })),
    umbrellas: placed.map((p) => ({ s: S(p.x), d: p.y, size: p.sz / 10, sz: p.sz, base: p.base, baseYaw: p.baseYaw || 0, table: p.table ?? -1,
      color: p.color, tint: p.tint, furled: p.furled, yaw: p.yaw })),
    menu,
    stats: { chairs, chairRects, tables, placed, dropped: src.length - placed.length, X },
  };
}

/** Diagnostics over all plans: overlapping canopies, base / chair clashes, close chairs. */
export function auditPlans(plans, route) {
  let canopy = 0, base = 0, chairPairs = 0, minChair = 9, dropped = 0, throughTable = 0;
  const close = [];
  const all = [];
  for (const { cafe, plan } of plans) {
    dropped += plan.stats.dropped;
    for (const u of plan.umbrellas) { all.push({ cafe, u }); if (u.base === 'table') throughTable++; }
    const { chairs, chairRects, placed } = plan.stats;
    for (let i = 0; i < chairs.length; i++) for (let j = i + 1; j < chairs.length; j++) {
      const dd = Math.hypot(chairs[i].x - chairs[j].x, chairs[i].y - chairs[j].y);
      minChair = Math.min(minChair, dd);
      if (dd < 0.45) { chairPairs++; close.push([cafe.id, chairs[i].t.ti, chairs[i].ci, chairs[j].t.ti, chairs[j].ci, +dd.toFixed(3)]); }
    }
    for (const p of placed) {
      if (p.base === 'table') continue;
      const shape = p.base === 'disc' ? null : rect(p.x, p.y, p.baseYaw, BASE_HALF, BASE_HALF);
      for (const r of chairRects) {
        if (shape ? rectsOverlap(shape, r, 0) : rectDist(r, p.x, p.y) < DISC_R) { base++; break; }
      }
    }
  }
  // canopies on the same side, in metres along the street (all cafés, so neighbours count)
  all.sort((a, b) => a.u.s - b.u.s);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const ds = route.delta(a.u.s, b.u.s) * route.offsetScale(a.u.s + route.delta(a.u.s, b.u.s) / 2, (a.u.d + b.u.d) / 2);
      if (ds > 4) break;
      if (a.cafe.side !== b.cafe.side || a.u.furled || b.u.furled) continue;
      const lim = (a.u.size + b.u.size) / 2 + 2 * VALANCE;
      if (Math.abs(ds) < lim && Math.abs(a.u.d - b.u.d) < lim) canopy++;
    }
  }
  return { umbrellas: all.length, canopyOverlaps: canopy, baseClashes: base, chairPairsUnder45: chairPairs, minChairDist: +minChair.toFixed(3), dropped, throughTable, close: close.slice(0, 8) };
}
