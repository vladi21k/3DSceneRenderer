import { FACES } from './mesh.js';

// Parapets, roofs and rooftop equipment.

/** Solid parapet section profile (closed loop): front face, coping, back face. */
export function parapetProfile(h, t = 0.3) {
  return [[0, 0], [0, h - 0.11], [0.05, h - 0.1], [0.05, h - 0.02], [0.03, h], [-t - 0.03, h], [-t - 0.05, h - 0.02], [-t - 0.05, h - 0.1], [-t, h - 0.11], [-t, 0]];
}
/** Low base and top rail of a balustrade (closed loops). */
export function balustradeBase(h) { return [[0.02, 0], [0.02, h - 0.03], [0, h], [-0.3, h], [-0.3, 0]]; }
export function balustradeRail(h) { return [[0.03, 0], [0.05, 0.02], [0.05, h - 0.03], [0.02, h], [-0.33, h], [-0.35, h - 0.03], [-0.35, 0.02], [-0.33, 0]]; }

/** Turned baluster (vase shape), radius profile [[r, y]] for a lathe, height h. */
export function balusterProfile(h) {
  const f = (r, y) => [r, y * h];
  return [f(0.065, 0), f(0.05, 0.1), f(0.085, 0.3), f(0.075, 0.48), f(0.035, 0.74), f(0.065, 0.86), f(0.065, 0.97), f(0.0, 1.0)];
}

/** Front balustrade: base, turned balusters, dies at the ends and every few metres, rail. */
export function balustrade(B, s, path, v0, h, q) {
  const baseH = 0.16, railH = 0.14, balH = h - baseH - railH;
  B.sweep(s, balustradeBase(baseH), path, v0, [true, true]);
  B.sweep(s, balustradeRail(railH), path, v0 + baseH + balH, [true, true]);
  const prof = balusterProfile(balH);
  for (let k = 0; k < path.length - 1; k++) {
    const [ua, wa] = path[k], [ub, wb] = path[k + 1];
    const L = Math.hypot(ub - ua, wb - wa);
    if (L < 0.5) continue;
    const du = (ub - ua) / L, dw = (wb - wa) / L;
    // dies (pedestals) at segment ends and roughly every 2.6 m
    const nd = Math.max(1, Math.round(L / 2.6));
    const dies = [];
    for (let i = 0; i <= nd; i++) dies.push(i * L / nd);
    // baluster axis: 0.15 behind the path, on the centre line of base and rail (the
    // outward normal of the path is (−dw, du))
    const ow = 0.15 * dw, oww = -0.15 * du;
    for (const t of dies) dieBlock(B, s, ua + du * t + ow, wa + dw * t + oww, du, v0 + baseH, balH);
    if (!q.balusters) {
      // far detail: the row of balusters reads as a solid band, darker than the stone
      // (lit balusters and shadowed gaps averaged) on the baluster axis
      const fl = B.flat;
      B.flat = [0.62, 0.6, 0.57];
      const sh = B.shade;
      if (sh) B.shade = (u, v, w, nu, nv, nw, out) => { sh(u, v, w, nu, nv, nw, out); out[0] *= 0.6; out[1] *= 0.59; out[2] *= 0.58; };
      for (let i = 0; i < nd; i++) {
        const a = dies[i] + 0.2, b = dies[i + 1] - 0.2;
        if (b - a < 0.1) continue;
        // panel in the path direction, set back to the baluster axis
        const pa = [ua + du * a + ow, wa + dw * a + oww], pb = [ua + du * b + ow, wa + dw * b + oww];
        B.vwall(s, pa[0], pa[1], pb[0], pb[1], v0 + baseH, v0 + baseH + balH);
      }
      B.flat = fl; B.shade = sh;
      continue;
    }
    for (let i = 0; i < nd; i++) {
      const a = dies[i] + 0.28, b = dies[i + 1] - 0.28;
      const n = Math.max(1, Math.round((b - a) / 0.27));
      for (let j = 0; j <= n; j++) {
        const t = a + (b - a) * (j / n);
        B.lathe(s, prof, ua + du * t + ow, wa + dw * t + oww, v0 + baseH, 6);
      }
    }
  }
}
function dieBlock(B, s, cu, cw, du, v0, h) {
  // pedestal centred on the baluster axis, a little proud of base and rail; axis-aligned
  // in the facade frame (balustrades only run along straight front paths)
  const hw = 0.2, hd = 0.21;
  if (Math.abs(du) > 0.5) B.bevelBox(s, cu - hw, cu + hw, v0, v0 + h, cw - hd, cw + hd, 0.01, FACES.ALL & ~FACES.BOTTOM);
  else B.box(s, cu - hd, cu + hd, v0, v0 + h, cw - hw, cw + hw, FACES.ALL & ~FACES.BOTTOM);
}

