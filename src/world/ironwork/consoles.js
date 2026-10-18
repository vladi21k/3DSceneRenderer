import { RNG } from '../../core/rng.js';
import { archPoint, ornament } from '../facadePlan.js';

// Where the carved stone consoles under a balcony slab go. Every slab sits on consoles
// (two at least): at its ends, on the bay boundaries it spans and in between, no more
// than MAX_SP apart along long balconies. Each one keeps clear of the masonry dressing
// of the openings on the floor below, exactly as the buildings module draws it
// (buildings/openings.js: arch rings, flat arches, lintels, keystones, hoods, door
// portals), by moving to the nearest pier or, where the dressing reaches close under
// the slab, by stopping on top of it. One balcony's consoles share one design and
// height: full scroll consoles where there is room, shortened stepped ones, or rows of
// short block consoles (modillions) over the shop heads.
// Open shutter leaves need no clearance: facades folds any leaf that would reach into
// the band under a balcony where consoles may hang (place.js wallObstacles).
// Facade-local coordinates (see facadePlan): u along the wall, v up.

/** Console kinds (geometry variants in stone.js). */
export const CONSOLE = { SCROLL: 0, TIERED: 1, BLOCK: 2 };

const STEP = 0.03;     // search grid (m)
const MARGIN = 0.02;   // free space kept around the dressing
const MAX_SP = 1.6;    // largest spacing of full consoles along a slab
const BLOCK_SP = 1.05; // ... of short block consoles
const H_MIN = 0.1;     // shortest console: below it a spot is not used
const H_TIERED = 0.34; // shortest stepped console (shorter: block consoles)
const MERGE = 0.7;     // consoles closer than this become one

const _ap = {};
const ornCache = new WeakMap();
/** The masonry choices of a plan: the draws the buildings module makes (facadePlan
 *  ornament() on the lot's 'shell' stream). */
function ornOf(plan) {
  let o = ornCache.get(plan);
  if (!o) ornCache.set(plan, (o = ornament(plan, RNG.from(plan.seed, 'shell'))));
  return o;
}

/** Dressing over an opening's head on floor f: the highest point of the masonry at any
 *  u, as {u0, u1, flat, jamb, arc} (arc: [u, v, ...] left to right, or null). */
function headProfile(plan, orn, o) {
  const ground = o.floor === 0, door = o.kind === 'door', arched = o.rise > 0.01;
  const yt = o.y + o.h;
  const surround = ground ? (door && orn.doorSurround ? orn.sw * 1.3 : 0) : (plan.style.surrounds ? orn.sw : 0);
  if (ground && door && orn.doorHood) {
    // entrance portal: a hood cornice on two tall consoles either side of the head
    const reach = 0.8;
    return { u0: o.uc - o.w / 2 - reach, u1: o.uc + o.w / 2 + reach, flat: yt + (arched ? 1.06 : 0.72), jamb: 0, arc: null };
  }
  if (arched) {
    // voussoir ring (T deep, radially) with a keystone 8 cm deeper at the crown
    const T = (ground ? orn.shopRing : surround ? surround * 1.3 : orn.ring) + MARGIN;
    const key = ground || orn.keystone;
    const a = [];
    for (let i = 0; i <= 20; i++) {
      archPoint(o, i / 20, _ap, T);
      a.push(_ap.u, _ap.v + (key && Math.abs(_ap.u - o.uc) < 0.24 ? 0.1 : 0));
    }
    if (a[0] > a[a.length - 2]) {
      for (let i = 0, j = a.length - 2; i < j; i += 2, j -= 2) {
        [a[i], a[j]] = [a[j], a[i]]; [a[i + 1], a[j + 1]] = [a[j + 1], a[i + 1]];
      }
    }
    return { u0: o.uc - o.w / 2 - T, u1: o.uc + o.w / 2 + T, flat: -Infinity, jamb: o.spring + 0.06, arc: a };
  }
  // flat head: lintel, flat arch (voussoirs fanning 6 cm past its ends) or lintel + hood
  const kind = ground ? orn.shopHead : orn.winHead;
  const ext = surround || (ground ? 0.2 : 0.12);
  const H = ground ? (kind === 'flatArch' ? 0.42 : 0.38) : Math.min(0.45, Math.max(0.26, plan.coursing.ch));
  let reach = ext + (kind === 'flatArch' ? 0.06 : kind === 'hood' ? 0.07 : 0) + MARGIN;
  // crossettes: the architrave steps out 8 cm just below the head (windows)
  if (!ground && orn.ears && surround) reach = Math.max(reach, surround + 0.08 + MARGIN);
  const top = kind === 'hood' ? H + 0.22 : H + (kind === 'flatArch' ? 0.06 : orn.keystone && kind !== 'plain' ? 0.05 : 0);
  return { u0: o.uc - o.w / 2 - reach, u1: o.uc + o.w / 2 + reach, flat: yt + top + MARGIN, jamb: 0, arc: null };
}

