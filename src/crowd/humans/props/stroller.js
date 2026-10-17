import * as THREE from 'three';
import { Builder, PIECE, CH, V, roundRect, M4, alongY, lin, smooth } from './geo.js';
import { spokeUv } from './shading.js';

// Strollers at true scale: modern 4-wheel pushchair (swivel front twin casters, canopy,
// under-seat basket), 3-wheel jogger (air tyres, spoked wheels), classic pram with a deep
// bassinet and folding hood, and a light umbrella stroller (J handles, sling seat), each with
// an optional child (seated toddler, or a baby lying in the pram).
//
// Prop-local frame: metres, origin on the ground directly below the middle of the handle,
// -Z forward (the stroller runs ahead of the pusher), +X right. Animated pieces: rear wheels
// spin (anim.x), front wheels spin (anim.y) and swivel on their casters (anim.w), the child
// shows with the BABY flag (hat / hair by the look word, see shading.js).

const M = {
  frameB: { col: [1, 1, 1], rough: 0.4, metal: 0, ch: CH.PAINT_B, w: 0.4 },
  chrome: { col: [0.9, 0.9, 0.91], rough: 0.08, metal: 1, ch: CH.PLAIN, w: 0 },
  alloy: { col: [0.8, 0.81, 0.82], rough: 0.32, metal: 1, ch: CH.PLAIN, w: 0 },
  plastic: { col: [0.022, 0.022, 0.024], rough: 0.5, metal: 0, ch: CH.PLAIN, w: 0 },
  plasticGrey: { col: [0.16, 0.16, 0.165], rough: 0.5, metal: 0, ch: CH.PLAIN, w: 0 },
  foam: { col: [0.03, 0.03, 0.03], rough: 0.82, metal: 0, ch: CH.LEATHER, w: 0 },
  eva: { col: [0.035, 0.035, 0.036], rough: 0.8, metal: 0, ch: CH.TREAD, w: 3 },
  airTread: { col: [0.03, 0.03, 0.03], rough: 0.78, metal: 0, ch: CH.TREAD, w: 2 },
  rubber: { col: [0.03, 0.03, 0.03], rough: 0.75, metal: 0, ch: CH.PLAIN, w: 0 },
  whiteWall: { col: [0.62, 0.61, 0.58], rough: 0.6, metal: 0, ch: CH.PLAIN, w: 0 },
  fabric: { col: [1, 1, 1], rough: 0.9, metal: 0, ch: CH.FABRIC_A, w: 0 },
  fabricDark: { col: [0.42, 0.42, 0.42], rough: 0.92, metal: 0, ch: CH.FABRIC_A, w: 0 },
  lining: { col: [0.2, 0.2, 0.2], rough: 0.92, metal: 0, ch: CH.FABRIC_A, w: 0 },
  charcoal: { col: [0.035, 0.035, 0.037], rough: 0.9, metal: 0, ch: CH.FABRIC_B, w: 0 },
  net: { col: [0.025, 0.025, 0.026], rough: 0.8, metal: 0, ch: CH.MESH, w: 0.3 },
  red: { col: [0.42, 0.03, 0.025], rough: 0.4, metal: 0, ch: CH.PLAIN, w: 0 },
  spokeCone: { col: [0.7, 0.7, 0.72], rough: 0.25, metal: 1, ch: CH.SPOKES, w: 0 },
  skin: { col: [1, 1, 1], rough: 0.55, metal: 0, ch: CH.SKIN, w: 0 },
  cloth: { col: [1, 1, 1], rough: 0.88, metal: 0, ch: CH.CLOTH, w: 0 },
  hair: { col: lin('#3b2a1c'), rough: 0.6, metal: 0, ch: CH.PLAIN, w: 0 },
  shoe: { col: [0.05, 0.05, 0.055], rough: 0.6, metal: 0, ch: CH.PLAIN, w: 0 },
};

const FABRICS = ['#1a1b1d', '#2c2e31', '#55595e', '#8d9196', '#23304a', '#3d4a3a', '#b7ab93', '#d6cfbf', '#5b2630', '#1f4f55', '#46638a', '#c7a1a3', '#b8913d', '#6b5a4a'];

export const STROLLER_SPECS = [
  { id: 'pushchair', label: 'pushchair (4 wheels)', weight: 0.45, fabrics: FABRICS, frames: ['#161718', '#161718', '#b4b7ba', '#e8e7e3', '#c9b99c', '#4a4d50'], handleH: 1.03 },
  { id: 'jogger', label: 'three-wheel jogger', weight: 0.13, fabrics: FABRICS, frames: ['#161718', '#b4b7ba', '#4a4d50'], handleH: 1.04 },
  { id: 'pram', label: 'pram with bassinet', weight: 0.2, fabrics: ['#1d2436', '#2a2c30', '#d9d2c2', '#7d8288', '#3c4a40', '#5a2a31', '#e7e3da', '#a99f8c'], frames: ['#c9cbcd', '#161718', '#b4b7ba'], handleH: 1.02 },
  { id: 'umbrella', label: 'umbrella stroller', weight: 0.22, fabrics: FABRICS, frames: ['#161718', '#161718', '#b4b7ba', '#2a3d6b', '#6b2230'], handleH: 1.0 },
];

