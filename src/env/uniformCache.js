// Garbage-free uniform caches for the uniforms that change every frame.
//
// The renderer keeps, per program and per uniform, a cache of the last uploaded value and
// skips uploads that would not change anything. Those caches are plain arrays created at
// one site; once any of them holds a boolean (bool uniforms do) every one of them stores
// numbers boxed, so each changed float uniform of each program costs a small heap object
// per frame: the view-space light uniforms (every light moves in view space as the camera
// moves), the view and model matrices, the camera position and the shared animated
// uniforms (U.uTime, the wind). At dusk, with the lamp lights on, that is several MB/s of
// garbage and a share of the major collections.
//
// For a fixed set of float uniforms that are always set to defined numbers (the light
// structs, the camera and object matrices, the shared U uniforms), the cache is swapped
// for a Float64Array once per program: same comparisons, same uploads, no boxing. Entries
// never uploaded start as NaN, so the first upload happens exactly as before.

// float uniform types (WebGL enums) and their cache lengths
const FLOAT_N = { 0x1406: 1, 0x8b50: 2, 0x8b51: 3, 0x8b52: 4, 0x8b5a: 4, 0x8b5b: 9, 0x8b5c: 16 };
// light structs: every field is a number the renderer sets each frame
const LIGHT_STRUCTS = new Set(['spotLights', 'directionalLights', 'sunLights', 'hemisphereLights', 'pointLights', 'rectAreaLights']);
// single uniforms the renderer or the shared U block always set to numbers
const SAFE = new Set([
  'cameraPosition', 'viewMatrix', 'projectionMatrix', 'modelViewMatrix', 'normalMatrix', 'modelMatrix',
  'ambientLightColor', 'toneMappingExposure',
  'uTime', 'uWind', 'uWindStrength', 'uSunDir', 'uSunColor', 'uCameraPos', 'uSpeed', 'uNight',
]);

function unbox(u) {
  const n = FLOAT_N[u.type];
  // (array uniforms carry a size and upload without a cache)
  if (!n || u.size !== undefined || !Array.isArray(u.cache)) return 0;
  const c = u.cache, f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = i < c.length && typeof c[i] === 'number' ? c[i] : NaN;
  u.cache = f;
  return 1;
}

function walk(seq, inLight) {
  let k = 0;
  for (let i = 0; i < seq.length; i++) {
    const u = seq[i];
    if (u.seq) k += walk(u.seq, inLight || LIGHT_STRUCTS.has(u.id));
    else if (inLight || SAFE.has(u.id)) k += unbox(u);
  }
  return k;
}

export class UniformCaches {
  constructor(renderer) {
    this.renderer = renderer;
    this.done = new WeakSet();
    this.count = 0;          // programs seen
    this.uniforms = 0;       // caches swapped so far
    this._frame = 0;
    this._pending = true;
  }

  /** Scan the renderer's programs now and then; each ready program is patched once. */
  update() {
    if (this._frame++ % 30 !== 0) return;
    const list = this.renderer.info && this.renderer.info.programs;
    if (!Array.isArray(list)) return;
    if (!this._pending && list.length === this.count) return;
    this.count = list.length;
    let pending = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || this.done.has(p)) continue;
      // (a program still compiling is left for a later scan: asking for its uniforms
      // would wait for the driver)
      if (typeof p.isReady === 'function' && !p.isReady()) { pending = true; continue; }
      this.done.add(p);
      try {
        const U = p.getUniforms();
        if (U && Array.isArray(U.seq)) this.uniforms += walk(U.seq, false);
      } catch (e) { /* a program that failed to link: nothing to patch */ }
    }
    this._pending = pending;
  }
}
