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
originate from agent or user threads and must be routed
back to the correct activity feed.

## Canonical assistant text (fragile — read before editing)

`chat.getTranscript` — plus the cursor-paged chat-history reader and the
internal `readTranscriptEntries` used by auto-title and handoff — flattens the
envelope stream into role-tagged entries via `transcriptEntriesFromEnvelopes` in
`apps/desktop/src/main/services/chat/chatTranscriptEntries.ts`. Clients that
hold **both** the live fragment stream and this canonical text (iOS, the web
client) reconcile the two, so the module owes them one invariant:

> Canonical text is byte-identical to what a renderer draws from the same
> envelopes. ADE never invents a character.

That is stronger than "don't corrupt text", and it is the property that matters:
a client holding both renditions can only reconcile them if they agree. The
moment canonical groups or joins differently from a renderer, the two are no
longer deltas of each other and the client concatenates them — rendering the
message twice.

So canonical mirrors the renderer exactly:

- **Entries group on `messageId`** (else the turn), because that is what every
  renderer keys on. Desktop's `shouldMergeTextRows` compares `messageId` and
  ignores `itemId`; iOS collapses a text event onto its `messageId` in
  `workAssistantMessageStableId`. Grouping more finely — for example splitting on
  the `itemId` Codex advances per provider message — makes a client silently
  concatenate two entries it keyed the same.
- **Identified fragments concatenate verbatim**, whatever interleaves, because
  the renderer joins merged rows with a bare `${previous}${next}`. ADE has no
  block-level identity it can trust, so guessing a boundary from interleaved
  events is what spliced `"\n\n"` into the middle of a word (`"no new mod"` +
  `"ifier chain needed:"`).

Only when ADE cannot tie a fragment to a provider message does it fall back to
inferring boundaries from interleaved events. Ephemeral chrome — `activity`
hints, live `context_usage`, token counters — is invisible to every renderer, so
letting it break a run made the canonical text disagree with what desktop, the
TUI, and iOS actually draw. `isTranscriptContentEvent` is an allowlist of
*content* types on purpose: a new event type defaults to "does not break the
run", which at worst drops a paragraph break, whereas the inverse default
corrupts words. Keep genuinely rendered rows (`todo_update`, the `subagent_*`
cards, `ade_card`, `done`) in that list — they are not chrome.

A user message clears every open entry, so a stream key reused in a later turn
cannot merge backwards into text that preceded the user.

A whitespace-only fragment (a word gap, or a markdown hard break `"  \n"`) is a
real delta and is dropped only when there is no run for it to continue.

