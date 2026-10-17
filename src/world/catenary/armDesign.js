import { turtle, scroll, lowestAfter } from './paths.js';

// The ornamental lamp bracket ("swan neck" with forged scrolls), drawn in its own plane:
// x = outward from the pole axis, y = up from the lower bracket collar. Pure data so it
// can be plotted offline and swept into geometry at runtime.
//
// Elements: {pts, prof: 'tube', r} for round tube, {pts, prof: 'bar', w, t} for forged
// flat bar (w = in-plane thickness, t = depth across the plane).

export function armDesign(reach = 1.0, { ornate = true } = {}) {
  const els = [];

  // short foot stub from the lower collar
  els.push({ pts: [[0.0, 0.0], [0.15, 0.0]], prof: 'tube', r: 0.024, name: 'foot' });

  // main swan neck: rises steeply from the foot, arches over and curls down into a
  // clockwise crook; the lantern hangs from the bottom of the crook
  const main = turtle(0.13, 0.0, 1.42, [
    [0.06, 0.0, -0.3],
    [0.42, -0.3, -0.85],
    [0.55, -0.85, -1.6],
    [0.33, -1.6, -2.7],
    [0.44, -2.7, -19],
  ]);
  els.push({ pts: main, prof: 'tube', r: 0.025, name: 'main' });

  // upper tie from the upper collar to the neck
  els.push({ pts: [[0.0, 0.5], [0.3, 0.5]], prof: 'bar', w: 0.02, t: 0.022, name: 'tie' });

  if (ornate) {
    // inner C-scroll hugging the neck, then peeling away into a curl under the arch
    const s1 = scroll({
      ctrl: [[0.34, 0.1], [0.3, 0.26], [0.29, 0.44], [0.37, 0.62], [0.5, 0.7]],
      startCurl: { len: 0.26, k0: 5, k1: 34 },
      endCurl: { len: 0.44, k0: -3, k1: -26 },
    });
    els.push({ pts: s1, prof: 'bar', w: 0.017, t: 0.022, name: 'sscroll' });

    // lower bracket: C-scroll from the shaft up to the foot
    const c1 = scroll({
      ctrl: [[0.15, 0.0], [0.17, -0.12], [0.12, -0.26], [0.03, -0.36]],
      startCurl: null,
      endCurl: null,
    });
    els.push({ pts: c1, prof: 'bar', w: 0.018, t: 0.022, name: 'strut' });
    const c2 = scroll({
      ctrl: [[0.16, -0.1], [0.22, -0.15]],
      endCurl: { len: 0.16, k0: 6, k1: 44 },
    });
    els.push({ pts: c2, prof: 'bar', w: 0.014, t: 0.02, name: 'strutCurl' });

    // small curl on the tie
    const c3 = scroll({
      ctrl: [[0.06, 0.5], [0.1, 0.42]],
      endCurl: { len: 0.17, k0: 5, k1: 45 },
    });
    els.push({ pts: c3, prof: 'bar', w: 0.013, t: 0.018, name: 'tieCurl' });
  }

  const crookStart = Math.floor(main.length * 0.7);
  const hang = lowestAfter(main.slice(0, Math.floor(main.length * 0.9)), crookStart);

  const S = reach;
  return {
    elements: els.map((e) => ({ ...e, pts: e.pts.map(([x, y]) => [x * S, y * S]) })),
    hang: [hang[0] * S, hang[1] * S],
    collars: [0, 0.5 * S, -0.36 * S],
    top: Math.max(...main.map((p) => p[1])) * S,
  };
}
