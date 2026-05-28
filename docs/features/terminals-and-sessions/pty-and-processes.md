# PTY, Sessions, and Managed Processes

Lifecycle and wiring for the three services that back the
terminal/session system:

- `apps/desktop/src/main/services/pty/ptyService.ts`
- `apps/desktop/src/main/services/sessions/sessionService.ts`
- `apps/desktop/src/main/services/processes/processService.ts`

These services run inside the **active ADE runtime** (local daemon for
local-bound windows, SSH-attached remote runtime for remote-bound
windows). The same source files are also loaded by the desktop main
process for the legacy in-process IPC fallback path; both paths share
identical behavior. PTY data and exit events flow over the runtime's
event stream and the renderer subscribes via the preload runtime event
pump. Remote-bound windows therefore have their PTYs spawn on the
remote machine — `node-pty` runs on the remote host, the bytes stream
back over SSH, and per-process readiness checks (TCP port probes) hit
ports on the remote host as well.

All three are large and carry a lot of cross-wiring through the
runtime daemon's project boot and `registerIpc.ts`. Re-read them before
any non-trivial change. The most recent structural shift was in
`processService`: runtime entries are now keyed by `runId` so a single
`(laneId, processId)` pair can have multiple concurrent and historical
runs simultaneously.

Adjacent: the `apps/desktop/src/main/services/computerUse/`
directory hosts the computer-use control plane and its broker
service (`computerUseArtifactBrokerService.ts`, with companion
test). It is local-only — controlling a real desktop is gated to the
local ADE runtime.

---

## `sessionService`

File: `apps/desktop/src/main/services/sessions/sessionService.ts`

Single source of truth for `terminal_sessions` rows. Pure persistence —
does not spawn anything, does not stream data, does not touch the
filesystem outside `readTranscriptTail`.

### Row shape

`SessionRow` maps to columns in `terminal_sessions`:

- identity: `id`, `lane_id`, `pty_id`, `tracked`, `pinned`,
  `manually_named`
- metadata: `title`, `goal`, `tool_type`, `summary`
- lifecycle: `status`, `started_at`, `ended_at`, `exit_code`
- content refs: `transcript_path`, `last_output_preview`
- git: `head_sha_start`, `head_sha_end`
- resume: `resume_command`, `resume_metadata_json`

`mapRow()` converts the row into `TerminalSessionSummary` /
`TerminalSessionDetail`. It parses `resumeMetadata` through
`normalizeResumeMetadata` (handles legacy `target` vs modern `targetId`),
then derives `resumeCommand` via `deriveResumeMetadataCommand` so
downstream code always sees a normalized command even for old rows.

### Exported methods

- `list({ laneId?, status?, limit? })` — returns up to 200 rows by
  default, ordered by `started_at desc`.
- `get(sessionId)` — single row with `TerminalSessionDetail`.
- `create({ sessionId, laneId, ptyId, tracked, title, startedAt,
  transcriptPath, toolType?, resumeCommand?, resumeMetadata? })` —
  inserts with status `running`. Normalizes the tool type and
  resume command/metadata before writing.
- `updateMeta(args)` — partial update, used by rename, pin, goal edit,
  tool-type change, and resume metadata refresh. Recomputes
  `resume_command` when either `toolType`, `resumeCommand`, or
  `resumeMetadata` changes.
- `reopen(sessionId)` — lightweight reset to `running`. Used when a
  resume is in-flight before the PTY is attached.
- `reattach({ sessionId, ptyId, startedAt })` — full reset used by
  `ptyService` during resume: status back to `running`, clears
  `ended_at`, `exit_code`, `summary`, `head_sha_end`, rebinds `pty_id`
  and `started_at`. Keeps identity, lane, transcript, head SHA start,
  tool type, resume metadata.
- `setHeadShaStart` / `setHeadShaEnd` — anchors for delta computation.
- `setLastOutputPreview(sessionId, preview)` — also stamps
  `last_output_at`.
- `setSummary` / `setResumeCommand` — tight writes used by the
  end-of-session summarizer and resume backfill.
- `end({ sessionId, endedAt, exitCode, status })` — finalizes and
  nulls `pty_id`.
- `readTranscriptTail(transcriptPath, maxBytes, opts)` — async file
  read, can align to a line boundary and optionally strip ANSI.
- `reconcileStaleRunningSessions({ endedAt?, status?, excludeToolTypes? })`
  — on-startup cleanup. `excludeToolTypes` is still accepted but
  `main.ts` no longer passes chat tool types; chat runtimes restart
  fresh on app launch, so leaving stale `running` chat rows behind is
  a net negative.
- `deleteSession(sessionId)` — remove a row outright. Emits
  `terminalSessionChanged` with `reason: "deleted"`. Used by both PTY
  cleanup and `agentChatService.deleteSession`.
- `onChanged(listener)` — in-process event bus, fires from
  `updateMeta` (`reason: "meta-updated"`) and `deleteSession`
  (`reason: "deleted"`).

### Notes

- `SessionService` never fires `changed` on create/end — those are
  handled by `ptyService` broadcasting PTY events.
- The `manuallyNamed` flag suppresses auto-title regeneration. Any
  rename from the renderer sets it to `true`; AI auto-title code
  refuses to overwrite when it is set.