Because canonical and rendered text agree, clients need no reconciliation
heuristic of their own. iOS merges every assistant fragment through
`mergeWorkStreamingText` regardless of where the envelope came from. An earlier
attempt to add a client-side guard for whole-message rows had to be removed: it
could not tell a complete message from one chunk of a paged canonical fetch
(`getChatTranscriptPage` can split a message at an envelope boundary), so it
dropped the other chunk. Keep the agreement on the host side; do not reintroduce
a client rule that has to guess what a sequence-less envelope contains.

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
| `user_message` | A user turn; carries text, attachments, `turnId`, optional `steerId` and `deliveryState`. `deliveryState` is `"queued"` while a steer waits for turn-end delivery, `"delivered"` once flushed at turn boundary, `"inline"` when the message was folded into the active turn rather than queued behind it (Claude's SDK `shouldQuery:false` send, or Cursor's `Run.steer()`), and `"failed"` if dispatch errored. The desktop draws the delivery state as one small line under the bubble, right-aligned with it and never inside it (see [Message delivery](README.md#message-delivery-turn-health-and-quiet-diagnostics)). Same-turn steers (`queued`, `inline`, and Codex `accepted`/`processed`/`unprocessed`) do not clear the live provider-retry working indicator; only a primary user message, `delivered`/`failed` user message, or a terminal status/`done` starts the next retry-replay segment. A `user_message` carrying `metadata.boardMove` is intercepted before the user-bubble branch and rendered as a divider (`Moved on the board · <from> → <to>`) with the exact text the agent received centred underneath — never a bubble, because the user dragged a card between Work-board columns rather than typing that sentence. |
| `text` | Streaming assistant text; identified by `messageId` (preferred) or turn/item identity. Fragments merge when `shouldMergeTextRows()` returns true. Codex text may carry an optional `phase` (`commentary` / `final_answer`); see Text merging. |
| `transcript_retraction` | Provider-level retraction signal. Claude emits this for refusal fallback `retracted_message_uuids` and assistant `supersedes`; renderers remove prior assistant text rows whose `messageId` matches `messageIds`, optionally retaining `replacementMessageId` as the new provider message id. The persisted JSONL remains append-only. |
| `reasoning` | Chain-of-thought or assistant-internal reasoning; surfaces as a distinct transcript row with a collapsible header. |
| `tool_call` / `tool_result` | Paired per tool invocation; rendered inside work-log groups. `tool_result.status` can be `running`, `completed`, `failed`, or `interrupted`. Claude SDK `tool_result_meta` is retained as optional `toolResultMeta`, and the provider's raw payload as optional `structured`; both are local-only debug material — they are bounded on disk and stripped from the sync wire, because no renderer, TUI, web, or iOS client decodes either. Provider-native MCP calls retain `mcp: AgentChatMcpToolSource` (`server`, `tool`, optional plugin/resource/app context) so transcript labels, the TUI/iOS, and Sources use the connector identity instead of a generic tool name. Provider web tools add an optional `sources: ChatSourceRef[]` (at most 20, http(s) only, strings clipped) to their `tool_result`; unlike `structured` it travels on every wire, and the desktop row lists those hits like a native web search. |
| `file_change` | Emitted when the agent writes or deletes a file; carries `path`, `diff`, and `kind`. |
| `command` | A shell command invocation; carries `cwd`, `output`, `exitCode`, `durationMs`. |
| `plan` | Plan payload (steps + explanation). A plan with steps writes the chat's one task list; a Codex plan-mode proposal (no steps, `streamingText`) keeps its own plan card; a plan with no steps and no text (ACP `plan_removed`) clears the list. See [One task list per chat](#one-task-list-per-chat). |
| `plan_text` | Streaming plan fragments; merged via `shouldMergePlanTextRows()`. |
| `approval_request` | Legacy approval; newer code emits an embedded `PendingInputRequest` via `detail`. |
| `structured_question` | Claude SDK `AskUserQuestion` tool surface. |
| `pending_input_resolved` | Hidden row; consumed by pending-input derivation to clear UI state. |
| `status` | Turn-level lifecycle: `started`, `completed`, `interrupted`, `failed`. |
| `done` | Final turn marker with model, model id, usage, cost, and optional open-string `terminalReason`. Claude may also carry `canonicalModel`, `modelProvider`, `apiErrorStatus`, `fastModeDisabledReason`, `userMessageUuid`, and `requestSentWallMs`; these preserve billing/provider provenance, terminal HTTP class, Fast fallback cause, and request correlation/latency metadata without exposing raw provider envelopes. Failed/interrupted dividers translate known reasons into a short explanation; completed turns omit the reason. Also clears non-question pending inputs when status is not `completed`. |
| `error` | Provider/runtime failure with message, detail, and semantic `errorInfo`. `errorInfo.presentation` is the host's own card copy for the row — `{ title, body, nextAction?, technicalDetail? }` from `shared/chatErrorPresentation.ts` — so desktop, iOS, and hosted web show the same sentence and none of them titles a failed turn "Error" or "Unknown"; raw provider text belongs in `technicalDetail`, never in `body`. A client that receives no presentation derives the same shape from `errorInfo.category`. Codex can report the same terminal failure first as an app-server `error` notification and again on failed `turn/completed`; ADE keeps one visible row for the same turn/error identity while preserving distinct failures. |
| `activity` | Ephemeral UI hint (thinking, searching, running_command). Hidden from the transcript. Automatic provider retry, reconnect, and transport-fallback signals also use this event with one compact, replaceable detail in the working indicator; they are emitted live-only and are not persisted. A live-only retry flushes any buffered assistant text/reasoning first so an older 100 ms fragment cannot land after the retry and clear the working indicator. |
| `todo_update` | Task-list snapshot (whole list each time); writes the chat's one task list. Items may carry `activeForm` (Claude) and `cancelled` (OpenCode/Cursor; wire status `completed`). |
| `subagent_started` / `subagent_progress` / `subagent_result` | Legacy Claude background subagent lifecycle. Each envelope carries `taskId`, `parentToolUseId`, `description`, and optional `agentId`, `parentAgentId`, `agentType`, and `providerSessionId`; Claude start rows bind the native child to the owning Claude session so transcript drill-in never mistakes the ADE chat id for a provider session id. For Claude / ade-code `agentType` is the Task tool's `subagent_type` (stashed at the `tool_use` boundary and joined on `parentToolUseId`); for Codex parallel agents it is a per-turn `Agent #N` label assigned at first announcement and the raw threadId is mirrored as `agentId`; for OpenCode subagents `agentType` is omitted so the row falls back to the `description` (taken from `session.title`). Codex app-server `subAgentActivity` items also flow into these rows and may carry `label`, `model`, and `reasoningEffort` for richer roster labels. Claude carries `label` too, and it is a different field from `agentType` on purpose: the Task tool's `name` is the human-chosen display name for *this* spawn, while `subagent_type` is the agent type. `name` used to be used as a fallback `agentType`, which made one spawn look like an agent type that does not exist. The label is stashed per subagent identity under both id spaces (taskId and agentId) in a map kept off `activeSubagents`, because terminal paths delete that entry — and the stashed tool input with it — before the result event is emitted, so a label stored there would vanish exactly when the completion row needs it. Claude SDK runs also stash `taskType` (`subagent` / `background` / `local_workflow` / `cron` / `other`) and `workflowName` at spawn so the renderer can label rows by workflow without re-deriving them per event; ambient/housekeeping tasks (the SDK's `skip_transcript=true` flag — e.g. session-title generation) and plain Claude Code task runs (`task_type` `other` with no agent metadata, e.g. "Re-run affected test files") are both tracked only for cleanup and filtered out symmetrically across spawn, progress, and completion notifications so the subagent panel never flashes them, while a backgrounded `Bash` shell (`task_type` `local_bash`/`background`) is routed to the background pane rather than the roster. Every `subagent_result` is gated on a recorded `subagent_started` (`emittedSubagentStartIds`), so an interrupt cannot emit a phantom stopped card for a subagent that never announced; terminal events clear both the taskId and agentId aliases. The service also emits canonical `subagent.started` / `subagent.progress` rows from `runtimeEvents.ts` so all runtimes can converge on the same envelope. There is no canonical end twin: a subagent ends once, so `subagent_result` is its single end event. A paired `subagent.completed` beside it makes clients count, group, and render each finished subagent twice. Two additional producers fan into the same three event types: **Claude Workflow runs** — the SDK's undocumented `workflow_progress` snapshot on `system:task_progress` is normalized by `claudeWorkflowProgress.ts` (defensive: malformed entries dropped, previews clipped, counts capped, unknown states degrade to queued/running; an unparseable snapshot leaves the generic task rendering untouched) and diffed per tick into started/progress/result transitions under a stable `<taskId>::a<index>` / latched-agentId identity, so each workflow agent renders as its own row with phase, tokens, and duration, reconnects upsert instead of duplicating, and agents left running when the workflow ends are closed out as `stopped`; and **child chat spawns** — a session created with `orchestrationParentSessionId` outside an orchestration run (e.g. `ade chat create` from a tracked agent shell) emits synthetic `subagent_started`/`subagent_result` events keyed `chat:<childSessionId>` into the parent so the child lists in the parent's subagents panel, its first finished turn reporting completed/failed/stopped. A `--mode cli` child (`ade new chat --mode cli --parent … --type …`, which goes through `start_cli_session` and creates a tracked PTY session) is not a chat session, so a third producer bridges it: `start_cli_session` calls `agentChatService.notifyParentOfCliChildSpawn`, which emits the same `subagent_spawned` chip and `chat:<terminalId>` `subagent_started` card (description = the terminal title, `agentType` = the CLI's provider for the logo, `model` from the launch) — clicking it opens the terminal session — and the chat service's `ptyService.onExit` listener closes the card when the PTY ends: exit 0 is `completed`, a non-zero exit is `failed`, and a closed or orphaned terminal is `stopped` unless the CLI had already written a closing message, in which case it is `completed` (the same rule the stale-run sweep applies to an ended chat that left a report). The summary is the CLI's own last assistant message when ADE can read it (Codex rollout by resume thread id, Claude Code JSONL by session id), otherwise the last meaningful terminal lines, and only when both are empty a plain statement of the exit — never a placeholder. Completion routing is the chat-child path (`deliverChildCompletionToParent`): `subagent` wakes the parent (the wake text points at `ade terminal read <id>`), `peer` leaves the quiet note, and the CTO gets one line. The dedupe `childTurnId` is `cli-exit:<endedAt>`, so the live exit and a post-restart reconcile of the same exit deliver once, while a resumed run that ends again reports again. Because an interactive CLI stays open after finishing its task, the card closes only when the process exits. The stale-run sweep defers `chat:` rows whose id is a tracked CLI child (`deferChildTerminal`) instead of reading the missing chat row as "the subagent chat is gone": an ended child is reported through the CLI path with quiet routing (no parent wake, matching the sweep), a running one is left to its PTY exit, and a row that already has its result is never re-closed. A shutting-down host unsubscribes before its PTYs are disposed, so a brain restart does not read its own terminal teardown as every CLI child stopping. `ade chat status <id>` answers for tracked CLI sessions (`running` while the PTY is busy, `blocked` while the TUI waits on a prompt, `idle` once quiet or ended, plus a `cliSession` block with status, exit code, lane, parent and the `ade terminal read` hint), `ade chat list` appends the lane's CLI children (`chat.listCliChildSessions`, `kind: "cli"`), and `ade chat read <id>` returns the CLI's last message and terminal tail with a pointer to `ade terminal read`. |
| `scheduled_work_update` | Scheduled/background-work lifecycle snapshot. ADE emits it for provider-neutral action schedules and Claude `ScheduleWakeup`, `CronCreate`, `CronDelete`, `/loop`/hook snapshots, remote triggers, cron/background task lifecycle messages, and durable scheduler transitions. It carries `kind` (`wakeup`, `cron`, `loop`, `remote_trigger`, `background_task`), `status` (`scheduled`, `paused`, `running`, `fired`, `missed`, `completed`, `cancelled`, `failed`, `stopped`), provenance ids, optional cron/prompt/reason/timestamps, `firedAt`, `late`, and `durable`; `shared/chatScheduledWork.ts` folds it into active/history Chat Info rows on desktop, ADE Code, and iOS. `background_task` is additionally how the live Claude runtime reports a backgrounded shell command — it emits no subagent lifecycle events for one — so on desktop those snapshots also drive the in-thread `background_job_line`; other kinds bundle as activity. Parent turn completion does not imply background completion, and `background_task` snapshots whose `sourceTaskId` belongs to a real subagent are omitted from the Background roster (and from the job line) to avoid duplicate Agent rows. One-shots progress through `scheduled` -> `fired` -> `completed`; crons record the fire and return to `scheduled` with `lastRunAt` plus their next occurrence. |
| `tool_use_start` / `tool_use_complete` / `tool_use_summary` | Claude SDK tool lifecycle tracking (see [Claude tool-use tracking](#claude-tool-use-tracking)). |
| `step_boundary` | Workflow step boundary marker. |
| `system_notice` | Non-transcript chrome: auth errors, rate limits, and file persistence hints. Automatic retry/reconnect progress is not a system notice: it is live `activity` state, so successful recovery leaves no transcript row. Special-cased renders: the "Promoted to Cursor Cloud" pill, the `status:"subagent_spawned"` chip (emitted into the parent when a child chat session is created with a parent lineage; `detail.spawnedSession` carries the child sessionId/laneId/title and the chip deep-links via `ade:work:select-session`; the TUI shows the message line; iOS renders it through its existing system_notice mapping), the quiet `status:"model_switched"` divider after a Claude Pre/PostModelSwitch, and `status:"classifier_context"` audit lines when ADE relays user-authored classifierContext. |
| `model_handoff` | A completed **provider** transition. Emitted on Send only when the committed session's top-level provider group changes (`claude` → `codex`); a model switch inside one provider — including swapping the vendor model fronted by an aggregator provider, since OpenCode, Cursor, and Droid each collapse to a single group — is a model change but not a handoff and emits nothing. Desktop draws a divider with previous and current provider marks. The TUI prints `[model] Codex → Claude`. iOS renders a hairline · from-logo · `HANDOFF` · arrow · to-logo divider: `WorkEventMapping` routes the event onto the notice channel under `AgentChatNoticeKind.modelHandoff` with the provider pair packed into the notice `detail` (`from|to`), and the `Model handoff · Codex → Claude` sentence survives as the VoiceOver label. All three renderers additionally skip a same-provider pair, so legacy transcripts holding `Claude → Claude` no longer draw one. |
| `conversation_reset` | Marks a fresh Claude conversation inside the same ADE session. ADE adopts `newConversationId` as the next SDK resume pointer, clears conversation-scoped auto-title/continuity caches while preserving a manual title, and renderers show a `New conversation` divider. |
| `interrupt_receipt` | Records SDK UUIDs that remain queued or were cancelled after an interrupt, plus the selected `stopMode`. Clients show the full remaining count; ADE-attributed messages include their `steerId` and offer cancellation through the SDK control channel. The long-lived query remains attached while messages are still queued so the receipt stays actionable. |
| `queue_recovery` | Bounded recovery lifecycle for Claude queue-clearing Stop (`stop_and_clear` / `stop_and_clear_and_background`): `available` renders one Undo card for the actually cancelled ADE-attributed messages, `restored` rehydrates the original steer payloads/ids, and `expired` closes the eight-second window. Terminal recovery events suppress the earlier available card during replay. |
| `command_lifecycle` | Ground-truth lifecycle for ADE-owned Claude messages (`queued`, `started`, `completed`, `cancelled`, `discarded`). ADE ignores internal UUIDs it cannot attribute, deduplicates repeated states, clears staged composer rows once execution begins, and renders only cancelled/discarded terminal anomalies to keep transcripts quiet. |
| `claude_goal_updated` / `claude_goal_cleared` | Read-only Claude `/goal` lifecycle. The update carries the condition, iteration count, token baseline, timestamps, and optional last reason; the session summary mirrors the latest value as `claudeGoal`. |
| `session_meta_updated` | Runtime-native session metadata update. Carries title / manual-name state, and — when a client changes the session's mode via `updateSession` — the permission/interaction mode fields (`permissionMode`, `interactionMode`, `claudePermissionMode`, `codexApprovalPolicy`/`codexSandbox`/`codexConfigSource`, `opencodePermissionMode`, `droidPermissionMode`, `cursorModeId`, `cursorModeSnapshot`). The renderer treats it as a local-touch event so Work lists and grid tiles refresh when a provider renames a session, patches the session summary with any mode fields present, and re-seeds the selected chat's composer mode controls so a mode change on another client (desktop ↔ iOS) shows up live without a refetch. All mode fields are optional; a title-only emit carries none of them. |
| `completion_report` | Structured closeout produced by the `reportCompletion` workflow tool. |
| `turn_diff_summary` | Git-level before/after SHA + per-file stats for a completed turn. |
| `delegation_state` | Delegated worker state updates. |
| `context_usage` | Provider-neutral context occupancy. Automatic Claude samples use `origin: "live" \| "snapshot" \| "compact"` and are filtered out of the transcript; `live` is the responsive stream estimate, while `snapshot`/`compact` come from the SDK control channel after initialization, settled turns, and compact completion. `state` is `measured`, `compacting`, `recalculating`, or `unknown`; non-measured states deliberately hide the old percentage. Monotonic `sampleId` plus `capturedAt` support stale-response rejection and diagnostics. The user-invoked `/context` command carries `origin: "command"` (historical undefined-origin snapshots are treated the same) and still renders its inline breakdown card, classified by each category's `kind` (`used` / `free` / `buffer` / `deferred`) — never by the display name `"free"`. Optional typed fields (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`) carry the breakdown the meter's hover shows without reparsing the display `categories`. |
| `context_compact` | Provider-neutral manual/automatic compaction lifecycle. `state: "started"` begins the boundary and `state: "completed"` may carry `preTokens`, `postTokens`, `tokensRemoved`, `durationMs`, provider, and per-session count. `trigger: "ade_fallback"` identifies ADE's guarded fallback. A completed boundary invalidates older context-meter usage on desktop, ADE Code, and iOS; exact post-compaction snapshots may refill the meter immediately, while stale same-turn aggregate counters are ignored. |
| `web_search` | Provider-neutral web-search/fetch lifecycle; renderers group these with other tool calls instead of showing them as standalone event cards. Actions can carry `query`, `queries`, `title`, `url`, and `snippet`; desktop and iOS render URL actions as in-app-browser result chips, while the TUI keeps a concise one-line action summary. Codex 0.145 additionally emits structured `results` (an array of `{ url, title, snippet }` capped at 8 by the adapter) plus `resultsTotal` (the pre-cap hit count). Renderers thread these onto the same grouped row — desktop/iOS surface them as `Sources` chips (deduped against the action URLs) and the Sources tab, and the TUI shows up to three `title — domain` preview lines with a `+N more` tail. Codex emits native web-search items; `claudeStructuredActivity.ts` maps Claude server-tool blocks into the same event. Every surface that lists sources reads these results and URL actions through `shared/chatSources.ts`; the queries are metadata on the sources they produced, never items of their own. The desktop row header shows the result count (`resultsTotal`, else the results, else the URL actions) without being expanded. |
| `sources` | Data-only citations for an assistant message: `sources: ChatSourceRef[]` plus optional `itemId`/`turnId`. Claude text-block citations, Codex `agentMessage.memoryCitation`, and ACP `resource_link` message blocks emit it. It draws no row on any surface (desktop hides it with the token events; iOS decodes it as `.unknown`; the TUI prints nothing for it) and does not break the streaming assistant message (`shouldFlushBufferedAssistantTextForEvent` returns false). Sources, the turn chip, and the fold count read it. |
| `codex_image_generation` / `codex_image_view` | Compact generated/viewed-image lifecycle used across providers despite the legacy type prefix. Codex emits native image items, Cursor maps `generateImage`, OpenCode maps image `file` parts, and Droid maps assistant image blocks. OpenCode's two origins are split by where the `file` part lives: an assistant-owned part is model output (`codex_image_generation`), while a tool attachment is what the tool returned (`codex_image_view`) — except attachments from a recognized image-generation tool, which keep the generation card. The view line renders an inline preview for data URIs only (the renderer CSP pins `img-src` to an allowlist plus data:/blob:, so a remote preview would paint an empty box) and never prints a data URI as its name; remote and local sources keep the `open` affordance. Large stored data URIs are removed with original/omitted byte metadata. |
| `codex_safety_buffering` / `codex_moderation_metadata` / `codex_sleep` / `codex_thread_deleted` / `codex_turn_stalled` | Codex app-server runtime state. Safety buffering, moderation metadata, and sleep are compact status rows; `codex_thread_deleted` clears the stored upstream thread; `codex_turn_stalled` is the structured recovery event shown when a turn produced no useful output after app-server reconciliation. Its actions are `wait`, `steer`, `interrupt_retry_same_thread`, and `restart_resume_thread`. |
| `auto_approval_review` | When auto-approval policy kicks in, this event carries the review text. |
| `prompt_suggestion` | Suggested follow-up prompts for the user. |

## Subagent model attribution

Subagent lifecycle rows may carry the child `model` and `reasoningEffort`. For
Claude, the service resolves the model from the task lifecycle frame or the
native `Agent`/`Task` tool input, including tool input that arrives after the
lifecycle frame. If a start row was already emitted with inherited parent
metadata, the late input updates the live snapshot and emits a corrected start
row so the renderer's model chip reflects the child that actually ran.

Claude `getSubagentTranscript` reads also attach `subagentMetadata` to the
provider message shape with the child thread id, parent thread id, and the
first model found across the historical/current SDK message shapes. The
renderer treats a reported model as authoritative and shows the parent model
as **inherited** only when no child model was reported.

Every inline `SubagentSpawnCard` / `SubagentResultCard` also wears the owning
runtime's provider mark at the bottom-right of the card (the same 20px mark the
Work session rows use, from the same `chatToolTypeForProvider` mapping), so a
thread makes clear which provider the main chat is calling. A runtime-native
subagent inherits the chat's provider — that is the runtime that ran it. A
spawned ADE child chat can run on a different provider, so `AgentChatPane`
resolves the child's own provider from the session list and the card wears
that; an unresolved child falls back to the parent runtime's mark rather than
rendering nothing or a guess.

## Claude context guardrails

Live Claude occupancy emits at most once every five seconds and only after a
one-point percentage change. ADE never preempts the SDK's natural compaction.
The streamed reading is refreshed from authoritative SDK `getContextUsage()`
snapshots after runtime initialization, every settled turn, and compact
completion. A compact start emits `compacting`; completion emits
`recalculating` until exact `postTokens` or the control snapshot establishes the
new measured value. A failed snapshot emits `unknown`, so an old 100% is never
presented as fresh.

It sends a fallback `/compact` only at a turn boundary when all three gates
hold: occupancy is at least 97%, no natural `context_compact` has appeared
since occupancy crossed 90%, and no fallback was already issued in the same
high-water episode. The episode resets below 80%.

If a turn ends with `terminalReason: "prompt_too_long"` (or the equivalent
overflow signature), ADE compacts once and asks the user to re-send the last
message. It does not automatically replay that message.

## Canonical runtime events

`apps/desktop/src/main/services/chat/runtimeEvents.ts` defines the
provider-neutral event vocabulary that runtime adapters should emit
internally: `turn.started`, `content.delta`, `tool.started`,
`tool.completed`, `tool.failed`, `subagent.started`,
`subagent.progress`, `subagent.completed`, `teammate.idle`,
`task.completed`, `turn.completed`, and `compact.boundary`.

The current migration is additive for the *start* and *progress* halves
only. Claude still emits the legacy underscore subagent rows used by older
renderer paths, then `buildCanonicalAgentChatRuntimeEvent()` writes the
canonical dotted row beside it — except for `subagent_result`, which
`agentChatEventToRuntimeEvent` deliberately does not translate, so no second
end event can be minted. `subagent.completed` remains in the vocabulary as an
inbound runtime shape and a legacy transcript type; replayed transcripts that
still hold both halves of an old pair are collapsed on read by
`collapseLegacySubagentEndEvents` (`shared/chatSubagents.ts`) on desktop and
web, and by `collapseLegacyWorkSubagentResultEnvelopes` on iOS.
`AgentChatPane` filters the dotted rows from the transcript display because
they are coordination data, while subagent-specific panels can consume either
shape during the transition.

## Structured activity normalization

Adapters preserve provider richness while converging on compact event shapes:

- Claude server `web_search` / `web_fetch` blocks become `web_search` start
  and terminal events. Claude Agent SDK `WebSearch`/`WebFetch` results and
  text-block citations become sources (see Sources). Claude MCP blocks become paired tool events; unfinished
  server activities are closed when the turn ends.
- Codex 0.144.5 `mcpToolCall` items retain plugin/app/resource metadata, while
  native web/image/subagent items keep their specialized compact rows.
- Cursor MCP calls and generated images, OpenCode image file parts, and Droid
  assistant image blocks reuse those same tool/image events. Cursor's native
  `updateTodos` tool is folded into `todo_update` + `plan` instead of a raw tool
  row, so it feeds the same task list the fenced `ade_update_plan` control block
  does.

### One task list per chat

Every provider's "what the agent is working through" lands in ONE task list per
chat. `apps/desktop/src/shared/chatTaskList.ts` owns it: `deriveChatTaskList(events)`
returns the current list (or null), and `reduceChatTaskList` applies one event.
Desktop (thread card and Chat Info pane) and the ADE Code TUI (transcript and
Chat Info pane) both read it. iOS does not yet: it still draws a plan card per
turn and folds same-turn todo rows into it (`WorkTimelineHelpers.swift`), and
ignores the optional `activeForm`, `cancelled`, and `priority` fields.

Sources, as each provider's SDK or protocol types them:

| Provider | Native shape | ADE event |
| --- | --- | --- |
| Claude | `TodoWrite` `{ todos: [{ content, status, activeForm }] }`; `TaskCreate` / `TaskUpdate` (`subject`, `activeForm`, `status` incl. `deleted`) | `todo_update` (with `activeForm`) |
| Codex | app-server `turn/plan/updated` (`TurnPlanStep { step, status: pending \| inProgress \| completed }`); the `update_plan` tool (`in_progress`, snake case); legacy `planningItem` | `plan` (`state: "updated"`); `todo_update` for `planningItem` |
| Cursor | `updateTodos` `{ todos: [{ content, status: pending \| inProgress \| completed \| cancelled }] }`; the `ade_update_plan` fence | `todo_update` + `plan` from one call |
| OpenCode | `todo.updated` `Todo { content, status: pending \| in_progress \| completed \| cancelled, priority }` (v2 has no id) | `todo_update` (position ids) |
| ACP | `plan` / `plan_update` `{ entries: [{ content, priority, status }] }`, `plan_removed` | `plan` (with `priority`); `plan_removed` → `plan` with no steps |
| Droid | `TodoWrite` `{ todos: string }` (a text checklist, or a JSON array `{ id?, content, status, priority? }`) | tool row + `todo_update` (ids `1..n`) |

Rules:

- Each update carries the whole list, so the newest one replaces what came
  before, across turns and across the two shapes.
- A `todo_update` written onto a plan of the same turn, or one whose items the
  plan already names in full, updates that plan's items instead: an item with
  the same text takes the new status, an item with new text is appended
  (`foldTodoItemsIntoTaskItems`, `todoItemsCoveredByTaskItems`). This is how the
  Cursor pair and the control fence stay one list.
- An empty `todo_update`, and a `plan` with no steps and no text, clear the list.
- Codex plan-mode proposals (`plan` with no steps and `streamingText`, or
  `state: "delta" | "complete"`) are not task lists. They keep their plan card
  and the `plan_approval` flow, and never create or clear the list.
- Statuses are unified to `pending | running | done | failed`. A provider
  `cancelled` item is settled: on the wire it is `completed` plus
  `cancelled: true` (iOS decodes the todo status as a closed enum, so the wire
  keeps a status every client knows), and the list shows it as done, dimmed and
  struck through, with a "skipped" note. It counts toward done.
- Items are `{ id, label, status, activeLabel?, skipped?, note?, priority?, children? }`.
  `id` is the provider's id or a position id (`step-N` for plans). Claude's
  `activeForm` is `activeLabel`, shown instead of the label while the item runs.
  ACP `priority` is carried but not drawn. `children` (one level) is supported by
  the renderer; no provider reports sub-items yet.
- The list's label is the plan explanation when it is one line of at most 60
  characters, else `Plan` (plan sources) or `Tasks` (todo sources). Counts are
  always derived from the items.

**In the thread.** The collapse pass turns every list event into ONE
`task_list` row keyed `task-list:<sessionId>`. Each update removes the row from
where it was and appends it where the event landed, keeping the key, so the
card sits at the turn of the latest update and no older plan card or todo row
remains. A cleared list removes the row. The move repairs every carried row
index, so the incremental collapse stays identical to a full replay. The row
never folds (`classifyTurnFoldEvent` keeps `task_list`).

The card (`ChatTaskListCard.tsx`) is collapsed by default to one line —
`label · done/total · current item` plus a small progress bar
(`chatTaskListCurrentLabel`). The current item is the running one (its
`activeLabel` when it has one), else `Next: <item>` for the first pending one, so
a list nobody has started reads `Tasks · 0/4 · Next: Search the web`. A settled
list reads `All done`, or `N failed` when any item failed; it names no single
item, because the last done one is not what the reader needs next. A click expands the full list and the next click collapses it; the open
state is kept per chat in memory, so it survives the row moving and the
virtualizer unmounting it. Rows use a 14px rounded box: done is a green tint with
a check drawn by `pathLength`, failed a red box with an x, running a 1px line
travelling under that row only, pending an empty box. Done rows dim to 65% and
settle 1px; motion respects reduced-motion.

When a reader is scrolled up, the existing list anchor keeps the rows on screen
in place as the card leaves the rows above them. The anchor capture skips the
task-list row itself: anchoring to a row that moves would ride it down the
thread.

Every event uses the provider item id (plus turn id) as its lifecycle key.
Desktop `chatTranscriptRows`, ADE Code `aggregateChatBlocks`, and iOS
`WorkEventMapping`/`WorkTranscriptParser` therefore update one row instead of
printing repeated start/progress/result records. Sources (below) derives from
this same stream; it is a view, not a second persistence channel.

## Sources

Every provider feeds one source model, `apps/desktop/src/shared/chatSources.ts`
(the renderer's `chatSources.ts` re-exports it). `deriveChatSources(events)`
returns every `ChatSource` in first-seen order, the four groups the drawer
shows, and `byTurn` for the thread.

- **Inputs.** `web_search` results and URL actions (`open_page`/`openPage`/
  `find_in_page` → `fetched_url`, the rest → `web_search_result`);
  `tool_result.sources`; `sources` events; MCP tool calls (connected apps) and
  URL records inside MCP JSON results; user attachments and Linear issue
  context. Failed searches and failed tool results contribute nothing.
- **Dedupe.** `normalizeSourceUrl` gives one page one key: `http:` and
  `https:` match, the host is lowercased without `www.`/`m.`/`mobile.`/`amp.`
  (and `en.m.` → `en.`), credentials, a default port, `#fragment`, a trailing
  slash, and a trailing `/amp` segment are dropped, tracking params
  (`utm_*`, `fbclid`, `gclid`, `msclkid`, `ref_src`, `?ref=<hostname>`, …) are
  dropped, and the remaining params are sorted. `?ref=main` or `?ref=v1.2.3`
  (a git ref) is kept. Path and query values keep their case. Files dedupe by
  path. A merged source keeps the union of `kinds`, `queries` (at most five),
  `turnIds`, and `itemIds`; the richest title wins (a real title beats a URL or
  file-name fallback, then the longer real title); `cited` is sticky.
- **Titles.** A page reported without a title (Claude `WebFetch` sends only a
  URL) is titled by its domain and path: `anthropic.com/research`, or
  `deepseek.com` for a site root. `chatSourceSubtitle` returns no domain for a
  title that already names it, so a row never prints the same domain twice.
- **Attachments.** A file the user attached is titled by
  `attachmentDisplayName`: staged files carry a generated `<uuid>.<ext>` name,
  so a pasted image reads "Pasted image" and another staged file "Attached PDF
  file" (a name after the uuid, or any other real name, is kept). Its second
  line is "Attached by you", never the stored path. iOS Sources lists no user
  attachments.
- **Cited by a link.** A source is also cited when an assistant `text`
  event links to it, in any turn: a markdown link, an autolink, or a bare
  URL, matched with `normalizeSourceUrl` (`linkedSourceUrls`). Fragments of
  one message (same `messageId`, else turn and item) are joined first, so a
  URL streamed across two fragments still matches. Only a source already in
  the list is marked; a link never adds a source, and user messages never
  cite. This is provider-neutral: most models write markdown links, and only
  some providers send structured citations.
- **Groups.** Cited (any citation, or linked from an answer) → Web (has a
  URL) → Files (attachments, memory files, file links) → Apps (connectors
  with no URL). Each source is in exactly one group; a cited page is listed
  under Cited only.
- **Per turn.** `byTurn` counts what the agent used in that turn: web results,
  fetched pages, citations, and files it read. Apps and user attachments are
  left out.
- **Icons.** Rows draw the site's favicon, fetched first-party by the brain
  through the `chat.resolveSourceFavicons` action (below). Until it arrives,
  and when a site has none, a row draws the domain's (or file name's) first
  letter.

### Favicons

`apps/desktop/src/main/services/chat/sourceFaviconService.ts` resolves them.
The icon is fetched from the site the agent already visited, directly by the
machine running the brain, never through a third-party favicon service (the
Google s2 endpoint t3code uses would learn every domain a chat touched).

- **Action.** `chat.resolveSourceFavicons` takes `{ domains: string[] }` (at
  most 48; `domain` or `url` also work) and returns `{ icons: { [domain]:
  dataUrl | null } }`, keyed by each input as given. Desktop reaches it through
  `window.ade.agentChat.resolveSourceFavicons` → the bound runtime's `chat`
  action domain (an unbound window gets `{ icons: {} }`). The hosted web client
  sends the viewer-allowed `chat.resolveSourceFavicons` sync command, which is
  runtime-scoped, so a personal chat with no project gets icons too. iOS can
  send the same command; its web-search `Sources` chips do not draw favicons
  yet. The CLI reaches it with `ade actions run chat.resolveSourceFavicons`.
- **Resolution.** `GET https://<host>/`, then the `<head>`'s
  `<link rel="icon" | "shortcut icon" | "apple-touch-icon">`: a declared
  32–64px icon first, then SVG, then an undeclared size, then smaller, larger,
  and touch icons. Up to three candidates are tried, then `/favicon.ico`. A
  host whose apex does not resolve is retried as `www.<host>`.
- **Limits and SSRF.** HTTPS on port 443 only, no credentials in the URL.
  `localhost`, `*.local`/`*.internal`/`*.lan`, single-label names, and private,
  loopback, link-local, CGNAT, multicast, and documentation addresses are
  refused. DNS is resolved and every answer checked before connecting, and the
  connection is pinned to the vetted address. At most 3 redirects, each hop
  checked the same way. A 3 s wall clock per request, 256 KB of page HTML, and
  64 KB per icon. An icon must be served as `image/*` and be a PNG, JPEG, GIF,
  WebP, ICO, or SVG by its bytes. A multi-size ICO is trimmed to its ~32px
  frame; one cut at 64 KB is kept only when a whole frame arrived. An SVG with
  script, event handlers, `javascript:` URLs, or foreign objects is refused.
  Renderers draw icons through `<img>`, which never runs SVG script anyway.
- **Cache.** One JSON file per host under
  `<ADE home>/cache/favicons/<sha1(host)>.json`: 7 days for an icon, 1 day for
  "none". Past 8 MB the oldest files are removed down to 80%. A bounded memory
  map fronts the disk, and concurrent requests for a host share one fetch
  (six fetches at a time). An offline or timed-out fetch is remembered for 10
  minutes in memory only, so a flaky network does not blank an icon for a day.
- **Renderer.** `useSourceFavicon(domain, visible)`
  (`components/chat/useSourceFavicon.ts`) keeps a session-wide in-memory map,
  requests a domain only once its icon has been on screen
  (`IntersectionObserver`), and batches every row that asks in the same tick
  into one call (32 domains per call). Icons are `data:` URLs, which both the
  desktop renderer CSP and the hosted web `_headers` CSP allow in `img-src`.
  An icon that fails to decode falls back to the letter.

### Where each provider's sources come from

Adapters live in `apps/desktop/src/main/services/chat/chatSourceAdapters.ts`,
bounded by `boundChatSourceRefs` (http(s) only, deduped, 20 per event).

| Provider | Native shape (verified against) | ADE event |
|---|---|---|
| Codex | `webSearch` item `{ query, action: WebSearchAction \| null, results }`; `WebSearchAction` is tagged by `type` (`search`, `openPage`, `findInPage`, `other`; legacy snake_case). `agentMessage.memoryCitation { entries: { path, lineStart, lineEnd, note }[], threadIds }` (`codex app-server generate-ts`, v2 `ThreadItem`, `MemoryCitation`). | `web_search` with `actions`/`results`; memory citations → `sources` event (cited `file` refs, note as snippet). Subagent transcripts read `action.type` and keep actions/results. |
| Claude (server tools) | `web_search_tool_result` → `WebSearchResultBlock { url, title }[]`; `web_fetch_tool_result` → `WebFetchBlock { url }` (`@anthropic-ai/sdk` messages.d.ts). | `web_search` via `claudeStructuredActivity.ts`. |
| Claude (Agent SDK tools) | `tool_use_result` of `WebSearch`: `WebSearchOutput { query, results: ({ tool_use_id, content: { title, url }[] } \| string)[] }`; `WebFetch`: `WebFetchOutput { url, code, codeText, result, bytes, durationMs }` (`claude-agent-sdk` sdk-tools.d.ts). | `tool_result.sources` (fetches with `code >= 400` add none). |
| Claude (citations) | `TextBlock.citations`: `web_search_result_location { url, title, cited_text }`, `search_result_location { source, title, cited_text }`. Document locations (`char_location`, `page_location`, `content_block_location`) name no URL or path and are skipped. | `sources` event per assistant message, cited. |
| Cursor | `ToolName` includes `webSearch`/`webFetch` (`@cursor/sdk` agent/options.d.ts); no JSON types. Agent protobuf: `WebSearchArgs { searchTerm }`, `WebSearchResult.success.references { title, url, chunk }[]`, `WebFetchArgs { url }`, `WebFetchResult.success { url, markdown }`. The 1.0.31 local converter currently drops both tool calls, so this path fires only when the SDK forwards them. | `tool_result.sources` (none on `error`). |
| OpenCode | `ToolStateCompleted { input: Record<string, unknown>, output: string, title }` (`@opencode-ai/sdk` v2 types.gen.d.ts); tool names `webfetch`/`websearch` (its permission config). Input is untyped, so only `url`/`query` are read and output is scanned only when it is JSON. | `tool_result.sources`. |
| Droid | `@factory/droid-sdk` 0.9.1 types every tool as a generic `ToolUse { name, input }` / `ToolResult { content, isError }` and names no web tools. ADE uses an allowlist: `WebSearch` and `FetchUrl` (plus the generic aliases). | `tool_result.sources` (input remembered from the `tool_call`). |
| ACP | `AcpToolKind` `fetch`/`search`, `rawInput`, `locations`; `resource_link { uri, name, title?, description? }` (`acpHost/acpProtocolTypes.ts`). | `fetch` + `rawInput.url` → `fetched_url`. `search` counts only with a `query`, no path/glob/cwd/locations, and URL records in its output, so grep never becomes a source. A `resource_link` in a message renders as a markdown link (it used to become `""`) and emits a cited `sources` event; in tool content it becomes an uncited source. |

### Where sources show

- **Drawer.** `ChatSourcesPanel` is a drawer section for every provider,
  mounted only when `chatHasSources(events)` is true. It draws no scroller,
  border, or empty state (it returns `null` when empty). Each group header
  shows its label and full count; the group lists its first three rows and a
  `Show N more` toggle (`Show less` folds it back), tracked separately for the
  whole chat and each turn. A row is the 16px favicon, a one-line title, and
  the domain muted on the same line (a file's `path:lines` or an app's actions
  go on a quiet second line). Clicking opens the link; hovering shows a copy
  button. A cited row carries a small `cited` mark. Opened from a turn chip it
  lists that turn's sources with `This turn · Show all`.
- **Turn chip.** `N sources` with up to three stacked favicons sits on the
  turn-end line (`DoneTurnDivider`, next to the proof chip), not in the
  answer's hover footer. A turn's list keeps its identity while its sources
  are unchanged, so streaming does not re-render every turn-end row.
- **Fold row.** `· N sources` behind a globe icon (see Turn fold).
- **Rows.** Provider web tool rows (`webSearch`, `websearch`, `webfetch`,
  `FetchUrl`, …) use the same globe meta as Claude's `WebSearch`/`WebFetch`
  instead of the warning glyph, and list their `sources` as result links.

### Provider retry and reconnect presentation

Automatic retry and transport recovery are replaceable live state, not
conversation content. The Claude `api_retry`, Codex app-server `willRetry`,
OpenCode `session.status` retry, Pi `auto_retry_start`, and Cursor SDK thread
recovery paths normalize to the existing live `activity` event. The detail
uses the provider display name and includes attempt, maximum, and backoff only
when the adapter supplies trustworthy values (for example, `Reconnecting to
Claude · attempt 6 of 10 · retrying in 8s`). Desktop, hosted web, ADE Code,
and iOS can therefore keep one working indicator current instead of appending
one card per attempt.

Raw provider messages, HTTP codes, request ids, and retry actions remain
diagnostic data or terminal error detail. A retry that succeeds leaves no
transcript row; an exhausted retry becomes one terminal `error`. Authentication,
quota, permission, context-overflow, cancellation, and other non-retryable
failures retain their existing visible treatment. ACP v1 does not define a
standard retry-progress event, and adapters do not invent retry counts for ACP,
Droid, or another provider when the host has no explicit recovery in flight.

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
     state; the compact while-you-were-away card scrolls to these stable keys.
   - `subagent_started` / `subagent_progress` / `subagent_result`
     events collapse per agent (keyed by `agentId ?? taskId`) into ONE
     row: a `subagent_spawn_anchor` while the agent is running, which the
     terminal event converts IN PLACE into a `subagent_result_card` when
     the agent completes, fails, or stops. The row keeps its position, its
     key, and its voice call, so a card never moves when it finishes: three
     running cards side by side become finished cards one by one in the
     same row. A late result (after the parent's `done`, even during a
     later turn) settles the card in place the same way. Only a result
     whose spawn row is not in the window (its start sits in an unloaded
     older page, or the result is the agent's only lifecycle event) appends
     a card where it arrives; loading the older page replays it into its
     spawn slot, because the layout is a pure function of the events. A
     settled card is never reopened by a late progress tick. A mass stop of more than
     `SUBAGENT_CARD_GRID_MAX_COLUMNS` (three) adjacent report-less
     stopped cards folds into one `subagent_stopped_group`; fewer stay
     cards (see Side-by-side grids). Backgrounded
     shell commands collapse to a single `background_job_line`, pushed on
     the job's first sighting (so a running job is visible in the thread)
     and mutated in place through to its terminal state, which is never
     reopened by a late progress tick. Two producers feed that one row and
     share its key space: the LIVE runtime, which reports background
     shells only as `scheduled_work_update {kind:"background_task"}`
     (`emitClaudeBackgroundTaskUpdate` — it emits no subagent lifecycle
     events for them at all), and legacy `subagent_*` events carrying
     `taskType: background`, which is all older persisted transcripts
     hold. Other scheduled kinds are unaffected. Classification can
     legitimately flip mid-task, so both directions are guarded: once a
     task has opened a job line it stays a background job (a late
     `agentType` cannot strand the running line and push a card pair for
     the same task), and a task that proves itself a real subagent has
     its job line spliced out before the spawn anchor lands — the
     level-set path gates only on task type, so an agent that reports
     none falls through to the background emitter and would otherwise
     render as a line *and* a card pair. The
     anchor keys (`subagent-spawn:` / `subagent-result:` /
     `background-chip:<agentKey>`, the last kept from the finish-chip era
     on purpose) never change on rebind so the
     virtualizer's measured heights survive. A card's key is fixed when its
     row is pushed (`cardKey`): `subagent-spawn:<agentKey>` for the normal
     case, kept through settling, and `subagent-result:<agentKey>` only for
     a card appended without its spawn. A jump that names either key lands
     on the card (`subagentCardRowKeyCandidates`, used by
     `subagentCardGridKeyByMemberKey`), so an older `subagent-result:` jump
     target still resolves. An event anchor on a progress or result event
     lands on the card it updated (`subagentCardKeyForLifecycleEvent`), not
     on the last row. A `transcript_retraction` splice repairs each stored
     row index, including the `backgroundJobRowIndexByKey` map that
     resolves job lines. Raw lifecycle events are then hidden.

     **Card names.** A card is titled with the agent's name, never its
     path or its current activity. `deriveSubagentCardName`
     (`shared/chatSubagents.ts`) applies one rule to every provider: the
     spawn's `description` (Claude's Task description, OpenCode's session
     title, Cursor's and Droid's task description, the agent path Codex
     chose), then the explicit `label` (Claude's Task `name`, a Codex
     nickname, Cursor's label), then `agentType` (Claude's
     `subagent_type`). A path or snake_case id is humanized from its last
     segment (`/root/desktop_scan` reads `Desktop scan`,
     `/ROOT/SHIP_POLL_927` reads `Ship poll #927`). OpenCode appends the
     agent to a child session's title (`Explore renderer UI (@explore
     subagent)`); a trailing `(@<agent> subagent)` or `(@<agent>)` is
     dropped, so the card reads `Explore renderer UI`. Sentence case keeps
     known acronyms (iOS, CLI, TUI, UI, UX, API, IPC, PR, CI, SDK, MCP,
     DB, JSON, URL, HTTP, SQL, CSS, HTML, AI, ID), so
     `/root/ios_shared_scan` reads `iOS shared scan` and `cli_tui_scan`
     reads `CLI TUI scan`; the iOS mirror in
     `WorkStatusAndFormattingHelpers.swift` does not have the acronym map
     yet. Placeholders
     (`Subagent task`, `Delegated task`, `Background work`, `subagent`,
     `opencode-subagent`) are skipped, and nothing usable reads
     `Subagent`. The collapse pass takes the title from
     `subagent_started` only (`nextSubagentTitle`): Claude's
     `task_progress` frames carry the current activity in `description`
     (`Running …`, `Reading <path>`), and the old longest-description
     rule promoted that to the title. A repeated start replaces the title
     only when it names the same task more fully (`Find` → `Find update
     modal component`) or the title is a placeholder. When the start sits
     in an unloaded older page, the label or agent type names the card
     before any progress description does. The longest description still
     drives classification and background job labels. The stopped-group
     items, the `spawned by` parent label, and the Chat Info subagents
     row (`chatSubagentDisplayName`) use the same name, so a Codex agent
     never shows its raw `/root/...` path there either. Chat Info keeps
     the start's description as the name: a later progress frame only
     fills it in when no start named the agent.

     **Card layout.** `SubagentSpawnCard` and `SubagentResultCard` share
     one frame and one container (`SUBAGENT_CARD_CHROME`: the same border,
     background, radius, and padding), so running and settled cards in one
     grid look alike and only the badge and the status line tell them
     apart. A spawned chat's kind shows only as its `SUBAGENT` / `PEER`
     chip, never as a tinted frame. Inside the frame: the agent's identicon on the left, the name (truncated),
     one mono status line, then the body, with open/Stop controls and the
     provider mark on the right. While running, the identicon wears its
     spinning ring and the status line reads `running · <activity> ·
     <N> tools · <elapsed>`. Once settled, the identicon wears a solid
     badge: a green check (finished), a red X (failed), or a neutral
     square (stopped). The status line reads `ran for 1m · 12 tools ·
     34k tokens`, prefixed `failed` or `stopped · <who stopped it>`, and
     the report follows as plain text, clamped to three lines. Reports are
     markdown, so the card reads them through `subagentSummaryPlainText`
     (`shared/chatSubagents.ts`): headings, list, quote, and table markers,
     rules, and fence lines drop; emphasis, code spans, and links keep their
     text; lines join into one paragraph, and a heading or list item with no
     closing punctuation gets `:` / `;` (`## Summary` + `**ADE** is…` reads
     `Summary: ADE is…`). The stopped group's rows (title and last
     activity) and the Chat Info subagent drawer (also clamped to three
     lines) read the same way. The stored report is unchanged. An OpenCode child's
     diff-stat summary with every count at zero (`+0 −0 · 0 files`) is not
     a report and is not shown (`isEmptyDiffStatSummary`); a stat with any
     non-zero count is. A stopped card shows a
     summary only when it says something of its own
     (`meaningfulStoppedSummary`): a stop sentence (`Interrupted`,
     `Stopped: the ADE brain restarted`) or runtime filler (`Agent
     active`) restates the status line. Without one, the body reads the
     agent's last activity and whether its work survived
     (`stoppedResultOutcome`: `work lost` or `report landed`), so a grid
     cell is never an empty frame. A failure keeps its full
     error behind a quiet `Details`, and a worktree result keeps its
     copy-worktree button. Clicking a card (or its caret button, the
     keyboard path) opens a spawned chat, or opens the agent's transcript
     in Chat Info for a runtime-native agent. That transcript is offered
     only inside a host that listens for `ade:chat:open-info`
     (`ChatInfoHostContext`). There is no separate "view transcript"
     link. A click that is a text selection, or a click on a control
     inside the card, does not open it. The spawn-kind chip (`SUBAGENT`
     / `PEER`) and the `background` chip stay. The agent-type pill is
     gone because its text is now the title.

     **Side-by-side grids.** Consecutive subagent cards of ANY state
     (running, finished, failed, stopped) join a single
     `subagent_card_grid` row (`groupSubagentCardGrids`). Cards settle in
     place, so a grid keeps its cards, its order, and its key while agents
     finish one by one; each card keeps its own status badge. A
     `subagent_stopped_group` ends a run.
     The only rows a run steps over are `subagent_spawned` notices with
     `hasInlineCard`, which draw nothing; they move ahead of the grid.
     `SubagentCardGrid` lays the cards out on a six-track CSS grid (the
     least common multiple of one, two, and three columns). Rows fill left
     to right at up to three cards; each card in a full row spans one
     column, and the cards of a short last row share the full width
     equally (`subagentCardGridSpan`): 5 cards read 3 + 2 wide, 4 read 3 + 1
     full width, 7 read 3 + 3 + 1. Full rows are never rebalanced, so a new
     spawn never moves an earlier card to another row. The column count
     comes from a container query on the grid's own width, at the
     breakpoints `subagentCardGridColumns` uses for height estimates (cards
     never narrower than 232px): three columns from 712px, two from 472px,
     else one, each with the same fill rule. The span classes are literal
     strings in `subagentCardGridCellClass`; a count change only rewrites
     them on the keyed cells, so no card remounts. Grid cells stretch, so
     cards in one grid row are equally tall.
     The grid row's key is its first member's own row key, and it lists
     `memberKeys`. A lone card renders through the same grid component
     with one member. So when a second card joins, the first stays
     mounted and keeps its measured height, since a side-by-side row is
     about as tall as one card. Only a grid whose first member leaves (into
     a stopped group) takes the next member's key.

     **Stopped-group fold.** `groupStoppedSubagentResultCards` folds a
     run of more than `SUBAGENT_CARD_GRID_MAX_COLUMNS` consecutive result
     cards that share a cause and attribution. A stopped card joins a run
     only when it has nothing of its own to say: no report landed before
     the stop (`resultLanded`) and no meaningful summary
     (`stoppedGroupCauseOf`). A run of three or fewer stays cards for the
     grid. The fold runs inside `groupChatTranscriptRows`, before the
     presentation filter, so it steps over rows the timeline never draws
     (`work_log_group`, and `subagent_spawned` notices with
     `hasInlineCard`) itself: a tool burst between two casualties does
     not split a mass stop. When the run folds, those hidden rows move
     ahead of the group; when it does not, every row keeps its place. The
     group lists `memberKeys` (the folded cards' own keys, normally
     `subagent-spawn:`), and jumps resolve them, and their
     `subagent-result:` aliases, to the group row the same way they resolve
     grid members. Because cards settle in place, a folded run can sit
     inside a longer run of cards in other states. Only the CONTIGUOUS
     casualties fold, and the group takes their place: no card moves past
     another, and the cards before and after it form their own grids. So
     `A` running, `B`–`E` stopped with no report, `F` finished reads `A`,
     `4 agents stopped`, `F`, in that order. Gathering casualties from
     across the run into one group would reorder the cards around it; two
     separate folded runs read as two groups. `SubagentStoppedGroupCard` shows each agent's
     `stoppedGroupItemOutcome` (`work lost` / `report landed`) at the
     right of its row.

     The grid pass runs in `AgentChatMessageList`'s `presentedRows`, in this
     order: second-layer grouping (`groupChatTranscriptRows`, including
     the stopped-group fold), then the presentation filter (drops
     `work_log_group` and covered `turn_diff_summary`), then
     `mergeAdjacentActivityBundleRows`, then `groupSubagentCardGrids`,
     then `groupBackgroundJobRuns`, then the turn fold, then
     `mergeAdjacentThoughtRows` (see "Thought runs" under Reasoning merging). Grouping after the filter means rows the
     timeline never draws cannot split a run. Grouping before the fold
     means the fold sees one grid row. The fold classifier does not know
     that row type, so it keeps the row visible, exactly like the cards
     it replaces. Grids, running, settled, or mixed, stay visible below
     the fold row, in their place above the answer; a card that settles
     after the turn ended keeps that status (both states are kept, so the
     sticky decision never changes). A grid never straddles a span,
     because user messages and answers end runs. The turn-end snapshot's subagent
     count reads the collapse rows, so it counts each agent. A jump,
     highlight, or event anchor that names a member card resolves to its
     grid row (`subagentCardGridKeyByMemberKey` in `scrollToRowKey`;
     member keys in `resolveAnchoredChatRowIndex`), and a folded
     casualty resolves to its `subagent_stopped_group` the same way.

     **Background job runs.** Consecutive `background_job_line` rows,
     whatever their labels and statuses, join ONE `background_job_group`
     row (`groupBackgroundJobRuns` in `chatBackgroundJobRuns.ts`). The
     pass runs in `presentedRows` right after `groupSubagentCardGrids`,
     so rows the timeline never draws (tool groups between the jobs)
     cannot split a run, and `subagent_spawned` notices with
     `hasInlineCard` move ahead of the group. The group's key is its
     first member's own row key and it lists `memberKeys`, so a lone job
     line that gains a neighbour stays mounted with its measured height.
     A run also splits where the turn fold would split it: a job still
     running when its turn ended (in any turn-end snapshot's
     `liveRowKeys`) never shares a row with jobs that finished before
     then. A live turn's jobs have no snapshot yet, so they always share
     one row. Jumps (`scrollToRowKey`), event anchors
     (`resolveAnchoredChatRowIndex`), and a scroll-memory anchor that
     names a member resolve to the group row
     (`backgroundJobGroupKeyByMemberKey`).

     `BackgroundJobRunRow` draws both shapes as one compact, left-aligned
     line in thread text size — deliberately not a card or a centered
     divider, because background jobs are frequent and rarely the point
     of the turn. A single job reads `$ <command> · <duration> ·
     <status>` (`done`, `failed`, `stopped`, or `running` with a
     once-per-second ticker anchored to the real start timestamp), with
     Stop while it runs and `open ›`. A run reads `$ 5 background jobs ·
     1 running 47s · 3 done · 1 failed ›` (the failed count in red, the
     running count ticking from the oldest running job); clicking it
     lists each job inline with a status icon, the truncated label, its
     duration, `failed`/`stopped` when it did not finish, Stop while it
     runs, and `open ›`. The scheduled-work wire format carries no exit
     code, so a job reported only through the live producer shows a
     duration measured from its own first sighting. `open` dispatches
     `ade:chat:open-info` with the job's task id to reveal the chat
     actions pane, where the job's full state and output live, and is
     omitted where no host registered a listener for that event. In an
     ended session a job still marked `running` shows no duration and
     no Stop.

     **Scheduled work.** An activity bundle's wake-up, cron, loop, or
     remote-trigger item (`scheduled_work_update` other than
     `background_task`) renders as one compact `ScheduledWorkLine` in the
     same idiom: `⏰ Wakes in 20m · <reason>`, `Woke at 14:30` once it
     fired, or `⟳ Cron · every 30m · next 14:30`. A bundle holding only
     scheduled work stacks those lines with no card around them. Task lists
     are never bundled; they are the chat's one `task_list` row. Clicking a line opens
     the chat actions pane. The fold keeps a line visible when its
     schedule was still pending at turn end and folds it otherwise; the
     `Woke on schedule` divider before the woken turn is unchanged.
   - `ade_card` collapses per `cardId` into ONE permanent chronological row
     keyed `ade-card:<cardId>`. A repeat emit mutates that row in place — a new
     object under the same key, merged over the previous payload, so an update
     that omits `rows`/`metrics` patches rather than blanks them — which keeps
     the row at its original position and preserves the virtualizer's measured
     height as a long-running card (CI, a build, an artifact pull) progresses.
     When a detail refresh fails, `degradedReason` does not destructively
     replace an earlier rich payload: rows/progress/metrics survive with
     `stale: true`, and a first-time empty failure renders `detail unavailable`
     plus its retry action instead of a false-green zero-count card. Emitters
     may provide `durationMs` only for a real measured run; the renderer labels
     the card update span as `tracked` so it is never presented as work time.
     `rowsTruncated` becomes a compact `+N more` summary.
     It is deliberately NOT activity: it is never classified by
     `classifyActivityPhaseRow` and never bundled, so an interleaved
     reasoning/work phase cannot swallow it. The payload contract and its
     helpers live in `apps/desktop/src/shared/adeCard.ts`, shared with the TUI;
     iOS mirrors it. Every surface renders `fallbackText` + the `navTarget`
     deeplink for a `variant` it does not recognize, which is what makes one
     wire contract safe across three independent release trains. There is no
     red tone in the vocabulary — failures are amber, per the house policy in
     `SubagentActivityCards.tsx`.
   - `pending_input_resolved`, `activity`, `step_boundary`, raw tool/
     command/file-change events, standalone reasoning events, and
     `scheduled_work_update` are hidden (consumed by other derivations).
   - `transcript_retraction` is also hidden, but mutates the accumulated
     rows by removing prior assistant `text` rows whose provider
     `messageId` was retracted or superseded.
   - `turn_diagnostics` snapshots and the turn's recovery receipt
     (`turn_recovery`, or the legacy `codex_turn_recovery` alias, which never
     replaces a provider-neutral receipt) merge into ONE `turn_details` row
     per turn, drawn as a single `Turn details` line whose summary adds the
     counts up (`Recovered · 2 safety checks · 3 optional integration
     warnings`) and whose body lists everything. Codex files diagnostics under
     two keys — its session-startup key (MCP startup, before the turn has an
     id) and the turn id — so an id-less snapshot joins the details row of the
     window it arrived in (since the last user message or own `done`), and a
     snapshot naming a turn joins that turn's row or the window's row that has
     no turn yet. The row is created where the turn's first contribution
     lands and keeps that position and its key (`turn-details:<turnId>`, or
     `turn-details:<first event's row key>` when that contribution had no
     id), so live, incremental, and reload collapses agree. Integrations are
     deduped by name; checks are summed across the two keys.
   - Warning notices (`severity: "warning"` or `noticeKind: "warning"`, other
     than usage and sign-in notices) render as one text-sized line: an amber
     warning icon and the message on one truncated line, without the
     provider's leading `⚠`. Clicking it shows the full message and any
     detail. Error notices keep their cards. Warnings stay separate rows
     rather than entries of the Turn details row: a warning after the answer
     must stay visible outside the fold, and folding it into a details row
     created earlier in the turn would hide it.
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
   emits one merged `Thought` row and one merged work-log group in
   chronological first-occurrence order. Simple one-thought + one-tool
   turns stay as two grouped envelopes. Shared logic lives in
   `apps/desktop/src/shared/chatActivityPhase.ts`; desktop wires it through
   `groupChatTranscriptRows()`, the TUI through `aggregateChatBlocks()`,
   and iOS through `collapseActivityPhaseTimelineEntries()`. Rows that the
   client never draws (automatic `context_usage` snapshots, same-provider
   handoffs) are removed before grouping on desktop, so a hidden row cannot
   split one thinking run into two `Thought` rows.

