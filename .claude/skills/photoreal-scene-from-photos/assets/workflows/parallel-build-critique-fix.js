export const meta = {
  name: 'parallel-build-critique-fix',
  description: 'Build every subsystem of a photoreal scene in parallel (one owner per area), each followed by a fresh-eyes photoreal critique against the reference photos and a fix pass',
  whenToUse: 'First real build after the grey-box skeleton, placeholders and the contract doc exist (M2), or a follow-up batch of new areas. Fill every <<FILL: ...>> first.',
  phases: [
    { title: 'Build', detail: 'one owner agent per area, self-verifying with GPU screenshots' },
    { title: 'Critique', detail: 'fresh-eyes photoreal critic per area vs the reference photos' },
    { title: 'Fix', detail: 'the owner implements the critique' },
  ],
}

// Worked example: the 13-area build of a tram cab-ride (39 agents, 4.6 h wall-clock; first-pass
// critic scores 4-5/10). Builders took 33-140 min, critics 16-41 min, fixers 8-81 min (plus retries).
// Before launching: docs/ARCHITECTURE.md must define coordinates, the module API, the material
// names, the file-ownership table and budgets; every module must exist as a working placeholder;
// the capture tool must support module isolation and inspection cameras.
//
// args (optional): { only: ['areaKey', ...] }  run a subset of AREAS (e.g. a follow-up batch)

// ============================ FILL IN: project specifics ============================
const ROOT = '<<FILL: absolute repository path>>'
const PROJECT = '<<FILL: one line, e.g. a PHOTOREAL first-person tram cab-ride through a historic limestone city street, running in the browser (three.js r186 vendored, plain ES modules, no build step)>>'
const SCENE = `<<FILL: 3-6 sentences on what the reference photos show (surfaces, architecture, furniture, vegetation, wires, people and clothing, light, sky) and where OUR camera is relative to them (eye height, direction of travel, default lens). Say so if the photos look the opposite way to our camera.>>`
const REAL_VALUES = '<<FILL: real material values to check against, e.g. albedo in a realistic range: limestone ~0.45-0.65, paving ~0.2-0.35, iron ~0.04>>'
const CAPTURE = '<<FILL: capture command, e.g. python3 tools/shoot.py --params "..." --out .work/shots/<area>/name.png (renders headless on the real GPU and prints console errors plus stats: fps, gpuMs, calls, triangles, build ms per module)>>'
const CAPTURE_PARAMS = '<<FILL: params agents use, e.g. only=<module> to isolate (core modules always load), view=s,d,h,yawDeg,pitchDeg close-up cameras, tod= time of day, fov=, freeze=1, speed=, --shots N --interval t for sequences, --eval "<js>">>'
const DEFAULT_VIEW = '<<FILL: the default framing, e.g. the default telephoto cab view (fov 17)>>'
const BUDGET = '<<FILL: e.g. 1920x1080 at 60 fps target; per chunk per module build < 3 ms at lod 0 and < 1 ms at lod 1; use instancing, merged geometry, shared geometries and LOD>>'
const OFFLINE_TOOLS = '<<FILL: e.g. tools/dk <cmd> runs Blender 4.5 / Node / numpy / ImageMagick in Docker; put scripts in tools/blender/<area>_*.py and outputs in assets/<area>/, keep them small, load them by relative URL>>'
const RNG_RULE = '<<FILL: e.g. use RNG from src/core/rng.js, never Math.random() for world content>>'

const AREAS = [
  {
    key: '<<FILL: area key, e.g. materials>>',
    owns: '<<FILL: globs this owner may create or edit, e.g. src/materials/** and tools/textures/**>>',
    task: `<<FILL: a concrete, numeric brief. What to build and with which technique; library material names to use; real dimensions; perf target; the EXACT verification views (view=..., tod=..., close range and the default view) and what "good" looks like next to which reference photo.>>`,
  },
  // One entry per area. 8-13 areas shared one GPU fine; more areas mostly slows every capture.
]
// ====================================================================================

if (JSON.stringify({ ROOT, PROJECT, SCENE, REAL_VALUES, CAPTURE, CAPTURE_PARAMS, DEFAULT_VIEW, BUDGET, OFFLINE_TOOLS, RNG_RULE, AREAS }).includes('<<FILL')) {
  throw new Error('parallel-build-critique-fix: replace every <<FILL: ...>> placeholder before running')
}

