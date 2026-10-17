import { MAIN_RAILS } from './constants.js';
import { RUNS_MAIN, sweepRuns } from './rails.js';
import { crossoverPlan, mainClass, mainRuns, mainCut, mainBusy } from './crossover.js';
import { inCrossoverZone } from './paving.js';

// Main-track rails of a chunk (lod 0), swept along the paving rows. On plain track
// gentle alignments keep only every other row; inside a crossover zone every row is
// kept and the rails take the crossover's profiles (switch tongues, check rails) and
// cut attributes (flangeways crossing at the frogs, opened stock rails at the switches).

/** samples: per-row route samples from buildPaving (rows: their s values). */
export function buildMainRails(ctx, chunk, rows, samples, bufs) {
  let kmax = 0;
  for (const S of samples) kmax = Math.max(kmax, Math.abs(S.curv));
  const minGap = kmax < 1 / 400 ? 2.4 : kmax < 1 / 150 ? 1.2 : 0.9;
  const nr = rows.length;
  // crossover plan of each row interval (null outside zones)
  const zone = new Array(nr - 1);
  for (let r = 0; r < nr - 1; r++) {
    const c = inCrossoverZone(ctx, (rows[r] + rows[r + 1]) / 2);
    zone[r] = c ? crossoverPlan(c, ctx.delta) : null;
  }
  for (const rl of MAIN_RAILS) {
    const pts = samples.map((S) => ({
      px: S.px + S.rx * rl.c, py: S.py, pz: S.pz + S.rz * rl.c, rx: S.rx, rz: S.rz, u: S.u, s: S.s, d: rl.c, dd: 0, n: 1,
    }));
    let seg = [], key = null, plan = null;
    // thin the rows on gentle alignments (keep the ends, and every row where `need`)
    const thin = (need) => {
      const keep = [seg[0]];
      for (let i = 1; i < seg.length - 1; i++) {
        const r = seg[i];
        if (rows[r] - rows[keep[keep.length - 1]] >= minGap || need(r) || need(seg[i + 1]) || need(seg[i - 1])) keep.push(r);
      }
      keep.push(seg[seg.length - 1]);
      return keep;
    };
    const flush = () => {
      if (seg.length < 2) return;
      if (!plan) {
        sweepRuns(bufs, ctx.mats.rail, thin(() => false).map((r) => pts[r]), rl.g, () => RUNS_MAIN);
        return;
      }
      // crossover zone: dense rows only where the rail interacts with a diverging one
      const p = plan, cls = key;
      const sp = thin((r) => mainBusy(p, rl, rows[r])).map((r) => pts[r]);
      sweepRuns(bufs, ctx.mats.cut, sp, rl.g, (i) => mainRuns(p, rl, sp[i].s, cls),
        (i, kind, x, sv, dv, out) => mainCut(p, rl, sv, dv, kind, x, out));
    };
    for (let r = 0; r < nr - 1; r++) {
      const p = zone[r];
      const k = p ? mainClass(p, rl, (rows[r] + rows[r + 1]) / 2) : 'n';
      if (k !== key || p !== plan) { flush(); seg = [r]; key = k; plan = p; }
      seg.push(r + 1);
    }
    flush();
  }
}
