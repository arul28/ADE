# Terminals and Sessions

PTY-backed terminal sessions plus agent chat sessions, both tracked through a
single `terminal_sessions` row and surfaced in the Work view, lane panels, and
the Sessions sidebar. The session model is the backbone for transcripts,
deltas, lane association, and provider continuation metadata.

PTYs are owned by the **active ADE runtime** for the window's project
binding. Local-bound windows spawn PTYs through the local ADE daemon
(`ade serve`); remote-bound windows spawn PTYs on the remote host via
the SSH-attached runtime, with stdin/stdout bytes streaming over the
SSH-backed RPC. The renderer's `window.ade.pty.*`, `window.ade.sessions.*`,
`window.ade.processes.*`, and `window.ade.terminal.*` calls in
`apps/desktop/src/preload/preload.ts` route through
`callProjectRuntimeActionIfBound("pty", …)` /
`callProjectRuntimeActionIfBound("session", …)` /
`callProjectRuntimeActionIfBound("process", …)` first and fall back to
the legacy in-process IPC handlers (the desktop's `ptyService.ts`,
`sessionService.ts`, `processService.ts`) only when no runtime is
bound. The same source files run on both paths. The macOS VM controls
(`window.ade.macosVm.*`) are local-only — they require local hardware
access and are intentionally disabled for remote-bound windows.

These services are large and have been repeatedly rewritten:
`ptyService.ts`, `sessionService.ts`, and `processService.ts`. Treat
them as fragile and re-read whenever wiring changes.

`processService` keeps one runtime record per *invocation*, not per
(lane, process) pair. A single `ProcessDefinition` can have many concurrent
or historical `ProcessRuntime` rows in memory, each identified by `runId`. The
Run page renders those runs on a single card and the aggregate persisted
snapshot (the most recent run) is what lives in the `process_runtime` table.

## Source file map

Service files. Same sources back both the runtime daemon and the
desktop fallback IPC path.

- `apps/desktop/src/main/services/pty/ptyService.ts` — PTY lifecycle,
  transcript capture (capped at `MAX_TRANSCRIPT_BYTES = 64 MB`), runtime
  state, AI auto-titles, tool-type routing, continuation-target backfill, and
  session-id based write/resize entry points used by mobile sync
  terminal control. ~1,500 lines. Branch rewrite.
- `apps/desktop/src/main/services/pty/ptyService.test.ts` — PTY behavior
  tests. Branch updated.
- `apps/desktop/src/main/services/sessions/sessionService.ts` — persistence
  layer for `terminal_sessions` rows. CRUD, continuation metadata normalization,
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
  `TerminalResumeMetadata`, `PtyCreateArgs`, `SessionDeltaSummary`,
  `PtySendToSessionArgs` / `PtySendToSessionResult` (the
  send-or-continue surface), the rich `ChatTerminalSession` /
  `ChatTerminalListArgs` / `ChatTerminalReadArgs` /
  `ChatTerminalReadResult` / `ChatTerminalWriteArgs` /
  `ChatTerminalResizeArgs` / `ChatTerminalSignalArgs` /
  `ChatTerminalActiveForChatArgs` envelopes, plus the
  buffer-snapshot DTOs (`TerminalSnapshotCell`, `TerminalSnapshotRow`,
  `TerminalSerializedSnapshot`, `ChatTerminalPreviewArgs`,
  `ChatTerminalPreviewResult`) used by the `ade.terminal.*` IPC
  surface and the `terminal` ADE action domain.
- `apps/desktop/src/main/services/probeLocalhostPort.ts` — tiny shared
  helper (`probeLocalhostPort(port, timeoutMs)`) that performs a single
  127.0.0.1 TCP probe with a default 150 ms timeout. Used by the
  in-chat localhost detector (so the work-log "Open in ADE" chip only
  appears once the dev server is actually accepting connections) and
  by the lane runtime health checks. Exposed to the renderer as
  `ade.localhost.probePort`.
- `apps/desktop/src/shared/types/sync.ts` — terminal stream/control
  envelopes (`terminal_subscribe`, `terminal_unsubscribe`,
  `terminal_data`, `terminal_exit`, `terminal_input`, `terminal_resize`)
  for iOS Work surfaces, plus the mobile CLI launcher payload
  (`SyncCliLaunchProvider`, `SyncStartCliSessionArgs`,
  `SyncStartCliSessionResult`) consumed by the
  `work.startCliSession` remote command.
