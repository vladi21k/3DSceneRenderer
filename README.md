# Tramline — Cab Ride

A photoreal first-person ride in the cab of a street tram, through a historic limestone city
street, running live in the browser. The whole street — a loop of about 6 km with its
buildings, shopfronts, balconies, trees, overhead line, café terraces and several hundred
people — is generated procedurally from a deterministic plan and rendered with three.js on
WebGL 2, with no build step.

## Screenshots

| | |
|---|---|
| ![Default view from the cab, early afternoon](docs/screenshots/01_default.jpg)<br>Default view from the cab, early afternoon | ![Midday on the avenue](docs/screenshots/02_midday.jpg)<br>Midday on the avenue |
| ![Golden hour at a tram stop](docs/screenshots/03_golden_hour.jpg)<br>Golden hour at a tram stop | ![Sunset, street lamps coming on](docs/screenshots/04_sunset.jpg)<br>Sunset, street lamps coming on |
| ![Dusk with lit shops and lanterns](docs/screenshots/05_dusk.jpg)<br>Dusk with lit shops and lanterns | ![An oncoming tram](docs/screenshots/06_oncoming_tram.jpg)<br>An oncoming tram |
| ![People at the stop (40 degree lens)](docs/screenshots/07_people.jpg)<br>People at the stop (40 degree lens) | ![Café terraces and shopfronts (40 degree lens)](docs/screenshots/08_cafe_street.jpg)<br>Café terraces and shopfronts (40 degree lens) |
| ![Facade close-up from the sidewalk](docs/screenshots/09_facade_close.jpg)<br>Facade close-up from the sidewalk | ![Further down the line (28 degree lens)](docs/screenshots/10_telephoto.jpg)<br>Further down the line (28 degree lens) |

## Running it

**Requirements:** a desktop browser with WebGL 2 and a discrete GPU. Tested on Chrome on
Linux with an NVIDIA RTX 4060 Ti.

```sh
python3 serve.py            # prints: Serving on http://localhost:8080/
python3 serve.py 9000       # optional port (and a second argument: bind address)
```

Open the URL it prints (`http://localhost:8080/`). Any static file server rooted at the
repository works as well (for example `python3 -m http.server 8080`); the page must be served
over HTTP, not opened as a file, because it loads ES modules. `serve.py` only adds no-cache
headers and a deep request queue, since the app fetches about 200 modules at once.

The first load downloads the human figures (about 33 MB) and takes about 16-17 s on a quiet
machine before the "Click to ride" screen appears, most of it spent compiling shaders. Click
to start: the tram departs from a standstill with a bell, and sound starts.

**URL parameters** (core ones in `src/core/params.js`, the rest in `docs/ARCHITECTURE.md`),
e.g. `http://localhost:8080/?s=1450&tod=0.55&fov=28`:

| Parameter | Meaning |
|---|---|
| `s=<m>` | start position along the route in metres (wraps round the loop) |
| `tod=<0..1>` | time of day: 0 midday, 0.55 golden hour, 0.8 sunset, 1 dusk (default 0.12) |
| `fov=<deg>` | vertical field of view, honoured exactly (default 17°, a telephoto) |
| `speed=<km/h>` | starting speed (the automatic driver then picks its own cruise speed) |
| `auto=0\|1` | automatic driving (default 1) |
| `freeze=1` | freeze the simulation clock (a still frame that keeps rendering) |
| `capture=1` | no interface, no start click and no sound (used for screenshots) |
| `q=low\|med\|high` | quality preset (default high; see Performance) |
| `seed=<int>` | world seed (default 7); the content is identical on every visit |
| `view=s,d,h,yaw,pitch` | free inspection camera in route coordinates (metres, degrees); e.g. `view=430,9,1.7,-60,8` stands on the right sidewalk looking at the facades |
| `only=a,b` / `skip=a,b` | enable only / disable the named modules (`street`, `buildings`, `facades`, `ironwork`, `vegetation`, `catenary`, `furniture`, `trams`, `humans`, `crowd`, `ui`, `audio`, `post`, `farfield`); materials, env, train and cameraRig always load |

