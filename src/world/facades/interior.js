import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

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

/** Shop interior types, in shader order. */
export const SHOP_TYPES = ['clothing', 'general', 'cafe', 'jewellery', 'pharmacy', 'shoes', 'books', 'flowers'];
export const shopTypeIndex = (name) => Math.max(0, SHOP_TYPES.indexOf(name));
/** Pack aWin.w. */
export const winCode = (kind, noGlass = false, type = 0) => kind + (noGlass ? 4 : 0) + 8 * type;

const VERT_PARS = /* glsl */`
attribute vec4 aRoomP;
attribute vec4 aRoomS;
attribute vec4 aWin;
attribute vec4 aFac;
attribute vec4 aFrame;
varying vec4 vFrame;
varying vec4 vRoomP;
varying vec4 vRoomS;
varying vec4 vWin;
varying vec4 vFac;
varying vec3 vFW;
`;

const VERT_MAIN = /* glsl */`
vRoomP = aRoomP; vRoomS = aRoomS; vWin = aWin; vFac = aFac; vFrame = aFrame;
vFW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAG_PARS = /* glsl */`
uniform float uTime;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec4 vFrame;
varying vec4 vRoomP;
varying vec4 vRoomS;
varying vec4 vWin;
varying vec4 vFac;
varying vec3 vFW;

// pixel angle (radians) and camera distance to the glass, set per pixel before tracing
float gPA = 0.001;
float gTC = 10.0;

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

