# Terminals and Sessions

PTY-backed terminal sessions plus agent chat sessions, both tracked through a
single `terminal_sessions` row and surfaced in the Work view, lane panels, and
the Sessions sidebar. The session model is the backbone for transcripts,
deltas, lane association, and resume flows.

The main-process services for this feature are large and have been repeatedly
rewritten: `ptyService.ts`, `sessionService.ts`, and `processService.ts`.
Treat them as fragile and re-read whenever wiring changes.

`processService` keeps one runtime record per *invocation*, not per
(lane, process) pair. A single `ProcessDefinition` can have many concurrent
or historical `ProcessRuntime` rows in memory, each identified by `runId`. The
Run page renders those runs on a single card and the aggregate persisted
snapshot (the most recent run) is what lives in the `process_runtime` table.

## Source file map

Main process:

- `apps/desktop/src/main/services/pty/ptyService.ts` — PTY lifecycle,
  transcript capture, runtime state, AI auto-titles, tool-type routing,
  resume backfill. ~1,500 lines. Branch rewrite.
- `apps/desktop/src/main/services/pty/ptyService.test.ts` — PTY behavior
  tests. Branch updated.
- `apps/desktop/src/main/services/sessions/sessionService.ts` — persistence
  layer for `terminal_sessions` rows. CRUD, resume metadata normalization,
  `reattach`, `reconcileStaleRunningSessions`. ~580 lines. Branch rewrite.
- `apps/desktop/src/main/services/sessions/sessionService.test.ts` —
  session persistence tests.
- `apps/desktop/src/main/services/sessions/sessionDeltaService.ts` —
  end-of-session git diff + transcript delta computation, reads from
  `session_deltas` table.
- `apps/desktop/src/main/services/processes/processService.ts` — managed
  process lifecycle keyed by `runId` (multi-run history per
  `(laneId, processId)`), readiness checks, restart policy with
  exponential backoff, stack buttons, process-group filtering. ~870 lines.
- `apps/desktop/src/main/services/processes/processService.test.ts` —
  managed process tests.
- `apps/desktop/src/main/services/lanes/laneLaunchContext.ts` —
  per-lane cwd resolution that gates PTY creation to the lane worktree.

Shared types and IPC:

- `apps/desktop/src/shared/types/sessions.ts` — `TerminalSessionSummary`,
  `TerminalSessionStatus`, `TerminalToolType`, `TerminalRuntimeState`,
  `TerminalResumeMetadata`, `PtyCreateArgs`, `SessionDeltaSummary`.
- `apps/desktop/src/shared/types/config.ts` — `ProcessDefinition`
  (now carries `groupIds: string[]`), `ProcessGroupDefinition`,
  `ProcessRuntime` (now carries `runId`), `ProcessRuntimeStatus`,
  `ProcessReadinessConfig`, `StackButtonDefinition`,
  `ProcessRestartPolicy`. `ProcessActionArgs` and
  `GetProcessLogTailArgs` accept an optional `runId`.
