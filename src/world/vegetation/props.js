import * as THREE from 'three';
import { MeshBatcher } from '../../core/geom.js';
import { RNG } from '../../core/rng.js';

// Static props around the street trees and the planters owned by vegetation:
//   * cast-iron tree grates (radial slots, mulch in the opening), flush with the paving;
//   * timber stakes, a cross batten and a rubber tie on the youngest trees;
//   * limestone planters (bevelled trough or square box) with soil, holding a shrub mound
//     (the foliage itself is instanced in the leaf pool by vegetation.js).
// Everything is merged per chunk by material. Textures are painted on canvases at init.

const UP = new THREE.Vector3(0, 1, 0);
const GRATE = 1.2;          // grate size (m)
const GRATE_HOLE = 0.23;    // radius of the opening around the trunk

// ------------------------------------------------------------------ textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/** Normal map from a height canvas (red channel), Sobel filter. */
function normalFromHeight(hc, strength) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h), ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h), d = img.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const k = (y * w + x) * 4;
      d[k] = (nx * 0.5 + 0.5) * 255; d[k + 1] = (ny * 0.5 + 0.5) * 255; d[k + 2] = (nz * 0.5 + 0.5) * 255; d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function tex(c, srgb, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Speckle noise helper for the canvas painters. */
function speckle(ctx, w, h, rng, n, rMin, rMax, colorFn) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colorFn(rng);
    ctx.beginPath();
    ctx.ellipse(rng.range(0, w), rng.range(0, h), rng.range(rMin, rMax), rng.range(rMin, rMax), rng.range(0, 3.14), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Cast-iron tree grate: concentric slotted rings with radial ribs, mulch in the opening. */
function grateMaterial(rng) {
  const S = 512, px = S / GRATE, c = S / 2;
  const col = canvas(S, S), hgt = canvas(S, S), rough = canvas(S, S);
  const cc = col.getContext('2d'), hc = hgt.getContext('2d'), rc = rough.getContext('2d');
  // iron base: dark grey with a brown rust cast
  cc.fillStyle = 'rgb(52,48,44)'; cc.fillRect(0, 0, S, S);
  speckle(cc, S, S, rng, 900, 2, 9, (r) => `rgba(${r.int(70, 105)},${r.int(48, 62)},${r.int(34, 42)},${r.range(0.08, 0.25)})`);
  speckle(cc, S, S, rng, 500, 1, 3, (r) => `rgba(${r.int(90, 120)},${r.int(88, 110)},${r.int(80, 100)},${r.range(0.1, 0.3)})`);
  hc.fillStyle = '#fff'; hc.fillRect(0, 0, S, S);
  rc.fillStyle = 'rgb(0,175,0)'; rc.fillRect(0, 0, S, S);
  // slots: ring segments between radial ribs
  const rings = [];
  for (let r = GRATE_HOLE + 0.05; r < GRATE * 0.7; r += 0.045) rings.push(r);
  for (const r of rings) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.11));
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2 + 0.035 / r, a1 = ((k + 1) / n) * Math.PI * 2 - 0.035 / r;
      for (const [ctx, style] of [[cc, 'rgb(14,12,11)'], [hc, '#000'], [rc, 'rgb(0,255,0)']]) {
        ctx.beginPath();
        ctx.arc(c, c, r * px, a0, a1);
        ctx.lineWidth = 0.017 * px; ctx.lineCap = 'butt';
        ctx.strokeStyle = style; ctx.stroke();
      }
    }
  }
  // solid frame and hub ring
  for (const [ctx, style] of [[cc, null], [hc, '#fff'], [rc, null]]) {
    if (!style) continue;
    ctx.lineWidth = 0.045 * px; ctx.strokeStyle = style; ctx.strokeRect(0.0225 * px, 0.0225 * px, S - 0.045 * px, S - 0.045 * px);
  }
  // opening: mulch / soil
  cc.save();
  cc.beginPath(); cc.arc(c, c, GRATE_HOLE * px, 0, Math.PI * 2); cc.clip();
  cc.fillStyle = 'rgb(46,36,28)'; cc.fillRect(0, 0, S, S);
  speckle(cc, S, S, rng, 700, 1.5, 6, (r) => `rgba(${r.int(60, 110)},${r.int(44, 78)},${r.int(30, 52)},${r.range(0.4, 0.9)})`);
  speckle(cc, S, S, rng, 120, 1, 2.5, (r) => `rgba(${r.int(150, 180)},${r.int(140, 160)},${r.int(120, 140)},0.6)`); // grit
  cc.restore();
  for (const ctx of [hc, rc]) {
    ctx.beginPath(); ctx.arc(c, c, GRATE_HOLE * px, 0, Math.PI * 2);
    ctx.fillStyle = ctx === hc ? 'rgb(90,90,90)' : 'rgb(0,240,0)'; ctx.fill();
  }
  // polished wear on the raised iron where people walk
  cc.globalCompositeOperation = 'source-atop';
  speckle(cc, S, S, rng, 160, 6, 22, (r) => `rgba(120,116,108,${r.range(0.03, 0.08)})`);
  cc.globalCompositeOperation = 'source-over';
  const m = new THREE.MeshStandardMaterial({
    name: 'vegetation.grate',
    map: tex(col, true), normalMap: tex(normalFromHeight(hgt, 2.5), false), roughnessMap: tex(rough, false),
    roughness: 1, metalness: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  return m;
}

/** Weathered round timber for tree stakes (u: 0.25 m around, v: 1 m along). */
function stakeMaterial(rng) {
  const W = 128, H = 512;
  const col = canvas(W, H), cc = col.getContext('2d');
  cc.fillStyle = 'rgb(140,124,100)'; cc.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) { // grain streaks along the length
    const x = rng.range(0, W), w = rng.range(0.6, 2.5);
    cc.fillStyle = `rgba(${rng.int(80, 110)},${rng.int(70, 92)},${rng.int(55, 70)},${rng.range(0.15, 0.4)})`;
    cc.fillRect(x, 0, w, H);
  }
  speckle(cc, W, H, rng, 60, 2, 10, (r) => `rgba(${r.int(150, 175)},${r.int(145, 160)},${r.int(130, 140)},${r.range(0.15, 0.35)})`); // silvering
  for (let i = 0; i < 4; i++) { // knots
    const x = rng.range(10, W - 10), y = rng.range(20, H - 20);
    cc.fillStyle = 'rgba(70,52,38,0.7)'; cc.beginPath(); cc.ellipse(x, y, 4, 7, 0, 0, Math.PI * 2); cc.fill();
  }
  return new THREE.MeshStandardMaterial({ name: 'vegetation.stake', map: tex(col, true, true), roughness: 0.85, metalness: 0 });
}

