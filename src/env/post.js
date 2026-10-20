import * as THREE from 'three';
import * as S from './postShaders.js';

// Post-processing: HDR scene (HalfFloat, MSAA, sub-pixel jitter) → half-res SSAO →
// half-res volumetric clouds → scene prepass (clouds over the sky, AO, aerial
// perspective, heat shimmer, dusk airlight, circle of confusion; broken pixels filled
// and the range clamped) → temporal anti-aliasing → depth-of-field gather → camera
// motion blur → bloom pyramid → metered exposure → glow around sources far above white
// (dusk) → lens, in-camera sharpening, white balance, camera tone curve (AgX colour), grain.
// Contract in docs/ARCHITECTURE.md: render(dt, app), setSize(w, h).

const QUALITY = {
  low: { msaa: 0, ao: 0, dof: false, levels: 5, shimmer: false, lamps: 4, blur: false },
  med: { msaa: 4, ao: 8, dof: true, levels: 6, shimmer: true, lamps: 6, blur: true },
  high: { msaa: 4, ao: 16, dof: true, levels: 6, shimmer: true, lamps: 8, blur: true },
};

// Depth of field, for a 1"-type sensor (a typical cab-ride camcorder: deep focus at
// these focal lengths). Daylight is shot stopped down (f/8) and focused near the
// hyperfocal distance, sharp front to back; the lens opens up and the focus moves down
// the street as the light fades. Focus pulls in when the tram stands at a stop (people
// on the platform), and in daylight the blur of anything nearer is capped at a soft
// couple of pixels.
const F_DAY = 8, F_DUSK = 2.8;
const SENSOR_H_MM = 8.8;
const FOCUS_RIDE = [16, 45], FOCUS_STOP = [13, 22];   // focus distance (m) at speed / standing: day, dusk
// circle of confusion a 1080p camcorder still renders sharp (px): by day, focused near
// the hyperfocal distance, everything from ~7 m to the horizon stays crisp
const COC_TOL = [0.5, 0.15];
const COC_MAX = [2.5, 8];                  // largest circle of confusion (px): day, dusk

// Camera motion blur: at most this many pixels of streak (1080p), and none below
// half a pixel (the pass is skipped when the camera is still).
const BLUR_MAX_PX = 32;
// mover slots the oncoming trams may take (two per unit); the riding cyclists fill the rest
const TRAM_MOVERS = 4;

// Heat shimmer: angular offset of a ray grazing the hot paving far away (rad; the noise
// reaches about 1.5x this).
const SHIMMER_RAD = 1.5e-4;

// HDR clamp before the blur chains: far above white after any exposure, but it keeps a
// single specular spark from ringing through the bloom pyramid.
const HDR_CLAMP = 64;

// Screen-space AO: world radius and strength; the baked AO in the materials is scaled
// down while it runs so contact darkening isn't counted twice.
const AO = { radius: 0.75, intensity: 0.75, strength: 0.85, bakedScale: 0.6 };

// Camera response (final pass). curve: display value of a scene luminance, a generalised
// logistic in stops from mid grey fitted to a camera JPEG's soft shoulder (0 → 0.47,
// +2 → 0.85, +3 → 0.98, white at about +3.2), its toe eased by `toe` and `black` below;
// chroma: AgX's colour (0) .. the scene's ratios (1), day .. low sun.
// Auto exposure: the metered log-average is pulled towards `target` with strength `meter`,
// within `clamp`; by day the exposure follows the incident light (sunny-16) and the meter
// only nudges it, from the low sun on the camera meters the scene: [day, evening].
// bloom: share of the blurred pyramid (glare around bright things), day .. night.
// veil: share of the frame's mean light the lens spreads evenly (lifts the blacks), plus
// `veilSun` of the sun's illuminance when it shines on the lens from just outside the frame.
const TONE = {
  curve: [1.1738, 0.6941, 0.8164, 0.8985], chroma: [0.7, 0.9],
  meter: [0.3, 0.6], target: [0.25, 0.32], backlit: 0.85,
  clampLo: [0.75, 0.5], clampHi: [1.6, 4], bloom: [0.018, 0.04], tail: 0.016, vignette: 0.25, sharpen: 0.8,
  veil: 0.006, veilSun: 0.0012,
  // highlight recovery: knee (stops over mid grey; time of day, knee) and the log slope
  // above it (time of day, slope): none at midday, then a phone camera's highlight tone
  // mapping as the sun lowers and the sky outshines the street. By day the knee sits high
  // (sunlit stone and the sky slot reach 230-248), lower as the sky outshines the street
  // (a camera keeps its dynamic range in the evening: the sky over a shaded street blows
  // out and the sunlit stone reaches the shoulder, rather than everything being fitted onto
  // the curve)
  hiKnee: [[0.3, 1.6], [0.55, 1.2], [0.8, 1.0]],
  hiSlope: [[0.15, 1], [0.3, 0.5], [0.55, 0.66], [0.8, 0.5], [0.9, 0.5], [1.0, 0.6]],
  // the hard light of midday is shot with a little more contrast above a pivot just over
  // mid grey (the highlights separate; the shade keeps the toe), easing off towards golden
  // hour: the blacks come from the curve, not from underexposure
  midday: 1.12, pivot: 0.3,
  // soft black point (display units; time of day, black): by day and through sunset the
  // deepest shade, window recesses and dark clothes sit near black as in a camera JPEG;
  // less once the light is lamps and sky
  black: [[0.6, 0.043], [0.85, 0.043], [0.95, 0.018]],
  // toe: below about mid grey the curve's log slope eases off by `toe[0]` (over `toe[2]`
  // stops around `toe[1]`), a camera's long toe (building shade and dark shop glass keep
  // their detail; mid grey and up unchanged); below about `deep[1]` stops the slope rises
  // again by `deep[0]` (by day .. dusk; over `deep[2]` stops), so the deepest shade falls
  // towards black as in a camera JPEG: by day −1 stop ~77 sRGB, −2 ~43, −2.5 ~29, −3 ~17,
  // −4 ~5, −5 ~1 (the photographs' darkest 2 % sit at 3-40, median 13); the lamp-lit night
  // keeps more of its shadow detail
  toe: [0.22, 0.06, 0.5],
  // deep: [(time of day, slope increase), (time of day, centre in stops), width]. Steeper
  // and a little higher from golden hour to sunset, when the street lies in shade under
  // a bright sky: dark clothes and hair, canopy undersides and doorways fall to 10-30 sRGB
  // as in the evening photographs instead of hanging in a milky grey. Steepest under the
  // high sun: the hard light's shade under the crowns and awnings, dark clothes and hair
  // fall to ~15-30 sRGB as in the midday photographs (their darkest 2 % sit at 3-40, median
  // 13), so the midday exposure's lift (env EXPO_LIFT) brightens the street, not its blacks
  deep: [[[0.15, 1.6], [0.5, 1.35], [0.85, 1.35], [1.0, 0.3]], [[0.3, -1.8], [0.5, -1.5], [0.85, -1.5], [1.0, -1.8]], 0.5],
  // local highlight recovery (final pass): where the surfaces around a pixel average more
  // than `knee` stops over mid grey (a low sun's sheen on the paving, looking into it), its
  // bright pixels (ramped in from `px[0]` stops over `px[1]`) come down by `strength` x the
  // excess. Sunlit stone and paving at the usual angles stay below the knee
  local: { knee: 2.5, strength: 1.0, px: [2.0, 1.5] },
  // gamut knee (time of day, [start, ceiling] of the brightest channel for the street, then
  // for the saturated sky): under the high sun a camera JPEG (the blue of the sky and the
  // brightest whites clip, about 1.5-6.5 % of the frame from the telephoto to a 40-degree
  // lens, as in the midday photographs, 0.05-11.6 %); from golden hour
  // the street's colour eases off a little earlier (golden stone and the backlit glow keep
  // their hue); from sunset on the ceilings come down (amber lamps, afterglow bands keep
  // their hue)
  knee: [[0.45, [0.84, 1.0, 0.84, 1.0]], [0.55, [0.78, 1.0, 0.84, 1.0]], [0.6, [0.78, 1.0, 0.84, 1.0]], [0.75, [0.8, 0.94, 0.72, 0.86]]],
  // saturation of the street's final colour (time of day, saturation): by day a camera
  // JPEG's colour (the midday photographs' mean HSV saturation is 0.22-0.5, their Hasler
  // colourfulness 28-60: warm stone, green crowns, clothes and awnings read clearly against
  // the grey paving); more from golden hour on, when the low sun, the afterglow and then the
  // lamps carry the colour (a camera keeps the evening's warm-cool split vivid instead of
  // letting the canyon go grey)
  // It is a vibrance (final pass): the boost goes to the weakly coloured pixels, so stone
  // and lit foliage that carry their own colour are not pushed past it (the photographs'
  // shaded limestone is a pale warm grey, sunlit stone at most ~0.35 HSV saturation)
  satOut: [[0.3, 1.42], [0.5, 1.3], [0.6, 1.28], [0.85, 1.5], [0.95, 1.35]],
  // soft ceiling of the display (HSV) saturation: [start, limit, limit in the deep shadows]
  // (the photographs keep under ~2.4 % of their pixels above 0.85 and almost none with a
  // crushed channel; a camera's chroma noise reduction holds the darkest colours, dark
  // crowns and clothes, lower still)
  satCeil: [0.72, 0.92, 0.8],
  // golden hour (time of day, weight): the low sun's colour is the picture (golden stone
  // against the blue-grey shade, green crowns, warm clothes), and nearly the whole frame,
  // limestone, paving and the pale sky, sits in the orange hues the day's vibrance holds
  // back: the boost rises by `sat`, reaches the mid-saturated colours too (`vib`: [share of
  // the pixel's own saturation that holds its boost back, share of the extra orange
  // protection]; by day [1, 1]) and the soft ceiling starts lower (`ceil`: [start, limit])
  // so the gamut edge stays guarded. Looking into the low sun (`backlit`) the lens veil and
  // the glowing air flatten the colour, as in a contre-jour photograph (pale and warm, HSV
  // saturation ~0.2): there the day's vibrance is kept. Through sunset, when the afterglow
  // and the first lamps carry the colour, part of it stays; none in the blue hour
  gold: { w: [[0.38, 0], [0.48, 1], [0.64, 1], [0.76, 0.6], [0.82, 0.6], [0.9, 0]], sat: 0.25, vib: [0.5, 0], ceil: [0.66, 0.86] },
  // a warm sky this many stops over mid grey (start, full) runs to the camera's cream white
  // (the blown aureole over a backlit golden street); under ~3 stops it keeps its apricot
  skyWhite: [3.0, 4.6],
  // and in the highlights (time of day, [saturation, from, to] in display-linear luminance):
  // by day it eases off from about +1 stop and is 0.6 by the shoulder, so sunlit limestone
  // rolls off to cream; at golden hour the same, a little stronger (the low sun's stone
  // stays golden in the mid tones, its brightest faces and the backlit paving's glow go
  // cream rather than apricot); at dusk the lamps' amber keeps most of it
  satHi: [[0.3, [0.6, 0.3, 0.75]], [0.5, [0.52, 0.3, 0.74]], [0.85, [0.6, 0.5, 0.92]], [0.95, [0.9, 0.45, 0.95]]],
  // colour saturation in the AgX look: day, dusk
  sat: [1.16, 1.08],
  // sky pixels keep nearly the scene's colour ratios, with more saturation where the sky
  // is blue (the dusty atmosphere's sky is pale; a camera renders the clear sky overhead a
  // deep blue, (95-130, 145-180, 220-250) sRGB at 45 degrees): day .. blue hour. A warm sky
  // (towards a low sun, the afterglow) gets little (`skySatWarm`) by day: a golden sky
  // stays pale cream, as in a photograph; after sunset the afterglow band down the street
  // keeps its orange. env.skySatScale scales both boosts (a milky dust-haze day keeps its
  // pale cream sky)
  skyChroma: 0.95, skySat: [1.8, 1.3], skySatWarm: [1.1, 1.25],
  // the boost depends on the view ray's elevation (time of day, [sin of the elevation where
  // it starts, where it is full]). By day it starts below the horizon and is full from ~9
  // degrees: the city haze leaves the band just over the far end of the street milky, and
  // the boost keeps the sky slot of the telephoto view, 3-8 degrees up, a camera's pale blue
  // (HSV saturation ~0.2, its blue channel at the clip, as in the photographs) rather than
  // a near-white. From golden hour none below ~8 degrees, full above ~35 (the
  // low sky towards the sun is pale and warm)
  skySatEl: [[0.45, [-0.06, 0.16]], [0.55, [0.139, 0.574]]],
  // sunset: warm sky hues turned a little towards yellow (the horizon band reads
  // yellow-orange, hue 30-40 degrees, as cameras render it; pink above it)
  skyTwist: 0.4,
  // blue hour: a camera profile turns saturated blues away from violet (time of day, share
  // of the red taken out of a blue sky pixel), so the twilight sky, short of green from the
  // ozone, reads a deep blue (hue ~215-225) rather than lavender
  skyBlue: [[0.72, 0], [0.86, 0.22], [1.0, 0.22]],
  // glow skirt around sources far above white, from sunset on (lantern globes, lit glass):
  // threshold and knee in exposed units, strength (time of day, strength). Only while the
  // lamps' own aureoles are off: with them each globe would get a second halo
  // white balance (see _todParams): share of the illuminant's warm-cool cast corrected
  // (time of day, share), and from golden hour on the weight of the open sky (the shade's
  // light) in the neutral the camera balances on (time of day, weight)
  wbK: [[0.3, 0.3], [0.55, 0.25], [0.62, 0.25], [0.78, 0]],
  wbShade: [[0.4, 0], [0.55, 0.9], [0.68, 0.9], [0.78, 0]],
  // and a split-tone in the street's shadows (time of day, share: R x (1 + k), B x
  // (1 - 1.07 k), luminance kept): under the high sun a touch cool, as a daylight-balanced
  // camera renders open shade (the midday photographs' shaded paving and stone lean blue-
  // grey, the sunlit stone carries the warmth); from the low sun to sunset warm, as the sunlit
  // facades and the golden air fill the canyon's shade (shaded grey paving a warm neutral,
  // R/B ~1.06-1.12 in the low-sun photographs, rather than an overcast-day grey)
  shadowWarm: [[0.3, -0.03], [0.42, 0], [0.52, 0.07], [0.68, 0.07], [0.8, 0]],
  // and from sunset on a cooler setting (time of day, shift): the blue gain up and the red
  // one down, towards a ~4000 K balance once the lamps carry the street, so the sky-lit
  // paving between the pools reads blue-grey and the pools amber
  wbCool: [[0.82, 0], [1.0, 0.3]],
  // lanterns' sideways and upward glow in screen space, as a share of their downward
  // intensity (0: the real lights carry it, see env lights.js LANTERN_OMNI)
  wash: 0,
  // street dust haze over the day (time of day, scale): extinction and in-scatter. A clear
  // day scales the daytime part by env.hazeBoost.day (the dry midday air keeps the far
  // facades crisp, their window openings dark, within 500 m); the evening veil and a
  // dusty day keep theirs
  hazeExt: [[0.35, 1.0], [0.5, 0.55], [1.0, 0.55]],
  hazeIn: [[0.35, 1.0], [0.5, 0.65], [1.0, 0.65]],
  // green-magenta guard (time of day, value): the neutral's G / mean(R, B) range and the
  // green gain's ceiling over the geometric mean of red and blue; at night the green gain
  // stays within lampMax of the red one (the lamp pools amber, never yellow-green). At
  // golden hour the neutral sits a little on the green side: the shade's light is the
  // ozone-tinted evening sky plus the facades' orange bounce, which would otherwise leave
  // the shaded grey paving pink rather than the warm neutral of the photographs
  wbG: {
    lo: [[0.4, 0.97], [0.5, 1.02], [0.6, 1.02], [0.7, 1.0]], hi: [[0.4, 1.0], [0.5, 1.04], [0.6, 1.04], [0.7, 1.02]],
    // (lampMax: the ~3300 K pools stay amber, hue ~35, with the green gain up to 1.38x the
    // red one; it lets the green rise far enough that the twilight-lit paving between the
    // pools reads blue-grey (hue ~225) and the zone where lamp and sky light mix a neutral
    // grey, not mauve)
    cap: [[0.4, 1.03], [0.5, 1.06], [0.6, 1.06], [0.72, 1.18], [0.9, 1.2], [1.0, 1.2]], lampMax: 1.38,
    // the sky's own guard (lo, hi, cap: the daylight locus)
    sky: [0.97, 1.0, 1.03],
  },
  glowThresh: 4, glowKnee: 12, glow: [[0.74, 0], [0.8, 0.2], [0.86, 0.12], [0.95, 0.03], [1.0, 0]], glowScatter: 0.4,
};

