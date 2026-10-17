import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { FOLIAGE, CELL } from './species.js';
import { cellRect } from './leafAtlas.js';

// Procedural street trees, grown once per template at start-up.
//
// 1. Skeleton: space colonisation. Attraction points fill a lobed crown envelope with a few
//    random gaps (weighted towards the shell, where a crown carries its foliage); a stem
//    (ash: a central leader, pagoda: a short stem splitting into scaffold limbs) grows
//    towards them in small steps. Short leaf-bearing spur shoots are added along the outer
//    branches and, shorter, along the inner ones. The main axis kinks away where a side
//    branch leaves it (sympodial growth), positions are lightly smoothed and slender shoots
//    droop under their own weight.
// 2. Radii: pipe model (r^2.3 of a parent = sum over children), remapped so the trunk has
//    the template's calliper and the shoots end at ~8 mm.
// 3. Bark: one tapered tube per branch chain (parallel-transport frames, metre UVs) with a
//    collar where it leaves its parent, occlusion in the crotches / crown interior and
//    splash dirt at the base. Young bark is grey-green (the shader adds lenticels), shoots
//    are greener. Three LODs keep thinner and thinner branches; each has a mirrored copy
//    (reversed winding) for instances drawn with a mirrored matrix.
// 4. Foliage: leaf cards carrying painted shoot tips (atlasPaint.js), centred on their shoot
//    so the leaf clumps stay inside the crown outline. Cards point outwards and face up
//    (tilting out on the crown sides); low in the crown some get a crossed partner so they
//    never all turn edge-on. Normals blend the card normal with the crown normal so the
//    crown shades as one volume. LOD 1 keeps 60% of the same cards, 1.25x larger; LOD 2
//    uses crossed clump cards. All levels share sites, colour and occlusion.
//
// Leaf vertex data (see vegMaterials.js):
//   aVeg   = (branch phase, branch amplitude, flutter weight, interior occlusion)
//   aCrown = (position in the crown sphere: centre 0, shell 1 (xyz), sphere radius in m)
//   aCard  = (unfolded card normal (xyz), lateral offset from the card axis in m)
// Bark: aVeg (flutter weight unused), aBark = youth (1 young smooth bark, 0 old).
//
// Template space: origin at the trunk base on the paving, +Y up, -X towards the tracks
// (branches and leaf tips are kept out of the tram's clearance envelope on that side).

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ crown envelope
function profile(shape, t) {
  if (t <= 0 || t >= 1) return 0;
  const ell = (c, a, b) => (t < c ? Math.sqrt(Math.max(0, 1 - ((c - t) / c) ** 2)) ** a : Math.max(0, 1 - ((t - c) / (1 - c)) ** 2) ** b);
  switch (shape) {
    case 'oval': return ell(0.42, 0.7, 0.55);
    case 'vase': return ell(0.62, 1.1, 0.5);
    case 'broad': return ell(0.36, 0.6, 0.35);
    default: return ell(0.45, 0.6, 0.5); // round
  }
}

function makeEnvelope(tpl, rng) {
  // tpl.height / tpl.crownR are the visible foliage extents: the branch envelope sits inside
  // them by the overhang of the leaf cards
  const over = FOLIAGE[tpl.species].card * 0.5;
  const R = tpl.crownR - over;
  const y0 = tpl.crownBase - 0.25, y1 = tpl.height - over * 0.9;
  const lobes = [];
  for (let i = 0; i < 6; i++) lobes.push([rng.int(2, 5), rng.range(0, Math.PI * 2), rng.range(0.07, 0.15), rng.range(1, 3), rng.range(0, Math.PI * 2)]);
  // a few random gaps in the crown: attraction points are not placed inside them
  const holes = [];
  const nHoles = Math.round(tpl.crownR * 2.2);
  for (let i = 0; i < nHoles; i++) {
    const a = rng.range(0, Math.PI * 2), t = rng.range(0.2, 0.85), rr = rng.range(0.55, 1.0);
    holes.push([Math.cos(a) * R * rr, y0 + (y1 - y0) * t, Math.sin(a) * R * rr, (rng.range(0.3, 0.5) * R) ** 2]);
  }
  const cy = (y0 + y1) / 2, hy = (y1 - y0) / 2;
  const env = {
    y0, y1, R, holes, cy, hy,
    /** Light-transport sphere (centre y, radius): the crown as seen by the shader. */
    sphere: { cy, r: (R + over + hy + over * 0.5) / 2 },
    radius(y, theta) {
      const t = (y - y0) / (y1 - y0);
      let f = 1;
      for (const [k, ph, a, kv, pv] of lobes) f += a * Math.sin(k * theta + ph) * Math.sin(kv * t * Math.PI + pv);
      return R * profile(tpl.shape, t) * f;
    },
    /** Track-side clearance for branches (template x must stay above this). Street trees
     *  next to a tram line are pruned clear of the vehicle gauge below ~4.2 m. */
    clear(y) { return y < 4.2 ? -1.25 : -2.0; },
    /** Clearance for the leaf tips (foliage may overhang the branches a little). */
    clearLeaf(y) { return y < 4.2 ? -1.5 : -2.25; },
    inside(x, y, z) {
      if (y < y0 || y > y1 || x < env.clear(y)) return false;
      return Math.hypot(x, z) <= env.radius(y, Math.atan2(z, x));
    },
    /** Normalised radial position (0 centre, 1 shell) for occlusion / leaf placement. */
    rn(x, y, z) { return Math.hypot(x / R, (y - cy) / hy, z / R); },
    /** Outward crown normal (ellipsoid gradient), written into out. */
    normal(x, y, z, out) {
      const c2 = (y0 + y1) * 0.48;
      return out.set(x / (R * R), (y - c2) / (hy * hy), z / (R * R)).normalize();
    },
  };
  return env;
}

