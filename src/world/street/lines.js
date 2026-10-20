import * as THREE from 'three';
import { RAIL_X0, RAIL_X1, HEAD_HALF, HEAD_DULL, GROOVE_OUT, LIP_OUT, GROUT_W, SEAL_TONE, pavingTones } from './constants.js';
import { patchRailSheen, RAIL_BAND_ROUGH, DUST_ROUGH } from './shading.js';

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
export const LINE_STYLE = { railFar: 0, railNear: 1, centre: 2, stripe: 3, joint: 4, seal: 5, patch: 6, polish: 7, repair: 8, drip: 9, relay: 10 };
// patches: their ribbon reaches PATCH_PAD beyond the cut on every side (the sealed joint
// overlaps it), so aLine.y = half width + PATCH_PAD and the points run from -PATCH_PAD to
// length + PATCH_PAD
export const PATCH_PAD = 0.06;
/** Drip band (LINE_STYLE.drip): full within DRIP_CORE of its centre line, gone DRIP_SOFT
 *  further out; DRIP_ALPHA is its opacity at strength 1 and mean density (the ribbon's
 *  half width must cover DRIP_CORE * 1.15 + DRIP_SOFT + 0.04 of wander). */
export const DRIP_CORE = 0.26, DRIP_SOFT = 0.2, DRIP_ALPHA = 0.18;
/** Repairs whose sides step with the courses (wear.js STEP_WALK_U, STEP_STREET_U) have
 *  ribbons this much wider on both sides; those whose ends step reach this much further
 *  at both ends (the steps reach out up to 0.2 m). */
export const STEP_PAD = 0.2;
/** Relay ribbons (relaid setts, wear.js) reach this far beyond their strip on both sides. */
export const RELAY_PAD = 0;
/** Wear value of a relay ribbon: the batch's tone k (0.6..1.4, relative to the setts
 *  round it) and hue h (-0.1..0.1: + warmer, - cooler). */
export const relayWear = (k, h) => Math.round((Math.max(-0.1, Math.min(0.1, h)) + 0.1) * 500) + 0.5 * Math.max(0.5, Math.min(1.45, k));
/** Added to a paint stripe's wear value when it is laid over setts (the paint cracks
 *  along the sett bed joints, which then must lie at whole multiples of 0.2 m of its
 *  along coordinate). */
export const SETT_FLAG = 10;
/** Added (once or twice) to a paint stripe's wear value when a long edge of it runs beside
 *  a rail: RAIL_FLAG for its -x edge (the left one, looking along it), 2 * RAIL_FLAG for
 *  its +x edge; the film flakes and greys along that edge (see paintWear). */
export const RAIL_FLAG = 20;
/** Wear value of a paint stripe: its wear factor (0.5..2.9), whether it lies over setts,
 *  and whether its -x / +x long edge runs beside a rail. */
export const paintWear = (wear, sett = false, railLo = false, railHi = false) =>
  Math.max(0.5, Math.min(2.9, wear)) + (sett ? SETT_FLAG : 0) + (railLo ? RAIL_FLAG : 0) + (railHi ? 2 * RAIL_FLAG : 0);
/** Wear value of a patch ribbon: the radius (m) of a cover lying in its centre (cut out
 *  of the patch) and its tone, -1 (fresh, dark binder) .. 1 (aged, grey). */
export const patchWear = (hole, tone) => Math.round(hole * 1000) + 0.02 + 0.96 * (tone * 0.5 + 0.5);
/** Wear value of a repair ribbon (fills over the setts, wear.js): kind (0 asphalt, 1
 *  concrete), tone 0..1 (asphalt: fresh dark .. aged grey; concrete: dirty .. pale), the
 *  cover lying in its centre, cut out of the fill: null, {r} (round) or {hs, hd} (half
 *  sizes along and across the ribbon), rounded up to whole millimetres / 5 mm, and how its
 *  edges step with the courses of the setts it replaced (wear.js STEP_*). */
export function repairWear(kind, tone, hole, step = 0) {
  let h = 0;
  if (hole && hole.r) h = Math.min(999, Math.ceil(hole.r * 1000));
  else if (hole) h = 1000 + Math.min(199, Math.ceil(hole.hs * 200)) * 200 + Math.min(199, Math.ceil(hole.hd * 200));
  return step * 100000 + kind * 50000 + h + 0.02 + 0.96 * Math.max(0, Math.min(1, tone));
}
const PAINT = [
  null, null,
  { color: 0xc9c6bd, roughness: 0.55, wear: 0.18, opacity: 1 },                           // centre
  { color: 0xcac7be, roughness: 0.5, wear: 0.24, opacity: 1 },                             // stripe
  { color: 0x3a342c, roughness: 0.6, wear: 0.12, opacity: 0.65, dash: [0.18, 0.65], minPx: 1.2 }, // joint
];

const VERT_PARS = /* glsl */`
attribute vec4 aRight;  // xz: lateral unit vector; y: per-line wear factor (paint); w: style
attribute vec4 aLine;   // x: side (-1|1), y: real half width, z: along (m), w: segment length / offset
                        // (position: the ribbon edge at the real half width)
uniform vec2 uViewport;
varying vec4 vLine;     // x: lateral (m), y: along (m), z: aLine.w, w: pixels per metre across the line
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
  // along the line (in the horizontal plane): pixels per metre ACROSS the line are the
  // lateral offset's screen component perpendicular to the line's screen direction (an
  // oblique line's lateral vector runs partly along it on screen)
  vec3 wa = vec3( -wr.z, 0.0, wr.x );
  vec4 c2 = projectionMatrix * viewMatrix * vec4( wp.xyz + wa * 0.05, 1.0 );
  float pxPerM = 1e4;
  if ( c0.w > 0.05 && c1.w > 0.05 && c2.w > 0.05 ) {
    vec2 s0 = c0.xy / c0.w;
    vec2 sd = ( c1.xy / c1.w - s0 ) * 0.5 * uViewport;
    vec2 sa = ( c2.xy / c2.w - s0 ) * 0.5 * uViewport;
    float la = length( sa );
    float perp = la > 1e-3 ? abs( sd.x * sa.y - sd.y * sa.x ) / la : length( sd );
    pxPerM = max( perp / 0.05, 1e-3 );
  }
  // pad by a pixel so the rasterized edge never cuts the analytic coverage (no stair
  // dots along thin bands), and keep at least minPx half width for sub-pixel lines
  // (joints and crack seals: thinner)
  float minPx = aRight.w > ${(LINE_STYLE.joint - 0.5).toFixed(1)} && aRight.w < ${(LINE_STYLE.seal + 0.5).toFixed(1)} ? ${PAINT[LINE_STYLE.joint].minPx.toFixed(2)} : 1.5;
  // (the pad is capped: seen edge-on, at the horizon, the pixel footprint diverges)
  float hw = aLine.y + min( 1.0 / pxPerM, 2.0 );
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
// change per pixel (steepest screen direction) of a field whose gradient in the ribbon's
// (lateral, along) metres is g; dx, du: screen derivatives (d/dX, d/dY) of those coordinates
float lnFw( vec2 g, vec2 dx, vec2 du ) { return length( g.x * dx + g.y * du ); }
// threshold of a noise field (mean 0.5, roughly logistic) below which the share W lies
float lnTg( float W ) { return 0.5 + 0.07 * log( max( W, 1e-3 ) / max( 1.0 - W, 1e-3 ) ); }
`;