4. **Client presentation.** Grouping remains lossless, but normalized tool,
   command, hook, and web-search groups no longer occupy permanent transcript
   rows. During a live turn they are available from the expandable working
   status; after `done` they collapse into one `N tools · M files` summary
   stacked immediately above the turn's existing time/usage line, left-aligned
   with Thought. Expanding lists the tools and files between that summary and
   the time/usage line, which stays last. On desktop the `work_log_group` envelopes are filtered out of the
   rendered timeline entirely rather than rendered empty, so they do not
   consume row gaps. File changes share that same combined summary (unless a
   checkpoint `turn_diff_summary` already covers the turn), instead of once per uninterrupted burst of tool
   entries — a turn whose bursts were broken up by prose used to stack six
   near-identical panels through one reply. Assistant narration is unchanged.

   **Desktop and hosted web** implement this in `AgentChatMessageList` through
   `ChatTurnWorkSummary` on the done divider: one expandable `N tools · M files`
   row sits immediately above the turn's existing time/usage cutout, left-aligned
   with Thought; expanding lists tools (`ChatToolActivityDetails`) and files
   between that summary and the footer, which stays last. The list filters
   `work_log_group` envelopes out of the rendered timeline entirely so grouped
   tools never occupy a second inline row. When the turn folds (step 5), the
   tool and file counts and their disclosure move to the fold row, and the done
   divider keeps time, usage, the proof chip, and the checkpoint diff.

   **iOS** puts the same counts on `WorkTurnEndMarkerView` at each
   `turnEndMarker`, including turns that pause at a usage limit (the marker
   shows the work summary and folds usage into the marker instead of a separate
   usage row beside it). Tapping opens that turn's tool/file activity in a
   sheet. `workPresentedTimelineEntries` drops `.toolGroup` and `.changedFiles`
   rows only when `workTurnToolActivityIndex` attached them to a completed
   turn; a markerless or unterminated cluster that a later turn-end never
   claimed stays inline. Chat Info still retains the underlying events.

   **ADE Code** mirrors the stack in `ChatView.tsx` `turnEndRows` on each
   `turn-end` block: collapsed `N tools · M files` when present, expanded tool
   and file entry rows when open, then the time / `Ran for` / status footer
   last. Settled `tool-calls-group` and non-live `files-changed-group` blocks
   are omitted from scrollback (`isTranscriptBlockVisible`). A turn that
   already has a checkpoint `turn_diff_summary` keeps that `[diff]` notice and
   leaves `turn-end.fileEntries` empty so the files half is not listed twice.

   This is capability preserving: clients show only events and file data the
   selected provider actually emitted, without synthesizing Claude-style file
   histories for other runtimes.