/** Merlons for a crenellated parapet top (Ottoman style). */
export function merlons(B, s, u0, u1, v0, step, w, h) {
  const n = Math.max(1, Math.floor((u1 - u0) / step));
  const off = u0 + (u1 - u0 - n * step) / 2 + (step - w) / 2;
  for (let i = 0; i < n; i++) {
    const a = off + i * step;
    // stepped merlon: two tiers
    B.box(s, a, a + w, v0, v0 + h * 0.55, -0.32, 0.03, FACES.ALL & ~FACES.BOTTOM);
    B.box(s, a + w * 0.2, a + w * 0.8, v0 + h * 0.55, v0 + h, -0.28, 0.0, FACES.ALL & ~FACES.BOTTOM);
  }
}

/**
 * Pitched tile roof over the building footprint: front eave line parallel to the facade,
 * back line parallel to it, and each end following its wall direction (straight back for
 * party walls, along the side street for corner returns). Exposed ends are hipped; ends
 * against a neighbour get a gable (ridge runs to the wall, stone gable triangle). Eaves
 * overhang the cornice with a soffit, fascia board and a half-round gutter.
 *   o: {W, v0 (eave height), pitch (deg), front (front eave w), back (back eave w),
 *       ends: [{dir: [du, dw], hip, over}] (u = 0 and u = W ends), wallBack: w of the back wall}
 */