// ------------------------------------------------------------------ skeleton
class Skeleton {
  constructor() { this.p = []; this.parent = []; this.trunk = []; this.noGrow = []; }
  add(pos, parent, trunk = false, noGrow = false) {
    this.p.push(pos.clone()); this.parent.push(parent); this.trunk.push(trunk); this.noGrow.push(noGrow);
    return this.p.length - 1;
  }
  get n() { return this.p.length; }
}

/** Spatial hash for nearest-node queries. */
class Grid {
  constructor(cell) { this.c = cell; this.m = new Map(); }
  key(x, y, z) { return ((Math.floor(x / this.c) + 512) * 1024 + (Math.floor(y / this.c) + 512)) * 1024 + (Math.floor(z / this.c) + 512); }
  add(i, p) { const k = this.key(p.x, p.y, p.z); let a = this.m.get(k); if (!a) this.m.set(k, (a = [])); a.push(i); }
  near(p, fn) {
    const c = this.c, ix = Math.floor(p.x / c), iy = Math.floor(p.y / c), iz = Math.floor(p.z / c);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const a = this.m.get(((ix + dx + 512) * 1024 + (iy + dy + 512)) * 1024 + (iz + dz + 512));
      if (a) for (const i of a) fn(i);
    }
  }
}

function growSkeleton(tpl, env, rng) {
  const sk = new Skeleton();
  const step = tpl.step;
  // ---- stem: slight lean and wobble, as nursery stock planted by hand
  const leanA = rng.range(0, Math.PI * 2), lean = rng.range(0.005, 0.035);
  const trunkTop = tpl.leader ? tpl.crownBase + (tpl.height - tpl.crownBase) * 0.55 : tpl.crownBase;
  let parent = -1;
  const pos = new THREE.Vector3();
  const nT = Math.ceil(trunkTop / step);
  const wob = [rng.range(0, 6), rng.range(0, 6)];
  for (let i = 0; i <= nT; i++) {
    const y = (i / nT) * trunkTop;
    const wb = 0.012 * Math.sin(y * 1.7 + wob[0]);
    pos.set(Math.cos(leanA) * lean * y + wb, y, Math.sin(leanA) * lean * y + 0.012 * Math.sin(y * 1.3 + wob[1]));
    parent = sk.add(pos, parent, true, y < tpl.crownBase - 0.3);
  }
  const top = parent;
  // ---- scaffold limbs where the stem splits (pagoda-type crowns)
  if (!tpl.leader) {
    const a0 = rng.range(0, Math.PI * 2);
    for (let k = 0; k < tpl.scaffolds; k++) {
      const az = a0 + (k / tpl.scaffolds) * Math.PI * 2 + rng.range(-0.35, 0.35);
      const el = rng.range(0.85, 1.15); // ~50-65 degrees above horizontal
      const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      let pi = top;
      const p = sk.p[top].clone();
      for (let s = 0; s < 3; s++) {
        p.addScaledVector(dir, step);
        if (p.x < env.clear(p.y)) p.x = env.clear(p.y) + 0.05;
        pi = sk.add(p, pi);
        dir.y += 0.08; dir.normalize();
      }
    }
  }

  // ---- attraction points (shell-weighted)
  const att = [];
  const R = env.R * 1.25;
  let guard = 0;
  while (att.length < tpl.attractors && guard++ < tpl.attractors * 60) {
    const x = rng.range(-R, R), y = rng.range(env.y0, env.y1), z = rng.range(-R, R);
    if (!env.inside(x, y, z)) continue;
    if (env.holes.some((h) => (x - h[0]) ** 2 + (y - h[1]) ** 2 + (z - h[2]) ** 2 < h[3])) continue;
    const r = Math.hypot(x, z) / Math.max(0.05, env.radius(y, Math.atan2(z, x)));
    if (rng.next() > 0.4 + 0.6 * Math.pow(Math.min(1, r), 1.6)) continue;
    att.push(new THREE.Vector3(x, y, z));
  }

  // ---- space colonisation (incremental: each attraction point caches its nearest node
  //      and only newly grown nodes are tested against the points around them)
  const grid = new Grid(tpl.infl);
  for (let i = 0; i < sk.n; i++) grid.add(i, sk.p[i]);
  const agrid = new Grid(tpl.infl);
  att.forEach((p, a) => agrid.add(a, p));
  const alive = new Uint8Array(att.length).fill(1);
  const infl2 = tpl.infl * tpl.infl, kill2 = tpl.kill * tpl.kill;
  const best = new Int32Array(att.length).fill(-1);
  const bestD = new Float32Array(att.length).fill(infl2);
  const consider = (i) => {
    if (sk.noGrow[i]) return;
    const p = sk.p[i];
    agrid.near(p, (a) => {
      if (!alive[a]) return;
      const d2 = p.distanceToSquared(att[a]);
      if (d2 < bestD[a]) { bestD[a] = d2; best[a] = i; if (d2 < kill2) alive[a] = 0; }
    });
  };
  for (let i = 0; i < sk.n; i++) consider(i);
  const childCount = new Uint8Array(65536);
  for (let iter = 0; iter < 160; iter++) {
    const acc = new Map();
    for (let a = 0; a < att.length; a++) {
      if (!alive[a] || best[a] < 0) continue;
      const i = best[a];
      let v = acc.get(i);
      if (!v) acc.set(i, (v = new THREE.Vector3()));
      _v.subVectors(att[a], sk.p[i]).normalize();
      v.add(_v);
    }
    if (!acc.size) break;
    const fresh = [];
    for (const [i, v] of acc) {
      if (childCount[i] >= 3 || sk.n >= 65000) continue;
      v.normalize();
      // persistence: keep some of the parent direction; gentle upward tropism
      const pp = sk.parent[i];
      if (pp >= 0) { _w.subVectors(sk.p[i], sk.p[pp]).normalize(); v.addScaledVector(_w, 0.35); }
      v.y += 0.12;
      v.x += rng.range(-0.15, 0.15); v.z += rng.range(-0.15, 0.15);
      v.normalize();
      const np = sk.p[i].clone().addScaledVector(v, tpl.step);
      if (np.y < tpl.crownBase - 0.35) continue;
      let dup = false;
      grid.near(np, (j) => { if (!dup && sk.p[j].distanceToSquared(np) < (tpl.step * 0.45) ** 2) dup = true; });
      if (dup) continue;
      const j = sk.add(np, i);
      grid.add(j, np);
      childCount[i]++;
      fresh.push(j);
    }
    if (!fresh.length) break;
    for (const j of fresh) consider(j);
  }
  kinkSkeleton(sk, env, rng);
  addSpurs(tpl, env, sk, rng, false);
  addSpurs(tpl, env, sk, rng, true);
  return sk;
}

