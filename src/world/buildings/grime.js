import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { U } from '../../core/uniforms.js';

// Weathering for the masonry: buildings-owned variants of the stone materials that
// darken and grey the albedo where the per-vertex grime mask (attribute aGrime, baked
// by FaceShade: under sill ends and balcony slabs, below cornices and string courses,
// the splash zone, uncleaned facades) is high, with the detail coming from a procedural
// atlas: thin drip trails, broad rain-wash streaks, blotches and a fine soot crust.
// The atlas is addressed in facade metres (along the wall from the world position and
// normal, height = world y), so it needs no extra UV set; two lookups at unrelated
// periods hide the tiling. Also a glass variant for the self-dressed backdrop lots
// (aGrime = lit share: warm interior light at night).

const SIZE = 512;
// atlas period in metres (u along the wall, v up); drips are long and narrow
const PERIOD_U = 4, PERIOD_V = 8;

/** Tileable value noise on a period-P lattice, sampled at (x, y) in lattice units. */
function vnoise(hash, P, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % P) + P) % P, y0 = ((iy % P) + P) % P, x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
  const a = hash[y0 * P + x0], b = hash[y0 * P + x1], c = hash[y1 * P + x0], d = hash[y1 * P + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function lattice(rng, P) {
  const h = new Float32Array(P * P);
  for (let i = 0; i < h.length; i++) h[i] = rng.next();
  return h;
}

/** Tileable fBm over the atlas: octaves = [[period cells, weight], ...]. */
function fbm(rng, octaves) {
  const out = new Float32Array(SIZE * SIZE);
  let wsum = 0;
  for (const [P, wt] of octaves) {
    const h = lattice(rng, P), k = P / SIZE;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) out[y * SIZE + x] += vnoise(h, P, x * k, y * k) * wt;
    wsum += wt;
  }
  for (let i = 0; i < out.length; i++) out[i] /= wsum;
  return out;
}

/**
 * Drip trails and rain-wash streaks (0 clean .. 1 dark), tileable. Rows run upwards
 * (row 0 = bottom), so a trail starts at its top row and runs down.
 */
function drips(rng) {
  const out = new Float32Array(SIZE * SIZE);
  const pxU = SIZE / PERIOD_U, pxV = SIZE / PERIOD_V;   // pixels per metre
  const streak = (x0, top, len, halfW, amp, meander, fade, bead) => {
    const ph = rng.range(0, 6.28), fr = rng.range(1.5, 4), bf = rng.range(0.25, 0.45);
    const rx = Math.ceil(halfW * 2.5) + 1;
    for (let j = 0; j < len; j++) {
      const t = j / len;
      // intensity fades down the trail; thin trails bead and break up, broad ones do not
      const b = 0.5 + 0.5 * Math.sin(j * bf + 2.5 * Math.sin(j * 0.045 + ph) + ph * 3);
      const fadeIn = Math.min(1, t / (bead ? 0.03 : 0.12));
      const a = amp * fadeIn * Math.pow(1 - t, fade) * (1 - bead + bead * b);
      const cx = x0 + Math.sin(t * fr + ph) * meander;
      const y = ((Math.round(top - j) % SIZE) + SIZE) % SIZE;
      const hw = halfW * (1 + 0.35 * t);
      for (let dx = -rx; dx <= rx; dx++) {
        const x = Math.round(cx) + dx;
        const d = (x - cx) / hw;
        const v = a * Math.exp(-d * d);
        if (v < 0.004) continue;
        const i = y * SIZE + (((x % SIZE) + SIZE) % SIZE);
        out[i] = 1 - (1 - out[i]) * (1 - v);
      }
    }
  };
  // broad rain-wash bands (soft, long)
  for (let k = 0; k < 18; k++) {
    streak(rng.range(0, SIZE), rng.range(0, SIZE), rng.range(3, 7) * pxV, rng.range(0.1, 0.32) * pxU, rng.range(0.12, 0.28), rng.range(1, 5), 0.6, 0);
  }
  // drip trails, mostly in clusters (water leaves a ledge at a few points)
  for (let c = 0; c < 26; c++) {
    const cx = rng.range(0, SIZE), cy = rng.range(0, SIZE), n = rng.int(2, 8);
    for (let k = 0; k < n; k++) {
      const w = rng.chance(0.7) ? rng.range(0.01, 0.025) : rng.range(0.03, 0.06);
      streak(cx + rng.range(-0.25, 0.25) * pxU, cy - rng.range(0, 0.3) * pxV, rng.range(0.6, 3.5) * pxV, w * pxU, rng.range(0.45, 0.95), rng.range(0, 2), 0.9, 0.35);
    }
  }
  for (let k = 0; k < 60; k++) {
    streak(rng.range(0, SIZE), rng.range(0, SIZE), rng.range(0.3, 2) * pxV, rng.range(0.008, 0.02) * pxU, rng.range(0.3, 0.7), rng.range(0, 1.5), 1, 0.4);
  }
  return out;
}

let atlas = null;

