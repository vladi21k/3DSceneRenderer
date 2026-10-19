import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { U } from '../../core/uniforms.js';
import { buildPrintAtlas, buildDisplayAtlas, buildLitAtlas, buildGlassDecal, buildBrandAtlas, ATLAS_H, LIT_ROWS, BRAND_PRINT } from './prints.js';
import { VALANCE_H } from './umbrella.js';
import { contactShadowTexture } from './vehicles.js';

// Furniture-specific materials and their procedural textures. Generic surfaces (painted
// iron, timber, concrete, platform paving...) come from the shared library by name; the
// ones here need patterns or shading the library does not have: woven seats, rattan,
// translucent canopy fabric with wind, clear glass, printed graphics, lit panels.
// Every material is registered as 'furniture.*' so lighting tracks it.

const srgb = (hex) => new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function tex(c, { srgb: isColor = true, repeat = null, aniso = 8 } = {}, renderer) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = Math.min(aniso, renderer?.capabilities.getMaxAnisotropy() || 1);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Tangent-space normal map from a height field (Float32Array w*h, wraps). */
function heightToNormal(hf, w, h, strength) {
  const c = canvas(w, h), ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = hf[y * w + ((x - 1 + w) % w)], r = hf[y * w + ((x + 1) % w)];
    const u = hf[((y - 1 + h) % h) * w + x], d = hf[((y + 1) % h) * w + x];
    // canvas rows run downwards while v runs upwards
    let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const i = (y * w + x) * 4;
    img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ woven seat (bistro chairs)
const WEAVES = [
  { a: '#e6dcc3', b: '#1f1d1c', pat: (i, j) => ((i >> 1) + (j >> 1)) % 2 === 0 },          // cream / black checks
  { a: '#e9e6de', b: '#1e2a47', pat: (i, j) => j % 3 === 0 || i % 6 === 0 },              // white / navy lines
  { a: '#d9c7a3', b: '#7d2622', pat: (i, j) => Math.abs((i % 8) - 4) + Math.abs((j % 8) - 4) < 3 }, // beige / red diamonds
  { a: '#e1d9c1', b: '#2c4636', pat: (i, j) => (i + j) % 6 < 2 },                           // ivory / green twill
];
const WEAVE_TILE = 0.128; // metres covered by one texture tile

function weaveTextures(spec, renderer) {
  const N = 256, S = 8; // strand width in pixels (= 4 mm)
  const A = srgb(spec.a), B = srgb(spec.b);
  const col = canvas(N, N), ctx = col.getContext('2d'), img = ctx.createImageData(N, N);
  const hf = new Float32Array(N * N);
  const rng = RNG.from('weave', spec.a);
  const jit = Array.from({ length: 64 }, () => 0.9 + rng.next() * 0.2);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (x / S) | 0, j = (y / S) | 0, fx = (x % S + 0.5) / S, fy = (y % S + 0.5) / S;
    const uOver = (i + j) % 2 === 0; // which strand is on top here (plain weave)
    const f = uOver ? fy : fx;        // across-strand coordinate of the top strand
    const along = uOver ? fx : fy;
    const strandIdx = uOver ? j : i;
    const useB = uOver ? spec.pat(0, j) && spec.pat(i, j) : spec.pat(i, j);
    const c = useB ? B : A;
    const prof = Math.sin(Math.PI * f);                // rounded strand
    const dip = 0.75 + 0.25 * Math.sin(Math.PI * along); // dives under the crossing strand
    const gap = sm(0.0, 0.12, f) * sm(1.0, 0.88, f);
    const shade = (0.55 + 0.45 * prof * dip) * (0.25 + 0.75 * gap) * jit[strandIdx % 64];
    const k = (y * N + x) * 4;
    // linear -> sRGB bytes
    img.data[k] = Math.pow(Math.min(1, c.r * shade), 1 / 2.2) * 255;
    img.data[k + 1] = Math.pow(Math.min(1, c.g * shade), 1 / 2.2) * 255;
    img.data[k + 2] = Math.pow(Math.min(1, c.b * shade), 1 / 2.2) * 255;
    img.data[k + 3] = 255;
    hf[y * N + x] = (prof * dip * gap + (uOver ? 0.15 : 0)) * 1.0;
  }
  ctx.putImageData(img, 0, 0);
  const rep = [1 / WEAVE_TILE, 1 / WEAVE_TILE];
  return { map: tex(col, { repeat: rep }, renderer), normalMap: tex(heightToNormal(hf, N, N, 3.0), { srgb: false, repeat: rep }, renderer) };
}

// ------------------------------------------------------------------ wicker (natural basket weave)
function wickerTextures(renderer) {
  // flat synthetic-rattan weavers (~7 mm) over vertical stakes, tile = 0.12 m
  const N = 256, rng = RNG.from('wicker');
  const col = canvas(N, N), ctx = col.getContext('2d'), img = ctx.createImageData(N, N);
  const hf = new Float32Array(N * N);
  const S = 16, stake = 32;
  const rowJ = Array.from({ length: 64 }, () => 0.8 + rng.next() * 0.35);
  const base = srgb('#ab8a62'); // natural honey cane, slightly greyed by sun
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const j = (y / S) | 0, fy = (y % S + 0.5) / S;
    const si = (x / stake) | 0, fx = (x % stake + 0.5) / stake;
    const over = (si + j) % 2 === 0;
    const bulge = over ? Math.sin(Math.PI * fx) : 0.2 + 0.25 * (1 - Math.cos(Math.PI * 2 * fx)) * 0.5;
    const prof = Math.pow(Math.sin(Math.PI * fy), 0.6);
    const gap = sm(0, 0.16, fy) * sm(1, 0.84, fy);
    const stakeVis = !over && Math.abs(fx - 0.5) < 0.16 ? 1 : 0; // stake shows where the weaver dives
    const streak = 0.9 + 0.1 * Math.sin(x * 0.7 + j * 7.1) * Math.sin(x * 0.13 + j);
    let shade = (0.5 + 0.5 * prof * (0.55 + 0.45 * bulge)) * (0.35 + 0.65 * gap) * rowJ[j % 64] * streak;
    if (stakeVis) shade *= 0.7;
    const k = (y * N + x) * 4;
    img.data[k] = Math.pow(Math.min(1, base.r * shade), 1 / 2.2) * 255;
    img.data[k + 1] = Math.pow(Math.min(1, base.g * shade), 1 / 2.2) * 255;
    img.data[k + 2] = Math.pow(Math.min(1, base.b * shade), 1 / 2.2) * 255;
    img.data[k + 3] = 255;
    hf[y * N + x] = prof * gap * (0.4 + 0.6 * bulge);
  }
  ctx.putImageData(img, 0, 0);
  const rep = [1 / 0.12, 1 / 0.12];
  return { map: tex(col, { repeat: rep }, renderer), normalMap: tex(heightToNormal(hf, N, N, 2.0), { srgb: false, repeat: rep }, renderer) };
}