5. **Turn fold (desktop and hosted web; not yet ADE Code or iOS).** Once a
   turn has its `done` row, the rows between
   its user message and its answer fold into one row, so a finished turn reads
   user message → `Worked for 4m 12s · 18 tools · 3 files · 2 subagents` →
   answer → done divider. The rules are pure and UI-free in
   `apps/desktop/src/shared/chatTurnFold.ts` (for the TUI and iOS to adopt
   later); `deriveChatTranscriptTurnFolds()` / `applyChatTranscriptTurnFolds()`
   in `chatTranscriptRows.ts` adapt them to desktop's grouped rows. It is
   presentation only: events, storage, sync, and canonical text are unchanged.

   - **Live turns never fold.** Until `done` arrives the thread looks exactly
     as described above: interim text, Thought rows, cards in order, the
     working indicator.
   - **The answer** is the turn's last `text` row, or its last
     `phase: "final_answer"` row when the provider labelled one; a
     `commentary` row is never the answer. A turn with no answer (tool-only,
     interrupted before any text, an error) does not fold. Neither does a turn
     whose fold would hide nothing, or only trivial rows: status and
     diagnostics receipts (`status`, `activity`, `step_boundary`,
     `turn_details`, `turn_diagnostics`, `turn_health`, a subagent's `done`)
     and text or thought rows with no visible content
     (`isTrivialTurnFoldEvent`). Those rows then draw in place, with no
     `Worked for …` row over them.
   - **The span** is the rows strictly between the turn's user message and the
     answer. A turn with no user message (a scheduled wake, a background
     completion) starts after the previous `done`; a steer's user message
     starts a new span. Rows after the answer never fold — late proof,
     new PR/CI cards, the done divider. A late subagent result updates its
     card in place inside the span, where it is kept visible; only a result
     whose spawn is not in the window lands after the answer.
   - **Whose turn a `done` ends.** A `done` whose turn id appears on none of
     the window's rows, while other rows there do name a turn, is a
     subagent's (`isForeignTurnEnd`): it neither ends the window nor folds a
     turn of its own, and inside the span it folds as history. So the parent
     turn folds whether its subagents' `done` events arrive before or after
     its own. A `done` with no turn id folds under the id on the window's user
     message, else the id on its last assistant text (`inferTurnEndTurnId`).
     A cancellation's consecutive interrupted/failed `status` + `done` rows
     (parent plus subagents) still merge into one row, and that row is the
     parent's (`resolveTerminusParent`): its turn id, terminal reason, and
     model come from the `done` whose id matches the turn's user message, else
     the first id the turn's own rows carry, else a `status` row in the
     cluster, else an id-less `done` (given the inferred id). Only when none of
     that exists does the most-tokens `done` win. Usage and cost are still
     summed across the cluster.
   - **Only history folds.** Thought rows, interim (non-answer) text, a Codex
     plan-mode proposal card, finished activity bundles, the Turn details row,
     spawned/completed chips, compaction dividers, goal pills, the host-sleep
     chip, a finished stall card, and warning, info, hook, and config notices
     (including a usage notice marked `warning`/`info`) fold: they have nothing
     to act on. These stay visible below the fold row, in order, above the
     answer: subagent spawn, result, and stopped-group cards and their
     side-by-side grids; `ade_card` rows
     (PR/CI/review/merge/conflict, proof, quota, and any variant this build
     does not know); errors (with `ProviderFailureRecoveryCard` /
     `AgentCliAuthCard`); continuity-recovery and reset-credit notices; error,
     sign-in (`auth`), provider-health, thread-error, and limit-reached usage
     notices; interrupt receipts and queue-recovery cards; model-switch/handoff
     dividers; cloud status/artifact rows; completion reports; generated
     images; and any row type the classifier does not know. Background job
     lines and groups, lane-setup cards, approvals, structured questions, task
     lists, and scheduled work stay visible only if they were still live when
     the turn ended; a job group is live when any member was, and its members
     always share that fate (see Background job runs).
   - **Sticky.** Liveness is read from a snapshot the collapse pass takes when
     the `done` event is appended (`recordTurnEndSnapshot`, keyed by turn id,
     first `done` wins): the rows of that turn in their state at that moment,
     plus which approvals had a `pending_input_resolved` so far. A background
     job still running at turn end therefore stays visible after it exits, and
     one that finished before the turn ended folds. The snapshot's window
     follows the same rules as the fold: it steps over a subagent's `done`
     (recorded in `foreignTurnEndKeys`, no snapshot of its own), and an id-less
     `done` files its snapshot under the inferred turn id. Because the snapshot
     is a step of replaying events in order, the incremental live collapse and
     a full reload produce the same folds.
   - **The fold row** reads `Worked for <duration>` — the same measured
     duration as the done divider's `ran …`, shown whenever one is known —
     then non-zero tool, file,
     subagent, background-job, and source counts, each behind a small colored
     icon (wrench, diff, robot, terminal, globe). The source count is the
     turn's entry in `deriveChatSources(events).byTurn` (see Sources below),
     the same number the turn-end chip shows. The job count covers every job in the
     span, folded or kept, and reads `5 jobs (1 failed)` in red when any
     failed. Every count is pluralized (`1 tool`, `2 tools`, `1 job`) through
     `pluralCount`, and so are the open fold's tool and file toggles. The
     fold row and those toggles draw their focus ring for keyboard focus only
     (`focus-visible`); a mouse click leaves no outline.
     A duration under a second reads `<1s` (never milliseconds) on both
     (`formatTurnDuration`). A turn runs from its user message; a turn with
     none (a Claude internal follow-up after background subagents, a
     scheduled wake) runs from its own `status: started` event
     (`deriveTurnStartedAtMs`, `deriveTurnEndDurations`). A turn with neither
     has no known start, so both lines omit the duration (the fold reads
     `Worked`) rather than measure from whatever row came first.
     An interrupted turn reads `Stopped after <duration>`; the `done` event
     does not say who stopped it, so the row never says "you". Opening the
     fold lists the turn's tools and files through `ChatTurnWorkSummary`
     with `align="start"` (the checkpoint diff stays on the done divider), and
     then every row of the span in its original order — kept rows included,
     so a kept row sits between the rows around it, not under the fold row.
     A closed fold shows its kept rows right after the fold row. An open fold
     still hides an earlier text row of the turn whose trimmed prose is
     byte-identical to the answer (`TurnFold.duplicateAnswerKeys`): some
     models answer, call a tool, then generate the same answer again (Grok
     4.7 on Cursor does; the Cursor SDK run log shows two separate token
     streams, so it is the model, not a re-send), and the open fold would
     otherwise show it twice. The canonical transcript keeps both. With the
     copy (and the tools, which live in the tool toggle) gone, the Thought
     rows on either side of it sit next to each other and draw as one Thought
     row (see "Thought runs" under Reasoning merging). The fold
     label, the tool/file toggles, the tool list, and the Turn details and
     warning lines all start at the same left inset. Each fold is closed by
     default; open/closed is remembered per turn for the transcript view (in
     memory, bounded like the scroll memory).
   - **Scrolling.** Toggling a fold pins the fold row's on-screen position and
     suspends bottom-follow for that one change. Afterwards the view follows
     the bottom again if it ends there: after any toggle that suspended
     following, and after a close even from a scrolled-up view, since closing
     can reveal the end without a scroll event. Opening a fold at the bottom
     never chases the new bottom. A turn that folds while the view follows the
     bottom is re-pinned in the same commit, so no frame shows the shortened
     list off the bottom. A turn that folds while the reader is scrolled up
     keeps the first visible row where it was, or the fold row that swallowed
     it. That row is placed by its DOM position, or by the height model when
     it is no longer mounted (a long fold closing above a virtualized window).
     The virtualization threshold counts unfolded rows, so a fold never flips
     the list between its plain and virtualized render paths. Measured row
     heights are kept for rows hidden in a closed fold, so reopening it lays
     out on real heights.
   - **Jumps open the fold first.** A deep link or ⌘K search result
     (`setPendingSessionAnchor`), a `scrollToRowKey` jump (subagent "jump to
     result", the wake digest), and a minimap tick whose row is folded all
     resolve their target on the unfolded rows, open the fold hiding it, and
     finish on the next commit. They land on the row, highlight it, and
     re-land on the next two frames while the revealed rows measure. A target
     that is the answer, or sits in a live turn, is never hidden and jumps
     directly. A target that no longer exists is dropped. A scroll-memory
     restore whose anchor row folded while the chat was closed opens that fold
     and restores the exact row and offset; if the fold cannot be opened it
     lands on the fold row.
   - **Other row-indexed features read the unfolded rows.** The minimap
     collects its items and reply previews from the unfolded rows, so a fold
     never removes one, and an item hidden in a closed fold sits on the fold
     row (`placeMinimapEntriesOnVisibleRows`). The fork-history divider is
     computed on the unfolded rows; while its row is hidden it draws on the
     fold row, which takes the place of the span's first row, and it returns
     to its row when the fold opens. The jump pill's "N new" count places its
     anchor on the unfolded order and counts only drawn rows after it
     (`countVisibleRowsAppendedSince`). A turn folding the anchor row away
     therefore neither zeroes the count nor counts hidden rows. Inline proof
     anchors on the unfolded rows and draws on the fold row while its row is
     hidden. "Copy turn" copies the whole turn, folded narration included; its
     button sits on the turn's last text row, which is the answer or comes
     after it and so is never folded.

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
`href`. Downstream `ChatWorkLogBlock` (specifically the
`ChatToolActivityDetails` view reachable from the working indicator and the
done divider) consumes `entry.localUrls` to render the localhost-strip chips
that route into the in-app browser.

## Assistant text hover actions (desktop and hosted web)

Every assistant text row has a hover footer: the row's time, `Copy`, and on
the turn's last text row `Copy turn`. It sits on its own line under the prose
(`assistant-text-hover-footer`) and keeps that line's height while hidden, so
it never covers text. It used to be pinned over the top-right corner of the
prose. That covered the end of a short line, such as interim narration in a
live turn, and the first line of a long one. The line is there in live turns
and after the fold alike. Copy always copies the stored text, never a paced
prefix.

## Text merging

Adjacent `text` events merge via `shouldMergeTextRows()`:

- Events with matching `messageId` always merge, unless both carry a
  `phase` and the phases differ. ADE reuses one `messageId` for consecutive
  assistant text until a tool call flushes it, so a Codex `commentary` message
  and its `final_answer` can share an id; they stay separate rows so the turn
  fold can pick the answer. A merged row adopts a later fragment's `phase`
  when its first fragment had none.
- Events without `messageId` fall back to matching `turnId` and
  `itemId`.

This prevents duplicate rows when the provider streams fragmented text.
For Claude SDK rows, `messageId` is the provider message UUID/id so a
later `transcript_retraction` can remove the exact assistant text that a
model refusal fallback or `supersedes` message invalidated. When a reader
never saw a message's `message_start` (the idle reader that picks up
Claude's internal follow-up turn right after the foreground turn ends),
it latches the first delta frame's wire `uuid` as the message id until the
next `message_start`. Each frame has its own `uuid`, so using it per delta
gave every delta its own id and its own row, and the turn fold then hid
all but the last fragment behind `Worked for …`.

A `text` event can carry an optional `phase` (`"commentary"` or
`"final_answer"`): the provider's own label for interim narration versus the
turn's answer. Only Codex sends it, on the `agentMessage` item in
`item/started` / `item/completed` rather than on the text deltas, and not for
every model, so an absent `phase` means unknown. The Codex handler records the
phase per item id (cleared when the item or the turn ends) and stamps it on
that item's deltas. The 100ms text buffer closes at each new `agentMessage`
item and never folds two different phases into one event. A phase first seen
at `item/completed` labels only text still in that buffer. No extra event is
emitted for text that already flushed, because every client drops empty
`text` events. The field only labels text and never changes it, so the stored
transcript stays byte-identical. It survives storage and sync compaction and
also appears on Codex imports, thread-read recovery, and Codex subagent
transcripts. Clients that do not know the field ignore it.

`plan_text` merging uses `shouldMergePlanTextRows()` with the same
heuristic. When a final `plan` event arrives for a turn, any preceding
`plan_text` rows for that turn are discarded and replaced with the
single `plan` row.

## Reasoning merging

Adjacent `reasoning` events in the same turn merge into one `Thought` row
even when the provider gave them different `itemId`s, and the merged text
never repeats a fragment the provider re-sent. Providers persist one thought
more than once — Claude emits the streamed block under the stream content
index and the SDK snapshot under the block index (the two differ when a
redacted/empty thinking block was stripped from the snapshot), and Cursor
re-sends a run's text — so without duplicate-aware merging a turn renders as
two `Thought` rows or as one row with the paragraph doubled.

The merge helpers live in `apps/desktop/src/shared/chatActivityPhase.ts`:
`mergeReasoningFragment()` folds streaming fragments (exact/suffix re-emits and
cumulative snapshots collapse to the text once) and
`mergeReasoningTextFragments()` deduplicates fragment lists while keeping the
`---` separator between genuinely distinct blocks. The Claude producer also
skips a snapshot whose full text was already streamed, matched by text rather
than by content index.

That `---` is a display join, not stored text. Thought text renders through
`MarkdownBlock` with `tone="thought"`, which draws a thematic break as a quiet
paragraph gap (`data-thought-fragment-gap`, 0.6 of a line) instead of a rule.
The same tone sets thought text one step smaller and quieter than the
assistant's prose (12/14 of the chat font size, 1.65 leading, the foreground
at 62%). It applies to the live block and to every open Thought block. A
thematic break the model wrote itself inside a thought draws the same gap.

### Thought runs (desktop and hosted web)

Grouping merges reasoning only when the rows are adjacent in the grouped list.
Rows the timeline does not draw can still sit between two thoughts: the tool
group of a thought → tool → thought phase that stopped at a hidden row, or the
duplicate answer copy an open fold hides. On screen the two Thought rows would
then be next to each other, each with its own grey block.
`mergeAdjacentThoughtRows` (`chatThoughtRuns.ts`) runs on the drawn rows in
`AgentChatMessageList`, right after the turn fold is applied, and merges each
run of Thought rows of one turn that are next to each other into ONE Thought
row, in the open fold and in unfolded views alike.

- **What ends a run.** Any drawn row: text, a card, a divider, a fold row,
  or a Thought of another turn. Rows that stay in the list but draw nothing
  (`drawsNothingBetweenThoughts`: a `subagent_spawned` notice with
  `hasInlineCard`, the "Promoted to Cursor Cloud" marker, a queued-command
  lifecycle that did not cancel, a conversation reset, an empty non-failure
  status) are stepped over and move ahead of the merged row.
- **Keys.** The merged row takes its first member's key and lists
  `thoughtMemberKeys`, so the first Thought row stays mounted with its
  measured height and open state when a later one joins it.
  `thoughtRunKeyByMemberKey` maps each member to the merged row. Jumps
  (`scrollToRowKey`, including one that has to open a fold first), event
  anchors, a scroll-memory anchor, the fork-history divider, and inline proof
  that name a member all resolve through it to the merged row.
- **The live thought.** The reasoning row that is still streaming
  (`deriveLiveThinkingRowKey`) never joins an earlier run, because that would
  give it the earlier row's key and remount it mid-stream. Once something
  follows it, it joins like any other thought.
- **Text and duration.** The text is `mergeReasoningTextFragments` over the
  members. The row reads `Thought for Ns` only when every member has a
  measured duration, and N is their sum. If any member has none (one chunk, a
  sub-second span, or an activity-phase merge that also covers tool time), the
  merged row shows no duration.
- **Identity.** An unchanged run reuses the previous pass's merged envelope,
  so a streaming delta elsewhere does not re-render it, and the member map
  keeps its identity while its contents are unchanged.

### Live thinking preview (desktop and hosted web)

Every provider's thinking (Claude SDK thinking, Codex reasoning and summaries,
Cursor thinking, OpenCode/Droid reasoning, ACP `agent_thought_chunk`) arrives
as `reasoning` events, so one presentation covers all of them
(`ThinkingPreview.tsx`, wired through `MinimalThought` in
`AgentChatMessageList.tsx`).

