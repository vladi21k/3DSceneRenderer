import * as THREE from 'three';
import { RAIL_X0, RAIL_X1, HEAD_HALF, HEAD_DULL, GROOVE_OUT, LIP_OUT, GROUT_W, MORTAR_ALBEDO, SEAL_TONE } from './constants.js';
import { patchCanyon } from './shading.js';

// Pixel-width-aware line ribbons with analytic coverage.
//
// A rail head is 56 mm wide: at the default telephoto view it is under a pixel from
// ~200 m on, and plain geometry breaks into crawling dashes. Each line is drawn as a
// flat ribbon whose half width is widened in the vertex shader to at least minPx
// screen pixels; the fragment shader then integrates the real cross-section (head,
// groove, lip, seals, or a paint stripe) over the pixel footprint (fwidth of the
// lateral coordinate), so lines stay continuous, correctly weighted and converge
// cleanly to the vanishing point. Near the camera the rail overlay fades out where the
// real 3D rail geometry is resolved.

export const LINE_SHARED = {
  uViewport: { value: new THREE.Vector2(1920, 1080) },
};

// Line styles, one per ribbon (aRight.w). Every line of a chunk is one mesh with one
// material: rails (far: analytic coverage only; near: also fade out where the 3D rails
// are resolved), paint (worn centre line, zebra stripes / stop lines, and the
// sealant-filled expansion joints, dashed and irregular), and the wear of the asphalt
// side streets: bitumen crack seals and hairline cracks, saw-cut repair patches with
// sealed joints, and tyre polish / oil drip bands.
export const LINE_STYLE = { railFar: 0, railNear: 1, centre: 2, stripe: 3, joint: 4, seal: 5, patch: 6, polish: 7 };
// patches: their ribbon reaches PATCH_PAD beyond the cut on every side (the sealed joint
// overlaps it), so aLine.y = half width + PATCH_PAD and the points run from -PATCH_PAD to
// length + PATCH_PAD
export const PATCH_PAD = 0.06;
/** Wear value of a patch ribbon: the radius (m) of a cover lying in its centre (cut out
 *  of the patch) and its tone, -1 (fresh, dark binder) .. 1 (aged, grey). */
export const patchWear = (hole, tone) => Math.round(hole * 1000) + 0.02 + 0.96 * (tone * 0.5 + 0.5);
const PAINT = [
  null, null,
  { color: 0xd8d6ce, roughness: 0.62, wear: 0.18, opacity: 0.8 },                         // centre
  { color: 0xdedcd5, roughness: 0.58, wear: 0.36, opacity: 0.87 },                         // stripe
  { color: 0x3a342c, roughness: 0.6, wear: 0.12, opacity: 0.65, dash: [0.18, 0.65], minPx: 1.2 }, // joint
];

const VERT_PARS = /* glsl */`
attribute vec4 aRight;  // xz: lateral unit vector; y: per-line wear factor (paint); w: style
attribute vec4 aLine;   // x: side (-1|1), y: real half width, z: along (m), w: segment length / offset
                        // (position: the ribbon edge at the real half width)
uniform vec2 uViewport;
varying vec4 vLine;     // x: lateral (m), y: along (m), z: aLine.w, w: pixels per metre (lateral)
varying vec3 vLineWorld;
varying vec3 vLineRightW; // world lateral unit vector of the ribbon
varying float vLineHalf; // real half width (m)
varying float vLineWear; // per-line wear factor
varying float vLineStyle;
`;

