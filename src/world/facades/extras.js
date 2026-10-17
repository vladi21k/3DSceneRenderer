// Small wall fittings: iron wall lanterns beside entrances, gooseneck lamps over shop
// signs, intercom panels. Built once (shared templates) in local coordinates with the
// wall face at z = 0.
import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { Tpl } from './geo.js';

/** Global night emissive gain of the material library (1 when unavailable). */
export const emissiveGain = (M) => (M && M.uniforms && M.uniforms.emissiveGain) || { value: 1 };

/**
 * Clear lantern glass: mostly transparent (premultiplied blending: the reflection is added
 * at full strength while what lies behind is only dimmed by the Fresnel share), so the
 * bulb, the holder and the far-side bars show through. A faint warm haze at dusk.
 */
export function createLampGlass(M) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.9, 0.9, 0.88), roughness: 0.05, metalness: 0,
    transparent: true, premultipliedAlpha: true, depthWrite: false,
  });
  m.name = 'facades.lampGlass';
  const gain = emissiveGain(M);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = U.uNight;
    shader.uniforms.uEmGain = gain;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uEmGain;')
      .replace('#include <opaque_fragment>', `
float fNVl = saturate( abs( dot( normal, normalize( vViewPosition ) ) ) );
float aGl = 0.09 + 0.6 * pow( 1.0 - fNVl, 5.0 );
vec3 hazeL = vec3( 1.0, 0.62, 0.32 ) * 0.0008 * smoothstep( 0.15, 0.7, uNight ) * uEmGain;
gl_FragColor = vec4( totalDiffuse * 0.04 + totalSpecular + hazeL, aGl );`)
      .replace('#include <premultiplied_alpha_fragment>', '');
  };
  m.customProgramCacheKey = () => 'facades.lampGlass.v3';
  return m;
}

/** Lamp bulbs (frosted, ~2700 K) and the lit undersides of sign lamps: emissive from dusk. */
export function createBulbMaterial(M) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.85, 0.84, 0.8), roughness: 0.35, metalness: 0 });
  m.name = 'facades.bulb';
  m.emissive = new THREE.Color(1.0, 0.62, 0.31);
  const gain = emissiveGain(M);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = U.uNight;
    shader.uniforms.uEmGain = gain;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uEmGain;')
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * smoothstep( 0.15, 0.7, uNight ) * 0.03 * uEmGain;');
  };
  m.customProgramCacheKey = () => 'facades.bulb.v2';
  return m;
}

/** Small faceted sphere (radius r) around c. */
function bulb(t, c, r) {
  const n = 8, rings = 3;
  const P = (i, j) => {
    const th = Math.PI * (0.14 + (0.86 * j) / rings), ph = (2 * Math.PI * i) / n; // open at the cap
    return [c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.cos(th), c[2] + r * Math.sin(th) * Math.sin(ph)];
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < n; i++) {
      const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), d = P(i, j + 1);
      t.quad(a, b, cc, d, 1, 1);
    }
  }
}

function tube(t, a, b, s, shade = 0.9) {
  // square tube between 3D points a and b (side s), used for small iron arms
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1;
  const d = [dx / L, dy / L, dz / L];
  let r = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const p = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
  const pl = Math.hypot(...p); p[0] /= pl; p[1] /= pl; p[2] /= pl;
  r = [p[1] * d[2] - p[2] * d[1], p[2] * d[0] - p[0] * d[2], p[0] * d[1] - p[1] * d[0]];
  const h = s / 2;
  const c = (q, u, v) => [q[0] + r[0] * u + p[0] * v, q[1] + r[1] * u + p[1] * v, q[2] + r[2] * u + p[2] * v];
  const k4 = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (let k = 0; k < 4; k++) {
    const [u0, v0] = k4[k], [u1, v1] = k4[(k + 1) % 4];
    t.quad(c(a, u0, v0), c(b, u0, v0), c(b, u1, v1), c(a, u1, v1), shade);
  }
}

