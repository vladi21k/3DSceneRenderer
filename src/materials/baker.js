import * as THREE from 'three';
import { HASH_GLSL, LAYOUT_GLSL, NOISE_GLSL } from './glsl/common.js';

// GPU texture baker. Each recipe is a GLSL `surface(m, s)` function evaluated per texel
// (m = metres inside the tile). Two passes:
//   A  recipe → half-float MRT: (albedo linear, roughness) + (height m, ao, metal)
//   B  shared → RGBA8 MRT: albedo (sRGB) + roughness in alpha,
//                         surface = (normal.xy, |normal.xy|² moment, ao)
// The moment channel survives hardware mip-mapping, so the runtime shader can turn
// normal detail lost in the mips into roughness (specular anti-aliasing).
// `raw` recipes write pass A straight into a half-float texture (macro noise).

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${HASH_GLSL}
${LAYOUT_GLSL}
${NOISE_GLSL}
struct Surf { vec3 albedo; float rough; float height; float ao; float metal; };
`;

const MAIN_A = /* glsl */ `
uniform float uSS;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
const vec2 SSO[4] = vec2[4](vec2(0.375, 0.125), vec2(0.875, 0.375), vec2(0.125, 0.625), vec2(0.625, 0.875));
void main() {
  vec4 a0 = vec4(0.0), a1 = vec4(0.0);
  int ns = uSS > 1.5 ? 4 : 1;
  for (int j = 0; j < 4; j++) {
    if (j >= ns) break;
    vec2 off = ns == 1 ? vec2(0.5) : SSO[j];
    vec2 m = (floor(gl_FragCoord.xy) + off) / uRes * uTile;
    Surf s = Surf(vec3(0.5), 0.8, 0.0, 1.0, 0.0);
    surface(m, s);
    a0 += vec4(s.albedo, s.rough);
    a1 += vec4(s.height, s.ao, s.metal, 1.0);
  }
  o0 = a0 / float(ns);
  o1 = a1 / float(ns);
}
`;

const MAIN_RAW = /* glsl */ `
layout(location = 0) out vec4 o0;
void main() { o0 = rawSurface((floor(gl_FragCoord.xy) + 0.5) / uRes * uTile); }
`;

const PASS_B = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tA;
uniform sampler2D tB;
uniform vec2 uRes;
uniform vec2 uTexM;      // metres per texel
uniform vec4 uNB;        // normal strength, cavity AO strength, AO radius (m), cavity → albedo darkening
uniform float uMetalOut; // 1: surface.b carries the metal mask instead of the normal moment
layout(location = 0) out vec4 oAlb;
layout(location = 1) out vec4 oSurf;
int sfMod(int a, int m) { return a - m * int(floor(float(a) / float(m))); }
float H(ivec2 p) { ivec2 r = ivec2(uRes); return texelFetch(tB, ivec2(sfMod(p.x, r.x), sfMod(p.y, r.y)), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h00 = H(p + ivec2(-1, -1)), h10 = H(p + ivec2(0, -1)), h20 = H(p + ivec2(1, -1));
  float h01 = H(p + ivec2(-1, 0)),  h11 = H(p),                h21 = H(p + ivec2(1, 0));
  float h02 = H(p + ivec2(-1, 1)),  h12 = H(p + ivec2(0, 1)),  h22 = H(p + ivec2(1, 1));
  float dx = ((h20 + 2.0 * h21 + h22) - (h00 + 2.0 * h01 + h02)) / (8.0 * uTexM.x);
  float dy = ((h02 + 2.0 * h12 + h22) - (h00 + 2.0 * h10 + h20)) / (8.0 * uTexM.y);
  vec3 n = normalize(vec3(-dx * uNB.x, -dy * uNB.x, 1.0));
  // horizon-style cavity occlusion from the height field
  float occ = 0.0;
  if (uNB.y > 0.0) {
    for (int i = 0; i < 24; i++) {
      float fi = float(i) + 0.5;
      float a = fi * 2.399963;
      vec2 off = vec2(cos(a), sin(a)) * uNB.z * sqrt(fi / 24.0);
      ivec2 o = ivec2(round(off / uTexM));
      float d = length(vec2(o) * uTexM);
      if (d <= 0.0) continue;
      occ += clamp((H(p + o) - h11) / d, 0.0, 1.0);
    }
    occ /= 24.0;
  }
  vec4 A = texelFetch(tA, p, 0), B = texelFetch(tB, p, 0);
  float ao = clamp(B.g * (1.0 - uNB.y * occ), 0.0, 1.0);
  oAlb = vec4(clamp(A.rgb * mix(1.0, ao, uNB.w), 0.0, 1.0), clamp(A.a, 0.0, 1.0));
  oSurf = vec4(n.xy * 0.5 + 0.5, uMetalOut > 0.5 ? clamp(B.b, 0.0, 1.0) : dot(n.xy, n.xy), ao);
}
`;

function sizeOf(r) { return Array.isArray(r.size) ? r.size : [r.size, r.size]; }

export class Baker {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.geometry = g;
    this.temps = new Map();
    this.passB = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: PASS_B,
      uniforms: {
        tA: { value: null }, tB: { value: null }, uRes: { value: new THREE.Vector2() },
        uTexM: { value: new THREE.Vector2() }, uNB: { value: new THREE.Vector4() }, uMetalOut: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
  }