const LODQ = [
  { tube: (r) => Math.max(8, Math.min(14, Math.round(r * 800))), around: 48, prof: 12, spokes: 'geo', shell: [20, 16] },
  { tube: () => 6, around: 28, prof: 7, spokes: 'cone', shell: [12, 10] },
  { tube: () => 4, around: 10, prof: 3, spokes: 'cone', shell: [5, 5] },
];

// ------------------------------------------------------------------ parts

/** Stroller wheel about X at hub: radius r, tyre width w. style 'eva' | 'air' | 'wire'. */
function wheel(ctx, hub, r, w, style, st) {
  const { b, Q, lod } = ctx;
  const seg = Math.max(12, Math.round(Q.around * Math.min(1, r / 0.14)));
  b.with(st, () => {
    const h = style === 'air' ? Math.min(w * 0.95, r * 0.3) : style === 'wire' ? 0.022 : Math.min(0.03, r * 0.24);
    const w2 = w / 2;
    // tyre: rounded section from the right bead over the crown to the left bead (outside on the right)
    const n = Q.prof;
    const pr = [];
    for (let i = 0; i <= n; i++) {
      const tt = -Math.PI / 2 + 0.35 + (i / n) * (Math.PI * 2 - 0.7);
      pr.push([w2 * Math.cos(tt), r - h / 2 + (h / 2) * Math.sin(tt)]);
    }
    const tread = style === 'air' ? M.airTread : M.eva;
    const C = 2 * Math.PI * r;
    if (style === 'wire') {
      // pram: black tread, white side walls
      b.with(M.whiteWall, () => {
        b.revolveX(hub, [[w2 * 0.8, r - h], [w2, r - h * 0.5], [w2 * 0.9, r - h * 0.15]], seg);
        b.revolveX(hub, [[-w2 * 0.9, r - h * 0.15], [-w2, r - h * 0.5], [-w2 * 0.8, r - h]], seg);
      });
      b.with(M.rubber, () => b.revolveX(hub, [[w2 * 0.9, r - h * 0.15], [w2 * 0.5, r - 0.001], [0, r], [-w2 * 0.5, r - 0.001], [-w2 * 0.9, r - h * 0.15]], seg));
    } else {
      const arcPts = pr;
      const arc = [0];
      for (let j = 1; j < arcPts.length; j++) arc.push(arc[j - 1] + Math.hypot(arcPts[j][0] - arcPts[j - 1][0], arcPts[j][1] - arcPts[j - 1][1]));
      const half = arc[arc.length - 1] / 2;
      b.with(tread, () => b.revolveX(hub, arcPts, seg, { uv: (I, J) => [(I / seg) * C, arc[Math.min(J, arc.length - 1)] - half] }));
    }
    // rim / hub
    const rin = r - h;
    if (style === 'eva') {
      // moulded plastic wheel: rim ring, six spokes, hub cap
      b.with(M.plastic, () => {
        b.revolveX(hub, [[w2 * 0.85, rin - 0.004], [w2 * 0.85, rin + 0.004], [-w2 * 0.85, rin + 0.004], [-w2 * 0.85, rin - 0.004], [-w2 * 0.6, rin - 0.012], [w2 * 0.6, rin - 0.012]].reverse(), seg);
        b.revolveX(hub, [[w2 * 0.7, 0.004], [w2 * 0.75, 0.02], [w2 * 0.3, 0.026], [-w2 * 0.3, 0.026], [-w2 * 0.75, 0.02], [-w2 * 0.7, 0.004]], Math.max(8, seg >> 1));
        if (lod < 2) {
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            const p0 = V(hub.x, hub.y + Math.cos(a) * 0.022, hub.z - Math.sin(a) * 0.022);
            const p1 = V(hub.x, hub.y + Math.cos(a) * (rin - 0.008), hub.z - Math.sin(a) * (rin - 0.008));
            b.sweep([p0, p1], roundRect(w2 * 0.35, 0.007, 0.003, 1), { n: 1, N0: V(1, 0, 0) });
          }
        } else {
          b.with({ ...M.plasticGrey, col: [0.06, 0.06, 0.065] }, () => {
            b.revolveX(hub, [[w2 * 0.2, 0.02], [w2 * 0.2, rin - 0.01]], seg);
            b.revolveX(hub, [[-w2 * 0.2, rin - 0.01], [-w2 * 0.2, 0.02]], seg);
          });
        }
      });
    } else {
      const rimM = style === 'wire' ? M.chrome : M.alloy;
      b.with(rimM, () => {
        b.revolveX(hub, [[w2 * 0.7, rin - 0.006], [w2 * 0.7, rin + 0.003], [-w2 * 0.7, rin + 0.003], [-w2 * 0.7, rin - 0.006]].reverse(), seg);
        b.revolveX(hub, [[0.03, 0.006], [0.028, 0.018], [-0.028, 0.018], [-0.03, 0.006]], 10);
      });
      // spokes: geometry near, alpha cones further
      const nS = style === 'wire' ? 10 : 9;
      if (Q.spokes === 'geo') {
        for (const sx of [1, -1]) {
          for (let k = 0; k < nS; k++) {
            const a = (k / nS) * Math.PI * 2 + (sx > 0 ? Math.PI / nS : 0);
            const h0 = V(hub.x + sx * 0.026, hub.y + Math.cos(a) * 0.017, hub.z - Math.sin(a) * 0.017);
            const r0 = V(hub.x, hub.y + Math.cos(a) * (rin - 0.004), hub.z - Math.sin(a) * (rin - 0.004));
            b.with(style === 'wire' ? M.chrome : M.alloy, () => b.tube([h0, r0], 0.0011, 4, { n: 1 }));
          }
        }
      } else {
        for (const sx of [1, -1]) {
          const rot = sx > 0 ? Math.PI / nS : 0;
          const n = lod === 1 ? 28 : 14;
          const uvA = [0, 0];
          const prof = sx > 0 ? [[sx * 0.026, 0.017], [0.0005, rin - 0.004]] : [[0.0005 * sx, rin - 0.004], [sx * 0.026, 0.017]];
          b.with(M.spokeCone, () => b.revolveX(hub, prof, n, {
            twoSided: true,
            uv: (I, J) => { const jj = sx > 0 ? J : 1 - J; spokeUv(3, jj ? 1 : 0.19, (I / n) * Math.PI * 2 * sx + rot, uvA); return [uvA[0], uvA[1]]; },
          }));
        }
      }
    }
  });
}