// Rail cross-section bands in rail-local x (+ towards the gauge side), matching the 3D
// profile (constants.js RAIL_PROFILE) and the finishes the rail.head texture lays out:
// mortar | field seal | field bevel (rust-brown oxide film) | shoulder (thin oxide) |
// polished running band | shoulder | gauge corner (oxide film, as the bevel) | groove |
// dusty guard lip | gauge seal | mortar
//
// Footprint-aware: every band is integrated over the pixel footprint (box filter of the
// lateral footprint w, which is measured perpendicular to the rail on screen, so oblique
// views are exact). Bands are averaged PHYSICALLY: each band contributes its own diffuse
// albedo (albedo × (1 - metal) × cavity AO), its own specular F0 (with the cavity's
// specular occlusion) and its own reflection strength, and the shading model is fed those
// sums. (Averaging albedo and metalness separately lit the partial-metal pixels at the
// band edges diffusely: bright fringes round a dark mirror core, which stair-stepped into
// dash trains wherever the head was a pixel or two wide.) A sub-pixel band therefore
// shades exactly as its share of the footprint: the far rail is a pre-filtered strip
// whose dark groove and bright head keep their weight at any distance.
const HEAD_GC = 0.0215;      // the running band ends here, the gauge corner rounds off
const HEAD_C0 = -0.013, HEAD_C1 = 0.015;   // level crown of the head (reflects the sky)
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
  float cBand = lnCov( ${f(HEAD_C0)}, ${f(HEAD_C1)}, x, w );
  float cShoulder = lnCov( ${f(HEAD_DULL)}, ${f(HEAD_C0)}, x, w ) + lnCov( ${f(HEAD_C1)}, ${f(HEAD_GC)}, x, w );
  float cGauge = lnCov( ${f(HEAD_GC)}, ${f(HEAD_HALF)}, x, w );
  float cGroove = lnCov( ${f(HEAD_HALF)}, ${f(GROOVE_OUT)}, x, w );
  float cLip = lnCov( ${f(GROOVE_OUT)}, ${f(LIP_OUT)}, x, w );
  float cGrout = lnCov( ${f(RAIL_X0 - GROUT_W)}, ${f(RAIL_X0)}, x, w ) + lnCov( ${f(RAIL_X1)}, ${f(RAIL_X1 + GROUT_W)}, x, w );
  float cov = cSeal + cCorner + cBand + cShoulder + cGauge + cGroove + cLip + cGrout;
  float fade = 1.0, core = 0.0;
  if ( vLineStyle > 0.5 ) {
    // near rails: the real rails take over once their narrowest bands (12-13 mm seals
    // and lip) span a few pixels across the rail (w is the footprint across it); further
    // out the 3D bands would alias into dash trains
    fade = 1.0 - smoothstep( 1.6, 3.2, 0.012 / w );
    // the 3D rail is rasterized under every pixel centre inside the rail span, so cover
    // those pixels fully (the uncovered part of their footprint is paving, filled in
    // below); otherwise the sub-pixel 3D groove and seals leak through as dotted edges
    core = step( ${f(RAIL_X0 - GROUT_W)}, x ) * step( x, ${f(RAIL_X1 + GROUT_W)} );
  }
  float alpha = mix( cov, 1.0, core ) * fade;
  if ( alpha < 0.002 ) discard;
  float cPave = core * max( 0.0, 1.0 - cov );
  float inv = 1.0 / max( cov + cPave, 1e-4 );
  // per band: diffuse albedo (incl. cavity AO), specular F0, roughness; the steel kinds
  // (rail.head) reflect the environment at uStSheen.y
  float wSeal = cSeal * inv, wCorner = cCorner * inv, wBand = cBand * inv, wShoulder = cShoulder * inv, wGauge = cGauge * inv;
  float wGroove = cGroove * inv, wLip = cLip * inv, wPave = cPave * inv, wGrout = cGrout * inv;
  vec3 dSeal = ST_DSEAL;                                                   // grey elastomer seal
  // the finishes of rail.head's zones (materials meta['rail.head'].zones, mean values
  // over the bake): the oxidised field bevel and gauge corner, the shoulders under a thin
  // oxide either side of the band, the polished running band (its roughness lowered by
  // RAIL_BAND_ROUGH, as on the 3D head: the lengthwise polish is smooth along the rail, so
  // it mirrors the sky slot down the street as a thin bright line), the dusty guard lip
  vec3 aBev = ST_ZB_A * ( 0.85 + 0.3 * wear );
  vec3 aSh = ST_ZS_A;
  vec3 aBand = ST_ZN_A * ( 0.94 + 0.1 * wear );
  vec3 aLip = ST_ZL_A * ( 0.9 + 0.2 * wear );
  float rBand = ST_ZN_R * ( 0.9 + 0.2 * wear );
  // the flangeway: grit and rust dust in a 36 mm slot whose walls and floor see part of
  // the sky and, mostly, no sun, and reflect almost nothing (effective albedo with the
  // cavity AO folded in, matching the 3D groove of shading.js patchGrit)
  vec3 dGroove = vec3( 0.05, 0.042, 0.032 );
  vec3 dGrout = ST_DGROUT;                                                  // mortar bed
  vec3 dPave = ST_DPAVE;                                                    // brake-dusted setts beside it
  vec3 f04 = vec3( 0.04 );
  float wBev = wCorner + wGauge;
  // the dust film over the steel, as on the 3D rail (shading.js SHEEN): uStDust.w of the
  // polished band, uStDustOff of the oxidised steel round it (bevel, shoulders, lip)
  float dB = uStDust.w, dO = uStDustOff, eO = 1.0 - dO;
  lnD = dSeal * wSeal + aBev * ( ( 1.0 - ST_ZB_M ) * wBev * eO ) + aSh * ( ( 1.0 - ST_ZS_M ) * wShoulder * eO ) + aLip * ( ( 1.0 - ST_ZL_M ) * 0.97 * wLip * eO ) + dGroove * wGroove + dGrout * wGrout + dPave * wPave;
  vec3 fBev = mix( f04, aBev, ST_ZB_M ), fSh = mix( f04, aSh, ST_ZS_M ), fBand = mix( f04, aBand, ST_ZN_M ), fLip = mix( f04, aLip, ST_ZL_M ) * 0.97;
  vec3 fSteel = ( fBev * wBev + fSh * wShoulder + fLip * wLip ) * eO + fBand * ( wBand * ( 1.0 - dB ) );
  float wDust = dO * ( wBev + wShoulder + wLip ) + dB * wBand;
  lnD += uStDust.rgb * wDust;
  fSteel += f04 * wDust;
  vec3 fOther = f04 * ( wSeal + wGrout + wPave ) + f04 * ( 0.15 * wGroove );
  lnF = fSteel + fOther;
  lnF90 = 1.0 - 0.85 * wGroove;               // the slot's walls hide its grazing sheen
  // reflection strength (steel at uStSheen.y, as the 3D rail.head; see shading.js
  // patchRailSheen) and direct-light specular (steel at uStDirK) of the mix
  float fs = dot( fSteel, vec3( 0.333 ) ), fo = dot( fOther, vec3( 0.333 ) );
  lnEnvK = ( fs * uStSheen.y + fo ) / max( fs + fo, 1e-5 );
  lnDirK = ( fs * uStDirK + fo ) / max( fs + fo, 1e-5 );
  lnPhys = 1.0;
  // one roughness for the whole footprint: each band's own, weighted by its share of the
  // specular reflection (a sub-pixel band's sheen keeps its own lobe instead of being
  // smeared by the matt seals and mortar round it, which reflect next to nothing)
  const vec3 LY = vec3( 0.2126, 0.7152, 0.0722 );
  float lB = dot( fBev, LY ) * eO * wBev, lS = dot( fSh, LY ) * eO * wShoulder, lN = dot( fBand, LY ) * ( 1.0 - dB ) * wBand, lL = dot( fLip, LY ) * eO * wLip;
  float lD = 0.04 * wDust, lO = 0.04 * ( wSeal + wGrout + wPave + 0.15 * wGroove );
  float rNum = lB * ST_ZB_R + lS * ST_ZS_R + lN * rBand + lL * ST_ZL_R + lD * ${f(DUST_ROUGH)}
             + 0.04 * ( wSeal * 0.85 + wGrout * 0.9 + wPave * 0.7 + 0.15 * wGroove * 0.85 );
  lnRough = rNum / max( lB + lS + lN + lL + lD + lO, 1e-5 );
  diffuseColor.rgb = lnD;
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
  vec2 wp = vLineWorld.xz;
  if ( dash ) {
    float cov = lnCov( -vLineHalf, vLineHalf, x, w );
    // box-filtered square wave: F(t) = floor(t)*duty + min(fract(t), duty)
    const float P = ${f(J.dash[0])}, duty = ${f(J.dash[1])};
    float uj = u + ( lnNoise( vec2( u * 2.3, 4.1 ) ) - 0.5 ) * 0.8 * P;
    float t0 = ( uj - 0.5 * wu ) / P, t1 = ( uj + 0.5 * wu ) / P;
    float F0 = floor( t0 ) * duty + min( fract( t0 ), duty );
    float F1 = floor( t1 ) * duty + min( fract( t1 ), duty );
    cov *= clamp( ( F1 - F0 ) * P / wu, 0.0, 1.0 );
    // the sealant is cut only by grain-sized flecks; finer octaves fade to their mean
    float wear = pWear * ( vLineWear > 0.0 ? vLineWear : 1.0 );
    float big = lnFbm( wp * 0.4 + 17.0, fpw * 0.4, 3 );
    float mid = lnFbm( wp * 3.1 + 5.0, fpw * 3.1, 3 );
    float grain = lnFbm( wp * 30.0 + 9.0, fpw * 30.0, 2 );
    float field = 0.5 + ( grain - 0.5 ) * 2.4 + ( mid - 0.5 ) * 0.9;
    float keep = smoothstep( wear - 0.1, wear + 0.1, field ) * mix( 0.72, 1.0, smoothstep( 0.3, 0.6, big ) );
    keep = mix( keep, ( 1.0 - 0.7 * wear ) * 0.88, smoothstep( 0.012, 0.04, fpw ) );
    cov *= keep;
    if ( cov < 0.002 ) discard;
    float dirt = clamp( 0.5 - ( big - 0.5 ) * 2.4, 0.0, 1.0 );
    diffuseColor.rgb = pCol * ( 0.93 - 0.17 * dirt ) * ( 0.96 + 0.08 * mid );
    diffuseColor.a = cov * pOpacity;
  } else {
    // Road paint: an off-white film, worn and grimed (albedo about 0.55 where clean and
    // whole, under 0.5 with its grime), thin enough over setts that the stone and its
    // joints show through wherever it has worn (below). The per-line wear rises for bars
    // lying in a wheel path; bars laid over setts carry SETT_FLAG on top, and RAIL_FLAG
    // (paintWear) when a long edge runs beside a rail.
    float wl = vLineWear > 0.0 ? vLineWear : 1.0;
    float rf = floor( wl / ${f(RAIL_FLAG)} + 1e-4 );
    wl -= ${f(RAIL_FLAG)} * rf;
    float railLo = mod( rf, 2.0 ), railHi = step( 1.5, rf );
    float sett = step( 8.0, wl );
    wl -= ${f(SETT_FLAG)} * sett;
    float seed = fract( wl * 7.31 ) * 53.0;
    float pHalf = vLineHalf;
    float segLen = vLine.z > 0.0 ? vLine.z : 1e9;
    float bar = step( 0.15, pHalf ) * step( segLen, 50.0 );   // crossing bars (not centre dashes)
    float we = max( w, 0.001 ), wue = max( wu, 0.001 );
    // where the film bears most: the foot path across the middle of a crossing, and beside
    // a rail, where the setts settle and rock under the passing trams (the film cracks and
    // flakes over a couple of decimetres there, and brake dust greys it)
    float fq = ( u - 0.5 * segLen ) / ( 0.32 * segLen );     // (pow() of a negative base is undefined)
    float foot = bar * exp( -fq * fq );
    float rd = min( railLo > 0.5 ? x + pHalf : 9.0, railHi > 0.5 ? pHalf - x : 9.0 );
    float nearRail = 1.0 - smoothstep( 0.02, 0.16, rd );
    // Edges: rolled up to a stencil, then worn. Close up they waver a couple of millimetres;
    // along crossing bars they are bitten into at three sizes: centimetre chips, bites a
    // decimetre or two long and broken stretches half a metre long and a few centimetres
    // deep (more of them beside a rail). Each size is drawn while it spans a pixel or two
    // along the edge and fades out below that, so an edge never crawls; the broken
    // stretches stay drawn far down the street.
    float res = 1.0 - smoothstep( 0.003, 0.012, max( w, wu ) );
    float e0 = ( lnNoise( vec2( u * 7.0, seed ) ) - 0.5 ) * 0.005 * res;
    float e1 = ( lnNoise( vec2( u * 6.3, seed + 5.0 ) ) - 0.5 ) * 0.005 * res;
    float rb = bar * ( 1.0 - smoothstep( 0.006, 0.02, w ) ) * ( 1.0 - smoothstep( 0.012, 0.03, wu ) );
    e0 += rb * 0.016 * smoothstep( 0.74, 0.95, lnNoise( vec2( u * 37.0, seed + 2.0 ) ) );
    e1 -= rb * 0.016 * smoothstep( 0.74, 0.95, lnNoise( vec2( u * 33.0, seed + 9.0 ) ) );
    float rM = bar * ( 1.0 - smoothstep( 0.012, 0.035, w ) ) * ( 1.0 - smoothstep( 0.07, 0.15, wu ) );
    float rL = bar * ( 1.0 - smoothstep( 0.03, 0.08, w ) ) * ( 1.0 - smoothstep( 0.25, 0.5, wu ) );
    float kLo = 1.0 + 1.2 * railLo, kHi = 1.0 + 1.2 * railHi;
    e0 += rM * 0.022 * kLo * smoothstep( 0.7, 0.93, lnNoise( vec2( u * 6.5, seed + 12.0 ) ) );
    e1 -= rM * 0.022 * kHi * smoothstep( 0.7, 0.93, lnNoise( vec2( u * 7.1, seed + 17.0 ) ) );
    e0 += rL * 0.026 * kLo * smoothstep( 0.72, 0.92, lnNoise( vec2( u * 1.7, seed + 23.0 ) ) );
    e1 -= rL * 0.026 * kHi * smoothstep( 0.72, 0.92, lnNoise( vec2( u * 1.9, seed + 29.0 ) ) );
    // the ends: ragged close up, broken back by up to several centimetres over much of their
    // width, the corners most
    float rE = bar * ( 1.0 - smoothstep( 0.03, 0.08, w ) );
    float cn = 1.0 - smoothstep( 0.0, 0.1, pHalf - abs( x ) );
    float sx = x > 0.0 ? 1.0 : 0.0;
    float eu0 = ( lnNoise( vec2( x * 7.0, seed + 3.0 ) ) - 0.5 ) * 0.008 * res
      + rE * ( 0.05 * smoothstep( 0.55, 0.9, lnNoise( vec2( x * 4.5, seed + 31.0 ) ) ) + 0.06 * cn * step( 0.45, lnHash( vec2( seed, sx + 3.0 ) ) ) );
    float eu1 = ( lnNoise( vec2( x * 6.1, seed + 7.0 ) ) - 0.5 ) * 0.008 * res
      - rE * ( 0.05 * smoothstep( 0.55, 0.9, lnNoise( vec2( x * 4.1, seed + 37.0 ) ) ) + 0.06 * cn * step( 0.45, lnHash( vec2( seed, sx + 7.0 ) ) ) );
    float cov = lnCov( -pHalf + e0, pHalf + e1, x, we ) * lnCov( eu0, segLen + eu1, u, wue );
    float ends = 1.0 - smoothstep( 0.0, 0.4, min( u, segLen - u ) );
    // Wear removes the film in discrete flakes with sharp rims: feet and wheels break it
    // where it bears on the tops of the surface and it lifts in pieces, clustered where
    // soles and tyres bear most (round the middle of a crossing, beside a rail, along a bar
    // in a wheel path, towards the ends and the long edges). Three sizes: broken-up
    // stretches a few decimetres across (where the share lost is high they merge into bare
    // ground), pieces of about 12 cm torn at the 4 cm scale, and pieces of about 4 cm torn
    // at the grain of the surface (asphalt aggregate ~1.5 cm, the setts' crystals ~5 mm),
    // each a noise field thresholded at its share of the loss with a rim one pixel wide
    // (from the field's own gradient, so the large stretches stay drawn far down the street,
    // blurred along the view only as much as the view compresses them). Under a pixel a
    // size's share counts as bared ground. Over setts the film is also thinnest on the
    // stones' rounded arrises, so it wears through along every joint first, and a stone
    // standing a little proud loses more of it; it has cracked along the joints (dark
    // hairlines; the bar starts on a bed joint, so they lie every 0.2 m across it, with the
    // head joints of each course between them) and flaked off for a few millimetres to a
    // couple of centimetres either side where the stones rock. On asphalt a sparse network
    // of fine fatigue cracks runs through it. Bared ground mostly shows through (the paving
    // beneath is drawn there: its stone, joints and dirt), the rest tints the film.
    float eX = 1.0 - smoothstep( 0.0, 0.05, pHalf - abs( x ) );
    float W = clamp( 0.26 * pWear * wl + 0.1 * foot + 0.1 * nearRail + bar * ( 0.05 * eX + 0.05 * ends ), 0.0, 0.85 );
    float fpl = max( w, wu );
    float pv = lnFbm( vec2( x, u ) * 2.6 + seed + 11.0, fpl * 2.6, 3 );
    float big = lnFbm( wp * 0.5 + 17.0 + seed, fpw * 0.5, 2 );
    float mid = lnFbm( wp * 3.1 + 5.0, fpw * 3.1, 3 );
    // the local share of film lost: decimetre patches
    float Wl = clamp( W * ( 0.12 + 1.3 * smoothstep( 0.5, 0.8, pv ) + 0.25 * ( big - 0.5 ) ), 0.0, 0.7 );
    float gs = sett > 0.5 ? 170.0 : 70.0;
    vec2 q = vec2( x, u ) * gs + seed;
    float kG = 1.0 - smoothstep( 0.6, 1.8, fpl * gs );
    float gr = mix( 0.5, lnNoise( q ) * 0.55 + lnNoise( mat2( 0.8, 0.6, -0.6, 0.8 ) * q * 2.2 + 7.0 ) * 0.45, kG );
    // the flake fields and their gradients (finite steps of FH metres)
    const float FH = 0.004;
    vec2 pL = vec2( x, u ) * 1.6 + seed * 0.7 + 21.0;
    float fpLg = fpl * 1.6;
    float fL = lnFbm( pL, fpLg, 2 );
    float fLx = lnFbm( pL + vec2( 1.6 * FH, 0.0 ), fpLg, 2 ), fLu = lnFbm( pL + vec2( 0.0, 1.6 * FH ), fpLg, 2 );
    vec2 pF = vec2( x, u ) * 22.0 + seed * 1.7 + 3.0, pC = vec2( x, u ) * 8.0 + seed * 1.3 + 7.0;
    float fpF = fpl * 22.0, fpC = fpl * 8.0;
    float fF = lnFbm( pF, fpF, 3 );
    float fFx = lnFbm( pF + vec2( 22.0 * FH, 0.0 ), fpF, 3 ), fFu = lnFbm( pF + vec2( 0.0, 22.0 * FH ), fpF, 3 );
    float fC = lnFbm( pC, fpC, 2 ) + 0.3 * ( fF - 0.5 );
    float fCx = lnFbm( pC + vec2( 8.0 * FH, 0.0 ), fpC, 2 ) + 0.3 * ( fFx - 0.5 );
    float fCu = lnFbm( pC + vec2( 0.0, 8.0 * FH ), fpC, 2 ) + 0.3 * ( fFu - 0.5 );
    // over setts: the joints (bed joints every 0.2 m along u, head joints every 0.29-0.52 m
    // across each course), the stone a point lies on and how far it is from its edges
    float jn = 0.0, crack = 0.0, chipped = 0.0, arr = 0.0, arrMean = 0.0, stoneT = 0.0, stoneBare = 0.0;
    if ( sett > 0.5 ) {
      float k = floor( u / 0.2 + 0.5 ), du = u - 0.2 * k;
      float ck = floor( u / 0.2 );
      float hx = ( x + 3.0 ) / 0.4 + lnHash( vec2( ck, seed + 4.0 ) );
      float hj = floor( hx + 0.5 );
      float hd = ( hx - hj - 0.32 * ( lnHash( vec2( hj, ck + seed ) ) - 0.5 ) ) * 0.4;
      jn = ( 1.0 - smoothstep( 0.0, 0.025, abs( du ) ) ) * ( 1.0 - smoothstep( 0.012, 0.04, wue ) );
      crack = max( lnCov( -0.0018, 0.0018, du, wue ), 0.8 * lnCov( -0.002, 0.002, hd, we ) );
      // flaked strips along a joint: mostly none, now and then a centimetre or two
      float cn2 = lnNoise( vec2( x * 9.0 + k * 3.7, k * 1.3 + seed ) );
      float chip = 0.009 * smoothstep( 0.62, 0.95, cn2 ) * ( 0.6 + 0.8 * W ) * ( 1.0 - smoothstep( 0.01, 0.03, wue ) );
      chipped = chip > 0.0005 ? lnCov( -chip, chip, du, wue ) : 0.0;
      // each stone its own film: a stone standing a little proud wears cleaner and barer,
      // a sunken one keeps more film and more dirt (drawn while the courses are resolved
      // along the view; under that their mean)
      float stone = hj - step( hd, 0.0 );
      float hs = lnHash( vec2( stone * 1.7 + 11.0, ck * 1.37 + seed ) );
      float kS = 1.0 - smoothstep( 0.05, 0.14, wue );
      stoneT = ( hs - 0.5 ) * kS;
      stoneBare = mix( 0.05, smoothstep( 0.72, 0.97, hs ), kS ) * ( 0.4 + 0.6 * W );
      // the arrises: 1.5-3 cm either side of every joint the film is thinnest
      // (wider and narrower along each joint, where the stones rock more or less)
      float awB = ( 0.008 + 0.03 * lnNoise( vec2( x * 7.0 + 3.0 * hs, k * 2.3 + seed ) ) ) * ( 0.7 + 0.6 * hs );
      float awH = ( 0.008 + 0.025 * lnNoise( vec2( u * 9.0, hj * 1.9 + seed ) ) ) * ( 0.7 + 0.6 * hs );
      // (a band is box-filtered over the pixel once it is under a couple of pixels wide, and
      // eased to its share of the course once the courses themselves are)
      float aB = mix( 1.0 - smoothstep( 0.002, awB, abs( du ) ), lnCov( -0.5 * awB, 0.5 * awB, du, wue ), smoothstep( 0.3 * awB, awB, wue ) );
      float aH = mix( 1.0 - smoothstep( 0.002, awH, abs( hd ) ), lnCov( -0.5 * awH, 0.5 * awH, hd, we ), smoothstep( 0.3 * awH, awH, we ) );
      float kB = 1.0 - smoothstep( 0.08, 0.2, wue ), kH = 1.0 - smoothstep( 0.12, 0.3, we );
      arr = max( aB * kB, 0.7 * aH * kH );
      arrMean = 0.1 * ( 1.0 - kB ) + 0.035 * ( 1.0 - kH );
    } else {
      float r = lnNoise( wp * 1.3 + seed ) * 0.6 + lnNoise( wp * 3.7 + seed + 2.0 ) * 0.4;
      crack = lnCov( -0.004, 0.004, r - 0.5, 4.5 * fpw + 1e-4 ) * 0.9;
    }
    float fieldC = fC + 0.06 * ( gr - 0.5 ) - 0.06 * jn;
    float fieldF = fF + 0.16 * ( gr - 0.5 ) - 0.1 * jn;
    // rims a pixel wide: the fields' change per pixel through the ribbon's coordinate
    // derivatives (sharp across the bar even where the view compresses it along)
    // (the large stretches' rims are torn at the smaller flakes' scales)
    fL += 0.14 * ( fC - 0.5 ) + 0.05 * ( fF - 0.5 );
    fLx += 0.14 * ( fCx - 0.5 ) + 0.05 * ( fFx - 0.5 );
    fLu += 0.14 * ( fCu - 0.5 ) + 0.05 * ( fFu - 0.5 );
    float feL = 0.5 * lnFw( vec2( fLx - fL, fLu - fL ) / FH, lnDx, lnDu ) + 0.002;
    float feC = 0.5 * lnFw( vec2( fCx - fC, fCu - fC ) / FH, lnDx, lnDu ) + 0.002;
    float feF = 0.5 * lnFw( vec2( fFx - fF, fFu - fF ) / FH, lnDx, lnDu ) + 0.002;
    float WL = clamp( W * ( 0.05 + 0.4 * max( foot * smoothstep( 0.45, 0.75, pv ), nearRail ) ), 0.0, 0.12 );
    float WC = 0.5 * Wl, WF = 0.5 * Wl;
    float tL = lnTg( WL ), tC = lnTg( WC ), tF = lnTg( WF );
    float keepL = WL < 0.01 ? 1.0 : smoothstep( tL - feL, tL + feL, fL );
    float keepC = WC < 0.002 ? 1.0 : smoothstep( tC - feC, tC + feC, fieldC );
    float keepF = WF < 0.002 ? 1.0 : smoothstep( tF - feF, tF + feF, fieldF );
    // a size of flake is drawn while it spans a few pixels; under that, its share is bared
    float rLg = 1.0 - smoothstep( 0.3, 0.7, fpLg );
    float rC = 1.0 - smoothstep( 0.35, 0.8, fpC ), rF = 1.0 - smoothstep( 0.35, 0.8, fpF );
    float keepW = mix( 1.0, keepL, rLg ) * mix( 1.0, keepC, rC ) * mix( 1.0, keepF, rF );
    float bared = 1.0 - ( 1.0 - ( 1.0 - rLg ) * WL ) * ( 1.0 - ( 1.0 - rC ) * WC ) * ( 1.0 - ( 1.0 - rF ) * WF );
    // and the film thinned over the arrises and the proud stones
    // and where it has worn thin in soft patches a few decimetres across (the paving's
    // grain and tone show through them: what reads as blotchy grey paint down the street)
    float mot = lnFbm( wp * 2.3 + 41.0, fpw * 2.3, 3 );
    float thin = clamp( ( arr + arrMean ) * ( 0.4 + 0.5 * W ) + stoneBare + ( 0.1 + 0.6 * W ) * smoothstep( 0.42, 0.75, mot ), 0.0, 0.8 );
    bared = 1.0 - ( 1.0 - bared ) * ( 1.0 - thin );
    // fine texture of the film (small numbers: exact noise)
    vec2 qf = vec2( x, u ) * 150.0 + seed;
    float fine = lnNoise( qf ) * 0.6 + lnNoise( mat2( 0.8, 0.6, -0.6, 0.8 ) * qf * 2.3 + 7.0 ) * 0.4;
    float kFine = 1.0 - smoothstep( 0.0015, 0.005, fpl );
    cov *= keepW * ( 1.0 - chipped ) * ( 1.0 - 0.85 * bared );
    if ( cov < 0.002 ) discard;
    // grime: dust ground into the film (a little more along the edges and towards the
    // ends, on a worn film and on the sunken stones), grey sole scuffs in the foot path
    // (streaked across the bar, the way people walk), dark tyre rubber streaked along bars
    // in a wheel path, brake dust beside a rail
    float dirt = clamp( 0.5 - ( big - 0.5 ) * 2.0, 0.0, 1.0 );
    float edge = 1.0 - smoothstep( 0.0, 0.015, pHalf - abs( x ) );
    edge = mix( edge, 0.5 * min( 1.0, 0.015 / max( pHalf, 0.015 ) ), smoothstep( 0.004, 0.015, w ) );
    float sc = lnFbm( vec2( x * 4.0, u * 16.0 ) + seed + 31.0, max( w * 4.0, wu * 16.0 ), 3 );
    float scuff = foot * smoothstep( 0.55, 0.68, sc ) * smoothstep( 0.4, 0.6, mid );
    float tyre = ( 1.0 - sett ) * bar * smoothstep( 1.3, 2.3, wl );
    float streak = lnFbm( vec2( x * 9.0 + seed, u * 0.7 ), max( w * 9.0, wu * 0.7 ), 3 );
    float gTyre = tyre * ( 0.15 + 0.4 * smoothstep( 0.35, 0.65, streak ) );
    float gDust = clamp( 0.07 + 0.04 * bar + 0.14 * dirt + 0.16 * smoothstep( 0.35, 0.7, 1.0 - mot ) + 0.18 * edge + 0.12 * ends + 0.3 * W + 0.12 * max( 0.0, -stoneT ), 0.0, 0.5 );
    // close up: grit and dust caught in the paint's texture
    vec3 col = pCol * ( 0.95 + 0.1 * mid ) * ( 1.0 + 0.1 * stoneT ) * mix( 1.0, 0.88 + 0.24 * fine, kFine );
    col = mix( col, vec3( 0.2, 0.19, 0.175 ), gDust );
    col = mix( col, vec3( 0.16, 0.155, 0.15 ), 0.55 * scuff );
    col = mix( col, vec3( 0.06, 0.058, 0.055 ), gTyre );
    col = mix( col, vec3( 0.12, 0.112, 0.102 ), 0.3 * nearRail * ( 0.6 + 0.4 * mid ) );
    // what of the bared ground does not show through: grimed stone (or asphalt) in the
    // flakes' hollows
    col = mix( col, sett > 0.5 ? ST_ALB * 0.75 : vec3( 0.075, 0.072, 0.068 ), 0.15 * bared );
    // the cracks: dark hairlines of joint grime (setts) or of the asphalt beneath
    col *= 1.0 - ( sett > 0.5 ? 0.6 : 0.85 ) * crack;
    diffuseColor.rgb = col;
    // the trodden film is duller where grit is ground in, a little glossier where soles
    // have polished it
    lnRough = mix( pRough, 0.78, 0.6 * gDust + 0.2 * W ) - 0.08 * scuff - 0.1 * gTyre + bar * 0.08 * ( pv - 0.5 );
    lnRough = mix( lnRough, 0.85, 0.15 * bared );
    diffuseColor.a = cov * pOpacity;
  }
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

