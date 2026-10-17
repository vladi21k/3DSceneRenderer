// Limestone recipes: Jerusalem-style ashlar, rock-faced rustication, finely dressed trim
// stone, the chisel-dressing detail maps (taltish point-chisel strokes, mussamsam pecking), the
// shared mineral detail map and the macro variation noise.
// GLSL functions run per texel in tile metres (see glsl/common.js, NOISE_GLSL).
//
// The large ashlar map (4.2 m tile, 4 mm/texel) carries the block layout, arrises,
// joints and the stone body colour. The chisel dressing is far finer than that, so it
// lives in its own detail maps (0.64 m tiles, 0.6-1.25 mm/texel) which the runtime
// applies per block with a random rotation and dressing type (see surface.js).

// common limestone body colour, mottling, pores, fossil fragments and patina. `cloud`
// scales the soft 4-50 cm clouding, the iron flushes and the clay seams: full on the tooled
// ashlar (the dressing breaks them up), lower on rock-faced and rubbed stone, where they
// would read as cloudy marble.
const limestone = (cloud = 1) => /* glsl */ `
vec3 limestone(vec2 m, float hc, inout float h) {
  vec3 base = vec3(0.6, 0.54, 0.43);                                     // pale cream (linear)
  float mot = fbm(m + vec2(hc * 13.7, hc * 5.3), 2.2, 5, 0.55, 14u);   // soft clouds ~0.5 m
  float mot2 = fbm(m + vec2(hc * 2.9, 0.0), 10.0, 3, 0.6, 15u);       // 4-10 cm clouding
  vec3 c = base * (1.0 + ${(0.09 * cloud).toFixed(4)} * mot + ${(0.2 * cloud).toFixed(4)} * mot2);
  // warmer (honey) and cooler (grey-white) drifts inside one block
  float w = fbm(m + vec2(hc * 3.1, 0.0), 3.5, 4, 0.55, 16u);
  c *= mix(vec3(0.97, 0.99, 1.03), vec3(1.05, 0.98, 0.86), smoothstep(-0.45, 0.55, w));
  // pores: tiny dark holes, sparse
  vec4 pv = voro(m, vec2(140.0), 17u, 1.0);
  float pore = smoothstep(0.22, 0.06, pv.x) * step(0.75, pv.z);
  c *= 1.0 - 0.4 * pore;
  h -= pore * 0.0012;
  // fossil / calcite fragments: small pale flecks
  vec4 fv = voro(m, vec2(55.0), 18u, 1.0);
  float fos = smoothstep(0.16, 0.05, fv.x) * step(0.88, fv.z);
  c = mix(c, c * vec3(1.12, 1.11, 1.08), fos);
  // weathering patina: clusters of grey-black microbial specks on exposed faces
  float patch_ = smoothstep(0.0, 0.55, fbm(m, 1.8, 4, 0.6, 22u));
  vec4 dv = voro(m, vec2(90.0), 23u, 1.0);
  float speck = smoothstep(0.24, 0.08, dv.x) * step(1.0 - 0.75 * patch_, dv.z);
  c = mix(c, c * vec3(0.45, 0.45, 0.47), speck * 0.85);
  c *= 1.0 - 0.08 * patch_;
  // iron-oxide flushes (pink / ochre) and grey clay seams
  float fe = smoothstep(0.35, 0.8, fbm(m, 1.6, 4, 0.6, 19u)) * step(0.6, fract(hc * 7.31));
  c = mix(c, c * vec3(1.05, 0.9, 0.78), fe * ${(0.6 * cloud).toFixed(3)});
  float seam = smoothstep(0.75, 0.95, 1.0 - abs(fbm2(m + vec2(hc * 4.0), vec2(1.2, 6.0), 3, 0.5, 24u)));
  c = mix(c, c * vec3(0.86, 0.87, 0.88), seam * ${(0.5 * cloud).toFixed(3)} * step(0.5, fract(hc * 3.7)));
  return c;
}
`;

