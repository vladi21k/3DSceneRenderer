---
name: photoreal-scene-from-photos
description: Build a photoreal, real-time, first-person 3D world in the browser (three.js / WebGL) from a handful of reference photos. Examples are a tram or train cab ride, a boat or car ride, or a walk through a real-looking street, square or village. The build orchestrates many sub-agents through build → critique → fix loops, with Docker tooling, headless GPU screenshots measured against the photos, procedural PBR content, a CC0 parametric-human crowd, serial performance QA and blind A/B acceptance. Use this skill whenever the user wants to recreate a real place or "make it look like this photo" in a browser 3D scene, asks for a photoreal walkthrough, ride-along, flythrough, cab ride or digital-twin street, or wants to continue, critique or speed up such a build, even if they don't mention agents, workflows or three.js by name.
---

# Photoreal scene from reference photos

This skill turns a brief plus a folder of reference photos into a photoreal, real-time 3D world that runs in a desktop browser. Around 200 sub-agents build it, critique it and fix it under one orchestrator (you). It distils a real project: a first-person tram cab ride through a limestone street (three.js r186, plain ES modules, no build step).

That project ran about 3 days of wall-clock and about 16 workflows with roughly 200 sub-agents. It finished at:
- 6.5/10 from a strict five-lens photoreal panel. Telephoto crowds and streets read as photographic; people within ~10 m never did.
- 0 console errors and about 15.5 ms GPU per frame at 1080p on an RTX 4060 Ti.
- 0 riding frames over 60 ms, and a cold start of about 16.7 s.

The worked-example repository is `/home/vlad/dev/reps/3DSceneRenderer` (paths under its `.work/` are git-ignored local scratch and may be missing on another machine). Its `docs/PLAN.md` has the full milestone history and `docs/ARCHITECTURE.md` the contract that let 13 agents build in parallel.

Use the arc and principles below as the backbone. Read the reference files when you reach the matching stage; each stands on its own.

| When you are… | Read |
|---|---|
| Planning stages, writing sub-agent prompts, running workflows, recovering from failures | `references/orchestration.md` (+ templates in `assets/workflows/`) |
| Reading the brief, asking decisions, reporting progress, committing, delivering | `references/working-with-the-user.md` |
| Writing the grey-box skeleton: coordinates, layout, streaming, module contract | `references/world-architecture.md` |
| Setting budgets, fixing cold start, hitches, GC, measuring frame time honestly | `references/performance.md` |
| Lighting, sky, exposure, tone curve, white balance, shadows, post | `references/lighting-and-post.md` |
| Stone, paving, rails, glass, ironwork, vegetation, wires, street life | `references/materials-and-geometry.md` |
| People and crowd (MakeHuman pipeline, instanced skinning, track clearing) | `references/people-and-crowd.md` |
| Camera rig, vehicle dynamics, oncoming vehicles, audio, UI, video recording | `references/camera-motion-audio.md` |
| Capture, measurement, recording and checkpoint scripts | `references/tooling.md` (+ `scripts/`) |
| Self-checking screenshots, writing critic prompts, deciding accept/revert | `references/photoreal-checklist.md` |

## The arc that worked

Each stage has an exit check. Don't start the next stage until it passes. Most lost time in the worked example came from finding later that an earlier stage had silently regressed.

**0. Brief, photos, environment (orchestrator, ~1 h)**
- Read the brief twice. Turn every testable requirement into a table with the number you will build to and the check that proves it. For a tram: gauge 1.435 m, eye height 2.75 m, look limits, dwell time, speed range, fps budget.
- Keep the brief's "never" items as a separate list: never render the own vehicle, no model or company names anywhere, no web search for the location. Copy that list word for word into every prompt.
- Open every reference photo and describe what it shows. Note mismatches, such as the brief naming one photo while the folder holds seven, and say so in your first report.
- Measure the photos with `scripts/imgstats.py` to build a **reference envelope**: p2/p50/p98 luma, clip %, colourfulness, saturation, and R/B of named regions. Exclude colour-graded photos and target the median of the ungraded ones. This envelope becomes the numeric bar for every critic and fixer.
- Set up tooling:
  - a Docker tools image with Blender LTS, Node, Python imaging, ffmpeg and gltf-transform (`scripts/Dockerfile.tools` and the `scripts/dk` wrapper);
  - the 3D library vendored into the repo, so there is no build step;
  - a headless GPU capture tool (`scripts/shoot.py`) and a static server with a big accept backlog (`scripts/serve.py`);
  - git with neutral commit wording from the first commit, a git-ignored `.work/` scratch folder, and `docs/PLAN.md` with milestones and sub-goals.
