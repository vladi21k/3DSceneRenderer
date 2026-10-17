import * as THREE from 'three';

// One shared physical material for every mobility prop (bicycles, strollers, locks), so a
// prop variant at one LOD is a single instanced draw. The vertex stage animates the prop's
// pieces per instance (wheels roll, cranks turn, pedals orbit level, the fork / bars / front
// wheel steer about the head axis, casters swivel, the saddle slides, parts toggle); the
// fragment stage shades per channel (paints with instance colours and finish, tyre tread,
// alpha-to-coverage spokes and wire mesh, fabric weave, leather grain, dust and wear).
//
// Per-instance data rides on InstancedMesh's own buffers (the geometry stays shared):
//   instanceMatrix  rows 0-2: the prop's transform; bottom row (elements 3, 7, 11, 15):
//                   anim = (wheel / rear wheel angle, saddle offset | front wheel angle, crank angle, steer | caster swivel)
//   instanceColor   r: colour A (sRGB 8:8:8 packed in a float), g: colour B, b: look word
//                   (finish 2 bits, wear 3 bits, flags from bit 5: see FLAG)
// Only meshes made by instancer.js may use this material: they keep the bounds themselves
// (three's own instance bounds would read the packed bottom row).

export const FLAG = { STAND: 1, BABY: 2, LOAD: 4 };   // flags (look word bits 5+)
export const FINISH = { GLOSS: 0, METALLIC: 1, MATTE: 2, SATIN: 3 };

/** Look word: finish 0..3, wear 0..7, flags (FLAG bits), baby skin 0..3, baby clothes 0..7, baby hat 0/1. */
export function packLook(finish = 0, wear = 2, flags = 0, skin = 0, cloth = 0, hat = 0) {
  return (finish & 3) + ((wear & 7) << 2) + ((flags & 7) << 5) + ((skin & 3) << 8) + ((cloth & 7) << 10) + ((hat & 1) << 13);
}

/** sRGB colour (THREE.Color in linear, a hex number or [r, g, b] sRGB 0..1) packed into one float. */
export function packColor(c) {
  let r, g, b;
  if (typeof c === 'number') { r = (c >> 16) & 255; g = (c >> 8) & 255; b = c & 255; }
  else if (Array.isArray(c)) { r = Math.round(c[0] * 255); g = Math.round(c[1] * 255); b = Math.round(c[2] * 255); }
  else { const t = _col.copy(c).convertLinearToSRGB(); r = Math.round(t.r * 255); g = Math.round(t.g * 255); b = Math.round(t.b * 255); }
  return Math.min(255, Math.max(0, r)) + Math.min(255, Math.max(0, g)) * 256 + Math.min(255, Math.max(0, b)) * 65536;
}
const _col = new THREE.Color();

// ---------------------------------------------------------------------------- shader code