const VERT_MAIN = /* glsl */`
vec3 transformed = vec3( position );
{
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vec3 wr = normalize( mat3( modelMatrix ) * vec3( aRight.x, 0.0, aRight.z ) );
  vLineWear = aRight.y;
  vLineStyle = aRight.w;
  vec4 c0 = projectionMatrix * viewMatrix * wp;
  vec4 c1 = projectionMatrix * viewMatrix * vec4( wp.xyz + wr * 0.05, 1.0 );
  float pxPerM = 1e4;
  if ( c0.w > 0.05 && c1.w > 0.05 ) {
    vec2 sd = ( c1.xy / c1.w - c0.xy / c0.w ) * 0.5 * uViewport;
    pxPerM = max( length( sd ) / 0.05, 1e-3 );
  }
  // pad by a pixel so the rasterized edge never cuts the analytic coverage (no stair
  // dots along thin bands), and keep at least minPx half width for sub-pixel lines
  // (joints and crack seals: thinner)
  float minPx = aRight.w > ${(LINE_STYLE.joint - 0.5).toFixed(1)} && aRight.w < ${(LINE_STYLE.seal + 0.5).toFixed(1)} ? ${PAINT[LINE_STYLE.joint].minPx.toFixed(2)} : 1.5;
  float hw = aLine.y + 1.0 / pxPerM;
  hw = max( hw, min( minPx / pxPerM, 1.6 ) );
  // the vertex lies on the real edge (on the surface's cross slope); widen beyond it in
  // the horizontal plane only (aRight.y carries the wear factor)
  float pad = aLine.x * ( hw - aLine.y );
  transformed += vec3( aRight.x, 0.0, aRight.z ) * pad;
  vLine = vec4( aLine.x * hw, aLine.z, aLine.w, pxPerM );
  vLineHalf = aLine.y;
  vLineRightW = wr;
  vLineWorld = wp.xyz + wr * pad;
}
`;

const FRAG_PARS = /* glsl */`
varying vec4 vLine;
varying vec3 vLineWorld;
varying vec3 vLineRightW;
varying float vLineHalf;
varying float vLineWear;
varying float vLineStyle;
float lnCov( float a, float b, float x, float w ) {
  return clamp( ( min( b, x + 0.5 * w ) - max( a, x - 0.5 * w ) ) / w, 0.0, 1.0 );
}
float lnHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float lnNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( lnHash( i ), lnHash( i + vec2( 1, 0 ) ), u.x ), mix( lnHash( i + vec2( 0, 1 ) ), lnHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
// fbm of rotated octaves; fp = pixel footprint in p units (unresolved octaves -> mean)
float lnFbm( vec2 p, float fp, int oct ) {
  const mat2 R = mat2( 0.8, 0.6, -0.6, 0.8 );
  float s = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 5; i++ ) {
    if ( i >= oct ) break;
    s += a * mix( lnNoise( p ), 0.5, smoothstep( 0.3, 0.7, fp ) );
    n += a;
    p = R * p * 2.07 + 3.7;
    fp *= 2.07;
    a *= 0.55;
  }
  return s / n;
}
`;