/**
 * Kinks: where a side branch leaves an axis, the continuing axis turns 8-15 degrees away
 * from it (plus a random component). The whole sub-tree beyond the node rotates with it,
 * so limbs zig-zag like real sympodial growth instead of running as smooth arcs.
 */
function kinkSkeleton(sk, env, rng) {
  const n = sk.n;
  const kids = Array.from({ length: n }, () => []);
  for (let i = 1; i < n; i++) if (sk.parent[i] >= 0) kids[sk.parent[i]].push(i);
  const q = new THREE.Quaternion(), axis = new THREE.Vector3(), dm = new THREE.Vector3(), ds = new THREE.Vector3();
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (sk.trunk[i] || kids[i].length < 2 || sk.parent[i] < 0) continue;
    // continuing axis = the child most aligned with the incoming direction
    _v.subVectors(sk.p[i], sk.p[sk.parent[i]]).normalize();
    let mainC = -1, bestD = -2;
    for (const c of kids[i]) { const d = _w.subVectors(sk.p[c], sk.p[i]).normalize().dot(_v); if (d > bestD) { bestD = d; mainC = c; } }
    dm.subVectors(sk.p[mainC], sk.p[i]).normalize();
    ds.set(0, 0, 0);
    for (const c of kids[i]) if (c !== mainC) ds.add(_w.subVectors(sk.p[c], sk.p[i]).normalize());
    // turn away from the side branches, plus some randomness
    axis.crossVectors(ds, dm);
    if (axis.lengthSq() < 1e-6) axis.set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
    axis.normalize();
    axis.x += rng.range(-0.5, 0.5); axis.y += rng.range(-0.5, 0.5); axis.z += rng.range(-0.5, 0.5);
    axis.normalize();
    q.setFromAxisAngle(axis, THREE.MathUtils.degToRad(rng.range(8, 15)));
    const pivot = sk.p[i];
    stack.length = 0; stack.push(mainC);
    while (stack.length) {
      const j = stack.pop();
      sk.p[j].sub(pivot).applyQuaternion(q).add(pivot);
      if (sk.p[j].x < env.clear(sk.p[j].y)) sk.p[j].x = env.clear(sk.p[j].y);
      for (const c of kids[j]) stack.push(c);
    }
  }
}

/**
 * Short leaf-bearing shoots. Space colonisation alone leaves long bare limbs; real crowns
 * carry their leaves on many short side shoots. inner: a second, shorter and sparser pass
 * along the branches inside the crown, so the interior holds twigs and small leaf clumps.
 */
function addSpurs(tpl, env, sk, rng, inner) {
  const n0 = sk.n;
  const kidsN = new Uint8Array(n0);
  for (let i = 1; i < n0; i++) if (sk.parent[i] >= 0) kidsN[sk.parent[i]]++;
  const cn = new THREE.Vector3(), d = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 1; i < n0; i++) {
    if (sk.trunk[i] || kidsN[i] >= 3 || sk.noGrow[i]) continue;
    const p = sk.p[i];
    const rn = env.rn(p.x, p.y, p.z);
    if (inner) {
      if (rn > 0.6 || rng.next() > tpl.spurs * 0.5) continue;
    } else if (rn < 0.35 || rng.next() > tpl.spurs * Math.min(1, (rn - 0.25) * 1.6)) continue;
    env.normal(p.x, p.y, p.z, cn);
    d.subVectors(p, sk.p[sk.parent[i]]).normalize().multiplyScalar(0.4).addScaledVector(cn, inner ? 0.25 : 0.5);
    d.x += rng.range(-0.6, 0.6); d.y += rng.range(-0.2, 0.45); d.z += rng.range(-0.6, 0.6);
    d.normalize();
    const len = inner ? rng.range(0.08, 0.18) : rng.range(0.14, 0.3);
    q.copy(p).addScaledVector(d, len * 0.5);
    if (q.x < env.clear(q.y)) continue;
    const a = sk.add(q, i, false, true);
    q.addScaledVector(d, len * 0.5);
    q.y += rng.range(-0.03, 0.04);
    sk.add(q, a, false, true);
  }
}