Also `debug=1` (stats overlay) and `rec=<fps>` (fixed-step recording, see Tooling). The
modules read a few inspection switches of their own: `sky=streaks|cumulus|haze` (cloud regime),
`tram=<s>` (first oncoming tram's position), `prof=1` (post-processing GPU timers), `taa=0`,
`taaj=<px>` and `sharp=<k>` (anti-aliasing and sharpening), `ffnear=<m>` (far field starts
nearer), `audio=1` (sound even with `capture=1`), `audiocache=0` (re-synthesise the sound bank),
`glbox=0` (three's own scalar uniform uploads), and the light and sky values `mie`, `mieh`,
`miealb`, `mieg`, `alt`, `hlev`, `hslope`, `skychroma` and `skysat`. `docs/ARCHITECTURE.md`
lists these and the remaining comparison switches.

## Controls

| Input | Action |
|---|---|
| Click on the start screen (or `Enter` / `Space`) | start the ride (the tram departs with a bell; audio starts) |
| `W` / `↑` | master controller one notch towards power |
| `S` / `↓` | master controller one notch towards brake |
| `A` (or the Auto/Manual button) | toggle automatic driving |
| `B` / `Space` | ring the bell |
| Drag with any mouse button | look around (grab the view); eases back to centre when released |
| `Z` / `X` (held), mouse wheel | zoom in / out |
| Time-of-day slider (bottom right) | midday to dusk |
| Lens slider (bottom right) | zoom, shown as a 35 mm-equivalent focal length |
| `H` | hide / show the interface |
| `M` | sound on / off (remembered by the browser) |
| `F` | full screen |

- The controller has ten notches: `EB` (emergency), `B4`-`B1`, `N`, `P1`-`P4`. Holding `W` or
  `S` steps about six notches a second. In automatic mode either key switches to manual
  driving: the controller takes the notch nearest the current effort and then steps from there.
- In manual mode station stops are still automatic, and a speed supervisor keeps the tram
  within curve and switch limits. After the dwell the tram departs by itself if the
  controller is at `N`; with a brake notch selected it waits for `W`. Hold `W` to run
  through a stop.
- Mouse look has soft limits of about 60° to either side and 25° up or down. Zoom covers
  12°-60° of vertical field of view (about 21-114 mm equivalent; the default 17° is about
  80 mm).
- Letter keys follow the printed keyboard layout; keys with Ctrl, Alt or Cmd are ignored.
- The HUD (bottom left) shows the speed and any lower speed limit, the controller strip,
  the driving mode and the distance to the next stop or the door state at a platform.

## How it was built

Plain ES modules on a vendored three.js r186. Each part is a module loaded by dynamic import
(`src/main.js`); a module that fails is logged and disabled while the rest keeps running.
Module contracts are in `docs/ARCHITECTURE.md`.

**Route and layout plan** (`src/world/route.js`, `src/world/layout.js`, `src/core/config.js`,
`src/core/rng.js`). The line is a closed loop of about 6 km built from straights, clothoid
transitions and circular arcs, with gentle S-meanders so no street is ruler-straight, and
designed hills (the avenue ahead of the start climbs about 21 m at about 5.8 %). Everything is
placed in route coordinates (distance along the street, lateral offset, height). Two
standard-gauge tracks run at ±1.6 m from the centre line; the camera rides the right one.
A deterministic master plan, computed once from a seeded random generator, places the
stations and side platforms, crossovers, cross streets, building lots, poles, trees, about 250
café terraces, street furniture and the obstacles the crowd avoids. The ground has a sidewalk
cross-fall, a slow hillside tilt and settlement undulation, and every object stands on it.

**Chunk streaming, LODs and start-up** (`src/world/streaming.js`, `src/core/farfield.js`,
`src/main.js`). The route is streamed in 40 m chunks: full detail within 200 m, a lighter
level out to 680 m, and a far field out to 1400 m, built from the same plans as merged blocks
with one draw call per chunk that shades itself as a street canyon beyond the sun's shadow
range. Builds are time-sliced (about 7 ms per frame, nearest first), and chunks crossing a
level boundary are rebuilt and swapped without gaps. During the ride a new chunk's shader
programs compile in the background and its vertex buffers go to the GPU ahead of time within a
2 MB per-frame budget, so no frame uploads a whole chunk. At start-up the module inits overlap
the shader compile (programs are queued as soon as they are known), every program gets its
first draw before the ride starts, and readiness gates (the texture bake, the foliage atlas)
keep anything from popping in.

**Procedural GPU-baked PBR materials** (`src/materials/`: `baker.js`, `recipes/`,
`library.js`, `surface.js`). Every tileable surface texture is baked on the GPU at start-up from a GLSL recipe
evaluated per texel (albedo, roughness, normal, height, occlusion): limestone ashlar and
rock-faced stone, grey granite setts, rail steel, iron, glass, canvas, wood, paint, plaster,
roof tiles, bark, leaves and the rest of a library of about forty materials. A runtime patch
on three.js's standard materials removes tiling (row layouts with per-row shifts and per-block
tone, mirrored map lookups), adds chisel dressing, weathering (soiled ledges, run-off streaks
down walls), grime lanes along the rails, gum spots and spill blots, specular anti-aliasing
from the baked normal variance, and parallax-occlusion relief with self-shadowing on
rock-faced stone. UVs are in metres everywhere.

**Buildings and facade plans** (`src/world/facadePlan.js`, `src/world/buildings.js`,
`src/world/buildings/`). `facadePlan(lot)` is the architectural description of each front,
shared by every module that dresses it: floors (mostly 4-6, from 2 to 9), bays of varying
rhythm, openings (shops, doors, windows, balcony doors with flat, round, segmental or pointed
heads, arcaded triple lights), balconies, string courses, cornice, parapet, roof, rooftop
clutter and style. The street mixes late-Ottoman and Mandate-era ashlar fronts with about a
quarter of later blocks (wide flat windows, slab balconies, many rendered and colour-washed),
neighbours in different stone tones, and towers or landmarks where a view ends. The shell
builder turns each plan into masonry: walls with real openings and reveals, coursing aligned
across the front, arches with voussoirs and keystones, surrounds, sills, cornices with dentils
and modillions, parapets or tiled roofs, rustication, quoins, pilasters, corner returns, party
walls, murals and set-back upper storeys, built as time-sliced jobs.

**Facades, shopfronts, signs and interiors** (`src/world/facades.js`, `src/world/facades/`).
Windows, doors, shutters (louvred and roller), shopfronts and awnings follow each opening's
outline. Window glass reflects a traced stand-in of the street and shows a room traced per
pixel behind it (homes about 4 m deep, shops about 7 m), with furniture, shelving with goods,
mannequins and curtains, lit by daylight through the opening and by lamps at dusk; lit shops
then light their reveals and the pavement in the colour of their own lamps (2700-5000 K by
trade). A canvas atlas of invented shop names (Hebrew lettering over an English
transliteration), trade words, phone numbers, posters and price cards feeds fascia boards,
projecting light boxes, discs and blades. Trades put goods out on the pavement (produce,
flowers, clothes racks, newspapers, bakery trays, sacks, shoes, books), registered as crowd
obstacles.

**Ironwork and balconies** (`src/world/ironwork.js`, `src/world/ironwork/`). Moulded stone
balcony slabs on carved consoles placed clear of the window dressing below, wrought-iron
railings or stone balustrades, planters, AC units, flags and satellite dishes. Railings are
instanced geometry near the camera and coverage cards far away that fade in under the bars.
Level of detail is chosen per instance from its projected size, so it follows the zoom. The
railings' rust pattern is shared with the stains on the wall below, and everything is drawn
street-wide in a few batches rather than per chunk.

**Street, track and paving wear** (`src/world/street.js`, `src/world/street/`). Granite setts
in the track corridor, light stone edge bands, gutters and sidewalks with camber and
unevenness; 3D grooved rails up close (polished running band, oxidised field side, grit in the
flangeway) and anti-aliased rail lines far away; crossovers with switches and frogs, cross
streets with kerbs, cast-iron covers, drains and road markings. Wear is placed per chunk:
relaid stretches of setts, asphalt and concrete repairs, a drip band along each track, oil
under the bogies where trams stand at the stops, rust halos round covers, gutter silt and weeds.

**Trees** (`src/world/vegetation.js`, `src/world/vegetation/`). Young pagoda trees,
narrow-leaved ash and hackberry or fig-like trees, with some old ones, grown once at start-up
by space colonisation inside a crown envelope, with pipe-model branch radii, bark tubes with
collars and three detail levels. Leaf cards carry shoot tips from a leaf atlas painted on CPU
canvases in workers. Trees are instanced along the street with per-tree scale, lean, yaw and
tint. The shaders add wind (trunk sway, branch motion, leaf flutter, matched in the shadow
pass), light passing through the crown, sky occlusion inside it and leaf translucency.

**Lamps, catenary and street furniture** (`src/world/catenary.js`, `src/world/catenary/`,
`src/world/furniture.js`, `src/world/furniture/`). Ornate lamp standards with forged lyre
brackets and globe lanterns that switch on as the light fades; an overhead contact line with a
staggered contact wire per track at 6 m, cross-span wires with insulators, droppers,
registration arms and pull-offs on curves; pole banners; pedestrian signals that turn red as a
tram approaches. All of it is instanced street-wide, with detail chosen per standard by
on-screen size. The furniture module places café terraces (tables, chairs, market umbrellas,
place settings), tram-stop platforms and shelters, benches, bins, bollards, kiosks, advert
columns, bike racks, ticket machines, A-boards, utility cabinets, vendor carts and parked
vehicles in the cross streets, as batched instances with cross-faded detail levels.

**Human figures** (`src/crowd/humans.js`, `src/crowd/humans/`, `tools/blender/mh_*.py`,
`assets/humans_mh/`). A cast of 49 dressed characters (men, women, teens, children, the
elderly and toddlers, in summer clothing) is built from the MakeHuman CC0 system assets with
the MPFB2 add-on in headless Blender, inside the project's Docker tools image (the variant from
`docker/Dockerfile.mh`). `mh_build.py` runs the stages: bodies from shape macros and targets,
CC0 clothes, hair and eyes with garment edits and skin weights converted to a 22-bone runtime
skeleton; strand-card hair groomed over each scalp; shared texture arrays with synthesised
clothing folds; four LODs per character, per-vertex occlusion and quantised geometry
(`cast.json`, `cast.bin.gz`, WebP texture strips). In the browser an appearance seed picks a
character and varies clothing colours and patterns, hair, skin, height, face shape, glasses,
bags and stance. Walk, idle and sitting clips are baked once and blended on the CPU into
bone matrices in a float texture; the figures are skinned on the GPU and drawn as instances of
one batched mesh (a single multi-draw call per pass, coarser LODs in the shadow cascades),
with a contact shade under the feet. Strollers with rolling wheels and bicycles with turning
cranks are attached props, and parked bicycles stand at the racks.

