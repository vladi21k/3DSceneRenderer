// Metals, rail steel, paint, plastic and glass recipes.

// Rail head steel. Tile 2 m along the rail (u) × 0.25 m across (v, metres). A narrow
// polished running band (21-30 mm, drifting slowly along the rail) with fine longitudinal
// wheel scratches; a dull grey contact edge; dark brown oxidised shoulders; dusty dull
// steel further out (guard lip). Rare oxide pits, only outside the band.
// The band sits where the street geometry puts the head top (see meta.uv of rail.head):
//   swept rail     v = arc length along the profile from the field-side paving edge,
//                  head top centre (x = 0) at v = 0.043, flange-polished gauge corner ~0.075
//   flat inlays    v = rail-local x, head centre at v = 0 (wraps to 0.25)
// Surface map b = metal mask (oxide is only partly metallic).
export const railhead = {
  name: 'railhead', flat: [0.34, 0.3, 0.27, 0.42], size: [512, 256], tile: [2.0, 0.25], ss: 2, metalMask: true,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float wander = fbm2(m, vec2(0.6, 1.0), 3, 0.5, 134u) * 0.004;
  float hw = 0.0125 + 0.0022 * fbm2(m, vec2(1.3, 1.0), 2, 0.5, 135u);
  float d1 = m.y - 0.043 - wander;                                // swept rail
  float d0 = (m.y < 0.5 * uTile.y ? m.y : m.y - uTile.y) - wander;  // inlay strips
  float dB = min(abs(d1), abs(d0));
  float band = 1.0 - smoothstep(hw - 0.0025, hw + 0.0025, dB);
  band = max(band, 0.5 * (1.0 - smoothstep(0.002, 0.005, abs(m.y - 0.075))));   // gauge corner
  float e = dB - hw;                                              // distance outside the band
  float edge = smoothstep(0.0, 0.002, e) * (1.0 - smoothstep(0.003, 0.006, e));
  float ox = smoothstep(0.003, 0.006, e) * (1.0 - smoothstep(0.03, 0.05, e));
  // running band: polished, scratched along the rail, patches of duller wheel burn
  float streak = fbm2(m, vec2(0.5, 300.0), 3, 0.5, 131u);
  float fine = fbm2(m, vec2(2.0, 450.0), 2, 0.5, 132u);
  float burn = smoothstep(0.2, 0.7, fbm2(m, vec2(3.0, 20.0), 3, 0.5, 136u));
  vec3 bandC = vec3(0.62, 0.615, 0.6) * (1.0 + 0.05 * streak + 0.02 * fine) * (1.0 - 0.12 * burn);
  float bandR = 0.15 + 0.03 * streak + 0.02 * fine + 0.08 * burn;
  // oxide shoulders and dusty steel
  float g = fbm(m, 30.0, 3, 0.5, 137u);
  vec3 oxC = vec3(0.2, 0.15, 0.11) * (1.0 + 0.25 * g);
  vec3 dustC = vec3(0.3, 0.29, 0.275) * (1.0 + 0.12 * g);
  vec3 dull = mix(mix(dustC, oxC, ox), vec3(0.36, 0.35, 0.34), edge);
  float dullR = mix(mix(0.6, 0.55, ox), 0.42, edge) + 0.08 * g;
  float dullM = mix(mix(0.85, 0.6, ox), 0.9, edge);
  vec4 pit = voro(m, vec2(90.0, 90.0), 133u, 1.0);
  float p = smoothstep(0.25, 0.08, pit.x) * step(0.98, pit.z) * (1.0 - band);
  dull = mix(dull, vec3(0.09, 0.07, 0.055), p);
  s.albedo = mix(dull, bandC, band);
  s.rough = clamp(mix(dullR + 0.25 * p, bandR, band), 0.08, 1.0);
  s.metal = mix(dullM * (1.0 - 0.5 * p), 1.0, band);
  s.height = mix(g * 0.00012, fine * 0.00003 + streak * 0.00005, band) - p * 0.0002;
}
`,
};

// Rusty rail web / foot and old iron: layered rust with patches of bare dark steel.
export const railside = {
  name: 'railside', flat: [0.2, 0.1, 0.05, 0.85], size: 256, tile: [1.0, 1.0], ss: 2, metalMask: true,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.006, cavity: 0.06 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float r1 = fbm(warp(m, 3.0, 0.05, 141u), 6.0, 5, 0.6, 142u);
  float flake = voro(m, vec2(40.0), 143u, 1.0).x;
  float bare = smoothstep(0.45, 0.7, fbm(m, 4.0, 4, 0.55, 144u));
  vec3 rust = mix(vec3(0.15, 0.07, 0.035), vec3(0.26, 0.12, 0.055), sat(r1 * 0.7 + 0.5));
  rust = mix(rust, vec3(0.08, 0.05, 0.035), 0.5 * smoothstep(0.0, 0.7, fbm(m, 18.0, 4, 0.55, 145u)));
  s.albedo = mix(rust, vec3(0.32, 0.31, 0.3), bare);
  s.metal = bare;
  s.rough = mix(0.86 + 0.08 * r1, 0.5, bare);
  s.height = (1.0 - bare) * (r1 * 0.0006 + flake * 0.0003);
}
`,
};

