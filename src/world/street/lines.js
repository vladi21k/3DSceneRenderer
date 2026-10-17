import * as THREE from 'three';

// Pixel-width-aware line ribbons with analytic coverage.
//
// A rail head is 56 mm wide: at the default telephoto view it is under a pixel from
// ~200 m on, and plain geometry breaks into crawling dashes. Each line is drawn as a
// flat ribbon whose half width is widened in the vertex shader to at least uMinPx
// screen pixels; the fragment shader then integrates the real cross-section (head,
// groove, lip, seals, or a paint stripe) over the pixel footprint (fwidth of the
// lateral coordinate), so lines stay continuous, correctly weighted and converge
// cleanly to the vanishing point. Near the camera the rail overlay fades out where the
// real 3D rail geometry is resolved.

export const LINE_SHARED = {
  uViewport: { value: new THREE.Vector2(1920, 1080) },
};

const VERT_PARS = /* glsl */`
attribute vec3 aRight;
attribute vec4 aLine;   // x: side (-1|1), y: real half width, z: along (m), w: segment length / offset
uniform vec2 uViewport;
uniform float uMinPx;
varying vec4 vLine;     // x: lateral (m), y: along (m), z: aLine.w, w: pixels per metre (lateral)
varying vec3 vLineWorld;
varying float vLineHalf; // real half width (m)
`;

const VERT_MAIN = /* glsl */`
vec3 transformed = vec3( position );
{
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vec3 wr = normalize( mat3( modelMatrix ) * aRight );
  vec4 c0 = projectionMatrix * viewMatrix * wp;
  vec4 c1 = projectionMatrix * viewMatrix * vec4( wp.xyz + wr * 0.05, 1.0 );
  float pxPerM = 1e4;
  if ( c0.w > 0.05 && c1.w > 0.05 ) {
    vec2 sd = ( c1.xy / c1.w - c0.xy / c0.w ) * 0.5 * uViewport;
    pxPerM = max( length( sd ) / 0.05, 1e-3 );
  }
  float hw = aLine.y;
  hw = max( hw, min( uMinPx / pxPerM, 1.6 ) );
  transformed += aRight * ( aLine.x * hw );
  vLine = vec4( aLine.x * hw, aLine.z, aLine.w, pxPerM );
  vLineHalf = aLine.y;
  vLineWorld = wp.xyz + wr * ( aLine.x * hw );
}
`;

const FRAG_PARS = /* glsl */`
varying vec4 vLine;
varying vec3 vLineWorld;
varying float vLineHalf;
float lnCov( float a, float b, float x, float w ) {
  return clamp( ( min( b, x + 0.5 * w ) - max( a, x - 0.5 * w ) ) / w, 0.0, 1.0 );
}
float lnHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float lnNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( lnHash( i ), lnHash( i + vec2( 1, 0 ) ), u.x ), mix( lnHash( i + vec2( 0, 1 ) ), lnHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
`;

// Rail cross-section bands in rail-local x (+ towards the gauge side):
// field seal | rusty field bevel | polished head (incl. gauge corner) | groove | lip | gauge seal
const RAIL_FRAG = /* glsl */`
float lnRough = 0.5, lnMetal = 0.0;
{
  float x = vLine.x + vLine.z;                 // z carries the ribbon centre offset
  float w = max( length( vec2( dFdx( vLine.x ), dFdy( vLine.x ) ) ), 1e-5 );
  float along = vLine.y;
  float wear = lnNoise( vec2( along * 0.35, 3.1 ) ) * 0.6 + lnNoise( vec2( along * 2.7, 7.7 ) ) * 0.4;
  float cSeal = lnCov( -0.040, -0.028, x, w ) + lnCov( 0.083, 0.095, x, w );
  float cCorner = lnCov( -0.028, -0.024, x, w );
  float cBand = lnCov( -0.024, 0.028, x, w );
  float cGroove = lnCov( 0.028, 0.070, x, w );
  float cLip = lnCov( 0.070, 0.083, x, w );
  float cov = cSeal + cCorner + cBand + cGroove + cLip;
  float fade = 1.0;
  #ifdef LINE_NEAR_FADE
    fade = 1.0 - smoothstep( 2.6, 5.0, 0.056 * vLine.w );   // real rails take over close up
  #endif
  if ( cov * fade < 0.002 ) discard;
  // values follow the library rail materials (rail.head / rail.side / rail.groove / rubber)
  vec3 aSeal = vec3( 0.024, 0.023, 0.022 );
  vec3 aCorner = vec3( 0.21, 0.10, 0.045 ) * ( 0.8 + 0.4 * wear );
  vec3 aBand = vec3( 0.60 ) * ( 0.9 + 0.12 * wear );
  vec3 aGroove = vec3( 0.045, 0.040, 0.034 );
  vec3 aLip = vec3( 0.55 ) * ( 0.85 + 0.15 * wear );
  float inv = 1.0 / max( cov, 1e-4 );
  float wSeal = cSeal * inv, wCorner = cCorner * inv, wBand = cBand * inv, wGroove = cGroove * inv, wLip = cLip * inv;
  diffuseColor.rgb = aSeal * wSeal + aCorner * wCorner + aBand * wBand + aGroove * wGroove + aLip * wLip;
  lnMetal = wCorner * 0.2 + wBand + wLip;
  lnRough = wSeal * 0.95 + wCorner * 0.85 + wBand * ( 0.2 + 0.08 * wear ) + wGroove * 0.75 + wLip * 0.28;
  diffuseColor.a = clamp( cov * fade, 0.0, 1.0 );
}
`;

