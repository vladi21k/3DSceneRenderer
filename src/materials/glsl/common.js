// GLSL shared by the texture baker and the runtime surface shaders.
//
// Everything here must produce bit-identical results in both places: the runtime
// shader re-derives the block / paver layout analytically (for per-cell colour
// variation and anti-tiling) and has to agree with what was baked into the maps.

export const HASH_GLSL = /* glsl */ `
// lowbias32 integer hash
uint sfH(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
// ints are offset to stay positive before the uint conversion
uint sfH2(int a, int b, uint s) { return sfH(uint(a + 0x20000000) ^ sfH(uint(b + 0x20000000) + sfH(s))); }
float sfHf(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
float sfHash(ivec2 p, uint s) { return sfHf(sfH2(p.x, p.y, s)); }
int sfMod(int a, int m) { return a - m * int(floor(float(a) / float(m))); }
`;

// Row layout: rows of height rowH stacked along v, each row split along u into
// n (per-row random in [segMin, segMax]) segments with jittered boundaries.
// Periodic in u with the tile width W and in rows with the row count.
//   lay  = (rowH, rows, segMin, segMax)
//   lay2 = (jitter, seed, shiftRows, rowJoints)
export const LAYOUT_GLSL = /* glsl */ `
int sfSegN(int r, vec4 lay, vec4 lay2) {
  int lo = int(lay.z), hi = int(lay.w);
  return lo + int(floor(sfHash(ivec2(r, 977), uint(lay2.y)) * float(hi - lo + 1) * 0.99999));
}
float sfSegB(int r, int k, int n, float L, vec4 lay2) {
  return (float(k) + lay2.x * (sfHash(ivec2(r, sfMod(k, n)), uint(lay2.y) + 31u) - 0.5)) * L;
}
// segment k containing x in row r (x any real, periodic in W); boundaries b0 <= x < b1
void sfRowSeg(int r, float x, float W, vec4 lay, vec4 lay2, out int k, out float b0, out float b1, out int n) {
  n = sfSegN(r, lay, lay2);
  float L = W / float(n);
  int k0 = int(floor(x / L));
  float a = sfSegB(r, k0, n, L, lay2), b = sfSegB(r, k0 + 1, n, L, lay2);
  if (x < a) { k = k0 - 1; b1 = a; b0 = sfSegB(r, k0 - 1, n, L, lay2); }
  else if (x >= b) { k = k0 + 1; b0 = b; b1 = sfSegB(r, k0 + 2, n, L, lay2); }
  else { k = k0; b0 = a; b1 = b; }
}
// random u shift of a whole (global) row: breaks the 2D repetition of the tile
float sfRowShift(int rowGlobal, vec4 lay2) { return sfHash(ivec2(rowGlobal, 4111), uint(lay2.y) + 7u); }
`;

