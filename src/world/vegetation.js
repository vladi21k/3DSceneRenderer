import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { TEMPLATES, SHRUBS } from './vegetation/species.js';
import { buildLeafAtlas, blankAtlas } from './vegetation/leafAtlas.js';
import { buildTreeTemplate, buildShrubTemplate } from './vegetation/treeGen.js';
import { createVegMaterials } from './vegetation/vegMaterials.js';
import { InstancePool, VegetationPools } from './vegetation/pool.js';
import { createProps } from './vegetation/props.js';
import { createGroundShade } from './vegetation/groundShade.js';

// Street trees and planters. Contract: docs/ARCHITECTURE.md
//
// init: starts painting the foliage atlas (workers) while the tree / shrub templates grow
//       (three detail levels each, bark also mirrored), puts them into two BatchedMeshes
//       (bark, foliage) shared by the street, and plans every tree of the layout once:
//       template (species zones, never the same as the previous tree on that side),
//       mirror, scale (planned height / crown, x and z apart), lean, yaw and tint.
//       It does not wait for the atlas: the leaf materials start on blank stand-ins (no
//       leaves drawn, same shader programs) and take the atlas when the painting ends,
//       in the background while the other modules start, long before the first frame.
//       The painting runs on CPU canvases (atlasPaint.js), so it never waits behind the
//       start-up compile in the GPU process, and `atlasReady` (settled once the atlas is
//       on the materials) is one of core's readiness gates: the ride never starts bare.
//       The drawn size of every tree goes back into layout.trees (_writeBack).
// build: per chunk, adds one instance per tree and per prop (stakes and ties, planter
//       boxes, raised tree beds; planters come from layout.furniture entries of type
//       'planter', the beds from _planBeds). The tree
//       grates are paving details drawn by the street module. The chunk's trees also get
//       a soft sky-occlusion disc on the paving under their crowns (groundShade.js).
// per frame (pool.js): instance visibility follows the chunk group, detail level follows
//       the tree's projected size on screen (cross-faded). Until the app is ready every
//       pool draws invisible warm-up instances (VegetationPools.warmup), so no program has
//       its first draw mid-ride.
// dispose: removes the chunk's instances.
//
// Debug URL switches: veglod=0|1|2 forces a detail level, vegshow=bark|leaf,
// vegdbg=1..4 shows one leaf lighting term (direct diffuse / specular, indirect diffuse /
// specular).

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color(), _e = new THREE.Euler();
const _yAxis = new THREE.Vector3(0, 1, 0);
const CLEAR_STEM = 2.85;     // m: lowest crown base of a young street tree
const LEAF_CLEAR = 2.45;     // m: lowest hanging leaves of a young street tree
const BARK_LOD_SIZE = 0.65;  // bark picks its detail level as if the tree were this much smaller
const _planter = { pos: new THREE.Vector3(), sx: 1, sz: 1 };

