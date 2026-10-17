import * as THREE from 'three';
import { RNG, loopNoise1 } from '../core/rng.js';
import { TEMPLATES, SHRUBS } from './vegetation/species.js';
import { buildLeafAtlas, blankAtlas } from './vegetation/leafAtlas.js';
import { buildTreeTemplate, buildShrubTemplate } from './vegetation/treeGen.js';
import { createVegMaterials } from './vegetation/vegMaterials.js';
import { InstancePool, VegetationPools } from './vegetation/pool.js';
import { createProps } from './vegetation/props.js';

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
// build: per chunk, adds one instance per tree and per prop (stakes and ties, planter
//       boxes; planters come from layout.furniture entries of type 'planter'). The tree
//       grates are paving details drawn by the street module.
// per frame (pool.js): instance visibility follows the chunk group, detail level follows
//       the tree's projected size on screen (cross-faded).
// dispose: removes the chunk's instances.
//
// Debug URL switches: veglod=0|1|2 forces a detail level, vegshow=bark|leaf,
// vegdbg=1..4 shows one leaf lighting term (direct diffuse / specular, indirect diffuse /
// specular).

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color(), _e = new THREE.Euler();
const _yAxis = new THREE.Vector3(0, 1, 0);
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
    this.pools = new VegetationPools(app);
    // foliage shadows: the cascade texels hold the leaf clumps of detail level 1 even in the
    // finest cascade (the same dapple, 40 % fewer cards)
    this.leafPool = this.pools.addPool(new InstancePool('vegetation:foliage', this.mats.leaf, this.mats.leafDepth, leafGeoms, 400,
      { preMaterial: this.mats.leafPre, farMaterial: this.mats.leafFar, shadowLevels: [0.012, 0.07] }));
    // bark: twigs and thin branches are sub-texel sooner than leaf clumps
    this.barkPool = this.pools.addPool(new InstancePool('vegetation:bark', this.mats.bark, this.mats.barkDepth, barkGeoms, 300, { shadowLevels: [0.012, 0.03] }));
    this.props = createProps(app, this.pools);
    this.plan = this._planTrees();
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
   * nor the template + mirror of the one before. About a third of the trees are old
   * (8-11 m, crowns up to the second floor): the layout's mature trees plus some of its
   * young ones, in loose runs of older planting.
   */
  _planTrees() {
    const { route, layout } = this.app;
    const plan = new Map();
    const last = { '-1': [], '1': [] };
    const trees = layout.trees.slice().sort((a, b) => a.side - b.side || a.s - b.s);
    const L = route.length;
    for (const t of trees) {
      const zone = Math.floor(route.wrap(t.s) / 330);
      const zr = RNG.from(layout.seed, 'vegzone', zone, t.side);
      const dominant = zr.weighted([['pagoda', 0.45], ['ash', 0.33], ['dense', 0.22]]);
      const r = new RNG(t.seed ^ 0x5bd1e995);
      // older planting: the layout's mature trees, and young ones promoted in loose runs
      const run = loopNoise1(route.wrap(t.s), L, 90, layout.seed + (t.side > 0 ? 17 : 29));
      const mature = t.mature || r.chance(THREE.MathUtils.clamp(0.21 + 0.32 * run, 0, 0.5));
      const height = mature && !t.mature ? r.range(8.2, 10.8) : t.height;
      const crown = mature && !t.mature ? r.range(4.8, 6.4) : t.crown;
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
      const sy = THREE.MathUtils.clamp(height / tpl.height, 0.82, 1.22);
      const sxz = THREE.MathUtils.clamp(0.5 * sy + 0.5 * (crown / (2 * tpl.crownR)), 0.82, tpl.mature ? 1.12 : 1.2);
      const sx = sxz * r.range(0.9, 1.1), sz = sxz * r.range(0.9, 1.1) * (mirror ? -1 : 1);
      // lean: mostly away from the tracks (local +x), a little along the street
      _e.set(r.range(-0.035, 0.035), 0, r.range(-0.045, 0.015));
      route.toWorld(t.s, t.d, 0, _p);
      _q.setFromAxisAngle(_yAxis, yaw).multiply(_q2.setFromEuler(_e));
      const matrix = new THREE.Matrix4().compose(_p, _q, _s.set(sx, sy, sz));
      // per-tree tint: vigour / light differences between individual trees (value about
      // ±8 %, hue about ±6°)
      const v = r.range(0.92, 1.08), h = r.range(-0.14, 0.14), bv = r.range(0.88, 1.08);
      const p = { T, mirror, matrix, pos: _p.clone(), size: tpl.height * sy, sxz, mature,
        leafTint: new THREE.Color(v * (1 + h), v, v * (1 - 2 * h)), barkTint: new THREE.Color(bv, bv, bv), seed: t.seed };
      plan.set(t, p);
      prev.push(p);
    }
    return plan;
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

    for (const t of trees) {
      const P = this.plan.get(t);
      if (!P) continue;
      const T = P.T;
      this.pools.add(rec, this.leafPool, T.leafIdx, P.matrix, P.leafTint, P.pos, P.size);
      // bark detail steps down sooner than the crown's: its twigs are sub-pixel long before
      // the leaf clumps are (and mostly hidden by them)
      this.pools.add(rec, this.barkPool, T.barkIdx[P.mirror], P.matrix, P.barkTint, P.pos, P.size * BARK_LOD_SIZE);
      if (!lod) props.tree(t, T, P.matrix, P.sxz, new RNG(P.seed ^ 0x2545f491));
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
    return marker;
  },

  update(dt, app) {
    // leaf coverage mode follows the post chain's scene target (its MSAA sample count, 0 = none)
    const post = app.post, rt = post && !post.disabled ? post.sceneRT : null;
    this.mats.params.a2c.value = rt && rt.samples > 0 ? rt.samples : 0;
  },

  dispose(obj) {
    this.pools.release(obj.userData.vegRecord);
  },
};

export default vegetation;
