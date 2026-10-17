import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { U } from '../../core/uniforms.js';
import { buildPrintAtlas, buildDisplayAtlas } from './prints.js';

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
  const base = srgb('#a27a4c');
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const j = (y / S) | 0, fy = (y % S + 0.5) / S;
    const si = (x / stake) | 0, fx = (x % stake + 0.5) / stake;
    const over = (si + j) % 2 === 0;
    const bulge = over ? Math.sin(Math.PI * fx) : 0.2 + 0.25 * (1 - Math.cos(Math.PI * 2 * fx)) * 0.5;
    const prof = Math.pow(Math.sin(Math.PI * fy), 0.6);
    const gap = sm(0, 0.16, fy) * sm(1, 0.84, fy);
    const stakeVis = !over && Math.abs(fx - 0.5) < 0.16 ? 1 : 0; // stake shows where the weaver dives
    const streak = 0.9 + 0.1 * Math.sin(x * 0.7 + j * 7.1) * Math.sin(x * 0.13 + j);
    let shade = (0.35 + 0.65 * prof * (0.5 + 0.5 * bulge)) * (0.12 + 0.88 * gap) * rowJ[j % 64] * streak;
    if (stakeVis) shade *= 0.55;
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
  g.addColorStop(0, '#866243'); g.addColorStop(0.5, '#a88660'); g.addColorStop(1, '#866243');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // fine longitudinal fibres
  for (let i = 0; i < 160; i++) {
    ctx.strokeStyle = `rgba(${rng.chance(0.5) ? '70,40,20' : '220,180,120'},${0.05 + rng.next() * 0.08})`;
    ctx.lineWidth = 0.5 + rng.next();
    const x = rng.next() * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + rng.range(-2, 2), H); ctx.stroke();
  }
  // burnt "tortoiseshell" blotches typical of bistro frames
  for (let i = 0; i < 26; i++) {
    const x = rng.next() * W, y = rng.next() * H, r = rng.range(3, 9), l = rng.range(12, 40);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, l);
    gr.addColorStop(0, `rgba(48,26,12,${0.55 + rng.next() * 0.3})`); gr.addColorStop(1, 'rgba(48,26,12,0)');
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

/** Emissive that follows the night factor: k0 by day, k1 at night. */
function patchNightEmissive(m, k0, k1) {
  const prev = m.onBeforeCompile;
  m.userData.nightK = { value: new THREE.Vector2(k0, k1) };
  m.onBeforeCompile = (s, r) => {
    prev && prev(s, r);
    s.uniforms.uNight = U.uNight; s.uniforms.fNightK = m.userData.nightK;
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform vec2 fNightK;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= mix( fNightK.x, fNightK.y, uNight );');
  };
  m.customProgramCacheKey = () => `furniture-night-${k0}-${k1}`;
  return m;
}

// ------------------------------------------------------------------ library
export function createMaterials(app) {
  const M = app.materials, R = app.renderer;
  const out = {};
  const reg = (name, m) => { m.name = `furniture.${name}`; M.register(`furniture.${name}`, m); out[name] = m; return m; };
  // library materials whose vertex colour is the albedo take the per-instance colour
  const names = new Set(M.names ? M.names() : []);
  const albedoVariant = (name, extra = {}) => (names.has(name) && M.meta?.[name]?.vertexColor === 'albedo' ? M.get(name, { vertexColors: true, ...extra }) : null);

  // canopy fabric (umbrellas, canopies, awnings): library canvas when available, coloured
  // by vertex × instance colour, plus wind flutter
  const libFabric = albedoVariant('fabric.umbrella', { userData: { furnitureWind: 1 } });
  if (libFabric) { patchWind(libFabric); out.canopy = libFabric; } else {
    const canopy = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, vertexColors: true });
    reg('canopy', patchFabric(canopy, 0.32));
  }

  out.weave = WEAVES.map((w, i) => {
    const t = weaveTextures(w, R);
    return reg(`weave${i}`, new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.58, metalness: 0 }));
  });
  {
    const t = wickerTextures(R);
    reg('wicker', new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.78, metalness: 0 }));
  }
  reg('rattan', new THREE.MeshStandardMaterial({ map: rattanTexture(R), roughness: 0.5, metalness: 0 }));
  // polypropylene shell chairs and painted metal, coloured per instance
  out.plastic = albedoVariant('plastic.chair') || reg('plastic', new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.48, metalness: 0 }));
  out.paint = albedoVariant('metal.pole') || reg('paint', new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0 }));
  // brushed aluminium (chairs, table rims)
  reg('aluminium', new THREE.MeshStandardMaterial({ color: srgb('#cfd2d4'), roughness: 0.36, metalness: 1 }));
  // stone / compact laminate table tops (tinted per instance)
  reg('tabletop', new THREE.MeshStandardMaterial({ map: speckleTexture(R), roughness: 0.32, metalness: 0 }));
  reg('ceramic', new THREE.MeshStandardMaterial({ color: srgb('#f1efe9'), roughness: 0.18, metalness: 0 }));
  reg('coffee', new THREE.MeshStandardMaterial({ color: srgb('#3a2214'), roughness: 0.25, metalness: 0 }));
  out.glass = names.has('glass.clear') ? M.get('glass.clear')
    : reg('glass', patchGlass(new THREE.MeshStandardMaterial({ color: srgb('#c9d6d2'), roughness: 0.04, metalness: 0, opacity: 0.16 })));
  reg('drinkGlass', patchGlass(new THREE.MeshStandardMaterial({ color: srgb('#e3ece9'), roughness: 0.03, metalness: 0, opacity: 0.12 })));
  if (names.has('paving.tactile')) out.tactile = M.get('paving.tactile'); else {
    const t = tactileTextures(R);
    reg('tactile', new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.82, metalness: 0 }));
  }
  const atlas = buildPrintAtlas(R);
  out.atlas = atlas;
  const printMap = tex(atlas.canvas, { repeat: [1, 1], aniso: 16 }, R);
  printMap.wrapS = printMap.wrapT = THREE.ClampToEdgeWrapping;
  reg('print', new THREE.MeshStandardMaterial({ map: printMap, roughness: 0.55, metalness: 0 }));
  // backlit advert panels: lit through the print at night
  reg('printLit', patchNightEmissive(new THREE.MeshStandardMaterial({ map: printMap, emissiveMap: printMap, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.2, metalness: 0 }), 0.05, 0.1));
  // LED passenger displays and screens: always on
  const disp = buildDisplayAtlas();
  out.display = disp;
  const dispMap = tex(disp.canvas, { repeat: [1, 1], aniso: 8 }, R);
  dispMap.wrapS = dispMap.wrapT = THREE.ClampToEdgeWrapping;
  reg('display', patchNightEmissive(new THREE.MeshStandardMaterial({ color: 0x050505, emissiveMap: dispMap, emissive: 0xffffff, emissiveIntensity: 2.0, roughness: 0.25, metalness: 0 }), 1, 0.25));
  // shelter / platform light diffusers
  reg('light', patchNightEmissive(new THREE.MeshStandardMaterial({ color: srgb('#e8e6e0'), emissive: srgb('#fff1d6'), emissiveIntensity: 6, roughness: 0.3, metalness: 0 }), 0, 1));
  return out;
}

