import * as THREE from 'three';
import { TRACK_OFFSET } from '../core/config.js';
import { LUX_PER_UNIT } from './atmosphere.js';

// Dusk lighting: a small pool of real lights reassigned every frame to the lamp
// standards nearest the view, and the tram headlight, a spot light just ahead of the
// cab aimed down the rails. Lanterns throw their light downwards, so the pool uses
// spot lights pointing at the ground (discrete pools under each standard).
//
// One real light per lantern, just under its bowl, so the arm, cap and scrolls above
// and beside it stay dark iron (a light at the merged centre of a two-lantern standard
// would sit in mid-air among the scrolls). Each standard's weight is a smooth function
// of its view-weighted distance and of the distance of the last one that still gets
// lights (an order statistic over the lanterns, so it changes continuously): nothing
// pops when the ranking changes. Standards beyond that are lit in screen space by post
// with the complementary weight, so the two systems always overlap exactly.
// The light count never changes, so switching day/night never recompiles shaders.

const LAMP_CD = 1400;           // luminous intensity of one lantern towards the ground (cd)
// a globe lantern lights the whole lower hemisphere: the cone reaches the facades 8–9 m
// away (~58° from the vertical) and the ground floors between the shops, fading out
// towards the horizontal
const LAMP_ANGLE = 1.35;        // half-angle of the lantern's light cone (rad)
const LAMP_PENUMBRA = 0.35;
const LAMP_DROP = 0.22;         // light source below the glass centre (m): at the bottom of the bowl (0.165 m)
const HEAD_CD = 15000;          // two LED headlights combined (cd, beam centre)
const HEAD_ANGLE = 0.42;        // beam half-angle (rad); the soft penumbra covers most of it
const HEAD_PENUMBRA = 0.85;
const QUERY = [-60, 170];       // metres along the route around the cab searched for standards
const FADE = 22;                // width of the real-light fade (m of view-weighted distance)
const FAR_MAX = 460;            // screen-space pools out to this distance
export const FAR_LAMPS = 24;
const FALLBACK_HEAD_H = 5.4;    // glass centre above the paving when the catenary module is absent

/**
 * The light pool has a fixed size (a changing light count would recompile every lit
 * material), so by day every lit fragment would still evaluate nine dark spot lights,
 * and at dusk the sun (dark below the skyline) and its shadow lookups. Patch the shared
 * light loops to skip a light whose colour is zero (a uniform, so the branch is
 * coherent), and a spot light's BRDF where the fragment lies outside its cone or range.
 * Must run before any lit material compiles.
 */
export function patchLightLoops() {
  const SC = THREE.ShaderChunk;
  let src = SC.lights_fragment_begin;
  const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const guard = (begin, head, visible, diffuseOnly = false) => {
    const a = src.indexOf(begin);
    const b = src.indexOf('#pragma unroll_loop_end', a);
    if (a < 0 || b < 0) return false;
    let block = src.slice(a, b);
    if (block.split(head).length !== 2 || block.split(call).length !== 2) return false;
    const v = head.split(' = ')[0];
    block = block.replace(head, `${head}\n\t\tif ( ${v}.color.r + ${v}.color.g + ${v}.color.b > 0.0 ) {`);
    // a diffuse-only light: whatever the material's RE_Direct adds to the specular terms
    // is put back (works for every lighting model and the patched leaf / surface ones)
    const body = diffuseOnly ? `{
\t\t\tvec3 dlSpec = reflectedLight.directSpecular;
\t\t\t#ifdef USE_CLEARCOAT
\t\t\tvec3 dlCc = clearcoatSpecularDirect;
\t\t\t#endif
\t\t\t#ifdef USE_SHEEN
\t\t\tvec3 dlSh = sheenSpecularDirect;
\t\t\t#endif
\t\t\t${call}
\t\t\treflectedLight.directSpecular = dlSpec;
\t\t\t#ifdef USE_CLEARCOAT
\t\t\tclearcoatSpecularDirect = dlCc;
\t\t\t#endif
\t\t\t#ifdef USE_SHEEN
\t\t\tsheenSpecularDirect = dlSh;
\t\t\t#endif
\t\t\t}` : call;
    block = block.replace(call, `${visible ? 'if ( directLight.visible ) ' : ''}${body}\n\t\t}`);
    src = src.slice(0, a) + block + src.slice(b);
    return true;
  };
  const spot = guard('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )', 'spotLight = spotLights[ i ];', true);
  const sun = guard('#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )', 'sunLight = sunLights[ i ];', false);
  // (the canyon cross-bounce is the only directional light; dark when no facade is sunlit).
  // Its source is a whole sunlit facade, a 10-20 m area light: no point-like specular
  // highlight in glass or polished stone, only its diffuse irradiance
  guard('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )', 'directionalLight = directionalLights[ i ];', false, true);
  SC.lights_fragment_begin = src;
  return spot && sun;
}

const lampColor = new THREE.Color(1.0, 0.64, 0.34);  // ~3300 K, linear
const headColor = new THREE.Color(1.0, 0.84, 0.68);  // ~4300 K, linear
const ss = THREE.MathUtils.smoothstep;

