import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Foliage and bark shading. Built on MeshStandardMaterial with onBeforeCompile patches
// (always chained after any existing hook) so the lighting system (shadows, fog, env)
// keeps working.
//
// Wind: trunk sway, branch motion and leaf flutter (the outer part of each card turns
// about the card's axis) in the vertex shader, identical in the custom depth materials so
// shadows move with the leaves.
//
// Light through the crown. A crown is a cloud of leaves, not a solid: sunlight reaching a
// leaf inside it has passed through the leaves between it and the crown surface. Shadow
// maps cannot resolve that (they turn every card into a blocker and darken whole tiers),
// so the two parts are separated:
//   * external shadow: the leaf's shadow-map lookup point is moved along the ray towards
//     the sun to where it leaves the crown (the move is along the shadow camera's axis, so
//     the lookup stays in the same cascade texel). Buildings, poles and other trees still
//     shadow it; its own crown does not;
//   * self shadow: the path length through the crown sphere towards the sun, as
//     transmittance exp(-density * path), dithered per card into sun flecks.
// Leaves also transmit light: sun from behind a card glows yellow-green (weakened less
// by the crown than the direct term, thin outer leaves strongest), and sky light from the
// far side of a card passes through it (undersides seen from below are lit by the sky).
// Interior occlusion darkens only the sky / indirect light.
//
// Coverage: the atlas carries coverage-preserving alpha mips, so coverage is sharpened at
// every distance (alpha-to-coverage edges with MSAA, alpha test without).
// LOD cross-fade: the batch colour alpha of an instance is 1 when shown, in (0, 1) while
// fading in and in (1, 2) while fading out; fragments are dithered on screen accordingly
// (complementary patterns, so a tree never shows both or neither).
//
// Vertex data: see treeGen.js (aVeg, aCrown, aCard; bark: aBark).

const WIND_PARS = /* glsl */`
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
attribute vec4 aVeg;
#ifdef VEG_LEAF
attribute vec4 aCrown;
attribute vec4 aCard;
uniform float uVegFlutter;
#endif
float vegHash( vec3 p ) { return fract( sin( dot( p, vec3( 12.9898, 78.233, 45.164 ) ) ) * 43758.5453 ); }

// Displacement in template (object) space. bm = per-tree matrix (identity if none).
// flut: leaf flutter angle (radians, signed), for the shading normal.
vec3 vegWind( vec3 p, mat4 bm, out float flut ) {
  vec3 inst = bm[ 3 ].xyz;
  float ph = dot( inst.xz, vec2( 0.37, 0.21 ) );
  mat3 R = mat3( bm );
  vec3 wL = transpose( R ) * vec3( uWind.x, 0.0, uWind.y );
  wL.y = 0.0;
  wL /= max( length( wL ), 1e-4 );
  vec3 perp = vec3( -wL.z, 0.0, wL.x );
  float s = uWindStrength;
  float t = uTime;
  // gusts drift down the street: slow, phase-shifted per tree
  float gust = 0.55 + 0.45 * sin( t * 0.37 + ph * 0.21 ) * sin( t * 0.23 + ph * 0.13 + 1.3 );
  // trunk / whole-crown sway (stiffness grows with size: h^1.8)
  float h = max( p.y - 0.4, 0.0 );
  float hb = pow( h, 1.8 ) * 0.010;
  float lean = s * ( 0.6 * gust + 0.25 * sin( t * 1.13 + ph ) + 0.1 * sin( t * 2.1 + ph * 1.7 ) );
  vec3 d = ( wL * lean + perp * s * 0.2 * sin( t * 0.91 + ph * 1.3 ) ) * hb;
  // branches: each limb has its own phase
  float bp = aVeg.x + ph;
  vec3 bm3 = vec3( sin( t * 1.7 + bp ), 0.6 * sin( t * 2.3 + bp * 1.3 ), cos( t * 1.4 + bp * 0.7 ) );
  d += ( bm3 * 0.6 + wL * ( 0.8 + 0.6 * sin( t * 1.1 + bp ) ) ) * aVeg.y * s * 0.07 * ( 0.5 + gust );
  flut = 0.0;
  #ifdef VEG_LEAF
    // leaf flutter: the outer part of each card turns about its long axis (2.3 and 4.1 Hz)
    float fph = vegHash( aCard.xyz ) * 6.283 + bp * 0.3;
    flut = uVegFlutter * s * ( 0.35 + gust ) * aVeg.z * ( sin( t * 14.45 + fph ) + 0.6 * sin( t * 25.76 + fph * 1.7 ) );
    d -= aCard.xyz * ( aCard.w * flut );
  #endif
  return p + d;
}
`;

