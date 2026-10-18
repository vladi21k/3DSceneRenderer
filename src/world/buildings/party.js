import { RNG } from '../../core/rng.js';
import { FaceShade } from './shade.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { openingInfill } from './infill.js';
import { plainOrnament } from './upper.js';
import { MURALS } from './mural.js';

// Exposed side (party) walls: where a neighbour is lower, set back or missing, the side
// of the building shows. These were never meant to be seen: plainer walling (coursed
// ashlar, squared rubble or patched render), a few small stair and bathroom windows,
// a downpipe, and the soot and rain wash of a wall that was never cleaned. Large ones
// (the long lens sees those facing back down the street end-on at every bend) are
// often rendered with a regular grid of windows, or carry a big painted mural.
//
// Each exposed rectangle of a side wall becomes a small facade of its own (frame on the
// side wall, u along it, w out of it), so the regular wall, opening and infill
// generators build it: real openings with reveals, glazing and frames.

/**
 * Side-wall facade frame for the strip w ∈ [w0, w1] (main frame, w1 nearer the street)
 * at end e (0: u = 0 side, facing −u; 1: u = W side, facing +u).
 */
export function sideFrame(f, W, e, w0, w1) {
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
    let finish = rng.weighted([['ashlar', 0.5], ['rough', 0.3], ['plaster', 0.2]]);
    // the side wall facing back down the street (towards the oncoming tram) is the one
    // the long lens sees end-on at a bend: larger ones are often rendered with a grid of
    // windows, or carry a big painted mural, as in the photographs
    const facing = !lot.sideStreet && (lot.side < 0) === (e === 0);
    const tr = RNG.from(lot.seed, 'partyBig', e);
    const treat = tr.weighted(facing ? [['mural', 0.12], ['windows', 0.5], ['plain', 0.38]] : [['mural', 0.03], ['windows', 0.4], ['plain', 0.57]]);
    let col = null;
    for (const [w0, w1, v0, v1] of rects[e]) {
      if (w1 - w0 < 0.05 || v1 - v0 < 0.05) continue;
      const width = w1 - w0;
      const big = width > 7 && v1 - v0 > 7.5;
      const mode = big ? treat : 'plain';
      if (mode !== 'plain' && !col) {
        // render (or the front's stone, for a windowed wall half the time)
        if (mode === 'mural' || tr.chance(0.6)) finish = 'plaster';
        col = finish === 'plaster' ? tr.pick([[1.08, 1.05, 0.97], [1.3, 1.02, 0.56], [1.06, 1.07, 1.1], [1.28, 1.1, 0.78]]).map((c) => c * tr.range(0.94, 1.02)) : null;
      }
      const sWall = finish === 'rough' ? sinks.rough : finish === 'plaster' ? sinks.paint : sinks.ashlar;
      // render is a little lighter and warmer than the stone, patched in places
      const wcol = finish === 'plaster' ? (col || tint.map((c, i) => c * [1.05, 1.03, 0.98][i])) : tint.map((c) => c * 0.95);
      const dressed = width > 2.2 && v1 - v0 > 2.6;
      const openings = [];
      let mural = null;
      if (mode === 'mural') {
        const m0 = Math.max(v0 + 1.2, plan.floors[1] ? plan.floors[1].y : v0 + 1.2);
        mural = { u0: tr.range(0.5, 1.2), u1: width - tr.range(0.5, 1.2), v0: m0, v1: v1 - tr.range(0.8, 1.6), k: tr.int(0, MURALS - 1) };
        if (mural.v1 - mural.v0 < 5) mural = null;
      }
      if (mode === 'windows') {
        // a regular grid: a window per bay and storey, some shuttered
        const nb = Math.max(1, Math.floor((width - 1.4) / 3.0)), bw = (width - 1.4) / nb;
        const ww = Math.min(bw - 0.9, tr.range(1.0, 1.35)), wh = tr.range(1.3, 1.5);
        for (const fl of plan.floors) {
          if (fl.index === 0) continue;
          const y = fl.y + tr.range(0.85, 0.95);
          if (y < v0 + 0.5 || y + wh > v1 - 0.5) continue;
          for (let b = 0; b < nb; b++) {
            const uc = 0.7 + bw * (b + 0.5), hs = tr.next();
            openings.push({ id: `${lot.id}:p${e}f${fl.index}b${b}`, floor: fl.index, uc, w: ww, y, h: wh, top: 'flat', rise: 0, spring: y + wh, kind: 'window', recess: 0.15,
              shutters: hs < 0.25 ? 'roller' : hs < 0.35 ? 'closed' : 'none', roller: tr.range(0.3, 1), lit: tr.next(), curtain: tr.chance(0.4) });
          }
        }
      } else if (dressed && !mural) {
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
      // windows let into a rendered side wall later on: mostly white or light joinery
      const frameColor = mode === 'windows' && finish === 'plaster' ? RNG.from(lot.seed, 'partyFrame', e).pick(['white', 'white', 'lightgrey', 'cream', plan.style.frameColor]) : plan.style.frameColor;
      const face = { width, openings, courses: [], balconies: [], cornice: { y: v1 }, groundAt: () => gMin, floors: plan.floors, style: { ...plan.style, surrounds: false, frameColor } };
      const fs = new FaceShade(face, wcol, lot.seed + 7919 * (e + 1), { dirt: orn.dirt * 1.15, uncleaned: finish === 'plaster' ? (mode === 'plain' ? 0.4 : 0.32) : 0.6, sillExt: 0.13, sillH: 0.06 });
      if (openings.length) {
        if (!sinks.glass) sinks.glass = B.sink('glass');
        if (!sinks.frame) sinks.frame = B.sink('plaster');   // painted joinery
      }
      const ctx = {
        B, sinks: { ...sinks, ashlar: sWall, smooth: finish === 'plaster' ? sWall : sinks.smooth, detail: finish === 'plaster' ? sWall : sinks.detail, rough: null }, q, fs, orn: plainOrnament(orn),
        vBottom: v0, vTop: v1, rustic: null, sillExt: 0.13, ch: 0, fit: null,
      };
      const fr = sideFrame(f, W, e, w0, w1);
      B.frameFromLot(fr);
      // texture: ashlar courses continue those of the front; rubble and render unaligned
      if (finish === 'ashlar') B.setUV(uvA[0], rng.range(0, 20), uvA[2], uvA[3]);
      else B.setUV(1, rng.range(0, 20), 1, 0);
      const keep = sWall.uvx;
      sWall.uvx = null;
      const holes = mural ? [...openings, { uc: (mural.u0 + mural.u1) / 2, w: mural.u1 - mural.u0, y: mural.v0, h: mural.v1 - mural.v0, top: 'flat', rise: 0, spring: mural.v1 }] : openings;
      yield* wallField({ ...ctx, q: { ...q, gridU: q.lod ? 3 : 1.8 } }, face, holes);
      sWall.uvx = keep;
      B.setUV();
      B.frameFromLot(fr);
      if (mural) {
        const sm = B.sink(`mural${mural.k}`);
        B.shade = null; B.flat = [1, 1, 1];
        sm.reserve(4, 6);
        const a = B.v(sm, mural.u0, mural.v0, 0, 0, 0, 1, 0, 0), b = B.v(sm, mural.u1, mural.v0, 0, 0, 0, 1, 1, 0);
        const c = B.v(sm, mural.u1, mural.v1, 0, 0, 0, 1, 1, 1), d = B.v(sm, mural.u0, mural.v1, 0, 0, 0, 1, 0, 1);
        B.quadIdx(sm, a, b, c, d);
      }
      const irng = RNG.from(lot.seed, 'partyInfill', e);
      const ictx = { ...ctx, rollerCol: col ? [0.62, 0.6, 0.55] : undefined };
      for (let i = 0; i < openings.length; i++) {
        openingMasonry(ictx, face, openings[i]);
        openingInfill(ictx, face, openings[i], irng);
        if (i % 3 === 2) { yield; B.frameFromLot(fr); }
      }
      // a rainwater downpipe down the dressed strips, with its brackets
      if (dressed && rng.chance(0.55)) {
        const pu = mural ? Math.max(0.2, mural.u0 - 0.3) : rng.range(0.35, Math.min(1.2, width - 0.35));
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
