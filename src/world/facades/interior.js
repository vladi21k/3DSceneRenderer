import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { goodsAtlas, GOODS_PAD } from './goods.js';

// Interior-mapped window glass.
//
// A standard PBR glass surface (F0 0.04, near-mirror roughness with a faint smudge film)
// whose reflections are completed by an analytic "street" model (opposite facades with
// their windows, the paving and the street trees, falling back to the sky / environment
// map above the rooflines), and whose transmitted light is a fake room traced per pixel:
// a box ~4 m deep (homes) or ~7 m (shops) with painted walls, floor, ceiling, furniture
// boxes, shelving with real depth (boards, goods of varied size and shape, a back panel)
// and curtains / sheers / blinds just behind the glass.
//
// Lighting inside the room, in scene units (daylight horizontal illuminance is ~3; the
// camera exposure rises ~1000x at dusk, so lamp levels are ~1/1000 of daylight):
//   daylight  form factor of the window aperture seen from each point, a uniform
//             inter-reflected share, sun patches through the aperture, and corner and
//             contact occlusion;
//   homes     a pendant or standing lamp of ~2700 K: shaded downward lobe, a bright pool
//             on the ceiling above the open shade, inverse-square falloff, fabric glowing
//             through when the curtains are drawn;
//   shops     a grid of recessed downlights (cos^n lobes, so their pools scallop the
//             walls and floor) of 3000–3500 K, warmer for cafes, cool only for pharmacies.
//
// Every periodic pattern is filtered against the pixel footprint at its hit point
// (pixel angle × path length / obliquity): stripes and grids fade to their mean before
// they alias, so nothing crawls when seen from the moving tram.
//
// Cost: once a pixel covers more than ~6–11 cm of the glass (a window under ~15 px wide)
// the furniture, its contact shadows, the merchandise patterns, lamp shades, pendants and
// the old-glass waviness are skipped; each fades out over that range, so nothing pops
// (furniture into the surface behind it). Lamp light scales with the global night
// emissive gain (materials.uniforms.emissiveGain).
//
// Per-vertex attributes (all in the facade frame of the lot, metres):
//   aRoomP  (x, y, z, halfWinW)   ray origin in room space (x from the left wall, y up from
//                                 the room floor, z depth behind the glass), window half width
//   aRoomS  (W, H, D, baseH)      room size, and height of the room floor above the paving
//   aWin    (seed, lit, drape, code)  code = kind + 4·noGlass + 8·shopType (winCode);
//                                 kind 0 home, 1 shop, 2 stairwell/door
//   aFac    (angle, streetW + recess, winY0, winY1)  facade tangent angle (world), distance
//                                 to the opposite facade (integer part) plus the opening's
//                                 recess (fraction), window sill / head heights in room space
//   aFrame  (r, g, b, on)         far range: procedural casing colour

/** Share of the rooms lit at full night (uNight = 1); closed shutters hide ~1/5 of them. */
export const LIT_SHARE = 0.5;

/**
 * Character of a lit room from its lit threshold (aWin.y), shared by the rooms and their
 * reveal spill (spill.js): lamp colour 2700–4000 K (mostly warm, a few cool LED rooms),
 * level ×0.6–1.4, and ~7% of the rooms lit only by a television.
 */
export const ROOM_LIGHT_GLSL = /* glsl */`
#define LIT_SHARE ${LIT_SHARE.toFixed(3)}
vec3 fRoomLampC( float lit ) {
  float c = fract( lit * 13.71 + 0.37 );
  vec3 warm = vec3( 1.0, 0.56, 0.27 ), mid = vec3( 1.0, 0.68, 0.42 ), cool = vec3( 1.0, 0.80, 0.62 );
  return c < 0.55 ? mix( warm, mid, c / 0.55 ) : c < 0.9 ? mix( mid, cool, ( c - 0.55 ) / 0.35 ) : vec3( 0.95, 0.9, 0.84 );
}
float fRoomLevel( float lit ) { return 0.6 + 0.8 * fract( lit * 7.13 + 0.5 ); }
float fRoomTV( float lit ) { return step( fract( lit * 31.17 + 0.11 ), 0.07 ); }
// television light: cool, its level jumping at every cut and drifting within a shot
vec3 fTVLight( float lit, float t ) {
  float cut = floor( t * 0.45 + lit * 17.0 );
  float a = fract( sin( cut * 12.9898 + lit * 78.233 ) * 43758.5453 );
  float b = fract( sin( cut * 39.346 + lit * 11.135 ) * 24634.6345 );
  float drift = 0.85 + 0.15 * sin( t * 2.1 + lit * 40.0 ) * sin( t * 0.7 );
  return mix( vec3( 0.55, 0.7, 1.0 ), vec3( 0.95, 0.9, 0.85 ), b * 0.6 ) * ( 0.35 + 0.65 * a ) * drift;
}
`;

/** Shop interior types, in shader order. */
export const SHOP_TYPES = ['clothing', 'general', 'cafe', 'jewellery', 'pharmacy', 'shoes', 'books', 'flowers'];
export const shopTypeIndex = (name) => Math.max(0, SHOP_TYPES.indexOf(name));
/** Pack aWin.w. */
export const winCode = (kind, noGlass = false, type = 0) => kind + (noGlass ? 4 : 0) + 8 * type;

// Per-window values are flat: an interpolated constant carries ~1e-7 of rounding noise,
// which the hashes below amplify into per-pixel speckle (goods, furniture sizes).
const VERT_PARS = /* glsl */`
attribute vec4 aRoomP;
attribute vec4 aRoomS;
attribute vec4 aWin;
attribute vec4 aFac;
attribute vec4 aFrame;
flat varying vec4 vFrame;
varying vec4 vRoomP;
flat varying vec4 vRoomS;
flat varying vec4 vWin;
flat varying vec4 vFac;
varying vec3 vFW;
`;

const VERT_MAIN = /* glsl */`
vRoomP = aRoomP; vRoomS = aRoomS; vWin = aWin; vFac = aFac; vFrame = aFrame;
vFW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAG_PARS = /* glsl */`
uniform float uTime;
${ROOM_LIGHT_GLSL}
// shop lighting by day, relative to the daylight irradiance on the glass: interiors read
// at ~10–20% of the street's luminance, so the glass is dominated by its reflection
#define SHOP_DAY 0.16
// share of the glass's sky irradiance that the street canyon passes into the rooms
#define CANYON 0.55
uniform sampler2D uGoods;
#define GOODS_PAD ${GOODS_PAD.toFixed(5)}
uniform float uNight;
uniform float uEmGain;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
flat varying vec4 vFrame;
varying vec4 vRoomP;
flat varying vec4 vRoomS;
flat varying vec4 vWin;
flat varying vec4 vFac;
varying vec3 vFW;

// pixel angle (radians) and camera distance to the glass, set per pixel before tracing;
// gDet: 1 while room detail (furniture, patterns) is resolved, 0 once it is skipped;
// gEm: emissive gain of the artificial light (night)
float gPA = 0.001;
float gTC = 10.0;
float gDet = 1.0;
float gEm = 1.0;

float fh1( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
float fh2( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
vec3 fh3( float p ) { return vec3( fh1( p ), fh1( p + 17.13 ), fh1( p + 41.71 ) ); }
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( fh2( i ), fh2( i + vec2( 1, 0 ) ), f.x ), mix( fh2( i + vec2( 0, 1 ) ), fh2( i + vec2( 1, 1 ) ), f.x ), f.y );
}

// ---- filtering
// footprint (m) of one pixel at path length t inside the room, on a surface with normal n
float fFoot( float t, vec3 rd, vec3 n ) { return gPA * ( gTC + t ) / max( abs( dot( rd, n ) ), 0.25 ); }
float fp0( float t, vec3 rd ) { return gPA * ( gTC + t ) / max( rd.z, 0.25 ); }
// 1 while a pattern of period P is resolved, fading to 0 (use its mean) near the pixel size
float fKeep( float fp, float P ) { return 1.0 - smoothstep( 0.2, 0.5, fp / P ); }
// box-filtered pulse train: share of [x - w/2, x + w/2] (in periods) where fract(x) >= e
float fPulseI( float x, float e ) { return floor( x ) * ( 1.0 - e ) + max( fract( x ) - e, 0.0 ); }
float fPulse( float x, float e, float w ) { w = max( w, 1e-3 ); return ( fPulseI( x + 0.5 * w, e ) - fPulseI( x - 0.5 * w, e ) ) / w; }
// filtered 0..1 edge: 1 for x > 0, softened over the footprint
float fEdge( float x, float fp ) { return clamp( x / max( fp, 1e-4 ) + 0.5, 0.0, 1.0 ); }

// ray / AABB, returns (tNear, tFar)
vec2 fBox( vec3 ro, vec3 ird, vec3 bmin, vec3 bmax ) {
  vec3 t0 = ( bmin - ro ) * ird, t1 = ( bmax - ro ) * ird;
  vec3 tn = min( t0, t1 ), tf = max( t0, t1 );
  return vec2( max( max( tn.x, tn.y ), tn.z ), min( min( tf.x, tf.y ), tf.z ) );
}
vec3 fBoxN( vec3 ro, vec3 ird, vec3 bmin, vec3 bmax, float t ) {
  vec3 t0 = ( bmin - ro ) * ird, t1 = ( bmax - ro ) * ird;
  vec3 tn = min( t0, t1 );
  vec3 s = -sign( ird );
  if ( t == tn.x ) return vec3( s.x, 0.0, 0.0 );
  if ( t == tn.y ) return vec3( 0.0, s.y, 0.0 );
  return vec3( 0.0, 0.0, s.z );
}

const vec3 WALLS[6] = vec3[6]( vec3( 0.74, 0.70, 0.60 ), vec3( 0.76, 0.75, 0.71 ), vec3( 0.74, 0.65, 0.48 ),
  vec3( 0.56, 0.61, 0.64 ), vec3( 0.60, 0.65, 0.55 ), vec3( 0.74, 0.60, 0.50 ) );
const vec3 SHOPWALL[8] = vec3[8]( vec3( 0.78, 0.77, 0.74 ), vec3( 0.72, 0.70, 0.66 ), vec3( 0.62, 0.52, 0.42 ), vec3( 0.13, 0.10, 0.08 ),
  vec3( 0.82, 0.82, 0.81 ), vec3( 0.62, 0.52, 0.42 ), vec3( 0.42, 0.30, 0.20 ), vec3( 0.66, 0.68, 0.62 ) );
