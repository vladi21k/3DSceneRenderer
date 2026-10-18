import * as THREE from 'three';
import { params } from './core/params.js';
import { U } from './core/uniforms.js';
import { Events } from './core/events.js';
import { DEFAULT_VFOV, EYE_HEIGHT, TRACK_OFFSET, LOD0_DIST } from './core/config.js';
import { Route } from './world/route.js';
import { Layout } from './world/layout.js';
import { World } from './world/streaming.js';
import { GpuTimer } from './core/gpuTimer.js';
import { FrameMonitor } from './core/frameMonitor.js';
import farfield from './core/farfield.js';

// Module registry. Each module is loaded with a dynamic import so a broken module is
// reported and skipped instead of taking the whole app down. Contracts: docs/ARCHITECTURE.md
const MODULES = [
  ['materials', './materials/materials.js'],
  ['env', './env/env.js'],
  ['post', './env/post.js'],
  ['street', './world/street.js'],
  ['buildings', './world/buildings.js'],
  ['facades', './world/facades.js'],
  ['ironwork', './world/ironwork.js'],
  ['vegetation', './world/vegetation.js'],
  ['catenary', './world/catenary.js'],
  ['furniture', './world/furniture.js'],
  ['trams', './ride/trams.js'],
  ['humans', './crowd/humans.js'],
  ['crowd', './crowd/crowd.js'],
  ['train', './ride/train.js'],
  ['cameraRig', './ride/cameraRig.js'],
  ['ui', './ride/ui.js'],
  ['audio', './ride/audio.js'],
];
const CORE = new Set(['materials', 'env', 'train', 'cameraRig']);

