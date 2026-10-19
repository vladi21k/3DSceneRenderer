// Allocation-free replacements for three's per-frame internals (r186). Each frame three
// sorts its render lists and uploads a few thousand uniforms, and both left garbage:
// Array.prototype.sort copies the list and the painter comparators return float
// differences (~1.1 MB/s), and the uniform setters compare and store numbers through
// plain arrays whose elements turn generic once any uniform caches a non-number (then
// every changed value becomes a new heap number, ~1.4 MB/s). Garbage drives the minor
// collections, so these paths are replaced by ones that make none. URL switches for A/B:
// glsort=0 (render list sort), gltyped=0 (uniform setters), glbox=0 (scalar uploads).

/**
 * Scalar uniform uploads without boxing: gl.uniform1f…4f routed through the vector forms
 * with one reused typed array, which the GL treats identically. A float passed to a call
 * into the browser is boxed; the typed setters below avoid most of those calls anyway, this
 * covers the rest (modules' own uploads, three's light structs before env takes them over).
 */
export function unboxedUniforms(gl) {
  const f1 = gl.uniform1fv.bind(gl), f2 = gl.uniform2fv.bind(gl), f3 = gl.uniform3fv.bind(gl), f4 = gl.uniform4fv.bind(gl);
  const b1 = new Float32Array(1), b2 = new Float32Array(2), b3 = new Float32Array(3), b4 = new Float32Array(4);
  gl.uniform1f = function (loc, x) { b1[0] = x; f1(loc, b1); };
  gl.uniform2f = function (loc, x, y) { b2[0] = x; b2[1] = y; f2(loc, b2); };
  gl.uniform3f = function (loc, x, y, z) { b3[0] = x; b3[1] = y; b3[2] = z; f3(loc, b3); };
  gl.uniform4f = function (loc, x, y, z, w) { b4[0] = x; b4[1] = y; b4[2] = z; b4[3] = w; f4(loc, b4); };
}

// ---- render list sort

/** Painter order of three's painterSortStable: true when a sorts strictly before b. */
function before(a, b) {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder < b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder < b.renderOrder;
  const ma = a.material.id, mb = b.material.id;
  if (ma !== mb) return ma < mb;
  if (a.materialVariant !== b.materialVariant) return a.materialVariant < b.materialVariant;
  if (a.z !== b.z) return a.z < b.z;
  return a.id < b.id;
}

/** reversePainterSortStable (transparent and transmissive items: far to near). */
function beforeBack(a, b) {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder < b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder < b.renderOrder;
  if (a.z !== b.z) return a.z > b.z;
  return a.id < b.id;
}

const RUN = 16;

/** Stable sort of `a` in place: insertion-sorted runs, then bottom-up merges through `tmp`
 *  (grown once, kept). Same order as Array.prototype.sort with the painter comparators. */
function mergeSort(a, tmp, back) {
  const n = a.length, lt = back ? beforeBack : before;
  for (let lo = 0; lo < n; lo += RUN) {
    const hi = Math.min(lo + RUN, n);
    for (let i = lo + 1; i < hi; i++) {
      const x = a[i];
      let j = i - 1;
      while (j >= lo && lt(x, a[j])) { a[j + 1] = a[j]; j--; }
      a[j + 1] = x;
    }
  }
  if (n <= RUN) return;
  while (tmp.length < n) tmp.push(null);
  let src = a, dst = tmp;
  for (let w = RUN; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid = Math.min(lo + w, n), hi = Math.min(lo + 2 * w, n);
      let i = lo, j = mid, k = lo;
      // (the right run's item goes first only when strictly before: stable)
      while (i < mid && j < hi) dst[k++] = lt(src[j], src[i]) ? src[j++] : src[i++];
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    const t = src; src = dst; dst = t;
  }
  if (src !== a) for (let i = 0; i < n; i++) a[i] = src[i];
}

/** Give every render list the renderer creates the allocation-free sort. A custom sort
 *  (renderer.setOpaqueSort / setTransparentSort) still goes through Array.prototype.sort. */