// temporal AA: weight of the new frame, variance clip width, jitter sequence length and
// amplitude (pixels peak to peak: the 4x MSAA already smooths the edges, so the jitter
// only needs to break up sub-pixel shading; a full pixel would soften the image like a
// one-pixel box filter)
const TAA = { alpha: 0.1, gamma: 1.0, n: 16, jitter: 0.5 };
// walking people's motion boxes: at most `max` moving people within `range` m; half extents
// of a walker's box (across, up, along: the swinging arms and the stride), and along a
// person pushing a stroller or with a bicycle
const PEOPLE = { max: 384, range: 140, half: [0.42, 1.02, 0.55], halfLenProp: 1.15 };
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const JITTER = Array.from({ length: TAA.n }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

/** Piecewise-linear table lookup ([[x, y], ...], x ascending). */
function table(T, x) {
  if (x <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) {
    if (x <= T[i][0]) {
      const k = THREE.MathUtils.smoothstep(x, T[i - 1][0], T[i][0]);
      return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * k;
    }
  }
  return T[T.length - 1][1];
}

/** Vector table lookup ([[x, [a, b, ...]], ...], x ascending) into `out` (a THREE vector), smooth between points. */
function vtable(T, x, out) {
  let i = 0;
  while (i < T.length - 1 && x > T[i + 1][0]) i++;
  const a = T[i], b = T[Math.min(i + 1, T.length - 1)];
  const k = b === a || x <= a[0] ? 0 : THREE.MathUtils.smoothstep(x, a[0], b[0]);
  for (let j = 0; j < a[1].length; j++) out.setComponent(j, a[1][j] + (b[1][j] - a[1][j]) * k);
  return out;
}

// Street-level dust haze: extinction per metre (rgb), nearly grey (coarse dust).
const HAZE_EXT = [1.05e-3, 1.12e-3, 1.22e-3];
const HAZE_NONE = { ext: 1, inscatter: 1, dayExt: 1, dayIn: 1, near: 0 };

// Lens veiling glare around the sun (fractions of the sun's illuminance per steradian):
// a wide 1/theta^2 skirt (~1.2% of the light) and a tighter halo (~1%).
const GLARE = { k1: 4.8e-4, theta0: 0.006, k2: 4.0, theta1: 0.02 };
const _sv = new THREE.Vector3();
const _vp = new THREE.Matrix4();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _p2 = new THREE.Vector3();
const _vx = new THREE.Vector3();
const _vy = new THREE.Vector3();
const _vz = new THREE.Vector3();
const _nI = new THREE.Vector3();
const _cc = new THREE.Color();
const _wbS = new THREE.Vector3();

function target(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, ...opts,
  });
}

// one triangle covering the screen
const TRI = new THREE.BufferGeometry();
TRI.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
TRI.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

/** Opt-in GPU section timer (URL prof=1): results in post.timings (ms, smoothed). */
class SectionTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.timings = {};
    this.samples = {};      // raw recent samples per section (for minima under contention)
    this.open = null;
  }
  begin(name) {
    if (!this.ext) return;
    this.end();
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.open = { name, q };
  }
  end() {
    if (!this.ext || !this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
  }
  collect() {
    const gl = this.gl;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
        const o = this.timings[p.name];
        this.timings[p.name] = o === undefined ? ms : o * 0.95 + ms * 0.05;
        const a = this.samples[p.name] || (this.samples[p.name] = []);
        a.push(ms);
        if (a.length > 600) a.shift();
      }
      gl.deleteQuery(p.q);
      this.pending.shift();
    }
    if (this.pending.length > 400) { this.pending.forEach((p) => gl.deleteQuery(p.q)); this.pending = []; }
  }
}

function pass(fragmentShader, uniforms, defines = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader: S.QUAD_VS, fragmentShader, uniforms, defines,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const mesh = new THREE.Mesh(TRI, material);
  mesh.frustumCulled = false;
  return mesh;
}

