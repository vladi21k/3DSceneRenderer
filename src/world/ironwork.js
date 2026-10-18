import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND, LOD0_DIST } from '../core/config.js';
import { facadePlan, archPoint } from './facadePlan.js';
import { DESIGNS, RAIL_H } from './ironwork/patterns.js';
import { bayGeometry, postGeometry, buildAtlas, atlasV, ATLAS, TOL } from './ironwork/railings.js';
import {
  slabPath, writeSlab, writeSlabShadow, corbelGeometry, corbelTemplate, CORBEL, balusterGeometry, plinthProfile, copingProfile,
  BALUSTRADE, makeStoneMaterial, GRIME, shadowTemplates, writeBalustradeShadow,
} from './ironwork/stone.js';
import { GeoWriter, PosWriter, writePos, sweepPath, box } from './ironwork/geo.js';
import { InstanceCollector, InstancePool, FlagPool } from './ironwork/instancer.js';
import { Strip } from './ironwork/strip.js';
import {
  makeMaterials, PAINTS, PAINT_W, uIronPx, uIronA2C, uIronCardK, uIronGeoK, uIwWiden, geoLimit, angleK,
} from './ironwork/mats.js';
import { buildAttachAssets, makeAttachMaterials, writeTemplate, PLANT, BOX_SOIL, TROUGH_SOIL } from './ironwork/attach.js';

// Balconies and facade attachments: carved stone slabs on scroll consoles, wrought-iron
// railings (instanced geometry near, coverage cards far) or stone balustrades, planters,
// AC units, flags and dishes. Everything is placed from facadePlan(lot) in the lot's
// facade frame (u along the wall, v up, w out of the wall). Contract: docs/ARCHITECTURE.md.
//
// Level of detail is chosen per INSTANCE (each railing bay, post, console, baluster,
// plant, planter strap, AC unit) in update(), from projected sizes, so it follows the FOV:
//   rail   bay tessellation level whose chord error stays under 0.4 px (railings.js TOL),
//          then nothing once bars are thinner than ~0.8 px, foreshortening included
//          (the cards carry on)
//   post   finial post / plain post, same range
//   carve  carved consoles, turned balusters / light levels whose omissions (~1 cm)
//          stay under 0.6 px, so the switch does not show
//   plant  full plantings / light ones (same rule) / far ones, a few larger cards
//          covering as much, once the light level's leaves are under 2 px
//   strap  planter hook straps, until they are thinner than a pixel
//   ac     AC unit with pipes and brackets / the bare body, same rule for the pipes
// Railing cards are always present: they fade in under the geometry and take over from
// it without holes (see ironwork/mats.js). Far chunks (lod 1) have cards only, far
// consoles merged into the stone mesh and the same instanced plants as near chunks.
//
// Draw calls: nothing is drawn per chunk. Merged geometry goes into one strip per
// material and detail range for the whole street (ironwork/strip.js: one draw per pass,
// culled per chunk block) and instances into one pool per family (ironwork/instancer.js:
// one draw per detail level in use, culled per chunk and, within it, per balcony stretch
// or window). A chunk's build returns an empty marker group; its blocks and instances
// are shown when the streamer shows the chunk and released on dispose. Builds are
// prepared ahead in small steps (see prefetch and warmStart).
// Shadows: position-only strips of light stand-ins cast them, the drawn geometry casts
// nothing. Slabs, consoles, balustrade rails and AC bodies cast in every cascade; the
// small and thin parts (balusters, pots, planters, chairs, poles, brackets, pipes) only
// in the fine cascades, whose texels can hold them (userData.thinCaster). The railing
// cards (thin) and a coarse twin of the flags cast the rest.

const _l = new THREE.Matrix4(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _sz = new THREE.Vector2();
const _q = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _c4 = new THREE.Matrix4(), _ap = {}, _pm = new THREE.Matrix4(), _fr = new THREE.Frustum();
const _pb = new THREE.Matrix4(), _pl = new THREE.Matrix4(), _pv = new THREE.Vector3();

/** Time slice (ms per frame) for preparing upcoming chunks in update(). */
const PREFETCH_MS = 0.5;

// Balcony gardening. Most balconies are bare: a building's residents garden a little,
// some or a lot (lotStyle greenery: the chance that a household plants), and what one
// household grows differs from the next: geraniums, herbs, trailing greens, surfinia,
// bougainvillea, boxes left to dry out or standing empty.
const GROW = { GERANIUM: 0, HERBS: 1, GREEN: 2, SURFINIA: 3, BOUG: 4, DRY: 5, EMPTY: 6 };
const GROW_W = [0.36, 0.12, 0.12, 0.08, 0.08, 0.13, 0.11];
// Linear albedo tints of the flowering parts. Geraniums: scarlet, red, pink, magenta,
// orange, white, salmon, lilac.
const FLOWERS = [[0.62, 0.012, 0.016], [0.75, 0.03, 0.02], [0.82, 0.16, 0.3], [0.5, 0.02, 0.17], [0.85, 0.2, 0.1], [0.8, 0.78, 0.74], [0.85, 0.32, 0.2], [0.45, 0.2, 0.5]];
const FLOWER_W = [0.26, 0.2, 0.18, 0.11, 0.08, 0.07, 0.06, 0.04];
// herb spikes: lavender, sage blue, basil white, not in flower (leafy)
const HERBS = [[0.32, 0.2, 0.55], [0.2, 0.12, 0.42], [0.7, 0.7, 0.66], [0.09, 0.16, 0.05]];
const HERB_W = [0.25, 0.15, 0.2, 0.4];
// surfinia: purple, magenta, white, pink, crimson; trailing greens hide their flowers
const SURFINIA = [[0.32, 0.03, 0.42], [0.62, 0.04, 0.3], [0.78, 0.78, 0.74], [0.8, 0.3, 0.48], [0.5, 0.03, 0.05]];
const TRAIL_GREEN = [0.05, 0.1, 0.03];
// bougainvillea bracts: magenta, purple, cerise, orange, cream
const BOUG = [[0.55, 0.015, 0.22], [0.42, 0.02, 0.32], [0.7, 0.05, 0.3], [0.85, 0.3, 0.08], [0.78, 0.74, 0.68]];
const BOUG_W = [0.4, 0.22, 0.18, 0.12, 0.08];
// withered flower heads
const WITHERED = [[0.16, 0.09, 0.045], [0.24, 0.15, 0.08], [0.11, 0.07, 0.045], [0.3, 0.22, 0.12]];
// planter boxes and troughs: terracotta (three), brown, green, white and anthracite
// plastic, fibre-cement grey, galvanised zinc
const BOXES = [[0.42, 0.16, 0.08], [0.36, 0.14, 0.06], [0.4, 0.22, 0.13], [0.12, 0.065, 0.035], [0.035, 0.075, 0.04], [0.6, 0.59, 0.55], [0.045, 0.045, 0.045], [0.3, 0.29, 0.27], [0.36, 0.37, 0.36]];
const BOX_W = [0.2, 0.12, 0.1, 0.12, 0.1, 0.12, 0.1, 0.08, 0.06];
const POTS = [[0.42, 0.16, 0.08], [0.32, 0.11, 0.05], [0.36, 0.14, 0.06], [0.2, 0.1, 0.055], [0.07, 0.11, 0.07], [0.42, 0.41, 0.38]];
const CHAIRS = [[0.75, 0.75, 0.72], [0.07, 0.2, 0.1], [0.5, 0.5, 0.48]];
const LEAFY = [0.09, 0.16, 0.05];
const TOWELS = [[0.8, 0.8, 0.78], [0.62, 0.55, 0.42], [0.12, 0.2, 0.42], [0.55, 0.12, 0.1], [0.3, 0.45, 0.35], [0.75, 0.65, 0.2]];
const WHITE = [1, 1, 1];
// instance families (constant keys and options: one lookup per family and chunk)
const CORBEL_KEYS = ['corbel0', 'corbel1'], PLANT_KEYS = Object.values(PLANT).map((k) => `plant${k}`);
const PLANT_OPTS = { cls: 'plant' }, CORBEL_OPTS = { cls: 'carve', radius: 1 }, BALUSTER_OPTS = { cls: 'carve', thin: true };
const BAY_OPTS = { cls: 'rail', radius: 0.8, angle: true, thin: true }, POST_OPTS = { cls: 'post', radius: 1.2, thin: true };
// All dishes in town aim at the same satellite: a fixed world direction (south-west, 40° up).
const DISH_DIR = new THREE.Vector3(-0.55, 0.64, 0.53).normalize();
// Stone tints are relative to the cream reference, exactly as the buildings tint theirs.
// WARM shifts the dressed-stone albedo toward the mean of the ashlar blocks around it
// (their per-block hue variation leans warm), measured on screen at equal lighting.
const CREAM = [0.86, 0.80, 0.68], WARM = [1.02, 1.0, 0.965];

const weighted = (r, w) => { let x = r.next() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return i; } return w.length - 1; };

