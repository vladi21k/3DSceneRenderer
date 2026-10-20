// Paving recipes: grey granite setts in running bond (street + sidewalk share the maps at
// different scales), the crystal detail map of the granite, the light stone edge band,
// platform slabs and tactile tiles.
// Rows (courses) run along recipe u. paving.street swaps u/v at runtime so its courses
// lie across the street, as in the photographs; the sidewalk keeps them along it.

const GRANITE = /* glsl */ `
// fine-grained grey granite seen from metres away: the crystals themselves come from the
// 'granite' detail map at runtime, the bake keeps soft ~1-2 cm mottling and clouding
vec3 granite(vec2 m, vec3 base) {
  vec3 c = base * (1.0 + 0.07 * fbm(m, 50.0, 2, 0.45, 81u));
  c *= 1.0 + 0.05 * fbm(m, 9.0, 3, 0.5, 82u);
  return c;
}
`;

// Granite crystals for close range (detail map: normal.xy, moment, albedo modulation at
// 0.5 = neutral). Interlocking 1-4 mm grains: black mica (0.5x, glossy at runtime),
// pale feldspar (1.3x), grey quartz; fine sub-grains and hairline grain boundaries.
export const granite = {
  name: 'granite', flat: [1, 1, 1, 0.8], size: 512, tile: [0.25, 0.25], ss: 2,
  pass: { normal: 1.0, ao: 0.0, cavity: 0.0 },
  glsl: /* glsl */ `
void surface(vec2 m, inout Surf s) {
  vec2 w = warp(m, 120.0, 0.0009, 321u);
  vec4 v = voro(w, vec2(380.0), 322u, 1.0);             // ~2.6 mm crystals
  vec4 v2 = voro(m, vec2(900.0), 323u, 1.0);            // ~1.1 mm sub-grains
  float k = v.z;
  float a = k < 0.16 ? 0.5 : (k > 0.68 ? 1.3 + 0.1 * fract(k * 9.1) : 0.9 + 0.14 * fract(k * 7.3));
  a *= 1.0 + 0.1 * (v2.z - 0.5);
  float edge = smoothstep(0.07, 0.0, v.w);
  a *= 1.0 - 0.1 * edge;
  s.height = (k < 0.16 ? 0.00003 : 0.0) - edge * 0.00005 + fbm(m, 500.0, 2, 0.5, 324u) * 0.00002;
  s.ao = sat(0.5 * a);
  s.albedo = vec3(1.0);
  s.rough = 0.8;
}
`,
};