const vec3 FABRIC[8] = vec3[8]( vec3( 0.50, 0.45, 0.38 ), vec3( 0.22, 0.25, 0.30 ), vec3( 0.40, 0.13, 0.11 ), vec3( 0.18, 0.28, 0.20 ),
  vec3( 0.56, 0.52, 0.46 ), vec3( 0.11, 0.11, 0.12 ), vec3( 0.42, 0.32, 0.23 ), vec3( 0.28, 0.33, 0.45 ) );
const vec3 DRAPES[6] = vec3[6]( vec3( 0.78, 0.74, 0.64 ), vec3( 0.82, 0.81, 0.77 ), vec3( 0.68, 0.57, 0.42 ),
  vec3( 0.46, 0.15, 0.13 ), vec3( 0.42, 0.46, 0.33 ), vec3( 0.62, 0.56, 0.50 ) );
const vec3 GOODS[8] = vec3[8]( vec3( 0.62, 0.11, 0.09 ), vec3( 0.10, 0.22, 0.48 ), vec3( 0.76, 0.66, 0.20 ), vec3( 0.12, 0.40, 0.19 ),
  vec3( 0.80, 0.79, 0.76 ), vec3( 0.07, 0.07, 0.08 ), vec3( 0.72, 0.40, 0.14 ), vec3( 0.48, 0.32, 0.48 ) );

struct Hit { float t; vec3 n; vec3 alb; float glow; float id; };   // id 0 room, 1 furniture, 2 shelving

// ---- furniture: trace (mode 0) or contact occlusion at p (mode 1)
void fBoxT( inout Hit h, inout float ao, vec3 ro, vec3 ird, vec3 p, vec3 n, int mode, vec3 bmin, vec3 bmax, vec3 alb ) {
  if ( mode == 0 ) {
    vec2 r = fBox( ro, ird, bmin, bmax );
    if ( r.x < r.y && r.x > 0.0 && r.x < h.t ) { h.t = r.x; h.n = fBoxN( ro, ird, bmin, bmax, r.x ); h.alb = alb; h.glow = 0.0; h.id = 1.0; }
  } else {
    vec3 c = 0.5 * ( bmin + bmax ), e = 0.5 * ( bmax - bmin );
    if ( n.y > 0.5 ) {
      // floor (or a lower top): soft shadow under and around the piece, weaker for raised tops
      vec2 q = abs( p.xz - c.xz ) - e.xz;
      float d = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 );
      float rise = max( bmin.y - p.y, 0.0 );
      if ( p.y < bmax.y - 0.01 ) ao *= 1.0 - ( 0.55 - 0.35 * smoothstep( 0.0, 1.0, rise ) ) * ( 1.0 - smoothstep( -0.05, 0.25 + 0.35 * rise, d ) );
    } else {
      vec3 q = abs( p - c ) - e;
      float d = length( max( q, 0.0 ) ) + min( max( q.x, max( q.y, q.z ) ), 0.0 );
      ao *= 0.6 + 0.4 * smoothstep( 0.0, 0.3, d );
    }
  }
}

// vertical cylinder (planter, bucket, stool), centre c (xz), radius r, y range
void fCylT( inout Hit h, vec3 ro, vec3 rd, vec2 c, float r, float y0, float y1, vec3 alb ) {
  vec2 o = ro.xz - c, d = rd.xz;
  float a = dot( d, d ), b = dot( o, d ), cc = dot( o, o ) - r * r;
  float disc = b * b - a * cc;
  if ( disc < 0.0 ) return;
  float t = ( -b - sqrt( disc ) ) / a;
  float y = ro.y + rd.y * t;
  if ( t > 0.0 && t < h.t && y > y0 && y < y1 ) { h.t = t; vec2 n = normalize( o + d * t ); h.n = vec3( n.x, 0.0, n.y ); h.alb = alb; h.glow = 0.0; h.id = 1.0; }
  else if ( rd.y < 0.0 ) {
    // open top (bucket / pot contents)
    float tt = ( y1 - ro.y ) / rd.y;
    vec2 q = ro.xz + rd.xz * tt - c;
    if ( tt > 0.0 && tt < h.t && dot( q, q ) < r * r ) { h.t = tt; h.n = vec3( 0.0, 1.0, 0.0 ); h.alb = alb; h.glow = 0.0; h.id = 1.0; }
  }
}

// lamp shade: open cylinder of radius r around c between y0 and y1; returns the hit t
// (or -1), inner = 1 when the inside is seen through the open bottom or top
float fShade( vec3 ro, vec3 rd, vec3 c, float r, float y0, float y1, out float inner ) {
  vec2 o = ro.xz - c.xz, d = rd.xz;
  float a = max( dot( d, d ), 1e-6 ), b = dot( o, d ), cc = dot( o, o ) - r * r;
  float disc = b * b - a * cc;
  inner = 0.0;
  if ( disc < 0.0 ) return -1.0;
  float sq = sqrt( disc );
  float t0 = ( -b - sq ) / a, t1 = ( -b + sq ) / a;
  float y = ro.y + rd.y * t0;
  if ( t0 > 0.0 && y > y0 && y < y1 ) return t0;
  y = ro.y + rd.y * t1;
  if ( t1 > 0.0 && y > y0 && y < y1 ) { inner = 1.0; return t1; }
  return -1.0;
}

// Fixed fittings of a room. Shop types: 0 clothing 1 general 2 cafe 3 jewellery 4 pharmacy
// 5 shoes 6 books 7 flowers.
void fFittings( inout Hit h, inout float ao, vec3 ro, vec3 rd, vec3 ird, vec3 p, vec3 n, int mode, vec3 S, float seed, bool shop, bool stair, float st ) {
  vec3 f1 = fh3( seed * 31.0 + 1.0 ), f2 = fh3( seed * 53.0 + 2.0 );
  float cx = S.x * 0.5;
  if ( shop ) {
    if ( st < 0.5 ) {
      // clothing: island table, two garment rails mid-floor
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.65 + f1.x * 0.3, 0.0, 2.6 ), vec3( cx + 0.65 + f1.x * 0.3, 0.78, 3.4 ), vec3( 0.42, 0.34, 0.27 ) );
      vec3 r0 = vec3( S.x * 0.18, 0.0, 1.3 ), r1 = vec3( S.x * 0.82 - 1.2, 0.0, 1.7 + f2.x );
      fBoxT( h, ao, ro, ird, p, n, mode, r0 + vec3( 0.0, 0.8, 0.0 ), r0 + vec3( 1.2, 1.6, 0.42 ), vec3( 0.5, 0.48, 0.45 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, r0 + vec3( -0.03, 0.0, 0.19 ), r0 + vec3( 0.0, 1.66, 0.23 ), vec3( 0.06 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, r0 + vec3( 1.2, 0.0, 0.19 ), r0 + vec3( 1.23, 1.66, 0.23 ), vec3( 0.06 ) );
      if ( f1.z > 0.35 ) {
        fBoxT( h, ao, ro, ird, p, n, mode, r1 + vec3( 0.0, 0.8, 0.0 ), r1 + vec3( 1.2, 1.6, 0.42 ), vec3( 0.5, 0.48, 0.45 ) );
        fBoxT( h, ao, ro, ird, p, n, mode, r1 + vec3( -0.03, 0.0, 0.19 ), r1 + vec3( 0.0, 1.66, 0.23 ), vec3( 0.06 ) );
        fBoxT( h, ao, ro, ird, p, n, mode, r1 + vec3( 1.2, 0.0, 0.19 ), r1 + vec3( 1.23, 1.66, 0.23 ), vec3( 0.06 ) );
      }
    } else if ( st < 1.5 ) {
      // general goods: a gondola unit and the counter
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.35, 0.0, 1.6 + f1.y ), vec3( cx + 0.35, 1.45, 3.4 + f1.y ), vec3( 0.66, 0.64, 0.60 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( 0.9, 0.0, S.z - 1.6 ), vec3( 0.9 + 1.6, 0.95, S.z - 1.0 ), vec3( 0.36, 0.26, 0.18 ) );
    } else if ( st < 2.5 ) {
      // cafe / bakery: counter with a lit display, two tables
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x * 0.12, 0.0, S.z - 2.4 ), vec3( S.x * 0.88, 1.05, S.z - 1.75 ), vec3( 0.30, 0.20, 0.13 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x * 0.14, 1.05, S.z - 2.35 ), vec3( S.x * 0.55, 1.38, S.z - 1.95 ), vec3( 0.80, 0.66, 0.44 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x * 0.22, 0.72, 1.3 ), vec3( S.x * 0.22 + 0.7, 0.76, 2.0 ), vec3( 0.24, 0.16, 0.10 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x * 0.22 + 0.33, 0.0, 1.62 ), vec3( S.x * 0.22 + 0.37, 0.72, 1.68 ), vec3( 0.08 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x * 0.64, 0.72, 1.6 ), vec3( S.x * 0.64 + 0.7, 0.76, 2.3 ), vec3( 0.24, 0.16, 0.10 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x * 0.64 + 0.33, 0.0, 1.92 ), vec3( S.x * 0.64 + 0.37, 0.72, 1.98 ), vec3( 0.08 ) );
    } else if ( st < 3.5 ) {
      // jewellery / optics: display cases along the walls and in the window
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( 0.0, 0.0, 1.0 ), vec3( 0.55, 1.0, S.z - 1.0 ), vec3( 0.20, 0.14, 0.10 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x - 0.55, 0.0, 1.0 ), vec3( S.x, 1.0, S.z - 1.0 ), vec3( 0.20, 0.14, 0.10 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.5, 0.0, 0.5 ), vec3( cx + 0.5, 1.1, 0.95 ), vec3( 0.20, 0.14, 0.10 ) );
    } else if ( st < 4.5 ) {
      // pharmacy: counter at the back, a central gondola
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x * 0.2, 0.0, S.z - 2.2 ), vec3( S.x * 0.8, 1.0, S.z - 1.7 ), vec3( 0.84, 0.84, 0.82 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.35, 0.0, 1.4 ), vec3( cx + 0.35, 1.5, 2.8 ), vec3( 0.84, 0.84, 0.82 ) );
    } else if ( st < 5.5 ) {
      // shoes: low benches and a stepped central display
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.8, 0.0, 2.0 ), vec3( cx + 0.8, 0.45, 2.55 ), vec3( 0.25, 0.20, 0.17 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.45, 0.0, 0.7 ), vec3( cx + 0.45, 0.6, 1.2 ), vec3( 0.78, 0.76, 0.72 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.3, 0.6, 0.85 ), vec3( cx + 0.3, 1.0, 1.15 ), vec3( 0.78, 0.76, 0.72 ) );
    } else if ( st < 6.5 ) {
      // books: a table of new titles and the till
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.7, 0.0, 1.5 + f1.y * 0.5 ), vec3( cx + 0.7, 0.8, 2.4 + f1.y * 0.5 ), vec3( 0.30, 0.20, 0.13 ) );
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( S.x - 1.9, 0.0, S.z - 1.4 ), vec3( S.x - 0.6, 0.95, S.z - 0.9 ), vec3( 0.28, 0.19, 0.12 ) );
    } else {
      // flowers: buckets on the floor near the window, a work table
      for ( int i = 0; i < 4; i++ ) {
        vec3 b = fh3( seed * 7.0 + float( i ) * 3.3 );
        if ( mode == 0 ) fCylT( h, ro, rd, vec2( 0.5 + float( i ) * ( S.x - 1.0 ) / 3.0, 0.6 + b.x * 0.5 ), 0.17, 0.0, 0.42 + b.y * 0.15, GOODS[ int( b.z * 7.99 ) ] * 0.8 + 0.05 );
      }
      fBoxT( h, ao, ro, ird, p, n, mode, vec3( cx - 0.8, 0.0, S.z - 1.8 ), vec3( cx + 0.8, 0.9, S.z - 1.1 ), vec3( 0.40, 0.30, 0.20 ) );
    }
  } else if ( !stair ) {
    // sofa / bed / sideboard against the back wall, cabinet on a side wall, a table
    float len = 1.4 + f1.x * 0.9;
    vec3 a0 = vec3( mix( 0.2, S.x - len - 0.2, f1.y ), 0.0, S.z - 0.9 );
    fBoxT( h, ao, ro, ird, p, n, mode, a0, a0 + vec3( len, 0.72 + f1.z * 0.3, 0.9 ), FABRIC[ int( f1.z * 7.99 ) ] );
    float side = step( 0.5, f2.x );
    vec3 a1 = vec3( side * ( S.x - 0.5 ), 0.0, 0.9 + f2.y * 1.2 );
    fBoxT( h, ao, ro, ird, p, n, mode, a1, a1 + vec3( 0.5, 1.8 + f2.z * 0.4, 1.0 ), vec3( 0.20, 0.13, 0.08 ) * ( 0.7 + f2.z ) );
    vec3 a2 = vec3( cx - 0.6 + f2.y * 0.3, 0.72, 1.6 + f1.x * 0.8 );
    fBoxT( h, ao, ro, ird, p, n, mode, a2, a2 + vec3( 1.2, 0.04, 0.8 ), vec3( 0.28, 0.18, 0.11 ) );
    fBoxT( h, ao, ro, ird, p, n, mode, a2 + vec3( 0.55, -0.72, 0.35 ), a2 + vec3( 0.65, 0.0, 0.45 ), vec3( 0.22, 0.14, 0.09 ) );
  }
}

