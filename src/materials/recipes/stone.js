// Limestone recipes: Jerusalem-style ashlar, rock-faced rustication, finely dressed trim
// stone, plus the shared mineral detail map and the macro variation noise.
// GLSL functions run per texel in tile metres (see glsl/common.js, NOISE_GLSL).

// common limestone body colour, mottling, pores and fossil fragments
const LIMESTONE = /* glsl */ `
vec3 limestone(vec2 m, float hc, inout float h) {
  vec3 base = vec3(0.625, 0.535, 0.385);
  float mot = fbm(m + vec2(hc * 13.7, hc * 5.3), 2.6, 4, 0.55, 14u);   // soft clouds ~40 cm
  float mot2 = fbm(m, 11.0, 3, 0.5, 15u);                              // finer clouding
  vec3 c = base * (1.0 + 0.075 * mot + 0.04 * mot2);
  // warmer (honey) and cooler (grey) drifts inside one block
  float w = fbm(m, 4.5, 3, 0.5, 16u);
  c *= mix(vec3(0.97, 0.99, 1.03), vec3(1.035, 0.99, 0.9), smoothstep(-0.4, 0.5, w));
  // pores: tiny dark holes, sparse
  vec4 pv = voro(m, vec2(140.0), 17u, 1.0);
  float pore = smoothstep(0.2, 0.06, pv.x) * step(0.82, pv.z);
  c *= 1.0 - 0.38 * pore;
  h -= pore * 0.0012;
  // fossil / calcite fragments: small pale flecks
  vec4 fv = voro(m * vec2(1.0, 1.0), vec2(55.0), 18u, 1.0);
  float fos = smoothstep(0.16, 0.05, fv.x) * step(0.9, fv.z);
  c = mix(c, c * vec3(1.12, 1.1, 1.08), fos);
  // rare iron-oxide flushes (pink / ochre)
  float fe = smoothstep(0.45, 0.85, fbm(m, 1.6, 4, 0.6, 19u)) * step(0.82, fract(hc * 7.31));
  c = mix(c, c * vec3(1.04, 0.9, 0.76), fe * 0.55);
  return c;
}
`;

// shared high-frequency mineral grain (stone, paving, concrete, plaster)
export const detail = {
  name: 'detail', size: 512, tile: [0.5, 0.5], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float g = fbm(m, 60.0, 4, 0.55, 3u);                  // fine relief
  vec4 v = voro(m, vec2(260.0), 4u, 1.0);              // ~2 mm grains
  float grain = v.z;
  s.height = g * 0.00035 + (v.x - 0.5) * 0.00018 - smoothstep(0.18, 0.05, v.x) * step(0.9, grain) * 0.0005;
  float a = 0.5 + 0.18 * (grain - 0.5) + 0.12 * g;     // albedo modulation (0.5 neutral)
  a -= smoothstep(0.18, 0.05, v.x) * step(0.9, grain) * 0.18;
  s.ao = clamp(a, 0.0, 1.0);
  s.albedo = vec3(1.0);
  s.rough = 0.8;
}
`,
};

// macro variation noise (raw RGBA16F): r,g soft multi-octave, b blotchy, a mid
export const macro = {
  name: 'macro', size: 256, tile: [1, 1], raw: true,
  glsl: /* glsl */ `
vec4 rawSurface(vec2 m) {
  float r = fbm(m, 3.0, 5, 0.55, 41u);
  float g = fbm(warp(m, 2.0, 0.08, 42u), 4.0, 5, 0.6, 43u);
  float b = fbm(warp(m, 3.0, 0.12, 44u), 5.0, 6, 0.62, 45u);
  float a = fbm(m, 9.0, 4, 0.5, 46u);
  return vec4(r, g, b, a) * 0.5 + 0.5;
}
`,
};

// Ashlar: courses of 0.35 m, blocks 0.36–1.2 m; 7 mm light mortar, rounded darker arrises,
// chisel-dressed faces (drafted margin + comb strokes), pecked or rubbed variants.
export const ashlar = {
  name: 'ashlar', size: 1024, tile: [4.2, 4.2], ss: 2,
  layout: { rowH: 0.35, rows: 12, seg: [5, 7], jitter: 0.42, seed: 11, shift: true },
  pass: { normal: 1.0, ao: 0.9, aoRadius: 0.018, cavity: 0.35 },
  glsl: LIMESTONE + /* glsl */ `