- **Which row is live.** `deriveLiveThinkingRowKey()` picks at most one row per
  list: while the turn is streaming and the session has not ended, the newest
  grouped row of the active turn, if it is a `reasoning` row. It reads the
  grouped rows *before* `work_log_group` rows leave the drawn timeline, so a
  tool starting after the thought collapses the preview even though the tool
  row is never drawn. A noisy activity phase (thought → tool → thought) merges
  into one Thought row placed before one merged work row; that row stays live
  only while its latest fragment is newer than the merged work row.
- **Live look.** A header with a spinner, a shimmering `Claude is thinking`
  (the chat's assistant label; plain `Thinking` when the label is only
  `Assistant`), and an elapsed `· 12s` counter. Under it is a compact block of
  the streamed text, indented to the heading, with no box. It uses the thought
  tone (smaller and muted) and streams at the assistant text's pace: the same
  `useRevealedLength` reveal, with a settled prefix and a growing tail. The
  block grows with the text up to four lines. Its viewport
  (`.ade-thinking-live-viewport`) has the thought text's font size and line
  height and `max-height: calc(4 * 1lh)`, so a one-line thought is a one-line
  block with no empty space. Past four lines the newest line stays at the
  bottom, older lines scroll up, and a top fade (`mask-image`, on only while
  lines are out of view) covers them. The block scrolls only inside itself.
  The counter starts at the thought's first fragment, or at the start of the
  latest thinking run for a phase-merged row (`latestStartTimestamp`), so tool
  time before it is not counted. A thought that arrives in one chunk (Claude
  summarized thinking) simply shows its text.
