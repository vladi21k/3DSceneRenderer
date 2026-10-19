import * as THREE from 'three';
import { GeoWriter, PosWriter, box, boxPos, lathe, sweepBar, shared, posTemplate } from './geo.js';
import { RNG } from '../../core/rng.js';
import { U } from '../../core/uniforms.js';
import { uIronA2C, centroidColor } from './mats.js';

// Small facade attachments: balcony planting (geraniums, herbs, trailing greens and
// surfinia, bougainvillea, dried-out pots), planter boxes with their rail hooks, pots,
// split AC units with brackets, pipes and the stains they leave on the wall, satellite
// dishes, balcony chairs and flags on angled poles.
// Shared shapes are built once as templates (written into the merged meshes) or as
// instanced geometries; their textures are painted on canvases at start-up. The small
// parts and the AC units share one material: the parts sample a white patch of the AC
// atlas. Position-only copies of the templates are the shadow casters.

// ---------------------------------------------------------------- templates
/** Frozen copy of a GeoWriter, re-emitted many times with different transforms; with
 *  `uv` every vertex samples that one texel (untextured parts in a textured material). */
export function template(W, uv = null) {
  const T = W.T.slice(0, W.n * 2);
  if (uv) for (let i = 0; i < W.n; i++) { T[i * 2] = uv[0]; T[i * 2 + 1] = uv[1]; }
  return { P: W.P.slice(0, W.n * 3), N: W.N.slice(0, W.n * 3), T, C: W.C.slice(0, W.n * 3), I: W.I.slice(0, W.ni), n: W.n };
}

/** Writes a template into W with `matrix` (THREE.Matrix4) and an RGB tint (fast path:
 *  straight into the writer's arrays; the writer's current kind() fills its kind stream). */
