import type { AgentChatEventEnvelope } from "./chat";

export type SyncScalarBytes = {
  type: "bytes";
  base64: string;
};

export type SyncScalar = string | number | null | SyncScalarBytes;

export type CrsqlChangeRow = {
  table: string;
  pk: SyncScalar;
  cid: string;
  val: SyncScalar;
  col_version: number;
  db_version: number;
  site_id: string;
  cl: number;
  seq: number;
};

export type ApplyRemoteChangesResult = {
  appliedCount: number;
  dbVersion: number;
  touchedTables: string[];
  rebuiltFts: boolean;
};

export type SyncProtocolVersion = 1;

export type SyncCompressionCodec = "none" | "gzip";

export type SyncPayloadEncoding = "json" | "base64";

export type SyncPeerPlatform = "macOS" | "linux" | "windows" | "iOS" | "unknown";

export type SyncPeerDeviceType = "desktop" | "phone" | "vps" | "unknown";

export type SyncPeerMetadata = {
  deviceId: string;
  deviceName: string;
  platform: SyncPeerPlatform;
  deviceType: SyncPeerDeviceType;
  siteId: string;
  dbVersion: number;
};

export type SyncPeerConnectionState = SyncPeerMetadata & {
  connectedAt: string;
  lastSeenAt: string;
  lastAppliedAt: string | null;
  remoteAddress: string | null;
  remotePort: number | null;
  latencyMs: number | null;
  syncLag: number;
  // Legacy internal/wire flag. User-facing copy should say "host".
  isBrain: boolean;
  isAuthenticated: boolean;
};

// Legacy internal/wire role names kept for sync protocol compatibility.
export type SyncConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type SyncRole = "brain" | "viewer";

export type SyncMode = "standalone" | "brain" | "viewer";

export type SyncDeviceRecord = {
  deviceId: string;
  siteId: string;
  name: string;
  platform: SyncPeerPlatform;
  deviceType: SyncPeerDeviceType;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  lastHost: string | null;
  lastPort: number | null;
  tailscaleIp: string | null;
  ipAddresses: string[];
  metadata: Record<string, unknown>;
};

export type SyncClusterState = {
  clusterId: string;
  // Legacy storage field name for the current host machine.
  brainDeviceId: string;
  brainEpoch: number;
  updatedAt: string;
  updatedByDeviceId: string;
};

export type SyncDesktopConnectionDraft = {
  host: string;
  port: number;
  token: string;
  authKind?: "bootstrap" | "paired";
  pairedDeviceId?: string | null;
  lastRemoteDbVersion?: number;
};

export type SyncClientStatus = {
  state: SyncConnectionState;
  host: string | null;
  port: number | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  latencyMs: number | null;
  syncLag: number | null;
  lastRemoteDbVersion: number;
  // Legacy internal naming. This points to the current host device.
  brainDeviceId: string | null;
  // User-facing display field for the current host name.
  hostName: string | null;
  error: string | null;
  message: string | null;
  savedDraft: Omit<SyncDesktopConnectionDraft, "token"> | null;
};

export type SyncTransferBlockerKind =
  | "mission_run"
  | "chat_runtime"
  | "terminal_session"
  | "managed_process";

export type SyncTransferBlocker = {
  kind: SyncTransferBlockerKind;
  id: string;
  label: string;
  detail: string;
};

export type SyncTransferReadiness = {
  ready: boolean;
  blockers: SyncTransferBlocker[];
  survivableState: string[];
};

export type SyncDeviceRuntimeState = SyncDeviceRecord & {
  isLocal: boolean;
  // Legacy internal/wire flag. User-facing copy should say "host".
  isBrain: boolean;
  connectionState: "self" | "connected" | "disconnected";
  connectedAt: string | null;
  lastAppliedAt: string | null;
  remoteAddress: string | null;
  remotePort: number | null;
  latencyMs: number | null;
  syncLag: number | null;
};

