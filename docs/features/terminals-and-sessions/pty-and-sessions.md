# PTY and sessions

Lifecycle and wiring for the two services that back the terminal/session system:

- `apps/desktop/src/main/services/pty/ptyService.ts`
- `apps/desktop/src/main/services/sessions/sessionService.ts`

These services run inside the **active ADE runtime** (local machine runtime for
local-bound windows, SSH-attached remote runtime for remote-bound
windows). The same source files are also loaded by the desktop main
process for tests, diagnostics, and flows without a runtime binding;
runtime-bound project work is not retried against desktop-local
handlers after a daemon failure. PTY data and exit events flow over the runtime's
event stream and the renderer subscribes via the preload runtime event
pump. Remote-bound windows therefore have their PTYs spawn on the
remote machine — `node-pty` runs on the remote host, the bytes stream
back over SSH, on the remote host.

Both services carry cross-wiring through the ADE runtime's project boot and `registerIpc.ts`. Re-read them before any non-trivial change.

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
- ownership: `owner_pid`, `owner_process_started_at`

`mapRow()` converts the row into `TerminalSessionSummary` /
`TerminalSessionDetail`. It parses `resumeMetadata` through
`normalizeResumeMetadata` (handles legacy `target` vs modern `targetId` and
retains optional `orchestrationParentSessionId` / `spawnKind`), then derives
`resumeCommand` via `deriveResumeMetadataCommand` so downstream code always
sees a normalized command even for old rows. For tracked agent CLI tool types,
`mapRow()` also projects those lineage fields onto the session summary; shell
and other terminal rows do not acquire lineage from resume metadata.

### Exported methods

- `list({ laneId?, status?, limit? })` — returns up to 200 rows by
  default, ordered by `started_at desc`.
- `get(sessionId)` — single row with `TerminalSessionDetail`.
- `create({ sessionId, laneId, ptyId, tracked, title, startedAt,
  transcriptPath, toolType?, resumeCommand?, resumeMetadata?,
  ownerPid?, ownerProcessStartedAt? })` —
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
- `reconcileStaleRunningSessions({ endedAt?, status?, excludeToolTypes?,
  liveOwnerPids?, liveOwnerIdentities?, knownOwnerPids?,
  knownOwnerIdentities? })` — on-startup cleanup. Runtime callers pass
  both live and known process identities from the local
  `runtime_processes` table. That lets ADE detach sessions owned by a
  crashed local process without rewriting a still-running session that
  arrived through sync from another machine.
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
  shape (plus optional `orchestrationParentSessionId` / `spawnKind`) and legacy
  fields (`target`, `permissionMode` at the top level). `setResumeCommand`
  merges parsed target data into the existing metadata so the two lineage
  fields survive a resume-target refresh.
- `runtime_processes` is machine-local bookkeeping, not replicated
  project state. It is excluded from CRR setup; synced terminal rows may
  describe sessions owned by another machine, and local reconcile must
  treat unknown owner identities as remote rather than dead.

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
  `transcriptBytesWritten` (lifetime logical UTF-8 end),
  `transcriptBaseOffset` (logical byte represented by physical byte zero),
  `transcriptRetainedBytes`, rollover state/promise/pending chunks, and
  `transcriptWriteDisabled` for a real write failure. The retained file has a
  16 MiB ceiling; output itself is not capped.
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
    was disposed in the meantime. When `awaitInitialInput` is false, a
    readiness/write failure is logged and the PTY is preserved; ADE no
    longer kills or ends the session just because the first input could
    not be delivered. When a caller explicitly sets `awaitInitialInput`,
    readiness/write failure is treated as startup failure: the process
    tree is terminated and the session is ended as `failed`. Returns
    `{ ptyId, sessionId, pid }`.

The launch env is built layer by layer: `process.env`, the lane
runtime env (from `getLaneRuntimeEnv`), the caller's `args.env`, then
`withAdeTerminalContextEnv` (project / lane / chat ids plus the opaque,
chat-bound `ADE_BROWSER_ACTOR_TOKEN` when the terminal has an owner), then
`withInteractiveTerminalColorEnv`. The color helper sets a sensible
`TERM` (`xterm-256color`) and `COLORTERM` (`truecolor`) when missing
and unsets `NO_COLOR` so TUIs render in color by default. If the
caller or the lane env explicitly set `NO_COLOR`, the helper is called
with `preserveNoColor: true` and leaves it alone. Without this, a
user-global `NO_COLOR=1` would silently break Claude / Codex /
OpenCode rendering inside Work tabs.

### Data, preview, and runtime state

