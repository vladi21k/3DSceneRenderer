import * as THREE from 'three';
import { TRACK_OFFSET } from '../../core/config.js';

// What the camera can see, so people only appear or vanish where nobody is looking:
// outside the view frustum, or behind a facade (inside a doorway recess or a side
// street) where the line of sight does not pass through the opening.

export class Visibility {
  constructor(route) {
    this.route = route;
    this.frustum = new THREE.Frustum();
    this.m = new THREE.Matrix4();
    this.sphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.camU = 0;            // camera route position (unwrapped, crowd frame)
    this.camD = TRACK_OFFSET;
    this.camPos = new THREE.Vector3();
  }

  /** camU: crowd's unwrapped camera s; camS: app.cameraS (wrapped). */
  update(camera, camU, camS) {
    camera.updateMatrixWorld();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    this.camPos.copy(camera.position);
    const p = this.route.project(camera.position.x, camera.position.z, camS, 6);
    this.camU = camU + this.route.delta(camS, p.s);
    this.camD = p.d;
  }

  /** Is a standing figure at route (s, d) inside the view frustum (with a margin)? */
  inView(s, d, h = 0) {
    this.route.toWorld(s, d, h + 0.9, this.sphere.center);
    this.sphere.radius = 1.1;
    return this.frustum.intersectsSphere(this.sphere);
  }

  /** Does the line of sight to (s, d), a point behind the building line |d| = lineD on `side`,
   *  cross that line inside the opening [sa, sb] (all s unwrapped)? */
  throughOpening(s, d, side, lineD, sa, sb) {
    const cd = side * this.camD, pd = side * d;
    if (pd <= lineD) return true;
    const t = (lineD - cd) / Math.max(1e-3, pd - cd);
    const sx = this.camU + (s - this.camU) * t;
    return sx > sa && sx < sb;
  }

  /** Hidden from the camera: outside the frustum or masked by the facade around an opening. */
  hidden(s, d, side = 0, lineD = 0, sa = 0, sb = 0) {
    if (!this.inView(s, d)) return true;
    if (side && !this.throughOpening(s, d, side, lineD, sa, sb)) return true;
    return false;
  }

  distance(s) { return Math.abs(s - this.camU); }
}
