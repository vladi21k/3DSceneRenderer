export const meta = {
  name: 'request-sweep-and-serial-qa',
  description: 'Owners resolve the cross-module requests and leftovers addressed to them, then one serial perf + behaviour + visual QA on a quiet machine, then owners fix what QA found and core folds the new contracts into the docs',
  whenToUse: 'After a photoreal loop or build round leaves requests/declined items behind, or as an integration + budget milestone. The orchestrator first writes the requests file. Fill every <<FILL: ...>> first. args: { requestsFile, tag, tasks: { owner: "extra prioritized task text" }, baseline, extraChecks }',
  phases: [
    { title: 'Resolve', detail: 'one agent per owner area: incoming requests plus assigned tasks' },
    { title: 'QA', detail: 'ONE serial perf + behaviour + visual pass on a quiet machine' },
    { title: 'Fix', detail: 'owners fix QA findings; core folds contract changes into the docs' },
  ],
}

// Worked example: 10 owners handled 189 requests left by a 3-round photoreal loop (2 h; whole-app
// garbage 1365 -> 920 KB/frame). A later build round of this shape (owners + a 2-stage people track,
// 19 agents, 7.1 h) ended with every behaviour check passing and GPU 11-14 ms against a 28 ms budget.
// The QA agent is deliberately alone: with 10 owners capturing on one GPU, timings were noise
// (load average 50-75, cold start 44-80 s instead of 14 s).
//
// args:
//   requestsFile: path the owners read, e.g. .work/requests.json, an array of { round?, from, text, notFixed? }
//                 (the orchestrator extracts every report's requests / declined / notFixed into it)
//   tag: scratch folder name (default 'sweep')
//   tasks: { owner: 'prioritized extra tasks, numbered, with evidence paths and settled cross-module decisions' }
//   baseline: path of the previous QA result / standard views to compare against
//   extraChecks: more QA checks for this round

// ============================ FILL IN: project specifics ============================
const ROOT = '<<FILL: absolute repository path>>'
const OWNERS = {
  '<<FILL: owner key, e.g. materials>>': '<<FILL: globs this owner may edit>>',
  // ... every owner area. Include core: '<main loop, core libs, route/layout/streaming, server, capture tools, docs/ARCHITECTURE.md, docs/ASSETS.md> (be conservative: everything depends on these; never rename public APIs)'
}
const PROJECT = '<<FILL: one line, e.g. a PHOTOREAL first-person tram cab-ride through a historic limestone city street, running in the browser (three.js r186 vendored, plain ES modules, no build step)>>'
const BUDGET = '<<FILL: e.g. QUALITY FIRST, 30 fps minimum: <= ~28 ms GPU / <= 20 ms CPU per frame at 1920x1080 on this GPU, no riding hitches over 60 ms, cold start <= 10 s>>'
const CAPTURE = '<<FILL: capture tool and its timing options, e.g. python3 tools/shoot.py (--eval, --hitches, --heapprof, --pre <js>, view=, s=, tod=, fov=, freeze=1, only=, skip=, debug=1)>>'
const PERF_PLAN = '<<FILL: what QA measures, e.g. GPU and CPU ms (median, p95) over 600+ riding frames at speed=50 WITH A FRAME CAP (uncapped rendering queues frames and inflates CPU time) on the default view, at tod 0.55, 0.8 and 1, and at fov 40 and 60; draw calls and triangles; cold start (ready time and per-module init breakdown) over 3 runs; frames over 60 ms through streaming and LOD swaps, a station stop, the loop wrap and a time-of-day sweep 0 -> 1 -> 0; heap growth and GC over a 3-minute ride (leak or warm-up?)>>'
const BEHAVIOUR_PLAN = '<<FILL: every behaviour requirement from the brief as a check, e.g. automatic platform stop at stopS, dwell 12-18 s, departure with bell; throttle/brake via KeyboardEvent; mouse-look limits and return to centre; FOV zoom; time-of-day slider; lamps, shops and headlight at dusk; pedestrians never inside the vehicle swept volume over a long run; crossings and bell reactions; loop wrap; audio graph with no errors; UI hide; zero console errors in every run; no vehicle geometry visible from the cab at any FOV; recording mode still steps frames>>'
const STANDARD_VIEWS = '<<FILL: the fixed standard views, e.g. default; s=700 tod 0.1; s=1450 tod 0.55; s=2440 tod 0.3 fov 28; s=3300 tod 0.8; s=4100 tod 0.97; s=5000 tod 0.45 fov 40; view=430,9,1.7,-60,8>>'
const PROBES = '<<FILL: regression probes, e.g. the people-height probe via --eval (expect bad: 0) at every standard view>>'
// ====================================================================================

