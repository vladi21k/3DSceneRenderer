import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { U } from '../core/uniforms.js';
import { noise1 } from '../core/rng.js';
import { TRACK_OFFSET } from '../core/config.js';
import { Atmosphere, SUN_E0, SUN_TINT, LUX_PER_UNIT, MIE_DEFAULT } from './atmosphere.js';
import { Sky } from './sky.js';
import { Clouds } from './clouds.js';
import { StreetSunShadow, patchSunShadowChunk, precompileShadowPrograms, installDepthKinds } from './sunShadow.js';
import { ShadowBatcher } from './shadowBatch.js';
import { sunDirection, solarPosition } from './sunPath.js';
import { StreetLights, patchLightLoops, lampLevel } from './lights.js';

// Environment: physically based sky and sun, cascaded sun shadows, HDR image-based
// lighting, wind, time of day and the dusk lights. Contract in docs/ARCHITECTURE.md.
//
// Units: 1.0 = 33,000 lux / 33,000 cd/m² (see atmosphere.js). Midday sun ≈ 3, a
// sunlit limestone wall ≈ 0.3–0.5, the blue sky ≈ 0.2–0.4, a lamp globe ≈ 0.3.
// Emissive materials should use these units (lit shop window ≈ 0.01–0.03).

const QUALITY = {
  low: { cascades: 2, mapSize: 1536, taps: 6, lamps: 4, envSize: 128, cloudSteps: 24 },
  med: { cascades: 3, mapSize: 2048, taps: 12, lamps: 8, envSize: 192, cloudSteps: 32 },
  // (high: 4096-texel tiles, ~1 cm texels in the nearest cascade and ~2 cm in the next, so
  // railing bars and lamp arms throw real shadows; about +0.6-1 ms of shadow pass)
  high: { cascades: 4, mapSize: 4096, taps: 16, lamps: 12, envSize: 256, cloudSteps: 44 },
};

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _es = new THREE.Vector3();
const _es2 = new THREE.Vector3();
const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
const _tc = new THREE.Vector3();
const XYZ = ['x', 'y', 'z'];
const _up = [0, 0, 0], _dn = [0, 0, 0], _cr = [0, 0, 0];
const _smpH = {}, _smpE = {};   // route samples (reused per frame)

// Weather regimes (one per world seed; URL sky= picks one): a pale dust haze with faint
// cirrus, high cirrus streaks over altocumulus patches (no low cumulus: a few evenly
// strewn small puffs in the telephoto sky slot read as cotton balls), or a field of
// small flat-based cumulus. cover/scale/top shape the volumetric cumulus.
// mie: aerosol load (x the clean reference atmosphere); haze: street-level dust haze
// (extinction and in-scatter scale for post's aerial perspective)
const WEATHER = {
  streaks: { cover: 0, scale: 0.42, top: 650, cirrus: 0.95, altocu: 0.5, mie: 32, haze: { ext: 1, inscatter: 1 } },
  cumulus: { cover: 0.6, scale: 0.36, top: 750, cirrus: 0.3, altocu: 0, mie: 32, haze: { ext: 1, inscatter: 1 } },
  // a pale dust haze: the sky milky and nearly white towards the horizon, far facades
  // losing most of their contrast
  // (bright, nearly non-absorbing dust, a touch warm; its extinction takes about a fifth
  // of the direct sun, and the forward scatter softens the shadow edges)
  // (mineral dust absorbs a little in the blue, so the haze sky is cream rather than pale
  // blue, and post keeps half of its daytime sky saturation boost)
  haze: { cover: 0, scale: 1, top: 800, cirrus: 0.3, altocu: 0, mie: 130, mieH: 1.0, mieAlb: [0.985, 0.94, 0.83], penumbra: 1.3, haze: { ext: 1.4, inscatter: 1.2 }, skySat: 0.5 },
};
const WALL_ALB = [0.55, 0.49, 0.40];
const GROUND_ALB = [0.17, 0.175, 0.185];   // grey granite paving (as the street material)
// canyon bounce: the share of the interreflection the environment map's single capture
// point misses (its canyon model already holds the sunlit facades and floor): the
// sunlit walls seen from the floor (up), the sunlit floor seen from below (down), and the
// sunlit facade seen from the opposite one (cross; a horizontal, diffuse-only light, so a
// shadow on the sunlit facade itself gets none of its own warm bounce, and glass shows no
// highlight from it)
// (open shade on the paving stays sky-blue: the warm wall bounce it gets is small)
const BOUNCE = { up: 0.065, down: 0.12, cross: 0.22 };
// exposure: a 0.18 albedo under the horizontal illuminance Eh is exposed to 0.18 KDAY
// while Eh is above EH_FULL; below it the camera adapts only partly (dusk stays darker
// than midday). KDAY rises by EXPO_LIFT (EV, time of day): a photograph of a sunny
// street exposes for the shade and the people, so whites and glints clip and the low
// sun's backlit street glows. Under the high sun (to t 0.3) the lift is under half a
// stop: the sunlit granite near the cab lands at ~165-180 sRGB with its setts and joints
// apart (post's meter gives back about a third of any change); more as the sun lowers
// and the street falls into shade, none once it has set (the dusk caps hold the exposure)
const KDAY = 1.3, EH_FULL = 1.9;
const EXPO_LIFT = [[0.0, 0.4], [0.3, 0.42], [0.45, 0.8], [0.55, 1.2], [0.65, 1.0], [0.78, 0.0]];
// exposed value of sun-facing stone that low-sun highlight protection holds: on the
// tone curve's shoulder (~3 stops over mid grey), as golden stone sits in a photograph
const LIT_STONE = 1.5;
// exposed value of the horizon slot down the street the camera holds (time of day, level),
// before post's highlight recovery, which brings it down to the shoulder with its colour:
// from mid-afternoon, looking towards the low sun, the aureole over the end of the street
// stays below ~7.3 stops over mid grey (a backlit golden street glows and the sky around
// the sun may clip, as it does in a photograph); from sunset on below ~4.6 stops, so the
// afterglow sits under the gamut knee with its gradient and hue. Interpolated in log
// terms; 64 = no hold.
const HORIZON_LEVEL = [[0.1, 64], [0.25, 24], [0.45, 30], [0.62, 26], [0.8, 4.5], [1.0, 4.5]];
// from sunset on, the metered exposure stays within this factor of the nominal one, so a
// view away from the afterglow does not open up to a grey midday; in the blue hour the
// camera opens up as far as the meter asks (time of day, factor; log interpolation)
const DUSK_CEIL = [[0.62, 1e4], [0.72, 1.8], [0.82, 1.8], [0.92, 4.2], [1.0, 4.2]];

