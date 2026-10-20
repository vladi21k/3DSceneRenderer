import * as THREE from 'three';

// Contact shade under the figures: where a shoe meets the paving the gap between them is a few mm, far
// below what the screen-space occlusion (half resolution, ~0.75 m radius) or the sun's shadow map can
// resolve, so people would seem to hover, most of all in the shade. Each posed figure near the camera gets
// ground-aligned soft ellipses drawn after the opaque scene with a multiplying blend (the colour behind is
// darkened, nothing else changes): one under each foot (about 0.30 x 0.12 m, fading as the foot lifts off
// the paving: a walking foot's swing leaves no mark) and a wider, fainter patch under the body for people
// who stand or sit. They fade out from 25 to 45 m (a pixel or two by then). One instanced draw.
//
//   const c = new ContactShade(app); scene.add(c.mesh);
//   per frame: c.begin(); c.add(x, y, z, dirX, dirZ, halfLen, halfWid, strength) ...; c.end();
// Strength is the darkening at the centre (0 none .. 1 black). No garbage per frame.

const VERT = /* glsl */`
attribute vec4 iPos;     // centre x, ground y, z, strength
attribute vec4 iAxis;    // direction of the long axis (x, z), half length, half width
varying vec2 vQ;
varying float vK;
void main() {
  vec2 d = normalize(iAxis.xy + vec2(1e-6, 0.0));
  vec2 sd = vec2(-d.y, d.x);
  vec2 off = d * position.x * iAxis.z + sd * position.y * iAxis.w;
  vec3 wp = vec3(iPos.x + off.x, iPos.y + 0.004, iPos.z + off.y);
  vQ = position.xy;
  vK = iPos.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */`
varying vec2 vQ;
varying float vK;
void main() {
  float r = length(vQ);
  if (r >= 1.0) discard;
  // (a dense core under the sole, a soft skirt round it)
  float f = 1.0 - smoothstep(0.0, 1.0, r);
  f = f * f * (0.55 + 0.45 * (1.0 - smoothstep(0.35, 0.75, r)));
  gl_FragColor = vec4(vec3(1.0 - vK * f), 1.0);
}`;

export class ContactShade {
  constructor(app) {
    this.app = app;
    this.cap = 0;
    this.n = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    g.instanceCount = 0;
    this.geo = g;
    this._grow(512);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    mat.name = 'humans.contact';
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'humans.contact';
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;        // first among the transparent draws (before glass, haze cards ...)
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.raycast = () => {};
    this.mesh = mesh;
  }

  _grow(n) {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2);
    const P = new Float32Array(cap * 4), A = new Float32Array(cap * 4);
    if (this.P) { P.set(this.P); A.set(this.A); }
    this.P = P; this.A = A;
    this.aP = new THREE.InstancedBufferAttribute(P, 4);
    this.aA = new THREE.InstancedBufferAttribute(A, 4);
    this.aP.setUsage(THREE.DynamicDrawUsage);
    this.aA.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.aP);
    this.geo.setAttribute('iAxis', this.aA);
    this.cap = cap;
  }

  begin() { this.n = 0; }

  add(x, y, z, dx, dz, hl, hw, k) {
    if (k <= 0.004) return;
    if (this.n >= this.cap) this._grow(this.n + 1);
    const o = this.n * 4;
    const P = this.P, A = this.A;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = k;
    A[o] = dx; A[o + 1] = dz; A[o + 2] = hl; A[o + 3] = hw;
    this.n++;
  }

  end() {
    const n = this.n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.aP.clearUpdateRanges(); this.aA.clearUpdateRanges();
      this.aP.addUpdateRange(0, n * 4); this.aA.addUpdateRange(0, n * 4);
      this.aP.needsUpdate = true; this.aA.needsUpdate = true;
    }
  }
}
