# Terminals and Sessions

PTY terminals and agent chats share one `terminal_sessions` row: transcript,
deltas, lane, lifecycle marks and provider resume metadata. Work, the lane
panels and session lists show them.

The **active runtime** of the window's project binding owns the PTYs. A local
binding spawns them through the local brain (`daex serve`); a remote binding
spawns them on that machine and streams bytes over its RPC. Renderer calls
(`window.ade.pty.*`, `.sessions.*`, `.terminal.*` in
`apps/desktop/src/preload/preload.ts`) go through
`callProjectRuntimeActionIfBound("pty" | "session", …)`. Desktop in-process
handlers run only when no runtime is bound (tests, early diagnostics); a brain
failure is never retried in the desktop process.

A projectless personal chat's Terminal button creates a PTY in the machine's
personal scratch folder; it has no lane, repo, PR or **Open in** actions. See
[Personal chats](../personal-chats/README.md).

Commands use `daex`; `ade` still works. Identifiers (`ade.sessions.*`,
`window.ade`, `ADE_*` env vars) keep their names.

Detail docs:

- [pty-and-sessions.md](./pty-and-sessions.md): PTY lifecycle, tool-type detection, transcripts, titles, resume, reconcile, activity detection.
- [ui-surfaces.md](./ui-surfaces.md): renderer and iOS surfaces.
- [runtime-isolation.md](./runtime-isolation.md): how a session stays in one lane worktree.
- [external-session-import.md](./external-session-import.md): importing provider-native CLI sessions.
- [settle-teardown-design.md](./settle-teardown-design.md): the settle writer, the settling window, peer writes.

## Source file map

Main process (`apps/desktop/src/main/services/` unless noted). `ptyService.ts`
and `sessionService.ts` are large and fragile; re-read their wiring before
changing it.

