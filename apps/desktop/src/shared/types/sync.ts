import type { AgentChatEventEnvelope, AgentChatPermissionMode } from "./chat";
import type { PtySendToSessionResult, TerminalSessionSummary } from "./sessions";

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
  /**
   * Per-host-DB changeset cursors keyed by the host project DB's cr-sqlite
   * site id. A brain hosts one project DB at a time and each DB has its own
   * db_version sequence, so a single `dbVersion` is meaningless after the
   * hosted project changes — the host picks its own site's entry and falls
   * back to `dbVersion` for older clients.
   */
  dbVersionBySite?: Record<string, number>;
  capabilities?: string[];
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
  isHost?: boolean;
  isAuthenticated: boolean;
};

// Legacy internal/wire role names kept for sync protocol compatibility.
export type SyncConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type SyncRole = "brain" | "viewer";

export type SyncMode = "standalone" | "brain" | "viewer";

export type SyncRuntimeRole = "host" | "viewer";

export type SyncRuntimeMode = "standalone" | "host" | "viewer";

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
  hostDeviceId?: string;
  hostEpoch?: number;
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
  hostDeviceId?: string | null;
  // User-facing display field for the current host name.
  hostName: string | null;
  error: string | null;
  message: string | null;
  savedDraft: Omit<SyncDesktopConnectionDraft, "token"> | null;
};

export type SyncTransferBlockerKind =
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

export type SyncGetStatusArgs = {
  /**
   * Transfer readiness scans active chats, terminal sessions, and managed run
   * processes. Top-level chrome can skip it when it only needs the
   * connection label.
   */
  includeTransferReadiness?: boolean;
  forceTransferReadiness?: boolean;
};

export type SyncDeviceRuntimeState = SyncDeviceRecord & {
  isLocal: boolean;
  // Legacy internal/wire flag. User-facing copy should say "host".
  isBrain: boolean;
  isHost?: boolean;
  connectionState: "self" | "connected" | "disconnected";
  connectedAt: string | null;
  lastAppliedAt: string | null;
  remoteAddress: string | null;
  remotePort: number | null;
  latencyMs: number | null;
  syncLag: number | null;
};

export type SyncTailnetDiscoveryState =
  | "disabled"
  | "publishing"
  | "published"
  | "pending_approval"
  | "unavailable"
  | "failed";

export type SyncTailnetDiscoveryStatus = {
  state: SyncTailnetDiscoveryState;
  serviceName: string;
  servicePort: number;
  target: string | null;
  updatedAt: string | null;
  error: string | null;
  stderr: string | null;
};

