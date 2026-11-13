import type { WebSocket } from "ws";
import type {
  PairedRuntimeHelloOkPayload,
  SyncApplicationCompressionCodec,
  SyncChatSubscribePayload,
  SyncEnvelope,
  SyncHelloAuth,
  SyncHelloPayload,
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
import type { LaneShareGrantSnapshot, LaneShareGrantSource, LaneShareTicketRedemption } from "./laneShareGrantService";
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
  remotePort?: number | null;
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
  /** The terminal snapshot barrier of each subscribed session (`syncTerminalSnapshotBarrier.ts`). */
  pendingTerminalSnapshots: Map<string, unknown>;
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

/**
 * A guest's socket on its way to the project its lane is in. A brain serves
 * one project on its shared sync listener at a time, so a guest may land on
 * the wrong project's host, or on the brain's own ingress when no project is
 * served. That side lets go of the socket (no close, no listener left) and
 * the brain's router (`laneShareGuestRouter.ts`) gives it to the right
 * project's host, which takes it from where the first side stopped.
 *
 * Everything here was read by this brain from the socket and from the
 * account directory; nothing is a claim the guest made that the next host
 * trusts without checking. `redeemed` is set when the first host already
 * checked the DPoP proof and redeemed the one-use ticket: the next host then
 * runs the checks after the redeem (project, owner, grant, lane, rights).
 */
export type LaneShareGuestHandoff = {
  ws: WebSocket;
  remoteAddress: string | null;
  remotePort: number | null;
  transportOrigin: SyncTransportOrigin;
  /** The hello's request id: the answer (hello_ok or hello_error) carries it. */
  requestId: string | null;
  hello: SyncHelloPayload;
  auth: Extract<SyncHelloAuth, { kind: "guest" }>;
  redeemed: {
    dpopPublicKey: string;
    redemption: LaneShareTicketRedemption;
    snapshot: LaneShareGrantSnapshot;
    /** The owner account whose token redeemed the ticket: the next host refuses under another. */
    redeemerUserId: string;
  } | null;
  /** The project this socket leaves (never routed back to it), or null from the brain's ingress. */
  fromProjectId?: string | null;
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
    platform?: NodeJS.Platform;
    /** The project folder and the lanes' worktrees: where a guest's image and turn diff reads may look. */
    projectRoot?: string | null;
    laneService?: { getLaneBaseAndBranch(laneId: string): { worktreePath: string } } | null;
  };
  peers: ReadonlySet<LaneShareGuestPeer>;
  send(target: WebSocket | LaneShareGuestPeer, type: SyncEnvelope["type"], payload: unknown, requestId?: string | null): boolean;
  captureAccountAuthorization(): Promise<{ userId: string; generation: number } | null>;
  /**
   * Gives a guest's socket to the host of its lane's project, through the
   * brain's router. Resolves false when no project of this brain can take it.
   * Absent: this host refuses a guest of another project, as before.
   */
  routeLaneShareGuest?: (handoff: LaneShareGuestHandoff) => Promise<boolean>;
  /** Lets go of a peer whose socket moves to another host: no close, no listener of this host left on it. */
  releasePeerForHandoff(peer: LaneShareGuestPeer): void;
  isPeerLifecycleCurrent(peer: LaneShareGuestPeer, generation: number): boolean;
  clearPeerAuthTimeout(peer: LaneShareGuestPeer): void;
  discardChatEventCoalescer(peer: LaneShareGuestPeer, sessionId: string): void;
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

/** A handed-off guest whose ticket a host already redeemed. */
export type LaneShareRedeemedGuest = NonNullable<LaneShareGuestHandoff["redeemed"]>;

/** Guest hello refusals, shared by every host and the brain's ingress. */
export const LANE_SHARE_UNAVAILABLE = "This computer could not check its shared lanes right now. Try again in a moment.";
export const LANE_SHARE_NO_GRANT = "This lane is not shared with your ADE account, or the share has ended. Open it again from ADE.";
export const LANE_SHARE_PROJECT_NOT_OPEN = "The owner's computer can't open this lane's project right now. ADE tries again in a minute.";
