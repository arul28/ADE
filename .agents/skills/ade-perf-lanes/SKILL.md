---
name: ade-perf-lanes
description: Performance practices for ADE's Lanes tab. Read before editing
  files under apps/desktop/src/renderer/components/lanes/**,
  apps/desktop/src/renderer/state/appStore.ts, or
  apps/desktop/src/main/services/lanes/**. Preserve these patterns unless a new
  measured UI audit proves a better one.
metadata:
  author: ade-autoresearch
  version: 0.2.1
  status: active
---

# ade-perf-lanes

Use this as engineering guidance for keeping the Lanes tab fast while adding features. The Lanes tab is a dense workspace: lane list, branch selector, stack graph, Work pane, Git Actions, dialogs, history, diff viewer, and runtime/session state all coexist. Small refresh choices can easily multiply into visible UI noise.

## Testing posture

- Test the actual `/lanes` route in the Electron dev app. Do not treat the Work tab with a lane selector as Lanes parity.
- Drive visible UI actions and mark each segment with `window.ade.perf.recordEvent({ kind: "manualStep", ... })`. Deterministic scenarios are regression guards, not a substitute for clicking through the tab.
- Keep a private `perf-pass` GitHub repo available for real fetch/push/pull behavior. It is safe to create throwaway lanes, commits, stashes, and branches there.
- When an action is destructive or externally visible, exercise the prompt/preflight by default. Execute the final action only when the user has allowed it or the target is clearly disposable.

## Refresh rules

- Use full decorated snapshots only when runtime decorations, conflict status, rebase suggestions, or auto-rebase state are truly needed.
- For Git Actions local operations such as stage, commit, fetch, push, pull, and history refresh, prefer `refreshLanes({ includeStatus: true, includeSnapshots: false })`. This updates lane Git status without rebuilding runtime/rebase/conflict snapshot decorations.
- For runtime-only updates from Work pane sessions, use `refreshLanes({ includeStatus: false, includeSnapshots: true, includeConflictStatus: false, includeRebaseSuggestions: false, includeAutoRebaseStatus: false })`. Preserve prior lane Git status while refreshing runtime buckets.
- For metadata-only updates such as lane color/appearance, use `refreshLanes({ includeStatus: false })` and preserve prior `status` / `parentStatus` in the store. A color change must not recompute Git status.
- Avoid calling bare `refreshLanes()` from new Lanes UI handlers. Treat it as the expensive path and document why a full refresh is required.

## Pane and poller rules

- Expanded/fullscreen panes must unmount the corresponding inline pane body when the duplicate would keep effects alive. CSS hiding is not enough.
- Git Actions should have at most one active polling/effect owner per visible lane. Timers must clean up on lane switch, pane minimize, and fullscreen transitions.
- Poll only visible or active surfaces. Hidden lanes, hidden panes, minimized panes, and closed dialogs should not keep expensive Git, PR, Linear, AI, or runtime status requests alive.
- Background sync/local-runtime failures should be fast-pathed in disabled perf/dev modes at the IPC boundary. Do not make every renderer caller catch slow "service unavailable" failures.
- Presence updates should be idempotent and de-duped by lane/signature so filter changes, layout switches, and tab clicks do not spam sync IPC.

## Dialog and menu rules

- Fetch heavy dialog data on open, not on page load. Branch lists, Linear issues, unregistered worktrees, delete-risk preflights, and PR metadata should be lazy and cancelable.
- Do not precompute delete, rebase, merge, force-push, or cherry-pick risk for every lane. Compute it only when the user opens that flow.
- Color/appearance changes should update cheaply. They are not a reason to rebuild snapshots or rerun Git status.
- Create-lane flows may be expensive because they create worktrees and initialize environment state. Keep that cost isolated to submit; opening and editing the dialog should stay light.

## Git Actions rules

- Keep local change operations scoped. Stage, unstage, commit, stash, and discard should refresh the active lane's change model and lane Git status, not all snapshot decorations.
- History and diff controls should fetch only the selected commit/file data. Split/unified, wrap, line-number, and copy-path controls should be renderer-local after the file/patch is loaded.
- Network actions are allowed to cost real time. `fetch`, `push`, and child-lane creation can dominate a trace; do not optimize them by hiding progress or skipping correctness checks.
- Save Changes currently stashes tracked changes and can leave untracked files visible. If changing that behavior, treat it as functionality work and add tests before using it as a perf cleanup.

## Proven patterns

### Skip disabled local runtime bridge calls
- **Why it helped**: When `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`, preload still attempted local-runtime action/sync/event IPC before falling back to desktop IPC. Real `/lanes` runs showed slow `ade.localRuntime.*` spans and `lanes.idle-at-rest` hit V8 OOM before summary.
- **Apply when**: Perf/dev launches disable the daemon but traces show slow `ade.localRuntime.callAction`, `ade.localRuntime.callSync`, or `ade.localRuntime.streamEvents`.
- **Avoid**: Renderer-only caches that hide the symptom while the unavailable transport still burns time.
- **Verification**: Baseline `lanes-20260511-1721-real-baseline-*` had local-runtime slow channels and idle OOM. Post-change `lanes-20260511-1725-real-optimized-{cold,switch,idle,scroll,stress}` passed with total fitness `7028.82` and no `ade.localRuntime.*` channels.

### Suppress hidden duplicate fullscreen pane bodies
- **Why it helped**: Expanding Git Actions mounted the fullscreen pane while leaving the inline `LaneGitActionsPane` body alive, producing duplicate toolbars and duplicated effects.
- **Apply when**: A Lanes expanded/fullscreen overlay reuses pane configs and a DOM snapshot shows duplicate pane bodies or repeated test regions while only one is visible.
- **Avoid**: CSS-only hiding for duplicate pane bodies.
- **Verification**: Git Actions expand went from 2 toolbars to 1. IPC dropped from 30 calls / 223 ms in `lanes-expand-prefix-20260511` to 29 calls / 192 ms in `lanes-expand-postfix-20260511`.

### Fast-path disabled sync status and presence
- **Why it helped**: Perf-mode Lanes traces hit `ade.sync.getStatus` and `ade.sync.setActiveLanePresence` even though the local runtime daemon and in-process sync service were unavailable. Failed calls cost about 250-370 ms each.
- **Apply when**: `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1` and traces show failed `ade.sync.*` calls with "Sync service is not available."
- **Avoid**: Removing Lanes presence calls globally or catching every failure in the renderer.
- **Verification**: `lanes-expand-postfix-20260511` had 4 failed sync IPC calls totaling 1145 ms. `lanes-sync-postfix-20260511` had 3 successful sync IPC calls totaling 2 ms.

### Scope Git Actions refreshes to lane status
- **Why it helped**: Stage/commit/fetch used to call full `listSnapshots`, rebuilding runtime and decoration state for local Git actions. The scoped path keeps status fresh and skips snapshot decorations.
- **Apply when**: A Git Actions handler finishes local Git work and calls bare `refreshLanes()`.
- **Avoid**: Recomputing runtime/rebase/conflict decorations after every stage, commit, stash, fetch, or history refresh.
- **Verification**: Before the change, `lanes-full-ui-audit-20260511-01` stage cycle spent 551 ms in `ade.lanes.listSnapshots`; commit spent 278 ms in `listSnapshots`. After the change, `lanes-refresh-light-20260511` stage used `ade.lanes.list` at 40 ms with no `listSnapshots`, and typed commit used `ade.lanes.list` at 213 ms with no `listSnapshots`.

### Split runtime refresh from Git status refresh
- **Why it helped**: Work pane pty/chat updates need runtime buckets, not fresh Git status for every lane. Runtime-only snapshot refresh avoids Git-status recompute while preserving prior status in store.
- **Apply when**: A session/runtime event updates running/awaiting/ended counts.
- **Avoid**: Calling full snapshots with `includeStatus:true` for runtime-only changes.
- **Verification**: `lanes-refresh-light-20260511` runtime snapshot refresh used `ade.lanes.listSnapshots` with `includeStatus:false`; the only runtime snapshot call was 76 ms while prior Git status stayed intact.

### Keep appearance refresh metadata-only
- **Why it helped**: Lane color changes in manage/context flows previously refreshed full decorated snapshots. Appearance is metadata and should use the statusless list path while preserving previous Git status in the store.
- **Apply when**: New lane metadata or appearance handlers update color/name/description without changing branch state.
- **Avoid**: Bare `refreshLanes()` after appearance-only updates.
- **Verification**: Real UI manage-dialog trace `lanes-refresh-light-20260511` showed `ade.lanes.updateAppearance` at 1 ms followed by an unnecessary `ade.lanes.listSnapshots` at 308 ms. The lightweight path uses `refreshLanes({ includeStatus: false })` instead.

### Gate Stack Graph agent rosters behind visibility
- **Why it helped**: Lanes loaded per-lane agent rosters even while Stack Graph was closed. With 30 lanes, initial `/lanes` load fanned out `agentChat.list({ laneId })` and `sessions.list({ laneId })` for every lane before the user opened the graph.
- **Apply when**: A closed Lanes surface computes per-lane chat/session/agent data that is only rendered inside Stack Graph.
- **Avoid**: Fetching every lane's agent roster on page load to keep a closed dropdown warm.
- **Verification**: `lanes-20260531-1421-baseline` Lanes nav spent 87 `ade.localRuntime.callAction` calls / 25.3 s total IPC time. After gating rosters until Stack Graph opens, `lanes-20260531-1421-after1` dropped Lanes nav to 28 `callAction` calls / 13.3 s. Stack Graph then paid the roster cost on demand: 63 calls / 450 ms in the open segment.

### Filter chat session lists before applying caps
- **Why it helped**: `agentChat.listSessions()` loaded the newest 500 terminal sessions and then filtered to chat rows. Many newer CLI or shell sessions could push older chats out of the capped result, making chat panes look empty or stale even though persisted chats existed.
- **Apply when**: A session list is intended to show a specific tool family, provider, or surface and the underlying table also stores high-volume shell/run-owned sessions.
- **Avoid**: Applying a global `limit` before the meaningful filter, or widening limits as a substitute for the right query.
- **Verification**: `fix(chat): filter chat session lists before caps` adds `toolTypes` to `sessionService.list`, uses it from `agentChatService.listSessions`, preserves legacy chat rows inferred from resume commands, and covers a regression with 505 newer shell sessions hiding an older chat.
