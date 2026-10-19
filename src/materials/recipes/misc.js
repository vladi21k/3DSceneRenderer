// Fabric, wood, roofing, renders and other secondary surfaces.

// Acrylic canvas: solution-dyed yarns ~1 mm in a plain weave (crimp relief, slubbed yarns
// of uneven thickness), heathered: neighbouring yarns and stretches of a yarn differ a
// little in tone, so the cloth has a fine tweedy grain that still reads at a few metres
// where the weave itself is sub-pixel. Soiled in use: soft grey dirt clouding at 3-10 cm,
// soot and pollen specks and a rare small darker spot (anything larger would repeat
// visibly with the tile: the runtime stain layer of the fabric materials adds water marks
// and dirt at decimetre scale). Albedo near white: colour comes from the material / vertex
// colour. Tile 0.4 m (0.4 mm/texel). Sun-fading, seams and run-off down hanging parts
// depend on the geometry and are left to the owner's shading.
export const canvas = {
  name: 'canvas', flat: [0.9, 0.9, 0.9, 0.84], size: 1024, tile: [0.4, 0.4], ss: 2,
  pass: { normal: 0.9, ao: 0.5, aoRadius: 0.0008, cavity: 0.08 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  const float P = 0.001;                                   // yarn pitch (400 per tile)
  vec2 g = m / P;
  vec2 cid = floor(g), f = fract(g);
  bool warpUp = mod(cid.x + cid.y, 2.0) < 1.0;
  float slubW = fbm2(m, vec2(4.0, 60.0), 2, 0.5, 211u);   // uneven yarn thickness
  float slubF = fbm2(m, vec2(60.0, 4.0), 2, 0.5, 212u);
  float pw = sqrt(sat(1.0 - pow(2.0 * f.x - 1.0, 2.0) * (1.0 - 0.25 * slubW)));
  float pf = sqrt(sat(1.0 - pow(2.0 * f.y - 1.0, 2.0) * (1.0 - 0.25 * slubF)));
  float bendW = sin(f.y * 3.14159), bendF = sin(f.x * 3.14159);
  float hw = pw * (warpUp ? 0.6 + 0.4 * bendW : 0.25);
  float hf = pf * (warpUp ? 0.25 : 0.6 + 0.4 * bendF);
  // heathered yarns: each warp yarn (column) and weft yarn (row) has its own tone, which
  // drifts along it over a few centimetres
  int yc = int(cid.x), yr = int(cid.y);
  float tw = sfHash(ivec2(sfMod(yc, 400), 1), 216u) - 0.5 + 0.6 * noiseM(m, vec2(2.5, 30.0), 217u);
  float tf = sfHash(ivec2(sfMod(yr, 400), 2), 218u) - 0.5 + 0.6 * noiseM(m, vec2(30.0, 2.5), 219u);
  float heather = warpUp ? tw : tf;
  // yarn-dyed streaks along the warp (thin lengthwise lines), the weft fainter
  float stW = fbm2(m, vec2(3.0, 260.0), 3, 0.5, 214u), stF = fbm2(m, vec2(220.0, 3.0), 2, 0.5, 215u);
  // soiling: grey clouding, water marks, specks
  float dirt = 0.5 + 0.5 * fbm(m, 12.0, 4, 0.55, 213u);
  vec4 sv = voro(m, vec2(150.0), 222u, 1.0);
  float speck = smoothstep(0.25, 0.08, sv.x) * step(0.94, sv.z);
  vec4 dv = voro(m, vec2(25.0), 223u, 1.0);
  float spot = smoothstep(0.3, 0.12, dv.x + 0.08 * fbm(m, 80.0, 2, 0.5, 224u)) * step(0.985, dv.z);
  s.height = max(hw, hf) * 0.0003;
  s.albedo = vec3(0.93) * (1.0 + 0.035 * (warpUp ? slubW : slubF)) * (1.0 + 0.07 * heather)
           * (1.0 + 0.05 * stW + 0.02 * stF) * (1.0 - 0.07 * dirt * dirt)
           * (1.0 - 0.3 * speck) * (1.0 - 0.12 * spot);
  s.rough = 0.82 + 0.05 * dirt;
}
`,
};

// Natural wood, grain along v (boards / door stiles). Warm mid-tone; materials tint it.
// CHECKS = 1 adds weathering splits: thin cracks that follow the grain, 5-20 cm long,
// tapering at both ends, on a few of the grain lines across the board.
const woodGlsl = (checks) => /* glsl */ `
const float CHECKS = ${checks ? '1.0' : '0.0'};
float checks(vec2 m, float wx) {
  const int NX = 43;                                    // candidate grain lines ~11.6 mm apart
  const int NV = 8;                                     // ~12.5 cm segments along the grain
  float cw = uTile.x / float(NX), L = uTile.y / float(NV);
  int ci = int(floor(wx / cw));
  float res = 0.0;
  for (int j = -uOne; j <= uOne; j++) {
    int c = sfMod(ci + j, NX);
    if (sfHash(ivec2(c, 0), 228u) < 0.85) continue;
    float xc = (float(ci + j) + 0.25 + 0.5 * sfHash(ivec2(c, 1), 228u)) * cw;
    float yv = m.y + sfHash(ivec2(c, 2), 228u) * uTile.y;
    int sg = int(floor(yv / L));
    ivec2 key = ivec2(c, sfMod(sg, NV) + 3);
    if (sfHash(key, 229u) < 0.45) continue;
    float t = (yv / L - float(sg)) / (0.4 + 0.6 * sfHash(key, 230u));
    if (t > 1.0) continue;
    float hw = (0.00015 + 0.00025 * sfHash(key, 231u)) * sin(3.14159 * t);
    res = max(res, 1.0 - smoothstep(hw, hw + 0.0004, abs(wx - xc)));
  }
  return res;
}
void surface(vec2 m, inout Surf s) {
  // growth rings: warped, with varying ring width and figure across the board
  vec2 w = m + vec2(fbm2(m, vec2(3.0, 0.8), 4, 0.5, 221u) * 0.025, 0.0);
  float rings = w.x * 70.0 + fbm2(m, vec2(4.0, 1.0), 3, 0.5, 222u) * 4.0 + fbm2(m, vec2(1.0, 2.0), 2, 0.5, 226u) * 6.0;
  float late = smoothstep(0.5, 0.95, fract(rings)) * (0.6 + 0.4 * fbm2(m, vec2(2.0, 3.0), 2, 0.5, 227u));
  float pores = smoothstep(0.6, 1.0, fbm2(m, vec2(300.0, 12.0), 2, 0.5, 223u));
  float check = CHECKS > 0.5 ? checks(m, w.x) : 0.0;
  vec3 early = vec3(0.47, 0.32, 0.19), lateC = vec3(0.29, 0.175, 0.095);
  s.albedo = mix(early, lateC, late) * (1.0 - 0.15 * pores) * (1.0 + 0.08 * fbm(m, 3.0, 3, 0.5, 225u));
  s.albedo *= 1.0 - 0.5 * check;
  s.height = late * 0.00012 - pores * 0.00008 - check * 0.0008;
  s.rough = 0.6 + 0.12 * late + 0.25 * check;
}
`;

export const wood = {
  name: 'wood', flat: [0.4, 0.26, 0.15, 0.66], size: 512, tile: [0.5, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.002, cavity: 0.06 },
  glsl: woodGlsl(false),
};

// Weathered timber (benches): the same wood with grain-aligned checks.
export const woodweathered = {
  name: 'woodweathered', flat: [0.4, 0.26, 0.15, 0.68], size: 512, tile: [0.5, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.002, cavity: 0.06 },
  glsl: woodGlsl(true),
};

// Painted timber (louvred shutters): grain telegraphs through the paint, cracked and
// slightly peeling paint. Grain along u. Albedo near white (paint colour from material).
export const paintwood = {
  name: 'paintwood', flat: [0.88, 0.88, 0.88, 0.55], size: 512, tile: [0.5, 0.5], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.003, cavity: 0.06 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float rings = m.y * 80.0 + fbm2(m, vec2(1.0, 6.0), 3, 0.5, 231u) * 3.0;
  float late = smoothstep(0.6, 0.95, fract(rings));
  vec4 cr = voro(m, vec2(70.0, 70.0), 232u, 1.0);
  float crack = smoothstep(0.03, 0.0, cr.w) * smoothstep(0.1, 0.5, fbm(m, 5.0, 3, 0.5, 233u));
  float peel = smoothstep(0.62, 0.7, fbm(m, 7.0, 5, 0.6, 234u));
  s.height = late * 0.00008 - crack * 0.0002 - peel * 0.0003;
  vec3 paintC = vec3(0.92) * (1.0 + 0.04 * fbm(m, 10.0, 3, 0.5, 235u));
  s.albedo = mix(paintC * (1.0 - 0.35 * crack), vec3(0.42, 0.37, 0.31), peel);  // grey weathered wood
  s.rough = mix(0.5 + 0.1 * late, 0.9, max(peel, crack));
}
`,
};

