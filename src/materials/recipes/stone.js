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
  // warm honey-cream body (linear R/B ~2.2, sRGB ~1.43): sunlit Jerusalem limestone reads
  // honey, not grey-cream; the per-building tints shift it golden or pale from here
  vec3 base = vec3(0.62, 0.495, 0.28);
  // soft clouding, faint: a cut face of good building stone is nearly even in tone (the
  // block-to-block patchwork comes from the runtime cell tints)
  float mot = fbm(m + vec2(hc * 13.7, hc * 5.3), 2.2, 5, 0.55, 14u);   // soft clouds ~0.5 m
  float mot2 = fbm(m + vec2(hc * 2.9, 0.0), 10.0, 3, 0.6, 15u);       // 4-10 cm clouding
  vec3 c = base * (1.0 + ${(0.05 * cloud).toFixed(4)} * mot + ${(0.09 * cloud).toFixed(4)} * mot2);
  // slightly warmer (honey) and paler drifts inside one block (a hue swing of a few
  // percent: a larger one reads as round blue-grey blotches next to the honey)
  float w = fbm(m + vec2(hc * 3.1, 0.0), 3.5, 4, 0.55, 16u);
  c *= mix(vec3(1.0, 0.995, 0.99), vec3(1.025, 0.99, 0.935), smoothstep(-0.45, 0.55, w));
  // pores: tiny dark holes, sparse and uneven (denser in some beds of the stone)
  vec4 pv = voro(m, vec2(140.0), 17u, 1.0);
  float pden = 0.9 - 0.08 * smoothstep(-0.2, 0.5, fbm(m, 2.5, 2, 0.5, 25u));
  float pore = smoothstep(0.18, 0.05, pv.x) * step(pden, pv.z);
  c *= 1.0 - 0.28 * pore;
  h -= pore * 0.0008;
  // fossil / calcite fragments: small pale flecks
  vec4 fv = voro(m, vec2(55.0), 18u, 1.0);
  float fos = smoothstep(0.16, 0.05, fv.x) * step(0.88, fv.z);
  c = mix(c, c * vec3(1.12, 1.11, 1.08), fos);
  // weathering patina: clusters of grey-black microbial specks on exposed faces
  float patch_ = smoothstep(0.0, 0.55, fbm(m, 1.8, 4, 0.6, 22u));
  vec4 dv = voro(m, vec2(90.0), 23u, 1.0);
  float speck = smoothstep(0.22, 0.08, dv.x) * step(0.97 - 0.65 * patch_ * patch_, dv.z);
  c = mix(c, c * vec3(0.55, 0.53, 0.5), speck * 0.6);
  c *= 1.0 - 0.045 * patch_;
  // iron-oxide flushes (pink / ochre) and grey clay seams
  float fe = smoothstep(0.35, 0.8, fbm(m, 1.6, 4, 0.6, 19u)) * step(0.6, fract(hc * 7.31));
  c = mix(c, c * vec3(1.05, 0.9, 0.78), fe * ${(0.6 * cloud).toFixed(3)});
  float seam = smoothstep(0.75, 0.95, 1.0 - abs(fbm2(m + vec2(hc * 4.0), vec2(1.2, 6.0), 3, 0.5, 24u)));
  c = mix(c, c * vec3(0.9, 0.88, 0.85), seam * ${(0.35 * cloud).toFixed(3)} * step(0.5, fract(hc * 3.7)));
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

