import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types";
import { readTranscriptHistoryPage } from "../../../../desktop/src/main/services/chat/chatTranscriptHistoryPager";
import { readHistoryFileSize } from "../../../../desktop/src/main/services/storage/historyCompression";
import { turnAlignedSnapshotStart } from "../../../../desktop/src/shared/chatSnapshotBoundary";
import { unresolvedApprovalRequestEnvelopes } from "../../../../desktop/src/shared/chatPendingInputRetention";

/**
 * Durable chat log reads for the `chatLogV2` sync protocol.
 *
 * Both readers work on the one transcript file a chat's history readers share
 * (see `agentChatService.resolveChatTranscriptPath`), walking it backwards in
 * bounded pages through the same pager `chat_history` uses, so byte cursors and
 * row boundaries agree with every other reader.
 */

/** Largest persisted byte span a `sinceSequence` resume replays. */
export const CHAT_SEQUENCE_RESUME_MAX_BYTES = 2_000_000;
const RESUME_PAGE_BYTES = 512 * 1024;

export type ChatSequenceResumeGapReason =
  | "unknown_sequence"
  | "ahead_of_log"
  | "resume_too_large"
  | "non_monotonic";

export type ChatSequenceResumeRead =
  | {
      status: "ok";
      /** Persisted events with `sequence > sinceSequence`, oldest first. */
      events: AgentChatEventEnvelope[];
      /** Highest persisted sequence seen (0 when the log is empty). */
      maxSequence: number;
    }
  | { status: "gap"; reason: ChatSequenceResumeGapReason };

