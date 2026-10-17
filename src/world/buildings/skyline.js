import { RNG } from '../../core/rng.js';
import { FACES } from './mesh.js';
import { hash3 } from './shade.js';

// Taller post-war blocks standing well behind the street frontage (8–14 storeys), so
// the skyline down the street is not one even cornice line: where the street bends or
// a frontage building is low, their upper floors show above the roofs, as in the
// photographs. Seen only from far away, they are simple and cheap: stone-clad or
// rendered boxes with a regular grid of flush dark windows (lit at random at night),
// a darker shop band, a roof with a lift room, tanks and a mast.

/**
 * Slab description in its own facade frame (same conventions as a lot frame: u along
 * the front, v up from the base, w out of the front towards the street).
 */
export function makeSlab(id, frame, rng) {
  const floors = rng.int(8, 14);
  return {
    id, frame, slab: true,
    W: frame.width, D: rng.range(12, 17), floors, floorH: rng.range(2.95, 3.2), groundH: rng.range(3.8, 4.6),
    stone: rng.chance(0.6),
    tint: rng.pick([[1.0, 0.98, 0.93], [0.96, 0.95, 0.93], [1.02, 0.97, 0.88], [0.9, 0.89, 0.87]]).map((c) => c * rng.range(0.92, 1.04)),
    bayW: rng.range(2.6, 3.4), winW: rng.range(1.3, 1.9), winH: rng.range(1.35, 1.6),
    balcony: rng.chance(0.35), seed: (rng.next() * 1e9) | 0,
  };
}

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
  // windows: flush dark panes on a regular grid, front and sides
  const faces = [
    { len: W, at: (x, y, w0, w1) => B.rectW(sGlass, x - w0, x + w0, y, y + w1, 0.012, 1) },
    { len: D, at: (x, y, w0, w1) => B.rectU(sGlass, W + 0.012, y, y + w1, -x - w0, -x + w0, 1) },
    { len: D, at: (x, y, w0, w1) => B.rectU(sGlass, -0.012, y, y + w1, -D + x - w0, -D + x + w0, -1) },
  ];
  faces.forEach((F, fi) => {
    const nb = Math.max(1, Math.floor((F.len - 1.2) / sl.bayW));
    const bw = (F.len - 1.2) / nb;
    for (let f = 0; f < sl.floors; f++) {
      const y = sl.groundH + f * sl.floorH + 0.9;
      for (let b = 0; b < nb; b++) {
        const lit = hash3(f * 131 + b, fi, sl.seed) < 0.3;
        B.grime = lit ? 0.75 : 0;
        F.at(0.6 + bw * (b + 0.5), y, sl.winW / 2, sl.winH);
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