  passA(r) {
    const [w, h] = sizeOf(r);
    const L = r.layout || {};
    return new THREE.RawShaderMaterial({
      name: 'bake:' + r.name,
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: HEAD + r.glsl + (r.raw ? MAIN_RAW : MAIN_A),
      uniforms: {
        uTile: { value: new THREE.Vector2(...r.tile) },
        uRes: { value: new THREE.Vector2(w, h) },
        uLay: { value: new THREE.Vector4(L.rowH ?? 1, L.rows ?? 1, L.seg?.[0] ?? 1, L.seg?.[1] ?? 1) },
        uLay2: { value: new THREE.Vector4(L.jitter ?? 0, L.seed ?? 1, L.shift ? 1 : 0, L.rowJoints === false ? 0 : 1) },
        uSS: { value: r.ss ?? 2 },
      },
      depthTest: false, depthWrite: false,
    });
  }

  temp(w, h) {
    const key = w + 'x' + h;
    if (!this.temps.has(key)) {
      this.temps.set(key, new THREE.WebGLRenderTarget(w, h, {
        count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      }));
    }
    return this.temps.get(key);
  }

  finalTarget(r) {
    const [w, h] = sizeOf(r);
    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: r.raw ? 1 : 2, depthBuffer: false,
      type: r.raw ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
      anisotropy: this.maxAniso,
    });
    rt.textures.forEach((t, i) => {
      t.name = `${r.name}.${r.raw ? 'raw' : i === 0 ? 'albedo' : 'surface'}`;
      t.colorSpace = !r.raw && i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    });
    return rt;
  }

  /** Bake every recipe. Returns Map name → {albedo, surface, raw, recipe}. Failed recipes are skipped. */
  async bake(recipes) {
    const R = this.renderer;
    const t0 = performance.now();
    const meshes = recipes.map((r) => {
      const m = new THREE.Mesh(this.geometry, this.passA(r));
      m.frustumCulled = false;
      return m;
    });
    const pb = new THREE.Mesh(this.geometry, this.passB);
    pb.frustumCulled = false;
    // parallel shader compilation (KHR_parallel_shader_compile) for every pass
    this.scene.add(pb, ...meshes);
    try { await R.compileAsync(this.scene, this.camera); } catch (e) { console.warn('[materials] compileAsync failed, compiling lazily', e); }
    this.scene.clear();
    const tCompile = performance.now();

    const prevTarget = R.getRenderTarget();
    const prevAutoClear = R.autoClear;
    const prevXr = R.xr.enabled;
    R.autoClear = false;
    R.xr.enabled = false;
    const out = new Map();
    const timings = {};
    for (let i = 0; i < recipes.length; i++) {
      const r = recipes[i], mesh = meshes[i];
      if (!this.runnable(mesh.material) || !this.runnable(this.passB)) {
        console.warn(`[materials] bake recipe ${r.name} did not compile; material falls back to flat values`);
        continue;
      }
      const tb = performance.now();
      const [w, h] = sizeOf(r);
      const final = this.finalTarget(r);
      this.scene.add(mesh);
      if (r.raw) {
        R.setRenderTarget(final);
        R.render(this.scene, this.camera);
      } else {
        const tmp = this.temp(w, h);
        R.setRenderTarget(tmp);
        R.render(this.scene, this.camera);
        const u = this.passB.uniforms;
        u.tA.value = tmp.textures[0];
        u.tB.value = tmp.textures[1];
        u.uRes.value.set(w, h);
        u.uTexM.value.set(r.tile[0] / w, r.tile[1] / h);
        const nb = r.pass || {};
        u.uNB.value.set(nb.normal ?? 1, nb.ao ?? 0.6, nb.aoRadius ?? 0.02, nb.cavity ?? 0.25);
        u.uMetalOut.value = r.metalMask ? 1 : 0;
        this.scene.remove(mesh);
        this.scene.add(pb);
        R.setRenderTarget(final);
        R.render(this.scene, this.camera);
        this.scene.remove(pb);
      }
      this.scene.clear();
      timings[r.name] = performance.now() - tb;
      out.set(r.name, {
        recipe: r, target: final,
        albedo: r.raw ? null : final.textures[0],
        surface: r.raw ? null : final.textures[1],
        raw: r.raw ? final.textures[0] : null,
      });
    }
    R.setRenderTarget(prevTarget);
    R.autoClear = prevAutoClear;
    R.xr.enabled = prevXr;
    // pass-A programs and scratch targets are no longer needed
    for (const m of meshes) m.material.dispose();
    for (const t of this.temps.values()) t.dispose();
    this.temps.clear();
    this.passB.dispose();
    this.geometry.dispose();
    this.stats = {
      compileMs: tCompile - t0, totalMs: performance.now() - t0, timings,
      bytes: [...out.values()].reduce((a, b) => a + texBytes(b), 0),
    };
    return out;
  }

  runnable(mat) {
    const p = this.renderer.properties.get(mat).currentProgram;
    if (!p) return true;
    p.getUniforms(); // forces link status / diagnostics
    return !p.diagnostics || p.diagnostics.runnable !== false;
  }
}

function texBytes(b) {
  const [w, h] = sizeOf(b.recipe);
  const per = b.recipe.raw ? 8 : 8; // 2× RGBA8 or 1× RGBA16F
  return Math.round(w * h * per * 4 / 3);
}