const BATCH_MATRIX = /* glsl */`
  #ifdef USE_BATCHING
    mat4 vegBM = batchingMatrix;
  #elif defined( USE_INSTANCING )
    mat4 vegBM = instanceMatrix;
  #else
    mat4 vegBM = mat4( 1.0 );
  #endif
`;

// LOD cross-fade of the instance (batch colour alpha, see header)
const FADE_VARY = /* glsl */`
  #ifdef USE_BATCHING_COLOR
    vVegFade = getBatchingColor( getIndirectIndex( gl_DrawID ) ).a;
  #else
    vVegFade = 1.0;
  #endif
`;
const FADE_FN = /* glsl */`
varying float vVegFade;
// shadow: the incoming level casts from the middle of the fade on, the outgoing until then
bool vegFadeHidden( bool shadowPass ) {
  float f = vVegFade;
  if ( abs( f - 1.0 ) < 1e-3 ) return false;
  if ( shadowPass ) return f < 1.0 ? f < 0.5 : f - 1.0 >= 0.5;
  float h = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  return f < 1.0 ? h >= f : h < f - 1.0;
}
`;

function chain(mat, key, fn) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    fn(shader, renderer);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|' + key;
  mat.needsUpdate = true;
}

function windUniforms(shader, params) {
  shader.uniforms.uTime = U.uTime;
  shader.uniforms.uWind = U.uWind;
  shader.uniforms.uWindStrength = U.uWindStrength;
  shader.uniforms.uVegFlutter = params.flutter;
}

/** Replace `from` in `src`, warning (once per key) if the chunk layout changed. */
function rep(src, from, to, what) {
  if (!src.includes(from)) { console.warn(`[vegetation] shader hook not found: ${what}`); return src; }
  return src.replace(from, to);
}