// Repairs over the setts (wear.js): a hand-laid fill [-half, half] x [0, length], x across
// and u along the ribbon, in asphalt (fresh and dark, or aged and grey, with its stone
// chips showing close up) or concrete mortar (pale warm grey, mottled, pores), its edges
// cut by hand and wandering by up to a couple of centimetres, dark where the joint has
// collected dirt; a cover in its middle is cut out (wear: repairWear).
const REPAIR_FRAG = /* glsl */`
{
  float x = vLine.x, u = vLine.y, len = vLine.z;
  float code = floor( vLineWear );
  float tone = clamp( ( fract( vLineWear ) - 0.02 ) / 0.96, 0.0, 1.0 );
  float mode = floor( code / 100000.0 + 1e-4 );
  code -= 100000.0 * mode;
  float hx = vLineHalf - ${f(PATCH_PAD)} - ( abs( mode - 2.0 ) > 0.5 && mode > 0.5 ? ${f(STEP_PAD)} : 0.0 );
  float kind = step( 49999.5, code );
  code -= 50000.0 * kind;
  float seed = floor( tone * 97.0 );
  vec2 wp = vLineWorld.xz;
  float amp = min( 0.022, 0.07 * min( hx, 0.5 * len ) ) * ( 1.0 - 0.35 * kind );
  float side = x > 0.0 ? 1.0 : 0.0, end = u > 0.5 * len ? 1.0 : 0.0;
  float ex = ( lnNoise( vec2( u * 3.1, 3.7 + 6.0 * side + seed ) ) - 0.5 ) * 2.0 * amp + ( lnNoise( vec2( u * 19.0, 1.3 + 4.0 * side + seed ) ) - 0.5 ) * 0.5 * amp;
  float eu = ( lnNoise( vec2( x * 3.1, 13.7 + 6.0 * end + seed ) ) - 0.5 ) * 2.0 * amp + ( lnNoise( vec2( x * 19.0, 21.1 + 4.0 * end + seed ) ) - 0.5 ) * 0.5 * amp;
  if ( mode > 0.5 ) {
    // the setts were taken up whole: the edges crossing the courses step out course by
    // course (to wherever the joint between two setts happened to lie), and the step
    // between two courses runs along their bed joint (blended over the pixel footprint)
    float cs = mode > 2.5 ? 0.2 : 0.25;
    bool alongU = mode < 1.5 || mode > 2.5;
    float t = alongU ? u : x + hx;
    float ft = alongU ? wu : w;
    float k = floor( t / cs ), f = t - k * cs;
    float sd = alongU ? side : end;
    float A = min( 0.2, 0.45 * ( alongU ? hx : 0.5 * len ) );
    float o0 = lnHash( vec2( k, seed + 13.0 * sd ) ), om = lnHash( vec2( k - 1.0, seed + 13.0 * sd ) ), op = lnHash( vec2( k + 1.0, seed + 13.0 * sd ) );
    float o = mix( om, o0, clamp( ( f + 0.5 * ft ) / ft, 0.0, 1.0 ) );
    o = mix( o, op, clamp( ( f - cs + 0.5 * ft ) / ft, 0.0, 1.0 ) );
    if ( alongU ) ex += A * o; else eu += A * o;
  }
  float sx = hx + ex - abs( x ), su = 0.5 * len + eu - abs( u - 0.5 * len );
  float cov = clamp( sx / w + 0.5, 0.0, 1.0 ) * clamp( su / wu + 0.5, 0.0, 1.0 );
  if ( code > 0.5 ) {
    vec2 q = vec2( x, u - 0.5 * len );
    if ( code < 999.5 ) cov *= clamp( ( length( q ) - code * 0.001 ) / max( max( w, wu ), 1e-4 ) + 0.5, 0.0, 1.0 );
    else {
      float c = code - 1000.0, hs = floor( c / 200.0 + 1e-3 ), hd = c - hs * 200.0;
      cov *= 1.0 - clamp( ( hd * 0.005 - abs( q.x ) ) / w + 0.5, 0.0, 1.0 ) * clamp( ( hs * 0.005 - abs( q.y ) ) / wu + 0.5, 0.0, 1.0 );
    }
  }
  if ( cov < 0.002 ) discard;
  float mot = lnFbm( wp * 0.9 + 13.0 + seed, fpw * 0.9, 3 );
  float spot = lnFbm( wp * 4.3 + 3.0 + seed, fpw * 4.3, 2 );
  float kFine = 1.0 - smoothstep( 0.003, 0.01, fpw );
  vec2 qf = vec2( x, u ) * 90.0 + seed;   // the fill's own small coordinates: exact noise
  float grain = mix( 0.5, lnNoise( qf ) * 0.6 + lnNoise( mat2( 0.8, 0.6, -0.6, 0.8 ) * qf * 2.3 + 7.0 ) * 0.4, kFine );
  float chips = mix( 0.12, smoothstep( 0.66, 0.8, lnNoise( qf * 0.55 + 31.0 ) ), kFine );
  float din = min( sx, su );
  float edge = 1.0 - smoothstep( 0.0, mix( 0.03, 0.012, kind ), din );
  edge = mix( edge, 0.3 * min( 1.0, 0.03 / max( min( hx, 0.5 * len ), 0.03 ) ), smoothstep( 0.01, 0.04, max( w, wu ) ) );
  vec3 col;
  if ( kind < 0.5 ) {
    // asphalt: the binder greys and the chips show as it ages; worn smooth, dusty
    col = mix( vec3( 0.055, 0.053, 0.051 ), vec3( 0.118, 0.113, 0.106 ), tone ) * ( 0.84 + 0.32 * mot ) * ( 0.94 + 0.12 * spot );
    col *= 0.8 + 0.4 * grain;
    col = mix( col, vec3( 0.22, 0.212, 0.198 ), ( 0.2 + 0.35 * tone ) * chips );
    col = mix( col, vec3( 0.03, 0.029, 0.028 ), 0.55 * edge );
    lnRough = 0.8 + 0.12 * mot;
  } else {
    // concrete mortar: pale warm grey, mottled and stained, fine pores; dirt along its edges
    col = mix( vec3( 0.14, 0.136, 0.128 ), vec3( 0.24, 0.232, 0.215 ), tone ) * ( 0.84 + 0.3 * mot ) * ( 0.92 + 0.16 * spot );
    col *= 0.88 + 0.24 * grain;
    col *= 1.0 - 0.35 * edge;
    lnRough = 0.92;
  }
  diffuseColor.rgb = col;
  diffuseColor.a = cov * 0.97;
}
`;