// shared high-frequency mineral grain (smooth stone, concrete, plaster); 4× anisotropy
// is plenty, the runtime fades minified detail out anyway
export const detail = {
  name: 'detail', flat: [1, 1, 1, 0.8], size: 512, tile: [0.5, 0.5], ss: 2, aniso: 4,
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

// Taltish: the face is worked over with a narrow point chisel in short, irregular
// strokes. Each stroke is a gouge 7-14 mm wide and 20-60 mm long, deepest (0.5-1.5 mm)
// just past where the chisel bites in and running out shallow and narrower; its direction
// scatters ±25° around the working direction (along u: the runtime rotates the map per
// block). Strokes sit on a jittered grid of 24.6 × 10 mm cells (rows shifted at random),
// so they overlap irregularly; the face is their lower envelope, every overlap leaving a
// sharp little ridge, and unworked islands keep the coarse pecked surface between them.
// Detail map format: surface = (normal.xy, moment, albedo modulation with 0.5 = neutral).
export const tooling = {
  name: 'tooling', flat: [1, 1, 1, 0.8], size: 1024, tile: [0.64, 0.64], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  const int NA = 26, NC = 64;
  vec2 cs = uTile / vec2(float(NA), float(NC));
  // ragged stroke outlines: the work surface is warped by a few millimetres
  vec2 w = m + vec2(fbm(m, 30.0, 2, 0.5, 301u), fbm(m, 30.0, 2, 0.5, 302u)) * 0.0018;
  float best = 0.0, bestT = 0.0;
  int j0 = int(floor(w.y / cs.y));
  for (int dj = -2 * uOne; dj <= 2 * uOne; dj++) {
    int j = j0 + dj;
    int jw = sfMod(j, NC);
    float rowOff = sfHash(ivec2(jw, 7), 303u) * cs.x;
    int i0 = int(floor((w.x - rowOff) / cs.x));
    for (int di = -2 * uOne; di <= 2 * uOne; di++) {
      int i = i0 + di;
      uint h = sfH2(sfMod(i, NA), jw, 304u);
      float h1 = sfHf(h), h2 = sfHf(sfH(h + 1u)), h3 = sfHf(sfH(h + 2u));
      float h4 = sfHf(sfH(h + 3u)), h5 = sfHf(sfH(h + 4u)), h6 = sfHf(sfH(h + 5u));
      vec2 c = vec2((float(i) + h1) * cs.x + rowOff, (float(j) + 0.15 + 0.7 * h2) * cs.y);
      float ang = (h3 - 0.5) * 0.87;                    // ±25°
      float len = 0.02 + 0.04 * h4 * (0.4 + 0.6 * h4);  // 20-60 mm, mostly short
      float wid = 0.007 + 0.007 * h5;
      float dep = 0.0005 + 0.001 * h6;
      vec2 t = vec2(cos(ang), sin(ang));
      vec2 d = w - c;
      float f = dot(d, t) / len + 0.5;                  // 0 at the bite, 1 at the run-out
      float x = dot(d, vec2(-t.y, t.x)) / (0.5 * wid * (1.0 - 0.45 * sat(f)));
      float prof = max(0.0, 1.0 - x * x);
      float alo = smoothstep(-0.04, 0.12, f) * (1.0 - smoothstep(0.35, 1.0, f) * 0.85) * step(f, 1.0);
      float hs = -dep * prof * alo;
      if (hs < best) { best = hs; bestT = h1; }
    }
  }
  // the pecked rough-out surface left between the strokes
  vec4 v = voro(m, vec2(260.0), 309u, 1.0);
  float pore = smoothstep(0.2, 0.05, v.x) * step(0.9, v.z);
  float peck = smoothstep(0.5, 0.1, v.x) * step(0.55, v.z);
  float isl = 1.0 - smoothstep(-0.0002, 0.0, best);    // inside a stroke
  s.height = best + fbm(m, 120.0, 3, 0.5, 310u) * 0.00012 - pore * 0.0004 - (1.0 - isl) * peck * 0.00035;
  // gouges hold dust where they are deep, fresh facets are paler; tone per stroke
  float dn = sat(-best / 0.0013);
  float a = 1.05 - 0.13 * dn + 0.04 * isl * (bestT - 0.5) - 0.04 * (1.0 - isl) * peck - 0.25 * pore + 0.04 * (v.z - 0.5);
  s.ao = sat(0.5 * a);
  s.albedo = vec3(1.0);
  s.rough = 0.8;
}
`,
};

// Mussamsam: surface pecked all over with a point, dense 3-5 mm pits up to 1.5 mm deep.
// Same detail map format and tile as tooling.
export const peck = {
  name: 'peck', flat: [1, 1, 1, 0.8], size: 512, tile: [0.64, 0.64], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec4 v = voro(m, vec2(220.0), 311u, 1.0);             // ~4.5 mm pits
  float pit = smoothstep(0.62, 0.0, v.x) * step(0.25, v.z) * (0.6 + 0.4 * fract(v.z * 13.1));
  vec4 v2 = voro(m, vec2(90.0), 312u, 1.0);             // occasional larger blows
  float big = smoothstep(0.5, 0.0, v2.x) * step(0.82, v2.z);
  float g = fbm(m, 80.0, 3, 0.5, 313u);
  s.height = -pit * 0.0013 - big * 0.0015 + g * 0.00015;
  float a = 1.04 - 0.12 * pit - 0.1 * big + 0.03 * g;
  s.ao = sat(0.5 * a);
  s.albedo = vec3(1.0);
  s.rough = 0.8;
}
`,
};

