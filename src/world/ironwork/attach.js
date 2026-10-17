import * as THREE from 'three';
import { GeoWriter, box, lathe, sweepBar, shared } from './geo.js';
import { RNG } from '../../core/rng.js';
import { U } from '../../core/uniforms.js';

// Small facade attachments: potted and boxed geraniums, planter boxes with their rail
// hooks, split AC units with brackets, pipes and the stains they leave on the wall,
// satellite dishes, balcony chairs and flags on angled poles.
// Shared shapes are built once as templates (written into per-chunk merged meshes) or as
// instanced geometries; their textures are painted on canvases at start-up.

// ---------------------------------------------------------------- templates
/** Frozen copy of a GeoWriter, re-emitted many times with different transforms. */
export function template(W) {
  return { P: W.P.slice(0, W.n * 3), N: W.N.slice(0, W.n * 3), T: W.T.slice(0, W.n * 2), C: W.C.slice(0, W.n * 3), I: W.I.slice(0, W.ni), n: W.n };
}

/** Writes a template into W with `matrix` (THREE.Matrix4) and an RGB tint (fast path:
 *  straight into the writer's arrays). */
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
  W.n += t.n;
  const I = W.I, I0 = t.I;
  for (let i = 0; i < I0.length; i++) I[W.ni + i] = base + I0[i];
  W.ni += I0.length;
}

// ---------------------------------------------------------------- canvas textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/** Plant atlas (512 x 256): left half a zonal geranium leaf, right half a flower umbel
 *  painted near-white (tinted per plant), bottom-left corner solid stem green. */
function plantTexture() {
  const cv = canvas(512, 256), g = cv.getContext('2d');
  const r = new RNG(4242);
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
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1; g.stroke();
      g.restore();
    }
    g.beginPath(); g.arc(x, y, s * 0.16, 0, Math.PI * 2); g.fillStyle = 'rgba(120,120,90,0.9)'; g.fill();
  }
  g.restore();
  g.fillStyle = 'rgb(70,100,45)'; g.fillRect(0, 236, 20, 20);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const STEM_UV = [0.02, 0.04];

// AC atlas (512 x 512): rows 0..352 the front (fan grille, service panel), below it the
// side louvre panel (x < 256) and the dusty top (x >= 256).
const AC_FRONT_V = 1 - 352 / 512;

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
  // foliage keeps its (outward-bent) normal on both faces: lit like a volume, not a sheet
  plant.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlowerTint;')
      .replace('#include <color_vertex>', 'vFlowerTint = vec3( 1.0 );\n' + THREE.ShaderChunk.color_vertex
        .replace('vColor.rgb *= instanceColor.rgb;', 'vFlowerTint = instanceColor.rgb;'));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlowerTint;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tif ( vMapUv.x > 0.5 ) diffuseColor.rgb *= vFlowerTint;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  plant.customProgramCacheKey = () => 'ironwork.plant';

  const parts = new THREE.MeshStandardMaterial({ name: 'ironwork.parts', vertexColors: true, roughness: 0.62, metalness: 0.0 });
  const ac = new THREE.MeshStandardMaterial({ name: 'ironwork.ac', map: acTexture(), vertexColors: true, roughness: 0.55, metalness: 0.0 });
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

  for (const m of [plant, parts, ac, stain, flag]) M.register(m.name, m);
  return { plant, parts, ac, stain, flag, flagDepth };
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

const LEAF_UV = [[0.035, 0.07], [0.465, 0.93]], FLOWER_UV = [[0.52, 0.04], [0.98, 0.96]];

/** Flower umbel: crossed cards (and a stem at full detail). */
function umbel(W, r, x, y, z, s, lite) {
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
    card(W, [x, y, z], [Math.cos(ang), 0.45, Math.sin(ang)], s, r.range(0, 6.28), FLOWER_UV[0], FLOWER_UV[1], ctr, 0.55);
  }
  if (!lite) card(W, [x, y + 0.012, z], [0, 1, 0], s * 0.9, r.range(0, 6.28), FLOWER_UV[0], FLOWER_UV[1], ctr, 0.55);
}

/** Geranium planting over an area L (x) by D (z), origin at the soil centre: a leafy
 *  mound `height` tall, umbels standing out of it, and `trail` ivy-geranium strands
 *  hanging over the front (+z) edge, 0.2 - 0.5 m long. */