// Drip band along the middle of a track on the main street: oil, grease and brake dust
// dropped by the passing trams, one continuous soft strip between the rails (full over
// the middle DRIP_CORE either side of its centre line, fading out over the next
// DRIP_SOFT), wandering a few centimetres. Its density varies along the track over 5-20 m
// (value noise of the along coordinate, so both levels of detail agree and chunks join
// seamlessly), with a faint mottle a few decimetres across and, close up, drops. The per
// point strength (wear) is 1 on the open line and heavier where the trams stand at the
// stops and under their bogies; aLine.w is the track (-1 | 1), which decorrelates the two
// tracks. The edges widen with the pixel footprint, so the band thins evenly with distance.
const DRIP_FRAG = /* glsl */`
{
  float x = vLine.x, u = vLine.y, tk = vLine.z;
  vec2 wp = vLineWorld.xz;
  float c = ( lnNoise( vec2( u * 0.11, 4.3 + 7.0 * tk ) ) - 0.5 ) * 0.08;
  float e0 = ${f(DRIP_CORE)} * ( 0.85 + 0.3 * lnNoise( vec2( u * 0.37, 9.7 + 5.0 * tk ) ) );
  float ax = abs( x - c );
  float prof = 1.0 - smoothstep( e0 - 0.5 * w, e0 + ${f(DRIP_SOFT)} + 0.5 * w, ax );
  // density along the track: 5-20 m stretches, about +-45 %
  float nA = 0.62 * lnNoise( vec2( u * 0.075, 1.3 + 3.0 * tk ) ) + 0.38 * lnNoise( vec2( u * 0.19, 6.1 + 3.0 * tk ) );
  float dens = clamp( 1.0 + 1.6 * ( nA - 0.5 ), 0.4, 1.6 );
  float mot = lnFbm( wp * 1.4 + 7.0, fpw * 1.4, 3 );
  float fine = lnFbm( wp * 13.0 + 3.0, fpw * 13.0, 2 );
  float drops = mix( smoothstep( 0.55, 0.7, fine ), 0.3, smoothstep( 0.015, 0.05, fpw ) );
  float a = prof * dens * ( 0.72 + 0.56 * mot ) * ( 0.8 + 0.4 * drops ) * vLineWear * ${f(DRIP_ALPHA)};
  if ( a < 0.002 ) discard;
  diffuseColor.rgb = vec3( 0.05, 0.046, 0.041 ) * ( 0.9 + 0.2 * mot );
  lnRough = 0.7 - 0.1 * drops;
  diffuseColor.a = min( a, 0.7 );
}
`;

