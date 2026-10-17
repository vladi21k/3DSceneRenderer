import * as THREE from 'three';
import { facadePlan } from './facadePlan.js';
import { MeshBatcher } from '../core/geom.js';

// Building shells (PLACEHOLDER boxes from the facade plan).
const buildings = {
  name: 'buildings',
  build(chunk, app) {
    const { layout, materials: M } = app;
    const b = new MeshBatcher();
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index)];
    for (const lot of lots) {
      const plan = facadePlan(lot);
      const f = lot.frame;
      const h = plan.totalHeight + 4;
      const box = new THREE.BoxGeometry(f.width, h, plan.depth);
      box.translate(f.width / 2, h / 2 - 4, -plan.depth / 2);
      b.add(M.get('stone.ashlar'), box, f.matrix);
    }
    return b.build({ name: 'buildings' });
  },
};
export default buildings;
