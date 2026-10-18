import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Materials of the line's trams (trams/model.js parts), tracked by the material library so
// lighting configures them like everything else. Each unit has its own set (its seed and
// the street around it); the programs are shared.
//
//  - body: metallic silver paint under a clear coat. The vertex colour is the paint colour;
//    dark vertex colours (skirt, bellows, seals, door seams, carbon strips) are plain
//    dielectric trim, so only the silver panels turn metallic. Road film low on the body,
//    streaks under the windows, a slight waviness of the panels in the clear coat's
//    reflection; the clear coat mirrors the street (see street reflection below).
//  - glass: flush side glazing, a smooth dielectric with a little more reflectance than one
//    surface (laminated / double panes). Vertex colour black = black frit over the pillars
//    and frames. Behind the panes the saloon is traced per pixel in the body frame (seat
//    pairs, grab poles and rails, seated and standing passengers, the ceiling's light
//    strips, the far side's windows onto the street), lit by the daylight coming in or by
//    its own lights after dark, and seen through the tinted glass.
//  - front / frontTrail: the cab front glass, uv = (u share of the half width, height in m).
//    Drawn per pixel: the windscreen in a rounded U (coated laminated glass, F0 ≈ 0.25, so
//    the street canyon and the sky mirror in it over the cab, which is ray traced behind
//    the glass in the body frame: console and binnacle, the driver in the leading cab,
//    overhead console, walls, side windows onto the street, the saloon door), a thin
//    silver trim round it, the dark tinted mask (cheeks and the foot where the lamps sit)
//    outside it.
//  - metal: the pantograph frame (dark grey paint).
//
// Street reflection: glass, windscreen and clear coat mirror the street as the camera saw it
// in the previous frame (the anti-aliasing history): the reflected ray is met with the
// street's paving and its two facade planes along the unit, and that point is looked up in
// last frame's image. Where it falls off screen (or there is no history) the environment
// cube takes over, with its bare street below the horizon toned down.

const C = (r, g, b) => new THREE.Color(r, g, b);

/** Street-reflection uniforms shared by every unit: last frame's image, its view-projection, on/off. */
export function makeSharedRefl() {
  return { hist: { value: null }, vp: { value: new THREE.Matrix4() }, on: { value: 0 } };
}

/** One unit's uniforms: the shared reflection source plus its street planes (route right
 *  in world xz, the right and left facade offsets along it), paving height and seed. */
export function makeUnitUniforms(shared, seed) {
  return {
    tTramHist: shared.hist, uTramVP: shared.vp, uTramSSR: shared.on,
    uTramStreet: { value: new THREE.Vector4(1, 0, 12, -12) },
    uTramGround: { value: 0 },
    uTramSeed: { value: seed },
  };
}

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

/** Shared helpers (after the environment map's declarations). */
const COMMON_GLSL = /* glsl */ `
uniform float uTramNight;
uniform float uTramGain;
uniform float uTramSeed;
float tramRect( vec2 p, vec2 lo, vec2 hi, float w ) {
  vec2 d = min( p - lo, hi - p );
  return smoothstep( - w, w, min( d.x, d.y ) );
}
// ray vs ellipsoid (centre c, radii r): soft coverage and the normal where it is hit
float tramEll( vec3 ro, vec3 rd, vec3 c, vec3 r, float w, out vec3 n ) {
  vec3 o = ( ro - c ) / r, d = rd / r;
  float a = dot( d, d ), tc = - dot( o, d ) / a;
  float m = length( o + d * tc );
  float t = tc - sqrt( max( 1.0 - m * m, 0.0 ) / a );
  n = normalize( ( o + d * t ) / r );
  return smoothstep( - w, w, ( 1.0 - m ) * min( r.x, r.y ) ) * step( 0.0, t );
}
vec3 tramEnv( vec3 dirW ) {
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  return textureCubeUV( envMap, envMapRotation * dirW, 0.1 ).rgb * envMapIntensity;
#else
  return vec3( 0.0 );
#endif
}
float tramHash( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.103, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
float tramNoise( float x ) {
  float i = floor( x ), f = fract( x );
  return mix( tramHash( vec3( i, uTramSeed, 1.7 ) ), tramHash( vec3( i + 1.0, uTramSeed, 1.7 ) ), f * f * ( 3.0 - 2.0 * f ) );
}
// the environment's street is bare stone (no trees, poles, people, shade or traffic): what a
// pane mirrors below the horizon is darker and less saturated than those bare sunlit facades
vec3 tramTone( vec3 e, float y ) {
  return mix( mix( e, vec3( dot( e, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.35 ) * 0.5, e, smoothstep( 0.05, 0.45, y ) );
}
`;

/** Street reflection from last frame's image (see the header). */
const REFL_GLSL = /* glsl */ `
uniform sampler2D tTramHist;
uniform mat4 uTramVP;
uniform float uTramSSR;
uniform vec4 uTramStreet;
uniform float uTramGround;
// world point P, reflected direction R: the street seen along R, and its weight (0 = none).
// The proxy is two vertical planes along the unit, on the sidewalks where the people, trees
// and poles stand (at most the facade lines): those stand upright in last frame's image and
// a vertical proxy keeps them upright in the mirror (a paving proxy would smear them along
// the street). A ray running down meets the plane under the paving; last frame shows the
// paving in front of that point. Rays steeply down land off screen: the environment there.
vec3 tramStreetRefl( vec3 P, vec3 R, out float a ) {
  a = 0.0;
  if ( uTramSSR < 0.5 ) return vec3( 0.0 );
  float t = 300.0;
  float nr = dot( uTramStreet.xy, R.xz ), np = dot( uTramStreet.xy, P.xz );
  if ( nr > 1e-3 ) t = min( t, ( uTramStreet.z - np ) / nr );
  else if ( nr < - 1e-3 ) t = min( t, ( uTramStreet.w - np ) / nr );
  t = max( t, 0.3 );
  vec4 c = uTramVP * vec4( P + R * t, 1.0 );
  if ( c.w < 0.05 ) return vec3( 0.0 );
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  vec2 e = min( uv, 1.0 - uv );
  a = smoothstep( 0.0, 0.05, min( e.x, e.y ) ) * smoothstep( uTramGround - 30.0, uTramGround - 10.0, P.y + R.y * t );
  if ( a <= 0.0 ) return vec3( 0.0 );
  return min( texture2D( tTramHist, uv ).rgb, vec3( 64.0 ) );
}
vec3 tramWorldPos() { return cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz; }
`;

