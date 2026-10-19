import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { ATLAS, IRON_REGIONS, canvas, ctx2d, makeNoise, generateIronAtlas, writeLeaves } from './ironAtlas.js';

// Procedural textures for street details:
//  - cast-iron atlas (albedo / normal / ORM): round manhole cover with concentric
//    rings, square tree grate with radial slots over soil, gully grate, slotted track
//    drain cover, chequer-plate utility cover, a small valve cover and four fallen-leaf
//    cut-outs (drawn with the iron, tinted by vertex colour). Generated in a worker
//    (ironAtlas.js) so start-up is not blocked; neutral iron until it arrives;
//  - stain atlas (alpha blotches, gum spots, drip marks, soil rings round tree grates,
//    mottled trodden-in dirt).

export { IRON_REGIONS };

function dataTex(data, w, h, srgb, aniso) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ stains
/** Stain atlas layout: STAIN_COLS x STAIN_ROWS cells of 256 px; kind k sits in column
 *  k % 3, row floor(k / 3) (row 0 at the top of the canvas = the top of texture v). */
export const STAIN_COLS = 3, STAIN_ROWS = 3;
/** Atlas uv of stain kind `kind` at local (lu, lv) in [-1, 1]. */
export function stainUV(kind, lu, lv, out) {
  const col = kind % STAIN_COLS, row = Math.floor(kind / STAIN_COLS);
  out[0] = (col + lu * 0.5 + 0.5) / STAIN_COLS;
  out[1] = 1 - (row + 1) / STAIN_ROWS + (lv * 0.5 + 0.5) / STAIN_ROWS;
  return out;
}