`writeTranscript(entry, data)` advances `transcriptBytesWritten`
synchronously, then writes to the append stream. When the retained physical
file plus the next chunk would exceed `MAX_TRANSCRIPT_BYTES` (16 MiB), the
service pauses the PTY when supported, closes/flushed the stream, and atomically
replaces the file with a UTF-8-safe recent window: up to an 8 MiB old-file tail
plus the triggering/output-during-rollover chunks, always bounded to 16 MiB.
It then reopens append and resumes the PTY. A backend that cannot pause keeps a
bounded pending tail; if callbacks exceed that bound, the older pending/file
portion is deliberately dropped so the retained range remains contiguous.

Rollover is crash-recoverable. `<transcript>.rollover.pending.json` describes
the old and new generations, `<transcript>.rollover.previous` is the atomic
backup, temporary files are same-directory, and the completed
`<transcript>.rollover.json` records `baseOffset` and retained size. Attach
reconciles an interrupted transaction before reopening append. The logical end
is seeded as `baseOffset + retainedBytes`, so it remains monotonic across
resume even though physical byte zero advances.

That logical end is the mobile/web cursor: each batched PTY data event carries
`offset` after the batch (null only when the session is untracked/has no
transcript or transcript writing failed). The transcript write and data-batch
enqueue run in the same `onData` handler, so rollover never rewinds live
offsets. The fs.WriteStream can still lag by a few ms.

`getTranscriptWindow(sessionId)` returns the retained logical
`[startOffset, endOffset)` range. `readTranscriptSnapshot` merges the flushed
range with the bounded live output tail and returns one exact contiguous suffix
through the in-memory logical end, which is the sync snapshot barrier's
authoritative capture. `readTranscriptRange({ sessionId, startOffset,
endOffset })` clamps requested logical offsets to the retained window and
reports the achieved range; optional safe-boundary alignment scans forward to
a newline/ESC and both ends avoid UTF-8 continuation bytes. Callers must not
derive logical offsets from the current file size.

Resize ownership: the ptyId-based `resize(...)` path (desktop
renderer) records `lastDesktopCols/Rows` on the entry;
`resizeBySessionId(..., { source: "mobile" })` does not.
`restoreDesktopSizeBySessionId(sessionId)` puts the PTY back to the
recorded desktop size — the sync host calls it when the last
subscribed phone detaches, so a phone-fitted 45-column reflow doesn't
linger on desktop.

`updatePreviewThrottled` uses `derivePreviewFromChunk` to track the last
non-empty line, capped at 220 chars. Preview is flushed to
`sessionService.setLastOutputPreview` at most every 900 ms.

`emitRuntimeSignalThrottled` fires `onSessionRuntimeSignal` when the
runtime state changes, when the preview changes more than 1.2 s after
the previous signal, or as a 10 s heartbeat. Runtime states:
`running`, `waiting-input`, `idle`, `exited`, `killed`. `idle` is
inferred from output silence. OSC 133 `B`/`C` markers may confirm running, but
prompt markers never infer `waiting-input`; only explicit or
provider-structured lifecycle requests raise attention.

### Process tree termination

`terminatePtyProcessTree(entry, signal, logger)` replaces the older
single-process `entry.pty.kill(signal)` call. On POSIX, node-pty's
`forkpty(3)` child is normally its own session and process-group leader, so
the service first signals that process group directly. In parallel it runs a
bounded asynchronous `ps` scan (PID, parent PID, process group, and foreground
process group) to include descendants and groups that a shell or foreground job
created after launch. The initial signal is never held behind that scan: a
100 ms fallback sends it if the scan is slow, and the scan itself is capped at
250 ms. For a non-`SIGKILL` signal, the 1.5 s follow-up rescans using the
known groups and sends `SIGKILL` to anything still reachable. If that final
scan cannot complete, ADE force-kills the known PTY/root groups and initial
members rather than treating scan failure as proof that the tree exited.

Windows first uses node-pty's normal kill path and, if the root still exists
after the same grace period, uses bounded `taskkill /T /F` as the tree fallback.
This keeps termination off the main thread's former synchronous recursive
`pgrep` path while ensuring a `SIGTERM` on a tracked agent CLI also reaches
language servers, dev servers, and other child processes instead of leaving
them orphaned.

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
`ptyService.resizeBySessionId(sessionId, cols, rows)` are the runtime-side
entry points for controller devices that know the ADE session id but not
the current in-memory `ptyId`. Both scan the live PTY map for an
undisposed entry matching the session id and return `false` when the
session row exists but no PTY is currently attached.

`writeBySessionId` forwards raw bytes into the PTY, runs the same
CLI-user-title sniffing used by local terminal writes, marks runtime
state `running`, and schedules the idle transition. `resizeBySessionId`
clamps the requested dimensions with the normal PTY dimension guard
before calling `pty.resize`.