- `apps/desktop/src/shared/types/config.ts` — `ProcessDefinition`
  (now carries `groupIds: string[]`), `ProcessGroupDefinition`,
  `ProcessRuntime` (now carries `runId`), `ProcessRuntimeStatus`,
  `ProcessReadinessConfig`, `StackButtonDefinition`,
  `ProcessRestartPolicy`. `ProcessActionArgs` and
  `GetProcessLogTailArgs` accept an optional `runId`.
- `apps/desktop/src/shared/ipc.ts` — channels `ade.sessions.*`,
  `ade.pty.*` (including `ade.pty.sendToSession` — the send-or-continue
  channel that writes into a live agent CLI runtime or starts the
  provider continuation internally), `ade.processes.*`, plus the
  chat-scoped `ade.terminal.*` family (`list`, `read`, `preview` —
  serialized xterm snapshot for the TUI / mobile renderers, `write`,
  `signal`, `activeForChat`), the lane-tied `ade.macosVm.*` family
  (`getStatus`, `provision`, `start`, `stop`, `delete`,
  `getAgentGuide`, `getSharePolicy`, `focusWindow`,
  `captureScreenshot`, `selectPoint`, `click`, `typeText`, event push),
  and the localhost-probe helper `ade.localhost.probePort`.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.sessions`,
  `window.ade.pty`, `window.ade.processes`, and `window.ade.macosVm`
  APIs.

IPC registration:

- `apps/desktop/src/main/services/ipc/registerIpc.ts` — registers
  `sessionsList`, `sessionsGet`, `sessionsUpdateMeta`,
  `sessionsReadTranscriptTail`, `sessionsGetDelta`, `ptyCreate`,
  `ptyWrite`, `ptyResize`, `ptyDispose`, the `processes.*` handlers,
  and the chat-scoped `terminalList` / `terminalRead` /
  `terminalWrite` / `terminalSignal` / `terminalActiveForChat`
  handlers (which delegate to the new `ptyService` chat-terminal
  helpers).

Renderer surfaces:

- `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` —
  entry surface with `PaneTilingLayout` (sessions list + work view).
  Owns the multi-select state (`selectedSessionIds`, shift/ctrl anchor,
  bulk close and bulk delete handlers) that the sidebar forwards into.
  Also owns the right-edge `WorkSidebar` toggle and resizer: when the
  sidebar is open and the view mode is not `grid`, the work view area
  shares its row with `WorkSidebar` via a flex container with a
  draggable column separator.
- `apps/desktop/src/renderer/components/terminals/WorkSidebar.tsx` —
  right-edge sidebar tied to the active lane (and active Work session
  when present). Tabbed into `git` (lane git actions + selection-driven
  diff), `files` (mounts `FilesPage` in `embedded` mode with the lane
  worktree pre-selected), `ios` (mounts `ChatIosSimulatorPanel` against
  the active lane), `app-control` (mounts `ChatAppControlPanel`), and
  `browser` (mounts `ChatBuiltInBrowserPanel` over the shared
  `WebContentsView`-backed built-in browser; the sidebar hides the
  browser viewport whenever the user switches off the tab or closes
  the sidebar by setting bounds to `{ x: 0, y: 0, width: 0, height: 0,
  visible: false }` and stopping any inspect mode). The browser tab is
  not lane-scoped — the built-in browser is a single shared instance
  across the app — but it still flows selections to the active chat
  through the same dispatch path as the other tool tabs. The active
  Work session picks the sidebar's insertion target
  (`WorkSidebarContextTarget`): chat sessions get the legacy
  `ade:agent-chat:add-attachment` / `add-ios-context` /
  `add-app-control-context` / `add-builtin-browser-context` /
  `add-macos-vm-context` / `insert-draft` events, while tracked agent
  CLI PTYs (Claude / Codex / Cursor / OpenCode / Droid) receive the
  same iOS / App Control / browser / macOS VM / attachment / draft
  payloads formatted into prompt text by
  `apps/desktop/src/renderer/lib/visualContextFormatting.ts` and
  written into the PTY through `window.ade.pty.write` as a
  bracketed-paste envelope. After each PTY insertion the sidebar
  dispatches `ADE_WORK_PTY_CONTEXT_INSERTED_EVENT`
  (`apps/desktop/src/renderer/lib/workPtyContextEvents.ts`) so the
  matching `TerminalView` can briefly highlight the new content. When
  no chat or tracked agent CLI session is open, attachment is disabled
  with a banner; lane mismatches between the Work lane and an existing
  App Control / iOS Simulator session also disable attachment with a
  warning. The tab strip must stay reachable when the Work pane is
  narrow: labels collapse to accessible icon buttons while preserving
  stable hit targets and tooltips.
- `apps/desktop/src/renderer/components/terminals/MacosVmPanel.tsx` —
  Work sidebar panel for the active lane's macOS VM. It shows provider
  readiness, provisioning/start/stop/delete controls, sanitized share
  status, screenshot capture, point selection, click/type controls, and
  chat context attachment for selected VM targets.
- `apps/desktop/src/renderer/components/terminals/SessionListPane.tsx` —
  sidebar list with three organization modes (lane / status / time),
  sticky group headers, search/filter. Renders a bulk action bar at the
  bottom when sessions are multi-selected (Close N running / Delete N
  ended / clear selection). The filter panel is width-constrained by
  the surrounding Work split, so status/group options wrap in an
  auto-fit grid and the embedded lane selector can fill its parent.
  Lane group headers expose the same lane context menu used by the Work
  tab so color, manage, split, and batch actions stay reachable without
  leaving the session list.
- `apps/desktop/src/renderer/components/terminals/SessionCard.tsx` —
  per-session card (status dot, title, preview line, tool type, lane,
  delta chips). Surfaces a small amber warning pip next to the title
  when `getStaleRunningCliSessionAgeHours` returns a value, so users
  can spot long-running CLI/shell sessions without opening them. The
  card also reports its multi-select state via `isMultiSelected`.
- `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx` —
  tabs/grid/single Work view. The grid mode renders through the shared
  `PaneTilingLayout`; the seed tree comes from
  `buildWorkSessionTilingTree`. Also hosts the chat-like continuation
  composer for ended tracked agent CLI sessions: when a Claude / Codex /
  Cursor / OpenCode / Droid PTY has exited, the surface keeps the
  transcript and renders a model / permission / slash-aware composer
  whose send button calls `ade.pty.sendToSession`. The handler writes
  into a live runtime when one is still attached, or starts a fresh
  provider continuation internally and binds it back to the same
  durable session id.
- `apps/desktop/src/renderer/components/terminals/useWorkLaneContextMenu.tsx`
  — shared Work-tab lane context menu hook. It portals `LaneContextMenu`
  over lane bands, lane chips, collapsed lane pills, and grouped session
  headers, running inline actions in place and routing modal-bearing lane
  actions through `/lanes?action=...`.
- `apps/desktop/src/renderer/components/terminals/WorkCliSessionHeader.tsx`
  — small chat-style header rendered above tracked agent CLI terminals
  (and their tabs). Shows the provider logo, primary title, status dot,
  insertion-target label, info / overflow / stop-runtime buttons, and
  the shared `ChatGitToolbar`. Replaces the older "terminal-only" tab
  chrome on agent CLI sessions and reuses `formatToolTypeLabel` /
  `primarySessionLabel` / `sessionStatusBucket` so chat and CLI rows
  read consistently.
- `apps/desktop/src/renderer/components/terminals/WorkStartSurface.tsx` —
  empty-state "start new chat / terminal" surface.
- `apps/desktop/src/renderer/components/terminals/TerminalView.tsx` —
  xterm.js wrapper; WebGL renderer with DOM fallback, fit retries, health
  counters.
- `apps/desktop/src/renderer/components/terminals/workSessionTiling.ts` —
  pure helper that produces the seed `PaneSplit` for the Work grid from
  an ordered list of session IDs. Accepts a `TilingPreset` of
  `"auto"` (default — single-column for ≤1 session, single row when
  `ceil(sqrt(n)) == n`, otherwise a vertical stack of horizontal rows
  with counts distributed by `rowSizes`), `"rows"` (one full-width row
  per session), or `"columns"` (one column per session). The
  `WorkViewArea` arrange menu rewrites the persisted tiling tree when
  the user picks a non-auto preset.
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
  tab switch always renders the current session set. Fresh PTY launches
  are inserted as short-lived optimistic sessions before the forced
  session-list refresh returns, which keeps the new terminal tab visible
  even when the runtime cache responds with a stale list.
- `apps/desktop/src/renderer/components/terminals/useSessionDelta.ts` —
  fetches `SessionDeltaSummary` for a given session.
- `apps/desktop/src/shared/cliLaunch.ts` — canonical CLI launch
  payload builder, shared between the desktop renderer Work tab and
  the main-process `syncRemoteCommandService` mobile launcher. Exposes
  `CliProvider = "claude" | "codex" | "cursor" | "droid" | "opencode"`
  and `LaunchProfile = CliProvider | "shell"`;
  `LAUNCH_PROFILE_TOOL_TYPE` and `LAUNCH_PROFILE_TITLE` map a launch
  profile to the recorded `TerminalToolType` (`cursor-cli`, `droid`,
  `opencode`, etc.) and the human tab title. `buildTrackedCliLaunchCommand`
  returns a typed `TrackedCliLaunchCommand` (`{ command?, args,
  startupCommand, env? }`) so `ptyService.create` can spawn Claude/
  Codex directly via argv (preferred) while `startupCommand` stays as a
  shell-typed fallback for the providers (Cursor, Droid, OpenCode) that
  need a multi-line shell preamble: Cursor pre-allocates a chat with
  `cursor-agent create-chat` so the resume target is known up front,
  Droid materializes a temp `--settings` JSON keyed off the active
  permission mode, and OpenCode passes its inline permission policy
  through the `OPENCODE_CONFIG_CONTENT` env var. ADE session guidance is
  injected on every launch with skill roots resolved from the active
  lane worktree when known: Claude gets `buildAdeCliAgentGuidance(...)`
  through `--append-system-prompt`, while every other provider receives
  a leading prompt from `buildAdeCliInlineGuidance(...)`. Launch env also
  carries `ADE_AGENT_SKILLS_DIRS` when a bundled skills root is known.
  The legacy
  `buildTrackedCliStartupCommand` and `defaultTrackedCliStartupCommand`
  are now thin wrappers over `buildTrackedCliLaunchCommand` for
  callers that only need the shell string. `buildTrackedCliResumeCommand`
  rebuilds a resume command line from `TerminalResumeMetadata` for any
  provider; `parseTrackedCliResumeCommand`
  (`apps/desktop/src/main/utils/terminalSessionSignals.ts`) is the
  inverse it relies on for round-tripping. `resolveLaunchFields` is
  the atomic-override helper that mixes a caller's
  `command`/`args`/`startupCommand`/`env` with the profile defaults
  (only when the caller passed nothing).
- `apps/desktop/src/renderer/components/terminals/cliLaunch.ts` — thin
  re-export of `apps/desktop/src/shared/cliLaunch.ts` so existing
  renderer callers keep their import path.
- `apps/desktop/src/shared/shell.ts` — shared shell-quoting and
  command-line parsing utilities (`quoteShellArg`, `commandArrayToLine`,
  `parseCommandLine`) used by both the renderer and the main-process
  CLI launcher. Handles POSIX and Windows quoting rules behind a single
  surface.
- `apps/desktop/src/renderer/lib/shell.ts` — thin re-export of
  `apps/desktop/src/shared/shell.ts` to preserve existing renderer
  imports.
- `apps/desktop/src/shared/adeCliGuidance.ts` — single source of truth
  for ADE session guidance injected into tracked CLI launches. Exposes
  builders plus compatibility constants; callers pass lane-aware skill
  roots so prompt text can point agents at the right bundled ADE skills.
- `apps/desktop/src/shared/agentSkillRoots.ts` — resolves candidate
  ADE Agent Skills roots from the active lane worktree, inherited
  `ADE_AGENT_SKILLS_DIRS`, packaged resources, and source fallbacks,
  then formats the prompt line / env var value.
- `apps/desktop/src/renderer/components/terminals/workSurfaceVisibility.ts`
  — exports the `WORK_SURFACE_REVEALED_EVENT` window-event constant
  and a `dispatchWorkSurfaceRevealed()` helper. The persistent Work
  surface fires this event whenever the work area becomes active again
  so xterm tiles can clear their texture atlas, force a refit against
  the new viewport, and restore focus/scroll without waiting for a
  resize event that will never come.
- `apps/desktop/src/renderer/components/terminals/SessionContextMenu.tsx`
  and `SessionInfoPopover.tsx` — right-click actions and info overlay.
  Ended chat sessions get an additional "Delete chat" action wired to
  `ade.agentChat.delete`. Fixed-position context menus measure their
  rendered size and clamp to the renderer viewport before opening near
  a pointer edge.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` — shared renderer
  cache for `ade.sessions.list` calls, keyed by `projectRoot/laneId/status`.
