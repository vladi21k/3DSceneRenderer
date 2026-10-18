// GPU frame time via EXT_disjoint_timer_query_webgl2 (debug / stats only).
// `ms` is a smoothed average; `last` is the newest raw result and `of(frame)` looks up the
// raw time of a recent frame (the results arrive a few frames late), for the hitch log.
const RING = 256;

export class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];            // [{q, tag}] in flight, oldest first
    this.active = null;
    this.ms = 0;
    this.last = 0;
    this._n = 0;
    this._ms = new Float32Array(RING);
    this._tag = new Int32Array(RING).fill(-1);
  }
  /** Start timing; `tag` (the app frame number) keys the raw result for of(). */
  begin(tag = this._n) {
    if (!this.ext || this.active) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, tag };
  }
  end() {
    const gl = this.gl;
    this._n++;
    if (!this.ext || !this.active) return;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.queries.push(this.active);
    this.active = null;
    while (this.queries.length) {
      const { q, tag } = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.last = ms;
        this.ms = this.ms * 0.9 + ms * 0.1;
        const i = ((tag % RING) + RING) % RING;
        this._ms[i] = ms; this._tag[i] = tag;
      }
      gl.deleteQuery(q);
      this.queries.shift();
    }
    if (this.queries.length > 24) { this.queries.forEach((e) => gl.deleteQuery(e.q)); this.queries = []; }
  }
  /** Raw GPU ms of a recent frame (by tag), or null when unknown (not back yet, disjoint, timer off). */
  of(tag) {
    const i = ((tag % RING) + RING) % RING;
    return this._tag[i] === tag ? this._ms[i] : null;
  }
}