// Painted louvred shutters up close, tile 1 m at 1 mm/texel. Grain along u telegraphs through the
// paint, brush marks run along it, the paint cracks along the grain, weathers to chalky
// dull patches and flakes in a few small elongated chips (pale primer, grey weathered wood
// in the deeper ones); faint lighter
// bead lines (paint build-up ridges) along u. Albedo near white where painted (vertex
// colour = paint); surface.b = paint coverage.
export const paintwooddetail = {
  name: 'paintwooddetail', flat: [0.87, 0.87, 0.87, 0.5], size: 1024, tile: [1.0, 1.0], ss: 2, mask: 'paint',
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.002, cavity: 0.05 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float rings = m.y * 80.0 + fbm2(m, vec2(1.0, 6.0), 3, 0.5, 411u) * 3.0;
  float late = smoothstep(0.6, 0.95, fract(rings));
  float brush = fbm2(m, vec2(4.0, 150.0), 3, 0.55, 412u);
  float dust = fbm(m, 25.0, 3, 0.5, 413u);
  float wearM = smoothstep(0.15, 0.75, 0.5 + 0.5 * fbm(m, 3.5, 3, 0.5, 414u));
  // cracks along the grain, on the late wood, where the paint is old
  float crack = late * smoothstep(0.55, 0.8, fbm2(m, vec2(6.0, 40.0), 3, 0.5, 415u)) * wearM;
  crack *= smoothstep(0.7, 0.95, fract(rings + 0.05));
  // wear reads mostly as dull chalky patches (matt, a touch paler); a few small flakes
  // stretched along the grain, sparse even where worn (under dark paints the runtime tones
  // them down: surface.js PAINT)
  float chalk = smoothstep(0.2, 0.75, wearM * (0.5 + 0.5 * fbm2(m, vec2(4.0, 12.0), 3, 0.5, 421u)) * 1.6);
  float fl = 0.5 + 0.5 * fbm2(warp(m, 90.0, 0.0015, 416u), vec2(27.0, 105.0), 4, 0.6, 417u);
  float th = 0.88 - 0.1 * wearM;
  float chip = smoothstep(th, th + 0.01, fl);
  float lip = smoothstep(th - 0.025, th, fl) * (1.0 - chip);
  float deep = smoothstep(th + 0.008, th + 0.016, fl);
  // bead lines: paint ridges along u at irregular spacing
  float bv = m.y * 30.0 + fbm2(m, vec2(1.0, 2.0), 2, 0.5, 418u) * 0.6;
  float bead = (1.0 - smoothstep(0.02, 0.06, abs(fract(bv) - 0.5))) * step(0.55, sfHash(ivec2(sfMod(int(floor(bv)), 30), 0), 419u));
  vec3 paintC = vec3(0.9) * (1.0 + 0.04 * fbm(m, 10.0, 3, 0.5, 420u) + 0.02 * brush - 0.04 * dust + 0.05 * chalk) * (1.0 - 0.3 * crack) * (1.0 + 0.04 * bead) * (1.0 - 0.06 * lip);
  vec3 primer = vec3(0.44, 0.43, 0.4) * (1.0 + 0.04 * dust);
  vec3 wood = mix(vec3(0.42, 0.37, 0.31), vec3(0.3, 0.26, 0.21), late);  // grey weathered wood
  s.albedo = mix(paintC, mix(primer, wood, deep), chip);
  s.cover = 1.0 - chip;
  s.rough = mix(0.48 + 0.1 * late + 0.05 * brush + 0.06 * dust + 0.22 * chalk, mix(0.78, 0.9, deep), max(chip, crack));
  s.height = late * 0.00008 + brush * 0.00002 + bead * 0.00012 + lip * 0.00003 - crack * 0.0002 - chip * 0.00018 - deep * 0.0002;
}
`,
};

// Marseille-style interlocking terracotta tiles: 0.24 m wide, 0.33 m exposed courses,
// two rolls per tile, overlap step at each course, grime in the channels, sparse lichen.
export const rooftile = {
  name: 'rooftile', flat: [0.36, 0.12, 0.055, 0.78], size: 512, tile: [1.92, 1.98], ss: 2,
  layout: { rowH: 0.33, rows: 6, seg: [8, 8], jitter: 0.0, seed: 17, shift: false },
  pass: { normal: 1.0, ao: 0.7, aoRadius: 0.015, cavity: 0.08 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float x = c.lp.x / c.size.x, y = c.lp.y / c.size.y;     // 0..1 across / up the course
  float roll = 0.5 + 0.5 * cos((x - 0.25) * 6.2831853 * 2.0);
  float rib = smoothstep(0.03, 0.0, abs(x - 0.02)) * 0.4;  // interlock lip
  float lift = 0.022 * (1.0 - y);                           // lower edge rests on the course below
  float sag = (cellRand(c, 1u) - 0.5) * 0.004;
  float h = lift + roll * 0.012 + rib * 0.006 + sag + fbm(m, 30.0, 3, 0.5, 241u) * 0.0004;
  float edgeGap = smoothstep(0.012, 0.0, min(c.ed.x, c.ed.y));
  h -= edgeGap * 0.006;
  s.height = h;
  vec3 terra = vec3(0.42, 0.135, 0.06) * (1.0 + 0.08 * fbm(m, 6.0, 4, 0.55, 242u));
  // channels collect grime, lower lip darker
  terra *= mix(0.62, 1.0, roll);
  terra *= mix(1.0, 0.75, smoothstep(0.3, 0.0, y));
  float lichen = smoothstep(0.62, 0.75, fbm(m, 4.0, 5, 0.6, 243u)) * smoothstep(0.4, 0.9, roll);
  s.albedo = mix(terra, vec3(0.3, 0.3, 0.24), lichen * 0.8);
  s.rough = mix(0.7, 0.88, 1.0 - roll) + 0.08 * lichen;
}
`,
};

