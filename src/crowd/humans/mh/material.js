import * as THREE from 'three';

// Shading for the MakeHuman-based cast (assets/humans_mh): a MeshStandardMaterial patched to
//   - skin from 22 runtime bones given as 3x4 row-major skin matrices (uBones, already in world space)
//   - read albedo / normal from texture arrays by the per-vertex layer (aTex.x / aTex.y)
//   - tint per region: detail layers albedo = 2 * texel * tint, colour layers texel * tint (aTex.w flag 4)
//   - alpha-tested coverage for hair cards, brows, lashes and beards (flag 1)
//   - baked ambient occlusion (aNrm.w) on the indirect light and part of the direct
// One material per figure here (uniforms per figure); the integrated renderer will move the bones and
// tints into textures for instancing.

const NB = 22;

const VERT_PARS = /* glsl */`
attribute vec4 aNrm;
attribute vec4 aBoneI;
attribute vec4 aBoneW;
attribute vec4 aTex;
uniform vec4 uBones[${NB * 3}];
uniform vec3 uHip[2];
uniform vec3 uKnee[2];
uniform vec2 uThighR[2];
varying vec2 vCastUv;
flat varying vec4 vCastTex;
varying float vCastAO;
mat4 castBone(float i) {
  int k = int(i) * 3;
  vec4 r0 = uBones[k], r1 = uBones[k + 1], r2 = uBones[k + 2];
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
void castSkin(out vec3 P, out vec3 N) {
  mat4 m = castBone(aBoneI.x) * aBoneW.x + castBone(aBoneI.y) * aBoneW.y + castBone(aBoneI.z) * aBoneW.z + castBone(aBoneI.w) * aBoneW.w;
  P = (m * vec4(position, 1.0)).xyz;
  N = normalize(mat3(m) * aNrm.xyz);
  if ((int(aTex.w + 0.5) & 8) != 0) {
    // skirts: kept outside both thigh capsules (the striding thigh pushes the cloth)
    for (int s = 0; s < 2; s++) {
      mat4 tb = castBone(s == 0 ? 14.0 : 18.0);
      vec3 a = (tb * vec4(uHip[s], 1.0)).xyz, b = (tb * vec4(uKnee[s], 1.0)).xyz;
      vec3 ab = b - a;
      float t = clamp(dot(P - a, ab) / dot(ab, ab), 0.0, 1.0);
      vec3 c = a + ab * t;
      vec3 d = P - c;
      float r = mix(uThighR[s].x, uThighR[s].y, t) + 0.018;
      float l = length(d);
      if (l < r && l > 1e-5) P = c + d * (r / l);
    }
  }
  vCastUv = uv;
  vCastTex = aTex;
  vCastAO = aNrm.w;
}
`;

const FRAG_PARS = /* glsl */`
uniform highp sampler2DArray uAlbedo;
uniform highp sampler2DArray uNormalArr;
uniform vec3 uTint[12];
uniform float uRough[64];
uniform float uHasNormal;
varying vec2 vCastUv;
flat varying vec4 vCastTex;
varying float vCastAO;
`;

export function makeCastMaterial(cast, tints, ch) {
  const uniforms = {
    uBones: { value: new Float32Array(NB * 12) },
    uAlbedo: { value: cast.albedo },
    uNormalArr: { value: cast.normal || cast.albedo },
    uHasNormal: { value: cast.normal ? 1 : 0 },
    uTint: { value: Array.from({ length: 12 }, () => new THREE.Vector3(1, 1, 1)) },
    uRough: { value: Array.from({ length: 64 }, (_, i) => cast.layerRough[i] ?? 0.7) },
    uHip: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uKnee: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uThighR: { value: [new THREE.Vector2(0.08, 0.05), new THREE.Vector2(0.08, 0.05)] },
  };
  setTints(uniforms, tints, cast.doc.regions);
  if (ch) {
    const J = ch.skeleton.joints;
    uniforms.uHip.value[0].fromArray(J[14]); uniforms.uKnee.value[0].fromArray(J[15]);
    uniforms.uHip.value[1].fromArray(J[18]); uniforms.uKnee.value[1].fromArray(J[19]);
    if (ch.info.thigh) { uniforms.uThighR.value[0].fromArray(ch.info.thigh.L); uniforms.uThighR.value[1].fromArray(ch.info.thigh.R); }
  }

  const patchV = (shader, depth) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS);
    if (depth) {
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 cP, cN; castSkin(cP, cN);\nvec3 transformed = cP;');
    } else {
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', 'vec3 cP, cN; castSkin(cP, cN);\nvec3 objectNormal = cN;')
        .replace('#include <begin_vertex>', 'vec3 transformed = cP;');
    }
  };

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 });
  mat.name = 'humans.mhcast';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchV(shader, false);
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
    fs = fs.replace('#include <map_fragment>', /* glsl */`
      vec4 castTexel = texture(uAlbedo, vec3(vCastUv, vCastTex.x));
      int castFlags = int(vCastTex.w + 0.5);
      if ((castFlags & 1) != 0 && castTexel.a < 0.5) discard;
      vec3 castTint = uTint[int(vCastTex.z + 0.5)];
      diffuseColor.rgb = castTexel.rgb * castTint * ((castFlags & 4) != 0 ? 2.0 : 1.0);
    `);
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = uRough[int(vCastTex.x + 0.5)];');
    fs = fs.replace('#include <normal_fragment_maps>', /* glsl */`
      if (uHasNormal > 0.5 && vCastTex.y < 254.5) {
        vec3 nm = texture(uNormalArr, vec3(vCastUv, vCastTex.y)).xyz * 2.0 - 1.0;
        vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
        vec2 st0 = dFdx(vCastUv), st1 = dFdy(vCastUv);
        vec3 q1perp = cross(q1, normal), q0perp = cross(normal, q0);
        vec3 T = q1perp * st0.x + q0perp * st1.x;
        vec3 B = q1perp * st0.y + q0perp * st1.y;
        float det = max(dot(T, T), dot(B, B));
        float sc = det == 0.0 ? 0.0 : inversesqrt(det);
        normal = normalize(T * (nm.x * sc) + B * (nm.y * sc) + normal * nm.z);
      }
    `);
    fs = fs.replace('#include <aomap_fragment>', /* glsl */`#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= vCastAO;
      reflectedLight.indirectSpecular *= vCastAO;
      reflectedLight.directDiffuse *= mix(1.0, vCastAO, 0.3);
    `);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'mhcast-v1';

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.name = 'humans.mhcast.depth';
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchV(shader, true);
    shader.vertexShader = shader.vertexShader.replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>');
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\nuniform highp sampler2DArray uAlbedo;\nvarying vec2 vCastUv;\nflat varying vec4 vCastTex;\nvarying float vCastAO;');
    fs = fs.replace('#include <alphatest_fragment>', /* glsl */`
      if ((int(vCastTex.w + 0.5) & 1) != 0 && texture(uAlbedo, vec3(vCastUv, vCastTex.x)).a < 0.5) discard;
    `);
    shader.fragmentShader = fs;
  };
  depth.customProgramCacheKey = () => 'mhcast-depth-v1';
  return { mat, depth, uniforms };
}

export function setTints(uniforms, tints, regions) {
  for (const [name, id] of Object.entries(regions)) {
    const t = tints[name];
    if (t) uniforms.uTint.value[id].set(t[0], t[1], t[2]);
  }
}