- `apps/desktop/src/renderer/lib/sessions.ts` — session-label helpers
  plus `getStaleRunningCliSessionAgeHours`, the canonical check that
  returns a rounded age in hours when a non-run, non-chat session has
  been `running` for at least `STALE_RUNNING_CLI_SESSION_MS` (12 h).
  Used by both `SessionCard` (inline pip) and `AppShell` (stale-CLI
  toast).
- `apps/desktop/src/renderer/lib/transcriptExport.ts` —
  `formatSessionBundleMarkdown` builds a metadata-only markdown bundle
  for a list of selected sessions; `triggerBrowserDownload` writes it
  to disk via a transient anchor + Object URL. Used by the bulk-export
  action in the session list.
- `apps/desktop/src/main/services/macosVm/macosVmService.ts` —
  lane-tied macOS VM lifecycle and control service. Uses Lume as the
  first provider, stores per-lane records under `.ade/cache/macos-vms`,
  keeps VNC credentials in `.ade/secrets`, mounts direct lane roots when
  safe, and otherwise maintains a sanitized rsync mirror that excludes
  ADE secrets, runtime databases, caches, transcripts, generated local
  memory/history, worktrees, agents, and `.git`.
- `apps/desktop/src/main/services/macosVm/rfbDirectClient.ts` —
  headless VNC bridge for screenshot, click, and type operations. It
  disables unsupported audio negotiation for Lume VNC sessions and
  encodes captured RGBA frames as PNGs for proof/context flows.
