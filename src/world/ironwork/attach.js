import * as THREE from 'three';
import { GeoWriter, box, lathe, sweepBar, shared } from './geo.js';
import { RNG } from '../../core/rng.js';
import { U } from '../../core/uniforms.js';

// Small facade attachments: potted and boxed geraniums, planter boxes, split AC units
// with brackets and pipes, satellite dishes, balcony chairs and flags on angled poles.
// Shared shapes are built once as templates (written into per-chunk merged meshes) or as
// instanced geometries; their textures are painted on canvases at start-up.

// ---------------------------------------------------------------- templates
/** Frozen copy of a GeoWriter, re-emitted many times with different transforms. */
export function template(W) {
  return { P: W.P.slice(0, W.n * 3), N: W.N.slice(0, W.n * 3), T: W.T.slice(0, W.n * 2), C: W.C.slice(0, W.n * 3), I: W.I.slice(0, W.ni), n: W.n };
}

/** Writes a template into W with `matrix` (THREE.Matrix4) and an RGB tint. */
export function writeTemplate(W, t, matrix, tint = [1, 1, 1]) {
  W.setMatrix(matrix);
  const base = W.count;
  const { P, N, T, C } = t;
  for (let i = 0; i < t.n; i++) {
    W.color(C[i * 3] * tint[0], C[i * 3 + 1] * tint[1], C[i * 3 + 2] * tint[2]);
    W.v(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2], T[i * 2], T[i * 2 + 1]);
  }
  for (let i = 0; i < t.I.length; i += 3) W.tri(base + t.I[i], base + t.I[i + 1], base + t.I[i + 2]);
}

// ---------------------------------------------------------------- canvas textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/** Plant atlas (512 x 256): left half a cluster of zonal geranium leaves, right half a
 *  flower umbel painted near-white (tinted per plant), bottom-left corner solid stem green. */
function plantTexture() {
  const cv = canvas(512, 256), g = cv.getContext('2d');
  const r = new RNG(4242);
  const leaf = (x, y, R, rot, dark) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2 - Math.PI / 2;
      let rr = R * (1 + 0.07 * Math.cos(a * 9));
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
    g.strokeStyle = `rgba(20,35,12,0.5)`; g.lineWidth = 1.5; g.stroke(); // crisp leaf margin
    g.strokeStyle = `rgba(${130 * k | 0},${165 * k | 0},${95 * k | 0},0.3)`; g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + Math.PI + (i - 4) * 0.36;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * R * 0.85, Math.sin(a) * R * 0.85); g.stroke();
    }
    g.restore();
  };
  // leaf cluster, back to front, darker underneath
  for (let i = 0; i < 9; i++) {
    const a = r.range(0, Math.PI * 2), d = i < 6 ? r.range(38, 70) : r.range(0, 30);
    leaf(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, r.range(34, 46), r.range(0, Math.PI * 2), i < 6 ? r.range(0.62, 0.8) : r.range(0.9, 1.08));
  }
  // flower umbel: florets of five petals
  g.save(); g.translate(384, 128);
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
      g.strokeStyle = `rgba(0,0,0,0.18)`; g.lineWidth = 1; g.stroke();
      g.restore();
    }
    g.beginPath(); g.arc(x, y, s * 0.16, 0, Math.PI * 2); g.fillStyle = 'rgba(120,120,90,0.9)'; g.fill();
  }
  g.restore();
  // solid stem green
  g.fillStyle = 'rgb(70,100,45)'; g.fillRect(0, 236, 20, 20);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const STEM_UV = [0.02, 0.04];

