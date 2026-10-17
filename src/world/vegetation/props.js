import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { InstancePool } from './pool.js';

// Static props around the street trees and the planters owned by vegetation:
//   * cast-iron tree grates (slotted rings, mulch in the opening) in an L-section frame
//     standing a few mm proud of the paving;
//   * timber stakes inside the opening, a cross batten and a rubber tie on the youngest
//     trees (fresh pine or silvered timber, darker cut tops);
//   * limestone planters (bevelled trough or square box) with soil and a soft contact
//     shadow on the paving, holding a shrub mound (the foliage itself is instanced in the
//     leaf pool by vegetation.js).
// Every prop is an instance in a BatchedMesh per material, created at init: a chunk build
// only adds instances (no geometry is copied), and they follow the chunk's visibility
// through the vegetation pools. Textures are painted on canvases at init.

const UP = new THREE.Vector3(0, 1, 0);
const GRATE = 1.2;          // grate size (m)
const GRATE_HOLE = 0.27;    // radius of the opening around the trunk
const STAKE_OFF = 0.18;     // stake axis from the stem axis (inside the opening)

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

/**
 * Cast-iron tree grate: concentric slotted rings with radial ribs, mulch in the opening.
 * Each slot shows soil at the bottom, a lit inner wall on one side and a shadowed one on
 * the other, so it reads as a hole rather than a painted dash.
 */
function grateMaterial(rng) {
  const S = 1024, px = S / GRATE, c = S / 2;
  const col = canvas(S, S), hgt = canvas(S, S), rough = canvas(S, S);
  const cc = col.getContext('2d'), hc = hgt.getContext('2d'), rc = rough.getContext('2d');
  // iron base: dark grey with a brown rust cast (albedo ~0.04-0.06)
  cc.fillStyle = 'rgb(58,54,50)'; cc.fillRect(0, 0, S, S);
  speckle(cc, S, S, rng, 1800, 3, 16, (r) => `rgba(${r.int(78, 110)},${r.int(52, 66)},${r.int(36, 44)},${r.range(0.08, 0.25)})`);
  speckle(cc, S, S, rng, 1000, 1, 5, (r) => `rgba(${r.int(92, 124)},${r.int(90, 112)},${r.int(82, 102)},${r.range(0.1, 0.3)})`);
  hc.fillStyle = '#fff'; hc.fillRect(0, 0, S, S);
  rc.fillStyle = 'rgb(0,170,0)'; rc.fillRect(0, 0, S, S);
  // slots: ring segments between radial ribs
  const rings = [];
  for (let r = GRATE_HOLE + 0.055; r < GRATE * 0.7; r += 0.045) rings.push(r);
  const slotW = 0.017 * px;
  const arc = (ctx, r, a0, a1, w, style, dy = 0) => {
    ctx.beginPath(); ctx.arc(c, c + dy, r * px, a0, a1);
    ctx.lineWidth = w; ctx.lineCap = 'butt'; ctx.strokeStyle = style; ctx.stroke();
  };
  for (const r of rings) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.11));
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2 + 0.035 / r, a1 = ((k + 1) / n) * Math.PI * 2 - 0.035 / r;
      // clip to the plate (corners of the square)
      const am = (a0 + a1) / 2, ex = c + Math.cos(am) * r * px, ey = c + Math.sin(am) * r * px;
      if (ex < 0.06 * px || ex > S - 0.06 * px || ey < 0.06 * px || ey > S - 0.06 * px) continue;
      // soil / leaf litter at the bottom, then the two inner walls
      arc(cc, r, a0, a1, slotW, `rgb(${rng.int(30, 40)},${rng.int(24, 30)},${rng.int(18, 22)})`);
      arc(cc, r, a0, a1, slotW * 0.3, 'rgba(12,10,9,0.9)', -slotW * 0.35);
      arc(cc, r, a0, a1, slotW * 0.22, 'rgba(96,88,78,0.55)', slotW * 0.38);
      arc(hc, r, a0, a1, slotW, '#000');
      arc(rc, r, a0, a1, slotW, 'rgb(0,255,0)');
    }
  }
  // the frame band (UV corner region used by the frame geometry): plain iron
  // opening: mulch / soil
  cc.save();
  cc.beginPath(); cc.arc(c, c, GRATE_HOLE * px, 0, Math.PI * 2); cc.clip();
  cc.fillStyle = 'rgb(46,36,28)'; cc.fillRect(0, 0, S, S);
  speckle(cc, S, S, rng, 1400, 2, 10, (r) => `rgba(${r.int(60, 110)},${r.int(44, 78)},${r.int(30, 52)},${r.range(0.4, 0.9)})`);
  speckle(cc, S, S, rng, 260, 1.5, 4, (r) => `rgba(${r.int(150, 180)},${r.int(140, 160)},${r.int(120, 140)},0.6)`); // grit
  speckle(cc, S, S, rng, 40, 5, 12, (r) => `rgba(${r.int(110, 150)},${r.int(100, 130)},${r.int(50, 70)},0.7)`);   // fallen leaflets
  cc.restore();
  // inner rim of the opening: a thin iron lip
  cc.beginPath(); cc.arc(c, c, GRATE_HOLE * px, 0, Math.PI * 2); cc.lineWidth = 0.012 * px; cc.strokeStyle = 'rgb(54,50,46)'; cc.stroke();
  for (const ctx of [hc, rc]) {
    ctx.beginPath(); ctx.arc(c, c, GRATE_HOLE * px, 0, Math.PI * 2);
    ctx.fillStyle = ctx === hc ? 'rgb(70,70,70)' : 'rgb(0,240,0)'; ctx.fill();
  }
  // polished wear on the raised iron where people walk
  cc.globalCompositeOperation = 'source-atop';
  speckle(cc, S, S, rng, 260, 10, 40, (r) => `rgba(124,120,112,${r.range(0.03, 0.08)})`);
  cc.globalCompositeOperation = 'source-over';
  return new THREE.MeshStandardMaterial({
    name: 'vegetation.grate',
    map: tex(col, true), normalMap: tex(normalFromHeight(hgt, 3.0), false), roughnessMap: tex(rough, false),
    roughness: 1, metalness: 0.3, vertexColors: true,
  });
}