const VERT_PARS = /* glsl */`
attribute vec4 aMat;
attribute vec4 aPiv;
attribute vec4 aAux;
varying vec4 vPMat;     // roughness, metalness, channel, parameter (clearcoat / tread kind / mesh width)
varying vec4 vPInfo;    // occlusion, dust weight, finish, wear
varying vec3 vPRest;    // rest-pose prop-local position (dust, wear and grain noise stick to the part)
varying vec2 vPUv;
varying float vPChain;  // chain travel (m) for the link pattern
uniform vec3 uPropSkin[4];
uniform vec3 uPropCloth[8];
vec3 pSrgb(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 pUnpack(float f) {
  float v = floor(f + 0.5);
  return pSrgb(vec3(mod(v, 256.0), mod(floor(v / 256.0), 256.0), floor(v / 65536.0)) / 255.0);
}
float pBits(float word, float shift, float count) { return mod(floor(floor(word + 0.5) / exp2(shift)), exp2(count)); }
mat3 pRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 pRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 pRotAxis(vec3 k, float a) {
  float c = cos(a), s = sin(a), t = 1.0 - c;
  return mat3(t * k.x * k.x + c, t * k.x * k.y + s * k.z, t * k.x * k.z - s * k.y,
              t * k.x * k.y - s * k.z, t * k.y * k.y + c, t * k.y * k.z + s * k.x,
              t * k.x * k.z + s * k.y, t * k.y * k.z - s * k.x, t * k.z * k.z + c);
}
// piece transform p' = R p + t for the instance's animation state
void pPiece(vec4 anim, float look, out mat3 R, out vec3 t) {
  R = mat3(1.0); t = vec3(0.0);
  int id = int(aPiv.w + 0.5);
  if (id == 0) return;
  vec3 piv = aPiv.xyz;
  if (id == 2 || id == 3 || id == 4 || id == 12) {
    float a = id == 4 ? anim.z : (id == 12 ? anim.y : anim.x);
    R = pRotX(-a);
    t = piv - R * piv;
  }
  if (id == 1 || id == 2) {
    vec3 k = vec3(0.0, sin(aAux.z), cos(aAux.z));
    vec3 A = vec3(0.0, aAux.x, aAux.y);
    mat3 S = pRotAxis(k, anim.w);
    t = S * t + A - S * A;
    R = S * R;
  } else if (id == 5) {
    vec3 bb = vec3(0.0, aAux.x, aAux.y);
    t = bb + pRotX(-anim.z) * (piv - bb) - piv;
  } else if ((id >= 6 && id <= 8) || id == 13 || id == 14) {
    float flags = pBits(look, 5.0, 3.0);
    bool baby = mod(floor(flags / 2.0), 2.0) > 0.5;
    bool hat = pBits(look, 13.0, 1.0) > 0.5;
    bool show = id == 6 ? mod(flags, 2.0) > 0.5 : (id == 7 ? mod(flags, 2.0) < 0.5 : (id == 8 ? baby : (id == 13 ? baby && hat : baby && !hat)));
    if (!show) { R = mat3(0.0); t = piv; }
  } else if (id == 9 || id == 10) {
    if (id == 10) { R = pRotX(-anim.y); t = aAux.xyz - R * aAux.xyz; }
    mat3 Y = pRotY(anim.w);
    t = Y * t + piv - Y * piv;
    R = Y * R;
  } else if (id == 11) {
    t = aAux.xyz * anim.y;
  }
}
`;

// injected at the top of main(): clean instance matrix, animation state, piece transform
const VERT_MAIN = /* glsl */`
  vec4 pAnim = vec4(0.0);
  vec3 pLook = vec3(${packColorGLSL(0x808080)}, ${packColorGLSL(0x808080)}, 8.0);
  #ifdef USE_INSTANCING
    mat4 pIM = instanceMatrix;
    pAnim = vec4(pIM[0][3], pIM[1][3], pIM[2][3], pIM[3][3]);
    pIM[0][3] = 0.0; pIM[1][3] = 0.0; pIM[2][3] = 0.0; pIM[3][3] = 1.0;
    #define instanceMatrix pIM
    #ifdef USE_INSTANCING_COLOR
      pLook = instanceColor;
    #endif
  #endif
  mat3 pR; vec3 pT;
  pPiece(pAnim, pLook.z, pR, pT);
`;

function packColorGLSL(hex) { return packColor(hex).toFixed(1); }

const VERT_COLOR = /* glsl */`
  {
    float ch = floor(aMat.z + 0.5);
    float finish = pBits(pLook.z, 0.0, 2.0), wear = pBits(pLook.z, 2.0, 3.0);
    vec3 alb = color.rgb;
    float rough = aMat.x, metal = aMat.y, par = aMat.w;
    if (ch == 1.0 || ch == 2.0) {
      vec3 paint = pUnpack(ch == 1.0 ? pLook.x : pLook.y);
      alb *= paint;
      // finishes: gloss (clear-coated enamel), metallic (flake under clear coat), matte, satin
      if (finish == 1.0) { metal = 0.55; rough = 0.32; par = 1.0; alb = mix(alb, alb * 1.25 + 0.02, 0.5); }
      else if (finish == 2.0) { rough = max(rough, 0.62); par = 0.0; }
      else if (finish == 3.0) { rough = max(rough, 0.42); par = 0.35; }
    } else if (ch == 6.0 || ch == 7.0) {
      alb *= pUnpack(ch == 6.0 ? pLook.x : pLook.y);
    } else if (ch == 8.0) {
      alb *= uPropSkin[int(pBits(pLook.z, 8.0, 2.0))];
    } else if (ch == 9.0) {
      alb *= uPropCloth[int(pBits(pLook.z, 10.0, 3.0))];
    }
    vColor = vec4(alb, 1.0);
    int pid = int(aPiv.w + 0.5);
    // dust settles low on the static parts; rolling parts get an even film
    float dustW = (pid == 0 || pid == 1 || pid == 11) ? 1.0 : 0.45;
    vPMat = vec4(rough, metal, ch, par);
    vPInfo = vec4(color.a, dustW, finish, wear);
    vPRest = position;
    vPUv = uv;
    vPChain = ch == 12.0 ? pAnim.z * aMat.w : 0.0;
  }
`;