- `apps/desktop/src/main/services/macosVm/macosVmService.test.ts` —
  macOS VM provider, share-policy, lifecycle, guidance, and direct-VNC
  control tests.
- `apps/desktop/src/shared/types/macosVm.ts` — `MacosVmStatus`,
  `MacosVmRecord`, provision/start/control arguments, event payloads,
  screenshot results, and `MacosVmContextItem`.

iOS Work surfaces:

- `apps/ios/ADE/Views/Work/WorkRootScreen.swift`,
  `WorkRootScreen+Actions.swift`, `WorkRootScreen+Selection.swift`, and
  `WorkRootComponents.swift` — mobile Work list, filters, grouped
  session rows, and live-count/status pills. Agent CLI continuation is
  driven by sending text to the durable session, not a standalone
  row action. The earlier
  in-list activity feed is gone — running chats surface through the
  session list and the live-count chip.
- `apps/ios/ADE/Views/Work/WorkArtifactTerminalViews.swift` —
  terminal artifact/output views and the compact input bar that sends
  `terminal_input` bytes and Ctrl-C to the subscribed host PTY. Hosts
  the new emulator surface and unsubscribes via
  `SyncService.unsubscribeTerminal` on view disappear.
- `apps/ios/ADE/Views/Work/WorkTerminalEmulatorView.swift` —
  UIKit-backed monospaced terminal screen + `WorkTerminalScreen`
  model that reports its viewport in (cols, rows) so the host can
  resize the PTY to the phone's actual rendered grid.