/** Hexagonal-ish lantern on a scroll bracket: {metal, glass} templates. Origin: wall plate centre. */
export function lanternTpls(q) {
  const m = new Tpl(), g = new Tpl();
  m.box(-0.05, -0.1, 0, 0.05, 0.1, 0.02, 1 | 4 | 8 | 16 | 32, 0.85, 1);      // wall plate
  tube(m, [0, 0.0, 0.02], [0, 0.0, 0.34], 0.025);                          // arm
  if (q >= 0.5) {
    tube(m, [0, -0.08, 0.02], [0, -0.01, 0.2], 0.016);                     // brace
    // curl under the arm
    let prev = [0, -0.01, 0.2];
    for (let k = 1; k <= 6; k++) {
      const a = (k / 6) * Math.PI * 1.4, r = 0.05 * (1 - k / 9);
      const pt = [0, -0.06 + Math.cos(a) * r, 0.25 + Math.sin(a) * r];
      tube(m, prev, pt, 0.012); prev = pt;
    }
  }
  // lantern hanging from the arm end at z = 0.34
  const cz = 0.34, top = -0.04, h = 0.32, w0 = 0.09, w1 = 0.065;
  tube(m, [0, 0.0, cz], [0, top, cz], 0.012);
  m.box(-w0 - 0.015, top - 0.04, cz - w0 - 0.015, w0 + 0.015, top, cz + w0 + 0.015, 1 | 2 | 4 | 8 | 16 | 32, 0.9, 1); // cap
  m.box(-w1 - 0.01, top - h - 0.03, cz - w1 - 0.01, w1 + 0.01, top - h, cz + w1 + 0.01, 1 | 2 | 4 | 8 | 16 | 32, 0.85, 0.9); // base
  // corner posts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) tube(m, [sx * w0, top - 0.04, cz + sz * w0], [sx * w1, top - h, cz + sz * w1], 0.012);
  // glass panes (tapered box)
  const yT = top - 0.04, yB = top - h;
  const P = (sx, y, sz, w) => [sx * w, y, cz + sz * w];
  g.quad(P(-1, yB, 1, w1), P(1, yB, 1, w1), P(1, yT, 1, w0), P(-1, yT, 1, w0));
  g.quad(P(1, yB, -1, w1), P(-1, yB, -1, w1), P(-1, yT, -1, w0), P(1, yT, -1, w0));
  g.quad(P(1, yB, 1, w1), P(1, yB, -1, w1), P(1, yT, -1, w0), P(1, yT, 1, w0));
  g.quad(P(-1, yB, -1, w1), P(-1, yB, 1, w1), P(-1, yT, 1, w0), P(-1, yT, -1, w0));
  // lamp holder hanging from the cap, and the bulb
  const b = new Tpl();
  const yc = top - 0.15;
  m.box(-0.012, yc + 0.03, cz - 0.012, 0.012, top - 0.04, cz + 0.012, 1 | 2 | 4 | 8, 0.8, 0.9);
  bulb(b, [0, yc, cz], q >= 0.5 ? 0.028 : 0.035);
  return { metal: m.bake(), glass: g.bake(), bulb: b.bake() };
}

/** Gooseneck sign lamp: arm from the wall curving forward and down. */
export function signLampTpls(q) {
  const m = new Tpl(), g = new Tpl();
  m.box(-0.035, -0.035, 0, 0.035, 0.035, 0.015, 1 | 4 | 8 | 16 | 32, 0.85, 1);
  const n = q >= 0.5 ? 6 : 2;
  let prev = [0, 0, 0.015];
  for (let k = 1; k <= n; k++) {
    const a = (k / n) * (Math.PI / 2);
    const pt = [0, 0.25 * Math.sin(a) * 0.6, 0.015 + 0.42 * (1 - Math.cos(a)) + 0.1 * Math.sin(a)];
    tube(m, prev, pt, 0.016); prev = pt;
  }
  // shade: a short downward-tilted box with the lit opening underneath
  const [x, y, z] = prev;
  m.box(x - 0.06, y - 0.03, z - 0.02, x + 0.06, y + 0.03, z + 0.12, 1 | 2 | 4 | 8 | 32, 0.85, 1);
  g.quad([x - 0.055, y - 0.031, z - 0.015], [x + 0.055, y - 0.031, z - 0.015], [x + 0.055, y - 0.031, z + 0.115], [x - 0.055, y - 0.031, z + 0.115]);
  return { metal: m.bake(), glass: g.bake() };
}

/** Brushed-steel intercom panel with buttons (hardware batch). */
export function intercomTpl(q, rows = 4) {
  const t = new Tpl();
  const w = 0.12, h = 0.08 + rows * 0.035;
  t.box(-w / 2, -h / 2, 0, w / 2, h / 2, 0.02, 1 | 4 | 8 | 16 | 32, 0.95, 1);
  if (q >= 0.5) {
    t.box(-0.035, h / 2 - 0.06, 0.02, 0.035, h / 2 - 0.02, 0.024, 1, 0.3, 0.3);   // speaker grille (dark)
    for (let r = 0; r < rows; r++) {
      const y = h / 2 - 0.085 - r * 0.035;
      t.box(-0.045, y - 0.01, 0.02, 0.025, y + 0.01, 0.023, 1, 0.75, 0.75);       // name strip
      t.box(0.032, y - 0.009, 0.02, 0.05, y + 0.009, 0.028, 1 | 32, 1, 1);             // button
    }
  }
  return t.bake();
}