/** The grime atlas (RGBA8, mipmapped, repeat): r drips, g blotches, b soot crust. */
export function grimeAtlas() {
  if (atlas) return atlas;
  const rng = RNG.from('buildings', 'grime');
  const R = drips(rng);
  const G = fbm(rng, [[4, 1], [8, 0.6], [16, 0.35], [32, 0.2]]);
  const Bc = fbm(rng, [[32, 1], [64, 0.7], [128, 0.45]]);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = Math.min(255, R[i] * 255) | 0;
    data[i * 4 + 1] = Math.min(255, Math.max(0, (G[i] - 0.5) * 1.8 + 0.5) * 255) | 0;
    data[i * 4 + 2] = Math.min(255, Math.max(0, (Bc[i] - 0.5) * 2.2 + 0.5) * 255) | 0;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  atlas = t;
  return t;
}

const VERT_PARS = /* glsl */ `
attribute float aGrime;
varying float vBgGrime;
varying vec3 vBgPos;
varying vec3 vBgN;
`;
const VERT_MAIN = /* glsl */ `
vBgGrime = aGrime;
vBgPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vBgN = normalize(mat3(modelMatrix) * objectNormal);
`;

const FRAG_PARS = /* glsl */ `
varying float vBgGrime;
varying vec3 vBgPos;
varying vec3 vBgN;
uniform sampler2D bgGrimeTex;
uniform vec4 bgGrimeK;   // darkening, greying, roughness gain, base streak share
float bgDirt = 0.0;
`;

// facade metres: along the wall (from the face normal) and height
const FRAG_STONE = /* glsl */ `
{
  vec3 bgN = normalize(vBgN);
  float bgL = length(bgN.xz);
  vec2 bgP = bgL > 0.35 ? vec2(dot(vBgPos.xz, vec2(-bgN.z, bgN.x) / bgL), vBgPos.y) : vBgPos.xz;
  vec4 bgA = texture(bgGrimeTex, bgP * vec2(${(1 / PERIOD_U).toFixed(4)}, ${(1 / PERIOD_V).toFixed(4)}));
  vec4 bgB = texture(bgGrimeTex, bgP * vec2(0.1587, 0.0911) + vec2(0.37, 0.21));
  float bgDrip = max(bgA.r, bgB.r * 0.85);
  float bgBlot = bgA.g * 0.6 + bgB.g * 0.4;
  float bgM = clamp(vBgGrime, 0.0, 1.0);
  // trails carry most of the dirt; blotches and the soot crust fill sheltered zones
  bgDirt = bgM * (bgGrimeK.w + (1.0 - bgGrimeK.w) * bgDrip) * (0.55 + 0.9 * bgBlot);
  bgDirt += smoothstep(0.5, 1.0, bgM) * (bgA.b * 0.6 + 0.2) * 0.6;
  bgDirt = clamp(bgDirt, 0.0, 1.0);
  float bgLum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(bgLum) * vec3(0.97, 0.98, 1.0), bgDirt * bgGrimeK.y);
  diffuseColor.rgb *= 1.0 - bgDirt * bgGrimeK.x;
}
`;
const FRAG_ROUGH = /* glsl */ `
roughnessFactor = min(1.0, roughnessFactor * (1.0 + bgGrimeK.z * bgDirt));
`;

// lit windows of the backdrop lots: warm interior glow at night, by lit share
const FRAG_GLASS_PARS = /* glsl */ `
varying float vBgGrime;
uniform float bgNight;
`;
const FRAG_GLASS = /* glsl */ `
totalEmissiveRadiance += vec3(1.0, 0.68, 0.4) * 1.6 * step(0.5, vBgGrime) * smoothstep(0.25, 0.75, bgNight) * (0.6 + 0.4 * vBgGrime);
`;
const VERT_GLASS_PARS = 'attribute float aGrime;\nvarying float vBgGrime;\n';
const VERT_GLASS_MAIN = 'vBgGrime = aGrime;\n';

/** Chain a patch after the material's existing onBeforeCompile and extend its cache key. */
function chain(m, key, patch) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    patch(shader);
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + key; };
  m.needsUpdate = true;
  return m;
}

/**
 * Weathered stone variant of a library material (vertex colours on). k: darkening,
 * greying, roughness gain, share of the mask that shows without a trail.
 */
export function grimeStone(app, name, k = [0.5, 0.6, 0.15, 0.3]) {
  const base = app.materials.get(name, { vertexColors: true });
  const m = base.clone();
  m.name = `buildings:${name}`;
  const uni = { bgGrimeTex: { value: grimeAtlas() }, bgGrimeK: { value: new THREE.Vector4(...k) } };
  chain(m, 'bgS1', (shader) => {
    Object.assign(shader.uniforms, uni);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_STONE)
      .replace('#include <lights_physical_fragment>', FRAG_ROUGH + '#include <lights_physical_fragment>');
  });
  m.userData.grime = uni;
  app.materials.register(m.name, m);
  return m;
}

/** Window glass of the self-dressed lots, lit at night by the lit share in aGrime. */
export function litGlass(app, name = 'glass.window') {
  const m = app.materials.get(name, { vertexColors: true }).clone();
  m.name = `buildings:${name}`;
  chain(m, 'bgG1', (shader) => {
    shader.uniforms.bgNight = U.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_GLASS_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_GLASS_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_GLASS_PARS)
      .replace('#include <lights_physical_fragment>', FRAG_GLASS + '#include <lights_physical_fragment>');
  });
  app.materials.register(m.name, m);
  return m;
}