// Goods on one shelf: albedo of the item at (a, y) above the board of row r, or alb.a = 0
// where the slot is empty. keep fades the per-item detail to the row's mean colour.
vec4 fItem( float a, float y, float r, float rowH, float cellW, float seed, float st, float keep ) {
  float c = floor( a / cellW ), fa = fract( a / cellW );
  bool books = st > 5.5 && st < 6.5;
  // facings: runs of 2–4 identical products (books vary one by one)
  float run = books ? c : floor( ( c + floor( fh1( r * 3.7 + seed ) * 4.0 ) ) / ( 2.0 + floor( fh1( r + seed * 3.0 ) * 3.0 ) ) );
  float g = fh2( vec2( run, r ) + seed * 7.0 );
  float gi = fh2( vec2( c * 1.37, r + 9.0 ) + seed );
  float ih = rowH * ( books ? 0.62 + 0.3 * gi : 0.35 + 0.5 * g ) - 0.03;
  // gaps either side of the item, as a share of the cell
  float gl = cellW * ( books ? 0.1 : 0.04 + 0.16 * fract( g * 5.3 ) ), gr = cellW * ( books ? 0.1 : 0.04 + 0.16 * fract( g * 9.1 ) );
  float shape = fract( g * 13.7 );
  // mean colour of a filled row, for the far range
  vec3 mean = books ? vec3( 0.36, 0.28, 0.22 ) : st > 3.5 && st < 4.5 ? vec3( 0.62, 0.62, 0.60 ) : st > 6.5 ? vec3( 0.32, 0.36, 0.22 ) : vec3( 0.42, 0.36, 0.30 );
  vec3 col;
  if ( books ) col = mix( GOODS[ int( gi * 7.99 ) ], vec3( 0.20, 0.14, 0.10 ), 0.45 ) * ( 0.6 + 0.5 * fh1( c * 0.71 + seed ) );
  else if ( st > 3.5 && st < 4.5 ) col = mix( vec3( 0.86, 0.86, 0.84 ), GOODS[ int( g * 7.99 ) ], step( 0.55, fract( g * 3.1 ) ) * 0.7 );
  else if ( st > 6.5 ) col = y > ih * 0.45 ? mix( vec3( 0.12, 0.30, 0.10 ), GOODS[ int( g * 7.99 ) ], step( 0.5, fract( a * 7.0 + y * 5.0 ) ) * 0.6 ) : vec3( 0.55, 0.28, 0.16 );
  else if ( st > 4.5 && st < 5.5 ) col = mix( vec3( 0.10, 0.08, 0.07 ), vec3( 0.75, 0.70, 0.62 ), step( 0.6, g ) ) * ( 0.7 + 0.5 * fract( g * 4.3 ) );
  else col = mix( vec3( 0.45, 0.42, 0.38 ), GOODS[ int( g * 7.99 ) ], st < 0.5 ? 0.55 : 0.8 ) * ( 0.65 + 0.4 * fract( g * 6.1 ) );
  // folded stacks (clothing): fold lines every ~3 cm
  if ( st < 0.5 ) col *= mix( 0.9, 0.8 + 0.2 * step( 0.3, fract( y / 0.03 ) ), keep );
  // labels and lids on boxes and jars
  if ( !books && st > 0.5 && st < 6.5 ) col = mix( col, vec3( 0.85, 0.83, 0.78 ), step( ih * 0.3, y ) * step( y, ih * 0.55 ) * step( 0.6, fract( g * 2.9 ) ) * keep );
  // silhouette: box, bottle (narrow neck) or jar (rounded shoulders)
  float xa = fa * cellW, xb = cellW - xa;
  float inX = step( gl, xa ) * step( gr, xb );
  if ( books ) inX = step( 0.003, xa ) * step( 0.003, xb );
  float neck = !books && shape > 0.55 && shape < 0.8 && y > ih * 0.7 ? step( abs( xa - 0.5 * ( cellW + gl - gr ) ), 0.14 * ( cellW - gl - gr ) ) : 1.0;
  float empty = step( fh2( vec2( c * 0.37, r * 1.3 ) + seed ), books ? 0.04 : 0.1 );
  float hit = inX * neck * step( y, ih ) * step( 0.0, y ) * ( 1.0 - empty );
  // far: a continuous band of the mean colour, ~70% of the row
  float hitFar = step( 0.0, y ) * step( y, rowH * ( books ? 0.8 : 0.62 ) );
  return vec4( mix( mean, col, keep ), mix( hitFar, hit, step( 0.5, keep ) ) );
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
    vec4 it = fItem( aIn, yIn - y0 - rIn * rowH - BT, rIn, rowH, cellW, seed, st, 0.0 );
    h.t = tIn; h.n = nW; h.alb = mix( frameC * 0.45, it.rgb, 0.62 ); h.id = 2.0;
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
  // goods: their fronts stand EG from the wall
  float tG = tW - EG / k;
  if ( tG > tIn && tG < tB ) {
    vec3 pG = ro + rd * tG;
    float rG = floor( ( pG.y - y0 ) / rowH );
    float yy = pG.y - y0 - rG * rowH - BT;
    float keepC = keepR * fKeep( fFoot( tG, rd, nW ), cellW );
    vec4 it = fItem( dot( pG, aDir ), yy, rG, rowH, cellW, seed, st, keepC );
    if ( it.a > 0.5 ) {
      // darker towards the board above
      float occ = 0.55 + 0.45 * smoothstep( 0.0, 0.5 * rowH, rowH - BT - yy );
      h.t = tG; h.n = nW; h.alb = it.rgb * occ; h.id = 2.0;
      return;
    }
  }
  if ( tB < tW ) {
    h.t = tB; h.n = nB; h.alb = frameC * ( nB.y < -0.5 ? 0.6 : 1.0 ); h.id = 2.0;
    return;
  }
  // the unit's back panel, deep in the shelf's shadow
  float yy = yW - y0 - rW * rowH;
  h.alb = frameC * 0.42 * ( 0.6 + 0.4 * smoothstep( 0.0, rowH, rowH - yy ) ); h.id = 2.0;
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
  if ( n.x < 0.5 ) ao *= 0.62 + 0.38 * smoothstep( 0.0, 0.5, p.x );
  if ( n.x > -0.5 ) ao *= 0.62 + 0.38 * smoothstep( 0.0, 0.5, b.x );
  if ( n.y < 0.5 ) ao *= 0.62 + 0.38 * smoothstep( 0.0, 0.5, p.y );
  if ( n.y > -0.5 ) ao *= 0.72 + 0.28 * smoothstep( 0.0, 0.45, b.y );
  if ( n.z > -0.5 ) ao *= 0.62 + 0.38 * smoothstep( 0.0, 0.5, b.z );
  return ao * ( 0.8 + 0.2 * smoothstep( 0.0, 0.4, p.z ) );
}
// home lamp at lp (lk 0 pendant with an open-topped shade, 1 standing lamp): irradiance
// on (p, n) per unit intensity
float fLamp( vec3 p, vec3 n, vec3 lp, float lk ) {
  vec3 dl = p - lp;
  float d2 = max( dot( dl, dl ), 0.15 );
  vec3 w = dl * inversesqrt( d2 );
  float down = max( -w.y, 0.0 ), up = max( w.y, 0.0 );
  float I = lk < 0.5 ? 0.2 + 0.8 * down * down + 1.4 * pow( up, 5.0 ) : 0.32 + 0.5 * down + 1.1 * up * up;
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
        fShelfUnit( h, ro, rd, h.n, vec3( 0.0, 0.0, 1.0 ), 0.9, S.z - 0.2, spec, sseed + h.n.x, st, frameC );
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
  // ---- fittings
  float ao = 1.0;
  fFittings( h, ao, ro, rd, ird, p, h.n, 0, S, seed, shop, stair, st );
  if ( !shop && !stair && lk > 0.5 ) fCylT( h, ro, rd, lp.xz, 0.014, 0.0, lp.y - 0.12, vec3( 0.06, 0.05, 0.045 ) );
  p = ro + rd * h.t;
  vec3 nn = h.n;
  float fp = fFoot( h.t, rd, nn );

  // ---- merchandise patterns on room walls and fittings
  if ( shop && h.glow == 0.0 && h.id < 1.5 ) {
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
        vec4 it = fItem( along, yy, r, spec.z, spec.w, seed * 3.0, st, keep );
        h.alb = mix( h.alb * 0.45, it.rgb, it.a * 0.9 );
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
  }

  // ---- lighting in room space
  ao *= fCornerAO( p, nn, S );
  if ( h.id < 0.5 ) fFittings( h, ao, ro, rd, ird, p, nn, 1, S, seed, shop, stair, st );
  float A = 2.0 * halfWin * max( fac.w - fac.z, 0.1 );
  float Aroom = 2.0 * ( S.x * S.y + S.x * S.z + S.y * S.z );
  vec3 E = Eday * ( 1.15 * fWinFF( p, nn, S, fac, halfWin ) + 0.9 * A / Aroom + 0.006 ) * ao;
  // sun patch: project the point back to the window plane along the sun direction
  if ( sunR.z < -0.05 ) {
    float tw = -p.z / sunR.z;
    vec2 q = p.xy + sunR.xy * tw;
    float pen = 0.01 + 0.012 * tw;
    float inX = fEdge( halfWin - abs( q.x - S.x * 0.5 ), pen );
    float inY = fEdge( q.y - fac.z, pen ) * fEdge( fac.w - q.y, pen );
    E += sunC * inX * inY * max( dot( nn, sunR ), 0.0 ) * 0.72;
  }
  // artificial light, colour by kind: ~2700 K homes (±10%), cafes ~2500 K, shops 3000–3500 K
  float litT = uNight * 0.58;
  float lit = 1.0 - smoothstep( litT - 0.03, litT + 0.03, win.y );
  if ( win.y < 0.035 ) lit = max( lit, 0.6 ); // a few rooms with the lights on during the day
  vec3 lampC = vec3( 1.0, 0.60, 0.31 ) * ( vec3( 1.0 ) + ( fh3( seed * 3.3 ) - 0.5 ) * vec3( 0.0, 0.12, 0.16 ) );
  vec3 Elamp = vec3( 0.0 );
  float glowK = 0.0;
  if ( shop ) {
    lampC = st > 3.5 && st < 4.5 ? vec3( 0.93, 0.95, 1.0 ) : st > 1.5 && st < 2.5 ? vec3( 1.0, 0.58, 0.29 )
          : mix( vec3( 1.0, 0.70, 0.43 ), vec3( 1.0, 0.64, 0.36 ), step( 0.5, fh1( seed * 5.1 ) ) );
    // shops are lit all day; by day the level follows the daylight outside so the
    // interior keeps its place relative to the street in the exposure
    float I = mix( max( 0.0012, 1.25 * daylum ), 0.0035, uNight ) * ( st > 2.5 && st < 3.5 ? 0.75 : 1.0 );
    float ex = st > 3.5 && st < 4.5 ? 2.0 : st > 2.5 && st < 3.5 ? 14.0 : 8.0;
    // downlight pools, the inter-reflected fill, and display spots on the window zone
    Elamp = lampC * I * ( fDownlights( p, nn, S, cell, ex ) * ( 0.75 + 0.25 * ao ) + ( 0.42 + 0.5 * smoothstep( 2.2, 0.4, p.z ) ) * ao );
    glowK = I;
  } else if ( lit > 0.0 ) {
    float I = stair ? 0.004 : 0.0105;
    Elamp = lampC * lit * I * ( fLamp( p, nn, lp, lk ) * ( 0.7 + 0.3 * ao ) + 0.07 * ao );
    // a television's cool flicker in a few rooms
    if ( fh1( seed * 9.7 ) < 0.1 ) Elamp += vec3( 0.25, 0.35, 0.6 ) * lit * 0.0007 * ( 0.6 + 0.4 * sin( uTime * 7.0 + seed * 40.0 ) * sin( uTime * 2.3 ) ) * ao;
    glowK = I * lit;
  }
  vec3 col = h.alb * ( E + Elamp ) * RECIPROCAL_PI + h.glow * lampC * glowK;

  // visible lamps: the fabric shade (open cylinder) glows when lit, brighter inside
  if ( !shop && !stair ) {
    float r = lk < 0.5 ? 0.2 : 0.17, inner;
    float tl = fShade( ro, rd, lp, r, lp.y - 0.13, lp.y + 0.07, inner );
    if ( tl > 0.0 && tl < h.t ) {
      vec3 shadeDay = vec3( 0.62, 0.56, 0.46 ) * Eday * ( 0.06 + 0.05 * inner ) * RECIPROCAL_PI;
      col = shadeDay + lampC * lit * 0.0105 * ( inner > 0.5 ? 9.0 : 1.6 );
    }
  }
  // cafe pendants
  if ( shop && st > 1.5 && st < 2.5 ) {
    for ( int i = 0; i < 3; i++ ) {
      vec3 lq = vec3( S.x * ( 0.25 + 0.25 * float( i ) ), S.y - 0.9, 1.6 + float( i ) * 0.4 );
      float tl = dot( lq - ro, rd );
      float fpl = gPA * ( gTC + tl );
      if ( tl > 0.0 && tl < h.t ) col += lampC * fEdge( 0.09 - length( ro + rd * tl - lq ), fpl ) * glowK * 12.0;
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
      vec3 back = lit > 0.0 ? lampC * lit * 0.0105 * ( fLamp( pc, vec3( 0.0, 0.0, 1.0 ), lp, lk ) + 0.07 ) : vec3( 0.0 );
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

// Reflection of the street: opposite facades (with windows), paving, trees; returns
// rgb + coverage (0 = only sky).
vec4 fStreet( vec3 R, vec3 N, vec3 T, vec3 P, float baseH, float streetW, vec3 Eamb, vec3 sky ) {
  float rn = max( dot( R, N ), 0.02 );
  float tO = streetW / rn;
  float hy = baseH + R.y * tO;
  float hx = dot( P, T ) + dot( R, T ) * tO;
  vec3 sunC = uSunColor;
  vec3 col;
  float cov;
  // ground
  if ( R.y < 0.0 && baseH / -R.y < tO ) {
    float tg = baseH / -R.y;
    vec2 gp = P.xz + R.xz * tg;
    float sh = 0.55 + 0.45 * vnoise( gp * 0.15 );
    vec3 E = Eamb + sunC * max( uSunDir.y, 0.0 ) * sh;
    col = vec3( 0.27, 0.26, 0.24 ) * E * RECIPROCAL_PI;
    return vec4( col, 1.0 );
  }
  // opposite facade: varying roof heights per building
  float bid = floor( hx / 13.0 );
  float roofH = 15.0 + 8.0 * fh1( bid * 1.37 + 0.5 );
  float blur = 0.012 * tO + 0.05;
  cov = 1.0 - smoothstep( roofH - blur, roofH + blur, hy );
  vec3 stone = mix( vec3( 0.50, 0.44, 0.35 ), vec3( 0.55, 0.50, 0.41 ), fh1( bid * 2.1 ) );
  // horizontal shadow bands under cornices and balconies
  stone *= 0.75 + 0.25 * smoothstep( 0.0, 0.35, fract( ( hy - 4.8 ) / 3.6 ) );
  float sunF = max( dot( -N, uSunDir ), 0.0 ) * ( 0.25 + 0.75 * step( 0.5, fh1( bid * 3.7 ) ) );
  vec3 E = Eamb * 0.9 + sunC * sunF;
  col = stone * E * RECIPROCAL_PI;
  // window grid on the opposite facade (soft edges: slightly imperfect glass blurs the
  // reflection with distance; never sharper than the pixel footprint)
  float bl = max( 0.03 + 0.006 * tO, gPA * ( gTC + tO ) * 1.5 );
  vec2 cell = vec2( hx / 3.4, ( hy - 4.8 ) / 3.6 );
  vec2 f = fract( cell );
  vec2 bb = min( vec2( bl / 3.4, bl / 3.6 ), vec2( 0.2 ) );
  float wx = smoothstep( 0.3 - bb.x, 0.3 + bb.x, f.x ) * ( 1.0 - smoothstep( 0.7 - bb.x, 0.7 + bb.x, f.x ) );
  float wy = smoothstep( 0.22 - bb.y, 0.22 + bb.y, f.y ) * ( 1.0 - smoothstep( 0.82 - bb.y, 0.82 + bb.y, f.y ) );
  float isWin = smoothstep( -bb.y, bb.y, cell.y ) * wx * wy;
  float fs = fract( hx / 3.4 );
  float shopBand = smoothstep( 4.2 + bl, 4.2 - bl, hy ) * smoothstep( 0.6 - bl, 0.6 + bl, hy ) * smoothstep( 0.12 - bb.x, 0.12 + bb.x, fs ) * smoothstep( 0.88 + bb.x, 0.88 - bb.x, fs );
  // what the opposite windows show: dark glass, pale curtains or painted shutters
  float wk = fh2( floor( cell ) + 11.0 );
  vec3 winAlb = wk < 0.5 ? vec3( 0.07, 0.075, 0.08 ) : wk < 0.8 ? vec3( 0.42, 0.40, 0.36 ) : vec3( 0.10, 0.16, 0.12 );
  float lit = step( fh2( floor( cell ) + 5.0 ), uNight * 0.5 );
  vec3 winC = winAlb * E * RECIPROCAL_PI + lit * vec3( 1.0, 0.62, 0.32 ) * 0.0012;
  vec3 shopC = vec3( 0.12, 0.11, 0.10 ) * E * RECIPROCAL_PI + vec3( 1.0, 0.74, 0.48 ) * 0.0016 * uNight;
  col = mix( col, winC, isWin * 0.9 );
  col = mix( col, shopC, shopBand * 0.85 );
  // street trees between us and the opposite facade
  float tT = ( streetW * 0.5 - 5.2 ) / rn;
  if ( tT > 0.0 ) {
    float ty = baseH + R.y * tT;
    float tx = dot( P, T ) + dot( R, T ) * tT;
    // soft, out-of-focus crowns: a blurred band with gentle density variation
    float crown = smoothstep( 2.4, 3.8, ty ) * smoothstep( 8.2, 5.6, ty );
    float dens = 0.3 + 0.25 * vnoise( vec2( tx * 0.2, 0.5 ) );
    float spacing = smoothstep( 0.0, 0.25, fract( tx / 10.0 + 0.1 ) ) * smoothstep( 1.0, 0.8, fract( tx / 10.0 + 0.1 ) );
    float tree = crown * dens * spacing;
    vec3 leaf = vec3( 0.09, 0.12, 0.06 ) * ( Eamb + sunC * 0.35 ) * RECIPROCAL_PI;
    col = mix( col, leaf, tree );
    cov = max( cov, tree );
  }
  return vec4( col, cov );
}
`;

// Injected after lights_fragment_maps: replaces the sky-only reflection by the street
// model, and computes the transmitted interior.
const FRAG_LIGHT = /* glsl */`
#include <lights_fragment_maps>
vec3 fInterior = vec3( 0.0 );
float fNoGlass = step( 3.5, mod( vWin.w, 8.0 ) );
float fGlass = ( 1.0 - fNoGlass ) * ( 1.0 - fMask );
// pixel footprint for the filtering (derivatives taken before any branching)
gTC = length( vViewPosition );
gPA = max( length( fwidth( normalize( vViewPosition ) ) ) * 0.75, 1e-5 );
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
  // a faint film of dust and smudges dims and greys the reflection a little
  radiance *= fSmudge;

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
  float wav = vnoise( vec2( vRoomP.x * 3.0, vRoomP.y * 9.0 ) + vWin.x * 50.0 ) - 0.5;
  j.x += wav * 0.006;
  j.y += ( vnoise( vec2( vRoomP.y * 4.0, vRoomP.x * 2.0 ) + 9.0 ) - 0.5 ) * 0.004;
  vec3 jv = ( viewMatrix * vec4( j.x, j.y, j.z, 0.0 ) ).xyz;
  normal = normalize( normal + jv * ( 1.0 - step( 3.5, mod( vWin.w, 8.0 ) ) ) );
}
`;

// Far range (lod 1): the casing, sill rail and central meeting stile are drawn here
// instead of as geometry. fMask = 1 on the painted frame. Also the smudge film.
const FRAG_FRAME = /* glsl */`
#include <color_fragment>
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
 * the thin glass never loses against the buildings' back plate at 200–680 m.
 */
export function createInteriorGlass({ far = false } = {}) {
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
    shader.uniforms.uSunDir = U.uSunDir;
    shader.uniforms.uSunColor = U.uSunColor;
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
  m.customProgramCacheKey = () => (far ? 'facades.glassInteriorFar.v3' : 'facades.glassInterior.v3');
  return m;
}

export const GLASS_ATTRS = { aRoomP: 4, aRoomS: 4, aWin: 4, aFac: 4, aFrame: 4 };
