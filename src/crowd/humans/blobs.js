import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Ground shadows for the farthest figures (a few pixels tall), which are left out of the
// shadow map: one instanced quad per figure lying on the paving, stretched away from the sun
// to the length of the figure's shadow, with a soft body-shaped falloff that is darkest at
// the feet. Nearer figures cast real shadow-map shadows.

const VERT_PARS = /* glsl */`
varying vec2 vBlobUv;
`;
const FRAG_PARS = /* glsl */`
uniform float uBlobAlpha;
varying vec2 vBlobUv;
`;
const FRAG = /* glsl */`
{
  // v: 0 at the feet -> 1 at the head's shadow; u: across
  float v = vBlobUv.y, u = abs(vBlobUv.x * 2.0 - 1.0);
  float w = 0.45 + 0.55 * smoothstep(0.0, 0.35, v) - 0.35 * smoothstep(0.75, 1.0, v);
  float a = smoothstep(1.0, 0.55, u / w) * smoothstep(1.0, 0.86, v);
  a *= 0.75 + 0.25 * smoothstep(0.25, 0.0, v);
  diffuseColor.a *= a * uBlobAlpha;
}
`;

export class BlobShadows {
  constructor(app, capacity) {
    this.app = app;
    this.count = 0;
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);          // on the ground, uv.y = 1 at local z = -0.5
    g.translate(0, 0, -0.5);          // from the feet (z = 0) along local -Z
    this.geometry = g;
    this.uAlpha = { value: 0 };
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    mat.name = 'humans.blobShadow';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBlobAlpha = this.uAlpha;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_PARS)
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvBlobUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
        .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n' + FRAG);
    };
    mat.customProgramCacheKey = () => 'humans-blob-v1';
    app.materials.track(mat);
    this.material = mat;
    this.mesh = null;
    this.ensureCapacity(capacity);
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._mtx = new THREE.Matrix4();
    this._yaw = 0;
    this._len = 1;
  }

  ensureCapacity(n) {
    if (this.mesh && this.mesh.instanceMatrix.count >= n) return;
    const parent = this.mesh && this.mesh.parent;
    if (this.mesh) { parent && parent.remove(this.mesh); this.mesh.dispose(); }
    const m = new THREE.InstancedMesh(this.geometry, this.material, n);
    m.name = 'humans.blobShadows';
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;          // a handful of quads spread along the street
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 1;
    this.mesh = m;
    if (parent) parent.add(m);
  }

  /** Per frame: sun direction -> shadow azimuth and length per metre of figure height. */
  begin() {
    this.count = 0;
    const sun = U.uSunDir.value;
    const horiz = Math.hypot(sun.x, sun.z);
    const elev = Math.atan2(sun.y, horiz);
    // three.js yaw that turns local -Z onto the shadow direction (away from the sun)
    this._yaw = horiz > 1e-4 ? Math.atan2(sun.x, sun.z) : 0;
    this._len = Math.min(4, 1 / Math.max(Math.tan(Math.max(elev, 0.05)), 0.25));
    this._q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this._yaw);
    this.uAlpha.value = 0.45 * (1 - U.uNight.value) * THREE.MathUtils.smoothstep(elev, 0.02, 0.12);
  }

  add(x, y, z, h) {
    if (this.count >= this.mesh.instanceMatrix.count || this.uAlpha.value <= 0.001) return;
    this._p.set(x, y + 0.04, z);
    this._s.set(0.35 * h / 1.7, 1, Math.max(0.35, h * this._len));
    this._mtx.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(this.count++, this._mtx);
  }

  end() {
    const m = this.mesh;
    m.count = this.count;
    m.visible = this.count > 0;
    if (this.count) {
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, this.count * 16);
      m.instanceMatrix.needsUpdate = true;
    }
  }
}