The sync service only calls these methods after the peer has subscribed to
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
`agentChatService.hasRetainableSessions()`) so a project context with running CLIs / agents / shells is
never evicted by the warm-idle cap.

### Resource-pressure attribution

`ptyService.getResourceAttribution()` returns the live PTY roots for the
TopBar resource-pressure indicator: `{ activePtyCount, roots }` where each
root is `{ pid, kind }` and `kind` is derived from the entry's
`toolTypeHint` (`shell` → `"shell"`, `other` → `"unknown"`,
any recognized provider CLI → `"provider-agent"`). It only carries the PIDs
and their spawn-metadata role — it no longer samples `ps` or aggregates CPU
/ memory itself. The actual machine sampling and per-role aggregation live in
`resourceUsageSampling.ts` (see below), which the `ade.app.getResourceUsage`
IPC handler drives.

The sampler in
`apps/desktop/src/main/services/pty/resourceUsageSampling.ts` has three
pieces:

- **Coalesced `ps` collector** (`createProcessMetricRowsCollector`) — spawns
  `ps -axo pid=,ppid=,pcpu=,rss=` asynchronously with a 1 s timeout and a
  2 MB stdout bound, coalescing all concurrent callers onto one in-flight
  child and never rejecting (it resolves an `unavailable` sample with a
  `timeout` / `spawn-error` / `exit-code` / `oversized-output` reason
  instead). A single process-wide collector is created lazily in
  `registerIpc.ts` and disposed on `will-quit`, so a slow or failing `ps`
  never blocks Electron main.
- **Disjoint role classification** (`classifyProcessRoles`) — assigns every
  sampled PID to at most one `AppResourceProcessRole`. Electron PIDs
  (main/renderer/helper, plus `process.pid`) are claimed first and excluded
  from every tree walk. Then ADE-runtime roots, ADE PTY-host owner PIDs, and
  the desktop-owned PTY roots (with their explicit `provider-agent` /
  `shell` / `unknown` kind) are claimed before any descendant walk, so an
  explicit identity always wins over inheritance. Descendant inference is
  deliberately conservative: only a `provider-agent` root's descendants stay
  `provider-agent` (helpers belong to the agent); shells, ADE runtimes, and
  PTY hosts propagate `unknown` to their children because they can host
  arbitrary work. The classifier also returns the legacy aggregate
  `PtyProcessResourceUsageSnapshot` over the same non-Electron tree.
- **Snapshot assembly** (`computeAppResourceUsageSnapshot`) — folds the
  Electron `getAppMetrics()` buckets and system memory together with the
  classified role usage into an `AppResourceUsageSnapshot`. It skips the
  `ps` sample entirely when nothing is active (no roots and
  `activePtyCount === 0`), recording `processSample.status = "skipped"` with
  reason `idle`. The result carries optional `roleUsage[]` (per-role process
  count / CPU / summed-RSS memory) and `processSample` (sample availability
  and staleness); both are absent on legacy synced peers, so consumers must
  tolerate their absence.

`registerIpc.ts`'s `ade.app.getResourceUsage` handler is async with a 900 ms
cache (`APP_RESOURCE_USAGE_CACHE_MS`) plus in-flight coalescing keyed by the
context set, so every window/project shares one sample. The renderer's
`resourcePressure.ts` groups the roles into "ADE app" (Electron +
`ade-runtime` + `ade-pty-host`), "agents" (`provider-agent`), and "other
terminal processes" (`shell` + `unknown`) for the indicator description, and
appends a staleness note when `processSample.status === "unavailable"`. The
numeric pressure thresholds are unchanged; only the attribution and the
description text changed.

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
   `providerFromTool(toolType)`. If a Claude/Codex/Droid/OpenCode row
   has no concrete target yet, the service runs the same on-demand
   resume-target backfill used by `ensureResumeTargets`; Codex can scan
   rollout storage during this resume-launch path before ADE reports a
   missing target.
3. Rebuild the resume command via
   `buildTrackedCliResumeCommand(metadata, overrides)` — runtime
   `model` / `reasoningEffort` / `permissionMode` overrides flow into
   the command line so the continuation honours the user's current
   model picker. For the first ended-session continuation with
   structured `resumeMetadata`, `text` is also passed as the provider
   prompt argument, except for Cursor where ADE waits for the interactive
   prompt and writes the text through PTY input.
4. De-duplicate concurrent sends through `resumeRuntimeFlights` (one
   in-flight continuation per session id) so rapid sends do not spawn
   parallel PTYs against the same row.
