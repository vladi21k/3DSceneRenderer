import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { U } from '../core/uniforms.js';
import { noise1 } from '../core/rng.js';
import { Atmosphere, SUN_E0, SUN_TINT, LUX_PER_UNIT } from './atmosphere.js';
import { Sky } from './sky.js';
import { StreetSunShadow, patchSunShadowChunk } from './sunShadow.js';
import { sunDirection, solarPosition } from './sunPath.js';
import { StreetLights } from './lights.js';

// Environment: physically based sky and sun, cascaded sun shadows, HDR image-based
// lighting, wind, time of day and the dusk lights. Contract in docs/ARCHITECTURE.md.
//
// Units: 1.0 = 33,000 lux / 33,000 cd/m² (see atmosphere.js). Midday sun ≈ 3, a
// sunlit limestone wall ≈ 0.3–0.5, the blue sky ≈ 0.2–0.4, a lamp globe ≈ 0.3.
// Emissive materials should use these units (lit shop window ≈ 0.01–0.03).

const QUALITY = {
  low: { cascades: 3, mapSize: 1024, taps: 6, lamps: 4, envSize: 128 },
  med: { cascades: 4, mapSize: 2048, taps: 8, lamps: 6, envSize: 192 },
  high: { cascades: 5, mapSize: 2048, taps: 10, lamps: 8, envSize: 256 },
};

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

/** Sky irradiance on a horizontal surface (scene units), clear sky, sun elevation e (rad). */
function skyIrradiance(e) {
  const deg = e / (Math.PI / 180);
  if (deg >= 0) return 0.012 + 0.55 * Math.pow(Math.sin(e), 0.7);
  return 0.012 * Math.pow(10, 0.347 * Math.max(deg, -12));
}