float dressing(vec2 m, Cell c, float hA, float hB, out float tooled) {
  float h = fbm(m, 3.5, 3, 0.5, 30u) * 0.0012;                   // face not perfectly flat
  h += (hA - 0.5) * 0.0024;                                       // block proud / sunk
  h += dot(c.lp - 0.5 * c.size, vec2(cellRand(c, 7u) - 0.5, cellRand(c, 8u) - 0.5)) * 0.009; // tilt
  float margin = 0.022 + 0.018 * cellRand(c, 9u);
  float field = smoothstep(margin, margin + 0.006, c.e);
  tooled = 0.0;
  if (hB < 0.58) {
    // taltish: rows of comb-chisel strokes, diagonal or vertical per block
    float ang = hA < 0.33 ? 1.5708 : (hA < 0.66 ? 0.95 : 2.2);
    vec2 dir = vec2(cos(ang), sin(ang));
    float along = dot(c.lp, dir), across = dot(c.lp, vec2(-dir.y, dir.x));
    float bw = 0.016 + 0.01 * cellRand(c, 10u);
    float bi = floor(across / bw), bf = fract(across / bw);
    float jit = sfHash(ivec2(int(bi), int(c.id & 1023u)), 61u);
    float stroke = fract(along / (0.03 + 0.02 * jit) + jit * 3.0);
    float scoop = -0.0007 * (bf * (1.0 - bf) * 4.0) - 0.00045 * stroke * stroke;
    h += scoop * field;
    tooled = field;
  } else if (hB < 0.85) {
    // mussamsam: pecked with a point, dense small pits
    vec4 v = voro(m, vec2(85.0), 31u, 1.0);
    h -= smoothstep(0.55, 0.0, v.x) * 0.0009 * field;
    tooled = 0.7 * field;
  }
  return h;
}
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float hA = cellRand(c, 1u), hB = cellRand(c, 2u);
  // irregular arrises
  float wob = fbm(m, 7.0, 3, 0.55, 11u) * 0.0022 + fbm(m, 38.0, 2, 0.5, 12u) * 0.0008;
  float e = c.e + wob;
  const float JW = 0.0035;                       // half joint (7 mm)
  float bev = 0.007 + 0.011 * cellRand(c, 3u);   // rounded arris 7-18 mm
  // chips along the arrises
  vec4 cv = voro(m, vec2(16.0), 21u, 1.0);
  float chip = smoothstep(0.5, 0.1, cv.x) * step(0.7, cv.z) * (1.0 - smoothstep(0.0, 0.025, e));
  float tooled;
  float face = dressing(m, c, hA, hB, tooled);
  float t = clamp((e - JW) / bev, 0.0, 1.0);
  float rnd = sqrt(1.0 - (1.0 - t) * (1.0 - t));
  float hFace = face - bev * 0.75 * (1.0 - rnd) - chip * 0.006;
  float hMortar = -0.0065 + fbm(m, 70.0, 2, 0.5, 13u) * 0.0007 + 0.0015 * smoothstep(0.0, JW, e);
  float stone = smoothstep(JW - 0.0008, JW + 0.0008, e);
  float hStone = face;
  vec3 alb = limestone(m, c.h, hStone);
  s.height = mix(hMortar, max(hFace + (hStone - face), hMortar), stone);
  // soiled arrises, fresh chips, tooled faces catch a little dust
  alb *= mix(0.86, 1.0, smoothstep(0.0, 0.022, e - JW));
  alb *= 1.0 + 0.07 * chip;
  alb *= 1.0 - 0.025 * tooled;
  vec3 mortar = vec3(0.66, 0.62, 0.545) * (1.0 + 0.07 * fbm(m, 45.0, 2, 0.5, 19u));
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.96, 0.84 + 0.04 * tooled + 0.03 * fbm(m, 9.0, 2, 0.5, 20u), stone);
}
`,
};

// Rock-faced rustication ("tubzeh"): pillowed rough faces inside a flat drafted margin,
// deep recessed joints. Courses 0.5 m.
export const rustic = {
  name: 'rustic', size: 1024, tile: [4.0, 4.0], ss: 2,
  layout: { rowH: 0.5, rows: 8, seg: [4, 6], jitter: 0.36, seed: 23, shift: true },
  pass: { normal: 1.0, ao: 1.0, aoRadius: 0.04, cavity: 0.45 },
  glsl: LIMESTONE + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 6.0, 3, 0.5, 51u) * 0.004;
  const float JW = 0.006;
  float margin = 0.03 + 0.012 * cellRand(c, 2u);
  // pillow: rises from the margin to a rough crown 2-4 cm proud
  vec2 q = (c.lp - 0.5 * c.size) / (0.5 * c.size);
  float dome = 1.0 - pow(max(abs(q.x), abs(q.y)), 6.0);
  float crown = 0.02 + 0.02 * cellRand(c, 3u);
  float rise = smoothstep(margin, margin + 0.05, e);
  // fractured rock: ridged noise + Voronoi facets
  vec4 f = voro(warp(m, 4.0, 0.03, 52u), vec2(9.0), 53u, 1.0);
  float facets = f.x * 0.012 + (f.z - 0.5) * 0.006;
  float rough = ridged(m, vec2(14.0), 4, 54u) * 0.008 + fbm(m, 40.0, 3, 0.5, 55u) * 0.0015;
  float hRock = crown * dome * rise + (facets + rough) * rise;
  float hMargin = -0.002 + fbm(m, 25.0, 2, 0.5, 56u) * 0.0005;
  float t = clamp((e - JW) / 0.008, 0.0, 1.0);
  float hFace = mix(-0.012, max(hMargin, hRock), sqrt(1.0 - (1.0 - t) * (1.0 - t)));
  float stone = smoothstep(JW - 0.001, JW + 0.001, e);
  float hm = 0.0;
  vec3 alb = limestone(m, c.h, hm);
  // weathering: projecting crowns washed paler, hollows collect grime
  alb *= mix(0.9, 1.05, sat(hRock / 0.04));
  alb *= 1.0 - 0.06 * smoothstep(0.3, 0.8, fbm(m, 3.0, 4, 0.6, 57u)) * rise;
  vec3 mortar = vec3(0.6, 0.57, 0.5) * (1.0 + 0.08 * fbm(m, 40.0, 2, 0.5, 58u));
  s.height = mix(-0.02, hFace + hm, stone);
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.97, 0.9, stone);
}
`,
};

// Finely dressed trim stone (cornices, sills, string courses, arches): rubbed faces, no joints.
export const smooth = {
  name: 'smooth', size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.01, cavity: 0.3 },
  glsl: LIMESTONE + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float h = fbm(m, 2.5, 3, 0.5, 71u) * 0.0008 + fbm(m, 30.0, 3, 0.5, 72u) * 0.00025;
  // faint fine claw-tool striation along u
  h += sin(m.y / uTile.y * 333.0 * 6.2831853 + fbm(m, 6.0, 2, 0.5, 73u) * 3.0) * 0.00008;
  vec3 c = limestone(m, 0.37, h);
  s.albedo = c * vec3(1.03, 1.03, 1.04);
  s.height = h;
  s.rough = 0.74 + 0.04 * fbm(m, 8.0, 2, 0.5, 74u);
}
`,
};