/** Split AC outdoor unit front (512 x 384): fan grille, panel, grime. Bottom strip plain. */
function acTexture() {
  const cv = canvas(512, 384), g = cv.getContext('2d');
  const W = 512, H = 352;
  g.fillStyle = '#dcdad2'; g.fillRect(0, 0, 512, 384);
  // grime gradient towards the bottom and edges
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgba(90,80,60,0.05)'); gr.addColorStop(0.75, 'rgba(90,80,60,0.12)'); gr.addColorStop(1, 'rgba(70,60,45,0.32)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  // fan grille
  const cx = W * 0.36, cy = H * 0.5, R = H * 0.42;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fillStyle = '#2b2b2a'; g.fill();
  // fan blades seen through
  g.save(); g.translate(cx, cy);
  for (let i = 0; i < 3; i++) {
    g.rotate((Math.PI * 2) / 3);
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(R * 0.5, -R * 0.35, R * 0.9, -R * 0.1); g.quadraticCurveTo(R * 0.55, R * 0.15, 0, 0);
    g.fillStyle = '#4a4a46'; g.fill();
  }
  g.restore();
  g.strokeStyle = '#c9c7bf'; g.lineWidth = 2.2;
  for (let rr = 10; rr < R; rr += 9) { g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke(); }
  g.lineWidth = 3;
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke(); }
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.lineWidth = 7; g.strokeStyle = '#bdbab1'; g.stroke();
  g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2); g.fillStyle = '#c4c1b8'; g.fill();
  // right service panel and seams
  g.strokeStyle = 'rgba(60,55,45,0.35)'; g.lineWidth = 2;
  g.strokeRect(W * 0.74, H * 0.1, W * 0.22, H * 0.8);
  g.fillStyle = 'rgba(60,55,45,0.25)';
  for (let y = H * 0.16; y < H * 0.5; y += 10) g.fillRect(W * 0.77, y, W * 0.16, 3);
  // rust/dirt streaks
  const r = new RNG(77);
  for (let i = 0; i < 14; i++) {
    const x = r.range(0, W), y0 = r.range(H * 0.4, H * 0.9);
    const st = g.createLinearGradient(0, y0, 0, H);
    st.addColorStop(0, 'rgba(90,70,40,0)'); st.addColorStop(1, `rgba(90,70,40,${r.range(0.08, 0.2)})`);
    g.fillStyle = st; g.fillRect(x, y0, r.range(2, 6), H - y0);
  }
  // outline shading (fake bevel)
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 6; g.strokeRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Flag designs (2 x 2 atlas): white with two blue stripes, blue over white, white with red
 *  bands, blue with a narrow white band. Generic designs, no emblems. */