- Exit: a WebGL test page renders on the real GPU through `shoot.py` (the Chrome flag that worked was `--use-angle=gl`).

**1. Grey-box skeleton and contracts, written by you alone (~30-60 min)**
- Build these before any builder starts:
  - one coordinate system (for a path-based world: route coordinates `(s, d, h)` with an allocation-free `toWorld`);
  - a closed route with gentle bends and designed hills, because nothing should be ruler-straight or flat;
  - noise that is periodic in the loop length, a shared ground-surface function, and a deterministic master layout plan bucketed per chunk;
  - shared data plans (for example a facade plan), a module loader with error isolation, `only=`, `skip=` and `view=` switches, and chunk streaming;
  - a placeholder module per area, so the whole app renders end to end;
  - `docs/ARCHITECTURE.md` with coordinates, contracts, the material name list, a file-ownership table, tooling, URL parameters and budgets.
- Make every feature the brief names visible from the default start view: the user judges the default view first.
- Exit: the grey box renders from the default view with 0 console errors. Send the user a screenshot and commit. See `references/world-architecture.md`.

**2. Parallel subsystem build: one owner per area (~4-5 h)**
- Typical areas are materials, buildings (shell), facades (infill), ironwork, street and track, vegetation, lamps and overhead wires, furniture and stops, sky/light/post, human figures, crowd behaviour, ride and camera, and audio.
- Run each area as a pipeline: **build → fresh critic → fix**. The fix pass is part of the build, because first passes score only 4-5/10.
- Every agent returns a structured report with `requests` for files it doesn't own. You consolidate those requests yourself.
- Start the people subsystem on a parametric human generator from day one; see `references/people-and-crowd.md`. Hand-made procedural bodies cost ~11 h and plateaued at 3.5-5/10. MakeHuman via MPFB2, headless in Docker with CC0 assets, scored 5 on its first review and reached 6.
- Exit: all areas are real modules, 0 console errors, and screenshots at the standard views and times of day.

**3. Integration and performance (~4-6 h)**
- Resolve the consolidated cross-module requests, one agent per owner, and fold each new contract back into `ARCHITECTURE.md`.
- Agree the frame budget with the user. Quality first: 30 fps at 1080p was acceptable, so the budget became ~28 ms GPU, ≤20 ms CPU, no hitch over 60 ms, ≤1500 draw calls and ≤10 M triangles. Then spend the headroom on image quality.
- Fix cold start:
  - compile against the real HDR render target;
  - use `compileAsync`;
  - make sure every program has been touched and actually drawn once before you report ready.
- Fix riding hitches with staged chunk reveal under an upload byte budget, and cut per-frame garbage.
- Exit: one **serial** QA agent on a quiet machine measures the budget and passes the behaviour checks. See `references/performance.md`.

**4. Photoreal loops (many rounds, ~6 h each)**
- Run a panel of critics, each on one lens: light/tone, surfaces, shot/motion, people, street life. Each scores against the photos and the envelope and tags every issue with exactly one owner.
- One fixer per owner then fixes its merged issues ("if two critics disagree, follow the reference photos").
- Next, one serial verification on fixed standard views runs regression probes, regression fixes follow, and a fresh panel re-scores.
- Between rounds: run a request sweep, an audit of the plan against the code, and a milestone commit with the verified numbers.
- Use `assets/workflows/photoreal-loop.js` and `references/photoreal-checklist.md`.
- Exit: the panel's top issues need new techniques rather than tuning (see "what never moved" in the checklist), or the user calls a stop.