export type SyncRoleSnapshot = {
  mode: SyncMode;
  role: SyncRole;
  localDevice: SyncDeviceRecord;
  // Legacy internal naming for the current host device.
  currentBrain: SyncDeviceRecord | null;
  clusterState: SyncClusterState | null;
  bootstrapToken: string | null;
  pairingPin: string | null;
  pairingPinConfigured: boolean;
  pairingConnectInfo: SyncPairingConnectInfo | null;
  connectedPeers: SyncPeerConnectionState[];
  client: SyncClientStatus;
  transferReadiness: SyncTransferReadiness;
  survivableStateText: string;
  blockingStateText: string;
};

export type SyncStatusEventPayload = {
  type: "sync-status";
  snapshot: SyncRoleSnapshot;
};

export type SyncFeatureFlags = {
  fileAccess: true;
  terminalStreaming: true;
  chatStreaming: {
    enabled: true;
  };
  bootstrapAuth: true;
  pairingAuth: {
    enabled: true;
    pinDigits: 6;
  };
  commandRouting: {
    mode: "allowlisted";
    supportedActions: string[];
    actions: SyncRemoteCommandDescriptor[];
  };
};

export type SyncHelloPayload = {
  peer: SyncPeerMetadata;
  token?: string;
  auth?: SyncHelloAuth;
};

export type SyncHelloAuth =
  | { kind: "bootstrap"; token: string }
  | { kind: "paired"; deviceId: string; secret: string };

export type SyncHelloOkPayload = {
  peer: SyncPeerMetadata;
  brain: SyncPeerMetadata;
  serverDbVersion: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  features: SyncFeatureFlags;
};

export type SyncHelloErrorPayload = {
  code: "auth_failed" | "invalid_hello";
  message: string;
};

export type SyncAddressCandidateKind = "lan" | "saved" | "tailscale" | "loopback";

export type SyncAddressCandidate = {
  host: string;
  kind: SyncAddressCandidateKind;
};

export type SyncPairingQrPayload = {
  version: 2;
  hostIdentity: {
    deviceId: string;
    siteId: string;
    name: string;
    platform: SyncPeerPlatform;
    deviceType: SyncPeerDeviceType;
  };
  port: number;
  addressCandidates: SyncAddressCandidate[];
};

export type SyncPairingConnectInfo = {
  hostIdentity: SyncPairingQrPayload["hostIdentity"];
  port: number;
  addressCandidates: SyncAddressCandidate[];
  qrPayload: SyncPairingQrPayload;
  qrPayloadText: string;
};

export type SyncPairingRequestPayload = {
  code: string;
  peer: SyncPeerMetadata;
};

export type SyncPairingResultPayload = {
  ok: boolean;
  deviceId?: string;
  secret?: string;
  error?: {
    code:
      | "invalid_pin"
      | "pin_not_set"
      | "pairing_failed";
    message: string;
  };
};

export type SyncChangesetBatchPayload = {
  reason: "catchup" | "broadcast" | "relay";
  fromDbVersion: number;
  toDbVersion: number;
  changes: CrsqlChangeRow[];
};

export type SyncHeartbeatPayload = {
  kind: "ping" | "pong";
  sentAt: string;
  dbVersion: number;
};

export type SyncFileBlob = {
  path: string;
  size: number;
  mimeType: string | null;
  encoding: "utf-8" | "base64";
  isBinary: boolean;
  content: string;
  languageId?: string | null;
};

export type SyncFileRequest =
  | { action: "listWorkspaces"; args?: { includeArchived?: boolean } }
  | { action: "listTree"; args: { workspaceId: string; parentPath?: string; depth?: number; includeIgnored?: boolean } }
  | { action: "readFile"; args: { workspaceId: string; path: string } }
  | { action: "writeText"; args: { workspaceId: string; path: string; text: string } }
  | { action: "createFile"; args: { workspaceId: string; path: string; content?: string } }
  | { action: "createDirectory"; args: { workspaceId: string; path: string } }
  | { action: "rename"; args: { workspaceId: string; oldPath: string; newPath: string } }
  | { action: "deletePath"; args: { workspaceId: string; path: string } }
  | { action: "quickOpen"; args: { workspaceId: string; query: string; limit?: number } }
  | { action: "searchText"; args: { workspaceId: string; query: string; limit?: number } }
  | { action: "readArtifact"; args: { artifactId?: string; uri?: string; path?: string } };

