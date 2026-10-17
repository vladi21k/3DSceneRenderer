import { RNG } from '../../core/rng.js';
import { FaceShade } from './shade.js';
import { FACES } from './mesh.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { openingInfill } from './infill.js';

// Set-back upper volume on a flat roof (plan.upper, see facadePlan massing): a
// penthouse storey behind its terrace, or a later addition of several storeys, in
// rendered plaster or plain ashlar. Front with real openings (reveals, dark interiors,
// glazing and frames: buildings dress these themselves), plain sides and back, a thin
// projecting roof slab, and a parapet-less flat roof.

/** Modern, unornamented dressing for openings (upper volumes, party walls). */
export function plainOrnament(orn) {
  return { ...orn, winHead: 'plain', shopHead: 'lintel', keystone: false, ears: false, apron: false, sillCorbels: false, doorSurround: false, doorHood: false, sillH: 0.06, sillP: 0.05 };
}

/**
 * Generate plan.upper of `lot` into B (a generator, yields between pieces). Returns
 * nothing; the volume's footprint for rooftop placement is upperFootprint(plan).
 */
export function* upperVolume(B, sinks, lot, plan, orn, tint, q, dirt) {
  const up = plan.upper;
  const W = up.width, D = up.depth, v0 = up.v0, top = v0 + up.floors * up.floorH;
  const plaster = up.material === 'plaster';
  const sWall = plaster ? sinks.paint : sinks.ashlar, sTrim = plaster ? sinks.paint : sinks.smooth;
  const col = plaster ? up.color.map((c) => c / 0.9) : tint;
  const face = {
    width: W, openings: up.openings, courses: [], balconies: [], cornice: { y: top }, groundAt: () => v0,
    floors: [...plan.floors, ...Array.from({ length: up.floors }, (_, k) => ({ index: plan.floors.length + k, y: v0 + k * up.floorH, h: up.floorH }))],
    style: { ...plan.style, surrounds: false },
  };
  const fs = new FaceShade(face, col, lot.seed + 4241, { dirt: dirt * 0.8, sillExt: 0.11, sillH: 0.06 });
  if (!sinks.glass) sinks.glass = B.sink('glass');
  if (!sinks.frame) sinks.frame = B.sink('frame');
  const ctx = {
    B, sinks: { ...sinks, ashlar: sWall, smooth: sTrim, rough: null }, q, fs, orn: plainOrnament(orn),
    vBottom: v0 - 0.02, vTop: top, rustic: null, sillExt: 0.11, ch: 0, fit: null,
  };
  B.frameFromLot(up.frame);
  B.setUV();
  yield* wallField(ctx, face, up.openings);
  B.frameFromLot(up.frame);
  const irng = RNG.from(lot.seed, 'upper');
  for (let i = 0; i < up.openings.length; i++) {
    openingMasonry(ctx, face, up.openings[i]);
    openingInfill(ctx, face, up.openings[i], irng);
    if (i % 3 === 2) { yield; B.frameFromLot(up.frame); }
  }
  yield;
  B.frameFromLot(up.frame);
  // sides and back (plain walls, shaded like the front's field)
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u - w * 0.37, v, out); out[0] *= 0.96; out[1] *= 0.96; out[2] *= 0.96; };
  B.gridU(sWall, 0, v0 - 0.02, top, -D, 0, -1, 2);
  B.gridU(sWall, W, v0 - 0.02, top, -D, 0, 1, 2);
  B.rectW(sWall, 0, W, v0 - 0.02, top, -D, -1);
  // roof slab: a thin projecting concrete-and-render slab with a drip edge
  const o = 0.3, t = 0.2;
  B.shade = null;
  B.flat = col.map((c) => c * 1.02);
  B.box(sTrim, -o, W + o, top, top + t, -D - o, o, FACES.FRONT | FACES.BACK | FACES.LEFT | FACES.RIGHT);
  B.flat = col.map((c) => c * 0.7);    // soffit, in the slab's own shadow
  B.rectV(sTrim, -o, W + o, -D - o, o, top, -1);
  // flat roof: grey screed
  B.flat = [0.4, 0.39, 0.38];
  B.rectV(sinks.dark, -o, W + o, -D - o, o, top + t, 1);
  B.flat = [1, 1, 1];
}

/** Footprint of plan.upper in the main facade frame: [u0, u1, w0 (back), w1 (front)], or null. */
export function upperFootprint(plan) {
  const up = plan.upper;
  return up ? [up.u0 - 0.3, up.u1 + 0.3, -up.setback - up.depth - 0.3, -up.setback + 0.3] : null;
}