/** Swivel caster: vertical housing at (x, yTop, z), fork, single or twin wheels. */
function caster(ctx, x, yTop, z, r, w, twin, trail = 0.035) {
  const { b } = ctx;
  const piv = [x, yTop, z];
  const hub = V(x, r, z + trail);
  b.with({ piece: PIECE.CASTER, piv }, () => {
    b.with(M.plastic, () => {
      b.tube([V(x, yTop + 0.02, z), V(x, yTop - 0.03, z)], 0.017, ctx.Q.tube(0.017), { n: 1, caps: 'flat' });
      // fork: a moulded yoke over the wheel(s)
      const half = twin ? 0.004 : w / 2 + 0.006;
      if (twin) {
        b.sweep([V(x, yTop - 0.03, z), V(x, (yTop + r) / 2, z + trail * 0.6), V(x, r + 0.012, hub.z)], roundRect(0.009, 0.014, 0.005, 1), { n: 6, N0: V(1, 0, 0) });
      } else {
        for (const sx of [-1, 1]) b.sweep([V(x + sx * half, yTop - 0.025, z), V(x + sx * half, (yTop + r) / 2, z + trail * 0.6), V(x + sx * half, r, hub.z)], roundRect(0.004, 0.012, 0.003, 1), { n: 6, N0: V(1, 0, 0) });
        b.rbox(half + 0.004, 0.006, 0.016, 0.004, M4([x, yTop - 0.028, z]), 1);
      }
    });
  });
  const offs = twin ? [-0.027, 0.027] : [0];
  for (const o of offs) {
    const h = V(x + o, r, hub.z);
    wheel(ctx, h, r, twin ? w * 0.85 : w, 'eva', { piece: PIECE.CASTER_WHEEL, piv, aux: [h.x, h.y, h.z, 0] });
  }
}

function tubeF(ctx, pts, r, mat = M.frameB, caps = null) {
  const { b, Q } = ctx;
  b.with(mat, () => b.tube(pts, r, Q.tube(r), { caps, stepRad: ctx.lod ? 0.35 : 0.15, maxLen: ctx.lod === 2 ? 2 : 0.3 }));
}

/** Foam handle bar (or J grips) between points. */
function grip(ctx, pts, r = 0.0165) {
  const { b, Q } = ctx;
  b.with(M.foam, () => b.tube(pts, r, Q.tube(r), { caps: 'round', stepRad: 0.2 }));
}

/**
 * Clamshell canopy: a barrel of fabric revolved about the X axis through the hinge (hy, hz),
 * from angle a0 (back) to a1 (front, 0 = straight up, + forward), ribbed into panels.
 */
