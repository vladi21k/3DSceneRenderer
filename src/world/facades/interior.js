import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Interior-mapped window glass.
//
// A standard PBR glass surface (F0 0.04, near-mirror roughness) whose reflections are
// completed by an analytic "street" model (opposite facades with their windows, the
// paving and the street trees, falling back to the sky / environment map above the
// rooflines), and whose transmitted light is a fake room traced per pixel:
// a box ~4 m deep (homes) or ~7 m (shops) with painted walls, floor, ceiling, a few
// furniture boxes, curtains / sheers / blinds just behind the glass, a daylight falloff
// with depth, sun patches through the aperture, and warm lamps at dusk.
//
// Per-vertex attributes (all in the facade frame of the lot, metres):
//   aRoomP  (x, y, z, halfWinW)   ray origin in room space (x from the left wall, y up from
//                                 the room floor, z depth behind the glass), window half width
//   aRoomS  (W, H, D, baseH)      room size, and height of the room floor above the paving
//   aWin    (seed, lit, drape, kind)  kind: 0 home, 1 shop, 2 stairwell/door; +4 = no glass
//   aFac    (angle, streetW + recess, winY0, winY1)  facade tangent angle (world), distance
//                                 to the opposite facade (integer part) plus the opening's
//                                 recess (fraction), window sill / head heights in room space

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

float fh1( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
float fh2( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
vec3 fh3( float p ) { return vec3( fh1( p ), fh1( p + 17.13 ), fh1( p + 41.71 ) ); }
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( fh2( i ), fh2( i + vec2( 1, 0 ) ), f.x ), mix( fh2( i + vec2( 0, 1 ) ), fh2( i + vec2( 1, 1 ) ), f.x ), f.y );
}

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

const vec3 WALLS[6] = vec3[6]( vec3( 0.78, 0.74, 0.64 ), vec3( 0.80, 0.79, 0.76 ), vec3( 0.80, 0.71, 0.52 ),
  vec3( 0.60, 0.66, 0.70 ), vec3( 0.64, 0.70, 0.60 ), vec3( 0.80, 0.65, 0.55 ) );
const vec3 FABRIC[8] = vec3[8]( vec3( 0.55, 0.50, 0.42 ), vec3( 0.25, 0.28, 0.33 ), vec3( 0.42, 0.14, 0.12 ), vec3( 0.20, 0.30, 0.22 ),
  vec3( 0.60, 0.56, 0.50 ), vec3( 0.12, 0.12, 0.13 ), vec3( 0.45, 0.35, 0.25 ), vec3( 0.30, 0.36, 0.48 ) );
const vec3 DRAPES[6] = vec3[6]( vec3( 0.82, 0.79, 0.70 ), vec3( 0.86, 0.85, 0.82 ), vec3( 0.72, 0.62, 0.46 ),
  vec3( 0.50, 0.16, 0.14 ), vec3( 0.46, 0.50, 0.36 ), vec3( 0.66, 0.60, 0.55 ) );
const vec3 GOODS[8] = vec3[8]( vec3( 0.75, 0.12, 0.10 ), vec3( 0.10, 0.25, 0.55 ), vec3( 0.85, 0.75, 0.20 ), vec3( 0.12, 0.45, 0.20 ),
  vec3( 0.85, 0.85, 0.82 ), vec3( 0.08, 0.08, 0.09 ), vec3( 0.80, 0.45, 0.15 ), vec3( 0.55, 0.35, 0.55 ) );

struct Hit { float t; vec3 n; vec3 alb; float glow; };

void fTryBox( inout Hit h, vec3 ro, vec3 ird, vec3 bmin, vec3 bmax, vec3 alb ) {
  vec2 r = fBox( ro, ird, bmin, bmax );
  if ( r.x < r.y && r.x > 0.0 && r.x < h.t ) { h.t = r.x; h.n = fBoxN( ro, ird, bmin, bmax, r.x ); h.alb = alb; h.glow = 0.0; }
}

