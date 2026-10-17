import * as THREE from 'three';

// Wire ribbons: each polyline point becomes two vertices sharing the centre position;
// the wire material (shaders.js) pushes them apart perpendicular to the view so the
// ribbon is max(true diameter, 1 px) wide, with alpha = true coverage.

export const WIRE_COLORS = {
  contact: [0.085, 0.062, 0.048],   // hard-drawn copper, oxidised dark brown
  steel: [0.14, 0.14, 0.135],       // galvanised span / hanger strand, weathered
  feeder: [0.035, 0.035, 0.037],    // insulated feeder cable
  insulator: [0.11, 0.1, 0.09],      // far-LOD stand-in for rod insulators (grey-brown silicone)
};

export class WireBuilder {
  constructor() { this.pos = []; this.tan = []; this.wire = []; this.col = []; this.idx = []; }
  get count() { return this.pos.length / 3; }

  /** pts: array of THREE.Vector3 (world); r: true radius (m); col: [r,g,b] linear. */
  add(pts, r, col) {
    const n = pts.length;
    if (n < 2) return;
    const base = this.count;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
      let tx = c.x - a.x, ty = c.y - a.y, tz = c.z - a.z;
      const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
      const p = pts[i];
      for (const side of [-1, 1]) {
        this.pos.push(p.x, p.y, p.z);
        this.tan.push(tx, ty, tz);
        this.wire.push(side, r);
        this.col.push(col[0], col[1], col[2]);
      }
      if (i < n - 1) {
        const k = base + i * 2;
        // (i-, i+, (i+1)-) winds counter-clockwise towards the camera after expansion
        this.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }

  toGeometry() {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aTan', new THREE.Float32BufferAttribute(this.tan, 3));
    g.setAttribute('aWire', new THREE.Float32BufferAttribute(this.wire, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    // the shader needs a normal attribute slot only for program compatibility
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
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