// Rail cross-section bands in rail-local x (+ towards the gauge side):
// mortar | field seal | oxidised field bevel | polished head (incl. gauge corner) | groove |
// lip | gauge seal | mortar
const f = (v) => v.toFixed(4);
const v3 = (a, k = 1) => `vec3( ${f(a[0] * k)}, ${f(a[1] * k)}, ${f(a[2] * k)} )`;
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const RAIL_FRAG = /* glsl */`
{
  float x = vLine.x + vLine.z;                 // z carries the ribbon centre offset
  float along = vLine.y;
  float wear = lnNoise( vec2( along * 0.35, 3.1 ) ) * 0.6 + lnNoise( vec2( along * 2.7, 7.7 ) ) * 0.4;
  float cSeal = lnCov( ${f(RAIL_X0)}, ${f(-HEAD_HALF)}, x, w ) + lnCov( ${f(LIP_OUT)}, ${f(RAIL_X1)}, x, w );
  float cCorner = lnCov( ${f(-HEAD_HALF)}, ${f(HEAD_DULL)}, x, w );
  float cBand = lnCov( ${f(HEAD_DULL)}, ${f(HEAD_HALF)}, x, w );
  float cGroove = lnCov( ${f(HEAD_HALF)}, ${f(GROOVE_OUT)}, x, w );
  float cLip = lnCov( ${f(GROOVE_OUT)}, ${f(LIP_OUT)}, x, w );
  float cGrout = lnCov( ${f(RAIL_X0 - GROUT_W)}, ${f(RAIL_X0)}, x, w ) + lnCov( ${f(RAIL_X1)}, ${f(RAIL_X1 + GROUT_W)}, x, w );
  float cov = cSeal + cCorner + cBand + cGroove + cLip + cGrout;
  float fade = 1.0, core = 0.0;
  if ( vLineStyle > 0.5 ) {
    // near rails: the real rails take over once their narrowest bands (12-13 mm seals
    // and lip) span a few pixels; further out the 3D bands would alias into dash trains
    fade = 1.0 - smoothstep( 1.5, 3.0, 0.012 * vLine.w );
    // the 3D rail is rasterized under every pixel centre inside the rail span, so cover
    // those pixels fully (the uncovered part of their footprint is paving, filled in
    // below); otherwise the sub-pixel 3D groove and seals leak through as dotted edges
    core = step( ${f(RAIL_X0 - GROUT_W)}, x ) * step( x, ${f(RAIL_X1 + GROUT_W)} );
  }
  float alpha = mix( cov, 1.0, core ) * fade;
  if ( alpha < 0.002 ) discard;
  // effective albedos of the 3D rail (materials × cavity AO), so the hand-over is seamless
  vec3 aSeal = ${v3(MORTAR_ALBEDO, SEAL_TONE * 0.88)};               // bitumen seal
  vec3 aCorner = vec3( 0.2, 0.15, 0.11 ) * ( 0.85 + 0.3 * wear );  // oxidised field bevel
  vec3 aBand = vec3( 0.60 ) * ( 0.9 + 0.12 * wear );
  vec3 aGroove = vec3( 0.05, 0.045, 0.037 );                        // grit-filled slot (grit floor, dark walls)
  vec3 aLip = vec3( 0.3, 0.29, 0.275 ) * ( 0.9 + 0.14 * wear );    // dusty guard lip
  vec3 aGrout = ${v3(MORTAR_ALBEDO, 0.95)};                          // mortar bed
  vec3 aPave = vec3( 0.245, 0.241, 0.236 );                         // brake-dusted setts beside it
  float cPave = core * max( 0.0, 1.0 - cov );
  float inv = 1.0 / max( cov + cPave, 1e-4 );
  float wSeal = cSeal * inv, wCorner = cCorner * inv, wBand = cBand * inv, wGroove = cGroove * inv, wLip = cLip * inv, wPave = cPave * inv, wGrout = cGrout * inv;
  diffuseColor.rgb = aSeal * wSeal + aCorner * wCorner + aBand * wBand + aGroove * wGroove + aLip * wLip + aPave * wPave + aGrout * wGrout;
  lnMetal = wCorner * 0.6 + wBand + wLip * 0.85;
  lnRough = wSeal * 0.85 + wCorner * 0.6 + wBand * ( 0.17 + 0.08 * wear ) + wGroove * 0.75 + wLip * 0.62 + wPave * 0.7 + wGrout * 0.9;
  diffuseColor.a = clamp( alpha, 0.0, 1.0 );
}
`;