export type SyncFileResponsePayload = {
  ok: boolean;
  action: SyncFileRequest["action"];
  result?:
    | unknown
    | SyncFileBlob;
  error?: {
    code: string;
    message: string;
  };
};

export type SyncTerminalSubscribePayload = {
  sessionId: string;
  maxBytes?: number;
};

export type SyncTerminalUnsubscribePayload = {
  sessionId: string;
};

export type SyncTerminalSnapshotPayload = {
  sessionId: string;
  transcript: string;
  status: string | null;
  runtimeState: string | null;
  lastOutputPreview: string | null;
  capturedAt: string;
};

export type SyncTerminalDataPayload = {
  sessionId: string;
  ptyId: string;
  data: string;
  at: string;
};

export type SyncTerminalExitPayload = {
  sessionId: string;
  ptyId: string;
  exitCode: number | null;
  at: string;
};

export type SyncChatSubscribePayload = {
  sessionId: string;
  maxBytes?: number;
};

export type SyncChatSubscribeSnapshotPayload = {
  sessionId: string;
  capturedAt: string;
  truncated: boolean;
  events: AgentChatEventEnvelope[];
};

export type SyncChatUnsubscribePayload = {
  sessionId: string;
};

export type SyncChatEventPayload = AgentChatEventEnvelope;

export type SyncBrainStatusPayload = {
  brain: SyncPeerMetadata;
  connectedPeers: SyncPeerConnectionState[];
  metrics: {
    connectedPeerCount: number;
    runningSessionCount: number;
    dbVersion: number;
    uptimeMs: number;
    lastBroadcastAt: string | null;
  };
};

export type SyncRunQuickCommandArgs = {
  laneId: string;
  title: string;
  startupCommand?: string | null;
  cols?: number;
  rows?: number;
  toolType?: string | null;
  tracked?: boolean;
};

