import type { AgentChatEvent } from "./types/chat";
import type { AgentChatEventEnvelope } from "./types";
import { compactChatEventForWire } from "./chatEventCompaction";

/**
 * What a phone receives for a chat, and nothing more.
 *
 * `chatEventCompaction` bounds heavy fields for EVERY consumer — the stored
 * transcript, desktop, hosted web, the TUI and the phone all share its caps,
 * because a payload the desktop keeps and the phone drops would render
 * differently on each. This module is the layer above that: the parts of a
 * chat that a phone should not carry at all, gated on a capability the phone
 * announces so an older build keeps today's wire byte for byte.
 *
 * Measured on a real 16.1 MB / 21,665-event thread from this machine
 * (`.ade/transcripts/chat/67757bac-…jsonl`), three families own 58% of it:
 *
 *   tool_result        23.1%   898 events
 *   subagent_progress  19.8% 7,775 events
 *   subagent.progress  15.2% 7,775 events   (a mirror of the line above)
 *   subagent_result    15.3%    93 events
 *
 * Each rule below targets one of those and keeps the outcome the user can see.
 *
 * ## 1. The `subagent.progress` mirror
 *
 * `buildCanonicalAgentChatRuntimeEvent` (main/services/chat/runtimeEvents.ts)
 * commits a dot-family twin next to every underscore subagent lifecycle event,
 * so the transcript carries both and both cross the wire. They are not two
 * facts: in the measured thread the pair is written 1 ms apart with identical
 * ids, and every client folds them into ONE row — desktop and the TUI through
 * `normalizeSubagentLifecycleEvent` (shared/chatSubagents.ts), iOS by decoding
 * `subagent.progress` into the same `.subagentProgress` case as
 * `subagent_progress` (RemoteModels.swift).
 *
 * So the mirror is dropped — but only when it IS a mirror. A transcript can
 * legitimately contain a dot-family event with no underscore twin (an older
 * build, or a runtime whose events arrive already canonical, where
 * `buildCanonicalAgentChatRuntimeEvent` returns null and nothing mints the
 * underscore form). Dropping the family outright would lose that subagent's
 * card entirely, so the rule is positional: a dot event is dropped only when
 * the underscore event it mirrors was itself just delivered for the same
 * agent. That is exactly the shape the emitter produces and nothing else.
 *
 * ## 2. Progress is state, not history
 *
 * A `subagent_progress` event is a snapshot of one agent's current summary,
 * token count and last tool. iOS says so explicitly — subagent progress
 * "enriches the folded snapshot but never creates a timeline row"
 * (WorkTimelineHelpers.swift). Nothing on the phone can show the thirty
 * superseded copies between two renders, so only the latest per agent is sent:
 * folded to one per agent in the subscribe snapshot, and coalesced to at most
 * one per second per agent live.
 *
 * `started` and `result`/`completed` are history and are never folded — they
 * are what the card's status and final summary are made of.
 *
 * ## 3. Tool results are fetched, not pushed
 *
 * The wire cap for every other client is 16 KB (`chatEventCompaction`), which
 * is far more than a phone renders before the user taps to expand. Capable
 * phones get `MOBILE_TOOL_RESULT_MAX_BYTES` — about one screen — plus the true
 * size, and fetch the stored result on demand through the `chat_tool_result`
 * request when the user expands the row.
 *
 * Nothing here changes what is persisted, what an agent does, or what any
 * non-phone client receives.
 */

/**
 * Roughly one screen of monospaced text on a phone. Large enough that the
 * common short result (an exit code, a path, a one-line answer) never needs a
 * fetch, small enough that a 16 KB grep dump does.
 */
export const MOBILE_TOOL_RESULT_MAX_BYTES = 2_048;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const sliceUtf8FromStart = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
};

const stringifyResult = (value: unknown): { text: string; measurable: boolean } => {
  if (typeof value === "string") return { text: value, measurable: true };
  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json === "string") return { text: json, measurable: true };
    return { text: String(value), measurable: false };
  } catch {
    // Same trap `chatEventCompaction` documents: `String(value)` on a circular
    // payload is 15 bytes, which would report an unbounded object as small.
    return { text: String(value), measurable: false };
  }
};

/**
 * The tool result as a capable phone should receive it: a head slice, the real
 * size, and a flag that tells the row it has more to fetch.
 *
 * The result is replaced by a plain string even when it was structured. Every
 * surface that shows an object-shaped result renders it as a JSON dump anyway,
 * and the phone must not mistake a truncated object for a complete one — a
 * half-serialized JSON body would decode as text on iOS but read as a real
 * value to anything that tried to parse it.
 */