// Paint / joint stripe: lateral band of real half width aLine.y, either a dashed
// pattern along the line (joints: period, duty; jittered so sealant seams are
// irregular) or a finite segment [0, aLine.w].
const paintConst = (st) => {
  const P = PAINT[st];
  return `pCol = ${v3(lin(P.color))}; pRough = ${f(P.roughness)}; pWear = ${f(P.wear)}; pOpacity = ${f(P.opacity)};`;
};
const J = PAINT[LINE_STYLE.joint];
const PAINT_FRAG = /* glsl */`
{
  vec3 pCol; float pRough, pWear, pOpacity;
  bool dash = vLineStyle > ${(LINE_STYLE.joint - 0.5).toFixed(1)};
  if ( dash ) { ${paintConst(LINE_STYLE.joint)} }
  else if ( vLineStyle > ${(LINE_STYLE.stripe - 0.5).toFixed(1)} ) { ${paintConst(LINE_STYLE.stripe)} }
  else { ${paintConst(LINE_STYLE.centre)} }
  lnRough = pRough;
  float x = vLine.x;
  float u = vLine.y;
  float cov = lnCov( -vLineHalf, vLineHalf, x, w );
  float ends = 1.0;
  if ( dash ) {
    // box-filtered square wave: F(t) = floor(t)*duty + min(fract(t), duty)
    const float P = ${f(J.dash[0])}, duty = ${f(J.dash[1])};
    float uj = u + ( lnNoise( vec2( u * 2.3, 4.1 ) ) - 0.5 ) * 0.8 * P;
    float t0 = ( uj - 0.5 * wu ) / P, t1 = ( uj + 0.5 * wu ) / P;
    float F0 = floor( t0 ) * duty + min( fract( t0 ), duty );
    float F1 = floor( t1 ) * duty + min( fract( t1 ), duty );
    cov *= clamp( ( F1 - F0 ) * P / wu, 0.0, 1.0 );
  } else {
    float segLen = vLine.z > 0.0 ? vLine.z : 1e9;
    cov *= lnCov( 0.0, segLen, u, wu );
    ends = 1.0 - smoothstep( 0.0, 0.4, min( u, segLen - u ) );   // dirt towards stripe ends
  }
  // Wear: the paint is cut only by grain-sized flecks (aggregate showing through, 20-40
  // per metre) with a soft threshold; larger walked-on patches only thin it, so worn
  // lines stay continuous instead of breaking into dashes. Octaves finer than the pixel
  // footprint fade to their mean, so distant paint shows its average coverage.
  vec2 wp = vLineWorld.xz;
  float wear = pWear * ( vLineWear > 0.0 ? vLineWear : 1.0 );
  float big = lnFbm( wp * 0.4 + 17.0, fpw * 0.4, 3 );             // walked-on patches
  float mid = lnFbm( wp * 3.1 + 5.0, fpw * 3.1, 3 );              // thinner blotches
  float grain = lnFbm( wp * 30.0 + 9.0, fpw * 30.0, 2 );          // flecks
  float field = 0.5 + ( grain - 0.5 ) * 2.4 + ( mid - 0.5 ) * 0.9;
  float keep = smoothstep( wear - 0.1, wear + 0.1, field );
  keep *= mix( 0.72, 1.0, smoothstep( 0.3, 0.6, big ) ) * ( 1.0 - 0.25 * wear * ends );
  keep = mix( keep, ( 1.0 - 0.7 * wear ) * 0.88, smoothstep( 0.012, 0.04, fpw ) );   // far: mean
  cov *= keep;
  if ( cov < 0.002 ) discard;
  // dirt ground into the paint where it is walked on most, and towards the ends
  float dirt = clamp( 0.5 - ( big - 0.5 ) * 2.4, 0.0, 1.0 );
  diffuseColor.rgb = pCol * ( 0.93 - 0.17 * dirt - 0.12 * ends ) * ( 0.96 + 0.08 * mid );
  diffuseColor.a = cov * pOpacity;
}
`;

