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
and `window.ade.terminal.*` calls in
`apps/desktop/src/preload/preload.ts` route through
`callProjectRuntimeActionIfBound("pty", …)` /
`callProjectRuntimeActionIfBound("session", …)` first and use the
legacy in-process IPC handlers (the desktop's `ptyService.ts`,
`sessionService.ts`) only when no runtime is
bound, such as tests or pre-binding diagnostics. A local-bound daemon
failure is surfaced to the caller instead of being retried against the
desktop process. The same source files run on both paths. Remote-bound windows
now rely on the same terminal/session APIs as local windows.

Projectless personal chat has a deliberately narrower terminal path. Its
compact Terminal button creates a PTY through `PersonalChatScope` in the
machine's personal scratch workspace, records ownership in that scope, and
streams PTY events through `personalChats.streamEvents`. It does not expose the
project Work terminal/session inventory or accept an arbitrary lane/cwd. See
[Personal chats](../personal-chats/README.md).

These services are large and have been repeatedly rewritten. Treat `ptyService.ts` and `sessionService.ts` as fragile and re-read them whenever wiring changes.

## External session import

Users can browse provider-native CLI sessions created outside ADE and continue
or fork them inside Work. See
[External Session Import](external-session-import.md) for the intended use
case, provider storage formats, capability matrix, CLI/chat import paths,
mobile routing, authorization model, and current open items.

## Source file map

Service files. Same sources back the ADE runtime and the limited
desktop in-process path used before a binding exists, in diagnostics,
and in tests.

- `apps/desktop/src/main/services/pty/ptyService.ts` — PTY lifecycle,
  transcript capture with a 16 MiB physical retention ceiling and lifetime
  logical byte offsets, runtime
  state, AI auto-titles, tool-type routing, continuation-target backfill,
  session-id based write/resize entry points used by mobile sync
  terminal control, `readTranscriptTail({ sessionId, ... })` which
  merges the on-disk transcript tail with the live PTY output tail so
  Work/TUI terminal hydration can replay output that is still buffered
  in the transcript write stream, `getTranscriptWindow` /
  `readTranscriptSnapshot` for authoritative logical-offset hydration, and
  `readTranscriptRange({ sessionId, startOffset, endOffset })` for mobile
  scrollback/delta resume across rollover,
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
  prompt-free relaunch. Creating a new tracked agent CLI PTY is gated on
  disk pressure through the optional `diskPressureMonitor`
  (`canPerform("cli_launch")`): under `exhausted` pressure the create throws a
  `disk_full`-coded error instead of spawning. Transcript reads tolerate
  compaction — `readTranscriptTail` / `readTranscriptRange` transparently fall
  back to a `<transcript>.gz` generation via `readHistoryFileSync`, and create
  reinflates a compressed transcript (`reinflateHistoryFileSync`) before
  reopening it for append. `isTranscriptPathActive(path)` lets the history
  compressor skip transcripts a live PTY is still writing.
  `canAcceptScheduledTurn(sessionId)` is the scheduler's non-mutating delivery
  boundary: ended tracked CLIs are resumable, while live CLIs require a
  provider-specific visible composer marker plus the short quiet window before
  a durable prompt may be submitted. It also owns the richer CLI state
  projection: each `PtyEntry` carries an optional `TuiMarkerState` (created at
  spawn only for tracked agent CLI tool types, so shells and unknown tools
  allocate nothing) that is folded on the same chunk the OSC 133 scan already
  reads, plus a `previewCursor` threaded through `derivePreviewFromChunk`. The
  runtime-state entry gains `runningSince`, stamped only on a
  non-running → running *transition* and cleared on every non-running state —
  not `lastActivityAt`, which is re-stamped on every output tick and would
  render as "time since last write". `anchorTurnStart` / `isTurnSubmitWrite`
  re-anchor that turn when a user write ends in a newline (a literal Enter;
  bracketed-paste payloads contain newlines but never end in one), and the same
  write path calls `clearTuiWaitingInput`. The shared session-row projection —
  the one chokepoint desktop, lane snapshots, web, and iOS all read — then
  emits `currentTurnStartedAt` for non-chat rows, the `tuiRowOverlay` spread,
  and `runtimeState: "waiting-input"` when a marker latch is live.
  ~4,450 lines.
- `apps/desktop/src/main/utils/terminalTuiMarkers.ts` — the TUI marker packs
  that give PTY-backed CLIs the same vocabulary chat sessions already have
  (planning / waiting-on-you), mapped onto the existing `chatActivityMode` and
  `runtimeState` fields so no surface needs new rendering. `PACKS` is keyed by
  `TerminalResumeProvider` and covers claude, codex, cursor, opencode, and
  droid; anything without a pack resolves to null and does zero scanning.
  `scanTuiMarkers` does one bounded pass per chunk (`MAX_CHUNK_SCAN_CHARS =
  8_000` head plus the same tail, joined, with a `CARRY_CHARS = 512` carry
  across chunk boundaries) and `tuiActivityFromState` resolves it. The two
  marker shapes are deliberately asymmetric: **planning is a footer state**, so
  it is sticky with a `PLANNING_TTL_MS = 60_000` decay and needs no
  "left plan mode" event (none is reliably printed); **waiting-input is an
  event**, so it is an edge-triggered latch armed only when currently null and
  cleared only by evidence — a `working` marker painting after the prompt, or
  `clearTuiWaitingInput` when the user types. `WAITING_TTL_MS` (30 minutes)
  exists to bound a false positive, not to time out a human. Where a window
  contains both a prompt and the spinner that replaced it, the later match
  wins, and waiting-input outranks planning because it is the actionable one.
  Failure needs no markers: a nonzero exit already lands as `status: "failed"`.
- `apps/desktop/src/main/utils/terminalPreview.ts` — the one-line session
  preview builder. It is a real column-cursor model (`PreviewCursorState`,
  `createPreviewCursorState`, `derivePreviewFromChunk`) over a mutable cell
  array rather than an ANSI stripper, because stripping every CSI deletes the
  *gaps* that positioning sequences represent and renders a TUI's status line
  as run-together fragments. It scans escapes with a real state machine over
  ECMA-48 byte ranges and honours CUP/HVP, VPA, CUU/CUD, CNL/CPL, CHA/HPA,
  CUF/CUB, EL, ED, and ECH; vertical moves keep the column, because a real
  terminal does. `\r` returns the cursor but keeps the cells, since a
  self-rewriting progress line overwrites what it needs and clears the rest.
  Caps: `MAX_LINE_CELLS = 500`, `MAX_COL = 2_000` (tracked past the buffer,
  never allocated), `MAX_PENDING_CHARS = 2_048`, preview `maxChars` 220. A
  trailing partial escape is carried across chunks — PTY chunks split mid-CSI
  often enough that per-chunk stripping leaked `[53;37H` into previews as
  literal text — and on overflow the carried tail is re-anchored on its last
  `ESC` so a blind slice cannot write escape garbage into the preview.
- `apps/desktop/src/main/utils/terminalTuiMarkers.test.ts` — pack matching,
  latch arming/clearing, and ordering coverage.
- `apps/desktop/src/main/services/pty/supervisedPtyHost.ts` and
  `ptyHostWorker.ts` — isolated node-pty worker host. Local runtimes fork the
  worker from the built desktop files; remote runtimes can receive
  `ADE_PTY_HOST_WORKER_PATH` + `ADE_PTY_HOST_WORKER_NODE` or
  `ADE_PTY_HOST_WORKER_COMMAND` from remote bootstrap so PTYs run through the
  uploaded worker/static runtime instead of relying on a source checkout.