const FRAG_PARS = /* glsl */`
varying vec4 vPMat;
varying vec4 vPInfo;
varying vec3 vPRest;
varying vec2 vPUv;
varying float vPChain;
uniform sampler2D uSpokeTex;
uniform float uPropDither;   // 1 when the target has no MSAA (alpha-to-coverage would be ignored)
float pHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float pNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(pHash(i), pHash(i + vec3(1, 0, 0)), f.x), mix(pHash(i + vec3(0, 1, 0)), pHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(pHash(i + vec3(0, 0, 1)), pHash(i + vec3(1, 0, 1)), f.x), mix(pHash(i + vec3(0, 1, 1)), pHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// bump from a scalar height field h (screen-space derivatives)
vec3 pBump(vec3 pos, vec3 n, float h, float fd) {
  vec3 sx = dFdx(pos), sy = dFdy(pos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * fd;
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}
// fades a pattern of frequency f (cycles per uv unit) as it approaches the pixel size
float pFade(vec2 uv, float f) { vec2 w = fwidth(uv) * f; return 1.0 - smoothstep(0.25, 0.6, max(w.x, w.y)); }
float pTread(vec2 uv, float kind) {
  // uv.x: metres around the tyre, uv.y: metres across the profile from the crown
  float x = uv.x, y = uv.y;
  if (kind < 0.5) {            // road slick: fine file tread on the shoulders only
    float sh = smoothstep(0.006, 0.012, abs(y));
    return sh * 0.5 * sin((x * 260.0 + abs(y) * 180.0) * 6.2832) * pFade(uv, 260.0);
  } else if (kind < 1.5) {     // city: diamond knurl with a central rib
    float a = sin((x + y) * 6.2832 / 0.007), b = sin((x - y) * 6.2832 / 0.007);
    float k = smoothstep(0.1, 0.5, a * b) * pFade(uv, 1.0 / 0.007);
    float rib = 1.0 - smoothstep(0.0015, 0.003, abs(y));
    float groove = smoothstep(0.003, 0.0045, abs(y)) * (1.0 - smoothstep(0.0045, 0.006, abs(y)));
    return mix(k * 0.6, 0.8, rib) - groove * 0.7 * pFade(uv, 120.0);
  } else if (kind < 2.5) {     // knobby blocks (kids / trekking)
    vec2 c = vec2(x / 0.016, y / 0.011 + 0.5 * floor(x / 0.016));
    vec2 f = abs(fract(c) - 0.5);
    float blk = smoothstep(0.42, 0.32, max(f.x, f.y));
    return blk * pFade(uv, 1.0 / 0.011);
  }
  // moulded EVA / pram tyre: shallow circumferential grooves
  return 0.5 * sin(y * 6.2832 / 0.006) * pFade(uv, 1.0 / 0.006);
}
`;

const FRAG_COLOR = /* glsl */`
  float pCh = floor(vPMat.z + 0.5);
  float pRough = vPMat.x, pMetal = vPMat.y, pCoat = 0.0, pSheen = 0.0;
  if (pCh == 4.0) {
    diffuseColor.a = texture2D(uSpokeTex, vPUv).a;
  } else if (pCh == 5.0) {
    // wire / net grid: anti-aliased lines at cell borders, averaging to the wire density far away
    float w = vPMat.w;
    vec2 d = 0.5 - abs(fract(vPUv) - 0.5);
    vec2 fw = max(fwidth(vPUv), vec2(1e-4));
    vec2 cov = clamp((w * 0.5 - d) / fw + 0.5, 0.0, 1.0);
    cov = mix(cov, vec2(w), smoothstep(0.25, 0.7, fw));
    diffuseColor.a = 1.0 - (1.0 - cov.x) * (1.0 - cov.y);
  }
  if ((pCh == 4.0 || pCh == 5.0) && uPropDither > 0.5) {
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (diffuseColor.a <= ign) discard;
    diffuseColor.a = 1.0;
  }
  float pLink = 0.0;
  if (pCh == 12.0) {
    // roller chain: bright pin heads every half inch, dark gaps at the plate waists
    float ph = (vPUv.x + vPChain) / 0.0127;   // links run towards -u (top run forwards) when pedalling
    float wave = cos(ph * 6.2832);
    float k = pFade(vec2(ph), 1.0);
    pLink = wave * k;
    diffuseColor.rgb *= mix(1.0, 0.55 + 0.7 * smoothstep(-0.2, 0.9, wave), k);
    pRough += 0.12 * (0.5 - 0.5 * wave) * k;
  }
  if (pCh == 1.0 || pCh == 2.0) pCoat = vPMat.w;
  if (pCh == 6.0 || pCh == 7.0 || pCh == 9.0) pSheen = 1.0;
  // dust, grime and wear (Jerusalem limestone dust: pale warm grey)
  {
    float wear = vPInfo.w / 7.0;
    float low = vPInfo.y * (1.0 - smoothstep(0.05, 0.55, vPRest.y));
    float n = pNoise(vPRest * 9.0) * 0.6 + pNoise(vPRest * 37.0) * 0.4;
    float dust = clamp(wear * (0.25 + 0.75 * low) * (0.55 + 0.9 * n), 0.0, 1.0);
    if (pCh == 4.0 || pCh == 5.0) dust *= 0.5;
    if (pCh >= 6.0 && pCh <= 9.0) dust *= 0.25;
    vec3 dustC = vec3(0.36, 0.33, 0.28);
    diffuseColor.rgb = mix(diffuseColor.rgb, dustC, dust * 0.38);
    pRough = mix(pRough, 0.85, dust * 0.55);
    pCoat *= 1.0 - dust * 0.7;
    pMetal *= 1.0 - dust * 0.4;
    // paint wear: duller, finely varying gloss on painted and plastic parts
    if (pCh <= 2.0) pRough += (n - 0.5) * 0.08 * (0.5 + wear);
  }
`;