// vertical cylinder (mannequin torso / column), centre c (xz), radius r, y range
void fTryCyl( inout Hit h, vec3 ro, vec3 rd, vec2 c, float r, float y0, float y1, vec3 alb ) {
  vec2 o = ro.xz - c, d = rd.xz;
  float a = dot( d, d ), b = dot( o, d ), cc = dot( o, o ) - r * r;
  float disc = b * b - a * cc;
  if ( disc < 0.0 ) return;
  float t = ( -b - sqrt( disc ) ) / a;
  float y = ro.y + rd.y * t;
  if ( t > 0.0 && t < h.t && y > y0 && y < y1 ) { h.t = t; vec2 n = normalize( o + d * t ); h.n = vec3( n.x, 0.0, n.y ); h.alb = alb; h.glow = 0.0; }
}

// Goods on shelving: rows of items of varied colour and height on a wall face.
vec3 fShelves( vec3 base, float along, float y, float seed, float cellW, float rowH, float y0, float y1, float sat, out float shelf ) {
  shelf = 0.0;
  if ( y < y0 || y > y1 ) return base;
  float row = floor( ( y - y0 ) / rowH ), fy = fract( ( y - y0 ) / rowH );
  float cell = floor( along / cellW );
  float hs = fh2( vec2( cell, row ) + seed * 7.0 );
  vec3 gc = mix( vec3( 0.45, 0.42, 0.38 ), GOODS[ int( hs * 7.99 ) ], sat ) * ( 0.65 + 0.35 * fh1( cell + row * 3.1 ) );
  float filled = step( fy, 0.3 + 0.6 * fh1( cell * 1.7 + row + seed ) ) * step( 0.07, fy ) * step( 0.2, fh1( cell * 0.37 + row * 1.3 + seed ) );
  float gap = step( 0.12, fract( along / cellW ) );
  shelf = step( fy, 0.07 );
  return shelf > 0.5 ? vec3( 0.58, 0.55, 0.50 ) : mix( base * 0.6, gc, filled * gap );
}

