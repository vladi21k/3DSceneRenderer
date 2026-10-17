import { ribbonGeometry, sweepProfile, MeshBatcher } from '../core/geom.js';
import { TRACK_OFFSET, RAIL_CENTER, RAIL_HEAD_W, TRACK_ZONE_HALF } from '../core/config.js';

// Street surface + embedded tracks (PLACEHOLDER).
const street = {
  name: 'street',
  build(chunk, app) {
    const { route, layout, materials: M } = app;
    const b = new MeshBatcher();
    const s0 = chunk.s0, s1 = chunk.s1;
    b.add(M.get('paving.street'), ribbonGeometry(route, s0, s1, -TRACK_ZONE_HALF, TRACK_ZONE_HALF));
    b.add(M.get('paving.sidewalk'), ribbonGeometry(route, s0, s1, TRACK_ZONE_HALF, (s) => layout.halfWidth(s, 1) + 0.5));
    b.add(M.get('paving.sidewalk'), ribbonGeometry(route, s0, s1, (s) => -layout.halfWidth(s, -1) - 0.5, -TRACK_ZONE_HALF));
    for (const t of [-1, 1]) for (const r of [-1, 1]) {
      const d = t * TRACK_OFFSET + r * RAIL_CENTER;
      const w = RAIL_HEAD_W / 2;
      b.add(M.get('rail.head'), sweepProfile(route, s0, s1, [[d - w, 0.004], [d + w, 0.004]].reverse(), { step: 1 }));
    }
    const g = b.build({ name: 'street', castShadow: false });
    return g;
  },
};
export default street;