function flagTexture() {
  const cv = canvas(512, 512), g = cv.getContext('2d');
  const cell = (i, j, fn) => { g.save(); g.translate(i * 256, j * 256); fn(256, 256); g.restore(); };
  cell(0, 0, (w, h) => { g.fillStyle = '#f2f2ee'; g.fillRect(0, 0, w, h); g.fillStyle = '#1d3f9a'; g.fillRect(0, h * 0.1, w, h * 0.15); g.fillRect(0, h * 0.75, w, h * 0.15); });
  cell(1, 0, (w, h) => { g.fillStyle = '#1f4fa8'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#f2f2ee'; g.fillRect(0, h / 2, w, h / 2); });
  cell(0, 1, (w, h) => { g.fillStyle = '#f2f2ee'; g.fillRect(0, 0, w, h); g.fillStyle = '#c42028'; g.fillRect(0, 0, w, h * 0.3); g.fillRect(0, h * 0.82, w, h * 0.08); });
  cell(1, 1, (w, h) => { g.fillStyle = '#1b3f8f'; g.fillRect(0, 0, w, h); g.fillStyle = '#f2f2ee'; g.fillRect(0, h * 0.44, w, h * 0.12); });
  // faint fabric weave
  g.globalAlpha = 0.06; g.fillStyle = '#000';
  for (let y = 0; y < 512; y += 3) g.fillRect(0, y, 512, 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- materials
export function makeAttachMaterials(app) {
  const M = app.materials;
  const plant = new THREE.MeshStandardMaterial({
    name: 'ironwork.plant', map: plantTexture(), alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide,
    vertexColors: true, roughness: 0.72,
  });
  // per-instance colour tints only the flower half of the atlas (leaves keep their greens)
  plant.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlowerTint;')
      .replace('#include <color_vertex>', 'vFlowerTint = vec3( 1.0 );\n' + THREE.ShaderChunk.color_vertex
        .replace('vColor.rgb *= instanceColor.rgb;', 'vFlowerTint = instanceColor.rgb;'));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlowerTint;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tif ( vMapUv.x > 0.5 ) diffuseColor.rgb *= vFlowerTint;');
  };
  plant.customProgramCacheKey = () => 'ironwork.plant';

  const parts = new THREE.MeshStandardMaterial({ name: 'ironwork.parts', vertexColors: true, roughness: 0.62, metalness: 0.0 });
  const ac = new THREE.MeshStandardMaterial({ name: 'ironwork.ac', map: acTexture(), vertexColors: true, roughness: 0.5, metalness: 0.05 });

  const flag = new THREE.MeshStandardMaterial({ name: 'ironwork.flag', map: flagTexture(), side: THREE.DoubleSide, roughness: 0.82 });
  // cloth flutter: travelling waves growing from the hoist (x = 0) to the fly end
  const head = `#include <common>
attribute vec3 aFlag;
uniform float uTime;
uniform float uWindStrength;
float flagWave( vec2 p, float ph ) {
	float t = uTime * 4.2 + ph;
	return sin( p.x * 6.5 - t ) * 0.055 + sin( p.x * 11.0 + p.y * 3.0 - t * 1.7 ) * 0.02;
}
float flagAmp() { return ( 0.35 + uWindStrength ) * position.x / 1.2; }`;
  const move = `#include <begin_vertex>
	transformed.z += flagWave( position.xy, aFlag.z ) * flagAmp();
	transformed.y -= 0.03 * flagAmp() * ( 1.0 + sin( uTime * 1.3 + aFlag.z ) );`;
  const flutter = (sh, withNormal) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uWindStrength = U.uWindStrength;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', head).replace('#include <begin_vertex>', move);
    if (!withNormal) return;
    sh.vertexShader = sh.vertexShader
      .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
	vMapUv = vMapUv * 0.5 + aFlag.xy;
#endif`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
	{
		float a = flagAmp(), w0 = flagWave( position.xy, aFlag.z );
		float wx = ( flagWave( position.xy + vec2( 0.02, 0.0 ), aFlag.z ) - w0 ) / 0.02;
		float wy = ( flagWave( position.xy + vec2( 0.0, 0.02 ), aFlag.z ) - w0 ) / 0.02;
		objectNormal = normalize( vec3( -wx * a, -wy * a, 1.0 ) );
	}`);
  };
  flag.onBeforeCompile = (sh) => flutter(sh, true);
  flag.customProgramCacheKey = () => 'ironwork.flag';
  // shadow pass with the same cloth motion
  const flagDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  flagDepth.onBeforeCompile = (sh) => flutter(sh, false);
  flagDepth.customProgramCacheKey = () => 'ironwork.flagDepth';

  for (const m of [plant, parts, ac, flag]) M.register(m.name, m);
  return { plant, parts, ac, flag, flagDepth };
}

// ---------------------------------------------------------------- plants
function card(W, c, nrm, size, rot, uv0, uv1, centre, roundness = 0.6) {
  // quad facing `nrm`, rotated by `rot` around it; normals bent towards the plant centre
  const n = new THREE.Vector3(...nrm).normalize();
  const t = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3().crossVectors(t, n).normalize();
  const b = new THREE.Vector3().crossVectors(n, a);
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const A = a.clone().multiplyScalar(ca).addScaledVector(b, sa).multiplyScalar(size / 2);
  const B = b.clone().multiplyScalar(ca).addScaledVector(a, -sa).multiplyScalar(size / 2);
  const corners = [[-1, -1, uv0[0], uv0[1]], [1, -1, uv1[0], uv0[1]], [1, 1, uv1[0], uv1[1]], [-1, 1, uv0[0], uv1[1]]];
  const idx = corners.map(([i, j, u, v]) => {
    const p = new THREE.Vector3(...c).addScaledVector(A, i).addScaledVector(B, j);
    const sn = p.clone().sub(centre).normalize().lerp(n, 1 - roundness).normalize();
    return W.v(p.x, p.y, p.z, sn.x, sn.y, sn.z, u, v);
  });
  W.quad(idx[0], idx[1], idx[2], idx[3]);
}

const LEAF_UV = [[0.02, 0.02], [0.48, 0.98]], FLOWER_UV = [[0.52, 0.04], [0.98, 0.96]];

/** Geranium foliage + umbels over an area of length L (x) and depth D (z); origin at the
 *  soil centre. trail adds leaves spilling over the front (+z) edge. */
function geranium(W, r, { L = 0.26, D = 0.22, leaves = 18, flowers = 7, trail = 0, height = 0.2, flowersOn = true, lite = false }) {
  const centre = new THREE.Vector3(0, -0.02, 0);
  // foliage mound: leaf-cluster cards (each carries several 6-8 cm leaves)
  for (let i = 0; i < leaves; i++) {
    const x = r.range(-0.5, 0.5) * L, z = r.range(-0.5, 0.5) * D;
    const e = 1 - Math.min(1, Math.hypot(x / (L * 0.62), z / (D * 0.62)));
    const y = 0.03 + e * height * r.range(0.6, 1.0);
    const nrm = [x * 3 + r.range(-0.3, 0.3), 0.5 + r.range(0, 0.7), z * 3 + r.range(-0.3, 0.3)];
    W.color(...[0.95, 1, 0.95].map((c) => c * r.range(0.8, 1.08)));
    card(W, [x, y, z], nrm, r.range(0.2, 0.27) * (lite ? 1.35 : 1), r.range(0, 6.28), LEAF_UV[0], LEAF_UV[1], centre);
  }
  // trailing stems spilling over the front edge
  for (let i = 0; i < trail; i++) {
    const x = r.range(-0.5, 0.5) * L, z = D * 0.5 + r.range(0.02, 0.07);
    const y = -r.range(0.0, 0.26);
    W.color(r.range(0.75, 0.95), r.range(0.8, 1.0), r.range(0.75, 0.95));
    card(W, [x, y, z], [r.range(-0.4, 0.4), r.range(-0.1, 0.4), 1], r.range(0.17, 0.23), r.range(0, 6.28), LEAF_UV[0], LEAF_UV[1], centre, 0.35);
  }
  if (!flowersOn) return;
  // umbels: balls of four cards on short stems standing out of the foliage
  for (let i = 0; i < flowers; i++) {
    const x = r.range(-0.44, 0.44) * L, z = r.range(-0.4, 0.4) * D + (trail ? D * 0.12 : 0);
    const e = 1 - Math.min(1, Math.hypot(x / (L * 0.62), z / (D * 0.62)));
    const y = 0.03 + e * height + r.range(0.04, 0.11);
    const s = r.range(0.11, 0.14) * (lite ? 1.2 : 1);
    W.color(0.85, 0.9, 0.85);
    const sw = 0.0025, y0 = Math.max(0.03, y - 0.15);
    if (lite) {
      // two crossed cards, no stem
      W.color(...[1, 1, 1].map(() => r.range(0.88, 1)));
      const ctr = new THREE.Vector3(x, y - 0.03, z), rot = r.range(0, 3.14);
      card(W, [x, y, z], [Math.cos(rot), 0.5, Math.sin(rot)], s, r.range(0, 6.28), FLOWER_UV[0], FLOWER_UV[1], ctr, 0.55);
      card(W, [x, y, z], [-Math.sin(rot), 0.5, Math.cos(rot)], s, r.range(0, 6.28), FLOWER_UV[0], FLOWER_UV[1], ctr, 0.55);
      continue;
    }
    const a = W.v(x - sw, y0, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]), b = W.v(x + sw, y0, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]);
    const c = W.v(x + sw, y, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]), d = W.v(x - sw, y, z, 0, 0, 1, STEM_UV[0], STEM_UV[1]);
    W.quad(a, b, c, d);
    W.color(...[1, 1, 1].map(() => r.range(0.88, 1)));
    const ctr = new THREE.Vector3(x, y - 0.03, z), rot = r.range(0, 3.14);
    for (let k = 0; k < 3; k++) {
      const ang = rot + (k * Math.PI) / 3;
      card(W, [x, y, z], [Math.cos(ang), 0.35, Math.sin(ang)], s, r.range(0, 6.28), FLOWER_UV[0], FLOWER_UV[1], ctr, 0.55);
    }
    card(W, [x, y + 0.015, z], [0, 1, 0], s * 0.9, r.range(0, 6.28), FLOWER_UV[0], FLOWER_UV[1], ctr, 0.55);
  }
}

// ---------------------------------------------------------------- containers & parts
const SOIL = [0.32, 0.24, 0.18];

/** Terracotta pot (origin at its foot), soil at 0.2 m. White base colour (tinted on write). */
function potTemplate() {
  const W = new GeoWriter();
  lathe(W, [[0.082, 0], [0.088, 0.008], [0.118, 0.185], [0.133, 0.19], [0.136, 0.222], [0.126, 0.226], [0.119, 0.21]], 12);
  W.color(...SOIL);
  lathe(W, [[0.119, 0.2], [0.0001, 0.205]], 12);
  return template(W);
}

/** Rectangular planter, unit length along x (scaled on write), 0.17 deep, 0.16 tall. */
function boxTemplate() {
  const W = new GeoWriter();
  box(W, 0, 0.075, 0, 1, 0.15, 0.17, 0.75);
  box(W, 0, 0.152, 0, 1.02, 0.014, 0.19);
  W.color(...SOIL);
  box(W, 0, 0.158, 0, 0.98, 0.006, 0.15);
  return template(W);
}

/** Far-range planter filling: a green mound and a few flower patches (tinted on write). */
function bloomTemplates() {
  const G = new GeoWriter(), Fl = new GeoWriter();
  G.color(0.11, 0.2, 0.06);
  box(G, 0, 0.21, 0.02, 0.8, 0.1, 0.22);
  Fl.color(1, 1, 1);
  for (const x of [-0.28, -0.05, 0.2, 0.33]) box(Fl, x, 0.27, 0.06, 0.13, 0.06, 0.14);
  return { green: template(G), flowers: template(Fl) };
}

/** Split AC outdoor unit body: x in [-0.4, 0.4], y in [0, 0.55], z in [0.09, 0.37]. */
function acBodyTemplate() {
  const W = new GeoWriter();
  const x0 = -0.4, x1 = 0.4, y0 = 0, y1 = 0.55, z0 = 0.09, z1 = 0.37;
  const plain = [0.5, 0.04];
  const F = (pts, n, uvs) => { const i = pts.map((p, k) => W.v(p[0], p[1], p[2], n[0], n[1], n[2], uvs ? uvs[k][0] : plain[0], uvs ? uvs[k][1] : plain[1])); W.quad(i[0], i[1], i[2], i[3]); };
  const vt = 1, vb = 32 / 384;
  F([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [[0, vb], [1, vb], [1, vt], [0, vt]]);
  F([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]);
  F([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  W.color(0.92, 0.92, 0.92);
  F([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]);
  W.color(0.6, 0.6, 0.6);
  F([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
  return template(W);
}

/** AC wall brackets (galvanised angles) in the AC unit's frame. */
function acBracketTemplate() {
  const W = new GeoWriter();
  W.color(0.42, 0.42, 0.4);
  for (const x of [-0.3, 0.3]) {
    box(W, x, -0.02, 0.2, 0.04, 0.04, 0.4);
    W.setMatrix(new THREE.Matrix4().makeRotationX(-Math.atan2(0.33, 0.3)).setPosition(x, -0.19, 0.15));
    box(W, 0, 0, 0, 0.035, 0.035, 0.44);
    W.setMatrix(null);
    box(W, x, -0.18, 0.004, 0.06, 0.4, 0.008);
  }
  W.color(0.85, 0.85, 0.85); // condensate hose dropping down the wall
  sweepBar(W, [[0.3, 0.0], [0.32, -0.15], [0.33, -0.9]], 0.007, 0.007, { z0: 0.12 });
  return template(W);
}

/** Taped refrigerant pipe pair leaving the unit's side and entering the wall. */
function acPipeTemplate() {
  const W = new GeoWriter();
  W.color(0.82, 0.81, 0.77);
  for (const dz of [0, 0.05]) {
    W.setMatrix(new THREE.Matrix4().makeTranslation(0, 0, 0.16 + dz));
    sweepBar(W, [[0.4, 0.12 + dz * 0.4], [0.47, 0.12 + dz * 0.4], [0.52, 0.06 + dz * 0.4], [0.52, -0.25]], 0.018, 0.018, {});
    W.setMatrix(null);
    // last stretch back into the wall
    W.setMatrix(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0.52, -0.25 + dz * 0.4, 0));
    sweepBar(W, [[-0.16 - dz, 0], [0.02, 0]], 0.018, 0.018, {});
    W.setMatrix(null);
  }
  return template(W);
}

/** Satellite dish on a wall arm, facing +z (re-aimed per placement). */
function dishTemplate() {
  const W = new GeoWriter();
  const R = 0.32, depth = 0.07, rings = 5, seg = 16;
  W.color(0.78, 0.78, 0.76);
  const front = [], back = [];
  for (let i = 0; i <= rings; i++) {
    const r = (i / rings) * R, z = (r * r) / (R * R) * depth;
    const fr = [], bk = [];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const nz = 1, nr = -2 * r / (R * R) * depth;
      const l = Math.hypot(nz, nr);
      fr.push(W.v(c * r, s * r, z, (c * nr) / l, (s * nr) / l, nz / l, c * r, s * r));
      bk.push(W.v(c * r, s * r, z - 0.006, -(c * nr) / l, -(s * nr) / l, -nz / l, c * r, s * r, 0.8));
    }
    front.push(fr); back.push(bk);
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    W.quad(front[i][j], front[i][j + 1], front[i + 1][j + 1], front[i + 1][j]);
    W.quad(back[i][j], back[i + 1][j], back[i + 1][j + 1], back[i][j + 1]);
  }
  W.color(0.3, 0.3, 0.3);
  sweepBar(W, [[0, -R * 0.9], [0, -R * 0.2]], 0.01, 0.01, { z0: 0.32 });       // LNB arm (in the dish's front)
  box(W, 0, -R * 0.15, 0.32, 0.05, 0.08, 0.06);                                 // LNB
  W.color(0.55, 0.55, 0.55);
  box(W, 0, -0.05, -0.12, 0.05, 0.05, 0.2);                                     // mount arm back to the wall
  return template(W);
}

/** Moulded plastic balcony chair (origin at the floor, facing +z). */
function chairTemplate() {
  const W = new GeoWriter();
  box(W, 0, 0.44, 0, 0.44, 0.03, 0.42);
  const back = new THREE.Matrix4().makeRotationX(-0.18).setPosition(0, 0.66, -0.22);
  W.setMatrix(back); box(W, 0, 0, 0, 0.44, 0.4, 0.025); W.setMatrix(null);
  for (const [x, z] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) box(W, x, 0.22, z, 0.035, 0.44, 0.035, 0.8);
  for (const x of [-0.21, 0.21]) box(W, x, 0.62, 0.0, 0.03, 0.03, 0.38);
  return template(W);
}

/** Flag pole along +y with a ball finial; wall bracket at the foot. */
function poleTemplate(len = 1.9) {
  const W = new GeoWriter();
  W.color(0.85, 0.85, 0.82);
  lathe(W, [[0.016, 0], [0.014, len]], 6);
  W.color(0.75, 0.6, 0.25);
  lathe(W, [[0.0001, len], [0.02, len + 0.01], [0.03, len + 0.035], [0.02, len + 0.06], [0.0001, len + 0.068]], 8);
  W.color(0.3, 0.3, 0.3);
  box(W, 0, 0.05, 0, 0.06, 0.12, 0.06);
  return template(W);
}

/** Flag cloth grid: x = fly 0..1.2 m, y = hoist 0..-0.8 m, z = 0. Instanced. */
function flagGeometry() {
  const nx = 14, ny = 8, w = 1.2, h = 0.8;
  const g = new THREE.PlaneGeometry(w, h, nx, ny);
  g.translate(w / 2, -h / 2, 0);
  return shared(g);
}

export function buildAttachAssets() {
  // [detail level][pot geranium, box geranium (0.8 m, trailing)]; level 1 is the light
  // stand-in used once a chunk is beyond carving distance
  const plants = [[], []];
  const r = new RNG(9001);
  const kinds = [
    [{ L: 0.3, D: 0.28, leaves: 16, flowers: 8, height: 0.2 }, { L: 0.3, D: 0.28, leaves: 6, flowers: 4, height: 0.2 }],
    [{ L: 0.8, D: 0.18, leaves: 34, flowers: 18, trail: 14, height: 0.15 }, { L: 0.8, D: 0.18, leaves: 12, flowers: 8, trail: 5, height: 0.15 }],
  ];
  for (const [full, lite] of kinds) {
    for (const [lvl, opts] of [[0, full], [1, lite]]) {
      const W = new GeoWriter();
      geranium(W, r, { ...opts, lite: lvl === 1 });
      plants[lvl].push(shared(W.toGeometry()));
    }
  }
  const pot = potTemplate(), planter = boxTemplate();
  return {
    plants,
    pot, box: planter,

    bloomLow: bloomTemplates(),
    acBody: acBodyTemplate(),
    acBrackets: acBracketTemplate(),
    acPipes: acPipeTemplate(),
    dish: dishTemplate(),
    chair: chairTemplate(),
    pole: poleTemplate(),
    flag: flagGeometry(),
  };
}