// ------------------------------------------------------------------ rattan cane (bistro chair frames)
function rattanTexture(renderer) {
  const W = 64, H = 512, rng = RNG.from('rattan'); // u: 0.08 m around, v: 0.8 m along
  const c = canvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#94704a'); g.addColorStop(0.5, '#b8946a'); g.addColorStop(1, '#94704a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // fine longitudinal fibres
  for (let i = 0; i < 160; i++) {
    ctx.strokeStyle = `rgba(${rng.chance(0.5) ? '70,40,20' : '220,180,120'},${0.05 + rng.next() * 0.08})`;
    ctx.lineWidth = 0.5 + rng.next();
    const x = rng.next() * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + rng.range(-2, 2), H); ctx.stroke();
  }
  // burnt "tortoiseshell" blotches typical of bistro frames
  for (let i = 0; i < 9; i++) {
    const x = rng.next() * W, y = rng.next() * H, r = rng.range(2, 6), l = rng.range(8, 22);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, l);
    gr.addColorStop(0, `rgba(58,32,14,${0.45 + rng.next() * 0.25})`); gr.addColorStop(1, 'rgba(58,32,14,0)');
    ctx.fillStyle = gr;
    ctx.save(); ctx.translate(x, y); ctx.scale(r / l, 1); ctx.translate(-x, -y);
    ctx.beginPath(); ctx.arc(x, y, l, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    for (const dx of [-W, W]) { // wrap around the tube
      ctx.save(); ctx.translate(x + dx, y); ctx.scale(r / l, 1); ctx.translate(-x - dx, -y);
      ctx.beginPath(); ctx.arc(x + dx, y, l, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  }
  // growth nodes
  for (let y = 40; y < H; y += 150 + rng.range(-20, 20)) {
    ctx.fillStyle = 'rgba(60,34,16,0.55)'; ctx.fillRect(0, y, W, 3);
    ctx.fillStyle = 'rgba(230,200,150,0.35)'; ctx.fillRect(0, y + 3, W, 2);
  }
  return tex(c, { repeat: [1 / 0.08, 1 / 0.8] }, renderer);
}

// ------------------------------------------------------------------ table tops (speckled compact stone)
function speckleTexture(renderer) {
  const N = 512, rng = RNG.from('speckle'); // 0.5 m tile
  const c = canvas(N, N), ctx = c.getContext('2d');
  ctx.fillStyle = '#d9d7d2'; ctx.fillRect(0, 0, N, N);
  for (let i = 0; i < 5000; i++) {
    const v = rng.range(120, 245) | 0, a = rng.range(0.2, 0.7);
    ctx.fillStyle = `rgba(${v},${v - 2},${v - 6},${a})`;
    const r = rng.next() < 0.9 ? rng.range(0.5, 1.6) : rng.range(2, 4);
    ctx.beginPath(); ctx.arc(rng.next() * N, rng.next() * N, r, 0, Math.PI * 2); ctx.fill();
  }
  // soft cloudy veining
  for (let i = 0; i < 12; i++) {
    ctx.strokeStyle = `rgba(150,148,142,${0.05 + rng.next() * 0.06})`;
    ctx.lineWidth = rng.range(2, 8);
    ctx.beginPath();
    let x = rng.next() * N, y = rng.next() * N; ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += rng.range(-80, 80); y += rng.range(-80, 80); ctx.lineTo(x, y); }
    ctx.stroke();
  }
  return tex(c, { repeat: [2, 2] }, renderer);
}

// ------------------------------------------------------------------ tactile warning paving
function tactileTextures(renderer) {
  const N = 256, rng = RNG.from('tactile'); // one 0.30 m tile per texture
  const col = canvas(N, N), ctx = col.getContext('2d'), img = ctx.createImageData(N, N);
  const hf = new Float32Array(N * N);
  const pitch = N / 5, rad = N * (0.0125 / 0.3), top = N * (0.009 / 0.3);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = (Math.floor(x / pitch) + 0.5) * pitch, cy = (Math.floor(y / pitch) + 0.5) * pitch;
    const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const dome = r < top ? 1 : r < rad * 1.35 ? Math.cos((Math.min(1, (r - top) / (rad * 1.35 - top))) * Math.PI / 2) : 0;
    const edge = Math.min(x, y, N - 1 - x, N - 1 - y);
    const joint = edge < 2 ? 1 : 0;
    const grain = (rng.next() - 0.5) * 0.08;
    let v = 0.62 + grain + dome * 0.05 - joint * 0.35;
    if (dome > 0 && dome < 0.6) v -= 0.06 * (1 - dome); // grime around stud feet
    const k = (y * N + x) * 4;
    img.data[k] = Math.min(255, v * 255 * 1.03); img.data[k + 1] = Math.min(255, v * 255 * 1.0); img.data[k + 2] = Math.min(255, v * 255 * 0.9); img.data[k + 3] = 255;
    hf[y * N + x] = dome - joint * 0.3;
  }
  ctx.putImageData(img, 0, 0);
  const rep = [1 / 0.3, 1 / 0.3];
  return { map: tex(col, { repeat: rep }, renderer), normalMap: tex(heightToNormal(hf, N, N, 5), { srgb: false, repeat: rep }, renderer) };
}

// ------------------------------------------------------------------ plastic stipple, brushed metal, timber
/** Fine moulded-in stipple of polypropylene shells (0.5 mm grain, 0.128 m tile). */
function stippleNormal(renderer) {
  const N = 256, rng = RNG.from('stipple');
  const hf = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) hf[i] = rng.next();
  // two box blurs: soft grains of ~2 px
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let a = 0;
      for (let k = -1; k <= 1; k++) a += hf[y * N + ((x + k + N) % N)] + hf[((y + k + N) % N) * N + x];
      t[y * N + x] = a / 6;
    }
    hf.set(t);
  }
  const rep = [1 / 0.128, 1 / 0.128];
  return tex(heightToNormal(hf, N, N, 1.6), { srgb: false, repeat: rep }, renderer);
}

/** Brushed finish: fine streaks along v (tubes and bars run along v). Tile 0.1 m. */
function brushedNormal(renderer) {
  const N = 256, rng = RNG.from('brushed');
  const hf = new Float32Array(N * N);
  const col = Array.from({ length: N }, () => rng.next());
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const a = col[x] * 0.7 + col[(x + 1) % N] * 0.3;
    hf[y * N + x] = a + 0.15 * Math.sin((y / N) * Math.PI * 2 * 3 + col[x] * 6);
  }
  return tex(heightToNormal(hf, N, N, 0.6), { srgb: false, repeat: [10, 10] }, renderer);
}

