// Paving recipes: grey granite setts in running bond (street + sidewalk share the maps at
// different scales), the light stone edge band, platform slabs and tactile tiles.
// Rows run along u (= street direction), so the long axis of each paver follows the street.

const GRANITE = /* glsl */ `
// fine-grained grey granite: biotite (dark), feldspar/quartz (light), matrix grey
vec3 granite(vec2 m, vec3 base) {
  vec4 g = voro(m, vec2(300.0), 81u, 1.0);          // ~3 mm grains
  float k = g.z;
  vec3 c = base;
  c = mix(c, base * 0.5, step(k, 0.2));              // dark mica
  c = mix(c, base * 1.32, step(0.84, k));            // pale quartz / feldspar
  c *= 1.0 + 0.05 * fbm(m, 9.0, 3, 0.5, 82u);         // soft clouding
  return c;
}
`;

// Street / sidewalk setts: 0.40 × 0.20 m (lengths 0.29–0.52), 4 mm sanded joints,
// 3 mm chamfers, lippage between pavers, worn honed tops.
export const paving = {
  name: 'paving', flat: [0.24, 0.24, 0.235, 0.68], size: 1024, tile: [3.2, 3.2], ss: 2,
  layout: { rowH: 0.2, rows: 16, seg: [7, 9], jitter: 0.32, seed: 5, shift: true },
  joint: 0.0027,
  pass: { normal: 1.0, ao: 0.8, aoRadius: 0.01, cavity: 0.4 },
  glsl: GRANITE + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 20.0, 2, 0.5, 91u) * 0.0008;
  const float JW = 0.0017;
  const float CH = 0.003;
  // lippage: each paver sits a little proud or low and slightly tilted; corners rock
  vec2 q = c.lp - 0.5 * c.size;
  float lip = (cellRand(c, 1u) - 0.5) * 0.003
            + dot(q, vec2(cellRand(c, 2u) - 0.5, cellRand(c, 3u) - 0.5)) * 0.012;
  // flamed / honed face micro relief, polished by wear on the high spots
  float relief = fbm(m, 35.0, 3, 0.5, 92u) * 0.00035;
  float wear = smoothstep(-0.2, 0.6, fbm(m + vec2(c.h * 9.0), 3.0, 3, 0.5, 93u));
  float t = clamp((e - JW) / CH, 0.0, 1.0);
  float hFace = lip + relief * (1.0 - 0.6 * wear) - CH * (1.0 - t);
  // edge chips
  vec4 cv = voro(m, vec2(22.0), 94u, 1.0);
  float chip = smoothstep(0.45, 0.1, cv.x) * step(0.78, cv.z) * (1.0 - smoothstep(0.0, 0.018, e));
  hFace -= chip * 0.004;
  float stone = smoothstep(JW - 0.0006, JW + 0.0006, e);
  float hJoint = -0.006 + fbm(m, 120.0, 2, 0.5, 95u) * 0.0012;  // sand fill
  s.height = mix(hJoint, max(hFace, hJoint), stone);
  vec3 g = granite(m, vec3(0.25, 0.25, 0.245));
  // grime in the chamfers and towards the joints
  g *= mix(0.8, 1.0, smoothstep(0.0, 0.01, e - JW));
  g *= 1.0 - 0.15 * chip;
  vec3 joint = vec3(0.13, 0.128, 0.122) * (1.0 + 0.25 * fbm(m, 90.0, 2, 0.5, 96u));
  s.albedo = mix(joint, g, stone);
  s.rough = mix(0.95, mix(0.74, 0.56, wear), stone);
}
`,
};

// Light stone edge band of the track corridor: honed slabs 0.6–0.9 m, no lengthwise joints.
export const band = {
  name: 'band', flat: [0.45, 0.435, 0.4, 0.62], size: 512, tile: [2.4, 2.4], ss: 2,
  layout: { rowH: 2.4, rows: 1, seg: [3, 4], jitter: 0.3, seed: 8, shift: false, rowJoints: false },
  joint: 0.0026,
  pass: { normal: 1.0, ao: 0.7, aoRadius: 0.008, cavity: 0.35 },
  glsl: GRANITE + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 15.0, 2, 0.5, 101u) * 0.0006;
  const float JW = 0.0018;
  float t = clamp((e - JW) / 0.003, 0.0, 1.0);
  float lip = (cellRand(c, 1u) - 0.5) * 0.002 + (c.lp.x - 0.5 * c.size.x) * (cellRand(c, 2u) - 0.5) * 0.004;
  float hFace = lip + fbm(m, 30.0, 3, 0.5, 102u) * 0.0002 - 0.003 * (1.0 - t);
  float stone = smoothstep(JW - 0.0005, JW + 0.0005, e);
  s.height = mix(-0.005, max(hFace, -0.005), stone);
  // pale limestone / light granite mix: soft, with sparse fine speckle
  vec3 base = vec3(0.47, 0.455, 0.42) * (1.0 + 0.05 * fbm(m, 3.0, 4, 0.55, 103u) + 0.03 * fbm(m, 18.0, 2, 0.5, 104u));
  vec4 g = voro(m, vec2(220.0), 105u, 1.0);
  base *= 1.0 - 0.18 * step(0.86, g.z) * smoothstep(0.45, 0.2, g.x);
  base *= mix(0.78, 1.0, smoothstep(0.0, 0.01, e - JW));
  s.albedo = mix(vec3(0.12, 0.115, 0.105), base, stone);
  s.rough = mix(0.95, 0.6 + 0.06 * fbm(m, 4.0, 2, 0.5, 106u), stone);
}
`,
};

