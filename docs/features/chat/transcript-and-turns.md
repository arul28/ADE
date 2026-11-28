# Chat transcript and turns

The transcript is a JSON-lines stream of `AgentChatEventEnvelope` records.
Everything the chat draws (messages, tools, commands, file changes, plans,
pending inputs, turn dividers) derives from this one stream, which is persisted
so chats survive restarts.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | `AgentChatEvent` union and envelope types. |
| `apps/desktop/src/shared/chatTranscript.ts` | `parseAgentChatTranscript`, summaries, `userMessageStartsTurn`. |
| `apps/desktop/src/main/services/chat/chatTranscriptEntries.ts` | Canonical role-tagged text (`transcriptEntriesFromEnvelopes`). |
| `apps/desktop/src/shared/chatTurnFold.ts` | Turn fold rules. |
| `apps/desktop/src/shared/chatEventCompaction.ts` | Storage and wire compaction (one policy). |
| `apps/desktop/src/shared/chatHistoryMerge.ts` | Merging history pages with live events. |
| `apps/desktop/src/shared/chatSources.ts`, `main/services/chat/chatSourceAdapters.ts`, `sourceFaviconService.ts` | Sources model, per-provider adapters, favicons. |
| `apps/desktop/src/shared/chatSubagents.ts`, `chatActivityPhase.ts`, `chatTaskList.ts`, `chatErrorPresentation.ts` | Subagent naming/collapse, activity phase, the task list, error copy. |
| `apps/desktop/src/shared/computerUseAction*.ts` | Computer-use command summaries. |
| `apps/desktop/src/main/services/chat/chatTextBatching.ts` | 100 ms text batching. |
| `apps/desktop/src/main/services/chat/runtimeEvents.ts` | Canonical dotted runtime events. |
| `apps/desktop/src/main/services/chat/claudeStructuredActivity.ts`, `claudeWorkflowProgress.ts` | Claude server-tool blocks; Workflow progress. |
| `apps/desktop/src/main/services/chat/chatTranscriptHistoryPager.ts` | Bounded history pager. |
| `apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts` | Events → rows (collapse pass). |
| `apps/desktop/src/renderer/components/chat/chatThoughtRuns.ts`, `chatBackgroundJobRuns.ts`, `chatScheduledWorkRows.ts`, `chatComputerUseRows.ts` | Later grouping passes. |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`, `chatCardPrimitives.tsx` | Virtualized list and card primitives. |
| `apps/ios/ADE/Views/Work/WorkTimelineHelpers.swift` | iOS port of the timeline rules. |

## Gotchas

- **`messageId` before turn/item identity.** A provider that stops sending
  `messageId` merges noisier; watch `shouldMergeTextRows` when swapping SDKs.
- **New event types drop silently** unless plumbed through
  `chatTranscriptRows.ts` / `HiddenTranscriptEvent`, and considered by
  `shouldFlushBufferedAssistantTextForEvent` and `isTranscriptContentEvent`.
- **Row keys never carry an index** ([Row keys](#row-keys)).
- **`logicalItemId` before `itemId`** in collapse keys, or re-emits duplicate.
- **Turn diffs need a lane.**
- **The fold's keep-visible decision is taken once, at `done`.** New row types
  default to visible; add types to `classifyTurnFoldEvent` on purpose.
- **Timeline rows are folded.** In `AgentChatMessageList`, `presentedRows` are
  unfolded and `groupedRows` folded. Anything resolving a target looks in the
  unfolded rows, then opens the fold (`revealTurnFoldRow`) or maps to the fold
  row (`foldIdByHiddenRowKey`).
- **A card in a grid or stopped group is not a row.** Map through
  `subagentCardGridKeyByMemberKey` / `subagentCardRowKeyCandidates`. Never
  splice the spawn row out on settle.
- **Claude parent terminal events are an ordered pair** (`status` then
  `done`), after orphan cleanup.
- **A terminal turn does not clear a Codex card; a receipt does.** Every Codex
  turn-ending path emits `pending_input_resolved`, except plan approvals on
  runtime death (`planApprovals: "preserve-cards"`).
- **Claude idle turns close on the SDK's `session_state_changed` idle event,
  never a timer.** Do not add a time-based idle watchdog.
- **A failed history read is not a missing chat:** `unavailable: true`, never
  `sessionFound: false`.
- **`tailStartOffset > 0` does not mean older history.** Gate on
  `hasOlderHistory`.

## Event envelope

`AgentChatEventEnvelope` = `{ sessionId, timestamp, event, sequence?,
provenance? }`. `provenance` (message ids, thread, role, run/step/lane ids,
retractions) routes delegated worker messages back to the right feed.

## Canonical assistant text (fragile — read before editing)

`chat.getTranscript`, the paged history reader and internal readers flatten the
stream with `transcriptEntriesFromEnvelopes`. Clients holding both the live
fragments and canonical text (iOS, web) reconcile them, so:

> Canonical text is byte-identical to what a renderer draws from the same
> envelopes. DAEX never invents a character.

- Entries group on `messageId` (else the turn), as every renderer keys. Never
  split finer (e.g. on Codex's per-message `itemId`), or clients concatenate.
- Identified fragments concatenate verbatim, whatever interleaves. Only
  fragments with no provider message fall back to inferring boundaries.
- `isTranscriptContentEvent` is an allowlist of content types: ephemeral chrome
  (`activity`, live `context_usage`) never breaks a run. Keep rendered rows
  (`todo_update`, `subagent_*`, `ade_card`, `done`) in it.
- A user message clears every open entry. A whitespace-only fragment is dropped
  only when there is no run to continue.
- Clients need no reconciliation heuristic; do not add a client rule that
  guesses what a sequence-less envelope holds (paged reads can split a message).

## Parsing

`parseAgentChatTranscript(raw)` skips malformed lines, fills missing timestamps,
and keeps only envelopes with a `sessionId` and an `event`. Helpers:
`hasMaterialWorkerChatEvent`, `hasWorkerChatLifecycleEvent`,
`deriveAgentChatTranscriptSummary`.

## The event union

Read `AgentChatEvent` in `shared/types/chat.ts` for fields. Notes per type:

| Type | Notes |
|---|---|
| `user_message` | Text, attachments, `turnId`, optional `steerId` and `deliveryState`: `queued`, `delivered`, `inline` (folded into the live turn), `accepted` ("Steering…", written first by Cursor/OpenCode/Pi before the provider takes it), `failed`. A refused steer never stays `accepted`. `sentAt` shows a held send's real send time. `metadata.boardMove` renders as a divider. Messages a person did not type (`agentRelay`, `automationRun`, `scheduledWake`) fold into one compact row (`resolveUserMessageBody`). |
| `text` | Streaming assistant text; optional Codex `phase` (below). |
| `transcript_retraction` | Removes earlier text rows by provider `messageId` (Claude refusal fallback, `supersedes`). JSONL stays append-only. |
| `reasoning` | Thought rows. |
| `tool_call` / `tool_result` | Paired per call. `structured` and `toolResultMeta` are local debug data (bounded on disk, stripped from the wire). MCP calls carry `mcp` (server, tool, plugin/app). Web tools add `sources` (≤ 20, http(s), on every wire). |
| `file_change`, `command` | File writes; shell commands with output, exit code, duration. |
| `plan` | Steps write the chat's task list; a Codex plan-mode proposal (no steps, `streamingText`) keeps its own card; no steps and no text clears the list. |
| `approval_request`, `structured_question`, `pending_input_resolved` | Pending input; the last is hidden and clears UI state. |
| `status`, `done` | Turn lifecycle; `done` has model, usage, cost, `terminalReason`, Claude provenance. A non-completed `done` clears non-question pending inputs. |
| `error` | `errorInfo.presentation` (`{ title, body, nextAction?, technicalDetail? }` from `chatErrorPresentation.ts`) is the card copy on every surface; raw provider text goes in `technicalDetail`. Codex duplicate terminal errors collapse to one row. |
| `activity` | Ephemeral, hidden. Provider retry/reconnect progress is live-only `activity` and leaves no row when it succeeds. |
| `todo_update` | Whole task-list snapshot. |
| `subagent_started` / `_progress` / `_result` | Subagent lifecycle (below). `subagent_result` is the single end event; there is no canonical end twin. |
| `scheduled_work_update` | Wake-ups, crons, loops, remote triggers, background tasks (`shared/chatScheduledWork.ts`). Claude's backgrounded shells arrive only as `kind: "background_task"`. |
| `system_notice` | Chrome: auth, rate limits, spawn chips (`status: "subagent_spawned"`), `model_switched`, `agent_download` ("Getting <agent> ready…"), `history_row_omitted`. |
| `model_handoff` | Only on a **provider-group** change; same-provider pairs draw nothing. |
| `conversation_reset` | New Claude conversation inside one DAEX session. |
| `interrupt_receipt`, `queue_recovery`, `command_lifecycle` | Claude queue state after Stop; Undo window (8 s); DAEX-owned message lifecycle. |
| `claude_goal_updated` / `_cleared` | Claude `/goal`. |
| `session_meta_updated` | Title and mode fields changed elsewhere; re-seeds composer controls live. |
| `turn_diff_summary` | Git before/after SHAs and per-file stats for a turn on a lane. |
| `context_usage` | Occupancy samples (`origin`: `live`, `snapshot`, `compact`, `command`); `state` other than `measured` hides the old percentage. `/context` renders its breakdown card. |
| `context_compact` | Compaction lifecycle per `compactionId`: `started` once, `completed` (tokens, summary) or `failed` (`failReason`). Open compactions close as failed when their turn ends. |
| `web_search`, `sources` | Search/fetch lifecycle; data-only citations. |
| `codex_image_generation` / `codex_image_view` | Generated / viewed images for every provider (legacy prefix). |
| `codex_*` runtime events | Safety buffering, moderation, `codex_turn_stalled` recovery, `codex_thread_deleted`. `codex_sleep` is legacy. |
| `auto_approval_review`, `prompt_suggestion`, `step_boundary`, `tool_use_summary` | Auto-approval text; suggested prompts; OpenCode step markers; Claude tool lifecycle. |
| `completion_report`, `delegation_state` | No current producer; only in old transcripts. |

### Subagent lifecycle producers

- **Claude** native subagents: `agentType` = Task `subagent_type`, `label` =
  Task `name` (stashed per id outside `activeSubagents`, which terminal paths
  delete first). Housekeeping tasks (`skip_transcript`, `task_type` `other`)
  are filtered; background shells go to the background pane. Every result is
  gated on a recorded start (`emittedSubagentStartIds`).
- **Claude Workflow runs:** `workflow_progress` snapshots
  (`claudeWorkflowProgress.ts`) diff into per-agent rows keyed
  `<taskId>::a<index>`.
- **Codex** parallel agents (`subAgentActivity`, labels `Agent #N`), OpenCode
  child sessions, Cursor, Droid, Grok.
