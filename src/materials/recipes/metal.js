// Metals, rail steel, paint, plastic and glass recipes.

// Rail head steel. Tile 2 m along the rail (u) × 0.25 m across (v, metres). A narrow
// running band, 21-29 mm wide on the head (drifting a few mm along the rail), is the
// brightest part: satin steel at roughness 0.45-0.6, never a mirror, with lengthwise wheel
// streaks (roughness ±0.06 in fine lines) and 2-10 cm patches along the rail (±0.06), and a
// few duller, darker burn patches where wheels slipped. On a busy line the rest of the head
// is worn steel too, only duller: the crowned shoulders either side of the band (grey,
// albedo ~0.29, roughness ~0.6, metal 0.75), the field-side bevel and the gauge corner
// under a thin light oxide film (albedo ~0.25, roughness ~0.65, metal 0.6), so the whole
// head reads light beside the dark flangeway, as in the photographs. The upper gauge face
// (flange contact) is lightly polished; the guard lip past the groove is dull dusty oxide.
// The band sits where the street geometry puts the head top (see meta.uv of rail.head):
//   swept rail     the head top (x -25 .. 21.5 mm) is pinned onto v 0.031-0.0543, i.e. half a
//                  metre of v per metre of head, centre (x = 0) at v = 0.0435; field-side
//                  bevel v 0.017-0.031, gauge corner 0.054-0.071, gauge face 0.071-0.079,
//                  guard lip 0.106-0.127
//   flat inlays    v = rail-local x (1:1), head centre at v = 0 (wraps to 0.25); worn steel
//                  within |x| < 27 mm
// Widths below are on the head (m); the swept band is half as wide in v.
// Surface map b = metal mask (oxide is only partly metallic).
export const railhead = {
  name: 'railhead', flat: [0.17, 0.14, 0.11, 0.65], size: [512, 512], tile: [2.0, 0.25], ss: 2, mask: 'metal',
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  float wander = fbm2(m, vec2(0.6, 1.0), 3, 0.5, 134u) * 0.003;            // band drift on the head (m)
  float hw = 0.0125 + 0.0018 * fbm2(m, vec2(1.3, 1.0), 2, 0.5, 135u);      // band half width on the head
  float d1 = (m.y - 0.0435) * 2.0 - wander;                                // swept head (0.5 v per m)
  float d0 = (m.y < 0.5 * uTile.y ? m.y : m.y - uTile.y) - wander;          // inlay strips (1:1)
  bool swept = m.y > 0.026 && m.y < 0.07;
  float dB = swept ? abs(d1) : abs(d0);
  float band = 1.0 - smoothstep(hw - 0.0018, hw + 0.0018, dB);
  float e = dB - hw;                                                        // outside the band (m on the head)
  float edge = smoothstep(-0.001, 0.001, e) * (1.0 - smoothstep(0.002, 0.0035, e));
  float gauge = (1.0 - smoothstep(0.0025, 0.0045, abs(m.y - 0.076))) * step(0.0543, m.y);
  float lipZ = smoothstep(0.098, 0.104, m.y) * (1.0 - smoothstep(0.13, 0.136, m.y));   // guard lip
  // lengthwise wheel streaks (fine lines and 2-10 cm patches along the rail), burn patches
  float streak = fbm2(m, vec2(0.5, 300.0), 3, 0.5, 131u);
  float streakF = fbm2(m, vec2(0.25, 700.0), 2, 0.5, 137u);
  float patchy = fbm2(m, vec2(12.0, 30.0), 3, 0.5, 138u);
  float streakC = fbm2(m, vec2(1.5, 90.0), 3, 0.5, 132u);
  float burn = smoothstep(0.38, 0.75, fbm2(m, vec2(2.0, 14.0), 3, 0.5, 136u));
  // running band: satin steel, rough and streaky, burn patches duller and darker
  vec3 bandC = vec3(0.47, 0.465, 0.455) * (1.0 + 0.05 * streak + 0.03 * streakF + 0.03 * patchy);
  bandC = mix(bandC, vec3(0.3, 0.27, 0.25), 0.55 * burn);
  float bandR = clamp(0.52 + 0.06 * streak + 0.03 * streakF + 0.06 * patchy + 0.1 * burn, 0.44, 0.66);
  // lightly polished upper gauge face
  vec3 gaugeC = vec3(0.36, 0.35, 0.34) * (1.0 + 0.05 * streakC);
  float gaugeR = 0.5 + 0.05 * streakC + 0.05 * burn;
  // worn steel off the band: crowned shoulders (head top), and under a thin light oxide film
  // the field-side bevel and the gauge corner; dark brown oxide only off the head (inlay
  // margins, the groove walls), dusty oxide on the guard lip
  float top = smoothstep(0.0295, 0.0315, m.y) * (1.0 - smoothstep(0.0533, 0.0553, m.y));
  float headW = smoothstep(0.015, 0.019, m.y) * (1.0 - smoothstep(0.069, 0.073, m.y));
  float inlayW = 1.0 - smoothstep(0.024, 0.03, abs(d0));
  float steelW = max(headW, inlayW);
  float film = (1.0 - top) * (1.0 - inlayW * (1.0 - smoothstep(0.018, 0.026, abs(d0))));   // bevel / corner film
  vec3 steelC = vec3(0.29, 0.28, 0.265) * (1.0 + 0.1 * streakC + 0.06 * patchy + 0.03 * streak);
  steelC = mix(steelC, vec3(0.255, 0.232, 0.205) * (1.0 + 0.1 * streakC), film);
  steelC = mix(steelC, vec3(0.22, 0.2, 0.18), 0.4 * burn);
  float steelR = mix(0.58, 0.65, film) + 0.04 * streakC + 0.03 * patchy;
  float steelM = mix(0.75, 0.6, film);
  vec3 oxC = vec3(0.155, 0.118, 0.085) * (1.0 + 0.15 * streakC + 0.08 * patchy);
  vec3 dustC = vec3(0.16, 0.145, 0.125) * (1.0 + 0.12 * streakC) * (1.0 - 0.1 * burn);
  vec3 edgeC = vec3(0.33, 0.32, 0.31) * (1.0 + 0.04 * streak);                            // 2-3 mm contact edge
  vec3 dull = mix(oxC, steelC, steelW);
  float dullR = mix(0.7 + 0.04 * streakC, steelR, steelW);
  float dullM = mix(0.4, steelM, steelW);
  dull = mix(dull, edgeC, edge * steelW);
  dullR = mix(dullR, 0.54, edge * steelW);
  dullM = mix(dullM, 0.8, edge * steelW);
  dull = mix(dull, dustC * (1.0 + 0.1 * streak), lipZ);
  dullR = mix(dullR, 0.72 + 0.05 * streakC, lipZ);
  dullM = mix(dullM, 0.4, lipZ);
  vec3 polC = mix(gaugeC, bandC, band);
  float polR = mix(gaugeR, bandR, band);
  float pol = max(band, 0.6 * gauge) * (1.0 - lipZ);
  s.albedo = mix(dull, polC, pol);
  s.rough = clamp(mix(dullR, polR, pol), 0.3, 1.0);
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
// in patches), orange peel and dust; chalky dull patches where the frame is worn, with a
// few small flakes there showing the pale primer and, in the deeper ones, grey weathered
// wood; a painted-over putty fillet (v 0-10 mm) and a bead line (v ≈ 18 mm) along u at the
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
  // wear: mostly dull, chalky patches (matt, a touch paler) where the frame weathers; only a
  // few small flakes (2-6 mm, sparse even where worn), primer inside, bare wood where it
  // flaked deeper. Under dark paints the runtime tones the flakes down (surface.js PAINT).
  float wearM = smoothstep(0.3, 0.85, 0.5 + 0.5 * fbm(m, 3.0, 3, 0.5, 405u));
  float chalk = smoothstep(0.2, 0.75, wearM * (0.5 + 0.5 * fbm(m, 9.0, 3, 0.5, 410u)) * 1.6);
  float fl = 0.5 + 0.5 * fbm(warp(m, 60.0, 0.002, 406u), 40.0, 4, 0.6, 407u);
  float th = 0.785 - 0.1 * wearM;
  float chip = smoothstep(th, th + 0.01, fl);
  float lip = smoothstep(th - 0.025, th, fl) * (1.0 - chip);
  float deep = smoothstep(th + 0.012, th + 0.02, fl);
  // putty fillet (sloping down to the glass at v = 0, hairline cracks across; painted over
  // like the frame, the putty shows only through the cracks) and bead line
  float putty = 1.0 - smoothstep(0.0095, 0.0105, m.y);
  float crack = smoothstep(0.03, 0.0, voro(m, vec2(60.0, 6.0), 408u, 1.0).w) * putty;
  float bead = 1.0 - smoothstep(0.0012, 0.0022, abs(m.y - 0.018));
  float grain = fbm2(bm, vec2(3.0, 70.0), 3, 0.5, 409u);
  vec3 paintC = vec3(0.9) * (1.0 + 0.02 * brush - 0.04 * dust + 0.05 * chalk) * (1.0 + 0.03 * bead) * (1.0 - 0.06 * lip);
  vec3 primer = vec3(0.52, 0.5, 0.45) * (1.0 + 0.04 * dust);
  vec3 wood = vec3(0.33, 0.29, 0.235) * (1.0 + 0.18 * grain);
  vec3 puttyC = vec3(0.56, 0.54, 0.48) * (1.0 + 0.05 * dust) * (1.0 - 0.45 * crack);
  vec3 bare = mix(primer, wood, deep);
  s.albedo = mix(mix(paintC, bare, chip), mix(paintC, puttyC, 0.5 * crack + 0.1), putty);
  s.cover = mix(1.0 - chip, 0.9 - 0.6 * crack, putty);
  s.rough = mix(mix(0.36 + 0.05 * brush + 0.08 * dust + 0.24 * chalk, mix(0.75, 0.86, deep), chip), 0.5 + 0.2 * crack, putty);
  s.height = brush * 0.00002 * (1.0 - 0.5 * chalk) + peel * 0.00001 + lip * 0.00003 - chip * 0.00015 - deep * 0.00015
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
  s.rough = 0.03 + 0.07 * dust * (0.4 + 0.6 * lower);     // clean float glass ~0.03, dusty low corners ~0.1
}
`,
};