// Taltish: the face is worked over with a toothed (comb) chisel, every stroke driven the
// same way (one working direction per face: no crossing passes). The strokes lie in rows
// side by side across the face, each row a run of strokes end to end along the working
// direction; every row starts at its own place, so the bite ends of one row never line up
// with the next (aligned ends read as a second hatch across the first, a basket weave).
// A row is worked in passes of two or three strokes, each pass at its own angle (±3.5°),
// tooth pitch (2.8-5.2 mm, a worn or a finer tool) and depth; a stroke is 10-15 cm long and
// one chisel wide (4.4-5.9 cm), overlapping its neighbours. It bites in and runs out; the
// teeth do not bite on one line (the bite end is ragged), their grooves are unevenly spaced
// and deep (worn teeth shallower, a broken one leaves a ridge), and the depth varies along
// the stroke. One stroke in eleven is missing and some are shallow, leaving the smoother face;
// the tool's corner has knocked out the odd pock, and the stone's pores break the grooves.
// The depth drifts over 20-40 cm (some areas worked harder). The working direction is along
// u: the runtime rotates the map per block (one angle per block, 35-100° from horizontal),
// lays it out in the wall's uv (metres, scaled per building by up to about a quarter to fit
// its coursing, so the tooling scales a little with the stone) and fades the striation
// inside the drafted margin and with distance. The relief carries the look in the sun; the
// albedo follows it (dust in the grooves and pocks), so it also reads in shade.
// Detail map format: surface = (normal.xy, moment, albedo modulation with 0.5 = neutral).
export const tooling = {
  name: 'tooling', flat: [1, 1, 1, 0.8], size: 1024, tile: [0.64, 0.64], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  const int NR = 18, NS = 7;                 // stroke rows across the tile (35.6 mm), strokes per row (91 mm)
  float rh = uTile.y / float(NR), sl = uTile.x / float(NS);
  // depth drifts over 20-40 cm: some areas worked harder
  float dfield = 0.75 + 0.5 * fbm(m, 3.0, 3, 0.55, 341u);
  float best = 0.0, bestT = 0.5, bestG = 0.0, worked = 0.0;
  int j0 = int(floor(m.y / rh));
  for (int dj = -uOne; dj <= uOne; dj++) {
    int j = j0 + dj;
    int jw = sfMod(j, NR);
    // the row: where its strokes start (a fraction of a stroke), how far it lies off its
    // slot, and where its passes begin
    uint hr = sfH2(jw, 3, 351u);
    float rOff = sfHf(hr);
    float rDy = (sfHf(sfH(hr + 1u)) - 0.5) * 0.3 * rh;
    int pOff = int(sfHf(sfH(hr + 2u)) * 2.99);
    int i0 = int(floor(m.x / sl - rOff));
    for (int di = -uOne; di <= uOne; di++) {
      int i = i0 + di;
      int iw = sfMod(i, NS);
      uint h = sfH2(iw, jw, 345u);
      float h1 = sfHf(h), h2 = sfHf(sfH(h + 1u)), h3 = sfHf(sfH(h + 2u));
      float h4 = sfHf(sfH(h + 3u)), h5 = sfHf(sfH(h + 4u)), h6 = sfHf(sfH(h + 5u));
      float h7 = sfHf(sfH(h + 6u)), h8 = sfHf(sfH(h + 7u));
      if (h8 < 0.09) continue;                                     // a stroke left out
      // its pass: two or three strokes along the row, one direction, tooth pitch and depth
      int pu = sfMod(iw + pOff, NS) / 3;
      uint hp = sfH2(pu, jw, 348u);
      float pAng = (sfHf(hp) - 0.5) * 0.12;                        // ±3.5°
      float pitch = 0.0028 + 0.0024 * sfHf(sfH(hp + 1u));          // 2.8-5.2 mm
      float pDep = 0.65 + 0.6 * sfHf(sfH(hp + 2u));
      vec2 c0 = vec2((float(i) + rOff + 0.5 + 0.3 * (h2 - 0.5)) * sl, (float(j) + 0.5 + 0.15 * (h3 - 0.5)) * rh + rDy);
      float sa = pAng + (h4 - 0.5) * 0.07;                         // ±2° within the pass
      vec2 dir = vec2(cos(sa), sin(sa));
      // long and wide enough that the strokes overlap and cover the face
      float len = sl * (1.1 + 0.5 * h5);                           // 10-14.6 cm
      float wid = rh * (1.25 + 0.4 * h6);                          // 4.4-5.9 cm (10-17 teeth)
      vec2 d = m - c0;
      float f = dot(d, dir) / len + 0.5;                           // 0 at the bite, 1 at the run-out
      float y = dot(d, vec2(-dir.y, dir.x));
      float acr = 1.0 - smoothstep(0.5 * wid - 0.005, 0.5 * wid, abs(y));
      if (acr <= 0.0 || f <= 0.0 || f >= 1.0) continue;
      // the stroke's teeth: each groove at its own offset and width within the pitch (the
      // spacing uneven), its own depth (one tooth in eleven broken off: a ridge), its own
      // bite point (a ragged bite end, never one straight line) and run-out
      float gy = y / pitch + h7 * 7.0;
      float tn = floor(gy);
      uint ht = sfH2(int(tn) + 64, iw * NR + jw, 349u);
      float t1 = sfHf(ht), t2 = sfHf(sfH(ht + 1u)), t3 = sfHf(sfH(ht + 2u)), t4 = sfHf(sfH(ht + 3u));
      float tc = 0.5 + 0.2 * (t2 - 0.5), tw = 0.3 + 0.1 * t3;
      float q = (gy - tn - tc) / tw;
      float tooth = sat(1.0 - q * q);
      float toothK = t1 < 0.09 ? 0.12 : 0.55 + 0.65 * t4;
      float f0 = 0.24 * fract(t2 * 7.31), f1 = 0.55 + 0.25 * fract(t3 * 5.17);
      float alo = smoothstep(f0, f0 + 0.1, f) * (1.0 - smoothstep(f1, min(f1 + 0.35, 1.0), f));
      float env = alo * acr;
      float along = 0.7 + 0.6 * (0.5 + 0.5 * noiseM(vec2(f * len + h1, h7), vec2(25.0), 350u));
      // a few strokes only grazed the face
      float sDep = h1 < 0.15 ? 0.5 : 1.0;
      float dep = (0.00025 + 0.0003 * h1) * sDep * dfield * pDep * toothK * along * (1.0 - 0.45 * sat(f));
      float hs = -dep * env * tooth;
      worked = max(worked, dep * env);
      if (hs < best) { best = hs; bestT = h1; bestG = tooth; }
    }
  }
  // pocks: where the tool's corner dug in or a hard grain broke out, a small pit 2-5 mm
  // across (sparse, a few per hand's breadth), and the stone's natural pores, both breaking
  // the grooves; a trace of grain
  vec4 pk = voro(m, vec2(120.0), 352u, 1.0);
  float pock = smoothstep(0.28, 0.06, pk.x) * step(0.98, pk.z) * (0.6 + 0.4 * fract(pk.z * 31.7));
  vec4 v = voro(m, vec2(260.0), 309u, 1.0);
  float pore = smoothstep(0.2, 0.05, v.x) * step(0.93, v.z);
  best *= 1.0 - smoothstep(0.3, 0.12, v.x) * step(0.93, v.z);
  s.height = min(best, -pock * 0.0005) + fbm(m, 120.0, 3, 0.5, 310u) * 0.00006 - pore * 0.0004;
  // dust held in the grooves and pocks, a little over the whole deep end of a stroke (so a
  // stroke reads as a dash running out along the working direction), and the strokes' own
  // tone (each a touch paler or darker): the dressing reads in shade too, where the relief
  // alone gives no contrast (mean 1.04 as before: the runtime's near-far balance)
  float dn = sat(-best / 0.0005);
  float a = 1.107 - 0.32 * dn * bestG - 0.1 * sat(worked / 0.0005) + 0.12 * (bestT - 0.5) - 0.2 * pore - 0.1 * pock + 0.03 * (v.z - 0.5);
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

// Ashlar: courses of 0.35 m, blocks 0.36-1.2 m; 4-8 mm light grey-beige lime pointing,
// recessed about 1.5 mm behind the arrises; faces slightly proud / sunk / tilted per block.
// 2 mm/texel, so joints and arrises stay crisp from the sidewalk (about a metre). The arris
// is crisp along roughly half its length and worn to a small dusty chamfer (1-4 mm) along
// the rest, so its light catch comes and goes instead of running as a ruled line. About
// half the blocks have lost a chip or two from their arrises (about one per metre of arris
// there): an irregular flake 8-36 mm along the arris, its outline a few straight fracture
// facets (never a round notch), cut a millimetre or two into the face, deepest at the
// arris and running out inwards, the fracture a little darker than the face (dust). The
// faces are hand dressed, so not quite plane: they undulate by a millimetre or so over
// 5-10 cm. A little dust works a centimetre or two in from the joints, and some blocks
// carry faint warm-grey weathering in tall streaks (rain runs down a face, it does not
// leave round clouds). The dressing (taltish, mussamsam, rubbed) is applied at runtime from
// the detail maps above.
export const ashlar = {
  name: 'ashlar', flat: [0.6, 0.47, 0.27, 0.86], size: 2048, tile: [4.2, 4.2], ss: 2,
  layout: { rowH: 0.35, rows: 12, seg: [5, 7], jitter: 0.42, seed: 11, shift: true },
  joint: 0.0055,
  pass: { normal: 1.0, ao: 0.55, aoRadius: 0.01, cavity: 0.08 },
  glsl: limestone() + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float hA = cellRand(c, 1u);
  vec2 ms = m + vec2(c.h * 17.3, cellRand(c, 30u) * 11.9);
  // crumbly arris line: small irregularities, no long smooth swell
  float wob = fbm(m, 8.0, 2, 0.5, 11u) * 0.0008 + fbm(m, 45.0, 3, 0.55, 12u) * 0.0005;
  float e = c.e + wob;
  // half joint: 4-8 mm pointing, its width wandering along the joint (the same on both
  // sides of it: a function of the tile position, not of the block)
  float JW = 0.0022 + 0.0016 * (0.5 + 0.5 * noiseM(m, vec2(5.0), 40u));
  // which arris: along a bed joint (horizontal) or a head joint
  bool bed = min(c.ed.z, c.ed.w) < min(c.ed.x, c.ed.y);
  float ta = bed ? m.x : m.y;                    // position along the arris
  // worn chamfer 1-4 mm along about half of the arris, crisp between
  float wear = smoothstep(0.0, 0.45, noiseM(vec2(ta, c.h * 9.0), vec2(9.0), 39u) + 0.35 * (cellRand(c, 3u) - 0.5));
  float bev = 0.0004 + (0.0008 + 0.003 * cellRand(c, 4u)) * wear;
  // chips: on about half the blocks, in a 0.6 m stretch of arris in two (about one per
  // metre of arris there), a flake broken out 8-36 mm along the arris (mostly small),
  // reaching 3-12 mm into the face. Its outline is a few straight fracture facets (two
  // flanks rising from the arris, an inner edge, sometimes a fourth facet across a corner),
  // a little ragged; it is 0.8-2.2 mm deep at the arris and runs out inwards, with no step
  // at its inner edge (a shadowed lip there read as a bright half moon in the sun)
  float spall = 0.0, chipIn = 0.0;
  if (cellRand(c, 38u) < 0.5) {
    float seg = floor(ta / 0.6);
    uint sh = sfH2(int(seg), bed ? 1 : 2, c.id + 211u);
    if (sfHf(sh) < 0.55) {
      float hl = sfHf(sfH(sh + 1u));
      float sl = 0.004 + 0.014 * hl * hl;                         // half length 4-18 mm
      float sc = (seg + 0.5) * 0.6 + (sfHf(sfH(sh + 2u)) - 0.5) * 0.5;
      float a = ta - sc;
      if (abs(a) < 1.3 * sl) {
        float h3 = sfHf(sfH(sh + 3u)), h4 = sfHf(sfH(sh + 4u)), h5 = sfHf(sfH(sh + 5u)), h6 = sfHf(sfH(sh + 6u));
        float x = e - JW + 0.0005 * noiseM(ms, vec2(260.0), 37u);  // into the face from the arris (m)
        float aL = -sl * (0.7 + 0.3 * h3), aR = sl * (0.7 + 0.3 * h4);
        float kL = 0.6 + 1.9 * h5, kR = 0.6 + 1.9 * fract(h5 * 7.31);
        float hIn = (0.003 + 0.009 * h6) * (0.5 + 0.5 * sl / 0.018), mI = (fract(h6 * 5.17) - 0.5);
        float d = min((kL * (a - aL) - x) * inversesqrt(1.0 + kL * kL), (kR * (aR - a) - x) * inversesqrt(1.0 + kR * kR));
        d = min(d, (hIn + mI * a - x) * inversesqrt(1.0 + mI * mI));
        if (fract(h3 * 3.71) < 0.5) {
          float m4 = (fract(h4 * 9.13) < 0.5 ? -1.0 : 1.0) * (0.8 + 0.8 * fract(h4 * 3.3));
          d = min(d, (0.8 * hIn + abs(m4) * 0.3 * sl + m4 * a - x) * inversesqrt(1.0 + m4 * m4));
        }
        float inside = smoothstep(0.0, 0.0007, d) * step(-0.002, x);
        float sd = (0.0008 + 0.0014 * sfHf(sfH(sh + 7u))) * (0.6 + 0.4 * sqrt(sl / 0.018));
        spall = sd * (1.0 - 0.75 * sat(x / max(hIn + mI * a, 1e-4))) * inside;
        chipIn = inside;
      }
    }
  }
  // face: not perfectly flat, block proud / sunk and slightly tilted, and hand dressed: a
  // millimetre or so of undulation over 5-10 cm (more on some blocks)
  float face = fbm(m, 3.5, 3, 0.5, 30u) * 0.0012 + (hA - 0.5) * 0.0024;
  face += dot(c.lp - 0.5 * c.size, vec2(cellRand(c, 7u) - 0.5, cellRand(c, 8u) - 0.5)) * 0.008;
  face += fbm(ms, 14.0, 3, 0.55, 42u) * (0.0005 + 0.001 * cellRand(c, 43u));
  float t = clamp((e - JW) / bev, 0.0, 1.0);
  float hFace = face - bev * 0.38 * pow(1.0 - t, 1.5) * (1.0 + 0.4 * fbm(m, 120.0, 2, 0.5, 31u));
  hFace -= spall * (1.0 + 0.15 * fbm(ms, 150.0, 2, 0.5, 32u));
  float broken = smoothstep(0.0003, 0.0009, spall) * chipIn;
  // pointing: struck a little behind the arrises, slightly ruled (fuller in the middle),
  // nearly flush in stretches and washed out deeper in others
  float mWash = 0.5 + 0.5 * noiseM(m, vec2(4.0), 41u);
  float hMortar = -0.0007 - 0.0018 * mWash + fbm(m, 70.0, 2, 0.5, 13u) * 0.0003 + 0.0004 * smoothstep(0.0, JW, e);
  float stone = smoothstep(JW - 0.0006, JW + 0.0006, e);
  float hs = 0.0;
  vec3 alb = limestone(m, c.h, hs);
  s.height = mix(hMortar, max(hFace + hs, hMortar), stone);
  // soiling: a little dust worked a centimetre or two in from the joints (patchy, more on
  // some blocks), warm grey-brown like the street dust; the worn chamfer dustier still (it
  // holds the dust, so it does not light up as a ruled line along every joint)
  float ej = e - JW;
  float soil = (0.03 + 0.05 * cellRand(c, 33u)) * (0.4 + 1.2 * (0.5 + 0.5 * fbm(ms, 7.0, 3, 0.55, 34u)));
  float dusty = soil * (1.0 - smoothstep(0.0, 0.025, ej)) + 0.16 * (1.0 - t) * (1.0 - t) * (1.0 - broken);
  alb = mix(alb, vec3(lum(alb)) * vec3(0.92, 0.84, 0.72), 0.5 * dusty) * (1.0 - 0.6 * dusty);
  // chips: the fracture holds dust and lies in its own shade, a little darker than the face
  alb *= 1.0 - (0.03 + 0.04 * cellRand(c, 39u)) * broken;
  // weathering: on some blocks faint warm-grey streaks running down the face (tall and
  // narrow, never round clouds)
  float crust = smoothstep(0.15, 0.6, fbm2(ms, vec2(6.0, 1.1), 3, 0.55, 35u) + 0.3 * (cellRand(c, 36u) - 0.5)) * smoothstep(0.35, 0.9, cellRand(c, 36u));
  alb = mix(alb, vec3(lum(alb)) * vec3(0.9, 0.83, 0.72), 0.18 * crust) * (1.0 - 0.06 * crust);
  alb *= 1.005;                                  // keeps the mean albedo of the limestone (meta)
  // pointing (lime with stone dust): light beige, a touch darker and greyer than the stone
  // but close to its hue (linear R/B ~1.85 against ~2.2): a greyer mortar turns neutral
  // under the blue sky light and reads as a white line along every joint; dirtier in places
  vec3 mortar = vec3(0.56, 0.475, 0.3) * (1.0 + 0.08 * fbm(m, 45.0, 2, 0.5, 19u)) * (1.0 - 0.14 * (0.5 + 0.5 * fbm(m, 6.0, 2, 0.5, 18u)))
              * (1.0 - 0.16 * smoothstep(0.45, 0.85, mWash));     // dirt held in the washed-out stretches
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.95, mix(0.86 + 0.03 * fbm(m, 9.0, 2, 0.5, 20u), 0.93, max(0.6 * (1.0 - t), broken)), stone);
}
`,
};

// Rock-faced rustication ("tubzeh"): a hammer-pitched boss 5-9 cm proud (per block) inside a
// narrow flat drafted margin of 15-25 mm (fine chisel lines), deep recessed joints (12 mm
// wide, 2 cm behind the margin, ambient occlusion 0.4). Courses 0.5 m; 4 × 2 m tile at
// 2 mm/texel. The boss is a rounded mass, not a crumple of small facets: a loaf whose
// shoulders roll over 2.5-7 cm from the pitch line (1.6-4.3 cm proud there, varying along
// the edge), its crown undulating and leaning; 3-5 large planes struck off it (6-20°,
// crisp slightly worn rims, each a touch paler or darker); one or two conchoidal scars
// broken out of the shoulder at the edge; rounded hammer lumps at 5-15 cm; the pitching
// tool's bites along the break line. Dust greys the hollows. Every block is pitched
// differently (plane count and directions, crown, lean, scars; the runtime also mirrors
// the relief at random per block).
// The height (m) is stored in the albedo alpha (heightA: the range it encodes), for the
// runtime's parallax-occlusion relief and self-shadowing; the roughness comes from the
// height there (joints rougher).
export const rustic = {
  name: 'rustic', flat: [0.6, 0.475, 0.275, 0.2], size: [2048, 1024], tile: [4.0, 2.0], ss: 2,
  layout: { rowH: 0.5, rows: 4, seg: [4, 6], jitter: 0.36, seed: 23, shift: true },
  joint: 0.01,
  heightA: [-0.024, 0.096],
  pass: { normal: 1.25, ao: 1.0, aoRadius: 0.045, cavity: 0.15 },
  glsl: limestone(0.75) + /* glsl */ `