export function sortRenderLists(renderer) {
  const lists = renderer.renderLists;
  if (!lists || typeof lists.get !== 'function') return false;
  const get = lists.get;
  const patch = (list) => {
    const { opaque, transmissive, transparent } = list;
    if (!Array.isArray(opaque) || !Array.isArray(transmissive) || !Array.isArray(transparent)) return;
    const tmp = [];
    list.sort = function (opaqueSort, transparentSort) {
      if (opaque.length > 1) { if (opaqueSort) opaque.sort(opaqueSort); else mergeSort(opaque, tmp, false); }
      if (transmissive.length > 1) { if (transparentSort) transmissive.sort(transparentSort); else mergeSort(transmissive, tmp, true); }
      if (transparent.length > 1) { if (transparentSort) transparent.sort(transparentSort); else mergeSort(transparent, tmp, true); }
    };
    list.__mergeSort = true;
  };
  lists.get = function (scene, depth) {
    const list = get(scene, depth);
    if (list.__mergeSort === undefined) { list.__mergeSort = false; patch(list); }
    return list;
  };
  return true;
}

// ---- typed uniform setters
// Each setter keeps its last value in a Float64Array (exact comparisons, as three's cache)
// and uploads from a Float32Array through the vector form of the call. The arrays belong
// to the uniform, so element access stays monomorphic and nothing is boxed.

const GL_FLOAT = 0x1406, GL_VEC2 = 0x8B50, GL_VEC3 = 0x8B51, GL_VEC4 = 0x8B52, GL_MAT3 = 0x8B5B, GL_MAT4 = 0x8B5C;

/** The renderer's own setter for anything the typed one does not handle (and forget the cache). */
function fallback(u, gl, v) { u.tc.fill(NaN); u.orig(gl, v); }

function setF1(gl, v) {
  const c = this.tc;
  if (c[0] === v) return;
  c[0] = v;
  const f = this.tf;
  f[0] = v;
  gl.uniform1fv(this.addr, f);
}

// (each branch compares and stores its own reads: values merged from several kinds of
// source into one variable would be boxed)
function setF2(gl, v) {
  const c = this.tc;
  if (v.x !== undefined) {
    if (c[0] === v.x && c[1] === v.y) return;
    c[0] = v.x; c[1] = v.y;
  } else if (v.length === 2) {
    if (c[0] === v[0] && c[1] === v[1]) return;
    c[0] = v[0]; c[1] = v[1];
  } else { fallback(this, gl, v); return; }
  const f = this.tf;
  f[0] = c[0]; f[1] = c[1];
  gl.uniform2fv(this.addr, f);
}

function setF3(gl, v) {
  const c = this.tc;
  if (v.x !== undefined) {
    if (c[0] === v.x && c[1] === v.y && c[2] === v.z) return;
    c[0] = v.x; c[1] = v.y; c[2] = v.z;
  } else if (v.r !== undefined) {
    if (c[0] === v.r && c[1] === v.g && c[2] === v.b) return;
    c[0] = v.r; c[1] = v.g; c[2] = v.b;
  } else if (v.length === 3) {
    if (c[0] === v[0] && c[1] === v[1] && c[2] === v[2]) return;
    c[0] = v[0]; c[1] = v[1]; c[2] = v[2];
  } else { fallback(this, gl, v); return; }
  const f = this.tf;
  f[0] = c[0]; f[1] = c[1]; f[2] = c[2];
  gl.uniform3fv(this.addr, f);
}

function setF4(gl, v) {
  const c = this.tc;
  if (v.x !== undefined) {
    if (c[0] === v.x && c[1] === v.y && c[2] === v.z && c[3] === v.w) return;
    c[0] = v.x; c[1] = v.y; c[2] = v.z; c[3] = v.w;
  } else if (v.length === 4) {
    if (c[0] === v[0] && c[1] === v[1] && c[2] === v[2] && c[3] === v[3]) return;
    c[0] = v[0]; c[1] = v[1]; c[2] = v[2]; c[3] = v[3];
  } else { fallback(this, gl, v); return; }
  const f = this.tf;
  f[0] = c[0]; f[1] = c[1]; f[2] = c[2]; f[3] = c[3];
  gl.uniform4fv(this.addr, f);
}