function canopy(ctx, hy, hz, halfW, rad, a0, a1, panels = 3, mat = M.fabric) {
  const { b, Q } = ctx;
  const [nA, nX] = Q.shell;
  const rowsO = [], rowsI = [];
  const th = 0.006;
  for (let i = 0; i <= nA; i++) {
    const t = i / nA;
    const a = a0 + (a1 - a0) * t;
    // panel seams: the fabric sags slightly between ribs
    const pp = (t * panels) % 1;
    const sag = 1 - 0.035 * Math.sin(Math.PI * pp);
    const rowO = [], rowI = [];
    for (let j = 0; j <= nX; j++) {
      const u = j / nX;
      const x = halfW * (1 - 2 * u);                 // +x -> -x
      // clam shell: domed top, side panels running down to the hinges
      const e = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x) / halfW, 4)), 0.25);
      const rr = rad * (0.1 + 0.9 * e) * sag;
      // sides drop vertically below the hinge line at the edges
      rowO.push(V(x, hy + Math.cos(a) * rr, hz - Math.sin(a) * rr));
      rowI.push(V(x * 0.985, hy + Math.cos(a) * (rr - th), hz - Math.sin(a) * (rr - th)));
    }
    rowsO.push(rowO);
    rowsI.push(rowI.slice().reverse());
  }
  // outer shell (outside on the right of +x -> -x) and the darker lining facing inwards
  b.with(mat, () => b.surface(rowsO, { flip: a1 > a0 }));
  b.with({ ...M.lining, aoFn: () => 0.6 }, () => b.surface(rowsI, { flip: a1 > a0 }));
  // front visor binding
  const edge = rowsO[rowsO.length - 1];
  b.with(M.charcoal, () => b.tube(edge, 0.006, 5, { stepRad: 0.3, maxLen: 0.06 }));
  // rib lines (hoops) at the panel joins
  if (ctx.lod < 2) {
    for (let k = 1; k < panels; k++) {
      const i = Math.round((k / panels) * nA);
      b.with({ ...mat, col: [0.85, 0.85, 0.85] }, () => b.tube(rowsO[i].map((p) => p.clone().add(V(0, 0, 0)).lerp(V(p.x, hy, hz), -0.012)), 0.004, 4, { stepRad: 0.3, maxLen: 0.08 }));
    }
  }
  return { edge };
}

/** Padded seat tub along a centre path (footrest -> seat -> backrest top), width w. */
function seatTub(ctx, path, w, mat = M.fabricDark) {
  const { b, Q } = ctx;
  const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
  const n = ctx.lod === 2 ? 6 : 16;
  const rows = [];
  const w2 = w / 2;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = curve.getPointAt(t);
    const T = curve.getTangentAt(t);
    const up = new THREE.Vector3(1, 0, 0).cross(T).normalize();     // normal of the seat surface (towards the child)
    // U section: padded bottom with raised sides, closed underneath
    const side = 0.07 * (0.6 + 0.4 * smooth(0.2, 0.6, t));
    const ring = [];
    const m = Q.shell[1];
    for (let j = 0; j < m; j++) {
      const a = (j / m) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const x = Math.sign(c) * Math.pow(Math.abs(c), 0.35) * w2;
      const yy = s > 0 ? -0.025 * s + side * Math.pow(Math.abs(c), 6) : -0.03 * Math.pow(-s, 0.6);
      ring.push(p.clone().add(V(x, 0, 0)).addScaledVector(up, yy));
    }
    rows.push(ring);
  }
  const c0 = rows[0].reduce((a, q) => a.add(q), V(0, 0, 0)).multiplyScalar(1 / rows[0].length);
  const c1 = rows[n].reduce((a, q) => a.add(q), V(0, 0, 0)).multiplyScalar(1 / rows[n].length);
  b.with({ ...mat, aoFn: (x, y, z, nx, ny) => 0.75 + 0.25 * Math.max(0, ny) }, () => b.loft(rows, { capStart: c0, capEnd: c1 }));
}