- Continuation metadata is stored as a JSON blob. `normalizeResumeMetadata`
  accepts both the current `{ provider, targetKind, targetId, launch }`
  shape and legacy fields (`target`, `permissionMode` at the top level).

---

## `ptyService`

File: `apps/desktop/src/main/services/pty/ptyService.ts`

Owns native `node-pty` instances, transcript capture, runtime state,
and AI-driven titling. Creates/ends rows in `sessionService`.

### Entry state (`PtyEntry`)

Each live PTY has an entry in the `ptys` map keyed by `ptyId` with:

- `pty` (node-pty handle), `laneId`, `laneWorktreePath`, `boundCwd`,
  `sessionId`, `tracked`
- transcript: `transcriptPath`, `transcriptStream`,
  `transcriptBytesWritten`, `transcriptLimitReached` (64 MB cap from
  `MAX_TRANSCRIPT_BYTES`)
- preview: `lastPreviewWriteAt`, `previewCurrentLine`,
  `latestPreviewLine`, `lastPreviewWritten`
- tool metadata: `toolTypeHint`, `resumeCommand`,
  `resumeCommandIsFallback`, `resumeScanBuffer`
- runtime state: `lastRuntimeSignalAt`, `lastRuntimeSignalState`,
  `lastRuntimeSignalPreview`
- AI title: `aiTitleTimer`, `cliUserTitleLineBuffer`,
  `cliUserTitleCommitted`
- buffer snapshot mirror: `terminalSnapshot` — for tracked PTYs only;
  an `@xterm/headless` Terminal + `SerializeAddon` that mirrors PTY
  output so the renderer-less surfaces (TUI `TerminalPane`, mobile
  Work tab, `ade terminal preview`) can render a real xterm buffer
  snapshot without subscribing to the live data stream. Writes are
  debounced (`TERMINAL_SNAPSHOT_DEBOUNCE_MS = 500`) and flushed to
  `.ade/cache/terminal-snapshots/<sessionId>.json` as a
  `TerminalSerializedSnapshot` (version 1: cols / rows / cursor /
  viewport / buffer-type / serialized scrollback + per-cell visible
  rows). Flushed on PTY exit, on resize, and on every
  `terminal.preview` call.
- initial input: `initialInputTimer` — deferred initial-input write for
  callers that pass `args.initialInput` with an `initialInputDelayMs`
- live session resync: `lastSessionResyncCheckAt` — last time the PTY
  entry re-synced its session row to keep the DB in step with the
  in-memory state
- teardown: `disposed`, `createdAt`, `cleanupPaths`

### Create flow (`create(args)`)

1. Resolve the lane worktree via `resolveLaneLaunchContext` — rejects
   requests that escape the lane root.
2. When the caller provides a `sessionId`:
   - Accept a missing row (caller gets a brand-new session with that ID).
   - If the row exists, enforce same lane and `tracked = true`.
   - If the row is already attached to a live, undisposed PTY, reuse
     that attachment: reattach the session row to the existing PTY,
     mark runtime state `running`, and return the existing
     `{ ptyId, sessionId, pid }` without spawning anything. This makes
     repeated "resume" clicks idempotent.
3. Generate `ptyId` + `sessionId` (reuses the row's `id` when resuming;
   a missing row uses the caller-supplied ID if any, otherwise a new UUID).
4. Resolve transcript path: reuses the existing row's path when
   resuming, otherwise `safeTranscriptPathFor(sessionId)` under the
   transcripts directory.
5. For Claude/Codex tool types, launch the provider with ADE identity
   environment variables and rely on the bundled `ade` CLI for ADE actions.
   Any temporary startup context path goes into `cleanupPaths` for unlink on
   disposal.
6. Build initial `resumeMetadata` via `buildInitialResumeMetadata` —
   extracts a pre-assigned `--session-id <uuid>` from the Claude
   startup command when present.
7. Insert a new `terminal_sessions` row (or skip when resuming an
   existing one) and call `sessionService.create`. Set runtime state to
   `running`.
8. Best-effort capture of `headShaStart` via `computeHeadShaBestEffort`
   so `sessionDeltaService` has a git anchor.
9. Pick a launch strategy:
   - When `args.command` is present (e.g. the renderer asked for
     `claude` with explicit argv from `buildTrackedCliLaunchCommand`),
     spawn that program directly. If the direct spawn fails, fall back
     to a shell candidate so an `args.startupCommand` shadow command
     can still execute the CLI through the user's shell rc — useful
     when Claude/Codex are only resolvable through `~/.zshrc` shims.
   - Otherwise iterate the shell candidate list (`/bin/zsh`,
     `/bin/bash`, `/bin/sh`, or Windows equivalents), retrying across
     candidates if the first spawn fails. Plain interactive shell
     sessions (`toolType === "shell"` with no direct command and no
     startup command) opt into the **clean shell** candidate set:
     `resolveShellCandidates({ clean: true })` returns the same shell
     binaries but pinned to `args` + `env` overlays that skip user
     init files (zsh `-f` with `ZDOTDIR=/var/empty`, bash
     `--noprofile --norc` with `BASH_ENV=""`, fish `--no-config`,
     PowerShell `-NoLogo -NoProfile`, `cmd.exe /d`). The overlays are
     applied per candidate so an `args.env` from the caller is
     overlaid first, then the clean-shell `env` block, before
     `ptyLib.spawn`.