- `apps/ios/ADE/Views/Work/WorkChatSessionView.swift`,
  `WorkChatComposerAndInputViews.swift`, `WorkChatRichCardViews.swift`,
  `WorkReasoningCard.swift`, `WorkNewChatScreen.swift` — mobile chat,
  composer, command/tool/reasoning cards, and new-chat launch surface.
  `WorkNewChatScreen` segments between **ADE chat** and **CLI session**;
  the CLI mode submits `work.startCliSession` against the host through
  `SyncService.startCliSession`.

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
- tracked CLI agent terminals (`claude`, `codex`, `cursor-cli`, `droid`,
  `opencode`, plus the `*-orchestrated` variants used by missions)
- agent chat sessions that run through the Claude/Codex/Cursor/Droid/
  OpenCode SDKs rather than a PTY (`claude-chat`, `codex-chat`,
  `opencode-chat`, `cursor-chat`, `droid-chat`)
- other tracked tools (`cursor`, `aider`, `continue`, `other`)

Status transitions: `running` → `completed` | `failed` | `disposed`.

Fields that feed UI and downstream systems:

- identity: `id`, `laneId`, `laneName`, `ptyId`, `tracked`, `pinned`,
  `manuallyNamed`, `chatSessionId` (parent chat that owns this terminal,
  set when launched from the chat terminal drawer or App Control —
  stored as `chat_session_id` and indexed)
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
   (or reuses an existing ID when continuing an ended session), opens a transcript stream,
   spawns the shell or direct command, and inserts a
   `terminal_sessions` row through `sessionService.create()`.

