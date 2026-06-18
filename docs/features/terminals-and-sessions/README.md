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
`callProjectRuntimeActionIfBound("process", …)` first and use the
legacy in-process IPC handlers (the desktop's `ptyService.ts`,
`sessionService.ts`, `processService.ts`) only when no runtime is
bound, such as tests or pre-binding diagnostics. A local-bound daemon
failure is surfaced to the caller instead of being retried against the
desktop process. The same source files run on both paths. Remote-bound windows
now rely on the same terminal/session APIs as local windows.

These services are large and have been repeatedly rewritten:
`ptyService.ts`, `sessionService.ts`, and `processService.ts`. Treat
them as fragile and re-read whenever wiring changes.

`processService` keeps one runtime record per *invocation*, not per
(lane, process) pair. A single `ProcessDefinition` can have many concurrent
or historical `ProcessRuntime` rows in memory, each identified by `runId`. The
Run page renders those runs on a single card and the aggregate persisted
snapshot (the most recent run) is what lives in the `process_runtime` table.

## Source file map

Service files. Same sources back the ADE runtime and the limited
desktop in-process path used before a binding exists, in diagnostics,
and in tests.

- `apps/desktop/src/main/services/pty/ptyService.ts` — PTY lifecycle,
  transcript capture (capped at `MAX_TRANSCRIPT_BYTES = 16 MB`), runtime
  state, AI auto-titles, tool-type routing, continuation-target backfill,
  session-id based write/resize entry points used by mobile sync
  terminal control, `readTranscriptTail({ sessionId, ... })` which
  merges the on-disk transcript tail with the live PTY output tail so
  Work/TUI terminal hydration can replay output that is still buffered
  in the transcript write stream, `readTranscriptRange({ sessionId,
  startOffset, endOffset })` for mobile scrollback/delta resume,
  offset-stamped PTY data batches, desktop-size restore after
  mobile-driven resizes, agent CLI input protocol (bracketed paste,
  chunked writes, provider-specific submit delays), process tree
  termination (`terminatePtyProcessTree` walks descendant PIDs via
  `pgrep` and escalates to `SIGKILL` after a grace timer), live session
  row resync (re-opens rows that drifted to `ended` while the PTY is
  still alive), and `initialInput` / `initialInputDelayMs` support for
  deferred first-turn submission. PTY create stamps the new
  `terminal_sessions` row's `owner_pid` with the
  `processRegistryService` pid so cross-process reconcile/dispose paths
  can tell live siblings from crashed owners. Also owns
  `sendToSession` and `resumeSession` for tracked CLI continuation and
  prompt-free relaunch. ~4,450 lines.
- `apps/desktop/src/main/services/pty/supervisedPtyHost.ts` and
  `ptyHostWorker.ts` — isolated node-pty worker host. Local runtimes fork the
  worker from the built desktop files; remote runtimes can receive
  `ADE_PTY_HOST_WORKER_PATH` + `ADE_PTY_HOST_WORKER_NODE` or
  `ADE_PTY_HOST_WORKER_COMMAND` from remote bootstrap so PTYs run through the
  uploaded worker/static runtime instead of relying on a source checkout.
- `apps/desktop/src/main/services/pty/ptyService.test.ts` — PTY behavior
  tests. Branch updated.
- `apps/desktop/src/main/services/sessions/sessionService.ts` — persistence
  layer for `terminal_sessions` rows. CRUD, continuation metadata
  normalization, `reattach`, `reconcileStaleRunningSessions`. Reconcile and
  ownership-aware queries gate row sweeps on both live owners and known local
  owners from `processRegistryService`: a `running` row whose owner is live
  belongs to a sibling and must be left alone; a row whose owner is known on
  this machine but no longer live can be marked `detached`; a row with an
  unknown owner identity is preserved because it may have synced from another
  machine. ~580 lines. Branch rewrite.