export function writeTemplate(W, t, matrix, tint = [1, 1, 1]) {
  W.setMatrix(matrix);
  W.reserve(t.n, t.I.length);
  const base = W.count, m = W.m, nm = W.nm;
  const { P, N, T, C } = t;
  const WP = W.P, WN = W.N, WT = W.T, WC = W.C;
  const tr = tint[0], tg = tint[1], tb = tint[2];
  for (let i = 0; i < t.n; i++) {
    const i3 = i * 3, o3 = (base + i) * 3;
    const x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
    WP[o3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    WP[o3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    WP[o3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const nx = N[i3], ny = N[i3 + 1], nz = N[i3 + 2];
    const X = nm[0] * nx + nm[3] * ny + nm[6] * nz, Y = nm[1] * nx + nm[4] * ny + nm[7] * nz, Z = nm[2] * nx + nm[5] * ny + nm[8] * nz;
    const l = 1 / (Math.sqrt(X * X + Y * Y + Z * Z) || 1);
    WN[o3] = X * l; WN[o3 + 1] = Y * l; WN[o3 + 2] = Z * l;
    WT[(base + i) * 2] = T[i * 2]; WT[(base + i) * 2 + 1] = T[i * 2 + 1];
    WC[o3] = C[i3] * tr; WC[o3 + 1] = C[i3 + 1] * tg; WC[o3 + 2] = C[i3 + 2] * tb;
  }
  if (W.K) W.K.fill(W.k, base, base + t.n);
  W.n += t.n;
  const I = W.I, I0 = t.I;
  for (let i = 0; i < I0.length; i++) I[W.ni + i] = base + I0[i];
  W.ni += I0.length;
}

// ---------------------------------------------------------------- canvas textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/** Plant atlas (1024 x 512): 4 x 2 cells of 256 px. The left half keeps its own colours:
 *  zonal geranium leaf, herb sprig (top), ivy sprig, dry twigs (bottom). The right half
 *  is painted near-white and tinted per instance: geranium umbel, bougainvillea bracts
 *  (top), small trumpet flowers, flower spikes (bottom). Two solid patches in the bottom
 *  corners of the left half (outside every card's UVs): stem green and twig brown. */
function plantTexture() {
  const cv = canvas(1024, 512), g = cv.getContext('2d');
  const r = new RNG(4242);
  const rgb = (c, k = 1, a = 1) => `rgba(${c[0] * k | 0},${c[1] * k | 0},${c[2] * k | 0},${a})`;
  /** Ovate leaf from its base (origin) to its tip at (L, 0), half width W/2. */
  const ovate = (L, W, tip = 0.75) => {
    g.beginPath(); g.moveTo(0, 0);
    g.bezierCurveTo(L * 0.22, -W * 0.72, L * tip, -W * 0.55, L, 0);
    g.bezierCurveTo(L * tip, W * 0.55, L * 0.22, W * 0.72, 0, 0);
  };
  /** A leaf at (x, y) pointing at `ang`: gradient fill, midrib, crisp margin. */
  const leafAt = (x, y, ang, L, W, c, mid = 0.35, tip = 0.75) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    ovate(L, W, tip);
    const gr = g.createLinearGradient(0, 0, L, 0);
    gr.addColorStop(0, rgb(c, 0.82)); gr.addColorStop(0.5, rgb(c, 1.04)); gr.addColorStop(1, rgb(c, 0.92));
    g.fillStyle = gr; g.fill();
    g.strokeStyle = rgb(c, 0.45, 0.6); g.lineWidth = 1.2; g.stroke();
    g.strokeStyle = rgb([255, 255, 220], 1, mid * 0.5); g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(1, 0); g.lineTo(L * 0.85, 0); g.stroke();
    g.restore();
  };
  /** Draws into atlas cell (cx, cy) only. */
  const inCell = (cx, cy, fn) => { g.save(); g.beginPath(); g.rect(cx * 256, cy * 256, 256, 256); g.clip(); fn(); g.restore(); };
  const stemLine = (pts, w, c) => {
    g.strokeStyle = c; g.lineWidth = w; g.lineCap = 'round';
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  };

  // ---- (0, 0) zonal geranium leaf
  const leaf = (x, y, R, rot, dark) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2 - Math.PI / 2;
      let rr = R * (1 + 0.06 * Math.cos(a * 7) + 0.025 * Math.cos(a * 29));
      const da = Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2));
      rr *= 1 - 0.55 * Math.exp(-((da / 0.2) ** 2)); // stem sinus
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath();
    const k = dark;
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, R);
    grd.addColorStop(0, `rgb(${84 * k | 0},${118 * k | 0},${54 * k | 0})`);
    grd.addColorStop(0.45, `rgb(${66 * k | 0},${98 * k | 0},${42 * k | 0})`);
    grd.addColorStop(0.56, `rgb(${50 * k | 0},${72 * k | 0},${32 * k | 0})`); // zonal ring
    grd.addColorStop(0.68, `rgb(${62 * k | 0},${94 * k | 0},${40 * k | 0})`);
    grd.addColorStop(1, `rgb(${58 * k | 0},${88 * k | 0},${36 * k | 0})`);
    g.fillStyle = grd; g.fill();
    g.strokeStyle = 'rgba(20,35,12,0.5)'; g.lineWidth = 1.5; g.stroke(); // crisp leaf margin
    // palmate veins from the petiole point
    g.strokeStyle = `rgba(${140 * k | 0},${170 * k | 0},${100 * k | 0},0.35)`; g.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      const a = Math.PI / 2 + (i - 4) * 0.62;
      g.beginPath(); g.moveTo(0, -R * 0.1); g.quadraticCurveTo(Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4 - R * 0.05, Math.cos(a) * R * 0.88, Math.sin(a) * R * 0.88); g.stroke();
    }
    g.restore();
  };
  leaf(128, 128, 104, Math.PI, 1);
  g.save(); g.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 900; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 110;
    g.fillStyle = r.chance(0.5) ? 'rgba(255,255,220,0.06)' : 'rgba(0,20,0,0.08)';
    g.fillRect(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 2, 2);
  }
  g.restore();

  // ---- (1, 0) herb sprig (basil, mint, oregano): a stem from the bottom edge with
  // opposite pairs of ovate leaves, smaller toward the tip, and two side shoots
  inCell(1, 0, () => {
    const ox = 256 + 128, oy = 248;
    const shoots = [[0, 0, r.range(-14, 14), -222, 3.2, 7], [-2, -78, -70, -176, 2.2, 4], [2, -112, 66, -196, 2, 4]];
    for (const [x0, y0, x1, y1, w, pairs] of shoots) {
      const cx = (x0 + x1) / 2 + r.range(-12, 12), cy = (y0 + y1) / 2;
      const P = (t) => [ox + (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1, oy + (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1];
      const pts = []; for (let i = 0; i <= 12; i++) pts.push(P(i / 12));
      stemLine(pts, w, 'rgb(88,112,52)');
      for (let p = 0; p < pairs; p++) {
        const t = 0.18 + 0.82 * (p / pairs) ** 0.9, [x, y] = P(t), [xa, ya] = P(Math.min(1, t + 0.02));
        const dir = Math.atan2(ya - y, xa - x), L = (46 - 26 * t) * r.range(0.85, 1.1) * (w > 3 ? 1 : 0.8);
        const c = [r.range(62, 84), r.range(112, 140), r.range(38, 52)];
        for (const s of [-1, 1]) leafAt(x, y, dir + s * r.range(0.95, 1.3), L, L * r.range(0.5, 0.6), c, 0.5);
      }
      const [tx, ty] = P(1);
      for (const s of [-1, 0, 1]) leafAt(tx, ty, -Math.PI / 2 + s * 0.5, 14, 8, [96, 150, 58], 0.3); // tip bud
    }
  });

  // ---- (0, 1) ivy sprig: a wavy stem from the top edge down, alternate three- to
  // five-lobed leaves on petioles, dark and glossy with pale veins
  inCell(0, 1, () => {
    const ox = 128, oy = 256;
    const pts = [];
    for (let i = 0; i <= 16; i++) { const t = i / 16; pts.push([ox + Math.sin(t * 5.5) * 12, oy + 8 + t * 236]); }
    stemLine(pts, 3, 'rgb(84,74,48)');
    const ivy = (x, y, R, rot) => {
      g.save(); g.translate(x, y); g.rotate(rot);
      g.beginPath();
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        // five lobes, the middle one longest; a sinus at the petiole (a = pi / 2)
        let rr = R * (0.58 + 0.42 * Math.pow(Math.abs(Math.cos((a + Math.PI / 2) * 2.5)), 1.6));
        rr *= 1 + 0.25 * Math.max(0, -Math.sin(a)); // the tip lobe (a = -pi / 2) reaches further
        rr *= 1 - 0.5 * Math.exp(-(((a - Math.PI / 2) / 0.22) ** 2));
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath();
      const k = r.range(0.8, 1.1);
      const grd = g.createRadialGradient(0, R * 0.3, 0, 0, 0, R * 1.2);
      grd.addColorStop(0, rgb([58, 92, 40], k)); grd.addColorStop(1, rgb([34, 60, 26], k));
      g.fillStyle = grd; g.fill();
      g.strokeStyle = 'rgba(12,24,8,0.55)'; g.lineWidth = 1.2; g.stroke();
      g.strokeStyle = 'rgba(190,210,160,0.35)'; g.lineWidth = 1.3;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.75;
        g.beginPath(); g.moveTo(0, R * 0.3); g.lineTo(Math.cos(a) * R * 0.85, Math.sin(a) * R * 0.85); g.stroke();
      }
      g.restore();
    };
    for (let i = 0; i < 7; i++) {
      const t = 0.08 + i * 0.13, s = i % 2 ? 1 : -1;
      const [x, y] = pts[Math.round(t * 16)];
      const R = r.range(28, 38) * (1 - 0.25 * t);
      const px = x + s * R * 0.95, py = y + R * 0.35;
      stemLine([[x, y], [px, py - R * 0.35]], 1.6, 'rgb(84,74,48)');
      ivy(px, py, R, s * r.range(0.6, 1.1) + Math.PI);
    }
  });

  // ---- (1, 1) dry: twiggy stems from the bottom edge, shrivelled and curled leaves in
  // straw, tan and grey-brown, a few still olive
  inCell(1, 1, () => {
    const ox = 256 + 128, oy = 506;
    const DRY = [[150, 118, 72], [122, 92, 58], [172, 148, 98], [98, 76, 50], [128, 118, 72], [140, 128, 108]];
    const twigs = [];
    for (let i = 0; i < 9; i++) {
      const x1 = r.range(-90, 90), y1 = -r.range(120, 225);
      const pts = []; const bend = r.range(-30, 30);
      for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push([ox + x1 * t + bend * Math.sin(t * 3.1), oy + y1 * t]); }
      twigs.push(pts);
      stemLine(pts, r.range(2.2, 3.4), 'rgb(104,86,62)');
    }
    // the shrivelled foliage hangs on in a loose mass, densest halfway up
    for (let i = 0; i < 80; i++) {
      const tw = twigs[i % twigs.length], [x, y] = tw[r.int(1, 8)];
      const c = DRY[r.int(0, DRY.length - 1)];
      const L = r.range(18, 36), curled = r.chance(0.45);
      leafAt(x + r.range(-6, 6), y + r.range(-6, 6), r.range(-Math.PI, Math.PI), L, L * (curled ? 0.25 : r.range(0.38, 0.52)), c.map((v) => v * r.range(0.85, 1.1)), 0.2, curled ? 0.55 : 0.75);
    }
  });

  // ---- (2, 0) geranium umbel: florets of five petals
  g.save(); g.translate(640, 128);
  const florets = [];
  for (let i = 0; i < 34; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 92;
    florets.push([Math.cos(a) * d, Math.sin(a) * d * 0.92, r.range(15, 21), r.range(0, 6.28)]);
  }
  florets.sort((p, q) => q[0] * q[0] + q[1] * q[1] - (p[0] * p[0] + p[1] * p[1]));
  for (const [x, y, s, rot] of florets) {
    const shade = 0.7 + 0.3 * (1 - Math.hypot(x, y) / 100);
    for (let p = 0; p < 5; p++) {
      const a = rot + (p / 5) * Math.PI * 2;
      g.save(); g.translate(x + Math.cos(a) * s * 0.55, y + Math.sin(a) * s * 0.55); g.rotate(a);
      g.beginPath(); g.ellipse(0, 0, s * 0.62, s * 0.44, 0, 0, Math.PI * 2);
      const c = Math.round(255 * shade * r.range(0.86, 1));
      g.fillStyle = `rgb(${c},${c},${c})`; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1; g.stroke();
      g.restore();
    }
    g.beginPath(); g.arc(x, y, s * 0.16, 0, Math.PI * 2); g.fillStyle = 'rgba(120,120,90,0.9)'; g.fill();
  }
  g.restore();

  // ---- (3, 0) bougainvillea: a loose spray of papery bract triplets, thin veins, a
  // small pale flower tube in each, gaps between the clusters
  inCell(3, 0, () => {
    const cl = [];
    for (let i = 0; i < 24; i++) {
      const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 92;
      cl.push([896 + Math.cos(a) * d, 128 + Math.sin(a) * d * 0.9, r.range(20, 28), r.range(0, 6.28)]);
    }
    cl.sort((p, q) => p[1] - q[1]);
    for (const [x, y, s, rot] of cl) {
      for (let p = 0; p < 3; p++) {
        const a = rot + (p / 3) * Math.PI * 2 + r.range(-0.2, 0.2);
        g.save(); g.translate(x, y); g.rotate(a);
        ovate(s * r.range(0.9, 1.1), s * 0.95, 0.6);
        const c = Math.round(255 * r.range(0.78, 1));
        const gr = g.createLinearGradient(0, 0, s, 0);
        gr.addColorStop(0, `rgb(${c * 0.8 | 0},${c * 0.8 | 0},${c * 0.8 | 0})`); gr.addColorStop(0.6, `rgb(${c},${c},${c})`);
        g.fillStyle = gr; g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1; g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.1)';
        for (const k of [-0.25, 0, 0.25]) { g.beginPath(); g.moveTo(2, 0); g.quadraticCurveTo(s * 0.4, s * k, s * 0.85, s * k * 0.6); g.stroke(); }
        g.restore();
      }
      g.beginPath(); g.ellipse(x, y, 2.5, 5, rot, 0, Math.PI * 2); g.fillStyle = 'rgba(245,240,215,0.95)'; g.fill();
    }
  });

  // ---- (2, 1) small trumpet flowers (surfinia, petunia, vinca): five fused lobes, a
  // darker throat and veins running into it
  inCell(2, 1, () => {
    const fl = [];
    for (let i = 0; i < 15; i++) {
      const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 90;
      fl.push([640 + Math.cos(a) * d, 384 + Math.sin(a) * d * 0.9, r.range(20, 29), r.range(0, 6.28)]);
    }
    fl.sort((p, q) => p[1] - q[1]);
    for (const [x, y, R, rot] of fl) {
      g.save(); g.translate(x, y); g.rotate(rot);
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const a = (i / 60) * Math.PI * 2, rr = R * (0.86 + 0.14 * Math.cos(a * 5));
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr * r.range(0.97, 1);
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath();
      const c = Math.round(255 * r.range(0.82, 1));
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, R);
      gr.addColorStop(0, `rgb(${c * 0.35 | 0},${c * 0.35 | 0},${c * 0.35 | 0})`); gr.addColorStop(0.3, `rgb(${c * 0.85 | 0},${c * 0.85 | 0},${c * 0.85 | 0})`);
      gr.addColorStop(1, `rgb(${c},${c},${c})`);
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1; g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 + 0.6; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * R * 0.8, Math.sin(a) * R * 0.8); g.stroke(); }
      g.restore();
    }
  });

  // ---- (3, 1) flower spikes (lavender, sage, bolting basil): thin stems from the bottom
  // edge, small florets crowded along their upper part
  inCell(3, 1, () => {
    for (let i = 0; i < 9; i++) {
      const x0 = 896 + r.range(-40, 40), x1 = 896 + r.range(-105, 105), y1 = 384 - r.range(70, 118);
      const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([x0 + (x1 - x0) * t, 506 - (506 - y1) * t]); }
      stemLine(pts, 2, 'rgb(170,176,160)');
      const n = r.int(9, 14);
      for (let k = 0; k < n; k++) {
        const t = 1 - 0.45 * (k / n) ** 1.1, x = x0 + (x1 - x0) * t, y = 506 - (506 - y1) * t;
        for (const s of [-1, 1]) {
          const c = Math.round(255 * r.range(0.72, 1));
          g.beginPath(); g.ellipse(x + s * r.range(2, 5), y + r.range(-2, 2), r.range(3.5, 5.5), r.range(2.5, 4), r.range(0, 3), 0, Math.PI * 2);
          g.fillStyle = `rgb(${c},${c},${c})`; g.fill();
          g.strokeStyle = 'rgba(0,0,0,0.15)'; g.lineWidth = 0.8; g.stroke();
        }
      }
    }
  });

  // solid patches: stem green, twig brown
  g.fillStyle = 'rgb(70,100,45)'; g.fillRect(0, 500, 12, 12);
  g.fillStyle = 'rgb(96,80,60)'; g.fillRect(500, 500, 12, 12);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
/** UV rectangle of atlas cell (cx, cy), cy = 0 the top row, inset by `px` texels. */
const cell = (cx, cy, px = 18) => [[(cx * 256 + px) / 1024, ((1 - cy) * 256 + px) / 512], [((cx + 1) * 256 - px) / 1024, ((2 - cy) * 256 - px) / 512]];
const STEM_UV = [6 / 1024, 6 / 512], TWIG_UV = [506 / 1024, 6 / 512];

// AC atlas (512 x 512): rows 0..352 the front (fan grille, service panel), below it the
// side louvre panel (x < 256) and the dusty top (x >= 256); an 8 x 8 white patch in the
// bottom-right corner (outside every face's UVs) for the untextured parts. A constant UV
// has no derivatives, so it always samples the full-resolution patch.
const AC_FRONT_V = 1 - 352 / 512;
const WHITE_UV = [508 / 512, 1 - 508 / 512];