export type SyncRemoteCommandAction =
  | "lanes.list"
  | "lanes.presence.announce"
  | "lanes.presence.release"
  | "lanes.refreshSnapshots"
  | "lanes.getDetail"
  | "lanes.create"
  | "lanes.createChild"
  | "lanes.createFromUnstaged"
  | "lanes.importBranch"
  | "lanes.attach"
  | "lanes.adoptAttached"
  | "lanes.rename"
  | "lanes.reparent"
  | "lanes.updateAppearance"
  | "lanes.archive"
  | "lanes.unarchive"
  | "lanes.delete"
  | "lanes.getStackChain"
  | "lanes.getChildren"
  | "lanes.rebaseStart"
  | "lanes.rebasePush"
  | "lanes.rebaseRollback"
  | "lanes.rebaseAbort"
  | "lanes.listRebaseSuggestions"
  | "lanes.dismissRebaseSuggestion"
  | "lanes.deferRebaseSuggestion"
  | "lanes.listAutoRebaseStatuses"
  | "lanes.listTemplates"
  | "lanes.getDefaultTemplate"
  | "lanes.initEnv"
  | "lanes.getEnvStatus"
  | "lanes.applyTemplate"
  | "work.listSessions"
  | "work.updateSessionMeta"
  | "work.runQuickCommand"
  | "work.closeSession"
  | "processes.listDefinitions"
  | "processes.listRuntime"
  | "processes.start"
  | "processes.stop"
  | "processes.kill"
  | "chat.listSessions"
  | "chat.getSummary"
  | "chat.getTranscript"
  | "chat.create"
  | "chat.send"
  | "chat.interrupt"
  | "chat.steer"
  | "chat.cancelSteer"
  | "chat.editSteer"
  | "chat.approve"
  | "chat.respondToInput"
  | "chat.resume"
  | "chat.updateSession"
  | "chat.dispose"
  | "chat.models"
  | "git.getChanges"
  | "git.getFile"
  | "files.writeTextAtomic"
  | "git.stageFile"
  | "git.stageAll"
  | "git.unstageFile"
  | "git.unstageAll"
  | "git.discardFile"
  | "git.restoreStagedFile"
  | "git.commit"
  | "git.generateCommitMessage"
  | "git.listRecentCommits"
  | "git.listCommitFiles"
  | "git.getFileHistory"
  | "git.getCommitMessage"
  | "git.revertCommit"
  | "git.cherryPickCommit"
  | "git.stashPush"
  | "git.stashList"
  | "git.stashApply"
  | "git.stashPop"
  | "git.stashDrop"
  | "git.fetch"
  | "git.pull"
  | "git.getSyncStatus"
  | "git.sync"
  | "git.push"
  | "git.getConflictState"
  | "git.rebaseContinue"
  | "git.rebaseAbort"
  | "git.listBranches"
  | "git.checkoutBranch"
  | "conflicts.getLaneStatus"
  | "conflicts.listOverlaps"
  | "conflicts.getBatchAssessment"
  | "prs.list"
  | "prs.refresh"
  | "prs.getDetail"
  | "prs.getStatus"
  | "prs.getChecks"
  | "prs.getReviews"
  | "prs.getComments"
  | "prs.getFiles"
  | "prs.getGitHubSnapshot"
  | "prs.getReviewThreads"
  | "prs.getActionRuns"
  | "prs.getActivity"
  | "prs.getDeployments"
  | "prs.createFromLane"
  | "prs.linkToLane"
  | "prs.draftDescription"
  | "prs.land"
  | "prs.close"
  | "prs.reopen"
  | "prs.requestReviewers"
  | "prs.rerunChecks"
  | "prs.addComment"
  | "prs.updateTitle"
  | "prs.updateBody"
  | "prs.setLabels"
  | "prs.submitReview"
  | "prs.replyToReviewThread"
  | "prs.setReviewThreadResolved"
  | "prs.reactToComment"
  | "prs.aiReviewSummary"
  | "prs.listIntegrationWorkflows"
  | "prs.updateIntegrationProposal"
  | "prs.deleteIntegrationProposal"
  | "prs.dismissIntegrationCleanup"
  | "prs.cleanupIntegrationWorkflow"
  | "prs.createIntegrationLaneForProposal"
  | "prs.startIntegrationResolution"
  | "prs.recheckIntegrationStep"
  | "prs.landQueueNext"
  | "prs.pauseQueueAutomation"
  | "prs.resumeQueueAutomation"
  | "prs.cancelQueueAutomation"
  | "prs.reorderQueue"
  | "prs.issueInventory.sync"
  | "prs.issueInventory.get"
  | "prs.issueInventory.getNew"
  | "prs.issueInventory.markFixed"
  | "prs.issueInventory.markDismissed"
  | "prs.issueInventory.markEscalated"
  | "prs.issueInventory.getConvergence"
  | "prs.issueInventory.reset"
  | "prs.convergenceState.get"
  | "prs.convergenceState.save"
  | "prs.convergenceState.delete"
  | "prs.pipelineSettings.get"
  | "prs.pipelineSettings.save"
  | "prs.pipelineSettings.delete"
  | "prs.getMobileSnapshot";

export type SyncRemoteCommandPolicy = {
  viewerAllowed: boolean;
  requiresApproval?: boolean;
  localOnly?: boolean;
  queueable?: boolean;
};

export type SyncRemoteCommandDescriptor = {
  action: SyncRemoteCommandAction | (string & {});
  policy: SyncRemoteCommandPolicy;
};

export type SyncCommandPayload = {
  commandId: string;
  action: SyncRemoteCommandAction | (string & {});
  args: Record<string, unknown>;
};

export type SyncCommandAckPayload = {
  commandId: string;
  accepted: boolean;
  status: "accepted" | "rejected";
  message: string | null;
};

