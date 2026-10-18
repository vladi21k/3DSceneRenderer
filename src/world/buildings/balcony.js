import { RNG } from '../../core/rng.js';
import { FACES } from './mesh.js';
import { hash3 } from './shade.js';
import { acUnit } from './roof.js';

// Plain modern cantilevered balconies (taller blocks behind the street, set-back
// additions on the roofs): concrete slab and solid parapet in the wall's finish, or a
// slender steel railing.

/**
 * Cantilevered balconies of a facade face (list of {u0, u1, y (top of the slab), depth,
 * slabT, solid, floor}): a slab in the wall's finish, a solid parapet or a steel
 * railing (far: a see-through dark band), a split AC unit on some. Yields every few
 * balconies (the frame `fr` is restored after each yield).
 */
export function* slabBalconies(B, sinks, list, fs, seed, q, fr) {
  const sW = sinks.ashlar === sinks.paint ? sinks.paint : sinks.detail;
  let n = 0;
  for (const b of list) {
    if (n++ % 5 === 4) { yield; B.frameFromLot(fr); }
    const { u0, u1, y, depth: d, slabT: t } = b;
    B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); const s = nv < -0.5 ? 0.72 : 1.0; out[0] *= s; out[1] *= s; out[2] *= s; };
    B.box(sW, u0, u1, y - t, y, 0, d, FACES.FRONT | FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
    if (b.solid) {
      const h = 1.0, th = 0.1;
      B.box(sW, u0, u1, y, y + h, d - th, d, FACES.FRONT | FACES.BACK | FACES.TOP | FACES.LEFT | FACES.RIGHT);
      B.box(sW, u0, u0 + th, y, y + h, 0, d - th, FACES.LEFT | FACES.RIGHT | FACES.TOP);
      B.box(sW, u1 - th, u1, y, y + h, 0, d - th, FACES.LEFT | FACES.RIGHT | FACES.TOP);
    } else {
      B.shade = null;
      const steel = [0.16, 0.16, 0.16];
      B.flat = steel;
      const h = 1.0, sM = sinks.paint;
      // top rail along the front and the sides, posts at the corners
      B.box(sM, u0, u1, y + h - 0.04, y + h, d - 0.05, d, FACES.FRONT | FACES.BACK | FACES.TOP | FACES.BOTTOM);
      B.box(sM, u0, u0 + 0.05, y + h - 0.04, y + h, 0, d - 0.05, FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
      B.box(sM, u1 - 0.05, u1, y + h - 0.04, y + h, 0, d - 0.05, FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
      if (q.lod === 0) {
        for (let u = u0 + 0.06; u < u1 - 0.05; u += 0.13) B.box(sM, u, u + 0.018, y, y + h - 0.04, d - 0.04, d - 0.022, FACES.FRONT | FACES.LEFT | FACES.RIGHT);
        for (const ue of [u0 + 0.02, u1 - 0.035]) for (let w = 0.1; w < d - 0.06; w += 0.13) B.box(sM, ue, ue + 0.016, y, y + h - 0.04, w, w + 0.016, FACES.FRONT | FACES.LEFT | FACES.RIGHT | FACES.BACK);
      } else {
        // far: the bars and the gaps between them average to a dark, see-through band
        B.flat = [0.3, 0.29, 0.28];
        B.rectW(sM, u0, u1, y, y + h - 0.04, d - 0.03, 1);
      }
    }
    // a split AC unit or a water heater tank on some balconies
    if (hash3(b.u0 * 13 | 0, b.floor, seed) < 0.3) {
      B.shade = null;
      B.enter(u1 - 0.6, y, 0.25, 0);
      acUnit(B, { paint: sinks.paint, metal: sinks.metal }, q, RNG.from(seed, 'bac', b.floor, b.u0));
      B.popFrame();
    }
  }
  B.shade = null;
  B.flat = [1, 1, 1];
}
