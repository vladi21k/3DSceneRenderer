# Performance: budgets, cold start, hitches, and measuring them honestly

What it took to keep a photoreal browser world (three.js r186, WebGL2, plain ES modules) at a
steady frame rate while 10+ agents kept adding detail. Worked example:
`/home/vlad/dev/reps/3DSceneRenderer` (`src/main.js`, `src/world/streaming.js`, `src/core/
frameMonitor.js`, `src/core/rendererPatches.js`, `tools/shoot.py`, `docs/ARCHITECTURE.md` sections
"Start-up" and "Frame timing, garbage and budget").

## Contents
1. Set the budget with the user, then spend it
2. The numbers over time
3. Measuring reliably
4. Cold start
5. Riding hitches
6. Garbage
7. GPU frame cost and shader programs
8. Shadows
9. Triangles and draw calls
10. Checklist

---

## 1. Set the budget with the user, then spend it

The brief asked for 60 fps at 1920×1080. Mid-build the user said 30 fps was fine: the build is
judged on photorealism. That changed every trade-off, so it went into
`docs/ARCHITECTURE.md` (every agent reads it) and into the orchestrator's memory notes at once.

Final budget (RTX 4060 Ti, 1080p, quality first):

| Item | Budget | Why |
|---|---|---|
| GPU per frame | ≤ ~28 ms | 30 fps with margin; headroom goes to image quality |
| CPU per frame | ≤ 20 ms | |
| Riding hitches | none > 60 ms | a single stall reads as a glitch in a cab-ride video |
| Draw calls | < ~1500 incl. shadow passes | CPU submit cost |
| Triangles | < ~10 M incl. shadow passes | |
| Chunk build | < 3 ms (lod 0), < 1 ms (lod 1) per module | streaming time slice ~7 ms/frame |
| Cold start | ≤ 10 s on a quiet machine | **never met** (16.7 s at delivery) |

Headroom was then spent on purpose: 4096-texel shadow cascades (about 1 cm texels near the cab,
so railing bars cast real shadows), 16-sample SSAO, MSAA plus temporal AA, denser crowds (up to
980 people). Record such decisions with the measured cost: the 4096 tiles cost about +0.6 to 1 ms
of shadow pass and 320 MB of VRAM.

## 2. The numbers over time

| Stage | GPU median | Draw calls | Triangles | Programs | Cold start |
|---|---|---|---|---|---|
| All 13 areas built (busy machine) | ~16 ms | 1166 to 1300+ | ~9 M | ~190 | 31 to 32 s |
| Integration pass (busy machine) | 9.6 ms | 629 | | | 15 s |
| First QA, clean GPU | 8.8 to 9.1 ms | 586 to 646 (max 759) | 5.9 to 6.1 M (max 9.1 M) | 117 | 14.5 to 16.4 s |
| Status audit, two days later | 9.3 ms | ≤ 912 | ≤ 7.0 M | | **19.3 s** (regressed) |
| Quiet-machine QA, 4096 shadows | 12.95 ms (p95 14.1) | 727 (max 945) | 6.2 M (max 8.9 M) | 128 | 17.1 s (55 runs) |
| Next round, before regression fix | 18.0 ms | 737 | 7.1 M (max 9.6 M) | 132 | 16.0 s |
| Delivery | ~15.5 ms | ~740 (max ~910, last measured) | peaks 9.8 M | 139 | 16.7 s |

Garbage: 117 MB/s in early rides; whole app 1365 → 920 KB/frame after one sweep; 320 KB/frame
(19 MB/s) at the quiet QA. Heap: ~920 MB at ready, flat at 1150 to 1250 MB after the first lap.

Lessons from the table:
- Cold start regressed by about 3 s over a day and a half of image-quality rounds with nobody
  watching it. Track it in every verification pass, not only in perf rounds.
- GPU time rose from 9 to 15.5 ms as headroom was deliberately spent; the one unplanned jump
  (+4 ms, section 7) was caught only because a serial verification compared against the last
  accepted build.

## 3. Measuring reliably

