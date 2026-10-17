import * as THREE from 'three';
import { U } from '../core/uniforms.js';

// Environment (PLACEHOLDER): flat sky colour, sun + hemisphere light, basic shadows.
const env = {
  name: 'env',
  async init(app) {
    this.app = app;
    app.scene.background = new THREE.Color(0x9ec3e6);
    app.scene.fog = new THREE.Fog(0xc8d6e2, 150, 1200);
    this.hemi = new THREE.HemisphereLight(0xcfe2ff, 0x8a7a66, 1.2);
    app.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera; c.left = -80; c.right = 80; c.top = 80; c.bottom = -80; c.near = 1; c.far = 600;
    this.sun.shadow.bias = -0.0005;
    app.scene.add(this.sun, this.sun.target);
    this.setTimeOfDay(app.params.tod);
  },
  setTimeOfDay(t) {
    this.t = t;
    const elev = THREE.MathUtils.lerp(68, -4, t) * Math.PI / 180;
    const az = THREE.MathUtils.degToRad(200 - 70 * t);
    U.uSunDir.value.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).normalize();
    U.uNight.value = THREE.MathUtils.smoothstep(t, 0.75, 1.0);
    this.app && this.app.events.emit('tod', { t });
  },
  update(dt, app) {
    const p = app.camera.position;
    const fwd = new THREE.Vector3(); app.camera.getWorldDirection(fwd);
    const center = p.clone().addScaledVector(fwd, 60);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(U.uSunDir.value, 300);
  },
};
export default env;