- `apps/desktop/src/shared/ipc.ts` — channels `ade.sessions.*`,
  `ade.pty.*`, `ade.processes.*`.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.sessions`,
  `window.ade.pty`, `window.ade.processes` APIs.

IPC registration:

- `apps/desktop/src/main/services/ipc/registerIpc.ts` — registers
  `sessionsList`, `sessionsGet`, `sessionsUpdateMeta`,
  `sessionsReadTranscriptTail`, `sessionsGetDelta`, `ptyCreate`,
  `ptyWrite`, `ptyResize`, `ptyDispose`, and the `processes.*` handlers.

Renderer surfaces:

- `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` —
  entry surface with `PaneTilingLayout` (sessions list + work view).
  Owns the multi-select state (`selectedSessionIds`, shift/ctrl anchor,
  bulk close and bulk delete handlers) that the sidebar forwards into.
- `apps/desktop/src/renderer/components/terminals/SessionListPane.tsx` —
  sidebar list with three organization modes (lane / status / time),
  sticky group headers, search/filter. Renders a bulk action bar at the
  bottom when sessions are multi-selected (Close N running / Delete N
  ended / clear selection).
- `apps/desktop/src/renderer/components/terminals/SessionCard.tsx` —
  per-session card (status dot, title, preview line, tool type, lane,
  delta chips). Surfaces a small amber warning pip next to the title
  when `getStaleRunningCliSessionAgeHours` returns a value, so users
  can spot long-running CLI/shell sessions without opening them. The
  card also reports its multi-select state via `isMultiSelected`.
- `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx` —
  tabs/grid/single Work view. The grid mode renders through the shared
  `PaneTilingLayout`; the seed tree comes from `buildWorkSessionTilingTree`.
- `apps/desktop/src/renderer/components/terminals/WorkStartSurface.tsx` —
  empty-state "start new chat / terminal" surface.
- `apps/desktop/src/renderer/components/terminals/TerminalView.tsx` —
  xterm.js wrapper; WebGL renderer with DOM fallback, fit retries, health
  counters.
- `apps/desktop/src/renderer/components/terminals/workSessionTiling.ts` —
  pure helper that produces the seed `PaneSplit` for the Work grid from
  an ordered list of session IDs (single-column for ≤1 session, single
  row when `ceil(sqrt(n)) == n`, otherwise a vertical stack of horizontal
  rows with counts distributed by `rowSizes`).
- `apps/desktop/src/renderer/components/ui/PaneTilingLayout.tsx` +
  `paneTreeOps.ts` — recursive pane tree component + pure operations
  (`reconcilePaneTree`, `splitPaneAtEdge`, `swapPanes`, `removePaneFromTree`,
  `detectDropEdge`) shared by every tiled surface, including the Work grid.
- `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts` —
  hook that owns work view state (open items, active tab, draft kind,
  view mode, filters) and persists it to `localStorage` under
  `ade.workViewState.v1`. Invalidates the shared session-list cache
  and schedules a background refresh on window focus /
  `visibilitychange` and on chat events, so returning to Work after a
  tab switch always renders the current session set.
- `apps/desktop/src/renderer/components/terminals/useSessionDelta.ts` —
  fetches `SessionDeltaSummary` for a given session.
- `apps/desktop/src/renderer/components/terminals/cliLaunch.ts` —
  builds Claude/Codex CLI command strings with permission and sandbox
  flags.
- `apps/desktop/src/renderer/components/terminals/SessionContextMenu.tsx`
  and `SessionInfoPopover.tsx` — right-click actions and info overlay.
  Ended chat sessions get an additional "Delete chat" action wired to
  `ade.agentChat.delete`.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` — shared renderer
  cache for `ade.sessions.list` calls, keyed by `projectRoot/laneId/status`.
- `apps/desktop/src/renderer/lib/sessions.ts` — session-label helpers
  plus `getStaleRunningCliSessionAgeHours`, the canonical check that
  returns a rounded age in hours when a non-run, non-chat session has
  been `running` for at least `STALE_RUNNING_CLI_SESSION_MS` (12 h).
  Used by both `SessionCard` (inline pip) and `AppShell` (stale-CLI
  toast).

## Detail docs

- [pty-and-processes.md](./pty-and-processes.md) — lifecycle, tool-type
  detection, transcript and preview handling, auto-titles, resume
  backfill, stale reconciliation. Covers the branch-heavy main-process
  code.
- [ui-surfaces.md](./ui-surfaces.md) — the renderer surfaces:
  `TerminalsPage`, `SessionListPane`, `WorkViewArea` (including the
  `PaneTilingLayout`-backed grid mode), `WorkStartSurface`,
  `TerminalView`, and state hooks.
- [runtime-isolation.md](./runtime-isolation.md) — how a session stays
  bound to a single lane worktree and a single mission/run context.

## Session model

A session is a row in `terminal_sessions` (SQLite via `AdeDb`). The same
schema is used for:

- interactive shell PTYs (`toolType = "shell"`)
- managed processes launched by `processService` (`toolType = "run-shell"`)
- CLI agent terminals (`claude`, `codex`, `claude-orchestrated`,
  `codex-orchestrated`, `opencode-orchestrated`)
- agent chat sessions that run through the Claude/Codex SDKs rather than
  a PTY (`claude-chat`, `codex-chat`, `opencode-chat`)
- other tracked tools (`cursor`, `aider`, `continue`, `other`)

Status transitions: `running` → `completed` | `failed` | `disposed`.

Fields that feed UI and downstream systems:

- identity: `id`, `laneId`, `laneName`, `ptyId`, `tracked`, `pinned`,
  `manuallyNamed`
- title and intent: `title`, `goal`, `toolType`
- lifecycle: `status`, `startedAt`, `endedAt`, `exitCode`, `runtimeState`
  (derived), `chatIdleSinceAt`
- content: `transcriptPath`, `lastOutputPreview`, `summary`
- git anchoring: `headShaStart`, `headShaEnd` (used by
  `sessionDeltaService`)