// Relaid setts (wear.js): another batch of setts over a corridor strip, its sides on the
// rails' mortar strips and its ends on bed joints, x across and u along [0, length].
// Darker batches blend towards a deep tint of the setts (so the setts beneath keep their
// relative variation: the result is close to the paving times k), paler ones towards a
// pale granite, which also evens out the variation a little, as a fresh batch does; the
// specular is the paving's own beneath (a dark blend carries none of its own).
const RELAY_FRAG = /* glsl */`
{
  float x = vLine.x, u = vLine.y, len = vLine.z;
  float hx = vLineHalf - ${f(0)};
  float h = floor( vLineWear ) * 0.002 - 0.1, k = fract( vLineWear ) * 2.0;
  float cov = lnCov( -hx, hx, x, w ) * lnCov( 0.0, len, u, wu );
  if ( cov < 0.002 ) discard;
  vec3 tint = vec3( 1.0 + h, 1.0 + 0.15 * h, 1.0 - h );
  vec3 pave = ST_ALB;
  float a;
  if ( k < 1.0 ) {
    lnD = pave * 0.25 * tint;
    a = ( 1.0 - k ) / 0.75;
    lnF = vec3( 0.0 ); lnF90 = 0.0;
  } else {
    lnD = pave * 1.75 * tint;
    a = ( k - 1.0 ) / 0.75;
    lnF = vec3( 0.04 ); lnF90 = 1.0;
  }
  lnPhys = 1.0; lnEnvK = 1.0; lnDirK = 1.0;
  lnRough = 0.85;
  diffuseColor.rgb = lnD;
  diffuseColor.a = cov * clamp( a, 0.0, 0.9 );
}
`;