- **Child chats** (`orchestrationParentSessionId` outside a run): synthetic
  rows keyed `chat:<childSessionId>`.
- **CLI children** (`daex new chat --mode cli --parent …`):
  `notifyParentOfCliChildSpawn` emits a `chat:<terminalId>` card; the PTY exit
  closes it (0 → completed, non-zero → failed, closed → stopped unless the CLI
  left a closing message). Completion goes through
  `deliverChildCompletionToParent` (dedupe `cli-exit:<endedAt>`).
  `daex chat status|list|read` answer for CLI children.
- Model and effort on subagent rows are the child's own; late Claude tool input
  re-emits a corrected start. Cards wear the provider mark of the runtime that
  ran them (a child chat's own provider).

## Compaction divider

One line per `compactionId` (`ContextCompactDivider.tsx`; iOS
`WorkContextCompactDivider.swift`): Running (spinner, tokens, elapsed from the
first `started`), Done (`481k → 6k`, a summary button), Cancelled (Stop or the
provider cancelled; **Retry**), Failed (with weekly/usage limit and account when
known; **Retry**). A compaction-only turn draws just that line.
`sessionActivityDetector` shows `compacting` and `compaction_failed` on the Work
row.

## Claude context guardrails

Occupancy = last request's input + cache read + cache creation, against the
model maximum (`modelUsage[].contextWindow`, else registry).
`getContextUsage().raw_max_tokens` is the compaction window; Claude compacts
33,000 tokens below it (`autoCompactThreshold`, shown as `compactAtTokens`).
DAEX sends a fallback `/compact` only at a turn boundary when occupancy ≥ 97%,
no natural compaction since 90%, and no fallback yet in this high-water episode
(resets below 80%). On `prompt_too_long`, DAEX compacts once and asks the user
to re-send; it never replays automatically.

## Canonical runtime events

`runtimeEvents.ts` defines `turn.started`, `content.delta`, `tool.*`,
`subagent.started|progress|completed`, `turn.completed`, `compact.boundary`, and
others. Claude writes dotted start/progress rows beside the legacy ones;
`subagent_result` is never translated, so no second end event exists. Replayed
old pairs collapse on read (`collapseLegacySubagentEndEvents`; iOS
`collapseLegacyWorkSubagentResultEnvelopes`). `AgentChatPane` hides dotted rows.

## Structured activity

- Claude server `web_search` / `web_fetch` blocks become `web_search` events;
  Agent SDK `WebSearch`/`WebFetch` results and citations become sources; MCP
  blocks become paired tool events.
- Codex `mcpToolCall` keeps plugin/app metadata.
- Cursor `updateTodos` folds into `todo_update` + `plan`.
- Every event uses the provider item id (plus turn id) as its lifecycle key, so
  updates change one row.

### One task list per chat

`shared/chatTaskList.ts` (`deriveChatTaskList`, `reduceChatTaskList`) owns one
task list per chat. Desktop reads it; iOS still draws a plan card per turn.

| Provider | Native shape | DAEX event |
|---|---|---|
| Claude | `TodoWrite`; `TaskCreate` / `TaskUpdate` | `todo_update` (with `activeForm`) |
| Codex | `turn/plan/updated`; `update_plan`; legacy `planningItem` | `plan`; `todo_update` for `planningItem` |
| Cursor | `updateTodos`; the `ade_update_plan` fence | `todo_update` + `plan` |
| ACP | `plan` / `plan_update` entries; `plan_removed` | `plan` (with `priority`) |
| Droid | `TodoWrite` text or JSON list | tool row + `todo_update` |
| OpenCode 2.0 | none (no `todowrite`) | — |

- Each update carries the whole list; the newest wins across turns and shapes.
  A `todo_update` onto a same-turn plan updates that plan's items
  (`foldTodoItemsIntoTaskItems`).
- Empty `todo_update` or an empty `plan` clears the list. Codex plan-mode
  proposals never touch it.
- Statuses unify to `pending | running | done | failed`; a provider
  `cancelled` item is `completed` + `cancelled: true` on the wire and shows as
  skipped.
- In the thread it is one `task_list` row keyed `task-list:<sessionId>` that
  moves to the latest update and never folds. `ChatTaskListCard.tsx` is
  collapsed to `label · done/total · current item`.

## Sources

`deriveChatSources(events)` (`shared/chatSources.ts`) returns every
`ChatSource`, four groups and `byTurn`.

- Inputs: `web_search` results and URL actions, `tool_result.sources`,
  `sources` events, MCP calls and URL records in MCP JSON, attachments, Linear
  context. Failures contribute nothing.
- `normalizeSourceUrl` dedupes pages (scheme, host aliases, tracking params,
  fragments, trailing slash; git-ref `?ref=` kept).
- A source is **cited** by a structured citation or when an assistant answer
  links to it (`linkedSourceUrls`); a link never adds a source.
- Groups: Cited → Web → Files → Apps (each source in one group). `byTurn`
  excludes apps and user attachments.
- Per-provider adapters: `chatSourceAdapters.ts` (bounded by
  `boundChatSourceRefs`). ACP `search` counts only with a query and URL output,
  so grep never becomes a source.
- Shown in the drawer (`ChatSourcesPanel`, only when non-empty), as a turn chip
  on the turn-end line (wide screens), on the fold row, and as result links on
  web tool rows.

### Favicons

`sourceFaviconService.ts` fetches icons first-party from the visited site
(never a third-party favicon service) via `chat.resolveSourceFavicons`
(`{ domains }` ≤ 48 → `{ icons }`). HTTPS:443 only; private/loopback/local names
refused; DNS answers vetted and pinned; ≤ 3 redirects; 3 s, 256 KB HTML, 64 KB
per icon; image bytes sniffed; scripted SVG refused. Cache:
`<ADE home>/cache/favicons/<sha1(host)>.json` (7 days icon, 1 day none, 8 MB
cap). Renderer: `useSourceFavicon` requests only on-screen domains, batched.

### Provider retry and reconnect presentation

Claude `api_retry`, Codex `willRetry`, OpenCode retry status, Pi
`auto_retry_start` and Cursor thread recovery normalize to live `activity` with
one replaceable detail ("Reconnecting to Claude · attempt 6 of 10 · retrying in
8s"). A success leaves no row; exhaustion becomes one `error`. Adapters never
invent counts (ACP has no retry event).

## Render pipeline

`chatTranscriptRows.ts` turns envelopes into rows; later passes group them.

### 1. Render events

- **Work entries.** Tool, command, file-change and web-search events collapse
  into `ChatWorkLogEntry` by `collapseKey` (turn, `logicalItemId ?? itemId`,
  tool identity). `withLocalhostUrls` adds localhost chips.
- **Hidden rows** (`pending_input_resolved`, `activity`, raw tool events,
  `scheduled_work_update`, `transcript_retraction`) feed other derivations.
- A scheduled `user_message` gets a `scheduled_wake_divider` before it.
- Exact duplicate `error` rows collapse.

#### Subagent cards

- One row per agent (`agentId ?? taskId`): a running `subagent_spawn_anchor`
  turns **in place** into a `subagent_result_card` (same key and position, also
  after the parent's `done`). A settled card is never reopened.
- A result without its spawn in the window appends a card; loading the older
  page moves it to the spawn slot. Keys: `subagent-spawn:<agentKey>`, or
  `subagent-result:<agentKey>` for an appended card.
- `deriveSubagentCardName`: spawn `description`, then `label`, then
  `agentType`; paths and snake_case humanized; placeholders skipped (fallback
  `Subagent`). The title comes from `subagent_started` only.
- Layout: one frame (`SUBAGENT_CARD_CHROME`) for running and settled; status
  line names the agent's own model/effort; reports are plain text
  (`subagentSummaryPlainText`), three lines max. A click opens the child chat or
  the agent transcript in Chat Info (only where `ade:chat:open-info` is heard).
- **Grids:** consecutive cards join a `subagent_card_grid`
  (`groupSubagentCardGrids`), up to three per row, keyed by the first member;
  full rows never rebalance.
- **Stopped-group fold:** more than three contiguous stopped cards with one
  cause and nothing to say fold into one group
  (`groupStoppedSubagentResultCards`).

#### Background jobs

Backgrounded shells collapse to one `background_job_line` keyed
`background-chip:<agentKey>`; consecutive lines join a `background_job_group`
(`groupBackgroundJobRuns`), split where the turn fold would. A task that proves
to be a real subagent loses its job line before its card lands.
`BackgroundJobRunRow` draws `$ <command> · <duration> · <status>` with Stop and
`open ›`.

#### Scheduled work and wake loops

One entry per schedule id (`foldScheduledWorkRows`). At turn end schedules move
onto the turn-end line as chips (`moveScheduledWorkToTurnEnds`). Wake turns
(`deriveWakeTurns`) have no "Worked for" row; consecutive wake turns fold behind
`+N more checks`.

#### DAEX cards

`ade_card` collapses per `cardId` into one row keyed `ade-card:<cardId>`;
repeats merge in place; failed refreshes keep rows as `stale`. Never activity.
Contract: `shared/adeCard.ts` (iOS mirrors); unknown variants render
`fallbackText` and `navTarget`. No red tone.

#### Turn details, warnings and receipts

`turn_diagnostics` and recovery receipts merge into one `turn_details` row per
turn (`turn-details:<turnId>`). Warning notices draw as one amber line.
Receipt notices draw as muted lines; neighbours share a line with `+N`
(`foldQuietNoticeLines`).

### 2. Grouped envelopes

Adjacent work-log events of one turn merge into `work_log_group`; a following
`tool_use_summary` is absorbed.

### 3. Activity phase collapse

A noisy run of reasoning and work groups in one turn merges into one `Thought`
row and one work group (`shared/chatActivityPhase.ts`; iOS
`collapseActivityPhaseTimelineEntries`).

### 4. Client presentation

- Live turn: the working status names the running tool; its dropdown lists the
  turn's tools (`deriveTranscriptToolActivity`). The open turn ends at `done` or
  a user message that starts a new turn (`userMessageStartsTurn`).
- Finished turn: one `N tools · M files` row (`ChatTurnWorkSummary`) above the
  time line; `work_log_group` rows leave the timeline. iOS puts counts on
  `WorkTurnEndMarkerView`.
- One-line previews strip inline Markdown in pairs only
  (`stripInlineMarkdown`), so `snake_case` survives.

#### Computer-use action rows (desktop, hosted web, iOS)

`daex screen|mac-desktop|app-control|browser|apple|proof` commands (also via
`"$ADE_CLI_PATH"`, any provider) draw as sentences ("Clicked “Checkout” on
localhost:5173"). Summary: `shared/computerUseActionSummary.ts` and
`computerUseActionOutput.ts` (null when unsure → plain shell row). Words:
`computerUseActionPresentation.ts`; rows: `chatComputerUseRows.ts`; drawing:
`ChatComputerUseActions.tsx`. Same-turn image views of printed screenshots join
the action line (`foldImageViewIntoAction`). A proof call counts as filed only
when its output names the record. iOS: `WorkComputerUse*.swift`.

### 5. Turn fold (desktop, hosted web, iOS)

After `done`, rows between the user message and the answer fold into
`Worked for 4m 12s · 18 tools · 3 files · 2 subagents`. Pure rules in
`shared/chatTurnFold.ts`; iOS `workTurnFoldPlan`. Storage and canonical text
are unchanged.

- Live turns never fold. No fold without an answer or when only trivial rows
  would hide.
- **The answer:** the last `text`, or last `final_answer`; `commentary` never;
  `partial_answer` is a candidate that never beats `final_answer`. Unlabelled
  (Claude): an earlier long text can be the answer with a short postscript.
- A `done` whose turn id no window row carries is a subagent's
  (`isForeignTurnEnd`). Interrupted `status` + `done` merge
  (`resolveTerminusParent`).
- Narration folds; substance stays (`proseStaysVisible`: proof, images, ≥ 400
  code units, markdown structure).
- Stays visible: subagent cards/grids/groups, `ade_card`, errors, sign-in and
  limit notices, interrupt receipts, model switches, generated images, unknown
  types; jobs, approvals, questions, task lists and schedules only if live at
  turn end.
- Liveness is a snapshot at the first `done` (`recordTurnEndSnapshot`), so live
  collapse and reload agree.
- Jumps (deep links, ⌘K, minimap) resolve on unfolded rows and open the fold.
  An interrupted turn reads `Stopped after <duration>`.

### Order of the presentation passes

`presentedRows`: `groupChatTranscriptRows` (with the stopped-group fold) →
presentation filter → `mergeAdjacentActivityBundleRows` →
`groupSubagentCardGrids` → `groupBackgroundJobRuns` → turn fold →
`mergeAdjacentThoughtRows`.

## Text merging

`shouldMergeTextRows()`: same `messageId` merges unless both carry different
`phase`s; otherwise `turnId` + `itemId`. Claude `messageId` is the provider
message id (a reader that missed `message_start` uses the first delta's `uuid`).

**`phase`** (`commentary`, `partial_answer`, `final_answer`) comes only from
Codex `agentMessage` items; absent means unknown. It labels text only (storage
unchanged) and survives compaction, sync and imports.

## Reasoning merging

Adjacent reasoning of one turn merges into one Thought row without repeating
re-sent fragments (`mergeReasoningFragment`, `mergeReasoningTextFragments`; `---`
between distinct blocks is a display join). `mergeAdjacentThoughtRows`
(`chatThoughtRuns.ts`) merges thought runs across rows that draw nothing.

### Live thinking preview

`ThinkingPreview.tsx`: one live reasoning row (`deriveLiveThinkingRowKey`) shows
a spinner, `<assistant> is thinking · 12s` and up to four lines of the newest
text; afterwards it collapses to `Thought` (`for Ns` when measured ≥ 1 s). Only
the last ~4,000 characters stay mounted. Reduced motion drops the animation.

## Turn diff summaries

A turn on a lane that moved HEAD emits `turn_diff_summary`; `TurnDiffSummary`
fetches file diffs lazily (`ade.agentChat.getTurnFileDiff`) and offers a
SHA-scoped revert. Other turns fall back to `ChatTurnFilesChangedSummary` (see
[composer-and-ui.md](composer-and-ui.md#file-changes-panel)).

## Claude tool-use tracking

Invocations are tracked by `toolUseID`: `tool_use_summary` completes earlier
ids; `AskUserQuestion` becomes a `PendingInputRequest` answered as a
`tool_result`; `resolvedToolUseIds` swallows double resolution.

## Text batching

`chatTextBatching.ts` holds text up to 100 ms. **Flush at once on every non-text
event** (`shouldFlushBufferedAssistantTextForEvent`). Transcript reads flush
first. With `ADE_PERF_RUN_ID` set, flushes are recorded
(`services/perf/chatTextProbe.ts`). The renderer paints each flush when it
arrives (paced reveal is off by default; see
[composer-and-ui.md](composer-and-ui.md#paced-text-reveal)).

## Virtual scrolling and message-list layout

`AgentChatMessageList.tsx` has its own virtualizer: `measuredHeights` per row
key, `estimateTranscriptRowHeight` for unmeasured rows, spacers, end-aligned
box while following the bottom, `reconcileMeasuredScrollTop` on height changes.
Below `VIRTUALIZATION_THRESHOLD` rows everything renders. Content width:
`--chat-content-width` (`chatAppearance.ts`).

### Row keys

From identity, never position (`allocateTranscriptEventRowKey`):
`<sessionId>:<type>:m:<messageId>[:<phase>]`, `…:i:<turnId>:<itemId>`, else
`…@<timestamp>`, with `#n` for repeats. Derived keys wrap a row key; grids and
job groups reuse their first member's. So prepends, trims and merges keep every
surviving key (heights, scroll memory, folds, anchors).

### Anchoring the reader

The list owns anchoring (`overflow-anchor: none`): row-list changes keep the
first on-screen row in place while scrolled up; leaving a chat saves the first
visible row and offset; older history loads near the top (local chats
background-fill after 1.5 s; remote chats only on demand).

### Run on shell code blocks

`ChatCodeBlockRun.tsx` (rules in `shellCodeBlockRun.ts`): settled replies'
shell blocks offer Run. Confirm calls `pty.create` **on the chat's pin**, owned
by the chat (`chatSessionId`), with `SHELL_BLOCK_RUN_ENV`. Windows lanes run
PowerShell blocks only; others bash-like only. Disabled with a reason for
personal chats, archived lanes, offline machines, hidden control characters or
over-long scripts. "Send output to the agent" sends command, exit code and the
last 20,000 characters on the chat's pin. Hosted web uses
`work.runShellBlock`.

## History snapshots, scroll-back, and misses

The pane hydrates from `ade.agentChat.getEventHistory` and pages with
`getEventHistoryPage` (`{ sessionId, beforeOffset?, maxBytes? }` — always one
object).

- **Resume:** snapshots carry `tailEndOffset` and `historyGeneration`; a
  reopened chat passes them back and gets only newer events when the generation
  matches.
- **`hasOlderHistory`** comes from the tail read, never envelope identity.
- **`tailStartOffset`** tiers: exact line offset; identity lost but window
  complete → tail `startOffset`; degraded → `endOffset` gated on
  `hasOlderHistory` (pages repeat, client dedupes; keep this fallback).
  `advanceOlderHistoryCursor` advances only on `hasMore` and a strictly smaller
  offset.

### A row too large to page

A row over the 2 MB page cap comes back as its own page, replaced by a
display-only `system_notice` (`status: "history_row_omitted"`, **no
`sequence`**, `omittedRow: { offset, bytes, eventType? }`). Rows up to 8 MB
(`SEQUENCE_PROBE_MAX_ROW_BYTES`) are parsed for size/kind/time. Sequence-cursor
reads (`chat.getChatEvents`) read past oversized, unsequenced and hidden rows. A
file that shrinks mid-read fails with retryable
`chat_history_changed_during_read`. Transcript reads report `truncated: true`
when an omitted row may have held a message.

### Paging and caches

- Pages: 256 KiB (512 KiB background fill). A selected view keeps ≤ 60,000
  events / 32 MiB. A page commits only while session, runtime, generation and
  cursor still match.
- "Load earlier" pages until the span holds a `user_message`
  (`readOlderHistoryBatch`, ≤ 8 pages / 400 events).
- History owns its range; live owns the rest (`shared/chatHistoryMerge.ts`).
  Desktop installs the live listener before the history read.
- View cache: 128 MB total, 32 MB per chat.
- A streamed event must cost that event, not the transcript: merges, display
  lists and the row builder extend incrementally and fall back to a full pass.
  `scripts/perf/service/chat-transcript.bench.mts` checks this.

### `unavailable` — "could not reach the runtime", not "no such session"

`sessionFound: false` is authoritative; `unavailable: true` means the runtime
was unreachable (remote hop down, asleep, project switch). Never clear a chat on
it. Preload returns it during a project switch for a remote runtime (see
[Remote runtime internals](../remote-runtime/internal-architecture.md#local-runtime-routing));
the web adapter when the host is unreachable. `resolveChatHistoryMissAction`:
`unavailable` → `sync-pending`; not found with rows → `keep-missing`; not found
and empty → `clear`.

## Persisted transcript

One file per chat: `.ade/transcripts/chat/<sessionId>.jsonl`. The session row
still names `.ade/transcripts/<sessionId>.chat.jsonl` (that column syncs);
`resolveChatTranscriptReadPath` maps it.

- **Compaction** (`shared/chatEventCompaction.ts`): large output, tool results,
  diffs, reasoning and inline images become a preview plus omitted-byte
  metadata. Storage (`compactChatEventForStorage`) and wire
  (`compactChatEventForWire`, which also drops `structured` and
  `toolResultMeta`) share the policy, so a live push equals a re-read.
  **Compaction must stay idempotent**: the wrapper is recognized by shape.
- Codex command deltas join per command (≤ 10/s or 64 KiB).
- `PersistedChatState` (version 2) restores provider-native state (Claude
  session id, Codex thread, OpenCode ids) so the next turn continues.

### Claude restart and Stop recovery

- Every parent turn ends with `status` + `done`. On runtime creation (and Stop
  on an idle runtime) DAEX closes orphaned subagent/background rows first, then
  adds only the missing member of the latest turn's pair. Idempotent.
- Codex delivers each `subAgentActivity` twice; only the first acts. Settled
  agents stay settled (`subagentSnapshotsFromEvents`, stale-run sweep, renderer).
- Control calls are bounded: `interrupt()` 2.5 s, `stopTask()` 2 s.
- Stop modes: `stop_and_clear` (default; `cancel_queued` or per-message cancel)
  clears queues and emits `queue_recovery` (8 s Undo via
  `restoreCancelledQueue`); `stop_only` keeps queues; `*_and_background` also
  stops tasks.
- **Codex staged messages:** a rejected steer goes to `thread/queue/add`;
  `cancelSteer` re-reads the server queue (`clientUserMessageId` = `steerId`).
  Failed deletes or unreadable queues keep the chip.
- **Codex turn ends:** every path runs `settleCodexPendingInputs` (plan
  approvals arrive after `turn/completed`).
