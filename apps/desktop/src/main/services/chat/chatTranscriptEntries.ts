import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatTranscriptEntry,
  AgentChatTranscriptTurnFailure,
  ChatEventsResult,
  ChatLifecycleEvent,
} from "../../../shared/types/chat";
import { canonicalSteerRows } from "../../../shared/chatTranscript";
import { canCoalesceBufferedAssistantText, type BufferedAssistantText } from "./chatTextBatching";
import { redactOutgoingChatText } from "../../utils/redaction";

/**
 * Flatten a transcript envelope stream into role-tagged entries.
 *
 * Assistant text arrives as a stream of `text` fragments (provider deltas). The
 * canonical transcript must rebuild the exact string the renderers show, because
 * clients reconcile a live fragment stream against this canonical text: any
 * character ADE invents here shows up as corruption on the client that has both.
 *
 * See `docs/features/chat/transcript-and-turns.md` ("Canonical assistant text")
 * for the full rationale and the corruption each rule prevents.
 */

/**
 * Events that render as their own transcript row and therefore end an assistant
 * text run. Only consulted for fragments with no provider identity at all — see
 * `assistantStream` — so it is a coarse fallback, not the primary rule.
 *
 * Deliberately an allowlist: a type added later defaults to "does not break the
 * run", which at worst drops a paragraph break, whereas the inverse default
 * splices a separator into the middle of a word.
 *
 * @see shouldFlushBufferedAssistantTextForEvent in ./chatTextBatching — a
 * separate, denylist-shaped classification of "ends an assistant run" used for
 * live emission granularity. It intentionally defaults the other way (unknown
 * types flush) because a wrong guess there only costs batching latency.
 */
const TRANSCRIPT_CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set<AgentChatEvent["type"]>([
  "ade_card",
  "approval_request",
  "codex_image_generation",
  "codex_image_view",
  "codex_context_compaction",
  "codex_turn_recovery",
  "codex_turn_stalled",
  "command",
  "completion_report",
  "context_compact",
  "conversation_reset",
  "done",
  "error",
  "file_change",
  "plan",
  "reasoning",
  "scheduled_work_update",
  "status",
  "structured_question",
  "subagent_progress",
  "subagent_result",
  "subagent_started",
  "subagent.completed",
  "subagent.progress",
  "subagent.started",
  "system_notice",
  "model_handoff",
  "todo_update",
  "tool_call",
  "tool_result",
  "tool_use_summary",
  "turn_diagnostics",
  "turn_health",
  "turn_recovery",
  "web_search",
]);

/** True when an event renders as transcript content and therefore ends an assistant text run. */
export function isTranscriptContentEvent(type: AgentChatEvent["type"]): boolean {
  return TRANSCRIPT_CONTENT_EVENT_TYPES.has(type);
}

type TextEvent = Extract<AgentChatEvent, { type: "text" }>;

/**
 * Which assistant text stream a fragment belongs to.
 *
 * `key` groups fragments into one transcript entry and deliberately matches the
 * identity every renderer keys assistant text on — `messageId` when present,
 * else the turn. Desktop merges same-`messageId` rows with a bare
 * `${previous}${next}` (`shouldMergeTextRows` in `chatTranscriptRows.ts`, which
 * ignores `itemId` entirely) and iOS collapses a text event onto its
 * `messageId`. Canonical text must group and join the same way: the moment it
 * splits or separates where a renderer does not, a client holding both
 * renditions sees two texts that are not deltas of each other and concatenates
 * them — the duplicate-render bug this module exists to prevent.
 *
 * `identified` marks a fragment ADE can tie to a provider message, so its text
 * continues verbatim no matter what interleaves. Without it, boundaries have to
 * be inferred from interleaved rendered content.
 */
type AssistantStream = { key: string; identified: boolean };

function assistantStream(event: TextEvent): AssistantStream | null {
  const messageId = event.messageId?.trim() ?? "";
  const itemId = event.itemId?.trim() ?? "";
  const turnId = event.turnId?.trim() ?? "";
  // Mirror `workAssistantMessageStableId` on iOS exactly: messageId, else the
  // itemId a provider supplies in its place. Desktop agrees — `turnAndItemMatch`
  // refuses to merge rows whose item ids differ. Keying item-only streams on the
  // turn instead would run two separate messages together.
  const key = messageId ? `message:${messageId}`
    : itemId ? `item:${itemId}`
    : turnId ? `turn:${turnId}`
    : null;
  if (!key) return null;
  return { key: `${key}\u0000${event.phase ?? ""}`, identified: Boolean(messageId || itemId) };
}

