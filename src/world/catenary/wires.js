import * as THREE from 'three';

// Wire ribbons: each polyline point becomes two vertices sharing the centre position;
// the wire material (shaders.js) pushes them apart perpendicular to the view so the
// ribbon is max(true diameter, 1 px) wide, with alpha = true coverage.

export const WIRE_COLORS = {
  contact: [0.085, 0.062, 0.048],   // hard-drawn copper, oxidised dark brown
  steel: [0.14, 0.14, 0.135],       // galvanised span / dropper strand, weathered
  arm: [0.16, 0.16, 0.155],         // galvanised registration arm tube
  feeder: [0.035, 0.035, 0.037],    // insulated feeder cable
  insulator: [0.17, 0.165, 0.155],  // stand-in for rod insulators (grey silicone, metal ends)
};

// Scratch buffers reused across chunk builds (no per-build array growth / GC churn).
// Each live builder holds one; toGeometry() copies out exactly what was written.
const pool = [];
function acquire() {
  return pool.pop() || { pos: new Float32Array(3 * 4096), tan: new Float32Array(3 * 4096), wire: new Float32Array(2 * 4096), col: new Float32Array(3 * 4096), idx: new Uint32Array(6 * 4096) };
}
function grow(arr, need) {
  if (arr.length >= need) return arr;
  const out = new arr.constructor(Math.max(need, arr.length * 2));
  out.set(arr);
  return out;
}

export class WireBuilder {
  constructor() { this.b = acquire(); this.n = 0; this.ni = 0; }
  get count() { return this.n; }

  /** pts: array of THREE.Vector3 (world); r: true radius (m); col: [r,g,b] linear. */
  add(pts, r, col) {
    const n = pts.length;
    if (n < 2) return;
    const b = this.b;
    const nv = this.n + n * 2, ni = this.ni + (n - 1) * 6;
    if (b.pos.length < nv * 3) { b.pos = grow(b.pos, nv * 3); b.tan = grow(b.tan, nv * 3); b.col = grow(b.col, nv * 3); b.wire = grow(b.wire, nv * 2); }
    if (b.idx.length < ni) b.idx = grow(b.idx, ni);
    const base = this.n;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
      let tx = c.x - a.x, ty = c.y - a.y, tz = c.z - a.z;
      const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
      const p = pts[i];
      for (let side = -1; side <= 1; side += 2) {
        const v = this.n++;
        b.pos[v * 3] = p.x; b.pos[v * 3 + 1] = p.y; b.pos[v * 3 + 2] = p.z;
        b.tan[v * 3] = tx; b.tan[v * 3 + 1] = ty; b.tan[v * 3 + 2] = tz;
        b.wire[v * 2] = side; b.wire[v * 2 + 1] = r;
        b.col[v * 3] = col[0]; b.col[v * 3 + 1] = col[1]; b.col[v * 3 + 2] = col[2];
      }
      if (i < n - 1) {
        const k = base + i * 2;
        // (i-, i+, (i+1)-) winds counter-clockwise towards the camera after expansion
        b.idx[this.ni++] = k; b.idx[this.ni++] = k + 1; b.idx[this.ni++] = k + 2;
        b.idx[this.ni++] = k + 1; b.idx[this.ni++] = k + 3; b.idx[this.ni++] = k + 2;
      }
    }
  }

  /** Copies the ribbons into a geometry (or null when empty) and releases the scratch. */
  toGeometry() {
    const b = this.b, n = this.n;
    this.b = null;
    pool.push(b);
    if (!n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos.slice(0, n * 3), 3));
    g.setAttribute('aTan', new THREE.BufferAttribute(b.tan.slice(0, n * 3), 3));
    g.setAttribute('aWire', new THREE.BufferAttribute(b.wire.slice(0, n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(b.col.slice(0, n * 3), 3));
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? b.idx.slice(0, this.ni) : Uint16Array.from(b.idx.subarray(0, this.ni)), 1));
    g.computeBoundingSphere();
    // ribbons are expanded in the shader: pad the bounds so frustum culling stays correct
    g.boundingSphere.radius += 2;
    return g;
  }
}

/** Points along a hanging wire from A to B with mid-span sag (parabolic approximation of
 *  the catenary, fine for the small sag/span ratios of overhead lines). */
export function sagCurve(A, B, sag, n, out = []) {
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(A, B, t);
    p.y -= sag * 4 * t * (1 - t);
    out.push(p);
  }
  return out;
}
