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
import { loopSpotLights } from './core/lightLoops.js';
import { unboxedUniforms, sortRenderLists, typedUniforms } from './core/rendererPatches.js';

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
  // Enable now the extensions three asks for on first use: getExtension is a synchronous
  // call into the GPU process, and asked in the middle of the start-up compile (the first
  // BatchedMesh asks for multi-draw) it waited seconds for every program queued before it.
  for (const name of ['KHR_parallel_shader_compile', 'WEBGL_multi_draw', 'EXT_texture_filter_anisotropic', 'EXT_color_buffer_half_float',
    'EXT_clip_control', 'EXT_texture_norm16', 'WEBGL_clip_cull_distance', 'OES_texture_float_linear']) renderer.extensions.has(name);
  // render lists sorted without garbage (core/rendererPatches.js; glsort=0 for A/B)
  const listSort = params.str('glsort', '1') !== '0' && sortRenderLists(renderer);
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
    perf: { fps: 0, frameMs: 0, cpuMs: 0, gpuMs: 0, listSort, typedUniforms: 0 },
  };
  window.__app = app;

  // ---- load modules
  const enabled = MODULES.filter(([name]) => (!params.only || params.only.includes(name) || CORE.has(name) || name === 'post' && params.only.includes('post')) && !params.skip.includes(name));
  // a busy static server can drop a request: retry each failed import once with a fresh URL
  const load = (path) => import(path).catch(() => new Promise((r) => setTimeout(r, 250)).then(() => import(`${path}?retry=1`)));
  const loaded = await Promise.allSettled(enabled.map(([, path]) => load(path)));
  // start-up phases (ms): imports (since navigation), each init, modulesTotal (all inits),
  // prime (all chunk builds), compileStart (since navigation, when the first programs were
  // queued), programsQueued (how many then), compile (until every program was linked; it
  // overlaps the later inits), compileWait (the part of it after the last init and build),
  // programs, firstFrame (from then to the first frame callback), frames (to the view being
  // ready) and firstReady (since navigation)
  app.perf.init = { imports: Math.round(performance.now()) };
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

  // ---- start-up. Chrome compiles the programs one after another in its GPU process, and
  // that is the longest part of the start-up (some 9 s for 130 programs), so it starts as
  // early as the programs can be known and runs while the main thread carries on
  // (KHR_parallel_shader_compile: compileAsync only queues them):
  //   1. the world modules (src/world/*, after materials, env and post) init in registry order;
  //   2. their parts of the chunks around the start are built, and the programs of everything
  //      in the scene so far are queued;
  //   3. the other modules (trams, humans, crowd, train, cameraRig, ui, audio, the far field)
  //      init meanwhile: their inits must make no synchronous GL calls (a first draw,
  //      getUniforms, readPixels, getExtension), each would wait for the whole queue;
  //   4. their chunk parts (humans' parked bicycles) and the far field are built, their
  //      programs queued, and the start-up waits for every program.
  // Programs depend on the output target (colour space, tone mapping): from post's init on,
  // start-up work renders into the HDR scene target the post chain uses, so the queued
  // programs (and a module's own renderer.compile warm-up) are the ones the scene pass draws
  // with, not variants for the screen. (Passes that render elsewhere set their own target.)
  const WORLD = new Set(MODULES.filter(([, path]) => path.startsWith('./world/')).map(([name]) => name));
  let split = -1;   // the last module of step 1
  mods.forEach((m, i) => { if (WORLD.has(m.name) || m.name === 'materials' || m.name === 'env' || m.name === 'post') split = i; });
  const initModule = async (m) => {
    if (!m.init) return;
    const t0 = performance.now();
    try {
      await m.init(app);
      // (env has patched the shared light loop: keep its spot lights a real loop, which
      // compiles in about 60 % of the time; lightloop=0 for A/B, see core/lightLoops.js)
      if (m.name === 'env' && params.str('lightloop', '1') !== '0') app.perf.lightLoop = loopSpotLights(THREE.ShaderChunk);
      if (m.name === 'post' && app.post && app.post.sceneRT) renderer.setRenderTarget(app.post.sceneRT);
      app.perf.init[m.name] = Math.round(performance.now() - t0);
    } catch (e) {
      console.error(`[main] ${m.name}.init failed — module disabled`, e);
      m.disabled = true;
    }
  };
  const P = app.perf.init;
  holdWorkers(true);   // (until every start-up program is linked: see holdWorkers)
  const tStart = performance.now();
  for (let i = 0; i <= split; i++) {
    await initModule(mods[i]);
    setProgress(0.05 + 0.1 * (i + 1) / (split + 1));
  }
  if (!app.materials || app.materials.disabled) { fatal('materials module unavailable'); return; }
  let initMs = performance.now() - tStart;

  // world streaming: the chunks within 240 m, with the parts of the modules initialised so far
  const builders = mods.filter((m) => m.build && !m.disabled);
  app.world = new World(app, builders);
  const s0 = app.startS, primeDist = Math.min(LOD0_DIST, 240);
  placeCamera(app, s0);
  let tq = performance.now();
  const ready1 = new Set(mods.slice(0, split + 1).filter((m) => !m.disabled).map((m) => m.name));
  await app.world.prime(s0, primeDist, (f) => setProgress(0.15 + 0.05 * f), null, ready1);
  let primeMs = performance.now() - tq;

  // queue the programs. (Nothing polls them until step 4: a query of a program's completion
  // status is a synchronous call that waits whenever the GPU process is busy, so polling
  // while the inits run would take main-thread time from them.)
  const tCompile = performance.now();
  P.compileStart = Math.round(tCompile);
  const progs = renderer.info.programs || [];
  compileScene(app, false);
  P.programsQueued = progs.length;

  // step 3: the remaining modules, while the GPU process compiles
  tq = performance.now();
  const late = mods.length - split - 1;
  for (let i = split + 1; i < mods.length; i++) {
    await initModule(mods[i]);
    setProgress(0.2 + 0.1 * (i - split) / Math.max(1, late));
  }
  initMs += performance.now() - tq;
  P.modulesTotal = Math.round(initMs);

  // step 4: their chunk parts, the far field (a few ms in all), and their programs; then wait
  // for every program (the loading bar follows them as they finish)
  tq = performance.now();
  await app.world.prime(s0, primeDist, null);
  await app.world.prime(s0, Infinity, null, [2]);
  primeMs += performance.now() - tq;
  P.prime = Math.round(primeMs);
  const tWait = performance.now();
  const progressTimer = setInterval(() => {
    let n = 0;
    for (const p of progs) if (!p.isReady || p.isReady()) n++;
    setProgress(0.3 + 0.65 * (progs.length ? n / progs.length : 1));
  }, 250);
  await Promise.race([compileScene(app, true), new Promise((r) => setTimeout(r, 20000))]);
  clearInterval(progressTimer);
  renderer.setRenderTarget(null);
  touchPrograms(renderer);   // pay each program's first-use cost now, behind the loading bar
  P.workersHeld = holdWorkers(false);
  // compile: from queueing the first programs until every program is linked (it overlaps
  // the step-3 inits); compileWait: the part of it the start-up waited for after step 4
  P.compile = Math.round(performance.now() - tCompile);
  P.compileWait = Math.round(performance.now() - tWait);
  P.programs = progs.length;
  const tFrames = performance.now();
  setProgress(1);

  // ---- loop
  const timer = new THREE.Timer();
  timer.connect(document);
  // rec=<fps>: offline recording. Every frame advances the clock by exactly 1/fps; the
  // simulation holds still while loading, and once ready the loop stops and frames are
  // stepped on demand by app.recStep(n) (tools/record.py screenshots after each step).
  const recFps = params.num('rec', 0);
  let fpsAcc = 0, fpsN = 0, fpsT = 0, progN = -1;
  const updaters = mods.filter((m) => m.update && !m.disabled);
  const order = ['train', 'cameraRig'];
  updaters.sort((a, b) => (order.includes(b.name) ? 1 : 0) - (order.includes(a.name) ? 1 : 0) || order.indexOf(a.name) - order.indexOf(b.name));

  // frame-time monitor: stats().frames percentiles and the hitch log (app.hitches(),
  // app.hitchReport(), app.resetFrames()), with stage times per module, world and render
  const mon = new FrameMonitor(app, [...updaters.map((m) => m.name), 'world', 'render']);
  const iWorld = updaters.length, iRender = updaters.length + 1;
  Object.assign(app, { monitor: mon, hitches: () => mon.hitches(), hitchReport: () => mon.report(), resetFrames: () => mon.reset() });
  {
    // CPU time of the shadow passes inside render (wraps any module's own hook), and their
    // longest single draw: one GL call that blocks for 10 ms or more is the main thread
    // waiting for a GPU that is behind, not shadow work on the CPU
    // (fixed arity, not rest parameters: no argument array per call)
    const sm = renderer.shadowMap, smRender = sm.render;
    let inShadow = false;
    sm.render = function (lights, scene, camera) {
      const t = performance.now();
      inShadow = true;
      try { return smRender.call(this, lights, scene, camera); } finally { inShadow = false; mon.shadowMs += performance.now() - t; }
    };
    const rbd = renderer.renderBufferDirect;
    renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
      if (!inShadow) return rbd.call(this, camera, scene, geometry, material, object, group);
      const t = performance.now();
      rbd.call(this, camera, scene, geometry, material, object, group);
      const d = performance.now() - t;
      if (d > mon.shadowDraw) { mon.shadowDraw = d; mon.shadowDrawObj = object.name || object.type; }
    };
  }

  function frame(ts) {
    const t0 = performance.now();
    mon.begin(t0);
    timer.update(ts);
    const realDt = recFps > 0 ? 1 / recFps : Math.min(timer.getDelta(), 0.1);
    const dt = params.freeze || (recFps > 0 && !app.ready) ? 0 : realDt;
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
    // programs created in a frame or compiled in the background: typed setters once linked
    const np = renderer.info.programs ? renderer.info.programs.length : 0;
    if (np !== progN || (app.frame & 31) === 0) { progN = np; touchReadyPrograms(renderer); app.perf.typedUniforms = typedCount; }
    if (app.frame <= 40) (app.perf.startFrames ||= []).push([Math.round(t0), Math.round(cpu), np]);
    if (app.frame === 1) app.perf.init.firstFrame = Math.round(t0 - tFrames);
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
      app.perf.init.frames = Math.round(performance.now() - tFrames);
      if (loadingEl) loadingEl.classList.add('done');
      events.emit('ready', {});
      setTimeout(() => { window.__ready = true; }, 300);
    }
    if (!(recFps > 0 && app.ready)) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  app.recStep = (n = 1) => { for (let i = 0; i < n; i++) frame(performance.now()); return app.frame; };

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
 * Worker teardown waits for the GPU process: Chrome releases a terminated worker's GPU
 * context (it has one once it used an OffscreenCanvas or an ImageBitmap) with a synchronous
 * call, and while the start-up programs compile that call waits behind every program
 * queued: the main thread stood still for 6-20 s when the figure decoders finished. A
 * worker terminated during the start-up (inits and compile) is terminated once every
 * start-up program is linked (the GPU process is idle then). holdWorkers(true) starts holding; holdWorkers(false) stops and
 * terminates the held ones, returning how many.
 */
