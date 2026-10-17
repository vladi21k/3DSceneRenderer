import { buildPrintAtlas, buildLitAtlas } from './prints.js';

// Draws the print atlas and the light-box emission atlas off the main thread and hands
// them back as vertically flipped ImageBitmaps (texture v = 1 - canvas y, like flipY).

const flip = (c) => createImageBitmap(c, { imageOrientation: 'flipY' });

self.onmessage = async () => {
  try {
    const t0 = performance.now();
    const atlas = buildPrintAtlas();
    const lit = buildLitAtlas(atlas.canvas);
    const [a, l] = await Promise.all([flip(atlas.canvas), flip(lit)]);
    self.postMessage({ atlas: a, lit: l, ms: performance.now() - t0 }, [a, l]);
  } catch (e) {
    self.postMessage({ error: String(e && e.stack || e) });
  }
};
