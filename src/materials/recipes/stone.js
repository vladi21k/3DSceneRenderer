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
  vec3 base = vec3(0.62, 0.495, 0.285);
  float mot = fbm(m + vec2(hc * 13.7, hc * 5.3), 2.2, 5, 0.55, 14u);   // soft clouds ~0.5 m
  float mot2 = fbm(m + vec2(hc * 2.9, 0.0), 10.0, 3, 0.6, 15u);       // 4-10 cm clouding
  vec3 c = base * (1.0 + ${(0.12 * cloud).toFixed(4)} * mot + ${(0.25 * cloud).toFixed(4)} * mot2);
  // warmer (honey) and cooler (grey-white) drifts inside one block
  float w = fbm(m + vec2(hc * 3.1, 0.0), 3.5, 4, 0.55, 16u);
  c *= mix(vec3(0.97, 0.99, 1.03), vec3(1.05, 0.98, 0.86), smoothstep(-0.45, 0.55, w));
  // pores: tiny dark holes, sparse and uneven (denser in some beds of the stone)
  vec4 pv = voro(m, vec2(140.0), 17u, 1.0);
  float pden = 0.9 - 0.08 * smoothstep(-0.2, 0.5, fbm(m, 2.5, 2, 0.5, 25u));
  float pore = smoothstep(0.18, 0.05, pv.x) * step(pden, pv.z);
  c *= 1.0 - 0.35 * pore;
  h -= pore * 0.0008;
  // fossil / calcite fragments: small pale flecks
  vec4 fv = voro(m, vec2(55.0), 18u, 1.0);
  float fos = smoothstep(0.16, 0.05, fv.x) * step(0.88, fv.z);
  c = mix(c, c * vec3(1.12, 1.11, 1.08), fos);
  // weathering patina: clusters of grey-black microbial specks on exposed faces
  float patch_ = smoothstep(0.0, 0.55, fbm(m, 1.8, 4, 0.6, 22u));
  vec4 dv = voro(m, vec2(90.0), 23u, 1.0);
  float speck = smoothstep(0.22, 0.08, dv.x) * step(0.97 - 0.65 * patch_ * patch_, dv.z);
  c = mix(c, c * vec3(0.45, 0.45, 0.47), speck * 0.85);
  c *= 1.0 - 0.045 * patch_;
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

