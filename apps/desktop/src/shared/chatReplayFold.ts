import type { AgentChatEventEnvelope } from "./types";

/**
 * Collapse superseded streaming rows at the replay boundary.
 *
 * A 30-second reply is persisted as hundreds of individual `text` delta rows,
 * and replay re-sends every one of them for the client to re-fold. On a real
 * 87.85 MiB thread from this machine, 68,081 `text` events averaged 798 bytes
 * each while carrying 10.1 bytes of text — a 1.27% payload. One measured event
 * spent 833 bytes to deliver the word " and". The rest is the identifier stack
 * (a ~130-char composite `messageId`, a ~160-char `provenance.messageId`
 * repeating it plus a UUID, then threadId/turnId/itemId/sessionId/timestamp/
 * sequence), re-sent in full per delta.
 *
 * ## Why this folds so little of the event union
 *
 * The obvious approach — fold every type with a `logicalItemId` — is wrong
 * here, because the clients do not agree on how to fold. Desktop's
 * `mergeStreamingText` (chatTranscriptRows.ts) is five lines: prefix check,
 * else concatenate. iOS's `mergeWorkStreamingText`
 * (WorkErrorAndMessageHelpers.swift) is ~50 lines of replay-shape detection,
 * trimmed prefix/suffix checks and an overlap scan. For deltas that overlap or
 * repeat, those two already produce different text TODAY. No single server-side
 * fold can be byte-identical to both, so folding those cases would silently
 * pick a winner and change what one client renders.
 *
 * So this folds exactly the case where every implementation provably agrees:
 * a run of deltas that are clean appends. When neither string is a prefix of
 * the other and they are not equal, desktop concatenates and iOS falls through
 * its heuristics to the same concatenation. Anything else stops the run and is
 * emitted unfolded.
 *
 * Types other than text/reasoning are deliberately NOT folded yet, for the same
 * reason rather than for lack of value:
 *   - `command` merges its `output` and `file_change` merges its `diff` through
 *     the same streaming merge (chatTranscriptRows.ts:959,984) — they are
 *     append-merges, not keep-last, so keeping the last event would drop output.
 *   - `plan` is a field-wise merge with fallbacks
 *     (`mergePlanTranscriptEvent`, chatTranscriptRows.ts:488): an event with
 *     empty `steps` preserves the previous steps, so keep-last loses them.
 * Each is foldable under its own provable-agreement predicate; that is follow-up
 * work, not a guess to make here.
 *
 * Every other event type passes through untouched — an unrecognized type is
 * never folded on a guess.
 */

/** Event types this module knows how to fold, and how. */
export const FOLDABLE_CHAT_EVENT_TYPES = {
  text: "clean-append",
  reasoning: "clean-append",
} as const;

export type FoldableChatEventType = keyof typeof FOLDABLE_CHAT_EVENT_TYPES;

export function isFoldableChatEventType(type: string): type is FoldableChatEventType {
  return Object.prototype.hasOwnProperty.call(FOLDABLE_CHAT_EVENT_TYPES, type);
}

/**
 * True when concatenation is what every client's merge produces for this pair.
 *
 * Mirrors the guards in desktop `mergeStreamingText` and iOS
 * `mergeWorkStreamingText`. Both special-case an empty side, equality, and a
 * prefix relationship in either direction; iOS additionally collapses repeated
 * or overlapping tails. Rejecting all of those leaves only disjoint appends,
 * where every implementation returns `existing + incoming`.
 */
export function isCleanTextAppend(existing: string, incoming: string): boolean {
  if (!existing.length || !incoming.length) return false;
  if (existing === incoming) return false;
  if (incoming.startsWith(existing) || existing.startsWith(incoming)) return false;
  const trimmedExisting = existing.trim();
  const trimmedIncoming = incoming.trim();
  if (trimmedIncoming.length > 0 && trimmedExisting.endsWith(trimmedIncoming)) return false;
  if (trimmedExisting.length > 0 && trimmedIncoming.startsWith(trimmedExisting)) return false;
  if (existing.endsWith(incoming)) return false;
  // A shared boundary substring is where iOS's overlap scan and desktop's plain
  // concatenation diverge, so any overlap between the tail of one and the head
  // of the other disqualifies the pair.
  return !hasBoundaryOverlap(existing, incoming);
}

