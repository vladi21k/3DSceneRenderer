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
// depth offsets from 0.4 to 60 m towards the sun to estimate how far the blocker is, and
// the filter radius follows the sun's angular size (0.53°), so a cornice 60 m up-sun
// throws a ~0.55 m soft edge, an awning 1 m off the wall a ~1 cm one.
// Coarse cascades filter over at least two texels with more taps (no stair steps),
// and skip thin casters (railings, lamp scrolls) that a 0.1–0.3 m texel cannot hold.
// Every tap compares against the receiver plane at its own offset (depth gradient from
// screen derivatives), so wide kernels on grazing-lit walls do not streak.
// A pixel samples at most two cascades (its own and, in the fade band, the next one),
// through a single call site, so the filter is inlined once per program; the tap loops
// have runtime bounds (sunShadowZero, never set) so they are not unrolled either.
// A pixel skips the filter (fully lit or dark) only when the widest-penumbra probe and a
// ring at the narrowest kernel's reach agree.
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
// convex hull scratch (setOutline): corner x, y, sort order, hull stack
const _hx = new Float64Array(8), _hy = new Float64Array(8), _ho = new Int32Array(8), _hs = new Int32Array(18);
const hullCross = (o, a, b) => (_hx[a] - _hx[o]) * (_hy[b] - _hy[o]) - (_hy[a] - _hy[o]) * (_hx[b] - _hx[o]);

// casters too fine for a coarse cascade: wrought iron, ironwork cards, lamp scrolls
const THIN_MATERIAL = /^(ironwork\.(parts|card)|metal\.(iron|wire))|catenaryThin/;
const THIN_TEXEL = 0.05;      // cascades with texels coarser than this (m) skip them
const SUBTEXEL = 1.5;         // casters smaller than this many texels (radius) are skipped
const MAX_FILTER_TEXELS = 24; // widest PCF kernel (texels): wider would only add noise (24 x ~1 cm
                              // in the nearest 4096 cascade: a cornice 50 m up-sun keeps its soft edge)
