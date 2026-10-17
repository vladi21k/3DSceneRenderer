import * as THREE from 'three';
import { ATLAS_GRID } from './species.js';
import { paintAtlas, SIZE } from './atlasPaint.js';

// Foliage atlas textures (painting and mips: atlasPaint.js).
//
// The colour and the normal+gloss passes are painted in two module workers in parallel,
// while the main thread grows the tree templates; if workers are unavailable the passes
// run here. Both come back with their full mip chains, which are uploaded explicitly
// (no GPU mip generation: the coverage-preserving alpha and the alpha-weighted colour
// must survive down the chain).

function runPass(seed, kind) {
  return new Promise((resolve, reject) => {
    const local = () => { try { resolve(paintAtlas(seed, kind)); } catch (e) { reject(e); } };
    let w = null;
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return local();
      w = new Worker(new URL('./atlasWorker.js', import.meta.url), { type: 'module' });
    } catch (e) { return local(); }
    w.onmessage = (e) => {
      w.terminate();
      if (e.data && e.data.error) { console.warn('[vegetation] atlas worker failed, painting here:', e.data.error); local(); } else resolve(e.data);
    };
    w.onerror = (e) => { e.preventDefault?.(); w.terminate(); local(); };
    w.postMessage({ seed, kind });
  });
}

function dataTexture(levels, srgb, aniso) {
  const t = new THREE.DataTexture(levels[0].data, levels[0].width, levels[0].height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.mipmaps = levels;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.flipY = false;
  t.unpackAlignment = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * Start painting the atlas; resolves to { map (straight sRGB colour, coverage alpha),
 * normalMap (normal x, y + gloss), size, coverage, ms }.
 */
export async function buildLeafAtlas(renderer, seed = 1) {
  const t0 = performance.now();
  const [col, nrm] = await Promise.all([runPass(seed, 'color'), runPass(seed, 'normal')]);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const map = dataTexture(col.levels, true, aniso);
  const normalMap = dataTexture(nrm.levels, false, aniso);
  return { map, normalMap, size: SIZE, coverage: col.coverage, ms: { color: col.ms, normal: nrm.ms, wall: +(performance.now() - t0).toFixed(1) } };
}

/** Blank 1 x 1 stand-ins with the atlas textures' formats (colour: no coverage), used until
 *  the painting finishes; the shader programs are the same. */
export function blankAtlas() {
  const tex = (rgba, srgb) => {
    const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: tex([0, 0, 0, 0], true), normalMap: tex([128, 128, 255, 128], false), blank: true };
}

/** UV rectangle of atlas cell i: [u0, v0, u1, v1] (v0 = attachment edge). */
export function cellRect(i) {
  const x = i % ATLAS_GRID, y = Math.floor(i / ATLAS_GRID);
  return [x / ATLAS_GRID, y / ATLAS_GRID, (x + 1) / ATLAS_GRID, (y + 1) / ATLAS_GRID];
}