// macro variation noise (raw RGBA8): r,g soft multi-octave, b blotchy, a mid
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
// arrises with chips, faces slightly proud / sunk / tilted per block. The dressing
// (taltish, mussamsam, rubbed) is applied at runtime from the detail maps above.
export const ashlar = {
  name: 'ashlar', flat: [0.59, 0.535, 0.43, 0.86], size: 1024, tile: [4.2, 4.2], ss: 2,
  layout: { rowH: 0.35, rows: 12, seg: [5, 7], jitter: 0.42, seed: 11, shift: true },
  joint: 0.0055,
  pass: { normal: 1.0, ao: 0.7, aoRadius: 0.008, cavity: 0.06 },
  glsl: limestone() + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float hA = cellRand(c, 1u);
  // irregular arrises
  float wob = fbm(m, 6.0, 3, 0.55, 11u) * 0.0016 + fbm(m, 30.0, 2, 0.5, 12u) * 0.0004;
  float e = c.e + wob;
  const float JW = 0.003;                        // half joint (6 mm)
  float bev = 0.006 + 0.01 * cellRand(c, 3u);    // rounded arris 6-16 mm
  // chips along the arrises
  vec4 cv = voro(m, vec2(16.0), 21u, 1.0);
  float chip = smoothstep(0.5, 0.1, cv.x) * step(0.72, cv.z) * (1.0 - smoothstep(0.0, 0.025, e));
  // face: not perfectly flat, block proud / sunk and slightly tilted
  float face = fbm(m, 3.5, 3, 0.5, 30u) * 0.0012 + (hA - 0.5) * 0.0024;
  face += dot(c.lp - 0.5 * c.size, vec2(cellRand(c, 7u) - 0.5, cellRand(c, 8u) - 0.5)) * 0.008;
  float t = clamp((e - JW) / bev, 0.0, 1.0);
  float rnd = sqrt(1.0 - (1.0 - t) * (1.0 - t));
  float hFace = face - bev * 0.6 * (1.0 - rnd) - chip * 0.005;
  float hMortar = -0.0035 + fbm(m, 70.0, 2, 0.5, 13u) * 0.0006 + 0.001 * smoothstep(0.0, JW, e);
  float stone = smoothstep(JW - 0.0008, JW + 0.0008, e);
  float hs = 0.0;
  vec3 alb = limestone(m, c.h, hs);
  s.height = mix(hMortar, max(hFace + hs, hMortar), stone);
  // soiled arrises (lightly: the shading does the rest), fresh chips paler
  alb *= mix(0.93, 1.0, smoothstep(0.0, 0.02, e - JW));
  alb *= 1.0 + 0.07 * chip;
  vec3 mortar = vec3(0.67, 0.645, 0.59) * (1.0 + 0.07 * fbm(m, 45.0, 2, 0.5, 19u));
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.95, 0.86 + 0.03 * fbm(m, 9.0, 2, 0.5, 20u), stone);
}
`,
};

// Rock-faced rustication ("tubzeh"): a broken boss 25-45 mm proud inside a flat drafted
// margin of 25-40 mm (fine chisel lines), a steep pitched break between the two, and deep
// recessed joints. Courses 0.5 m; 4 × 2 m tile at 2 mm/texel so the fracture facets stay
// sharp. The fracture relief is the lower envelope of randomly tilted, shallow dished
// scars at three scales: continuous, with hard creases that self-shadow under raking sun.
// Every block is pitched differently: flake size, relief depth, a boss tilted to one side
// and an off-centre lump (the runtime also mirrors the relief at random per block).
export const rustic = {
  name: 'rustic', flat: [0.58, 0.53, 0.42, 0.9], size: [2048, 1024], tile: [4.0, 2.0], ss: 2,
  layout: { rowH: 0.5, rows: 4, seg: [4, 6], jitter: 0.36, seed: 23, shift: true },
  joint: 0.01,
  pass: { normal: 1.1, ao: 0.5, aoRadius: 0.012, cavity: 0.05 },
  glsl: limestone(0.5) + /* glsl */ `
