// Frame-time monitor (core): frame interval percentiles since the app became ready
// (`stats().frames`) and a hitch log (`app.hitches()`, `app.hitchReport()`).
//
// A frame interval (callback start to callback start) over HITCH_MS is logged with what
// ran in the frame before it: each module's update, world streaming (build, background
// compile, reveal), render (and the sun's shadow passes inside it), the programs created
// in that frame (a program created inside render is a synchronous compile), the GPU time
// of that frame, heap change (a drop of a few MB is a garbage collection), the reveal and
// proxy-merge state, post's section timers under prof=1, and the browser's
// long-animation-frame script attribution, which also covers work outside the frame
// callback (timers, promise callbacks). Every time is shown next to its usual value (the
// median of the last BASE smooth frames), so one module's spike stands out from a frame
// in which everything ran slower at once (the machine busy with other work: CPU cores or
// GPU shared with other processes).
//
// Cost: a performance.now() pair per module per frame and a few typed-array writes;
// records are only allocated for hitches.

const HITCH_MS = 50;
const RING = 4096;          // frame intervals kept for the percentiles
const MAX_HITCHES = 120;
const LOAF_KEEP = 96;
const BASE = 128;           // smooth frames kept for the usual values

const r1 = (x) => Math.round(x * 10) / 10;

export class FrameMonitor {
  constructor(app, names) {
    this.app = app;
    this.names = names;                         // stage names: updaters..., world, render
    this.st = new Float32Array(names.length);   // this frame's stage times (ms)
    this.iv = new Float32Array(RING);           // frame intervals since ready (ms)
    this.ivN = 0;
    this.log = [];
    this.count = 0;                             // hitches since ready (the log keeps the newest)
    this.lastT = 0;
    this.lastFrame = -1;
    this.readyT = 0;
    // scalars of the frame being run (read back when the next interval turns out long)
    this.cpu = 0; this.shadowMs = 0; this.cascades = -1;
    this.progUpd = 0; this.progRender = 0; this.progNames = null;
    this.reveal = 0; this.build = 0; this.queue = 0;
    this.heap = 0; this.heapStart = 0; this.calls = 0; this.tris = 0; this.proxy = 0;
    for (const p of app.renderer.info.programs || []) p.__mon = 1;   // start-up programs
    this._prog = this._programs();
    // usual values: rings of the last BASE smooth frames (a hitch frame is left out)
    this.base = { cpu: new Float32Array(BASE), shadow: new Float32Array(BASE), gpu: new Float32Array(BASE), calls: new Float32Array(BASE) };
    this.baseSt = names.map(() => new Float32Array(BASE));
    this.baseN = 0;
    this._scratch = new Float32Array(BASE);
    this._measured = false;
    this._pend = [];                            // hitches waiting for their GPU time
    this.loaf = [];
    this._observe();
  }