**Crowd behaviour** (`src/crowd/crowd.js`, `src/crowd/behaviour/`). Up to 980 people are kept
from 42 m behind the cab to 560 m ahead, spawned where they cannot be seen and recycled behind.
About half of those on foot walk in pairs and threes, talking in turns; children walk hand in
hand; café parties sit down and leave together and waiters serve the tables; passengers wait
at the platforms; others browse shop windows and goods stands, go up side streets, push
strollers or ride bicycles. Steering uses social forces around obstacles and walls, people
obey the pedestrian signals, clear the tracks ahead of every tram with a margin outside the
cab's swept volume, react to the bell and never pass through the camera. New people avoid
cast characters already in use within 20 m.

**Tram ride dynamics and the fixed cab camera** (`src/ride/train.js`, `src/ride/cameraRig.js`,
`src/ride/trams.js`, `src/ride/trams/`, `src/ride/ui.js`, `src/ride/input.js`). The tram is a
32 m five-module low-floor vehicle: constant torque up to 32 km/h, then constant power to a
50 km/h governor, running resistance and the route grade, and jerk-limited traction and
braking. The automatic driver cruises at 40-45 km/h on a clear corridor and 23-28 km/h when
people walk in it, keeps curve and 25 km/h crossover limits, coasts into braking curves, stops
at the platforms (12-18 s dwell with doors and a bell) and brakes, rings and creeps for people
on the track. The camera is mounted on the cab body at 2.75 m eye height, 1.7 m behind the cab
front, and never pans towards the line ahead, like a fixed cab-ride camera; it carries body
sway, hunting, bob, roll in curves, pitch under braking, knocks at rail joints and turnout
parts (the same ones the audio plays), a fine running shake and a shutter time for motion blur
(1/160 s by day to 1/50 s at dusk). The cab tram is never drawn but casts its shadow. Two
oncoming trams run the loop the other way with the same driving model, see-through glazing
over a modelled saloon with passengers, and paint and glass that reflect the street.

