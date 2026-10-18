// Limestone recipes: Jerusalem-style ashlar, rock-faced rustication, finely dressed trim
// stone, the chisel-dressing detail maps (taltish point-chisel strokes, mussamsam pecking), the
// shared mineral detail map and the macro variation noise.
// GLSL functions run per texel in tile metres (see glsl/common.js, NOISE_GLSL).
//
// The large ashlar map (4.2 m tile, 2 mm/texel) carries the block layout, arrises,
// joints and the stone body colour. The chisel dressing is far finer than that, so it
// lives in its own detail maps (0.64 m tiles, 0.6-1.25 mm/texel) which the runtime
// applies per block with a random rotation and dressing type (see surface.js).

// common limestone body colour, mottling, pores, fossil fragments and patina. `cloud`
// scales the soft 4-50 cm clouding, the iron flushes and the clay seams: full on the tooled
// ashlar (the dressing breaks them up), lower on rock-faced and rubbed stone, where they
// would read as cloudy marble.
const limestone = (cloud = 1) => /* glsl */ `
vec3 limestone(vec2 m, float hc, inout float h) {
  // warm honey-cream body (linear R/B ~1.9, sRGB ~1.33): sunlit Jerusalem limestone reads
  // honey, not grey-cream; the per-building tints shift it golden or pale from here
  vec3 base = vec3(0.6, 0.505, 0.318);
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

// Taltish: the face is worked over with a toothed (comb) chisel in short strokes, all
// driven the same way across a block: every stroke leaves a band of 6-12 parallel tooth
// grooves at a 2.5 mm pitch, 15-30 mm wide and 30-90 mm long, deepest (0.6-1.4 mm) just
// past where the chisel bites in and running out shallow and narrower (the outer teeth
// lift first), so the strokes have ragged, tapering ends. The working direction scatters
// only ±5° (along u: the runtime rotates the map per block, one angle per block), so the
// face reads as fields of parallel comb marks, not random scratches. Strokes sit on a
// fully jittered grid of 45.7 × 24.6 mm cells (rows shifted at random) so they overlap; the face
// is their lower envelope, every overlap leaving a little step, and unworked islands keep
// the coarse pecked surface between them. The relief carries the look: the albedo only
// follows it faintly (dust in the deepest grooves).
// Detail map format: surface = (normal.xy, moment, albedo modulation with 0.5 = neutral).
export const tooling = {
  name: 'tooling', flat: [1, 1, 1, 0.8], size: 1024, tile: [0.64, 0.64], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  const int NA = 14, NC = 26;
  const float PITCH = 0.0025;
  vec2 cs = uTile / vec2(float(NA), float(NC));
  // ragged stroke outlines: the work surface is warped by a millimetre or two
  vec2 w = m + vec2(fbm(m, 30.0, 2, 0.5, 301u), fbm(m, 30.0, 2, 0.5, 302u)) * 0.0012;
  float best = 0.0, bestT = 0.0, bestG = 0.0;
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
      vec2 c = vec2((float(i) + h1) * cs.x + rowOff, (float(j) + 0.05 + 0.9 * h2) * cs.y);
      float ang = (h3 - 0.5) * 0.17;                    // ±5°
      float len = 0.03 + 0.06 * h4 * h4;                // 30-90 mm, mostly short
      float teeth = floor(6.0 + 6.99 * h5);             // 6-12 teeth engaged
      float dep = 0.0006 + 0.0008 * h6;
      vec2 t = vec2(cos(ang), sin(ang));
      vec2 d = w - c;
      float f = dot(d, t) / len + 0.5;                  // 0 at the bite, 1 at the run-out
      float y = dot(d, vec2(-t.y, t.x));                // across the stroke (m)
      // the chisel lifts as it runs out: narrower, and the outer teeth stop cutting first
      float wid = teeth * PITCH * (1.0 - 0.35 * sat(f));
      float edgeW = 1.0 - smoothstep(0.5 * wid - 0.0045, 0.5 * wid, abs(y) + 0.002 * fract(h6 * 13.7));
      float alo = smoothstep(-0.04, 0.08, f) * (1.0 - smoothstep(0.25, 1.0, f)) * step(-0.06, f);
      // tooth grooves: rounded V at every pitch, the ridges between them left standing
      float ph = fract(y / PITCH + h1 * 7.0);
      float tooth = 1.0 - pow(abs(ph - 0.5) * 2.0, 1.5);
      float hs = -dep * alo * edgeW * (0.3 + 0.7 * tooth);
      if (hs < best) { best = hs; bestT = h1; bestG = tooth; }
    }
  }
  // the pecked rough-out surface left between the strokes
  vec4 v = voro(m, vec2(260.0), 309u, 1.0);
  float pore = smoothstep(0.2, 0.05, v.x) * step(0.9, v.z);
  float peck = smoothstep(0.5, 0.1, v.x) * step(0.55, v.z);
  float isl = 1.0 - smoothstep(-0.0002, 0.0, best);    // inside a stroke
  s.height = best + fbm(m, 120.0, 3, 0.5, 310u) * 0.0001 - pore * 0.0004 - (1.0 - isl) * peck * 0.00035;
  // deep grooves hold a little dust; tone per stroke
  float dn = sat(-best / 0.001);
  float a = 1.02 - 0.05 * dn * bestG + 0.03 * isl * (bestT - 0.5) - 0.04 * (1.0 - isl) * peck - 0.2 * pore + 0.03 * (v.z - 0.5);
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

// Close-range texture of the rock-faced bosses (detail map, same format as tooling; tile
// 0.5 m at 0.5 mm/texel): only what a hammer-pitched face shows within a few metres, fine
// pitting (2-5 mm pits, 0.3-0.8 mm deep), a sparse scatter of small spalls (~1 cm) and the
// stone's grain. The large planar fracture facets live in the rustic map itself; nothing
// at the 2-6 cm scale here (that read as crumpled paper). Applied per block with the
// dressing machinery (rotated per block, faded on the drafted margin and beyond ~6 m).
export const pitch = {
  name: 'pitch', flat: [1, 1, 1, 0.8], size: 1024, tile: [0.5, 0.5], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec4 v = voro(m, vec2(280.0), 331u, 1.0);              // ~3.6 mm pits on about half the cells
  float pit = smoothstep(0.55, 0.05, v.x) * step(0.5, v.z) * (0.4 + 0.6 * fract(v.z * 13.1));
  vec4 v2 = voro(m, vec2(110.0), 332u, 1.0);             // ~9 mm spalls, sparse
  float spall = smoothstep(0.6, 0.0, v2.x) * step(0.92, v2.z);
  vec4 v3 = voro(m, vec2(600.0), 336u, 1.0);             // ~1.7 mm grains
  float g = fbm(m, 150.0, 2, 0.5, 333u);
  s.height = -pit * 0.0007 - spall * 0.0012 + (v3.x - 0.5) * 0.00012 + g * 0.00008;
  float a = 1.0 - 0.07 * pit - 0.05 * spall + 0.04 * (v3.z - 0.5) + 0.02 * g;
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

// Ashlar: courses of 0.35 m, blocks 0.36-1.2 m; 6 mm pointing recessed 4-5 mm behind
// rounded, worn and soiled arrises with chips, faces slightly proud / sunk / tilted per
// block. 2 mm/texel, so joints and arrises stay crisp from the sidewalk (about a metre). The dressing
// (taltish, mussamsam, rubbed) is applied at runtime from the detail maps above.
export const ashlar = {
  name: 'ashlar', flat: [0.59, 0.5, 0.33, 0.86], size: 2048, tile: [4.2, 4.2], ss: 2,
  layout: { rowH: 0.35, rows: 12, seg: [5, 7], jitter: 0.42, seed: 11, shift: true },
  joint: 0.0055,
  pass: { normal: 1.0, ao: 0.75, aoRadius: 0.012, cavity: 0.06 },
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
  float hMortar = -0.0045 + fbm(m, 70.0, 2, 0.5, 13u) * 0.0006 + 0.0008 * smoothstep(0.0, JW, e);
  float stone = smoothstep(JW - 0.0008, JW + 0.0008, e);
  float hs = 0.0;
  vec3 alb = limestone(m, c.h, hs);
  s.height = mix(hMortar, max(hFace + hs, hMortar), stone);
  // soiled arrises (lightly: the shading does the rest), fresh chips paler
  alb *= mix(0.93, 1.0, smoothstep(0.0, 0.02, e - JW));
  alb *= 1.0 + 0.07 * chip;
  vec3 mortar = vec3(0.58, 0.545, 0.47) * (1.0 + 0.07 * fbm(m, 45.0, 2, 0.5, 19u));
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.95, 0.86 + 0.03 * fbm(m, 9.0, 2, 0.5, 20u), stone);
}
`,
};