/** Sphere around facade anchors (x, y, z, r, ...) padded for attachments and flags. */
function boundsOf(a) {
  const bx = new THREE.Box3();
  for (let i = 0; i < a.length; i += 4) bx.expandByPoint(_p.set(a[i], a[i + 1], a[i + 2]));
  const sp = bx.getBoundingSphere(new THREE.Sphere());
  let r = 0;
  for (let i = 0; i < a.length; i += 4) r = Math.max(r, sp.center.distanceTo(_p.set(a[i], a[i + 1], a[i + 2])) + a[i + 3]);
  sp.radius = r + 6;
  return sp;
}

/** Per-building ironwork style (deterministic from the lot seed). */
function lotStyle(lot, plan) {
  const r = new RNG(hash2(lot.seed, 0x1f0e));
  const era = plan.style.era;
  const design = era === 'modern' ? r.weighted([[5, 0.6], [2, 0.25], [6, 0.15]])
    : era === 'mandate' ? r.weighted([[2, 0.24], [6, 0.22], [3, 0.18], [0, 0.14], [5, 0.08], [1, 0.14]])
      : r.weighted([[0, 0.26], [1, 0.22], [4, 0.22], [3, 0.16], [6, 0.14]]);
  const paint = r.chance(0.78) ? -1 : weighted(r, PAINT_W);
  const railH = r.range(0.96, 1.07);
  const corbel = era === 'modern' ? -1 : r.chance(0.6) ? 0 : 1;
  const slabVariant = era === 'modern' || (era === 'mandate' && r.chance(0.45)) ? 1 : 0;
  const roundStone = r.chance(0.45);
  if (!r.chance(0.1)) r.next(); // (a former draw, kept so the choices after it stay put)
  const flowers = weighted(r, FLOWER_W);
  const pots = r.int(0, POTS.length - 1);
  const flag = r.int(0, 3);
  const k = r.range(0.95, 1.02);
  const tint = plan.style.tint.map((t, i) => Math.pow(t / CREAM[i], 1.1) * k * WARM[i]);
  // gardening (a stream of its own): about half the buildings have bare balconies, in a
  // third some households plant, in the rest (the keen ones) most do. Each building
  // leans toward some plantings; the keen ones let fewer boxes dry out.
  const rg = new RNG(hash2(lot.seed, 0x6a7d));
  const keen = rg.next();
  const greenery = keen < 0.48 ? rg.range(0, 0.07) : keen < 0.8 ? rg.range(0.12, 0.42) : rg.range(0.5, 0.88);
  const grow = GROW_W.map((w, i) => w * rg.range(0.3, 1.7) * (i >= GROW.DRY ? 1.3 - greenery : 1));
  const box = weighted(rg, BOX_W);
  return { design, paint, railH, corbel, slabVariant, roundStone, tint, greenery, grow, box, flowers, pots, flag };
}

// ---------------------------------------------------------------- clearance of openings
// Dressing around an opening's head (surrounds, voussoir rings, keystones, hoods, door
// portals), as the buildings module may draw it, and open shutter leaves folded back
// against the piers either side (facades). Conservative reaches (metres).
function headProfile(o, ground) {
  const door = o.kind === 'door';
  const arched = o.rise > 0.01;
  const reach = ground ? (door ? 0.8 : arched ? 0.62 : 0.34) : 0.4;
  const d0 = o.uc - o.w / 2 - reach, d1 = o.uc + o.w / 2 + reach;
  // open leaves: one leaf width beyond each jamb, up to the crown at their outer edge
  const leaf = o.shutters === 'open' ? [o.uc - o.w - 0.09, o.uc + o.w + 0.09, o.y + o.h + 0.03] : null;
  const hp = {
    u0: leaf ? Math.min(d0, leaf[0]) : d0, u1: leaf ? Math.max(d1, leaf[1]) : d1, d0, d1, leaf,
    flat: o.y + o.h + (ground ? (door ? (arched ? 1.06 : 0.72) : 0.52) : 0.5),
    jamb: o.spring + 0.06, arc: null, door,
  };
  if (arched) {
    const T = ground ? 0.6 : 0.36, a = [];
    for (let i = 0; i <= 20; i++) {
      archPoint(o, i / 20, _ap, T);
      a.push(_ap.u, _ap.v + (Math.abs(_ap.u - o.uc) < 0.22 ? 0.1 : 0)); // keystone
    }
    // left to right (headTopAt walks it with u increasing)
    if (a[0] > a[a.length - 2]) for (let i = 0, j = a.length - 2; i < j; i += 2, j -= 2) {
      [a[i], a[j]] = [a[j], a[i]]; [a[i + 1], a[j + 1]] = [a[j + 1], a[i + 1]];
    }
    hp.arc = a;
  }
  return hp;
}

/** Highest point of an opening's dressing at facade position u (−Infinity if clear).
 *  `seg` (optional {i}) is a cursor into the arc for calls with increasing u. */
function headTopAt(hp, u, seg = null) {
  if (u < hp.u0 || u > hp.u1) return -Infinity;
  const L = hp.leaf;
  const lt = L && u >= L[0] && u <= L[1] ? L[2] : -Infinity;
  if (u < hp.d0 || u > hp.d1) return lt;
  if (hp.door || !hp.arc) return Math.max(lt, hp.flat);
  const a = hp.arc, n = a.length;
  if (u <= a[0]) return Math.max(lt, hp.jamb, a[1]);
  if (u >= a[n - 2]) return Math.max(lt, hp.jamb, a[n - 1]);
  // the segment holding u (the arc runs left to right)
  let i = seg ? seg.i : 0;
  while (i < n - 4 && u > a[i + 2]) i += 2;
  if (seg) seg.i = i;
  const ua = a[i], ub = a[i + 2];
  return Math.max(lt, hp.jamb, a[i + 1] + (a[i + 3] - a[i + 1]) * ((u - ua) / ((ub - ua) || 1)));
}

const planHeads = new WeakMap();
/** Head profiles of the openings on floor `f` of a plan (cached per plan and floor). */
function headsOn(plan, f) {
  let h = planHeads.get(plan);
  if (!h) planHeads.set(plan, (h = []));
  if (!h[f]) h[f] = plan.openings.filter((o) => o.floor === f).map((o) => headProfile(o, f === 0));
  return h[f];
}

const consoleCache = new WeakMap(); // balcony -> placements (plans are cached)
/** Console positions for a balcony: n evenly spread consoles, each moved to the nearest
 *  pier where it clears the dressing of the openings below; where no pier is wide
 *  enough it is shortened to stop above the head, or left out. → [{u, h}] */