/** Dark planting soil with bark mulch (0.5 m tile). */
function soilMaterial(rng) {
  const S = 256, c = canvas(S, S), ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(48,38,30)'; ctx.fillRect(0, 0, S, S);
  speckle(ctx, S, S, rng, 900, 1, 5, (r) => `rgba(${r.int(30, 90)},${r.int(24, 66)},${r.int(18, 46)},${r.range(0.4, 0.9)})`);
  for (let i = 0; i < 160; i++) { // mulch chips
    ctx.save(); ctx.translate(rng.range(0, S), rng.range(0, S)); ctx.rotate(rng.range(0, 3.14));
    ctx.fillStyle = `rgb(${rng.int(90, 130)},${rng.int(62, 86)},${rng.int(40, 56)})`;
    ctx.fillRect(-rng.range(3, 8), -rng.range(1, 2.5), rng.range(6, 16), rng.range(2, 5));
    ctx.restore();
  }
  return new THREE.MeshStandardMaterial({ name: 'vegetation.soil', map: tex(c, true, true), roughness: 0.95, metalness: 0 });
}

// ------------------------------------------------------------------ geometry
/**
 * Sweep a profile [[o, y], ...] (o = outward offset from the nominal outer face) around a
 * rounded rectangle w x d (corner radius cr). UVs in metres (u along the perimeter,
 * v along the profile). Flat-shaded facets per profile segment; colours from colorFn(y, o).
 */
