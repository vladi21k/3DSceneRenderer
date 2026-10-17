import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { facadePlan } from './facadePlan.js';
import { Kit } from './facades/kit.js';
import { createInteriorGlass, GLASS_ATTRS } from './facades/interior.js';
import { buildWindowInfill } from './facades/place.js';

// Facade infill: windows, shopfronts, doors, shutters, signage, awnings and small wall
// fittings for every opening of facadePlan(lot), main-street lots, side-street lots and
// corner returns alike. Openings are holes with reveals cut by `buildings`; infill sits at
// w = −opening.recess in the lot frame and matches the hole outline exactly.
//
// Geometry is assembled per chunk into one buffer per material (see facades/geo.js), from
// per-opening templates cached by size and style.

const _m = new THREE.Matrix4(), _t = new THREE.Matrix4();

const facades = {
  name: 'facades',

  async init(app) {
    const M = app.materials;
    const white = new THREE.Color(1, 1, 1);
    const glass = createInteriorGlass();
    M.register('facades.glassInterior', glass);
    this.mats = {
      frame: { material: M.get('paint.frame', { vertexColors: true, color: white }) },
      shutter: { material: M.get('wood.shutter', { vertexColors: true, color: white }) },
      glass: { material: glass, color: false, extra: GLASS_ATTRS, castShadow: false },
    };
    if (app.params.str('fwall')) {
      const { DevWall } = await import('./facades/devwall.js');
      this.devWall = new DevWall(app);
    }
  },

  build(chunk, app) {
    const { layout } = app;
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index)];
    if (!lots.length) return null;
    const kit = new Kit(this.mats, chunk.lod);
    const q = chunk.lod === 0 ? 1 : 0.4;
    for (const lot of lots) {
      const plan = facadePlan(lot);
      const streetW = lot.sideStreet ? lot.cross.width : 2 * lot.d;
      const fronts = [{ plan, frame: lot.frame }];
      for (const r of plan.returns || []) fronts.push({ plan: r, frame: r.frame, streetW: r.width > 0 ? 12 : 12 });
      for (const fr of fronts) {
        const ctx = {
          plan: fr.plan, frame: fr.frame, lot, q, lod: chunk.lod,
          streetW: fr.streetW || streetW,
          angle: Math.atan2(fr.frame.uDir.z, fr.frame.uDir.x),
          rng: RNG.from(fr.plan.seed ?? lot.seed, 'facades', fr.plan.id ?? lot.id),
        };
        ctx.joinery = null;
        for (const o of fr.plan.openings) {
          _m.copy(fr.frame.matrix).multiply(_t.makeTranslation(o.uc, o.y, -o.recess));
          if (o.kind === 'window' || o.kind === 'balconyDoor') buildWindowInfill(kit, ctx, o, _m);
        }
        if (this.devWall) this.devWall.add(kit, ctx);
      }
    }
    const group = new THREE.Group();
    group.name = 'facades';
    kit.meshes(group, 'facades');
    return group;
  },
};

export default facades;