// Taltish: the face is worked over with a toothed (comb) chisel driven the same way across
// the whole block, so it reads as one continuous field of fine parallel striation inside
// the drafted margin (never a quilt of separate patches). The strokes lie in rows one
// chisel wide (8-10 teeth, ~32 mm), end to end along the working direction: each 6-10 cm
// long, overlapping the next by a quarter to a half with soft ends (the tool bites in and
// runs out), and overlapping the neighbouring rows by a tooth or two. Every tooth leaves a
// rounded groove at a 4 mm pitch (3.5-4.5 mm after the runtime's per-block scale), 0.3-0.6
// mm deep, deepest just past the bite; the mason keeps the teeth roughly in the previous
// grooves, so the striation runs on from stroke to stroke with only a small jump. The depth
// drifts over 20-40 cm (some areas worked harder). The direction is along u: the runtime
// rotates the map per block (one angle per block, 60-75° from horizontal). No pecked dots
// here (those belong to the pecked blocks), only the stone's sparse natural pores. The
// relief carries the look; the albedo only follows it faintly (dust in the grooves).
// Detail map format: surface = (normal.xy, moment, albedo modulation with 0.5 = neutral).
export const tooling = {
  name: 'tooling', flat: [1, 1, 1, 0.8], size: 1024, tile: [0.64, 0.64], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  const int NR = 20, NS = 9;                 // stroke rows across the tile (32 mm), strokes per row (71 mm)
  const float PITCH = 0.004;
  float rh = uTile.y / float(NR), sl = uTile.x / float(NS);
  // depth drifts over 20-40 cm: some areas worked harder
  float dfield = 0.8 + 0.4 * fbm(m, 3.0, 3, 0.55, 341u);
  // hand-driven: the work lines wander by a fraction of a millimetre
  float wy = m.y + 0.0005 * fbm(m, 14.0, 2, 0.5, 342u);
  float best = 0.0, bestT = 0.5, bestG = 0.0;
  int j0 = int(floor(wy / rh));
  for (int dj = -uOne; dj <= uOne; dj++) {
    int j = j0 + dj;
    int jw = sfMod(j, NR);
    float rowOff = sfHash(ivec2(jw, 3), 343u) * sl;
    float yc = (float(j) + 0.5 + 0.2 * (sfHash(ivec2(jw, 5), 344u) - 0.5)) * rh;
    float rowPh = sfHash(ivec2(jw, 9), 346u);
    int i0 = int(floor((m.x - rowOff) / sl));
    for (int di = -2 * uOne; di <= uOne; di++) {
      int i = i0 + di;
      uint h = sfH2(sfMod(i, NS), jw, 345u);
      float h1 = sfHf(h), h2 = sfHf(sfH(h + 1u)), h3 = sfHf(sfH(h + 2u));
      float h4 = sfHf(sfH(h + 3u)), h5 = sfHf(sfH(h + 4u)), h6 = sfHf(sfH(h + 5u));
      float x0 = (float(i) + 0.25 * (h1 - 0.5)) * sl + rowOff;   // where the tool bites in
      float len = sl * (1.25 + 0.3 * h2);                          // 9-11 cm: overlaps the next stroke
      float ang = (h3 - 0.5) * 0.04;                               // ±1°
      float wid = rh * (1.12 + 0.18 * h4);                         // a tooth or two over the next rows
      vec2 d = vec2(m.x - x0, wy - yc);
      float f = (d.x + d.y * ang) / len;                           // 0 at the bite, 1 at the run-out
      float y = d.y - d.x * ang;
      // soft ends: bites in over the first 10 %, lifts out over the last 35 %
      float alo = smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(0.65, 1.0, f));
      float acr = 1.0 - smoothstep(0.5 * wid - 0.005, 0.5 * wid, abs(y));
      float env = alo * acr;
      if (env <= 0.0) continue;
      // grooves keep roughly to the previous stroke's (a small jump at each re-set)
      float ph = fract((wy - d.x * ang) / PITCH + rowPh + 0.3 * (h5 - 0.5));
      float tooth = pow(0.5 - 0.5 * cos(6.2831853 * ph), 0.7);
      float dep = (0.0003 + 0.0003 * h6) * dfield * (1.0 - 0.35 * sat(f));
      float hs = -dep * env * tooth;
      if (hs < best) { best = hs; bestT = h1; bestG = tooth; }
    }
  }
  // the stone's natural pores (sparse) and a trace of grain
  vec4 v = voro(m, vec2(260.0), 309u, 1.0);
  float pore = smoothstep(0.2, 0.05, v.x) * step(0.93, v.z);
  s.height = best + fbm(m, 120.0, 3, 0.5, 310u) * 0.00006 - pore * 0.0004;
  float dn = sat(-best / 0.0006);
  float a = 1.01 - 0.035 * dn * bestG + 0.012 * (bestT - 0.5) - 0.18 * pore + 0.02 * (v.z - 0.5);
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
// worn, crumbly, soiled arrises with angular spalls, faces slightly proud / sunk / tilted
// per block. 2 mm/texel, so joints and arrises stay crisp from the sidewalk (about a
// metre). The arris is a small worn chamfer (3-8 mm, its steepest part ~40°, never a
// rounded bead that would catch the sun as a glossy rim), broken along its length by
// spalls: flat fracture planes cut back 2-6 mm over 1-5 cm, their floors rough and dusty.
// Dust and soot settle in the pointing and work a few centimetres into the stone along
// the joints (patchy), and old weathered blocks carry a grey crust in patches. The
// dressing (taltish, mussamsam, rubbed) is applied at runtime from the detail maps above.
export const ashlar = {
  name: 'ashlar', flat: [0.6, 0.47, 0.27, 0.86], size: 2048, tile: [4.2, 4.2], ss: 2,
  layout: { rowH: 0.35, rows: 12, seg: [5, 7], jitter: 0.42, seed: 11, shift: true },
  joint: 0.0055,
  pass: { normal: 1.0, ao: 0.75, aoRadius: 0.012, cavity: 0.12 },
  glsl: limestone() + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float hA = cellRand(c, 1u);
  vec2 ms = m + vec2(c.h * 17.3, cellRand(c, 30u) * 11.9);
  // crumbly arris line: small irregularities, no long smooth swell
  float wob = fbm(m, 8.0, 2, 0.5, 11u) * 0.0008 + fbm(m, 45.0, 3, 0.55, 12u) * 0.0007;
  float e = c.e + wob;
  const float JW = 0.003;                        // half joint (6 mm)
  // worn chamfer 2-8 mm, coming and going along the arris (crisp stretches between)
  // which arris: along a bed joint (horizontal) or a head joint
  bool bed = min(c.ed.z, c.ed.w) < min(c.ed.x, c.ed.y);
  float ta = bed ? m.x : m.y;                    // position along the arris
  float bev = (0.002 + 0.006 * cellRand(c, 3u)) * (0.25 + 0.75 * smoothstep(-0.35, 0.35, noiseM(vec2(ta, c.h * 9.0), vec2(14.0), 39u)));
  // spalls: per 3 cm of arris, one in four broken off by a flat plane 2-6 mm deep and
  // 1-3 cm into the face, deepest at the arris; shell-shaped in plan (widest mid-way, the
  // inner edge ragged), up to 4 cm long, so neighbouring stretches are looked at too
  float seg0 = floor(ta / 0.03);
  float spall = 0.0;
  for (int j = -uOne; j <= uOne; j++) {
    float seg = seg0 + float(j);
    uint sh = sfH2(int(seg), bed ? 1 : 2, c.id + 211u);
    if (sfHf(sh) < 0.62 + 0.3 * cellRand(c, 38u)) continue;
    float sl = 0.012 + 0.022 * sfHf(sfH(sh + 1u));
    float sc = (seg + 0.5) * 0.03 + (sfHf(sfH(sh + 2u)) - 0.5) * 0.02;
    float sa = (ta - sc) / sl;
    if (abs(sa) >= 1.0) continue;
    float sw = (0.008 + 0.018 * sfHf(sfH(sh + 3u))) * sqrt(1.0 - sa * sa) * (1.0 + 0.35 * fbm(ms, 90.0, 2, 0.5, 37u));
    float sd = 0.002 + 0.004 * sfHf(sfH(sh + 4u));
    spall = max(spall, sd * sat(1.0 - (e - JW) / max(sw, 1e-4)));
  }
  // face: not perfectly flat, block proud / sunk and slightly tilted
  float face = fbm(m, 3.5, 3, 0.5, 30u) * 0.0012 + (hA - 0.5) * 0.0024;
  face += dot(c.lp - 0.5 * c.size, vec2(cellRand(c, 7u) - 0.5, cellRand(c, 8u) - 0.5)) * 0.008;
  float t = clamp((e - JW) / bev, 0.0, 1.0);
  float hFace = face - bev * 0.45 * pow(1.0 - t, 1.5) * (1.0 + 0.4 * fbm(m, 120.0, 2, 0.5, 31u));
  hFace -= spall * (1.0 + 0.25 * fbm(ms, 150.0, 2, 0.5, 32u));
  float broken = smoothstep(0.0003, 0.0012, spall);
  float hMortar = -0.0045 + fbm(m, 70.0, 2, 0.5, 13u) * 0.0006 + 0.0008 * smoothstep(0.0, JW, e);
  float stone = smoothstep(JW - 0.0008, JW + 0.0008, e);
  float hs = 0.0;
  vec3 alb = limestone(m, c.h, hs);
  s.height = mix(hMortar, max(hFace + hs, hMortar), stone);
  // soiling: dust and soot worked a few centimetres in from the joints (patchy, more on
  // some blocks), the worn arris dusty, spall floors dirty grey
  float ej = e - JW;
  float soil = (0.05 + 0.08 * cellRand(c, 33u)) * (0.4 + 1.2 * (0.5 + 0.5 * fbm(ms, 7.0, 3, 0.55, 34u)));
  alb *= 1.0 - soil * (1.0 - smoothstep(0.0, 0.035, ej));
  alb = mix(alb, vec3(lum(alb)) * vec3(0.8, 0.79, 0.78), 0.45 * (1.0 - t) * (1.0 - t));
  alb = mix(alb, vec3(lum(alb)) * vec3(0.86, 0.85, 0.84), 0.4 * broken);
  // grey weathering crust in patches on old blocks
  float crust = smoothstep(0.1, 0.55, fbm(ms, 2.5, 4, 0.6, 35u) + 0.25 * (cellRand(c, 36u) - 0.5)) * smoothstep(0.3, 0.85, cellRand(c, 36u));
  alb = mix(alb, vec3(lum(alb)) * vec3(0.72, 0.72, 0.73), 0.5 * crust);
  alb *= 1.03;                                   // keeps the mean albedo of the limestone (meta)
  vec3 mortar = vec3(0.5, 0.47, 0.41) * (1.0 + 0.1 * fbm(m, 45.0, 2, 0.5, 19u)) * (1.0 - 0.15 * (0.5 + 0.5 * fbm(m, 6.0, 2, 0.5, 18u)));
  s.albedo = mix(mortar, alb, stone);
  s.rough = mix(0.95, mix(0.86 + 0.03 * fbm(m, 9.0, 2, 0.5, 20u), 0.93, max(1.0 - t, broken)), stone);
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
  alb = mix(alb, vec3(lum(alb)) * vec3(0.8, 0.8, 0.81), 0.3 * hollow) * (1.0 - 0.1 * hollow);
  // crowns washed paler by the rain, the low shoulders and the margin dustier
  alb *= mix(0.86, 1.05, sat(hRock / 0.06));
  // grey soot crust in patches over part of the boss, heavier on some blocks; fine dark
  // specks of lichen and soot in the pitting
  vec2 ms = m + vec2(c.h * 13.1, cellRand(c, 15u) * 7.7);
  float crust = smoothstep(0.05, 0.5, fbm(ms, 3.2, 4, 0.6, 66u) + 0.35 * (cellRand(c, 16u) - 0.5)) * (0.4 + 0.6 * cellRand(c, 17u));
  alb = mix(alb, vec3(lum(alb)) * vec3(0.62, 0.62, 0.63), 0.45 * crust * rise);
  vec4 sv = voro(ms, vec2(70.0), 67u, 1.0);
  alb *= 1.0 - 0.35 * smoothstep(0.3, 0.1, sv.x) * step(0.9 - 0.15 * crust, sv.z) * rise;
  alb *= 1.07;                                   // keeps the mean albedo of the limestone (meta)
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
  // weathered trim: a grey crust in patches (sheltered undersides and returns keep it
  // longest), fine soot specks, faint rust-brown flushes
  float crust = smoothstep(0.1, 0.6, fbm(m, 1.6, 4, 0.6, 75u));
  c = mix(c, vec3(lum(c)) * vec3(0.76, 0.76, 0.77), 0.3 * crust);
  vec4 sv = voro(m, vec2(80.0), 76u, 1.0);
  c *= 1.0 - 0.3 * smoothstep(0.3, 0.1, sv.x) * step(0.93 - 0.1 * crust, sv.z);
  s.albedo = c * vec3(1.04, 1.04, 1.04);
  s.height = h;
  s.rough = 0.74 + 0.04 * fbm(m, 8.0, 2, 0.5, 74u);
}
`,
};