/** Seated toddler: hips at p (seat surface), facing -Z, back reclined by `recline` (rad). */
function toddler(ctx, p, recline = 0.25, lying = false) {
  const { b, lod } = ctx;
  const piv = [p.x, p.y, p.z];
  const seg = lod === 0 ? 14 : lod === 1 ? 9 : 6;
  const ring = lod === 0 ? 9 : lod === 1 ? 6 : 4;
  // under a canopy most of the sky is hidden: the child gets little ambient light
  b.with({ piece: PIECE.BABY, piv, ao: lying ? 0.8 : 0.6 }, () => {
    if (lying) {
      // baby lying under a blanket in the bassinet, head towards the hood (+Z)
      b.with(M.skin, () => b.ellipsoid(V(p.x, p.y + 0.05, p.z + 0.2), 0.058, 0.055, 0.064, seg, ring));
      b.with({ piece: PIECE.BABY_HAT, piv }, () => b.with(M.cloth, () => b.ellipsoid(V(p.x, p.y + 0.07, p.z + 0.225), 0.062, 0.05, 0.058, seg, ring)));
      b.with(M.cloth, () => b.ellipsoid(V(p.x, p.y + 0.03, p.z - 0.05), 0.15, 0.06, 0.22, seg, ring));
      return;
    }
    const cr = Math.cos(recline), sr = Math.sin(recline);
    const up = V(0, cr, sr);        // back direction (leaning back towards +Z)
    const chest = p.clone().addScaledVector(up, 0.17);
    const neck = p.clone().addScaledVector(up, 0.27);
    const head = p.clone().addScaledVector(up, 0.36).add(V(0, 0, -0.012));
    b.with(M.cloth, () => {
      // torso and hips (romper)
      b.ellipsoid(chest, 0.085, 0.12, 0.068, seg, ring);
      b.ellipsoid(p.clone().addScaledVector(up, 0.04).add(V(0, 0, -0.01)), 0.09, 0.07, 0.075, seg, ring);
      // thighs along the seat, shins over the edge
      for (const sx of [-1, 1]) {
        const hip = p.clone().add(V(sx * 0.045, 0.02, -0.02));
        const knee = hip.clone().add(V(sx * 0.012, 0.01, -0.17));
        const ankle = knee.clone().add(V(0, -0.15, -0.03));
        b.tube([hip, knee], (t) => 0.042 - 0.01 * t, ctx.Q.tube(0.04) >> 1 || 4, { n: 2, caps: ['round', 'round'] });
        b.tube([knee, ankle], (t) => 0.032 - 0.008 * t, ctx.Q.tube(0.03) >> 1 || 4, { n: 2, caps: ['round', null] });
        b.with(M.shoe, () => b.ellipsoid(ankle.clone().add(V(0, -0.02, -0.025)), 0.03, 0.026, 0.05, seg >> 1, ring >> 1 || 3));
        // arms: shoulders down to the lap
        const sh = chest.clone().addScaledVector(up, 0.07).add(V(sx * 0.085, 0, 0));
        const el = sh.clone().add(V(sx * 0.02, -0.12, -0.02));
        const wr = el.clone().add(V(-sx * 0.03, 0.0, -0.11));
        b.tube([sh, el], 0.026, ctx.Q.tube(0.026) >> 1 || 4, { n: 2, caps: ['round', 'round'] });
        b.tube([el, wr], 0.022, ctx.Q.tube(0.022) >> 1 || 4, { n: 2, caps: [null, null] });
        b.with(M.skin, () => b.ellipsoid(wr.clone().add(V(0, 0, -0.025)), 0.022, 0.018, 0.03, seg >> 1, ring >> 1 || 3));
      }
    });
    b.with(M.skin, () => {
      b.tube([neck.clone().addScaledVector(up, -0.03), neck.clone().addScaledVector(up, 0.03)], 0.032, 6, { n: 1 });
      b.ellipsoid(head, 0.068, 0.076, 0.074, seg, ring);
      if (lod < 2) {
        // ears, full cheeks and a small nose (a toddler's face is round and low on the head)
        for (const sx of [-1, 1]) {
          b.ellipsoid(head.clone().add(V(sx * 0.066, -0.005, 0.005)), 0.01, 0.018, 0.012, 6, 4);
          b.ellipsoid(head.clone().add(V(sx * 0.027, -0.03, -0.036)), 0.029, 0.026, 0.028, 8, 6);
        }
        b.ellipsoid(head.clone().add(V(0, -0.014, -0.071)), 0.011, 0.009, 0.01, 6, 4);
      }
    });
    if (lod < 2) {
      // eyes (dark, glossy) under the brow
      for (const sx of [-1, 1]) b.with({ col: [0.02, 0.014, 0.01], rough: 0.15, metal: 0, ch: CH.PLAIN, w: 0 }, () => b.ellipsoid(head.clone().add(V(sx * 0.024, 0.004, -0.066)), 0.008, 0.0055, 0.004, 6, 4));
    }
    // hair (no hat) or a soft sun hat
    b.with({ piece: PIECE.BABY_HAIR, piv }, () => b.with(M.hair, () => b.ellipsoid(head.clone().add(V(0, 0.016, 0.01)), 0.07, 0.068, 0.072, seg, ring)));
    b.with({ piece: PIECE.BABY_HAT, piv }, () => b.with(M.cloth, () => {
      b.ellipsoid(head.clone().add(V(0, 0.024, 0.006)), 0.074, 0.066, 0.078, seg, ring);
      b.revolveY(head.clone().add(V(0, 0.012, 0.006)), [[0.115, -0.022], [0.09, -0.004], [0.07, 0.004]], seg);
      b.revolveY(head.clone().add(V(0, 0.0115, 0.006)), [[0.07, 0.0], [0.09, -0.008], [0.115, -0.026]], seg);
    }));
  });
}

// ------------------------------------------------------------------ variants