/** Weathered timber slats: grey-brown, straight grain along u, fine checking cracks. Tile 1 x 0.25 m. */
function timberTextures(renderer) {
  const W = 1024, H = 256, rng = RNG.from('timber');
  const c = canvas(W, H), ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const hf = new Float32Array(W * H);
  const base = srgb('#8a7660');
  const rowTone = Array.from({ length: H }, (_, y) => 0.9 + 0.1 * Math.sin(y * 0.21 + Math.sin(y * 0.05) * 3) + (rng.next() - 0.5) * 0.06);
  const cracks = Array.from({ length: 14 }, () => ({ y: rng.next() * H, x0: rng.next() * W, len: rng.range(60, 260), w: rng.range(0.6, 1.4) }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ring = Math.sin((y + 6 * Math.sin(x * 0.004 + y * 0.02)) * 0.55) * 0.5 + 0.5;
    let v = rowTone[y] * (0.88 + 0.12 * ring) * (0.95 + 0.05 * Math.sin(x * 0.03 + y));
    let h = ring * 0.4;
    for (const k of cracks) {
      const dx = x - k.x0;
      if (dx < 0 || dx > k.len) continue;
      const cy = k.y + Math.sin(dx * 0.05) * 1.5, d = Math.abs(y - cy);
      if (d < k.w * 1.5) { v *= 0.55 + 0.45 * (d / (k.w * 1.5)); h -= 0.8 * (1 - d / (k.w * 1.5)); }
    }
    // silvered weathering: desaturate towards grey
    const g = 0.5 + 0.5 * Math.sin(x * 0.011 + y * 0.03);
    const r = base.r * v, gg = base.g * v, b = base.b * v, l = 0.3 * r + 0.59 * gg + 0.11 * b, w = 0.25 * g;
    const k = (y * W + x) * 4;
    img.data[k] = Math.pow(r + (l - r) * w, 1 / 2.2) * 255;
    img.data[k + 1] = Math.pow(gg + (l - gg) * w, 1 / 2.2) * 255;
    img.data[k + 2] = Math.pow(b + (l - b) * w, 1 / 2.2) * 255;
    img.data[k + 3] = 255;
    hf[y * W + x] = h;
  }
  ctx.putImageData(img, 0, 0);
  return { map: tex(c, { repeat: [1, 4] }, renderer), normalMap: tex(heightToNormal(hf, W, H, 1.2), { srgb: false, repeat: [1, 4] }, renderer) };
}

// ------------------------------------------------------------------ shader patches
/** Wind flutter for canopy fabric, driven by the per-vertex 'aFlex' attribute
 *  (0 rigid .. 1 free hem), phased per instance. */
function windVertex(s) {
  s.uniforms.uTime = U.uTime; s.uniforms.uWindStrength = U.uWindStrength; s.uniforms.uWind = U.uWind;
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aFlex;\nuniform float uTime;\nuniform float uWindStrength;\nuniform vec2 uWind;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
    {
      #if defined( USE_BATCHING )
        vec3 fIp = vec3(batchingMatrix[3][0], batchingMatrix[3][1], batchingMatrix[3][2]);
      #elif defined( USE_INSTANCING )
        vec3 fIp = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 fIp = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
      #endif
      float fPh = dot(fIp.xz, vec2(0.71, 0.53));
      float gust = 0.55 + 0.45 * sin(uTime * 0.63 + fPh * 0.37) * sin(uTime * 0.29 + fPh);
      float fl = sin(uTime * 4.7 + fPh + dot(position.xz, vec2(3.1, 2.3))) * 0.6
               + sin(uTime * 8.3 + fPh * 1.7 + dot(position.xz, vec2(-4.3, 5.1))) * 0.4;
      transformed += objectNormal * aFlex * fl * (0.004 + 0.022 * uWindStrength * gust);
    }`);
}

/** Wind flutter chained onto a library fabric variant (which brings its own translucency). */
function patchWind(m) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (s, r) => { prev && prev.call(m, s, r); windVertex(s); };
  m.customProgramCacheKey = () => `${prevKey ? prevKey.call(m) : ''}|furniture-wind`;
  m.needsUpdate = true;
  return m;
}

/** Own canopy fabric: wind flutter plus diffuse translucency (sun and sky through the cloth). */
function patchFabric(m, translucency) {
  const prev = m.onBeforeCompile;
  m.userData.translucency = { value: translucency };
  m.onBeforeCompile = (s, r) => {
    prev && prev(s, r);
    windVertex(s);
    s.uniforms.fTrans = m.userData.translucency;
    let frag = s.fragmentShader.replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment);
    frag = frag.replace('#include <common>', '#include <common>\nuniform float fTrans;');
    frag = frag.replace('vec3 irradiance = dotNL * directLight.color;',
      `vec3 irradiance = dotNL * directLight.color;
       reflectedLight.directDiffuse += saturate( - dot( geometryNormal, directLight.direction ) ) * directLight.color * BRDF_Lambert( material.diffuseContribution ) * fTrans;`);
    frag = frag.replace('#include <lights_fragment_end>', `{
        vec3 tN = - geometryNormal;
        vec3 tIrr = getAmbientLightIrradiance( ambientLightColor );
        #if ( NUM_HEMI_LIGHTS > 0 )
          for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) tIrr += getHemisphereLightIrradiance( hemisphereLights[ i ], tN );
        #endif
        irradiance += tIrr * fTrans;
        #if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
          iblIrradiance += getIBLIrradiance( tN ) * fTrans;
        #endif
      }
      #include <lights_fragment_end>`);
    s.fragmentShader = frag;
  };
  m.customProgramCacheKey = () => 'furniture-fabric';
  return m;
}

/**
 * Café umbrella canopies (umbrella.js 'aVal', the instance colour carrying brand and LED
 * flags, see cafe.js):
 *  - valance print: the café's brand from the brand atlas, on each side's valance, printed
 *    into the fabric's albedo (seen mirrored and fainter from inside);
 *  - valance sun: the cloth hanging under the canopy edge never takes its sun through its
 *    own canopy's shadow map entry (the hem sits right at the canopy's shadow edge, where
 *    the waves beat against the shadow texels into a comb). Its own canopy's occlusion is
 *    analytic instead: a side whose outside faces away from the sun is in the canopy's
 *    shade, a side facing it is lit (and glows through from inside); the shadow map is
 *    read 0.3 m outside the canopy edge, so buildings, trees and neighbouring canopies
 *    still shade it;
 *  - LED glow: after dusk the strips under the ribs light the canopy's underside (and,
 *    through the cloth, its top a little), brightest along the ribs.
 */