const A = args || {}
if (JSON.stringify({ ROOT, OWNERS, PROJECT, BUDGET, CAPTURE, PERF_PLAN, BEHAVIOUR_PLAN, STANDARD_VIEWS, PROBES }).includes('<<FILL')) {
  throw new Error('request-sweep-and-serial-qa: replace every <<FILL: ...>> placeholder before running')
}
if (!A.requestsFile) throw new Error('request-sweep-and-serial-qa: pass args.requestsFile (write it first)')
const TAG = A.tag || 'sweep'
const TASKS = A.tasks || {}
const KEYS = Object.keys(OWNERS)

const PREAMBLE = `
You are a senior graphics engineer on ${PROJECT}. Repository: ${ROOT} (cd there; all work stays inside it; scratch output goes to .work/${TAG}/<your area>/).
READ FIRST: docs/ARCHITECTURE.md (contracts, ownership, tooling, URL params) and docs/PLAN.md. Budget: ${BUDGET}. The build is judged in a BLIND side-by-side comparison with real photographs: reference/ (open them with the Read tool; they describe the scene).

OTHER OWNERS WORK IN PARALLEL on the rest of the code. So: (a) cross-module decisions in your task list are already settled; follow them; (b) before declining anything for a missing API, re-read the other module's code at the END of your work; (c) put anything you need from a file you do not own into "requests" with the exact API you need.

RULES: only edit the files you own (listed below). No state-changing git commands (a checkpoint loop commits the tree every ~20 minutes, so never leave a file broken or half-edited for long). Never write any AI model, AI company or AI tool name anywhere, and do not describe the work in code comments or docs as done by agents, critics, panels or workflows: write as an engineering team would. No web searches for this place or its assets. Deterministic content. Zero console errors at all times. Run every capture under a time limit and leave no headless browser running. Verify every change with screenshots (LOOK at them next to the references) and measurements. The machine is shared with other owners and the GPU is busy, so take timings as a minimum over several runs, and prefer structural metrics (allocations per frame, draw calls, triangles, upload bytes, program counts); a separate serial QA pass measures timing on a quiet machine after you.
When finished, reply with ONLY the structured report.`

const REPORT = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    done: { type: 'array', items: { type: 'string' }, description: 'each change with before/after evidence' },
    declined: { type: 'array', items: { type: 'string' }, description: 'requests or tasks not done, with the concrete reason' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    contracts: { type: 'array', items: { type: 'string' }, description: 'new or changed public APIs, fields or URL params that docs/ARCHITECTURE.md must describe' },
    perf: { type: 'string' },
    requests: { type: 'array', items: { type: 'string' } },
  },
  required: ['owner', 'done', 'declined', 'filesChanged', 'contracts', 'perf', 'requests'],
}
const QA_SCHEMA = {
  type: 'object',
  properties: {
    metrics: { type: 'string', description: 'measured perf with the machine load next to each number' },
    behaviour: { type: 'string', description: 'pass/fail for every behaviour check, with evidence' },
    visual: { type: 'string', description: 'regressions or improvements seen in the standard views' },
    screenshots: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, owner: { type: 'string', enum: KEYS }, title: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'owner', 'title', 'evidence', 'fix'] } },
  },
  required: ['metrics', 'behaviour', 'visual', 'screenshots', 'issues'],
}