function pushchair(ctx, jog = false) {
  const { b, lod, spec } = ctx;
  const H = spec.handleH;
  const fw = jog ? 0 : 0.2;              // front caster track (half)
  const rr = jog ? 0.2 : 0.135, rw = jog ? 0.05 : 0.045;
  const zr = jog ? -0.26 : -0.2, xr = jog ? 0.3 : 0.285;
  const fr = jog ? 0.15 : 0.085;
  const zf = jog ? -0.86 : -0.71;
  const hinge = (sx) => V(sx * 0.235, jog ? 0.6 : 0.62, jog ? -0.32 : -0.27);
  // handle bar (foam), side tubes down to the front, rear legs
  const hw = 0.235;
  grip(ctx, [V(-hw, H, 0.0), V(-hw * 0.6, H + 0.004, -0.006), V(hw * 0.6, H + 0.004, -0.006), V(hw, H, 0.0)], 0.0175);
  for (const sx of [-1, 1]) {
    const top = V(sx * hw, H, 0);
    const hg = hinge(sx);
    const front = jog ? V(sx * 0.07, 0.36, zf + 0.08) : V(sx * fw, 0.25, zf);
    tubeF(ctx, [top.clone().add(V(0, 0.01, 0.012)), top.clone().add(V(0, -0.03, -0.02)), hg], 0.0125);
    tubeF(ctx, jog ? [hg, V(sx * 0.17, 0.46, (hg.z + front.z) / 2), front] : [hg, front.clone().add(V(0, 0.03, 0))], 0.0125);
    tubeF(ctx, [hg.clone().add(V(0, 0, 0.02)), V(sx * (xr - 0.035), rr + 0.02, zr + 0.01)], 0.0125);
    // hinge block, rear wheel hub mount
    b.with(M.plastic, () => b.rbox(0.017, 0.034, 0.03, 0.008, M4([hg.x, hg.y, hg.z]), lod ? 1 : 2));
    b.with(M.plastic, () => b.rbox(0.016, 0.03, 0.03, 0.007, M4([sx * (xr - 0.035), rr + 0.01, zr]), 1));
    // rear wheels
    wheel(ctx, V(sx * xr, rr, zr), rr, rw, jog ? 'air' : 'eva', { piece: PIECE.RWHEEL, piv: [0, rr, zr] });
    if (!jog) caster(ctx, sx * fw, 0.25, zf, fr, 0.038, true);
  }
  // rear axle with brake pedal
  tubeF(ctx, [V(-xr + 0.03, rr + 0.005, zr), V(xr - 0.03, rr + 0.005, zr)], 0.008, M.alloy);
  if (lod < 2) b.with(M.red, () => b.rbox(0.03, 0.006, 0.025, 0.004, M4([0.12, rr + 0.02, zr + 0.025], [0.3, 0, 0]), 1));
  if (jog) {
    // single fixed front wheel on a fork
    const fz = zf;
    for (const sx of [-1, 1]) tubeF(ctx, [V(sx * 0.07, 0.36, zf + 0.08), V(sx * 0.04, fr + 0.02, fz)], 0.011);
    wheel(ctx, V(0, fr, fz), fr, 0.045, 'air', { piece: PIECE.FWHEEL_S, piv: [0, fr, fz] });
  }
  // seat: tub from the footrest up the seat to the backrest top
  const sy = jog ? 0.5 : 0.48, sz0 = jog ? -0.56 : -0.5;
  const seat = [V(0, 0.3, sz0 - 0.1), V(0, sy - 0.03, sz0), V(0, sy, -0.28), V(0, sy + 0.08, -0.2), V(0, 0.86, -0.13)];
  seatTub(ctx, seat, 0.32, M.fabricDark);
  // padded back of the seat unit (closes the seat from behind, down to the seat pan)
  {
    const top = V(0, 0.84, -0.115), bot = V(0, sy - 0.05, -0.215);
    b.with({ ...M.fabricDark, aoFn: (x, y, z, nx, ny, nz) => (nz > 0.3 ? 0.9 : 0.7) }, () => b.rbox(0.158, top.distanceTo(bot) / 2, 0.028, 0.022, alongY(bot, top).multiply(M4([0, top.distanceTo(bot) / 2, 0.012])), ctx.lod ? 1 : 3));
  }
  // footrest bar, bumper bar
  tubeF(ctx, [V(-0.15, 0.29, sz0 - 0.12), V(0.15, 0.29, sz0 - 0.12)], 0.009, M.plastic);
  grip(ctx, [V(-0.21, 0.66, -0.36), V(-0.17, 0.69, -0.5), V(0.17, 0.69, -0.5), V(0.21, 0.66, -0.36)], 0.012);
  // canopy from behind the backrest over the child
  canopy(ctx, 0.79, -0.31, 0.215, jog ? 0.3 : 0.285, -1.45, jog ? 1.3 : 1.28, 3);
  for (const sx of [-1, 1]) b.with(M.plastic, () => b.rbox(0.012, 0.022, 0.022, 0.006, M4([sx * 0.215, 0.79, -0.31]), 1));
  // shopping basket under the seat
  if (!jog || lod < 2) {
    const y0 = 0.14, y1 = 0.36, z0 = zr - 0.03, z1 = sz0 + 0.02, x0 = -0.17, x1 = 0.17;
    const p = (x, y, z) => V(x, y, z);
    const panel = (A, B, C, D) => {
      const lu = A.distanceTo(B), lv = A.distanceTo(D);
      b.with(M.net, () => b.surface([[A, D], [B, C]], { twoSided: true, uv: (I, J) => [(I * lu) / 0.012, (J * lv) / 0.012] }));
    };
    panel(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1));
    panel(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0));
    panel(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1));
    panel(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0));
    b.with(M.plastic, () => b.tube([p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), p(x0, y1, z0)], 0.005, 4, { n: 4 }));
  }
  toddler(ctx, V(0, sy + 0.01, -0.33), 0.32);
  return {
    grips: [V(-hw + 0.06, H + 0.004, 0), V(hw - 0.06, H + 0.004, 0)], rearRadius: rr, frontRadius: fr,
    length: -(zf - fr), seat: V(0, sy, -0.33),
  };
}

