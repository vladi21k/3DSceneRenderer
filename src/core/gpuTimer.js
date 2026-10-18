// GPU frame time via EXT_disjoint_timer_query_webgl2 (debug / stats only).
// `ms` is a smoothed average; `last` is the newest raw result and `of(frame)` looks up the
// raw time of a recent frame (the results arrive a few frames late), for the hitch log.
const RING = 256;
const MAX_FLIGHT = 24;   // queries waiting for their result

export class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.TIME = this.ext ? this.ext.TIME_ELAPSED_EXT : 0;   // (kept: a profiler may null ext to pause the timer)
    // queries in flight, oldest first, as a ring of query objects and their tags (the
    // query objects are reused once read: nothing is allocated per frame)
    this.qs = new Array(MAX_FLIGHT).fill(null);
    this.qTag = new Int32Array(MAX_FLIGHT);
    this.qHead = 0; this.qN = 0;
    this.free = [];
    this.active = null;
    this.activeTag = 0;
    this.ms = 0;
    this.last = 0;
    this._n = 0;
    this._ms = new Float32Array(RING);
    this._tag = new Int32Array(RING).fill(-1);
  }
  /** Start timing; `tag` (the app frame number) keys the raw result for of(). */
  begin(tag = this._n) {
    if (!this.ext || this.active) return;
    const q = this.free.length ? this.free.pop() : this.gl.createQuery();
    this.gl.beginQuery(this.TIME, q);
    this.active = q; this.activeTag = tag;
  }
  end() {
    const gl = this.gl;
    this._n++;
    if (!this.active) return;
    gl.endQuery(this.TIME);
    if (!this.ext) { this.free.push(this.active); this.active = null; return; }
    if (this.qN === MAX_FLIGHT) {   // results stopped arriving (context trouble): start over
      for (let k = 0; k < this.qN; k++) this.free.push(this.qs[(this.qHead + k) % MAX_FLIGHT]);
      this.qN = 0;
    }
    const slot = (this.qHead + this.qN) % MAX_FLIGHT;
    this.qs[slot] = this.active; this.qTag[slot] = this.activeTag; this.qN++;
    this.active = null;
    while (this.qN) {
      const q = this.qs[this.qHead], tag = this.qTag[this.qHead];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.last = ms;
        this.ms = this.ms * 0.9 + ms * 0.1;
        const i = ((tag % RING) + RING) % RING;
        this._ms[i] = ms; this._tag[i] = tag;
      }
      this.qs[this.qHead] = null;
      this.free.push(q);
      this.qHead = (this.qHead + 1) % MAX_FLIGHT; this.qN--;
    }
  }
  /** Raw GPU ms of a recent frame (by tag), or null when unknown (not back yet, disjoint, timer off). */
  of(tag) {
    const i = ((tag % RING) + RING) % RING;
    return this._tag[i] === tag ? this._ms[i] : null;
  }
}