/** Children lists, pipe-model radii, smoothing, droop, chains, wind data. */
function finishSkeleton(tpl, env, sk, rng) {
  const n = sk.n;
  const kids = Array.from({ length: n }, () => []);
  for (let i = 1; i < n; i++) if (sk.parent[i] >= 0) kids[sk.parent[i]].push(i);
  // pipe model (children always have larger indices than their parent)
  const TIP = 0.004, EXP = 2.3;
  const rp = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    if (!kids[i].length) { rp[i] = TIP; continue; }
    let s = 0;
    for (const c of kids[i]) s += Math.pow(rp[c], EXP);
    rp[i] = Math.pow(s, 1 / EXP);
  }
  const r = new Float32Array(n);
  const R0 = rp[0];
  for (let i = 0; i < n; i++) {
    let v = TIP + (rp[i] - TIP) * (tpl.trunkR - TIP) / Math.max(1e-6, R0 - TIP);
    if (sk.trunk[i]) {
      const y = sk.p[i].y;
      v *= 1 + 0.1 * Math.max(0, 1 - y / Math.max(1, tpl.crownBase)); // taper of the stem
      if (y < 0.35) v *= 1 + (tpl.mature ? 0.45 : 0.12) * (1 - y / 0.35) ** 2; // root flare
    }
    r[i] = Math.max(v, 0.004);
  }
  // main child = thickest
  const main = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let b = -1, br = -1;
    for (const c of kids[i]) if (rp[c] > br) { br = rp[c]; b = c; }
    main[i] = b;
  }
  // one light smoothing pass of the crown structure (keeps the kinks)
  {
    const np = sk.p.map((p) => p.clone());
    for (let i = 0; i < n; i++) {
      if (sk.trunk[i] || sk.parent[i] < 0 || main[i] < 0) continue;
      const a = sk.p[sk.parent[i]], b = sk.p[main[i]];
      np[i].multiplyScalar(0.7).addScaledVector(a, 0.15).addScaledVector(b, 0.15);
    }
    sk.p = np;
  }
  // path length from the stem (wind amplitude) and droop of slender shoots
  const path = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const pa = sk.parent[i];
    path[i] = sk.trunk[i] ? 0 : path[pa] + sk.p[i].distanceTo(sk.p[pa]);
  }
  const drop = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    if (sk.trunk[i]) continue;
    const pa = sk.parent[i];
    const slender = 1 - Math.min(1, r[i] / (tpl.trunkR * 0.6));
    drop[i] = drop[pa] + tpl.droop * 0.07 * slender * slender * sk.p[i].distanceTo(sk.p[pa]) * Math.min(2, path[i]);
  }
  for (let i = 0; i < n; i++) sk.p[i].y -= drop[i];

  // chains: follow the main child; other children start new chains at their branch point
  const chains = [];
  const chainOf = new Int32Array(n).fill(-1);
  const stack = [{ start: 0, from: -1, level: 0, parentChain: -1 }];
  while (stack.length) {
    const { start, from, level, parentChain } = stack.pop();
    const nodes = from >= 0 ? [from] : [];
    let i = start;
    const id = chains.length;
    while (i >= 0) {
      nodes.push(i);
      chainOf[i] = id;
      for (const c of kids[i]) if (c !== main[i]) stack.push({ start: c, from: i, level: level + 1, parentChain: id });
      i = main[i];
    }
    chains.push({ nodes, level, parentChain });
  }
  // wind phase per limb: level-1 chains define the phase, deeper ones add a small offset
  const phase = new Float32Array(chains.length);
  for (let c = 0; c < chains.length; c++) {
    const ch = chains[c];
    phase[c] = ch.level === 0 ? 0 : ch.level === 1 ? rng.range(0, 6.283) : phase[ch.parentChain] + rng.range(-0.6, 0.6);
  }
  const amp = new Float32Array(n);
  for (let i = 0; i < n; i++) amp[i] = Math.pow(Math.min(1, path[i] / (env.R * 1.6)), 1.3);
  return { kids, r, main, chains, chainOf, phase, amp, path };
}

