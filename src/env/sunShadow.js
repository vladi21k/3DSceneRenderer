import * as THREE from 'three';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

// Cascaded sun shadows on top of the renderer's built-in sun light (one light, one
// shadow atlas, cascades blended in the shader). The stock SunLightShadow has two
// cascades with a fixed split; a telephoto view down a 700 m street needs more, with
// splits that follow the field of view. Every lit built-in material supports it
// without per-material patches.
//
// Shader conventions (patched getSunShadow below):
//   shadow.radius     largest penumbra half-width in metres (blockers ~25 m away)
//   shadow.normalBias normal offset in shadow-map texels of the cascade in use
//   shadow.bias       small constant depth bias
//   cascade.w         floor(depth range of the cascade camera, m) + world texel size (m)
// Penumbrae harden towards contact: a small blocker search compares the receiver at
// four depth offsets (0, 1.5, 10 and 50 m towards the sun) to estimate how far the
// blocker is, and the filter radius follows the sun's angular size (0.53°), so a
// cornice 60 m up-sun throws a ~0.4 m soft edge while a bench leg stays crisp.
// Coarse cascades filter over at least two texels with more taps (no stair steps),
// and skip thin casters (railings, lamp scrolls) that a 0.1–0.3 m texel cannot hold.
// Every tap compares against the receiver plane at its own offset (depth gradient from
// screen derivatives), so wide kernels on grazing-lit walls do not streak.
// A pixel samples at most two cascades (its own and, in the fade band, the next one),
// so the filter is inlined twice per program rather than once per cascade.
//
// Caster culling per cascade: the light-space box is a rotation-stable sphere fit, so a
// caster must also (a) cast within reach of the cascade's slice of view depth, (b)
// overlap the slice's outline seen from the sun (its convex hull in light space) and
// (c) for instanced sets that publish it (userData.shadowRange = [min, max, height] view
// depth band of this frame's instances), have instances near the slice.
//
// Atlas: the cascades sit side by side in one row. Near cascades are redrawn every
// frame; the far ones on a stagger (cascade 2 every other frame, cascade 3 every
// fourth) unless the view or the sun moved enough to need them, so the redrawn tiles
// are always a prefix of the row and one scissored clear covers them.

const _m = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _c = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _far = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _axes = new Float32Array(9);   // light-space axes in world space (rows: x, y, z)

// casters too fine for a coarse cascade: wrought iron, ironwork cards, lamp scrolls
const THIN_MATERIAL = /^(ironwork\.(parts|card)|metal\.(iron|wire))|catenaryThin/;
const THIN_TEXEL = 0.05;      // cascades with texels coarser than this (m) skip them
const SUBTEXEL = 1.5;         // casters smaller than this many texels (radius) are skipped
const MAX_FILTER_TEXELS = 16; // widest PCF kernel (texels): wider would only add noise
const REFRESH = [1, 1, 2, 4]; // frames between redraws per cascade (far ones staggered)
const OUTLINE_MARGIN = 1.0;   // slack for the filter footprint and normal offset (m)
const MAX_REACH = 120;        // longest caster shadow considered by the cascade culling (m)
export const NEAR_CASCADES = 2; // cascades below this index draw the batcher's cell proxies, the rest its coarse ones

const _thinMat = new WeakMap();
const _origShadowHooks = [THREE.Object3D.prototype.onBeforeShadow, THREE.Object3D.prototype.onAfterShadow];

/** Thin caster: userData.thinCaster on the mesh, else its material (flag or name). */
export function isThinCaster(object) {
  const t = object.userData.thinCaster;
  if (t !== undefined) return !!t;
  const m = Array.isArray(object.material) ? object.material[0] : object.material;
  if (!m) return false;
  let v = _thinMat.get(m);
  if (v === undefined) { v = m.userData.thinCaster === true || THIN_MATERIAL.test(m.name || ''); _thinMat.set(m, v); }
  return v;
}

/** True when the object's shadow pass uses its own hooks (it builds its own draw lists). */
export function hasShadowHooks(object) {
  return object.onBeforeShadow !== _origShadowHooks[0] || object.onAfterShadow !== _origShadowHooks[1];
}

/**
 * World bounding sphere of a caster, computed once per frame and shared by the cascades.
 * Plain stand-in objects (modules that cull their own instances pass one object with a
 * changing sphere) are never cached.
 */