/** Highest point of an opening's dressing at facade position u (−Infinity if clear).
 *  `seg` ({i}) is a cursor into the arc for calls with increasing u. */
function headTopAt(hp, u, seg) {
  if (u < hp.u0 || u > hp.u1) return -Infinity;
  const a = hp.arc;
  if (!a) return hp.flat;
  const n = a.length;
  if (u <= a[0]) return Math.max(hp.jamb, a[1]);
  if (u >= a[n - 2]) return Math.max(hp.jamb, a[n - 1]);
  let i = seg.i;
  while (i < n - 4 && u > a[i + 2]) i += 2;
  seg.i = i;
  const ua = a[i], ub = a[i + 2];
  return Math.max(hp.jamb, a[i + 1] + (a[i + 3] - a[i + 1]) * ((u - ua) / ((ub - ua) || 1)));
}

const planHeads = new WeakMap();
/** Head dressing of the openings on floor f of a plan (cached per plan and floor). */
function headsOn(plan, f) {
  let h = planHeads.get(plan);
  if (!h) planHeads.set(plan, (h = []));
  if (!h[f]) {
    const orn = ornOf(plan);
    h[f] = plan.openings.filter((o) => o.floor === f).map((o) => headProfile(plan, orn, o));
  }
  return h[f];
}

/** Dressing height under a console footprint (half-width W2 + margin) on the grid
 *  lo + i·STEP, i < N: each head over its own span, then a sliding maximum. */
function dressingField(heads, lo, N, W2) {
  const top = new Float32Array(N).fill(-1e9);
  if (!heads.length) return top;
  const K = Math.ceil((W2 + MARGIN) / STEP), M = N + 2 * K, u0 = lo - K * STEP;
  const raw = new Float32Array(M).fill(-1e9), seg = { i: 0 };
  for (const hp of heads) {
    seg.i = 0;
    const j0 = Math.max(0, Math.ceil((hp.u0 - u0) / STEP)), j1 = Math.min(M - 1, Math.floor((hp.u1 - u0) / STEP));
    for (let j = j0; j <= j1; j++) { const h = headTopAt(hp, u0 + j * STEP, seg); if (h > raw[j]) raw[j] = h; }
  }
  // sliding maximum over 2K + 1 cells (monotone deque)
  const q = new Int32Array(M);
  let qh = 0, qt = 0;
  for (let j = 0; j < M; j++) {
    while (qt > qh && raw[q[qt - 1]] <= raw[j]) qt--;
    q[qt++] = j;
    const i = j - 2 * K;
    if (i < 0) continue;
    if (q[qh] < i) qh++;
    top[i] = raw[q[qh]];
  }
  return top;
}

/** Ideal console positions along [a, b]: both ends, the bay boundaries in between, and
 *  even subdivisions of what lies between them, at most `sp` apart. */