  _observe() {
    const types = (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
    const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
    if (!type) return;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const scripts = (e.scripts || []).filter((s) => s.duration >= 4).sort((a, b) => b.duration - a.duration).slice(0, 4).map((s) => ({
            type: s.invokerType, inv: String(s.invoker || '').slice(0, 60), fn: s.sourceFunctionName || '',
            src: `${String(s.sourceURL || '').split('/').pop().split('?')[0]}:${s.sourceCharPosition ?? ''}`,
            ms: r1(s.duration), layout: r1(s.forcedStyleAndLayoutDuration || 0),
          }));
          this.loaf.push({ t: e.startTime, ms: r1(e.duration), block: r1(e.blockingDuration || 0),
            render: e.renderStart ? r1(e.renderStart - e.startTime) : null, scripts });
          if (this.loaf.length > LOAF_KEEP) this.loaf.shift();
        }
      }).observe({ type, buffered: false });
    } catch (e) { /* unsupported here */ }
  }

  /** Top of the frame callback (t = performance.now()). Logs the previous frame if its interval was long. */
  begin(t) {
    const app = this.app;
    const dtMs = this.lastT ? t - this.lastT : 0;
    let hitch = false;
    if (app.ready && this.lastT) {
      if (!this.readyT) this.readyT = this.lastT;
      this.iv[this.ivN++ % RING] = dtMs;
      hitch = dtMs > HITCH_MS && !document.hidden;
      if (hitch) this._record(dtMs, t);
    }
    // the previous frame's slot in the usual-value rings becomes permanent unless it hitched
    if (this._measured && dtMs <= HITCH_MS) this.baseN++;
    this._measured = false;
    this.lastT = t;
    this.heapStart = performance.memory ? performance.memory.usedJSHeapSize : 0;
    this.lastFrame = app.frame + 1;   // the frame this callback runs (main increments app.frame after begin)
    this.st.fill(0);
    this.shadowMs = 0; this.progRender = 0; this.progNames = null;
    // (programs created between frames, in timers or promise callbacks, count with the updates)
  }

  /** Id of the newest program (three appends new programs, so a change means a compile). */
  _programs() {
    const list = this.app.renderer.info.programs;
    return list && list.length ? list[list.length - 1].id : -1;
  }

  /** Programs created since the last call (by identity, so a release does not hide a compile). */
  _newPrograms() {
    const list = this.app.renderer.info.programs || [];
    let n = 0;
    for (const p of list) {
      if (p.__mon) continue;
      p.__mon = 1; n++;
      (this.progNames ||= []).push(`${p.type}${p.name ? ':' + p.name : ''}`);
    }
    return n;
  }

  renderBegin() {
    // programs created by the updates and the streamer (background compiles)
    const n = this._programs();
    this.progUpd = n !== this._prog ? this._newPrograms() : 0;
    this._prog = n;
  }

  renderEnd() {
    // programs created inside render: compiled synchronously and used at once
    const n = this._programs();
    if (n !== this._prog) this.progRender = this._newPrograms();
    this._prog = n;
  }

  /** End of the frame callback: cpu = its duration (ms). */
  end(cpu) {
    const app = this.app, w = app.world, info = app.renderer.info;
    this.cpu = cpu;
    this.reveal = w?.stats.revealBytes ?? 0;
    this.build = w?.stats.lastBuildMs ?? 0;
    this.queue = w?.stats.queue ?? 0;
    this.calls = info.render.calls; this.tris = info.render.triangles;
    this.heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const env = app.env;
    this.cascades = env?.sun?.shadow?.refreshed ?? -1;
    this.proxy = env?.batcher?.job ? 1 : 0;
    // this frame into the next slot of the usual-value rings (kept if the next interval is smooth)
    const i = this.baseN % BASE, b = this.base;
    b.cpu[i] = cpu; b.shadow[i] = this.shadowMs; b.calls[i] = this.calls;
    b.gpu[i] = app.gpuTimer?.last ?? 0;
    for (let k = 0; k < this.st.length; k++) this.baseSt[k][i] = this.st[k];
    this._measured = true;
    // GPU times arrive a few frames late
    if (this._pend.length && app.gpuTimer) {
      const g = app.gpuTimer;
      this._pend = this._pend.filter((h) => {
        const v = g.of(h.frame);
        if (v !== null) { h.gpu = r1(v); return false; }
        return app.frame - h.frame < 120;
      });
    }
  }

  /** Median of the filled part of a usual-value ring (typed sort: no garbage). */
  _med(a) {
    const n = Math.min(this.baseN, BASE);
    if (!n) return 0;
    const v = this._scratch.subarray(0, n);
    v.set(a.subarray(0, n));
    v.sort();
    return v[n >> 1];
  }

  _record(dtMs, t) {
    const app = this.app;
    if (this.log.length && this.log[this.log.length - 1].frame === this.lastFrame) return;
    const stages = {}, usualStages = {};
    const order = [];
    for (let i = 0; i < this.names.length; i++) if (this.st[i] >= 0.5) order.push(i);
    order.sort((a, b) => this.st[b] - this.st[a]);
    for (const i of order) { stages[this.names[i]] = r1(this.st[i]); usualStages[this.names[i]] = r1(this._med(this.baseSt[i])); }
    const heapNow = performance.memory ? performance.memory.usedJSHeapSize : 0;
    let compiling = 0;
    if (app.world) for (const c of app.world.chunks.values()) { if (c.stage === 'compile') compiling++; if (c.next && c.next.stage === 'compile') compiling++; }
    const rec = {
      frame: this.lastFrame,
      t: r1((this.lastT - this.readyT) / 1000),
      s: r1(app.cameraS ?? 0), kmh: r1((app.train?.speed ?? 0) * 3.6), state: app.train?.state ?? null,
      ms: r1(dtMs), cpu: r1(this.cpu), gap: r1(dtMs - this.cpu),
      stages, usualStages, shadowCpu: r1(this.shadowMs), cascades: this.cascades,
      programs: this.progUpd + this.progRender, syncCompile: this.progRender,
      newPrograms: this.progNames ? this.progNames.slice(0, 8) : undefined,
      compiling, reveal: Math.round(this.reveal / 1024), build: r1(this.build), queue: this.queue, proxyMerge: this.proxy,
      calls: this.calls, tris: this.tris,
      usual: { cpu: r1(this._med(this.base.cpu)), shadowCpu: r1(this._med(this.base.shadow)), gpu: r1(this._med(this.base.gpu)), calls: Math.round(this._med(this.base.calls)) },
      // heap at the start of the frame before the gap minus the heap now (a drop = a GC
      // in that frame or in the gap; Chrome caches the value ~50 ms, coarser without
      // --enable-precise-memory-info)
      heapMB: r1(this.heap / 1048576), heapDropMB: this.heapStart && heapNow ? r1((this.heapStart - heapNow) / 1048576) : 0,
      gpu: null,
      post: app.post?.timings ? Object.fromEntries(Object.entries(app.post.timings).map(([k, v]) => [k, r1(+v || 0)])) : undefined,
      _t0: this.lastT, _t1: t,
    };
    this.count++;
    this.log.push(rec);
    this._pend.push(rec);
    if (this.log.length > MAX_HITCHES) this.log.shift();
  }

  /** The hitch log, with long-animation-frame entries and the likely cause attached. */
  hitches() {
    return this.log.map((h) => {
      const loaf = this.loaf.filter((e) => e.t < h._t1 && e.t + e.ms > h._t0).map(({ t, ...e }) => ({ at: r1(t - h._t0), ...e }));
      const { _t0, _t1, ...out } = h;
      out.loaf = loaf;
      out.cause = cause(out);
      // single-module spikes, whatever the overall cause: far over the module's usual time
      out.spikes = Object.entries(out.stages).filter(([k, v]) => k !== 'render' && v > 4 * (out.usualStages[k] || 0) + 5).map(([k, v]) => `${k}:${v}`);
      return out;
    });
  }

  /** Frame-time summary and one line per hitch (for the capture tool). */
  report() {
    const f = this.frames();
    const hs = this.hitches();
    const causes = {};
    const spikes = {};
    for (const h of hs) {
      causes[h.cause] = (causes[h.cause] || 0) + 1;
      for (const sp of h.spikes) { const k = sp.split(':')[0]; spikes[k] = (spikes[k] || 0) + 1; }
    }
    const lines = [`frames n=${f.n} p50=${f.p50} p95=${f.p95} p99=${f.p99} max=${f.max} >50ms=${f.over50} >60ms=${f.over60} hitches=${this.count}` +
      ` causes=${Object.entries(causes).map(([k, v]) => `${k}:${v}`).join(',') || '-'}` +
      ` spikes=${Object.entries(spikes).map(([k, v]) => `${k}:${v}`).join(',') || '-'}`];
    for (const h of hs) {
      const st = Object.entries(h.stages).slice(0, 5).map(([k, v]) => `${k}=${v}(${h.usualStages[k]})`).join(' ');
      const lo = h.loaf.map((e) => `loaf ${e.ms}ms[${e.scripts.map((s) => `${s.type}:${s.fn || s.inv} ${s.ms}`).join(', ')}]`).join(' ');
      const u = h.usual;
      lines.push(`t=${h.t}s s=${h.s} ${h.kmh}km/h ${h.ms}ms cause=${h.cause}${h.spikes.length ? ' spikes=' + h.spikes.join(',') : ''} cpu=${h.cpu}(${u.cpu}) gap=${h.gap} gpu=${h.gpu ?? '?'}(${u.gpu}) | ${st} ` +
        `shadowCpu=${h.shadowCpu}(${u.shadowCpu}) calls=${h.calls}(${u.calls}) casc=${h.cascades} prog=${h.programs}/${h.syncCompile} ` +
        `compiling=${h.compiling} reveal=${h.reveal}KB build=${h.build} proxy=${h.proxyMerge} heapDrop=${h.heapDropMB}MB${h.newPrograms ? ' new=' + h.newPrograms.join(',') : ''}${lo ? ' ' + lo : ''}`);
    }
    return lines.join('\n');
  }

  /** Frame interval percentiles since ready (or since resetFrames). */
  frames() {
    const n = Math.min(this.ivN, RING);
    if (!n) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, over50: 0, over60: 0 };
    const a = this.iv.slice(0, n).sort();
    const q = (f) => r1(a[Math.min(n - 1, Math.floor(f * n))]);
    let o50 = 0, o60 = 0;
    for (const v of a) { if (v > 50) o50++; if (v > 60) o60++; }
    return { n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: r1(a[n - 1]), over50: o50, over60: o60 };
  }

  reset() { this.ivN = 0; this.log.length = 0; this._pend.length = 0; this.count = 0; this.readyT = 0; }
}