function pram(ctx) {
  const { b, lod, spec } = ctx;
  const H = spec.handleH;
  const r = 0.15, zr = -0.2, zf = -0.82, xw = 0.27;
  // chassis: chrome side rails with a curved C spring up to the body
  for (const sx of [-1, 1]) {
    tubeF(ctx, [V(sx * (xw - 0.03), r, zr), V(sx * 0.2, 0.24, zr - 0.08), V(sx * 0.2, 0.24, zf + 0.08), V(sx * (xw - 0.03), r, zf)], 0.011, M.chrome);
    // C springs from the chassis rails up to the body
    for (const z of [zr - 0.14, zf + 0.14]) {
      const o = Math.sign(z - (zr + zf) / 2);
      tubeF(ctx, [V(sx * 0.2, 0.24, z), V(sx * 0.2, 0.34, z + o * 0.06), V(sx * 0.16, 0.48, z + o * 0.05), V(sx * 0.12, 0.6, z)], 0.008, M.chrome);
    }
    wheel(ctx, V(sx * xw, r, zr), r, 0.03, 'wire', { piece: PIECE.RWHEEL, piv: [0, r, zr] });
    wheel(ctx, V(sx * xw, r, zf), r, 0.03, 'wire', { piece: PIECE.FWHEEL_S, piv: [0, r, zf] });
    // handle arms from the chassis to the handle
    tubeF(ctx, [V(sx * 0.2, 0.24, zr - 0.04), V(sx * 0.215, 0.6, -0.12), V(sx * 0.22, H - 0.02, 0.0)], 0.011, M.chrome);
  }
  for (const z of [zr, zf]) tubeF(ctx, [V(-xw + 0.03, r, z), V(xw - 0.03, r, z)], 0.007, M.chrome);
  grip(ctx, [V(-0.24, H, 0.01), V(-0.15, H + 0.006, 0.0), V(0.15, H + 0.006, 0.0), V(0.24, H, 0.01)], 0.017);
  // bassinet body: boat-shaped tub (loft of rounded sections), rim at y 0.86
  const nL = lod === 2 ? 6 : 14, nR = lod === 2 ? 8 : 18;
  const rings = [];
  const zA = -0.12, zB = -0.9, top = 0.86, bot = 0.58;
  for (let i = 0; i <= nL; i++) {
    const t = i / nL;
    const z = zA + (zB - zA) * t;
    const e = Math.sqrt(Math.max(0.02, 1 - Math.pow(Math.abs(2 * t - 1), 4)));
    const hw = 0.19 * (0.55 + 0.45 * e);
    const depth = (top - bot) * (0.7 + 0.3 * e);
    const ring = [];
    for (let j = 0; j < nR; j++) {
      const a = (j / nR) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const x = Math.sign(c) * Math.pow(Math.abs(c), 0.5) * hw;
      const y = s > 0 ? top - 0.004 * (1 - Math.abs(c)) : top - depth * Math.pow(-s, 0.7);
      ring.push(V(x, y, z));
    }
    rings.push(ring);
  }
  b.with({ ...M.fabric, aoFn: (x, y) => 0.6 + 0.4 * smooth(0.5, 0.8, y) }, () => b.loft(rings, { capStart: V(0, top - 0.15, zA - 0.01), capEnd: V(0, top - 0.15, zB + 0.01) }));
  // rim piping
  const rim = [];
  for (let i = 0; i <= nL * 2; i++) {
    const t = i / (nL * 2);
    const z = zA + (zB - zA) * t;
    const e = Math.sqrt(Math.max(0.02, 1 - Math.pow(Math.abs(2 * t - 1), 4)));
    rim.push(V(0.2 * (0.55 + 0.45 * e), top + 0.004, z));
  }
  const rimAll = rim.concat(rim.slice().reverse().map((p) => V(-p.x, p.y, p.z)));
  b.with(M.charcoal, () => b.tube(rimAll, 0.008, 5, { stepRad: 0.3, maxLen: 0.06 }));
  // hood over the head end, apron over the foot end
  canopy(ctx, 0.84, -0.3, 0.205, 0.26, -1.5, 0.15, 4);
  b.with(M.fabric, () => {
    const rows = [];
    for (let i = 0; i <= 4; i++) {
      const z = -0.48 - (i / 4) * 0.4;
      const row = [];
      for (let j = 0; j <= 8; j++) { const x = 0.19 * (1 - 2 * j / 8); row.push(V(x, top + 0.02 + 0.03 * (1 - Math.pow(x / 0.19, 2)), z)); }
      rows.push(row);
    }
    b.surface(rows, { out: () => V(0, 1, 0), twoSided: false });
  });
  toddler(ctx, V(0, 0.7, -0.42), 0, true);
  return { grips: [V(-0.17, H + 0.006, 0), V(0.17, H + 0.006, 0)], rearRadius: r, frontRadius: r, length: -(zf - r), seat: V(0, 0.72, -0.3) };
}

