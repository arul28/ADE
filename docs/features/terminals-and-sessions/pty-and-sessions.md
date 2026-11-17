# PTY and sessions

Lifecycle and wiring for the two services behind terminals and sessions:

- `apps/desktop/src/main/services/pty/ptyService.ts`
- `apps/desktop/src/main/services/sessions/sessionService.ts`

Both run inside the **active ADE runtime**: the local runtime for a
local-bound window, the remote runtime for a remote-bound one (there
`node-pty` runs on the remote host and the bytes stream back). The desktop
main process also loads them for tests, diagnostics and flows with no runtime
binding; runtime-bound work is not retried on desktop-local handlers after a
daemon failure. PTY data and exit events flow over the runtime event stream to
the preload event pump.

Both services are cross-wired through the runtime's project boot and
`registerIpc.ts`. Read both before a non-trivial change.

The computer-use control plane (`apps/desktop/src/main/services/computerUse/`,
`computerUseArtifactBrokerService.ts`) is local-only: it runs only in the local
ADE runtime.

---

## `sessionService`

File: `apps/desktop/src/main/services/sessions/sessionService.ts`

The one source of truth for `terminal_sessions` rows. Pure persistence: it
spawns nothing, streams nothing, and reads files only in `readTranscriptTail`.

### Row shape

`SessionRow` maps to columns in `terminal_sessions`:

- identity: `id`, `lane_id`, `pty_id`, `tracked`, `pinned`,
  `manually_named`
- metadata: `title`, `goal`, `tool_type`, `summary`
- lifecycle: `status`, `started_at`, `ended_at`, `exit_code`
- content refs: `transcript_path`, `last_output_preview`
- git: `head_sha_start`, `head_sha_end`
- resume: `resume_command`, `resume_metadata_json`
- ownership: `owner_pid`, `owner_process_started_at`

`mapRow()` converts a row into `TerminalSessionSummary` /
`TerminalSessionDetail`. It parses `resumeMetadata` through
`normalizeResumeMetadata` (legacy `target` or `targetId`, plus optional
`orchestrationParentSessionId` / `spawnKind`), then derives `resumeCommand`
with `deriveResumeMetadataCommand`, so old rows get a normalized command too.
Only tracked agent CLI rows get those lineage fields on the summary.

### Exported methods

- `list({ laneId?, status?, limit? })`: up to 200 rows by default, newest
  `started_at` first.
- `get(sessionId)`: one row as `TerminalSessionDetail`.
- `create({ sessionId, laneId, ptyId, tracked, title, startedAt,
  transcriptPath, toolType?, resumeCommand?, resumeMetadata?, ownerPid?,
  ownerProcessStartedAt? })`: inserts a `running` row with a normalized tool
  type and resume command/metadata.
- `updateMeta(args)`: partial update (rename, pin, goal, tool type, resume
  metadata). Recomputes `resume_command` when `toolType`, `resumeCommand` or
  `resumeMetadata` changes.
- `reopen(sessionId)`: resets the row to `running` from **any** non-running
  status. A resume uses it before the PTY attaches; chat lifecycle sites (turn
  start, restart recovery, a chat kept open across a runtime close) use it to
  undo a wrong detach. It emits `terminalSessionChanged` only when the row
  moved.
- `reattach({ sessionId, ptyId, startedAt })`: the full reset `ptyService`
  uses on resume. Back to `running`; clears `ended_at`, `exit_code`,
  `summary`, `head_sha_end`; rebinds `pty_id` and `started_at`. Keeps
  identity, lane, transcript, head SHA start, tool type and resume metadata.
- `setHeadShaStart` / `setHeadShaEnd`: anchors for the delta.
- `setLastOutputPreview(sessionId, preview)` and `touchLastOutput`: stamp
  `last_output_at` and call `repairStaleDetachOnActivity`, which reopens the
  row **only** from `detached`. They are the only activity writers and fire
  only while this process's live runtime prints, so a dead session never comes
  back through them.
- `setSummary` / `setResumeCommand`: small writes for the summarizer and the
  resume backfill.
- `end({ sessionId, endedAt, exitCode, status })`: finalizes and nulls
  `pty_id`.
- `readTranscriptTail(transcriptPath, maxBytes, opts)`: async read, can align
  to a line and strip ANSI.
- `reconcileStaleRunningSessions({ endedAt?, status?, excludeToolTypes?,
  liveOwnerPids?, liveOwnerIdentities?, knownOwnerPids?,
  knownOwnerIdentities? })`: startup cleanup.
  - Callers pass live and known identities from the local `runtime_processes`
    table, so ADE detaches sessions of a crashed local process and never
    rewrites a running session synced from another machine.
  - `freshActivityGraceMs` defaults to
    `STALE_RUNNING_SESSION_FRESH_ACTIVITY_GRACE_MS` (2 min); only tests
    override it.
  - Hosts schedule one rescan at `STALE_RUNNING_SESSION_RESCAN_DELAY_MS`: the
    larger of the process-registry liveness window and that grace, plus 1 s.
- `deleteSession(sessionId)`: removes the row and emits
  `terminalSessionChanged` (`reason: "deleted"`). PTY cleanup and
  `agentChatService.deleteSession` use it.
- `onChanged(listener)`: fires from `updateMeta` (`"meta-updated"`) and
  `deleteSession` (`"deleted"`).

### Notes

- `SessionService` never fires `changed` on create or end; `ptyService`
  broadcasts PTY events for those.
- `manuallyNamed` stops the quiet automatic title. A renderer rename sets it.
  **Name & status** is a separate user command that can replace a manual
  title; per-field guards keep edits made during the request.
- `normalizeResumeMetadata` accepts the current `{ provider, targetKind,
  targetId, launch }` shape (plus lineage fields) and legacy top-level
  `target` / `permissionMode`. `setResumeCommand` merges the parsed target
  into the metadata, so the lineage fields survive a target refresh.
- `runtime_processes` is machine-local, not CRR. A synced row can describe a
  session another machine owns, so local reconcile treats an unknown owner as
  remote, not dead.

---

## `ptyService`

File: `apps/desktop/src/main/services/pty/ptyService.ts`

Owns the `node-pty` instances, transcript capture, runtime state and AI
titles. Creates and ends rows in `sessionService`.

### Entry state (`PtyEntry`)

Each live PTY has an entry in the `ptys` map, keyed by `ptyId`:

- `pty`, `laneId`, `laneWorktreePath`, `boundCwd`, `sessionId`, `tracked`
- transcript: `transcriptPath`, `transcriptStream`, `transcriptBytesWritten`
  (lifetime logical UTF-8 end), `transcriptBaseOffset` (the logical byte at
  physical byte zero), `transcriptRetainedBytes`, rollover state, and
  `transcriptWriteDisabled` after a real write failure. The file keeps at most
  16 MiB; output is not capped.
- preview: `lastPreviewWriteAt`, `previewCurrentLine`, `latestPreviewLine`,
  `lastPreviewWritten`
- tool metadata: `toolTypeHint`, `resumeCommand`, `resumeCommandIsFallback`,
  `resumeScanBuffer`
- runtime state: `lastRuntimeSignalAt`, `lastRuntimeSignalState`,
  `lastRuntimeSignalPreview`
- AI title: `aiTitleTimer`, `cliUserTitleLineBuffer`, `cliUserTitleCommitted`
- `terminalSnapshot` (tracked PTYs only): an `@xterm/headless` Terminal plus
  `SerializeAddon` that mirrors output, so surfaces with no renderer (the
  mobile Work tab, `ade terminal preview`) get a real buffer. It writes
  `.ade/cache/terminal-snapshots/<sessionId>.json` (a version 1
  `TerminalSerializedSnapshot`) with a `TERMINAL_SNAPSHOT_DEBOUNCE_MS` (5 s)
  debounce, and flushes on exit, dispose, resize and every
  `terminal.preview`.
- initial input: `initialInputTimer`; `userInputGeneration` advances on each
  user write, so a deferred launch prompt cancels if the user types first.