export type SyncRoleSnapshot = {
  mode: SyncMode;
  role: SyncRole;
  runtimeMode?: SyncRuntimeMode;
  runtimeRole?: SyncRuntimeRole;
  localDevice: SyncDeviceRecord;
  // Legacy internal naming for the current host device.
  currentBrain: SyncDeviceRecord | null;
  currentRuntime?: SyncDeviceRecord | null;
  clusterState: SyncClusterState | null;
  bootstrapToken: string | null;
  pairingPin: string | null;
  pairingPinConfigured: boolean;
  /// Optional human name for THIS runtime (one per socket/`siteId`), set so two
  /// runtimes on the same machine are distinguishable. Null when unset.
  runtimeName: string | null;
  pairingConnectInfo: SyncPairingConnectInfo | null;
  connectedPeers: SyncPeerConnectionState[];
  tailnetDiscovery: SyncTailnetDiscoveryStatus;
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
  projectCatalog: {
    enabled: boolean;
  };
  changesetAck: {
    enabled: boolean;
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

export type SyncMobileProjectSummary = {
  id: string;
  displayName: string;
  rootPath: string | null;
  defaultBaseRef: string | null;
  lastOpenedAt: string | null;
  iconDataUrl?: string | null;
  laneCount: number;
  isAvailable: boolean;
  isCached: boolean;
  isOpen: boolean;
};

export type SyncProjectCatalogPayload = {
  projects: SyncMobileProjectSummary[];
};

export type SyncProjectCatalogChunkPayload = {
  catalogId: string;
  index: number;
  total: number;
  done: boolean;
  projects: SyncMobileProjectSummary[];
};

export type SyncProjectSwitchRequestPayload = {
  projectId?: string | null;
  rootPath?: string | null;
};

export type SyncProjectConnectionPayload = {
  authKind: "bootstrap" | "paired";
  token?: string | null;
  pairedDeviceId?: string | null;
  hostIdentity: SyncPairingHostIdentity;
  port: number;
  addressCandidates: SyncAddressCandidate[];
};

export type SyncProjectSwitchResultPayload = {
  ok: boolean;
  message?: string | null;
  project?: SyncMobileProjectSummary | null;
  connection?: SyncProjectConnectionPayload | null;
};

export type SyncHelloAuth =
  | { kind: "bootstrap"; token: string }
  | { kind: "paired"; deviceId: string; secret: string };

export type SyncHelloOkPayload = {
  peer: SyncPeerMetadata;
  brain: SyncPeerMetadata;
  serverDbVersion: number;
  /**
   * cr-sqlite site id of the project DB this host is currently serving.
   * Clients key their inbound changeset cursor on it so a cursor built
   * against one project's DB is never replayed against another's.
   */
  serverDbSiteId?: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  projects?: SyncMobileProjectSummary[];
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

export type SyncPairingHostIdentity = {
  deviceId: string;
  siteId: string;
  name: string;
  platform: SyncPeerPlatform;
  deviceType: SyncPeerDeviceType;
};

export type SyncPairingConnectInfo = {
  hostIdentity: SyncPairingHostIdentity;
  port: number;
  addressCandidates: SyncAddressCandidate[];
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
  batchId: string;
  reason: "catchup" | "broadcast" | "relay";
  fromDbVersion: number;
  toDbVersion: number;
  changes: CrsqlChangeRow[];
};

export type SyncChangesetAckPayload = {
  batchId: string;
  fromDbVersion: number;
  toDbVersion: number;
  appliedDbVersion: number;
  appliedCount: number;
  ok: boolean;
  error?: {
    code: string;
    message: string;
  };
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
  previewKind?: "text" | "image" | "binary";
  dataUrl?: string;
  contentOmitted?: boolean;
  omittedReason?: "too_large" | "unsupported_binary";
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
  /**
   * Resume marker: transcript byte offset the client has already applied.
   * When the host can serve `sinceOffset .. end` within the maxBytes budget
   * it replies with a delta snapshot (`delta: true`) the client appends;
   * otherwise it falls back to the regular tail snapshot.
   */
  sinceOffset?: number;
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
  /** Transcript byte offset where `transcript` begins. null when unknown. */
  startOffset?: number | null;
  /** Transcript byte offset `transcript` covers through. null when unknown. */
  endOffset?: number | null;
  /** True when `transcript` only contains bytes from the requested `sinceOffset` (client appends instead of replacing). */
  delta?: boolean;
  /**
   * Whether a live PTY currently backs the session. False when a brain
   * restart orphaned a "running" session — input would go nowhere, so clients
   * surface a resume affordance instead of silently accepting keystrokes.
   */
  live?: boolean;
};

export type SyncTerminalDataPayload = {
  sessionId: string;
  ptyId: string;
  data: string;
  at: string;
  /**
   * Transcript end offset (UTF-8 bytes) after this chunk. null/omitted when
   * unavailable (untracked session, transcript writes disabled, byte cap).
   */
  offset?: number | null;
};

// Mobile pull-to-load-older request: return transcript bytes
// [startOffset, endOffset) where endOffset = min(beforeOffset, transcript
// size) and the page is ~maxBytes. The host scans startOffset forward to a
// safe boundary (byte after `\n`, or an ESC byte) so a page never starts
// mid-escape-sequence — unless the page starts at offset 0.
export type SyncTerminalHistoryRequestPayload = {
  sessionId: string;
  beforeOffset: number;
  maxBytes?: number;
};

export type SyncTerminalHistoryResponsePayload = {
  sessionId: string;
  data: string;
  startOffset: number;
  endOffset: number;
  /** True when this page starts at the very beginning of the transcript. */
  atStart: boolean;
};

export type SyncTerminalExitPayload = {
  sessionId: string;
  ptyId: string;
  exitCode: number | null;
  at: string;
};

// Sent by mobile clients to push raw bytes (typed text, control sequences,
// pasted content) into the active PTY for `sessionId`. The host expects the
// peer to have a live `terminal_subscribe` for the same session id.
export type SyncTerminalInputPayload = {
  sessionId: string;
  data: string;
};

// Sent by mobile clients when the visible terminal viewport changes
// (rotation, split view, font-size). Cols/rows are characters; the host
// clamps to a sane range internally.
export type SyncTerminalResizePayload = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type SyncChatSubscribePayload = {
  sessionId: string;
  maxBytes?: number;
  /**
   * Resume marker: the highest `seq` (see SyncChatEventPayload) the client
   * has already applied for this session. When the host's per-session replay
   * buffer still covers `sinceSeq + 1 .. latest`, it replays just those
   * events as ordinary `chat_event` envelopes and skips the snapshot
   * (responding with `resumed: true` and an empty `events` array). When the
   * gap is no longer coverable (host restart, buffer eviction), the host
   * falls back to the regular maxBytes-capped snapshot.
   */
  sinceSeq?: number;
};

export type SyncChatSubscribeSnapshotPayload = {
  sessionId: string;
  capturedAt: string;
  truncated: boolean;
  events: AgentChatEventEnvelope[];
  /**
   * True when the host honored `sinceSeq` and replayed buffered events
   * instead of producing a snapshot. `events` is empty in that case — the
   * replayed history arrives as ordinary `chat_event` envelopes. Clients must
   * reset any stored seq watermark when this is absent/false because the
   * host's seq stream may have restarted (e.g. host process restart).
   */
  resumed?: boolean;
  /**
   * Whether a turn is currently running for this session, taken from the live
   * agent chat service at subscribe time. Snapshots are byte-capped transcript
   * tails, so a long-running turn's `status: started` event can fall outside
   * the tail — without this flag a client subscribing mid-turn cannot tell
   * the session is streaming. Absent on hosts that predate the field and when
   * the host has no live summary for the session.
   */
  turnActive?: boolean;
};

export type SyncChatUnsubscribePayload = {
  sessionId: string;
};

/**
 * Live chat event envelope. `seq` is a host-assigned, per-session,
 * monotonically increasing counter used for resumable streams: clients track
 * the highest seq applied and pass it back as `sinceSeq` on re-subscribe.
 * Optional for backward compatibility — events without `seq` behave exactly
 * as before (no dedupe, no resume).
 */
export type SyncChatEventPayload = AgentChatEventEnvelope & { seq?: number };

export type SyncBrainStatusPayload = {
  // Legacy wire field. New consumers can read host/runtime instead.
  brain: SyncPeerMetadata;
  host?: SyncPeerMetadata;
  runtime?: SyncPeerMetadata;
  connectedPeers: SyncPeerConnectionState[];
  metrics: {
    connectedPeerCount: number;
    runningSessionCount: number;
    dbVersion: number;
    uptimeMs: number;
    lastBroadcastAt: string | null;
    pendingChangesetPeerCount?: number;
    commandLedgerSize?: number;
    commandReplayCount?: number;
    commandConflictCount?: number;
    lastCommandResultLatencyMs?: number | null;
    lastChangesetAckLatencyMs?: number | null;
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

export type SyncCliLaunchProvider = "claude" | "codex" | "cursor" | "droid" | "opencode" | "shell";

export type SyncStartCliSessionArgs = {
  laneId: string;
  provider: SyncCliLaunchProvider;
  permissionMode?: AgentChatPermissionMode | null;
  title?: string | null;
  initialInput?: string | null;
  cols?: number;
  rows?: number;
  model?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
};

export type SyncStartCliSessionResult = {
  sessionId: string;
  ptyId: string | null;
  session: TerminalSessionSummary | null;
};

export type SyncSendToSessionArgs = {
  sessionId: string;
  text: string;
  cols?: number | null;
  rows?: number | null;
};

export type SyncSendToSessionResult = PtySendToSessionResult;

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
  | "lanes.previewBranchSwitch"
  | "lanes.attach"
  | "lanes.listUnregisteredWorktrees"
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
  | "lanes.dismissAutoRebaseStatus"
  | "lanes.listTemplates"
  | "lanes.getDefaultTemplate"
  | "lanes.initEnv"
  | "lanes.getEnvStatus"
  | "lanes.applyTemplate"
  | "work.listSessions"
  | "work.updateSessionMeta"
  | "work.runQuickCommand"
  | "work.startCliSession"
  | "work.resumeCliSession"
  | "work.sendToSession"
  | "work.stopRuntime"
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
  | "chat.dispatchSteer"
  | "chat.cancelDispatchedSteer"
  | "chat.approve"
  | "chat.respondToInput"
  | "chat.restart"
  | "chat.updateSession"
  | "chat.getCodexGoal"
  | "chat.setCodexGoal"
  | "chat.setCodexGoalStatus"
  | "chat.clearCodexGoal"
  | "chat.archive"
  | "chat.unarchive"
  | "chat.delete"
  | "chat.models"
  | "chat.modelCatalog"
  | "chat.getChatEventHistoryPage"
  | "agentChat.getEventHistoryPage"
  | "cto.getRoster"
  | "cto.ensureSession"
  | "cto.ensureAgentSession"
  | "cto.getState"
  | "cto.listAgents"
  | "cto.getBudgetSnapshot"
  | "cto.listAgentRuns"
  | "cto.listAgentSessionLogs"
  | "cto.listAgentRevisions"
  | "cto.getFlowPolicy"
  | "cto.getLinearConnectionStatus"
  | "cto.getLinearQuickView"
  | "cto.getLinearIssuePickerData"
  | "cto.searchLinearIssues"
  | "cto.getLinearIssueComments"
  | "cto.getLinearSyncDashboard"
  | "cto.runLinearSyncNow"
  | "cto.listLinearSyncQueue"
  | "cto.listLinearIngressEvents"
  | "cto.updateIdentity"
  | "cto.saveAgent"
  | "cto.removeAgent"
  | "cto.setAgentStatus"
  | "cto.triggerAgentWakeup"
  | "cto.rollbackAgentRevision"
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
  | "git.isCommitInLaneHistory"
  | "git.revertCommit"
  | "git.cherryPickCommit"
  | "git.createTag"
  | "git.resetToCommit"
  | "git.stashPush"
  | "git.stashList"
  | "git.stashApply"
  | "git.stashPop"
  | "git.stashDrop"
  | "git.fetch"
  | "git.pull"
  | "git.undoLastHeadChange"
  | "git.redoLastHeadChange"
  | "git.getSyncStatus"
  | "git.sync"
  | "git.push"
  | "git.getConflictState"
  | "git.rebaseContinue"
  | "git.rebaseAbort"
  | "git.mergeContinue"
  | "git.mergeAbort"
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
  | "prs.getDetailByGithub"
  | "prs.getFilesByGithub"
  | "prs.getCommitsByGithub"
  | "prs.getActionRunsByGithub"
  | "prs.getActivityByGithub"
  | "prs.getChecksByGithub"
  | "prs.getReviewsByGithub"
  | "prs.getCommentsByGithub"
  | "prs.getReviewThreadsByGithub"
  | "prs.createFromLane"
  | "prs.createQueue"
  | "prs.linkToLane"
  | "prs.preflightCreateLaneFromPrBranch"
  | "prs.createLaneFromPrBranch"
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
  | "prs.simulateIntegration"
  | "prs.commitIntegration"
  | "prs.listIntegrationWorkflows"
  | "prs.updateIntegrationProposal"
  | "prs.deleteIntegrationProposal"
  | "prs.dismissIntegrationCleanup"
  | "prs.cleanupIntegrationWorkflow"
  | "prs.createIntegrationLaneForProposal"
  | "prs.startIntegrationResolution"
  | "prs.recheckIntegrationStep"
  | "prs.landQueueNext"
  | "prs.startQueueAutomation"
  | "prs.pauseQueueAutomation"
  | "prs.resumeQueueAutomation"
  | "prs.cancelQueueAutomation"
  | "prs.reorderQueue"
  | "prs.getMobileSnapshot"
  | "modelPicker.getFavorites"
  | "modelPicker.setFavorites"
  | "modelPicker.toggleFavorite"
  | "modelPicker.getRecents"
  | "modelPicker.pushRecent"
  | "deeplinks.open";

export type SyncRemoteCommandPolicy = {
  viewerAllowed: boolean;
  requiresApproval?: boolean;
  localOnly?: boolean;
  queueable?: boolean;
};

export type SyncRemoteCommandDescriptor = {
  action: SyncRemoteCommandAction | (string & {});
  scope: "runtime" | "project";
  policy: SyncRemoteCommandPolicy;
};

export type SyncCommandPayload = {
  commandId: string;
  projectId?: string | null;
  projectRootPath?: string | null;
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

// ---------------------------------------------------------------------------
// Mobile push notification types (WS2)
// ---------------------------------------------------------------------------

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsPushTokenKind = "alert" | "activity-start" | "activity-update";

/**
 * Shape of the Mobile Push settings panel's read of the main-process APNs state.
 * `keyStored` reflects whether a `.p8` is persisted via `safeStorage`; the bytes
 * themselves never round-trip to the renderer.
 */
export type ApnsBridgeStatus = {
  enabled: boolean;
  configured: boolean;
  keyStored: boolean;
  keyId: string | null;
  teamId: string | null;
  bundleId: string | null;
  env: ApnsEnvironment;
};

export type ApnsBridgeSaveConfigArgs = {
  enabled: boolean;
  keyId: string;
  teamId: string;
  bundleId: string;
  env: ApnsEnvironment;
};

export type ApnsBridgeUploadKeyArgs = {
  /** PEM-formatted `.p8` body. The main process encrypts before writing to disk. */
  p8Pem: string;
};

/**
 * Named category of the fake notification the Mobile Push panel sends.
 * Each maps to a distinct APNs payload template so the user can exercise
 * every iOS code path (awaiting-input banner, CI-failing retry, etc.)
 * without having to trigger a real domain event.
 */
export type ApnsTestPushKind =
  | "awaiting_input"
  | "chat_failed"
  | "chat_turn_completed"
  | "ci_failing"
  | "review_requested"
  | "merge_ready"
  | "cto_subagent_finished"
  | "generic"
  // Live Activity tests — drive the workspace-pill UI on the device.
  | "la_update_running"
  | "la_update_attention"
  | "la_update_multi"
  | "la_start"
  | "la_end";

export type ApnsBridgeSendTestPushArgs = {
  /** Specific device to target. Null/undefined picks the first iOS peer with an alert token. */
  deviceId?: string | null;
  /** Which fake payload to fire. Defaults to `"generic"` for back-compat. */
  kind?: ApnsTestPushKind;
};

export type ApnsBridgeSendTestPushResult = {
  ok: boolean;
  reason?: string;
};

/**
 * Sent from an iOS peer to the desktop host whenever it registers or rotates
 * an APNs token. Stored in the device registry metadata so subsequent pushes
 * can target the correct device + token kind.
 */
export type SyncRegisterPushTokenPayload = {
  token: string;
  kind: ApnsPushTokenKind;
  env: ApnsEnvironment;
  bundleId: string;
  /** Optional extra context that we may route on; kept open-ended. */
  activityId?: string;
  /** `true` once the peer has confirmed it actually received a previous test push. */
  verified?: boolean;
};

/**
 * 14 user-tunable toggles mirroring the iOS Notifications Center screen.
 * The host uses these as a filter at send-time so toggles take effect live.
 */
export type NotificationPreferences = {
  /** Master switch; if false, all of the below are short-circuited. */
  enabled: boolean;
  chat: {
    awaitingInput: boolean;
    chatFailed: boolean;
    turnCompleted: boolean;
  };
  cto: {
    subagentStarted: boolean;
    subagentFinished: boolean;
  };
  prs: {
    ciFailing: boolean;
    reviewRequested: boolean;
    changesRequested: boolean;
    mergeReady: boolean;
  };
  system: {
    providerOutage: boolean;
    authRateLimit: boolean;
    hookFailure: boolean;
  };
  /** Optional quiet-hours gate in 24h `HH:MM` format, inclusive start / exclusive end. */
  quietHours?: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
  };
  /** Per-session APNs routing overrides keyed by chat/session id. */
  perSessionOverrides?: Record<string, {
    muted?: boolean;
    awaitingInputOnly?: boolean;
  }>;
  /** Global mute applied by the Control Widget ("snooze for N minutes"). */
  muteUntil?: string | null;
};

export type SyncNotificationPrefsPayload = {
  prefs: NotificationPreferences;
};

export type SyncSendTestPushPayload = {
  kind: "alert" | "activity";
  /** Optional override body for the test push; otherwise a canned message is used. */
  title?: string;
  body?: string;
};

/**
 * Payload pushed to an iOS peer over the existing sync WebSocket when the
 * desktop decides an event is foreground-only (no APNs fan-out needed) or
 * when APNs is disabled.
 */
export type SyncInAppNotificationPayload = {
  category: "chat" | "cto" | "pr" | "system";
  title: string;
  body: string;
  /** Used by the client for de-duplication with any parallel APNs delivery. */
  collapseId?: string;
  /** Deep link target: `ade://session/<id>` / `ade://pr/<number>` / etc. */
  deepLink?: string;
  /** Optional routing hints used by the iOS notification formatter. */
  metadata?: Record<string, string | number | boolean | null>;
  /** ISO8601. Helps the client reason about stale notifications. */
  generatedAt: string;
};

type SyncEnvelopeBase<TType extends string> = {
  version: SyncProtocolVersion;
  type: TType;
  projectId?: string | null;
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
export type SyncProjectCatalogRequestEnvelope = SyncEnvelopeWithPayload<"project_catalog_request", Record<string, never>>;
export type SyncProjectCatalogEnvelope = SyncEnvelopeWithPayload<"project_catalog", SyncProjectCatalogPayload>;
export type SyncProjectCatalogChunkEnvelope = SyncEnvelopeWithPayload<"project_catalog_chunk", SyncProjectCatalogChunkPayload>;
export type SyncProjectSwitchRequestEnvelope = SyncEnvelopeWithPayload<"project_switch_request", SyncProjectSwitchRequestPayload>;
export type SyncProjectSwitchResultEnvelope = SyncEnvelopeWithPayload<"project_switch_result", SyncProjectSwitchResultPayload>;
export type SyncPairingRequestEnvelope = SyncEnvelopeWithPayload<"pairing_request", SyncPairingRequestPayload>;
export type SyncPairingResultEnvelope = SyncEnvelopeWithPayload<"pairing_result", SyncPairingResultPayload>;
export type SyncChangesetBatchEnvelope = SyncEnvelopeWithPayload<"changeset_batch", SyncChangesetBatchPayload>;
export type SyncChangesetAckEnvelope = SyncEnvelopeWithPayload<"changeset_ack", SyncChangesetAckPayload>;
export type SyncHeartbeatEnvelope = SyncEnvelopeWithPayload<"heartbeat", SyncHeartbeatPayload>;
export type SyncFileRequestEnvelope = SyncEnvelopeWithPayload<"file_request", SyncFileRequest>;
export type SyncFileResponseEnvelope = SyncEnvelopeWithPayload<"file_response", SyncFileResponsePayload>;
export type SyncTerminalSubscribeEnvelope = SyncEnvelopeWithPayload<"terminal_subscribe", SyncTerminalSubscribePayload>;
export type SyncTerminalUnsubscribeEnvelope = SyncEnvelopeWithPayload<"terminal_unsubscribe", SyncTerminalUnsubscribePayload>;
export type SyncTerminalSnapshotEnvelope = SyncEnvelopeWithPayload<"terminal_snapshot", SyncTerminalSnapshotPayload>;
export type SyncTerminalDataEnvelope = SyncEnvelopeWithPayload<"terminal_data", SyncTerminalDataPayload>;
export type SyncTerminalExitEnvelope = SyncEnvelopeWithPayload<"terminal_exit", SyncTerminalExitPayload>;
export type SyncTerminalInputEnvelope = SyncEnvelopeWithPayload<"terminal_input", SyncTerminalInputPayload>;
export type SyncTerminalResizeEnvelope = SyncEnvelopeWithPayload<"terminal_resize", SyncTerminalResizePayload>;
export type SyncTerminalHistoryEnvelope = SyncEnvelopeWithPayload<"terminal_history", SyncTerminalHistoryRequestPayload | SyncTerminalHistoryResponsePayload>;
export type SyncChatSubscribeEnvelope = SyncEnvelopeWithPayload<"chat_subscribe", SyncChatSubscribePayload | SyncChatSubscribeSnapshotPayload>;
export type SyncChatUnsubscribeEnvelope = SyncEnvelopeWithPayload<"chat_unsubscribe", SyncChatUnsubscribePayload>;
export type SyncChatEventEnvelope = SyncEnvelopeWithPayload<"chat_event", SyncChatEventPayload>;
export type SyncBrainStatusEnvelope = SyncEnvelopeWithPayload<"brain_status", SyncBrainStatusPayload>;
export type SyncCommandEnvelope = SyncEnvelopeWithPayload<"command", SyncCommandPayload>;
export type SyncCommandAckEnvelope = SyncEnvelopeWithPayload<"command_ack", SyncCommandAckPayload>;
export type SyncCommandResultEnvelope = SyncEnvelopeWithPayload<"command_result", SyncCommandResultPayload>;
export type SyncRegisterPushTokenEnvelope = SyncEnvelopeWithPayload<"register_push_token", SyncRegisterPushTokenPayload>;
export type SyncNotificationPrefsEnvelope = SyncEnvelopeWithPayload<"notification_prefs", SyncNotificationPrefsPayload>;
export type SyncSendTestPushEnvelope = SyncEnvelopeWithPayload<"send_test_push", SyncSendTestPushPayload>;
export type SyncInAppNotificationEnvelope = SyncEnvelopeWithPayload<"in_app_notification", SyncInAppNotificationPayload>;

/**
 * One slice of an oversized encoded envelope. `part` is a base64 slice of the
 * full encoded envelope's UTF-8 bytes; clients concatenate parts in `index`
 * order, decode, and process the result as a normal envelope. Hosts only emit
 * these to peers that declared the "chunkedEnvelopes" hello capability.
 */
export type SyncEnvelopeChunkPayload = {
  chunkId: string;
  index: number;
  total: number;
  part: string;
};
export type SyncEnvelopeChunkEnvelope = SyncEnvelopeWithPayload<"envelope_chunk", SyncEnvelopeChunkPayload>;

export type SyncEnvelope =
  | SyncHelloEnvelope
  | SyncHelloOkEnvelope
  | SyncHelloErrorEnvelope
  | SyncProjectCatalogRequestEnvelope
  | SyncProjectCatalogEnvelope
  | SyncProjectCatalogChunkEnvelope
  | SyncProjectSwitchRequestEnvelope
  | SyncProjectSwitchResultEnvelope
  | SyncPairingRequestEnvelope
  | SyncPairingResultEnvelope
  | SyncChangesetBatchEnvelope
  | SyncChangesetAckEnvelope
  | SyncHeartbeatEnvelope
  | SyncFileRequestEnvelope
  | SyncFileResponseEnvelope
  | SyncTerminalSubscribeEnvelope
  | SyncTerminalUnsubscribeEnvelope
  | SyncTerminalSnapshotEnvelope
  | SyncTerminalDataEnvelope
  | SyncTerminalExitEnvelope
  | SyncTerminalInputEnvelope
  | SyncTerminalResizeEnvelope
  | SyncTerminalHistoryEnvelope
  | SyncChatSubscribeEnvelope
  | SyncChatUnsubscribeEnvelope
  | SyncChatEventEnvelope
  | SyncBrainStatusEnvelope
  | SyncCommandEnvelope
  | SyncCommandAckEnvelope
  | SyncCommandResultEnvelope
  | SyncRegisterPushTokenEnvelope
  | SyncNotificationPrefsEnvelope
  | SyncSendTestPushEnvelope
  | SyncInAppNotificationEnvelope
  | SyncEnvelopeChunkEnvelope;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  chat: {
    awaitingInput: true,
    chatFailed: true,
    turnCompleted: false,
  },
  cto: {
    subagentStarted: false,
    subagentFinished: true,
  },
  prs: {
    ciFailing: true,
    reviewRequested: true,
    changesRequested: true,
    mergeReady: true,
  },
  system: {
    providerOutage: true,
    authRateLimit: true,
    hookFailure: false,
  },
  muteUntil: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizePrefsGroup<T extends Record<string, boolean>>(
  input: unknown,
  defaults: T,
): T {
  const raw = isRecord(input) ? input : {};
  const next = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    next[key] = booleanOrDefault(raw[key as string], defaults[key]) as T[keyof T];
  }
  return next;
}

export function normalizeNotificationPreferences(input: unknown): NotificationPreferences {
  const raw = isRecord(input) ? input : {};
  const quietHoursRaw = isRecord(raw.quietHours) ? raw.quietHours : null;
  const perSessionRaw = isRecord(raw.perSessionOverrides) ? raw.perSessionOverrides : {};
  const perSessionOverrides: NonNullable<NotificationPreferences["perSessionOverrides"]> = {};
  for (const [sessionId, override] of Object.entries(perSessionRaw)) {
    if (!isRecord(override) || !sessionId.trim()) continue;
    const normalizedOverride = {
      muted: booleanOrDefault(override.muted, false),
      awaitingInputOnly: booleanOrDefault(override.awaitingInputOnly, false),
    };
    if (!normalizedOverride.muted && !normalizedOverride.awaitingInputOnly) continue;
    perSessionOverrides[sessionId] = normalizedOverride;
  }
  return {
    enabled: booleanOrDefault(raw.enabled, DEFAULT_NOTIFICATION_PREFERENCES.enabled),
    chat: normalizePrefsGroup(raw.chat, DEFAULT_NOTIFICATION_PREFERENCES.chat),
    cto: normalizePrefsGroup(raw.cto, DEFAULT_NOTIFICATION_PREFERENCES.cto),
    prs: normalizePrefsGroup(raw.prs, DEFAULT_NOTIFICATION_PREFERENCES.prs),
    system: normalizePrefsGroup(raw.system, DEFAULT_NOTIFICATION_PREFERENCES.system),
    ...(quietHoursRaw
      ? {
          quietHours: {
            enabled: booleanOrDefault(quietHoursRaw.enabled, false),
            start: stringOrDefault(quietHoursRaw.start, "22:00"),
            end: stringOrDefault(quietHoursRaw.end, "07:00"),
            timezone: stringOrDefault(
              quietHoursRaw.timezone,
              Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            ),
          },
        }
      : {}),
    ...(Object.keys(perSessionOverrides).length > 0 ? { perSessionOverrides } : {}),
    muteUntil: typeof raw.muteUntil === "string" || raw.muteUntil === null ? raw.muteUntil : DEFAULT_NOTIFICATION_PREFERENCES.muteUntil,
  };
}
