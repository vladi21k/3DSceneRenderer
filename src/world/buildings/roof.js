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
    const ow = 0.15 * -dw, oww = 0.15 * du; // the balustrade sits 0.15 behind the face line
    for (const t of dies) {
      const cu = ua + du * t + ow - 0.02 * dw, cw = wa + dw * t + oww;
      dieBlock(B, s, cu, cw, du, dw, v0 + baseH, balH);
    }
    if (!q.balusters) {
      // far detail: a pierced screen reads as a darker solid band
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
function dieBlock(B, s, cu, cw, du, dw, v0, h) {
  // axis-aligned in the path direction: only straight front/back paths are used, so
  // a box in the facade frame (du = ±1 or dw = ±1) is exact
  const hw = 0.2;
  if (Math.abs(du) > 0.5) B.bevelBox(s, cu - hw, cu + hw, v0, v0 + h, cw - 0.38, cw + 0.18, 0.01, FACES.ALL & ~FACES.BOTTOM);
  else B.box(s, cu - 0.18, cu + 0.38, v0, v0 + h, cw - hw, cw + hw, FACES.ALL & ~FACES.BOTTOM);
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
 * Hip roof over the rectangle u ∈ [x0, x1], w ∈ [z0, z1] (z1 = street side), eaves at
 * height v0, slopes `pitch` degrees. Ridge along the longer side. Tiles via roof.tile UVs
 * (u along the eaves, v up the slope in metres); ridge and hip caps as round tiles.
 */
export function hipRoof(B, sTile, x0, x1, z0, z1, v0, pitchDeg, q) {
  const W = x1 - x0, D = z1 - z0, tn = Math.tan((pitchDeg * Math.PI) / 180);
  const alongU = W >= D;
  const half = (alongU ? D : W) / 2, H = half * tn;
  const top = v0 + H;
  const cs = Math.cos(Math.atan(tn)), sn = Math.sin(Math.atan(tn));
  const P = (u, v, w) => [u, v, w];
  let r0, r1; // ridge end points
  if (alongU) { r0 = P(x0 + half, top, (z0 + z1) / 2); r1 = P(x1 - half, top, (z0 + z1) / 2); }
  else { r0 = P((x0 + x1) / 2, top, z1 - half); r1 = P((x0 + x1) / 2, top, z0 + half); }
  const c00 = P(x0, v0, z0), c10 = P(x1, v0, z0), c11 = P(x1, v0, z1), c01 = P(x0, v0, z1);
  // planes: each slope as a quad (degenerate where the ridge collapses to a point)
  const face = (A, Bq, C, Dq, nu, nv, nw, eaveDir) => {
    sTile.reserve(4, 6);
    // UV: tu along the eave, tv up the slope from the eave
    const uvOf = (p) => {
      const along = eaveDir === 'u' ? p[0] : eaveDir === '-u' ? -p[0] : eaveDir === 'w' ? p[2] : -p[2];
      return [along, (p[1] - v0) / sn];
    };
    const ids = [A, Bq, C, Dq].map((p) => { const t = uvOf(p); return B.v(sTile, p[0], p[1], p[2], nu, nv, nw, t[0], t[1]); });
    B.quadIdx(sTile, ids[0], ids[1], ids[2], ids[3]);
  };
  // front (street, +w), back (−w), left (−u), right (+u)
  if (alongU) {
    face(c01, c11, r1, r0, 0, cs, sn, 'u');
    face(c10, c00, r0, r1, 0, cs, -sn, '-u');
    face(c00, c01, r0, r0, -sn, cs, 0, 'w');
    face(c11, c10, r1, r1, sn, cs, 0, '-w');
  } else {
    face(c01, c11, r0, r0, 0, cs, sn, 'u');
    face(c10, c00, r1, r1, 0, cs, -sn, '-u');
    face(c00, c01, r0, r1, -sn, cs, 0, 'w');
    face(c11, c10, r1, r0, sn, cs, 0, '-w');
  }
  // ridge and hips: half-round capping tiles
  if (q.lod === 0) {
    const cap = (a, b) => roundCap(B, sTile, a, b, 0.11);
    cap(r0, r1);
    if (alongU) { cap(c01, r0); cap(c00, r0); cap(c11, r1); cap(c10, r1); }
    else { cap(c01, r0); cap(c11, r0); cap(c00, r1); cap(c10, r1); }
  }
  // eave fascia (tile edge thickness) all round
  const t = 0.06;
  B.shade = null;
  B.rectW(sTile, x0, x1, v0 - t, v0, z1, 1);
  B.rectW(sTile, x0, x1, v0 - t, v0, z0, -1);
  B.rectU(sTile, x0, v0 - t, v0, z0, z1, -1);
  B.rectU(sTile, x1, v0 - t, v0, z0, z1, 1);
  B.rectV(sTile, x0, x1, z0, z1, v0 - t, -1);
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

/** Flat-plate solar water heater: two tilted collectors on a galvanised frame and a horizontal tank. */
export function solarHeater(B, sinks, frameYaw, q, rng) {
  // the glazing goes in the metal batch as a dark, smooth metallic surface (saves a draw call)
  const sM = sinks.metal, sG = sinks.metal, sP = sinks.paint;
  const tilt = (rng.range(38, 46) * Math.PI) / 180;
  const panelW = 0.95, panelL = 2.0, n = rng.chance(0.7) ? 2 : 1;
  const totalW = n * panelW + (n - 1) * 0.06;
  const c = Math.cos(tilt), sn = Math.sin(tilt);
  // local frame of the heater: u across, w towards the sun (front), v up
  const foot = 0.25;
  const run = panelL * c, rise = panelL * sn;
  // collectors: tilted slab from (w = +run/2, v = foot) up to (w = -run/2, v = foot + rise)
  for (let i = 0; i < n; i++) {
    const a = -totalW / 2 + i * (panelW + 0.06), b = a + panelW;
    const wf = run / 2, wb = -run / 2, vf = foot, vb = foot + rise, th = 0.09;
    // glazing (top surface): dark blue-black absorber seen through the glass
    B.flat = [0.07, 0.08, 0.1];
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
    B.flat = [0.16, 0.17, 0.18];
    B.rectW(sinks.metal, -0.45, 0.45, 0.02, 2.0, d / 2 + 0.01, 1);
  }
}