/** EXPO_LIFT at time of day t (EV, smooth piecewise-linear). */
function expoLift(t) {
  const T = EXPO_LIFT;
  if (t <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) {
    if (t <= T[i][0]) return THREE.MathUtils.lerp(T[i - 1][1], T[i][1], THREE.MathUtils.smoothstep(t, T[i - 1][0], T[i][0]));
  }
  return T[T.length - 1][1];
}

/** HORIZON_LEVEL at time of day t (log interpolation). */
function horizonLevel(t) { return logTable(HORIZON_LEVEL, t); }

/** Table lookup ([[t, value], ...]) with smooth log-space interpolation. */
function logTable(T, t) {
  if (t <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) {
    if (t <= T[i][0]) {
      const k = THREE.MathUtils.smoothstep(t, T[i - 1][0], T[i][0]);
      return Math.exp(THREE.MathUtils.lerp(Math.log(T[i - 1][1]), Math.log(T[i][1]), k));
    }
  }
  return T[T.length - 1][1];
}

/** Sky irradiance on a horizontal surface (scene units), clear sky, sun elevation e (rad). */
function skyIrradiance(e) {
  const deg = e / (Math.PI / 180);
  if (deg >= 0) return 0.012 + 0.55 * Math.pow(Math.sin(e), 0.7);
  return 0.012 * Math.pow(10, 0.347 * Math.max(deg, -12));
}

