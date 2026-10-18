import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { FACES } from './mesh.js';
import { FaceShade, hash3 } from './shade.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { openingInfill } from './infill.js';
import { plainOrnament } from './upper.js';
import { pitchedRoof, solarHeater, heaterRadius, sunYaw, waterTank, antenna, acUnit } from './roof.js';
import { MURALS, ADVERTS, ADVERT_ASPECT, advertPanel } from './mural.js';
import { slabBalconies } from './balcony.js';

// Taller post-war blocks standing behind the street frontage (7–14 storeys), so the
// skyline down the street is not one even cornice line: where the street bends or a
// frontage building is low, their upper floors show above the roofs, and some close the
// vista of the street or of a side street, as in the photographs. Built like the
// frontage, with the same wall, opening and infill generators: real openings with
// reveals, sills, lintels, painted frames and glazing on all four sides, roller or
// louvred shutters on many of them, split AC units, cantilevered balconies (stacked
// bays or continuous bands with solid parapets or steel railings) with the run-off
// streaks under their slabs, a shop floor with a concrete canopy, and a flat roof with
// a parapet, a lift room, solar water heaters and tanks, or a hipped tile roof.
//
// Finishes (one per block): limestone cladding, ochre / yellow, orange or rose render, the
// white render of the 1960s blocks or bare cement-grey render; weathered like the
// frontage (soot under the parapet, splash zone, streaks). String courses (stone bands,
// or the exposed slab edges of the rendered blocks) and a projecting roof slab mark the
// storeys and the top; about a third have a set-back top storey breaking the roofline.
// A few blocks closing the view carry a large painted mural on their street-facing
// gable, and about one in six a mural or a printed advert on the side that faces back
// down the street.

const CREAM = [0.86, 0.80, 0.68];
const STONE = [[0.86, 0.80, 0.68], [0.84, 0.74, 0.58], [0.86, 0.825, 0.765], [0.81, 0.78, 0.74], [0.87, 0.78, 0.62]];   // (facadePlan's tints)
// render colours as multipliers on the plaster albedo (≈ 0.66, 0.62, 0.54)
const RENDER = {
  ochre: [[1.3, 1.0, 0.52], [1.32, 1.08, 0.62], [1.26, 0.95, 0.5]],
  orange: [[1.36, 0.78, 0.42], [1.3, 0.72, 0.4]],
  rose: [[1.3, 0.88, 0.74], [1.28, 0.82, 0.66], [1.24, 0.9, 0.8]],
  white: [[1.07, 1.08, 1.11], [1.04, 1.05, 1.06], [1.06, 1.05, 1.01]],
  concrete: [[0.94, 0.94, 0.93], [0.88, 0.88, 0.86], [0.97, 0.95, 0.9]],
};
const ROLLER = [[0.62, 0.6, 0.55], [0.5, 0.5, 0.48], [0.7, 0.7, 0.68], [0.4, 0.33, 0.27]];

/**
 * Block description in its own facade frame (same conventions as a lot frame: u along
 * the front, v up from the base, w out of the front). floorsRange: [min, max] storeys
 * above the shop floor. opts: {finish ('stone' | 'ochre' | 'orange' | 'rose' | 'white' |
 * 'concrete'), D, mural, muralFace (0 front, 1 right, 2 back, 3 left), side (of the
 * street: the face looking back down it carries the sign slot)}.
 */