// ---- Resolve ----
phase('Resolve')
const resolved = await parallel(KEYS.map((o) => () => agent(`${PREAMBLE}

YOUR AREA: ${o}
YOU OWN: ${OWNERS[o]}

TASK: read ${A.requestsFile} and handle every request and not-fixed note that concerns your area (addressed to you by name, by your files, or clearly in your domain). Do them, or decline with a concrete reason. Prioritise anything that affects how photographic the frames look, correctness, or riding hitches and GC pauses.${TASKS[o] ? `\n\nALSO, YOUR ASSIGNED TASKS (in priority order):\n${TASKS[o]}` : ''}${o === 'core' ? '\n\nDo NOT rewrite docs/ARCHITECTURE.md yet; you fold in every owner\'s contract changes in the Fix phase.' : ''}`, { label: `resolve:${o}`, phase: 'Resolve', schema: REPORT })))
const reports = {}
KEYS.forEach((o, i) => { reports[o] = resolved[i] })
const missing = KEYS.filter((o) => !reports[o])
if (missing.length) log(`Resolve: no report from ${missing.join(', ')}`)

// ---- QA (serial, alone) ----
phase('QA')
const summary = JSON.stringify(Object.entries(reports).filter(([, r]) => r).map(([k, r]) => ({ owner: k, done: r.done, declined: r.declined, contracts: r.contracts, perf: r.perf, requests: r.requests }))).slice(0, 40000)
const qa = await agent(`You are the performance and QA engineer for ${PROJECT} (repo ${ROOT}). Read docs/ARCHITECTURE.md (tooling: ${CAPTURE}; URL params) and docs/PLAN.md. The module owners just finished a round. Their reports: ${summary}
${A.baseline ? `Baseline from before the round: ${A.baseline}.` : ''}
Run captures ONE AT A TIME, never in parallel, each under a time limit. Check uptime, GPU load and running headless browsers before every measurement. If the machine is busy (another browser, a recording, load1 above ~6), wait and retry, and report the load next to every number. Leave no browser running. Save everything under .work/${TAG}/qa/.
PERF: ${PERF_PLAN}. Budget: ${BUDGET}.
BEHAVIOUR: ${BEHAVIOUR_PLAN}.
VISUAL: shoot the standard views (${STANDARD_VIEWS}), run the probes (${PROBES}), and compare with the baseline and with reference/: report regressions (broken geometry, z-fighting, blown or crushed tones, popping, floating or missing objects, artefacts) and what improved.${A.extraChecks ? `\nALSO: ${A.extraChecks}` : ''}
Do NOT edit any files. Return metrics, behaviour results, visual notes, screenshots and issues, each issue with exactly one owner.`, { label: 'qa', phase: 'QA', schema: QA_SCHEMA })
if (!qa) log('QA returned nothing: rerun it alone before trusting this round')

// ---- Fix ----
phase('Fix')
const mine = (o) => ((qa && qa.issues) || []).filter((i) => i.owner === o)
const fixOwners = KEYS.filter((o) => (o === 'core' && OWNERS.core) || mine(o).length)
const contractNotes = JSON.stringify(Object.entries(reports).filter(([, r]) => r).map(([k, r]) => ({ owner: k, contracts: r.contracts, filesChanged: r.filesChanged }))).slice(0, 30000)
const fixes = await parallel(fixOwners.map((o) => () => agent(`${PREAMBLE}

YOUR AREA: ${o}
YOU OWN: ${OWNERS[o]}

The serial QA pass measured the app after the round. Fix the issues assigned to you (critical and major first), re-verifying each:
${JSON.stringify(mine(o), null, 1)}
QA metrics for context: ${((qa && qa.metrics) || '').slice(0, 6000)}
${o === 'core' ? `ALSO: update docs/ARCHITECTURE.md with every contract change from this round, folded into the right sections (not a changelog). The owners' contract notes: ${contractNotes}` : ''}`, { label: `fix:${o}`, phase: 'Fix', schema: REPORT })))

// Leftovers for the orchestrator to write into the next requests file.
const all = [...Object.values(reports), ...fixes].filter(Boolean)
const leftovers = all.flatMap((r) => [
  ...(r.requests || []).map((text) => ({ from: r.owner, text })),
  ...(r.declined || []).map((text) => ({ from: r.owner, text, notFixed: true })),
])
log(`QA issues: ${((qa && qa.issues) || []).length}; fix reports: ${fixes.filter(Boolean).length}/${fixOwners.length}; leftovers: ${leftovers.length}`)
return { reports, qa, fixes: fixes.filter(Boolean), leftovers }