const SPHERE = Symbol('sunShadowSphere');
const _tmp = { f: -1, ok: false, s: new THREE.Sphere() };
function worldSphere(object, frame) {
  let c = object.isObject3D ? object[SPHERE] : _tmp;
  if (c && c !== _tmp && c.f === frame) return c.ok ? c.s : null;
  if (!c) c = object[SPHERE] = { f: -1, ok: false, s: new THREE.Sphere() };
  c.f = frame;
  let bs = null;
  if (object.boundingSphere !== undefined) {
    if (object.boundingSphere === null) object.computeBoundingSphere();
    bs = object.boundingSphere;
  } else if (object.geometry) {
    const g = object.geometry;
    if (g.boundingSphere === null) g.computeBoundingSphere();
    bs = g.boundingSphere;
  }
  c.ok = !!bs;
  if (bs) c.s.copy(bs).applyMatrix4(object.matrixWorld);
  return c.ok ? c.s : null;
}

/**
 * Cascade frustum that also rejects casters whose shadow cannot reach the cascade's
 * slice of view depth: a shadow lies between the object and the object pushed away
 * from the sun by (height / tan(sun elevation)). A sphere-fitted far cascade would
 * otherwise contain, and redraw, every small object near the camera. Coarse cascades
 * also drop thin and sub-texel casters, and casters merged into a depth-only proxy
 * (see shadowBatch.js) are left to the proxy.
 */
class CascadeFrustum extends THREE.Frustum {
  constructor(index = 0) {
    super();
    this.index = index;
    this.zNear = -Infinity;
    this.zFar = Infinity;
    this.ctx = null;
    this.skip = false;
    this.skipThin = false;
    this.minRadius = 0;
    this.acceptAll = false;
    // the slice's outline seen from the sun (convex hull in light space) and its lowest
    // light-space depth: a caster can only shadow the slice if its sphere, projected
    // along the sun, overlaps the outline and it is not entirely beyond the slice
    this.hull = new Float32Array(16);
    this.hullN = 0;
    this.minZ = -Infinity;
    this.axes = null;   // light-space axes (shared): x, y, z rows
  }

