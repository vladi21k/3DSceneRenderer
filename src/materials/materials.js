import * as THREE from 'three';
import { U } from '../core/uniforms.js';
import { Baker } from './baker.js';
import { RECIPES } from './recipes/index.js';
import { LIBRARY } from './library.js';
import { applySurface, surfaceUniforms } from './surface.js';

// Physically based material library (contract: docs/ARCHITECTURE.md).
// At init every tileable texture set is baked procedurally on the GPU (baker.js), then
// the library materials are created with the runtime surface patch (surface.js) that
// removes tiling (per-row shifts, per-cell colour), adds macro / detail variation and
// specular anti-aliasing. All geometry UVs are metres; materials own the scale.

const lib = new Map();
const variants = new Map();
const listeners = new Set();
const tracked = new Set();
const shared = {
  textures: new Map(),
  detail: null,
  macro: null,
  night: U.uNight,
  gain: { value: 1 },
};

const lin = (a) => new THREE.Color().setRGB(a[0], a[1], a[2], THREE.LinearSRGBColorSpace);

function setProps(m, props) {
  for (const [k, v] of Object.entries(props)) {
    if (k === 'side') m.side = v === 'double' ? THREE.DoubleSide : v === 'back' ? THREE.BackSide : v === 'front' ? THREE.FrontSide : v;
    else if (m[k] && m[k].isColor) Array.isArray(v) ? m[k].copy(lin(v)) : m[k].set(v);
    else if (m[k] && m[k].isVector2 && Array.isArray(v)) m[k].fromArray(v);
    else m[k] = v;
  }
}

/** Build a library material from its definition. */
function build(name, def) {
  const m = def.kind === 'physical' ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
  m.name = name;
  setProps(m, def.props || {});
  const t = def.bake ? shared.textures.get(def.bake) : null;
  const surf = def.surf || {};
  const defines = {};
  if (t) {
    defines.SURF = '';
    if (t.recipe.layout && surf.rows !== false) defines.SURF_ROWS = '';
    if (surf.detail && shared.detail) defines.SURF_DETAIL = '';
    if ((surf.macro || surf.stain) && shared.macro) defines.SURF_MACRO = '';
    if (surf.spots && defines.SURF_ROWS !== undefined) defines.SURF_SPOTS = '';
    if (t.recipe.metalMask) defines.SURF_METALMASK = '';
    if (surf.swap) defines.SURF_SWAP = '';
    if (def.glassClear) defines.SURF_GLASS = '';
  }
  if (surf.trans) defines.SURF_TRANS = '';
  if (def.night) defines.SURF_NIGHT = '';
  if (Object.keys(defines).length) {
    applySurface(m, { defines, textures: t, uniforms: surfaceUniforms(surf, t, shared), def });
  }
  return m;
}

/** Copy a library material into a variant, keeping the surface patch and its uniforms. */
function cloneLib(base) {
  const m = base.clone();
  const sf = base.userData.sf;
  if (sf) applySurface(m, sf);
  return m;
}

function stableKey(o) {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k] && o[k].isColor ? o[k].getHex() : o[k]]));
}

const materials = {
  name: 'materials',
  /** baked texture sets by recipe name: {albedo, surface, raw, recipe} */
  textures: shared.textures,
  /** per material: texture tile size and pattern metrics (see library.js meta) */
  meta: {},
  /** global emissive gain for night materials (env / post may tune it) */
  uniforms: { emissiveGain: shared.gain },
  stats: {},

  async init(app) {
    this.app = app;
    const t0 = performance.now();
    const needed = new Set(['detail', 'macro']);
    for (const d of Object.values(LIBRARY)) if (d.bake) needed.add(d.bake);
    const recipes = [...needed].map((n) => RECIPES[n]).filter(Boolean);
    let baked = new Map();
    try {
      const baker = new Baker(app.renderer);
      baked = await baker.bake(recipes);
      this.stats.bake = baker.stats;
    } catch (e) {
      console.warn('[materials] texture bake failed, using flat materials', e);
    }
    for (const [k, v] of baked) shared.textures.set(k, v);
    shared.detail = shared.textures.get('detail')?.surface || null;
    shared.macro = shared.textures.get('macro')?.raw || null;

    for (const [name, def] of Object.entries(LIBRARY)) {
      this.register(name, build(name, def));
      const r = def.bake && RECIPES[def.bake];
      const sc = def.surf?.scale ?? 1;
      this.meta[name] = {
        tile: r ? [r.tile[0] * sc, r.tile[1] * sc] : null,
        vertexColor: def.vc || 'tint',
        textured: !!shared.textures.get(def.bake),
        ...(def.meta || {}),
      };
      if (sc !== 1 && def.meta) for (const k of ['courseH', 'blockL']) if (def.meta[k]) this.meta[name][k] = def.meta[k] * sc;
    }
    this.stats.initMs = performance.now() - t0;
    this.stats.textureMB = +((this.stats.bake?.bytes || 0) / 1048576).toFixed(1);
  },

  /** Shared material by name. opts (e.g. {vertexColors:true}, {side: THREE.DoubleSide}) returns a cached variant. */
  get(name, opts) {
    if (!lib.has(name)) {
      console.warn('[materials] unknown material', name);
      this.register(name, new THREE.MeshStandardMaterial({ color: 0xff00ff, name }));
    }
    if (!opts || !Object.keys(opts).length) return lib.get(name);
    const key = name + stableKey(opts);
    if (!variants.has(key)) {
      const base = lib.get(name);
      const m = cloneLib(base);
      setProps(m, opts);
      // 'albedo' materials: the vertex colour IS the paint colour
      if (opts.vertexColors && this.meta[name]?.vertexColor === 'albedo') m.color.setRGB(1, 1, 1);
      m.name = key;
      m.needsUpdate = true;
      variants.set(key, m);
      this.track(m);
    }
    return variants.get(key);
  },
  register(name, mat) { mat.name = mat.name || name; lib.set(name, mat); this.track(mat); return mat; },
  /** Every material that ends up in the scene must be tracked so lighting can configure it. */
  track(mat) { if (!tracked.has(mat)) { tracked.add(mat); for (const fn of listeners) fn(mat); } return mat; },
  all() { return [...tracked]; },
  onTrack(fn) { listeners.add(fn); for (const m of tracked) fn(m); return () => listeners.delete(fn); },
  names() { return [...lib.keys()]; },
};

export default materials;
