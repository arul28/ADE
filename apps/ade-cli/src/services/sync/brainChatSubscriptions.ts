import type { WebSocket } from "ws";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  PersonalChatScopeContract,
  SyncChatHistoryRequestPayload,
  SyncChatSubscribePayload,
  SyncChatSubscribeSnapshotPayload,
  SyncChatToolResultRequestPayload,
  SyncChatToolResultResponsePayload,
  SyncChatUnsubscribePayload,
  SyncEnvelope,
  SyncPeerMetadata,
} from "../../../../desktop/src/shared/types";
import { SYNC_MOBILE_CHAT_SLIM_CAPABILITY } from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { nowIso } from "../../../../desktop/src/main/services/shared/utils";
import {
  clampChatSnapshotMaxBytes,
  currentReadableTranscriptPath,
  readChatTranscriptEventsSince,
  readFileBackedChatSnapshot,
  readSubscribedTranscriptHistoryPage,
  readTranscriptLogicalSize,
  SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES,
  transcriptStorageKey,
} from "./syncChatTranscriptReads";
import {
  chatEventDeliveryKey,
  compactChatEventEnvelopeForMobileSync,
  compactChatEventEnvelopeForSync,
  prepareChatSnapshotEventsForPeer,
  readStoredToolResultResponse,
} from "./syncChatWire";
import { historyPageBeforeSequence } from "./syncRemoteCommandService";
import type { SyncForeignChatTranscriptResolver } from "./syncHostService";

/**
 * File-backed chat subscriptions for the brain's projectless ingress. No
 * project runtime runs here, so every chat is served from its transcript file:
 * a personal chat, or a registered project's chat (as a project host serves a
 * cross-project chat), with the same readers and response shapes.
 */

/** One file-backed chat subscription on one socket. */
export type BrainChatSubscription = {
  scope: "personal" | "foreign-project";
  /** Resolved at subscribe; may be `.jsonl` or `.jsonl.gz`. */
  transcriptPath: string;
  /** `transcriptStorageKey` of the resolved path, for scope matching. */
  storageKey: string;
  offset: number;
  scanOffset: number | null;
  sentKeys: Set<string>;
  /** The snapshot is being built; the pump must not tail yet. */
  hydrating: boolean;
};

/** What the subscriptions need from the handler's peer record. */
export type BrainChatPeer = {
  ws: WebSocket;
  metadata: SyncPeerMetadata | null;
  chatSubscriptions: Map<string, BrainChatSubscription>;
};

type ChatScopeRequest = {
  chatScope?: "project" | "personal";
  projectId?: string | null;
  projectRootPath?: string | null;
};

type SendEnvelope = (
  ws: WebSocket,
  type: SyncEnvelope["type"],
  payload: unknown,
  requestId?: string | null,
) => boolean;

const BRAIN_CHAT_SENT_KEYS_MAX = 800;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedCursor(value: unknown, minimum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= minimum
    ? value
    : null;
}

function unavailableChatHistoryPage(
  sessionId: string,
  beforeOffset: number,
): AgentChatEventHistoryPage {
  return {
    sessionId,
    events: [],
    startOffset: beforeOffset,
    hasMore: beforeOffset > 0,
    sessionFound: false,
    unavailable: true,
  };
}

/**
 * The scope a chat request asks for. No project is hosted here, so a chat
 * that names a project is always a cross-project one, and a request that names
 * neither a project nor the personal scope has no owner on this ingress.
 */
function requestedChatScope(payload: ChatScopeRequest | null | undefined): BrainChatSubscription["scope"] | null {
  if (payload?.chatScope === "personal") return "personal";
  return optionalString(payload?.projectId) || optionalString(payload?.projectRootPath)
    ? "foreign-project"
    : null;
}

function hasExplicitChatScope(payload: ChatScopeRequest | null | undefined): boolean {
  return payload?.chatScope === "project"
    || payload?.chatScope === "personal"
    || optionalString(payload?.projectId) != null
    || optionalString(payload?.projectRootPath) != null;
}