/** Split AC outdoor unit: aged off-white enamel, grime at the edges and bottom. */
function acTexture() {
  const cv = canvas(512, 512), g = cv.getContext('2d');
  const r = new RNG(77);
  const W = 512, H = 352;
  g.fillStyle = '#cfc9b8'; g.fillRect(0, 0, 512, 512);
  // uneven yellowing
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${150 + r.int(0, 40)},${130 + r.int(0, 30)},${80 + r.int(0, 30)},${r.range(0.02, 0.06)})`;
    g.beginPath(); g.ellipse(r.range(0, 512), r.range(0, 512), r.range(30, 120), r.range(20, 90), r.range(0, 3), 0, Math.PI * 2); g.fill();
  }
  // grime gradient towards the bottom
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgba(90,80,60,0.08)'); gr.addColorStop(0.7, 'rgba(90,80,60,0.14)'); gr.addColorStop(1, 'rgba(70,60,45,0.38)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  // fan grille
  const cx = W * 0.36, cy = H * 0.5, R = H * 0.42;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fillStyle = '#232220'; g.fill();
  g.save(); g.translate(cx, cy);
  for (let i = 0; i < 3; i++) {
    g.rotate((Math.PI * 2) / 3 + 0.4);
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(R * 0.5, -R * 0.35, R * 0.9, -R * 0.1); g.quadraticCurveTo(R * 0.55, R * 0.15, 0, 0);
    g.fillStyle = '#3e3d39'; g.fill();
  }
  g.restore();
  g.strokeStyle = 'rgba(178,172,156,0.9)'; g.lineWidth = 2;
  for (let rr = 10; rr < R; rr += 9) { g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke(); }
  g.lineWidth = 3;
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke(); }
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.lineWidth = 7; g.strokeStyle = '#b3ad9c'; g.stroke();
  g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2); g.fillStyle = '#b8b2a2'; g.fill();
  // dust caught in the lower grille
  g.fillStyle = 'rgba(95,82,60,0.25)'; g.beginPath(); g.arc(cx, cy + R * 0.55, R * 0.45, 0, Math.PI); g.fill();
  // right service panel, seams and side louvres seen on the front
  g.strokeStyle = 'rgba(60,55,45,0.4)'; g.lineWidth = 2;
  g.strokeRect(W * 0.74, H * 0.1, W * 0.22, H * 0.8);
  g.fillStyle = 'rgba(60,55,45,0.28)';
  for (let y = H * 0.16; y < H * 0.5; y += 10) g.fillRect(W * 0.77, y, W * 0.16, 3);
  // streaks running down from the top edge and the panel screws
  for (let i = 0; i < 22; i++) {
    const x = r.range(0, W), y0 = r.chance(0.5) ? 0 : r.range(H * 0.3, H * 0.85);
    const st = g.createLinearGradient(0, y0, 0, H);
    st.addColorStop(0, 'rgba(90,70,40,0)'); st.addColorStop(1, `rgba(${r.chance(0.3) ? '110,60,25' : '80,68,48'},${r.range(0.08, 0.24)})`);
    g.fillStyle = st; g.fillRect(x, y0, r.range(1.5, 5), H - y0);
  }
  // edge grime (fake bevel)
  g.strokeStyle = 'rgba(40,35,25,0.32)'; g.lineWidth = 8; g.strokeRect(0, 0, W, H);
  // side panel: louvres, grime toward the bottom
  g.fillStyle = '#c4bead'; g.fillRect(0, 352, 256, 160);
  g.fillStyle = 'rgba(40,36,28,0.55)';
  for (let y = 368; y < 500; y += 7) g.fillRect(28, y, 200, 3);
  const sg = g.createLinearGradient(0, 352, 0, 512);
  sg.addColorStop(0, 'rgba(70,60,40,0.05)'); sg.addColorStop(1, 'rgba(70,60,40,0.35)');
  g.fillStyle = sg; g.fillRect(0, 352, 256, 160);
  // top: dust, leaves and soot
  g.fillStyle = '#a49c88'; g.fillRect(256, 352, 256, 160);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = r.chance(0.7) ? `rgba(70,62,48,${r.range(0.1, 0.3)})` : `rgba(120,95,55,${r.range(0.2, 0.5)})`;
    g.fillRect(256 + r.range(0, 256), 352 + r.range(0, 160), r.range(1, 5), r.range(1, 4));
  }
  g.fillStyle = '#fff'; g.fillRect(504, 504, 8, 8);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Wall stain under a wall-mounted AC unit (256 x 512, 0.9 m x 1.6 m): rust tails from the
 *  two bracket feet and the wet-dark trail below the condensate hose. Colour + alpha. */
function stainTexture() {
  const cv = canvas(256, 512), g = cv.getContext('2d');
  const r = new RNG(313);
  const px = (u) => (u / 0.9) * 256, py = (v) => (v / 1.6) * 512;
  const tail = (x, y0, len, w, rgb, a) => {
    for (let k = 0; k < 5; k++) {
      const xx = x + r.range(-w, w) * 0.6;
      const gr = g.createLinearGradient(0, y0, 0, y0 + len * r.range(0.6, 1));
      gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.fillRect(xx - r.range(1, 3), y0, r.range(2, 6), len);
    }
  };
  // bracket feet at u = 0.45 ± 0.3, 0.18 m below the unit
  for (const u of [0.15, 0.75]) tail(px(u), py(0.2), py(r.range(0.6, 1.1)), 8, '96,48,18', 0.5);
  // hose end at u = 0.78, 0.9 m below the unit: wet stain and splash fan
  const hx = px(0.78), hy = py(0.88);
  tail(hx, hy, py(0.7), 10, '40,36,30', 0.45);
  const rg = g.createRadialGradient(hx, hy + 20, 2, hx, hy + 20, 40);
  rg.addColorStop(0, 'rgba(40,36,30,0.35)'); rg.addColorStop(1, 'rgba(40,36,30,0)');
  g.fillStyle = rg; g.fillRect(hx - 50, hy - 20, 100, 100);
  // faint shadow-grey film right under the unit
  const fg = g.createLinearGradient(0, 0, 0, py(0.35));
  fg.addColorStop(0, 'rgba(60,55,45,0.22)'); fg.addColorStop(1, 'rgba(60,55,45,0)');
  g.fillStyle = fg; g.fillRect(px(0.06), 0, px(0.78), py(0.35));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Flag designs (2 x 2 atlas): white with two blue stripes, blue over white, white with red
 *  bands, blue with a narrow white band. Generic designs, no emblems. A slightly darker
 *  sleeve at the hoist (u = 0). */
function flagTexture() {
  const cv = canvas(512, 512), g = cv.getContext('2d');
  const cell = (i, j, fn) => { g.save(); g.translate(i * 256, j * 256); fn(256, 256); g.restore(); };
  cell(0, 0, (w, h) => { g.fillStyle = '#f0efea'; g.fillRect(0, 0, w, h); g.fillStyle = '#1d3f9a'; g.fillRect(0, h * 0.1, w, h * 0.15); g.fillRect(0, h * 0.75, w, h * 0.15); });
  cell(1, 0, (w, h) => { g.fillStyle = '#1f4fa8'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#f0efea'; g.fillRect(0, h / 2, w, h / 2); });
  cell(0, 1, (w, h) => { g.fillStyle = '#f0efea'; g.fillRect(0, 0, w, h); g.fillStyle = '#c42028'; g.fillRect(0, 0, w, h * 0.3); g.fillRect(0, h * 0.82, w, h * 0.08); });
  cell(1, 1, (w, h) => { g.fillStyle = '#1b3f8f'; g.fillRect(0, 0, w, h); g.fillStyle = '#f0efea'; g.fillRect(0, h * 0.44, w, h * 0.12); });
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    cell(i, j, (w, h) => {
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 0, w * 0.035, h);
      // weathering: the fly end frays and greys a little
      const gr = g.createLinearGradient(w * 0.7, 0, w, 0);
      gr.addColorStop(0, 'rgba(120,115,100,0)'); gr.addColorStop(1, 'rgba(120,115,100,0.16)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------- materials
/** Flag cloth size of the instanced template (metres): fly length, hoist height. */
const FLAG = { L: 1.2, H: 0.8 };

export function makeAttachMaterials(app) {
  const M = app.materials;
  const plant = new THREE.MeshStandardMaterial({
    name: 'ironwork.plant', map: plantTexture(), alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide,
    vertexColors: true, roughness: 0.72,
  });
  // per-instance colour tints only the flower half of the atlas (leaves keep their greens);
  // foliage keeps its (outward-bent) normal on both faces: lit like a volume, not a sheet;
  // leaf-edge coverage rounded to whole MSAA samples (no driver dither, see mats.js)
  plant.onBeforeCompile = (sh) => {
    sh.uniforms.uIronA2C = uIronA2C;
    centroidColor(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlowerTint;')
      .replace('#include <color_vertex>', 'vFlowerTint = vec3( 1.0 );\n' + THREE.ShaderChunk.color_vertex
        .replace('vColor.rgb *= instanceColor.rgb;', 'vFlowerTint = instanceColor.rgb;'));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlowerTint;\nuniform float uIronA2C;')
      .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
	if ( uIronA2C > 0.5 ) {
		diffuseColor.a = floor( diffuseColor.a * uIronA2C + 0.5 ) / uIronA2C;
		if ( diffuseColor.a <= 0.0 ) discard;
	}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tif ( vMapUv.x > 0.5 ) diffuseColor.rgb *= vFlowerTint;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  plant.customProgramCacheKey = () => 'ironwork.plant';

  // parts and AC units: AC atlas (the parts sample its white patch), colour per vertex
  const parts = new THREE.MeshStandardMaterial({ name: 'ironwork.parts', map: acTexture(), vertexColors: true, roughness: 0.6, metalness: 0.0 });
  // (baked occlusion on small parts: colours at the sample centroid, see mats.js)
  parts.onBeforeCompile = centroidColor;
  parts.customProgramCacheKey = () => 'ironwork.parts';
  // stains on the wall under AC units: lit like the wall, blended over it
  const stain = new THREE.MeshStandardMaterial({
    name: 'ironwork.stain', map: stainTexture(), transparent: true, depthWrite: false, roughness: 0.92,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });

  const flag = new THREE.MeshStandardMaterial({ name: 'ironwork.flag', map: flagTexture(), side: THREE.DoubleSide, roughness: 0.88 });
  // Cloth: hoist edge (x = 0) pinned to the pole; the fly end droops under its weight,
  // soft folds run from hoist to fly, and wind adds travelling waves. Displacement in the
  // cloth's local frame (x fly, y along the pole, z out of the cloth).
  const head = `#include <common>
