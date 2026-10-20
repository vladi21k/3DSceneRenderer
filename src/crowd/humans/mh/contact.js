import * as THREE from 'three';

// Contact shade under the figures: where a shoe meets the paving the gap between them is a few mm, far
// below what the screen-space occlusion (half resolution, ~0.75 m radius) or the sun's shadow map can
// resolve, so people would seem to hover, most of all in the shade. Each posed figure near the camera gets
// ground-aligned soft ellipses drawn after the opaque scene with a multiplying blend (the colour behind is
// darkened, nothing else changes): one under each foot (about 0.30 x 0.12 m, fading as the foot lifts off
// the paving: a walking foot's swing leaves no mark) and a wider, fainter patch under the body for people
// who stand or sit. They fade out from 25 to 45 m (a pixel or two by then). One draw: the quads are
// written on the CPU (a few hundred a frame) into one dynamic buffer.
//
//   const c = new ContactShade(app); scene.add(c.mesh);
//   per frame: c.begin(); c.add(x, y, z, dirX, dirZ, halfLen, halfWid, strength) ...; c.end();
// Strength is the darkening at the centre (0 none .. 1 black). No garbage per frame.

const VERT = /* glsl */`
attribute vec3 aQ;       // position in the ellipse (-1..1, -1..1), strength
varying vec2 vQ;
varying float vK;
void main() {
  vQ = aQ.xy;
  vK = aQ.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
varying vec2 vQ;
varying float vK;
void main() {
  float r = length(vQ);
  if (r >= 1.0) discard;
  // (full strength under the sole out to its edge, about half the ellipse, then a soft falloff over the
  // few centimetres round it)
  float f = 1.0 - smoothstep(0.5, 1.0, r);
  f *= sqrt(f);
  gl_FragColor = vec4(vec3(1.0 - vK * f), 1.0);
}`;

const LIFT = 0.006;      // above the figure's ground height (m): the paving under a person is near flat

export class ContactShade {
  constructor(app) {
    this.app = app;
    this.cap = 0;
    this.n = 0;
    this.geo = new THREE.BufferGeometry();
    this._grow(256);
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
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.name = 'humans.contact';
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;        // first among the transparent draws (before glass, haze cards ...)
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.raycast = () => {};
    this.mesh = mesh;
  }

  _grow(n) {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2);
    const P = new Float32Array(cap * 12), Q = new Float32Array(cap * 12);
    if (this.P) { P.set(this.P); Q.set(this.Q); }
    const I = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 4, o = i * 6;
      I[o] = v; I[o + 1] = v + 2; I[o + 2] = v + 1; I[o + 3] = v; I[o + 4] = v + 3; I[o + 5] = v + 2;
    }
    this.P = P; this.Q = Q;
    if (this.aP) this.geo.dispose();
    this.aP = new THREE.BufferAttribute(P, 3).setUsage(THREE.DynamicDrawUsage);
    this.aQ = new THREE.BufferAttribute(Q, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aP);
    this.geo.setAttribute('aQ', this.aQ);
    this.geo.setIndex(new THREE.BufferAttribute(I, 1));
    this.cap = cap;
  }

  begin() { this.n = 0; }

  add(x, y, z, dx, dz, hl, hw, k) {
    if (k <= 0.004) return;
    if (this.n >= this.cap) this._grow(this.n + 1);
    const P = this.P, Q = this.Q, o = this.n * 12;
    const sx = -dz, sz = dx;
    const yy = y + LIFT;
    // corners (-1,-1) (1,-1) (1,1) (-1,1) in (along, across)
    for (let c = 0; c < 4; c++) {
      const a = c === 1 || c === 2 ? 1 : -1, b = c >= 2 ? 1 : -1;
      const j = o + c * 3;
      P[j] = x + dx * a * hl + sx * b * hw; P[j + 1] = yy; P[j + 2] = z + dz * a * hl + sz * b * hw;
      Q[j] = a; Q[j + 1] = b; Q[j + 2] = k;
    }
    this.n++;
  }

  end() {
    const n = this.n;
    this.geo.setDrawRange(0, n * 6);
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.aP.clearUpdateRanges(); this.aQ.clearUpdateRanges();
      this.aP.addUpdateRange(0, n * 12); this.aQ.addUpdateRange(0, n * 12);
      this.aP.needsUpdate = true; this.aQ.needsUpdate = true;
    }
  }
}
