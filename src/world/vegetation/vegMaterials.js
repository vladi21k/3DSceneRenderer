import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Foliage and bark shading. Built on MeshStandardMaterial with onBeforeCompile patches
// (always chained after any existing hook) so the lighting system (shadows, fog, env)
// keeps working:
//   * wind: trunk sway + branch motion + leaf flutter in the vertex shader, identical in
//     the custom depth materials so shadows move with the leaves and never self-shadow;
//   * far-LOD clumps are camera-facing billboards (aCorner.z = 1), expanded in view space;
//   * leaves: premultiplied atlas decoded in the shader, mip-aware alpha boost so far
//     crowns keep their density under alpha test / alpha-to-coverage, crown normals (no
//     back-face flip), paler undersides, translucency (back-lit leaves glow yellow-green,
//     shadowed by the real shadow term because it is added inside RE_Direct), and an
//     interior-occlusion term from the vertex data.
//
// Vertex data: aVeg = (branch phase, branch amplitude, flutter amplitude, occlusion),
//              aCorner = (billboard corner offset x, y, billboard flag).

const WIND_PARS = /* glsl */`
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
attribute vec4 aVeg;
attribute vec3 aCorner;

// Displacement in template (object) space. bm = per-tree matrix (identity if none).
vec3 vegWind( vec3 p, vec3 nrm, mat4 bm ) {
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
  // leaf flutter along the card normal
  float fph = bp * 3.1 + dot( p, vec3( 1.7, 2.3, 1.1 ) );
  d += nrm * sin( t * 17.0 + fph ) * aVeg.z * 0.012 * ( 0.25 + s * gust );
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

const WIND_APPLY = /* glsl */`
#include <begin_vertex>
${BATCH_MATRIX}
transformed = vegWind( transformed, normal, vegBM );
`;

// project_vertex with camera-facing billboards for the far clumps
const PROJECT_BILLBOARD = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
mvPosition = vegBM * mvPosition;
mvPosition = modelViewMatrix * mvPosition;
if ( aCorner.z > 0.5 ) {
  float vegScale = length( vegBM[ 0 ].xyz ) * 0.5 + length( vegBM[ 1 ].xyz ) * 0.5;
  mvPosition.xy += aCorner.xy * vegScale;
}
gl_Position = projectionMatrix * mvPosition;
`;

// mip level of the atlas lookup (for the coverage-preserving alpha boost)
const MIP_FN = /* glsl */`
float vegMip( vec2 uv, sampler2D tex ) {
  vec2 sz = vec2( textureSize( tex, 0 ) );
  vec2 dx = dFdx( uv * sz ), dy = dFdy( uv * sz );
  return max( 0.0, 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) );
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

function windUniforms(shader) {
  shader.uniforms.uTime = U.uTime;
  shader.uniforms.uWind = U.uWind;
  shader.uniforms.uWindStrength = U.uWindStrength;
}

/** Leaf material: shared by every tree, shrub and flower card. */
function patchLeaf(mat, params) {
  chain(mat, 'veg-leaf-v1', (shader) => {
    windUniforms(shader);
    shader.uniforms.uLeafTrans = params.trans;
    shader.uniforms.uLeafSpec = params.spec;
    shader.uniforms.uSunDirV = U.uSunDir;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}\nvarying float vVegAO;\nuniform vec3 uSunDirV;`)
      .replace('#include <begin_vertex>', WIND_APPLY + '\nvVegAO = aVeg.w;')
      .replace('#include <project_vertex>', PROJECT_BILLBOARD)
      // billboards take their shadow sample from the clump centre, nudged towards the sun
      .replace('#include <shadowmap_vertex>', `#if defined( USE_SHADOWMAP ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
        if ( aCorner.z > 0.5 ) worldPosition.xyz += uSunDirV * 0.45;
      #endif
      #include <shadowmap_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vVegAO;\nuniform float uLeafTrans;\nuniform float uLeafSpec;\n${MIP_FN}`)
      .replace('#include <map_fragment>', /* glsl */`
        #ifdef USE_MAP
          vec4 vegTex = texture2D( map, vMapUv );
          vegTex.rgb /= max( vegTex.a, 1e-3 );                       // atlas is premultiplied
          vegTex.rgb = sRGBTransferEOTF( vec4( vegTex.rgb, 1.0 ) ).rgb; // stored sRGB, sampled raw
          vegTex.a = min( 1.0, vegTex.a * ( 1.0 + vegMip( vMapUv, map ) * 0.3 ) );
          diffuseColor *= vegTex;
        #endif
        // leaf undersides are paler and slightly bluish-grey
        if ( ! gl_FrontFacing ) {
          float l = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( l ) * vec3( 0.95, 1.08, 0.85 ), 0.2 ) * 1.06;
        }`)
      // crown normals are authored to point out of the crown on both faces: no flip
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin
        .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'))
      .replace('#include <lights_physical_pars_fragment>', /* glsl */`#include <lights_physical_pars_fragment>
        // Thin-leaf transmission: light arriving on the far side of the leaf passes through
        // tinted yellow-green, strongest when looking towards the light. Added per light,
        // after the shadow term, so leaves in shadow do not glow.
        void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
          // leaves are waxy but small and curled: keep only part of the direct specular
          ReflectedLight leafRL = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
          RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, leafRL );
          reflectedLight.directDiffuse += leafRL.directDiffuse;
          reflectedLight.directSpecular += leafRL.directSpecular * uLeafSpec;
          float back = saturate( -dot( geometryNormal, directLight.direction ) );
          float fwd = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 5.0 );
          vec3 tc = material.diffuseColor * vec3( 1.5, 1.8, 0.5 );
          reflectedLight.directDiffuse += directLight.color * tc * uLeafTrans * ( back * ( 0.55 + 1.8 * fwd ) + 0.3 * fwd ) * RECIPROCAL_PI;
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Leaf`)
      .replace('#include <aomap_fragment>', /* glsl */`#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vVegAO;
        reflectedLight.indirectSpecular *= vVegAO;
        reflectedLight.directDiffuse *= mix( 1.0, vVegAO, 0.35 );
        reflectedLight.directSpecular *= vVegAO;`);
  });
}