5. Spawn the continuation through `service.create({ sessionId, ... })`
   in the same row. When the row has structured `resumeMetadata` and
   no other resume flight is already running, the prompt is included in
   the provider resume command and no follow-up PTY write is attempted.
   Cursor is the exception: its continuation command stays prompt-free,
   then the text is submitted after the resumed CLI is input-ready.
   OpenCode uses its replay-resume command when the installed CLI
   supports it. If the code has to reuse an already-started resume
   flight, it writes `text` after the PTY is attached. The return shape
   is `{ ptyId, sessionId, pid, session, resumed: true,
   reusedExistingRuntime: false }`.

Failed post-resume writes log `pty.resume_send_input_failed_preserved`
and throw `Terminal session '<id>' could not receive the message.`;
the resumed PTY is intentionally left running so the user can inspect
or retry from the visible terminal.

### Prompt-free resume (`resumeSession`)

`ptyService.resumeSession({ sessionId, cols?, rows?, model?,
reasoningEffort?, permissionMode? })` is the sibling entry point for
"open this ended agent CLI session again without sending a new
message."

The validation and resume-target rules match `sendToSession`: the row
must be a tracked agent CLI session, a concrete provider resume target
must exist, and Codex update-only transcripts produce the explicit
"start a new Codex session" error. If a live PTY is already attached,
the call returns it with `resumed: false` and
`reusedExistingRuntime: true`. Otherwise it rebuilds the provider
resume command with the optional model / reasoning / permission
overrides, launches a new PTY in the existing row, and returns
`resumed: true`. No prompt is appended and no agent CLI input write is
performed.

The renderer's Work continuation composer, the iOS Work tab's
"continue" path (`work.sendToSession` remote command), and the TUI's
`send_to_session` JSON-RPC tool all go through `sendToSession`.

Durable scheduled work uses this same delivery boundary for tracked provider
CLI sessions. `chat.createScheduledWork` may target only an ADE-tracked agent
chat or provider CLI owned by the caller. A live CLI becomes eligible only when
the PTY service sees that provider's visible composer marker after a short quiet
window; the generic 12.5-second no-output state is not sufficient because a
model may be silently thinking. An ended CLI is resumed through
`sendToSession`. A proven pre-delivery failure restores the occurrence and
retries instead of advancing it, while an ambiguous partial-write failure keeps
the at-most-once behavior. Untracked shells are rejected.

### Agent CLI input protocol

Live `sendToSession` text submissions, post-resume sends that could
not be embedded in the launch command, and `initialInput` writes from
`create` go through a structured input protocol instead of a raw
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

For fresh `initialInput` writes, ADE still waits up to
`AGENT_CLI_READY_TIMEOUT_MS = 20 s` for the provider TUI to produce
output and settle before writing. Ended-session continuations avoid
that readiness race by passing the first follow-up prompt as a resume
command argument whenever structured resume metadata is available.

### AI-driven titles

Three paths, all gated by `sessionIntelligence.titles.enabled` and the
presence of an AI integration service in non-guest mode (except the
Claude runtime-title capture, which is free):

- **Output snippet title** (shell, cursor, aider, continue):
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
  provider slash commands, sentence-cases). The AI title call no longer
  fires immediately: `runEarlyCliAiTitle` is deferred by
  `EARLY_CLI_AI_TITLE_DELAY_MS` (5 s) so a slice of the session's actual
  output exists to summarize. It feeds the seed **plus** the
  ANSI-stripped `recentOutputTail` (last ~4000 chars) to the model, so
  the title reflects what the session is doing ("Inspect GitHub login
  screenshot") rather than echoing the opening line ("Take a look at …").
  The deterministic fallback shows until then, the early pass never
  overwrites a user rename, and the on-complete pass refines it later.
  The timer is stored on `entry.aiTitleTimer` (unref'd) and cleared on
  dispose. AI title calls use `PTY_AI_TITLE_TIMEOUT_MS` (60 s) since
  slower local models were timing out at the prior 8 s budget.

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
fire on the `close` / `dispose` reasons and explicit on-demand
continuation paths, not on `session-list`, so renderer list refreshes
don't spawn a `spawnSync` or hit external storage on every render.

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
backfill runs under: `"close"` and `"dispose"` consult
`~/.codex/sessions` with the 10-minute drift window; `"session-list"`
skips the storage lookup entirely; `"resume-launch"` is allowed to use
the storage lookup because the user is actively trying to continue that
specific session. Lazy hydration over `sessions.list` therefore relies
only on transcript regex matches, keeping the list-render hot path off
the disk and preventing one renderer's idle refresh from adopting
another lane's Codex rollout. Live Codex sessions still get their
resume target through the live capture path, which uses the strict
`requiredText: "ADE session guidance"` gate.

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

Returning to a `waiting-input` runtime state does not auto-close a PTY.
The user, owning service, or worker orchestration layer must call
`dispose` explicitly when a terminal should close.

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
