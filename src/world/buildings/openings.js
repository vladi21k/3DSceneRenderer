import { archPoint, ringParts, headKind } from '../facadePlan.js';
import { FACES, arcSeg } from './mesh.js';
import { CREASE } from './mouldings.js';
import { trimColor, setBlock, hash3, JAMB_H0, JAMB_H1 } from './shade.js';

// Masonry around each opening. The opening itself stays empty for the facade infill
// (frames, glass, shopfronts, doors at w = −recess). Here:
//   reveals  jambs, sill/threshold and head soffit (flat or curved) from w = 0 to −recess
//   interior a dark box from −recess to −recess − o.backDepth, closed at the back (far
//            detail: only the back plate, and none where the facades module glazes
//            the opening: ctx.filled)
//   dressing surrounds, voussoir rings with keystones, flat arches, lintels, hoods,
//            sills with optional corbels, thresholds and steps down to a lower paving.
//            Faces nothing can see are left out (the tops of window sills, which are all
//            above the eye; the joint faces between stacked jamb stones); far away (q.flat)
//            the dressing is its front faces, plus the undersides of sills and lintels.

const DARK = [0.035, 0.032, 0.03];
const _p = {}, _q = {}, _r = {}, _s = {};

export function openingMasonry(ctx, face, o) {
  const { B, sinks, q, fs, orn } = ctx;
  const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2;
  const y0 = o.y, ys = o.spring, yt = o.y + o.h;
  const R = o.recess;
  const arched = o.top !== 'flat' && o.rise > 0.01;
  const ground = o.floor === 0;
  const sRev = q.lod ? sinks.detail : sinks.smooth;   // far, the reveals' shadows are sub-texel
  const surround = surroundOf(o, face, orn);
  const seed = ((o.uc * 1000) | 0) + ((o.y * 100) | 0) * 7919 + (fs.seed | 0);

  // ---------------------------------------------------------------- reveals
  // Near, the reveals are cut stone like the faces they return from: walled jambs carry
  // the facade's own courses round the arris (coursedJamb); dressed jambs, sills and
  // heads continue the surround, lintel or ring stones (their tone, stone by stone).
  // (a rendered wall's own jambs are rendered: ctx.render, see wall.wallField)
  const rend = ctx.render && !surround && y0 > ctx.render.v0 - 0.05 ? ctx.render : null;
  const revealShade = (fsx, trim) => (u, v, w, nu, nv, nw, out) => {
    if (trim) trimColor(fsx, u, v, 0, out, 1.0); else fsx.wall(u, v, out);
    const d = Math.min(1, -w / Math.max(0.05, R));
    const k = (1 - 0.42 * Math.pow(d, 0.8)) * (nv < -0.3 ? 0.8 : nv > 0.5 ? 0.95 : 1);
    out[0] *= k; out[1] *= k; out[2] *= k;
  };
  B.shade = revealShade(fs, true);
  const near = q.lod === 0;
  setBlock(-1);
  if (rend) {
    B.shade = revealShade(rend.fs, false);
    B.rectU(rend.sink, u0, y0, ys, -R, 0, 1);
    B.rectU(rend.sink, u1, y0, ys, -R, 0, -1);
    B.shade = revealShade(fs, true);
  } else if (!surround && ctx.uvA) {
    // (far: one piece per material zone, the courses still turn the arris)
    coursedJamb(ctx, u0, 1, y0, ys, R);
    coursedJamb(ctx, u1, -1, y0, ys, R);
  } else if (near && surround) {
    // the surround's jamb stones (see the dressing below) return into the reveal
    const nj = ys - y0 > 1.3 ? 2 : 1, hj = (ys - y0) / nj;
    for (let j = 0; j < nj; j++) {
      const a = y0 + j * hj, b = y0 + (j + 1) * hj;
      block(B, seed, j * 2); B.rectU(sRev, u0, a, b, -R, 0, 1);
      block(B, seed, j * 2 + 1); B.rectU(sRev, u1, a, b, -R, 0, -1);
    }
    endBlocks(B);
  } else {
    // (rows where the soiling beside a shop or door jamb fades out, see shade.FaceShade)
    const vs = jambRows(ctx, u0, y0, ys);
    for (let i = 0; i + 1 < vs.length; i++) {
      B.rectU(sRev, u0, vs[i], vs[i + 1], -R, 0, 1);
      B.rectU(sRev, u1, vs[i], vs[i + 1], -R, 0, -1);
    }
  }
  B.rectV(sRev, u0, u1, -R, 0, y0, 1);
  if (!arched) {
    // the underside of the head: the lintel (one stone) or the flat arch's voussoirs
    const head = near ? flatHead(o, orn, surround, ctx.ch) : null;
    if (head && head.kind === 'flatArch') {
      // (closed: the joints are mortar-toned strips, nothing shows through them)
      const parts = flatArchParts(o, head.ext);
      parts.forEach(([xa, xb, k], i) => {
        const a = Math.max(u0, xa), b = Math.min(u1, xb);
        if (b - a > 1e-3) { block(B, seed, 200 + k); B.rectV(sRev, a, b, -R, 0, yt, -1); }
        const nx = parts[i + 1] ? parts[i + 1][0] : xb;
        if (nx > xb && xb > u0 && nx < u1) mortar(B, () => B.rectV(sRev, xb, nx, -R, 0, yt, -1));
      });
      endBlocks(B);
    } else {
      if (head) block(B, seed, 301);
      B.rectV(sRev, u0, u1, -R, 0, yt, -1);
      endBlocks(B);
    }
  } else if (near && q.voussoirs) {
    // the intrados of each ring stone
    const n = arcSeg(q, o), parts = ringParts(o, ringDepth(o, orn, surround), orn.keystone || ground);
    parts.forEach(([ta, tb, k], i) => {
      block(B, seed, 100 + k);
      soffit(B, sRev, o, -R, 0, Math.max(1, Math.ceil(n * (tb - ta))), ta, tb);
      if (parts[i + 1]) mortar(B, () => soffit(B, sRev, o, -R, 0, 1, tb, parts[i + 1][0]));
    });
    endBlocks(B);
  } else soffit(B, sRev, o, -R, 0, arcSeg(q, o));
  B.mark('op.reveal');

  // ---------------------------------------------------------------- dark interior
  const sD = sinks.dark;
  B.shade = null; B.flat = DARK;
  if (q.interior) {
    const Ri = R + (o.backDepth ?? 0.4);
    B.rectU(sD, u0, y0, ys, -Ri, -R, 1);
    B.rectU(sD, u1, y0, ys, -Ri, -R, -1);
    B.rectV(sD, u0, u1, -Ri, -R, y0, 1);
    if (!arched) B.rectV(sD, u0, u1, -Ri, -R, yt, -1);
    else soffit(B, sD, o, -Ri, -R, Math.max(4, arcSeg(q, o) >> 1));
    backFace(B, sD, o, -Ri, Math.max(4, arcSeg(q, o) >> 1));
  } else if (!ctx.filled) {
    backFace(B, sD, o, -R - 0.02, arcSeg(q, o));
  }
  B.flat = [1, 1, 1];
  B.mark('op.interior');

  // ---------------------------------------------------------------- dressing
  // (run-off from the sill or balcony above streaks the dressing as it does the wall)
  const sT = sinks.detail;
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(fs, u, v, nv, out, 1.05);
  B.run = fs.occluderAt(o.uc, yt);
  const isWin = o.kind === 'window' || o.kind === 'balconyDoor';
  const sp = surround ? orn.sp : 0;
  const bev = q.bevel ? 0.012 : 0;
  const flat = !!q.flat;

  // jambs of the surround
  if (surround) {
    // each jamb is a few dressed stones (tone, tooling and face plane differ a little)
    // (the head covers the top of the jambs, a window's sill their foot)
    const nj = (ys - y0) > 1.3 && q.lod === 0 ? 2 : 1, hj = (ys - y0) / nj;
    for (let j = 0; j < nj; j++) {
      const a = y0 + j * hj + (j ? 0.002 : 0), b = y0 + (j + 1) * hj - (j < nj - 1 ? 0.002 : 0);
      const hidden = FACES.TOP | (j || o.kind === 'window' ? FACES.BOTTOM : 0);
      for (const [p0, p1, side] of [[u0 - surround, u0, 0], [u1, u1 + surround, 1]]) {
        const h = block(B, seed, j * 2 + side);
        B.bevelBox(sT, p0, p1, a, b, flat ? 0 : -0.01, sp + (h - 0.5) * 0.004, bev, flat ? FACES.FRONT : FACES.ALL, hidden);
      }
    }
    endBlocks(B);
    // crossettes: the architrave steps out sideways just below the head
    if (orn.ears && isWin && !arched && q.lod === 0) {
      const eh = Math.min(0.22, (ys - y0) * 0.12), ew = 0.08;
      B.bevelBox(sT, u0 - surround - ew, u0 - surround + 0.01, ys - eh, ys, 0, sp, bev * 0.5, FACES.ALL & ~FACES.RIGHT);
      B.bevelBox(sT, u1 + surround - 0.01, u1 + surround + ew, ys - eh, ys, 0, sp, bev * 0.5, FACES.ALL & ~FACES.LEFT);
    }
  }

  B.mark('op.surround');
  // head
  if (arched) {
    const T = ringDepth(o, orn, surround);
    const proj = ground ? orn.shopRingP : (surround ? sp : 0.012);
    voussoirRing(ctx, sT, o, T, proj, orn.keystone || ground, bev, seed);
  } else {
    const { kind, ext, H } = flatHead(o, orn, surround, ctx.ch);
    const proj = surround ? sp : (ground ? 0.02 : 0.012);
    if (kind === 'flatArch') flatArch(ctx, sT, o, ext, H, proj, bev, seed);
    else if (kind === 'hood') { lintel(ctx, sT, o, ext, H, proj, bev, orn.keystone, seed); hood(ctx, sT, o, ext, yt + H); }
    else lintel(ctx, sT, o, ext, H, proj, bev, orn.keystone && kind !== 'plain', seed);
  }

  B.mark('op.head');
  // sill
  if (o.kind === 'window') {
    const ext = (surround || 0.06) + 0.07;
    const h = orn.sillH, p = sp + orn.sillP;
    B.bevelBox(sT, u0 - ext, u1 + ext, y0 - h, y0 + 0.004, 0, p, bev, flat ? FACES.FRONT | FACES.BOTTOM : FACES.ALL, FACES.TOP);
    // raised apron panel under the sill
    if (orn.apron && o.floor > 0) {
      const ah = Math.min(0.7, (y0 - h) - (face.floors[o.floor].y + 0.25));
      if (ah > 0.25) B.bevelBox(sT, u0, u1, y0 - h - ah, y0 - h - 0.02, 0, 0.018, bev * 0.6, flat ? FACES.FRONT : FACES.ALL);
    }
    if (orn.sillCorbels && q.lod === 0) {
      for (const cu of [u0 - ext + 0.05, u1 + ext - 0.17]) B.bevelBox(sT, cu, cu + 0.12, y0 - h - 0.2, y0 - h, 0, p - 0.03, bev, FACES.ALL & ~FACES.TOP);
    }
  }

  B.mark('op.sill');
  // threshold and steps at ground openings: worn, greyer and dirtier than the dressing
  // above (trodden and splashed), darkest along the paving
  if (ground) {
    const gA = face.groundAt(u0), gB = face.groundAt(u1);
    const gMin = Math.min(gA, gB);
    const rise = y0 - gMin;
    B.shade = (u, v, w, nu, nv, nw, out) => {
      trimColor(fs, u, v, nv, out, 0.9);
      const hg = Math.max(0, v - face.groundAt(u)), k = 0.8 + 0.12 * Math.min(1, hg / 0.4);
      const l = (out[0] + out[1] + out[2]) / 3;
      out[0] = (out[0] + (l - out[0]) * 0.4) * k; out[1] = (out[1] + (l - out[1]) * 0.4) * k; out[2] = (out[2] + (l - out[2]) * 0.4) * k;
      out[3] = Math.min(1.2, out[3] + 0.35);
    };
    B.bevelBox(sT, u0 - 0.04, u1 + 0.04, Math.min(y0 - 0.12, gMin - 0.05), y0 + 0.004, -0.03, 0.05, bev, flat ? FACES.FRONT | FACES.TOP : FACES.ALL & ~FACES.BOTTOM);
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
  B.run = null;
}

/**
 * Dressing that closes over the wall around opening o (see wall.wallField ctx.cover):
 * surround jambs and, over a flat head, a lintel on them; null when the wall shows.
 * Not far away (q.flat), where the dressing is only its front faces.
 */
export function coverOf(ctx, face, o) {
  const sw = surroundOf(o, face, ctx.orn);
  if (!sw || ctx.q.flat) return null;
  const head = o.top === 'flat' || !o.rise ? flatHead(o, ctx.orn, sw, ctx.ch) : null;
  return { side: sw, head: head && head.kind !== 'flatArch' ? head : null };
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
  const kind = headKind(o, orn);
  const ext = surround || (ground ? 0.2 : 0.12);
  const H = ground ? (kind === 'flatArch' ? 0.42 : 0.38) : ch ? Math.min(0.45, Math.max(0.26, ch)) : (kind === 'flatArch' ? 0.3 : 0.26);
  return { kind, ext, H };
}

/**
 * Curved soffit of an arched head between w0 and w1 (normals point into the opening),
 * over the head parameters ta..tb (0 left spring, 1 right spring) in n segments.
 */
function soffit(B, s, o, w0, w1, n, ta = 0, tb = 1) {
  s.reserve((n + 1) * 2, n * 6);
  let a0 = -1, b0 = -1, acc = 0, pu = 0, pv = 0;
  for (let k = 0; k <= n; k++) {
    archPoint(o, ta + ((tb - ta) * k) / n, _p);
    if (k) acc += Math.hypot(_p.u - pu, _p.v - pv);
    pu = _p.u; pv = _p.v;
    const a = B.v(s, _p.u, _p.v, w0, -_p.ru, -_p.rv, 0, acc, w0);
    const b = B.v(s, _p.u, _p.v, w1, -_p.ru, -_p.rv, 0, acc, w1);
    // the curve runs left → right over the crown, so (a0, a, b, b0) faces the arch centre
    if (k) B.quadIdx(s, a0, a, b, b0);
    a0 = a; b0 = b;
  }
}

/** Depth of the voussoir ring over an arched head (shop arches, surrounds, plain rings). */
function ringDepth(o, orn, surround) {
  return o.floor === 0 ? orn.shopRing : (surround ? surround * 1.3 : orn.ring);
}

/**
 * Voussoirs of a flat (jack) arch over opening o, `ext` beyond its jambs, as their
 * bottom edges [xa, xb, k, key] (joints excluded); the keystone (1.5 shares) is in the middle.
 */
function flatArchParts(o, ext) {
  const u0 = o.uc - o.w / 2 - ext, u1 = o.uc + o.w / 2 + ext;
  let n = Math.max(5, Math.round((u1 - u0) / 0.28)); if (n % 2 === 0) n++;
  const mid = (n - 1) >> 1, shares = n + 0.5, W = u1 - u0, j = 0.003;
  const out = [];
  let x = u0;
  for (let k = 0; k < n; k++) {
    const dx = (k === mid ? 1.5 : 1) * W / shares;
    out.push([x + (k ? j : 0), x + dx - (k < n - 1 ? j : 0), k, k === mid]);
    x += dx;
  }
  return out;
}

const _tr = [0, 0], _jc = [];
/**
 * A walled jamb at u (dir +1: the left jamb, facing +u; −1: the right one) from y0 to
 * y1, w from −R to 0, in the wall's own stone: cut at the bed joints of its courses, each
 * course mapped with the fitted transform of the run beside the opening, mirrored about
 * the arris (tu = arris − depth), so the bed joints and the block beside the opening turn
 * the corner; where the block is shorter than the reveal is deep, its head joint shows
 * in the reveal (the long and short jamb stones of bonded walling). The rusticated
 * ground floor takes the rock-faced stone and its own rows.
 */
function coursedJamb(ctx, u, dir, y0, y1, R) {
  const { B, sinks, fit, rustic } = ctx;
  const fA = fit ? fit.ashlar : null, fR = fit ? fit.rough : null;
  const sRough = sinks.rough || sinks.ashlar;
  const inRus = (v) => !!(rustic && v > rustic.v0 && v < rustic.v1);
  const cuts = _jc;
  cuts.length = 0;
  cuts.push(y0, y1);
  if (!ctx.q.lod && ctx.fs.jambs) for (const h of JAMB_ROWS) { const v = ctx.fs.groundAt(u) + h; if (v > y0 + 0.02 && v < y1 - 0.02) cuts.push(v); }
  if (fA) for (let rg = fA.row(y0) + 1, v = fA.bed(rg); v < y1; v = fA.bed(++rg)) if (!inRus(v)) cuts.push(v);
  if (rustic) {
    if (fR) for (let rg = fR.row(y0) + 1, v = fR.bed(rg); v < y1; v = fR.bed(++rg)) if (inRus(v)) cuts.push(v);
    for (const v of [rustic.v0, rustic.v1]) if (v > y0 && v < y1) cuts.push(v);
  }
  cuts.sort((a, b) => a - b);
  const uw = u - dir * 0.01;   // in the wall run beside the jamb
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a < 2e-3) continue;
    const vm = (a + b) / 2, rough = inRus(vm) && !!ctx.uvR;
    const F = rough ? fR : fA, s = rough ? sRough : sinks.ashlar, base = rough ? ctx.uvR : ctx.uvA;
    if (F) F.at(F.row(vm), uw, _tr); else { _tr[0] = base[0]; _tr[1] = base[1]; }
    const x = s.revUV || (s.revUV = [0, 0, 0, 0]);
    x[0] = -_tr[0]; x[1] = u * _tr[0] + _tr[1]; x[2] = base[2]; x[3] = base[3];
    s.uvx = x;
    B.rectU(s, u, a, b, -R, 0, dir);
  }
  sinks.ashlar.uvx = null;
  sRough.uvx = null;
}