**5. Acceptance and delivery**
- Accept or revert each round with a **blind A/B** between two commits (`assets/workflows/blind-ab.js`): state the accept rule first, render identical frozen views, shuffle the left/right sides per view (never written to disk), and use three independent judges.
- Then deliver:
  - a README written for a stranger with a fresh clone: numbered steps from scratch, every command including the Docker image, troubleshooting, how each part was built, performance trade-offs, and asset licences;
  - final screenshots;
  - a metadata scrub;
  - a "Remaining work" section in PLAN.md.
- See `references/working-with-the-user.md`.

## Principles (and why)

- **Contracts before parallelism.** The skeleton, shared coordinates, ownership table and placeholders let 13 builders share one repo without worktrees or collisions. Without them, agents invent overlapping layouts and edit each other's files.
- **One owner per file; requests instead of messages.** Agents never edit files they don't own. Needs go into a `requests` field, and you route them: about 40 after the first build and 189 after the photoreal loop. This turns cross-agent coordination into a queue you can see.
- **Look and measure: every agent verifies its own work.** Each agent renders on the real GPU, LOOKS at the screenshots next to the reference photos, and quotes numbers. Critics who measured converged; critics who gave opinions swung back and forth for rounds (exposure −1.15/+1.2/−0.75 EV; foliage too dark, then lime, then crushed).
- **Two-sided numeric targets, two metrics per property.** One-sided fixes caused every ping-pong in the project. Write ranges, such as shaded stone R/B 1.25-1.45 or p2 luma 3-40, and track both level and contrast.
- **Time only in serial runs; otherwise count.** With 10+ agents rendering on one GPU, milliseconds are noise: the same configuration measured 14 ms and 73 ms. During parallel work, agents report structural metrics (calls, triangles, programs, bytes, KB/frame). A single QA agent times behind a wait-for-quiet gate with a frame cap.
- **Every round can break earlier wins.** Regressions seen in the worked example:
  - golden hour 2.5 EV too dark;
  - people floating above the ground;
  - a milky windscreen;
  - a broken oncoming-tram front;
  - a shadow filter costing 4 ms more.

  Keep fixed standard views, frozen A/B crops of hero objects and automated probes (people-height probe, bad-pixel counter, overlap counters, readiness gates) in every verification.
- **Replace, don't tune, when tuning stops moving the score.** Fix a fundamental the user notices (camera on the rails) or add a lens for a neglected area. Things that never moved across 6+ rounds of tuning: people within 10-15 m, chrome-looking rails, rock-faced stone, shop interiors, the oncoming cab and dusk lamp pools. Plan those as new build work (cloth simulation, strand hair, modelled relief, real interiors) by round 2.
- **Brief compliance is checked, not assumed.** A critic called the missing cab a flaw, and a fixer built a dashboard the brief forbids. Copy the hard constraints into every critic and fixer prompt, and give each one a QA check.
- **The camera sells "real footage".** Mount it rigidly on the vehicle body and never pan toward a gaze point. Specify motion in pixels at the default lens: ~1 px RMS running shake and 4-7 px joint knocks. Drive the picture and the sound from one rail-feature table. Verify camera changes with a rail-centring sweep.
- **Deterministic, procedural, licence-clean.** Use seeded RNG for all content, so A/B builds differ only in rendering. Bake textures on the GPU at start-up. Every asset is CC0 or self-made, with its licence recorded. No AI model or company name may appear anywhere: code, comments, file names, page title, glTF/EXIF/Blender metadata, commit messages and trailers. The work is judged blind.
- **Keep everything resumable.** Agents die from usage limits, network errors and stalls. Make prompts restart-safe ("read the current code first; an earlier attempt may be in the tree"), commit often, keep PLAN.md current, and run read-only audits after an interruption. A dying agent once built the improved cast into a git-ignored folder and never shipped it.

## Your job as orchestrator between workflows