export function createBrainChatSubscriptions(args: {
  logger: Logger;
  personalChatScope?: PersonalChatScopeContract;
  foreignChatProvider?: SyncForeignChatTranscriptResolver;
  send: SendEnvelope;
  isPeerBackpressured: (ws: WebSocket) => boolean;
}) {
  const { send } = args;

  const peerWantsSlimChat = (peer: BrainChatPeer): boolean =>
    peer.metadata?.capabilities?.includes(SYNC_MOBILE_CHAT_SLIM_CAPABILITY) === true;

  const markChatEventSent = (subscription: BrainChatSubscription, event: AgentChatEventEnvelope): void => {
    subscription.sentKeys.add(chatEventDeliveryKey(event));
    if (subscription.sentKeys.size <= BRAIN_CHAT_SENT_KEYS_MAX) return;
    let overflow = subscription.sentKeys.size - BRAIN_CHAT_SENT_KEYS_MAX;
    for (const key of subscription.sentKeys) {
      if (overflow <= 0) break;
      subscription.sentKeys.delete(key);
      overflow -= 1;
    }
  };

  const resolveForeignTranscriptPath = (
    payload: ChatScopeRequest | null | undefined,
    sessionId: string,
  ): string | null => args.foreignChatProvider?.resolveTranscriptPath({
    projectId: optionalString(payload?.projectId),
    projectRootPath: optionalString(payload?.projectRootPath),
    sessionId,
  }) ?? null;

  /**
   * A history/tool-result/unsubscribe request must name the scope it
   * subscribed with. For a project chat the resolver is the identity: its
   * answer must be the same transcript, compared by storage key so the swap
   * between `.jsonl` and `.jsonl.gz` does not orphan the subscription.
   */
  const chatSubscriptionMatchesRequest = (
    subscription: BrainChatSubscription | undefined,
    payload: ChatScopeRequest | null | undefined,
    sessionId: string,
  ): subscription is BrainChatSubscription => {
    if (!subscription) return false;
    const scope = requestedChatScope(payload);
    if (scope !== subscription.scope) return false;
    if (scope === "personal") return true;
    const resolved = resolveForeignTranscriptPath(payload, sessionId);
    return resolved != null && transcriptStorageKey(resolved) === subscription.storageKey;
  };

  const subscribeToScope = async (
    peer: BrainChatPeer,
    requestId: string | null | undefined,
    payload: SyncChatSubscribePayload,
    sessionId: string,
    scope: BrainChatSubscription["scope"],
    isCurrent: () => boolean,
  ): Promise<void> => {
    const personalScope = args.personalChatScope;
    const prior = peer.chatSubscriptions.get(sessionId);
    const transcriptPath = scope === "personal"
      ? await personalScope?.transcriptPath(sessionId).catch(() => null) ?? null
      : resolveForeignTranscriptPath(payload, sessionId);
    if (!isCurrent()) return;
    // chatLogV2: a file-backed chat keeps no durable log state here (as for a
    // cross-project chat on a project host), so a `sinceSequence` resume is
    // always answered with an authoritative snapshot flagged `gap`.
    const sinceSequence = normalizedCursor(payload.sinceSequence, 0);
    const chatLogV2Requested = payload.chatLogV2 === true;
    const liveStatusFields = async (): Promise<{ turnActive?: boolean }> => {
      if (scope !== "personal" || !personalScope) return {};
      const turnActive = await personalScope.isTurnActive(sessionId).catch(() => false);
      return typeof turnActive === "boolean" ? { turnActive } : {};
    };
    if (!transcriptPath) {
      // Unknown project or session: an empty snapshot, never another scope's
      // history for the same session id, and no live subscription.
      peer.chatSubscriptions.delete(sessionId);
      const status = await liveStatusFields();
      if (!isCurrent()) return;
      send(peer.ws, "chat_subscribe", {
        sessionId,
        capturedAt: nowIso(),
        truncated: false,
        tailStartOffset: 0,
        hasOlderHistory: false,
        cursorKind: "byte",
        events: [],
        ...(sinceSequence != null ? { gap: true } : {}),
        ...status,
      } satisfies SyncChatSubscribeSnapshotPayload, requestId);
      return;
    }
    const subscription: BrainChatSubscription = {
      scope,
      transcriptPath,
      storageKey: transcriptStorageKey(transcriptPath),
      offset: 0,
      scanOffset: null,
      sentKeys: new Set(),
      hydrating: true,
    };
    peer.chatSubscriptions.set(sessionId, subscription);
    let hydrated = false;
    try {
      // The durable handoff boundary: the pump starts here once the snapshot
      // is out, and delivery keys drop the rows both of them carry.
      const hydrationStartOffset = await readTranscriptLogicalSize(transcriptPath);
      const tail = await readFileBackedChatSnapshot({
        transcriptPath,
        sessionId,
        maxBytes: clampChatSnapshotMaxBytes(payload.maxBytes),
        chatLogV2: chatLogV2Requested,
        logger: args.logger,
        logPrefix: "sync_brain",
      });
      if (!isCurrent() || peer.chatSubscriptions.get(sessionId) !== subscription) return;
      const prepared = prepareChatSnapshotEventsForPeer({
        events: tail.events,
        pinnedEvents: tail.pinnedEvents,
        capabilities: peer.metadata?.capabilities,
        sessionId,
        logger: args.logger,
      });
      const status = await liveStatusFields();
      if (!isCurrent() || peer.chatSubscriptions.get(sessionId) !== subscription) return;
      subscription.offset = hydrationStartOffset;
      subscription.scanOffset = null;
      send(peer.ws, "chat_subscribe", {
        sessionId,
        capturedAt: nowIso(),
        truncated: tail.truncated,
        tailStartOffset: tail.tailStartOffset,
        hasOlderHistory: tail.hasOlderHistory,
        cursorKind: "byte",
        events: prepared.events,
        ...(sinceSequence != null ? { gap: true } : {}),
        ...(chatLogV2Requested && prepared.pinnedEvents.length > 0 ? { pinnedEvents: prepared.pinnedEvents } : {}),
        ...status,
      } satisfies SyncChatSubscribeSnapshotPayload, requestId);
      for (const event of prepared.pinnedEvents) markChatEventSent(subscription, event);
      for (const event of prepared.sourceEvents) markChatEventSent(subscription, event);
      hydrated = true;
    } finally {
      subscription.hydrating = false;
      // A failed snapshot must not leave a half-built subscription behind; a
      // refresh of a live one keeps the prior one streaming.
      if (!hydrated && peer.chatSubscriptions.get(sessionId) === subscription) {
        if (prior) peer.chatSubscriptions.set(sessionId, prior);
        else peer.chatSubscriptions.delete(sessionId);
      }
    }
  };

  return {
    /** `chat_subscribe`: a snapshot now, then live rows from the pump. */
    async subscribe(
      peer: BrainChatPeer,
      requestId: string | null | undefined,
      payload: SyncChatSubscribePayload | null,
      isCurrent: () => boolean,
    ): Promise<void> {
      const sessionId = optionalString(payload?.sessionId);
      if (!sessionId || !payload) return;
      const scope = requestedChatScope(payload);
      // No project is hosted here, so an unscoped project chat has no owner;
      // a personal chat needs the personal scope wired.
      if (!scope || (scope === "personal" && !args.personalChatScope)) return;
      await subscribeToScope(peer, requestId, payload, sessionId, scope, isCurrent);
    },

    /** `chat_history`: one older page of a subscribed chat. */
    async history(
      peer: BrainChatPeer,
      requestId: string | null | undefined,
      payload: SyncChatHistoryRequestPayload | null,
      isCurrent: () => boolean,
    ): Promise<void> {
      const sessionId = optionalString(payload?.sessionId) ?? "";
      const beforeOffset = typeof payload?.beforeOffset === "number" && Number.isFinite(payload.beforeOffset)
        ? Math.max(0, Math.floor(payload.beforeOffset))
        : 0;
      // chatLogV2 sequence cursor; takes precedence over the byte cursor.
      const beforeSequence = historyPageBeforeSequence(payload?.beforeSequence);
      const subscription = sessionId ? peer.chatSubscriptions.get(sessionId) : undefined;
      if (!sessionId || !chatSubscriptionMatchesRequest(subscription, payload, sessionId)) {
        if (sessionId) {
          args.logger.warn("sync_brain.chat_history_unsubscribed_or_scope_mismatch", {
            sessionId,
            subscribedScope: subscription?.scope ?? null,
            requestedScope: requestedChatScope(payload),
          });
        }
        send(peer.ws, "chat_history", unavailableChatHistoryPage(sessionId, beforeOffset), requestId);
        return;
      }
      let page: AgentChatEventHistoryPage = unavailableChatHistoryPage(sessionId, beforeOffset);
      try {
        const read = await readSubscribedTranscriptHistoryPage({
          transcriptPath: subscription.transcriptPath,
          sessionId,
          beforeOffset,
          beforeSequence,
          maxBytes: payload?.maxBytes,
        });
        page = peerWantsSlimChat(peer)
          ? { ...read, events: read.events.map(compactChatEventEnvelopeForMobileSync) }
          : read;
      } catch (error) {
        args.logger.warn("sync_brain.chat_history_failed", {
          sessionId,
          beforeOffset,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!isCurrent()) return;
      send(peer.ws, "chat_history", page, requestId);
    },

    /** `chat_tool_result`: scoped exactly like `chat_history` (and like the project host). */
    async toolResult(
      peer: BrainChatPeer,
      requestId: string | null | undefined,
      payload: SyncChatToolResultRequestPayload | null,
      isCurrent: () => boolean,
    ): Promise<void> {
      const sessionId = optionalString(payload?.sessionId);
      const itemId = optionalString(payload?.itemId);
      const unavailable = (): SyncChatToolResultResponsePayload => ({
        sessionId: sessionId ?? "",
        itemId: itemId ?? "",
        found: false,
        unavailable: true,
      });
      const subscription = sessionId ? peer.chatSubscriptions.get(sessionId) : undefined;
      if (!sessionId || !itemId || !chatSubscriptionMatchesRequest(subscription, payload, sessionId)) {
        send(peer.ws, "chat_tool_result", unavailable(), requestId);
        return;
      }
      let response = unavailable();
      try {
        response = await readStoredToolResultResponse({
          transcriptPath: currentReadableTranscriptPath(subscription.transcriptPath),
          sessionId,
          itemId,
          resultSequence: typeof payload?.resultSequence === "number" && Number.isFinite(payload.resultSequence)
            ? payload.resultSequence
            : null,
          resultTimestamp: optionalString(payload?.resultTimestamp),
          sourceOffset: typeof payload?.sourceOffset === "number"
            && Number.isFinite(payload.sourceOffset)
            && payload.sourceOffset >= 0
            ? payload.sourceOffset
            : null,
        });
      } catch (error) {
        args.logger.warn("sync_brain.chat_tool_result_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!isCurrent()) return;
      send(peer.ws, "chat_tool_result", response, requestId);
    },

    /** `chat_unsubscribe`: an explicitly scoped request must match what it subscribed. */
    unsubscribe(peer: BrainChatPeer, payload: SyncChatUnsubscribePayload | null): void {
      const sessionId = optionalString(payload?.sessionId);
      if (
        sessionId
        && (
          !hasExplicitChatScope(payload)
          || chatSubscriptionMatchesRequest(peer.chatSubscriptions.get(sessionId), payload, sessionId)
        )
      ) {
        peer.chatSubscriptions.delete(sessionId);
      }
    },

    /** Tail every live subscription of one peer. */
    async pump(peer: BrainChatPeer, isCurrent: () => boolean): Promise<void> {
      for (const [sessionId, subscription] of peer.chatSubscriptions) {
        if (subscription.hydrating) continue;
        if (args.isPeerBackpressured(peer.ws)) return;
        const transcriptPath = currentReadableTranscriptPath(subscription.transcriptPath);
        // A compressed transcript is never appended to (a new turn reinflates
        // it first), and its raw bytes are not logical offsets.
        if (transcriptPath.endsWith(".gz")) continue;
        const next = await readChatTranscriptEventsSince(
          transcriptPath,
          subscription.offset,
          subscription.scanOffset,
        );
        if (!isCurrent()) return;
        if (peer.chatSubscriptions.get(sessionId) !== subscription || subscription.hydrating) continue;
        if (next.droppedOversizedRecordBytes != null) {
          args.logger.warn("sync_brain.chat_transcript_record_too_large", {
            peerDeviceId: peer.metadata?.deviceId ?? null,
            sessionId,
            recordBytes: next.droppedOversizedRecordBytes,
            maxRecordBytes: SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES,
          });
        }
        let allDelivered = true;
        for (const event of next.events) {
          if (subscription.sentKeys.has(chatEventDeliveryKey(event))) continue;
          const wire = peerWantsSlimChat(peer)
            ? compactChatEventEnvelopeForMobileSync(event)
            : compactChatEventEnvelopeForSync(event);
          if (!send(peer.ws, "chat_event", wire)) {
            allDelivered = false;
            break;
          }
          markChatEventSent(subscription, event);
        }
        // Keep the cursor on a failed send; delivery keys drop what already went.
        if (!allDelivered) continue;
        subscription.offset = next.nextOffset;
        subscription.scanOffset = next.nextScanOffset;
      }
    },
  };
}