float sminP(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 5.0, 3, 0.5, 51u) * 0.003;
  const float JW = 0.006;
  float margin = 0.015 + 0.01 * cellRand(c, 2u);
  // pitch line: the boss breaks away 6-10 mm inside the margin, irregularly
  float brk = margin + 0.006 * fbm(m, 12.0, 3, 0.5, 59u) + 0.004 * cellRand(c, 4u);
  vec2 hs = 0.5 * c.size;
  vec2 q = c.lp - hs;
  // the plane intersections wander a centimetre or two
  vec2 qw = q + vec2(fbm(m, 3.0, 2, 0.5, 61u), fbm(m, 3.0, 2, 0.5, 62u)) * 0.018;
  float crown = 0.058 + 0.035 * cellRand(c, 3u);
  vec2 cc = (vec2(cellRand(c, 13u), cellRand(c, 14u)) - 0.5) * hs * 0.7;
  // the mass: a loaf whose shoulders roll over 3-9 cm from the pitch line (1-3.4 cm proud
  // there, varying along the edge), its top undulating (lumps of ~30 cm, the whole boss
  // leaning a little to one side)
  float dIn0 = max(e - brk, 0.0);
  float edgeH = 0.016 + 0.018 * cellRand(c, 8u) + 0.009 * fbm(m, 5.0, 2, 0.5, 63u);
  float w = 0.025 + 0.035 * cellRand(c, 9u) + 0.012 * fbm(m, 4.0, 2, 0.5, 64u);
  vec2 lean = (vec2(cellRand(c, 11u), cellRand(c, 12u)) - 0.5) * 0.06;
  float crownH = crown + 0.012 * fbm(m + vec2(c.h * 7.7), 3.0, 3, 0.5, 65u) + dot(q, lean)
               - 0.012 * dot((q - cc) / hs, (q - cc) / hs);
  float dome = edgeH + (crownH - edgeH) * (1.0 - exp(-dIn0 / w));
  // spalls: 3-5 large planes struck off the mass, set round the crown and falling outwards
  // more gently than the shoulders (6-20°), each leaving the crown at its own distance, so
  // they cut flat facets of different sizes with crisp (slightly worn) rims
  int nf = 3 + int(cellRand(c, 6u) * 2.99);
  float a0 = cellRand(c, 7u) * 6.2831853;
  float boss = dome, fid = 0.5;
  for (int k = 0; k < 5 * uOne; k++) {
    if (k >= nf) break;
    float hk = cellRand(c, 20u + uint(k)), hk2 = cellRand(c, 40u + uint(k));
    float ang = a0 + (float(k) + 0.6 * (hk - 0.5)) * 6.2831853 / float(nf);
    vec2 n = vec2(cos(ang), sin(ang));
    float rx = abs(n.x) > 1e-3 ? (sign(n.x) * hs.x - cc.x) / n.x : 1e3;
    float ry = abs(n.y) > 1e-3 ? (sign(n.y) * hs.y - cc.y) / n.y : 1e3;
    float reach = max(min(rx, ry) - brk, 0.06);
    float r0 = reach * (0.15 + 0.45 * hk2);
    float slope = 0.1 + 0.25 * fract(hk * 7.31);
    float h = crown - 0.004 - 0.01 * fract(hk * 3.71) - slope * max(dot(n, qw - cc) - r0, 0.0)
            + 0.15 * slope * dot(vec2(-n.y, n.x), qw - cc) * (fract(hk * 5.17) - 0.5);
    if (h < boss) fid = hk;
    boss = sminP(boss, h, 0.004);
  }
  float planes = boss;
  // one or two conchoidal scars: shallow dishes broken out of the boss at its edge (flakes
  // struck off the shoulder), wider along the edge than deep into the face, with a crisp
  // rim inside and running out over the shoulder
  int ns = 1 + int(cellRand(c, 70u) * 1.99);
  for (int k = 0; k < 2 * uOne; k++) {
    if (k >= ns) break;
    uint kk = uint(k) * 3u;
    float side = cellRand(c, 72u + kk) * 4.0;
    float tpos = cellRand(c, 73u + kk) * 1.6 - 0.8;
    // centre on the pitch line of one side, the dish lying inwards
    vec2 ps = side < 1.0 ? vec2(-hs.x, tpos * hs.y) : side < 2.0 ? vec2(hs.x, tpos * hs.y)
            : side < 3.0 ? vec2(tpos * hs.x, -hs.y) : vec2(tpos * hs.x, hs.y);
    vec2 inw = side < 1.0 ? vec2(1.0, 0.0) : side < 2.0 ? vec2(-1.0, 0.0) : side < 3.0 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
    float R = 0.07 + 0.09 * cellRand(c, 74u + kk);
    float D = 0.008 + 0.012 * cellRand(c, 77u + kk);
    vec2 dp = qw - ps - inw * (brk + 0.2 * R);
    vec2 dl = vec2(dot(dp, inw) / R, dot(dp, vec2(-inw.y, inw.x)) / (R * (1.4 + 0.8 * cellRand(c, 78u + kk))));
    float r2 = dot(dl, dl);
    float prof = max(1.0 - r2, 0.0);
    boss -= D * prof * sqrt(prof);
  }
  // rounded hammer lumps (5-15 cm), no small sharp creases: the rough mass of the face between the planes
  boss += 0.01 * fbm(m + vec2(c.h * 3.1), 6.0, 3, 0.5, 52u) + 0.0035 * fbm(m, 16.0, 2, 0.5, 53u) + 0.001 * fbm(m, 45.0, 2, 0.5, 54u);
  // chisel scars: the pitching tool's bites along the break line, short tapered grooves
  // running in from the edge (about one every 8 cm, at random)
  bool alongX = min(c.ed.z, c.ed.w) < min(c.ed.x, c.ed.y);
  float tE = alongX ? c.lp.x : c.lp.y;
  float dIn = e - brk;
  float ti = floor(tE / 0.045);
  float hb = cellRand(c, 90u + uint(ti) + (alongX ? 0u : 400u));
  float hb2 = fract(hb * 13.37), hb3 = fract(hb * 7.11);
  float tc = (ti + 0.2 + 0.6 * hb2) * 0.045;
  float len = 0.02 + 0.035 * hb3;
  float wid = 0.003 + 0.004 * fract(hb * 3.7);
  float fa = sat(dIn / len);
  float scar = step(hb, 0.4) * step(0.0, dIn) * (1.0 - smoothstep(0.55, 1.0, fa))
             * (1.0 - smoothstep(0.35 * wid, wid, abs(tE - tc) / (1.0 - 0.7 * fa)));
  boss -= scar * 0.004 * (1.0 - fa);
  // the break: the boss leaves the margin in a short rough cliff (2-4 mm wide)
  float rt = smoothstep(brk - 0.002, brk + 0.002 + 0.002 * cellRand(c, 5u), e);
  float rise = 1.0 - (1.0 - rt) * (1.0 - rt);
  float hRock = max(boss, 0.004) * rise;
  // drafted margin: flat band with fine parallel chisel lines (3 mm pitch) across it
  float dirL = alongX ? m.x : m.y;
  float hMargin = -0.0015 - 0.00025 * (0.5 + 0.5 * sin(dirL / 0.003 * 6.2831853 + fbm(m, 20.0, 2, 0.5, 57u) * 2.0));
  float t = clamp((e - JW) / 0.004, 0.0, 1.0);
  float hFace = mix(-0.014, max(hMargin, hRock), sqrt(1.0 - (1.0 - t) * (1.0 - t)));
  float stone = smoothstep(JW - 0.001, JW + 0.001, e);
  float hm = 0.0;
  vec3 alb = limestone(m, c.h, hm);
  // facets each a touch paler or darker, crowns washed paler, fresh bites pale; dust and
  // soot settle in the scars and hollows
  float hollow = sat((planes - boss) / 0.01) * rise;
  alb *= 1.0 + (0.07 * (fid - 0.5) + 0.04 * scar) * rise;
  alb = mix(alb, vec3(lum(alb)) * vec3(0.9, 0.84, 0.74), 0.15 * hollow) * (1.0 - 0.05 * hollow);
  // crowns washed paler by the rain, the low shoulders and the margin dustier
  alb *= mix(0.86, 1.05, sat(hRock / 0.06));
  // warm grey soot crust in patches over part of the boss (stretched down the face, as the
  // rain leaves it), heavier on some blocks; fine dark specks of lichen and soot in the pitting
  vec2 ms = m + vec2(c.h * 13.1, cellRand(c, 15u) * 7.7);
  float crust = smoothstep(0.05, 0.5, fbm2(ms, vec2(5.0, 1.6), 4, 0.6, 66u) + 0.35 * (cellRand(c, 16u) - 0.5)) * (0.4 + 0.6 * cellRand(c, 17u));
  alb = mix(alb, vec3(lum(alb)) * vec3(0.84, 0.77, 0.67), 0.2 * crust * rise) * (1.0 - 0.05 * crust * rise);
  vec4 sv = voro(ms, vec2(70.0), 67u, 1.0);
  alb *= 1.0 - 0.35 * smoothstep(0.3, 0.1, sv.x) * step(0.9 - 0.15 * crust, sv.z) * rise;
  alb *= 1.04;                                   // keeps the mean albedo of the limestone (meta)
  vec3 mortar = vec3(0.6, 0.56, 0.48) * (1.0 + 0.08 * fbm(m, 40.0, 2, 0.5, 58u));
  s.height = mix(-0.022, hFace + hm, stone);
  s.albedo = mix(mortar, alb, stone);
  s.ao = mix(0.4, 1.0, smoothstep(JW - 0.001, JW + 0.003, e));
  s.rough = mix(0.97, mix(0.86, 0.9, rise), stone);
}
`,
};

// Finely dressed trim stone (cornices, sills, string courses, arches): rubbed faces, no joints,
// weathered in patches.
export const smooth = {
  name: 'smooth', flat: [0.63, 0.495, 0.28, 0.75], size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.4, aoRadius: 0.006, cavity: 0.05 },
  glsl: limestone(0.45) + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float h = fbm(m, 2.5, 3, 0.5, 71u) * 0.0008 + fbm(m, 30.0, 3, 0.5, 72u) * 0.00025;
  // faint fine claw-tool striation along u
  h += sin(m.y / uTile.y * 333.0 * 6.2831853 + fbm(m, 6.0, 2, 0.5, 73u) * 3.0) * 0.00008;
  vec3 c = limestone(m, 0.37, h);
  // weathered trim: a warm grey crust in patches (sheltered undersides and returns keep it
  // longest), fine soot specks, faint rust-brown flushes
  float crust = smoothstep(0.1, 0.6, fbm2(m, vec2(2.4, 0.8), 4, 0.6, 75u));
  c = mix(c, vec3(lum(c)) * vec3(0.86, 0.8, 0.7), 0.22 * crust) * (1.0 - 0.05 * crust);
  vec4 sv = voro(m, vec2(80.0), 76u, 1.0);
  c *= 1.0 - 0.3 * smoothstep(0.3, 0.1, sv.x) * step(0.93 - 0.1 * crust, sv.z);
  s.albedo = c * vec3(1.04, 1.04, 1.04);
  s.height = h;
  s.rough = 0.74 + 0.04 * fbm(m, 8.0, 2, 0.5, 74u);
}
`,
};