This was the most expensive lesson. With 10+ agents each running headless Chrome captures on one
GPU, the machine sat at load 14 to 97 on 32 threads, with up to about 100 headless Chrome
processes and the GPU 80 to 100 % busy. The same configuration measured 14 ms in one run and
73 ms in the next. For several rounds no agent could confirm the budget at all.

**Separate structural metrics from timings.** Draw calls, triangles, program count, bytes
uploaded, allocations per frame and program re-evaluations do not change with load: agents can
measure those any time. Milliseconds need a quiet machine.

**Run timing serially.** Give timing to one QA agent that runs alone after all builders finish,
and wrap every timed run in a wait-for-quiet gate that logs machine state before and after. Make
the capture tool print load average, headless browser count and GPU % at the start and end of
every timing run, so every number in a report carries its conditions:

```bash
# waits for: no other headless browser, no capture tool, GPU < 30 %, load1 < 6 (4 s in a row)
while :; do
  n=$(pgrep -fc -- "--headless"); g=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits)
  l=$(cut -d' ' -f1 /proc/loadavg | cut -d. -f1)
  [ "$n" -eq 0 ] && [ "$g" -lt 30 ] && [ "$l" -lt 6 ] && ok=$((ok+1)) || ok=0
  [ "${ok:-0}" -ge 4 ] && break; sleep 1
done
echo "machine before: $(uptime) gpu=$g"; timeout 600 python3 tools/shoot.py "$@"; echo "after: $(uptime)"
```