- `apps/desktop/src/main/services/runtime/processRegistryService.ts` — per-
  process heartbeat registrar against the machine-local `runtime_processes`
  table, which is excluded from CRR replication because PIDs are OS-local.
  Every ADE process (desktop main, TUI runtime, `ade serve` daemon) inserts a
  row on boot keyed by the process incarnation (`pid`, `started_at`),
  refreshes `last_seen` on a 5 s heartbeat, and
  reports live and known owners through `isPidLive(candidatePid)`,
  `listLivePids()`, `listLiveProcessIdentities()`, `listKnownPids()`, and
  `listKnownProcessIdentities()`. The default liveness window is 3× the
  heartbeat interval so a single missed tick doesn't false-positive a sibling
  as dead. PTY create stamps new rows with the registry's owner identity, and
  reconcile / dispose paths consult the registry before sweeping. See
  [ARCHITECTURE.md §3.4](../../ARCHITECTURE.md#34-cross-process-ownership).
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
  offset-stamped `PtyDataEvent`,
  `PtySendToSessionArgs` / `PtySendToSessionResult` (the
  send-or-continue surface), `PtyResumeSessionArgs` /
  `PtyResumeSessionResult` (prompt-free tracked CLI relaunch), the rich `ChatTerminalSession` /
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
  `terminal_snapshot`, `terminal_data`, `terminal_history`,
  `terminal_exit`, `terminal_input`, `terminal_resize`) for iOS Work
  surfaces, including transcript offsets, `sinceOffset` delta resume,
  `live` backing-PTY status, and pull-to-load-older history pages, plus
  the mobile CLI launcher payload
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
  provider continuation internally — and `ade.pty.resumeSession`, which
  relaunches an ended tracked CLI session without sending a prompt),
  `ade.processes.*`, plus the
  chat-scoped `ade.terminal.*` family (`list`, `read`, `preview` —
  serialized xterm snapshot for the TUI / mobile renderers, `write`,
  `signal`, `activeForChat`), and the localhost-probe helper
  `ade.localhost.probePort`.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.sessions`,
  `window.ade.pty`, and `window.ade.processes` APIs.

IPC registration:

- `apps/desktop/src/main/services/ipc/registerIpc.ts` — registers
  `sessionsList`, `sessionsGet`, `sessionsUpdateMeta`,
  `sessionsReadTranscriptTail`, `sessionsGetDelta`, `ptyCreate`,
  `ptyResumeSession`, `ptySendToSession`, `ptyWrite`, `ptyResize`,
  `ptyDispose`, the `processes.*` handlers,
  and the chat-scoped `terminalList` / `terminalRead` /
  `terminalWrite` / `terminalSignal` / `terminalActiveForChat`
  handlers. `terminalRead` delegates transcript-tail reads to
  `ptyService` so chat-owned terminal drawers and `ade code` get the
  same live-tail merge as the Work tab.

Renderer surfaces:

- `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` —
  entry surface with `PaneTilingLayout` (sessions list + work view).
  Owns the multi-select state (`selectedSessionIds`, shift/ctrl anchor,
  bulk close and bulk delete handlers) that the sidebar forwards into.
  It consumes `AgentChatPane` session-created options from
  `WorkStartSurface` / `WorkViewArea`: foreground Work launches
  (disposition `"foreground"` or unset) select the lane, focus the
  session, and open the session tab, while background launches
  (disposition `"background"`) upsert the optimistic session and
  refresh the list without stealing focus. Both chat and CLI draft
  launches respect the same disposition field through the unified
  `WorkPtyLaunchArgs` / `WorkPtyLaunchResult` contract. Ended tracked
  CLI sessions expose a prompt-free Resume action wired to
  `window.ade.pty.resumeSession`, alongside the continuation composer
  that sends a new prompt through `window.ade.pty.sendToSession`.
  It also listens for the renderer-wide `ade:work:select-session` event
  used by orchestration panels and worker-to-lead links; the listener
  selects the lane when supplied, focuses the target session, opens its
  Work tab, and updates `selectedSessionId`.
  Also owns the right-edge `WorkSidebar` toggle and resizer: when the
  sidebar is open and the view mode is not `grid`, the work view area
  shares its row with `WorkSidebar` via a flex container with a
  draggable column separator.
- `apps/desktop/src/renderer/components/terminals/WorkSidebar.tsx` —
  right-edge sidebar tied to the active lane (and active Work session
  when present). Tabbed into `git` (lane git actions + selection-driven
  diff), `files` (mounts `FilesTab` in `embedded` mode with the lane
  worktree pre-selected), `ios` (mounts `ChatIosSimulatorPanel` against
  the active lane), `app-control` (mounts `ChatAppControlPanel`), and
  `browser` (mounts `ChatBuiltInBrowserPanel` over the current ADE
  window's `WebContentsView`-backed built-in browser; the sidebar hides
  the browser viewport whenever the user switches off the tab or closes
  the sidebar by setting bounds to `{ x: 0, y: 0, width: 0, height: 0,
  visible: false }` and stopping any inspect mode). The browser tab is
  not lane-scoped: each ADE window owns its own tabs and active inspect
  state, while all windows share the same `persist:ade-browser`
  partition for authentication. On remote-bound Work surfaces, the sidebar is
  limited to the runtime-backed `git` and `files` tabs and automatically
  switches away from local-only iOS / App Control / Browser tabs. It still
  flows selections to the active
  chat through the same dispatch path as the other tool tabs. The active
  Work session picks the sidebar's insertion target
  (`WorkSidebarContextTarget`): chat sessions (`kind: "chat"`) and
  draft composers (`kind: "draft"`, carrying `draftTargetId`, `laneId`,
  and `draftKind`) receive
  `ade:agent-chat:add-attachment` / `add-ios-context` /
  `add-app-control-context` / `add-builtin-browser-context` /
  `insert-draft` events (draft targets include `draftTargetId` instead
  of `sessionId` in the event detail), while tracked agent
  CLI PTYs (Claude / Codex / Cursor / OpenCode / Droid) receive the
  same iOS / App Control / browser / attachment / draft
  payloads formatted into prompt text by
  `apps/desktop/src/renderer/lib/visualContextFormatting.ts` and
  written into the PTY through `window.ade.pty.write` as a
  bracketed-paste envelope. After each PTY insertion the sidebar
  dispatches `ADE_WORK_PTY_CONTEXT_INSERTED_EVENT`
  (`apps/desktop/src/renderer/lib/workPtyContextEvents.ts`) so the
  matching `TerminalView` can briefly highlight the new content. When
  no chat, draft, or tracked agent CLI session is open, attachment is
  disabled with a banner. Lane mismatches between the Work lane and an
  existing App Control / iOS Simulator session are shown as an
  informational warning banner but no longer block context insertion —
  controls affect the running tool while inserted context goes to the
  current chat, draft, or CLI target. The tab strip must stay reachable
  when the Work pane is narrow: labels collapse to accessible icon
  buttons while preserving stable hit targets and tooltips.
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
  whose send button calls `ade.pty.sendToSession`. The same surface also
  renders a Resume button that calls `ade.pty.resumeSession` when the
  user wants the TUI back without sending a new prompt. `sendToSession`
  writes into a live runtime when one is still attached, or starts a
  fresh provider continuation bound back to the same durable session id.
  For the first ended-session continuation with stored resume metadata,
  the prompt is included in the provider resume command line, so ADE
  does not wait for provider-specific readiness and then type into the
  resumed TUI. Later sends that target an already-live PTY still use the
  serialized agent CLI input protocol. The
  `onLaunchPtySession` prop is typed as
  `(args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>`.
- `apps/desktop/src/renderer/components/terminals/useWorkLaneContextMenu.tsx`
  — shared Work-tab lane context menu hook. It portals `LaneContextMenu`
  over lane bands, lane chips, collapsed lane pills, and grouped session
  headers, running inline actions in place and routing modal-bearing lane
  actions through `/lanes?action=...`.
- `apps/desktop/src/renderer/components/work/WorkSurfaceHeader.tsx` —
  shared single-row Work surface header chrome used by both embedded
  chats and tracked agent CLI terminals. It owns the title, lane chip,
  Claude cache badge, lane git toolbar slot, and trailing-action
  placement so chat and CLI surfaces share one visual shell.
- `apps/desktop/src/renderer/components/terminals/CliSessionWorkSurfaceHeader.tsx`
  — CLI adapter for `WorkSurfaceHeader`. It maps a
  `TerminalSessionSummary` to the shared header, adds the status dot,
  Run menu, info, and overflow actions, and intentionally leaves stop
  controls to the sidebar card / chat composer paths.
- `apps/desktop/src/renderer/components/terminals/WorkStartSurface.tsx` —
  empty-state "start new chat / terminal" surface. It mounts
  `AgentChatPane` in embedded draft mode, passes `draftContextTargetId`
  so the Work sidebar can insert context into the draft composer before
  a session exists, and forwards `onSessionCreated(session, options)` so
  foreground draft launches can open in Work while background launches
  stay quiet and surface their dismissible launch notice inside the pane.
  The `onLaunchPtySession` prop is typed as
  `(args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>`.
- `apps/desktop/src/renderer/components/terminals/TerminalView.tsx` —
  xterm.js wrapper; WebGL renderer with DOM fallback, fit retries, health
  counters, and transcript replay mode for disposed chat-CLI sessions so an
  ended tracked CLI tab can repaint the full retained transcript before falling
  back to `terminal.preview`. Work-tracked agent CLI terminals paste clipboard
  images by saving the bytes as chat temp attachments through the active runtime
  and bracketed-pasting a short path/type stub into the PTY, while standalone
  terminals keep the native clipboard-image shortcut behavior.
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
  are inserted as optimistic sessions before the forced
  session-list refresh returns, which keeps the new terminal tab visible
  even when the runtime cache responds with a stale list. During project
  switches it hydrates the destination project's cached rows but marks them
  non-authoritative until the active project refresh returns; cache mirroring
  and open-tab pruning pause during that window so the previous project's
  sessions cannot poison the new project's Work state. Remote-bound projects
  use a slower running-session refresh cadence and skip visibility-triggered
  refreshes unless hidden changes were observed, reducing background SSH
  chatter. `launchPtySession`
  accepts `WorkPtyLaunchArgs` and returns `WorkPtyLaunchResult`; when
  `disposition` is `"background"` the hook skips `selectLane`,
  `focusSession`, and `openSessionTab` so the launch happens silently
  without stealing the user's current focus.
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
  startupCommand, initialInput?, initialInputDelayMs?, env? }`) so `ptyService.create` can spawn tracked
  CLIs with explicit argv instead of typing the launch command into an
  already-open shell. Cursor launches `cursor-agent` directly and keeps
  empty Work launches idle; when ADE has an actual first user prompt,
  it waits for Cursor's interactive prompt and submits the ADE guidance
  plus user text through PTY input instead of argv. Droid materializes a
  temp `--settings` JSON keyed off the active
  permission mode, and OpenCode passes its inline permission policy
  through the `OPENCODE_CONFIG_CONTENT` env var. ADE session guidance is
  injected on every launch with skill roots resolved from the active
  lane worktree when known: Claude gets `buildAdeCliAgentGuidance(...)`
  through `--append-system-prompt`; Codex, Droid, and OpenCode receive
  a leading prompt from `buildAdeCliInlineGuidance(...)`; Cursor receives
  that prompt only when there is an initial user message. Launch env also
  carries `ADE_AGENT_SKILLS_DIRS` when skill roots are known, including
  lane/user `.claude`, `.agents`, `.ade`, `.codex` skill dirs plus
  bundled ADE resources.
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
  (only when the caller passed nothing). `TRACKED_CLI_PERMISSION_MODES`
  now includes `auto` (Claude only; mapped onto the SDK
  `permissionMode: "auto"`); `validateLaunchProfilePermissionMode`
  rejects `auto` for any non-Claude provider and rejects `config-toml`
  for providers other than Codex and OpenCode. A launch that passes an
  `initialPrompt` embeds it into the provider launch itself for
  argv-oriented runtimes (Claude/Codex legacy prompt models/Droid,
  OpenCode `--prompt`), while Codex interactive launches and Cursor use
  `initialInput` after PTY readiness so the first user message is
  submitted as the provider's real first turn instead of becoming a
  half-typed shell line.
  Plain "shell" launches and `resolveCleanShellLaunchFields({
  platform, shell, comSpec })` together produce a deterministic
  argv/env per OS that skips the user's profile / rc / config files
  (zsh `-f` with `ZDOTDIR=/var/empty`, bash `--noprofile --norc` with
  `BASH_ENV=""`, fish `--no-config`, PowerShell `-NoLogo -NoProfile`,
  `cmd.exe /d`); `ptyService.resolveShellCandidates({ clean: true })`
  uses the same recipe for interactive shell sessions launched
  without a startup command. `deriveTrackedCliInitialInputSessionMeta`
  seeds the session title and `goal` field from the first prompt
  (sanitised + clipped to ~72 chars) when the caller did not supply a
  manual title, so tracked CLI rows render with a meaningful name
  instead of "Codex" / "Claude" while still letting providers like
  Shell fall back to the generic profile title.
- `apps/desktop/src/renderer/components/terminals/cliLaunch.ts` — thin
  re-export of `apps/desktop/src/shared/cliLaunch.ts` plus the renderer-
  local Work launch envelope types: `WorkPtyLaunchDisposition`
  (`"foreground" | "background"`), `WorkPtyLaunchArgs` (typed argument
  bag for `launchPtySession` across all Work surfaces — carries
  `laneId`, `profile`, optional overrides, and the `disposition` field),
  and `WorkPtyLaunchResult` (alias of `PtyCreateResult`). These types
  unify the inline prop shapes that `WorkStartSurface`, `WorkViewArea`,
  `useLaneWorkSessions`, `useWorkSessions`, and `AgentChatPane` all
  previously duplicated.
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
  builders plus the canonical bundled ADE skill list; callers pass
  lane-aware skill roots so prompt text can point agents at the active
  Agent Skills search path and explain the `<skill>/SKILL.md`
  package shape.
- `apps/desktop/src/shared/agentSkillRoots.ts` — resolves candidate
  Agent Skill roots from the active lane worktree, ancestor and home
  `.claude` / `.agents` / `.ade` / `.codex` directories, inherited
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

iOS Work surfaces:

- `apps/ios/ADE/Views/Work/WorkRootScreen.swift`,
  `WorkRootScreen+Actions.swift`, `WorkRootScreen+Selection.swift`, and
  `WorkRootComponents.swift` — mobile Work list, filters, grouped
  session rows, and live-count/status pills. Agent CLI continuation is
  driven by sending text to the durable session, not a standalone
  row action. The earlier
  in-list activity feed is gone — running chats surface through the
  session list and the live-count chip.
- `apps/ios/ADE/Views/Work/TerminalSessionScreen.swift` and
  `SwiftTermSessionView.swift` — full-screen SwiftTerm-backed terminal
  surface for CLI sessions. It subscribes with `sinceOffset`, applies
  offset-stamped `terminal_data`, pages older transcript bytes via
  `terminal_history`, sends raw `terminal_input`, reports viewport
  changes as `terminal_resize`, and unsubscribes on disappear.
- `apps/ios/ADE/Views/Work/WorkArtifactTerminalViews.swift` —
  terminal artifact/output views and inline preview cards; the older
  lightweight terminal emulator remains here only for compact previews.
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
  bound to a single lane worktree and caller context.

## Session model

A session is a row in `terminal_sessions` (SQLite via `AdeDb`). The same
schema is used for:

- interactive shell PTYs (`toolType = "shell"`)
- managed processes launched by `processService` (`toolType = "run-shell"`)
- tracked CLI agent terminals (`claude`, `codex`, `cursor-cli`, `droid`,
  `opencode`)
- agent chat sessions that run through the Claude/Codex/Cursor/Droid/
  OpenCode SDKs rather than a PTY (`claude-chat`, `codex-chat`,
  `opencode-chat`, `cursor-chat`, `droid-chat`)
- other tracked tools (`cursor`, `aider`, `continue`, `other`)

Status transitions: `running` → `completed` | `failed` | `disposed` |
`detached`. `detached` means the durable row and transcript remain, but the
process-local PTY is no longer reachable from the current ADE runtime.

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
   `terminal_sessions` row through `sessionService.create()`. When
   `args.initialInput` is set, the service schedules a deferred write
   using the agent CLI input protocol (bracketed paste, chunked
   writes, provider-specific submit delay) after an optional
   `initialInputDelayMs` delay.

2. **Stream** — PTY `data` events are written to the transcript
   (capped at `MAX_TRANSCRIPT_BYTES = 16 MB`), throttled into a
   `lastOutputPreview`, forwarded to `broadcastData` with the transcript
   end offset when available, and scanned for runtime state signals
   (OSC 133 prompt markers).

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
   No tracked CLI PTY is auto-disposed just because a TUI returns to a
   waiting input prompt. Close/stop is explicit, so a resumed provider
   TUI is preserved even if ADE cannot prove that it is ready for input.

6. **Continue** — `work.sendToSession` reuses an existing session row
   when the user sends text to an ended agent CLI session and the PTY
   service opens the transcript in append mode. When the runtime is still
   live, it submits to that PTY directly. When the PTY is gone, it rebuilds
   the provider resume command, backfills a missing resume target on
   demand when possible (including Codex rollout storage during an active
   resume launch), creates a new PTY bound to the same durable session id,
   and includes the new prompt in that launch command when resume metadata
   is available. If another send arrives while the resume
   flight is already in progress, that later text is serialized and
   written after the PTY is attached. This keeps identity, lane
   association, and transcript history intact without killing the resumed
   runtime on a readiness timeout.

7. **Reconcile** — on startup, `reconcileStaleRunningSessions` marks
   orphaned `running` rows as `detached`. Ownership is gated through the
   process registry's live and known local owner sets: a row whose owner is
   live belongs to a sibling process (another desktop window, the `ade serve`
   daemon, an attached `ade code` TUI) and is left alone; a row whose owner is
   known on this machine but no longer live can be swept; a row whose owner is
   unknown is preserved because it may belong to another synced machine.
   Freshly started or recently-outputting rows get a short grace window before
   they can be detached, so a new runtime cannot immediately close a CLI
   session created by the process it just replaced. The service
   still accepts an `excludeToolTypes` option, but `main.ts` no longer
   passes chat tool types: chat runtimes always warm up afresh on app
   start, so leaving stale `running` chat rows behind only causes UI
   confusion. Ended chat sessions stay in the table and are resumable
   through the SDK (or removable via `ade.agentChat.delete`).

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
| `ade.pty.resumeSession` | prompt-free tracked CLI relaunch. Args: `{ sessionId, cols?, rows?, model?, reasoningEffort?, permissionMode? }`. Reuses a live PTY when attached; otherwise validates the row, backfills a missing resume target when possible, rebuilds the provider resume command, and spawns a continuation PTY in the same `terminal_sessions` row without writing a prompt. Returns `PtyResumeSessionResult` (`{ ptyId, sessionId, pid, session, resumed, reusedExistingRuntime }`). |
| `ade.pty.sendToSession` | send-or-continue. Args: `{ sessionId, text, cols?, rows?, model?, reasoningEffort?, permissionMode? }`. Submits text into the live PTY when one is attached; otherwise validates that the row is a tracked agent CLI session, backfills a missing resume target when possible, rebuilds the resume command via `buildTrackedCliResumeCommand` (honouring runtime overrides), spawns the continuation PTY in the same `terminal_sessions` row, and includes the user's text in the launch command when resume metadata is available. Later sends that land after a resume flight has started are serialized through the agent CLI input protocol: line clear, bracketed paste envelope, chunked 64-byte writes with 5 ms inter-chunk delay, then carriage return with a provider-specific submit delay. Returns `PtySendToSessionResult` (`{ ptyId, sessionId, pid, session, resumed, reusedExistingRuntime }`). |
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
  `running` chat rows are swept to `detached` like any other orphaned
  row after the startup activity grace expires. If you need a row to
  survive reconciliation, the caller has to pass `excludeToolTypes`
  explicitly.
- `transcriptPath` may be blank for untracked sessions (tracked=false)
  and for processes that died before their PTY opened — always
  null-check before reading.
- `resumeCommand` is derived from `resumeMetadata` when present, then
  falls back to `defaultResumeCommandForTool(toolType)`. Editing it
  directly is only allowed through `sessionService.setResumeCommand` or
  `updateMeta`, both of which re-derive the metadata.
- Transcript writes are capped at 16 MB; after the cap a notice line is
  written once and further output is dropped. The runtime seeds
  `transcriptBytesWritten` from the file size on attach, so the cap
  survives resume.
- Preview updates are throttled (~900 ms) and the string is capped at
  220 chars via `derivePreviewFromChunk`.
- Reconcile and dispose paths gate on `processRegistryService` live and
  known-owner sets. Adding a new sweep path that operates on
  `terminal_sessions` without consulting the registry can mark another
  process's live sessions dead or detach sessions owned by another synced
  machine — always run the candidate row set through the registry before
  disposing. The same heartbeat backs PTY cleanup: owner stamping happens
  inside `ptyService.create`, so any new lifecycle surface that bypasses
  that helper needs to write `owner_pid` and `owner_process_started_at`
  itself.
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