export function makeSlab(id, frame, rng, floorsRange = [8, 14], opts = {}) {
  const floors = rng.int(floorsRange[0], floorsRange[1]);
  const finish = opts.finish || rng.weighted([['stone', 0.42], ['ochre', 0.14], ['orange', 0.05], ['rose', 0.1], ['white', 0.19], ['concrete', 0.1]]);
  const stone = finish === 'stone', pale = finish === 'white' || finish === 'concrete';
  const t = stone ? rng.pick(STONE) : rng.pick(RENDER[finish]);
  const k = rng.range(0.94, 1.04);
  const color = stone ? t.map((c, i) => Math.pow(c / CREAM[i], 1.2) * k) : t.map((c) => c * k);
  const bayW = rng.range(2.6, 3.2);
  return {
    id, frame, slab: true, finish, color,
    W: frame.width, D: opts.D ?? rng.range(12, 17), floors, floorH: rng.range(3.0, 3.25), groundH: rng.range(3.9, 4.6),
    bayW, winW: Math.min(bayW - 1.0, rng.range(1.25, 1.7)), winH: rng.range(1.35, 1.6),
    // balconies: none, stacked in some bay columns, or continuous bands across the front
    balcony: rng.weighted([['none', 0.3], ['stack', 0.45], ['bands', 0.25]]),
    solid: rng.chance(0.55),                    // solid parapets (else steel railings)
    shutters: stone || pale ? (rng.chance(0.75) ? 'roller' : 'louvre') : (rng.chance(0.7) ? 'louvre' : 'roller'),
    roller: rng.pick(ROLLER),
    // (painted or aluminium joinery: mostly light, so the frames read from afar)
    frameColor: rng.pick(stone || pale ? ['white', 'white', 'lightgrey', 'grey', 'brown', 'cream'] : ['darkgreen', 'brown', 'white', 'teal', 'cream']),
    shutterColor: rng.pick(['darkgreen', 'brown', 'teal', 'grey', 'white']),
    canopy: rng.chance(0.6),
    roof: floors <= 8 && rng.chance(0.3) ? 'tile' : 'flat',
    dirt: rng.range(0.7, 1.3), uncleaned: stone ? (rng.chance(0.2) ? rng.range(0.3, 0.7) : 0) : rng.range(0.25, 0.55),
    mural: opts.mural ? { face: opts.muralFace ?? 0, k: rng.int(0, MURALS - 1), u0: rng.range(0.06, 0.16), u1: rng.range(0.84, 0.94), v0: rng.range(0.22, 0.32), v1: rng.range(0.86, 0.95) } : null,
    seed: (rng.next() * 1e9) | 0,
    ...dress(id, floors, finish, opts),
  };
}

/**
 * Storey and roofline dressing (own stream, so the draws above never shift): string
 * courses `bands` (floor indices: stone bands, or every slab edge of a rendered block),
 * the roof slab's projection, a set-back top storey `top` {u0, u1 (fractions of the
 * width), back (from the front), h}, and the sign slot `sign` {kind 'mural' | 'advert',
 * face, k, u0, u1, v0, v1 (fractions of the face)} on the face looking back down the street.
 */
function dress(id, floors, finish, opts) {
  const r = RNG.from(id, 'slabDress');
  const mid = Math.max(2, Math.round(floors / 2));
  const slabEdges = (finish === 'white' || finish === 'concrete') && r.chance(0.6);
  const bands = slabEdges ? Array.from({ length: floors }, (_, i) => i + 1) : r.chance(0.8) ? [1, mid, floors] : [1, floors];
  const top = floors >= 8 && r.chance(0.38) ? { u0: r.range(0.08, 0.25), u1: r.range(0.7, 0.92), back: r.range(2.2, 3.4), h: r.range(2.9, 3.2) } : null;
  let sign = null;
  if (opts.side && !opts.mural && r.chance(0.17)) {
    const advert = r.chance(0.6);
    sign = { kind: advert ? 'advert' : 'mural', face: opts.side > 0 ? 1 : 3, k: r.int(0, (advert ? ADVERTS : MURALS) - 1), u0: r.range(0.08, 0.2), u1: r.range(0.8, 0.92), v0: r.range(0.28, 0.45), v1: r.range(0.86, 0.94) };
  }
  return { bands, slabEdges, cornice: { h: r.range(0.24, 0.36), proj: slabEdges ? r.range(0.3, 0.5) : r.range(0.22, 0.4) }, top, sign };
}

// opening dressing for these blocks: plain lintels and thin sills, no surrounds
const ORN = plainOrnament({
  sw: 0.16, sp: 0, ring: 0.26, shopRing: 0.45, shopRingP: 0.02, keystone: false, winHead: 'plain', shopHead: 'lintel',
  sillH: 0.06, sillP: 0.05, sillCorbels: false, ears: false, apron: false, doorSurround: false, doorHood: false,
  plinthH: 0.4, plinthP: 0.03, dirt: 1,
});