// Bake-only noise library. Coordinates are metres inside the tile (uTile); every
// function is periodic over the tile so the baked maps wrap seamlessly.
export const NOISE_GLSL = /* glsl */ `
uniform vec2 uTile;   // tile size (m)
uniform vec2 uRes;    // target size (px)
uniform vec4 uLay;    // row layout (see LAYOUT_GLSL)
uniform vec4 uLay2;

ivec2 sfMod2(ivec2 a, ivec2 m) { return ivec2(sfMod(a.x, m.x), sfMod(a.y, m.y)); }
vec2 sfGrad(ivec2 p, uint s) { float a = sfHash(p, s) * 6.2831853; return vec2(cos(a), sin(a)); }
vec2 hash22(ivec2 p, uint s) { uint h = sfH2(p.x, p.y, s); return vec2(sfHf(h), sfHf(sfH(h))); }
float sat(float x) { return clamp(x, 0.0, 1.0); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// periodic gradient noise, ~[-1, 1]
float gnoiseP(vec2 x, ivec2 per, uint s) {
  vec2 i = floor(x), f = x - i;
  ivec2 p = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(sfGrad(sfMod2(p, per), s), f);
  float b = dot(sfGrad(sfMod2(p + ivec2(1, 0), per), s), f - vec2(1.0, 0.0));
  float c = dot(sfGrad(sfMod2(p + ivec2(0, 1), per), s), f - vec2(0.0, 1.0));
  float d = dot(sfGrad(sfMod2(p + ivec2(1, 1), per), s), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.414;
}
ivec2 sfPer(vec2 freq) { return max(ivec2(1), ivec2(floor(uTile * freq + 0.5))); }
// single octave in metres at (approximately) freq cycles per metre
float noiseM(vec2 m, vec2 freq, uint s) { ivec2 per = sfPer(freq); return gnoiseP(m / uTile * vec2(per), per, s); }
// fbm in metres, freq = base cycles per metre (per axis), ~[-1, 1]
float fbm2(vec2 m, vec2 freq, int oct, float gain, uint s) {
  float a = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += a * noiseM(m, freq, s + uint(i) * 1013u);
    norm += a; freq *= 2.0; a *= gain;
  }
  return sum / norm;
}
float fbm(vec2 m, float freq, int oct, float gain, uint s) { return fbm2(m, vec2(freq), oct, gain, s); }
float ridged(vec2 m, vec2 freq, int oct, uint s) {
  float a = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += a * (1.0 - abs(noiseM(m, freq, s + uint(i) * 977u)));
    norm += a; freq *= 2.0; a *= 0.5;
  }
  return sum / norm;
}
// periodic Voronoi in metres: (F1, F2, cell hash, F2 - F1); distances in cell units
vec4 voro(vec2 m, vec2 freq, uint s, float jit) {
  ivec2 per = sfPer(freq);
  vec2 x = m / uTile * vec2(per);
  vec2 i = floor(x), f = x - i;
  ivec2 p = ivec2(i);
  float F1 = 8.0, F2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    ivec2 cw = sfMod2(p + ivec2(xx, y), per);
    vec2 o = hash22(cw, s) * jit + 0.5 * (1.0 - jit);
    vec2 d = vec2(float(xx), float(y)) + o - f;
    float dd = dot(d, d);
    if (dd < F1) { F2 = F1; F1 = dd; id = sfHash(cw, s + 7u); } else if (dd < F2) { F2 = dd; }
  }
  F1 = sqrt(F1); F2 = sqrt(F2);
  return vec4(F1, F2, id, F2 - F1);
}
// like voro() but also returns the vector from m to the nearest feature point (m)
vec4 voroV(vec2 m, vec2 freq, uint s, float jit, out vec2 toC) {
  ivec2 per = sfPer(freq);
  vec2 cell = uTile / vec2(per);
  vec2 x = m / cell;
  vec2 i = floor(x), f = x - i;
  ivec2 p = ivec2(i);
  float F1 = 8.0, F2 = 8.0, id = 0.0;
  toC = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    ivec2 cw = sfMod2(p + ivec2(xx, y), per);
    vec2 o = hash22(cw, s) * jit + 0.5 * (1.0 - jit);
    vec2 d = vec2(float(xx), float(y)) + o - f;
    float dd = dot(d, d);
    if (dd < F1) { F2 = F1; F1 = dd; id = sfHash(cw, s + 7u); toC = d * cell; } else if (dd < F2) { F2 = dd; }
  }
  F1 = sqrt(F1); F2 = sqrt(F2);
  return vec4(F1, F2, id, F2 - F1);
}
vec2 warp(vec2 m, float freq, float amp, uint s) {
  return m + amp * vec2(fbm(m, freq, 3, 0.5, s), fbm(m, freq, 3, 0.5, s + 57u));
}

// ---- row layout cell (bake side)
struct Cell {
  int r;        // local row
  int k;        // segment index (unwrapped)
  int n;        // segments in this row
  vec2 lp;      // position inside the cell from its lower-left corner (m)
  vec2 size;    // cell size (m)
  vec4 ed;      // distance to left, right, bottom, top edge (m)
  float e;      // distance to the nearest joint (m)
  uint id;      // per-cell hash
  float h;      // per-cell random [0,1)
};
Cell rowsCell(vec2 m) {
  Cell c;
  float rowH = uLay.x;
  int rows = int(uLay.y);
  float rf = floor(m.y / rowH);
  c.r = sfMod(int(rf), rows);
  float b0, b1;
  sfRowSeg(c.r, m.x, uTile.x, uLay, uLay2, c.k, b0, b1, c.n);
  c.lp = vec2(m.x - b0, m.y - rf * rowH);
  c.size = vec2(b1 - b0, rowH);
  c.ed = vec4(c.lp.x, c.size.x - c.lp.x, c.lp.y, c.size.y - c.lp.y);
  c.e = uLay2.w > 0.5 ? min(min(c.ed.x, c.ed.y), min(c.ed.z, c.ed.w)) : min(c.ed.x, c.ed.y);
  c.id = sfH2(c.r, sfMod(c.k, c.n), uint(uLay2.y) + 101u);
  c.h = sfHf(c.id);
  return c;
}
float cellRand(Cell c, uint i) { return sfHf(sfH(c.id + i * 0x9e3779b9u)); }
`;