export class StreetLights {
  constructor(app, count = 8) {
    this.app = app;
    this.count = count;
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.SpotLight(lampColor, 0, 24, LAMP_ANGLE, LAMP_PENUMBRA, 2);
      l.castShadow = false;
      l.name = `lampLight${i}`;
      app.scene.add(l, l.target);
      this.pool.push(l);
    }
    this.head = new THREE.SpotLight(headColor, 0, 160, HEAD_ANGLE, HEAD_PENUMBRA, 2);
    this.head.castShadow = false;
    this.head.name = 'headlight';
    app.scene.add(this.head, this.head.target);

    // data for the in-scatter (airlight) pass in post
    this.airlight = {
      lampPos: Array.from({ length: count }, () => new THREE.Vector3()),   // glass centres
      lampI: new Float32Array(count),     // intensity in scene units (cd / LUX_PER_UNIT)
      headPos: new THREE.Vector3(),
      headDir: new THREE.Vector3(0, 0, -1),
      headI: 0,
      headCos: [Math.cos(HEAD_ANGLE), Math.cos(HEAD_ANGLE * (1 - HEAD_PENUMBRA))],
    };
    // distant standards, relit in screen space by post: xyz world position, w weight
    this.farLamps = Array.from({ length: FAR_LAMPS }, () => new THREE.Vector4());
    this.farIntensity = 0;
    this.farMinDist = 60;               // post relights only beyond this distance (m)
    this.lampCos = [Math.cos(LAMP_ANGLE), Math.cos(LAMP_ANGLE * (1 - LAMP_PENUMBRA))];
    this._standards = new Map();        // pole key → merged standard (cached)
    this._list = [];
    this._heads = [];                   // ranked lanterns of the near standards
    this._smp = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), right: new THREE.Vector3(), tanH: new THREE.Vector3() };
    this._p = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /**
   * Lamp standards within [sMin, sMax]: lanterns from the catenary module (else the pole
   * plan) merged per pole. A walk-side lantern inside or next to a tree crown gives its
   * light to the track-side lantern (a light among leaves would blow them out).
   */
  _standardsIn(sMin, sMax) {
    const app = this.app, out = this._list;
    out.length = 0;
    const cat = app.systems.catenary;
    let heads = null;
    if (cat && !cat.disabled && typeof cat.getLampHeads === 'function') {
      try { heads = cat.getLampHeads(sMin, sMax); } catch (e) { heads = null; }
    }
    const seen = new Set();
    if (heads && heads.length) {
      for (const it of heads) {
        const v = it.isVector3 ? it : (it.position || it.pos || it.world);
        if (!v || !Number.isFinite(v.x) || !Number.isFinite(it.s)) continue;
        const key = `${Math.round(it.s * 2)}:${it.side ?? Math.sign(it.d || 1)}`;
        let st = this._standards.get(key);
        if (!st) { st = this._newStandard(it.s, it.side ?? Math.sign(it.d || 1)); this._standards.set(key, st); }
        if (!seen.has(key)) { seen.add(key); st.heads.length = 0; out.push(st); }
        st.heads.push(v);
      }
      for (const st of out) this._resolve(st);
      return out;
    }
    // fallback: one lantern per lamp pole from the plan
    const { layout, route } = app;
    const i0 = layout.chunkIndex(sMin), n = Math.ceil((sMax - sMin) / 40) + 1;
    for (let k = 0; k <= n; k++) {
      for (const p of layout.inChunk('poles', i0 + k)) {
        if (!p.lamp) continue;
        const ds = route.delta(sMin, p.s);
        if (ds < 0 || ds > sMax - sMin) continue;
        const key = `${Math.round(p.s * 2)}:${p.side}`;
        let st = this._standards.get(key);
        if (!st) {
          st = this._newStandard(p.s, p.side);
          st.pos.copy(route.toWorld(p.s, p.d * 0.84, FALLBACK_HEAD_H - LAMP_DROP, this._p));
          st.heads.push(new THREE.Vector3(st.pos.x, st.pos.y + LAMP_DROP, st.pos.z));
          st.n = 1; st.resolved = true;
          this._standards.set(key, st);
        }
        out.push(st);
      }
    }
    return out;
  }

  _newStandard(s, side) {
    if (this._standards.size > 400) this._standards.clear(); // keep the cache bounded
    return { s, side, heads: [], pos: new THREE.Vector3(), n: 1, drop: -1, resolved: false, w: 0 };
  }

  /** Merge a standard's lanterns into one light position (once; lanterns never move). */
  _resolve(st) {
    if (st.resolved || !st.heads.length) return;
    const { route, layout } = this.app;
    const smp = route.sample(st.s, this._smp);
    // lateral offset of each lantern; the outermost one of a pair is on the walk side
    const lat = st.heads.map((v) => (v.x - smp.pos.x) * smp.right.x + (v.z - smp.pos.z) * smp.right.z);
    let drop = -1;
    if (st.heads.length > 1) {
      let walk = 0;
      for (let i = 1; i < lat.length; i++) if (Math.abs(lat[i]) > Math.abs(lat[walk])) walk = i;
      // a tree crown around the walk-side lantern?
      const i0 = layout.chunkIndex(st.s - 8), i1 = layout.chunkIndex(st.s + 8);
      for (let c = i0; c <= i1 && drop < 0; c++) {
        for (const t of layout.inChunk('trees', c)) {
          if (t.side !== st.side) continue;
          const r = Math.max(2.0, (t.crown || 3) * 0.5 + 0.8);
          if (Math.hypot(route.delta(st.s, t.s), lat[walk] - t.d) < r) { drop = walk; break; }
        }
      }
    }
    st.pos.set(0, 0, 0);
    let m = 0;
    st.heads.forEach((v, i) => { if (i !== drop) { st.pos.add(v); m++; } });
    st.pos.multiplyScalar(1 / Math.max(m, 1));
    st.pos.y -= LAMP_DROP;
    st.n = st.heads.length;      // a dropped lantern's flux goes to the remaining one
    st.drop = drop;
    st.resolved = true;
  }

  update(app, night) {
    const s = app.cameraS ?? app.train?.s ?? app.startS;
    const { route } = app;
    const on = night > 0.001;
    const air = this.airlight, N = this.count;
    const unitI = LAMP_CD / LUX_PER_UNIT;

    // ---- lamp standards ranked by view-weighted distance. Standards behind the view count
    // as much farther (their pools are out of frame), so looking ahead the whole pool
    // covers the stations in front, and looking back lights the ones behind.
    let D = 0;
    let list = [];
    if (on) {
      list = this._standardsIn(s + QUERY[0], s + QUERY[1]);
      const smp = route.sample(s, this._smp);
      app.camera.getWorldDirection(this._fwd);
      const c = THREE.MathUtils.clamp(this._fwd.x * smp.tan.x + this._fwd.z * smp.tan.z, -1, 1);
      for (const st of list) {
        const ds = route.delta(s, st.s);
        st.ds = ds;
        st.score = ds >= 0 ? ds * (1 + 12 * Math.max(0, -c)) : -ds * (1 + 12 * Math.max(0, c));
      }
      list.sort((a, b) => a.score - b.score);
      // lanterns in rank order (a lantern inside a tree crown gives its flux to its pair)
      const H = this._heads;
      H.length = 0;
      for (const st of list) {
        for (let k = 0; k < st.heads.length; k++) {
          if (k === st.drop) continue;
          H.push({ st, v: st.heads[k], n: st.drop >= 0 ? st.n : 1 });
        }
      }
      // the score of the N-th lantern: continuous in time, and every standard with a
      // nonzero weight is guaranteed a light for each of its lanterns
      D = H.length >= N ? H[N - 1].st.score : QUERY[1];
    }
    const H = this._heads;
    for (let i = 0; i < N; i++) {
      const l = this.pool[i], h = on ? H[i] : null;
      const w = h ? 1 - ss(h.st.score, D - FADE, D) : 0;
      if (!h || w <= 0) { l.intensity = 0; air.lampI[i] = 0; continue; }
      l.position.set(h.v.x, h.v.y - LAMP_DROP, h.v.z);
      l.target.position.set(h.v.x, h.v.y - 10, h.v.z);
      l.target.updateMatrixWorld();
      l.intensity = unitI * h.n * night * w;
      air.lampPos[i].copy(h.v);
      air.lampI[i] = l.intensity;
    }

    // ---- distant standards for the screen-space pools: the complementary weight of the
    // real lights' fade, out to FAR_MAX
    this.farMinDist = Math.max(0, D - FADE - 15);
    if (on) {
      const far = this._standardsIn(s + Math.max(0, D - FADE - 2), s + FAR_MAX);
      let k = 0;
      for (const st of far) {
        if (k >= FAR_LAMPS) break;
        const ds = route.delta(s, st.s);
        if (ds < 0) continue;
        const w = ss(ds, D - FADE, D) * (1 - ss(ds, FAR_MAX - 60, FAR_MAX));
        if (w <= 0) continue;
        this.farLamps[k++].set(st.pos.x, st.pos.y, st.pos.z, w * st.n);
      }
      for (; k < FAR_LAMPS; k++) this.farLamps[k].set(0, -1e4, 0, 0);
    }
    // intensity of one far lantern (the per-standard weight × lantern count is in w)
    this.farIntensity = on ? unitI * night : 0;

    // ---- headlight: just ahead of the cab, 0.9 m up, aimed ~45 m down the ride track
    const hp = route.toWorld(s + 0.4, TRACK_OFFSET, 0.9, this.head.position);
    route.toWorld(s + 45, TRACK_OFFSET, 0, this.head.target.position);
    this.head.target.updateMatrixWorld();
    this.head.intensity = (HEAD_CD / LUX_PER_UNIT) * night;
    air.headPos.copy(hp);
    air.headDir.subVectors(this.head.target.position, hp).normalize();
    air.headI = this.head.intensity;
  }
}