- `apps/desktop/src/main/services/pty/resourceUsageSampling.ts` — the
  async, coalesced machine process sampler behind the TopBar
  resource-pressure indicator. Owns `createProcessMetricRowsCollector`
  (bounded, timeout-guarded `ps` collector that coalesces callers and never
  rejects), `classifyProcessRoles` (disjoint per-PID attribution into
  Electron / `ade-runtime` / `ade-pty-host` / `provider-agent` / `shell` /
  `unknown` roles, claiming explicit roots before any descendant walk), and
  `computeAppResourceUsageSnapshot` (folds Electron `getAppMetrics()` and
  system memory in, skips the `ps` sample when nothing is active). Driven by
  the `ade.app.getResourceUsage` handler in `registerIpc.ts`;
  `ptyService.getResourceAttribution()` supplies the live PTY roots + kinds.
  See [pty-and-sessions.md](./pty-and-sessions.md#resource-pressure-attribution).
- `apps/desktop/src/main/services/pty/resourceUsageSampling.test.ts` —
  collector coalescing/timeout/bounds and role-classification tests.
- `apps/desktop/src/main/services/pty/ptyService.test.ts` — PTY behavior
  tests. Branch updated.
- `apps/desktop/src/main/services/sessions/sessionService.ts` — persistence
  layer for `terminal_sessions` rows. CRUD, continuation metadata
  normalization, `reattach`, `reconcileStaleRunningSessions`, and the durable
  settled/status-note/attention/last-turn-failure mutations. Normalized
  `TerminalResumeMetadata` retains optional `orchestrationParentSessionId` /
  `spawnKind`; tracked agent CLI rows project those fields onto
  `TerminalSessionSummary`, and resume-command backfill merges the existing
  metadata so lineage survives continuation. New user turns clear settle,
  attention, and failure markers; PTY output clears settle without erasing
  an agent-authored status note. It also owns the snooze overlay
  (`snoozeSession` / `wakeSession` / `snoozeSessions` / `wakeSessions` /
  `wakeSessionIfSnoozed` / `clearWokeMarker`) and the settle override
  (`setSettleOverride` / `setSettleOverrides`); `requestAttention`,
  `markLastTurnFailed`, and `clearLastTurnFailed` are the three early-wake
  trigger sites, and only `markLastTurnFailed` applies the
  newer-than-`snoozed_at` comparison. Reconcile and
  ownership-aware queries gate row sweeps on both live owners and known local
  owners from `processRegistryService`: a `running` row whose owner is live
  belongs to a sibling and must be left alone; a row whose owner is known on
  this machine but no longer live can be marked `detached`; a row with an
  unknown owner identity is preserved because it may have synced from another
  machine. Its transcript-tail read transparently falls back to a
  `<transcript>.gz` generation (`readHistoryFileSync`) so a compacted chat
  transcript still replays. ~580 lines. Branch rewrite.
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
- `apps/desktop/src/main/services/sessions/chatSessionProjection.ts` —
  canonical bridge from `AgentChatSessionSummary` runtime truth to the
  `terminal_sessions` row used by Work, detail reads, ADE runtime actions,
  and lane snapshots.
  It projects active/idle/waiting state, pending input, the live
  `currentTurnStartedAt` timer anchor, wake time, and orchestration lineage.
  If chat hydration fails, a persisted resumable
  `status = "running"` row falls back to quiet idle/waiting instead of
  presenting a false live/green agent.
- `apps/desktop/src/main/services/sessions/settleTerminalSession.ts` —
  single settlement transaction shared by direct IPC and the ADE action
  registry. Settle stops the machinery the session owns before it writes the
  lifecycle column — see
  `apps/desktop/src/main/services/sessions/sessionMachineryTeardown.ts`. It
  calls `agentChatService.stopBackgroundWork`, which stops every live child
  before the parent. Every settle entry point runs it, including the CTO
  operator's `settleSession` tool, because the teardown has to finish *before*
  the lifecycle write. **Scheduled work is deliberately left running**: pausing
  it would be durable, and `settled_at` is cleared from seven places (including
  the hot `setLastOutputPreview` path), so a pause without a complete undo would
  silently disable a user's own monitors and crons forever. ADE's scheduled work
  is already visible and user-manageable (`scheduledWork` / `nextWakeAt` on the
  summary, a per-session pause toggle), and `canonicalSessionState` already
  handles a settled chat woken by a schedule — green while the turn streams,
  then re-settled. **Terminal panes stay open**: an agent's background shell is
  thread background work, but a pane the user opened is theirs, and closing it
  on settle would destroy scrollback nobody asked to lose. An ACTIVE foreground
  turn is also left alone — its subagents are work the user can see happening,
  and the row un-settles on its own activity anyway. What escapes is stated
  rather than pretended away: processes an agent detached with
  `nohup`/`setsid`/`disown` leave ADE's tree entirely, and Codex background
  subagents are reported but expose no stop control. Every settle entry point
  runs it — the single/bulk ADE actions, the `sessions.settle`/`settleMany`
  IPC handlers, the `session.settle*` sync commands, and the PR-merge
  auto-settle (which files a session even when it still owns scheduled work or
  a live background task, and is therefore the path most likely to file one
  that is still running something).
  `dismissPendingInput: true`
  first quiets an SDK chat through `agentChatService`, or clears a tracked
  CLI's explicit `ade chat ask` marker through `ptyService`; arbitrary native
  terminal prompts are rejected because ADE cannot answer them truthfully.
  That dismissal is exported separately as `dismissPendingInputBeforeSettle`
  so the **bulk** settle paths — which must write through
  `sessionService.settleSessions` and keep returning the changed-id list — reuse
  the exact same semantic instead of inventing a second mechanism. It returns
  false when the row is missing and throws when there is nothing pending to
  dismiss, which is why the bulk sync command refuses the flag for more than one
  id (see
  [remote commands](../sync-and-multi-device/remote-commands.md#registry)).
- `apps/ade-cli/src/cli.ts`, `apps/ade-cli/src/adeRpcServer.ts` —
  `ade new chat --mode cli` forwards the parent chat id and spawn kind for
  agent providers; `start_cli_session` validates them and persists them in
  `TerminalResumeMetadata` without assigning `chatSessionId`. Plain shell
  sessions omit the fields.
- `apps/ade-cli/src/tuiClient/closedCliSessions.ts`,
  `apps/ade-cli/src/tuiClient/components/Drawer.tsx` — ADE Code projects spawn
  lineage from closed tracked CLI resume metadata and shows compact `sub` /
  `peer` markers for chat and CLI children in the session drawer; missing
  legacy lineage metadata stays visually quiet.
- `apps/desktop/src/main/services/sessions/sessionDeltaService.ts` —
  end-of-session git diff + transcript delta computation, reads from
  `session_deltas` table.
- `apps/desktop/src/main/services/lanes/laneLaunchContext.ts` —
  per-lane cwd resolution that gates PTY creation to the lane worktree.
- `apps/desktop/src/main/services/externalSessions/` —
  external CLI session discovery and import. `externalSessionsService.ts`
  orchestrates provider discovery, capability flags, project/all scoping,
  already-imported detection, active-session hints, CLI import into tracked
  PTYs, chat import delegation, cwd checks, and provider-specific resume/fork
  commands. The per-provider discovery modules scan Claude JSONL transcripts
  under `~/.claude/projects`, Codex threads from the `~/.codex/state_5.sqlite`
  thread store (falling back to the `sessions/` rollout tree only when that
  database is unusable), Cursor artifacts under `~/.cursor/chats` and
  `~/.cursor/projects`, Droid sessions under `~/.factory/sessions`, and
  OpenCode through `opencode session list`.
  `claudeSessionTransplant.ts` performs the non-destructive Claude JSONL copy
  used when forking or importing a Claude session into a different lane cwd;
  `claudeLiveSessions.ts` reads Claude's own `sessions/<pid>.json` registry to
  tell a session that is open right now from one that merely has a recent file
  mtime; `importedSessionStore.ts` is the durable machine-local log of every
  import, which is what keeps the "already imported" badge alive after the ADE
  session is deleted and what records the new provider id a fork created;
  `discoveryUtils.ts` owns safe filesystem reads, cwd slug resolution, cheap
  previews, limits, and sorting. Deep detail:
  [external-session-import.md](external-session-import.md).

Shared types and IPC:

- `apps/desktop/src/shared/types/sessions.ts` — `TerminalSessionSummary`,
  `TerminalSessionStatus`, `TerminalToolType`, `TerminalRuntimeState`,
  `TerminalResumeMetadata` (including tracked CLI spawn lineage),
  `PtyCreateArgs`, `SessionDeltaSummary`, and the optional
  `currentTurnStartedAt` anchor used by active chat Working timers,
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
- `apps/desktop/src/shared/sessionCanonicalState.ts` — canonical phase and
  status-bucket derivation shared by desktop and mirrored on iOS. Precedence is
  explicit/structured attention → declared settle at rest → stopped/failure/
  clean exit → stale/running/resting. It is the source of the one-word row capsule,
  Work grouping, and the loud-vs-quiet attention split.
  **Live background work promotes a resting session back to `running`.** A
  session whose foreground turn ended while its background shells, monitors, or
  subagent fleet kept going used to project to `ready`/`idle`, so the Work-tab
  dot, the TopBar rollup, the dock badge and the Lanes agent list all showed
  nothing while agents were mid-run — the "Background work" copy existed but
  never reached the phase those surfaces derive from. The promotion also
  returns `liveness` (`"turn" | "background" | "monitoring"`), which is what the
  label reads; it is not a phase, because filing, buckets, the roster status and
  iOS's `AgentRunPhase` all want the three treated identically.
  `monitoring` is set only when watch loops are the SOLE live work — one real
  job among three monitors still reads as working.
  Classification is a **denylist** (`MONITOR_TASK_TYPES` / `INERT_TASK_TYPES`,
  via `classifyBackgroundWorkKind`): unknown task types count as WORKING,
  because an allowlist silently drops a real subagent the first time a provider
  SDK renames a type. Liveness is in-memory and deliberately empty after a
  restart — orphaned background work is not live work — and it sits BELOW
  failure, stopped, settled and stale in the precedence order, so a lingering
  "Working" can never mask a failed session.
  The **settle override** (`terminal_sessions.settle_override`,
  `null | "settled" | "active"`) is consulted at the declared-settle tier, i.e.
  `"settled"` behaves like a declared settle, and `"active"` is an explicit
  keep-active pin that suppresses a declared settle.
  It is cleared on real activity at the same write sites that clear
  `settled_at` (PTY output, `touchSessionActivity`, turn start, attention
  request, turn failure).
  **Snooze** lives in the same module but deliberately does NOT touch
  `canonicalSessionState()`: it is a synced *visibility overlay*
  (`snoozed_until` / `snoozed_at`), not a lifecycle phase. `isSessionSnoozed`,
  `isSessionSnoozeExpired`, `isWakingSessionError`, and
  `resolveSessionWakeReason` are the pure helpers desktop, `ade code`, and iOS
  all derive it from. Timer expiry is derived by comparing `snoozed_until` to
  now — there is no scheduler or watchdog. Early wake ("hand-raising") fires on
  a pending approval/input request, a session error **strictly newer than
  `snoozed_at`**, or a completed turn; the newer-than comparison is
  load-bearing, because otherwise the error the user snoozed on top of re-wakes
  the row instantly and snooze does nothing. Waking records `woke_at` /
  `woke_reason` so the UI can show a "woke" marker until the row is visited.
  A session that **ends in failure** (non-zero exit, or a `"failed"` end that
  never got an exit code) is an early-wake trigger too, at the `end` /
  `reconcileStaleRunningSessions` write sites. Filing yields to an explicit or
  provider-structured hand raise: `isSessionFiledAsSnoozed`
  (`shared/sessionCanonicalState.ts`, mirrored in
  `WorkSessionCanonicalState.swift`) returns false for a `needs_you` phase, so a
  snoozed row that is blocked on the user stays in its normal section on every
  surface. `isSessionSnoozed` remains the RAW column read the chips, menus, and
  wake labels use.
  `parseSessionSettleOverride` (`shared/types/sessions.ts`) is the single parser
  for a settle-override value crossing any boundary — IPC args, sync-command
  JSON, CLI flags, a SQLite text column. It returns `undefined` for unrecognized
  input so a typo can never be mistaken for "clear"; `"clear"` / `"none"` / `""`
  / null are the explicit clear sentinels, and clients that cannot encode a JSON
  null (iOS) send the string.
- `apps/desktop/src/shared/sessionStatusPresentation.ts` — the shared
  phase-to-label/glyph/tone/prominence vocabulary consumed by the Work sidebar
  and Activity surfaces and mirrored by iOS widgets/Activity drawer. Blue means
  work in flight, amber is reserved exclusively for `Needs you`, emerald is a
  clean unseen outcome, red is failure, and neutral is true but non-actionable.
  A session running only because of background work is named for what it is —
  **Background work** / **Background work ×N**, or **Monitoring** / **Monitoring
  ×N** when watch loops are all that is left — rather than reusing the bare
  **Working** of a live turn, and it sets `showsElapsed`, so the row carries a
  duration instead of an unfalsifiable claim that the model is still thinking.
  Plan mode is a property of a live turn only: a background-promoted row never
  reads **Planning**.
  It also owns the short working-duration formatter; renderer icon components
  map its dependency-free glyph ids to platform symbols.
- `apps/desktop/src/renderer/lib/sessionSnooze.ts` — the desktop half of snooze
  presentation. The derivations themselves live in `shared/sessionCanonicalState.ts`
  and are shared with `ade code` and iOS; this module owns the re-export plus the
  client-side deadline math behind the duration menu.
  `SNOOZE_DURATION_OPTIONS` is the fixed-order static superset, shortest window
  first: `In 1 hour`, `This evening` (local 18:00), `Tomorrow` (local 09:00),
  `Next week` (next Monday 09:00, a full week out when today is Monday), and
  `Until I'm asked`. The last one has no clock deadline, so it parks the row
  ~100 years out — only a hand-raise (needs-you / error / turn complete) brings
  it back, and any deadline past a year reads as open-ended rather than a
  countdown. Labels name the DAY, never the clock time, because every menu
  renders a separate time column beside them.
  `resolveSnoozePresets(nowMs)` is what the menus actually render: it resolves
  each row's `whenLabel` (the time column: "9:00 AM", "Mon 9:00 AM", "on a
  hand-raise") and `untilIso` against local time, and drops `This evening` once
  18:00 is within an hour (it would duplicate `In 1 hour`) or already past (the
  row would silently mean *tomorrow* evening). `Until I'm asked` is never
  suppressed and always sorts last. Callers must not cache the result at module
  load — a long-lived process would freeze the suppression decision at startup.
  Day arithmetic advances by calendar day, never by `+24h` in milliseconds: a
  spring-forward day is 23 hours, so a fixed offset from 23:30 skips the whole
  next day.
  `snoozeDeadlineIso`, `snoozeConfirmationLabel`, `snoozeWakeLabel`
  ("wakes in 3h" / "wakes tomorrow" / "wakes when asked" / "wakes now"),
  `snoozeWakeDescription` (the absolute wake time for menus and toasts —
  "9:00 AM" / "tomorrow 9:00 AM" / "Mon 9:00 AM" / "Apr 20, 9:00 AM" /
  "when you're asked"), `sessionWokeMarker`, and `nextSnoozeDeadlineMs` are the
  exported helpers; nothing here reads or writes a canonical phase.
- `apps/desktop/src/renderer/components/terminals/sessionLifecycleActions.ts` —
  one place for the Work tab's snooze / wake / settle-override writes, so the
  sidebar row menu, the row context menu, and the chat header chips can never
  disagree about what an action does or the copy it confirms with. Snooze
  computes the deadline client-side and hands it over as a concrete ISO instant
  (expiry is derived from it everywhere, so no scheduler is involved) and offers
  a five-second undo toast; failures surface as error toasts rather than silent
  no-ops. Exports `snoozeSessionForDuration`, `wakeSessionNow`,
  `setSessionSettleOverride`, and `clearSessionWokeMarker`.
- `apps/desktop/src/renderer/components/terminals/SessionSnoozeControl.tsx` —
  snooze affordance mounted in `SessionStatusSlot`'s action cluster. The hot
  Work list pays only for a single always-mounted button plus menu state that
  exists after a click. The duration menu is a locally-owned fixed popover
  clamped to the viewport like `SessionContextMenu`, with no document-level
  listener. Already-snoozed rows offer **Wake now** instead of the duration
  list.
- `apps/desktop/src/renderer/components/terminals/SessionStatusLabel.tsx` —
  the pure label half of the slot below: shared glyph id to Phosphor icon, tone
  class, and the elapsed/countdown text. It was extracted so the account-wide
  Activity card can speak the same status vocabulary **without** inheriting the
  slot's mutation controls, which act on this Mac's local session service and
  would be wrong — sometimes destructively so — on a row that belongs to
  another machine. Anything both surfaces must agree on belongs here.
- `apps/desktop/src/renderer/components/terminals/SessionStatusSlot.tsx` —
  the row's single status surface and no-layout-shift hover/focus action swap.
  It renders `SessionStatusLabel` and adds the mutations: it ticks running
  elapsed time from immutable `currentTurnStartedAt` for **every** session
  type, not just chat, falling back to last activity for legacy rows — a CLI
  repainting its TUI would otherwise reset the timer every few seconds, because
  last activity is time-since-last-output. It keeps Stale elapsed time on last
  activity, ticks idle scheduled-work countdowns, and
  replaces the status label with snooze plus binding-aware settle/un-settle
  controls while the row is hovered or keyboard-focused.
- `apps/desktop/src/renderer/components/terminals/SessionHoverCard.tsx` —
  one-second hover-intent detail pane positioned to the right of the full-bleed
  source row. Direct row-to-row movement after a card opens hands off
  immediately; any other entry earns a fresh delay. It renders icon-led facts,
  supports clickable PR/parent-thread rows, cancels on scroll/resize, clamps to
  the viewport, and uses a reduced-motion-aware fade/slide.
- `apps/desktop/src/renderer/components/work/SessionLifecycleChips.tsx` —
  ambient settled/snoozed chips for a chat surface header, mounted by
  `WorkSurfaceHeader` through its `lifecycleSessionId` prop. A chat pane
  otherwise has no lifecycle awareness at all: a settled or snoozed chat looks
  identical to a live one once you are inside it. State is resolved from the
  same derived helpers the Work sidebar uses (`sessionCanonicalUiState` +
  `isSessionSnoozed`), so a chip and its sidebar row can never disagree.
  `useSessionLifecycleSnapshot(sessionId)` reads the row out of the per-project
  session cache the Work tab already mirrors into the app store, so there is no
  extra IPC. These are header chips; the slot above the composer belongs to lane
  branch drift (`LaneBranchDriftStrip`).
- `apps/ade-cli/src/sessionSnoozeDuration.ts` — snooze duration grammar shared
  by the `ade session snooze` planner in `cli.ts` and `ade code`'s
  `/session snooze`, extracted so there is exactly one answer to "what does
  `1.5h` mean" and exactly one cap (`MAX_SNOOZE_MS`, 30 days — beyond that it is
  almost certainly a typo, and no scheduler exists that could walk the deadline
  back). It accepts an integer or one-decimal amount plus a unit suffix
  (`30m`, `1h`, `1.5h`, `4h`, `1d`, `1w`); a bare number reads as minutes. It
  returns a result union (`{ ok: true, ms }` or
  `{ ok: false, code: "invalid" | "too-short" | "too-long", message }`) instead
  of throwing, so `cli.ts` can re-throw a flag-worded `CliUsageError` while the
  TUI switches on `code` to write copy that never mentions a flag the user did
  not type.
- `apps/ade-cli/src/tuiClient/sessionLifecycle.ts` — `ade code`'s half of the
  lifecycle surface: argument parsing for the `/session snooze | wake | settle |
  unsettle | keep-active` slash commands and the text-only row markers the
  drawer and right-pane chat list render. Everything semantic is imported rather
  than re-derived — `isSessionSnoozed` / `isSessionFiledAsSnoozed` from
  `sessionCanonicalState.ts`, wake and woke-reason copy from `sessionSnooze.ts`,
  duration grammar from `sessionSnoozeDuration.ts`. `/chat settle` and
  `/chat unsettle` keep their own active-only dispatch in `app.tsx`.
- `apps/desktop/src/renderer/webclient/adapter/sessionLifecycleOverlay.ts`,
  `adapter/sessionLifecycleSupport.ts`, and `shell/sessionLifecycleChrome.ts` —
  the hosted-web halves. ADE Web has no local database, so every lifecycle
  mutation is a sync round-trip: the overlay paints an optimistic patch over the
  mirrored session rows and retires it by reconciliation, rejection, or TTL;
  the support module gates the controls on the host advertising `session.*` in
  `hello_ok.features.commandRouting.actions`; the chrome module gives the
  desktop component's hover-revealed control a coarse-pointer touch target.
  See [Web client](../web-client/README.md).
- `apps/desktop/src/renderer/hooks/useAppWideSessionAttention.ts` —
  event-driven application-wide session attention owner. It refreshes the
  active project's shared session cache on PTY/chat/session events, focus, and
  a visible-window recovery interval; publishes canonical counts to the app
  store; and mirrors only loud `needs_you` rows to the macOS Dock badge.
  Project switch/close cleanup prevents an old async refresh from leaking
  counts into the new surface.
- `apps/desktop/src/shared/types/externalSessions.ts` —
  `ExternalSessionProvider`, `ExternalSessionCapabilities`,
  `ExternalSessionSummary`, `ExternalSessionListArgs`,
  `ExternalSessionImportArgs`, and `ExternalSessionImportResult`. This is
  the canonical DTO surface shared by desktop IPC, the ADE action domain,
  `ade code`, sync remote commands, and iOS.
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
  `terminal_exit`, `terminal_input`, `terminal_input_ack`,
  `terminal_resize`) for iOS/web Work surfaces, including logical transcript
  offsets, `sinceOffset` delta resume, authoritative full snapshots,
  input-id dedupe/ack metadata, `live` backing-PTY status, and
  pull-to-load-older history pages, plus
  the mobile CLI launcher payload
  (`SyncCliLaunchProvider`, `SyncStartCliSessionArgs`,
  `SyncStartCliSessionResult`) consumed by the
  `work.startCliSession` remote command and the external-session remote
  command aliases (`SyncListExternalSessionsArgs` /
  `SyncImportExternalSessionArgs`) consumed by
  `work.listExternalSessions` and `work.importExternalSession`.
- `apps/desktop/src/renderer/webclient/sync/client.ts` and
  `adapter/sessionsPty.ts` — hosted-web terminal watermark/recovery state and
  the `window.ade` PTY bridge. Duplicate/overlapping live ranges are dropped or
  UTF-8-trimmed, one gap resubscribe requests the missing suffix, and an
  authoritative full snapshot is surfaced as `PtyDataEvent.replace`.
- `apps/ade-cli/src/services/sync/syncHostService.ts` — remote terminal
  subscription barrier and input boundary. It installs the barrier before
  reading a logical transcript snapshot, queues concurrent data/exit events
  within 256 events / 2 MB, trims snapshot overlap, and recaptures up to four
  times rather than exposing a gap. Its terminal-input ledger deduplicates
  stable input ids before PTY write and acknowledges success/duplicate/failure
  to ACK-capable web/iOS clients.
- `apps/desktop/src/shared/ipc.ts` — channels `ade.sessions.*`,
  `ade.pty.*` (including `ade.pty.sendToSession` — the send-or-continue
  channel that writes into a live agent CLI runtime or starts the
  provider continuation internally — and `ade.pty.resumeSession`, which
  relaunches an ended tracked CLI session without sending a prompt),
  the session-owned `ade.terminal.*` family (`list`, `read`, `preview` —
  serialized xterm snapshot for the TUI / mobile renderers, `write`,
  `signal`, `activeForChat`), and the localhost-probe helper
  `ade.localhost.probePort`, plus `ade.externalSessions.list` and
  `ade.externalSessions.import`.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.sessions`,
  `window.ade.pty` and `window.ade.externalSessions` APIs. The external-session calls prefer
  the runtime `external-sessions` ADE action domain and fall back to the
  legacy desktop IPC handlers only when no runtime binding exists.
- `apps/desktop/src/preload/global.d.ts` — renderer-visible typing for
  the `window.ade.externalSessions.list/import` bridge.

IPC registration:

- `apps/desktop/src/main/services/ipc/registerIpc.ts` — registers
  `sessionsList`, `sessionsGet`, `sessionsUpdateMeta`, `sessionsSettle`,
  `sessionsUnsettle`, `sessionsSettleMany`, `sessionsUnsettleMany`,
  `sessionsReadTranscriptTail`, `sessionsGetDelta`, `ptyCreate`,
  `ptyResumeSession`, `ptySendToSession`, `ptyWrite`, `ptyResize`,
  `ptyDispose`, and the session-owned `terminalList` / `terminalRead` /
  `terminalWrite` / `terminalSignal` / `terminalActiveForChat`
  handlers, plus `externalSessionsList` / `externalSessionsImport`.
  `terminalRead` delegates transcript-tail reads to
  `ptyService` so attached terminal panels and `ade code` get the
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
  that sends a new prompt through `window.ade.pty.sendToSession`. Resume and
  continue share one request path (`runCliResumeRequest` +
  `finalizeCliResumeResult`) that resolves the row's pin through
  `resolveSessionRuntimePin` first, passes it to whichever call it is making, and
  remembers it against the resulting session/PTY id. A pinned resume leaves the
  local snapshot patch and lane selection to the cross-machine union's own sync
  round rather than inventing a local lane for a foreign session.
  It also owns `onSelectForeignRuntimeSession`: a CLI/shell row whose owning
  binding is still open is remembered as a per-session pin and opened in the
  current view state, and only a binding this window does not have open falls
  back to switching the project tab.
  Opening a row that carries a woke marker clears it
  (`clearSessionWokeMarker`): opening *is* the acknowledgement, since the marker
  exists only to explain an unexpected return.
  It also listens for the renderer-wide `ade:work:select-session` event
  used by orchestration panels and lineage links; the listener uses the
  supplied lane when present or resolves it from the loaded session list,
  then focuses the target session, opens its Work tab, and updates
  `selectedSessionId`.
  Also owns the right-edge `WorkSidebar` toggle and resizer: when the
  sidebar is open and the view mode is not `grid`, the work view area
  shares its row with `WorkSidebar` via a flex container with a
  draggable column separator. `useWorkLaneDeleteProgress` subscribes to
  lane-delete events while Work is active, hydrates any backend deletion
  already in flight, and refreshes both the lightweight lane list and the
  uncached Work session list when deletion finishes. The active lane's work
  surface is covered by a non-interactive deletion overlay until that refresh
  succeeds; failed refreshes retry twice with bounded backoff before clearing
  the overlay and surfacing a sticky error toast.
- `apps/desktop/src/renderer/components/terminals/importSessions/` —
  desktop two-stage import browser/details flow and bridge contract. It lists
  external sessions by provider/search, counts meaningful user prompts, shows
  cwd/imported/active state, lets the user choose a target lane on the details
  screen, and offers only the safe `Continue`/`Copy` actions for ADE chat or
  CLI (including an explicit `Continue in original folder` when a provider is
  cwd-locked). `sessionPresentation.ts` keeps title-free path/time headings
  separate from prompt previews.
- `apps/desktop/src/shared/externalSessionAffordances.ts` — pure shared
  capability-to-action policy consumed by both desktop and `ade code`, so the
  two surfaces expose the same safe Continue/Copy choices.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` —
  Work draft/new-chat surface. In draft mode the lane picker stays at
  the top, with Shell and Import buttons below; Import opens
  `ImportSessionBrowser` when the caller provides `onImportedSession`.
  Auto-created lane launches keep import disabled because there is no
  existing target lane to import into yet.
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
  sticky group headers, search/filter, and two quiet tails: Snoozed and
  Settled. Snoozed sits one tier above Settled and is fed by the separate
  `snoozedFiltered` partition `useWorkSessions` computes, because snooze is a
  visibility overlay rather than a status — a snoozed row is pulled out of
  whichever status bucket it would otherwise land in. Status mode renders both
  as their own collapsed-by-default sections; lane mode puts collapsible
  snoozed and settled tails inside each lane; time mode keeps both in final
  sections rather than mixing them into creation-time buckets. Rows in either
  tail stay reachable through those sections; there is no separate Tiers/Show
  settled filter because Status grouping already exposes the full lifecycle.
  Collapsed tails are excluded from shift-range selection so a hidden row cannot
  enter a bulk action accidentally. Group headers carry an explicit
  `role="heading"` with a `"<label> (<count>)"` accessible name so a screen
  reader can navigate to a group rather than inferring it from a bare toggle.
  In lane organization, a lane whose complete unfiltered roster is snoozed or
  settled starts as one thin muted header with inline snoozed/settled counts;
  the nested quiet tails are omitted while it is collapsed. Expanding it
  restores the normal lane header and compact quiet rows. Quiet expansion uses
  the inverted `lane-open:<laneId>` marker, which is removed when active work
  returns so the next quiet spell collapses automatically. The classification
  runs through `sessionFilingBucket`, the shared canonical-lifecycle-plus-snooze
  filing helper, whose `needs_you` precedence is
  load-bearing: filtering or snoozing must never fold a row that is waiting on
  the user into the quiet header.
  Renders a bulk action bar at the bottom when sessions are multi-selected
  (Stop N running / Settle N / Delete N ended / clear selection), and offers an
  eight-second undo after bulk settle. The filter panel is width-constrained by
  the surrounding Work split, so status/group options wrap in an
  auto-fit grid and the embedded lane selector can fill its parent.
  Lane group headers expose the same lane context menu used by the Work
  tab so color, manage, split, and batch actions stay reachable without
  leaving the session list. The list is a **cross-machine union**
  (`useCrossMachineLaneUnion` from `renderer/state/crossMachineLanes.ts`): chats
  in flight on every connected machine appear regardless of which machine the
  project tab is bound to. The pane hands the union its **unfiltered** local
  roster so a session it already renders is never also rendered as a foreign row;
  passing the visible rows instead would make a chip-filtered session reappear
  from the other side, because ownership is a question of shape, not
  visibility. A lane not on the **physical Mac** running ADE carries
  one amber `DesktopTower` marker — always a glyph in the sidebar, with the
  machine name on hover. The tab's binding only decides where a row renders; it
  never changes whether the work is marked as elsewhere. This makes an unmarked
  row mean "here" even in a remote-bound tab. A one-session foreign lane has no
  divider, so its card carries the same glyph; cards beneath a real lane header
  suppress the repeated marker. Foreign lanes are listed only when they
  have sessions, after the same search and lane filter the local list applies, so
  the union stays "work in flight" rather than an inventory of every lane
  everywhere; the empty state accounts for them, so "No sessions" cannot claim an
  empty machine while another is busy. Foreign lanes use the same active /
  snoozed / settled partition, collapsed-by-default fully quiet header, quiet
  counts, and nested quiet-tail renderer as local lanes. Their persistence keys
  include the owning machine id (`<machineId>:<laneId>`), and an explicit
  `lane-open:` marker is cleared when active foreign work returns so a future
  quiet spell starts collapsed instead of inheriting stale expanded state.
  Every foreign row carries its owning `OpenProjectBinding`. Both chat and
  CLI/shell rows open **in place** through a per-session runtime pin, leaving the
  project tab pointed wherever the user put it — rebinding would drag Lanes, PRs,
  and Files to the session's machine. They differ only in who resolves the pin: a
  chat's is derived from its lane by `AgentChatPane` itself, while a CLI/shell
  session's is handed to the PTY surfaces through the page's
  `onSelectForeignRuntimeSession` handler. Rebinding the tab survives as the
  fallback for the one case that has nothing to pin to: the owning binding is not
  open in this window. Row/lane context actions pass the same binding so
  mutations cannot fall through to the active machine. A machine that goes
  offline keeps its rows, dimmed and folded shut: every card is inert and reads
  "<machine> is offline", the lane context menu's machine-bound actions are
  disabled from live store state rather than a flag captured at right-click time,
  and the group sorts below the reachable machines. Its branches still count
  toward "same branch elsewhere", because commits stranded on a machine you
  cannot reach are the ones most worth naming — the same reason the
  push-divergence guard reads the retained slice. A lane with shared delete
  progress is dimmed and
  interaction-blocked: its lane-group header shows the deletion status, and
  every session card for that lane is disabled in lane, status, and time
  organization modes. The bottom Add Lane button opens
  `CreateLaneDialogHost` in `close-on-create` mode, so a new lane can
  be created from Work without navigating away; once the lane record
  exists, env setup continues detached and failures surface as a sticky
  retry toast. It also builds parent-title and live-child indexes from the
  unfiltered session list, so a lineage tooltip can name a parent hidden by
  the current lane/search filter. In Lane organization, the primary lane stays
  first and the remaining rows are ordered by the Work-only tiers pinned,
  active, and quiet; a Work pin overrides compact quiet styling without
  changing the Lanes-tab pin set. The funnel selects Activity, Name, Created,
  or Manual ordering inside those tiers. A non-primary header can be dragged
  before/after a header in the same tier; the native drag controller supplies a
  drop line plus edge autoscroll, seeds Manual from the on-screen order, and
  never permits a cross-tier move. The funnel also has Status and Tool
  multi-select chips (OR within a row), Has PR, and Dirty lane filters (AND
  across rows). Their shared pure matcher files status through
  `sessionFilingBucket`; the Has PR result reuses the coalesced PR snapshot
  that serves lane badges, and a filtered empty state identifies and clears the
  active chips.
- `apps/desktop/src/renderer/components/terminals/LaneMachineMarker.tsx` — the
  amber tower marker on a lane header, rendered only for lanes that are not on
  the physical Mac you are sitting at, so the common single-machine case pays
  nothing. It is always a glyph in the sidebar; the tooltip supplies the machine
  name. It has a dimmed form with its own `<machine>, offline` accessible name,
  and on an unreachable machine's row it is the only thing that says why the
  group has gone quiet.
- `apps/desktop/src/renderer/components/terminals/ForeignLaneContextMenu.tsx` —
  the right-click menu for a lane owned by another machine. Its `online` prop is
  read live from the store rather than captured at right-click time, so a machine
  that dims while the menu is open disables every action in it — they all run on
  the owning machine.
- `apps/desktop/src/renderer/state/crossMachineLanes.ts` — repository-scoped
  union loader and optimistic foreign-chat ownership bridge. A detached launch
  that targets a binding other than the active project is inserted immediately
  into that binding's machine slice with the resolved lane name. Pending
  summaries are keyed by binding and session id, survive stale in-flight
  foreign list responses, and are removed when the authoritative list returns
  the same id, the launch is deleted, or the two-minute optimistic window
  expires. This reconciliation prevents both a blank launch interval and a
  duplicate raw-id lane under the active machine.
  `buildCrossMachineLaneRows` accepts the local roster's session ids and keeps a
  single claim set spanning every machine slice, so one session is contributed by
  exactly one list — local first, then the first machine that reports the lane
  the session names. The hook stabilizes that id set by content rather than by
  the roster array's identity, because the roster is replaced wholesale by every
  session poll and keying on it would rebuild every foreign row, marker, and
  ordering on a timer. Foreign rows stay grouped by reachability, then use the
  same selected raw Work sort mode as local lanes; Created is the default, so
  live PTY output does not reshuffle shell rows, while Activity remains an
  explicit choice. Equal sort values fall back to the owning machine/lane key.
  Session and lane change feeds request an identity refresh but coalesce onto
  the shared visible-window cadence instead of restarting a remote read for
  every output tick.
  Its marker resolver separately distinguishes `isActiveBinding` (where a lane
  renders) from `isThisMachine` (whether it is marked): a remote-bound tab still
  marks all lanes that are elsewhere, even when it has no foreign union rows.
  It also owns presence: `applyReachability` decides, from the connection
  snapshot alone, which machines are live, which are dimmed, and which are
  forgotten. A drop is believed only once a reconnect attempt has completed and
  failed — `connecting` seen while dropped, then a non-connected state — with a
  45 s floor and a 120 s ceiling for a dial that never finishes; floor and
  ceiling are one deadline, not two rules. Two states have no attempt left to
  wait for and dim on the floor alone: an `idle` target that will not redial, and
  a `connected` machine whose repository cannot be re-proven, which is eligible
  for display but ineligible for refresh — calling it live would be a lie, so it
  dims, but it is not removed, because absence of proof is not proof of absence.
  `lastAttemptedAt` cannot answer any of this alone: a failed RPC over an
  established connection stamps it too, and that is the event most drops start
  with. The verdict lives in the store, not the tick — an already-dimmed machine
  brightens only by becoming eligible again, so leaving Work and coming back,
  which tears down the shared runtime and its drop records while the store slice
  survives, cannot flash the machine live for another floor; its retention
  deadline is re-anchored to its last successful read instead. Removal is
  reserved for a target missing from the snapshot, a connected machine that
  positively reports the repository missing *with* a resolvable origin to prove
  it by (`repoMatchFor` will say "missing" off a folder-name mismatch, and the
  scope's origin is re-resolved from the bound machine and can be transiently
  null), and 24 hours unreachable (`dropCrossMachineLanes`). A timer re-runs the
  check at the next deadline, since a machine held through its floor produces no
  further snapshot on its own, and the records are cleared on teardown and on
  scope change.
  Reads are visibility-gated: the loop stops entirely while the window is hidden
  and refreshes once on the way back. Chats are re-read every 10 s; the lane list
  has its own 30 s cadence because `lane.list` with `includeStatus` resolves a
  git status per lane and writes a state-snapshot row per lane on the other
  machine. A chat referencing a lane that machine has never reported forces the
  lane read immediately, so nothing is invisible while it waits — but only once.
  `resolveLaneCadence` owns that rule for both read paths and remembers the lane
  ids a completed read did not explain, because `session.list` does not filter on
  lane status while `lane.list` asks for `includeArchived: false`: a chat on an
  archived lane is permanently unresolvable and would otherwise demand a fresh
  `includeStatus` read on every tick, costing more than before the cadence
  existed. The cadence is stamped only when lanes were actually read, and only
  when the read resolved inside the scope that asked for it, so a response
  landing after a project-tab switch cannot suppress the new scope's first lane
  read.
- `apps/desktop/src/renderer/components/terminals/SessionCard.tsx` —
  full-bleed three-line Work row. Line one adapts pin, singleton lane, spawn
  lineage, drifted branch, diff, and last-activity identity around
  `SessionStatusSlot`; line two is the elastic title with a singleton lane's
  fixed-width PR badge at the right edge, directly beneath the status; line
  three keeps the sanitized preview, Claude TTL, failure exit code, and
  provider mark. A foreign singleton adds the fixed-width amber machine glyph to
  the line-one status cluster; grouped lane headers own repeated machine/PR
  identity. A lane with exactly one session has no redundant header and promotes
  the lane identity and PR navigation onto the card.
  After one second `SessionHoverCard` carries the lower-frequency metadata
  removed from the row (including clickable PR and parent-thread facts). The
  Lane labels on singleton rows and hover details show the shared animated
  `Naming lane…` placeholder while background identity generation is active.
  The title still warm-highlights when background AI naming lands, and
  `disabledReason` blocks selection, dragging, and the context menu during lane
  deletion. Selection/hover use the row background; non-prominent lifecycle
  states recede instead of spending lane-tinted card surfaces.
- `apps/desktop/src/renderer/state/laneNamingStore.ts` — ephemeral,
  renderer-only zustand store tracking which lanes have an AI
  auto-naming pass in flight. `setLaneNaming(laneId, on)` is the
  imperative setter the draft-launch / parallel-launch flow toggles;
  `useLaneNaming(laneId)` is the label-side subscription. Bridges the
  draft-launch flow (which owns the naming lifecycle) to singleton cards,
  hover details, and grouped lane headers in a separate component tree.
- `apps/desktop/src/renderer/components/terminals/LaneNamingLabel.tsx` —
  shared reduced-motion-aware `Naming lane…` label with three animated dots;
  callers supply the resolved naming state so visible and accessible labels
  stay consistent.
- `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx` —
  tabs/grid/single Work view. The grid mode renders through the shared
  `PaneTilingLayout`; the seed tree comes from
  `buildWorkSessionTilingTree`. It builds a session-title index and threads it
  into locked `AgentChatPane` embeddings so spawned-chat roster rows use live
  child titles. Also hosts the chat-like continuation
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
  headers. Color/copy/reveal actions run inline, and **Manage lane** opens
  `WorkManageLaneDialogHost` in the same portal without changing the Work
  route or active session. Split, batch-manage, and the direct attached-lane
  adopt action still use `/lanes?action=...` deeplinks. The Work caller also
  supplies its own pin toggle and pin set, so the shared menu can offer **Pin
  to Work sidebar** without conflating it with Lanes-tab pins.
- `apps/desktop/src/renderer/components/terminals/WorkManageLaneDialogHost.tsx`
  — single-lane Work host for the shared `ManageLaneDialog`. It coordinates
  appearance/stack refreshes, archive, the attached-lane adoption confirmation,
  and delete while preserving the Work route. Delete closes the dialog
  immediately and seeds optimistic shared delete progress before dispatching
  the background lane teardown; an immediate dispatch failure clears only the
  matching optimistic record and surfaces a sticky toast.
- `apps/desktop/src/renderer/components/terminals/useWorkLaneDeleteProgress.ts`
  — Work-owned lane deletion synchronizer. It consumes `lanes.delete.event`,
  uses `lanes.onLifecycleEvent` as a completion/invalidation fallback, and
  calls `lanes.listDeleteProgress()` on activation so tab switches do not hide
  an in-flight delete. Terminal progress triggers uncached lane/session
  refreshes with bounded retry; failed/cancelled deletes and cleanup warnings
  are surfaced through shared toasts.
- `apps/desktop/src/renderer/components/work/WorkSurfaceHeader.tsx` —
  shared single-row Work surface header chrome used by both embedded
  chats and tracked agent CLI terminals. It owns the title, lane chip,
  Claude cache badge, lane git toolbar slot, and trailing-action
  placement so chat and CLI surfaces share one visual shell.
- `apps/desktop/src/renderer/components/work/ClaudeLoginPromptButton.tsx` —
  dismissible Claude auth recovery CTA. Chat headers render it after a
  Claude SDK auth error; CLI headers render it when a Claude terminal
  preview contains the `Please run /login` / 401 invalid-credentials
  failure. The action creates a tracked shell PTY in the same lane
  (and same chat drawer when there is a chat owner) running
  `claude auth login`.
- `apps/desktop/src/renderer/components/terminals/CliSessionWorkSurfaceHeader.tsx`
  — CLI adapter for `WorkSurfaceHeader`. It maps a
  `TerminalSessionSummary` to the shared header, adds the Claude login
  CTA when auth failure is detected, status dot, Run menu, info, and
  overflow actions, and intentionally leaves stop controls to the
  sidebar card / chat composer paths.
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
  terminals keep the native clipboard-image shortcut behavior. Selected terminal
  text copies through the local desktop clipboard bridge (with browser clipboard
  fallback for previews). Shift+drag remains available for local text
  selection when a full-screen CLI enables terminal mouse tracking; on macOS,
  ADE translates that gesture to xterm's Option-based force-selection path so
  remote and local CLI sessions behave the same. A recovery event with
  `replace: true` invalidates the hydration generation, clears queued frame/
  hydration writes, resets xterm, and writes the authoritative snapshot so an
  older async preview cannot repaint stale bytes after a gap repair.
  Accepts an optional `runtimePin`: the cached runtime records it, it is part of
  the runtime cache key, and every PTY/preview/transcript call the runtime makes
  carries it. Width correctness is a first-class concern here, because the same
  session can be mirrored by a desktop window and a hosted browser tab at once:
  a width-sensitive write only happens once `terminalWidthTrustworthy` holds
  (fitted at least once **and** `document.fonts.ready` settled), a terminal
  opened before its webfont arrived is forced to re-measure its cell
  (`remeasureTerminalFont`, since xterm only re-measures on a *changed*
  font family/size), a `replace: true` payload waits for a trustworthy fit on a
  20 × 60 ms budget before it is written (and is written anyway on exhaustion —
  blank is worse than rewrapped), and a later width change re-hydrates on a
  250 ms trailing debounce. Wheel routing follows iTerm2/kitty/VS Code: with
  mouse tracking on the wheel goes to the app unless Shift is held; with
  tracking off it scrolls locally only when scrollback actually exists. Zoom
  compensation sets the host's `zoom` to the reciprocal of the web client's
  zoom factor and scales `fontSize` instead, because xterm's hit-test divides a
  zoomed-space pixel offset by an unzoomed cell height and selects the wrong
  line further down the pane. Diagnostics print one `[ade-term]` line per event
  (`pty-resize-send`, `pty-resize-acked`, `snapshot-hydrate`,
  `rehydrate-after-fit`, `hydrate-normalize-declined`, `hydrate-complete`, …);
  a dims mismatch warns on **columns only**, since row disagreement is normal
  and columns are what decide wrapping.
- `apps/desktop/src/renderer/components/terminals/terminalTranscriptNormalize.ts`
  — the runtime-free transcript hydration helpers, split out of `TerminalView`
  so they are testable without a mounted terminal. `inferTranscriptColumns`
  reads the highest column any CUP/HVP/CHA sequence ever addressed, which is a
  lower bound on the width the transcript was recorded at;
  `normalizeTranscriptToGrid` replays the transcript through an offscreen
  headless xterm at that width and returns the resulting grid as plain
  `\r\n`-joined rows, which soft-wrap in any viewer. Without it, replaying
  host-width-keyed absolute cursor moves into a differently sized web viewer
  produces the diagonal "staircase". Caps: `MIN_VALID_COLS = 20` (below it a
  fit is a pane caught mid-layout, not a viewport, and normalization declines),
  400 columns, 96 rows; the result is clamped to the viewer's last N rows and
  trailing blanks are popped, because rows past the viewport land in scrollback
  and a nonzero `baseY` both paints a scrollbar and hijacks the wheel.
  `inferTerminalModesFromTranscript` recovers still-set DEC private modes
  (mouse tracking and encodings, cursor keys, origin, wraparound, focus
  reporting, bracketed paste, cursor visibility) so a hydrated web viewer keeps
  mouse tracking the desktop gets free from its serialized snapshot;
  alt-screen modes 1049/47 are deliberately excluded, since the normalized grid
  is written into the main buffer and switching buffers would hide it. These
  TUIs re-assert their modes continuously, which is what makes a tail-window
  scan viable — the known residual limit is a TUI emitting more than the 2 MB
  hydration window of quiet output after setting them, whose real fix is a
  host-reported modes field on the wire.
- `apps/desktop/src/renderer/components/terminals/ptySizeOwnership.ts` — size
  arbitration for the case where a desktop window and a hosted browser tab
  mirror the same session, both fit to their own element, and both push dims;
  the host applies last-writer-wins, so the CLI wraps at one viewer's width
  while the other renders at another. `installPtySizeOwnershipTracking` (called
  on mount, not at import, so tests inherit no document listeners) stamps the
  last local interaction from capture-phase `pointerdown`/`keydown`/`focus`,
  and `windowOwnsPtySize` answers: a hidden document never owns the size
  whatever else holds, a focused one always does, and otherwise ownership
  survives `OWNERSHIP_IDLE_MS = 60_000` of idleness. The timestamp is seeded at
  module load so a freshly opened viewer owns the size immediately rather than
  queueing behind a long-running background mirror. A non-owning fit
  deliberately does **not** advance `lastDims` — recording unsent dims would
  make the next fit a no-op and strand the PTY at the other viewer's width —
  and `force` on a resize means only "send even though dims look unchanged",
  never an ownership override. Two simultaneously foregrounded viewers still
  need host-side arbitration; that is out of scope here. A pin change relocates a mounted session to a new key, so
  `ensureRuntime` sweeps the runtime stranded at the old key
  (`teardownRelocatedRuntimes`) before reusing or creating one — otherwise the
  orphan would hold its PTY subscriptions open forever and a second xterm would
  be built for the same PTY. PTY data/exit subscriptions and the main-side id
  filter are grouped per pin, and the unpinned local path keeps its original
  single listener, single signature, and one-argument preload calls.
- `apps/desktop/src/renderer/components/terminals/terminalMacShiftSelection.ts`
  — macOS-only capture bridge used by `TerminalView`. While terminal mouse
  tracking is active, it converts an unmodified left-button Shift+mousedown
  into the Option+mousedown gesture recognized by xterm when
  `macOptionClickForcesSelection` is enabled, preserving local text selection
  without forwarding the gesture to the CLI.
- `apps/desktop/src/renderer/components/terminals/workSessionTiling.ts` —
  pure helper that produces the seed `PaneSplit` for the Work grid from
  an ordered list of session IDs. Accepts a `TilingPreset` of
  `"auto"` (default — single-column for ≤1 session, single row when
  `ceil(sqrt(n)) == n`, otherwise a vertical stack of horizontal rows
  with counts distributed by `rowSizes`), `"rows"` (one full-width row
  per session), or `"columns"` (one column per session). The
  `WorkViewArea` arrange menu rewrites the persisted tiling tree when
  the user picks a non-auto preset.
- `apps/desktop/src/renderer/lib/workGrid.ts` — pure grid-set membership
  ops (`addSessionBesideTarget`, `removeSessionFromGrids`,
  `findGridSetForSession`), the drag-and-drop mime
  (`GRID_SESSION_DND_MIME`), and `MAX_WORK_GRID_TILES` — the hard bound
  on how many sessions one grid set may hold, because every tile renders
  a full live session surface. See
  [ui-surfaces.md](./ui-surfaces.md#gotchas) for the three places that
  cap is enforced.
- `apps/desktop/src/renderer/components/ui/PaneTilingLayout.tsx` +
  `paneTreeOps.ts` — recursive pane tree component + pure operations
  (`reconcilePaneTree`, `splitPaneAtEdge`, `swapPanes`, `removePaneFromTree`,
  `detectDropEdge`) shared by every tiled surface, including the Work grid.
- `apps/desktop/src/renderer/components/terminals/useWorkMachineRouter.ts` —
  the Work tab's single per-session runtime routing authority, and the CLI/shell
  counterpart to the chat pane's router. It builds a `ChatMachineRouter` from the
  same shared helpers (`collectOpenProjectBindings` +
  `buildChatMachineRoutingState` in `renderer/lib/chatMachineRouting.ts`) over
  the active binding, open remote tabs, open local project roots, and every
  cross-machine machine slice, then adds `pinForSession` / `rememberSessionPin` /
  `forgetSessionPin` on top. `pinForSession` resolves lane ownership first and
  falls back to the remembered launch pin from `cliLaunch.ts`; a pin that equals
  the active binding collapses to `null` so every local session keeps the
  unpinned fast path and its local IPC fallback. The remembered foreign pin is
  deliberately **not** liveness-gated: the cross-machine lane scope is replaced
  wholesale while it reloads, so a healthy binding briefly vanishes from the open
  set, and dropping the pin in that window would query the tab's machine, discard
  the parked terminal buffer, and hydrate a foreign session id there. Click-time
  rebinding still consults `isLivePin`. `useWorkSessions` owns the single
  instance and re-exports it as `machineRouter` / `resolveSessionRuntimePin`;
  nothing else in Work constructs one.
- `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts` —
  hook that owns work view state (open items, active tab, draft kind,
  view mode, filters) and persists it to `localStorage` under
  `ade.workViewState.v1`. Lane/status deeplinks layer a transient
  `deeplinkViewOverride` over the saved project state instead of rewriting
  grouping and collapsed sections; an explicit filter, organization, or
  section change clears the framing. Invalidates the shared session-list cache
  and schedules a background refresh on window focus /
  `visibilitychange` and on chat events, so returning to Work after a
  tab switch always renders the current session set. Renderer-local
  chat-session creation announcements are also inserted optimistically and
  followed by a background refresh, so a headless batch-created chat appears
  without waiting for session-list convergence. Fresh PTY launches
  are inserted as optimistic sessions before the forced
  session-list refresh returns, which keeps the new terminal tab visible
  even when the runtime cache responds with a stale list. During project
  switches it hydrates the destination project's cached rows but marks them
  non-authoritative until the active project refresh returns; cache mirroring
  and open-tab pruning pause during that window so the previous project's
  sessions cannot poison the new project's Work state. `canMutatePinnedProjectUi`
  delegates to the machine router's `isLivePin`, gating pinned updates on whether
  the pinned binding is still **open**, not on whether it is the active one: a
  pin that differs from the active binding is the normal state of any session
  whose lane lives on another open machine, so only a pin for a closed project is
  discarded. `stopRuntime` resolves the row through the combined union map and
  asks `machineRouter.pinForSession` for its binding, so disposing a foreign PTY
  reaches its owning machine while local PTYs keep the unpinned call; `stopAll`
  runs every running row in that same union through `stopRuntime` (chat rows
  without a PTY are skipped).
  Remote-bound projects
  use a slower running-session refresh cadence and skip visibility-triggered
  refreshes unless hidden changes were observed, reducing background SSH
  chatter. `launchPtySession`
  accepts `WorkPtyLaunchArgs` and returns `WorkPtyLaunchResult`; when
  `disposition` is `"background"` the hook skips `selectLane`,
  `focusSession`, and `openSessionTab` so the launch happens silently
  without stealing the user's current focus.
  It also owns the quiet-tier partitioning and ordering. `snoozedFiltered` and
  `buildWorkTabGroupModel` both file through `sessionFilingBucket`, where
  `"snoozed"` is a
  partition of the grouping rather than a canonical bucket
  (`running`, `awaiting-input`, `ended`, `snoozed`, `settled`). Ordering inside
  the quiet tails deliberately diverges from the list's default `startedAt`
  ordering: settled rows rank by `settledAt` (falling back to last activity then
  start), because otherwise a session started yesterday and settled just now
  buries itself under sessions settled long before it; snoozed rows rank by
  `snoozedUntil` ascending, because the point of the group is "what comes back
  first", with unparseable deadlines sinking to the bottom. Snooze expiry stays
  derived: a single `setTimeout` armed at the soonest deadline (capped at
  10 minutes per tick, since `setTimeout` overflows past ~24.8 days) bumps a
  `snoozeEpoch` counter that re-derives the partition. `buildWorkTabGroupModel`
  takes an injectable `nowMs` so that derivation stays testable. Work-sidebar
  chip filters, lane pins, and sort/manual-order choices are persisted in the
  same per-project view state. Changing any of them clears a transient
  deeplink override. `reorderWorkLanes` seeds a sparse manual order from the
  currently rendered list, prunes dead ids only while writing, and switches to
  Manual even when an accepted drag is a positional no-op. Its Has PR filter
  uses `useLanePrsByLaneId`, a coalesced PR read refreshed by `prs-updated`
  pushes; no-chip paths preserve the original filtered array reference.
- `apps/desktop/src/renderer/components/terminals/workLaneOrder.ts` — pure
  Work-sidebar tiering, stable sort, and manual-move helpers. Primary remains
  first; pins outrank active and quiet rows; activity/name/created/manual sort
  applies only within a tier. Also declares the lane-specific HTML5 drag MIME
  type so a session-card drag cannot be mistaken for a lane reorder.
- `apps/desktop/src/renderer/components/terminals/useWorkLaneReorder.ts` —
  native lane-header drag lifecycle: validates the Work lane MIME type,
  computes before/after drops from the header midpoint, and rAF-autoscrolls the
  list near either edge. It is presentation-only; `useWorkSessions` owns the
  persisted mutation.
- `apps/desktop/src/renderer/components/terminals/workSessionFilters.ts` —
  pure Work chip-filter normalization, tool-family projection, active-label
  formatting, and matching. Status/Tool selections OR within an axis; axes
  AND together.
- `apps/desktop/src/renderer/components/terminals/useLanePrs.ts` —
  the lane→PR map shared by the list's PR badges and the Has PR filter. The
  bound machine's half is a coalesced PR read plus a `prs-updated`
  subscription; each other machine's rows arrive with its cross-machine union
  slice. Keys are namespaced by machine and never bare lane ids, because
  cross-machine handoff copies a lane id: `boundMachineLanePrs` answers rows on
  the tab's own machine, `lanePrsForMachine` answers a foreign row from its own
  machine only, and `laneHasAnyPr` is the union answer the Has PR chip uses —
  the one lookup allowed to ignore machine identity. See
  [Pull requests](../pull-requests/README.md#which-machine-answers-a-pr-read).
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
  callers that only need the shell string.
  `buildTrackedCliResumeLaunchCommand` rebuilds a structured
  `{ command, args, env?, startupCommand }` descriptor from
  `TerminalResumeMetadata` for any provider. Windows continuation paths
  consume that descriptor directly, so OpenCode permission policy stays in
  the process environment and Claude/Codex/Cursor argv never passes through
  PowerShell quoting. Droid is the intentional shell launch: Windows uses a
  no-profile PowerShell descriptor that writes its temporary settings JSON as
  BOM-free UTF-8 and cleans it up after the provider exits.
  `buildTrackedCliResumeCommand` remains the persisted/display POSIX string
  compatibility wrapper; `parseTrackedCliResumeCommand`
  (`apps/desktop/src/main/utils/terminalSessionSignals.ts`) is the
  inverse it relies on for round-tripping. It also owns the shell-command-line
  primitives `ptyService` uses to place Claude's `--plugin-dir` flag on the real
  `claude` token: `shellWordSpans`, `isClaudeBinaryCommand`,
  `shellCommandLineArgIndex` (the argument after `-c`/`-lc`), and the idempotent
  `withClaudePluginInCommandLine`. `resolveLaunchFields` is
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
  `cmd.exe /d`); `ptyService.resolveShellCandidates("clean")`
  uses the same recipe for command-backed and provider-fallback shells. Plain
  interactive shells use their login configuration. Windows accepts configured Windows PowerShell,
  PowerShell 7, cmd, or an absolute Git for Windows `bash.exe` path and then
  falls back through PowerShell 5.1, PowerShell 7, and cmd. Bare `bash.exe` and
  `wsl.exe` are rejected so the local runtime never crosses into WSL.
  `deriveTrackedCliInitialInputSessionMeta`
  seeds the session title and `goal` field from the first prompt
  (sanitised + clipped to ~72 chars) when the caller did not supply a
  manual title; ADE launch guidance is unwrapped first so lane/worktree
  directives do not become the title. Tracked CLI rows render with a
  meaningful name instead of "Codex" / "Claude" while still letting
  providers like Shell fall back to the generic profile title. If ADE
  AI title generation is unavailable, `ptyService` can also adopt a
  provider-emitted terminal window title after sanitizing it.
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
- `apps/desktop/src/shared/sessionStatusNote.ts` — normalizes an
  agent-authored status line at the session-service boundary. Exports
  `STATUS_NOTE_GUIDELINE_WORDS` (six — the guideline the CLI help,
  bootstrap guidance, and the control-plane skill quote) and
  `MAX_STATUS_NOTE_CHARACTERS` (72 — the only hard bound). It collapses
  whitespace, drops empty notes, and ellipsizes past the character
  budget. It deliberately does **not** amputate at six words: the
  decisive half of a note is often in words seven and eight, and
  silently deleting it made the Work row lie.
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
  and `SessionInfoPopover.tsx` — grouped right-click actions and explicit info
  overlay. The context menu sections identity, Lifecycle, Go to, Copy, optional
  singleton-lane actions, and fenced destructive rows; Copy, Snooze, and Lane
  are pointer/keyboard submenus. Ended chat sessions get Delete chat wired to
  `ade.agentChat.delete`. Fixed-position menus measure and clamp to the renderer
  viewport.
- `apps/desktop/src/renderer/components/terminals/LanePrBadge.tsx`,
  `apps/desktop/src/renderer/lib/lanePrBadge.ts`,
  `LaneActionsSubmenu.tsx`, and
  `apps/desktop/src/renderer/components/ui/MenuSubmenu.tsx` — the shared
  compact PR state badge, its selection/presentation/navigation helpers, the
  singleton session row's lane submenu, and the pointer-safe/keyboard-accessible
  submenu primitive. The badge is presentation-only; where it opens is decided
  once by `openLanePr`, which sends a PR on the machine you are bound to into
  the PRs tab and a foreign one to GitHub, since a PR id resolves only on the
  machine that owns it. `LaneActionsSubmenu` renders the same
  `buildLaneMenuGroups()` definitions as the lane divider's context menu, so the
  two surfaces cannot drift.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` — shared renderer
  cache for `ade.sessions.list` calls, keyed by `projectRoot/laneId/status`.
  Ordinary callers coalesce compatible in-flight reads; forced reads bypass
  them, and invalidation removes in-flight entries so a post-mutation refresh
  cannot reuse a pre-mutation snapshot. Promise identity guards prevent a
  superseded response from repopulating the cache.
- `apps/desktop/src/renderer/lib/sessions.ts` — session-label helpers
  plus `getStaleRunningCliSessionAgeHours`, a separate process-cleanup
  heuristic that returns a rounded age when a non-run, non-chat session
  has been `running` without output for at least
  `STALE_RUNNING_CLI_SESSION_MS` (24 h). It drives the legacy inline
  warning pip and AppShell cleanup toast; it is not the canonical
  three-hour `stale` lifecycle threshold.
- `apps/desktop/src/renderer/lib/transcriptExport.ts` —
  `formatSessionBundleMarkdown` builds a metadata-only markdown bundle
  for a list of selected sessions; `triggerBrowserDownload` writes it
  to disk via a transient anchor + Object URL. The utility is retained,
  but the current session-list footer does not expose an export action.

ADE CLI / TUI runtime surfaces:

- `apps/ade-cli/src/bootstrap.ts` — constructs the shared
  `externalSessionsService` inside the daemon/runtime alongside
  `ptyService`, `sessionService`, and `agentChatService`, making the
  `external-sessions` ADE action domain available to desktop, `ade code`,
  sync remote commands, and headless runtimes.
- `apps/ade-cli/src/tuiClient/externalSessionBrowser.ts` and
  `apps/ade-cli/src/tuiClient/app.tsx` — `ade code` import browser.
  It reuses the same shared DTOs and affordance mapper as desktop, then
  calls `external-sessions.list` / `external-sessions.import` through the
  TUI action connection.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` —
  registers `work.listExternalSessions` and
  `work.importExternalSession` for trusted paired controllers. See
  [Sync and multi-device](../sync-and-multi-device/README.md#external-session-import-commands).

iOS Work surfaces:

- `apps/ios/ADE/Views/Work/WorkRootScreen.swift`,
  `WorkRootScreen+Actions.swift`, `WorkRootScreen+Selection.swift`, and
  `WorkRootComponents.swift` — mobile Work list: the one-row header
  (search + filter funnel + a compose menu holding **New chat** / **New lane**),
  the filter panel, sticky lane section headers, the child-shell section, and
  the `WorkSessionListRow` action shell that hangs swipe and context menus off a
  row. Visibility mirrors desktop
  (`workSessionShouldAppearInWorkList` in `WorkBrowserHelpers.swift`):
  standalone CLI sessions are always listed — **including ended ones**,
  which stay visible and resumable; chat-owned shell rows ride their
  parent chat's entry (an orphaned child whose parent chat isn't listed
  surfaces only while it is actually live). Agent CLI continuation is
  driven by sending text to the durable session, not a standalone
  row action. There is no rollup count anywhere on this screen: attention is
  stated per row, and the bell's Activity drawer is the only aggregate.
  Work filters, organization, and
  collapsed-section ids are restored from `WorkViewStateStore` per
  project-plus-host scope; lane deeplinks temporarily frame the list without
  persisting their resets. By-lane groups whose full roster is settled,
  snoozed, or archived use the same inverted `lane-open:<laneId>` marker as
  desktop: collapsed is a thin muted row, while explicit expansion shows
  compact session rows until active work returns.
- `apps/ios/ADE/Views/Work/WorkSessionRowCard.swift` — the session row card
  itself (`WorkSessionRow`, its leaf views, and the
  `WorkSessionRowRenderSignature` equality shim) plus the preview-line helpers
  (`workSessionRowPreviewSource`, `workLinkifiedPreview`). Split out of
  `WorkRootComponents.swift`, which keeps the surrounding list chrome. Card
  surface is neutral — background, border and shadow are reserved for selection
  and press, never for state, matching desktop `SessionCard.tsx`. See
  [the iOS companion](../sync-and-multi-device/ios-companion.md#work-session-list-rows).
- `apps/ios/ADE/Views/Work/WorkSessionGrouping.swift` — the by-lane (default) /
  by-status / by-time grouping, `WorkViewStateStore`, and the trailing quiet
  zone: a **Snoozed** shelf above a **Settled** shelf, both collapsed until
  explicitly opened via an inverted `shelf-open:<id>` marker. By-lane is exempt
  from the shelves — a settled row still belongs to its lane there, and the
  per-lane quiet fold already handles it.
- `apps/ios/ADE/Views/Work/TerminalSessionScreen.swift` and
  `SwiftTermSessionView.swift` — full-screen SwiftTerm-backed terminal
  surface for CLI sessions. It subscribes with `sinceOffset`, applies
  offset-stamped `terminal_data`, recovers gaps with a guarded delta/full
  resubscribe, pages older retained transcript bytes via `terminal_history`,
  sends ordered `terminal_input` through `SyncTerminalInputQueue`, reports viewport
  changes as `terminal_resize`, and unsubscribes on disappear.
- `apps/ios/ADE/Views/Work/WorkArtifactTerminalViews.swift` —
  terminal artifact/output views and inline preview cards; the older
  lightweight terminal emulator remains here only for compact previews.
- `apps/ios/ADE/Views/Work/WorkChatSessionView.swift`,
  `WorkChatComposerAndInputViews.swift`, `WorkChatRichCardViews.swift`,
  `WorkReasoningCard.swift`, `WorkNewChatScreen.swift`,
  `WorkUsageActivityCarousel.swift` — mobile chat,
  composer, command/tool/reasoning cards, and new-chat launch surface.
  `WorkNewChatScreen` segments between **ADE chat** and **CLI session**;
  the CLI mode submits `work.startCliSession` against the host through
  `SyncService.startCliSession`, and the Import entry opens the external
  session browser. A compact activity carousel is pinned outside the welcome
  scroll view above the composer, so keyboard/composer movement does not drag
  it through the page. It fetches the host's cached `usage.getAdeStats`
  snapshot, supports activity/token/code/client-mix charts and
  day/week/month/year ranges, and persists both selections on-device.
- `apps/ios/ADE/Views/Work/WorkImportSessionScreen.swift` and
  `WorkExternalSessionAffordances.swift` — iOS import browser/details flow and
  pure capability-to-action policy. The screen calls
  `SyncService.listExternalSessions` and `SyncService.importExternalSession`,
  mirrors the desktop capability affordances, installs the returned persisted
  session summary, and routes CLI imports to the terminal screen or chat
  imports to the chat screen.

## External CLI session import

ADE can adopt provider-native CLI sessions that were started outside ADE in a
plain terminal. Discovery is read-only: the runtime scans each provider's
local session storage, returns recent sessions with title/preview/cwd metadata,
and marks rows that already have ADE provenance or whose source file changed in
the last couple of minutes. The default list scope is the current ADE project
(including lane worktrees); callers can request `scope: "all"` to browse the
user's wider provider history.

Import has two targets:

| Target | Providers | Result |
|---|---|---|
| CLI | Claude, Codex, Cursor, Droid, OpenCode | Starts a tracked ADE PTY (`terminal_sessions` row) that resumes or forks the provider CLI. The session keeps normal Work behavior: transcript capture, lane association, continuation composer, sync terminal streaming, and the `Imported` badge. |
| ADE chat | Claude, Codex | Creates a native `AgentChatSession`, seeds the ADE transcript from the external provider history, and binds the provider runtime to the imported Claude session id or Codex thread id. See [Chat](../chat/README.md#external-chat-import). |

Provider capabilities are intentionally explicit because each upstream CLI has
different continuation rules:

| Provider | Resume in source cwd | Resume in another lane cwd | Fork | Fork into another lane cwd | ADE chat import |
|---|---:|---:|---:|---:|---:|
| Claude | yes | no | yes | yes | yes |
| Codex | yes | yes | yes | yes | yes |
| Cursor | yes | no | no | no | no |
| Droid | yes | no | if installed CLI supports `--fork` | if installed CLI supports `--fork` | no |
| OpenCode | yes | no | yes | no | no |

The cwd rule is the sharp edge. Claude, Cursor, Droid, and OpenCode sessions
were born in a specific folder and their resume command must run there.
If that folder is not the selected lane, ADE either offers a fork path that
can land in the lane (Claude, Codex, Droid when supported) or a clearly labeled
resume-in-place action that runs in the original folder with
`allowExternalCwd`. Codex threads are cwd-portable, so Codex resume can target
the selected lane directly.

Resume means "take the baton": ADE starts a tracked continuation of the same
provider session/thread. If the original terminal is still active, both tools
can race on the same provider state, so the UI warns on recently modified
sessions and nudges users to close the other terminal or fork. Fork means "make
a branch": ADE asks the provider for a new continuation target where possible.
Claude cross-lane fork/import copies the source JSONL into the target lane's
Claude project storage with a new session id instead of moving or editing the
original file; Codex uses its native thread fork path; Droid and OpenCode use
their CLI fork flags within the limits above.

## Detail docs

- [pty-and-sessions.md](./pty-and-sessions.md) — lifecycle, tool-type
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
- tracked CLI agent terminals (`claude`, `codex`, `cursor-cli`, `droid`,
  `opencode`)
- agent chat sessions that run through the Claude/Codex/Cursor/Droid/
  OpenCode SDKs rather than a PTY (`claude-chat`, `codex-chat`,
  `opencode-chat`, `cursor-chat`, `droid-chat`)
- other tracked tools (`cursor`, `aider`, `continue`, `other`)

Status transitions: `running` → `completed` | `failed` | `disposed` |
`detached`. `detached` means the durable row and transcript remain, but the
process-local PTY is no longer reachable from the current ADE runtime.

Those persisted process statuses are intentionally separate from the canonical
UI phase. `CanonicalSessionPhase` adds `needs_you`, `stale`, `ready`, `idle`,
`stopped`, `ended`, and `settled` projections without rewriting the underlying
process status. A settled session remains in the live Work inventory and is
still openable/resumable; archive remains a separate chat-only visibility
lifecycle.

Fields that feed UI and downstream systems:

- identity: `id`, `laneId`, `laneName`, `ptyId`, `tracked`, `pinned`,
  `manuallyNamed`, `chatSessionId` (owner session for attached terminals;
  historically a parent chat id, and now also a tracked CLI session id
  for CLI-owned attached terminals; stored as `chat_session_id` and indexed)
- title and intent: `title`, `goal`, `toolType`
- lifecycle: `status`, `startedAt`, `endedAt`, `exitCode`, `runtimeState`
  (derived), `chatIdleSinceAt`, `settledAt`, `statusNote`,
  `attentionRequestedAt`, `attentionMessage`, `lastTurnFailedAt`,
  `settleOverride`
- visibility overlay: `snoozedUntil`, `snoozedAt`, and the woke marker
  `wokeAt` / `wokeReason`. These are not lifecycle state — see
  [Snooze and early wake](#session-lifecycle) below
- content: `transcriptPath`, `lastOutputPreview`, `summary`
- git anchoring: `headShaStart`, `headShaEnd` (used by
  `sessionDeltaService`)
- resume: `resumeCommand`, `resumeMetadata` (provider, target kind,
  target ID, launch config, and optional `orchestrationParentSessionId` /
  `spawnKind` for tracked agent CLI lineage)
- spawn lineage: optional `orchestrationParentSessionId` and `spawnKind`,
  projected from a chat record or tracked agent CLI `resumeMetadata`

See `apps/desktop/src/shared/types/sessions.ts` for the full shape.

The lifecycle columns are `settle_override`, `snoozed_until`, `snoozed_at`,
`woke_at`, and `woke_reason` on `terminal_sessions`. All five are nullable text
with **no unique index**: the table replicates to iOS through cr-sqlite, and
`crsql_as_crr` rejects any non-primary-key unique index. `kvDb.ts` both declares
them in the create-table statement (fresh databases) and adds them through
`safeAddColumn` (existing ones). The same columns must exist in *both* iOS
halves — `apps/ios/ADE/Resources/DatabaseBootstrap.sql` for fresh installs and
`Database.swift`'s `ensureColumn` migrations for upgrades. A missing iOS half
does not fail on desktop; it surfaces as changeset-apply errors on the phone.

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

2. **Stream** — PTY `data` events advance a lifetime logical UTF-8 byte
   cursor and are written into a rolling retained transcript (16 MiB physical
   ceiling, rollover target near 8 MiB), throttled into a
   `lastOutputPreview`, forwarded to `broadcastData` with the logical transcript
   end offset when available, and scanned for runtime state signals (OSC 133
   prompt markers). Rollover changes only the retained base offset; live event
   offsets remain monotonic.

3. **Tag** — the tool type is inferred or passed by the renderer.
   Claude/Codex sessions also get a best-effort `--session-id` extraction
   so continuation works after the CLI itself assigns an ID.

4. **Auto-title** — after 6 seconds (`PTY_AI_TITLE_DEBOUNCE_MS`) the
   service may summarize the early output into a short title via the AI
   integration service. For Claude/Codex it prefers the first submitted
   user line (`tryCliUserTitleFromWrite`) because the TUI hides useful
   text in the alternate screen; ADE guidance wrappers are stripped
   before deriving the visible title/goal. Provider-emitted OSC window
   titles are accepted only when ADE title generation is not available,
   so the ADE summarizer remains authoritative for normal desktop and
   CLI runtime launches.

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

6. **Classify and settle** — `canonicalSessionState()` projects persisted
   facts in a fixed order. Deterministic pending input or `ade chat ask` is
   loud `needs_you`; an explicit `settledAt` wins at rest; disposed, failed,
   and cleanly ended sessions remain distinct; exit code 0 does not settle;
   a still-running session with no activity for three hours is `stale` but is
   not settled. Chat idle between turns is the quiet `ready` phase. Explicit
   Settle/Unsettle is available from the session context menu and multi-select
   footer — and, since 2026-07, *only* from user surfaces plus the PR-merge
   policy. `ade chat settle` / `ade session settle` were removed because
   "is this work finished" is a subjective judgment agents are unreliable at,
   and a self-settling chat drops out of the user's active list on the agent's
   say-so. A `needs_you` row becomes **Dismiss & settle**. For an SDK
   chat, the service interrupts Claude/Codex/OpenCode/Cursor/Droid work,
   cancels live and restored waiters, removes Codex plan follow-ups, persists
   idle state, and only then settles. A tracked CLI may dismiss an explicit
   `ade chat ask` marker; a raw provider TUI prompt instead shows **Resolve
   input to settle** and must be handled in the terminal.

7. **Activity and escalation** — a new user turn clears a chat's settle,
   explicit attention, and last-turn-failure markers. PTY output clears settle
   because the process is active again. Scheduled/background wakes are
   different: an explicitly settled chat shows running while the unattended
   turn streams, retains `settledAt`, and returns to Settled when it rests.
   `ade chat ask` clears settle, persists the blocking question and its
   `agent_explicit` provenance, marks a live tracked CLI as waiting-input, and
   publishes a time-sensitive push; the next accepted user message clears it,
   including an active-turn steer. Agent-to-agent and orchestration steers do
   not dismiss the user's pending question. Provider
   structured input carries its own pending item id. OSC markers and
   prompt-looking output never create `Needs you`. `ade chat note ""` clears
   only the status line. Status notes are trimmed to at
   most 72 characters at the session-service boundary so the sidebar remains
   glanceable; blocking detail belongs in the separate `ade chat ask` question.

   Beyond the binary settle there is a tri-state **settle override**
   (`terminal_sessions.settle_override`). `"settled"` behaves like a declared
   settle; `"active"` is the explicit keep-active pin; `null` returns the row
   to the declared rules. An explicit settle drops a stale `"active"` pin, and
   unsettle drops only a `"settled"` pin. `attention_source` and
   `settle_source` record where the current declaration came from. The
   `settle_source` enum still carries `agent_explicit` for rows settled before
   the 2026-07 removal of agent settlement; new settles are only `user`,
   `operator` (CTO), or `pr_merge`. Session Info displays that provenance.

8. **Snooze and early wake** — snooze is a synced **visibility overlay**, never
   a lifecycle phase: `canonicalSessionState()` does not read it, only the
   surfaces' filing does. `snoozed_until` is a derived-expiry deadline — there
   is no scheduler; every surface compares it to now via `isSessionSnoozed`.
   `snoozed_at` is load-bearing for early wake: an error is only a hand-raise
   when it is strictly newer than `snoozed_at`, otherwise the failure you
   snoozed on top of would instantly re-wake the row. Waking stamps
   `woke_at` / `woke_reason` so the surfaces can explain the return:
   `needs_you` (an approval or `ade chat ask` escalation), `error` (a newer
   failed turn), `turn_complete` (the running turn finished), `timer` (the
   deadline simply passed), `manual`. `clearWokeMarker` drops the marker once
   the row has been visited.

   Two halves keep the hand-raise contract honest for **non-chat** sessions,
   whose failures are not chat turns:
   a session that ends in failure (non-zero exit code, or a `"failed"` end with
   no exit code) wakes with reason `error` at the end write sites — exit 0 does
   not because it is not a failure; and every Snoozed group files
   through `isSessionFiledAsSnoozed(session, phase)`, which yields to a
   `needs_you` phase, so a snoozed row blocked on the user is never hidden even
   under an "Until I'm asked" (~100 year) deadline. The desktop flat list and
   `buildWorkTabGroupModel` consume that rule through `sessionFilingBucket`;
   the `ade code` row marker
   (`tuiClient/sessionLifecycle.ts`), and the iOS `workSessionGroups` snoozed
   tail all use it; `isSessionSnoozed` stays the raw read for row chrome.

   Agent- and operator-reachable entry points:

   - CLI — `ade session snooze <id> --for 1h|--until <iso>|--until-asked`,
     `ade session wake <id> [--reason ...]`, `ade session clear-woke <id>`,
     `ade session show <id> --text`, and `ade session actions --text` for the
     raw action list. Each takes the id as a positional, accepts
     `--session <id>`, and falls back to `$ADE_CHAT_SESSION_ID`, so a bound
     agent can file itself. Duration grammar and the 30-day cap come from
     `sessionSnoozeDuration.ts`, shared verbatim with `ade code`'s
     `/session …` commands. `ade session settle | unsettle | keep-active` and
     `ade chat settle | unsettle` are **retired**: they exit 2 with a message
     naming the two remaining paths (the user, and the PR-merge policy).
   - Action registry (`session` domain) — agent-reachable: `snoozeSession`,
     `snoozeSessions`, `wakeSession`, `wakeSessions`, `clearWokeMarker`.
     CTO-only (i.e. reachable from the desktop renderer's remote-runtime client
     and `ade code`, both of which authenticate at cto role, but refused for a
     session-bound agent): `settleSession`, `unsettleSession`, `settleSessions`,
     `unsettleSessions`, `setSettleOverride`. The caller-scoped
     `settleSelfSession` / `unsettleSelfSession` pair no longer exists.
   - Sync (`session.*` remote commands) — the only path for mobile and the
     hosted web client, which have no local DB. Advertised in
     `hello_ok.features.commandRouting.actions`, and listed in
     `MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS` (optional, not required, so
     older phones are not flipped into limited mode). Clients that cannot
     encode a JSON null send `override: "clear"` to clear a settle pin.
   - CTO operator tools — `getSessionLifecycle`, `snoozeSession`, `wakeSession`,
     `settleSession`, `unsettleSession`, `setSessionSettleOverride`.
     `listChats` and `getChatStatus` carry the same lifecycle block, including
     `wokeReason`, so the CTO can reason about why a row resurfaced.

9. **Continue** — `work.sendToSession` reuses an existing session row
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

10. **Reconcile** — on startup, `reconcileStaleRunningSessions` marks
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

11. **Delete** — `sessionService.deleteSession(sessionId)` removes a
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
  attention. Invalidate it when a new session is created or lifecycle metadata
  changes outside the normal paths. Main-process IPC handlers, runtime action
  `session.list` / `session.get`, and the lane-list snapshot service all use
  `chatSessionProjection.ts`, include automation chats when building the
  projection index, and fall back to quiet chat state if runtime hydration
  fails.
- **Two quiet tiers, not one** — Settled is a lifecycle phase; Snoozed is a
  visibility overlay that files a row without changing what its status dot says.
  They remain distinct inputs, combined for desktop filing by
  `sessionFilingBucket` (canonical lifecycle plus
  `isSessionFiledAsSnoozed`), and rendered as two separate tails; every
  surface — desktop, iOS, `ade code`, hosted web, `ade` CLI, CTO tools — has
  both. Nothing about session lifecycle is desktop-only.
- **Two-tier attention** — the Your move bucket contains loud `needs_you` rows
  and quiet resting chats/idle CLIs. Only canonical `needs_you` increments the
  Work-tab highlight, notification count, and macOS Dock badge. A ready chat is
  visible in Your move but does not interrupt the user. The attention hook is
  mounted at `AppShell`, so Files, PRs, and other project routes keep the count
  truthful without route-scoped Work polling.
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
  `projectRoot::laneId` key. The payload is version 3 and also owns the Lanes
  tab's filter, pinned lane ids, and expanded lane id so those controls survive
  route/project remounts. Its version-2 one-shot migration is gated by the
  dedicated settled-collapse version, not by the current schema version, so
  later additive bumps cannot re-collapse a section the user expanded.
  Mounted project stores persist scoped read-modify-write deltas and hydrate
  their own project key directly from storage; they never republish a stale
  whole-map snapshot from another project surface. `refreshLanes` prunes
  lane-scoped records only after a non-empty authoritative lane list arrives,
  and only for its own project key. `AppShell`/`TopBar` callers above the
  per-project provider route writes through the live project-store registry.
  Per-lane quiet tails use
  `settled-open:<laneId>` and `snoozed-open:<laneId>` markers and also start
  collapsed; a fully quiet lane uses the equivalent inverted
  `lane-open:<laneId>` marker. Deeplink filters/grouping are transient framing
  and do not overwrite the persisted base.

## IPC surface summary

Sessions:

| Channel | Purpose |
|---|---|
| `ade.sessions.list` | list by lane/status; cached at renderer |
| `ade.sessions.get` | single session detail including runtime state |
| `ade.sessions.updateMeta` | rename (sets `manuallyNamed`), pin, edit goal, update resume metadata |
| `ade.sessions.settle` / `.unsettle` | Set or clear `settled_at` for one session. Settle accepts `{ outcome?, dismissPendingInput? }`; dismissal is handled atomically by `settleTerminalSession` before the settle mutation. |
| `ade.sessions.settleMany` / `.unsettleMany` | bulk lifecycle mutation used by the Work multi-select footer; settle returns only newly-settled ids for precise undo |
| `ade.sessions.setSettleOverride` | tri-state settle pin: `"settled"` behaves like a declared settle, `"active"` suppresses a declared settle, `null` hands the row back to declared lifecycle state |
| `ade.sessions.snooze` / `.snoozeMany` | set `snoozed_until` (+ `snoozed_at`) and clear any stale woke marker. Snooze is a **visibility overlay**, not a lifecycle phase — `canonicalSessionState()` never reads it. Bulk returns the ids it changed. |
| `ade.sessions.wake` / `.wakeMany` | clear the snooze now and record `woke_reason` (`timer \| needs_you \| error \| turn_complete \| manual`, default `manual`). Bulk returns the ids that were actually snoozed. |
| `ade.sessions.clearWokeMarker` | drop `woke_at`/`woke_reason` once the user has visited the row |
| `ade.sessions.delete` | remove a row outright; emits `terminalSessionChanged` with `reason: "deleted"` |
| `ade.sessions.readTranscriptTail` | tail bytes of transcript (raw or ANSI-stripped) |
| `ade.sessions.getDelta` | `SessionDeltaSummary` |
| `ade.sessions.changed` (event) | fired on meta updates and deletions (`reason: "meta-updated" \| "deleted"`) |
| `ade.agentChat.delete` | delete a chat session: disposes the runtime, resolves waiters, wipes persisted JSON + transcript, then calls `sessions.delete` |

PTY:

| Channel | Purpose |
|---|---|
| `ade.pty.create` | create or reattach; returns `{ ptyId, sessionId, pid }`. Accepts an optional `chatSessionId` to mark the terminal as attached to that owner session. |
| `ade.pty.resumeSession` | prompt-free tracked CLI relaunch. Args: `{ sessionId, cols?, rows?, model?, reasoningEffort?, permissionMode? }`. Reuses a live PTY when attached; otherwise validates the row, backfills a missing resume target when possible, rebuilds the provider resume command, and spawns a continuation PTY in the same `terminal_sessions` row without writing a prompt. Returns `PtyResumeSessionResult` (`{ ptyId, sessionId, pid, session, resumed, reusedExistingRuntime }`). |
| `ade.pty.sendToSession` | send-or-continue. Args: `{ sessionId, text, cols?, rows?, model?, reasoningEffort?, permissionMode? }`. Submits text into the live PTY when one is attached; otherwise validates that the row is a tracked agent CLI session, backfills a missing resume target when possible, rebuilds the provider launch via `buildTrackedCliResumeLaunchCommand` (honouring runtime overrides), spawns the continuation PTY in the same `terminal_sessions` row, and includes the user's text in the launch when resume metadata is available. Windows consumes the returned command/argv/env directly; POSIX retains the existing shell-string compatibility path. Later sends that land after a resume flight has started are serialized through the agent CLI input protocol: line clear, bracketed paste envelope, chunked 64-byte writes with 5 ms inter-chunk delay, then carriage return with a provider-specific submit delay. Returns `PtySendToSessionResult` (`{ ptyId, sessionId, pid, session, resumed, reusedExistingRuntime }`). |
| `ade.pty.write` | write bytes to PTY |
| `ade.pty.resize` | cols/rows resize |
| `ade.pty.dispose` | close PTY; optional `sessionId` used for logging |
| `ade.pty.data` (event) | stream stdout/stderr to the renderer |
| `ade.pty.exit` (event) | final exit code |

Attached terminals (`ade.terminal.*` — used by the chat/CLI terminal panel, the App Control panel, the TUI `TerminalPane`, and the headless `ade terminal` / `ade app-control` CLI commands):

| Channel | Purpose |
|---|---|
| `ade.terminal.list` | list `ChatTerminalSession[]` (filterable by owner `chatSessionId` and/or `laneId`). Rich rows: `toolType`, `goal`, `resumeCommand`, `resumeMetadata`, `lastOutputPreview`, `summary`, status / runtime state. Chat-toolType sessions are filtered out so the surface only lists shells and tracked agent CLI terminals. |
| `ade.terminal.read` | tail scrollback by explicit `terminalId` *or* by owner `chatSessionId`. Returns `{ terminalId, data, nextSince }` for incremental polling. |
| `ade.terminal.preview` | serialized buffer snapshot for the TUI/mobile renderers. Each live PTY mirrors output into an `@xterm/headless` Terminal + `SerializeAddon` and debounce-writes a JSON file under `.ade/cache/terminal-snapshots/`. The preview call flushes the in-flight write, reads the snapshot (`TerminalSerializedSnapshot` with serialized scrollback, visible-row cells, cursor / viewport / buffer-type metadata), and falls back to a transcript tail when no snapshot exists yet. |
| `ade.terminal.write` | write bytes to a terminal (by `terminalId`, `ptyId`, or owner `chatSessionId`). |
| `ade.terminal.resize` | resize the live PTY (cols, rows) by `terminalId`, `ptyId`, or owner `chatSessionId`. Clamps dims and rebroadcasts the new size to the snapshot mirror. |
| `ade.terminal.signal` | deliver `SIGINT` / `SIGTERM` / `SIGKILL` to the resolved terminal. |
| `ade.terminal.activeForChat` | resolve the active `ChatTerminalSession` for a given `chatSessionId`. |

`ptyService` keeps two in-memory maps to back this surface:
`terminalChatSessions` (terminalId → owner session id) and
`activeTerminalByChatSession` (owner session id → terminalId). Disposing
the active terminal automatically promotes the most recently created
sibling, so `ade terminal read --chat-session <id>` always resolves a
sensible target for attached-session agents. Every PTY launched through
`ptyService.create` runs through `withAdeTerminalContextEnv` which
exports `ADE_PROJECT_ROOT`, `ADE_LANE_ID`, and (when the PTY is
session-owned) `ADE_CHAT_SESSION_ID` plus an opaque
`ADE_BROWSER_ACTOR_TOKEN` into the spawn env. The browser capability is
bound in Electron memory to that owner chat/lane/project. The runtime rejects
missing tokens and strips caller routing; Electron validates the token in the
issuing process before restoring its scope on the authenticated bridge. The
remaining identity variables are how a
plain shell that the user types `ade --socket terminal read --chat-session
"$ADE_CHAT_SESSION_ID" --text` into will resolve to the owning session's
terminal even though no agent runtime spawned it. The headless ADE
runtime and agent chat runtime both layer the same identity envs
(plus `ADE_WORKSPACE_ROOT`) on top through `buildAgentRuntimeEnv`.

## Gotchas

- **Snooze must never reach `canonicalSessionState()`.** The moment a phase is
  derived from `snoozed_until`, a snoozed row starts lying about what it is
  doing and every count, badge, and capsule downstream inherits the lie. Snooze
  only changes where a surface *files* the row, through
  `isSessionFiledAsSnoozed` (wrapped with canonical lifecycle as
  `sessionFilingBucket` in the desktop renderer). The shared helper yields to a
  `needs_you` phase,
  which is what makes "Until I'm asked" true for tracked CLI rows at all: their
  needs-input state is purely derived, so no early-wake event ever fires for
  them and filing is the only thing that can un-hide them.
- **There is no snooze scheduler.** Expiry is derived by comparing
  `snoozed_until` to now, everywhere. The Work hook's timer only nudges a
  re-render; it is not the source of truth, and adding a watchdog that mutates
  rows on expiry would create a second, divergent answer on every surface that
  is not running it. Similarly, only `markLastTurnFailed` applies the
  strictly-newer-than-`snoozed_at` comparison — drop it and the error the user
  snoozed on top of instantly re-wakes the row, making snooze a no-op.
- **TUI-marker needs-you rides on `attentionSource: "provider_structured"`, and
  that label is a known mislabel.** The value is supposed to mean the provider
  told us it is blocked; for a marker latch the evidence is regex heuristics
  over painted output. It is load-bearing anyway, because
  `canonicalSessionState` derives `needs_you` from `pendingInputItemId`,
  `attentionRequestedAt`, or `provider_structured` and ignores
  `runtimeState: "waiting-input"` entirely — dropping the label would remove
  the badge *and* leave the row unsettleable. `SessionStatusSlot` therefore
  always allows dismissing a `provider_structured` needs-you. The real fix is a
  heuristic-waiting tier in the canonical layer, which is a shared-contract
  change across all five surfaces.
- **Process exit is not settlement.** A clean exit-0 row remains ended until an
  agent/user declaration or the enabled PR-merge policy settles it. New
  lifecycle surfaces must not infer task completion from process mechanics.
- **Settlement is not a pending-input response.** Never restore the old
  renderer sequence of `respondToInput` then settle. A provider decline may
  resume work, Codex plan declines may stage a revision, and a stale persisted
  waiter may have no live provider request. Keep dismissal and settle inside
  `settleTerminalSession`, and keep raw native CLI prompts non-dismissible.
- **Persisted chat `running` is not UI running.** Chat rows remain resumable
  across provider restarts, so the database status alone cannot drive the
  green/running projection. Route IPC and runtime-action list/detail reads,
  lane snapshots, and automation rows through `chatSessionProjection.ts`;
  hydration failure must degrade to quiet idle/waiting.
- Chat sessions backed by the Claude/Codex SDK still insert a
  `terminal_sessions` row but they are not attached to a PTY. Guard
  UI code with `isChatToolType(toolType)` before calling PTY-only APIs.
- `reconcileStaleRunningSessions` accepts `excludeToolTypes` but desktop and
  brain startup no longer exclude chat tool types — stale
  `running` chat rows are swept to `detached` like any other orphaned
  row after the startup activity grace expires. If you need a row to
  survive reconciliation, the caller has to pass `excludeToolTypes`
  explicitly.
- `transcriptPath` may be blank for untracked sessions (tracked=false)
 — always null-check before reading.
- `resumeCommand` is derived from `resumeMetadata` when present, then
  falls back to `defaultResumeCommandForTool(toolType)`. Editing it
  directly is only allowed through `sessionService.setResumeCommand` or
  `updateMeta`, both of which re-derive the metadata; target-id refreshes merge
  the current metadata so tracked CLI spawn lineage is not discarded.
- Transcript output is not dropped at 16 MiB. When the retained physical file
  would cross that ceiling, the PTY pauses when possible and atomically keeps a
  UTF-8-safe recent window targeted near 8 MiB plus output that arrived during
  replacement. `transcriptBytesWritten` is a lifetime logical cursor and never
  rewinds; `.rollover.json` records the logical base of physical byte zero.
  Crash journals/backups make an interrupted replacement recoverable on the
  next attach. Range/history callers must honor returned logical offsets: old
  bytes before the retained base are intentionally unavailable.
- Preview updates are throttled (~900 ms) and the string is capped at
  220 chars via `derivePreviewFromChunk`.
- Disk-pressure gating is enforced at the *start* boundary only:
  `ptyService.create` refuses a new tracked agent CLI PTY under `exhausted` pressure (`disk_full` code). Existing sessions are never killed by pressure. See
  [Storage and recovery](../storage-and-recovery/README.md#disk-pressure-and-enforcement).
- A transcript may exist only as a `<transcript>.gz` after history
  compaction. Read paths (`ptyService`/`sessionService` tails, search) handle
  this transparently, but any new code that opens a transcript by its raw
  `.log`/`.jsonl` path must check for the `.gz` sibling or reinflate first —
  `ptyService.create` reinflates before append.
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

- External session import:
  [external-session-import.md](external-session-import.md) — provider-native
  session discovery/import, the Continue/Copy x ADE-chat/CLI-session model, and
  mobile/host constraints.
- Lanes feature: [lanes/](../lanes/)
- Files surface used by terminals for the transcript: see
  [../files-and-editor/](../files-and-editor/) (the file watcher is
  scoped per workspace, not per session).
- Configuration-driven processes: [../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
- Universal search: [../search/](../search/) — terminal/CLI-session scrollback
  transcripts (`.log`) are FTS-indexed (ANSI-stripped, chunked by byte offset)
  as the `terminal` search source, deep-linking back to the scrollback position.
- Storage and recovery: [../storage-and-recovery/](../storage-and-recovery/) —
  the disk-pressure gate that refuses new CLI/process launches, and the lossless
  history compression that transcript reads transparently reinflate.
