import { RNG } from '../../core/rng.js';
import { FACES } from './mesh.js';
import { hash3 } from './shade.js';

// Taller post-war blocks standing well behind the street frontage (8–14 storeys), so
// the skyline down the street is not one even cornice line: where the street bends or
// a frontage building is low, their upper floors show above the roofs, as in the
// photographs; some close the vista of a long straight or of a side street. Seen only
// from far away, they are simple and cheap: stone-clad or rendered boxes with a regular
// grid of windows (sills, roller shutters, AC units; lit at random at night), a few
// solid-parapet balconies, a darker shop band, a roof with a lift room, tanks and a mast.

/**
 * Slab description in its own facade frame (same conventions as a lot frame: u along
 * the front, v up from the base, w out of the front towards the street). floors: [min,
 * max] storeys above the shop floor.
 */
export function makeSlab(id, frame, rng, floorsRange = [8, 14]) {
  const floors = rng.int(floorsRange[0], floorsRange[1]);
  return {
    id, frame, slab: true,
    W: frame.width, D: rng.range(12, 17), floors, floorH: rng.range(2.95, 3.2), groundH: rng.range(3.8, 4.6),
    stone: rng.chance(0.6),
    tint: rng.pick([[1.0, 0.98, 0.93], [0.96, 0.95, 0.93], [1.02, 0.97, 0.88], [0.9, 0.89, 0.87]]).map((c) => c * rng.range(0.92, 1.04)),
    bayW: rng.range(2.6, 3.4), winW: rng.range(1.3, 1.9), winH: rng.range(1.35, 1.6),
    balcony: rng.chance(0.35), seed: (rng.next() * 1e9) | 0,
  };
}

// roller shutter colours (one per block): beige, grey, white, brown
const SHUTTERS = [[0.62, 0.58, 0.5], [0.5, 0.5, 0.48], [0.7, 0.7, 0.68], [0.36, 0.27, 0.2]];

