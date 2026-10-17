import { archPoint, openingOutline } from '../facadePlan.js';
import { FACES, arcSeg } from './mesh.js';

// Self-contained opening infill for buildings-only lots (the facades closing the far end
// of side streets), which the facades module does not dress. Seen from 60–120 m, so it is
// kept simple but complete: glazing at w = −recess, painted frames with mullion and
// transom, closed shutters on some windows, shopfronts with stall risers or roller
// shutters, panelled doors with fanlights. Linear albedo colours (vertex colour = paint).

const PAINT = {
  darkgreen: [0.025, 0.06, 0.04], brown: [0.075, 0.042, 0.026], white: [0.58, 0.58, 0.56],
  grey: [0.2, 0.21, 0.21], black: [0.018, 0.018, 0.02], teal: [0.02, 0.09, 0.09],
};
const STALL = [0.05, 0.05, 0.048];
const ROLLER = [0.3, 0.3, 0.29];
const DOOR = [0.09, 0.05, 0.03];
const _p = {}, _q = {};

/** Paint colour by plan colour name (linear albedo). */
export const paint = (name) => PAINT[name] || PAINT.grey;

/**
 * Infill of opening `o` (facade-local, w = 0 is the wall face). sinks: glass, frame
 * (frames, shutters, doors: one painted batch). `lit` (0..1) is written to the per-vertex
 * grime slot of the glass so the buildings glass material can light it at night.
 */
export function openingInfill(ctx, face, o, rng) {
  const { B, sinks, q } = ctx;
  const R = o.recess, w0 = -R;
  const arched = o.top !== 'flat' && o.rise > 0.01;
  const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2, ys = o.spring, yt = o.y + o.h;
  const shop = o.kind === 'shop', door = o.kind === 'door';
  const frameCol = paint(face.style.frameColor);
  const n = Math.max(4, q.archSeg >> 1);
  B.shade = null;

  // glazing (the whole outline; doors and shutters cover parts of it)
  B.flat = [1, 1, 1];
  B.grime = shop ? 0.9 : (o.lit != null && o.lit < 0.32 ? 0.75 : 0);
  pane(B, sinks.glass, o, w0 - 0.012, arched ? arcSeg(q, o) : 1);
  B.grime = 0;

  // frame: jambs, sill / head rails, arched head ring
  const fw = shop ? 0.08 : 0.055, wf = w0 + 0.035, wb = w0 - 0.025;
  const sF = sinks.frame;
  B.flat = shop ? STALL.map((c, i) => c * 0.5 + frameCol[i] * 0.5) : frameCol;
  B.box(sF, u0, u0 + fw, o.y, ys, wb, wf, FACES.FRONT | FACES.RIGHT);
  B.box(sF, u1 - fw, u1, o.y, ys, wb, wf, FACES.FRONT | FACES.LEFT);
  B.box(sF, u0 + fw, u1 - fw, o.y, o.y + fw * 1.3, wb, wf, FACES.FRONT | FACES.TOP);
  if (!arched) B.box(sF, u0 + fw, u1 - fw, yt - fw, yt, wb, wf, FACES.FRONT | FACES.BOTTOM);
  else archRing(B, sF, o, fw, wb, wf, arcSeg(q, o));

  // transom and mullions
  const top = arched ? ys : yt - fw;
  let tr = null;
  if (arched) tr = ys;
  else if (!shop && o.h > 1.9) tr = o.y + o.h * 0.74;
  else if ((shop || door) && o.h > 2.7) tr = yt - 0.62;
  if (tr !== null) B.box(sF, u0 + fw, u1 - fw, tr - 0.028, tr + 0.028, wb, wf - 0.005, FACES.FRONT | FACES.TOP | FACES.BOTTOM);
  const lowTop = tr !== null ? tr - 0.028 : top;
  if (q.lod === 0 || shop) {
    const nm = shop ? Math.max(1, Math.round(o.w / 1.25)) : (o.w > 0.75 ? 2 : 1);
    for (let k = 1; k < nm; k++) {
      const u = u0 + (o.w * k) / nm;
      B.box(sF, u - 0.025, u + 0.025, o.y + fw, shop ? lowTop : top, wb, wf - 0.008, FACES.FRONT | FACES.LEFT | FACES.RIGHT);
    }
  }

  if (shop) {
    // stall riser, and some shops closed by a roller shutter
    B.flat = STALL;
    B.box(sF, u0 + fw, u1 - fw, o.y, o.y + 0.42, wb, wf - 0.005, FACES.FRONT | FACES.TOP);
    if (rng.chance(0.28)) {
      const vt = lowTop, wr = w0 + 0.07;
      for (let v = o.y, k = 0; v < vt - 0.01; v += 0.55, k++) {
        const c = 0.9 + 0.1 * (k % 2);
        B.flat = ROLLER.map((x) => x * c);
        B.rectW(sF, u0 + 0.01, u1 - 0.01, v, Math.min(vt, v + 0.55), wr, 1);
      }
    }
  } else if (door) {
    // panelled door leaves below the transom (or the spring line)
    const dt = tr !== null ? tr - 0.028 : top;
    B.flat = DOOR;
    B.rectW(sF, u0 + fw, o.uc - 0.006, o.y, dt, w0 + 0.02, 1);
    B.rectW(sF, o.uc + 0.006, u1 - fw, o.y, dt, w0 + 0.02, 1);
    B.flat = DOOR.map((c) => c * 0.7);
    for (const [a, b] of [[u0 + fw + 0.08, o.uc - 0.08], [o.uc + 0.08, u1 - fw - 0.08]]) {
      if (b - a > 0.15) B.box(sF, a, b, o.y + 0.25, o.y + 0.25 + (dt - o.y) * 0.38, w0 + 0.02, w0 + 0.035, FACES.FRONT | FACES.TOP);
    }
  } else if (o.shutters === 'closed' || rng.chance(0.35)) {
    // closed louvred shutters over the rectangular part (fanlights stay glazed)
    const col = paint(face.style.shutterColor);
    const ws = w0 + 0.065, vt = arched ? ys : yt;
    const nb = Math.max(2, Math.round((vt - o.y) / 0.42));
    for (const [a, b] of [[u0 + 0.008, o.uc - 0.006], [o.uc + 0.006, u1 - 0.008]]) {
      for (let k = 0; k < nb; k++) {
        const c = 0.86 + 0.14 * ((k * 7 + (a > o.uc ? 3 : 0)) % 3) / 2;
        B.flat = col.map((x) => x * c);
        B.rectW(sF, a, b, o.y + ((vt - o.y) * k) / nb, o.y + ((vt - o.y) * (k + 1)) / nb, ws, 1);
      }
    }
  }
  B.flat = [1, 1, 1];
}

