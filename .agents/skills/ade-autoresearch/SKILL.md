---
name: ade-autoresearch
description: Iteratively optimize an ADE tab's CPU/memory/IPC/render performance.
  Drives the real UI, builds tab-specific probes from the visible product and
  perf-pass repo, identifies bottlenecks from JSONL metrics, makes ONE targeted
  code change per iteration, gates on tests + smoke, keeps wins on a branch, and
  distills patterns into per-tab perf skills. Invoke when the user says
  "optimize <tab>", "autoresearch <tab>", or "perf pass on <tab>". Drives ADE
  pointed at the perf-pass throwaway repo; full liberty inside that repo. Uses
  Codex/GPT models for in-ADE AI activity unless the run explicitly opts into
  another configured provider for comparison.
metadata:
  author: ADE
  version: 0.3.0
---

# ade-autoresearch

A Karpathy-style autoresearch loop for ADE perf. You (the agent) ARE the loop runner — there is no hidden script. Follow this algorithm exactly.

## Inputs

- `<tab>`: the tab to optimize. Must be one of: `boot`, `lanes`, `prs`, `work`, `files`, `run`, `graph`, `review`, `history`, `automations`, `cto`, `settings`. (`boot` = cold launch + welcome + project open + remote runtime + iOS pairing — the "main ADE screen" surface above any specific tab.)
- `<perf-pass-dir>`: throwaway git repo path. Defaults to `/Users/admin/Projects/perf pass` (note the space — quote it). Must exist, must be a git repo, must have a `perf-pass-seed` tag (or you create one on first run). Override via `ADE_PERF_PASS_DIR` env var.

## Real UI audit is the primary loop

The job is to find what a person actually feels in the tab. Do not predefine a
fixed deterministic scenario suite and mistake that for the audit. Build the
measurement plan from the live UI, source, and perf-pass repo; then create
whatever repeatable probes, scripts, seeded repo states, or tests are needed to
show load-time, CPU, heap, IPC, render, and interaction deltas for the surfaces
the user actually exercises.

Use this order:

1. **Warm launch the real Electron UI on the target tab** and keep it open while auditing:
   ```bash
   NO_DEVTOOLS=1 ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1 ADE_LOCAL_RUNTIME_FALLBACK=1 ADE_MODEL_OVERRIDE=gpt-5-codex \
     node scripts/perf-launch.mjs --tab <tab> --run-id <tab>-ui-audit-$(date +%Y%m%d-%H%M)
   ```
   Confirm the Electron surface is on the requested tab. The visible active tab must match `<tab>`; do not audit a related embedded surface from another tab.

2. **Build an action inventory from the visible UI and source.** Start with the tab's actual first screen, then cover every safe user action, subpane, menu, picker, dialog, mode switch, list interaction, empty state, error/preflight state, expand/minimize/fullscreen state, keyboard/search/filter path, and tab-specific destructive/external preflight. For destructive or externally visible actions, open and measure the prompt/preflight unless the user has explicitly allowed final execution.

   The inventory must be tab-derived. For example, a Work pass should cover Work sidebar/session list, chat/CLI/shell start surfaces, session tabs/grid/layout controls, running/ended session actions, model/attachment/command/parallel pickers, terminal/chat panes, context menus, filters/search, and ADE tools drawers because those are Work-tab surfaces. A Lanes pass should cover lane list, stack graph, lane dialogs, Git Actions, and lane Work panes because those are Lanes-tab surfaces.

   Do not claim complete coverage until the inventory itself says every row is
   measured, prompt-only, external-skip, or explicitly deferred with a reason.
   A handful of representative clicks is a partial smoke pass, not an audit. If
   an action matrix already exists for the tab, update that matrix as evidence
   arrives instead of replacing it with narrative notes.

   Treat the matrix as the work queue. Pick the next unresolved action/state,
   drive that exact UI path, record evidence, then either promote the row or
   mark why it needs a fixture, sandbox, prompt, or external dependency. When a
   row exposes slowness, churn, overflow, broken behavior, or missing
   accessibility, make one targeted product change, re-drive that same row, and
   only then move to the next row.

