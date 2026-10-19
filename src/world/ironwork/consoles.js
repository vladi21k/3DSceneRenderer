import { RNG } from '../../core/rng.js';
import { archPoint, ornament, headDressing } from '../facadePlan.js';

// Where the carved stone consoles under a balcony slab go. Every slab sits on consoles
// (two at least) unless the dressing below reaches up to the slab itself. Full consoles
// stand on the piers: at the slab's ends, either side of each opening below and about
// MAX_SP apart along wide piers. Where the piers do not carry the slab, consoles keep an
// even rhythm (ends, bay boundaries, subdivisions) and stop on top of the dressing.
// The dressing is the envelope the plan publishes for what the buildings module draws
// (facadePlan headDressing: arch rings, flat arches, lintels, keystones, hoods, door
// portals), with the ring of an arched head followed along its curve, plus the shop
// signs facades hangs under first-floor balconies. One balcony's consoles share one
// design and height: full scroll or stepped consoles where there is room, shortened
// stepped ones, or rows of short block consoles (modillions) over the shop heads.
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
const PORTAL_SP = 4.5; // longest span of a slab resting on a portal hood instead

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
 *  u, as {u0, u1, flat, jamb, arc} (arc: [u, v, ...] left to right, or null), MARGIN
 *  clear of the plan's envelope (facadePlan headDressing, the extent and top the shell
 *  draws). Flat heads and door portals are their envelope; an arched head follows its
 *  ring (as thick as the envelope reaches past the jambs) round the arch, the keystone
 *  (what the envelope's top adds over the ring's crown) standing on the crown. */
function headProfile(plan, orn, o) {
  const d = headDressing(plan, orn, o);
  const arched = o.top !== 'flat' && o.rise > 0.01;   // (as headDressing decides)
  const portal = o.floor === 0 && o.kind === 'door' && orn.doorHood;
  if (!arched || portal) return { u0: d.u0 - MARGIN, u1: d.u1 + MARGIN, flat: d.top + MARGIN, jamb: 0, arc: null };
  const T = Math.max(0, d.u1 - (o.uc + o.w / 2));
  archPoint(o, 0.5, _ap, T);
  const key = Math.max(0, d.top - _ap.v);
  // the keystone's span of the head parameter, where the plan gives it (d.keyT), else
  // about half a metre round the crown
  const kt = d.keyT;
  const a = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    archPoint(o, t, _ap, T + MARGIN);
    const onKey = kt ? t >= kt[0] - 0.025 && t <= kt[1] + 0.025 : Math.abs(_ap.u - o.uc) < 0.24;
    a.push(_ap.u, _ap.v + (key > 0.005 && onKey ? key : 0));
  }
  if (a[0] > a[a.length - 2]) {
    for (let i = 0, j = a.length - 2; i < j; i += 2, j -= 2) {
      [a[i], a[j]] = [a[j], a[i]]; [a[i + 1], a[j + 1]] = [a[j + 1], a[i + 1]];
    }
  }
  return { u0: d.u0 - MARGIN, u1: d.u1 + MARGIN, flat: -Infinity, jamb: o.spring + 0.06, arc: a };
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

/** Shop signs on the wall under a first-floor balcony, as facades hangs them (place.js:
 *  fascia boards and their lamps stop 0.62 m under the soffit, projecting blade signs
 *  0.55 m under it), in the form of head dressing. */