// Platform: 0.40 m square concrete-stone slabs, stack bond, exposed fine aggregate.
export const platform = {
  name: 'platform', flat: [0.35, 0.34, 0.32, 0.74], size: 512, tile: [2.4, 2.4], ss: 2,
  layout: { rowH: 0.4, rows: 6, seg: [6, 6], jitter: 0.0, seed: 9, shift: false },
  joint: 0.003,
  pass: { normal: 1.0, ao: 0.7, aoRadius: 0.01, cavity: 0.35 },
  glsl: GRANITE + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 18.0, 2, 0.5, 111u) * 0.0006;
  const float JW = 0.002;
  float t = clamp((e - JW) / 0.004, 0.0, 1.0);
  float lip = (cellRand(c, 1u) - 0.5) * 0.002;
  vec4 ag = voro(m, vec2(160.0), 112u, 0.9);
  float hFace = lip - 0.004 * (1.0 - t) + (0.5 - ag.x) * 0.0004;
  float stone = smoothstep(JW - 0.0005, JW + 0.0005, e);
  s.height = mix(-0.006, max(hFace, -0.006), stone);
  vec3 base = vec3(0.37, 0.36, 0.34) * (1.0 + 0.05 * fbm(m, 4.0, 3, 0.5, 113u));
  base *= mix(0.85, 1.12, ag.z);                       // aggregate stones
  base *= mix(0.8, 1.0, smoothstep(0.0, 0.01, e - JW));
  s.albedo = mix(vec3(0.11, 0.105, 0.1), base, stone);
  s.rough = mix(0.95, 0.72, stone);
}
`,
};

// Tactile warning tiles: 0.30 m tiles with truncated domes on a 50 mm grid.
export const tactile = {
  name: 'tactile', flat: [0.46, 0.44, 0.39, 0.75], size: 256, tile: [0.6, 0.6], ss: 2,
  layout: { rowH: 0.3, rows: 2, seg: [2, 2], jitter: 0.0, seed: 3, shift: false },
  pass: { normal: 1.0, ao: 0.8, aoRadius: 0.012, cavity: 0.3 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  const float JW = 0.002;
  vec2 g = mod(c.lp, 0.05) - 0.025;
  float r = length(g);
  float dome = 0.005 * (1.0 - smoothstep(0.009, 0.0125, r)) + 0.001 * (1.0 - smoothstep(0.0125, 0.0135, r));
  float stone = smoothstep(JW - 0.0005, JW + 0.0005, c.e);
  s.height = mix(-0.004, dome + fbm(m, 60.0, 2, 0.5, 121u) * 0.0002, stone);
  vec3 base = vec3(0.47, 0.45, 0.4) * (1.0 + 0.05 * fbm(m, 10.0, 3, 0.5, 122u));
  base *= mix(1.0, 1.06, smoothstep(0.009, 0.0, r));   // dome tops worn paler
  s.albedo = mix(vec3(0.12, 0.11, 0.1), base, stone);
  s.rough = mix(0.95, mix(0.8, 0.62, smoothstep(0.009, 0.0, r)), stone);
}
`,
};