// Roof membrane: granulated bitumen cap sheet, 1 m laps along v.
export const membrane = {
  name: 'membrane', flat: [0.28, 0.275, 0.26, 0.9], size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.008, cavity: 0.06 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec4 g = voro(m, vec2(220.0), 251u, 1.0);
  float lap = fract(m.y / 1.0);
  float seam = smoothstep(0.012, 0.0, lap) + smoothstep(0.985, 1.0, lap) * 0.5;
  float sag = fbm(m, 1.5, 3, 0.5, 252u);
  s.height = (0.5 - g.x) * 0.0006 + seam * 0.003 + sag * 0.002;
  vec3 c = vec3(0.3, 0.295, 0.28) * mix(0.75, 1.2, g.z) * (1.0 + 0.1 * fbm(m, 3.0, 4, 0.55, 253u));
  c *= 1.0 - 0.15 * smoothstep(0.4, 0.8, sag);   // dirt in the low spots
  s.albedo = mix(c, vec3(0.08, 0.075, 0.07), seam * 0.6);
  s.rough = 0.9;
}
`,
};

// Cast concrete: cement clouding, fine aggregate, bug holes.
export const concrete = {
  name: 'concrete', flat: [0.39, 0.38, 0.36, 0.87], size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.006, cavity: 0.06 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float cl = fbm(m, 2.0, 5, 0.6, 261u);
  vec4 bh = voro(m, vec2(45.0), 262u, 1.0);
  float hole = smoothstep(0.2, 0.1, bh.x) * step(0.95, bh.z) * smoothstep(0.1, 0.5, fbm(m, 1.5, 3, 0.5, 265u));
  vec4 ag = voro(m, vec2(180.0), 263u, 1.0);
  s.height = fbm(m, 20.0, 3, 0.5, 264u) * 0.0003 - hole * 0.003 + (0.5 - ag.x) * 0.0002;
  vec3 c = vec3(0.4, 0.39, 0.37) * (1.0 + 0.09 * cl) * mix(0.94, 1.06, ag.z);
  s.albedo = c * (1.0 - 0.4 * hole);
  s.rough = 0.86 + 0.05 * cl;
}
`,
};