Keep each workflow to one stage type (2-8 h). Between workflows:
- Read every report.
- Move requests into files.
- Measure the app yourself and fix cross-cutting bugs directly. Examples from the worked project:
  - skin weights that don't sum to 1 pulled far-LOD vertices toward the world origin as coloured streak bands;
  - shaders compiled twice against the wrong target doubled the cold start;
  - a server backlog dropped module imports.
- Update `ARCHITECTURE.md` and `PLAN.md`.
- Make a milestone commit whose message states what changed and the verified numbers.
- Then launch the next workflow with prompts that carry the new decisions.

Use journal watchers (Monitor or background scripts on `journal.jsonl`) so finished agents wake you. Use `holdOwners`/`holdAlways` when another workflow owns some files.

Reporting to the user (refined over the project):
- Report when a piece of work finishes, with fresh images of THAT change, before/after where possible. Don't send "still running" notes or routine checkpoint images.
- Send JPEGs, and keep every file under ~3 MB. For video, render a fixed-step offline recording with `scripts/record.py` and send its 720p copy.
- Ask each decision once, with options, a recommendation and a default you keep working on. The lens question went unanswered eight times and ended up as an "open decision".
- Pin down early what "push" means. Don't commit large regenerated binaries after every rebuild: the repo reached ~150 MB.

## Top pitfalls (each cost hours in the worked example)

1. A dead-straight, flat default view. The first user correction was "the track must curve, the ground must undulate".
2. Hiding mesh parts by moving them 500 m away, combined with skin weights that don't sum to 1. Both produced streak bands across the street. Use sub-draw ranges and renormalise weights.
3. Distance-based LOD with a telephoto lens. Choose LOD by projected size, because at 17° most figures sit at LOD 2.
4. "Compiled" is not "warm". Hidden warm-up meshes at y = −10000 were frustum-culled and never drew, so cups first drawn mid-ride caused a 175 ms stall every lap.
5. Per-frame allocation. Boxed floats, 3-argument `Math.hypot` and uniform setters cause GC hitches. Whole-app garbage went from 1365 to ~320 KB/frame.
6. Unitless emissives and lights. Fix physical light units on day one (here 1.0 = 33,000 lux) and publish anchor values.
7. Taking stone warmth from colour-graded reference photos. The result was "egg-yolk" walls.
8. Guessed crowd composition. Prop shares (strollers, bikes) came out 5-20× too high. Count them in the photos.
9. Timing measurements made while other agents render, and checkpoint screenshots taken mid-edit. Re-render from the current tree before reacting.
10. Asynchronous visuals without readiness gates (texture bakes, leaf atlases). Captures showed flat stand-ins or leafless trees.

## Bundled resources

- `scripts/shoot.py`: headless GPU capture over the DevTools protocol (stdlib only). It starts a private server, waits for `window.__ready`, then takes screenshots (with `--shots`), reads console errors and runs `--eval`. It always cleans up.
- `scripts/frametimes.js`: an in-page frame-time, hitch and heap sampler to pass to `shoot.py --eval`.
- `scripts/record.py`: fixed-timestep offline video, which needs a `rec=<fps>` hook in the app, plus a phone-size copy.
- `scripts/imgstats.py`: luminance percentiles, clip/black %, colourfulness, saturation and region ratios, compared against the reference photos.
- `scripts/serve.py`, `scripts/dk` and `scripts/Dockerfile.tools`: the static server, the Docker wrapper and the tools image.
- `scripts/checkpoint.sh`: a periodic capture plus an informative git commit grouped by area, with the stage taken from a note file.
- `assets/workflows/`: workflow templates.
  - `parallel-build-critique-fix.js`
  - `photoreal-loop.js`
  - `request-sweep-and-serial-qa.js`
  - `blind-ab.js`

  Fill in their `<<FILL: …>>` placeholders and keep the proven prompt language.

The app-side hooks these tools expect:
- `window.__ready` and `window.__app.stats()`;
- `capture=1` (no UI) and `freeze=1`;
- a `view=s,d,h,yaw,pitch` inspection camera, `tod=`, `fov=`, `only=` and `skip=`;
- deterministic seeds.

Build them into the skeleton in stage 1; `references/tooling.md` has the details.