export function compactToolResultForMobile(
  event: Extract<AgentChatEvent, { type: "tool_result" }>,
): Extract<AgentChatEvent, { type: "tool_result" }> {
  const serialized = stringifyResult(event.result);
  const totalBytes = serialized.measurable ? utf8Bytes(serialized.text) : 0;
  // An already-capped result whose original size is known keeps that number:
  // `resultOriginalBytes` is the size of what the agent produced, and the phone
  // shows it to the user. Overwriting it with the post-compaction size would
  // report a megabyte grep as 16 KB.
  const originalBytes = typeof event.resultOriginalBytes === "number" && event.resultOriginalBytes > 0
    ? event.resultOriginalBytes
    : totalBytes;
  if (serialized.measurable && totalBytes <= MOBILE_TOOL_RESULT_MAX_BYTES) {
    return event;
  }
  const preview = sliceUtf8FromStart(serialized.text, MOBILE_TOOL_RESULT_MAX_BYTES);
  return {
    ...event,
    result: preview,
    resultOriginalBytes: originalBytes,
    resultOmittedBytes: Math.max(0, originalBytes - utf8Bytes(preview)),
    // The row's "Show full result" affordance. Absent on every other wire, so
    // an older phone sees exactly the event it sees today.
    resultTruncatedForMobile: true,
  };
}

/** Storage/wire compaction first, then the phone-only rules. */
export function compactChatEventForMobileWire(event: AgentChatEvent): AgentChatEvent {
  const wire = compactChatEventForWire(event);
  if (wire.type !== "tool_result") return wire;
  return compactToolResultForMobile(wire);
}

// ---------------------------------------------------------------------------
// Subagent progress
// ---------------------------------------------------------------------------

export type SubagentProgressFamily = "underscore" | "dot";

export type SubagentProgressIdentity = {
  /** Which agent this progress is about. */
  agentKey: string;
  family: SubagentProgressFamily;
};

const trimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
};

type SubagentProgressEvent = Extract<
  AgentChatEvent,
  { type: "subagent_progress" | "subagent.progress" }
>;

type SubagentCompletionEvent = Extract<
  AgentChatEvent,
  { type: "subagent_result" | "subagent.completed" }
>;

function asSubagentProgressEvent(value: unknown): SubagentProgressEvent | null {
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  if (type !== "subagent_progress" && type !== "subagent.progress") return null;
  return value as SubagentProgressEvent;
}

function subagentCompletionAgentKey(event: SubagentCompletionEvent): string | null {
  return event.type === "subagent_result"
    ? trimmed(event.agentId) ?? trimmed(event.taskId)
    : trimmed(event.agentId);
}

/**
 * Identify a subagent PROGRESS event and the agent it belongs to.
 *
 * `started` and `result`/`completed` deliberately return null: they are the
 * events a card's existence and outcome are made of, and folding them would
 * lose a subagent, not a redraw.
 */
export function subagentProgressIdentity(event: unknown): SubagentProgressIdentity | null {
  const progress = asSubagentProgressEvent(event);
  if (!progress) return null;
  // `agentId` is the stable identity on both families; the underscore family
  // falls back to `taskId`, which is what it keys its own snapshot map on
  // (`subagentAgentKey` in agentChatService).
  const agentKey = trimmed(progress.agentId)
    ?? (progress.type === "subagent_progress" ? trimmed(progress.taskId) : null);
  if (!agentKey) return null;
  return { agentKey, family: progress.type === "subagent.progress" ? "dot" : "underscore" };
}

/**
 * True when `candidate` is the dot-family twin that
 * `commitChatEventWithCanonical` mints immediately after `previous`.
 *
 * Positional by design — see the module header. The pair is written back to
 * back for the same agent, so "the last progress delivered for this session was
 * the underscore original for this same agent" is the emitter's own shape.
 */
export function isMirroredSubagentProgress(
  previous: SubagentProgressIdentity | null,
  candidate: SubagentProgressIdentity,
): boolean {
  if (candidate.family !== "dot") return false;
  return previous?.family === "underscore" && previous.agentKey === candidate.agentKey;
}

/**
 * Collapse a subscribe snapshot's subagent progress to the latest event per
 * agent, in place.
 *
 * Order is preserved by emitting each surviving event at the position of the
 * LAST progress for that agent — the phone renders progress as card state, so
 * the newest value belongs where the newest event was, next to whatever
 * followed it.
 *
 * Snapshot-only, like `chatReplayFold`: the replay-buffer resume path keeps
 * every event because its per-event `seq` monotonicity is what the client's
 * `seq <= lastSeq` drop rule runs on, and it only covers a small recent gap.
 */