/** The saloon behind the side glazing, traced per pixel in the body frame (x right, y up
 *  from the rail, z back from the body's leading end), seen from either side (mirrored so
 *  the near side is +x): inner walls at |x| = 1.2, low floor, ceiling with two light strips,
 *  transverse seat pairs (2 + 2, facing pairs) between the doors, grab poles between the
 *  backs and at the doors, overhead rails, seated and standing passengers (by seat / cell
 *  hash and the unit's seed), and the far side's windows onto the street. Cab bodies: the
 *  driver's cab ahead of a partition at z = 2.65. Objects are painted far to near with soft
 *  edges over the pixel footprint. Returns the light leaving the saloon through the pane. */
const SALOON_GLSL = /* glsl */ `
#define TS_XW 1.2
#define TS_YF 0.36
#define TS_YC 2.3
#define TS_P 0.8
const vec3 TS_T = vec3( 0.5, 0.56, 0.54 );         // the tinted side glazing's transmission
vec3 tsHit = vec3( 0.0, 1.5, 0.0 );                // where the last primitive was hit (for the shading)
float tsEll( vec3 ro, vec3 rd, vec3 c, vec3 r, float w, out vec3 n ) {
  float cv = tramEll( ro, rd, c, r, w, n );
  tsHit = c + n * r;
  return cv;
}
float tramBox( vec3 ro, vec3 rd, vec3 lo, vec3 hi, float w, out vec3 n ) {
  vec3 iv = 1.0 / rd;
  vec3 ta = ( lo - ro ) * iv, tb = ( hi - ro ) * iv;
  vec3 tn = min( ta, tb ), tf = max( ta, tb );
  float t0 = max( max( tn.x, tn.y ), tn.z ), t1 = min( min( tf.x, tf.y ), tf.z );
  n = tn.x >= t0 ? vec3( - sign( rd.x ), 0.0, 0.0 ) : tn.y >= t0 ? vec3( 0.0, - sign( rd.y ), 0.0 ) : vec3( 0.0, 0.0, - sign( rd.z ) );
  tsHit = ro + rd * t0;
  return smoothstep( 0.0, w, t1 - t0 ) * step( 0.0, t0 );
}
// roll along x (centre yz, radius r) between x0 and x1: the rounded top of a seat back
float tramRoll( vec3 ro, vec3 rd, vec2 c, float r, float x0, float x1, float w, out vec3 n ) {
  vec2 o = ro.yz - c, d = rd.yz;
  float a = max( dot( d, d ), 1e-6 ), tc = - dot( o, d ) / a;
  float m = length( o + d * tc );
  float t = tc - sqrt( max( r * r - m * m, 0.0 ) / a );
  vec2 h = o + d * t;
  n = normalize( vec3( 0.0, h ) + 1e-6 );
  tsHit = ro + rd * t;
  return smoothstep( - w, w, r - m ) * step( 0.0, t ) * step( x0, tsHit.x ) * step( tsHit.x, x1 );
}
// vertical pole at c (xz), radius r
float tramPole( vec3 ro, vec3 rd, vec2 c, float r, float w, out vec3 n ) {
  vec2 o = ro.xz - c, d = rd.xz;
  float a = max( dot( d, d ), 1e-6 ), tc = - dot( o, d ) / a;
  float m = length( o + d * tc );
  float t = tc - sqrt( max( r * r - m * m, 0.0 ) / a );
  vec2 h = o + d * t;
  n = normalize( vec3( h.x, 0.0, h.y ) + 1e-6 );
  tsHit = ro + rd * t;
  float y = tsHit.y;
  return smoothstep( - w, w, r - m ) * step( 0.0, t ) * step( TS_YF, y ) * step( y, TS_YC );
}
// rail along the car at c (xy), radius r
float tramRail( vec3 ro, vec3 rd, vec2 c, float r, float w, out vec3 n ) {
  vec2 o = ro.xy - c, d = rd.xy;
  float a = max( dot( d, d ), 1e-6 ), tc = - dot( o, d ) / a;
  float m = length( o + d * tc );
  float t = tc - sqrt( max( r * r - m * m, 0.0 ) / a );
  vec2 h = o + d * t;
  n = normalize( vec3( h, 0.0 ) + 1e-6 );
  tsHit = ro + rd * t;
  return smoothstep( - w, w, r - m ) * step( 0.0, t );
}
// albedo lit by the daylight coming in through the windows (from the sides; less below the
// window line) and by the ceiling lights (from above); Ed, En are irradiance / pi
vec3 tramLit( vec3 alb, vec3 n, vec3 Ed, float En ) {
  float y = tsHit.y;
  float aoD = 0.4 + 0.6 * smoothstep( 0.45, 1.7, y ), aoN = 0.55 + 0.45 * smoothstep( 0.3, 2.0, y );
  return alb * ( Ed * aoD * ( 0.5 + 0.5 * abs( n.x ) + 0.15 * n.y ) + En * aoN * vec3( 0.97, 0.98, 1.0 ) * ( 0.35 + 0.65 * max( n.y, 0.0 ) ) );
}
vec3 tramCloth( float h ) {
  return h < 0.14 ? vec3( 0.018, 0.022, 0.04 ) : h < 0.25 ? vec3( 0.01 ) : h < 0.36 ? vec3( 0.5, 0.5, 0.47 )
    : h < 0.46 ? vec3( 0.045, 0.07, 0.13 ) : h < 0.55 ? vec3( 0.16, 0.13, 0.09 ) : h < 0.62 ? vec3( 0.17, 0.025, 0.025 )
    : h < 0.7 ? vec3( 0.04, 0.055, 0.03 ) : h < 0.8 ? vec3( 0.2, 0.27, 0.38 ) : h < 0.9 ? vec3( 0.08 ) : vec3( 0.32, 0.2, 0.1 );
}
vec3 tramSkin( float h ) { return mix( vec3( 0.34, 0.22, 0.16 ), vec3( 0.06, 0.035, 0.022 ), h * h ); }
// does the ray pass within r (+ the footprint) of c? (bound before the details)
bool tramNear( vec3 ro, vec3 rd, vec3 c, float r ) {
  vec3 o = c - ro;
  float t = dot( o, rd );
  return t > 0.0 && dot( o, o ) - t * t < r * r;
}
// head (facing f along z): hair over the crown and the back (a smooth hairline, longer on
// some), skin elsewhere with soft brows / eye sockets and the shade under the jaw
vec3 tramHead( vec3 n, float f, float h, vec3 Ed, float En ) {
  float lng = step( 0.55, fract( h * 2.3 ) );
  float back = max( - f * n.z, 0.0 );
  float hair = smoothstep( 0.0, 0.16, n.y * 1.15 + 0.9 * back + ( 0.2 + 0.45 * lng ) * abs( n.x ) * ( 1.0 - max( f * n.z, 0.0 ) ) - 0.42 + 0.12 * fract( h * 9.1 ) );
  float bald = step( 0.93, fract( h * 7.7 ) );
  hair *= 1.0 - bald * smoothstep( 0.2, 0.5, n.y );
  float hh = fract( h * 5.3 );
  vec3 hc = hh < 0.72 ? vec3( 0.016, 0.012, 0.009 ) : hh < 0.88 ? vec3( 0.07, 0.042, 0.022 ) : hh < 0.95 ? vec3( 0.2, 0.13, 0.06 ) : vec3( 0.28, 0.26, 0.24 );
  float face = smoothstep( 0.3, 0.8, f * n.z );
  float eyes = face * ( 1.0 - smoothstep( 0.03, 0.1, abs( n.y - 0.1 ) ) ) * 0.22;
  vec3 sk = tramSkin( fract( h * 3.7 ) ) * ( 0.8 + 0.2 * face ) * ( 1.0 - eyes );
  return tramLit( mix( sk, hc, hair ), n, Ed, En );
}
// head, jaw and neck at the head centre c (facing f)
void tramHeadNeck( inout vec3 L, vec3 ro, vec3 rd, vec3 c, float f, float h, float w, vec3 Ed, float En ) {
  vec3 n; float cv;
  vec3 sk = tramSkin( fract( h * 3.7 ) );
  cv = tsEll( ro, rd, c + vec3( 0.0, - 0.12, - f * 0.005 ), vec3( 0.054, 0.08, 0.054 ), w, n );
  L = mix( L, tramLit( sk * 0.72, n, Ed, En ), cv );
  cv = tsEll( ro, rd, c + vec3( 0.0, - 0.05, f * 0.02 ), vec3( 0.064, 0.068, 0.072 ), w, n );
  L = mix( L, tramLit( sk * ( 0.75 + 0.25 * smoothstep( - 0.6, 0.0, n.y ) ), n, Ed, En ), cv );
  cv = tsEll( ro, rd, c, vec3( 0.077, 0.1, 0.092 ), w, n );
  L = mix( L, tramHead( n, f, h, Ed, En ), cv );
}
// a seated passenger: pos = hip point, facing f
void tramSeated( inout vec3 L, vec3 ro, vec3 rd, vec3 pos, float f, float h, float w, vec3 Ed, float En ) {
  if ( !tramNear( ro, rd, pos + vec3( 0.0, 0.2, f * 0.2 ), 0.75 + w ) ) return;
  vec3 n; float c;
  vec3 top = tramCloth( fract( h * 7.13 ) ), legs = tramCloth( fract( h * 5.37 + 0.3 ) ) * 0.7;
  vec3 sk = tramSkin( fract( h * 3.7 ) );
  float sh = 0.92 + 0.16 * fract( h * 19.0 );           // build
  float lean = ( fract( h * 23.0 ) - 0.5 ) * 0.06, side = ( fract( h * 29.0 ) - 0.5 ) * 0.05;
  c = tsEll( ro, rd, pos + vec3( 0.0, - 0.3, f * 0.47 ), vec3( 0.15, 0.25, 0.075 ), w, n );
  L = mix( L, tramLit( legs, n, Ed, En ), c );
  c = tsEll( ro, rd, pos + vec3( 0.0, 0.03, f * 0.24 ), vec3( 0.17 * sh, 0.08, 0.25 ), w, n );
  L = mix( L, tramLit( legs, n, Ed, En ), c );
  c = tsEll( ro, rd, pos + vec3( side * 0.5, 0.3, f * ( 0.04 + lean * 0.5 ) ), vec3( 0.165 * sh, 0.27, 0.115 ), w, n );
  L = mix( L, tramLit( top, n, Ed, En ), c );
  c = tsEll( ro, rd, pos + vec3( side * 0.8, 0.505, f * ( 0.03 + lean ) ), vec3( 0.2 * sh, 0.095, 0.1 ), w, n );
  L = mix( L, tramLit( top, n, Ed, En ), c );
  for ( int i = 0; i < 2; i ++ ) {
    float ax = ( i == 0 ? - 1.0 : 1.0 ) * 0.195 * sh;
    c = tsEll( ro, rd, pos + vec3( ax + side * 0.6, 0.33, f * ( 0.09 + lean * 0.6 ) ), vec3( 0.052, 0.2, 0.06 ), w, n );
    L = mix( L, tramLit( top * 0.9, n, Ed, En ), c );
    c = tsEll( ro, rd, pos + vec3( ax * 0.75, 0.1, f * 0.25 ), vec3( 0.045, 0.045, 0.12 ), w, n );
    L = mix( L, tramLit( sk, n, Ed, En ), c );
  }
  tramHeadNeck( L, ro, rd, pos + vec3( side, 0.76, f * ( 0.06 + lean * 1.4 ) ), f, h, w, Ed, En );
}
// a standing passenger at p (floor point), facing f, height scale s
void tramStanding( inout vec3 L, vec3 ro, vec3 rd, vec3 p, float f, float s, float h, float w, vec3 Ed, float En ) {
  if ( !tramNear( ro, rd, p + vec3( 0.0, 0.9 * s, 0.0 ), 0.95 * s + w ) ) return;
  vec3 n; float c;
  vec3 top = tramCloth( fract( h * 7.13 ) ), legs = tramCloth( fract( h * 5.37 + 0.3 ) ) * 0.7;
  float sh = 0.92 + 0.16 * fract( h * 19.0 );
  for ( int i = 0; i < 2; i ++ ) {
    float lx = ( i == 0 ? - 1.0 : 1.0 ) * 0.085 * sh;
    c = tsEll( ro, rd, p + vec3( lx, 0.44 * s, 0.0 ), vec3( 0.075, 0.45 * s, 0.08 ), w, n );
    L = mix( L, tramLit( legs, n, Ed, En ), c );
  }
  c = tsEll( ro, rd, p + vec3( 0.0, 1.12 * s, 0.0 ), vec3( 0.17 * sh, 0.3 * s, 0.12 ), w, n );
  L = mix( L, tramLit( top, n, Ed, En ), c );
  c = tsEll( ro, rd, p + vec3( 0.0, 1.36 * s, 0.0 ), vec3( 0.2 * sh, 0.095, 0.105 ), w, n );
  L = mix( L, tramLit( top, n, Ed, En ), c );
  for ( int i = 0; i < 2; i ++ ) {
    float ax = ( i == 0 ? - 1.0 : 1.0 ) * 0.205 * sh;
    c = tsEll( ro, rd, p + vec3( ax, 1.12 * s, 0.0 ), vec3( 0.05, 0.28 * s, 0.058 ), w, n );
    L = mix( L, tramLit( top * 0.9, n, Ed, En ), c );
  }
  tramHeadNeck( L, ro, rd, p + vec3( 0.0, 1.6 * s, f * 0.02 ), f, h, w, Ed, En );
}
// one side's seat pair (back at zb, facing f) and whoever sits there; sx = +1 near, -1 far
void tramSeats( inout vec3 L, vec3 ro, vec3 rd, float sx, float k, float zb, float f, float w, vec3 seatC, vec3 Ed, float En ) {
  vec3 n; float c;
  float x0 = sx > 0.0 ? 0.34 : - 1.16, x1 = sx > 0.0 ? 1.16 : - 0.34;
  vec3 shell = vec3( 0.23, 0.23, 0.22 );
  // the ray meets the seat back first when it travels the way the seats face
  bool backFirst = rd.z * f > 0.0;
  for ( int pass = 0; pass < 2; pass ++ ) {
    bool people = ( pass == 0 ) == backFirst;
    if ( people ) {
      for ( int i = 0; i < 2; i ++ ) {
        float x = sx * ( i == 0 ? 0.55 : 0.95 );
        float h = tramHash( vec3( k, x * 3.0, uTramSeed ) );
        if ( h < 0.4 ) tramSeated( L, ro, rd, vec3( x, 0.84, zb + f * 0.06 ), f, fract( h * 13.1 ), w, Ed, En );
      }
    } else {
      // cushion, then the back: upholstered towards the seat, a grey plastic shell round
      // the sides, the top (with its grab handle) and behind
      c = tramBox( ro, rd, vec3( x0, 0.74, min( zb, zb + f * 0.48 ) ), vec3( x1, 0.84, max( zb, zb + f * 0.48 ) ), w, n );
      L = mix( L, tramLit( n.y > 0.5 ? seatC : shell * 0.6, n, Ed, En ), c );
      c = tramBox( ro, rd, vec3( x0, 0.74, zb - 0.035 ), vec3( x1, 1.36, zb + 0.035 ), w, n );
      vec3 alb = n.z * f > 0.5 ? seatC : shell;
      L = mix( L, tramLit( alb, n, Ed, En ), c );
      c = tramRoll( ro, rd, vec2( 1.36, zb ), 0.048, x0, x1, w, n );
      L = mix( L, tramLit( n.z * f > 0.3 ? seatC : shell, n, Ed, En ), c );
    }
  }
}
bool tramSeatCell( float zm, float body ) {
  if ( body < 0.5 ) return zm > 3.15 && zm < 10.5 && abs( zm - 6.4 ) > 1.05;
  return zm > 0.6 && zm < 9.1 && abs( zm - 2.25 ) > 1.05 && abs( zm - 7.45 ) > 1.05;
}
float tramDoorZ( float zm, float body ) {
  if ( body < 0.5 ) return 6.4;
  return abs( zm - 2.25 ) < abs( zm - 7.45 ) ? 2.25 : 7.45;
}
// the street through the far side's windows (a second tinted pane)
vec3 tramOutside( vec3 rdW ) { vec3 e = tramEnv( rdW ); return mix( e, tramTone( e, rdW.y ), 0.4 ) * TS_T; }

vec3 tramSaloon( vec3 ro, vec3 rd, vec3 rdW, float w0, float camD, float body, vec3 Ed, float En ) {
  float sd = ro.x >= 0.0 ? 1.0 : - 1.0;
  ro.x *= sd; rd.x *= sd;
  rd.x = min( rd.x, - 0.03 );
  rd.y = abs( rd.y ) < 1e-4 ? 1e-4 : rd.y;
  rd.z = abs( rd.z ) < 1e-4 ? 1e-4 : rd.z;
  rd = normalize( rd );
  float tin = max( ( ro.x - TS_XW ) / - rd.x, 0.0 );
  float tfar = ( ro.x + TS_XW ) / - rd.x;
  float tfc = rd.y < 0.0 ? ( ro.y - TS_YF ) / - rd.y : ( TS_YC - ro.y ) / rd.y;
  bool cab = body < 0.5;
  bool inCab = cab && ro.z < 2.65;
  float tpart = 1e4, tcon = 1e4;
  if ( cab ) { tpart = ( 2.65 - ro.z ) / rd.z; if ( tpart < 0.0 ) tpart = 1e4; }
  if ( inCab && rd.z < 0.0 ) tcon = ( 1.05 - ro.z ) / rd.z;
  float tend = min( min( tfar, tfc ), min( tpart, tcon ) );
  // the lights: two strips along the ceiling, on day and night
  float lamp = 0.085 * mix( 1.0, uTramGain, uTramNight );
  // ---- the room
  vec3 p = ro + rd * tend, n = vec3( 1.0, 0.0, 0.0 );
  tsHit = p;
  vec3 L;
  float w = w0 * ( 1.0 + tend / camD );
  if ( tend == tcon ) {
    // the driver's desk, the windscreen above it
    L = mix( tramLit( vec3( 0.03 ), vec3( 0.0, 0.5, 0.86 ), Ed, En ), tramOutside( rdW ) * 0.8, smoothstep( 1.33 - w, 1.33 + w, p.y ) );
  } else if ( tend == tpart ) {
    // the partition behind the driver's cab, its door window
    float win = tramRect( p.xy, vec2( 0.25, 1.4 ), vec2( 0.75, 2.05 ), w );
    L = mix( tramLit( vec3( 0.4, 0.4, 0.39 ), vec3( 0.0, 0.0, - sign( rd.z ) ), Ed, En ), tramLit( vec3( 0.12 ), vec3( 0.0, 1.0, 0.0 ), Ed, En ), win );
  } else if ( tend == tfar ) {
    // far side: wall panels under the glazing band, black frit over the pillars, the panes
    // (the doors' leaves glazed lower down); the cove panel above
    float dz = abs( p.z - tramDoorZ( p.z, body ) );
    bool door = dz < 0.66 && !( cab && p.z < 3.0 );
    float y0 = door ? 0.8 : 0.98, y1 = door ? 2.1 : 2.38;
    float pil = door ? smoothstep( 0.02 + w, 0.02 - w, dz ) : smoothstep( 0.07 + w, 0.07 - w, abs( fract( ( p.z + 0.4 ) / 1.59 ) - 0.5 ) * 1.59 );
    float pane = tramRect( vec2( 0.0, p.y ), vec2( - 1.0, y0 ), vec2( 1.0, y1 ), w ) * ( 1.0 - pil );
    float band = tramRect( vec2( 0.0, p.y ), vec2( - 1.0, y0 - 0.05 ), vec2( 1.0, y1 + 0.04 ), w );
    // lining panels with their joints, a dark kick strip along the floor
    float fz = fract( p.z / TS_P );
    float joint = smoothstep( 0.006 + w, 0.006 - w, min( fz, 1.0 - fz ) * TS_P );
    float kick = smoothstep( 0.52 + w, 0.52 - w, p.y );
    vec3 wall = tramLit( mix( vec3( 0.4, 0.4, 0.385 ), vec3( 0.07, 0.07, 0.07 ), kick ) * ( 1.0 - 0.6 * joint ), vec3( 1.0, 0.0, 0.0 ), Ed, En );
    wall = mix( wall, tramLit( vec3( 0.03 ), vec3( 1.0, 0.0, 0.0 ), Ed, En ), band );
    // (the inner face of that glass mirrors the lit saloon a little)
    L = mix( wall, tramOutside( rdW ) + tramLit( vec3( 0.025 ), vec3( 0.0, 1.0, 0.0 ), Ed, En ), pane );
    tsHit = vec3( 0.0, 1.5, 0.0 );
  } else if ( rd.y > 0.0 ) {
    // ceiling, lit from below, with the light strips
    float ax = abs( p.x );
    L = vec3( 0.55, 0.55, 0.53 ) * ( Ed * 0.45 + En * 0.5 ) * ( 0.6 + 0.4 * smoothstep( 1.2, 0.8, ax ) );
    L = mix( L, vec3( 0.97, 0.98, 1.0 ) * lamp, tramRect( vec2( ax, 0.0 ), vec2( 0.5, - 1.0 ), vec2( 0.64, 1.0 ), w ) );
  } else {
    // floor: dark grey vinyl
    L = tramLit( vec3( 0.07, 0.065, 0.06 ), vec3( 0.0, 1.0, 0.0 ), Ed, En );
  }
  if ( inCab ) return L;
  // ---- the furniture and the people, cell by cell (one seat pitch each), far to near
  float tcap = tin + 8.0 * TS_P / abs( rd.z );
  float tl = min( tend, tcap );
  float zA = ro.z + rd.z * tin, zB = ro.z + rd.z * tl;
  float kA = floor( zA / TS_P ), kB = floor( zB / TS_P );
  float dk = kA >= kB ? 1.0 : - 1.0;
  float nk = abs( kA - kB ) + 2.0;
  vec3 seatC = mix( vec3( 0.06, 0.08, 0.15 ), vec3( 0.14, 0.04, 0.045 ), step( 0.6, fract( uTramSeed * 0.37 ) ) );
  vec3 steel = vec3( 0.2, 0.2, 0.195 );
  vec3 nn; float c;
  // far overhead rail
  c = tramRail( ro, rd, vec2( - 0.42, 1.98 ), 0.016, w0 * ( 1.0 + tfar / camD ), nn );
  L = mix( L, tramLit( steel, nn, Ed, En ), c );
  for ( int j = 0; j < 12; j ++ ) {
    if ( float( j ) > nk ) break;
    float k = kB - dk + dk * float( j );
    float z0 = k * TS_P, zm = z0 + 0.5 * TS_P;
    if ( cab && zm < 2.65 ) continue;
    float tz = clamp( ( zm - ro.z ) / rd.z, tin, tend );
    float wc = w0 * ( 1.0 + tz / camD );
    bool seat = tramSeatCell( zm, body );
    float f = mod( k, 2.0 ) < 0.5 ? 1.0 : - 1.0;
    float zb = f > 0.0 ? z0 + 0.04 : z0 + TS_P - 0.04;
    float dz = zm - tramDoorZ( zm, body );
    bool doorCell = !seat && abs( dz ) < 1.25;
    // grab poles between back-to-back seats every other pair, on alternate sides of the
    // aisle; one pole in the middle of each doorway
    float pk = mod( k, 8.0 );
    bool poleFar = seat && pk < 0.5, poleNear = seat && abs( pk - 4.0 ) < 0.5;
    // far seats, far pole
    if ( seat ) {
      tramSeats( L, ro, rd, - 1.0, k, zb, f, wc, seatC, Ed, En );
      if ( poleFar ) { c = tramPole( ro, rd, vec2( - 0.36, z0 ), 0.018, wc, nn ); L = mix( L, tramLit( steel, nn, Ed, En ), c ); }
    }
    // standing in the aisle and at the doors
    for ( int i = 0; i < 2; i ++ ) {
      float h = tramHash( vec3( k, float( i ) + 5.0, uTramSeed ) );
      float pr = doorCell ? 0.45 : seat && i == 0 ? 0.12 : 0.0;
      if ( h < pr ) {
        float hx = fract( h * 13.7 ), hz = fract( h * 7.9 );
        float x = doorCell ? ( hx - 0.5 ) * 1.3 : ( hx - 0.5 ) * 0.24;
        if ( float( i ) > 0.5 && doorCell ) x = - x;
        vec3 sp = vec3( x, TS_YF, z0 + 0.2 + 0.4 * hz );
        tramStanding( L, ro, rd, sp, hz > 0.5 ? 1.0 : - 1.0, 0.94 + 0.12 * fract( h * 31.0 ), fract( h * 17.3 ), wc, Ed, En );
      }
    }
    if ( doorCell && abs( dz ) < 0.4 ) {
      c = tramPole( ro, rd, vec2( 0.0, zm - dz ), 0.019, wc, nn ); L = mix( L, tramLit( steel, nn, Ed, En ), c );
    }
    // near pole, near seats
    if ( seat ) {
      if ( poleNear ) { c = tramPole( ro, rd, vec2( 0.36, z0 ), 0.018, wc, nn ); L = mix( L, tramLit( steel, nn, Ed, En ), c ); }
      tramSeats( L, ro, rd, 1.0, k, zb, f, wc, seatC, Ed, En );
    }
  }
  c = tramRail( ro, rd, vec2( 0.42, 1.98 ), 0.016, w0 * ( 1.0 + tin / camD ), nn );
  L = mix( L, tramLit( steel, nn, Ed, En ), c );
  // beyond the traced cells (grazing views): the saloon fades into its average
  float fade = smoothstep( tcap, tcap * 1.6, tend );
  L = mix( L, tramLit( vec3( 0.12 ), vec3( 0.7, 0.7, 0.0 ), Ed, En ), fade * 0.7 );
  return L;
}
`;