// Rock-faced rustication ("tubzeh"): a hammer-pitched boss 2-5 cm proud (per block) inside a
// flat drafted margin of 25-40 mm (fine chisel lines), a steep pitched break between the
// two, and deep recessed joints. Courses 0.5 m; 4 × 2 m tile at 2 mm/texel so the ridges
// stay sharp. The boss is a handful of large planar fracture facets: the lower envelope of
// 5-9 planes tilted 8-15° and set round the block (each leaves the crown at its own
// distance, so the facets differ in size) under one or two nearly level crown facets; they
// meet in sharp, slightly wandering ridges that self-shadow under raking sun. On top only
// small things: the pitching tool's bites along the break line (short tapered chisel
// scars) and, from the detail map at close range, fine pitting. Every block is pitched
// differently (facet count, sizes, tilts, a boss leaning to one side; the runtime also
// mirrors the relief at random per block).
export const rustic = {
  name: 'rustic', flat: [0.58, 0.49, 0.33, 0.9], size: [2048, 1024], tile: [4.0, 2.0], ss: 2,
  layout: { rowH: 0.5, rows: 4, seg: [4, 6], jitter: 0.36, seed: 23, shift: true },
  joint: 0.01,
  pass: { normal: 1.1, ao: 0.5, aoRadius: 0.012, cavity: 0.05 },
  glsl: limestone(0.5) + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 5.0, 3, 0.5, 51u) * 0.003;
  const float JW = 0.006;
  float margin = 0.025 + 0.015 * cellRand(c, 2u);
  // pitched edge: the boss breaks away steeply 6-10 mm inside the margin, irregularly
  float brk = margin + 0.005 * fbm(m, 14.0, 3, 0.5, 59u) + 0.004 * cellRand(c, 4u);
  float rise = smoothstep(brk, brk + 0.006 + 0.004 * cellRand(c, 5u), e);
  // boss facets, in metres from the block centre; the ridges wander a few millimetres
  vec2 hs = 0.5 * c.size;
  vec2 q = c.lp - hs;
  vec2 qw = q + vec2(fbm(m, 7.0, 2, 0.5, 61u), fbm(m, 7.0, 2, 0.5, 62u)) * 0.005;
  float crown = 0.02 + 0.03 * cellRand(c, 3u);                  // 2-5 cm proud
  vec2 lean = (vec2(cellRand(c, 11u), cellRand(c, 12u)) - 0.5) * 0.05;   // boss leaning to one side
  int nf = 5 + int(cellRand(c, 6u) * 4.99);                     // 5-9 side facets
  float a0 = cellRand(c, 7u) * 6.2831853;
  float rock = 1.0, second = 1.0, fid = 0.0;
  for (int k = 0; k < 9 * uOne; k++) {
    if (k >= nf) break;
    float hk = cellRand(c, 20u + uint(k)), hk2 = cellRand(c, 40u + uint(k));
    float ang = a0 + (float(k) + 0.6 * (hk - 0.5)) * 6.2831853 / float(nf);
    vec2 n = vec2(cos(ang), sin(ang));
    float reach = abs(n.x) * hs.x + abs(n.y) * hs.y;            // half extent of the block that way
    float r = reach * (0.2 + 0.45 * hk2);                       // where the facet leaves the crown
    float slope = 0.14 + 0.13 * fract(hk * 7.31);               // 8-15°
    vec2 dq = qw - n * (r + 0.5 * (reach - r));
    float h = crown - slope * (dot(n, qw) - r) + 0.06 * dot(dq, dq) / max(reach, 0.1);   // a faint conchoidal dish
    if (h < rock) { second = rock; rock = h; fid = hk; } else if (h < second) { second = h; }
  }
  for (int k = 0; k < 2 * uOne; k++) {                          // nearly level crown facets
    float hk = cellRand(c, 60u + uint(k));
    vec2 p0 = (vec2(cellRand(c, 62u + uint(k)), cellRand(c, 64u + uint(k))) - 0.5) * hs;
    vec2 n = vec2(cos(hk * 6.2831853), sin(hk * 6.2831853));
    float h = crown + 0.003 * float(k) - (0.03 + 0.06 * fract(hk * 5.3)) * dot(n, qw - p0);
    if (h < rock) { second = rock; rock = h; fid = hk; } else if (h < second) { second = h; }
  }
  rock += dot(q, lean) + 0.0025 * fbm(m, 3.0, 2, 0.5, 52u);      // lean, a faint broad swell
  // chisel scars: the pitching tool's bites along the break line, short tapered grooves
  // running in from the edge (about one every 8 cm, at random)
  bool alongX = min(c.ed.z, c.ed.w) < min(c.ed.x, c.ed.y);
  float tE = alongX ? c.lp.x : c.lp.y;
  float dIn = e - brk;
  float ti = floor(tE / 0.045);
  float hb = cellRand(c, 80u + uint(ti) + (alongX ? 0u : 400u));
  float hb2 = fract(hb * 13.37), hb3 = fract(hb * 7.11);
  float tc = (ti + 0.2 + 0.6 * hb2) * 0.045;
  float len = 0.02 + 0.035 * hb3;
  float wid = 0.003 + 0.004 * fract(hb * 3.7);
  float fa = sat(dIn / len);
  float scar = step(hb, 0.4) * step(0.0, dIn) * (1.0 - smoothstep(0.55, 1.0, fa))
             * (1.0 - smoothstep(0.35 * wid, wid, abs(tE - tc) / (1.0 - 0.7 * fa)));
  rock -= scar * 0.004 * (1.0 - fa);
  float hRock = (0.006 + log(1.0 + exp((rock - 0.006) / 0.003)) * 0.003) * rise;   // soft floor
  // drafted margin: flat band with fine parallel chisel lines (3 mm pitch) across it
  float dirL = alongX ? m.x : m.y;
  float hMargin = -0.0015 - 0.00025 * (0.5 + 0.5 * sin(dirL / 0.003 * 6.2831853 + fbm(m, 20.0, 2, 0.5, 57u) * 2.0));
  float t = clamp((e - JW) / 0.004, 0.0, 1.0);
  float hFace = mix(-0.012, max(hMargin, hRock), sqrt(1.0 - (1.0 - t) * (1.0 - t)));
  float stone = smoothstep(JW - 0.001, JW + 0.001, e);
  float hm = 0.0;
  vec3 alb = limestone(m, c.h, hm);
  // fracture facets each a touch paler or darker, ridges and fresh chisel bites bruised
  // paler, crowns washed
  float ridge = 1.0 - smoothstep(0.0, 0.0015, second - rock);
  alb *= 1.0 + (0.07 * (fid - 0.5) + 0.04 * ridge + 0.05 * scar) * rise;
  alb *= mix(0.96, 1.02, sat(hRock / 0.04));
  vec3 mortar = vec3(0.6, 0.56, 0.48) * (1.0 + 0.08 * fbm(m, 40.0, 2, 0.5, 58u));
  s.height = mix(-0.016, hFace + hm, stone);
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.97, mix(0.84, 0.9, rise), stone);
}
`,
};

// Finely dressed trim stone (cornices, sills, string courses, arches): rubbed faces, no joints.
export const smooth = {
  name: 'smooth', flat: [0.61, 0.515, 0.335, 0.75], size: 512, tile: [2.0, 2.0], ss: 2,
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