// pixel footprints are taken before the style branch (derivatives in uniform control flow)
const LINE_FRAG = /* glsl */`
float lnRough = 0.5, lnMetal = 0.0;
// rails: physically averaged bands (diffuse contribution, F0, reflection strength)
vec3 lnD = vec3( 0.0 ), lnF = vec3( 0.04 );
float lnF90 = 1.0, lnEnvK = 1.0, lnDirK = 1.0, lnPhys = 0.0;
vec2 lnDx = vec2( dFdx( vLine.x ), dFdy( vLine.x ) ), lnDu = vec2( dFdx( vLine.y ), dFdy( vLine.y ) );
float w = max( length( lnDx ), 1e-5 );
float wu = max( length( lnDu ), 1e-5 );
float fpw = max( length( fwidth( vLineWorld.xz ) ), 1e-4 );     // metres per pixel
if ( vLineStyle < ${(LINE_STYLE.centre - 0.5).toFixed(1)} ) ${RAIL_FRAG}
else if ( vLineStyle < ${(LINE_STYLE.joint + 0.5).toFixed(1)} ) ${PAINT_FRAG}
else if ( vLineStyle < ${(LINE_STYLE.polish + 0.5).toFixed(1)} ) ${ASPHALT_FRAG}
else if ( vLineStyle < ${(LINE_STYLE.repair + 0.5).toFixed(1)} ) ${REPAIR_FRAG}
else if ( vLineStyle < ${(LINE_STYLE.drip + 0.5).toFixed(1)} ) ${DRIP_FRAG}
else ${RELAY_FRAG}
`;