export type TranscriptEntriesOptions = {
  sourceOffsetForEnvelope?: (envelope: AgentChatEventEnvelope) => number | null;
  onEntrySourceOffset?: (offset: number | null) => void;
};

export function transcriptEntriesFromEnvelopes(
  sessionId: string,
  envelopes: readonly AgentChatEventEnvelope[],
  options?: TranscriptEntriesOptions,
): AgentChatTranscriptEntry[] {
  /**
   * A steer's row is written once per lifecycle state (`queued` then
   * `delivered`, `accepted` then `inline`, ...). Every row is real history, but
   * they are one message: emitting each makes `ade chat read` (and every client
   * that merges this canonical text against the live event stream) show the
   * text more than once. A still-pending queued steer has no settled row and is
   * kept, because it is the only record of that message.
   */
  const steerRows = canonicalSteerRows(envelopes, { sessionId });
  type TranscriptDraftEntry = AgentChatTranscriptEntry & Partial<BufferedAssistantText>;
  const entries: TranscriptDraftEntry[] = [];
  const sourceOffsetByDraft = new WeakMap<TranscriptDraftEntry, number>();
  const assistantDraftsByKey = new Map<string, TranscriptDraftEntry>();
  let assistantDraft: (AgentChatTranscriptEntry & BufferedAssistantText) | null = null;
  /**
   * Coarse run key for fragments with no message identity, where rendered
   * content between fragments is the only available boundary signal.
   */
  let openStreamKey: string | null = null;

  const flushAssistantDraft = (): void => {
    if (!assistantDraft) return;
    const text = assistantDraft.text.trim();
    if (text.length > 0) {
      const flushed: TranscriptDraftEntry = {
        role: "assistant",
        text,
        timestamp: assistantDraft.timestamp,
        ...(assistantDraft.turnId ? { turnId: assistantDraft.turnId } : {}),
        ...(assistantDraft.messageId ? { messageId: assistantDraft.messageId } : {}),
        ...(assistantDraft.itemId ? { itemId: assistantDraft.itemId } : {}),
        ...(assistantDraft.phase ? { phase: assistantDraft.phase } : {}),
      };
      const sourceOffset = sourceOffsetByDraft.get(assistantDraft);
      if (sourceOffset != null) sourceOffsetByDraft.set(flushed, sourceOffset);
      entries.push(flushed);
    }
    assistantDraft = null;
  };

  const rememberDraftSource = (draft: TranscriptDraftEntry, envelope: AgentChatEventEnvelope): void => {
    const sourceOffset = options?.sourceOffsetForEnvelope?.(envelope);
    if (sourceOffset != null) sourceOffsetByDraft.set(draft, sourceOffset);
  };

  /**
   * Start a new paragraph on a stream ADE could not identify, where a resumed
   * run is genuinely a different assistant message.
   */
  const joinAsNewParagraph = (existing: string, incoming: string): string => {
    if (!existing.trim().length) return incoming;
    if (!incoming.trim().length) return existing;
    if (existing.endsWith("\n") || incoming.startsWith("\n")) return `${existing}${incoming}`;
    return `${existing.trimEnd()}\n\n${incoming.trimStart()}`;
  };

  for (let index = 0; index < envelopes.length; index += 1) {
    const entry = envelopes[index]!;
    if (entry.sessionId !== sessionId) continue;
    if (entry.event.type === "user_message") {
      const steerRow = steerRows.get(index);
      // Another row of this steer carries it. Skipped BEFORE the stream state
      // is reset: a row that is never emitted must not break the assistant run
      // it landed inside, or a mid-turn steer splits one message into two
      // entries with no user entry between them.
      if (steerRow === null) continue;
      flushAssistantDraft();
      openStreamKey = null;
      assistantDraftsByKey.clear();
      // Emitted at this row's place and time, with the content of the row the
      // steer settled on (its turn and message id).
      const { event, timestamp } = steerRow ?? { event: entry.event, timestamp: entry.timestamp };
      const text = event.text.trim();
      if (!text.length) continue;
      const displayText = typeof event.displayText === "string" && event.displayText.trim().length > 0
        ? event.displayText.trim()
        : undefined;
      const draft: TranscriptDraftEntry = {
        role: "user",
        text,
        ...(displayText ? { displayText } : {}),
        timestamp,
        turnId: event.turnId,
        ...(event.messageId ? { messageId: event.messageId } : {}),
      };
      rememberDraftSource(draft, entry);
      entries.push(draft);
      continue;
    }
    if (entry.event.type === "text") {
      // A delta can be pure whitespace — the gap between two words, or a
      // markdown hard break ("  \n"). Dropping it glues words together, so it
      // is discarded only when there is no run for it to continue.
      const isBlankFragment = !entry.event.text.trim().length;
      const stream = assistantStream(entry.event);
      if (stream) {
        const existing = assistantDraftsByKey.get(stream.key);
        // An unchanged id pair proves both fragments are one message's deltas,
        // so they concatenate verbatim no matter what came between. Without any
        // identity, fall back to "nothing rendered since the last fragment".
        const contiguous = existing != null
          && (stream.identified || openStreamKey === stream.key);
        // At a real boundary the paragraph break supersedes edge whitespace.
        if (isBlankFragment && !contiguous) continue;
        flushAssistantDraft();
        if (existing) {
          existing.text = contiguous
            ? `${existing.text}${entry.event.text}`
            : joinAsNewParagraph(existing.text, entry.event.text);
          openStreamKey = stream.key;
          continue;
        }
        const draft: TranscriptDraftEntry = {
          role: "assistant",
          text: entry.event.text,
          timestamp: entry.timestamp,
          ...(entry.event.messageId ? { messageId: entry.event.messageId } : {}),
          ...(entry.event.turnId ? { turnId: entry.event.turnId } : {}),
          ...(entry.event.itemId ? { itemId: entry.event.itemId } : {}),
          ...(entry.event.phase ? { phase: entry.event.phase } : {}),
        };
        rememberDraftSource(draft, entry);
        assistantDraftsByKey.set(stream.key, draft);
        entries.push(draft);
        openStreamKey = stream.key;
        continue;
      }
      if (assistantDraft && canCoalesceBufferedAssistantText(assistantDraft, entry.event)) {
        assistantDraft.text = `${assistantDraft.text}${entry.event.text}`;
        openStreamKey = null;
        continue;
      }
      if (isBlankFragment) continue;
      flushAssistantDraft();
      assistantDraft = {
        role: "assistant",
        text: entry.event.text,
        timestamp: entry.timestamp,
        ...(entry.event.messageId ? { messageId: entry.event.messageId } : {}),
        ...(entry.event.turnId ? { turnId: entry.event.turnId } : {}),
        ...(entry.event.itemId ? { itemId: entry.event.itemId } : {}),
        ...(entry.event.phase ? { phase: entry.event.phase } : {}),
      };
      rememberDraftSource(assistantDraft, entry);
      openStreamKey = null;
      continue;
    }
    // Chrome the renderers never draw must not split an assistant message.
    if (!isTranscriptContentEvent(entry.event.type)) continue;
    flushAssistantDraft();
    openStreamKey = null;
  }
  flushAssistantDraft();
  return entries.flatMap((entry) => {
    const text = entry.text.trim();
    if (!text.length) return [];
    const normalized: AgentChatTranscriptEntry = {
      role: entry.role,
      text,
      ...(entry.displayText ? { displayText: entry.displayText } : {}),
      timestamp: entry.timestamp,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      ...(entry.itemId ? { itemId: entry.itemId } : {}),
      ...(entry.phase ? { phase: entry.phase } : {}),
    };
    options?.onEntrySourceOffset?.(sourceOffsetByDraft.get(entry) ?? null);
    return [normalized];
  });
}

