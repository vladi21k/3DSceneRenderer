// GPU frame time via EXT_disjoint_timer_query_webgl2 (debug / stats only).
export class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];
    this.active = null;
    this.ms = 0;
  }
  begin() {
    if (!this.ext || this.active) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end() {
    const gl = this.gl;
    if (!this.ext || !this.active) return;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.queries.push(this.active);
    this.active = null;
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) this.ms = this.ms * 0.9 + (gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6) * 0.1;
      gl.deleteQuery(q);
      this.queries.shift();
    }
    if (this.queries.length > 24) { this.queries.forEach((q) => gl.deleteQuery(q)); this.queries = []; }
  }
}