function sweepRoundedRect(w, d, prof, cr, colorFn) {
  const path = [];
  const hw = w / 2 - cr, hd = d / 2 - cr, cseg = 4;
  const corners = [[hw, hd, 0], [-hw, hd, Math.PI / 2], [-hw, -hd, Math.PI], [hw, -hd, Math.PI * 1.5]];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= cseg; k++) {
      const a = a0 + (k / cseg) * Math.PI / 2;
      path.push([cx, cz, Math.cos(a), Math.sin(a)]);
    }
  }
  path.push(path[0]);
  const pos = [], nor = [], uv = [], col = [], idx = [];
  let u = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const A = path[i], B = path[i + 1];
    const du = Math.hypot((B[0] + B[2] * cr) - (A[0] + A[2] * cr), (B[1] + B[3] * cr) - (A[1] + A[3] * cr));
    let v = 0;
    for (let j = 0; j < prof.length - 1; j++) {
      const [o0, y0] = prof[j], [o1, y1] = prof[j + 1];
      const len = Math.hypot(o1 - o0, y1 - y0);
      const nh = (y1 - y0) / len, nv = -(o1 - o0) / len; // 2D outward normal of the segment
      const base = pos.length / 3;
      for (const [P, pu] of [[A, u], [B, u + du]]) {
        for (const [o, y, pv] of [[o0, y0, v], [o1, y1, v + len]]) {
          pos.push(P[0] + P[2] * (cr + o), y, P[1] + P[3] * (cr + o));
          nor.push(P[2] * nh, nv, P[3] * nh);
          uv.push(pu, pv);
          const c = colorFn(y, o);
          col.push(c, c, c * 0.98);
        }
      }
      // vertices: 0 = A/p0, 1 = A/p1, 2 = B/p0, 3 = B/p1; front faces point along the profile normal
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      v += len;
    }
    u += du;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Limestone planter shell (outer w x d, height H) and its soil surface. */
function planterGeometry(w, d, H) {
  const T = 0.075; // wall thickness
  const prof = [
    [-0.02, 0.0], [-0.02, 0.05], [0.0, 0.06],            // recessed plinth, step out
    [0.006, H - 0.035], [0.014, H - 0.03],                // slight batter, drip edge
    [0.014, H - 0.018], [0.0, H],                          // top chamfer
    [-T + 0.008, H], [-T, H - 0.01], [-T, H - 0.12],       // top, inner arris, inner wall
  ];
  const shell = sweepRoundedRect(w, d, prof, 0.03, (y, o) => {
    if (o < -T * 0.5) return 0.62;                             // inner wall, shaded
    return y < 0.12 ? 0.72 + 0.28 * (y / 0.12) : 1.0 - 0.06 * Math.max(0, (y - H + 0.1) / 0.1); // splash dirt, rim wear
  });
  const soilY = H - 0.065;
  const soil = new THREE.PlaneGeometry(w - 2 * T + 0.01, d - 2 * T + 0.01);
  soil.rotateX(-Math.PI / 2);
  soil.translate(0, soilY, 0);
  // metre UVs at 2x density for the 0.5 m soil tile
  const uv = soil.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w - 2 * T) * 2, uv.getY(i) * (d - 2 * T) * 2);
  return { shell, soil, soilY, inner: [w - 2 * T, d - 2 * T] };
}

/** Round stake with a small chamfer at the top, UVs scaled for the stake texture. */
function stakeGeometry(len, r) {
  const body = new THREE.CylinderGeometry(r, r, len, 10, 1, true);
  body.translate(0, len / 2, 0);
  const cap = new THREE.CylinderGeometry(r * 0.75, r, 0.015, 10, 1, false);
  cap.translate(0, len + 0.0075, 0);
  for (const g of [body, cap]) {
    const uv = g.attributes.uv;
    const circ = 2 * Math.PI * r;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ / 0.25, uv.getY(i) * len);
  }
  const g = mergeSimple([body, cap]);
  return g;
}

function mergeSimple(list) {
  const pos = [], nor = [], uv = [], idx = [];
  let off = 0;
  for (const g0 of list) {
    const g = g0.index ? g0 : g0;
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); uv.push(t.getX(i), t.getY(i)); }
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + off);
    off += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ public