const JAMB_ROWS = [JAMB_H0, JAMB_H1];
const _jr = [];
/** Heights from y0 to y1 cutting a reveal at u where the jamb soiling fades (full detail). */
function jambRows(ctx, u, y0, y1) {
  _jr.length = 0;
  _jr.push(y0);
  if (!ctx.q.lod && ctx.fs.jambs) for (const h of JAMB_ROWS) { const v = ctx.fs.groundAt(u) + h; if (v > y0 + 0.02 && v < y1 - 0.02) _jr.push(v); }
  _jr.push(y1);
  return _jr;
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

/** Start a dressed stone: its own tone and texture offset (see shade.setBlock). */
function block(B, seed, k) {
  const h = hash3(seed, k, 0x51ed);
  setBlock(h);
  B.setUV(1, h * 7.3, 1, h * 5.1);
  return h;
}
function endBlocks(B) { setBlock(-1); B.setUV(); }
/**
 * Emit a mortar joint with `fn`: the current shading, lighter and greyer (pointing in
 * lime mortar), no block tone.
 */
function mortar(B, fn) {
  setBlock(-1); B.setUV();
  const sh = B.shade;
  B.shade = (u, v, w, nu, nv, nw, out) => { sh(u, v, w, nu, nv, nw, out); out[0] *= 1.14; out[1] *= 1.14; out[2] *= 1.16; };
  fn();
  B.shade = sh;
}

const _t0 = {}, _t1 = {};
/**
 * One curved ring stone between head parameters ta and tb: intrados on the opening's
 * curve, extrados `ext` further out, front face at w = proj with a drafted margin
 * (chamfer `bev`), intrados, extrados and joint faces back to the wall. nSub arc
 * samples per stone keep it on the curve (the facade infill follows the same curve).
 * faces: 'full'; 'lean' leaves out the flat strips between the chamfers and the wall
 * (a centimetre or two, behind which the wall and the soffit continue); 'front'.
 */
// ring stone scratch: curve samples (u, v, ru, rv per point) and four quad corners
let _rI = new Float64Array(64), _rX = new Float64Array(64);
const _q0 = [0, 0, 0], _q1 = [0, 0, 0], _q2 = [0, 0, 0], _q3 = [0, 0, 0];
function ringStone(B, s, o, ta, tb, ext, proj, nSub, bev, faces = 'full') {
  const frontOnly = faces === 'front', lean = faces === 'lean' && bev > 0;
  if ((nSub + 1) * 4 > _rI.length) { _rI = new Float64Array((nSub + 1) * 8); _rX = new Float64Array((nSub + 1) * 8); }
  const I = _rI, X = _rX;
  for (let i = 0; i <= nSub; i++) {
    const t = ta + ((tb - ta) * i) / nSub;
    archPoint(o, t, _t0, 0); archPoint(o, t, _t1, ext);
    I[i * 4] = _t0.u; I[i * 4 + 1] = _t0.v; I[i * 4 + 2] = _t0.ru; I[i * 4 + 3] = _t0.rv;
    X[i * 4] = _t1.u; X[i * 4 + 1] = _t1.v; X[i * 4 + 2] = _t1.ru; X[i * 4 + 3] = _t1.rv;
  }
  const wb = bev > 0 ? proj - bev : proj;
  // front-face points, inset by the margin (radially, and along the curve at the joints)
  const inset = (P, k, sgn, out) => {
    const u = P[k * 4], v = P[k * 4 + 1], ru = P[k * 4 + 2], rv = P[k * 4 + 3];
    let du = ru * bev * sgn, dv = rv * bev * sgn;
    if (k === 0) { du += rv * bev; dv -= ru * bev; }           // tangent (rv, −ru) points along +t
    if (k === nSub) { du -= rv * bev; dv += ru * bev; }
    out[0] = u + du; out[1] = v + dv; out[2] = proj;
    return out;
  };
  const at = (P, k, w, out) => { out[0] = P[k * 4]; out[1] = P[k * 4 + 1]; out[2] = w; return out; };
  for (let k = 0; k < nSub; k++) {
    // front
    B.quadOut(s, inset(I, k, 1, _q0), inset(I, k + 1, 1, _q1), inset(X, k + 1, -1, _q2), inset(X, k, -1, _q3), 0, 0, 1);
    if (frontOnly) continue;
    // intrados (faces into the opening) and extrados (faces away from it)
    if (!lean) {
      B.quadOut(s, at(I, k, 0, _q0), at(I, k + 1, 0, _q1), at(I, k + 1, wb, _q2), at(I, k, wb, _q3), -I[k * 4 + 2], -I[k * 4 + 3], 0);
      B.quadOut(s, at(X, k, 0, _q0), at(X, k + 1, 0, _q1), at(X, k + 1, wb, _q2), at(X, k, wb, _q3), X[k * 4 + 2], X[k * 4 + 3], 0);
    }
    if (bev > 0) {
      B.quadOut(s, at(I, k, wb, _q0), at(I, k + 1, wb, _q1), inset(I, k + 1, 1, _q2), inset(I, k, 1, _q3), -I[k * 4 + 2], -I[k * 4 + 3], 1);
      B.quadOut(s, at(X, k, wb, _q0), at(X, k + 1, wb, _q1), inset(X, k + 1, -1, _q2), inset(X, k, -1, _q3), X[k * 4 + 2], X[k * 4 + 3], 1);
    }
  }
  // joint faces at both ends (normals along ∓ the curve)
  if (frontOnly) return;
  for (let e = 0; e < 2; e++) {
    const k = e ? nSub : 0, sg = e ? 1 : -1;
    const tu = I[k * 4 + 3] * sg, tv = -I[k * 4 + 2] * sg;
    if (!lean) B.quadOut(s, at(I, k, 0, _q0), at(X, k, 0, _q1), at(X, k, wb, _q2), at(I, k, wb, _q3), tu, tv, 0);
    if (bev > 0) B.quadOut(s, at(I, k, wb, _q0), at(X, k, wb, _q1), inset(X, k, -1, _q2), inset(I, k, 1, _q3), tu, tv, 1);
  }
}

/** Ring of voussoirs around an arched head; odd count with a keystone at the crown. */
function voussoirRing(ctx, s, o, T, proj, keystone, bev, seed) {
  const { B, q } = ctx;
  const parts = ringParts(o, T, keystone);
  if (!q.voussoirs) {
    // far detail: the ring as two smooth curved bands either side of the same keystone as
    // near (front faces: the relief is a few millimetres at a pixel there)
    const tk0 = parts.mid / parts.shares, tk1 = (parts.mid + 1.5) / parts.shares;
    const bands = keystone ? [[0, tk0], [tk1, 1]] : [[0, 1]];
    const n = arcSeg(q, o);
    const faces = q.flat ? 'front' : 'full';
    for (const [a, b] of bands) ringStone(B, s, o, a, b, T, proj, Math.max(1, Math.round(n * (b - a))), 0, faces);
    if (keystone) ringStone(B, s, o, tk0, tk1, T + 0.08, proj + 0.03, 1, 0, faces);
    return;
  }
  const mb = bev ? Math.max(bev, 0.02) : 0;   // drafted margin of ring stones
  // (in a rusticated wall the crown ends on a course line, see headInCourses; the ring
  // keeps its division, and so the keystone span facadePlan publishes)
  const [Tr, Tk] = headInCourses(ctx, o.y + o.h, T, keystone ? 0.08 : 0);
  for (const [ta, tb, k, isKey] of parts) {
    const h = block(B, seed, 100 + k);
    // keystone: projecting a little further and rising above the ring
    if (isKey) ringStone(B, s, o, ta, tb, Tk, proj + 0.03, 2, mb);
    else ringStone(B, s, o, ta, tb, Tr, proj + (h - 0.5) * 0.005, 2, mb, 'lean');
  }
  endBlocks(B);
}

/**
 * Height and keystone top [H, K] (above the head line yt: a flat head's, or an arch's
 * crown) of a head H0 tall (an arch ring: its depth) whose keystone rises `rise` above
 * it, in a rusticated wall: where a V joint runs through the top of the head (its band
 * less than 0.14 m below the top, or in the keystone's rise),
 * the head ends at the joint's lower arris, so the courses meet it on a course line, and
 * the keystone is flush (a stone straddling a joint, or a keystone poking into the
 * block above, reads as a displaced block). Never above H0 + rise (facadePlan's
 * headDressing). Full detail only: the joints are cut there.
 */
function headInCourses(ctx, yt, H0, rise) {
  const r = ctx.rustic;
  if (r) {
    for (const j of r.joints) {
      const a = j - r.c - yt, b = j + r.c - yt;
      if (b > H0 - 0.14 && a < H0 + rise && a > 0.24) return [a, a];
    }
  }
  return [H0, H0 + rise];
}

/** Flat (jack) arch: voussoirs fanning from a point below the head, keystone in the middle. */
function flatArch(ctx, s, o, ext, H, proj, bev, seed) {
  const { B } = ctx;
  const u0 = o.uc - o.w / 2 - ext, u1 = o.uc + o.w / 2 + ext, yt = o.y + o.h;
  const cy = yt - o.w * 1.1; // fan centre
  const parts = flatArchParts(o, ext), n = parts.length;
  // (in a rusticated wall the head ends on a course line, see headInCourses)
  const [vH, kH] = headInCourses(ctx, yt, H, 0.06);
  for (const [xa, xb0, k, key] of parts) {
    const top = key ? kH : vH;
    const sc = (yt + top - cy) / (yt - cy);
    const pts = [xa, yt, xb0, yt, o.uc + (xb0 - o.uc) * sc, yt + top, o.uc + (xa - o.uc) * sc, yt + top];
    // the outermost voussoirs are cut vertical at the ends of the head
    if (k === 0) pts[6] = Math.max(pts[6], u0 - 0.06);
    if (k === n - 1) pts[4] = Math.min(pts[4], u1 + 0.06);
    const h = block(B, seed, 200 + k);
    B.prism(s, pts, 0, key ? proj + 0.025 : proj + (h - 0.5) * 0.004, key && bev ? bev : 0, !ctx.q.flat);
  }
  endBlocks(B);
}

/** Plain lintel block across the head, optional raised keystone. */
function lintel(ctx, s, o, ext, H0, proj, bev, keystone, seed) {
  const { B } = ctx;
  const u0 = o.uc - o.w / 2 - ext, u1 = o.uc + o.w / 2 + ext, yt = o.y + o.h;
  // (in a rusticated wall the head ends on a course line, see headInCourses)
  const [H, K] = headInCourses(ctx, yt, H0, keystone ? 0.05 : 0);
  const flat = !!ctx.q.flat;
  block(B, seed, 300);
  B.bevelBox(s, u0, u1, yt, yt + H, flat ? 0 : -0.01, proj + 0.004, bev, flat ? FACES.FRONT | FACES.BOTTOM : FACES.ALL & ~FACES.BOTTOM);
  block(B, seed, 301);
  if (!flat) B.rectV(s, o.uc - o.w / 2, o.uc + o.w / 2, 0, proj + 0.004, yt, -1);
  if (keystone) {
    const kw = Math.min(0.32, o.w * 0.22), kt = yt + K;
    B.prism(s, [o.uc - kw * 0.4, yt - 0.04, o.uc + kw * 0.4, yt - 0.04, o.uc + kw * 0.55, kt, o.uc - kw * 0.55, kt], 0, proj + 0.03, bev, !flat);
  }
  endBlocks(B);
}

/** Small cornice hood over a head (window or door). */
function hood(ctx, s, o, ext, v0) {
  const { B } = ctx;
  const u0 = o.uc - o.w / 2 - ext - 0.07, u1 = o.uc + o.w / 2 + ext + 0.07;
  if (ctx.q.flat) B.extrudeU(s, HOOD_FAR, u0, u1, v0, [false, false]);
  else B.extrudeU(s, HOOD, u0, u1, v0, [true, true], CREASE);
}
const HOOD = [[0, 0], [0.04, 0], [0.05, 0.03], [0.09, 0.07], [0.13, 0.09], [0.13, 0.15], [0.15, 0.17], [0.15, 0.2], [0, 0.22]];
const HOOD_FAR = [[0, 0], [0.13, 0.09], [0.15, 0.2], [0, 0.22]];

/** Entrance portal hood on two consoles (clear of the voussoir ring of an arched door). */
function doorHood(ctx, s, o, surround, ring) {
  const { B } = ctx;
  const yt = ring ? o.y + o.h + ring + 0.14 : o.y + o.h + 0.38;
  const cw = 0.24, off = ring ? ring + 0.06 : (surround || 0.12) + 0.08;
  const ua = o.uc - o.w / 2 - off - cw, ub = o.uc + o.w / 2 + off;
  for (const cu of [ua, ub]) {
    // carved scroll console: the full S profile on the outside, a sunk side panel inside
    // (finely divided and smooth-shaded: a carved scroll, not facets)
    B.sweep(s, CONSOLE, [[cu, 0], [cu + 0.035, 0]], yt - CONSOLE_H, [true, true], 0, CREASE);
    B.sweep(s, CONSOLE_IN, [[cu + 0.035, 0], [cu + cw - 0.035, 0]], yt - CONSOLE_H, [false, false], 0, CREASE);
    B.sweep(s, CONSOLE, [[cu + cw - 0.035, 0], [cu + cw, 0]], yt - CONSOLE_H, [true, true], 0, CREASE);
  }
  B.extrudeU(s, DOOR_HOOD, ua - 0.08, ub + cw + 0.08, yt, [true, true], CREASE);
}
// S-scroll console profile [out, up], bottom to top: small lower volute, cyma body
// swelling out, a large upper volute under the hood (0.36 m projection, 0.7 m tall),
// 10-16 segments per curve
const CONSOLE_H = 0.7;
const CONSOLE = (() => {
  const pts = [[0, 0]];
  // lower volute: a roll from the foot round to its neck
  for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (i / 10) * (Math.PI * 5 / 6); pts.push([0.05 + 0.045 * Math.cos(a), 0.045 + 0.045 * Math.sin(a)]); }
  pts.push([0.075, 0.13]);
  // cyma body: from the lower volute out to the upper one
  for (let i = 1; i <= 16; i++) { const t = i / 16; pts.push([0.075 + 0.2 * (t - Math.sin(t * Math.PI * 2) / (Math.PI * 2) * 0.8), 0.13 + 0.38 * t]); }
  // upper volute rolling out under the hood
  for (let i = 1; i <= 14; i++) { const a = -Math.PI / 2 + (i / 14) * Math.PI * 0.9; pts.push([0.29 + 0.07 * Math.cos(a), 0.58 + 0.07 * Math.sin(a) + 0.03]); }
  pts.push([0.36, CONSOLE_H - 0.02], [0.35, CONSOLE_H], [0, CONSOLE_H]);
  return pts;
})();
/** The sunk middle of the console: the same profile set back 2 cm. */
const CONSOLE_IN = CONSOLE.map(([o, v]) => [Math.max(0, o - 0.02), v]);
const DOOR_HOOD = [[0, 0], [0.24, 0], [0.26, 0.03], [0.3, 0.06], [0.3, 0.17], [0.34, 0.2], [0.36, 0.26], [0.36, 0.3], [0, 0.32]];
