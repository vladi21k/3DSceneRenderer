import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { ATLAS, IRON_REGIONS, canvas, makeNoise, generateIronAtlas, writeLeaves } from './ironAtlas.js';

// Procedural textures for street details:
//  - cast-iron atlas (albedo / normal / ORM): round manhole cover with concentric
//    rings, square tree grate with radial slots over soil, gully grate, slotted track
//    drain cover, chequer-plate utility cover, a small valve cover and four fallen-leaf
//    cut-outs (drawn with the iron, tinted by vertex colour). Generated in a worker
//    (ironAtlas.js) so start-up is not blocked; neutral iron until it arrives;
//  - stain atlas (alpha blotches, gum spots, drip marks).

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
function drawStains() {
  // grey levels on black (alphaMap reads the green channel); blobs accumulate additively
  const S = 512, c = canvas(S, S), C = c.getContext('2d');
  C.fillStyle = '#000'; C.fillRect(0, 0, S, S);
  C.globalCompositeOperation = 'lighter';
  const rng = RNG.from('street-stains');
  const cell = S / 2;
  // 0: broad water / dirt stain, 1: oil drip patch, 2: gum spots, 3: streaky drip trail
  const blob = (cx, cy, r, a) => {
    const g = C.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.6, `rgba(255,255,255,${a * 0.6})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    C.fillStyle = g; C.beginPath(); C.arc(cx, cy, r, 0, Math.PI * 2); C.fill();
  };
  for (let i = 0; i < 40; i++) blob(cell * 0.5 + rng.normal(0, 26), cell * 0.5 + rng.normal(0, 26), rng.range(14, 46), 0.12);
  for (let i = 0; i < 26; i++) blob(cell * 1.5 + rng.normal(0, 20), cell * 0.5 + rng.normal(0, 14), rng.range(8, 30), 0.2);
  for (let i = 0; i < 6; i++) blob(cell * 1.5 + rng.normal(0, 8), cell * 0.5 + rng.normal(0, 8), rng.range(6, 12), 0.35);
  for (let i = 0; i < 70; i++) {
    const x = cell * 0.5 + rng.normal(0, 40), y = cell * 1.5 + rng.normal(0, 40), r = rng.range(1.6, 4.5);
    C.fillStyle = `rgba(255,255,255,${rng.range(0.55, 0.9)})`; C.beginPath(); C.ellipse(x, y, r, r * rng.range(0.7, 1), rng.range(0, 3), 0, Math.PI * 2); C.fill();
  }
  for (let i = 0; i < 90; i++) {
    const t = rng.next();
    blob(cell * 1.5 + rng.normal(0, 7), cell + 12 + t * (cell - 24), rng.range(4, 12), 0.16 + 0.12 * (1 - Math.abs(t - 0.5) * 2));
  }
  // break the soft blobs up with noise so they read as stains, not shadows
  C.globalCompositeOperation = 'source-over';
  const img = C.getImageData(0, 0, S, S), px = img.data;
  const na = makeNoise(11), nb = makeNoise(12);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      if (px[o + 1] === 0) continue;
      const n = na(x / 14, y / 14) * 0.65 + nb(x / 4, y / 4) * 0.35;
      const v = (px[o + 1] / 255) * Math.max(0, Math.min(1, (n - 0.28) * 2.2));
      px[o] = px[o + 1] = px[o + 2] = v * 255;
    }
  }
  C.putImageData(img, 0, 0);
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

  const stain = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.075, 0.068, 0.06), alphaMap: drawStains(), transparent: true, depthWrite: false, opacity: 0.7,
    roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  stain.name = 'street.stain';

  return { iron, stain };
}