function envelopeSequence(envelope: AgentChatEventEnvelope): number | null {
  const value = envelope.sequence;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** Nested Codex subagent rows never appear in parent history reads. */
function isParentVisible(envelope: AgentChatEventEnvelope): boolean {
  return envelope.provenance?.targetKind !== "codex_subagent";
}

async function readLogicalSizeOrZero(transcriptPath: string): Promise<number> {
  try {
    return await readHistoryFileSize(transcriptPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return 0;
    throw error;
  }
}

/**
 * Every persisted event after `sinceSequence`, or a gap.
 *
 * Walks back from EOF until it reaches a row whose sequence is at or below
 * `sinceSequence` (the client's last row) — proof that nothing between the
 * client's log and the returned events is missing. Answers `gap` when that
 * proof is not available within `maxBytes`, when the client claims a sequence
 * newer than anything persisted, or when the scanned rows are not strictly
 * increasing (legacy transcripts restarted numbering across host restarts, and
 * a resume across such a seam would be ambiguous). Unsequenced rows are live-
 * only by contract and never replayed.
 */
export async function readChatEventsAfterSequence(args: {
  transcriptPath: string;
  sessionId: string;
  sinceSequence: number;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<ChatSequenceResumeRead> {
  const sinceSequence = Math.max(0, Math.floor(args.sinceSequence));
  const maxBytes = Math.max(64 * 1024, Math.floor(args.maxBytes ?? CHAT_SEQUENCE_RESUME_MAX_BYTES));
  const size = await readLogicalSizeOrZero(args.transcriptPath);
  if (size <= 0) {
    return sinceSequence === 0
      ? { status: "ok", events: [], maxSequence: 0 }
      : { status: "gap", reason: "unknown_sequence" };
  }

  // Newest first while walking back; reversed once at the end.
  const collectedNewestFirst: AgentChatEventEnvelope[] = [];
  let maxSequence = 0;
  let olderSequence = Number.POSITIVE_INFINITY;
  let beforeOffset = size;
  let bytesScanned = 0;
  let anchored = false;

  while (!anchored) {
    args.signal?.throwIfAborted();
    const remaining = maxBytes - bytesScanned;
    if (remaining <= 0) return { status: "gap", reason: "resume_too_large" };
    const page = await readTranscriptHistoryPage({
      transcriptPath: args.transcriptPath,
      sessionId: args.sessionId,
      beforeOffset,
      maxBytes: Math.min(RESUME_PAGE_BYTES, remaining),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    bytesScanned += beforeOffset - page.startOffset;
    for (let index = page.envelopes.length - 1; index >= 0; index -= 1) {
      const envelope = page.envelopes[index]!;
      const sequence = envelopeSequence(envelope);
      if (sequence == null) continue;
      if (sequence >= olderSequence) return { status: "gap", reason: "non_monotonic" };
      olderSequence = sequence;
      if (maxSequence === 0) maxSequence = sequence;
      if (sequence <= sinceSequence) {
        anchored = true;
        break;
      }
      if (isParentVisible(envelope)) collectedNewestFirst.push(envelope);
    }
    if (anchored) break;
    if (page.startOffset <= 0 || !page.hasMore) {
      // Head of the log. A fresh client (0) takes everything; otherwise the log
      // must continue exactly where the client's stopped.
      const earliest = Number.isFinite(olderSequence) ? olderSequence : null;
      if (sinceSequence === 0 || earliest === sinceSequence + 1) {
        anchored = true;
        break;
      }
      return { status: "gap", reason: "unknown_sequence" };
    }
    if (bytesScanned >= maxBytes) return { status: "gap", reason: "resume_too_large" };
    beforeOffset = page.startOffset;
  }

  if (sinceSequence > maxSequence) return { status: "gap", reason: "ahead_of_log" };
  return { status: "ok", events: collectedNewestFirst.reverse(), maxSequence };
}

export type TurnAlignedTranscriptTail = {
  events: AgentChatEventEnvelope[];
  /** Unresolved approval requests read from before the window. */
  pinnedEvents: AgentChatEventEnvelope[];
  transcriptSize: number;
  tailStartOffset: number;
  truncated: boolean;
};

/**
 * File-backed `chatLogV2` snapshot for scopes without a live chat service
 * (personal chats and cross-project quick looks): the newest `maxBytes` of the
 * transcript with the cut moved back to the nearest turn boundary, reading at
 * most one extra budget to find it.
 */
export async function readTurnAlignedTranscriptTail(args: {
  transcriptPath: string;
  sessionId: string;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<TurnAlignedTranscriptTail> {
  const maxBytes = Math.max(1_024, Math.floor(args.maxBytes));
  const size = await readLogicalSizeOrZero(args.transcriptPath);
  if (size <= 0) {
    return { events: [], pinnedEvents: [], transcriptSize: 0, tailStartOffset: 0, truncated: false };
  }
  const readBudget = maxBytes * 2;
  const events: AgentChatEventEnvelope[] = [];
  const offsets: number[] = [];
  let beforeOffset = size;
  while (beforeOffset > 0 && size - beforeOffset < readBudget) {
    args.signal?.throwIfAborted();
    const page = await readTranscriptHistoryPage({
      transcriptPath: args.transcriptPath,
      sessionId: args.sessionId,
      beforeOffset,
      maxBytes: Math.min(2_000_000, readBudget - (size - beforeOffset)),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    const pageOffsets = page.envelopeStartOffsets.length === page.envelopes.length
      ? page.envelopeStartOffsets
      : page.envelopes.map(() => page.startOffset);
    events.unshift(...page.envelopes);
    offsets.unshift(...pageOffsets);
    if (page.startOffset >= beforeOffset) break;
    beforeOffset = page.startOffset;
  }
  const parentEvents: AgentChatEventEnvelope[] = [];
  const parentOffsets: number[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (!isParentVisible(events[index]!)) continue;
    parentEvents.push(events[index]!);
    parentOffsets.push(offsets[index]!);
  }
  const cutFloor = size - maxBytes;
  let naturalStart = parentEvents.length;
  while (naturalStart > 0 && parentOffsets[naturalStart - 1]! >= cutFloor) naturalStart -= 1;
  const start = turnAlignedSnapshotStart(
    parentEvents,
    naturalStart,
    maxBytes,
    (index) => (parentOffsets[index + 1] ?? size) - parentOffsets[index]!,
  );
  const windowEvents = parentEvents.slice(start);
  const tailStartOffset = start < parentEvents.length ? parentOffsets[start]! : size;
  const inWindow = new Set(windowEvents);
  const pinnedEvents = start > 0
    ? unresolvedApprovalRequestEnvelopes(parentEvents).filter((envelope) => !inWindow.has(envelope))
    : [];
  return {
    events: windowEvents,
    pinnedEvents,
    transcriptSize: size,
    tailStartOffset,
    truncated: tailStartOffset > 0,
  };
}