  /** Light-space convex hull of the slice corners (Andrew's monotone chain). */
  setOutline(corners, axes) {
    this.axes = axes;
    const pts = corners.map((v) => [v.x, v.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    this.hullN = hull.length;
    hull.forEach((q, i) => { this.hull[i * 2] = q[0]; this.hull[i * 2 + 1] = q[1]; });
    this.minZ = Math.min(...corners.map((v) => v.z));
  }

  /** Can a sphere (world space) shadow the slice? Outline test in light space. */
  reachesOutline(p, r) {
    const a = this.axes, n = this.hullN;
    if (!a || n < 3) return true;
    const z = p.x * a[6] + p.y * a[7] + p.z * a[8];
    if (z + r < this.minZ - OUTLINE_MARGIN) return false;
    const x = p.x * a[0] + p.y * a[1] + p.z * a[2], y = p.x * a[3] + p.y * a[4] + p.z * a[5];
    const H = this.hull, rr = r + OUTLINE_MARGIN;
    let inside = true, d2 = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = H[i * 2], y0 = H[i * 2 + 1], ex = H[j * 2] - x0, ey = H[j * 2 + 1] - y0;
      const px = x - x0, py = y - y0;
      if (ex * py - ey * px < 0) inside = false;   // right of a CCW edge: outside
      const t = Math.max(0, Math.min(1, (px * ex + py * ey) / Math.max(ex * ex + ey * ey, 1e-12)));
      const qx = px - t * ex, qy = py - t * ey;
      d2 = Math.min(d2, qx * qx + qy * qy);
    }
    return inside || d2 <= rr * rr;
  }

  intersectsObject(object) {
    if (this.skip) return false;
    if (this.acceptAll) return true;
    const c = this.ctx;
    const ud = object.userData;
    let sphere;
    if (ud.shadowProxy) {
      // cell proxies serve the near cascades, the coarse ones the rest
      if (!ud.shadowProxy.active || (ud.shadowFar === true) !== (this.index >= NEAR_CASCADES)) return false;
      sphere = ud.shadowSphere;
    } else {
      if (c && c.batcher && c.batcher.covers(object)) return false;
      sphere = worldSphere(object, c ? c.frame : 0);
      if (!sphere) return super.intersectsObject(object);
    }
    if (this.skipThin && isThinCaster(object)) return false;
    const r = sphere.radius;
    if (r < this.minRadius) return false;
    if (c && c.enabled) {
      const p = sphere.center;
      const d = (p.x - c.camPos.x) * c.fwd.x + (p.y - c.camPos.y) * c.fwd.y + (p.z - c.camPos.z) * c.fwd.z;
      const h = Math.max(0, Math.min(p.y + r - c.groundY, 60));
      // view-depth component of the top's shadow reach, capped: a low sun's shadows run for
      // hundreds of metres, but by then the street floor is in the canyon's shadow anyway
      const dd = Math.min(h * c.cotE, MAX_REACH) * c.awayDotFwd;
      const lo = Math.min(d, d + dd) - r - 6, hi = Math.max(d, d + dd) + r + 6;
      if (hi < this.zNear || lo > this.zFar) return false;
      // instanced sets drawn in one call (a whole LOD of figures) can publish the view-depth
      // band of this frame's instances and their height: userData.shadowRange =
      // [min, max, height?] (m along the view; the sphere's height when omitted)
      const band = ud.shadowRange;
      if (band) {
        const db = band[2] !== undefined ? Math.min(band[2] * c.cotE, MAX_REACH) * c.awayDotFwd : dd;
        if (Math.max(band[1], band[1] + db) + 2 < this.zNear || Math.min(band[0], band[0] + db) - 2 > this.zFar) return false;
      }
      if (!this.intersectsSphere(sphere)) return false;
      return this.reachesOutline(sphere.center, r);
    }
    return this.intersectsSphere(sphere);
  }
}

export class StreetSunShadow extends SunLightShadow {
  constructor(cascades = 4) {
    super();
    this.isStreetSunShadow = true;
    this.cascades = cascades;
    this.fade = 0.14;            // fraction of each cascade blended into the next
    this.firstSplit = 30;        // metres at the default 17° field of view
    this._cameras = []; this._matrices = []; this._frustums = []; this._cascadeData = []; this._viewports = [];
    for (let i = 0; i < cascades; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new CascadeFrustum(i));
      this._cascadeData.push(new THREE.Vector4());
      this._viewports.push(new THREE.Vector4());
    }
    this._viewportCount = cascades;
    this._frameExtents.set(cascades, 1);
    this._cascadeSplits = new Array(cascades + 1).fill(0);
    this.splits = this._cascadeSplits;
    // caster culling context, shared by the cascade frustums
    this.cullCasters = true;
    this._ctx = {
      enabled: true, frame: 0, batcher: null,
      camPos: new THREE.Vector3(), fwd: new THREE.Vector3(), groundY: 0, cotE: 1, awayDotFwd: 0,
    };
    for (const f of this._frustums) f.ctx = this._ctx;
    this.groundY = null; // world height of the street at the camera (set by env); null = camera.y - 3
    // far cascades are redrawn on a stagger unless the view or the sun changed a lot
    this.stagger = cascades > 2;
    this.refreshed = cascades;   // cascades redrawn by the last update (a prefix of the row)
    // the first redraw takes every caster into every cascade, so all depth-pass program
    // variants compile at start-up rather than when a caster first enters a cascade
    this.warmup = true;
    this._frame = 0;
    this._lastFar = { pos: new THREE.Vector3(1e9, 0, 0), fwd: new THREE.Vector3(), sun: new THREE.Vector3(), fov: 0 };
  }

  /** Static caster batcher whose proxies stand in for the casters they merge. */
  set batcher(b) { this._ctx.batcher = b; }
  get batcher() { return this._ctx.batcher; }

  copy(source) {
    super.copy(source);
    this.fade = source.fade;
    this.firstSplit = source.firstSplit;
    return this;
  }

  _computeSplits(near, far, fovDeg) {
    const n = this.cascades, s = this._cascadeSplits;
    // narrower lenses see less of the near field: push the first split out
    const s1 = THREE.MathUtils.clamp(this.firstSplit * Math.pow(17 / Math.max(fovDeg, 5), 0.8), 8, 40);
    s[0] = near;
    for (let i = 1; i < n; i++) s[i] = s1 * Math.pow(far / s1, (i - 1) / (n - 1));
    s[n] = far;
  }

