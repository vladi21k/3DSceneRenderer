import { RNG } from '../../core/rng.js';
import { FaceShade } from './shade.js';
import { FACES } from './mesh.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { openingInfill } from './infill.js';
import { sideFrame } from './party.js';
import { slabBalconies } from './balcony.js';
import { acUnit } from './roof.js';

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
    width: W, openings: up.openings, courses: [], balconies: up.balconies || [], cornice: { y: top }, groundAt: () => v0,
    floors: [...plan.floors, ...Array.from({ length: up.floors }, (_, k) => ({ index: plan.floors.length + k, y: v0 + k * up.floorH, h: up.floorH }))],
    // later additions mostly have white or light (aluminium) joinery, as do rendered towers
    style: { ...plan.style, surrounds: false, frameColor: RNG.from(lot.seed, 'upperFrame').pick(plaster ? ['white', 'white', 'lightgrey', 'cream', plan.style.frameColor] : ['white', 'lightgrey', plan.style.frameColor, plan.style.frameColor]) },
  };
  // render weathers (soot under the slab, streaks), as the stone does
  const unc = plaster ? 0.38 : 0;
  const fs = new FaceShade(face, col, lot.seed + 4241, { dirt: dirt * 0.9, uncleaned: unc, sillExt: 0.11, sillH: 0.06 });
  if (!sinks.glass) sinks.glass = B.sink('glass');
  if (!sinks.frame) sinks.frame = B.sink('plaster');   // painted joinery
  const ctx = {
    B, sinks: { ...sinks, ashlar: sWall, smooth: sTrim, detail: sTrim, rough: null }, q, fs, orn: plainOrnament(orn),
    vBottom: v0 - 0.02, vTop: top, rustic: null, sillExt: 0.11, ch: 0, fit: null, rollerCol: [0.62, 0.6, 0.55],
  };
  B.frameFromLot(up.frame);
  B.setUV();
  yield* wallField(ctx, face, up.openings);
  B.frameFromLot(up.frame);
  const irng = RNG.from(lot.seed, 'upper');
  for (let i = 0; i < up.openings.length; i++) {
    openingMasonry(ctx, face, up.openings[i]);
    openingInfill(ctx, face, up.openings[i], irng);
    acUnder(B, ctx.sinks, up.openings[i], q, lot.seed, i);
    if (i % 3 === 2) { yield; B.frameFromLot(up.frame); }
  }
  yield;
  B.frameFromLot(up.frame);
  if (face.balconies.length) { yield* slabBalconies(B, ctx.sinks, face.balconies, fs, lot.seed + 17, q, up.frame); B.frameFromLot(up.frame); }
  // sides and back (plain walls, shaded like the front's field); a tower's sides have
  // windows, or a painted mural on the side facing back down the street
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u - w * 0.37, v, out); out[0] *= 0.96; out[1] *= 0.96; out[2] *= 0.96; };
  if (!up.sides) {
    B.gridU(sWall, 0, v0 - 0.02, top, -D, 0, -1, 2);
    B.gridU(sWall, W, v0 - 0.02, top, -D, 0, 1, 2);
  }
  B.rectW(sWall, 0, W, v0 - 0.02, top, -D, -1);
  if (up.sides) {
    for (const e of [0, 1]) {
      const fr = sideFrame(up.frame, W, e, -D, 0);
      const ops = up.sides[e], m = up.mural && up.mural.e === e ? up.mural : null;
      const sface = { ...face, width: D, openings: ops, balconies: [] };
      const sfs = new FaceShade(sface, col.map((c) => c * 0.97), lot.seed + 4241 + 31 * (e + 1), { dirt: dirt * 0.95, uncleaned: unc, sillExt: 0.11, sillH: 0.06 });
      const sctx = { ...ctx, fs: sfs };
      B.frameFromLot(fr);
      B.setUV(1, 7.3 * e, 1, 0);
      const holes = m ? [...ops, { uc: (m.u0 + m.u1) / 2, w: m.u1 - m.u0, y: m.v0, h: m.v1 - m.v0, top: 'flat', rise: 0, spring: m.v1 }] : ops;
      yield* wallField(sctx, sface, holes);
      B.setUV();
      B.frameFromLot(fr);
      if (m) {
        const sm = B.sink(`mural${m.k}`);
        B.shade = null; B.flat = [1, 1, 1];
        sm.reserve(4, 6);
        const a = B.v(sm, m.u0, m.v0, 0, 0, 0, 1, 0, 0), b = B.v(sm, m.u1, m.v0, 0, 0, 0, 1, 1, 0);
        const c = B.v(sm, m.u1, m.v1, 0, 0, 0, 1, 1, 1), d = B.v(sm, m.u0, m.v1, 0, 0, 0, 1, 0, 1);
        B.quadIdx(sm, a, b, c, d);
      }
      const srng = RNG.from(lot.seed, 'upperSide', e);
      for (let i = 0; i < ops.length; i++) {
        openingMasonry(sctx, sface, ops[i]);
        openingInfill(sctx, sface, ops[i], srng);
        acUnder(B, sctx.sinks, ops[i], q, lot.seed + e + 1, i);
        if (i % 4 === 3) { yield; B.frameFromLot(fr); }
      }
      yield;
    }
    B.frameFromLot(up.frame);
  }
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

/** Split AC unit hung under a window (o.ac), to one side of it. */
function acUnder(B, sinks, o, q, seed, i) {
  if (!o.ac || o.kind !== 'window') return;
  const r = RNG.from(seed, 'uac', i);
  B.shade = null;
  B.enter(o.uc + (r.chance(0.5) ? -0.3 : 0.3), o.y - 0.95, 0.17, 0);
  acUnit(B, { paint: sinks.paint, metal: sinks.metal || sinks.paint }, q, r);
  B.popFrame();
}
