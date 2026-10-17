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
//   debug=1        stats overlay
//   seed=<int>     world seed

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