/** Flat polygon of the opening outline at depth w (fan; outlines are convex). */
function pane(B, s, o, w, n) {
  const pts = openingOutline(o, Math.max(1, n));
  const m = pts.length >> 1;
  s.reserve(m, (m - 2) * 3);
  const base = s.vc;
  for (let k = 0; k < m; k++) B.v(s, pts[k * 2], pts[k * 2 + 1], w, 0, 0, 1, pts[k * 2], pts[k * 2 + 1]);
  for (let k = 1; k < m - 1; k++) B.tri(s, base, base + k, base + k + 1);
}

/** Frame ring following an arched head: front face and the inner (soffit) face. */
function archRing(B, s, o, fw, wb, wf, n) {
  s.reserve((n + 1) * 4, n * 12);
  let a0 = -1, b0 = -1, c0 = -1, d0 = -1;
  for (let k = 0; k <= n; k++) {
    archPoint(o, k / n, _p, 0);
    archPoint(o, k / n, _q, -fw);
    const a = B.v(s, _p.u, _p.v, wf, 0, 0, 1, _p.u, _p.v);
    const b = B.v(s, _q.u, _q.v, wf, 0, 0, 1, _q.u, _q.v);
    const c = B.v(s, _q.u, _q.v, wf, -_q.ru, -_q.rv, 0, k / n, 0);
    const d = B.v(s, _q.u, _q.v, wb, -_q.ru, -_q.rv, 0, k / n, 1);
    if (k) {
      // left → right over the crown: (a0, b0, b, a) faces +w; (d0, d, c, c0) faces the arch centre
      B.quadIdx(s, a0, b0, b, a);
      B.quadIdx(s, d0, d, c, c0);
    }
    a0 = a; b0 = b; c0 = c; d0 = d;
  }
}