- resume: `resumeCommand`, `resumeMetadata` (provider, target kind,
  target ID, launch config)

See `apps/desktop/src/shared/types/sessions.ts` for the full shape.

## Session lifecycle

1. **Create** — `ptyService.create()` resolves the lane worktree via
   `resolveLaneLaunchContext`, allocates `ptyId` and `sessionId`
   (or reuses an existing ID on resume), opens a transcript stream,
   spawns the shell or direct command, and inserts a
   `terminal_sessions` row through `sessionService.create()`.

2. **Stream** — PTY `data` events are written to the transcript
   (capped at `MAX_TRANSCRIPT_BYTES = 8 MB`), throttled into a
   `lastOutputPreview`, forwarded to `broadcastData`, and scanned for
   runtime state signals (OSC 133 prompt markers).

3. **Tag** — the tool type is inferred or passed by the renderer.
   Claude/Codex sessions also get a best-effort `--session-id` extraction
   so resume works after the CLI itself assigns an ID.

4. **Auto-title** — after 6 seconds (`PTY_AI_TITLE_DEBOUNCE_MS`) the
   service may summarize the early output into a short title via the AI
   integration service. For Claude/Codex it prefers the first submitted
   user line (`tryCliUserTitleFromWrite`) because the TUI hides useful
   text in the alternate screen.

5. **End** — on PTY exit, `sessionService.end()` finalizes `endedAt`,
   `exitCode`, and `status`. The transcript stream is flushed, then:
   - `backfillResumeTargetFromTranscriptBestEffort` tries to recover a
     Claude/Codex session UUID from transcript output or from Claude/Codex
     local JSONL storage.
   - `summarizeSessionBestEffort` generates an optional end-of-session
     summary and, when `refreshOnComplete` is enabled, regenerates the
     title from the transcript tail.
   - `sessionDeltaService` can compute file-level git deltas using
     `headShaStart`/`headShaEnd`.

6. **Reattach** — `sessionService.reattach()` reuses an existing session
   row when a user clicks "resume" and the PTY service opens the
   transcript in append mode. This keeps identity, lane association, and
   transcript history intact.

7. **Reconcile** — on startup, `reconcileStaleRunningSessions` marks
   orphaned `running` rows as `disposed`. The service still accepts an
   `excludeToolTypes` option, but `main.ts` no longer passes chat tool
   types: chat runtimes always warm up afresh on app start, so leaving
   stale `running` chat rows behind only causes UI confusion. Ended
   chat sessions stay in the table and are resumable through the SDK
   (or removable via `ade.agentChat.delete`).

8. **Delete** — `sessionService.deleteSession(sessionId)` removes a
   row outright and emits `terminalSessionChanged` with
   `reason: "deleted"` so renderer caches drop it immediately.
   `agentChatService.deleteSession` wraps this for chat rows: it
   disposes a live runtime, cancels the pending turn collector,
   rejects outstanding input waiters, deletes the persisted JSON and
   transcript (path-safe under `.ade/`), and then calls the session
   service. PTY rows use the same `deleteSession` as their deletion
   primitive.

## Hot paths worth knowing

- **Session list cache** — the renderer shares `listSessionsCached()`
  (`sessionListCache.ts`) across Work, lanes, graph, and top-bar
  attention. Invalidate it when a new session is created outside the
  normal paths.
- **Refresh-before-activate** — every surface that creates or opens a
  session awaits `refresh()` before activating a tab, so
  `sessionsById.get(activeItemId)` resolves on the first render.
- **Runtime isolation** — `resolveLaneLaunchContext` is the single gate
  that converts a `laneId` + optional `cwd` into a real directory inside
  the lane worktree. Bypass it and you risk launching a session in the
  wrong worktree. See [runtime-isolation.md](./runtime-isolation.md).
- **Work view state persistence** — the Work tab persists per-project
  UI state (open items, filters, collapsed groups, focus-hidden flag)
  to `localStorage` under `ade.workViewState.v1`. Lane-scoped state
  uses a composite `projectRoot::laneId` key.

## IPC surface summary

Sessions:

