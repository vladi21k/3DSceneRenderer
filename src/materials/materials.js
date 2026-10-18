import * as THREE from 'three';
import { U } from '../core/uniforms.js';
import { Baker } from './baker.js';
import { RECIPES } from './recipes/index.js';
import { LIBRARY } from './library.js';
import { applySurface, surfaceUniforms, surfaceOf, familyOf } from './surface.js';

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
  aoScale: { value: 1 },
  sunDir: U.uSunDir,
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
  // the shader code is assembled per feature family (lite / full) plus the translucency,
  // night and glass switches; everything else is uniform-driven (surface.js)
  if (t || def.night || surf.trans) {
    applySurface(m, {
      textures: t, family: familyOf(def, t?.recipe), trans: !!surf.trans, night: !!def.night, glass: !!def.glassClear,
      uniforms: surfaceUniforms(surf, def, t, shared),
    });
  }
  return m;
}

/** Flat stand-in when a definition fails to build: its colour (or the recipe mean). */
function fallback(name, def) {
  const p = def.props || {};
  const r = def.bake && RECIPES[def.bake];
  const flat = r?.flat || [0.5, 0.5, 0.5, 0.7];
  // (a heightA recipe keeps its height in the alpha, not the roughness)
  const m = new THREE.MeshStandardMaterial({ name, metalness: p.metalness ?? 0, roughness: Math.min(1, (p.roughness ?? 1) * (r?.heightA ? 0.88 : flat[3])) });
  m.color.copy(lin(Array.isArray(p.color) ? p.color : flat));
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
  /** global emissive gain for night materials (env / post may tune it); aoScale scales the
   *  baked small-scale AO / micro-shadowing (post may lower it while its SSAO runs) */
  uniforms: { emissiveGain: shared.gain, aoScale: shared.aoScale },
  stats: {},

  async init(app) {
    this.app = app;
    const t0 = performance.now();
    const needed = new Set(['detail', 'macro']);
    for (const d of Object.values(LIBRARY)) {
      for (const n of [d.bake, d.surf?.detail?.tex, d.surf?.detail?.tool]) if (n) needed.add(n);
    }
    const recipes = [...needed].map((n) => RECIPES[n]).filter(Boolean);
    // Targets are allocated and flat-filled now (so every material can be built at once);
    // the procedural bake compiles in parallel on the driver's threads and renders as each
    // program is ready. init does not wait for it: the other modules' init, the first chunk
    // builds and the scene's shader compile run meanwhile, and the maps are final long
    // before the loading screen goes (materials.ready resolves then). While the app is not
    // ready a recipe bakes as soon as it compiles; later ones are spread over frames.
    this.ready = Promise.resolve(null);
    const raw = app.params?.raw;
    const flat = raw?.get?.('matflat') === '1';      // debug: skip baking (A/B cost check)
    const profile = raw?.get?.('matprof') === '1';   // debug: GPU time per recipe (forced sync)
    if (!flat) {
      try {
        const baker = new Baker(app.renderer);
        const entries = baker.prepare(recipes);
        for (const [k, v] of entries) shared.textures.set(k, v);
        this.ready = baker.run(entries, { immediate: () => !app.ready, profile }).then((st) => {
          this.stats.bake = st;
          this.stats.textureMB = +(st.bytes / 1048576).toFixed(1);
          this.stats.bakedAfterMs = performance.now() - t0;
          return st;
        }).catch((e) => { console.warn('[materials] texture bake failed', e); return null; });
      } catch (e) {
        console.warn('[materials] texture bake unavailable, using flat materials', e);
      }
    }
    shared.detail = shared.textures.get('detail')?.surface || null;
    shared.macro = shared.textures.get('macro')?.raw || null;

    // every entry builds on its own: a failing one falls back to a flat material, so
    // init can never throw (the app cannot start without the library)
    for (const [name, def] of Object.entries(LIBRARY)) {
      let m;
      try {
        m = build(name, def);
      } catch (e) {
        console.error('[materials] build', name, e && e.stack || e);
        m = fallback(name, def);
      }
      this.register(name, m);
      try {
        const r = def.bake && RECIPES[def.bake];
        const sc = def.surf?.scale ?? 1;
        this.meta[name] = {
          tile: r ? [r.tile[0] * sc, r.tile[1] * sc] : null,
          vertexColor: def.vc || 'tint',
          textured: !!shared.textures.get(def.bake),
          ...(def.meta || {}),
        };
        if (sc !== 1 && def.meta) for (const k of ['courseH', 'blockL']) if (def.meta[k]) this.meta[name][k] = def.meta[k] * sc;
      } catch (e) {
        console.error('[materials] meta', name, e && e.stack || e);
        this.meta[name] = { tile: null, vertexColor: def.vc || 'tint', textured: false };
      }
    }
    const wait = +(raw?.get?.('matwait') || 0);       // debug: ms init waits for the bake (A/B)
    if (wait > 0) await Promise.race([this.ready, new Promise((r) => setTimeout(r, wait))]);
    this.stats.initMs = performance.now() - t0;
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
      const m = lib.get(name).clone(); // clone() keeps the surface patch and its uniforms
      // 'albedo' materials: the vertex colour IS the paint colour (unless a colour is given)
      if (opts.vertexColors && this.meta[name]?.vertexColor === 'albedo') m.color.setRGB(1, 1, 1);
      setProps(m, opts);
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
  /** Live shader uniforms of a library material's surface patch (shared with its variants), or null. */
  uniformsOf(name) { const m = lib.get(name); return (m && surfaceOf.get(m)?.uniforms) || null; },
};

export default materials;
