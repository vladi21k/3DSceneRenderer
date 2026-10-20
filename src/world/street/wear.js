import { RNG } from '../../core/rng.js';
import { MAIN_RAILS, BAND_IN, GUTTER_OUT, GROUT_W, TRACK_OFFSET, RAIL_CENTER } from './constants.js';

// Wear of the street as it is placed on the paving (planned per chunk with the details,
// deterministically from the chunk index; the paving recipes carry the stone's own
// texture-level wear):
//   relays     stretches of a corridor strip (rail to rail, or rail to the edge band)
//              taken up for rail or utility work and relaid with setts of another batch,
//              a slightly different stone and tone; the ends lie on bed joints, the sides
//              on the rails' mortar strips, so the change of tone follows real joints
//              (line decals, street.js buildRelays and lines.js LINE_STYLE.relay);
//   repairs    asphalt and concrete fills over the setts: reinstatement squares round
//              some covers, trenches of service connections across the sidewalk from
//              the facades, cable trenches along it, small fills where broken setts
//              were replaced, and concrete strips along the rails (line ribbons of style
//              LINE_STYLE.repair, lines.js);
//   stains     rust and grime halos round the cast-iron covers (the joint round a frame
//              collects dirt, rust bleeds out of it), damp streaks along the gutter at
//              the gullies, and oil and grease under the bogies where trams stand at
//              the stops (the drip down the middle of each track is no decal but the
//              continuous drip band, street.js buildDripBands);
//   weeds      the odd tuft in a joint at the foot of a facade, along the gutter or at a
//              tree grate.

const SETT_COURSE = 0.2;      // paving.street courses run across the street every 0.2 m of u
const WALK_COURSE = 0.25;     // paving.sidewalk courses run along the street every 0.25 m of
                              // v (metres from the gutter's outer edge)
/** Cover size as a share of its halo decal (the halo cells of the stain atlas keep the
 *  middle RING_IN of the cell for the cover, see textures.js). */
export const RING_IN = 0.6;

/** The lateral ranges of the corridor strips: edge band | setts | rail | setts (four-foot)
 *  | rail | ... | setts | edge band. */
export const STRIPS = (() => {
  const z = [];
  let x = -BAND_IN;
  for (const r of MAIN_RAILS) { z.push([x, r.lo]); x = r.hi; }
  z.push([x, BAND_IN]);
  return z;
})();

// repair kinds (lines.js: the repair style's fill)
export const REPAIR_ASPHALT = 0, REPAIR_CONCRETE = 1;
// how a repair's edges follow the setts it replaced (lines.js repairWear): free, or stepped
// a course at a time: sidewalk courses (WALK_COURSE) lying across the ribbon's length
// (STEP_WALK_U: its sides step) or along it (STEP_WALK_X: its ends step), street courses
// (SETT_COURSE) across its length (STEP_STREET_U). The stepped extent starts and ends on
// course joints.
export const STEP_NONE = 0, STEP_WALK_U = 1, STEP_WALK_X = 2, STEP_STREET_U = 3;

/**
 * Wear plan of chunk ci (see the header): { relays, repairs, weeds }; halo, gutter and oil
 * stains are appended to `stains` (the details' stain decals). items: the chunk's covers
 * and grates; blocked(s, d, r): the details' free-space test.
 */