function geranium(W, r, { L = 0.26, D = 0.22, leaves = 18, flowers = 7, trail = 0, height = 0.3, lite = false }) {
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
    card(W, [x, y, z], nrm, lite ? r.range(0.12, 0.16) : r.range(0.065, 0.1), r.range(0, 6.28), LEAF_UV[0], LEAF_UV[1], centre, 0.5);
  }
  // umbels on top, standing just out of the foliage
  for (let i = 0; i < flowers; i++) {
    const x = r.range(-0.92, 0.92) * ax * 0.85, z = r.range(-0.8, 0.8) * az * 0.8;
    const y = 0.015 + dome(x, z) * height + r.range(0.02, 0.08);
    umbel(W, r, x, y, z, r.range(0.11, 0.15) * (lite ? 1.2 : 1), lite);
  }
  // trailing strands over the front edge: chains of leaves, a flower or two on each
  for (let i = 0; i < trail; i++) {
    const x0 = r.range(-0.48, 0.48) * L, len = r.range(0.2, 0.5);
    const steps = lite ? 3 : Math.max(4, Math.round(len / 0.055));
    const out = r.range(0.03, 0.09), sway = r.range(-0.08, 0.08);
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const x = x0 + sway * t + r.range(-0.02, 0.02), y = 0.02 - len * t, z = D * 0.5 + 0.02 + out * Math.sin(t * 1.8);
      W.color(r.range(0.66, 0.9), r.range(0.76, 1.0), r.range(0.66, 0.88));
      card(W, [x, y, z], [r.range(-0.5, 0.5), r.range(-0.2, 0.6), 1], lite ? r.range(0.1, 0.13) : r.range(0.055, 0.08), r.range(0, 6.28), LEAF_UV[0], LEAF_UV[1], centre, 0.35);
    }
    const nf = lite ? 1 : r.int(1, 2);
    for (let k = 0; k < nf; k++) {
      const t = r.range(0.35, 1);
      umbel(W, r, x0 + sway * t, 0.04 - len * t, D * 0.5 + 0.04 + out, r.range(0.08, 0.11) * (lite ? 1.2 : 1), true);
    }
  }
}

// ---------------------------------------------------------------- containers & parts
const SOIL = [0.2, 0.15, 0.11];

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
  lathe(W, [[0.084, 0], [0.1, 0.09]], 10);
  W.color(1, 1, 1);
  lathe(W, [[0.1, 0.09], [0.118, 0.186], [0.135, 0.19], [0.134, 0.224], [0.119, 0.21]], 10);
  W.color(...SOIL);
  lathe(W, [[0.119, 0.2], [0.0001, 0.205]], 10);
  return template(W);
}

/** Rectangular planter, unit length along x (scaled on write), 0.17 deep, 0.16 tall:
 *  water-stained toward the foot, lighter rim, dark soil line under the rim. */
function boxTemplate() {
  const W = new GeoWriter();
  gradBox(W, -0.5, 0.5, 0, 0.15, -0.085, 0.085, 0.66, 0.95, 'u');
  gradBox(W, -0.51, 0.51, 0.146, 0.16, -0.095, 0.095, 1.0, 1.04, '');
  W.color(...SOIL);
  box(W, 0, 0.162, 0, 0.98, 0.006, 0.15, 1, 'fblrd');
  return template(W);
}

/** Two flat-bar hooks holding a planter on the handrail (box space: the rail is on the
 *  -z side, `back` metres behind the box centre; mirror with dir = -1). */
function hookTemplate(dir) {
  const W = new GeoWriter();
  W.color(0.05, 0.05, 0.05);
  const zb = -0.09 * dir, zf = -0.162 * dir;
  for (const x of [-0.32, 0.32]) {
    box(W, x, 0.105, zb, 0.026, 0.21, 0.005, 1, 'd');                         // up the box back
    box(W, x, 0.207, (zb + zf) / 2, 0.026, 0.005, Math.abs(zf - zb) + 0.005);  // over the handrail
    box(W, x, 0.18, zf, 0.026, 0.055, 0.005, 1, 'u');                          // down the far side
  }
  return template(W);
}

/** Far-range planter: the box, a squashed foliage mound and flower clumps (lathe mounds,
 *  ~40-60 triangles each, tinted on write). */