2. **Stream** — PTY `data` events are written to the transcript
   (capped at `MAX_TRANSCRIPT_BYTES = 64 MB`), throttled into a
   `lastOutputPreview`, forwarded to `broadcastData`, and scanned for
   runtime state signals (OSC 133 prompt markers).

3. **Tag** — the tool type is inferred or passed by the renderer.
   Claude/Codex sessions also get a best-effort `--session-id` extraction
   so continuation works after the CLI itself assigns an ID.

4. **Auto-title** — after 6 seconds (`PTY_AI_TITLE_DEBOUNCE_MS`) the
   service may summarize the early output into a short title via the AI
   integration service. For Claude/Codex it prefers the first submitted
   user line (`tryCliUserTitleFromWrite`) because the TUI hides useful
   text in the alternate screen.

5. **Runtime exit** — on PTY exit, `sessionService.end()` finalizes `endedAt`,
   `exitCode`, and `status`. The transcript stream is flushed, then:
   - `backfillResumeTargetFromTranscriptBestEffort` tries to recover a
     Claude/Codex session UUID from transcript output or from Claude/Codex
     local JSONL storage.
   - `summarizeSessionBestEffort` generates an optional end-of-session
     summary and, when `refreshOnComplete` is enabled, regenerates the
     title from the transcript tail.
   - `sessionDeltaService` can compute file-level git deltas using
     `headShaStart`/`headShaEnd`.

6. **Continue** — `work.sendToSession` reuses an existing session row
   when the user sends text to an ended agent CLI session and the PTY
   service opens the transcript in append mode. This keeps identity,
   lane association, and transcript history intact.

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
  UI state (open items, filters, collapsed groups, focus-hidden flag,
  right `WorkSidebar` open/tab/width) to `localStorage` under
  `ade.workViewState.v1`. The sidebar fields are
  `workSidebarOpen: boolean`, `workSidebarTab: "git" | "files" | "ios"
  | "app-control" | "browser"`, and `workSidebarWidthPct: number`
  (clamped to 26–55). Lane-scoped state uses a composite
  `projectRoot::laneId` key.

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
| `ade.pty.create` | create or reattach; returns `{ ptyId, sessionId, pid }`. Accepts an optional `chatSessionId` to mark the terminal as chat-owned. |
| `ade.pty.sendToSession` | send-or-continue. Args: `{ sessionId, text, cols?, rows?, model?, reasoningEffort?, permissionMode? }`. Writes into the live PTY when one is attached; otherwise validates that the row is a tracked agent CLI session, rebuilds the resume command via `buildTrackedCliResumeCommand` (honouring runtime overrides), spawns the continuation PTY in the same `terminal_sessions` row, and then writes the user's text. Returns `PtySendToSessionResult` (`{ ptyId, sessionId, pid, session, resumed, reusedExistingRuntime }`). |
| `ade.pty.write` | write bytes to PTY |
| `ade.pty.resize` | cols/rows resize |
| `ade.pty.dispose` | close PTY; optional `sessionId` used for logging |
| `ade.pty.data` (event) | stream stdout/stderr to the renderer |
| `ade.pty.exit` (event) | final exit code |

