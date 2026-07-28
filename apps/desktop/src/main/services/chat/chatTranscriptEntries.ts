import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatTranscriptEntry,
} from "../../../shared/types/chat";
import { canAppendBufferedAssistantText, type BufferedAssistantText } from "./chatTextBatching";

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
  return { key, identified: Boolean(messageId || itemId) };
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

  for (const entry of envelopes) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.event.type === "user_message") {
      flushAssistantDraft();
      openStreamKey = null;
      assistantDraftsByKey.clear();
      const text = entry.event.text.trim();
      if (!text.length) continue;
      const displayText = typeof entry.event.displayText === "string" && entry.event.displayText.trim().length > 0
        ? entry.event.displayText.trim()
        : undefined;
      const draft: TranscriptDraftEntry = {
        role: "user",
        text,
        ...(displayText ? { displayText } : {}),
        timestamp: entry.timestamp,
        turnId: entry.event.turnId,
        ...(entry.event.messageId ? { messageId: entry.event.messageId } : {}),
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
        };
        rememberDraftSource(draft, entry);
        assistantDraftsByKey.set(stream.key, draft);
        entries.push(draft);
        openStreamKey = stream.key;
        continue;
      }
      if (assistantDraft && canAppendBufferedAssistantText(assistantDraft, entry.event)) {
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
    };
    options?.onEntrySourceOffset?.(sourceOffsetByDraft.get(entry) ?? null);
    return [normalized];
  });
}