- **Collapse.** As soon as any other row follows the thought, or the turn ends,
  the same row (same key) draws the compact `Thought` row. It shows
  `Thought for 12s` when the row has a real measured span (first to last
  fragment, at least 1s). A phase-merged row shows no duration because its
  span also covers tool work. The label is plain text with nothing after
  it; only the live `… is thinking` header carries a spinner and shimmer.
- **Opening.** Clicking a `Thought` row opens the full text inside the grey
  block, at full height, with no fade and no auto-scroll. Clicking the live
  block (or its header) expands it the same way while it streams, and
  clicking the grey block collapses it back to the four-line live view. It
  stays expanded until clicked again, and stays open when the thought settles.
  A click that ends a text selection or lands on a link does not toggle. Thought
  rows inside an open turn fold behave the same way. They never show the live
  preview.
- **Performance.** The only timer is one 1s interval in the header's elapsed
  leaf, so a tick never re-renders the text. The paced reveal re-renders only
  the `LiveThoughtText` leaf. Tail-following is at most one `scrollTop` write
  per frame, coalesced through a ref and `requestAnimationFrame`. A layout
  effect triggers it when the text changes, and a `ResizeObserver` on the
  content triggers it as the reveal grows the text between deltas. The same
  frame sets `data-overflowing`, which turns the fade on, without a React
  render. The block keeps the last ~4,000 characters of the revealed text
  mounted, cut on a paragraph boundary (an unclosed code fence is reopened), so
  markdown cost stays bounded on long thoughts.
