import { RNG, hash2 } from '../../core/rng.js';
import { CHUNK_LEN } from '../../core/config.js';
import { IRON_REGIONS } from './textures.js';
import { MAIN_RAILS, CORRIDOR, GUTTER_W, GUTTER_OUT, TRACK_OFFSET, BAND_IN } from './constants.js';
import { colInfo, Z_CORR } from './surface.js';

// Street details per chunk, planned deterministically from the chunk index so the
// surface can flatten the paving under covers before it is built:
//   cast-iron covers (round manholes, chequer plates, valve caps), gully grates in the
//   gutters, slotted drain covers between the rails, tree grates around every tree,
//   stains / gum spots / drip trails, fallen leaves, and transverse expansion joints.

const ATLAS = 1024;
const SIZES = {
  manhole: [0.8, 0.8], treeGrate: [1.24, 1.24], gully: [0.62, 0.31], drain: [1.0, 0.5],
  plate: [0.6, 0.6], plate2: [1.0, 0.5], valve: [0.32, 0.32],
};
const ROUND = { manhole: 1, valve: 1 };
const u01 = (a, b) => hash2(a | 0, b | 0) / 4294967296;

/** Deterministic plan for chunk ci: { items, spots, joints, stains, leaves }. */
export function planDetails(ctx, ci) {
  const { layout, route } = ctx;
  const L = route.length;
  const s0 = ci * CHUNK_LEN, s1 = Math.min(L, s0 + CHUNK_LEN);
  const rng = RNG.from(layout.seed, 'street-details', ci);
  const obstacles = layout.obstaclesNear((s0 + s1) / 2, CHUNK_LEN);
  const items = [];

  const blocked = (s, d, r) => {
    for (const o of obstacles) {
      if (o.kind === 'circle') {
        const ds = route.delta(o.s, s), dd = d - o.d;
        if (ds * ds + dd * dd < (r + o.r + 0.25) ** 2) return true;
      } else if (route.delta(o.s0 - r, s) > 0 && route.delta(o.s1 + r, s) < 0 && d > o.d0 - r && d < o.d1 + r) return true;
    }
    for (const it of items) {
      const ds = route.delta(it.s, s), dd = d - it.d;
      if (ds * ds + dd * dd < (r + it.r + 0.3) ** 2) return true;
    }
    if (layout.isInCrossover(s, 3) && Math.abs(d) < BAND_IN) return true;
    for (const c of layout.crossStreets) if (Math.abs(route.delta(c.s, s)) < 2.6 + r && Math.abs(d) < GUTTER_OUT + 0.8) return true;
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

  // round manholes: sidewalks, sometimes between the tracks
  const nMan = rng.weighted([[0, 0.3], [1, 0.5], [2, 0.2]]);
  for (let i = 0; i < nMan; i++) {
    for (let tries = 0; tries < 6; tries++) {
      const s = rng.range(s0 + 1.2, s1 - 1.2);
      let d;
      if (rng.chance(0.28)) d = 0;
      else {
        const side = rng.chance(0.5) ? 1 : -1;
        const hw = layout.halfWidth(s, side);
        d = side * rng.range(GUTTER_OUT + 1.0, Math.max(GUTTER_OUT + 1.2, hw - 1.3));
      }
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

  // stains: oil drips along the tracks, dirt and gum on the sidewalks
  const stains = [];
  const nSt = rng.int(3, 7);
  for (let i = 0; i < nSt; i++) {
    const s = rng.range(s0 + 0.5, s1 - 0.5);
    const kind = rng.weighted([[0, 0.4], [1, 0.25], [2, 0.2], [3, 0.15]]);
    let d;
    if (kind === 3 || (kind === 1 && rng.chance(0.6))) d = (rng.chance(0.5) ? 1 : -1) * (TRACK_OFFSET + rng.normal(0, 0.15));
    else {
      const side = rng.chance(0.5) ? 1 : -1;
      d = side * rng.range(GUTTER_OUT + 0.3, layout.halfWidth(s, side) - 0.4);
    }
    const size = kind === 3 ? rng.range(1.4, 2.6) : kind === 2 ? rng.range(0.8, 1.5) : rng.range(0.6, 1.8);
    stains.push({ s, d, kind, size, yaw: kind === 3 ? Math.PI / 2 + rng.normal(0, 0.05) : rng.range(0, Math.PI * 2), aspect: kind === 3 ? 0.45 : rng.range(0.7, 1.2) });
  }

  // fallen leaves around trees and in the gutters
  const leaves = [];
  for (const t of layout.inChunk('trees', ci)) {
    const lr = RNG.from('leaves', t.seed);
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

  // transverse expansion joints across the corridor every ~12 m
  const joints = [];
  {
    const k0 = Math.floor(s0 / 12), k1 = Math.ceil(s1 / 12);
    for (let k = k0; k <= k1; k++) {
      const s = 12 * k + (u01(k, 911) - 0.5) * 4;
      if (s < s0 + 0.2 || s > s1 - 0.2) continue;
      if (layout.isInCrossover(s, 3) || layout.crossStreets.some((c) => Math.abs(route.delta(c.s, s)) < 3)) continue;
      joints.push(s);
    }
  }

  const spots = items.map((it) => ({ s: it.s, d: it.d, r: it.r + 0.05, tree: !!it.tree }));
  return { items, spots, stains, leaves, joints };
}

// leaf tints (linear): yellowing green, brown, dry tan, green, rusty
const LEAF_TINTS = [[0.36, 0.34, 0.08], [0.2, 0.11, 0.04], [0.42, 0.3, 0.14], [0.14, 0.2, 0.05], [0.33, 0.16, 0.05]];

/** Build the details of a chunk into the BufSet (iron, stains, leaves) and joints into a LineBuf. */
export function buildDetails(ctx, chunk, plan, bufs, jointLines) {
  const { route, surface, mats } = ctx;
  const smp = {};
  const ri = surface.rowInfo(chunk.s0, {});
  const ci = {};
  const baseH = (s, d) => {
    colInfo(d, ci);
    const xo = ci.zone === Z_CORR ? ri.xo : 0;
    return ci.h0 * (1 - xo);
  };

  // --- cast iron
  const iron = bufs.get(mats.details.iron, false);
  for (const it of plan.items) {
    const R = IRON_REGIONS[it.type];
    const [mw, mh] = SIZES[it.type];
    route.sample(it.s, smp);
    surface.rowInfo(it.s, ri);
    const ca = Math.cos(it.yaw), sa = Math.sin(it.yaw);
    // local (lu, lv) -> (ds, dd): u axis rotated by yaw from the street direction
    const P = (lu, lv) => {
      const ds = lu * ca - lv * sa, dd = lu * sa + lv * ca;
      const d = it.d + dd;
      const h = baseH(it.s, d) + 0.0025;
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

  // --- stains (alpha decals)
  const st = bufs.get(mats.details.stain, false);
  for (const sn of plan.stains) {
    route.sample(sn.s, smp);
    surface.rowInfo(sn.s, ri);
    const hx = sn.size / 2, hy = (sn.size * sn.aspect) / 2;
    const ca = Math.cos(sn.yaw), sa = Math.sin(sn.yaw);
    const col = sn.kind % 2, row = Math.floor(sn.kind / 2);
    const first = st.n;
    for (const [lu, lv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const ds = lu * hx * ca - lv * hy * sa, dd = lu * hx * sa + lv * hy * ca;
      const d = sn.d + dd;
      const h = surface.height(ri, d) + 0.001;
      st.v(smp.pos.x + smp.tanH.x * ds + smp.right.x * d, smp.pos.y + smp.grade * ds + h, smp.pos.z + smp.tanH.z * ds + smp.right.z * d,
        0, 1, 0, col * 0.5 + (lu * 0.5 + 0.5) * 0.5, 1 - (row + 1) * 0.5 + (lv * 0.5 + 0.5) * 0.5);
    }
    st.quad(first, first + 3, first + 2, first + 1);
  }

  // --- fallen leaves
  const lf = bufs.get(mats.details.leaf, true);
  for (const l of plan.leaves) {
    route.sample(l.s, smp);
    const ca = Math.cos(l.yaw), sa = Math.sin(l.yaw);
    const h0 = baseH(l.s, l.d) + 0.004;
    const tint = LEAF_TINTS[l.tint];
    const col = l.cell % 2, row = Math.floor(l.cell / 2);
    const first = lf.n;
    for (const [lu, lv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const ds = lu * l.size * ca - lv * l.size * sa, dd = lu * l.size * sa + lv * l.size * ca;
      const d = l.d + dd;
      lf.v(smp.pos.x + smp.tanH.x * ds + smp.right.x * d, smp.pos.y + h0 + lu * l.tilt * l.size * 0.4 + 0.006 * (lv + 1), smp.pos.z + smp.tanH.z * ds + smp.right.z * d,
        0, 1, 0, col * 0.5 + (lu * 0.5 + 0.5) * 0.5, 1 - (row + 1) * 0.5 + (lv * 0.5 + 0.5) * 0.5, tint[0], tint[1], tint[2]);
    }
    lf.quad(first, first + 3, first + 2, first + 1);
  }

  // --- transverse joints (dark lines across the corridor between the rails)
  if (jointLines) {
    for (const s of plan.joints) {
      route.sample(s, smp);
      surface.rowInfo(s, ri);
      const free = [];
      let x = -BAND_IN;
      for (const r of MAIN_RAILS) { free.push([x, r.lo - 0.005]); x = r.hi + 0.005; }
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
        jointLines.add(arr, 0.012, b - a);
      }
    }
  }
}