// The fake room. ro/rd in room space (rd.z > 0 goes into the room).
vec3 fRoom( vec3 ro, vec3 rd, vec3 S, vec4 win, vec4 fac, float halfWin, vec3 Eday, vec3 sunR, vec3 sunC ) {
  float seed = win.x;
  float kind = mod( win.w, 4.0 );
  bool shop = kind > 0.5 && kind < 1.5;
  bool stair = kind > 1.5;
  float stype = floor( fh1( seed * 11.3 + 0.7 ) * 6.0 ); // shop type
  vec3 ird = 1.0 / rd;
  vec3 tB = ( step( 0.0, rd ) * S - ro ) * ird;
  Hit h;
  h.t = min( min( tB.x, tB.y ), tB.z );
  vec3 p = ro + rd * h.t;
  h.glow = 0.0;
  vec3 rnd = fh3( seed * 97.0 + 3.0 );
  vec3 wall = WALLS[ int( rnd.x * 5.99 ) ];
  if ( shop ) {
    wall = stype < 0.5 ? vec3( 0.82, 0.81, 0.78 ) : stype < 1.5 ? vec3( 0.74, 0.72, 0.68 ) : stype < 2.5 ? vec3( 0.55, 0.36, 0.24 )
         : stype < 3.5 ? vec3( 0.16, 0.11, 0.08 ) : stype < 4.5 ? vec3( 0.86, 0.86, 0.85 ) : vec3( 0.62, 0.50, 0.38 );
  }
  if ( stair ) wall = vec3( 0.74, 0.70, 0.62 );

  if ( h.t == tB.z ) {
    h.n = vec3( 0, 0, -1 );
    h.alb = wall * 0.92;
    float dx = mix( 0.3, S.x - 1.2, rnd.y );
    if ( !shop && p.x > dx && p.x < dx + 0.9 && p.y < 2.1 ) h.alb = vec3( 0.10, 0.09, 0.08 ); // doorway
    float px = mix( 0.4, S.x - 1.4, rnd.z );
    if ( !shop && !stair && p.x > px && p.x < px + 0.7 && p.y > 1.35 && p.y < 1.85 ) {
      vec3 pc = fh3( seed * 13.0 + 5.0 );
      h.alb = ( p.x - px < 0.04 || px + 0.7 - p.x < 0.04 || p.y - 1.35 < 0.04 || 1.85 - p.y < 0.04 ) ? vec3( 0.12, 0.09, 0.06 ) : pc * 0.6 + 0.1;
    }
    if ( stair ) h.alb *= 0.8 + 0.2 * step( 0.5, fract( p.y / 0.17 ) ); // stair treads seen through the fanlight
  } else if ( h.t == tB.x ) {
    h.n = vec3( -sign( rd.x ), 0, 0 );
    h.alb = wall * 0.85;
  } else if ( rd.y > 0.0 ) {
    h.n = vec3( 0, -1, 0 );
    h.alb = vec3( 0.80, 0.79, 0.76 );
    if ( shop ) {
      if ( stype > 3.5 && stype < 4.5 ) {
        vec2 c = fract( p.xz / vec2( 1.2, 1.5 ) ) - 0.5;      // pharmacy: light panels
        h.glow = step( abs( c.x ), 0.24 ) * step( abs( c.y ), 0.2 ) * 2.4;
      } else {
        vec2 c = fract( p.xz / vec2( 1.1, 1.3 ) ) - 0.5;      // recessed downlights
        h.glow = smoothstep( 0.09, 0.05, length( c ) ) * 4.0;
      }
    }
  } else {
    h.n = vec3( 0, 1, 0 );
    float ft = fh1( seed * 7.0 + 11.0 );
    if ( shop && ( stype < 1.5 || stype > 3.5 && stype < 4.5 ) ) {
      vec2 g = fract( p.xz / 0.6 );
      h.alb = mix( vec3( 0.60, 0.58, 0.54 ), vec3( 0.32, 0.30, 0.28 ), step( 0.97, max( g.x, g.y ) ) );
    } else if ( ft < 0.5 && !shop ) {
      // patterned cement tiles
      vec2 g = p.xz / 0.2;
      vec2 f = fract( g ) - 0.5;
      float motif = step( length( f ), 0.32 ) * step( 0.5, fh2( floor( g * 0.5 ) + seed ) );
      h.alb = mix( vec3( 0.52, 0.48, 0.42 ), vec3( 0.30, 0.22, 0.18 ), motif * 0.6 );
      h.alb *= 0.85 + 0.15 * step( 0.04, min( abs( f.x ), abs( f.y ) ) );
    } else {
      // wooden boards
      vec2 g = vec2( p.x / 0.09, p.z / 0.6 + floor( p.x / 0.09 ) * 0.37 );
      h.alb = vec3( 0.36, 0.23, 0.13 ) * ( 0.75 + 0.35 * fh2( floor( g ) ) );
    }
  }

  // ---- fittings
  vec3 f1 = fh3( seed * 31.0 + 1.0 ), f2 = fh3( seed * 53.0 + 2.0 );
  if ( shop ) {
    if ( stype < 0.5 ) {
      // clothing: island tables, garment rails, mannequins in the window
      fTryBox( h, ro, ird, vec3( S.x * 0.5 - 0.6, 0.0, 2.2 ), vec3( S.x * 0.5 + 0.6, 0.8, 3.0 ), vec3( 0.55, 0.45, 0.38 ) );
      fTryCyl( h, ro, rd, vec2( S.x * ( 0.3 + 0.15 * f1.x ), 0.75 ), 0.17, 0.35, 1.45, GOODS[ int( f1.y * 7.99 ) ] * 0.7 );
      fTryCyl( h, ro, rd, vec2( S.x * ( 0.3 + 0.15 * f1.x ), 0.75 ), 0.1, 1.45, 1.72, vec3( 0.80, 0.78, 0.74 ) );
      if ( f1.z > 0.4 ) {
        fTryCyl( h, ro, rd, vec2( S.x * ( 0.62 + 0.15 * f2.x ), 0.8 ), 0.17, 0.35, 1.45, GOODS[ int( f2.y * 7.99 ) ] * 0.7 );
        fTryCyl( h, ro, rd, vec2( S.x * ( 0.62 + 0.15 * f2.x ), 0.8 ), 0.1, 1.45, 1.72, vec3( 0.80, 0.78, 0.74 ) );
      }
    } else if ( stype < 1.5 ) {
      fTryBox( h, ro, ird, vec3( S.x * 0.5 - 0.7 + f1.x * 0.4, 0.0, 0.8 ), vec3( S.x * 0.5 + 0.4 + f1.x * 0.4, 0.8, 1.6 ), vec3( 0.7, 0.68, 0.64 ) );
      fTryBox( h, ro, ird, vec3( 1.0, 0.0, 2.6 ), vec3( S.x - 1.0, 1.7, 3.0 ), vec3( 0.62, 0.60, 0.56 ) );
    } else if ( stype < 2.5 ) {
      // cafe / bakery: counter with a lit display, stools
      fTryBox( h, ro, ird, vec3( S.x * 0.12, 0.0, S.z - 2.4 ), vec3( S.x * 0.88, 1.05, S.z - 1.7 ), vec3( 0.30, 0.20, 0.13 ) );
      fTryBox( h, ro, ird, vec3( S.x * 0.15, 1.05, S.z - 2.35 ), vec3( S.x * 0.55, 1.35, S.z - 2.0 ), vec3( 0.75, 0.62, 0.42 ) );
      fTryBox( h, ro, ird, vec3( S.x * 0.3, 0.0, 1.2 ), vec3( S.x * 0.3 + 0.7, 0.75, 1.9 ), vec3( 0.22, 0.15, 0.10 ) );
      fTryBox( h, ro, ird, vec3( S.x * 0.65, 0.0, 1.4 ), vec3( S.x * 0.65 + 0.7, 0.75, 2.1 ), vec3( 0.22, 0.15, 0.10 ) );
    } else if ( stype < 3.5 ) {
      // jewellery / optics: glass display cases along the walls
      fTryBox( h, ro, ird, vec3( 0.0, 0.0, 1.0 ), vec3( 0.55, 1.0, S.z - 1.0 ), vec3( 0.20, 0.14, 0.10 ) );
      fTryBox( h, ro, ird, vec3( S.x - 0.55, 0.0, 1.0 ), vec3( S.x, 1.0, S.z - 1.0 ), vec3( 0.20, 0.14, 0.10 ) );
      fTryBox( h, ro, ird, vec3( S.x * 0.5 - 0.5, 0.0, 0.5 ), vec3( S.x * 0.5 + 0.5, 1.1, 0.95 ), vec3( 0.20, 0.14, 0.10 ) );
    } else if ( stype < 4.5 ) {
      fTryBox( h, ro, ird, vec3( S.x * 0.2, 0.0, S.z - 2.2 ), vec3( S.x * 0.8, 1.0, S.z - 1.7 ), vec3( 0.86, 0.86, 0.84 ) );
      fTryBox( h, ro, ird, vec3( S.x * 0.5 - 0.35, 0.0, 1.4 ), vec3( S.x * 0.5 + 0.35, 1.5, 2.6 ), vec3( 0.86, 0.86, 0.84 ) );
    } else {
      // shoes: low benches and a central display
      fTryBox( h, ro, ird, vec3( S.x * 0.5 - 0.8, 0.0, 1.8 ), vec3( S.x * 0.5 + 0.8, 0.45, 2.4 ), vec3( 0.25, 0.20, 0.17 ) );
      fTryBox( h, ro, ird, vec3( S.x * 0.5 - 0.4, 0.0, 0.6 ), vec3( S.x * 0.5 + 0.4, 0.9, 1.1 ), vec3( 0.80, 0.78, 0.74 ) );
    }
  } else if ( !stair ) {
    // sofa / bed / sideboard against the back wall, cabinet on a side wall, a table
    float len = 1.4 + f1.x * 0.9;
    vec3 a0 = vec3( mix( 0.2, S.x - len - 0.2, f1.y ), 0.0, S.z - 0.9 );
    fTryBox( h, ro, ird, a0, a0 + vec3( len, 0.75 + f1.z * 0.35, 0.9 ), FABRIC[ int( f1.z * 7.99 ) ] );
    float side = step( 0.5, f2.x );
    vec3 a1 = vec3( side * ( S.x - 0.55 ), 0.0, 0.9 + f2.y * 1.2 );
    fTryBox( h, ro, ird, a1, a1 + vec3( 0.55, 1.8 + f2.z * 0.4, 1.0 ), vec3( 0.20, 0.13, 0.08 ) * ( 0.7 + f2.z ) );
    vec3 a2 = vec3( S.x * 0.5 - 0.6 + f2.y * 0.3, 0.72, 1.6 + f1.x * 0.8 );
    fTryBox( h, ro, ird, a2, a2 + vec3( 1.2, 0.04, 0.8 ), vec3( 0.28, 0.18, 0.11 ) );
  }
  p = ro + rd * h.t;

  // ---- merchandise on walls and fittings
  if ( shop && h.glow == 0.0 ) {
    bool vert = abs( h.n.x ) > 0.5 || abs( h.n.z ) > 0.5;
    float along = abs( h.n.x ) > 0.5 ? p.z : p.x;
    float shelf;
    if ( vert ) {
      if ( stype < 0.5 ) {
        // garments on rails (side walls), folded stacks above
        if ( p.y > 0.5 && p.y < 1.65 && abs( h.n.x ) > 0.5 ) {
          float g = floor( along / 0.07 );
          vec3 gc = mix( vec3( 0.5, 0.48, 0.45 ), GOODS[ int( fh1( g + seed ) * 7.99 ) ], 0.55 ) * ( 0.6 + 0.4 * fh1( g * 1.3 ) );
          float hem = 0.5 + 0.35 * fh1( g * 2.1 + seed );
          h.alb = p.y > hem ? gc * ( 0.8 + 0.2 * sin( along * 90.0 ) ) : h.alb;
        }
        h.alb = fShelves( h.alb, along, p.y, seed, 0.3, 0.35, 1.8, 2.5, 0.4, shelf );
      } else if ( stype < 1.5 ) {
        h.alb = fShelves( h.alb, along, p.y, seed, 0.09, 0.34, 0.2, 2.3, 0.55, shelf );
      } else if ( stype < 2.5 ) {
        if ( h.n.z < -0.5 && p.y > 1.7 && p.y < 2.5 && abs( p.x - S.x * 0.5 ) < S.x * 0.3 ) {
          // menu board
          float txt = step( 0.55, fh2( floor( vec2( p.x / 0.05, p.y / 0.06 ) ) + seed ) ) * step( 0.2, fract( p.y / 0.06 ) );
          h.alb = mix( vec3( 0.04, 0.04, 0.04 ), vec3( 0.8, 0.78, 0.7 ), txt * 0.6 );
        } else h.alb = fShelves( h.alb, along, p.y, seed, 0.06, 0.3, 1.1, 1.7, 0.35, shelf );
      } else if ( stype < 3.5 ) {
        // dark panelled walls with small lit display niches
        vec2 nf = fract( vec2( along / 0.7, ( p.y - 1.25 ) / 0.45 ) );
        if ( p.y > 1.25 && p.y < 2.15 && nf.x > 0.18 && nf.x < 0.82 && nf.y > 0.18 && nf.y < 0.82 ) { h.alb = vec3( 0.62, 0.58, 0.52 ); h.glow = 0.3; }
        else h.alb *= 0.85 + 0.15 * step( 0.04, fract( along / 0.7 ) );
      } else if ( stype < 4.5 ) {
        h.alb = fShelves( h.alb, along, p.y, seed, 0.055, 0.26, 0.2, 2.3, 0.65, shelf );
      } else {
        h.alb = fShelves( h.alb, along, p.y, seed, 0.32, 0.3, 0.3, 2.1, 0.35, shelf );
      }
    } else if ( h.n.y > 0.5 && p.y > 0.3 && stype > 2.5 && stype < 3.5 ) {
      // lit glass tops of the display cases, a few glints
      h.alb = vec3( 0.5 ); h.glow = 0.35 + 1.2 * step( 0.985, fh2( floor( p.xz / 0.035 ) + seed ) );
    } else if ( h.n.y > 0.5 && p.y > 0.3 ) {
      // goods on table tops
      float g = fh2( floor( p.xz / 0.18 ) + seed );
      h.alb = mix( h.alb, GOODS[ int( g * 7.99 ) ] * 0.6, step( 0.45, g ) * 0.8 );
    }
  }

  // ---- lighting in room space
  vec3 nn = h.n;
  float depth = p.z;
  float faceK = nn.y > 0.5 ? 1.25 : ( nn.y < -0.5 ? 0.55 : ( nn.z < -0.5 ? 0.75 : 0.9 ) );
  vec3 L = Eday * ( 0.05 + 0.32 * exp( -depth * 0.55 ) ) * faceK;
  // sun patch: project the point back to the window plane along the sun direction
  if ( sunR.z < -0.05 ) {
    float tw = -depth / sunR.z;
    vec2 q = p.xy + sunR.xy * tw;
    float inX = step( abs( q.x - S.x * 0.5 ), halfWin );
    float inY = step( fac.z, q.y ) * step( q.y, fac.w );
    float ndl = max( dot( nn, sunR ), 0.0 );
    L += sunC * inX * inY * ndl * 0.75;
  }
  // artificial light is in scene (physical) units: daylight horizontal illuminance is
  // ~3 here, so a lamp-lit room is ~0.005; the camera exposure rises ~900x at dusk.
  float litT = uNight * 0.58;
  float lit = 1.0 - smoothstep( litT - 0.03, litT + 0.03, win.y );
  if ( win.y < 0.035 ) lit = max( lit, 0.6 ); // a few rooms with the lights on during the day
  vec3 lampC = mix( vec3( 1.0, 0.70, 0.42 ), vec3( 1.0, 0.86, 0.70 ), fh1( seed * 3.3 ) );
  if ( shop ) {
    lampC = stype > 3.5 && stype < 4.5 ? vec3( 0.92, 0.96, 1.0 ) : stype > 1.5 && stype < 2.5 ? vec3( 1.0, 0.74, 0.46 ) : mix( vec3( 1.0, 0.84, 0.64 ), vec3( 0.96, 0.95, 0.92 ), step( 0.6, fh1( seed * 5.1 ) ) );
    // by day a perceptual boost keeps the interior readable behind the glass
    float dayK = max( 0.011, 0.15 * dot( Eday, vec3( 0.2126, 0.7152, 0.0722 ) ) ); // follows the daylight level
    float shopI = ( stype > 2.5 && stype < 3.5 ? 0.65 : 1.0 ) * mix( dayK, 0.0085, uNight );
    L += lampC * shopI * ( 0.6 + 0.4 * exp( -abs( p.y - S.y ) * 0.5 ) );
  } else if ( lit > 0.0 ) {
    vec3 lp = vec3( S.x * 0.5, S.y - 0.45, S.z * 0.5 );
    vec3 dl = lp - p;
    float d2 = dot( dl, dl );
    float ndl = max( dot( nn, normalize( dl ) ), 0.0 ) * 0.7 + 0.3;
    L += lampC * lit * ( stair ? 0.0035 : 0.0065 ) * ndl / ( 1.0 + d2 * 0.45 );
    if ( fh1( seed * 9.7 ) < 0.12 ) L += vec3( 0.25, 0.35, 0.6 ) * lit * 0.003 * ( 0.6 + 0.4 * sin( uTime * 7.0 + seed * 40.0 ) * sin( uTime * 2.3 ) ) / ( 1.0 + d2 );
  }
  float glowK = shop ? mix( max( 0.007, 0.08 * dot( Eday, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.007, uNight ) : 0.007;
  vec3 col = h.alb * L * RECIPROCAL_PI * 1.6 + h.glow * lampC * glowK;

  // pendant lamp shade (visible when lit)
  if ( !shop && lit > 0.0 ) {
    vec3 lp = vec3( S.x * 0.5, S.y - 0.45, S.z * 0.5 );
    float tl = dot( lp - ro, rd );
    if ( tl > 0.0 && tl < h.t ) {
      vec3 q = ro + rd * tl - lp;
      float shade = smoothstep( 0.2, 0.15, length( q.xz ) ) * step( -0.12, q.y ) * step( q.y, 0.05 );
      col = mix( col, lampC * lit * 0.02, shade );
    }
  }
  // cafe pendants
  if ( shop && stype > 1.5 && stype < 2.5 ) {
    for ( int i = 0; i < 3; i++ ) {
      vec3 lp = vec3( S.x * ( 0.25 + 0.25 * float( i ) ), S.y - 0.9, 1.6 + float( i ) * 0.4 );
      float tl = dot( lp - ro, rd );
      if ( tl > 0.0 && tl < h.t ) col += lampC * smoothstep( 0.11, 0.07, length( ro + rd * tl - lp ) ) * ( 0.3 * ( 1.0 - uNight ) + 0.03 * uNight );
    }
  }

  // ---- drapes just behind the glass
  float dtype = floor( win.z ), damt = fract( win.z );
  if ( dtype > 0.5 && rd.z > 1e-3 ) {
    float zc = 0.12;
    float tc = ( zc - ro.z ) / rd.z;
    vec2 c = ro.xy + rd.xy * tc;
    float xr = c.x - S.x * 0.5;
    vec3 dc = DRAPES[ int( fh1( seed * 4.1 ) * 5.99 ) ];
    vec3 back = lampC * lit * 0.004;
    vec3 front = Eday * 0.42;
    if ( dtype < 1.5 ) {
      float cover = halfWin * ( 1.0 - damt );
      if ( abs( xr ) > cover && tc < h.t ) {
        float fold = 0.72 + 0.28 * sin( c.x * 38.0 + seed * 20.0 ) * sin( c.x * 11.0 );
        col = dc * fold * ( front + back * 0.55 ) * RECIPROCAL_PI * 1.6;
      }
    } else if ( dtype < 2.5 ) {
      float fold = 0.8 + 0.2 * sin( c.x * 45.0 + seed * 10.0 );
      vec3 sheer = vec3( 0.86, 0.85, 0.80 ) * fold * ( front + back * 0.8 ) * RECIPROCAL_PI * 1.6;
      col = mix( col, sheer, 0.55 + 0.25 * damt );
    } else if ( dtype < 3.5 ) {
      float edge = mix( fac.w, fac.z, damt );
      if ( c.y > edge && tc < h.t ) col = dc * ( front * 0.8 + back * 0.5 ) * RECIPROCAL_PI * 1.6 * ( c.y - edge < 0.04 ? 0.6 : 1.0 );
    } else {
      float edge = mix( fac.w, fac.z, damt );
      float slat = step( 0.35, fract( c.y / 0.05 ) );
      if ( c.y > edge && tc < h.t && slat > 0.5 ) col = vec3( 0.75, 0.74, 0.70 ) * ( front * 0.7 + back * 0.4 ) * RECIPROCAL_PI * 1.6 * ( 0.8 + 0.2 * fract( c.y / 0.05 ) );
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
  // window grid on the opposite facade
  // (soft edges: slightly imperfect glass blurs the reflection with distance)
  float bl = 0.03 + 0.006 * tO;
  vec2 cell = vec2( hx / 3.4, ( hy - 4.8 ) / 3.6 );
  vec2 f = fract( cell );
  vec2 bb = vec2( bl / 3.4, bl / 3.6 );
  float wx = smoothstep( 0.3 - bb.x, 0.3 + bb.x, f.x ) * ( 1.0 - smoothstep( 0.7 - bb.x, 0.7 + bb.x, f.x ) );
  float wy = smoothstep( 0.22 - bb.y, 0.22 + bb.y, f.y ) * ( 1.0 - smoothstep( 0.82 - bb.y, 0.82 + bb.y, f.y ) );
  float isWin = smoothstep( -bb.y, bb.y, cell.y ) * wx * wy;
  float fs = fract( hx / 3.4 );
  float shopBand = smoothstep( 4.2 + bl, 4.2 - bl, hy ) * smoothstep( 0.6 - bl, 0.6 + bl, hy ) * smoothstep( 0.12 - bb.x, 0.12 + bb.x, fs ) * smoothstep( 0.88 + bb.x, 0.88 - bb.x, fs );
  // what the opposite windows show: dark glass, pale curtains or painted shutters
  float wk = fh2( floor( cell ) + 11.0 );
  vec3 winAlb = wk < 0.5 ? vec3( 0.07, 0.075, 0.08 ) : wk < 0.8 ? vec3( 0.42, 0.40, 0.36 ) : vec3( 0.10, 0.16, 0.12 );
  float lit = step( fh2( floor( cell ) + 5.0 ), uNight * 0.5 );
  vec3 winC = winAlb * E * RECIPROCAL_PI + lit * vec3( 1.0, 0.7, 0.4 ) * 0.0015;
  vec3 shopC = vec3( 0.12, 0.11, 0.10 ) * E * RECIPROCAL_PI + vec3( 1.0, 0.85, 0.65 ) * 0.002 * uNight;
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
float fGlass = ( 1.0 - step( 3.5, vWin.w ) ) * ( 1.0 - fMask );
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
    float depth = rec + vRoomP.z + 0.015;
    float tOut = depth / max( Rl.z, 0.02 );
    vec2 e = vec2( vRoomP.x - vRoomS.x * 0.5, vRoomP.y - vFac.z ) + Rl.xy * tOut;
    float hh = vFac.w - vFac.z;
    float soft = 0.02 + 0.03 * tOut;
    float inside = smoothstep( -soft, soft, vRoomP.w - abs( e.x ) ) * smoothstep( -soft, soft, e.y ) * smoothstep( -soft, soft, hh - e.y );
    vec3 stoneR = vec3( 0.56, 0.50, 0.41 ) * Eamb * RECIPROCAL_PI * ( e.y < 0.0 ? 0.75 : 0.42 );
    radiance = mix( stoneR, radiance, inside );
  }

  // interior: camera ray expressed in room space
  vec3 rd = vec3( dot( Vw, T ), Vw.y, -dot( Vw, N ) );
  rd.z = max( rd.z, 1e-3 );
  rd.x = abs( rd.x ) < 1e-4 ? 1e-4 : rd.x;
  rd.y = abs( rd.y ) < 1e-4 ? 1e-4 : rd.y;
  vec3 sunR = vec3( dot( uSunDir, T ), uSunDir.y, -dot( uSunDir, N ) );
  vec3 ro = clamp( vRoomP.xyz, vec3( 0.001 ), vRoomS.xyz - 0.001 );
  fInterior = fRoom( ro, rd, vRoomS.xyz, vWin, vFac, vRoomP.w, Eamb, sunR, uSunColor * step( 0.0, uSunDir.y ) );
  if ( fGlass < 0.5 && fMask < 0.5 ) radiance = vec3( 0.0 );
  fInterior *= 1.0 - fMask;
}
`;

const FRAG_OUT = /* glsl */`
float fNV = saturate( dot( normal, normalize( vViewPosition ) ) );
float fF = 0.04 + 0.96 * pow( 1.0 - fNV, 5.0 );
vec3 outgoingLight = ( totalDiffuse + totalSpecular ) * max( fGlass, fMask ) + totalEmissiveRadiance + fInterior * ( 1.0 - fF * fGlass );
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
  normal = normalize( normal + jv * ( 1.0 - step( 3.5, vWin.w ) ) );
}
`;

// Far range (lod 1): the casing, sill rail and central meeting stile are drawn here
// instead of as geometry. fMask = 1 on the painted frame.
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
`;

export function createInteriorGlass() {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.018, 0.018, 0.018), // dust film on the glass
    roughness: 0.035,
    metalness: 0,
    envMapIntensity: 1,
  });
  m.name = 'facades.glassInterior';
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
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.55, fMask );')
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <lights_fragment_maps>', FRAG_LIGHT)
      .replace('vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;', FRAG_OUT);
  };
  m.customProgramCacheKey = () => 'facades.glassInterior.v2';
  return m;
}

export const GLASS_ATTRS = { aRoomP: 4, aRoomS: 4, aWin: 4, aFac: 4, aFrame: 4 };