const post = {
  name: 'post',
  // (inspection: the look tables, read live every frame)
  tone: TONE,

  async init(app) {
    this.app = app;
    this.q = QUALITY[app.params.quality] || QUALITY.high;
    const q = this.q;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.size = new THREE.Vector2();
    this.firstFrame = true;
    this.lumPing = 0;
    this.focus = FOCUS_RIDE[0];
    const env = app.systems.env;
    const air = env?.lights?.airlight;
    const nLamps = air ? air.lampPos.length : q.lamps;

    const camU = {
      uNear: { value: 0.3 }, uFar: { value: 2500 }, uProjXY: { value: new THREE.Vector2(1, 1) },
    };
    this.camU = camU;

    this.depthDown = pass(S.DEPTH_DOWN_FS, { ...camU, tDepth: { value: null } });
    this.aoPass = pass(S.AO_FS, {
      ...camU, tZ: { value: null }, uTexel: { value: new THREE.Vector2() },
      uRadius: { value: AO.radius }, uIntensity: { value: AO.intensity }, uFocalPx: { value: 500 },
    }, { AO_SAMPLES: Math.max(q.ao, 4) });
    this.aoBlur = pass(S.AO_BLUR_FS, { tAO: { value: null }, uDir: { value: new THREE.Vector2() } });

    const atmoU = env?.atmo?.uniforms;
    this.prepass = pass(S.PREPASS_FS, {
      ...camU,
      tScene: { value: null }, tDepth: { value: null }, tAO: { value: null },
      uSunDirA: atmoU ? atmoU.uSunDirA : { value: new THREE.Vector3(0, 1, 0) },
      uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 }, uAOStrength: { value: AO.strength }, uAOSize: { value: new THREE.Vector2(1, 1) },
      uHazeExt: { value: new THREE.Vector3(4.2e-4, 4.6e-4, 5.3e-4) }, uHazeInscatter: { value: 0.85 },
      uSkyIrr: env?.sky ? { value: env.sky.irrRT.texture } : { value: null },
      uSunGround: env?.sky ? env.sky.uniforms.uSunGround : { value: new THREE.Vector3(3, 3, 3) },
      uHazeAmb: { value: env?.haze ? env.haze.amb : new THREE.Vector3(0.05, 0.06, 0.08) },
      uHazePlane: { value: env?.haze ? env.haze.plane : new THREE.Vector4(0, 0, 0, -1) },
      uHazeGap: { value: 0 }, uHazeSun: { value: 1.0 }, uHazeNear: { value: 0 },
      uShimmer: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) },
      uDofK: { value: 0 }, uFocus: { value: FOCUS_RIDE[0] }, uCocMax: { value: COC_MAX[0] }, uCocTol: { value: COC_TOL[0] },
      uNightAir: { value: 0 }, uClampHDR: { value: HDR_CLAMP },
      uLampPos: { value: air ? air.lampPos : Array.from({ length: nLamps }, () => new THREE.Vector3()) },
      uLampI: { value: air ? air.lampI : new Float32Array(nLamps) },
      uHeadPos: { value: air ? air.headPos : new THREE.Vector3() },
      uHeadDir: { value: air ? air.headDir : new THREE.Vector3(0, 0, -1) },
      uHeadI: { value: 0 }, uHeadCos: { value: new THREE.Vector2(0.96, 0.995) },
      // dry summer air: the lamps' glow is mostly lens bloom, the air adds a faint forward halo
      uMist: { value: 6e-4 },
      tClouds: { value: null }, uUseClouds: { value: 0 },
      uFarLamp: { value: env?.lights?.farLamps ?? Array.from({ length: 24 }, () => new THREE.Vector4()) },
      uFarI: { value: 0 }, uFarMin: { value: 60 }, uLampCos: { value: new THREE.Vector2(0.58, 0.88) }, uWash: { value: 0 },
      tSunVis: { value: null }, uGlareE: { value: new THREE.Vector3() },
      uGlare: { value: new THREE.Vector4(GLARE.k1, GLARE.theta0 * GLARE.theta0, GLARE.k2, GLARE.theta1) },
    }, { NUM_LAMPS: nLamps, NUM_FAR: env?.lights?.farLamps?.length ?? 24, ...(q.ao ? { USE_AO: 1 } : {}) });

    this.sunVis = pass(S.SUNVIS_FS, {
      tDepth: { value: null }, tClouds: { value: null }, uUseClouds: { value: 0 },
      uSunUV: { value: new THREE.Vector2() }, uSunR: { value: new THREE.Vector2() }, uFade: { value: 0 },
    });
    this.sunVisRT = target(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    // oncoming trams' bodies and riding cyclists, and their motion since the last frame
    // (blur and TAA history)
    this.movers = {
      uMoverInv: { value: Array.from({ length: S.NUM_MOVERS }, () => new THREE.Matrix4()) },
      uMoverDisp: { value: Array.from({ length: S.NUM_MOVERS }, () => new THREE.Vector3()) },
      uMovers: { value: 0 },
      // walking people's motion map (see _people)
      tPeople: { value: null }, uPeople: { value: 0 },
    };
    this._moverPrev = new Map();
    this._initPeople();
    this.taa = pass(S.TAA_FS, {
      ...camU, ...this.movers, tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
      uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() },
      uAlpha: { value: 1 }, uGamma: { value: TAA.gamma }, uExpo: { value: 1 },
    });
    this.skySatK = app.params.num ? app.params.num('skysat', 1) : 1;   // (inspection: URL skysat=)
    this.hiSlopeK = app.params.num ? app.params.num('hslope', 0) : 0;  // (inspection: URL hslope=)
    this.taaOn = q.taa !== false && app.params.raw.get('taa') !== '0';
    this.taaPing = 0;
    this.taaFrame = 0;
    this.prevVP = new THREE.Matrix4();
    this.prevCamPos = new THREE.Vector3();
    this.prevFov = 0;
    this.taaValid = false;
    this.jitter = new THREE.Vector2();
    this.jitterScale = app.params.num ? app.params.num('taaj', TAA.jitter) : TAA.jitter;   // (inspection: URL taaj=)
    // debug=1: count of broken (non-finite / negative) scene pixels, in stats()
    this.debug = app.params.raw.get('debug') === '1';
    this.badPixels = 0;
    if (this.debug) this.badPass = pass(S.BADPIX_FS, { tScene: { value: null }, uSize: { value: new THREE.Vector2() } });
    this.dof = pass(S.DOF_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.blur = pass(S.MBLUR_FS, {
      ...camU, ...this.movers, tSrc: { value: null }, tDepth: { value: null },
      uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uPrevViewProj: { value: new THREE.Matrix4() }, uResolution: { value: new THREE.Vector2(1, 1) },
      uShutter: { value: 1 }, uMaxPx: { value: BLUR_MAX_PX },
    });
    this.down = pass(S.DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKaris: { value: 0 }, uClamp: { value: 1e4 } });
    this.up = pass(S.UP_FS, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.68 } });
    this.lum = pass(S.LUM_FS, { tSmall: { value: null }, tPrev: { value: null }, uSize: { value: new THREE.Vector2() }, uRate: { value: 1 } });
    this.final = pass(S.FINAL_FS, {
      tHDR: { value: null }, tBloom: { value: null }, tLum: { value: null }, tTail: { value: null }, uTail: { value: 0 },
      uExposure: { value: 1 }, uExposureMax: { value: 1e4 }, uAutoExp: { value: TONE.meter[0] }, uMeterTarget: { value: TONE.target[0] },
      uMeterClamp: { value: new THREE.Vector2(TONE.clampLo[0], TONE.clampHi[0]) }, uBloom: { value: TONE.bloom[0] },
      uVignette: { value: TONE.vignette }, uCA: { value: 0.0004 }, uGrain: { value: 0.012 }, uTime: { value: 0 },
      uSharpen: { value: app.params.num ? app.params.num('sharp', TONE.sharpen) : TONE.sharpen },
      uWB: { value: new THREE.Vector3(1.0, 0.99, 0.965) },
      uSat: { value: TONE.sat[0] }, uContrast: { value: 1.08 },
      uCurve: { value: new THREE.Vector4(...TONE.curve) }, uChroma: { value: TONE.chroma[0] },
      uShadowTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      uHighTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uVeil: { value: TONE.veil }, uVeilSun: { value: new THREE.Vector3() },
      uHiComp: { value: new THREE.Vector2(TONE.hiKnee[0][1], 1) },
      uCurveSlope: { value: new THREE.Vector2(1, TONE.pivot) },
      tDepth: { value: null }, uBlack: { value: 0 },
      uSkyChroma: { value: app.params.num ? app.params.num('skychroma', TONE.skyChroma) : TONE.skyChroma },
      uSkySat: { value: new THREE.Vector2(TONE.skySat[0], TONE.skySatWarm[0]) },
      tGlow: { value: null }, uGlow: { value: 0 },
      uToe: { value: new THREE.Vector3(...TONE.toe) }, uDeep: { value: new THREE.Vector3(table(TONE.deep[0], 0), table(TONE.deep[1], 0), TONE.deep[2]) },
      tLocal: { value: null }, uLocal: { value: new THREE.Vector4(TONE.local.knee, 0, TONE.local.px[0], TONE.local.px[1]) },
      uKnee: { value: vtable(TONE.knee, 0, new THREE.Vector4()) }, uSatOut: { value: table(TONE.satOut, 0) }, uSkyTwist: { value: 0 }, uSkyBlue: { value: 0 },
      uSatHi: { value: vtable(TONE.satHi, 0, new THREE.Vector3()) },
      uUpView: { value: new THREE.Vector3(0, 1, 0) }, uProjInv: { value: new THREE.Vector2(1, 1) },
      uSkySatEl: { value: vtable(TONE.skySatEl, 0, new THREE.Vector2()) },
      uWBSky: { value: new THREE.Vector3(1.0, 0.99, 0.965) }, uSunView: { value: new THREE.Vector3(0, 0, 1) },
      uSkyWhite: { value: new THREE.Vector2(...TONE.skyWhite) }, uSatCeil: { value: new THREE.Vector3(...TONE.satCeil) },
      uVib: { value: new THREE.Vector2(1, 1) },
      tClouds: { value: null }, uUseClouds: { value: 0 },
    });
    // local level of the surfaces for the highlight recovery (1/8 res, then blurred)
    this.localPass = pass(S.LOCAL_FS, { tSrc: { value: null }, tDepth: { value: null }, uSrcSize: { value: new THREE.Vector2() } });
    this.localBlur = pass(S.LOCAL_BLUR_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.localOn = app.params.raw.get('lhr') !== '0';   // (A/B: URL lhr=0)
    // glow extraction (shares the final pass's exposure inputs)
    {
      const f = this.final.material.uniforms;
      this.glowPass = pass(S.GLOW_FS, {
        tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
        uThresh: { value: TONE.glowThresh }, uKnee: { value: TONE.glowKnee }, tLum: { value: null },
        uExposure: f.uExposure, uExposureMax: f.uExposureMax, uAutoExp: f.uAutoExp,
        uMeterTarget: f.uMeterTarget, uMeterClamp: f.uMeterClamp,
      });
    }

    // the materials' baked AO is scaled down while the screen-space AO runs
    const mu = app.materials?.uniforms;
    if (mu && mu.aoScale) mu.aoScale.value = q.ao ? AO.bakedScale : 1;

    // opt-in profiler; the core frame timer is paused while it runs (queries cannot nest)
    this.prof = app.params.raw.get('prof') === '1' ? new SectionTimer(app.renderer.getContext()) : null;
    if (this.prof && app.gpuTimer) app.gpuTimer.ext = null;
    this.timings = this.prof ? this.prof.timings : null;
    if (this.prof) {
      // time the sun's shadow atlas separately from the scene pass that follows it
      const sm = app.renderer.shadowMap, render = sm.render, prof = this.prof;
      sm.render = function (lights, scene, camera) {
        if (!lights.length || !prof.open || prof.open.name !== 'scene') return render.call(this, lights, scene, camera);
        prof.begin('shadow');
        render.call(this, lights, scene, camera);
        prof.begin('main');
      };
    }

    this.lumRT = [target(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      target(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })];
    const v = new THREE.Vector2();
    app.renderer.getSize(v);
    this.setSize(v.x, v.y);
    this._precompile();
  },

  /**
   * Start compiling every pass program now, on the driver's threads where supported, so
   * they are ready by the first frame (or by the first time a pass is needed, like the
   * sun glare) instead of stalling it. Programs depend on the output target's colour
   * space: the final pass draws to the screen, everything else into float targets.
   */
  _precompile() {
    const r = this.app.renderer, env = this.app.systems.env;
    const into = [this.depthDown, this.aoPass, this.aoBlur, this.prepass, this.sunVis, this.taa, this.dof, this.blur, this.down, this.up, this.lum, this.glowPass, this.localPass, this.localBlur, this.peopleMesh];
    for (const m of env?.passes?.() || []) into.push(m);
    const prev = r.getRenderTarget();
    const group = (meshes, rt) => {
      const scene = new THREE.Scene();
      for (const m of meshes) scene.add(m);
      r.setRenderTarget(rt);
      const done = r.compileAsync(scene, this.cam).catch(() => {});
      for (const m of meshes) scene.remove(m);
      return done;
    };
    try {
      this.compiled = Promise.all([group(into, this.hdrRT), group([this.final], null)]).then(() => this._warm());
    } catch (e) {
      console.warn('[post] precompile', e);
    }
    r.setRenderTarget(prev);
  },

  /**
   * One draw of each pass that isn't used every frame (sun glare, motion blur, the
   * environment map swap): the driver finishes a program on its first draw, which would
   * otherwise stall the frame that first needs it.
   */
  _warm() {
    const r = this.app.renderer, env = this.app.systems.env;
    if (!this.sceneRT || !this.dofRT) return;
    const prev = r.getRenderTarget();
    const su = this.sunVis.material.uniforms;
    su.tDepth.value = this.sceneRT.depthTexture; su.tClouds.value = null; su.uUseClouds.value = 0;
    this._draw(this.sunVis, this.sunVisRT);
    const bu = this.blur.material.uniforms;
    bu.tSrc.value = this.hdrRT.texture; bu.tDepth.value = this.sceneRT.depthTexture;
    this._draw(this.blur, this.dofRT);
    // (the people pass: one box far below the street, which draws nothing)
    if (this.peopleRT) {
      const g = this.peopleMesh.geometry;
      g.attributes.iC.array.set([0, -1e4, 0, 0]); g.attributes.iE.array.set([0.4, 1, 0.5]);
      g.attributes.iC.needsUpdate = true; g.attributes.iE.needsUpdate = true; g.attributes.iD.needsUpdate = true;
      g.instanceCount = 1;
      this.peopleMesh.material.uniforms.tDepth.value = this.sceneRT.depthTexture;
      this._draw(this.peopleMesh, this.peopleRT);
      g.instanceCount = 0;
    }
    if (this.glowDowns && this.glowDowns[0] && this.downs[0]) {
      const gu = this.glowPass.material.uniforms;
      gu.tSrc.value = this.downs[0].texture; gu.tLum.value = this.lumRT[0].texture;
      this._draw(this.glowPass, this.glowDowns[0]);
    }
    if (env && env.sky && env.sky.warmCopy) env.sky.warmCopy();
    r.setRenderTarget(prev);
  },

  setSize() {
    const r = this.app.renderer;
    const v = r.getDrawingBufferSize(new THREE.Vector2());
    const W = Math.max(2, Math.floor(v.x)), H = Math.max(2, Math.floor(v.y));
    if (this.sceneRT && W === this.size.x && H === this.size.y) return;
    this.size.set(W, H);
    this._disposeTargets();
    const q = this.q;
    const depthTexture = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT = target(W, H, { depthBuffer: true, samples: q.msaa, depthTexture });
    this.hdrRT = target(W, H);
    // temporal AA: the resolved frame doubles as the next frame's history
    this.taaRT = this.taaOn ? [target(W, H), target(W, H)] : null;
    // walking people's motion (xyz displacement, w on a figure)
    this.peopleRT = this.taaOn && this.peopleOn ? target(W, H, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }) : null;
    if (this.peopleMesh) this.peopleMesh.material.uniforms.uResolution.value.set(W, H);
    this.taaValid = false;
    if (this.debug) this.badRT = target(Math.ceil(W / 8), Math.ceil(H / 8), { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    // DOF and motion blur ping-pong between hdrRT and this one
    this.dofRT = q.dof || q.blur ? target(W, H) : null;
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    if (q.ao) {
      this.zRT = target(hw, hh, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.aoRT = target(hw, hh, { type: THREE.FloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.aoRT2 = target(hw, hh, { type: THREE.FloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    this.downs = []; this.ups = [];
    let w = W, h = H;
    for (let i = 0; i < q.levels; i++) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
      this.downs.push(target(w, h));
      this.ups.push(i > 0 && i < q.levels - 1 ? target(w, h) : null);
    }
    // glow pyramid: quarter, eighth and sixteenth resolution (down), eighth and quarter (up)
    const gq = this.downs[1] || this.downs[0];
    this.glowDowns = [];
    this.glowUps = [];
    w = gq.width; h = gq.height;
    for (let i = 0; i < 3; i++) {
      this.glowDowns.push(target(w, h));
      this.glowUps.push(i < 2 ? target(w, h) : null);
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
    }
    // local highlight level: 1/8 res, a ping-pong pair for the separable blur
    const lw = Math.ceil(W / 8), lh = Math.ceil(H / 8);
    this.localRT = [target(lw, lh, { format: THREE.RGFormat }), target(lw, lh, { format: THREE.RGFormat })];
    this.app.systems.env?.clouds?.setSize(W, H);
    this.final.material.uniforms.uResolution.value.set(W, H);
    this.prepass.material.uniforms.uResolution.value.set(W, H);
    this.prepass.material.uniforms.uAOSize.value.set(hw, hh);
    this.blur.material.uniforms.uResolution.value.set(W, H);
    this.taa.material.uniforms.uResolution.value.set(W, H);
    this.firstFrame = true;
  },

  _disposeTargets() {
    for (const k of ['sceneRT', 'hdrRT', 'dofRT', 'zRT', 'aoRT', 'aoRT2', 'badRT', 'peopleRT']) {
      if (this[k]) { if (this[k].depthTexture) this[k].depthTexture.dispose(); this[k].dispose(); this[k] = null; }
    }
    for (const t of this.taaRT || []) t.dispose();
    this.taaRT = null;
    for (const t of this.localRT || []) t.dispose();
    this.localRT = null;
    for (const t of [...(this.downs || []), ...(this.ups || []), ...(this.glowDowns || []), ...(this.glowUps || [])]) t && t.dispose();
  },

  _draw(mesh, rt) {
    const r = this.app.renderer;
    r.setRenderTarget(rt);
    r.render(mesh, this.cam);
  },

  /** Per-time-of-day look parameters (haze, shimmer, airlight, bloom, exposure, white balance). */
  _todParams(env, camera) {
    const t = env ? env.state.t : 0.12;
    const night = env ? env.state.night : 0;
    const ss = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp;
    const pu = this.prepass.material.uniforms, fu = this.final.material.uniforms;
    // how directly the camera faces the sun: `into` 1 within 12° of the view axis, 0 beyond
    // 35°; `backlit` 1 within ~25°, 0 beyond ~40° (only meaningful for a low sun)
    let into = 0, backlit = 0;
    if (env && camera && !env.disabled) {
      camera.getWorldDirection(_sv);
      const c = _sv.dot(env.state.sunDir);
      into = ss(c, 0.8192, 0.9781);
      backlit = ss(c, 0.766, 0.9063) * ss(t, 0.3, 0.45) * (env.state.sunDir.y > -0.02 ? 1 : 0);
    }
    // haze: a dusty summer afternoon (visibility ~3.5 km: distant facades wash out to a
    // pale warm grey, about half their contrast gone at 500 m), clearing a little at dusk;
    // a hazy-sky day (env.weather 'haze') is thicker
    // From golden hour on the air clears (the afternoon's dust settles, and the low sun
    // lights only the air above the canyon): a light veil over the far end of the street,
    // the people and trees at 20-80 m keep their dark accents
    const hz = env && env.hazeBoost ? env.hazeBoost : HAZE_NONE;
    const kDay = 1 - ss(t, 0.3, 0.5);
    const k = table(TONE.hazeExt, t) * (hz.ext ?? 1) * lerp(1, hz.dayExt ?? 1, kDay);
    pu.uHazeExt.value.set(HAZE_EXT[0] * k, HAZE_EXT[1] * k, HAZE_EXT[2] * k);
    pu.uHazeInscatter.value = table(TONE.hazeIn, t) * (hz.inscatter ?? 1) * lerp(1, hz.dayIn ?? 1, kDay);
    pu.uHazeNear.value = hz.near ?? 0;
    pu.uHazeGap.value = env ? env.haze.gap : 0;
    // aerosol albedo; tree canopies and awnings shade much of the street air. Looking
    // straight into a low sun the forward lobe is held back (the shaded street air between
    // the camera and the sunlit far end would otherwise fog the whole view)
    pu.uHazeSun.value = 0.25 * (env ? env.haze.sun : 1) * lerp(1, 0.35, into * ss(t, 0.4, 0.5));
    // heat shimmer over the hot paving: an angular jitter of the rays (~45 arc seconds at
    // most), so in pixels it scales with the lens, and stays under a pixel: a larger offset
    // drags thin bright lines (a rail head across a shadow band) into a comb of streaks
    {
      const pxAng = camera && camera.isPerspectiveCamera ? THREE.MathUtils.degToRad(camera.fov) / Math.max(this.size.y, 1) : 3e-4;
      pu.uShimmer.value = this.q.shimmer ? Math.min(SHIMMER_RAD / Math.max(pxAng, 1e-6), 0.8) * (1 - ss(t, 0.1, 0.4)) : 0;
    }
    // dusk airlight (lamp and headlight intensities already carry their own ramps)
    const lamps = env ? env.state.lamps ?? night : 0;
    pu.uNightAir.value = Math.max(night, lamps);
    // frosted globes under a shallow cap send a little of their light sideways and up
    // (on the lamps' photocell ramp, with the real lights and the globes)
    pu.uWash.value = TONE.wash * lamps;
    // contact shadows read deeper once the light is all lamps and sky
    pu.uAOStrength.value = Math.min(AO.strength * lerp(1, 1.3, ss(night, 0.5, 1)), 1);
    fu.uBloom.value = THREE.MathUtils.lerp(TONE.bloom[0], TONE.bloom[1], night);
    // one halo per lantern: the lamps' own aureoles (catenary) draw the skirt round each lit
    // globe, so the glow pass only stands in for them while they are off (catglow=0)
    const cat = this.app.systems.catenary;
    fu.uGlow.value = cat && !cat.disabled && cat.glow ? 0 : table(TONE.glow, t);
    fu.uTail.value = TONE.tail * ss(night, 0.3, 1.0);
    fu.uExposure.value = env ? env.exposure : 1;
    fu.uExposureMax.value = env ? env.exposureMax ?? 1e4 : 1e4;
    // metering: by day the exposure follows the incident light and the meter only nudges
    // it; from the low sun on, the camera meters the scene, and exposes darker when it
    // looks into the light (the shaded street goes under, the sky keeps its colour)
    const km = ss(t, 0.35, 0.6);
    fu.uAutoExp.value = lerp(TONE.meter[0], TONE.meter[1], km);
    fu.uMeterClamp.value.set(lerp(TONE.clampLo[0], TONE.clampLo[1], km), lerp(TONE.clampHi[0], TONE.clampHi[1], km));
    fu.uMeterTarget.value = lerp(TONE.target[0], TONE.target[1], ss(t, 0.3, 0.6)) * lerp(1, TONE.backlit, backlit);
    // the HDR clamp is set in exposed units
    pu.uClampHDR.value = HDR_CLAMP / Math.max(env ? env.exposure : 1, 1e-4);
    // white balance, split into a warm-cool and a green-magenta axis. By day the camera
    // balances on the direct sun (a daylight preset), so sunlit grey paving reads neutral
    // and sky-lit shade keeps its blue; from golden hour on it balances on the whole
    // illuminant (sun + sky on a horizontal surface), keeping most of the evening warmth.
    // At the blue hour it is set for the ~3000 K lamps: their pools stay warm, everything
    // the sky lights turns blue. Grey stone lit by the open sky stays neutral on the
    // green-magenta axis at every time of day (never mauve, never olive).
    const wb = fu.uWB.value, wbS = fu.uWBSky.value;
    if (env) {
      const ill = env.illuminant, sun = env.sunIlluminant;
      const lrAll = Math.log(Math.max(ill.x, 1e-9) / Math.max(ill.z, 1e-9));
      const wSun = sun && sun.x > 1e-6 && sun.z > 1e-6 ? 1 - ss(t, 0.3, 0.6) : 0;
      let lr = wSun > 0 ? THREE.MathUtils.lerp(lrAll, Math.log(sun.x / sun.z), wSun) : lrAll;
      // (the sky's own balance: the illuminant alone, see below)
      const lrSky = lr;
      // golden hour: most of the frame lies in the canyon's shade, and a camera balancing the
      // scene sets its neutral part-way towards the open sky that lights the shade: the shaded
      // paving reads warm-neutral instead of lavender, the sunlit stone stays golden
      // (on both axes: the open sky's light, short of green from the ozone in the evening,
      // would otherwise leave the shaded grey paving mauve)
      const sky = env.skyIlluminant;
      const wShade = sky && sky.x > 1e-9 && sky.y > 1e-9 && sky.z > 1e-9 ? table(TONE.wbShade, t) : 0;
      if (wShade > 0) lr = THREE.MathUtils.lerp(lr, Math.log(sky.x / sky.z), wShade);
      // the neutral on the green-magenta axis (geometric blend of the two illuminants)
      const nI = _nI.set(Math.max(ill.x, 1e-9), Math.max(ill.y, 1e-9), Math.max(ill.z, 1e-9));
      const lgSky = Math.log(nI.y / Math.sqrt(nI.x * nI.z));
      if (wShade > 0) nI.set(nI.x ** (1 - wShade) * sky.x ** wShade, nI.y ** (1 - wShade) * sky.y ** wShade, nI.z ** (1 - wShade) * sky.z ** wShade);
      const lg = Math.log(nI.y / Math.sqrt(nI.x * nI.z));
      // warm-cool correction: under a third of the sun's cast by day (the warm sun on
      // stone stays warm), a little at golden hour, none from sunset on: a daylight-
      // balanced camera keeps the twilight blue (the warmth comes from the lamps), and
      // later the lamp balance (TONE.wbCool) turns it bluer still
      const kc = table(TONE.wbK, t);
      // green-magenta: mostly corrected through sunset (the twilight sky's ozone tint
      // would turn shaded grey paving mauve), about a third once the lamps light the street
      // (sky-lit grey reads blue with G above R, the ~3000 K pools stay amber, not olive)
      const kt = lerp(1.0, 0.85, ss(t, 0.62, 0.78)) - 0.5 * ss(t, 0.88, 1.0);
      const cool = table(TONE.wbCool, t);
      const G = TONE.wbG;
      this._wbGains(wb, lr, lg, nI, kc, kt, cool, t, table(G.lo, t), table(G.hi, t), table(G.cap, t), true);
      // the sky: balanced on the illuminant alone (no shade neutral), and on the daylight
      // locus on the green-magenta axis (the street's golden-hour and sunset green lift would
      // turn the sky facing away from the sun mint or khaki), so it reads blue as the
      // photographs' evening skies do; in the blue hour without the street's lamp-light green
      // lift (a deep blue, never teal)
      _wbS.set(Math.max(ill.x, 1e-9), Math.max(ill.y, 1e-9), Math.max(ill.z, 1e-9));
      this._wbGains(wbS, lrSky, lgSky, _wbS, kc, kt, cool, t, G.sky[0], G.sky[1], G.sky[2], false);
    } else {
      wb.set(1, 1, 1);
      wbS.set(1, 1, 1);
    }
    // highlight recovery: none at midday, more as the sun lowers and the sky outshines the street
    fu.uHiComp.value.set(table(TONE.hiKnee, t), this.hiSlopeK > 0 ? this.hiSlopeK : table(TONE.hiSlope, t));
    fu.uCurveSlope.value.x = THREE.MathUtils.lerp(TONE.midday, 1, ss(t, 0.25, 0.5));
    fu.uBlack.value = table(TONE.black, t);
    fu.uDeep.value.set(table(TONE.deep[0], t), table(TONE.deep[1], t), TONE.deep[2]);
    // the low sun's warmth on the highlights, and the canyon's warm fill in the shadows
    const hiW = 0.05 * ss(t, 0.35, 0.55) * (1 - ss(t, 0.72, 0.88));
    fu.uHighTint.value.set(1 + hiW, 1, 1 - hiW);
    const shW = table(TONE.shadowWarm, t);
    fu.uShadowTint.value.set(1 + shW, 1, 1 - 1.07 * shW).multiplyScalar(1 / (1 + 0.2126 * shW - 0.0722 * 1.07 * shW));
    // more of the scene's own chroma once the light warms (low sun on stone, lamps)
    fu.uChroma.value = THREE.MathUtils.lerp(TONE.chroma[0], TONE.chroma[1], ss(t, 0.35, 0.6));
    fu.uSat.value = THREE.MathUtils.lerp(TONE.sat[0], TONE.sat[1], ss(t, 0.6, 0.85));
    // (a dusty day's milky light is rendered with a little more colour, env.lookSat)
    const kLook = env && Number.isFinite(env.lookSat) ? env.lookSat : 1;
    // (the golden-hour look, see TONE.gold; not when looking into the sun)
    const gw = table(TONE.gold.w, t), gl = gw * (1 - backlit), Gd = TONE.gold;
    this.goldLook = gl;   // (inspection)
    fu.uSatOut.value = 1 + (table(TONE.satOut, t) + Gd.sat * gl - 1) * kLook;
    fu.uVib.value.set(lerp(1, Gd.vib[0], gl), lerp(1, Gd.vib[1], gl));
    fu.uSatCeil.value.set(lerp(TONE.satCeil[0], Gd.ceil[0], gw), lerp(TONE.satCeil[1], Gd.ceil[1], gw), TONE.satCeil[2]);
    fu.uSkyWhite.value.set(TONE.skyWhite[0], TONE.skyWhite[1]);
    vtable(TONE.satHi, t, fu.uSatHi.value);
    // the sky's saturation boost by elevation: world up seen from the camera
    if (camera) {
      const e = camera.matrixWorld.elements, P = camera.projectionMatrix.elements;
      fu.uUpView.value.set(e[1], e[5], e[9]);
      fu.uProjInv.value.set(1 / P[0], 1 / P[5]);
      if (env) fu.uSunView.value.copy(env.state.sunDir).transformDirection(camera.matrixWorldInverse);
    }
    vtable(TONE.skySatEl, t, fu.uSkySatEl.value);
    fu.uSkyTwist.value = TONE.skyTwist * ss(t, 0.6, 0.74) * (1 - ss(t, 0.9, 1.0));
    fu.uSkyBlue.value = table(TONE.skyBlue, t);
    // gamut knee: a camera JPEG by day, hue-keeping from sunset on
    vtable(TONE.knee, t, fu.uKnee.value);
    // local highlight recovery while the sun is up (after sunset the bright things are the
    // lamps, small sources whose halos stand for the lens)
    fu.uLocal.value.y = this.localOn && this.localRT ? TONE.local.strength * (1 - ss(t, 0.8, 0.9)) : 0;
    const kSky = env && Number.isFinite(env.skySatScale) ? env.skySatScale : 1;
    const kd = ss(t, 0.45, 0.9);
    fu.uSkySat.value.set(this.skySatK * (1 + (lerp(TONE.skySat[0], TONE.skySat[1], kd) - 1) * kSky),
      this.skySatK * (1 + (lerp(TONE.skySatWarm[0], TONE.skySatWarm[1], kd) - 1) * kSky));
  },

  /**
   * White balance gains into `wb` (normalised to unit luminance): warm-cool correction `kc`
   * of the log red/blue cast `lr`, green-magenta correction `kt` of `lg`, the lamp balance
   * `cool`, then the guards below for the neutral `nI` (lo, hi, cap: TONE.wbG).
   */
  _wbGains(wb, lr, lg, nI, kc, kt, cool, t, gLo, gHi, gCap, lamps) {
    const ss = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
    const er = clamp(0.5 * lr * kc, -0.7, 0.7), eg = clamp(lg * kt, -0.7, 0.7);
    wb.set(Math.exp(-er) * (1 - 0.5 * cool), Math.exp(-eg), Math.exp(er) * (1 + cool));
    // from sunset on, a daylight-balanced camera keeps the twilight blue (the warmth
    // comes from the lamps): the blue gain stays within 5% of the green one
    const keepBlue = ss(t, 0.66, 0.72);
    if (keepBlue > 0) wb.z = Math.max(wb.z, lerp(wb.z, 0.9025 * wb.x, keepBlue));
    // the gains stay on the daylight locus: the green one never more than 1% under the
    // geometric mean of red and blue and at most 3% over it by day (no green push, so the
    // sky and the limestone it lights never turn khaki or olive), and a neutral surface
    // under the illuminant keeps G / mean(R, B) within [gLo, gHi]: [0.97, 1.0] by day,
    // a little over 1 at golden hour, at least 1 from sunset on (TONE.wbG)
    // Around sunset and in the blue hour the sky's ozone (Chappuis) absorption leaves the
    // twilight illuminant some 10-20% short of green against the daylight locus, which
    // would turn the shaded grey street and the lamp-and-sky mix mauve: the green gain
    // may then rise to gCap x the geometric mean (the correction kt asks for)
    const gm = Math.sqrt(wb.x * wb.z);
    wb.y = clamp(wb.y, 0.99 * gm, Math.max(1.01, gCap - 0.02) * gm);
    const gr = (nI.y * wb.y) / Math.max(0.5 * (nI.x * wb.x + nI.z * wb.z), 1e-12);
    if (gr > gHi) wb.y = Math.max(wb.y * gHi / gr, 0.99 * gm);
    else if (gr < gLo) wb.y = Math.min(wb.y * gLo / gr, gCap * gm);
    // and once the lamps light the street their pools stay amber, never yellow-green:
    // the green gain stays within lampMax of the red one
    if (lamps) {
      const lampW = ss(t, 0.84, 0.95);
      const gMax = wb.x * (TONE.wbG.lampMax + 2 * (1 - lampW));
      if (wb.y > gMax) wb.y = gMax;
    }
    // keep the overall exposure (normalise the gains to unit luminance)
    const n = 0.2126 * wb.x + 0.7152 * wb.y + 0.0722 * wb.z;
    wb.multiplyScalar(1 / n);
    return wb;
  },

  /**
   * The last resolved (anti-aliased) frame, scene-linear HDR before exposure, with its
   * unjittered view-projection, camera position and field of view; `valid` is false
   * while there is none (TAA off, a cut). Read it during the update phase, before this
   * frame renders (the oncoming trams' glass reflects the street from it).
   */
  get history() {
    const h = this._hist || (this._hist = { texture: null, viewProj: null, camPos: null, fov: 0, valid: false });
    const ok = !!(this.taaOn && this.taaRT && this.taaValid && this.prevVP);
    h.texture = ok ? this.taaRT[this.taaPing ^ 1].texture : null;
    h.viewProj = this.prevVP || null;
    h.camPos = this.prevCamPos || null;
    h.fov = this.prevFov || 0;
    h.valid = ok;
    return h;
  },

  /** Thin-lens depth of field: circle of confusion scale (px), focus distance and blur cap. */
  _dofParams(env, camera, rdt) {
    const pu = this.prepass.material.uniforms;
    if (!this.q.dof) { pu.uDofK.value = 0; return; }
    const ss = THREE.MathUtils.smoothstep, t = env ? env.state.t : 0.12;
    // focus pulls in as the tram slows for a stop and back out as it leaves (~1.5 s)
    const tr = this.app.train;
    const v = tr && !tr.disabled ? Math.abs(tr.speed || 0) : 10;
    const dusk = ss(t, 0.5, 0.95);
    const lerp = THREE.MathUtils.lerp;
    const want = lerp(lerp(FOCUS_STOP[0], FOCUS_STOP[1], dusk), lerp(FOCUS_RIDE[0], FOCUS_RIDE[1], dusk), ss(v, 1, 8));
    this.focus += (want - this.focus) * (this.firstFrame ? 1 : 1 - Math.exp(-rdt / 1.5));
    const fovR = THREE.MathUtils.degToRad(camera.fov);
    const fmm = (SENSOR_H_MM / 2) / Math.tan(fovR / 2), fm = fmm / 1000;
    const fNum = THREE.MathUtils.lerp(F_DAY, F_DUSK, ss(t, 0.3, 0.95));
    pu.uDofK.value = (fmm / fNum) * fm / Math.max(this.focus - fm, 0.1) * (this.size.y / SENSOR_H_MM);
    pu.uFocus.value = this.focus;
    pu.uCocMax.value = THREE.MathUtils.lerp(COC_MAX[0], COC_MAX[1], ss(t, 0.55, 0.95));
    pu.uCocTol.value = lerp(COC_TOL[0], COC_TOL[1], dusk);
  },

  /**
   * Veil from a sun shining on the lens (and the cab's glass) from in or near the frame:
   * strongest looking towards it, fading over ~15° (exp(−angle / 0.25 rad)); only while
   * the camera itself stands in the sun (canyon shadow plane, skyline).
   */
  _sunVeil(env, camera) {
    const v = this.final.material.uniforms.uVeilSun.value;
    if (!env || env.disabled || !env.sun || !env.haze || env.state.sunDir.y < 0.0) { v.set(0, 0, 0); return; }
    const d = env.state.sunDir, pl = env.haze.plane;
    camera.getWorldDirection(_sv);
    const ang = Math.acos(THREE.MathUtils.clamp(_sv.dot(d), -1, 1));
    const p = camera.position;
    const lit = THREE.MathUtils.smoothstep(p.x * pl.x + p.y * pl.y + p.z * pl.z + pl.w, -2, 2);
    const k = TONE.veilSun * env.sun.intensity * lit * Math.exp(-ang / 0.25);
    const c = env.sun.color;
    v.set(c.r * k, c.g * k, c.b * k);
  },

  /** Project the sun into the frame and measure its visible share (1x1 pass). */
  _sunGlare(env, camera, P, clouds) {
    const pu = this.prepass.material.uniforms;
    pu.tSunVis.value = this.sunVisRT.texture;
    const sunE = env && !env.disabled && env.sky ? env.sky.uniforms.uSunGround.value : null;
    _sv.copy(env ? env.state.sunDir : _sv.set(0, 1, 0)).transformDirection(camera.matrixWorldInverse);
    if (!sunE || _sv.z > -0.05 || env.state.sunDir.y < -0.02) { pu.uGlareE.value.set(0, 0, 0); return; }
    const nx = P[0] * _sv.x / -_sv.z, ny = P[5] * _sv.y / -_sv.z;
    // a sun just outside the frame still veils it a little
    const ox = Math.max(Math.abs(nx) - 1, 0) / P[0], oy = Math.max(Math.abs(ny) - 1, 0) / P[5];
    const fade = Math.exp(-Math.hypot(ox, oy) / 0.02);
    if (fade < 0.01) { pu.uGlareE.value.set(0, 0, 0); return; }
    const u = this.sunVis.material.uniforms;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.tClouds.value = clouds ? pu.tClouds.value : null;
    u.uUseClouds.value = clouds ? 1 : 0;
    u.uSunUV.value.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
    u.uSunR.value.set(P[0] * 0.5 * 0.00465, P[5] * 0.5 * 0.00465);
    u.uFade.value = fade;
    this._draw(this.sunVis, this.sunVisRT);
    pu.uGlareE.value.copy(sunE);
  },

  /**
   * Moving boxes, camera-relative, each with its displacement since the last frame: the
   * oncoming trams, two per car (it bends with the track; at most TRAM_MOVERS slots), then
   * the riding cyclists the crowd publishes (app.crowd.movers: box centre, yaw, half
   * extents, displacement). Returns the largest displacement (m).
   */
  _movers(app, camera) {
    const M = this.movers, trams = app.trams, route = app.route;
    M.uMovers.value = 0;
    const cp = _p0.setFromMatrixPosition(camera.matrixWorld);
    const moving = app.dt > 0;
    let n = 0, dMax = 0;
    if (!trams || trams.disabled || !Array.isArray(trams.units) || !route) this._moverPrev.clear();
    else n = this._tramMovers(app, trams, route, cp, moving);
    for (let i = 0; i < n; i++) dMax = Math.max(dMax, M.uMoverDisp.value[i].length());
    // riding cyclists (bicycle and rider, a little margin for the wheels and elbows)
    const crowd = app.crowd, mv = crowd && !crowd.disabled ? crowd.movers : null;
    if (mv && mv.items && moving) {
      const items = mv.items, cap = S.NUM_MOVERS;
      for (let j = 0, m = Math.min(mv.n | 0, items.length); j < m && n < cap; j++) {
        const it = items[j];
        const sh = Math.sin(it.heading), ch = Math.cos(it.heading);
        const hw = (it.halfWidth || 0.36) + 0.06, hl = (it.halfLen || 0.95) + 0.06, hh = (it.halfHeight || 0.92) + 0.06;
        // (yaw 0 faces −Z: forward (−sin, 0, −cos), right (cos, 0, −sin))
        _vx.x = ch * hw; _vx.y = 0; _vx.z = -sh * hw;
        _vy.x = 0; _vy.y = hh; _vy.z = 0;
        _vz.x = -sh * hl; _vz.y = 0; _vz.z = -ch * hl;
        _m4.makeBasis(_vx, _vy, _vz).setPosition(it.x - cp.x, it.y - cp.y, it.z - cp.z);
        M.uMoverInv.value[n].copy(_m4).invert();
        const disp = M.uMoverDisp.value[n];
        disp.x = it.dx; disp.y = it.dy; disp.z = it.dz;
        const dl = disp.length();
        // (a respawn or a jump: no history)
        if (dl > 3) continue;
        if (dl > dMax) dMax = dl;
        n++;
      }
    }
    M.uMovers.value = n;
    return dMax;
  },

  /**
   * Walking people's motion for the TAA history and the motion blur: one oriented box per
   * moving person near the camera (instanced), drawn into a full-resolution map that keeps
   * each box's displacement where the scene point lies inside it (see PEOPLE_FS). Without it
   * the history of a walker is fetched as if the figure stood still, several pixels behind
   * it at the telephoto, and the resolve smears faces and clothes.
   */
  _initPeople() {
    const n = PEOPLE.max;
    const g = new THREE.InstancedBufferGeometry();
    const box = new THREE.BoxGeometry(2, 2, 2);
    g.index = box.index;
    g.setAttribute('position', box.getAttribute('position'));
    const attr = (k) => new THREE.InstancedBufferAttribute(new Float32Array(n * k), k).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iC', attr(4));
    g.setAttribute('iE', attr(3));
    g.setAttribute('iD', attr(3));
    g.instanceCount = 0;
    const u = {
      ...this.camU, tDepth: { value: null }, uCamWorld: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() }, uVPrel: { value: new THREE.Matrix4() },
    };
    const m = new THREE.ShaderMaterial({
      vertexShader: S.PEOPLE_VS, fragmentShader: S.PEOPLE_FS, uniforms: u,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false, side: THREE.BackSide,
    });
    this.peopleMesh = new THREE.Mesh(g, m);
    this.peopleMesh.frustumCulled = false;
    this.peopleOn = this.app.params.raw.get('ppl') !== '0';   // (A/B: URL ppl=0)
    this.peopleN = 0;
  },

  /** Fill the people boxes for this frame and draw their motion map; returns the box count. */
  _people(app, camera) {
    const M = this.movers;
    M.uPeople.value = 0;
    const crowd = app.crowd;
    if (!this.peopleOn || !this.taaOn || !this.peopleRT || !(app.dt > 0) || !crowd || crowd.disabled || typeof crowd.agents !== 'function') return 0;
    const list = crowd.agents();
    if (!list || !list.length) return 0;
    const g = this.peopleMesh.geometry;
    const C = g.attributes.iC, E = g.attributes.iE, D = g.attributes.iD;
    const c = C.array, e = E.array, dd = D.array;
    const cp = _p0.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_sv);
    const fx = _sv.x, fz = _sv.z, dt = app.dt, R2 = PEOPLE.range * PEOPLE.range;
    let n = 0;
    for (let i = 0, m = list.length; i < m && n < PEOPLE.max; i++) {
      const a = list[i];
      const vx = a.wvx, vz = a.wvz;
      if (!(vx * vx + vz * vz > 0.0025)) continue;          // (standing, seated: nothing to do)
      const x = a.x - cp.x, z = a.z - cp.z;
      const d2 = x * x + z * z;
      if (d2 > R2 || x * fx + z * fz < -2) continue;
      const big = a.mob > 0;                                   // a stroller or a bicycle with its person
      // (the box starts just above the paving, which stays put under the feet)
      c[n * 4] = x; c[n * 4 + 1] = a.y - cp.y + PEOPLE.half[1] + 0.03; c[n * 4 + 2] = z; c[n * 4 + 3] = a.heading;
      e[n * 3] = PEOPLE.half[0]; e[n * 3 + 1] = PEOPLE.half[1]; e[n * 3 + 2] = big ? PEOPLE.halfLenProp : PEOPLE.half[2];
      dd[n * 3] = vx * dt; dd[n * 3 + 1] = 0; dd[n * 3 + 2] = vz * dt;
      n++;
    }
    this.peopleN = n;
    if (n === 0) return 0;
    C.clearUpdateRanges(); C.addUpdateRange(0, n * 4); C.needsUpdate = true;
    E.clearUpdateRanges(); E.addUpdateRange(0, n * 3); E.needsUpdate = true;
    D.clearUpdateRanges(); D.addUpdateRange(0, n * 3); D.needsUpdate = true;
    g.instanceCount = n;
    const u = this.peopleMesh.material.uniforms;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uJitter.value.copy(this.jitter);
    u.uVPrel.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(_m4.makeTranslation(cp.x, cp.y, cp.z));
    const r = app.renderer;
    r.getClearColor(_cc);
    const ca = r.getClearAlpha();
    r.setRenderTarget(this.peopleRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setClearColor(_cc, ca);
    r.render(this.peopleMesh, this.cam);
    M.tPeople.value = this.peopleRT.texture;
    M.uPeople.value = 1;
    return n;
  },

  /** The oncoming trams' boxes (see _movers); returns the number of slots filled. */
  _tramMovers(app, trams, route, cp, moving) {
    const M = this.movers;
    let n = 0;
    for (const u of trams.units) {
      // (the unit's own previous-frame position when it publishes one)
      let prev = u.prevS;
      if (!Number.isFinite(prev)) { prev = this._moverPrev.get(u.id); this._moverPrev.set(u.id, u.s); }
      if (!u.root || !u.root.visible || !Number.isFinite(u.s) || u.active === false) continue;
      const len = u.length || 32, hw = (u.halfWidth || 1.3) + 0.08;
      const ds = prev === undefined || !moving ? 0 : route.delta(prev, u.s);
      if (Math.abs(ds) > 6) continue;    // a jump (respawn): no history
      for (let k = 0; k < 2 && n < TRAM_MOVERS; k++) {
        const o = (k + 0.5) * len / 2;
        const c = route.toWorld(u.s + o, u.d, 1.9, _p1);
        if (c.distanceToSquared(cp) > 200 * 200) continue;
        const smp = route.sample(u.s + o, this._msmp || (this._msmp = {}));
        const hl = len / 4 + 0.3;
        _vx.copy(smp.right).multiplyScalar(hw);
        _vy.set(0, 1.95, 0);
        _vz.copy(smp.tan).multiplyScalar(hl);
        _m4.makeBasis(_vx, _vy, _vz).setPosition(c.x - cp.x, c.y - cp.y, c.z - cp.z);
        M.uMoverInv.value[n].copy(_m4).invert();
        const disp = M.uMoverDisp.value[n];
        if (ds !== 0) disp.subVectors(c, route.toWorld(u.s - ds + o, u.d, 1.9, _p2)); else disp.set(0, 0, 0);
        n++;
      }
    }
    return n;
  },

  /**
   * Camera motion blur for this frame, or false: streaks follow each pixel's reprojected
   * motion since the last frame, scaled to the shutter time. Off for a cut (jump, zoom,
   * inspection view), while frozen, and when the camera barely moved.
   */
  _blurParams(app, camera) {
    if (!this.q.blur) return false;
    const rig = app.cameraRig;
    if (!rig || rig.disabled || rig.cut || !rig.prevViewProj || !(app.dt > 0) || !(app.realDt > 0)) return false;
    const u = this.blur.material.uniforms;
    const shutter = Math.min((rig.shutterSec ?? 1 / 50) / app.realDt, 2);
    // skip when the view barely moved: probe the frame corners 3 m ahead of the camera
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const P = camera.projectionMatrix.elements;
    let d = 0;
    for (let i = 0; i < 4; i++) {
      _p0.set((i & 1 ? 3 : -3) / P[0], (i & 2 ? 3 : -3) / P[5], -3).applyMatrix4(camera.matrixWorld);
      _p1.copy(_p0).applyMatrix4(rig.prevViewProj);
      _p0.applyMatrix4(_vp);
      d = Math.max(d, Math.abs(_p0.x - _p1.x) * this.size.x, Math.abs(_p0.y - _p1.y) * this.size.y);
    }
    if (d * 0.5 * shutter < 0.25 && !(this._moverMax > 0.01)) return false;
    u.uPrevViewProj.value.copy(rig.prevViewProj);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.copy(camera.position);
    u.uShutter.value = shutter;
    // the rig's streak cap (daylight / wide-angle limits), at 1080 lines
    const cap = Number.isFinite(rig.blurMaxPx) && rig.blurMaxPx > 0 ? rig.blurMaxPx : BLUR_MAX_PX;
    u.uMaxPx.value = cap * this.size.y / 1080;
    return true;
  },

  /**
   * Temporal AA, step 1: offset the projection by this frame's sub-pixel jitter (Halton
   * 2,3), and decide whether last frame's history is usable (no cut, jump or zoom).
   * Returns false when TAA is off.
   */
  _taaBegin(app, camera) {
    if (!this.taaOn || !this.taaRT || !camera.isPerspectiveCamera) return false;
    const rig = app.cameraRig;
    const jump = _sv.setFromMatrixPosition(camera.matrixWorld).distanceToSquared(this.prevCamPos) > 16;
    const zoom = Math.abs(camera.fov - this.prevFov) > 0.03 * Math.max(camera.fov, 1);
    // (the inspection view= flags every frame as a cut for the motion blur: ignore that)
    const cut = rig && !rig.disabled && rig.cut && !app.params.view;
    if (jump || zoom || cut || this.firstFrame) this.taaValid = false;
    const j = JITTER[this.taaFrame++ % JITTER.length];
    const e = camera.projectionMatrix.elements;
    this._pe8 = e[8]; this._pe9 = e[9];
    // content moves by +2j/size in NDC
    this.jitter.set(2 * j[0] * this.jitterScale / this.size.x, 2 * j[1] * this.jitterScale / this.size.y);
    e[8] -= this.jitter.x; e[9] -= this.jitter.y;
    return true;
  },

  _taaRestore(camera) {
    const e = camera.projectionMatrix.elements;
    e[8] = this._pe8; e[9] = this._pe9;
  },

  /** Temporal AA, step 2: resolve the prepass output against the history. */
  _taaResolve(camera, env) {
    const u = this.taa.material.uniforms;
    const dst = this.taaRT[this.taaPing], hist = this.taaRT[this.taaPing ^ 1];
    u.tCur.value = this.hdrRT.texture;
    u.tHist.value = hist.texture;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uCamWorld.value.copy(camera.matrixWorld);
    // last frame's view-projection taking positions relative to this frame's camera
    _sv.setFromMatrixPosition(camera.matrixWorld);
    u.uPrevVP.value.copy(this.prevVP).multiply(_m4.makeTranslation(_sv.x, _sv.y, _sv.z));
    u.uJitter.value.copy(this.jitter);
    u.uAlpha.value = this.taaValid ? TAA.alpha : 1;
    u.uExpo.value = Math.min(env && !env.disabled ? env.exposure * 1.3 : 1, env ? env.exposureMax ?? 1e4 : 1e4);
    this._draw(this.taa, dst);
    this.taaPing ^= 1;
    this.taaValid = true;
    this.prevVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.prevCamPos.setFromMatrixPosition(camera.matrixWorld);
    this.prevFov = camera.fov;
    return dst;
  },

  /** debug=1: count broken scene pixels (read back every 30 frames; a small stall). */
  _countBad(app) {
    if (!this.badPass || !this.badRT) return;
    if ((this._badFrame = (this._badFrame || 0) + 1) % 30 !== 1) return;
    const u = this.badPass.material.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.uSize.value.set(this.size.x, this.size.y);
    this._draw(this.badPass, this.badRT);
    const w = this.badRT.width, h = this.badRT.height;
    const buf = this._badBuf && this._badBuf.length === w * h ? this._badBuf : (this._badBuf = new Float32Array(w * h));
    try {
      app.renderer.readRenderTargetPixels(this.badRT, 0, 0, w, h, buf);
      let n = 0;
      for (let i = 0; i < buf.length; i++) n += buf[i];
      this.badPixels = n;
    } catch (e) { /* format not readable here */ }
    // surface it in stats() (debug runs only)
    if (app.stats && !app.stats.__badPixels) {
      const f = app.stats, self = this;
      app.stats = () => ({ ...f(), badPixels: self.badPixels });
      app.stats.__badPixels = true;
    }
  },

  render(dt, app) {
    // renderer.info accumulates over the whole frame (scene, shadow passes and post),
    // so stats() reports real draw calls and triangles rather than the last quad
    const info = app.renderer.info;
    info.autoReset = false;
    info.reset();
    // (a time step that is not positive, as the first frame after a long load can bring,
    // must not run the adaptation filters backwards)
    try { this._render(dt > 0 ? dt : 0, app); } finally { info.autoReset = true; }
  },

  _render(dt, app) {
    const { renderer: r, scene, camera } = app;
    const env = app.systems.env;
    const pr = r.getDrawingBufferSize(this._dbs || (this._dbs = new THREE.Vector2()));
    if (pr.x !== this.size.x || pr.y !== this.size.y) this.setSize();

    const prof = this.prof;
    if (prof) { prof.collect(); prof.begin('scene'); }
    const info = r.info;
    // ---- 1. HDR scene (plus the shadow passes inside it), jittered by a sub-pixel offset
    // for the temporal AA (the projection's inverse, which the shadow cascades are fitted
    // from, stays unjittered)
    const taa = this._taaBegin(app, camera);
    this._moverMax = this._movers(app, camera);
    r.setRenderTarget(this.sceneRT);
    r.clear();
    try { r.render(scene, camera); } finally { if (taa) this._taaRestore(camera); }
    const perf = app.perf;
    if (perf) { perf.sceneCalls = info.render.calls; perf.sceneTris = info.render.triangles; }

    // camera uniforms
    const P = camera.projectionMatrix.elements;
    this.camU.uNear.value = camera.near;
    this.camU.uFar.value = camera.far;
    this.camU.uProjXY.value.set(P[0], P[5]);
    this._todParams(env, camera);

    // ---- 1b. walking people's motion (TAA history, motion blur)
    if (prof) prof.begin('people');
    this._people(app, camera);

    // ---- 2. SSAO (half res)
    if (prof) prof.begin('ao');
    if (this.q.ao) {
      this.depthDown.material.uniforms.tDepth.value = this.sceneRT.depthTexture;
      this._draw(this.depthDown, this.zRT);
      const au = this.aoPass.material.uniforms;
      au.tZ.value = this.zRT.texture;
      au.uTexel.value.set(1 / this.zRT.width, 1 / this.zRT.height);
      au.uFocalPx.value = P[5] * this.zRT.height * 0.5;
      this._draw(this.aoPass, this.aoRT);
      const bu = this.aoBlur.material.uniforms;
      bu.tAO.value = this.aoRT.texture; bu.uDir.value.set(1 / this.aoRT.width, 0);
      this._draw(this.aoBlur, this.aoRT2);
      bu.tAO.value = this.aoRT2.texture; bu.uDir.value.set(0, 1 / this.aoRT.height);
      this._draw(this.aoBlur, this.aoRT);
    }

    // ---- 3. volumetric clouds (half res, sky pixels only)
    const pu = this.prepass.material.uniforms;
    const clouds = env && !env.disabled ? env.clouds : null;
    if (clouds) {
      if (prof) prof.begin('clouds');
      pu.tClouds.value = clouds.render(camera, this.sceneRT.depthTexture, app.frame);
    } else {
      pu.tClouds.value = null;
    }
    pu.uUseClouds.value = clouds ? 1 : 0;

    // ---- 3b. how much of the sun disc is visible (drives the lens glare), and its veil
    this._sunGlare(env, camera, P, clouds);
    this._sunVeil(env, camera);

    // ---- 4. scene prepass
    if (prof) prof.begin('prepass');
    pu.tScene.value = this.sceneRT.texture;
    pu.tDepth.value = this.sceneRT.depthTexture;
    pu.tAO.value = this.aoRT ? this.aoRT.texture : null;
    pu.uCamWorld.value.copy(camera.matrixWorld);
    pu.uCamPos.value.copy(camera.position);
    pu.uTime.value = app.time;
    const air = env?.lights?.airlight;
    if (air) { pu.uHeadI.value = air.headI; pu.uHeadCos.value.set(air.headCos[0], air.headCos[1]); }
    const L = env?.lights;
    pu.uFarI.value = L ? L.farIntensity : 0;
    pu.uFarMin.value = L ? L.farMinDist : 60;
    if (L) pu.uLampCos.value.set(L.lampCos[0], L.lampCos[1]);
    this._dofParams(env, camera, app.realDt > 0 ? app.realDt : dt);
    this._draw(this.prepass, this.hdrRT);

    // ---- 4b. temporal anti-aliasing (history reprojected by depth and camera motion)
    let img = this.hdrRT;
    if (taa) {
      if (prof) prof.begin('taa');
      img = this._taaResolve(camera, env);
    }
    if (this.debug) this._countBad(app);

    // ---- 5. depth of field (gather, full res)
    if (this.q.dof) {
      if (prof) prof.begin('dof');
      const fu0 = this.dof.material.uniforms;
      fu0.tSrc.value = img.texture;
      fu0.uTexel.value.set(1 / this.size.x, 1 / this.size.y);
      this._draw(this.dof, this.dofRT);
      img = this.dofRT;
    }

    // ---- 6. camera motion blur (full res)
    if (this._blurParams(app, camera)) {
      if (prof) prof.begin('blur');
      const bu = this.blur.material.uniforms;
      bu.tSrc.value = img.texture;
      bu.tDepth.value = this.sceneRT.depthTexture;
      const dst = img === this.hdrRT ? this.dofRT : this.hdrRT;
      this._draw(this.blur, dst);
      img = dst;
    }

    // ---- 7. blur pyramid for bloom
    if (prof) prof.begin('pyramid');
    const du = this.down.material.uniforms;
    let src = img;
    for (let i = 0; i < this.downs.length; i++) {
      du.tSrc.value = src.texture;
      du.uTexel.value.set(1 / src.width, 1 / src.height);
      du.uKaris.value = i === 1 ? 1 : 0;
      du.uClamp.value = i === 1 ? 60 / Math.max(env ? env.exposure : 1, 1e-4) : 1e4;
      this._draw(this.down, this.downs[i]);
      src = this.downs[i];
    }
    const uu = this.up.material.uniforms;
    let low = this.downs[this.downs.length - 1];
    for (let i = this.downs.length - 2; i >= 1; i--) {
      uu.tLow.value = low.texture;
      uu.tHigh.value = this.downs[i].texture;
      uu.uTexel.value.set(1 / low.width, 1 / low.height);
      this._draw(this.up, this.ups[i]);
      low = this.ups[i];
    }

    // ---- 8. metered exposure (1x1, adapted over time)
    const lu = this.lum.material.uniforms;
    const small = this.downs[this.downs.length - 1];
    lu.tSmall.value = small.texture;
    lu.uSize.value.set(small.width, small.height);
    lu.tPrev.value = this.lumRT[this.lumPing].texture;
    lu.uRate.value = this.firstFrame ? 1 : 1 - Math.exp(-dt / 0.8);
    this.lumPing ^= 1;
    this._draw(this.lum, this.lumRT[this.lumPing]);

    // ---- 8b. local level of the surfaces (highlight recovery in the final pass)
    const fu = this.final.material.uniforms;
    if (fu.uLocal.value.y > 0) {
      if (prof) prof.begin('local');
      const lu0 = this.localPass.material.uniforms, L = this.localRT;
      lu0.tSrc.value = img.texture;
      lu0.tDepth.value = this.sceneRT.depthTexture;
      lu0.uSrcSize.value.set(img.width, img.height);
      this._draw(this.localPass, L[0]);
      const bu = this.localBlur.material.uniforms;
      bu.tSrc.value = L[0].texture; bu.uDir.value.set(1 / L[0].width, 0);
      this._draw(this.localBlur, L[1]);
      bu.tSrc.value = L[1].texture; bu.uDir.value.set(0, 1 / L[0].height);
      this._draw(this.localBlur, L[0]);
      fu.tLocal.value = L[0].texture;
    }

    // ---- 8c. glow around sources far above white (from sunset on)
    fu.tGlow.value = low.texture;
    if (fu.uGlow.value > 0 && this.glowDowns && this.glowDowns.length === 3) {
      if (prof) prof.begin('glow');
      const gu = this.glowPass.material.uniforms, G = this.glowDowns, Gu = this.glowUps;
      const src0 = this.downs[0];
      gu.tSrc.value = src0.texture;
      gu.uTexel.value.set(1 / src0.width, 1 / src0.height);
      gu.tLum.value = this.lumRT[this.lumPing].texture;
      this._draw(this.glowPass, G[0]);
      du.uKaris.value = 0; du.uClamp.value = 1e4;
      for (let i = 1; i < 3; i++) {
        du.tSrc.value = G[i - 1].texture;
        du.uTexel.value.set(1 / G[i - 1].width, 1 / G[i - 1].height);
        this._draw(this.down, G[i]);
      }
      // a tighter skirt than the bloom: more of the finer levels
      uu.uScatter.value = TONE.glowScatter;
      let gl = G[2];
      for (let i = 1; i >= 0; i--) {
        uu.tLow.value = gl.texture;
        uu.tHigh.value = G[i].texture;
        uu.uTexel.value.set(1 / gl.width, 1 / gl.height);
        this._draw(this.up, Gu[i]);
        gl = Gu[i];
      }
      uu.uScatter.value = 0.68;
      fu.tGlow.value = gl.texture;
    }

    // ---- 9. final
    if (prof) prof.begin('final');
    fu.tHDR.value = img.texture;
    fu.tBloom.value = low.texture;
    const tail = this.ups[Math.min(3, this.ups.length - 2)] || low;
    fu.tTail.value = tail.texture;
    fu.tLum.value = this.lumRT[this.lumPing].texture;
    fu.tDepth.value = this.sceneRT.depthTexture;
    fu.tClouds.value = pu.tClouds.value;
    fu.uUseClouds.value = pu.tClouds.value ? 1 : 0;
    fu.uTime.value = app.time + app.frame * 0.618;
    r.setRenderTarget(null);
    r.render(this.final, this.cam);
    if (prof) {
      prof.end();
      const t = prof.timings;
      t.post = (t.people || 0) + (t.ao || 0) + (t.clouds || 0) + (t.prepass || 0) + (t.taa || 0) + (t.dof || 0) + (t.blur || 0) + (t.pyramid || 0) + (t.local || 0) + (t.glow || 0) + (t.final || 0);
      t.total = t.post + (t.scene || 0) + (t.shadow || 0) + (t.main || 0) + (t.envmap || 0);
      app.perf.gpuMs = t.total;
    }
    this.firstFrame = false;
  },
};

export default post;