const FRAG_NORMAL = /* glsl */`
  {
    float pFd = faceDirection;
    if (pCh == 3.0) {
      float h = pTread(vPUv, vPMat.w);
      normal = pBump(-vViewPosition, normal, h * 0.0009, pFd);
    } else if (pCh == 6.0 || pCh == 7.0) {
      // fabric: fine weave + soft creases
      float wv = (sin(vPUv.x * 6.2832 / 0.0016) * sin(vPUv.y * 6.2832 / 0.0016)) * pFade(vPUv, 1.0 / 0.0016);
      float cr = pNoise(vPRest * vec3(14.0, 22.0, 14.0)) + 0.5 * pNoise(vPRest * 41.0);
      normal = pBump(-vViewPosition, normal, wv * 0.00012 + cr * 0.0035, pFd);
    } else if (pCh == 12.0) {
      normal = pBump(-vViewPosition, normal, pLink * 0.0007, pFd);
    } else if (pCh == 10.0) {
      float g = pNoise(vPRest * 900.0) * pFade(vPRest.xy, 900.0) + 0.5 * pNoise(vPRest * 160.0);
      normal = pBump(-vViewPosition, normal, g * 0.00018, pFd);
    } else if (pCh == 8.0 || pCh == 9.0) {
      float g = pNoise(vPRest * 60.0);
      normal = pBump(-vViewPosition, normal, g * 0.0008, pFd);
    }
  }
`;

const FRAG_LIGHT = /* glsl */`
  #ifdef USE_CLEARCOAT
    material.clearcoat = saturate(pCoat);
  #endif
  #ifdef USE_SHEEN
    material.sheenColor = vec3(pSheen * 0.55) * (diffuseColor.rgb * 0.7 + 0.3);
    material.sheenRoughness = 0.6;
  #endif
`;

const FRAG_AO = /* glsl */`
  reflectedLight.indirectDiffuse *= vPInfo.x;
  reflectedLight.indirectSpecular *= mix(1.0, vPInfo.x, 0.8);
  reflectedLight.directDiffuse *= mix(1.0, vPInfo.x, 0.25);
`;

function patchVertex(vs, depthOnly) {
  vs = vs.replace('#include <common>', '#include <common>\n' + VERT_PARS);
  vs = vs.replace('void main() {', 'void main() {\n' + VERT_MAIN);
  if (!depthOnly) {
    vs = vs.replace('#include <color_vertex>', VERT_COLOR);
    vs = vs.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = pR * objectNormal;');
  }
  // spoke cones and wire mesh cast no shadow (collapsed)
  const extra = depthOnly ? '\nif (floor(aMat.z + 0.5) == 4.0 || floor(aMat.z + 0.5) == 5.0) transformed = vec3(0.0);' : '';
  vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = pR * transformed + pT;' + extra);
  return vs;
}

// ---------------------------------------------------------------------------- spoke atlas

