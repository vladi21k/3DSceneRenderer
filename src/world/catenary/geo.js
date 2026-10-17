import * as THREE from 'three';

// Small geometry kit for the lamp standards: an accumulating builder with lathe and
// planar-sweep primitives. Every vertex carries `aTube`, the local radius of the part it
// belongs to, so the thin-part shader can keep sub-pixel ironwork at least ~1 px wide.
// UVs are in metres (u along the part, v around it).

export class GeoBuilder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.tube = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  vert(x, y, z, nx, ny, nz, u, v, tube) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(u, v); this.tube.push(tube);
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  /** Append another builder transformed by a Matrix4. */
  append(other, m = null) {
    const base = this.count;
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    for (let i = 0; i < other.count; i++) {
      v.fromArray(other.pos, i * 3); n.fromArray(other.nor, i * 3);
      if (m) { v.applyMatrix4(m); n.applyMatrix3(nm).normalize(); }
      this.vert(v.x, v.y, v.z, n.x, n.y, n.z, other.uv[i * 2], other.uv[i * 2 + 1], other.tube[i]);
    }
    for (const i of other.idx) this.idx.push(i + base);
    return this;
  }
  /** colorFn(x, y, z, nx, ny, nz) -> [r, g, b] baked into a colour attribute (AO / grime). */
  toGeometry(colorFn = null) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTube', new THREE.Float32BufferAttribute(this.tube, 1));
    if (colorFn) {
      const col = new Float32Array(this.count * 3);
      for (let i = 0; i < this.count; i++) {
        const c = colorFn(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], this.nor[i * 3], this.nor[i * 3 + 1], this.nor[i * 3 + 2]);
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Surface of revolution around +Y. profile: [[r, y, sharp?], ...] from bottom to top.
 *  A point flagged sharp gets split normals (crease). opts.flutes = {count, depth, y0, y1}
 *  cuts vertical flutes; opts.tube overrides the inflation radius. */
export function lathe(b, profile, segs, opts = {}) {
  const { flutes = null, y0 = 0, angle0 = 0 } = opts;
  // expand sharp points into duplicated rings
  const rings = [];
  for (let i = 0; i < profile.length; i++) {
    const [r, y, sharp] = profile[i];
    if (sharp && i > 0 && i < profile.length - 1) { rings.push({ r, y, side: -1 }); rings.push({ r, y, side: +1 }); }
    else rings.push({ r, y, side: 0 });
  }
  const fl = (theta, y) => {
    if (!flutes || y < flutes.y0 || y > flutes.y1) return 1;
    const edge = Math.min(1, (y - flutes.y0) / 0.02, (flutes.y1 - y) / 0.02);
    const c = Math.cos(theta * flutes.count);
    return 1 - flutes.depth * Math.max(0, c) ** 2 * Math.max(0, edge);
  };
  const P = (ri, theta) => {
    const R = rings[ri];
    const r = R.r * fl(theta, R.y);
    return [Math.cos(theta) * r, R.y + y0, -Math.sin(theta) * r];
  };
  const base = b.count;
  const cols = segs + 1;
  let vAcc = 0;
  for (let i = 0; i < rings.length; i++) {
    if (i > 0) vAcc += Math.hypot(rings[i].r - rings[i - 1].r, rings[i].y - rings[i - 1].y);
    // neighbour rings for the meridian tangent (respecting creases)
    const prev = rings[i].side === +1 ? i : Math.max(0, i - 1);
    const next = rings[i].side === -1 ? i : Math.min(rings.length - 1, i + 1);
    for (let j = 0; j <= segs; j++) {
      const th = angle0 + (j / segs) * Math.PI * 2;
      const p = P(i, th);
      const e = 1e-3;
      const pa = P(i, th - e), pb = P(i, th + e);
      const ma = P(prev, th), mb = P(next, th);
      const tx = pb[0] - pa[0], ty = pb[1] - pa[1], tz = pb[2] - pa[2];
      let mx = mb[0] - ma[0], my = mb[1] - ma[1], mz = mb[2] - ma[2];
      if (Math.abs(mx) + Math.abs(my) + Math.abs(mz) < 1e-9) { mx = 0; my = 1; mz = 0; }
      // normal = tangent x meridian (outward for a bottom-to-top profile)
      let nx = ty * mz - tz * my, ny = tz * mx - tx * mz, nz = tx * my - ty * mx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      b.vert(p[0], p[1], p[2], nx, ny, nz, (j / segs) * Math.PI * 2 * Math.max(0.05, rings[i].r), p[1], opts.tube ?? Math.max(rings[i].r, 0.004));
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    if (rings[i].side === -1) continue; // crease pair: no faces between duplicates
    for (let j = 0; j < segs; j++) {
      const a = base + i * cols + j, c = base + (i + 1) * cols + j;
      b.tri(a, a + 1, c); b.tri(a + 1, c + 1, c);
    }
  }
  void vAcc;
  return b;
}

/** Sweep a closed cross-section along a planar polyline.
 *  pts: [[x, y], ...] in the plane; place(x, y, z) maps plane coordinates to 3D (z = across
 *  the plane). section: {kind: 'round', r} or {kind: 'bar', w, t} (w in-plane, t across).
 *  Ends get small domed caps. */
export function sweepPlanar(b, pts, section, place = (x, y, z) => [x, y, z], segs = 8, caps = true) {
  const ring = sectionRing(section, segs);
  const n = pts.length;
  const base = b.count;
  const tubeR = section.kind === 'round' ? section.r : Math.min(section.w, section.t) * 0.5;
  // per point frame: tangent t, in-plane normal m = (-ty, tx), across-plane k = (0,0,1)
  const frames = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
    let tx = c[0] - a[0], ty = c[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    frames.push({ tx, ty, mx: -ty, my: tx, s: acc });
  }
  const rows = [];
  const emitRow = (cx, cy, f, scale, uS, capDir = 0) => {
    const row = [];
    for (let k = 0; k < ring.length; k++) {
      const q = ring[k];
      const px = cx + f.mx * q.a * scale, py = cy + f.my * q.a * scale, pz = q.b * scale;
      // section normal in 3D plane coordinates, tilted along the tangent on caps
      let nx = f.mx * q.na, ny = f.my * q.na, nz = q.nb;
      if (capDir) { const w = 1 - scale; nx = nx * (1 - w) + f.tx * capDir * w; ny = ny * (1 - w) + f.ty * capDir * w; nz *= (1 - w); }
      const P = place(px, py, pz), N0 = place(nx, ny, nz), O = place(0, 0, 0);
      let Nx = N0[0] - O[0], Ny = N0[1] - O[1], Nz = N0[2] - O[2];
      const nl = Math.hypot(Nx, Ny, Nz) || 1;
      row.push(b.vert(P[0], P[1], P[2], Nx / nl, Ny / nl, Nz / nl, uS, q.v, tubeR));
    }
    rows.push(row);
  };
  const capLen = tubeR * 0.9;
  if (caps) {
    const f = frames[0];
    emitRow(pts[0][0] - f.tx * capLen, pts[0][1] - f.ty * capLen, f, 0.05, -capLen, -1);
    emitRow(pts[0][0] - f.tx * capLen * 0.55, pts[0][1] - f.ty * capLen * 0.55, f, 0.75, -capLen * 0.55, -1);
  }
  for (let i = 0; i < n; i++) emitRow(pts[i][0], pts[i][1], frames[i], 1, frames[i].s);
  if (caps) {
    const f = frames[n - 1], e = pts[n - 1], s = frames[n - 1].s;
    emitRow(e[0] + f.tx * capLen * 0.55, e[1] + f.ty * capLen * 0.55, f, 0.75, s + capLen * 0.55, 1);
    emitRow(e[0] + f.tx * capLen, e[1] + f.ty * capLen, f, 0.05, s + capLen, 1);
  }
  const m = ring.length;
  for (let r = 0; r < rows.length - 1; r++) {
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const a = rows[r][k], bb = rows[r][k2], c = rows[r + 1][k], d = rows[r + 1][k2];
      b.tri(a, bb, c); b.tri(bb, d, c);
    }
  }
  void base;
  return b;
}

/** Cross-section ring: points (a in-plane, b across) with normals, counter-clockwise. */
function sectionRing(section, segs) {
  const out = [];
  if (section.kind === 'round') {
    for (let k = 0; k < segs; k++) {
      const t = (k / segs) * Math.PI * 2;
      out.push({ a: Math.cos(t) * section.r, b: Math.sin(t) * section.r, na: Math.cos(t), nb: Math.sin(t), v: t * section.r });
    }
    return out;
  }
  // rounded rectangle: corner radius rr, 2 points per corner
  const hw = section.w / 2, ht = section.t / 2;
  const rr = Math.min(hw, ht) * 0.45;
  const corners = [[hw - rr, ht - rr, 0], [-hw + rr, ht - rr, 1], [-hw + rr, -ht + rr, 2], [hw - rr, -ht + rr, 3]];
  const per = Math.max(1, Math.round(segs / 4) - 1);
  let v = 0;
  for (const [cx, cy, q] of corners) {
    for (let i = 0; i <= per; i++) {
      const t = (q + i / per) * Math.PI / 2;
      const na = Math.cos(t), nb = Math.sin(t);
      out.push({ a: cx + na * rr, b: cy + nb * rr, na, nb, v: v += 0.01 });
    }
  }
  return out;
}

/** Drop points of a dense polyline while keeping turning angle and spacing bounded. */
export function simplifyPath(pts, maxAngleDeg = 6, maxLen = 0.06, minLen = 0.004) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  const maxA = (maxAngleDeg * Math.PI) / 180;
  let last = pts[0], lastDir = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = Math.hypot(p[0] - last[0], p[1] - last[1]);
    const dir = Math.atan2(pts[i + 1][1] - p[1], pts[i + 1][0] - p[0]);
    let da = Math.abs(dir - lastDir); if (da > Math.PI) da = 2 * Math.PI - da;
    if ((da > maxA && d > minLen) || d > maxLen) { out.push(p); last = p; lastDir = dir; }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Straight round rod between two 3D points (used for stems, brackets). */
export function rod(b, a, c, r, segs = 8, caps = true) {
  const A = new THREE.Vector3(...a), C = new THREE.Vector3(...c);
  const dir = C.clone().sub(A); const L = dir.length(); dir.normalize();
  // local frame: plane spanned by dir and a perpendicular
  const up = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const m = new THREE.Vector3().crossVectors(up, dir).normalize(); // in-plane normal
  const k = new THREE.Vector3().crossVectors(dir, m).normalize();
  // plane coords: x along dir, y along m, z along k
  const place = (x, y, z) => [A.x + dir.x * x + m.x * y + k.x * z, A.y + dir.y * x + m.y * y + k.y * z, A.z + dir.z * x + m.z * y + k.z * z];
  // sweepPlanar's in-plane normal is (-ty, tx): with t = +x it is +y = m, and across = z = k
  return sweepPlanar(b, [[0, 0], [L, 0]], { kind: 'round', r }, place, segs, caps);
}
