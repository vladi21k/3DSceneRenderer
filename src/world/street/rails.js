import { RAIL_PROFILE, RAIL_X0, RAIL_X1, HEAD_HALF, HEAD_DULL, GROOVE_OUT, LIP_OUT, GROUT_W, SEAL_TONE } from './constants.js';

// Embedded grooved rails.
//  - sweepRail(): true 3D cross-section (rubber seals, bevelled head with a polished
//    running band, 36 mm deep flangeway, guard lip) swept along the paving rows.
//  - inlayRail(): the same bands as flat coplanar strips with polygon-offset layers,
//    used inside crossovers where rails cross, split and merge.
//  - railLinePoints(): centre-line points for the far-field anti-aliased overlay.

// --- precomputed profile segments with smoothed normals, grouped into runs: consecutive
// same-kind segments joined by smoothed normals share vertices
function buildRuns(profile) {
  const segs = [];
  for (let j = 1; j < profile.length; j++) {
    const [x0, h0, , ao0, t0] = profile[j - 1], [x1, h1, kind, ao1, t1] = profile[j];
    const dx = x1 - x0, dh = h1 - h0, l = Math.hypot(dx, dh);
    segs.push({ x0, h0, x1, h1, kind, ao0, ao1, t0, t1, nx: -dh / l, nh: dx / l, v0: 0, v1: 0 });
  }
  // smooth normals across gentle corners
  const cosLim = Math.cos((50 * Math.PI) / 180);
  for (const s of segs) { s.n0 = [s.nx, s.nh]; s.n1 = [s.nx, s.nh]; }
  for (let j = 0; j < segs.length - 1; j++) {
    const a = segs[j], b = segs[j + 1];
    const dot = a.nx * b.nx + a.nh * b.nh;
    if (dot > cosLim) {
      let x = a.nx + b.nx, h = a.nh + b.nh;
      const l = Math.hypot(x, h); x /= l; h /= l;
      a.n1 = [x, h]; b.n0 = [x, h];
    }
  }
  // texture v: arc length from the field-side paving edge, unless the profile pins it
  // (head top and gauge corner are mapped onto the rail.head texture's polished bands)
  let acc = 0;
  for (const s of segs) {
    s.v0 = acc; acc += Math.hypot(s.x1 - s.x0, s.h1 - s.h0); s.v1 = acc;
    if (s.kind === 'head' || s.kind === 'gauge') { s.v0 = s.t0 ?? s.v0; s.v1 = s.t1 ?? s.v1; }
  }
  const runs = [];
  let cur = null;
  for (let j = 0; j < segs.length; j++) {
    const sg = segs[j];
    if (cur && cur.kind === sg.kind && segs[j - 1].n1 === sg.n0) cur.segs.push(sg);
    else { cur = { kind: sg.kind, segs: [sg] }; runs.push(cur); }
  }
  for (const r of runs) {
    // vertex colour = cavity AO (× the bitumen tone on the seals, drawn with the mortar)
    const tone = r.kind === 'seal' ? SEAL_TONE : 1;
    const s0 = r.segs[0];
    r.pts = [{ x: s0.x0, h: s0.h0, n: s0.n0, v: s0.v0, c: s0.ao0 * tone }];
    for (const sg of r.segs) r.pts.push({ x: sg.x1, h: sg.h1, n: sg.n1, v: sg.v1, c: sg.ao1 * tone });
  }
  return runs;
}

/** Plain grooved rail. */
export const RUNS_MAIN = buildRuns(RAIL_PROFILE);

/** Stock rail along a switch tongue lying in its flangeway: the guard lip is machined
 *  away, so the groove runs on (widened) to the gauge-side seal. */
export const RUNS_SWITCH = buildRuns(RAIL_PROFILE.map((p) => {
  if (p[0] > 0.085 && p[0] < 0.086) return [p[0], p[1], 'groove', 0.65];   // far groove wall
  if (p[0] < 0.0697 || p[0] > 0.083) return p;
  return [p[0], -0.028 - 0.004 * Math.sin(((p[0] - 0.0698) / 0.013) * Math.PI), 'groove', 0.4];
}));

