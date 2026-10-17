import { RAIL_CENTER, TRACK_OFFSET, TRACK_ZONE_HALF, EDGE_BAND_W, RAIL_HEAD_W, RAIL_GROOVE_W } from '../../core/config.js';

// Street cross-section and grooved-rail geometry (metres).
//
// Rail-local coordinate x runs across the rail and is positive towards the gauge side
// (towards the track centre); h is height above the rail top / paving (h = 0).
// A rail with centre line c and gauge direction g maps x to street offset d = c + g·x.

export const HEAD_HALF = RAIL_HEAD_W / 2;                // 0.028 running head half width
export const GROOVE_IN = HEAD_HALF;                      // groove starts at the head's gauge face
export const GROOVE_OUT = HEAD_HALF + RAIL_GROOVE_W;     // 0.070 (42 mm flangeway)
export const LIP_OUT = GROOVE_OUT + 0.013;               // 0.083 guard lip
export const SEAL_W = 0.012;                             // rubber / bitumen sealing strip
export const RAIL_X0 = -HEAD_HALF - SEAL_W;              // -0.040 field-side paving edge
export const RAIL_X1 = LIP_OUT + SEAL_W;                 // 0.095 gauge-side paving edge
export const HEAD_DULL = -0.0270;                        // rusty field-side bevel ends here (< 2 mm)
export const GROOVE_DEPTH = 0.0365;
export const GROUT_W = 0.07;                             // dark mortar strip bedding each rail into the setts

// The four running rails of the two main tracks: centre line d and gauge direction g.
export const MAIN_RAILS = [];
for (const t of [-1, 1]) {
  MAIN_RAILS.push({ track: t, c: t * TRACK_OFFSET - RAIL_CENTER, g: +1 });
  MAIN_RAILS.push({ track: t, c: t * TRACK_OFFSET + RAIL_CENTER, g: -1 });
}
MAIN_RAILS.sort((a, b) => a.c - b.c);
for (const r of MAIN_RAILS) {
  const a = r.c + r.g * RAIL_X0, b = r.c + r.g * RAIL_X1;
  r.lo = Math.min(a, b); r.hi = Math.max(a, b);
}

/** Distance (m) from street offset d to the nearest main rail span (0 inside a span). */
export function railDist(d) {
  let e = 1e9;
  for (let i = 0; i < 4; i++) {
    const r = MAIN_RAILS[i];
    const v = d < r.lo ? r.lo - d : d > r.hi ? d - r.hi : 0;
    if (v < e) e = v;
  }
  return e;
}

export const CORRIDOR = TRACK_ZONE_HALF;                 // 3.4
export const BAND_IN = TRACK_ZONE_HALF - EDGE_BAND_W;    // 3.1 inner edge of the light stone band
export const GUTTER_W = 0.26;                            // dished drainage channel outside the band
export const GUTTER_OUT = TRACK_ZONE_HALF + GUTTER_W;    // 3.66
export const SIDEWALK_RISE = 0;                          // sidewalk level above the rail tops (the
                                                         // real ground shape comes from route.surface)
export const FACADE_OVERLAP = 1.0;                       // sidewalk runs this far under the facades
export const SLAB_H = -0.30;                             // ground slab below everything

// Grooved rail cross-section, from the field-side paving edge to the gauge-side one:
// [x, h, kind of the segment that ends at this point, cavity AO at this point, rail.head
// texture v (optional; default: arc length along the profile)].
//   head   head top: the polished running band (rail.head texture band, v 0.031-0.054)
//   gauge  gauge corner and upper gauge face, polished by the flanges (texture v ≈ 0.075)
//   lip    guard lip top and both its edges: steel dulled by dust, no wheel contact
//   side   narrow rusty field-side bevel
//   groove compacted grime in the flangeway and on its walls
//   seal   bitumen sealing strip against the paving
// The AO darkens the cavity (groove floor 0.25, walls 0.45, lower gauge face 0.6), so
// the flangeway reads as a dark slot rather than a lit channel.
export const RAIL_PROFILE = [
  [RAIL_X0, 0.0, null, 1],
  [-0.0378, -0.0024, 'seal', 0.92],
  [-0.0287, -0.0038, 'seal', 0.8],
  [-0.0283, -0.0019, 'side', 0.9],
  [HEAD_DULL, -0.0006, 'side', 1],
  [-0.0250, -0.0002, 'head', 1, 0.031],
  [0.0000, 0.0, 'head', 1, 0.0435],        // slightly crowned, polished running surface
  [0.0160, -0.0001, 'head', 1, 0.0515],
  [0.0215, -0.0003, 'head', 1, 0.0543],
  [0.0252, -0.0017, 'gauge', 1, 0.071],     // gauge corner, polished by the flanges
  [0.0274, -0.0044, 'gauge', 0.92, 0.075],
  [0.0281, -0.0115, 'gauge', 0.62, 0.079],  // flange contact band on the gauge face
  [0.0286, -0.0290, 'groove', 0.42],
  [0.0318, -0.0342, 'groove', 0.3],
  [0.0395, -GROOVE_DEPTH, 'groove', 0.25],
  [0.0585, -GROOVE_DEPTH, 'groove', 0.25],
  [0.0658, -0.0338, 'groove', 0.3],
  [0.0690, -0.0280, 'groove', 0.45],
  [0.0698, -0.0095, 'groove', 0.62],
  [0.0702, -0.0040, 'lip', 0.82],          // worn inner edge of the lip
  [0.0714, -0.0017, 'lip', 0.97],
  [0.0742, -0.0011, 'lip', 1],
  [0.0800, -0.0014, 'lip', 1],
  [0.0828, -0.0040, 'lip', 0.92],
  [0.0858, -0.0043, 'seal', 0.8],
  [0.0925, -0.0027, 'seal', 0.92],
  [RAIL_X1, 0.0, 'seal', 1],
];

// Effective albedo of the bitumen seal and of the mortar bed (linear). The seal is drawn
// with the mortar material at SEAL_TONE of its colour.
export const MORTAR_ALBEDO = [0.13, 0.128, 0.124];
export const SEAL_TONE = 0.42;

export { TRACK_OFFSET, RAIL_CENTER, TRACK_ZONE_HALF, EDGE_BAND_W };
