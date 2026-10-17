// Fixed track features along the ride track that make impact sounds: rail joints
// (18 m rails; most are welded smooth, some are dipped and knock) and the turnout
// parts of each crossover (switch toe, heel joints, frog, check rail). Deterministic,
// so the same joint knocks the same way on every lap; exposed for the camera rig too.
import { RNG } from '../../core/rng.js';

const RAIL_LEN = 18;

/**
 * Axles of the tram measured back from the cab front (m) and their audibility in the
 * cab: three bogies (front motor bogie under the cab, a middle and a rear one).
 */
export const AXLES = [
  { o: 2.2, w: 1.0, far: false }, { o: 4.05, w: 0.92, far: false },
  { o: 13.6, w: 0.34, far: true }, { o: 15.45, w: 0.31, far: true },
  { o: 25.0, w: 0.13, far: true }, { o: 26.85, w: 0.12, far: true },
];

/** Sorted features [{s, kind: 'joint'|'frog'|'check', sev, v}] over the whole loop. */
export function trackFeatures(route, layout) {
  const rng = RNG.from(layout.seed ?? 7, 'audio-joints');
  const L = route.length;
  const out = [];
  let s = rng.range(2, RAIL_LEN);
  while (s < L - 2) {
    if (!layout.isInCrossover(s, 4)) {
      // dipped joints knock, welds are barely there
      const dipped = rng.chance(0.62);
      const sev = dipped ? rng.range(0.45, 1.0) : rng.range(0.08, 0.22);
      out.push({ s, kind: 'joint', sev, v: rng.int(0, 7) });
    }
    s += RAIL_LEN + rng.range(-0.35, 0.35);
  }
  for (const c of layout.crossovers) {
    // our track has one turnout: facing at s0 (from = +1) or trailing at s1 (from = -1)
    const facing = c.from > 0;
    const at = (x) => route.wrap(facing ? c.s0 + x : c.s1 - x);
    out.push({ s: at(0.0), kind: 'joint', sev: 0.5, v: rng.int(0, 7) });     // switch toe
    out.push({ s: at(6.4), kind: 'joint', sev: 0.75, v: rng.int(0, 7) });    // switch heel
    out.push({ s: at(14.0), kind: 'check', sev: 0.7, len: 4.5 });          // check rail scrape
    out.push({ s: at(15.6), kind: 'frog', sev: 1.0, v: rng.int(0, 2) });     // frog nose
    out.push({ s: at(19.2), kind: 'joint', sev: 0.7, v: rng.int(0, 7) });    // frog heel
    out.push({ s: at(23.5), kind: 'joint', sev: 0.55, v: rng.int(0, 7) });   // closure rail joint
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
