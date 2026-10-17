// Synthesis worker: runs one part of the sample-bank job list off the main thread and
// streams each finished buffer back (transferred, not copied).
import { synthJobs } from './jobs.js';

self.onmessage = async (ev) => {
  const { sr, part } = ev.data;
  try {
    for await (const it of synthJobs(sr, part)) {
      const chans = it.chans.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()));
      self.postMessage({ type: 'buffer', name: it.name, chans, rate: it.rate }, chans.map((c) => c.buffer));
    }
    self.postMessage({ type: 'done' });
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.stack) || e) });
  }
};