/** The four outer faces as facade frames (u to the right seen from outside, w out). */
function faceFrames(f, W, D) {
  const up = new THREE.Vector3(0, 1, 0);
  const o = f.origin, u = f.uDir, n = f.nDir;
  const mk = (origin, nDir, width) => ({ origin, uDir: new THREE.Vector3().crossVectors(up, nDir).normalize(), nDir, width });
  return [
    mk(o.clone(), n.clone(), W),
    mk(o.clone().addScaledVector(u, W), u.clone(), D),
    mk(o.clone().addScaledVector(u, W).addScaledVector(n, -D), n.clone().negate(), W),
    mk(o.clone().addScaledVector(n, -D), u.clone().negate(), D),
  ];
}

/**
 * Plan of one face k (0 front, 1 right, 2 back, 3 left): floors, bays, openings,
 * balconies, and the mural panel (front only).
 */
function facePlan(sl, k, width) {
  const r = RNG.from(sl.seed, 'face', k);
  const H = sl.groundH + sl.floors * sl.floorH;
  const floors = [{ index: 0, y: 0, h: sl.groundH }];
  for (let i = 0; i < sl.floors; i++) floors.push({ index: i + 1, y: sl.groundH + i * sl.floorH, h: sl.floorH });
  const edge = 0.7;
  const nb = Math.max(1, Math.floor((width - 2 * edge) / sl.bayW));
  const bw = (width - 2 * edge) / nb;
  const bays = [];
  for (let b = 0; b < nb; b++) bays.push({ index: b, u0: edge + b * bw, u1: edge + (b + 1) * bw, uc: edge + (b + 0.5) * bw, w: bw });
  const panelOf = (m) => ({ u0: m.u0 * width, u1: m.u1 * width, v0: sl.groundH + m.v0 * (H - sl.groundH), v1: sl.groundH + m.v1 * (H - sl.groundH) });
  let mural = sl.mural && k === sl.mural.face ? panelOf(sl.mural) : null, advert = null;
  if (!mural && sl.sign && k === sl.sign.face) {
    const p = panelOf(sl.sign);
    if (sl.sign.kind === 'mural') { mural = p; mural.k = sl.sign.k; } else {
      // a printed advert keeps its proportions, centred in the slot
      const ph = Math.min(p.v1 - p.v0, (p.u1 - p.u0) / ADVERT_ASPECT), pw = ph * ADVERT_ASPECT, uc = (p.u0 + p.u1) / 2;
      advert = { u0: uc - pw / 2, u1: uc + pw / 2, v0: p.v1 - ph, v1: p.v1, k: sl.sign.k };
    }
  }
  const inRect = (m, u0, u1, v0, v1) => m && u1 > m.u0 - 0.3 && u0 < m.u1 + 0.3 && v1 > m.v0 - 0.3 && v0 < m.v1 + 0.3;
  const inMural = (u0, u1, v0, v1) => inRect(mural, u0, u1, v0, v1) || inRect(advert, u0, u1, v0, v1);
  // balcony bays: stacked columns on the long faces, or bands across the front
  const longFace = k === 0 || k === 2;
  const bandFront = sl.balcony === 'bands' && k === 0 && !mural && !advert;
  const stackCols = new Set();
  if (sl.balcony === 'stack' && (longFace || r.chance(0.3))) for (const b of bays) if (r.chance(0.4)) stackCols.add(b.index);
  const balconies = [];
  const openings = [];
  const id = `${sl.id}:${k}`;
  // shop floor (front), or small windows / blank wall (sides and back)
  if (k === 0) {
    const door = nb > 2 ? r.int(0, nb - 1) : -1;
    for (const b of bays) {
      if (inMural(b.u0, b.u1, 0, sl.groundH)) continue;
      const isDoor = b.index === door;
      const w = isDoor ? Math.min(1.5, bw - 0.7) : bw - r.range(0.45, 0.7);
      const h = isDoor ? Math.min(2.6, sl.groundH - 1.0) : sl.groundH - r.range(0.85, 1.1);
      openings.push({ id: `${id}:g${b.index}`, floor: 0, bay: b.index, uc: b.uc, w, y: 0.03, h, top: 'flat', rise: 0, spring: 0.03 + h, kind: isDoor ? 'door' : 'shop', recess: r.range(0.2, 0.35), lit: r.range(0.6, 1) });
    }
  } else if (r.chance(0.5)) {
    for (const b of bays) {
      if (!r.chance(0.6)) continue;
      const w = Math.min(sl.winW, bw - 1), y = 1.2, h = 1.2;
      openings.push({ id: `${id}:g${b.index}`, floor: 0, bay: b.index, uc: b.uc, w, y, h, top: 'flat', rise: 0, spring: y + h, kind: 'window', recess: 0.14, shutters: 'none', lit: r.next() });
    }
  }
  // upper floors: one window per bay, stacked; balcony bays get French windows
  for (const f of floors) {
    if (f.index === 0) continue;
    const bandHere = bandFront && (f.index > 1 || r.chance(0.6));
    if (bandHere) balconies.push({ floor: f.index, u0: 0.35, u1: width - 0.35, y: f.y + 0.02, depth: r.range(1.1, 1.5), slabT: 0.16, solid: sl.solid });
    for (const b of bays) {
      const bal = bandHere || stackCols.has(b.index);
      const y = bal ? f.y + 0.05 : f.y + r.range(0.85, 0.95);
      const h = bal ? Math.min(f.h - 0.75, 2.2) : sl.winH;
      const w = bal ? Math.min(bw - 0.7, sl.winW + 0.25) : sl.winW;
      if (inMural(b.uc - w / 2, b.uc + w / 2, y, y + h)) continue;
      if (bal && !bandHere) balconies.push({ floor: f.index, u0: b.uc - Math.min(bw * 0.45, 1.35), u1: b.uc + Math.min(bw * 0.45, 1.35), y: f.y + 0.02, depth: r.range(1.0, 1.4), slabT: 0.15, solid: sl.solid });
      const hs = hash3(f.index * 31 + b.index, k + 7, sl.seed);
      // shutters on about 40 % of the windows: roller shutters part or all the way down,
      // or louvred leaves (closed, or folded back against the wall)
      let shutters = 'none', roller = 0;
      if (hs < 0.42) {
        if (sl.shutters === 'roller') { shutters = 'roller'; roller = hs < 0.12 ? 1 : 0.25 + 0.65 * hash3(b.index, f.index, sl.seed + 3); }
        else shutters = hs < 0.2 ? 'closed' : 'open';
      }
      openings.push({
        id: `${id}:f${f.index}b${b.index}`, floor: f.index, bay: b.index, uc: b.uc, w, y, h, top: 'flat', rise: 0, spring: y + h,
        kind: bal ? 'balconyDoor' : 'window', recess: r.range(0.14, 0.22), shutters, roller, lit: r.next(), curtain: r.chance(0.5),
        ac: !bal && hash3(b.index * 7 + f.index, k + 19, sl.seed) < 0.13,
      });
    }
  }
  return {
    k, width, floors, bays, openings, balconies, mural, advert, courses: [], cornice: { y: H }, groundAt: () => 0,
    style: { surrounds: false, frameColor: sl.frameColor, shutterColor: sl.shutterColor },
  };
}

