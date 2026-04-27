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

`provenance` is populated for mission-scoped chat, where messages can
originate from orchestrator, worker, or user threads and must be routed
back to the correct mission feed.

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
  file_change }` is present. Used to gate mission-chat activity badges.
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
| `reasoning` | Chain-of-thought or assistant-internal reasoning; surfaces as a distinct transcript row with a collapsible header. |
| `tool_call` / `tool_result` | Paired per tool invocation; rendered inside work-log groups. `tool_result.status` can be `running`, `completed`, `failed`, or `interrupted`. |
| `file_change` | Emitted when the agent writes or deletes a file; carries `path`, `diff`, and `kind`. |
| `command` | A shell command invocation; carries `cwd`, `output`, `exitCode`, `durationMs`. |
| `plan` | Final plan payload (steps + explanation); replaces any earlier `plan_text` rows for that turn. |
| `plan_text` | Streaming plan fragments; merged via `shouldMergePlanTextRows()`. |
| `approval_request` | Legacy approval; newer code emits an embedded `PendingInputRequest` via `detail`. |
| `structured_question` | Claude V2 `AskUserQuestion` tool surface. |
| `pending_input_resolved` | Hidden row; consumed by pending-input derivation to clear UI state. |
| `status` | Turn-level lifecycle: `started`, `completed`, `interrupted`, `failed`. |
| `done` | Final turn marker with model, model id, usage, cost. Also clears non-question pending inputs when status is not `completed`. |
| `activity` | Ephemeral UI hint (thinking, searching, running_command). Hidden from the transcript. |
| `todo_update` | Task-list snapshot; consumed by `ChatTasksPanel`. |
| `subagent_started` / `subagent_progress` / `subagent_result` | Claude background subagent lifecycle. |
| `tool_use_start` / `tool_use_complete` / `tool_use_summary` | Claude V2 tool lifecycle tracking (see [Claude tool-use tracking](#claude-tool-use-tracking)). |
| `step_boundary` | Mission step boundary marker. |
| `system_notice` | Non-transcript chrome: auth errors, rate limits, memory notices, file persistence hints. |
| `completion_report` | Structured closeout produced by the `reportCompletion` workflow tool. |
| `turn_diff_summary` | Git-level before/after SHA + per-file stats for a completed turn. |
| `delegation_state` | Mission orchestrator delegation contract updates. |
| `context_compact` | Emitted before the provider compacts context (manual or auto). |
| `web_search` | Web-search tool lifecycle. |
| `auto_approval_review` | When auto-approval policy kicks in, this event carries the review text. |
| `prompt_suggestion` | Suggested follow-up prompts for the user. |

## Render pipeline

`apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts`
implements a two-layer transform:

1. **Render events.** Raw envelopes become `ChatTranscriptRenderEvent`
   values:
   - Tool, command, file-change, and web-search events collapse into
     `ChatWorkLogEntry` objects (status, label, tone, diff stats).
   - Text, reasoning, plan, status, pending input, and user-message
     events pass through as visible rows.
   - `pending_input_resolved`, `activity`, `step_boundary`, raw tool/
     command/file-change events, and standalone reasoning events are
     hidden (consumed by other derivations).

2. **Grouped envelopes.** Adjacent work-log render events in the same
   turn merge into `work_log_group` blocks. When a `tool_use_summary`
   event immediately follows a group from the same turn, its summary
   and tool-use IDs are absorbed into the group instead of rendering
   as a separate row. This keeps the transcript compact when the agent
   runs many tools in a single turn.

Each work-log entry carries a `collapseKey` built from `turnId`,
`logicalItemId` (preferred) or `itemId`, and tool/command identity.
Streaming updates for the same tool call merge into the existing entry
instead of appending a new row.

## Text merging

Adjacent `text` events merge via `shouldMergeTextRows()`:

- Events with matching `messageId` always merge.
- Events without `messageId` fall back to matching `turnId` and
  `itemId`.

This prevents duplicate rows when the provider streams fragmented text.

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

The Claude V2 runtime tracks individual tool invocations via the SDK's
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
`sessionRecovery.ts` implements version-2 reconstruction:

- Recent entries (bounded) are parsed back into envelopes.
- A continuity summary is injected into the new runtime context on
  resume.
- Provider-native runtime state (Claude session id, Codex app-server
  socket path, OpenCode runtime ids) is rehydrated so the next turn
  can use the same session instead of creating a new one.

Codex adapters deduplicate repeated lifecycle notifications before
converting them to envelope events, so a restart does not yield
duplicate rows.

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
</content>
</invoke>