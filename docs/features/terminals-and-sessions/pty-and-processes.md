# PTY, Sessions, and Managed Processes

Lifecycle and wiring for the three main-process services that back the
terminal/session system:

- `apps/desktop/src/main/services/pty/ptyService.ts`
- `apps/desktop/src/main/services/sessions/sessionService.ts`
- `apps/desktop/src/main/services/processes/processService.ts`

All three were rewritten on the current branch. The branch diff for
these files is 500+ lines inserted and 440+ removed; expect the wiring
in `main.ts` and `registerIpc.ts` to need a careful re-read before any
non-trivial change.

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
- Resume metadata is stored as a JSON blob. `normalizeResumeMetadata`
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
  `transcriptBytesWritten`, `transcriptLimitReached` (8 MB cap from
  `MAX_TRANSCRIPT_BYTES`)
- preview: `lastPreviewWriteAt`, `previewCurrentLine`,
  `latestPreviewLine`, `lastPreviewWritten`
- tool metadata: `toolTypeHint`, `resumeCommand`,
  `resumeCommandIsFallback`, `resumeScanBuffer`
- runtime state: `lastRuntimeSignalAt`, `lastRuntimeSignalState`,
  `lastRuntimeSignalPreview`
- AI title: `aiTitleTimer`, `cliUserTitleLineBuffer`,
  `cliUserTitleCommitted`
- teardown: `disposed`, `createdAt`, `cleanupPaths`

### Create flow (`create(args)`)

1. Resolve the lane worktree via `resolveLaneLaunchContext` — rejects
   requests that escape the lane root.
2. Validate the session ID if the caller is resuming an existing row:
   must exist, same lane, tracked, not already attached to a live PTY.
