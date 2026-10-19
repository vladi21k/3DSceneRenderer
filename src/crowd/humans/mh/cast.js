import * as THREE from 'three';

// Loader for the character cast built by tools/blender/mh_build.py (assets/humans_mh/):
//   cast.json      metadata (format description in cast.json.format)
//   cast.bin.gz    geometry of every character (gzip; one vertex set per character shared by its 4 LODs)
//   tex/*.webp     texture arrays as vertical strips of layers (albedo RGB + separate coverage strips, normals),
//                  decoded and flipped in module workers (decode.worker.js; on the main thread where those fail)
//
// loadCast(baseUrl) -> { doc, chars, buf, albedo: DataArrayTexture, normal: DataArrayTexture | null, layerRough,
//   timing: ms from the start to cast.bin / albedo / normal done, raw views, total }
//   chars[i] = the character's cast.json entry plus `raw`: typed-array views of its vertex data
//   { n, pos (Float32Array, dequantised), nrm (Int8 x4: normal + AO), uv (Uint16 x2), bi, bw, tex (Uint8 x4), index }
// The renderer merges every character (and its runtime accessories) into one vertex / index buffer (merge()).

export const VERTEX_ATTRS = [
  // name, components, array type, normalised
  ['position', 3, Float32Array, false],
  ['aNrm', 4, Int8Array, true],
  ['uv', 2, Uint16Array, true],
  ['aBoneI', 4, Uint8Array, false],
  ['aBoneW', 4, Uint8Array, true],
  ['aTex', 4, Uint8Array, false],
];
const RAW_KEY = { position: 'pos', aNrm: 'nrm', uv: 'uv', aBoneI: 'bi', aBoneW: 'bw', aTex: 'tex' };

async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  // served as a plain file: unzip here (a server sending Content-Encoding: gzip would have done it)
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf.buffer;
  const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}

async function decodeStrip(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close();
  return d;          // RGBA, rows top to bottom; layer k = rows [k*S, (k+1)*S)
}

// strips are decoded (and flipped) in a few module workers, off the main thread; where workers are not
// available, here
let _pool = null;
function decodePool() {
  if (_pool !== null) return _pool;
  try {
    const url = new URL('./decode.worker.js', import.meta.url);
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) >> 1));
    const workers = [];
    for (let i = 0; i < n; i++) workers.push(new Worker(url, { type: 'module' }));
    const waiting = new Map();
    let next = 0, seq = 0, live = 0;
    for (const w of workers) {
      w.onmessage = (e) => {
        const job = waiting.get(e.data.id);
        if (!job) return;
        waiting.delete(e.data.id);
        if (--live === 0) { for (const x of workers) x.terminate(); _pool = null; }
        if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.data);
      };
      w.onerror = (e) => {
        for (const j of waiting.values()) j.reject(new Error('decode worker failed'));
        waiting.clear();
        for (const x of workers) x.terminate();
        _pool = undefined;              // (no workers here: decode on the main thread from now on)
        e.preventDefault && e.preventDefault();
      };
    }
    _pool = {
      run(msg) {
        return new Promise((resolve, reject) => {
          const id = ++seq;
          waiting.set(id, { resolve, reject });
          live++;
          workers[next++ % workers.length].postMessage({ ...msg, id });
        });
      },
    };
  } catch (e) {
    _pool = undefined;
  }
  return _pool;
}

/** One strip's layers as RGBA bytes (rows flipped, box-filtered by `scale`): in a worker, else here. */
async function stripLayers(base, st, S, scale) {
  const pool = decodePool();
  if (pool) {
    try {
      return await pool.run({ url: new URL(base + st.file, location.href).href, alpha: st.alpha ? new URL(base + st.alpha, location.href).href : null,
        S, layers: st.layers, scale });
    } catch (e) { /* decoded here instead */ }
  }
  return null;
}

/** DataArrayTexture from the strips (layer images top row first; rows flipped so v = 0 is the bottom row
 *  of each layer, as the exported UVs expect). `scale` 2 halves the resolution (box filter). */