// Asphalt wear (side streets), x lateral and u along the ribbon (m):
//  seal:   bitumen poured into a crack, its edges wavering and pooling, dust and grit
//          worked into it (aLine.y: twice the nominal half width; aLine.w: length; wear:
//          dust 0..1); hairline cracks are the same at a few millimetres, so they fade to
//          a faint darkening by pixel coverage;
//  patch:  saw-cut repair [-half, half] x [0, length] in a fresh dark or an aged grey mix
//          with its own mottling, edged by a wavering sealed joint (wear: patchWear);
//  polish: soft band in a wheel path, darker and smoother where tyres polish the
//          binder, or an oil drip band, mottled along (wear: strength); with a negative
//          strength a band of lighter dust along a kerb.
const ASPHALT_FRAG = /* glsl */`
{
  float x = vLine.x, u = vLine.y, len = vLine.z;
  vec2 wp = vLineWorld.xz;
  float dust = lnFbm( wp * 3.0 + 7.0, fpw * 3.0, 3 );
  float grit = lnFbm( wp * 40.0 + 1.3, fpw * 40.0, 2 );
  vec3 sealCol = vec3( 0.016, 0.0155, 0.015 );
  if ( vLineStyle < ${(LINE_STYLE.seal + 0.5).toFixed(1)} ) {
    // both edges waver on their own, and the sealant pooled wider here and there (the
    // ribbon is twice the nominal half width)
    float h = vLineHalf * 0.5;
    float pool = smoothstep( 0.72, 0.95, lnNoise( vec2( u * 0.9, 2.2 ) ) );
    float lo = -h * ( 0.5 + 0.45 * lnNoise( vec2( u * 2.1, 5.3 ) ) + 0.3 * lnNoise( vec2( u * 13.0, 1.9 ) ) + 0.7 * pool );
    float hi = h * ( 0.5 + 0.45 * lnNoise( vec2( u * 1.7, 9.1 ) ) + 0.3 * lnNoise( vec2( u * 11.0, 8.4 ) ) + 0.7 * pool );
    float cov = lnCov( lo, hi, x, w ) * lnCov( 0.0, len, u, wu ) * clamp( min( u, len - u ) / 0.12, 0.0, 1.0 );
    if ( cov < 0.002 ) discard;
    float d = clamp( ( dust - 0.45 ) * 1.6 + vLineWear * 0.7, 0.0, 1.0 );
    diffuseColor.rgb = sealCol * ( 1.0 + 3.5 * d ) * ( 0.8 + 0.4 * grit );
    lnRough = mix( 0.32, 0.75, d );
    diffuseColor.a = cov * 0.92;
  } else if ( vLineStyle < ${(LINE_STYLE.patch + 0.5).toFixed(1)} ) {
    float hx = vLineHalf - ${f(PATCH_PAD)};
    float hole = floor( vLineWear ) * 0.001;
    float tone = ( fract( vLineWear ) - 0.02 ) / 0.96 * 2.0 - 1.0;
    // the joint wanders a little about the cut and is wider where the sealant spread
    float jw = lnNoise( wp * 3.3 + 5.0 );
    float e1 = 0.012 + 0.022 * jw, e0 = 0.006 + 0.008 * jw;
    float cFill = lnCov( -hx, hx, x, w ) * lnCov( 0.0, len, u, wu );
    float cOut = lnCov( -hx - e1, hx + e1, x, w ) * lnCov( -e1, len + e1, u, wu );
    float cCore = lnCov( -hx + e0, hx - e0, x, w ) * lnCov( e0, len - e0, u, wu );
    float cSeal = max( cOut - cCore, 0.0 ) * ( 0.75 + 0.25 * jw );
    if ( hole > 0.0 ) {
      // a cover lies in the middle: neither fill nor joint over it
      float r = length( vec2( x, u - 0.5 * len ) );
      float k = clamp( ( r - hole ) / max( w, 1e-4 ) + 0.5, 0.0, 1.0 );
      cFill *= k; cSeal *= k;
    }
    // fill: shifts the asphalt underneath towards fresh black binder or aged grey, mottled
    float mot = lnFbm( wp * 0.8 + 13.0, fpw * 0.8, 3 );
    vec3 fillCol = tone < 0.0 ? vec3( 0.02, 0.019, 0.018 ) : vec3( 0.2, 0.195, 0.185 );
    float aFill = cFill * abs( tone ) * ( 0.5 + 0.35 * mot ) * ( 0.85 + 0.3 * grit );
    float aSeal = cSeal * 0.88;
    float a = aSeal + aFill * ( 1.0 - aSeal );
    if ( a < 0.002 ) discard;
    float d = clamp( ( dust - 0.4 ) * 1.8 + 0.3, 0.0, 1.0 );
    vec3 sc = sealCol * ( 1.0 + 3.0 * d ) * ( 0.8 + 0.4 * grit );
    float wf = aFill * ( 1.0 - aSeal ) / a;
    diffuseColor.rgb = mix( sc, fillCol, wf );
    lnRough = mix( mix( 0.3, 0.72, d ), tone < 0.0 ? 0.74 : 0.9, wf );
    diffuseColor.a = a;
  } else {
    float q = x / vLineHalf;
    float prof = max( 0.0, 1.0 - q * q );
    prof *= prof * smoothstep( 0.0, 1.5, u ) * smoothstep( 0.0, 1.5, len - u );
    float mot = lnFbm( wp * 0.55 + 23.0, fpw * 0.55, 3 );
    float a = prof * clamp( 0.3 + 1.2 * ( mot - 0.35 ), 0.0, 1.0 ) * abs( vLineWear ) * 0.6;
    if ( a < 0.002 ) discard;
    if ( vLineWear > 0.0 ) {
      diffuseColor.rgb = vec3( 0.022, 0.021, 0.02 ) * ( 0.9 + 0.2 * grit );
      lnRough = 0.5;
    } else {
      // (negative strength) dry dust and grit swept to the kerb side
      diffuseColor.rgb = vec3( 0.23, 0.215, 0.19 ) * ( 0.85 + 0.3 * grit );
      lnRough = 0.95;
    }
    diffuseColor.a = a;
  }
}
`;