10. If the spawn ended up in a shell (no direct launch, or direct
    launch fell back), type `args.startupCommand` into the PTY so the
    shell executes the CLI. Direct launches that succeeded skip this —
    they already received argv. The write can be deferred by
    `args.startupDelayMs` (clamped 0–1000 ms via
    `normalizeStartupCommandDelayMs`; non-numeric / negative / `NaN`
    inputs collapse to `0`). When the delay is positive the write is
    scheduled with `setTimeout(...).unref()` so the timer never blocks
    process exit; `closeEntry` / `dispose` clear the pending timer, and
    the scheduled callback also bails out if the PTY was disposed in
    the meantime. This is what the renderer Work CLI
    launch path uses (`workCliStartupDelayMs = 180` in
    `AgentChatPane`) to give the spawned shell a beat to finish
    drawing its initial prompt before the CLI invocation is typed in,
    avoiding a half-rendered command in the user's scrollback.
11. If `args.initialInput` is a non-empty string, `create` schedules
    writing it into the PTY after an optional `initialInputDelayMs` delay
    (clamped 0--10 000 ms). The initial input is submitted using the
    agent CLI input protocol (bracketed paste envelope, chunked writes,
    provider-specific submit delay) so the provider sees it as a real
    first user turn rather than a half-typed shell line. This replaces
    the older pattern where callers embedded the prompt in the provider
    argv or typed it as a post-create PTY write. The timer is cleared
    on `closeEntry` / `dispose` and the callback bails out if the PTY
    was disposed in the meantime. Returns `{ ptyId, sessionId, pid }`.

The launch env is built layer by layer: `process.env`, the lane
runtime env (from `getLaneRuntimeEnv`), the caller's `args.env`, then
`withAdeTerminalContextEnv` (project / lane / chat ids), then
`withInteractiveTerminalColorEnv`. The color helper sets a sensible
`TERM` (`xterm-256color`) and `COLORTERM` (`truecolor`) when missing
and unsets `NO_COLOR` so TUIs render in color by default. If the
caller or the lane env explicitly set `NO_COLOR`, the helper is called
with `preserveNoColor: true` and leaves it alone. Without this, a
user-global `NO_COLOR=1` would silently break Claude / Codex /
OpenCode rendering inside Work tabs.

### Data, preview, and runtime state

`writeTranscript(entry, data)` writes to the append-mode write stream.
Once the 64 MB cap is hit it writes a single notice line and drops
further output. Bytes written are not persisted, so the cap resets on
reattach.

`updatePreviewThrottled` uses `derivePreviewFromChunk` to track the last
non-empty line, capped at 220 chars. Preview is flushed to
`sessionService.setLastOutputPreview` at most every 900 ms.

`emitRuntimeSignalThrottled` fires `onSessionRuntimeSignal` when the
runtime state changes, when the preview changes more than 1.2 s after
the previous signal, or as a 10 s heartbeat. Runtime states:
`running`, `waiting-input`, `idle`, `exited`, `killed`. `idle` is
inferred from OSC 133 prompt markers.

### Process tree termination

`terminatePtyProcessTree(entry, signal, logger)` replaces the older
single-process `entry.pty.kill(signal)` call. On POSIX it walks the PTY
root PID's descendant tree via `pgrep -P` (up to
`PTY_PROCESS_TREE_MAX_DEPTH = 12` levels), signals every descendant in
reverse depth order, then kills the root. For non-`SIGKILL` signals a
follow-up timer (`PTY_PROCESS_TREE_KILL_DELAY_MS = 1500 ms`) checks
whether any descendants survived and sends them `SIGKILL`. This ensures
that a `SIGTERM` on a tracked agent CLI session kills both the shell and
any child processes the agent spawned (language servers, dev servers,
etc.) instead of leaving orphaned process trees.

### Live session row resync

`resyncLiveSessionRowIfNeeded(entry, ptyId)` runs on every PTY data
batch (throttled to once per `PTY_LIVE_SESSION_RESYNC_INTERVAL_MS =
1 000 ms`). It reads the session row from `sessionService.get` and
fixes two drift scenarios:

- The DB row says `ended` / `detached` / `disposed` / `completed` but
  the PTY is still alive and producing output. The service re-opens the
  row to `running` so the UI no longer shows a stale "ended" badge.
- The DB row's `pty_id` does not match the current in-memory PTY. The
  service rebinds it.

This guards against races where an external reconciler or a crash
recovery pass marks a row dead while the PTY is still healthy.

### Session-id writes and resizes

`ptyService.writeBySessionId(sessionId, data)` and
`ptyService.resizeBySessionId(sessionId, cols, rows)` are the host-side
entry points for controller devices that know the ADE session id but not
the current in-memory `ptyId`. Both scan the live PTY map for an
undisposed entry matching the session id and return `false` when the
session row exists but no PTY is currently attached.

`writeBySessionId` forwards raw bytes into the PTY, runs the same
CLI-user-title sniffing used by local terminal writes, marks runtime
state `running`, and schedules the idle transition. `resizeBySessionId`
clamps the requested dimensions with the normal PTY dimension guard
before calling `pty.resize`.