// ---- shelving with depth along a wall
// spec: (y0, y1, rowH, cellW) per shop type; y1 <= y0 means none on this wall
vec4 fShelfSpec( float st ) {
  if ( st < 0.5 ) return vec4( 1.78, 2.46, 0.34, 0.32 );   // clothing: folded stacks above the rails
  if ( st < 1.5 ) return vec4( 0.14, 2.22, 0.37, 0.12 );   // general goods
  if ( st < 2.5 ) return vec4( 1.45, 2.25, 0.40, 0.09 );   // cafe: jars and cups behind the counter
  if ( st < 3.5 ) return vec4( 0.0 );                      // jewellery: lit niches instead
  if ( st < 4.5 ) return vec4( 0.14, 2.22, 0.28, 0.075 );  // pharmacy
  if ( st < 5.5 ) return vec4( 0.25, 2.05, 0.31, 0.30 );   // shoes
  if ( st < 6.5 ) return vec4( 0.10, 2.36, 0.33, 0.036 );  // books
  return vec4( 0.25, 1.75, 0.50, 0.26 );                   // flowers: pots
}

// mean colour of a filled shelf row, for the far range
vec3 fItemMean( float st ) {
  return st > 5.5 && st < 6.5 ? vec3( 0.36, 0.28, 0.22 ) : st > 3.5 && st < 4.5 ? vec3( 0.62, 0.62, 0.60 ) : st > 6.5 ? vec3( 0.32, 0.36, 0.22 ) : vec3( 0.42, 0.36, 0.30 );
}
// tile (column, row) of product g in the goods atlas (goods.js) for shop type st
vec2 fGoodsTile( float g, float st ) {
  float v = floor( fract( g * 17.31 ) * 8.0 ), w = fract( g * 5.77 );
  float row = st < 0.5 ? 7.0
            : st < 1.5 ? ( w < 0.4 ? floor( w * 5.0 ) : w < 0.8 ? 2.0 + floor( ( w - 0.4 ) * 5.0 ) : 4.0 )
            : st < 2.5 ? 4.0
            : st < 4.5 ? ( w < 0.65 ? 5.0 : 1.0 ) : 6.0;
  return vec2( v, row );
}

// Goods on one shelf: the item at (a, y) above the board of row r, premultiplied
// (rgb · coverage, coverage); empty slots and the air between items are transparent.
// Products come from the goods atlas (printed cartons, bottles, shoes, folded clothes...),
// sampled at the level of detail of the pixel footprint fp (m); books and plants are
// painted here. keep fades the per-item detail to the row's mean colour.
vec4 fItem( float a, float y, float r, float rowH, float cellW, float seed, float st, float keep, float fp ) {
  float c = floor( a / cellW ), fa = fract( a / cellW );
  bool books = st > 5.5 && st < 6.5, plants = st > 6.5;
  // facings: runs of 2–4 identical products (books vary one by one)
  float run = books ? c : floor( ( c + floor( fh1( r * 3.7 + seed ) * 4.0 ) ) / ( 2.0 + floor( fh1( r + seed * 3.0 ) * 3.0 ) ) );
  float g = fh2( vec2( run, r ) + seed * 7.0 );
  float gi = fh2( vec2( c * 1.37, r + 9.0 ) + seed );
  float ih = rowH * ( books ? 0.62 + 0.3 * gi : 0.45 + 0.45 * g ) - 0.03;
  // gaps either side of the item, as a share of the cell
  float gl = cellW * ( books ? 0.1 : 0.03 + 0.12 * fract( g * 5.3 ) ), gr = cellW * ( books ? 0.1 : 0.03 + 0.12 * fract( g * 9.1 ) );
  float empty = step( fh2( vec2( c * 0.37, r * 1.3 ) + seed ), books ? 0.04 : 0.1 );
  float xa = fa * cellW, xb = cellW - xa;
  // far: a continuous band of the mean colour, ~70% of the row
  float hitFar = step( 0.0, y ) * step( y, rowH * ( books ? 0.8 : 0.62 ) );
  vec4 far = vec4( fItemMean( st ) * hitFar, hitFar );
  if ( keep <= 0.0 ) return far;
  vec4 res;
  if ( books || plants ) {
    vec3 col = books ? mix( GOODS[ int( gi * 7.99 ) ], vec3( 0.20, 0.14, 0.10 ), 0.45 ) * ( 0.6 + 0.5 * fh1( c * 0.71 + seed ) )
             : y > ih * 0.45 ? mix( vec3( 0.12, 0.30, 0.10 ), GOODS[ int( g * 7.99 ) ], step( 0.5, fract( a * 7.0 + y * 5.0 ) ) * 0.6 ) : vec3( 0.55, 0.28, 0.16 );
    // spines: a title block and gilt bands
    if ( books ) col = mix( col, col * 1.6 + 0.05, ( step( ih * 0.55, y ) * step( y, ih * 0.75 ) + step( ih * 0.9, y ) * step( y, ih * 0.93 ) ) * keep );
    float inX = books ? step( 0.003, xa ) * step( 0.003, xb ) : step( gl, xa ) * step( gr, xb );
    float hit = inX * step( y, ih ) * step( 0.0, y ) * ( 1.0 - empty );
    res = vec4( col * hit, hit );
  } else {
    float iw = max( cellW - gl - gr, 0.01 );
    vec2 uv = vec2( ( xa - gl ) / iw, y / ih );
    float inside = step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 ) * ( 1.0 - empty );
    vec2 tile = fGoodsTile( g, st );
    vec2 auv = vec2( tile.x + GOODS_PAD + clamp( uv.x, 0.0, 1.0 ) * ( 1.0 - 2.0 * GOODS_PAD ),
                     7.0 - tile.y + GOODS_PAD + clamp( uv.y, 0.0, 1.0 ) * ( 1.0 - 2.0 * GOODS_PAD ) ) / 8.0;
    float lod = log2( max( fp * 120.0 / min( iw, ih ), 1.0 ) );
    res = textureLod( uGoods, auv, lod ) * inside;
    // facings of one product differ a little (stock, light)
    res.rgb *= 0.88 + 0.22 * fh1( c * 0.71 + seed );
  }
  return mix( far, res, smoothstep( 0.0, 0.6, keep ) );
}