export function pitchedRoof(B, sinks, o, q) {
  const tn = Math.tan((o.pitch * Math.PI) / 180), sn = Math.sin((o.pitch * Math.PI) / 180);
  const wf = o.front, wb = o.back, wm = (wf + wb) / 2, half = (wf - wb) / 2, H = half * tn;
  // side lines: through the front wall corner along the end's wall direction, pushed out by the overhang
  const lines = o.ends.map((e, k) => {
    const [du, dw] = e.dir;
    const out = k ? [-dw, du] : [dw, -du];        // outward normal (away from the building)
    const P = [(k ? o.W : 0) + out[0] * e.over, out[1] * e.over];
    return { P, d: [du, dw], out };
  });
  const at = (L, w) => { const t = (w - L.P[1]) / L.d[1]; return [L.P[0] + L.d[0] * t, w]; };
  const FL = at(lines[0], wf), FR = at(lines[1], wf), BL = at(lines[0], wb), BR = at(lines[1], wb);
  // ridge ends: hips sit `half` inside their side line, gables on it
  const ridgeEnd = (k) => {
    const L = lines[k], M = at(L, wm);
    if (!o.ends[k].hip) return M[0];
    // the point of the ridge line `half` inside the side line (same pitch as front and back)
    const nu = -L.out[0], nw = -L.out[1];
    return L.P[0] + (half - (wm - L.P[1]) * nw) / nu;
  };
  let xl = ridgeEnd(0), xr = ridgeEnd(1);
  if (xl > xr) xl = xr = (xl + xr) / 2;
  const top = o.v0 + H;
  const RL = [xl, top, wm], RR = [xr, top, wm];
  const p3 = (p, v = o.v0) => [p[0], v, p[1]];
  const s = sinks.tile;
  // tile faces (normal from the geometry, UV: along the eave, up the slope)
  const face = (pts, e0, e1) => {
    const ex = e1[0] - e0[0], ez = e1[2] - e0[2], el = Math.hypot(ex, ez) || 1;
    const P = pts;
    const ax = P[1][0] - P[0][0], ay = P[1][1] - P[0][1], az = P[1][2] - P[0][2];
    const bx = P[P.length - 1][0] - P[0][0], by = P[P.length - 1][1] - P[0][1], bz = P[P.length - 1][2] - P[0][2];
    let nu = ay * bz - az * by, nv = az * bx - ax * bz, nw = ax * by - ay * bx;
    const l = Math.hypot(nu, nv, nw) || 1; nu /= l; nv /= l; nw /= l;
    let order = P;
    if (nv < 0) { order = P.slice().reverse(); nu = -nu; nv = -nv; nw = -nw; }
    s.reserve(order.length, (order.length - 2) * 3);
    const base = s.vc;
    for (const p of order) {
      const tu = ((p[0] - e0[0]) * ex + (p[2] - e0[2]) * ez) / el;
      B.v(s, p[0], p[1], p[2], nu, nv, nw, tu, (p[1] - o.v0) / sn);
    }
    for (let k = 1; k < order.length - 1; k++) B.tri(s, base, base + k, base + k + 1);
  };
  const fl = p3(FL), fr = p3(FR), bl = p3(BL), br = p3(BR);
  face([fl, fr, RR, RL], fl, fr);
  face([br, bl, RL, RR], br, bl);
  if (o.ends[0].hip) face([bl, fl, RL], bl, fl);
  if (o.ends[1].hip) face([fr, br, RR], fr, br);
  // gable triangles in stone where the roof meets a neighbour
  const sg = sinks.ashlar;
  for (const k of [0, 1]) {
    if (o.ends[k].hip) continue;
    const a = k ? fr : bl, b = k ? br : fl, r = k ? RR : RL;   // travel so the wall faces outwards
    const dx = b[0] - a[0], dz = b[2] - a[2], dl = Math.hypot(dx, dz) || 1;
    const nu = -dz / dl, nw = dx / dl;
    sg.reserve(3, 3);
    const i0 = B.v(sg, a[0], a[1] - 0.02, a[2], nu, 0, nw, 0, a[1]);
    const i1 = B.v(sg, b[0], b[1] - 0.02, b[2], nu, 0, nw, dl, b[1]);
    const i2 = B.v(sg, r[0], r[1], r[2], nu, 0, nw, ((r[0] - a[0]) * dx + (r[2] - a[2]) * dz) / dl, r[1]);
    B.tri(sg, i0, i1, i2);
  }
  if (q.lod === 0) {
    const cap = (a, b) => roundCap(B, s, a, b, 0.11);
    cap(RL, RR);
    if (o.ends[0].hip) { cap(fl, RL); cap(bl, RL); }
    if (o.ends[1].hip) { cap(fr, RR); cap(br, RR); }
  }
  // eaves: soffit (from the wall line out to the eave), fascia board and gutter along
  // every eave edge (gable verges get a thin fascia only)
  const ring = [FL, FR, BR, BL];                        // clockwise in (u, w)
  const wallRing = [[0, 0], [o.W, 0], o.wallBack[1], o.wallBack[0]];
  const sp = sinks.paint;
  for (let k = 0; k < 4; k++) {
    const A = ring[k], Bp = ring[(k + 1) % 4], a = wallRing[k], b = wallRing[(k + 1) % 4];
    const gable = (k === 3 && !o.ends[0].hip) || (k === 1 && !o.ends[1].hip);
    const L = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]);
    if (L < 0.05) continue;
    B.flat = [0.2, 0.16, 0.13];
    B.vwall(sp, A[0], A[1], Bp[0], Bp[1], o.v0 - (gable ? 0.06 : 0.16), o.v0 + 0.02);
    if (gable) continue;
    // soffit: quad between the eave edge and the wall edge, facing down
    B.flat = [0.42, 0.37, 0.32];
    sp.reserve(4, 6);
    const v = o.v0 - 0.16;
    const i0 = B.v(sp, A[0], v, A[1], 0, -1, 0, A[0], A[1]), i1 = B.v(sp, Bp[0], v, Bp[1], 0, -1, 0, Bp[0], Bp[1]);
    const i2 = B.v(sp, b[0], v, b[1], 0, -1, 0, b[0], b[1]), i3 = B.v(sp, a[0], v, a[1], 0, -1, 0, a[0], a[1]);
    B.quadIdx(sp, i0, i3, i2, i1);
    if (q.lod === 0 && k !== 2) {
      // half-round gutter hung just outside the fascia
      const du = (Bp[0] - A[0]) / L, dw = (Bp[1] - A[1]) / L;
      B.enter(A[0], 0, A[1], Math.atan2(-dw, du));
      B.flat = [0.5, 0.5, 0.49];
      B.cylinderU(sinks.metal, 0, L, o.v0 - 0.09, 0.07, 0.065, 8, true);
      B.popFrame();
    }
  }
  B.flat = [1, 1, 1];
}