/**
 * Most likely cause of a hitch, from its record:
 * - 'sync-compile': a program was created inside render.
 * - 'contention': most stages, the GL-free updates too, ran far over their usual times at
 *   once and no single one explains the excess: the main thread was starved (cores busy
 *   with other processes, or moved to a slow core), not a code path.
 * - 'gc' / 'gc-in-<stage>': the heap dropped by more than 2 MB.
 * - 'gpu-wait': render alone took several times its usual CPU for the usual draw calls,
 *   so the main thread waited inside GL calls for a GPU that was behind.
 * - 'cpu:<stage>': one stage explains most of the excess.
 * - 'task:<fn>': a timer or promise callback between frames; 'gpu': GPU-bound frame;
 *   'idle-wait': the main thread was idle (GPU or compositor back-pressure).
 */
function cause(h) {
  if (h.syncCompile) return 'sync-compile';
  const entries = Object.entries(h.stages);
  const us = h.usualStages, u = h.usual;
  const outside = h.loaf.flatMap((e) => e.scripts).filter((s) => s.type !== 'user-callback' || !/frame/i.test(s.inv));
  if (h.cpu > 0.6 * h.ms && entries.length) {
    // the stage with the largest excess over its usual time
    // (contention is judged on the module updates: plain JS, which only a starved or
    // slowed main thread makes several times slower all at once)
    let top = entries[0][0], topEx = -1e9, inflated = 0, measured = 0;
    for (const [k, v] of entries) {
      const ex = v - (us[k] || 0);
      if (ex > topEx) { topEx = ex; top = k; }
      if (k !== 'render' && k !== 'world' && (us[k] || 0) >= 0.3) { measured++; if (v > 1.8 * us[k] + 0.5) inflated++; }
    }
    if (h.heapDropMB > 2) return `gc-in-${top}`;
    if (inflated >= 2 && inflated >= 0.5 * measured && (top === 'render' || topEx < 0.6 * Math.max(h.cpu - u.cpu, 1e-3))) return 'contention';
    if (top === 'render') {
      const sameWork = !u.calls || h.calls < 1.3 * u.calls;
      if (h.shadowCpu - u.shadowCpu > 0.5 * topEx) return 'cpu:shadows';
      if (sameWork && h.stages.render > 2.5 * (us.render || 0) + 10) return 'gpu-wait';
    }
    return `cpu:${top}`;
  }
  if (h.heapDropMB > 2) return 'gc';
  if (outside.length && outside[0].ms > 0.4 * h.gap) return `task:${outside[0].fn || outside[0].inv || outside[0].type}`;
  if (h.gpu !== null && h.gpu > 0.6 * h.ms) return 'gpu';
  if (!h.loaf.length) return 'idle-wait';
  return 'main-thread';
}