// conchoidal scars: lower envelope of tilted dishes centred on jittered points (cell
// size cellM, m): concave facets meeting in sharp ridges, like a hammer-pitched face
float scars(vec2 m, float cellM, float slope, float dish, uint sd, out float id) {
  ivec2 per = sfPer(vec2(1.0 / cellM));
  vec2 cell = uTile / vec2(per);
  vec2 x = m / cell;
  vec2 i = floor(x), f = x - i;
  ivec2 p = ivec2(i);
  float best = 1.0;
  id = 0.0;
  for (int y = -uOne; y <= uOne; y++) for (int xx = -uOne; xx <= uOne; xx++) {
    ivec2 cw = sfMod2(p + ivec2(xx, y), per);
    vec2 d = (vec2(float(xx), float(y)) + hash22(cw, sd) * 0.9 + 0.05 - f) * cell;
    float hc = sfHash(cw, sd + 7u);
    float a = hc * 6.2831853;
    vec2 g = vec2(cos(a), sin(a)) * slope * (0.3 + 0.7 * fract(hc * 7.13));
    float hi = dot(g, -d) + dish * dot(d, d) / cellM + (fract(hc * 3.71) - 0.5) * cellM * 0.15;
    if (hi < best) { best = hi; id = hc; }
  }
  return best;
}
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 5.0, 3, 0.5, 51u) * 0.003;
  const float JW = 0.006;
  float margin = 0.025 + 0.015 * cellRand(c, 2u);
  // pitched edge: the boss breaks away steeply 6-10 mm inside the margin, irregularly
  float brk = margin + 0.005 * fbm(m, 14.0, 3, 0.5, 59u) + 0.004 * cellRand(c, 4u);
  float rise = smoothstep(brk, brk + 0.006 + 0.004 * cellRand(c, 5u), e);
  // boss: high and flattish in the middle, falling off towards the pitched edge, tilted
  // to one side and with an off-centre lump, both per block
  vec2 q = (c.lp - 0.5 * c.size) / (0.5 * c.size);
  float dome = 1.0 - pow(max(abs(q.x), abs(q.y)), 3.0);
  vec2 tilt = vec2(cellRand(c, 11u), cellRand(c, 12u)) - 0.5;
  vec2 pk = (vec2(cellRand(c, 13u), cellRand(c, 14u)) - 0.5) * 1.2;
  float lump = exp(-2.5 * dot(q - pk, q - pk)) * (0.003 + 0.012 * cellRand(c, 15u));
  float crown = (0.02 + 0.018 * cellRand(c, 3u)) * (1.0 + 0.7 * dot(q, tilt));
  // fracture relief: large flakes, smaller conchoidal scars, fine spalls; flake size and
  // relief depth per block
  vec2 mw = m + vec2(c.h * 5.3, c.h * 2.1);
  float fs = 0.7 + 0.65 * cellRand(c, 9u), fd = 0.75 + 0.5 * cellRand(c, 10u);
  float i1, i2, i3;
  float f1 = scars(mw, 0.17 * fs, 0.3, 0.3, 53u, i1);
  float f2 = scars(mw, 0.07 * fs, 0.3, 0.5, 54u, i2);
  float f3 = scars(mw, 0.028, 0.25, 0.6, 55u, i3);
  float bulge = 0.008 * fbm(mw, 4.0, 2, 0.5, 52u);
  float rock = crown * (0.3 + 0.7 * dome) + lump * (0.4 + 0.6 * dome) + bulge + fd * (f1 + 0.5 * f2) + 0.3 * f3 + 0.0004 * fbm(m, 60.0, 3, 0.5, 56u);
  float hRock = (0.006 + log(1.0 + exp((rock - 0.006) / 0.003)) * 0.003) * rise;   // soft floor
  // drafted margin: flat band with fine parallel chisel lines (3 mm pitch) across it
  float dirL = min(c.ed.x, c.ed.y) < min(c.ed.z, c.ed.w) ? m.y : m.x;
  float hMargin = -0.0015 - 0.00025 * (0.5 + 0.5 * sin(dirL / 0.003 * 6.2831853 + fbm(m, 20.0, 2, 0.5, 57u) * 2.0));
  float t = clamp((e - JW) / 0.004, 0.0, 1.0);
  float hFace = mix(-0.012, max(hMargin, hRock), sqrt(1.0 - (1.0 - t) * (1.0 - t)));
  float stone = smoothstep(JW - 0.001, JW + 0.001, e);
  float hm = 0.0;
  vec3 alb = limestone(m, c.h, hm);
  // fresh fracture facets slightly paler, weathered ones a touch darker; crowns washed
  alb *= 1.0 + (0.05 * (i1 - 0.5) + 0.03 * (i2 - 0.5)) * rise;
  alb *= mix(0.96, 1.02, sat(hRock / 0.04));
  vec3 mortar = vec3(0.62, 0.595, 0.54) * (1.0 + 0.08 * fbm(m, 40.0, 2, 0.5, 58u));
  s.height = mix(-0.016, hFace + hm, stone);
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.97, mix(0.84, 0.92, rise), stone);
}
`,
};

// Finely dressed trim stone (cornices, sills, string courses, arches): rubbed faces, no joints.
export const smooth = {
  name: 'smooth', flat: [0.61, 0.555, 0.44, 0.75], size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.4, aoRadius: 0.006, cavity: 0.05 },
  glsl: limestone(0.45) + /* glsl */ `
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