- **Row height.** The live row grows from one line to four while it streams
  and then stays the same height. It is always the list's newest row, so its
  growth is below any scroll anchor: a reader scrolled up is not moved, and
  the content `ResizeObserver` re-runs bottom-follow for a reader at the
  bottom. When the preview collapses, the row shrinks. The browser clamps
  `scrollTop` to the new maximum, the scroll handler sees distance 0 and stays
  pinned, and bottom-follow runs again.
- **Reduced motion.** Under `prefers-reduced-motion` the header drops the
  shimmer and spinner animation, and the live block drops smooth scrolling. This is
  done in the component (`usePrefersReducedMotion`) and again in the CSS.
- **Other clients.** The TUI and iOS keep their existing Thought rendering.

## Turn diff summaries

When a turn completes on a lane and the service can compute a diff
between the before and after SHAs, the service emits
`turn_diff_summary` with per-file add/delete counts. The
`ChatTurnDiffPanel` component renders the summary inline; individual
file diffs are fetched lazily via `ade.agentChat.getTurnFileDiff`. This is
the only summary that can offer real git diffs and a SHA-scoped revert.

A turn that changed files without moving HEAD emits no such event — no lane,
a runtime with no git integration, or edits that never reached a checkpoint.
Those turns fall back to `ChatTurnFilesChangedSummary`, derived purely from
work-log entries and therefore available for every runtime (see
[composer-and-ui.md](composer-and-ui.md#file-changes-panel)). Exactly one of
the two renders per turn: the desktop message list suppresses the fallback for
any done row whose turn id appears in the session's `turn_diff_summary` set.

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
   builds a `PendingInputRequest`, attaches the `toolUseID`, and emits
   the request inline. When the user responds, a `tool_result` goes
   back to the SDK with the answer text, and `pending_input_resolved`
   clears the UI. There is no idle timer to suspend for human
   deliberation: Claude's time-based idle watchdog was removed because
   long tool calls emit no stream events, and
   `pauseIdleWatchdog` / `resumeIdleWatchdog` survive only as no-op
   stubs so approval and elicitation callers did not have to change.
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

Every flush is labelled with why it happened — `timer` (the 100 ms
window elapsed), `identityBreak` (the incoming fragment could not be
appended to the buffered one), `interleave` (a non-text event forced the
ordering flush) — and, while `ADE_PERF_RUN_ID` is set, recorded as a
`chatTextFlush` perf event by `services/perf/chatTextProbe.ts`. That probe
is what measures the real cadence the renderer has to absorb (flush count,
characters per flush, deltas coalesced, gap since the previous flush). It
is a no-op with no allocations when no run id is set. Note that
`agentChatService` is not Electron-only: in a normal dev session the `ade`
runtime daemon hosts the chat sessions, so it — not Electron main — is the
process that emits these events, and both may append to the same log at
once. See [ARCHITECTURE.md](../../ARCHITECTURE.md).

The lumpiness this batching produces is what the renderer's paced text
reveal smooths out; see
[composer-and-ui.md](composer-and-ui.md#paced-text-reveal). The store still
receives each flush whole and immediately — only the painted slice is
paced.

## Virtual scrolling and message-list layout

`AgentChatMessageList.tsx` keeps render cost proportional to the visible
viewport rather than total message count using its **own** virtualizer —
not `@tanstack/react-virtual`. The pieces:

- `measuredHeights`: a `Map` from stable row key to last measured DOM
  height. A row that has never been rendered uses a per-kind estimate
  (`estimateTranscriptRowHeight`): a fold row or chip is a single line,
  user and assistant text scale with their length across the measured
  content column, and cards get a card height. Each estimate is computed once
  per key (again only when the column width moves a full 64px step), so an
  unmeasured row's model height never drifts.
- Spacer divs: a top spacer offsets the rendered window to its correct
  scroll position and a bottom spacer fills the remaining scroll area,
  both sized from that map.
- `MeasuredEventRow`: wraps each rendered row and reports its real height
  through a `ResizeObserver`; `handleMeasure` writes the map and calls
  `reconcileMeasuredScrollTop`, which adjusts `scrollTop` when a row
  that starts above the viewport top changed height — including one
  straddling the top edge — so the visible content stays still.

Below `VIRTUALIZATION_THRESHOLD` rows the list skips all of this and
renders every row directly. The transcript has one responsive content-width
contract: `chatAppearance.ts` publishes `--chat-content-width` as
`min(100%, clamp(720px, 62vw, 1180px))` and aliases the older
`--chat-column` variable to it. Prose, composer, cards, plans, file changes,
activity details, and pills all use that token, while the JS
`resolveChatContentWidthPx()` mirror supplies floating-pane layout math.

Card rows compose `chatCardPrimitives.tsx`: a fixed 16 px glyph column,
flexible title/content column, and auto-sized meta/action column. Passing
one-line facts use a hairline row, live/detail-bearing work uses an inset, and
failures use an amber rail. The same primitives back `AdeCard`,
`CodexPlanCard`, files changed, tool/work rows, and the stopped-agents group
card. Running and finished subagent cards share their own frame and
container instead (see Card layout above).

Notable rendering rules:

- Assistant messages and transcript cards share the responsive content width.
- Completed-turn dividers show local time and measured duration. Tool activity
  and proof each have independent collapsed controls. Chat-owned proof is
  bucketed into turns by `artifact.createdAt`; expanding `N proof` renders the
  horizontal `ChatProofFilmstrip` immediately below that divider. The filmstrip
  is chronological, starts collapsed, and never moves to a pinned thread
  footer. Local project-relative URIs render through the artifact protocol;
  remote items fall back to their kind label and open the runtime-backed drawer.
- Code blocks in assistant messages render through `HighlightedCode`.
- User messages animate in with a `motion/react` spring transition and
  render in full, however long; there is no length-based clamp.
- Tables use rounded borders and a subtle inset-shadow treatment.
- System notices render compact inline rather than as pill badges.
- Plan approval bodies render whole inside the transcript. Only the pinned
  `ChatProposedPlanCard` above the composer caps its body
  (`min(52vh, 560px)`), so a long plan cannot push its own Implement / Keep
  planning buttons out of the viewport.

### Row keys

Every row key is built from the event's identity, never from its position in
the loaded window (`allocateTranscriptEventRowKey` in `chatTranscriptRows.ts`).
The base is `<sessionId>:<type>:m:<messageId>[:<phase>]` when the event names
a message, `<sessionId>:<type>:i:<turnId>:<logicalItemId or itemId>` when it
names an item, and `<sessionId>:<type>@<timestamp>` otherwise; a `#n` suffix
counts earlier events in the window with the same base. Derived keys
(`work-log:`, `activity:`, `reasoning-group:`, `activity-phase-*:`,
`terminus:`) wrap a row key and inherit its stability; subagent, card,
host-sleep, wake, and `turn-fold:` keys were already identity-based. A
`subagent_card_grid` or `background_job_group` row reuses its first member's
key and lists every member in `memberKeys`.

So a prepended older page, a background chat trimmed to its newest events, a
snapshot merge, or a late mid-list insert leaves every surviving row's key
alone: measured heights, mounted rows (no replayed fade-ins or
re-highlighting), scroll memory, the "N new" anchor, fold open state, fold
hidden keys, the turn-end snapshot, highlights, proof anchors, and the minimap
all carry across. The incremental collapse and a full recollapse assign the
same keys, and `buildTranscriptEventRowKeys` replays the assignment without a
collapse (the fork divider uses it). Keys only move when two events with the
same base are split by a page boundary — two id-less events of one type in the
same millisecond. `sceneRowIdentity` stays separate: it names scene stills on
disk and keeps its own frozen format.

### Anchoring the reader

The chat list owns scroll anchoring (`overflow-anchor: none` on the pane):

- **Row-list changes.** When the drawn row keys change while the reader is
  scrolled up — an older page, a trim, a merge, a regroup or removal above
  them — the render pass reads up to four on-screen rows and their tops from
  the DOM before the commit. The list anchor layout effect reads the first of
  them that is still mounted and moves `scrollTop` by exactly how far it moved,
  in both the plain and virtualized paths. In the virtualized path the window
  for that commit is computed from where the anchor row is about to be, so it
  stays mounted; a row that did unmount is placed by the height model. The
  anchor stands down while following the bottom, while a fold toggle or a
  turn folding pins its own row, and during a jump or a scroll restore.
- **Scroll memory.** Leaving a chat detached saves the first on-screen row,
  how far into it the viewport sat (read from the DOM, the height model when
  nothing is laid out), and the distance from the bottom. Returning puts that
  row back at that offset — by its DOM position once mounted — and re-applies
  every frame until the position holds for two frames in a row. A wheel,
  touch, press, or scroll key cancels it. When the row no longer exists, the
  view lands the saved distance from the bottom.
- **Older history.** Older pages load automatically as the reader nears the
  top (two viewport heights of runway), with no button. Nothing loads while a
  scroll restore is landing. Automatic triggers — the sentinel, the re-arm
  after a page lands, a settled restore — get one page between two reader
  scrolls, so pages never chain on their own; an underfilled pane with no
  scrollbar keeps backfilling until it fills, and a failure still offers
  Retry.
- **Code blocks.** `HighlightedCode` renders a cached highlight on the first
  frame, and the plain fallback and Shiki's `<pre>` share one font size, line
  height, and wrapping, so highlighting never changes a measured row's height.

## History snapshots, scroll-back, and misses

A chat pane hydrates from `ade.agentChat.getEventHistory`
(`AgentChatEventHistorySnapshot`) and pages backwards with
`ade.agentChat.getEventHistoryPage` (`AgentChatEventHistoryPage`). Both DTOs
live in `apps/desktop/src/shared/types/chat.ts`. Three fields carry the whole
contract, and each exists because the obvious substitute is wrong.

Runtime callers send both actions as one object envelope
(`{ sessionId, beforeOffset?, maxBytes? }`). The desktop preload and ADE Code
TUI use that canonical shape; the runtime registry still accepts the legacy
positional form while older packaged clients age out. This matters because a
one-argument runtime wrapper silently discards a second positional options
argument before validation, making every older-page request fail even though
the initial snapshot succeeds.

### `hasOlderHistory` — is there anything to scroll back to?

`agentChatService` derives it from the **tail read** (`transcriptTruncated ||
windowTruncated`), never from envelope object identity, so it stays correct when
a snapshot was served entirely from the in-memory ring buffer or the envelopes
were re-created by the coalescing/subagent pipeline (which loses identity).

Clients must gate the "load earlier messages" head slot on this field, **not**
on `tailStartOffset > 0`. `resolveSnapshotHistoryCursor` in `AgentChatPane`
enforces that: a `hasOlderHistory === false` returns cursor `0` even when a
non-zero `tailStartOffset` is reported, because otherwise the list offers a
scroll-back affordance that can only ever fail — which is exactly what produced
the false `couldn't load earlier messages` banner. The field is optional for
compatibility; older runtimes that omit it fall back to the legacy offset-only
rule.

### `tailStartOffset` — the paging cursor, in three tiers

`tailStartOffset` is the `beforeOffset` a client passes to
`getChatEventHistoryPage`. It is resolved in strict precedence:

1. **Exact.** The oldest returned event maps to a physical transcript line —
   use that line's byte offset.
2. **Identity lost, window complete.** Nothing was dropped from the head of the
   merged window (`!windowTruncated`), so everything at or after the tail read's
   `startOffset` is already in this response and paging from `startOffset` is
   still exact. A tail that started at byte 0 yields a `null` cursor: there is
   nothing older.
3. **Degraded.** Identity was lost *and* the merged window dropped events, so
   ADE cannot name the byte offset of the oldest returned event. It pages from
   `endOffset` (the end of the transcript), gated on `hasOlderHistory`. Pages
   then re-deliver events the client already shows — which the client dedupes —
   but scroll-back still reaches the head. This fallback must survive: removing
   it strands truncated transcripts whose snapshot came entirely from the ring
   buffer with no way to scroll back at all.

`advanceOlderHistoryCursor` requires `hasMore` **and** a strictly decreasing
`startOffset` before it advances, which mirrors the service guarantee and makes
client paging loops provably terminating. A page that claims `hasMore` without
decreasing the cursor is a retryable protocol failure, not evidence that the
head was reached.

Desktop, personal chat, and ADE Code request 256 KiB pages. Desktop and
personal-chat selected views keep at most 60,000 events / 32 MiB resident; a
background personal-chat view keeps 1,000 events / 2 MiB. Page responses are
committed only while the selected session, bound runtime, request generation,
and requested cursor still match.

One user-visible "load earlier" is one *batch*, not one page. `readOlderHistoryBatch`
keeps pulling pages until the accumulated span contains a `user_message`,
because pages are cut by bytes: a single page of a long streamed reply can be
hundreds of superseded `text` delta rows that fold to one rendered line, so a
page-per-trigger design reads as "load earlier did nothing". The same loop also
continues through empty-but-progressing pages, so sparse transcript regions do
not look exhausted. Two bounds keep it terminating: `maxPages` (default 8,
shared by both behaviours) and `maxAnchorEvents` (default 400, for a turn that
legitimately spans many pages). Hitting either is not an error — the reader has
real content and the next scroll continues. Pages already collected in a batch
are returned even if a later read reports `sessionFound === false`, which would
otherwise latch "no older history" and drop them until a reload. An overlapping snapshot
may preserve an exhausted cursor only when its oldest retained event survived
the merge; a replacement snapshot or cap eviction re-arms paging.

History hydration and live delivery have separate authority. The history API
owns the ordered range it returns; the live stream owns only events outside
that range. `shared/chatHistoryMerge.ts` applies that contract across desktop
and ADE Code: exact/semantic duplicates are removed, delayed live rows are
inserted by timestamp before later terminal rows, and a replayed old turn can
never be appended after the authoritative tail. Event identity is cached by
envelope object so a 60,000-event resident window does not re-serialize every
payload on each streaming flush. Desktop installs the live listener before its
passive history read, while the local runtime pump replays the narrow handoff
window and filters older buffered events by subscription start time. The hosted
web adapter consumes `chat_subscribe` snapshots only as stream watermarks and
hydrates visible history through `chat.getChatEventHistory`; it does not
re-emit snapshot rows as new live messages. ADE Code uses its semantic
provider-run identity for overlap, then normalizes delayed events
chronologically. iOS continues to sort and dedupe its materialized event set by
the same lifecycle contract.

The renderer keeps a bounded per-session view cache so switching back can paint
immediately. A hidden chat's retention subscription captures the concrete
outgoing project binding, even when that binding was the active unpinned path,
so a later project switch cannot silently retarget the retained stream.
Returning adopts that subscription synchronously, renders the cached tail, and
reconciles against authoritative history without blanking the list. Composer
controls are withheld for the one-frame interval where the incoming transcript
id and internal selected-session id differ; an outgoing Stop button or pending
input can therefore never appear over a settled incoming transcript.

### `unavailable` — "could not reach the runtime", not "no such session"

`sessionFound: false` is an authoritative answer: this project runtime has no
such session. `unavailable: true` is not — it means the bound runtime could not
be reached (remote hop down, machine asleep, project switch in flight), so no
history could be read at all. Clients must never clear, tombstone, or blank a
chat on it.

It is produced at every boundary that can fail to reach a runtime:

- **Preload** (`apps/desktop/src/preload/preload.ts`) returns it for
  `getEventHistory` / `getEventHistoryPage` when the call was left unhandled
  during a project transition **and** the window's runtime context is remote.
  Falling through to the local main-process chat service there was the bug: the
  local service has never heard of a remote session id, so it answers a *false*
  `sessionFound: false` that the renderer treats as authoritative and uses to
  wipe the transcript and its cache. Local bindings still fall through to IPC,
  because there the local service **is** the right answer. The page variant also
  echoes the caller's cursor back as `startOffset` so it does not additionally
  claim the head of the transcript was reached. See
  [Remote runtime internals](../remote-runtime/internal-architecture.md#local-runtime-routing).
- **The web-client adapter** (`renderer/webclient/adapter/agentChat.ts`,
  `personalChats.ts`) sets it on the fallback value used when the host command
  could not be reached or dispatched.

`resolveChatHistoryMissAction` in `AgentChatPane` turns a miss into one of three
actions:

| Result | Action | Meaning |
|---|---|---|
| `unavailable: true` | `sync-pending` | Keep everything, retry later, raise the catch-up hairline. |
| `sessionFound: false`, events rendered | `keep-missing` | Authoritative miss, but blanking a transcript the user is reading is strictly worse than leaving a stale-but-real one on screen. Marked for a later "chat no longer exists" pass. |
| `sessionFound: false`, nothing rendered | `clear` | Safe to drop the empty view. |

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
the turn is over. Large command output, tool results (both `result` and the
provider's raw `structured` payload), file diffs, reasoning text, and inline
image data URIs are replaced with a short preview (or no inline media) plus
original/omitted-byte metadata on the event (`outputOriginalBytes`,
`resultOmittedBytes`, `diffOmittedBytes`, `textOmittedBytes`,
`urlOmittedBytes`, etc.). Desktop/runtime live subscribers still receive the
original event while a turn is active. Persisted-history consumers see the
stored preview on replay.

The policy — every cap, every wrapper shape — lives in one module,
`apps/desktop/src/shared/chatEventCompaction.ts`, because it has two consumers
that must never disagree: the stored transcript
(`compactChatEventForStorage`) and the mobile/web sync wire
(`compactChatEventForWire`). The wire variant runs storage compaction first, so
a live push and the same event re-read after reconnect hydration are
byte-identical, then drops `tool_result.structured` and
`tool_result.toolResultMeta` outright — no client decodes either field, so
phones and web clients paid a download and a JSON parse for something they
immediately discarded. Removing a field no client reads is backward-compatible
by construction and needs no capability gate; adding or reshaping one still
does.

Compaction must stay **idempotent**. The wire applies it to events that already
came off disk compacted (hydration and the replay ring), and re-wrapping is not
a harmless no-op: the wrapper's newline-dense `preview` re-serializes with JSON
escaping and comes out *bigger* than the cap, so each pass grew the payload
while overwriting `originalBytes` with the previous pass's size. The module
recognizes its own wrapper by shape (`summary` starting with `[ADE] Large `,
plus `preview` / `originalBytes` / `omittedBytes`) rather than by a marker key,
because every surface that renders an object-shaped tool result dumps it as
JSON, so an added key would become the first line the user reads — and shape
detection also recognizes wrappers written by builds that predate the check.
The recognition is size-bounded at 2× the cap so a provider payload cannot
coincidentally buy itself an exemption.

The shortened-payload notices are user-facing copy now (the same compaction
feeds phones), so they no longer mention "stored chat history". Transcripts
already on disk carry the old wording; `summarizeDiffStats` in
`chatTranscriptRows.ts` matches both so an old shortened diff is still counted
as shortened rather than parsed as real diff lines.

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

A subagent whose terminal result is already in the stream is never closed
again. Codex delivers each `subAgentActivity` item twice (item/started, then
item/completed with the same `kind`), and the second delivery can land after
the child's own `turn/completed` settled it. The service acts only on the first
delivery: a `started` kind opens the thread only then, an `interrupted` kind
closes only a running thread, and other kinds emit `subagent_progress` only for
a running thread, so an echo never re-marks a finished child `running` or writes
"Agent active" after its result. Three backstops cover transcripts written
before that: `subagentSnapshotsFromEvents` ignores a progress tick after a
terminal result (only a fresh `subagent_started` reopens an agent), the stale
run sweep skips any snapshot with an `endedAt`, and the renderer drops a
`system` / `foreign-brain` stop for an agent that already settled, so it cannot
turn a finished card into `stopped · the ADE brain restarted` or stretch its
duration. Runtime filler (`Agent active`, `Agent received input`, `Status: …`,
`Task updated`; `SUBAGENT_PLACEHOLDER_SUMMARY`) is never saved as a report by
the orphan reconcile.

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

Queue handling is explicit at this boundary. `stop_and_clear` (**Turn + queue**) is the
backward-compatible default and uses `cancel_queued: true` when the Claude
session advertises the capability; otherwise ADE interrupts first and cancels
each attributed provider-queued message through `cancelAsyncMessage`. Local
pending steers are cleared in the same operation. `stop_only` interrupts the
turn but preserves the local/provider queues **and** background jobs.
`stop_and_background` / `stop_and_clear_and_background` also stop running
Claude tasks. A successful clear snapshots only
the queued steers the runtime actually cancelled, emits `queue_recovery`, and
accepts one `restoreCancelledQueue` call for eight seconds; expiry and restore
are persisted as terminal recovery events so replay cannot resurrect Undo.

Codex stages a mid-turn message on the app-server's own queue
(`thread/queue/add`) whenever the live turn rejects a steer — during compaction
or a review turn — and ADE keeps the `steerId` -> `submissionId` mapping on the
runtime object only. That mapping does not survive a runtime restart, a
rehydration, or a cancel routed in from another machine, while the transcript
still renders the staged chip, so `cancelSteer` re-reads the server queue first:
every entry carries the ADE `steerId` ADE sent as `clientUserMessageId`, which
makes the app-server the durable half of the mapping. Three rules follow:

- A `thread/queue/delete` that **fails** raises. The submission is still queued
  and will run, so clearing the chip would report a cancellation that did not
  happen.
- If ADE cannot read the app-server queue during recovery, it also raises and
  leaves the chip in place. A failed lookup is not evidence that the submission
  disappeared; the user can retry after the temporary failure clears.
- A submission that is recoverable **nowhere** — no mapping, nothing on the
  server — still clears the chip and emits the `Queued message cancelled.`
  notice. Nothing can deliver that message, and the old silent return left a
  control that did nothing every time it was pressed.
- A cancel on a session with **no runtime** clears the chip and also drops the
  steer from the persisted `pendingSteers`. `persistChatState` carries the
  previous file's list forward verbatim whenever the live runtime is not Claude,
  so without that the next runtime hydrated the steer straight back and sent the
  message the user had just cancelled.

`requireQueued: true` (the composer's Edit path) still refuses rather than
clearing, because Edit must not lose a message it cannot first take back.

A Codex turn ends through several paths — Stop, the local interrupt finish, the
app-server's `turn/aborted`, runtime teardown, `thread/deleted`, an app-server
crash — and every one of them runs `settleCodexPendingInputs` so the turn cannot
leave a plan, exec, or permission card behind. That matters more for Codex than
for the other providers because a Codex plan approval is raised *after* the turn
completes, when `activeTurnId` is already null: Stop's "nothing to interrupt"
arms are the common case for the one card that blocks every later send. The
helper empties the approvals map as it settles, so the app-server's own
`turn/aborted` arriving after a local interrupt is a no-op rather than a second
receipt. Settle teardown's `stop_only` interrupt is the deliberate exception and
leaves the cards for the user.

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
- **Row keys never carry an index.** A key built from an event's position in
  the loaded window changes on every prepend or trim, which drops measured
  heights, remounts rows, and loses the reader's place. Build new row keys
  from the event's identity (or wrap an existing row key); see
  [Row keys](#row-keys).
- **`logicalItemId` vs `itemId`.** Collapse keys prefer `logicalItemId`
  so streaming updates of the same logical tool merge even when the
  provider re-emits with a new physical `itemId`. Missing this breaks
  into duplicate rows.
- **Turn diff emission depends on lane context.** If a session is
  disassociated from a lane, `turn_diff_summary` will not emit. Do not
  rely on it for non-lane surfaces.
- **The turn fold's keep-visible decision is taken once, at `done`.** Do not
  re-derive liveness from a row's current state (a CI or lane-setup card, a
  background job): rows would jump into the fold as they settle, and a reload
  would disagree with the live session. New row types default to visible; add
  a type to `classifyTurnFoldEvent`'s history or keep-if-live sets
  deliberately, and give a grouped keep-if-live row its member keys
  (`liveKeys`) the way activity bundles and background-job groups do.
- **Timeline rows are the folded list.** In `AgentChatMessageList`,
  `presentedRows` / `presentedRowKeys` are the unfolded timeline and
  `groupedRows` / `groupedRowKeys` have the folds applied. Rendering,
  virtualization, and scroll offsets work on `groupedRows`. Anything that
  resolves a target or position from events or keys (jumps, minimap, fork
  divider, "N new", inline proof, scroll restore) must look it up in the
  unfolded rows. It then either opens the fold (`revealTurnFoldRow`) before
  scrolling or maps the row to its fold row (`foldIdByHiddenRowKey`). The
  measured-height cache is pruned against the unfolded keys plus fold ids,
  never against the drawn keys alone.
- **A subagent card in a grid is not a row.** Only the first card's key is a
  row key; the other members exist only in `memberKeys`. Anything that
  targets a card by key (`subagent-result:<agentKey>` jumps, event anchors)
  maps it through `subagentCardGridKeyByMemberKey` first. The same holds for
  a card folded into a `subagent_stopped_group`, which has no row of its own.
- **A settled card keeps its spawn key.** The result converts the spawn row
  in place, so `subagent-result:<agentKey>` names no row in the normal case.
  Resolve a card key through `subagentCardRowKeyCandidates` (or the member
  map, which already does), never by string-matching one prefix. Never splice
  the spawn row out on settle: that is what moved finished cards to a new row
  under the running ones.
- **Claude parent terminal events are an ordered pair.** Restart and idle-Stop
  repair must leave the parent `status` + `done` pair after any orphan cleanup.
- **A terminal turn does not clear a Codex card; a receipt does.** A Codex plan
  approval is raised after `turn/completed`, so the renderer intentionally keeps
  plan-approval and question inputs across a `done: completed`. The only thing
  that retires such a card is an explicit `pending_input_resolved` — which is
  why every Codex turn-ending path has to emit one. On runtime death the receipt
  is deliberately *withheld* for a plan approval
  (`planApprovals: "preserve-cards"`) so `respondToInput` can rebuild the card
  from the transcript; withholding it for anything else strands the composer.
  See [README › Fragile and tricky wiring](README.md#fragile-and-tricky-wiring).
- **Claude idle turns close on an SDK event, never on a timer.** An idle turn is
  opened by background/subagent output that has no result envelope of its own,
  so its only authoritative end is the `system` / `session_state_changed`
  message with `state: "idle"`, which the SDK sends after `heldBackResult`
  flushes and the background-agent loop exits. `finishClaudeIdleTurn` no-ops
  when no idle turn is open, so handling every idle transition is safe. Do not
  reintroduce a time-based idle watchdog to cover this — the previous one fired
  false positives during long tool calls. New Claude `system` subtypes are
  caught by a compile-time exhaustiveness guard rather than by review; see
  [README › Fragile and tricky wiring](README.md#fragile-and-tricky-wiring).
  Emitting later lifecycle rows can resurrect a stopped renderer state.
- **A failed history read is not evidence that a chat is gone.** Never infer
  `sessionFound: false` from a connection or dispatch failure — set
  `unavailable: true` instead. Every new code path that can answer a chat
  history read without reaching the bound runtime has to make that distinction,
  or it will blank a healthy transcript. See
  [History snapshots, scroll-back, and misses](#history-snapshots-scroll-back-and-misses).
- **`tailStartOffset > 0` does not mean older history exists.** In the degraded
  tier it is a conservative end-of-file cursor. Gate scroll-back UI on
  `hasOlderHistory`.
- **Subscribed mobile history pages do not activate project runtimes.**
  Modern sync hosts advertise `chatHistoryPaging`; the `chat_subscribe` ack
  carries `cursorKind: "byte"`, `tailStartOffset`, and `hasOlderHistory`, and
  the phone requests `chat_history` pages against the already-authorized
  subscription. The host reads the same local, personal, or foreign quick-look
  transcript path already bound to that subscription. A scope mismatch or
  transient read failure returns `unavailable: true` with the caller's cursor
  intact; only an authoritative missing session or a strictly decreasing page
  that reaches zero exhausts history.
