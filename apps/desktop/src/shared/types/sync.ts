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
  localDevice: SyncDeviceRecord;
  // Legacy internal naming for the current host device.
  currentBrain: SyncDeviceRecord | null;
  clusterState: SyncClusterState | null;
  bootstrapToken: string | null;
  pairingPin: string | null;
  pairingPinConfigured: boolean;
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
  laneCount: number;
  isAvailable: boolean;
  isCached: boolean;
  isOpen: boolean;
};

export type SyncProjectCatalogPayload = {
  projects: SyncMobileProjectSummary[];
};

export type SyncProjectSwitchRequestPayload = {
  projectId?: string | null;
  rootPath?: string | null;
};

export type SyncProjectConnectionPayload = {
  authKind: "bootstrap";
  token: string;
  hostIdentity: SyncPairingQrPayload["hostIdentity"];
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

/// Sent by mobile clients to push raw bytes (typed text, control sequences,
/// pasted content) into the active PTY for `sessionId`. The host expects the
/// peer to have a live `terminal_subscribe` for the same session id.
export type SyncTerminalInputPayload = {
  sessionId: string;
  data: string;
};

/// Sent by mobile clients when the visible terminal viewport changes
/// (rotation, split view, font-size). Cols/rows are characters; the host
/// clamps to a sane range internally.
export type SyncTerminalResizePayload = {
  sessionId: string;
  cols: number;
  rows: number;
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
  | "lanes.dismissAutoRebaseStatus"
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
  | "chat.restart"
  | "chat.updateSession"
  | "chat.dispose"
  | "chat.archive"
  | "chat.unarchive"
  | "chat.delete"
  | "chat.models"
  | "cto.getRoster"
  | "cto.ensureSession"
  | "cto.ensureAgentSession"
  | "cto.getState"
  | "cto.listAgents"
  | "cto.getBudgetSnapshot"
  | "cto.getAgentCoreMemory"
  | "cto.listAgentRuns"
  | "cto.listAgentSessionLogs"
  | "cto.listAgentRevisions"
  | "cto.getFlowPolicy"
  | "cto.getLinearConnectionStatus"
  | "cto.getLinearSyncDashboard"
  | "cto.listLinearSyncQueue"
  | "cto.listLinearIngressEvents"
  | "cto.updateIdentity"
  | "cto.updateCoreMemory"
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
    missionPhaseChanged: boolean;
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
export type SyncProjectSwitchRequestEnvelope = SyncEnvelopeWithPayload<"project_switch_request", SyncProjectSwitchRequestPayload>;
export type SyncProjectSwitchResultEnvelope = SyncEnvelopeWithPayload<"project_switch_result", SyncProjectSwitchResultPayload>;
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
export type SyncTerminalInputEnvelope = SyncEnvelopeWithPayload<"terminal_input", SyncTerminalInputPayload>;
export type SyncTerminalResizeEnvelope = SyncEnvelopeWithPayload<"terminal_resize", SyncTerminalResizePayload>;
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

export type SyncEnvelope =
  | SyncHelloEnvelope
  | SyncHelloOkEnvelope
  | SyncHelloErrorEnvelope
  | SyncProjectCatalogRequestEnvelope
  | SyncProjectCatalogEnvelope
  | SyncProjectSwitchRequestEnvelope
  | SyncProjectSwitchResultEnvelope
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
  | SyncTerminalInputEnvelope
  | SyncTerminalResizeEnvelope
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
  | SyncInAppNotificationEnvelope;

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
    missionPhaseChanged: true,
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
    perSessionOverrides[sessionId] = {
      muted: booleanOrDefault(override.muted, false),
      awaitingInputOnly: booleanOrDefault(override.awaitingInputOnly, false),
    };
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
