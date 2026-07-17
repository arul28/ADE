# Chat Transcript and Turns

The transcript is a JSON-lines stream of `AgentChatEventEnvelope` records.
Everything the renderer draws (messages, tool calls, commands, file
changes, plans, pending inputs, turn dividers) is derived from this one
stream. Sessions persist the stream to disk so they survive restarts.

## Event envelope

```ts
type AgentChatEventEnvelope = {
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
  sequence?: number;
  provenance?: {
    messageId?: string;
    providerMessageId?: string;
    providerParentAgentId?: string | null;
    providerOrigin?: string | null;
    providerSupersedes?: string[];
    providerRetractedMessageIds?: string[];
    threadId?: string | null;
    role?: "user" | "orchestrator" | "worker" | "agent" | null;
    targetKind?: string | null;
    sourceSessionId?: string | null;
    attemptId?: string | null;
    stepKey?: string | null;
    laneId?: string | null;
    runId?: string | null;
  };
};
```

Type definitions live in `apps/desktop/src/shared/types/chat.ts`. The
envelope carries transport metadata; the actual payload is the
discriminated `AgentChatEvent` union.

`provenance` is populated for delegated worker chat, where messages can
originate from orchestrator, worker, or user threads and must be routed
back to the correct activity feed.

## Parsing

`parseAgentChatTranscript(raw)` in
`apps/desktop/src/shared/chatTranscript.ts` is the canonical parser. It
tolerates malformed lines (silently skips), normalises missing
timestamps to `Date.now()`, and only passes through envelopes with a
non-empty `sessionId` and a non-null `event` object.

The parser is used both in the main process (for persisted state
replay, recovery, and auto-title generation) and the renderer (for
transcript-derived summaries in session cards).

Two helpers summarise a parsed stream:

- `hasMaterialWorkerChatEvent(events)` -- returns true when any event
  type in `{ text, reasoning, tool_call, tool_result, command,
  file_change }` is present. Used to gate worker-chat activity badges.
- `hasWorkerChatLifecycleEvent(events)` -- returns true when any event
  other than `user_message` is present.
- `deriveAgentChatTranscriptSummary(events, maxChars = 280)` -- returns
  the last text/reasoning/error/status message, compacted to a single
  line.

## The event union

`AgentChatEvent` is a discriminated union defined at
`apps/desktop/src/shared/types/chat.ts`. Major members:

| Type | Purpose |
|---|---|
| `user_message` | A user turn; carries text, attachments, `turnId`, optional `steerId` and `deliveryState`. `deliveryState` is `"queued"` while a steer waits for turn-end delivery, `"delivered"` once flushed at turn boundary, `"inline"` when the user inline-dispatched a queued steer into the active Claude turn (SDK `shouldQuery:false` send), and `"failed"` if dispatch errored. |
| `text` | Streaming assistant text; identified by `messageId` (preferred) or turn/item identity. Fragments merge when `shouldMergeTextRows()` returns true. |
| `transcript_retraction` | Provider-level retraction signal. Claude emits this for refusal fallback `retracted_message_uuids` and assistant `supersedes`; renderers remove prior assistant text rows whose `messageId` matches `messageIds`, optionally retaining `replacementMessageId` as the new provider message id. The persisted JSONL remains append-only. |
| `reasoning` | Chain-of-thought or assistant-internal reasoning; surfaces as a distinct transcript row with a collapsible header. |
| `tool_call` / `tool_result` | Paired per tool invocation; rendered inside work-log groups. `tool_result.status` can be `running`, `completed`, `failed`, or `interrupted`. Provider-native MCP calls retain `mcp: AgentChatMcpToolSource` (`server`, `tool`, optional plugin/resource/app context) so transcript labels, the TUI/iOS, and Sources use the connector identity instead of a generic tool name. |
| `file_change` | Emitted when the agent writes or deletes a file; carries `path`, `diff`, and `kind`. |
| `command` | A shell command invocation; carries `cwd`, `output`, `exitCode`, `durationMs`. |
| `plan` | Final plan payload (steps + explanation); replaces any earlier `plan_text` rows for that turn. |
| `plan_text` | Streaming plan fragments; merged via `shouldMergePlanTextRows()`. |
| `approval_request` | Legacy approval; newer code emits an embedded `PendingInputRequest` via `detail`. |
| `structured_question` | Claude SDK `AskUserQuestion` tool surface. |
| `pending_input_resolved` | Hidden row; consumed by pending-input derivation to clear UI state. |
| `status` | Turn-level lifecycle: `started`, `completed`, `interrupted`, `failed`. |
| `done` | Final turn marker with model, model id, usage, cost. Also clears non-question pending inputs when status is not `completed`. |
| `error` | Provider/runtime failure with message, detail, and semantic `errorInfo`. Codex can report the same terminal failure first as an app-server `error` notification and again on failed `turn/completed`; ADE keeps one visible row for the same turn/error identity while preserving distinct failures. |
| `activity` | Ephemeral UI hint (thinking, searching, running_command). Hidden from the transcript. |
| `todo_update` | Task-list snapshot; consumed by `ChatTasksPanel`. |
| `subagent_started` / `subagent_progress` / `subagent_result` | Legacy Claude background subagent lifecycle. Each envelope carries `taskId`, `parentToolUseId`, `description`, and optional `agentId`, `parentAgentId`, `agentType`, and `providerSessionId`; Claude start rows bind the native child to the owning Claude session so transcript drill-in never mistakes the ADE chat id for a provider session id. For Claude / ade-code `agentType` is the Task tool's `subagent_type` (stashed at the `tool_use` boundary and joined on `parentToolUseId`); for Codex parallel agents it is a per-turn `Agent #N` label assigned at first announcement and the raw threadId is mirrored as `agentId`; for OpenCode subagents `agentType` is omitted so the row falls back to the `description` (taken from `session.title`). Codex app-server `subAgentActivity` items also flow into these rows and may carry `label`, `model`, and `reasoningEffort` for richer roster labels. Claude SDK runs also stash `taskType` (`subagent` / `background` / `local_workflow` / `cron` / `other`) and `workflowName` at spawn so the renderer can label rows by workflow without re-deriving them per event; ambient/housekeeping tasks (the SDK's `skip_transcript=true` flag — e.g. session-title generation) and plain Claude Code task runs (`task_type` `other` with no agent metadata, e.g. "Re-run affected test files") are both tracked only for cleanup and filtered out symmetrically across spawn, progress, and completion notifications so the subagent panel never flashes them, while a backgrounded `Bash` shell (`task_type` `local_bash`/`background`) is routed to the background pane rather than the roster. Every `subagent_result` is gated on a recorded `subagent_started` (`emittedSubagentStartIds`), so an interrupt cannot emit a phantom stopped card for a subagent that never announced; terminal events clear both the taskId and agentId aliases. The service also emits canonical `subagent.started` / `subagent.progress` / `subagent.completed` rows from `runtimeEvents.ts` so all runtimes can converge on the same envelope. Two additional producers fan into the same three event types: **Claude Workflow runs** — the SDK's undocumented `workflow_progress` snapshot on `system:task_progress` is normalized by `claudeWorkflowProgress.ts` (defensive: malformed entries dropped, previews clipped, counts capped, unknown states degrade to queued/running; an unparseable snapshot leaves the generic task rendering untouched) and diffed per tick into started/progress/result transitions under a stable `<taskId>::a<index>` / latched-agentId identity, so each workflow agent renders as its own row with phase, tokens, and duration, reconnects upsert instead of duplicating, and agents left running when the workflow ends are closed out as `stopped`; and **child chat spawns** — a session created with `orchestrationParentSessionId` outside an orchestration run (e.g. `ade chat create` from a tracked agent shell) emits synthetic `subagent_started`/`subagent_result` events keyed `chat:<childSessionId>` into the parent so the child lists in the parent's subagents panel, its first finished turn reporting completed/failed/stopped. |
| `scheduled_work_update` | Scheduled/background-work lifecycle snapshot. Claude emits it from `ScheduleWakeup`, `CronCreate`, `CronDelete`, `/loop`/hook snapshots, remote triggers, cron/background task lifecycle messages, and durable scheduler transitions. It carries `kind` (`wakeup`, `cron`, `loop`, `remote_trigger`, `background_task`), `status` (`scheduled`, `paused`, `running`, `fired`, `missed`, `completed`, `cancelled`, `failed`, `stopped`), provenance ids, optional cron/prompt/reason/timestamps, `firedAt`, `late`, and `durable`; `shared/chatScheduledWork.ts` folds it into active/history Chat Info rows on desktop, ADE Code, and iOS. Parent turn completion does not imply background completion, and `background_task` snapshots whose `sourceTaskId` belongs to a real subagent are omitted from the Background roster to avoid duplicate Agent rows. One-shots progress through `scheduled` -> `fired` -> `completed`; crons record the fire and return to `scheduled` with `lastRunAt` plus their next occurrence. |
| `tool_use_start` / `tool_use_complete` / `tool_use_summary` | Claude SDK tool lifecycle tracking (see [Claude tool-use tracking](#claude-tool-use-tracking)). |
| `step_boundary` | Workflow step boundary marker. |
| `system_notice` | Non-transcript chrome: auth errors, rate limits, and file persistence hints. Special-cased renders: the "Promoted to Cursor Cloud" pill, and the `status:"subagent_spawned"` chip (emitted into the parent when a child chat session is created with a parent lineage; `detail.spawnedSession` carries the child sessionId/laneId/title and the chip deep-links via `ade:work:select-session`; the TUI shows the message line; iOS renders it through its existing system_notice mapping). |
| `session_meta_updated` | Runtime-native session metadata update. Carries title / manual-name state, and — when a client changes the session's mode via `updateSession` — the permission/interaction mode fields (`permissionMode`, `interactionMode`, `claudePermissionMode`, `codexApprovalPolicy`/`codexSandbox`/`codexConfigSource`, `opencodePermissionMode`, `droidPermissionMode`, `cursorModeId`, `cursorModeSnapshot`). The renderer treats it as a local-touch event so Work lists and grid tiles refresh when a provider renames a session, patches the session summary with any mode fields present, and re-seeds the selected chat's composer mode controls so a mode change on another client (desktop ↔ iOS) shows up live without a refetch. All mode fields are optional; a title-only emit carries none of them. |
| `completion_report` | Structured closeout produced by the `reportCompletion` workflow tool. |
| `turn_diff_summary` | Git-level before/after SHA + per-file stats for a completed turn. |
| `delegation_state` | Delegated worker state updates. |
| `context_compact` | Provider-neutral manual/automatic compaction lifecycle. `state: "started"` begins the boundary and `state: "completed"` may carry `preTokens`, `postTokens`, `tokensRemoved`, `durationMs`, provider, and per-session count. A completed boundary invalidates older context-meter usage on desktop, ADE Code, and iOS; exact post-compaction snapshots may refill the meter immediately, while stale same-turn aggregate counters are ignored. |
| `web_search` | Provider-neutral web-search/fetch lifecycle; renderers group these with other tool calls instead of showing them as standalone event cards. Actions can carry `query`, `queries`, `title`, `url`, and `snippet`; desktop and iOS render URL actions as in-app-browser result chips, while the TUI keeps a concise one-line action summary. Codex 0.145 additionally emits structured `results` (an array of `{ url, title, snippet }` capped at 8 by the adapter) plus `resultsTotal` (the pre-cap hit count). Renderers thread these onto the same grouped row — desktop/iOS surface them as `Sources` chips (deduped against the action URLs) and the Sources tab, and the TUI shows up to three `title — domain` preview lines with a `+N more` tail. Codex emits native web-search items; `claudeStructuredActivity.ts` maps Claude server-tool blocks into the same event. |
| `codex_image_generation` / `codex_image_view` | Compact generated/viewed-image lifecycle used across providers despite the legacy type prefix. Codex emits native image items, Cursor maps `generateImage`, OpenCode maps image `file` parts, and Droid maps assistant image blocks. Large stored data URIs are removed with original/omitted byte metadata. |
| `codex_safety_buffering` / `codex_moderation_metadata` / `codex_sleep` / `codex_thread_deleted` / `codex_turn_stalled` | Codex app-server runtime state. Safety buffering, moderation metadata, and sleep are compact status rows; `codex_thread_deleted` clears the stored upstream thread; `codex_turn_stalled` is the structured recovery event shown when a turn produced no useful output after app-server reconciliation. Its actions are `wait`, `steer`, `interrupt_retry_same_thread`, and `restart_resume_thread`. |
| `auto_approval_review` | When auto-approval policy kicks in, this event carries the review text. |
| `prompt_suggestion` | Suggested follow-up prompts for the user. |

## Canonical runtime events

`apps/desktop/src/main/services/chat/runtimeEvents.ts` defines the
provider-neutral event vocabulary that runtime adapters should emit
internally: `turn.started`, `content.delta`, `tool.started`,
`tool.completed`, `tool.failed`, `subagent.started`,
`subagent.progress`, `subagent.completed`, `teammate.idle`,
`task.completed`, `turn.completed`, and `compact.boundary`.

The current migration is additive. Claude still emits the legacy
underscore subagent rows used by older renderer paths, then
`buildCanonicalAgentChatRuntimeEvent()` writes the canonical dotted
subagent row beside it. `AgentChatPane` filters the dotted rows from
the transcript display because they are coordination data, while
subagent-specific panels can consume either shape during the transition.

## Structured activity normalization

Adapters preserve provider richness while converging on compact event shapes:

- Claude server `web_search` / `web_fetch` blocks become `web_search` start
  and terminal events. Claude MCP blocks become paired tool events; unfinished
  server activities are closed when the turn ends.
- Codex 0.144.5 `mcpToolCall` items retain plugin/app/resource metadata, while
  native web/image/subagent items keep their specialized compact rows.
- Cursor MCP calls and generated images, OpenCode image file parts, and Droid
  assistant image blocks reuse those same tool/image events.

Every event uses the provider item id (plus turn id) as its lifecycle key.
Desktop `chatTranscriptRows`, ADE Code `aggregateChatBlocks`, and iOS
`WorkEventMapping`/`WorkTranscriptParser` therefore update one row instead of
printing repeated start/progress/result records. The Codex Sources tab derives
files, web results, connector apps/actions, and external URLs from this same
stream; it is a view, not a second persistence channel.

## Render pipeline

`apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts`
implements a two-layer transform:

1. **Render events.** Raw envelopes become `ChatTranscriptRenderEvent`
   values:
   - Tool, command, file-change, and web-search events collapse into
     `ChatWorkLogEntry` objects (status, label, tone, diff stats, and
     web-search action metadata for result chips).
   - Text, reasoning, plan, status, pending input, and user-message
     events pass through as visible rows. Before a synthetic scheduled
     `user_message` carrying `metadata.scheduledWake`, the transform inserts a
     `scheduled_wake_divider` keyed
     `scheduled-wake:<scheduleId>:<turnId>` with fire time, reason, and late
     state; the while-you-were-away strip scrolls to these stable keys.
   - `subagent_started` / `subagent_progress` / `subagent_result`
     events collapse per agent (keyed by `agentId ?? taskId`) into two
     stable render rows — a `subagent_spawn_anchor` at the start
     position (mutated in place as progress arrives) and a
     `subagent_result_card` at the settle position — while backgrounded
     shell commands collapse to a single `background_finish_chip`. The
     anchor keys (`subagent-spawn:` / `subagent-result:` /
     `background-chip:<agentKey>`) never change on rebind so the
     virtualizer's measured heights survive; a `transcript_retraction`
     splice repairs each stored row index. Raw lifecycle events are then
     hidden.
   - `pending_input_resolved`, `activity`, `step_boundary`, raw tool/
     command/file-change events, standalone reasoning events, and
     `scheduled_work_update` are hidden (consumed by other derivations).
   - `transcript_retraction` is also hidden, but mutates the accumulated
     rows by removing prior assistant `text` rows whose provider
     `messageId` was retracted or superseded.
   - Exact duplicate `error` rows are collapsed by turn id, message, detail,
     and semantic `errorInfo`. This replay guard handles historical
     transcripts written before provider-side dedupe without hiding distinct
     failures from the same turn.

2. **Grouped envelopes.** Adjacent work-log render events in the same
   turn merge into `work_log_group` blocks. When a `tool_use_summary`
   event immediately follows a group from the same turn, its summary
   and tool-use IDs are absorbed into the group instead of rendering
   as a separate row. This keeps the transcript compact when the agent
   runs many tools in a single turn.

3. **Activity phase collapse.** After work-log grouping, contiguous runs
   of `reasoning` + `work_log_group` rows within the same turn (unbroken
   by assistant text, user messages, plans, pending inputs, or other hard
   boundaries) can merge again when the phase is noisy: at least three rows,
   or at least two reasoning rows, or at least two work groups. The pass
   emits one merged `Thought` row and one merged `Tool calls (N)` row in
   chronological first-occurrence order. Simple one-thought + one-tool
   turns stay as two rows. Shared logic lives in
   `apps/desktop/src/shared/chatActivityPhase.ts`; desktop wires it through
   `groupChatTranscriptRows()`, the TUI through `aggregateChatBlocks()`,
   and iOS through `collapseActivityPhaseTimelineEntries()`.

Each work-log entry carries a `collapseKey` built from `turnId`,
`logicalItemId` (preferred) or `itemId`, and tool/command identity.
Streaming updates for the same tool call merge into the existing entry
instead of appending a new row.

`withLocalhostUrls(entry)` runs at every emit/merge step and stamps
`entry.localUrls?: ChatLocalhostUrl[]` whenever the entry's
command/output/args/result/label/detail mention a `localhost`,
`127.0.0.1`, `0.0.0.0`, or `[::1]` URL. The extractor (also exported as
`extractLocalhostUrlsFromText`) trims trailing punctuation, normalises
the host to `localhost` for the canonical `href`, and dedupes by
`href`. Downstream `ChatWorkLogBlock` consumes `entry.localUrls` to
render the localhost-strip chips that route into the in-app browser.

## Text merging

Adjacent `text` events merge via `shouldMergeTextRows()`:

- Events with matching `messageId` always merge.
- Events without `messageId` fall back to matching `turnId` and
  `itemId`.

This prevents duplicate rows when the provider streams fragmented text.
For Claude SDK rows, `messageId` is the provider message UUID/id so a
later `transcript_retraction` can remove the exact assistant text that a
model refusal fallback or `supersedes` message invalidated.

`plan_text` merging uses `shouldMergePlanTextRows()` with the same
heuristic. When a final `plan` event arrives for a turn, any preceding
`plan_text` rows for that turn are discarded and replaced with the
single `plan` row.

## Turn diff summaries

When a turn completes on a lane and the service can compute a diff
between the before and after SHAs, the service emits
`turn_diff_summary` with per-file add/delete counts. The
`ChatTurnDiffPanel` component renders the summary inline; individual
file diffs are fetched lazily via `ade.agentChat.getTurnFileDiff`.

## Turn recap

`chatTranscriptRows` also emits a synthetic `turn_recap` row when a
turn completes. The recap aggregates completed, failed, and interrupted
tool invocations into a single summary line with task-progress counts.

## Claude tool-use tracking

The Claude SDK runtime tracks individual tool invocations via the SDK's
`toolUseID`:

1. On `tool_use_start` the service records the invocation as
   in-progress.
2. When the SDK returns a `tool_use_summary` with
   `preceding_tool_use_ids`, each ID is matched back to its pending
   invocation and marked complete, emitting `tool_use_complete` with
   the summary text.
3. `AskUserQuestion` is special: when the SDK invokes it, the service
   builds a `PendingInputRequest`, attaches the `toolUseID`, pauses the
   idle watchdog (so the turn doesn't time out during human
   deliberation), and emits the request inline. When the user
   responds, the watchdog resumes, a `tool_result` goes back to the
   SDK with the answer text, and `pending_input_resolved` clears the
   UI.
4. `resolvedToolUseIds` tracks already-resolved tool uses so double
   resolutions (UI double-click, interrupted turn, stale state) are
   swallowed rather than throwing.

## Text batching

`apps/desktop/src/main/services/chat/chatTextBatching.ts` accumulates
streaming text fragments for up to 100 ms before flushing as a single
assistant-text event. This reduces renderer re-render frequency during
fast streams.

Critical invariant: the buffer **must** be flushed immediately on every
non-text event (tool call, turn boundary, error) to preserve ordering.
`shouldFlushBufferedAssistantTextForEvent()` is the gate. Any new event
type added to the union must be considered for this check.

`getRecentEntries` (used by auto-title and compaction flush) calls the
flush helper first so reads always reflect the latest streamed content.

## Virtual scrolling and message-list layout

`AgentChatMessageList.tsx` uses `@tanstack/react-virtual` to keep render
cost proportional to the visible viewport rather than total message
count. Notable rendering rules:

- Assistant message cards constrain to `max-w-[78ch]` for readability.
- Turn dividers (`ChatTurnDivider`) separate consecutive turns.
- Code blocks in assistant messages render through `HighlightedCode`.
- User messages animate in with a `motion/react` spring transition.
- Tables use rounded borders and a subtle inset-shadow treatment.
- System notices render compact inline rather than as pill badges.
- Plan approval cards cap at `max-h-72` with pre-wrapped text so long
  multi-step plans scroll.

## Persisted transcript

Sessions persist the transcript to disk under the `.ade` layout.
Chat replay prefers the dedicated per-session JSONL at
`.ade/transcripts/chat/<sessionId>.jsonl`; the legacy managed transcript path
can still exist for compatibility and may be byte-capped by the terminal/session
storage budget. When multiple transcript candidates are present, recovery first
prefers files that contain real chat event envelopes, then uncapped files, then
newer readable candidates with file size only as a tie-breaker, so header-only
or capped files do not hide compacted chat history.

Persisted chat events keep the same public `AgentChatEvent` shape, but bulky
payloads are compacted before storage for rows users rarely need in full after
the turn is over. Large command output, tool results, file diffs, reasoning
text, and inline image data URIs are replaced with a short preview (or no inline
media) plus original/omitted-byte metadata on the event
(`outputOriginalBytes`, `resultOmittedBytes`, `diffOmittedBytes`,
`textOmittedBytes`, `urlOmittedBytes`, etc.). Desktop/runtime live subscribers
still receive the original event while a turn is active. The sync host
independently removes inline image data URIs over 64 KB from mobile live sends,
snapshots, and replay entries without mutating the desktop event.
Persisted-history consumers see the stored preview on replay.

`sessionRecovery.ts` implements version-2 reconstruction:

- Recent entries (bounded) are parsed back into envelopes.
- A continuity summary is injected into the new runtime context on
  resume.
- Provider-native runtime state (Claude session id, Codex app-server
  socket path, OpenCode runtime ids) is rehydrated so the next turn
  can use the same session instead of creating a new one.

### Claude restart and Stop recovery

Every parent turn must finish with both a terminal `status` and a matching
`done` event. A process crash can occur after the user message or
`status: "started"` has been persisted but before that pair is written. When a
Claude runtime is created, `agentChatService` therefore checks the latest
non-steer parent turn even when the previous process never persisted an SDK
session id. It fills in only the missing member of the terminal pair, preserves
an already-written terminal status, marks the session idle, and persists the
repair. A newer complete parent turn makes an older incomplete turn irrelevant;
restart recovery never rewrites historical turns.

Restart reconciliation first closes orphaned background and subagent rows, then
appends the parent terminal pair last. This ordering is deliberate: renderer
turn state is derived in event order, so a cleanup row must not make a repaired
turn look active again. Pressing Stop on an already-idle Claude runtime runs the
same parent-turn repair, which lets a stale red Stop state settle without
requiring a live Claude process. Repeated reconciliation and repeated Stop calls
are idempotent because an already-complete `status` + `done` pair is no longer an
unsettled turn.

Live Claude control calls are bounded independently of the desktop action
timeout. Provider `interrupt()` gets 2.5 seconds; active `stopTask()` calls get
2 seconds each and run concurrently. During ordinary Stop, a hung SDK control
channel is logged and local interruption cleanup continues rather than holding
the action bridge until its 30-second request timeout; an interrupt-and-replace
request that requires provider acknowledgement fails within the control-call
bound instead of sending the replacement ambiguously. Likewise, a steer sent to
an idle or stale Claude session waits only for input-dispatch acceptance; the
provider turn keeps streaming asynchronously instead of making the steer action
wait for the full answer.

Codex adapters deduplicate repeated lifecycle notifications before
converting them to envelope events. Terminal app-server failures use a
bounded semantic key (turn id + message + detail + error identity) shared by
the early notification and failed completion path; retrying notifications stay
non-terminal provider-health notices. The renderer applies the same exact
identity rule while replaying persisted history, so older transcripts do not
regain duplicate visible failures after restart.

## Gotchas

- **`messageId` is preferred over turn/item identity for merging.** If a
  provider adapter stops emitting `messageId`, the fallback path is
  correct but noisier. Track regressions in `shouldMergeTextRows` when
  swapping SDKs.
- **Hidden event types drop silently.** Adding a new event type that
  should still be grouped into the work log requires plumbing through
  `chatTranscriptRows.ts` and `HiddenTranscriptEvent`.
- **`logicalItemId` vs `itemId`.** Collapse keys prefer `logicalItemId`
  so streaming updates of the same logical tool merge even when the
  provider re-emits with a new physical `itemId`. Missing this breaks
  into duplicate rows.
- **Turn diff emission depends on lane context.** If a session is
  disassociated from a lane, `turn_diff_summary` will not emit. Do not
  rely on it for non-lane surfaces.
- **Claude parent terminal events are an ordered pair.** Restart and idle-Stop
  repair must leave the parent `status` + `done` pair after any orphan cleanup.
  Emitting later lifecycle rows can resurrect a stopped renderer state.