/** Leaf material: shared by every tree, shrub and flower card. */
function patchLeaf(mat, params) {
  chain(mat, 'veg-leaf-v2', (shader) => {
    windUniforms(shader, params);
    shader.uniforms.uLeafTrans = params.trans;
    shader.uniforms.uLeafSpec = params.spec;
    shader.uniforms.uVegA2C = params.a2c;
    shader.uniforms.uVegDensity = params.density;
    shader.uniforms.uVegShift = params.shift;
    shader.uniforms.uSunDirV = U.uSunDir;
    let vs = shader.vertexShader;
    vs = rep(vs, '#include <common>', `#include <common>
      ${WIND_PARS}
      uniform vec3 uSunDirV;
      uniform float uVegDensity;
      uniform float uVegShift;
      varying float vVegAO;
      varying float vVegSun;
      varying float vVegFlut;
      varying float vVegRim;
      varying float vVegFade;
      varying vec3 vVegGN;`, 'leaf common');
    vs = rep(vs, '#include <begin_vertex>', `#include <begin_vertex>
      ${BATCH_MATRIX}
      transformed = vegWind( transformed, vegBM, vVegFlut );
      vVegAO = aVeg.w;
      ${FADE_VARY}
      // ---- light through the crown (template space; the crown is a sphere there)
      mat3 vegR = mat3( modelMatrix ) * mat3( vegBM );
      vec3 vegS2 = vec3( dot( vegR[ 0 ], vegR[ 0 ] ), dot( vegR[ 1 ], vegR[ 1 ] ), dot( vegR[ 2 ], vegR[ 2 ] ) );
      vec3 vegLt = ( transpose( vegR ) * uSunDirV ) / vegS2;  // world sun direction in template space
      float vegLs = max( length( vegLt ), 1e-5 );
      vec3 vegL = vegLt / vegLs;
      vec3 vegQ = aCrown.xyz;
      float vegB = dot( vegQ, vegL ), vegDisc = vegB * vegB - ( dot( vegQ, vegQ ) - 1.0 );
      float vegPath = 0.0;  // metres of crown between the leaf and the sun (world units)
      if ( vegDisc > 0.0 ) {
        float sq = sqrt( vegDisc );
        vegPath = ( max( 0.0, -vegB + sq ) - max( 0.0, -vegB - sq ) ) * aCrown.w / vegLs;
      }
      float vegT = exp( -uVegDensity * vegPath );
      float vegR0 = vegHash( aCard.xyz + 0.37 );
      vVegSun = mix( vegT, smoothstep( vegR0 - 0.22, vegR0 + 0.22, vegT ), 0.55 );  // dithered into flecks
      vVegRim = length( vegQ );
      vVegGN = normalMatrix * ( vegR * ( aCard.xyz / vegS2 ) );`, 'leaf begin_vertex');
    // the shadow lookup leaves the crown along the sun ray (external shadows only)
    vs = rep(vs, '#include <shadowmap_vertex>', `#if defined( USE_SHADOWMAP )
        worldPosition.xyz += uSunDirV * ( vegPath + 0.3 ) * uVegShift;
      #endif
      #include <shadowmap_vertex>`, 'leaf shadowmap_vertex');
    shader.vertexShader = vs;

    let fs = shader.fragmentShader;
    fs = rep(fs, '#include <common>', `#include <common>
      varying float vVegAO;
      varying float vVegSun;
      varying float vVegFlut;
      varying float vVegRim;
      varying vec3 vVegGN;
      uniform float uLeafTrans;
      uniform float uLeafSpec;
      uniform float uVegA2C;
      uniform vec3 uSunDirV;
      ${FADE_FN}
      float vegGloss = 0.5;`, 'leaf frag common');
    fs = rep(fs, '#include <map_fragment>', /* glsl */`
      #ifdef USE_MAP
        vec4 vegTex = texture2D( map, vMapUv );  // straight sRGB colour, decoded by the sampler
        // coverage: sharpened around 0.5 (crisp, anti-aliased edges with alpha-to-coverage)
        float vegA = vegTex.a;
        float vegCov = uVegA2C > 0.5 ? clamp( ( vegA - 0.5 ) / max( fwidth( vegA ), 1e-4 ) + 0.5, 0.0, 1.0 ) : step( 0.5, vegA );
        if ( vegCov < 0.02 ) discard;
        diffuseColor.rgb *= vegTex.rgb;
        diffuseColor.a = vegCov;
      #endif`, 'leaf map_fragment');
    fs = rep(fs, '#include <color_fragment>', /* glsl */`
      #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
        diffuseColor.rgb *= vColor.rgb;
      #endif
      if ( vegFadeHidden( false ) ) discard;
      // seen from the side the card faces away from: the paler, bluish-grey underside
      bool vegUnder = dot( vVegGN, vViewPosition ) < 0.0;
      if ( vegUnder ) {
        float l = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( l ) * vec3( 0.95, 1.08, 0.85 ), 0.22 ) * 1.08;
      }`, 'leaf color_fragment');
    // crown normals are authored to point out of the crown on both faces: no flip
    fs = rep(fs, '#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin
      .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'), 'leaf normal begin');
    fs = rep(fs, '#include <normal_fragment_maps>', /* glsl */`
      #ifdef USE_NORMALMAP_TANGENTSPACE
        vec4 vegNm = texture2D( normalMap, vNormalMapUv );  // normal x, y + gloss
        vec3 mapN = vec3( vegNm.xy * 2.0 - 1.0, 0.0 );
        mapN.z = sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) );
        mapN.xy *= normalScale;
        normal = normalize( tbn * mapN );
        // flutter turns the card about its axis: the shading normal follows
        normal = normalize( normal + tbn[ 0 ] * vVegFlut * 1.5 );
        vegGloss = vegNm.b;
      #endif
      // thick, older leaves are glossier
      roughnessFactor = mix( 0.72, 0.42, vegGloss );`, 'leaf normal maps');
    fs = rep(fs, '#include <lights_physical_pars_fragment>', /* glsl */`#include <lights_physical_pars_fragment>
      void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
        // the sun reaches inner leaves through the rest of the crown; lamps are local
        vec3 sunV = normalize( ( viewMatrix * vec4( uSunDirV, 0.0 ) ).xyz );
        bool isSun = dot( directLight.direction, sunV ) > 0.999;
        float through = isSun ? vVegSun : 1.0;
        vec3 gn = normalize( vVegGN );
        float facing = abs( dot( gn, geometryViewDir ) );
        ReflectedLight leafRL = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
        RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, leafRL );
        reflectedLight.directDiffuse += leafRL.directDiffuse * through;
        // waxy but small and curled leaves: part of the specular; none on edge-on cards
        reflectedLight.directSpecular += leafRL.directSpecular * ( uLeafSpec * through * smoothstep( 0.0, 0.4, facing ) );
        // transmission: light arriving on the far side of the card, strongest looking into
        // the light; thin outer leaves pass diffused light even when partly occluded
        if ( dot( gn, geometryViewDir ) < 0.0 ) gn = -gn;
        float back = saturate( -dot( gn, directLight.direction ) );
        float into = saturate( dot( -geometryViewDir, directLight.direction ) );
        float fwd = pow( into, 5.0 );
        float rim = smoothstep( 0.8, 1.05, vVegRim ) * smoothstep( 0.5, 0.9, into );
        float tThrough = isSun ? mix( 0.35, 1.0, vVegSun ) : 1.0;
        vec3 tc = material.diffuseColor * vec3( 1.5, 1.8, 0.5 );
        reflectedLight.directDiffuse += directLight.color * tc * uLeafTrans * tThrough * ( back * ( 0.55 + 1.8 * fwd ) + 0.3 * fwd + 0.5 * rim ) * RECIPROCAL_PI;
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_Leaf`, 'leaf lights pars');
    fs = rep(fs, '#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
      {
        // grazing cards pick up no sky sheen
        float vegFacing = smoothstep( 0.0, 0.4, abs( dot( normalize( vVegGN ), geometryViewDir ) ) );
        reflectedLight.indirectSpecular *= vVegAO * vegFacing;
        // sky light from the far side of the card, transmitted through the leaf
        #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
          vec3 vegGn = normalize( vVegGN );
          if ( dot( vegGn, geometryViewDir ) < 0.0 ) vegGn = -vegGn;
          reflectedLight.indirectDiffuse += getIBLIrradiance( -vegGn ) * diffuseColor.rgb * vec3( 0.75, 1.0, 0.4 ) * ( 0.55 * uLeafTrans * RECIPROCAL_PI );
        #endif
        reflectedLight.indirectDiffuse *= vVegAO;
        #ifdef VEG_DEBUG
          // debug view (URL vegdbg=1..4): one lighting term only
          vec3 vegDbg = VEG_DEBUG == 1 ? reflectedLight.directDiffuse : VEG_DEBUG == 2 ? reflectedLight.directSpecular
            : VEG_DEBUG == 3 ? reflectedLight.indirectDiffuse : reflectedLight.indirectSpecular;
          reflectedLight = ReflectedLight( vegDbg, vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
        #endif
      }`, 'leaf lights end');
    shader.fragmentShader = fs;
  });
}

/** Bark: wind (so branches carry the leaves), interior occlusion, young-bark lenticels. */
function patchBark(mat, params) {
  chain(mat, 'veg-bark-v2', (shader) => {
    windUniforms(shader, params);
    let vs = shader.vertexShader;
    vs = rep(vs, '#include <common>', `#include <common>
      ${WIND_PARS}
      attribute float aBark;
      varying float vVegAO;
      varying float vVegFade;
      varying float vBarkYouth;
      varying vec2 vBarkUv;`, 'bark common');
    vs = rep(vs, '#include <begin_vertex>', `#include <begin_vertex>
      ${BATCH_MATRIX}
      float vegFl;
      transformed = vegWind( transformed, vegBM, vegFl );
      vVegAO = aVeg.w;
      vBarkYouth = aBark;
      vBarkUv = uv;
      ${FADE_VARY}`, 'bark begin_vertex');
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = rep(fs, '#include <common>', `#include <common>
      varying float vVegAO;
      varying float vBarkYouth;
      varying vec2 vBarkUv;
      ${FADE_FN}
      float barkHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }`, 'bark frag common');
    fs = rep(fs, '#include <color_fragment>', /* glsl */`#include <color_fragment>
      if ( vegFadeHidden( false ) ) discard;
      {
        // young bark: pale horizontal lenticels (2-5 mm, ~30 per dm2) and faint vertical
        // striation, faded out before they would alias
        vec2 bu = vBarkUv;  // metres: u around the stem, v up
        vec2 cs = vec2( 0.016, 0.02 );
        vec2 g = bu / cs, gi = floor( g ), gf = fract( g ) - 0.5;
        float h1 = barkHash( gi ), h2 = barkHash( gi + 17.3 );
        vec2 dd = ( gf - ( vec2( h1, h2 ) - 0.5 ) * 0.55 ) * cs;
        float hl = mix( 0.001, 0.0025, h1 );
        float e = length( vec2( dd.x / hl, dd.y / 0.00055 ) );
        float px = max( fwidth( bu.x ), fwidth( bu.y ) );
        float detail = 1.0 - smoothstep( 0.0012, 0.0035, px );
        float lent = ( 1.0 - smoothstep( 0.55, 1.0, e ) ) * step( 0.3, h2 ) * detail * vBarkYouth;
        float stria = ( barkHash( vec2( floor( bu.x / 0.005 ), 3.1 ) ) - 0.5 ) * 0.1 * ( 1.0 - smoothstep( 0.0008, 0.0025, px ) ) * vBarkYouth;
        diffuseColor.rgb *= 1.0 + stria;
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.36, 0.33, 0.27 ), lent * 0.65 );
      }`, 'bark color_fragment');
    fs = rep(fs, '#include <lights_fragment_end>', `#include <lights_fragment_end>
      reflectedLight.indirectDiffuse *= vVegAO;
      reflectedLight.indirectSpecular *= vVegAO;
      reflectedLight.directSpecular *= vVegAO;`, 'bark lights end');
    shader.fragmentShader = fs;
  });
}

/** Shadow-pass material with the same wind (and coverage / fade for leaves). */
function makeDepth(leaf, params, map) {
  const m = new THREE.MeshDepthMaterial();
  m.name = leaf ? 'vegetation.leafDepth' : 'vegetation.barkDepth';
  if (leaf) {
    m.defines = { VEG_LEAF: '' };
    m.map = map;
    m.alphaTest = 0.5;
  }
  chain(m, leaf ? 'veg-leaf-depth-v2' : 'veg-bark-depth-v2', (shader) => {
    windUniforms(shader, params);
    let vs = shader.vertexShader;
    vs = rep(vs, '#include <common>', `#include <common>\n${WIND_PARS}\nvarying float vVegFade;`, 'depth common');
    vs = rep(vs, '#include <begin_vertex>', `#include <begin_vertex>
      ${BATCH_MATRIX}
      float vegFl;
      transformed = vegWind( transformed, vegBM, vegFl );
      ${FADE_VARY}`, 'depth begin_vertex');
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = rep(fs, '#include <common>', `#include <common>\n${FADE_FN}`, 'depth frag common');
    fs = rep(fs, '#include <map_fragment>', leaf ? `if ( vegFadeHidden( true ) ) discard;
      #ifdef USE_MAP
        // coverage-preserving mips; the level is capped so far cascades keep their holes
        vec2 vegSz = vec2( textureSize( map, 0 ) );
        vec2 vegDx = dFdx( vMapUv * vegSz ), vegDy = dFdy( vMapUv * vegSz );
        float vegLod = min( 2.0, max( 0.0, 0.5 * log2( max( dot( vegDx, vegDx ), dot( vegDy, vegDy ) ) ) ) );
        diffuseColor.a *= textureLod( map, vMapUv, vegLod ).a;
      #endif` : 'if ( vegFadeHidden( true ) ) discard;', 'depth map_fragment');
    shader.fragmentShader = fs;
  });
  return m;
}

