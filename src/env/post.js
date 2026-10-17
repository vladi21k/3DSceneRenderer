// Post-processing (PLACEHOLDER): plain render. Owner replaces with the full chain.
const post = {
  name: 'post',
  async init(app) { this.app = app; },
  render(dt, app) { app.renderer.render(app.scene, app.camera); },
  setSize() {},
};
export default post;
