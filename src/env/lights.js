import * as THREE from 'three';
import { TRACK_OFFSET } from '../core/config.js';
import { LUX_PER_UNIT } from './atmosphere.js';

// Dusk lighting: a small pool of real lights reassigned every frame to the lamp heads
// nearest the cab (fading in/out at the ends of the range so nothing pops), and the
// tram headlight, a spot light just ahead of the cab aimed down the rails. Lanterns
// throw their light downwards, so the pool uses wide spot lights pointing at the
// ground rather than point lights (no glowing canopies above the lamps).
// The light count never changes, so switching day/night never recompiles shaders.

const LAMP_CD = 1400;           // luminous intensity of one lantern towards the ground (cd)
const LAMP_ANGLE = 1.22;        // half-angle of the lantern's light cone (rad)
const HEAD_CD = 26000;          // two LED headlights combined (cd, beam centre)
const LAMP_RANGE = [-14, 92];   // metres along the route relative to the cab (real lights)
const FAR_RANGE = [70, 460];    // lamps lit in screen space by post (beyond the real lights)
export const FAR_LAMPS = 24;
const FALLBACK_HEAD_H = 5.5;

const lampColor = new THREE.Color(1.0, 0.64, 0.34);  // ~3300 K, linear
const headColor = new THREE.Color(1.0, 0.93, 0.84);  // ~4800 K LED, linear

export class StreetLights {
  constructor(app, count = 8) {
    this.app = app;
    this.count = count;
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.SpotLight(lampColor, 0, 32, LAMP_ANGLE, 0.75, 2);
      l.castShadow = false;
      l.name = `lampLight${i}`;
      app.scene.add(l, l.target);
      this.pool.push(l);
    }
    this.head = new THREE.SpotLight(headColor, 0, 160, 0.26, 0.65, 2);
    this.head.castShadow = false;
    this.head.name = 'headlight';
    app.scene.add(this.head, this.head.target);

    // data for the in-scatter (airlight) pass in post
    this.airlight = {
      lampPos: Array.from({ length: count }, () => new THREE.Vector3()),
      lampI: new Float32Array(count),     // intensity in scene units (cd / LUX_PER_UNIT)
      headPos: new THREE.Vector3(),
      headDir: new THREE.Vector3(0, 0, -1),
      headI: 0,
      headCos: [Math.cos(0.26), Math.cos(0.26 * 0.35)],
    };
    // distant lamps, relit in screen space by post: xyz world position, w intensity (scene units)
    this.farLamps = Array.from({ length: FAR_LAMPS }, () => new THREE.Vector4());
    this._farTimer = 0;
    this.farIntensity = 0;
    this.lampCos = [Math.cos(LAMP_ANGLE), Math.cos(LAMP_ANGLE * 0.25)];
    this._heads = [];
    this._tmp = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  /** Lamp heads within [sMin, sMax]: from the catenary module when available, else the pole plan. */
  _lampHeads(sMin, sMax) {
    const app = this.app, out = this._heads;
    out.length = 0;
    const cat = app.systems.catenary;
    if (cat && !cat.disabled && typeof cat.getLampHeads === 'function') {
      try {
        const list = cat.getLampHeads(sMin, sMax);
        if (list && list.length) {
          for (const it of list) {
            const v = it.isVector3 ? it : (it.pos || it.position || it.world || it);
            if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
              out.push({ x: v.x, y: v.y, z: v.z, s: Number.isFinite(it.s) ? it.s : null });
            }
          }
          if (out.length) return out;
        }
      } catch (e) { /* fall back to the plan */ }
    }
    const { layout, route } = app;
    const i0 = layout.chunkIndex(sMin), n = Math.ceil((sMax - sMin) / 40) + 1;
    for (let k = 0; k <= n; k++) {
      for (const p of layout.inChunk('poles', i0 + k)) {
        if (!p.lamp) continue;
        const ds = route.delta(sMin, p.s);
        if (ds < 0 || ds > sMax - sMin) continue;
        route.toWorld(p.s, p.d * 0.84, FALLBACK_HEAD_H, this._p);
        out.push({ x: this._p.x, y: this._p.y, z: this._p.z, s: p.s });
      }
    }
    return out;
  }

  update(app, night) {
    const s = app.cameraS ?? app.train?.s ?? app.startS;
    const { route } = app;
    const on = night > 0.001;
    const air = this.airlight;

    // ---- lamps
    let heads = [];
    if (on) heads = this._lampHeads(s + LAMP_RANGE[0], s + LAMP_RANGE[1]);
    const scored = heads.map((h) => {
      const ds = h.s != null ? route.delta(s, h.s) : this._tmp.set(h.x, h.y, h.z).distanceTo(app.camera.position);
      return { h, ds };
    }).sort((a, b) => Math.abs(a.ds - 18) - Math.abs(b.ds - 18));
    for (let i = 0; i < this.count; i++) {
      const l = this.pool[i], sc = scored[i];
      if (!sc) { l.intensity = 0; air.lampI[i] = 0; continue; }
      const w = THREE.MathUtils.smoothstep(sc.ds, LAMP_RANGE[0], LAMP_RANGE[0] + 9)
        * (1 - THREE.MathUtils.smoothstep(sc.ds, LAMP_RANGE[1] - 22, LAMP_RANGE[1]));
      l.position.set(sc.h.x, sc.h.y - 0.25, sc.h.z);
      l.target.position.set(sc.h.x, sc.h.y - 10, sc.h.z);
      l.target.updateMatrixWorld();
      l.intensity = (LAMP_CD / LUX_PER_UNIT) * night * w;
      air.lampPos[i].copy(l.position);
      air.lampI[i] = l.intensity;
    }

    // ---- distant lamps for the screen-space pools (refreshed a few times a second)
    if (on && (this._farTimer -= app.realDt ?? 0.016) <= 0) {
      this._farTimer = 0.15;
      const far = this._lampHeads(s + FAR_RANGE[0], s + FAR_RANGE[1]).map((h) => ({
        h, ds: h.s != null ? route.delta(s, h.s) : this._tmp.set(h.x, h.y, h.z).distanceTo(app.camera.position),
      })).sort((a, b) => a.ds - b.ds);
      for (let i = 0; i < FAR_LAMPS; i++) {
        const f = far[i], v = this.farLamps[i];
        if (!f) { v.set(0, -1e4, 0, 0); continue; }
        // hand over from the real lights as they fade out; fade at the far end
        const w = THREE.MathUtils.smoothstep(f.ds, LAMP_RANGE[1] - 22, LAMP_RANGE[1])
          * (1 - THREE.MathUtils.smoothstep(f.ds, FAR_RANGE[1] - 60, FAR_RANGE[1]));
        v.set(f.h.x, f.h.y - 0.25, f.h.z, w);
      }
    }
    // intensity of one far lamp (the per-lamp hand-over weight is in w)
    this.farIntensity = on ? (LAMP_CD / LUX_PER_UNIT) * night : 0;

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