function placeConsoles(plan, bal, n, Hc) {
  let out = consoleCache.get(bal);
  if (!out) consoleCache.set(bal, (out = findConsoles(plan, bal, n, Hc)));
  return out;
}
function findConsoles(plan, bal, n, Hc) {
  const soffit = bal.y - bal.slabT, len = bal.u1 - bal.u0;
  const W2 = CORBEL.W / 2;
  const lo = bal.u0 + W2 + 0.03, hi = bal.u1 - W2 - 0.03;
  if (hi <= lo) return [];
  const heads = bal.floor > 0 ? headsOn(plan, bal.floor - 1).filter((hp) => hp.u1 > bal.u0 - 0.5 && hp.u0 < bal.u1 + 0.5) : [];
  const step = 0.03, N = Math.floor((hi - lo) / step) + 1;
  const top = new Float32Array(N).fill(-1e9);
  if (heads.length) {
    // dressing height on a grid widened by a console half-width (+2 cm) either side, each
    // head over its own span only, then the highest point under each console footprint
    // (sliding maximum, monotone deque)
    const K = Math.ceil((W2 + 0.02) / step), M = N + 2 * K, u0 = lo - K * step;
    const raw = new Float32Array(M).fill(-1e9), seg = { i: 0 };
    for (const hp of heads) {
      seg.i = 0;
      const j0 = Math.max(0, Math.ceil((hp.u0 - u0) / step)), j1 = Math.min(M - 1, Math.floor((hp.u1 - u0) / step));
      for (let j = j0; j <= j1; j++) { const h = headTopAt(hp, u0 + j * step, seg); if (h > raw[j]) raw[j] = h; }
    }
    const q = new Int32Array(M);
    let qh = 0, qt = 0;
    for (let j = 0; j < M; j++) {
      while (qt > qh && raw[q[qt - 1]] <= raw[j]) qt--;
      q[qt++] = j;
      const i = j - 2 * K;
      if (i < 0) continue;
      if (q[qh] < i) qh++;
      top[i] = raw[q[qh]];
    }
  }
  const clear = soffit - Hc - 0.075; // knob below the console + 3 cm
  const inset = Math.min(0.32, len * 0.1) + W2;
  const spacing = n > 1 ? (len - 2 * inset) / (n - 1) : len;
  const maxShift = Math.min(0.9, Math.max(0.3, spacing * 0.45));
  const out = [];
  const taken = (u) => out.some((c) => Math.abs(c.u - u) < 0.42);
  for (let k = 0; k < n; k++) {
    const ud = n > 1 ? bal.u0 + inset + spacing * k : (bal.u0 + bal.u1) / 2;
    const id = Math.round((Math.min(hi, Math.max(lo, ud)) - lo) / step);
    let best = -1;
    for (let d = 0; d * step <= maxShift && best < 0; d++) {
      for (const i of d ? [id - d, id + d] : [id]) {
        if (i < 0 || i >= N || top[i] >= clear || taken(lo + i * step)) continue;
        best = i; break;
      }
    }
    if (best >= 0) { out.push({ u: lo + best * step, h: Hc }); continue; }
    // no clear pier nearby: the tallest console that still stops above the head
    let bi = -1;
    for (let d = 0; d * step <= 0.45; d++) {
      for (const i of [id - d, id + d]) {
        if (i < 0 || i >= N || taken(lo + i * step)) continue;
        if (bi < 0 || top[i] < top[bi]) bi = i;
      }
    }
    if (bi < 0) continue;
    const h = soffit - top[bi] - 0.075;
    if (h >= 0.2) out.push({ u: lo + bi * step, h: Math.min(Hc, h) });
  }
  return out;
}

/** Bracket position for a facade flag: the pier nearest the planned spot that is clear
 *  of the windows on that floor (null if none). */
function flagPier(plan, f) {
  const fl = plan.floors.find((x) => f.y >= x.y && f.y < x.y + x.h) || plan.floors[plan.floors.length - 1];
  const cands = [plan.pierL * 0.5, ...plan.bays.slice(1).map((b) => b.u0), plan.width - plan.pierR * 0.5];
  const ops = plan.openings.filter((o) => o.floor === fl.index);
  let best = null;
  for (const u of cands) {
    if (ops.some((o) => Math.abs(u - o.uc) < o.w / 2 + 0.42)) continue;
    if (best === null || Math.abs(u - f.u) < Math.abs(best - f.u)) best = u;
  }
  return best;
}

