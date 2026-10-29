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
mergeability, GitHub stacks, merge readiness, review threads,
files, CI, and activity. Keep first paint local and defer expensive live GitHub
or Git operations until the visible surface needs them.

## Measurement posture

- Test the real Electron `/prs` route against a private `perf-pass` GitHub repo
  with enough PRs to cover single and stacked flows.
- Drive visible UI actions with Computer Use and mark important spans with
  `window.ade.perf.recordEvent({ kind: "manualStep", ... })`.
- Do not measure only one PR forever. Seed several lanes and PRs per PR
  type, then optimize the batched path users actually hit.
- Separate stale-cache/no-op refreshes from true GitHub refreshes. If the UI
  returns instantly because nothing is stale, also measure the explicit preload
  path for the PR set changed by the optimization.

## Startup and GitHub tab rules

- Opening the GitHub tab must not run conflict analysis or rebase scans. First
  paint should use local PR rows and cached GitHub snapshot data.
- Default GitHub snapshot search should fetch open external PRs only. Closed,
  merged, and all-history views may opt into external closed PR history when
  the user asks for that surface.
- Hydrate selected PR detail panes from `pull_request_snapshots` first, then run
  live GitHub calls in the background. Detail panes should not render blank while
  cached detail/files/checks/reviews/comments/commits exist.
- Keep snapshot hydration batched. Prefer `listSnapshots({ prId })` for detail
  hydration and avoid separate status/checks/reviews/comments/files calls before
  the cached view is visible.

## Lane and conflict-analysis rules

- Conflict-analysis reads should use lane metadata only:
  `laneService.list({ includeArchived: false, includeStatus: false })` unless
  the UI is explicitly displaying fresh Git status.
- PR rendering keeps lane reads status-light too. Use
  `window.ade.lanes.list({ includeStatus: false })` and fetch fresh lane Git
  status only inside flows that inspect dirty, ahead, behind, or
  rebase-in-progress state.
- The GitHub list calls `listWithConflicts()` without conflict analysis.
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
- Rebase diagnostics are not a reason to run `git fetch` on every poll. Keep
  target tracking refreshes best-effort and TTL-bound.

## Proven PRs patterns

### Keep GitHub first open-only and local-first

- **Why it helped**: The original PRs open path spent seconds fetching external
  GitHub history and doing local work before the list felt usable.
- **Apply when**: Editing `GitHubTab`, GitHub snapshot fetching, or first-load
  PR state.
- **Avoid**: Loading closed/merged external PRs or conflict analysis before the
  user opens those surfaces.
- **Verification**: `prs-ui-baseline-20260512-051124` had
  `ade.prs.getGitHubSnapshot` at `5941ms`. After the open-only snapshot and
  local-first hydration, `prs-ui-lane-metadata-fast-inproc-20260512-060555`
  showed first-load `getGitHubSnapshot` at `1146ms` and `listWithConflicts` at
  `1ms`.

### Bound explicit refresh with parallel workers

- **Why it helped**: Refreshing PRs one at a time made refresh feel stuck even
  when the UI was otherwise local-first.
- **Apply when**: Changing `prService.refresh`, refresh buttons, or explicit
  refresh actions from automations.
- **Avoid**: Serial `for await` refresh of PR detail/status/check/files for
  multiple PRs.
- **Verification**: Before parallel refresh, the measured refresh span
  had `ade.prs.refresh` at `12284ms`. After bounded parallel refresh, an
  explicit all-18 preload/IPC refresh in
  `prs-ui-lane-metadata-fast-inproc-20260512-060555` completed in `3800ms`.

### Keep PR lane reads status-light

- **Why it helped**: PR reloads paid full lane Git status even though the
  visible rows only needed lane identity, branch, and color.
- **Apply when**: Editing `PrsContext` or PR status hydration.
- **Avoid**: `window.ade.lanes.list({ includeStatus: true })` on PRs-tab
  startup or background PR refreshes that do not display lane dirty/ahead/behind
  state.
- **Verification**: In
  `prs-ui-rebase-fetch-ttl-20260512-062130`, PR reload lane reads dropped
  from `1393ms` to `47-80ms`.

### Share reads, cap concurrency, and keep what cannot change (2026-10-26)

- **Why it helped**: opening one PR on a large public repo sent 57 GitHub
  requests, 19 at once: status, checks and reviews each read the head's
  check-runs and combined status themselves, and the commit list read
  check-runs once per commit (29) for a field no desktop surface draws.
  Idle, the list was re-walked ten pages at a time every two minutes because
  a budget-cut full walk never advanced the delta cursor.
- **Apply when**: adding a GitHub read to `prService`, a timer on the PRs
  surface, or anything that fans out per commit, run or row.
- **Patterns**: join an in-flight read and reuse it for 5 s (`readCache.shared` in `prGithubReadCache.ts`);
  every request passes `acquireGithubRequestSlot` (6 in flight per process);
  keep immutable results (finished run jobs by run and attempt, settled
  older-commit checks); prefer one GraphQL read over N REST reads; treat
  background revalidation as automatic so it takes the delta walk; skip
  polling ticks while the window is hidden.
- **Verification**: see "PRs tab: GitHub requests" in
  `docs/perf/macos-baseline.md` (57 → 22 requests per open, peak 19 → 6,
  1,680 → 648 requests per idle hour).