**Sky, lighting, shadows and post-processing** (`src/env/`). A physically based atmosphere
(transmittance, multiple-scattering and sky-view lookup tables) with dust aerosol and a low
urban haze; volumetric cumulus ray-marched at half resolution and cirrus layers, in one of
three weather regimes per seed; real solar geometry for early September at 31.8° N mapped onto
the afternoon. Image-based lighting comes from an HDR cube of the sky over a street-canyon
model, with bounce light from sunlit facades. At dusk a pool of real spot lights follows the
nearest lanterns (about 3300 K), more distant lamp pools are added in screen space, and the
tram's dipped headlight lights the rails. The sun casts four cascades fitted to the field of
view out to 700 m, with penumbrae that harden towards contact; static casters are merged into
depth-only proxies in the background. The post chain works like a camera: HDR scene with MSAA
and sub-pixel jitter, SSAO, aerial perspective and heat shimmer, temporal anti-aliasing (16
jitter samples, reprojection of moving trams, cyclists and walkers), depth of field for a
1-inch sensor, camera and per-object motion blur, bloom, metered exposure, lens veil,
highlight recovery, sharpening, white balance, a camera tone curve with AgX colour, and grain.

**Synthesized audio** (`src/ride/audio.js`, `src/ride/audio/`). No recorded samples: every
sound is synthesised with WebAudio: sample buffers in workers (cached in IndexedDB), endless
noise and the inverter's PWM live in AudioWorklets. Layers: the two-strike bell, rolling noise and wheel knocks at the same rail
joints and turnout parts as the camera, curve squeal, the traction inverter whine and gear
mesh, brakes and doors, the oncoming trams passing, and street ambience driven by the real
crowd (conversations placed at the people talking, footsteps, birds), mixed through cab and
street reverbs and spatialised.

