import { RNG } from '../../core/rng.js';
import { FACES, glassTone } from './mesh.js';
import { hash3, slabRun } from './shade.js';
import { acUnit } from './roof.js';

// Plain modern cantilevered balconies (taller blocks behind the street, set-back
// additions on the roofs): a concrete slab in the wall's finish with a darker soffit and a
// drip groove near its front edge, and a parapet:
//   solid   a rendered or stone-faced upstand in the wall's finish under a coping, its
//           front soiled by the water the coping sheds (streaks from its ends, see
//           grime.js); on some a steel handrail on posts above a lower upstand
//   railing slender steel bars (far: a see-through dark band)
//   glass   panes in a steel shoe with a steel top rail

const STEEL = [0.16, 0.16, 0.16];
// what shows through a balcony's glass: the balcony floor and the wall behind, in shade
const BEHIND = glassTone([0.2, 0.19, 0.17]);

/**
 * Cantilevered balconies of a facade face (list of {u0, u1, y (top of the slab), depth,
 * slabT, solid, floor}): the slab, its parapet (solid, steel railing or glass, see
 * above), a split AC unit on some. Yields every few balconies (the frame `fr` is restored
 * after each yield).
 */
export function* slabBalconies(B, sinks, list, fs, seed, q, fr) {
  const sW = sinks.ashlar === sinks.paint ? sinks.paint : sinks.detail;
  let n = 0;
  for (const b of list) {
    if (n++ % 5 === 4) { yield; B.frameFromLot(fr); }
    const { u0, u1, y, depth: d, slabT: t } = b;
    // one choice per building and floor band: the parapets of a block mostly agree, a few
    // were refitted later
    const hb = hash3(seed & 0xffff, 0x51ab, seed >>> 16), hk = hash3(b.u0 * 13 | 0, b.floor * 7 + 3, seed);
    const kind = b.solid ? (hb < 0.3 || hk < 0.08 ? 'rail' : 'solid') : (hb > 0.75 || hk > 0.92 ? 'glass' : 'bars');
    // slab: soffit in its own shade, the front edge soiled (water runs off it)
    B.shade = (u, v, w, nu, nv, nw, out) => {
      fs.wall(u, v, out);
      const s = nv < -0.5 ? 0.66 : nw > 0.5 ? 0.92 : 1.0;
      out[0] *= s; out[1] *= s; out[2] *= s;
      if (nw > 0.5 || nv < -0.5) out[3] = Math.min(1.6, out[3] + 0.4);
    };
    B.box(sW, u0, u1, y - t, y, 0, d, FACES.FRONT | FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
    if (q.lod === 0) {
      // drip groove: a shadowed slot under the soffit 4 cm behind the front edge
      B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); out[0] *= 0.3; out[1] *= 0.3; out[2] *= 0.3; };
      B.rectV(sW, u0 + 0.04, u1 - 0.04, d - 0.065, d - 0.04, y - t - 0.002, -1);
    }
    if (kind === 'solid' || kind === 'rail') {
      const ph = kind === 'rail' ? 0.78 : 1.0, th = 0.1, cop = 0.045;
      // the upstand: its faces shaded like the wall, the front streaked by the coping's
      // run-off (an occluder line under the coping, ends at the balcony's corners)
      B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); const s = nw < -0.5 ? 0.9 : 1.0; out[0] *= s; out[1] *= s; out[2] *= s; };
      B.run = slabRun(u0, u1, y + ph - cop, 0.8 + 0.6 * hk);
      B.box(sW, u0, u1, y, y + ph - cop, d - th, d, FACES.FRONT | FACES.BACK | FACES.LEFT | FACES.RIGHT);
      B.run = null;
      B.box(sW, u0, u0 + th, y, y + ph - cop, 0, d - th, FACES.LEFT | FACES.RIGHT);
      B.box(sW, u1 - th, u1, y, y + ph - cop, 0, d - th, FACES.LEFT | FACES.RIGHT);
      // coping: overhangs the upstand by 2-3 cm, light on top, dark under its lip
      B.shade = (u, v, w, nu, nv, nw, out) => {
        fs.wall(u, v, out);
        const s = nv < -0.5 ? 0.62 : nv > 0.5 ? 1.02 : 1.06;
        out[0] *= s; out[1] *= s; out[2] *= s;
        if (nv > 0.5) out[3] = Math.min(1.6, out[3] + 0.3);
      };
      const o = 0.025;
      B.box(sW, u0 - o, u1 + o, y + ph - cop, y + ph, d - th - o, d + o, FACES.ALL & ~FACES.BACK);
      B.box(sW, u0 - o, u0 + th + o, y + ph - cop, y + ph, 0, d - th - o, FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
      B.box(sW, u1 - th - o, u1 + o, y + ph - cop, y + ph, 0, d - th - o, FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
      if (kind === 'rail') {
        // a steel handrail on posts above the upstand
        B.shade = null;
        B.flat = STEEL;
        const sM = sinks.paint, top = y + 1.05, wr = d - th / 2;
        B.box(sM, u0, u1, top - 0.04, top, wr - 0.025, wr + 0.025, FACES.FRONT | FACES.BACK | FACES.TOP | FACES.BOTTOM);
        for (const ue of [u0 + th / 2, u1 - th / 2]) B.box(sM, ue - 0.025, ue + 0.025, top - 0.04, top, 0.05, wr - 0.025, FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
        const np = Math.max(1, Math.round((u1 - u0) / 1.3));
        for (let k = 0; k <= np; k++) {
          const u = u0 + 0.06 + ((u1 - u0 - 0.12) * k) / np;
          B.box(sM, u - 0.018, u + 0.018, y + ph, top - 0.04, wr - 0.018, wr + 0.018, q.lod ? FACES.FRONT : FACES.FRONT | FACES.LEFT | FACES.RIGHT);
        }
      }
    } else if (kind === 'glass' && sinks.glass) {
      // glass panes in a steel shoe on the slab, a steel top rail, joints every ~1.2 m
      const sM = sinks.paint, h = 1.02, wg = d - 0.06;
      B.shade = null;
      B.flat = BEHIND;
      B.rectW(sinks.glass, u0 + 0.03, u1 - 0.03, y + 0.07, y + h - 0.05, wg, 1);
      for (const ue of [u0 + 0.03, u1 - 0.03]) B.rectU(sinks.glass, ue, y + 0.07, y + h - 0.05, 0.06, wg, ue < (u0 + u1) / 2 ? -1 : 1);
      B.flat = STEEL;
      B.box(sM, u0, u1, y, y + 0.08, wg - 0.03, wg + 0.03, FACES.FRONT | FACES.TOP | FACES.LEFT | FACES.RIGHT);
      B.box(sM, u0, u1, y + h - 0.05, y + h, wg - 0.025, wg + 0.025, FACES.FRONT | FACES.BACK | FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
      if (q.lod === 0) {
        const nj = Math.max(1, Math.round((u1 - u0) / 1.2));
        for (let k = 1; k < nj; k++) { const u = u0 + ((u1 - u0) * k) / nj; B.box(sM, u - 0.012, u + 0.012, y + 0.08, y + h - 0.05, wg - 0.012, wg + 0.012, FACES.FRONT); }
      }
    } else {
      B.shade = null;
      B.flat = STEEL;
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
  B.run = null;
  B.flat = [1, 1, 1];
}