Chat-owned terminals (`ade.terminal.*` — used by the chat terminal drawer, the App Control panel, the TUI `TerminalPane`, and the headless `ade terminal` / `ade app-control` CLI commands):

| Channel | Purpose |
|---|---|
| `ade.terminal.list` | list `ChatTerminalSession[]` (filterable by `chatSessionId` and/or `laneId`). Rich rows: `toolType`, `goal`, `resumeCommand`, `resumeMetadata`, `lastOutputPreview`, `summary`, status / runtime state. Chat-toolType sessions are filtered out so the surface only lists shells and tracked agent CLI terminals. |
| `ade.terminal.read` | tail scrollback by explicit `terminalId` *or* by `chatSessionId`. Returns `{ terminalId, data, nextSince }` for incremental polling. |
| `ade.terminal.preview` | serialized buffer snapshot for the TUI/mobile renderers. Each live PTY mirrors output into an `@xterm/headless` Terminal + `SerializeAddon` and debounce-writes a JSON file under `.ade/cache/terminal-snapshots/`. The preview call flushes the in-flight write, reads the snapshot (`TerminalSerializedSnapshot` with serialized scrollback, visible-row cells, cursor / viewport / buffer-type metadata), and falls back to a transcript tail when no snapshot exists yet. |
| `ade.terminal.write` | write bytes to a terminal (by `terminalId`, `ptyId`, or `chatSessionId`). |
| `ade.terminal.resize` | resize the live PTY (cols, rows) by `terminalId`, `ptyId`, or `chatSessionId`. Clamps dims and rebroadcasts the new size to the snapshot mirror. |
| `ade.terminal.signal` | deliver `SIGINT` / `SIGTERM` / `SIGKILL` to the resolved terminal. |
| `ade.terminal.activeForChat` | resolve the active `ChatTerminalSession` for a given `chatSessionId`. |

`ptyService` keeps two in-memory maps to back this surface:
`terminalChatSessions` (terminalId → chatSessionId) and
`activeTerminalByChatSession` (chatSessionId → terminalId). Disposing
the active terminal automatically promotes the most recently created
sibling, so `ade terminal read --chat-session <id>` always resolves a
sensible target for in-chat agents. Every PTY launched through
`ptyService.create` runs through `withAdeTerminalContextEnv` which
exports `ADE_PROJECT_ROOT`, `ADE_LANE_ID`, and (when the PTY is
chat-owned) `ADE_CHAT_SESSION_ID` into the spawn env — that's how a
plain shell that the user types `ade --socket terminal read --chat-session
"$ADE_CHAT_SESSION_ID" --text` into will resolve to the parent chat's
terminal even though no agent runtime spawned it. The headless ADE
runtime and agent chat runtime both layer the same identity envs
(plus `ADE_WORKSPACE_ROOT`) on top through `buildAgentRuntimeEnv`.

Processes (managed):

| Channel | Purpose |
|---|---|
| `ade.processes.listDefinitions` | read from project config |
| `ade.processes.listRuntime` | every in-memory run for the lane (one entry per `runId`, including recent stopped/crashed ones up to the 20-run history cap) |
| `ade.processes.start` | lifecycle; always returns the new `ProcessRuntime` |
| `ade.processes.stop` / `ade.processes.kill` | returns the targeted `ProcessRuntime`, or `null` when no active run exists for the `(laneId, processId[, runId])` tuple |
| `ade.processes.restart` | stop active runs, wait for exit (up to 10 s), start a new run |
| `ade.processes.startStack` / `stopStack` / `restartStack` | stack buttons |
| `ade.processes.startGroup` / `stopGroup` / `restartGroup` | bulk ops over a `ProcessGroupDefinition`. Caller passes `{ groupId, laneByProcessId }` so each member can run on its own lane (the Run page builds this map from per-card lane selections). Start order is **parallel** — `dependsOn` is intentionally not topologically sorted across mixed lanes. Restart waits for in-flight stops before re-starting. |
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
- Transcript writes are capped at 64 MB; after the cap a notice line is
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
