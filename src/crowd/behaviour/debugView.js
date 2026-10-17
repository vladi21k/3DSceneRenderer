import * as THREE from 'three';
import { ST, KIND } from './agent.js';

// TEMPORARY development markers (crowdDebug=1) used until the figure renderer is in.

const COLORS = {
  walk: 0x3b6fd8, goto: 0x2fb36b, stand: 0xe0a020, wait: 0xe03030, seated: 0x8a50c0, platform: 0x20c0c0,
};

export class DebugView {
  constructor(app, n) {
    const geo = new THREE.CapsuleGeometry(0.22, 1.25, 4, 8);
    geo.translate(0, 0.845, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    if (app.materials && app.materials.track) app.materials.track(mat);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.p = new THREE.Vector3(); this.sc = new THREE.Vector3(1, 1, 1);
    this.col = new THREE.Color();
    this.up = new THREE.Vector3(0, 1, 0);
    app.scene.add(this.mesh);
  }

  update(agents) {
    let k = 0;
    for (const a of agents) {
      if (!a.active) continue;
      this.p.set(a.x, a.y, a.z);
      this.q.setFromAxisAngle(this.up, a.heading);
      const sy = a.state === ST.SEATED ? 0.72 : 1;
      this.sc.set(1, sy, 1);
      this.m.compose(this.p, this.q, this.sc);
      this.mesh.setMatrixAt(k, this.m);
      let key = ['walk', 'goto', 'stand', 'wait', 'seated', 'platform'][a.state];
      if (a.clearing) key = 'wait';
      this.col.setHex(COLORS[key]);
      if (a.kind === KIND.STANDER) this.col.multiplyScalar(0.7);
      this.mesh.setColorAt(k, this.col);
      k++;
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