const ironwork = {
  name: 'ironwork',

  async init(app) {
    this.atlas = buildAtlas();
    this.mats = makeMaterials(app, this.atlas);
    this.stoneMat = makeStoneMaterial(app);
    this.geo = {
      bay: DESIGNS.map((d) => [0, 1, 2].map((lod) => bayGeometry(d, lod))),
      post: [postGeometry(0), postGeometry(1)],
      corbel: [[corbelGeometry(0, 0), corbelGeometry(0, 1)], [corbelGeometry(1, 0), corbelGeometry(1, 1)]],
      corbelFar: [corbelTemplate(0), corbelTemplate(1)],
      baluster: [balusterGeometry(0), balusterGeometry(1)],
      shadow: shadowTemplates(),
    };
    this.att = buildAttachAssets();
    this.amats = makeAttachMaterials(app);
    this.app = app;
    this.live = new Set();     // marker groups handed to the streamer
    this.pending = new Set();  // ... whose chunk is not shown yet
    this.jobs = new Map();     // chunk index * 2 + lod -> build job (see prefetch)
    this.spare = [];           // spare writer sets
    this.uniforms = { uIronPx, uIronA2C, uIronCardK, uIronGeoK, uIwWiden }; // for inspection / debugging
    this.lastPx = 0;
    this.census = null;        // set to a Map to record what full-detail builds plant (debugging)

    // street-wide meshes: merged strips per material, instance pools per family, flags
    this.root = new THREE.Group();
    this.root.name = 'ironwork';
    app.scene.add(this.root);
    // Near (lod 0) and far (lod 1) chunks fill separate strips: each ring then holds its
    // chunks in route order, so the blocks a pass sees form a tight index span.
    const strip = (mat, streams, name, opts) => {
      const s = new Strip(mat, streams, { scene: app.scene, name: `ironwork:${name}`, ...opts });
      this.root.add(s.mesh);
      return s;
    };
    // (capacities: about twice the most a dense stretch uses, so the rings rarely grow)
    const K = 1024, set = (tag, cap) => ({
      stone: strip(this.stoneMat, ['normal', 'uv', 'color', 'aGk'], `stone${tag}`, { instanceColor: true, vCap: cap.stone[0] * K, iCap: cap.stone[1] * K }),
      cards: strip(this.mats.card, ['normal', 'uv', 'color'], `cards${tag}`, { castShadow: true, thin: true, vCap: 32 * K, iCap: 48 * K }),
      parts: strip(this.amats.parts, ['normal', 'uv', 'color'], `parts${tag}`, { instanceColor: true, vCap: cap.parts[0] * K, iCap: cap.parts[1] * K }),
      // shadow casters only (the stone program, never drawn in the view)
      shadow: strip(this.stoneMat, [], `shadow${tag}`, { shadowOnly: true, instanceColor: true, vCap: cap.shadow[0] * K, iCap: cap.shadow[1] * K }),
    });
    this.strips = {
      near: set('', { stone: [128, 256], parts: [64, 96], shadow: [128, 512] }),
      far: set('Far', { stone: [192, 448], parts: [16, 32], shadow: [64, 256] }),
    };
    Object.assign(this.strips.near, {
      stains: strip(this.amats.stain, ['normal', 'uv'], 'stains', { vCap: K, iCap: 2 * K }),
      thin: strip(this.stoneMat, [], 'thinShadow', { shadowOnly: true, thin: true, instanceColor: true, vCap: 112 * K, iCap: 512 * K }),
    });
    // instance pools of every family and the flags: created now (empty), so the start-up
    // compile covers their programs instead of the first frame
    this.pools = new Map();
    for (const f of this.families()) this.poolOf(f);
    this.flagPool = new FlagPool(this.att.flag, this.att.flagShadow, this.amats.flag, this.amats.flagDepth, this.root, app.scene);
    await this.warmStart(app);
  },

  /** Prepares the chunks the streamer asks for first (around the start position and the
   *  inspection view) while the loading screen is up, so the start-up builds and the
   *  first frames' far chunks hand over finished groups. */
  async warmStart(app) {
    const n = app.layout.nChunks, around = [app.startS];
    if (app.params.view) around.push(app.params.view[0]);
    let yielded = performance.now();
    for (const s of around) {
      for (let i = Math.floor((s - VIEW_BEHIND) / CHUNK_LEN); i <= Math.floor((s + VIEW_AHEAD) / CHUNK_LEN); i++) {
        const idx = ((i % n) + n) % n;
        const dist = Math.max(0, Math.abs(i * CHUNK_LEN + CHUNK_LEN / 2 - s) - CHUNK_LEN / 2);
        const lod = dist < LOD0_DIST ? 0 : 1, key = idx * 2 + lod;
        if (this.jobs.has(key)) continue;
        const j = this.job(idx, lod);
        this.runJob(j, Infinity);
        this.jobs.set(key, j);
        // let the loading screen breathe now and then
        if (performance.now() - yielded > 40) { await new Promise((r) => setTimeout(r, 0)); yielded = performance.now(); }
      }
    }
  },

  /** Every instance family the builds add to: {key, levels, material, opts}. */
  families() {
    const G = this.geo, M = this.mats, A = this.att, out = [];
    DESIGNS.forEach((_, i) => out.push(
      { key: `bay${i}`, levels: G.bay[i], material: M.iron, opts: BAY_OPTS },
      { key: `bay${i}p`, levels: G.bay[i], material: M.paint, opts: BAY_OPTS }));
    out.push({ key: 'post', levels: G.post, material: M.ironPost, opts: POST_OPTS });
    out.push({ key: 'postp', levels: G.post, material: M.paintPost, opts: POST_OPTS });
    CORBEL_KEYS.forEach((key, v) => out.push({ key, levels: G.corbel[v], material: this.stoneMat, opts: CORBEL_OPTS }));
    out.push({ key: 'baluster', levels: G.baluster, material: this.stoneMat, opts: BALUSTER_OPTS });
    PLANT_KEYS.forEach((key, k) => out.push({ key, levels: A.plants.levels[k], material: this.amats.plant, opts: PLANT_OPTS }));
    for (const p of A.pooled.values()) out.push({ key: p.key, levels: p.levels, material: this.amats.parts, opts: p });
    return out;
  },

  // ---------------------------------------------------------------- chunk jobs
  // A chunk is built in small steps (one balcony, or one facade's attachments) into a
  // job. update() advances the jobs of the chunks the streamer is about to ask for (the
  // next detail upgrades and the far horizon) within a time slice per frame, so build()
  // mostly hands over a finished group; a chunk nobody prepared is built in full on the
  // spot. The content is identical either way (everything is seeded per lot).

  /** New build job for chunk `index` at detail `lod`. */
  job(index, lod) {
    const L = this.app.layout;
    let lots = [...L.inChunk('lots', index), ...L.inChunk('sideLots', index)];
    // side-street facades are seen down the side street: left out of far chunks beyond
    // the corner lots
    if (lod) lots = lots.filter((l) => !(l.sideStreet && l.x0 > 24));
    if (!lots.length) return { index, lod, steps: null, ctx: null, group: null };
    const ctx = {
      lod,                // detail level of the lot being built (may drop below the chunk's)
      chunkLod: lod,
      clutter: true,
      inst: new InstanceCollector(),
      w: this.writers(),
      flags: [],
      bounds: [],         // facade centres (x, y, z, r): culling sphere of the chunk's blocks
    };
    Object.assign(ctx, ctx.w); // ctx.stone, ctx.cards, ctx.parts, ctx.stains, ctx.shadow, ctx.thin
    return { index, lod, steps: this.steps(ctx, lots), ctx, group: undefined };
  },

  /** Writers of a chunk's merged geometry (one per strip). Their contents are copied into
   *  the strips when the chunk is finished, so a few sets, grown to chunk size, are reused. */
  writers() {
    return this.spare.pop() || {
      stone: new GeoWriter(16384, { kind: true }), cards: new GeoWriter(4096), parts: new GeoWriter(32768),
      stains: new GeoWriter(256), shadow: new PosWriter(16384), thin: new PosWriter(2048),
    };
  },

  recycle(w) {
    if (w && this.spare.length < 4) { for (const k in w) w[k].reset(); this.spare.push(w); }
  },

  /** The build steps of a chunk: one per balcony, one per facade's attachments. */
  * steps(ctx, lots) {
    for (const lot of lots) {
      // deep side-street lots get far-range detail; beyond the corner lots (35 m and
      // more from any camera on the main street, at grazing angles) the floor clutter
      // behind the railings is left out: it is hidden by the bars and the slab
      ctx.lod = ctx.chunkLod || (lot.sideStreet && lot.x0 > 60) ? 1 : 0;
      ctx.clutter = !lot.sideStreet || lot.x0 <= 24;
      const plan = facadePlan(lot);
      const st = lotStyle(lot, plan);
      _p.set(lot.frame.width / 2, plan.totalHeight / 2, 0).applyMatrix4(lot.frame.matrix);
      ctx.bounds.push(_p.x, _p.y, _p.z, Math.max(lot.frame.width, plan.totalHeight) / 2);
      for (let i = 0; i < plan.balconies.length; i++) {
        this.balcony(ctx, lot, plan, st, plan.balconies[i], i);
        yield;
      }
      this.facadeAttachments(ctx, lot, plan, st);
      yield;
      // corner returns and chamfered corner faces: window AC units and flower boxes
      for (const r of plan.returns || []) {
        _p.set(r.width / 2, plan.totalHeight / 2, 0).applyMatrix4(r.frame.matrix);
        ctx.bounds.push(_p.x, _p.y, _p.z, Math.max(r.width, plan.totalHeight) / 2);
        this.facadeAttachments(ctx, r, r, st);
      }
    }
  },

  /** Advances a job until `deadline` (performance.now() ms); true once its group is made. */
  runJob(j, deadline) {
    if (j.group !== undefined) return true;
    if (j.steps) {
      for (;;) {
        if (performance.now() > deadline) return false;
        if (j.steps.next().done) break;
      }
      j.steps = null;
    }
    // making the meshes is one step of up to ~0.5 ms: it waits for a fresh slice
    if (performance.now() > deadline - PREFETCH_MS * 0.7) return false;
    j.group = this.finish(j.ctx);
    if (j.group) Object.assign(j.group.userData, { index: j.index, lod: j.lod });
    j.ctx = null;
    return true;
  },

  /** Drops a job that will not be asked for. */
  dropJob(j) {
    if (j.group) this.dispose(j.group);
    else if (j.ctx) this.recycle(j.ctx.w);
  },

  build(chunk) {
    const key = chunk.index * 2 + (chunk.lod ? 1 : 0);
    let j = this.jobs.get(key);
    if (j) this.jobs.delete(key);
    else j = this.job(chunk.index, chunk.lod);
    this.runJob(j, Infinity);
    const g = j.group;
    if (!g) return null;
    // drawn from the moment the streamer shows the chunk (see update / dispose)
    this.live.add(g);
    this.pending.add(g);
    return g;
  },

  /** True once the streamer shows the chunk group a marker belongs to. */
  shown(g) {
    const c = g.parent;
    return !!(c && c.visible && c.parent);
  },

  /** Starts drawing a chunk's blocks, instances and flags. */
  activate(g) {
    this.pending.delete(g);
    const u = g.userData;
    u.active = true;
    for (const [strip, b] of u.blocks) strip.activate(b);
    for (const [pool, e] of u.entries) pool.attach(e);
    if (u.flags) this.flagPool.attach(u.flags);
  },

  /** Brings the instance pools and flags up to date (view culling per chunk, levels,
   *  packing) for this frame's camera (final once cameraRig has run). */
  refresh(force = false) {
    const camera = this.app.camera;
    camera.updateMatrixWorld();
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pm, camera.coordinateSystem, camera.reversedDepth);
    const L = this.limits(this.lastPx || uIronPx.value), cam = camera.position;
    for (const p of this.pools.values()) p.update(cam, p.cls ? L[p.cls] : null, force, _fr);
    this.flagPool.flush();
  },

  /** The pool of an instance family (created with its first entry). */
  poolOf(e) {
    let p = this.pools.get(e.key);
    if (!p) this.pools.set(e.key, (p = new InstancePool(e.key, e.levels, e.material, e.opts, this.root)));
    return p;
  },

  /** Prepares the chunks the streamer will ask for next, within a per-frame time slice,
   *  nearest first: a chunk not built yet at the detail the streamer builds it at (full
   *  inside LOD0_DIST), the full-detail upgrade inside LOD0_DIST + 80 m, the next two
   *  chunks beyond the far horizon. Jobs no longer wanted are dropped. */
  prefetch(app) {
    const s = app.cameraS;
    if (s == null) return;
    const n = app.layout.nChunks;
    const have = new Map(); // chunk index -> finest detail level built
    for (const g of this.live) {
      const { index, lod } = g.userData;
      if (!(have.get(index) <= lod)) have.set(index, lod);
    }
    const want = [];
    const i0 = Math.floor((s - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((s + VIEW_AHEAD) / CHUNK_LEN);
    for (let i = i0; i <= i1 + 2; i++) {
      const idx = ((i % n) + n) % n;
      const dist = Math.max(0, Math.abs(i * CHUNK_LEN + CHUNK_LEN / 2 - s) - CHUNK_LEN / 2);
      const h = have.get(idx), first = dist < LOD0_DIST ? 0 : 1;
      if (h === undefined) want.push({ key: idx * 2 + first, idx, lod: first, dist });
      if (dist < LOD0_DIST + 80 && (h ?? first) > 0) want.push({ key: idx * 2, idx, lod: 0, dist });
    }
    const keep = new Set(want.map((w) => w.key));
    for (const [k, j] of this.jobs) if (!keep.has(k)) { this.dropJob(j); this.jobs.delete(k); }
    want.sort((a, b) => a.dist - b.dist); // (stable: a chunk's first build before its upgrade)
    const deadline = performance.now() + PREFETCH_MS;
    for (const w of want) {
      let j = this.jobs.get(w.key);
      if (!j) { j = this.job(w.idx, w.lod); this.jobs.set(w.key, j); }
      if (!this.runJob(j, deadline)) break;
    }
  },

  /** One balcony: slab, consoles, railing, then what the residents put on it. */
  balcony(ctx, lot, plan, st, bal, index) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix;
    inst.cluster(); // the balcony's instances are culled together
    const r = new RNG(hash2(lot.seed, 977 + index));
    const { y, slabT: T, depth: D, u0, u1 } = bal;
    const isStone = bal.railing === 'stone';
    const tint = st.tint;
    const dirt = r.range(0.88, 1.0);

    // ---- slab (and its shadow caster)
    const rc = isStone && st.roundStone ? Math.min(0.3, D * 0.35) : 0;
    ctx.stone.setMatrix(F).color(tint[0], tint[1], tint[2]);
    writeSlab(ctx.stone, slabPath(u0, u1, D, rc), y, T, st.slabVariant, lod, dirt, D);
    // (rounded corners of two chords: inside the convex corner)
    writeSlabShadow(ctx.shadow.setMatrix(F), slabPath(u0, u1, D, rc, 0.25, 2), y, T, st.slabVariant, lod);

    // ---- consoles, on the piers between the openings below
    if (st.corbel >= 0) {
      const Hc = THREE.MathUtils.clamp(0.36 + 0.32 * D, 0.5, 0.74);
      const sz = (D - 0.07) / CORBEL.D;
      const c = [tint[0] * dirt, tint[1] * dirt, tint[2] * dirt];
      for (const { u, h } of placeConsoles(plan, bal, Math.max(2, bal.corbels | 0), Hc)) {
        // shortened consoles over a high head become the stepped (tiered) kind
        const variant = h < Hc * 0.8 ? 1 : st.corbel;
        _l.makeScale(1, h / CORBEL.H, sz).setPosition(u, y - T, 0);
        _m.multiplyMatrices(F, _l);
        // far chunks: merged into the stone mesh; near: instanced, carved or light per
        // instance. The light console casts the shadow either way.
        if (lod) writeTemplate(ctx.stone.kind(GRIME.NONE), this.geo.corbelFar[variant], _m, c);
        else inst.add(CORBEL_KEYS[variant], this.geo.corbel[variant], this.stoneMat, _m, c, CORBEL_OPTS);
        writePos(ctx.shadow, this.geo.shadow.corbel[variant], _m);
      }
    }

    // ---- railing
    // (the balustrade draws from its own stream so far/near builds place contents alike)
    if (isStone) this.balustrade(ctx, F, bal, rc, tint, new RNG(hash2(lot.seed, 4111 + index)));
    else this.ironRailing(ctx, lot, bal, st);

    this.balconyContents(ctx, lot, plan, st, bal, index, r);
  },

  /** What the residents keep on a balcony: planter boxes on the rail (or the coping, or
   *  a trough on the floor), pots, a chair, an AC unit, now and then a towel or a flag. */
  balconyContents(ctx, lot, plan, st, bal, index, r) {
    const { lod } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const { y, depth: D, u0, u1 } = bal;
    const len = u1 - u0, hs = st.railH;
    const iron = bal.railing !== 'stone';
    const top = y + (iron ? RAIL_H * hs : BALUSTRADE.H);
    // does this household plant at all? (decided alike in near and far builds)
    const planted = r.chance(st.greenery);
    let boxes = 0, grow = -1, where = null;
    if (planted && r.chance(0.8)) {
      const n = len > 3.2 ? r.int(1, 3) : len > 2 ? r.int(1, 2) : 1;
      const col = r.chance(0.6) ? BOXES[st.box] : BOXES[weighted(r, BOX_W)];
      const bl = r.range(0.6, 1.0);
      grow = this.growOf(st, r);
      // hung on the handrail (mostly outside), standing on a balustrade's coping clear of
      // its rounded corners, or (plantings that do not hang) a trough on the floor
      const low = grow === GROW.HERBS || grow === GROW.DRY || grow === GROW.EMPTY;
      where = !iron ? 'coping' : r.weighted([['out', 0.65], ['in', 0.2], ['floor', low ? 0.35 : 0]]);
      let lo = u0 + 0.45, hi = u1 - 0.45, w, yb;
      if (where === 'coping') {
        const rc = st.roundStone ? Math.min(0.3, D * 0.35) : 0, i = 0.13;
        const e = i + Math.max(0, rc - i * 0.5) + bl / 2 + 0.02;
        lo = u0 + e; hi = u1 - e;
        w = D - i; yb = top;
      } else if (where === 'floor') {
        w = D - 0.2; yb = y;
      } else {
        w = D - 0.05 + (where === 'out' ? 0.13 : -0.13); yb = top - 0.19;
      }
      const trough = where === 'coping' || where === 'floor' ? r.chance(0.6) : false;
      for (let k = 0; k < n; k++) {
        const u = u0 + len * ((k + 0.5) / n) + r.range(-0.12, 0.12) * len / n;
        _pb.multiplyMatrices(F, _l.makeTranslation(lo < hi ? THREE.MathUtils.clamp(u, lo, hi) : (u0 + u1) / 2, yb, w));
        // most households fill their boxes alike
        if (k && r.chance(0.35)) {
          const g = this.growOf(st, r);
          if (where !== 'floor' || g === GROW.HERBS || g === GROW.DRY || g === GROW.EMPTY) grow = g;
        }
        this.planter(ctx, _pb, bl, col, grow, this.tintOf(st, grow, r), trough, r);
        if (!lod && (where === 'out' || where === 'in')) this.part(ctx, A.hooks[where === 'out' ? 0 : 1], _m.multiplyMatrices(_pb, _l.makeScale(bl, 1, 1)));
        boxes++;
      }
    }
    if (this.census && !ctx.chunkLod) {
      this.census.set(`${lot.seed}:${index}`, { planted, boxes, grow, where, s: lot.s0, side: lot.side, y, at: _q.set((u0 + u1) / 2, y, D).applyMatrix4(F).toArray() });
    }
    if (lod || !ctx.clutter) return;
    // pots on the floor along the front, inside the railing: in many planted households,
    // and now and then a forgotten one on a bare balcony
    if (planted ? r.chance(0.5) : r.chance(0.06)) {
      const n = planted ? r.int(1, Math.max(1, Math.min(4, Math.floor(len / 0.45)))) : 1;
      const potCol = POTS[(st.pots + (r.chance(0.2) ? 1 : 0)) % POTS.length];
      for (let k = 0; k < n; k++) {
        const u = u0 + 0.3 + (len - 0.6) * ((k + r.range(0.3, 0.7)) / n);
        const w = D - r.range(0.25, 0.32);
        const s = r.range(0.8, 1.2);
        _l.makeRotationY(r.range(0, 6.28)).scale(_a.set(s, s, s)).setPosition(u, y, w);
        this.part(ctx, A.pot, _m.multiplyMatrices(F, _l), r.chance(0.7) ? potCol : POTS[r.int(0, POTS.length - 1)]);
        // a geranium (not every one in bloom), a herb, a dried-out one or bare soil
        const what = planted ? r.weighted([[PLANT.POT, 0.5], [PLANT.HERB, 0.28], [PLANT.DRY, 0.12], [-1, 0.1]])
          : r.weighted([[PLANT.DRY, 0.5], [-1, 0.3], [PLANT.HERB, 0.2]]);
        if (what < 0) continue;
        _l.makeRotationY(r.range(0, 6.28)).scale(_a.set(s, s, s)).setPosition(u, y + 0.2 * s, w);
        const tint = what === PLANT.POT ? (r.chance(0.7) ? this.flower(st, r) : LEAFY)
          : what === PLANT.HERB ? HERBS[weighted(r, HERB_W)] : WITHERED[r.int(0, WITHERED.length - 1)];
        this.plant(ctx, what, _m.multiplyMatrices(F, _l), tint);
      }
    }
    // a plastic chair
    if (r.chance(0.1) && D > 0.75) {
      _l.makeRotationY(r.range(-0.6, 0.6) + (r.chance(0.5) ? 0 : Math.PI)).setPosition(u0 + len * r.range(0.2, 0.8), y, D * 0.5);
      this.part(ctx, A.chair, _m.multiplyMatrices(F, _l), CHAIRS[r.int(0, CHAIRS.length - 1)]);
    }
    // an AC unit standing on the balcony floor beside the door
    const door = plan.openings.find((o) => o.balcony === index);
    if (door && (door.ac || r.chance(0.08)) && len > 1.6) {
      const side = r.chance(0.5) ? -1 : 1;
      const u = THREE.MathUtils.clamp(door.uc + side * (door.w / 2 + 0.5), u0 + 0.5, u1 - 0.5);
      _l.makeTranslation(u, y + 0.06, -0.06);
      this.acUnit(ctx, _m.multiplyMatrices(F, _l), false);
    }
    // a towel or rug airing over the front rail
    if (iron && r.chance(0.04)) {
      _l.makeScale(r.range(0.5, 0.9), 1, 1).setPosition(u0 + len * r.range(0.25, 0.75), top, D - 0.05);
      this.part(ctx, A.towel, _m.multiplyMatrices(F, _l), TOWELS[r.int(0, TOWELS.length - 1)]);
    }
    // a flag on the front corner post
    if (iron && r.chance(0.012)) this.flag(ctx, F, r.chance(0.5) ? u0 + 0.05 : u1 - 0.05, y + 0.85, D - 0.05, st, r, 0.6);
  },

  /** Window AC units, window flower boxes, flags and satellite dishes of one facade
   *  (`lot` needs only {seed, frame}: a corner return passes itself as both). */
  facadeAttachments(ctx, lot, plan, st) {
    const { lod } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const r = new RNG(hash2(lot.seed, 0x5eed));
    for (const o of plan.openings) {
      if (o.kind !== 'window') continue;
      ctx.inst.cluster(); // each window's attachments are culled together
      if (o.ac) {
        // under one side of the window, clear of the sill and its corbels; where the unit
        // or its brackets reach a string course it stands off the wall in front of it
        const u = o.uc + (r.chance(0.5) ? -1 : 1) * (o.w / 2 + 0.05) * r.range(0.45, 0.9);
        const top = o.y - 0.37, bot = top - 0.55 - 0.22;
        let w = -0.02;
        for (const c of plan.courses) if (c.y < top && c.y + c.h > bot) w = Math.max(w, c.proj - 0.07);
        _l.makeTranslation(u, top - 0.55, w);
        this.acUnit(ctx, _m.multiplyMatrices(F, _l), true);
      }
      if (o.flowerBox) this.sillBox(ctx, lot, st, o, F);
    }
    for (const f of plan.flags) {
      const u = flagPier(plan, f);
      if (u !== null) this.flag(ctx, F, u, f.y, 0, st, r, 1);
    }
    // satellite dish on the top floor, only where the facade can see the satellite
    if (!lod && r.chance(0.14) && plan.bays.length > 1) {
      _a.copy(lot.frame.nDir);
      if (_a.dot(_b.set(DISH_DIR.x, 0, DISH_DIR.z).normalize()) > 0.25) {
        const fl = plan.floors[plan.floors.length - 1];
        const k = r.int(1, plan.bays.length - 1);
        _p.set(plan.bays[k].u0, fl.y + r.range(1.1, 1.8), 0.42).applyMatrix4(F);
        _l.lookAt(_c.set(0, 0, 0), _q.copy(DISH_DIR).negate(), _b.set(0, 1, 0)).setPosition(_p);
        this.part(ctx, A.dish, _l);
      }
    }
  },

  /** A planter standing on a window sill, half inside the reveal, where the plan has one
   *  and the household plants (the building's greenery decides, as on its balconies). */
  sillBox(ctx, lot, st, o, F) {
    const r = new RNG(hash2(lot.seed, hash2(Math.round(o.uc * 100), Math.round(o.y * 100))));
    const planted = r.chance(Math.min(1, st.greenery * 2.2));
    if (this.census && !ctx.chunkLod) this.census.set(`${lot.seed}:w${o.uc.toFixed(2)}:${o.y.toFixed(2)}`, { sill: true, planted });
    if (!planted) return;
    let grow = this.growOf(st, r);
    if (grow === GROW.BOUG) grow = GROW.GREEN;
    const col = r.chance(0.6) ? BOXES[st.box] : BOXES[weighted(r, BOX_W)];
    _pb.multiplyMatrices(F, _l.makeTranslation(o.uc, o.y + 0.012, 0.03));
    this.planter(ctx, _pb, o.w + 0.06, col, grow, this.tintOf(st, grow, r), r.chance(0.6), r);
  },

  /** What a household grows (GROW), after the building's leaning. */
  growOf(st, r) { return weighted(r, st.grow); },

  /** Geranium colour: the building's favourite, or any. */
  flower(st, r) { return FLOWERS[r.chance(0.7) ? st.flowers : weighted(r, FLOWER_W)]; },

  /** Tint of a planting's flowering parts. */
  tintOf(st, grow, r) {
    switch (grow) {
      case GROW.GERANIUM: return this.flower(st, r);
      case GROW.HERBS: return HERBS[weighted(r, HERB_W)];
      case GROW.GREEN: return TRAIL_GREEN;
      case GROW.SURFINIA: return SURFINIA[r.int(0, SURFINIA.length - 1)];
      case GROW.BOUG: return BOUG[weighted(r, BOUG_W)];
      default: return WITHERED[r.int(0, WITHERED.length - 1)];
    }
  },

  /** Planter box or trough (`base`: its foot, unscaled; `len` its length along x) and what
   *  grows in it (GROW, tint). Whole-box plantings (0.8 m long) are fitted to the length,
   *  mirrored at random; herbs and dried-out plants are pot-sized clumps along it, a gap
   *  here and there. The far chunks use the same instanced plants (their light levels)
   *  and the same draws, so nothing changes when a chunk is rebuilt at full detail. */
  planter(ctx, base, len, col, grow, tint, trough, r) {
    const A = this.att;
    this.part(ctx, trough ? A.trough : A.box, _pl.multiplyMatrices(base, _l.makeScale(len, 1, 1)), col);
    const soil = trough ? TROUGH_SOIL : BOX_SOIL;
    if (grow === GROW.EMPTY) return;
    if (grow === GROW.HERBS || grow === GROW.DRY) {
      const n = Math.max(1, Math.round(len / 0.27));
      for (let k = 0; k < n; k++) {
        if (n > 1 && r.chance(grow === GROW.DRY ? 0.3 : 0.12)) continue;
        const s = r.range(0.8, 1.05) * (trough ? 0.9 : 1);
        _l.makeRotationY(r.range(0, 6.28)).scale(_pv.set(s * 0.85, s, s * 0.85))
          .setPosition(len * ((k + 0.5) / n - 0.5) + r.range(-0.03, 0.03), soil, r.range(-0.015, 0.015));
        this.plant(ctx, grow === GROW.HERBS ? PLANT.HERB : PLANT.DRY, _pl.multiplyMatrices(base, _l), k && r.chance(0.3) ? this.tintOf(null, grow, r) : tint);
      }
      return;
    }
    const kind = grow === GROW.GERANIUM ? PLANT.BOX : grow === GROW.BOUG ? PLANT.BOUG : PLANT.TRAIL;
    const n = Math.max(1, Math.round(len / 0.85)), sx = len / (n * 0.8);
    for (let k = 0; k < n; k++) {
      _l.makeScale(r.chance(0.5) ? sx : -sx, 1, 1).setPosition(len * ((k + 0.5) / n - 0.5), soil, 0);
      this.plant(ctx, kind, _pl.multiplyMatrices(base, _l), tint);
    }
  },

  /** Instanced planting (PLANT family): full, light and far versions per instance. */
  plant(ctx, kind, m, tint) {
    const P = this.att.plants;
    ctx.inst.add(PLANT_KEYS[kind], P.levels[kind], this.amats.plant, m, tint, PLANT_OPTS);
  },

  /** A part into the merged parts mesh (or its instance pool), and its stand-in into the
   *  shadow caster it belongs to (solid, or small / thin for the fine cascades). Far
   *  chunks' parts cast no shadow (planters and AC bodies a few pixels tall). */
  part(ctx, t, m, tint = WHITE) {
    const A = this.att, pooled = A.pooled.get(t);
    if (pooled) ctx.inst.add(pooled.key, pooled.levels, this.amats.parts, m, tint, pooled);
    else writeTemplate(ctx.parts, t, m, tint);
    if (ctx.chunkLod) return;
    const c = A.cast.get(t);
    if (c) writePos(ctx.shadow, c, m);
    else { const th = A.thin.get(t); if (th) writePos(ctx.thin, th, m); }
  },

  /** Split AC unit (matrix: unit frame on the wall): textured body, pipes, brackets
   *  (instanced, see attach.js), their shadow stand-ins and the wall stain. */
  acUnit(ctx, m, wallMounted) {
    const A = this.att, P = A.pooled.get(wallMounted ? 'acWall' : 'acFloor');
    ctx.inst.add(P.key, P.levels, this.amats.parts, m, wallMounted ? WHITE : [0.92, 0.92, 0.92], P);
    if (ctx.chunkLod) return;
    writePos(ctx.shadow, A.cast.get(A.acBody), m);
    if (ctx.lod) return; // pipes and brackets are sub-pixel beyond 200 m
    writePos(ctx.thin, A.thin.get(A.acPipes), m);
    if (wallMounted) {
      writePos(ctx.thin, A.thin.get(A.acBrackets), m);
      writeTemplate(ctx.stains, A.acStain, m);
    }
  },

  /** Flag on an angled pole: bracket at facade (u, v, w), pole out of the wall and up. */
  flag(ctx, F, u, v, w, st, r, size) {
    const el = THREE.MathUtils.degToRad(r.range(30, 45));
    // pole direction p and fly direction q in facade space (u, v, w), then to world
    const p = _a.set(0, Math.sin(el), Math.cos(el)).transformDirection(F);
    const q = _b.set(0, -Math.cos(el), Math.sin(el)).transformDirection(F);
    const base = _p.set(u, v, w).applyMatrix4(F);
    // pole (template is along +y); a 3 cm pole is sub-pixel in far chunks
    _c.crossVectors(p, q);
    _l.makeBasis(q, p, _c).setPosition(base);
    if (!ctx.lod) this.part(ctx, this.att.pole, _l);
    // cloth: local x = fly (q), y = along the pole (p), hoist top at 1.85 m up the pole
    const s = size;
    _m.makeBasis(_q.copy(q).multiplyScalar(s), _a.copy(p).multiplyScalar(s), _c.clone().multiplyScalar(s)).setPosition(base.clone().addScaledVector(p, 1.85));
    const d = r.chance(0.45) ? 0 : (st.flag + (r.chance(0.15) ? 1 : 0)) % 4;
    ctx.flags.push({ m: _m.clone(), uv: [(d % 2) * 0.5, (1 - Math.floor(d / 2)) * 0.5], phase: r.range(0, 30) });
  },

  ironRailing(ctx, lot, bal, st) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix;
    const { y, depth: D, u0, u1 } = bal;
    const design = DESIGNS[st.design];
    const painted = st.paint >= 0;
    const mat = painted ? this.mats.paint : this.mats.iron;
    const postMat = painted ? this.mats.paintPost : this.mats.ironPost;
    // (black iron instances are white: every railing pool has instance colours)
    const color = painted ? PAINTS[st.paint] : WHITE;
    const hs = st.railH;
    const i = 0.05; // railing centre line inset from the slab edge
    const rp = [[u0 + i, 0], [u0 + i, D - i], [u1 - i, D - i], [u1 - i, 0]];
    const cw = ctx.cards.setMatrix(F);
    const cc = painted ? color : this.mats.ironColor();
    cw.color(cc[0], cc[1], cc[2]);
    const vb = atlasV(st.design, 0), vt = atlasV(st.design, RAIL_H);
    const bayKey = `bay${st.design}${painted ? 'p' : ''}`, postKey = painted ? 'postp' : 'post';
    for (let k = 0; k < rp.length - 1; k++) {
      const A = rp[k], B = rp[k + 1];
      const du = B[0] - A[0], dw = B[1] - A[1], len = Math.sqrt(du * du + dw * dw);
      if (len < 0.08) continue;
      const tu = du / len, tw = dw / len;
      const nb = Math.max(1, Math.round(len / design.W)), sx = len / (nb * design.W);
      if (!lod) {
        for (let b = 0; b < nb; b++) {
          const o = b * design.W * sx;
          _l.set(tu * sx, 0, -tw, A[0] + tu * o, 0, hs, 0, y, tw * sx, 0, tu, A[1] + tw * o, 0, 0, 0, 1);
          inst.add(bayKey, this.geo.bay[st.design], mat, _m.multiplyMatrices(F, _l), color, BAY_OPTS);
        }
      }
      // card for this run (also casts the railing shadow at every distance)
      const nx = -tw, nz = tu, yt = y + RAIL_H * hs;
      const a = cw.v(A[0], y, A[1], nx, 0, nz, 0, vb), b = cw.v(B[0], y, B[1], nx, 0, nz, nb, vb);
      const c = cw.v(B[0], yt, B[1], nx, 0, nz, nb, vt), d = cw.v(A[0], yt, A[1], nx, 0, nz, 0, vt);
      cw.quad(a, b, c, d);
    }
    // corner and wall-end posts: two crossed sprite quads each on the cards, geometry near
    const pv0 = atlasV(ATLAS.POST_ROW, 0), pv1 = atlasV(ATLAS.POST_ROW, RAIL_H + 0.1), ph = ATLAS.POST_W / 2;
    for (const P of rp) {
      for (const [eu, ew] of [[1, 0], [0, 1]]) {
        const yt = y + (RAIL_H + 0.1) * hs;
        const a = cw.v(P[0] - eu * ph, y, P[1] - ew * ph, -ew, 0, eu, 0, pv0), b = cw.v(P[0] + eu * ph, y, P[1] + ew * ph, -ew, 0, eu, 1, pv0);
        const c = cw.v(P[0] + eu * ph, yt, P[1] + ew * ph, -ew, 0, eu, 1, pv1), d = cw.v(P[0] - eu * ph, yt, P[1] - ew * ph, -ew, 0, eu, 0, pv1);
        cw.quad(a, b, c, d);
      }
      if (!lod) {
        _l.makeScale(1, hs, 1).setPosition(P[0], y, P[1]);
        inst.add(postKey, this.geo.post, postMat, _m.multiplyMatrices(F, _l), color, POST_OPTS);
      }
    }
  },

  balustrade(ctx, F, bal, rc, tint, r) {
    const { lod, inst } = ctx;
    const { y, depth: D, u0, u1 } = bal;
    const i = 0.13;
    const path = slabPath(u0 + i, u1 - i, D - i, Math.max(0, rc - i * 0.5), 0.04);
    const S = ctx.stone, SW = ctx.shadow;
    S.setMatrix(_m.multiplyMatrices(F, _l.makeTranslation(0, y, 0)));
    SW.setMatrix(_m);
    S.color(tint[0], tint[1], tint[2]);
    sweepPath(S, path, plinthProfile(), { shadeFn: (o, v) => (v < 0.02 ? 0.8 : 0.95) });
    sweepPath(S, path, copingProfile(lod), { shadeFn: (o, v) => (v < BALUSTRADE.H - BALUSTRADE.COPING + 0.01 ? 0.75 : 1) });
    // pedestals at the wall ends and the front corners
    const hP = BALUSTRADE.H - BALUSTRADE.PLINTH - BALUSTRADE.COPING;
    const ped = [path[0], path[path.length - 1]];
    if (rc <= 0.01) ped.push(path[1], path[2]);
    for (const P of ped) box(S, P[0], BALUSTRADE.PLINTH + hP / 2, P[1], 0.2, hP, 0.2, 0.85, 'ud');
    writeBalustradeShadow(SW, rc > 0.01 ? slabPath(u0 + i, u1 - i, D - i, Math.max(0, rc - i * 0.5), 0.04, 2) : path, ped);
    // far: one darkened panel per run stands in for the row of balusters (at 200 m and
    // beyond they read as a mid-tone band anyway)
    if (lod) {
      S.color(tint[0] * 0.72, tint[1] * 0.72, tint[2] * 0.72);
      const y0 = BALUSTRADE.PLINTH, y1 = BALUSTRADE.H - BALUSTRADE.COPING;
      for (let k = 0; k < path.length - 1; k++) {
        const A = path[k], B = path[k + 1];
        const du = B[0] - A[0], dw = B[1] - A[1], l = Math.sqrt(du * du + dw * dw) || 1;
        const nx = -dw / l, nz = du / l;
        for (const sg of [1, -1]) {
          const a = S.v(A[0], y0, A[1], nx * sg, 0, nz * sg, 0, y0), b = S.v(B[0], y0, B[1], nx * sg, 0, nz * sg, l, y0);
          const c = S.v(B[0], y1, B[1], nx * sg, 0, nz * sg, l, y1), d = S.v(A[0], y1, A[1], nx * sg, 0, nz * sg, 0, y1);
          if (sg > 0) S.quad(a, b, c, d); else S.quad(b, a, d, c);
        }
      }
      // (no shadow for the panel: balusters are thin casters, and what it would shade
      // lies behind it)
      return;
    }
    // balusters along the path, kept clear of the pedestals
    const col = [tint[0], tint[1], tint[2]];
    for (let k = 0; k < path.length - 1; k++) {
      const A = path[k], B = path[k + 1];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const n = Math.floor(len / BALUSTRADE.SPACING);
      if (n < 1) continue;
      const step = len / n;
      for (let j = 0; j <= n; j++) {
        const t = (j * step) / len;
        const u = A[0] + (B[0] - A[0]) * t, w = A[1] + (B[1] - A[1]) * t;
        if (ped.some((P) => Math.hypot(P[0] - u, P[1] - w) < 0.17)) continue;
        if (j === n && k < path.length - 2) continue; // shared with the next segment
        _l.makeRotationY(r.range(0, Math.PI)).setPosition(u, y + BALUSTRADE.PLINTH, w);
        inst.add('baluster', this.geo.baluster, this.stoneMat, _m.multiplyMatrices(F, _l), col, BALUSTER_OPTS);
        writePos(ctx.thin, this.geo.shadow.baluster, _m);
      }
    }
  },

  /** Hands a finished chunk's geometry to the strips (inactive blocks: vertex data is
   *  uploaded now, drawing starts on activate) and returns its marker group, or null. */
  finish(ctx) {
    // one conservative sphere for all of the chunk's blocks (cheaper than scanning vertices)
    const sphere = boundsOf(ctx.bounds);
    const blocks = [], S = ctx.chunkLod ? this.strips.far : this.strips.near;
    for (const k in S) {
      const b = S[k].alloc(ctx.w[k], sphere);
      if (b) blocks.push([S[k], b]);
    }
    const entries = ctx.inst.entries().map((e) => [this.poolOf(e), e]);
    let flags = null;
    if (ctx.flags.length) {
      // matrices plus the per-flag design offset and wave phase
      const n = ctx.flags.length;
      flags = { n, m: new Float32Array(n * 16), a: new Float32Array(n * 3), box: new THREE.Box3() };
      ctx.flags.forEach((f, i) => {
        f.m.toArray(flags.m, i * 16);
        flags.a[i * 3] = f.uv[0]; flags.a[i * 3 + 1] = f.uv[1]; flags.a[i * 3 + 2] = f.phase;
        flags.box.expandByPoint(_p.setFromMatrixPosition(f.m));
      });
    }
    this.recycle(ctx.w);
    if (!blocks.length && !entries.length && !flags) return null;
    const g = new THREE.Group();
    g.name = 'ironwork';
    Object.assign(g.userData, { blocks, entries, flags, active: false, lod: ctx.chunkLod });
    return g;
  },

  /** Releases a chunk's blocks, instances and flags. When an upgraded chunk replaces this
   *  one, the streamer has just shown it: it starts drawing in the same frame. */
  dispose(g) {
    this.live.delete(g);
    this.pending.delete(g);
    const u = g.userData;
    for (const [strip, b] of u.blocks || []) strip.free(b);
    for (const [pool, e] of u.entries || []) pool.detach(e);
    if (u.flags) this.flagPool.detach(u.flags);
    u.blocks = u.entries = null; u.flags = null;
    for (const p of this.pending) if (p.userData.index === u.index && this.shown(p)) this.activate(p);
    this.refresh();
  },

  /** Distance limits per detail class for the current projection (see header). The
   *  railing bays' last limit shrinks with the view angle (mats.js angleK). */
  limits(px) {
    const geo = geoLimit() + 0.5;
    const d1 = (TOL[1] * px) / 0.4, d2 = (TOL[2] * px) / 0.4;
    const carve = (0.01 * px) / 0.6; // what the light levels leave out (~1 cm) is under 0.6 px
    // far plants once the light level's leaves (14 cm) are under 2 px; planter hook
    // straps (2.6 cm) and AC pipes (3.6 cm) go once they are under a pixel
    return {
      rail: Object.assign([d1, d2, geo], { angleK }), post: [d2, geo], carve: [carve, Infinity], plant: [carve, 0.07 * px, Infinity],
      strap: [0.026 * px], ac: [0.036 * px, Infinity],
    };
  },

  update(dt, app) {
    // projected pixels per metre at 1 m distance
    app.renderer.getDrawingBufferSize(_sz);
    const px = 0.5 * _sz.y * app.camera.projectionMatrix.elements[5];
    uIronPx.value = px;
    const post = app.post;
    uIronA2C.value = post && !post.disabled && post.sceneRT ? post.sceneRT.samples | 0 : 0;
    // a zoom changes every limit; otherwise an entry is revisited once the camera has
    // moved further than the slack its last partition left
    const zoomed = Math.abs(px - this.lastPx) > 0.01 * px;
    if (zoomed) this.lastPx = px;
    this.prefetch(app);
    for (const g of this.pending) if (this.shown(g)) this.activate(g);
    this.refresh(zoomed);
  },
};

export default ironwork;