function signsUnder(plan, bal, soffit) {
  const out = [];
  for (const s of plan.signs || []) {
    if (s.kind === 'fascia' && s.u1 > bal.u0 - 0.2 && s.u0 < bal.u1 + 0.2) {
      out.push({ u0: s.u0 - 0.05, u1: s.u1 + 0.05, flat: soffit - 0.6, jamb: 0, arc: null });
    } else if (s.kind === 'blade' && s.u > bal.u0 - 0.9 && s.u < bal.u1 + 0.9) {
      out.push({ u0: s.u - 0.08, u1: s.u + 0.08, flat: soffit - 0.53, jamb: 0, arc: null });
    }
  }
  return out;
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
 * → {kind, h, u: [...], w2?} (h: console height below the soffit; w2: the half-width of
 * slimmer consoles where the building's own found no room, see slimEnds).
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
  if (bal.floor === 1) heads.push(...signsUnder(plan, bal, soffit));
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
    // carry the slab (a door portal or an arch crown under one end of a long run).
    // Where the dressing comes up within a stepped console's height of the soffit (a
    // portal hood), the slab rests on it: that spot keeps no console, at the slab's
    // ends too, as long as the slab spans at most PORTAL_SP there (else one spot
    // would turn the whole run into modillions)
    if (c.length > 2) {
      const rooms = c.map((x) => Math.min(x.room, full)).sort((p, q) => p - q);
      const med = rooms[rooms.length >> 1];
      for (let i = c.length - 1; i >= 0 && c.length > 2; i--) {
        const r = Math.min(c[i].room, full);
        if (r >= med * 0.6) continue;
        const end = i === 0 || i === c.length - 1;
        const span = i === 0 ? c[1].u - bal.u0 : i === c.length - 1 ? bal.u1 - c[i - 1].u : c[i + 1].u - c[i - 1].u;
        if (r < H_TIERED && med >= H_TIERED ? span <= PORTAL_SP : !end && span <= sp * 1.45) c.splice(i, 1);
      }
    }
    return c;
  };

  let cons = pick(MAX_SP);
  // a lone console would carry one end only: the slab rests on the dressing instead,
  // unless slimmer consoles find room nearer its ends (stone-era fronts)
  if (cons.length < 2) return (plan.style.era !== 'modern' && slimEnds(bal, heads, soffit, rc, W2, Hc, kind, foot)) || none;
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

/** Fallback for a slab whose dressing below leaves no room for the building's consoles
 *  where they normally stand (a wide head under the middle of the slab, its ends within
 *  half a metre of the slab's, or a rounded slab whose consoles keep inside the curve):
 *  slimmer consoles (`w2` half-width, down to 13 cm wide) as near each end as the slab's
 *  plan allows (inside its rounded corners), on the first spot inward with room, plus
 *  any clear spots between them about BLOCK_SP apart. Full or stepped where there is
 *  room for them, else short blocks; null if an end finds no spot. */
function slimEnds(bal, heads, soffit, rc, W2, Hc, kind, foot) {
  const w2a = Math.max(0.065, Math.min(0.1, W2 * 0.75));
  return slimAt(bal, heads, soffit, rc, w2a, Hc, kind, foot) || (w2a > 0.07 ? slimAt(bal, heads, soffit, rc, 0.065, Hc, kind, foot) : null);
}

function slimAt(bal, heads, soffit, rc, w2, Hc, kind, foot) {
  const len = bal.u1 - bal.u0;
  // a console of the slab's depth (its front 7 cm in from the edge) stays 1.5 cm inside
  // a rounded corner from this far in
  const inset = rc > 0.05 ? rc - Math.sqrt(Math.max(0, 0.11 * rc - 0.003)) : 0.02;
  const e = w2 + Math.max(0.02, inset);
  if (len < 2 * e + 0.6) return null;
  const N = Math.floor((len - 2 * e) / STEP) + 1, lo = bal.u0 + e;
  const top = dressingField(heads, lo, N, w2);
  const room = (i) => soffit - top[i];
  const reach = Math.round(0.4 / STEP);
  const find = (i0, dir) => {
    for (let d = 0; d <= reach; d++) { const i = i0 + d * dir; if (i >= 0 && i < N && room(i) >= H_MIN - 0.005) return i; }
    return -1;
  };
  const s = find(0, 1), t = find(N - 1, -1);
  if (s < 0 || t < 0 || (t - s) * STEP < 0.6) return null;
  const idx = [s];
  const n = Math.round(((t - s) * STEP) / BLOCK_SP);
  for (let k = 1; k < n; k++) {
    const i = Math.round(s + ((t - s) * k) / n);
    if (room(i) >= H_MIN - 0.005) idx.push(i);
  }
  idx.push(t);
  const r = Math.min(...idx.map(room));
  const u = idx.map((i) => lo + i * STEP);
  if (r >= Hc * 0.85 + foot) return { kind, h: Math.min(Hc, r - foot), u, w2 };
  if (r >= H_TIERED) return { kind: CONSOLE.TIERED, h: Math.min(Hc, r), u, w2 };
  return { kind: CONSOLE.BLOCK, h: Math.min(0.3, r), u, w2 };
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
    // (a pier a little wider than MAX_SP keeps its pair: three in a bunch read badly)
    const n = span > MAX_SP * 1.25 ? Math.ceil(span / MAX_SP - 1e-6) : 1;
    for (let j = 1; j < n; j++) out.push(lo + (p + ((q - p) * j) / n) * STEP);
  }
  return out;
}
