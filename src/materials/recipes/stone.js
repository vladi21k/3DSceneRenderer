// Limestone recipes: Jerusalem-style ashlar, rock-faced rustication, finely dressed trim
// stone, plus the shared mineral detail map and the macro variation noise.
// GLSL functions run per texel in tile metres (see glsl/common.js, NOISE_GLSL).

// common limestone body colour, mottling, pores and fossil fragments
const LIMESTONE = /* glsl */ `
vec3 limestone(vec2 m, float hc, inout float h) {
  vec3 base = vec3(0.6, 0.54, 0.43);                                     // pale cream (linear)
  float mot = fbm(m + vec2(hc * 13.7, hc * 5.3), 2.2, 5, 0.55, 14u);   // soft clouds ~0.5 m
  float mot2 = fbm(m, 9.0, 3, 0.5, 15u);                               // finer clouding
  vec3 c = base * (1.0 + 0.085 * mot + 0.045 * mot2);
  // warmer (honey) and cooler (grey-white) drifts inside one block
  float w = fbm(m + vec2(hc * 3.1, 0.0), 3.5, 4, 0.55, 16u);
  c *= mix(vec3(0.98, 0.995, 1.02), vec3(1.04, 0.985, 0.88), smoothstep(-0.45, 0.55, w));
  // pores: tiny dark holes, sparse
  vec4 pv = voro(m, vec2(140.0), 17u, 1.0);
  float pore = smoothstep(0.2, 0.06, pv.x) * step(0.8, pv.z);
  c *= 1.0 - 0.35 * pore;
  h -= pore * 0.001;
  // fossil / calcite fragments: small pale flecks
  vec4 fv = voro(m, vec2(55.0), 18u, 1.0);
  float fos = smoothstep(0.16, 0.05, fv.x) * step(0.9, fv.z);
  c = mix(c, c * vec3(1.1, 1.09, 1.07), fos);
  // weathering patina: clusters of grey-black microbial specks on exposed faces
  float patch_ = smoothstep(0.1, 0.6, fbm(m, 1.8, 4, 0.6, 22u));
  vec4 dv = voro(m, vec2(90.0), 23u, 1.0);
  float speck = smoothstep(0.22, 0.08, dv.x) * step(1.0 - 0.45 * patch_, dv.z);
  c = mix(c, c * vec3(0.62, 0.62, 0.64), speck * 0.8);
  c *= 1.0 - 0.06 * patch_;
  // rare iron-oxide flushes (pink / ochre)
  float fe = smoothstep(0.45, 0.85, fbm(m, 1.6, 4, 0.6, 19u)) * step(0.8, fract(hc * 7.31));
  c = mix(c, c * vec3(1.04, 0.92, 0.8), fe * 0.5);
  return c;
}
`;