/** Metallic silver paint with a clear coat; dark vertex colours stay dielectric trim. */
export function makeBodyMaterial(uni) {
  const m = new THREE.MeshPhysicalMaterial({
    name: 'trams.body', color: C(1, 1, 1), vertexColors: true,
    metalness: 0.7, roughness: 0.3, clearcoat: 0.55, clearcoatRoughness: 0.07,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni, { uTramNight: U.uNight, uTramGain: { value: 1 } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTramP;\nvarying vec3 vTramZ;\nvarying vec2 vTramUv;')
      .replace('#include <project_vertex>', `#include <project_vertex>
	vTramP = transformed;
	vTramUv = uv;
	vTramZ = normalize( ( modelViewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTramP;\nvarying vec3 vTramZ;\nvarying vec2 vTramUv;')
      .replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>\n${COMMON_GLSL}\n${REFL_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	// silver paint (bright vertex colours) vs dark trim
	float tramPaint = smoothstep( 0.08, 0.3, max( vColor.r, max( vColor.g, vColor.b ) ) );
	// road film: the lower body and the skirt a little duller and browner, faint streaks
	// running down from the window corners, dust on the roof
	float tramGrime;
	{
		vec3 bp = vTramP;
		float low = 1.0 - smoothstep( 0.18, 0.9, bp.y );
		float under = smoothstep( 0.97, 0.6, bp.y ) * step( 0.3, bp.y );
		float streak = smoothstep( 0.55, 0.95, tramNoise( bp.z * 31.0 ) ) * ( 0.4 + 0.6 * tramNoise( bp.z * 3.1 + 7.0 ) );
		float roof = smoothstep( 3.15, 3.3, bp.y ) * ( 0.5 + 0.5 * tramNoise( bp.z * 1.7 + bp.x * 3.0 ) );
		tramGrime = clamp( 0.07 * low + 0.06 * under * streak + 0.12 * roof, 0.0, 1.0 );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.12, 0.105, 0.09 ), tramGrime * tramPaint );
		// road dust greying the black skirt, the bogies and the wheels
		float dust = ( 1.0 - tramPaint ) * ( 1.0 - smoothstep( 0.15, 0.5, bp.y ) ) * ( 0.7 + 0.3 * tramNoise( bp.z * 4.0 ) );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.06, 0.054, 0.046 ), dust * 0.5 );
	}
	// joints between the lower side panels (under the window pillars), a few mm wide
	float tramSeam = 0.0;
	if ( vTramUv.y > 40.0 ) {
		float zc = vTramUv.x - ( vTramUv.x - vTramP.z > 50.0 ? 100.0 : 0.0 );
		float aa = max( fwidth( vTramP.z ), 1e-4 );
		tramSeam = ( 1.0 - smoothstep( 0.0035 - aa, 0.0035 + aa, abs( vTramP.z - zc ) ) ) * min( 1.0, 0.007 / aa );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.015 ), tramSeam );
		tramPaint *= 1.0 - tramSeam;
	}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
	roughnessFactor = mix( 0.5, roughnessFactor + 0.25 * tramGrime, tramPaint );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor *= tramPaint * ( 1.0 - 1.5 * tramGrime );`)
      // the panels are not perfectly flat: the clear coat's reflection wavers along the car
      .replace('#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>
	{
		float rip = ( tramNoise( vTramP.z * 1.3 + 3.0 ) - 0.5 ) * 0.012 + ( tramNoise( vTramP.z * 6.0 + vTramP.y * 2.0 ) - 0.5 ) * 0.004;
		clearcoatNormal = normalize( clearcoatNormal + vTramZ * rip * ( 1.0 - abs( dot( clearcoatNormal, vTramZ ) ) ) );
	}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.clearcoat *= tramPaint;`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	{
		vec3 tramRc = transformDirectionByInverseViewMatrix( reflect( - geometryViewDir, geometryClearcoatNormal ), viewMatrix );
		float tramA;
		vec3 tramH = tramStreetRefl( tramWorldPos(), tramRc, tramA );
		clearcoatRadiance = mix( tramTone( clearcoatRadiance, tramRc.y ), tramH, tramA );
	}`);
  };
  m.customProgramCacheKey = () => 'trams.body.v5';
  return m;
}

/** Side glazing: flush tinted panes over the traced saloon (see the header); vertex colour
 *  black = black frit. uv.x > 50 marks a centre body (its glass uv runs from 100). */
export function makeGlassMaterial(name, uni, gain = { value: 1 }) {
  const m = new THREE.MeshPhysicalMaterial({
    name, color: C(0.004, 0.004, 0.004), vertexColors: true, metalness: 0, roughness: 0.04, ior: 1.65,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni, { uTramNight: U.uNight, uTramGain: gain });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;\nvarying vec3 vTramP;\nvarying vec3 vTramE;\nvarying vec3 vTramZ;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTramUv = uv;')
      .replace('#include <project_vertex>', `#include <project_vertex>
	vTramP = transformed;
	vTramE = ( cameraPosition - modelMatrix[ 3 ].xyz ) * mat3( modelMatrix ) - transformed;
	vTramZ = normalize( ( modelViewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;\nvarying vec3 vTramP;\nvarying vec3 vTramE;\nvarying vec3 vTramZ;')
      .replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>\n${COMMON_GLSL}\n${REFL_GLSL}\n${SALOON_GLSL}`)
      // coated laminated glazing: a little more reflectance than one plain surface
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.specularColor *= 1.4;
	material.specularColorBlended = material.specularColor;`)
      // the street, as last frame saw it, mirrored in the panes (the environment elsewhere);
      // the panes are not perfectly flat, so the mirrored lines bend a little along the car
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	{
		float tramRip = ( tramNoise( vTramP.z * 0.9 + 11.0 ) - 0.5 ) * 0.008 + ( tramNoise( vTramP.z * 3.7 + vTramP.y * 1.3 ) - 0.5 ) * 0.003;
		vec3 tramNr = normalize( geometryNormal + vTramZ * tramRip * ( 1.0 - abs( dot( geometryNormal, vTramZ ) ) ) );
		vec3 tramR = transformDirectionByInverseViewMatrix( reflect( - geometryViewDir, tramNr ), viewMatrix );
		float tramA;
		vec3 tramH = tramStreetRefl( tramWorldPos(), tramR, tramA );
		radiance = mix( tramTone( radiance, tramR.y ), tramH, tramA );
	}`)
      // the saloon through the pane: daylight from the windows (and the sun on this side),
      // the ceiling lights after dark; tinted, less what the outer face reflects
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
	{
		float tramPane = smoothstep( 0.3, 0.7, vColor.g );
		if ( tramPane > 0.0 ) {
			vec3 tramRdW = inverseTransformDirection( - geometryViewDir, viewMatrix );
			vec3 tramEdir = reflectedLight.directDiffuse * PI / max( material.diffuseContribution, vec3( 1e-4 ) );
			vec3 tramEd = ( irradiance + iblIrradiance + 0.3 * tramEdir ) * ( 0.42 * RECIPROCAL_PI );
			float tramEn = uTramNight * uTramGain * 0.022 * RECIPROCAL_PI;
			float tramCamD = max( length( vTramE ), 0.5 );
			float tramW = max( length( fwidth( vTramP ) ), 0.002 );
			float tramBody = step( 50.0, vTramUv.x - vTramP.z );
			vec3 tramL = tramSaloon( vTramP, normalize( - vTramE ), tramRdW, tramW, tramCamD, tramBody, tramEd, tramEn );
			float tramNV = saturate( dot( geometryNormal, geometryViewDir ) );
			float tramF = 0.06 + 0.94 * pow( 1.0 - tramNV, 5.0 );
			totalEmissiveRadiance += tramPane * tramL * TS_T * ( 1.0 - tramF );
		}
	}`);
  };
  m.customProgramCacheKey = () => 'trams.glass.v12';
  return m;
}

/** The cab seen through the windscreen, traced per pixel in the body frame (x right, y up
 *  from the rail, −z forward; the glass lies at z ≈ 0–0.5): a dark console across the cab
 *  with the driver's binnacle in the middle, the driver (leading cab only) on a dark seat,
 *  grey walls and a dim ceiling, the cab's side windows showing the street (environment)
 *  and the door to the saloon in the back wall. Every edge is softened over the pixel
 *  footprint `w` (m), so nothing shimmers far away. E = the cab's irradiance / π. */
const CAB_GLSL = /* glsl */ `
uniform float uTramDriver;
// light falls in through the windscreen (ahead and above) and the side windows
float tramShade( vec3 n ) { return 0.3 + 0.7 * max( dot( n, vec3( 0.0, 0.48, - 0.88 ) ), 0.0 ) + 0.2 * abs( n.x ); }
vec3 tramCab( vec3 ro, vec3 rd, vec3 rdW, float w, vec3 E ) {
  rd.z = max( rd.z, 1e-3 );
  vec3 ard = max( abs( rd ), vec3( 1e-4 ) );
  float tx = ( 1.22 - sign( rd.x ) * ro.x ) / ard.x;
  float ty = ( rd.y < 0.0 ? ro.y - 0.6 : 2.5 - ro.y ) / ard.y;
  float tz = ( 2.65 - ro.z ) / rd.z;
  vec3 L;
  if ( tz <= tx && tz <= ty ) {
    // back wall: grey panels and the door to the saloon, whose window shows the saloon
    // (daylight from its many windows; its lights at night); darker into the corners
    vec3 p = ro + rd * tz;
    float door = tramRect( p.xy, vec2( 0.3, 0.6 ), vec2( 1.0, 2.2 ), w );
    float win = tramRect( p.xy, vec2( 0.42, 1.45 ), vec2( 0.88, 2.04 ), w );
    float ao = ( 0.55 + 0.45 * smoothstep( 0.0, 0.4, 1.22 - abs( p.x ) ) ) * ( 0.6 + 0.4 * smoothstep( 0.0, 0.35, 2.5 - p.y ) );
    vec3 wall = mix( vec3( 0.42, 0.42, 0.4 ), vec3( 0.3, 0.3, 0.3 ), door ) * E * 0.85 * ao;
    vec3 saloon = vec3( 0.3, 0.29, 0.28 ) * E * 0.75 + vec3( 1.0, 0.94, 0.85 ) * ( uTramNight * uTramGain * 0.00005 );
    L = mix( wall, saloon, win );
  } else if ( tx < ty ) {
    // side wall: the cab's side window shows the street, the pillar ahead of it is dark
    vec3 p = ro + rd * tx;
    float win = tramRect( p.zy, vec2( 1.28, 0.98 ), vec2( 2.52, 2.42 ), w );
    float ao = ( 0.6 + 0.4 * smoothstep( 0.0, 0.35, 2.5 - p.y ) ) * ( 0.6 + 0.4 * smoothstep( 0.0, 0.4, 2.65 - p.z ) );
    vec3 wall = vec3( 0.36, 0.36, 0.35 ) * E * mix( 0.9, 0.5, saturate( p.z / 2.65 ) ) * ao;
    L = mix( wall, tramEnv( rdW ) * vec3( 0.5, 0.57, 0.58 ), win );
  } else if ( rd.y > 0.0 ) {
    // ceiling: lit only from below, darker into the corners
    vec3 p = ro + rd * ty;
    float ao = ( 0.55 + 0.45 * smoothstep( 0.0, 0.4, 1.22 - abs( p.x ) ) ) * ( 0.6 + 0.4 * smoothstep( 0.0, 0.4, 2.65 - p.z ) );
    L = vec3( 0.55, 0.55, 0.54 ) * E * 0.4 * ao;
  } else {
    L = vec3( 0.05 ) * E * 0.5;                    // floor
  }
  if ( uTramDriver > 0.5 ) {
    // seat back and headrest (mostly hidden by the driver)
    vec3 n;
    float c = tramEll( ro, rd, vec3( 0.0, 1.38, 1.66 ), vec3( 0.22, 0.32, 0.06 ), w, n );
    L = mix( L, vec3( 0.03 ) * E * tramShade( n ) * 0.7, c );
    c = tramEll( ro, rd, vec3( 0.0, 1.86, 1.62 ), vec3( 0.11, 0.09, 0.05 ), w, n );
    L = mix( L, vec3( 0.03 ) * E * tramShade( n ) * 0.7, c );
    // the driver: uniform shirt (arms, torso, broad shoulders), neck, head with the hair
    // on top and at the back
    vec3 shirt = vec3( 0.2, 0.26, 0.34 ), skin = vec3( 0.33, 0.22, 0.165 );
    c = tramEll( ro, rd, vec3( - 0.215, 1.46, 1.4 ), vec3( 0.055, 0.16, 0.065 ), w, n );
    L = mix( L, shirt * E * tramShade( n ) * 0.85, c );
    c = tramEll( ro, rd, vec3( 0.215, 1.46, 1.4 ), vec3( 0.055, 0.16, 0.065 ), w, n );
    L = mix( L, shirt * E * tramShade( n ) * 0.85, c );
    c = tramEll( ro, rd, vec3( 0.0, 1.38, 1.44 ), vec3( 0.185, 0.3, 0.12 ), w, n );
    L = mix( L, shirt * E * tramShade( n ), c );
    c = tramEll( ro, rd, vec3( 0.0, 1.6, 1.44 ), vec3( 0.235, 0.095, 0.115 ), w, n );
    L = mix( L, shirt * E * tramShade( n ), c );
    c = tramEll( ro, rd, vec3( 0.0, 1.74, 1.43 ), vec3( 0.05, 0.07, 0.05 ), w, n );
    L = mix( L, skin * E * tramShade( n ) * 0.7, c );
    c = tramEll( ro, rd, vec3( 0.0, 1.9, 1.4 ), vec3( 0.08, 0.108, 0.095 ), w, n );
    float hair = smoothstep( 0.3, 0.55, n.y + 0.8 * max( n.z, 0.0 ) + 0.35 * abs( n.x ) );
    L = mix( L, mix( skin, vec3( 0.03, 0.025, 0.022 ), hair ) * E * tramShade( n ), c );
  }
  // overhead console under the destination display: light grey plastic right behind the
  // screen, lit by the whole street through it
  vec2 po = ( ro + rd * ( ( 0.72 - ro.z ) / rd.z ) ).xy;
  float oc = tramRect( po, vec2( - 0.8, 2.12 ), vec2( 0.8, 2.7 ), w ) * step( ro.z, 0.72 );
  L = mix( L, vec3( 0.55, 0.55, 0.53 ) * E * mix( 1.0, 1.6, smoothstep( 2.12, 2.5, po.y ) ), oc );
  // console across the cab, the driver's binnacle in the middle
  vec2 pb = ( ro + rd * ( ( 0.6 - ro.z ) / rd.z ) ).xy;
  L = mix( L, vec3( 0.035 ) * E * 0.8, tramRect( pb, vec2( - 0.5, 0.0 ), vec2( 0.5, 1.5 ), w ) * step( ro.z, 0.6 ) );
  float yDeck = ro.y + rd.y * ( 0.85 - ro.z ) / rd.z;
  L = mix( L, vec3( 0.03 ) * E * 0.7, smoothstep( w, - w, yDeck - 1.34 ) );
  return L;
}
`;

/** Cab front glass: windscreen, trim and mask from uv (see WS_GLSL); the cab is traced
 *  behind the windscreen (CAB_GLSL). `driver`: the leading cab has its driver at the
 *  controls; `gain`: the library's night emissive gain. */
export function makeFrontMaterial(uni, { driver = true, gain = { value: 1 } } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    name: driver ? 'trams.front' : 'trams.frontTrail', color: C(1, 1, 1), metalness: 0, roughness: 0.03, ior: 1.52,
  });
  const drv = { value: driver ? 1 : 0 };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni, { uTramDriver: drv, uTramNight: U.uNight, uTramGain: gain });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;\nvarying vec3 vTramP;\nvarying vec3 vTramE;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTramUv = uv;')
      // body-frame position and the vector to the camera (the body's matrix is a rotation
      // and a translation)
      .replace('#include <project_vertex>', `#include <project_vertex>
	vTramP = transformed;
	vTramE = ( cameraPosition - modelMatrix[ 3 ].xyz ) * mat3( modelMatrix ) - transformed;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vTramUv;\nvarying vec3 vTramP;\nvarying vec3 vTramE;\n${WS_GLSL}`)
      .replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>\n${COMMON_GLSL}\n${REFL_GLSL}\n${CAB_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	float tramD = tramWsDist( vTramUv );
	float tramAA = max( fwidth( tramD ), 1e-4 );
	float tramWs = 1.0 - smoothstep( -tramAA, tramAA, tramD );                  // clear windscreen
	float tramTrim = ( 1.0 - tramWs ) * ( 1.0 - smoothstep( 0.04 - tramAA, 0.04 + tramAA, tramD ) );
	float tramFoot = max( length( fwidth( vTramP ) ), 0.003 );                  // m per pixel on the glass
	// the windscreen itself is clear (a trace of road film): the cab behind it is traced
	// after the lighting; the mask: dark tinted glass over a black backing
	diffuseColor.rgb = mix( vec3( 0.006, 0.009, 0.02 ), vec3( 0.004 ), tramWs );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.38, 0.395, 0.42 ), tramTrim );`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
	roughnessFactor = mix( roughnessFactor, 0.3, tramTrim );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor = mix( metalnessFactor, 0.7, tramTrim );`)
      // reflection: the windscreen is coated laminated glass whose faces and solar-control
      // film reflect about a fifth of the light (a little blue), the mask only with its outer
      // face (the black backing behind it); the Fresnel rise to grazing stays physical
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.specularColor = mix( material.specularColor * mix( 1.2, 1.0, tramTrim ), vec3( 0.24, 0.275, 0.31 ), tramWs );
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );`)
      // the street mirrored in the glass: last frame's image where it can, else the
      // environment with its bare street toned down
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	{
		vec3 tramR = transformDirectionByInverseViewMatrix( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
		float tramA;
		vec3 tramH = tramStreetRefl( tramWorldPos(), tramR, tramA );
		radiance = mix( tramTone( radiance, tramR.y + 0.05 ), tramH, tramA );
	}`)
      // the cab through the glass: lit by the daylight on the screen (or the saloon and the
      // instruments at night), tinted, with a shade band along the top of the screen
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
	{
		vec3 tramRdW = inverseTransformDirection( - geometryViewDir, viewMatrix );
		// direct light on the screen (sun, lamps; shadowed), recovered from its faint road film
		vec3 tramEdir = reflectedLight.directDiffuse * PI / max( material.diffuseContribution, vec3( 1e-4 ) );
		vec3 tramE = ( irradiance + iblIrradiance + 0.25 * tramEdir ) * ( 0.6 * RECIPROCAL_PI ) + vec3( 0.75, 0.85, 1.0 ) * ( uTramNight * uTramGain * 0.00003 );
		vec3 tramL = tramCab( vTramP, normalize( - vTramE ), tramRdW, tramFoot, tramE );
		float tramNV = saturate( dot( geometryNormal, geometryViewDir ) );
		float tramF = 0.27 + 0.73 * pow( 1.0 - tramNV, 5.0 );
		vec3 tramT = vec3( 0.52, 0.69, 0.82 ) * mix( 1.0, 0.85, smoothstep( 2.2, 2.6, vTramUv.y ) );
		totalEmissiveRadiance += tramWs * tramL * tramT * ( 1.0 - tramF );
	}`);
  };
  m.customProgramCacheKey = () => 'trams.front.v5';
  return m;
}

/** Pantograph frame: dark grey paint (vertex colour). */
export function makeMetalMaterial() {
  return new THREE.MeshStandardMaterial({ name: 'trams.metal', color: C(1, 1, 1), vertexColors: true, metalness: 0.3, roughness: 0.45 });
}
