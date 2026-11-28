# PTY and sessions

The two services behind terminals and sessions:

- `apps/desktop/src/main/services/pty/ptyService.ts`
- `apps/desktop/src/main/services/sessions/sessionService.ts`

Both run in the active runtime (local brain, or the remote host where
`node-pty` runs and bytes stream back). Desktop loads them only for tests,
diagnostics and unbound flows. They are cross-wired through the runtime's
project boot and `registerIpc.ts`; read both before a non-trivial change.

A window receives output only for the terminals it shows: main keeps the list
(`ptyDataSubscriptions.ts`, fed by `pty.setDataSubscriptions`) and sends it to
a remote brain as `ptyDataIds`; a brain that announces `ptyDataFilter` skips
`pty_data` for other terminals. A terminal that comes back re-reads its screen
after the new list applies, so nothing printed in between is lost.

## `sessionService`

The one source of truth for `terminal_sessions` rows. Pure persistence: it
spawns and streams nothing.

- `mapRow()` normalizes `resumeMetadata` (`{ provider, targetKind, targetId, launch }` plus lineage; legacy `target` accepted) and derives `resumeCommand`.
- `list` (200 newest by default; `settledLimit` caps settled rows), `get`, `create` (a `running` row), `updateMeta` (recomputes the resume command when its inputs change), `end` (nulls `pty_id`), `deleteSession` (emits `reason: "deleted"`).
- `reattach` resets a row to `running` for a resume, keeping identity, lane, transcript and metadata.
- `reopen` (from any non-running status) and `repairStaleDetachOnActivity` (from `detached` only, called by the activity writers `setLastOutputPreview` / `touchSessionActivity`). See [Stale-detached repair](README.md#stale-detached-repair).
- `reconcileStaleRunningSessions` takes live and known owner identities from the machine-local `runtime_processes` table: a crashed local owner's rows detach; an unknown owner (another machine) is kept. Fresh rows get a 2-minute grace (`STALE_RUNNING_SESSION_FRESH_ACTIVITY_GRACE_MS`).
- `onChanged` fires from `updateMeta` and `deleteSession`, never on create or end (`ptyService` broadcasts those).
- `manuallyNamed` stops automatic titles; **Name & status** is an explicit user command that can still replace it.

## `ptyService`

Owns `node-pty` instances, transcripts, runtime state and titles. Each live
PTY has a `PtyEntry` in the `ptys` map. Tracked PTYs also mirror output into an
`@xterm/headless` terminal whose serialized snapshot goes to
`.ade/cache/terminal-snapshots/<sessionId>.json` (5 s debounce, flushed on
exit, resize and every `terminal.preview`), so the phone and `daex terminal
preview` get a real buffer.

### Create flow (`create(args)`)

1. Resolve the lane cwd with `resolveLaneLaunchContext`; a path outside the lane is refused.
2. With a caller `sessionId`: a missing row is a new session; an existing row must be the same lane and tracked; a row already on a live PTY is reused with no spawn (repeated resume clicks are idempotent).
3. Transcript path from the row on resume, else `safeTranscriptPathFor(sessionId)`. Build `resumeMetadata` (`buildInitialResumeMetadata` reads a pre-assigned session id) and record the launch model.
4. Insert or keep the row as `running`; stamp the owner; capture `headShaStart`.
5. **Swap in DAEX's pinned CLI** (`pty/pinnedProviderCli.ts`): every provider terminal runs DAEX's pinned copy by absolute path, never the one on PATH. It is one late swap, so every parser sees bare words, and the swapped line is never persisted. Self-update switches are disabled. While the pin downloads, the PTY shows a clean shell with a message, holds initial input and types the launch when ready. A plain shell with no command is untouched.
6. Launch: explicit argv from `buildTrackedCliLaunchCommand` spawns directly (shell fallback on failure); otherwise shell candidates. Command-backed and provider shells use `resolveShellCandidates("clean")` (no rc files). Windows continuations use the structured descriptor, never the stored display string.
7. A shell gets `args.startupCommand` typed after `startupDelayMs` (clamped 0–1000 ms; Work uses 180 ms).
8. `initialInput` goes through the [agent CLI input protocol](#agent-cli-input-protocol) after the provider's composer is visible and stable for 600 ms (deadline 60 s for Codex, 20 s for others). A user write cancels a deferred prompt. With `awaitInitialInput`, a readiness failure kills the tree and ends the row `failed`.

**Claude plugin dir.** `withBundledClaudePlugin` adds `--plugin-dir` right
after the `claude` token (in argv for a direct spawn, inside the `-c` line for
a shell-wrapped one). Never put Claude flags in a shell's argv: bash reads
`--plugin-dir` as its own option and exits.

**Launch env.** `process.env` → lane runtime env → caller env, then
`stripHostRuntimeEnv` (drops the host's own keys and its multiplexer: `TMUX`,
`STY`, `ZELLIJ*`, so `tmux split-window` does not act on the user's session),
`withAdeTerminalContextEnv`, and `withInteractiveTerminalColorEnv` (sets
`TERM`/`COLORTERM`, unsets a user-global `NO_COLOR`).

### Transcripts and offsets

- `writeTranscript` advances `transcriptBytesWritten` (a lifetime logical byte cursor) synchronously. Past 16 MiB (`MAX_TRANSCRIPT_BYTES`) it pauses the PTY, atomically keeps a UTF-8-safe recent window (≤ 8 MiB tail plus new data) and resumes. Rollover is crash-safe (`.rollover.pending.json`, `.rollover.previous`, `.rollover.json` with `baseOffset`).
- Each PTY data batch carries the logical end `offset`; rollover never rewinds it. `getTranscriptWindow`, `readTranscriptSnapshot` and `readTranscriptRange` work in logical offsets. Never derive an offset from file size.
- **Resize ownership.** Desktop resizes record `lastDesktopCols/Rows`; a mobile resize sets `mobileViewportActive`; `restoreDesktopSizeBySessionId` restores when the last phone detaches. `readScreenSnapshot` returns the current screen for mobile and web.
- Preview: last non-empty line, ≤ 220 chars, written at most every 900 ms.
- `resyncLiveSessionRowIfNeeded` (≤ 1/s on data) puts a row that drifted to ended back to `running` and rebinds a wrong `pty_id`.
- `writeBySessionId` / `resizeBySessionId` serve controllers that know only the session id; sync calls them only after the peer subscribed to that session.

### Exact turn status for agent CLIs

DAEX does not guess the turn of a CLI that reports it. Each entry holds a turn
tracker (`PtyEntry.cliTurn`, `pty/cliTurnSignals.ts`) with phase `working`,
`idle` or `needs-input`, read by the runtime state, the Work row,
`daex chat status` (`getCliTurnStatus`), settle and the roster.

| CLI | working | done | needs you |
| --- | --- | --- | --- |
| Claude Code | `UserPromptSubmit` hook | `Stop` / `StopFailure` (background work while `SubagentStart` agents lack a `SubagentStop`) | `PermissionRequest` hook, `Notification` `permission_prompt` / `elicitation_dialog`, `Elicitation` |
| Codex 0.167+ | OSC `7501;state=working`, or a launch that carries the prompt | `state=done`, or `idle` after working | `state=blocked` (`kind=permission`) |
| Others | output (heuristic) | 12.5 s of quiet (heuristic) | the Jev screen check, `daex chat ask` |

- **Claude hooks.** A tracked Claude launch gets `--settings` with DAEX's hooks (merged into inline `--settings` JSON; a settings *file* is left alone and keeps heuristics). Hooks are exec form (`ADE_CLI_PATH __ade-cli-turn-hook claude <id>`, async), so a Windows `.cmd` shim gets none. `apps/ade-cli/src/cliTurnHook.ts` sends only event metadata (never the transcript path or message) to `session.reportCliTurnSignal`, never starts a brain, and exits within 5 s. A per-launch `ADE_CLI_TURN_HOOK_TOKEN` rejects reports from other CLIs.
- **Claude's gaps.** No hook for an interrupt: 2.5 s of quiet after Esc/Ctrl-C ends the turn; 12.5 s of quiet while working ends a missed turn; a menu key answers `needs-input`.
- **Background agents.** `SubagentStart` / `SubagentStop` keep ids in `PtyEntry.cliSubagents` (the last 64 stopped ids drop late starts). While non-empty the row reads background work. A lost stop has no timer; the row goes Stale after `SESSION_STALE_AFTER_MS`.
- **Exact signals win.** After the first hook or OSC 7501 report, output no longer flips the row to running and the quiet rule no longer ends a Codex turn.
- **Planned stop** (`disposeAll({ reopenAfterRestart: true })`) records a CLI as owed a continue from the exact signal, live Claude background agents (≤ 2 h, `CLI_SUBAGENT_LIVE_MAX_AGE_MS`), or the screen guess. A pending permission prompt is never mid-turn.
- **Needs you.** Entering `needs-input` raises a `cli_prompt` hand with the CLI's words through the same path as `daex chat ask`; an agent's own ask is never overwritten.
- `onTrackedCliTurnStarted` / `onTrackedCliTurnEnded` fire on transitions only.

Other providers' CLIs (Cursor, Droid, OpenCode, Pi, Muse, Qwen, Kimi, Grok,
Copilot, Devin, Antigravity) use the heuristic row.

**Activity detail** (`planning`, `exploring`, `implementing`, `testing`,
`debugging`, `reviewing`, `shipping`, `monitoring`) is separate from the phase.
Tracked CLIs have no tool stream, so only agent reports (`daex chat activity`,
scoped by `ADE_ACTIVITY_SESSION_ID`) set it. Guidance asks for reports from
Codex and OpenCode outside Plan, write-capable Droid, Pi full-auto, and Cursor
with an initial prompt; never Claude, Qwen, Kimi, Grok or Copilot.

### Process tree termination

`terminatePtyProcessTree`:

- **POSIX.** Signal the process group first (`signalProcessGroup` refuses pid < 2, since `kill(-1)` hits every user process). A bounded `ps` scan finds descendants; a non-`SIGKILL` signal is followed by `SIGKILL` after 1.5 s. A failed scan is not proof the tree exited.
- **Windows.** `taskkill /T`, then node-pty's kill, then always `taskkill /T /F` after the grace.

### Chat-CLI auto-reattach

`reattachChatCli({ chatSessionId })` restarts a chat-CLI session (`cursor` and
`*-chat` tool types except `pi-chat`) in the same row, one flight per chat.
`writeTerminal` reattaches only when the caller passed no `ptyId`. An SDK
chat's `chat:<provider>` marker is refused, never run. Any other "no live PTY"
case throws, so a stopped shell or App Control never comes back.

### Resource-pressure attribution

`ptyService.getResourceAttribution()` returns `{ activePtyCount, roots }`
without sampling. `pty/resourceUsageSampling.ts` samples:
`createProcessMetricRowsCollector` runs one bounded `ps` (1 s, 2 MB) shared by
callers and never rejects; `classifyProcessRoles` gives each pid one role
(Electron, `ade-runtime`, `ade-pty-host`, `provider-agent`, `shell`,
`unknown`); with nothing active it skips `ps`. `ade.app.getResourceUsage`
caches 900 ms and may reuse the last `ps` for 10–30 s while trees are far
below pressure lines; Settings › Health asks `fresh: true`.

### Send-or-continue (`sendToSession`)

1. A live PTY gets the text through the input protocol.
2. Otherwise the row must be a tracked agent CLI. A missing target runs the on-demand backfill (`ensureResumeTargets`).
3. `buildTrackedCliResumeLaunchCommand` rebuilds the launch with model / effort / permission overrides (saved on `resumeMetadata.launch`).
4. One continuation per session (`resumeRuntimeFlights`). When the builder can carry the prompt, the text rides on the resume command; otherwise it is written once the CLI is input-ready.

A failed write after resume throws but keeps the PTY running. The Work
composer, iOS `work.sendToSession` and the `send_to_session` tool use it.
Scheduled work uses the same boundary: a live CLI is eligible only when its
composer shows after a quiet window (`canAcceptScheduledTurn`).

`resumeSession` is the prompt-free form. `chat/agentCliSessionActions.ts`
adds `interruptAgentCli` (the cancel key without ending the process),
`restartAgentCli` (relaunch on the same conversation, refusing settings the
resume command cannot carry) and `regenerateAgentCliTitle`. See
[Talking to an agent CLI session](../chat/README.md#talking-to-an-agent-cli-session).

### Agent CLI input protocol

Never a raw `pty.write(text + "\r")`:

1. `Ctrl-U` + `Ctrl-E` clear partial input.
2. Bracketed paste (`ESC[200~…ESC[201~`).
3. 64-byte chunks, 5 ms apart.
4. `\r` after the provider delay (25 ms default, Codex 180 ms, Cursor 500 ms).

`typeLineIntoAgentCli` (`chat.typeIntoCli` with `when: "now"`) is kept for
older clients: no line clear, no readiness wait; it joins the same
`submitInputFlights` chain, and a repeated `clientMessageId` types once.

### AI-driven titles

CLI sessions are DAEX-named with one model: the provider's cheap helper for
Claude, Codex and Cursor CLIs, else the launch model. On failure the
deterministic title stays. Provider-written titles (Claude `ai-title`, Codex
thread names) never win.

- Shells and non-agent terminals: after 6 s, up to 800 chars of output are summarized.
- Agent CLIs (`CLI_USER_TITLE_TOOL_TYPES`: claude, codex, cursor-cli, droid, opencode, pi, muse): the first submitted line becomes a seed title at once, then after 5 s an AI title from the seed plus recent output. Never overwrites a rename.
- At close, the transcript tail gets a final title. There is no AI end-of-session summary.

### Continuation metadata backfill

`tryBackfillResumeTarget` runs at close and on demand
(`ensureResumeTargets`). Provider stores resolve through
`services/shared/providerConfigHomes.ts` (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
`FACTORY_HOME_OVERRIDE`), never a hard-coded `~/.codex`.

Strategies: transcript regexes for resume flags; Claude project JSONL (newest
in 5 minutes, start/end skew checks); Codex rollouts scored by cwd and start
time, excluding ids other rows own; Droid sessions by cwd; DAEX's own OpenCode
store (never `opencode session list`), matching realpath-folded directories.
Every strategy needs an exact cwd from `resolveSessionRunCwd`. A
`"session-list"` reason reads no storage, so a list refresh never adopts
another lane's rollout.

### Live Codex session-id capture

Codex has no pre-assigned-id flag. `scheduleCodexSessionIdCaptureBestEffort`
watches today's and tomorrow's rollout folders plus fallback scans, for up to
60 s, and matches by cwd within 90 s of start, excluding ids other rows own.
On capture it writes the target and appends an `ade-<sessionId>` thread name to
`<codexConfigHome>/session_index.jsonl`, so `codex resume ade-<id>` works.

### Pi session tracking

Pi shares its store with DAEX chat (`piSessionStoreForEnvironment`; see
[Agent Routing › Session store](../chat/agent-routing.md#session-store)).

- **Never resume Pi by "most recent."** `defaultResumeCommandForTool("pi")` is null; rebuilt launches strip `--continue`, `-c` and `-r`. A user-typed continue resolves to a concrete id before the spawn.
- `piSessionCouldBelongToTerminal` rejects a stored target created before the terminal; the launch then clears both `resumeCommand` and `resumeMetadata` and starts fresh.
- `selectPiStorageSessionCandidate` requires an exact header cwd and scores creation time only; candidates owned by another writer are skipped.
- `recordPiSessionOwner` writes the `.ade-owner` claim only after the lease upgrade wins (the sidecar is never deleted).
- Pi's initial input waits for output silence (≤ 15 s), not a clock.

### Dispose

`dispose` kills the tree (`SIGTERM`, then `SIGKILL` after the grace), ends the
row, flushes the transcript, backfills and titles, and unlinks `cleanupPaths`.
A `waiting-input` state never closes a PTY.

A resume that exits nonzero within 5 s (`RESUME_LAUNCH_FAILURE_WINDOW_MS`: a
bad flag, a missing binary) restores the row's prior end state (`detached`,
`completed` or `failed`; never `running`) instead of marking it `failed`.

## Gotchas

- `ptyService.enrichSessions` overlays live PTY state (`status`, `ptyId`, `runtimeState`, background agents) on rows. A caller that bypasses `registerIpc` must enrich before trusting those fields.
- `sessionsList` / `sessionsGet` hydrate blank resume targets for ended Claude/Codex rows (≤ 10 per list). A new session read must do the same.
- A resumed session whose transcript file was deleted starts a new empty one; the old history is gone.
- `hasLiveSessions()` keeps a project with running terminals from warm-idle eviction (`hasActiveProjectWorkloads` in `main.ts`).

## Activity detection

`chat/sessionActivityDetector.ts` reads every normalized chat event
(`tool_call`, `command`, `file_change`, `subagent_started`) from every chat
provider (ACP providers add `toolKind`) and keeps one detected activity per
chat:

- Reads never move a turn out of a real activity; only a long run of reads returns to **Exploring**.
- Test runners, review/test subagents and watch loops switch at once; edits, typechecks and git/PR commands need two within five minutes.
- An edit within two minutes of a test run stays **Testing**. Subagent-internal calls are ignored. **Debugging** is never detected.

`nextDetectedActivityReport` (`shared/sessionActivity.ts`) holds precedence:
detection first; an agent report from this turn stands while it covers what
the detector sees. `updatedAt` is when the activity began, so "Testing 3m" is
three minutes of tests.
