---
name: ade-perf-work
description: Performance and UX patterns discovered for ADE's Work tab, including chat/CLI/shell launch surfaces, the Work tools pane, Git/Files/iOS/App Control/Browser/Mac VM panels, and local-runtime-disabled perf runs. Read before editing Work tab code.
metadata:
  author: ADE
  version: 0.1.0
---

# ade-perf-work

Read this before editing Work tab surfaces:

- `apps/desktop/src/renderer/components/terminals/**`
- `apps/desktop/src/renderer/components/chat/**` when mounted from Work
- `apps/desktop/src/renderer/components/lanes/LaneGitActionsPane.tsx`
- `apps/desktop/src/renderer/components/lanes/CommitTimeline.tsx`
- `apps/desktop/src/renderer/components/files/FilesPage.tsx` when embedded
- `apps/desktop/src/preload/preload.ts`
- `apps/desktop/src/main/services/ipc/registerIpc.ts`
- Work-facing tool services for iOS Simulator, App Control, built-in browser, and macOS VM

## Measurement pattern

Use the real Work tab first. For local perf runs, reset and open the perf-pass repo:

```bash
scripts/reset-perf-pass.sh
NO_DEVTOOLS=1 ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1 ADE_LOCAL_RUNTIME_FALLBACK=1 ADE_MODEL_OVERRIDE=gpt-5-codex \
  node scripts/perf-launch.mjs --tab work --run-id work-ui-audit-<date>-<n>
```

Drive actual Work UI actions and record `work.audit.*` markers for:

- session search/filter, tab/grid, Chat/CLI/Shell mode switches
- model picker, attachment picker, slash command picker, parallel model configuration
- Work tools pane open/close
- Git: status, More menu, history refresh, diff selection
- Files: mount and path filtering
- iOS Sim, App Control, Browser, Mac VM panel mounts

Fixed scenario files are optional evidence. The important proof is a UI-derived run over `~/.ade/perf-runs/<runId>/events.jsonl` plus focused tests for any fixed behavior.

## Current known wins

### Skip the local runtime bridge when the local daemon is disabled

In Work perf runs with `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`, the preload bridge must not try `ade.localRuntime.callAction`, `ade.localRuntime.callSync`, or `ade.localRuntime.streamEvents` for local project bindings.

Measured Work cold run:

- Before: `67` failed `ade.localRuntime.*` IPC calls, `19,427ms` aggregate failed IPC time.
- After: `0` failed `ade.localRuntime.*` IPC calls.

Keep the preload guard in `apps/desktop/src/preload/preload.ts` intact. If changing project binding or remote runtime event pump logic, re-run a local-runtime-disabled Work audit and confirm local runtime IPC remains zero.

### Fast-path sync status when the local runtime daemon is disabled

`ade.sync.getStatus` is called during Work startup and periodically from shell chrome. In local-runtime-disabled runs it must not spawn the disabled runtime or fail before falling back.

Measured Work run:

- Before sync fix: `ade.sync.getStatus` failed and consumed `606ms` across two calls in the startup window.
- After: the same status path returned successfully in `0-1ms`.

Keep the unavailable sync snapshot in `apps/desktop/src/main/services/ipc/registerIpc.ts`. It is a perf-mode/status fallback, not a replacement for real sync service behavior.

### Work tools pane must remain operable when narrow

The Work tools pane can be narrow after the session list, chat surface, and tools pane are all visible. Do not assume all tab labels fit. The tab strip should collapse to icon buttons under narrow widths while preserving `aria-label`, tooltips, and stable hit targets.

Measured UI pass after compact tabs:

- Git, Files, iOS Sim, App Control, Browser, and Mac VM tabs were all visible and clickable in the narrow tools pane.
- No tools tab had a bounding rect beyond the renderer viewport.

If changing `WorkSidebar`, verify with a small Work pane and a larger audit window. The target is no clipped or unreachable tool tabs, not merely no TypeScript errors.

### Missing lane worktrees are lane state, not raw Git errors

The perf-pass repo can contain lane records and branches while the physical `.ade/worktrees/<lane>` directory is missing. The Git history panel previously surfaced raw messages like `git working directory not found: ...` through Electron IPC.

Work UI should show an operational lane-state message:

```text
Lane worktree is missing. Restore or recreate the lane worktree at <path> before viewing history.
```

Do not expose the raw `Error invoking remote method ...` prefix in Work Git history. When reproducing, remove a lane worktree directory from perf-pass, open Work > Git > History, and refresh.

## Watch list

- `ade.github.getStatus` remains the largest Work startup IPC in measured runs, around `630-700ms`. Treat it as the next likely target, but verify whether it is shell-wide status work or Git-pane-specific before changing it.
- Browser panel mount creates built-in browser tabs and can cost about `400-500ms` per tab creation in UI probes. Optimize only after checking that tab reuse and hidden WebContentsView bounds behavior remain correct.
- iOS Simulator and macOS VM status calls are visible costs when those panels mount. Keep them lazy to the active tools tab.
- Avoid hidden panel polling. App Control, iOS Simulator, Browser, and Mac VM should subscribe or poll only while their tab is active, unless a feature explicitly needs background state.
