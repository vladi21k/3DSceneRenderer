import { buildPrintAtlas, buildLitAtlas } from './prints.js';

// Worker entry: paints the print atlas and the lit atlas off the main thread (see
// materials.js printAtlases) and returns them as bitmaps flipped for upload (a bitmap
// ignores the GL's flipY).
self.onmessage = async () => {
  try {
    const t0 = performance.now();
    const atlas = buildPrintAtlas();
    const t1 = performance.now();
    const lit = buildLitAtlas(atlas.canvas);
    const t2 = performance.now();
    const opts = { imageOrientation: 'flipY', premultiplyAlpha: 'none' };
    const [a, l] = await Promise.all([createImageBitmap(atlas.canvas, opts), createImageBitmap(lit, opts)]);
    self.postMessage({ atlas: a, lit: l, ms: { atlas: +(t1 - t0).toFixed(1), lit: +(t2 - t1).toFixed(1) } }, [a, l]);
  } catch (err) {
    self.postMessage({ error: String((err && err.stack) || err) });
  }
};
