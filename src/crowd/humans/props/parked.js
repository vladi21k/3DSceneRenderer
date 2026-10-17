import * as THREE from 'three';
import { RNG } from '../../../core/rng.js';
import { Builder, CH, V } from './geo.js';
import { propMesh, writeInstance, propMatrix, pxPerMetre, lodFor, fitBounds } from './instancer.js';
import { packLook, packColor } from './shading.js';

// Parked bicycles for a chunk: 2-5 bikes at every 'bikeRack' furniture entry (beside the
// hoops, some locked to them with a U-lock), and occasionally one leaning against a lamp
// pole or a street tree. Deterministic (chunk.rng + layout ids), resting on the ground at both
// wheels (route.toWorld), never placed where layout obstacles or other parked bikes are.
//
// The returned Object3D holds one cluster per spot (a THREE.LOD subclass): the cluster's level
// follows its projected size like the moving props, and each level is an InstancedMesh per
// bike variant sharing the kit's geometry. Call disposeParkedBicycles(obj) when the chunk is
// recycled (it frees only the per-chunk instance buffers; geometries and the material are shared).

const RACK_HOOPS = 5, HOOP_SP = 0.9, HOOP_TOP = 0.78;   // furniture bikeRack: 5 hoops 0.9 m apart, 0.78 m tall
const POLE_R = 0.155;          // cast drum of the lamp poles (0.3 - 1.1 m)
const TRUNK_R = 0.07;
const LEAN_POLE_P = 0.07, LEAN_TREE_P = 0.035;

// parked mix: city bikes and commuters, few road bikes
const PARK_WEIGHTS = { city: 0.32, dutch: 0.12, hybrid: 0.24, ebike: 0.16, road: 0.08, kids: 0.08 };

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _smp = {};

let lockGeo = null;
/** U-lock: hardened shackle (13 mm) around the rack bar and the frame, plastic-coated crossbar. Local: shackle in the XY plane, crossbar along X at y = 0. */
function lockGeometry() {
  if (lockGeo) return lockGeo;
  const b = new Builder();
  const pts = [];
  const w = 0.055, L = 0.2;
  pts.push(V(-w, 0.0, 0));
  for (let i = 0; i <= 10; i++) { const a = Math.PI - (i / 10) * Math.PI; pts.push(V(Math.cos(a) * w, L + Math.sin(a) * w * 0.9, 0)); }
  pts.push(V(w, 0.0, 0));
  b.with({ col: [0.75, 0.75, 0.77], rough: 0.25, metal: 1, ch: CH.PLAIN }, () => b.tube(pts, 0.0065, 8, { n: 24 }));
  b.with({ col: [1, 1, 1], rough: 0.45, metal: 0, ch: CH.PAINT_A, w: 0.2 }, () => b.tube([V(-0.085, -0.004, 0), V(0.085, -0.004, 0)], 0.017, 10, { n: 1, caps: 'round' }));
  b.with({ col: [0.02, 0.02, 0.02], rough: 0.5, metal: 0, ch: CH.PLAIN }, () => b.tube([V(-0.085, 0.0, 0.0), V(-0.105, 0.0, 0)], 0.012, 8, { n: 1, caps: [null, 'flat'] }));
  lockGeo = b.build();
  lockGeo.name = 'props.ulock';
  return lockGeo;
}
const LOCK_COLORS = ['#141414', '#141414', '#e3b819', '#b61f1f', '#1f4fa0', '#2a2a2a'];

/** A parked cluster: switches levels by projected size (pixels) instead of distance. */
class ParkedCluster extends THREE.LOD {
  constructor(app, centre, size) {
    super();
    this.app = app;
    this.centre = centre;
    this.size = size;
    this.cur = -1;
    this.autoUpdate = true;
  }
  update(camera) {
    if (!this.levels.length) return;
    const d = Math.max(0.5, _q.setFromMatrixPosition(camera.matrixWorld).distanceTo(this.centre));
    let lv = lodFor((this.size * pxPerMetre(camera, this.app.renderer)) / d);
    lv = Math.min(lv, this.levels.length - 1);
    if (lv !== this.cur) {
      this.levels.forEach((l, i) => { l.object.visible = i === lv; });
      this.cur = lv;
      if (lv === 0) {
        for (const m of this.levels[0].object.children) {
          const V_ = m.userData.upgrade;
          if (V_ && V_.lods[0]) { m.geometry = V_.lods[0]; m.userData.upgrade = null; }
        }
      }
    }
  }
}

/**
 * Footprints of the parked bikes of a chunk for crowd avoidance: [{s, d, r}] circles
 * (three per bike along its length). Deterministic and identical to what buildParkedBicycles draws.
 */
