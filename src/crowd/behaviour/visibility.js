import * as THREE from 'three';
import { TRACK_OFFSET } from '../../core/config.js';
import { settleShape } from './agent.js';

// What the camera can see, so people only appear or vanish where nobody is looking:
// outside the view frustum, behind a facade (inside a doorway recess or a side street)
// where the line of sight does not pass through the opening, or right behind a taller
// figure or a kiosk on the same line of sight.

const SHOULDER = 0.25;     // half body width tested for openings
const _c = settleShape({ x: 0, y: 0, z: 0 });
const BODY_R = 0.28;

export class Visibility {
  constructor(route) {
    this.route = route;
    this.frustum = new THREE.Frustum();
    this.m = new THREE.Matrix4();
    this.sphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.camU = 0;            // camera route position (unwrapped, crowd frame)
    this.camD = TRACK_OFFSET;
    this.camPos = new THREE.Vector3();
    // (s, d, h) -> world point: route.toWorld, or the crowd's (which follows the side streets)
    this.toWorld = (s, d, h, out) => route.toWorld(s, d, h, out);
    this._proj = settleShape({ s: 0, d: 0 });
    settleShape(this);
  }

  /** camU: crowd's unwrapped camera s; camS: app.cameraS (wrapped). */
  update(camera, camU, camS) {
    camera.updateMatrixWorld();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    this.camPos.copy(camera.position);
    // the camera's route coordinates: a few fixed-point steps along the centre line from camS
    // through route.io (route.project boxes the numbers of some forty route.toWorld calls)
    const R = this.route, io = R.io, px = camera.position.x, pz = camera.position.z;
    let s = camS, d = 0;
    if (io && R.toWorldIO && R.sampleIO) {
      for (let k = 0; k < 8; k++) {
        io[0] = s; io[1] = 0; io[2] = 0;
        R.toWorldIO(_c);
        R.sampleIO();
        const th = io[3], tx = Math.cos(th), tz = -Math.sin(th);
        const ex = px - _c.x, ez = pz - _c.z, f = ex * tx + ez * tz;
        d = ez * tx - ex * tz;
        s += f;
        if (f < 1e-4 && f > -1e-4) break;
      }
    } else {
      const p = R.project(px, pz, camS, 6, this._proj);
      s = p.s; d = p.d;
    }
    const L = R.length;
    let ds = (s - camS) % L; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
    this.camU = camU + ds;
    this.camD = d;
  }

  /** Is a standing figure at route (s, d) inside the view frustum (with a margin)? */
  inView(s, d, h = 0) {
    this.toWorld(s, d, h + 0.9, this.sphere.center);
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

  /** A whole body (centre at (s, d), facing the street) inside an opening is hidden: its front
   *  and both shoulders are masked by the facade around the opening [sa, sb]. */
  bodyHidden(s, d, side, lineD, sa, sb) {
    if (!this.inView(s, d)) return true;
    const df = d - side * BODY_R;
    return !this.throughOpening(s, df, side, lineD, sa, sb)
      && !this.throughOpening(s - SHOULDER, d, side, lineD, sa, sb)
      && !this.throughOpening(s + SHOULDER, d, side, lineD, sa, sb);
  }

  /** Lateral offset (m, measured at the occluder) between the camera rays to (s, d) and to an
   *  occluder at (so, dO) that is nearer to the camera; Infinity when it is not in front. */
  rayOffset(s, d, so, dO) {
    const r = s - this.camU, ro = so - this.camU;
    if (ro < 2 || ro > r - 0.8) return Infinity;
    const dRay = this.camD + (d - this.camD) * (ro / r);
    return Math.abs(dRay - dO);
  }

  /** Point on the camera ray through (so, dO) that lies `behind` metres further away (d of that point). */
  rayBehind(so, dO, behind) {
    const ro = so - this.camU;
    return this.camD + (dO - this.camD) * ((ro + behind) / Math.max(1, ro));
  }

  distance(s) { return Math.abs(s - this.camU); }
}
