# Working with the user: requirements, corrections, reporting, delivery

How to turn a brief plus a folder of photos into a plan, absorb the user's corrections, keep a
remote user informed without spamming them, and hand over a repository a stranger can run.
Worked example: the tram cab-ride in `/home/vlad/dev/reps/3DSceneRenderer` (3 days, about 200
sub-agents, judged blind against real photos). Times below are from that project.

## Contents
1. [Read the brief and the photos](#1-read-the-brief-and-the-photos)
2. [Turn it into a plan and a contracts doc](#2-turn-it-into-a-plan-and-a-contracts-doc)
3. [Mid-course corrections and what they teach](#3-mid-course-corrections-and-what-they-teach)
4. [Decisions you need from the user](#4-decisions-you-need-from-the-user)
5. [Reporting cadence](#5-reporting-cadence)
6. [Commits, pushes and resuming](#6-commits-pushes-and-resuming)
7. [Stopping a round: accept or revert](#7-stopping-a-round-accept-or-revert)
8. [Delivery](#8-delivery)
9. [What never reached the target](#9-what-never-reached-the-target)
10. [Checklists](#10-checklists)

---

## 1. Read the brief and the photos

### 1.1 Pull out every hard requirement
Read the brief line by line and copy each testable requirement into a table before writing
code. For every row, write the number you will build to and the check that proves it. Vague
wording ("believable", "subtle") still gets a number. Otherwise every sub-agent picks its own
number and they drift apart.

| Brief says | Built to | Proven by |
|---|---|---|
| Standard-gauge twin tracks | 1.435 m gauge, tracks at ±1.6 m from the street centre line, camera on the right track | rail-centring sweep (ride-track centre within ~10 px of frame centre on straights) |
| Driver eye height 2.5-3 m | 2.75 m above the rails | config constant. A critic later found it ~0.9 m above the reference camera: record such picks as decisions |
| 0-50 km/h, smooth accel/brake | 10-notch controller, curve and switch speed supervisor | QA ride logs |
| Auto stop at platform, short dwell | stops on its mark, 13.9-14.8 s dwell, bell, departs | behaviour check per round |
| Mouse look ±60° yaw / ±25° pitch, returns to centre | soft limits ±57° / ±25°, back to centre in 1.2-1.5 s | QA input test |
| Time of day midday → golden hour → dusk, lights at dusk | `tod` 0..1 slider. Lamps, shop lights and headlight beam come on at dusk | standard views at tod 0.1, 0.55, 0.8, 0.97 |
| Spatial audio, synthesised or free | every sound synthesised with WebAudio, no sound files | `docs/ASSETS.md` lists no audio files |
| 1920×1080 at 60 fps (later: 30 fps OK) | budget ≤ ~28 ms GPU, ≤ 20 ms CPU, no riding frame > 60 ms | quiet-machine timing ride |
| Tram never rendered | no cab, dashboard or hood at any lens | QA "no cab geometry at any FOV" |
| Runnable project, README, licences | `python3 serve.py`; README; `docs/ASSETS.md` | fresh-export run check |

Keep the brief's "never" items as a separate list (tram body, placeholder primitives, toon
shading, names). Check them against what sub-agents actually build. In this project a ride
agent built a full cab interior (console, A-pillars, windscreen dust) that showed at wide
lenses. The orchestrator spotted it in a checkpoint and removed it. Sub-agents optimise for
their own area and will happily break a global rule they never saw.

### 1.2 The blind-comparison rule covers more than the UI
"No model or company name anywhere" means all of these:
- page title, on-screen text, credits, file and folder names, code comments
- metadata: image EXIF/XMP and comments, glTF `generator`/`copyright`, Blender file metadata
- commit messages and their trailers (no co-author or "generated with" lines), branch names
- docs wording. In the final scrub, phrases like "agents", "critics", "review panel" and
  "workflow" were rewritten to neutral engineering terms ("other processes", "the image-quality
  review").

Put the rule into every sub-agent preamble from the first workflow (rule 3 of the build
preamble). Use neutral wording in commit messages from the first commit. Rewriting history
later is risky with agents still working. Here the older commit messages that say "review",
"panel" and "owner" were left as they were.

### 1.3 Sourcing and licence rules
- The photos are the only description of the place. Do not web-search the location or look for
  existing models of it, and never use the photos as textures. Say this in every agent
  preamble, because an agent stuck on a hard asset will otherwise go looking.
- Procedural is preferred. Any third-party file needs a free licence (CC0, CC-BY with
  attribution, MIT, BSD, Apache-2.0) and a row in `docs/ASSETS.md` *when it is committed*, not
  at delivery.
- Tools that run only at build time (Blender, the add-on that builds people) are listed
  separately: their licence does not reach the app as long as none of their code ships.

### 1.4 Note mismatches, and say them out loud
- The brief named one photo (`street-tram.jpg`). The folder held seven photos with other names,
  and none had that name. The orchestrator read all seven and treated them all as ground truth.
  That was right, but it never told the user. Better: name the mismatch in the first report,
  say which photo matches the requested shot (here `Jaffa-Road2111.jpg` matched the telephoto
  start), and carry on unless they object.
- Photo file names can reveal the location and stock agencies. They do not license anything.
  Ask once whether the photos stay in the repo (section 4).
- The brief asked for "a gentle curve and switches" and a "telephoto composition with a clear
  vanishing point". The loop had curves, but the default start sat on a dead-straight 560 m
  avenue, so the first thing the user saw looked straight and flat (see 3.1). **Every feature
  the brief names must be visible from the default start**, because the default view is what
  gets judged.

### 1.5 Early instructions arrive queued
Within 13 minutes of the brief the user typed five more instructions while the orchestrator
was busy. They arrived as queued messages between tool calls:
- use Docker for Blender and the other tools
- keep all code and work inside the workspace directory
- send short milestone reports with screenshots
- use version control and push from time to time so work can be reverted
- write a clear breakdown of milestones and sub-goals

After every tool batch, look for queued user messages. Acknowledge each one in a line and turn
it into a mechanism: the `tools/dk` Docker wrapper, `.work/` (git-ignored) for scratch, git with
milestone commits, `docs/PLAN.md`. A preference acknowledged but never built into a mechanism
gets forgotten.

## 2. Turn it into a plan and a contracts doc

**`docs/PLAN.md`** holds milestones M0-M6 with sub-goals and a status legend
(`[x] done · [~] in progress · [ ] todo`). It is the user's progress view, every agent's
orientation, and the restart point after a session dies. Keep it current at every stage
change, not only at the end.

```
M0 Environment and tooling   (Docker tools image, vendored renderer, headless GPU capture tool, git)
M1 Core skeleton, contracts  (route, layout plan, chunk streaming, module isolation, grey-box end to end)
M2 Parallel subsystem build  (one owner per area: materials, buildings, facades, street, trees, ...)
M3 Integration, performance  (cross-module requests, budgets, clean console)
M4 Image-quality rounds      (critique against the photos -> fixes -> re-score)
M5 Behaviour verification    (people never pass through the camera, stops, controls, loop wrap)
M6 Delivery                  (README, licences, metadata scrub, final screenshots)
Remaining work               (added when pausing: open decisions, open findings, perf)
```

User requests get their own milestone (M2b "figures follow-up (user requests)", M4b "people
rebuild"). The user can then see that their request is tracked and when it is done.

**`docs/ARCHITECTURE.md`** is the contracts doc that every sub-agent reads first. Sections:
hard rules (the blind rule, photos-only, procedural or licensed, deterministic, work stays in
the repo), tooling, coordinates and conventions, the shared layout plan, the module API, file
ownership for the parallel build, and budgets. When the user changes a requirement (60 → 30 fps),
edit this file first. Agents started after that read the new budget, and you do not have to
re-brief them.

## 3. Mid-course corrections and what they teach

| When | User said (paraphrased) | Real cause | Fix | Lesson |
|---|---|---|---|---|
| Day 1, +2.5 h | The track should curve, and the ground is a slight hill, not a flat plane | default start on a 560 m straight; grades too gentle to read | core reshaped the route (gentle S-meanders everywhere; the avenue climbs ~9 m over 400 m, then crests; grades up to ~3%) plus one shared ground function (sidewalk cross-fall, slow hillside tilt, a few cm of settlement, flat at the rails) | fix shared foundations in core. Hold the ground switch until the paving owner follows it, or every building and tree floats |
| Day 1, +3.5 h | People's backs look weird; mind anatomy of men, women, children; add strollers and bicycles | procedural figures: coat-hanger shoulders, trousers clinging to the buttocks, glued-on hair, claw hands | dedicated follow-up workflow (anatomy, strollers, bicycles, crowd roles), started by a watcher once the figure fix pass finished | never put two agents on the same files: queue the request. Look from behind, since the cab mostly sees people walking away |
| Day 1, evening | (critic) too many cyclists and strollers | over-delivery on the request | share tuned; the next review judged 4.4% strollers and 2.2% cycles (of walkers) in line with the photos | add a requested element at the photos' frequency, not as a showcase |
| Day 1, +8 h | 30 fps is fine | 60 fps budget was holding quality back | budget ≤ ~28 ms GPU; headroom spent on 4096-texel shadow cascades, AO, crowd density; docs and a memory note updated | a relaxed constraint is a quality budget: say where it goes |
| Day 3 | The camera should move as if on rails; it looks like it sits between the two tracks | at the 17° lens the view turned 70% toward a point 80 m ahead; in tight bends the ride track slid up to ~450 px off centre and the other track sat mid-frame | camera fixed to the cab body (no pan toward a gaze point); rail-centring sweep added to every verification | measure the complaint (pixel offset of the ride track), then make it a permanent check |
| Day 3 | People are floating in the air; this used to work | the 20-minute auto-checkpoint captured half-finished edits while three owners edited crowd, frame-loop and streaming code | none needed in the code; measured 650-750 people at three spots, none more than 10 cm off; a people-height probe added to every QA pass | screenshots taken while agents are editing can be wrong. Check the current code, explain, and add a probe anyway |
| Day 3 | The oncoming tram's front broke | first the checkpoint caught an owner mid-edit; the finished change then really did make the windscreen milky | full-resolution before/after crops at 15 m and 40 m, then a one-agent focused fix: glass glossy and sharp, paint satin | when a user says "previously it worked", crop the same object old vs new at full size. Their eye is usually right |
| Day 4 | Stop improving; let the round finish, keep it if better, else revert; write down what is left | n/a | re-score plus blind A/B, decision rule stated in advance (section 7) | do not stop abruptly: close the round cleanly |
| Day 4 | README with the run command, how each part was built, licences; final screenshots; then all commands including Docker; then "someone clones the repo"; then a step-by-step from scratch | the README was written for an insider | section 8 | write the README for a stranger with a fresh clone from day one |

How to handle any correction:
1. Acknowledge in one line and restate what you will change. Save lasting preferences as
   memory notes: 30 fps OK, camera on rails, keep the reference photos, how to report.
2. Reproduce and measure before fixing: people heights, the ride track's pixel offset, black
   levels against the photos.
3. Check whether a sub-agent is editing those files right now. If so, queue a focused
   follow-up or fix it yourself after that agent finishes. You cannot message agents inside a
   running workflow.
4. Fix at the right layer, then show before/after images of exactly what was flagged.
5. Add a permanent check to the verification stage so the problem cannot come back unnoticed.
   By the end it checked people on the ground (with contact shadows), the oncoming tram
   touching the rails, leaves present on the first frame, console errors, broken pixels,
   behaviour (stop, dwell, bell, track clearing), rail centring and timing.

When a correction shows the approach has hit a ceiling, change the approach. Procedural
figures stalled at 3.5/10 from the people critic. Rebuilding the cast from CC0 MakeHuman
characters (built headless in Docker) moved it to 5, then 6. Each user correction about people
was a sign of that ceiling.

## 4. Decisions you need from the user

- Ask once. Give the options, your recommendation and the default you will use meanwhile, then
  keep working on that default.
- Don't nag. The default-lens question (17° vs 24° vs 30°) was repeated in about eight updates
  over 12 hours and never answered. It ended up under "Open decisions" in `PLAN.md`. A user
  following from a phone answers what blocks them, not what you list.
- Back a decision with evidence: one tight bend at 17°/24°/30° side by side, plus two 12 s clips.
- Record each answer in a memory note and in the docs it affects. "Keep the reference photos"
  went into the memory note and `docs/ASSETS.md`, so the delivery scrub would not delete them.
- Ask before anything that leaves the machine (pushing to a remote) or deletes the user's
  material.

## 5. Reporting cadence

### 5.1 How it changed
| Phase | What happened | User reaction |
|---|---|---|
| Milestones | M1 grey-box report with two PNG screenshots, 25 min after the brief | fine |
| ~25 min checkpoints during the parallel build | one screenshot plus a commit each | "If you have more than one example it would be nice" → 3-5 views per report (midday, golden hour, dusk, close-ups, a tram stop) |
| Busy coding | 35-40 min with no images; then images reused from earlier | "Did you generate images as example in the last 25m?", then "Pls remember about updating me with the progress and images and commiting" |
| Automated | `tools/checkpoint.sh` every 20 min: 3 fresh views (default plus two rotating through route positions and times of day), JPEG, commit | coverage solved, but every captioned report arrived whether or not anything had changed, plus a stream of "watcher re-armed", "still running" and "no changes" messages |
| Event-driven | "don't blindly update on the work, only when something of the fixes was finished; if nothing changed, no need to show more images" | final rule, below |

### 5.2 The rule that stuck
- **Report when a piece of work finishes** (an owner's fix lands, a stage completes, a check
  passes or fails), with images of **that change**, before/after where possible. Watch the
  workflow journal for finish events (a small poller that prints `FINISHED <label>`) instead of
  a clock.
- Keep the periodic loop for commits and for console-error alerts only. Its images are for you.
- Keep plumbing out of the chat: re-armed watchers, stale timers, retries and a `pkill` that
  matched its own shell. Say nothing when nothing changed.
- Answer "Status?" directly: **Done** (with numbers), **Running**, **Next**, and anything you
  need from them.
- When the honest answer is "no" ("No, the last images were 35-40 minutes ago"), say so, then
  fix the mechanism rather than just promising.

### 5.3 What one good report contains
- One sentence on what finished, then 2-4 bullets with measured numbers: "people garbage
  426 → 13 KB/frame", "golden-hour p2 luma 53 → 24".
- 1-3 images: before/after sheets with the reference photo alongside, or the 8 standard views
  after a verification. Number them and say in the caption what to look at.
- Name flaws and regressions in the same report ("the windscreen came out milky; a fix is
  running"). The user will spot them anyway, and a hidden flaw costs trust.
- What comes next, in one line.

### 5.4 The user is on a phone
| Payload | Result |
|---|---|
| 3 MB PNG screenshot | upload timed out |
| JPEG, 1600 px wide, quality ~84 | arrives; use for all progress images |
| MP4 1080p 9 MB | timed out after ~30 s |
| MP4 540p 2 MB, 720p 3.2 MB | arrive |
| Final screenshots, 1920×1080 JPEG q88 | 0.3-0.6 MB each, arrive |

- Send JPEGs, and send videos one per message so one failed upload does not take the others
  with it. Resend once on a network error.
- Videos: add a fixed-step record mode (`rec=<fps>`: each frame advances the clock by exactly
  1/fps). Capture frames headless, encode with ffmpeg in the tools image, and write a
  `<name>_phone.mp4` sized to ~3 MB:
  `kbps = phone_mb*8*1024*0.92/seconds`, `-vf scale=1280:-2 -crf 28 -maxrate {kbps}k -bufsize {kbps}k`.
  A live recording stutters because every screenshot stalls the frame. Warn that videos are
  silent (live WebAudio is not captured) and say where the full-quality copies are.

## 6. Commits, pushes and resuming

- **Informative commit messages.** About 50 commits titled just "Auto checkpoint HHMM" told the
  user nothing, and they asked: "commit from time to time and give informative commit
  comments". The checkpoint script now writes:
  ```
  Checkpoint 00:37: crowd behaviour, facades, ironwork, materials, people figures, street

  Stage: <one line from .work/checkpoint_note.txt>

  - facades (+73/-24): facades.js, dressing.js, geo.js, interior.js, ...
  - ironwork (+50/-5): ironwork.js, consoles.js
  15 files changed, 151 insertions(+), 45 deletions(-). Views captured ...; console errors: 0.
  ```
  It maps paths to areas and skips runs with no changes. Update the note file at every stage
  change. At the end of each round, also write a milestone commit by hand that says what
  landed, with the verified numbers. Those are the commits the user reads.
- **No attribution trailers** and no tool names in messages (section 1.2).
- **Pin down what "push" means.** The user asked to "push from time to time". The orchestrator
  only committed locally, and by delivery the private remote was 46 commits behind. That
  meant about 150 MB to push, mostly because the 20-29 MB people cast was committed again after
  every rebuild. Confirm the remote early, push at milestones, and keep regenerated binaries
  out of history until they settle (or commit them only at milestones).
- **Sessions die.** A usage limit stopped the work in the middle of a round. The next session
  started with "Do you know what work is left?". It recovered by reading `PLAN.md` and running
  a read-only audit workflow (4 auditors checking open items against the code), and found
  uncommitted half-edits left by agents that died. On resume, run `git status` first, then
  audit, then plan. A current `PLAN.md` made this take minutes.
- **Clean up.** Capture tools must kill their headless browsers even when they are killed
  themselves. Leftover browsers held the GPU at 97% for an hour and spoiled the timing
  numbers.
- **Other sessions on the same repo.** The session that hit the usage limit was still open in
  another window when the work resumed. At start, check for it (`ps` for a second session on
  the same directory) and ask the user to close it, or two orchestrators will edit one tree.
  Later that old session committed a skill folder (`.claude/skills/...`, 23 files of
  orchestration notes) into the project repo, and the next push sent it to GitHub unnoticed.
  Before every push, read `git log origin/main..main` and `git diff --stat origin/main` for
  commits you did not make. Keep orchestration material (skills, agent notes, workflow
  scripts) out of a repo that is judged blind, or ask the user first: a `.claude/` folder or
  "agent" wording tells a judge how the work was made. (Asked afterwards, this user chose to keep
  the skill in the repo.)

## 7. Stopping a round: accept or revert

User: "we can stop improving... let the current round finish, check if it is better, if so
accept if not revert and stop and commit."

1. **Let the running fixes finish.** Stopping agents mid-edit leaves half-applied changes. Set
   a time limit: if they keep getting interrupted, keep whatever finished cleanly and skip
   the re-score.
2. **Don't decide on critic scores alone.** Each panel is a fresh set of judges, and they had
   been getting stricter, so scores drift (in one round the people score went 6 → 5.5 after a
   large clothing and face fix had landed, because that panel judged close figures harder).
3. **Run a blind A/B.** Render the same 12 views from both builds (a `git archive` export of
   each, every one using its own capture tool, one capture at a time on a quiet machine).
   Make one side-by-side sheet per view, labelled only L/R. Vary which build is on the left
   from view to view, keep that mapping only in the script, and delete the raw renders. Three
   judges with different emphases (overall; light, colour and materials first; people, motion
   and street life first) pick the more photographic half against the reference photos. They
   are told not to look for which build is which.
4. **State the decision rule before you look**: accept if the new build wins the blind votes
   and its re-score does not drop; otherwise revert *with a new commit* that restores the old
   build, without rewriting history. Result here: 20 votes to 13 (3 ties), 7 views to 4
   (1 even), re-score 6.3 → 6.5, so the new build was accepted. The views the old build won
   (dusk mood, golden-hour warmth, near trees going black) went to the top of Remaining work.
5. **Write "Remaining work" in `PLAN.md`**: status when paused (score, frame time, cold
   start), open decisions, where the previous build still looked better, open findings by
   area (most costly first), performance and robustness.
6. **Stop everything**: workflows, checkpoint loop, watchers, capture browsers. Check that
   nothing is still running, make a final commit, and report what was kept and why.

## 8. Delivery

### 8.1 The README bar rose four times in one hour
1. "a README with the run command, how each part was built, and asset licences" plus "final
   screenshots"
2. "readme should cover all command set including running the docker image"
3. "Think of it as someone clones that git repo and needs to run this... everything that is
   needed so that it runs should be in the repo"
4. "a section that has a clear step by step example on how to run it from scratch"

Start at level 4. Write a living README early and test it from a fresh clone at every
milestone. Sections, in order:

| Section | Contents (this project) |
|---|---|
| Title, 2-3 sentences | what it is, the tech, "no build step" |
| Screenshots | grid of the final JPEGs with captions |
| From a fresh clone, step by step | numbered steps, each with the exact command and what you should see: check prerequisites → `git clone --depth 1 ...` (full history ~200 MB) → `python3 serve.py` prints `Serving on http://localhost:8080/` → open in a WebGL 2 browser, ~16-17 s to "Click to ride" → click, try the controls and two URL examples → optional: Docker image, screenshots, videos, rebuilding assets |
| Prerequisites | versions: Python 3, a WebGL 2 browser and a discrete GPU (tested hardware named); for the tools: Docker, the NVIDIA Container Toolkit for GPU work, Chrome/Chromium on `PATH` |
| Running it | run command, alternative static servers, why HTTP (ES modules), first-load time and why |
| URL parameters, controls | a table from the code, not from memory |
| How it was built | one paragraph per part, naming its source folder |
| Commands | every command: serve (host and via `docker run -p 8080:8080 ... python3 serve.py 8080 0.0.0.0`), `docker build -t <tools-image> docker/`, the `tools/dk` wrapper (builds the image on first use; `DK_GPU=1`; image override variable; interactive shell line), asset rebuild (`tools/mh_fetch.sh` downloads ~330 MB, then the cast build), capture and record tools with an options table, the checkpoint loop, material preview |
| Performance and trade-offs | target, measured numbers, and each trade-off with its reason (lens, LOD distances, shadow cascades, crowd size, quality presets) |
| Assets and licences | summary of `docs/ASSETS.md` |
| Troubleshooting | no WebGL 2, port in use, slow first load, Docker permissions, GPU in Docker, browser not found |
| Repository layout | short tree, plus what `.work/` is |

Gotchas a fresh clone hits: git-ignored folders the tools expect (`mkdir -p .work`), lost
executable bits on scripts, downloads that live outside git (and whether their URLs still
resolve), clone size, GitHub's 100 MB per-file limit. A small `tools/doctor.sh` that reports
what is missing beats a paragraph of prose.

### 8.2 Verify the README by running it
Plan three passes:
- **Release reviewer.** `git archive` HEAD into a scratch folder and start `serve.py` exactly
  as written. `curl` the URL, run one headless capture (ready reached in 16.4 s, 0 console
  errors). Check every key and URL parameter against the input and params code, every image
  link, the licences against what is really in `vendor/` and `assets/`, and the numbers
  against `PLAN.md`. Then run the scrub (8.4).
- **Command runner.** Runs every command in the Commands section, safely: time limits, a
  2-second test clip, a one-character test build into scratch folders, no multi-GB downloads,
  no loop that commits. It fixes the README wherever a command, option or default is wrong.
- **Fresh-clone tester.** Clones into an empty folder and follows only the step-by-step
  section, word for word. It writes down every place it had to guess. Fix those, run it
  again, then push.

How the fresh-clone check was done in the end, in about ten minutes:
- **Before committing**, copy exactly what will be committed (tracked files plus new
  untracked, non-ignored ones; git-ignored files left out, as a clone would) into an empty
  folder and work only there:
  ```sh
  git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - | tar -x -C <empty-dir>
  ```
  Then run the doctor script, start the server exactly as written, `curl` the page, the main
  module, the renderer and one asset file (all 200), and run one headless capture with
  `--console` (ready in 16.5 s, 0 errors, 0 warnings, no 404s).
- **After pushing**, do a real `git clone --depth 1` from the remote into an empty folder and
  repeat the doctor check and one capture (15 s and 108 MB to clone; ready in 16.8 s).
- Kill test servers by PID, not with `pkill -f "serve.py 8085"`: the pattern matched the
  shell running it and killed the command itself (exit 144).

**Don't hand documentation to a slow agent.** The writer agent for the step-by-step section
spent an hour and 72 tool calls re-running every command it planned to document before writing
a line. The user asked: "why writing takes so long? ... Is it a long novel with 300 pages?" The
orchestrator stopped it, kept its finished parts (the doctor script, a script fix), and wrote
the ~150 lines itself in a few minutes, then ran the one fresh-clone check above. The user also
said "we dont need workflow for this simple task". Write docs, licences and small edits
inline; spend agents on work that needs many hours or independent eyes. When the user asks
"when should we finish?", give a time per remaining step and offer a shorter path with its risk
(here: skip the from-scratch Docker rebuild and the second re-test; the app itself needs no
Docker).

### 8.3 Final screenshots
- About 10 views covering the brief: default start, midday, golden hour, sunset, dusk, an
  oncoming vehicle, people close, a busy street at a wider lens, a facade close-up, a long lens.
- 1920×1080. Check each log for ready and 0 console errors, and *look* at each one (people on
  the ground, no loading veil, nothing broken). Save as JPEG q88, under ~900 KB, metadata
  stripped (`convert in.png -strip -quality 88 out.jpg` in the tools image), in
  `docs/screenshots/` with the captions used in the README.
- Send them to the user in two messages of five, and name the small flaws you can see ("one
  walker's foot slightly above her shadow").

### 8.4 Metadata and wording scrub
- Grep every tracked file outside `vendor/`, case-insensitively, for the names of every AI
  model, AI company and coding tool in your own toolchain (make the list at project start), plus
  `co-authored`, `generated with` and generic words for such models. Also grep for wording that says
  agents, assistants, workflows, critics or panels did the work.
- Inspect image EXIF/XMP/comments (`identify -verbose`), glTF `generator`/`copyright`, and
  any Blender-written metadata. Strip what you find.
- Check commit messages (`git log --format=%B`). Fix new ones; leave old history unless the
  user asks.
- The page `<title>` and the visible UI name are invented and neutral ("Tramline — Cab Ride").

### 8.5 Licences (`LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/ASSETS.md`)
At delivery the user asked: "add a license file, our work should be MIT but do reference other
works we used that have their own license". What shipped:
- `LICENSE`: the plain MIT text with the copyright holder (the git author) and year, and
  nothing else, so GitHub recognises it as MIT.
- `THIRD_PARTY_NOTICES.md`: what the project's own MIT work covers (code, docs, screenshots,
  files its scripts generate), then the third-party works. Included in the repo: the vendored
  renderer (MIT; copy the copyright years from its own LICENSE file), libraries bundled in its
  add-on tree that the app does not load (their own licences, e.g. Apache-2.0 and MIT), and the
  CC0 source assets of the people cast. Used to build, not included: the build add-on
  (GPL-3.0; models it produces are not covered), Blender, Node, Python libraries, ImageMagick,
  ffmpeg, the browser. Not covered: the reference photographs.
- A README "License" section pointing to both files.
- "Our work is MIT" changed the cast's label: it had been released as CC0 like its source
  assets; it became the project's work under MIT, built from CC0 assets (CC0 allows that). The
  licence note in the cast's JSON and in the exporter that writes it changed with it.
- Search the sources for copied code first (`copyright`, `licence`, `SPDX`, `ported from`,
  well-known shader authors); none was found here, so nothing else needed crediting.

The asset record in `docs/ASSETS.md`, which points to both files above:
Shipped, with path, source and licence: the vendored renderer (MIT, unmodified, its LICENSE
file kept), the add-ons actually loaded, and the people cast (the project's work under MIT,
built from the MakeHuman CC0 system assets; the GPL-3.0 build add-on is a tool only and none
of its code ships; the licence note is also stored in the cast's own JSON). Not shipped: fonts (system stack),
HDRs, sounds (all synthesised). Build-time tools each under their own licence. Reference
photos: third-party, kept only for comparison, never loaded, not covered by the project's
licence (the user decided to keep them in the private repo). End the file with a short "Adding
an asset" rule.

## 9. What never reached the target

- **Photorealism**: the image-quality review levelled off around 6.3-6.5/10 against a target
  of 8.5. People close up stayed the weakest area (shell-like clothes, helmet hair).
- **Cold start**: ~16.7 s against a 10 s target, set by ~140 shader programs that the browser
  compiles one at a time.
- **Lens and eye height**: never decided by the user; both left as open decisions.
- **Delivery tail**: when the user stopped the work, the README was a short summary. The full
  command reference, the step-by-step section, the doctor script, the fresh-clone check, the
  licence files and the agreed push (local main 46 commits ahead of the remote) all came in
  the last hours, one user request at a time, because the README started at the end. They
  were cheap once done inline. Start the README, `LICENSE` and the fresh-clone check in
  stage 1; the `PLAN.md` "Remaining work" section is what makes the project resumable.

## 10. Checklists

**Start**
- [ ] Hard-requirements table with numbers and checks; a "never" list; the blind rule in every preamble
- [ ] Mismatches between brief and folder named in the first report
- [ ] `PLAN.md` (M0-M6 plus status legend) and `ARCHITECTURE.md` (rules, ownership, budgets) committed
- [ ] Docker tools wrapper; all work in the repo; scratch in a git-ignored folder
- [ ] Remote confirmed and push cadence agreed; neutral commit wording from commit one
- [ ] Living README with a fresh-clone section, tested once; `LICENSE` and third-party notices
- [ ] No other session open on the same repo

**During**
- [ ] Queued user messages acknowledged and turned into mechanisms or memory notes
- [ ] Corrections: measure, avoid file collisions, fix at the right layer, before/after, permanent check
- [ ] Report on finish events only, with JPEG images of that change; phone limit ~3 MB
- [ ] Informative checkpoint and milestone commits; `PLAN.md` status current
- [ ] Each decision asked once, with a recommendation and a default

**End**
- [ ] Round finished; re-score plus blind A/B with the rule stated first; revert as a new commit if needed
- [ ] Remaining work written; loops, watchers and browsers stopped; final commit
- [ ] README verified by export run, command runner and fresh-clone tester; screenshots stripped; scrub clean; licences match the files
- [ ] `git log origin/main..main` holds only commits you made; no orchestration files in a blind-judged repo
- [ ] Pushed (if agreed), then a real `git clone --depth 1` from the remote starts the app; the user gets the screenshots, the README and a short summary
