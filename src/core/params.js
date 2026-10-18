// URL parameters. Everything has a sensible default; capture/debug options exist so
// automated screenshots can reproduce a precise view.
//
//   s=<m>          start position along the route (metres, wraps)
//   tod=<0..1>     time of day: 0 midday, 0.55 golden hour, 0.8 sunset, 1 dusk
//   fov=<deg>      vertical field of view
//   speed=<km/h>   initial speed
//   auto=0|1       automatic driving (default 1)
//   freeze=1       freeze the simulation clock (static frame, still renders)
//   capture=1      hide UI / overlays, no click-to-start gate
//   only=a,b       only enable the named modules (plus core); e.g. only=street,buildings
//   skip=a,b       disable the named modules
//   view=s,d,h,yaw,pitch   free inspection camera in route coordinates (deg)
//   q=low|med|high quality preset
//   debug=1        stats overlay; post adds stats().badPixels (broken HDR pixels)
//   seed=<int>     world seed
// Read by the modules themselves (params.num / params.str), documented in ARCHITECTURE.md:
//   sky=streaks|cumulus|haze   cloud regime (env)      tram=<s>    first oncoming tram's nose (trams)
//   prof=1         post's per-section GPU timers        taa=0       temporal AA off (post)
//   taaj=<px>      TAA jitter amplitude (post)          sharp=<k>   final luma sharpening (post)
//   ffnear=<m>     far field starts nearer (streaming)  audio=1, audiocache=0 (audio)
//   glbox=0        scalar uniform uploads as three makes them (main.js unboxedUniforms off, A/B)
//   mie, mieh, miealb, mieg, alt, hlev (env) and hslope, skychroma, skysat (post): light and sky inspection

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && q.get(k) !== '' && !isNaN(+q.get(k)) ? +q.get(k) : d);
const list = (k) => (q.get(k) ? q.get(k).split(',').map((x) => x.trim()).filter(Boolean) : null);

export const params = {
  s: num('s', null),
  tod: num('tod', 0.12),
  fov: num('fov', null),
  speed: num('speed', null),
  auto: num('auto', 1) !== 0,
  freeze: num('freeze', 0) === 1,
  capture: num('capture', 0) === 1,
  only: list('only'),
  skip: list('skip') || [],
  view: q.get('view') ? q.get('view').split(',').map(Number) : null,
  quality: q.get('q') || 'high',
  debug: num('debug', 0) === 1,
  seed: num('seed', 7),
  raw: q,
  num,
  str: (k, d = null) => (q.has(k) ? q.get(k) : d),
};