## Tooling

- **`tools/dk <cmd>`** runs a command in the Docker tools image (`docker/Dockerfile`: Blender
  4.5 LTS, Node 24, Python with numpy, scipy and Pillow, ImageMagick, ffmpeg, gltf-transform)
  with the repository mounted at `/work`, building the image on first use. `DK_GPU=1` adds the
  GPU; `TRAM_TOOLS_IMAGE=tramline-mh:latest` selects the human-figure image, which
  `tools/mh_fetch.sh` builds after fetching MPFB2 and the MakeHuman assets.
- **`tools/shoot.py`** drives headless Chrome on the GPU over the DevTools protocol (standard
  library only). It starts a private `serve.py`, waits for the app to report ready, saves
  screenshots and prints console errors and frame stats. Options include `--params`,
  `--shots`/`--interval`, `--settle`, `--eval`, `--fps` (a frame-rate cap, as vsync would
  give), `--hitches` (frame timing with a per-hitch cause), `--heapprof`, `--cpuprof` and
  `--firstdraw`. Chrome and the server are killed on every way out. Example:
  `timeout 600 python3 tools/shoot.py --params "s=420&tod=0.55" --out .work/shots/x.png --timeout 300`.
- **`tools/record.py`** records fixed-step video: the page runs with `rec=<fps>`, so every
  frame advances the clock by exactly 1/fps however long it takes to render; frames are grabbed
  as JPEGs and encoded with ffmpeg in the tools image to `.work/movies/<name>/` (1080p and a
  small phone copy).
- **`tools/checkpoint.sh`** is a periodic progress checkpoint: every 20 minutes by default it
  captures three views, converts them to JPEG and commits the working tree with a message
  listing the changed areas, files and line counts.
- `tools/textures/preview.html` shows the baked material maps.

## Performance and trade-offs

The target is 30 fps at 1920×1080 on an RTX 4060 Ti with image quality first: a frame
budget of about 28 ms GPU and 20 ms CPU, no riding hitches over 60 ms, under about 1500 draw
calls and about 10 M triangles including shadow passes. Measured: GPU about 15.5 ms median per
frame, and 0 riding frames over 60 ms at a 30 fps cap; the triangle count peaks at about
9.8 M on busy stretches.

Cold start is about 16-17 s on a quiet machine, against a 10 s target. It is dominated by
shader compilation: the browser compiles about 140 programs one at a time in its GPU process,
so the start-up overlaps everything else with that compile, and fewer or smaller programs are
the remaining lever.

