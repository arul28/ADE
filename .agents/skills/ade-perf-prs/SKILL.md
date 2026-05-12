---
name: ade-perf-prs
description: Performance practices for ADE's PRs tab. Read before editing
  files under apps/desktop/src/renderer/components/prs/**,
  apps/desktop/src/main/services/prs/**, PR IPC/preload contracts, or
  PR-facing ADE actions. Preserve these patterns unless a new measured PRs UI
  audit proves a better one.
metadata:
  author: ade-autoresearch
  version: 0.1.0
  status: active
---

# ade-perf-prs

Use this as engineering guidance for keeping the PRs tab fast while adding
features. The PRs tab combines external GitHub search, local lane links,
mergeability, queue/integration workflows, Path to Merge state, review threads,
files, CI, and activity. Keep first paint local and defer expensive live GitHub
or Git operations until the visible surface needs them.

## Measurement posture

- Test the real Electron `/prs` route against a private `perf-pass` GitHub repo
  with enough PRs to cover single, queue, integration, and rebase/merge flows.
- Drive visible UI actions with Computer Use and mark important spans with
  `window.ade.perf.recordEvent({ kind: "manualStep", ... })`.
- Do not measure only one PR forever. Seed several lanes and PRs per workflow
  type, then optimize the batched path users actually hit.
- Separate stale-cache/no-op refreshes from true GitHub refreshes. If the UI
  returns instantly because nothing is stale, also measure the explicit preload
  path for the PR set changed by the optimization.

## Startup and GitHub tab rules

- Opening the GitHub tab must not run conflict analysis, rebase scans, or
  per-PR merge-context calls. First paint should use local PR rows and cached
  GitHub snapshot data.
- Default GitHub snapshot search should fetch open external PRs only. Closed,
  merged, and all-history views may opt into external closed PR history when
  the user asks for that surface.
- Hydrate selected PR detail panes from `pull_request_snapshots` first, then run
  live GitHub calls in the background. Detail panes should not render blank while
  cached detail/files/checks/reviews/comments/commits exist.
- Keep snapshot hydration batched. Prefer `listSnapshots({ prId })` for detail
  hydration and avoid separate status/checks/reviews/comments/files calls before
  the cached view is visible.

## Workflow and merge-context rules

- Use bulk merge-context APIs for workflow surfaces. `getMergeContexts(prIds)`
  should replace N calls to `getMergeContext(prId)` whenever a queue,
  integration, or rebase/merge view renders multiple PRs.
- Merge-context and conflict-analysis reads should use lane metadata only:
  `laneService.list({ includeArchived: false, includeStatus: false })` unless
  the UI is explicitly displaying fresh Git status.
- PR workflow context should also keep lane reads status-light. Use
  `window.ade.lanes.list({ includeStatus: false })` for workflow rendering and
  fetch fresh lane Git status only inside flows that actually inspect dirty,
  ahead, behind, or rebase-in-progress state.
- The normal GitHub list should call `listWithConflicts({ includeConflictAnalysis: false })`.
  Queue, integration, and rebase/merge workflows may request conflict analysis
  because their UI depends on it.
- `listWithConflicts` must batch conflict assessment with lane inputs instead of
  asking the conflict service one PR at a time.

## Refresh rules

- Explicit PR refreshes should be bounded and parallel, not serialized one PR at
  a time. Keep a conservative concurrency limit so GitHub is used efficiently
  without flooding the API.
- Background refresh should stay small and stale-aware. The no-argument refresh
  path is for hot or stale candidates, not a reason to sync every PR on every
  tab open.
- Do not reintroduce "syncing to GitHub" as a blocking first-open state. The tab
  should remain usable while refreshes run.
- Rebase diagnostics are useful workflow data, but they are not a reason to run
  queue-target `git fetch` on every poll. Keep queue target tracking refreshes
  best-effort and TTL-bound.

## Proven PRs patterns

### Keep GitHub first open-only and local-first

- **Why it helped**: The original PRs open path spent seconds fetching external
  GitHub history and doing local workflow work before the list felt usable.
- **Apply when**: Editing `GitHubTab`, GitHub snapshot fetching, or first-load
  PR state.
- **Avoid**: Loading closed/merged external PRs or conflict analysis before the
  user opens those surfaces.
- **Verification**: `prs-ui-baseline-20260512-051124` had
  `ade.prs.getGitHubSnapshot` at `5941ms`. After the open-only snapshot and
  local-first hydration, `prs-ui-lane-metadata-fast-inproc-20260512-060555`
  showed first-load `getGitHubSnapshot` at `1146ms`, `listWithConflicts` at
  `1ms`, and `getMergeContexts` at `52ms`.

### Batch merge contexts and keep lane reads metadata-only

- **Why it helped**: Workflow pages previously fanned out merge-context calls
  and each one could pay for lane status work.
- **Apply when**: Queue, integration, rebase/merge, or Path to Merge surfaces
  need per-PR merge context.
- **Avoid**: Looping over `getMergeContext` or using bare `laneService.list()`
  from merge-context helpers.
- **Verification**: In `prs-ui-lane-metadata-fast-inproc-20260512-060555`,
  workflow `getMergeContexts` calls measured `28-72ms`; the prior workflow pass
  had repeated merge-context batches around `1.2-1.4s`.

### Bound explicit refresh with parallel workers

- **Why it helped**: Refreshing PRs one at a time made workflow refresh feel
  stuck even when the UI was otherwise local-first.
- **Apply when**: Changing `prService.refresh`, refresh buttons, or explicit
  refresh actions from automations.
- **Avoid**: Serial `for await` refresh of PR detail/status/check/files for
  multiple PRs.
- **Verification**: Before parallel refresh, the measured workflow refresh span
  had `ade.prs.refresh` at `12284ms`. After bounded parallel refresh, an
  explicit all-18 preload/IPC refresh in
  `prs-ui-lane-metadata-fast-inproc-20260512-060555` completed in `3800ms`.

### Keep workflow lane reads status-light

- **Why it helped**: Queue workflow reloads still paid full lane Git status and
  auto-rebase status cleanup even though the visible workflow cards only needed
  lane identity, branch, color, queue state, rebase needs, and merge context.
- **Apply when**: Editing `PrsContext`, workflow tabs, or auto-rebase status
  hydration for PRs.
- **Avoid**: `window.ade.lanes.list({ includeStatus: true })` on PR workflow
  startup or background PR refreshes that do not display lane dirty/ahead/behind
  state.
- **Verification**: In
  `prs-ui-rebase-fetch-ttl-20260512-062130`, queue reload lane reads dropped
  from `1393ms` to `47-80ms`, and `listAutoRebaseStatuses` dropped from
  `1404-1407ms` to `40-70ms`.

### Keep Path to Merge start/stop local and state-first

- **Why it helped**: Path to Merge controls should react to local pipeline
  settings, convergence state, and issue inventory without waiting on a full PR
  refresh or workflow sweep.
- **Apply when**: Editing `PrConvergencePanel`, pipeline settings, issue
  inventory sync, or Path to Merge IPC.
- **Avoid**: Coupling the start/stop buttons to fresh detail hydration, merge
  context fan-out, or agent dispatch prework that can run after the local state
  transition.
- **Verification**: In `prs-ui-ptm-audit-20260512-0635`, with PLAN mode and
  auto-merge off, the UI covered native Path to Merge start/stop safely:
  `ade.prs.pathToMerge.start` completed in `5ms` and
  `ade.prs.pathToMerge.stop` completed in `2ms`.
