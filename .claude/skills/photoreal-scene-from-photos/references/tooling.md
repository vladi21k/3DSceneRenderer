# Tooling: capture, measure, record, checkpoint

How to see, measure and record a browser 3D scene from an agent's terminal, and the
environment traps that cost hours in the worked example (a photoreal tram cab ride, three.js,
~200 sub-agents sharing one Linux machine with an RTX 4060 Ti). Every script named here is
in `scripts/` of this skill: generic, standard-library Python where possible, tested.

**Contents**
1. [The toolkit](#1-the-toolkit)
2. [Set-up in a new project](#2-set-up-in-a-new-project)
3. [App-side hooks the tools expect](#3-app-side-hooks-the-tools-expect)
4. [shoot.py: screenshots, evals, profiles](#4-shootpy-screenshots-evals-profiles)
5. [Timing discipline and frametimes.js](#5-timing-discipline-and-frametimesjs)
6. [record.py: smooth offline video](#6-recordpy-smooth-offline-video)
7. [imgstats.py: numbers against the reference photos](#7-imgstatspy-numbers-against-the-reference-photos)
8. [Blind A/B between two builds](#8-blind-ab-between-two-builds)
9. [serve.py, dk and the tools image](#9-servepy-dk-and-the-tools-image)
10. [checkpoint.sh and reporting to a remote user](#10-checkpointsh-and-reporting-to-a-remote-user)
11. [Environment lessons (failure, cause, fix)](#11-environment-lessons)

## 1. The toolkit

| Script | Use it for | Needs |
|---|---|---|
| `shoot.py` | screenshots (.png/.jpg), console errors, `stats`, JS probes (`--eval`), CPU/heap profiles, first-draw audit | Python 3, Chrome |
| `frametimes.js` | frame-time percentiles, hitches, GPU/CPU over budget, heap and GC, long frames; evaluated in the page by `shoot.py` | the page |
| `record.py` | fixed-timestep offline MP4s (master + ~3 MB phone copy) | Chrome, ffmpeg (or `dk`) |
| `imgstats.py` | tone, clipping, colour, detail metrics vs reference photos; frame diffs (pop-in); A/B sheets; crops; metadata-free JPEGs | numpy, Pillow (or `dk`) |
| `serve.py` | the no-cache static server people use to run the app | Python 3 |
| `dk` + `Dockerfile.tools` | Blender (headless), Node, gltf-transform, ImageMagick, exiftool, ffmpeg, numpy/scipy in one image | Docker |
| `checkpoint.sh` | periodic captures + informative git commits during long runs | git, bash 4 |

## 2. Set-up in a new project

- Copy `scripts/*` into the project's `tools/` on day one, before any module agent starts:
  every agent then verifies visually with the same tool, and its numbers compare.
- Add `.work/` to `.gitignore`. All scratch output (screenshots, profiles, logs, movies)
  lives there, inside the workspace (the user asked for that), and never gets committed.
- Build the tools image early in the background (`docker build -t scene-tools:latest -f
  tools/Dockerfile.tools tools/`, or the first `tools/dk` call does it): Blender + Node
  downloads take minutes.
- Smoke-test the capture path on the grey-box scene within the first hour:
  `python3 tools/shoot.py --out .work/shots/m1.jpg` must print a real GPU in its `gpu:` line,
  `ready=True` and no `[error]` lines. In the example the grey box, streaming core and GPU
  capture all ran end to end about 25 minutes in, which let 13 builder agents start at once.

## 3. App-side hooks the tools expect

Agree this contract in the architecture doc before fanning out; every module owner relies on it.

| Hook | Meaning | Why it matters |
|---|---|---|
| `window.__ready = true` | everything visible is built, compiled and drawn | a shot before it shows a half-loaded scene; set it ~300 ms after the app's own ready |
| readiness gates | ready waits for worker-painted atlases, GPU texture bakes, nearby chunks (cap each gate, e.g. 20 s, and log which timed out) | trees were bare in the first frames until the leaf atlas became a gate |
| `window.__fatal = msg` | start-up failed | the tool stops waiting at once instead of timing out after 4 min |
| `window.__progress` | any JSON (stage, chunks built) | printed every 30 s while loading: tells "slow" from "stuck" |
| `window.__app.stats()` | fps, cpuMs, gpuMs, draw calls, triangles, programs, textures, per-module build ms, frame percentiles, disabled modules | one `stats:` line per capture gives every agent a perf reading for free |
| `capture=1` | no UI, no click-to-start, no audio; loading veil removed in the ready frame | a CSS fade only advances on browser frames, which Chrome can withhold for seconds after a cold start: shots caught a half-faded veil |
| `freeze=1` | simulation dt = 0, rendering continues | identical frames for before/after and A/B (TAA still converges) |
| `rec=<fps>` + `app.recStep(n)` | dt = 1/fps exactly; sim holds still until ready; own loop stops after ready | smooth offline video (section 6) |
| `view=s,d,h,yaw,pitch` | free inspection camera in path coordinates (metres along the path, lateral offset, height; degrees) | close-ups of facades, people from behind, a sidewalk view: e.g. `view=430,9,1.7,-60,8` |
| `s=`, `tod=`, `fov=`, `speed=`, `seed=` | start position, time of day 0..1, lens, speed, world seed | reproducible views; a fixed list of named views is the regression suite |
| `only=a,b` / `skip=a,b` | load only / skip named modules | blame: which module costs the ms, which module throws, which makes the bad pixels |
| `debug=1` | stats overlay plus `stats().badPixels` (NaN/negative HDR pixels, counted every 30 frames) | any non-zero count is a shader bug to fix at its source (normalize of zero, negative light) |
| `window.__frameEnd?.(cpuMs, gpuMs)` | called at the end of every rendered frame | lets `frametimes.js` count frames the app pumps from a timer (below) |

Determinism is part of the contract: all content randomness comes from a seeded generator
keyed by purpose (`RNG.from(seed, lotId, 'joinery')`, mulberry32 over FNV hashes in the
example), never `Math.random()`. Without it no before/after or A/B comparison means anything.

Minimal frame loop that satisfies the contract (three.js-style; adapt names):

```js
const q = new URLSearchParams(location.search);
const P = { capture: q.get('capture') === '1', freeze: q.get('freeze') === '1', rec: +(q.get('rec') || 0) };
const app = (window.__app = { frame: 0, time: 0, ready: false });
function frame(ts) {
  const t0 = performance.now();
  const realDt = P.rec ? 1 / P.rec : Math.min(Math.max(timer.getDelta(), 0), 0.1); // clamp: first rAF ts can be stale
  const dt = P.freeze || (P.rec && !app.ready) ? 0 : realDt;
  app.time += dt; app.frame++;
  for (const m of modules) if (!m.disabled) try { m.update(dt, app); } catch (e) { console.error(m.name, e); }
  render();
  window.__frameEnd?.(performance.now() - t0, gpuTimer.last);
  if (!app.ready && world.readyAround(camera, 160) && gatesSettled()) {
    app.ready = true;
    if (P.capture || P.rec) loading.style.display = 'none';
    setTimeout(() => { window.__ready = true; }, 300);
  }
  if (!(P.rec && app.ready)) requestAnimationFrame(frame);
}
app.recStep = (n = 1) => { for (let i = 0; i < n; i++) frame(performance.now()); return app.frame; };
// each module by dynamic import: a broken one is logged and skipped; retry once (a dropped request)
const load = (p) => import(p).catch(() => new Promise((r) => setTimeout(r, 250)).then(() => import(`${p}?retry=1`)));
main().catch((e) => { console.error(e); window.__fatal = String(e.stack || e); });
```

Also worth adding (all paid off in the example): a GPU timer on
`EXT_disjoint_timer_query_webgl2` keyed by frame number (results arrive a few frames late, so
store them in a ring and look them up by frame), a frame monitor that logs every interval over
50 ms with each module's update time next to its usual (median) value, and an animation-frame
watchdog (section 11, "cold start hung").

## 4. shoot.py: screenshots, evals, profiles

```sh
python3 tools/shoot.py --params "s=420&tod=0.55" --out .work/shots/gold.jpg        # one shot (.jpg: phone-ready)
python3 tools/shoot.py --params "s=700&speed=40" --shots 4 --interval 0.5 --out .work/shots/seq.png
python3 tools/shoot.py --params "speed=0&freeze=1&view=430,9,1.7,-60,8" --settle 6 --out .work/shots/facade.png
python3 tools/shoot.py --params "speed=0" --shots 0 --eval "JSON.stringify(window.__app.stats())"
python3 tools/shoot.py --params "s=900" --shots 0 --eval-file .work/probes/rails_centred.js   # a probe
python3 tools/shoot.py --shots 0 --cpuprof 30                                 # start-up: main-thread time by file/function
python3 tools/shoot.py --params "speed=45" --shots 0 --settle 30 --heapprof 30 --heapdelay 20   # warm allocation sites
python3 tools/shoot.py --params "speed=45" --shots 0 --settle 150 --heaplive 30   # what the heap grows by
python3 tools/shoot.py --profile .work/prof --params "speed=60" --shots 0 --settle 30 --firstdraw   # late shader first use
python3 tools/shoot.py --reap                                                 # kill browsers of dead runs
```

What one run prints: `machine at start` (load, other headless browsers, GPU %), `gpu:` (the
WebGL renderer string), `url:`, `ready=True after 17.2s`, saved files with sizes, `stats:`,
`eval:`, console `[error]`/`[warning]` lines, `machine at end`. On a failed start it prints the
last 40 console messages whatever the flags: one intermittent fatal in about 30 runs could not
be diagnosed because the lines before it had not been kept.

Key options (all: `--help`): `--root` (served dir, default cwd), `--page`, `--params`,
`--url` (any URL instead of serving), `--out` (.png/.jpg; several shots become `name_00.ext`),
`--quality`, `--width/--height` (1920x1080), `--shots`, `--interval`, `--settle` (seconds
after ready; the scene runs meanwhile), `--timeout` (240 s), `--force`, `--pre/--pre-file`
(JS at ready), `--eval/--eval-file` (JS at the end; promises awaited), `--init/--init-file`
(JS before the page's own scripts: stub or hook browser APIs), `--console`, `--fps N`,
`--wait-quiet S`, `--require-gpu`, `--profile DIR`, `--work DIR`, `--max-seconds`,
`--ready-expr`, `--fatal-expr`, `--stats-expr`, `--veil` (selector, default `#loading`).
Exit codes: 0 ok, 1 never ready/fatal, 2 Chrome did not start, 3 console errors, 4 software
GL with `--require-gpu`, 124 `--max-seconds`, 130 Ctrl+C. Env: `SHOOT_GPU_FLAGS` (replace GPU
switches), `SHOOT_CHROME_FLAGS` (add switches), `SHOOT_STDERR=<file>` (keep Chrome's output),
`SHOOT_CHROME` (binary), `SHOOT_WORK`.

How it stays robust (keep these if you rewrite it):
- **GPU in headless Chrome**: `--headless=new --enable-gpu --ignore-gpu-blocklist
  --use-angle=gl` was set on day one and never needed changing on Linux + NVIDIA (renderer
  string `ANGLE (NVIDIA ..., OpenGL ES 3.2)`). Without GPU flags headless Chrome may fall back
  to SwiftShader (software): images look plausible but every timing is meaningless, so check
  the `gpu:` line.
- **No port collisions**: `--remote-debugging-port=0`, then read the real port from
  `<profile>/DevToolsActivePort`. With a fixed port, two agents starting at once would drive
  each other's browser.
- **Fresh profile per run** (cold shader cache, like a first-time viewer) unless `--profile`
  is given (warm cache: what a returning viewer sees; needed for the first-draw audit).
- **Cache-busting**: a random `cb=` parameter on every URL plus a no-cache server: agents edit
  modules between captures, and a cached module means a screenshot of old code.
- **Browser lifetime**: Chrome runs in its own process group; it is killed on exit, on
  exceptions, on SIGTERM/SIGINT/SIGHUP (from `timeout`), and by a watchdog process holding a
  pipe to the tool if the tool is SIGKILLed (tested: 0 browsers 7 s after `kill -9`). Each run
  first reaps browsers tagged `--shoot-owner=<pid>` whose tool is gone. Still wrap every call
  in `timeout 600`.
- **In-process server** on a free port, so no server outlives the tool either.

Probes via `--eval` are the cheapest way to turn "looks wrong" into a number. Examples that
settled arguments in the worked example: people's foot height above the ground at 8 standard
views (expect `bad: 0`; written after the user spotted floating people, then rerun every round), the screen x of the
ride track's centre at the frame bottom over a 2 km sweep (the camera must read as on the
rails), crowd swept-volume violations (`crowdCheck=1`), a time-of-day sweep counting shader
programs created (`setTimeOfDay` must not compile new programs). Keep probes in
`.work/<stage>/*.js` and quote their numbers in reports.

## 5. Timing discipline and frametimes.js

Most "regressions" reported by agents on a shared machine were contention (owner runs at load
11-25 with the GPU 90-100 % busy logged 64-167 hitches; the same build on a quiet machine, 0).
Rules, with why:

- **Cap the frame rate** for every timing run (`--fps 30` for a 30 fps budget, 60 otherwise).
  Headless Chrome has vsync off; an uncapped loop queues frames ahead of the GPU and blocks in
  GL calls. Measured: CPU p95 24-26 ms uncapped vs 8-13 ms capped on the same build, plus
  storms of fake 50-110 ms "gpu-wait" hitches. GPU time is the same either way (median 12.95 ms
  capped vs 12.88 ms uncapped).
- **One capture at a time on a quiet machine.** Three parallel gallery captures reported p95
  frame times of 98-127 ms that meant nothing. `--wait-quiet 900` waits for: no other headless
  browser, load1 < 0.2 x cores, GPU < 30 %, four checks in a row. Print the machine load next
  to every number (the tool does, at start and end).
- **No screenshots in a timing run** (`--shots 0`): a screenshot stalls the frame it is in.
- **Skip warm-up**: JIT, first shader use and the first streaming burst dominate short runs;
  use `warmup` in frametimes.js or `--heapdelay`.
- **Builders measure structure, a QA agent measures time.** While 10+ agents share the GPU,
  ask builders for structural numbers (draw calls, triangles, programs, upload bytes, allocations
  per frame, ms as a minimum over runs) and schedule one serial QA agent on a quiet machine
  for the budget numbers. Pause `checkpoint.sh` during it.

```sh
# one shot: 30 s of riding after 5 s warm-up, capped at 30 fps
python3 tools/shoot.py --params "speed=40" --shots 0 --settle 0 --fps 30 --wait-quiet 900 \
  --pre "window.__FT={seconds:30, warmup:5, where: () => Math.round(window.__app.cameraS)}" \
  --eval-file tools/frametimes.js
# two phase: install at ready, sample during --settle, summarise at the end
python3 tools/shoot.py --params "speed=40" --shots 0 --fps 60 --pre-file tools/frametimes.js --settle 30 --eval-file tools/frametimes.js
```

The summary is JSON: `source` (app hook or rAF), `capped`, `frames`, `fps`, `intervalMs`
{p50,p95,p99,max,mean}, `over` {33,50,60,100 ms}, `cpuMs`/`gpuMs` (with the hook),
`cpuOverBudget`/`gpuOverBudget` (defaults 20/28 ms), `calls`, `trianglesM`, `heapMB`
{start,end,min,max}, `gc` {n, mb, perMin}, `hitches` [{t, ms, cpu, gpu, where}],
`longFrames` (long-animation-frame entries with the scripts responsible).
Budget used in the example (30 fps target at 1080p): GPU <= 28 ms, CPU <= 20 ms, no riding
frame over 60 ms, under ~1500 draw calls and ~10 M triangles including shadow passes;
achieved GPU ~15.5 ms median, 0 riding frames over 60 ms.

Why the `__frameEnd` hook: after a cold start Chrome withheld animation frames for 0.75-3.5 s
in 31 of 40 fresh-profile starts (0 of 5 with a warm profile; once for over 2 minutes). The
app pumps frames from a timer then; a sampler on its own rAF loop missed those frames and
reported a first interval of 0.35-3.6 s where the app's monitor saw at most 49 ms.

Cold start (navigation to `__ready`) is its own metric: measure it 10-20 times serially with
fresh profiles; report median and worst. Example: 32 s at first, 15 s once shaders were
compiled against the real post-processing target, later overlapping compilation
(`KHR_parallel_shader_compile` via `compileAsync`) with module start-up; content growth took
it back to 16-17 s, against a 10 s target that was never reached.
`--cpuprof` shows which files own the main-thread time; `--firstdraw` lists programs first
drawn mid-ride (each cost 100-250 ms).

## 6. record.py: smooth offline video

```sh
python3 tools/record.py --name midday --params "s=700&tod=0.1" --seconds 40
python3 tools/record.py --name dusk --params "s=4000&tod=0.95" --seconds 20 --fps 30 \
  --status-expr 'JSON.stringify({s: window.__app.stats().s})'
python3 tools/record.py --name dusk --encode-only        # re-encode existing frames
```

- A live recording of a heavy scene stutters; this steps `app.recStep(1)`, grabs a JPEG
  (quality 94) after each step through DevTools, and encodes later, so playback is smooth
  however slow a frame is. Cost in the example: 95-325 ms per 1080p frame, about 3-10 minutes
  per 30 s clip.
- `--warmup 60` frames before recording fill TAA history and let staged chunk reveals finish;
  `--settle 2` s lets background compiles land. The first recorded frame is then clean.
- Output `.work/movies/<name>/`: `frames/`, `<name>_1080p.mp4` (x264 crf 18; 33-115 MB for
  30-45 s) and `<name>_phone.mp4` (1280 px, bitrate sized to `--phone-mb`, default 3; real
  clips landed at 2.3-2.4 MB). No audio: the sound is synthesised live in the page.
- ffmpeg comes from PATH, else `tools/dk ffmpeg`, else `--ffmpeg "CMD"`.
- Use clips for anything about motion: camera sway, people's gait, pop-in (`imgstats.py diff`
  on the frames), passing trams. The user judged "the camera floats between the tracks" from
  clips, not stills.

## 7. imgstats.py: numbers against the reference photos

```sh
python3 tools/imgstats.py stats .work/shots/default.jpg --ref "reference/*.jp*g" \
  --region sun=0.45,0.55,0.55,0.62 --region shade=0.45,0.75,0.55,0.85
python3 tools/imgstats.py diff ".work/movies/ride/frames/*.jpg" --region vp=0.4,0.3,0.6,0.5
python3 tools/imgstats.py sheet old.png new.png --out .work/ab/view_01.jpg --labels L,R
python3 tools/imgstats.py crop shot.png crop.png 0.45 0.35 0.55 0.5 --scale 2
python3 tools/imgstats.py jpeg shot.png shot.jpg --width 1600 --quality 85
```

All images are resized to 1000 px wide first, so photos and renders compare on one scale.
`stats` prints each reference, the reference range, each render and the metrics outside the
range. What the metrics caught in the example (reference ranges from its 5-7 street photos):

| Metric | References | What a bad render showed | Fix it pointed to |
|---|---|---|---|
| mean / p50 / p98 Y' | 110-144 / 115-169 / 200-249 | 83-90 / 75-84 / 158-187 (0.75 EV dark, no highlights) | exposure meter clamp, highlight shoulder |
| clip% (max ch >= 250) | 0.05-11.6 % (median 1.35) | 0 % by day; 6.4 % at sunset (white sky) | horizon cap applied after metering |
| black% (crushed shadows; Y' <= 10 here) | 0.1-5 % | 15-28 % at golden hour | tone-curve toe too steep |
| colourfulness | 28-60 | 24-35 day, 16-17 dusk | grade under-saturated |
| HSV saturation | 0.22-0.52 | 0.14-0.22 | same |
| R/B (white balance) | sunlit paving 0.88-0.94 | 1.06-1.11 (too warm) | balance on the sun's direct light |
| shade EV vs sun, same stone | -3.3 to -3.45 EV, shade R/B 0.40-0.65 | -1.8 to -2.0 EV, R/B 0.85-0.96 | bounce light added twice |
| hp1 (fine detail) | 6.8-16 | 4.9-7.6 | texture detail, sharpening |
| frame diff in the vanishing point | n/a | median 8.9, p95 14.7, one spike = rail-joint jolt | no LOD pop-in |

Use the numbers to steer, not to finish: a fix that moved one metric into range often moved
another out (one exposure rework overshot and left daylight 0.75-1 EV under the photos for a
round).
Always look at the image too, and keep the reference crop next to the render crop in reports.
Regions are the same box on every image: compare like with like (an A/B of one view), and
measure a reference with a different composition in a separate call with its own boxes.

## 8. Blind A/B between two builds

The last accept/revert decision in the example was made this way (new build preferred 20 to 13,
3 ties, over 12 views by 3 judges):

1. Export each build: `git archive <sha> | tar -x -C .work/ab/old` (and `new`); `mkdir
   .work/ab/old/.work` (profiles go there). Serve each from its own root (`--root`).
2. Render each view of a fixed list (default, midday, golden hour, sunset, dusk, close-ups,
   people, an oncoming vehicle; 12 in the example) from both builds with identical params
   including `freeze=1`, one capture at a time on a quiet machine, `timeout 600`, checking
   every log for `ready=True` and 0 errors.
3. Make one `sheet` per view with neutral labels `L`/`R`; the side assignment is randomised
   per view in the orchestrating script and never written to disk; delete raw renders and logs.
4. Several judge agents (different emphasis: overall realism; light, colour and materials;
   people, motion and street life) study the reference photos first, then pick L/R/tie per
   view with a margin and a reason. The script un-blinds and tallies.

## 9. serve.py, dk and the tools image

- `python3 tools/serve.py [port] [--root DIR] [--bind 0.0.0.0]`: threaded, listen backlog
  512, `.js/.mjs` as `text/javascript`, `Cache-Control: no-cache`, `--owner PID` makes it exit
  when that process dies. `python3 -m http.server` (backlog 5) dropped connections when the app
  fetched ~200 modules at once, and a random dynamic import failed.
- `tools/dk <cmd>`: runs in the tools image as your uid, with the git top level mounted at
  `/work` and the current directory kept (so relative paths work); builds the image on first
  use; `-t` only on a real terminal (agents have none); `DK_GPU=1` for Cycles bakes;
  `DK_PORTS="8080:8080"` to publish ports; `DK_IMAGE` for a derived image (the example built a
  second image on top with MakeHuman assets for the crowd figures).

```sh
tools/dk blender -b --factory-startup -P tools/blender/lamp.py -- --out assets/lamp.glb
tools/dk gltf-transform inspect assets/lamp.glb      # sizes, draw-relevant counts
tools/dk node --check src/world/streaming.js         # syntax check without a browser
tools/dk convert in.png -strip -quality 88 out.jpg   # metadata-free JPEG
tools/dk exiftool -a docs/screenshots/*.jpg          # prove no metadata leaks
```

`Dockerfile.tools`: Ubuntu 24.04, Blender 4.5 LTS tarball (+ its X11/GL libs, needed even
headless), Node tarball + `@gltf-transform/cli`, python3 numpy/scipy/Pillow, ImageMagick,
exiftool, ffmpeg, git; `HOME=/tmp` because the container runs as a uid with no home.
A blind comparison forbids tool and vendor names in metadata: strip glTF `generator` /
`copyright` fields and image EXIF/XMP, and check them before delivery.

## 10. checkpoint.sh and reporting to a remote user

```sh
nohup tools/checkpoint.sh 1200 >> .work/checkpoint.log 2>&1 &
echo "M4 round 2: lighting and materials fixes" > .work/checkpoint_note.txt   # at every stage change
printf 's=700&tod=0.3\ns=1450&tod=0.55&fov=40\nview=430,9,1.7,-60,8\n' > .work/checkpoint_views.txt
touch .work/checkpoint.pause      # during serial timing; rm to resume
kill "$(cat .work/checkpoint.pid)"  # stop
```

Every interval it renders the first view plus two rotating ones as JPEGs into
`.work/shots/auto/HHMM/`, then commits with a message like:

```
Checkpoint 09:31: core, lighting/post, materials

Stage: M4.8 photoreal round: lighting and materials fixes

- lighting/post (+214/-61): post.js, sky.js
- materials (+88/-20): ashlar.js, library.js

5 files changed, 302 insertions(+), 81 deletions(-). Views captured (.work/shots/auto/0931): default; s=700&tod=0.3; view=430,9,1.7,-60,8; console errors: 0.
```

Area names come from `.work/checkpoint_areas.txt` (`glob<TAB>area`). Also write a
descriptive milestone commit by hand at the end of each stage (what changed, verified numbers).
The log line `CHECKPOINT <dir> ...; console errors: N` is for a watcher; alert only on errors.

What the remote user taught the orchestrator (they followed on a phone):
- **Send JPEGs, never PNGs**: a 3 MB PNG upload timed out; 1920 px JPEG q85-88 is 0.3-0.6 MB.
  Video: a 9 MB MP4 timed out (30 s cap); 2-3.2 MB arrived. Hence `record.py`'s phone copy.
- **Report when something finished**, with images of that change (before/after crops), not
  on a timer: "don't blindly update... if nothing changed, no need to show more images".
  Reused images and a 35-minute silence both drew complaints earlier, so: no news without
  new pictures, and no long silence while work is landing.
- **Informative commits, no attribution**: "Auto checkpoint HHMM" was rejected; commit
  messages, file names, page titles and metadata never name a model, vendor or agent.
- **Docker for tooling, everything inside the workspace**; commit regularly so any step
  can be reverted.

## 11. Environment lessons

| Symptom | Cause | Fix |
|---|---|---|
| GPU at 97 % for 78 min, every timing slow | orphaned headless Chrome from a killed tool, rendering uncapped | process groups + watchdog + reap tagged orphans each run; `timeout` on every call |
| 1 start in ~30 aborted: "materials module unavailable" | never proven (lines before it not kept); suspected a dropped request in the 200-module burst (default backlog 5) | backlog 512, threaded server, one import retry with `?retry=1`; not reported again |
| shots show a half-faded loading screen | CSS fade advances only on browser frames, withheld after cold start | remove the veil in the ready frame under `capture=1`; tool waits for it, then hides it |
| bare trees / untextured walls in early shots | ready fired before worker-painted atlas / GPU bake | readiness gates (promise per module, capped), ready waits for them |
| cold start froze 0.75-3.5 s in most fresh starts, 125-134 s in 2 of ~200 | Chrome withholds rAF after a big shader compile with an empty shader cache | app watchdog: no rAF for 400-750 ms while visible and idle, run frames from a timer |
| uncapped CPU times 2-3x too high, fake hitches | vsync off headless; GL calls block on a queued GPU | `--fps` cap for timing runs |
| perf "regressions" that vanish on rerun | 10+ agents and their captures sharing the GPU | serial QA on a quiet machine; load next to every number; structural metrics for builders |
| a mid-ride 90 ms stall 0.7 s into every ride | first lod-0 chunk revealed 9 MB of geometry in one frame | upload ahead within a per-frame byte budget (2 MB), build chunks for 40 m ahead before start |
| 100-250 ms stalls at certain positions | shader programs first drawn mid-ride | compile and first-draw every program before ready; audit with `--firstdraw` and a warm profile |
| (risk) two runs started together share a fixed DevTools port and drive one browser | fixed `--remote-debugging-port` | port 0 + `DevToolsActivePort` |
| screenshots of stale code | browser/module cache | no-cache server + `cb=` parameter + fresh profile |
| `docker run -t` fails for agents | no TTY | `-t` only when stdin and stdout are terminals |
| intermittent start-up fatal, cause unknown | console lines before the failure not captured | print the console tail on every failure; soak 30-50 starts when something is intermittent |
| long-running agents' results lost | a QA agent hit its usage limit mid-run | agents write logs and partial results under `.work/<stage>/` as they go |
| a log watcher went quiet | the watcher (a Monitor on the log or the workflow journal) ends at its own timeout | re-arm it each time; check it whenever a stage should have finished |
| the agent's own shell died (exit 144; found while writing these scripts) | `pkill -f <pattern>` matched the calling shell's command line | stop by pid (`.work/checkpoint.pid`), or `shoot.py --reap` for browsers |
| a quiet-machine check that can never pass (found while writing these scripts) | `pgrep -f -- --headless` also matches non-browser daemons started with a `--headless` flag | match the Chrome executable and skip `--type=` children (`shoot.py` does) |

Worked example for deeper reading (paths in the finished project):
`/home/vlad/dev/reps/3DSceneRenderer/tools/shoot.py`, `tools/record.py`,
`tools/checkpoint.sh`, `tools/dk`, `docker/Dockerfile`, `serve.py`, `src/main.js` (frame
loop, readiness gates, animation-frame watchdog, `recStep`, `stats`), `src/core/frameMonitor.js`,
`src/core/gpuTimer.js`, `src/core/params.js`, `src/core/rng.js`, `.work/m46/qa/run.sh`
(quiet-machine wrapper), `.work/m46/qa/pre.js` and `eval.js` (QA sampler), and the README's
Commands section.