/** Generate one block into B (generator: yields between pieces). */
export function* slabSteps(B, sl, q0) {
  // seen from 40 m and more: no dark boxes behind the glass, no bevels or steps
  const q = { ...q0, interior: false, bevel: false, steps: false, fit: false, rustic: false, gridV: Math.max(q0.gridV, 1.6), gridU: 4 };
  B.begin();
  const stone = sl.finish === 'stone';
  const wall = stone ? B.sink('ashlar') : B.sink('plaster');
  const sinks = {
    ashlar: wall, rough: null,
    smooth: stone ? B.sink('smooth') : wall,           // reveals
    detail: stone ? B.sink('smoothD') : wall,          // sills and lintels
    dark: B.sink('plaster'), paint: B.sink('plaster'), frame: B.sink('plaster'),
    metal: B.sink('dark'), glass: B.sink('glass'), tile: B.sink('tile'),
  };
  const W = sl.W, D = sl.D, H = sl.groundH + sl.floors * sl.floorH;
  const col = sl.color;
  const frames = faceFrames(sl.frame, W, D);
  const uvOff = (sl.seed % 97) * 0.37;
  let frontShade = null;
  for (let k = 0; k < 4; k++) {
    const fr = frames[k];
    const face = facePlan(sl, k, fr.width);
    const fs = new FaceShade(face, col, sl.seed + 977 * k, { dirt: sl.dirt, uncleaned: sl.uncleaned, sillExt: 0.11, sillH: 0.06 });
    if (!k) frontShade = fs;
    const ctx = { B, sinks, q, fs, orn: ORN, vBottom: -2, vTop: H, rustic: null, sillExt: 0.11, ch: 0, fit: null, filled: false, rollerCol: sl.roller };
    B.frameFromLot(fr);
    B.setUV(1, uvOff + k * 3.1, 1, 0);
    // the mural panel is left out of the wall (it is its own surface)
    const holes = face.mural
      ? [...face.openings, { uc: (face.mural.u0 + face.mural.u1) / 2, w: face.mural.u1 - face.mural.u0, y: face.mural.v0, h: face.mural.v1 - face.mural.v0, top: 'flat', rise: 0, spring: face.mural.v1 }]
      : face.openings;
    yield* wallField(ctx, face, holes);
    B.setUV();
    B.frameFromLot(fr);
    const irng = RNG.from(sl.seed, 'infill', k);
    for (let i = 0; i < face.openings.length; i++) {
      const o = face.openings[i];
      openingMasonry(ctx, face, o);
      openingInfill(ctx, face, o, irng);
      if (o.ac) {
        B.enter(o.uc + (hash3(i, k, sl.seed) < 0.5 ? -0.25 : 0.25), o.y - 0.95, 0.17, 0);
        acUnit(B, { paint: sinks.paint, metal: sinks.metal }, q, RNG.from(sl.seed, 'ac', k, i));
        B.popFrame();
      }
      if (i % 4 === 3) { yield; B.frameFromLot(fr); }
    }
    B.shade = null;
    yield;
    B.frameFromLot(fr);
    yield* slabBalconies(B, sinks, face.balconies, fs, sl.seed, q, fr);
    if (face.mural) muralPanel(B, face.mural, face.mural.k ?? sl.mural.k);
    if (face.advert) advertPanel(B, sinks, face.advert, q);
    yield* storeyBands(B, sinks, sl, face, fs, fr, H);
    if (!k && sl.canopy && q.lod === 0) {
      // concrete canopy over the shop floor (its shadow line marks the base of the block)
      B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); const s = nv < -0.5 ? 0.7 : 1.02; out[0] *= s; out[1] *= s; out[2] *= s; };
      const cu0 = 0.3, cu1 = fr.width - 0.3;
      B.box(sinks.detail, cu0, cu1, sl.groundH - 0.5, sl.groundH - 0.32, 0, 1.3, FACES.FRONT | FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
      B.shade = null;
    }
    B.flat = [1, 1, 1];
    yield;
  }
  // roof
  B.frameFromLot(sl.frame);
  if (sl.roof === 'tile') {
    B.shade = (u, v, w, nu, nv, nw, out) => frontShade.wall(u, v, out);
    // eaves band
    B.box(sinks.detail, -0.1, W + 0.1, H - 0.3, H, -D - 0.1, 0.1, FACES.FRONT | FACES.BACK | FACES.LEFT | FACES.RIGHT | FACES.BOTTOM);
    B.shade = null;
    B.flat = [1, 1, 1];
    pitchedRoof(B, sinks, {
      W, v0: H, pitch: 22 + (sl.seed % 9), front: 0.55, back: -D - 0.55,
      ends: [{ dir: [0, -1], hip: true, over: 0.55 }, { dir: [0, -1], hip: true, over: 0.55 }], wallBack: [[0, -D], [W, -D]],
    }, q);
    B.flat = [1, 1, 1];
    return;
  }
  // the roof slab's edge, projecting all round: a light line against the sky with a
  // dark soffit under it
  {
    const cp = sl.cornice.proj, chh = sl.cornice.h;
    B.shade = (u, v, w, nu, nv, nw, out) => { frontShade.wall(u, v, out); const k = nv < -0.5 ? 0.6 : nv > 0.5 ? 0.98 : 1.06; out[0] *= k; out[1] *= k; out[2] *= k; };
    B.box(sinks.detail, -cp, W + cp, H - chh, H - 0.02, -D - cp, cp, FACES.ALL);
    B.shade = null;
  }
  yield* flatRoof(B, sinks, sl, q, frontShade, H);
}