const workerHold = { on: false, held: [] };
if (typeof Worker !== 'undefined' && Worker.prototype.terminate) {
  const terminate = Worker.prototype.terminate;
  Worker.prototype.terminate = function () {
    if (!workerHold.on) return terminate.call(this);
    if (!workerHold.held.includes(this)) workerHold.held.push(this);
    workerHold.terminate = terminate;
  };
}
function holdWorkers(on) {
  workerHold.on = on;
  if (on) return 0;
  const held = workerHold.held.splice(0);
  for (const w of held) { try { workerHold.terminate.call(w); } catch (e) { /* gone */ } }
  return held.length;
}

/** Queue the programs of everything in the scene against the HDR scene target (non-blocking:
 *  KHR_parallel_shader_compile). With `wait`, the promise resolves once they are linked. */
function compileScene(app, wait) {
  const r = app.renderer;
  const rt = app.post && !app.post.disabled ? app.post.sceneRT : null;
  const prev = r.getRenderTarget();
  let p = null;
  try {
    r.setRenderTarget(rt || null);
    if (wait) p = r.compileAsync(app.scene, app.camera);
    else r.compile(app.scene, app.camera);
  } catch (e) {
    console.warn('[main] compile', e);
  }
  r.setRenderTarget(prev);
  return (p || Promise.resolve()).catch((e) => console.warn('[main] compile', e));
}

const TYPED = params.str('gltyped', '1') !== '0';
let typedCount = 0;

/** Resolve uniforms/attributes of every linked program so first use never stalls a frame
 *  (getUniforms waits for a program still linking), and give their float uniforms the
 *  typed setters (core/rendererPatches.js). */
export function touchPrograms(renderer) {
  for (const p of renderer.info.programs || []) {
    if (p.__touched) continue;
    try {
      p.getUniforms(); p.getAttributes(); p.__touched = true;
      if (TYPED) typedCount += typedUniforms(p);
    } catch (e) { /* not linked yet */ }
  }
}

/** The same for programs that are ready, without waiting for any (per frame: programs the
 *  renderer created in a frame, or compiled in the background). */
function touchReadyPrograms(renderer) {
  const progs = renderer.info.programs;
  if (!progs) return;
  for (let i = 0; i < progs.length; i++) {
    const p = progs[i];
    if (p.__touched || (p.isReady && !p.isReady())) continue;
    try {
      p.getUniforms(); p.getAttributes(); p.__touched = true;
      if (TYPED) typedCount += typedUniforms(p);
    } catch (e) { /* not linked yet */ }
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
