import * as THREE from 'three';

// Global uniforms shared by custom shaders (inject them in onBeforeCompile:
//   shader.uniforms.uTime = U.uTime;  etc.). Owned/updated by core + env.
export const U = {
  uTime: { value: 0 },                          // seconds since start (frozen when freeze=1)
  uWind: { value: new THREE.Vector2(0.8, 0.6) },  // horizontal wind direction (unit, xz)
  uWindStrength: { value: 0.35 },               // 0 calm .. 1 strong gusts (gusting animated by env)
  uNight: { value: 0 },                         // 0 day .. 1 full night: drives lamp / shop / window emissives
  uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.2) }, // towards the sun (world)
  uSunColor: { value: new THREE.Color(1, 1, 1) },       // linear, includes intensity
  uCameraPos: { value: new THREE.Vector3() },
  uSpeed: { value: 0 },                         // tram speed m/s
};