// Flangeway groove: near-black compacted grime with faint rust-brown streaks along the
// rail, damp low spots, and a few clustered sand grains (about 3 % of the area).
export const railgroove = {
  name: 'railgroove', flat: [0.038, 0.032, 0.027, 0.7], size: 256, tile: [1.0, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.4, aoRadius: 0.005, cavity: 0.05 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float g = fbm(m, 8.0, 4, 0.55, 151u);
  vec4 v = voro(m, vec2(120.0), 152u, 1.0);
  float cluster = smoothstep(0.55, 0.75, 0.5 + 0.5 * fbm(m, 3.0, 3, 0.5, 153u));
  float sand = step(0.93, v.z) * smoothstep(0.5, 0.2, v.x) * cluster;
  float rust = smoothstep(0.1, 0.7, fbm2(m, vec2(0.5, 40.0), 3, 0.5, 154u));
  float damp = smoothstep(0.25, 0.65, fbm(m, 2.0, 3, 0.5, 155u));
  vec3 grime = vec3(0.037, 0.032, 0.027) * (1.0 + 0.3 * g);
  grime = mix(grime, vec3(0.055, 0.034, 0.022), 0.55 * rust) * mix(1.0, 0.8, damp);
  s.albedo = mix(grime, vec3(0.11, 0.1, 0.085), sand);
  s.rough = mix(mix(0.72 + 0.15 * g, 0.35, damp), 0.9, sand);
  s.height = g * 0.0008 + sand * 0.0004;
}
`,
};

// Paint over metal or wood (iron, poles, frames, signs): orange peel, brush/roller
// unevenness and fine dust. Albedo is near white: the material colour (or vertex colour)
// is the paint colour. Larger wear comes from the runtime macro layer (no repeating chips).
export const paint = {
  name: 'paint', flat: [0.95, 0.95, 0.95, 0.4], size: 512, tile: [1.0, 1.0], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float peel = fbm(m, 180.0, 3, 0.5, 161u);               // orange peel
  float brush = fbm2(m, vec2(4.0, 60.0), 3, 0.5, 162u);   // faint brush / roller marks
  float dust = fbm(m, 40.0, 3, 0.5, 164u);
  s.height = peel * 0.00003 + brush * 0.00002;
  s.albedo = vec3(0.95) * (1.0 + 0.015 * brush - 0.02 * dust);
  s.rough = 0.37 + 0.04 * brush + 0.05 * dust;
}
`,
};

// Weathered hot-dip galvanized steel (street furniture, rooftop metal): a dull grey zinc
// patina over most of the surface with the spangle crystals faintly showing through, and
// whitish zinc-carbonate blooms. Surface map b = metal mask (the patina is partly
// dielectric). Large patches come from the runtime macro layer.
export const galv = {
  name: 'galv', flat: [0.53, 0.54, 0.545, 0.6], size: 512, tile: [0.5, 0.5], ss: 2, metalMask: true,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec2 tc;
  vec4 v = voroV(warp(m, 6.0, 0.006, 171u), vec2(70.0), 172u, 1.0, tc);   // 7 mm spangles
  float k = v.z;
  vec2 tilt = vec2(fract(k * 13.1), fract(k * 7.7)) - 0.5;
  s.height = dot(-tc, tilt) * 0.02;                     // each crystal is a slightly tilted facet
  float dull = 0.45 + 0.35 * smoothstep(-0.3, 0.6, fbm(m, 24.0, 3, 0.55, 173u));
  float bloom = 0.7 * smoothstep(0.35, 0.75, fbm(m, 9.0, 4, 0.55, 174u));
  vec3 zinc = vec3(0.56, 0.57, 0.58) * (0.94 + 0.1 * k);
  s.albedo = mix(mix(zinc, vec3(0.5, 0.51, 0.51), dull), vec3(0.62), bloom);
  s.rough = mix(mix(0.45 + 0.12 * fract(k * 5.7), 0.62, dull), 0.8, bloom);
  s.rough *= 1.0 - 0.15 * smoothstep(0.05, 0.0, v.w);
  s.metal = mix(1.0, 0.85, dull) * mix(1.0, 0.3, bloom);
}
`,
};

// Brushed stainless steel: fine directional brushing along u, fingerprint smudges.
export const brushed = {
  name: 'brushed', flat: [0.55, 0.555, 0.56, 0.4], size: 256, tile: [0.4, 0.4], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float b = fbm2(m, vec2(3.0, 500.0), 3, 0.6, 181u);
  float smudge = fbm(m, 30.0, 3, 0.5, 182u);
  s.albedo = vec3(0.55, 0.555, 0.56) * (1.0 + 0.04 * b);
  s.rough = 0.38 + 0.05 * b + 0.08 * smudge;
  s.height = b * 0.00002;
}
`,
};

// Moulded plastic (cafe chairs, rubber parts): fine stipple, scuffs. Near-white albedo.
export const plastic = {
  name: 'plastic', flat: [0.93, 0.93, 0.93, 0.48], size: 256, tile: [0.25, 0.25], ss: 2,
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
  name: 'glass', flat: [1, 1, 1, 0.06], size: 256, tile: [1.2, 1.2], ss: 1,
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
