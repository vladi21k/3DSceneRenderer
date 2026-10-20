import { RNG, hash2 } from '../../core/rng.js';
import { CHUNK_LEN } from '../../core/config.js';
import { IRON_REGIONS, stainUV } from './textures.js';
import { MAIN_RAILS, CORRIDOR, GUTTER_W, GUTTER_OUT, TRACK_OFFSET, BAND_IN } from './constants.js';
import { colInfo, Z_CORR } from './surface.js';
import { pavingHeight } from './paving.js';
import { facadePlan } from '../facadePlan.js';
import { planWear, STEP_WALK_U, STEP_WALK_X, STEP_STREET_U } from './wear.js';
import { PATCH_PAD, STEP_PAD, repairWear } from './lines.js';

// Street details per chunk, planned deterministically from the chunk index so the
// surface can flatten the paving under covers before it is built:
//   cast-iron covers (round manholes, chequer plates, valve caps), gully grates in the
//   gutters, slotted drain covers between the rails, tree grates around every tree,
//   stains / gum spots / drip trails, soil rings and leaf litter round the tree grates,
//   trodden-in dirt under café tables and at benches, fallen leaves, and transverse
//   expansion joints; and the wear placed on the paving (wear.js: relaid setts, asphalt
//   and concrete repairs, halos round the covers, oil under the trams at the stops, weeds).

const ATLAS = 1024;
const SIZES = {
  manhole: [0.8, 0.8], treeGrate: [1.24, 1.24], gully: [0.62, 0.31], drain: [1.0, 0.5],
  plate: [0.6, 0.6], plate2: [1.0, 0.5], valve: [0.32, 0.32],
};
const ROUND = { manhole: 1, valve: 1 };
const COVER_LIFT = 0.003;      // covers stand this proud of their (planar) bed
const REPAIR_LIFT = 0.0025;    // repair ribbons above the paving (they also have a polygon offset)
const SETT_COURSE = 0.2;       // paving.street courses run across the street every 0.2 m of u
const JOINT_HALF = 0.007;      // sealant-filled expansion joint: 14 mm wide
const TREE_RING_SIZE = 3.0;    // soil ring decal round a 1.24 m tree grate (stain kind 4)
// chance of a gum / dirt spot by street furniture where people linger
const LINGER = { bench: 0.9, bin: 0.8, shelter: 0.9, ticketMachine: 0.8, stopSign: 0.6, kiosk: 0.8, infoBoard: 0.5, advertColumn: 0.4 };
const u01 = (a, b) => hash2(a | 0, b | 0) / 4294967296;

/** Deterministic plan for chunk ci: { items, spots, joints, stains, leaves, relays,
 *  repairs, weeds }. */