const env = {
  name: 'env',
  // lamps: the street lamps' level (their photocells switch on before sunset, see lights.js)
  state: { t: 0, sunDir: new THREE.Vector3(0, 1, 0), sunElevation: 1, night: 0, lamps: 0 },
  exposure: 1,
  exposureBase: 1,
  exposureMax: 1e4,    // ceiling for the metered exposure (low-sun highlight protection)
  // street haze inputs for post: ambient in-scatter source, sunlit-air plane, far gap share
  haze: { amb: new THREE.Vector3(0.05, 0.06, 0.08), plane: new THREE.Vector4(0, 0, 0, -1), gap: 0, sun: 1 },
  // scene illuminant on a horizontal surface in the open (sun + sky), for white balance
  illuminant: new THREE.Vector3(1, 1, 1),
  // the direct sun's illuminance (rgb, normal incidence, zero below the skyline)
  sunIlluminant: new THREE.Vector3(1, 1, 1),

  async init(app) {
    this.app = app;
    const q = QUALITY[app.params.quality] || QUALITY.high;
    this.q = q;
    const { renderer, scene } = app;

    // shadows: built-in sun light with our cascade layout (patch before anything compiles)
    const patched = patchSunShadowChunk(q.cascades, q.taps);
    if (!patchLightLoops()) console.warn('[env] light loop layout changed; dark lights are not skipped');
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // one depth material per mesh kind in the shadow passes (no program re-evaluations);
    // env.depthKinds.reevals / .switches: with and without it, in the last shadow pass
    this.depthKinds = installDepthKinds(renderer);

    // weather regime: one per world seed, URL sky= picks one
    const names = Object.keys(WEATHER);
    const pick = app.params.raw?.get?.('sky');
    this.weather = WEATHER[pick] ? pick : names[(Math.imul(app.params.seed | 0, 2654435761) >>> 0) % names.length];
    const w = WEATHER[this.weather];
    this.hazeBoost = w.haze;
    this.skySatScale = w.skySat ?? 1;   // (post: share of the sky saturation boost)
    this._hlev = app.params.num('hlev', 1);   // (inspection: horizon hold level scale)
    // a hazy, dusty Mediterranean summer afternoon: ~12x the aerosol of the clean
    // reference atmosphere, 2 km deep (optical depth ~0.1 above the city: a pale blue
    // sky, a milky horizon, deep blue only overhead), more on a hazy day; URL mie=
    // overrides it
    const alb = w.mieAlb || MIE_DEFAULT.alb, ka = app.params.num('miealb', 1);
    this.atmo = new Atmosphere(renderer, {
      mieScale: app.params.num('mie', w.mie), mieH: app.params.num('mieh', w.mieH || MIE_DEFAULT.h),
      mieAlb: alb.map((a) => Math.min(a * ka, 1)), mieG: app.params.num('mieg', w.mieG || MIE_DEFAULT.g),
      mieAng: app.params.num('mieang', w.mieAng ?? MIE_DEFAULT.ang),
      camAlt: app.params.num('alt', 0.35),
    });
    this.sky = new Sky(app, this.atmo, { envSize: q.envSize });
    scene.add(this.sky.mesh);
    this.clouds = new Clouds(renderer, this.sky.uniforms, { steps: q.cloudSteps });
    const su = this.sky.uniforms;
    su.uCloudCover.value = w.cover; su.uCloudScale.value = w.scale; su.uCloudTop.value = w.top;
    su.uCirrus.value = w.cirrus; su.uAltocu.value = w.altocu;
    scene.background = null;
    scene.fog = null;
    // (the capture's canyon model is a single straight street: it misses the open sky the
    // cross streets, lower roofs and the street's own bends let in, so the shade gets a
    // little more skylight than it sees)
    scene.environmentIntensity = 1.25;

    this.sun = new SunLight(0xffffff, 3);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    if (patched) {
      this.sun.shadow = new StreetSunShadow(q.cascades);
      // the chunks' static casters draw as one depth-only proxy per chunk
      this.batcher = new ShadowBatcher(app, this.sun.shadow);
      this.sun.shadow.batcher = this.batcher;
    }
    const sh = this.sun.shadow;
    // (the cascades sit side by side in one atlas row; inspection: URL shadowmap=<tile texels>)
    const ms = Math.min(app.params.num('shadowmap', q.mapSize), Math.floor(renderer.capabilities.maxTextureSize / q.cascades));
    sh.mapSize.set(ms, ms);
    // the atlas, made here rather than by the renderer: its colour attachment is never read
    // (the passes keep only depth), so it is a single 8-bit channel instead of RGBA (at 4096
    // texels a tile: 64 MB instead of 256 MB next to the 256 MB of depth)
    if (patched && !sh.map) {
      const W = ms * q.cascades, H = ms;
      const map = new THREE.WebGLRenderTarget(W, H, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      const dt = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
      dt.format = THREE.DepthFormat;
      dt.compareFunction = renderer.state.buffers.depth.getReversed() ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
      dt.minFilter = THREE.LinearFilter;
      dt.magFilter = THREE.LinearFilter;
      dt.name = 'sun.shadowMap';
      map.texture.name = 'sun.shadowMapColor';
      map.depthTexture = dt;
      sh.map = map;
    }
    sh.camera.near = 1;
    sh.camera.far = 700;
    sh.bias = patched ? -0.00002 : -0.0002;
    sh.normalBias = patched ? 1.2 : 0.05;
    // widest penumbra half-width (m): a cornice ~80 m up-sun (sun radius 0.27°, x1.5 filter)
    sh.radius = (patched ? 0.5 : 2) * (w.penumbra || 1);
    scene.add(this.sun);

    this.lights = new StreetLights(app, q.lamps);

    // street-canyon bounce: sunlit stone and paving relight everything around them (warm
    // fill in the shade, glowing soffits). A hemisphere light along the vertical: its sky
    // colour is the light reflected down by the sunlit facades, its ground colour the
    // light reflected up by the sunlit floor; facades get the mean of the two. The
    // environment map holds the sky and the canyon as seen from the camera; this adds the
    // interreflection a single capture point under-represents.
    this.bounce = new THREE.HemisphereLight(0x000000, 0x000000, 1);
    this.bounce.name = 'canyonBounce';
    this.bounce.position.set(0, 1, 0);
    scene.add(this.bounce);
    // and across the street: the sunlit facade relighting the one opposite (a horizontal
    // light from the sunlit side; dark when no facade is in the sun). Its source is a
    // whole facade, so the shared light loop gives it no specular (lights.js)
    this.crossBounce = new THREE.DirectionalLight(0x000000, 1);
    this.crossBounce.name = 'canyonCrossBounce';
    this.crossBounce.castShadow = false;
    scene.add(this.crossBounce, this.crossBounce.target);

    // avenue frame used to orient the sun path
    const ref = app.route.sample(app.layout.defaultStartS);
    this._avenueFwd = new THREE.Vector3(ref.tan.x, 0, ref.tan.z).normalize();
    this._avenueRight = new THREE.Vector3(ref.right.x, 0, ref.right.z).normalize();

    // wind (uWind is the horizontal direction the air moves towards)
    this.windBase = new THREE.Vector2(-0.55, 0.83).normalize();
    this.cloudSpeed = 9; // m/s at cloud level

    // without post-processing the renderer tone maps directly: drive its exposure
    this._noPost = !app.systems.post || app.params.skip.includes('post');

    this._lastHeading = null;
    this._gpuReady = false;
    this.sky.allocateEnv();
    this.setTimeOfDay(app.params.tod ?? 0.12);
    this._updateEnvFrame(true);
    // GPU set-up (LUTs, noise textures, the first environment capture) runs once its
    // programs have compiled in parallel, while the other modules start up; the first
    // frame completes it at the latest
    this._compileOffscreen([...this.atmo.passes(), ...this.sky.passes(), ...this.clouds.passes()], this.atmo.sky)
      .then(() => this._initGPU(), () => this._initGPU());

    // the depth passes' programs compile alongside the start-up compile: wait for the
    // streamed world to be primed (it is compiled right after), then submit them
    if (patched) {
      const t0 = performance.now();
      const poll = () => {
        if (this._shadowsCompiled) return;
        if (app.perf?.init?.prime !== undefined) this._precompileShadows();
        else if (performance.now() - t0 < 120000) setTimeout(poll, 25);
      };
      setTimeout(poll, 25);
    }
  },

  /** Compile off-scene passes on the driver's threads (resolves when they are ready). */
  _compileOffscreen(meshes, target) {
    const r = this.app.renderer, prev = r.getRenderTarget();
    const scene = new THREE.Scene();
    const parents = meshes.map((m) => m.parent);
    for (const m of meshes) scene.add(m);
    let done;
    try {
      r.setRenderTarget(target);
      done = r.compileAsync(scene, this.app.camera);
    } catch (e) {
      done = Promise.reject(e);
    } finally {
      meshes.forEach((m, i) => { scene.remove(m); if (parents[i]) parents[i].add(m); });
      r.setRenderTarget(prev);
    }
    return done;
  },

  /** One-time GPU work: fixed LUTs, noise textures, sky, irradiance, first environment map. */
  _initGPU() {
    if (this._gpuReady) return;
    this._gpuReady = true;
    this.atmo.renderLUTs();
    this.sky.initGPU();
    this.clouds.renderNoise();
    // the sky irradiance for every time of day, read back once (see Sky.buildIrradianceTable)
    const t0 = performance.now();
    const fwd = this._avenueFwd, right = this._avenueRight;
    this._hasIrrTable = !!(fwd && right) && this.sky.buildIrradianceTable((t, out) => sunDirection(t, fwd, right, out));
    if (this.app && this.app.perf) this.app.perf.irrTable = { ok: this._hasIrrTable, ms: Math.round(performance.now() - t0) };
    this.atmo.updateSky(this.state.sunDir);
    this.sky.updateIrradiance(false);
    if (this._hasIrrTable && this.sky.irradianceAt(this.state.t)) {
      this._irrDirty = false;
      this._updateExposure();
    } else {
      this._irrDirty = true;     // read back (asynchronously) on the next update
    }
    this.sky.requestEnv(true);
  },

  /** Submit the sun's depth-pass programs for compilation (once; see sunShadow.js). */
  _precompileShadows() {
    if (this._shadowsCompiled) return;
    this._shadowsCompiled = true;
    const app = this.app, t0 = performance.now();
    try {
      const target = app.renderer.getRenderTarget() || app.post?.hdrRT || null;
      const n = precompileShadowPrograms(app.renderer, app.scene, app.camera, target);
      if (app.perf) app.perf.shadowPrecompile = { casters: n, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      console.warn('[env] shadow precompile', e);
    }
  },

  /** t in [0,1]: 0 midday, 0.55 golden hour, 0.8 sunset, 1 dusk (civil twilight). */
  setTimeOfDay(t) {
    t = THREE.MathUtils.clamp(+t || 0, 0, 1);
    this.t = t;
    const app = this.app;
    if (!this.atmo) return; // not initialised yet
    const dir = sunDirection(t, this._avenueFwd, this._avenueRight, this.state.sunDir);
    const elev = Math.asin(dir.y);

    // sun colour from the atmosphere's transmittance
    const T = this.atmo.transmittance(dir, undefined, _v);
    const sunCol = new THREE.Color(SUN_TINT.r * T.x, SUN_TINT.g * T.y, SUN_TINT.b * T.z);
    const E = SUN_E0;
    // the city skyline beyond the modelled streets (and beyond the shadow range) hides
    // a sun within a few degrees of the horizon from street level; the sky and the
    // clouds still see it
    const skyline = THREE.MathUtils.smoothstep(elev / (Math.PI / 180), 0.0, 3.0);
    this.skyline = skyline;
    const Es = E * skyline;
    this.sunIlluminance = Es * (0.2126 * sunCol.r + 0.7152 * sunCol.g + 0.0722 * sunCol.b);
    this.sun.color.copy(sunCol);
    this.sun.intensity = Es;
    this.sun.position.copy(dir);
    // keep the light (a changing light count would recompile every material); once the
    // skyline hides the sun its light is zero and the shadow passes are skipped
    const up = Es > 1e-4;
    const sh = this.sun.shadow;
    // (the atlas must exist even when the sun is down: lit shaders sample it)
    if ((up && !sh.autoUpdate) || !sh.map || !this._atlasInit) { sh.needsUpdate = true; this._atlasInit = true; }
    sh.autoUpdate = up;
    U.uSunDir.value.copy(dir);
    U.uSunColor.value.setRGB(sunCol.r * Es, sunCol.g * Es, sunCol.b * Es);
    this.sky.uniforms.uSunGround.value.set(sunCol.r * E, sunCol.g * E, sunCol.b * E);
    const Tc = this.atmo.transmittance(dir, 2.0, _tc);
    this.sky.uniforms.uSunCloud.value.set(SUN_TINT.r * Tc.x * E, SUN_TINT.g * Tc.y * E, SUN_TINT.b * Tc.z * E);

    // sky-view LUT and irradiance texture (for the shaders); the CPU's copy of the
    // irradiance comes from the start-up table (without one it is read back by update(),
    // the calibrated CPU estimate standing in meanwhile)
    if (this._gpuReady) {
      this.atmo.updateSky(dir);
      this.sky.updateIrradiance(false);
    } else {
      this.atmo.uniforms.uSunDirA.value.copy(dir);
    }
    this._irrDirty = !(this._hasIrrTable && this.sky.irradianceAt(t));
    this._todStamp = (this._todStamp || 0) + 1;

    // night: lamps, shop fronts and windows come on around sunset (the street lamps are
    // fully on by the time the sun has set)
    const night = THREE.MathUtils.smoothstep(t, 0.7, 0.82);
    U.uNight.value = night;
    // the street lamps (real lights, lantern wash, far pools, airlight) follow the same
    // photocell ramp as the visible globes: on from t 0.64, fully by 0.72
    const lamps = lampLevel(t, night);

    Object.assign(this.state, { t, sunElevation: elev, night, lamps });
    this._updateExposure();
    this.solar = solarPosition(t);
    if (this._gpuReady) this.sky.requestEnv(false);
    app && app.events && app.events.emit('tod', { t });
  },

  /**
   * Exposure follows the horizontal illuminance with partial adaptation (a camera keeps
   * dusk darker and bluer than midday, and adapts even less once the light falls below
   * ~1000 lux). Sky irradiance comes from the GPU read-back; between read-backs the CPU
   * estimate is scaled to agree with the last one. update() caps it per frame so the
   * bright horizon at the end of the street stays below clipping at dusk.
   */
  _updateExposure() {
    const elev = this.state.sunElevation ?? Math.asin(this.state.sunDir.y);
    const est = skyIrradiance(elev);
    const irr = this.sky.irradiance;
    let Esky;
    if (irr && Number.isFinite(irr.horizontal.x) && !this._irrDirty) {
      Esky = lum(irr.horizontal);
      this._irrCal = Esky / Math.max(est, 1e-9);
    } else {
      Esky = est * (this._irrCal ?? 1);
    }
    this.skyIrradianceH = Esky;
    const Eh = Math.max(this.sunIlluminance * Math.max(this.state.sunDir.y, 0), 0) + Esky;
    this.Eh = Eh;
    // full adaptation to the incident light above EH_FULL (a 0.18 albedo exposed to 0.18
    // KDAY, so sunlit grey granite sits just above mid grey), partial below it, and less
    // still below ~1000 lux
    const EK = 0.03; // ~1000 lux
    const lnE = Math.log(KDAY * Math.PI / Math.max(Eh, EH_FULL)) + 0.7 * Math.log(EH_FULL / Math.min(Math.max(Eh, EK), EH_FULL))
      + 0.5 * Math.log(EK / Math.min(Math.max(Eh, 1e-7), EK));
    this.exposureBase = Math.exp(lnE) * Math.pow(2, expoLift(this.state.t ?? 0));
    // highlight protection for a low sun: whatever the metering does for the shaded
    // canyon, stone facing the sun (albedo ~0.55) stays on the shoulder, so the golden
    // light keeps its colour instead of clipping to cream (half-way in log terms: the
    // camera still exposes for the street, as the golden-hour photographs do)
    const sh = Math.max(this.state.sunDir.y, 0);
    const litStone = 0.55 * this.sunIlluminance * Math.sqrt(1 - sh * sh) / Math.PI;
    const w = THREE.MathUtils.smoothstep(this.state.t, 0.35, 0.55);
    this._litCap = litStone > 1e-6 ? Math.exp(THREE.MathUtils.lerp(Math.log(1e4), Math.log(LIT_STONE / litStone), 0.5 * w)) : 1e4;
    this._applyCaps();

    // illuminant for the white balance (horizontal surface in the open), and the direct
    // sun alone (a daylight preset balances on it)
    const sc = U.uSunColor.value, sy = Math.max(this.state.sunDir.y, 0);
    const sk = irr && !this._irrDirty ? irr.horizontal : null;
    if (sk) this.illuminant.set(sc.r * sy + sk.x, sc.g * sy + sk.y, sc.b * sy + sk.z);
    else this.illuminant.set(sc.r * sy + Esky * 0.6, sc.g * sy + Esky, sc.b * sy + Esky * 1.9);
    this.sunIlluminant.set(sc.r, sc.g, sc.b);
  },

  /**
   * Exposure ceiling (post applies it to the metered exposure) and the nominal exposure:
   * the low-sun highlight protection, and from sunset on the horizon slot down the street
   * held below the shoulder, so the afterglow keeps its colour however dark the canyon.
   */
  _applyCaps() {
    // from sunset on, a view-independent ceiling as well
    const ceil = logTable(DUSK_CEIL, this.state.t) * this.exposureBase;
    this.exposureMax = Math.min(this._litCap ?? 1e4, this._horizonCap(), ceil);
    this.exposure = Math.min(this.exposureBase, this.exposureMax);
    if (this._noPost && this.app) this.app.renderer.toneMappingExposure = this.exposure;
  },

  /** Highest exposure that keeps the horizon seen down the street at HORIZON_LEVEL. */
  _horizonCap() {
    const irr = this.sky.irradiance, cam = this.app && this.app.camera;
    if (!irr || !cam || !irr.horizonSun) return 1e4;
    const level = horizonLevel(this.state.t) * (this._hlev ?? 1);
    if (level >= 63.9) return 1e4;
    const d = this.state.sunDir;
    cam.getWorldDirection(_fwd);
    const h = Math.hypot(_fwd.x, _fwd.z), hs = Math.hypot(d.x, d.z);
    const c = h > 1e-4 && hs > 1e-4 ? (_fwd.x * d.x + _fwd.z * d.z) / (h * hs) : 0;
    const w = Math.pow(0.5 + 0.5 * c, 2);
    const slot = THREE.MathUtils.lerp(lum(irr.horizonAnti), lum(irr.horizonSun), w);
    return level / Math.max(slot, 1e-9);
  },

  /**
   * Street haze inputs: the mean radiance the street-level air sees (half sky slot and
   * facades above, half paving below), and the canyon's shadow plane: air at height z,
   * x metres from the sun-side facade line, is sunlit when z + k x > cornice height.
   */
  _updateHaze(app) {
    const u = this.sky.uniforms, d = this.state.sunDir, hz = this.haze;
    const irr = this.sky.irradiance;
    const sc = U.uSunColor.value, Es = _es.set(sc.r, sc.g, sc.b);
    const Esky = this.skyIrradianceH ?? skyIrradiance(this.state.sunElevation);
    const skyH = irr ? irr.horizontal : _v.set(Esky * 0.6, Esky, Esky * 1.9);
    const skyV = irr ? irr.vertical : skyH;
    const R = u.uStreetRight.value, hw = u.uHalfW.value, H = u.uBldH.value;
    const h = Math.hypot(d.x, d.z);
    const across = h > 1e-4 ? (d.x * R.x + d.z * R.z) / h : 0;
    const facing = Math.max(Math.abs(across), 1e-3);
    const tanSun = d.y / Math.max(h, 1e-3);
    const sunUp = THREE.MathUtils.smoothstep(d.y, -0.02, 0.03);
    const zSh = H - (2 * hw / facing) * tanSun;
    const litWall = sunUp * THREE.MathUtils.clamp((H - Math.max(zSh, 0)) / H, 0, 1);
    const floorLit = sunUp * THREE.MathUtils.clamp(1 - (H * facing / Math.max(tanSun, 1e-3)) / (2 * hw), 0, 1);
    const sy = Math.max(d.y, 0), cw = facing * h;
    const c = XYZ;
    for (let i = 0; i < 3; i++) {
      const k = c[i];
      const sky = skyH[k] / Math.PI;
      const wall = WALL_ALB[i] * (skyV[k] + 0.5 * Es[k] * cw * litWall) / Math.PI;
      const ground = GROUND_ALB[i] * (skyH[k] * 0.62 + Es[k] * sy * floorLit) / Math.PI;
      hz.amb.setComponent(i, 0.5 * (0.45 * sky + 0.55 * wall) + 0.5 * ground);
    }
    // dust scatters nearly greyly and the canyon light it sees is warm: by day the
    // in-scatter source leans to a pale warm grey of the same luminance
    const La = lum(hz.amb);
    hz.amb.lerp(_es2.set(La * 1.07, La, La * 0.88), 0.2 * sunUp);
    // canyon bounce: mean irradiance of the sun-facing facade and of the floor, reflected
    // with the stone and paving albedo through the view factors of a ~1:1 street canyon
    const bu = this.bounce, cb = this.crossBounce;
    if (bu) {
      const up = _up, dn = _dn, cr = _cr;
      for (let i = 0; i < 3; i++) {
        const k = c[i];
        const Ew = Es[k] * cw * litWall, Ef = Es[k] * sy * floorLit;
        up[i] = BOUNCE.up * WALL_ALB[i] * Ew;
        dn[i] = BOUNCE.down * GROUND_ALB[i] * Ef;
        cr[i] = BOUNCE.cross * WALL_ALB[i] * Ew;
      }
      bu.color.setRGB(up[0], up[1], up[2]);
      bu.groundColor.setRGB(dn[0], dn[1], dn[2]);
      if (cb) {
        // the sun-facing facade is the one whose normal points towards the sun's side:
        // its light travels away from it, across the street
        const side = across >= 0 ? 1 : -1;
        cb.color.setRGB(cr[0], cr[1], cr[2]);
        const cp = app.camera.position;
        cb.position.set(cp.x - side * R.x, cp.y, cp.z - side * R.z);
        cb.target.position.copy(cp);
        cb.target.updateMatrixWorld();
        cb.updateMatrixWorld();
      }
    }
    // shadow plane in world space: f(p) = dot(p, n) + w
    if (d.y > 0.002) {
      const side = across >= 0 ? 1 : -1;
      const k = Math.min(tanSun / facing, 50);
      const s = app.cameraS ?? app.startS;
      const O = app.route.sample(s, _smpH).pos;
      const dO = O.x * R.x + O.z * R.z;
      hz.plane.set(-k * side * R.x, 1, -k * side * R.z, -O.y + k * hw + k * side * dO - H);
    } else {
      hz.plane.set(0, 0, 0, -1);
    }
    hz.gap = 0.08 * sunUp;
    hz.sun = this.skyline ?? 1;
  },

  /** Orient the canyon model of the environment map to the street at the camera. */
  _updateEnvFrame(force) {
    const app = this.app;
    const s = app.cameraS ?? app.startS;
    const smp = app.route.sample(s, _smpE);
    const u = this.sky.uniforms;
    u.uStreetAxis.value.set(smp.tan.x, 0, smp.tan.z).normalize();
    u.uStreetRight.value.set(smp.right.x, 0, smp.right.z).normalize();
    u.uHalfW.value = 0.5 * (app.layout.halfWidth(s, 1) + app.layout.halfWidth(s, -1));
    u.uCamD.value = TRACK_OFFSET;
    const h = Math.atan2(smp.tan.x, smp.tan.z);
    if (force) this._lastHeading = h;
    return h;
  },

  update(dt, app) {
    // (wall-clock step; never negative: the first frame after a long load can bring one,
    // which would hold the environment refresh back)
    const rd = app.realDt ?? dt, realDt = rd > 0 ? rd : 0;
    const time = app.time;
    if (!this._gpuReady) this._initGPU();
    if (!this._shadowsCompiled && this.batcher) this._precompileShadows();

    // (without the irradiance table) sky-irradiance read-back: a pixel-pack buffer behind
    // a fence whose status is polled here once a frame. While the time of day keeps
    // changing (the slider, a sweep) the reads follow one another, each recalibrating the
    // CPU estimate at the sun elevation it was taken for, so the exposure tracks the sky
    // within a frame or two instead of jumping once the change stops
    if (this._irrReading) {
      const st = this.sky.pollIrradiance();
      if (st !== 0) {
        this._irrReading = false;
        if (st > 0) {
          if (this._irrStamp === this._todStamp) this._irrDirty = false;
          else {
            const est = skyIrradiance(this._irrElev), H = this.sky.irradiance && this.sky.irradiance.horizontal;
            if (H && est > 1e-9 && Number.isFinite(H.y)) this._irrCal = lum(H) / est;
          }
          this._updateExposure();
        }
      }
    } else if (this._irrDirty) {
      this._irrStamp = this._todStamp;
      this._irrElev = this.state.sunElevation;
      this._irrReading = this.sky.beginIrradianceRead();
      // (read synchronously instead: the values are in place)
      if (!this._irrReading) { this._irrDirty = false; this._updateExposure(); }
    }

    // ---- wind: slowly veering direction, gusty strength (deterministic in time)
    const veer = noise1(time * 0.013, 41) * 0.35;
    const c = Math.cos(veer), s = Math.sin(veer);
    U.uWind.value.set(this.windBase.x * c - this.windBase.y * s, this.windBase.x * s + this.windBase.y * c);
    const gust = 0.5 + 0.5 * noise1(time * 0.21, 7) * 0.7 + 0.3 * noise1(time * 0.9, 13) * 0.4;
    U.uWindStrength.value = THREE.MathUtils.clamp(0.22 + 0.28 * gust, 0.05, 1);

    // ---- clouds drift with the wind (upper winds a bit veered)
    const su = this.sky.uniforms;
    su.uWindDir.value.copy(U.uWind.value);
    su.uCloudOffset.value.addScaledVector(U.uWind.value, -this.cloudSpeed * dt);
    su.uCirrusOffset.value.addScaledVector(U.uWind.value, -this.cloudSpeed * 2.2 * dt);
    su.uCamPosW.value.copy(app.camera.position);
    su.uPixelAngle.value = THREE.MathUtils.degToRad(app.camera.fov) / Math.max(app.renderer.domElement.height, 1);

    // ---- sun light follows the camera (cascades are fitted by the shadow itself)
    app.camera.updateMatrixWorld();
    if (this.sun.shadow.isStreetSunShadow) this.sun.shadow.groundY = app.route.elevation(app.cameraS ?? app.startS);
    if (this.batcher) this.batcher.update();
    this.sun.position.copy(this.state.sunDir);
    this.sun.updateMatrixWorld();

    // ---- environment map: progressive refresh (clouds move; street orientation changes)
    const h = this._updateEnvFrame(false);
    let dh = Math.abs(h - (this._lastHeading ?? h));
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    if (dh > 0.12 && this.sky._capStep < 0) { this._lastHeading = h; this.sky.requestEnv(false); }
    const prof = app.post?.prof;
    if (prof) prof.begin('envmap');
    this.sky.step(realDt, 8);
    if (prof) prof.end();

    // ---- street haze inputs and the per-frame exposure (horizon cap follows the view)
    this._updateHaze(app);
    this._applyCaps();

    // ---- dusk lights
    this.lights.update(app, U.uNight.value, this.state.lamps ?? U.uNight.value);
  },

  /** Off-scene passes env renders itself (post compiles them up front with its own). */
  passes() {
    const out = [];
    if (this.clouds) out.push(this.clouds.quad, this.clouds.resolveQuad);
    if (this.sky && this.sky._copyQuad) out.push(this.sky._copyQuad);
    return out;
  },

  /** Horizontal illuminance (scene units) in the open for the current time of day. */
  get illuminance() {
    return this.sunIlluminance * Math.max(this.state.sunDir.y, 0) + (this.skyIrradianceH ?? skyIrradiance(this.state.sunElevation));
  },
  LUX_PER_UNIT,
};

export default env;