3. Generate `ptyId` + `sessionId` (reuses the row's `id` when resuming).
4. Resolve transcript path: reuses the existing row's path when
   resuming, otherwise `safeTranscriptPathFor(sessionId)` under the
   transcripts directory.
5. For Claude/Codex tool types, write a per-session ADE MCP config file
   under `.ade/mcp-configs/terminal-<sessionId>.json` and append
   `--mcp-config <path>` (Claude) or codex config flags to the startup
   command. The config file path goes into `cleanupPaths` for unlink on
   disposal.
6. Build initial `resumeMetadata` via `buildInitialResumeMetadata` —
   extracts a pre-assigned `--session-id <uuid>` from the Claude
   startup command when present.
7. Insert a new `terminal_sessions` row (or skip when resuming an
   existing one) and call `sessionService.create`. Set runtime state to
   `running`.
8. Best-effort capture of `headShaStart` via `computeHeadShaBestEffort`
   so `sessionDeltaService` has a git anchor.
9. Select a shell (`/bin/zsh`, `/bin/bash`, `/bin/sh`, or Windows
   equivalents) or spawn a direct command. Retries across candidates if
   the first spawn fails.
10. Write `args.startupCommand` to the PTY so the shell executes the
    CLI. Returns `{ ptyId, sessionId, pid }`.

### Data, preview, and runtime state

`writeTranscript(entry, data)` writes to the append-mode write stream.
Once the 8 MB cap is hit it writes a single notice line and drops
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

### AI-driven titles

Two paths, both gated by `sessionIntelligence.titles.enabled` and the
presence of an AI integration service in non-guest mode:

- **Output snippet title** (shell, run-shell, cursor, aider, continue):
  `aiTitleTimer` fires after 6 s, sends up to 800 chars of
  ANSI-stripped early output to `aiIntegrationService.summarizeTerminal`
  with a "max 80 chars, plain text" prompt.
- **CLI user title** (claude, codex): `tryCliUserTitleFromWrite`
  listens to PTY *writes* (keyboard input) and commits the first
  submitted prompt line (3 to 180 chars). This avoids the alt-screen
  noise of Claude/Codex TUIs. Skipped when the session is
  `manuallyNamed`.

At session close, when `refreshOnComplete` is enabled, the transcript
tail (last 2000 chars) is re-summarized into a final title through the
same service. Failure logs a warn and moves on — the title contract
never fails the session.

### Resume metadata backfill

`backfillResumeTargetFromTranscriptBestEffort` runs after the
transcript stream is finalized at close time. Tries, in order:

1. Scan the transcript tail with provider-specific regexes
   (`extractResumeCommandFromOutput`).
2. Read Claude's local storage: `~/.claude/projects/<escaped-cwd>/*.jsonl`,
   newest file modified in the last 5 minutes, filename is the session
   UUID.
3. Read Codex's rollout storage:
   `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, newest recent file
   whose `session_meta.payload.cwd` matches.

Any found ID updates the row's `resumeMetadata.targetId` through
`sessionService.updateMeta`. A resume command is always written even
without a target ID so the CLI can prompt interactively.

### Dispose and orphan disposal

`dispose({ ptyId, sessionId? })` kills the PTY (SIGHUP on POSIX), ends
the session row via `sessionService.end`, schedules transcript cleanup
work, and broadcasts a final `ptyExit` event.

Two forms of cleanup:

- `scheduleTranscriptDependentWork` — flush transcript stream, then
  backfill + summarize.
- `cleanupEntryPaths` — unlink `cleanupPaths` (per-session MCP config
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

Keyed by `laneId:processId`:

- `runtime`: `ProcessRuntime` (status, readiness, pid, ports, timing)
- `definition`: `ProcessDefinition | null`
- `runId`: UUID for the current `process_runs` row
- `stopIntent`: caller-supplied termination reason
- `sessionId` / `ptyId` / `transcriptPath`: the live PTY handle
- readiness: `readinessRegex`, `readinessTimeout`, `readinessInterval`
- health: `healthFailures`, `healthInterval`
- restart: `restartAttempts`

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
   (`stopped`, `killed`, `crashed`, `restart`).
2. Persists the `process_runs` row and emits runtime.
3. If the reason is `restart` (from `restart()`), schedules a 20 ms
   restart.
4. Otherwise, if the policy says restart, applies exponential backoff:
   `min(30_000, 400 * 2^(attempt-1))` + up to 250 ms jitter. Resets
   `restartAttempts` if the process ran longer than 60 s before dying.

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

- on `data`, it looks up the entry via `sessionId`/`ptyId`, emits a
  `log` event, and tests the log-regex readiness check.
- on `exit`, it calls `handleProcessExit`.

It never calls `ptyService.write` — managed processes can't receive
stdin from the Run UI.

### Persistence

Two tables:

- `process_runtime` — current snapshot per `(project_id, lane_id,
  process_key)`. On startup, any row left in an active status
  (`running`, `starting`, `stopping`, `degraded`) is normalized to
  `exited` with `ended_at = now`.
- `process_runs` — one row per invocation. `termination_reason` is
  `stopped`, `killed`, `crashed`, or `restart`.

---

## Data flow summary

```
renderer pty.create  →  ade.pty.create (registerIpc)
                          ↓
                      ptyService.create
                      ├─→ resolveLaneLaunchContext (lane gate)
                      ├─→ sessionService.create (new row)
                      ├─→ writeExternalClaudeMcpConfig (Claude/Codex)
                      ├─→ loadPty().spawn
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

## Gotchas specific to the branch rewrite

- `ptyService.enrichSessions` (called from `registerIpc.sessionsList`)
  overlays live runtime state onto rows returned from
  `sessionService.list`. Callers that bypass `registerIpc` must either
  run sessions through `enrichSessions` or explicitly derive
  `runtimeState` from `status`.
- `processService.startByDefinition` locks the runtime to
  `starting` *before* the PTY is created. A spawn failure path runs
  `handleProcessStartFailure`, which writes a `process_runs` row with
  `termination_reason = "crashed"` and then rethrows. If you swallow
  the throw, the UI will still see the crash.
- The `toolAutoCloseTimers` on the PTY side and the `healthInterval`
  on the process side both fire after a grace period; they can race on
  teardown. Always call `disposeAll()` last.
- Transcript paths for resumed sessions come from the existing row. If
  an old row references a deleted transcript file, `create` opens it
  in append mode and creates a new empty file — old history is gone.
- Handlers in `registerIpc.ts` lines 3913-3983 and 4219-4240 are the
  canonical surface for renderer calls; add new behavior there rather
  than in `main.ts`.

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