const loadingEl = document.getElementById('loading');
const barEl = document.getElementById('loading-bar');
const setProgress = (f) => { if (barEl) barEl.style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`; };

function fatal(msg, e) {
  console.error(msg, e);
  window.__fatal = String(msg) + (e ? `: ${e.stack || e}` : '');
}

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, params.quality === 'low' ? 1 : 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // Synchronous GL queries stall the pipeline: only check shader logs when debugging, and seed
  // three's pixel-store cache so partial texture uploads never read UNPACK_* back from the driver.
  renderer.debug.checkShaderErrors = params.debug;
  {
    const gl = renderer.getContext();
    for (const p of [gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS, gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_IMAGES]) renderer.state.pixelStorei(p, 0);
    if (params.str('glbox', '1') !== '0') unboxedUniforms(gl);
  }
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(params.fov ?? DEFAULT_VFOV, window.innerWidth / window.innerHeight, 0.3, 2500);
  scene.add(camera);

  const route = new Route();
  const layout = new Layout(route, params.seed);
  const events = new Events();

  const app = {
    THREE, renderer, scene, camera, canvas, params, U, events, route, layout,
    systems: {}, time: 0, dt: 0, frame: 0, ready: false, touchPrograms: (r) => touchPrograms(r),
    startS: params.s ?? layout.defaultStartS,
    gpuTimer: new GpuTimer(renderer),
    perf: { fps: 0, frameMs: 0, cpuMs: 0, gpuMs: 0 },
  };
  window.__app = app;

  // ---- load modules
  const enabled = MODULES.filter(([name]) => (!params.only || params.only.includes(name) || CORE.has(name) || name === 'post' && params.only.includes('post')) && !params.skip.includes(name));
  // a busy static server can drop a request: retry each failed import once with a fresh URL
  const load = (path) => import(path).catch(() => new Promise((r) => setTimeout(r, 250)).then(() => import(`${path}?retry=1`)));
  const loaded = await Promise.allSettled(enabled.map(([, path]) => load(path)));
  const mods = [];
  loaded.forEach((r, i) => {
    const [name] = enabled[i];
    if (r.status === 'fulfilled' && r.value.default) {
      const m = r.value.default;
      m.name = m.name || name;
      mods.push(m);
      app.systems[m.name] = m;
    } else {
      console.error(`[main] module ${name} failed to load`, r.reason);
    }
  });
  // the far field (core): the city beyond the streamed range, after every module's init
  const farOn = (!params.only || params.only.includes('farfield')) && !params.skip.includes('farfield');
  if (farOn) { mods.push(farfield); app.systems.farfield = farfield; }
  Object.assign(app, {
    materials: app.systems.materials, env: app.systems.env, post: app.systems.post,
    train: app.systems.train, cameraRig: app.systems.cameraRig, crowd: app.systems.crowd,
    humans: app.systems.humans, audio: app.systems.audio, ui: app.systems.ui, trams: app.systems.trams,
  });
  setProgress(0.05);

  // ---- init (sequential: materials and env first, in registry order)
  app.perf.init = {};
  const tStart = performance.now();
  for (const m of mods) {
    if (!m.init) continue;
    const t0 = performance.now();
    try {
      await m.init(app);
      app.perf.init[m.name] = Math.round(performance.now() - t0);
    } catch (e) {
      console.error(`[main] ${m.name}.init failed — module disabled`, e);
      m.disabled = true;
    }
  }
  if (!app.materials || app.materials.disabled) { fatal('materials module unavailable'); return; }
  setProgress(0.2);

  // ---- world streaming
  const builders = mods.filter((m) => m.build && !m.disabled);
  app.world = new World(app, builders);
  const s0 = app.startS;
  placeCamera(app, s0);
  app.perf.init.modulesTotal = Math.round(performance.now() - tStart);
  const tPrime = performance.now();
  await app.world.prime(s0, Math.min(LOD0_DIST, 240), (f) => setProgress(0.2 + 0.7 * f));
  await app.world.prime(s0, Infinity, null, [2]);   // far field: a few ms in all
  app.perf.init.prime = Math.round(performance.now() - tPrime);

  // warm up shaders
  // compile every program up front, in parallel on the driver's threads where supported
  // (KHR_parallel_shader_compile), instead of stalling the first frames one program at a time
  const tCompile = performance.now();
  // Programs depend on the output target (colour space, tone mapping): compile against the
  // HDR scene target the post chain renders into, not the screen.
  try {
    const rt = app.post && !app.post.disabled ? app.post.sceneRT : null;
    renderer.setRenderTarget(rt || null);
    await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 20000))]);
    renderer.setRenderTarget(null);
  } catch (e) { console.warn('compile', e); }
  touchPrograms(renderer);   // pay each program's first-use cost now, behind the loading bar
  app.perf.init.compile = Math.round(performance.now() - tCompile);
  setProgress(1);

  // ---- loop
  const timer = new THREE.Timer();
  timer.connect(document);
  let fpsAcc = 0, fpsN = 0, fpsT = 0;
  const updaters = mods.filter((m) => m.update && !m.disabled);
  const order = ['train', 'cameraRig'];
  updaters.sort((a, b) => (order.includes(b.name) ? 1 : 0) - (order.includes(a.name) ? 1 : 0) || order.indexOf(a.name) - order.indexOf(b.name));

  // frame-time monitor: stats().frames percentiles and the hitch log (app.hitches(),
  // app.hitchReport(), app.resetFrames()), with stage times per module, world and render
  const mon = new FrameMonitor(app, [...updaters.map((m) => m.name), 'world', 'render']);
  const iWorld = updaters.length, iRender = updaters.length + 1;
  Object.assign(app, { monitor: mon, hitches: () => mon.hitches(), hitchReport: () => mon.report(), resetFrames: () => mon.reset() });
  {
    // CPU time of the shadow passes inside render (wraps any module's own hook)
    // (fixed arity, not rest parameters: no argument array per call)
    const sm = renderer.shadowMap, smRender = sm.render;
    sm.render = function (lights, scene, camera) {
      const t = performance.now();
      try { return smRender.call(this, lights, scene, camera); } finally { mon.shadowMs += performance.now() - t; }
    };
  }

  function frame(ts) {
    const t0 = performance.now();
    mon.begin(t0);
    timer.update(ts);
    const realDt = Math.min(timer.getDelta(), 0.1);
    const dt = params.freeze ? 0 : realDt;
    app.dt = dt; app.realDt = realDt; app.time += dt; app.frame++;
    U.uTime.value = app.time;

    for (let i = 0; i < updaters.length; i++) {
      const m = updaters[i];
      if (m.disabled) continue;
      const tu = performance.now();
      try { m.update(dt, app); } catch (e) {
        console.error(`[main] ${m.name}.update failed`, e);
        m.updateErrors = (m.updateErrors || 0) + 1;
        if (m.updateErrors > 5) { m.disabled = true; console.error(`[main] ${m.name} disabled`); }
      }
      if (m.name === 'cameraRig') applyInspectionView(app);
      mon.st[i] = performance.now() - tu;
    }
    if (!app.cameraRig || app.cameraRig.disabled) { placeCamera(app, app.train?.s ?? app.startS); applyInspectionView(app); }
    camera.updateMatrixWorld();
    U.uCameraPos.value.copy(camera.position);
    const tw = performance.now();
    app.world.update(app.cameraS ?? app.train?.s ?? app.startS);
    const tr = performance.now();
    mon.st[iWorld] = tr - tw;

    mon.renderBegin();
    app.gpuTimer.begin(app.frame);
    if (app.post && !app.post.disabled && app.post.render) {
      try { app.post.render(realDt, app); } catch (e) { console.error('[main] post.render failed — falling back', e); app.post.disabled = true; }
    } else {
      renderer.render(scene, camera);
    }
    app.gpuTimer.end();
    mon.renderEnd();

    const cpu = performance.now() - t0;
    mon.st[iRender] = performance.now() - tr;
    mon.end(cpu);
    if (app.frame <= 40) (app.perf.startFrames ||= []).push([Math.round(t0), Math.round(cpu), renderer.info.programs?.length ?? 0]);
    fpsAcc += realDt; fpsN++; fpsT += cpu;
    if (fpsAcc > 0.5) {
      app.perf.fps = fpsN / fpsAcc; app.perf.frameMs = (fpsAcc / fpsN) * 1000; app.perf.cpuMs = fpsT / fpsN;
      fpsAcc = 0; fpsN = 0; fpsT = 0;
    }
    if (app.gpuTimer.ext) app.perf.gpuMs = app.gpuTimer.ms;

    if (!app.ready && app.frame > 3 && app.world.readyAround(app.cameraS ?? s0, 160)) {
      app.ready = true;
      app.world.staged = true;   // from now on chunks are compiled in the background and revealed gradually
      app.perf.init.firstReady = Math.round(performance.now());
      if (loadingEl) loadingEl.classList.add('done');
      events.emit('ready', {});
      setTimeout(() => { window.__ready = true; }, 300);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (app.post && app.post.setSize) app.post.setSize(window.innerWidth, window.innerHeight);
  });

  app.stats = () => ({
    fps: +app.perf.fps.toFixed(1), frameMs: +app.perf.frameMs.toFixed(2), cpuMs: +app.perf.cpuMs.toFixed(2), gpuMs: +app.perf.gpuMs.toFixed(2),
    calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length,
    chunks: app.world.chunks.size, queue: app.world.stats.queue, buildMsByModule: app.world.stats.buildMsByModule, rideBuild: app.world.rideBuildStats(),
    s: +(app.cameraS ?? 0).toFixed(1), speedKmh: +((app.train?.speed ?? 0) * 3.6).toFixed(1),
    frames: mon.frames(), hitches: mon.count,
    modules: mods.map((m) => m.name + (m.disabled ? '(disabled)' : '')).join(','),
  });
}

/**
 * Scalar uniform uploads without garbage. Every frame three uploads a few thousand vector
 * uniforms (the lights move in view space with the camera, once per program), and a call
 * into the browser with float arguments boxes each of them: about a tenth of all the
 * app's garbage. The scalar forms are routed through the vector forms with one reused
 * typed array, which the GL treats identically (url glbox=0 turns this off for A/B).
 */
function unboxedUniforms(gl) {
  const f1 = gl.uniform1fv.bind(gl), f2 = gl.uniform2fv.bind(gl), f3 = gl.uniform3fv.bind(gl), f4 = gl.uniform4fv.bind(gl);
  const b1 = new Float32Array(1), b2 = new Float32Array(2), b3 = new Float32Array(3), b4 = new Float32Array(4);
  gl.uniform1f = function (loc, x) { b1[0] = x; f1(loc, b1); };
  gl.uniform2f = function (loc, x, y) { b2[0] = x; b2[1] = y; f2(loc, b2); };
  gl.uniform3f = function (loc, x, y, z) { b3[0] = x; b3[1] = y; b3[2] = z; f3(loc, b3); };
  gl.uniform4f = function (loc, x, y, z, w) { b4[0] = x; b4[1] = y; b4[2] = z; b4[3] = w; f4(loc, b4); };
}

/** Resolve uniforms/attributes of every linked program so first use never stalls a frame. */
export function touchPrograms(renderer) {
  for (const p of renderer.info.programs || []) {
    if (p.__touched) continue;
    try { p.getUniforms(); p.getAttributes(); p.__touched = true; } catch (e) { /* not linked yet */ }
  }
}

const _p = new THREE.Vector3(), _t = new THREE.Vector3();

/** Fallback / initial camera: on the ride track at s, looking along the route. */
function placeCamera(app, s) {
  const { route, camera } = app;
  const p = route.toWorld(s, TRACK_OFFSET, EYE_HEIGHT, _p);
  const t = route.toWorld(s + 60, TRACK_OFFSET, EYE_HEIGHT * 0.9, _t);
  camera.position.copy(p);
  camera.lookAt(t);
  app.cameraS = s;
}

/** view=s,d,h,yaw,pitch : free inspection camera in route coordinates (degrees, yaw + = left). */
function applyInspectionView(app) {
  const v = app.params.view;
  if (!v) return;
  const s = v[0], d = v[1] ?? TRACK_OFFSET, h = v[2] ?? EYE_HEIGHT, yaw = v[3] ?? 0, pitch = v[4] ?? 0;
  const { route, camera } = app;
  const p = route.toWorld(s, d, h, _p);
  const th = route.heading(s) + (yaw * Math.PI) / 180;
  const pr = (pitch * Math.PI) / 180;
  camera.position.copy(p);
  camera.up.set(0, 1, 0);
  camera.lookAt(_t.set(p.x + Math.cos(th) * Math.cos(pr), p.y + Math.sin(pr), p.z - Math.sin(th) * Math.cos(pr)));
  app.cameraS = s;
}

main().catch((e) => fatal('startup failed', e));