export function parkedBicycleFootprints(chunk, app) {
  const kit = getKit(app);
  if (!kit) return [];
  return planChunk(chunk, app, kit).flatMap((it) => it.foot);
}

let kitGetter = null;
function getKit(app) {
  if (!kitGetter) return null;
  try { return kitGetter(app); } catch (e) { console.warn('[props] bicycle kit unavailable', e); return null; }
}
/** index.js registers the shared kit accessor (avoids a circular import). */
export function setParkedKit(fn) { kitGetter = fn; }

function pickVariant(kit, r) {
  const items = kit.variants.map((v, i) => [i, PARK_WEIGHTS[v.id] || 0]).filter(([, w]) => w > 0);
  return r.weighted(items);
}

/** The parked bikes a chunk would get: [{v, look, s, d, dirS | dirD, lean, steer, crank, lock?, foot}]. */
export function parkedBicyclePlan(chunk, app) {
  const kit = getKit(app);
  return kit ? planChunk(chunk, app, kit) : [];
}

function planChunk(chunk, app, kit) {
  const { layout, route } = app;
  const rng = chunk.rng ? chunk.rng('parkedBikes') : RNG.from(layout.seed, 'parkedBikes', chunk.index);
  const out = [];
  const taken = [];       // footprint circles already used in this chunk
  const free = (foot, ignoreS = null, ignoreD = null) => {
    for (const c of foot) {
      for (const t of taken) if (Math.hypot(route.delta(t.s, c.s), t.d - c.d) < t.r + c.r) return false;
      for (const o of layout.obstaclesNear(c.s, 3)) {
        if (o.kind === 'circle') {
          if (ignoreS !== null && Math.abs(route.delta(o.s, ignoreS)) < 0.05 && Math.abs(o.d - ignoreD) < 0.05) continue;
          if (Math.hypot(route.delta(o.s, c.s), c.d - o.d) < o.r + c.r) return false;
        } else if (route.delta(o.s0, c.s) > -c.r && route.delta(c.s, o.s1) > -c.r && c.d > o.d0 - c.r && c.d < o.d1 + c.r) return false;
      }
    }
    return true;
  };
  // footprint circles along the bike (centred between the wheels), forward = (dirS along s, dirD along d)
  const footOf = (s, d, dirS, dirD, V_) => {
    const zc = (V_.dims.front + V_.dims.rear) / 2;         // bike-local z of the middle (+ = back)
    const len = V_.dims.length;
    const f = [];
    for (const k of [-0.36, 0, 0.36]) {
      const z = zc + k * len;
      f.push({ s: s - dirS * z, d: d - dirD * z, r: 0.36 });
    }
    return f;
  };

  // ---- bike racks
  for (const f of layout.inChunk('furniture', chunk.index)) {
    if (f.type !== 'bikeRack') continue;
    const r = new RNG((rng.next() * 4294967296) >>> 0);
    const side = f.d > 0 ? 1 : -1;
    const sgn = side;                         // rack local +X runs along +s on the right side, -s on the left
    const nBikes = r.int(2, 5);
    const slots = [];
    for (let h = 0; h < RACK_HOOPS; h++) for (const ss of [-1, 1]) slots.push([h, ss]);
    for (let i = slots.length - 1; i > 0; i--) { const j = r.int(0, i); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    const used = new Set();
    let placed = 0;
    for (const [h, ss] of slots) {
      if (placed >= nBikes) break;
      // one bike per hoop side, never two facing each other through the same hoop gap
      if (used.has(`${h}:${ss}`) || used.has(`${h + ss}:${-ss}`)) continue;
      const v = pickVariant(kit, r);
      const V_ = kit.variants[v];
      const spec = V_.spec;
      const look = kit.pick((r.next() * 4294967296) >>> 0, { variant: v, parked: false });
      const lock = spec.adult && spec.saddleH > HOOP_TOP + 0.08 && r.chance(0.45);
      const fwd = r.chance(0.55) ? 1 : -1;     // front wheel towards the facade (+1) or the street
      const L = V_.layout;
      // where the seat tube crosses the hoop's top bar height (bike-local z, + = back)
      const zCross = L.bb.z + ((HOOP_TOP - L.bb.y) * L.seatDir.z) / L.seatDir.y;
      // bike-local z of the hoop centre: locked bikes put the seat tube at the bar, others sit centred on the crank
      const zHoop = lock ? zCross + r.range(-0.12, 0.12) : r.range(-0.12, 0.08);
      const gap = spec.extras.rack ? 0.105 : 0.052;
      const hoopX = -1.8 + h * HOOP_SP;
      const sHoop = f.s + sgn * hoopX;
      const sBike = sHoop + ss * gap;
      // forward across the street (towards the facade when fwd = 1); a bike-local z maps to d - dirD * z
      const dirD = fwd * side;
      const dBike = f.d + dirD * zHoop;
      const foot = footOf(sBike, dBike, 0, dirD, V_);
      // the bike's right points along -dirD * s (right = forward x up): is the hoop on its left?
      const hoopOnLeft = (sHoop - sBike) * dirD > 0;
      const lean = (hoopOnLeft ? 1 : -1) * (spec.extras.rack ? 0.006 : r.range(0.015, 0.04));
      // front wheel turned a little towards the hoop side (keeps it clear of the hoop legs)
      const steer = (hoopOnLeft ? 1 : -1) * r.range(0, 0.35) * (r.chance(0.6) ? 1 : 0.3);
      // cranks roughly vertical so the hoop-side pedal passes between the hoop legs
      const crank = (r.chance(0.5) ? 0 : Math.PI) + r.range(-0.3, 0.3);
      used.add(`${h}:${ss}`);
      placed++;
      for (const c of foot) taken.push(c);
      out.push({ v, look, s: sBike, d: dBike, dirD, lean, steer, crank, foot,
        lock: lock ? { s: (sBike + sHoop) / 2, d: dBike - dirD * zCross, y: HOOP_TOP - 0.07, color: r.pick(LOCK_COLORS) } : null });
    }
  }

  // ---- bikes leaning against lamp poles and street trees (sparse)
  const leaners = [];
  for (const p of layout.inChunk('poles', chunk.index)) leaners.push({ o: p, kind: 'pole', p: LEAN_POLE_P, R: POLE_R });
  for (const t of layout.inChunk('trees', chunk.index)) leaners.push({ o: t, kind: 'tree', p: LEAN_TREE_P, R: TRUNK_R });
  leaners.sort((a, b) => a.o.s - b.o.s);
  for (const L0 of leaners) {
    const r = new RNG((rng.next() * 4294967296) >>> 0);
    if (!r.chance(L0.p)) continue;
    const { o } = L0;
    const side = o.d > 0 ? 1 : -1;
    if (layout.isInStation(o.s, 6) || layout.isInCrossStreet(o.s, side, 3)) continue;
    const v = pickVariant(kit, r);
    const V_ = kit.variants[v];
    const spec = V_.spec;
    const look = kit.pick((r.next() * 4294967296) >>> 0, { variant: v, parked: false });
    // parallel to the street on the pavement side of the pole / tree, saddle against it
    const dirS = r.chance(0.5) ? 1 : -1;
    const lean = 0.13 + r.range(0, 0.05);
    const touchH = spec.saddleH - 0.02;
    const off = L0.R + (spec.saddle === 'road' ? 0.07 : 0.09) + touchH * Math.sin(lean);
    const dBike = o.d + side * off;
    const sBike = o.s + dirS * V_.attach.saddle.z;    // the saddle (bike-local z) sits at the pole's s
    const foot = footOf(sBike, dBike, dirS, 0, V_);
    if (!free(foot, o.s, o.d)) continue;
    // the bike's right points along dirS * d: is the pole on its left?
    const poleOnLeft = (o.d - dBike) * dirS < 0;
    for (const c of foot) taken.push(c);
    out.push({ v, look, s: sBike, d: dBike, dirS, lean: (poleOnLeft ? 1 : -1) * lean, steer: (poleOnLeft ? 1 : -1) * r.range(0.1, 0.45), crank: r.range(0, Math.PI * 2), foot });
  }
  return out;
}

/** Build the parked bicycles of a chunk (or null when there are none). */
export function buildParkedBicycles(chunk, app) {
  const kit = getKit(app);
  if (!kit) return null;
  const items = planChunk(chunk, app, kit);
  if (!items.length) return null;
  const { route } = app;
  const group = new THREE.Group();
  group.name = 'parkedBicycles';
  const anim = [0, 0, 0, 0];
  // group by spot: rack bikes share a cluster per rack, leaners are their own cluster
  const clusters = [];
  let cur = null;
  for (const it of items) {
    if (!cur || Math.abs(route.delta(cur.s, it.s)) > 6 || Math.abs(cur.d - it.d) > 3) { cur = { s: it.s, d: it.d, items: [] }; clusters.push(cur); }
    cur.items.push(it);
  }
  for (const c of clusters) {
    const centre = route.toWorld(c.s, c.d, 0.6, new THREE.Vector3());
    const cl = new ParkedCluster(app, centre, 1.1);
    cl.name = 'parkedBicycles.cluster';
    const pos = [];
    for (let lv = 0; lv < 3; lv++) {
      const lvG = new THREE.Group();
      lvG.visible = false;
      const byV = new Map();
      for (const it of c.items) { if (!byV.has(it.v)) byV.set(it.v, []); byV.get(it.v).push(it); }
      for (const [v, list] of byV) {
        const V_ = kit.variants[v];
        // the close-up model may still be building in the background: use LOD 1 until it is there
        const g = V_.lods[lv] || V_.lods[lv + 1];
        const mesh = propMesh(g, kit.mats, list.length, `parked.${V_.id}.lod${lv}`);
        if (!V_.lods[lv]) mesh.userData.upgrade = V_;
        mesh.castShadow = true;
        list.forEach((it, i) => {
          placeMatrix(app, kit, it, _m);
          kit.anim(anim, v, { wheel: ((it.s * 7.31) % 1) * Math.PI * 2, crank: it.crank, steer: it.steer, saddle: 0 });
          const flags = 0;
          it.look.look[2] = packLook(it.look.finish, it.look.wear, flags);
          writeInstance(mesh, i, _m, anim, it.look.look);
          if (lv === 0) pos.push(_m.elements[12], _m.elements[13], _m.elements[14]);
        });
        mesh.count = list.length;
        const pts = new Float32Array(list.length * 3);
        list.forEach((it, i) => { route.toWorld(it.s, it.d, 0, _p); pts[i * 3] = _p.x; pts[i * 3 + 1] = _p.y; pts[i * 3 + 2] = _p.z; });
        fitBounds(mesh, pts, list.length, 1.2);
        mesh.matrixAutoUpdate = false;
        lvG.add(mesh);
      }
      // U-locks (near levels only)
      const locks = c.items.filter((it) => it.lock);
      if (locks.length && lv < 2) {
        const mesh = propMesh(lockGeometry(), kit.mats, locks.length, 'parked.locks');
        locks.forEach((it, i) => {
          const k = it.lock;
          route.sample(k.s, _smp);
          route.toWorld(k.s, k.d, k.y, _p);
          // shackle plane across the bar and the frame, crossbar under the top bar (along s)
          const heading = Math.atan2(-_smp.tanH.x, -_smp.tanH.z);
          propMatrix(_m, _p.x, _p.y, _p.z, heading + Math.PI / 2, 0, 0);
          writeInstance(mesh, i, _m, [0, 0, 0, 0], [packColor(k.color), packColor(k.color), packLook(0, 2, 0)]);
        });
        mesh.count = locks.length;
        const pts = new Float32Array(locks.length * 3);
        locks.forEach((it, i) => { route.toWorld(it.lock.s, it.lock.d, it.lock.y, _p); pts[i * 3] = _p.x; pts[i * 3 + 1] = _p.y; pts[i * 3 + 2] = _p.z; });
        fitBounds(mesh, pts, locks.length, 0.3);
        mesh.matrixAutoUpdate = false;
        lvG.add(mesh);
      }
      cl.addLevel(lvG, lv);
    }
    group.add(cl);
  }
  group.userData.parkedBicycles = items.length;
  return group;
}

/** World matrix of a parked bike: on the ground at both wheels, heading along its direction, leaning. */
function placeMatrix(app, kit, it, out) {
  const { route } = app;
  const V_ = kit.variants[it.v];
  const L = V_.layout;
  route.sample(it.s, _smp);
  // forward direction (world, horizontal)
  let fx, fz;
  if (it.dirD) { fx = _smp.right.x * it.dirD; fz = _smp.right.z * it.dirD; }
  else { fx = _smp.tanH.x * it.dirS; fz = _smp.tanH.z * it.dirS; }
  const heading = Math.atan2(-fx, -fz);
  // ground under both wheels (pitch) and under the bottom bracket
  const zF = L.hubF.z, zR = L.hubR.z;             // bike-local (forward is -z)
  const at = (z) => {
    // route coords of a point z (local, + = back) along the bike's axis
    const k = -z;
    const s = it.s + (it.dirD ? 0 : it.dirS * k);
    const d = it.d + (it.dirD ? it.dirD * k : 0);
    return route.toWorld(s, d, 0, _q).y;
  };
  const yF = at(zF), yR = at(zR);
  const pitch = Math.atan2(yF - yR, zR - zF);
  const y0 = yR + ((yF - yR) * (zR - 0)) / (zR - zF);
  route.toWorld(it.s, it.d, 0, _p);
  return propMatrix(out, _p.x, y0, _p.z, heading, it.lean, pitch);
}

/** Free the per-chunk instance buffers of buildParkedBicycles' result (shared geometry and material stay). */
export function disposeParkedBicycles(obj) {
  if (!obj) return;
  obj.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  if (obj.parent) obj.parent.remove(obj);
}