function patchCanopy(m, brandMap, ledLevel) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  const P = BRAND_PRINT;
  m.onBeforeCompile = function (s, r) {
    if (prev) prev.call(this, s, r);
    s.uniforms.fBrandMap = { value: brandMap };
    s.uniforms.fSunW = U.uSunDir;
    s.uniforms.fLedLevel = ledLevel;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aVal;
        varying vec4 vVal;
        varying vec2 vUmb;
        varying vec3 vValOut;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vUmb = vec2( 0.0 );
        #ifdef USE_BATCHING_COLOR
        {
          // brand (red) and LED (green) flags ride on the instance colour as multiples of 4
          vec4 fBc = getBatchingColor( getIndirectIndex( gl_DrawID ) );
          vec2 fFl = floor( fBc.rg * 0.25 );
          vColor.rg *= ( fBc.rg - 4.0 * fFl ) / max( fBc.rg, vec2( 1e-4 ) );
          vUmb = fFl;
        }
        #endif
        vVal = aVal;`)
      .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>
        {
          float fSa = ( aVal.x - 1.0 ) * 1.5707963;
          vec3 fOut = vec3( cos( fSa ), 0.0, sin( fSa ) );
          #ifdef USE_BATCHING
            fOut = mat3( batchingMatrix ) * fOut;
          #endif
          vValOut = normalize( mat3( modelMatrix ) * fOut );
          #if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
            if ( aVal.x > 0.5 ) vSunShadowWorldPosition.xyz += vValOut * 0.3 + vec3( 0.0, 0.04 + aVal.z * ${VALANCE_H.toFixed(3)}, 0.0 );
          #endif
        }`);
    let f = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vVal;
        varying vec2 vUmb;
        varying vec3 vValOut;
        uniform sampler2D fBrandMap;
        uniform vec3 fSunW;
        uniform float fLedLevel;
        float fValSun = 1.0;`)
      .replace('#include <alphamap_fragment>', `{
          // valance print: one strip centred on each side (two on sides over 3.6 m)
          float fIsVal = step( 0.5, vVal.x );
          float fX = vVal.y - ( vVal.w > 3.6 ? sign( vVal.y ) * vVal.w * 0.25 : 0.0 );
          vec2 fC = vec2( fX / ${P[0].toFixed(3)} + 0.5, ( vVal.z * ${VALANCE_H.toFixed(3)} - 0.03 ) / ${P[1].toFixed(3)} );
          float fB = max( vUmb.x - 1.0, 0.0 );
          vec2 fAuv = vec2( ( mod( fB, 2.0 ) + clamp( fC.x, 0.003, 0.997 ) ) * 0.5, 1.0 - ( floor( fB * 0.5 + 0.01 ) + clamp( fC.y, 0.02, 0.98 ) ) * 0.125 );
          vec4 fInk = texture2D( fBrandMap, fAuv );
          float fIn = fIsVal * step( 0.5, vUmb.x ) * step( 0.0, fC.x ) * step( fC.x, 1.0 ) * step( 0.0, fC.y ) * step( fC.y, 1.0 );
          #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
            vec3 fBase = diffuseColor.rgb / max( vColor.rgb, vec3( 1e-3 ) );
          #else
            vec3 fBase = diffuseColor.rgb;
          #endif
          float fWeave = clamp( dot( fBase, vec3( 0.3333 ) ) / 0.62, 0.7, 1.25 );
          diffuseColor.rgb = mix( diffuseColor.rgb, fInk.rgb * fWeave, fInk.a * fIn * ( gl_FrontFacing ? 1.0 : 0.45 ) );
          // valance sun: lit only on a side whose outside faces the sun (see above)
          if ( vVal.x > 0.5 ) fValSun = smoothstep( -0.04, 0.06, dot( vValOut.xz, fSunW.xz ) );
        }
        #include <alphamap_fragment>`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if ( vUmb.y > 0.5 && fLedLevel > 0.0 ) {
          // LED strips under the ribs: the underside glows warm, brightest along the ribs
          float fRib = vVal.x > 0.5 ? 0.15 : exp( - vVal.y / 0.1 ) * smoothstep( 0.06, 0.18, vVal.z ) * ( 1.0 - smoothstep( 0.9, 1.0, vVal.z ) );
          float fUnder = gl_FrontFacing ? ( vVal.x > 0.5 ? 0.2 : 0.1 ) : 1.0;
          totalEmissiveRadiance += diffuseColor.rgb * vec3( 1.0, 0.7, 0.42 ) * fLedLevel * fUnder * ( 0.18 + 1.6 * fRib );
        }`);
    // the valance's own-canopy occlusion gates the sun only (the lamps light it as before)
    if (f.includes('#define RE_Direct RE_Direct_Surf')) {
      f = f.replace('#define RE_Direct RE_Direct_Surf', `#define RE_Direct RE_Direct_Surf
        void RE_Direct_Canopy( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
          IncidentLight fL = directLight;
          if ( fValSun < 1.0 && dot( fL.direction, normalize( ( viewMatrix * vec4( fSunW, 0.0 ) ).xyz ) ) > 0.999 ) fL.color *= fValSun;
          RE_Direct_Surf( fL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Canopy`);
    }
    s.fragmentShader = f;
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-canopy`; };
  m.needsUpdate = true;
  return m;
}

/** Radial falloff for the warm light pool under a lit canopy (linear data). */
function poolTexture(renderer) {
  const N = 128, c = canvas(N, N), ctx = c.getContext('2d'), img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N * 2 - 1, v = (y + 0.5) / N * 2 - 1;
    // a soft square-ish pool (the canopy is square), brightest under the middle of each half
    const r = Math.pow(Math.pow(Math.abs(u), 3) + Math.pow(Math.abs(v), 3), 1 / 3);
    const k = Math.max(0, 1 - sm(0.35, 1.0, r)) * (0.85 + 0.15 * Math.cos(r * 3));
    const i = (y * N + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * k * k); img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = tex(c, { srgb: false, aniso: 4 }, renderer);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Clear glass: reflections are kept at full strength while the body transmits
 *  (premultiplied output: diffuse * alpha + specular). */
function patchGlass(m) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    prev && prev(s, r);
    s.fragmentShader = s.fragmentShader.replace('#include <opaque_fragment>',
      `gl_FragColor = vec4( totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance, diffuseColor.a );`);
  };
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.customProgramCacheKey = () => 'furniture-glass';
  return m;
}

/** Ground-contact grime and occlusion for instanced furniture (prototypes have their
 *  origin on the paving, so the object-space height is the height above the ground):
 *  darker, rougher and occluded in the bottom ~0.2 m, plus low-frequency mottling. */