function umbrella(ctx) {
  const { b, lod, spec } = ctx;
  const H = spec.handleH;
  const r = 0.075, zr = -0.17, zf = -0.68, xw = 0.2;
  const tr = 0.0095;
  for (const sx of [-1, 1]) {
    // J handle: hook bending back at the top, foam grip on the hook
    const top = V(sx * xw, H - 0.05, -0.03);
    tubeF(ctx, [V(sx * xw, 0.18, zf + 0.04), V(sx * xw, 0.62, -0.25), top], tr);
    const hook = [top, V(sx * xw, H, 0.0), V(sx * xw, H - 0.015, 0.06), V(sx * xw, H - 0.06, 0.07)];
    grip(ctx, hook, 0.016);
    // rear leg
    tubeF(ctx, [V(sx * xw, 0.58, -0.27), V(sx * (xw + 0.01), r + 0.03, zr)], tr);
    b.with(M.plastic, () => b.rbox(0.012, 0.022, 0.02, 0.005, M4([sx * xw, 0.58, -0.27]), 1));
    // twin rear wheels (fixed) and swivel twin front casters
    for (const o of [-0.022, 0.022]) wheel(ctx, V(sx * (xw + 0.01) + o, r, zr), r, 0.024, 'eva', { piece: PIECE.RWHEEL, piv: [0, r, zr] });
    caster(ctx, sx * xw, 0.18, zf + 0.03, r, 0.03, true, 0.03);
  }
  tubeF(ctx, [V(-xw, 0.2, zf + 0.05), V(xw, 0.2, zf + 0.05)], 0.007, M.plastic);
  tubeF(ctx, [V(-xw, r + 0.03, zr), V(xw, r + 0.03, zr)], 0.007);
  // sling seat between the side tubes: back, seat and leg rest in one sagging sheet
  const rows = [];
  const pts = [V(0, 0.92, -0.13), V(0, 0.62, -0.2), V(0, 0.44, -0.3), V(0, 0.43, -0.42), V(0, 0.3, -0.52)];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const n = lod === 2 ? 5 : 12, m = lod === 2 ? 4 : 10;
  for (let i = 0; i <= n; i++) {
    const p = curve.getPointAt(i / n);
    const row = [];
    for (let j = 0; j <= m; j++) {
      const u = j / m, x = (xw - 0.012) * (1 - 2 * u);
      const sag = 0.035 * Math.sin(Math.PI * u);
      row.push(p.clone().add(V(x, -sag * 0.6, sag * 0.8)));
    }
    rows.push(row);
  }
  b.with(M.fabric, () => b.surface(rows, { twoSided: true }));
  canopy(ctx, 0.84, -0.2, 0.2, 0.22, -0.95, 1.1, 2);
  toddler(ctx, V(0, 0.45, -0.33), 0.38);
  return { grips: [V(-xw, H - 0.005, 0.03), V(xw, H - 0.005, 0.03)], rearRadius: r, frontRadius: r, length: -(zf - r), seat: V(0, 0.45, -0.33) };
}

const BUILD = { pushchair: (c) => pushchair(c, false), jogger: (c) => pushchair(c, true), pram, umbrella };

function buildLod(spec, lod) {
  const b = new Builder();
  const ctx = { b, spec, Q: LODQ[lod], lod };
  const info = BUILD[spec.id](ctx);
  const g = b.build();
  g.name = `stroller.${spec.id}.lod${lod}`;
  return { g, info };
}

/** Variant record: LOD 1 / 2 now, LOD 0 on demand (ensureLod0). */
export function makeStrollerVariant(spec, { lod0 = false } = {}) {
  const lods = [null, null, null];
  const r1 = buildLod(spec, 1);
  lods[1] = r1.g;
  lods[2] = buildLod(spec, 2).g;
  const info = r1.info;
  const H = spec.handleH;
  const rec = {
    spec, id: spec.id, label: spec.label, lods,
    ensureLod0() { if (!lods[0]) lods[0] = buildLod(spec, 0).g; return lods[0]; },
    attach: { gripL: info.grips[0], gripR: info.grips[1], seat: info.seat },
    dims: {
      handleHeight: H, length: info.length + 0.02, width: 0.62, rearRadius: info.rearRadius, frontRadius: info.frontRadius,
      pushOffset: 0.4,     // pusher's root (between the feet) this far behind the handle (+Z)
    },
    size: 1.06,
  };
  if (lod0) rec.ensureLod0();
  return rec;
}

/** Pusher contact points (prop-local). */
export function strollerAttachments(rec, out = {}) {
  out.gripL = (out.gripL || new THREE.Vector3()).copy(rec.attach.gripL);
  out.gripR = (out.gripR || new THREE.Vector3()).copy(rec.attach.gripR);
  out.handle = (out.handle || new THREE.Vector3()).copy(rec.attach.gripL).lerp(rec.attach.gripR, 0.5);
  out.seat = (out.seat || new THREE.Vector3()).copy(rec.attach.seat);
  out.pusher = (out.pusher || new THREE.Vector3()).set(0, 0, rec.dims.pushOffset);
  return out;
}
