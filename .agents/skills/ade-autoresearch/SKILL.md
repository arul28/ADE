---
name: ade-autoresearch
description: Iteratively optimize an ADE tab's CPU/memory/IPC/render performance.
  Runs predefined scenarios, identifies bottlenecks from JSONL metrics, makes ONE
  targeted code change per iteration, gates on tests + smoke, keeps wins on a
  branch, and distills patterns into per-tab perf skills. Invoke when the user
  says "optimize <tab>", "autoresearch <tab>", or "perf pass on <tab>". Drives
  ADE pointed at the perf-pass throwaway repo; full liberty inside that repo.
  Uses Codex/GPT models for any in-ADE AI activity unless a scenario opts into
  Claude.
metadata:
  author: ADE
  version: 0.1.0
---

# ade-autoresearch

A Karpathy-style autoresearch loop for ADE perf. You (the agent) ARE the loop runner — there is no hidden script. Follow this algorithm exactly.

## Inputs

- `<tab>`: the tab to optimize. Must be one of: `boot`, `lanes`, `missions`, `prs`, `work`, `files`, `run`, `graph`, `review`, `history`, `automations`, `cto`, `settings`. (`boot` = cold launch + welcome + project open + remote runtime + iOS pairing — the "main ADE screen" surface above any specific tab.)
- `<perf-pass-dir>`: throwaway git repo path. Defaults to `/Users/admin/Projects/perf pass` (note the space — quote it). Must exist, must be a git repo, must have a `perf-pass-seed` tag (or you create one on first run). Override via `ADE_PERF_PASS_DIR` env var.

## Shortcuts — prefer IPC and direct launch over computer use

Computer use (screenshots + clicks) is slow and noisy. Always prefer these in this order:

1. **Direct IPC calls** in scenarios. Most ADE actions are exposed on `window.ade.*` — call them directly instead of clicking buttons. Examples:
   ```ts
   await window.ade.project.openRepo({ rootPath: "/some/repo" });
   await window.ade.lanes.create({ name: "x", ... });
   await window.ade.project.listRecent();
   await window.ade.remoteRuntime.listTargets();
   ```
   Read `apps/desktop/src/preload/global.d.ts` for the full IPC surface.

2. **Warm launch on a specific tab** without running any scenario:
   ```bash
   node scripts/perf-launch.mjs --tab lanes
   node scripts/perf-launch.mjs --tab boot --no-project
   node scripts/perf-launch.mjs --route /settings/integrations
   ```
   This boots ADE with perf instrumentation, navigates to the target route, and stays open. Ideal for hands-on inspection of metrics as they stream into `~/.ade/perf-runs/<runId>/events.jsonl`.

3. **Single-scenario run** for a measured cycle:
   ```bash
   node scripts/run-perf-scenario.mjs lanes.cold-list run-id
   node scripts/run-perf-scenario.mjs boot.idle-welcome run-id --no-project
   ```

4. **Computer use is the last resort.** Use only when no IPC exists and a click is unavoidable. Even then, prefer adding a `data-testid` and a `clickTestId` step in the scenario instead of pixel coordinates.

## Setup (do once at start of run)

1. **Read prior wins** at `.agents/skills/ade-perf-<tab>/SKILL.md` if it exists. These are patterns past runs discovered — do not redo them, and prefer NOT to undo them. If conflict, prefer the prior win unless your new change strictly improves on it.
2. **Read scenario definitions** at `apps/desktop/src/renderer/perf/scenarios/<tab>.ts`. These are the *contract*. Do NOT edit them.
3. **Verify perf-pass repo** is clean and on its seed tag:
   ```bash
   scripts/reset-perf-pass.sh
   ```
   Refuse to start if perf-pass doesn't exist — instruct the user to create it.
4. **Create a working branch** off main:
   ```bash
   git checkout -b autoresearch/<tab>-$(date +%Y%m%d-%H%M)
   ```
5. **Set the model override** for all in-ADE AI activity: export `ADE_MODEL_OVERRIDE=gpt-5-codex` (or another GPT/Codex model id available in ADE). Don't touch this during the run.

## Baseline (iteration 0)

Run all scenarios for the tab. For lanes that's:

```bash
node scripts/run-perf-scenario.mjs lanes.cold-list   baseline-cold
node scripts/run-perf-scenario.mjs lanes.switch-rapid baseline-switch
node scripts/run-perf-scenario.mjs lanes.idle-at-rest baseline-idle
node scripts/run-perf-scenario.mjs lanes.scroll-list  baseline-scroll
node scripts/run-perf-scenario.mjs lanes.stress-poll  baseline-stress
```

For boot (which has a mix of project-loaded and no-project scenarios):