/** Half-round cap along a segment (in local coords) lying on a roof. */
function roundCap(B, s, a, b, r) {
  const du = b[0] - a[0], dv = b[1] - a[1], dw = b[2] - a[2];
  const L = Math.hypot(du, dv, dw);
  if (L < 0.05) return;
  const ax = [du / L, dv / L, dw / L];
  // side vector: horizontal, perpendicular to the axis; up vector completes the frame
  let sx = -ax[2], sz = ax[0];
  const sl = Math.hypot(sx, sz) || 1; sx /= sl; sz /= sl;
  const up = [ax[1] * sz - ax[2] * 0, ax[2] * sx - ax[0] * sz, ax[0] * 0 - ax[1] * sx];
  if (up[1] < 0) { up[0] = -up[0]; up[1] = -up[1]; up[2] = -up[2]; sx = -sx; sz = -sz; }
  const seg = 5;
  s.reserve((seg + 1) * 2, seg * 6);
  const base = s.vc;
  for (let k = 0; k <= seg; k++) {
    const t = (k / seg) * Math.PI, c = Math.cos(t), sn = Math.sin(t);
    const nu = sx * c + up[0] * sn, nv = up[1] * sn, nw = sz * c + up[2] * sn;
    for (const e of [0, 1]) {
      const p = e ? b : a;
      B.v(s, p[0] + nu * r, p[1] + nv * r, p[2] + nw * r, nu, nv, nw, e * L, t * r);
    }
  }
  for (let k = 0; k < seg; k++) {
    const i = base + k * 2;
    B.quadIdx(s, i, i + 2, i + 3, i + 1);
  }
}

// ------------------------------------------------------------------ rooftop equipment

// Direction the solar collectors face (towards the midday sun), world xz.
const SUN_X = -0.34, SUN_Z = -0.94;

/**
 * Footprint radius of a solar heater (collectors, tank and frame) for placement, from
 * the same random draws solarHeater() makes first.
 */
export function heaterRadius(n) {
  const totalW = n * 0.95 + (n - 1) * 0.06, run = 2.0 * Math.cos((42 * Math.PI) / 180);
  return Math.hypot(totalW / 2, run / 2 + 0.3 + 0.1) + 0.05;
}

/**
 * Flat-plate solar water heater: one or two tilted glazed collectors on a galvanised
 * angle frame, with the horizontal storage tank above their top edge. stand > 0 raises
 * the whole rig on taller legs with braces (common, so the tank clears the parapet).
 */
