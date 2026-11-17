# Terminals and Sessions

PTY terminal sessions and agent chat sessions share one `terminal_sessions`
row. Work, the lane panels and the session lists show them. The row carries
transcripts, deltas, the lane and the provider continuation metadata.

The **active ADE runtime** of the window's project binding owns the PTYs. A
local binding spawns them through the local brain (`ade serve`); a remote
binding spawns them on that machine and streams the bytes over its RPC. The
renderer's `window.ade.pty.*`, `window.ade.sessions.*` and
`window.ade.terminal.*` calls (`apps/desktop/src/preload/preload.ts`) go
through `callProjectRuntimeActionIfBound("pty" | "session", …)`. The desktop's
in-process handlers run only when no runtime is bound (tests, early
diagnostics). A local brain failure goes back to the caller; it is never
retried in the desktop process. The same source files run on both paths.

A projectless personal chat has a narrower terminal path. Its Terminal button
creates a PTY through `PersonalChatScope` in the machine's personal scratch
folder and streams through `personalChats.streamEvents`. It has no Work
terminal list, no free lane or cwd, and no lane / repo / PR / **Open in**
actions. See [Personal chats](../personal-chats/README.md).

`ptyService.ts` and `sessionService.ts` are large and fragile. Read them again
whenever you change their wiring.

## External session import

Work can continue or copy provider-native CLI sessions made outside ADE, as an
ADE chat or a tracked CLI terminal, for ten providers: Claude, Codex, Cursor,
Droid, OpenCode, Pi, Qwen, Kimi, Grok and Copilot. See
[External Session Import](external-session-import.md).

A terminal sends a failed PTY resize again after the connection recovers.

## Source file map

The same sources back the ADE runtime and the desktop in-process path used
before a binding exists, in diagnostics and in tests.

- `apps/desktop/src/main/services/pty/ptyService.ts` — the PTY lifecycle.
  - Transcripts: a 16 MiB physical ceiling with lifetime logical byte offsets.
    `readTranscriptTail` merges the disk tail with the live output tail.
    `getTranscriptWindow` / `readTranscriptSnapshot` hydrate by offset, and
    `readTranscriptRange` serves phone scrollback across rollover.
    `readScreenSnapshot` returns the current screen (SerializeAddon CSI),
    because an alt-screen TUI cannot be rebuilt from a log tail. Reads fall
    back to a `<transcript>.gz` generation; a create reinflates it first.
    `isTranscriptPathActive` lets the history compressor skip live files.
  - Input: agent CLI input uses bracketed paste, chunked writes and
    per-provider submit delays. `initialInput` / `initialInputDelayMs` defer
    the first turn. `sendToSession` and `resumeSession` continue tracked CLIs.
  - Sizing: while a phone or web viewport owns the size, desktop fit-resizes
    are remembered (`lastDesktop*`) but never applied; the desktop size comes
    back on the last unsubscribe.
  - AI titles use one model: the cheap helper for Claude, Codex and Cursor,
    else the stored launch model. The deterministic title stays when it misses.
  - Process tree end: `terminatePtyProcessTree` walks descendants with `pgrep`
    and sends `SIGKILL` after a grace timer.
  - A create stamps the row's `owner_pid` from `processRegistryService`. A
    row that drifted to `ended` while its PTY lives is opened again.
  - Under `exhausted` disk pressure, a new tracked agent CLI throws
    `disk_full` (`diskPressureMonitor.canPerform("cli_launch")`).
  - `canAcceptScheduledTurn` is the scheduler's delivery check: an ended
    tracked CLI can resume; a live one needs its provider's composer marker
    and a short quiet window.
  - CLI status comes from the host lifecycle and ADE attention requests. With
    Jev on, a running-to-idle change can send up to 40 visible lines for one
    `cli_status` decision. Only `waiting_for_input` at confidence 0.85 or more
    raises the `cli_prompt` hand (the same path as `ade chat ask`); it clears
    on input or new output. OSC 133 markers and plain shell prompts skip the
    decision. Jev failures never reach the user, and terminal output is never
    copied into local logs.
  - `runningSince` is stamped only on a change to running, so the row's
    `currentTurnStartedAt` timer is the turn's age, not the time since the
    last write. A user write that ends in a newline starts a new turn.
- `apps/desktop/src/main/utils/terminalPreview.ts` — the one-line preview: a
  column-cursor model over a cell array (not an ANSI stripper, which would run
  a TUI status line together). It honours CUP/HVP, VPA, CUU/CUD, CNL/CPL,
  CHA/HPA, CUF/CUB, EL, ED and ECH. Caps: 500 cells a line, column 2,000,
  2,048 pending characters, 220 preview characters. A partial escape carries
  over to the next chunk and re-anchors on its last `ESC` on overflow.
- `apps/desktop/src/main/services/pty/supervisedPtyHost.ts` and
  `ptyHostWorker.ts` — the node-pty worker host, outside the brain's process;
  at most 8 terminals a host (`MAX_PTYS_PER_HOST`). A remote runtime gets
  `ADE_PTY_HOST_WORKER_PATH` + `ADE_PTY_HOST_WORKER_NODE`, or
  `ADE_PTY_HOST_WORKER_COMMAND`, from its bootstrap.
