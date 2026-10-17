import * as THREE from 'three';
import * as S from './postShaders.js';

// Post-processing: HDR scene (HalfFloat, MSAA) → half-res SSAO → half-res volumetric
// clouds → scene prepass (clouds over the sky, AO,
// aerial perspective, heat shimmer, dusk airlight, circle of confusion) → blur pyramid
// → depth-of-field gather → bloom pyramid → metered exposure → AgX tone map, grade, lens.
// Contract in docs/ARCHITECTURE.md: render(dt, app), setSize(w, h).

const QUALITY = {
  low: { msaa: 0, ao: 0, dof: false, levels: 5, shimmer: false, lamps: 4 },
  med: { msaa: 4, ao: 8, dof: true, levels: 6, shimmer: true, lamps: 6 },
  high: { msaa: 4, ao: 12, dof: true, levels: 6, shimmer: true, lamps: 8 },
};

const F_NUMBER = 3.5;          // lens aperture for the depth of field
const FOCUS_M = 55;            // focus distance (m)
const SENSOR_H_MM = 24;

function target(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, ...opts,
  });
}

// one triangle covering the screen
const TRI = new THREE.BufferGeometry();
TRI.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
TRI.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

/** Opt-in GPU section timer (URL prof=1): results in post.timings (ms, smoothed). */
class SectionTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.timings = {};
    this.open = null;
  }
  begin(name) {
    if (!this.ext) return;
    this.end();
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.open = { name, q };
  }
  end() {
    if (!this.ext || !this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
  }
  collect() {
    const gl = this.gl;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
        const o = this.timings[p.name];
        this.timings[p.name] = o === undefined ? ms : o * 0.95 + ms * 0.05;
      }
      gl.deleteQuery(p.q);
      this.pending.shift();
    }
    if (this.pending.length > 400) { this.pending.forEach((p) => gl.deleteQuery(p.q)); this.pending = []; }
  }
}

function pass(fragmentShader, uniforms, defines = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader: S.QUAD_VS, fragmentShader, uniforms, defines,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const mesh = new THREE.Mesh(TRI, material);
  mesh.frustumCulled = false;
  return mesh;
}