export type SyncCommandResultPayload = {
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

type SyncEnvelopeBase<TType extends string> = {
  version: SyncProtocolVersion;
  type: TType;
  requestId?: string | null;
};

type SyncEnvelopeWithPayload<TType extends string, TPayload> =
  | (SyncEnvelopeBase<TType> & {
      compression: "none";
      payloadEncoding: "json";
      payload: TPayload;
    })
  | (SyncEnvelopeBase<TType> & {
      compression: "gzip";
      payloadEncoding: "base64";
      payload: string;
      uncompressedBytes: number;
    });

export type SyncHelloEnvelope = SyncEnvelopeWithPayload<"hello", SyncHelloPayload>;
export type SyncHelloOkEnvelope = SyncEnvelopeWithPayload<"hello_ok", SyncHelloOkPayload>;
export type SyncHelloErrorEnvelope = SyncEnvelopeWithPayload<"hello_error", SyncHelloErrorPayload>;
export type SyncPairingRequestEnvelope = SyncEnvelopeWithPayload<"pairing_request", SyncPairingRequestPayload>;
export type SyncPairingResultEnvelope = SyncEnvelopeWithPayload<"pairing_result", SyncPairingResultPayload>;
export type SyncChangesetBatchEnvelope = SyncEnvelopeWithPayload<"changeset_batch", SyncChangesetBatchPayload>;
export type SyncHeartbeatEnvelope = SyncEnvelopeWithPayload<"heartbeat", SyncHeartbeatPayload>;
export type SyncFileRequestEnvelope = SyncEnvelopeWithPayload<"file_request", SyncFileRequest>;
export type SyncFileResponseEnvelope = SyncEnvelopeWithPayload<"file_response", SyncFileResponsePayload>;
export type SyncTerminalSubscribeEnvelope = SyncEnvelopeWithPayload<"terminal_subscribe", SyncTerminalSubscribePayload>;
export type SyncTerminalUnsubscribeEnvelope = SyncEnvelopeWithPayload<"terminal_unsubscribe", SyncTerminalUnsubscribePayload>;
export type SyncTerminalSnapshotEnvelope = SyncEnvelopeWithPayload<"terminal_snapshot", SyncTerminalSnapshotPayload>;
export type SyncTerminalDataEnvelope = SyncEnvelopeWithPayload<"terminal_data", SyncTerminalDataPayload>;
export type SyncTerminalExitEnvelope = SyncEnvelopeWithPayload<"terminal_exit", SyncTerminalExitPayload>;
export type SyncChatSubscribeEnvelope = SyncEnvelopeWithPayload<"chat_subscribe", SyncChatSubscribePayload | SyncChatSubscribeSnapshotPayload>;
export type SyncChatUnsubscribeEnvelope = SyncEnvelopeWithPayload<"chat_unsubscribe", SyncChatUnsubscribePayload>;
export type SyncChatEventEnvelope = SyncEnvelopeWithPayload<"chat_event", SyncChatEventPayload>;
export type SyncBrainStatusEnvelope = SyncEnvelopeWithPayload<"brain_status", SyncBrainStatusPayload>;
export type SyncCommandEnvelope = SyncEnvelopeWithPayload<"command", SyncCommandPayload>;
export type SyncCommandAckEnvelope = SyncEnvelopeWithPayload<"command_ack", SyncCommandAckPayload>;
export type SyncCommandResultEnvelope = SyncEnvelopeWithPayload<"command_result", SyncCommandResultPayload>;

export type SyncEnvelope =
  | SyncHelloEnvelope
  | SyncHelloOkEnvelope
  | SyncHelloErrorEnvelope
  | SyncPairingRequestEnvelope
  | SyncPairingResultEnvelope
  | SyncChangesetBatchEnvelope
  | SyncHeartbeatEnvelope
  | SyncFileRequestEnvelope
  | SyncFileResponseEnvelope
  | SyncTerminalSubscribeEnvelope
  | SyncTerminalUnsubscribeEnvelope
  | SyncTerminalSnapshotEnvelope
  | SyncTerminalDataEnvelope
  | SyncTerminalExitEnvelope
  | SyncChatSubscribeEnvelope
  | SyncChatUnsubscribeEnvelope
  | SyncChatEventEnvelope
  | SyncBrainStatusEnvelope
  | SyncCommandEnvelope
  | SyncCommandAckEnvelope
  | SyncCommandResultEnvelope;