// ------------------------------------------------------------------ geometry buffers
/** Growable vertex / index lists with named attributes of fixed sizes. */
class Buf {
  constructor(spec) {
    this.spec = spec; // { name: itemSize }
    this.a = {};
    for (const k of Object.keys(spec)) this.a[k] = [];
    this.idx = [];
    this.count = 0;
  }
  /** Append one vertex: values in spec order (arrays or numbers). */
  vert(...vals) {
    let j = 0;
    for (const k of Object.keys(this.spec)) {
      const v = vals[j++], arr = this.a[k];
      if (typeof v === 'number') arr.push(v);
      else if (v.isVector3) arr.push(v.x, v.y, v.z);
      else for (let i = 0; i < this.spec[k]; i++) arr.push(v[i]);
    }
    return this.count++;
  }
  geometry(reverse = false) {
    const g = new THREE.BufferGeometry();
    const names = { pos: 'position', nor: 'normal', uv: 'uv', col: 'color' };
    for (const [k, size] of Object.entries(this.spec)) g.setAttribute(names[k] || k, new THREE.Float32BufferAttribute(this.a[k], size));
    let idx = this.idx;
    if (reverse) {
      idx = idx.slice();
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.userData.shared = true;
    return g;
  }
}
const LEAF_SPEC = { pos: 3, nor: 3, uv: 2, col: 3, aVeg: 4, aCrown: 4, aCard: 4 };
const BARK_SPEC = { pos: 3, nor: 3, uv: 2, col: 3, aVeg: 4, aBark: 1 };

/** Tapered tubes along every chain thicker than minR. */
function barkGeometry(tpl, env, sk, info, lod, rng) {
  const b = new Buf(BARK_SPEC);
  const minR = [0.0045, 0.015, 0.04][lod];
  const N = new THREE.Vector3(), B = new THREE.Vector3(), T = new THREE.Vector3();
  const q = new THREE.Vector3(), cn = new THREE.Vector3(), p = new THREE.Vector3();
  const youth = tpl.mature ? 0.25 : 1;
  for (let c = 0; c < info.chains.length; c++) {
    const ch = info.chains[c];
    const nodes = ch.nodes;
    if (nodes.length < 2) continue;
    const r0 = info.r[nodes[Math.min(1, nodes.length - 1)]];
    if (r0 < minR) continue;
    const sides = lod === 2 ? (r0 > 0.06 ? 6 : 4)
      : lod === 1 ? (r0 > 0.06 ? 8 : r0 > 0.03 ? 6 : 4)
      : (r0 > 0.06 ? 11 : r0 > 0.03 ? 8 : r0 > 0.015 ? 6 : r0 > 0.008 ? 4 : 3);
    const circ = Math.max(0.05, 2 * Math.PI * r0);
    // bark colour (multiplies the library bark, a warm grey-brown): young stems cool grey
    // with a green cast, shoots greener, old wood darker grey-brown
    const tv = rng.range(0.92, 1.06);
    const tint = tpl.mature
      ? (r0 < 0.015 ? [0.82, 0.9, 0.84] : [0.74, 0.76, 0.8])
      : (r0 < 0.012 ? [0.86, 1.04, 0.82] : [0.9, 1.02, 1.08]);
    const base = b.count;
    let vacc = 0;
    // ring list: (node, position, radius); a collar ring where a child leaves its parent
    const ring = [];
    for (let k = 0; k < nodes.length; k++) {
      const i = nodes[k];
      let rr = info.r[i];
      if (k === 0 && ch.level > 0) rr = Math.min(rr, info.r[nodes[1]] * 1.05); // child starts inside the parent
      if (k === nodes.length - 1 && !info.kids[i].length) rr *= 0.55;
      ring.push([i, sk.p[i], rr]);
      if (k === 0 && ch.level > 0 && lod < 2) {
        const r1 = info.r[nodes[1]], pr = info.r[i];
        const dist = Math.min(pr + r1 * 1.5, sk.p[nodes[1]].distanceTo(sk.p[i]) * 0.5);
        const cp = new THREE.Vector3().subVectors(sk.p[nodes[1]], sk.p[i]).setLength(dist).add(sk.p[i]);
        ring.push([nodes[1], cp, r1 * 1.15, true]);
      }
    }
    // initial frame
    T.subVectors(ring[1][1], ring[0][1]).normalize();
    N.copy(Math.abs(T.y) < 0.9 ? UP : _v.set(1, 0, 0)).cross(T).normalize();
    for (let k = 0; k < ring.length; k++) {
      const [i, pos, rr, collar] = ring[k];
      p.copy(pos);
      if (k > 0) vacc += p.distanceTo(ring[k - 1][1]);
      const a = ring[Math.max(0, k - 1)][1], bb = ring[Math.min(ring.length - 1, k + 1)][1];
      T.subVectors(bb, a).normalize();
      // parallel transport of N
      N.addScaledVector(T, -N.dot(T)).normalize();
      B.crossVectors(T, N);
      // occlusion: crotches, deep crown interior, paving splash at the stem base
      let ao = 1;
      if (ch.level > 0 && k === 0) ao *= 0.65;
      else if (ch.level > 0 && (k === 1 || collar)) ao *= 0.85;
      const rn = env.rn(p.x, p.y, p.z);
      if (!sk.trunk[i] || p.y > tpl.crownBase) ao *= 0.55 + 0.45 * THREE.MathUtils.smoothstep(rn, 0.1, 0.95);
      const dirt = p.y < 0.4 ? 0.72 + 0.28 * (p.y / 0.4) : 1;
      const colr = [tint[0] * tv * dirt, tint[1] * tv * dirt, tint[2] * tv * dirt];
      const veg = [info.phase[c], info.amp[i], 0, ao];
      for (let s = 0; s <= sides; s++) {
        const th = (s / sides) * Math.PI * 2;
        cn.copy(N).multiplyScalar(Math.cos(th)).addScaledVector(B, Math.sin(th));
        q.copy(p).addScaledVector(cn, rr);
        b.vert(q, cn, [(s / sides) * circ, vacc], colr, veg, youth);
      }
    }
    for (let k = 0; k < ring.length - 1; k++) {
      for (let s = 0; s < sides; s++) {
        const a = base + k * (sides + 1) + s, d = a + sides + 1;
        b.idx.push(a, a + 1, d, a + 1, d + 1, d);
      }
    }
  }
  return b;
}

/** Leaf card sites: shoot tips and slender shoots (node indices). */
function leafSites(tpl, env, sk, info, rng) {
  const sites = [];
  for (let i = 1; i < sk.n; i++) {
    if (sk.trunk[i]) continue;
    const p = sk.p[i];
    const rn = env.rn(p.x, p.y, p.z);
    if (rn < 0.15) continue;
    const tip = !info.kids[i].length;
    let k = 0;
    if (tip) k = tpl.cardsPerTip * (rn < 0.35 ? 0.5 : 1);
    else if (info.r[i] < 0.012) k = rn < 0.35 ? 0.25 : tpl.mature ? 0.6 : 0.85;
    else if (info.r[i] < 0.022 && rn > 0.5) k = 0.15;
    while (k > 0) { if (rng.next() < k) sites.push(i); k -= 1; }
  }
  return sites;
}

/**
 * Card descriptors for every site (shared by LOD 0 and 1):
 *   { i, c: centre, d: axis (attachment -> tip), nn: card normal, size, fold, bend, cell,
 *     col, ao, keep (in LOD 1), cross (has a crossed partner) }
 */
function cardLayout(tpl, env, sk, info, sites, rng) {
  const fol = FOLIAGE[tpl.species];
  const cards = [];
  const cn = new THREE.Vector3(), tmp = new THREE.Vector3();
  const tint = fol.tint;
  const lowY = tpl.crownBase + (tpl.height - tpl.crownBase) * 0.45;
  for (const i of sites) {
    const p = sk.p[i], pa = sk.p[sk.parent[i]];
    env.normal(p.x, p.y, p.z, cn);
    const rn = env.rn(p.x, p.y, p.z);
    // Leaf clumps spread out sideways from the shoot: cards point outwards (horizontally,
    // turned at random about the vertical), face up and tilt outwards on the crown sides.
    tmp.set(cn.x, 0, cn.z);
    if (tmp.lengthSq() < 1e-4) tmp.set(p.x - pa.x, 0, p.z - pa.z);
    if (tmp.lengthSq() < 1e-4) tmp.set(1, 0, 0);
    tmp.normalize();
    const d = new THREE.Vector3().subVectors(p, pa).setY(0);
    if (d.lengthSq() > 1e-6) d.normalize();
    d.multiplyScalar(0.3).addScaledVector(tmp, 0.7);
    if (d.lengthSq() < 1e-6) d.copy(tmp);
    d.normalize().applyAxisAngle(UP, rng.range(-1.2, 1.2));
    d.y = rng.range(-0.25, 0.15) - tpl.droop * 0.4;
    d.normalize();
    const tilt = rng.range(0.15, 1.0) * (0.4 + 0.6 * (1 - Math.abs(cn.y)));
    const nn = new THREE.Vector3().copy(UP).addScaledVector(tmp, Math.tan(tilt));
    nn.addScaledVector(d, -nn.dot(d)).normalize();
    nn.applyAxisAngle(d, rng.range(-0.35, 0.35));
    const size = fol.card * rng.range(0.82, 1.15);
    // centred on the shoot: the attachment edge sits 0.45 * size behind it
    const c = new THREE.Vector3().copy(p).addScaledVector(d, size * 0.05);
    // keep the leaf tips out of the tram's clearance envelope on the track side (-x)
    const lim = env.clearLeaf(p.y) + size * 0.5;
    if (c.x < lim) c.x = lim;
    // sunny outer / upper leaves a touch lighter and yellower, plus per-card noise
    const v = rng.range(0.86, 1.1) * (0.94 + 0.08 * Math.max(0, cn.y));
    const h = rng.range(-0.06, 0.06) + 0.04 * Math.max(0, cn.y);
    const col = [tint[0] * v * (1 + h), tint[1] * v, tint[2] * v * (1 - h * 1.5)];
    // interior occlusion (sky light only), dimmer towards the crown centre and underside
    const ao = (0.6 + 0.4 * THREE.MathUtils.smoothstep(rn, 0.2, 1.0)) * (0.85 + 0.15 * (cn.y * 0.5 + 0.5));
    const card = { i, c, d, nn, size, fold: rng.range(0.12, 0.38), bend: rng.range(0.05, 0.2), cell: rng.pick(fol.cells),
      col, ao, keep: rng.next() < 0.6, cross: p.y < lowY && rng.next() < 0.3 };
    cards.push(card);
    if (card.cross) {
      const nn2 = nn.clone().applyAxisAngle(d, (rng.chance(0.5) ? 1 : -1) * rng.range(1.2, 1.57));
      cards.push({ ...card, nn: nn2, cell: rng.pick(fol.cells), size: size * rng.range(0.85, 1.0), cross: false, partner: true });
    }
  }
  return cards;
}

/** Crown-sphere coordinates of a template-space point. */
function crownCoord(env, p, out) {
  const s = env.sphere;
  return out.set(p.x / s.r, (p.y - s.cy) / s.r, p.z / s.r);
}

/**
 * Foliage for one LOD.
 *   0: folded, bent cards (3x3 vertices) for every card;
 *   1: the 60% kept cards, 1.25x larger, folded only (2x3 vertices);
 *   2: crossed clump cards (far range), same colour and occlusion.
 */
function foliageGeometry(tpl, env, sk, info, cards, lod, rng) {
  const fol = FOLIAGE[tpl.species];
  const b = new Buf(LEAF_SPEC);
  const side = new THREE.Vector3(), p3 = new THREE.Vector3(), vn = new THREE.Vector3(), cn = new THREE.Vector3();
  const q = new THREE.Vector3(), base = new THREE.Vector3();
  const R = env.sphere.r;
  if (lod < 2) {
    const rows = lod ? 1 : 2;
    let count = 0;
    for (const k of cards) {
      if (lod === 1 && !k.keep) continue;
      count++;
      const p = sk.p[k.i];
      env.normal(p.x, p.y, p.z, cn);
      const size = k.size * (lod ? 1.25 : 1);
      const { d, nn } = k;
      side.crossVectors(d, nn).normalize();
      const [u0, v0, u1, v1] = cellRect(k.cell);
      base.copy(k.c).addScaledVector(d, -size * 0.5);
      const flutterScale = Math.min(1.3, size / 0.45);
      const bend = lod ? 0 : k.bend;
      const vb = b.count;
      for (let iv = 0; iv <= rows; iv++) {
        const v = iv / rows;
        for (let iu = 0; iu <= 2; iu++) {
          const u = iu / 2;
          const su = (u - 0.5) * size;
          p3.copy(base).addScaledVector(d, v * size).addScaledVector(side, su)
            .addScaledVector(nn, Math.abs(su) * Math.sin(k.fold) - bend * v * v * size);
          // folded-surface normal, blended with the crown normal
          vn.copy(nn).addScaledVector(side, -Math.sign(su) * Math.tan(k.fold)).normalize();
          vn.multiplyScalar(0.5).addScaledVector(cn, 0.5).normalize();
          crownCoord(env, p3, q);
          b.vert(p3, vn, [u0 + u * (u1 - u0), v0 + (0.01 + v * 0.98) * (v1 - v0)], k.col,
            [info.phase[info.chainOf[k.i]], info.amp[k.i], v * flutterScale, k.ao], [q.x, q.y, q.z, R], [nn.x, nn.y, nn.z, su]);
        }
      }
      // winding: front face on the side the card normal points to
      for (let iv = 0; iv < rows; iv++) {
        for (let iu = 0; iu < 2; iu++) {
          const a = vb + iv * 3 + iu, c2 = a + 3;
          b.idx.push(a, a + 1, c2, a + 1, c2 + 1, c2);
        }
      }
    }
    return { buf: b, count };
  }

  // ---- lod 2: clumps of two crossed cards (one facing out, one facing up)
  const sites = [...new Set(cards.filter((k) => !k.partner).map((k) => k.i))];
  const n = Math.max(6, Math.round(cards.length * (fol.card / fol.clumpCard) ** 2 * 0.9));
  for (let i = sites.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [sites[i], sites[j]] = [sites[j], sites[i]]; }
  const byNode = new Map();
  for (const k of cards) if (!byNode.has(k.i)) byNode.set(k.i, k);
  const out = new THREE.Vector3(), nn = new THREE.Vector3(), d = new THREE.Vector3();
  let count = 0;
  for (let s = 0; s < Math.min(n, sites.length); s++) {
    const i = sites[s], k = byNode.get(i);
    const p = sk.p[i];
    env.normal(p.x, p.y, p.z, cn);
    const size = fol.clumpCard * rng.range(0.85, 1.15);
    base.copy(p).addScaledVector(cn, -0.12);
    base.x = Math.max(base.x, env.clearLeaf(base.y) + size * 0.5);
    out.set(cn.x, 0, cn.z);
    if (out.lengthSq() < 1e-4) out.set(1, 0, 0);
    out.normalize();
    const [u0, v0, u1, v1] = cellRect(rng.pick(fol.clumps));
    const rot = rng.range(0, Math.PI * 2);
    for (let c = 0; c < 2; c++) {
      // card normal: outward and a little up / up and a little outward
      if (c === 0) nn.copy(out).addScaledVector(UP, rng.range(0.2, 0.6)).normalize();
      else nn.copy(UP).addScaledVector(out, rng.range(0.2, 0.6)).normalize();
      d.set(-nn.z, 0, nn.x);
      if (d.lengthSq() < 1e-4) d.set(1, 0, 0);
      d.normalize().applyAxisAngle(nn, rot + c * 1.3);
      side.crossVectors(d, nn).normalize();
      vn.copy(nn).multiplyScalar(0.35).addScaledVector(cn, 0.65).normalize();
      const vb = b.count;
      for (const [cu, cv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const su = (cu - 0.5) * size;
        p3.copy(base).addScaledVector(side, su).addScaledVector(d, (cv - 0.5) * size);
        crownCoord(env, p3, q);
        b.vert(p3, vn, [u0 + cu * (u1 - u0), v0 + cv * (v1 - v0)], k.col,
          [info.phase[info.chainOf[i]], info.amp[i] * 0.8, 0, k.ao], [q.x, q.y, q.z, R], [nn.x, nn.y, nn.z, su]);
      }
      b.idx.push(vb, vb + 1, vb + 2, vb + 1, vb + 3, vb + 2);
      count++;
    }
  }
  return { buf: b, count };
}

/**
 * Grow one template. Returns { tpl, bark: [[lod0..2], [mirrored lod0..2]], leaves: [lod0..2],
 * stem, stats }. stem(y) gives the stem axis position and radius at height y.
 */
export function buildTreeTemplate(tpl, seed = 1) {
  const rng = RNG.from(seed, 'tree', tpl.id);
  const T0 = performance.now();
  const env = makeEnvelope(tpl, rng);
  const sk = growSkeleton(tpl, env, rng);
  const T1 = performance.now();
  const info = finishSkeleton(tpl, env, sk, rng);
  const T2 = performance.now();
  const barkBufs = [0, 1, 2].map((l) => barkGeometry(tpl, env, sk, info, l, RNG.from(seed, 'bark', l, tpl.id)));
  const sites = leafSites(tpl, env, sk, info, RNG.from(seed, 'sites', tpl.id));
  const cards = cardLayout(tpl, env, sk, info, sites, RNG.from(seed, 'cards', tpl.id));
  const fol = [0, 1, 2].map((l) => foliageGeometry(tpl, env, sk, info, cards, l, RNG.from(seed, 'leaf', l, tpl.id)));
  const stemNodes = [];
  for (let i = 0; i < sk.n; i++) if (sk.trunk[i]) stemNodes.push([sk.p[i].clone(), info.r[i]]);
  stemNodes.sort((a, b) => a[0].y - b[0].y);
  const stem = (y) => {
    for (let i = 1; i < stemNodes.length; i++) {
      if (stemNodes[i][0].y >= y) {
        const [a, ra] = stemNodes[i - 1], [b2, rb] = stemNodes[i];
        const t = (y - a.y) / Math.max(1e-6, b2.y - a.y);
        return { x: a.x + (b2.x - a.x) * t, z: a.z + (b2.z - a.z) * t, r: ra + (rb - ra) * t };
      }
    }
    const [a, ra] = stemNodes[stemNodes.length - 1];
    return { x: a.x, z: a.z, r: ra };
  };
  return {
    tpl, stem,
    bark: [barkBufs.map((x) => x.geometry()), barkBufs.map((x) => x.geometry(true))],
    leaves: fol.map((f) => f.buf.geometry()),
    stats: { nodes: sk.n, cards: fol.map((f) => f.count), chains: info.chains.length,
      ms: [T1 - T0, T2 - T1, performance.now() - T2].map((x) => +x.toFixed(1)) },
  };
}

/**
 * Shrub mound for a planter, in planter space (origin at the soil surface centre), with
 * flowers as upright crossed umbel cards on stalks above the leaves.
 * Returns { leaves: [lod0, lod1 (= lod0), lod2] } (no bark: the stems are hidden in the foliage).
 */
export function buildShrubTemplate(sh, seed = 1) {
  const rng = RNG.from(seed, 'shrub', sh.id);
  const fol = FOLIAGE.shrub;
  const b0 = new Buf(LEAF_SPEC), b1 = new Buf(LEAF_SPEC);
  const p = new THREE.Vector3(), d = new THREE.Vector3(), nn = new THREE.Vector3(), side = new THREE.Vector3();
  const p3 = new THREE.Vector3(), cn = new THREE.Vector3(), vn = new THREE.Vector3(), q = new THREE.Vector3();
  const hw = sh.width / 2, hd = sh.depth / 2;
  const R = Math.max(hw, hd, sh.height);
  const cc = (v) => q.set(v.x / R, (v.y - sh.height * 0.3) / R, v.z / R);
  const card = (buf, cellIdx, size, pos, dir, normal, col, phase, ao, rows, cupped, nblend = 0.6) => {
    const [u0, v0, u1, v1] = cellRect(cellIdx);
    side.crossVectors(dir, normal).normalize();
    const vb = buf.count;
    for (let iv = 0; iv <= rows; iv++) {
      const v = iv / rows;
      for (let iu = 0; iu <= 2; iu++) {
        const u = iu / 2, su = (u - 0.5) * size;
        p3.copy(pos).addScaledVector(dir, v * size).addScaledVector(side, su).addScaledVector(normal, cupped ? Math.abs(su) * 0.25 - 0.1 * v * v * size : 0);
        vn.copy(normal).multiplyScalar(1 - nblend).addScaledVector(cn, nblend).normalize();
        cc(p3);
        buf.vert(p3, vn, [u0 + u * (u1 - u0), v0 + (0.01 + v * 0.98) * (v1 - v0)], col, [phase, 0.25 + 0.4 * v, cupped ? v * 0.6 : v * 0.3, ao],
          [q.x, q.y, q.z, R], [normal.x, normal.y, normal.z, su]);
      }
    }
    for (let iv = 0; iv < rows; iv++) for (let iu = 0; iu < 2; iu++) {
      const a = vb + iv * 3 + iu, c2 = a + 3;
      buf.idx.push(a, a + 1, c2, a + 1, c2 + 1, c2);
    }
  };
  const leafCells = sh.flowers ? [...fol.cells, CELL.pelargonium[0]] : fol.cells;
  for (let s = 0; s < sh.shoots; s++) {
    p.set(rng.range(-hw, hw) * 0.85, rng.range(-0.02, sh.height * 0.45), rng.range(-hd, hd) * 0.85);
    // mound normal: ellipsoid over the planter
    cn.set(p.x / (hw * hw), (p.y + 0.15) / (sh.height * sh.height), p.z / (hd * hd)).normalize();
    d.copy(cn).multiplyScalar(0.7).add(UP).normalize();
    d.x += rng.range(-0.4, 0.4); d.z += rng.range(-0.4, 0.4); d.normalize();
    nn.copy(cn).addScaledVector(UP, 0.6);
    nn.addScaledVector(d, -nn.dot(d)).normalize();
    nn.applyAxisAngle(d, rng.range(-0.6, 0.6));
    const v = rng.range(0.86, 1.1);
    const ao = 0.55 + 0.45 * Math.min(1, (p.y + 0.05) / (sh.height * 0.6));
    card(b0, rng.pick(leafCells), fol.card * rng.range(0.8, 1.2), p, d, nn, [v, v, v], rng.range(0, 6.28), ao, 2, true);
  }
  // flowers: umbels on stalks, two upright cards crossed at 90 degrees
  for (let f = 0; f < sh.flowers; f++) {
    p.set(rng.range(-hw, hw) * 0.78, sh.height * rng.range(0.35, 0.62), rng.range(-hd, hd) * 0.78);
    cn.set(p.x / (hw * hw), p.y / (sh.height * sh.height), p.z / (hd * hd)).normalize();
    const h = rng.range(0.18, 0.26);
    d.set(rng.range(-0.12, 0.12), 1, rng.range(-0.12, 0.12)).normalize();
    const a0 = rng.range(0, Math.PI);
    const tint = rng.pick([[1, 1, 1], [1.05, 0.85, 1.25], [0.95, 1.1, 1.1], [1.08, 1.0, 0.9]]);
    for (let k = 0; k < 2; k++) {
      nn.set(Math.cos(a0 + k * Math.PI / 2), 0, Math.sin(a0 + k * Math.PI / 2));
      nn.addScaledVector(d, -nn.dot(d)).normalize();
      // the cell's attachment edge (v0) is the top of the umbel: build from the top down
      p3.copy(p).addScaledVector(d, h);
      const top = p3.clone();
      card(b0, CELL.umbel[0], h, top, d.clone().negate(), nn.clone(), tint, rng.range(0, 6.28), 0.95, 2, false, 0.2);
    }
  }
  // lod 2: a few crossed clumps over the mound
  const [u0, v0, u1, v1] = cellRect(fol.clumps[0]);
  const nC = Math.max(3, Math.round((sh.width * sh.depth) / 0.12));
  for (let c = 0; c < nC; c++) {
    p.set(rng.range(-hw, hw) * 0.7, sh.height * rng.range(0.25, 0.6), rng.range(-hd, hd) * 0.6);
    cn.set(p.x, p.y + 0.2, p.z).normalize();
    const size = fol.clumpCard * rng.range(0.8, 1.1);
    for (let k = 0; k < 2; k++) {
      nn.copy(k ? UP : cn).addScaledVector(k ? cn : UP, 0.3).normalize();
      d.set(-nn.z, 0, nn.x); if (d.lengthSq() < 1e-4) d.set(1, 0, 0); d.normalize().applyAxisAngle(nn, rng.range(0, 6.28));
      side.crossVectors(d, nn).normalize();
      const vb = b1.count;
      for (const [cu, cv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const su = (cu - 0.5) * size;
        p3.copy(p).addScaledVector(side, su).addScaledVector(d, (cv - 0.5) * size);
        cc(p3);
        b1.vert(p3, cn, [u0 + cu * (u1 - u0), v0 + cv * (v1 - v0)], [1, 1, 1], [0, 0.2, 0, 0.85], [q.x, q.y, q.z, R], [nn.x, nn.y, nn.z, su]);
      }
      b1.idx.push(vb, vb + 1, vb + 2, vb + 1, vb + 3, vb + 2);
    }
  }
  const g0 = b0.geometry(), g2 = b1.geometry();
  return { leaves: [g0, g0, g2] };
}
