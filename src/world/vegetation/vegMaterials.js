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
// Sky light is occluded the same way: a leaf sees the sky through the crown above it and
// around it (path to the crown surface straight up and radially out), so the crown core
// and its underside sit at about half the sky light of the top shell (light also comes
// in sideways through the gaps between the leaf clumps). That
// occlusion darkens every indirect term (sky diffuse, sky sheen, sky through the leaf).
// Leaves also transmit light, but only light arriving on their far side (backlit cards):
// a fraction (uLeafTrans, ~0.45) of what the lit face would show, a little more looking
// into the light and on the thin outer shell (rim-lit edges), and through the crown like
// the direct term. Sky light from the far side passes through the same way.
//
// Coverage: the atlas carries coverage-preserving alpha mips, so coverage is sharpened at
// every distance (alpha-to-coverage edges with MSAA, alpha test without). The coverage is
// rounded to whole MSAA samples: some drivers dither fractional alpha-to-coverage over a
// screen-fixed 2x2 pixel pattern, which would print a checkerboard behind the leaves.
// Strong direct light: transmission and specular of a light are capped at LIGHT_CAP times
// the sky's irradiance (and a lamp's diffuse at LAMP_CAP times), so low sun through a
// backlit crown or a leaf next to a lantern glows instead of clipping to neon green.
// Lamps pass little light through the leaves (LAMP_TRANS of the sun's share): a crown
// under a street lamp is lit warm olive on its underside, never a green lampshade.
// LOD cross-fade: the batch colour alpha of an instance is 1 when shown, in (0, 1) while
// fading in and in (1, 2) while fading out; fragments are dithered on screen accordingly
// (complementary patterns, so a tree never shows both or neither).
// Depth pre-pass: near crowns are drawn twice, first by leafPre (same vertex shader with an
// invariant position, coverage only, no colour), then by leaf with depth writes off, so the
// expensive leaf lighting runs once per visible sample instead of once per layer of cards.
// Far crowns (small on screen, see pool.js) are drawn once by leafFar (depth writes on).
//
// Vertex data: see treeGen.js (aVeg, aCrown, aCard; bark: aBark).

const LIGHT_CAP = 8.0;
const LAMP_CAP = 14.0;
const LAMP_TRANS = 0.3;

