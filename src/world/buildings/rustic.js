import { hash3 } from './shade.js';
import { surroundOf } from './openings.js';

// Proud rock-faced blocks at the arrises of a rusticated ground floor (full detail only).
//
// stone.rough draws its rock-faced bosses with parallax relief in front of the polygon,
// which cannot change a mesh's outline: pier corners and opening reveals would keep a
// ruler-straight silhouette. So the stone next to every arris of the rusticated zone (the
// jambs of the shop and door openings, and exposed building corners) is real geometry:
// one block per course, standing about 3 cm proud of the wall with chamfered edges and
// a slightly uneven face, wrapping the arris into the reveal (or round the corner). Its
// foot (the drafted margin and the V joints) stays in the wall plane, so the joints,
// jambs, frames and shutter guides meet the wall as before. Each block covers exactly
// the texture block beside the arris (the joint fitter puts a head joint on the arris;
// the block ends on the next one), and its return is textured like the reveal it stands
// on (mirrored about the arris, see openings.coursedJamb), so texture and geometry agree.

const CH = 0.04;          // chamfer run from the block's foot to its face
const STEP_F = 0.2;       // face subdivision along the wall (the uneven rock face)
const _tr = [0, 0];
const _uvx = [1, 0, 1, 0];
const _col = [];          // polyline columns (reused)
const _nrm = [];          // positions and accumulated vertex normals (reused)
const _tu = [];           // texture u per column (reused)
const MARGIN = 0.022;     // a wrapped arris starts the texture just past its joint

function arrisTop(o) { return o.top !== 'flat' && o.rise > 0.01 ? o.spring : o.y + o.h; }

/**
 * ctx: the face context of shell.lotSteps (B, sinks, fs, orn, rustic {v0, v1, joints, c},
 * fit, uvR, uMin, uMax); ops: the face's openings; ends: per face end (u = uMin, u = uMax)
 * null or {dir: [du, dw] along the exposed side from the corner, len: its exposed length}.
 */
export function rusticBlocks(ctx, face, ops, ends) {
  const { B, sinks, fs, orn, rustic } = ctx;
  if (!rustic || !rustic.joints.length || !ctx.uvR) return;
  const s = sinks.rough;
  const fit = ctx.fit ? ctx.fit.rough : null;
  const J = rustic.joints.slice().sort((a, b) => a - b), c = rustic.c;
  const uMin = ctx.uMin ?? 0, uMax = ctx.uMax ?? face.width;
  const plinthTop = (u) => face.groundAt(u) + orn.plinthH + 0.005;
  const seed = fs.seed | 0;
  for (let i = 0; i <= J.length; i++) {
    const ca = i === 0 ? -Infinity : J[i - 1] + c;
    const cb = i === J.length ? rustic.v1 - 0.005 : J[i] - c;
    const vm = (Math.max(ca, cb - 0.6) + cb) / 2;
    const rg = fit ? fit.row(vm) : i;
    // free runs of the wall at this course: [a, b, endA, endB], an end being an arris
    // {u, sgn, r, Lr, vb, vt, R} or null (a surround's jamb stone, a chamfered corner)
    const runs = courseRuns(face, ops, orn, vm, uMin, uMax, ends, plinthTop, i);
    for (const [a, b, ea, eb] of runs) {
      if (!ea && !eb) continue;
      let la = ea ? jointFrom(fit, rg, a, 1, i) - a : 0;
      let lb = eb ? b - jointFrom(fit, rg, b, -1, i + 1) : 0;
      const len = b - a;
      if (ea && eb && la + lb > len - 0.25) { la = len; lb = 0; }
      else { la = Math.min(la, len - lb - 0.1); }
      const blocks = la >= len ? [[a, b, ea, eb]] : [ea && la > 0.2 ? [a, a + la, ea, null] : null, eb && lb > 0.2 ? [b - lb, b, null, eb] : null];
      for (const blk of blocks) {
        if (!blk) continue;
        const [ua, ub, e0, e1] = blk;
        const vb = Math.max(ca, e0 ? e0.vb : -Infinity, e1 ? e1.vb : -Infinity, rustic.v0);
        const vt = Math.min(cb, e0 ? e0.vt : Infinity, e1 ? e1.vt : Infinity);
        if (vt - vb < 0.16) continue;
        // texture: the fitted transform of the course beside the arris
        if (fit) fit.at(rg, e0 ? ua + 0.01 : ub - 0.01, _tr); else { _tr[0] = ctx.uvR[0]; _tr[1] = ctx.uvR[1]; }
        _uvx[0] = _tr[0]; _uvx[1] = _tr[1]; _uvx[2] = ctx.uvR[2]; _uvx[3] = ctx.uvR[3];
        s.uvx = _uvx;
        B.run = fs.occluderAt((ua + ub) / 2, vt);
        block(B, s, fs, ua, ub, vb, vt, e0, e1, hash3(seed, i * 977 + Math.round(ua * 50), 0x7a11));
      }
    }
  }
  s.uvx = null;
  B.run = null;
  B.shade = null;
}