function patchGrime(m, { albedo = 0.16, rough = 0.15, ao = 0.45, mottle = 0.05 } = {}) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.userData.grime = { value: new THREE.Vector4(albedo, rough, ao, mottle) };
  m.onBeforeCompile = function (s, r) {
    prev && prev.call(this, s, r);
    s.uniforms.fGrime = m.userData.grime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFurnP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFurnP = position;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFurnP;
        uniform vec4 fGrime;
        float fHash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float fNoise3(vec3 x) {
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(fHash3(i), fHash3(i + vec3(1,0,0)), f.x), mix(fHash3(i + vec3(0,1,0)), fHash3(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(fHash3(i + vec3(0,0,1)), fHash3(i + vec3(1,0,1)), f.x), mix(fHash3(i + vec3(0,1,1)), fHash3(i + vec3(1,1,1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float fLow = 1.0 - smoothstep(0.0, 0.2, vFurnP.y);
        float fMot = fNoise3(vFurnP * vec3(7.0, 2.5, 7.0)) * 0.6 + fNoise3(vFurnP * 23.0) * 0.4;
        diffuseColor.rgb *= (1.0 - fGrime.x * fLow * (0.6 + 0.6 * fMot)) * (1.0 + fGrime.w * (fMot - 0.5) * 2.0);`)
      .replace('#include <normal_fragment_begin>', `roughnessFactor = min(1.0, roughnessFactor + fGrime.y * fLow);
        #include <normal_fragment_begin>`)
      .replace('vec3 totalDiffuse =', `reflectedLight.indirectDiffuse *= 1.0 - fGrime.z * (1.0 - smoothstep(0.0, 0.12, vFurnP.y));
        reflectedLight.indirectSpecular *= 1.0 - 0.6 * fGrime.z * (1.0 - smoothstep(0.0, 0.12, vFurnP.y));
        vec3 totalDiffuse =`);
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-grime`; };
  m.needsUpdate = true;
  return m;
}

/**
 * Platform slabs (uv in metres: u along the platform, v = route offset; 0.4 m stack-bond
 * slabs on the metre grid): every slab its own tone (cv ~0.05) and a faint hue, a few
 * flattened chewing-gum spots (more where the paving is trodden: the vertex colour carries
 * the door-lane darkening), joints of varying width and darkness, and a smoother, slightly
 * polished finish in the trodden lanes. Detail fades out before it would alias.
 */
function patchPlatformPaving(m) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (s, r) {
    prev && prev.call(this, s, r);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPlatUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlatUv = uv;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vPlatUv;
        float platH(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
        float platWear = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vPlatUv / 0.4, si = floor(q), sf = fract(q);
          float px = max(max(fwidth(vPlatUv.x), fwidth(vPlatUv.y)), 1e-5);
          float near = 1.0 - smoothstep(0.004, 0.014, px);   // mm detail
          float slabV = 1.0 - smoothstep(0.06, 0.2, px);      // slab-sized detail
          #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
            platWear = clamp((1.0 - vColor.g) / 0.13, 0.0, 1.0);
          #endif
          float h1 = platH(si), h2 = platH(si + 17.3), h3 = platH(si + 41.9);
          // slab tone and hue
          float tone = 1.0 + (h1 - 0.5) * 0.17 + (h3 > 0.93 ? -0.07 : 0.0);
          diffuseColor.rgb *= mix(vec3(1.0), tone * vec3(1.0 + (h2 - 0.5) * 0.035, 1.0, 1.0 - (h2 - 0.5) * 0.035), slabV);
          // joints: each edge its own width (2-5 mm of dark grit) and darkness
          vec2 e0 = sf * 0.4, e1 = (1.0 - sf) * 0.4;
          float wL = mix(0.0015, 0.0045, platH(si + vec2(0.0, 5.5))), wR = mix(0.0015, 0.0045, platH(si + vec2(1.0, 5.5)));
          float wB = mix(0.0015, 0.0045, platH(si + vec2(9.5, 0.0))), wT = mix(0.0015, 0.0045, platH(si + vec2(9.5, 1.0)));
          float jx = max(1.0 - smoothstep(wL - px, wL + px, e0.x), 1.0 - smoothstep(wR - px, wR + px, e1.x));
          float jy = max(1.0 - smoothstep(wB - px, wB + px, e0.y), 1.0 - smoothstep(wT - px, wT + px, e1.y));
          float jd = mix(0.45, 0.8, h2);
          diffuseColor.rgb *= 1.0 - jd * 0.5 * max(jx, jy) * near;
          // chewing gum: flattened grey-black discs, 8-15 mm, a few per slab (more trodden)
          float gum = 0.0;
          for (int k = 0; k < 3; k++) {
            vec2 hk = si + vec2(float(k) * 3.7, 11.0);
            float pr = platH(hk);
            if (pr > 0.16 + 0.5 * platWear) continue;
            vec2 c = vec2(platH(hk + 1.3), platH(hk + 2.9)) * 0.86 + 0.07;
            float rr = mix(0.008, 0.015, platH(hk + 4.1));
            float d = length((sf - c) * 0.4 * vec2(1.0, mix(0.8, 1.2, platH(hk + 5.3))));
            gum = max(gum, (1.0 - smoothstep(rr - px, rr + px, d)) * mix(0.55, 0.9, platH(hk + 6.7)));
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.055, 0.053, 0.05), gum * near);
        }`)
      .replace('#include <normal_fragment_begin>', `roughnessFactor *= 1.0 - 0.18 * platWear;
        #include <normal_fragment_begin>`);
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-platform1`; };
  m.needsUpdate = true;
  return m;
}

/**
 * Weathering of the stone bollards (on top of the library stone): a ragged dirt and splash
 * band at the foot (10-15 cm, darker and rougher, speckled), rain streaks running down from
 * the cap, a dusty top and a mottle; every post gets its own pattern from its position.
 */
function patchBollard(m) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (s, r) {
    prev && prev.call(this, s, r);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBolP;\nvarying vec2 vBolI;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBolP = position;
        #ifdef USE_BATCHING
          vBolI = batchingMatrix[ 3 ].xz;
        #else
          vBolI = vec2( 0.0 );
        #endif`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBolP;
        varying vec2 vBolI;
        float bHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
        float bNoise( vec3 x ) {
          vec3 i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( mix( bHash( i ), bHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( bHash( i + vec3( 0, 1, 0 ) ), bHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                      mix( mix( bHash( i + vec3( 0, 0, 1 ) ), bHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( bHash( i + vec3( 0, 1, 1 ) ), bHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float bRough = 0.0;
        {
          vec3 o = vec3( vBolI.x * 1.7, 0.0, vBolI.y * 1.3 );
          float n1 = bNoise( vBolP * 9.0 + o ), n2 = bNoise( vBolP * 37.0 + o * 2.0 ), n3 = bNoise( vBolP * 3.0 + o );
          // splash band: ragged top edge at 10-15 cm, speckled with grit
          float band = 1.0 - smoothstep( 0.08, 0.13 + 0.05 * n1, vBolP.y );
          float grit = step( 0.72, n2 ) * smoothstep( 0.3, 0.1, vBolP.y );
          // rain streaks from the cap down the faces, fading towards the foot
          float st = bNoise( vec3( ( vBolP.x + vBolP.z ) * 34.0 + o.x, vBolP.y * 2.0, ( vBolP.x - vBolP.z ) * 34.0 + o.z ) );
          float streak = smoothstep( 0.58, 0.9, st ) * smoothstep( 0.12, 0.45, vBolP.y ) * ( 1.0 - smoothstep( 0.52, 0.56, vBolP.y ) );
          float dust = smoothstep( 0.54, 0.6, vBolP.y ) * 0.08;
          diffuseColor.rgb *= ( 1.0 - band * ( 0.4 + 0.2 * n1 ) ) * ( 1.0 - 0.18 * grit ) * ( 1.0 - 0.2 * streak ) * ( 0.9 + 0.2 * n3 ) * ( 1.0 - dust );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.0, 0.95, 0.86 ), band * 0.5 );
          bRough = band * 0.12;
        }`)
      .replace('#include <normal_fragment_begin>', `roughnessFactor = min( 1.0, roughnessFactor + bRough );
        #include <normal_fragment_begin>`)
      .replace('vec3 totalDiffuse =', `reflectedLight.indirectDiffuse *= mix( 0.6, 1.0, smoothstep( 0.0, 0.1, vBolP.y ) );
        vec3 totalDiffuse =`);
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-bollard`; };
  m.needsUpdate = true;
  return m;
}

/** Wrapped diffuse for thin pale plastics (light reaches a little past the terminator). */
function patchWrap(m, w) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (s, r) {
    prev && prev.call(this, s, r);
    s.fragmentShader = s.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment)
      // diffuse only: the specular term keeps the plain dotNL (it blows up at silhouettes)
      .replace('vec3 irradiance = dotNL * directLight.color;',
        `vec3 irradiance = dotNL * directLight.color;
        float fWrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + ${w.toFixed(3)} ) / ${(1 + w).toFixed(3)} );
        reflectedLight.directDiffuse += max( fWrapNL - dotNL, 0.0 ) * directLight.color * BRDF_Lambert( material.diffuseContribution );`);
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-wrap`; };
  m.needsUpdate = true;
  return m;
}

/** Emissive radiance scaled by a uniform the module drives every frame (see updateLightLevels). */
function patchEmissiveLevel(m, uniform, key) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    prev && prev(s, r);
    s.uniforms.fEmLevel = uniform;
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float fEmLevel;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= fEmLevel;');
  };
  m.customProgramCacheKey = () => `furniture-emlevel-${key}`;
  return m;
}

/** Posters (the atlas's top row of eight, see prints.js): each instance shows its own
 *  ones, the row rotated by a hash of the instance position, so neighbouring shelters and
 *  kiosks never advertise the same thing. Other prints on the same atlas are untouched. */
function patchPosterPick(m) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (s, r) {
    if (prev) prev.call(this, s, r);
    s.vertexShader = s.vertexShader.replace('#include <uv_vertex>', `
      vec2 fPosterUv = uv;
      #ifdef USE_BATCHING
        if ( fPosterUv.y > ${(1 - LIT_ROWS / ATLAS_H + 1e-3).toFixed(4)} ) {
          vec2 fPos = floor( getBatchingMatrix( getIndirectIndex( gl_DrawID ) )[ 3 ].xz * 2.0 );
          float fH = fract( 52.9829189 * fract( dot( fPos, vec2( 0.06711056, 0.00583715 ) ) ) );
          fPosterUv.x = fract( fPosterUv.x + floor( fH * 8.0 ) * 0.125 );
        }
      #endif
      #undef MAP_UV
      #define MAP_UV fPosterUv
      #undef EMISSIVEMAP_UV
      #define EMISSIVEMAP_UV fPosterUv
      #include <uv_vertex>`);
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-poster`; };
  m.needsUpdate = true;
  return m;
}

/** Shelter glazing: thin clear glass whose coverage rises towards grazing angles (Fresnel),
 *  plus a decal map (safety dots, dust, water spots) that is diffuse and rougher. The
 *  output is premultiplied: reflections are never attenuated by the low opacity. */
function patchShelterGlass(m) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    prev && prev(s, r);
    s.fragmentShader = s.fragmentShader
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.55, diffuseColor.a );')
      .replace('#include <opaque_fragment>', `{
        float fNV = saturate( dot( normal, normalize( vViewPosition ) ) );
        float fCov = diffuseColor.a;
        float fFr = 0.05 + 0.8 * pow( 1.0 - fNV, 5.0 );
        gl_FragColor = vec4( totalDiffuse * fCov + totalSpecular * ( 1.0 - 0.5 * fCov ), clamp( fCov + ( 1.0 - fCov ) * fFr, 0.0, 1.0 ) );
      }`);
  };
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.customProgramCacheKey = () => 'furniture-shelter-glass';
  return m;
}

/** The material's envMapIntensity, applied to its indirect specular. three replaces
 *  envMapIntensity by scene.environmentIntensity whenever the environment comes from
 *  scene.environment (as here), so a per-material level only works through the shader,
 *  the same way the materials library applies it. */
function patchEnvSpec(m) {
  if (m.userData.furnitureEnvSpec) return m;
  m.userData.furnitureEnvSpec = true;
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (s, r) {
    if (prev) prev.call(this, s, r);
    s.uniforms.fEnvSpec = { get value() { return m.envMapIntensity; } };
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float fEnvSpec;')
      .replace('vec3 totalDiffuse =', `reflectedLight.indirectSpecular *= fEnvSpec;
        vec3 totalDiffuse =`);
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-envspec`; };
  m.needsUpdate = true;
  return m;
}

/** Paper wrinkles and glue bubbles for posters glued on advertising columns. */
function paperNormal(renderer) {
  const N = 256, rng = RNG.from('paper');
  const hf = new Float32Array(N * N);
  for (let i = 0; i < 70; i++) { // bubbles
    const cx = rng.next() * N, cy = rng.next() * N, rx = rng.range(4, 18), ry = rng.range(3, 12), a = rng.range(0.3, 1);
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
      const d = (x / rx) ** 2 + (y / ry) ** 2;
      if (d < 1) hf[(((cy + y) | 0) + N) % N * N + ((((cx + x) | 0) % N) + N) % N] += a * (1 - d);
    }
  }
  for (let i = 0; i < 30; i++) { // creases
    let x = rng.next() * N, y = rng.next() * N;
    const dx = rng.range(-1, 1), dy = rng.range(-1, 1), l = Math.hypot(dx, dy) || 1, len = rng.range(10, 60);
    for (let t = 0; t < len; t++) { hf[((y | 0) % N + N) % N * N + ((x | 0) % N + N) % N] -= 0.6; x += dx / l; y += dy / l; }
  }
  return tex(heightToNormal(hf, N, N, 1.4), { srgb: false, repeat: [12, 6] }, renderer);
}

// ------------------------------------------------------------------ print atlases
/** Texture for an atlas whose image arrives later (canvas texture settings, clamped). */
function atlasTexture({ repeat = null, aniso = 8 }, renderer) {
  const t = new THREE.Texture();
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = Math.min(aniso, renderer?.capabilities.getMaxAnisotropy() || 1);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Paint the print atlas and the lit atlas (prints.js) in a module worker and give them to
 *  the two textures when they arrive. Returns {done, finish()}: finish() paints them here
 *  at once if the worker has not delivered yet (or failed), so the textures never get
 *  their images (and uploads) after the first frame. */
function paintPrintAtlases(printMap, litMap, tm) {
  const t0 = performance.now();
  const job = { done: false, finish: null };
  let w = null;
  const set = (t, image, flipY) => { t.image = image; t.flipY = flipY; t.needsUpdate = true; };
  const local = () => {
    if (job.done) return;
    job.done = true;
    if (w) { w.terminate(); w = null; }
    const t1 = performance.now();
    const a = buildPrintAtlas();
    set(printMap, a.canvas, true);
    set(litMap, buildLitAtlas(a.canvas), true);
    tm.atlas = +(performance.now() - t1).toFixed(1);
  };
  job.finish = local;
  try {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') { local(); return job; }
    w = new Worker(new URL('./printWorker.js', import.meta.url), { type: 'module' });
  } catch (e) { local(); return job; }
  w.onmessage = (e) => {
    if (job.done) return;
    const d = e.data;
    if (!d || d.error || !d.atlas || !d.lit) {
      console.warn('[furniture] print atlas worker failed, painting here:', d && d.error);
      local();
      return;
    }
    job.done = true;
    w.terminate(); w = null;
    // the bitmaps come flipped (a bitmap ignores the GL's flipY)
    set(printMap, d.atlas, false);
    set(litMap, d.lit, false);
    tm.atlasWorker = d.ms;
    tm.atlasWall = +(performance.now() - t0).toFixed(1);
  };
  w.onerror = (e) => { e.preventDefault?.(); local(); };
  w.postMessage({});
  return job;
}

// ------------------------------------------------------------------ library
export function createMaterials(app) {
  const M = app.materials, R = app.renderer;
  const out = {};
  const tm = (out.times = {});
  const T = (k, f) => { const t0 = performance.now(); const r = f(); tm[k] = +(performance.now() - t0).toFixed(1); return r; };
  const reg = (name, m) => { m.name = `furniture.${name}`; M.register(`furniture.${name}`, m); out[name] = m; return m; };
  const names = new Set(M.names ? M.names() : []);
  // library materials whose vertex colour is the albedo take the per-instance colour
  const albedoVariant = (name, extra = {}) => (names.has(name) && M.meta?.[name]?.vertexColor === 'albedo' ? M.get(name, { vertexColors: true, ...extra }) : null);
  // furniture-only variant of a library material (own clone, so our patches stay local)
  const variant = (name, extra = {}) => M.get(name, { userData: { furniture: name }, ...extra });

  // canopy fabric (umbrellas, awnings): library canvas (weave, sheen, translucency),
  // coloured by vertex × instance colour, plus wind flutter
  const libFabric = albedoVariant('fabric.umbrella', { userData: { furnitureWind: 1 } });
  if (libFabric) { patchWind(libFabric); out.canopy = libFabric; } else {
    const canopy = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, vertexColors: true });
    reg('canopy', patchFabric(canopy, 0.32));
  }
  // light levels (scene-linear radiance) the module sets every frame from the exposure
  out.levels = { lit: { value: 0.03 }, disp: { value: 0.3 }, lamp: { value: 0 }, led: { value: 0 }, board: { value: 0 } };
  // café umbrellas: valance prints (brand atlas), the valance's own-canopy shading and the
  // LED glow after dusk (patchCanopy); the LED strips and the warm pool on the paving
  const brandMap = tex(T('brands', () => buildBrandAtlas()), { aniso: 8 }, R);
  brandMap.wrapS = brandMap.wrapT = THREE.ClampToEdgeWrapping;
  patchCanopy(out.canopy, brandMap, out.levels.led);
  reg('umbLed', patchEmissiveLevel(new THREE.MeshStandardMaterial({ color: srgb('#d9d6cf'), roughness: 0.45, metalness: 0, emissive: new THREE.Color(1.0, 0.7, 0.42), emissiveIntensity: 4 }), out.levels.led, 'led'));
  {
    const m = reg('umbPool', new THREE.MeshBasicMaterial({ map: poolTexture(R), color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4;
    m.visible = false;
  }
  // seat cushions and wind-screen panels: canvas coloured per instance
  out.cushion = albedoVariant('fabric.awning', { userData: { furniture: 'cushion' }, side: THREE.FrontSide }) || reg('cushion', new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  patchGrime(out.cushion, { albedo: 0.08, rough: 0.05, ao: 0.3, mottle: 0.04 });
  out.canvasPanel = albedoVariant('fabric.awning', { userData: { furniture: 'screen' } }) || reg('canvasPanel', new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide }));

  out.weave = WEAVES.map((w, i) => {
    const t = T(`weave${i}`, () => weaveTextures(w, R));
    return patchGrime(reg(`weave${i}`, new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.58, metalness: 0 })), { mottle: 0.03 });
  });
  {
    const t = T('wicker', () => wickerTextures(R));
    patchGrime(reg('wicker', new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.6, metalness: 0 })), { mottle: 0.03 });
  }
  patchGrime(reg('rattan', new THREE.MeshStandardMaterial({ map: T('rattan', () => rattanTexture(R)), roughness: 0.5, metalness: 0 })), { mottle: 0.02 });
  // moulded polypropylene shell chairs, coloured per instance: satin with a faint clear coat
  patchGrime(patchWrap(reg('plastic', new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.38, metalness: 0, clearcoat: 0.1, clearcoatRoughness: 0.3,
    normalMap: T('stipple', () => stippleNormal(R)), normalScale: new THREE.Vector2(0.35, 0.35),
  })), 0.15), { albedo: 0.06, rough: 0.1, mottle: 0.02 });
  // painted metal (bins, kiosk, columns, painted chairs), coloured per instance: satin paint
  out.paint = albedoVariant('metal.pole', { userData: { furniture: 'paint' }, roughness: 0.62 }) || reg('paint', new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0 }));
  patchGrime(out.paint, { albedo: 0.2, rough: 0.12, mottle: 0.05 });
  out.iron = patchGrime(variant('metal.iron'), { albedo: 0.15, rough: 0.1, mottle: 0.04 });
  // furniture-owned variants of other library surfaces (patched locally: grime, LOD fade)
  out.rubber = variant('rubber');
  out.galv = patchGrime(variant('metal.galvanized'), { albedo: 0.12, rough: 0.1, mottle: 0.04 });
  out.steel = variant('metal.steel');
  out.stone = patchGrime(variant('stone.smooth'), { albedo: 0.18, rough: 0.05, ao: 0.5, mottle: 0.06 });
  out.bollardStone = patchBollard(variant('stone.smooth', { userData: { furniture: 'bollard' } }));
  reg('interior', new THREE.MeshStandardMaterial({ color: srgb('#1e1d1b'), roughness: 0.9, metalness: 0 }));
  reg('pages', new THREE.MeshStandardMaterial({ color: srgb('#e4dfd3'), roughness: 0.75, metalness: 0 }));
  out.pole = patchGrime(variant('metal.pole'), { albedo: 0.15, rough: 0.1, mottle: 0.04 });
  out.concrete = patchGrime(variant('concrete'), { albedo: 0.2, rough: 0.05, ao: 0.55, mottle: 0.06 });
  // brushed aluminium (chairs, tables, frames); the env reflection is kept moderate
  const brushed = T('brushed', () => brushedNormal(R));
  patchEnvSpec(patchGrime(reg('aluminium', new THREE.MeshStandardMaterial({ color: srgb('#c9cacb'), roughness: 0.45, metalness: 1, normalMap: brushed, normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 0.75 })), { albedo: 0.12, rough: 0.1, mottle: 0.03 }));
  // umbrella frames live under the canopy: little sky reaches them
  patchEnvSpec(patchGrime(reg('umbFrame', new THREE.MeshStandardMaterial({ color: srgb('#c4c5c6'), roughness: 0.5, metalness: 1, normalMap: brushed, normalScale: new THREE.Vector2(0.2, 0.2), envMapIntensity: 0.3 })), { albedo: 0.05, rough: 0.05, ao: 0.2, mottle: 0.02 }));
  {
    const t = T('timber', () => timberTextures(R));
    patchGrime(reg('timber', new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.82, metalness: 0 })), { albedo: 0.15, rough: 0.08, mottle: 0.05 });
  }
  // stone / compact laminate table tops (tinted per instance)
  reg('tabletop', new THREE.MeshStandardMaterial({ map: T('speckle', () => speckleTexture(R)), roughness: 0.32, metalness: 0 }));
  reg('ceramic', new THREE.MeshStandardMaterial({ color: srgb('#f1efe9'), roughness: 0.18, metalness: 0 }));
  reg('coffee', new THREE.MeshStandardMaterial({ color: srgb('#3a2214'), roughness: 0.25, metalness: 0 }));
  reg('drinkGlass', patchGlass(new THREE.MeshStandardMaterial({ color: srgb('#e3ece9'), roughness: 0.03, metalness: 0, opacity: 0.12 })));
  if (names.has('paving.tactile')) out.tactile = M.get('paving.tactile'); else {
    const t = tactileTextures(R);
    reg('tactile', new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.82, metalness: 0 }));
  }
  // platform: cut limestone coping (per-block tint in vertex colours), mortar, paving
  // (own variant, same program: the shared one is also drawn batched by other modules, and
  // a material switching between batched and plain meshes is re-evaluated at every switch)
  out.copingStone = M.get('stone.smooth', { vertexColors: true, userData: { furniture: 'coping' } });
  out.mortar = M.get('concrete', { color: [0.3, 0.29, 0.28], userData: { furniture: 'mortar' } });
  // platform slabs: toned to the sidewalk granite (a touch lighter, not the warm cream of
  // the bare library slab), per-slab tone, gum, worn door lanes (vertex colours), joints
  out.platformPaving = patchPlatformPaving(M.get('paving.platform', { vertexColors: true, color: [0.6, 0.615, 0.68], userData: { furniture: 'platform' } }));
  out.bandStone = M.get('stone.smooth', { color: [0.42, 0.42, 0.41], userData: { furniture: 'band' } });
  // shelter glazing with its decal, and the green-tinted glass edges
  {
    const decal = tex(T('decal', () => buildGlassDecal()), { repeat: [1, 0.25], aniso: 8 }, R);
    // (the reflection level works through patchEnvSpec; a little over 1, since the
    // environment's street canyon is darker than the sunlit street the glass faces)
    patchEnvSpec(reg('shelterGlass', patchShelterGlass(new THREE.MeshStandardMaterial({ color: srgb('#e6e8e2'), map: decal, roughness: 0.05, metalness: 0, envMapIntensity: 1.2 }))));
    patchEnvSpec(reg('glassEdge', new THREE.MeshStandardMaterial({ color: srgb('#6f9a8a'), roughness: 0.1, metalness: 0, transparent: true, opacity: 0.6, depthWrite: false, envMapIntensity: 1.2 })));
  }
  // the print atlas and its lit copy are painted in a worker while the start-up goes on;
  // the module's first update finishes them here if they have not arrived (out.prints)
  const printMap = atlasTexture({ aniso: 16 }, R);
  const litMap = atlasTexture({ repeat: [1, ATLAS_H / LIT_ROWS], aniso: 8 }, R);
  litMap.offset.set(0, -(1 - LIT_ROWS / ATLAS_H) * (ATLAS_H / LIT_ROWS));
  out.prints = paintPrintAtlases(printMap, litMap, tm);
  // prints sit a few millimetres proud of their panels; polygon offset keeps them clear
  // of the panel in the depth buffer at any distance
  const decalOffset = (m) => { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4; return m; };
  patchPosterPick(decalOffset(reg('print', new THREE.MeshStandardMaterial({ map: printMap, roughness: 0.55, metalness: 0 }))));
  // posters glued on advertising columns: paper with wrinkles and bubbles
  decalOffset(reg('paper', new THREE.MeshStandardMaterial({ map: printMap, roughness: 0.68, metalness: 0, normalMap: T('paper', () => paperNormal(R)), normalScale: new THREE.Vector2(0.18, 0.18) })));
  // parked vehicles: clear-coated paint (solid and metallic, coloured per instance, road
  // dirt low down), dark tinted glazing over dark interiors, black plastic trim, alloy
  // wheels (brake dust), lamp lenses (vertex colours) and the contact shadow decal
  patchGrime(reg('carPaint', new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.07 })), { albedo: 0.3, rough: 0.2, ao: 0.3, mottle: 0.03 });
  patchGrime(reg('carMetal', new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.06 })), { albedo: 0.3, rough: 0.2, ao: 0.3, mottle: 0.03 });
  patchEnvSpec(reg('carGlass', new THREE.MeshStandardMaterial({ color: srgb('#262a2e'), roughness: 0.04, metalness: 0, envMapIntensity: 1.3 })));
  patchGrime(reg('carTrim', new THREE.MeshStandardMaterial({ color: srgb('#151617'), roughness: 0.62, metalness: 0 })), { albedo: 0.1, rough: 0.1, mottle: 0.04 });
  patchEnvSpec(patchGrime(reg('carAlloy', new THREE.MeshStandardMaterial({ color: srgb('#8f9295'), roughness: 0.4, metalness: 1, envMapIntensity: 0.7 })), { albedo: 0.3, rough: 0.15, mottle: 0.05 }));
  reg('carLamp', new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.12, metalness: 0 }));
  {
    const m = reg('contactShadow', new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: contactShadowTexture(), transparent: true, opacity: 0.5, depthWrite: false }));
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4;
  }
  // backlit advert panels: laminate over a light box (emission from the lit atlas)
  patchPosterPick(decalOffset(reg('printLit', patchEmissiveLevel(new THREE.MeshStandardMaterial({ map: printMap, emissiveMap: litMap, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.25, metalness: 0 }), out.levels.lit, 'lit'))));
  // LED passenger displays and touch screens (auto-dimmed like real ones)
  const disp = T('display', () => buildDisplayAtlas());
  out.display = disp;
  const dispMap = tex(disp.canvas, { repeat: [1, 1], aniso: 8 }, R);
  dispMap.wrapS = dispMap.wrapT = THREE.ClampToEdgeWrapping;
  decalOffset(reg('display', patchEmissiveLevel(new THREE.MeshStandardMaterial({ color: 0x050505, emissiveMap: dispMap, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.25, metalness: 0 }), out.levels.disp, 'disp')));
  // shelter / platform light diffusers (on from dusk)
  reg('light', patchEmissiveLevel(new THREE.MeshStandardMaterial({ color: srgb('#e8e6e0'), emissive: srgb('#fff1d6'), emissiveIntensity: 1, roughness: 0.3, metalness: 0 }), out.levels.lamp, 'lamp'));
  return out;
}

