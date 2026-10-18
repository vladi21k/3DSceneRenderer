import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { facadePlan } from '../facadePlan.js';
import { bar, rbox, xf, merge, quad } from './kit.js';
import { proto, placeMatrix } from './instancer.js';
import { uvRect } from './prints.js';

// Sidewalk A-boards in front of the shops of the main street: about one shopfront in five
// puts a board out beside its window, in front of the pier next to the opening (never in
// the doorway), 0.95-1.25 m out from the facade (past the strip where the paving meets the
// building's own ground line). Two kinds: a wooden A-frame with a chalk menu or a printed
// sheet, and an aluminium snap-frame board with a poster. Lots with a café terrace have
// its menu board instead.
//
// Planned once at init (deterministic), off the trees, poles, furniture, café terraces and
// cross-street mouths, and registered as circular obstacles in layout.obstacles (before the
// crowd plans its street map), so pedestrians walk round them.

const SHARE = 0.2;
const OUT = [0.95, 1.25];
const R_OBST = 0.4;               // crowd obstacle radius (m)
const FOOT = 0.3;                 // base radius for the sink into sloping paving
const FACES = { wood: ['chalk0', 'chalk1', 'small1', 'small5'], snap: ['small0', 'small2', 'small4', 'small6'] };

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Wooden A-frame: two 0.6 x 0.88 panels hinged at the top, splayed ~22°, the face in a
 *  recess of the frame (chalk menu or a printed sheet). */
function woodBoard(face, detail) {
  const W = 0.6, H = 0.88, spl = 0.2;
  if (detail >= 1) {
    const slab = [1, -1].map((side) => xf(rbox(W, H, 0.02, 0), [0, H / 2, side * 0.085], [-side * spl, 0, 0]));
    return { wood: merge(slab), face: null };
  }
  const wood = [], faces = [];
  for (const side of [1, -1]) {
    const leg = (x) => bar([V(x, 0, side * 0.17), V(x, H, side * 0.012)], 0.03, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 });
    wood.push(leg(-W / 2 + 0.015), leg(W / 2 - 0.015));
    wood.push(bar([V(-W / 2, H - 0.02, side * 0.016), V(W / 2, H - 0.02, side * 0.016)], 0.04, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 }));
    wood.push(bar([V(-W / 2, 0.12, side * 0.148), V(W / 2, 0.12, side * 0.148)], 0.04, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 }));
    const n = new THREE.Vector3(0, Math.sin(spl), Math.cos(spl)).multiplyScalar(side);
    const c = [0, 0.12 + (H - 0.14) / 2, side * 0.08];
    wood.push(xf(rbox(W - 0.05, H - 0.19, 0.008, 0), c, [-side * spl, 0, 0]));
    const q = quad(W - 0.07, H - 0.21, uvRect(face));
    xf(q, [c[0] + n.x * 0.0075, c[1] + n.y * 0.0075, c[2] + n.z * 0.0075], [-side * spl, side > 0 ? 0 : Math.PI, 0]);
    faces.push(q);
  }
  return { wood: merge(wood), face: merge(faces) };
}

/** Aluminium snap-frame A-board (0.64 x 1.0 m panels, ~10° each way): a mitred silver
 *  profile round each poster under its clear cover, black feet. */
function snapBoard(face, detail) {
  const W = 0.64, H = 1.0, spl = 0.17, T = 0.032;   // panel, splay, frame profile width
  const zc = (H / 2) * Math.sin(spl) + 0.012;
  const frame = [], faces = [], feet = [];
  for (const side of [1, -1]) {
    const rot = [-side * spl, 0, 0], c = [0, H / 2 + 0.02, side * zc];
    const parts = [];
    if (detail >= 1) parts.push(rbox(W, H, 0.022, 0));
    else {
      const r = 0.004;
      parts.push(xf(rbox(W, T, 0.022, r, 1), [0, H / 2 - T / 2, 0]), xf(rbox(W, T, 0.022, r, 1), [0, -H / 2 + T / 2, 0]));
      parts.push(xf(rbox(T, H - 2 * T + 0.002, 0.022, r, 1), [-W / 2 + T / 2, 0, 0]), xf(rbox(T, H - 2 * T + 0.002, 0.022, r, 1), [W / 2 - T / 2, 0, 0]));
      parts.push(rbox(W - 2 * T + 0.004, H - 2 * T + 0.004, 0.008, 0));   // backing board
    }
    for (const g of parts) frame.push(xf(g, c, rot));
    const n = new THREE.Vector3(0, Math.sin(spl), Math.cos(spl)).multiplyScalar(side);
    const off = detail >= 1 ? 0.0115 : 0.0065;
    const q = quad(W - 2 * T + 0.002, H - 2 * T + 0.002, uvRect(face));
    xf(q, [c[0] + n.x * off, c[1] + n.y * off, c[2] + n.z * off], [-side * spl, side > 0 ? 0 : Math.PI, 0]);
    faces.push(q);
    if (!detail) {
      // rubber feet under the bottom corners
      const bz = side * (zc + (H / 2) * Math.sin(spl));
      for (const x of [-W / 2 + 0.03, W / 2 - 0.03]) feet.push(xf(rbox(0.05, 0.03, 0.05, 0.006, 1), [x, 0.015, bz]));
    }
  }
  return { frame: merge(frame), face: merge(faces), feet: feet.length ? merge(feet) : null };
}

