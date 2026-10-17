// Metals, rail steel, paint, plastic and glass recipes.

// Polished running band of the rail head: bright steel with longitudinal wheel streaks
// and scattered dark oxide pits. Tile 2 m along the rail (u), 0.25 m across (v).
export const railhead = {
  name: 'railhead', size: [512, 64], tile: [2.0, 0.25], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float streak = fbm2(m, vec2(1.5, 160.0), 4, 0.6, 131u);
  float fine = fbm2(m, vec2(6.0, 700.0), 2, 0.5, 132u);
  vec4 pit = voro(m, vec2(90.0, 90.0), 133u, 1.0);
  float ox = smoothstep(0.25, 0.08, pit.x) * step(0.85, pit.z);
  s.albedo = vec3(0.6, 0.6, 0.6) * (1.0 + 0.05 * streak + 0.02 * fine);
  s.albedo = mix(s.albedo, vec3(0.16, 0.12, 0.1), ox);
  s.rough = clamp(0.2 + 0.08 * streak + 0.04 * fine + 0.4 * ox, 0.08, 1.0);
  s.height = fine * 0.00004 + streak * 0.00006 - ox * 0.0002;
}
`,
};

// Rusty rail web / foot and old iron: layered rust with patches of bare dark steel.
export const railside = {
  name: 'railside', size: 256, tile: [1.0, 1.0], ss: 2, metalMask: true,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.006, cavity: 0.3 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float r1 = fbm(warp(m, 3.0, 0.05, 141u), 6.0, 5, 0.6, 142u);
  float flake = voro(m, vec2(40.0), 143u, 1.0).x;
  float bare = smoothstep(0.35, 0.6, fbm(m, 3.0, 4, 0.55, 144u));
  vec3 rust = mix(vec3(0.17, 0.075, 0.035), vec3(0.28, 0.13, 0.055), sat(r1 * 0.8 + 0.5));
  rust = mix(rust, vec3(0.07, 0.045, 0.03), smoothstep(0.1, 0.5, fbm(m, 12.0, 3, 0.5, 145u)));
  s.albedo = mix(rust, vec3(0.32, 0.31, 0.3), bare);
  s.metal = bare;
  s.rough = mix(0.86 + 0.08 * r1, 0.5, bare);
  s.height = (1.0 - bare) * (r1 * 0.0006 + flake * 0.0003);
}
`,
};

// Flangeway groove: compacted grime, wet-looking dirt, sand grains and debris.
export const railgroove = {
  name: 'railgroove', size: 256, tile: [1.0, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.6, aoRadius: 0.006, cavity: 0.4 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float g = fbm(m, 8.0, 4, 0.55, 151u);
  vec4 v = voro(m, vec2(120.0), 152u, 1.0);
  float sand = step(0.7, v.z) * smoothstep(0.5, 0.2, v.x);
  vec3 grime = vec3(0.045, 0.04, 0.034) * (1.0 + 0.3 * g);
  s.albedo = mix(grime, vec3(0.24, 0.21, 0.17), sand * 0.8);
  s.rough = mix(0.6 + 0.2 * g, 0.9, sand);
  s.height = g * 0.0008 + sand * 0.0006;
}
`,
};

// Paint over metal or wood (iron, poles, frames, signs): orange peel, dust, sparse chips.
// Albedo is near white: the material colour (or vertex colour) is the paint colour.
export const paint = {
  name: 'paint', size: 512, tile: [1.0, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.4, aoRadius: 0.004, cavity: 0.2 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float peel = fbm(m, 180.0, 3, 0.5, 161u);               // orange peel
  float mott = fbm(m, 6.0, 4, 0.55, 162u);
  vec4 cv = voro(m, vec2(14.0), 163u, 1.0);
  float chip = smoothstep(0.3, 0.12, cv.x) * step(0.88, cv.z) * smoothstep(0.0, 0.4, fbm(m, 30.0, 3, 0.5, 164u) + 0.2);
  s.height = peel * 0.00003 - chip * 0.0002;
  vec3 c = vec3(0.95) * (1.0 + 0.03 * mott);
  s.albedo = mix(c, vec3(0.42, 0.24, 0.16), chip);          // primer / rust under the paint
  s.rough = mix(0.36 + 0.07 * mott, 0.85, chip);
}
`,
};

// Hot-dip galvanized steel: spangle crystals with individual sheen and tilt, dull patches.
export const galv = {
  name: 'galv', size: 512, tile: [0.5, 0.5], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec2 tc;
  vec4 v = voroV(warp(m, 6.0, 0.006, 171u), vec2(70.0), 172u, 1.0, tc);   // 7 mm spangles
  float k = v.z;
  vec2 tilt = vec2(fract(k * 13.1), fract(k * 7.7)) - 0.5;
  s.height = dot(-tc, tilt) * 0.03;                     // each crystal is a slightly tilted facet
  float dull = smoothstep(0.2, 0.65, fbm(m, 5.0, 4, 0.55, 173u));
  s.albedo = vec3(0.56, 0.57, 0.58) * (0.93 + 0.12 * k) * mix(1.0, 0.82, dull);
  s.rough = mix(0.22 + 0.25 * fract(k * 5.7), 0.62, dull);
  s.rough *= 1.0 - 0.3 * smoothstep(0.05, 0.0, v.w);
}
`,
};

// Brushed stainless steel: fine directional brushing along u.
export const brushed = {
  name: 'brushed', size: 256, tile: [0.4, 0.4], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float b = fbm2(m, vec2(3.0, 500.0), 3, 0.6, 181u);
  float smudge = fbm(m, 8.0, 3, 0.5, 182u);
  s.albedo = vec3(0.55, 0.555, 0.56) * (1.0 + 0.04 * b);
  s.rough = 0.3 + 0.06 * b + 0.06 * smudge;
  s.height = b * 0.00002;
}
`,
};

// Moulded plastic (cafe chairs, rubber parts): fine stipple, scuffs. Near-white albedo.
export const plastic = {
  name: 'plastic', size: 256, tile: [0.25, 0.25], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float st = fbm(m, 400.0, 2, 0.5, 191u);
  float scuff = smoothstep(0.35, 0.7, fbm2(m, vec2(12.0, 40.0), 3, 0.5, 192u));
  s.height = st * 0.00002;
  s.albedo = vec3(0.95) * (1.0 - 0.06 * scuff);
  s.rough = 0.45 + 0.06 * st + 0.15 * scuff;
}
`,
};

// Window glass: dust and smudges (rougher), slight waviness of old drawn glass.
// Albedo near white: the material colour sets the dark interior tone.
export const glass = {
  name: 'glass', size: 256, tile: [1.2, 1.2], ss: 1,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float wave = fbm2(m, vec2(1.5, 7.0), 3, 0.5, 201u);
  float dust = smoothstep(0.2, 0.8, fbm(m, 3.0, 5, 0.6, 202u));
  float lower = smoothstep(0.6, 0.0, fract(m.y / 1.2));       // grime collects low on panes
  s.height = wave * 0.00035;
  s.albedo = vec3(1.0) * (1.0 - 0.08 * dust * lower);
  s.rough = 0.035 + 0.12 * dust * (0.4 + 0.6 * lower);
}
`,
};