/**
 * String courses of face `face` (stone bands, or the exposed slab edges of a rendered
 * block) just under the floor lines of sl.bands, clear of the face's mural or advert.
 * The front and back faces' bands turn the corners (their ends cover the side faces').
 */
function* storeyBands(B, sinks, sl, face, fs, fr, H) {
  const W = face.width, s = sinks.detail, k = face.k;
  const h = sl.slabEdges ? 0.2 : 0.26, p = sl.slabEdges ? 0.045 : 0.06;
  const panels = [face.mural, face.advert].filter(Boolean);
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); const c = nv < -0.5 ? 0.66 : nv > 0.5 ? 0.98 : 1.07; out[0] *= c; out[1] *= c; out[2] *= c; };
  const ends = k % 2 === 0;
  for (const fi of sl.bands) {
    const f = face.floors[fi];
    if (!f || f.y > H - 0.5) continue;
    const y1 = f.y - 0.02, y0 = y1 - h;     // under the floor line (balcony slabs sit on it)
    let segs = [[ends ? -p : 0, ends ? W + p : W]];
    for (const m of panels) {
      if (y1 < m.v0 - 0.1 || y0 > m.v1 + 0.1) continue;
      segs = segs.flatMap(([a, b]) => [[a, Math.min(b, m.u0 - 0.06)], [Math.max(a, m.u1 + 0.06), b]]).filter(([a, b]) => b - a > 0.3);
    }
    for (const [a, b] of segs) {
      B.box(s, a, b, y0, y1, 0, p, FACES.FRONT | FACES.TOP | FACES.BOTTOM | (a < 0 || a > 0.01 ? FACES.LEFT : 0) | (b > W || b < W - 0.01 ? FACES.RIGHT : 0));
    }
  }
  B.shade = null;
  yield;
  B.frameFromLot(fr);
}