async function arrayTexture(base, strips, S, total, srgb, scale = 1) {
  const D = S / scale;
  const data = new Uint8Array(D * D * 4 * total);
  const layerBytes = D * D * 4;
  const jobs = strips.map(async (st, si) => {
    const first = strips.slice(0, si).reduce((a, b) => a + b.layers, 0);
    const done = await stripLayers(base, st, S, scale);
    if (done) { data.set(done, first * layerBytes); return; }
    const [rgb, alpha] = await Promise.all([decodeStrip(base + st.file), st.alpha ? decodeStrip(base + st.alpha) : null]);
    for (let k = 0; k < st.layers; k++) {
      const dst = (first + k) * layerBytes;
      for (let y = 0; y < D; y++) {
        const dstRow = dst + (D - 1 - y) * D * 4;
        for (let x = 0; x < D; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let sy = 0; sy < scale; sy++) {
            const src = ((k * S + y * scale + sy) * S + x * scale) * 4;
            for (let sx = 0; sx < scale; sx++) {
              const o = src + sx * 4;
              r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2];
              a += alpha ? alpha[o] : 255;
            }
          }
          const n = scale * scale, o = dstRow + x * 4;
          data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = a / n;
        }
      }
    }
  });
  await Promise.all(jobs);
  const t = new THREE.DataArrayTexture(data, D, D, total);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  // the CPU copy is not needed once uploaded
  t.onUpdate = () => { t.image.data = null; };
  return t;
}

export async function loadCast(baseUrl, { texScale = 1 } = {}) {
  const t0 = performance.now();
  const timing = {};
  const doc = await fetch(baseUrl + 'cast.json').then((r) => { if (!r.ok) throw new Error('cast.json ' + r.status); return r.json(); });
  const tex = doc.textures;
  const done = (k) => (v) => { timing[k] = Math.round(performance.now() - t0); return v; };
  const [buf, albedo, normal] = await Promise.all([
    fetchBin(baseUrl + 'cast.bin.gz').then(done('bin')),
    arrayTexture(baseUrl, tex.albedo, tex.size, tex.nAlbedo, true, texScale).then(done('albedo')),
    tex.nNormal ? arrayTexture(baseUrl, tex.normal, tex.size, tex.nNormal, false, texScale).then(done('normal')) : Promise.resolve(null),
  ]);
  if (doc.byteLength && buf.byteLength !== doc.byteLength) throw new Error('cast.bin does not match cast.json');
  const t1 = performance.now();
  const chars = doc.characters.map((c) => ({ ...c, raw: rawViews(c, buf) }));
  timing.raw = Math.round(performance.now() - t1);
  timing.total = Math.round(performance.now() - t0);
  const layerRough = new Float32Array(tex.layers.map((l) => l.rough));
  return { doc, chars, albedo, normal, layerRough, timing };
}

function rawViews(c, buf) {
  const n = c.vertexCount;
  const q = new Int16Array(buf, c.position.offset, n * 3);
  const pos = new Float32Array(n * 3);
  const mn = c.position.min, rg = c.position.range;
  for (let i = 0; i < n * 3; i++) {
    const k = i % 3;
    pos[i] = mn[k] + ((q[i] + 32767) / 65534) * rg[k];
  }
  const A = c.attributes;
  const IT = c.index.type === 'u16' ? Uint16Array : Uint32Array;
  return {
    n, pos,
    nrm: new Int8Array(buf, A.normal, n * 4),
    uv: new Uint16Array(buf, A.uv, n * 2),
    bi: new Uint8Array(buf, A.skinIndex, n * 4),
    bw: new Uint8Array(buf, A.skinWeight, n * 4),
    tex: new Uint8Array(buf, A.tex, n * 4),
    index: new IT(buf, c.index.offset, c.index.count),
  };
}

/**
 * Merge meshes (each {n, pos, nrm, uv, bi, bw, tex, index} in the raw layout) into one indexed
 * geometry with 32-bit indices. Returns {geometry, ranges: [{vbase, ibase}]}: mesh k's index i is at
 * ranges[k].ibase + i and refers to vertex ranges[k].vbase + index[i].
 */
export function mergeMeshes(meshes) {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.n; ni += m.index.length; }
  const arrays = {};
  for (const [name, k, T] of VERTEX_ATTRS) arrays[name] = new T(nv * k);
  const index = new Uint32Array(ni);
  const ranges = [];
  let v0 = 0, i0 = 0;
  for (const m of meshes) {
    for (const [name, k] of VERTEX_ATTRS) arrays[name].set(m[RAW_KEY[name]].subarray(0, m.n * k), v0 * k);
    const src = m.index;
    for (let i = 0; i < src.length; i++) index[i0 + i] = src[i] + v0;
    ranges.push({ vbase: v0, ibase: i0 });
    v0 += m.n; i0 += src.length;
  }
  const g = new THREE.BufferGeometry();
  for (const [name, k, , norm] of VERTEX_ATTRS) g.setAttribute(name, new THREE.BufferAttribute(arrays[name], k, norm));
  // (three flat-shades lit materials without a 'normal' attribute; the shader reads aNrm)
  g.setAttribute('normal', g.attributes.aNrm);
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return { geometry: g, ranges, vertices: nv, indices: ni };
}