export function foldSubagentProgressForSnapshot(
  envelopes: readonly AgentChatEventEnvelope[],
): { events: AgentChatEventEnvelope[]; foldedAwayCount: number } {
  // Which index each agent's latest progress lives at, and whether an
  // underscore event was seen for it. A dot event never replaces an underscore
  // one: it carries strictly less (no description, no spawnDepth, no
  // toolUses/durationMs in usage), and the two are the same fact.
  const latestIndexByAgent = new Map<string, { index: number; family: SubagentProgressFamily }>();
  const drop = new Set<number>();
  envelopes.forEach((envelope, index) => {
    const identity = subagentProgressIdentity(envelope?.event);
    if (!identity) return;
    const previous = latestIndexByAgent.get(identity.agentKey);
    if (!previous) {
      latestIndexByAgent.set(identity.agentKey, { index, family: identity.family });
      return;
    }
    if (previous.family === "underscore" && identity.family === "dot") {
      drop.add(index);
      return;
    }
    drop.add(previous.index);
    latestIndexByAgent.set(identity.agentKey, { index, family: identity.family });
  });
  if (drop.size === 0) return { events: [...envelopes], foldedAwayCount: 0 };
  return {
    events: envelopes.filter((_, index) => !drop.has(index)),
    foldedAwayCount: drop.size,
  };
}

// ---------------------------------------------------------------------------
// Live coalescing
// ---------------------------------------------------------------------------

export const MOBILE_SUBAGENT_PROGRESS_INTERVAL_MS = 1_000;

/**
 * One outbound chat event, as the coalescer decides to send it.
 *
 * `seq` is omitted when the event is being delivered out of seq order — see
 * `flushAgent` for why that is the correct thing to do rather than a
 * workaround.
 */
export type CoalescedChatEvent = {
  event: AgentChatEventEnvelope;
  seq: number | null;
  /** The host replay sequence, retained so a failed send can be retried. */
  sourceSeq: number;
  /** Progress entries intentionally superseded by this terminal event. */
  superseded?: readonly AgentChatEventEnvelope[];
};

export type SubagentProgressCoalescer = {
  /**
   * Offer one outbound event. Returns what to actually send, in order.
   * Non-progress events always pass through untouched.
   */
  admit(event: AgentChatEventEnvelope, seq: number, nowMs: number): CoalescedChatEvent[];
  /** Emit any pending progress whose one-second window has closed. */
  flushDue(nowMs: number): CoalescedChatEvent[];
  /** Emit everything pending — unsubscribe, disconnect, end of turn. */
  flushAll(nowMs: number): CoalescedChatEvent[];
  /** Put progress back after the transport rejected an outbound event. */
  requeue(entries: readonly CoalescedChatEvent[]): void;
  /** Earliest ms at which `flushDue` could produce anything, or null. */
  nextDueAtMs(): number | null;
  readonly pendingCount: number;
};