/**
 * A set-back top storey on the roof (sl.top): its front with real openings (reveals,
 * glazing, frames, shutters), plain sides and back, a thin projecting roof slab.
 * Returns its footprint [u0, u1, w0, w1] (for the rooftop clutter), or null.
 */
function* topStorey(B, sinks, sl, q, fs, H) {
  const t = sl.top, W = sl.W, D = sl.D;
  const u0 = t.u0 * W, u1 = t.u1 * W, w1 = -t.back, w0 = -D + 2.2, th = t.h, vt = H + th;
  if (u1 - u0 < 5 || w1 - w0 < 4) return null;
  const f = sl.frame;
  const origin = f.origin.clone().addScaledVector(f.uDir, u0).addScaledVector(f.nDir, w1);
  const fr = { origin, uDir: f.uDir, nDir: f.nDir };
  const r = RNG.from(sl.seed, 'top');
  const width = u1 - u0;
  const nb = Math.max(1, Math.floor((width - 1.0) / 2.8)), bw = (width - 1.0) / nb;
  const openings = [];
  for (let b = 0; b < nb; b++) {
    const door = r.chance(0.55), w = door ? Math.min(bw - 0.6, r.range(1.4, 2.0)) : Math.min(bw - 0.8, r.range(1.1, 1.5));
    const y = door ? H + 0.05 : H + r.range(0.85, 0.95), h = door ? 2.2 : 1.4;
    const hs = r.next();
    openings.push({ id: `${sl.id}:t${b}`, floor: sl.floors + 1, bay: b, uc: 0.5 + bw * (b + 0.5), w, y, h, top: 'flat', rise: 0, spring: y + h, kind: door ? 'balconyDoor' : 'window',
      recess: 0.14, shutters: hs < 0.35 ? (sl.shutters === 'roller' ? 'roller' : 'closed') : 'none', roller: r.range(0.3, 1), lit: r.next(), curtain: r.chance(0.5) });
  }
  const face = { width, openings, courses: [], balconies: [], cornice: { y: vt }, groundAt: () => H, floors: [], style: { surrounds: false, frameColor: sl.frameColor, shutterColor: sl.shutterColor } };
  const tfs = new FaceShade(face, sl.color.map((c) => c * 1.02), sl.seed + 3301, { dirt: sl.dirt, uncleaned: sl.uncleaned * 0.6, sillExt: 0.11, sillH: 0.06 });
  const ctx = { B, sinks, q, fs: tfs, orn: ORN, vBottom: H - 0.02, vTop: vt, rustic: null, sillExt: 0.11, ch: 0, fit: null, filled: false, rollerCol: sl.roller };
  B.frameFromLot(fr);
  B.setUV(1, (sl.seed % 31) * 0.53, 1, 0);
  yield* wallField(ctx, face, openings);
  B.setUV();
  B.frameFromLot(fr);
  const irng = RNG.from(sl.seed, 'topInfill');
  for (const o of openings) { openingMasonry(ctx, face, o); openingInfill(ctx, face, o, irng); }
  yield;
  // sides and back (main frame), the roof slab and its screed
  B.frameFromLot(f);
  B.shade = (u, v, w, nu, nv, nw, out) => { tfs.wall(u - u0 - w * 0.4, v, out); out[0] *= 0.97; out[1] *= 0.97; out[2] *= 0.97; };
  B.gridU(sinks.ashlar, u0, H - 0.02, vt, w0, w1, -1, 2.5);
  B.gridU(sinks.ashlar, u1, H - 0.02, vt, w0, w1, 1, 2.5);
  B.rectW(sinks.ashlar, u0, u1, H - 0.02, vt, w0, -1);
  B.shade = (u, v, w, nu, nv, nw, out) => { tfs.wall(u - u0, v, out); const k = nv < -0.5 ? 0.62 : 1.04; out[0] *= k; out[1] *= k; out[2] *= k; };
  B.box(sinks.detail, u0 - 0.3, u1 + 0.3, vt, vt + 0.18, w0 - 0.3, w1 + 0.45, FACES.ALL & ~FACES.TOP);
  B.shade = null;
  B.flat = [0.4, 0.39, 0.38];
  B.rectV(sinks.dark, u0 - 0.3, u1 + 0.3, w0 - 0.3, w1 + 0.45, vt + 0.18, 1);
  B.flat = [1, 1, 1];
  return [u0, u1, w0, w1];
}

