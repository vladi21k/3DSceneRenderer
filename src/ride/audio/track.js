// Fixed track features along the ride track that make impact sounds. Street track is
// continuously welded grooved rail set in the paving, so almost every 18 m "joint" is a
// weld that only gives a faint low thump; about one in eight is an insulated or dipped
// joint that knocks. Plus the turnout parts of each crossover (switch toe, heel joints,
// frog, check rail). Deterministic, so the same joint knocks the same way on every lap;
// the camera rig reads the same list (app.audio.features) and the same axle positions,
// so each visible jolt lands with its knock. The axles are the shared table in
// src/core/config.js (AXLES: offset back from the cab front, weight felt / heard in the cab).
import { RNG } from '../../core/rng.js';

const RAIL_LEN = 18;
/** Axles further back than this belong to the middle / rear bogies (dull, distant impacts). */
export const NEAR_BOGIE_END = 8;

/** Sorted features [{s, kind: 'joint'|'frog'|'check', sev, v, xo?: turnout part}] over the whole loop. */
export function trackFeatures(route, layout) {
  const rng = RNG.from(layout.seed ?? 7, 'audio-joints');
  const L = route.length;
  const out = [];
  let s = rng.range(2, RAIL_LEN);
  while (s < L - 2) {
    if (!layout.isInCrossover(s, 4)) {
      // welds are barely there (sev < 0.25: thump only); insulated / dipped joints knock
      const dipped = rng.chance(0.12);
      const sev = dipped ? rng.range(0.45, 1.0) : rng.range(0.03, 0.1);
      out.push({ s, kind: 'joint', sev, v: rng.int(0, 7) });
    }
    s += RAIL_LEN + rng.range(-0.35, 0.35);
  }
  for (const c of layout.crossovers) {
    // our track has one turnout: facing at s0 (from = +1) or trailing at s1 (from = -1)
    const facing = c.from > 0;
    const at = (x) => route.wrap(facing ? c.s0 + x : c.s1 - x);
    out.push({ s: at(0.0), kind: 'joint', sev: 0.5, v: rng.int(0, 7), xo: true });     // switch toe
    out.push({ s: at(6.4), kind: 'joint', sev: 0.75, v: rng.int(0, 7), xo: true });    // switch heel
    out.push({ s: at(14.0), kind: 'check', sev: 0.7, len: 4.5, xo: true });        // check rail scrape
    out.push({ s: at(15.6), kind: 'frog', sev: 1.0, v: rng.int(0, 2), xo: true });     // frog nose
    out.push({ s: at(19.2), kind: 'joint', sev: 0.7, v: rng.int(0, 7), xo: true });    // frog heel
    out.push({ s: at(23.5), kind: 'joint', sev: 0.55, v: rng.int(0, 7), xo: true });   // closure rail joint
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

/** Index of the first feature with s > x (features sorted, wraps to 0). */
export function nextFeatureIndex(features, x) {
  let lo = 0, hi = features.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (features[m].s <= x) lo = m + 1; else hi = m; }
  return lo % features.length;
}