The sync host only calls these methods after the peer has subscribed to
the same session with `terminal_subscribe`; unsubscribed
`terminal_input` / `terminal_resize` envelopes are ignored. This keeps
mobile terminal control tied to the visible Work surface instead of
making a bare session id sufficient to drive a shell.

### Chat-CLI auto-reattach (`reattachChatCli` + `writeTerminal`)

`ptyService.reattachChatCli({ chatSessionId, cols?, rows? })` is the
single entry point for "spin a chat-CLI session back up because the
user wants to send a message". It only accepts tracked chat-typed
sessions (`isPersistedChatToolType(toolType)`) — non-chat sessions and
untracked rows are rejected with a clear error.

Chat-scoped PTYs are partitioned by tool type. Persisted chat tool
types (`claude-chat`, `codex-chat`, `cursor`, `opencode-chat`,
`droid-chat`) are the only sessions allowed to own the chat-CLI active
route used by `activeForChat` and `reattachChatCli`. Auxiliary PTYs
such as App Control or plain shells may carry the same `chatSessionId`
so they nest under the parent chat, but they are tracked in a separate
auxiliary active route for `terminal.read` / `write` / `signal`.

Behaviour:

- Fast path: if a live PTY is already bound to the chat session, the
  call returns `{ terminalId, ptyId, pid, relaunched: false }` without
  any further work.
- Otherwise resolve the resume command from `session.resumeMetadata`
  (via `buildTrackedCliResumeCommand`, no overrides) or
  `session.resumeCommand`, then `service.create({ sessionId, laneId,
  chatSessionId, cols, rows, toolType, startupCommand })` to spawn a
  fresh PTY in the same row and return `{ ..., relaunched: true }`.
- Concurrent callers are deduped through `reattachChatCliFlights`
  (one in-flight reattach per `chatSessionId`) so a chat composer +
  App Control + a rapid send burst can't each race a separate
  `claude --resume <same-id>` PTY into existence.

`writeTerminal` was made async and now auto-reattaches before
writing when:

1. The caller did NOT pass an explicit `ptyId` (explicit `ptyId`
   keeps the original "PTY not running" throw to surface programmer
   errors), and
2. `terminalId` / `chatSessionId` resolves to a tracked chat-CLI
   session whose PTY is missing.

In that case the service calls `reattachChatCli({ chatSessionId })`
and writes to the freshly attached PTY. Any other "no live PTY"
case still throws — the auto-reattach is intentionally scoped to
chat CLIs so an active App Control terminal, a shell, or a non-chat
agent CLI doesn't silently resurrect after the user stopped it.

A new IPC channel `ade.terminal.reattachChatCli` exposes the
service method to the renderer (consumed by `AgentChatPane` and the
chat composer when sending into a chat whose PTY has been
evicted), the `ade-cli` socket surface, and the ADE Action
registry under `terminal.reattachChatCli`.

### Live-session detection

`ptyService.hasLiveSessions()` walks the PTY map and returns true if
any entry is not disposed. `main.ts`'s
`hasActiveProjectWorkloads(ctx)` calls it (alongside
`agentChatService.hasRetainableSessions()` and managed-process
checks) so a project context with running CLIs / agents / shells is
never evicted by the warm-idle cap.

### Send-or-continue (`sendToSession`)

`ptyService.sendToSession({ sessionId, text, cols?, rows?, model?,
reasoningEffort?, permissionMode? })` is the single entry point for
"send this text to a Work CLI session, starting the provider
continuation if needed." It collapses the legacy resume / reattach /
write paths into one call:

1. If a live PTY is currently attached, submit `text` using the agent
   CLI input protocol (see below) and return `{ ptyId, sessionId, pid,
   resumed: false, reusedExistingRuntime: true }`.
2. Otherwise require a tracked agent CLI row (Claude, Codex, Cursor,
   OpenCode, Droid; chats and shells are rejected with a clear error).
   Resolve the provider from `resumeMetadata.provider`, fall back to
   `providerFromTool(toolType)`.
3. Rebuild the resume command via
   `buildTrackedCliResumeCommand(metadata, overrides)` — runtime
   `model` / `reasoningEffort` / `permissionMode` overrides flow into
   the command line so the continuation honours the user's current
   model picker.
4. De-duplicate concurrent sends through `resumeRuntimeFlights` (one
   in-flight continuation per session id) so rapid sends do not spawn
   parallel PTYs against the same row.
5. Spawn the continuation through `service.create({ sessionId, ... })`
   in the same row, submit `text` via the agent CLI input protocol,
   and return the new `{ ptyId, sessionId, pid, session, resumed: true,
   reusedExistingRuntime: false }`.

The renderer's Work continuation composer, the iOS Work tab's
"continue" path (`work.sendToSession` remote command), and the TUI's
`send_to_session` JSON-RPC tool all go through this single function.

### Agent CLI input protocol

All `sendToSession` text submissions (and `initialInput` writes from
`create`) go through a structured input protocol instead of a raw
`pty.write(text + "\r")`. The protocol:

1. **Line clear** — send `Ctrl-U` + `Ctrl-E` to clear any partial
   input the TUI may have buffered.
2. **Bracketed paste envelope** — wrap the text in `ESC[200~…ESC[201~`
   so the TUI interprets multi-line content as a single paste event
   rather than submitting on each newline.