/** The painted panel (uv 0..1 over it), flush with the wall it replaces. */
function muralPanel(B, m, k) {
  const s = B.sink(`mural${k}`);
  B.shade = null;
  B.flat = [1, 1, 1];
  s.reserve(4, 6);
  const a = B.v(s, m.u0, m.v0, 0, 0, 0, 1, 0, 0), b = B.v(s, m.u1, m.v0, 0, 0, 0, 1, 1, 0);
  const c = B.v(s, m.u1, m.v1, 0, 0, 0, 1, 1, 1), d = B.v(s, m.u0, m.v1, 0, 0, 0, 1, 0, 1);
  B.quadIdx(s, a, b, c, d);
}

/** Flat roof: parapet with a coping, membrane deck, lift room, heaters, tanks, a mast. */
function* flatRoof(B, sinks, sl, q, fs, H) {
  const W = sl.W, D = sl.D, ph = 1.0, t = 0.22;
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); if (nv > 0.5) { out[0] *= 1.04; out[1] *= 1.04; out[2] *= 1.04; } };
  const sW = sinks.ashlar;
  B.box(sW, 0, W, H, H + ph, -t, 0, FACES.FRONT | FACES.BACK | FACES.TOP);
  B.box(sW, 0, W, H, H + ph, -D, -D + t, FACES.FRONT | FACES.BACK | FACES.TOP);
  B.box(sW, 0, t, H, H + ph, -D + t, -t, FACES.LEFT | FACES.RIGHT | FACES.TOP);
  B.box(sW, W - t, W, H, H + ph, -D + t, -t, FACES.LEFT | FACES.RIGHT | FACES.TOP);
  // coping proud of the wall: a light line along the top with a shadowed drip under it
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); const k = nv < -0.5 ? 0.62 : nv > 0.5 ? 0.96 : 1.08; out[0] *= k; out[1] *= k; out[2] *= k; };
  B.box(sinks.detail, -0.07, W + 0.07, H + ph - 0.02, H + ph + 0.08, -D - 0.07, 0.07, FACES.ALL);
  B.shade = null;
  B.flat = [0.36, 0.35, 0.34];
  B.rectV(sinks.dark, 0, W, -D, 0, H + 0.02, 1);
  yield;
  B.frameFromLot(sl.frame);
  const r = RNG.from(sl.seed, 'roof');
  // lift and stair room
  const lu = r.range(0.3, 0.6) * W, lw = -r.range(0.4, 0.6) * D, lh = r.range(2.8, 3.4);
  // a set-back top storey (it houses the stair head), or the lift and stair room
  const top = sl.top ? yield* topStorey(B, sinks, sl, q, fs, H) : null;
  B.frameFromLot(sl.frame);
  const placed = [];
  if (!top) {
    B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u * 0.7, v, out); out[0] *= 0.97; out[1] *= 0.97; out[2] *= 0.97; };
    B.box(sW, lu - 1.7, lu + 1.7, H, H + lh, lw - 2.3, lw + 2.3, FACES.ALL & ~FACES.BOTTOM);
    B.shade = null;
    B.flat = sl.color.map((c) => c * 0.9);
    B.box(sinks.paint, lu - 1.8, lu + 1.8, H + lh, H + lh + 0.12, lw - 2.4, lw + 2.4, FACES.ALL);
    placed.push([lu, lw, 2.9]);
  }
  const clearTop = (u, w, rr) => !top || u + rr < top[0] - 0.5 || u - rr > top[1] + 0.5 || w + rr < top[2] - 0.5 || w - rr > top[3] + 0.6;
  const free = (u, w, rr) => u - rr > 0.5 && u + rr < W - 0.5 && w + rr < -0.5 && w - rr > -D + 0.5 && clearTop(u, w, rr) && placed.every((p) => Math.hypot(p[0] - u, p[1] - w) > p[2] + rr);
  // solar water heaters in rows (one per flat; the city's characteristic roofline)
  const yawSun = sunYaw(sl.frame), R2 = heaterRadius(2);
  const nMax = q.lod ? 5 : 14;
  let n = 0;
  const sinksH = { ...sinks, paint: sinks.metal, frame: sinks.metal, glass: q.lod ? null : sinks.glass };
  for (let w = -0.9 - R2; w > -D + R2 + 0.6 && n < nMax; w -= r.range(2.8, 3.3)) {
    for (let u = R2 + 0.7 + r.range(0, 0.6); u < W - R2 - 0.7 && n < nMax; u += r.range(2.3, 2.8)) {
      if (!free(u, w, R2) || r.chance(0.2)) continue;
      placed.push([u, w, R2]);
      const hr = RNG.from(sl.seed, 'heater', n++);
      B.enter(u, H + 0.02, w, yawSun + hr.range(-0.1, 0.1));
      solarHeater(B, sinksH, 0, q, hr, hr.chance(0.5) ? hr.range(0.4, 1.1) : 0, 2);
      B.popFrame();
      if (n % 3 === 0) { yield; B.frameFromLot(sl.frame); }
    }
  }
  B.frameFromLot(sl.frame);
  if (top) {
    // heaters on the top storey's roof, against the sky
    const vt = H + sl.top.h + 0.18, k = Math.min(3, Math.floor((top[1] - top[0]) / 3.2));
    for (let i = 0; i < k; i++) {
      const hr = RNG.from(sl.seed, 'topHeater', i);
      const u = top[0] + ((top[1] - top[0]) * (i + 0.5)) / k, w = (top[2] + top[3]) / 2 + hr.range(-0.6, 0.6);
      B.enter(u, vt, w, yawSun + hr.range(-0.1, 0.1));
      solarHeater(B, sinksH, 0, q, hr, hr.chance(0.4) ? hr.range(0.3, 0.9) : 0, 2);
      B.popFrame();
    }
  }
  for (let i = 0; i < 3; i++) {
    const tr = RNG.from(sl.seed, 'tank', i);
    const u = tr.range(1.5, W - 1.5), w = -tr.range(1.5, D - 1.5);
    if (!free(u, w, 0.8)) continue;
    placed.push([u, w, 0.8]);
    B.enter(u, H + 0.02, w, tr.range(0, 3));
    if (i < 2) waterTank(B, sinks, q, tr); else antenna(B, sinks, q, tr);
    B.popFrame();
  }
  B.flat = [1, 1, 1];
}