/** Light levels from the camera exposure: light boxes and screens behave like auto-dimmed
 *  real ones (never clipping at dusk), luminaires switch on with the night. */
export function updateLightLevels(F, app, ready = true) {
  const env = app.env, exp = Math.max(env?.exposure || 1.15, 1e-3), t = env?.state?.t ?? 0;
  const on = THREE.MathUtils.smoothstep(t, 0.68, 0.95);
  // light boxes by day sit near the brightness of the shade round them (the print, a
  // little lit from behind); the backlight comes up with the evening
  F.levels.lit.value = Math.min(0.03, 0.75 / exp) * (0.1 + 0.9 * on);
  F.levels.disp.value = Math.min(0.5, 0.3 / exp);
  F.levels.lamp.value = on * 5 / exp;
  // café umbrella LEDs come on soon after sunset (switched by the staff, not a photocell)
  const night = U.uNight.value, gain = app.materials?.uniforms?.emissiveGain?.value ?? 1;
  const led = THREE.MathUtils.smoothstep(night, 0.15, 0.45) * gain / exp;
  F.levels.led.value = led;
  const pool = F.umbPool;
  if (pool) {
    pool.visible = led > 1e-4 || !ready;  // (drawn behind the loading screen for its first draw)
    pool.color.setRGB(1.0, 0.7, 0.42).multiplyScalar(0.22 * led);
  }
}
