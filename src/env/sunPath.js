import * as THREE from 'three';

// Time of day → sun position. Real solar geometry for a Mediterranean city in early
// September (latitude 31.8° N, declination +7°), with t mapped onto the afternoon:
//   t 0 ≈ 13:05 (elev ~61°), 0.3 ≈ 15:30 (35°), 0.55 ≈ 17:30 (10°, golden hour),
//   0.8 ≈ 18:20 (sunset, 0°), 1 ≈ 18:45 (civil twilight, −6°).
// The compass is fixed so the main avenue runs towards azimuth ~297°: at golden hour
// the sun sits ~25° left of the direction of travel, raking along the right-hand
// facades and filling the far end of the street with backlit haze; at midday it is
// high on the left, so the left buildings throw their shadows across the street.

const DEG = Math.PI / 180;
const LAT = 31.8 * DEG;
const DECL = 7.0 * DEG;
export const AVENUE_AZIMUTH = 297; // compass azimuth (deg) of the direction of travel on the main avenue

// t → hour angle (deg), monotone cubic through these keys
const KEYS = [[0, 16.1], [0.3, 52.85], [0.55, 82.5], [0.8, 94.4], [1, 101.5]];

function hermiteKeys(keys, t) {
  t = THREE.MathUtils.clamp(t, keys[0][0], keys[keys.length - 1][0]);
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [x0, y0] = keys[i], [x1, y1] = keys[i + 1];
  const slope = (j) => {
    if (j <= 0) return (keys[1][1] - keys[0][1]) / (keys[1][0] - keys[0][0]);
    if (j >= keys.length - 1) { const n = keys.length - 1; return (keys[n][1] - keys[n - 1][1]) / (keys[n][0] - keys[n - 1][0]); }
    const a = (keys[j][1] - keys[j - 1][1]) / (keys[j][0] - keys[j - 1][0]);
    const b = (keys[j + 1][1] - keys[j][1]) / (keys[j + 1][0] - keys[j][0]);
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b); // harmonic mean keeps it monotone
  };
  const h = x1 - x0, u = (t - x0) / h;
  const m0 = slope(i) * h, m1 = slope(i + 1) * h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * m1;
}

/** Solar elevation and compass azimuth (radians, azimuth clockwise from north) for t. */
export function solarPosition(t) {
  const H = hermiteKeys(KEYS, t) * DEG;
  const sinE = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
  const elev = Math.asin(sinE);
  // azimuth measured from south, positive towards west
  const A = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(DECL) * Math.cos(LAT));
  return { elevation: elev, azimuth: Math.PI + A, hourAngle: H };
}

/**
 * World-space direction towards the sun. `fwd`/`right` are the avenue's horizontal
 * travel and right-hand directions at the reference point.
 */
export function sunDirection(t, fwd, right, out = new THREE.Vector3()) {
  const { elevation, azimuth } = solarPosition(t);
  const rel = azimuth - AVENUE_AZIMUTH * DEG; // + clockwise = to the right of travel
  const ch = Math.cos(elevation);
  out.set(0, 0, 0)
    .addScaledVector(fwd, ch * Math.cos(rel))
    .addScaledVector(right, ch * Math.sin(rel));
  out.y = Math.sin(elevation);
  return out.normalize();
}