- `lastSessionResyncCheckAt` ([Live session row resync](#live-session-row-resync)).
- teardown: `disposed`, `createdAt`, `cleanupPaths`

### Create flow (`create(args)`)

1. Resolve the lane worktree with `resolveLaneLaunchContext`; a path outside
   the lane root is refused.
2. With a caller `sessionId`:
   - A missing row is accepted (a new session with that id).
   - An existing row must be the same lane and `tracked = true`.
   - A row already on a live PTY reuses it: reattach, mark `running`, and
     return `{ ptyId, sessionId, pid }` without a spawn. Repeated resume
     clicks are idempotent (`pty.resume_reused_live_attachment`).
3. Make `ptyId` and `sessionId` (the row's id on resume, else the caller's id,
   else a new UUID).
4. Take the transcript path from the row on resume, else
   `safeTranscriptPathFor(sessionId)`.
5. Claude and Codex launch with ADE identity env and use the bundled `ade`
   CLI. A temporary startup context path goes into `cleanupPaths`.
6. Build `resumeMetadata` with `buildInitialResumeMetadata` (it reads a
   pre-assigned `--session-id <uuid>`). When the launch has a model and
   `resumeMetadata.launch.model` is empty, ADE writes the model there for
   later title and summary passes.
7. Insert the row (or keep the existing one) and set `running`.
8. Capture `headShaStart` (`computeHeadShaBestEffort`) for
   `sessionDeltaService`.
9. **Swap in ADE's pinned CLI** (`pty/pinnedProviderCli.ts`). Every provider
   terminal (work, resume, login) runs ADE's pinned copy by absolute path,
   never the CLI on the PATH.
   - It is one late swap, after resume backfill, Pi lease work, Claude
     `--plugin-dir` and pre-assigned ids, so every parser sees bare-word
     lines. The swapped line is never persisted.
   - It replaces the command word of a direct command, of a POSIX `-c` line
     (at the start and after `&&`, `||`, `|`, `;`, past `KEY=value`
     prefixes), of Windows Droid's `powershell -Command` line, and of shell
     startup commands that run a provider CLI (ACP sign-in, the chat auth
     card, `claude auth login`).
   - Node-run CLIs get their leading args (Qwen `<node> <cli-entry.js>`,
     Cursor `<node> [--use-system-ca] <index.js> --disable-auto-update`, Pi
     `<pinned node> <dist/cli.js>`). Codex gets
     `-c check_for_update_on_startup=false`, Grok `--no-auto-update`, and the
     env gets each tool's self-update switches (plus
     `CURSOR_INVOKED_AS=cursor-agent`). Windows runs the pin's `.exe` or
     `node.exe`, never a cmd shim.
   - While the pin downloads, the PTY opens a clean shell, prints "ADE is
     downloading <Tool> for this machine. It starts here when the download
     finishes.", holds initial input, and types the launch when the copy is
     ready. A failure prints the sentence and closes with exit 1 (a state
     known up front makes `create()` throw). `create()` awaits OpenCode's
     download first, because its TUI attaches to ADE's server.
   - A plain shell with no command is untouched, so a user can run their own
     CLI.
10. Pick a launch strategy:
    - With `args.command` (explicit argv from `buildTrackedCliLaunchCommand`),
      spawn it directly. If that fails, fall back to a shell so
      `args.startupCommand` can still run the CLI.
    - Otherwise try the shell candidates in order (`/bin/zsh`, `/bin/bash`,
      `/bin/sh`, or the Windows ones). A plain interactive shell uses login
      configuration. Command-backed and provider shells use
      `resolveShellCandidates("clean")`, which skips user init files (zsh `-f`
      with `ZDOTDIR=/var/empty`, bash `--noprofile --norc` with
      `BASH_ENV=""`, fish `--no-config`, PowerShell `-NoLogo -NoProfile`,
      `cmd.exe /d`); the caller's `args.env` goes first, then the clean env.
    - Windows tracked-provider continuation uses the structured `command` /
      `args` / `env` of `buildTrackedCliResumeLaunchCommand`. The stored
      `resume_command` is a display string, never typed into PowerShell when
      structured metadata exists. Droid uses an explicit no-profile
      PowerShell descriptor, because its temporary settings file needs shell
      statements.
11. If the spawn is a shell, type `args.startupCommand` into it; a direct
    launch skips this. `args.startupDelayMs` (clamped 0–1000 ms by
    `normalizeStartupCommandDelayMs`; bad values become 0) defers the write
    on an unref'd timer that `closeEntry` / `dispose` clear. The Work CLI
    launch uses 180 ms (`workCliStartupDelayMs` in `AgentChatPane`) so the
    shell draws its prompt first.
12. A non-empty `args.initialInput` is written after `initialInputDelayMs`
    (clamped 0–10 000 ms) through the
    [agent CLI input protocol](#agent-cli-input-protocol), so the provider
    sees a real first turn.
    - Readiness needs the provider's visible composer and 600 ms of
      stability. The deadline is 60 s for Codex and 20 s for other agent
      CLIs. A stable Codex composer passes even while title or redraw output
      continues after an MCP startup failure.
    - At the deadline of a fire-and-forget Codex launch, ADE keeps the
      prompt and waits again; the PTY stays open. A user write during the
      delay or a retry cancels the kept prompt.
    - With `awaitInitialInput`, a readiness or write failure kills the
      process tree and ends the session `failed`.
    - Returns `{ ptyId, sessionId, pid }`.

**Claude Agent Skill plugin.** `withBundledClaudePlugin` adds
`--plugin-dir <bundled root>` (`claudeAgentSkillPluginRoots`) to Claude
launches, decided from the resolved `command`:

- A direct Claude spawn (`isClaudeBinaryCommand`: `claude`, `claude.exe`,
  `claude.cmd`) gets the flag first in its argv.
- A shell-wrapped launch (`/bin/bash --noprofile --norc -lc "<line>"`) gets it
  inside the `-c`/`-lc` line, right after the `claude` token
  (`shellCommandLineArgIndex`, `withClaudePluginInCommandLine`).
- The typed `startupCommand` is rewritten by the same helper.

Never put Claude flags in a shell's argv: bash reads `--plugin-dir` as its own
option and exits with "invalid option". The injection is idempotent, and a
line that does not parse is returned unchanged.

**Launch env**, in layers: `process.env`, the lane runtime env
(`getLaneRuntimeEnv`), the caller's `args.env`, then `stripHostRuntimeEnv`,
`withAdeTerminalContextEnv` (project, lane and chat ids) and
`withInteractiveTerminalColorEnv`.

- The color helper sets `TERM=xterm-256color` and `COLORTERM=truecolor` when
  missing and unsets `NO_COLOR`, so a user-global `NO_COLOR=1` does not break
  agent TUIs. A `NO_COLOR` set by the caller or lane is kept
  (`preserveNoColor: true`).
- `stripHostRuntimeEnv` (`services/shared/hostRuntimeEnv.ts`) drops the host's
  own keys (`ELECTRON_RUN_AS_NODE`, role and lifecycle keys, compile cache) and
  the multiplexer it started from (`TMUX`, `TMUX_PANE`, `STY`, `ZELLIJ`,
  `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, and `WINDOW` while `STY` is set),
  only where the value is still the host's. Otherwise `tmux split-window` in
  a terminal acts on the user's own session. Agent processes and editors
  (`editors/editorProcessEnv.ts`) use the same strip.

### Data, preview, and runtime state

**Transcript.** `writeTranscript(entry, data)` advances
`transcriptBytesWritten` synchronously, then writes to the append stream.

- When the file plus the next chunk would pass `MAX_TRANSCRIPT_BYTES`
  (16 MiB), the service pauses the PTY (when it can), flushes and closes the
  stream, and atomically replaces the file with a UTF-8-safe recent window
  (up to an 8 MiB tail plus the new chunks, at most 16 MiB). Then it reopens
  and resumes. A backend that cannot pause keeps a bounded pending tail and
  drops the older part, so the kept range stays contiguous.
- Rollover is crash-safe: `<transcript>.rollover.pending.json` describes the
  generations, `<transcript>.rollover.previous` is the backup, temp files are
  in the same folder, and `<transcript>.rollover.json` records `baseOffset`
  and the kept size. Attach finishes an interrupted rollover before it
  reopens. The logical end starts at `baseOffset + retainedBytes`, so it only
  grows.
- That logical end is the mobile and web cursor: each PTY data batch carries
  `offset` after the batch (null when untracked, with no transcript, or after
  a write failure). The write and the batch run in one `onData` handler, so
  rollover never rewinds an offset.
- `getTranscriptWindow(sessionId)` returns the kept logical
  `[startOffset, endOffset)`. `readTranscriptSnapshot` joins the flushed range
  and the live tail into one exact suffix (the sync snapshot barrier).
  `readTranscriptRange({ sessionId, startOffset, endOffset })` clamps to the
  window and reports the range it read; boundary alignment moves to a
  newline or ESC and never splits a UTF-8 character. Never derive a logical
  offset from the file size.

**Resize ownership.** The `ptyId` `resize(...)` path (desktop) records
`lastDesktopCols/Rows`. `resizeBySessionId(..., { source: "mobile" })` does
not, and sets `mobileViewportActive`, so a focused desktop pane does not fight
the phone. `restoreDesktopSizeBySessionId(sessionId)` clears the flag and
restores the desktop size; the sync host calls it when the last phone
detaches. `readScreenSnapshot(sessionId)` returns the live current screen
(scrollback 0) for mobile and web hydrates.

**Preview.** `updatePreviewThrottled` keeps the last non-empty line
(`derivePreviewFromChunk`, max 220 chars) and writes it at most every 900 ms.

**Runtime signal.** `emitRuntimeSignalThrottled` fires
`onSessionRuntimeSignal` on a state change, on a preview change more than
1.2 s after the last signal, or as a 10 s heartbeat. States: `running`,
`waiting-input`, `idle`, `exited`, `killed`. `idle` comes from output silence.
OSC 133 `B`/`C` can confirm running, but prompt markers and painted TUI text
never infer `waiting-input` or Planning. For tracked CLIs, an explicit ADE
request (`ade chat ask`) sets waiting-input.

#### Exact turn status for agent CLIs

ADE does not guess the turn of a tracked agent CLI that reports it. Each
entry holds a turn tracker (`PtyEntry.cliTurn`, `pty/cliTurnSignals.ts`) with
phase `working`, `idle` or `needs-input`. The runtime state, the Work row,
`ade chat status` (`getCliTurnStatus`), settle and the roster read it.

| CLI | working | done | needs you |
| --- | --- | --- | --- |
| Claude Code | `UserPromptSubmit` hook | `Stop` / `StopFailure` hook (background work while `SubagentStart` agents have no `SubagentStop`) | `PermissionRequest` hook (tool permission, `AskUserQuestion`, `ExitPlanMode`), `Notification` `permission_prompt` / `elicitation_dialog`, `Elicitation` |
| Codex 0.167+ | OSC `7501;state=working`, or a launch that carries the prompt (`promptSubmittedAtLaunch`) | `state=done`, or `idle` after working (an interrupt); every report in an output chunk is applied in order | `state=blocked` (`kind=permission`) |
| Others | output (heuristic) | 12.5 s of quiet (heuristic) | the Jev screen check, `ade chat ask` |

**Claude hooks.**

- A tracked Claude launch gets `--settings` with ADE's hooks. Inline
  `--settings` JSON (fast mode, ultracode) gets the hooks merged in, because
  Claude reads only the last `--settings`. A `--settings` file is left alone,
  and that launch keeps the heuristics.
- Each hook is exec form (`command` = `ADE_CLI_PATH`,
  `args: ["__ade-cli-turn-hook", "claude", <session id>]`, `async: true`):
  no shell, the same on Windows, and Claude never waits. A Windows `.cmd`
  shim cannot start this way, so that launch gets no hooks.
- The hook (`apps/ade-cli/src/cliTurnHook.ts`) sends only the event name,
  prompt id, notification type, tool name, agent id and type, and message
  (never the transcript path or last message) to
  `session.reportCliTurnSignal` over `--socket $ADE_CLI_TURN_HOOK_SOCKET`. It
  never starts a brain, prints nothing, and exits 0 within 5 s.
- Each hooked launch gets a random `ADE_CLI_TURN_HOOK_TOKEN`;
  `reportCliTurnHookEvent` drops a report without it, so another CLI under the
  same chat cannot report this turn.
- Async hooks can arrive out of order: a `UserPromptSubmit` for a prompt whose
  `Stop` already arrived is dropped.

**Claude's gaps and their fallbacks.** Claude fires no hook for an interrupt,
and a line queued mid-turn can run with no `UserPromptSubmit`:

- after Esc or Ctrl-C, 2.5 s of quiet ends the turn;
- a `Stop` after a line submitted mid-turn keeps the row working;
- 12.5 s of quiet while working ends the turn (the spinner redraws while
  Claude works, so this fires only after a missed end);
- a menu key (Enter, a letter or digit, Esc) answers `needs-input` and
  returns to working; arrow keys do not.

**Background agents.** Claude sends `Stop` as soon as it starts a background
agent.

- `SubagentStart` / `SubagentStop` keep agent ids in `PtyEntry.cliSubagents`;
  `SessionEnd` (`/clear`, exit) empties it. A stop can arrive before its start,
  so the tracker remembers the last 64 stopped ids and drops a late start.
  Claude's helper agents send `SubagentStop` with no start; they only fill
  that memory. An interrupt drops the agents its turn started.
- While the set is not empty, `enrichSessions` sets
  `activeBackgroundTaskCount`, `backgroundWork` and `backgroundWorkSince` (as
  for a chat), so desktop, web and iOS read background work, not done. The
  runtime signal carries `backgroundAgentIds`, and the push publisher keeps
  the run `running` until they drain; idle heartbeats do not rewrite it, and
  a new turn clears the parked "completed". The sync roster reads
  `getTrackedCliTurn().backgroundAgentCount`.
- A lost `SubagentStop` has no timer on purpose (a real agent can run for
  hours): the row turns Stale after `SESSION_STALE_AFTER_MS`, and the parked
  push run retires at its running TTL.
- Other CLIs have no such signal; the heuristic CLIs show done when output
  stops.

**Exact signals win.** After a session reports through a hook or OSC 7501,
output no longer flips it to running, the 12.5 s rule no longer ends a Codex
turn, and the Jev screen check runs only after a Claude turn ends on the
quiet fallback. Before the first report, the heuristics decide.

**Planned stop.** `disposeAll({ reopenAfterRestart: true })` (update, reboot,
quit) records a tracked CLI as mid-turn when it is owed a continue:

- The exact signal decides first (a working Claude hook or Codex OSC 7501
  turn).
- A Claude CLI with live background agents is owed one; an agent counts for
  2 h after its start (`CLI_SUBAGENT_LIVE_MAX_AGE_MS`).
- A CLI with no exact signal uses the screen guess: still printing and not at
  its prompt. A pending permission prompt is never mid-turn.

**Needs you.** Entering `needs-input` raises the row's hand with the CLI's
words (`cli_prompt` source, "Claude wants permission to use Bash") through
`onSessionAttentionRequested`, the same path, push alert and badge as
`ade chat ask`. Leaving it lowers the hand. An agent's own ask is never
overwritten or lowered.

**Turn end and listeners.**

- An exact `idle` goes to the push publisher as `exactTurnState`, and the run
  settles `completed` (Done), as a chat's `done` does. A turn that starts on
  its own clears settle markers, as a submitted line does.
- `onTrackedCliTurnStarted` fires on a move to working;
  `onTrackedCliTurnEnded` on a move to `idle` or `needs-input`. Work before
  any submit (Codex's startup blip) fires neither. `getTrackedCliTurn` returns
  the phase and its source.

**Cost.** The OSC 7501 parse runs only on chunks that can hold the sequence.
`sessionService.notifyChanged` runs on transitions only. Each Claude turn
starts two short `ade` processes, plus one or two per permission prompt, two
per subagent and one at session end. No per-tool hook is installed.

**Activity detail** is a separate typed value (`planning`, `exploring`,
`implementing`, `testing`, `debugging`, `reviewing`, `shipping`,
`monitoring`) with a source.

- ADE chats: the host detects it from the turn's tool calls
  (`source: "detected"`, `chat/sessionActivityDetector.ts`). An agent can also
  report one with `ade chat activity` (`source: "agent"`) when the guidance
  confirms it can call the runtime's ADE CLI on this runtime's exact socket.
- Tracked CLI terminals have no tool stream, so only agent reports set it.
  PTY output is never scanned for these labels.
- It refines a running card's label, never changes the lifecycle phase, and
  clears on a new user turn ([Activity detection](#activity-detection)).

Tracked CLI activity guidance is on for Codex and OpenCode outside Plan and
external `config-toml`, write-capable non-AGI Droid, Pi full-auto, and Cursor
launches with an initial prompt. It calls `ADE_CLI_PATH` and scopes activity
with `ADE_ACTIVITY_SESSION_ID` (the PTY row id); `ADE_CHAT_SESSION_ID` still
names the owning chat. Windows guidance gives PowerShell and cmd forms plus a
PowerShell bridge for Git Bash, and changes nothing when no form matches.
Guidance stays off for Claude (its shell fallback drops the instruction),
blank Cursor launches, other Pi modes, and Qwen, Kimi, Grok and Copilot
(their command and prompt paths are not verified together).

### Process tree termination

`terminatePtyProcessTree(entry, signal, logger)`:

- **POSIX.** node-pty's `forkpty(3)` child normally leads its own session and
  process group, so the service signals that group first. Every `kill(-pid)`
  goes through `signalProcessGroup` (`services/shared/utils.ts`), which
  refuses a pid below 2 with `ESRCH`: `kill(-1, …)` signals every user process
  and `-0` is ADE's own group.
- In parallel, a bounded `ps` scan (pid, parent, group, foreground group)
  finds descendants and groups created after launch. The first signal never
  waits for it: a 100 ms fallback sends it, and the scan is capped at 250 ms.
- For a non-`SIGKILL` signal, a 1.5 s follow-up rescans and sends `SIGKILL`
  to anything reachable. If that scan fails, ADE force-kills the known groups
  and first members; a failed scan is not proof the tree exited.
- **Windows.** A bounded `taskkill /PID <root> /T` while the leader exists,
  then node-pty's kill. After the grace it always runs
  `taskkill /PID <root> /T /F`, because descendants can outlive the leader. A
  PTY-host crash uses the same forced cleanup for every provider pid of that
  worker.

### Live session row resync

`resyncLiveSessionRowIfNeeded(entry, ptyId)` runs on PTY data batches, at most
once per `PTY_LIVE_SESSION_RESYNC_INTERVAL_MS` (1 s). It fixes two drifts:

- The row says `ended` / `detached` / `disposed` / `completed` while the PTY
  prints: the row goes back to `running`.
- The row's `pty_id` is not the live PTY: the row is rebound.

This covers a reconciler or crash recovery that marked a healthy PTY dead.

### Session-id writes and resizes

`writeBySessionId(sessionId, data)` and `resizeBySessionId(sessionId, cols,
rows)` serve controller devices that know the session id but not the `ptyId`.
Both return `false` when no live PTY is attached.

- `writeBySessionId` writes raw bytes, runs the CLI-user-title sniff, marks
  `running` and schedules the idle move.
- `resizeBySessionId` clamps the size before `pty.resize`.
- Sync calls them only after the peer sent `terminal_subscribe` for that
  session; other `terminal_input` / `terminal_resize` envelopes are ignored,
  so a bare session id cannot drive a shell.

### Chat-CLI auto-reattach (`reattachChatCli` + `writeTerminal`)

`ptyService.reattachChatCli({ chatSessionId, cols?, rows? })` restarts a
chat-CLI session so the user can send a message. It accepts only tracked
sessions whose tool type passes `isPersistedChatToolType` (`cursor` and every
`*-chat` type but `pi-chat`).

- Only those types own the chat-CLI active route (`activeForChat`,
  `reattachChatCli`). Auxiliary PTYs (App Control, shells) can carry the same
  `chatSessionId` to nest under the chat; they use a separate auxiliary route
  for `terminal.read` / `write` / `signal`.
- A live PTY returns `{ terminalId, ptyId, pid, relaunched: false }`.
- Otherwise the resume command comes from `resumeMetadata`
  (`buildTrackedCliResumeCommand`, no overrides) or `resumeCommand`, and
  `create({ sessionId, laneId, chatSessionId, cols, rows, toolType,
  startupCommand })` spawns in the same row (`relaunched: true`).
- `reattachChatCliFlights` allows one reattach per `chatSessionId`, so a
  burst of sends cannot start two `claude --resume <id>` PTYs.

`writeTerminal` is async and reattaches before it writes only when the caller
passed **no** explicit `ptyId` (an explicit one keeps the "PTY not running"
throw) and the target is a tracked chat-CLI session with no PTY.

- An SDK chat has the marker `chat:<provider>[:<id>]` as its resume command.
  `reattachChatCli` refuses it with a user error and logs
  `pty.reattach_chat_cli_refused` (`reason: "sdk_chat"`); it never runs the
  marker as a command.
- Any other "no live PTY" case throws, so App Control, a shell or a non-chat
  CLI never comes back after the user stopped it.

`ade.terminal.reattachChatCli` exposes it to the renderer (`AgentChatPane`,
the composer), the `ade-cli` socket, and the action registry
(`terminal.reattachChatCli`).

### Live-session detection

`ptyService.hasLiveSessions()` is true when any entry is not disposed.
`hasActiveProjectWorkloads(ctx)` in `main.ts` calls it with
`agentChatService.hasRetainableSessions()`, so a project with running CLIs,
agents or shells is never evicted by the warm-idle cap.

### Resource-pressure attribution

`ptyService.getResourceAttribution()` returns `{ activePtyCount, roots }`
for the TopBar indicator. Each root is `{ pid, kind }` from `toolTypeHint`
(`shell` → `"shell"`, `other` → `"unknown"`, a provider CLI →
`"provider-agent"`). It does not sample processes.

`apps/desktop/src/main/services/pty/resourceUsageSampling.ts` samples:

- **`createProcessMetricRowsCollector`** runs `ps -axo pid=,ppid=,pcpu=,rss=`
  async (1 s timeout, 2 MB stdout cap), shares one child among concurrent
  callers, and never rejects: it returns `unavailable` with a reason
  (`timeout`, `spawn-error`, `exit-code`, `oversized-output`). One collector
  per process, made lazily in `registerIpc.ts` and disposed on `will-quit`.
- **`classifyProcessRoles`** gives each pid at most one
  `AppResourceProcessRole`. Electron pids (plus `process.pid`) go first and
  are never walked. ADE runtime roots, PTY-host owners and PTY roots (with
  their explicit kind) are claimed before any descendant walk. Only a
  `provider-agent` root's descendants inherit `provider-agent`; shells,
  runtimes and PTY hosts give `unknown` to children. It also returns the
  legacy `PtyProcessResourceUsageSnapshot`.
- **`computeAppResourceUsageSnapshot`** joins Electron `getAppMetrics()`,
  system memory and the role usage into an `AppResourceUsageSnapshot`. With
  nothing active it skips `ps` (`processSample.status = "skipped"`, reason
  `idle`). `roleUsage[]` and `processSample` are optional: older synced peers
  omit them.

`ade.app.getResourceUsage` (`registerIpc.ts`) caches for 900 ms
(`APP_RESOURCE_USAGE_CACHE_MS`) and shares one in-flight sample per context
set. The renderer's `resourcePressure.ts` groups roles into "ADE app"
(Electron, `ade-runtime`, `ade-pty-host`), "agents" (`provider-agent`) and
"other terminal processes" (`shell`, `unknown`), and adds a staleness note when
the sample is `unavailable`.

### Send-or-continue (`sendToSession`)

`ptyService.sendToSession({ sessionId, text, cols?, rows?, model?,
reasoningEffort?, permissionMode? })` sends text to a Work CLI session and
starts the provider continuation when needed:

1. A live PTY gets `text` through the
   [agent CLI input protocol](#agent-cli-input-protocol) and returns
   `{ ptyId, sessionId, pid, resumed: false, reusedExistingRuntime: true }`.
2. Otherwise the row must be a tracked agent CLI (chats and shells are
   refused). The provider comes from `resumeMetadata.provider`, else
   `providerFromTool(toolType)`. A row with no concrete target runs the
   on-demand backfill of `ensureResumeTargets` (Codex can scan rollout
   storage here).
3. `buildTrackedCliResumeLaunchCommand(metadata, overrides)` rebuilds the
   launch with the current `model` / `reasoningEffort` / `permissionMode`
   overrides, which are also saved on `resumeMetadata.launch`.
4. `resumeRuntimeFlights` allows one continuation per session id.
5. `create({ sessionId, ... })` spawns in the same row. When this call
   created the flight and the builder can carry the prompt
   (`promptAtLaunch`), `text` rides on the resume command and no PTY write
   follows. Otherwise (Cursor, Windows, a reused flight) ADE writes `text`
   after the CLI is input-ready. Returns `{ ptyId, sessionId, pid, session,
   resumed: true, reusedExistingRuntime: false }`.

A failed write after a resume logs `pty.resume_send_input_failed_preserved`
and throws `Terminal session '<id>' could not receive the message.`; the
resumed PTY stays running so the user can retry.

The Work continuation composer, the iOS `work.sendToSession` command and the
`send_to_session` JSON-RPC tool all use `sendToSession`.

Scheduled work uses the same boundary. `chat.createScheduledWork` can target
only an ADE-tracked agent chat or provider CLI the caller owns. A live CLI is
eligible only when the provider's visible composer shows after a short quiet
window (12.5 s of no output is not enough: the model can be thinking). An
ended CLI resumes through `sendToSession`. A proven failure before delivery
restores the occurrence; an ambiguous partial write keeps at-most-once.
Untracked shells are refused.

### Prompt-free resume (`resumeSession`)

`ptyService.resumeSession({ sessionId, cols?, rows?, model?,
reasoningEffort?, permissionMode? })` opens an ended agent CLI session again
with no new message. Its validation matches `sendToSession`: a tracked agent
CLI row and a concrete resume target (Codex update-only transcripts give the
"start a new Codex session" error). A live PTY returns `resumed: false`,
`reusedExistingRuntime: true`; otherwise it relaunches with the overrides and
returns `resumed: true`.

Three siblings serve `ade chat` on a tracked agent CLI
(`chat/agentCliSessionActions.ts`; see
[Talking to an agent CLI session](../chat/README.md#talking-to-an-agent-cli-session)):

- `interruptAgentCli(sessionId)` presses the cancel key without ending the
  process (Esc, Esc twice for OpenCode, Ctrl-C for Cursor). It writes
  directly, so the press is not user input, and presses nothing at a free
  prompt.
- `restartAgentCli({ sessionId, model?, reasoningEffort?, fastMode?,
  permissionMode?, codex*?, instanceId?, requireIdle? })` relaunches the CLI in
  its row on the same conversation. It checks the target first and refuses a
  setting the resume command cannot carry (it builds the command with and
  without it and compares). It saves the settings and account on
  `resumeMetadata.launch`, disposes the PTY, waits up to 5 s for the exit,
  then calls `resumeSession`.
- `regenerateAgentCliTitle(sessionId)` runs the AI title pass from the row's
  `goal` and the output, and saves it as the user's title (`manuallyNamed`).

### Agent CLI input protocol

Live sends, post-resume sends and `initialInput` never use a raw
`pty.write(text + "\r")`:

1. **Line clear.** `Ctrl-U` + `Ctrl-E` clear partial input.
2. **Bracketed paste.** `ESC[200~…ESC[201~` makes multi-line text one paste.
3. **Chunked write.** `AGENT_CLI_INPUT_CHUNK_SIZE` (64 bytes) chunks, with
   `AGENT_CLI_INPUT_CHUNK_DELAY_MS` (5 ms) between them.
4. **Submit.** `\r` after a provider delay: `AGENT_CLI_SUBMIT_DELAY_MS`
   (25 ms), `CODEX_CLI_PASTE_SUBMIT_DELAY_MS` (180 ms),
   `CURSOR_CLI_PASTE_SUBMIT_DELAY_MS` (500 ms).

A fresh `initialInput` waits up to `AGENT_CLI_READY_TIMEOUT_MS` (20 s) for the
TUI to print and settle. A continuation avoids that wait by passing the first
prompt on the resume command when it can.

### AI-driven titles

CLI sessions are always ADE-named, on one model: the cheap helper for a
Claude, Codex or Cursor CLI (Haiku 5.5 / GPT-6 Luna / Composer 2.5), else
`resumeMetadata.launch.model`. If that fails, the deterministic title on the
row stays. Claude JSONL `ai-title` and Codex thread names never win
(`scheduleClaudeRuntimeTitleCaptureBestEffort` and
`scheduleCodexRuntimeTitleCaptureBestEffort` are no-ops).

- **Output snippet title** (shells and other non-agent terminals):
  `aiTitleTimer` fires after 6 s and sends up to 800 chars of ANSI-stripped
  output to `aiIntegrationService.summarizeTerminal` ("max 80 chars, plain
  text").
- **CLI user title** (`CLI_USER_TITLE_TOOL_TYPES`: claude, codex, cursor-cli,
  droid, opencode, pi, muse): `tryCliUserTitleFromWrite` reads keyboard
  writes and commits the first submitted line (3 to 180 chars), because agent
  TUIs hide their output on the alt screen. Skipped when `manuallyNamed`.
  - When the title is still a placeholder (`isCliPlaceholderTitle`: `Claude`,
    `Codex`, `Cursor Agent CLI`, …), `deterministicCliTitleFromSeed` commits a
    title at once (drops lead-ins such as "ok"/"please", clips to 72 chars on
    a clause or word, drops non-command `/` prefixes, sentence case).
  - `runEarlyCliAiTitle` runs after `EARLY_CLI_AI_TITLE_DELAY_MS` (5 s) with
    the seed **plus** the ANSI-stripped `recentOutputTail` (~4000 chars), so
    the title says what the session does. It never overwrites a user rename.
  - AI title calls use `PTY_AI_TITLE_TIMEOUT_MS` (60 s) for slow local
    models.

At close, when an AI provider is available (not guest mode), the transcript
tail (2000 chars) gets a final title through the same model walk. A failure
logs a warning; the title never fails the session. ADE makes no end-of-session
AI summary; the row keeps its deterministic `summary`.

### Continuation metadata backfill

`tryBackfillResumeTarget` runs after a transcript is finalized at close, and
on demand through `ensureResumeTargets(sessionIds)`.
`backfillResumeTargetFromTranscriptBestEffort` is the fire-and-forget wrapper
for close and dispose; the on-demand call returns whether it found a target.

Resolve every provider store through `services/shared/providerConfigHomes.ts`,
never a hard-coded `~/.codex` or `~/.factory`: `CODEX_HOME` and
`CLAUDE_CONFIG_DIR` name the config folder, and `FACTORY_HOME_OVERRIDE`
replaces the HOME that `.factory` is added to. A hard-coded default reads a
different folder than the CLI ADE started.

Strategies, in order:

1. Transcript regexes (`extractResumeCommandFromOutput`) for the resume,
   continue and session flags of `claude`, `codex`, `cursor-agent`, `droid`
   and `opencode` (`--resume`, `--continue`, `--session`, `-r`, `-c`, `-s`,
   `resume`).
2. Claude storage: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/*.jsonl`, the newest
   file changed in the last 5 minutes (the filename is the UUID). Optional
   `startedAt` / `endedAt` and `maxStartDeltaMs` reject a file whose creation
   drifts from the session window (`CLAUDE_STORAGE_MATCH_START_SKEW_MS` 1 s,
   `CLAUDE_STORAGE_MATCH_END_SKEW_MS` 5 s).
3. Codex storage: `<codexConfigHome>/sessions/YYYY/MM/DD/rollout-*.jsonl`, up
   to 7 days and 80 files. A candidate whose `session_meta.payload.cwd`
   matches is scored by how close `payload.timestamp` (or mtime) is to
   `startedAt`; the best wins, so a concurrent terminal in the same cwd keeps
   its own target. Optional gates: `maxStartDeltaMs`, `notBeforeMs` (refuses
   a rollout from an earlier launch) and `excludedIds` (thread ids another row
   owns). The live capture uses all three; the close-time pass uses only a
   10-minute drift window.
4. Droid storage: `<factoryConfigHome>/sessions/<escaped-cwd>/*.jsonl`. The
   first line must be a `session_start` with a matching `cwd`; mtime is scored
   against `startedAt` (10-minute window). The id becomes
   `droid --resume <id>` through `sessionService.setResumeCommand`.
5. OpenCode: ADE's managed store, read-only (`listAdeOpenCodeSessions`, 80
   rows), never `opencode session list` (that reaches OpenCode's background
   service and the user's store). A session whose `directory` matches is
   scored by creation (else update) time against `startedAt` (10-minute
   window) and becomes `opencode --session <id>`. The directory match
   compares realpath-resolved, platform-folded keys (`fs.realpathSync` +
   `pathKey`): macOS returns `/var/...` where rows record `/private/var/...`,
   and Windows adds case drift. A folder that no longer resolves compares the
   raw spelling.

The `reason` of the backfill gates the storage reads:

- `"close"` and `"dispose"` read Codex, Droid and OpenCode storage (Codex with
  the 10-minute window).
- `"resume-launch"` (explicit continuation) may read storage.
- `"session-list"` reads none, so a list refresh never touches the disk or
  adopts another lane's rollout. Live Codex sessions get their target through
  the live capture below.

A found id updates `resumeMetadata.targetId` through `updateMeta`. A resume
command is written even with no target, so the CLI can prompt.
`ensureResumeTargets` de-dupes ids, logs one
`pty.resume_target_backfill_failed` per failing id, and never throws.

Every storage strategy matches an **exact cwd** from
`resolveSessionRunCwd(session)`: the lane worktree
(`laneService.getLaneBaseAndBranch`) first, then the folder of the transcript
path. Transcripts live under the project root even for lane sessions, so the
transcript folder is only the fallback for a deleted lane.

### Live Codex session-id capture

`scheduleCodexSessionIdCaptureBestEffort(sessionId, cwd, startedAt)` runs once
per Codex PTY launch. Codex has no pre-assigned-id flag, so this is the only
way to learn the UUID. Two strategies run together:

- **`fs.watch`** on today's and tomorrow's (UTC rollover)
  `<codexConfigHome>/sessions/YYYY/MM/DD/`. Each event triggers a 200 ms
  debounced parse of new candidates.
- **Fallback scans** at `CODEX_FALLBACK_POLL_DELAYS_MS` (0.5, 2, 5, 12 and
  30 s), for file systems where `fs.watch` fails. The capture stops after
  `CODEX_LIVE_CAPTURE_HARD_TIMEOUT_MS` (60 s).

A candidate matches by **cwd plus a launch window**, with no content gate:
`CODEX_LIVE_CAPTURE_MAX_START_DELTA_MS` (90 s) on each side of `startedAt`,
and the `notBeforeMs` floor (`startedAt - 1 s`). There is **no**
"ADE session guidance" marker gate: most launches never print that string.

Two Codex runs in the same worktree cannot share a thread: each pass excludes
ids another row owns (`listOtherAdoptedCodexTargetIds`, from
`resumeMetadata.targetId` and the parsed `resumeCommand`). If that query
throws, the pass captures nothing. Time only breaks ties.

On a capture, the service writes `resumeMetadata.targetId` and appends
`{ id, thread_name, updated_at }` with the name `ade-<sessionId>` to
`<codexConfigHome>/session_index.jsonl` (Codex's on-disk `SetThreadName`
format). `codex resume ade-<id>` then resolves wherever the rollout is. ADE
owns the `ade-*` names, and the append is under `PIPE_BUF`, so it is safe
beside Codex's own writes.

### Pi session tracking

Pi is the only tracked CLI that shares its store with ADE chat. Both resolve
it with `piSessionStoreForEnvironment` (`services/chat/piSessionStore.ts`);
[Agent Routing › Session store](../chat/agent-routing.md#session-store) has
the precedence and the two sidecar files.

**Never resume Pi by "most recent".** `defaultResumeCommandForTool("pi")` is
null, `buildTrackedCliResumeLaunchCommand` emits `--session <id>` or starts
fresh, and `PI_CONTINUATION_FLAG_RE` / `stripPiContinuationArgs` remove
`--continue`, `-c` and `-r` (Pi's picker) whenever ADE rebuilds a launch. The
most recent session in a folder can be another terminal's or a chat's. A
user-typed `--continue`/`-c`/`-r` resolves to a concrete id **before** the
spawn, so Pi cannot write a JSONL before ADE upgrades its creation lease.

**Re-check a stored target.** `piSessionCouldBelongToTerminal` rejects a
session created before the terminal (10-minute grace). The launch then logs
`pty.pi_resume_target_discarded`, clears **both** `resumeCommand` and
`resumeMetadata` (`setResumeCommand(null)` alone re-derives from the
metadata), and rebuilds with a null target so model, thinking and tool flags
stay. A chosen target (`importedFrom`) is exempt.

**Exact, ownership-aware selection.** `selectPiStorageSessionCandidate`
requires the header cwd to equal the launch `cwd` (a lane worktree is inside
the primary root, so containment would cross lanes). It scores **creation**
time only, because an old session that a chat just wrote to has a fresh
mtime. Survivors are checked with `isOwnedByAnotherWriter`
(`piSessionLeaseIsHeld` or `piSessionIsAdoptableByTerminal`), because losing
the lease after the launch commits disposes the terminal.

**Record ownership only once confirmed.** `recordPiSessionOwner` writes the
durable `.ade-owner` claim on resume, and on a fresh launch only on the branch
that wins the lease upgrade. The sidecar is never deleted, so a claim on the
losing branch would block every other terminal.

**Launch errors name the cause.** A latest session ADE cannot verify inside
the root reports that the repository's `.pi/settings.json` moves Pi's session
folder (set `PI_CODING_AGENT_SESSION_DIR` for the profile instead), or that
the session id could not be verified in the store.

**Initial input waits for quiet, not a clock.** For `toolType === "pi"` with
`initialInputDelayMs`, the create flow waits for that much output silence
(capped at 15 s), then logs `pty.pi_initial_input_ready`. Pi prints a banner,
skills and conflicts before its prompt accepts input. The wait cancels
through `PtyEntry.initialInputCancel` wherever disposal clears
`initialInputTimer`.

### Dispose and orphan disposal

`dispose({ ptyId, sessionId? })` kills the process tree
(`terminatePtyProcessTree`, `SIGTERM` unless `signal` overrides, always
`SIGKILL` after the grace), ends the row (`sessionService.end`), schedules
transcript work, and broadcasts `ptyExit`.

- `scheduleTranscriptDependentWork` flushes the stream, then backfills and
  titles.
- `cleanupEntryPaths` unlinks `cleanupPaths` (per-session ADE CLI config
  files).

A `waiting-input` state never closes a PTY. The user, the owning service or
the worker layer must call `dispose`.

#### Resume launches that die on launch

A resume takes over an existing row, so a launch that fails at once would mark
a resumable session `failed`. `create` snapshots the row's `priorEndState`
(`status`, `exitCode`, `endedAt`), and `closeEntry` restores it when the
process exits nonzero within `RESUME_LAUNCH_FAILURE_WINDOW_MS` (5 s): a bad
flag, a missing binary or a shell usage error, not a real exit. Each restore
logs `pty.resume_launch_failed_status_preserved`.

`running` is never captured: a row can read `running` after its brain died,
and restoring it would mark a dead relaunch live. Only `detached`,
`completed` and `failed` are restored; anything else leaves the snapshot null.

---

## Data flow summary

```
renderer pty.create  →  ade.pty.create (registerIpc)
                          ↓
                      ptyService.create
                      ├─→ resolveLaneLaunchContext (lane gate)
                      ├─→ sessionService.create (new row)
                      ├─→ loadPty().spawn (with ADE identity env for
                      │                     Claude/Codex tool types)
                      └─→ transcript stream, preview, title timers

PTY data events  →  broadcastData (ade.pty.data)
                 →  writeTranscript / updatePreview / runtime signals

PTY exit         →  sessionService.end
                 →  scheduleTranscriptDependentWork
                 │     ├─ endTranscriptStream
                 │     ├─ backfillResumeTargetFromTranscriptBestEffort
                 │     └─ summarizeSessionBestEffort
                 └─ broadcastExit (ade.pty.exit)
```

---

## Gotchas

- `ptyService.enrichSessions` (from `registerIpc.sessionsList`) overlays live
  PTY state on rows: `status`, `ptyId`, `endedAt`, `exitCode`,
  `runtimeState`. A caller that bypasses `registerIpc` must run rows through
  `enrichSessions` or reconcile live PTYs before it trusts those fields.
- `sessionsList` and `sessionsGet` hydrate resume targets
  (`ensureResumeTargets`) for tracked, ended Claude/Codex rows with a blank
  `targetId`. `sessionsList` caps the batch at 10 ids and logs failures as
  `sessions.resume_target_hydration_failed`. A new session IPC must do the
  same, or fresh ended sessions show "no resume target" for a moment.
- A resumed session takes its transcript path from the row. If that file was
  deleted, `create` makes a new empty one: the old history is gone.

---

## Cross-links

- UI surfaces: [ui-surfaces.md](./ui-surfaces.md)
- Lane isolation and worktree gating: [runtime-isolation.md](./runtime-isolation.md)
- Session deltas: `apps/desktop/src/main/services/sessions/sessionDeltaService.ts`

## Activity detection

`sessionActivityDetector.ts` reads every normalized chat event (`tool_call`,
`command`, `file_change`, `subagent_started`) from every chat provider (the
ACP providers also carry the protocol's `toolKind`) and keeps one detected
activity per chat:

- Reads and searches never move a turn out of a real activity; only a long
  run of reads returns it to **Exploring**. The first evidence of a turn sets
  the state directly.
- Test runners, review/test/implementation subagents and watch loops are
  strong signals (one call switches). Edits, typechecks, one-off CI reads and
  git commit/push/PR commands are weak (two within five minutes), so one push
  does not flash **Shipping**.
- An edit within two minutes of a test run is a fix-and-rerun loop and stays
  **Testing**. Tool calls inside a subagent (`parentItemId`) are ignored.
- **Debugging** is never detected; tool calls cannot tell it from testing.

The chat service writes the value only when it changes
(`sessionService.setDetectedSessionActivity`). `nextDetectedActivityReport`
(`shared/sessionActivity.ts`) holds the precedence: detection is primary; an
agent report from the current turn stands while it still covers what the
detector sees (debugging covers testing and implementing, planning covers
exploring). A detected value can carry across continuation turns; the
detector and the row reset when the user engages (a message, a steer, an
answer).

`updatedAt` is when the session **entered** the activity, and the row's
elapsed counts from there (`sessionElapsedAnchor`): "Testing 3m" is three
minutes of tests. The turn's total stays on the chat's "Working…" timer. An
agent that re-reports the shown activity keeps its entry time.
