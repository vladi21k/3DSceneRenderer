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
// A pixel samples at most two cascades (its own and, in the fade band, the next one),
// so the filter is inlined twice per program rather than once per cascade.
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

// casters too fine for a coarse cascade: wrought iron, ironwork cards, lamp scrolls
const THIN_MATERIAL = /^(ironwork\.(parts|card)|metal\.(iron|wire))|catenaryThin/;
const THIN_TEXEL = 0.05;      // cascades with texels coarser than this (m) skip them
const SUBTEXEL = 1.5;         // casters smaller than this many texels (radius) are skipped
const MAX_FILTER_TEXELS = 16; // widest PCF kernel (texels): wider would only add noise
const REFRESH = [1, 1, 2, 4]; // frames between redraws per cascade (far ones staggered)

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

/** World bounding sphere of a caster, computed once per frame and shared by the cascades. */
const SPHERE = Symbol('sunShadowSphere');
function worldSphere(object, frame) {
  let c = object[SPHERE];
  if (c && c.f === frame) return c.ok ? c.s : null;
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
  constructor() {
    super();
    this.zNear = -Infinity;
    this.zFar = Infinity;
    this.ctx = null;
    this.skip = false;
    this.skipThin = false;
    this.minRadius = 0;
    this.acceptAll = false;
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
      const dd = h * c.cotE * c.awayDotFwd;    // view-depth component of the top's shadow reach
      const lo = Math.min(d, d + dd) - r - 6, hi = Math.max(d, d + dd) + r + 6;
      if (hi < this.zNear || lo > this.zFar) return false;
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
      this._frustums.push(new CascadeFrustum());
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
			vec2 atlasSize, float bias, float texel, float range, float maxRadius, int cascade, vec4 coord ) {
			coord.xyz /= coord.w;
			coord.z += bias;
			if ( coord.z > 1.0 ) return 1.0;
			#if defined( SHADOWMAP_TYPE_PCF )
				vec2 tx = 1.0 / atlasSize;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				// coarse cascades always filter over two texels or more (no stair steps)
				float minR = cascade >= 2 ? 2.0 : 1.0;
				float maxR = clamp( maxRadius / texel, minR, ${MAX_FILTER_TEXELS.toFixed(1)} );
				// blocker search over the widest penumbra
				vec2 so[ 5 ];
				so[ 0 ] = vec2( 0.0 );
				float f0 = 1.0 - texture( shadowMap, coord.xyz );
				for ( int k = 1; k < 5; k ++ ) {
					so[ k ] = vogelDiskSample( k - 1, 4, phi ) * maxR * tx;
					f0 += 1.0 - texture( shadowMap, vec3( coord.xy + so[ k ], coord.z ) );
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
					for ( int k = 0; k < 5; k ++ ) f += 1.0 - texture( shadowMap, vec3( coord.xy + so[ k ], coord.z - dm[ j ] ) );
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
					s += texture( shadowMap, vec3( coord.xy + vogelDiskSample( k, n, phi + 1.3 ) * r, coord.z ) );
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
			SunLightShadow sunLightShadow, int index, int cascade ) {
			vec4 data = sunShadowCascade[ index ];
			float texel = fract( data.w );
			vec4 wp = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * ( sunLightShadow.shadowNormalBias * texel ), 1.0 );
			float cs = sunShadowTap( shadowMap, sunLightShadow.shadowMapSize, sunLightShadow.shadowBias, texel, floor( data.w ),
				sunLightShadow.shadowRadius, cascade, sunShadowMatrix[ index ] * wp );
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
			// the nearest cascade holding this depth; in its fade band, blend into the next
			int ci = - 1;
			for ( int i = 0; i < SUN_LIGHT_CASCADES; i ++ ) {
				vec4 c = sunShadowCascade[ base + i ];
				if ( ci < 0 && viewDepth >= c.x && viewDepth < c.y ) ci = i;
			}
			if ( ci < 0 ) return 1.0;
			vec4 cascade = sunShadowCascade[ base + ci ];
			float shadow = sunShadowCascadeTap( shadowMap, sunLightShadow, base + ci, ci );
			float f = smoothstep( cascade.z, cascade.y, viewDepth );
			if ( f > 0.0 ) {
				float next = ci + 1 < SUN_LIGHT_CASCADES ? sunShadowCascadeTap( shadowMap, sunLightShadow, base + ci + 1, ci + 1 ) : 1.0;
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
