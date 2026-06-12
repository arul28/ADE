// Shared identity logic for coalescing streamed assistant text deltas.
//
// Codex/Cursor/Droid/OpenCode stream an assistant message as many small `text`
// deltas, and — critically — multiple messages (a parent turn plus its
// subagents) stream CONCURRENTLY, so their deltas interleave in the event
// stream by timestamp. Two independent passes need to decide "do these two
// deltas belong to the same message?": the render-line coalescer
// (`coalesceLines` in format.ts) and the buffer-level delta coalescer
// (`flushPendingChatEvents` in app.tsx). They MUST share one predicate or they
// drift (and interleaved messages get concatenated into one scrambled blob).

import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";

/** Minimal shape both a `text` event and a rendered line expose for identity. */
export type AssistantTextIdentity = {
  messageId?: string;
  turnId?: string;
  itemId?: string;
};

/** Stable per-message identity, preferring the explicit messageId. */
export function textIdentity(value: AssistantTextIdentity): string | null {
  const messageId = value.messageId?.trim();
  return messageId?.length ? messageId : null;
}

export function turnAndItemMatch(a: AssistantTextIdentity, b: AssistantTextIdentity): boolean {
  const aTurnId = a.turnId ?? null;
  const bTurnId = b.turnId ?? null;
  if (!aTurnId || !bTurnId || aTurnId !== bTurnId) return false;
  const aItemId = a.itemId ?? null;
  const bItemId = b.itemId ?? null;
  return !aItemId || !bItemId || aItemId === bItemId;
}

/**
 * True when `next` continues the same assistant message as `previous` and the
 * two deltas may be concatenated. Prefers an explicit messageId match; falls
 * back to turn+item; and only merges identity-less deltas with other
 * identity-less deltas (legacy providers that emit no ids).
 */
export function shouldMergeAssistantText(previous: AssistantTextIdentity, next: AssistantTextIdentity): boolean {
  const previousIdentity = textIdentity(previous);
  const nextIdentity = textIdentity(next);

  if (previousIdentity || nextIdentity) {
    if (previousIdentity && nextIdentity) {
      return previousIdentity === nextIdentity;
    }
    return turnAndItemMatch(previous, next);
  }

  if (turnAndItemMatch(previous, next)) return true;

  return !previous.turnId && !next.turnId && !previous.itemId && !next.itemId;
}

/**
 * Overlap-aware append for streamed assistant text (desktop mergeStreamingText
 * parity, chatTranscriptRows.ts). Providers sometimes re-emit a cumulative
 * snapshot of the message-so-far (incoming starts with everything we already
 * hold), and history replay can overlap live buffered deltas (we already end
 * with exactly the incoming fragment). Plain concatenation duplicated the tail
 * in both cases — "…one giant pass. so I can split… one giant pass." Every
 * merge site (aggregate.ts, format.ts, coalesceTextDeltaEnvelopes) must use
 * this so the dedupe happens no matter which layer sees the overlap first.
 */
export function appendStreamingText(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (incoming.startsWith(existing)) return incoming;
  // Tail dedupe only fires for multi-word fragments: providers re-emit whole
  // phrases/sentences, while single-token deltas (" x", " the") legitimately
  // repeat back-to-back in normal streaming and must keep concatenating.
  if (/\S\s+\S/.test(incoming) && existing.endsWith(incoming)) return existing;
  return `${existing}${incoming}`;
}

/**
 * Codex persists each subagent's child content (text + tool calls) as messages
 * whose id is namespaced `codex-subagent:<...>`. Desktop tags these with
 * provenance.targetKind==="codex_subagent" and filters them out of the parent
 * transcript (they surface in the subagent pane instead). The TUI receives the
 * raw events with only the namespaced messageId, so we key off that prefix.
 */
export function isCodexSubagentMessageId(messageId: string | undefined): boolean {
  return typeof messageId === "string" && messageId.startsWith("codex-subagent:");
}

/**
 * Fuse consecutive `text` deltas that belong to the same streamed message into a
 * single envelope, so a turn's token stream lands in the transcript as a handful
 * of envelopes instead of thousands. The merged text is the overlap-aware
 * concatenation ({@link appendStreamingText} — no trim, no inserted separators;
 * deltas carry their own whitespace, and cumulative/tail re-emits dedupe),
 * and the fused envelope keeps the LATEST timestamp/sequence so the
 * timeline sort is unchanged. Non-text events and deltas from a different message
 * (or session) act as boundaries, so interleaved concurrent messages are never
 * merged together. Pure + order-preserving so both the per-session map and the
 * active-session buffer can apply it identically.
 */
export function coalesceTextDeltaEnvelopes(
  envelopes: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  const out: AgentChatEventEnvelope[] = [];
  for (const envelope of envelopes) {
    const last = out[out.length - 1];
    if (
      last
      && envelope.sessionId === last.sessionId
      && envelope.event.type === "text"
      && last.event.type === "text"
      && shouldMergeAssistantText(last.event, envelope.event)
    ) {
      const mergedText = appendStreamingText(last.event.text, envelope.event.text);
      out[out.length - 1] = {
        ...last,
        timestamp: envelope.timestamp,
        sequence: envelope.sequence ?? last.sequence,
        event: {
          ...last.event,
          text: mergedText,
          // Prefer the latest ids so a subsequent delta still matches identity.
          turnId: envelope.event.turnId ?? last.event.turnId,
          itemId: envelope.event.itemId ?? last.event.itemId,
          messageId: envelope.event.messageId ?? last.event.messageId,
        },
      };
      continue;
    }
    out.push(envelope);
  }
  return out;
}
