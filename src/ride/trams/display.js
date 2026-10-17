import * as THREE from 'three';

// Lamp atlas of the line's trams (canvas, mipmapped): the amber LED destination display
// (a 160 × 16 dot matrix: line number, destination) and a lens patch for the head / tail
// lamps (bright core, rim fall-off). Unlit material: vertex colour × atlas × level.

const W = 1024, H = 128;
const COLS = 160, ROWS = 16, PITCH = 5;     // display: 800 × 80 px

// 5 × 7 dot-matrix font (rows top to bottom, 5 bits, MSB = left)
export const FONT = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31],
  3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12], ' ': [0, 0, 0, 0, 0, 0, 0], '-': [0, 0, 0, 31, 0, 0, 0],
};

/** Lit dots of the display: line number (double width) and the destination, 7-row glyphs drawn 2 rows tall. */
function dots(line, dest) {
  const on = new Uint8Array(COLS * ROWS);
  const put = (c, r) => { if (c >= 0 && c < COLS && r >= 0 && r < ROWS) on[r * COLS + c] = 1; };
  const glyph = (ch, c0, wx) => {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 7; r++) {
      for (let b = 0; b < 5; b++) {
        if (!(g[r] & (16 >> b))) continue;
        for (let dx = 0; dx < wx; dx++) { put(c0 + b * wx + dx, 1 + r * 2); put(c0 + b * wx + dx, 2 + r * 2); }
      }
    }
  };
  let c = 3;
  for (const ch of line) { glyph(ch, c, 2); c += 12; }
  const w = dest.length * 6 - 1, x0 = Math.round(c + 4 + (COLS - c - 4 - w) / 2);
  for (let k = 0; k < dest.length; k++) glyph(dest[k], x0 + k * 6, 1);
  return on;
}

/**
 * Canvas atlas for one destination. Returns {texture, display: [u0, v0, u1, v1], lens: [...]}
 * (uv rectangles; v up). Falls back to a plain amber strip without a 2D canvas.
 */
export function makeLampAtlas(line = '1', dest = 'CENTRAL STATION') {
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const g = cv && cv.getContext('2d');
  if (g) {
    cv.width = W; cv.height = H;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const on = dots(line, dest);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const lit = on[r * COLS + c];
        g.fillStyle = lit ? 'rgb(255,150,40)' : 'rgb(20,13,8)';     // unlit LEDs are faintly visible
        g.beginPath();
        g.arc(c * PITCH + PITCH / 2, r * PITCH + PITCH / 2, lit ? 2.0 : 1.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    // lens: bright core with a falling rim, a little structure (LED lens rings)
    const lx = 832, ly = 0, ls = 128;
    const grd = g.createRadialGradient(lx + ls / 2, ly + ls / 2, 4, lx + ls / 2, ly + ls / 2, ls / 2);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.45, '#fdfdfd'); grd.addColorStop(0.62, '#c8c8c8');
    grd.addColorStop(0.8, '#6a6a6a'); grd.addColorStop(1, '#262626');
    g.fillStyle = grd;
    g.fillRect(lx, ly, ls, ls);
  }
  const texture = g ? new THREE.CanvasTexture(cv) : new THREE.DataTexture(new Uint8Array([255, 150, 40, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = !!g;
  texture.minFilter = g ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.needsUpdate = true;
  const v = (y) => 1 - y / H;
  return {
    texture,
    display: g ? [0, v(ROWS * PITCH), (COLS * PITCH) / W, v(0)] : [0, 0, 1, 1],
    lens: g ? [832 / W, v(128), 960 / W, v(0)] : [0, 0, 1, 1],
  };
}