/** The fitted head joint past u (dir ±1), or an even rhythm without a fitter. */
function jointFrom(fit, rg, u, dir, i) {
  if (fit) return fit.nextJoint(rg, u, dir, 0.22, 1.6);
  return u + dir * (i % 2 ? 0.45 : 0.7);
}

const _runs = [];
function courseRuns(face, ops, orn, vm, uMin, uMax, ends, plinthTop, i) {
  const holes = [];
  for (const o of ops) {
    if (!(o.y < vm && vm < arrisTop(o))) continue;
    const sw = surroundOf(o, face, orn);
    holes.push({ u0: o.uc - o.w / 2 - sw, u1: o.uc + o.w / 2 + sw, o: sw ? null : o });
  }
  holes.sort((p, q) => p.u0 - q.u0);
  _runs.length = 0;
  const jamb = (o, u, sgn) => ({
    u, sgn, r: [0, -1], R: o.recess,
    // (the return stays clear of the shopfront's shutter box and guides at the infill plane)
    Lr: Math.min(0.2, Math.max(0.05, o.recess - 0.22)),
    vb: Math.max(o.y + 0.02, plinthTop(u)), vt: arrisTop(o) - 0.005,
  });
  const corner = (e, u, sgn) => {
    const x = ends && ends[e];
    if (!x) return null;
    return { u, sgn, r: x.dir, R: Infinity, Lr: Math.min(x.len - 0.02, i % 2 ? 0.32 : 0.5), vb: plinthTop(u), vt: Infinity };
  };
  let a = uMin, ea = uMin < 0.01 ? corner(0, uMin, 1) : null;
  for (const h of holes) {
    if (h.u0 - a > 0.2) _runs.push([a, h.u0, ea, h.o ? jamb(h.o, h.u0, -1) : null]);
    if (h.u1 > a) { a = h.u1; ea = h.o ? jamb(h.o, h.u1, 1) : null; }
  }
  if (uMax - a > 0.2) _runs.push([a, uMax, ea, uMax > face.width - 0.01 ? corner(1, uMax, -1) : null]);
  return _runs;
}

/**
 * One proud block over [ua, ub] × [vb, vt]: a polyline across it (seen from above),
 * wrapping the arris at either end (e0 at ua, e1 at ub: {u, sgn, r, Lr, R}), lofted
 * through five rows (foot, chamfer, middle, chamfer, foot). h: the block's own hash.
 */