/** Light timber for tree stakes (u: 0.25 m around, v: 1 m along); tinted per stake. */
function stakeMaterial(rng) {
  const W = 128, H = 512;
  const col = canvas(W, H), cc = col.getContext('2d');
  cc.fillStyle = 'rgb(176,168,154)'; cc.fillRect(0, 0, W, H);
  for (let i = 0; i < 80; i++) { // grain streaks along the length
    const x = rng.range(0, W), w = rng.range(0.6, 2.5);
    cc.fillStyle = `rgba(${rng.int(110, 140)},${rng.int(100, 124)},${rng.int(86, 104)},${rng.range(0.15, 0.4)})`;
    cc.fillRect(x, 0, w, H);
  }
  speckle(cc, W, H, rng, 60, 2, 10, (r) => `rgba(${r.int(190, 205)},${r.int(186, 198)},${r.int(176, 188)},${r.range(0.15, 0.35)})`);
  for (let i = 0; i < 4; i++) { // knots
    const x = rng.range(10, W - 10), y = rng.range(20, H - 20);
    cc.fillStyle = 'rgba(86,66,48,0.7)'; cc.beginPath(); cc.ellipse(x, y, 4, 7, 0, 0, Math.PI * 2); cc.fill();
  }
  // soil stain at the foot (v = 0 at the bottom; canvas y down = v down with flipY)
  const g = cc.createLinearGradient(0, H, 0, H - 0.25 * H);
  g.addColorStop(0, 'rgba(60,46,34,0.75)'); g.addColorStop(1, 'rgba(60,46,34,0)');
  cc.fillStyle = g; cc.fillRect(0, H * 0.75, W, H * 0.25);
  return new THREE.MeshStandardMaterial({ name: 'vegetation.stake', map: tex(col, true, true), roughness: 0.85, metalness: 0, vertexColors: true });
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
/** Add a constant vertex colour attribute (rgb or rgba). */
function withColor(g, c = [1, 1, 1]) {
  const n = g.attributes.position.count, a = new Float32Array(n * c.length);
  for (let i = 0; i < n; i++) a.set(c, i * c.length);
  g.setAttribute('color', new THREE.BufferAttribute(a, c.length));
  return g;
}

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
    return y < 0.12 ? 0.62 + 0.38 * (y / 0.12) : 1.0 - 0.06 * Math.max(0, (y - H + 0.1) / 0.1); // splash dirt, rim wear
  });
  const soilY = H - 0.065;
  const soil = new THREE.PlaneGeometry(w - 2 * T + 0.01, d - 2 * T + 0.01);
  soil.rotateX(-Math.PI / 2);
  soil.translate(0, soilY, 0);
  // metre UVs at 2x density for the 0.5 m soil tile
  const uv = soil.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w - 2 * T) * 2, uv.getY(i) * (d - 2 * T) * 2);
  // contact shadow: a ring on the paving fading out over 0.16 m (rgba vertex colours)
  const skirt = contactSkirt(w - 0.04, d - 0.04, 0.16, 0.55);
  return { shell, soil, skirt, soilY, inner: [w - 2 * T, d - 2 * T] };
}