// Lime render: trowel undulation, sand texture, hairline cracks, soft soiling.
export const plaster = {
  name: 'plaster', flat: [0.65, 0.61, 0.53, 0.9], size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.006, cavity: 0.05 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float trowel = fbm(warp(m, 1.5, 0.15, 271u), 2.5, 4, 0.5, 272u);
  vec4 cr = voro(warp(m, 4.0, 0.04, 273u), vec2(3.0), 274u, 1.0);
  float crack = smoothstep(0.012, 0.0, cr.w) * smoothstep(0.55, 0.75, fbm(m, 2.0, 3, 0.5, 275u));
  float sand = fbm(m, 150.0, 2, 0.5, 276u);
  s.height = trowel * 0.0015 + sand * 0.00015 - crack * 0.0006;
  vec3 c = vec3(0.66, 0.62, 0.54) * (1.0 + 0.05 * fbm(m, 3.0, 4, 0.55, 277u) + 0.02 * sand);
  s.albedo = c * (1.0 - 0.35 * crack);
  s.rough = 0.9;
}
`,
};

// Asphalt / bituminous mortar: angular crushed-stone chips (5-14 mm and finer grit) in a
// dark binder, worn so the chip tops are exposed; dust settles in the voids. Low contrast:
// from a few metres it reads as an even dark grey with a fine grain.
export const asphalt = {
  name: 'asphalt', flat: [0.085, 0.084, 0.082, 0.86], size: 512, tile: [1.5, 1.5], ss: 2,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.004, cavity: 0.05 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec2 w = warp(m, 30.0, 0.003, 284u);
  vec4 a = voro(w, vec2(75.0), 281u, 1.0);                    // coarse chips (~13 mm cells)
  vec4 b = voro(w + 0.37, vec2(170.0), 285u, 1.0);            // fine grit (~6 mm cells)
  // polygonal chips: Voronoi cells shrunk from their edges (F2 - F1), not round blobs
  float chipA = smoothstep(0.06, 0.16, a.w) * step(0.45, a.z);
  float chipB = smoothstep(0.05, 0.14, b.w) * step(0.4, b.z) * (1.0 - chipA);
  float chip = chipA + chipB;
  float tone = chipA > 0.0 ? fract(a.z * 7.31) : fract(b.z * 5.17);
  float dust = smoothstep(-0.3, 0.6, fbm(m, 2.0, 4, 0.55, 282u));
  float grit = fbm(m, 260.0, 2, 0.5, 283u);
  vec3 binder = vec3(0.05, 0.05, 0.05) * (1.0 + 0.15 * grit) * (1.0 + 0.4 * dust);
  vec3 agg = mix(vec3(0.1, 0.1, 0.098), vec3(0.15, 0.143, 0.133), tone) * (1.0 + 0.15 * dust);
  s.albedo = mix(binder, agg, chip * 0.85);
  s.height = chipA * 0.0011 + chipB * 0.0006 + grit * 0.00015;
  s.rough = mix(0.92, 0.8, chip);
}
`,
};