function bloomTemplates() {
  const B = new GeoWriter(), G = new GeoWriter(), Fl = new GeoWriter();
  gradBox(B, -0.5, 0.5, 0, 0.16, -0.085, 0.085, 0.66, 0.98, 'b');
  const mound = [[1, 0], [0.92, 0.45], [0.62, 0.85], [0.0001, 1]];
  G.color(0.11, 0.19, 0.06);
  G.setMatrix(new THREE.Matrix4().makeScale(0.54, 0.26, 0.15).setPosition(0, 0.15, 0.015));
  lathe(G, mound, 8);
  // two hanging lobes over the front face
  for (const x of [-0.25, 0.22]) {
    G.setMatrix(new THREE.Matrix4().makeRotationX(Math.PI).scale(new THREE.Vector3(0.16, 0.2, 0.05)).setPosition(x, 0.16, 0.09));
    lathe(G, mound, 6);
  }
  Fl.color(1, 1, 1);
  for (const [x, y, z, s] of [[-0.3, 0.33, 0.03, 0.14], [0.02, 0.38, 0.0, 0.16], [0.3, 0.32, 0.04, 0.13], [-0.24, 0.02, 0.13, 0.09], [0.24, 0.05, 0.12, 0.08]]) {
    Fl.setMatrix(new THREE.Matrix4().makeScale(s, s * 0.55, s * 0.75).setPosition(x, y - s * 0.3, z));
    lathe(Fl, mound, 6);
  }
  return { box: template(B), green: template(G), flowers: template(Fl) };
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
  return template(W);
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
  return template(W);
}

/** Wall stain quad under a wall-mounted unit (unit frame; 0.9 m wide, 1.6 m tall). */
function acStainTemplate() {
  const W = new GeoWriter();
  const a = W.v(-0.45, -1.6, 0.004, 0, 0, 1, 0, 0), b = W.v(0.45, -1.6, 0.004, 0, 0, 1, 1, 0);
  const c = W.v(0.45, 0, 0.004, 0, 0, 1, 1, 1), d = W.v(-0.45, 0, 0.004, 0, 0, 1, 0, 1);
  W.quad(a, b, c, d);
  return template(W);
}

/** Satellite dish on a wall arm, facing +z (re-aimed per placement). */
function dishTemplate() {
  const W = new GeoWriter();
  const R = 0.32, depth = 0.07, rings = 5, seg = 16;
  W.color(0.72, 0.71, 0.68);
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
  W.color(0.5, 0.5, 0.5);
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
  return template(W);
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
  return template(W);
}

/** Flag cloth grid: x = fly 0..L, y = hoist 0..-H, z = 0. Instanced. */
function flagGeometry() {
  const g = new THREE.PlaneGeometry(FLAG.L, FLAG.H, 24, 16);
  g.translate(FLAG.L / 2, -FLAG.H / 2, 0);
  return shared(g);
}

export function buildAttachAssets() {
  // [detail level][pot geranium, box geranium (0.8 m, trailing)]; level 1 is the light
  // stand-in used beyond carving distance
  const plants = [[], []];
  const r = new RNG(9001);
  const kinds = [
    [{ L: 0.3, D: 0.28, leaves: 16, flowers: 9, height: 0.26 }, { L: 0.3, D: 0.28, leaves: 7, flowers: 5, height: 0.26 }],
    [{ L: 0.8, D: 0.18, leaves: 36, flowers: 24, trail: 7, height: 0.32 }, { L: 0.8, D: 0.18, leaves: 14, flowers: 12, trail: 6, height: 0.32 }],
  ];
  for (const [full, lite] of kinds) {
    for (const [lvl, opts] of [[0, full], [1, lite]]) {
      const W = new GeoWriter();
      geranium(W, r, { ...opts, lite: lvl === 1 });
      const g = W.toGeometry();
      g.computeBoundingSphere();
      plants[lvl].push(shared(g));
    }
  }
  return {
    plants,
    pot: potTemplate(),
    box: boxTemplate(),
    hooks: [hookTemplate(1), hookTemplate(-1)],
    bloomLow: bloomTemplates(),
    acBody: acBodyTemplate(),
    acBrackets: acBracketTemplate(),
    acPipes: acPipeTemplate(),
    acStain: acStainTemplate(),
    dish: dishTemplate(),
    chair: chairTemplate(),
    towel: towelTemplate(),
    pole: poleTemplate(),
    flag: flagGeometry(),
    flagSize: FLAG,
  };
}
