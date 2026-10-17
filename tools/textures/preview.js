import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import materials from '../../src/materials/materials.js';
import { U } from '../../src/core/uniforms.js';

// Material preview: lit sample spheres / panels, a facade wall, a street ground plane at the
// tram's eye height, and the raw baked maps.
//   ?mode=grid | wall | street | maps | single | canopy
//   &mat=<name>  &recipe=<bake name>  &sun=<elevDeg>,<azDeg>  &fov=<deg>
//   &cam=x,y,z,tx,ty,tz  &night=<0..1>  &exposure=<f>  &filter=<substring>
// Works with tools/shoot.py: --page tools/textures/preview.html --params "mode=wall"

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'grid';
const num = (k, d) => (q.has(k) ? +q.get(k) : d);
const vec = (k) => (q.get(k) ? q.get(k).split(',').map(Number) : null);

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 40), innerWidth / innerHeight, 0.05, 3000);
const app = { THREE, renderer, scene, camera, U, params: {} };

// ---------------------------------------------------------------- lighting: sun + gradient sky env
const [sunEl, sunAz] = vec('sun') || [58, 215];
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - sunEl), THREE.MathUtils.degToRad(sunAz));
U.uSunDir.value.copy(sunDir);
U.uNight.value = num('night', 0);
const sun = new THREE.DirectionalLight(0xfff1e0, 3.2 * (1 - 0.9 * U.uNight.value));
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