Even then, other runs started mid-ride; a per-process GPU monitor (`nvidia-smi pmon` plus each
Chrome GPU process's owner tag) told contention apart from the ride's own hitches.

**Cap the frame rate as vsync would.** Headless Chrome runs with vsync off; an uncapped loop
queues frames ahead of the GPU and then blocks inside GL calls. Uncapped CPU p95 was 36.6 ms
against 9.8 ms capped on the same ride, with storms of 50 to 110 ms "gpu-wait" frames that a real
display never shows. Cap `requestAnimationFrame` in the page (60 for hitch hunting, 30 for budget
rides). GPU time is the same capped or uncapped.

**Time GPU per frame with timer queries** (`EXT_disjoint_timer_query_webgl2`), keyed by frame
number so the hitch log can pair a slow frame with its GPU time, plus per-section timers in the
post chain behind a switch (`prof=1`).

**Pick the browser profile on purpose.** Fresh profile (empty shader cache) for cold-start
numbers; a warm persistent profile for riding hitches. The recurring s ≈ 1600 stall (167 to
209 ms, every lap) only happened with a warm shader cache, so every agent using fresh profiles
failed to reproduce it for a whole round.

**Make the frame log explain itself.** `src/core/frameMonitor.js` records every interval over
50 ms with: route position and speed, CPU per module update, streaming and render, each next to its
usual value (median of the last 128 smooth frames), programs created that frame, bytes revealed
and uploaded ahead, shadow-pass time and its longest single draw, heap drop, GPU time and the
browser's long-animation-frame attribution, plus a guessed cause:

| Cause | Meaning | Action |
|---|---|---|
| `sync-compile` | a program was created inside render | warm it at start-up |
| `contention` | every stage, GL-free ones too, ran several times over usual | other processes; repeat the run |
| `gc` | heap drop, excess < 250 ms | find the allocation sites |
| `gpu-wait` | render alone slow for the usual draws, or one shadow draw > 10 ms | GPU behind (often someone else's) |
| `cpu:<stage>` | one stage explains it | that module's work unit is too long |
| `task:<fn>` | a timer or promise callback between frames | |
| `idle-wait` | main thread idle | compositor or GPU back-pressure |

`spikes` lists modules over 4× their usual time + 5 ms whatever the cause: a module that keeps
appearing there has a work unit that must be split.

**Make every sampler count the same frames.** A sampler on its own `requestAnimationFrame` missed
the frames the app ran from a timer while the browser held animation frames back, and reported
0.35 to 3.6 s "frames" the app's own monitor showed as 49 ms. Sample from the app's frame hook.

**Heap: compare per frame, skip warm-up.** Report allocation as KB per frame, not MB/s (a loaded
run makes fewer frames). Start sampling some seconds after ready: the crowd measured 106 KB/frame
over 25 s and 52 KB/frame over 70 s of the same code. Growth that flattens after the first lap is
warm-up and caches, not a leak; check it with a three-lap fly-through and heap snapshots.

**Keep the tools from poisoning the machine.** An orphaned headless Chrome renders uncapped: one
held the GPU at 97 % for 78 minutes. Run browser and server in their own process groups, kill the
group on every exit path (including the tool being SIGKILLed: a watchdog process holding a pipe),
reap leftovers at the start of every run, and let Chrome pick its own DevTools port so parallel
runs never drive each other's browser.

**Keep A/B switches in the code** for every core optimisation (`boot=serial`, `glsort=0`,
`gltyped=0`, `glbox=0`, `lightloop=0`), and verify refactors of hot maths bit-identical on 200k+
random samples, so a change can be judged in one run.

## 4. Cold start

Anatomy at the quiet QA (median of 55 fresh-profile starts, 17.1 s): imports 0.7 s, module inits
4.7 s, chunk prime 0.15 s, **shader compile 9.3 s for 128 programs**, first frames 1.6 s. At
delivery: 16.7 s for 139 programs. The 10 s target was not reached.

### How the browser compiles (Chrome on the ANGLE GL backend, Linux default)
- Programs compile **one at a time in the GPU process**, `KHR_parallel_shader_compile` or not.
  The extension only keeps the main thread free while the queue drains.
- **Any synchronous GL call waits for the whole queue**: a program's first draw, `getUniforms`,
  `getProgramInfoLog`, `readPixels`, `getError`, `getParameter`, a completion-status query, even a
  first `getExtension`. Measured: a material-readiness poll blocked the main thread 12 s; the first
  BatchedMesh's `getExtension('WEBGL_multi_draw')` waited 3.4 s; terminating a worker that had used
  an OffscreenCanvas or ImageBitmap blocked 20 s (Chrome tears down its GPU context synchronously).

### What worked
1. **Compile against the real render target.** Programs depend on output colour space and tone
   mapping. Warm-ups ran against the screen while the scene renders into an HDR target, so every
   program compiled twice. Setting the scene target as current from the post-processing init on
   took the cold start from 32 s to 15 s.
2. **Overlap the start-up.** (a) world modules init; (b) their chunks near the start are built;
   (c) the scene's programs are queued with non-blocking `renderer.compile` at the first module
   boundary after in-flight warm-ups finish, and the remaining inits run while the GPU process
   compiles; (d) late chunk parts and the far field are built, then `compileAsync` waits for
   everything. A download-bound init (the people cast) starts early and runs alongside.
   Rule for modules: no synchronous GL calls in init or start-up timers.
3. **Remove hidden sync calls.** Enable every extension three.js asks for lazily right after
   creating the renderer; set `renderer.debug.checkShaderErrors` only in debug (it calls
   `getProgramInfoLog`); seed three's pixel-store cache (`state.pixelStorei(UNPACK_ROW_LENGTH...,
   0)`) so a partial texture update never reads `UNPACK_*` back (48 to 124 ms each); hold
   `Worker.terminate()` until the compile is done; replace GPU read-backs with tables built once
   (sky irradiance for 129 times of day in one read).
4. **Fewer, smaller programs: the main lever.** Each lit fragment shader was ~105 KB. three.js
   unrolls the spot-light loop, so 13 spot lights inlined the lighting code 13 times; turning that
   block into a real loop when there are no spot shadows cut one program from 245 to 141 ms.
   Library surface features became opt-in per material (−29 % compile); duplicate materials were
   merged (street 16 → 9 programs, ironwork 13 → 8, facades 10 → 8). Count programs in every QA.
5. **Pay every program's first use behind the loading bar.** After the compile, call
   `getUniforms()/getAttributes()` on every program; then give every program one real draw before
   the view counts as ready (section 5).
6. **Readiness gates.** Content finished after init (a texture bake, a foliage atlas painted in a
   worker) is a promise the start-up waits for, capped at 20 s, so nothing pops in (leafless trees
   at the start of the ride were the symptom).
7. **Animation-frame watchdog.** With an empty shader cache the browser held back animation
   frames for 0.75 to 3.5 s in 31 of 40 starts, and for over two minutes in 2 of about 200, behind
   a frozen loading screen, while the page and GPU were fine. When the requested frame has not come
   after 400 ms (750 ms after ready) and the page is visible, run frames from a timer until frames
   come back. 20 cold starts in a row then reached the first frame within 0.4 s.

### What did not work (and why)
- **Compile only what the first view needs, the rest during the ride.** Rejected: a program
  compiled mid-ride sits in the same GPU-process queue as that frame's draws, so each one is a
  50 to 250 ms hitch. Compile everything at start-up.
- **`renderer.compile` after each module's init** (first attempt). The compile phase shrank by
  7 s, but other inits still made sync GL calls that now waited behind the queue: ready times
  went from 31 to 37 s to 33 to 94 s under load. The overlap only paid off (about −11 %) after
  those sync calls were removed from every init.
- **Runtime loop bounds in the shadow filter** to stop unrolling saved ~0.5 s of compile but
  cost 4 ms of GPU every frame (section 7). Reverted.
- **Keeping terminated workers alive** to avoid the frame hold: no effect (16 of 20 still held),
  +430 MB memory. Reverted.
- Left at delivery: ~140 programs at ~70 ms each, compiled serially. Next levers: fewer lit variants,
  smaller shadow sampling code, fewer per-module custom shaders.

## 5. Riding hitches

| Cause | Measured | Fix |
|---|---|---|
| Program compiled mid-ride (a stop's platform material first seen at s ≈ 6000; street details) | 372 ms; 1020 to 1114 ms | create every material variant at start-up; hidden warm-up meshes |
| First use of a compiled program (`getProgramInfoLog` in three's first use) | 47 to 102 ms | call `getUniforms()` on every program behind the loading bar; shader checks only in debug |
| **First draw** of a compiled program with a warm shader cache (café cups within 30 m at s ≈ 1600, every lap) | 167 to 209 ms, 8 to 10 frames after the draw | each batch draws one instance scaled to 1e-5, 2 m in front of the eye, every frame until ready |
| Whole lod 0 chunk revealed in one frame (7 to 23 MB of vertex data) | 55 to 350 ms | compact vertex format; upload ahead under a 2 MB/frame budget → 7 to 21 ms |
| Synchronous GPU read-back (sky irradiance) | 90 ms (216 to 506 ms under load) | precomputed table; fenced async read as fallback |
| Major GC | 20 to 50 ms, 26 to 30 MB drops every ~6 s | section 6 |
| Unsplittable work unit (one street prefetch step) | 53 ms under load (~15 ms quiet) | split every unit under ~3 ms |
| Prefetch budget scaled by `realDt` (slow frame → bigger budget → slower frame) | 4 to 13 ms updates | fixed absolute budget per nominal 1/60 s, capped (0.8 ms base, 4 ms when a chunk is due) |

Warm-up details that matter:
- **Hidden warm-up meshes must actually draw.** Stand-ins parked at y = −10 000 were frustum
  culled and never drawn, so their programs stayed cold. Put the micro-instance in front of the
  camera instead.
- `renderer.compile` never reaches shadow depth materials; give those casters their draw too.
- Verify with a first-draw audit: hook WebGL from page start and list every program whose first
  non-empty draw came after ready (`tools/shoot.py --firstdraw --profile <warm dir>`). Target: zero.

Uploading ahead, the pattern:

```js
// per frame, nearest staged chunk first, within budget (2 MB incl. this frame's reveals)
const m = uploaderMeshes[used++] ||= addToScene(new THREE.Mesh(EMPTY_GEOMETRY, []));
m.geometry = pendingGeometry;   // empty material array: attributes upload, nothing draws or compiles
// after render: m.geometry = EMPTY_GEOMETRY. Reveal a chunk only when all its buffers went
// at least one frame earlier; the reveal then sends only index and instance buffers.
```

Before the ride starts, build chunks at the detail they will need 40 m later: the default start
lay 9 m before a chunk boundary and its 9 MB lod 0 upgrade landed 0.7 s into the ride.

## 6. Garbage

A major collection pauses the main thread 20 to 50 ms, and minor ones come more often the more a
frame allocates. Target: near-zero allocation in per-frame code.

| Source | Before → after (per frame) | Fix |
|---|---|---|
| People animation (`Math.hypot`, temporaries) | 426 → 13 KB | `Math.sqrt(x*x+y*y+z*z)` (`hypot` with 3+ args allocates); scratch typed arrays |
| Crowd steering | 466 → 50 KB | numbers through object fields and `Float64Array`s, not arguments and returns |
| three.js uniform setters (night lights) | 169 → < 9 KB | typed setters comparing against a `Float64Array` cache, uploading from a `Float32Array` |
| Whole app, frozen view, after patching three.js's render-list sort and uniform setters | 261 → 197 KB | stable merge sort on persistent arrays; typed setters for every program |
| Route and noise maths | ~158 → ~7 KB | `out` parameters; `route.io` typed array; inlined lattice hashes |
| Transparent `DoubleSide` ground-shade material | 21 program re-evaluations/frame, ~9 % of all garbage | `forceSinglePass = true` |

Rules that removed it:
- No closures, arrays or objects per call in hot loops; pass `out` vectors; reuse scratch.
- **Numbers are garbage too**: a call V8 does not inline boxes its float arguments and float
  return (and uint32 values above 2^30, such as hashes). Keep tight loops in one function; write
  `v.x = …` instead of `v.set(a, b, c)` with computed floats on the hottest paths; read results
  out of typed arrays (`rng.nextTo(arr, i)`).
- `Array.prototype.sort` copies its array each call: insertion-sort short per-frame lists.

```js
function sortByDist(a, n) {          // stable, allocation-free, fine for a few dozen items
  for (let i = 1; i < n; i++) {
    const x = a[i], k = x.dist; let j = i - 1;
    while (j >= 0 && a[j].dist > k) { a[j + 1] = a[j]; j--; }
    a[j + 1] = x;
  }
}
```

- **Program re-evaluation** builds a parameter object and a cache-key string each time: never
  draw one material object from both a `BatchedMesh`/`InstancedMesh` and a plain `Mesh` (use a
  variant); give each shadow-caster kind its own copy of the depth material (re-evaluations went
  8.3 → 0 per frame).
- Retained memory: CPU copies of uploaded textures kept alive by an `onUpdate` closure (208 MB of
  people textures) and mipmap copies (32 MB) were constant waste; the first-lap growth was a
  geometry template cache whose every cached piece kept a whole 1 MB slab alive (~180 MB).
  Free CPU copies after upload; size cache slabs to what they hold.

## 7. GPU frame cost and shader programs

At delivery, the default view: ~15.5 ms = main pass ~12.5, shadows 1 to 2, post ~0.9
(SSAO 0.11, TAA 0.19, bloom pyramid 0.13, final 0.14).

Biggest wins:
- **Skip dark lights in the light loop.** A pool of real spot lights (12 lamps + headlight) costs
  nothing by day only if the shader skips lights with zero colour or outside cone/range: −25 % of
  the main pass (13.8 vs 18.3 ms).
- Batching per area (section 9) mostly saves CPU, not GPU.
- A foliage depth pre-pass doubles crown triangles but saved GPU (1.8 vs 2.5 ms): overdraw of
  alpha-tested leaves cost more than the triangles.

The regression worth remembering: a shadow-filter change used runtime loop bounds
(`for (int i = 0; i < N + uZero; i++)`) to stop the compiler unrolling, to save compile time. The
loops no longer unrolled, tap offsets left registers, and the main pass went 12.5 → 16.5 ms. A
serial verification bisected it by swapping that one file between builds. Constant bounds came
back; compile 8.1 s instead of 7.7 s. **Compile time and frame time pull in opposite directions:
measure both before shipping a shader change.**

## 8. Shadows

The sun uses 4 cascades in one atlas row (4096-texel tiles: a 16384 × 4096 atlas with an R8
colour attachment and 24-bit depth, 320 MB; RGBA8 would have been 512 MB), fitted to the field of
view, reaching 700 m; beyond it the far field shades itself (world-architecture.md, section 11).

Measures (together: shadow-pass CPU 3.3 → 1.0 ms, shadow draws 243 → 120, shadow triangles
−24 %, shadow GPU 1 to 2 ms with 4096 tiles):
- Cascades 0-1 redraw every frame, 2 every 2nd, 3 every 4th; all redraw on a 3 m or 3° camera
  move, a zoom or a sun change.
- Far cascades skip `userData.thinCaster` meshes and casters under 1.5 texels.
- Static casters are merged in the background into depth-only proxies, cut into ~13 m cells,
  each with a full and a coarse version (triangles with edges under 0.35 m dropped).
- Bounding spheres are computed once per frame and shared by all cascades; instanced casters
  publish `userData.shadowRange`. Culling costs 0.03 ms for 421 casters.
- The filter samples at most 2 cascades per pixel (it had 4 inlined copies).
- Every caster kind gets its own depth material copy: 0 program re-evaluations in shadow passes.

People were the biggest shadow cost (1.43 M of 2.27 M shadow triangles): cast with coarse LODs.
Thin geometry (railings, sign arms) casts only in the near cascades.

## 9. Triangles and draw calls

Where the frame went at the first QA (6.4 M triangles): main pass 4.0 M + shadows 2.9 M;
people 2.3 M (0.82 main + 1.24 shadows); generic depth 1.2 M; ironwork 0.8 M; foliage ~1.0 M.

Measures, with numbers:
- **Batch per material per chunk, or per scene for small repeated parts**: ironwork 191 → 45
  draw calls, catenary 110 → 10, furniture 174 → ~40, facades ~300 → ~150, street 178 → 106.
  Whole app 1166 → 629 in the integration pass.
- **Cheaper vertices**: building shells 64 → 36 bytes per vertex (snorm8 normals, packed
  colour + grime in unorm8, int16 run data decoded in the vertex shader). Per lod 0 chunk 94.5k →
  58k triangles; generation 36 → 20 ms per chunk (prefetched off the critical path).
- **Detail by projected size, not distance alone**: railings, lamp standards, trees and figures
  pick their LOD per instance from on-screen size, which follows the zoom (12° to 60°).
- **lod 1 drops only what is sub-pixel** (at 17°, 200 m is ~5.5 cm per pixel): mouldings stay,
  tableware and bars go.
- **CPU culling of batches**: per-frame batch culling went 3.1 → 0.35 ms across vegetation,
  furniture and catenary. Note that three.js's BatchedMesh re-sorts and re-uploads its indirect
  texture for every camera, shadow cascades included (~70 small uploads per frame, single ones
  blocking 8 to 17 ms when the GPU queue is full); turn sorting off for depth passes or reuse the
  visible list.

Left at delivery: triangles peak at 9.8 M on busy stretches, close to the 10 M budget.

## 10. Checklist

- [ ] Budget agreed with the user and written into the contract doc, with what headroom buys.
- [ ] Timing runs serial, behind a wait-for-quiet gate, capped as vsync would, logged with
      machine state; structural metrics for everyone else.
- [ ] Frame log with per-stage times, usual values and a cause; GPU timer per frame.
- [ ] Program count and cold start tracked every round; compile against the real render target.
- [ ] No sync GL calls during start-up; extensions enabled up front; shader checks only in debug.
- [ ] Every program compiled, touched and drawn once before ready (first-draw audit: zero late).
- [ ] Readiness gates and an animation-frame watchdog.
- [ ] Chunk reveals and uploads under a byte budget; prefetch budgets absolute, not per `realDt`.
- [ ] Allocation per frame measured after warm-up; no boxed numbers in hot loops.
- [ ] Shader changes measured for both compile time and GPU frame time.