export function buildShopProtos(F) {
  const P = {};
  for (const f of FACES.wood) {
    const lv = [woodBoard(f, 0), woodBoard(f, 1)];
    P[`wood_${f}`] = proto('shopBoardWood', [{ geo: lv.map((b) => b.wood), mat: F.timber }, { geo: lv.map((b) => b.face), mat: F.print, cast: false }], [40]);
  }
  for (const f of FACES.snap) {
    const lv = [snapBoard(f, 0), snapBoard(f, 1)];
    P[`snap_${f}`] = proto('shopBoardSnap', [{ geo: lv.map((b) => b.frame), mat: F.aluminium }, { geo: lv.map((b) => b.face), mat: F.print, cast: false },
      { geo: [lv[0].feet, null], mat: F.rubber, cast: false }], [40]);
  }
  return P;
}

/** Plan every shop board once (init) and register their obstacles. Returns a Map
 *  chunk index -> [{s, d, yaw, key}]. */
export function planShopStands(app) {
  const { layout, route } = app;
  const byChunk = new Map();
  const placed = [];
  const p = new THREE.Vector3();
  const blocked = (s, d) => {
    for (const o of layout.obstaclesNear(s, 4)) {
      if (o.kind === 'circle') {
        const ds = route.delta(o.s, s) * route.offsetScale(s, d), dd = d - o.d, r = o.r + R_OBST + 0.15;
        if (ds * ds + dd * dd < r * r) return true;
      } else {
        const m = R_OBST + 0.1, a = route.delta(o.s0, s), b = route.delta(s, o.s1);
        if (a > -m && b > -m && d > o.d0 - m && d < o.d1 + m) return true;
      }
    }
    for (const q of placed) {
      if (Math.abs(route.delta(q.s, s)) < 2.5 && Math.abs(q.d - d) < 2) return true;
    }
    return false;
  };
  for (const lot of layout.lots) {
    if (lot.sideStreet || (lot.cafe !== undefined && lot.cafe !== null)) continue;
    let plan;
    try { plan = facadePlan(lot); } catch (e) { continue; }
    const f = lot.frame;
    if (!plan || !f || !(f.width > 2)) continue;
    const g = plan.openings.filter((o) => o.floor === 0 && (o.kind === 'shop' || o.kind === 'door')).sort((a, b) => a.uc - b.uc);
    for (let i = 0; i < g.length; i++) {
      const o = g[i];
      if (o.kind !== 'shop') continue;
      const rng = RNG.from(layout.seed, 'shopStand', o.id);
      if (!rng.chance(SHARE)) continue;
      // the piers either side of the opening (to the next opening or the lot's end)
      const piers = [];
      const l0 = i > 0 ? g[i - 1].uc + g[i - 1].w / 2 : 0.3, l1 = o.uc - o.w / 2;
      const r0 = o.uc + o.w / 2, r1 = i < g.length - 1 ? g[i + 1].uc - g[i + 1].w / 2 : f.width - 0.3;
      if (l1 - l0 >= 0.5) piers.push([l0, l1]);
      if (r1 - r0 >= 0.5) piers.push([r0, r1]);
      if (!piers.length) continue;
      const [a, b] = piers[rng.int(0, piers.length - 1)];
      const u = (a + b) / 2 + rng.range(-0.5, 0.5) * Math.max(0, b - a - 0.6);
      const w = rng.range(OUT[0], OUT[1]);
      p.copy(f.origin).addScaledVector(f.uDir, u).addScaledVector(f.nDir, w);
      const frac = u / f.width;
      const sGuess = lot.side > 0 ? lot.s1 - frac * lot.len : lot.s0 + frac * lot.len;
      const { s, d } = route.project(p.x, p.z, sGuess, 3);
      if (Math.abs(d) > layout.halfWidth(s, lot.side) - 0.6 || Math.abs(d) < 5.5) continue;
      if (layout.isInCrossStreet(s, lot.side, 2) || blocked(s, d)) continue;
      const kind = rng.chance(0.4) ? 'wood' : 'snap';
      const face = rng.pick(FACES[kind]);
      // mostly turned across the sidewalk (the faces to the walkers), now and then flat to
      // the shopfront
      const yaw = rng.chance(0.75) ? (rng.chance(0.5) ? 0 : Math.PI) + rng.range(-0.25, 0.25)
        : (lot.side > 0 ? -Math.PI / 2 : Math.PI / 2) + rng.range(-0.12, 0.12);
      const st = { s, d, yaw, key: `${kind}_${face}`, lot: lot.id };
      placed.push(st);
      const ci = layout.chunkIndex(s);
      if (!byChunk.has(ci)) byChunk.set(ci, []);
      byChunk.get(ci).push(st);
      layout.obstacles.push({ kind: 'circle', s, d, r: R_OBST, shopBoard: true });
    }
  }
  return byChunk;
}

const _m = new THREE.Matrix4();

/** Instances of the shop boards planned in this chunk. */
export function placeShopStands(chunk, app, inst, P, plan) {
  const list = plan && plan.get(chunk.index);
  if (!list) return;
  for (const st of list) inst.add(P[st.key], placeMatrix(app.route, st.s, st.d, 0, st.yaw, _m, FOOT));
}