/** Flat ring around a w x d footprint on the paving: alpha a0 inside, 0 at `out` metres. */
function contactSkirt(w, d, out, a0) {
  const pos = [], col = [], idx = [];
  const ring = (hw, hd, a) => {
    const base = pos.length / 3;
    for (const [x, z] of [[hw, hd], [-hw, hd], [-hw, -hd], [hw, -hd]]) { pos.push(x, 0.003, z); col.push(0, 0, 0, a); }
    return base;
  };
  const i0 = ring(w / 2, d / 2, a0), i1 = ring(w / 2 + out, d / 2 + out, 0);
  for (let k = 0; k < 4; k++) {
    const a = i0 + k, b = i0 + (k + 1) % 4, c = i1 + k, e = i1 + (k + 1) % 4;
    idx.push(a, c, b, b, c, e);
  }
  idx.push(i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2); // under the planter
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

/** Round stake with a chamfered, darker cut top; UVs scaled for the stake texture. */
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
  withColor(body, [1, 1, 1]);
  withColor(cap, [0.62, 0.56, 0.5]);
  return mergeSimple([body, cap]);
}

/** Grate plate (y = 4 mm) inside an L-section frame (30 mm wide, 6 mm proud, bevelled). */
function grateGeometry() {
  const plate = new THREE.PlaneGeometry(GRATE - 0.05, GRATE - 0.05);
  plate.rotateX(-Math.PI / 2);
  plate.translate(0, 0.004, 0);
  const uv = plate.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.0208 + uv.getX(i) * 0.9584, 0.0208 + uv.getY(i) * 0.9584);
  withColor(plate, [1, 1, 1]);
  const frame = sweepRoundedRect(GRATE, GRATE, [[0, -0.01], [0, 0.003], [-0.003, 0.006], [-0.027, 0.006], [-0.03, 0.003], [-0.03, -0.004]], 0.004, () => 1.08);
  const fuv = frame.attributes.uv;
  for (let i = 0; i < fuv.count; i++) fuv.setXY(i, 0.008 + (fuv.getX(i) % 1) * 0.004, 0.008); // plain iron
  return mergeSimple([plate, frame]);
}

function mergeSimple(list) {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  let off = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); uv.push(t.getX(i), t.getY(i));
      col.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
    }
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + off);
    off += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ public
/**
 * Prop pools. begin(rec, lod) returns the per-chunk writer: tree(...) adds a grate and
 * stakes, planter(...) a planter box (returns where its shrub mound goes).
 */