const post = {
  name: 'post',

  async init(app) {
    this.app = app;
    this.q = QUALITY[app.params.quality] || QUALITY.high;
    const q = this.q;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.size = new THREE.Vector2();
    this.firstFrame = true;
    this.lumPing = 0;
    const env = app.systems.env;
    const air = env?.lights?.airlight;
    const nLamps = air ? air.lampPos.length : q.lamps;

    const camU = {
      uNear: { value: 0.3 }, uFar: { value: 2500 }, uProjXY: { value: new THREE.Vector2(1, 1) },
    };
    this.camU = camU;

    this.depthDown = pass(S.DEPTH_DOWN_FS, { ...camU, tDepth: { value: null } });
    this.aoPass = pass(S.AO_FS, {
      ...camU, tZ: { value: null }, uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 0.75 }, uIntensity: { value: 0.9 }, uFocalPx: { value: 500 },
    }, { AO_SAMPLES: Math.max(q.ao, 4) });
    this.aoBlur = pass(S.AO_BLUR_FS, { tAO: { value: null }, uDir: { value: new THREE.Vector2() } });

    const atmoU = env?.atmo?.uniforms;
    this.prepass = pass(S.PREPASS_FS, {
      ...camU,
      tScene: { value: null }, tDepth: { value: null }, tAO: { value: null },
      uSkyLUT: atmoU ? atmoU.uSkyLUT : { value: null },
      uSunDirA: atmoU ? atmoU.uSunDirA : { value: new THREE.Vector3(0, 1, 0) },
      uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 }, uAOStrength: { value: 0.8 }, uAOSize: { value: new THREE.Vector2(1, 1) },
      uHazeExt: { value: new THREE.Vector3(4.2e-4, 4.6e-4, 5.3e-4) }, uHazeInscatter: { value: 0.85 },
      uSkyIrr: env?.sky ? { value: env.sky.irrRT.texture } : { value: null },
      uSunGround: env?.sky ? env.sky.uniforms.uSunGround : { value: new THREE.Vector3(3, 3, 3) },
      uHazeSunVis: { value: 0.5 }, uHazeSun: { value: 1.0 },
      uShimmer: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) },
      uDofK: { value: 0 }, uFocus: { value: FOCUS_M },
      uNightAir: { value: 0 },
      uLampPos: { value: air ? air.lampPos : Array.from({ length: nLamps }, () => new THREE.Vector3()) },
      uLampI: { value: air ? air.lampI : new Float32Array(nLamps) },
      uHeadPos: { value: air ? air.headPos : new THREE.Vector3() },
      uHeadDir: { value: air ? air.headDir : new THREE.Vector3(0, 0, -1) },
      uHeadI: { value: 0 }, uHeadCos: { value: new THREE.Vector2(0.96, 0.995) },
      uMist: { value: 2.5e-3 },
      tClouds: { value: null }, uUseClouds: { value: 0 },
      uFarLamp: { value: env?.lights?.farLamps ?? Array.from({ length: 24 }, () => new THREE.Vector4()) },
      uFarI: { value: 0 }, uLampCos: { value: new THREE.Vector2(0.34, 0.95) },
    }, { NUM_LAMPS: nLamps, NUM_FAR: env?.lights?.farLamps?.length ?? 24, ...(q.ao ? { USE_AO: 1 } : {}) });

    this.dof = pass(S.DOF_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.down = pass(S.DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKaris: { value: 0 }, uClamp: { value: 1e4 } });
    this.up = pass(S.UP_FS, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.68 } });
    this.lum = pass(S.LUM_FS, { tSmall: { value: null }, tPrev: { value: null }, uSize: { value: new THREE.Vector2() }, uRate: { value: 1 } });
    this.final = pass(S.FINAL_FS, {
      tHDR: { value: null }, tBloom: { value: null }, tLum: { value: null },
      uExposure: { value: 1 }, uAutoExp: { value: 0.22 }, uBloom: { value: 0.035 },
      uVignette: { value: 0.38 }, uCA: { value: 0.0012 }, uGrain: { value: 0.012 }, uTime: { value: 0 },
      uWB: { value: new THREE.Vector3(1.0, 0.99, 0.965) },
      uSat: { value: 1.12 }, uContrast: { value: 1.08 },
      uShadowTint: { value: new THREE.Vector3(0.985, 1.0, 1.03) },
      uHighTint: { value: new THREE.Vector3(1.03, 1.0, 0.955) },
      uResolution: { value: new THREE.Vector2(1, 1) },
    });

    // opt-in profiler; the core frame timer is paused while it runs (queries cannot nest)
    this.prof = app.params.raw.get('prof') === '1' ? new SectionTimer(app.renderer.getContext()) : null;
    if (this.prof && app.gpuTimer) app.gpuTimer.ext = null;
    this.timings = this.prof ? this.prof.timings : null;

    this.lumRT = [target(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      target(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })];
    const v = new THREE.Vector2();
    app.renderer.getSize(v);
    this.setSize(v.x, v.y);
  },

  setSize() {
    const r = this.app.renderer;
    const v = r.getDrawingBufferSize(new THREE.Vector2());
    const W = Math.max(2, Math.floor(v.x)), H = Math.max(2, Math.floor(v.y));
    if (this.sceneRT && W === this.size.x && H === this.size.y) return;
    this.size.set(W, H);
    this._disposeTargets();
    const q = this.q;
    const depthTexture = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT = target(W, H, { depthBuffer: true, samples: q.msaa, depthTexture });
    this.hdrRT = target(W, H);
    this.dofRT = q.dof ? target(W, H) : null;
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    if (q.ao) {
      this.zRT = target(hw, hh, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.aoRT = target(hw, hh, { type: THREE.FloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.aoRT2 = target(hw, hh, { type: THREE.FloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    this.downs = []; this.ups = [];
    let w = W, h = H;
    for (let i = 0; i < q.levels; i++) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
      this.downs.push(target(w, h));
      this.ups.push(i > 0 && i < q.levels - 1 ? target(w, h) : null);
    }
    this.app.systems.env?.clouds?.setSize(W, H);
    this.final.material.uniforms.uResolution.value.set(W, H);
    this.prepass.material.uniforms.uResolution.value.set(W, H);
    this.prepass.material.uniforms.uAOSize.value.set(hw, hh);
    this.firstFrame = true;
  },

  _disposeTargets() {
    for (const k of ['sceneRT', 'hdrRT', 'dofRT', 'zRT', 'aoRT', 'aoRT2']) {
      if (this[k]) { if (this[k].depthTexture) this[k].depthTexture.dispose(); this[k].dispose(); this[k] = null; }
    }
    for (const t of [...(this.downs || []), ...(this.ups || [])]) t && t.dispose();
  },

  _draw(mesh, rt) {
    const r = this.app.renderer;
    r.setRenderTarget(rt);
    r.render(mesh, this.cam);
  },

  /** Per-time-of-day look parameters (haze, shimmer, airlight, bloom). */
  _todParams(env) {
    const t = env ? env.state.t : 0.12;
    const night = env ? env.state.night : 0;
    const pu = this.prepass.material.uniforms, fu = this.final.material.uniforms;
    // haze: a dusty summer afternoon
    const k = THREE.MathUtils.lerp(1.0, 1.12, THREE.MathUtils.smoothstep(t, 0.3, 0.8));
    pu.uHazeExt.value.set(3.6e-4 * k, 4.0e-4 * k, 4.7e-4 * k);
    pu.uHazeInscatter.value = 1.25;
    pu.uHazeSunVis.value = env ? env.canyonSunFraction : 0.5;
    pu.uHazeSun.value = 1.0;
    pu.uShimmer.value = this.q.shimmer ? 1.1 * (1 - THREE.MathUtils.smoothstep(t, 0.1, 0.4)) : 0;
    pu.uNightAir.value = night;
    fu.uBloom.value = THREE.MathUtils.lerp(0.035, 0.05, night);
    fu.uExposure.value = env ? env.exposure : 1;
    // white balance: daylight at midday, some of the evening warmth kept at golden hour,
    // then a cooler balance into the blue hour (the camera does not neutralise twilight)
    const warm = THREE.MathUtils.smoothstep(t, 0.25, 0.6) * (1 - THREE.MathUtils.smoothstep(t, 0.68, 0.84));
    const cool = THREE.MathUtils.smoothstep(t, 0.72, 1.0);
    fu.uWB.value.set(1.0 + 0.05 * warm - 0.11 * cool, 0.99 - 0.02 * cool, 0.965 - 0.06 * warm + 0.13 * cool);
    fu.uSat.value = THREE.MathUtils.lerp(1.12, 1.02, THREE.MathUtils.smoothstep(t, 0.6, 0.85));
  },

  render(dt, app) {
    const { renderer: r, scene, camera } = app;
    const env = app.systems.env;
    if (this.size.x === 0) this.setSize();
    const pr = r.getDrawingBufferSize(new THREE.Vector2());
    if (pr.x !== this.size.x || pr.y !== this.size.y) this.setSize();

    const prof = this.prof;
    if (prof) { prof.collect(); prof.begin('scene'); }
    // ---- 1. HDR scene
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    // camera uniforms
    const P = camera.projectionMatrix.elements;
    this.camU.uNear.value = camera.near;
    this.camU.uFar.value = camera.far;
    this.camU.uProjXY.value.set(P[0], P[5]);
    this._todParams(env);

    // ---- 2. SSAO (half res)
    if (prof) prof.begin('ao');
    if (this.q.ao) {
      this.depthDown.material.uniforms.tDepth.value = this.sceneRT.depthTexture;
      this._draw(this.depthDown, this.zRT);
      const au = this.aoPass.material.uniforms;
      au.tZ.value = this.zRT.texture;
      au.uTexel.value.set(1 / this.zRT.width, 1 / this.zRT.height);
      au.uFocalPx.value = P[5] * this.zRT.height * 0.5;
      this._draw(this.aoPass, this.aoRT);
      const bu = this.aoBlur.material.uniforms;
      bu.tAO.value = this.aoRT.texture; bu.uDir.value.set(1 / this.aoRT.width, 0);
      this._draw(this.aoBlur, this.aoRT2);
      bu.tAO.value = this.aoRT2.texture; bu.uDir.value.set(0, 1 / this.aoRT.height);
      this._draw(this.aoBlur, this.aoRT);
    }

    // ---- 3. volumetric clouds (half res, sky pixels only)
    const pu = this.prepass.material.uniforms;
    const clouds = env && !env.disabled ? env.clouds : null;
    if (clouds) {
      if (prof) prof.begin('clouds');
      pu.tClouds.value = clouds.render(camera, this.sceneRT.depthTexture, app.frame);
    } else {
      pu.tClouds.value = null;
    }
    pu.uUseClouds.value = clouds ? 1 : 0;

    // ---- 4. scene prepass
    if (prof) prof.begin('prepass');
    pu.tScene.value = this.sceneRT.texture;
    pu.tDepth.value = this.sceneRT.depthTexture;
    pu.tAO.value = this.aoRT ? this.aoRT.texture : null;
    pu.uCamWorld.value.copy(camera.matrixWorld);
    pu.uCamPos.value.copy(camera.position);
    pu.uTime.value = app.time;
    const air = env?.lights?.airlight;
    if (air) { pu.uHeadI.value = air.headI; pu.uHeadCos.value.set(air.headCos[0], air.headCos[1]); }
    const L = env?.lights;
    pu.uFarI.value = L ? L.farIntensity : 0;
    if (L) pu.uLampCos.value.set(L.lampCos[0], L.lampCos[1]);
    // thin-lens circle of confusion, in pixels
    const fovR = THREE.MathUtils.degToRad(camera.fov);
    const fmm = (SENSOR_H_MM / 2) / Math.tan(fovR / 2), fm = fmm / 1000;
    pu.uDofK.value = this.q.dof ? (fmm / F_NUMBER) * fm / (FOCUS_M - fm) * (this.size.y / SENSOR_H_MM) : 0;
    this._draw(this.prepass, this.hdrRT);

    // ---- 5. depth of field (gather, full res)
    let img = this.hdrRT;
    if (this.dofRT) {
      if (prof) prof.begin('dof');
      const fu0 = this.dof.material.uniforms;
      fu0.tSrc.value = this.hdrRT.texture;
      fu0.uTexel.value.set(1 / this.size.x, 1 / this.size.y);
      this._draw(this.dof, this.dofRT);
      img = this.dofRT;
    }

    // ---- 6. blur pyramid for bloom
    if (prof) prof.begin('pyramid');
    const du = this.down.material.uniforms;
    let src = img;
    for (let i = 0; i < this.downs.length; i++) {
      du.tSrc.value = src.texture;
      du.uTexel.value.set(1 / src.width, 1 / src.height);
      du.uKaris.value = i === 1 ? 1 : 0;
      du.uClamp.value = i === 1 ? 60 / Math.max(env ? env.exposure : 1, 1e-4) : 1e4;
      this._draw(this.down, this.downs[i]);
      src = this.downs[i];
    }
    const uu = this.up.material.uniforms;
    let low = this.downs[this.downs.length - 1];
    for (let i = this.downs.length - 2; i >= 1; i--) {
      uu.tLow.value = low.texture;
      uu.tHigh.value = this.downs[i].texture;
      uu.uTexel.value.set(1 / low.width, 1 / low.height);
      this._draw(this.up, this.ups[i]);
      low = this.ups[i];
    }

    // ---- 7. metered exposure (1x1, adapted over time)
    const lu = this.lum.material.uniforms;
    const small = this.downs[this.downs.length - 1];
    lu.tSmall.value = small.texture;
    lu.uSize.value.set(small.width, small.height);
    lu.tPrev.value = this.lumRT[this.lumPing].texture;
    lu.uRate.value = this.firstFrame ? 1 : 1 - Math.exp(-dt / 0.8);
    this.lumPing ^= 1;
    this._draw(this.lum, this.lumRT[this.lumPing]);

    // ---- 8. final
    if (prof) prof.begin('final');
    const fu = this.final.material.uniforms;
    fu.tHDR.value = img.texture;
    fu.tBloom.value = low.texture;
    fu.tLum.value = this.lumRT[this.lumPing].texture;
    fu.uTime.value = app.time + app.frame * 0.618;
    r.setRenderTarget(null);
    r.render(this.final, this.cam);
    if (prof) {
      prof.end();
      const t = prof.timings;
      t.post = (t.ao || 0) + (t.clouds || 0) + (t.prepass || 0) + (t.dof || 0) + (t.pyramid || 0) + (t.final || 0);
      t.total = t.post + (t.scene || 0);
      app.perf.gpuMs = t.total;
    }
    this.firstFrame = false;
  },
};

export default post;