export function solarHeater(B, sinks, frameYaw, q, rng, stand = 0, n = rng.chance(0.7) ? 2 : 1) {
  const sM = sinks.metal, sG = sinks.glass || sinks.metal, sP = sinks.paint;
  const tilt = (rng.range(38, 46) * Math.PI) / 180;
  const panelW = 0.95, panelL = 2.0;
  const totalW = n * panelW + (n - 1) * 0.06;
  const c = Math.cos(tilt), sn = Math.sin(tilt);
  // local frame of the heater: u across, w towards the sun (front), v up
  const foot = 0.25 + stand;
  const run = panelL * c, rise = panelL * sn;
  // collectors: tilted slab from (w = +run/2, v = foot) up to (w = -run/2, v = foot + rise)
  for (let i = 0; i < n; i++) {
    const a = -totalW / 2 + i * (panelW + 0.06), b = a + panelW;
    const wf = run / 2, wb = -run / 2, vf = foot, vb = foot + rise, th = 0.09;
    // glazing (top surface): dark blue-black absorber seen through the glass
    B.flat = sinks.glass ? [1, 1, 1] : [0.07, 0.08, 0.1];
    B._quad4(sG, a, vf + th * c, wf + th * sn, b, vf + th * c, wf + th * sn, b, vb + th * c, wb + th * sn, a, vb + th * c, wb + th * sn, 0, c, sn);
    // aluminium casing sides and underside
    B.flat = [0.85, 0.86, 0.88];
    B._quad4(sM, a, vf, wf, b, vf, wf, b, vf + th * c, wf + th * sn, a, vf + th * c, wf + th * sn, 0, -sn, c);
    B._quad4(sM, b, vb, wb, a, vb, wb, a, vb + th * c, wb + th * sn, b, vb + th * c, wb + th * sn, 0, sn, -c);
    B._quad4(sM, a, vf, wf, a, vf + th * c, wf + th * sn, a, vb + th * c, wb + th * sn, a, vb, wb, -1, 0, 0);
    B._quad4(sM, b, vf, wf, b, vb, wb, b, vb + th * c, wb + th * sn, b, vf + th * c, wf + th * sn, 1, 0, 0);
    B._quad4(sM, a, vf, wf, a, vb, wb, b, vb, wb, b, vf, wf, 0, -c, -sn);
  }
  // tank above the top edge of the collectors
  const tankR = rng.range(0.24, 0.3), tankL = Math.max(1.3, totalW * 0.85);
  const tv = foot + rise + tankR + 0.12, tw = -run / 2 - 0.05;
  B.flat = rng.chance(0.75) ? [0.88, 0.88, 0.86] : [0.55, 0.56, 0.58];
  B.cylinderU(sP, -tankL / 2, tankL / 2, tv, tw, tankR, q.lod ? 8 : 14, true);
  if (q.lod === 0) {
    // rolled end rims and the strap bands of the tank
    const f = B.flat;
    B.flat = f.map((x) => x * 0.8);
    for (const x of [-tankL / 2 + 0.02, tankL / 2 - 0.05, -0.35, 0.32]) B.cylinderU(sP, x, x + 0.03, tv, tw, tankR + 0.008, 12, false);
    B.flat = f;
  }
  // frame: legs and rails (galvanised angle)
  B.flat = [0.8, 0.8, 0.8];
  const leg = 0.035;
  for (const x of [-totalW / 2 + 0.05, totalW / 2 - 0.05]) {
    B.box(sM, x - leg, x + leg, 0, foot + rise + 0.05, -run / 2 - leg, -run / 2 + leg, FACES.SIDES & ~FACES.BOTTOM | FACES.FRONT | FACES.BACK);
    B.box(sM, x - leg, x + leg, 0, foot, run / 2 - leg, run / 2 + leg, FACES.ALL & ~FACES.BOTTOM);
    if (q.lod === 0) {
      // tank cradle
      B.box(sM, x - leg, x + leg, foot + rise + 0.02, tv - tankR * 0.6, tw - tankR * 0.8, tw + tankR * 0.8, FACES.ALL & ~FACES.BOTTOM);
    }
  }
  B.box(sM, -totalW / 2, totalW / 2, 0, 0.06, -run / 2 - 0.05, run / 2 + 0.05, FACES.TOP | FACES.FRONT | FACES.BACK | FACES.LEFT | FACES.RIGHT);
  if (stand > 0.3) {
    // braces of a raised stand: rails front to back and across, half way up
    const y = stand * 0.55;
    for (const x of [-totalW / 2 + 0.05, totalW / 2 - 0.05]) B.box(sM, x - 0.02, x + 0.02, y - 0.02, y + 0.02, -run / 2, run / 2, FACES.SIDES);
    B.box(sM, -totalW / 2 + 0.05, totalW / 2 - 0.05, y - 0.02, y + 0.02, -run / 2 - 0.02, -run / 2 + 0.02, FACES.FRONT | FACES.BACK | FACES.TOP | FACES.BOTTOM);
  }
  void frameYaw;
}