// pixel footprints are taken before the style branch (derivatives in uniform control flow)
const LINE_FRAG = /* glsl */`
float lnRough = 0.5, lnMetal = 0.0;
float w = max( length( vec2( dFdx( vLine.x ), dFdy( vLine.x ) ) ), 1e-5 );
float wu = max( length( vec2( dFdx( vLine.y ), dFdy( vLine.y ) ) ), 1e-5 );
float fpw = max( length( fwidth( vLineWorld.xz ) ), 1e-4 );     // metres per pixel
if ( vLineStyle < ${(LINE_STYLE.centre - 0.5).toFixed(1)} ) ${RAIL_FRAG}
else if ( vLineStyle < ${(LINE_STYLE.joint + 0.5).toFixed(1)} ) ${PAINT_FRAG}
else ${ASPHALT_FRAG}
`;

/** The shared line material (all styles; rails reflect the street canyon). */
export function createLineMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
  });
  m.name = 'street.line';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uViewport = LINE_SHARED.uViewport;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${LINE_FRAG}`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = lnRough;\nmetalnessFactor = lnMetal;');
  };
  m.customProgramCacheKey = () => 'street-line-3';
  return patchCanyon(m, 'line');
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
 * segment length for segments). All styles share one buffer; style(k) returns a writer
 * with a fixed LINE_STYLE.
 */
export class LineBuf {
  constructor(cap = 256) {
    this.n = 0; this.ni = 0;
    this._grow(cap);
  }
  _grow(cap) {
    const g = (old, k) => { const a = new Float32Array(cap * k); if (old) a.set(old.subarray(0, this.n * k)); return a; };
    this.pos = g(this.pos, 3); this.right = g(this.right, 4); this.line = g(this.line, 4);
    const idx = new Uint32Array(cap * 3);
    if (this.idx) idx.set(this.idx.subarray(0, this.ni));
    this.idx = idx;
    this.cap = cap;
  }
  /** pts: flat array [x,y,z, rx,rz, along, ...] (6 per point, or 7 with stride 7: plus
   *  the surface's slope (dh/dm) along the right vector, so wide ribbons lie on a cross
   *  slope); wear scales the paint style's wear for this line. */
  add(pts, halfW, extra, style, wear = 1, stride = 6) {
    const np = pts.length / stride;
    if (this.n + np * 2 > this.cap) this._grow(Math.max(this.cap * 2, this.n + np * 2 + 64));
    let prev = -1;
    for (let i = 0; i < np; i++) {
      const o = i * stride, v = this.n;
      const rx = pts[o + 3], rz = pts[o + 4], dy = stride > 6 ? pts[o + 6] * halfW : 0;
      for (let k = 0; k < 2; k++) {
        const j = v + k, sd = k ? 1 : -1;
        this.pos[j * 3] = pts[o] + rx * sd * halfW; this.pos[j * 3 + 1] = pts[o + 1] + dy * sd; this.pos[j * 3 + 2] = pts[o + 2] + rz * sd * halfW;
        this.right[j * 4] = rx; this.right[j * 4 + 1] = wear; this.right[j * 4 + 2] = rz; this.right[j * 4 + 3] = style;
        this.line[j * 4] = sd; this.line[j * 4 + 1] = halfW; this.line[j * 4 + 2] = pts[o + 5]; this.line[j * 4 + 3] = extra;
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
  /** Writer for one style: { add(pts, halfW, extra, wear, stride) }. */
  style(k) {
    return { add: (pts, halfW, extra, wear = 1, stride = 6) => this.add(pts, halfW, extra, k, wear, stride) };
  }
  get empty() { return this.ni === 0; }
  /** Forget the written lines (the arrays are kept as scratch space). */
  reset() { this.n = 0; this.ni = 0; return this; }
  /** Mesh over exact-size copies of the written range (the buffer can be reused). */
  mesh(material, name) {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('aRight', new THREE.BufferAttribute(this.right.slice(0, n * 4), 4));
    g.setAttribute('aLine', new THREE.BufferAttribute(this.line.slice(0, n * 4), 4));
    // flat ribbons: the up normal is constant (a view into one shared array)
    g.setAttribute('normal', new THREE.BufferAttribute(upNormals(n), 3));
    const src = this.idx.subarray(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(n <= 65535 ? new Uint16Array(src) : src.slice(), 1));
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