export function createProps(app, pools) {
  const M = app.materials;
  const rng = RNG.from(app.layout.seed, 'vegprops');
  const decal = new THREE.MeshBasicMaterial({ name: 'vegetation.contact', color: 0x000000, vertexColors: true, transparent: true,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const mats = {
    grate: M.register('vegetation.grate', grateMaterial(rng)),
    stake: M.register('vegetation.stake', stakeMaterial(rng)),
    soil: M.register('vegetation.soil', soilMaterial(rng)),
    contact: M.register('vegetation.contact', decal),
    stone: M.get('stone.smooth', { vertexColors: true }),
    rubber: M.get('rubber'),
  };
  mats.grate.polygonOffset = true; mats.grate.polygonOffsetFactor = -2; mats.grate.polygonOffsetUnits = -2;
  // shared geometries
  const grate = grateGeometry();
  const post = stakeGeometry(1.75, 0.032);
  const batten = withColor(new THREE.BoxGeometry(0.6, 0.065, 0.024));
  const tie = new THREE.TorusGeometry(1, 0.12, 4, 14);
  tie.rotateX(Math.PI / 2);
  const strap = new THREE.BoxGeometry(1, 0.03, 0.004);
  const planters = [planterGeometry(1.5, 0.66, 0.48), planterGeometry(0.86, 0.86, 0.52)];
  const pool = (name, mat, geoms, cap, cast) => pools.addPool(new InstancePool(name, mat, null, geoms, cap, { castShadow: cast, receiveShadow: true, sort: false }));
  const P = {
    grate: pool('vegetation:grates', mats.grate, [grate], 128, false),
    stake: pool('vegetation:stakes', mats.stake, [post, batten], 128, true),
    rubber: pool('vegetation:ties', mats.rubber, [tie, strap], 96, false),
    stone: pool('vegetation:planters', mats.stone, planters.map((p) => p.shell), 48, true),
    soil: pool('vegetation:soil', mats.soil, planters.map((p) => p.soil), 48, false),
    contact: pool('vegetation:contact', mats.contact, planters.map((p) => p.skirt), 48, false),
  };
  P.contact.mesh.receiveShadow = false;
  P.contact.mesh.renderOrder = 1;

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _v = new THREE.Vector3(), _e = new THREE.Euler();
  const _base = new THREE.Vector3(), _mid = new THREE.Vector3(), _stemP = new THREE.Vector3(), _tgt = new THREE.Vector3();
  const _ends = [new THREE.Vector3(), new THREE.Vector3()];
  const _c = new THREE.Color();
  const X1 = new THREE.Vector3(1, 0, 0);
  const local = (treeM, x, y, z, out) => out.set(x, y, z).applyMatrix4(treeM);

  return {
    mats, pools: P,
    begin(rec, lod) {
      const { route } = app;
      const add = (p, g, m, c, size = 1) => pools.add(rec, p, g, m, c, _p.setFromMatrixPosition(m), size);
      return {
        /** Grate and (young trees) stakes, ties. treeM: the tree instance matrix. */
        tree(t, T, treeM, sxz, r) {
          if (lod) return; // sub-pixel beyond 200 m
          // grate aligned with the paving grid, flush with the paving
          const heading = route.heading(t.s);
          route.toWorld(t.s, t.d, 0, _base);
          _q.setFromAxisAngle(UP, heading);
          _m.compose(_base, _q, _s.set(1, 1, 1));
          add(P.grate, 0, _m, null);
          if (!T.tpl.stake || r.next() < 0.25) return;
          // two stakes either side of the stem along the street, inside the opening; a batten
          // across their tops on the far side from the tracks, a rubber tie stem -> batten
          const st0 = T.stem(0), st = T.stem(1.45);
          const ax = _a.setFromMatrixColumn(treeM, 0).setY(0).normalize(); // away from the tracks
          const az = _b.setFromMatrixColumn(treeM, 2).setY(0).normalize(); // along the street
          local(treeM, st0.x, 0, st0.z, _base);
          // timber: fresh pine or silvered with age
          const pine = r.chance(0.5), tv = r.range(0.92, 1.05);
          if (pine) _c.setRGB(1.08 * tv, 0.93 * tv, 0.7 * tv); else _c.setRGB(0.86 * tv, 0.86 * tv, 0.85 * tv);
          for (let k = 0; k < 2; k++) {
            const side = k ? 1 : -1;
            const e = _ends[k].copy(_base).addScaledVector(az, side * STAKE_OFF).addScaledVector(ax, r.range(-0.02, 0.03));
            e.y -= 0.02;
            _e.set(r.range(-0.03, 0.03), r.range(0, 6.28), r.range(-0.03, 0.03));
            _q.setFromEuler(_e);
            _m.compose(e, _q, _s.set(1, 1, 1));
            add(P.stake, 0, _m, _c, 1.8);
          }
          const clear = T.stem(1.6).r * sxz + 0.03; // batten passes behind the stem, never through it
          _mid.copy(_ends[0]).add(_ends[1]).multiplyScalar(0.5).addScaledVector(ax, clear);
          _mid.y += 1.62;
          const span = _v.subVectors(_ends[1], _ends[0]).setY(0);
          const spanLen = span.length();
          _q.setFromUnitVectors(X1, span.normalize());
          _m.compose(_mid, _q, _s.set((spanLen + 0.12) / 0.6, 1, 1));
          add(P.stake, 1, _m, _c);
          local(treeM, st.x, 1.45, st.z, _stemP);
          const rr = st.r * sxz + 0.008;
          _m.compose(_stemP, _q.identity(), _s.set(rr, 0.125, rr));
          add(P.rubber, 0, _m, null);
          _tgt.copy(_mid).setY(_stemP.y);
          const len = _tgt.distanceTo(_stemP);
          if (len > 0.02) {
            _q.setFromUnitVectors(X1, _v.subVectors(_tgt, _stemP).normalize());
            _m.compose(_v.copy(_stemP).add(_tgt).multiplyScalar(0.5), _q, _s.set(len, 1, 1));
            add(P.rubber, 1, _m, null);
          }
        },
        /** Planter box; returns where the shrub mound goes and its footprint scale. */
        planter(f, kind, yaw, out) {
          const G = planters[kind];
          route.toWorld(f.s, f.d, 0, out.pos);
          _q.setFromAxisAngle(UP, yaw);
          _m.compose(out.pos, _q, _s.set(1, 1, 1));
          add(P.stone, kind, _m, null);
          add(P.soil, kind, _m, null);
          add(P.contact, kind, _m, null);
          out.pos.y += G.soilY;
          const shrubW = kind === 0 ? 1.3 : 0.68, shrubD = kind === 0 ? 0.5 : 0.68;
          out.sx = (G.inner[0] / shrubW) * 0.98;
          out.sz = (G.inner[1] / shrubD) * 0.98;
          return out;
        },
      };
    },
  };
}