// shared high-frequency mineral grain (stone, paving, concrete, plaster)
export const detail = {
  name: 'detail', flat: [1, 1, 1, 0.8], size: 512, tile: [0.5, 0.5], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float g = fbm(m, 60.0, 4, 0.55, 3u);                  // fine relief
  vec4 v = voro(m, vec2(260.0), 4u, 1.0);              // ~2 mm grains
  float grain = v.z;
  vec4 pk = voro(m, vec2(110.0), 5u, 1.0);             // ~5 mm pecking / weathering pits
  float pit = smoothstep(0.42, 0.1, pk.x) * step(0.55, pk.z);
  s.height = g * 0.0005 + (v.x - 0.5) * 0.00018 - smoothstep(0.18, 0.05, v.x) * step(0.9, grain) * 0.0005 - pit * 0.0004;
  float a = 0.5 + 0.18 * (grain - 0.5) + 0.12 * g;     // albedo modulation (0.5 neutral)
  a -= smoothstep(0.18, 0.05, v.x) * step(0.9, grain) * 0.18 + pit * 0.05;
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

// Ashlar: courses of 0.35 m, blocks 0.36-1.2 m; 6 mm light pointing, rounded and soiled
// arrises, chisel-dressed faces (drafted margin + comb strokes), pecked or rubbed variants.
export const ashlar = {
  name: 'ashlar', flat: [0.59, 0.535, 0.43, 0.86], size: 1024, tile: [4.2, 4.2], ss: 2,
  layout: { rowH: 0.35, rows: 12, seg: [5, 7], jitter: 0.42, seed: 11, shift: true },
  joint: 0.0055,
  pass: { normal: 1.0, ao: 0.7, aoRadius: 0.016, cavity: 0.18 },
  glsl: LIMESTONE + /* glsl */ `
float dressing(vec2 m, Cell c, float hA, float hB, out float tooled) {
  float h = fbm(m, 3.5, 3, 0.5, 30u) * 0.0012;                   // face not perfectly flat
  h += (hA - 0.5) * 0.0024;                                       // block proud / sunk
  h += dot(c.lp - 0.5 * c.size, vec2(cellRand(c, 7u) - 0.5, cellRand(c, 8u) - 0.5)) * 0.008; // tilt
  float margin = 0.02 + 0.02 * cellRand(c, 9u);
  float field = smoothstep(margin, margin + 0.008, c.e + fbm(m, 20.0, 2, 0.5, 33u) * 0.004);
  tooled = 0.0;
  if (hB < 0.55) {
    // taltish: irregular rows of comb-chisel strokes, diagonal or vertical per block
    float ang = hA < 0.33 ? 1.5708 : (hA < 0.66 ? 0.95 : 2.2);
    ang += (cellRand(c, 11u) - 0.5) * 0.25;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 lp = c.lp + vec2(fbm(m, 12.0, 2, 0.5, 34u), fbm(m, 12.0, 2, 0.5, 35u)) * 0.006;
    float along = dot(lp, dir), across = dot(lp, vec2(-dir.y, dir.x));
    float bw = 0.018 + 0.012 * cellRand(c, 10u);
    float bi = floor(across / bw), bf = fract(across / bw);
    float jit = sfHash(ivec2(int(bi), int(c.id & 1023u)), 61u);
    float sl = 0.035 + 0.03 * jit;
    float si = floor(along / sl + jit * 3.0);
    float sf = fract(along / sl + jit * 3.0);
    float depth = 0.6 + 0.8 * sfHash(ivec2(int(si), int(bi)), uint(c.id));
    float scoop = -(bf * (1.0 - bf) * 4.0) * 0.0003 - sf * sf * 0.00045 * depth;
    h += scoop * field;
    tooled = field;
  } else if (hB < 0.86) {
    // mussamsam: pecked with a point, dense small pits
    vec4 v = voro(m, vec2(85.0), 31u, 1.0);
    h -= smoothstep(0.5, 0.0, v.x) * 0.0007 * field;
    tooled = 0.7 * field;
  }
  return h;
}
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float hA = cellRand(c, 1u), hB = cellRand(c, 2u);
  // irregular arrises
  float wob = fbm(m, 6.0, 3, 0.55, 11u) * 0.0016 + fbm(m, 30.0, 2, 0.5, 12u) * 0.0004;
  float e = c.e + wob;
  const float JW = 0.003;                        // half joint (6 mm)
  float bev = 0.006 + 0.01 * cellRand(c, 3u);    // rounded arris 6-16 mm
  // chips along the arrises
  vec4 cv = voro(m, vec2(16.0), 21u, 1.0);
  float chip = smoothstep(0.5, 0.1, cv.x) * step(0.72, cv.z) * (1.0 - smoothstep(0.0, 0.025, e));
  float tooled;
  float face = dressing(m, c, hA, hB, tooled);
  float t = clamp((e - JW) / bev, 0.0, 1.0);
  float rnd = sqrt(1.0 - (1.0 - t) * (1.0 - t));
  float hFace = face - bev * 0.6 * (1.0 - rnd) - chip * 0.005;
  float hMortar = -0.0035 + fbm(m, 70.0, 2, 0.5, 13u) * 0.0006 + 0.001 * smoothstep(0.0, JW, e);
  float stone = smoothstep(JW - 0.0008, JW + 0.0008, e);
  float hStone = face;
  vec3 alb = limestone(m, c.h, hStone);
  s.height = mix(hMortar, max(hFace + (hStone - face), hMortar), stone);
  // soiled arrises, fresh chips, tooled faces hold a little dust
  alb *= mix(0.88, 1.0, smoothstep(0.0, 0.02, e - JW));
  alb *= 1.0 + 0.06 * chip;
  alb *= 1.0 - 0.02 * tooled;
  vec3 mortar = vec3(0.67, 0.645, 0.59) * (1.0 + 0.07 * fbm(m, 45.0, 2, 0.5, 19u));
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.95, 0.84 + 0.04 * tooled + 0.03 * fbm(m, 9.0, 2, 0.5, 20u), stone);
}
`,
};

// Rock-faced rustication ("tubzeh"): pillowed, roughly broken faces inside a flat drafted
// margin, deep recessed joints. Courses 0.5 m.
export const rustic = {
  name: 'rustic', flat: [0.58, 0.53, 0.42, 0.9], size: 1024, tile: [4.0, 4.0], ss: 2,
  layout: { rowH: 0.5, rows: 8, seg: [4, 6], jitter: 0.36, seed: 23, shift: true },
  joint: 0.01,
  pass: { normal: 1.0, ao: 0.9, aoRadius: 0.035, cavity: 0.3 },
  glsl: LIMESTONE + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 5.0, 3, 0.5, 51u) * 0.004;
  const float JW = 0.006;
  float margin = 0.03 + 0.015 * cellRand(c, 2u);
  // pillow: rises from the margin to a broken crown 2-4 cm proud
  vec2 q = (c.lp - 0.5 * c.size) / (0.5 * c.size);
  float dome = 1.0 - pow(max(abs(q.x), abs(q.y)), 4.0);
  float crown = 0.018 + 0.02 * cellRand(c, 3u);
  float rise = smoothstep(margin, margin + 0.045 + 0.03 * cellRand(c, 4u), e + fbm(m, 9.0, 3, 0.5, 59u) * 0.012);
  // broken rock: warped billowy relief with terraced fracture steps
  vec2 w = warp(m, 3.0, 0.05, 52u);
  float big = fbm(w, 3.5, 3, 0.55, 53u);
  float frac = abs(fbm(w, 9.0, 4, 0.55, 54u));
  float terr = floor(big * 6.0 + frac * 2.0) / 6.0;
  float rock = 0.012 * mix(big, terr, 0.55) - 0.006 * frac + 0.0015 * fbm(m, 45.0, 3, 0.5, 55u);
  float hRock = (crown * dome + rock) * rise;
  float hMargin = -0.002 + fbm(m, 25.0, 2, 0.5, 56u) * 0.0005;
  float t = clamp((e - JW) / 0.008, 0.0, 1.0);
  float hFace = mix(-0.012, max(hMargin, hRock), sqrt(1.0 - (1.0 - t) * (1.0 - t)));
  float stone = smoothstep(JW - 0.001, JW + 0.001, e);
  float hm = 0.0;
  vec3 alb = limestone(m, c.h, hm);
  // weathering: projecting crowns washed paler, hollows collect grime
  alb *= mix(0.88, 1.04, sat(hRock / 0.035));
  alb *= 1.0 - 0.05 * smoothstep(0.3, 0.8, fbm(m, 3.0, 4, 0.6, 57u)) * rise;
  vec3 mortar = vec3(0.62, 0.595, 0.54) * (1.0 + 0.08 * fbm(m, 40.0, 2, 0.5, 58u));
  s.height = mix(-0.016, hFace + hm, stone);
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.97, 0.9, stone);
}
`,
};

// Finely dressed trim stone (cornices, sills, string courses, arches): rubbed faces, no joints.
export const smooth = {
  name: 'smooth', flat: [0.61, 0.555, 0.44, 0.75], size: 512, tile: [2.0, 2.0], ss: 2,
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
