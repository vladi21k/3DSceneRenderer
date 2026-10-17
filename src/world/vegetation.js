import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { TEMPLATES, SHRUBS } from './vegetation/species.js';
import { buildLeafAtlas } from './vegetation/leafAtlas.js';
import { buildTreeTemplate, buildShrubTemplate } from './vegetation/treeGen.js';
import { createVegMaterials } from './vegetation/vegMaterials.js';
import { InstancePool, VegetationPools } from './vegetation/pool.js';
import { createProps } from './vegetation/props.js';

// Street trees and planters. Contract: docs/ARCHITECTURE.md
//
// init: paints the foliage atlas, grows the tree / shrub templates (both LODs) and puts
//       them into two BatchedMeshes (bark, foliage) shared by the whole street.
// build: per chunk, adds one instance per tree (template picked per species zone, scaled
//       to the planned height / crown, yawed so the pruned side faces the tracks, tinted)
//       and merges the small static props (tree grates, stakes and ties, planter boxes).
// dispose: removes the chunk's instances. Visibility follows the chunk group (pool.js).

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color();
const _yAxis = new THREE.Vector3(0, 1, 0);

const vegetation = {
  name: 'vegetation',

  async init(app) {
    this.app = app;
    const seed = app.layout.seed;
    const t0 = performance.now();
    this.atlas = buildLeafAtlas(app.renderer, seed);
    const t1 = performance.now();
    this.trees = TEMPLATES.map((tpl) => buildTreeTemplate(tpl, seed));
    this.shrubs = SHRUBS.map((sh) => buildShrubTemplate(sh, seed));
    const t2 = performance.now();
    this.mats = createVegMaterials(app, this.atlas);

    // geometry order in the pools: trees [lod0, lod1] per template, then shrubs
    const leafGeoms = [], barkGeoms = [];
    this.trees.forEach((t, i) => {
      t.leafIdx = [leafGeoms.push(t.leaves[0]) - 1, leafGeoms.push(t.leaves[1]) - 1];
      t.barkIdx = [barkGeoms.push(t.bark[0]) - 1, barkGeoms.push(t.bark[1]) - 1];
      t.index = i;
    });
    this.shrubs.forEach((s) => { s.leafIdx = [leafGeoms.push(s.leaves[0]) - 1, leafGeoms.push(s.leaves[1]) - 1]; });
    this.pools = new VegetationPools(app);
    this.leafPool = this.pools.addPool(new InstancePool('vegetation:foliage', this.mats.leaf, this.mats.leafDepth, leafGeoms, 400));
    this.barkPool = this.pools.addPool(new InstancePool('vegetation:bark', this.mats.bark, this.mats.barkDepth, barkGeoms, 300));
    this.props = createProps(app);
    // debug switches: veglod=0|1 forces a LOD, vegshow=bark|leaf hides the other pool
    this.forceLod = app.params.num('veglod', null);
    const show = app.params.str('vegshow');
    if (show === 'bark') this.leafPool.mesh.visible = false;
    if (show === 'leaf') this.barkPool.mesh.visible = false;
    this.stats = {
      atlasMs: +(t1 - t0).toFixed(1), templatesMs: +(t2 - t1).toFixed(1),
      templates: this.trees.map((t) => ({ id: t.tpl.id, ...t.stats,
        tris0: (t.leaves[0].index.count + t.bark[0].index.count) / 3, tris1: (t.leaves[1].index.count + t.bark[1].index.count) / 3 })),
    };
  },

  /** Template for a planned tree: species zones of a few hundred metres, mostly one species. */
  pickTemplate(t) {
    const { route, layout } = this.app;
    const zone = Math.floor(route.wrap(t.s) / 330);
    const zr = RNG.from(layout.seed, 'vegzone', zone);
    const dominant = zr.chance(0.62) ? 'pagoda' : 'ash';
    const other = dominant === 'pagoda' ? 'ash' : 'pagoda';
    const r = new RNG(t.seed ^ 0x5bd1e995);
    if (t.mature) {
      const id = r.weighted(dominant === 'pagoda'
        ? [['pagodaM', 0.5], ['denseM', 0.35], ['ashM', 0.15]]
        : [['ashM', 0.5], ['denseM', 0.35], ['pagodaM', 0.15]]);
      return this.trees.find((x) => x.tpl.id === id);
    }
    const species = r.chance(0.86) ? dominant : other;
    const cands = this.trees.filter((x) => !x.tpl.mature && x.tpl.species === species);
    // prefer templates close to the planned size, keep some randomness
    return r.weighted(cands.map((x) => [x, 1 / (0.35 + Math.abs(x.tpl.height - t.height))]));
  },

  build(chunk, app) {
    const { route, layout } = app;
    const lod = this.forceLod ?? chunk.lod;
    const trees = layout.inChunk('trees', chunk.index);
    const planters = layout.inChunk('furniture', chunk.index).filter((f) => f.type === 'planter');
    if (!trees.length && !planters.length) return null;
    const marker = new THREE.Group();
    marker.name = 'vegetation';
    const rec = this.pools.record(marker);
    const props = this.props.begin(lod);

    for (const t of trees) {
      const T = this.pickTemplate(t);
      const tpl = T.tpl;
      const r = new RNG(t.seed);
      const heading = route.heading(t.s);
      const yaw = (t.side > 0 ? heading - Math.PI / 2 : heading + Math.PI / 2) + r.range(-1, 1) * (tpl.mature ? 0.2 : 0.4);
      const sy = THREE.MathUtils.clamp(t.height / tpl.height, 0.82, 1.22);
      const sxz = THREE.MathUtils.clamp(0.5 * sy + 0.5 * (t.crown / (2 * tpl.crownR)), 0.82, tpl.mature ? 1.12 : 1.2);
      route.toWorld(t.s, t.d, 0, _p);
      _q.setFromAxisAngle(_yAxis, yaw);
      _s.set(sxz, sy, sxz);
      _m.compose(_p, _q, _s);
      // per-tree tint: vigour / light differences between individual trees
      const v = r.range(0.9, 1.07), h = r.range(-0.05, 0.05);
      _c.setRGB(v * (1 + h), v, v * (1 - 2 * h));
      rec.entries.push([this.leafPool, this.leafPool.add(T.leafIdx[lod ? 1 : 0], _m, _c)]);
      const bv = r.range(0.85, 1.1);
      _c.setRGB(bv, bv, bv);
      rec.entries.push([this.barkPool, this.barkPool.add(T.barkIdx[lod ? 1 : 0], _m, _c)]);
      props.tree(t, T, _m, yaw, sy, sxz, r);
    }

    for (const f of planters) {
      const r = RNG.from(layout.seed, 'planter', f.id);
      const kind = r.chance(0.6) ? 0 : 1;
      const S = this.shrubs[kind === 0 ? r.int(0, 1) : 2];
      const yaw = route.heading(f.s) + (f.yaw || 0);
      const top = props.planter(f, kind, yaw, r);
      // shrub mound on the soil, scaled to the planter footprint
      _q.setFromAxisAngle(_yAxis, yaw);
      _s.set(top.sx, 1, top.sz);
      _m.compose(top.pos, _q, _s);
      _c.setRGB(1, 1, 1);
      rec.entries.push([this.leafPool, this.leafPool.add(S.leafIdx[lod ? 1 : 0], _m, _c)]);
    }

    const mesh = props.build();
    if (mesh) marker.add(mesh);
    return marker;
  },

  dispose(obj) {
    this.pools.release(obj.userData.vegRecord);
    obj.traverse((o) => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose(); });
  },
};

export default vegetation;