// Street / sidewalk setts: 0.40 × 0.20 m (lengths 0.29–0.52) in courses, 1.6 mm/texel.
// Every sett is its own stone: its own mottling (the granite noise is offset per sett, so
// it never runs on across a joint), a faint tone gradient from the block it was split
// from, and its own finish: flamed (paler, matt, micro-rough) or worn smooth by traffic
// (darker, satin, slightly dished, arrises rounded). Some setts carry a dark xenolith, a
// pale aplite vein, rust specks or a hairline crack (spill blots, which would repeat
// with the tile, are drawn at runtime per global sett); a corner in ten is spalled and a
// few arrises chipped, the breaks shallow and close to the sett's tone. Dirt is worked
// into the stone for about a centimetre along the joints, patchily, a little darker at the
// corners.
// Joints: each joint has its own width (head joints 2-6 mm, bed joints 1-3 mm, varying
// along it), fill depth (sand to the top, a few millimetres down, or washed out) and fill
// (pale sand, grey dirt, dark grime), looked up by the joint's own id so both setts beside
// it agree. Bed joints are tight and mostly sand-filled (faint light lines), head joints
// wider, mostly sand or dust and some dirtier (soft grey dashes); from metres away the
// joints average out towards the sett tone (no cobble outline that would crawl at ride
// speed), and further off the runtime draws them as pale dusty lines (surface.js far
// blend). Mid-grey granite with a cool cast (the street is a little darker than the
// facades).
export const paving = {
  name: 'paving', flat: [0.16, 0.167, 0.186, 0.6], size: 2048, tile: [3.2, 3.2], ss: 2,
  layout: { rowH: 0.2, rows: 16, seg: [7, 9], jitter: 0.32, seed: 5, shift: true },
  joint: 0.0018,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.005, cavity: 0.08 },
  glsl: GRANITE + /* glsl */ `
// a line across the sett (crack or vein): distance (m) from it, along a random direction
// through a random point, wandering
float settLine(Cell c, vec2 m, uint k, float wander, float wf) {
  float a = (cellRand(c, k) - 0.5) * 1.4 + (cellRand(c, k + 1u) < 0.5 ? 0.0 : 1.5708);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 p0 = (vec2(cellRand(c, k + 2u), cellRand(c, k + 3u)) - 0.5) * c.size * 0.6;
  vec2 q = c.lp - 0.5 * c.size - p0;
  float along = dot(q, dir);
  return abs(dot(q, vec2(-dir.y, dir.x)) + wander * fbm(vec2(along, c.h * 3.1), wf, 3, 0.5, k + 9u));
}
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  vec2 q = c.lp - 0.5 * c.size;
  vec2 ms = m + vec2(c.h * 37.1, cellRand(c, 30u) * 23.7);       // this sett's own noise space
  // ---- joints: the nearer head joint and bed joint, with their own ids
  bool leftH = c.ed.x < c.ed.y;
  uint jh = sfH2(c.r, sfMod(leftH ? c.k : c.k + 1, c.n), 601u);
  float jhX = leftH ? m.x - c.ed.x : m.x + c.ed.y;
  bool lowB = c.ed.z < c.ed.w;
  uint jb = sfH2(lowB ? c.r : sfMod(c.r + 1, int(uLay.y)), 0, 602u);
  float jbY = lowB ? m.y - c.ed.z : m.y + c.ed.w;
  float nh = noiseM(vec2(jhX * 3.0, m.y), vec2(40.0), 603u), nb = noiseM(vec2(m.x, jbY * 3.0), vec2(25.0), 604u);
  float h1 = sfHf(jh), h2 = sfHf(sfH(jh + 1u)), h3 = sfHf(sfH(jh + 2u));
  float b1 = sfHf(jb), b2 = sfHf(sfH(jb + 1u)), b3 = sfHf(sfH(jb + 2u));
  float JH = 0.0011 + 0.0017 * h1 + 0.0005 * nh;                 // half widths (m)
  float JB = 0.0005 + 0.0008 * b1 + 0.0003 * nb;
  float wob = fbm(m, 20.0, 2, 0.5, 91u) * 0.0006 + fbm(m, 70.0, 2, 0.5, 99u) * 0.00025;
  float eH = min(c.ed.x, c.ed.y) + wob;
  float eB = min(c.ed.z, c.ed.w) + wob * 0.5;
  bool head = eH - JH < eB - JB;
  // ---- the sett: finish, lippage and tilt, wear
  float fin = cellRand(c, 10u);                                   // 0 flamed .. 1 worn smooth
  float worn = smoothstep(0.45, 0.85, fin);
  float CH = 0.001 + 0.0012 * cellRand(c, 11u) + 0.0012 * worn;  // arris rounding (m)
  float CB = 0.0012 + 0.0012 * cellRand(c, 12u) + 0.0010 * worn;
  float lip = (cellRand(c, 1u) - 0.5) * 0.002
            + dot(q, vec2(cellRand(c, 2u) - 0.5, cellRand(c, 3u) - 0.5)) * 0.008;
  vec2 qn = q / (0.5 * c.size);
  float dish = -0.0005 * worn * (1.0 - 0.5 * dot(qn * qn, vec2(0.5)));
  // (worn tops keep some of the grain: a mirror-smooth sett among flamed ones glints alone
  // at grazing angles, its mip variance far below its neighbours')
  float relief = fbm(ms, 35.0, 3, 0.5, 92u) * mix(0.00035, 0.00022, worn) + fbm(ms, 140.0, 2, 0.5, 105u) * 0.00018 * (1.0 - 0.6 * worn);
  float tH = clamp((eH - JH) / CH, 0.0, 1.0);
  float tB = clamp((eB - JB) / CB, 0.0, 1.0);
  float hFace = lip + dish + relief - 0.55 * CH * (1.0 - tH) * (1.0 - tH) - 0.6 * CB * (1.0 - tB) * (1.0 - tB);
  // corner spalls (one corner in ten) and a few small arris chips; shallow broken floors,
  // old ones a little dirtier, a few fresh and pale (kept close to the sett's tone: dark
  // dirt-filled chips along every bed joint read as a scatter of black dashes once the
  // courses are foreshortened to a pixel or two)
  vec2 cq = vec2(q.x < 0.0 ? c.ed.x : c.ed.y, q.y < 0.0 ? c.ed.z : c.ed.w);
  uint ck = c.id + (q.x < 0.0 ? 0u : 1u) + (q.y < 0.0 ? 0u : 2u) * 7u;
  float cr = sfHf(sfH(ck + 77u));
  float spR = 0.006 + 0.014 * sfHf(sfH(ck + 78u));
  float spall = step(0.9, cr) * (1.0 - smoothstep(spR - 0.0015, spR + 0.0015, cq.x + cq.y + 0.004 * noiseM(ms, vec2(60.0), 106u)));
  vec4 cv = voro(ms, vec2(30.0), 94u, 1.0);
  float chip = smoothstep(0.42, 0.18, cv.x) * step(0.93, cv.z) * (1.0 - smoothstep(0.0, 0.012, min(eH, eB)));
  float broken = max(spall, chip);
  float fresh = step(0.75, cellRand(c, 13u));
  hFace -= broken * (0.0015 + 0.0008 * noiseM(ms, vec2(90.0), 107u));
  // hairline crack across a few setts
  float crack = 0.0;
  if (cellRand(c, 14u) < 0.07) {
    float cd = settLine(c, m, 40u, 0.01, 12.0);
    crack = 1.0 - smoothstep(0.0003, 0.0016, cd);
    hFace -= crack * 0.0006;
  }
  // ---- joint profile: fill depth and fill colour per joint (washed out in stretches)
  float sH = smoothstep(JH - 0.0006, JH + 0.0006, eH);
  float sB = smoothstep(JB - 0.0004, JB + 0.0004, eB);
  float fillH = h2 < 0.45 ? 0.0008 : (h2 < 0.85 ? 0.0025 : 0.007);
  float fillB = b2 < 0.65 ? 0.0004 : (b2 < 0.92 ? 0.0018 : 0.005);
  float washH = smoothstep(0.35, 0.6, noiseM(vec2(jhX * 5.0, m.y), vec2(6.0), 608u)) * 0.004;
  float washB = smoothstep(0.4, 0.65, noiseM(vec2(m.x, jbY * 5.0), vec2(3.0), 609u)) * 0.003;
  float depth = head ? fillH + washH : fillB + washB;
  float hJ = -depth + (head ? fbm(m, 120.0, 2, 0.5, 95u) * 0.0006 : fbm(m, 150.0, 2, 0.5, 97u) * 0.0004);
  float st = min(sH, sB);
  s.height = mix(hJ, max(hFace, hJ), st);
  // ---- colour: granite with this sett's own mottling and clustering, tone gradient,
  // finish, inclusions
  vec3 g = granite(ms, vec3(0.162, 0.17, 0.19));
  g *= 1.0 + 0.12 * fbm(ms, 28.0, 3, 0.55, 108u) + 0.07 * fbm(ms, 95.0, 2, 0.5, 109u) + 0.06 * noiseM(ms, vec2(230.0), 117u);
  g *= 1.0 + 0.035 * dot(qn, vec2(cellRand(c, 15u) - 0.5, cellRand(c, 16u) - 0.5));
  g *= mix(1.012, 0.985, worn);
  float xr = cellRand(c, 17u);
  if (xr < 0.035) {                                                // dark xenolith (fine-grained, speckled)
    vec2 xc = (vec2(cellRand(c, 18u), cellRand(c, 19u)) - 0.5) * c.size * 0.6;
    float xs = 0.015 + 0.03 * cellRand(c, 20u);
    vec2 xd = (q - xc) / vec2(xs * (1.3 + cellRand(c, 21u)), xs);
    float xb = 1.0 - smoothstep(0.85, 1.15, length(xd) + 0.25 * fbm(ms, 40.0, 2, 0.5, 110u));
    g = mix(g, g * vec3(0.74, 0.75, 0.78) * (1.0 + 0.12 * noiseM(ms, vec2(300.0), 118u)), xb);
  } else if (xr < 0.115) {                                         // pale aplite vein
    float vd = settLine(c, m, 50u, 0.025, 3.0);
    float vw = 0.002 + 0.005 * cellRand(c, 22u);
    g = mix(g, g * vec3(1.16, 1.15, 1.12), (1.0 - smoothstep(vw, vw + 0.004, vd)) * 0.6);
  }
  if (cellRand(c, 23u) < 0.2) {                                    // rust specks (weathered pyrite)
    vec4 rv = voro(ms, vec2(70.0), 111u, 1.0);
    float rs = smoothstep(0.3, 0.05, rv.x) * step(0.93, rv.z);
    float halo = smoothstep(0.6, 0.1, rv.x) * step(0.93, rv.z);
    g = mix(g, g * vec3(1.18, 0.98, 0.78), 0.45 * halo);
    g = mix(g, vec3(0.13, 0.075, 0.04), 0.8 * rs);
  }
  // dirt worked into the stone along the joints: about a centimetre, patchy, a little
  // darker at the corners and along the head joints; the chamfers a touch grimier
  float ej = min(eH - JH, eB - JB);
  float dirtA = 0.05 + 0.05 * sfHf(sfH(c.id + 31u));
  float patchD = 0.55 + 0.9 * (0.5 + 0.5 * fbm(ms, 9.0, 3, 0.5, 113u));
  float corner = 1.0 - smoothstep(0.0, 0.035, max(cq.x, cq.y));
  g *= 1.0 - dirtA * patchD * (1.0 - smoothstep(0.0, 0.007 + 0.007 * sfHf(sfH(c.id + 32u)), ej)) - 0.05 * corner;
  g *= mix(0.94, 1.0, tH) * mix(0.96, 1.0, tB);
  g = mix(g, fresh > 0.5 ? g * vec3(1.08, 1.075, 1.07) : g * vec3(0.87, 0.86, 0.85), broken);
  g *= 1.0 - 0.45 * crack;
  // joint fill: pale sand, grey dirt or dark grime, per joint and along it
  float fsel = head ? h3 : b3;
  float fn = 0.5 + 0.5 * (head ? nh : nb);
  vec3 sand = vec3(0.205, 0.192, 0.172) * (1.0 + 0.2 * fbm(m, 90.0, 2, 0.5, 98u));
  vec3 dirt = vec3(0.13, 0.124, 0.113) * (1.0 + 0.25 * fbm(m, 60.0, 2, 0.5, 96u));
  vec3 grime = vec3(0.065, 0.061, 0.056);
  float wDirt = smoothstep(0.3, 0.7, fsel + 0.3 * (fn - 0.5)) * (head ? 0.7 : 0.5);
  float wGrime = smoothstep(0.8, 0.98, fsel + 0.2 * (fn - 0.5)) + smoothstep(0.004, 0.008, depth);
  vec3 joint = mix(mix(sand, dirt, wDirt), grime, sat(wGrime));
  s.albedo = mix(joint, g, st);
  // flamed tops matt (~0.7), worn ones a soft satin (a broad low-angle sheen towards a low
  // sun or the bright end of the street, never a mirror: the difference between neighbouring
  // setts stays small, or single setts glint out of it at grazing angles); breaks and cracks
  // rough, joints matt
  float rough = mix(0.695, 0.672, worn) + 0.03 * fbm(ms, 6.0, 2, 0.5, 114u) + 0.04 * fbm(ms, 40.0, 2, 0.5, 115u);
  rough = mix(rough, 0.8, max(broken, crack));
  s.rough = mix(head ? 0.95 : 0.92, rough, st);
}
`,
};