3. **Mark each UI segment in the perf log** before and after exercising it:
   ```ts
   window.ade.perf.recordEvent({ kind: "manualStep", ts: Date.now(), name: "git-actions-stage", phase: "start" });
   // drive the visible UI
   window.ade.perf.recordEvent({ kind: "manualStep", ts: Date.now(), name: "git-actions-stage", phase: "end" });
   ```
   Segment names should describe the workflow, not the implementation detail.

4. **Use direct IPC only for setup, cleanup, and analysis.** It is fine to create fixture data, reset a throwaway repo, query status, or extract metrics through IPC/shell. Do not replace a UI audit action with `window.ade.*` unless the UI is genuinely impossible to drive; if you must, say so in the run notes.

5. **Create UI-derived probes after findings.** If existing scenarios cover a
   surface, you may run them. If they do not, write a tab-specific probe,
   scenario, fixture, or test that reproduces the measured workflow against the
   perf-pass repo. The probe is evidence, not a product requirement: it exists to
   quantify a real UI bottleneck and compare before/after behavior.

## Setup (do once at start of run)

1. **Read prior wins** at `.agents/skills/ade-perf-<tab>/SKILL.md` if it exists. These are optional best-practice notes from earlier audits, not prerequisites. If no per-tab skill exists, derive the checklist from the tab UI and source and create the per-tab skill only during codification after you have measured real behavior.
2. **Inspect existing perf probes** under `apps/desktop/src/renderer/perf/scenarios/`,
   scripts, and tab tests. Reuse what matches the tab, but do not treat missing or
   incomplete scenarios as a blocker and do not let scenario availability define
   the work. It is acceptable to add new tab-specific scenarios/probes when they
   help quantify a real UI workflow.
3. **Verify perf-pass repo** exists, has a seed tag, and can exercise real GitHub paths when needed:
   ```bash
   scripts/reset-perf-pass.sh
   ```
   Refuse to start if perf-pass doesn't exist. If the tab uses GitHub behavior, publish the repo as a private `perf-pass` remote before measuring push/pull/fetch UI.
4. **Create a working branch** off main:
   ```bash
   git checkout -b autoresearch/<tab>-$(date +%Y%m%d-%H%M)
   ```
5. **Set the model override** for all in-ADE AI activity: export `ADE_MODEL_OVERRIDE=gpt-5-codex` (or another GPT/Codex model id available in ADE). Don't touch this during the run.

## Baseline (iteration 0)

Start with the real UI inventory. The baseline is complete when every safe tab
surface has been exercised or explicitly marked unsafe/external/destructive, and
each measured segment has corresponding perf evidence.

For each important workflow, capture at least one of:

- A real UI perf-launch run with `manualStep` markers in
  `~/.ade/perf-runs/<runId>/events.jsonl`
- A purpose-built probe or scenario that drives the workflow against the
  perf-pass repo and writes `summary.json` / `events.jsonl`
- A focused unit/component/integration test that reproduces the expensive derive,
  mount, or IPC behavior
- A shell/IPC setup script only for fixture creation and cleanup

Record `baseline_metrics` as a small table, not a single mandatory fitness
score. Include the metrics that matter to the surface: route/load time, segment
duration, main CPU p95, renderer CPU or long tasks, heap growth, IPC count/p95,
render-on-scroll time, or panel mount cost. If an existing scenario reports a
fitness score, keep it as one data point; do not let it override real UI evidence.

Then analyze `events.jsonl` by manualStep segment. Record the worst UI segment,
the slow IPC channels inside it, and whether the cost is expected work (for
example network push/fetch) or avoidable tab work.

Tag the baseline commit:
```bash
git tag perf-baseline-<tab>-$(date +%Y%m%d)
```

## Iteration loop

Stop conditions: **no measurable improvement on the current bottleneck for 10
consecutive attempts** OR user kills the run OR 50 iterations OR 4 hours
wall-clock.

