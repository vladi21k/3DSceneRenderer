import * as THREE from 'three';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

// Cascaded sun shadows on top of the renderer's built-in sun light (one light, one
// shadow atlas, cascades blended in the shader). The stock SunLightShadow has two
// cascades with a fixed split; a telephoto view down a 700 m street needs more, with
// splits that follow the field of view. Every lit built-in material supports it
// without per-material patches.
//
// Shader conventions (patched getSunShadow below):
//   shadow.radius     PCF filter radius in metres (sun penumbra, constant in world space)
//   shadow.normalBias normal offset in shadow-map texels of the cascade in use
//   shadow.bias       small constant depth bias
//   cascade.w         world size of one texel in that cascade (metres)

const _m = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _c = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _far = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

export class StreetSunShadow extends SunLightShadow {
  constructor(cascades = 4) {
    super();
    this.cascades = cascades;
    this.fade = 0.14;            // fraction of each cascade blended into the next
    this.firstSplit = 30;        // metres at the default 17° field of view
    this._cameras = []; this._matrices = []; this._frustums = []; this._cascadeData = []; this._viewports = [];
    for (let i = 0; i < cascades; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4());
      this._viewports.push(new THREE.Vector4());
    }
    this._viewportCount = cascades;
    const cols = cascades <= 3 ? cascades : Math.ceil(cascades / 2);
    this._cols = cols;
    this._frameExtents.set(cols, Math.ceil(cascades / cols));
    this._cascadeSplits = new Array(cascades + 1).fill(0);
    this.splits = this._cascadeSplits;
  }

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
    const n = this.cascades, cols = this._cols;
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
      const insetTexels = Math.ceil(Math.max(this.radius / texelGuess, 1) + this.normalBias) + 2;
      const inset = Math.min(0.2, insetTexels / tile);
      const col = i % cols, row = Math.floor(i / cols);
      this._viewports[i].set(col + inset, row + inset, 1 - 2 * inset, 1 - 2 * inset);
      const res = tile * (1 - 2 * inset);

      // snap to the texel grid (rotation-stable sphere fit, so no shimmer while moving)
      radius /= 1 - 1 / res;
      const texel = (2 * radius) / res;
      _c.x = Math.round(_c.x / texel) * texel;
      _c.y = Math.round(_c.y / texel) * texel;
      _c.z = maxZ + shadowNear;
      _c.applyMatrix4(_m);

      this._cascadeData[i].set(i === 0 ? -1e10 : cNear, cFar, fadeStart, texel);

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
      this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
    }
  }
}

/**
 * Patch the global shadow chunk: cascade count + a sun PCF with a world-space radius,
 * per-cascade normal offset and more taps. Must run before any lit material compiles.
 */
export function patchSunShadowChunk(cascades, taps = 10) {
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
  const fn = /* glsl */ `
		float sunShadowTap(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			vec2 atlasSize, float bias, float radiusTexels, vec4 coord ) {
			coord.xyz /= coord.w;
			coord.z += bias;
			if ( coord.z > 1.0 ) return 1.0;
			#if defined( SHADOWMAP_TYPE_PCF )
				vec2 r = radiusTexels / atlasSize;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				float s = 0.0;
				for ( int k = 0; k < SUN_PCF_TAPS; k ++ ) {
					s += texture( shadowMap, vec3( coord.xy + vogelDiskSample( k, SUN_PCF_TAPS, phi ) * r, coord.z ) );
				}
				return s / float( SUN_PCF_TAPS );
			#else
				return step( coord.z, texture2D( shadowMap, coord.xy ).r );
			#endif
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
			int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
			float shadow = 1.0;
			for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {
				vec4 cascade = sunShadowCascade[ cascadeOffset + i ];
				if ( viewDepth >= cascade.x && viewDepth < cascade.y ) {
					float texel = cascade.w;
					vec4 wp = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * ( sunLightShadow.shadowNormalBias * texel ), 1.0 );
					float rt = max( sunLightShadow.shadowRadius / texel, 0.85 );
					float cs = sunShadowTap( shadowMap, sunLightShadow.shadowMapSize, sunLightShadow.shadowBias, rt, sunShadowMatrix[ cascadeOffset + i ] * wp );
					cs = mix( 1.0, cs, sunLightShadow.shadowIntensity );
					shadow = mix( cs, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );
				}
			}
			return shadow;
		}
	`;
  src = src.slice(0, start) + fn + '\n\t' + src.slice(end);
  src = src.replace('#define SUN_LIGHT_CASCADES 2', `#define SUN_LIGHT_CASCADES ${cascades}\n\t\t#define SUN_PCF_TAPS ${taps}`);
  SC.shadowmap_pars_fragment = src;
  return true;
}