// Street-tree bark, u around the trunk and v up (tile 0.8 × 1.6 m, 1 mm/texel).
// Grey-brown bark split by long, shallow, interlacing vertical fissures. Two sets of
// fissures (10 and 7 around the tile) wander independently over decimetres, so they
// converge, cross at shallow angles and part again, leaving long lens-shaped plates
// (roughly 4-10 cm across and 0.3-1 m long); each fissure fades in and out along its length
// (plates merge where it pinches out), and its width (6-18 mm) and depth (1.5-5 mm) vary.
// A finer, shallower third set cracks the plates. The bake turns the relief into normal
// and AO; the fissure floors are only a little darker and warmer than the ridges (no black
// outlines). Ridge tops are weathered grey with sparse pale lenticel dashes (2-6 mm × 1 mm,
// horizontal); grey-green crustose lichen in patches.
const BARK_COMMON = /* glsl */ `
// fissure profile of a set of n wandering lines around the tile: x phase warped by
// low-frequency noise; returns depth weight 0..1 (1 on the fissure line)
float fissures(vec2 m, float n, float warpA, uint sd, float hw, float actLo, out float plate) {
  float sp = uTile.x / n;
  float ph = m.x / sp + warpA * fbm2(m, vec2(1.25, 0.625), 3, 0.5, sd) + 0.2 * fbm2(m, vec2(5.0, 2.5), 2, 0.5, sd + 11u);
  float fr = fract(ph);
  float d = min(fr, 1.0 - fr) * sp;                        // metres to the nearest line
  int id = sfMod(int(floor(ph + 0.5)), int(n));
  plate = fract(float(sfMod(int(floor(ph)), int(n))) * 0.618);
  // each line fades in and out along its length
  float act = smoothstep(actLo, actLo + 0.35, fbm2(vec2(float(id) * sp, m.y), vec2(1.25, 1.875), 2, 0.5, sd + 23u));
  float t = clamp(d / max(hw * mix(0.4, 1.0, act), 1e-4), 0.0, 1.0);
  return (1.0 - t) * (1.0 - t) * act;
}
// lenticels: a jittered 16 × 12.5 mm grid, one horizontal dash per cell (some empty)
float lenticels(vec2 m, float lenMin, float lenMax, float keep) {
  vec2 lc = vec2(0.016, 0.0125);
  vec2 gi = floor(m / lc);
  ivec2 id = sfMod2(ivec2(gi), ivec2(50, 128));
  vec2 jit = hash22(id, 293u) - 0.5;
  vec2 dd = m - (gi + 0.5 + jit * vec2(0.55, 0.45)) * lc;
  float hl = mix(lenMin, lenMax, fract(jit.x * 7.31 + 0.5));
  float e = length(vec2(dd.x / hl, dd.y / 0.0005));
  return (1.0 - smoothstep(0.55, 1.0, e)) * step(1.0 - keep, sfHash(id, 294u));
}
float lichen(vec2 m) {
  float big = smoothstep(0.15, 0.55, fbm(m, 1.2, 3, 0.5, 305u));          // patchy, per side
  return smoothstep(0.58, 0.7, fbm(m, 4.0, 5, 0.6, 295u)) * big;
}
`;