For each iteration:

### 1. Analyze
- Read the latest real-UI `events.jsonl`, probe outputs, scenario summaries, and
  focused test results.
- Pick the **#1 bottleneck**: the avoidable cost that appears in real UI segments
  or repeatable probes. Tie-break by user-visible workflow first, then
  reproducibility and metric severity.
- Common bottleneck categories:
  - **Slow IPC channel**: a channel in `summary.ipc.slowChannels` with p95 ≥ 120ms
  - **Long task spam**: `webVitals.longTaskCount` > 5 per minute
  - **Memory growth**: `process.rendererHeapGrowthMB` > 10 over a measured workflow
  - **Render-on-scroll cost**: `marks.scroll.*` p95 high
  - **Route transition cost**: `marks.nav.*` or `marks.switch.*` p95 high
  - **Main CPU**: `process.mainCpuPercentP95` > 30 during idle or panel-open probes → background pollers
- UI segment waste: heavy refreshes, duplicate mounted panes, hidden pollers, repeated global status checks, or expensive dialog prefetches that are not needed for the action the user took
- Read the code that owns the bottleneck. Form a hypothesis.

### 2. Propose ONE change

Legal moves (examples, not a complete list):
- Memoize a hot selector with `useMemo` / `useCallback`
- Batch IPC calls (collapse N independent invokes into one)
- Debounce / throttle a poller
- Virtualize a long list (`@tanstack/react-virtual` or similar)
- Lazy-load a heavy component (`React.lazy`)
- Replace `O(n²)` work with a Map lookup
- Hoist a stable callback out of render
- Skip re-renders with `React.memo` + stable props
- Move work off the render thread (`requestIdleCallback`, microtask deferral)
- Replace a polling interval with an event-driven subscription
- Cache an expensive derive (only invalidate on deps change)

**Forbidden moves:**
- Editing anything under `apps/desktop/src/main/services/perf/**`
- Editing metrics plumbing under `apps/desktop/src/renderer/perf/harness/**`,
  `apps/desktop/src/renderer/perf/markers.ts`, or
  `apps/desktop/src/renderer/perf/webVitals.ts` to make results look better
- Editing `scripts/run-perf-scenario.mjs` or `scripts/reset-perf-pass.sh` to
  weaken measurement or setup
- Editing test files to make them pass
- Disabling polling/sync features outright (only debounce/throttle)
- Removing UI features or hiding elements to bypass measured workflows
- Changing metric weights, summaries, or existing probes to mask a regression

Allowed measurement moves:
- Add new tab-specific scenarios/probes under `apps/desktop/src/renderer/perf/scenarios/`
  when they drive a real UI-derived workflow.
- Add scripts under `scripts/` or tests under the touched feature area to seed the
  perf-pass repo or reproduce an expensive UI path.
- Expand a probe to cover a newly discovered tab surface, provided it remains
  honest about what it measures.

### 3. Apply the change
One commit, focused. Conventional message: `perf(<tab>): <one-line description>`.

### 4. Test gate
Run **only the affected test files**. Never the full suite. Use the per-tab Vitest projects.
```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test -- --run path/to/affected.test.ts
```
If tests fail: **revert** the commit (`git reset --hard HEAD~1`), do NOT count toward plateau, try a different change targeting the same or next bottleneck.

### 5. Measure
First re-drive the same UI segment with the same markers and compare the
IPC/render/memory/load/CPU delta. Then re-run the smallest probe, scenario, or
test that covers the changed surface. Before declaring the run done, re-run the
final measured sweep that covers the audited surfaces; this can be a mix of real
UI markers, custom probes, and existing scenarios.

### 6. Smoke gate
For each probe or scenario that writes a summary, check
`summary.scenarios.<id>.ok === true` when present and `smokeFailures.length === 0`.
For tests, require the targeted tests to pass. If the workflow breaks or smoke
fails because of the code change: **revert**, increment the missed-attempt
counter.

