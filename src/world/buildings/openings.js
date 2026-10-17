import { archPoint } from '../facadePlan.js';
import { FACES } from './mesh.js';
import { trimColor } from './shade.js';

// Masonry around each opening. The opening itself stays empty for the facade infill
// (frames, glass, shopfronts, doors at w = −recess). Here:
//   reveals  jambs, sill/threshold and head soffit (flat or curved) from w = 0 to −recess
//   interior a dark box from −recess to −recess − 0.4, closed at the back
//   dressing surrounds, voussoir rings with keystones, flat arches, lintels, hoods,
//            sills with optional corbels, thresholds and steps down to a lower paving

const DARK = [0.035, 0.032, 0.03];
const _p = {}, _q = {}, _r = {}, _s = {};

export function openingMasonry(ctx, face, o) {
  const { B, sinks, q, fs, orn } = ctx;
  const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2;
  const y0 = o.y, ys = o.spring, yt = o.y + o.h;
  const R = o.recess;
  const arched = o.top !== 'flat' && o.rise > 0.01;
  const ground = o.floor === 0;
  const sRev = sinks.smooth;

  // ---------------------------------------------------------------- reveals
  B.shade = (u, v, w, nu, nv, nw, out) => {
    trimColor(fs, u, v, 0, out, 1.0);
    const d = Math.min(1, -w / Math.max(0.05, R));
    const k = (1 - 0.42 * Math.pow(d, 0.8)) * (nv < -0.3 ? 0.8 : nv > 0.5 ? 0.95 : 1);
    out[0] *= k; out[1] *= k; out[2] *= k;
  };
  B.rectU(sRev, u0, y0, ys, -R, 0, 1);
  B.rectU(sRev, u1, y0, ys, -R, 0, -1);
  B.rectV(sRev, u0, u1, -R, 0, y0, 1);
  if (!arched) B.rectV(sRev, u0, u1, -R, 0, yt, -1);
  else soffit(B, sRev, o, -R, 0, q.archSeg);

  // ---------------------------------------------------------------- dark interior
  const sD = sinks.dark;
  B.shade = null; B.flat = DARK;
  if (q.interior) {
    const Ri = R + 0.4;
    B.rectU(sD, u0, y0, ys, -Ri, -R, 1);
    B.rectU(sD, u1, y0, ys, -Ri, -R, -1);
    B.rectV(sD, u0, u1, -Ri, -R, y0, 1);
    if (!arched) B.rectV(sD, u0, u1, -Ri, -R, yt, -1);
    else soffit(B, sD, o, -Ri, -R, Math.max(4, q.archSeg >> 1));
    backFace(B, sD, o, -Ri, Math.max(4, q.archSeg >> 1));
  } else {
    backFace(B, sD, o, -R - 0.02, Math.max(3, q.archSeg >> 1));
  }
  B.flat = [1, 1, 1];

  // ---------------------------------------------------------------- dressing
  const sT = sinks.smooth;
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(fs, u, v, nv, out, 1.05);
  const isWin = o.kind === 'window' || o.kind === 'balconyDoor';
  const surround = surroundOf(o, face, orn);
  const sp = surround ? orn.sp : 0;
  const bev = q.bevel ? 0.012 : 0;

  // jambs of the surround
  if (surround) {
    B.bevelBox(sT, u0 - surround, u0, y0, ys, 0, sp, bev, FACES.ALL & ~FACES.BOTTOM);
    B.bevelBox(sT, u1, u1 + surround, y0, ys, 0, sp, bev, FACES.ALL & ~FACES.BOTTOM);
    // crossettes: the architrave steps out sideways just below the head
    if (orn.ears && isWin && !arched && q.lod === 0) {
      const eh = Math.min(0.22, (ys - y0) * 0.12), ew = 0.08;
      B.bevelBox(sT, u0 - surround - ew, u0 - surround + 0.01, ys - eh, ys, 0, sp, bev * 0.5, FACES.ALL & ~FACES.RIGHT);
      B.bevelBox(sT, u1 + surround - 0.01, u1 + surround + ew, ys - eh, ys, 0, sp, bev * 0.5, FACES.ALL & ~FACES.LEFT);
    }
  }

  // head
  if (arched) {
    const T = ground ? orn.shopRing : (surround ? surround * 1.3 : orn.ring);
    const proj = ground ? orn.shopRingP : (surround ? sp : 0.012);
    voussoirRing(ctx, sT, o, T, proj, orn.keystone || ground, bev);
  } else {
    const { kind, ext, H } = flatHead(o, orn, surround, ctx.ch);
    const proj = surround ? sp : (ground ? 0.02 : 0.012);
    if (kind === 'flatArch') flatArch(ctx, sT, o, ext, H, proj, bev);
    else if (kind === 'hood') { lintel(ctx, sT, o, ext, H, proj, bev, orn.keystone); hood(ctx, sT, o, ext, yt + H); }
    else lintel(ctx, sT, o, ext, H, proj, bev, orn.keystone && kind !== 'plain');
  }

  // sill
  if (o.kind === 'window') {
    const ext = (surround || 0.06) + 0.07;
    const h = orn.sillH, p = sp + orn.sillP;
    B.bevelBox(sT, u0 - ext, u1 + ext, y0 - h, y0 + 0.004, 0, p, bev, FACES.ALL);
    // raised apron panel under the sill
    if (orn.apron && o.floor > 0) {
      const ah = Math.min(0.7, (y0 - h) - (face.floors[o.floor].y + 0.25));
      if (ah > 0.25) B.bevelBox(sT, u0, u1, y0 - h - ah, y0 - h - 0.02, 0, 0.018, bev * 0.6, FACES.ALL);
    }
    if (orn.sillCorbels && q.lod === 0) {
      for (const cu of [u0 - ext + 0.05, u1 + ext - 0.17]) B.bevelBox(sT, cu, cu + 0.12, y0 - h - 0.2, y0 - h, 0, p - 0.03, bev, FACES.ALL & ~FACES.TOP);
    }
  }

  // threshold and steps at ground openings
  if (ground) {
    const gA = face.groundAt(u0), gB = face.groundAt(u1);
    const gMin = Math.min(gA, gB);
    const rise = y0 - gMin;
    B.bevelBox(sT, u0 - 0.04, u1 + 0.04, Math.min(y0 - 0.12, gMin - 0.05), y0 + 0.004, -0.03, 0.05, bev, FACES.ALL & ~FACES.BOTTOM);
    if (q.steps && rise > 0.2) {
      const n = Math.ceil(rise / 0.17), r = rise / n, tread = 0.3;
      for (let k = 1; k < n; k++) {
        const top = y0 - k * r;
        B.bevelBox(sT, u0 - 0.1, u1 + 0.1, gMin - 0.12, top, 0, 0.05 + k * tread, bev * 0.6, FACES.FRONT | FACES.TOP | FACES.LEFT | FACES.RIGHT);
      }
    }
    if (o.kind === 'door' && orn.doorHood && q.lod === 0) doorHood(ctx, sT, o, surround, arched ? orn.shopRing : 0);
  }
  B.shade = null;
}