export function planDetails(ctx, ci) {
  const it = planSteps(ctx, ci);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** planDetails as a resumable sequence of short steps (it yields 'plan' between them;
 *  the result is the generator's return value), so the street's prefetch can plan ahead
 *  a slice per frame. The facade plans of the chunk's lots (shared with buildings and
 *  facades, cached there) are made one lot per step: the first plan of a lot can take a
 *  few milliseconds. */
export function* planSteps(ctx, ci) {
  const { layout, route } = ctx;
  for (const lot of layout.inChunk('lots', ci)) {
    facadePlan(lot);
    yield 'plan';
  }
  const L = route.length, delta = ctx.delta;
  const s0 = ci * CHUNK_LEN, s1 = Math.min(L, s0 + CHUNK_LEN);
  const rng = RNG.from(layout.seed, 'street-details', ci);
  const obstacles = layout.obstaclesNear((s0 + s1) / 2, CHUNK_LEN);
  const items = [];
  // obstacles bucketed by 2 m of s around the chunk (rects go to every bucket they span)
  const B0 = s0 - 4, NB = Math.ceil((s1 - s0 + 8) / 2);
  const buckets = Array.from({ length: NB }, () => []);
  const bi = (s) => Math.floor(delta(B0, s) / 2);
  for (const o of obstacles) {
    const a = o.kind === 'circle' ? o.s - o.r - 1.6 : o.s0 - 1.6, b = o.kind === 'circle' ? o.s + o.r + 1.6 : o.s1 + 1.6;
    const i0 = Math.max(0, bi(a)), i1 = Math.min(NB - 1, bi(b));
    for (let i = i0; i <= i1; i++) buckets[i].push(o);
  }

  const blocked = (s, d, r) => {
    const i = bi(s);
    for (const o of buckets[Math.max(0, Math.min(NB - 1, i))]) {
      if (o.kind === 'circle') {
        const ds = delta(o.s, s), dd = d - o.d;
        if (ds * ds + dd * dd < (r + o.r + 0.25) ** 2) return true;
      } else if (delta(o.s0 - r, s) > 0 && delta(o.s1 + r, s) < 0 && d > o.d0 - r && d < o.d1 + r) return true;
    }
    for (const it of items) {
      const ds = delta(it.s, s), dd = d - it.d;
      if (ds * ds + dd * dd < (r + it.r + 0.3) ** 2) return true;
    }
    if (layout.isInCrossover(s, 3) && Math.abs(d) < BAND_IN) return true;
    for (const c of layout.crossStreets) if (Math.abs(delta(c.s, s)) < 2.6 + r && Math.abs(d) < GUTTER_OUT + 0.8) return true;
    return false;
  };
  const inside = (s, r) => s - r > s0 + 0.6 && s + r < s1 - 0.6;
  const add = (type, s, d, yaw, extra = {}) => {
    const [w, h] = SIZES[type];
    const r = ROUND[type] ? w / 2 : Math.hypot(w, h) / 2;
    items.push({ type, s, d, yaw, r, ...extra });
  };

  // tree grates around every tree (cast iron, aligned with the street)
  for (const t of layout.inChunk('trees', ci)) items.push({ type: 'treeGrate', s: t.s, d: t.d, yaw: 0, r: 0.88, tree: true });

  yield 'plan';
  // gully grates in both gutters on a global ~18 m rhythm
  for (const side of [-1, 1]) {
    const k0 = Math.floor((s0 - 9) / 18), k1 = Math.ceil((s1 - 9) / 18);
    for (let k = k0; k <= k1; k++) {
      const s = 9 + 18 * k + (u01(k, side * 7 + 3) - 0.5) * 5;
      const d = side * (CORRIDOR + GUTTER_W / 2);
      if (!inside(s, 0.35) || layout.isInStation(s, 1) || blocked(s, d, 0.2)) continue;
      add('gully', s, d, 0, { r: 0.33 });
    }
  }

  // slotted drain cover in a four-foot now and then
  if (rng.chance(0.4)) {
    const s = rng.range(s0 + 2, s1 - 2), d = rng.chance(0.5) ? TRACK_OFFSET : -TRACK_OFFSET;
    if (!blocked(s, d, 0.6)) add('drain', s, d, Math.PI / 2);
  }

  // round manholes on the sidewalks (between the tracks the covers are the slotted
  // drains in the four-foot only)
  const nMan = rng.weighted([[0, 0.3], [1, 0.5], [2, 0.2]]);
  for (let i = 0; i < nMan; i++) {
    for (let tries = 0; tries < 6; tries++) {
      const s = rng.range(s0 + 1.2, s1 - 1.2);
      const side = rng.chance(0.5) ? 1 : -1;
      const hw = layout.halfWidth(s, side);
      const d = side * rng.range(GUTTER_OUT + 1.0, Math.max(GUTTER_OUT + 1.2, hw - 1.3));
      if (!blocked(s, d, 0.42)) { add('manhole', s, d, rng.range(0, Math.PI * 2)); break; }
    }
  }

  // utility plates and valve caps, mostly near the facades
  const nUt = rng.int(0, 3);
  for (let i = 0; i < nUt; i++) {
    const type = rng.weighted([['plate', 0.35], ['plate2', 0.25], ['valve', 0.4]]);
    for (let tries = 0; tries < 6; tries++) {
      const s = rng.range(s0 + 1.2, s1 - 1.2);
      const side = rng.chance(0.5) ? 1 : -1;
      const hw = layout.halfWidth(s, side);
      const d = side * (rng.chance(0.6) ? hw - rng.range(0.5, 1.6) : rng.range(GUTTER_OUT + 0.8, hw - 1.0));
      const r = type === 'valve' ? 0.17 : type === 'plate' ? 0.43 : 0.56;
      if (Math.abs(d) < GUTTER_OUT + 0.5 || blocked(s, d, r)) continue;
      add(type, s, d, rng.chance(0.5) ? 0 : Math.PI / 2, type === 'valve' ? { yaw: rng.range(0, 6.28) } : {});
      break;
    }
  }

  yield 'plan';
  // stains: dirt, gum and the odd oil spot on the sidewalks. (The tracks carry no single
  // stains away from the stops: their oil and brake dust is the continuous drip band,
  // street.js buildDripBands; the draws of a track stain are still made, so the sidewalk
  // stains keep their places.)
  const stains = [];
  const nSt = rng.int(3, 7);
  for (let i = 0; i < nSt; i++) {
    const s = rng.range(s0 + 0.5, s1 - 0.5);
    const kind = rng.weighted([[0, 0.4], [1, 0.25], [2, 0.2], [3, 0.15]]);
    let d;
    const track = kind === 3 || (kind === 1 && rng.chance(0.6));
    if (track) d = (rng.chance(0.5) ? 1 : -1) * (TRACK_OFFSET + rng.normal(0, 0.15));
    else {
      const side = rng.chance(0.5) ? 1 : -1;
      d = side * rng.range(GUTTER_OUT + 0.3, layout.halfWidth(s, side) - 0.4);
    }
    const size = kind === 3 ? rng.range(1.4, 2.6) : kind === 2 ? rng.range(0.8, 1.5) : rng.range(0.6, 1.8);
    const yaw = kind === 3 ? Math.PI / 2 + rng.normal(0, 0.05) : rng.range(0, Math.PI * 2);
    const aspect = kind === 3 ? 0.45 : rng.range(0.7, 1.2);
    if (!track) stains.push({ s, d, kind, size, yaw, aspect, op: 1, warm: kind === 1 ? 0 : 0.15 });
  }

  // where people linger the paving collects more: gum and dark spots around benches,
  // bins and stops, along café terraces, and trodden-in grime at shop doors and entrances
  const lg = RNG.from(layout.seed, 'street-linger', ci);
  const onWalk = (s, d) => s > s0 + 0.3 && s < s1 - 0.3 && Math.abs(d) > GUTTER_OUT + 0.25 && Math.abs(d) < layout.halfWidth(s, d < 0 ? -1 : 1) - 0.1;
  const stain = (s, d, kind, size, aspect, yaw, op = 1, warm = 0.15) => {
    if (onWalk(s, d)) stains.push({ s, d, kind, size, yaw, aspect, op, warm });
  };
  for (const f of layout.inChunk('furniture', ci)) {
    if (!LINGER[f.type] || !lg.chance(LINGER[f.type])) continue;
    const a = lg.range(0, Math.PI * 2), r = lg.range(0.5, 1.3);
    stain(f.s + Math.cos(a) * r, f.d + Math.sin(a) * r, lg.chance(0.7) ? 2 : 0, lg.range(0.7, 1.3), lg.range(0.7, 1.2), lg.range(0, 6.28));
  }
  for (const f of layout.inChunk('furniture', ci)) {
    // benches: the paving in front of them is trodden darker
    if (f.type !== 'bench') continue;
    const side = f.d < 0 ? -1 : 1;
    stain(f.s + lg.range(-0.2, 0.2), f.d - side * lg.range(0.3, 0.5), 5, lg.range(1.6, 2.2), lg.range(0.55, 0.75), lg.range(-0.15, 0.15), lg.range(0.8, 1.15), 0.3);
  }
  for (const c of layout.inChunk('cafes', ci)) {
    // mottled darkening under the tables and chairs (spills, crumbs, scraped chair legs),
    // here and there a cluster of spots
    for (const t of c.tables) {
      stain(t.s + lg.range(-0.15, 0.15), t.d + lg.range(-0.15, 0.15), 5, lg.range(1.5, 2.1), lg.range(0.8, 1.15), lg.range(0, 6.28), lg.range(0.8, 1.2), 0.3);
      if (lg.chance(0.35)) stain(t.s + lg.range(-0.5, 0.5), t.d + lg.range(-0.5, 0.5), 2, lg.range(0.5, 0.9), lg.range(0.7, 1.2), lg.range(0, 6.28), 0.8, 0.4);
    }
    const n = lg.int(1, 3);
    for (let i = 0; i < n; i++) {
      // mostly along the terrace's street-side edge, where waiters and passers-by walk
      const d = c.dOut + Math.sign(c.dOut) * lg.range(-0.6, 0.5);
      stain(lg.range(c.s0, c.s1), d, lg.chance(0.6) ? 2 : 0, lg.range(0.8, 1.6), lg.range(0.7, 1.2), lg.range(0, 6.28));
    }
  }
  yield 'plan';
  for (const lot of layout.inChunk('lots', ci)) {
    // the frame origin's route position, then step along the facade (u runs along it)
    const F = lot.frame;
    const o0 = route.project(F.origin.x, F.origin.z, (lot.s0 + lot.s1) / 2);
    if (!o0) continue;
    const smp = route.sample(o0.s, {});
    const k = F.uDir.x * smp.tanH.x + F.uDir.z * smp.tanH.z;
    for (const o of facadePlan(lot).openings) {
      if (o.floor !== 0 || !lg.chance(o.kind === 'door' ? 0.75 : 0.45)) continue;
      // a soft band of grime just outside the threshold, elongated along the facade
      const s = o0.s + k * o.uc;
      const d = lot.side * (layout.halfWidth(s, lot.side) - lg.range(0.35, 0.6));
      stain(s, d, 0, Math.min(1.8, o.w * lg.range(0.8, 1.1)), lg.range(0.45, 0.7), lg.range(-0.1, 0.1));
    }
  }

  // soil washed out of the tree pits and trodden round the grates (the grate covers the
  // middle of the decal: TREE_RING_SIZE is scaled to its 1.24 m frame)
  for (const t of layout.inChunk('trees', ci)) {
    const tr = RNG.from('tree-ring', t.seed);
    stains.push({ s: t.s, d: t.d, kind: 4, size: TREE_RING_SIZE, aspect: 1, yaw: 0, op: tr.range(1.15, 1.35), warm: tr.range(0.3, 0.5) });
  }

  yield 'plan';
  // fallen leaves around trees and in the gutters
  const leaves = [];
  for (const t of layout.inChunk('trees', ci)) {
    const lr = RNG.from('leaves', t.seed);
    // litter caught against the grate frame: small, mostly dry leaves and fragments
    const nl = lr.int(5, 12);
    for (let i = 0; i < nl; i++) {
      const edge = lr.int(0, 3), along = lr.range(-0.75, 0.75), out = 0.66 + Math.abs(lr.normal(0, 0.14));
      const ds = edge < 2 ? (edge ? out : -out) : along, dd = edge < 2 ? along : (edge === 2 ? out : -out);
      const s = t.s + ds, d = t.d + dd;
      if (!inside(s, 0.1)) continue;
      leaves.push({ s, d, yaw: lr.range(0, 6.28), size: lr.range(0.035, 0.07), cell: lr.int(0, 3), tint: lr.weighted([[1, 0.4], [2, 0.3], [4, 0.2], [0, 0.1]]), tilt: lr.range(-0.2, 0.2) });
    }
    const n = lr.int(3, 10);
    for (let i = 0; i < n; i++) {
      const a = lr.range(0, Math.PI * 2), r = lr.range(0.75, 2.6);
      const s = t.s + Math.cos(a) * r, d = t.d + Math.sin(a) * r;
      if (!inside(s, 0.1) || Math.abs(d) < GUTTER_OUT - 0.2) continue;
      leaves.push({ s, d, yaw: lr.range(0, 6.28), size: lr.range(0.07, 0.12), cell: lr.int(0, 3), tint: lr.int(0, 4), tilt: lr.range(-0.25, 0.25) });
    }
    // a few blown into the gutter
    for (let i = 0; i < lr.int(0, 4); i++) {
      const s = t.s + lr.range(-3, 3);
      if (!inside(s, 0.1)) continue;
      leaves.push({ s, d: Math.sign(t.d) * (CORRIDOR + GUTTER_W * lr.range(0.2, 0.8)), yaw: lr.range(0, 6.28), size: lr.range(0.07, 0.11), cell: lr.int(0, 3), tint: lr.int(0, 4), tilt: 0 });
    }
  }

  // transverse expansion joints across the corridor every ~12 m, each in a bed joint of
  // the setts (paving u = surface.sp(s), courses every SETT_COURSE), so the sealant fills
  // a real joint rather than crossing the stones' faces
  const joints = [];
  {
    const k0 = Math.floor(s0 / 12), k1 = Math.ceil(s1 / 12), kP = ctx.surface.kP;
    for (let k = k0; k <= k1; k++) {
      const s = (Math.round(((12 * k + (u01(k, 911) - 0.5) * 4) * kP) / SETT_COURSE) * SETT_COURSE) / kP;
      if (s < s0 + 0.2 || s > s1 - 0.2) continue;
      if (layout.isInCrossover(s, 3) || layout.crossStreets.some((c) => Math.abs(delta(c.s, s)) < 3)) continue;
      joints.push(s);
    }
  }

  yield 'plan';
  const wear = planWear(ctx, ci, s0, s1, items, stains, blocked);

  // flat spots for the surface: covers (with dishing towards them), tree pits, and the
  // footprints of street furniture and café floors (objects stand at h = 0)
  // (covers and grates lie on a planar bed, see Surface.bedAt)
  const spots = items.map((it) => (it.spot = { s: it.s, d: it.d, r: it.r + 0.05, tree: !!it.tree, dish: !it.tree, bed: true }));
  for (const o of layout.inChunk('obstacles', ci)) {
    if (o.platform !== undefined) continue;
    if (o.kind === 'circle') spots.push({ s: o.s, d: o.d, r: o.r + 0.1 });
    else spots.push({ rect: true, s: (o.s0 + o.s1) / 2, hs: (o.s1 - o.s0) / 2 + 0.1, r: (o.s1 - o.s0) / 2 + 0.1, d0: o.d0 - 0.1, d1: o.d1 + 0.1 });
  }
  return { items, spots, stains, leaves, joints, relays: wear.relays, repairs: wear.repairs, weeds: wear.weeds };
}

// corners of a leaf quad
const QUAD_U = [-1, 1, 1, -1], QUAD_V = [-1, -1, 1, 1];
// leaf tints (linear): yellowing green, brown, dry tan, green, rusty
const LEAF_TINTS = [[0.36, 0.34, 0.08], [0.2, 0.11, 0.04], [0.42, 0.3, 0.14], [0.14, 0.2, 0.05], [0.33, 0.16, 0.05]];
// weed tints (linear): fresh green, grey-green, yellowing, dry straw
const WEED_TINTS = [[0.085, 0.15, 0.035], [0.1, 0.14, 0.055], [0.11, 0.17, 0.04], [0.15, 0.16, 0.05], [0.22, 0.2, 0.09]];

/** Build the details of a chunk into the BufSet (iron, stains, leaves, weeds) and joints
 *  and repairs into the line buffer (lines: its style writers, see street.js). grid: the
 *  chunk's paving grid (buildPaving), which covers, stains, leaves and repairs follow
 *  exactly. Resumable (see street.js): yields 'details' after each kind. */
export function* buildDetails(ctx, chunk, plan, bufs, lines, grid) {
  const jointLines = lines && lines.joint;
  const { route, surface, mats } = ctx;
  const pave = (s, d) => pavingHeight(grid, s, d, ctx.delta);
  const smp = {};
  const ri = surface.rowInfo(chunk.s0, {});
  const ci = {};
  const baseH = (s, d) => {
    colInfo(d, ci);
    const xo = ci.zone === Z_CORR ? ri.xo : 0;
    return ci.h0 * (1 - xo);
  };
  // shared ground under a cover: its planar bed (the paving is flattened to the same plane)
  const bed = route.surfaceEnabled ? (p, ds, d) => surface.bedAt(p, ds, d) : () => 0;

  // --- cast iron
  const iron = bufs.get(mats.details.iron, true);
  for (const it of plan.items) {
    const R = IRON_REGIONS[it.type];
    const [mw, mh] = SIZES[it.type];
    route.sample(it.s, smp);
    if (Math.abs(it.d) < GUTTER_OUT) surface.rowInfo(it.s, ri);   // (crossover blend of the camber)
    const ca = Math.cos(it.yaw), sa = Math.sin(it.yaw);
    // local (lu, lv) -> (ds, dd): u axis rotated by yaw from the street direction
    // the cover is flat on its bed; it stands proud of the paving by at least
    // COVER_LIFT, more where a mesh triangle reaching in from outside the bed rises
    const bedH = (lu, lv) => {
      const ds = lu * ca - lv * sa, d = it.d + lu * sa + lv * ca;
      return baseH(it.s, d) + bed(it.spot, ds, d);
    };
    let rise = 0;
    for (let j = 0; j <= 6; j++) {
      for (let i = 0; i <= 6; i++) {
        const lu = (i / 6 - 0.5) * mw, lv = (j / 6 - 0.5) * mh;
        if (ROUND[it.type] && lu * lu + lv * lv > (mw * mw) / 4) continue;
        const ds = lu * ca - lv * sa, d = it.d + lu * sa + lv * ca;
        rise = Math.max(rise, pave(it.s + ds, d) - bedH(lu, lv));
      }
    }
    const lift = Math.min(0.012, Math.max(COVER_LIFT, rise + 0.0015));
    const P = (lu, lv) => {
      const ds = lu * ca - lv * sa, dd = lu * sa + lv * ca;
      const d = it.d + dd;
      const h = bedH(lu, lv) + lift;
      return [
        smp.pos.x + smp.tanH.x * ds + smp.right.x * d,
        smp.pos.y + smp.grade * ds + h,
        smp.pos.z + smp.tanH.z * ds + smp.right.z * d,
      ];
    };
    const UV = (lu, lv) => [(R.x + (lu / mw + 0.5) * R.w) / ATLAS, (R.y + (lv / mh + 0.5) * R.h) / ATLAS];
    const vert = (lu, lv) => { const p = P(lu, lv), t = UV(lu, lv); return iron.v(p[0], p[1], p[2], 0, 1, 0, t[0], t[1]); };
    if (ROUND[it.type]) {
      const n = 24, r = mw / 2;
      const c = vert(0, 0);
      const first = iron.n;
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; vert(Math.cos(a) * r, Math.sin(a) * r); }
      for (let k = 0; k < n; k++) iron.tri(c, first + ((k + 1) % n), first + k);
    } else {
      // small grid so large grates follow the camber
      const nu = mw > 0.9 ? 3 : 1, nv = mh > 0.9 ? 3 : 1;
      const first = iron.n;
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) vert((i / nu - 0.5) * mw, (j / nv - 0.5) * mh);
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const a = first + j * (nu + 1) + i;
          iron.quad(a, a + nu + 1, a + nu + 2, a + 1);
        }
      }
    }
  }

  yield 'details';

  // --- stains (alpha decals): a small grid draped over the paving (the ground undulates
  // by a few centimetres over a couple of metres on the sidewalks)
  const st = bufs.get(mats.details.stain, true);
  const uv = [0, 0];
  for (const sn of plan.stains) {
    route.sample(sn.s, smp);
    const hx = sn.size / 2, hy = (sn.size * sn.aspect) / 2;
    const ca = Math.cos(sn.yaw), sa = Math.sin(sn.yaw);
    const op = sn.op ?? 1, warm = sn.warm ?? 0;
    const nu = Math.min(3, Math.ceil(hx / 0.4)), nv = Math.min(3, Math.ceil(hy / 0.4));
    const first = st.n;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const lu = (i / nu) * 2 - 1, lv = (j / nv) * 2 - 1;
        const ds = lu * hx * ca - lv * hy * sa, dd = lu * hx * sa + lv * hy * ca;
        const d = sn.d + dd;
        const h = pave(sn.s + ds, d) + 0.0015;
        stainUV(sn.kind, lu, lv, uv);
        st.v(smp.pos.x + smp.tanH.x * ds + smp.right.x * d, smp.pos.y + smp.grade * ds + h, smp.pos.z + smp.tanH.z * ds + smp.right.z * d,
          0, 1, 0, uv[0], uv[1], op, warm, 0);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = first + j * (nu + 1) + i;
        st.quad(a, a + nu + 1, a + nu + 2, a + 1);
      }
    }
  }

  // --- fallen leaves (cut-outs in the iron atlas, tinted by vertex colour)
  const LR = IRON_REGIONS.leaves, cw = LR.w / 2 / ATLAS, chh = LR.h / 2 / ATLAS;
  for (const l of plan.leaves) {
    route.sample(l.s, smp);
    const ca = Math.cos(l.yaw), sa = Math.sin(l.yaw);
    const h0 = pave(l.s, l.d) + 0.004;
    const tint = LEAF_TINTS[l.tint];
    const u0 = LR.x / ATLAS + (l.cell % 2) * cw, v0 = LR.y / ATLAS + Math.floor(l.cell / 2) * chh;
    const first = iron.n;
    for (let q = 0; q < 4; q++) {
      const lu = QUAD_U[q], lv = QUAD_V[q];
      const ds = lu * l.size * ca - lv * l.size * sa, dd = lu * l.size * sa + lv * l.size * ca;
      const d = l.d + dd;
      iron.v(smp.pos.x + smp.tanH.x * ds + smp.right.x * d, smp.pos.y + h0 + lu * l.tilt * l.size * 0.4 + 0.006 * (lv + 1), smp.pos.z + smp.tanH.z * ds + smp.right.z * d,
        0, 1, 0, u0 + (lu * 0.5 + 0.5) * cw, v0 + (lv * 0.5 + 0.5) * chh, tint[0], tint[1], tint[2]);
    }
    iron.quad(first, first + 3, first + 2, first + 1);
  }

  // --- weeds (wear.js): crossed upright cut-outs of the iron atlas, tinted, lit as the
  // ground (up normals; both windings, the iron material is single sided)
  const WR = IRON_REGIONS.weeds;
  for (const wd of plan.weeds) {
    const r = RNG.from('weed', wd.seed);
    for (let k = 0; k < wd.n; k++) {
      const s = wd.s + r.normal(0, 0.03), d = wd.d + r.normal(0, 0.025);
      route.sample(s, smp);
      const h = wd.size * r.range(0.7, 1.15), y0 = smp.pos.y + pave(s, d) - 0.004;
      const tint = WEED_TINTS[r.int(0, WEED_TINTS.length - 1)];
      const cell = r.int(0, 1);
      const u0 = (WR.x + cell * 128 + 4) / ATLAS, u1 = (WR.x + cell * 128 + 124) / ATLAS;
      const vTop = (WR.y + 4) / ATLAS, vBase = (WR.y + 124) / ATLAS;
      const yaw = r.range(0, Math.PI);
      for (let q = 0; q < 2; q++) {
        const a = yaw + q * Math.PI / 2, ca = Math.cos(a) * h * 0.5, sa = Math.sin(a) * h * 0.5;
        const P = (sg, up) => {
          const ds = sg * ca, dd = sg * sa;
          return iron.v(smp.pos.x + smp.tanH.x * ds + smp.right.x * (d + dd), y0 + smp.grade * ds + up * h, smp.pos.z + smp.tanH.z * ds + smp.right.z * (d + dd),
            0, 1, 0, sg < 0 ? u0 : u1, up ? vTop : vBase, tint[0], tint[1], tint[2]);
        };
        const b0 = P(-1, 0), b1 = P(1, 0), t1 = P(1, 1), t0 = P(-1, 1);
        iron.quad(b0, b1, t1, t0);
        iron.quad(b0, t0, t1, b1);
      }
    }
  }

  yield 'details';

  // --- repairs (wear.js): ribbons over the paving grid, lying on its cross slope. Their
  // along coordinate starts at the nominal start of the fill (a course joint where its
  // ends step: the ribbon reaches STEP_PAD further at both ends) and runs outwards from
  // the gutter for trenches across a sidewalk; where the sides step, the ribbon is
  // STEP_PAD wider on both sides (lines.js)
  if (lines && lines.repair) {
    const e = 0.15;
    for (const p of plan.repairs) {
      const along = p.dir === 's';
      const half = along ? p.hd : p.hs, h0 = along ? p.hs : p.hd;
      const endPad = p.step === STEP_WALK_X ? STEP_PAD : 0;
      const sidePad = p.step === STEP_WALK_U || p.step === STEP_STREET_U ? STEP_PAD : 0;
      const sg = along || !(p.d < 0) ? 1 : -1;      // trenches on the left run towards -d
      const r0 = h0 + PATCH_PAD + endPad;
      const n = Math.max(2, Math.ceil((2 * r0) / 0.35));
      const pts = new Array((n + 1) * 7);
      let acc = 0, px = 0, pz = 0;
      for (let i = 0; i <= n; i++) {
        const t = -r0 + (2 * r0 * i) / n;
        const s = along ? p.s + t : p.s, d = along ? p.d : p.d + sg * t;
        route.sample(s, smp);
        const x = smp.pos.x + smp.right.x * d, z = smp.pos.z + smp.right.z * d;
        if (i > 0) acc += Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
        px = x; pz = z;
        const o = i * 7;
        pts[o] = x; pts[o + 1] = smp.pos.y + pave(s, d) + REPAIR_LIFT; pts[o + 2] = z;
        if (along) {
          pts[o + 3] = smp.right.x; pts[o + 4] = smp.right.z;
          pts[o + 6] = (pave(s, d + e) - pave(s, d - e)) / (2 * e);
        } else {
          // runs towards sg·d: its right vector is -sg·tangent
          pts[o + 3] = -sg * smp.tanH.x; pts[o + 4] = -sg * smp.tanH.z;
          pts[o + 6] = -sg * (pave(s + e, d) - pave(s - e, d)) / (2 * e);
        }
        pts[o + 5] = acc - PATCH_PAD - endPad;
      }
      lines.repair.add(pts, half + PATCH_PAD + sidePad, acc - 2 * (PATCH_PAD + endPad), repairWear(p.kind, p.tone, p.hole, p.step || 0), 7);
    }
  }

  // --- transverse joints (intermittent sealant lines across the corridor between the rails)
  if (jointLines) {
    for (const s of plan.joints) {
      route.sample(s, smp);
      surface.rowInfo(s, ri);
      // across the setts and the mortar strips, up to the rail seals
      const free = [];
      let x = -BAND_IN;
      for (const r of MAIN_RAILS) { free.push([x, r.lo]); x = r.hi; }
      free.push([x, BAND_IN]);
      // the line runs towards +d: its right vector is -tangent
      const rx = -smp.tanH.x, rz = -smp.tanH.z;
      for (const [a, b] of free) {
        const arr = [];
        const n = Math.max(1, Math.ceil((b - a) / 0.4));
        for (let k = 0; k <= n; k++) {
          const d = a + ((b - a) * k) / n;
          arr.push(smp.pos.x + smp.right.x * d, smp.pos.y + surface.height(ri, d) + 0.0005, smp.pos.z + smp.right.z * d, rx, rz, d - a);
        }
        jointLines.add(arr, JOINT_HALF, b - a);
      }
    }
  }
}