| File | Owns |
|---|---|
| `pty/ptyService.ts` | PTY lifecycle: create/reattach, transcripts (16 MiB ceiling, logical offsets, rollover, `.gz` reinflate), screen snapshots, agent CLI input protocol, `sendToSession` / `resumeSession`, sizing ownership, AI titles, process-tree kill, `canAcceptScheduledTurn`, the optional Jev idle classifier. |
| `pty/supervisedPtyHost.ts`, `pty/ptyHostWorker.ts` | node-pty worker hosts outside the brain process, ≤ 8 terminals each. |
| `pty/ptyOutputFlowControl.ts` | Pauses PTYs when a brain connection falls behind. |
| `pty/terminalWatchService.ts`, `pty/terminalWatchOutput.ts` | `daex terminal watch`. |
| `pty/terminalShells.ts` | Default shell discovery and setting. |
| `pty/resourceUsageSampling.ts` | Process sampler behind the TopBar pressure indicator ([attribution](./pty-and-sessions.md#resource-pressure-attribution)). |
| `main/utils/terminalPreview.ts` | The one-line preview: a column-cursor model over cells, not an ANSI stripper. |
| `sessions/sessionService.ts` | `terminal_sessions` CRUD, resume metadata, reconcile, stranded-row close, settle/snooze/attention/failure marks, `reopen` and stale-detach repair. |
| `sessions/chatSessionProjection.ts` | Projects chat summaries onto session rows for every list/detail read; hydration failure reads quiet. |
| `sessions/settleLifecycleWriter.ts` | The one writer of the settle tuple ([design §3a, §6d](./settle-teardown-design.md)). |
| `sessions/settleTerminalSession.ts`, `settleTurnCheck.ts`, `settleWiring.ts` | The settle transaction, its turn check and host wiring. |
| `sessions/settledLaneReleaseService.ts`, `sessions/sessionLifecycleSettings.ts` | Release what settled chats were using. |
| `sessions/agentShellCleanup.ts` | Deletes dead App Control shells ([below](#dead-agent-shells)). |
| `sessions/sessionDeltaService.ts` | Git and transcript delta at session end. |
| `adeActions/sessionBoardMove.ts` | Host half of a board move ([The Work board](#the-work-board)). |
| `runtime/processRegistryService.ts` | Machine-local process heartbeats that every reconcile and sweep consults ([ARCHITECTURE §3.4](../../ARCHITECTURE.md#34-cross-process-ownership)). |
| `lanes/laneLaunchContext.ts` | The lane cwd gate for a PTY create. |
| `chat/cliChildSessions.ts`, `chat/cliChildReports.ts` | Tracked agent CLIs as children of a chat: spawn chips, turn and exit reports. |
| `chat/cliCardInputs.ts` | DAEX cards (`ask_user`, secrets, integrations, MCP) raised from a tracked CLI. |
| `chat/piSessionStore.ts`, `piSessionLease.ts`, `piSessionOwnership.ts` | Shared Pi session store ([Pi session tracking](./pty-and-sessions.md#pi-session-tracking)). |
| `chat/settleNudgeSweep.ts` | "Looks finished" verdicts for old idle turns. |
| `opencode/openCodeTerminal.ts` | OpenCode CLI attach ([below](#opencode-cli-attach-to-ades-server)). |
| `externalSessions/` | External session discovery and import ([external-session-import.md](./external-session-import.md)). |
| `apps/ade-cli/src/services/sync/syncHostService.ts` | Remote terminal subscribe barrier and input ledger. |

Shared and renderer:

| File | Owns |
|---|---|
| `apps/desktop/src/shared/types/sessions.ts` | `TerminalSessionSummary`, tool types, `TerminalResumeMetadata`, `PtyCreateArgs`, `PtyDataEvent`, terminal DTOs, `parseSessionSettleOverride`. |
| `apps/desktop/src/shared/sessionCanonicalState.ts` | The canonical phase and bucket (mirrored on iOS). |
| `apps/desktop/src/shared/sessionStatusPresentation.ts` | Label, glyph and tone per phase; stall and wake deadlines. |
| `apps/desktop/src/shared/sessionActivity.ts` | The activity vocabulary. |
| `apps/desktop/src/shared/sessionSpawnNesting.ts` | By-lane filing of subagents and shells; `isChatToolType`. |
| `apps/desktop/src/shared/types/sync.ts` | Terminal stream envelopes (`terminal_subscribe` … `terminal_resize`). |
| `renderer/lib/sessionSnooze.ts`, `components/terminals/sessionLifecycleActions.ts` | Snooze presets and the one place for snooze/wake/override writes. |
| `components/terminals/CliAgentPane.tsx` | A CLI's actions pane: agents it started, proof, open cards; reads carry the CLI's pin. |
| `renderer/webclient/sync/client.ts`, `adapter/sessionsPty.ts` | Web terminal state and gap recovery. |
| `apps/ade-cli/src/cli.ts`, `adeRpcServer.ts`, `sessionSnoozeDuration.ts` | `daex new chat --mode cli`, `start_cli_session`, `daex session …`. |

Renderer and iOS files: [ui-surfaces.md](./ui-surfaces.md#source-file-map).

## Gotchas

- **No whole-buffer work per PTY chunk in the brain.** The live tail may overshoot its 2M-character cap by 500K before it is cut; read it through `readRecentOutputTail`. The resume-command scan runs at most every 250 ms. A per-chunk tail copy pins the brain at 100 % CPU (`docs/perf/macos-baseline.md`, Terminals).
- **Flow-control pauses are counted per reason** (`setOutputPaused`), so rollover and flow control cannot release each other. A paused PTY is resumed before kill so its exit is read. Output must never overtake replies or the reverse.
- **A PTY host serves up to 8 terminals.** A host crash ends all of them. Kill a stuck terminal through its host handle (`disposeInHost`), never by killing a shared host. Every spawn passes its own `env` and `cwd`.
- **Open in is SSH-or-local, never paired** (`resolveOpenInTarget` returns null for `transport: "paired"`). Never spawn a local editor against a remote path.
- **Snooze never reaches `canonicalSessionState()`.** It only changes filing (`isSessionFiledAsSnoozed`, which yields to `needs_you`). There is no snooze scheduler: expiry compares `snoozed_until` to now. Only `markLastTurnFailed` compares with `snoozed_at`.
- **PTY text raises a hand only through the optional Jev classifier**: up to 40 visible lines after an idle transition, `waiting_for_input` at ≥ 0.85 confidence. Shell prompts and OSC 133 markers skip it; terminal output is never copied into local logs.
- **Never stamp `provider_structured` without an item id**, or the row says Needs you with no card to answer. `chatSessionProjection` stamps it only when it can name the card.
- **Settling a card is not the whole answer.** `respondToInput` clears the turn-start markers once, after delivery succeeds; paths that empty a provider's pending map emit a `pending_input_resolved` receipt per item.
- **Process exit is not settlement.** Exit 0 stays `ended`.
- **The settle tuple is host-authoritative.** A controller never writes `settled_at` / `settle_override` / `settle_source` into its replica; `syncHostService` drops them from inbound phone changesets. iOS uses a local overlay (`PendingSessionSettleStates.swift`). See [sync → host-authoritative columns](../sync-and-multi-device/README.md#host-authoritative-columns-are-peer-scoped).
- **Settlement is not a pending-input response.** Keep dismissal and settle inside `settleTerminalSession`; raw native CLI prompts are not dismissible.
- **Persisted chat `running` is not UI running.** Route list/detail reads through `chatSessionProjection.ts`.
- **Chat rows have no PTY.** Guard PTY-only calls with `isChatToolType(toolType)`.
- **Mobile/web cannot rebuild an alt-screen TUI from a transcript tail.** `terminal_snapshot.screen` carries the serialized current screen (omitted over 256k chars; never slice CSI). While a phone or web viewer owns the size, desktop fit-resizes are remembered, not applied. Catch-up overflow never closes the socket.
- **Resume needs a captured id for Pi and Cursor.** `defaultResumeCommandForTool("pi")` is null and Cursor never uses `--continue`, because "most recent session" can be another terminal's.
- **Provider session files are held by a descendant of the PTY.** Decide ownership with `handleIsOwnedByTrackedPty`, never `ptyPids.has(pid)`.
- **Transcripts roll over, not truncate.** `transcriptBytesWritten` is a lifetime logical cursor; `.rollover.json` records the retained base. Range callers must honour returned offsets. A transcript may exist only as `<transcript>.gz`.
- **Disk pressure gates only the start**: `ptyService.create` refuses a new tracked agent CLI under `exhausted` pressure (`disk_full`). See [Storage and recovery](../storage-and-recovery/README.md#disk-pressure-and-enforcement).
- **Every sweep consults the process registry.** A new lifecycle path that bypasses `ptyService.create` must write `owner_pid` and `owner_process_started_at` itself.
- **Parked terminals give their WebGL context back after 30 s** (`PARKED_WEBGL_RELEASE_MS`). A resumed terminal clears screen and scrollback with escape codes before rehydrating (not `term.reset()`).
- **New lifecycle columns need both iOS halves** (`DatabaseBootstrap.sql` and `Database.swift` `ensureColumn`), nullable with no unique index (CRR rejects one). A missing iOS half breaks only the phone's changeset apply.

## Session model

A session is a `terminal_sessions` row. Tool types
(`TerminalToolType`, `shared/types/sessions.ts`): `shell`; tracked agent CLIs
(`claude`, `codex`, `cursor-cli`, `droid`, `opencode`, `pi`, `muse`, `qwen`,
`kimi`, `grok`, `copilot`, `devin`, `antigravity`); chats (`<provider>-chat`,
except Cursor's chat, which is `cursor`); and `aider`, `continue`, `other`.

Process status: `running` → `completed` | `failed` | `disposed` | `detached`.
`detached` keeps the row and transcript but the PTY is unreachable from this
runtime. The canonical UI phase (`needs_you`, `running`, `stale`, `ready`,
`idle`, `stopped`, `ended`, `settled`) is projected without rewriting status.

Fields worth knowing: lane identity (`laneType` lets screens say "Main
checkout" via `sessionLaneDisplayName`), `chatSessionId` (owner of an attached
terminal), lifecycle marks (`settledAt`, `settleOverride`, `statusNote`,
`attentionRequestedAt`, `lastTurnFailedAt`), the snooze overlay
(`snoozedUntil`, `snoozedAt`, `wokeAt`, `wokeReason`), `headShaStart` /
`headShaEnd`, `resumeMetadata` (with spawn lineage
`orchestrationParentSessionId` / `spawnKind`), `parentIdentityKey` (`"cto"`
when the CTO started it; stamped host-side because identity rows are filtered
out of rosters), and `model` / `modelId`.

`canonicalSessionState` precedence: explicit or structured attention → a
declared settle at rest → stopped / failure / clean exit → stale / running /
resting. Live background work promotes a resting row to `running` with
liveness `turn`, `background` or `monitoring`; a live foreground turn outranks
stored failure marks.

### Provider signal boundaries

Every provider uses the same host lifecycle. **Needs you** comes only from
structured input or permission requests (and `daex chat ask` for tracked
CLIs); PTY text is never parsed into a status except by the Jev classifier
above. DAEX detects activity from the turn's tool calls
([Activity detection](./pty-and-sessions.md#activity-detection)); an agent
report only refines it and needs the resolved DAEX CLI plus this runtime's
socket.

| Provider path | Structured Plan signal | Agent-reported activity |
| --- | --- | --- |
| Claude SDK | `interactionMode` | Outside Plan |
| Codex app-server | The accepted `turn/start` collaboration mode | Default mode, not external `config.toml` |
| Cursor SDK | Local `currentMode` | Local Agent mode only |
| Droid SDK | `interactionMode` | Write-capable, non-Spec permission only |
| OpenCode SDK | Permission mode | Outside Plan and `config-toml` |
| Pi SDK | None | POSIX non-personal sessions outside Plan, Bash allowlisted |
| ACP Qwen, Kimi, Grok | ACP configuration | Not offered |
| Copilot SDK | Not wired | Not offered |
| Tracked PTY CLI | None from terminal text | Codex and OpenCode outside Plan, write-capable Droid, Pi full-auto, Cursor with an initial prompt; not Claude. `ADE_ACTIVITY_SESSION_ID` scopes reports. |

Devin and Antigravity (ACP dialects in `services/chat/acpHost/acpDialects/`)
and Muse (`museSdkEventMapper.ts`) are not in this table yet; read their
adapters before relying on a Plan or activity signal.

Pending requests: Claude, Cursor, Droid, OpenCode through their events; Codex
through app-server input events; Pi through approval and AskUser; ACP through
`session/request_permission`.

## The Work board

A four-column board over the same roster (`workViewMode`, separate from
grouping). The vocabulary lives once in `shared/types/chat.ts`
(`WorkBoardColumn`, `WORK_BOARD_MOVE_TARGETS`, `WORK_BOARD_COLUMN_LABEL`).

| Column | Membership | Drop target |
| --- | --- | --- |
| **Needs you** | the `needs_you` phase only | yes |
| **Working** | the rest of the running partition | yes |
| **Waiting** | snoozed rows, plus running rows whose lane PR is mid-CI or awaiting review (`lanePrWaitingReason`, bound machine's PRs) | no |
| **Done** | resting, then ended, then settled | yes |

The host's `deriveWorkBoardColumn` (no PR state) and the renderer's
`buildWorkBoardModel` must agree on everything except PR waits; a drag from
"Waiting for CI" to Working is a host no-op and says so.

**A move** wakes the row, then writes lifecycle and stages a message together:

| Target | Lifecycle write | Message to the agent |
| --- | --- | --- |
| Done | clear attention and override, settle with source `user` | none |
| Working | unsettle, clear attention, override `"active"` | only when moving from Done |
| Needs you | unsettle, clear override, raise attention with source `user` | "The user parked this for their input…" |

The message carries host-stamped `metadata.boardMove` (callers cannot forge
it) and renders as a divider, never a user bubble.

**Undo.** The message waits `BOARD_MOVE_STAGE_MS` (5 s); `undoBoardMove`
cancels it and restores the snapshot (attention last). Refusals are
`already_dispatched` or `unknown_move`. One staged move per session. The
staging map is in-process: only a graceful shutdown awaits
`flushStagedBoardMoves`; a hard exit can leave the status write without its
message.

**Who may move.** `session.moveOnBoard` / `undoBoardMove` are CTO-only, so an
agent cannot move its own card; automations cannot call them either.

## Session lifecycle

1. **Create.** `ptyService.create()` resolves the lane cwd (`resolveLaneLaunchContext`), allocates ids (or reuses one for a continuation), opens the transcript, spawns and inserts the row, and stamps `owner_pid`. `initialInput` is written after `initialInputDelayMs` through the agent CLI input protocol.
2. **Stream.** Output advances a lifetime logical byte cursor, writes the rolling transcript, throttles the preview (~900 ms, 220 chars), and broadcasts with offsets.
3. **Tag.** Fresh Claude, Qwen, Grok and Copilot launches get a pre-assigned session id; Kimi's session folder is adopted when the cwd is provable; others are backfilled. See [Session tracking](./external-session-import.md#session-tracking).
4. **Auto-title** after 6 s (`PTY_AI_TITLE_DEBOUNCE_MS`), preferring the first submitted user line. A CLI's own window title is used only when DAEX titling is unavailable.
5. **Exit.** `sessionService.end()` records status and exit code, then backfills the resume target, writes the summary and computes the delta. A tracked CLI is never auto-disposed for returning to its prompt.
6. **Settle.** Only user surfaces and the PR-merge policy settle; agents cannot. A working chat cannot be settled (`turn_running`, or `status_unknown` after 10 s), and **settle stops nothing**. A `needs_you` row offers **Dismiss & settle** for SDK chats and `daex chat ask` marks; a raw TUI prompt must be resolved in the terminal. Any turn start unsettles (`clearSettleOnTurnStart`).
7. **Attention.** A new user turn clears settle, attention and failure; PTY output clears settle only. `daex chat ask` raises a hand with `agent_explicit` provenance. A chat whose turn ends with a question while background work runs raises one with source `turn_end_question` (`chat/turnEndQuestionCheck.ts`). Status notes are capped at 72 characters.
8. **Settle override.** `"settled"`, `"active"` (keep-active pin), or `null`. `settle_source` is `user`, `operator` or `pr_merge`.
9. **Snooze and early wake.** A visibility overlay. Early wake on a pending request, an error newer than `snoozed_at`, a completed turn, or a failed end. Waking stamps `woke_reason` (`needs_you`, `error`, `turn_complete`, `timer`, `manual`). Agents can snooze and wake (`session` domain); settle actions are CTO-only. CLI: `daex session snooze|wake|clear-woke|show`, defaulting to `$ADE_CHAT_SESSION_ID`; no CLI command settles.
10. **Continue.** `sendToSession` submits to a live PTY, or rebuilds the resume command, creates a new PTY on the same row, and puts the prompt on the launch. Later sends during the resume flight are serialized.
11. **Reconcile.** At start, `closeStrandedLocalSessions` closes rows an earlier clean stop stranded on this computer (proved by the cr-sqlite clock and the registry), then `reconcileStaleRunningSessions` marks orphaned `running` rows `detached`: a live owner is a sibling (left alone), a known dead owner is swept, an unknown owner (another machine) is kept. Both hosts rescan once after `STALE_RUNNING_SESSION_RESCAN_DELAY_MS`.
12. **Clean stop.** `endRunningSessionsOwnedBy` ends the stopping process's rows: chats at rest `completed`, work in flight `detached` (restart recovery resumes it).
13. **Delete.** `sessionService.deleteSession` emits `terminalSessionChanged` with `reason: "deleted"`; `agentChatService.deleteSession` wraps it for chats.

The "Looks finished · Settle" pill comes from `settleNudgeSweep.ts`: up to 10
idle turns every 30 minutes after three quiet hours, judged by optional Jev.
It never settles on its own.

### Stale-detached repair

The registry can be wrong at boot, so a live session can be marked `detached`
and Work paints "Ended" over a live PTY. Two repairs:

| Repair | Reopens | Fires on |
|---|---|---|
| `reopen(sessionId)` | any non-`running` status | chat lifecycle sites (turn start, restart recovery). |
| `repairStaleDetachOnActivity(sessionId)` | `detached` only | every activity write; the only repair PTY rows get. |

Both use one `reopenRow` with the scope in the `WHERE`, and emit
`terminalSessionChanged` only when a row moved. `agentChatService` calls
`reopen` on every session open.

## IPC surface summary

Channels are in `apps/desktop/src/shared/ipc.ts`.

- **Sessions** (`ade.sessions.*`): `list`, `get`, `updateMeta`, `settle` / `unsettle` (`{ outcome?, dismissPendingInput? }`), `settleMany` / `unsettleMany` (one machine's ids per call), `setSettleOverride`, `snooze` / `snoozeMany`, `wake` / `wakeMany`, `moveOnBoard`, `undoBoardMove`, `clearWokeMarker`, `delete`, `readTranscriptTail`, `getDelta`, and the `changed` event.
- **PTY** (`ade.pty.*`): `create` (optional `chatSessionId`), `resumeSession` (prompt-free relaunch), `sendToSession` (send or continue), `write`, `resize`, `dispose`, `data` and `exit` events.
- **Attached terminals** (`ade.terminal.*`, used by chat terminal panels and `daex terminal`): `list` (no chat rows), `read`, `preview` (headless-xterm snapshot; agents get `screenText`), `write`, `resize`, `signal`, `activeForChat`.

Every PTY gets `ADE_PROJECT_ROOT`, `ADE_LANE_ID` and, when owned,
`ADE_CHAT_SESSION_ID` (`withAdeTerminalContextEnv`), so `daex` in a plain shell
resolves its owner.

<a id="opencode-cli-attach-to-ades-server"></a>
## OpenCode CLI: attach to DAEX's server

A tracked OpenCode TUI does not run standalone. `attachOpenCodeTerminal`
(`opencode/openCodeTerminal.ts`) intercepts a plain `opencode` launch (anything
with shell operators is refused) and:

1. acquires a lease on DAEX's shared OpenCode server (`acquireOpenCodeServer`);
2. resolves the session (`--session <id>`, `--continue`, or a new session with the DAEX agent for the permission mode);
3. writes DAEX's instructions onto the session and sets `session.environment` from the terminal's env (shell commands now run in the server);
4. rewrites the launch to `opencode --server <lease url> --session <id>` with `OPENCODE_SERVER_PASSWORD`, stripping flags the 2.0 TUI rejects from old resume commands. On macOS and Linux the login-shell `-c` string is rewritten too.

The URL and password change per server start and are never persisted.
`config-toml` means "use your own OpenCode configuration": DAEX sets no agent
or permission policy.

## Terminal watch (`daex terminal watch`)

A chat can be woken when a terminal prints something new instead of polling.

- `pty/terminalWatchService.ts`, `terminalWatchOutput.ts`, `shared/terminalWatch.ts`; wired in the brain's `bootstrap.ts` and desktop `main.ts`.
- One `onData` subscription while any watch exists; per chunk it only appends.
- Wakes after 3 s of quiet (20 s max). Pure paint, no `match`, or a repeat excerpt does not wake. Excerpt ~4 KB; ≤ 64 KB kept between wakes.
- The wake is `messageSession({ kind: "wake" })` with a `terminal_watch_wake` card, held until a running turn ends. A settled chat is still woken.
- Caps: 5 per chat, 100 per brain, 2 h default lifetime (1 min–24 h), 20 wakes an hour. Exit, lifetime or the cap end the watch with one final wake.
- Actions `terminal.watch` / `unwatch` / `listWatches` run on the brain that owns the chat. The chat's **Watching** section reads them through the chat's pin. In memory only; a brain restart ends them.

## Type-ahead on a slow link

A plain shell on another machine shows typed characters at once, dimmed, until
the echo arrives (`terminalTypeAhead.ts`). It turns on when that machine's
link is far (two of three round trips ≥ 150 ms, off below 110 ms) or in
slow-connection mode, never when the machine's setting is **Off**. Agent CLIs
and alt-screen terminals get none. Rules follow mosh: plain narrow characters
only; Enter, Tab, arrows, control keys and pastes clear the guess; only output
that exactly matches confirms, so a silent prompt (a password) never shows the
text. It is a DOM layer, never input. See
[Remote runtime](../remote-runtime/README.md#a-slow-or-dropping-link).

## Dead agent shells

`agentShellCleanup` deletes (row and transcript) shells App Control launched
that have ended, are not archived, and nobody typed into. One replaced by a
relaunch goes at once; exit 0 or a DAEX stop waits 10 minutes; a crash waits
until the chat settles. Deletion, not archive, because hidden rows still fill
a `session.list` page (the cross-machine read uses `limit: 200`,
`settledLimit: 40`).

- **Relaunch reuses the shell** when the same chat launches again on the lane: it waits up to 5 s for the old process, checks eligibility (`canRelaunchIn`), and runs the new process in that row (`freshRun`) with a fresh transcript. `daex app-control launch --new-shell` opts out.
- **Typing makes a shell the person's** (`terminal.write { fromUser }` from a user client); it is never deleted or reused. The RPC server strips `fromUser` from non-user callers.
- The ledger is per machine and never replicates.
- Deleting a chat archives its shells (`archiveAttachedShellsForChat`), never its child chats. Archiving a lane archives its sessions with the lane's stamp; restore clears exactly that stamp.

## Releasing what settled chats were using

Settings › Lanes › "Release what settled chats were using" (off by default,
machine-wide, `<ADE home>/session-lifecycle.json`). Once every live chat in a
lane has been settled for five minutes (`settledLaneReleaseService.ts`), DAEX
powers off simulators and emulators those chats' agents booted, stops dev
servers they started, and releases Mac Desktop control. Nothing a person
started is touched (agent boots are marked `ade-booted-by-chat`). A waking
chat cancels it; "Keep running" pins, devices in use and watched streams stay.
Failed steps retry for up to five sweeps. Built-in browser tabs are left
alone.

## External CLI session import

Discovery is read-only; an import goes to a tracked CLI or a DAEX chat.
`PROVIDER_IMPORT_RULES` (`shared/externalSessionPolicy.ts`) decides actions
and lane rules; host flags can only narrow it. Every provider except Codex
resumes in its original folder, so a session inside a lane is locked to it.
Details: [external-session-import.md](./external-session-import.md#import-policy).