/** Spoke patterns (one flange each), 2 x 2 cells: [spokes per flange, cross count]. */
export const SPOKE_CELLS = [
  { n: 18, cross: 3 },   // 36-spoke city / trekking
  { n: 16, cross: 3 },   // 32-spoke
  { n: 12, cross: 2 },   // 24-spoke road
  { n: 10, cross: 0 },   // 20 radial (pram, small wheels)
];
export const SPOKE_RIM = 0.47;    // rim radius in cell units (cell = 0.5 x 0.5 of the atlas)
export const SPOKE_HUB = 0.045;

function makeSpokeAtlas() {
  const S = 1024, C = S / 2;
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(S, S);
  else { canvas = document.createElement('canvas'); canvas.width = canvas.height = S; }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  SPOKE_CELLS.forEach((cell, k) => {
    const cx = (k % 2) * C + C / 2, cy = Math.floor(k / 2) * C + C / 2;
    const rr = SPOKE_RIM * C, rh = SPOKE_HUB * C * 2;
    const step = (Math.PI * 2) / cell.n;
    const delta = (cell.cross * Math.PI * 2) / cell.n;   // x-cross: rim hole 720 * x / N degrees from the hub hole
    for (let i = 0; i < cell.n; i++) {
      const a = i * step;
      const lead = i % 2 ? 1 : -1;
      const b = a + lead * delta;
      // the spoke leaves the flange hole and runs straight to the rim hole
      const x0 = cx + Math.cos(a) * rh, y0 = cy + Math.sin(a) * rh;
      const x1 = cx + Math.cos(b) * rr, y1 = cy + Math.sin(b) * rr;
      g.lineWidth = 1.9;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      // nipple at the rim
      g.lineWidth = 3.4;
      const t0 = 0.94;
      g.beginPath(); g.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0); g.lineTo(x1, y1); g.stroke();
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Atlas uv for a point at (radius fraction rf of the rim, angle a) in spoke cell k. */
export function spokeUv(k, rf, a, out) {
  const cx = (k % 2) * 0.5 + 0.25, cy = Math.floor(k / 2) * 0.5 + 0.25;
  out[0] = cx + Math.cos(a) * rf * SPOKE_RIM * 0.5;
  // canvas rows run downwards; textures are flipped on upload (flipY), so v = 1 - row
  out[1] = 1 - (cy + Math.sin(a) * rf * SPOKE_RIM * 0.5);
  return out;
}

// ---------------------------------------------------------------------------- material

const SKIN = ['#e9c4a6', '#d7a682', '#a8774f', '#6b4630'];
const CLOTH = ['#f2efe6', '#9cc3e4', '#f4b6c2', '#f3dd8a', '#b9d9b0', '#6f7f99', '#d9d2c3', '#c9554f'];

let shared = null;

/** The shared prop material set {mat, depth, dist}; registered / tracked with the app's library once. */
export function propMaterials(materials = null) {
  if (shared) {
    if (materials && !shared.registered) register(materials);
    return shared;
  }
  const uniforms = {
    uSpokeTex: { value: makeSpokeAtlas() },
    uPropSkin: { value: SKIN.map((h) => new THREE.Color(h)) },
    uPropCloth: { value: CLOTH.map((h) => new THREE.Color(h)) },
    uPropDither: { value: 0 },
  };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0, vertexColors: true,
    clearcoat: 1, clearcoatRoughness: 0.06, sheen: 1, sheenRoughness: 0.6, sheenColor: 0x000000,
    specularIntensity: 1, ior: 1.5, alphaToCoverage: true,
  });
  mat.name = 'props.mobility';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchVertex(shader.vertexShader, false);
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR);
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(pRough, 0.04, 1.0);');
    fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = pMetal;');
    fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL);
    fs = fs.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + FRAG_LIGHT);
    fs = fs.replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + FRAG_AO);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'props-mobility-v1';

  const depth = new THREE.MeshDepthMaterial();
  depth.name = 'props.mobility.depth';
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchVertex(shader.vertexShader, true);
  };
  depth.customProgramCacheKey = () => 'props-mobility-depth-v1';

  const dist = new THREE.MeshDistanceMaterial();
  dist.name = 'props.mobility.distance';
  dist.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchVertex(shader.vertexShader, true);
  };
  dist.customProgramCacheKey = () => 'props-mobility-dist-v1';

  shared = { mat, depth, dist, uniforms, registered: false };
  if (materials) register(materials);
  return shared;
}

function register(materials) {
  try {
    if (materials.register) materials.register('props.mobility', shared.mat);
    else if (materials.track) materials.track(shared.mat);
    shared.registered = true;
  } catch (e) {
    console.warn('[props] material registration failed', e);
  }
}