export function createProps(app) {
  const M = app.materials;
  const rng = RNG.from(app.layout.seed, 'vegprops');
  const mats = {
    grate: M.register('vegetation.grate', grateMaterial(rng)),
    stake: M.register('vegetation.stake', stakeMaterial(rng)),
    soil: M.register('vegetation.soil', soilMaterial(rng)),
    stone: M.get('stone.smooth', { vertexColors: true }),
    rubber: M.get('rubber'),
  };
  // shared unit geometries (cloned + transformed by MeshBatcher per chunk)
  const grate = new THREE.PlaneGeometry(GRATE, GRATE);
  grate.rotateX(-Math.PI / 2);
  const post = stakeGeometry(1.75, 0.032);
  const batten = new THREE.BoxGeometry(0.9, 0.065, 0.024);
  const tie = new THREE.TorusGeometry(1, 0.12, 4, 14);
  tie.rotateX(Math.PI / 2);
  const strap = new THREE.BoxGeometry(1, 0.03, 0.004);
  const planters = [planterGeometry(1.5, 0.66, 0.48), planterGeometry(0.86, 0.86, 0.52)];

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _v = new THREE.Vector3(), _e = new THREE.Euler();
  const X1 = new THREE.Vector3(1, 0, 0);
  const local = (treeM, x, y, z) => _p.set(x, y, z).applyMatrix4(treeM);

  return {
    mats,
    begin(lod) {
      const b = new MeshBatcher();
      const { route } = app;
      return {
        /** Grate and (young trees) stakes, ties. treeM: the tree instance matrix. */
        tree(t, T, treeM, yaw, sy, sxz, r) {
          if (lod) return; // sub-pixel beyond 200 m
          // grate aligned with the paving grid, a few mm proud of the paving
          const heading = route.heading(t.s);
          route.toWorld(t.s, t.d, 0.004, _p);
          _q.setFromAxisAngle(UP, heading);
          _m.compose(_p, _q, _s.set(1, 1, 1));
          b.add(mats.grate, grate, _m);
          if (!T.tpl.stake || r.next() < 0.25) return;
          // two stakes either side of the stem along the street, a batten across their tops
          // on the far side from the tracks, and a rubber tie from the stem to the batten
          const st0 = T.stem(0), st = T.stem(1.45);
          const ax = _a.setFromMatrixColumn(treeM, 0).setY(0).normalize(); // away from the tracks
          const az = _b.setFromMatrixColumn(treeM, 2).setY(0).normalize(); // along the street
          const stemBase = local(treeM, st0.x, 0, st0.z).clone();
          const ends = [];
          for (const side of [-1, 1]) {
            const base = stemBase.clone().addScaledVector(az, side * 0.4).addScaledVector(ax, T.stem(0.5).r * sxz + 0.04);
            base.y -= 0.02;
            _e.set(r.range(-0.03, 0.03), r.range(0, 6.28), r.range(-0.03, 0.03));
            _q.setFromEuler(_e);
            _m.compose(base, _q, _s.set(1, 1, 1));
            b.add(mats.stake, post, _m);
            ends.push(base);
          }
          const clear = T.stem(1.6).r * sxz + 0.03; // batten passes behind the stem, never through it
          const mid = ends[0].clone().add(ends[1]).multiplyScalar(0.5).addScaledVector(ax, clear);
          mid.y += 1.62;
          const span = _v.subVectors(ends[1], ends[0]).setY(0);
          const spanLen = span.length();
          _q.setFromUnitVectors(X1, span.normalize());
          _m.compose(mid, _q, _s.set((spanLen + 0.12) / 0.9, 1, 1));
          b.add(mats.stake, batten, _m);
          const stemP = local(treeM, st.x, 1.45, st.z).clone();
          const rr = st.r * sxz + 0.008;
          _m.compose(stemP, _q.identity(), _s.set(rr, 0.125, rr));
          b.add(mats.rubber, tie, _m);
          const tgt = mid.clone().setY(stemP.y);
          const len = tgt.distanceTo(stemP);
          if (len > 0.02) {
            _q.setFromUnitVectors(X1, _v.subVectors(tgt, stemP).normalize());
            _m.compose(stemP.add(tgt).multiplyScalar(0.5), _q, _s.set(len, 1, 1));
            b.add(mats.rubber, strap, _m);
          }
        },
        /** Planter box; returns where the shrub mound goes and its footprint scale. */
        planter(f, kind, yaw, r) {
          const P = planters[kind];
          route.toWorld(f.s, f.d, 0, _p);
          const pos = _p.clone();
          _q.setFromAxisAngle(UP, yaw);
          _m.compose(pos, _q, _s.set(1, 1, 1));
          b.add(mats.stone, P.shell, _m);
          b.add(mats.soil, P.soil, _m);
          const top = pos.clone(); top.y += P.soilY;
          const shrubW = kind === 0 ? 1.3 : 0.68, shrubD = kind === 0 ? 0.5 : 0.68;
          return { pos: top, sx: (P.inner[0] / shrubW) * 0.98, sz: (P.inner[1] / shrubD) * 0.98, kind };
        },
        build() {
          if (!b.map.size) return null;
          const g = b.build({ name: 'vegetation:props', castShadow: true, receiveShadow: true });
          // flat or tiny parts do not need to be drawn into the shadow cascades
          for (const m of g.children) if (m.material === mats.grate || m.material === mats.soil || m.material === mats.rubber) m.castShadow = false;
          return g;
        },
      };
    },
  };
}
