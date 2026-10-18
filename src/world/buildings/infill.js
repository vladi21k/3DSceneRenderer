import { archPoint, openingOutline } from '../facadePlan.js';
import { FACES, arcSeg, glassTone } from './mesh.js';

// Self-contained opening infill for the openings the facades module does not dress (the
// small windows of exposed party walls and the set-back upper storeys, which are not in
// the shared plan's fronts). Kept simple but complete: glazing at w = −recess, painted
// frames with mullion and transom, closed shutters on some windows, shopfronts with stall
// risers or roller shutters, panelled doors with fanlights. Linear albedo colours (vertex
// colour = paint).

const PAINT = {
  darkgreen: [0.025, 0.06, 0.04], brown: [0.075, 0.042, 0.026], white: [0.58, 0.58, 0.56],
  grey: [0.2, 0.21, 0.21], black: [0.018, 0.018, 0.02], teal: [0.02, 0.09, 0.09],
  lightgrey: [0.42, 0.42, 0.41], cream: [0.55, 0.51, 0.43],
};
// what shows behind the panes (linear albedo, as the light inside the room leaves it):
// net curtains and blinds (white, cream, grey), drawn curtains (fabric colours), rooms
const SHEER = [[0.6, 0.59, 0.56], [0.58, 0.55, 0.48], [0.5, 0.5, 0.49], [0.55, 0.5, 0.42], [0.46, 0.45, 0.43]];
const DRAPE = [[0.5, 0.43, 0.32], [0.4, 0.2, 0.15], [0.3, 0.33, 0.25], [0.28, 0.32, 0.38], [0.55, 0.5, 0.42], [0.42, 0.36, 0.3], [0.52, 0.52, 0.5]];
const BLIND = [[0.6, 0.6, 0.58], [0.56, 0.53, 0.46], [0.45, 0.45, 0.45], [0.52, 0.47, 0.38]];
const ROOM = [[0.036, 0.034, 0.032], [0.05, 0.045, 0.04], [0.068, 0.06, 0.05], [0.042, 0.043, 0.047]];
const SHOP_GLASS = glassTone([0.03, 0.032, 0.034]);
const STALL = [0.05, 0.05, 0.048];
const ROLLER = [0.3, 0.3, 0.29];
const DOOR = [0.09, 0.05, 0.03];
const GOODS = [[0.16, 0.11, 0.07], [0.08, 0.09, 0.12], [0.19, 0.16, 0.11], [0.1, 0.12, 0.08], [0.22, 0.19, 0.16], [0.14, 0.05, 0.04]];
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
  glazing(B, sinks.glass, o, w0 - 0.012, arched, arched ? arcSeg(q, o) : 1, shop, door, rng);

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
    // the shop seen through the glass (from these distances a flat picture is enough):
    // dim warm back wall and ceiling above, shelves of goods below
    const wi = w0 - 0.006, gTop = o.y + Math.min(1.7, (lowTop - o.y) * 0.62);
    B.flat = [0.2, 0.165, 0.13].map((c) => c * rng.range(0.8, 1.2));
    B.rectW(sF, u0 + fw, u1 - fw, gTop, lowTop, wi, 1);
    for (let u = u0 + fw, k = 0; u < u1 - fw - 0.01; k++) {
      const du = Math.min(u1 - fw - u, rng.range(0.25, 0.6));
      B.flat = rng.pick(GOODS).map((c) => c * rng.range(0.7, 1.15));
      B.rectW(sF, u, u + du, o.y + 0.42, gTop, wi, 1);
      u += du;
    }
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
  } else if (o.shutters === 'roller') {
    rollerShutter(B, sF, o, w0, yt, ctx.rollerCol || ROLLER, q);
  } else if (o.shutters === 'open') {
    openLeaves(B, sF, o, face, q);
  } else if (o.shutters === 'none') {
    // (bare glazing)
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

/**
 * Roller shutter let down o.roller (0..1) of the opening from the head, in front of the
 * glazing, in its guide rails: slats in bands of slightly different tone (one face far).
 */
function rollerShutter(B, s, o, w0, yt, col, q) {
  const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2;
  const down = Math.max(0.12, Math.min(1, o.roller ?? 0.5) * o.h);
  const yb = yt - down, ws = w0 + 0.07;
  if (q.lod) {
    B.flat = col;
    B.rectW(s, u0 + 0.01, u1 - 0.01, yb, yt, ws, 1);
  } else {
    const n = Math.max(1, Math.round(down / 0.16));
    for (let k = 0; k < n; k++) {
      const c = 0.93 + 0.07 * ((k * 5) % 3) / 2;
      B.flat = col.map((x) => x * c);
      B.rectW(s, u0 + 0.01, u1 - 0.01, yt - ((k + 1) * down) / n, yt - (k * down) / n, ws, 1);
    }
    // bottom rail, catching the light
    B.flat = col.map((x) => x * 0.75);
    B.box(s, u0 + 0.01, u1 - 0.01, yb, yb + 0.04, ws - 0.01, ws + 0.012, FACES.FRONT | FACES.BOTTOM);
    B.flat = col.map((x) => x * 0.85);
    for (const u of [u0, u1 - 0.03]) B.box(s, u, u + 0.03, o.y, yt, ws - 0.02, ws + 0.015, FACES.FRONT | FACES.LEFT | FACES.RIGHT);
  }
}

/** Louvred shutter leaves folded back against the wall either side of the opening. */
function openLeaves(B, s, o, face, q) {
  const col = paint(face.style.shutterColor);
  const lw = o.w / 2, yb = o.y, yt = o.y + o.h - (o.rise || 0);
  for (const [a, b] of [[o.uc - o.w / 2 - lw - 0.02, o.uc - o.w / 2 - 0.02], [o.uc + o.w / 2 + 0.02, o.uc + o.w / 2 + lw + 0.02]]) {
    B.flat = col.map((x) => x * 0.8);
    B.box(s, a, b, yb, yt, 0.004, 0.035, q.lod ? FACES.FRONT : FACES.FRONT | FACES.LEFT | FACES.RIGHT | FACES.TOP | FACES.BOTTOM);
    if (q.lod) continue;
    // louvres: lighter slat faces between darker gaps, inside a stile frame
    const nb = Math.max(4, Math.round((yt - yb - 0.16) / 0.09));
    for (let k = 0; k < nb; k++) {
      const v0 = yb + 0.08 + ((yt - yb - 0.16) * k) / nb, v1 = v0 + ((yt - yb - 0.16) / nb) * 0.62;
      B.flat = col.map((x) => x * (0.95 + 0.05 * (k % 2)));
      B.rectW(s, a + 0.05, b - 0.05, v0, v1, 0.037, 1);
    }
  }
}

/**
 * The panes of an opening at depth w, and what shows through them: about a third of the
 * windows have net curtains, some curtains drawn to the sides, blinds let down part of
 * the way, dark rooms, a few open casements (no reflection: colour alpha flag 0.25, with
 * the night-lit flag 0.75). Each window's panes lean a degree or two (their normal), so
 * neighbouring windows mirror different parts of the sky. (o.curtain: the plan's hint.)
 */
function glazing(B, s, o, w, arched, n, shop, door, rng) {
  const lit = o.lit != null && o.lit < 0.32;
  const tu = rng.range(-0.035, 0.035), tv = rng.range(-0.03, 0.03);
  B.shade = null;
  if (shop || door) {
    B.flat = SHOP_GLASS;
    B.grime = shop || lit ? 0.75 : 0;
    pane(B, s, o, w, n, tu, tv);
    B.grime = 0; B.flat = [1, 1, 1];
    return;
  }
  const h = rng.next();
  const kind = o.curtain ? (h < 0.55 ? 'sheer' : h < 0.8 ? 'drawn' : 'room') : (h < 0.5 ? 'room' : h < 0.82 ? 'blind' : 'open');
  const room = glassTone(rng.pick(ROOM).map((c) => c * rng.range(0.85, 1.2)));
  B.grime = (lit ? 0.75 : 0) + (kind === 'open' ? 0.25 : 0);
  const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2, top = arched ? o.spring : o.y + o.h;
  if (kind === 'sheer' || ((kind === 'drawn' || kind === 'blind') && arched)) {
    // net curtain over the whole window (a little darker low down, where it hangs in folds)
    const c = (kind === 'drawn' ? rng.pick(DRAPE) : rng.pick(SHEER)).map((x) => x * rng.range(0.85, 1.08));
    B.flat = glassTone(c);
    pane(B, s, o, w, n, tu, tv);
  } else if (kind === 'drawn') {
    // curtains drawn back to both sides, the room dark between them
    const c = glassTone(rng.pick(DRAPE).map((x) => x * rng.range(0.85, 1.1)));
    const a = o.w * rng.range(0.18, 0.32), b = o.w * rng.range(0.18, 0.32);
    B.flat = c; quad(B, s, u0, u0 + a, o.y, top, w, tu, tv);
    B.flat = room; quad(B, s, u0 + a, u1 - b, o.y, top, w, tu, tv);
    B.flat = c; quad(B, s, u1 - b, u1, o.y, top, w, tu, tv);
  } else if (kind === 'blind') {
    // a blind let down part of the way from the head
    const yb = top - (top - o.y) * rng.range(0.25, 0.8);
    B.flat = glassTone(rng.pick(BLIND).map((x) => x * rng.range(0.9, 1.06)));
    quad(B, s, u0, u1, yb, top, w, tu, tv);
    B.flat = room; quad(B, s, u0, u1, o.y, yb, w, tu, tv);
  } else {
    B.flat = room;
    pane(B, s, o, w, n, tu, tv);
  }
  B.grime = 0;
  B.flat = [1, 1, 1];
}

/** Flat polygon of the opening outline at depth w (fan; outlines are convex), normal leaning (tu, tv). */
function pane(B, s, o, w, n, tu = 0, tv = 0) {
  const pts = openingOutline(o, Math.max(1, n));
  const m = pts.length >> 1;
  s.reserve(m, (m - 2) * 3);
  const base = s.vc;
  for (let k = 0; k < m; k++) B.v(s, pts[k * 2], pts[k * 2 + 1], w, tu, tv, 1, pts[k * 2], pts[k * 2 + 1]);
  for (let k = 1; k < m - 1; k++) B.tri(s, base, base + k, base + k + 1);
}

/** Pane rectangle at depth w facing +w, normal leaning (tu, tv). UV = (u, v). */
function quad(B, s, u0, u1, v0, v1, w, tu, tv) {
  if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return;
  s.reserve(4, 6);
  const a = B.v(s, u0, v0, w, tu, tv, 1, u0, v0), b = B.v(s, u1, v0, w, tu, tv, 1, u1, v0);
  const c = B.v(s, u1, v1, w, tu, tv, 1, u1, v1), d = B.v(s, u0, v1, w, tu, tv, 1, u0, v1);
  B.quadIdx(s, a, b, c, d);
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