export const bark = {
  name: 'bark', flat: [0.2, 0.18, 0.155, 0.9], size: [768, 1536], tile: [0.8, 1.6], ss: 2,
  pass: { normal: 1.0, ao: 0.7, aoRadius: 0.01, cavity: 0.08 },
  glsl: BARK_COMMON + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float wv = 0.5 + 0.5 * fbm2(m, vec2(2.5, 1.25), 2, 0.5, 296u);   // width / depth along the trunk
  float hw = 0.003 + 0.006 * wv;
  float dep = 0.0015 + 0.0035 * smoothstep(0.1, 0.9, wv);
  float pa, pb, pc;
  float fa = fissures(m, 10.0, 1.3, 291u, hw, -0.25, pa);
  float fb = fissures(m + vec2(0.0, 0.53), 7.0, 1.8, 311u, hw * 1.15, -0.1, pb);
  float fc = fissures(m + vec2(0.0, 0.27), 23.0, 0.9, 321u, 0.0022, 0.15, pc);
  float f1 = max(fa, fb);
  float f2 = fc * (1.0 - f1);
  float rid = 1.0 - f1;
  // plate tops: soft scaly relief and short cross checks
  float relief = fbm2(m, vec2(20.0, 8.0), 4, 0.55, 297u);
  vec4 cc = voro(m + 0.17, vec2(10.0, 40.0), 303u, 0.9);
  float check = (1.0 - smoothstep(0.0, 0.05, cc.w)) * smoothstep(0.35, 0.75, fbm(m, 5.0, 2, 0.5, 304u)) * rid * (1.0 - f2);
  float top = smoothstep(0.3, 0.0, f1 + f2);
  float lent = lenticels(m, 0.001, 0.003, 0.4) * top;
  float lich = lichen(m) * rid;
  float scale = fbm(m, 45.0, 3, 0.55, 306u);                                   // fine scaly grain
  s.height = -dep * f1 - 0.0008 * f2 - 0.0005 * check + rid * (relief * 0.0018 + scale * 0.0006) + lent * 0.00012 + lich * 0.0002;
  float mot = fbm(m, 4.0, 3, 0.5, 301u);
  vec3 c = vec3(0.205, 0.185, 0.158) * (1.0 + 0.28 * mot + 0.1 * scale);
  c *= 1.0 - 0.18 * smoothstep(0.2, 0.7, fbm(m, 1.5, 3, 0.5, 307u));        // darker sooty / damp patches
  c *= 1.0 + 0.08 * (pa - 0.5);                                                // plates differ a little
  c = mix(c, vec3(0.25, 0.24, 0.22) * (1.0 + 0.1 * relief), 0.4 * top);       // weathered grey ridge tops
  c *= mix(1.0, 0.72, f1) * mix(1.0, 0.85, f2) * (1.0 - 0.12 * check);          // fissure floors: darker,
  c = mix(c, c * vec3(1.08, 0.97, 0.88), f1);                                  // a little warmer
  c = mix(c, vec3(0.34, 0.31, 0.26), lent * 0.6);
  c = mix(c, vec3(0.36, 0.38, 0.32) * (1.0 + 0.15 * relief), lich * 0.75);     // grey-green crust
  s.albedo = c;
  s.rough = mix(0.85, 0.95, f1) + 0.03 * relief;
}
`,
};

// Smooth young street-tree bark (trunks under ~25 cm, branches), same tile and mapping:
// smooth grey skin with faint vertical striation and a few long shallow splits, horizontal
// lenticel dashes (3-8 mm), soft mottling, lichen patches.
export const barksmooth = {
  name: 'barksmooth', flat: [0.23, 0.215, 0.19, 0.82], size: [512, 1024], tile: [0.8, 1.6], ss: 2,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.006, cavity: 0.05 },
  glsl: BARK_COMMON + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float pa;
  float split = fissures(m, 6.0, 1.5, 312u, 0.0035, 0.3, pa);                // splits only here and there
  float stri = fbm2(m, vec2(30.0, 2.5), 3, 0.5, 314u);                        // faint vertical striation
  float wr = fbm2(m, vec2(5.0, 60.0), 2, 0.5, 315u);                          // fine horizontal wrinkles
  float lent = lenticels(m, 0.0015, 0.004, 0.6);
  float lich = lichen(m);
  s.height = -0.0012 * split + stri * 0.00015 + wr * 0.00006 + lent * 0.00018 + lich * 0.00015;
  vec3 c = vec3(0.235, 0.22, 0.195) * (1.0 + 0.16 * fbm(m, 3.0, 3, 0.5, 316u) + 0.05 * stri);
  c *= 1.0 - 0.15 * smoothstep(0.2, 0.7, fbm(m, 1.5, 3, 0.5, 317u));        // darker damp patches
  c *= mix(1.0, 0.8, split);
  c = mix(c, vec3(0.36, 0.33, 0.27), lent * 0.85);
  c = mix(c, vec3(0.37, 0.39, 0.33), lich * 0.7);
  s.albedo = c;
  s.rough = 0.8 + 0.06 * stri + 0.08 * split;
}
`,
};