function skyEnv() {
  const s = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { sunDir: { value: sunDir }, k: { value: 1 - 0.95 * U.uNight.value } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vD; uniform vec3 sunDir; uniform float k;
      void main(){
        vec3 d = normalize(vD);
        float h = d.y;
        vec3 zen = vec3(0.09, 0.2, 0.48), hor = vec3(0.42, 0.48, 0.55), gnd = vec3(0.16, 0.15, 0.13);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor * 0.5, gnd, smoothstep(0.0, 0.25, -h));
        c += vec3(1.0, 0.85, 0.6) * pow(max(dot(d, sunDir), 0.0), 8.0) * 0.6;   // aureole (sun disc is the light)
        gl_FragColor = vec4(c * k, 1.0);
      }`,
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), mat));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0, 0.1, 200);
  pm.dispose();
  return rt.texture;
}
scene.environment = skyEnv();
scene.background = new THREE.Color().setRGB(0.42, 0.52, 0.66, THREE.LinearSRGBColorSpace).multiplyScalar(1 - 0.95 * U.uNight.value);

// ---------------------------------------------------------------- geometry helpers (UVs in metres)
function uvFrom(geo, fn) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const [a, b] = fn(v); uv.setXY(i, a, b); }
  uv.needsUpdate = true;
  return geo;
}
function sphere(r) {
  const g = new THREE.SphereGeometry(r, 64, 32);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, uv.getY(i) * Math.PI * r);
  return g;
}
function mesh(geo, mat, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast; m.receiveShadow = true;
  scene.add(m);
  return m;
}
/** horizontal strip along -Z: u = distance along (-z), v = lateral x */
function strip(x0, x1, len, mat, h = 0) {
  const g = new THREE.PlaneGeometry(x1 - x0, len, 1, Math.ceil(len / 2));
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, h, -len / 2 + 10);
  uvFrom(g, (p) => [-p.z + 1000, p.x]);
  return mesh(g, mat, false);
}
/** vertical wall in the plane x = const facing +x or -x; u along -z (or +z), v = height */
function wall(x, z0, z1, h0, h1, mat, facing = 1, uOff = 0) {
  const g = new THREE.PlaneGeometry(Math.abs(z1 - z0), h1 - h0);
  g.rotateY(facing > 0 ? Math.PI / 2 : -Math.PI / 2);
  g.translate(x, (h0 + h1) / 2, (z0 + z1) / 2);
  uvFrom(g, (p) => [(facing > 0 ? -p.z : p.z) + uOff, p.y]);
  return mesh(g, mat);
}

// ---------------------------------------------------------------- scenes
const labels = [];
async function main() {
  await materials.init(app);
  await materials.ready;
  const M = materials;
  const filter = q.get('filter');

  if (mode === 'grid') {
    const names = M.names().filter((n) => !filter || n.includes(filter));
    const cols = Math.ceil(Math.sqrt(names.length * 1.8));
    names.forEach((n, i) => {
      const cx = (i % cols - (cols - 1) / 2) * 1.6, cz = Math.floor(i / cols) * 1.9;
      const s = mesh(sphere(0.5), M.get(n));
      s.position.set(cx - 0.25, 0.55, cz);
      const panel = mesh(uvFrom(new THREE.BoxGeometry(0.5, 0.9, 0.06), (p) => [p.x + 0.25, p.y + 0.45]), M.get(n));
      panel.position.set(cx + 0.42, 0.5, cz);
      panel.rotation.y = -0.5;
      labels.push({ name: n, pos: new THREE.Vector3(cx, 0.0, cz + 0.6) });
    });
    strip(-20, 20, 60, M.get('concrete'), 0);
    const rows = Math.ceil(names.length / cols);
    camera.position.set(0, 7.5, rows * 1.9 + 4.5);
    camera.lookAt(0, 0, rows * 0.95 - 0.5);
  } else if (mode === 'wall') {
    // facade: rusticated base, ashlar, smooth string course and sills
    const mat = q.get('mat') || 'stone.ashlar';
    wall(0, -12, 12, -0.5, 1.4, M.get('stone.rough'), 1);
    wall(0, -12, 12, 1.4, 1.75, M.get('stone.smooth'), 1);
    wall(0, -12, 12, 1.75, 14, M.get(mat), 1);
    const sill = mesh(uvFrom(new THREE.BoxGeometry(0.25, 0.16, 24), (p) => [-p.z, p.y + p.x]), M.get('stone.smooth'));
    sill.position.set(0.12, 1.66, 0);
    strip(0, 6, 60, M.get('paving.sidewalk'), 0).position.z = 30;
    const iron = mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.0, 12), M.get('metal.iron'));
    iron.position.set(0.6, 5.0, 0);
    const [cx, cy, cz, tx, ty, tz] = vec('cam') || [6.5, 1.7, 4, 0, 3.2, -1];
    camera.position.set(cx, cy, cz);
    camera.lookAt(tx, ty, tz);
  } else if (mode === 'street') {
    // tram corridor + bands + sidewalks + facades, seen from the cab at 2.75 m
    const L = 600;
    strip(-3.1, 3.1, L, M.get('paving.street'));
    strip(3.1, 3.4, L, M.get('paving.band'));
    strip(-3.4, -3.1, L, M.get('paving.band'));
    strip(3.4, 12, L, M.get('paving.sidewalk'));
    strip(-12, -3.4, L, M.get('paving.sidewalk'));
    for (const t of [-1.6, 1.6]) for (const r of [-0.7455, 0.7455]) {
      strip(t + r - 0.028, t + r + 0.028, L, M.get('rail.head'), 0.001);
      const gx = t + r + (r > 0 ? -0.049 : 0.049);
      strip(gx - 0.02, gx + 0.02, L, M.get('rail.groove'), 0.0005);
    }
    wall(12, 10, -L + 10, 0, 20, M.get('stone.ashlar'), -1);
    wall(-12, 10, -L + 10, 0, 20, M.get('stone.ashlar'), 1, 37);
    const [cx, cy, cz, tx, ty, tz] = vec('cam') || [1.6, 2.75, 0, 1.6, 2.2, -60];
    camera.position.set(cx, cy, cz);
    camera.lookAt(tx, ty, tz);
    camera.fov = num('fov', 17);
    camera.updateProjectionMatrix();
  } else if (mode === 'single') {
    const n = q.get('mat') || 'stone.ashlar';
    const g = new THREE.PlaneGeometry(6, 4);
    uvFrom(g, (p) => [p.x + 3, p.y + 2]);
    const pl = mesh(g, M.get(n));
    pl.position.set(0, 2, 0);
    const s = mesh(sphere(0.6), M.get(n));
    s.position.set(1.9, 0.6, 1.3);
    strip(-10, 10, 30, M.get('paving.sidewalk')).position.z = 15;
    const [cx, cy, cz, tx, ty, tz] = vec('cam') || [0.6, 1.8, 3.6, 0.4, 1.7, 0];
    camera.position.set(cx, cy, cz);
    camera.lookAt(tx, ty, tz);
  } else if (mode === 'canopy') {
    // fabric seen from below with the sun above: back-lit translucency
    const n = q.get('mat') || 'fabric.umbrella';
    for (const [i, x] of [[0, -1.6], [1, 1.6]]) {
      const g = new THREE.PlaneGeometry(3, 3);
      g.rotateX(Math.PI / 2);
      uvFrom(g, (p) => [p.x + 1.5, p.z + 1.5]);
      const mat = i === 0 ? M.get(n) : M.get(n, { vertexColors: true });
      if (i === 1) {
        const c = new Float32Array(g.attributes.position.count * 3);
        for (let k = 0; k < c.length; k += 3) { c[k] = 0.04; c[k + 1] = 0.07; c[k + 2] = 0.2; }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      }
      const pl = mesh(g, mat);
      pl.position.set(x, 2.6, 0);
    }
    strip(-10, 10, 30, M.get('paving.sidewalk')).position.z = 15;
    const [cx, cy, cz, tx, ty, tz] = vec('cam') || [0, 1.5, 3.2, 0, 2.6, 0];
    camera.position.set(cx, cy, cz);
    camera.lookAt(tx, ty, tz);
  } else if (mode === 'maps') {
    const t = M.textures.get(q.get('recipe') || 'ashlar');
    const show = (tex, x, fn) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { t: { value: tex } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform sampler2D t; varying vec2 vUv; void main(){ vec4 s = texture2D(t, vUv * 2.0); ${fn} }`,
      });
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
      p.position.set(x, 0, 0);
      scene.add(p);
    };
    if (t?.albedo) {
      show(t.albedo, -1.65, 'gl_FragColor = vec4(s.rgb, 1.0);\n#include <colorspace_fragment>\n');
      show(t.surface, -0.55, 'vec2 n = s.rg * 2.0 - 1.0; gl_FragColor = vec4(n * 0.5 + 0.5, sqrt(max(1.0 - dot(n,n), 0.0)), 1.0);');
      show(t.albedo, 0.55, 'gl_FragColor = vec4(vec3(s.a), 1.0);');
      show(t.surface, 1.65, 'gl_FragColor = vec4(vec3(s.a), 1.0);');
    } else if (t?.raw) {
      show(t.raw, 0, 'gl_FragColor = vec4(s.rgb, 1.0);');
    }
    renderer.toneMapping = THREE.NoToneMapping;
    scene.background = new THREE.Color(0x202020);
    camera.position.set(0, 0, 2.6);
    camera.lookAt(0, 0, 0);
  }

  // shadow frustum around the view
  const target = new THREE.Vector3();
  camera.getWorldDirection(target).multiplyScalar(mode === 'street' ? 40 : 6).add(camera.position);
  sun.target.position.copy(target);
  sun.position.copy(target).addScaledVector(sunDir, 200);
  const sc = sun.shadow.camera;
  const ext = mode === 'street' ? 70 : mode === 'grid' ? 25 : 15;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 400;
  sc.updateProjectionMatrix();

  if (!q.has('capture')) {
    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.update();
  }

  const info = document.getElementById('info');
  const st = materials.stats;
  info.textContent = `init ${st.initMs?.toFixed(0)} ms · bake done after ${st.bakedAfterMs?.toFixed(0)} ms · textures ${st.textureMB} MB · ${materials.names().length} materials`;
  const labelEl = document.getElementById('labels');
  labelEl.innerHTML = labels.map((l) => `<div>${l.name}</div>`).join('');
  let frames = 0, t0 = performance.now(), fps = 0, glErrors = 0;
  const gl = renderer.getContext();
  function frame() {
    renderer.render(scene, camera);
    if (gl.getError() !== gl.NO_ERROR) glErrors++;
    labels.forEach((l, i) => {
      const p = l.pos.clone().project(camera);
      const el = labelEl.children[i];
      el.style.left = ((p.x + 1) / 2) * innerWidth + 'px';
      el.style.top = ((1 - p.y) / 2) * innerHeight + 'px';
    });
    frames++;
    if (frames === 30) { fps = 30000 / (performance.now() - t0); }
    if (frames === 8) window.__ready = true;
    requestAnimationFrame(frame);
  }
  window.__app = {
    materials, renderer,
    stats: () => ({ glErrors, fps: +fps.toFixed(1), calls: renderer.info.render.calls, programs: renderer.info.programs?.length, textures: renderer.info.memory.textures, bake: materials.stats }),
  };
  frame();
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});
main().catch((e) => { console.error(e); window.__fatal = String(e.stack || e); });
