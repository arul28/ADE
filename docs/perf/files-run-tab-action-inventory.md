# Files and Run tab action inventory

This pass followed `.agents/skills/ade-autoresearch/SKILL.md` against the real
Electron ADE UI and used Codex Computer Use to click, type, scroll, and inspect
the Files and Run tabs. CDP was used for marker/setup/finalize plumbing only.
The fixture was `/Users/admin/Projects/perf pass` with roughly 1,348 tracked
files, dirty/deleted/untracked file states, 36 Run commands across five groups,
and seven lanes including nested child lanes.

## Evidence

- Files baseline: `~/.ade/perf-runs/files-ui-audit-20260513-044449/events.jsonl`
- Run baseline: `~/.ade/perf-runs/run-ui-audit-20260513-045741/events.jsonl`
- Run after fix: `~/.ade/perf-runs/run-ui-after-routing-20260513-052031/events.jsonl`

## Files coverage

| Action | Status | Notes |
| --- | --- | --- |
| Workspace menu and lane switch | measured | Switched from Primary to `UI audit lane 1 3tecsx`. |
| Tree expand and virtual scroll | measured | Expanded `src/feature-*` and scrolled the large tree. |
| Open, edit, and save file | measured | Edited a generated component file and saved it. |
| Path filter | measured | Filtered for `conflict`. |
| Changes and merge modes | measured | Opened a conflict sample and accepted ours. |
| Content search | measured | Searched `PERF_NEEDLE` across the large fixture. |
| Quick open | measured | Opened a generated component by query. |
| Context menu and theme toggle | measured | Opened tree context menu and toggled editor theme. |

Files did not show the bottleneck in this pass. `ade.files.listTree` ran 5
times with p95 `23ms` and max `27ms`; `ade.files.searchText` took `101ms` for
the large content search. No Files product change was made.

## Run coverage

| Action | Status | Notes |
| --- | --- | --- |
| Open Run tab | measured | Loaded 36 command cards from the sidebar Run link. |
| Advanced lane runtime bar | measured | Opened and idled the preview/runtime status bar. |
| Group filter | measured | Selected the API group. |
| Run and stop command | measured | Started `Perf command 02`; force-stop action was attempted after it had already exited in the baseline. |
| Lane selection | measured | Opened a command lane menu and switched to a non-primary lane. |
| Add to group | measured | Opened the menu; follow-up save path hit the config bug below. |
| New shell | measured | Opened a tracked shell terminal. |
| Add command dialog | measured | Filled and submitted a command dialog; the save-path cwd bug found during the sweep is covered by a regression test. |

## Finding

The Run tab bottleneck was in `LaneRuntimeBar`. Every runtime/health refresh
also reread the preview routing snapshot and port lease:

- Baseline overall: `ade.lanes.proxy.getPreviewInfo` ran 53 times for `2,183ms`
  total; `ade.lanes.port.getLease` ran 53 times for `2,038ms` total.
- Baseline `run.command.runSingle`: five preview reads (`201ms`) and five lease
  reads (`182ms`) rode along with a single command launch.

The fix split the lane bar refreshes:

- Health/runtime state keeps the 10s refresh and process-event refreshes.
- Routing state refreshes on mount, proxy/port events, and a 30s safety poll.

## After fix

`run-ui-after-routing-20260513-052031` kept the same fixture and real Electron
UI. In the marked command launch window:

- `ade.lanes.proxy.getPreviewInfo`: `5 -> 1` calls (`201ms -> 35ms`).
- `ade.lanes.port.getLease`: `5 -> 1` calls (`182ms -> 34ms`).
- A 35s idle window with Advanced open made one routing refresh, while cheap
  health/runtime checks continued separately.

Remaining top cost in the marked launch is `ade.processes.start` at `628ms`;
that is process startup, not the lane bar refresh loop.

## Validation

- `npm --prefix apps/desktop run test -- src/renderer/components/run/CommandCard.test.tsx src/renderer/components/run/RunPage.test.tsx`
- `npm --prefix apps/desktop run typecheck -- --pretty false`
- `npm --prefix apps/desktop run lint -- --quiet`
- `git diff --check`

## Follow-up

The Add command flow initially failed in the real UI with
`ADE_CONFIG_INVALID: effective.processes[36].cwd: Process cwd is required`
even though the dialog showed working directory `.`. The save path now preserves
`cwd: "."`; follow-up real-UI proof should re-drive the dialog in the perf
fixture before promoting this from regression-test coverage to after-fix UI
evidence.
