import { generateIronAtlas } from './ironAtlas.js';

// Builds the cast-iron detail atlas off the main thread (see ironAtlas.js).
self.onmessage = () => {
  const r = generateIronAtlas();
  self.postMessage(r, [r.alb.buffer, r.nor.buffer, r.orm.buffer]);
};