// Traces a shelving unit (boards every rowH from y0 to y1, projecting E from the wall)
// in front of the wall hit h.t with inward normal nW and along-wall axis aDir.
void fShelfUnit( inout Hit h, vec3 ro, vec3 rd, vec3 nW, vec3 aDir, float aMin, float aMax, vec4 spec, float seed, float st, vec3 frameC ) {
  const float E = 0.36, EG = 0.30, BT = 0.025;
  float y0 = spec.x, y1 = spec.y, rowH = spec.z, cellW = spec.w;
  float k = max( -dot( rd, nW ), 1e-3 );
  float tW = h.t;
  float tIn = max( tW - E / k, 0.0 );
  vec3 pIn = ro + rd * tIn;
  float aIn = dot( pIn, aDir );
  if ( aIn < aMin || aIn > aMax ) return;
  float yIn = pIn.y, yW = ro.y + rd.y * tW;
  if ( min( yIn, yW ) > y1 || yIn < y0 - 0.25 ) return;
  float fp = fFoot( tIn, rd, nW );
  float keepR = fKeep( fp, rowH * 0.5 );
  if ( yIn < y0 ) { h.t = tIn; h.n = nW; h.alb = frameC * 0.8; h.id = 2.0; return; }   // closed plinth
  float rIn = floor( ( yIn - y0 ) / rowH );
  // the unit's top
  if ( yIn > y1 ) {
    if ( rd.y >= 0.0 ) return;
    float tt = ( y1 - ro.y ) / rd.y;
    if ( tt < tW ) { h.t = tt; h.n = vec3( 0.0, 1.0, 0.0 ); h.alb = frameC; h.id = 2.0; }
    return;
  }
  if ( keepR <= 0.0 ) {
    // far: boards and goods as one averaged face
    h.t = tIn; h.n = nW; h.alb = mix( frameC * 0.45, fItemMean( st ), 0.62 ); h.id = 2.0;
    return;
  }
  // first board the ray meets inside the unit (top face looking down, underside looking up)
  float rW = floor( ( clamp( yW, y0, y1 - 1e-3 ) - y0 ) / rowH );
  float tB = 1e9; vec3 nB = vec3( 0.0, 1.0, 0.0 );
  float yRow = y0 + rIn * rowH;
  if ( yIn - yRow < BT ) { tB = tIn; nB = nW; }      // the board's front edge
  else if ( rIn != rW || yW > y1 || yW < y0 ) {
    float plane = rd.y < 0.0 ? yRow + BT : min( yRow + rowH, y1 );
    tB = ( plane - ro.y ) / rd.y;
    nB = vec3( 0.0, rd.y < 0.0 ? 1.0 : -1.0, 0.0 );
  }
  // goods: their fronts stand EG from the wall, blended over the board or back panel
  // behind them by their (filtered) silhouette
  float tG = tW - EG / k;
  vec4 it = vec4( 0.0 );
  if ( tG > tIn && tG < tB ) {
    vec3 pG = ro + rd * tG;
    float rG = floor( ( pG.y - y0 ) / rowH );
    float yy = pG.y - y0 - rG * rowH - BT;
    float fpG = fFoot( tG, rd, nW );
    it = fItem( dot( pG, aDir ), yy, rG, rowH, cellW, seed, st, keepR * fKeep( fpG, cellW ), fpG );
    // darker towards the board above
    it.rgb *= 0.55 + 0.45 * smoothstep( 0.0, 0.5 * rowH, rowH - BT - yy );
  }
  h.id = 2.0;
  if ( tB < tW ) { h.t = tB; h.n = nB; h.alb = frameC * ( nB.y < -0.5 ? 0.6 : 1.0 ); }
  else {
    // the unit's back panel, deep in the shelf's shadow
    float yy = yW - y0 - rW * rowH;
    h.alb = frameC * 0.42 * ( 0.6 + 0.4 * smoothstep( 0.0, rowH, rowH - yy ) );
  }
  h.alb = h.alb * ( 1.0 - it.a ) + it.rgb;
  if ( it.a > 0.5 ) { h.t = tG; h.n = nW; }
}

// ---- lighting helpers
// daylight through the window: disc form factor of the aperture seen from p (normal n)
float fWinFF( vec3 p, vec3 n, vec3 S, vec4 fac, float halfWin ) {
  vec3 wc = vec3( S.x * 0.5, 0.5 * ( fac.z + fac.w ), 0.0 );
  float A = 2.0 * halfWin * max( fac.w - fac.z, 0.1 );
  vec3 dv = wc - p;
  float d2 = dot( dv, dv ) + 1e-4;
  vec3 l = dv * inversesqrt( d2 );
  return A * max( dot( n, l ), 0.0 ) * max( -l.z, 0.0 ) / ( PI * d2 + A );
}
// darkening into the room's corners and edges (0.5 m), skipping the surface p lies on
float fCornerAO( vec3 p, vec3 n, vec3 S ) {
  vec3 b = S - p;
  float ao = 1.0;
  if ( n.x < 0.5 ) ao *= 0.55 + 0.45 * smoothstep( 0.0, 0.7, p.x );
  if ( n.x > -0.5 ) ao *= 0.55 + 0.45 * smoothstep( 0.0, 0.7, b.x );
  if ( n.y < 0.5 ) ao *= 0.6 + 0.4 * smoothstep( 0.0, 0.6, p.y );
  if ( n.y > -0.5 ) ao *= 0.65 + 0.35 * smoothstep( 0.0, 0.6, b.y );
  if ( n.z > -0.5 ) ao *= 0.55 + 0.45 * smoothstep( 0.0, 0.7, b.z );
  return ao * ( 0.8 + 0.2 * smoothstep( 0.0, 0.4, p.z ) );
}
// home lamp at lp (lk 0 pendant with an open-topped shade, 1 standing lamp): irradiance
// on (p, n) per unit intensity
float fLamp( vec3 p, vec3 n, vec3 lp, float lk ) {
  vec3 dl = p - lp;
  float d2 = max( dot( dl, dl ), 0.15 );
  vec3 w = dl * inversesqrt( d2 );
  float down = max( -w.y, 0.0 ), up = max( w.y, 0.0 );
  float I = lk < 0.5 ? 0.16 + 0.84 * down * down + 1.6 * pow( up, 5.0 ) : 0.28 + 0.5 * down + 1.3 * up * up;
  return I * max( dot( n, -w ), 0.0 ) / d2;
}
// recessed downlights on a grid (cell, in xz) under the ceiling, cos^ex lobes
float fDownlights( vec3 p, vec3 n, vec3 S, vec2 cell, float ex ) {
  vec2 i0 = floor( p.xz / cell - 0.5 );
  float E = 0.0;
  for ( int k = 0; k < 4; k++ ) {
    vec2 c = ( i0 + vec2( float( k & 1 ), float( k >> 1 ) ) + 0.5 ) * cell;
    vec3 dl = p - vec3( c.x, S.y - 0.02, c.y );
    float d2 = max( dot( dl, dl ), 0.06 );
    vec3 w = dl * inversesqrt( d2 );
    E += pow( max( -w.y, 0.0 ), ex ) * max( dot( n, -w ), 0.0 ) / d2;
  }
  return E;
}

