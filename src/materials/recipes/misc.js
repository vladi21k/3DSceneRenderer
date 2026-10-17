// Fabric, wood, roofing, renders and other secondary surfaces.

// Acrylic canvas, plain weave ~1 mm yarns. Albedo near white: colour comes from the
// material / vertex colour. Tile 0.2 m.
export const canvas = {
  name: 'canvas', flat: [0.92, 0.92, 0.92, 0.83], size: 512, tile: [0.2, 0.2], ss: 2,
  pass: { normal: 0.6, ao: 0.5, aoRadius: 0.0008, cavity: 0.08 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  const float P = 0.001;                                   // yarn pitch (200 per tile)
  vec2 g = m / P;
  vec2 cid = floor(g), f = fract(g);
  bool warpUp = mod(cid.x + cid.y, 2.0) < 1.0;
  float slubW = fbm2(m, vec2(4.0, 60.0), 2, 0.5, 211u);   // uneven yarn thickness
  float slubF = fbm2(m, vec2(60.0, 4.0), 2, 0.5, 212u);
  float pw = sqrt(sat(1.0 - pow(2.0 * f.x - 1.0, 2.0) * (1.0 - 0.2 * slubW)));
  float pf = sqrt(sat(1.0 - pow(2.0 * f.y - 1.0, 2.0) * (1.0 - 0.2 * slubF)));
  float bendW = sin(f.y * 3.14159), bendF = sin(f.x * 3.14159);
  float hw = pw * (warpUp ? 0.6 + 0.4 * bendW : 0.25);
  float hf = pf * (warpUp ? 0.25 : 0.6 + 0.4 * bendF);
  s.height = max(hw, hf) * 0.00025;
  float dirt = fbm(m, 12.0, 3, 0.5, 213u);
  s.albedo = vec3(0.93) * (1.0 + 0.03 * (warpUp ? slubW : slubF)) * (1.0 - 0.03 * dirt);
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
// paint, brush marks run along it, the paint cracks along the grain and flakes in
// elongated chips (pale primer, grey weathered wood in the deeper ones); faint lighter
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
  // flaking in patches stretched along the grain (sparse, clustered by wear)
  float fl = 0.5 + 0.5 * fbm2(warp(m, 30.0, 0.003, 416u), vec2(10.0, 40.0), 5, 0.6, 417u);
  float th = 0.84 - 0.22 * wearM;
  float chip = smoothstep(th, th + 0.012, fl);
  float lip = smoothstep(th - 0.035, th, fl) * (1.0 - chip);
  float deep = smoothstep(th + 0.008, th + 0.018, fl);
  // bead lines: paint ridges along u at irregular spacing
  float bv = m.y * 30.0 + fbm2(m, vec2(1.0, 2.0), 2, 0.5, 418u) * 0.6;
  float bead = (1.0 - smoothstep(0.02, 0.06, abs(fract(bv) - 0.5))) * step(0.55, sfHash(ivec2(int(floor(bv)), 0), 419u));
  vec3 paintC = vec3(0.9) * (1.0 + 0.04 * fbm(m, 10.0, 3, 0.5, 420u) + 0.02 * brush - 0.04 * dust) * (1.0 - 0.35 * crack) * (1.0 + 0.06 * bead) * (1.0 - 0.1 * lip);
  vec3 primer = vec3(0.44, 0.43, 0.4) * (1.0 + 0.04 * dust);
  vec3 wood = mix(vec3(0.42, 0.37, 0.31), vec3(0.3, 0.26, 0.21), late);  // grey weathered wood
  s.albedo = mix(paintC, mix(primer, wood, deep), chip);
  s.cover = 1.0 - chip;
  s.rough = mix(0.48 + 0.1 * late + 0.05 * brush + 0.06 * dust, mix(0.78, 0.9, deep), max(chip, crack));
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
// Grey-brown bark split by broad interlacing furrows: the borders of a staggered,
// jittered, warped lattice of tall cells (4.4 × 20 cm, so the ridges are long lenses that
// split and merge), measured in metres so every furrow is a V 18-30 mm wide and 2.5-9 mm
// deep that the bake turns into normal and AO relief; rounded, scaly ridges with
// lengthwise splits and short cross cracks; lenticels as subtle pale horizontal dashes
// (2-5 mm × ~1 mm) on the ridge tops; lichen patches.
export const bark = {
  name: 'bark', flat: [0.18, 0.155, 0.125, 0.9], size: [768, 1536], tile: [0.8, 1.6], ss: 2,
  pass: { normal: 1.0, ao: 0.85, aoRadius: 0.012, cavity: 0.12 },
  glsl: /* glsl */ `
// Distance (m) to the nearest cell border of a staggered, jittered lattice of tall cells
// (tile / per), and the cell hash. The cells are found in a space squeezed by the cell
// aspect k (where they are round), so they stay long lenses that taper to points; the
// border distance is converted back to metres for each border's orientation.
// Returns (distance, cell hash, |x| of the nearest border's normal: 1 = vertical border).
vec3 ridgeCells(vec2 m, ivec2 per, float jit, uint s) {
  vec2 cell = uTile / vec2(per);
  float k = cell.y / cell.x;
  vec2 x = m / cell;
  vec2 i = floor(x), f = x - i;
  ivec2 p = ivec2(i);
  vec2 mr = vec2(0.0); ivec2 mc = ivec2(0); float md = 1e9, id = 0.0;
  for (int y = -uOne; y <= uOne; y++) for (int xx = -uOne; xx <= uOne; xx++) {
    ivec2 g = ivec2(xx, y), cw = sfMod2(p + g, per);
    vec2 o = (hash22(cw, s) - 0.5) * jit + vec2(0.5 + 0.5 * float(cw.y & 1), 0.5);
    vec2 r = (vec2(g) + o - f) * cell.x;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mc = g; id = sfHash(cw, s + 7u); }
  }
  float e = 1e9, nx = 1.0;
  for (int y = -2 * uOne; y <= 2 * uOne; y++) for (int xx = -2 * uOne; xx <= 2 * uOne; xx++) {
    ivec2 g = mc + ivec2(xx, y), cw = sfMod2(p + g, per);
    vec2 o = (hash22(cw, s) - 0.5) * jit + vec2(0.5 + 0.5 * float(cw.y & 1), 0.5);
    vec2 r = (vec2(g) + o - f) * cell.x;
    vec2 dr = r - mr;
    if (dot(dr, dr) > 1e-10) {
      vec2 n = normalize(dr), nm = vec2(n.x, n.y / k);
      float d = dot(0.5 * (mr + r), n) / length(nm);
      if (d < e) { e = d; nx = abs(nm.x) / length(nm); }
    }
  }
  return vec3(e, id, nx);
}
void surface(vec2 m, inout Surf s) {
  // two warps: the ridges wander over decimetres and their borders wiggle over centimetres
  vec2 w = warp(warp(m, 1.5, 0.02, 291u), 9.0, 0.004, 302u);
  vec3 rc = ridgeCells(w, ivec2(18, 8), 0.95, 292u);           // 4.4 × 20 cm (rows even: stagger)
  float hwF = 0.009 + 0.006 * (0.5 + 0.5 * fbm(m, 5.0, 2, 0.5, 296u));   // furrow half width
  float depth = (0.0025 + 0.0065 * smoothstep(-0.4, 0.5, fbm(w, 3.0, 3, 0.5, 298u))) * mix(0.3, 1.0, rc.z);
  float t = clamp(rc.x / hwF, 0.0, 1.0);
  float rid = 1.0 - (1.0 - t) * (1.0 - t);                        // V furrow, rounded ridge
  float furrow = 1.0 - rid;
  // ridge tops: scaly relief, shallow lengthwise splits and short cross cracks
  float relief = fbm(m, 25.0, 4, 0.55, 297u);
  vec4 sp = voro(w + 0.31, vec2(40.0, 6.0), 299u, 0.9);
  float split = (1.0 - smoothstep(0.0, 0.06, sp.w)) * smoothstep(0.15, 0.6, fbm(m, 4.0, 2, 0.5, 300u)) * rid;
  vec4 cc = voro(w + 0.17, vec2(6.0, 45.0), 303u, 0.9);
  float check = (1.0 - smoothstep(0.0, 0.05, cc.w)) * smoothstep(0.3, 0.7, fbm(m, 5.0, 2, 0.5, 304u)) * rid;
  float top = smoothstep(0.7, 1.0, rid);
  // lenticels: a jittered 16 × 12.5 mm grid, one dash per cell (some empty), on the ridges
  vec2 lc = vec2(0.016, 0.0125);
  vec2 gi = floor(m / lc);
  ivec2 id = sfMod2(ivec2(gi), ivec2(50, 128));
  vec2 jit = hash22(id, 293u) - 0.5;
  vec2 dd = m - (gi + 0.5 + jit * vec2(0.55, 0.45)) * lc;
  float hl = mix(0.001, 0.0025, fract(jit.x * 7.31 + 0.5));
  float e = length(vec2(dd.x / hl, dd.y / 0.00055));
  float lent = (1.0 - smoothstep(0.55, 1.0, e)) * step(0.45, sfHash(id, 294u)) * top;
  float lich = smoothstep(0.6, 0.72, fbm(m, 3.0, 5, 0.6, 295u)) * rid;
  s.height = -depth * furrow - 0.0012 * split - 0.0008 * check + rid * relief * 0.0012 + lent * 0.00015;
  vec3 c = vec3(0.215, 0.188, 0.158) * (1.0 + 0.12 * fbm(m, 6.0, 3, 0.5, 301u)) * mix(0.93, 1.07, rc.y);
  c = mix(c, vec3(0.26, 0.245, 0.22) * (1.0 + 0.1 * relief), 0.45 * top);   // weathered grey ridge tops
  c = mix(c, vec3(0.13, 0.095, 0.07), 0.8 * furrow * furrow);      // furrow bottoms: red-brown
  c *= 1.0 - 0.25 * max(split, check);
  c = mix(c, vec3(0.36, 0.32, 0.25), lent * 0.5);
  c = mix(c, vec3(0.3, 0.33, 0.24), lich * 0.7);
  s.albedo = c;
  s.rough = mix(0.86, 0.95, furrow) + 0.03 * relief;
}
`,
};
