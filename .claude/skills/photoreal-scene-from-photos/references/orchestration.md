# Multi-agent orchestration

How one orchestrator plus ~200 sub-agents, run as a chain of workflows, built a photoreal browser cab-ride from 7 reference photos in about 3 days. Use it for any "photoreal first-person world from photos" build: a canal boat, a mountain railway, a city walk, a village drive.

Worked example: `/home/vlad/dev/reps/3DSceneRenderer` (`docs/PLAN.md` has the milestone log; `docs/ARCHITECTURE.md` the contracts). Templates: `../assets/workflows/*.js`.

## Contents
1. [Roles: what the orchestrator keeps, what it delegates](#1-roles)
2. [The milestone arc that worked](#2-the-milestone-arc-that-worked)
3. [Prompt design](#3-prompt-design)
4. [Patterns](#4-patterns)
5. [Failure modes and fixes](#5-failure-modes-and-fixes)
6. [Sizing and budgeting](#6-sizing-and-budgeting)
7. [Staying in the loop between and during workflows](#7-staying-in-the-loop)
8. [Templates](#8-templates)

---

## 1. Roles

**Keep inline (orchestrator):**
- Tooling, the grey-box skeleton and the written contracts (M0/M1). Builders who start without them invent conflicting coordinates, APIs and placements.
- The "core" files (main loop, streaming, route/layout) until the first integration pass. Everything depends on them, so one careful owner beats a committee.
- Cross-module decisions ("post owns the single lamp halo", "goods stands belong to facades"). Write them into the next prompts as *settled*.
- Measuring the bar yourself: tone statistics of the reference photos, frame timing on a quiet machine, a probe for floating people. Numbers turn vague critique into targets.
- Root-cause fixes on files whose owner is idle (example: streak artefacts in far figure LODs were bisected with `skip=` flags and fixed by the orchestrator once the figures workflow finished; skin weights did not sum to 1).
- Smoke-testing a new pipeline before handing it to agents (one parametric-human character exported and previewed before the 8-hour people rebuild).
- Reading every report, updating `docs/PLAN.md` and the contract doc, milestone commits, and user communication.

**Delegate (sub-agents):** anything that needs more than ~30 minutes of focused work in one area, every critique (fresh eyes, never the author), every serial QA run, audits, README/screenshot delivery.

You cannot message an agent inside a running workflow. If you spot a problem in an area under edit, log it (the example used `.work/notes_m4.md`, tagged `[RESOLVED hh:mm]` when closed) and queue a follow-up for when that owner finishes.

---

## 2. The milestone arc that worked

Times are wall-clock; stages overlapped where they touched different files.

| Stage | What it produced | Agents | Wall-clock | Score / numbers |
|---|---|---|---|---|
| M0+M1 (inline) | Docker tools image, vendored three.js, headless GPU capture tool, route + layout master plan, facade-plan format, chunk streaming, module loader with per-module error isolation, a placeholder for every module, `ARCHITECTURE.md` (contracts, ownership table, budgets), `PLAN.md` | 0 | ~25 min | grey box end to end |
| M2 parallel build | 13 subsystems, each built → critiqued → fixed (pipeline) | 39 | 4.6 h | per-area critics 4–5/10 |
| M2b user follow-up | anatomy rework, strollers, bicycles, crowd roles (3 parallel → integrate → critique → 2 fixes) | 7 | 6.5 h (beside M3) | 5.2 |
| M3 integration + perf | ~40 cross-module requests turned into 8 per-area task lists; full-app photo critic + perf/QA reviewer; owner fixes | 18 | 5.8 h | photo 5.5; GPU 16 → 9.6 ms, draw calls 1166 → 629; cold start 32 → 15 s (orchestrator) |
| M4 photoreal loop | 4-lens panel × 3 rounds, 8–10 owner fixes per round | 40 | 7.5 h | mean 4.9 → 5.9 → 6.25 |
| M4b people rebuild | CC0 parametric-human cast generator → renderer integration → 2 critique/fix rounds | 6 | 8 h (beside M4) | people 3.5 → 5 → 5 |
| M4.5 request sweep | 189 leftover requests handled by 10 owners; per-frame garbage 1365 → 920 KB | 10 (+QA died) | 2 h | — |
| (pause) | weekly usage limit hit | — | ~29 h | — |
| Status audit | 4 read-only auditors verifying the plan against code at HEAD and old journals | 4 | 0.4 h | prioritized task lists |
| M4.6 build round | 10 owners + a 2-stage people track, one serial QA, fixes | 19 | 7.1 h | every behaviour check passes; GPU 11–14 ms |
| M4.7 photoreal round | 5-lens panel → 11 owner fixes → serial verify → regression fixes → re-score | 26 (+2 single-agent fixes) | ~6.3 h | 6.1 → 6.3 |
| M4.8 photoreal round | same shape, from the M4.7 re-score issues | 20 | 6.3 h | 6.3 → 6.5 |
| Blind A/B | old vs new commit on 12 identical views, 3 independent judges | 4 | 0.4 h | new 20 / old 13 / tie 3 → accept |
| Delivery | final screenshots, README, accuracy + scrub review, every README command run | 4 | 0.6 h | — |

Totals: ~197 completed sub-agent reports, ~285 agent launches including retries, ~117 commits (85 of them checkpoints).

**Why this order works**
- **Contracts before builders.** M1 gave 13 parallel builders one coordinate system (`route.toWorld(s, d, h)`), one shared deterministic layout (`layout.inChunk(kind, i)`), one material library by name, and a file-ownership table. The M2 build ran 39 agents with no ownership collisions.
- **Placeholders keep the whole app rendering.** Every agent screenshots the full app; a missing module would block everyone.
- **Critique immediately after each build**, per area, by a fresh agent that reads the builder's report. First-pass subsystems scored only 4–5/10; the fix right after is cheap because it starts from a ranked, concrete list.
- **Integration as its own milestone.** Parallel builders leave requests for each other; a dedicated pass resolves them against a measured budget.
- **Photoreal loops only after integration**, so critics judge the real composite, not isolated parts.
- **Audit after any interruption** before building again (section 4.6).
- **Blind A/B before accepting a round**, because panel scores are not comparable across fresh panels.

---

## 3. Prompt design

Every agent prompt = shared PREAMBLE + `YOUR AREA` / `YOU OWN` + a task block + a schema'd report. The essentials, quoted from the M2 build:

```
You are one of 13 senior graphics engineers building, in parallel, a PHOTOREAL first-person
<ride> through <place>, running in the browser (three.js r186 vendored, plain ES modules, no
build step). Repository: <ROOT> (cd there; ALL work stays inside it; scratch files go to .work/).
READ FIRST: docs/ARCHITECTURE.md (contracts, coordinates, module API, file ownership, tooling,
budgets. Follow it exactly), docs/PLAN.md, and the reference photos in reference/*.jpg. Open them
with the Read tool and study them. They define the target. The scene: <2-4 sentence description
of what the photos show, and where OUR camera is relative to them>.

THE BAR, judged strictly: the result sits on screen next to real photographs ... in a blind
comparison. Any frame that looks like a 3D demo fails. Use real-world scale and dimensions and
physically based materials with real values (albedo in a realistic range: limestone ~0.45-0.65,
paving ~0.2-0.35, iron ~0.04). Nothing toon, flat, low-poly or plastic. No visible primitive
placeholders. Add the small irregularities that make things real: bevels, wear, dirt and
weathering, variation, imperfection. Avoid repetition patterns visible at street scale.

RULES:
1. Only create or edit the files you OWN. About 12 other agents are editing the other files at
   the same time. If you need a change in a file you don't own, describe it in "requests".
2. Never run state-changing git commands (commit, add, reset, checkout, stash, clean, restore).
3. Blind comparison: never write any AI model name, AI company name or "generated by AI" style
   text anywhere (code, comments, file names, UI, metadata, glTF generator fields, Blender metadata).
4. The reference photos are the only description of the place. Do not search the web for this
   place or existing 3D assets of it. Never use the reference photos as textures. Build
   procedurally, or with freely licensed generic assets whose licence you record.
5. Content must be deterministic: use the project RNG, never Math.random() for world content.
6. Respect the performance budget ... (per-chunk build ms, instancing, LOD).
7. Tools: `python3 tools/shoot.py --params "..." --out .work/shots/<area>/x.png` ... LOOK at your
   screenshots with the Read tool, compare them with the reference photos, and iterate until your
   part genuinely holds up next to a photograph. Check console errors every time.
8. Other modules may still be placeholders. Judge your own part. Use library material names.
9. Keep your module loading and working at all times. Never leave a syntax error behind,
   because other agents are taking screenshots of the whole app. Zero console errors.
When finished, reply with ONLY the structured report.
```

**Why each line is there**
- *Describe the photos in words* even though agents can open them: it fixes the vocabulary critics and fixers share ("ashlar", "scroll arms", "catenary"), and states where the camera sits relative to the photos (our camera faced the opposite way to most of them).
- *Real albedo ranges and real dimensions* give agents numbers to check, instead of "make it look real".
- *Ownership + requests* is what lets 13 agents edit one repo with no worktrees. It held for 3 days.
- *No git writes* because the orchestrator (and an auto-checkpoint loop) commit. Agents committing in parallel would interleave.
- *"LOOK at your screenshots"* is the single most important verification rule. Agents that only read their code report success on broken frames.
- *Zero errors at all times* because every other agent's screenshot includes your module.

**Per-area task block.** Concrete and numeric: what to build, technique hints, materials by library name, a perf target, and the exact verification views (`view=s,d,h,yaw,pitch`, `tod=`, `fov=`). Example (street): "flangeway groove 42 mm wide ... rail tops flush with the paving at h = 0 ... Verify at the default view, at `view=<s>,1.6,1.2,0,-25` (rails close up), at a crossover, at a cross street, and at golden hour."

**Report schema** (keep `requests` and `knownIssues` from day one; add `declined` and `contracts` later):

```js
{ area, filesChanged[], summary /* technique, 5-15 sentences */, verification /* screenshot paths */,
  perf /* build ms, calls, tris, gpu ms */, knownIssues[], requests[] /* changes in others' files */,
  licenses[] }
// later rounds: { owner, done[] /* with before/after evidence */, declined[] /* with reason */,
//                 filesChanged[], contracts[] /* new public APIs/params for the contract doc */,
//                 perf, requests[] }
```

**Critic prompt essentials** ("ruthless photorealism critic, senior VFX supervisor"): read the contract doc and every reference photo; take at least 12–16 varied screenshots (the standard views + lens-specific close-ups + a ride sequence); LOOK at each next to the references and crop details; "Be adversarial and specific. Do not praise"; score 1–10; at most 14–18 issues ranked by how much each costs in a blind comparison; each issue gets exactly one `owner` from an enum, `evidence` (screenshot path, params, measurement, which reference shows the right look) and a concrete `fix`; "Do NOT edit any files."

**Fix prompt essentials:** issues sorted critical → major → minor; "Read your current code first"; "Some may overlap; merge them. If two critics disagree, follow the reference photos"; "Re-verify each fix with before/after screenshots next to the references"; from round 2: "Issues you already fixed last round and that the critics still raise need a deeper fix, not a tweak."

**Rules added after failures** (all now in the templates):

| Rule | Added after |
|---|---|
| "Run every capture with a time limit (`timeout 600 ...`) and make sure no headless browser you started is still running" | an orphaned browser rendering uncapped held the GPU at 97% for 78 minutes |
| "The machine is shared ... take timings as a minimum over several runs, prefer structural metrics (allocations per frame, draw calls, triangles, upload bytes, program counts); a serial QA pass times things afterwards" | perf numbers taken under contention were noise |
| "An auto-checkpoint commits the tree every 20 minutes, so never leave a file broken or half-edited for long" | checkpoints captured floating people and a broken tram front mid-edit |
| "(a) cross-module decisions in your task list are already settled; (b) before declining anything for a missing API, re-read the other module's code at the END of your work; (c) put what you need into requests with the exact API" | owners declined work because "the other side has not published X" while it was being published; two owners both added a lamp halo |
| REGRESSION GUARD: run the people-height probe (expect `bad: 0`) if you touch positions, heights, the route, start-up order or figures | people drawn tens of metres above the street |
| "Never describe the work in code comments or docs as done by agents, critics, panels or workflows: write as an engineering team would" | agent wording leaked into docs and tool output |
| Give the measured reference targets in the CONTEXT block (p2 luma 3–40, clipped 0.05–11.6%, colourfulness 28–60, saturation 0.22–0.52) | tone fixes overshot both ways (crushed blacks in round 1, milky lifted shade two rounds later) until the targets were numbers |
| Restate hard brief constraints ("the tram itself is never rendered") | the ride agent built a full cab interior; the orchestrator removed it |

---

## 4. Patterns

### 4.1 pipeline(build → critique → fix), one owner per area
`pipeline(AREAS, build, critique, fix)`: each area flows through its own chain with no barrier, so fast areas (ride: 33 min build) are fixed while slow ones (humans: 140 min) still build. The critic gets the builder's report and the original task; the fixer gets the critique and the original task. Template: `parallel-build-critique-fix.js`.

### 4.2 Multi-lens critic panel + per-owner fixes, looped to a target
Each round: N critics in parallel, each with one **lens** (light/tone/atmosphere; surfaces/geometry; shot/motion/camera; people/crowd; street life/dressing), every issue tagged with one owner; then one fixer per owner with all issues for that owner merged across lenses. Stop when the **minimum** lens score reaches the target (8.5 here; never reached) or after max rounds. Pass the previous round's `fixed / notFixed / requests` to the next critics: "Check that those fixes really improved things. Turn any still-valid cross-area request into an issue for the right owner."
- One full-app critic (M3) produced 25 mixed issues at 5.5. Four focused lenses (M4) produced deeper, measured findings. A fifth lens (street life) added in M4.7 surfaced a whole neglected area (empty shopfronts, identical umbrellas).
- Append your own findings to the merged list as issues with lens `orchestrator` (orphaned browsers, golden-hour shade p2 53 against 3–40), so owners treat them like any critic's.
- Later rounds added: **serial verify → regression fixes → fresh re-score** inside the round. Template: `photoreal-loop.js`.

### 4.3 `requests` + a consolidated request sweep
Every report carries `requests` for other owners. Between workflows the orchestrator extracts them into one file (`.work/m4_requests.json`: 189 entries with `round, from, text, notFixed`). A sweep workflow gives each owner the file: "handle every request and not-fixed note that concerns your area (by name, by your files, or clearly in your domain). Do them, or decline with a concrete reason." Leftovers go to the next file (`.work/m46/leftovers.json`) and into the next round's fix prompts. Template: `request-sweep-and-serial-qa.js`.

### 4.4 holdOwners / holdAlways
When a separate workflow owns some files (the people rebuild owned the figure files during M4), pass `holdOwners` (skip those owners' fixes in round 1) and `holdAlways` (skip every round), and tell the relevant critic to stop reporting that area: "the human FIGURES themselves are being rebuilt from scratch by a separate team right now, so do NOT report figure-appearance issues. Focus on the crowd." Deferred issues are logged, not silently dropped.

### 4.5 Serial QA on a quiet machine
Parallel owners make timing meaningless. Run ONE QA agent after the fan-out: "Run captures ONE AT A TIME (never in parallel). Check `uptime`, `nvidia-smi` and running headless browsers before every measurement; if the machine is busy, wait and retry, and report the load next to every number." The M4.8 verifier's wrapper waited for: no other headless browser or capture tool, load1 < 6, median GPU over 5 s < 45%. Measure GPU/CPU median and p95 over 600+ riding frames **with a frame cap** (uncapped rendering lets the CPU queue frames and inflates CPU time), hitches over 50/60 ms through streaming, stops, the loop wrap and a time-of-day sweep, cold start over 3 runs, heap over 3 minutes; plus every behaviour check. Pause the checkpoint loop while it runs.

### 4.6 Status audit → build round
After an interruption (or any time you do not know the state), run 3–4 **read-only** auditors in parallel, each over one area: residue of the last sweep, the weakest subsystem, the photoreal gap against the references, perf/behaviour/delivery. Prompt: "verify against the code and assets at HEAD instead of trusting reports. Count an item as done only if you can see it in the code or assets. Report items OPEN, PARTIAL, UNVERIFIED or BROKEN with evidence (file:line, a journal quote, or a measurement), severity (blocker/major/minor) and effort (S/M/L)." Point them at the old workflow journals (`journal.jsonl` rows `started`/`result`, `agent-*.jsonl` transcripts) to reconstruct what a dying agent was doing. The orchestrator then writes a prioritized task list per owner, with cross-module decisions settled, and launches the build round (M4.6).

### 4.7 Two-stage track inside a fan-out
When one area needs sequential steps but should run beside the other owners, put an `async` thunk in the same `parallel([...])`: `const peopleRun = async () => { const h1 = await agent(ship...); const h2 = await agent(realism(h1)...); return [h1, h2] }`.

### 4.8 Single-agent targeted fix workflow
For a regression found mid-round in an area whose owner has finished (milky tram windscreen after a satin-paint pass; folded-arms pose broken by a cloth pass), launch a one-agent workflow with the before/after evidence, the exact physical target ("sharp, Fresnel-weighted reflection ... never a frosted haze"), what must not change, and "Finish within about 45 minutes and leave every file complete." Both landed within about 45 minutes.

### 4.9 Blind A/B between two commits
Scores drift because each panel is a fresh, often stricter set of judges (people fell 6 → 5.5 in a round that improved them). To accept or revert a round: `git archive` both commits into `.work/ab/old` and `.work/ab/new`, render identical views serially from each tree's own tools, build side-by-side sheets labelled only L/R with a fixed per-view assignment that is never written to disk, delete raw renders, and ask 3 judges with different weightings (overall; light/colour/materials first; people/motion/street life first) to pick the more photographic half per view against the references. Tally in the script. Decision rule used: accept if the new build wins the votes and the re-score did not drop. Result: new 20, old 13, ties 3; new won 7 views, old 4 (golden hour and dusk), which became the "fix first" list. Note: procedural content that changed between builds (different signs, different people) confounds a view; the render agent should flag it. Template: `blind-ab.js`.

### 4.10 Resume, and continuation when resume fails
- Edited a script mid-run (e.g. to hold the figures for a new team)? Stop it and relaunch with `resumeFromRunId`: unchanged agent calls return cached results (M4 round 1 replayed instantly; round 2 ran live with `holdAlways`).
- If resume is refused ("run has not exited yet"), write a **continuation script**: copy the script, replace finished phases with their saved results (scores as literals, issues written by the orchestrator to a file such as `.work/m47/crit_r1.json` under `byOwner.<owner>`), and tell re-run agents "An earlier attempt at this fix was interrupted part-way, so some of it may already be in the tree: read the current code and continue from there."
- Before resuming, commit the partial state and check the tree is healthy (cold start, 0 console errors, height probe).

### 4.11 Watchers on the journal
A small poller tails `<transcriptDir>/journal.jsonl` and prints `FINISHED <label> (result|failed) score=<n>` once per agent (`scripts/watch_results.py`; `--skip-existing` when re-arming); run it under a background monitor so each finished owner wakes the orchestrator. A second watcher greps for the `verify` label to pause the checkpoint loop, and restarts it when that agent's result row appears. Watchers time out (30 min here) and need re-arming; make `pgrep`/`pkill` patterns specific, because a check matched its own command line and reported "still running".

---

## 5. Failure modes and fixes

| Symptom | Cause | Fix / prevention |
|---|---|---|
| Perf numbers swing 2–3×; cold start 44–80 s instead of 14 s; load average 50–75 | 10–13 agents each running headless GPU captures on one GPU | Owners report structural metrics; one serial QA times everything on a quiet machine; pause the checkpoint loop during it |
| GPU at 97% for 78 min with no workflow running | an orphaned headless browser kept rendering uncapped after its script died | capture tools start the browser in its own process group and kill it on exit, exceptions, SIGTERM (as sent by `timeout`) and atexit; `--max-seconds` watchdog; `--reap` at start; every capture under `timeout` |
| Checkpoint images show people floating, a broken tram front, coloured bands, console errors | the 20-min checkpoint (and other agents' screenshots) caught half-finished edits | before reacting, re-render the same view from the current tree; add a probe (people-height offset > 1 m, `bad` must be 0) to every QA; rule "never leave a file half-edited for long" |
| Regressions from later rounds: golden hour ~2.5 EV too dark; blacks lifted (p2 23 → 42); windscreen milky; folded arms broken; shadow filter +4 ms; golden hour lost colour (colourfulness 31.7 → 23.9) | a fix in one area overreached (exposure rework, satin-paint pass also hit glass, cloth drape widened sleeves, runtime loop bounds stopped unrolling, gamut fix) | serial verify after every fix round with **fixed standard views** compared to the previous round's views plus measured tone targets; regression fixes before re-score; single-agent fix for anything found later |
| Agents restarted 2–6 times; short-lived duplicates in the journal | API/network errors; the runtime retries a failed agent from the **current disk state** with a fresh context | prompts must be restart-safe: "Read the current code first", keep each change complete before moving on |
| 6 of 11 fixers `failed` at once; resume refused | an interruption propagated to running agents; they hit their retry limit | commit and health-check the tree; continuation script (4.10) |
| Weekly usage limit killed the QA agent at start and the people fixer mid-edit; work stopped for ~29 h | account limit | commit often (auto-checkpoint kept committing until the end); write state to files, not only to the workflow return; audit before resuming |
| "The round-2 fixes were never shipped" | the agent rebuilt the people cast into a git-ignored scratch folder and died before promoting it | require outputs promoted to tracked paths and loaded by the app before a report says "done"; the audit checks the shipped version |
| Panel plateaued at ~6–6.5 against a target of 8.5 | see below | stop on blind A/B, not on the target |
| One critic's 25 mixed issues | no lens, no measurements | focused lenses, each told how to measure (crop mean RGB/luma vs the photos) |
| Critics contradict each other | different lenses, different taste | "If two critics disagree, follow the reference photos"; give numeric reference targets |
| Agent built something the brief forbids (a cab interior) | brief constraint not repeated in the area task | restate hard constraints in the preamble; review checkpoints for them |
| 3 MB PNG / 9 MB MP4 never reached the user's phone | upload limit ~3.2 MB | send JPEGs; record a ~3 MB 720p "phone" encode |

**What still moved the plateaued scores** (6 → 6.5 took two full rounds):
- Measured targets from the reference photos (p2 luma, clipped %, Hasler colourfulness, HSV saturation on 1000 px downscales). Golden-hour shade p2 went 53 → 16–24 only after it was a number.
- Replacing a weak subsystem wholesale instead of tweaking it: procedural figures were stuck at 3.5–5.2; a CC0 parametric-human cast took people to 5–6.
- Contact and grounding cues: contact shadows under feet, the oncoming tram's skirt, underframe and closed shadow hull (it "hovered" before).
- User-observed fundamentals: the camera now rides fixed to the cab ("must move as if it is on rails").
- A new lens exposing a neglected area (street life 6 → 7).

**What did not move them:** repeated tweaks of the same item ("needs a deeper fix, not a tweak"); people within ~15 m (stuck at 5–6 while the crowd at 15–150 m read as photographic).

---

## 6. Sizing and budgeting

| Agent type | Typical duration here |
|---|---|
| Area builder (first version) | 33–140 min |
| Critic (12–30 screenshots) | 15–45 min |
| Owner fixer | 40–150 min |
| Serial QA / verify | 43–73 min |
| Read-only auditor | 15–24 min |
| A/B render (24 serial captures) / judge | 14 min / 4–7 min |

- **Fan-out width:** 8–13 owners per workflow worked for file ownership; the limit is the shared GPU, not the runtime (concurrency cap `min(16, CPUs − 2)`). More owners → worse timings and slower captures, not more conflicts.
- **One workflow = one stage type** (build round, photoreal round, sweep, audit, A/B). Each ran 2–8 h; chain them and read results in between.
- **Round cost:** a full photoreal round (5 critics + 11 fixers + verify + 3–4 regression fixers + 5 re-score critics) ≈ 20–26 agents and ~6–7 h. Expect +1.0 mean in the first round from ~5, then +0.2–0.4 per round above 6.
- **Prompt size:** cap injected context (`JSON.stringify(x).slice(0, 9000 … 40000)`); for big issue lists, write a file and tell the agent where to read its section.
- **Stop criteria:** a target score (min across lenses) and max rounds in the loop; at the project level, stop when a blind A/B no longer prefers the new build or the user calls it.
- **Overlap safely:** two workflows may run at once only on disjoint files (M2b beside M3; the people rebuild beside M4 with `holdAlways`).
- **Match the tool to the task.** Workflows pay off for multi-hour, many-owner or independent-judgement work. For documentation, licence files, a README section or a two-file fix, work inline: a docs agent spent an hour verifying before writing, and the user said "we dont need workflow for this simple task" and later "do it without subagents". Ask yourself whether one careful pass by you, plus one check, would do.

---

## 7. Staying in the loop

**Between workflows** (each time, ~15–60 min of orchestrator work):
1. Read every structured report. Pull out `requests`, `declined`, `knownIssues`, `contracts` into files under `.work/`.
2. Look at fresh renders yourself next to the references; log observations with owners in a notes file.
3. Measure what the next round should move (tone statistics, timings on a quiet machine, probes).
4. Fold new contracts into the contract doc (or give that job to the core owner in the fix phase: "fold them into the right sections, not a changelog").
5. Update `PLAN.md` status with verified numbers; make a milestone commit whose message lists what landed and the numbers.
6. Write the next script (or edit and resume), settling cross-module decisions in the task lists.

**During a workflow:**
- An auto-checkpoint loop (`tools/checkpoint.sh`, every 20 min) renders 3 rotating views, converts to JPEG, and commits with a message built from the diff: areas touched, files, +/− lines, and the stage from a one-line note file you update at each stage change. Never empty commits.
- Watch the journal (4.11); alert on checkpoints with console errors.
- Bisect visual bugs with module isolation (`only=` / `skip=`) and reproduce with exact params before blaming an owner.
- Agree the report cadence with the user and record it, with other preferences (frame-rate floor, camera behaviour), in persistent memory so the next session keeps them. This user first wanted image reports every ~25 min, then "only when something of the fixes was finished", with before/after images of that change.
- Route user feedback into a follow-up workflow that starts when the owner of those files finishes; never edit files an agent is editing.

---

## 8. Templates

All in `../assets/workflows/`, plain JS for the Workflow tool. Replace every `<<FILL: ...>>`; each script refuses to run while one remains.

| File | Use |
|---|---|
| `parallel-build-critique-fix.js` | M2-style first build of N areas; `areas` array placeholder |
| `photoreal-loop.js` | lens panel → per-owner fixes → serial verify → regression fixes, N rounds to a target, `holdOwners`/`holdAlways`, continuation from saved issues |
| `request-sweep-and-serial-qa.js` | owners resolve a requests file → one serial QA → owner fixes; core folds contracts into the docs |
| `blind-ab.js` | old vs new commit, identical views, independent judges, tally and verdict |