// ---- the fake room. ro/rd in room space (rd.z > 0 goes into the room)
vec3 fRoom( vec3 ro, vec3 rd, vec3 S, vec4 win, vec4 fac, float halfWin, vec3 Eday, vec3 sunR, vec3 sunC ) {
  float seed = win.x;
  float kind = mod( win.w, 4.0 );
  bool shop = kind > 0.5 && kind < 1.5;
  bool stair = kind > 1.5;
  float st = shop ? floor( win.w / 8.0 + 0.01 ) : -1.0;
  vec3 ird = 1.0 / rd;
  vec3 tB = ( step( 0.0, rd ) * S - ro ) * ird;
  Hit h;
  h.t = min( min( tB.x, tB.y ), tB.z );
  h.glow = 0.0; h.id = 0.0;
  vec3 p = ro + rd * h.t;
  vec3 rnd = fh3( seed * 97.0 + 3.0 );
  vec3 wall = shop ? SHOPWALL[ int( st ) ] : stair ? vec3( 0.70, 0.66, 0.58 ) : WALLS[ int( rnd.x * 5.99 ) ];
  float daylum = dot( Eday, vec3( 0.2126, 0.7152, 0.0722 ) );
  // light fittings: shop downlight grid (pharmacy: broad panels) and home lamp
  vec2 cell = st > 3.5 && st < 4.5 ? vec2( 1.2, 1.5 ) : vec2( 1.1, 1.3 );
  float lk = step( 0.62, fh1( seed * 2.9 ) );
  vec3 lp = lk < 0.5 ? vec3( S.x * ( 0.42 + 0.16 * rnd.y ), S.y - 0.55, S.z * ( 0.42 + 0.16 * rnd.z ) )
                     : vec3( rnd.y < 0.5 ? 0.45 : S.x - 0.45, 1.45, S.z - 0.55 );

  float fpS = fFoot( h.t, rd, vec3( 0.0, 0.0, 1.0 ) );
  if ( h.t == tB.z ) {
    h.n = vec3( 0, 0, -1 );
    h.alb = wall * 0.94;
    float dx = mix( 0.3, S.x - 1.2, rnd.y );
    if ( !shop && p.x > dx && p.x < dx + 0.9 && p.y < 2.1 ) h.alb = vec3( 0.10, 0.09, 0.08 ); // doorway
    float px = mix( 0.4, S.x - 1.4, rnd.z );
    if ( !shop && !stair && p.x > px && p.x < px + 0.7 && p.y > 1.35 && p.y < 1.85 ) {
      vec3 pc = fh3( seed * 13.0 + 5.0 );
      float fr = ( p.x - px < 0.04 || px + 0.7 - p.x < 0.04 || p.y - 1.35 < 0.04 || 1.85 - p.y < 0.04 ) ? 1.0 : 0.0;
      h.alb = mix( pc * 0.5 + 0.1, vec3( 0.12, 0.09, 0.06 ), fr * fKeep( fpS, 0.08 ) + 0.25 * ( 1.0 - fKeep( fpS, 0.08 ) ) );
    }
    if ( stair ) h.alb *= 0.8 + 0.2 * fPulse( p.y / 0.17, 0.5, fpS / 0.17 ); // stair treads seen through the fanlight
  } else if ( h.t == tB.x ) {
    h.n = vec3( -sign( rd.x ), 0, 0 );
    h.alb = wall * 0.9;
  } else if ( rd.y > 0.0 ) {
    h.n = vec3( 0, -1, 0 );
    h.alb = vec3( 0.80, 0.79, 0.76 );
    if ( shop ) {
      float fpc = fFoot( h.t, rd, h.n );
      vec2 c = ( fract( p.xz / cell ) - 0.5 ) * cell;
      if ( st > 3.5 && st < 4.5 ) {
        // pharmacy: light panels
        float m = fEdge( 0.29 - abs( c.x ), fpc ) * fEdge( 0.3 - abs( c.y ), fpc );
        h.glow = m * 2.2;
      } else {
        // recessed downlights: a bright lamp in a white trim ring
        float r = length( c );
        h.glow = fEdge( 0.045 - r, fpc ) * 16.0 + fEdge( 0.075 - r, fpc ) * 0.8;
        h.glow = mix( h.glow, ( 16.0 * 0.00636 + 0.8 * 0.01767 ) / ( cell.x * cell.y ), 1.0 - fKeep( fpc, 0.4 ) );
      }
    }
  } else {
    h.n = vec3( 0, 1, 0 );
    float fpf = fFoot( h.t, rd, h.n );
    float ft = fh1( seed * 7.0 + 11.0 );
    if ( shop && ( st < 1.5 || st > 3.5 && st < 5.5 || st > 6.5 ) ) {
      // large stone or porcelain tiles
      vec2 g = p.xz / 0.6;
      vec2 e = abs( fract( g ) - 0.5 ) * 0.6;      // distance from the tile centre (m)
      float grout = max( fEdge( e.x - 0.29, fpf ), fEdge( e.y - 0.29, fpf ) );
      float tv = fh2( floor( g ) + seed * 3.0 );
      h.alb = mix( vec3( 0.58, 0.56, 0.52 ) * ( 0.92 + 0.12 * mix( 0.5, tv, fKeep( fpf, 0.6 ) ) ), vec3( 0.30, 0.29, 0.27 ), grout * fKeep( fpf, 0.05 ) + 0.03 * ( 1.0 - fKeep( fpf, 0.05 ) ) );
    } else if ( ft < 0.5 && !shop ) {
      // patterned cement tiles
      vec2 g = p.xz / 0.2;
      vec2 f = fract( g ) - 0.5;
      float keep = fKeep( fpf, 0.2 );
      float motif = step( length( f ), 0.32 ) * step( 0.5, fh2( floor( g * 0.5 ) + seed ) );
      h.alb = mix( vec3( 0.50, 0.46, 0.40 ), vec3( 0.30, 0.22, 0.18 ), mix( 0.16, motif * 0.6, keep ) );
      h.alb *= mix( 0.97, 0.85 + 0.15 * step( 0.04, min( abs( f.x ), abs( f.y ) ) ), keep );
    } else {
      // wooden boards
      vec2 g = vec2( p.x / 0.09, p.z / 0.6 + floor( p.x / 0.09 ) * 0.37 );
      float keep = fKeep( fpf, 0.09 );
      h.alb = vec3( 0.34, 0.22, 0.13 ) * ( 0.75 + 0.35 * mix( 0.5, fh2( floor( g ) ), keep ) );
    }
  }
  // skirting board and a little unevenness in the paint
  if ( abs( h.n.y ) < 0.5 ) {
    float fpw = fFoot( h.t, rd, h.n );
    h.alb *= 0.95 + 0.08 * vnoise( p.xy * 1.7 + p.z * 1.3 + seed * 40.0 );
    h.alb = mix( h.alb, h.alb * 0.55, fEdge( 0.1 - p.y, fpw ) * fKeep( fpw, 0.1 ) + 0.05 * ( 1.0 - fKeep( fpw, 0.1 ) ) );
  }

  // ---- shelving (with depth) on the walls of shops
  vec3 frameC = st > 5.5 && st < 6.5 || st > 1.5 && st < 2.5 ? vec3( 0.26, 0.17, 0.10 ) : st > 4.5 && st < 5.5 ? vec3( 0.40, 0.30, 0.22 ) : vec3( 0.76, 0.75, 0.72 );
  if ( shop ) {
    vec4 spec = fShelfSpec( st );
    if ( spec.y > spec.x ) {
      float sseed = seed * 5.0;
      if ( h.t == tB.x && !( st > 1.5 && st < 2.5 ) ) {
        fShelfUnit( h, ro, rd, h.n, vec3( 0.0, 0.0, 1.0 ), 0.35, S.z - 0.2, spec, sseed + h.n.x, st, frameC );
      } else if ( h.t == tB.z && ( st < 2.5 || st > 3.5 && st < 4.5 || st > 5.5 ) ) {
        // back wall: a lit feature panel in the middle for general goods and clothing
        bool panel = st < 1.5 && abs( p.x - S.x * 0.5 ) < 0.7 && p.y > ( st < 0.5 ? 0.6 : 1.2 ) && p.y < 2.3;
        if ( panel ) {
          // a backlit poster: an abstract photograph in two colours inside a thin dark frame
          vec2 q = p.xy * vec2( 1.0, 1.0 ) + seed * 31.0;
          vec3 c1 = GOODS[ int( fh1( seed * 3.0 ) * 7.99 ) ] * 0.8, c2 = mix( vec3( 0.62, 0.55, 0.48 ), GOODS[ int( fh1( seed * 5.0 ) * 7.99 ) ], 0.6 );
          float keep = fKeep( fp0( h.t, rd ), 0.3 );
          float img = mix( 0.5, vnoise( q * 2.2 ) * 0.7 + vnoise( q * 6.0 ) * 0.3, keep );
          h.alb = mix( c1, c2, smoothstep( 0.3, 0.7, img ) ) * ( 0.75 + 0.25 * mix( 0.5, vnoise( q * 11.0 ), keep ) );
          float fr = step( 0.66, abs( p.x - S.x * 0.5 ) ) + step( 2.26, p.y ) + step( p.y, st < 0.5 ? 0.64 : 1.24 );
          h.alb = mix( h.alb, vec3( 0.05 ), min( fr, 1.0 ) ); h.glow = 0.1 * ( 1.0 - min( fr, 1.0 ) );
        }
        else fShelfUnit( h, ro, rd, h.n, vec3( 1.0, 0.0, 0.0 ), 0.2, S.x - 0.2, spec, sseed + 0.5, st, frameC );
      }
    }
  }
  // ---- fittings (faded into the surface behind them, then skipped, as the window shrinks)
  float ao = 1.0;
  if ( gDet > 0.0 ) {
    vec3 albBehind = h.alb;
    fFittings( h, ao, ro, rd, ird, p, h.n, 0, S, seed, shop, stair, st );
    if ( !shop && !stair && lk > 0.5 ) fCylT( h, ro, rd, lp.xz, 0.014, 0.0, lp.y - 0.12, vec3( 0.06, 0.05, 0.045 ) );
    if ( h.id > 0.5 && h.id < 1.5 ) h.alb = mix( albBehind, h.alb, gDet );
  }
  p = ro + rd * h.t;
  vec3 nn = h.n;
  float fp = fFoot( h.t, rd, nn );

  // ---- merchandise patterns on room walls and fittings (faded out with the detail)
  if ( shop && h.glow == 0.0 && h.id < 1.5 && gDet > 0.0 ) {
    vec3 alb0 = h.alb;
    bool vert = abs( nn.y ) < 0.5;
    float along = abs( nn.x ) > 0.5 ? p.z : p.x;
    if ( vert ) {
      if ( st < 0.5 && p.y > 0.3 && p.y < 1.68 && ( abs( nn.x ) > 0.5 || h.id > 0.5 && h.alb.r > 0.3 ) ) {
        // garments hanging on rails, seen side-on: runs of the same piece in several sizes,
        // mostly neutral colours, rounded shoulders, uneven hems, soft folds
        const float PITCH = 0.055;
        float g = floor( along / PITCH ), fa = fract( along / PITCH );
        float run = floor( ( g + floor( fh1( seed * 3.0 ) * 4.0 ) ) / 4.0 );
        float rh = fh1( run * 1.71 + seed * 9.0 );
        vec3 gc = rh < 0.18 ? vec3( 0.035 ) : rh < 0.32 ? vec3( 0.72, 0.71, 0.68 ) : rh < 0.46 ? vec3( 0.55, 0.47, 0.36 )
                : rh < 0.58 ? vec3( 0.10, 0.15, 0.26 ) : rh < 0.68 ? vec3( 0.30, 0.30, 0.29 ) : GOODS[ int( fh1( run + 3.3 ) * 7.99 ) ] * 0.75;
        float keep = fKeep( fp, PITCH );
        float len = h.id > 0.5 ? 0.8 : 0.55 + 0.6 * fh1( run * 2.3 + seed );
        float top = 1.6 - 0.035 * 4.0 * fa * ( 1.0 - fa ) * keep;
        float hem = mix( 1.6 - len, 1.6 - len * ( 0.94 + 0.08 * fh1( g * 2.1 ) ), keep );
        float shade = mix( 0.82, 0.62 + 0.38 * sin( 3.14159 * fa ), keep ) * ( 1.0 + 0.05 * sin( p.y * 23.0 + g * 1.7 ) * fKeep( fp, 0.25 ) );
        float rail = fEdge( 0.012 - abs( p.y - 1.615 ), fp );
        if ( p.y > hem && p.y < top ) h.alb = gc * shade;
        else if ( h.id < 0.5 ) h.alb *= 0.55 + 0.45 * smoothstep( 0.0, 0.5, hem - p.y );
        h.alb = mix( h.alb, vec3( 0.25 ), rail );
      } else if ( st > 1.5 && st < 2.5 && nn.z < -0.5 && h.id < 0.5 && p.y > 2.25 && p.y < 2.75 && abs( p.x - S.x * 0.5 ) < S.x * 0.3 ) {
        // menu board above the shelves
        float keep = fKeep( fp, 0.06 );
        float txt = step( 0.55, fh2( floor( vec2( p.x / 0.05, p.y / 0.06 ) ) + seed ) ) * step( 0.2, fract( p.y / 0.06 ) );
        h.alb = mix( vec3( 0.04 ), vec3( 0.8, 0.78, 0.7 ), mix( 0.12, txt * 0.6, keep ) );
      } else if ( st > 2.5 && st < 3.5 && h.id < 0.5 ) {
        // dark panelled walls with small lit display niches
        vec2 nf = fract( vec2( along / 0.7, ( p.y - 1.25 ) / 0.45 ) );
        float keep = fKeep( fp, 0.35 );
        float niche = step( 1.25, p.y ) * step( p.y, 2.15 ) * step( 0.18, nf.x ) * step( nf.x, 0.82 ) * step( 0.18, nf.y ) * step( nf.y, 0.82 );
        niche = mix( 0.36 * step( 1.25, p.y ) * step( p.y, 2.15 ), niche, keep );
        h.alb = mix( h.alb * ( 0.9 + 0.1 * keep * step( 0.04, fract( along / 0.7 ) ) ), vec3( 0.62, 0.58, 0.52 ), niche );
        h.glow = 0.35 * niche;
      } else if ( h.id > 0.5 && h.id < 1.5 && ( st > 0.5 && st < 1.5 || st > 3.5 && st < 4.5 ) && p.y > 0.12 ) {
        // goods on the faces of gondola units
        vec4 spec = fShelfSpec( st );
        float r = floor( ( p.y - 0.12 ) / spec.z );
        float yy = p.y - 0.12 - r * spec.z - 0.025;
        float keep = fKeep( fp, spec.w );
        vec4 it = fItem( along, yy, r, spec.z, spec.w, seed * 3.0, st, keep, fp );
        h.alb = h.alb * 0.45 * ( 1.0 - 0.9 * it.a ) + 0.9 * it.rgb;
        if ( yy < 0.0 ) h.alb = frameC;
      }
    } else if ( nn.y > 0.5 && p.y > 0.3 && h.id > 0.5 ) {
      if ( st > 2.5 && st < 3.5 ) {
        // lit glass tops of the display cases, a few glints
        float keep = fKeep( fp, 0.035 );
        h.alb = vec3( 0.5 ); h.glow = 0.35 + mix( 0.018, 1.2 * step( 0.985, fh2( floor( p.xz / 0.035 ) + seed ) ), keep );
      } else {
        // goods on table tops
        float keep = fKeep( fp, 0.18 );
        float g = fh2( floor( p.xz / 0.18 ) + seed );
        h.alb = mix( h.alb, mix( vec3( 0.36, 0.30, 0.26 ), GOODS[ int( g * 7.99 ) ] * 0.6, keep ), mix( 0.45, step( 0.45, g ) * 0.8, keep ) );
      }
    }
    h.alb = mix( alb0, h.alb, gDet ); h.glow *= gDet;
  }

  // ---- lighting in room space
  ao *= fCornerAO( p, nn, S );
  if ( h.id < 0.5 && gDet > 0.0 ) {
    float aoF = 1.0;
    fFittings( h, aoF, ro, rd, ird, p, nn, 1, S, seed, shop, stair, st );
    ao *= mix( 1.0, aoF, gDet );
  }
  float A = 2.0 * halfWin * max( fac.w - fac.z, 0.1 );
  float Aroom = 2.0 * ( S.x * S.y + S.x * S.z + S.y * S.z );
  // daylight through the aperture: the window sees mostly the street canyon (opposite
  // facades, paving), well below the open-sky irradiance on the glass; walls and ceiling
  // darken upwards and into the corners
  float up = abs( nn.y ) < 0.5 ? mix( 1.0, 0.6, smoothstep( 0.8, S.y, p.y ) ) : nn.y < -0.5 ? 0.7 : 1.0;
  vec3 E = Eday * CANYON * ( 1.15 * fWinFF( p, nn, S, fac, halfWin ) + 0.9 * A / Aroom + 0.006 ) * ao * up;
  // sun patch: project the point back to the window plane along the sun direction
  if ( sunR.z < -0.05 ) {
    float tw = -p.z / sunR.z;
    vec2 q = p.xy + sunR.xy * tw;
    float pen = 0.01 + 0.012 * tw;
    float inX = fEdge( halfWin - abs( q.x - S.x * 0.5 ), pen );
    float inY = fEdge( q.y - fac.z, pen ) * fEdge( fac.w - q.y, pen );
    E += sunC * inX * inY * max( dot( nn, sunR ), 0.0 ) * 0.72;
  }
  // artificial light, colour by kind: homes 2700–4000 K by room (shared with the reveal
  // spill), cafes ~2500 K, shops 3000–3500 K, pharmacies cool
  float litT = uNight * LIT_SHARE;
  float lit = 1.0 - smoothstep( litT - 0.03, litT + 0.03, win.y );
  if ( win.y < 0.035 ) lit = max( lit, 0.6 ); // a few rooms with the lights on during the day
  bool tv = !shop && !stair && fRoomTV( win.y ) > 0.5;
  vec3 lampC = ( stair ? vec3( 1.0, 0.62, 0.33 ) : fRoomLampC( win.y ) * fRoomLevel( win.y ) ) * gEm;
  float Ih = stair ? 0.006 : tv ? 0.0025 : 0.024;
  vec3 Elamp = vec3( 0.0 );
  float glowK = 0.0;
  if ( shop ) {
    lampC = st > 3.5 && st < 4.5 ? vec3( 0.93, 0.95, 1.0 ) : st > 1.5 && st < 2.5 ? vec3( 1.0, 0.58, 0.29 )
          : mix( vec3( 1.0, 0.70, 0.43 ), vec3( 1.0, 0.64, 0.36 ), step( 0.5, fh1( seed * 5.1 ) ) );
    // shops are lit all day; seen from the daylit street the warm light reads less orange
    lampC = mix( lampC, vec3( 1.0, 0.86, 0.72 ), 0.45 * ( 1.0 - uNight ) ) * gEm;
    float I = mix( SHOP_DAY * daylum * ( 0.7 + 0.6 * fh1( seed * 8.3 ) ), 0.0035, uNight ) * ( st > 2.5 && st < 3.5 ? 0.75 : 1.0 );
    float ex = st > 3.5 && st < 4.5 ? 2.0 : st > 2.5 && st < 3.5 ? 14.0 : 8.0;
    // downlight pools, the inter-reflected fill (falling off up the walls: the light goes
    // down onto the floor and the goods) and display spots on the low window zone
    float fill = 0.42 * mix( 1.0, 0.45, smoothstep( 0.9, S.y, p.y ) ) + 0.5 * smoothstep( 2.2, 0.4, p.z ) * ( 1.0 - smoothstep( 0.7, 2.0, p.y ) );
    Elamp = lampC * I * ( fDownlights( p, nn, S, cell, ex ) * ( 0.75 + 0.25 * ao ) + fill * ao );
    glowK = I;
  } else if ( lit > 0.0 ) {
    Elamp = lampC * lit * Ih * ( fLamp( p, nn, lp, lk ) * ( 0.7 + 0.3 * ao ) + 0.035 * ao );
    if ( tv ) {
      // lit by a television on the side wall: cool, flickering with the picture
      vec3 tp = vec3( rnd.y < 0.5 ? S.x - 0.1 : 0.1, 0.95, S.z * 0.55 );
      Elamp += fTVLight( win.y, uTime ) * gEm * lit * 0.006 * ( fLamp( p, nn, tp, 1.0 ) * ( 0.6 + 0.4 * ao ) + 0.03 * ao );
    }
    glowK = Ih * lit;
  }
  vec3 col = h.alb * ( E + Elamp ) * RECIPROCAL_PI + h.glow * lampC * glowK;

  // visible lamps: the fabric shade (open cylinder) glows when lit, brighter inside
  if ( !shop && !stair && gDet > 0.0 ) {
    float r = lk < 0.5 ? 0.2 : 0.17, inner;
    float tl = fShade( ro, rd, lp, r, lp.y - 0.13, lp.y + 0.07, inner );
    if ( tl > 0.0 && tl < h.t ) {
      vec3 shadeDay = vec3( 0.62, 0.56, 0.46 ) * Eday * ( 0.06 + 0.05 * inner ) * RECIPROCAL_PI;
      col = mix( col, shadeDay + lampC * lit * Ih * ( inner > 0.5 ? 6.0 : 1.2 ), gDet );
    }
  }
  // cafe pendants
  if ( shop && st > 1.5 && st < 2.5 && gDet > 0.0 ) {
    for ( int i = 0; i < 3; i++ ) {
      vec3 lq = vec3( S.x * ( 0.25 + 0.25 * float( i ) ), S.y - 0.9, 1.6 + float( i ) * 0.4 );
      float tl = dot( lq - ro, rd );
      float fpl = gPA * ( gTC + tl );
      if ( tl > 0.0 && tl < h.t ) col += lampC * fEdge( 0.09 - length( ro + rd * tl - lq ), fpl ) * glowK * 12.0 * gDet;
    }
  }

  // ---- drapes just behind the glass (translucent: lit from the street side by day, glowing
  // warm from the room's lamp at night)
  float dtype = floor( win.z ), damt = fract( win.z );
  if ( dtype > 0.5 && rd.z > 1e-3 ) {
    float zc = 0.12;
    float tc = ( zc - ro.z ) / rd.z;
    if ( tc > 0.0 && tc < h.t ) {
      vec2 c = ro.xy + rd.xy * tc;
      float fpc = gPA * ( gTC + tc ) / max( rd.z, 0.25 );
      float xr = c.x - S.x * 0.5;
      vec3 dc = DRAPES[ int( fh1( seed * 4.1 ) * 5.99 ) ];
      vec3 pc = vec3( c, zc );
      vec3 back = lit > 0.0 ? lampC * lit * Ih * ( fLamp( pc, vec3( 0.0, 0.0, 1.0 ), lp, lk ) + 0.035 ) : vec3( 0.0 );
      vec3 front = Eday * 0.45;
      if ( dtype < 1.5 ) {
        // curtains drawn to the sides
        float cover = halfWin * ( 1.0 - damt );
        if ( abs( xr ) > cover ) {
          float fold = 0.72 + 0.28 * sin( c.x * 38.0 + seed * 20.0 ) * sin( c.x * 11.0 ) * fKeep( fpc, 0.17 );
          col = dc * fold * ( front + back * 0.35 ) * RECIPROCAL_PI;
        }
      } else if ( dtype < 2.5 ) {
        // sheers: the room shows through, softened
        float fold = 0.8 + 0.2 * sin( c.x * 45.0 + seed * 10.0 ) * fKeep( fpc, 0.14 );
        vec3 sheer = vec3( 0.84, 0.83, 0.78 ) * fold * ( front * 0.7 + back * 0.6 ) * RECIPROCAL_PI;
        col = mix( col, sheer, 0.5 + 0.25 * damt );
      } else if ( dtype < 3.5 ) {
        // roller blind
        float edge = mix( fac.w, fac.z, damt );
        if ( c.y > edge ) col = dc * ( front * 0.8 + back * 0.35 ) * RECIPROCAL_PI * mix( 1.0, 0.6, fEdge( 0.04 - ( c.y - edge ), fpc ) );
      } else {
        // venetian blind: 5 cm slats, box filtered
        float edge = mix( fac.w, fac.z, damt );
        if ( c.y > edge ) {
          float slat = fPulse( c.y / 0.05, 0.35, fpc / 0.05 );
          vec3 sc = vec3( 0.72, 0.71, 0.67 ) * ( front * 0.7 + back * 0.3 ) * RECIPROCAL_PI * mix( 0.9, 0.8 + 0.2 * fract( c.y / 0.05 ), fKeep( fpc, 0.05 ) );
          col = mix( col, sc, slat );
        }
      }
    }
  }
  return col;
}

