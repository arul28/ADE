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
 * Two rules keep that reconciliation exact:
 *
 * 1. Fragments carrying the same provider `messageId` are deltas of one
 *    assistant message and are concatenated verbatim. ADE has no block-level
 *    identity on the event, so it must not guess where a "paragraph" starts —
 *    guessing splits words mid-token (`"no new mod" + "ifier chain needed:"`).
 * 2. Only events that render as transcript content end an assistant run.
 *    Ephemeral chrome (activity hints, subagent progress, token usage) is
 *    invisible to every renderer, so letting it break a run made the canonical
 *    text disagree with what desktop, the TUI, and iOS actually draw.
 *
 * The list below is deliberately an allowlist of *content* types: an event type
 * added later defaults to "does not break the run", which at worst drops a
 * paragraph break. The inverse default corrupts words.
 */
const TRANSCRIPT_CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set<AgentChatEvent["type"]>([
  "approval_request",
  "codex_image_generation",
  "codex_image_view",
  "command",
  "completion_report",
  "conversation_reset",
  "error",
  "file_change",
  "plan",
  "reasoning",
  "structured_question",
  "system_notice",
  "tool_call",
  "tool_result",
  "web_search",
]);

/** True when an event renders as transcript content and therefore ends an assistant text run. */
export function isTranscriptContentEvent(type: AgentChatEvent["type"]): boolean {
  return TRANSCRIPT_CONTENT_EVENT_TYPES.has(type);
}

type TextEvent = Extract<AgentChatEvent, { type: "text" }>;

/**
 * Identity of the assistant text stream a fragment belongs to. A provider
 * `messageId` is exact; a turn id is the coarse fallback for runtimes that do
 * not carry message identity.
 */
function assistantStreamKey(event: TextEvent): string | null {
  const messageId = event.messageId?.trim();
  if (messageId) return `message:${messageId}`;
  const turnId = event.turnId?.trim();
  if (turnId) return `turn:${turnId}`;
  return null;
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
  /** Stream key of the most recent assistant text fragment, or null after a reset. */
  let lastAssistantStreamKey: string | null = null;
  /** Whether rendered content has appeared since that fragment. */
  let contentSinceLastAssistantText = false;

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
   * Join a resumed fragment onto its stream. Same-message fragments are always
   * a verbatim continuation; only a coarse turn-keyed stream interrupted by
   * rendered content gets a paragraph break, because there the two runs are
   * genuinely different assistant messages.
   */
  const appendFragment = (existing: string, incoming: string, contiguous: boolean): string => {
    if (contiguous) return `${existing}${incoming}`;
    if (!existing.trim().length) return incoming;
    if (!incoming.trim().length) return existing;
    if (existing.endsWith("\n") || incoming.startsWith("\n")) return `${existing}${incoming}`;
    return `${existing.trimEnd()}\n\n${incoming.trimStart()}`;
  };

  for (const entry of envelopes) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.event.type === "user_message") {
      flushAssistantDraft();
      lastAssistantStreamKey = null;
      contentSinceLastAssistantText = false;
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
      const streamKey = assistantStreamKey(entry.event);
      if (streamKey) {
        const existing = assistantDraftsByKey.get(streamKey);
        // A provider message id proves both fragments are the same message's
        // deltas, so they concatenate verbatim no matter what came between.
        const contiguous = existing != null
          && (streamKey.startsWith("message:")
            || (lastAssistantStreamKey === streamKey && !contentSinceLastAssistantText));
        // At a real boundary the paragraph break supersedes edge whitespace.
        if (isBlankFragment && !contiguous) continue;
        flushAssistantDraft();
        if (existing) {
          existing.text = appendFragment(existing.text, entry.event.text, contiguous);
          lastAssistantStreamKey = streamKey;
          contentSinceLastAssistantText = false;
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
        assistantDraftsByKey.set(streamKey, draft);
        entries.push(draft);
        lastAssistantStreamKey = streamKey;
        contentSinceLastAssistantText = false;
        continue;
      }
      if (assistantDraft && canAppendBufferedAssistantText(assistantDraft, entry.event)) {
        assistantDraft.text = `${assistantDraft.text}${entry.event.text}`;
        lastAssistantStreamKey = null;
        contentSinceLastAssistantText = false;
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
      lastAssistantStreamKey = null;
      contentSinceLastAssistantText = false;
      continue;
    }
    // Chrome the renderers never draw must not split an assistant message.
    if (!isTranscriptContentEvent(entry.event.type)) continue;
    flushAssistantDraft();
    contentSinceLastAssistantText = true;
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
