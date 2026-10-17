import * as THREE from 'three';

// Materials of the line's trams (trams/model.js parts), tracked by the material library so
// lighting configures them like everything else.
//
//  - body: metallic silver paint under a clear coat. The vertex colour is the paint colour;
//    dark vertex colours (skirt, bellows, seals, door seams, carbon strips) are plain
//    dielectric trim, so only the silver panels turn metallic.
//  - glass / ws: flush side glazing, a smooth dielectric with a little more reflectance
//    than one surface (laminated / double panes) over the interior seen through the tint
//    (the material colour). Vertex colour black = black frit over the pillars and frames;
//    the upper panes glow with the saloon lighting at dusk (glass only).
//  - front: the cab front glass, uv = (u share of the half width, height in m). Drawn per
//    pixel: the clear windscreen (sky reflection over the lit cab and the dashboard below)
//    in a rounded U, a thin silver trim round it, the dark tinted mask (cheeks and the
//    foot where the lamps sit) outside it.
//  - metal: the pantograph frame (dark grey paint).

const C = (r, g, b) => new THREE.Color(r, g, b);

/** Windscreen outline in the front glass's uv space (GLSL): signed distance in metres,
 *  negative inside. The U narrows from ~1.85 m wide under the display band to a rounded
 *  bottom 1.1 m above the rail. */
const WS_GLSL = /* glsl */ `
float tramWsDist( vec2 p ) {
  vec2 q = vec2( abs( p.x ) * 1.28, p.y );
  // side edge through (0.6, 1.1) and (0.93, 2.6), outward normal towards +x / -y
  vec2 n = normalize( vec2( 1.5, -0.33 ) );
  float dA = dot( q - vec2( 0.6, 1.1 ), n );
  float dB = 1.1 - q.y;
  float r = 0.3;
  vec2 k = vec2( dA, dB ) + r;
  return length( max( k, 0.0 ) ) + min( max( k.x, k.y ), 0.0 ) - r;
}
`;

/** Metallic silver paint with a clear coat; dark vertex colours stay dielectric trim. */
export function makeBodyMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    name: 'trams.body', color: C(1, 1, 1), vertexColors: true,
    metalness: 0.7, roughness: 0.3, clearcoat: 0.55, clearcoatRoughness: 0.07,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
	// silver paint (bright vertex colours) vs dark trim
	float tramPaint = smoothstep( 0.08, 0.3, max( vColor.r, max( vColor.g, vColor.b ) ) );
	roughnessFactor = mix( 0.5, roughnessFactor, tramPaint );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor *= tramPaint;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.clearcoat *= tramPaint;`);
  };
  m.customProgramCacheKey = () => 'trams.body.v2';
  return m;
}

/** Side glazing over the interior colour; `glow` panes light up at dusk (emissive gated
 *  by the vertex colour so the black frit stays dark). */
export function makeGlassMaterial(name, interior, glow = false) {
  const m = new THREE.MeshPhysicalMaterial({
    name, color: interior, vertexColors: true, metalness: 0, roughness: 0.045, ior: 1.65,
    emissive: glow ? C(1.0, 0.96, 0.9) : C(0, 0, 0), emissiveIntensity: 0,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTramUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;')
      // saloon lighting (uv: x = m along the car, y = m up the side profile from the body's
      // lower edge, about the height above the rail less 0.13 m): the lit
      // ceiling shows brightest at the top of the panes, standing passengers and seat rows
      // break the light up along the car; the frit stays dark
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	{
		float gy = vTramUv.y, gx = vTramUv.x / 0.55;
		float h0 = fract( sin( floor( gx ) * 12.9898 + 4.1 ) * 43758.5453 );
		float h1 = fract( sin( ( floor( gx ) + 1.0 ) * 12.9898 + 4.1 ) * 43758.5453 );
		float crowd = mix( h0, h1, smoothstep( 0.0, 1.0, fract( gx ) ) );
		float body = smoothstep( 0.85, 1.1, gy ) * ( 1.0 - smoothstep( 1.75, 1.95, gy ) );
		float lit = ( 0.42 + 0.58 * smoothstep( 1.55, 2.15, gy ) ) * mix( 1.0, 0.4 + 0.45 * crowd, body );
		totalEmissiveRadiance *= vColor.g * lit;
	}`)
      // the environment cube's street is bare stone: no trees, poles, people, shade or
      // traffic. What a side pane mirrors at and below the horizon (the street, the shop
      // fronts opposite) is darker and less saturated than those bare sunlit facades
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	{
		vec3 tramR = transformDirectionByInverseViewMatrix( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
		float tramSky = smoothstep( 0.05, 0.45, tramR.y );
		vec3 tramStreet = mix( radiance, vec3( dot( radiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.35 ) * 0.5;
		radiance = mix( tramStreet, radiance, tramSky );
	}`);
  };
  m.customProgramCacheKey = () => 'trams.glass.v5';
  return m;
}

/** Cab front glass: windscreen, trim and mask from uv (see WS_GLSL). */
export function makeFrontMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    name: 'trams.front', color: C(1, 1, 1), metalness: 0, roughness: 0.09, ior: 1.65,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTramUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vTramUv;\n${WS_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	float tramD = tramWsDist( vTramUv );
	float tramAA = max( fwidth( tramD ), 1e-4 );
	float tramWs = 1.0 - smoothstep( -tramAA, tramAA, tramD );                  // clear windscreen
	float tramTrim = ( 1.0 - tramWs ) * ( 1.0 - smoothstep( 0.04 - tramAA, 0.04 + tramAA, tramD ) );
	// seen through the windscreen: the dashboard below ~1.5 m, the lit cab above;
	// the mask: dark tinted glass over a black backing
	vec3 tramCab = mix( vec3( 0.03, 0.034, 0.04 ), vec3( 0.15, 0.165, 0.185 ), smoothstep( 1.25, 1.8, vTramUv.y ) );
	vec3 tramMask = vec3( 0.006, 0.009, 0.02 );
	diffuseColor.rgb = mix( tramMask, tramCab, tramWs );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.38, 0.395, 0.42 ), tramTrim );`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
	roughnessFactor = mix( roughnessFactor, 0.3, tramTrim );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor = mix( metalnessFactor, 0.7, tramTrim );`)
      // the raked laminated screen mirrors the bright sky a little more than one surface would
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	radiance *= mix( 1.6, 1.0, tramTrim );`);
  };
  m.customProgramCacheKey = () => 'trams.front.v2';
  return m;
}

/** Pantograph frame: dark grey paint (vertex colour). */
export function makeMetalMaterial() {
  return new THREE.MeshStandardMaterial({ name: 'trams.metal', color: C(1, 1, 1), vertexColors: true, metalness: 0.3, roughness: 0.45 });
}
