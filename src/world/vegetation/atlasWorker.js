import { paintAtlas } from './atlasPaint.js';

// Worker entry: paints one pass of the foliage atlas off the main thread (see leafAtlas.js).
self.onmessage = (e) => {
  const { seed, kind } = e.data;
  try {
    const out = paintAtlas(seed, kind);
    self.postMessage(out, out.levels.map((l) => l.data.buffer));
  } catch (err) {
    self.postMessage({ error: String(err && err.stack || err) });
  }
};