/** Width of the smooth surround around an opening (0 = none). */
export function surroundOf(o, face, orn) {
  const isWin = o.kind === 'window' || o.kind === 'balconyDoor';
  return isWin ? (face.style.surrounds ? orn.sw : 0) : (o.kind === 'door' && orn.doorSurround ? orn.sw * 1.3 : 0);
}

/**
 * Head over a flat-topped opening: lintel, flat (jack) arch or lintel with a hood; on
 * the upper floors it is one ashlar course (ch) tall, so the courses run on above it.
 */
export function flatHead(o, orn, surround, ch) {
  const ground = o.floor === 0;
  const kind = ground ? orn.shopHead : orn.winHead;
  const ext = surround || (ground ? 0.2 : 0.12);
  const H = ground ? (kind === 'flatArch' ? 0.42 : 0.38) : ch ? Math.min(0.45, Math.max(0.26, ch)) : (kind === 'flatArch' ? 0.3 : 0.26);
  return { kind, ext, H };
}

/** Curved soffit of an arched head between w0 and w1 (normals point into the opening). */
function soffit(B, s, o, w0, w1, n) {
  s.reserve((n + 1) * 2, n * 6);
  let a0 = -1, b0 = -1, acc = 0, pu = 0, pv = 0;
  for (let k = 0; k <= n; k++) {
    archPoint(o, k / n, _p);
    if (k) acc += Math.hypot(_p.u - pu, _p.v - pv);
    pu = _p.u; pv = _p.v;
    const a = B.v(s, _p.u, _p.v, w0, -_p.ru, -_p.rv, 0, acc, w0);
    const b = B.v(s, _p.u, _p.v, w1, -_p.ru, -_p.rv, 0, acc, w1);
    // the curve runs left → right over the crown, so (a0, a, b, b0) faces the arch centre
    if (k) B.quadIdx(s, a0, a, b, b0);
    a0 = a; b0 = b;
  }
}