Main trade-offs:

- **Telephoto 17° default lens.** It matches the long-lens look of street photographs and
  compresses the street. Because the camera is fixed to the cab body, the line leaves the frame
  for up to about 6 s in tight bends; 24-30° keeps it in frame (zoom, or `fov=`).
- **LOD distances.** Full detail within 200 m, a lighter level to 680 m and the merged far
  field to 1400 m. At 17°, 200 m is about 5.5 cm per pixel, so the lighter level keeps every
  moulding and drops only sub-pixel detail. Railings, lamp standards, trees and figures choose
  their detail per instance by projected size, which follows the zoom.
- **Shadow cascade sizes.** Four cascades of 4096-texel tiles (a 16384×4096 atlas, about 320 MB)
  give about 1 cm texels in the nearest cascade, so railing bars and lamp arms cast real
  shadows, at about 0.6-1 ms of extra shadow pass. To pay for it the two far cascades redraw
  only every 2nd and 4th frame and skip thin casters, static casters are drawn as merged
  depth-only proxies (coarse ones in the far cascades), figures cast with coarse LODs, and
  beyond 700 m the far field shades itself.
- **Crowd size.** Up to 980 people from 42 m behind to 560 m ahead (about 790 active a few
  seconds after the default start). Density tapers off beyond 450 m, and beyond 340 m people skip
  avoidance and use cheap kinematics.
- **Quality presets.** `q=med` uses three 2048-texel cascades, 8 lamp lights and lighter SSAO;
  `q=low` uses two 1536-texel cascades and turns off MSAA, SSAO, depth of field and motion
  blur. The pixel ratio is capped at 1.5 (1 on low).

## Assets and licences

Details in `docs/ASSETS.md`.

- **three.js r186** (`vendor/three/`), vendored unmodified: MIT, see `vendor/three/LICENSE`.
  The app uses the build and these add-ons: `geometries/RoundedBoxGeometry.js`,
  `lights/SunLight.js`, `lights/SunLightShadow.js`, `utils/BufferGeometryUtils.js` (MIT). The
  rest of the add-on tree is not loaded; third-party libraries in it keep their own licences.
- **Human figures** (`assets/humans_mh/`): CC0 1.0, built in this repository by
  `tools/blender/mh_*.py` with the MPFB2 add-on (v2.0.18) from the MakeHuman system assets
  (CC0 1.0). MPFB2 itself (GPL-3.0) is a build tool only; none of its code is shipped.
- **Everything else** is procedural and made by this repository's code: geometry built at
  run time, textures baked on the GPU or painted into canvases, sky and lighting computed,
  sound synthesised. Apart from the figures' texture strips, no image, HDR, sound or font files
  are shipped; signs use fonts installed on the viewer's system.
- Build-time tools (Blender, Node, gltf-transform, Python libraries, ImageMagick, ffmpeg,
  headless Chrome) run in the tools image or locally and are not shipped.
- **`reference/*.jpg`** (and `.jpeg`) are third-party photographs kept only as visual reference
  for judging the result. They are never loaded by the app, never used as textures, and are not
  covered by any licence of this project; their copyright stays with their photographers.

## Repository layout

```
index.html            page and import map
serve.py              static server
src/
  main.js             module registry, start-up, frame loop
  core/               config, shared runtime, far field, renderer patches, frame timing
  world/              route, layout, streaming, buildings, facades, ironwork, street,
                      vegetation, catenary, furniture
  materials/          GPU texture baker, recipes, material library, surface shading
  env/                atmosphere, sky, clouds, sun and shadows, lights, post-processing
  crowd/              human figures (humans/) and crowd behaviour (behaviour/)
  ride/               tram dynamics, cab camera, oncoming trams, input, HUD, audio
assets/humans_mh/     the built human cast
vendor/three/         three.js r186
tools/                shoot.py, record.py, dk, checkpoint.sh, mh_fetch.sh, blender/, textures/
docker/               tools image and human-figure image
docs/                 ARCHITECTURE.md, ASSETS.md, PLAN.md, screenshots/
reference/            third-party reference photographs (not part of the app)
```

`.work/` (git-ignored) holds scratch output from the tools.
