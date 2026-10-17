// Metals, rail steel, paint, plastic and glass recipes.

// Rail head steel. Tile 2 m along the rail (u) × 0.25 m across (v, metres). A narrow
// running band (21-30 mm, drifting slowly along the rail) of bright but rough steel:
// wheel contact leaves fine lengthwise streaks (roughness alternating 0.24-0.42 across
// the band, so the reflection smears along the rail like a brushed, anisotropic finish)
// and duller burn patches; never a mirror. The gauge corner is flange-polished
// (roughness ~0.3). Everything off the wheel path is dull: a dark brown oxide on the
// field-side bevel and the shoulders, and a dull dusty oxide on the guard lip (albedo
// ~0.12-0.16, roughness 0.6-0.75, only partly metallic), so every rail reads as one bright
// line, not two.
// The band sits where the street geometry puts the head top (see meta.uv of rail.head):
//   swept rail     v = arc length along the profile from the field-side paving edge,
//                  head top centre (x = 0) at v = 0.043, flange-polished gauge corner ~0.075,
//                  guard lip 0.106-0.127
//   flat inlays    v = rail-local x, head centre at v = 0 (wraps to 0.25)
// Surface map b = metal mask (oxide is only partly metallic).
export const railhead = {
  name: 'railhead', flat: [0.3, 0.27, 0.24, 0.45], size: [512, 256], tile: [2.0, 0.25], ss: 2, mask: 'metal',
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float wander = fbm2(m, vec2(0.6, 1.0), 3, 0.5, 134u) * 0.004;
  float hw = 0.0125 + 0.0022 * fbm2(m, vec2(1.3, 1.0), 2, 0.5, 135u);
  float d1 = m.y - 0.043 - wander;                                // swept rail
  float d0 = (m.y < 0.5 * uTile.y ? m.y : m.y - uTile.y) - wander;  // inlay strips
  float dB = min(abs(d1), abs(d0));
  float band = 1.0 - smoothstep(hw - 0.0025, hw + 0.0025, dB);
  float gauge = 1.0 - smoothstep(0.002, 0.005, abs(m.y - 0.075));
  float e = dB - hw;                                              // distance outside the band
  float edge = smoothstep(0.0, 0.002, e) * (1.0 - smoothstep(0.003, 0.006, e));
  float ox = smoothstep(0.003, 0.006, e) * (1.0 - smoothstep(0.03, 0.05, e));
  float lipZ = smoothstep(0.098, 0.104, m.y) * (1.0 - smoothstep(0.13, 0.136, m.y));   // guard lip
  // lengthwise wheel streaks (fine in the band, coarser outside) and duller burn patches
  float streak = fbm2(m, vec2(0.5, 300.0), 3, 0.5, 131u);
  float streakF = fbm2(m, vec2(0.25, 700.0), 2, 0.5, 137u);
  float streakC = fbm2(m, vec2(1.5, 90.0), 3, 0.5, 132u);
  float burn = smoothstep(0.2, 0.7, fbm2(m, vec2(3.0, 20.0), 3, 0.5, 136u));
  // running band: bright satin steel, rough and streaky
  vec3 bandC = vec3(0.54, 0.535, 0.525) * (1.0 + 0.06 * streak + 0.03 * streakF) * (1.0 - 0.12 * burn);
  float bandR = 0.27 + 0.1 * smoothstep(-0.3, 0.6, streak) + 0.05 * streakF + 0.1 * burn;
  // flange-polished gauge corner
  vec3 gaugeC = vec3(0.46, 0.45, 0.44) * (1.0 + 0.05 * streakC);
  float gaugeR = 0.3 + 0.06 * abs(streakC) + 0.06 * burn;
  // dull contact edge, oxide shoulders and bevel, dusty lip
  vec3 oxC = vec3(0.15, 0.115, 0.085) * (1.0 + 0.2 * streakC) * (1.0 - 0.15 * burn);
  vec3 dustC = vec3(0.16, 0.145, 0.125) * (1.0 + 0.12 * streakC) * (1.0 - 0.1 * burn);
  vec3 edgeC = vec3(0.3, 0.29, 0.28) * (1.0 + 0.04 * streak);
  vec3 dull = mix(mix(dustC, oxC, ox), edgeC, edge);
  float dullR = mix(mix(0.68, 0.64, ox), 0.48, edge) + 0.05 * streakC + 0.05 * burn;
  float dullM = mix(mix(0.4, 0.4, ox), 0.75, edge);
  // the lip: dusty oxide whatever the band distance says
  dull = mix(dull, dustC * (1.0 + 0.1 * streak), lipZ);
  dullR = mix(dullR, 0.7 + 0.05 * streakC, lipZ);
  dullM = mix(dullM, 0.4, lipZ);
  vec3 polC = mix(gaugeC, bandC, band);
  float polR = mix(gaugeR, bandR, band);
  float pol = max(band, 0.85 * gauge) * (1.0 - lipZ);
  s.albedo = mix(dull, polC, pol);
  s.rough = clamp(mix(dullR, polR, pol), 0.2, 1.0);
  s.metal = mix(dullM, 1.0, pol);
  s.height = mix(streakC * 0.0001, (streak + 0.5 * streakF) * 0.00005, pol);
}
`,
};

// Rusty rail web / foot and old iron: layered rust with patches of bare dark steel.
export const railside = {
  name: 'railside', flat: [0.2, 0.1, 0.05, 0.85], size: 256, tile: [1.0, 1.0], ss: 2, mask: 'metal',
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

// Painted joinery up close (window and shop frames), tile 1 m at 1 mm/texel. Gloss enamel over
// primer over timber: brush marks (fine ridges along the stroke, which runs along u or v
// in patches), orange peel and dust; chips where the paint has flaked, clustered where
// the frame is worn, showing the pale primer and, in the deeper ones, grey weathered
// wood; a lighter putty fillet (v 0-10 mm) and a bead line (v ≈ 18 mm) along u at the
// start of every tile row, so frames whose v is metres from the glass edge get them at
// the glass (tile 1 m: wider members never reach the next row). Albedo near white where painted (the vertex colour is the paint);
// surface.b = paint coverage (0 shows the baked primer / wood / putty colour as is).
export const paintdetail = {
  name: 'paintdetail', flat: [0.88, 0.88, 0.88, 0.42], size: 1024, tile: [1.0, 1.0], ss: 2, mask: 'paint',
  pass: { normal: 1.0, ao: 0.4, aoRadius: 0.002, cavity: 0.04 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec4 pc = voro(m, vec2(12.0), 401u, 1.0);                      // ~8 cm stroke patches
  vec2 bm = pc.z < 0.5 ? m : m.yx;                               // stroke (and grain) along u or v
  float brush = fbm2(bm, vec2(5.0, 140.0), 3, 0.55, 402u);
  float peel = fbm(m, 220.0, 2, 0.5, 403u);
  float dust = fbm(m, 30.0, 3, 0.5, 404u);
  // flaking: ragged patches where a warped fractal noise passes a threshold that drops in
  // the sparse worn areas; primer inside, bare wood where it flaked deeper
  float wearM = smoothstep(0.3, 0.85, 0.5 + 0.5 * fbm(m, 3.0, 3, 0.5, 405u));
  float fl = 0.5 + 0.5 * fbm(warp(m, 30.0, 0.004, 406u), 22.0, 5, 0.6, 407u);
  float th = 0.84 - 0.22 * wearM;
  float chip = smoothstep(th, th + 0.012, fl);
  float lip = smoothstep(th - 0.035, th, fl) * (1.0 - chip);
  float deep = smoothstep(th + 0.015, th + 0.025, fl);
  // putty fillet (sloping down to the glass at v = 0, hairline cracks across) and bead line
  float putty = 1.0 - smoothstep(0.0095, 0.0105, m.y);
  float crack = smoothstep(0.03, 0.0, voro(m, vec2(60.0, 6.0), 408u, 1.0).w) * putty;
  float bead = 1.0 - smoothstep(0.0012, 0.0022, abs(m.y - 0.018));
  float grain = fbm2(bm, vec2(3.0, 70.0), 3, 0.5, 409u);
  vec3 paintC = vec3(0.9) * (1.0 + 0.02 * brush - 0.04 * dust) * (1.0 + 0.08 * bead) * (1.0 - 0.1 * lip);
  vec3 primer = vec3(0.52, 0.5, 0.45) * (1.0 + 0.04 * dust);
  vec3 wood = vec3(0.33, 0.29, 0.235) * (1.0 + 0.18 * grain);
  vec3 puttyC = vec3(0.56, 0.54, 0.48) * (1.0 + 0.05 * dust) * (1.0 - 0.45 * crack);
  vec3 bare = mix(primer, wood, deep);
  s.albedo = mix(mix(paintC, bare, chip), puttyC, putty);
  s.cover = mix(1.0 - chip, 0.25, putty);
  s.rough = mix(mix(0.36 + 0.05 * brush + 0.08 * dust, mix(0.75, 0.86, deep), chip), 0.72, putty);
  s.height = brush * 0.00002 + peel * 0.00001 + lip * 0.00003 - chip * 0.00015 - deep * 0.00015
           + bead * 0.0003 - putty * (0.002 * (0.0105 - m.y) / 0.0105 + crack * 0.0003);
  s.ao = 1.0 - 0.3 * crack;
}
`,
};

// Weathered hot-dip galvanized steel (street furniture, rooftop metal): a dull grey zinc
// patina over most of the surface with the spangle crystals faintly showing through, and
// whitish zinc-carbonate blooms. Surface map b = metal mask (the patina is partly
// dielectric). Large patches come from the runtime macro layer.
export const galv = {
  name: 'galv', flat: [0.53, 0.54, 0.545, 0.6], size: 512, tile: [0.5, 0.5], ss: 2, mask: 'metal',
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