const WIND_PARS = /* glsl */`
invariant gl_Position;
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
  chain(mat, 'veg-leaf-v3', (shader) => {
    windUniforms(shader, params);
    shader.uniforms.uLeafTrans = params.trans;
    shader.uniforms.uLeafSpec = params.spec;
    shader.uniforms.uVegA2C = params.a2c;
    shader.uniforms.uVegDensity = params.density;
    shader.uniforms.uVegShift = params.shift;
    shader.uniforms.uVegCap = params.cap;
    shader.uniforms.uVegSky = params.sky;
    shader.uniforms.uSunDirV = U.uSunDir;
    let vs = shader.vertexShader;
    vs = rep(vs, '#include <common>', `#include <common>
      ${WIND_PARS}
      uniform vec3 uSunDirV;
      uniform float uVegDensity;
      uniform float uVegShift;
      uniform vec2 uVegSky;
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
      // sky occlusion by the crown: metres of crown above the leaf and radially outside it
      float vegUb = vegQ.y, vegUd = vegUb * vegUb - ( dot( vegQ, vegQ ) - 1.0 );
      float vegUp = vegUd > 0.0 ? max( 0.0, -vegUb + sqrt( vegUd ) ) : 0.0;
      float vegDepth = ( 0.6 * vegUp + 0.4 * max( 0.0, 1.0 - vVegRim ) ) * aCrown.w;
      vVegAO *= mix( uVegSky.y, 1.0, exp( -uVegSky.x * vegDepth ) );
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
      uniform vec2 uVegCap;
      ${FADE_FN}
      float vegGloss = 0.5;
      float vegSkyE = 0.0;  // luminance of the sky irradiance on a level surface (set before the lights)`, 'leaf frag common');
    fs = rep(fs, '#include <map_fragment>', /* glsl */`
      #ifdef USE_MAP
        vec4 vegTex = texture2D( map, vMapUv );  // straight sRGB colour, decoded by the sampler
        // coverage: sharpened around 0.5 (crisp, anti-aliased edges with alpha-to-coverage).
        // Cards seen nearly edge-on show their clump foreshortened: the leaves thin out
        // instead of smearing into streaks.
        float vegFace = abs( dot( normalize( vVegGN ), normalize( vViewPosition ) ) );
        float vegA = vegTex.a * mix( 0.45, 1.0, smoothstep( 0.03, 0.2, vegFace ) );
        float vegCov = uVegA2C > 0.5 ? clamp( ( vegA - 0.5 ) / max( fwidth( vegA ), 1e-4 ) + 0.5, 0.0, 1.0 ) : step( 0.5, vegA );
        if ( uVegA2C > 0.5 ) vegCov = floor( vegCov * uVegA2C + 0.5 ) / uVegA2C;  // whole samples
        if ( vegCov <= 0.0 ) discard;
        diffuseColor.rgb *= vegTex.rgb;
        diffuseColor.a = vegCov;
      #endif`, 'leaf map_fragment');
    fs = rep(fs, '#include <color_fragment>', /* glsl */`
      #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
        diffuseColor.rgb *= vColor.rgb;
      #endif
      if ( vegFadeHidden( false ) ) discard;
      #ifdef VEG_PREPASS
        // depth pre-pass: coverage (alpha-to-coverage) and depth only
        gl_FragColor = vec4( 0.0, 0.0, 0.0, diffuseColor.a );
        return;
      #endif
      // seen from the side the card faces away from: the paler, bluish-grey underside
      bool vegUnder = dot( vVegGN, vViewPosition ) < 0.0;
      if ( vegUnder ) {
        float l = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( l ) * vec3( 0.95, 1.08, 0.85 ), 0.1 ) * 1.04;
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
      roughnessFactor = mix( 0.62, 0.36, vegGloss );`, 'leaf normal maps');
    fs = rep(fs, '#include <lights_physical_pars_fragment>', /* glsl */`#include <lights_physical_pars_fragment>
      void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
        // the street keeps a fixed set of lamp lights (dark by day, out of range for most
        // leaves at night): unlit ones cost nothing
        if ( ! directLight.visible ) return;
        // the sun reaches inner leaves through the rest of the crown; lamps are local
        vec3 sunV = normalize( ( viewMatrix * vec4( uSunDirV, 0.0 ) ).xyz );
        bool isSun = dot( directLight.direction, sunV ) > 0.999;
        float through = isSun ? vVegSun : 1.0;
        vec3 gn = normalize( vVegGN );
        float facing = abs( dot( gn, geometryViewDir ) );
        if ( dot( gn, geometryViewDir ) < 0.0 ) gn = -gn;  // card normal on the viewer's side
        // a leaf reflects a light only on the face the light falls on: seen from the other
        // side (a sunlit crown from below) it mostly transmits. A card is a clump of leaves
        // turned every way, so its far side still shows some lit faces (no sheen though).
        float vegLit = dot( gn, directLight.direction );
        float sameSide = smoothstep( -0.2, 0.25, vegLit );
        ReflectedLight leafRL = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
        RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, leafRL );
        // strong light: transmission and sheen capped at a few times the sky's irradiance,
        // and a lamp's diffuse too (a leaf against the lantern stays a lit leaf)
        float vegE = dot( directLight.color, vec3( 0.2126, 0.7152, 0.0722 ) );
        float vegCapT = vegSkyE > 0.0 ? min( 1.0, uVegCap.x * vegSkyE / max( vegE, 1e-9 ) ) : 1.0;
        float vegCapD = isSun || vegSkyE <= 0.0 ? 1.0 : min( 1.0, uVegCap.y * vegSkyE / max( vegE, 1e-9 ) );
        vec3 vegDD = leafRL.directDiffuse;
        if ( ! isSun ) {
          // a warm lamp on green leaves reads olive / yellow-brown (its spectrum has little
          // of the green the leaf reflects best), not saturated green
          float vegDL = dot( vegDD, vec3( 0.2126, 0.7152, 0.0722 ) );
          vegDD = mix( vegDD, vegDL * vec3( 1.3, 1.0, 0.55 ), 0.4 );
        }
        reflectedLight.directDiffuse += vegDD * ( through * vegCapD * mix( 0.3, 1.0, sameSide ) );
        // waxy but small and curled leaves: part of the specular; none on edge-on cards
        reflectedLight.directSpecular += leafRL.directSpecular * ( uLeafSpec * through * smoothstep( 0.0, 0.4, facing ) * vegCapT * vegCapD * sameSide );
        // transmission: only light arriving on the far side of the card (backlit leaves), a
        // fraction of what the lit face shows; a little more looking into the light and on
        // the thin outer shell (rim-lit edges); through the crown like the direct light
        float back = saturate( -vegLit );
        float into = saturate( dot( -geometryViewDir, directLight.direction ) );
        float fwd = pow( into, 4.0 );
        float rim = smoothstep( 0.85, 1.05, vVegRim ) * fwd;
        float tThrough = isSun ? mix( 0.12, 1.0, vVegSun ) : ${LAMP_TRANS.toFixed(3)} * vegCapD;
        vec3 tc = material.diffuseColor * vec3( 1.12, 1.08, 0.55 );
        reflectedLight.directDiffuse += directLight.color * tc * ( uLeafTrans * tThrough * vegCapT * back * ( 1.0 + 0.5 * fwd + 0.4 * rim ) * RECIPROCAL_PI );
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_Leaf`, 'leaf lights pars');
    fs = rep(fs, '#include <lights_fragment_begin>', /* glsl */`
      #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
        vegSkyE = dot( getIBLIrradiance( normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ), vec3( 0.2126, 0.7152, 0.0722 ) );
      #endif
      vegSkyE += dot( getAmbientLightIrradiance( ambientLightColor ), vec3( 0.2126, 0.7152, 0.0722 ) );
      #include <lights_fragment_begin>`, 'leaf lights begin');
    fs = rep(fs, '#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
      {
        // grazing cards pick up no sky sheen
        float vegFacing = smoothstep( 0.0, 0.4, abs( dot( normalize( vVegGN ), geometryViewDir ) ) );
        reflectedLight.indirectSpecular *= vVegAO * vegFacing;
        // sky light from the far side of the card, transmitted through the leaf
        #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
          vec3 vegGn = normalize( vVegGN );
          if ( dot( vegGn, geometryViewDir ) < 0.0 ) vegGn = -vegGn;
          reflectedLight.indirectDiffuse += getIBLIrradiance( -vegGn ) * diffuseColor.rgb * vec3( 1.0, 1.04, 0.6 ) * ( 0.8 * uLeafTrans * RECIPROCAL_PI );
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
        float youth = smoothstep( 0.5, 1.0, vBarkYouth );  // old, fissured bark has none
        float lent = ( 1.0 - smoothstep( 0.55, 1.0, e ) ) * step( 0.3, h2 ) * detail * youth;
        float stria = ( barkHash( vec2( floor( bu.x / 0.005 ), 3.1 ) ) - 0.5 ) * 0.1 * ( 1.0 - smoothstep( 0.0008, 0.0025, px ) ) * youth;
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
    trans: { value: 0.45 },     // leaf transmission: share of the lit face's radiance passed through
    sky: { value: new THREE.Vector2(0.4, 0.45) },  // sky occlusion by the crown: extinction (1/m), floor
    spec: { value: 0.5 },       // share of the direct specular kept
    a2c: { value: 0 },
    density: { value: 0.55 },   // crown extinction (1/m): exp(-0.55 * 2 m) ~ 0.33 through a young crown
    shift: { value: 1 },        // shadow lookup moved out of the crown along the sun ray (0 = off, debug)
    flutter: { value: 0.32 },   // leaf flutter angle per unit wind strength (rad)
    // per-light caps in units of the sky's irradiance: transmission + specular of any
    // light, diffuse of a lamp (see header)
    cap: { value: new THREE.Vector2(LIGHT_CAP, LAMP_CAP) },
  };
  const makeLeaf = (name, defines) => {
    const m = new THREE.MeshStandardMaterial({
      name,
      map: atlas.map,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      side: THREE.DoubleSide,
      alphaTest: 0,          // coverage is computed in the patched map chunk (see above)
      alphaToCoverage: true,
      roughness: 0.6,
      metalness: 0,
      vertexColors: true,
      envMapIntensity: 0.8,
    });
    m.defines = { VEG_LEAF: '', ...defines };
    patchLeaf(m, params);
    return m;
  };
  const dbg = app.params.num('vegdbg', 0);
  const leaf = makeLeaf('vegetation.leaf', dbg ? { VEG_DEBUG: dbg | 0 } : {});
  // after the pre-pass: shade the samples it left, no depth writes (early depth test)
  leaf.depthWrite = false;
  M.register('vegetation.leaf', leaf);
  // crowns without the pre-pass (far, small on screen): the same program with depth writes
  const leafFar = makeLeaf('vegetation.leafFar', dbg ? { VEG_DEBUG: dbg | 0 } : {});
  M.register('vegetation.leafFar', leafFar);
  const leafPre = makeLeaf('vegetation.leafPre', { VEG_PREPASS: '' });
  leafPre.colorWrite = false;
  M.register('vegetation.leafPre', leafPre);

  const bark = M.get('bark', { vertexColors: true });
  patchBark(bark, params);

  const leafDepth = makeDepth(true, params, atlas.map);
  return {
    leaf, leafPre, leafFar, bark, params, leafDepth,
    barkDepth: makeDepth(false, params, null),
    /** Swap in the painted atlas (the stand-ins are disposed). */
    setAtlas(a) {
      const old = [leaf.map, leaf.normalMap];
      for (const m of [leaf, leafPre, leafFar]) { m.map = a.map; m.normalMap = a.normalMap; }
      leafDepth.map = a.map;
      for (const t of old) if (t && t !== a.map && t !== a.normalMap) t.dispose();
    },
  };
}