const RUN = (args && args.only) ? AREAS.filter((a) => args.only.includes(a.key)) : AREAS
const N = RUN.length

const PREAMBLE = `
You are one of ${N} senior graphics engineers building, in parallel, ${PROJECT}. Repository: ${ROOT} (cd there; ALL work stays inside it; scratch files go to ${ROOT}/.work/).

READ FIRST:
- docs/ARCHITECTURE.md: contracts, coordinates, module API, file ownership, tooling, budgets. Follow it exactly.
- docs/PLAN.md
- The reference photos in reference/. Open them with the Read tool and study them. They define the target. The scene: ${SCENE}

THE BAR, judged strictly: the result sits on screen next to real photographs and real footage in a blind comparison. Any frame that looks like a 3D demo fails. Use real-world scale and dimensions and physically based materials with real values (${REAL_VALUES}). Nothing toon, flat, low-poly or plastic. No visible primitive placeholders. Add the small irregularities that make things real: bevels, wear, dirt and weathering, variation, imperfection. Avoid repetition patterns visible at the scale the camera sees.

RULES:
1. Only create or edit the files you OWN (listed below). About ${N - 1} other agents are editing the other files at the same time. If you need a change in a file you don't own, describe it in "requests" in your final report (with the exact API or field you need). Do not touch it.
2. Never run state-changing git commands (commit, add, reset, checkout, stash, clean, restore). Read-only git (status/diff/log) is fine. A checkpoint loop may commit the tree at any moment, so never leave a file broken or half-edited for long: make each change complete before moving on.
3. Blind comparison: never write any AI model name, AI company name or "generated by AI" style text anywhere (code, comments, file names, UI, metadata, glTF generator fields, Blender metadata). Do not describe the work in comments or docs as done by agents, critics or workflows: write as an engineering team would.
4. The reference photos are the only description of the place. Do not search the web for this place or for existing 3D assets of it. Never use the reference photos as textures. Build everything procedurally (JS at runtime, GLSL, or Blender/Python scripts), or with freely licensed generic assets whose licence you record in your report. Procedural is strongly preferred.
5. Content must be deterministic: ${RNG_RULE}.
6. Respect the performance budget in ARCHITECTURE.md (${BUDGET}).
7. Tools: \`${CAPTURE}\`. Params: ${CAPTURE_PARAMS}. Run every capture under a time limit (e.g. timeout 600 ...) and make sure no headless browser you started is still running when you finish: an orphaned browser rendering uncapped once held the GPU at 97% for over an hour. LOOK at your screenshots with the Read tool, compare them with the reference photos, and iterate until your part genuinely holds up next to a photograph, at close range and at ${DEFAULT_VIEW}. Check console errors every time. ${OFFLINE_TOOLS}.
8. The GPU is shared with the other owners, so timings are noisy: take the minimum of several runs and prefer structural metrics (draw calls, triangles, build ms, allocations, program counts). A separate serial pass measures timing on a quiet machine later.
9. Other modules may still be placeholders while you work. Judge your own part. Use library material names so your geometry picks up the real materials as they land. If you need a special material, create it, register it with the material library, chain any existing onBeforeCompile hook, and give it physically plausible values.
10. Keep your module loading and working at all times. Never leave a syntax error behind, because other agents are taking screenshots of the whole app. Your final state must run with zero console errors.
11. Keep code clean and readable: sensible structure, short comments where they help, matching the existing code style.

When finished, reply with ONLY the structured report.`

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: 'what was built and how (technique), 5-15 sentences' },
    verification: { type: 'string', description: 'how it was verified; list key screenshot paths' },
    perf: { type: 'string', description: 'measured build ms per chunk, draw calls, triangles, gpu ms where relevant (say if the GPU was contended)' },
    knownIssues: { type: 'array', items: { type: 'string' } },
    requests: { type: 'array', items: { type: 'string' }, description: 'changes needed in files owned by others, addressed to the owner by name, with the exact API' },
    contracts: { type: 'array', items: { type: 'string' }, description: 'new or changed public APIs, fields or URL params the contract doc must describe' },
    licenses: { type: 'array', items: { type: 'string' }, description: 'third-party assets used with licence, or empty' },
  },
  required: ['area', 'filesChanged', 'summary', 'verification', 'perf', 'knownIssues', 'requests', 'contracts', 'licenses'],
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    score: { type: 'number', description: '1-10 photorealism of this area vs real photographs' },
    screenshots: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'which screenshot / params / what is visible / which reference photo shows it right' },
          fix: { type: 'string', description: 'concrete fix suggestion' },
        },
        required: ['severity', 'title', 'evidence', 'fix'],
      },
    },
  },
  required: ['area', 'score', 'screenshots', 'issues'],
}