function drawStains() {
  // grey levels on black (alphaMap reads the green channel); blobs accumulate additively
  const cell = 256, W = cell * STAIN_COLS, H = cell * STAIN_ROWS, c = canvas(W, H), C = ctx2d(c);
  C.fillStyle = '#000'; C.fillRect(0, 0, W, H);
  C.globalCompositeOperation = 'lighter';
  const rng = RNG.from('street-stains');
  // 0: broad water / dirt stain, 1: oil drip patch, 2: gum spots, 3: streaky drip trail,
  // 4: soil and litter ring round a tree grate (the grate covers the middle 41%),
  // 5: mottled trodden-in dirt (café floors, benches),
  // 6 / 7: grime and rust halo round a round / square cover (the cover takes the middle
  // 60 %: wear.js RING_IN), 8: a cluster of oil and grease drops
  const cx = (k) => (k % STAIN_COLS + 0.5) * cell, cy = (k) => (Math.floor(k / STAIN_COLS) + 0.5) * cell;
  const blob = (x, y, r, a) => {
    const g = C.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.6, `rgba(255,255,255,${a * 0.6})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    C.fillStyle = g; C.beginPath(); C.arc(x, y, r, 0, Math.PI * 2); C.fill();
  };
  for (let i = 0; i < 40; i++) blob(cx(0) + rng.normal(0, 26), cy(0) + rng.normal(0, 26), rng.range(14, 46), 0.15);
  for (let i = 0; i < 26; i++) blob(cx(1) + rng.normal(0, 20), cy(1) + rng.normal(0, 14), rng.range(8, 30), 0.2);
  for (let i = 0; i < 6; i++) blob(cx(1) + rng.normal(0, 8), cy(1) + rng.normal(0, 8), rng.range(6, 12), 0.35);
  for (let i = 0; i < 70; i++) {
    const x = cx(2) + rng.normal(0, 40), y = cy(2) + rng.normal(0, 40), r = rng.range(1.6, 4.5);
    C.fillStyle = `rgba(255,255,255,${rng.range(0.55, 0.9)})`; C.beginPath(); C.ellipse(x, y, r, r * rng.range(0.7, 1), rng.range(0, 3), 0, Math.PI * 2); C.fill();
  }
  for (let i = 0; i < 90; i++) {
    const t = rng.next();
    blob(cx(3) + rng.normal(0, 7), cy(3) - cell / 2 + 12 + t * (cell - 24), rng.range(4, 12), 0.16 + 0.12 * (1 - Math.abs(t - 0.5) * 2));
  }
  // break the soft blobs up with noise so they read as stains, not shadows
  C.globalCompositeOperation = 'source-over';
  const img = C.getImageData(0, 0, W, H), px = img.data;
  const na = makeNoise(11), nb = makeNoise(12), nc = makeNoise(13), nd = makeNoise(14);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (px[o + 1] === 0) continue;
      const n = na(x / 14, y / 14) * 0.65 + nb(x / 4, y / 4) * 0.35;
      const v = (px[o + 1] / 255) * Math.max(0, Math.min(1, (n - 0.28) * 2.2));
      px[o] = px[o + 1] = px[o + 2] = v * 255;
    }
  }
  const sm = (a, b, t) => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
  const put = (x, y, v) => { const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = Math.max(0, Math.min(255, v * 255)); };
  // 4: soil washed out of the pit and trodden round the grate, densest at its edge (a
  // rounded square), ragged further out
  {
    const x0 = cx(4) - cell / 2, y0 = cy(4) - cell / 2;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const qx = Math.abs(x + 0.5 - cell / 2), qy = Math.abs(y + 0.5 - cell / 2);
        const q = Math.pow(qx ** 4 + qy ** 4, 0.25) * 0.7 + Math.hypot(qx, qy) * 0.3;
        const n = na((x0 + x) / 11, (y0 + y) / 11) * 0.55 + nb((x0 + x) / 3.5, (y0 + y) / 3.5) * 0.3 + nc((x0 + x) / 30, (y0 + y) / 30) * 0.15;
        const reach = 70 + 46 * nc((x0 + x) / 24 + 7, (y0 + y) / 24);       // ragged outer edge
        let v = sm(48, 55, q) * Math.pow(1 - sm(56, reach, q), 0.7) * Math.max(0, Math.min(1, 0.3 + (n - 0.25) * 1.7));
        v = Math.max(v, sm(48, 54, q) * (1 - sm(54, 64, q)) * (0.45 + 0.4 * n));   // grime in the joint round the frame
        if (v > 0) put(x0 + x, y0 + y, v * 0.95);
      }
    }
    C.putImageData(img, 0, 0);
    // crumbs of soil and leaf fragments
    for (let i = 0; i < 160; i++) {
      const a = rng.range(0, Math.PI * 2), r = 58 + Math.abs(rng.normal(0, 24));
      const x = cx(4) + Math.cos(a) * r, y = cy(4) + Math.sin(a) * r, rr = rng.range(0.8, 2.6);
      C.fillStyle = `rgba(255,255,255,${rng.range(0.5, 0.95)})`; C.beginPath(); C.ellipse(x, y, rr, rr * rng.range(0.4, 1), rng.range(0, 3), 0, Math.PI * 2); C.fill();
    }
  }
  // 5: mottled, trodden-in dirt: soft-edged, blotchy inside, with darker spots
  {
    const im2 = C.getImageData(0, 0, W, H), p2 = im2.data;
    const x0 = cx(5) - cell / 2, y0 = cy(5) - cell / 2;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const qx = (x + 0.5) / cell * 2 - 1, qy = (y + 0.5) / cell * 2 - 1;
        const r = Math.hypot(qx, qy) + 0.22 * (nd((x0 + x) / 40, (y0 + y) / 40) - 0.5);
        const edge = 1 - sm(0.45, 0.95, r);
        const n = nd((x0 + x) / 18, (y0 + y) / 18) * 0.5 + na((x0 + x) / 7, (y0 + y) / 7) * 0.3 + nb((x0 + x) / 2.5, (y0 + y) / 2.5) * 0.2;
        const v = edge * (0.35 + 0.65 * sm(0.36, 0.66, n));
        const o = ((y0 + y) * W + x0 + x) * 4;
        if (v > 0) p2[o] = p2[o + 1] = p2[o + 2] = Math.min(255, v * 0.95 * 255);
      }
    }
    C.putImageData(im2, 0, 0);
    for (let i = 0; i < 26; i++) {
      const x = cx(5) + rng.normal(0, 45), y = cy(5) + rng.normal(0, 45), r = rng.range(1.5, 4);
      C.fillStyle = `rgba(255,255,255,${rng.range(0.5, 0.85)})`; C.beginPath(); C.ellipse(x, y, r, r * rng.range(0.7, 1), rng.range(0, 3), 0, Math.PI * 2); C.fill();
    }
  }
  // 6, 7: halos round covers. Dirt packed into the joint round the frame (a thin dark
  // ring hugging it), rust and grime bled out of it into the stone (ragged, patchy, a
  // few centimetres), and a run-off lobe where water leaves the cover
  for (const k of [6, 7]) {
    const im = C.getImageData(0, 0, W, H), p = im.data;
    const x0 = cx(k) - cell / 2, y0 = cy(k) - cell / 2;
    const rIn = cell * 0.3;
    const lobe = rng.range(0, Math.PI * 2);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const qx = x + 0.5 - cell / 2, qy = y + 0.5 - cell / 2;
        // distance from the cover's edge (round, or a square with slightly eased corners)
        const q = (k === 6 ? Math.hypot(qx, qy) : Math.pow(qx ** 8 + qy ** 8, 1 / 8)) - rIn;
        if (q < -1) continue;
        const n = na((x0 + x) / 9, (y0 + y) / 9) * 0.55 + nb((x0 + x) / 3, (y0 + y) / 3) * 0.3 + nc((x0 + x) / 26, (y0 + y) / 26) * 0.15;
        const ang = Math.atan2(qy, qx);
        const run = Math.max(0, Math.cos(ang - lobe)) ** 3;
        const reach = 9 + 26 * nc((x0 + x) / 18 + 3, (y0 + y) / 18) + 30 * run;
        const joint = sm(-1, 0.5, q) * (1 - sm(2.5, 6, q)) * (0.7 + 0.3 * n);
        const bleed = sm(0, 2, q) * Math.pow(1 - sm(1, reach, q), 1.4) * Math.max(0, Math.min(1, 0.25 + (n - 0.3) * 1.8));
        const v = Math.max(joint * 0.95, bleed * 0.8);
        const o = ((y0 + y) * W + x0 + x) * 4;
        if (v > 0) p[o] = p[o + 1] = p[o + 2] = Math.min(255, v * 255);
      }
    }
    C.putImageData(im, 0, 0);
  }
  // 8: oil and grease: drops soaked into the stone (dark cores feathering out), overlapping
  // into a couple of soft smears, splashes round them; broken up by noise
  {
    C.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) blob(cx(8) + rng.normal(0, 20), cy(8) + rng.normal(0, 16), rng.range(18, 36), 0.2);
    for (let i = 0; i < 46; i++) {
      const a = rng.range(0, Math.PI * 2), r = Math.abs(rng.normal(0, 36));
      const x = cx(8) + Math.cos(a) * r, y = cy(8) + Math.sin(a) * r * 0.8;
      const rr = Math.max(1.5, Math.min(10, Math.abs(rng.normal(3.5, 2.4)) * (1.25 - r / 120)));
      const g = C.createRadialGradient(x, y, 0, x, y, rr * 1.8);
      const k = rng.range(0.35, 0.7);
      g.addColorStop(0, `rgba(255,255,255,${k})`); g.addColorStop(0.45, `rgba(255,255,255,${k * 0.8})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      C.fillStyle = g; C.beginPath(); C.arc(x, y, rr * 1.8, 0, Math.PI * 2); C.fill();
    }
    C.globalCompositeOperation = 'source-over';
    const im = C.getImageData(0, 0, W, H), p = im.data;
    const x0 = cx(8) - cell / 2, y0 = cy(8) - cell / 2;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = ((y0 + y) * W + x0 + x) * 4;
        if (p[o + 1] === 0) continue;
        const n = na((x0 + x) / 7, (y0 + y) / 7) * 0.6 + nb((x0 + x) / 2.5, (y0 + y) / 2.5) * 0.4;
        const v = Math.min(1, p[o + 1] / 255) * Math.max(0, Math.min(1, 0.35 + (n - 0.3) * 1.6));
        p[o] = p[o + 1] = p[o + 2] = v * 255;
      }
    }
    C.putImageData(im, 0, 0);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Creates all detail materials (registered and tracked by the caller). */