/** Back face of the opening box at depth w (facing the street). */
function backFace(B, s, o, w, n) {
  const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2;
  const arched = o.top !== 'flat' && o.rise > 0.01;
  s.reserve(n + 4, n * 3 + 6);
  const c = B.v(s, o.uc, o.y, w, 0, 0, 1, o.uc, o.y);
  const a = B.v(s, u0, o.y, w, 0, 0, 1, u0, o.y);
  const b = B.v(s, u1, o.y, w, 0, 0, 1, u1, o.y);
  let prev = b;
  if (!arched) {
    const d = B.v(s, u1, o.y + o.h, w, 0, 0, 1, u1, o.y + o.h), e = B.v(s, u0, o.y + o.h, w, 0, 0, 1, u0, o.y + o.h);
    B.tri(s, c, b, d); B.tri(s, c, d, e); B.tri(s, c, e, a);
    return;
  }
  for (let k = n; k >= 0; k--) {
    archPoint(o, k / n, _p);
    const i = B.v(s, _p.u, _p.v, w, 0, 0, 1, _p.u, _p.v);
    B.tri(s, c, prev, i);
    prev = i;
  }
  B.tri(s, c, prev, a);
}

/** Ring of voussoirs around an arched head; odd count with a keystone at the crown. */
function voussoirRing(ctx, s, o, T, proj, keystone, bev) {
  const { B, q } = ctx;
  // arc length estimate
  let L = 0, pu = 0, pv = 0;
  for (let k = 0; k <= 16; k++) { archPoint(o, k / 16, _p, T * 0.5); if (k) L += Math.hypot(_p.u - pu, _p.v - pv); pu = _p.u; pv = _p.v; }
  let n = Math.max(5, Math.round(L / (T > 0.36 ? 0.42 : 0.3)));
  if (n % 2 === 0) n++;
  const mid = (n - 1) >> 1;
  // keystone takes 1.5 shares
  const shares = n + 0.5;
  const tk0 = mid / shares, tk1 = (mid + 1.5) / shares;
  if (!q.voussoirs) {
    // far detail: the ring as two smooth bands either side of the same keystone as near
    const hasKey = keystone;
    const bands = hasKey ? [[0, tk0], [tk1, 1]] : [[0, 1]];
    for (const [a, b] of bands) {
      const m = Math.max(2, Math.round(q.archSeg * (b - a)));
      for (let k = 0; k < m; k++) {
        const ta = a + ((b - a) * k) / m, tb = a + ((b - a) * (k + 1)) / m;
        archPoint(o, ta, _p); archPoint(o, tb, _q); archPoint(o, tb, _r, T); archPoint(o, ta, _s, T);
        B.prism(s, [_p.u, _p.v, _q.u, _q.v, _r.u, _r.v, _s.u, _s.v], 0, proj, 0, k === 0 || k === m - 1);
      }
    }
    if (hasKey) {
      archPoint(o, tk0, _p); archPoint(o, tk1, _q); archPoint(o, tk1, _r, T + 0.08); archPoint(o, tk0, _s, T + 0.08);
      B.prism(s, [_p.u, _p.v, _q.u, _q.v, _r.u, _r.v, _s.u, _s.v], 0, proj + 0.03, 0, true);
    }
    return;
  }
  const joint = 0.006 / Math.max(0.5, L);
  let t = 0;
  for (let k = 0; k < n; k++) {
    const isKey = keystone && k === mid;
    const dt = (k === mid ? 1.5 : 1) / shares;
    const ta = t + (k ? joint : 0), tb = t + dt - (k < n - 1 ? joint : 0);
    t += dt;
    const ext = isKey ? T + 0.08 : T;
    archPoint(o, ta, _p); archPoint(o, tb, _q); archPoint(o, tb, _r, ext); archPoint(o, ta, _s, ext);
    const pts = [_p.u, _p.v, _q.u, _q.v, _r.u, _r.v, _s.u, _s.v];
    if (isKey) {
      // keystone: tapered, projecting a little further, with dressed edges
      B.prism(s, pts, 0, proj + 0.03, bev ? bev * 1.2 : 0, true);
    } else {
      B.prism(s, pts, 0, proj, 0, true);
    }
  }
}