### 7. Decide
- Improvement threshold: at least one primary metric for the bottleneck improves
  by ≥2% without regressing the surrounding smoke metrics. Use the most relevant
  metric for the workflow (duration, CPU p95, heap, long tasks, IPC count/p95,
  render cost), not a mandatory global fitness score.
- If improvement: **keep**. Update best. Reset plateau to 0. Amend the commit
  message with the metric delta, e.g. `work open 1840ms → 1210ms` or
  `ipc p95 160ms → 70ms`.
- Else: **revert** (`git reset --hard HEAD~1`). Plateau += 1.

### 8. Soft iteration cap
If this iteration has been running >15 minutes wall clock (build loops, scenario flakes, etc.), abort it: revert any in-progress change, mark as a missed iteration (don't count toward plateau), move on.

## Termination

When stop condition hits:
1. Print run summary: baseline metrics, final metrics, %-improvement for each
   kept bottleneck, and list of kept commits (sha + message + metric delta).
2. Suggest the user merge the working branch into main via PR.
3. Proceed to codification (next section).

## Completion and handoff discipline

Do not describe the run as "done", "complete", or "covered" while the tab
inventory still has unresolved rows (`source`, `fixture-needed`, `sandbox-only`,
or unvisited `prompt-only` / `external-skip`) unless the user explicitly narrowed
the objective. Open rows mean the run is still in progress.

If there is a feasible next measured iteration and the user has not asked you to
stop, continue the loop instead of ending with a future-work summary. If you must
pause because the user asked for a handoff, the environment needs cleanup, or a
blocking decision is required, do all of the following before the final response:

- Stop any perf/dev/Electron processes you started and record the latest run id.
- Update the tab audit matrix with what is measured, invalid, skipped, and next.
- Update the per-tab perf skill with any measured win that future agents must
  preserve.
- State clearly that the audit is incomplete and name the next concrete loop.
- Include a ready-to-run follow-up prompt that points to the matrix, run ids,
  current bottleneck, validation commands, and "do not claim full coverage" rule.

## Codify (after the run ends)

Read all kept commits (`git log --oneline perf-baseline-<tab>-... HEAD`). For each, extract the **pattern** (the technique used, not the literal change). Update `.agents/skills/ade-perf-<tab>/SKILL.md`:

- Write this as future engineering guidance for agents editing that tab, not as an audit transcript. One entry per pattern. If a similar pattern already exists, append a refinement instead of duplicating.
- Each entry:
  - **Pattern**: one-line name (e.g. "Debounce git-status pollers behind window visibility").
  - **Why it helped**: which bottleneck it addressed, with the metric delta from the summary.
  - **How to recognize when to apply**: signs in future code that the same pattern is needed.
  - **Anti-pattern to avoid**: what NOT to do.
  - **Verification**: which UI segment, probe, scenario, or test metric this affected.
- Preserve proven history, but keep the top of the file readable as best practices for future code changes.

## Notes on agent behavior

- **Stay focused.** One bottleneck at a time. Resist the urge to "while I'm here also fix..." — that breaks attribution.
- **Trust the metric.** If the relevant measured workflow does not improve, revert
  even when the code feels cleaner. The metric-backed user workflow is the
  contract.
- **The perf-pass repo is your sandbox.** Inside it, you may create lanes, open
  chats, push/pull throwaway branches, run automations, stash changes, and delete
  fixtures when needed to exercise ADE. Purpose-built probes are encouraged when
  fixed scenarios do not cover the tab. Real UI audit coverage is required before
  you call the tab optimized.
- **Codex model preference.** If a probe or in-ADE action invokes chat/agent work,
  use the `ADE_MODEL_OVERRIDE` model (gpt-5-codex by default) for the majority of
  chat work and for deep performance-fix work. Other configured providers may be
  sampled for comparison when the user asks for broad coverage.
- **Concurrency**: only one perf run on the machine at a time. If `~/.ade/perf-runs/` contains a `<runId>/lock` file with a live pid, refuse to start.