  updateMatrices(light, viewCamera) {
    if (viewCamera === undefined) return;
    const n = this.cascades;
    const tile = Math.min(this.mapSize.x, this.mapSize.y);

    const camNear = viewCamera.near;
    const camFar = Math.max(camNear + 1e-6, Math.min(this.camera.far, viewCamera.far));
    this._computeSplits(camNear, camFar, viewCamera.fov ?? 50);
    const splits = this._cascadeSplits;

    _dir.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_dir)) > 0.99) _up.set(0, 0, 1);
    _m.lookAt(_c.set(0, 0, 0), _dir, _up);
    _viewToLight.copy(_m).transpose().multiply(viewCamera.matrixWorld);
    { const e = _m.elements; _axes.set([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]]); }

    // caster culling context: view position/direction and the sun's horizontal reach
    const ctx = this._ctx;
    ctx.enabled = this.cullCasters;
    ctx.frame = this._frame;
    ctx.camPos.setFromMatrixPosition(viewCamera.matrixWorld);
    ctx.fwd.set(0, 0, -1).transformDirection(viewCamera.matrixWorld);
    ctx.groundY = this.groundY ?? ctx.camPos.y - 3;
    const sunH = Math.hypot(_dir.x, _dir.z);              // _dir points away from the sun
    ctx.cotE = Math.min(sunH / Math.max(-_dir.y, 0.02), 40);
    ctx.awayDotFwd = sunH > 1e-4 ? (_dir.x * ctx.fwd.x + _dir.z * ctx.fwd.z) / sunH : 0;

    // how many cascades (a prefix of the row) to redraw this frame
    const lf = this._lastFar;
    const all = !this.stagger || this.map === null
      || lf.pos.distanceToSquared(ctx.camPos) > 9 || lf.fwd.dot(ctx.fwd) < 0.9986 || lf.sun.dot(_dir) < 0.99995
      || lf.fov !== viewCamera.fov;
    let k = n;
    if (!all) {
      k = 0;
      while (k < n && this._frame % REFRESH[Math.min(k, REFRESH.length - 1)] === 0) k++;
      k = Math.max(k, Math.min(2, n));
    }
    this._frame++;
    if (k === n) { lf.pos.copy(ctx.camPos); lf.fwd.copy(ctx.fwd); lf.sun.copy(_dir); lf.fov = viewCamera.fov; }
    this.refreshed = k;
    if (this.map) {
      // only the tiles being redrawn are cleared (the clear honours the scissor)
      this.map.scissorTest = k < n;
      this.map.scissor.set(0, 0, k * this.mapSize.x, this.mapSize.y);
    }

    const inv = viewCamera.projectionMatrixInverse;
    let maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1, y = i === 0 || i === 3 ? 1 : -1;
      const nc = _near[i].set(x, y, -1).applyMatrix4(inv);
      _far[i].copy(nc).multiplyScalar(camFar / camNear);
      nc.applyMatrix4(_viewToLight);
      _far[i].applyMatrix4(_viewToLight);
      maxZ = Math.max(maxZ, nc.z, _far[i].z);
    }
    // casters up to one shadow range towards the light still cast into the view
    maxZ += Math.min(camFar, 400);
    const shadowNear = this.camera.near;

    for (let i = 0; i < n; i++) {
      // stale cascade: keep its camera, matrix and depth range from the last redraw
      this._frustums[i].skip = i >= k;
      if (i >= k) continue;
      const cNear = i === 0 ? splits[0] : this._cascadeData[i - 1].z;
      const cFar = splits[i + 1];
      const fadeStart = cFar - this.fade * (cFar - splits[i]);

      const a0 = (cNear - camNear) / (camFar - camNear), a1 = (cFar - camNear) / (camFar - camNear);
      _c.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].lerpVectors(_near[j], _far[j], a0);
        _corners[j * 2 + 1].lerpVectors(_near[j], _far[j], a1);
        _c.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _c.multiplyScalar(1 / 8);
      let r2 = 0, minZ = Infinity;
      for (let j = 0; j < 8; j++) { r2 = Math.max(r2, _corners[j].distanceToSquared(_c)); minZ = Math.min(minZ, _corners[j].z); }

      // inset each tile by the filter footprint so PCF never reads the neighbouring tile
      let radius = Math.sqrt(r2);
      const texelGuess = (2 * radius) / tile;
      const insetTexels = Math.ceil(Math.min(Math.max(this.radius / texelGuess, 2), MAX_FILTER_TEXELS) * 1.2 + this.normalBias) + 2;
      const inset = Math.min(0.2, insetTexels / tile);
      this._viewports[i].set(i + inset, inset, 1 - 2 * inset, 1 - 2 * inset);
      const res = tile * (1 - 2 * inset);

      // snap to the texel grid (rotation-stable sphere fit, so no shimmer while moving)
      radius /= 1 - 1 / res;
      const texel = (2 * radius) / res;
      _c.x = Math.round(_c.x / texel) * texel;
      _c.y = Math.round(_c.y / texel) * texel;
      _c.z = maxZ + shadowNear;
      _c.applyMatrix4(_m);

      const range = maxZ - minZ + 2 * shadowNear;
      this._cascadeData[i].set(i === 0 ? -1e10 : cNear, cFar, fadeStart, Math.floor(range) + Math.min(texel, 0.999));
      // the slice's view depths (corners of the frustum reach a little further than the split)
      const f = this._frustums[i];
      f.zNear = i === 0 ? -Infinity : cNear * 0.97 - 2;
      f.zFar = cFar + 2;
      f.skipThin = this.cullCasters && (i >= 2 || texel > THIN_TEXEL);
      f.minRadius = this.cullCasters && i >= 2 ? SUBTEXEL * texel : 0;
      f.acceptAll = this.warmup;
      f.setOutline(_corners, _axes);

      const cam = this._cameras[i];
      cam.position.copy(_c);
      cam.quaternion.setFromRotationMatrix(_m);
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = shadowNear;
      cam.far = maxZ - minZ + 2 * shadowNear;
      cam.coordinateSystem = this.camera.coordinateSystem;
      cam._reversedDepth = this.camera.reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      this._updateMatrix(cam, this._matrices[i], f, this._viewports[i]);
    }
    if (this.map) this.warmup = false;
  }
}