| Channel | Purpose |
|---|---|
| `ade.sessions.list` | list by lane/status; cached at renderer |
| `ade.sessions.get` | single session detail including runtime state |
| `ade.sessions.updateMeta` | rename (sets `manuallyNamed`), pin, edit goal, update resume metadata |
| `ade.sessions.delete` | remove a row outright; emits `terminalSessionChanged` with `reason: "deleted"` |
| `ade.sessions.readTranscriptTail` | tail bytes of transcript (raw or ANSI-stripped) |
| `ade.sessions.getDelta` | `SessionDeltaSummary` |
| `ade.sessions.changed` (event) | fired on meta updates and deletions (`reason: "meta-updated" \| "deleted"`) |
| `ade.agentChat.delete` | delete a chat session: disposes the runtime, resolves waiters, wipes persisted JSON + transcript, then calls `sessions.delete` |

PTY:

| Channel | Purpose |
|---|---|
| `ade.pty.create` | create or reattach; returns `{ ptyId, sessionId, pid }` |
| `ade.pty.write` | write bytes to PTY |
| `ade.pty.resize` | cols/rows resize |
| `ade.pty.dispose` | close PTY; optional `sessionId` used for logging |
| `ade.pty.data` (event) | stream stdout/stderr to the renderer |
| `ade.pty.exit` (event) | final exit code |

Processes (managed):

| Channel | Purpose |
|---|---|
| `ade.processes.listDefinitions` | read from project config |
| `ade.processes.listRuntime` | every in-memory run for the lane (one entry per `runId`, including recent stopped/crashed ones up to the 20-run history cap) |
| `ade.processes.start` | lifecycle; always returns the new `ProcessRuntime` |
| `ade.processes.stop` / `ade.processes.kill` | returns the targeted `ProcessRuntime`, or `null` when no active run exists for the `(laneId, processId[, runId])` tuple |
| `ade.processes.restart` | stop active runs, wait for exit (up to 10 s), start a new run |
| `ade.processes.startStack` / `stopStack` / `restartStack` | stack buttons |
| `ade.processes.startAll` / `stopAll` | bulk ops |
| `ade.processes.getLogTail` | transcript tail for the focused run (pass `runId` to target a specific invocation) |
| `ade.processes.event` (event) | `runtime` events carrying a `ProcessRuntime` with `runId`, and `log` events carrying `runId` + `laneId` + `processId` |

## Gotchas

- Chat sessions backed by the Claude/Codex SDK still insert a
  `terminal_sessions` row but they are not attached to a PTY. Guard
  UI code with `isChatToolType(toolType)` before calling PTY-only APIs.
- `processes.stop` / `processes.kill` resolve to `null` when nothing
  matches the caller's `(laneId, processId[, runId])`. Don't treat a
  null return as a failure — it just means there was no active run to
  act on. Callers that need a sync confirmation should subscribe to
  the `runtime` event instead.
- `reconcileStaleRunningSessions` accepts `excludeToolTypes` but the
  main-process startup no longer excludes chat tool types — stale
  `running` chat rows are swept to `disposed` like any other orphaned
  row. If you need a row to survive reconciliation, the caller has to
  pass `excludeToolTypes` explicitly.
- `transcriptPath` may be blank for untracked sessions (tracked=false)
  and for processes that died before their PTY opened — always
  null-check before reading.
- `resumeCommand` is derived from `resumeMetadata` when present, then
  falls back to `defaultResumeCommandForTool(toolType)`. Editing it
  directly is only allowed through `sessionService.setResumeCommand` or
  `updateMeta`, both of which re-derive the metadata.
- Transcript writes are capped at 8 MB; after the cap a notice line is
  written once and further output is dropped. The runtime counter
  `transcriptBytesWritten` is not persisted.
- Preview updates are throttled (~900 ms) and the string is capped at
  220 chars via `derivePreviewFromChunk`.
- `PaneTilingLayout` mounts every leaf pane in the Work grid; each
  `SessionSurface` still passes `terminalVisible={true}` for grid tiles
  because the tiling layout keeps them on screen. Do not unmount a grid
  leaf just because it is inactive — the PTY will detach. The tiling
  tree for the Work grid is persisted per `(projectRoot, laneId)` under
  the `work:grid:tiling:v1:` key family (via `window.ade.tilingTree`),
  and legacy `work:grid:v2:*` layouts are intentionally ignored — a new
  tree is seeded from `buildWorkSessionTilingTree` when nothing is
  persisted under the current key.

## Cross-links

- Lanes feature: [lanes/](../lanes/)
- Files surface used by terminals for the transcript: see
  [../files-and-editor/](../files-and-editor/) (the file watcher is
  scoped per workspace, not per session).
- Configuration-driven processes: [../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
- Context packs / exports that reference session deltas:
  [../context-packs/](../context-packs/)
