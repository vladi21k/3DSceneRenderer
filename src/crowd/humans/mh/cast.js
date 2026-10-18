import * as THREE from 'three';

// Loader for the character cast built by tools/blender/mh_build.py (assets/humans_mh/):
//   cast.json      metadata (format description in cast.json.format)
//   cast.bin.gz    geometry of every character (gzip; one vertex set per character shared by its 4 LODs)
//   tex/*.webp     texture arrays as vertical strips of layers (albedo RGB + separate coverage strips, normals)
//
// loadCast(baseUrl) -> { doc, chars: [{ ...meta, geometry }], albedo: DataArrayTexture, normal: DataArrayTexture,
//                        layerRough: Float32Array }
// geometry attributes: position (float, dequantised), aNrm (int8x4 norm: normal + AO), uv (uint16x2 norm),
//   aBoneI (uint8x4), aBoneW (uint8x4 norm), aTex (uint8x4: albedo layer, normal layer | 255, region, flags);
//   geometry.userData.lods[l] = {start, count} index draw ranges.

async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  if (url.endsWith('.gz') && typeof DecompressionStream !== 'undefined') {
    // served as a plain file: unzip here (a server sending Content-Encoding: gzip would have done it)
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf.buffer;
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(ds).arrayBuffer();
  }
  return r.arrayBuffer();
}

async function decodeStrip(url, S) {
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

/** Builds a DataArrayTexture from the strips (layer images top row first; uploaded with flipY so v = 0 is the
 *  bottom row of each layer, as the exported UVs expect). */
async function arrayTexture(base, strips, S, total, srgb) {
  const data = new Uint8Array(S * S * 4 * total);
  let layer = 0;
  const layerBytes = S * S * 4;
  const jobs = strips.map(async (st, si) => {
    const first = strips.slice(0, si).reduce((a, b) => a + b.layers, 0);
    const [rgb, alpha] = await Promise.all([decodeStrip(base + st.file, S), st.alpha ? decodeStrip(base + st.alpha, S) : null]);
    for (let k = 0; k < st.layers; k++) {
      const dst = (first + k) * layerBytes;
      // flip rows: image row 0 (top) -> texture row S-1
      for (let y = 0; y < S; y++) {
        const srcRow = (k * S + y) * S * 4;
        const dstRow = dst + (S - 1 - y) * S * 4;
        data.set(rgb.subarray(srcRow, srcRow + S * 4), dstRow);
        if (alpha) {
          for (let x = 0; x < S; x++) data[dstRow + x * 4 + 3] = alpha[srcRow + x * 4];
        } else {
          for (let x = 0; x < S; x++) data[dstRow + x * 4 + 3] = 255;
        }
      }
    }
  });
  await Promise.all(jobs);
  layer = total;
  const t = new THREE.DataArrayTexture(data, S, S, layer);
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

export async function loadCast(baseUrl) {
  const doc = await fetch(baseUrl + 'cast.json').then((r) => { if (!r.ok) throw new Error('cast.json ' + r.status); return r.json(); });
  const tex = doc.textures;
  const [buf, albedo, normal] = await Promise.all([
    fetchBin(baseUrl + 'cast.bin.gz'),
    arrayTexture(baseUrl, tex.albedo, tex.size, tex.nAlbedo, true),
    tex.nNormal ? arrayTexture(baseUrl, tex.normal, tex.size, tex.nNormal, false) : Promise.resolve(null),
  ]);
  if (doc.byteLength && buf.byteLength !== doc.byteLength) throw new Error('cast.bin does not match cast.json');
  const chars = doc.characters.map((c) => ({ ...c, geometry: buildGeometry(c, buf) }));
  const layerRough = new Float32Array(tex.layers.map((l) => l.rough));
  return { doc, chars, albedo, normal, layerRough };
}

function buildGeometry(c, buf) {
  const n = c.vertexCount;
  const g = new THREE.BufferGeometry();
  const q = new Int16Array(buf, c.position.offset, n * 3);
  const pos = new Float32Array(n * 3);
  const mn = c.position.min, rg = c.position.range;
  for (let i = 0; i < n * 3; i++) {
    const k = i % 3;
    pos[i] = mn[k] + ((q[i] + 32767) / 65534) * rg[k];
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const A = c.attributes;
  g.setAttribute('aNrm', new THREE.BufferAttribute(new Int8Array(buf, A.normal, n * 4), 4, true));
  g.setAttribute('uv', new THREE.BufferAttribute(new Uint16Array(buf, A.uv, n * 2), 2, true));
  g.setAttribute('aBoneI', new THREE.BufferAttribute(new Uint8Array(buf, A.skinIndex, n * 4), 4, false));
  g.setAttribute('aBoneW', new THREE.BufferAttribute(new Uint8Array(buf, A.skinWeight, n * 4), 4, true));
  g.setAttribute('aTex', new THREE.BufferAttribute(new Uint8Array(buf, A.tex, n * 4), 4, false));
  // (three flat-shades lit materials without a 'normal' attribute; the shader reads aNrm)
  g.setAttribute('normal', g.attributes.aNrm);
  const IT = c.index.type === 'u16' ? Uint16Array : Uint32Array;
  g.setIndex(new THREE.BufferAttribute(new IT(buf, c.index.offset, c.index.count), 1));
  g.userData.lods = c.lods;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, c.height / 2, 0), c.height * 0.75);
  return g;
}