/**
 * Every turn in the stream that ended failed, oldest first, each with the error
 * that ended it.
 *
 * A turn is failed when its `done` or its `status` says so; one record per turn
 * however many of those it wrote. The message is the turn's last `error` event
 * (matched by turn id, or the latest unattributed error since the turn's last
 * prompt), falling back to the status's own message.
 */
export function transcriptTurnFailuresFromEnvelopes(
  sessionId: string,
  envelopes: readonly AgentChatEventEnvelope[],
): AgentChatTranscriptTurnFailure[] {
  const failures: AgentChatTranscriptTurnFailure[] = [];
  const failureByTurn = new Map<string, AgentChatTranscriptTurnFailure>();
  const errorByTurn = new Map<string, { message: string; detail?: string }>();
  let unattributedError: { message: string; detail?: string } | null = null;
  /** The failure already recorded since the last prompt: its turn's `status` and `done` are one failure even when only one names the turn. */
  let failureSincePrompt: AgentChatTranscriptTurnFailure | null = null;
  for (const envelope of envelopes) {
    if (envelope.sessionId !== sessionId) continue;
    const event = envelope.event;
    if (event.type === "user_message") {
      unattributedError = null;
      failureSincePrompt = null;
      continue;
    }
    if (event.type === "error") {
      const message = event.message?.trim();
      if (!message) continue;
      const detail = typeof event.detail === "string" && event.detail.trim() ? event.detail.trim() : undefined;
      const error = { message, ...(detail ? { detail } : {}) };
      const turnId = event.turnId?.trim();
      if (turnId) errorByTurn.set(turnId, error);
      else unattributedError = error;
      // A late error for a turn already reported failed names the real cause:
      // its message and detail together, never one error's message beside
      // another's detail.
      const reported = turnId ? failureByTurn.get(turnId) : null;
      if (reported) {
        reported.message = error.message;
        if (error.detail) reported.detail = error.detail;
        else delete reported.detail;
      }
      continue;
    }
    const failed = (event.type === "done" && event.status === "failed")
      || (event.type === "status" && event.turnStatus === "failed");
    if (!failed) continue;
    const turnId = event.turnId?.trim() || undefined;
    if (turnId && failureByTurn.has(turnId)) continue;
    if (failureSincePrompt && (!turnId || !failureSincePrompt.turnId)) {
      if (turnId) {
        failureSincePrompt.turnId = turnId;
        failureByTurn.set(turnId, failureSincePrompt);
      }
      continue;
    }
    const statusMessage = event.type === "status" ? event.message?.trim() : undefined;
    const error = (turnId ? errorByTurn.get(turnId) : undefined)
      ?? unattributedError
      ?? (statusMessage ? { message: statusMessage } : { message: "The turn failed." });
    const failure: AgentChatTranscriptTurnFailure = {
      ...(turnId ? { turnId } : {}),
      status: "failed",
      ...error,
      timestamp: envelope.timestamp,
    };
    if (turnId) failureByTurn.set(turnId, failure);
    failureSincePrompt = failure;
    failures.push(failure);
  }
  return failures;
}

