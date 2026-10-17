import { RNG } from '../../core/rng.js';
import { FaceShade } from './shade.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { openingInfill } from './infill.js';
import { plainOrnament } from './upper.js';

// Exposed side (party) walls: where a neighbour is lower, set back or missing, the side
// of the building shows. These were never meant to be seen: plainer walling (coursed
// ashlar, squared rubble or patched render), a few small stair and bathroom windows,
// a downpipe, and the soot and rain wash of a wall that was never cleaned.
//
// Each exposed rectangle of a side wall becomes a small facade of its own (frame on the
// side wall, u along it, w out of it), so the regular wall, opening and infill
// generators build it: real openings with reveals, glazing and frames.

/**
 * Side-wall facade frame for the strip w ∈ [w0, w1] (main frame, w1 nearer the street)
 * at end e (0: u = 0 side, facing −u; 1: u = W side, facing +u).
 */
function sideFrame(f, W, e, w0, w1) {
  const origin = f.origin.clone();
  if (e) origin.addScaledVector(f.uDir, W).addScaledVector(f.nDir, w1);
  else origin.addScaledVector(f.nDir, w0);
  const uDir = e ? f.nDir.clone().negate() : f.nDir.clone();
  const nDir = e ? f.uDir.clone() : f.uDir.clone().negate();
  return { origin, uDir, nDir };
}

/**
 * Generate the exposed parts of both side walls. rects[e]: [[w0, w1, v0, v1], ...] in
 * the main frame. Small strips are plain walling; larger ones are dressed.
 */
export function* partyWalls(B, sinks, lot, plan, orn, tint, q, rects, gMin, uvA) {
  const f = lot.frame, W = plan.width;
  for (const e of [0, 1]) {
    const rng = RNG.from(lot.seed, 'party', e);
    const finish = rng.weighted([['ashlar', 0.5], ['rough', 0.3], ['plaster', 0.2]]);
    const sWall = finish === 'rough' ? sinks.rough : finish === 'plaster' ? sinks.paint : sinks.ashlar;
    // render is a little lighter and warmer than the stone, patched in places
    const col = finish === 'plaster' ? tint.map((c, i) => c * [1.05, 1.03, 0.98][i]) : tint.map((c) => c * 0.95);
    for (const [w0, w1, v0, v1] of rects[e]) {
      if (w1 - w0 < 0.05 || v1 - v0 < 0.05) continue;
      const width = w1 - w0;
      const dressed = width > 2.2 && v1 - v0 > 2.6;
      const openings = [];
      if (dressed) {
        // small windows, one or two per storey, clear of the strip's edges
        for (const fl of plan.floors) {
          if (fl.index === 0) continue;
          const y = fl.y + rng.range(1.0, 1.25), h = rng.range(0.8, 1.05);
          if (y < v0 + 0.4 || y + h > v1 - 0.45) continue;
          const n = rng.weighted([[0, 0.3], [1, 0.5], [2, 0.2]]);
          const used = [];
          for (let k = 0; k < n; k++) {
            const w = rng.range(0.55, 0.75), uc = rng.range(0.9 + w / 2, width - 0.9 - w / 2);
            if (uc < 0.9 + w / 2 || used.some((x) => Math.abs(x - uc) < 1.6)) continue;
            used.push(uc);
            openings.push({ id: `${lot.id}:p${e}f${fl.index}k${k}`, floor: fl.index, uc, w, y, h, top: 'flat', rise: 0, spring: y + h, kind: 'window', recess: 0.12, shutters: null, lit: rng.next(), curtain: rng.chance(0.4) });
          }
        }
      }
      const face = { width, openings, courses: [], balconies: [], cornice: { y: v1 }, groundAt: () => gMin, floors: plan.floors, style: { ...plan.style, surrounds: false } };
      const fs = new FaceShade(face, col, lot.seed + 7919 * (e + 1), { dirt: orn.dirt * 1.15, uncleaned: finish === 'plaster' ? 0.35 : 0.6, sillExt: 0.13 });
      if (openings.length) {
        if (!sinks.glass) sinks.glass = B.sink('glass');
        if (!sinks.frame) sinks.frame = B.sink('frame');
      }
      const ctx = {
        B, sinks: { ...sinks, ashlar: sWall, smooth: sinks.smooth, rough: null }, q, fs, orn: plainOrnament(orn),
        vBottom: v0, vTop: v1, rustic: null, sillExt: 0.13, ch: 0, fit: null,
      };
      const fr = sideFrame(f, W, e, w0, w1);
      B.frameFromLot(fr);
      // texture: ashlar courses continue those of the front; rubble and render unaligned
      if (finish === 'ashlar') B.setUV(uvA[0], rng.range(0, 20), uvA[2], uvA[3]);
      else B.setUV(1, rng.range(0, 20), 1, 0);
      const keep = sWall.uvx;
      sWall.uvx = null;
      yield* wallField({ ...ctx, q: { ...q, gridU: q.lod ? 3 : 1.8 } }, face, openings);
      sWall.uvx = keep;
      B.setUV();
      B.frameFromLot(fr);
      const irng = RNG.from(lot.seed, 'partyInfill', e);
      for (let i = 0; i < openings.length; i++) {
        openingMasonry(ctx, face, openings[i]);
        openingInfill(ctx, face, openings[i], irng);
        if (i % 3 === 2) { yield; B.frameFromLot(fr); }
      }
      // a rainwater downpipe down the dressed strips, with its brackets
      if (dressed && rng.chance(0.55)) {
        const pu = rng.range(0.35, Math.min(1.2, width - 0.35));
        B.shade = null;
        B.flat = rng.chance(0.6) ? [0.32, 0.32, 0.31] : [0.62, 0.6, 0.56];
        B.cylinderV(sinks.paint, pu, 0.11, Math.max(v0, gMin), v1 - 0.1, 0.05, q.lod ? 6 : 10, false);
        if (!q.lod) for (let v = v0 + 1.5; v < v1 - 0.5; v += 2.2) B.box(sinks.paint, pu - 0.07, pu + 0.07, v, v + 0.04, 0, 0.17, 63);
        B.flat = [1, 1, 1];
      }
      yield;
    }
  }
  B.frameFromLot(f);
}