/**
 * Create the vegetation materials. Leaves are our own material (registered as
 * 'vegetation.leaf'); bark is the library 'bark' (vertex-colour variant) patched for wind.
 */
export function createVegMaterials(app, atlas) {
  const M = app.materials;
  // a2c: 1 when the scene renders into a multisampled target (set by vegetation.update)
  const params = {
    trans: { value: 1.0 },      // leaf transmission strength
    spec: { value: 0.5 },       // share of the direct specular kept
    a2c: { value: 0 },
    density: { value: 0.42 },   // crown extinction (1/m): exp(-0.42 * 2 m) ~ 0.43 through a young crown
    shift: { value: 1 },        // shadow lookup moved out of the crown along the sun ray (0 = off, debug)
    flutter: { value: 0.32 },   // leaf flutter angle per unit wind strength (rad)
  };
  const leaf = new THREE.MeshStandardMaterial({
    name: 'vegetation.leaf',
    map: atlas.map,
    normalMap: atlas.normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    side: THREE.DoubleSide,
    alphaTest: 0,          // coverage is computed in the patched map chunk (see above)
    alphaToCoverage: true,
    roughness: 0.6,
    metalness: 0,
    vertexColors: true,
    envMapIntensity: 0.75,
  });
  leaf.defines = { VEG_LEAF: '' };
  const dbg = app.params.num('vegdbg', 0);
  if (dbg) leaf.defines.VEG_DEBUG = dbg | 0;
  patchLeaf(leaf, params);
  M.register('vegetation.leaf', leaf);

  const bark = M.get('bark', { vertexColors: true });
  patchBark(bark, params);

  return {
    leaf, bark, params,
    leafDepth: makeDepth(true, params, atlas.map),
    barkDepth: makeDepth(false, params, null),
  };
}