const env = {
  name: 'env',
  state: { t: 0, sunDir: new THREE.Vector3(0, 1, 0), sunElevation: 1, night: 0 },
  exposure: 1,

  async init(app) {
    this.app = app;
    const q = QUALITY[app.params.quality] || QUALITY.high;
    this.q = q;
    const { renderer, scene } = app;

    // shadows: built-in sun light with our cascade layout (patch before anything compiles)
    const patched = patchSunShadowChunk(q.cascades, q.taps);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    this.atmo = new Atmosphere(renderer, { mieScale: 2.4 });
    this.sky = new Sky(app, this.atmo, { envSize: q.envSize });
    scene.add(this.sky.mesh);
    scene.background = null;
    scene.fog = null;
    scene.environmentIntensity = 1.0;

    this.sun = new SunLight(0xffffff, 3);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    if (patched) this.sun.shadow = new StreetSunShadow(q.cascades);
    const sh = this.sun.shadow;
    sh.mapSize.set(q.mapSize, q.mapSize);
    sh.camera.near = 1;
    sh.camera.far = 700;
    sh.bias = patched ? -0.00002 : -0.0002;
    sh.normalBias = patched ? 1.2 : 0.05;
    sh.radius = patched ? 0.075 : 2;
    scene.add(this.sun);

    this.lights = new StreetLights(app, q.lamps);

    // avenue frame used to orient the sun path
    const ref = app.route.sample(app.layout.defaultStartS);
    this._avenueFwd = new THREE.Vector3(ref.tan.x, 0, ref.tan.z).normalize();
    this._avenueRight = new THREE.Vector3(ref.right.x, 0, ref.right.z).normalize();

    // wind (uWind is the horizontal direction the air moves towards)
    this.windBase = new THREE.Vector2(-0.55, 0.83).normalize();
    this.cloudSpeed = 9; // m/s at cloud level

    // without post-processing the renderer tone maps directly: give it fog and exposure
    this._noPost = !app.systems.post || app.params.skip.includes('post');

    this._lastHeading = null;
    this._lastEnvPos = new THREE.Vector3(1e9, 0, 0);
    this.setTimeOfDay(app.params.tod ?? 0.12);
    this._updateEnvFrame(true);
    this.sky.requestEnv(true);
  },

  /** t in [0,1]: 0 midday, 0.55 golden hour, 0.8 sunset, 1 dusk (civil twilight). */
  setTimeOfDay(t) {
    t = THREE.MathUtils.clamp(+t || 0, 0, 1);
    this.t = t;
    const app = this.app;
    const dir = sunDirection(t, this._avenueFwd || _fwd.set(0, 0, -1), this._avenueRight || _right.set(1, 0, 0), this.state.sunDir);
    const elev = Math.asin(dir.y);

    // sun colour from the atmosphere's transmittance
    const T = this.atmo.transmittance(dir, undefined, _v);
    const sunCol = new THREE.Color(SUN_TINT.r * T.x, SUN_TINT.g * T.y, SUN_TINT.b * T.z);
    const E = SUN_E0;
    this.sunIlluminance = E * (0.2126 * sunCol.r + 0.7152 * sunCol.g + 0.0722 * sunCol.b);
    this.sun.color.copy(sunCol);
    this.sun.intensity = E;
    this.sun.position.copy(dir);
    this.sun.visible = dir.y > -0.03;
    U.uSunDir.value.copy(dir);
    U.uSunColor.value.setRGB(sunCol.r * E, sunCol.g * E, sunCol.b * E);
    this.sky.uniforms.uSunGround.value.set(sunCol.r * E, sunCol.g * E, sunCol.b * E);

    this.atmo.updateSky(dir);
    this.sky.updateIrradiance();

    // night: lamps, shop fronts and windows come on around sunset
    const night = THREE.MathUtils.smoothstep(t, 0.72, 0.86);
    U.uNight.value = night;

    // exposure follows the horizontal illuminance with partial adaptation (a camera
    // keeps dusk darker and bluer than midday)
    const Eh = Math.max(this.sunIlluminance * Math.max(dir.y, 0), 0) + skyIrradiance(elev);
    const Eref = 3.1;
    this.exposure = 1.15 * Math.pow(Eref / Math.max(Eh, 1e-6), 0.74);
    if (this._noPost && app) {
      app.renderer.toneMappingExposure = this.exposure;
    }

    Object.assign(this.state, { t, sunElevation: elev, night });
    this.state.sunDir = dir;
    this.solar = solarPosition(t);
    if (this.sky.envRT) this.sky.requestEnv(false);
    app && app.events && app.events.emit('tod', { t });
  },

  /** Orient the canyon model of the environment map to the street at the camera. */
  _updateEnvFrame(force) {
    const app = this.app;
    const s = app.cameraS ?? app.startS;
    const smp = app.route.sample(s);
    const u = this.sky.uniforms;
    u.uStreetAxis.value.set(smp.tan.x, 0, smp.tan.z).normalize();
    u.uStreetRight.value.set(smp.right.x, 0, smp.right.z).normalize();
    u.uHalfW.value = 0.5 * (app.layout.halfWidth(s, 1) + app.layout.halfWidth(s, -1));
    u.uCamD.value = 1.6;
    const h = Math.atan2(smp.tan.x, smp.tan.z);
    if (force) this._lastHeading = h;
    return h;
  },

  update(dt, app) {
    const realDt = app.realDt ?? dt;
    const time = app.time;

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

    // ---- sun light follows the camera (cascades are fitted by the shadow itself)
    app.camera.updateMatrixWorld();
    this.sun.position.copy(this.state.sunDir);
    this.sun.updateMatrixWorld();

    // ---- environment map: progressive refresh (clouds move; street orientation changes)
    const h = this._updateEnvFrame(false);
    let dh = Math.abs(h - (this._lastHeading ?? h));
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    if (dh > 0.12 && this.sky._capStep < 0) { this._lastHeading = h; this.sky.requestEnv(false); }
    this.sky.step(realDt, 8);

    // ---- dusk lights
    this.lights.update(app, U.uNight.value);
  },

  /** Horizontal illuminance estimate (scene units) for the current time of day. */
  get illuminance() {
    return this.sunIlluminance * Math.max(this.state.sunDir.y, 0) + skyIrradiance(this.state.sunElevation);
  },
  LUX_PER_UNIT,
};

export default env;