/** Longest suffix of `existing` that is also a prefix of `incoming`, bounded. */
function hasBoundaryOverlap(existing: string, incoming: string): boolean {
  const max = Math.min(existing.length, incoming.length, 64);
  for (let length = max; length > 0; length -= 1) {
    if (existing.endsWith(incoming.slice(0, length))) return true;
  }
  return false;
}

function readText(event: Record<string, unknown>): string | null {
  return typeof event.text === "string" ? event.text : null;
}

/**
 * Grouping key. Must match what the clients treat as one message: iOS uses
 * `workAssistantMessageStableId` (messageId, else itemId) and desktop uses
 * `logicalItemId ?? itemId` inside a turn. Requiring all of them to agree keeps
 * a fold from spanning what either client would render as two messages.
 */
function foldGroupKey(envelope: AgentChatEventEnvelope): string | null {
  const event = envelope.event as unknown as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  const messageId = typeof event.messageId === "string" ? event.messageId.trim() : "";
  const itemId = typeof event.itemId === "string" ? event.itemId.trim() : "";
  const logicalItemId = typeof event.logicalItemId === "string" ? event.logicalItemId.trim() : "";
  const turnId = typeof event.turnId === "string" ? event.turnId.trim() : "";
  const stable = messageId || logicalItemId || itemId;
  // Without a stable id the clients merge on adjacency instead, which depends
  // on surrounding rows and is not reproducible from the event alone.
  if (!stable) return null;
  // NUL-separated: ids may legitimately contain spaces or colons, so a
  // printable separator could let two distinct groups collide on one key.
  // Written as an escape so this file stays reviewable text, not binary.
  return [type, turnId, stable, logicalItemId || itemId].join("\u0000");
}

export type FoldedChatReplay = {
  /** Events to put on the wire, in original render order. */
  events: AgentChatEventEnvelope[];
  /**
   * Every source envelope that went into `events`, including the ones folded
   * away. Delivery bookkeeping must mark all of these as sent, or the
   * transcript pump re-sends the collapsed deltas individually and the client
   * renders them twice.
   */
  sources: AgentChatEventEnvelope[];
  foldedAwayCount: number;
};

/**
 * Fold a replay snapshot. Order is preserved: a folded run is emitted at the
 * position of its FIRST event, because that is where both clients place the
 * message, and carries the LAST event's `sequence` and `timestamp` so a
 * consumer that watermarks on the snapshot cannot land inside a collapsed run.
 */
export function foldChatEventEnvelopesForReplay(
  envelopes: readonly AgentChatEventEnvelope[],
): FoldedChatReplay {
  const events: AgentChatEventEnvelope[] = [];
  let foldedAwayCount = 0;
  // Index of the open run per group key, into `events`.
  const openRunIndex = new Map<string, number>();
  const openRunText = new Map<string, string>();

  for (const envelope of envelopes) {
    const event = envelope?.event as unknown as Record<string, unknown> | undefined;
    // Real transcripts contain lines with no `event` at all (legacy writes and
    // splice-repaired tails). Replay must carry them through untouched rather
    // than fault on them.
    if (!event || typeof event !== "object") {
      events.push(envelope);
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (!isFoldableChatEventType(type)) {
      events.push(envelope);
      continue;
    }
    const incoming = readText(event);
    const key = foldGroupKey(envelope);
    if (incoming == null || key == null) {
      events.push(envelope);
      continue;
    }
    const openIndex = openRunIndex.get(key);
    if (openIndex == null) {
      openRunIndex.set(key, events.length);
      openRunText.set(key, incoming);
      events.push(envelope);
      continue;
    }
    const existing = openRunText.get(key) ?? "";
    if (!isCleanTextAppend(existing, incoming)) {
      // Not provably equivalent — close the run and let the client apply its
      // own merge to this event exactly as it does today.
      openRunIndex.set(key, events.length);
      openRunText.set(key, incoming);
      events.push(envelope);
      continue;
    }
    const merged = existing + incoming;
    const previous = events[openIndex]!;
    events[openIndex] = {
      ...previous,
      // The last delta's identity: a snapshot consumer that tracks progress on
      // sequence must not stop inside the run.
      sequence: envelope.sequence ?? previous.sequence,
      timestamp: envelope.timestamp ?? previous.timestamp,
      event: { ...(previous.event as object), text: merged } as AgentChatEventEnvelope["event"],
    };
    openRunText.set(key, merged);
    foldedAwayCount += 1;
  }

  return { events, sources: [...envelopes], foldedAwayCount };
}
