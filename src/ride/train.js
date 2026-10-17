// Tram dynamics (PLACEHOLDER: constant speed). Contract: docs/ARCHITECTURE.md
const train = {
  name: 'train',
  async init(app) { this.s = app.startS; this.speed = (app.params.speed ?? 30) / 3.6; this.accel = 0; },
  update(dt, app) { this.s = app.route.wrap(this.s + this.speed * dt); },
};
export default train;