const TURN_END_KIND = { completed: "turn_completed", failed: "turn_failed", interrupted: "turn_interrupted" } as const;

/** The turning points of a chat, oldest first; a turn's end appears once even when a runtime reports it twice. */
export function chatLifecycleEvents(envelopes: readonly AgentChatEventEnvelope[]): ChatLifecycleEvent[] {
  const events: ChatLifecycleEvent[] = [];
  const endedTurns = new Set<string>();
  const add = (entry: AgentChatEventEnvelope, kind: ChatLifecycleEvent["kind"], extra: { turnId?: string; message?: string } = {}) => {
    events.push({ sequence: entry.sequence ?? -1, at: entry.timestamp, kind, ...extra });
  };
  const addTurnEnd = (entry: AgentChatEventEnvelope, status: keyof typeof TURN_END_KIND, turnId: string | undefined) => {
    if (turnId && endedTurns.has(turnId)) return;
    if (turnId) endedTurns.add(turnId);
    add(entry, TURN_END_KIND[status], turnId ? { turnId } : {});
  };
  for (const entry of envelopes) {
    const event = entry.event;
    if (event.type === "status") {
      if (event.turnStatus === "started") add(entry, "turn_started", event.turnId ? { turnId: event.turnId } : {});
      else addTurnEnd(entry, event.turnStatus, event.turnId);
    } else if (event.type === "done") {
      addTurnEnd(entry, event.status, event.turnId);
    } else if (event.type === "approval_request") {
      add(entry, "input_needed", event.turnId ? { turnId: event.turnId } : {});
    } else if (event.type === "pending_input_resolved") {
      add(entry, "input_resolved", event.turnId ? { turnId: event.turnId } : {});
    } else if (event.type === "error") {
      add(entry, "error", { ...(event.turnId ? { turnId: event.turnId } : {}), message: redactOutgoingChatText(event.message).slice(0, 500) });
    }
  }
  return events;
}

/**
 * One `getChatEvents` answer from the envelopes read: oldest first after a
 * cursor, the newest `limit` without one. When it stops short, the next call
 * starts after the last event returned.
 */
export function chatEventsPage(
  envelopes: readonly AgentChatEventEnvelope[],
  since: number | null,
  limit: number,
  reachedSince: boolean,
): Pick<ChatEventsResult, "cursor" | "events" | "truncated" | "gap"> {
  const newer = since === null ? envelopes : envelopes.filter((entry) => (entry.sequence ?? -1) > since);
  // Read from everything on hand, then cut at the cursor: a turn's end reported
  // twice (its status, then its done) straddling the cursor is still one event.
  const events = chatLifecycleEvents(envelopes).filter((event) => since === null || event.sequence > since);
  const returned = since === null ? events.slice(-limit) : events.slice(0, limit);
  // Without a cursor the newest events come back and older ones are not "more to read".
  const truncated = since !== null && returned.length < events.length;
  const newest = newer.reduce((max, entry) => Math.max(max, entry.sequence ?? -1), since ?? -1);
  return {
    cursor: truncated && since !== null ? returned[returned.length - 1]!.sequence : newest,
    events: returned,
    truncated,
    ...(reachedSince ? {} : { gap: true as const }),
  };
}