// Reflection of the street, traced against a stand-in of its far side: the opposite
// facade row at streetW (buildings of varied height and stone, a shop band of dark glass
// under awnings, storeys of windows with dark glass, curtains or shutters, iron balconies,
// cornice shadows, the sun / shade line cast by this side's roofs), the paving and both
// rows of street trees. Being traced, it is parallax-correct for every pixel. Each pattern
// is box-filtered over the pixel's footprint on the far facade, which grows as 1 / cos
// towards grazing angles: there the bays and buildings average out while the storeys,
// cornices and the roofline against the sky still read, as in a real shop window seen
// along the street. Returns rgb + coverage (0 = sky).
vec4 fStreetBg( vec3 R, vec3 N, vec3 T, vec3 P, float baseH, float streetW, vec3 Eamb, vec3 sky, out float tHit ) {
  float rn = max( dot( R, N ), 0.02 );
  float tO = streetW / rn;
  float hy = baseH + R.y * tO;
  float hx = dot( P, T ) + dot( R, T ) * tO;
  vec3 sunC = uSunColor * step( 0.0, uSunDir.y );
  vec3 col;
  // ground: sidewalks, the darker track corridor down the middle, and the shadow cast
  // across the street by the roofs on the sun's side (~18 m)
  if ( R.y < 0.0 && baseH / -R.y < tO ) {
    float tg = baseH / -R.y;
    vec2 gp = P.xz + R.xz * tg;
    float acr = rn * tg, fpG = gPA * ( gTC + tg ) / max( -R.y, 0.05 );
    float gx = dot( P, T ) + dot( R, T ) * tg;
    float sy = max( uSunDir.y, 0.03 ), sn = dot( uSunDir, N );
    float roof = 18.0 + 4.0 * ( vnoise( vec2( gx / 13.0, 0.5 ) ) - 0.5 );
    float shadeL = sn < 0.0 ? roof * -sn / sy - acr : roof * sn / sy - ( streetW - acr );
    float sunG = 1.0 - smoothstep( -0.3 - fpG, 0.3 + fpG, shadeL );
    float sh = ( 0.6 + 0.4 * vnoise( gp * 0.15 ) ) * sunG;
    vec3 E = Eamb + sunC * max( uSunDir.y, 0.0 ) * sh;
    float trk = 1.0 - smoothstep( 3.2 - fpG, 3.6 + fpG, abs( acr - streetW * 0.5 ) );
    col = mix( vec3( 0.29, 0.28, 0.26 ), vec3( 0.2, 0.2, 0.2 ), trk ) * E * RECIPROCAL_PI;
    tHit = tg;
    return vec4( mix( col, sky, 1.0 - exp( -tg / 900.0 ) ), 1.0 );
  }
  tHit = tO;
  // footprint of the pixel on the far facade: up it, and along it (1 / cos at grazing);
  // never sharper than the slight waviness of real glass blurs the reflection
  float fpY = max( gPA * ( gTC + tO ), 0.02 + 0.004 * tO );
  float fpX = fpY / rn;
  // buildings ~13 m wide: their height, stone, storey height and dressing
  float kB = 1.0 - smoothstep( 3.0, 9.0, fpX );
  float bid = floor( hx / 13.0 );
  vec3 b1 = fh3( bid * 1.37 + 0.5 ), b2 = fh3( bid * 2.91 + 7.0 );
  float roofH = mix( 19.0, 15.0 + 8.0 * b1.x, kB );
  float soft = fpY + ( 1.0 - kB ) * 3.5;
  float cov = 1.0 - smoothstep( roofH - soft, roofH + soft, hy );
  vec3 stone = mix( vec3( 0.54, 0.48, 0.38 ), mix( vec3( 0.47, 0.42, 0.34 ), vec3( 0.62, 0.56, 0.45 ), b1.y ), kB );
  float fh = mix( 3.6, 3.3 + 0.6 * b1.z, kB ), g0 = mix( 4.6, 4.2 + 0.8 * b2.x, kB );
  // sun on the far facade above the shadow line of this side's roofs (~16–22 m)
  float sN = dot( uSunDir, -N );
  float lit = 0.0;
  if ( sN > 0.02 ) {
    float tS = streetW / sN;
    float ourRoof = 16.0 + 6.0 * fh1( floor( ( hx - dot( uSunDir, T ) * tS ) / 13.0 ) * 1.91 + 3.0 );
    lit = smoothstep( -0.4 - fpY, 0.4 + fpY, hy + uSunDir.y * tS - ourRoof ) * sN;
  }
  vec3 E = Eamb * 0.9 + sunC * lit;
  // storeys above the shop band: window columns every 3.4 m, sill to head 22–82% of a storey
  float fy = ( hy - g0 ) / fh;
  float wy = ( fPulse( fy, 0.22, fpY / fh ) - fPulse( fy, 0.82, fpY / fh ) ) * step( 0.0, fy );
  float wxW = fpX / 3.4;
  float wx = fPulse( hx / 3.4 + 0.5 * b2.y, 0.3, wxW ) - fPulse( hx / 3.4 + 0.5 * b2.y, 0.7, wxW );
  // cornice / string course shadow just under each storey line, balcony slab and railing
  float cor = fPulse( fy, 0.93, fpY / fh ) * step( 1.0, fy );
  float balc = step( 0.5, b2.z ) * kB;
  float rail = balc * ( fPulse( fy, 0.0, fpY / fh ) - fPulse( fy, 0.27, fpY / fh ) ) * step( 1.0, fy ) * mix( 0.35, 1.0, kB );
  col = stone * E * RECIPROCAL_PI * ( 1.0 - 0.45 * cor );
  // what the windows show: dark glass mirroring the sky, curtains, painted shutters
  vec2 cell = floor( vec2( hx / 3.4 + 0.5 * b2.y, fy ) );
  float wk = fh2( cell + 11.0 + bid );
  float kW = 1.0 - smoothstep( 0.3, 0.6, wxW );
  vec3 winAlb = mix( vec3( 0.12, 0.12, 0.12 ), wk < 0.45 ? vec3( 0.05, 0.055, 0.06 ) : wk < 0.7 ? vec3( 0.45, 0.42, 0.37 )
              : mix( vec3( 0.11, 0.2, 0.14 ), vec3( 0.28, 0.2, 0.13 ), step( 0.5, b1.y ) ), kW );
  float litW = step( fh2( cell + 5.0 ), uNight * 0.5 ) * kW + uNight * 0.25 * ( 1.0 - kW );
  vec3 winC = winAlb * E * RECIPROCAL_PI * 0.8 + sky * 0.08 * ( 1.0 - step( 0.45, wk ) * kW ) + litW * vec3( 1.0, 0.62, 0.32 ) * 0.0012 * gEm;
  col = mix( col, winC, wx * wy * 0.9 );
  col = mix( col, vec3( 0.03, 0.03, 0.032 ) * E * RECIPROCAL_PI, rail * 0.75 );
  // shop band: dark display glass between stone piers, awnings over some
  float sb = fPulse( hy / 4.0, 0.0, fpY / 4.0 ) - fPulse( hy / 4.0, ( g0 - 0.6 ) / 4.0, fpY / 4.0 );
  sb *= step( 0.0, hy ) * step( hy, g0 );
  float px = fPulse( hx / 4.3, 0.18, fpX / 4.3 ) - fPulse( hx / 4.3, 0.86, fpX / 4.3 );
  float shopI = fh1( floor( hx / 4.3 ) * 3.1 + 2.0 );
  vec3 shopC = vec3( 0.07, 0.07, 0.075 ) * E * RECIPROCAL_PI + sky * 0.05 + vec3( 1.0, 0.74, 0.48 ) * 0.0016 * uNight * gEm;
  col = mix( col, shopC, sb * px * 0.9 );
  float aw = ( fPulse( hy, g0 - 1.35, fpY ) - fPulse( hy, g0 - 0.55, fpY ) ) * px * step( 0.55, shopI ) * kW;
  vec3 awC = fh1( shopI * 7.0 ) < 0.5 ? vec3( 0.62, 0.55, 0.40 ) : fh1( shopI * 9.0 ) < 0.5 ? vec3( 0.14, 0.24, 0.16 ) : vec3( 0.36, 0.11, 0.1 );
  col = mix( col, awC * ( Eamb * 0.7 + sunC * lit * 0.8 ) * RECIPROCAL_PI, aw );
  // street trees: the far side's row before its facades, then this side's row
  for ( int k = 0; k < 2; k++ ) {
    float tT = ( streetW * 0.5 + ( k == 0 ? 5.2 : -5.2 ) ) / rn;
    if ( tT <= 0.0 ) continue;
    float ty = baseH + R.y * tT;
    float tx = dot( P, T ) + dot( R, T ) * tT;
    // soft, out-of-focus crowns: a band with gentle density variation, trunks below
    float crown = smoothstep( 2.6, 3.8, ty ) * smoothstep( 8.4, 5.8, ty );
    float fpT = gPA * ( gTC + tT ) / rn;
    float dens = mix( 0.42, 0.3 + 0.35 * vnoise( vec2( tx * 0.35, ty * 0.6 ) + float( k ) * 9.0 ), 1.0 - smoothstep( 1.0, 4.0, fpT ) );
    float gap = mix( 0.75, smoothstep( 0.0, 0.25, fract( tx / 10.0 + 0.1 ) ) * smoothstep( 1.0, 0.8, fract( tx / 10.0 + 0.1 ) ), 1.0 - smoothstep( 2.0, 6.0, fpT ) );
    float tree = crown * dens * gap;
    vec3 leaf = vec3( 0.07, 0.10, 0.05 ) * ( Eamb + sunC * 0.35 ) * RECIPROCAL_PI;
    // composite over (facade, coverage)
    float nc = cov + tree * ( 1.0 - cov );
    col = ( cov * ( 1.0 - tree ) * col + tree * leaf ) / max( nc, 1e-4 );
    cov = nc;
  }
  // aerial perspective along long grazing paths
  col = mix( col, sky, 1.0 - exp( -tO / 900.0 ) );
  return vec4( col, cov );
}