3. **Chunked write** — the bracketed payload is written in
   `AGENT_CLI_INPUT_CHUNK_SIZE = 64` byte chunks with
   `AGENT_CLI_INPUT_CHUNK_DELAY_MS = 5 ms` between them, preventing
   PTY input buffer overflows on large prompts.
4. **Submit** — after the paste, a carriage return (`\r`) is sent
   with a provider-specific delay: `AGENT_CLI_SUBMIT_DELAY_MS = 25 ms`
   (general), `CODEX_CLI_PASTE_SUBMIT_DELAY_MS = 180 ms` (Codex),
   `CURSOR_CLI_PASTE_SUBMIT_DELAY_MS = 500 ms` (Cursor). The
   different delays account for each provider's TUI paste-processing
   timing.
5. **Ready wait** — for continuation sends, the protocol waits up to
   `AGENT_CLI_READY_TIMEOUT_MS = 20 s` for the TUI to produce output
   (at least `AGENT_CLI_READY_QUIET_MS = 600 ms` of silence after
   initial output) before writing the input, so the prompt text does
   not race ahead of the provider's startup banner.

### AI-driven titles

Three paths, all gated by `sessionIntelligence.titles.enabled` and the
presence of an AI integration service in non-guest mode (except the
Claude runtime-title capture, which is free):

- **Output snippet title** (shell, run-shell, cursor, aider, continue):
  `aiTitleTimer` fires after 6 s, sends up to 800 chars of
  ANSI-stripped early output to `aiIntegrationService.summarizeTerminal`
  with a "max 80 chars, plain text" prompt.
- **Claude runtime-storage title** (claude, claude-orchestrated):
  `scheduleClaudeRuntimeTitleCaptureBestEffort` polls Claude's local
  JSONL at `~/.claude/projects/<escaped-cwd>/<session>.jsonl` for an
  `ai-title` or `custom-title` record using
  `CLAUDE_TITLE_POLL_DELAYS_MS = [1s, 2.5s, 5s, 12s, 30s, 60s]`. The
  ADE prompt summarizer is intentionally skipped for Claude so that
  Claude Code's own generated title wins when it arrives, with
  `adoptClaudeRuntimeTitle` honouring the `manuallyNamed` flag and
  refusing to overwrite a user rename.
- **CLI user title** (codex, cursor-cli, droid, opencode):
  `tryCliUserTitleFromWrite` listens to PTY *writes* (keyboard input)
  and commits the first submitted prompt line (3 to 180 chars). This
  avoids the alt-screen noise that every interactive agent TUI hides
  output behind. Skipped when the session is `manuallyNamed`. If the
  current session title is still a CLI placeholder (`Claude`, `Codex`,
  `Cursor Agent CLI`, `Factory Droid CLI`, `OpenCode CLI`, etc. — see
  `isCliPlaceholderTitle`), a deterministic fallback title is committed
  immediately from the seed via `deterministicCliTitleFromSeed` (strips
  filler lead-ins like "ok"/"please", clips to 72 chars on a clause or
  word boundary, strips natural-language `/`-prefixes that are not
  provider slash commands, sentence-cases). The AI title call still
  runs after and overwrites with the model's output if it succeeds, but
  the user no longer stares at "Codex" while the model is thinking. AI
  title calls use `PTY_AI_TITLE_TIMEOUT_MS` (60 s) since slower local
  models were timing out at the prior 8 s budget.

At session close, when `refreshOnComplete` is enabled, the transcript
tail (last 2000 chars) is re-summarized into a final title through the
same service. Failure logs a warn and moves on — the title contract
never fails the session.

### Continuation metadata backfill

Internal worker `tryBackfillResumeTarget` runs after a transcript is
finalized at close time, and also on demand via
`ensureResumeTargets(sessionIds)`. `backfillResumeTargetFromTranscriptBestEffort`
is the fire-and-forget wrapper used by close/dispose paths; the
on-demand call path is `async` and returns whether a target was
resolved. Strategies, in order:

1. Scan the transcript tail with provider-specific regexes
   (`extractResumeCommandFromOutput`). The regex now matches resume /
   continue / session flags for `claude`, `codex`, `cursor-agent`,
   `droid`, and `opencode` (`--resume`, `--continue`, `--session`,
   `-r`, `-c`, `-s`, `resume`).
2. Read Claude's local storage: `~/.claude/projects/<escaped-cwd>/*.jsonl`,
   newest file modified in the last 5 minutes, filename is the session
   UUID. The lookup accepts optional `startedAt` / `endedAt` and a
   `maxStartDeltaMs` gate so the backfill can reject JSONL files whose
   creation timestamp drifts too far from the ADE session window
   (`CLAUDE_STORAGE_MATCH_START_SKEW_MS = 1 s`,
   `CLAUDE_STORAGE_MATCH_END_SKEW_MS = 5 s`).
