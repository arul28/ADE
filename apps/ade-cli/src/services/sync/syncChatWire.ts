import type {
  AgentChatEventEnvelope,
  SyncChatToolResultResponsePayload,
} from "../../../../desktop/src/shared/types";
import {
  SYNC_FOLDED_REPLAY_CAPABILITY,
  SYNC_MOBILE_CHAT_SLIM_CAPABILITY,
} from "../../../../desktop/src/shared/types";
import { compactChatEventForWire } from "../../../../desktop/src/shared/chatEventCompaction";
import { foldChatEventEnvelopesForReplay } from "../../../../desktop/src/shared/chatReplayFold";
import {
  compactChatEventForMobileWire,
  foldSubagentProgressForSnapshot,
} from "../../../../desktop/src/shared/chatMobileSlim";
import { findStoredToolResult } from "../../../../desktop/src/main/services/chat/chatToolResultLookup";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";

/**
 * Chat rows on the sync wire, shaped the same way by every ingress that serves
 * a chat: the project sync host and the brain's projectless fallback.
 */

/**
 * Envelope adapter for the wire. The policy lives in
 * `shared/chatEventCompaction` — see its header for why the wire and the stored
 * transcript have to share one. Every outbound path (live push, replay ring,
 * snapshot backfill) funnels through here.
 */
export function compactChatEventEnvelopeForSync(
  envelope: AgentChatEventEnvelope,
): AgentChatEventEnvelope {
  const event = compactChatEventForWire(envelope.event);
  return event === envelope.event ? envelope : { ...envelope, event };
}

/**
 * The same adapter for peers that announced `mobileChatSlimV1`. Everything the
 * shared wire policy does, plus the phone-only tool-result cap — see
 * `shared/chatMobileSlim`.
 */
export function compactChatEventEnvelopeForMobileSync(
  envelope: AgentChatEventEnvelope,
): AgentChatEventEnvelope {
  const event = compactChatEventForMobileWire(envelope.event);
  return event === envelope.event ? envelope : { ...envelope, event };
}

/**
 * Shape a `chat_subscribe` snapshot's rows for one peer, the same way on every
 * ingress: compact for the wire (slim for `mobileChatSlimV1` peers), fold
 * superseded subagent progress on the slim wire, and fold streaming deltas for
 * `foldedReplay` peers. `sourceEvents` is the pre-fold list; every one of them
 * must be marked delivered, or the transcript pump re-sends a collapsed row.
 */
export function prepareChatSnapshotEventsForPeer(args: {
  events: AgentChatEventEnvelope[];
  pinnedEvents: AgentChatEventEnvelope[];
  capabilities: readonly string[] | null | undefined;
  sessionId: string;
  logger: Pick<Logger, "debug">;
}): {
  events: AgentChatEventEnvelope[];
  pinnedEvents: AgentChatEventEnvelope[];
  sourceEvents: AgentChatEventEnvelope[];
} {
  const slimChatPeer = args.capabilities?.includes(SYNC_MOBILE_CHAT_SLIM_CAPABILITY) === true;
  const compactForPeer = slimChatPeer ? compactChatEventEnvelopeForMobileSync : compactChatEventEnvelopeForSync;
  let events = args.events.map(compactForPeer);
  const pinnedEvents = args.pinnedEvents.map(compactForPeer);
  // Fold streaming deltas into the message they belong to. Snapshot-only
  // and capability-gated: the replay-buffer resume path stays unfolded
  // because its per-event `seq` monotonicity is load-bearing for the client's
  // `seq <= lastSeq` drop rule, and it carries only a small recent gap.
  // `sourceEvents` keeps the pre-fold envelopes so delivery bookkeeping still
  // marks every collapsed delta as sent.
  const sourceEvents: AgentChatEventEnvelope[] = events;
  if (slimChatPeer) {
    // A snapshot is a byte-capped tail; on a subagent-heavy thread most of it
    // is superseded progress for agents whose card the phone will draw exactly
    // once. Keep the latest per agent — started and result are untouched, so
    // every card and every outcome still arrives.
    const progressFolded = foldSubagentProgressForSnapshot(events);
    if (progressFolded.foldedAwayCount > 0) {
      args.logger.debug("sync_host.chat_replay_subagent_progress_folded", {
        sessionId: args.sessionId,
        beforeCount: events.length,
        afterCount: progressFolded.events.length,
        foldedAwayCount: progressFolded.foldedAwayCount,
      });
    }
    events = progressFolded.events;
  }
  if (args.capabilities?.includes(SYNC_FOLDED_REPLAY_CAPABILITY)) {
    const folded = foldChatEventEnvelopesForReplay(events);
    if (folded.foldedAwayCount > 0) {
      args.logger.debug("sync_host.chat_replay_folded", {
        sessionId: args.sessionId,
        beforeCount: events.length,
        afterCount: folded.events.length,
        foldedAwayCount: folded.foldedAwayCount,
      });
    }
    // `sourceEvents` deliberately keeps the FULL pre-fold list rather than
    // `folded.sources`: on the slim wire the subagent progress fold has already
    // removed envelopes from `events`, and every one of them still needs its
    // delivery key marked. For every other peer the two are the same array.
    events = folded.events;
  }
  return { events, pinnedEvents, sourceEvents };
}

/**
 * Answer a `chat_tool_result` from the subscribed transcript: the stored event
 * with the shared storage caps already applied — never the raw provider
 * payload. The phone-only cap is the one thing this response deliberately does
 * not apply. `found: false` (not `unavailable`) when the row is gone, so the
 * phone shows "no longer available" instead of an error it could retry.
 */
export async function readStoredToolResultResponse(args: {
  transcriptPath: string;
  sessionId: string;
  itemId: string;
  resultSequence: number | null;
  resultTimestamp: string | null;
  sourceOffset: number | null;
  signal?: AbortSignal;
}): Promise<SyncChatToolResultResponsePayload> {
  const { sessionId, itemId } = args;
  const hit = await findStoredToolResult({
    transcriptPath: args.transcriptPath,
    sessionId,
    itemId,
    ...(args.resultSequence !== null ? { resultSequence: args.resultSequence } : {}),
    ...(args.resultTimestamp ? { resultTimestamp: args.resultTimestamp } : {}),
    ...(args.sourceOffset !== null ? { sourceOffset: args.sourceOffset } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!hit) return { sessionId, itemId, found: false };
  const stored = compactChatEventForWire(hit.event);
  return {
    sessionId,
    itemId,
    found: true,
    result: stored.type === "tool_result" ? stored.result : undefined,
    ...(stored.type === "tool_result" && typeof stored.resultOriginalBytes === "number"
      ? { resultOriginalBytes: stored.resultOriginalBytes }
      : {}),
    ...(stored.type === "tool_result" && typeof stored.resultOmittedBytes === "number"
      ? { resultOmittedBytes: stored.resultOmittedBytes }
      : {}),
    ...(stored.type === "tool_result" && stored.status ? { status: stored.status } : {}),
    ...(stored.type === "tool_result" && stored.tool ? { tool: stored.tool } : {}),
  };
}

export function chatEventDeliveryKey(event: AgentChatEventEnvelope): string {
  return `${event.sessionId}:${event.sequence ?? -1}:${event.timestamp}:${event.event.type}`;
}