/** Yaw (about +v, frame-local) that turns a sub-frame's +w towards the sun. */
export function sunYaw(frame) {
  const fu = SUN_X * frame.uDir.x + SUN_Z * frame.uDir.z;
  const fw = SUN_X * frame.nDir.x + SUN_Z * frame.nDir.z;
  return Math.atan2(fu, fw);
}

/** Water tank: vertical cylinder on a low steel stand. */
export function waterTank(B, sinks, q, rng) {
  const r = rng.range(0.45, 0.65), h = rng.range(1.0, 1.5);
  const black = rng.chance(0.55);
  B.flat = black ? [0.09, 0.09, 0.1] : [0.82, 0.82, 0.8];
  B.cylinderV(sinks.paint, 0, 0, 0.3, 0.3 + h, r, q.lod ? 8 : 16, true);
  if (q.lod === 0) {
    // ribs
    B.lathe(sinks.paint, [[r + 0.015, 0.3 + h * 0.33], [r + 0.015, 0.3 + h * 0.33 + 0.05]], 0, 0, 0, 16);
    B.lathe(sinks.paint, [[r + 0.015, 0.3 + h * 0.66], [r + 0.015, 0.3 + h * 0.66 + 0.05]], 0, 0, 0, 16);
  }
  B.flat = [0.7, 0.7, 0.7];
  B.box(sinks.metal, -r * 0.9, r * 0.9, 0, 0.3, -r * 0.9, r * 0.9, FACES.ALL & ~FACES.BOTTOM);
}

/** Split AC condenser on rails. */
export function acUnit(B, sinks, q, rng) {
  const w = rng.range(0.8, 0.95), h = rng.range(0.55, 0.75), d = 0.33;
  B.flat = [0.86, 0.86, 0.84];
  B.box(sinks.paint, -w / 2, w / 2, 0.12, 0.12 + h, -d / 2, d / 2, FACES.ALL & ~FACES.BOTTOM);
  if (q.lod === 0) {
    // fan grille: dark disc slightly proud of the front
    B.flat = [0.12, 0.12, 0.12];
    const cx = -w / 2 + h / 2 + 0.03, cy = 0.12 + h / 2, rr = h * 0.4;
    const s = sinks.paint, seg = 14;
    s.reserve(seg + 1, seg * 3);
    const c0 = B.v(s, cx, cy, d / 2 + 0.004, 0, 0, 1, 0, 0);
    const b0 = s.vc;
    for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; B.v(s, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, d / 2 + 0.004, 0, 0, 1, 0, 0); }
    for (let k = 0; k < seg; k++) B.tri(s, c0, b0 + k, b0 + ((k + 1) % seg));
  }
  B.flat = [0.6, 0.6, 0.6];
  B.box(sinks.metal, -w / 2 - 0.05, w / 2 + 0.05, 0, 0.12, -0.04, 0.04, FACES.ALL & ~FACES.BOTTOM);
}