- `apps/desktop/src/main/services/pty/resourceUsageSampling.ts` — the coalesced
  process sampler behind the TopBar pressure indicator: a bounded `ps`
  collector that never rejects, per-PID roles (Electron, `ade-runtime`,
  `ade-pty-host`, `provider-agent`, `shell`, `unknown`), and the snapshot
  (`ade.app.getResourceUsage`). See
  [pty-and-sessions.md](./pty-and-sessions.md#resource-pressure-attribution).
- `apps/desktop/src/main/services/chat/piSessionStore.ts`,
  `piSessionLease.ts`, `piSessionOwnership.ts` — the native Pi session store
  that chat, tracked `pi` terminals and discovery share: the `.ade-lease`
  writer lock and the `.ade-owner` claim. See
  [Pi session tracking](pty-and-sessions.md#pi-session-tracking).
- `apps/desktop/src/main/services/chat/settleNudgeSweep.ts` — a bounded sweep
  of old idle chat turns; Jev, at background priority, stores an optional
  verdict per turn on the session row.
- `apps/desktop/src/main/services/sessions/sessionService.ts` — the
  `terminal_sessions` rows: CRUD, continuation metadata, `reattach`,
  `reconcileStaleRunningSessions`, `endRunningSessionsOwnedBy` (a stopping
  process ends the rows it owns: a chat at rest `completed`, work in flight
  `detached`), `closeStrandedLocalSessions` (rows an earlier clean stop
  stranded on this computer, proven from the cr-sqlite clock and the process
  registry), and the settle, status-note, attention and last-turn-failure
  marks.
  - Agent activity reports are stored with a host time and cleared when a new
    turn is accepted. A new user turn clears settle, attention and failure;
    PTY output clears settle but keeps an agent's status note.
  - Lineage (`orchestrationParentSessionId`, `spawnKind`) lives in
    `TerminalResumeMetadata` and survives a continuation.
  - Snooze: `snoozeSession` / `wakeSession` (and the bulk forms),
    `wakeSessionIfSnoozed`, `clearWokeMarker`. `requestAttention`,
    `markLastTurnFailed` and `clearLastTurnFailed` wake early; only
    `markLastTurnFailed` compares with `snoozed_at`.
  - Reconcile: a `running` row with a live owner belongs to a sibling and is
    left alone; a known but dead owner makes it `detached`; an unknown owner
    (a row synced from another machine) is kept. `reopen` and
    `repairStaleDetachOnActivity` undo a wrong `detached`; see
    [Stale-detached repair](#stale-detached-repair).
    `STALE_RUNNING_SESSION_RESCAN_DELAY_MS` is the rescan delay both hosts use.
- `apps/desktop/src/main/services/sessions/agentShellCleanup.ts` — deletes the
  dead shells that App Control started, from the machine-local
  `agent_shell_cleanup` ledger (not replicated). See
  [Dead agent shells](#dead-agent-shells).
- `apps/desktop/src/main/services/runtime/processRegistryService.ts` — each ADE
  process's heartbeat row in the machine-local `runtime_processes` table (not
  replicated: PIDs are local). A 15 s heartbeat; an owner is live within 3
  heartbeats. Reconcile and dispose ask it before a sweep. See
  [ARCHITECTURE.md §3.4](../../ARCHITECTURE.md#34-cross-process-ownership).
- `apps/desktop/src/main/services/sessions/chatSessionProjection.ts` — maps
  `AgentChatSessionSummary` onto the `terminal_sessions` row that Work, detail
  reads, runtime actions and lane snapshots read: state, pending input, the
  turn timer, the wake time and lineage. If chat hydration fails, a resumable
  `running` row reads quiet, never live.
- `apps/desktop/src/main/services/sessions/settleLifecycleWriter.ts` — the one
  writer of the settle tuple (`settled_at`, `settle_override`, `settle_source`)
  and its host-local revision. Its test scans the tree for any other writer. A
  peer's replicated settle write goes through it too, so a settle in flight
  sees the change and stops. See
  [settle-teardown-design.md](settle-teardown-design.md) §3a and §6d.
- `apps/desktop/src/main/services/sessions/settleTurnCheck.ts` and
  `settleWiring.ts` — the check a settle runs in its window, and the wiring
  both hosts share (`createSettleWiring`, `createLateBoundSettle`).
- `apps/desktop/src/main/services/sessions/settleTerminalSession.ts` — the one
  settle transaction for IPC and the action registry. **Settle files a chat and
  stops nothing**: its background shells, subagents, cloud runs, wakes and
  crons keep running.
  - A working chat cannot be settled: the check refuses a running turn
    (`turn_running`) or a turn read that does not answer in 10 s
    (`status_unknown`), for every caller. The UI hides Settle on those rows
    (`sessionIsMidFlight`).
  - Any turn start unsettles (`sessionService.clearSettleOnTurnStart` from
    `setSessionActive`). It clears only the settle tuple, never an
    `ade chat ask` hand.
  - Settled chats resume after a restart. Terminals are never touched. Archive
    is the path that stops work (`laneService.archive`, where the order
    matters).
  - `dismissPendingInput: true` first quiets an SDK chat or clears a CLI's
    `ade chat ask` mark; a native terminal prompt is refused. The bulk paths
    reuse it as `dismissPendingInputBeforeSettle`, which is why the bulk sync
    command refuses the flag for more than one id (see
    [remote commands](../sync-and-multi-device/remote-commands.md#registry)).
- `apps/ade-cli/src/cli.ts`, `apps/ade-cli/src/adeRpcServer.ts` —
  `ade new chat --mode cli` and `start_cli_session`.
  - An agent CLI keeps its parent chat id and spawn kind in
    `TerminalResumeMetadata` (no `chatSessionId`); a plain shell has neither.
    After the PTY starts, `notifyParentOfCliChildSpawn` puts the same spawn
    chip and `chat:<childId>` card in the parent that a chat child gets.
  - Lane rule for an agent caller (as `chat.launchCli` and `spawn_agent`): an
    agent CLI may start in any lane with a worktree, at or under the caller's
    permission; the chat it claims and the parent it reports to must be the
    caller's own. A plain `shell` stays in the caller's own lane
    (`ensurePtyCreateAuthorized`). A denial names `callerChatSessionId`.
  - A launch with no permission takes the chat default
    (`configuredCliLaunchPermissionMode`): a full-auto parent's subagent runs
    full-auto, else the project's per-provider setting, then
    `ai.permissions.cli.mode`, then full access, always clamped under the
    caller. An explicit `--permissions` is kept.
  - Each tracked agent CLI has its own id as `ADE_CHAT_SESSION_ID`, so an
    `ade new chat` inside it parents to the CLI, and its `ade chat message`
    arrives stamped `agentRelay`. A parent may read and stop the CLI children
    it started in other lanes (`isPtySessionAuthorized`).
  - `--text-file -` reads stdin once per run (`readAllStdinSync`), so the text
    survives a forward to the chat's machine.
- `apps/desktop/src/main/services/chat/cliChildSessions.ts` and
  `cliChildReports.ts` — the CLI child bridge. The end verdict
  (`completed`, `failed`, or `disposed`/`detached` → stopped), the run key
  (`cli-exit:<endedAt>`) and the report (the CLI's last message from the Codex
  rollout or Claude Code JSONL, else the last terminal lines). The parent's
  card closes through the same path as a chat child.
  - Each finished turn reports too (`reportCliChildTurnEnded`, keyed
    `cli-turn:<turn start>`, once a turn). A CLI parent gets it typed at its
    next turn boundary (`wakeAgentCliParent`), never into a running turn.
  - A turn end from quiet output counts only when `canAcceptScheduledTurn` sees
    the composer. A turn that stopped on a question reports nothing. A new turn
    reopens the card. A turn the CLI already reported (`agentRelay`), or an
    exit that repeats the last report, closes the card quietly.
- `apps/desktop/src/main/services/chat/cliCardInputs.ts` — ADE's own cards
  (`ask_user`, `ade secrets request`, `ade integrations connect`,
  `ade mcp servers add`) raised from a tracked agent CLI, held in memory by
  session. An open card raises the row's hand. `chat.listPendingInputs` lists
  them before the CLI's own prompt item, and the answer goes back to the
  waiting `ade` command. An exit or a brain stop cancels them.
- `apps/desktop/src/renderer/components/terminals/CliAgentPane.tsx` — a CLI's
  actions pane (live and ended): the header button (`CliActionsToggle`), the
  pane over the terminal (`CliActionsSidePane`; it opens by itself the first
  time the CLI starts an agent or files proof), and the CLI's open cards in
  the prompt box's place (`CliPromptSlot`). It lists the agents the CLI started
  (`useCliParentChildRows`, with Stop) and its proof. Every read and answer
  carries the CLI's `runtimePin`, and nothing polls. A failed read, answer or
  Stop shows an error `Banner`. iOS does not show this pane yet.
- `apps/desktop/src/main/services/sessions/sessionDeltaService.ts` — the git
  diff and transcript delta at a session's end (`session_deltas`).
- `apps/desktop/src/main/services/lanes/laneLaunchContext.ts` — the lane's cwd
  for a PTY create.
- `apps/desktop/src/main/services/externalSessions/` — external CLI session
  discovery and import (`externalSessionsService.ts`: `list`,
  `importExternalSession`, `getDetail`), one provider table
  (`discoverers.ts`), the preview converters (`events/`), the import log
  (`importedSessionStore.ts`), the Claude copy into another cwd
  (`claudeSessionTransplant.ts`) and the live Claude registry
  (`claudeLiveSessions.ts`). Provider homes come from
  `services/shared/providerConfigHomes.ts`. Detail:
  [external-session-import.md](external-session-import.md).

Shared types and IPC:

- `apps/desktop/src/shared/types/sessions.ts` — `TerminalSessionSummary`,
  status, tool type, runtime state, `TerminalResumeMetadata`, `PtyCreateArgs`,
  `PtyDataEvent` (offset-stamped), the send-or-continue and resume args, the
  `ChatTerminal*` envelopes and the snapshot DTOs of the `ade.terminal.*`
  surface. It also holds the eight-value activity vocabulary
  (`sessionActivity.ts` normalizes it and decides detected versus agent
  reports) and `parseSessionSettleOverride`, the one parser for a settle
  override at any boundary (`undefined` for a typo; `"clear"`, `"none"`, `""`
  and null clear).
- `apps/desktop/src/shared/sessionCanonicalState.ts` — the canonical phase and
  bucket, mirrored on iOS. Precedence: explicit or structured attention, then
  a declared settle at rest, then stopped / failure / clean exit, then stale /
  running / resting.
  - Live background work promotes a resting session to `running`, with
    `liveness` `turn`, `background` or `monitoring` (monitoring only when watch
    loops are the only live work). Unknown task types count as working
    (`classifyBackgroundWorkKind` is a denylist). Liveness is in memory and
    empty after a restart, and it sits below failure, stopped, settled and
    stale.
  - A live foreground turn (`runtimeState`) is above the stored marks: a
    working chat never reads Failed or Ended. `last_turn_failed_at` clears at
    every turn start, and a non-failed `done` replaces an older failure.
  - `backgroundWorkSince` anchors the elapsed time of a promoted row. A
    background-only Claude runtime silent for `SESSION_STALE_AFTER_MS` is
    reclaimed by the idle sweep (the same constant).
  - `runtimeProcesses` lists the agent SDK processes a session holds (pid and
    start time; in memory, no command lines). `ade session show` reads it.
  - The settle override (`null`, `"settled"`, `"active"`) acts at the settle
    tier and clears on real activity.
  - Snooze is a synced visibility overlay (`snoozed_until`, `snoozed_at`), not
    a phase. Expiry compares `snoozed_until` with now; nothing schedules it.
    Early wake: a pending request, an error strictly newer than `snoozed_at`,
    a completed turn, or a failed end. Waking records `woke_at` /
    `woke_reason`. A snoozed row that needs the user stays in its section
    (`isSessionFiledAsSnoozed`).

  #### Provider signal boundaries

  Every provider uses the same host lifecycle. **Needs you** comes only from
  structured input or permission requests (and `ade chat ask` for tracked
  CLIs); PTY text is never parsed into a status. ADE detects the activity
  detail from the turn's tool calls
  ([Activity detection](./pty-and-sessions.md#activity-detection)); an agent
  report only refines it. Agent reports need the resolved ADE CLI and this
  runtime's socket, so embedded runtimes have none.

  | Provider path | Structured Plan signal | Agent-reported activity detail |
  | --- | --- | --- |
  | Claude SDK | Current `interactionMode` | Outside Plan, when the runtime resolves the ADE CLI |
  | Codex app-server | The accepted `turn/start` collaboration mode | In default mode, except external `config.toml` sessions |
  | Cursor SDK | Local `currentMode` | Local Agent mode only |
  | Droid SDK | Explicit `interactionMode` | Explicit write-capable, non-AGI, non-Spec permission only |
  | OpenCode SDK | Current permission mode | Outside Plan and external `config-toml` |
  | Pi SDK | None | Non-personal POSIX sessions outside Plan, with Bash allowlisted |
  | ACP Qwen, Kimi, Grok | Structured ACP configuration | Not offered: no verified command tool; Kimi and Grok share pooled processes |
  | Copilot SDK | Not wired | Not offered |
  | Tracked PTY CLI | None from terminal text | Codex and OpenCode outside Plan, write-capable Droid, Pi full-auto, Cursor with an initial prompt (not Claude). `ADE_ACTIVITY_SESSION_ID` scopes reports to the terminal row. |

  Pending requests: Claude, Cursor, Droid and OpenCode through their events;
  Codex through app-server input and permission events; Pi through approval
  and AskUser; ACP through `session/request_permission`. Cursor and Droid keep
  the request, so **Needs you** survives a reload. Codex Planning counts only
  after the app-server accepts the mode.
- `apps/desktop/src/shared/sessionStatusPresentation.ts` — the label, glyph,
  tone and prominence of each phase, mirrored on iOS. Blue is work in flight,
  amber only Needs you, emerald a clean unseen outcome, red failure. A
  background-only row reads **Background work** (×N) or **Monitoring** (×N)
  with a duration, never Planning. `sessionStatusShoutsLabel` keeps the word on
  nested rows only for Needs you or Failed.
- `apps/desktop/src/shared/sessionSpawnNesting.ts` — the by-lane filing rule
  (with an iOS mirror). Same-lane subagent chats and tracked CLI
  `--type subagent` sessions of a parent chat file under it; peers, children
  of a CLI or shell parent, and cross-lane children stay top-level. A quiet
  parent pulls not-done children up. Grandchildren file under the root.
  `nestedSubagentMark` gives the parent's one mark. It also owns
  `isChatToolType`.
- `apps/desktop/src/renderer/lib/sessionSnooze.ts` — the snooze menu math.
  Presets: In 1 hour, This evening (18:00), Tomorrow (09:00), Next week (next
  Monday 09:00) and Until I'm asked (about 100 years out; only a hand raise
  ends it). `resolveSnoozePresets(nowMs)` drops This evening within an hour of
  18:00 or after it; never cache it at module load. Days advance by calendar
  day, not 24 h. Labels name the day; the time sits in its own column.
- `apps/desktop/src/renderer/components/terminals/sessionLifecycleActions.ts` —
  the one place for snooze, wake and settle-override writes (row menu, context
  menu, composer chip). Snooze sends a concrete ISO deadline and offers a 5 s
  undo; failures show error toasts. It also writes the auto-handoff rules:
  writes first, then deletes, and a "not found" delete is success.
- `apps/desktop/src/main/services/adeActions/sessionBoardMove.ts` — the host
  half of a board drag (`moveOnBoard`, `undoBoardMove`,
  `flushStagedBoardMoves` on shutdown). See [The Work board](#the-work-board).
- `apps/desktop/src/renderer/components/terminals/SessionSnoozeControl.tsx` —
  the snooze button and its viewport-clamped menu; a snoozed row offers
  **Wake now**.
- `apps/desktop/src/renderer/components/terminals/SessionStatusLabel.tsx` — the
  status label alone (glyph, tone, elapsed). The Activity card uses it without
  the slot's controls, which act on this Mac's sessions.
- `apps/desktop/src/renderer/components/terminals/SessionStatusSlot.tsx` — the
  row's status slot. Running time ticks from `currentTurnStartedAt` for every
  session type (a repainting TUI would reset a last-activity timer); Stale time
  uses last activity. On hover or focus it swaps in snooze and settle controls
  with no layout shift.
- `apps/desktop/src/renderer/components/terminals/SessionHoverCard.tsx` — the
  1 s hover-intent detail card; row-to-row movement hands off at once.
- `apps/desktop/src/renderer/components/work/useSessionLifecycleSnapshot.ts` —
  the composer's `ChatLifecyclePill` (settled and snoozed state, Wake now,
  Un-settle), from the local session cache or the cross-machine snapshot. The
  same strip shows `LaneBranchComposerChip`.
- `apps/ade-cli/src/sessionSnoozeDuration.ts` — the `ade session snooze`
  duration grammar (`30m`, `1.5h`, `1d`, `1w`; a bare number is minutes), at
  most 30 days (`MAX_SNOOZE_MS`). It returns a result union, never throws.
- `apps/desktop/src/renderer/webclient/adapter/sessionLifecycleOverlay.ts`,
  `sessionLifecycleSupport.ts`, `shell/sessionLifecycleChrome.ts` — the hosted
  web halves: an optimistic overlay retired by reconcile, rejection or TTL;
  controls only when the host advertises `session.*`; a touch-size target. See
  [Web client](../web-client/README.md).
- `apps/desktop/src/renderer/hooks/useAppWideSessionAttention.ts` — app-wide
  attention counts from session events, focus and a visible-window recovery
  interval; only loud `needs_you` rows reach the Dock badge.
- `apps/desktop/src/shared/types/externalSessions.ts` — the external session
  DTOs shared by IPC, the action domain, sync commands and iOS.
- `apps/desktop/src/main/services/probeLocalhostPort.ts` — one 127.0.0.1 TCP
  probe (150 ms default) for the chat's "Open in ADE" chip and lane health
  checks (`ade.localhost.probePort`).
- `apps/desktop/src/shared/types/sync.ts` — the terminal stream envelopes
  (`terminal_subscribe` … `terminal_resize`) with logical offsets,
  `sinceOffset` resume, full snapshots with an optional `screen`, input ids
  and acks, `live` status and older-history pages; the phone CLI launcher
  payload (`work.startCliSession`); and the external-session commands.
- `apps/desktop/src/renderer/webclient/sync/client.ts` and
  `adapter/sessionsPty.ts` — the hosted web terminal state: overlapping ranges
  are dropped or trimmed, one gap resubscribe fetches the missing part, and a
  full snapshot arrives as `PtyDataEvent.replace` (with `screen: true` when it
  carries the current screen).
- `apps/ade-cli/src/services/sync/syncHostService.ts` — the remote terminal
  subscribe barrier: events queue (256 events / 2 MB) while the snapshot is
  read, overlap is trimmed, and a recapture runs up to four times rather than
  leave a gap. An overflow still answers `terminal_snapshot` and never closes
  the socket. The input ledger dedups input ids and acks each one.
- `apps/desktop/src/shared/ipc.ts` — the `ade.sessions.*` and `ade.pty.*`
  channels (`ade.pty.sendToSession` writes into a live agent CLI or starts its
  continuation; `ade.pty.resumeSession` relaunches an ended CLI with no
  prompt), the `ade.terminal.*` family (`list`, `read`, `preview`, `write`,
  `signal`, `activeForChat`; an agent caller of `preview` gets
  `snapshot.screenText` in place of the cell grid), `ade.localhost.probePort`,
  and `ade.externalSessions.*` with the `detailUpdated` push.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.sessions`, `.pty` and
  `.externalSessions`. External-session calls use the runtime
  `external-sessions` domain, with the desktop IPC only when no runtime is
  bound. The preview watch is always local IPC (it reads this computer's
  provider stores); if it fails, the preview reads `getDetail` once.
- `apps/desktop/src/preload/global.d.ts` — the renderer typing of those
  bridges.

IPC registration:

- `apps/desktop/src/main/services/ipc/registerIpc.ts` — registers the
  `sessions*`, `pty*`, `terminal*` and `externalSessions*` handlers.
  `terminalRead` reads the tail through `ptyService`, so attached panels get
  the same live-tail merge as Work.

Renderer surfaces:

- `apps/desktop/src/renderer/components/terminals/useWorkFocusGrid.ts`,
  `useWorkFocusQueueReport.ts`, `WorkFocusGrid.tsx` — the Focus grid: tile
  order, page size from the grid's box, the focused tile, unseen marks, swipe
  paging and the saved layout; the chats it shows (this machine's first, then
  other machines' with their binding); the page math and the UI.
- `apps/desktop/src/renderer/lib/useTurnStallClock.ts` — "now" for the
  turn-stall rule, re-rendering at the next stall deadline only.
- `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` — the Work
  page (`PaneTilingLayout`: the session list and the work view).
  - Multi-select, bulk close and bulk delete.
  - Launch disposition: a foreground launch selects the lane and opens the
    session; a background one adds the row and keeps focus. Chat and CLI
    drafts share `WorkPtyLaunchArgs` / `WorkPtyLaunchResult`.
  - An ended tracked CLI offers Resume (`pty.resumeSession`) and a
    continuation composer (`pty.sendToSession`). Both go through
    `runCliResumeRequest`, which resolves the row's pin first and keeps it for
    the new PTY.
  - `onSelectForeignRuntimeSession` opens another machine's CLI or shell in
    place with a per-session pin. Only a binding this window does not hold
    switches the project tab.
  - Opening a row clears its woke mark. The `ade:work:select-session` event
    (lineage links) selects and opens a session.
  - The `WorkSidebar` toggle and resizer.
  - `useWorkLaneDeleteProgress` covers a deleting lane's surface with an
    overlay until the refresh succeeds (two retries, then a sticky toast).
  - The per-session metadata generation busy set, routed through the owning
    pin.
- `apps/desktop/src/renderer/components/terminals/importSessions/` — the
  Import session dialog: the list (provider chips, a lane filter with counts
  and "Other folders", search) and the read-only preview with the action bar
  from `planImport`. The target lane is the session's home lane, never the
  Work view's lane.
- `apps/desktop/src/shared/externalSessionPolicy.ts` — the one import policy
  (`planImport`, `importRejectionReason`), used by desktop and the host guard
  and ported to Swift. `importProviderLabel` is the provider label.
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` — the Work
  draft surface. The machine and lane shelf under the composer holds Shell
  and Import. Import stays off for an auto-created lane (there is no lane to
  import into yet).
- `apps/desktop/src/renderer/components/terminals/WorkSidebar.tsx` — the
  right-edge tools pane: a picker page, or one tool on screen in a tab strip
  (terminal, browser, git, PR, files, iOS, App Control and the rest). The open
  tool is kept per lane; open state and width per project.
  - The browser is per window, not per lane; all windows share the
    `persist:ade-browser` partition. Leaving the browser tool hides its view
    and stops inspect mode.
  - On the web client, Browser and App Control are read-only; Apple is full.
    Apple also needs `iosSimulator.getStatus().supported` on the session's
    machine. A tool that becomes unavailable falls back to the picker.
  - Context insertion goes to the active target: a chat or draft gets
    `ade:agent-chat:*` events; a tracked agent CLI gets the text as a
    bracketed paste through `terminal.write(..., runtimePin)`, then
    `ADE_WORK_PTY_CONTEXT_INSERTED_EVENT` highlights it. With no target,
    attach is off. A lane mismatch only warns.
  - The picker stays mounted (`inert`) while a tool shows, so the backdrop
    does not recompile. A narrow pane drops tab labels, then overflows into
    `…`; `workSidebarSplitter.ts` keeps the 32 px header.
  - The pane follows the **chat's** machine (`runtimePin`). Lanes come from
    `useLanesForPin(runtimePin)`. Each panel's React key has the pin key, so
    one machine's state never paints into another. A known-offline pinned
    machine shows "<machine> is offline." and skips status probes.
  - Context insertion into a PTY works across machines. Chat insertion for a
    chat on another machine fails closed ("Tool context insertion is not
    available for chats on another machine.").
- `apps/desktop/src/renderer/components/terminals/workTools.ts` — the tool
  catalogue (`WORK_TOOL_DEFINITIONS`), `workToolAvailability` (from
  capability flags, never `process.platform`) and `isReadOnlyWorkTool`. The
  Issues tool counts the lane's open issue tabs
  ([Issues](../issues/README.md)).
- `apps/desktop/src/renderer/components/terminals/WorkToolPicker.tsx`,
  `WorkToolPickerBackdrop.tsx`, `WorkToolHeader.tsx`,
  `WorkToolReadOnlyView.tsx`, `workToolPanels.tsx`,
  `remoteWorkToolPanels.tsx` — the tab strip, its two pages and the panels.
  - The picker: two columns of tiles over a WebGL mesh (DPR 1, 600 k pixels,
    30 fps, paused when unseen; a CSS gradient without WebGL). A tile shows
    the agent's live action, else the measured status, else its `hint`, else
    why it cannot run.
  - The 32 px strip is a roving-tabindex `tablist`; tabs go glyph-only under
    420 px and overflow into `…` (`workToolTabLayout`).
  - `workToolPanels.tsx` has one component per tool id with one props object;
    a new tool is one entry here and one in `WORK_TOOL_DEFINITIONS`.
  - `remoteWorkToolPanels.tsx`: the iOS, Android, Desktop and App Control
    tools for a chat on another machine connect to it while on screen
    (`useRemoteWorkReach`, with Retry).
- `apps/desktop/src/renderer/components/terminals/workToolCatalog.ts`,
  `useWorkToolCatalog.ts`, `useWorkToolCatalogState.ts`, `useToolMachines.ts`,
  `useRemoteDeviceProbes.ts`, `chatDeviceSources.ts`, `remoteWorkCleanup.ts` —
  where each device is: the chat's device choice (`ade devices use`), else the
  machine its current turn drives. Another machine's device is probed through
  a pin this window already holds, never a new connection. Clean up deletes
  the chat's copies on machines it left, but keeps a copy with unpushed work.
- `apps/desktop/src/renderer/components/terminals/useChatToolActivity.ts`,
  `useToolHandoff.ts`, `WorkToolPanelBar.tsx` — what the agent does with each
  tool (from the chat's event stream), and the row above a tool: Take over,
  Hand back, or the machine it runs on. Notes go inline only while that
  chat's turn runs.
- `apps/desktop/src/renderer/components/terminals/workToolStartState.tsx` — an
  open device tool with nothing running: buttons ask the agent ("Boot a
  simulator") or pick a machine that can run it.
- `apps/desktop/src/renderer/components/terminals/workToolPickerBackdropShader.ts`,
  `workToolPickerBackdropRenderer.ts` — the backdrop's GLSL, palettes and size
  policy (`resolveBackdropSize`, testable without a GPU), and the React-free
  renderer that returns `dispose`, or `null` when it refuses (no WebGL, a
  software rasteriser, a failed shader). `field="window"` makes several
  canvases draw one window-sized field.
- `apps/desktop/src/renderer/components/terminals/useWorkSidebarTool.ts`,
  `useWorkToolStatuses.ts`, `workToolRequests.ts`, `workToolErrors.ts`,
  `workSidebarSplitter.ts` — open tools per lane, published as
  `work_tools.setActiveTool` (250 ms debounce, with the focused chat's pin);
  status lines from reads the pane already makes; the request queue; the red
  diagnostic dots; the splitter clamp.
- `apps/desktop/src/renderer/components/terminals/useWorkShowRequests.ts`,
  `lib/workToolShowRequests.ts`, `lib/workToolOnScreen.ts` — Work's side of
  `ade ui show`. A handler exists only while Work is on screen, for the
  session in front; a request for another chat waits until it opens. `shown`
  means mounted, with real width, in a visible window. A show for a screen,
  app or device tool uses an already-open pane or floats the player, never
  opens a closed pane; `WorkToolShowAck.shownAs` names what appeared. The
  browser, a lane-less chat, another lane, or a declined float opens the
  pane. See
  [chat › Agents open panes](../chat/README.md#agents-open-panes-ade-ui-show).
- `apps/desktop/src/renderer/components/apple/useLaneAppleDevices.ts`,
  `LaneAppleDeviceMarker.tsx` — the Apple mark beside a lane that holds a
  simulator.
- `apps/desktop/src/renderer/components/terminals/workToolChrome.tsx` — the
  shared panel chrome: one 40 px row under the 32 px header, ghost controls,
  16 px icons, and an 8 px inset / 10 px radius ring around a content surface.
- `apps/desktop/src/renderer/components/terminals/workTerminalShells.ts` and
  `useAttachedTerminalShells.ts` — the shell count the terminal panel
  publishes (one number per session, no IPC), and the shells of one session:
  the panel count, else titles from the terminal list. The list is read again
  only when a shell can change (session create or delete, PTY exit, panel
  count). It gates the chat header's **Open terminal** icon.
- `apps/desktop/src/renderer/components/terminals/useNativeToolSessions.ts`,
  `NativeToolFeedsContext.tsx` — one browser, App Control and simulator
  subscription set for the pane and the corner card.
- `apps/desktop/src/renderer/components/terminals/agentBrowserPresence.ts`,
  `AgentBrowserPresenceBadge.tsx` — "Using the browser": one shared
  `agent-presence` subscription, seeded by `getAgentPresence()` (not
  `getStatus`, which loads every tab). See
  [Chat › An agent is using the browser](../chat/README.md#an-agent-is-using-the-browser).
- `apps/desktop/src/renderer/components/work/WorkLiveCornerCard.tsx`,
  `workLiveCard.ts`, `WorkLiveIosStreamView.tsx` — the floating live preview
  of the latest screen tool not in the pane. See
  [UI surfaces](ui-surfaces.md#the-floating-live-preview-card-worklivecornercardtsx).
- `apps/desktop/src/renderer/components/terminals/workLaneBranchClusters.ts` —
  same-branch lanes (not primaries, `main` or `master`, across machines) sit
  next to each other in a dashed group. A quiet member stays in the inbox
  while the group has live work. An empty lane is not a member.
- `apps/desktop/src/renderer/components/terminals/WorkKanbanBoard.tsx` — the
  board view: `WORK_BOARD_COLUMNS`, drag and drop, `canAcceptDrop`. Column
  accents are CSS variables (they work in light theme). Cards come from the
  list's own `renderCardCore`.
- `apps/desktop/src/renderer/components/terminals/AutoHandoffModal.tsx` — the
  **Hand off…** dialog: rules that hand a dying chat to another model, one
  rule per condition, with deterministic ids. `loadAutoHandoffRulesForSession`
  returns `null` on a failed read (never `[]`), so a failed read cannot delete
  rules. The default target is the first model that is not the session's own.
  See [Automations › Rule provenance](../automations/triggers-and-actions.md#rule-provenance).
- `apps/desktop/src/renderer/components/ui/dialogFocus.ts` —
  `getFocusableElements` for the dialog focus traps: it skips hidden,
  `aria-hidden`, closed-`<details>`, disabled and negative-tabindex elements.
- `apps/desktop/src/renderer/components/terminals/SessionListPane.tsx` — the
  session list: lane, status or time grouping, search and filters, and two
  quiet tails (Snoozed above Settled; snooze is a separate partition, not a
  status). Collapsed tails are outside shift-range selection.
  - By lane, subagents and attached shells file under their chat (see
    `sessionSpawnNesting.ts`); the parent row has one mark that opens the
    actions pane. Status, time and board stay flat.
  - Board mode swaps in `WorkKanbanBoard` and keeps keyboard order in reading
    order. A board move shows a toast with a 5 s **Undo** and pulses the card
    until the agent's next activity.
  - A lane whose whole roster is quiet starts as one thin header with counts.
    `lane-open:<laneId>` keeps it open and clears when work returns.
    `needs_you` always wins, so a waiting row never folds.
  - **Focus** (`workFoldBusyLanes`, on by default): a lane with live work and
    nothing waiting folds onto a collapsed **Working** shelf, and comes back
    when it finishes or needs the user. `summarizeLaneFocus`
    (`workLaneFocus.ts`) holds a lane out for a raised hand, a stale run, a
    stalled turn (5 min silent with no open work), a missed wake, or a failure
    the user has not left. A clean finish never holds a lane. Pinned lanes
    never fold. Each header has one rolled-up dot. The second half of the
    pill is the Focus grid ([ui-surfaces.md](ui-surfaces.md#focus-grid)).
  - Bulk bar: Stop, Settle (8 s undo), Delete, clear.
  - A "Couldn't load chats from <machine>" banner shows only for an online
    machine that returned an error and no chats.
  - The list is the cross-machine union (`useCrossMachineLaneUnion`). It gets
    the **unfiltered** local roster, so a session never shows twice. Rows
    never name their machine; the hover card, the open chat's composer and
    the Start on picker do. A Devin or Cursor Cloud lane shows a cloud mark
    (`LaneCloudMarker`). Foreign lanes show only with sessions, after the
    same filters; their keys are `<machineId>:<laneId>`.
  - Every foreign row carries its `OpenProjectBinding` and opens in place
    through a per-session pin; the tab switches only when this window does
    not hold that binding. Context actions pass the same binding.
  - An offline machine is not listed (`rowShowsConnected`,
    `state/cloudRestingRows.ts`); its rows come back when it reconnects. An
    asleep ADE Cloud computer stays listed and readable. An offline machine's
    branches still count for "same branch elsewhere".
  - A deleting lane is dimmed and blocked in every grouping.
  - Lane order: the main checkout first, then pinned, active and quiet tiers;
    Activity, Name, Created or Manual sort inside a tier; drag only inside a
    tier. Filters: Status, Tool, Machine (OR in a row), Has PR and Dirty (AND
    across rows). Foreign matches count against the empty state.
- `apps/desktop/src/renderer/components/terminals/LaneMachineMarker.tsx` —
  `LaneMachineMarker` (a tower for an offline machine's lane, or the machine
  name with `named` or `mode: "name"`, used by Files and the command palette)
  and `LaneCloudMarker` (the Devin Cloud or Cursor Cloud mark the Work list
  shows).
- `apps/desktop/src/renderer/components/terminals/ForeignLaneContextMenu.tsx` —
  the menu of another machine's lane. Its `online` prop is live, so a drop
  disables every action. An SSH target adds the **Open in** submenu.
- `apps/desktop/src/renderer/state/crossMachineLanes.ts` — the union loader.
  - A launch onto another binding shows at once in that machine's slice, for
    up to two minutes or until the real list has it.
  - `buildCrossMachineLaneRows` keeps one claim set, so each session comes
    from one list: local first. The local id set is compared by content, not
    identity.
  - `isActiveBinding` (where a lane renders) is separate from `isThisMachine`
    (whether it is marked).
  - `applyReachability` decides from the connection snapshot which machines
    are live, dropped (hidden, slice kept) or forgotten. A drop counts only
    after a reconnect attempt fails, with a 45 s floor and a 120 s ceiling.
    Removal needs a missing target, a proven missing repository, or 24 h
    unreachable (`dropCrossMachineLanes`).
  - Reads stop while the window is hidden. Chats every 10 s; lanes every
    30 s (each lane read costs a git status there), or at once for an unknown
    lane, once (`resolveLaneCadence`).
- `apps/desktop/src/renderer/components/terminals/useChatLaunchCliDriver.ts` —
  finishes brain-owned new-lane CLI launches parked at `awaiting-client`: it
  starts the PTY for launches this window started and reports
  `chatLaunch.completeClient`. It lives in `TerminalsPage`, so a launch
  finishes after the user leaves the draft. A PTY the brain no longer wants is
  disposed. See
  [Chat › New-lane launches](../chat/composer-and-ui.md#new-lane-launches).
- `apps/desktop/src/renderer/components/terminals/SessionCard.tsx` — the
  three-line Work row: identity around `SessionStatusSlot`; the title with a
  singleton lane's PR badge; the preview, Claude TTL, exit code and provider
  mark. The subagent mark sits on line three (on line one the hover controls
  slid under it). A singleton lane's card carries the lane and PR. A chat the
  CTO started shows a CTO chip (`parentIdentityKey === "cto"`) that opens
  `/cto`. The model label shows only when the provider reported one. Rows do
  not fade by state; `disabledReason` blocks a deleting lane's rows.
- `apps/desktop/src/renderer/state/laneNamingStore.ts`,
  `sessionMetadataGeneratingStore.ts`, `terminals/LaneNamingLabel.tsx` —
  renderer-only "Naming…" state for lane auto-naming and Generate title / lane
  / status runs, and the shared animated label.
- `apps/desktop/src/renderer/components/terminals/terminalPreviewRows.ts` —
  `previewRowsFromTranscript` replays an ended session's transcript in a
  headless terminal at its own height (10 to 300 rows, default 40), with no
  alternate-screen switch. The desktop ended pane and ADE Web share it.
- `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx` — the tabs,
  grid and single Work view.
  - An ended agent CLI (`ClosedCliSessionSurface`) replays an alt-screen
    transcript, so it shows the screen the CLI drew. A late replay for another
    session is dropped.
  - The empty new-chat surface paints `WorkToolPickerBackdrop` and marks the
    draft for the first-send handoff
    ([Composer and Chat UI](../chat/composer-and-ui.md#new-lane-launches)).
  - The grid uses `PaneTilingLayout` seeded by `buildWorkSessionTilingTree`.
  - An ended tracked agent CLI keeps its transcript and gets a composer
    (`pty.sendToSession`) and a Resume button (`pty.resumeSession`). The
    first continuation with resume metadata puts the prompt on the resume
    command line; later sends to a live PTY use the agent input protocol.
- `apps/desktop/src/renderer/components/terminals/useWorkLaneContextMenu.tsx`,
  `WorkManageLaneDialogHost.tsx`, `useWorkLaneDeleteProgress.ts` — the Work lane
  menu (inline color, copy and reveal; **Manage lane** in place; **Pin to Work
  sidebar** separate from Lanes pins), the manage dialog host, and the delete
  progress. A delete closes the dialog and shows progress at once. Another
  machine's lane (`machineId:laneId`) has no progress feed, so its entry stays
  until that machine no longer lists the lane (`waitForForeignLaneToLeave`) or
  15 s pass. A failed delete shows a sticky toast.
- `apps/desktop/src/renderer/components/work/WorkSurfaceHeader.tsx` — the two
  one-row headers: `WorkSurfaceHeader` (CLI: title and lane chip, git
  toolbar, actions, Tools) and `CenteredWorkSurfaceHeader` (chat: a centered
  title, no lane chip). `prBadgeOnly` hides create-PR on both; a PR opens from
  the PR Work tool or the PRs tab.
- `apps/desktop/src/renderer/components/work/workShortcuts.ts` — the Work
  chords (`⌘↑`/`⌘↓`, `⌘I`, `⌘⇧A`, `⌘⇧N`, `⌘T`, `Esc`). The page presses the
  row's control rather than calling the select callback, so a foreign row
  keeps its pin. `WorkShortcutSheet.tsx` (the `?` sheet) reads the same
  constants; `lib/keyboardClaims.ts` decides when a chord is claimed;
  `useProjectTabShortcuts.ts` cycles project tabs with `⌃⇥`. The contract is
  in `docs/design/keyboard.md`.
- `apps/desktop/src/renderer/components/work/ClaudeLoginPromptButton.tsx` and
  `terminals/CliSessionWorkSurfaceHeader.tsx` — the CLI header adapter, which
  adds the Claude login button when a Claude preview shows `Please run /login`
  or a 401. The button opens a shell running `claude auth login` in the same
  lane, on the session's machine (`runtimePin`). Stop stays on the card and the
  composer.
- `apps/desktop/src/renderer/components/terminals/WorkStartSurface.tsx` — the
  empty "new chat / terminal" surface: `AgentChatPane` in draft mode, with
  `draftContextTargetId` so tools can insert context before a session exists.
- `apps/desktop/src/renderer/components/terminals/TerminalView.tsx` — the
  xterm.js wrapper: WebGL with a DOM fallback, fit retries and transcript
  replay for ended CLI tabs.
  - Image paste: a tracked agent CLI saves the image on the session's machine
    and pastes a path stub. A local plain shell keeps `^V`. A shell on another
    machine (pin, remote tab, web) saves the image there and pastes the
    quoted path. A failure logs `[ade-term] image paste failed` and shows
    "Couldn't attach the image: <reason>" for 8 s; it is not retried.
  - Copy: a selection copies through the desktop clipboard bridge. OSC 52
    (`osc52.ts`) is write-only, at most 1 MiB of base64, never clears, and
    only from the visible, focused terminal. History writes go through
    `writeTerminalHistory`, so an old copy never fires again. The brain's
    headless mirror ignores OSC 52.
  - Shift+drag selects text while a CLI tracks the mouse (on macOS through
    `terminalMacShiftSelection.ts`).
  - A `replace: true` event resets xterm and writes the snapshot, so an old
    preview cannot repaint after a gap repair.
  - `runtimePin` is part of the runtime cache key and goes on every call.
  - Width: a width-sensitive write waits for a fit and `document.fonts.ready`
    (`terminalWidthTrustworthy`); a terminal opened before its font loads
    re-measures; a `replace` waits up to 20 × 60 ms for a fit, then writes
    anyway; a width change re-hydrates after 250 ms.
  - Wheel: with mouse tracking, to the app unless Shift; without, local
    scroll only when scrollback exists. Zoom scales `fontSize`, not the box,
    so hit-tests stay right.
  - Diagnostics: one `[ade-term]` line per event; a dims mismatch warns on
    columns only.
- `apps/desktop/src/renderer/components/terminals/terminalTypeAhead.ts` — the
  dimmed guess at the cursor on a slow link, as a layer only. See
  [Type-ahead on a slow link](#type-ahead-on-a-slow-link).
- `apps/desktop/src/renderer/components/terminals/terminalImagePaste.ts`,
  `TerminalImagePasteNotice.tsx`, `terminalBracketedPaste.ts` — the image
  paste path (behind a narrow runtime interface), its 8 s notice, and the DEC
  2004 markers.
- `apps/desktop/src/renderer/components/terminals/terminalTranscriptNormalize.ts`
  — hydration helpers. `inferTranscriptColumns` finds the widest column a
  cursor move used; `normalizeTranscriptToGrid` replays at that width into
  plain rows, so a different-size viewer shows no "staircase" (declines under
  20 columns; caps 400 columns, 96 rows; trailing blanks popped).
  `inferTerminalModesFromTranscript` recovers DEC modes (mouse, cursor keys,
  bracketed paste…) but never alt-screen. Limit: a TUI that sets a mode and
  then prints more than the 2 MB hydration window loses it.
- `apps/desktop/src/renderer/components/terminals/ptySizeOwnership.ts` — which
  viewer sets the PTY size when a desktop window and a browser tab mirror one
  session. A hidden document never owns it, a focused one always does, else
  ownership lasts 60 s idle. A non-owning fit does not move `lastDims`.
  A pin change moves the runtime to a new key, and `teardownRelocatedRuntimes`
  removes the one left at the old key.
- `apps/desktop/src/renderer/components/terminals/workSessionTiling.ts`,
  `lib/workGrid.ts`, `ui/PaneTilingLayout.tsx`, `ui/paneTreeOps.ts` — the
  grid's seed tree (`auto`, `rows`, `columns`), grid-set membership with
  `MAX_WORK_GRID_TILES` (see [ui-surfaces.md](./ui-surfaces.md#gotchas)), and
  the shared pane tree.
- `apps/desktop/src/renderer/components/terminals/useWorkMachineRouter.ts` —
  the Work tab's one per-session routing authority. `pinForSession` resolves
  lane ownership first, then the remembered launch pin; a pin equal to the
  active binding becomes the tab's own binding. The remembered foreign pin is
  not liveness-gated, because the union scope blinks while it reloads.
  `useWorkSessions` owns the one instance (`resolveSessionRuntimePin`).
- `apps/desktop/src/renderer/lib/firstLoadRetry.ts` — retries a Work list's
  first load until it answers, at once on reconnect. Idle unless a load fails.
- `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts` — the
  Work view state (`ade.workViewState.v1` in `localStorage`).
  - `hostSessions` plus stand-in rows for new-lane launches, never cached and
    never counted as running. They show "Setting up" / "Setup failed".
  - The 30 s safety reload runs only while a row needs it: a chat with a
    running turn, a wait on the person, background work, or an unmatched
    chat; a running shell or CLI.
  - Focus, visibility and chat events refresh the list. New chats and PTYs
    show at once. A project switch shows cached rows as non-authoritative
    until the refresh returns.
  - `canMutatePinnedProjectUi` asks the router whether the binding is still
    open. `stopRuntime` and `stopAll` dispose a foreign PTY on its machine.
  - Remote-bound projects refresh running sessions more slowly.
  - Background launches skip select, focus and tab open.
  - Quiet tails: settled rows sort by `settledAt`, snoozed rows by
    `snoozedUntil`. One `setTimeout` at the soonest deadline (at most 10 min)
    re-derives the partition.
  - The board model (`buildWorkBoardModel`, `lanePrWaitingReason`).
  - Chips, pins and sort are saved per project; a deeplink override is
    transient and clears on any change. `reorderWorkLanes` switches to Manual.
- `apps/desktop/src/renderer/components/terminals/workLaneOrder.ts`,
  `useWorkLaneReorder.ts` — the lane tiers and sorts, the lane drag MIME, and
  the header drag with edge autoscroll.
- `apps/desktop/src/renderer/components/terminals/workSessionFilters.ts`,
  `WorkFilterPanel.tsx` — the chip filters (OR in an axis, AND across; Machine
  reads the row's own `machineId`) and the funnel panel (Machine only when
  more than one machine reports the repo).
- `apps/desktop/src/renderer/components/terminals/useLanePrs.ts` — the lane to
  PR map. Keys carry the machine, because a handoff copies a lane id; only
  `laneHasAnyPr` (the Has PR chip) ignores the machine. See
  [Pull requests](../pull-requests/README.md#which-machine-answers-a-pr-read).
- `apps/desktop/src/renderer/components/terminals/useSessionDelta.ts` — reads a
  `SessionDeltaSummary`.
- `apps/desktop/src/shared/cliLaunch.ts` — the one CLI launch builder, shared
  by the Work tab and the phone launcher. `CliProvider` lists every provider
  that has a CLI launch profile; `LaunchProfile` adds `"shell"`.
  `LAUNCH_PROFILE_TOOL_TYPE` and `LAUNCH_PROFILE_TITLE` map a profile to its
  tool type and tab title.
  - `buildTrackedCliLaunchCommand` returns explicit argv
    (`TrackedCliLaunchCommand`), so `ptyService.create` never types a launch
    line into a shell. `resolveLaunchFields` takes a caller's fields only when
    the caller passed any.
  - Per provider: Cursor runs `cursor-agent` and waits for its prompt before it
    types a first message (an empty launch stays idle). Droid writes a temporary
    `--settings` JSON for the permission mode. OpenCode gets only a session
    selector and `--prompt`; mode, model and effort go as JSON in
    `ADE_OPENCODE_LAUNCH`, and `attachOpenCodeTerminal` rewrites the launch to
    `opencode --server <lease url> --session <id>` (see
    [OpenCode CLI: attach to ADE's server](#opencode-cli-attach-to-ades-server)).
    OpenCode CLI launches have no `--variant`.
  - Guidance on every launch: Claude through `--append-system-prompt`
    (`buildAdeCliAgentGuidance`); Codex and Droid as a leading prompt
    (`buildAdeCliInlineGuidance`); Cursor only with a first message; OpenCode
    gets the slim chat base prompt on its session instead.
    `ADE_AGENT_SKILLS_DIRS` carries the skill roots when known.
  - An `initialPrompt` goes into argv for argv-style launches (Claude, Droid,
    OpenCode `--prompt` with the user's text only). Codex interactive and
    Cursor use `initialInput` after the PTY is ready, so it is a real first
    turn.
  - Permission modes: `auto` is Claude only; `config-toml` is Codex and
    OpenCode only (`validateLaunchProfilePermissionMode`).
  - Resume: `buildTrackedCliResumeLaunchCommand` rebuilds a structured
    descriptor from `TerminalResumeMetadata`. Windows uses it directly, so argv
    never passes through PowerShell quoting; Droid is a no-profile PowerShell
    line that writes its settings JSON as BOM-free UTF-8.
    `buildTrackedCliResumeCommand` / `parseTrackedCliResumeCommand`
    (`main/utils/terminalSessionSignals.ts`) keep the stored POSIX string.
  - Claude's `--plugin-dir` goes on the real `claude` token
    (`withClaudePluginInCommandLine` and the shell word helpers).
  - Clean shells (`resolveCleanShellLaunchFields`, and
    `ptyService.resolveShellCandidates("clean")`) skip rc files: zsh `-f`
    with `ZDOTDIR=/var/empty`, bash `--noprofile --norc`, fish `--no-config`,
    PowerShell `-NoLogo -NoProfile`, `cmd.exe /d`.
  - Plain interactive shells are login shells on macOS (`-l`). On Linux they
    are interactive, not login (a login `/etc/profile` reset PATH and lost the
    `ade` and `gh` shims); the login PATH still reaches the terminal. Windows
    accepts PowerShell 5.1 or 7, cmd, or an absolute Git Bash `bash.exe`, and
    rejects bare `bash.exe` and `wsl.exe`.
  - **Default shell** (Settings → App → Behaviour → Terminal shell, or a
    machine's page; `TerminalShellSection.tsx`): `pty/terminalShells.ts`
    finds the machine's shells (`/etc/shells` + `$SHELL`; on Windows the
    PowerShells, cmd and Git Bash, never WSL), caches them 5 min, and keeps
    the choice in `<ADE home>/terminal-shell.json`. It applies only to a plain
    shell the user opens, with Automatic as the fallback; a missing shell
    falls back with a warning. `pty.getShellSettings` and
    `pty.setDefaultShell` (CTO only; reported ids only) take the Settings
    machine pin.
  - Every PTY gets `TERM_PROGRAM=ADE` and `TERM_PROGRAM_VERSION`
    (`withAdeTerminalIdentityEnv`); the host terminal's own session pointers
    (`LC_TERMINAL`, `ITERM_SESSION_ID`, `WT_SESSION`, …) are dropped. A
    caller's or lane's `TERM_PROGRAM` is kept.
  - `deriveTrackedCliInitialInputSessionMeta` titles a CLI row from its first
    prompt (about 72 characters, guidance removed). Without AI titles,
    `ptyService` can adopt the CLI's own window title.
- `apps/desktop/src/renderer/components/terminals/cliLaunch.ts` — re-exports
  the shared module and adds `WorkPtyLaunchDisposition`, `WorkPtyLaunchArgs`
  and `WorkPtyLaunchResult`.
- `apps/desktop/src/shared/shell.ts` (re-exported by `renderer/lib/shell.ts`) —
  POSIX and Windows quoting and parsing (`quoteShellArg`,
  `commandArrayToLine`, `parseCommandLine`).
- `apps/desktop/src/shared/adeCliGuidance.ts` — the one source of CLI launch
  guidance and the bundled skill list.
- `apps/desktop/src/shared/sessionStatusNote.ts` — an agent's status line: six
  words is the guideline (`STATUS_NOTE_GUIDELINE_WORDS`), 72 characters the
  only hard bound (`MAX_STATUS_NOTE_CHARACTERS`). It never cuts at six words.
- `apps/desktop/src/shared/agentSkillRoots.ts` — the skill roots: lane,
  ancestors and home `.claude` / `.agents` / `.ade` / `.codex`, inherited
  `ADE_AGENT_SKILLS_DIRS`, and bundled resources.
- `apps/desktop/src/renderer/components/terminals/workSurfaceVisibility.ts` —
  `WORK_SURFACE_REVEALED_EVENT`: when Work shows again, xterm tiles clear
  their atlas, refit and restore focus.
- `apps/desktop/src/renderer/components/terminals/SessionContextMenu.tsx` and
  `SessionInfoPopover.tsx` — the row menu (identity, Lifecycle, Go to, Copy,
  **Open in**, lane actions, then destructive rows) and the info overlay.
  - A chat row adds **Name & status** (Rename, three Generate choices) and
    **Hand off…** (Local, Another machine, Auto handoff…). Local and Another
    machine queue the target through `lib/chatHandoffIntent.ts`.
  - A chat whose lane is still in setup, or failed it, is a launch: its menu
    has only Retry setup, Cancel setup, Pin, Remove from grid and Copy
    session ID, and Delete cancels the launch.
  - Singleton rows get **Open in** from **Lane ▸** with the row's binding.
    Ended chats get Delete chat (`ade.agentChat.delete`).
- `apps/desktop/src/renderer/components/terminals/LanePrBadge.tsx`,
  `ui/HoverCard.tsx`, `lib/lanePrBadge.ts`, `LaneActionsSubmenu.tsx`,
  `ui/OpenInSubmenu.tsx`, `ui/MenuSubmenu.tsx` — the PR badge and its preview
  card, the lane submenu and the submenu primitive. A multi-PR badge picks the
  newest open PR and lists the rest in a clamped portal. `openLanePr` sends a
  PR on the bound machine to the PRs tab and a foreign one to GitHub.
  `LaneActionsSubmenu` uses the same `buildLaneMenuGroups()` as the lane
  header, and **Start chat in lane** on a foreign row sets `draftMachineId`.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` — the `sessions.list`
  cache (`projectRoot/laneId/status`). Reads coalesce; a forced read skips
  that; invalidation drops in-flight entries, so a refresh after a change
  never reuses an old answer.
- `apps/desktop/src/renderer/lib/sessions.ts` — session labels,
  `isPtyContextInsertableToolType` (agent CLIs, not shells), and
  `getStaleRunningCliSessionAgeHours` (24 h with no output; a cleanup hint,
  not the 3 h `stale` phase).
- `apps/desktop/src/renderer/lib/transcriptExport.ts` — a metadata-only
  markdown bundle of sessions and a browser download.

ADE CLI runtime surfaces:

- `apps/ade-cli/src/bootstrap.ts` — builds `externalSessionsService` with the
  PTY, session and chat services, so the `external-sessions` domain works
  everywhere.
- `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` —
  `work.listExternalSessions`, `work.getExternalSessionDetail` and
  `work.importExternalSession` for paired controllers. See
  [Sync and multi-device](../sync-and-multi-device/README.md#external-session-import-commands).

iOS Work surfaces:

- `apps/ios/ADE/Views/Work/WorkRootScreen.swift` (with `+Actions`,
  `+Selection`, `WorkRootComponents.swift`) — the phone's Work list: one-row
  header (search, filter, compose menu), sticky lane headers, the subagent
  and shell drawers, and swipe and context menus. Visibility matches desktop
  (`workSessionShouldAppearInWorkList`): standalone CLIs always show, ended
  ones too; chat-owned shells ride their chat. No rollup count on this
  screen. View state is kept per project and host (`WorkViewStateStore`);
  quiet lanes use the same `lane-open:<laneId>` marker.
- `apps/ios/ADE/Views/Work/WorkSessionRowCard.swift` — the row card. The card
  surface is neutral, as on desktop. See
  [the iOS companion](../sync-and-multi-device/ios-companion.md#work-session-list-rows).
- `apps/ios/ADE/Views/Work/WorkSpawnNesting.swift` — the Swift mirror of
  `sessionSpawnNesting.ts`.
- `apps/ios/ADE/Views/Work/WorkSessionGrouping.swift` — lane (default),
  status and time grouping, and the quiet zone: Snoozed above Settled, both
  collapsed until opened (`shelf-open:<id>`). A pinned lane keeps its settled
  rows.
- `apps/ios/ADE/Views/Work/TerminalSessionScreen.swift`,
  `SwiftTermSessionView.swift` — the SwiftTerm terminal: `sinceOffset`
  subscribe, gap recovery, older history through `terminal_history`, the
  `screen.serialized` paint for alt-screen CLIs, ordered input through
  `SyncTerminalInputQueue`, and `terminal_resize`.
- `apps/ios/ADE/Views/Work/WorkArtifactTerminalViews.swift` — compact terminal
  previews.
- `apps/ios/ADE/Views/Work/WorkChatSessionView.swift`,
  `WorkChatComposerAndInputViews.swift`, `WorkChatRichCardViews.swift`,
  `WorkReasoningCard.swift`, `WorkNewChatScreen.swift`,
  `WorkUsageActivityCarousel.swift` — chat, composer, cards and the new-chat
  screen (**ADE chat** or **CLI session**, through `work.startCliSession`;
  Import opens the browser). The usage carousel reads the host's cached
  `usage.getAdeStats`.
- `apps/ios/ADE/Views/Work/WorkImportSessionScreen.swift` (with its rows,
  preview, presentation and action bar files) and
  `WorkExternalSessionAffordances.swift` — the phone's import flow and the
  Swift port of the import policy (`workPlanImport`).
- `apps/ios/ADE/Services/PendingSessionSettleStates.swift` — the phone's local
  overlay for an in-flight settle, unsettle or override (the columns belong
  to the host). Every UI read goes through `SyncService.localSessions()` /
  `localSession(id:)`. An intent retires on confirmation, failure or a
  staleness backstop. Snooze keeps its optimistic write plus rollback (see
  [Gotchas](#gotchas)).

## External CLI session import

Discovery is read-only: the runtime scans each provider's local store and
lists recent sessions in the current project (`scope: "all"` lists the whole
history). An import goes to a tracked CLI terminal or to an ADE chat (see
[Chat](../chat/README.md#external-chat-import)). `PROVIDER_IMPORT_RULES`
(`shared/externalSessionPolicy.ts`) decides the actions and lane rules per
provider; host capability flags can only narrow it, and the host refuses an
import the plan does not offer. Every provider except Codex must resume in the
folder the session started in, so a session inside a lane is locked to that
lane. The default target is the session's home lane, never the Work view's
lane. Continue on a session that may still be open elsewhere asks for a second
confirm; a copy keeps the original importable. The table, cwd rules and
per-provider fork paths are in
[external-session-import.md](external-session-import.md#import-policy).

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
  `opencode`, `pi`)
- agent chat sessions that run through the Claude/Codex/Cursor/Droid/
  OpenCode SDKs rather than a PTY (`claude-chat`, `codex-chat`,
  `opencode-chat`, `cursor-chat`, `droid-chat`)
- other tracked tools (`cursor`, `aider`, `continue`, `other`)

Status transitions: `running` → `completed` | `failed` | `disposed` |
`detached`. `detached` means the durable row and transcript remain, but the
process-local PTY is no longer reachable from the current ADE runtime. For a
chat, a clean stop ends a chat at rest `completed` (the next start does not
load it; a send or a scheduled wake reopens the row) and a chat with work in
flight `detached`, which restart recovery resumes.

Those persisted process statuses are intentionally separate from the canonical
UI phase. `CanonicalSessionPhase` adds `needs_you`, `stale`, `ready`, `idle`,
`stopped`, `ended`, and `settled` projections without rewriting the underlying
process status. A settled session remains in the live Work inventory and is
still openable/resumable; archive remains a separate chat-only visibility
lifecycle.

Fields that feed UI and downstream systems:

- identity: `id`, `laneId`, `laneName`, `ptyId`, `tracked`, `pinned`,
  `manuallyNamed`, `chatSessionId` (the owner of an attached terminal: a chat
  or a tracked CLI; `chat_session_id`, indexed)
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
  projected from a chat record or tracked agent CLI `resumeMetadata`, plus
  `parentIdentityKey` when the parent is an identity session
- model: optional `model` / `modelId`, projected from the chat summary so a row
  can name what it is running without opening it

See `apps/desktop/src/shared/types/sessions.ts` for the full shape.

### Identity lineage on a row

`parentIdentityKey` names the parent's identity when the parent is an **identity
session** rather than an ordinary chat. The only one is the CTO (`"cto"`). It is **absent**, not null, for the overwhelmingly common case
of no parent or an ordinary parent, so absent is the single no-op value.

It has to be stamped host-side: identity rows are filtered out of every session
roster, so a renderer cannot see the parent to ask it.
`chatSessionProjection` does it two ways. `projectChatSummariesOntoSessions`
builds an id→identity index in the same loop that already collects the identity
rows it is about to drop, so there is no extra fetch and no renderer cache; the
single-session `getSessionWithChatProjection` has no roster and reads the parent
summary directly. Either way the key is stamped only when the chat actually has
an `orchestrationParentSessionId`.

The same projection carries the chat's `model` / `modelId` onto the row, with
blank treated as absent — "we don't know" and "no model" are the same value, and
a CLI or shell row has no model at all.

## The Work board

The Work tab has a second view of the same roster: a four-column Kanban board,
toggled beside the organization control. The view mode is its own
`WorkProjectViewState` field (`workViewMode`, default `"list"`), deliberately
**not** a fourth `sessionListOrganization` value, so the grouping you left is
the grouping you come back to. It is additive, so no view-state version bump.
Opening a row from the board flips back to the list.

### The columns

The vocabulary is declared once in `shared/types/chat.ts` — `WorkBoardColumn`,
`WorkBoardMoveTarget`, `WORK_BOARD_MOVE_TARGETS`, `WORK_BOARD_COLUMN_LABEL` —
and everything else imports it: the action registry that writes moves, the
renderer that buckets cards, and `ade session move`. Values are snake_case
everywhere, the renderer's bucket keys and `data-testid`s too.

| Column | Membership | Drop target |
| --- | --- | --- |
| **Needs you** | the `needs_you` phase only — a raised hand | yes |
| **Working** | what is left of the running partition after Waiting takes its share | yes |
| **Waiting** | snoozed rows, plus running rows whose lane PR is mid-CI or has a review requested | **no** |
| **Done** | resting rows (`ready`/`idle`), then ended rows, then settled rows | yes |

Each card shows at most one status label and icon. In Kanban, the column names
the parent state, so the card does not repeat it. A current activity detail can
occupy the card's one status slot; **Needs you** takes that slot whenever input
is pending. The list view uses the same single effective status, so an activity
detail replaces the generic **Working** label instead of appearing beside it.

The first column takes the `needs_you` phase, **not** the list's whole
`awaiting-input` partition. That partition is a container holding three phases —
`needs_you`, `ready` and `idle` — which is why the list names it "Your move" and
lets each card state its own phase. The board's first column is a claim, not a
container: it is amber and it says the row is blocked on the user. `ready` and
`idle` are already emerald "Done" on their own cards, so they file under Done
here, loudest tier first — resting rows are live sessions that just finished a
turn, settled is what the user already filed away.

The host's `deriveWorkBoardColumn` maps a phase through
`canonicalBoardColumnForPhase`; the renderer's `buildWorkBoardModel` reaches the
same answer one level up, from the list's filing buckets plus a `needs_you`
split. The two must agree, or a drag's host-authored "you moved this chat from
<column>" message names a column the user never saw.

Waiting is not droppable because a row sits there for a reason a drag cannot
assert — it is snoozed, or its PR is waiting on someone else. `canAcceptDrop`
refuses it by type and at runtime, and because only a `preventDefault`'d
`dragover` makes an element a drop target, the column shows the browser's own
"no drop" cursor with no affordance to suppress.

`buildWorkBoardModel` builds the buckets from the **already filtered** list
partitions rather than re-deriving from the raw roster, and assembles Waiting
*first* so the four are a partition by construction rather than by four
predicates that have to agree. The PR half is `lanePrWaitingReason`: only
`open`/`draft` PRs count, a pending checks status is `"ci"`, a requested review
is `"review"`, and `none`/`not_run` deliberately are not a wait (nobody has
looked yet) while `failing` is the agent's problem rather than a wait. The hook's PR lookup is the **bound** machine's set, so a foreign lane's CI
cannot park a local row in Waiting. The board the pane paints is the sidebar's
union: those bound-machine columns, then every other connected machine's chats,
each filed with that machine's own PR wait. A foreign card carries the same
runtime pin as its sidebar row, and a drag moves it on that machine. The
reason shows as the card's chip. New chat leaves the board and
opens the list-mode draft, because the board occupies the surface the draft
draws on.

The host keeps its own, deliberately narrower derivation in
`deriveWorkBoardColumn`: snooze alone puts a row in Waiting there, because the
host has no reason to consult PR state to answer "which column was this card in
when the drop landed". The two disagreeing is expected and handled — a card the
user sees in Waiting for CI derives as `working` on the host, so dragging it to
Working is a legitimate no-op, and the no-op toast says so ("The PR is what is
waiting, not the chat.").

### What a move does

A drag is two writes that must never come apart: the lifecycle columns that
decide the column, and a message telling the agent what the user just did. A
status write with no message is a card that moved while the agent kept doing
what it was doing; a message with no status write is a nudge about a move that
did not happen. So both are staged together and both land together.

Every target first wakes the row (a snooze keeps filing a row in Waiting even
once settled), then:

| Target | Lifecycle write | Message |
| --- | --- | --- |
| **Done** | clear the attention request, clear the settle override, settle with source `user` | none — a move to Done would start a turn on a chat the user just quieted |
| **Working** | unsettle, clear the attention request, pin the override to `"active"` so it cannot fall back to Done on the next idle tick | only when moving *from* Done: "You moved this chat from Done to Working. …" |
| **Needs you** | unsettle, clear the override, raise attention with source **`user`** and the message "Parked for your input." | "The user parked this for their input. Stop, summarize where you are, and list what you need from them." |

No target writes a snooze. The attention source is `user`, never
`agent_explicit`: the source is auditable and must not claim the agent asked for
something.

The message is dispatched as a normal chat message carrying
`metadata.boardMove` (`from`, `to`, `at`, `moveId`). That metadata is
host-stamped only — `from` is host-derived, and `boardMove` is one of the
`HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS` the host strips from any caller-supplied
metadata, so neither a rule nor an agent can forge "the user moved this card".
The chat transcript renders it as a divider (`Moved on the board · <from> →
<to>`) with the exact text the agent received underneath, never as a user
bubble: the user dragged a card, they did not type that sentence.

### Undo, and the honest bound on it

The message waits `BOARD_MOVE_STAGE_MS` (5 seconds) before it is sent. Within
that window `undoBoardMove` cancels the message and restores the snapshot the
move captured; after it, the message goes out and the move is final. If the
dispatch itself fails, the status write is reversed with it.

Restore order matters: override, then re-settle or unsettle, then attention
**last** — settling clears the attention columns, and needs-you outranks settled
in canonical precedence. A snooze whose deadline has already passed is not
restored, and a re-settle is stamped now rather than backdated, because no write
path backdates.

A refusal says which kind it is. `already_dispatched` means the agent has been
told; `unknown_move` means ADE no longer holds the move at all. They are
different facts and the toast says different things, so they are not collapsed
into one boolean. The dispatched-id memory is a capped FIFO, and an id that ages
out answers `unknown_move` — the truthful fallback.

At most one move per session is in flight: staging a second one drains the
first, so an undo can only ever reverse the most recent. A duplicate drop on the
column a card is already in is a pure no-op, checked *before* the drain, so it
cannot cut a real move's undo window short.

The bound, stated plainly: the staging map is in-process, and the drain is
guaranteed on exactly one path — a graceful shutdown, where the desktop host
awaits `flushStagedBoardMoves` first in its sequence, before the services the
dispatch needs are torn down. Every other exit only *attempts* it: the immediate
cleanup path fires the drain without awaiting it, so the send starts against a
live service but can be cut off by `process.exit`, a signal-driven fast kill, the
shutdown force timer, or Electron's `will-quit`. When that happens the status
write survives without its message — nothing in a single process can prevent
that — and `undoBoardMove` answers `unknown_move` for the orphan rather than
claiming it dispatched. The fast-kill prelude deliberately skips the drain,
because claiming moves synchronously there would empty the map and turn the
awaited drain into a no-op.

### Who may move a card

`session.moveOnBoard` and `session.undoBoardMove` are in the action allowlist
and are **CTO-only**. A board move writes the same lifecycle columns a settle
does and then tells the agent the user moved it; both halves are the user's, so
a session-bound agent authenticating as `agent` cannot move
its own card and then congratulate itself on being told to. Unattended
automations cannot call them either, since the automation predicate is
"allowlisted and not CTO-only".

Agents are told this directly. `ADE_BOARD_STATUS_GUIDANCE` — "Your status on the
Work board is derived from your turn state and your note. Keep the note current
with `ade chat note`, and use `ade chat ask` when you are blocked." — opens the
session status protocol, and the `ade-cli-control-plane` skill says outright that
there is no command that moves your own row.

The lifecycle columns are `settle_override`, `snoozed_until`, `snoozed_at`,
`woke_at`, and `woke_reason` on `terminal_sessions`. All five are nullable text
with **no unique index**: the table replicates to iOS through cr-sqlite, and
`crsql_as_crr` rejects any non-primary-key unique index. `kvDb.ts` both declares
them in the create-table statement (fresh databases) and adds them through
`safeAddColumn` (existing ones). The same columns must exist in *both* iOS
halves — `apps/ios/ADE/Resources/DatabaseBootstrap.sql` for fresh installs and
`Database.swift`'s `ensureColumn` migrations for upgrades. A missing iOS half
does not fail on desktop; it surfaces as changeset-apply errors on the phone.
The nullable `settle_nudge_turn_id`, `settle_nudge_done_probability`, and
`settle_nudge_dismissed_turn_id` columns also replicate with this row. They do
not affect canonical session state; iOS stores them for sync compatibility.

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
   so continuation works after the CLI itself assigns an ID. Fresh tracked
   Claude, Qwen, Grok, and Copilot launches get a pre-assigned session id on
   the command line (`--session-id`, Grok `-s`, Copilot `--session-id=`), so
   the resume target is known from the first byte; a continuation launch never
   gets one. Kimi has no such flag, so ADE adopts the session folder the launch
   created in Kimi's `wd_<slug>_<hash12>` layout, and only when it can prove
   the cwd. See
   [Session tracking](external-session-import.md#session-tracking).

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
   - `summarizeSessionBestEffort` writes the deterministic end-of-session
     summary and, when an AI provider is available (not guest mode),
     regenerates the title from the transcript tail.
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
   Settle/Unsettle comes only from user surfaces (the context menu and the
   multi-select footer) and the PR-merge policy. Agents cannot settle: a
   self-settling chat would leave the user's list on the agent's say-so. A
   `needs_you` row becomes **Dismiss & settle**. For an SDK
   chat, the service interrupts Claude/Codex/OpenCode/Cursor/Droid work,
   cancels live and restored waiters, removes Codex plan follow-ups, persists
   idle state, and only then settles. A tracked CLI may dismiss an explicit
   `ade chat ask` marker; a raw provider TUI prompt instead shows **Resolve
   input to settle** and must be handled in the terminal.

   A brain-side sweep checks up to 10 idle chat turns every 30 minutes after
   they have been quiet for three hours. It asks optional Jev whether the last
   assistant reply finished the request, then stores the probability on the
   synced session row keyed to that turn. A high-confidence positive replaces
   the row's ordinary status label with **Looks finished · Settle**. The pill
   runs the same user settle action and never settles on its own. New turns,
   settle/unsettle, snoozed rows, pending input, active work, and failed turns
   do not show it. A failed Jev call leaves the existing row UI alone. The
   `settle_nudge_*` columns are present in both desktop and iOS
   schemas so phone sync accepts the verdict; iOS does not draw a badge.

7. **Activity and escalation** — a new user turn clears a chat's settle,
   explicit attention, and last-turn-failure markers. PTY output clears settle
   because the process is active again. Scheduled/background wakes are
   different: an explicitly settled chat shows running while the unattended
   turn streams, retains `settledAt`, and returns to Settled when it rests.
   `ade chat ask` clears settle, persists the blocking question and its
   `agent_explicit` provenance, marks a live tracked CLI as waiting-input, and
   publishes a time-sensitive push; the next accepted user message clears it,
   including an active-turn steer. Agent-to-agent steers do not dismiss the
   user's pending question. A chat whose turn ends while it still owns live
   background work reads as running, so ADE raises the same hand for a
   question left in that reply, with source `turn_end_question`
   (`chat/turnEndQuestionCheck.ts`): rules on the reply's ending raise it for
   a clear ask and skip a progress note, and an unsure ending goes to Jev
   (any provider), then, when Jev gives no clear answer, to the provider's
   cheap model (Claude, Codex, Cursor), with a staleness guard on the turn
   id. Subagents are skipped, and nothing runs on replay. Provider
   structured input carries its own pending item id. OSC markers do not create
   `Needs you`; an available Jev decision may do so only for a high-confidence
   input prompt after the terminal becomes idle. `ade chat note ""` clears
   only the status line. Status notes are trimmed to at
   most 72 characters at the session-service boundary so the sidebar remains
   glanceable; blocking detail belongs in the separate `ade chat ask` question.

   Beyond the binary settle there is a tri-state **settle override**
   (`terminal_sessions.settle_override`). `"settled"` behaves like a declared
   settle; `"active"` is the explicit keep-active pin; `null` returns the row
   to the declared rules. An explicit settle drops a stale `"active"` pin, and
   unsettle drops only a `"settled"` pin. `attention_source` and
   `settle_source` record where the current declaration came from. New
   settles are `user`, `operator` (CTO) or `pr_merge`; `agent_explicit`
   remains only on old rows. Session Info shows the source.

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
   `buildWorkTabGroupModel` consume that rule through
   `effectiveSessionFilingBuckets` (whose base rule is `sessionFilingBucket`);
   the iOS `workSessionGroups` snoozed
   tail all use it; `isSessionSnoozed` stays the raw read for row chrome.

   Agent- and operator-reachable entry points:

   - CLI — `ade session snooze <id> --for 1h|--until <iso>|--until-asked`,
     `ade session wake <id> [--reason ...]`, `ade session clear-woke <id>`,
     `ade session show <id> --text`, and `ade session actions --text` for the
     raw action list. Each takes the id as a positional, accepts
     `--session <id>`, and falls back to `$ADE_CHAT_SESSION_ID`, so a bound
     agent can file itself. Duration grammar and the 30-day cap come from
     `sessionSnoozeDuration.ts`. No CLI command settles: only the user and
     the PR-merge policy settle.
   - Action registry (`session` domain) — agent-reachable: `snoozeSession`,
     `snoozeSessions`, `wakeSession`, `wakeSessions`, `clearWokeMarker`.
     CTO-only (i.e. reachable from the desktop renderer's remote-runtime client, which authenticates at cto role, but refused for a
     session-bound agent): `settleSession`, `unsettleSession`, `settleSessions`,
     `unsettleSessions`, `setSettleOverride`.
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
   daemon, an attached CLI runtime) and is left alone; a row whose owner is
   known on this machine but no longer live can be swept; a row whose owner is
   unknown is preserved because it may belong to another synced machine.
   Freshly started or recently-outputting rows get a short grace window before
   they can be detached, so a new runtime cannot immediately close a CLI
   session created by the process it just replaced. Chat rows are swept like
   any other row (`excludeToolTypes` exists, but no host passes chat types),
   because chat runtimes start fresh. Ended chats stay resumable through the
   SDK, or `ade.agentChat.delete` removes them.

   **A clean stop ends its own rows first.** Both hosts call
   `sessionService.endRunningSessionsOwnedBy([{ pid, startedAt }])` with the
   stopping process's registry identity, after every service that drives a
   session is down and before `processRegistry.stop()` removes its row.
   - The chat service ends its chats at rest as `completed`
     (`chatHasWorkInFlightAtStop`). The host ends every other row it still owns
     as `detached`, so restart recovery resumes it.
   - A desktop project close or quit goes through `disposeAll`: `completed`
     only for a chat at rest whose row this process owns, `detached` for the
     rest (a chat whose runtime another brain holds keeps `detached`).
   - The brain's shutdown and the desktop's emergency path go through
     `forceDisposeAll`, which ends only rows this process owns as `completed`.

   **Rows an earlier clean stop stranded.** `closeStrandedLocalSessions` runs
   before the reconcile at every start and rescan.
   - The cr-sqlite clock proves that an owner is from this computer (site 0
     wrote the owner columns and the status), so a row synced from another
     machine never qualifies.
   - Owners the registry still lists are a crash, not a clean stop: those rows
     stay with the reconcile and close `detached`.
   - For the others, each row ends once its pid is gone, at its own last
     output: a chat quiet for longer than `RESTART_RESUME_MAX_AGE_MS` (6 h)
     ends `completed`, and a newer one ends `detached`.
   - The call passes the row ids and the update re-checks the owner, so a row
     a peer wrote last, or a chat another brain takes over mid-scan, stays
     untouched.

   Both hosts re-run the reconcile once after startup —
   `setTimeout(…, STALE_RUNNING_SESSION_RESCAN_DELAY_MS)` in desktop `main.ts`
   and in the brain's `apps/ade-cli/src/bootstrap.ts`. The constant is owned by
   `sessionService.ts`, next to the grace it is built from, and is
   `max(DEFAULT_PROCESS_REGISTRY_LIVENESS_WINDOW_MS, STALE_RUNNING_SESSION_FRESH_ACTIVITY_GRACE_MS) + 1s`.
   **Both** windows have to pass, or the rescan skips the same rows again. A
   row wrongly detached anyway is repaired by activity or by a
   turn — see [Stale-detached repair](#stale-detached-repair) below.

11. **Delete** — `sessionService.deleteSession(sessionId)` removes a
   row outright and emits `terminalSessionChanged` with
   `reason: "deleted"` so renderer caches drop it immediately.
   `agentChatService.deleteSession` wraps this for chat rows: it
   disposes a live runtime, cancels the pending turn collector,
   rejects outstanding input waiters, deletes the persisted JSON and
   transcript (path-safe under `.ade/`), and then calls the session
   service. PTY rows use the same `deleteSession` as their deletion
   primitive.

### Stale-detached repair

The reconcile decides liveness from the process registry, which can be wrong for
a session whose owner is another ADE process, or whose registry row has not been
observed yet at boot. Such a session is marked `detached` while it is still
streaming, and the Work tab paints the frozen `ClosedCliSessionSurface` ("Ended")
over a live PTY. Two repairs undo it, and the split is deliberate:

| Repair | Reopens from | Fires on |
|---|---|---|
| `reopen(sessionId)` | any non-`running` status | chat lifecycle sites about to drive the session themselves — turn start, restart recovery, keeping a chat open across a runtime close. A turn arriving *is* proof the row is wrong. |
| `repairStaleDetachOnActivity(sessionId)` | `detached` only | every activity write (`setLastOutputPreview`, `touchLastOutput`). This is the repair that lands **between** turns, and the only one PTY / tracked-CLI rows ever get — every `reopen` call site is a chat lifecycle site. |

The narrow one is safe because it only ever fires while the live runtime *in
this process* is producing output for the session: the caller is by construction
the owner, and a genuinely dead session produces no activity, so nothing can be
resurrected here.

Both go through one private `reopenRow(sessionId, scope)`. The scope predicate
lives in the `WHERE` rather than in a read-modify-write, so a concurrent writer
cannot lose a race against a value this process read earlier; it is a PK seek
that matches nothing in the normal case. `status` / `ended_at` / `exit_code` are
plain CRR columns (not settle-tuple columns, so this stays outside the settle
chokepoint) and merge last-writer-wins. `terminalSessionChanged` is emitted only
when a row actually moved, so calling either on an already-running row is
idempotent and silent — and without that emit the renderer never learns the
session went back to `running`.

`agentChatService` also calls `sessionService.reopen` on the **persisted** row
every time it opens a session, because a hot chat's in-memory status is never
`ended` and would hide a wrong `detached`.

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
  `effectiveSessionFilingBuckets` (whose base rule is `sessionFilingBucket`,
  canonical lifecycle plus
  `isSessionFiledAsSnoozed`), and rendered as two separate tails; every
  surface — desktop, iOS, hosted web, `ade` CLI, CTO tools — has
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
  right `WorkSidebar` open/width) to `localStorage` under
  `ade.workViewState.v1`. The sidebar fields are
  `workSidebarOpen: boolean`, `workSidebarWidthPct: number` (clamped to
  26–55), and `workSidebarTool: "terminal" | "browser" | "git" | "pr" | "files" |
  "ios" | "app-control" | "mac-desktop" | "windows-desktop" | "issues" | null`
  (null = the picker page). The Issues tool's open issues are stored
  separately, per lane, under `ade.work.issueTabs.v1` (see
  [Issues](../issues/README.md)). The PR tool is
  per lane.
  `workSidebarTool` is read and written on the **lane** scope, falling back
  to the project scope when no lane is bound; the other two are always
  project-wide. Lane-scoped state uses a composite
  `projectRoot::laneId` key. The payload is version 5 and also owns the Lanes
  tab's filter, pinned lane ids, and expanded lane id so those controls survive
  route/project remounts. The settled-collapse migration has its own version,
  so a later schema bump cannot collapse a section again.
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
| `ade.sessions.moveOnBoard` | a Work-board drag: the lifecycle write for the target column plus the host-authored message staged for 5 s. Returns `SessionBoardMoveResult`; `changed: false` means the card was already there and nothing was written. |
| `ade.sessions.undoBoardMove` | reverse a staged move by `moveId` while it is still staged. Returns `SessionBoardMoveUndoResult`, whose refusal names `already_dispatched` or `unknown_move`. |
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

Attached terminals (`ade.terminal.*` — used by the chat/CLI terminal panel, the App Control panel, and the headless `ade terminal` / `ade app-control` CLI commands):

| Channel | Purpose |
|---|---|
| `ade.terminal.list` | list `ChatTerminalSession[]` (filterable by owner `chatSessionId` and/or `laneId`). Rich rows: `toolType`, `goal`, `resumeCommand`, `resumeMetadata`, `lastOutputPreview`, `summary`, status / runtime state. Chat-toolType sessions are filtered out so the surface only lists shells and tracked agent CLI terminals. |
| `ade.terminal.read` | tail scrollback by explicit `terminalId` *or* by owner `chatSessionId`. Returns `{ terminalId, data, nextSince }` for incremental polling. |
| `ade.terminal.preview` | serialized buffer snapshot for the mobile renderer. Each live PTY mirrors output into an `@xterm/headless` Terminal + `SerializeAddon` and debounce-writes a JSON file under `.ade/cache/terminal-snapshots/`. The preview call flushes the in-flight write, reads the snapshot (`TerminalSerializedSnapshot` with serialized scrollback, visible-row cells, cursor / viewport / buffer-type metadata), and falls back to a transcript tail when no snapshot exists yet. |
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
session-owned) `ADE_CHAT_SESSION_ID` into the spawn env. There is no
browser token: `ade browser` from any terminal works, and the chat id only
tags which chat owns the tabs it opens. These identity variables are how a
plain shell that the user types `ade --socket terminal read --chat-session
"$ADE_CHAT_SESSION_ID" --text` into will resolve to the owning session's
terminal even though no agent runtime spawned it. The headless ADE
runtime and agent chat runtime both layer the same identity envs
(plus `ADE_WORKSPACE_ROOT`) on top through `buildAgentRuntimeEnv`.

## OpenCode CLI: attach to ADE's server

A tracked OpenCode TUI launch does not run standalone. By default the 2.0 TUI
connects to OpenCode's own shared background service on the user's default
data home (and migrates their v1 store in place); ADE instead points it at its
own managed server, the same one chat sessions use.

`attachOpenCodeTerminal` (`openCodeTerminal.ts`) intercepts a plain `opencode`
launch (a direct spawn or a startup command whose command line is `opencode`
with no shell operators — anything more, such as a pipe or `&&`, is refused,
because only a plain invocation can be redirected) and:

1. Acquires a lease on ADE's shared OpenCode server
   (`acquireOpenCodeServer`).
2. Resolves the session: an explicit `--session <id>` re-attaches (falling back
   to a fresh session if that id lived only in the user's own store, which
   ADE's server never opens), `--continue` picks the newest session for the
   working directory, and otherwise a new session is created with the ADE
   agent for the permission mode and the resolved model.
3. Writes ADE's instructions onto the session as an instruction entry
   (`buildOpenCodeAdeInstructions`, built from the same
   `buildCodingAgentSystemPrompt({ runtime: "opencode" })` the chat runtime
   uses) and sets `session.environment` from the terminal's own environment,
   because the agent's shell commands run in the server process now, not in
   the TUI.
4. Rewrites the launch to `opencode --server <lease url> --session <id>`,
   with `OPENCODE_SERVER_PASSWORD` in the PTY environment. Without the
   password the TUI refuses the server. The TUI takes no `--agent` or `--model` flag, since ADE's
   agents and rules live on the server; those and any other ADE-owned or
   2.0-rejected flags (`--agent`, `--model`/`-m`, `--variant`, `--mini`,
   `--replay*`, a stray `--server`/`--standalone`) are stripped from a
   persisted 1.x-era resume command, which would otherwise make the 2.0 TUI
   exit on launch. On macOS and Linux a resume runs through a login shell
   (`/bin/bash --noprofile --norc -lc '<line>'`), so the rewrite replaces that
   shell's `-c` string too; rewriting only the stored startup command would
   leave the shell running the old line against OpenCode's own store.

The server URL and password change on every server start, so neither is ever
persisted — the stored startup command stays a plain
`opencode --session <id>`, and the current lease's `--server`/password pair is
applied fresh on every relaunch. `config-toml` is its own permission mode
rather than folded into `edit`: it means "use your own OpenCode configuration",
so ADE sets no agent and no permission policy for it, and the instructions say
so explicitly rather than asserting a tier ADE never set.

## Terminal watch (`ade terminal watch`)

A chat can ask to be woken when an ADE terminal prints something new, instead
of polling `ade terminal read` (whose `--since` cursor is positional in a
sliding window, not an absolute offset).

- **Service:** `main/services/pty/terminalWatchService.ts` (state machine),
  `terminalWatchOutput.ts` (ANSI strip, `\r` redraws, spinner/paint lines,
  repeat collapse, excerpt), `shared/terminalWatch.ts` (wire types, lifetime and
  `match` parsers). Wired in `apps/ade-cli/src/bootstrap.ts` (the brain) and
  `main.ts` (legacy in-process desktop).
- **Event driven.** One `ptyService.onData` / `onExit` subscription, held only
  while a watch exists. Per chunk it only appends; cleaning and matching run
  once per wake. Baseline is the stream at arm time; a `--command` watch
  buffers from the shell's first byte.
- **Debounce:** wakes after 3 s of quiet, or 20 s max for a process that never
  goes quiet. Pure paint, nothing matching `match`, or the same excerpt as the
  last wake: no wake. Excerpt: newest ~4 KB; at most 64 KB of raw output is
  kept between wakes (the rest is counted and reported).
- **Wake path:** `agentChatService.messageSession({ kind: "wake" })` with
  `metadata.terminalWatchWake` (a `terminal_watch_wake` card), the same path
  PR watch uses. While the chat is mid-turn the output is held and coalesced
  into one wake at the turn's end; a moved-away chat holds until it is back. A
  settled chat is still woken (settle stops nothing), and the wake's turn
  takes it out of settled. Archived/deleted chats end the watch.
- **Caps:** 5 watches per chat, 100 per brain, lifetime 2 h default (1 min to
  24 h), 20 wakes an hour. The lifetime or wake cap, and the terminal exiting
  (with its exit code), end the watch with one final wake. Stop/unwatch is
  quiet. A second watch on the same terminal from the same chat replaces the
  first.
- **Remote:** actions `terminal.watch` / `unwatch` / `listWatches` (allowlisted
  in `actionPolicy.ts`, read/write in `adeActionAccess.ts`). The watch runs on
  the brain that owns the chat and refuses a terminal that is not live there.
  The chat pane's **Watching** section (`ChatTerminalWatches.tsx`) reads and
  stops them through the chat's pin and re-reads on the `meta-updated`
  session event the service raises for the chat (`sessionService.notifyChanged`).
- **Persistence:** in memory only. Watches end when the brain restarts; agents
  re-arm. CTO tools: `watchTerminal` / `unwatchTerminal`.

## Type-ahead on a slow link

A plain shell on another machine shows the characters you type straight away,
dimmed and with a dotted underline at the cursor, until the machine's echo
arrives (`terminalTypeAhead.ts`). The window picks it per terminal from the
connection snapshot: on when that machine's slow-connection mode is on, or its
measured round trip is 200 ms or more, and never when the machine's setting is
**Off** (`useTypeAheadRoundTripMs` in `state/projectMachines.ts`). Agent command
line tools get none of it — they draw their own input box, so a guess at the
cursor is not safe there (`toolType` other than "shell" or none) — and neither
does any terminal in the alternate screen. The rules are mosh's: only plain
narrow characters; Enter, Tab, arrows, control keys and pastes clear the guess;
after a clear, nothing shows until one guess comes back as the program's own
echo; a guess expires after max(1 s, 3 × round trip). Confirmation is
deliberately strict: only an output chunk that is exactly the typed characters
confirms a line, and output that starts a new line clears it, so a prompt that
echoes nothing (a password) never shows what was typed. A guess is one DOM
layer over the terminal, never input, so a wrong guess cannot change the
screen. See [Remote runtime](../remote-runtime/README.md#a-slow-or-dropping-link).

## Gotchas

- **No whole-buffer work per PTY chunk in the brain.** A flood delivers
  thousands of chunks a second. The live tail (`recentOutputTail`) may
  overshoot its 2M-character cap by 500K and is cut back only then; read it
  through `readRecentOutputTail`. The resume-command scan runs at most every
  250 ms, with a trailing scan and a final scan on close. A per-chunk copy
  of the tail pins the brain at 100% CPU (`docs/perf/macos-baseline.md`,
  "Terminals").
- **PTY output is flow-controlled; keep pauses counted and bounded.** The
  pty host pauses a PTY past 256K unacknowledged chars (`RemotePty.emitData`
  acknowledges after the listeners ran, even if one throws), and a brain
  connection more than 1 MB behind pauses the PTYs printing over 16K per
  200 ms until it drains (`ptyOutputFlowControl.ts`). Pause reasons are
  counted per entry (`setOutputPaused`), so transcript rollover and flow
  control cannot release each other; a connection that does not drain within
  1.5 s is ignored until it catches up, and a paused PTY is resumed before
  kill/dispose so its exit is read. Never let output overtake replies or the
  reverse: a snapshot reply that overtakes older output gets that output
  painted over it.
- **A PTY host serves up to 8 terminals.** Each host is a whole Node process
  (about 18-25 MB). A host crash ends every terminal it serves (they show as failed); new
  terminals start a new host. A terminal that ignores kill, or whose spawn
  timed out, is killed on its own through its host's live handle
  (`disposeInHost`), never by killing a host others still use. node-pty on
  Windows rejects a signal, so the worker calls `kill()` without one there. Every spawn must pass its own `env` and `cwd`: a shared host's own
  environment is from whenever it started.
- **Parked terminals give their WebGL context back after 30 s**
  (`PARKED_WEBGL_RELEASE_MS`) and take one again on the next mount
  (`reclaimParkedWebgl`). Only `MAX_WEBGL_TERMINALS` exist, so a terminal
  that keeps its context while hidden pushes newer ones onto the DOM renderer.
- **A resumed terminal erases its old output before rehydrating.** A parked
  runtime pauses its stream; on reveal the hydration payload carries the
  history again, so `finalizeHydration` clears screen and scrollback with
  escape codes in the same write (not `term.reset()`, which would drop
  bracketed paste and cursor-key modes). Alternate-screen content repaints in
  place and is left alone. The blank-pane check reads xterm's buffer for
  WebGL terminals: WebGL leaves `.xterm-rows` empty, and the DOM check made
  every WebGL pane look blank and fetch its history a second time.
- **Open in is SSH-or-local, never paired.** `resolveOpenInTarget` returns
  null for `transport: "paired"` and for a missing worktree path. Do not
  spawn a local editor against a remote path, and do not add **Open in**
  to projectless personal chats — they have no user-visible lane/repo/PR.
  Singleton rows, local and foreign SSH, put Open in under **Lane ▸**, which
  gets the row's binding.
- **Snooze must never reach `canonicalSessionState()`.** The moment a phase is
  derived from `snoozed_until`, a snoozed row starts lying about what it is
  doing and every count, badge, and capsule downstream inherits the lie. Snooze
  only changes where a surface *files* the row, through
  `isSessionFiledAsSnoozed` (wrapped with canonical lifecycle as
  `sessionFilingBucket`, then relationship-aware filing in the desktop
  renderer). The shared helper yields to a
  `needs_you` phase,
  which is what makes "Until I'm asked" true for tracked CLI rows at all: their
  needs-input state is purely derived, so no early-wake event ever fires for
  them and filing is the only thing that can un-hide them.
- **There is no snooze scheduler.** Expiry is derived by comparing
  `snoozed_until` to now, everywhere. The Work hook, open chat, command palette,
  and standalone foreign-row pane use bounded render-only timers to nudge a
  re-render; none is the source of truth or mutates a row. A watchdog that
  writes on expiry would create a second, divergent answer on every surface
  that is not running it. Similarly, only `markLastTurnFailed` applies the
  strictly-newer-than-`snoozed_at` comparison — drop it and the error the user
  snoozed on top of instantly re-wakes the row, making snooze a no-op.
- **PTY text only creates a hand through the optional idle classifier.** A
  prompt-looking screen alone is not enough evidence, and plan-looking text is
  not a reliable mode event. When Jev is enabled and available, the PTY service
  sends up to 40 visible lines after an idle transition and raises `cli_prompt`
  only for a waiting-for-input answer at confidence 0.85 or higher. Failures,
  null, low confidence, and all other answers preserve idle. Plain shell
  prompts and OSC 133 prompt markers skip classification. Structured provider
  input remains a separate adapter event with its own provenance.
- **Never stamp `provider_structured` without an item id.** Because
  `canonicalSessionState` treats that source as a needs-you trigger in its own
  right, independent of the item id, stamping it alongside a null
  `pendingInputItemId` manufactures a "Needs you" that names no card: there is
  nothing to answer, and answering the card that just settled does not clear it,
  because the next projection re-stamps the source. `chatSessionProjection`
  stamps it **only** when it can name the card, and otherwise clears a stale
  structured claim and leaves any other source alone
  (`chatSessionProjection.test.ts`).
- **Settling a card is not the whole answer.** Clearing `pending_input_item_id`
  leaves `attention_requested_at`, `attention_message`, `attention_source`, and
  `last_turn_failed_at` behind, which is the other half of "I answered it and it
  still says Needs you". `respondToInput` clears the turn-start markers once,
  after delivery actually succeeded, rather than at a dozen early returns; the
  paths that empty a provider's pending-approval map while the session survives
  emit a `pending_input_resolved` receipt per item instead of clearing bare, so
  the event scan stops naming an unanswerable card; and an answered plan
  approval whose followup is still staged is suppressed by item id (never by
  downgrading `awaitingInput`) until its real receipt is written.
- **Process exit is not settlement.** A clean exit-0 row remains ended until an
  agent/user declaration or the enabled PR-merge policy settles it. New
  lifecycle surfaces must not infer task completion from process mechanics.
- **`settled_at` / `settle_override` / `settle_source` are host-authoritative —
  a controller must never write them into its replica.** `terminal_sessions` is
  a CRR table, so such a write replicates upstream carrying no host lifecycle
  revision, and can win a merge against a host that *rejected* the settle. That
  defeats the guard by merge rather than by caller, which no amount of host-side
  checking closes. iOS shows a local pending overlay instead
  (`PendingSessionSettleStates.swift`), and `syncHostService` drops those columns
  from inbound **phone** changesets so an older build cannot bypass the rule. The
  filter is deliberately not applied to desktop peers: they run the same
  `sessionService` chokepoint, so their settle writes are host-decided and must
  keep replicating. The snooze columns are exempt — the phone owns its optimistic
  write there because no host decision is at stake. See
  [sync → Host-authoritative columns](../sync-and-multi-device/README.md#host-authoritative-columns-are-peer-scoped).
- **Settlement is not a pending-input response.** Never call
  `respondToInput` and then settle from the renderer. A provider decline may
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
  The predicate lives in `sessionSpawnNesting.ts` (re-exported from
  `renderer/lib/sessions.ts`) because by-lane filing also has to tell a chat
  from a tracked CLI subagent.
- **Spawn nesting is one shared rule.** Same-lane `spawnKind: "subagent"`
  filing lives in `sessionSpawnNesting.ts`, with a Swift mirror in
  `WorkSpawnNesting.swift`. Desktop and iOS consult that index. Do
  not re-derive nest / quiet-parent pull-up / grandchild flatten in a list
  renderer — a demote, a quiet parent, or a grandchild will disagree across
  surfaces. `ade chat list` stays a flat table on purpose.
- **Mobile/web replacing hydrates cannot replay a transcript tail for an
  alt-screen TUI.** Desktop keeps a headless xterm and hydrates from
  SerializeAddon current-screen CSI. A days-long Claude Code session's last
  512 KB is CUP/EL at the desktop width with the DECSET long gone, so a
  replay of that tail alone paints black. `terminal_snapshot.screen` carries that serialize
  (`scrollback: 0`, omit if over 256k chars — never slice CSI). Deltas stay
  transcript-only. Clients that do not know the field keep the old tail
  replay. While a phone/web peer is subscribed, desktop fit-resizes remember
  lastDesktop* but must not call live `pty.resize`; restore on last
  unsubscribe. Catch-up overflow must never close the socket: every other
  surface on it would go blank.
- A row survives reconcile only if the caller passes `excludeToolTypes`; the
  hosts do not, so stale `running` chat rows become `detached` too.
- `transcriptPath` may be blank for untracked sessions (tracked=false)
 — always null-check before reading.
- `resumeCommand` is derived from `resumeMetadata` when present, then
  falls back to `defaultResumeCommandForTool(toolType)`. Editing it
  directly is only allowed through `sessionService.setResumeCommand` or
  `updateMeta`, both of which re-derive the metadata; target-id refreshes merge
  the current metadata so tracked CLI spawn lineage is not discarded.
  `defaultResumeCommandForTool("pi")` deliberately returns **null**: `pi
  --continue` means "the most recent session for this directory", and because
  ADE chat and the tracked Pi CLI share one native session store that can be
  another terminal's session or a chat's. Pi is resumed only by a session id
  ADE captured for that terminal — see
  [Pi session tracking](pty-and-sessions.md#pi-session-tracking). Cursor
  follows the same rule: `cursor-agent --continue` reopens the most recent
  chat, which may not be this terminal's, so a Cursor resume without a
  captured chat id is a fresh launch, never a `--continue`.
- A live provider session file is usually held open by a descendant of the
  tracked PTY (shell → node → CLI), not by the PTY root. Decide ownership with
  `handleIsOwnedByTrackedPty` (it reads the handle's `trackedRootPid`), never
  with `ptyPids.has(handle.pid)`.
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
  the `work:grid:tiling:v1:` key family (via `window.ade.tilingTree`); with
  nothing saved, `buildWorkSessionTilingTree` seeds a tree.

## Dead agent shells

A shell App Control launched does not linger once it is dead, and a relaunch
does not make a new one. `agentShellCleanup` (wired by `ptyService`) tracks the
shells this machine launched (`markAgentLaunched`), what was typed into them
(`markUserInput`), and what ADE itself ended (`markRetiredByAde`), then deletes
the eligible ones: the row and its transcript. A shell is eligible only when App
Control started it (`launchedBy: "agent"`, with or without a chat), it has ended
(not `running`/`detached`), it is not archived, and nobody typed into it. When it
goes depends on how it ended: one replaced by a launch in a new shell goes at
once; exit 0 or an ADE stop waits out a 10-minute grace; a crash waits until the
chat settles, so a failure stays in view. A chatless shell's crash has no chat to
settle, so it stays until a relaunch reuses the shell.

Deletion, not archive, because hidden rows still fill a `session.list` page and
can push a live chat out of another machine's Work list. The cross-machine read
passes `includeArchived: false` and `settledLimit: 40` (with `limit: 200`):
every unsettled row comes first, and at most 40 settled rows fill the rest. An
older brain ignores `settledLimit` and returns the newest 200.

**Relaunch reuses the shell.** When the same chat (or, chatless, no chat)
launches again on the lane, App Control waits up to 5 seconds for the old app's
process to exit, checks the shell is still eligible (`canRelaunchIn`: same lane
and chat, ended, untouched, not archived), and runs the new process in that row
(`ptyService.create` with `sessionId`, `freshRun`). `hold` keeps the sweep off the
row in between, and launches on one lane run one at a time, so two cannot claim
the same row. A fresh run gets a new start time, its own failure state (not the
resume path's restored end state), the new title, and a fresh transcript: it
waits for the old run's close work, then removes the old log, so
`ade app-control logs` shows only the current run. The ledger marks the relaunch
only after the new process holds the row. `ade app-control launch --new-shell`
opts out.

Typing into a shell the person owns it — `terminal.write { fromUser }` from a
user client, or a hand resume — and it is never deleted or reused. The RPC
server strips `fromUser` from a non-user caller, so an agent cannot claim its
own shell to keep it around. The ledger is per machine and never replicates.

A shell is a tool of the chat that ran it, so deleting that chat stops and
archives its shells (`sessionService.listAttachedShellIds` /
`archiveAttachedShellsForChat`, called from the chat delete path). A shell of
another machine's live runtime is left running — ownership decides who may stop
it — but its row is still archived here. Nothing is deleted, so output survives
and the archive can put the row back. Deleting the chat never touches a child
chat: a child chat is work, not a tool. A shell's `chat_session_id` has no
foreign key, so the sweeper treats a missing owner row as a quiet parent. Lane
deletion removes every session row in that lane, archived or not.

Archiving a lane archives its sessions too (`sessionService.archiveSessionsForLane`,
stamped with the lane's `archived_at`), and restoring the lane clears exactly
that stamp (`unarchiveSessionsForLane`), so a session archived on its own stays
archived. See [Lanes › Archive / reclaim / restore](../lanes/README.md).

Chats and shells list with archived rows hidden by default. `ade chat list` and
`ade terminal list` take `--include-archived`, and `ade archive list` shows every
archived item across lanes, chats, and shells. A chat's attached shells are
listed in its actions pane's **Shells** section (open, or right-click for the
Work list's own menu) rather than as rows or a drawer in the Work list. Its
same-lane subagents are listed the same way, in the pane's **Subagents**
section; the Work row only carries a mark with their count and worst state.

## Cross-links

- External session import:
  [external-session-import.md](external-session-import.md) — provider-native
  session discovery/import, the import policy (Continue/Copy per ADE chat and
  CLI, with lane rules), and mobile/host constraints.
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

### Lane identity in session lists

Work's Status and Time organizations show each session's lane name and lane
color using the same compact identity as a singleton in the Lane view.
They include already-loaded sessions from other machines, with their owner
binding and lane identity intact. Duplicate
session ids are shown once, preferring the bound machine. Foreign attached
shells follow the same filing rules as local ones; Status and Time keep
subagents flat. Pending handoffs also name their lane.

Bulk settling in these mixed lists is labelled **Settle local** and acts only
on the bound machine; individual foreign rows keep their machine-scoped actions.
Apple, Android, screen, and tool markers reuse the lane data already in the pane.
Kanban already shows lane identity, and both State and Stack organizations in
the Lanes sidebar keep the lane name and color. None of these labels adds a
fetch, effect, or subscription per row.

## Releasing what settled chats were using

Settings › Lanes › "Release what settled chats were using" (off by default, one
setting for every project on the machine, kept in `<ADE home>/session-lifecycle.json`). Once every live chat in a lane has been settled for five minutes
(`settledLaneReleaseService.ts`), ADE powers off the simulators and emulators
those chats' agents booted, stops the dev servers they started, and gives up any
Mac Desktop control they held (the screen itself closes on its own idle timer).
Nothing a person started is touched: an agent's boot
writes `ade-booted-by-chat` in the simulator's folder (cleared when it goes off),
and an emulator's owner record names its chat. A device already on when an agent
reached it stays unattributed. A chat waking cancels the release, "Keep running"
pins are honored, and a device in use or a stream someone is viewing stays on. A step that
fails is tried again on later sweeps, up to five passes, and every step first re-reads the lane
so a chat that just woke keeps the rest. The
wait is read from the chats' `settled_at` columns on a slow sweep (a board pin has none, so the
first sweep that sees it stamps it), so it survives a brain
restart and notices a chat settled from a phone. A quiet line in the last chat to
settle says what was released. Built-in browser tabs are left alone: they belong
to the project, not to a lane's chats.