attribute vec3 aFlag;
uniform float uTime;
uniform float uWindStrength;
vec3 flagDisp( vec2 p, float ph ) {
	float f = clamp( p.x / ${FLAG.L.toFixed(2)}, 0.0, 1.0 );
	float w = clamp( uWindStrength, 0.0, 1.0 );
	float t = uTime * ( 1.6 + 2.4 * w ) + ph;
	float amp = ( 0.07 + 0.2 * w ) * ( 0.75 + 0.5 * fract( ph * 0.37 ) );
	float wave = sin( p.x * 5.2 - t ) * 0.7 + sin( p.x * 8.7 + p.y * 2.6 - t * 1.6 ) * 0.3;
	float folds = sin( p.y * 8.5 + ph * 2.0 + 0.5 * sin( t * 0.45 ) ) * ( 0.03 + 0.06 * ( 1.0 - w ) );
	float z = wave * amp * pow( f, 1.3 ) + folds * smoothstep( 0.0, 0.4, f );
	float sag = 0.3 * ( 1.25 - w ) * f * f;
	return vec3( -0.25 * sag * f, -sag, z );
}`;
  const flutter = (sh, withNormal) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uWindStrength = U.uWindStrength;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', head)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed += flagDisp( position.xy, aFlag.z );');
    if (!withNormal) return;
    sh.vertexShader = sh.vertexShader
      .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
	vMapUv = vMapUv * 0.5 + aFlag.xy;
#endif`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
	{
		const float e = 0.015;
		vec3 d0 = flagDisp( position.xy, aFlag.z );
		vec3 tx = vec3( e, 0.0, 0.0 ) + flagDisp( position.xy + vec2( e, 0.0 ), aFlag.z ) - d0;
		vec3 ty = vec3( 0.0, e, 0.0 ) + flagDisp( position.xy + vec2( 0.0, e ), aFlag.z ) - d0;
		objectNormal = normalize( cross( tx, ty ) );
	}`);
  };
  flag.onBeforeCompile = (sh) => flutter(sh, true);
  flag.customProgramCacheKey = () => 'ironwork.flag';
  // shadow pass with the same cloth motion
  const flagDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  flagDepth.onBeforeCompile = (sh) => flutter(sh, false);
  flagDepth.customProgramCacheKey = () => 'ironwork.flagDepth';

  for (const m of [plant, parts, stain, flag]) M.register(m.name, m);
  return { plant, parts, stain, flag, flagDepth };
}

// ---------------------------------------------------------------- plants
const _n = new THREE.Vector3(), _t = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

/** Quad facing `nrm` centred at c, rotated by `rot` around it; its normals are bent
 *  away from `centre` (roundness 0..1) so a cluster of cards shades like a volume. */
function card(W, c, nrm, size, rot, uv0, uv1, centre, roundness = 0.6) {
  _n.set(nrm[0], nrm[1], nrm[2]).normalize();
  _t.set(Math.abs(_n.y) > 0.9 ? 1 : 0, Math.abs(_n.y) > 0.9 ? 0 : 1, 0);
  _a.crossVectors(_t, _n).normalize();
  _b.crossVectors(_n, _a);
  const ca = Math.cos(rot), sa = Math.sin(rot);
  _A.copy(_a).multiplyScalar(ca).addScaledVector(_b, sa).multiplyScalar(size / 2);
  _B.copy(_b).multiplyScalar(ca).addScaledVector(_a, -sa).multiplyScalar(size / 2);
  const idx = [];
  for (const [i, j, u, v] of [[-1, -1, uv0[0], uv0[1]], [1, -1, uv1[0], uv0[1]], [1, 1, uv1[0], uv1[1]], [-1, 1, uv0[0], uv1[1]]]) {
    _p.set(c[0], c[1], c[2]).addScaledVector(_A, i).addScaledVector(_B, j);
    _s.copy(_p).sub(centre).normalize().lerp(_n, 1 - roundness).normalize();
    idx.push(W.v(_p.x, _p.y, _p.z, _s.x, _s.y, _s.z, u, v));
  }
  W.quad(idx[0], idx[1], idx[2], idx[3]);
}

const LEAF_UV = cell(0, 0), HERB_UV = cell(1, 0), IVY_UV = cell(0, 1), DRY_UV = cell(1, 1);
const FLOWER_UV = cell(2, 0, 10), BRACT_UV = cell(3, 0, 10), BLOOM_UV = cell(2, 1, 10), SPIKE_UV = cell(3, 1, 10);

/** Flower umbel: crossed cards (and a stem at full detail). */
function umbel(W, r, x, y, z, s, lite, uv = FLOWER_UV) {
  const ctr = new THREE.Vector3(x, y - 0.03, z), rot = r.range(0, 3.14);
  if (!lite) {
    const sw = 0.0025, y0 = Math.max(0.0, y - 0.13);
    W.color(0.85, 0.9, 0.85);
    const a = W.v(x - sw, y0, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]), b = W.v(x + sw, y0, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]);
    const c = W.v(x + sw, y, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]), d = W.v(x - sw, y, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]);
    W.quad(a, b, c, d);
  }
  W.color(...[1, 1, 1].map(() => r.range(0.86, 1)));
  const n = lite ? 2 : 3;
  for (let k = 0; k < n; k++) {
    const ang = rot + (k * Math.PI) / n;
    card(W, [x, y, z], [Math.cos(ang), 0.45, Math.sin(ang)], s, r.range(0, 6.28), uv[0], uv[1], ctr, 0.55);
  }
  if (!lite) card(W, [x, y + 0.012, z], [0, 1, 0], s * 0.9, r.range(0, 6.28), uv[0], uv[1], ctr, 0.55);
}

/** Thin flat stalk from p0 to p1 (width w), sampling a solid patch of the atlas. */
function stalk(W, p0, p1, w, uv, face = 0) {
  const nx = Math.cos(face), nz = Math.sin(face), tx = -nz * w / 2, tz = nx * w / 2;
  const a = W.v(p0[0] - tx, p0[1], p0[2] - tz, nx, 0.2, nz, uv[0], uv[1]), b = W.v(p0[0] + tx, p0[1], p0[2] + tz, nx, 0.2, nz, uv[0], uv[1]);
  const c = W.v(p1[0] + tx, p1[1], p1[2] + tz, nx, 0.2, nz, uv[0], uv[1]), d = W.v(p1[0] - tx, p1[1], p1[2] - tz, nx, 0.2, nz, uv[0], uv[1]);
  W.quad(a, b, c, d);
}

/** An upright card whose foot stands at (x, 0, z), `s` tall, leaning out of the clump
 *  centre by `lean` (radians), facing across the radial direction `a`. */
function sprig(W, x, z, a, s, lean, uv, centre, y0 = 0) {
  const rx = Math.cos(a), rz = Math.sin(a);
  const up = Math.cos(lean), out = Math.sin(lean);
  card(W, [x + rx * out * s * 0.47, y0 + up * s * 0.47, z + rz * out * s * 0.47], [-rz, 0.12, rx], s, -lean, uv[0], uv[1], centre, 0.45);
}

/** Herb clump (basil, mint, oregano, thyme) over L by D, origin at the soil centre:
 *  upright sprigs leaning out of the clump, a few lying over the crown and, tinted per
 *  instance, flower spikes (lavender, sage, bolting basil; a green tint keeps them leafy).
 *  The light levels have fewer, larger cards (`ks`: size factors of sprigs and spikes). */
function herb(W, r, { L = 0.26, D = 0.24, sprigs = 18, crown = 6, spikes = 5, height = 0.27, lite = 0, ks = [1, 1] }) {
  const centre = new THREE.Vector3(0, height * 0.25, 0);
  for (let i = 0; i < sprigs; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 0.9;
    const x = Math.cos(a) * d * L / 2, z = Math.sin(a) * d * D / 2;
    W.color(r.range(0.78, 1.05), r.range(0.85, 1.06), r.range(0.72, 1.0));
    sprig(W, x, z, a, height * r.range(0.72, 1.08) * ks[0], d * 0.55 + r.range(0, 0.2), HERB_UV, centre);
  }
  for (let i = 0; i < crown; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 0.6;
    W.color(r.range(0.85, 1.08), r.range(0.9, 1.1), r.range(0.78, 1.0));
    card(W, [Math.cos(a) * d * L / 2, height * r.range(0.7, 0.9), Math.sin(a) * d * D / 2], [r.range(-0.6, 0.6), 1, r.range(-0.6, 0.6)],
      height * 0.7 * ks[0], r.range(0, 6.28), HERB_UV[0], HERB_UV[1], centre, 0.5);
  }
  for (let i = 0; i < spikes; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 0.6;
    W.color(...[1, 1, 1].map(() => r.range(0.85, 1)));
    sprig(W, Math.cos(a) * d * L / 2, Math.sin(a) * d * D / 2, a, height * 0.75 * ks[1], d * 0.4 + r.range(-0.1, 0.15), SPIKE_UV, centre, height * 0.45);
  }
}

/** Neglected planting over L by D: dry stalks (some snapped), shrivelled leaves on twiggy
 *  stems, a leaf or two fallen on the soil and, tinted per instance, withered flower
 *  heads. Sparse: the soil shows through. */
function dry(W, r, { L = 0.26, D = 0.24, stalks = 8, tufts = 10, fallen = 2, heads = 3, height = 0.28, lite = 0, ks = [1, 1] }) {
  const centre = new THREE.Vector3(0, height * 0.2, 0);
  const tips = [];
  for (let i = 0; i < stalks; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 0.7;
    const x = Math.cos(a) * d * L / 2, z = Math.sin(a) * d * D / 2;
    const h = height * (r.chance(0.3) ? r.range(0.25, 0.5) : r.range(0.7, 1.15)), lean = r.range(0.05, 0.5);
    const tip = [x + Math.cos(a) * Math.sin(lean) * h, Math.cos(lean) * h, z + Math.sin(a) * Math.sin(lean) * h];
    W.color(...[1, 0.97, 0.92].map((c) => c * r.range(0.8, 1.15)));
    if (!lite) stalk(W, [x, 0, z], tip, 0.004, TWIG_UV, r.range(0, 6.28));
    tips.push(tip);
  }
  for (let i = 0; i < tufts; i++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 0.85;
    W.color(...[1, 1, 1].map(() => r.range(0.75, 1.08)));
    sprig(W, Math.cos(a) * d * L / 2, Math.sin(a) * d * D / 2, a, height * r.range(0.6, 1.0) * ks[0], d * 0.6 + r.range(0, 0.3), DRY_UV, centre);
  }
  for (let i = 0; i < fallen; i++) {
    W.color(...[1, 1, 1].map(() => r.range(0.7, 0.95)));
    card(W, [r.range(-0.35, 0.35) * L, 0.012, r.range(-0.3, 0.3) * D], [r.range(-0.2, 0.2), 1, r.range(-0.2, 0.2)], 0.09 * ks[0], r.range(0, 6.28), DRY_UV[0], DRY_UV[1], centre, 0.1);
  }
  for (let i = 0; i < heads && tips.length; i++) {
    const [x, y, z] = tips[i % tips.length];
    umbel(W, r, x, y, z, r.range(0.05, 0.075) * ks[1], true);
  }
}

/** Trailing planting (ivy, ivy-leaved geranium out of bloom, surfinia, pothos) over L by
 *  D, origin at the soil centre: a low leafy mound and strands hanging over the front
 *  (+z) edge, 0.25 - 0.85 m long, a few over the ends; tinted per instance, small trumpet
 *  flowers dotted over it (a green tint keeps them leafy). The light levels have fewer,
 *  larger cards (`ks`: mound, strand, flower sizes), spaced wider along the strands. */
function trailing(W, r, { L = 0.8, D = 0.18, mound = 30, strands = 12, blooms = 12, height = 0.13, lite = 0, ks = [1, 1, 1] }) {
  const ax = L * 0.5 + 0.02, az = D * 0.5 + 0.04;
  const centre = new THREE.Vector3(0, -0.05, 0);
  // strand layout first, so the detail levels (same seed, fewer strands) share it
  const S = [];
  for (let i = 0; i < strands; i++) {
    // most hang over the front, a few over the ends
    const end = i % 6 === 5 ? (r.chance(0.5) ? -1 : 1) : 0;
    const len = r.range(0.25, 0.85) * (end ? 0.7 : 1);
    S.push({ end, len, x0: end ? end * (L * 0.5 + 0.02) : r.range(-0.48, 0.48) * L, z0: end ? r.range(-0.3, 0.4) * D : D * 0.5 + 0.02, out: r.range(0.02, 0.08), sway: r.range(-0.1, 0.1) });
  }
  for (let i = 0; i < mound; i++) {
    const a = r.range(0, Math.PI * 2), e = Math.acos(r.range(0.1, 1));
    const sx = Math.cos(a) * Math.sin(e), sy = Math.cos(e), sz = Math.sin(a) * Math.sin(e);
    const k = r.range(0.75, 1.05);
    W.color(...[0.95, 1, 0.92].map((c) => c * r.range(0.72, 1.08)));
    card(W, [sx * ax * k, 0.02 + sy * height * k, sz * az * k], [sx / ax + r.range(-2, 2), sy / height * 0.3 + r.range(-0.5, 1.5), sz / az + r.range(-2, 2)],
      r.range(0.11, 0.15) * ks[0], r.range(0, 6.28), IVY_UV[0], IVY_UV[1], centre, 0.45);
  }
  const flowerAt = [];
  for (const { end, len, x0, z0, out, sway } of S) {
    const n = Math.max(2, Math.round(len / (lite ? 0.1 * ks[1] : 0.07)));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const x = x0 + (end ? end * out * Math.sin(t * 1.8) : sway * t) + r.range(-0.015, 0.015), y = 0.03 - len * t;
      const z = z0 + (end ? sway * t : out * Math.sin(t * 1.8));
      W.color(...[0.92, 1, 0.9].map((c) => c * r.range(0.7, 1.0)));
      card(W, [x, y, z], end ? [end, r.range(-0.2, 0.4), r.range(-0.5, 0.5)] : [r.range(-0.5, 0.5), r.range(-0.2, 0.4), 1],
        r.range(0.1, 0.13) * ks[1], r.range(-0.3, 0.3), IVY_UV[0], IVY_UV[1], centre, 0.3);
      if (j === n - 1 || r.chance(0.12)) flowerAt.push([x, y, z + 0.015]);
    }
  }
  for (let i = 0; i < blooms; i++) {
    const p = i < blooms * 0.6 || !flowerAt.length
      ? [r.range(-0.95, 0.95) * ax * 0.9, 0.03 + height * r.range(0.6, 1.05), r.range(-0.6, 0.9) * az]
      : flowerAt[r.int(0, flowerAt.length - 1)];
    W.color(...[1, 1, 1].map(() => r.range(0.85, 1)));
    card(W, p, [r.range(-0.5, 0.5), r.range(0.3, 1), r.range(0.2, 1)], r.range(0.085, 0.11) * ks[2], r.range(0, 6.28), BLOOM_UV[0], BLOOM_UV[1], centre, 0.4);
  }
}

/** Bougainvillea trained out of a box (L along x, origin at the soil centre): woody canes
 *  arching up and over the front edge, leaves along them and, tinted per instance, masses
 *  of papery bracts on the outer growth, the longest sprays hanging well below the box.
 *  The light levels have fewer, larger cards (`ks`: leaves, bracts). */
function bougainvillea(W, r, { L = 0.8, D = 0.18, canes = 9, leaves = 9, bracts = 13, crown = 10, lite = 0, ks = [1, 1] }) {
  const centre = new THREE.Vector3(0, 0.12, 0.1);
  // cane layout first, so the detail levels (same seed, fewer cards) share it
  const C = [];
  for (let i = 0; i < canes; i++) {
    const x0 = r.range(-0.4, 0.4) * L, x2 = x0 + r.range(-0.3, 0.3);
    const h = r.range(0.2, 0.45), drop = r.range(0.15, 0.7), reach = r.range(0.12, 0.32);
    C.push([[x0, 0, r.range(-0.3, 0.3) * D], [(x0 + x2) / 2, h * 1.6, D * 0.5 + reach * 0.5], [x2, -drop, D * 0.5 + reach]]);
  }
  for (const [P0, P1, P2] of C) {
    const B = (t) => P0.map((p, k) => (1 - t) * (1 - t) * p + 2 * (1 - t) * t * P1[k] + t * t * P2[k]);
    if (!lite) {
      W.color(0.8, 0.85, 0.7);
      for (let k = 0; k < 5; k++) stalk(W, B(k / 5), B((k + 1) / 5), 0.005, TWIG_UV, r.range(0, 6.28));
    }
    for (let j = 0; j < leaves; j++) {
      const t = 0.08 + 0.88 * (j + r.next()) / leaves, p = B(t);
      W.color(r.range(0.55, 0.75), r.range(0.7, 0.88), r.range(0.5, 0.7));
      card(W, [p[0] + r.range(-0.05, 0.05), p[1] + r.range(-0.03, 0.04), p[2] + r.range(-0.05, 0.05)], [r.range(-1, 1), r.range(-0.2, 1), r.range(-0.3, 1)],
        r.range(0.14, 0.2) * ks[0], r.range(0, 6.28), HERB_UV[0], HERB_UV[1], centre, 0.5);
    }
    // bracts crowd the outer growth: sprays all along the hanging part
    for (let j = 0; j < bracts; j++) {
      const t = 0.3 + 0.7 * Math.sqrt((j + r.next()) / bracts), p = B(t);
      W.color(...[1, 1, 1].map(() => r.range(0.8, 1)));
      card(W, [p[0] + r.range(-0.07, 0.07), p[1] + r.range(-0.05, 0.05), p[2] + r.range(-0.03, 0.07)], [r.range(-0.8, 0.8), r.range(-0.1, 0.9), r.range(0.1, 1)],
        r.range(0.14, 0.2) * ks[1], r.range(0, 6.28), BRACT_UV[0], BRACT_UV[1], centre, 0.5);
    }
  }
  // a mound of leaves and bracts over the box, so the canes rise out of a mass
  for (let i = 0; i < crown; i++) {
    const x = r.range(-0.48, 0.48) * L, z = r.range(-0.4, 0.7) * D, y = r.range(0.04, 0.26);
    const b = i % 2 === 1;
    W.color(...(b ? [1, 1, 1].map(() => r.range(0.8, 1)) : [r.range(0.55, 0.75), r.range(0.7, 0.88), r.range(0.5, 0.7)]));
    card(W, [x, y, z], [r.range(-0.6, 0.6), 1, r.range(-0.2, 0.8)], r.range(0.16, 0.22) * (b ? ks[1] : ks[0]), r.range(0, 6.28),
      (b ? BRACT_UV : HERB_UV)[0], (b ? BRACT_UV : HERB_UV)[1], centre, 0.55);
  }
}

/** Geranium planting over an area L (x) by D (z), origin at the soil centre: a leafy
 *  mound `height` tall, umbels standing out of it, and `trail` ivy-geranium strands
 *  hanging over the front (+z) edge, 0.2 - 0.5 m long. The light levels have fewer,
 *  larger cards (`ks`: size factors of leaves, umbels, trailing leaves and umbels) and
 *  `steps` leaves per strand. */
function geranium(W, r, { L = 0.26, D = 0.22, leaves = 18, flowers = 7, trail = 0, height = 0.3, lite = false, ks = [1, 1, 1, 1], steps = 3 }) {
  const ax = L * 0.5 + 0.03, az = D * 0.5 + 0.05;
  const centre = new THREE.Vector3(0, -0.04, 0);
  const dome = (x, z) => Math.sqrt(Math.max(0, 1 - (x / ax) ** 2 - (z / az) ** 2));
  // foliage: leaves facing out of the mound, all above the rim
  const n = lite ? leaves : leaves * 3;
  for (let i = 0; i < n; i++) {
    const a = r.range(0, Math.PI * 2), e = Math.acos(r.range(0.12, 1));
    const sx = Math.cos(a) * Math.sin(e), sy = Math.cos(e), sz = Math.sin(a) * Math.sin(e);
    const k = r.range(0.72, 1.04);
    const x = sx * ax * k, y = 0.015 + sy * height * k, z = sz * az * k;
    const nrm = [sx / ax + r.range(-3, 3), sy / height * 0.6 + r.range(-1, 2), sz / az + r.range(-3, 3)];
    W.color(...[0.95, 1, 0.92].map((c) => c * r.range(0.68, 1.08) * (0.8 + 0.2 * sy)));
    card(W, [x, y, z], nrm, (lite ? r.range(0.12, 0.16) : r.range(0.065, 0.1)) * ks[0], r.range(0, 6.28), LEAF_UV[0], LEAF_UV[1], centre, 0.5);
  }
  // umbels on top, standing just out of the foliage
  for (let i = 0; i < flowers; i++) {
    const x = r.range(-0.92, 0.92) * ax * 0.85, z = r.range(-0.8, 0.8) * az * 0.8;
    const y = 0.015 + dome(x, z) * height + r.range(0.02, 0.08);
    umbel(W, r, x, y, z, r.range(0.11, 0.15) * (lite ? 1.2 : 1) * ks[1], lite);
  }
  // trailing strands over the front edge: chains of leaves, a flower or two on each
  for (let i = 0; i < trail; i++) {
    const x0 = r.range(-0.48, 0.48) * L, len = r.range(0.2, 0.5);
    const n = lite ? steps : Math.max(4, Math.round(len / 0.055));
    const out = r.range(0.03, 0.09), sway = r.range(-0.08, 0.08);
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const x = x0 + sway * t + r.range(-0.02, 0.02), y = 0.02 - len * t, z = D * 0.5 + 0.02 + out * Math.sin(t * 1.8);
      W.color(r.range(0.66, 0.9), r.range(0.76, 1.0), r.range(0.66, 0.88));
      card(W, [x, y, z], [r.range(-0.5, 0.5), r.range(-0.2, 0.6), 1], (lite ? r.range(0.1, 0.13) : r.range(0.055, 0.08)) * ks[2], r.range(0, 6.28), LEAF_UV[0], LEAF_UV[1], centre, 0.35);
    }
    const nf = lite ? 1 : r.int(1, 2);
    for (let j = 0; j < nf; j++) {
      const t = r.range(0.35, 1);
      umbel(W, r, x0 + sway * t, 0.04 - len * t, D * 0.5 + 0.04 + out, r.range(0.08, 0.11) * (lite ? 1.2 : 1) * ks[3], true);
    }
  }
}

// ---------------------------------------------------------------- containers & parts
const SOIL = [0.2, 0.15, 0.11];
/** Soil heights of the planter box and the trough, from their foot (plants stand on it). */
export const BOX_SOIL = 0.16, TROUGH_SOIL = 0.14;

/** Box x0..x1, y0..y1, z0..z1 whose side faces shade from `bot` at the foot to `top`. */
function gradBox(W, x0, x1, y0, y1, z0, z1, bot, top, skip = '') {
  const F = (pts, n, s) => {
    const i = pts.map((p, k) => W.v(p[0], p[1], p[2], n[0], n[1], n[2], p[0] + p[2], p[1], s[k]));
    W.quad(i[0], i[1], i[2], i[3]);
  };
  const S = [bot, bot, top, top];
  if (!skip.includes('f')) F([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], S);
  if (!skip.includes('b')) F([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], S);
  if (!skip.includes('r')) F([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], S);
  if (!skip.includes('l')) F([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], S);
  if (!skip.includes('u')) F([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [top, top, top, top]);
  if (!skip.includes('d')) F([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], [bot * 0.8, bot * 0.8, bot * 0.8, bot * 0.8]);
}

/** Terracotta pot (origin at its foot), soil at 0.2 m. White base colour (tinted on write). */
function potTemplate() {
  const W = new GeoWriter();
  W.color(0.78, 0.78, 0.78); // water-stained foot
  lathe(W, [[0.084, 0], [0.1, 0.09]], 9);
  W.color(1, 1, 1);
  lathe(W, [[0.1, 0.09], [0.118, 0.186], [0.135, 0.19], [0.134, 0.224], [0.119, 0.21]], 9);
  W.color(...SOIL);
  lathe(W, [[0.119, 0.2], [0.0001, 0.205]], 9);
  return template(W, WHITE_UV);
}

/** Rectangular planter, unit length along x (scaled on write), 0.17 deep, 0.16 tall:
 *  water-stained toward the foot, lighter rim, dark soil line under the rim. */
function boxTemplate() {
  const W = new GeoWriter();
  gradBox(W, -0.5, 0.5, 0, 0.15, -0.085, 0.085, 0.66, 0.95, 'u');
  gradBox(W, -0.51, 0.51, 0.146, 0.16, -0.095, 0.095, 1.0, 1.04, '');
  W.color(...SOIL);
  box(W, 0, 0.162, 0, 0.98, 0.006, 0.15, 1, 'fblrd');
  return template(W, WHITE_UV);
}

/** Moulded plastic trough, unit length along x (scaled on write): sides tapering from
 *  0.13 deep at the foot to 0.18 under a rolled lip 0.2 deep, 0.16 tall, the soil a
 *  centimetre under the lip. It stands (on a sill, a coping or the balcony floor). */
function troughTemplate() {
  const W = new GeoWriter();
  const xb = 0.48, zb = 0.065, xt = 0.495, zt = 0.09, h = TROUGH_SOIL + 0.004;
  const F = (pts, n, s) => {
    const i = pts.map((p, k) => W.v(p[0], p[1], p[2], n[0], n[1], n[2], p[0] + p[2], p[1], s[k]));
    W.quad(i[0], i[1], i[2], i[3]);
  };
  const nz = new THREE.Vector3(0, zt - zb, h).normalize(), nx = new THREE.Vector3(h, xt - xb, 0).normalize();
  const S = [0.66, 0.66, 0.95, 0.95];
  F([[-xb, 0, zb], [xb, 0, zb], [xt, h, zt], [-xt, h, zt]], [0, nz.y, nz.z], S);
  F([[xb, 0, -zb], [-xb, 0, -zb], [-xt, h, -zt], [xt, h, -zt]], [0, nz.y, -nz.z], S);
  F([[xb, 0, zb], [xb, 0, -zb], [xt, h, -zt], [xt, h, zt]], [nx.x, nx.y, 0], S);
  F([[-xb, 0, -zb], [-xb, 0, zb], [-xt, h, zt], [-xt, h, -zt]], [-nx.x, nx.y, 0], S);
  F([[-xb, 0, -zb], [xb, 0, -zb], [xb, 0, zb], [-xb, 0, zb]], [0, -1, 0], [0.5, 0.5, 0.5, 0.5]);
  // rolled lip: front, back and end bars
  const y0 = h - 0.006, y1 = h + 0.016;
  gradBox(W, -0.505, 0.505, y0, y1, zt - 0.012, zt + 0.01, 0.92, 1.04, 'd');
  gradBox(W, -0.505, 0.505, y0, y1, -zt - 0.01, -zt + 0.012, 0.92, 1.04, 'd');
  for (const s of [-1, 1]) gradBox(W, s > 0 ? xt - 0.012 : -xt - 0.01, s > 0 ? xt + 0.01 : -xt + 0.012, y0, y1, -zt + 0.012, zt - 0.012, 0.92, 1.04, 'dfb');
  W.color(...SOIL);
  F([[-xt + 0.01, TROUGH_SOIL, zt - 0.01], [xt - 0.01, TROUGH_SOIL, zt - 0.01], [xt - 0.01, TROUGH_SOIL, -zt + 0.01], [-xt + 0.01, TROUGH_SOIL, -zt + 0.01]], [0, 1, 0], [1, 1, 1, 1]);
  return template(W, WHITE_UV);
}

/** Two flat-bar hooks holding a planter on the handrail (box space: the rail is on the
 *  -z side, `back` metres behind the box centre; mirror with dir = -1). */
function hookTemplate(dir) {
  const W = new GeoWriter();
  W.color(0.05, 0.05, 0.05);
  const zb = -0.09 * dir, zf = -0.162 * dir;
  // faces against the box, the rail or the next strap are left out
  const toBox = dir > 0 ? 'f' : 'b', toRail = dir > 0 ? 'f' : 'b';
  for (const x of [-0.32, 0.32]) {
    box(W, x, 0.105, zb, 0.026, 0.21, 0.005, 1, 'du' + toBox);                 // up the box back
    box(W, x, 0.207, (zb + zf) / 2, 0.026, 0.005, Math.abs(zf - zb) + 0.005, 1, 'lrd'); // over the handrail
    box(W, x, 0.18, zf, 0.026, 0.055, 0.005, 1, 'ud' + toRail);                // down the far side
  }
  return template(W, WHITE_UV);
}

/** Split AC outdoor unit body: x in [-0.4, 0.4], y in [0, 0.55], z in [0.09, 0.37].
 *  (atlas: front, side louvres, dusty top; faces toward the wall a little darker) */
function acBodyTemplate() {
  const W = new GeoWriter();
  const x0 = -0.4, x1 = 0.4, y0 = 0, y1 = 0.55, z0 = 0.09, z1 = 0.37;
  const F = (pts, n, uvs, sh = [1, 1, 1, 1]) => {
    const i = pts.map((p, k) => W.v(p[0], p[1], p[2], n[0], n[1], n[2], uvs[k][0], uvs[k][1], sh[k]));
    W.quad(i[0], i[1], i[2], i[3]);
  };
  const vt = 1, vb = AC_FRONT_V, sv = AC_FRONT_V - 0.01;
  F([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [[0, vb], [1, vb], [1, vt], [0, vt]]);
  // sides: louvre panel, darker toward the wall
  const side = [[0.02, 0.01], [0.48, 0.01], [0.48, sv], [0.02, sv]];
  F([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], side, [1, 0.85, 0.85, 1]);
  F([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], side, [0.85, 1, 1, 0.85]);
  F([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [[0.52, 0.02], [0.98, 0.02], [0.98, sv], [0.52, sv]]);
  W.color(0.55, 0.55, 0.55);
  F([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], side);
  return template(W);
}

/** AC wall brackets (galvanised angles, rust at the joints) in the AC unit's frame. */
function acBracketTemplate() {
  const W = new GeoWriter();
  W.color(0.36, 0.34, 0.31);
  for (const x of [-0.3, 0.3]) {
    box(W, x, -0.02, 0.2, 0.04, 0.04, 0.4, 1, 'b');
    W.setMatrix(new THREE.Matrix4().makeRotationX(-Math.atan2(0.33, 0.3)).setPosition(x, -0.19, 0.15));
    box(W, 0, 0, 0, 0.035, 0.035, 0.44, 1, 'fb');
    W.setMatrix(null);
  }
  W.color(0.7, 0.68, 0.62); // condensate hose dropping down the wall
  sweepBar(W, [[0.3, 0.0], [0.32, -0.15], [0.33, -0.9]], 0.007, 0.007, { z0: 0.12 });
  return template(W, WHITE_UV);
}

/** Taped refrigerant pipe pair leaving the unit's side and entering the wall. */
function acPipeTemplate() {
  const W = new GeoWriter();
  W.color(0.7, 0.68, 0.62);
  for (const dz of [0, 0.05]) {
    W.setMatrix(new THREE.Matrix4().makeTranslation(0, 0, 0.16 + dz));
    sweepBar(W, [[0.4, 0.12 + dz * 0.4], [0.47, 0.12 + dz * 0.4], [0.52, 0.06 + dz * 0.4], [0.52, -0.25]], 0.018, 0.018, {});
    W.setMatrix(null);
    W.setMatrix(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0.52, -0.25 + dz * 0.4, 0));
    sweepBar(W, [[-0.16 - dz, 0], [0.02, 0]], 0.018, 0.018, {});
    W.setMatrix(null);
  }
  return template(W, WHITE_UV);
}

/** Wall stain quad under a wall-mounted unit (unit frame; 0.9 m wide, 1.6 m tall). */
function acStainTemplate() {
  const W = new GeoWriter();
  const a = W.v(-0.45, -1.6, 0.004, 0, 0, 1, 0, 0), b = W.v(0.45, -1.6, 0.004, 0, 0, 1, 1, 0);
  const c = W.v(0.45, 0, 0.004, 0, 0, 1, 1, 1), d = W.v(-0.45, 0, 0.004, 0, 0, 1, 0, 1);
  W.quad(a, b, c, d);
  return template(W);
}

// Satellite dish: a pressed-steel offset reflector on a wall mount. Two templates, so
// the mount stays square to the wall while the dish turns to its satellite: the dish in
// its own frame (origin at the clamp on the mast, +z its aim, +y up) and the mount in
// the facade frame (origin at the same clamp, +z out of the wall, the wall DISH_W behind).
export const DISH_W = 0.42;
const DISH = { RX: 0.3, RY: 0.33, D: 0.055, Z0: 0.1, T: 0.008 };
/** Front skin depth of the reflector at (x, y) (dish frame). */
const dishZ = (x, y) => DISH.Z0 + DISH.D * ((x * x) / (DISH.RX * DISH.RX) + (y * y) / (DISH.RY * DISH.RY));

/** Tube of radius r from p to q ([x, y, z]), `seg` sides, optional end caps. */
function tube(W, p, q, r, seg = 8, caps = false) {
  const d = _A.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]), len = d.length();
  d.multiplyScalar(1 / len);
  // basis with y along the tube
  const x = Math.abs(d.y) < 0.9 ? _B.set(0, 1, 0).cross(d).normalize() : _B.set(1, 0, 0).cross(d).normalize();
  const z = _s.crossVectors(x, d);
  W.setMatrix(_tm.makeBasis(x, d, z).setPosition(p[0], p[1], p[2]));
  lathe(W, [[r, 0], [r, len]], seg, { capTop: caps, capBottom: caps });
  W.setMatrix(null);
}
const _tm = new THREE.Matrix4();

/** The dish (dish frame, see above): an oval reflector whose front and back skins, 8 mm
 *  apart, meet in a rolled rim; the bracket and clamp behind it; the feed arm from the
 *  lower rim up to the LNB at the focus, its feedhorn turned to the reflector. Painted
 *  per placement (tint). */
function dishTemplate() {
  const W = new GeoWriter();
  const { RX, RY, D, Z0, T } = DISH, rings = 6, seg = 28;
  W.color(0.74, 0.735, 0.71);
  const front = [], back = [], rim = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings, fr = [], bk = [];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2, x = Math.cos(a) * RX * t, y = Math.sin(a) * RY * t, z = dishZ(x, y);
      const gx = (2 * D * x) / (RX * RX), gy = (2 * D * y) / (RY * RY), l = Math.sqrt(gx * gx + gy * gy + 1);
      // (the bowl's inside a little darker toward its centre and grimier toward its
      // lower rim, where rain runs off; the back in its own shade)
      const grime = 0.9 + 0.1 * Math.min(1, (y / RY + 1) * 0.75);
      fr.push(W.v(x, y, z, -gx / l, -gy / l, 1 / l, x, y, (0.93 + 0.07 * t) * grime));
      bk.push(W.v(x, y, z - T, gx / l, gy / l, -1 / l, x, y, 0.8 * grime));
    }
    front.push(fr); back.push(bk);
  }
  // (rings run counter-clockwise seen from the front: the front skin faces +z, the back -z)
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    W.quad(front[i][j], front[i + 1][j], front[i + 1][j + 1], front[i][j + 1]);
    W.quad(back[i][j], back[i][j + 1], back[i + 1][j + 1], back[i + 1][j]);
  }
  // rolled rim: front edge, a lip 4 mm proud of it, back edge (normals turning outward)
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const x = c * RX, y = s * RY, z = dishZ(x, y);
    let ox = c / RX, oy = s / RY;
    const ol = Math.sqrt(ox * ox + oy * oy); ox /= ol; oy /= ol;
    rim.push([
      W.v(x, y, z, ox * 0.6, oy * 0.6, 0.8, x, y, 0.97),
      W.v(x + ox * 0.004, y + oy * 0.004, z - T * 0.5, ox, oy, 0, x, y, 0.92),
      W.v(x, y, z - T, ox * 0.6, oy * 0.6, -0.8, x, y, 0.85),
    ]);
  }
  for (let j = 0; j < seg; j++) {
    const A = rim[j], B = rim[j + 1];
    W.quad(A[0], A[1], B[1], B[0]);
    W.quad(A[1], A[2], B[2], B[1]);
  }
  // back bracket and the clamp round the mast (galvanised)
  W.color(0.5, 0.5, 0.49);
  box(W, 0, 0, Z0 - T - 0.004, 0.17, 0.2, 0.012, 0.85);
  box(W, 0, 0, 0.02, 0.08, 0.12, 0.14, 0.8);
  // feed arm from the bracket down behind the reflector, under its lower rim and out to
  // the LNB holder; the LNB low in front of the reflector (an offset dish's focus), its
  // horn aimed at the reflector centre
  W.color(0.7, 0.695, 0.67);
  const knee = [0, -RY - 0.07, 0.1], lnb = [0, -0.16, 0.44], arm1 = [0, -0.235, 0.49];
  tube(W, [0, -0.05, 0.03], knee, 0.011, 6);
  tube(W, knee, arm1, 0.011, 6);
  box(W, 0, -0.215, 0.495, 0.05, 0.035, 0.06, 0.85);
  W.color(0.8, 0.8, 0.78);
  const ax = _A.set(-lnb[0], -lnb[1], Z0 - lnb[2]).normalize().negate(); // away from the reflector
  const bx = _B.set(1, 0, 0), bz = _s.crossVectors(bx, ax).normalize();
  W.setMatrix(_tm.makeBasis(bx, ax, bz).setPosition(lnb[0], lnb[1], lnb[2]));
  lathe(W, [[0.03, 0], [0.03, 0.012], [0.022, 0.03], [0.022, 0.085], [0.027, 0.095], [0.027, 0.13], [0.012, 0.14]], 10, { capBottom: true, capTop: true });
  W.setMatrix(null);
  return template(W, WHITE_UV);
}

/** The wall mount (facade frame, origin at the clamp): wall plate, square arm out to the
 *  mast, a brace under it, and the round mast the dish is clamped to. */
function dishMountTemplate() {
  const W = new GeoWriter(), w0 = -DISH_W;
  W.color(0.5, 0.5, 0.49);
  box(W, 0, -0.2, w0 + 0.006, 0.15, 0.24, 0.012, 0.8, 'b');
  box(W, 0, -0.14, w0 / 2 + 0.006, 0.04, 0.04, -w0 - 0.012, 0.8);
  tube(W, [0, -0.3, w0 + 0.012], [0, -0.155, w0 * 0.3], 0.01, 6);
  tube(W, [0, -0.24, 0], [0, 0.16, 0], 0.024, 10, true);
  return template(W, WHITE_UV);
}

/** Far dish (beyond 200 m, a few pixels): the reflector's two skins on a coarse grid, the
 *  LNB as a box (its 2 cm arm is sub-pixel there), the bracket. Same frame, size and
 *  colours as the near one. */
function dishFarTemplate() {
  const W = new GeoWriter(), { RX, RY, D, Z0, T } = DISH, seg = 14;
  W.color(0.74, 0.735, 0.71);
  const c = [W.v(0, 0, Z0, 0, 0, 1, 0, 0, 0.93), W.v(0, 0, Z0 - T, 0, 0, -1, 0, 0, 0.8)], ring = [];
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2, x = Math.cos(a) * RX, y = Math.sin(a) * RY, z = dishZ(x, y);
    const gx = (2 * D * x) / (RX * RX), gy = (2 * D * y) / (RY * RY), l = Math.sqrt(gx * gx + gy * gy + 1);
    ring.push([W.v(x, y, z, -gx / l, -gy / l, 1 / l, x, y, 0.97), W.v(x, y, z - T, gx / l, gy / l, -1 / l, x, y, 0.8)]);
  }
  for (let j = 0; j < seg; j++) {
    W.tri(c[0], ring[j][0], ring[j + 1][0]);
    W.tri(c[1], ring[j + 1][1], ring[j][1]);
  }
  W.color(0.5, 0.5, 0.49);
  box(W, 0, 0, 0.02, 0.08, 0.12, 0.14, 0.8);
  W.color(0.75, 0.745, 0.72);
  box(W, 0, -0.19, 0.5, 0.05, 0.06, 0.14, 0.85);
  return template(W, WHITE_UV);
}

/** Far wall mount: mast and arm. */
function dishMountFarTemplate() {
  const W = new GeoWriter();
  W.color(0.5, 0.5, 0.49);
  box(W, 0, -0.04, 0, 0.045, 0.4, 0.045, 0.8);
  box(W, 0, -0.14, -DISH_W / 2, 0.04, 0.04, DISH_W, 0.8, 'b');
  return template(W, WHITE_UV);
}

/** The dish's shadow caster (dish frame): the reflector as a coarse shell just behind its
 *  back skin (chords bulge toward the front skin by under 5 mm, so it never shades its
 *  own bowl), both faces (the depth pass draws back faces), the bracket and the LNB. */
function dishCaster() {
  const S = new PosWriter(), { RX, RY, T } = DISH, z = (x, y) => dishZ(x, y) - T - 0.003;
  const c = S.v(0, 0, z(0, 0)), mid = [], rim = [];
  for (let j = 0; j < 10; j++) {
    const a = (j / 10) * Math.PI * 2, x = Math.cos(a) * RX, y = Math.sin(a) * RY;
    mid.push(S.v(x * 0.55, y * 0.55, z(x * 0.55, y * 0.55)));
    rim.push(S.v(x, y, z(x, y)));
  }
  for (let j = 0; j < 10; j++) {
    const k = (j + 1) % 10;
    S.tri(c, mid[j], mid[k]); S.tri(c, mid[k], mid[j]);
    S.quad(mid[j], rim[j], rim[k], mid[k]); S.quad(mid[k], rim[k], rim[j], mid[j]);
  }
  boxPos(S, 0, 0, 0.02, 0.08, 0.12, 0.14);
  boxPos(S, 0, -0.19, 0.5, 0.06, 0.08, 0.15);
  return { P: S.P.slice(0, S.n * 3), I: S.I.slice(0, S.ni), n: S.n };
}

/** The mount's shadow caster (facade frame): mast and arm. */
function dishMountCaster() {
  const S = new PosWriter();
  boxPos(S, 0, -0.04, 0, 0.045, 0.4, 0.045);
  boxPos(S, 0, -0.14, -DISH_W / 2, 0.04, 0.04, DISH_W);
  return { P: S.P.slice(0, S.n * 3), I: S.I.slice(0, S.ni), n: S.n };
}

/** Moulded plastic balcony chair (origin at the floor, facing +z). */
function chairTemplate() {
  const W = new GeoWriter();
  box(W, 0, 0.44, 0, 0.44, 0.03, 0.42);
  const back = new THREE.Matrix4().makeRotationX(-0.18).setPosition(0, 0.66, -0.22);
  W.setMatrix(back); box(W, 0, 0, 0, 0.44, 0.4, 0.025); W.setMatrix(null);
  for (const [x, z] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) box(W, x, 0.22, z, 0.035, 0.44, 0.035, 0.8);
  for (const x of [-0.21, 0.21]) box(W, x, 0.62, 0.0, 0.03, 0.03, 0.38);
  return template(W, WHITE_UV);
}

/** A towel or rug hung over the handrail: front drop 0.45 m, back drop 0.3 m, unit width
 *  along x (scaled on write), folded over the rail at y = 0. White, tinted on write. */
function towelTemplate() {
  const W = new GeoWriter();
  const t = 0.03;
  const Q = (pts, n, s) => { const i = pts.map((p) => W.v(p[0], p[1], p[2], n[0], n[1], n[2], p[0], p[1], s)); W.quad(i[0], i[1], i[2], i[3]); };
  Q([[-0.5, -0.45, t], [0.5, -0.45, t], [0.5, 0, t], [-0.5, 0, t]], [0, 0, 1], 1);
  Q([[0.5, -0.45, t - 0.004], [-0.5, -0.45, t - 0.004], [-0.5, 0, t - 0.004], [0.5, 0, t - 0.004]], [0, 0, -1], 0.7);
  Q([[-0.5, 0.012, t], [0.5, 0.012, t], [0.5, 0.012, -t], [-0.5, 0.012, -t]], [0, 1, 0], 1.05);
  Q([[0.5, -0.3, -t], [-0.5, -0.3, -t], [-0.5, 0, -t], [0.5, 0, -t]], [0, 0, -1], 0.75);
  return template(W, WHITE_UV);
}

/** Flag pole along +y with a ball finial; wall bracket at the foot. */
function poleTemplate(len = 1.9) {
  const W = new GeoWriter();
  W.color(0.78, 0.78, 0.75);
  lathe(W, [[0.016, 0], [0.014, len]], 6);
  W.color(0.6, 0.48, 0.2);
  lathe(W, [[0.0001, len], [0.02, len + 0.01], [0.03, len + 0.035], [0.02, len + 0.06], [0.0001, len + 0.068]], 8);
  W.color(0.25, 0.25, 0.25);
  box(W, 0, 0.05, 0, 0.06, 0.12, 0.06);
  return template(W, WHITE_UV);
}

/** Flag cloth grid: x = fly 0..L, y = hoist 0..-H, z = 0. Instanced. */
function flagGeometry(sx = 24, sy = 16) {
  const g = new THREE.PlaneGeometry(FLAG.L, FLAG.H, sx, sy);
  g.translate(FLAG.L / 2, -FLAG.H / 2, 0);
  return shared(g);
}

/** Plant families, in instance-pool order: geraniums in a pot and along a 0.8 m box,
 *  herb and dried-out clumps (pot sized, several to a box), trailing greens / surfinia
 *  and bougainvillea along a 0.8 m box. */
export const PLANT = { POT: 0, BOX: 1, HERB: 2, DRY: 3, TRAIL: 4, BOUG: 5 };

export function buildAttachAssets() {
  // [detail level][family]; level 1 is the light stand-in used beyond carving distance,
  // level 2 the far one (leaves of a few pixels): fewer cards, larger where that keeps
  // the planting's outline
  const s2 = Math.SQRT2;
  const kinds = [
    [geranium, [{ L: 0.3, D: 0.28, leaves: 16, flowers: 9, height: 0.26 }, { L: 0.3, D: 0.28, leaves: 7, flowers: 5, height: 0.26 },
      { L: 0.3, D: 0.28, leaves: 4, flowers: 3, height: 0.26, ks: [Math.sqrt(7 / 4), Math.sqrt(5 / 3), 1, 1] }]],
    [geranium, [{ L: 0.8, D: 0.18, leaves: 36, flowers: 24, trail: 7, height: 0.32 }, { L: 0.8, D: 0.18, leaves: 14, flowers: 12, trail: 6, height: 0.32 },
      { L: 0.8, D: 0.18, leaves: 5, flowers: 5, trail: 3, height: 0.32, steps: 2, ks: [Math.sqrt(14 / 5), Math.sqrt(12 / 5), Math.sqrt(18 / 6), s2] }]],
    [herb, [{}, { sprigs: 10, crown: 4, spikes: 3, ks: [1.15, 1.1] }, { sprigs: 5, crown: 2, spikes: 2, ks: [1.3, 1.2] }]],
    [dry, [{}, { stalks: 5, tufts: 6, fallen: 1, heads: 2, ks: [1.2, 1.1] }, { stalks: 3, tufts: 3, fallen: 0, heads: 1, ks: [1.5, 1.2] }]],
    [trailing, [{}, { mound: 13, strands: 9, blooms: 7, ks: [1.45, 1.3, 1.25] }, { mound: 6, strands: 6, blooms: 4, ks: [2, 1.8, 1.6] }]],
    [bougainvillea, [{}, { leaves: 4, bracts: 6, crown: 5, ks: [1.45, 1.4] }, { canes: 6, leaves: 2, bracts: 3, crown: 2, ks: [1.9, 1.9] }]],
  ];
  const plants = [[], [], []];
  // (the geraniums' far levels draw from a random stream of their own; the other
  // families build every level from the same seed, so the levels share their layout)
  const r = new RNG(9001), rFar = new RNG(9002);
  kinds.forEach(([fn, levels], kind) => {
    levels.forEach((opts, lvl) => {
      const W = new GeoWriter();
      if (kind < 2) fn(W, lvl < 2 ? r : rFar, { ...opts, lite: lvl > 0 });
      else fn(W, new RNG(9100 + kind), { ...opts, lite: lvl });
      const g = W.toGeometry();
      g.computeBoundingSphere();
      plants[lvl].push(shared(g));
    });
  });
  // the detail levels of each family, as an instance pool takes them
  plants.levels = kinds.map((_, kind) => plants.map((lvl) => lvl[kind]));
  const A = {
    plants,
    pot: potTemplate(),
    box: boxTemplate(),
    trough: troughTemplate(),
    hooks: [hookTemplate(1), hookTemplate(-1)],
    acBody: acBodyTemplate(),
    acBrackets: acBracketTemplate(),
    acPipes: acPipeTemplate(),
    acStain: acStainTemplate(),
    dish: dishTemplate(),
    dishMount: dishMountTemplate(),
    dishFar: dishFarTemplate(),
    dishMountFar: dishMountFarTemplate(),
    chair: chairTemplate(),
    towel: towelTemplate(),
    pole: poleTemplate(),
    flag: flagGeometry(),
    flagShadow: flagGeometry(8, 5), // the cloth's shadow caster: same motion, coarse grid
    flagSize: FLAG,
  };
  // shadow casters (welded positions): the AC body casts in every cascade; the small
  // parts (pots, boxes, troughs, chairs, dishes) and the thin ones (poles, brackets, pipes) only
  // in the fine cascades, whose texels can hold them. The planters' hook straps (2.6 cm)
  // cast nothing.
  A.cast = new Map([[A.acBody, posTemplate(A.acBody)]]);
  A.thin = new Map([A.box, A.trough, A.chair, A.towel, A.pole, A.acBrackets, A.acPipes].map((t) => [t, posTemplate(t)]));
  // the pot's caster: a coarse cone through its foot, belly and rim (chords inside)
  const W = new GeoWriter();
  lathe(W, [[0.084, 0], [0.118, 0.186], [0.134, 0.224], [0.0001, 0.215]], 6);
  A.thin.set(A.pot, posTemplate(W));
  A.thin.set(A.dish, dishCaster());
  A.thin.set(A.dishMount, dishMountCaster());
  // the most numerous parts are instanced (module-wide pools, ironwork/instancer.js)
  // rather than written into the merged mesh: planter boxes and troughs, their hook
  // straps, pots and AC units (pipes and brackets dropped at range: the light level is
  // the bare body)
  const body = templateGeometry([A.acBody]);
  A.pooled = new Map([
    [A.box, { key: 'box', levels: [templateGeometry([A.box])] }],
    [A.trough, { key: 'trough', levels: [templateGeometry([A.trough])] }],
    [A.hooks[0], { key: 'hook0', levels: [templateGeometry([A.hooks[0]])], cls: 'strap', thin: true }],
    [A.hooks[1], { key: 'hook1', levels: [templateGeometry([A.hooks[1]])], cls: 'strap', thin: true }],
    [A.pot, { key: 'pot', levels: [templateGeometry([A.pot])] }],
    ['acWall', { key: 'acWall', levels: [templateGeometry([A.acBody, A.acPipes, A.acBrackets]), body], cls: 'ac' }],
    ['acFloor', { key: 'acFloor', levels: [templateGeometry([A.acBody, A.acPipes]), body], cls: 'ac' }],
  ]);
  return A;
}

/** Shared geometry of one or more templates (instanced parts). */
function templateGeometry(ts) {
  const W = new GeoWriter();
  for (const t of ts) writeTemplate(W, t, IDENTITY);
  const g = W.toGeometry({ copy: true });
  return shared(g);
}
const IDENTITY = new THREE.Matrix4();
