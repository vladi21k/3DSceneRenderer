// Texture strip decoding for the crowd cast (mh/cast.js), off the main thread: a WebP strip of layers
// (and its separate coverage strip) is decoded, each layer's rows flipped so v = 0 is its bottom row,
// optionally box-filtered to a lower resolution, and the RGBA bytes are sent back (transferred).
// No imports: plain module worker.

async function decode(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close();
  return d;
}

self.onmessage = async (e) => {
  const { id, url, alpha, S, layers, scale } = e.data;
  try {
    const [rgb, al] = await Promise.all([decode(url), alpha ? decode(alpha) : null]);
    const D = S / scale, layerBytes = D * D * 4;
    const out = new Uint8Array(layerBytes * layers);
    for (let k = 0; k < layers; k++) {
      const dst = k * layerBytes;
      for (let y = 0; y < D; y++) {
        const dstRow = dst + (D - 1 - y) * D * 4;
        if (scale === 1) {
          const src = (k * S + y) * S * 4;
          for (let x = 0; x < D; x++) {
            const o = src + x * 4, q = dstRow + x * 4;
            out[q] = rgb[o]; out[q + 1] = rgb[o + 1]; out[q + 2] = rgb[o + 2]; out[q + 3] = al ? al[o] : 255;
          }
          continue;
        }
        for (let x = 0; x < D; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let sy = 0; sy < scale; sy++) {
            const src = ((k * S + y * scale + sy) * S + x * scale) * 4;
            for (let sx = 0; sx < scale; sx++) {
              const o = src + sx * 4;
              r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2];
              a += al ? al[o] : 255;
            }
          }
          const n = scale * scale, q = dstRow + x * 4;
          out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = a / n;
        }
      }
    }
    self.postMessage({ id, data: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