const REFRESH = [1, 1, 2, 4]; // frames between redraws per cascade (far ones staggered)
const OUTLINE_MARGIN = 1.0;   // slack for the filter footprint and normal offset (m)
const MAX_REACH = 120;        // longest caster shadow considered by the cascade culling (m)
const DETAIL_MARGIN = 15;     // near cascades draw full-detail static casters this close to their slice (m)
export const NEAR_CASCADES = 2; // cascades below this index may draw the batcher's detail cells

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
    this.hull = new Float64Array(24);   // per edge: outward normal x, y and offset
    this.hullN = 0;
    this.minZ = -Infinity;
    this.axes = null;   // light-space axes (shared): x, y, z rows
  }

  /** Light-space convex hull of the slice corners (Andrew's monotone chain), as edge lines.
   *  Allocation-free: it runs for every redrawn cascade each frame. */
  setOutline(corners, axes) {
    this.axes = axes;
    const n = corners.length, X = _hx, Y = _hy, O = _ho, Hs = _hs;
    let minZ = Infinity;
    for (let i = 0; i < n; i++) { X[i] = corners[i].x; Y[i] = corners[i].y; O[i] = i; minZ = Math.min(minZ, corners[i].z); }
    // sort by x, then y (insertion sort: 8 points)
    for (let i = 1; i < n; i++) {
      const v = O[i];
      let j = i - 1;
      while (j >= 0 && (X[O[j]] > X[v] || (X[O[j]] === X[v] && Y[O[j]] > Y[v]))) { O[j + 1] = O[j]; j--; }
      O[j + 1] = v;
    }
    // lower hull, then upper hull, into one stack (the last point of each is dropped)
    let m = 0;
    for (let i = 0; i < n; i++) {
      const q = O[i];
      while (m >= 2 && hullCross(Hs[m - 2], Hs[m - 1], q) <= 0) m--;
      Hs[m++] = q;
    }
    const lo = m;
    for (let i = n - 2; i >= 0; i--) {
      const q = O[i];
      while (m > lo && hullCross(Hs[m - 2], Hs[m - 1], q) <= 0) m--;
      Hs[m++] = q;
    }
    m--;   // the first point closes the loop
    // outward unit normal and offset of each counter-clockwise edge: distance = n·p − c
    let k = 0;
    for (let i = 0; i < m; i++) {
      const a = Hs[i], b = Hs[(i + 1) % m];
      const ex = X[b] - X[a], ey = Y[b] - Y[a], l = Math.sqrt(ex * ex + ey * ey);
      if (l < 1e-6) continue;
      const nx = ey / l, ny = -ex / l;
      this.hull[k++] = nx; this.hull[k++] = ny; this.hull[k++] = nx * X[a] + ny * Y[a];
    }
    this.hullN = k / 3;
    this.minZ = minZ;
  }

  /**
   * Can a sphere (world space) shadow the slice? Its projection along the sun must reach
   * the outline (conservative: within r of every edge line) and it must not lie wholly
   * beyond the slice.
   */
  reachesOutline(p, r) { return this._reachesOutline(p.x, p.y, p.z, r); }

  _reachesOutline(px, py, pz, r) {
    const a = this.axes, n = this.hullN;
    if (!a || n < 3) return true;
    const z = px * a[6] + py * a[7] + pz * a[8];
    if (z + r < this.minZ - OUTLINE_MARGIN) return false;
    const x = px * a[0] + py * a[1] + pz * a[2], y = px * a[3] + py * a[4] + pz * a[5];
    const H = this.hull, rr = r + OUTLINE_MARGIN;
    for (let i = 0; i < n * 3; i += 3) if (H[i] * x + H[i + 1] * y - H[i + 2] > rr) return false;
    return true;
  }

  /** Is a caster's shadow along view depth [d0, d1] (top `h` m above the street) in the slice? */
  _reachesSlice(d0, d1, h, r) {
    const c = this.ctx;
    const dd = Math.min(h * c.cotE, MAX_REACH) * c.awayDotFwd;
    const lo = Math.min(d0, d0 + dd) - r - 6, hi = Math.max(d1, d1 + dd) + r + 6;
    return !(hi < this.zNear || lo > this.zFar);
  }

  /**
   * Allocation-free caster test for modules that cull their own instances in a shadow pass
   * (one call per instance and cascade): a sphere given as numbers (world centre, radius),
   * with the same slice, shadow-reach, frustum, outline and sub-texel tests as
   * intersectsObject for an ordinary caster. `height` (optional): how far the caster's top
   * stands above the street (m), when the sphere's top overstates it. Thin casters are the
   * caller's to skip (`skipThin`).
   */
  reachesSphere(cx, cy, cz, r, height) {
    if (this.skip) return false;
    if (this.acceptAll) return true;
    if (r < this.minRadius) return false;
    const c = this.ctx;
    const on = c && c.enabled;
    if (on) {
      const d = (cx - c.camPos.x) * c.fwd.x + (cy - c.camPos.y) * c.fwd.y + (cz - c.camPos.z) * c.fwd.z;
      const h = Math.max(0, Math.min(height !== undefined ? height : cy + r - c.groundY, 60));
      if (!this._reachesSlice(d, d, h, r)) return false;
    }
    const P = this.planes;
    for (let i = 0; i < 6; i++) {
      const pl = P[i], nn = pl.normal;
      if (nn.x * cx + nn.y * cy + nn.z * cz + pl.constant < -r) return false;
    }
    return on ? this._reachesOutline(cx, cy, cz, r) : true;
  }

  intersectsObject(object) {
    if (this.skip) return false;
    if (this.acceptAll) return true;
    const c = this.ctx;
    const ud = object.userData;
    let sphere;
    if (ud.shadowProxy) {
      if (!ud.shadowProxy.active) return false;
      sphere = ud.shadowSphere;
      // batcher cells: far cascades draw the coarse ones; near cascades the detail cells
      // close to their slice and the coarse ones farther away
      const coarse = ud.shadowCoarse === true;
      if (this.index >= NEAR_CASCADES) {
        if (!coarse) return false;
      } else if (c && c.enabled) {
        const p = sphere.center, r = sphere.radius;
        const d = (p.x - c.camPos.x) * c.fwd.x + (p.y - c.camPos.y) * c.fwd.y + (p.z - c.camPos.z) * c.fwd.z;
        const close = d + r > this.zNear - DETAIL_MARGIN && d - r < this.zFar + DETAIL_MARGIN;
        if (close === coarse) return false;
      } else if (coarse) return false;
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
      if (!this._reachesSlice(d, d, h, r)) return false;
      // instanced sets drawn in one call (a whole LOD of figures) can publish the view-depth
      // band of this frame's instances and their height: userData.shadowRange =
      // [min, max, height?] (m along the view; the sphere's height when omitted)
      const band = ud.shadowRange;
      if (band) {
        const db = Math.min((band[2] !== undefined ? band[2] : h) * c.cotE, MAX_REACH) * c.awayDotFwd;
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
    { const e = _m.elements; _axes[0] = e[0]; _axes[1] = e[1]; _axes[2] = e[2]; _axes[3] = e[4]; _axes[4] = e[5]; _axes[5] = e[6]; _axes[6] = e[8]; _axes[7] = e[9]; _axes[8] = e[10]; }

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
      // (cascade 0 has no lower bound: its x carries the frame number for the shader's
      // per-frame kernel rotation, as -(2^20 + frame mod 16))
      this._cascadeData[i].set(i === 0 ? -(1048576 + (this._frame % 16)) : cNear, cFar, fadeStart, Math.floor(range) + Math.min(texel, 0.999));
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

/** Mesh kind bits that select a different depth program (batched, instanced, skinned, morphs). */
function depthKind(object, geometry) {
  let k = 0;
  if (object.isBatchedMesh) k = object._colorsTexture ? 2 : 1;
  else if (object.isInstancedMesh) k = 4 + (object.instanceColor ? 8 : 0) + (object.morphTexture ? 16 : 0);
  if (object.isSkinnedMesh) k += 32;
  const mp = geometry && geometry.morphAttributes.position;
  if (mp && mp.length) k += 64 * mp.length;
  return k;
}

/**
 * One depth material per mesh kind in the shadow passes. Casters without a custom depth
 * material all draw with the renderer's shared depth material (or its per-material
 * variant when alpha-tested), and the renderer re-evaluates that material's program each
 * time the kind of mesh drawing it changes (plain, batched, instanced, skinned...): a
 * parameter object and a cache-key string, several times per frame. Here every such draw
 * in a shadow pass takes a kind-specific copy of the material the renderer prepared (its
 * per-object state copied over), so each copy only ever sees one kind and keeps its
 * program. Casters with their own depth material are left alone. `stats.switches` counts
 * the kind changes the shared materials would have seen in the last shadow pass, and
 * `stats.reevals` the ones the renderer still sees (program re-evaluations).
 */
export function installDepthKinds(renderer) {
  const sm = renderer.shadowMap;
  if (sm.__depthKinds) return sm.__depthKinds;
  const stats = { switches: 0, reevals: 0, copies: 0, frameSwitches: 0, frameReevals: 0 };
  const byMat = new WeakMap();    // depth material -> { kind last seen (shared / actual), copies by kind }
  let inShadow = false;
  const render = sm.render;
  sm.render = function (lights, scene, camera) {
    // (every render call passes through here; only the ones with shadow lights draw)
    if (!lights || lights.length === 0) return render.call(this, lights, scene, camera);
    inShadow = true;
    stats.frameSwitches = 0; stats.frameReevals = 0;
    try { return render.call(this, lights, scene, camera); } finally {
      inShadow = false; stats.switches = stats.frameSwitches; stats.reevals = stats.frameReevals;
    }
  };
  const rbd = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    if (inShadow && scene === null && material && material.isMeshDepthMaterial && object.customDepthMaterial === undefined) {
      const k = depthKind(object, geometry);
      let e = byMat.get(material);
      if (!e) { e = { would: k, act: k, kinds: new Map() }; byMat.set(material, e); }
      if (e.would !== k) { stats.frameSwitches++; e.would = k; }
      // (the plain kind keeps the material itself)
      if (k !== 0) {
        let c = e.kinds.get(k);
        if (!c) { c = material.clone(); e.kinds.set(k, c); stats.copies++; }
        c.visible = material.visible; c.side = material.side; c.wireframe = material.wireframe;
        c.map = material.map; c.alphaMap = material.alphaMap; c.alphaTest = material.alphaTest;
        c.displacementMap = material.displacementMap; c.displacementScale = material.displacementScale; c.displacementBias = material.displacementBias;
        c.clipShadows = material.clipShadows; c.clippingPlanes = material.clippingPlanes; c.clipIntersection = material.clipIntersection;
        material = c;
      }
      // (what the renderer now sees: a change here is a program re-evaluation)
      let a = byMat.get(material);
      if (!a) { a = { would: k, act: k, kinds: null }; byMat.set(material, a); }
      if (a.act !== k) { stats.frameReevals++; a.act = k; }
    }
    return rbd.call(this, camera, scene, geometry, material, object, group);
  };
  sm.__depthKinds = stats;
  return stats;
}

/**
 * Compile the programs the sun's depth passes will use, now and on the driver's threads,
 * instead of one by one in the first shadow pass (or later, the first time a caster
 * enters a cascade). A depth pass draws each caster with its custom depth material, or
 * the renderer's own depth material (a per-material variant when alpha-tested), set to
 * the caster's map, alpha test and shadow side; one representative of each such
 * combination (and mesh kind) is compiled with that material swapped in for a moment.
 * The renderer shares programs by key, so equivalent materials stand in for its own.
 * `seen` (the signatures already submitted) lets a later call take only the casters added
 * since, such as figures or proxies a module adds after the start-up compile.
 */
export function precompileShadowPrograms(renderer, scene, camera, target, seen = new Set()) {
  const shared = new THREE.MeshDepthMaterial();
  const variants = new Map();
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
  const wide = Math.max(32, taps);
  const fn = /* glsl */ `
		// (never set, so 0: the tap loops get bounds the compiler cannot see, so it keeps them
		// as loops instead of unrolling and inlining every tap, which halves the compile time
		// of every lit program)
		uniform int sunShadowZero;
		float sunShadowTap(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			vec2 atlasSize, float bias, float texel, float range, float maxRadius, int cascade, vec4 coord, vec2 dz, float frameNo ) {
			coord.xyz /= coord.w;
			coord.z += bias;
			if ( coord.z > 1.0 ) return 1.0;
			// receiver plane: every tap compares against the receiver's depth at its own offset
			// (dz = depth gradient over the atlas), so a wide kernel on a surface the light
			// grazes does not shadow itself in streaks
			#if defined( SHADOWMAP_TYPE_PCF )
				vec2 tx = 1.0 / atlasSize;
				// kernel rotation: interleaved gradient noise, stepped every frame so the
				// temporal AA in post averages the pattern away instead of freezing a stipple
				float phi = interleavedGradientNoise( gl_FragCoord.xy + 5.588238 * frameNo ) * PI2;
				// coarse cascades always filter over two texels or more (no stair steps)
				// (and the near ones over 1.5: a contact edge filtered over a single texel shows the
				// shadow map's stair steps as a rope pattern along sills and string courses)
				float minR = cascade >= 2 ? 2.2 : 1.5;
				float maxR = clamp( maxRadius / texel, minR, ${MAX_FILTER_TEXELS.toFixed(1)} );
				// blocker search over the widest penumbra (5 taps): in a wide penumbra they
				// sometimes all agree and call a pixel fully lit or dark; with the rotation
				// stepping every frame the temporal AA averages those calls into a smooth ramp
				vec2 so[ 5 ];
				so[ 0 ] = vec2( 0.0 );
				float f0 = 1.0 - texture( shadowMap, coord.xyz );
				for ( int k = 1; k < 5 + sunShadowZero; k ++ ) {
					so[ k ] = vogelDiskSample( k - 1, 4, phi ) * maxR * tx;
					f0 += 1.0 - texture( shadowMap, vec3( coord.xy + so[ k ], coord.z + dot( dz, so[ k ] ) ) );
				}
				f0 *= 0.2;
				// and a ring at the narrowest filter's reach: a pixel is only called fully lit or
				// dark when the smallest kernel it could get agrees, so the edge between the pixels
				// that skip the filter and those that run it never follows the shadow map's texel
				// grid (a sawtooth along contact edges, as on an awning's valance)
				float fi = 0.0;
				for ( int k = 0; k < 4 + sunShadowZero; k ++ ) {
					vec2 o = vogelDiskSample( k, 4, phi + 0.785 ) * ( minR * 1.15 ) * tx;
					fi += 1.0 - texture( shadowMap, vec3( coord.xy + o, coord.z + dot( dz, o ) ) );
				}
				fi *= 0.25;
				if ( f0 <= 0.0 && fi <= 0.0 ) return 1.0;
				if ( f0 >= 1.0 && fi >= 1.0 ) return 0.0;
				float rt = minR;
				if ( f0 > 0.0 ) {
					// how far are the blockers? Probe whether the receiver, moved 0.4, 1.2, 3, 7, 15, 30
					// and 60 m towards the sun, is still blocked (stop once nothing is left); the
					// share that drops out between two probes lies between their distances
					float D[ 7 ];
					D[ 0 ] = 0.4; D[ 1 ] = 1.2; D[ 2 ] = 3.0; D[ 3 ] = 7.0; D[ 4 ] = 15.0; D[ 5 ] = 30.0; D[ 6 ] = 60.0;
					float prev = f0, dPrev = 0.0, dSum = 0.0;
					for ( int j = 0; j < 7 + sunShadowZero; j ++ ) {
						if ( prev <= 0.0 ) break;
						float f = 0.0;
						float dm = D[ j ] / range;
						for ( int k = 0; k < 5 + sunShadowZero; k ++ ) f += 1.0 - texture( shadowMap, vec3( coord.xy + so[ k ], coord.z + dot( dz, so[ k ] ) - dm ) );
						f = min( f * 0.2, prev );
						dSum += ( prev - f ) * sqrt( max( dPrev, 0.15 ) * D[ j ] );
						prev = f; dPrev = D[ j ];
					}
					float dEst = ( dSum + prev * 85.0 ) / f0;
					// penumbra half-width from the sun's angular radius: the disc kernel's edge
					// ramps over its diameter, as the umbra-to-light transition spans 0.0093 x distance
					rt = clamp( dEst * 0.0047 * 1.1 / texel, minR, maxR );
				}
				vec2 r = rt * tx;
				// penumbra taps: 16, and 32 for wide kernels and coarse cascades (only pixels
				// in a penumbra get here)
				int n = ( cascade >= 2 || rt > 3.0 ) ? ${wide} : SUN_PCF_TAPS;
				float s = 0.0;
				for ( int k = 0; k < n; k ++ ) {
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
			// frame number (mod 64) rides in cascade 0's lower depth bound (see updateMatrices)
			float frameNo = mod( - sunShadowCascade[ index - cascade ].x, 64.0 );
			float cs = sunShadowTap( shadowMap, sunLightShadow.shadowMapSize, sunLightShadow.shadowBias, texel, floor( data.w ),
				sunLightShadow.shadowRadius, cascade, M * wp, dz, frameNo );
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
			float f = smoothstep( sunShadowCascade[ base + ci ].z, sunShadowCascade[ base + ci ].y, viewDepth );
			// one call site for the filter (a 1-2 step loop: its own cascade and, in the fade
			// band, the next one), so the compiler inlines it once
			int nc = ( f > 0.0 && ci + 1 < SUN_LIGHT_CASCADES ) ? 2 : 1;
			float sh[ 2 ];
			sh[ 0 ] = 1.0; sh[ 1 ] = 1.0;
			for ( int q = 0; q < nc; q ++ ) sh[ q ] = sunShadowCascadeTap( shadowMap, sunLightShadow, base + ci + q, ci + q, dpx, dpy );
			return f > 0.0 ? mix( sh[ 0 ], sh[ 1 ], f ) : sh[ 0 ];
		}
	`;
  src = src.slice(0, start) + fn + '\n\t' + src.slice(end);
  src = src.replace('#define SUN_LIGHT_CASCADES 2', `#define SUN_LIGHT_CASCADES ${cascades}\n\t\t#define SUN_PCF_TAPS ${taps}`);
  SC.shadowmap_pars_fragment = src;
  return true;
}