function idealPositions(plan, a, b, sp, short) {
  const anchors = [a];
  if (!short) for (const bay of plan.bays) if (bay.index > 0 && bay.u0 > a + 0.6 && bay.u0 < b - 0.6) anchors.push(bay.u0);
  anchors.push(b);
  const out = [a];
  for (let k = 1; k < anchors.length; k++) {
    const x0 = anchors[k - 1], x1 = anchors[k];
    const n = short ? 1 : Math.max(1, Math.ceil((x1 - x0) / sp - 1e-6));
    for (let i = 1; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
  }
  return out;
}

/** For each ideal position, the nearest spot (within its share of the slab) where a
 *  console of height `want` fits, else the spot with the most room: [{u, room}]. */
function settle(ideal, top, lo, N, soffit, want) {
  const out = [];
  const spots = ideal.map((ud, k) => {
    const gap = Math.min(ud - (ideal[k - 1] ?? -1e9), (ideal[k + 1] ?? 1e9) - ud);
    return { ud, shift: Math.min(0.5, Math.max(0.12, gap * 0.32)) };
  });
  for (const { ud, shift } of spots) {
    const id = Math.round((Math.min(lo + (N - 1) * STEP, Math.max(lo, ud)) - lo) / STEP);
    const room = (i) => soffit - top[i];
    let best = -1, bestRoom = -Infinity;
    for (let d = 0; d * STEP <= shift; d++) {
      for (const i of d ? [id - d, id + d] : [id]) {
        if (i < 0 || i >= N) continue;
        const r = room(i);
        if (r >= want) { best = i; bestRoom = r; break; }
        if (r > bestRoom + 0.01) { best = i; bestRoom = r; }
      }
      if (bestRoom >= want) break;
    }
    if (best >= 0) out.push({ u: lo + best * STEP, room: bestRoom });
  }
  return out;
}

/** Consoles too close to each other merge (the one with more room stays). */
function spaced(list, minGap) {
  const out = [];
  for (const c of list) {
    const p = out[out.length - 1];
    if (p && c.u - p.u < minGap) { if (c.room > p.room) out[out.length - 1] = c; continue; }
    out.push(c);
  }
  return out;
}

const cache = new WeakMap(); // balcony -> placement (plans are cached)

/**
 * The consoles under balcony `bal` of `plan`. opts: {Hc (full height), W2 (half-width),
 * rc (rounded slab corners), kind (the building's full console: SCROLL or TIERED),
 * foot (what the full kind hangs below its height: the scroll's pendant knob)}.
 * → {kind, h, u: [...]} (h: console height below the soffit).
 */
export function balconyConsoles(plan, bal, opts) {
  let out = cache.get(bal);
  if (!out) cache.set(bal, (out = place(plan, bal, opts)));
  return out;
}

function place(plan, bal, { Hc, W2, rc, kind, foot }) {
  const soffit = bal.y - bal.slabT, len = bal.u1 - bal.u0;
  const e0 = W2 + Math.max(0.05, rc * 0.8), none = { kind, h: Hc, u: [] };
  if (len <= 2 * e0) return none;
  // the grid is centred on the slab, so a slab centred over an opening gets a mirrored
  // pair of consoles
  const N = Math.floor((len - 2 * e0) / STEP) + 1, lo = (bal.u0 + bal.u1) / 2 - ((N - 1) * STEP) / 2, hi = lo + (N - 1) * STEP;
  const heads = bal.floor > 0 ? headsOn(plan, bal.floor - 1).filter((hp) => hp.u1 > bal.u0 - 0.5 && hp.u0 < bal.u1 + 0.5) : [];
  const top = dressingField(heads, lo, N, W2);
  const short = len <= 2.8;
  const end = Math.min(Math.max(0.08, len * 0.06), 0.22);
  const a = Math.max(lo, bal.u0 + W2 + end + rc * 0.6), b = Math.min(hi, bal.u1 - W2 - end - rc * 0.6);
  const full = Hc + foot, minGap = Math.max(W2 * 2 + 0.16, MERGE);

  // full consoles on the piers: at both ends and either side of every opening's
  // dressing below, the piers between filled in evenly
  if (!short && b > a) {
    const u = flanking(top, lo, N, soffit - full, a, b, minGap);
    if (u) return { kind, h: Hc, u };
  }

  // an even rhythm (ends, bay boundaries, subdivisions), each console on the nearest
  // spot with room; one height for all, so the design follows the tightest spot
  const pick = (sp) => {
    const ideal = b > a ? idealPositions(plan, a, b, sp, short) : [(a + b) / 2];
    const at = settle(ideal, top, lo, N, soffit, full).sort((p, q) => p.u - q.u);
    const c = spaced(at, minGap).filter((x) => x.room >= H_MIN);
    // a console far shorter than the others is left out where its neighbours still
    // carry the slab (a door portal or an arch crown under one end of a long run)
    if (c.length > 2) {
      const rooms = c.map((x) => Math.min(x.room, full)).sort((p, q) => p - q);
      const med = rooms[rooms.length >> 1];
      for (let i = c.length - 2; i > 0; i--) {
        if (Math.min(c[i].room, full) >= med * 0.6) continue;
        if (c[i + 1].u - c[i - 1].u <= sp * 1.45) c.splice(i, 1);
      }
    }
    return c;
  };

  let cons = pick(MAX_SP);
  // a lone console would carry one end only: the slab rests on the dressing instead
  if (cons.length < 2) return none;
  let room = Math.min(...cons.map((x) => x.room));
  if (room >= Hc * 0.85 + foot) {
    return { kind, h: Math.min(Hc, room - foot), u: cons.map((x) => x.u) };
  }
  if (room >= H_TIERED) {
    return { kind: CONSOLE.TIERED, h: Math.min(Hc, room), u: cons.map((x) => x.u) };
  }
  // block consoles: closer together along long runs
  if (!short) {
    const dense = pick(BLOCK_SP);
    if (dense.length >= 2) { cons = dense; room = Math.min(...cons.map((x) => x.room)); }
  }
  return { kind: CONSOLE.BLOCK, h: Math.min(0.3, Math.max(H_MIN, room)), u: cons.map((x) => x.u) };
}

/** Pier positions for full consoles along [a, b] (grid lo + i·STEP; a spot is clear
 *  where the dressing stays below `clearTop`), or null where an end has no pier near it
 *  or an opening below spans more than OPEN_SP. */
const OPEN_SP = 2.6;
function flanking(top, lo, N, clearTop, a, b, minGap) {
  const clear = (i) => top[i] <= clearTop;
  const idx = (u) => Math.max(0, Math.min(N - 1, Math.round((u - lo) / STEP)));
  const near = (i0, dir) => {
    for (let d = 0; d * STEP <= 0.3; d++) for (const i of [i0 + d * dir, i0 - d * dir]) if (i >= 0 && i < N && clear(i)) return i;
    return -1;
  };
  const s = near(idx(a), 1), e = near(idx(b), -1);
  if (s < 0 || e < 0 || (e - s) * STEP < minGap) return null;
  // the ends and the clear spots either side of each run of dressing between them
  let pts = [s];
  for (let i = s; i < e;) {
    while (i < e && clear(i)) i++;
    if (i >= e) break;
    pts.push(i - 1);
    while (i < e && !clear(i)) i++;
    pts.push(i);
  }
  pts.push(e);
  // spots on one pier closer than a console pair merge into one at the pier centre
  const g = Math.ceil(minGap / STEP);
  for (let merged = true; merged;) {
    merged = false;
    for (let k = 0; k < pts.length - 1; k++) {
      if (pts[k + 1] - pts[k] >= g) continue;
      const m = k === 0 ? pts[0] : k + 1 === pts.length - 1 ? pts[k + 1] : Math.round((pts[k] + pts[k + 1]) / 2);
      if (!clear(m)) continue;
      pts.splice(k, 2, m);
      merged = true;
      break;
    }
  }
  // fill the piers; an opening is spanned by the slab alone
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    out.push(lo + pts[k] * STEP);
    if (k + 1 === pts.length) break;
    const p = pts[k], q = pts[k + 1], span = (q - p) * STEP;
    let free = true;
    for (let i = p; i <= q && free; i++) free = clear(i);
    if (!free) {
      if (span > OPEN_SP) return null;
      continue;
    }
    const n = Math.ceil(span / MAX_SP - 1e-6);
    for (let j = 1; j < n; j++) out.push(lo + (p + ((q - p) * j) / n) * STEP);
  }
  return out;
}