/** Bark: wind (so branches carry the leaves) and interior occlusion. */
function patchBark(mat) {
  chain(mat, 'veg-bark-v1', (shader) => {
    windUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}\nvarying float vVegAO;`)
      .replace('#include <begin_vertex>', WIND_APPLY + '\nvVegAO = aVeg.w;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vVegAO;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vVegAO;
        reflectedLight.indirectSpecular *= vVegAO;
        reflectedLight.directSpecular *= vVegAO;`);
  });
}

/** Shadow-pass material with the same wind (and billboards / alpha boost for leaves). */
function makeDepth(leaf) {
  const m = new THREE.MeshDepthMaterial();
  m.name = leaf ? 'vegetation.leafDepth' : 'vegetation.barkDepth';
  chain(m, leaf ? 'veg-leaf-depth-v1' : 'veg-bark-depth-v1', (shader) => {
    windUniforms(shader);
    let vs = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}`)
      .replace('#include <begin_vertex>', WIND_APPLY);
    if (leaf) vs = vs.replace('#include <project_vertex>', PROJECT_BILLBOARD);
    shader.vertexShader = vs;
    if (leaf) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${MIP_FN}`)
        .replace('#include <map_fragment>', `#ifdef USE_MAP
          vec4 vegTex = texture2D( map, vMapUv );
          diffuseColor.a *= min( 1.0, vegTex.a * ( 1.0 + vegMip( vMapUv, map ) * 0.3 ) );
        #endif`);
    }
  });
  return m;
}

/**
 * Create the vegetation materials. Leaves are our own material (registered as
 * 'vegetation.leaf'); bark is the library 'bark' (vertex-colour variant) patched for wind.
 */
export function createVegMaterials(app, atlas) {
  const M = app.materials;
  const params = { trans: { value: 0.85 }, spec: { value: 0.45 } };
  const leaf = new THREE.MeshStandardMaterial({
    name: 'vegetation.leaf',
    map: atlas.map,
    normalMap: atlas.normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    alphaToCoverage: true,
    roughness: 0.62,
    metalness: 0,
    vertexColors: true,
    envMapIntensity: 0.6,
  });
  patchLeaf(leaf, params);
  M.register('vegetation.leaf', leaf);

  const bark = M.get('bark', { vertexColors: true });
  patchBark(bark);

  return {
    leaf, bark, params,
    leafDepth: makeDepth(true),
    barkDepth: makeDepth(false),
  };
}