// Paint / joint stripe: lateral band of real half width aLine.y, either a dashed
// pattern along the line (uDash: period, duty) or a finite segment [0, aLine.w].
const PAINT_FRAG = /* glsl */`
float lnRough = uPaintRough, lnMetal = 0.0;
{
  float x = vLine.x;
  float w = max( length( vec2( dFdx( vLine.x ), dFdy( vLine.x ) ) ), 1e-5 );
  float u = vLine.y;
  float wu = max( length( vec2( dFdx( u ), dFdy( u ) ) ), 1e-5 );
  float cov = lnCov( -vLineHalf, vLineHalf, x, w );
  #ifdef LINE_DASH
    // box-filtered square wave: F(t) = floor(t)*duty + min(fract(t), duty)
    float P = uDash.x, duty = uDash.y;
    float t0 = ( u - 0.5 * wu ) / P, t1 = ( u + 0.5 * wu ) / P;
    float F0 = floor( t0 ) * duty + min( fract( t0 ), duty );
    float F1 = floor( t1 ) * duty + min( fract( t1 ), duty );
    cov *= clamp( ( F1 - F0 ) * P / wu, 0.0, 1.0 );
  #else
    cov *= lnCov( 0.0, vLine.z > 0.0 ? vLine.z : 1e9, u, wu );
  #endif
  // wear: worn-through patches and ragged edges (only resolved close up)
  float nfine = lnNoise( vLineWorld.xz * 23.0 ) * 0.5 + lnNoise( vLineWorld.xz * 6.0 ) * 0.5;
  float nbig = lnNoise( vLineWorld.xz * 0.33 + 17.0 ) * 0.7 + lnNoise( vLineWorld.xz * 1.1 + 5.0 ) * 0.3;
  float keep = smoothstep( uWear - 0.12, uWear + 0.12, nfine * 0.65 + nbig * 0.35 );
  float res = clamp( w * 40.0, 0.0, 1.0 );      // pixel footprint large -> average coverage instead
  cov *= mix( keep, 1.0 - uWear * 0.6, res );
  if ( cov < 0.002 ) discard;
  diffuseColor.rgb = uPaintColor * ( 0.88 + 0.12 * nbig );
  diffuseColor.a = cov * uPaintOpacity;
}
`;

function makeLineMaterial(kind, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: opts.offsetFactor ?? -4, polygonOffsetUnits: opts.offsetUnits ?? -8,
  });
  m.name = opts.name || `street.line.${kind}`;
  const defines = {};
  if (opts.nearFade) defines.LINE_NEAR_FADE = 1;
  if (opts.dash) defines.LINE_DASH = 1;
  m.defines = defines;
  const uniforms = {
    uViewport: LINE_SHARED.uViewport,
    uMinPx: { value: opts.minPx ?? 1.5 },
    uDash: { value: new THREE.Vector2(opts.dash ? opts.dash[0] : 1, opts.dash ? opts.dash[1] : 1) },
    uPaintColor: { value: new THREE.Color(opts.color ?? 0xffffff) },
    uPaintRough: { value: opts.roughness ?? 0.6 },
    uPaintOpacity: { value: opts.opacity ?? 1 },
    uWear: { value: opts.wear ?? 0.25 },
  };
  m.userData.lineUniforms = uniforms;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', VERT_MAIN);
    const body = kind === 'rail' ? RAIL_FRAG : PAINT_FRAG;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}\nuniform vec2 uDash;\nuniform vec3 uPaintColor;\nuniform float uPaintRough;\nuniform float uPaintOpacity;\nuniform float uWear;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = lnRough;\nmetalnessFactor = lnMetal;');
  };
  m.customProgramCacheKey = () => `street-line-${kind}-${opts.nearFade ? 1 : 0}-${opts.dash ? 1 : 0}`;
  return m;
}