/**
 * Sweep a grooved-rail profile through the paving rows listed in `rowIdx` (indices into
 * samples from buildPaving). mats: { head, gauge, lip, side, groove, seal }.
 * Main rails: centre line d = c, gauge direction g. With opts.at(row) => {c, dd, y} the
 * rail follows its own path through the rows instead (crossover rails): the profile is
 * laid along each row, stretched by sqrt(1 + dd²) so its true width is kept, and shifted
 * by y vertically. opts.runs selects the profile (RUNS_MAIN by default).
 */
export function sweepRail(out, mats, samples, rowIdx, c, g, opts = {}) {
  if (rowIdx.length < 2) return;
  const runs = opts.runs || RUNS_MAIN, at = opts.at;
  for (const run of runs) {
    const b = out.get(mats[run.kind], true);
    const P = run.pts, np = P.length;
    let prev = -1;
    for (const r of rowIdx) {
      const S = samples[r];
      let cc = c, k = 1, y = 0, px = S.rx, pz = S.rz;
      if (at) {
        const q = at(r);
        cc = q.c; y = q.y; k = Math.sqrt(1 + q.dd * q.dd);
        // the rail's own horizontal perpendicular (normals)
        px = (S.rx - S.tx * q.dd) / k; pz = (S.rz - S.tz * q.dd) / k;
      }
      const first = b.n;
      for (let j = 0; j < np; j++) {
        const p = P[j];
        const d = cc + g * p.x * k, nx = g * p.n[0];
        b.v(S.px + S.rx * d, S.py + p.h + y, S.pz + S.rz * d, px * nx, p.n[1], pz * nx, S.u ?? S.s, p.v, p.c, p.c, p.c);
      }
      if (prev >= 0) {
        for (let j = 0; j < np - 1; j++) {
          const a0 = prev + j, a1 = prev + j + 1, b0 = first + j, b1 = first + j + 1;
          if (g > 0) b.quad(a0, a1, b1, b0);
          else b.quad(a1, a0, b0, b1);
        }
      }
      prev = first;
    }
  }
}

/**
 * Path along which inlays and overlay lines are laid: array of
 * {px, py, pz, rx, rz, s, along} where (rx, rz) is the path's own right vector.
 * pathFn(t) returns {s, d, dd} (route s, lateral d, slope dd/ds) for t in [t0, t1].
 */
export function samplePath(route, surface, pathFn, t0, t1, step) {
  const n = Math.max(1, Math.ceil((t1 - t0) / step));
  const smp = {};
  const pts = [];
  let along = 0, lx = 0, lz = 0;
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const q = pathFn(t);
    route.sample(q.s, smp);
    // world tangent of the path: tanH * 1 + right * dd (per metre of s)
    let tx = smp.tanH.x + smp.right.x * q.dd, tz = smp.tanH.z + smp.right.z * q.dd;
    const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
    const h = surface ? surface.heightAt(q.s, q.d) : 0;
    const px = smp.pos.x + smp.right.x * q.d, pz = smp.pos.z + smp.right.z * q.d;
    if (i > 0) along += Math.hypot(px - lx, pz - lz);
    lx = px; lz = pz;
    pts.push({ px, py: smp.pos.y + h, pz, rx: -tz, rz: tx, s: q.s, d: q.d, t, along });
  }
  return pts;
}

/** Flat strip along a sampled path between lateral offsets x0(p, i), x1(p, i) (path-right
 *  metres; return null to skip the sample). */
