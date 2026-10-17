// Fabric, wood, roofing, renders and other secondary surfaces.

// Acrylic canvas, plain weave ~1 mm yarns. Albedo near white: colour comes from the
// material / vertex colour. Tile 0.2 m.
export const canvas = {
  name: 'canvas', size: 512, tile: [0.2, 0.2], ss: 2,
  pass: { normal: 0.6, ao: 0.5, aoRadius: 0.0008, cavity: 0.25 },
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
export const wood = {
  name: 'wood', size: 512, tile: [0.5, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.002, cavity: 0.3 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec2 w = m + vec2(fbm2(m, vec2(3.0, 0.8), 4, 0.5, 221u) * 0.02, 0.0);
  float rings = w.x * 90.0 + fbm2(m, vec2(6.0, 1.0), 3, 0.5, 222u) * 3.0;
  float late = smoothstep(0.55, 0.95, fract(rings));        // dense latewood bands
  float pores = smoothstep(0.6, 1.0, fbm2(m, vec2(300.0, 12.0), 2, 0.5, 223u));
  float check = smoothstep(0.93, 1.0, ridged(m, vec2(30.0, 1.5), 3, 224u));   // weathering checks
  vec3 early = vec3(0.47, 0.32, 0.19), lateC = vec3(0.3, 0.18, 0.095);
  s.albedo = mix(early, lateC, late) * (1.0 - 0.15 * pores) * (1.0 + 0.06 * fbm(m, 4.0, 3, 0.5, 225u));
  s.albedo *= 1.0 - 0.5 * check;
  s.height = late * 0.00012 - pores * 0.00008 - check * 0.0008;
  s.rough = 0.6 + 0.12 * late + 0.2 * check;
}
`,
};

// Painted timber (louvred shutters): grain telegraphs through the paint, cracked and
// slightly peeling paint. Grain along u. Albedo near white (paint colour from material).
export const paintwood = {
  name: 'paintwood', size: 512, tile: [0.5, 0.5], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.003, cavity: 0.3 },
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

// Marseille-style interlocking terracotta tiles: 0.24 m wide, 0.33 m exposed courses,
// two rolls per tile, overlap step at each course, grime in the channels, sparse lichen.
export const rooftile = {
  name: 'rooftile', size: 512, tile: [1.92, 1.98], ss: 2,
  layout: { rowH: 0.33, rows: 6, seg: [8, 8], jitter: 0.0, seed: 17, shift: false },
  pass: { normal: 1.0, ao: 1.0, aoRadius: 0.03, cavity: 0.45 },
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
  name: 'membrane', size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.01, cavity: 0.3 },
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
  name: 'concrete', size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.7, aoRadius: 0.006, cavity: 0.4 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float cl = fbm(m, 2.0, 5, 0.6, 261u);
  vec4 bh = voro(m, vec2(45.0), 262u, 1.0);
  float hole = smoothstep(0.22, 0.12, bh.x) * step(0.86, bh.z);
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
  name: 'plaster', size: 512, tile: [2.0, 2.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.006, cavity: 0.35 },
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

// Asphalt: dark binder with exposed aggregate, worn and dusty.
export const asphalt = {
  name: 'asphalt', size: 512, tile: [1.5, 1.5], ss: 2,
  pass: { normal: 1.0, ao: 0.8, aoRadius: 0.006, cavity: 0.4 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec4 a = voro(m, vec2(90.0), 281u, 0.9);
  float stone = smoothstep(0.62, 0.35, a.x);
  float dust = smoothstep(-0.2, 0.6, fbm(m, 2.0, 4, 0.55, 282u));
  s.height = stone * 0.0015 * (0.6 + 0.4 * a.z) + fbm(m, 200.0, 2, 0.5, 283u) * 0.0002;
  vec3 binder = vec3(0.045, 0.045, 0.045);
  vec3 agg = vec3(0.16, 0.155, 0.15) * (0.7 + 0.6 * a.z);
  s.albedo = mix(binder, agg, stone * 0.85) * (1.0 + 0.35 * dust);
  s.rough = mix(0.92, 0.78, stone);
}
`,
};

// Young street-tree bark: smooth grey-brown with fine vertical fissures, lenticels, lichen.
// u around the trunk, v up. Tile 0.5 × 1 m.
export const bark = {
  name: 'bark', size: 512, tile: [0.5, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.8, aoRadius: 0.006, cavity: 0.45 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float fis = ridged(warp(m, 3.0, 0.02, 291u), vec2(40.0, 3.0), 4, 292u);
  vec4 len = voro(m * vec2(1.0, 1.0), vec2(30.0, 60.0), 293u, 1.0);
  float lent = smoothstep(0.25, 0.1, len.x) * step(0.6, len.z);
  float lich = smoothstep(0.6, 0.72, fbm(m, 5.0, 5, 0.6, 294u));
  s.height = (fis - 0.7) * 0.003 + lent * 0.0004;
  vec3 c = vec3(0.2, 0.17, 0.135) * (1.0 + 0.12 * fbm(m, 8.0, 3, 0.5, 295u));
  c *= mix(0.6, 1.0, smoothstep(0.5, 0.85, fis));
  c = mix(c, vec3(0.32, 0.29, 0.24), lent * 0.6);
  c = mix(c, vec3(0.3, 0.33, 0.24), lich * 0.7);
  s.albedo = c;
  s.rough = 0.88;
}
`,
};