// Light stone edge band of the track corridor: honed slabs 0.6–0.9 m, no lengthwise
// joints. Pale grey stone, only a little lighter than the setts (as in the photographs:
// a subtle light stripe, not a painted line), visibly speckled and mottled, slab tones
// ±8 %, the 4 mm slab joints holding a few centimetres of grime.
export const band = {
  name: 'band', flat: [0.214, 0.213, 0.207, 0.62], size: 512, tile: [2.4, 2.4], ss: 2,
  layout: { rowH: 2.4, rows: 1, seg: [3, 4], jitter: 0.3, seed: 8, shift: false, rowJoints: false },
  joint: 0.0026,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.006, cavity: 0.05 },
  glsl: GRANITE + /* glsl */ `
void surface(vec2 m, inout Surf s) {
  Cell c = rowsCell(m);
  float e = c.e + fbm(m, 15.0, 2, 0.5, 101u) * 0.0006;
  const float JW = 0.002;
  float t = clamp((e - JW) / 0.003, 0.0, 1.0);
  float lip = (cellRand(c, 1u) - 0.5) * 0.002 + (c.lp.x - 0.5 * c.size.x) * (cellRand(c, 2u) - 0.5) * 0.004;
  float hFace = lip + fbm(m, 30.0, 3, 0.5, 102u) * 0.0002 - 0.003 * (1.0 - t);
  float stone = smoothstep(JW - 0.0005, JW + 0.0005, e);
  s.height = mix(-0.005, max(hFace, -0.005), stone);
  // pale grey limestone / light granite: soft clouding and a visible fine speckle
  vec3 base = vec3(0.218, 0.217, 0.211) * (1.0 + 0.08 * fbm(m, 3.0, 4, 0.55, 103u) + 0.04 * fbm(m, 18.0, 2, 0.5, 104u));
  base *= 1.0 + 0.08 * (cellRand(c, 5u) - 0.5) * 2.0;                       // slab tone
  vec4 g = voro(m, vec2(220.0), 105u, 1.0);
  base *= 1.0 - 0.3 * step(0.84, g.z) * smoothstep(0.45, 0.2, g.x);
  vec4 g2 = voro(m, vec2(140.0), 107u, 1.0);
  base *= 1.0 + 0.12 * step(0.9, g2.z) * smoothstep(0.4, 0.15, g2.x);       // pale feldspar
  // grime along the slab joints, fading over a few centimetres (wide enough that the
  // joints still mark the slabs off at 10-30 m, where the joint itself is sub-pixel)
  base *= mix(0.66, 1.0, smoothstep(0.0, 0.016, e - JW)) * mix(0.88, 1.0, smoothstep(0.0, 0.07, e - JW));
  s.albedo = mix(vec3(0.085, 0.082, 0.078), base, stone);
  s.rough = mix(0.95, 0.62 + 0.06 * fbm(m, 4.0, 2, 0.5, 106u), stone);
}
`,
};

// Platform: 0.40 m square concrete-stone slabs, stack bond, exposed fine aggregate.
export const platform = {
  name: 'platform', flat: [0.27, 0.264, 0.252, 0.74], size: 512, tile: [2.4, 2.4], ss: 2,
  layout: { rowH: 0.4, rows: 6, seg: [6, 6], jitter: 0.0, seed: 9, shift: false },
  joint: 0.003,
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.006, cavity: 0.05 },
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
  vec3 base = vec3(0.285, 0.278, 0.265) * (1.0 + 0.05 * fbm(m, 4.0, 3, 0.5, 113u));   // a little lighter than the setts
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
  pass: { normal: 1.0, ao: 0.5, aoRadius: 0.008, cavity: 0.05 },
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