/** rail.head's zone finishes (materials meta['rail.head'].zones) used when the library
 *  publishes none. */
export const RAIL_ZONES = {
  band: { albedo: [0.451, 0.446, 0.436], rough: 0.57, metal: 1 },
  shoulder: { albedo: [0.254, 0.226, 0.2], rough: 0.64, metal: 0.59 },
  bevel: { albedo: [0.204, 0.161, 0.118], rough: 0.72, metal: 0.41 },
  lip: { albedo: [0.16, 0.145, 0.125], rough: 0.72, metal: 0.4 },
};
const zoneOk = (z) => z && Array.isArray(z.albedo) && z.albedo.length === 3 && z.albedo.every((x) => x >= 0 && x <= 1)
  && z.rough > 0 && z.rough <= 1 && z.metal >= 0 && z.metal <= 1;

/** The shared line material (all styles; the rail steel has the lengthwise-polish sheen).
 *  tones: constants.js pavingTones (mortar and the setts beside the rails); zones: the
 *  rail.head zone finishes from the materials meta (falls back per zone to RAIL_ZONES). */
export function createLineMaterial(tones = pavingTones(null), zones = null) {
  const Z = {};
  for (const k of Object.keys(RAIL_ZONES)) Z[k] = zones && zoneOk(zones[k]) ? zones[k] : RAIL_ZONES[k];
  let frag = LINE_FRAG
    .replace('ST_DSEAL', v3(tones.mortar, SEAL_TONE * 0.86))
    .replace('ST_DGROUT', v3(tones.mortar, 0.95))
    .replace('ST_DPAVE', v3(tones.pave))
    .replaceAll('ST_ALB', v3(tones.albedo));
  const zk = { B: Z.bevel, S: Z.shoulder, N: Z.band, L: Z.lip };
  for (const [c, z] of Object.entries(zk)) {
    // the running band's roughness as on the 3D head (shading.js RAIL_BAND_ROUGH)
    const r = c === 'N' ? z.rough * RAIL_BAND_ROUGH : z.rough;
    frag = frag.replaceAll(`ST_Z${c}_A`, v3(z.albedo)).replaceAll(`ST_Z${c}_R`, f(r)).replaceAll(`ST_Z${c}_M`, f(z.metal));
  }
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
      .replace('#include <color_fragment>', `#include <color_fragment>\n${frag}`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = lnRough;\nmetalnessFactor = lnMetal;')
      .replace('#include <lights_physical_fragment>', /* glsl */`#include <lights_physical_fragment>
if ( lnPhys > 0.5 ) {
  material.diffuseContribution = lnD;
  material.specularColorBlended = lnF;
  material.specularF90 = lnF90;
}`)
      .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\nreflectedLight.directSpecular *= lnDirK;')
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n#if defined( RE_IndirectSpecular )\nradiance *= lnEnvK;\n#endif');
  };
  m.customProgramCacheKey = () => 'street-line-16';
  return patchRailSheen(m, 'line');
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
   *  slope; or 8 with stride 8: plus a per-point factor on the wear); wear scales the paint
   *  style's wear for this line. */
  add(pts, halfW, extra, style, wear = 1, stride = 6) {
    const np = pts.length / stride;
    if (this.n + np * 2 > this.cap) this._grow(Math.max(this.cap * 2, this.n + np * 2 + 64));
    let prev = -1;
    for (let i = 0; i < np; i++) {
      const o = i * stride, v = this.n;
      const rx = pts[o + 3], rz = pts[o + 4], dy = stride > 6 ? pts[o + 6] * halfW : 0;
      const wr = stride > 7 ? wear * pts[o + 7] : wear;
      for (let k = 0; k < 2; k++) {
        const j = v + k, sd = k ? 1 : -1;
        this.pos[j * 3] = pts[o] + rx * sd * halfW; this.pos[j * 3 + 1] = pts[o + 1] + dy * sd; this.pos[j * 3 + 2] = pts[o + 2] + rz * sd * halfW;
        this.right[j * 4] = rx; this.right[j * 4 + 1] = wr; this.right[j * 4 + 2] = rz; this.right[j * 4 + 3] = style;
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