export function createSubagentProgressCoalescer(options: {
  intervalMs?: number;
} = {}): SubagentProgressCoalescer {
  const intervalMs = Math.max(0, Math.floor(options.intervalMs ?? MOBILE_SUBAGENT_PROGRESS_INTERVAL_MS));
  const pending = new Map<string, {
    event: AgentChatEventEnvelope;
    seq: number;
    family: SubagentProgressFamily;
    superseded?: readonly AgentChatEventEnvelope[];
  }>();
  const pendingOutbound: CoalescedChatEvent[] = [];
  const lastSentAtMs = new Map<string, number>();
  const dueAtMs = new Map<string, number>();
  let lastEmittedSeq = 0;
  let lastProgressIdentity: SubagentProgressIdentity | null = null;

  const emit = (entry: { event: AgentChatEventEnvelope; seq: number }): CoalescedChatEvent => {
    if (entry.seq > lastEmittedSeq) {
      lastEmittedSeq = entry.seq;
      return { event: entry.event, seq: entry.seq, sourceSeq: entry.seq };
    }
    // The window closed after a newer event for a DIFFERENT agent already went
    // out, so this agent's latest state now carries a seq below the client's
    // watermark — and the client drops `seq <= lastSeq` on sight. Dropping it
    // here instead would leave that one card stale until the agent's next
    // progress, which for a quiet agent is its result.
    //
    // Sending it without a seq is the honest encoding of what it is: card
    // state, not a new point in the ordered stream. The client applies events
    // with no seq (its drop rule is `if let seq`), its resume watermark stays
    // on the newer event, and a reconnect that replays this one again is a
    // no-op because progress never creates a row.
    return { event: entry.event, seq: null, sourceSeq: entry.seq };
  };

  const flushAgent = (agentKey: string, nowMs: number): CoalescedChatEvent[] => {
    const entry = pending.get(agentKey);
    if (!entry) return [];
    pending.delete(agentKey);
    dueAtMs.delete(agentKey);
    lastSentAtMs.set(agentKey, nowMs);
    const emitted = emit(entry);
    return entry.superseded && entry.superseded.length > 0
      ? [{ ...emitted, superseded: entry.superseded }]
      : [emitted];
  };

  return {
    admit(event, seq, nowMs) {
      const queued = pendingOutbound.splice(0);
      const identity = subagentProgressIdentity(event?.event);
      if (!identity) {
        // A non-progress event does not flush pending progress. It cannot:
        // flushing here would emit the pending event with a LOWER seq right
        // before this one, and the ordered stream must not go backwards. The
        // pending entry keeps its own one-second window and is delivered by
        // `flushDue` (or seq-lessly, per `emit`) instead.
        //
        // The one case that does flush is a subagent ending: its result is the
        // last word on that card, so the progress behind it has no reader.
        const endingEvent = event.event as AgentChatEvent;
        const ending = endingEvent.type === "subagent_result" || endingEvent.type === "subagent.completed";
        const superseded: AgentChatEventEnvelope[] = [];
        if (ending) {
          const agentKey = subagentCompletionAgentKey(endingEvent as SubagentCompletionEvent);
          // Drop rather than emit: the result that follows in this same call
          // supersedes it, and emitting first would put a lower seq ahead of
          // a higher one for no visible gain.
          const pendingEntry = agentKey ? pending.get(agentKey) : undefined;
          if (pendingEntry) {
            superseded.push(...(pendingEntry.superseded ?? []), pendingEntry.event);
            pending.delete(agentKey!);
            dueAtMs.delete(agentKey!);
            lastSentAtMs.delete(agentKey!);
          }
          lastProgressIdentity = null;
        } else {
          lastProgressIdentity = null;
        }
        if (seq > lastEmittedSeq) lastEmittedSeq = seq;
        // A transcript pump can present the same source event again after its
        // live send was rejected. Keep the queued copy as the single retry;
        // otherwise a non-progress event would be sent twice.
        const alreadyQueued = queued.some((entry) =>
          entry.event.sessionId === event.sessionId && entry.sourceSeq === seq,
        );
        const outbound: CoalescedChatEvent = {
          event,
          seq,
          sourceSeq: seq,
          ...(superseded.length > 0 ? { superseded } : {}),
        };
        return alreadyQueued ? queued : [...queued, outbound];
      }

      if (isMirroredSubagentProgress(lastProgressIdentity, identity)) {
        // The underscore original was just delivered (or just coalesced) for
        // this agent. The twin carries nothing new.
        return queued;
      }
      lastProgressIdentity = identity;

      const existing = pending.get(identity.agentKey);
      if (existing && existing.family === "underscore" && identity.family === "dot") {
        // Same reason as the snapshot fold: never downgrade a pending
        // underscore event to its thinner twin.
        return queued;
      }
      const sameSource = existing?.seq === seq && existing.event.sessionId === event.sessionId;
      const superseded = existing
        ? [...(existing.superseded ?? []), ...(sameSource ? [] : [existing.event])]
        : undefined;
      pending.set(identity.agentKey, {
        event,
        seq,
        family: identity.family,
        ...(superseded && superseded.length > 0 ? { superseded } : {}),
      });

      const lastSent = lastSentAtMs.get(identity.agentKey);
      if (lastSent == null || nowMs - lastSent >= intervalMs) {
        return [...queued, ...flushAgent(identity.agentKey, nowMs)];
      }
      if (!dueAtMs.has(identity.agentKey)) {
        dueAtMs.set(identity.agentKey, lastSent + intervalMs);
      }
      return queued;
    },

    flushDue(nowMs) {
      const out = pendingOutbound.splice(0);
      for (const [agentKey, due] of [...dueAtMs]) {
        if (nowMs < due) continue;
        out.push(...flushAgent(agentKey, nowMs));
      }
      return out;
    },

    flushAll(nowMs) {
      const out = pendingOutbound.splice(0);
      for (const agentKey of [...pending.keys()]) {
        out.push(...flushAgent(agentKey, nowMs));
      }
      lastProgressIdentity = null;
      return out;
    },

    requeue(entries) {
      const retryOutbound: CoalescedChatEvent[] = [];
      for (const entry of entries) {
        const identity = subagentProgressIdentity(entry.event.event);
        if (!identity) {
          retryOutbound.push(entry);
          continue;
        }
        pending.set(identity.agentKey, {
          event: entry.event,
          seq: entry.sourceSeq,
          family: identity.family,
          ...(entry.superseded && entry.superseded.length > 0
            ? { superseded: entry.superseded }
            : {}),
        });
        dueAtMs.set(identity.agentKey, 0);
        lastSentAtMs.delete(identity.agentKey);
      }
      if (retryOutbound.length > 0) {
        pendingOutbound.unshift(...retryOutbound);
      }
    },

    nextDueAtMs() {
      if (pendingOutbound.length > 0) return 0;
      let earliest: number | null = null;
      for (const due of dueAtMs.values()) {
        if (earliest == null || due < earliest) earliest = due;
      }
      return earliest;
    },

    get pendingCount() {
      return pending.size + pendingOutbound.length;
    },
  };
}