const SIDE_FLIP = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

/**
 * Compile the programs the sun's depth passes will use, now and on the driver's threads,
 * instead of one by one in the first shadow pass (or later, the first time a caster
 * enters a cascade). A depth pass draws each caster with its custom depth material, or
 * the renderer's own depth material (a per-material variant when alpha-tested), set to
 * the caster's map, alpha test and shadow side; one representative of each such
 * combination (and mesh kind) is compiled with that material swapped in for a moment.
 * The renderer shares programs by key, so equivalent materials stand in for its own.
 */
export function precompileShadowPrograms(renderer, scene, camera, target) {
  const shared = new THREE.MeshDepthMaterial();
  const variants = new Map();
  const seen = new Set();
  const jobs = [];
  scene.traverse((o) => {
    if (!o.castShadow || !o.isMesh) return;
    const m = o.material;
    if (!m || Array.isArray(m)) return;
    const custom = o.customDepthMaterial;
    const variant = !custom && (m.alphaToCoverage || (m.alphaTest > 0 && (m.map || m.alphaMap)) || (m.displacementMap && m.displacementScale !== 0));
    const side = m.shadowSide ?? SIDE_FLIP[m.side];
    const kind = o.isBatchedMesh ? 'b' : o.isInstancedMesh ? (o.instanceColor ? 'c' : 'i') : o.isSkinnedMesh ? 's' : 'm';
    const morph = o.geometry && o.geometry.morphAttributes.position ? o.geometry.morphAttributes.position.length : 0;
    const at = m.alphaToCoverage ? 0.5 : m.alphaTest;
    const sig = [custom ? custom.uuid : variant ? 'v' : 's', kind, morph, side, !!m.map, !!m.alphaMap, at > 0, !!m.displacementMap].join('|');
    if (seen.has(sig)) return;
    seen.add(sig);
    let dm = custom || shared;
    if (variant) {
      const k = [kind, morph, side, !!m.map, !!m.alphaMap, at > 0, !!m.displacementMap].join('|');
      if (!variants.has(k)) variants.set(k, shared.clone());
      dm = variants.get(k);
    }
    jobs.push({ o, m, dm, side, at });
  });
  const prev = renderer.getRenderTarget();
  if (target) renderer.setRenderTarget(target);
  for (const { o, m, dm, side, at } of jobs) {
    const keep = [o.material, dm.map, dm.alphaMap, dm.alphaTest, dm.side, dm.displacementMap, dm.displacementScale];
    dm.map = m.map; dm.alphaMap = m.alphaMap; dm.alphaTest = at; dm.side = side;
    dm.displacementMap = m.displacementMap; dm.displacementScale = m.displacementScale;
    o.material = dm;
    try {
      renderer.compile(o, camera, scene);
    } catch (e) {
      // a caster that cannot be compiled out of context simply compiles when first drawn
    } finally {
      [o.material, dm.map, dm.alphaMap, dm.alphaTest, dm.side, dm.displacementMap, dm.displacementScale] = keep;
    }
  }
  renderer.setRenderTarget(prev);
  return jobs.length;
}