/** Flat (jack) arch: voussoirs fanning from a point below the head, keystone in the middle. */
function flatArch(ctx, s, o, ext, H, proj, bev) {
  const { B } = ctx;
  const u0 = o.uc - o.w / 2 - ext, u1 = o.uc + o.w / 2 + ext, yt = o.y + o.h;
  const cy = yt - o.w * 1.1; // fan centre
  let n = Math.max(5, Math.round((u1 - u0) / 0.28)); if (n % 2 === 0) n++;
  const mid = (n - 1) >> 1, shares = n + 0.5;
  let x = u0;
  const W = u1 - u0, j = 0.003;
  for (let k = 0; k < n; k++) {
    const dx = (k === mid ? 1.5 : 1) * W / shares;
    const xa = x + (k ? j : 0), xb0 = x + dx - (k < n - 1 ? j : 0);
    x += dx;
    const key = k === mid;
    const top = key ? H + 0.06 : H;
    const sc = (yt + top - cy) / (yt - cy);
    const pts = [xa, yt, xb0, yt, o.uc + (xb0 - o.uc) * sc, yt + top, o.uc + (xa - o.uc) * sc, yt + top];
    // the outermost voussoirs are cut vertical at the ends of the head
    if (k === 0) pts[6] = Math.max(pts[6], u0 - 0.06);
    if (k === n - 1) pts[4] = Math.min(pts[4], u1 + 0.06);
    B.prism(s, pts, 0, key ? proj + 0.025 : proj, key && bev ? bev : 0, true);
  }
}

/** Plain lintel block across the head, optional raised keystone. */
function lintel(ctx, s, o, ext, H, proj, bev, keystone) {
  const { B } = ctx;
  const u0 = o.uc - o.w / 2 - ext, u1 = o.uc + o.w / 2 + ext, yt = o.y + o.h;
  B.bevelBox(s, u0, u1, yt, yt + H, 0, proj + 0.004, bev, FACES.ALL & ~FACES.BOTTOM);
  B.rectV(s, o.uc - o.w / 2, o.uc + o.w / 2, 0, proj + 0.004, yt, -1);
  if (keystone) {
    const kw = Math.min(0.32, o.w * 0.22);
    B.prism(s, [o.uc - kw * 0.4, yt - 0.04, o.uc + kw * 0.4, yt - 0.04, o.uc + kw * 0.55, yt + H + 0.05, o.uc - kw * 0.55, yt + H + 0.05], 0, proj + 0.03, bev, true);
  }
}

/** Small cornice hood over a head (window or door). */
function hood(ctx, s, o, ext, v0) {
  const { B } = ctx;
  const u0 = o.uc - o.w / 2 - ext - 0.07, u1 = o.uc + o.w / 2 + ext + 0.07;
  B.extrudeU(s, HOOD, u0, u1, v0, [true, true]);
}
const HOOD = [[0, 0], [0.04, 0], [0.05, 0.03], [0.09, 0.07], [0.13, 0.09], [0.13, 0.15], [0.15, 0.17], [0.15, 0.2], [0, 0.22]];

/** Entrance portal hood on two consoles (clear of the voussoir ring of an arched door). */
function doorHood(ctx, s, o, surround, ring) {
  const { B } = ctx;
  const yt = ring ? o.y + o.h + ring + 0.14 : o.y + o.h + 0.38;
  const cw = 0.16, off = ring ? ring + 0.06 : (surround || 0.12) + 0.08;
  const ua = o.uc - o.w / 2 - off - cw, ub = o.uc + o.w / 2 + off;
  for (const cu of [ua, ub]) B.sweep(s, CONSOLE, [[cu, 0], [cu + cw, 0]], yt - 0.62, [true, true]);
  B.extrudeU(s, DOOR_HOOD, ua - 0.08, ub + cw + 0.08, yt, [true, true]);
}
const CONSOLE = [[0, 0], [0.06, 0.02], [0.1, 0.12], [0.12, 0.3], [0.2, 0.48], [0.26, 0.56], [0.27, 0.62], [0, 0.62]];
const DOOR_HOOD = [[0, 0], [0.24, 0], [0.26, 0.03], [0.3, 0.06], [0.3, 0.17], [0.34, 0.2], [0.36, 0.26], [0.36, 0.3], [0, 0.32]];
