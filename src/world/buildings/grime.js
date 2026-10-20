import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { U } from '../../core/uniforms.js';
import { COLOR_SCALE, GLASS_K, HG_MAX, FU_Q } from './mesh.js';

// Weathering for the masonry: buildings-owned variants of the stone materials that
// soil the albedo (a warm brown-grey, never a cold grey that a low sun turns olive) where
// the per-vertex grime mask (colour alpha, baked by FaceShade: below cornices and string
// courses, soffits, the splash zone, uncleaned facades) is high: an even crust only where
// the stone is well sheltered, elsewhere sparse drip trails and blotches from a procedural
// atlas, so open walling stays mostly clean, as the street's sun-bleached stone does.
// The atlas is addressed in facade metres (along the wall from the world position and
// normal, height = world y), so it needs no extra UV set; two lookups at unrelated
// periods hide the tiling. Run-off below balcony slabs and window sills is shaded per
// pixel from the aRun attribute (the occluder above, see shade.runAttr): soffit
// occlusion and patchy soot under the slab, streaks hanging from its consoles, and sharp
// drip trails of varied length and spacing off the slab and sill ends (bgTrails), with
// rust under iron railings. The foot of the wall carries rising damp, splash dirt and a
// scuffed band up to about 0.7 m; the piers beside doors and shop fronts are handled up
// to about 1.5 m (FaceShade). Colour-washed render (bgRender) also fades unevenly, shows
// patched repairs in another tone, broad stains under its sills and hairline cracks from
// the sill corners. The run-off masks vary along the wall in facade metres, so they cross
// materials, dressing and zone borders without a seam, and a slab's soot fades out a
// little beyond its ends. Dust settles on
// the ashlar's worn block arrises (BG_ARRIS, from the library's row layout), so the upper
// arris of each block does not read as a clean ruled highlight. Also a glass
// variant for the openings the buildings glaze themselves (party walls, set-back
// storeys, skyline blocks): curtains, blinds and rooms behind the panes, reflections
// of the street canyon (the stone across the street from the lower floors, the sky from
// the upper ones) with a Fresnel floor, warm interior light at night (see litGlass).
// Inspection: URL bgdbg=1..5 (GRIME_DEBUG) shows the weathering's inputs as colours.
//
// Every buildings material reads the compact vertex format of buildings/mesh.js: the
// colour attribute is unorm8 × 4 (rgb = sqrt(colour / 2), a = grime / 2), decoded per
// vertex (COLOR_DECODE), and aRun is int16 × 4 (decoded in VERT_MAIN, see shade.runAttr).

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
  // (faint: broad soft bands read as airbrushing)
  for (let k = 0; k < 8; k++) {
    streak(rng.range(0, SIZE), rng.range(0, SIZE), rng.range(3, 7) * pxV, rng.range(0.1, 0.3) * pxU, rng.range(0.05, 0.12), rng.range(1, 5), 0.6, 0);
  }
  // drip trails, mostly in clusters (water leaves a ledge at a few points), sparse enough
  // that clean stone shows between them
  for (let c = 0; c < 14; c++) {
    const cx = rng.range(0, SIZE), cy = rng.range(0, SIZE), n = rng.int(2, 6);
    for (let k = 0; k < n; k++) {
      const w = rng.chance(0.7) ? rng.range(0.008, 0.02) : rng.range(0.025, 0.045);
      streak(cx + rng.range(-0.3, 0.3) * pxU, cy - rng.range(0, 0.4) * pxV, rng.range(0.4, 3.0) * pxV, w * pxU, rng.range(0.55, 1.0), rng.range(0, 2), 0.9, 0.35);
    }
  }
  for (let k = 0; k < 26; k++) {
    streak(rng.range(0, SIZE), rng.range(0, SIZE), rng.range(0.3, 2) * pxV, rng.range(0.006, 0.016) * pxU, rng.range(0.4, 0.8), rng.range(0, 1.5), 1, 0.4);
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

// colour attribute (unorm8 × 4): rgb = sqrt(colour / 2), a = grime / 2 (lit share on glass)
const CSCALE = COLOR_SCALE.toFixed(1);
const COLOR_DECODE = /* glsl */ `
float bgA = vColor.a * ${CSCALE};
vColor = vec4(vColor.rgb * vColor.rgb * ${CSCALE}, 1.0);
`;

const VERT_PARS = /* glsl */ `
attribute vec4 aRun;
attribute vec2 aFu;
varying float vBgU;
attribute vec4 aNrmW;
varying float vBgHg;
varying float vBgGrime;
varying vec4 vBgRun;
varying vec3 vBgPos;
varying vec3 vBgN;
varying float vBgRust;
`;
// aRun (int16): ((a - u) * 256, (line - v) * 256, dirtiness * 128 * 128 + low, +-width * 64)
// to (a - u, line - v, dirtiness, code) with code = +-(floor(width * 64) + s / 2), as
// the fragment code reads it; low: a sill's strength s * 63, a slab's rust (eighths) * 16
// + (s - 0.4) / 0.08 (shade.runItem)
const VERT_MAIN = /* glsl */ `
{
  float bgZ = aRun.z + 0.5, bgZq = floor(bgZ * (1.0 / 128.0));
  float bgLo = bgZ - bgZq * 128.0 - 0.5, bgS = bgLo * (1.0 / 63.0);
  vBgRust = 0.0;
  if (aRun.w > 0.5) {
    float bgRq = floor(bgLo * (1.0 / 16.0) + 0.01);
    bgS = 0.4 + (bgLo - bgRq * 16.0) * 0.08;
    vBgRust = bgRq * (1.0 / 7.0);
  }
  vBgRun = vec4(aRun.xy * (1.0 / 256.0), bgZq * (1.0 / 128.0), sign(aRun.w) * (abs(aRun.w) + clamp(bgS * 0.5, 0.01, 0.99)));
}
vBgPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vBgN = normalize(mat3(modelMatrix) * objectNormal);
vBgU = aFu.x * ${(1 / FU_Q).toFixed(6)};
vBgHg = aNrmW.w * ${HG_MAX.toFixed(1)};
`;

const FRAG_PARS = /* glsl */ `
varying float vBgU;
varying float vBgHg;
varying float vBgGrime;
varying vec4 vBgRun;
varying vec3 vBgPos;
varying vec3 vBgN;
varying float vBgRust;
uniform sampler2D bgGrimeTex;
uniform vec4 bgGrimeK;   // darkening, greying, roughness gain, base streak share
uniform vec2 bgArrisK;   // dust on the block arrises: amount, share on the head joints
uniform float bgDbg;     // inspection (URL bgdbg=1..5, see GRIME_DEBUG)
uniform float bgRender;  // 1: a colour-washed render (plaster shares its program with the tiles)
float bgDirt = 0.0;
float bgHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float bgVN(vec2 p) {
  vec2 i = floor(p), t = fract(p); t = t * t * (3.0 - 2.0 * t);
  return mix(mix(bgHash(i), bgHash(i + vec2(1.0, 0.0)), t.x), mix(bgHash(i + vec2(0.0, 1.0)), bgHash(i + vec2(1.0, 1.0)), t.x), t.y);
}
// Drip trails off the ends of a ledge (a sill, a balcony slab): water leaves it at its
// ends, one to three thin sharp trails per end, each with its own offset from the end,
// width, length (up to lenMax), strength and wander, some ends clean; they widen and fade
// as they run down, broken in places. ua, ub: in from the left / right end (m); d: below
// the ledge (m); px: along the wall (facade metres); sg: whether px runs with the ledge's
// u (see the stone code); fx: metres per pixel along the wall; skip: bit 1 the left end,
// bit 2 the right end has none (a console takes it). The trails' draws are value noise
// of the end's position at a high rate, which a millimetre of interpolation error cannot
// flip.
float bgTrails(float ua, float ub, float d, float px, float sg, float fx, float seed, float lenMax, float skip) {
  float tr = 0.0;
  for (int e = 0; e < 2; e++) {
    float ue = e == 0 ? ua : ub;
    if (ue > 0.36 || (e == 0 ? mod(skip, 2.0) > 0.5 : skip > 1.5)) continue;
    float ep = (px - sg * (e == 0 ? ua : -ub)) * 4.3;
    for (int k = 0; k < 3; k++) {
      float h0 = bgVN(vec2(ep + float(k) * 17.0, float(e) * 5.0 + 3.7 + seed * 11.0));
      if (h0 > (k == 0 ? 0.78 : 0.5)) continue;
      float h1 = bgVN(vec2(ep * 1.7 + float(k) * 7.0, 9.1)), h2 = bgVN(vec2(ep * 1.3 + 3.3, float(k) * 4.1 + 1.9));
      float of = -0.02 + 0.22 * h1 * h1;                       // trail centre, in from the end
      float len = (0.3 + 1.7 * h2 * h2) * lenMax * 0.5;
      if (d > len) continue;
      float wd = (0.01 + 0.022 * fract(h1 * 37.1)) * (1.0 + 0.8 * d / len);
      float x = ue - of - 0.04 * (bgVN(vec2(ep * 0.37 + float(k) * 5.1, d * 1.6)) - 0.5) * min(1.0, d * 2.0);
      // (a sharp core in a faint halo: the water spreads a little of its dirt sideways)
      float ac = max(1.0 - smoothstep(0.3 * wd, wd + fx, abs(x)), 0.22 * (1.0 - smoothstep(wd, 4.0 * wd + fx, abs(x))));
      float al = smoothstep(0.0, 0.03, d) * pow(1.0 - d / len, 1.1);
      float br = 0.6 + 0.4 * smoothstep(0.3, 0.6, bgVN(vec2(ep * 0.71 + float(k) * 3.3, d * 3.1)));
      tr = max(tr, ac * al * br * (0.6 + 0.4 * fract(h2 * 53.7)));
    }
  }
  return tr;
}
`;

// Facade metres: along the wall (the facade coordinate, vertex attribute aFu) and height;
// a level face (ledge, soffit) takes plan metres. aRun.z is the building's dirtiness
// (also a per-building offset of the patch noise).
const FRAG_STONE = /* glsl */ `
{
  vec3 bgNrm = normalize(vBgN);
  float bgL = length(bgNrm.xz);
  // (a carved profile keeps the wall's coordinate while it turns towards the vertical:
  // only a truly level face falls back to plan xz)
  vec2 bgP = bgL > 0.06 ? vec2(vBgU, vBgPos.y) : vBgPos.xz;
  float bgDirtB = vBgRun.z;
  // dirt on this stone is warm brown-grey (street dust, soot and rain-carried grime), so
  // a low warm sun never turns it olive: the soiled colour is the albedo's luminance in
  // this hue
  const vec3 BG_SOIL = vec3(1.07, 0.98, 0.84);
  float bgTrail = 0.0;                                // sharp drip trails (sills, consoles)
  float bgCrack = 0.0;                                // hairline cracks in the render
  float bgStain = 0.0;                                // the render's broad stain under a sill
  if (bgRender > 0.5) {
  // colour-washed render: the wash fades unevenly (lighter and greyer in broad patches,
  // where sun and rain have worn it), and patched repairs 1-4 m across stand out in a
  // slightly different tone with crisp edges (a cell grid in facade metres, one patch in
  // about one cell in five)
  {
    float bgFd = smoothstep(0.3, 0.8, bgVN(bgP * vec2(0.11, 0.08) + bgDirtB * 3.1)) * (0.7 + 0.3 * bgVN(bgP * vec2(0.5, 0.35) + 7.7));
    float bgLr = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(bgLr) * 1.05, 0.32 * bgFd) * (1.0 + 0.08 * bgFd);
    vec2 bgCs = vec2(3.1, 2.3), bgCi = floor(bgP / bgCs + vec2(bgDirtB * 5.0, 0.0));
    float bgPh = bgHash(bgCi + 17.3);
    if (bgPh < 0.26) {
      vec2 bgCo = (bgP / bgCs + vec2(bgDirtB * 5.0, 0.0)) - bgCi;   // 0..1 in the cell
      float bgA0 = bgHash(bgCi + 3.1), bgA1 = bgHash(bgCi + 5.7), bgA2 = bgHash(bgCi + 8.9), bgA3 = bgHash(bgCi + 11.3);
      vec2 bgLo = vec2(0.05 + 0.4 * bgA0, 0.05 + 0.4 * bgA1), bgHi = bgLo + vec2(0.3 + 0.5 * bgA2, 0.3 + 0.5 * bgA3);
      vec2 bgE2 = (fwidth(bgP) / bgCs) + 0.004;
      vec2 bgIn2 = smoothstep(bgLo - bgE2, bgLo + bgE2, bgCo) * (1.0 - smoothstep(min(bgHi, vec2(0.97)) - bgE2, min(bgHi, vec2(0.97)) + bgE2, bgCo));
      float bgPk = bgIn2.x * bgIn2.y;
      float bgTn = bgHash(bgCi + 23.9) < 0.5 ? 0.86 + 0.06 * bgA0 : 1.04 + 0.05 * bgA1;
      float bgLp = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(bgLp), 0.45) * bgTn, bgPk);
    }
  }
  }
  // large soft patches (stone batches, cleaning, sun bleaching), which also set how
  // dirty the stone is locally
  vec2 bgQ = bgP + bgDirtB * vec2(37.1, 11.3);
  float bgN1 = bgVN(bgQ * vec2(0.35, 0.28));
  float bgPt = bgN1 - 0.5 + 0.35 * (bgVN(bgQ * vec2(1.3, 0.9) + 7.7) - 0.5);
  diffuseColor.rgb *= 1.0 + vec3(0.10, 0.10, 0.11) * bgPt;
  float bgDk = 0.6 + 0.8 * bgN1;

  // run-off below the occluder above: aRun = (a - u, line - v, dirtiness, code), code =
  // +-(floor(width * 64) + s / 2): + balcony slab (line = soffit), - window sill. Its
  // masks are modulated along the wall in facade metres (bgP), so they run on unbroken
  // across the materials and the dressing, and from one occluder's zone into the next.
  float bgRunM = 0.0, bgSoot = 0.0, bgWash = 0.0;   // grime mask, soot, rain wash
  float bgCst = 0.0;                                  // console streak
  vec3 bgRunK = vec3(1.0);                            // occlusion and rust
  float bgK = abs(vBgRun.w), bgD = vBgRun.y;
  float bgFx = fwidth(vBgRun.x);                     // metres along the wall per pixel
  // (whether bgP.x runs with the face's u or against it, for positions along the wall)
  float bgSg = dFdx(bgP.x) * dFdx(vBgRun.x) + dFdy(bgP.x) * dFdy(vBgRun.x) > 0.0 ? -1.0 : 1.0;
  if (bgK >= 1.0 && bgD > 0.0) {
    // (width code: width in 1/64 m, plus flags on slab pieces ending at a console)
    float bgKq = floor(bgK), bgCf = floor(bgKq * (1.0 / 8192.0));
    float bgW = (bgKq - bgCf * 8192.0) * (1.0 / 64.0), bgS = fract(bgK) * 2.0;
    float bgUa = -vBgRun.x, bgUb = bgW - bgUa;      // from the left / right end
    // strips centred just inside each end: water runs off there
    float bgE = max(0.0, 1.0 - min(abs(bgUa - 0.08), abs(bgUb - 0.08)) / 0.2);
    // patches 1.5-4 m long at 30-100 % strength
    float bgPu = bgP.x + bgDirtB * 17.3;
    float bgPatch = 0.3 + 0.7 * smoothstep(0.2, 0.8, 0.65 * bgVN(vec2(bgPu * 0.38, 3.7)) + 0.35 * bgVN(vec2(bgPu * 0.71, 9.1)));
    if (vBgRun.w > 0.0) {
      // balcony slab: occlusion right under the soffit, and soot that fades in over the
      // first 20 cm and hangs 0.4-1.8 m in streaks; both reach a little beyond the slab
      // ends; water and rust down the strips under the ends
      float bgOut = max(0.0, -min(bgUa, bgUb));
      float bgSpread = exp(-bgOut / 0.4) * (1.0 - smoothstep(0.6, 1.05, bgOut));   // nil at the zone's end (shade.BAL_M)
      bgRunK *= 1.0 - 0.18 * bgSpread * exp(-bgD / 0.35);
      float bgLen = 0.4 + 1.4 * bgVN(vec2(bgPu * 0.9 + 5.3, 0.5));
      float bgCol = smoothstep(0.35, 0.85, bgVN(vec2(bgPu * 3.1, bgD * 0.12)))
        + 0.6 * smoothstep(0.5, 0.9, bgVN(vec2(bgPu * 9.0, bgD * 0.4))) * (1.0 - smoothstep(0.015, 0.05, bgFx));
      bgCol = mix(bgCol, 0.4, smoothstep(0.04, 0.15, bgFx));   // far: the mean
      float bgRun = bgE * bgS * exp(-bgD / 3.2) * (1.0 - smoothstep(2.8, 3.8, bgD));
      bgSoot = bgSpread * bgPatch * min(1.4, bgDirtB * bgDk) * smoothstep(0.0, 0.2, bgD)
        * (0.3 * exp(-bgD / 0.6) + 0.7 * bgCol * exp(-bgD / bgLen));
      // water off the slab's ends: drip trails (the console ends have their own streaks),
      // far away their soft mean
      float bgNearS = 1.0 - smoothstep(0.015, 0.06, bgFx);
      float bgCLs = step(1.5, bgCf), bgCRs = step(0.5, bgCf - 2.0 * bgCLs);
      float bgTrS = bgNearS > 0.0 && bgD < 2.6 ? bgTrails(bgUa, bgUb, bgD, bgP.x, bgSg, bgFx, bgDirtB + 0.37, 2.6, bgCLs + 2.0 * bgCRs) : 0.0;
      bgTrail = max(bgTrail, min(1.0, 0.3 + 0.5 * bgS) * bgTrS * bgNearS * min(1.3, bgDirtB));
      bgRunM = bgDirtB * (0.3 + 0.65 * (1.0 - bgNearS)) * bgRun;
      // streaks hanging from the consoles: water runs down the console and off its foot,
      // a dark trail below it that meanders a little, widens as it runs down and fades
      // over 0.5-3 m, some consoles far dirtier than others, about half of them clean (the
      // consoles split the slab into pieces, see shade.js)
      float bgCL = step(1.5, bgCf), bgCR = step(0.5, bgCf - 2.0 * bgCL);
      bool bgOnL = bgCL > 0.5 && (bgCR < 0.5 || bgUa < bgUb);
      float bgOff = bgOnL ? bgUa : (bgCR > 0.5 ? -bgUb : 9.0);   // across from the console (m)
      if (abs(bgOff) < 0.35) {
        float bgCu = bgP.x - bgSg * bgOff;                         // the console along the wall (the same from both pieces)
        float bgCk = smoothstep(0.42, 0.85, bgVN(vec2(bgCu * 2.3 + bgDirtB * 7.0, 4.1)));
        float bgCLen = 0.5 + 2.3 * bgVN(vec2(bgCu * 3.1, 8.7));
        float bgCx = bgOff - 0.05 * (bgVN(vec2(bgCu * 5.0, bgD * 1.3)) - 0.5) * min(1.0, bgD);
        float bgCw = 0.045 + 0.05 * min(1.0, bgD / 1.5) + 0.03 * (bgVN(vec2(bgCu * 4.0 + 1.7, bgD * 2.5)) - 0.5);
        bgCst = (1.0 - smoothstep(bgCw * 0.35, bgCw * 1.3, abs(bgCx))) * bgCk * smoothstep(0.3, 0.6, bgD)
          * exp(-bgD / bgCLen) * (1.0 - smoothstep(bgCLen * 1.1, bgCLen * 1.6, bgD)) * (0.55 + 0.45 * bgVN(vec2(bgCu * 7.0, bgD * 4.0)))
          * (1.0 - smoothstep(0.06, 0.2, bgFx));                   // (sub-pixel trails: the run-off mean carries them)
        bgRunM += bgDirtB * 0.5 * bgCst;
      }
      float bgRust = 0.6 * bgRun;
      bgRunK *= vec3(1.0 - 0.08 * bgRust, 1.0 - 0.13 * bgRust, 1.0 - 0.2 * bgRust);
      // rust from the iron railing above (ironwork's bal.rust): orange-brown trails 0.3-1.5
      // m long under the slab ends and the corner posts (less at a piece's console end),
      // and a little down the console streaks
      if (vBgRust > 0.01) {
        float bgEa = max(0.0, 1.0 - abs(bgUa - 0.08) / 0.2) * (1.0 - 0.5 * bgCL), bgEb = max(0.0, 1.0 - abs(bgUb - 0.08) / 0.2) * (1.0 - 0.5 * bgCR);
        float bgRl = 0.3 + 1.2 * bgVN(vec2(bgPu * 1.7 + 3.1, 6.2));
        float bgRs = max(bgEa, bgEb) * smoothstep(0.0, 0.06, bgD) * exp(-bgD / bgRl) * (1.0 - smoothstep(bgRl * 1.2, bgRl * 1.8, bgD))
          * (0.55 + 0.45 * bgVN(vec2(bgPu * 11.0, bgD * 3.0)));
        bgRunK *= mix(vec3(1.0), vec3(0.6, 0.38, 0.24), 0.5 * vBgRust * min(1.0, bgRs + 0.5 * bgCst));
      }
    } else {
      // window sill: a short soft shadow of dirt right under it, and drip trails off its
      // ends (bgTrails); far away (trails under a few pixels) only their soft mean is left
      float bgIn = clamp(min(bgUa, bgUb) / 0.2, 0.0, 1.0);
      float bgUnder = 0.16 * bgIn * bgPatch * smoothstep(0.0, 0.08, bgD) * exp(-bgD / 0.32);
      float bgNearT = 1.0 - smoothstep(0.015, 0.06, bgFx);
      float bgTr = bgNearT > 0.0 && bgD < 2.0 ? bgTrails(bgUa, bgUb, bgD, bgP.x, bgSg, bgFx, bgDirtB, 2.0, 0.0) : 0.0;
      float bgRun = bgE * bgS * exp(-bgD / 1.6) * (1.0 - smoothstep(1.8, 2.6, bgD));
      bgRunM = bgDirtB * (bgUnder + 0.25 * bgRun * (1.0 - bgNearT));
      bgTrail = max(bgTrail, min(1.0, 0.4 + 0.6 * bgS) * bgTr * bgNearT * min(1.3, bgDirtB));
      // render soaks up the dirty water: a broad grey-brown stain under the sill as well,
      // patchy and fading over a metre or two, which still shows from far away
      bgStain = bgRender * min(1.3, bgDirtB) * 0.75 * min(1.2, bgS) * bgPatch * smoothstep(0.0, 0.1, bgD) * exp(-bgD / 1.2) * (0.3 + 0.7 * max(bgE, bgIn * 0.6))
        * (0.7 + 0.3 * bgVN(vec2(bgP.x * 4.0, bgD * 2.5)));
      // render cracks: a hairline from the sill's corner on some windows, running down and
      // outwards at 55-80 degrees with a little wander (gone once it is far below a pixel)
      if (bgRender > 0.5 && bgFx < 0.02 && bgD < 1.4) {
        for (int e = 0; e < 2; e++) {
          float bgUe = e == 0 ? bgUa : bgUb;
          float bgEc = (bgP.x - bgSg * (e == 0 ? bgUa : -bgUb)) * 3.1;
          float bgQ0 = bgVN(vec2(bgEc, float(e) * 3.0 + 21.7)), bgQ1 = bgVN(vec2(bgEc * 1.9 + 4.0, 7.3));
          if (bgQ0 > 0.46) continue;
          float bgCl = 0.3 + 1.0 * bgQ1;
          if (bgD > bgCl) continue;
          float bgTa = 0.18 + 0.5 * fract(bgQ1 * 17.3);                       // run outwards per metre down
          float bgXc = -bgD * bgTa + 0.03 * (bgVN(vec2(bgEc + bgD * 9.0, 2.2)) - 0.5) + 0.012 * (bgVN(vec2(bgEc - bgD * 31.0, 5.9)) - 0.5);
          float bgCw = 0.0012 + 0.5 * bgFx;
          float bgCk = (1.0 - smoothstep(bgCw, bgCw * 2.5, abs(bgUe - bgXc))) * (1.0 - smoothstep(bgCl * 0.6, bgCl, bgD)) * smoothstep(0.0, 0.02, bgD);
          bgCrack = max(bgCrack, bgCk * (1.0 - smoothstep(0.006, 0.02, bgFx)) * min(1.0, 0.0012 / bgCw + 0.35));
        }
      }
      bgWash = 0.03 * bgRun;
    }
    float bgL0 = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
    diffuseColor.rgb = mix(diffuseColor.rgb, bgL0 * BG_SOIL * 0.95, min(0.6, bgWash * 1.4)) * bgRunK * (1.0 - bgWash);
  }

  // the foot of the wall (vBgHg: height above the paving in front, per vertex): rising
  // damp up to an irregular tide line 0.35-1.2 m up (higher on dirtier buildings), darker
  // and greyer below it (a little green only in the bottom 15 cm, where the paving keeps
  // it wet), with a patchy pale salt bloom just above it; splash dirt in the first 40 cm;
  // and dirt packed into the joints near the ground
  float bgHg = vBgHg;
  if (bgHg < 2.0) {
    float bgDampK = clamp(bgDirtB * 0.9 - 0.2, 0.2, 1.0);
    float bgTide = 0.35 + 0.85 * bgDampK * (0.4 + 0.6 * bgVN(vec2(bgP.x * 0.45 + bgDirtB * 13.0, 2.7)))
      + 0.1 * (bgVN(vec2(bgP.x * 2.9, 5.3)) - 0.5);
    float bgFw = fwidth(bgHg);
    float bgWet = 1.0 - smoothstep(bgTide - 0.06 - bgFw, bgTide + 0.02 + bgFw, bgHg);
    float bgWetN = 0.7 + 0.6 * bgVN(bgP * vec2(1.6, 2.2) + 3.3);
    float bgL1 = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
    diffuseColor.rgb = mix(diffuseColor.rgb, bgL1 * vec3(1.0, 0.97, 0.92), 0.4 * bgWet) * (1.0 - 0.3 * bgWet * bgWetN * bgDampK);
    float bgGr = (1.0 - smoothstep(0.03, 0.16 + bgFw, bgHg)) * bgDampK * (0.5 + 0.5 * bgWetN);
    diffuseColor.rgb = mix(diffuseColor.rgb, bgL1 * vec3(0.86, 0.95, 0.84) * 0.85, 0.35 * bgGr);
    float bgSalt = smoothstep(bgTide - 0.03 - bgFw, bgTide + 0.02, bgHg) * (1.0 - smoothstep(bgTide + 0.03, bgTide + 0.15 + bgFw, bgHg))
      * smoothstep(0.3, 0.7, bgVN(vec2(bgP.x * 3.3, bgHg * 7.0)));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(bgL1 * 1.1 + 0.025), 0.3 * bgSalt * bgDampK);
    float bgSp = (1.0 - smoothstep(0.04, 0.45, bgHg)) * smoothstep(0.4, 0.8, texture(bgGrimeTex, bgP * vec2(1.13, 1.71) + 0.5).b);
    diffuseColor.rgb *= 1.0 - 0.3 * bgSp;
    // the splash and pedestrian band: rain splash off the paving, scuffing shoes, bags,
    // bicycles and dogs soil the bottom half metre or so evenly, darker and greyer, up to
    // an irregular line (higher and heavier on older, dirtier fronts: bgDirtB is the age)
    float bgAge = clamp(bgDirtB, 0.4, 1.6);
    float bgBt = 0.55 + 0.3 * bgAge + 0.16 * (bgVN(vec2(bgP.x * 0.7 + bgDirtB * 5.3, 1.9)) - 0.5) + 0.05 * (bgVN(vec2(bgP.x * 5.5, 3.1)) - 0.5);
    float bgBand = (1.0 - smoothstep(bgBt - 0.25 - bgFw, bgBt + 0.03 + bgFw, bgHg)) * (0.75 + 0.25 * (1.0 - smoothstep(0.0, 0.3, bgHg)));
    bgBand *= min(1.0, (0.6 + 0.4 * bgAge) * (0.8 + 0.4 * bgVN(bgP * vec2(2.3, 3.1) + 9.1)));
    float bgL3 = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
    diffuseColor.rgb = mix(diffuseColor.rgb, bgL3 * vec3(1.02, 0.98, 0.92), 0.55 * bgBand) * (1.0 - 0.28 * bgBand);
#ifdef BG_JOINTS
    if (sfLay.y > 0.5) {
      vec2 bgJd = min(sfCl, sfCs - sfCl);
      float bgJw = max(0.004, sfJoint.y);
      float bgJ = 1.0 - smoothstep(bgJw, bgJw * 2.6, min(bgJd.x, bgJd.y));
      float bgJf = 1.0 - smoothstep(0.004, 0.012, max(fwidth(sfCl.x), fwidth(sfCl.y)));   // (gone once a joint is sub-pixel)
      diffuseColor.rgb *= 1.0 - 0.42 * bgJ * bgJf * exp(-max(0.0, bgHg) / 0.8);
    }
#endif
  }

#ifdef BG_ARRIS
  // dust on the worn arrises of the ashlar: the upper arris of every block is a small
  // upward-facing bevel that catches the sky, and left clean it reads as a ruled bright
  // line along each bed joint. Dust settles there (and, less, on the head-joint arrises),
  // in patches along the arris and heavier on some blocks; gone once the arris is
  // sub-pixel (its highlight is then gone too)
  if (bgArrisK.x > 0.0 && sfLay.y > 0.5) {
    float bgAf = 1.0 - smoothstep(0.002, 0.007, max(fwidth(bgP.x), fwidth(bgP.y)));
    if (bgAf > 0.0) {
      float bgAw = max(0.002, sfJoint.y * 0.55);    // pointing half width
      float bgDt = sfCs.y - sfCl.y, bgDs = min(sfCl.x, sfCs.x - sfCl.x);
      // (from the lower half of the pointing, over the step up to the stone, across the bevel)
      float bgAt = smoothstep(0.3 * bgAw, 0.6 * bgAw, bgDt) * (1.0 - smoothstep(bgAw + 0.003, bgAw + 0.011, bgDt));
      float bgAs = smoothstep(0.3 * bgAw, 0.6 * bgAw, bgDs) * (1.0 - smoothstep(bgAw + 0.002, bgAw + 0.007, bgDs));
      float bgBh = float(sfCh & 1023u) * (1.0 / 1023.0);
      float bgPa = smoothstep(0.32, 0.62, bgVN(vec2(bgP.x * 14.0 + bgBh * 31.0, bgP.y * 2.9)));
      float bgPs = smoothstep(0.32, 0.62, bgVN(vec2(bgP.y * 14.0 + bgBh * 17.0, bgP.x * 2.9 + 5.0)));
      float bgAk = bgArrisK.x * bgAf * (0.6 + 0.4 * bgBh);
      float bgAd = bgAk * (0.2 + 0.8 * bgPa) * bgAt + bgAk * bgArrisK.y * (0.2 + 0.8 * bgPs) * bgAs;
      bgAd = min(bgAd, 1.0);
      // (the greyed bevel under the bluish sky light reads as a white line: the dust is a
      // warm brown-grey, darker and less blue than the stone)
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.76, 0.66, 0.52), bgAd);
    }
  }
#endif

  // weathering detail from the atlas: trails carry most of the dirt; blotches and the
  // soot crust fill sheltered zones
  vec4 bgA = texture(bgGrimeTex, bgP * vec2(${(1 / PERIOD_U).toFixed(4)}, ${(1 / PERIOD_V).toFixed(4)}));
  vec4 bgB = texture(bgGrimeTex, bgP * vec2(0.1587, 0.0911) + vec2(0.37, 0.21));
  float bgDrip = max(bgA.r, bgB.r * 0.85);
  float bgBlot = bgA.g * 0.6 + bgB.g * 0.4;
  float bgM = clamp((vBgGrime + bgRunM) * bgDk, 0.0, 1.0);
  // an even crust only where the stone is well sheltered (right under the cornice and the
  // soffits); elsewhere the dirt shows as trails and patches, never as an even airbrushed
  // film over open walling
  float bgFilm = mix(bgGrimeK.w * 0.4, 1.0, smoothstep(0.45, 0.9, bgM));
  bgDirt = bgM * (bgFilm + (1.0 - bgFilm) * bgDrip) * (0.55 + 0.9 * bgBlot);
  bgDirt += smoothstep(0.5, 1.0, bgM) * (bgA.b * 0.6 + 0.2) * 0.6;
  bgDirt = clamp(bgDirt, 0.0, 1.0);
  // soot under a balcony slab: greyer and darker (at most a quarter) than the stone
  bgSoot = clamp(bgSoot * (0.75 + 0.5 * bgBlot), 0.0, 1.0);
  float bgLum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  diffuseColor.rgb = mix(diffuseColor.rgb, bgLum * BG_SOIL, min(1.0, bgDirt * bgGrimeK.y + bgSoot * 0.35));
  diffuseColor.rgb *= (1.0 - bgDirt * bgGrimeK.x) * (1.0 - 0.25 * bgSoot);
  // console streaks and the trails off the sill ends: sharp brown-grey dirt
  float bgCt = max(bgCst * (0.5 + 0.5 * bgDrip), bgTrail);
  float bgLc = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  diffuseColor.rgb = mix(diffuseColor.rgb, bgLc * BG_SOIL * 0.9, 0.55 * bgCt) * (1.0 - 0.5 * bgCt);
  diffuseColor.rgb *= 1.0 - 0.45 * bgCrack;
  float bgLs = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  diffuseColor.rgb = mix(diffuseColor.rgb, bgLs * BG_SOIL * 0.88, 0.5 * bgStain) * (1.0 - 0.16 * bgStain);
  bgDirt = max(bgDirt, 0.6 * bgStain);
  bgDirt = max(max(bgDirt, bgSoot), bgCt);
  if (bgDbg > 0.5) {
    // 1: height above the paving (red ramp to 2 m, green below 0.6 m); 2: trails (red),
    // grime mask (green), soot (blue); 3: the run-off zone (red sill, green slab, blue none);
    // 4: the vertex colour alone; 5: the dirt the weathering lays (grey, white = clean)
    diffuseColor.rgb = bgDbg < 1.5 ? vec3(clamp(vBgHg / 2.0, 0.0, 1.0), vBgHg < 0.6 ? 0.8 : 0.0, 0.1)
      : bgDbg < 2.5 ? vec3(bgCt, bgM, bgSoot)
      : bgDbg < 3.5 ? vec3(vBgRun.w < -0.5 ? 0.8 : 0.0, vBgRun.w > 0.5 ? 0.8 : 0.0, abs(vBgRun.w) < 0.5 ? 0.8 : 0.0)
      : bgDbg < 4.5 ? vColor.rgb * 0.6 : bgDbg < 5.5 ? vec3(0.7 * (1.0 - bgDirt)) : vec3(vBgGrime, bgRunM, bgDk * 0.5);
  }
}
`;
/** Inspection mode of the weathered materials (URL bgdbg, set by buildings.init). */
export const GRIME_DEBUG = { value: 0 };
const FRAG_ROUGH = /* glsl */ `
roughnessFactor = min(1.0, roughnessFactor * (1.0 + bgGrimeK.z * bgDirt));
`;

// The buildings' own glazing (party walls, set-back storeys, skyline blocks, rooftop
// collectors). Vertex colour = what shows behind the pane (curtain, blind, dark room) as
// albedo / GLASS_K; colour alpha = flags: lit at night (0.75) + open casement (0.25).
// Reflections: the opposite side of the street hides the low sky from the lower floors
// (they mirror warm stone instead, the upper floors the sky), each window's pane is tilted
// a little (its vertex normal) so neighbours catch different parts of the sky, and an
// open window mirrors nothing.
const FRAG_GLASS_PARS = /* glsl */ `
varying float vBgGrime;
varying float vBgH;
uniform float bgNight;
uniform float bgGain;
uniform float bgLevel;
`;
// (the vertex colour replaces the library colour; the pane's own dust stays, and the glass
// tints what shows through it a little green-grey)
const FRAG_GLASS_COLOR = /* glsl */ `
diffuseColor.rgb *= ${GLASS_K.toFixed(4)} * vec3(0.96, 1.0, 0.99) / max(diffuse, vec3(1e-3));
`;
// The environment map holds the street canyon seen from the camera (sky, facades,
// paving); the pane mirrors it in the reflected direction. Below the opposite skyline as
// seen from the pane's own height (the lower floors) that is the stone across the street,
// a little warmer and dimmer than the capture's average there; above it the sky. Fresnel
// (Schlick, F0 0.04) as three applies it, with a floor of 0.06 at normal incidence (a pane
// reflects its dusty film and the frame's surround too), so a window facing the shade
// still shows the bright facade across the street instead of a black hole.
const FRAG_GLASS_REFL = /* glsl */ `
#if defined( RE_IndirectSpecular )
{
  float bgLitR = step(0.5, vBgGrime), bgOpen = step(0.125, vBgGrime - 0.75 * bgLitR);
  vec3 bgRw = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
  // elevation of the opposite skyline seen from this height (about 17 m tall, 24 m away)
  float bgE0 = clamp((17.0 - vBgH) / 24.0, -0.35, 0.6);
  float bgSky = smoothstep(bgE0 - 0.16, bgE0 + 0.16, bgRw.y);
  float bgNv = clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0);
  float bgF = 0.04 + 0.96 * pow(1.0 - bgNv, 5.0);
  radiance *= mix(vec3(0.86, 0.8, 0.7), vec3(1.0), bgSky) * max(1.0, 0.06 / bgF) * (1.0 - bgOpen);
}
#endif
`;
// a dim warm room behind the pane (curtains, a lamp somewhere inside), not a light box:
// 2700-3000 K (the lighter the curtain, the brighter and a little less orange), at a level
// that follows the exposure at night (GLASS_NIGHT), so a lit window reads as a warm lamp
// through a curtain and never burns out to a white patch at full night
const FRAG_GLASS = /* glsl */ `
{
  float bgK = min(1.0, dot(vColor.rgb, vec3(0.4)));
  totalEmissiveRadiance += mix(vec3(1.0, 0.56, 0.27), vec3(1.0, 0.66, 0.38), bgK) * bgLevel * bgGain * step(0.5, vBgGrime) * smoothstep(0.25, 0.75, bgNight) * (0.6 + 0.6 * bgK);
}
`;
/**
 * Night level of the buildings' lit windows (scene units), set every frame by
 * buildings.update from the exposure (see nightLevels).
 */
export const GLASS_NIGHT = { value: 0.0045 };
// exposed level of a lit window's brightest channel (scene radiance x exposure): warm,
// bright, below the white point
const GLASS_EXPOSED = 0.3;
/** Update GLASS_NIGHT from the exposure the post pass applies (env.exposure). */
export function nightLevels(exposure) {
  GLASS_NIGHT.value = Math.min(0.0045, GLASS_EXPOSED / Math.max(1, exposure || 1));
}
const VERT_GLASS_PARS = 'varying float vBgGrime;\nvarying float vBgH;\n';

// Never a negative radiance out of the buildings' materials: at golden hour a few far
// (600 m) plaster and glass pixels came out a little below zero (about -0.0015, all three
// channels), which the post pass counts as broken and replaces; clamped where they are made.
const FRAG_NONNEG = 'gl_FragColor.rgb = max(gl_FragColor.rgb, vec3(0.0));\n#include <dithering_fragment>';

const LIB_ALONG = 'float sfAl = dot(vSfWorld, sfTW), sfY = vSfWorld.y;';
const LIB_ALONG_FU = 'float sfAl = vBgU, sfY = vSfWorld.y;';

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
export function grimeStone(app, name, k = [0.5, 0.6, 0.15, 0.3], arris = [0, 0], opts = {}) {
  const base = app.materials.get(name, { vertexColors: true });
  const m = base.clone();
  m.name = `buildings:${name}`;
  const uni = { bgGrimeTex: { value: grimeAtlas() }, bgGrimeK: { value: new THREE.Vector4(...k) }, bgArrisK: { value: new THREE.Vector2(...arris) }, bgDbg: GRIME_DEBUG, bgRender: { value: opts.render ? 1 : 0 } };
  // the library's own run-off streaks (a field of them on every wall) are thinned out on
  // these variants: the buildings' run-off hangs from the sills, consoles and cornices
  const streakK = opts.streak ?? 1;
  let weather = null;
  chain(m, 'bgS9', (shader) => {
    Object.assign(shader.uniforms, uni);
    const w = shader.uniforms.sfWeather;
    if (streakK !== 1 && w && w.value && w.value.isVector4) {
      weather = weather || { value: new THREE.Vector4(w.value.x, w.value.y * streakK, w.value.z * (0.5 + 0.5 * streakK), w.value.w) };
      shader.uniforms.sfWeather = weather;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <color_vertex>', '#include <color_vertex>\n' + COLOR_DECODE + 'vBgGrime = bgA;\n')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_MAIN);
    // (dirt in the joints needs the library's row layout: the block coordinates and joint
    // width of the surface patch, where the program has them)
    const joints = /vec2 sfCl\b/.test(shader.fragmentShader) && /vec2 sfCs\b/.test(shader.fragmentShader) && /uniform vec4 sfJoint;/.test(shader.fragmentShader);
    const arrises = joints && /uint sfCh\b/.test(shader.fragmentShader) && /uniform vec4 sfLay;/.test(shader.fragmentShader);
    // the library's run-off streaks hang along the wall by a coordinate taken from the
    // world position and the normal, which carved profiles stripe (see mesh.js, vertex
    // attribute f): these variants give it the facade coordinate (when the library's code
    // reads as expected; else it is left as it is)
    shader.fragmentShader = shader.fragmentShader.replace(LIB_ALONG, LIB_ALONG_FU);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + (joints ? '#define BG_JOINTS\n' : '') + (arrises ? '#define BG_ARRIS\n' : '') + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_STONE)
      .replace('#include <lights_physical_fragment>', FRAG_ROUGH + '#include <lights_physical_fragment>')
      .replace('#include <dithering_fragment>', FRAG_NONNEG);
  });
  m.userData.grime = uni;
  app.materials.register(m.name, m);
  return m;
}

// paint on render (the murals): the trowelled render under the paint shows through it
// (value noise at 0.3 m and 8 cm, the fine one gone once it is sub-pixel), before the
// weathering of the stone code (soot, splash, run-off under the sills, drip trails)
const FRAG_PAINT = /* glsl */ `
{
  vec3 bgNp = normalize(vBgN);
  float bgLp = length(bgNp.xz);
  vec2 bgPp = bgLp > 0.06 ? vec2(vBgU, vBgPos.y) : vBgPos.xz;
  float bgFp = fwidth(bgPp.x);
  float bgTr = (bgVN(bgPp * 3.3) - 0.5) * 0.1 + (bgVN(bgPp * 12.5 + 4.1) - 0.5) * 0.1 * (1.0 - smoothstep(0.02, 0.08, bgFp));
  diffuseColor.rgb *= 1.0 + bgTr;
}
`;

/**
 * Weathered paint: a plain map-textured material (vertexColors on, buildings' vertex
 * format) that takes the stone weathering: the vertex colour is the wall's shading
 * relative to its tint (FaceShade with a white tint), the grime mask and run-off as on
 * the wall, and the render's texture through the paint. k: as grimeStone.
 */
export function grimePaint(m, k = [0.45, 0.55, 0.12, 0.3]) {
  m.vertexColors = true;
  const uni = { bgGrimeTex: { value: grimeAtlas() }, bgGrimeK: { value: new THREE.Vector4(...k) }, bgArrisK: { value: new THREE.Vector2(0, 0) }, bgDbg: GRIME_DEBUG, bgRender: { value: 0 } };
  chain(m, 'bgP2', (shader) => {
    Object.assign(shader.uniforms, uni);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <color_vertex>', '#include <color_vertex>\n' + COLOR_DECODE + 'vBgGrime = bgA;\n')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_PAINT + FRAG_STONE)
      .replace('#include <lights_physical_fragment>', FRAG_ROUGH + '#include <lights_physical_fragment>')
      .replace('#include <dithering_fragment>', FRAG_NONNEG);
  });
  m.userData.grime = uni;
  return m;
}

/** Window glass the buildings put in themselves, lit at night by the lit share (colour alpha). */
export function litGlass(app, name = 'glass.window') {
  const gain = (app.materials.uniforms && app.materials.uniforms.emissiveGain) || { value: 1 };
  const m = app.materials.get(name, { vertexColors: true }).clone();
  m.name = `buildings:${name}`;
  chain(m, 'bgG4', (shader) => {
    shader.uniforms.bgNight = U.uNight;
    shader.uniforms.bgGain = gain;
    shader.uniforms.bgLevel = GLASS_NIGHT;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_GLASS_PARS)
      .replace('#include <color_vertex>', '#include <color_vertex>\n' + COLOR_DECODE + 'vBgGrime = bgA;\nvBgH = uv.y;\n');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_GLASS_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_GLASS_COLOR)
      .replace('#include <lights_physical_fragment>', FRAG_GLASS + '#include <lights_physical_fragment>')
      .replace('#include <lights_fragment_end>', FRAG_GLASS_REFL + '#include <lights_fragment_end>')
      .replace('#include <dithering_fragment>', FRAG_NONNEG);
  });
  app.materials.register(m.name, m);
  return m;
}