// The street with what stands in it between the glass and its far side, nearest first:
// the tree trunks and poles of both sides and people on the far sidewalk (dark verticals
// against the paving and the facades; filtered to their mean density once sub-pixel).
vec4 fStreet( vec3 R, vec3 N, vec3 T, vec3 P, float baseH, float streetW, vec3 Eamb, vec3 sky ) {
  float tHit;
  vec4 bg = fStreetBg( R, N, T, P, baseH, streetW, Eamb, sky, tHit );
  float rn = max( dot( R, N ), 0.02 );
  vec3 E = Eamb * 0.8 + uSunColor * step( 0.0, uSunDir.y ) * 0.3;
  float hw = streetW * 0.5;
  vec3 acc = vec3( 0.0 );
  float tr = 1.0;
  // (no people on this side: right in front of the glass they would loom over the real ones)
  for ( int k = 2; k < 8; k++ ) {
    float c = k == 2 ? hw - 5.15 : k == 3 ? hw - 3.95 : k == 4 ? hw + 3.95 : k == 5 ? hw + 5.15 : k == 6 ? streetW - 3.9 : streetW - 1.8;
    float tc = c / rn;
    if ( tc >= tHit ) break;
    float yc = baseH + R.y * tc;
    if ( yc < 0.0 || yc > 7.0 ) continue;
    float xc = dot( P, T ) + dot( R, T ) * tc;
    float fy = max( gPA * ( gTC + tc ), 0.01 + 0.003 * tc ), fx = fy / rn;
    float cover;
    vec3 alb;
    if ( k > 5 ) {
      // people 1.5–1.9 m tall in ~1.1 m slots, a third of them taken: legs, torso, head
      float u = xc / 1.1 + float( k ) * 0.37, cid = floor( u );
      vec3 hp = fh3( cid * 1.913 + float( k ) * 17.0 );
      float hgt = 1.5 + 0.4 * hp.y, yr = yc / hgt;
      float du = abs( u - cid - 0.5 - ( hp.z - 0.5 ) * 0.3 ) * 1.1;
      float wh = yr > 0.87 ? 0.085 : yr > 0.47 ? 0.2 + 0.03 * hp.z : 0.16;
      float body = fEdge( wh - du, fx ) * step( hp.x, 0.33 ) * ( 1.0 - smoothstep( 1.0 - fy / hgt, 1.0 + fy / hgt, yr ) );
      if ( yr < 0.45 ) body *= 1.0 - 0.8 * fEdge( 0.035 - du, fx );
      float kp = 1.0 - smoothstep( 0.5, 1.5, fx / 1.1 );
      cover = mix( 0.33 * 0.34 * ( 1.0 - smoothstep( 1.6, 1.8, yc ) ), body, kp );
      vec3 cl = fh3( cid * 7.1 + float( k ) + step( 0.47, yr ) * 3.0 );
      alb = mix( vec3( 0.12, 0.11, 0.1 ), mix( vec3( dot( cl, vec3( 0.33 ) ) ), cl, 0.45 ) * 0.42 + 0.03, kp );
    } else if ( k == 2 || k == 5 ) {
      cover = fPulse( xc / 10.0 + 0.1, 0.975, fx / 10.0 ) * step( yc, 2.8 );   // tree trunks
      alb = vec3( 0.12, 0.1, 0.08 );
    } else {
      cover = fPulse( xc / 31.0 + 0.3, 0.9935, fx / 31.0 ) * step( yc, 6.6 );  // poles
      alb = vec3( 0.12, 0.13, 0.13 );
    }
    acc += tr * cover * alb * E * RECIPROCAL_PI;
    tr *= 1.0 - cover;
  }
  float a = 1.0 - tr * ( 1.0 - bg.a );
  return vec4( ( acc + tr * bg.a * bg.rgb ) / max( a, 1e-4 ), a );
}
`;

// Injected after lights_fragment_maps: replaces the sky-only reflection by the street
// model, and computes the transmitted interior.
const FRAG_LIGHT = /* glsl */`
#include <lights_fragment_maps>
vec3 fInterior = vec3( 0.0 );
float fNoGlass = step( 3.5, mod( vWin.w, 8.0 ) );
float fGlass = ( 1.0 - fNoGlass ) * ( 1.0 - fMask );
if ( fMask < 0.999 ) {
  float ang = vFac.x;
  vec3 T = vec3( cos( ang ), 0.0, sin( ang ) );
  vec3 N = vec3( -T.z, 0.0, T.x );
  vec3 Vw = normalize( vFW - cameraPosition );
  vec3 Nw = inverseTransformDirection( normal, viewMatrix );
  vec3 R = reflect( Vw, Nw );
  vec3 Eamb = irradiance + iblIrradiance;
  // sky radiance: environment when available, else a simple gradient from the ambient light
  vec3 skyFallback = Eamb * RECIPROCAL_PI * mix( vec3( 1.15, 1.12, 1.08 ), vec3( 0.75, 0.9, 1.25 ), clamp( R.y, 0.0, 1.0 ) ) * 1.4;
  #if defined( USE_ENVMAP )
    vec3 skyR = radiance;
  #else
    vec3 skyR = skyFallback;
  #endif
  float streetW = floor( vFac.y ), rec = fract( vFac.y );
  vec4 st = fStreet( R, N, T, vFW, vRoomS.w + vRoomP.y, streetW, Eamb, skyR );
  radiance = mix( skyR, st.rgb, st.a );
  // the reveal around a recessed window hides most of the street at grazing angles:
  // follow the reflected ray out of the recess and see whether it clears the opening
  {
    vec3 Rl = vec3( dot( R, T ), R.y, dot( R, N ) );
    // shopfront glass sits nearly flush with its frame: only the casing shades it
    float shopK = abs( mod( vWin.w, 4.0 ) - 1.0 ) < 0.5 ? 0.3 : 1.0;
    float depth = ( rec + vRoomP.z + 0.015 ) * shopK;
    float tOut = depth / max( Rl.z, 0.02 );
    vec2 e = vec2( vRoomP.x - vRoomS.x * 0.5, vRoomP.y - vFac.z ) + Rl.xy * tOut;
    float hh = vFac.w - vFac.z;
    float soft = 0.02 + 0.03 * tOut;
    float inside = smoothstep( -soft, soft, vRoomP.w - abs( e.x ) ) * smoothstep( -soft, soft, e.y ) * smoothstep( -soft, soft, hh - e.y );
    vec3 stoneR = vec3( 0.56, 0.50, 0.41 ) * Eamb * RECIPROCAL_PI * ( e.y < 0.0 ? 0.8 : 0.55 );
    radiance = mix( stoneR, radiance, inside );
  }
  // a faint film of dust and smudges dims and greys the reflection a little; both faces of
  // the pane reflect, ~2F / (1 + F) of what the single-face BRDF applies
  float fNVr = saturate( dot( normal, normalize( vViewPosition ) ) );
  radiance *= fSmudge * 2.0 / ( 1.04 + 0.96 * pow( 1.0 - fNVr, 5.0 ) );

  // interior: camera ray expressed in room space
  vec3 rd = vec3( dot( Vw, T ), Vw.y, -dot( Vw, N ) );
  rd.z = max( rd.z, 1e-3 );
  rd.x = abs( rd.x ) < 1e-4 ? 1e-4 : rd.x;
  rd.y = abs( rd.y ) < 1e-4 ? 1e-4 : rd.y;
  vec3 sunR = vec3( dot( uSunDir, T ), uSunDir.y, -dot( uSunDir, N ) );
  vec3 ro = clamp( vRoomP.xyz, vec3( 0.001 ), vRoomS.xyz - 0.001 );
  fInterior = fRoom( ro, rd, vRoomS.xyz, vWin, vFac, vRoomP.w, Eamb, sunR, uSunColor * step( 0.0, uSunDir.y ) );
  // glass transmits ~90%
  fInterior *= mix( 1.0, 0.9, fGlass );
  if ( fGlass < 0.5 && fMask < 0.5 ) radiance = vec3( 0.0 );
  fInterior *= 1.0 - fMask;
}
`;

const FRAG_OUT = /* glsl */`
float fNV = saturate( dot( normal, normalize( vViewPosition ) ) );
float fF = 0.04 + 0.96 * pow( 1.0 - fNV, 5.0 );
// transmission through both faces of the pane: (1 - F)^2
float fT = 1.0 - fF * fGlass;
vec3 outgoingLight = ( totalDiffuse + totalSpecular ) * max( fGlass, fMask ) + totalEmissiveRadiance + fInterior * fT * fT;
`;

// per-pane tilt and old-glass waviness, applied to the shading normal
const FRAG_NORMAL = /* glsl */`
#include <normal_fragment_maps>
{
  float leaf = step( vRoomS.x * 0.5, vRoomP.x ) + step( vFac.w - 0.02, vRoomP.y ) * 2.0;
  vec3 j = ( fh3( vWin.x * 61.0 + leaf * 7.0 ) - 0.5 ) * 0.022;
  if ( gDet > 0.0 && mod( vWin.w, 4.0 ) < 0.5 ) {
    // old-glass waviness in the homes' windows (sub-pixel once the window is small; shop
    // glass is float glass)
    j.x += ( vnoise( vec2( vRoomP.x * 3.0, vRoomP.y * 9.0 ) + vWin.x * 50.0 ) - 0.5 ) * 0.006 * gDet;
    j.y += ( vnoise( vec2( vRoomP.y * 4.0, vRoomP.x * 2.0 ) + 9.0 ) - 0.5 ) * 0.004 * gDet;
  }
  vec3 jv = ( viewMatrix * vec4( j.x, j.y, j.z, 0.0 ) ).xyz;
  normal = normalize( normal + jv * ( 1.0 - step( 3.5, mod( vWin.w, 8.0 ) ) ) );
}
`;

// Far range (lod 1): the casing, sill rail and central meeting stile are drawn here
// instead of as geometry. fMask = 1 on the painted frame. Also the smudge film.
const FRAG_FRAME = /* glsl */`
#include <color_fragment>
// pixel footprint for the filtering and the detail switch (derivatives taken here, before
// any branching)
gTC = length( vViewPosition );
gPA = max( length( fwidth( normalize( vViewPosition ) ) ) * 0.75, 1e-5 );
gDet = 1.0 - smoothstep( 0.06, 0.11, gPA * gTC );
gEm = mix( 1.0, uEmGain, uNight );
float fMask = 0.0;
if ( vFrame.a > 0.5 ) {
  float x = vRoomP.x - vRoomS.x * 0.5, y = vRoomP.y - vFac.z;
  float hw = vRoomP.w, hh = vFac.w - vFac.z;
  float d = min( min( hw - abs( x ), y ), hh - y );
  float aa = fwidth( x ) * 0.75;
  fMask = 1.0 - smoothstep( 0.075 - aa, 0.075 + aa, d );
  if ( hw > 0.38 ) fMask = max( fMask, 1.0 - smoothstep( 0.045 - aa, 0.045 + aa, abs( x ) ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vFrame.rgb, fMask );
}
// low-frequency smudges and drip marks: rougher, slightly dimmer reflections in patches
float fSm = smoothstep( 0.45, 0.85, vnoise( vec2( vRoomP.x * 2.2, vRoomP.y * 1.6 ) + vWin.x * 37.0 ) )
  + 0.5 * smoothstep( 0.6, 0.95, vnoise( vec2( vRoomP.x * 9.0, vRoomP.y * 0.8 ) + vWin.x * 11.0 ) ) * smoothstep( 1.2, 0.0, vRoomP.y - vFac.z );
float fSmudge = 1.0 - 0.12 * fSm;
`;

/**
 * far: variant for lod 1 chunks, pulled towards the camera in depth (polygon offset) so
 * the thin glass never loses against the buildings' back plate at 200–680 m. Both share
 * one program (the offset is render state).
 */
export function createInteriorGlass(M, { far = false } = {}) {
  const gain = (M && M.uniforms && M.uniforms.emissiveGain) || { value: 1 };
  const goods = { value: goodsAtlas() };
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.018, 0.018, 0.018), // dust film on the glass
    roughness: 0.03,
    metalness: 0,
    envMapIntensity: 1,
  });
  m.name = far ? 'facades.glassInteriorFar' : 'facades.glassInterior';
  if (far) { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4; }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uNight = U.uNight;
    shader.uniforms.uEmGain = gain;
    shader.uniforms.uSunDir = U.uSunDir;
    shader.uniforms.uSunColor = U.uSunColor;
    shader.uniforms.uGoods = goods;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_FRAME)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor + 0.07 * fSm, 0.55, fMask );')
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <lights_fragment_maps>', FRAG_LIGHT)
      .replace('vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;', FRAG_OUT);
  };
  m.customProgramCacheKey = () => 'facades.glassInterior.v5';
  return m;
}

export const GLASS_ATTRS = { aRoomP: 4, aRoomS: 4, aWin: 4, aFac: 4, aFrame: 4 };
