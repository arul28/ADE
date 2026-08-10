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
 * here, because the two clients do not fold text the same way.
 *
 * Desktop merges a text delta inline (chatTranscriptRows.ts, the `text` branch
 * of the row reducer): it concatenates UNCONDITIONALLY, and only into
 * `rows[rows.length - 1]`, and only when that row is itself a text row passing
 * `shouldMergeTextRows`. iOS merges through `mergeWorkStreamingText`
 * (WorkErrorAndMessageHelpers.swift) — ~50 lines of replay-shape detection,
 * trimmed prefix/suffix checks and an overlap scan — and finds its target by
 * searching the message list for the item id, so it merges ACROSS intervening
 * events. Two consequences, and this module obeys both:
 *
 *  1. Only provably-clean appends fold. For deltas that overlap or repeat, iOS
 *     collapses and desktop concatenates, so they already render differently
 *     today; folding those would silently pick a winner.
 *  2. Only ADJACENT deltas fold. Desktop ends a text row at the first non-text
 *     event, so folding across a tool call would move that tool call after the
 *     whole message instead of leaving it between the two halves. Folding only
 *     adjacent runs is exactly what desktop produces and no more than iOS
 *     already does.
 *
 * Types other than text/reasoning are deliberately NOT folded yet, for the same
 * reason rather than for lack of value:
 *   - `command` merges its `output` and `file_change` merges its `diff` through
 *     `mergeStreamingText` (chatTranscriptRows.ts:634, called at :959 and :984
 *     — its ONLY two call sites; it is not on the text path). That function
 *     has two semantics: `incoming.startsWith(existing)` REPLACES, everything
 *     else CONCATENATES. A runtime emitting a growing diff or growing command
 *     output per event is exactly the cumulative shape that branch exists to
 *     collapse, so anyone extending the fold to those types must handle it —
 *     the fixtures in this module's test file are all text-shaped and would
 *     not catch a cumulative diff.
 *   - `plan` is a field-wise merge with fallbacks
 *     (`mergePlanTranscriptEvent`, chatTranscriptRows.ts:488): an event with
 *     empty `steps` preserves the previous steps, so keep-last loses them.
 * Each is foldable under its own provable-agreement predicate; that is follow-up
 * work, not a guess to make here.
 *
 * Every other event type passes through untouched — an unrecognized type is
 * never folded on a guess.
 *
 * ## Invariant: a folded run must never overlap a byte-paged range
 *
 * Event identity is content-derived — `agentChatEventIdentityKey`
 * (shared/chatHistoryMerge.ts) is `timestamp#type#JSON.stringify(event)` —
 * so a folded run and the individual deltas it replaces have completely
 * different identities and will NOT dedupe against each other. If a reader ever
 * received both, it would render the same text twice with no path to detect it.
 *
 * That is safe today only because the two spans are disjoint: the
 * `chat_subscribe` snapshot covers `[tailStartOffset, EOF)` and byte-paged
 * history covers strictly below `tailStartOffset`. This module is therefore
 * called from exactly one place — the snapshot path in `syncHostService` — and
 * must stay that way. Never fold anything below `tailStartOffset`, and never
 * let a folded snapshot overlap a byte-paged range. (Contract agreed with the
 * lane that owns page-cut placement and renderer paging.)
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
 * Desktop concatenates text deltas unconditionally, so for text this predicate
 * is stricter than desktop needs — it simply folds less. It exists for iOS,
 * whose `mergeWorkStreamingText` special-cases an empty side, equality, a
 * prefix relationship in either direction, and repeated or overlapping tails.
 * Rejecting all of those leaves only disjoint appends, where both clients
 * return `existing + incoming`.
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
  // At most ONE run is open, and only while the deltas are adjacent in the
  // stream. Desktop merges a text delta into `rows[rows.length - 1]` and only
  // when that row is itself a text row, so a tool call landing between two
  // deltas of one message ends the run there and starts a second row. Folding
  // across the gap would move the tool call after the whole message. iOS
  // merges by item id across gaps, so folding only adjacent runs is correct
  // for both: it is what desktop produces, and no more than iOS already does.
  let openRun: { index: number; key: string; text: string } | null = null;

  for (const envelope of envelopes) {
    const event = envelope?.event as unknown as Record<string, unknown> | undefined;
    // Real transcripts contain lines with no `event` at all (legacy writes and
    // splice-repaired tails). Replay must carry them through untouched rather
    // than fault on them.
    if (!event || typeof event !== "object") {
      openRun = null;
      events.push(envelope);
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (!isFoldableChatEventType(type)) {
      openRun = null;
      events.push(envelope);
      continue;
    }
    const incoming = readText(event);
    const key = foldGroupKey(envelope);
    if (incoming == null || key == null) {
      openRun = null;
      events.push(envelope);
      continue;
    }
    // A different message, or a merge the clients would not all agree on,
    // starts a fresh run instead of extending this one.
    if (
      openRun == null
      || openRun.key !== key
      || !isCleanTextAppend(openRun.text, incoming)
    ) {
      openRun = { index: events.length, key, text: incoming };
      events.push(envelope);
      continue;
    }
    const merged = openRun.text + incoming;
    const previous = events[openRun.index]!;
    events[openRun.index] = {
      ...previous,
      // The last delta's identity: a snapshot consumer that tracks progress on
      // sequence must not stop inside the run.
      sequence: envelope.sequence ?? previous.sequence,
      timestamp: envelope.timestamp ?? previous.timestamp,
      event: { ...(previous.event as object), text: merged } as AgentChatEventEnvelope["event"],
    };
    openRun.text = merged;
    foldedAwayCount += 1;
  }

  return { events, sources: [...envelopes], foldedAwayCount };
}