/** Creates the shared line materials. */
export function createLineMaterials() {
  return {
    railNear: makeLineMaterial('rail', { nearFade: true, name: 'street.line.rail' }),
    railFar: makeLineMaterial('rail', { nearFade: false, name: 'street.line.railFar' }),
    // worn white line between the tracks (continuous, patchy with wear)
    centre: makeLineMaterial('paint', { color: 0xe4e2db, roughness: 0.62, wear: 0.34, opacity: 0.9, name: 'street.line.centre' }),
    // zebra stripes and stop lines (segments)
    stripe: makeLineMaterial('paint', { color: 0xecebe6, roughness: 0.58, wear: 0.3, opacity: 0.95, name: 'street.line.stripe' }),
    // bitumen-filled expansion joints across the corridor
    joint: makeLineMaterial('paint', { color: 0x161513, roughness: 0.5, wear: 0.12, opacity: 0.9, minPx: 1.2, name: 'street.line.joint' }),
  };
}

let UP = new Float32Array(0);
function upNormals(n) {
  if (UP.length < n * 3) {
    UP = new Float32Array(Math.max(n * 3, UP.length * 2));
    for (let i = 1; i < UP.length; i += 3) UP[i] = 1;
  }
  return UP.subarray(0, n * 3);
}

/**
 * Ribbon builder: add a polyline (world points on the surface) with a lateral unit
 * vector per point. halfW = real half width, extra = aLine.w (centre offset for rails,
 * real half width for dashes, segment length for segments).
 */
export class LineBuf {
  constructor(cap = 256) {
    this.n = 0; this.ni = 0;
    this._grow(cap);
  }
  _grow(cap) {
    const g = (old, k) => { const a = new Float32Array(cap * k); if (old) a.set(old.subarray(0, this.n * k)); return a; };
    this.pos = g(this.pos, 3); this.right = g(this.right, 3); this.line = g(this.line, 4);
    const idx = new Uint32Array(cap * 3);
    if (this.idx) idx.set(this.idx.subarray(0, this.ni));
    this.idx = idx;
    this.cap = cap;
  }
  /** pts: flat array [x,y,z, rx,rz, along, ...] (6 per point) */
  add(pts, halfW, extra) {
    const np = pts.length / 6;
    if (this.n + np * 2 > this.cap) this._grow(Math.max(this.cap * 2, this.n + np * 2 + 64));
    let prev = -1;
    for (let i = 0; i < np; i++) {
      const o = i * 6, v = this.n;
      for (let k = 0; k < 2; k++) {
        const j = v + k;
        this.pos[j * 3] = pts[o]; this.pos[j * 3 + 1] = pts[o + 1]; this.pos[j * 3 + 2] = pts[o + 2];
        this.right[j * 3] = pts[o + 3]; this.right[j * 3 + 1] = 0; this.right[j * 3 + 2] = pts[o + 4];
        this.line[j * 4] = k ? 1 : -1; this.line[j * 4 + 1] = halfW; this.line[j * 4 + 2] = pts[o + 5]; this.line[j * 4 + 3] = extra;
      }
      this.n += 2;
      if (prev >= 0) {
        const x = this.idx;
        x[this.ni++] = prev; x[this.ni++] = prev + 1; x[this.ni++] = v + 1;
        x[this.ni++] = prev; x[this.ni++] = v + 1; x[this.ni++] = v;
      }
      prev = v;
    }
  }
  get empty() { return this.ni === 0; }
  mesh(material, name) {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.subarray(0, n * 3), 3));
    g.setAttribute('aRight', new THREE.BufferAttribute(this.right.subarray(0, n * 3), 3));
    g.setAttribute('aLine', new THREE.BufferAttribute(this.line.subarray(0, n * 4), 4));
    // flat ribbons: the up normal is constant (a view into one shared array)
    g.setAttribute('normal', new THREE.BufferAttribute(upNormals(n), 3));
    g.setIndex(new THREE.BufferAttribute(this.idx.subarray(0, this.ni), 1));
    g.computeBoundingSphere();
    // ribbons widen in the vertex shader: pad the bounds so culling stays conservative
    g.boundingSphere.radius += 2;
    const m = new THREE.Mesh(g, material);
    m.name = name;
    m.castShadow = false;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.renderOrder = 2;
    return m;
  }
}
