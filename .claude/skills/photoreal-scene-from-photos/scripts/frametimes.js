// frametimes.js: in-page frame-time, hitch, GPU/CPU and heap sampler for a WebGL app.
// Evaluate it in the page (shoot.py --pre-file / --eval-file, or paste into DevTools).
//
//   One shot (sample N seconds, then return the summary):
//     shoot.py --params "speed=40" --shots 0 --settle 0 --fps 30 \
//              --pre "window.__FT={seconds:30, warmup:5}" --eval-file frametimes.js
//   Two phase (install at ready, sample during --settle, summary at the end):
//     shoot.py --params "speed=40" --shots 0 --fps 30 --pre-file frametimes.js --settle 30 --eval-file frametimes.js
//
// The first evaluation installs the sampler; a later one returns the summary (JSON string).
// Config, set before the first evaluation: window.__FT = {
//   seconds: 0      >0: one-shot mode, resolve the summary after this many seconds
//   warmup: 0       ignore the first N seconds (JIT warm-up, shader first use, streaming burst)
//   hitchMs: 50     log frame intervals longer than this (with where() and CPU time)
//   cpuBudget: 20, gpuBudget: 28   count frames over these (ms); 28/20 suit a 30 fps target
//   where: null     () => label for a hitch, e.g. () => window.__app.cameraS (route metres)
// }
// Optional app hooks it uses when present:
//   window.__frameEnd?.(cpuMs, gpuMs)   called by the app at the end of EVERY frame it renders.
//     Prefer it: an app that pumps frames from a timer while Chrome withholds animation frames
//     (common for 1-3 s after a cold start) is invisible to a requestAnimationFrame sampler,
//     whose first interval then spans the whole hold (0.35-3.6 s where the app saw <= 49 ms).
//     gpuMs may be the newest EXT_disjoint_timer_query result (it arrives a few frames late).
//   window.__app.renderer.info.render   three.js draw calls / triangles per frame.
//   window.__app.where()                hitch label when C.where is not given.
// No allocation per frame (typed arrays); records are allocated only for hitches.
(() => {
  const C = Object.assign({ seconds: 0, warmup: 0, hitchMs: 50, cpuBudget: 20, gpuBudget: 28, maxHitches: 40, where: null }, window.__FT || {});
  if (window.__ft) return window.__ft.summary();

  const N = 1 << 16;
  const iv = new Float32Array(N), cpu = new Float32Array(N), gpu = new Float32Array(N);
  const calls = new Float32Array(N), tris = new Float32Array(N);
  let n = 0, last = 0, first = 0, src = 'raf', stopped = false;
  const t0 = performance.now(), startAt = t0 + Math.max(0, C.warmup) * 1000;
  const hitches = [], heap = [], gc = [], loaf = [];
  const info = () => { const a = window.__app; return a && a.renderer && a.renderer.info ? a.renderer.info.render : null; };
  const where = () => {
    try {
      if (C.where) return C.where();
      const a = window.__app;
      return a && typeof a.where === 'function' ? a.where() : null;
    } catch (e) { return null; }
  };

  function sample(now, c, g) {
    if (stopped || now < startAt) return;
    if (!last) { last = first = now; return; }   // (the first frame only starts the clock)
    if (n >= N) return;
    const d = now - last; last = now;
    const i = n++;
    iv[i] = d; cpu[i] = c; gpu[i] = g;
    const r = info();
    calls[i] = r ? r.calls : -1; tris[i] = r ? r.triangles / 1e6 : -1;
    if (d > C.hitchMs && hitches.length < C.maxHitches) {
      hitches.push({ t: +((now - t0) / 1000).toFixed(2), ms: +d.toFixed(1), cpu: c >= 0 ? +c.toFixed(1) : null, gpu: g >= 0 ? +g.toFixed(1) : null, where: where() });
    }
  }

  // app hook: switches the sampler to app frames on the first call
  window.__frameEnd = (c, g) => {
    if (src !== 'hook') { src = 'hook'; n = 0; last = 0; hitches.length = 0; }
    sample(performance.now(), c == null ? -1 : c, g == null ? -1 : g);
  };
  const raf = () => {
    if (stopped) return;
    if (src === 'raf') sample(performance.now(), -1, -1);
    requestAnimationFrame(raf);   // (goes through shoot.py's --fps cap when installed: one sample per app slot)
  };
  requestAnimationFrame(raf);

  // heap: performance.memory (precise with Chrome's --enable-precise-memory-info, which shoot.py passes)
  let lastHeap = 0;
  const heapTimer = setInterval(() => {
    if (!performance.memory || performance.now() < startAt) return;
    const h = performance.memory.usedJSHeapSize / 1048576, t = (performance.now() - t0) / 1000;
    if (lastHeap && h < lastHeap - 2) gc.push(lastHeap - h);   // a drop of > 2 MB is a collection
    lastHeap = h;
    if (heap.length < 4096) heap.push([t, h]);
  }, 250);

  // long animation frames: which scripts made a long frame (covers timers and promise callbacks too)
  try {
    const type = (PerformanceObserver.supportedEntryTypes || []).includes('long-animation-frame') ? 'long-animation-frame' : null;
    if (type) new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (stopped || e.duration < C.hitchMs || e.startTime < startAt) continue;
        loaf.push({ t: +((e.startTime - t0) / 1000).toFixed(2), ms: Math.round(e.duration), block: Math.round(e.blockingDuration || 0),
          scripts: (e.scripts || []).filter((s) => s.duration >= 4).sort((a, b) => b.duration - a.duration).slice(0, 3)
            .map((s) => `${String(s.sourceURL || '').split('/').pop().split('?')[0]}:${s.sourceFunctionName || s.invoker || '?'} ${Math.round(s.duration)}ms`) });
        if (loaf.length > 64) { loaf.sort((a, b) => b.ms - a.ms); loaf.length = 32; }
      }
    }).observe({ type, buffered: false });
  } catch (e) { /* not supported */ }

  const pct = (arr, keep) => {
    const v = Array.from(arr.subarray(0, n)).filter(keep).sort((a, b) => a - b);
    if (!v.length) return null;
    const at = (f) => +v[Math.min(v.length - 1, Math.floor(f * v.length))].toFixed(2);
    return { n: v.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: +v[v.length - 1].toFixed(2), mean: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) };
  };
  const over = (arr, lim) => { let k = 0; for (let i = 0; i < n; i++) if (arr[i] > lim) k++; return k; };

  window.__ft = {
    reset() { n = 0; last = 0; hitches.length = 0; heap.length = 0; gc.length = 0; loaf.length = 0; lastHeap = 0; return 'reset'; },
    stop() { stopped = true; clearInterval(heapTimer); return 'stopped'; },
    summary() {
      const secs = n && last > first ? (last - first) / 1000 : 0;
      const hs = heap.map((x) => x[1]);
      const out = {
        source: src === 'hook' ? 'app frames (window.__frameEnd)' : 'requestAnimationFrame',
        capped: !!window.__origRAF, seconds: +secs.toFixed(1), frames: n, fps: secs ? +(n / secs).toFixed(1) : null,
        intervalMs: pct(iv, () => true),
        over: { '33ms': over(iv, 33.4), '50ms': over(iv, 50), '60ms': over(iv, 60), '100ms': over(iv, 100) },
        cpuMs: pct(cpu, (x) => x >= 0), gpuMs: pct(gpu, (x) => x >= 0),
        cpuOverBudget: over(cpu, C.cpuBudget), gpuOverBudget: over(gpu, C.gpuBudget),
        calls: pct(calls, (x) => x >= 0), trianglesM: pct(tris, (x) => x >= 0),
        heapMB: hs.length ? { start: Math.round(hs[0]), end: Math.round(hs[hs.length - 1]), min: Math.round(Math.min(...hs)), max: Math.round(Math.max(...hs)) } : null,
        gc: { n: gc.length, mb: Math.round(gc.reduce((s, x) => s + x, 0)), perMin: secs ? +(gc.length * 60 / secs).toFixed(1) : null },
        hitches,
        longFrames: loaf.slice().sort((a, b) => b.ms - a.ms).slice(0, 8),
      };
      return JSON.stringify(out);
    },
  };
  if (C.seconds > 0) {
    return new Promise((res) => setTimeout(() => { const s = window.__ft.summary(); window.__ft.stop(); res(s); }, (C.seconds + Math.max(0, C.warmup)) * 1000));
  }
  return 'frametimes: sampling (evaluate this file again for the summary)';
})()