/** Generate one slab into B (generator: yields between faces). */
export function* slabSteps(B, sl, q) {
  B.begin();
  const sWall = sl.stone ? B.sink('ashlar') : B.sink('plaster');
  const sGlass = B.sink('glass'), sDark = B.sink('plaster');
  const H = sl.groundH + sl.floors * sl.floorH;
  const W = sl.W, D = sl.D, t = sl.tint;
  B.frameFromLot(sl.frame);
  B.setUV(1, (sl.seed % 97) * 0.37, 1, 0);
  // the box (down below the paving to sit on any slope)
  B.flat = t;
  B.rectW(sWall, 0, W, -2, H, 0, 1);
  B.rectW(sWall, 0, W, -2, H, -D, -1);
  B.flat = t.map((c) => c * 0.94);
  B.rectU(sWall, 0, -2, H, -D, 0, -1);
  B.rectU(sWall, W, -2, H, -D, 0, 1);
  B.setUV();
  yield;
  // windows on a regular grid, front and sides: dark panes (some roller shutters part
  // or all the way down), a projecting sill and, near, a lintel; split AC units under a
  // few; on the front, solid-parapet balconies at random bays. Face-local placement:
  // a along the face, o out of it.
  const rect = [
    (s, a0, a1, v0, v1, o) => B.rectW(s, a0, a1, v0, v1, o, 1),
    (s, a0, a1, v0, v1, o) => B.rectU(s, W + o, v0, v1, -a1, -a0, 1),
    (s, a0, a1, v0, v1, o) => B.rectU(s, -o, v0, v1, -D + a0, -D + a1, -1),
  ];
  const box = [
    (s, a0, a1, v0, v1, o0, o1, ends = true) => B.box(s, a0, a1, v0, v1, o0, o1, FACES.FRONT | FACES.TOP | FACES.BOTTOM | (ends ? FACES.LEFT | FACES.RIGHT : 0)),
    (s, a0, a1, v0, v1, o0, o1, ends = true) => B.box(s, W + o0, W + o1, v0, v1, -a1, -a0, FACES.RIGHT | FACES.TOP | FACES.BOTTOM | (ends ? FACES.FRONT | FACES.BACK : 0)),
    (s, a0, a1, v0, v1, o0, o1, ends = true) => B.box(s, -o1, -o0, v0, v1, -D + a0, -D + a1, FACES.LEFT | FACES.TOP | FACES.BOTTOM | (ends ? FACES.FRONT | FACES.BACK : 0)),
  ];
  // sills and lintels: the thin dressing batch (no shadows in the coarse cascades);
  // AC units: no shadows at all
  const sTrim = B.sink('smoothD'), sUnit = B.sink('dark');
  const shutter = SHUTTERS[sl.seed % SHUTTERS.length];
  const sill = t.map((c) => c * 1.06);
  [W, D, D].forEach((len, fi) => {
    const nb = Math.max(1, Math.floor((len - 1.2) / sl.bayW));
    const bw = (len - 1.2) / nb, hw = sl.winW / 2, wh = sl.winH;
    for (let f = 0; f < sl.floors; f++) {
      const fy = sl.groundH + f * sl.floorH, y = fy + 0.9;
      for (let b = 0; b < nb; b++) {
        const k = f * 131 + b, x = 0.6 + bw * (b + 0.5);
        const lit = hash3(k, fi, sl.seed) < 0.3, sh = hash3(k, fi + 11, sl.seed), ex = hash3(k, fi + 23, sl.seed);
        // shutter down to `cut` (from the head): all the way, part way or not at all
        const cut = sh < 0.16 ? y : sh < 0.36 ? y + wh * (0.3 + 0.6 * hash3(k, fi + 37, sl.seed)) : y + wh;
        B.grime = lit ? 0.75 : 0;
        B.flat = [1, 1, 1];
        if (cut > y + 0.05) rect[fi](sGlass, x - hw, x + hw, y, cut, 0.012);
        B.grime = 0;
        if (cut < y + wh - 0.05) { B.flat = shutter; rect[fi](sDark, x - hw, x + hw, cut, y + wh, 0.016); }
        B.flat = sill;
        box[fi](sTrim, x - hw - 0.06, x + hw + 0.06, y - 0.07, y, 0, 0.07, false);
        if (!q.lod) box[fi](sTrim, x - hw - 0.04, x + hw + 0.04, y + wh, y + wh + 0.14, 0, 0.025, false);
        if (ex < 0.1) { B.flat = [0.84, 0.84, 0.82]; box[fi](sUnit, x - 0.42, x + 0.42, y - 0.75, y - 0.15, 0.02, 0.32); }
        else if (fi === 0 && f > 0 && !sl.balcony && ex > 0.82) {
          B.flat = t.map((c) => c * 0.98);
          box[0](sWall, x - hw - 0.45, x + hw + 0.45, fy - 0.15, fy + 1.0, 0, 1.15);
        }
      }
    }
  });
  B.grime = 0;
  // shop band, and a thin projecting slab edge at each floor of balconied fronts
  B.flat = [0.16, 0.16, 0.17];
  B.rectW(sDark, 0.4, W - 0.4, 0.2, sl.groundH - 0.6, 0.02, 1);
  if (sl.balcony && q.lod === 0) {
    B.flat = t.map((c) => c * 1.03);
    for (let f = 1; f < sl.floors; f++) B.box(sWall, 0.6, W - 0.6, sl.groundH + f * sl.floorH - 0.12, sl.groundH + f * sl.floorH + 0.06, 0, 0.9, FACES.FRONT | FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
  }
  yield;
  // roof: screed, parapet band, lift room, tanks, a mast
  B.flat = [0.38, 0.37, 0.36];
  B.rectV(sDark, 0, W, -D, 0, H + 0.01, 1);
  B.flat = t;
  B.box(sWall, 0, W, H, H + 0.9, -0.25, 0, FACES.FRONT | FACES.TOP | FACES.LEFT | FACES.RIGHT);
  B.box(sWall, 0, W, H, H + 0.9, -D, -D + 0.25, FACES.BACK | FACES.TOP | FACES.LEFT | FACES.RIGHT);
  const r = RNG.from(sl.seed, 'roof');
  const lu = r.range(0.25, 0.6) * W, lw = -r.range(0.35, 0.65) * D;
  B.box(sWall, lu - 1.6, lu + 1.6, H, H + 3.2, lw - 2.2, lw + 2.2, FACES.ALL & ~FACES.BOTTOM);
  B.flat = [0.82, 0.82, 0.8];
  for (let i = 0; i < r.int(2, 5); i++) B.cylinderV(sDark, r.range(1.5, W - 1.5), -r.range(1.5, D - 1.5), H, H + r.range(1.2, 1.8), r.range(0.5, 0.75), 10, true);
  B.flat = [0.6, 0.6, 0.6];
  const mu = r.range(1, W - 1), mw = -r.range(1, D - 1), mh = r.range(3, 6);
  B.box(sDark, mu - 0.04, mu + 0.04, H, H + mh, mw - 0.04, mw + 0.04, FACES.SIDES | FACES.FRONT | FACES.BACK);
  B.flat = [1, 1, 1];
}
