import type { WebSocket } from "ws";
import type {
  PairedRuntimeHelloOkPayload,
  SyncApplicationCompressionCodec,
  SyncChatSubscribePayload,
  SyncEnvelope,
  SyncPeerMetadata,
  SyncProjectCatalogPayload,
  SyncRelayAuthorizationLease,
  SyncRemoteCommandDescriptor,
} from "../../../../desktop/src/shared/types";
import type { LaneShareEvent } from "../../../../desktop/src/shared/types/laneShare";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import type { LaneShareRightsStore } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import type { LaneShareGuestRole } from "./laneShareGuestPolicy";
import type { LaneShareGrantSource } from "./laneShareGrantService";
import type { LaneShareMoveService } from "./laneShareMoveService";
import type { AdoptChallengeState } from "./adoptChannelHandshake";
import type { RelayAuthorizationLifecycle } from "./relayAuthorization";
import type { SyncTransportOrigin } from "./sharedSyncListener";
import type { SyncPairingRecord } from "./syncPairingStore";
import type { SyncRemoteCommandService } from "./syncRemoteCommandService";

/**
 * The types of the lane share guest host (`laneShareGuestHost.ts`) and its
 * gates (`laneShareGuestGates.ts`): the peer fields they use, and what the
 * sync host gives them.
 */

/** The fields of the sync host's peer that the guest host reads and writes. */
export type LaneShareGuestPeer = {
  ws: WebSocket;
  laneShareGuest: LaneShareGuestRole | null;
  authenticated: boolean;
  transportOrigin: SyncTransportOrigin;
  remoteAddress: string | null;
  metadata: SyncPeerMetadata | null;
  negotiatedCompression: SyncApplicationCompressionCodec | null;
  authKind: "bootstrap" | "paired" | "account" | "guest" | null;
  pairedDeviceId: string | null;
  pairingRecord: SyncPairingRecord | null;
  pendingPairingCommitDeviceId: string | null;
  pendingPairingCommitSecret: string | null;
  lastKnownServerDbVersion: number;
  relayAuthorization: RelayAuthorizationLifecycle | null;
  adoptChallenge: AdoptChallengeState | null;
  helloAcceptedAtMs: number;
  subscribedSessionIds: Set<string>;
  subscribedChatSessionIds: Set<string>;
  hydratingChatSessionIds: Set<string>;
  chatSubscriptionBindings: Map<string, unknown>;
  chatTranscriptOffsets: Map<string, number>;
  chatTranscriptScanOffsets: Map<string, number>;
  chatEventIdsSent: Map<string, Set<string>>;
  resolvedChatTranscriptPaths: Map<string, string>;
  projectChatTranscriptPaths: Map<string, string>;
};

export type ChatScopeRequest = Pick<SyncChatSubscribePayload, "chatScope" | "projectId" | "projectRootPath">;

/** Who started the turn that runs in a chat, when a guest did (`trackLaneShareTurns`). */
export type LaneShareTurnOwner = { userId: string; turnId: string | null };

/** What the sync host gives both the guest host and its gates. */
export type LaneShareGuestSyncHostDeps = {
  sendRequired(
    peer: LaneShareGuestPeer,
    type: SyncEnvelope["type"],
    payload: unknown,
    requestId?: string | null,
    context?: { action?: string | null },
  ): boolean;
  remoteCommandService: Pick<SyncRemoteCommandService, "getDescriptor" | "getDescriptors" | "getSupportedActions" | "execute">;
  readBrainMetadata(): SyncPeerMetadata;
  /** Read on each use: the host replaces the set. */
  getLocalActiveLaneIds(): ReadonlySet<string>;
  hostProjectIdAliases: readonly (string | null | undefined)[];
  projectIdMatchesHost(
    receivedProjectId: string | null | undefined,
    hostProjectId: string | null | undefined,
    hostProjectIdAliases?: readonly (string | null | undefined)[],
  ): boolean;
  safeObjectValue(value: unknown): Record<string, unknown> | null;
  requestedProjectChatScope(payload: ChatScopeRequest | null): "project" | "foreign-project";
  normalizeTerminalInputId(value: unknown): string | null;
};

/** What `closeLaneShareGrant` did: the owner's revoke reports it. */
export type LaneShareCloseResult = {
  closedConnections: number;
  removedQueuedMessages: number;
  runningTurnSessionIds: string[];
};

export type LaneShareGuestHostDeps = LaneShareGuestSyncHostDeps & {
  /** The sync host's own arguments that the guest host reads. */
  args: {
    db: Pick<AdeDb, "sync">;
    logger: Logger;
    projectId?: string | null;
    sessionService: Pick<ReturnType<typeof createSessionService>, "get">;
    agentChatService?: ReturnType<typeof createAgentChatService>;
    laneShareGrants?: LaneShareGrantSource | null;
    laneShareRights?: LaneShareRightsStore | null;
    getLaneShareRepoKey?: () => string | null;
    laneShareMoves?: LaneShareMoveService | null;
    onLaneShareEvent?: (event: LaneShareEvent) => void;
  };
  peers: ReadonlySet<LaneShareGuestPeer>;
  send(target: WebSocket | LaneShareGuestPeer, type: SyncEnvelope["type"], payload: unknown, requestId?: string | null): boolean;
  captureAccountAuthorization(): Promise<{ userId: string; generation: number } | null>;
  isPeerLifecycleCurrent(peer: LaneShareGuestPeer, generation: number): boolean;
  clearPeerAuthTimeout(peer: LaneShareGuestPeer): void;
  discardChatEventCoalescer(peer: LaneShareGuestPeer, sessionId: string): void;
  clearTerminalSnapshotBarrier(peer: LaneShareGuestPeer, sessionId: string): void;
  isDisposed(): boolean;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  compressionThresholdBytes: number;
  buildSyncHostHelloOkPayload(input: {
    peer: SyncPeerMetadata;
    brain: SyncPeerMetadata;
    serverDbVersion: number;
    heartbeatIntervalMs: number;
    pollIntervalMs: number;
    compression?: SyncApplicationCompressionCodec | null;
    chunkedEnvelopes?: boolean;
    projectCatalog: SyncProjectCatalogPayload;
    projectCatalogEnabled: boolean;
    projectActionsEnabled: boolean;
    crossProjectChatEnabled: boolean;
    rosterEnabled?: boolean;
    remoteCommandSupportedActions: string[];
    remoteCommandDescriptors: SyncRemoteCommandDescriptor[];
    localCommandDescriptors: SyncRemoteCommandDescriptor[];
    compressionThresholdBytes?: number;
    relayAuthorization?: SyncRelayAuthorizationLease | null;
    connectionTransport?: "direct" | "relay";
    runtimeChannelEnabled?: boolean;
    omitProjectCatalog?: boolean;
    pipelinedHelloAccepted?: number | null;
  }): PairedRuntimeHelloOkPayload;
};