const results = await pipeline(
  RUN,
  (a) => agent(`${PREAMBLE}

YOUR AREA: ${a.key}
YOU OWN: ${a.owns}

${a.task}`, { label: `build:${a.key}`, phase: 'Build', schema: REPORT_SCHEMA }),

  async (report, a) => (!report ? { report: null, critique: null } : { report, critique: await agent(`You are a ruthless photorealism critic and senior technical artist reviewing ONE subsystem of ${PROJECT}. Repository: ${ROOT}. Read docs/ARCHITECTURE.md (tooling and URL params) first, and study the reference photos in reference/ with the Read tool.

The build will be shown in a blind side-by-side comparison against real photographs and real footage, and judged strictly on photorealism. Your job is to find everything about the "${a.key}" subsystem that would betray it as CG, plus functional bugs and performance problems in it. Be adversarial and specific. Do not praise.

The owner's report:
${JSON.stringify(report, null, 1).slice(0, 12000)}

Task requirements for this area (for context):
${a.task}

How to inspect: \`${CAPTURE}\` (save under .work/shots/critic_${a.key}/). Params: ${CAPTURE_PARAMS}. Use isolation and also the full app. Take at least 6 varied screenshots (${DEFAULT_VIEW}, close-ups, other times of day, the far range for LOD and aliasing) and LOOK at each with the Read tool next to the references. Check console errors and the perf stats. Run every capture under a time limit and leave no browser running. Other subsystems may still be unfinished or placeholders; judge only "${a.key}", but note integration problems you see.
Do NOT edit any files (except writing screenshots under .work/). Return the structured critique with the issues ordered by impact, at most 15. Each fix must be concrete enough to implement.`, { label: `critique:${a.key}`, phase: 'Critique', schema: CRITIQUE_SCHEMA }) }),

  async (prev, a) => (!prev.critique ? prev : { ...prev, fix: await agent(`${PREAMBLE}

YOUR AREA: ${a.key}
YOU OWN: ${a.owns}

The first version of this subsystem has been built (task description below). An independent photorealism critic reviewed it. Your job: fix the critique's issues in order of severity (all critical and major ones, then as many minor ones as is sensible), re-verify each with before/after screenshots next to the references, and keep the module working with zero console errors. Read the current code first (an earlier attempt may have been interrupted part-way; continue from what is in the tree).

ORIGINAL TASK:
${a.task}

CRITIQUE:
${JSON.stringify(prev.critique, null, 1).slice(0, 15000)}

Report as the structured report (summarize what you changed in "summary").`, { label: `fix:${a.key}`, phase: 'Fix', schema: REPORT_SCHEMA }) }),
)

// Each item: { area, build, score, critique, fix }. Consolidate every requests/knownIssues/contracts
// entry into a file under .work/ before planning the integration milestone.
const out = RUN.map((a, i) => {
  const r = results[i] || {}
  return { area: a.key, build: r.report || null, score: r.critique ? r.critique.score : null, critique: r.critique || null, fix: r.fix || null }
})
const missing = out.filter((r) => !r.fix).map((r) => r.area)
if (missing.length) log(`no fix report from: ${missing.join(', ')} (check the journal; rerun those areas with args.only)`)
const requestCount = out.reduce((n, r) => n + [r.build, r.fix].filter(Boolean).reduce((m, x) => m + (x.requests || []).length, 0), 0)
log(`${out.length - missing.length}/${out.length} areas fixed; critic scores ${out.map((r) => `${r.area} ${r.score}`).join(', ')}; ${requestCount} cross-area requests to consolidate`)
return out