/**
 * Patch the global shadow chunk: cascade count + a sun PCF with a world-space radius,
 * per-cascade normal offset and more taps. Must run before any lit material compiles.
 */
export function patchSunShadowChunk(cascades, taps = 8) {
  const SC = THREE.ShaderChunk;
  let src = SC.shadowmap_pars_fragment;
  if (!src.includes('#define SUN_LIGHT_CASCADES 2')) {
    console.warn('[env] shadow chunk layout changed; using stock sun shadows');
    return false;
  }
  const start = src.indexOf('float getSunShadow(');
  const endMarker = src.indexOf('#if NUM_POINT_LIGHT_SHADOWS > 0', start);
  const end = src.lastIndexOf('#endif', endMarker);
  if (start < 0 || endMarker < 0 || end < start) {
    console.warn('[env] getSunShadow not found; using stock sun shadows');
    return false;
  }
  const wide = Math.max(12, taps);
  const fn = /* glsl */ `
		float sunShadowTap(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			vec2 atlasSize, float bias, float texel, float range, float maxRadius, int cascade, vec4 coord, vec2 dz ) {
			coord.xyz /= coord.w;
			coord.z += bias;
			if ( coord.z > 1.0 ) return 1.0;
			// receiver plane: every tap compares against the receiver's depth at its own offset
			// (dz = depth gradient over the atlas), so a wide kernel on a surface the light
			// grazes does not shadow itself in streaks
			#if defined( SHADOWMAP_TYPE_PCF )
				vec2 tx = 1.0 / atlasSize;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				// coarse cascades always filter over two texels or more (no stair steps)
				// (and the near ones over 1.6: a contact edge filtered over a single texel shows the
				// shadow map's stair steps as a rope pattern along sills and string courses)
				float minR = cascade >= 2 ? 2.2 : 1.6;
				float maxR = clamp( maxRadius / texel, minR, ${MAX_FILTER_TEXELS.toFixed(1)} );
				// blocker search over the widest penumbra
				vec2 so[ 5 ];
				so[ 0 ] = vec2( 0.0 );
				float f0 = 1.0 - texture( shadowMap, coord.xyz );
				for ( int k = 1; k < 5; k ++ ) {
					so[ k ] = vogelDiskSample( k - 1, 4, phi ) * maxR * tx;
					f0 += 1.0 - texture( shadowMap, vec3( coord.xy + so[ k ], coord.z + dot( dz, so[ k ] ) ) );
				}
				f0 *= 0.2;
				if ( f0 <= 0.0 ) return 1.0;
				if ( f0 >= 1.0 ) return 0.0;
				// how far are the blockers? Probe whether the receiver, moved 1.5, 10 and 50 m
				// towards the sun, is still blocked (stop once nothing is left)
				vec3 fd = vec3( 0.0 );
				vec3 dm = vec3( 1.5, 10.0, 50.0 ) / range;
				float prev = f0;
				for ( int j = 0; j < 3; j ++ ) {
					if ( prev <= 0.0 ) break;
					float f = 0.0;
					for ( int k = 0; k < 5; k ++ ) f += 1.0 - texture( shadowMap, vec3( coord.xy + so[ k ], coord.z + dot( dz, so[ k ] ) - dm[ j ] ) );
					prev = f * 0.2;
					fd[ j ] = prev;
				}
				float dEst = ( 0.6 * ( f0 - fd.x ) + 4.5 * ( fd.x - fd.y ) + 24.0 * ( fd.y - fd.z ) + 85.0 * fd.z ) / f0;
				// penumbra half-width from the sun's angular radius (x1.5 for the filter shape)
				float rt = clamp( dEst * 0.0047 * 1.5 / texel, minR, maxR );
				vec2 r = rt * tx;
				// wide kernels and coarse cascades get more taps
				int n = ( cascade >= 2 || rt > 3.0 ) ? ${wide} : SUN_PCF_TAPS;
				float s = 0.0;
				for ( int k = 0; k < ${wide}; k ++ ) {
					if ( k >= n ) break;
					vec2 o = vogelDiskSample( k, n, phi + 1.3 ) * r;
					s += texture( shadowMap, vec3( coord.xy + o, coord.z + dot( dz, o ) ) );
				}
				return s / float( n );
			#else
				return step( coord.z, texture2D( shadowMap, coord.xy ).r );
			#endif
		}
		float sunShadowCascadeTap(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			SunLightShadow sunLightShadow, int index, int cascade, vec3 dpx, vec3 dpy ) {
			vec4 data = sunShadowCascade[ index ];
			float texel = fract( data.w );
			mat4 M = sunShadowMatrix[ index ];
			vec4 wp = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * ( sunLightShadow.shadowNormalBias * texel ), 1.0 );
			// receiver depth gradient over the atlas, from the screen derivatives of the position
			vec3 sx = ( M * vec4( dpx, 0.0 ) ).xyz, sy = ( M * vec4( dpy, 0.0 ) ).xyz;
			float det = sx.x * sy.y - sx.y * sy.x;
			vec2 dz = abs( det ) > 1e-14 ? vec2( sy.y * sx.z - sx.y * sy.z, sx.x * sy.z - sy.x * sx.z ) / det : vec2( 0.0 );
			// at most 0.25 m of depth per texel (silhouettes and grazing angles give wild slopes)
			float lim = 0.25 / max( floor( data.w ), 1.0 ) * sunLightShadow.shadowMapSize.y;
			dz *= min( 1.0, lim / max( length( dz ), 1e-9 ) );
			float cs = sunShadowTap( shadowMap, sunLightShadow.shadowMapSize, sunLightShadow.shadowBias, texel, floor( data.w ),
				sunLightShadow.shadowRadius, cascade, M * wp, dz );
			return mix( 1.0, cs, sunLightShadow.shadowIntensity );
		}
		float getSunShadow(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			SunLightShadow sunLightShadow,
			int shadowIndex
		) {
			float viewDepth = vSunShadowWorldPosition.w;
			int base = shadowIndex * SUN_LIGHT_CASCADES;
			// (screen derivatives taken here, in uniform control flow)
			vec3 dpx = dFdx( vSunShadowWorldPosition.xyz ), dpy = dFdy( vSunShadowWorldPosition.xyz );
			// the nearest cascade holding this depth; in its fade band, blend into the next
			int ci = - 1;
			for ( int i = 0; i < SUN_LIGHT_CASCADES; i ++ ) {
				vec4 c = sunShadowCascade[ base + i ];
				if ( ci < 0 && viewDepth >= c.x && viewDepth < c.y ) ci = i;
			}
			if ( ci < 0 ) return 1.0;
			vec4 cascade = sunShadowCascade[ base + ci ];
			float shadow = sunShadowCascadeTap( shadowMap, sunLightShadow, base + ci, ci, dpx, dpy );
			float f = smoothstep( cascade.z, cascade.y, viewDepth );
			if ( f > 0.0 ) {
				float next = ci + 1 < SUN_LIGHT_CASCADES ? sunShadowCascadeTap( shadowMap, sunLightShadow, base + ci + 1, ci + 1, dpx, dpy ) : 1.0;
				shadow = mix( shadow, next, f );
			}
			return shadow;
		}
	`;
  src = src.slice(0, start) + fn + '\n\t' + src.slice(end);
  src = src.replace('#define SUN_LIGHT_CASCADES 2', `#define SUN_LIGHT_CASCADES ${cascades}\n\t\t#define SUN_PCF_TAPS ${taps}`);
  SC.shadowmap_pars_fragment = src;
  return true;
}