export function createDetailMaterials(renderer) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  // full-size textures from the start (neutral dusty iron), filled when the atlas is ready
  const N = ATLAS * ATLAS * 4;
  const alb = new Uint8Array(N), nor = new Uint8Array(N), orm = new Uint8Array(N);
  const rgba = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; // little-endian RGBA
  new Uint32Array(alb.buffer).fill(rgba(78, 76, 73));
  new Uint32Array(nor.buffer).fill(rgba(128, 128, 255));
  new Uint32Array(orm.buffer).fill(rgba(255, 200, 60));
  writeLeaves({ alb, nor, orm });   // leaves stay invisible until the atlas arrives
  const tAlb = dataTex(alb, ATLAS, ATLAS, true, aniso), tNor = dataTex(nor, ATLAS, ATLAS, false, aniso), ormTex = dataTex(orm, ATLAS, ATLAS, false, aniso);
  const fill = (res) => {
    alb.set(res.alb); nor.set(res.nor); orm.set(res.orm);
    tAlb.needsUpdate = tNor.needsUpdate = ormTex.needsUpdate = true;
  };
  let started = false;
  try {
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      const w = new Worker(new URL('./ironWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { fill(e.data); w.terminate(); };
      w.onerror = (e) => { e.preventDefault(); w.terminate(); fill(generateIronAtlas()); };
      w.postMessage('go');
      started = true;
    }
  } catch (e) { started = false; }
  if (!started) fill(generateIronAtlas());

  // cast iron and the fallen leaves (alpha-tested cut-outs, tinted by vertex colour)
  const iron = new THREE.MeshStandardMaterial({
    map: tAlb, normalMap: tNor, roughnessMap: ormTex, metalnessMap: ormTex,
    roughness: 1, metalness: 1, vertexColors: true, alphaTest: 0.5,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  iron.name = 'street.castIron';

  // stains: dark grime decals; vertex colour r = opacity, g = warmth (soil, brake dust)
  const stain = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.062, 0.057, 0.051), alphaMap: drawStains(), transparent: true, depthWrite: false, opacity: 0.88,
    roughness: 0.6, metalness: 0, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  stain.name = 'street.stain';
  stain.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', /* glsl */`
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.5, 1.08, 0.7 ), vColor.g );
  diffuseColor.a *= vColor.r;
#endif`)
      // opacities above 1 (heavier stains) saturate: alpha past 1 would subtract the
      // paving behind
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a = min( diffuseColor.a, 1.0 );');
  };
  stain.customProgramCacheKey = () => 'street-stain-3';

  return { iron, stain };
}