3. Read Codex's rollout storage:
   `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The scan now covers
   up to 7 days of dated directories and up to 80 candidate files.
   Each candidate's first JSONL line is parsed; sessions whose
   `session_meta.payload.cwd` matches are scored by closeness between
   `payload.timestamp` (or the file `mtime` when absent) and the ADE
   session's `startedAt`. The best-scoring match wins, so re-running
   Codex in the same cwd doesn't clobber the resume target of a
   concurrent terminal. The matcher accepts three optional gates so the
   close-time pass is tighter than the on-demand pass:
   `maxStartDeltaMs` (drop matches whose timestamp drifts more than N
   ms from `startedAt`), `notBeforeMs` (ignore rollouts older than this
   floor — used to refuse a recycled rollout from a previous launch),
   and `requiredText` (reads up to 512 KB of the candidate's prefix and
   only accepts the file when that substring appears, e.g. the
   `"ADE session guidance"` marker that the renderer's CLI launcher
   embeds in the initial Codex prompt). The live polling backfill that
   runs while a Codex session is still streaming uses all three gates;
   the close-time backfill only enforces a 10-minute drift window so
   it can match older sessions on resume.
4. Read Droid's local storage:
   `~/.factory/sessions/<escaped-cwd>/*.jsonl`. Each candidate's first
   line must be a `session_start` record whose `cwd` matches the ADE
   session; the file's mtime is scored against `startedAt` with a
   10-minute drift window. The recovered session UUID becomes
   `droid --resume <id>` and is written through
   `sessionService.setResumeCommand`.
5. Shell out to `opencode session list --format json --max-count 80`
   in the lane cwd. Sessions whose `directory` matches are scored by
   `created`/`updated` against `startedAt` with the same 10-minute
   drift window. The recovered id becomes `opencode --session <id>`.

The Droid storage scan and the OpenCode `session list` invocation only
fire on the `close` / `dispose` reasons (and on demand), not on
`session-list` or `resume-launch`, so renderer list refreshes don't
spawn a `spawnSync` or hit external storage on every render.

Any found ID updates the row's `resumeMetadata.targetId` through
`sessionService.updateMeta`. A resume command is always written even
without a target ID so the CLI can prompt interactively.

`ensureResumeTargets(sessionIds)` is exposed publicly so that
`sessions.list` / `sessions.get` handlers in `registerIpc.ts` can
lazily hydrate missing resume targets for Claude/Codex sessions when
the renderer first asks for them. Each call de-dupes IDs and logs a
single `pty.resume_target_backfill_failed` warn per failing ID; it
never throws.

The Codex storage scan is gated by the `reason` argument that the
backfill runs under: `"close"` and `"dispose"` (the regular end-of-
session paths) consult `~/.codex/sessions` with the 10-minute drift
window; `"session-list"` and `"resume-launch"` skip the storage
lookup entirely. Lazy hydration over `sessions.list` therefore relies
only on transcript regex matches, which keeps the list-render hot path
off the disk and prevents one renderer's idle list refresh from
adopting another lane's Codex rollout. Live Codex sessions still get
their resume target through the live capture path, which uses the
strict `requiredText: "ADE session guidance"` gate.

### Live Codex session-id capture

`scheduleCodexSessionIdCaptureBestEffort(sessionId, cwd, startedAt)`
runs once per Codex PTY launch. It is the only handle on the session's
UUID since codex has no pre-assigned-id flag (unlike Claude's
`--session-id`). Two strategies run together:

- **`fs.watch` on the day directory.** A fresh codex run almost always
  writes its rollout JSONL within ~1 s. The service watches today's
  `~/.codex/sessions/YYYY/MM/DD/` (and tomorrow's, to handle UTC
  rollover near midnight); each `add`/`change` event triggers a
  200 ms-debounced parse pass against any new candidate file matching
  the cwd / startedAt / required-text gates above.
- **Staggered fallback poll.** `CODEX_FALLBACK_POLL_DELAYS_MS =
  [500, 2_000, 5_000, 12_000, 30_000]` schedules five timers that
  scan the same directory tree even when `fs.watch` is unavailable
  or unreliable (network mounts, some Linux file systems, the test
  harness). The whole capture aborts after
  `CODEX_LIVE_CAPTURE_HARD_TIMEOUT_MS = 60_000`.

When a UUID is captured, the service writes the row's
`resumeMetadata.targetId` and **registers a stable thread name in
codex's index**: it appends `{ id, thread_name, updated_at }` to
`~/.codex/session_index.jsonl` with a derived `ade-<sessionId>`
name. This is codex's public on-disk format for `SetThreadName`, so
once the line lands, `codex resume ade-<id>` resolves through the
index regardless of where the rollout file ends up on disk. We
control the `ade-*` namespace so it never collides with user-chosen
names. The append is well under PIPE_BUF and safe vs. concurrent
codex writers.

### Dispose and orphan disposal

`dispose({ ptyId, sessionId? })` kills the PTY process tree via
`terminatePtyProcessTree(entry, "SIGTERM", logger)` (see above), ends
the session row via `sessionService.end`, schedules transcript cleanup
work, and broadcasts a final `ptyExit` event. The `signal` override on
the dispose args selects the initial signal (`SIGTERM` by default);
the tree kill always escalates to `SIGKILL` after the grace timer.

Two forms of cleanup:

- `scheduleTranscriptDependentWork` — flush transcript stream, then
  backfill + summarize.
- `cleanupEntryPaths` — unlink `cleanupPaths` (per-session ADE CLI config
  files).

`toolAutoCloseTimers` close a tool-typed PTY that has returned to the
shell prompt. The timer is cleared on any new output or runtime state
change.

---

## `processService`

File: `apps/desktop/src/main/services/processes/processService.ts`

Wraps managed processes defined in project config (`.ade/ade.yaml` +
`.ade/local.yaml`). Launches each via `ptyService.create` with
`toolType = "run-shell"`, so managed processes get transcripts, runtime
state signals, and session rows exactly like interactive PTYs.

### Entry state (`ManagedProcessEntry`)

Keyed by `runId` (a new UUID per invocation). A single
`(laneId, processId)` pair can own many entries at once: one per live
run plus up to `MAX_PROCESS_HISTORY_PER_LANE_PROCESS = 20` of the most
recent terminated runs. Fields:

- `runId`, `laneId`, `processId`
- `definition`: `ProcessDefinition` captured at start
- `runtime`: `ProcessRuntime` (status, readiness, pid, ports, timing,
  `runId`, `sessionId`, `ptyId`, `uptimeMs`)
- `stopIntent`: caller-supplied termination reason (`"stopped" |
  "killed" | "crashed"`; `"restart"` is no longer an exit reason)
- `sessionId` / `ptyId` / `transcriptPath`: the live PTY handle
- readiness: `readinessRegex`, `readinessTimeout`, `readinessInterval`
- health: `healthFailures`, `healthInterval`
- restart: `restartAttempts`

Auxiliary maps:

- `sessionToRunId` / `ptyToRunId` — reverse lookups used by the PTY
  data/exit subscribers.
- `terminationWaiters` — `runId → Set<() => void>` queue that
  `waitForEntryStopped` resolves when `handleProcessExit` fires.
- `restartAttemptsByProcess` — keyed by `"laneId:processId"` so backoff
  carries across runs even when each run has its own `runId`.

`pruneOldEntriesForLaneProcess` is called after every exit and trims
the history back down to `MAX_PROCESS_HISTORY_PER_LANE_PROCESS` —
active runs are skipped so a stop storm never evicts live ones.

### Readiness checks

Three types, driven by `ProcessDefinition.readiness`:

- `none` — immediately `running` / `ready`.
- `port` — every 500 ms, TCP-connect to the configured port on
  127.0.0.1. First success → `running`/`ready`. Health check interval
  (`HEALTH_CHECK_INTERVAL_MS = 2500`) keeps probing; after
  `HEALTH_DEGRADED_AFTER_FAILURES = 2` consecutive failures the status
  flips to `degraded`/`not_ready` until the next success.
- `logRegex` — compiled regex tested against each `ptyData` event; the
  first match marks the process ready.

A single `READINESS_TIMEOUT_MS = 15000` watchdog flips to `degraded` if
nothing becomes ready in time.

### Restart policy

`ProcessRestartPolicy`: `never`, `on-failure`, `always`, `on_crash`
(alias for `on-failure`).

On exit:

1. `handleProcessExit` clears timers, builds the termination `reason`
   (`stopped`, `killed`, `crashed`). `"restart"` is no longer a reason
   — a restart is modeled as a stop of the outgoing run followed by a
   fresh start that gets its own `runId`.
2. Finalizes the current `process_runs` row and emits runtime.
3. Resolves any `terminationWaiters` registered for this `runId`, so
   `restart()`/`restartStack()` callers can await actual exit.
4. If there was no `stopIntent` and the policy says to auto-restart on
   crash or always, applies exponential backoff keyed by
   `"laneId:processId"` — `min(30_000, 400 * 2^(attempt-1))` plus up
   to 250 ms jitter — and schedules a new `startById` via `setTimeout`.
   A stop or kill that originated from the caller clears the attempt
   counter for that process.

`restart()` and `restartStack()` implement themselves by calling
`stopEntries(...)` then awaiting `waitForEntriesStopped` (capped at
`PROCESS_TERMINATION_WAIT_MS = 10 s`) before issuing the new start.
That's why `stop()` / `kill()` return `ProcessRuntime | null`:
the caller may be operating on a `(laneId, processId)` with no active
run, and returning `null` lets the caller no-op without throwing.

### Dependency ordering

`resolveDependencyOrder` is a topological sort with cycle detection.
Thrown errors surface as IPC rejections on `processes.startStack` and
related calls.

### Stack buttons

- `startStack` / `stopStack` / `restartStack` take a `stackId` and
  resolve the `StackButtonDefinition`. `startOrder === "dependency"`
  starts sequentially and awaits each. `startOrder === "parallel"`
  fires all at once.
- `stopStack` reverses the order.
- `startAll` / `stopAll` delegate to `runStartSet` / `runStopSet` with
  `startOrder: "dependency"`.

### Process groups

`processService.startGroup` / `stopGroup` / `restartGroup` accept
`ProcessGroupArgs = { groupId, laneByProcessId }`. `groupProcessIds`
resolves the group id against `effective.processGroups` (throws on
unknown group) and returns every process whose `groupIds[]` includes
the id; `runStartGroupParallel` and `runStopGroupParallel` then drive
the lifecycle. Group runs are intentionally **parallel** — definition
order only affects fork order inside `Promise.all`. Per-process
`dependsOn` is **not** topologically sorted across mixed lanes,
because each member can run on its own lane (the Run page picks the
lane per `CommandCard`). Groups exist to bundle commands for one-tap
start/stop in the Run page; if you need strict dependency
sequencing for a bundle, model it as a single-lane stack instead.
`restartGroup` calls `stopGroup` first and awaits the corresponding
`waitForEntriesStopped` for every targeted active entry before
issuing the parallel restart.

### Lane overlay integration

`getLaneOverlay` runs `matchLaneOverlayPolicies` (from `laneOverlayMatcher`)
against the lane summary and the current effective config's
`laneOverlayPolicies`. The overlay can:

- restrict `processIds` (so some processes are disabled per lane)
- override `cwd`
- merge extra `env`
- override port ranges or proxy hostnames

`applyProcessFilter` applies the restricted id list before dependency
resolution. `startByDefinition` merges overlay `env` over definition
`env` after the base lane runtime env.

### Integration with PTY events

The service subscribes once each to `ptyService.onData` and
`ptyService.onExit` at construction:

- on `data`, it resolves `ptyToRunId.get(event.ptyId) ??
  sessionToRunId.get(event.sessionId)` into an entry, emits a
  `log` event carrying `runId`, and tests the log-regex readiness check.
- on `exit`, it resolves the same way and calls `handleProcessExit`.

It never calls `ptyService.write` — managed processes can't receive
stdin from the Run UI.

### Persistence

Two tables:

- `process_runtime` — one aggregate snapshot per `(project_id, lane_id,
  process_key)`. `persistAggregateRuntime` writes whichever run is the
  latest (newest `updatedAt / startedAt / endedAt`) so the persisted
  row mirrors the card the user sees in the Run page. If every entry
  for that `(lane, process)` falls out of memory, the row is deleted.
  On startup, any row left in an active status (`running`, `starting`,
  `stopping`, `degraded`) is normalized to `exited` with
  `ended_at = now`.
- `process_runs` — one row per invocation keyed by `runId`.
  `termination_reason` is `stopped`, `killed`, or `crashed`. `log_path`
  is the transcript path of the run's session (empty string if the PTY
  never opened before `handleStartFailure` wrote the row).

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
                 →  listener callback (processService uses this)

PTY exit         →  sessionService.end
                 →  scheduleTranscriptDependentWork
                 │     ├─ endTranscriptStream
                 │     ├─ backfillResumeTargetFromTranscriptBestEffort
                 │     └─ summarizeSessionBestEffort
                 └─ broadcastExit (ade.pty.exit)

processes.start  →  processService.startByDefinition
                 →  ptyService.create (toolType = "run-shell")
                 →  readiness timers, health timers, restart backoff
```

---

## Gotchas

- `ptyService.enrichSessions` (called from `registerIpc.sessionsList`)
  overlays live PTY attachment state onto rows returned from
  `sessionService.list`: `status`, `ptyId`, `endedAt`, `exitCode`,
  and `runtimeState`. Callers that bypass `registerIpc` must either run
  sessions through `enrichSessions` or explicitly reconcile live PTYs
  before trusting persisted lifecycle fields.
- `registerIpc.sessionsList` and `.sessionsGet` both lazily hydrate
  resume targets via `ptyService.ensureResumeTargets` for tracked,
  ended Claude/Codex rows whose `resumeMetadata.targetId` is blank.
  `sessionsList` caps the hydration batch at 10 IDs per call and
  swallows errors into `sessions.resume_target_hydration_failed`.
  If you add a new session-surfacing IPC, replicate that hydration
  or accept that freshly-ended sessions will show "no resume target"
  briefly.
- `processService.startByDefinition` creates the `ManagedProcessEntry`
  and emits `runtime` *before* the PTY is created, so the Run page's
  card flips to `starting` immediately. If the PTY spawn fails,
  `handleStartFailure` writes a `process_runs` row with
  `termination_reason = "crashed"` and then rethrows. If you swallow
  the throw, the UI still sees the crash.
- `listRuntime(laneId)` returns every in-memory entry for the lane —
  active runs *and* recent history (up to 20 per `(lane, process)`).
  Callers that only want live runs need to filter by
  `isProcessActive(status)` themselves.
- The `toolAutoCloseTimers` on the PTY side and the `healthInterval`
  on the process side both fire after a grace period; they can race on
  teardown. Always call `disposeAll()` last.
- Transcript paths for resumed sessions come from the existing row. If
  an old row references a deleted transcript file, `create` opens it
  in append mode and creates a new empty file — old history is gone.
- Resuming a session that is still attached to a live PTY no longer
  throws. `ptyService.create({ sessionId })` returns the existing
  attachment and re-syncs the session row when the DB status has
  drifted (e.g. a failed reconcile). The logged counter is
  `pty.resume_reused_live_attachment`.

---

## Cross-links

- UI surfaces: [ui-surfaces.md](./ui-surfaces.md)
- Lane-level isolation and worktree gating:
  [runtime-isolation.md](./runtime-isolation.md)
- Session deltas and end-of-session summaries:
  `apps/desktop/src/main/services/sessions/sessionDeltaService.ts`
- Configuration schema for `ProcessDefinition`, `StackButtonDefinition`,
  `LaneOverlayPolicy`:
  [../onboarding-and-settings/configuration-schema.md](../onboarding-and-settings/configuration-schema.md)