export function inlayStrip(buf, pts, fx0, fx1, uScale = 1) {
  let prev = -1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = fx0(p, i), b = fx1(p, i);
    if (a === null || b === null || b - a < 1e-4) { prev = -1; continue; }
    const v = buf.v(p.px + p.rx * a, p.py, p.pz + p.rz * a, 0, 1, 0, p.along * uScale, a);
    buf.v(p.px + p.rx * b, p.py, p.pz + p.rz * b, 0, 1, 0, p.along * uScale, b);
    if (prev >= 0) buf.quad(prev, prev + 1, v + 1, v);
    prev = v;
  }
}

/** Bands of the grooved rail (rail-local x, + towards gauge). */
export const BANDS = {
  groutF: [RAIL_X0 - GROUT_W, RAIL_X0],
  groutG: [RAIL_X1, RAIL_X1 + GROUT_W],
  sealF: [RAIL_X0, -HEAD_HALF],
  cornerF: [-HEAD_HALF, HEAD_DULL],
  head: [HEAD_DULL, HEAD_HALF],
  groove: [HEAD_HALF, GROOVE_OUT],
  lip: [GROOVE_OUT, LIP_OUT],
  sealG: [LIP_OUT, RAIL_X1],
};

const HEADISH = { head: 1, cornerF: 1 };

/**
 * Inlay a whole rail (all bands) along pts (path centre = rail centre line).
 * g: gauge direction relative to the path's right vector. layer: material set
 * { seal, side, head, lip, groove } with increasing polygon offsets.
 * opts.mask(p, band) -> 0..1 (0 skips the sample; for the head bands it also scales
 * the width about the rail centre, which tapers switch blades). opts.grout = false
 * leaves out the mortar strips (where the paving grid already has them).
 */
export function inlayRail(bufs, pts, g, opts = {}) {
  const mask = opts.mask || (() => 1);
  const put = (buf, band, name) => {
    const [x0, x1] = band;
    inlayStrip(buf, pts, (p) => {
      const k = mask(p, name);
      if (k <= 0) return null;
      const a = g > 0 ? x0 : -x1, b = g > 0 ? x1 : -x0;
      return HEADISH[name] ? a * k : a;
    }, (p) => {
      const k = mask(p, name);
      if (k <= 0) return null;
      const a = g > 0 ? x0 : -x1, b = g > 0 ? x1 : -x0;
      return HEADISH[name] ? b * k : b;
    });
  };
  if (bufs.grout && opts.grout !== false) {
    put(bufs.grout, BANDS.groutF, 'groutF');
    put(bufs.grout, BANDS.groutG, 'groutG');
  }
  put(bufs.seal, BANDS.sealF, 'sealF');
  put(bufs.seal, BANDS.sealG, 'sealG');
  put(bufs.side, BANDS.cornerF, 'cornerF');
  put(bufs.head, BANDS.head, 'head');
  put(bufs.lip || bufs.head, BANDS.lip, 'lip');
  put(bufs.groove, BANDS.groove, 'groove');
}

/** Points for a LineBuf ribbon centred on the rail profile (offset so the ribbon covers
 *  the rail and its mortar strips); returns [flat array, halfWidth, centreOffset]. The
 *  ribbon's right vector points to the gauge side. */
export function railLinePoints(pts, g) {
  const cOff = (RAIL_X0 + RAIL_X1) / 2, half = (RAIL_X1 - RAIL_X0) / 2 + GROUT_W;
  const n = pts.length;
  const arr = new Array(n * 6);
  for (let i = 0; i < n; i++) {
    // walk the path backwards when the gauge side is on its left, so the ribbon's
    // right vector (towards the gauge) is always the right of its direction
    const p = pts[g > 0 ? i : n - 1 - i], o = i * 6;
    // ribbon centre sits cOff towards the gauge side
    arr[o] = p.px + p.rx * g * cOff; arr[o + 1] = p.py; arr[o + 2] = p.pz + p.rz * g * cOff;
    arr[o + 3] = p.rx * g; arr[o + 4] = p.rz * g; arr[o + 5] = p.along;
  }
  return [arr, half, cOff];
}