/** Copy n numbers of e into the cache and upload array when any differs; true when changed. */
function changed(u, e, n) {
  const c = u.tc;
  let i = 0;
  while (i < n && c[i] === e[i]) i++;
  if (i === n) return false;
  const f = u.tf;
  // (the upload array always holds the cache's values: copy from the first difference on)
  for (; i < n; i++) { const x = e[i]; c[i] = x; f[i] = x; }
  return true;
}

function setM3(gl, v) {
  const e = v.elements !== undefined ? v.elements : v;
  if (e.length !== 9) { fallback(this, gl, v); return; }
  if (changed(this, e, 9)) gl.uniformMatrix3fv(this.addr, false, this.tf);
}

function setM4(gl, v) {
  const e = v.elements !== undefined ? v.elements : v;
  if (e.length !== 16) { fallback(this, gl, v); return; }
  if (changed(this, e, 16)) gl.uniformMatrix4fv(this.addr, false, this.tf);
}

/** three's flatten() without its relational test on objects: a flat array is passed on as
 *  it is, an array of vectors or matrices is packed into the uniform's own Float32Array. */
function flat(u, v, k) {
  const first = v[0];
  if (typeof first !== 'object' || first === null) return v;
  const f = u.tf, n = Math.min(u.size, v.length);
  for (let i = 0; i < n; i++) v[i].toArray(f, i * k);
  return f;
}
function setF2Arr(gl, v) { gl.uniform2fv(this.addr, flat(this, v, 2)); }
function setF3Arr(gl, v) { gl.uniform3fv(this.addr, flat(this, v, 3)); }
function setF4Arr(gl, v) { gl.uniform4fv(this.addr, flat(this, v, 4)); }
function setM3Arr(gl, v) { gl.uniformMatrix3fv(this.addr, false, flat(this, v, 9)); }
function setM4Arr(gl, v) { gl.uniformMatrix4fv(this.addr, false, flat(this, v, 16)); }

const SINGLE = new Map([[GL_FLOAT, [setF1, 1]], [GL_VEC2, [setF2, 2]], [GL_VEC3, [setF3, 3]], [GL_VEC4, [setF4, 4]], [GL_MAT3, [setM3, 9]], [GL_MAT4, [setM4, 16]]]);
const ARRAY = new Map([[GL_VEC2, [setF2Arr, 2]], [GL_VEC3, [setF3Arr, 3]], [GL_VEC4, [setF4Arr, 4]], [GL_MAT3, [setM3Arr, 9]], [GL_MAT4, [setM4Arr, 16]]]);

function typedSeq(seq) {
  let n = 0;
  for (let i = 0; i < seq.length; i++) {
    const u = seq[i];
    if (!u || typeof u !== 'object') continue;
    if (Array.isArray(u.seq)) { n += typedSeq(u.seq); continue; }
    // (done already, or one of env's light-struct setters: src/env/lights.js)
    if (u.tf !== undefined || u.c64 !== undefined || u.spotK !== undefined || typeof u.setValue !== 'function') continue;
    if (u.size === undefined) {
      const s = SINGLE.get(u.type);
      if (!s) continue;
      u.tc = new Float64Array(s[1]).fill(NaN);
      u.tf = new Float32Array(s[1]);
      u.orig = u.setValue;
      u.setValue = s[0];
    } else {
      const s = ARRAY.get(u.type);
      if (!s || !(u.size > 0)) continue;
      u.tf = new Float32Array(s[1] * u.size);
      u.orig = u.setValue;
      u.setValue = s[0];
    }
    n++;
  }
  return n;
}

/** Give a linked program's float uniforms the typed setters (idempotent); returns how many
 *  changed. Call it only once the program is ready (getUniforms waits for the link). */
export function typedUniforms(program) {
  const U = program && typeof program.getUniforms === 'function' ? program.getUniforms() : null;
  return U && Array.isArray(U.seq) ? typedSeq(U.seq) : 0;
}