function block(B, s, fs, ua, ub, vb, vt, e0, e1, h) {
  const p = 0.026 + 0.012 * h;                     // face proud of the wall
  const ch = CH * (0.85 + 0.3 * hash3(h * 1e6, 3, 1));
  const cols = _col;
  cols.length = 0;
  // [u, w (face), bu, bw (foot on the wall), role, proud share 0..1, reveal depth]
  // role: 0 front, 1 / 2 the corner at ua / ub, 3 / 4 the return at ua / ub
  const add = (u, w, bu, bw, role, k, d) => cols.push(u, w, bu, bw, role, k, d);
  const wrap = (e, first) => {
    // the return: along r from depth Lr (its foot) to the arris
    const ru = e.r[0], rw = e.r[1];
    // outward normal of the side face: perpendicular to r, away from the wall (−sgn along u)
    let nu = rw, nw = -ru;
    if (nu * e.sgn > 0) { nu = -nu; nw = -nw; }
    // the corner: where the side's offset plane meets the front's (w = p)
    const tc = Math.abs(rw) > 0.2 ? (p - nw * p) / rw : 0;
    const t1 = Math.max(0.01, e.Lr - ch), role = first ? 3 : 4;
    if (!first) add(e.u + nu * p + ru * tc, p, e.u, 0, 2, 1, 0);
    for (let i = 0; i < 3; i++) {
      const j = first ? i : 2 - i, t = j === 0 ? e.Lr : j === 1 ? t1 : 0, k = j === 0 ? 0 : 1;
      const bu = e.u + ru * t, bw = rw * t;
      add(bu + nu * p * k, bw + nw * p * k, bu, bw, role, k, t);
    }
    if (first) add(e.u + nu * p + ru * tc, p, e.u, 0, 1, 1, 0);
  };
  if (e0) wrap(e0, true); else { add(ua, 0, ua, 0, 0, 0, 0); add(ua + ch, p, ua + ch, 0, 0, 1, 0); }
  const fa = ua + (e0 ? 0 : ch), fb = ub - (e1 ? 0 : ch);
  const nf = Math.max(1, Math.round((fb - fa) / STEP_F));
  for (let k = e0 ? 0 : 1; k <= (e1 ? nf : nf - 1); k++) {
    const u = fa + ((fb - fa) * k) / nf;
    add(u, p, u, 0, 0, 1, 0);
  }
  if (e1) wrap(e1, false); else { add(ub - ch, p, ub - ch, 0, 0, 1, 0); add(ub, 0, ub, 0, 0, 0, 0); }
  const nc = cols.length / 7;
  // texture along the block by arc length: the front from joint to joint (or from just
  // past the joint at a wrapped arris, so the corner shows the drafted margin and not
  // the joint), each return continuing from its corner, mirrored as on the reveal
  const tu = _tu;
  tu.length = nc;
  let A = 0, Z = nc - 1;
  for (let k = 0; k < nc; k++) { if (cols[k * 7 + 4] === 1) A = k; else if (cols[k * 7 + 4] === 2) Z = k; }
  let arc = 0;
  for (let k = 0; k < nc; k++) {
    if (k) { const du = cols[k * 7] - cols[k * 7 - 7], dw = cols[k * 7 + 1] - cols[k * 7 - 6]; arc += Math.sqrt(du * du + dw * dw); }
    tu[k] = arc;
  }
  const aA = tu[A], aB = tu[Z], tA = e0 ? ua + MARGIN : ua, tB = e1 ? ub - MARGIN : ub;
  for (let k = 0; k < nc; k++) {
    const a = tu[k];
    tu[k] = k < A ? tA + (aA - a) : k > Z ? tB - (a - aB) : tA + ((tB - tA) * (a - aA)) / Math.max(1e-6, aB - aA);
  }

  const rows = [vb, vb + ch, (vb + vt) / 2, vt - ch, vt];
  const prow = [0, 1, 1, 1, 0];
  // positions (u, v, w) per vertex, the face roughened: interior points move ±6 mm
  const P = _nrm;
  P.length = 0;
  for (let r = 0; r < 5; r++) {
    for (let k = 0; k < nc; k++) {
      const o = k * 7, kk = cols[o + 5] * prow[r];
      const j = kk > 0 && r === 2 && k > 0 && k < nc - 1 ? (hash3(h * 1e6, k, 17) - 0.5) * 0.012 : 0;
      const t = kk * (1 + j / p);
      P.push(cols[o + 2] + (cols[o] - cols[o + 2]) * t, rows[r], cols[o + 3] + (cols[o + 1] - cols[o + 3]) * t, 0, 0, 0);
    }
  }
  // vertex normals: area-weighted sum of the adjacent quads' normals
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < nc - 1; k++) {
      const a = (r * nc + k) * 6, b = a + 6, d = a + nc * 6;
      const ax = P[b] - P[a], ay = P[b + 1] - P[a + 1], az = P[b + 2] - P[a + 2];
      const bx = P[d] - P[a], by = P[d + 1] - P[a + 1], bz = P[d + 2] - P[a + 2];
      // (u, v, w) right-handed: along × up faces out of the wall
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      P[a + 3] += nx; P[a + 4] += ny; P[a + 5] += nz; P[b + 3] += nx; P[b + 4] += ny; P[b + 5] += nz;
      P[d + 3] += nx; P[d + 4] += ny; P[d + 5] += nz; P[d + 9] += nx; P[d + 10] += ny; P[d + 11] += nz;
    }
  }
  B.shade = (u, v, w, nu, nv, nw, out) => {
    fs.wall(u, v, out);
    // reveal darkening (as the flat reveal beside it), soffit-facing chamfers darker
    const k = (w < -0.005 && _R < 9 ? 1 - 0.42 * Math.pow(Math.min(1, -w / _R), 0.8) : 1) * (nv < -0.4 ? 0.86 : nv > 0.4 ? 1.03 : 1);
    out[0] *= k; out[1] *= k; out[2] *= k;
  };
  _R = Math.min(e0 ? e0.R : 99, e1 ? e1.R : 99);
  s.reserve(nc * 5, (nc - 1) * 4 * 6);
  const base = s.vc;
  for (let r = 0; r < 5; r++) {
    for (let k = 0; k < nc; k++) {
      const q = (r * nc + k) * 6;
      let nx = P[q + 3], ny = P[q + 4], nz = P[q + 5];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      B.v(s, P[q], P[q + 1], P[q + 2], nx, ny, nz, tu[k], P[q + 1]);
    }
  }
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < nc - 1; k++) {
      const a = base + r * nc + k;
      B.quadIdx(s, a, a + 1, a + 1 + nc, a + nc);
    }
  }
}
let _R = 99;