/** TV antenna mast with a few cross elements. */
export function antenna(B, sinks, q, rng) {
  const s = sinks.metal;
  const h = rng.range(2.5, 4.5);
  B.flat = [0.75, 0.75, 0.75];
  const r = 0.022;
  B.box(s, -r, r, 0, h, -r, r, FACES.SIDES | FACES.FRONT | FACES.BACK);
  const n = q.lod ? 2 : rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const y = h - 0.15 - i * 0.28, L = 0.5 + 0.25 * (n - i) / n;
    B.box(s, -0.008, 0.008, y - 0.008, y + 0.008, -L, L, FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
  }
  // boom
  B.box(s, -0.012, 0.012, h - 0.17, h - 0.15, -0.05, 1.1, FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
  B.box(s, -0.1, 0.1, 0, 0.04, -0.1, 0.1, FACES.ALL & ~FACES.BOTTOM);
}

/** Roof access stair head-house (small rendered box with a door and a flat slab). */
export function headHouse(B, sinks, q, rng, tint) {
  const w = rng.range(2.0, 2.8), d = rng.range(2.4, 3.2), h = rng.range(2.3, 2.7);
  const k = rng.range(0.85, 0.97);
  B.flat = [tint[0] * k, tint[1] * k, tint[2] * k];
  const s = sinks.paint;
  B.box(s, -w / 2, w / 2, 0, h, -d / 2, d / 2, FACES.ALL & ~FACES.BOTTOM);
  B.box(s, -w / 2 - 0.08, w / 2 + 0.08, h, h + 0.14, -d / 2 - 0.08, d / 2 + 0.08, FACES.ALL);
  if (q.lod === 0) {
    // painted steel door in a shallow reveal
    const dd = d / 2;
    B.flat = [tint[0] * k * 0.7, tint[1] * k * 0.7, tint[2] * k * 0.7];
    B.rectU(s, -0.45, 0.02, 2.0, dd - 0.06, dd, 1);
    B.rectU(s, 0.45, 0.02, 2.0, dd - 0.06, dd, -1);
    B.rectV(s, -0.45, 0.45, dd - 0.06, dd, 2.0, -1);
    const door = rng.pick([[0.16, 0.2, 0.17], [0.3, 0.3, 0.29], [0.12, 0.07, 0.05], [0.42, 0.4, 0.36]]);
    B.flat = door;
    B.rectW(sinks.frame || s, -0.45, 0.45, 0.02, 2.0, dd - 0.06, 1);
    B.flat = door.map((x) => x * 0.6);
    B.box(sinks.frame || s, 0.3, 0.36, 0.98, 1.02, dd - 0.06, dd - 0.02, FACES.FRONT | FACES.TOP);
  }
}

/**
 * Satellite dish on a short bracket: a shallow paraboloid facing +w, tilted up by
 * `elev` (radians), feed arm under the rim. Two-sided (front and back faces).
 */
export function satelliteDish(B, s, q, rng, elev = 0.75) {
  const R = rng.range(0.3, 0.42), depth = R * 0.22, h = rng.range(0.35, 0.6);
  const ce = Math.cos(elev), se = Math.sin(elev);
  // dish axis a (u, v, w) = (0, se, ce); e1 = u axis; e2 = a × e1 = (0, ce, -se)
  const cv = h + 0.05, cw = 0.12;
  const P = (r, t) => {
    const x = r * Math.cos(t), y = r * Math.sin(t), z = depth * (r / R) * (r / R);
    return [x, cv + y * ce + z * se, cw + -y * se + z * ce];
  };
  B.flat = rng.chance(0.8) ? [0.78, 0.78, 0.76] : [0.3, 0.3, 0.31];
  const nr = 2, nt = q.lod ? 6 : 10;
  for (let i = 0; i < nr; i++) {
    const r0 = (R * i) / nr, r1 = (R * (i + 1)) / nr;
    for (let j = 0; j < nt; j++) {
      const t0 = (j / nt) * Math.PI * 2, t1 = ((j + 1) / nt) * Math.PI * 2;
      const a = P(r0, t0), b = P(r1, t0), c = P(r1, t1), d = P(r0, t1);
      B.quadAuto(s, a, b, c, d);
      B.quadAuto(s, a, d, c, b);
    }
  }
  // feed arm from the rim bottom to the focus, and the mounting bracket
  B.flat = [0.35, 0.35, 0.35];
  const rimB = P(R, -Math.PI / 2), focus = [0, cv + (R * 0.9) * se, cw + (R * 0.9) * ce];
  const e = 0.012;
  B.quadAuto(s, [rimB[0] - e, rimB[1], rimB[2]], [rimB[0] + e, rimB[1], rimB[2]], [focus[0] + e, focus[1], focus[2]], [focus[0] - e, focus[1], focus[2]]);
  B.box(s, -0.03, 0.03, focus[1] - 0.04, focus[1] + 0.04, focus[2] - 0.05, focus[2] + 0.03, FACES.ALL);
  B.box(s, -0.02, 0.02, 0, cv, cw - 0.12, cw - 0.08, FACES.SIDES | FACES.FRONT | FACES.BACK);
  B.box(s, -0.08, 0.08, 0, 0.02, cw - 0.2, cw, FACES.TOP | FACES.FRONT | FACES.BACK | FACES.LEFT | FACES.RIGHT);
}