```bash
node scripts/run-perf-scenario.mjs boot.cold-paint     baseline-paint   --no-project
node scripts/run-perf-scenario.mjs boot.recent-projects baseline-recent --no-project
node scripts/run-perf-scenario.mjs boot.open-project    baseline-open   --no-project
node scripts/run-perf-scenario.mjs boot.remote-runtime  baseline-remote
node scripts/run-perf-scenario.mjs boot.idle-welcome    baseline-idle   --no-project
node scripts/run-perf-scenario.mjs boot.stress-launch   baseline-stress --no-project
```

Each writes `~/.ade/perf-runs/<runId>/summary.json`. Read all summaries. Compute the **per-tab fitness** as the sum of all scenario fitness scores. Record this as `baseline_fitness`. Also record per-component breakdown so you can target the worst component.

Tag the baseline commit:
```bash
git tag perf-baseline-<tab>-$(date +%Y%m%d)
```

## Iteration loop

Stop conditions: **no fitness improvement for 10 consecutive iterations** OR user kills the run OR 50 iterations OR 4 hours wall-clock.

For each iteration:

### 1. Analyze
- Read the latest set of `summary.json` files for this tab.
- Pick the **#1 bottleneck**: the component contributing most to fitness. Tie-break by reproducibility (the bottleneck that appears across multiple scenarios > single-scenario).
- Common bottleneck categories:
  - **Slow IPC channel**: a channel in `summary.ipc.slowChannels` with p95 ≥ 120ms
  - **Long task spam**: `webVitals.longTaskCount` > 5 per minute
  - **Memory growth**: `process.rendererHeapGrowthMB` > 10 over a scenario
  - **Render-on-scroll cost**: `marks.scroll.*` p95 high
  - **Route transition cost**: `marks.nav.*` or `marks.switch.*` p95 high
  - **Main CPU**: `process.mainCpuPercentP95` > 30 during idle scenarios → background pollers
- Read the code that owns the bottleneck. Form a hypothesis.

### 2. Propose ONE change

Legal moves (examples — not exhaustive):
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
- Editing anything under `apps/desktop/src/renderer/perf/**`
- Editing `scripts/run-perf-scenario.mjs` or `scripts/reset-perf-pass.sh`
- Editing test files to make them pass
- Disabling polling/sync features outright (only debounce/throttle)
- Removing UI features or hiding elements to bypass scenarios
- Changing fitness weights or scenario definitions

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
Re-run all scenarios for the tab. Compute new per-tab fitness.

### 6. Smoke gate
For each scenario's summary, check `summary.scenarios.<id>.ok === true` and `smokeFailures.length === 0`. If any scenario failed smoke: **revert**, increment plateau counter.

### 7. Decide
- Improvement threshold: `new_fitness < best_fitness * 0.98` (≥2% better)
- If improvement: **keep**. Update best. Reset plateau to 0. Amend the commit message with `fitness <old> → <new>`.
- Else: **revert** (`git reset --hard HEAD~1`). Plateau += 1.

### 8. Soft iteration cap
If this iteration has been running >15 minutes wall clock (build loops, scenario flakes, etc.), abort it: revert any in-progress change, mark as a missed iteration (don't count toward plateau), move on.

## Termination

When stop condition hits:
1. Print run summary: starting fitness, final fitness, %-improvement, list of kept commits (sha + message + fitness delta).
2. Suggest the user merge the working branch into main via PR.
3. Proceed to codification (next section).

## Codify (after the run ends)

Read all kept commits (`git log --oneline perf-baseline-<tab>-... HEAD`). For each, extract the **pattern** (the technique used, not the literal change). Update `.agents/skills/ade-perf-<tab>/SKILL.md`:

- One entry per pattern. If a similar pattern already exists, append a refinement instead of duplicating.
- Each entry:
  - **Pattern**: one-line name (e.g. "Debounce git-status pollers behind window visibility").
  - **Why it helped**: which bottleneck it addressed, with the metric delta from the summary.
  - **How to recognize when to apply**: signs in future code that the same pattern is needed.
  - **Anti-pattern to avoid**: what NOT to do.
  - **Verification**: which scenario + metric this affected.
- Append-only. Do not delete prior entries.

## Notes on agent behavior

- **Stay focused.** One bottleneck at a time. Resist the urge to "while I'm here also fix..." — that breaks attribution.
- **Trust the metric.** If fitness went up but you "feel" the code is better, revert anyway. The metric is the contract.
- **The perf-pass repo is your sandbox.** Inside it, you may create lanes, open chats, run automations, anything that exercises ADE. The scenarios already drive this; you may extend them ONLY by adding new scenarios in `apps/desktop/src/renderer/perf/scenarios/<tab>.ts` — never by editing existing ones.
- **Codex model only.** If a scenario invokes an in-ADE chat, that chat uses the `ADE_MODEL_OVERRIDE` model (gpt-5-codex by default). Scenarios opting into Claude must declare `requiresClaude: true` and you must set `ADE_PERF_ALLOW_CLAUDE=1` for them.
- **Concurrency**: only one perf run on the machine at a time. If `~/.ade/perf-runs/` contains a `<runId>/lock` file with a live pid, refuse to start.