const vegetation = {
  name: 'vegetation',

  async init(app) {
    this.app = app;
    const seed = app.layout.seed;
    const t0 = performance.now();
    const atlasP = buildLeafAtlas(app.renderer, seed); // painted off the main thread
    this.trees = TEMPLATES.map((tpl) => buildTreeTemplate(tpl, seed));
    // drawn crown of each template (detail 0): lowest leaves and horizontal reach
    for (const t of this.trees) {
      const g = t.leaves[0];
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox;
      t.leafMinY = b.min.y;
      t.leafMaxY = b.max.y;
      t.leafR = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z);
      t.leafW = [b.max.x - b.min.x, b.max.z - b.min.z];
    }
    this.shrubs = SHRUBS.map((sh) => ({ sh, ...buildShrubTemplate(sh, seed) }));
    const t1 = performance.now();
    this.mats = createVegMaterials(app, blankAtlas());
    this.atlasReady = atlasP.then((atlas) => {
      this.atlas = atlas;
      this.mats.setAtlas(atlas);
      if (this.stats) { this.stats.atlas = atlas.ms; this.stats.initMs.atlasDone = +(performance.now() - t0).toFixed(1); }
    }, (e) => console.error('[vegetation] leaf atlas failed', e));

    // pool geometry lists: three detail levels per template (shrub L1 shares L0)
    const leafGeoms = [], barkGeoms = [];
    const put = (list, g) => { const i = list.indexOf(g); return i >= 0 ? i : list.push(g) - 1; };
    for (const t of this.trees) {
      t.leafIdx = t.leaves.map((g) => put(leafGeoms, g));
      t.barkIdx = t.bark.map((set) => set.map((g) => put(barkGeoms, g)));
    }
    for (const sh of this.shrubs) sh.leafIdx = sh.leaves.map((g) => put(leafGeoms, g));
    this.leafGeoms = leafGeoms; this.barkGeoms = barkGeoms;   // (farTree)
    this.pools = new VegetationPools(app);
    // foliage shadows: the cascade texels hold the leaf clumps of detail level 1 even in the
    // finest cascade (the same dapple, 40 % fewer cards)
    this.leafPool = this.pools.addPool(new InstancePool('vegetation:foliage', this.mats.leaf, this.mats.leafDepth, leafGeoms, 400,
      { preMaterial: this.mats.leafPre, farMaterial: this.mats.leafFar, shadowLevels: [0.012, 0.07] }));
    // bark: twigs and thin branches are sub-texel sooner than leaf clumps
    this.barkPool = this.pools.addPool(new InstancePool('vegetation:bark', this.mats.bark, this.mats.barkDepth, barkGeoms, 300, { shadowLevels: [0.012, 0.03] }));
    this.props = createProps(app, this.pools);
    this.groundShade = createGroundShade(app);
    this.plan = this._planTrees();
    this.beds = this._planBeds();
    this._writeBack();
    // debug switches (see header)
    this.pools.forceLod = app.params.num('veglod', null);
    const show = app.params.str('vegshow');
    if (show === 'bark') this.leafPool.mesh.visible = false; // (the twins follow)
    if (show === 'leaf') this.barkPool.mesh.visible = false;
    // warm-up: one throw-away chunk build so the first real chunk does not pay for JIT
    const warm = this._build({ index: app.layout.chunkIndex(app.startS), lod: 0 }, app);
    if (warm) this.dispose(warm);
    this.stats = {
      build: [{ n: 0, total: 0, max: 0 }, { n: 0, total: 0, max: 0 }],
      initMs: { templates: +(t1 - t0).toFixed(1), total: +(performance.now() - t0).toFixed(1) },
      atlas: null,
      mature: +([...this.plan.values()].filter((p) => p.mature).length / Math.max(1, this.plan.size)).toFixed(3),
      templates: this.trees.map((t) => ({ id: t.tpl.id, ...t.stats,
          tris: [0, 1, 2].map((l) => (t.leaves[l].index.count + t.bark[0][l].index.count) / 3) })),
    };
  },

  /**
   * Plan every tree once (deterministic, independent of chunk build order): template,
   * mirror, instance matrix, tints and LOD size. Species come in zones of a few hundred
   * metres, each side of the street planted on its own (mostly one species, some of the
   * others mixed in); a tree never repeats the template of the previous tree on its side,
   * nor the template + mirror of the one before. The main avenue (the first 1.5 km) is a
   * replanted line of young, open trees (about 5-6.5 m, clear stems of 2.5-3 m, facades
   * and shopfronts showing through and above them) with about one old tree in ten (8-11 m
   * tall, crowns 5-7 m across); elsewhere about one in six is old.
   */
  _planTrees() {
    const { route, layout } = this.app;
    const plan = new Map();
    const last = { '-1': [], '1': [] };
    const trees = layout.trees.slice().sort((a, b) => a.side - b.side || a.s - b.s);
    for (const t of trees) {
      const zone = Math.floor(route.wrap(t.s) / 330);
      const zr = RNG.from(layout.seed, 'vegzone', zone, t.side);
      const dominant = zr.weighted([['pagoda', 0.4], ['ash', 0.3], ['dense', 0.3]]);
      const r = new RNG(t.seed ^ 0x5bd1e995);
      // old planting: the layout's mature trees, plus some of its young ones on the avenue
      // and round the stations
      const sw = route.wrap(t.s);
      const old = sw < 1500 || layout.stations.some((st) => Math.abs(route.delta(st.s, t.s)) < 90);
      const avenue = sw < 1500;
      const mature = t.mature ? r.chance(avenue ? 0.75 : old ? 0.85 : 0.8) : r.chance(avenue ? 0.015 : old ? 0.04 : 0.03);
      // planned sizes: young trees are kept small (the layout plans them a little bigger),
      // old ones at least 5 m across
      const height = mature ? (t.mature ? t.height * 0.97 : r.range(8.2, 10.5)) : (t.mature ? r.range(5.0, 7.2) : t.height) * 0.9;
      const crown = mature ? (t.mature ? Math.max(5, t.crown * 1.05) : r.range(5, 7)) : (t.mature ? r.range(2.6, 3.8) : t.crown) * 0.82;
      const prev = last[t.side];
      let T = null, mirror = 0;
      for (let tries = 0; tries < 8; tries++) {
        let cand;
        if (mature) {
          const id = r.weighted(dominant === 'pagoda' ? [['pagodaM', 0.55], ['denseM', 0.25], ['ashM', 0.2]]
            : dominant === 'ash' ? [['ashM', 0.55], ['denseM', 0.25], ['pagodaM', 0.2]]
              : [['denseM', 0.55], ['pagodaM', 0.25], ['ashM', 0.2]]);
          cand = this.trees.find((x) => x.tpl.id === id);
        } else {
          const species = r.chance(0.75) ? dominant : r.pick(['pagoda', 'ash', 'dense'].filter((x) => x !== dominant));
          const cands = this.trees.filter((x) => !x.tpl.mature && x.tpl.species === species);
          // prefer templates close to the planned size, keep some randomness
          cand = r.weighted(cands.map((x) => [x, 1 / (0.35 + Math.abs(x.tpl.height - height))]));
        }
        const mir = r.chance(0.5) ? 1 : 0;
        T = cand; mirror = mir;
        const p1 = prev[prev.length - 1], p2 = prev[prev.length - 2];
        if (p1 && p1.T === cand) continue;
        if (p2 && p2.T === cand && p2.mirror === mir) continue;
        break;
      }
      const tpl = T.tpl;
      const heading = route.heading(t.s);
      // the pruned (clearance) side of the template faces the tracks; some yaw jitter
      const yaw = (t.side > 0 ? heading - Math.PI / 2 : heading + Math.PI / 2) + r.range(-1, 1) * (tpl.mature ? 0.15 : 0.25);
      // young trees keep a clear stem of at least CLEAR_STEM and no leaves below LEAF_CLEAR
      // (pruned for the sidewalk: the crowns start about the cab eye, so shopfronts and café
      // umbrellas read under them)
      const sy = THREE.MathUtils.clamp(height / tpl.height, tpl.mature ? 0.82 : Math.max(0.82, CLEAR_STEM / tpl.crownBase, LEAF_CLEAR / T.leafMinY), 1.22);
      const sxz = THREE.MathUtils.clamp(0.5 * sy + 0.5 * (crown / (2 * tpl.crownR)), 0.82, tpl.mature ? 1.15 : 1.2);
      const sx = sxz * r.range(0.9, 1.1), sz = sxz * r.range(0.9, 1.1) * (mirror ? -1 : 1);
      // lean: mostly away from the tracks (local +x), a little along the street
      _e.set(r.range(-0.035, 0.035), 0, r.range(-0.045, 0.015));
      route.toWorld(t.s, t.d, 0, _p);
      _q.setFromAxisAngle(_yAxis, yaw).multiply(_q2.setFromEuler(_e));
      const matrix = new THREE.Matrix4().compose(_p, _q, _s.set(sx, sy, sz));
      // per-tree tint: vigour / light differences between individual trees (value about
      // ±8 %, hue about ±6°)
      const v = r.range(0.92, 1.08), h = r.range(-0.14, 0.14), bv = r.range(0.88, 1.08);
      const p = { T, mirror, matrix, pos: _p.clone(), size: tpl.height * sy, sy, sxz, mature, reach: T.leafR * Math.max(Math.abs(sx), Math.abs(sz)),
        spread: 0.5 * (T.leafW[0] * Math.abs(sx) + T.leafW[1] * Math.abs(sz)),
        leafTint: new THREE.Color(v * (1 + h), v, v * (1 - 2 * h)), barkTint: new THREE.Color(bv, bv, bv), seed: t.seed };
      plan.set(t, p);
      prev.push(p);
    }
    return plan;
  },

  /**
   * Raised beds round some street trees (about one in eight on the main avenue, one in
   * twenty elsewhere): a limestone kerb people sit on, with timber seat slats on the side
   * towards the shopfronts and sometimes the tracks. Never at a stop, a cross-street mouth
   * or a café terrace, never where the kerb would meet a bench, bin, pole or anything else
   * in the plan, never two within 12 m on one side. Registered as crowd obstacles (rect,
   * tag treeBed). Map layout tree -> {half, seats, tint, timber}.
   */
  _planBeds() {
    const { route, layout } = this.app;
    const beds = new Map(), half = this.props.bedSize / 2, obs = [], m = 0.35;
    const last = { '-1': -1e9, '1': -1e9 };
    const trees = layout.trees.slice().sort((a, b) => a.side - b.side || a.s - b.s);
    for (const t of trees) {
      const r = RNG.from(layout.seed, 'treeBed', t.id);
      if (!r.chance(route.wrap(t.s) < 1500 ? 0.13 : 0.05)) continue;
      if (route.wrap(t.s) - last[t.side] < 12) continue;
      if (layout.isInStation(t.s, 8) || layout.isInCrossStreet(t.s, t.side, 3) || layout.isInCrossStreet(t.s, 0, 3)) continue;
      let ok = true;
      for (const o of layout.obstaclesNear(t.s, 4)) {
        if (o.kind === 'circle') {
          const ds = Math.abs(route.delta(o.s, t.s)), dd = Math.abs(o.d - t.d);
          if (ds < 0.01 && dd < 0.01) continue;   // the tree itself
          const ex = Math.max(0, ds - half), ey = Math.max(0, dd - half);
          if (ex * ex + ey * ey < (o.r + m) ** 2) { ok = false; break; }
        } else if (route.delta(o.s0, t.s) > -(half + m) && route.delta(t.s, o.s1) > -(half + m) && t.d > o.d0 - half - m && t.d < o.d1 + half + m) { ok = false; break; }
      }
      if (!ok) continue;
      const out = t.side > 0 ? 'z+' : 'z-';
      const v = r.range(0.92, 1.04), tv = r.range(0.92, 1.05);
      const timber = r.chance(0.5) ? new THREE.Color(0.82 * tv, 0.8 * tv, 0.78 * tv) : new THREE.Color(0.86 * tv, 0.63 * tv, 0.43 * tv);
      beds.set(t, { half, seats: r.chance(0.35) ? [out, out === 'z+' ? 'z-' : 'z+'] : [out], tint: new THREE.Color(v, v, v * 0.985), timber });
      obs.push({ kind: 'rect', s0: t.s - half, s1: t.s + half, d0: t.d - half, d1: t.d + half, treeBed: t.id });
      last[t.side] = route.wrap(t.s);
    }
    if (layout.addObstacles) layout.addObstacles(obs); else layout.obstacles.push(...obs);
    return beds;
  },

  /**
   * The drawn trees go back into the shared plan, so every module sees them as drawn
   * (café canopies, lamp pools, signals, the crowd, parked bicycles, the far field): per
   * layout tree, `height` (m, top of the crown above the paving), `crown` (m, the spread
   * of its leaves: mean width across the two crown axes), `mature` (an old tree as
   * drawn), plus `crownR` (m, the farthest reach of its leaves from the stem, for
   * clearances: crowns are pruned on the track side, so they are not centred on the
   * stem), `crownBase` (m, its lowest leaves above the paving), `species`,
   * `template`, `drawn: true` and the layout's own values in `planned` {height, crown,
   * mature}, and `bed` {half (m), h (m), seats} for a tree standing in a raised bed.
   * Modules that read layout.trees in their own init before vegetation's still see the
   * planned values.
   */
  _writeBack() {
    for (const [t, P] of this.plan) {
      if (!t.planned) t.planned = { height: t.height, crown: t.crown, mature: t.mature };
      t.height = +(P.T.leafMaxY * P.sy).toFixed(2);
      t.crownR = +P.reach.toFixed(2);
      t.crown = +P.spread.toFixed(2);
      t.crownBase = +(P.T.leafMinY * P.sy).toFixed(2);
      t.mature = P.mature;
      t.species = P.T.tpl.species;
      t.template = P.T.tpl.id;
      t.drawn = true;
      const bed = this.beds && this.beds.get(t);
      if (bed) t.bed = { half: bed.half, h: 0.44, seats: bed.seats };
    }
  },

  build(chunk, app) {
    const t0 = performance.now();
    const obj = this._build(chunk, app);
    const b = this.stats.build[chunk.lod ? 1 : 0], dt = performance.now() - t0;
    b.n++; b.total += dt; b.max = Math.max(b.max, dt);
    return obj;
  },

  _build(chunk, app) {
    const { route, layout } = app;
    const lod = chunk.lod; // props only: trees and shrubs pick their detail per frame
    const trees = layout.inChunk('trees', chunk.index);
    const planters = layout.inChunk('furniture', chunk.index).filter((f) => f.type === 'planter');
    if (!trees.length && !planters.length) return null;
    const marker = new THREE.Group();
    marker.name = 'vegetation';
    const rec = this.pools.record(marker);
    const props = this.props.begin(rec, lod);
    const shade = [];

    for (const t of trees) {
      const P = this.plan.get(t);
      if (!P) continue;
      const T = P.T;
      // sky occlusion under the crown: open young crowns hide less of the sky
      const sy = P.size / T.tpl.height;
      shade.push({ s: t.s, d: t.d, side: t.side, r: T.tpl.crownR * P.sxz, h: 0.5 * (T.tpl.crownBase + T.tpl.height) * sy, k: P.mature ? 0.36 : 0.22 });
      this.pools.add(rec, this.leafPool, T.leafIdx, P.matrix, P.leafTint, P.pos, P.size);
      // bark detail steps down sooner than the crown's: its twigs are sub-pixel long before
      // the leaf clumps are (and mostly hidden by them)
      this.pools.add(rec, this.barkPool, T.barkIdx[P.mirror], P.matrix, P.barkTint, P.pos, P.size * BARK_LOD_SIZE);
      const bed = this.beds.get(t);
      if (!lod) props.tree(t, T, P.matrix, P.sxz, new RNG(P.seed ^ 0x2545f491), !!bed);
      if (bed) props.bed(t, bed);
    }

    for (const f of planters) {
      const r = RNG.from(layout.seed, 'planter', f.id);
      const kind = r.chance(0.6) ? 0 : 1;
      const yaw = route.heading(f.s) + (f.yaw || 0);
      const top = props.planter(f, kind, yaw, _planter);
      // shrub mound on the soil, scaled to the planter footprint; turned / mirrored and
      // tinted per planter so neighbours never match
      const variants = this.shrubs.filter((s) => s.sh.kind === kind);
      const S = variants[r.int(0, variants.length - 1)];
      _q.setFromAxisAngle(_yAxis, yaw + (r.chance(0.5) ? Math.PI : 0));
      _s.set(top.sx, r.range(0.9, 1.1), top.sz * (r.chance(0.5) ? -1 : 1));
      _m.compose(top.pos, _q, _s);
      const v = r.range(0.88, 1.08), h = r.range(-0.06, 0.06);
      _c.setRGB(v * (1 + h), v, v * (1 - 2 * h));
      this.pools.add(rec, this.leafPool, S.leafIdx, _m, _c, top.pos, 1.4);
    }
    const ground = this.groundShade.build(shade);
    if (ground) marker.add(ground);
    return marker;
  },

  /**
   * For the far field beyond the streamed range: layout tree t as vegetation draws it at
   * its coarsest detail (the level its far trees already show inside the streamed range,
   * so the hand-over matches). {leaf, bark: shared BufferGeometry (never dispose), matrix:
   * world Matrix4, leafTint, barkTint: Color (instance colours), template: id}, or null.
   * Draw them with farMaterials() {leaf, bark} on BatchedMeshes, the mesh kind vegetation
   * itself draws these materials with (an InstancedMesh would add two programs and make
   * three re-evaluate the materials at every switch between the kinds); about 400-3,800
   * triangles a tree.
   */
  farTree(t) {
    const P = this.plan && this.plan.get(t);
    if (!P) return null;
    return { leaf: this.leafGeoms[P.T.leafIdx[2]], bark: this.barkGeoms[P.T.barkIdx[P.mirror][2]], matrix: P.matrix, leafTint: P.leafTint, barkTint: P.barkTint, template: P.T.tpl.id };
  },

  /** The crown of layout tree t as drawn: {r: horizontal reach from the stem (m), base:
   *  height of its lowest leaves above the paving (m)}, or null. (Café canopies use it.) */
  crownAt(t) {
    const P = this.plan && this.plan.get(t);
    if (!P) return null;
    return { r: P.T.leafR * P.sxz * 1.1, base: P.T.leafMinY * P.sy };
  },

  /** Materials for farTree() geometry (registered and tracked). */
  farMaterials() { return { leaf: this.mats.leafFar, bark: this.mats.bark }; },

  update(dt, app) {
    // until ready every pool draws once a frame (see VegetationPools.warmup)
    if (!app.ready) this.pools.warmup(app.camera.position, app.camera.getWorldDirection(_p));
    else if (this.pools.warm) {
      this.pools.endWarmup();
      // (core's ready waits for atlasReady, up to its gate time-out: say so if it gave up)
      if (!this.atlas) console.warn('[vegetation] ready before the leaf atlas arrived: crowns are bare until it does');
    }
    // leaf coverage mode follows the post chain's scene target (its MSAA sample count, 0 = none)
    const post = app.post, rt = post && !post.disabled ? post.sceneRT : null;
    this.mats.params.a2c.value = rt && rt.samples > 0 ? rt.samples : 0;
  },

  dispose(obj) {
    this.pools.release(obj.userData.vegRecord);
    for (const c of obj.children) if (c.geometry) c.geometry.dispose();
  },
};

export default vegetation;
