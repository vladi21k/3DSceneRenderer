import { TRACK_OFFSET, EYE_HEIGHT } from '../core/config.js';
// Cab camera (PLACEHOLDER: rigid). Contract: docs/ARCHITECTURE.md
const cameraRig = {
  name: 'cameraRig',
  update(dt, app) {
    const s = app.train.s;
    const p = app.route.toWorld(s, TRACK_OFFSET, EYE_HEIGHT);
    const t = app.route.toWorld(s + 80, TRACK_OFFSET, EYE_HEIGHT * 0.95);
    app.camera.position.copy(p);
    app.camera.lookAt(t);
    app.cameraS = s;
  },
};
export default cameraRig;
