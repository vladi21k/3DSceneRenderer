import * as THREE from 'three';
import { Tpl } from './geo.js';
import { outlinePts } from './outline.js';

// Development aid (URL parameter fwall=1): a plain stone wall with the facade-plan holes
// and their reveals, so the infill can be inspected while the building shells are not
// available. Never used in normal runs.
export class DevWall {
  constructor(app) {
    this.mat = app.materials.get('stone.ashlar', { vertexColors: true });
    app.systems.facades.mats.devwall = { material: this.mat };
    this._m = new THREE.Matrix4();
  }
  add(kit, ctx) {
    const { plan, frame } = ctx;
    const shape = new THREE.Shape();
    const v0 = Math.min(plan.ground0 ?? 0, plan.ground1 ?? 0) - 0.4;
    shape.moveTo(0, v0); shape.lineTo(plan.width, v0); shape.lineTo(plan.width, plan.totalHeight); shape.lineTo(0, plan.totalHeight);
    const t = new Tpl();
    for (const o of plan.openings) {
      const pts = outlinePts(o, 0);
      const hole = new THREE.Path();
      pts.slice().reverse().forEach((p, i) => (i ? hole.lineTo(o.uc + p[0], o.y + p[1]) : hole.moveTo(o.uc + p[0], o.y + p[1])));
      shape.holes.push(hole);
      // reveal: faces point into the opening
      const ring = (z) => pts.map((p) => [o.uc + p[0], o.y + p[1], z]);
      t.loft([ring(0), ring(-o.recess - 0.06)], true, 0.8);
    }
    const g = new THREE.ShapeGeometry(shape);
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    const b = t.count;
    for (let i = 0; i < pos.count; i++) t.v(pos.getX(i), pos.getY(i), 0, 0, 0, 1, uv.getX(i), uv.getY(i), 1);
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) t.ix(idx[i] + b, idx[i + 1] + b, idx[i + 2] + b);
    void nor; g.dispose();
    const tint = plan.style.tint;
    kit.get('devwall').add(t.bake(), frame.matrix, tint[0] * 0.75, tint[1] * 0.75, tint[2] * 0.75);
  }
}
