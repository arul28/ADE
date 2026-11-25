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
letting it break a run made the canonical text disagree with what desktop
and iOS actually draw. `isTranscriptContentEvent` is an allowlist of
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
| `user_message` | A user turn; carries text, attachments, `turnId`, optional `steerId` and `deliveryState`. A send held on its way (its computer woke, its ADE started) also carries `sentAt`, the person's send time from the client's `clientSubmittedAtMs` when it is 5 s to 1 hour before the host wrote the row; the bubble shows it, while ordering and turn timing keep the envelope `timestamp`. `deliveryState` is `"queued"` while a steer waits for turn-end delivery, `"delivered"` once flushed at turn boundary, `"inline"` when the message was folded into the active turn rather than queued behind it (Claude's SDK `shouldQuery:false` send, Cursor's `Run.steer()`, OpenCode's `session.prompt` with `delivery: "steer"`, or Pi's `steer`), and `"failed"` if dispatch errored. Cursor, OpenCode, and Pi first write the row as `"accepted"` ("Steering…") before they await the provider, then move the same `steerId` to `"inline"` ("Steered") when the turn takes it. Cursor's `Run.steer()` resolves only once the turn reads the message at its next model step, so without the early row the message was invisible for that whole step. A refusal moves the row to `"queued"` (staged again), `"delivered"` (sent as its own turn), or `"failed"` (dropped), so it never stays `"accepted"`. The desktop draws the delivery state as one small line under the bubble, right-aligned with it and never inside it (see [Message delivery](README.md#message-delivery-turn-health-and-quiet-diagnostics)). Same-turn steers (`queued`, `inline`, `accepted` from every inline provider, and Codex `processed`/`unprocessed`) do not clear the live provider-retry working indicator; only a primary user message, `delivered`/`failed` user message, or a terminal status/`done` starts the next retry-replay segment. A `user_message` carrying `metadata.boardMove` is intercepted before the user-bubble branch and rendered as a divider (`Moved on the board · <from> → <to>`) with the exact text the agent received centred underneath — never a bubble, because the user dragged a card between Work-board columns rather than typing that sentence. Messages a person did not type fold into one compact right-aligned row (`resolveUserMessageBody` kind `folded`): `agentRelay` (sender = the sending chat's title, with **Open chat**), `automationRun` (sender = the rule's name, preview = what set it off, or the prompt), and `scheduledWake` (Scheduled task / Loop / Scheduled wake-up, preview = the prompt's first line). The row shows an icon, the sender and a one-line preview, and opens to the full text with copy and time. ⌘F and the minimap read the sender and preview. |
| `text` | Streaming assistant text; identified by `messageId` (preferred) or turn/item identity. Fragments merge when `shouldMergeTextRows()` returns true. Codex text may carry an optional `phase` (`commentary` / `partial_answer` / `final_answer`); see Text merging. |
| `transcript_retraction` | Provider-level retraction signal. Claude emits this for refusal fallback `retracted_message_uuids` and assistant `supersedes`; renderers remove prior assistant text rows whose `messageId` matches `messageIds`, optionally retaining `replacementMessageId` as the new provider message id. The persisted JSONL remains append-only. |
| `reasoning` | Chain-of-thought or assistant-internal reasoning; surfaces as a distinct transcript row with a collapsible header. |
| `tool_call` / `tool_result` | Paired per tool invocation; rendered inside work-log groups. `tool_result.status` can be `running`, `completed`, `failed`, or `interrupted`. Claude SDK `tool_result_meta` is retained as optional `toolResultMeta`, and the provider's raw payload as optional `structured`; both are local-only debug material — they are bounded on disk and stripped from the sync wire, because no renderer, web, or iOS client decodes either. Provider-native MCP calls retain `mcp: AgentChatMcpToolSource` (`server`, `tool`, optional plugin/resource/app context) so transcript labels, iOS, and Sources use the connector identity instead of a generic tool name. Provider web tools add an optional `sources: ChatSourceRef[]` (at most 20, http(s) only, strings clipped) to their `tool_result`; unlike `structured` it travels on every wire, and the desktop row lists those hits like a native web search. |
| `file_change` | Emitted when the agent writes or deletes a file; carries `path`, `diff`, and `kind`. |
| `command` | A shell command invocation; carries `cwd`, `output`, `exitCode`, `durationMs`. |
| `plan` | Plan payload (steps + explanation). A plan with steps writes the chat's one task list; a Codex plan-mode proposal (no steps, `streamingText`) keeps its own plan card; a plan with no steps and no text (ACP `plan_removed`) clears the list. See [One task list per chat](#one-task-list-per-chat). |
| `plan_text` | Streaming plan fragments; merged via `shouldMergePlanTextRows()`. |
| `approval_request` | Legacy approval; newer code emits an embedded `PendingInputRequest` via `detail`. |
| `structured_question` | Claude SDK `AskUserQuestion` tool surface. OpenCode's `question` tool arrives as `form.created` and maps to the same card (see [OpenCode integration](opencode-integration.md#permissions-and-questions)). |
| `pending_input_resolved` | Hidden row; consumed by pending-input derivation to clear UI state. |
| `status` | Turn-level lifecycle: `started`, `completed`, `interrupted`, `failed`. |
| `done` | Final turn marker with model, model id, usage, cost, and optional open-string `terminalReason`. Claude may also carry `canonicalModel`, `modelProvider`, `apiErrorStatus`, `fastModeDisabledReason`, `userMessageUuid`, and `requestSentWallMs`; these preserve billing/provider provenance, terminal HTTP class, Fast fallback cause, and request correlation/latency metadata without exposing raw provider envelopes. Failed/interrupted dividers translate known reasons into a short explanation; completed turns omit the reason. Also clears non-question pending inputs when status is not `completed`. |
| `error` | Provider/runtime failure with message, detail, and semantic `errorInfo`. `errorInfo.presentation` is the host's own card copy for the row — `{ title, body, nextAction?, technicalDetail? }` from `shared/chatErrorPresentation.ts` — so desktop, iOS, and hosted web show the same sentence and none of them titles a failed turn "Error" or "Unknown"; raw provider text belongs in `technicalDetail`, never in `body`. A client that receives no presentation derives the same shape from `errorInfo.category`. Codex can report the same terminal failure first as an app-server `error` notification and again on failed `turn/completed`; ADE keeps one visible row for the same turn/error identity while preserving distinct failures. |
| `activity` | Ephemeral UI hint (thinking, searching, running_command). Hidden from the transcript. Automatic provider retry, reconnect, and transport-fallback signals also use this event with one compact, replaceable detail in the working indicator; they are emitted live-only and are not persisted. A live-only retry flushes any buffered assistant text/reasoning first so an older 100 ms fragment cannot land after the retry and clear the working indicator. |
| `todo_update` | Task-list snapshot (whole list each time); writes the chat's one task list. Items may carry `activeForm` (Claude) and `cancelled` (Cursor; wire status `completed`). OpenCode 2.0 has no `todowrite` tool and emits none of these. |
| `subagent_started` / `subagent_progress` / `subagent_result` | Legacy Claude background subagent lifecycle. Each envelope carries `taskId`, `parentToolUseId`, `description`, and optional `agentId`, `parentAgentId`, `agentType`, and `providerSessionId`; Claude start rows bind the native child to the owning Claude session so transcript drill-in never mistakes the ADE chat id for a provider session id. For Claude `agentType` is the Task tool's `subagent_type` (stashed at the `tool_use` boundary and joined on `parentToolUseId`); for Codex parallel agents it is a per-turn `Agent #N` label assigned at first announcement and the raw threadId is mirrored as `agentId`; for OpenCode subagents `agentType` is omitted so the row falls back to the `description` (taken from `session.title`). Codex app-server `subAgentActivity` items also flow into these rows and may carry `label`, `model`, and `reasoningEffort` for richer roster labels. Claude carries `label` too, and it is a different field from `agentType` on purpose: the Task tool's `name` is the human-chosen display name for *this* spawn, while `subagent_type` is the agent type. `name` used to be used as a fallback `agentType`, which made one spawn look like an agent type that does not exist. The label is stashed per subagent identity under both id spaces (taskId and agentId) in a map kept off `activeSubagents`, because terminal paths delete that entry — and the stashed tool input with it — before the result event is emitted, so a label stored there would vanish exactly when the completion row needs it. Claude SDK runs also stash `taskType` (`subagent` / `background` / `local_workflow` / `cron` / `other`) and `workflowName` at spawn so the renderer can label rows by workflow without re-deriving them per event; ambient/housekeeping tasks (the SDK's `skip_transcript=true` flag — e.g. session-title generation) and plain Claude Code task runs (`task_type` `other` with no agent metadata, e.g. "Re-run affected test files") are both tracked only for cleanup and filtered out symmetrically across spawn, progress, and completion notifications so the subagent panel never flashes them, while a backgrounded `Bash` shell (`task_type` `local_bash`/`background`) is routed to the background pane rather than the roster. Every `subagent_result` is gated on a recorded `subagent_started` (`emittedSubagentStartIds`), so an interrupt cannot emit a phantom stopped card for a subagent that never announced; terminal events clear both the taskId and agentId aliases. The service also emits canonical `subagent.started` / `subagent.progress` rows from `runtimeEvents.ts` so all runtimes can converge on the same envelope. There is no canonical end twin: a subagent ends once, so `subagent_result` is its single end event. A paired `subagent.completed` beside it makes clients count, group, and render each finished subagent twice. Two additional producers fan into the same three event types: **Claude Workflow runs** — the SDK's undocumented `workflow_progress` snapshot on `system:task_progress` is normalized by `claudeWorkflowProgress.ts` (defensive: malformed entries dropped, previews clipped, counts capped, unknown states degrade to queued/running; an unparseable snapshot leaves the generic task rendering untouched) and diffed per tick into started/progress/result transitions under a stable `<taskId>::a<index>` / latched-agentId identity, so each workflow agent renders as its own row with phase, tokens, and duration, reconnects upsert instead of duplicating, and agents left running when the workflow ends are closed out as `stopped`; and **child chat spawns** — a session created with `orchestrationParentSessionId` outside an orchestration run (e.g. `ade chat create` from a tracked agent shell) emits synthetic `subagent_started`/`subagent_result` events keyed `chat:<childSessionId>` into the parent so the child lists in the parent's subagents panel, its first finished turn reporting completed/failed/stopped. A `--mode cli` child (`ade new chat --mode cli --parent … --type …`, which goes through `start_cli_session` and creates a tracked PTY session) is not a chat session, so a third producer bridges it: `start_cli_session` calls `agentChatService.notifyParentOfCliChildSpawn`, which emits the same `subagent_spawned` chip and `chat:<terminalId>` `subagent_started` card (description = the terminal title, `agentType` = the CLI's provider for the logo, `model` from the launch) — clicking it opens the terminal session — and the chat service's `ptyService.onExit` listener closes the card when the PTY ends: exit 0 is `completed`, a non-zero exit is `failed`, and a closed or orphaned terminal is `stopped` unless the CLI had already written a closing message, in which case it is `completed` (the same rule the stale-run sweep applies to an ended chat that left a report). The summary is the CLI's own last assistant message when ADE can read it (Codex rollout by resume thread id, Claude Code JSONL by session id), otherwise the last meaningful terminal lines, and only when both are empty a plain statement of the exit — never a placeholder. Completion routing is the chat-child path (`deliverChildCompletionToParent`): `subagent` wakes the parent (the wake text points at `ade terminal read <id>`), `peer` leaves the quiet note, and the CTO gets one line. The dedupe `childTurnId` is `cli-exit:<endedAt>`, so the live exit and a post-restart reconcile of the same exit deliver once, while a resumed run that ends again reports again. Because an interactive CLI stays open after finishing its task, the card closes only when the process exits. The stale-run sweep defers `chat:` rows whose id is a tracked CLI child (`deferChildTerminal`) instead of reading the missing chat row as "the subagent chat is gone": an ended child is reported through the CLI path with quiet routing (no parent wake, matching the sweep), a running one is left to its PTY exit, and a row that already has its result is never re-closed. A shutting-down host unsubscribes before its PTYs are disposed, so a brain restart does not read its own terminal teardown as every CLI child stopping. `ade chat status <id>` answers for tracked CLI sessions (`running` while the PTY is busy, `blocked` while the TUI waits on a prompt, `idle` once quiet or ended, plus a `cliSession` block with status, exit code, lane, parent and the `ade terminal read` hint), `ade chat list` appends the lane's CLI children (`chat.listCliChildSessions`, `kind: "cli"`), and `ade chat read <id>` returns the CLI's last message and terminal tail with a pointer to `ade terminal read`. |
| `scheduled_work_update` | Scheduled/background-work lifecycle snapshot. ADE emits it for provider-neutral action schedules and Claude `ScheduleWakeup`, `CronCreate`, `CronDelete`, `/loop`/hook snapshots, remote triggers, cron/background task lifecycle messages, and durable scheduler transitions. It carries `kind` (`wakeup`, `cron`, `loop`, `remote_trigger`, `background_task`), `status` (`scheduled`, `paused`, `running`, `fired`, `missed`, `completed`, `cancelled`, `failed`, `stopped`), provenance ids, optional cron/prompt/reason/timestamps, `firedAt`, `late`, and `durable`; `shared/chatScheduledWork.ts` folds it into active/history Chat Info rows on desktop and iOS. `background_task` is additionally how the live Claude runtime reports a backgrounded shell command — it emits no subagent lifecycle events for one — so on desktop those snapshots also drive the in-thread `background_job_line`; other kinds bundle as activity. Parent turn completion does not imply background completion, and `background_task` snapshots whose `sourceTaskId` belongs to a real subagent are omitted from the Background roster (and from the job line) to avoid duplicate Agent rows. One-shots progress through `scheduled` -> `fired` -> `completed`; crons record the fire and return to `scheduled` with `lastRunAt` plus their next occurrence. |
| `tool_use_start` / `tool_use_complete` / `tool_use_summary` | Claude SDK tool lifecycle tracking (see [Claude tool-use tracking](#claude-tool-use-tracking)). |
| `step_boundary` | Workflow step boundary marker. |
| `system_notice` | Non-transcript chrome: auth errors, rate limits, and file persistence hints. Automatic retry/reconnect progress is not a system notice: it is live `activity` state, so successful recovery leaves no transcript row. Special-cased renders: the "Promoted to Cursor Cloud" pill, the `status:"subagent_spawned"` chip (emitted into the parent when a child chat session is created with a parent lineage; `detail.spawnedSession` carries the child sessionId/laneId/title and the chip deep-links via `ade:work:select-session`. iOS renders it through its existing system_notice mapping), the quiet `status:"model_switched"` divider after a Claude Pre/PostModelSwitch, and `status:"classifier_context"` audit lines when ADE relays user-authored classifierContext. "Getting <agent> ready" carries `status:"agent_download"`: while it is the newest event (only the person's messages after it) the working line reads "Getting <agent> ready…" instead of "Thinking" (`deriveAgentSetupWait`). |
| `model_handoff` | A completed **provider** transition. Emitted on Send only when the committed session's top-level provider group changes (`claude` → `codex`); a model switch inside one provider — including swapping the vendor model fronted by an aggregator provider, since OpenCode, Cursor, and Droid each collapse to a single group — is a model change but not a handoff and emits nothing. Desktop draws a divider with previous and current provider marks. iOS renders a hairline · from-logo · `HANDOFF` · arrow · to-logo divider: `WorkEventMapping` routes the event onto the notice channel under `AgentChatNoticeKind.modelHandoff` with the provider pair packed into the notice `detail` (`from|to`), and the `Model handoff · Codex → Claude` sentence survives as the VoiceOver label. All three renderers additionally skip a same-provider pair, so legacy transcripts holding `Claude → Claude` no longer draw one. |
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
| `context_compact` | Provider-neutral manual/automatic compaction lifecycle. `state: "started"` begins the boundary, `"completed"` may carry `preTokens`, `postTokens`, `tokensRemoved`, `durationMs`, provider, per-session count, and `summary` (Claude's `PostCompact` hook, OpenCode's summary text), and `"failed"` carries `failReason` (`interrupted`, `timed_out`, `teardown`, `provider_error`, `quota`), the provider's `failDetail`, and the account's `accountLabel`. `trigger` is `manual` (the turn was a typed or clicked `/compact`), `auto`, or `ade_fallback` (ADE's guarded fallback). A compaction says `started` exactly once: an `ade_fallback` one when Claude reports `compacting` (the `/compact` waits behind whatever Claude runs next, and saying "Compacting" when ADE asked left the label up for half an hour while the context kept growing), and a native one on its first `compacting` status frame — Claude repeats that status every ~30 s while one compaction runs, and a repeat must not open a second row or restart the elapsed clock above it. When a turn ends, ADE closes every compaction still open for it as `failed`, so no divider spins after its turn; an `interrupted` one closes as a cancellation (see the divider table). A completed boundary invalidates older context-meter usage on desktop and iOS; a failed one leaves the last measured value. |
| `web_search` | Provider-neutral web-search/fetch lifecycle; renderers group these with other tool calls instead of showing them as standalone event cards. Actions can carry `query`, `queries`, `title`, `url`, and `snippet`; desktop and iOS render URL actions as in-app-browser result chips. Codex 0.145 additionally emits structured `results` (an array of `{ url, title, snippet }` capped at 8 by the adapter) plus `resultsTotal` (the pre-cap hit count). Renderers thread these onto the same grouped row — desktop/iOS surface them as `Sources` chips (deduped against the action URLs) and the Sources tab. Codex emits native web-search items; `claudeStructuredActivity.ts` maps Claude server-tool blocks into the same event. Every surface that lists sources reads these results and URL actions through `shared/chatSources.ts`; the queries are metadata on the sources they produced, never items of their own. The desktop row header shows the result count (`resultsTotal`, else the results, else the URL actions) without being expanded. |
| `sources` | Data-only citations for an assistant message: `sources: ChatSourceRef[]` plus optional `itemId`/`turnId`. Claude text-block citations, Codex `agentMessage.memoryCitation`, and ACP `resource_link` message blocks emit it. It draws no row on any surface (desktop hides it with the token events; iOS decodes it as `.unknown`) and does not break the streaming assistant message (`shouldFlushBufferedAssistantTextForEvent` returns false). Sources, the turn chip, and the fold count read it. |
| `codex_image_generation` / `codex_image_view` | Compact generated/viewed-image lifecycle used across providers despite the legacy type prefix. Codex emits native image items, Cursor maps `generateImage`, OpenCode maps image `file` parts, and Droid maps assistant image blocks. OpenCode's two origins are split by where the `file` part lives: an assistant-owned part is model output (`codex_image_generation`), while a tool attachment is what the tool returned (`codex_image_view`) — except attachments from a recognized image-generation tool, which keep the generation card. A view is one quiet line in the grid of the computer-use rows (`CodexImageViewLine`): "Viewed banner.png", named by the file name (never a whole path or a data URI). A click opens the picture small under the line and a click on it opens `MediaLightbox`; nothing is read until then. A picture is a local file read through the chat's machine (`readAttachmentImageDataUrl` with the runtime pin, `ChatViewedImages.tsx`) or an inline data URI; a remote URL is not previewable (the renderer CSP pins `img-src` to an allowlist plus data:/blob:). A view of a file that a computer-use action of the same turn printed — its screenshot, the picture its observation saved — draws no row: it joins that action's line (`foldImageViewIntoAction`, on `ChatWorkLogEntry.imageViews`), see the computer-use rows below. Consecutive views in one turn fold into a single `Viewed N images` line (`imageViewSiblings`, carried through `ChatTranscriptRenderEnvelope` / `ChatTranscriptGroupedEnvelope`): a later view joins it when only folded work — tool calls, commands, narration, rows that draw nothing such as automatic `context_usage` snapshots — sits between them, and a row the reader keeps seeing starts a new one. OpenCode's `read` names its attachment with the absolute path it read; the mapper records that as the view's `path` and its file name as the title, so the picture stays reachable after storage drops a large data URI (original/omitted byte metadata is kept). |
| `codex_safety_buffering` / `codex_moderation_metadata` / `codex_sleep` / `codex_thread_deleted` / `codex_turn_stalled` | Codex app-server runtime state. Safety buffering and moderation metadata are compact status rows. A new Codex sleep is not a runtime-state event: it arrives as a `tool_call` (tool `sleep`, args `duration` and `durationMs`) and a matching `tool_result` (`Waited 30s`), which draw as one ordinary tool row. `codex_sleep` is legacy — it only appears in saved chats. `codex_thread_deleted` clears the stored upstream thread; `codex_turn_stalled` is the structured recovery event shown when a turn produced no useful output after app-server reconciliation. Its actions are `wait`, `steer`, `interrupt_retry_same_thread`, and `restart_resume_thread`. |
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

## Compaction divider and activity

Every surface draws one line per `compactionId` across the thread: everything above it was replaced
by a summary. On desktop (`ContextCompactDivider.tsx`) the line is one pill between two rules:

| State | Pill |
|---|---|
| Running | A spinner, `Compacting`, the token count (`481k`), and the seconds after five seconds. The elapsed counts from the first `started` of this compaction, so a provider that re-reports its `compacting` status (Claude, every ~30 s) cannot restart it. |
| Done | `Compacted`, then `481k → 6k`. Hover gives who asked (`You asked`, `Automatic`, or ADE near the limit), how long it took, and `2nd time in this chat` from the second compaction on. |
| Cancelled | Warning tone, `Compaction cancelled`: the compaction was aborted — the person's Stop, or the provider cancelling its own `/compact` (Claude Code prints "Compaction canceled.") — with a **Retry** action that sends `/compact`. Hover shows the provider's text when there is one. |
| Failed | Warning tone: `Compaction failed` (or `Compaction timed out`), plus `— weekly limit on <account>` or `— usage limit on <account>` when the provider said so, and a **Retry** action that sends `/compact`. Hover shows the provider's text. |

A done pill with a `summary` is a button. It opens a `.kit-card` under the line, "Summary the chat
continues from", with the provider's wrapper tags removed and a fixed height that scrolls.

A turn that only ran `/compact` is drawn as that line and nothing else (`AgentChatMessageList.tsx`):
the command is a quiet right-aligned chip instead of a message bubble, the working indicator stays
hidden while it runs, and the finished turn gets no turn-end line. Every provider goes through this
one component (`context_compact`, and Codex's `codex_context_compaction` mapped onto it).

iOS is `WorkContextCompactDivider.swift`. It still draws the earlier one-line text divider
(`Context compacted · 481k → 6k · 28 s`, then the trigger), with the same
cancelled/failed wording as desktop, and its running elapsed counts from the card's first `started` for the
same reason.

`sessionActivityDetector` sets the system activity `compacting` while a compaction runs ("Compacting… · 481k" on
the Work row and sidebar), restores the prior activity when it completes, and sets `compaction_failed`
("Compaction failed", amber) when it fails. A cancellation (`failReason: "interrupted"`) restores the prior
activity like a completion — nobody has a move to make — and only a real failure leaves the amber row. The
next turn clears `compaction_failed`.

A compaction-only turn that hits a usage limit does not move accounts or schedule a resume "continue". Assistant
text whose origin timestamp is older than the turn's start is dropped, so a resumed thread cannot replay an older
turn's error under a new turn.

## Claude context guardrails

Live Claude occupancy is the last request's input + cache read + cache creation tokens (output tokens are not
counted), measured against the model's maximum window (`modelUsage[].contextWindow`, else the registry). The SDK's
`getContextUsage().raw_max_tokens` is the auto-compact window, not the model maximum, so ADE keeps it separately as
the compaction window; the 80/90/97% guardrail gates measure against that window. Claude itself compacts a fixed
33,000-token buffer below the window and reports that point as `autoCompactThreshold`; ADE shows it as
`compactAtTokens` (estimated as window − 33,000 before the first snapshot). The 97% fallback stays on the window, so
it fires only after Claude should already have compacted. It emits at most once every
five seconds and only after a one-point percentage change. ADE never preempts the SDK's natural compaction.
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
Desktop (thread card and Chat Info pane) reads it. iOS does not yet: it still draws a plan card per
turn and folds same-turn todo rows into it (`WorkTimelineHelpers.swift`), and
ignores the optional `activeForm`, `cancelled`, and `priority` fields.

Sources, as each provider's SDK or protocol types them:

| Provider | Native shape | ADE event |
| --- | --- | --- |
| Claude | `TodoWrite` `{ todos: [{ content, status, activeForm }] }`; `TaskCreate` / `TaskUpdate` (`subject`, `activeForm`, `status` incl. `deleted`) | `todo_update` (with `activeForm`) |
| Codex | app-server `turn/plan/updated` (`TurnPlanStep { step, status: pending \| inProgress \| completed }`); the `update_plan` tool (`in_progress`, snake case); legacy `planningItem` | `plan` (`state: "updated"`); `todo_update` for `planningItem` |
| Cursor | `updateTodos` `{ todos: [{ content, status: pending \| inProgress \| completed \| cancelled }] }`; the `ade_update_plan` fence | `todo_update` + `plan` from one call |
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
Desktop `chatTranscriptRows` and iOS
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
machine running the brain, never through a third-party favicon service (Google's
s2 endpoint would learn every domain a chat touched).

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
| OpenCode | `ToolStateCompleted { input: Record<string, unknown>, output: string, title }` (`@opencode/client` types); tool names `webfetch`/`websearch` (its permission config). Input is untyped, so only `url`/`query` are read and output is scanned only when it is JSON. | `tool_result.sources`. |
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
  turn-end line (`DoneTurnDivider`, next to the proof count) on wider screens,
  not in the answer's hover footer. It is hidden on mobile to keep the turn
  summary readable; the Sources section remains available in the chat Actions
  drawer. A turn's list keeps its identity while its sources are unchanged, so
  streaming does not re-render every turn-end row.
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
Claude · attempt 6 of 10 · retrying in 8s`). Desktop, hosted web,
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

`apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts` turns raw
envelopes into rows in five steps.

### 1. Render events

Raw envelopes become `ChatTranscriptRenderEvent` values:

- **Work entries.** Tool, command, file-change and web-search events collapse
  into `ChatWorkLogEntry` objects (status, label, tone, diff stats, web-search
  result chips). Each entry has a `collapseKey` from `turnId`,
  `logicalItemId` (else `itemId`) and the tool or command identity, so
  streaming updates of one call merge into one entry. `withLocalhostUrls`
  stamps `entry.localUrls` when the entry mentions a `localhost`,
  `127.0.0.1`, `0.0.0.0` or `[::1]` URL (`extractLocalhostUrlsFromText`:
  trims trailing punctuation, normalizes the host to `localhost`, dedupes by
  `href`). `ChatToolActivityDetails` draws them as chips that open the
  in-app browser.
- **Visible rows.** Text, reasoning, plan, status, pending input and user
  messages pass through. Before a scheduled `user_message`
  (`metadata.scheduledWake`) the transform inserts a `scheduled_wake_divider`
  keyed `scheduled-wake:<scheduleId>:<turnId>` (fire time, reason, late
  state); the while-you-were-away card scrolls to these keys.
- **Hidden rows.** `pending_input_resolved`, `activity`, `step_boundary`, raw
  tool/command/file-change events, standalone reasoning events and
  `scheduled_work_update` feed other derivations. `transcript_retraction` is
  hidden too, and removes earlier assistant `text` rows whose provider
  `messageId` was retracted or superseded.
- **Errors.** Exact duplicate `error` rows (same turn id, message, detail and
  `errorInfo`) collapse into one.

#### Subagent cards

`subagent_started` / `subagent_progress` / `subagent_result` collapse per
agent (`agentId ?? taskId`) into one row:

- A running agent is a `subagent_spawn_anchor`. Its terminal event turns that
  row **in place** into a `subagent_result_card`, with the same position and
  key, also when the result arrives after the parent's `done`. A settled card
  is never reopened by a late progress tick.
- Only a result whose spawn row is not in the window (an unloaded older page,
  or a result with no start) appends a card where it arrives. Loading the
  older page moves it into its spawn slot: the layout is a pure function of
  the events.
- Keys never change on rebind, so measured heights survive:
  `subagent-spawn:<agentKey>` normally, `subagent-result:<agentKey>` only for
  a card appended without its spawn. A jump that names either key lands on
  the card (`subagentCardRowKeyCandidates`). An event anchor on a progress or
  result event lands on the card it updated
  (`subagentCardKeyForLifecycleEvent`).
- A `transcript_retraction` splice repairs every stored row index, including
  `backgroundJobRowIndexByKey`.

**Card names.** `deriveSubagentCardName` (`shared/chatSubagents.ts`) names a
card the same way for every provider:

1. The spawn's `description` (Claude's Task description, OpenCode's session
   title, Cursor's and Droid's task description, Codex's agent path).
2. The explicit `label` (Claude's Task `name`, a Codex nickname, Cursor's
   label).
3. `agentType` (Claude's `subagent_type`).

A path or snake_case id is humanized from its last segment
(`/ROOT/SHIP_POLL_927` reads `Ship poll #927`). A trailing `(@<agent>
subagent)` or `(@<agent>)` from OpenCode is dropped. Sentence case keeps known
acronyms (iOS, CLI, UI, UX, API, IPC, PR, CI, SDK, MCP, DB, JSON, URL, HTTP,
SQL, CSS, HTML, AI, ID); the iOS mirror (`WorkStatusAndFormattingHelpers.swift`)
has no acronym map yet. Placeholders (`Subagent task`, `Delegated task`,
`Background work`, `subagent`, `opencode-subagent`) are skipped; with nothing
usable the card reads `Subagent`.

- The title comes from `subagent_started` only (`nextSubagentTitle`), because
  Claude's `task_progress` frames carry the current activity in
  `description`. A repeated start replaces the title only when it names the
  same task more fully or the title is a placeholder.
- With the start in an unloaded page, the label or agent type names the card
  before any progress description does.
- The longest description still drives classification and background job
  labels.
- Stopped-group items, the `spawned by` label and the Chat Info subagents row
  (`chatSubagentDisplayName`) use the same name. Chat Info keeps the start's
  description; a progress frame fills it in only when no start named the
  agent.

**Card layout.** `SubagentSpawnCard` and `SubagentResultCard` share one frame
(`SUBAGENT_CARD_CHROME`), so only the badge and status line tell running and
settled cards apart. The spawn kind shows only as a `SUBAGENT` / `PEER` chip.

- Inside the frame: the identicon, the name (truncated), one mono status line,
  the body, open/Stop controls and the provider mark.
- Running: a spinning ring, and `running · <activity> · <N> tools ·
  <elapsed>`.
- Settled: a green check (finished), red X (failed) or neutral square
  (stopped), and `ran for 1m · 12 tools · 34k tokens`, prefixed `failed` or
  `stopped · <who stopped it>`. The report follows as plain text, three lines
  at most.
- Both status lines name the agent's own model and effort when it reported
  them, never the parent's. Claude reports a native child's effort only
  through its PostToolUse and SubagentStop hooks (`effort.level`);
  `noteClaudeSubagentEffort` turns it into a `subagent_progress` row, and the
  result reads `subagentEffortById` because terminal paths delete the active
  entry first. Opening a subagent's thread locks the composer's model and
  effort to the agent's own.
- Reports are markdown. `subagentSummaryPlainText` drops heading, list, quote
  and table markers, rules and fences, keeps the text of emphasis, code and
  links, joins lines into one paragraph, and ends a heading or list item with
  `:` / `;`. The stopped group and the Chat Info drawer read reports the same
  way. The stored report is unchanged.
- An OpenCode diff-stat summary with every count at zero is not a report
  (`isEmptyDiffStatSummary`).
- A stopped card shows a summary only when it says something of its own
  (`meaningfulStoppedSummary`). Otherwise the body reads the last activity
  and `work lost` or `report landed` (`stoppedResultOutcome`).
- A failure keeps its full error behind `Details`. A worktree result keeps its
  copy-worktree button.
- A click on the card (or its caret, the keyboard path) opens a spawned chat,
  or the agent's transcript in Chat Info for a runtime-native agent, only
  inside a host that listens for `ade:chat:open-info` (`ChatInfoHostContext`).
  A text selection or a click on a control inside does not open it.

**Side-by-side grids.** Consecutive subagent cards of any state join one
`subagent_card_grid` row (`groupSubagentCardGrids`):

- A `subagent_stopped_group` ends a run. A run steps over only
  `subagent_spawned` notices with `hasInlineCard`, which move ahead of it.
- `SubagentCardGrid` uses a six-track CSS grid. Rows fill left to right, up to
  three cards; the cards of a short last row share the full width
  (`subagentCardGridSpan`: 5 cards read 3 + 2, 4 read 3 + 1). Full rows are
  never rebalanced, so a new spawn never moves an earlier card.
- A container query sets the columns (`subagentCardGridColumns`; cards never
  under 232px): three from 712px, two from 472px, else one. Span classes are
  literal strings in `subagentCardGridCellClass`, so a count change remounts
  no card. Cells stretch to equal height.
- The grid's key is its first member's key, and it lists `memberKeys`. A lone
  card renders through the same component, so a card stays mounted when a
  second one joins. Only a grid whose first member leaves (into a stopped
  group) takes the next member's key.

**Stopped-group fold.** `groupStoppedSubagentResultCards` folds a run of more
than `SUBAGENT_CARD_GRID_MAX_COLUMNS` (three) consecutive stopped cards that
share a cause and attribution and have nothing of their own to say (no report
before the stop, `resultLanded`; no meaningful summary, `stoppedGroupCauseOf`).

- It runs inside `groupChatTranscriptRows`, before the presentation filter,
  and steps over rows the timeline never draws (`work_log_group`, inline-card
  spawn notices). Those rows move ahead of a group that folds; otherwise
  nothing moves.
- Only **contiguous** casualties fold, and the group takes their place, so no
  card moves past another: `A` running, `B`–`E` stopped, `F` finished reads
  `A`, `4 agents stopped`, `F`.
- Jumps to a member key or its `subagent-result:` alias resolve to the group.
  `SubagentStoppedGroupCard` shows each agent's `stoppedGroupItemOutcome`.

#### Background jobs

Backgrounded shell commands collapse to one `background_job_line`, pushed on
the job's first sighting and changed in place to its terminal state, which a
late progress tick never reopens.

- Two producers share one key space: the live runtime, which reports
  background shells only as `scheduled_work_update {kind:"background_task"}`
  (`emitClaudeBackgroundTaskUpdate`), and older transcripts' `subagent_*`
  events with `taskType: background`.
- Once a task opened a job line it stays a job. A task that proves to be a
  real subagent has its job line removed before the spawn anchor lands, so it
  never draws as a line and a card.
- The key `background-chip:<agentKey>` never changes on rebind.

Consecutive job lines join one `background_job_group`
(`groupBackgroundJobRuns` in `chatBackgroundJobRuns.ts`), right after the
grid pass. The group's key is its first member's, with `memberKeys`. A run
splits where the turn fold would: a job still running at turn end (in that
turn's `liveRowKeys`) never shares a row with jobs that finished before. Jumps,
event anchors and scroll memory resolve members to the group
(`backgroundJobGroupKeyByMemberKey`).

`BackgroundJobRunRow` draws one compact left-aligned line, not a card:

- One job: `$ <command> · <duration> · <status>`, with a once-per-second
  ticker from the real start while it runs, Stop, and `open ›`.
- A run: `$ 5 background jobs · 1 running 47s · 3 done · 1 failed ›` (failed
  in red). A click lists each job with its status, label, duration, Stop and
  `open ›`.
- The wire format has no exit code, so a job seen only through the live
  producer measures from its first sighting.
- `open` sends `ade:chat:open-info` with the task id, and is left out where no
  host listens. In an ended session a job still marked `running` has no
  duration and no Stop.

#### Scheduled work and wake loops

- A wake-up, cron, loop or remote trigger is one entry per schedule id across
  the transcript (`foldScheduledWorkRows` in `chatScheduledWorkRows.ts`).
  Later updates patch the entry where the schedule was made.
- A one-shot `cancelled` at or after its fire time reads as fired.
- When the turn ends, its schedules move onto its turn-end line
  (`moveScheduledWorkToTurnEnds`) as chips: `⏰ wakes in 2m` (amber while
  pending), `woke at 9:50 PM`, `⟳ cron · every 30m`. A pending wake-up more
  than a minute late reads `was due 9:29`. A click opens the chat actions
  pane. A running turn keeps a `ScheduledWorkLine` row until its `done`.
- Task lists are never bundled; they are the chat's one `task_list` row.
- A turn the agent started from its own wake-up is a wake turn
  (`deriveWakeTurnIds`). It has no `Worked for …` row: the `ran 2.2s ›` time
  on its turn-end line opens the fold. Consecutive wake turns fold every
  check but the latest (`deriveWakeChains` / `applyWakeChains`) behind `+3
  more checks ›` on the turn-end line above them; without that line a slim
  `3 earlier checks` row (`wake_chain`) shows. A turn the user started ends
  the run.

#### ADE cards

`ade_card` collapses per `cardId` into one permanent row keyed
`ade-card:<cardId>`:

- A repeat emit merges over the previous payload in place, so an update that
  leaves out `rows`/`metrics` patches them, and the row keeps its position and
  height.
- A failed detail refresh keeps the earlier rows with `stale: true`. A first
  empty failure shows `detail unavailable` and its retry action.
- `durationMs` only for a real measured run; the update span reads `tracked`.
  `rowsTruncated` becomes `+N more`.
- It is never activity: `classifyActivityPhaseRow` never classifies it, so a
  reasoning or work phase cannot swallow it.
- The contract is `shared/adeCard.ts`; iOS mirrors it. Every surface renders
  `fallbackText` and the `navTarget` deeplink for an unknown `variant`. There
  is no red tone: failures are amber.

#### Turn details, warnings and receipts

- `turn_diagnostics` snapshots and the turn's recovery receipt
  (`turn_recovery`, or the alias `codex_turn_recovery`, which never replaces a
  provider-neutral receipt) merge into one `turn_details` row per turn: one
  `Turn details` line with summed counts. Codex files diagnostics under its
  session-startup key and the turn id; an id-less snapshot joins the details
  row of its window (since the last user message or own `done`). The row sits
  where the first contribution landed, keyed `turn-details:<turnId>` (or the
  first event's row key), so live and reload collapses agree. Integrations
  dedupe by name; checks sum.
- Warning notices (other than usage and sign-in) draw as one amber line
  without the provider's leading `⚠`; a click shows the full message. They
  stay separate rows, so a warning after the answer stays outside the fold.
- Receipt notices (`info`, `config`, `hook`, `file_persist`, no error or
  warning, no own row status) draw as one muted line with a glyph by meaning
  and a chevron for detail. Neighbouring receipts of one turn share a line
  with `+N` (`foldQuietNoticeLines`). Model switch, spawn, host sleep, reset
  credit, voice, and every actionable or failing notice keep their own rows.

### 2. Grouped envelopes

Adjacent work-log events of one turn merge into `work_log_group` blocks. A
`tool_use_summary` right after a group of the same turn is absorbed into it.

### 3. Activity phase collapse

A noisy run of `reasoning` + `work_log_group` rows in one turn (three rows or
more, or two reasoning rows, or two work groups, with no hard boundary between)
merges into one `Thought` row and one work-log group, in first-occurrence
order. The logic is `shared/chatActivityPhase.ts` (desktop:
`groupChatTranscriptRows()`; iOS: `collapseActivityPhaseTimelineEntries()`).
Desktop removes rows it never draws (automatic `context_usage`, same-provider
handoffs) first, so a hidden row cannot split a thinking run.

### 4. Client presentation

Tool, command, hook and web-search groups have no permanent rows:

- **Live turn.** The working status names the running tool, and its dropdown
  lists the open turn's tools (`deriveTranscriptToolActivity`). The open turn
  ends at `done` or at a user message that starts a new one
  (`userMessageStartsTurn` in `shared/chatTranscript.ts`): a message with the
  open turn's id (Codex's mid-turn `!` command) or a steer the turn took or
  that failed never starts one.
- **Finished turn.** Desktop and hosted web draw one `N tools · M files` row
  (`ChatTurnWorkSummary`) right above the time/usage line, left-aligned with
  Thought; expanding lists tools and files above that line. File changes share
  this summary unless a checkpoint `turn_diff_summary` covers the turn.
  `work_log_group` envelopes are filtered out of the timeline. When the turn
  folds (step 5), the counts move to the fold row.
- **iOS** puts the counts on `WorkTurnEndMarkerView`, also for a turn paused at
  a usage limit, and a tap opens a sheet. `workPresentedTimelineEntries` drops
  `.toolGroup` / `.changedFiles` rows only when `workTurnToolActivityIndex`
  attached them to a finished turn.
- Clients show only what the provider emitted; they never make up file
  histories.

**One-line previews strip inline Markdown.** `summarizeInlineText` uses
`stripInlineMarkdown` for collapsed tool args, the tool-summary header and
minimap previews: markers come off only in pairs, and `_`/`*` only at word
boundaries, so `snake_case` and globs survive. Grouping uses
`normalizeInlineText` (whitespace only). iOS: `workStripInlineMarkdown`.

#### Computer-use action rows (desktop, hosted web, iOS)

A group with ADE computer-use shell commands (`ade screen|mac-desktop|desk`,
`ade app-control`, `ade browser`, `ade apple`, `ade proof`, also through
`"$ADE_CLI_PATH"`, from any provider) stays in the thread and draws those
commands as sentences: "Clicked “Checkout” on localhost:5173".

- `shared/computerUseActionSummary.ts` reads the command and
  `shared/computerUseActionOutput.ts` its output (`hit:` / `effect:` lines,
  key-value rows, the Mac Desktop windows footer, `ade:` errors, the
  `attached:` / `target:` lines, `--json`). The summary returns null when
  unsure (an unknown verb, two acting commands, shell control flow), which
  keeps the plain shell row.
- The tokenizer splits only unquoted redirections (`2>&1`, `>out`, `&>log`,
  `*>$null`, `snapshot>out`) off the words, so a redirection is never a value
  or a target.
- A row names the app it touched. A surface names itself only when no app
  does (a screen or simulator, a page by its site, the user's own browser
  always, in amber). App Control never names itself and carries the last
  window title forward. `app-control launch` reads as the app's label or
  "the app".
- Consecutive actions with the same words, outcome and proof merge with a
  count ("Looked at ADE ×3"). An unnamed element is named by its role
  ("Clicked a button"), a bare point by the point.
- A proof call counts as filed only when its output names the record (a
  `cite:` line, the JSON record, or the filed table). Output without one
  reads "Couldn't file proof"; cut-off output reads as unconfirmed; no output
  stays neutral. A later `proof publish` adds "· posted to PR #N".
- An image the agent opens (`codex_image_view`) whose file an action of the
  same turn printed joins that action's line (`foldImageViewIntoAction`;
  macOS `/private` and Windows spellings match, drive and UNC paths
  case-insensitively). The line then reads "Taking / Took / Viewing / Viewed
  a screenshot". A line with pictures is a button: the pictures open small
  under it and enlarge on click. They start closed.
- The latest action draws in a stronger colour, with "no change seen" when ADE
  could not confirm it. Only a warning (amber) or failure (red) gets a mark,
  and a failure always says why. A running action shimmers once across the
  line. App icons come from `app.getAppIcon` (macOS, cached).
- A finished turn's fold hides these lines with the rest of its work.
- Files: `shared/computerUseActionPresentation.ts` (words),
  `chat/chatComputerUseRows.ts` (which entries are actions; a run that is not
  the turn's last draws compact, `computerUseCompact`),
  `ChatComputerUseActions.tsx` (drawing). iOS: `WorkComputerUseSummary.swift`,
  `WorkComputerUsePresentation.swift`, `WorkComputerUseActions.swift`.

### 5. Turn fold (desktop, hosted web, iOS)

Once a turn has its `done`, the rows between its user message and its answer
fold into one row: user message → `Worked for 4m 12s · 18 tools · 3 files · 2
subagents` → answer → done divider. The rules are pure in
`shared/chatTurnFold.ts`; `deriveChatTranscriptTurnFolds()` /
`applyChatTranscriptTurnFolds()` adapt them on desktop, and iOS mirrors them
in `WorkTimelineHelpers.swift` (`workTurnFoldPlan`). Events, storage, sync and
canonical text do not change.

- **Live turns never fold.**
- **The answer** is the turn's last `text` row, or its last
  `phase: "final_answer"` row. A `commentary` row is never the answer. A
  `partial_answer` row is a candidate (the last wins) but never displaces a
  `final_answer`. With no labels (Claude), an earlier text is the answer and
  the last text is a postscript when the earlier one is at least 400
  characters and three times as long, with at most three non-trivial rows
  between. The search skips empty text and other turns' rows and stops at a
  `commentary` row.
- **No fold** for a turn with no answer, or whose fold would hide only trivial
  rows (`isTrivialTurnFoldEvent`: status and diagnostics receipts, a
  subagent's `done`, empty text or thought rows).
- **The span** is the rows strictly between the user message and the answer.
  A turn with no user message starts after the previous `done`; a steer starts
  a new span. Rows after the answer never fold.
- **Whose turn a `done` ends.** A `done` whose turn id is on none of the
  window's rows, while other rows name a turn, is a subagent's
  (`isForeignTurnEnd`): it ends nothing and folds as history. An id-less
  `done` takes the id of the window's user message, else its last assistant
  text (`inferTurnEndTurnId`). A cancellation's interrupted `status` + `done`
  rows merge into one row that is the parent's (`resolveTerminusParent`);
  usage and cost sum across the cluster.
- **Narration folds; substance stays.** A non-answer text folds only when it
  is narration. It stays visible when it embeds proof or a markdown image, is
  at least 400 UTF-16 code units, or has markdown structure
  (`proseStaysVisible`). A `commentary` row folds unless it embeds proof. A
  `partial_answer` row always stays. A text that repeats the answer word for
  word folds.
- **What folds:** Thought rows, interim narration, a Codex plan-mode proposal
  card, finished activity bundles, Turn details, spawned chips, completion
  lines, compaction dividers, goal pills, the host-sleep chip, a finished
  stall card, and warning, info, hook and config notices.
- **What stays visible** below the fold row, in order: subagent cards, grids
  and stopped groups; `ade_card` rows; errors (`TurnFailureLine`,
  `AgentCliAuthCard`, `ProviderSignInReceipt`); continuity-recovery and
  reset-credit notices; error, sign-in, provider-health, thread-error and
  limit-reached notices; interrupt receipts and queue-recovery cards;
  model-switch dividers; cloud status rows; completion reports; generated
  images; any unknown row type. Background jobs, lane-setup cards, approvals,
  questions, task lists and scheduled work stay only if they were live when
  the turn ended (a job group goes with its members).
- **Sticky.** Liveness comes from a snapshot taken when the `done` is appended
  (`recordTurnEndSnapshot`, first `done` wins), with the approvals resolved so
  far. It skips a subagent's `done` (`foreignTurnEndKeys`). Live collapse and
  a full reload give the same folds.
- **The fold row** reads `Worked for <duration>` (the done divider's measured
  duration), then non-zero tool, file, subagent, background-job and source
  counts with icons. Sources come from `deriveChatSources(events).byTurn`. The
  job count reads `5 jobs (1 failed)` in red when one failed. Counts use
  `pluralCount`. Focus rings are `focus-visible` only.
  - A duration under a second reads `<1s` (`formatTurnDuration`). A turn runs
    from its user message, else from its `status: started`
    (`deriveTurnStartedAtMs`); with neither it reads `Worked`.
  - An interrupted turn reads `Stopped after <duration>`, never "you".
  - Opening the fold lists tools and files (`ChatTurnWorkSummary`,
    `align="start"`), then every span row in order, kept rows included.
  - An open fold hides an earlier text whose trimmed prose equals the answer
    (`TurnFold.duplicateAnswerKeys`); some models repeat the answer after a
    tool call. The Thought rows on either side then draw as one.
  - Each fold starts closed; open state is kept per turn in memory.
- **Scrolling.** A toggle pins the fold row's position and suspends
  bottom-follow for that change; afterwards the view follows the bottom again
  if it ends there. A turn that folds while following is re-pinned in the
  same commit. A turn that folds while the reader is scrolled up keeps the
  first visible row (or the fold row that took it) in place. The
  virtualization threshold counts unfolded rows. Heights of hidden rows are
  kept.
- **Jumps open the fold first.** A deep link or ⌘K result
  (`setPendingSessionAnchor`), a `scrollToRowKey` jump and a minimap tick
  resolve on the unfolded rows, open the fold, land and highlight, and land
  again on the next two frames. A missing target is dropped. A scroll-memory
  anchor in a fold opens it; if it can't, it lands on the fold row.
- **Row-indexed features read the unfolded rows.** Minimap items in a closed
  fold sit on the fold row (`placeMinimapEntriesOnVisibleRows`). The
  fork-history divider and inline proof draw on the fold row while their row
  is hidden. The jump pill's "N new" counts only drawn rows
  (`countVisibleRowsAppendedSince`). "Copy turn" copies text outside the fold.

### Order of the presentation passes

`AgentChatMessageList`'s `presentedRows` runs, in order:

1. `groupChatTranscriptRows` (with the stopped-group fold).
2. The presentation filter (drops `work_log_group` and covered
   `turn_diff_summary`).
3. `mergeAdjacentActivityBundleRows`.
4. `groupSubagentCardGrids`.
5. `groupBackgroundJobRuns`.
6. The turn fold.
7. `mergeAdjacentThoughtRows` (see Thought runs).

Grouping after the filter keeps undrawn rows from splitting a run. Grouping
before the fold lets the fold see one grid row, which it keeps visible. A grid
never crosses a span, because user messages and answers end runs. The
turn-end snapshot counts each agent. Jumps and anchors to a member card
resolve to its grid (`subagentCardGridKeyByMemberKey`,
`resolveAnchoredChatRowIndex`) or stopped group.

## Assistant text hover actions (desktop and hosted web)

Each assistant text row has an icon-only `Copy` beside its timestamp. On a
hover display an interim row floats this footer below the prose without a new
line. The turn-end row has one `Copy turn`, which joins the assistant text
outside the fold with blank lines (no prompt, reasoning, tool output or folded
narration). Copy always copies the stored text, never a paced prefix.

## Text merging

Adjacent `text` events merge via `shouldMergeTextRows()`:

- Events with the same `messageId` merge, unless both carry a `phase` and the
  phases differ. ADE reuses one `messageId` for consecutive text until a tool
  call, so a Codex `commentary` and its `final_answer` can share an id; they
  stay separate so the turn fold can pick the answer. A `partial_answer`
  stays separate from both. A merged row takes a later fragment's `phase`
  when the first had none.
- Events without `messageId` match on `turnId` and `itemId`.

For Claude SDK rows, `messageId` is the provider message id, so a later
`transcript_retraction` removes the exact text a refusal fallback or
`supersedes` message invalidated. A reader that never saw a message's
`message_start` (the idle reader that picks up Claude's internal follow-up
turn) uses the first delta's wire `uuid` as the id until the next
`message_start`. Each delta has its own `uuid`, so a per-delta id would split
the message into rows.

**`phase`.** A `text` event can carry `"commentary"`, `"partial_answer"` or
`"final_answer"`: interim narration, a finished statement more output may
follow, or the terminal answer. Only Codex sends it (not for every model), on
the `agentMessage` item in `item/started` / `item/completed`; an absent phase
means unknown.

- The Codex handler records the phase per item id and stamps it on that
  item's deltas. The 100 ms text buffer closes at each new `agentMessage`
  item and never mixes two phases.
- A phase first seen at `item/completed` labels only text still in the
  buffer. No extra event is emitted for flushed text.
- The field only labels text, so the stored transcript stays byte-identical.
  It survives storage and sync compaction, Codex imports, thread-read recovery
  and Codex subagent transcripts. Clients that do not know it ignore it.

`plan_text` merges the same way (`shouldMergePlanTextRows()`). A final `plan`
event for a turn replaces that turn's `plan_text` rows.

## Reasoning merging

Adjacent `reasoning` events of one turn merge into one `Thought` row even with
different `itemId`s, and the text never repeats a re-sent fragment. Claude
emits a thought under the stream content index and again under the snapshot
block index, and Cursor re-sends a run's text.

- `mergeReasoningFragment()` (`shared/chatActivityPhase.ts`) folds streaming
  fragments: exact and suffix re-emits and cumulative snapshots collapse to
  the text once.
- `mergeReasoningTextFragments()` dedupes fragment lists and keeps `---`
  between distinct blocks.
- The Claude producer skips a snapshot whose text already streamed, matched by
  text.

The `---` is a display join, not stored text. `MarkdownBlock` with
`tone="thought"` draws a thematic break as a 0.6-line gap
(`data-thought-fragment-gap`), and sets thought text smaller and quieter
(12/14 of the chat font size, 1.65 leading, foreground at 62%).

### Thought runs (desktop and hosted web)

Rows the timeline does not draw can sit between two thoughts (a hidden tool
group, or the duplicate answer an open fold hides). `mergeAdjacentThoughtRows`
(`chatThoughtRuns.ts`) runs on the drawn rows after the turn fold and merges
each run of adjacent Thought rows of one turn into one.

- **A run ends** at any drawn row. Rows that draw nothing
  (`drawsNothingBetweenThoughts`: an inline-card spawn notice, the "Promoted
  to Cursor Cloud" marker, a queued-command lifecycle that did not cancel, a
  conversation reset, an empty non-failure status) move ahead of the merged
  row.
- **Keys.** The merged row takes its first member's key and lists
  `thoughtMemberKeys`. `thoughtRunKeyByMemberKey` resolves jumps, anchors,
  scroll memory, the fork divider and inline proof to it.
- **The live thought** (`deriveLiveThinkingRowKey`) never joins an earlier
  run, so it is not remounted mid-stream.
- **Duration.** `Thought for Ns` shows only when every member has a measured
  duration (N is the sum).
- An unchanged run reuses the previous merged envelope.

### Live thinking preview (desktop and hosted web)

Every provider's thinking arrives as `reasoning` events, so one presentation
covers all (`ThinkingPreview.tsx`, through `MinimalThought` in
`AgentChatMessageList.tsx`). iOS keeps its own Thought rendering.

- **Which row is live.** `deriveLiveThinkingRowKey()` picks at most one: while
  the turn streams, the newest grouped row of the active turn if it is
  `reasoning`. It reads the rows before `work_log_group` rows leave the
  timeline, so a tool after the thought ends the preview. A phase-merged row
  stays live only while its latest fragment is newer than the merged work row.
- **Live look.** A spinner, a shimmering `Claude is thinking` (the chat's
  assistant label; `Thinking` for plain `Assistant`), and `· 12s`. Below, the
  streamed text in the thought tone at the assistant's reveal pace
  (`useRevealedLength`), growing up to four lines
  (`.ade-thinking-live-viewport`, `max-height: calc(4 * 1lh)`). Past four lines
  the newest line stays at the bottom under a top fade. The counter starts at
  the first fragment, or the latest thinking run of a phase-merged row
  (`latestStartTimestamp`).
- **Collapse.** When another row follows or the turn ends, the same row draws
  `Thought`, with `for 12s` only for a measured span of at least 1 s (never
  for a phase-merged row).
- **Opening.** A click opens the full text at full height. A click on the live
  block expands it while it streams; it stays open until clicked again. A
  click that ends a selection or hits a link does not toggle.
- **Performance.** The elapsed leaf uses the shared 1 s timer; the reveal
  re-renders only `LiveThoughtText`. Tail-following is at most one
  `scrollTop` write per frame (layout effect and a content `ResizeObserver`),
  which also sets `data-overflowing`. Only the last ~4,000 characters stay
  mounted, cut on a paragraph boundary.
- **Row height.** The live row is always the newest, so its growth never moves
  a reader scrolled up, and bottom-follow re-runs for a reader at the bottom.
- **Reduced motion** drops the shimmer, spinner and smooth scrolling
  (`usePrefersReducedMotion` and CSS).

## Turn diff summaries

When a turn on a lane moved HEAD, the service emits `turn_diff_summary` with
per-file counts. `ChatTurnDiffPanel` draws it and fetches file diffs lazily
(`ade.agentChat.getTurnFileDiff`); only this summary offers real diffs and a
SHA-scoped revert. Other turns that changed files fall back to
`ChatTurnFilesChangedSummary`, built from work-log entries for every runtime
(see [composer-and-ui.md](composer-and-ui.md#file-changes-panel)). The desktop
list draws only one of the two per turn.

## Claude tool-use tracking

The Claude SDK runtime tracks each invocation by `toolUseID`:

1. `tool_use_start` records it as in progress.
2. A `tool_use_summary` with `preceding_tool_use_ids` completes each one and
   emits `tool_use_complete`.
3. `AskUserQuestion` builds a `PendingInputRequest` with the `toolUseID`. The
   answer goes back as a `tool_result`, and `pending_input_resolved` clears
   the UI. Claude has no time-based idle watchdog (long tool calls emit no
   stream events); `pauseIdleWatchdog` / `resumeIdleWatchdog` are no-ops.
4. `resolvedToolUseIds` swallows a second resolution.

## Text batching

`main/services/chat/chatTextBatching.ts` holds streaming text for up to
100 ms before one flush.

- **Invariant:** flush at once on every non-text event, to keep the order.
  `shouldFlushBufferedAssistantTextForEvent()` is the gate; consider it for
  every new event type.
- `getRecentEntries` (auto-title, compaction) flushes first.
- Each flush has a reason (`timer`, `identityBreak`, `interleave`). With
  `ADE_PERF_RUN_ID` set, `services/perf/chatTextProbe.ts` records a
  `chatTextFlush` perf event; with no run id it does nothing. The `ade`
  runtime daemon, not Electron main, hosts chats in a normal dev session.
- The renderer paints each flush when it arrives (the paced reveal is off by
  default; see [composer-and-ui.md](composer-and-ui.md#paced-text-reveal)).
  `AgentChatPane` applies a burst of events on the next animation frame (a
  16 ms timer when no frames draw).

## Virtual scrolling and message-list layout

`AgentChatMessageList.tsx` has its own virtualizer (not
`@tanstack/react-virtual`):

- `measuredHeights` maps a row key to its measured height. An unmeasured row
  uses `estimateTranscriptRowHeight` (per kind and text length), computed once
  per key and again only when the column width moves a 64px step.
- A top and a bottom spacer size the window from that map.
- While the list follows the bottom, the rows sit at the end of the virtual
  box (`END_ALIGNED_VIRTUAL_BOX_STYLE`). Rows that just mounted keep their
  estimated height in the box until they measure; at the end, that slack sits
  above them, out of view, and never shows as an empty pane under the last
  message.
- `MeasuredEventRow` reports heights through a `ResizeObserver`;
  `reconcileMeasuredScrollTop` adjusts `scrollTop` when a row above (or
  across) the viewport top changes height.

Below `VIRTUALIZATION_THRESHOLD` rows every row renders directly. One content
width applies to every transcript element: `chatAppearance.ts` publishes
`--chat-content-width` = `min(100%, clamp(720px, 62vw, 1180px))` (alias
`--chat-column`); `resolveChatContentWidthPx()` mirrors it for layout math.

Card rows compose `chatCardPrimitives.tsx` (a 16 px glyph column, a flexible
content column, an auto meta/action column; a hairline row for passing facts,
an inset for live work, an amber rail for failures). `AdeCard`,
`CodexPlanCard`, files changed, tool rows and the stopped-agents group use
them; subagent cards have their own frame.

Other rules:

- Completed-turn dividers show local time and measured duration. Proof is
  bucketed into turns by `artifact.createdAt`: "N proof filed ›" on the
  divider, and "▣ N proof ›" at the end of the fold line, which never wraps.
  It opens the proof drawer on those records. Proof filed between rows is the
  same count at that point, minus records a "Filed proof" row shows. Proof an
  answer cites is not counted.
- Code renders through `HighlightedCode`. User messages animate in and render
  in full.
- Plan approval bodies render whole. Only the pinned `ChatProposedPlanCard`
  caps its body (`min(52vh, 560px)`), so its buttons stay on screen.

### Row keys

A row key comes from the event's identity, never its position
(`allocateTranscriptEventRowKey`):

- `<sessionId>:<type>:m:<messageId>[:<phase>]` when the event names a message.
- `<sessionId>:<type>:i:<turnId>:<logicalItemId or itemId>` when it names an
  item.
- `<sessionId>:<type>@<timestamp>` otherwise.
- A `#n` suffix counts earlier events in the window with the same base.

Derived keys (`work-log:`, `activity:`, `reasoning-group:`,
`activity-phase-*:`, `terminus:`) wrap a row key. Grid and job-group rows
reuse their first member's key. So a prepended page, a trim, a snapshot merge
or a late insert keeps every surviving key, and with it heights, mounts,
scroll memory, the "N new" anchor, fold state, snapshots, highlights, proof
anchors and the minimap. `buildTranscriptEventRowKeys` replays the assignment
without a collapse. Keys move only when a page boundary splits two id-less
events of one type in the same millisecond. `sceneRowIdentity` keeps its own
frozen format.

### Anchoring the reader

The list owns scroll anchoring (`overflow-anchor: none`):

- **Row-list changes.** When drawn keys change while the reader is scrolled
  up, the render pass reads up to four on-screen rows and their tops before
  the commit, and the layout effect moves `scrollTop` by how far the first
  mounted one moved. In the virtualized path the window keeps that row
  mounted. The anchor stands down while following the bottom, during a fold
  pin, a jump or a scroll restore.
- **Scroll memory.** Leaving a chat saves the first on-screen row, the offset
  into it and the distance from the bottom. Returning puts the row back and
  re-applies each frame until it holds for two frames; a wheel, touch, press
  or scroll key cancels. A missing row lands the saved distance from the
  bottom.
- **Older history** loads near the top (two viewports of runway), with no
  button, and never during a restore. Automatic triggers get one page between
  two reader scrolls; an underfilled pane keeps backfilling; a failure offers
  Retry. The main Work pane fills a local chat's history 1.5 s after the open
  (at once on scroll-up, find or the prompt rail), in 512 KiB pages. A chat
  on another machine fills only on demand.
- **Code blocks.** `HighlightedCode` renders a cached highlight on the first
  frame, and the fallback and Shiki share one font, line height and wrap, so
  highlighting never changes a row's height.

### Run on shell code blocks

`ChatCodeBlockRun.tsx`, rules in `shellCodeBlockRun.ts`.

- **Which blocks.** A settled assistant reply's `bash`, `sh`, `zsh`, `shell`,
  `console`, `powershell`, `pwsh` and `ps1` blocks offer Run beside Copy.
  `MarkdownBlock` passes `runnableCode` only from `AssistantTextBody`, never
  while the turn is live. The control mounts on first hover or focus.
- **Run.** A confirm shows the script, the chat's machine and the lane folder.
  Confirm calls `pty.create` on the chat's pin, owned by the chat
  (`chatSessionId`), running the interpreter with the script as one argument
  (`bash -c <script>`, `powershell.exe -EncodedCommand`), with
  `SHELL_BLOCK_RUN_ENV` (`PAGER=cat`, `GIT_PAGER=cat`). A `console` block runs
  only its `$ `/`% ` lines.
- **Platform.** A Windows lane folder runs PowerShell blocks and disables bash
  blocks with a reason; elsewhere the reverse. `cmd`/`bat` never run.
- **Disabled with a reason:** a personal chat, an archived lane, an offline
  machine, hidden control characters, an over-long script. The brain refuses
  a lane whose folder is gone (`resolveLaneLaunchContext`).
- The terminal opens in the chat's tools pane (`ChatTerminalRevealContext`,
  `requestChatTerminalFocus`) only while the pane still shows that chat.
- The run settles on the PTY exit event, or on `sessions.get` status when the
  feed misses it (a remote feed can start late; the hosted web reports exits
  only to a subscribed view).
- **Send output to the agent** (after exit, only on click) reads the host's
  terminal snapshot (`terminal.preview`) through an offscreen xterm, because
  raw ConPTY output holds every repaint. Without a snapshot it uses the raw
  transcript with escapes stripped. It sends command, exit code and the last
  20,000 characters as a user message on the chat's pin.
- Windows PowerShell 5.1 drops pending table output when a script ends in
  `exit` or `throw`; that output never reaches the terminal.
- Runs live in a module store keyed by chat and block. The hosted web sends
  `work.runShellBlock`; a host without it gets an "update ADE" refusal.

## History snapshots, scroll-back, and misses

A chat pane hydrates from `ade.agentChat.getEventHistory`
(`AgentChatEventHistorySnapshot`) and pages back with
`ade.agentChat.getEventHistoryPage` (`AgentChatEventHistoryPage`), both in
`shared/types/chat.ts`. Callers send one object
(`{ sessionId, beforeOffset?, maxBytes? }`); the registry still accepts the
legacy positional form. A one-argument runtime wrapper drops a second
positional argument, so every older-page request would fail.

### Resume — reopening a chat sends only what is new

Every snapshot carries `tailEndOffset` and `historyGeneration` (moves when a
rewind or import rewrites the file). A reopened chat passes them back as
`afterOffset` and `historyGeneration`. When the generation matches, the reply
holds the seam event and everything newer with `resumedFromOffset`, and the
client merges it. A mismatch, or a host that does not know the arguments,
answers with the full window. On a remote machine a warm switch costs
kilobytes.

### `hasOlderHistory` — is there anything to scroll back to?

`agentChatService` derives it from the tail read (`transcriptTruncated ||
windowTruncated`), never from envelope identity, which the ring buffer and the
coalescing pipeline lose. Gate the "load earlier" slot on this field, not on
`tailStartOffset > 0`: `resolveSnapshotHistoryCursor` returns cursor `0` when
it is `false`. Older runtimes that omit it use the offset-only rule.

### `tailStartOffset` — the paging cursor, in three tiers

`tailStartOffset` is the `beforeOffset` for the next page, in this order:

1. **Exact.** The oldest returned event maps to a transcript line: use its
   byte offset.
2. **Identity lost, window complete** (`!windowTruncated`): page from the tail
   read's `startOffset`. A tail from byte 0 gives `null` (nothing older).
3. **Degraded.** Identity lost and the window dropped events: page from
   `endOffset`, gated on `hasOlderHistory`. Pages then repeat events, which the
   client dedupes, but scroll-back still reaches the head. Keep this fallback:
   without it a truncated transcript served from the ring buffer cannot scroll
   back.

`advanceOlderHistoryCursor` advances only on `hasMore` **and** a strictly
smaller `startOffset`, so paging loops end. A page that claims `hasMore`
without a smaller cursor is a retryable protocol failure.

### A row too large to page

A row over the 2 MB page cap never blocks scroll-back.
`chatTranscriptHistoryPager.ts` returns it as its own page with, in its place,
a display-only `system_notice` (`status: "history_row_omitted"`, **no
`sequence`**). Every client draws it as an info line.

- A row up to 8 MB (`SEQUENCE_PROBE_MAX_ROW_BYTES`) is parsed so the notice
  names its size, kind and time; a larger row gets a generic notice.
- The notice carries `omittedRow: { offset, bytes, eventType? }`; the offset
  is its identity on desktop and the phone.
- With no sequence, a durable log keyed on sequence never stores it as the
  row.
- A sequence-cursor reply (`beforeSequence`, `chat.getChatEvents`) always
  holds a shown sequenced row older than the cursor, or `hasMore: false`. It
  reads past oversized, unsequenced and hidden rows (Codex subagent rows,
  `isVisible`). A file that shrinks mid-read fails with the retryable
  `chat_history_changed_during_read`.
- A transcript read (`getChatTranscript`, `ade chat read`, handoff briefs)
  reports `truncated: true` when the omitted row may have held a message.
- `getChatEventHistoryPage` returns `envelopeStartOffsets` lined up with its
  events.

### Paging and caches

- Desktop and personal chats request 256 KiB pages; the background fill
  512 KiB. A selected view keeps at most 60,000 events / 32 MiB; a background
  personal view 1,000 events / 2 MiB. A page commits only while the session,
  runtime, request generation and cursor still match.
- One "load earlier" is one batch (`readOlderHistoryBatch`): pages until the
  span holds a `user_message` (one page can be hundreds of text deltas that
  fold to one line), also through empty pages that still progress. Bounds:
  `maxPages` 8 and `maxAnchorEvents` 400; hitting one is not an error. Pages
  already collected are kept even if a later read says `sessionFound ===
  false`.
- An overlapping snapshot keeps an exhausted cursor only when its oldest event
  survived the merge.
- **History and live stream.** The history API owns the range it returns; the
  live stream owns only events outside it. `shared/chatHistoryMerge.ts`
  removes duplicates, inserts delayed live rows by time before later terminal
  rows, and never appends a replayed old turn after the tail. Identity is
  cached per envelope object. Desktop installs the live listener before the
  history read. The hosted web uses `chat_subscribe` snapshots only as
  watermarks and hydrates through `chat.getChatEventHistory`. iOS sorts and
  dedupes by the same rules.
- **View cache.** A per-session cache (128 MB, 32 MB per chat) paints a
  return at once. A hidden chat's retention subscription keeps the concrete
  binding it had, so a project switch cannot retarget it. Composer controls
  are withheld for the one frame where the incoming transcript and selected
  session differ.
- **An unchanged transcript reconciles to the same list.**
  `mergeAgentChatHistorySnapshot` maps a rebuilt envelope (a tool call the
  provider sent twice) back to the held one. `RuntimeRpcClient` decodes the
  reply stream with a `StringDecoder`, so a multi-byte character at a read
  boundary stays whole.

### What one streamed event costs

A streamed event must cost that event, not the transcript. Each shortcut falls
back to the full computation, which defines the result:

- `mergeAgentChatLiveEvents` passes its identity keys and tool-call positions
  to the next merge (`liveMergeIndexByList`); a provider resend updates the
  stored envelope in place.
- `agentChatLiveAppendOf(list)` names what an append extended. Folds that keep
  an answer per list (`deriveRuntimeState`, the active turn, its start, the
  turn-start map) read only the new events.
- `chatDisplayEvents` extends its previous answer and records the relation
  (`recordAgentChatLiveAppend`). A batch that shows nothing returns the old
  list, so nothing renders.
- The row builder replays from the newest of two checkpoints before a
  replaced event. Row indexes are complete after a full pass
  (`rowIndexesComplete`). `cloneCollapseTranscriptContext` copies field by
  field, so a new field does not compile until copied.

`scripts/perf/service/chat-transcript.bench.mts` checks incremental rows
against a full pass on real transcripts.

### `unavailable` — "could not reach the runtime", not "no such session"

`sessionFound: false` is authoritative. `unavailable: true` means the runtime
could not be reached (remote hop down, machine asleep, project switch). Never
clear or blank a chat on it.

- **Preload** returns it for `getEventHistory` / `getEventHistoryPage` when the
  call was unhandled during a project switch **and** the window's runtime is
  remote. The local service would answer a false `sessionFound: false` for a
  remote id. Local bindings still go to IPC. The page variant echoes the
  caller's cursor. See
  [Remote runtime internals](../remote-runtime/internal-architecture.md#local-runtime-routing).
- **The web adapter** (`webclient/adapter/agentChat.ts`, `personalChats.ts`)
  sets it when the host command could not be reached.

`resolveChatHistoryMissAction` in `AgentChatPane`:

| Result | Action | Meaning |
|---|---|---|
| `unavailable: true` | `sync-pending` | Keep everything, retry later, show the catch-up hairline. |
| `sessionFound: false`, events rendered | `keep-missing` | Keep the real transcript on screen; mark it for a later "chat no longer exists" pass. |
| `sessionFound: false`, nothing rendered | `clear` | Drop the empty view. |

## Persisted transcript

A chat writes one file: `.ade/transcripts/chat/<sessionId>.jsonl`. The session
row still names `.ade/transcripts/<sessionId>.chat.jsonl` (that column syncs
to peers and older builds); `resolveChatTranscriptReadPath` maps it to the
dedicated file. The storage doctor removes an old 8 MB-capped copy once its
content is in the dedicated file. Recovery prefers files with real chat
envelopes, then uncapped files, then newer readable files (size breaks ties).

**Compaction.** Stored events keep the `AgentChatEvent` shape, but large
command output, tool results (`result` and `structured`), diffs, reasoning
text and inline image data URIs become a preview plus omitted-byte metadata
(`outputOriginalBytes`, `resultOmittedBytes`, …). Live subscribers get the
original during the turn.

- Codex command deltas join per command into one `command` event, at most ten
  a second (or at 64 KiB). Any other event flushes the chunk first.
- The policy is one module, `shared/chatEventCompaction.ts`, for the stored
  transcript (`compactChatEventForStorage`) and the sync wire
  (`compactChatEventForWire`). The wire runs storage compaction first, so a
  live push and a re-read are byte-identical, then drops
  `tool_result.structured` and `tool_result.toolResultMeta`, which no client
  reads.
- **Compaction must stay idempotent.** A re-wrapped preview grows past the
  cap. The module recognizes its own wrapper by shape (`summary` starting
  `[ADE] Large `, with `preview` / `originalBytes` / `omittedBytes`), not by a
  marker key, up to 2× the cap.
- `summarizeDiffStats` matches the current and the older shortened-diff
  notice, so an old shortened diff is still counted as shortened.

`agentChatService.ts` (`PersistedChatState`) rebuilds a session (version 2):
recent entries become envelopes, a continuity summary goes into the new
runtime context, and provider-native state (Claude session id, Codex
app-server socket, OpenCode runtime ids) comes back so the next turn uses the
same session.

### Claude restart and Stop recovery

Every parent turn ends with a terminal `status` and a matching `done`.

- **Restart.** When a Claude runtime is created, `agentChatService` checks the
  latest non-steer parent turn (also with no saved SDK session id), adds only
  the missing member of the pair, marks the session idle and saves. It never
  rewrites older turns.
- **Order.** Reconciliation closes orphaned background and subagent rows
  first, then appends the parent pair, because turn state is derived in event
  order. Stop on an idle Claude runtime runs the same repair. Both are
  idempotent.
- **Settled subagents stay settled.** Codex delivers each `subAgentActivity`
  item twice; the service acts only on the first (a `started` kind opens,
  `interrupted` closes only a running thread, other kinds give progress only
  for a running thread). Backstops: `subagentSnapshotsFromEvents` ignores
  progress after a result, the stale-run sweep skips snapshots with
  `endedAt`, and the renderer drops a `system` / `foreign-brain` stop for a
  settled agent. Runtime filler (`SUBAGENT_PLACEHOLDER_SUMMARY`) is never
  saved as a report.
- **Bounded control calls.** `interrupt()` gets 2.5 s; `stopTask()` calls 2 s
  each, at the same time. A hung control channel is logged and local cleanup
  continues; an interrupt-and-replace that needs the provider's answer fails
  within the bound. A steer to an idle Claude session waits only for input
  acceptance.
- **Queues on Stop.** `stop_and_clear` (**Turn + queue**, the default) uses
  `cancel_queued: true` when Claude supports it, else interrupts and cancels
  each provider-queued message (`cancelAsyncMessage`), and clears local
  steers. `stop_only` keeps queues and background jobs.
  `stop_and_background` / `stop_and_clear_and_background` also stop Claude
  tasks. A clear snapshots the steers it cancelled, emits `queue_recovery`,
  and accepts one `restoreCancelledQueue` for eight seconds; expiry and
  restore are saved as terminal events.

**Codex staged messages.** Codex stages a rejected steer on the app-server's
queue (`thread/queue/add`). The `steerId` → `submissionId` map lives only on
the runtime, so `cancelSteer` re-reads the server queue, where each entry
carries the `steerId` as `clientUserMessageId`:

- A failed `thread/queue/delete` raises; the chip stays.
- An unreadable queue raises; the chip stays.
- A submission found nowhere clears the chip with `Queued message cancelled.`
- A cancel with no runtime also drops the steer from saved `pendingSteers`,
  which `persistChatState` otherwise carries forward.
- `requireQueued: true` (the composer's Edit) refuses instead of clearing.

**Codex turn ends.** Every path that ends a Codex turn (Stop, local interrupt,
`turn/aborted`, teardown, `thread/deleted`, an app-server crash) runs
`settleCodexPendingInputs`, because a Codex plan approval is raised after
`turn/completed`. It empties the approvals map, so a later `turn/aborted` is a
no-op. Settle teardown's `stop_only` leaves the cards.

Codex adapters dedupe repeated lifecycle notifications. Terminal app-server
failures share one key (turn id + message + detail + error identity);
retrying notifications stay provider-health notices. The renderer applies the
same rule on replay.

## Gotchas

- **`messageId` before turn/item identity.** A provider that stops sending
  `messageId` merges correctly but noisier; watch `shouldMergeTextRows` when
  swapping SDKs.
- **Hidden event types drop silently.** A new event type for the work log
  needs plumbing in `chatTranscriptRows.ts` and `HiddenTranscriptEvent`.
- **Row keys never carry an index.** Build keys from identity; see
  [Row keys](#row-keys).
- **`logicalItemId` before `itemId`** in collapse keys, or re-emits become
  duplicate rows.
- **Turn diffs need a lane.** No lane, no `turn_diff_summary`.
- **The fold's keep-visible decision is taken once, at `done`.** New row types
  default to visible; add a type to `classifyTurnFoldEvent`'s sets on
  purpose, and give a grouped keep-if-live row its `liveKeys`.
- **Timeline rows are the folded list.** In `AgentChatMessageList`,
  `presentedRows` are unfolded and `groupedRows` folded. Rendering and scroll
  use `groupedRows`; anything that resolves a target from events or keys looks
  in the unfolded rows, then opens the fold (`revealTurnFoldRow`) or maps to
  the fold row (`foldIdByHiddenRowKey`). Prune the height cache against
  unfolded keys plus fold ids.
- **A card in a grid or stopped group is not a row.** Map card keys through
  `subagentCardGridKeyByMemberKey` / `subagentCardRowKeyCandidates`, never by
  one prefix. Never splice the spawn row out on settle.
- **Claude parent terminal events are an ordered pair**, after any orphan
  cleanup.
- **A terminal turn does not clear a Codex card; a receipt does.** Every Codex
  turn-ending path emits `pending_input_resolved`, except on runtime death for
  a plan approval (`planApprovals: "preserve-cards"`), so `respondToInput` can
  rebuild the card. See
  [README › Fragile and tricky wiring](README.md#fragile-and-tricky-wiring).
- **Claude idle turns close on an SDK event, never on a timer:** the
  `session_state_changed` message with `state: "idle"`. `finishClaudeIdleTurn`
  no-ops with no idle turn open. Do not add a time-based idle watchdog (long
  tool calls emit nothing). New Claude `system` subtypes hit a compile-time
  exhaustiveness guard.
- **A failed history read is not a missing chat.** Set `unavailable: true`,
  never `sessionFound: false`, for a connection or dispatch failure.
- **`tailStartOffset > 0` does not mean older history.** Gate on
  `hasOlderHistory`.
- **Subscribed mobile history pages do not start project runtimes.** Hosts
  with `chatHistoryPaging` answer `chat_history` pages on the authorized
  subscription's transcript path. A scope mismatch or read failure returns
  `unavailable: true` with the cursor intact.
