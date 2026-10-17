// Lantern profiles (pure data, plotted offline). Surfaces of revolution around the hang
// axis: [r, y, sharp?] from bottom to top, y relative to the hang point (the bottom of the
// bracket volute), in metres.
//
// The luminaire is the classic city lantern of the street: a short stem, a domed cap on a
// beaded drum, a shoulder and a steep flared cone that ends in a broad brim with a rolled
// edge, and a clear prismatic acorn bowl tucked under the brim.

export const STEM_LEN = 0.09;
export const GLASS_TOP = -0.432;
export const GLASS_BOTTOM = -0.695;
export const GLASS_CENTRE = -0.53;      // light centre (lamp inside the bowl)
export const BRIM_R = 0.3;

const arc = (cx, cy, r, a0, a1, n) => {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
};

/** Hood (cap, drum, cone, brim) as one closed profile, underside first. lo = coarse. */
export function lanternMetalProfile(lo = false) {
  const n = lo ? 2 : 4;
  const P = [];
  // seat ring the glass hangs in, then the flat underside of the brim
  P.push([0.148, -0.448], [0.156, -0.448, true], [0.156, -0.434, true], [0.26, -0.43, true]);
  // rolled edge of the brim (a bead about 15 mm thick)
  for (const p of arc(0.287, -0.418, 0.015, -Math.PI / 2, Math.PI / 2, n + 2)) P.push(p);
  P.push([0.284, -0.401, true], [0.268, -0.398]);
  // steep flared cone up to the shoulder
  P.push([0.236, -0.373], [0.204, -0.341], [0.18, -0.312], [0.168, -0.29, true]);
  // shoulder ring
  P.push([0.172, -0.287, true], [0.172, -0.268, true], [0.142, -0.264, true]);
  // drum with two beads
  for (const [y, r] of [[-0.248, 0.008], [-0.168, 0.007]]) {
    P.push([0.128, y - r - 0.006, true]);
    for (const p of arc(0.128, y, r, -Math.PI / 2, Math.PI / 2, n)) P.push(p);
    P.push([0.128, y + r + 0.006, true]);
  }
  // lip and domed cap
  P.push([0.128, -0.152, true], [0.136, -0.15, true], [0.136, -0.142, true], [0.118, -0.14, true]);
  for (let i = 1; i <= n + 2; i++) { const t = (i / (n + 2)) * 1.18; P.push([0.118 * Math.cos(t), -0.14 + 0.04 * Math.sin(t)]); }
  // cap ring and the socket the stem screws into
  P.push([0.044, -0.1, true], [0.044, -0.093, true], [0.02, -0.091, true]);
  if (!lo) for (const p of arc(0.0, -0.082, 0.013, -Math.PI / 2 + 0.7, Math.PI / 2, 3)) P.push(p);
  P.push([0.0, -STEM_LEN + 0.02]);
  return P;
}

/** Acorn bowl: top tucked into the seat ring, bulge just below the brim, drip finial. */
export function lanternGlassProfile() {
  return [
    [0.0, GLASS_BOTTOM], [0.006, -0.693], [0.008, -0.684], [0.022, -0.678],
    [0.05, -0.664], [0.082, -0.643], [0.11, -0.614], [0.132, -0.58],
    [0.148, -0.54], [0.155, -0.5], [0.153, -0.472], [0.145, -0.45],
    [0.142, -0.44], [0.1, -0.436], [0.0, -0.434],
  ];
}