export function planWear(ctx, ci, s0, s1, items, stains, blocked) {
  const { layout, surface } = ctx;
  const delta = ctx.delta, kP = surface.kP;
  const rng = RNG.from(layout.seed, 'street-wear', ci);
  const inside = (s, r) => s - r > s0 + 0.3 && s + r < s1 - 0.3;
  const joint = (s) => (Math.round((s * kP) / SETT_COURSE) * SETT_COURSE) / kP;
  // |d| of the sidewalk course joint nearest |d| = a
  const walkJoint = (a) => GUTTER_OUT + Math.round((a - GUTTER_OUT) / WALK_COURSE) * WALK_COURSE;
  const poleNear = (s, d, r) => {
    for (let k = -1; k <= 1; k++) {
      for (const p of layout.inChunk('poles', ci + k)) if (Math.abs(delta(p.s, s)) < r + 0.3 && Math.abs(p.d - d) < r + 0.3) return true;
    }
    return false;
  };
  const nearCross = (s, r) => layout.crossStreets.some((c) => Math.abs(delta(c.s, s)) < c.width / 2 + r);

  // --- relaid setts
  const relays = [];
  const nRel = rng.weighted([[0, 0.5], [1, 0.38], [2, 0.12]]);
  for (let i = 0; i < nRel; i++) {
    for (let t = 0; t < 5; t++) {
      const zone = rng.weighted([[0, 0.1], [1, 0.3], [2, 0.2], [3, 0.3], [4, 0.1]]);
      const len = rng.chance(0.25) ? rng.range(4.5, 9) : rng.range(0.8, 4);
      const a = joint(rng.range(s0 + 0.4, s1 - 0.4 - len)), b = joint(a + len);
      if (b - a < 0.6 || a < s0 + 0.3 || b > s1 - 0.3) continue;
      const mid = (a + b) / 2, half = (b - a) / 2;
      if (layout.isInCrossover(mid, half + 3) || nearCross(mid, half + 3)) continue;
      if (relays.some((r) => r.zone === zone && r.s0 < b + 0.6 && r.s1 > a - 0.6)) continue;
      // another batch of granite: darker or paler, a little warmer or cooler
      const k = rng.chance(0.55) ? rng.range(0.68, 0.84) : rng.range(1.15, 1.32);
      const h = rng.range(-0.05, 0.07);
      const [d0, d1] = STRIPS[zone];
      relays.push({ s0: a, s1: b, zone, d0, d1, k, h });
      break;
    }
  }

  // --- repairs, and halos round the covers that keep their setts
  const repairs = [];
  const hit = (s, d, r, skip) => items.some((it) => it !== skip && (delta(it.s, s) ** 2 + (d - it.d) ** 2) < (r + it.r + 0.15) ** 2);
  const overlaps = (s, d, hs, hd) => repairs.some((p) => Math.abs(delta(p.s, s)) < p.hs + hs + 0.3 && Math.abs(p.d - d) < p.hd + hd + 0.3);
  for (const it of items) {
    if (it.tree) continue;
    const walk = Math.abs(it.d) > GUTTER_OUT + 0.2;
    if (walk && (it.type === 'manhole' || it.type === 'plate' || it.type === 'plate2' || it.type === 'valve')
      && rng.chance(it.type === 'valve' ? 0.15 : 0.22)) {
      // reinstatement square round the cover, hand-laid in asphalt or concrete where the
      // setts were taken up: its sides on course joints (the cover is nudged by up to an
      // eighth of a course to sit centred between them), its ends stepped sett by sett
      const side = it.type === 'valve' ? rng.range(0.6, 0.9) : it.type === 'manhole' ? rng.range(1.25, 1.7) : rng.range(1.0, 1.5);
      const hs = side / 2 + rng.range(-0.05, 0.12);
      const kind = rng.chance(0.65) ? REPAIR_ASPHALT : REPAIR_CONCRETE;
      const sd = it.d < 0 ? -1 : 1, H = WALK_COURSE / 2;
      const ac = GUTTER_OUT + Math.round((Math.abs(it.d) - GUTTER_OUT) / H) * H;
      const onJoint = Math.abs(walkJoint(ac) - ac) < 1e-6;
      const hd = (onJoint ? 0 : H) + Math.max(1, Math.round((side / 2 - (onJoint ? 0 : H)) / WALK_COURSE)) * WALK_COURSE;
      if (inside(it.s, hs + 0.25) && !overlaps(it.s, sd * ac, hs, hd) && ac - hd > GUTTER_OUT + 0.1) {
        it.d = sd * ac;
        const round = it.type === 'manhole' || it.type === 'valve';
        const [w, l] = SIZE[it.type];
        const rot = Math.abs(Math.sin(it.yaw)) > 0.7;
        repairs.push({
          dir: 's', s: it.s, d: it.d, hs, hd, kind, tone: rng.next(), step: STEP_WALK_X,
          hole: round ? { r: w / 2 + 0.002 } : { hs: (rot ? l : w) / 2 + 0.002, hd: (rot ? w : l) / 2 + 0.002 },
        });
        continue;
      }
    }
    // halo: grime in the joint round the frame and rust bled out of it into the stone
    const R = SIZE[it.type];
    if (!R) continue;
    const round = it.type === 'manhole' || it.type === 'valve';
    if (it.type === 'gully') {
      stains.push({ s: it.s, d: it.d, kind: 7, size: R[0] / RING_IN, aspect: R[1] / R[0], yaw: 0, op: rng.range(0.8, 1.1), warm: rng.range(0.1, 0.3) });
      // damp silt washed along the channel to the grate
      const up = rng.chance(0.5) ? 1 : -1;
      const L = rng.range(1.6, 3.2);
      const sc = it.s + up * (R[0] / 2 + L * 0.42);
      if (inside(sc, L / 2)) stains.push({ s: sc, d: it.d + rng.range(-0.02, 0.02), kind: 3, size: rng.range(1.3, 1.7), aspect: L / 1.5, yaw: Math.PI / 2, op: rng.range(0.75, 1.05), warm: rng.range(0.05, 0.2) });
      if (rng.chance(0.5)) stains.push({ s: it.s, d: it.d, kind: 0, size: rng.range(0.7, 1.0), aspect: 0.6, yaw: rng.range(-0.2, 0.2), op: 0.8, warm: 0.15 });
    } else if (it.type === 'drain') {
      stains.push({ s: it.s, d: it.d, kind: 7, size: R[0] / RING_IN, aspect: R[1] / R[0], yaw: it.yaw, op: rng.range(0.9, 1.15), warm: rng.range(0.2, 0.45) });
      for (let k = rng.int(1, 3); k > 0; k--) {
        const s = it.s + rng.range(-1.2, 1.2);
        if (inside(s, 0.6)) stains.push({ s, d: it.d + rng.normal(0, 0.12), kind: 8, size: rng.range(0.45, 0.8), aspect: rng.range(0.7, 1.1), yaw: rng.range(0, 6.28), op: rng.range(0.7, 1.0), warm: 0.15 });
      }
    } else {
      stains.push({
        s: it.s, d: it.d, kind: round ? 6 : 7, size: R[0] / RING_IN, aspect: R[1] / R[0], yaw: it.yaw,
        op: rng.range(0.75, 1.15), warm: rng.range(0.35, 0.85),
      });
    }
  }

  // trenches of service connections across a sidewalk, from the facade (or a cover on
  // the way) out towards the street: from course joint to course joint, the sides
  // stepped where the setts were taken up; and, rarely, a cable trench along it
  for (const side of [-1, 1]) {
    if (!rng.chance(0.13)) continue;
    for (let t = 0; t < 4; t++) {
      const s = rng.range(s0 + 1.2, s1 - 1.2);
      const hs = rng.range(0.24, 0.42);
      if (!inside(s, hs + 0.35) || layout.isInStation(s, 3) || layout.isInCrossStreet(s, side, 2) || layout.isInCrossStreet(s, 0, 2)) continue;
      const f = surface.facadeAt(s, side, {});
      if (!(f.d === f.d)) continue;
      const a = Math.abs(f.d) - 0.04;
      const b = rng.chance(0.6) ? GUTTER_OUT : walkJoint(rng.range(Math.max(GUTTER_OUT + 1.5, a - 4.5), a - 1.2));
      if (a - b < 1) continue;
      const dm = side * (a + b) / 2, hd = (a - b) / 2;
      // clear of grates, covers, poles and anything standing on the sidewalk
      let ok = !poleNear(s, dm, Math.max(hs, hd));
      for (let x = b + 0.2; ok && x <= a - 0.2; x += 0.3) if (hit(s, side * x, hs + 0.2) || blocked(s, side * x, hs + 0.15)) ok = false;
      if (!ok || overlaps(s, dm, hs, hd)) continue;
      repairs.push({ dir: 'd', s, d: dm, hs, hd, kind: rng.chance(0.7) ? REPAIR_ASPHALT : REPAIR_CONCRETE, tone: rng.next(), hole: null, step: STEP_WALK_U, side });
      break;
    }
  }
  if (rng.chance(0.08)) {
    const side = rng.chance(0.5) ? 1 : -1;
    const len = rng.range(4, 12), hd = rng.chance(0.6) ? WALK_COURSE : WALK_COURSE / 2;
    const s = rng.range(s0 + len / 2 + 0.5, s1 - len / 2 - 0.5);
    const hw = layout.halfWidth(s, side);
    const d = side * (walkJoint(hw - rng.range(0.9, 1.8)) + hd);
    let ok = inside(s, len / 2 + 0.3) && !layout.isInStation(s, len / 2 + 3) && !layout.isInCrossStreet(s, side, len / 2 + 2) && !layout.isInCrossStreet(s, 0, len / 2 + 2);
    for (let x = -len / 2; ok && x <= len / 2; x += 0.4) if (hit(s + x, d, hd) || poleNear(s + x, d, hd)) ok = false;
    if (ok && !overlaps(s, d, len / 2, hd)) repairs.push({ dir: 's', s, d, hs: len / 2, hd, kind: REPAIR_ASPHALT, tone: rng.next(), hole: null, step: STEP_WALK_X });
  }
  // small fills where a broken sett or two were replaced with mortar or asphalt: a course
  // or two of the sidewalk, or a few courses of the street's setts
  for (let i = rng.chance(0.55) ? 1 : 0; i > 0; i--) {
    let s = rng.range(s0 + 1, s1 - 1);
    const side = rng.chance(0.5) ? 1 : -1;
    const walk = rng.chance(0.65);
    let d, hs, hd, step;
    if (walk) {
      hd = rng.chance(0.65) ? WALK_COURSE / 2 : WALK_COURSE;
      d = side * (walkJoint(rng.range(GUTTER_OUT + 0.6, layout.halfWidth(s, side) - 0.6)) + hd);
      hs = rng.range(0.2, 0.45);
      step = STEP_WALK_X;
    } else {
      const a = joint(s - rng.range(0.15, 0.4)), b = joint(s + rng.range(0.15, 0.4));
      s = (a + b) / 2; hs = (b - a) / 2;
      hd = rng.range(0.15, 0.32);
      d = side * rng.range(0.3, BAND_IN - 0.4);
      step = STEP_STREET_U;
    }
    if (hs < 0.08 || !inside(s, hs + 0.3) || blocked(s, d, Math.max(hs, hd)) || overlaps(s, d, hs, hd) || nearCross(s, 3)) continue;
    // in the corridor keep clear of the rails' mortar strips (the steps reach a little
    // beyond the nominal sides)
    if (!walk && MAIN_RAILS.some((r) => d + hd + 0.22 > r.lo - GROUT_W && d - hd - 0.22 < r.hi + GROUT_W)) continue;
    repairs.push({ dir: 's', s, d, hs, hd, kind: rng.chance(0.6) ? REPAIR_CONCRETE : REPAIR_ASPHALT, tone: rng.next(), hole: null, step, small: true });
  }
  // concrete along a rail where the setts beside it broke under the wheels' blows
  if (rng.chance(0.2)) {
    const r = MAIN_RAILS[rng.int(0, 3)];
    const out = rng.chance(0.5) ? 1 : -1;
    const w = rng.range(0.12, 0.24);
    const a0 = joint(rng.range(s0 + 0.8, s1 - 3.6)), s = (a0 + joint(a0 + rng.range(0.6, 3.0))) / 2;
    const len = 2 * (s - a0);
    const d = out > 0 ? r.hi + GROUT_W + 0.012 + w / 2 : r.lo - GROUT_W - 0.012 - w / 2;
    if (len > 0.4 && inside(s, len / 2 + 0.3) && Math.abs(d) + w / 2 < BAND_IN - 0.05 && !layout.isInCrossover(s, len / 2 + 3) && !nearCross(s, len / 2 + 3)
      && !hit(s, d, Math.max(len / 2, w)) && !overlaps(s, d, len / 2, w / 2)) {
      repairs.push({ dir: 's', s, d, hs: len / 2, hd: w / 2, kind: REPAIR_CONCRETE, tone: rng.next(), hole: null, rail: true });
    }
  }

  // --- oil and grease where the trams stand at the stops: patches under the bogies
  for (const z of surface.stopZones()) {
    if (delta(s0, z.s1) < -1 || delta(s1, z.s0) > 1) continue;
    const dc = z.track * TRACK_OFFSET;
    const zr = RNG.from(layout.seed, 'street-stop', ci, z.track);
    for (const b of z.bogies) {
      for (let k = zr.int(2, 4); k > 0; k--) {
        const s = b + zr.normal(0, 0.7);
        if (!inside(s, 0.5)) continue;
        stains.push({ s, d: dc + zr.normal(0, 0.1), kind: zr.chance(0.6) ? 8 : 1, size: zr.range(0.55, 1.15), aspect: zr.range(0.6, 1.0), yaw: zr.range(0, 6.28), op: zr.range(0.85, 1.25), warm: zr.range(0.05, 0.25) });
      }
    }
    // (the drips along the middle of the track under the standing body are the drip
    // band's heavier stretch, street.js buildDripBands: no separate decals; the draws
    // are kept so the stains that follow keep their places)
    for (let s = z.s0 + zr.range(0, 2); delta(s, z.s1) > 0; s += zr.range(1.6, 3.4)) {
      if (!inside(s, 0.9) || !zr.chance(0.6)) continue;
      zr.normal(0, 0.07); zr.range(1.0, 1.5); zr.range(0.6, 1.1); zr.normal(0, 0.04); zr.range(0.7, 1.0);
    }
  }
  // grime blotches a metre or two across: spills and water stains dried into the stone,
  // trodden-in dirt (on the sidewalks and across the corridor; the middle of each track
  // darkens continuously with the drip band instead, so blotches drawn there are dropped)
  const gr = RNG.from(layout.seed, 'street-grime', ci);
  for (let k = gr.int(3, 7); k > 0; k--) {
    const s = gr.range(s0 + 1.0, s1 - 1.0);
    const where = gr.weighted([[0, 0.45], [1, 0.2], [2, 0.35]]);
    let d;
    if (where === 0) d = (gr.chance(0.5) ? 1 : -1) * (TRACK_OFFSET + gr.normal(0, 0.25));
    else if (where === 1) d = gr.range(-BAND_IN + 0.3, BAND_IN - 0.3);
    else {
      const side = gr.chance(0.5) ? 1 : -1;
      d = side * gr.range(GUTTER_OUT + 0.4, layout.halfWidth(s, side) - 0.5);
    }
    const size = where === 0 ? gr.range(0.6, 1.1) : gr.range(0.9, 2.4);
    if (!inside(s, where === 0 ? size * 1.1 : size * 0.5) || layout.isInCrossover(s, 2) || nearCross(s, 1.5) || (where === 2 && blocked(s, d, 0.2))) continue;
    const kind = gr.chance(0.6) ? 0 : 5;
    const aspect = where === 0 ? gr.range(1.3, 2.2) : gr.range(0.6, 1.1);
    const yaw = where === 0 ? Math.PI / 2 + gr.normal(0, 0.2) : gr.range(0, 6.28);
    const op = gr.range(0.85, 1.45), warm = gr.range(0.05, 0.3);
    // (a blotch across the corridor centred in a four-foot is dropped too: fitted between
    // the rails below, it would be just such a smear)
    const four = Math.abs(Math.abs(d) - TRACK_OFFSET) < RAIL_CENTER;
    if (where === 0 || (where === 1 && four)) continue;
    stains.push({ s, d, kind, size, aspect, yaw, op, warm });
  }

  // (no single drip stains along the tracks away from the stops: the drip band. The
  // draws are kept so the weeds that follow keep their places.)
  for (let t = 0; t < 2; t++) {
    for (let k = rng.int(0, 3); k > 0; k--) {
      if (layout.isInCrossover(rng.range(s0 + 0.8, s1 - 0.8), 2)) continue;
      rng.normal(0, 0.1); rng.range(0.35, 0.75); rng.range(0.6, 1.1); rng.range(0, 6.28); rng.range(0.6, 0.95);
    }
  }

  // stains in the corridor stay on the setts of their strip: a decal draped over a rail
  // would bridge its flangeway (shrunk to fit, or dropped where too little room is left)
  for (let i = stains.length - 1; i >= 0; i--) {
    const sn = stains[i];
    if (Math.abs(sn.d) >= BAND_IN) continue;
    const z = STRIPS.find((q) => sn.d >= q[0] && sn.d <= q[1]);
    const room = z ? Math.min(sn.d - z[0], z[1] - sn.d) - 0.02 : 0;
    // (a drip trail, kind 3, is a narrow streak down the middle of its decal)
    const w = sn.kind === 3 ? 0.16 : 1;
    const across = (sn.size / 2) * (w * Math.abs(Math.sin(sn.yaw)) + (sn.aspect ?? 1) * Math.abs(Math.cos(sn.yaw)));
    if (room < 0.12) stains.splice(i, 1);
    else if (across > room) sn.size *= room / across;
  }

  // --- weeds: the odd tuft in a joint at the foot of a facade, along the gutter's outer
  // edge or against a tree grate
  const weeds = [];
  for (let k = rng.int(0, 3); k > 0; k--) {
    const s = rng.range(s0 + 0.5, s1 - 0.5);
    const side = rng.chance(0.5) ? 1 : -1;
    const where = rng.weighted([[0, 0.55], [1, 0.3], [2, 0.15]]);
    let d;
    if (where === 0) {
      const f = surface.facadeAt(s, side, {});
      if (!(f.d === f.d)) continue;
      d = f.d - side * rng.range(0.02, 0.06);
    } else if (where === 1) d = side * (GUTTER_OUT + rng.range(0.0, 0.03));
    else {
      const trees = items.filter((it) => it.tree);
      if (!trees.length) continue;
      const tr = trees[rng.int(0, trees.length - 1)];
      const e = rng.int(0, 3), a = rng.range(-0.55, 0.55);
      const ds = e < 2 ? (e ? 0.66 : -0.66) : a, dd = e < 2 ? a : (e === 2 ? 0.66 : -0.66);
      if (!inside(tr.s + ds, 0.1)) continue;
      weeds.push({ s: tr.s + ds, d: tr.d + dd, n: rng.int(1, 3), size: rng.range(0.06, 0.12), seed: rng.int(0, 1 << 20) });
      continue;
    }
    if (where === 1 && (layout.isInStation(s, 1) || nearCross(s, 1))) continue;
    if (where === 0 && blocked(s, d, 0.15)) continue;
    weeds.push({ s, d, n: rng.int(1, 4), size: rng.range(0.05, 0.13), seed: rng.int(0, 1 << 20) });
  }
  return { relays, repairs, weeds };
}

// cover sizes [across u, across v] (m), as details.js lays them out
const SIZE = { manhole: [0.8, 0.8], gully: [0.62, 0.31], drain: [1.0, 0.5], plate: [0.6, 0.6], plate2: [1.0, 0.5], valve: [0.32, 0.32] };

