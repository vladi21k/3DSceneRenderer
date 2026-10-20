import { RNG } from '../../core/rng.js';
import { FaceShade } from './shade.js';
import { FACES } from './mesh.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { openingInfill } from './infill.js';
import { sideFrame } from './party.js';
import { slabBalconies } from './balcony.js';
import { acUnit } from './roof.js';
import { muralField } from './mural.js';

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
  // storey bands (a tower's string courses or exposed slab edges): under the floor lines
  // (balcony slabs sit on them), below the roof slab
  const bands = (up.bands || []).filter((k) => k > 0 && k < up.floors).map((k) => {
    const y1 = v0 + k * up.floorH - 0.02;
    return { y: y1 - (up.bandH || 0.22), h: up.bandH || 0.22, p: up.bandP || 0.05 };
  });
  const face = {
    width: W, openings: up.openings, courses: bands, balconies: up.balconies || [], cornice: { y: top }, groundAt: () => v0,
    floors: [...plan.floors, ...Array.from({ length: up.floors }, (_, k) => ({ index: plan.floors.length + k, y: v0 + k * up.floorH, h: up.floorH }))],
    // later additions mostly have white or light (aluminium) joinery, as do rendered towers
    style: { ...plan.style, surrounds: false, frameColor: RNG.from(lot.seed, 'upperFrame').pick(plaster ? ['white', 'white', 'lightgrey', 'cream', plan.style.frameColor] : ['white', 'lightgrey', plan.style.frameColor, plan.style.frameColor]) },
  };
  // render weathers (soot under the slab, streaks), as the stone does
  const unc = plaster ? 0.38 : 0;
  const fs = new FaceShade(face, col, lot.seed + 4241, { dirt: dirt * 0.9, uncleaned: unc, sillExt: 0.11, sillH: 0.06, damp: false, bleach: plaster ? 0.7 : 0 });
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
  // the front's bands turn the corners (their ends cover the sides' bands)
  if (bands.length) storeyBands(B, sTrim, bands, fs, up.sides ? -bands[0].p : 0, up.sides ? W + bands[0].p : W, null);
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
      // (the mural's side: the windows the painting is worked round, see facadePlan tower)
      const m = up.mural && up.mural.e === e ? up.mural : null;
      const ops = m && m.windows ? [...up.sides[e], ...m.windows] : up.sides[e];
      const sface = { ...face, width: D, openings: ops, balconies: [], courses: bands };
      const sfs = new FaceShade(sface, col.map((c) => c * 0.97), lot.seed + 4241 + 31 * (e + 1), { dirt: dirt * 0.95, uncleaned: unc, sillExt: 0.11, sillH: 0.06, damp: false, bleach: plaster ? 0.7 : 0 });
      const sctx = { ...ctx, fs: sfs };
      B.frameFromLot(fr);
      B.setUV(1, 7.3 * e, 1, 0);
      const holes = m ? [...ops, { uc: (m.u0 + m.u1) / 2, w: m.u1 - m.u0, y: m.v0, h: m.v1 - m.v0, top: 'flat', rise: 0, spring: m.v1 }] : ops;
      yield* wallField(sctx, sface, holes);
      B.setUV();
      B.frameFromLot(fr);
      if (m) { yield* muralField(sctx, sface, m, m.k); B.frameFromLot(fr); }
      if (bands.length) storeyBands(B, sTrim, bands, sfs, 0, D, m);
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

/**
 * Storey bands of a face from a0 to a1 along it (the front's reach past its ends to wrap
 * the corners), broken round the painted rectangle m; shaded like the face's dressing (a
 * darker soffit, a lit, dust-catching top).
 */
function storeyBands(B, s, bands, fs, a0, a1, m) {
  B.run = null;
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); const c = nv < -0.5 ? 0.68 : nv > 0.5 ? 0.98 : 1.06; out[0] *= c; out[1] *= c; out[2] *= c; if (nv > 0.5) out[3] = Math.min(1.6, out[3] + 0.25); };
  for (const b of bands) {
    let segs = [[a0, a1]];
    if (m && b.y + b.h > m.v0 - 0.1 && b.y < m.v1 + 0.1) {
      segs = [[a0, Math.min(a1, m.u0 - 0.06)], [Math.max(a0, m.u1 + 0.06), a1]].filter(([a, c]) => c - a > 0.3);
    }
    for (const [a, c] of segs) B.box(s, a, c, b.y, b.y + b.h, 0, b.p, FACES.FRONT | FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
  }
  B.shade = null;
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
