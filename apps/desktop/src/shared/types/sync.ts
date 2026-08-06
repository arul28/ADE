import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  AgentChatPermissionMode,
} from "./chat";
import type { PersonalChatRemoteCommandAction } from "./personalChats";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
} from "./core";
import type {
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
  ExternalSessionListArgs,
  ExternalSessionSummary,
} from "./externalSessions";
import type { PtySendToSessionResult, TerminalSessionSummary } from "./sessions";
import type { PairedRuntimeSyncEnvelope } from "./pairedRuntime";
import type { LinearConnectionStatus } from "./linearSync";

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

/** Any integer in the runtime's advertised supported version interval. */
export type SyncProtocolVersion = number;

/** Additive hello capability for in-place ADE Relay account reauthorization. */
export const SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY = "relayReauthorizeV1" as const;

/**
 * Additive hello capability for browser peers that keep no local CRR replica.
 * Such peers fully refetch their query domains after hello and consume only
 * post-connect sync messages as invalidation hints.
 */
export const SYNC_INVALIDATION_ONLY_V1_CAPABILITY = "invalidationOnlyV1" as const;
/** Browser can consume compact `invalidation_batch` envelopes. */
export const SYNC_COMPACT_INVALIDATION_V1_CAPABILITY = "compactInvalidationV1" as const;

/** Hard bounds for compact browser invalidation hints. */
export const SYNC_INVALIDATION_BATCH_MAX_ENVELOPE_BYTES = 16 * 1024;
export const SYNC_INVALIDATION_BATCH_MAX_TABLES = 128;
export const SYNC_INVALIDATION_TABLE_MAX_BYTES = 256;

/** Relay transport readiness protocol used before the ADE sync hello. */
export const SYNC_RELAY_READY_VERSION = 2 as const;

/**
 * Random 32-hex generation minted for each brain control socket. The Worker
 * binds every open/pipe/ready/reject to this epoch so a stale pipe cannot pair
 * with a client admitted by a replacement control.
 */
export type SyncRelayControlEpoch = string;

export type SyncRelayControlOpen = {
  t: "open";
  id: string;
  epoch: SyncRelayControlEpoch;
  /** Present when the client connected with `?ready=2`. */
  readyVersion?: typeof SYNC_RELAY_READY_VERSION;
};

export type SyncRelayControlReady = {
  t: "ready";
  id: string;
  epoch: SyncRelayControlEpoch;
};

export type SyncRelayControlReject = {
  t: "reject";
  id: string;
  epoch: SyncRelayControlEpoch;
  code: number;
  reason: string;
};

/** Immediate negotiation frame from a Worker that understands `?ready=2`. */
export type SyncRelayClientAccepted = {
  t: "accepted";
  v: typeof SYNC_RELAY_READY_VERSION;
};

/** Final client-visible frame after both Relay pipe and local bridge are OPEN. */
export type SyncRelayClientReady = {
  t: "ready";
  v: typeof SYNC_RELAY_READY_VERSION;
};

/**
 * Wire-level payload compression. `gzip` is the legacy, implicitly enabled
 * codec retained for peers that predate negotiation; `deflate` is used only
 * after both sides explicitly negotiate it in hello/hello_ok.
 */
export type SyncCompressionCodec = "none" | "gzip" | "deflate";
export const SYNC_APPLICATION_COMPRESSION_CODECS = ["deflate"] as const;
export type SyncApplicationCompressionCodec =
  (typeof SYNC_APPLICATION_COMPRESSION_CODECS)[number];
export const SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES = 512;
export const SYNC_CHUNKED_ENVELOPES_CAPABILITY = "chunkedEnvelopes";

export type SyncPayloadEncoding = "json" | "base64";

export type SyncPeerPlatform = "macOS" | "linux" | "windows" | "iOS" | "unknown";

export type SyncPeerDeviceType = "desktop" | "phone" | "vps" | "browser" | "unknown";

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
  /**
   * One id/timestamp shared by every route candidate in a single connection
   * race. Hosts use it to prevent a late losing route from evicting the winner.
   * Older clients omit it and retain last-successful-hello behavior.
   */
  connectionAttempt?: {
    id: string;
    /** Strictly monotonic per device, expressed as Unix epoch milliseconds. */
    startedAtMs: number;
  };
  /**
   * Additive hello capabilities. `runtimeOnly` means the client consumes only
   * rpc/fwd envelopes; hosts honor it only for an authenticated pairing record
   * carrying the server-issued runtime-host grant.
   */
  capabilities?: string[];
  appVersion?: string;
  appBuild?: string;
  bundleIdentifier?: string;
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
  | "terminal_session";

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
   * Transfer readiness scans active chats and terminal sessions. Top-level
   * chrome can skip it when it only needs the connection label.
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

export function peerToRuntimeDeviceState(
  peer: SyncPeerConnectionState,
  metadata: SyncDeviceRecord["metadata"] = {},
): SyncDeviceRuntimeState {
  return {
    deviceId: peer.deviceId,
    siteId: peer.siteId,
    name: peer.deviceName,
    platform: peer.platform,
    deviceType: peer.deviceType,
    createdAt: peer.connectedAt,
    updatedAt: peer.lastSeenAt,
    lastSeenAt: peer.lastSeenAt,
    lastHost: peer.remoteAddress,
    lastPort: peer.remotePort,
    tailscaleIp: null,
    ipAddresses: [],
    metadata,
    isLocal: false,
    isBrain: peer.isBrain,
    isHost: peer.isHost,
    connectionState: "connected",
    connectedAt: peer.connectedAt,
    lastAppliedAt: peer.lastAppliedAt,
    remoteAddress: peer.remoteAddress,
    remotePort: peer.remotePort,
    latencyMs: peer.latencyMs,
    syncLag: peer.syncLag,
  };
}

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

export type SyncAccountDirectoryState =
  | "published"
  | "sync_disabled"
  | "no_active_sync_scope"
  | "snapshot_failed"
  | "machine_key_unavailable"
  | "missing_pairing_connect_info"
  | "not_host"
  | "account_signed_out"
  | "token_unreadable"
  | "invalid_directory_url"
  | "http_error"
  | "token_timeout"
  | "http_timeout"
  | "timeout"
  | "transport_error";

/**
 * True for publish failures caused by the brain's own copy of the account
 * session being unreadable on this Mac — it could not decrypt the stored
 * session, could not read account status, or could not read/refresh the
 * account token. A brain restart is the known remediation: the replacement
 * process re-reads the keychain from scratch and can decrypt again.
 *
 * Deliberately narrow. Network, HTTP, and genuinely-signed-out states are not
 * fixed by restarting, so offering a repair for them would be a lie.
 */
export function isBrainAccountSessionFailure(
  state: SyncAccountDirectoryState | null | undefined,
): boolean {
  return state === "token_unreadable";
}

const SYNC_ACCOUNT_DIRECTORY_STATES: readonly SyncAccountDirectoryState[] = [
  "published",
  "sync_disabled",
  "no_active_sync_scope",
  "snapshot_failed",
  "machine_key_unavailable",
  "missing_pairing_connect_info",
  "not_host",
  "account_signed_out",
  "token_unreadable",
  "invalid_directory_url",
  "http_error",
  "token_timeout",
  "http_timeout",
  "timeout",
  "transport_error",
];

/**
 * Narrows a publisher state that arrived over RPC as an untyped string.
 *
 * The widening belongs here, at the trust boundary, rather than in a caller's
 * signature where it would silently disable exhaustiveness checking on the
 * switch below.
 */
export function isSyncAccountDirectoryState(
  value: string | null | undefined,
): value is SyncAccountDirectoryState {
  return typeof value === "string"
    && (SYNC_ACCOUNT_DIRECTORY_STATES as readonly string[]).includes(value);
}

export type UnpublishedMachineAdvice = {
  /** What is true right now, in the user's terms. Never a raw diagnostic. */
  summary: string;
  /** What clears it. Null when nothing the user does would help. */
  nextAction: string | null;
};

/**
 * User-facing advice for a machine that is signed in but not published.
 *
 * One table, consumed by both the desktop Connections pane and `ade setup`.
 * They previously kept hand-mirrored copies that had already drifted: the pane
 * covered every state while the CLI covered one and printed the publisher's raw
 * `skipReason` for the rest — the exact thing both files' comments condemned.
 *
 * Never render `skipReason` from this state. Those strings are internal
 * diagnostics ("No active sync scope is available."); a real user saw one and it
 * told them a fault had occurred and nothing about how to clear it.
 */
export function describeUnpublishedAccountDirectory(
  state: SyncAccountDirectoryState,
): UnpublishedMachineAdvice {
  switch (state) {
    case "published":
      return { summary: "published to your ADE account", nextAction: null };
    case "no_active_sync_scope":
      // NOT "open a project" any more. A brain with no project registered now
      // publishes on its own, so the only way to reach this state is another ADE
      // process on this computer holding the machine-wide sync-host lease — and
      // that process is the one publishing this machine. Telling the user to
      // open a project would hand them an action that cannot change anything.
      return {
        summary: "another ADE app on this computer owns sync for this machine",
        nextAction: "ade doctor",
      };
    case "not_host":
      return {
        summary: "this computer publishes through your main ADE host",
        nextAction: null,
      };
    case "sync_disabled":
      return {
        summary: "sync is off on this computer, so other devices can't reach it",
        nextAction: null,
      };
    case "missing_pairing_connect_info":
      return {
        summary: "waiting for this computer's connection details",
        nextAction: null,
      };
    case "machine_key_unavailable":
      return {
        summary: "this computer isn't registered yet",
        nextAction: "restart ADE",
      };
    case "account_signed_out":
      // The window has a session but the brain does not, so signing in again is
      // what hands the brain one it can use.
      return {
        summary: "the ADE background service is signed out",
        nextAction: "ade connect",
      };
    case "token_unreadable":
      // A Repair control renders beside this in the pane
      // (isBrainAccountSessionFailure), so the summary names the fault and lets
      // the button carry the verb.
      return {
        summary: "the ADE background service can't read your account session",
        nextAction: "ade brain restart",
      };
    case "http_error":
    case "http_timeout":
    case "token_timeout":
    case "timeout":
    case "transport_error":
      return {
        summary: "can't reach your ADE account right now, retrying",
        nextAction: null,
      };
    case "snapshot_failed":
    case "invalid_directory_url":
      return {
        summary: "this computer isn't published yet",
        nextAction: "restart ADE",
      };
  }
}

export type SyncAccountDirectoryLegDurations = {
  snapshot: number | null;
  token: number | null;
  http: number | null;
};

/** Last account-directory publisher outcome for this machine brain. */
export type SyncAccountDirectoryHealth = {
  state: SyncAccountDirectoryState;
  skipReason: string | null;
  directoryOrigin: string | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastHttpStatus: number | null;
  lastHttpReason: string | null;
  reachableEndpointCount: number;
  lastLegDurations: SyncAccountDirectoryLegDurations;
  failingSinceMs: number | null;
};

export function createSyncAccountDirectoryHealth(
  state: SyncAccountDirectoryState,
  skipReason: string | null,
  overrides: Partial<Omit<SyncAccountDirectoryHealth, "state" | "skipReason">> = {},
): SyncAccountDirectoryHealth {
  return {
    state,
    skipReason,
    directoryOrigin: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastHttpStatus: null,
    lastHttpReason: null,
    reachableEndpointCount: 0,
    lastLegDurations: {
      snapshot: null,
      token: null,
      http: null,
    },
    failingSinceMs: null,
    ...overrides,
  };
}

export type SyncRouteHealth = {
  listener: {
    listenerBound: boolean;
    loopbackAdeValidated: boolean;
    port: number | null;
    lastFailureAt: string | null;
    reason: string | null;
    lastSuccessAt: string | null;
  };
  tailscale: {
    enabled: boolean;
    tailscalePublished: boolean;
    tailscaleReachable: boolean;
    lastFailureAt: string | null;
    reason: string | null;
    lastSuccessAt: string | null;
  };
  relay: {
    enabled: boolean;
    relayControlConnected: boolean;
    relayBridgeValidated: boolean;
    lastFailureAt: string | null;
    skipReason: string | null;
    lastControlError: string | null;
    lastControlOpenAt: string | null;
    lastBridgeValidationAt: string | null;
    /**
     * The relay control is deliberately NOT redialing. Set when the relay
     * evicted this host with close code 4505 ("replaced by newer host"),
     * which means another ADE process on this machine claimed the same
     * machineKey. Redialing there is self-harm: the two processes evict each
     * other in a tight loop and relay stays down for both.
     */
    relayControlSuppressed?: boolean;
    relayControlSuppressedReason?: string | null;
    /**
     * Epoch ms when the current uninterrupted control outage began; null while
     * connected. Distinct from `lastFailureAt`, which restamps on every failed
     * attempt and so can never measure how long relay has been down.
     */
    relayControlFailingSinceMs?: number | null;
  };
  accountDirectory: SyncAccountDirectoryHealth;
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
  routeHealth: SyncRouteHealth;
  client: SyncClientStatus;
  transferReadiness: SyncTransferReadiness;
  /** Absent on older runtimes; false means phone/CRDT sync must not be offered. */
  crdtSyncAvailable?: boolean;
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
  /**
   * Browser invalidation-only sync contract. The host includes this only when
   * the concrete hello requested `invalidationOnlyV1`, confirming it will not
   * replay CRDT history to a browser with no local replica.
   *
   * Older hosts omit this additive feature. Browser clients that require the
   * contract must fail closed; other clients safely ignore it.
   */
  invalidationOnlyV1?: {
    enabled: true;
  };
  /**
   * Compact invalidation envelope contract. Kept separate from
   * `invalidationOnlyV1` so hosts remain compatible with older browsers that
   * negotiated history suppression but only understood `changeset_batch`.
   */
  compactInvalidationV1?: {
    enabled: true;
  };
  /**
   * Cross-project chat "quick look": when enabled, the host honors a
   * `projectId`/`projectRootPath` override on `chat_subscribe` and streams a
   * foreign (non-active) project's chat transcript + live events read-only,
   * without switching the socket's active project. Absent on hosts that
   * predate the feature — clients must fall back to a full project activation.
   */
  crossProjectChat?: {
    enabled: boolean;
  };
  /**
   * Cursor-paged chat history over the already-authorized chat subscription.
   * Works for project, personal, and foreign-project quick-look scopes without
   * activating a runtime just to read older transcript bytes.
   */
  chatHistoryPaging?: {
    enabled: true;
  };
  projectCatalog: {
    enabled: boolean;
  };
  projectActions: {
    enabled: boolean;
  };
  changesetAck: {
    enabled: boolean;
  };
  /**
   * Bidirectional oversized-envelope framing. The host returns this only to a
   * peer that declared the matching hello capability.
   */
  chunkedEnvelopes?: {
    enabled: true;
    maxFrameBytes: number;
  };
  /**
   * Reliable terminal input delivery. When enabled, clients may attach an
   * `inputId` to `terminal_input` and retry until the host replies with
   * `terminal_input_ack`. Older hosts omit this field.
   */
  terminalInputAck?: {
    enabled: boolean;
    /** Client retry eligibility window; receipts are never evicted sooner. */
    retryWindowMs?: number;
    /** Maximum unacknowledged input operations a client may pipeline. */
    maxOutstanding?: number;
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
  /**
   * Additive host/mobile product contract. Older hosts omit this field; clients
   * must still keep the connection alive and enter limited mode.
   */
  mobileCompatibility?: {
    contractVersion: number;
    mode: "full" | "limited";
    requiredActions: string[];
    missingActions: string[];
  };
};

export type SyncHelloPayload = {
  peer: SyncPeerMetadata;
  token?: string;
  auth?: SyncHelloAuth;
  /** Ordered application-layer codecs this client can encode and decode. */
  compression?: SyncApplicationCompressionCodec[];
};

export type SyncMobileProjectSummary = {
  id: string;
  displayName: string;
  rootPath: string | null;
  /**
   * Canonical coordinates parsed from the project's GitHub origin. Additive
   * for wire compatibility: older hosts omit both fields, while current hosts
   * send both strings or both nulls.
   */
  repoOwner?: string | null;
  repoName?: string | null;
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

// ---------------------------------------------------------------------------
// All-projects chat roster (mobile hub)
//
// A lightweight, machine-wide projection of every project's lanes + work
// sessions — agent chats, their attached shell rows, AND standalone CLI
// (tracked terminal) sessions, live or ended — so the mobile hub can render
// all projects' sessions-grouped-by-lane at once without activating each
// project. Sourced cheaply from disk (each
// project's `<root>/.ade/ade.db` + `.ade/cache/chat-sessions/*.json`) for
// un-booted projects, with live running/awaiting fidelity overlaid for any
// project scope currently booted on the runtime. Transcripts are NOT included
// here — they load on demand when a chat is opened (which activates that
// project's full sync). Pushed over dedicated `roster_snapshot` / `roster_delta`
// envelopes (subscribe handshake mirrors `chat_subscribe`); oversized snapshots
// ride the generic `envelope_chunk` mechanism transparently.
// ---------------------------------------------------------------------------

/**
 * Status of a roster chat row. For an un-booted project (no live runtime) the
 * truthful states are `idle` / `ended` / `awaiting` (the last persisted to
 * disk); `running` and live `awaiting` are only emitted for a booted scope.
 */
export type SyncRosterChatStatus = "running" | "awaiting" | "idle" | "ended" | "failed";

export type SyncRosterChat = {
  id: string; // sessionId
  laneId: string;
  /** Parent chat/session id for attached shell rows. Mirrors TerminalSessionSummary.chatSessionId. */
  chatSessionId?: string | null;
  title?: string | null;
  provider?: string | null;
  model?: string | null;
  toolType?: string | null; // distinguishes chat vs CLI rows
  status: SyncRosterChatStatus;
  awaitingInput?: boolean;
  pinned?: boolean;
  archived?: boolean;
  lastActivityAt?: string | null;
  preview?: string | null; // last-output preview, hard-truncated (~120 chars)
  /**
   * Additive settled-lifecycle projection. Optional so current phones remain
   * compatible with older hosts and current hosts remain compatible with older
   * phones. `exitCode` is needed to distinguish clean ends from failures.
   */
  settledAt?: string | null;
  statusNote?: string | null;
  attentionRequestedAt?: string | null;
  attentionMessage?: string | null;
  lastTurnFailedAt?: string | null;
  exitCode?: number | null;
};

export type SyncRosterLane = {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  laneType?: string | null;
  branchRef?: string | null;
};

export type SyncRosterProject = {
  projectId: string;
  rootPath?: string | null;
  displayName: string;
  iconDataUrl?: string | null;
  lastOpenedAt?: string | null;
  /** true ⇒ live running/awaiting fidelity; false ⇒ disk-derived status only. */
  booted: boolean;
  runningCount: number;
  /** awaiting-input + failed sessions — drives the hub attention bubbles. */
  attentionCount: number;
  lanes: SyncRosterLane[];
  chats: SyncRosterChat[];
};

/** Full roster snapshot — sent on subscribe and on resync. */
export type SyncRosterSnapshotPayload = {
  seq: number;
  projects: SyncRosterProject[];
};

/**
 * Incremental roster update. `changed` upserts whole project entries (per-project
 * delta granularity — simple and cheap since a project's row set is small);
 * `removed` lists projectIds no longer present.
 */
export type SyncRosterDeltaPayload = {
  seq: number;
  changed?: SyncRosterProject[];
  removed?: string[];
};

export type SyncRosterSubscribePayload = {
  /** Last seq the client holds; lets the host send a delta instead of a snapshot. */
  sinceSeq?: number | null;
};

export type SyncRosterUnsubscribePayload = Record<string, never>;

export type SyncProjectSwitchRequestPayload = {
  projectId?: string | null;
  rootPath?: string | null;
};

export type SyncProjectForgetRequestPayload = {
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

export type SyncProjectForgetResultPayload = {
  ok: boolean;
  message?: string | null;
  projectId?: string | null;
  rootPath?: string | null;
};

export type SyncProjectOpenRequestPayload = {
  rootPath?: string | null;
};

export type SyncProjectBrowseResultPayload = {
  ok: boolean;
  message?: string | null;
  result?: ProjectBrowseResult | null;
};

export type SyncProjectDefaultParentDirPayload = {
  ok: boolean;
  message?: string | null;
  parentDir?: string | null;
};

export type SyncProjectActionResultPayload = {
  ok: boolean;
  message?: string | null;
  project?: SyncMobileProjectSummary | null;
};

export type SyncProjectListMyGitHubReposResultPayload = {
  ok: boolean;
  message?: string | null;
  result?: ListMyGitHubReposResult | null;
};

/**
 * Device-bound proof-of-possession attached to a paired hello. The phone keeps
 * a P-256 private key in the Secure Enclave; pairing registers the public key
 * with the host, and every connection signs a fresh challenge. A stolen paired
 * secret without the enclave key is useless once the key is on record.
 */
export type SyncDpopProof = {
  /**
   * Base64 X9.63 (04 || X || Y) P-256 public key. Sent while upgrading a
   * legacy pairing record that has no key yet; ignored once a key is stored.
   */
  publicKey?: string | null;
  /** Unix seconds; the host rejects proofs outside a small skew window. */
  timestamp: number;
  /** Random single-use value; the host keeps a short replay cache. */
  nonce: string;
  /** Base64 DER ECDSA-SHA256 signature over the canonical challenge string. */
  signature: string;
};

/**
 * Host-issued lease for a Relay-origin sync connection. Timestamps are Unix
 * epoch milliseconds. Capable clients refresh at or after `refreshAfter` and
 * the host keeps the socket open through `expiresAt + graceMs` while transient
 * token-verifier failures are retried.
 */
export type SyncRelayAuthorizationLease = {
  expiresAt: number;
  refreshAfter: number;
  challenge: string;
  graceMs: number;
};

/**
 * Device-bound refresh of the short-lived Relay account proof. The signature
 * covers `ade-relay-reauth-v1`, deviceId, SHA-256 of the exact token bytes,
 * the connection challenge, timestamp, and nonce in that order.
 */
export type SyncRelayReauthorizePayload = {
  deviceId: string;
  relayAccountToken: string;
  proof: SyncDpopProof;
};

export type SyncRelayReauthorizeResultPayload =
  | {
      ok: true;
      relayAuthorization: SyncRelayAuthorizationLease;
    }
  | {
      ok: false;
      error: {
        code:
          | "invalid_request"
          | "invalid_proof"
          | "stale_proof"
          | "replayed_nonce"
          | "relay_account_changed"
          | "token_expired"
          | "token_not_advanced"
          | "token_too_short"
          | "verification_failed";
        message: string;
        retryable: boolean;
      };
    };

export type SyncHelloAuth =
  | { kind: "bootstrap"; token: string }
  | {
      kind: "paired";
      deviceId: string;
      secret: string;
      dpop?: SyncDpopProof | null;
      /** Short-lived Clerk proof sent only over an ADE Relay connection. */
      relayAccountToken?: string | null;
    }
  | {
      kind: "account";
      deviceId: string;
      accountToken: string;
      dpop?: SyncDpopProof | null;
      /** Optional legacy one-time desktop runtime authorization. */
      runtimeHostGrant?: string | null;
    }
  | {
      kind: "account_sealed";
      v: 1;
      deviceId: string;
      sealed: string;
    };

export type SyncAccountChallengePayload = {
  v: 1;
  nonce: string;
  clientEphemeralPublicKey: string;
  supportedAeads?: string[];
};

export type SyncAccountChallengeOkPayload = {
  v: 1;
  hostDeviceId: string;
  ts: number;
  hostEphemeralPublicKey: string;
  signature: string;
  aead?: string;
};

export type SyncAccountChallengeErrorPayload = {
  message: string;
};

export type SyncSealedHelloOkPayload = {
  v: 1;
  sealed: string;
};

export type SyncHelloOkPayload = {
  peer: SyncPeerMetadata;
  brain: SyncPeerMetadata;
  serverDbVersion: number;
  /**
   * Transport observed by the authenticated host. Clients may race several
   * advertised routes, so this is the source of truth for whether the winning
   * socket actually traversed ADE Relay.
   */
  connectionTransport?: "direct" | "relay";
  /**
   * cr-sqlite site id of the project DB this host is currently serving.
   * Clients key their inbound changeset cursor on it so a cursor built
   * against one project's DB is never replayed against another's.
   */
  serverDbSiteId?: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  /**
   * Present only when hello offered a mutually supported application codec.
   * Its absence preserves the exact legacy compression behavior.
   */
  compression?: {
    codec: SyncApplicationCompressionCodec;
    thresholdBytes: number;
  };
  projects?: SyncMobileProjectSummary[];
  features: SyncFeatureFlags;
  /**
   * Full `wss://…/connect/<machineKey>` cloud tunnel-relay URL for this
   * machine, when the relay is enabled. Lets phones that paired before the
   * relay existed (or via discovery + PIN, where no QR carried it) learn the
   * off-LAN route over the live connection and persist it for reconnects.
   */
  cloudRelayWssUrl?: string | null;
  /** Present only for capable clients authenticated through ADE Relay. */
  relayAuthorization?: SyncRelayAuthorizationLease;
  /**
   * Fresh paired credential minted only when a verified account hello adopts a
   * genuinely new device. Existing devices keep their stored pairing record,
   * and the host omits this field so reconnects cannot rotate their secret.
   */
  accountPairing?: {
    deviceId: string;
    secret: string;
  };
};

type SyncHelloErrorHost = {
  /**
   * Identity of the machine that rejected this hello. Lets a client tell
   * "the machine I'm paired with revoked this device" (safe to drop the
   * saved pairing) apart from "a different machine answered on a reused
   * address" (keep the pairing and try other routes). Older hosts omit it,
   * in which case clients must treat the rejection as unattributed and
   * never destroy saved credentials over it.
   */
  host?: {
    deviceId: string;
    name?: string;
  };
};

export type SyncHelloErrorPayload =
  | (SyncHelloErrorHost & {
      /**
       * `repair_required` is the one rejection the user can act on directly:
       * the host has no usable pairing record for this device, so the fix is to
       * pair again. Clients must classify from this code and never by matching
       * the host-sent message text.
       *
       * The two codes below it exist because `auth_failed` reads as "pair it
       * again" on every client, and that is the wrong instruction for a host
       * that simply cannot verify accounts yet (`host_update_required` — update
       * it there) or whose account session moved under the handshake
       * (`account_session_changed` — sign in, then retry). Neither is a reason
       * to destroy a saved pairing.
       */
      code:
        | "auth_failed"
        | "repair_required"
        | "host_update_required"
        | "account_session_changed"
        | "invalid_hello"
        | "relay_account_required"
        | "connection_attempt_superseded";
      message: string;
    })
  | (SyncHelloErrorHost & {
      code: "protocol_version_mismatch";
      message: string;
      receivedVersion: number;
      currentVersion: number;
      minSupportedVersion: number;
      updateTarget: "client" | "host";
    });

export type SyncAddressCandidateKind = "lan" | "saved" | "tailscale" | "loopback" | "relay";

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

export type SyncWebPairingInfo = {
  pairingUrl: string;
  code: string | null;
  pinConfigured: boolean;
  machineName: string;
  relayEnabled: boolean;
  hasRelayCandidate: boolean;
};

/** Machine-level cloud tunnel relay identity and connection posture. */
export type SyncCloudRelayStatus = {
  /** `wss://…/connect/<machineKey>` — what phones dial. */
  relayWssUrl: string;
  machineKey: string;
  /** http(s) base URL of the relay worker. */
  relayUrl: string;
  connected: boolean;
  activeTunnels: number;
  relayBridgeValidated: boolean;
  lastFailureAt: string | null;
  lastControlOpenAt: string | null;
  lastBridgeValidationAt: string | null;
  lastControlError: string | null;
  lastError: string | null;
};

/**
 * Payload behind the desktop pairing QR: a single smart URL
 * (`https://ade-app.dev/pair#<base64url(JSON)>`) carrying everything the phone
 * needs to find the machine. The PIN is never embedded — the user still types
 * it, so a photographed QR alone cannot pair a device. The payload rides the
 * URL fragment so it never reaches any web server's logs.
 */
export type SyncPairingQrPayload = {
  version: 3;
  hostIdentity: SyncPairingHostIdentity;
  port: number;
  addressCandidates: SyncAddressCandidate[];
  /** Full wss:// URL of the cloud tunnel relay, when the user enabled it. */
  relayUrl?: string | null;
  /** Reserved for off-LAN pairing claims once the relay pairing flow ships. */
  claimToken?: string | null;
  /** One-time host-issued authorization for desktop runtime RPC/forwarding. */
  runtimeHostGrant?: string | null;
};

export type SyncPairingRequestPayload = {
  code: string;
  peer: SyncPeerMetadata;
  /**
   * Version 1 clients persist a replacement secret before hello and explicitly
   * commit it after hello_ok. Older hosts ignore this field; older clients omit
   * it and retain the host's hello-as-commit compatibility path.
   */
  pairingCommitVersion?: 1;
  /**
   * Short-lived account bearer presented only when this request crosses ADE
   * Relay. The host verifies that it belongs to its current signed-in user;
   * direct LAN and tailnet pairing never require or receive it.
   */
  relayAccountToken?: string | null;
  /**
   * Base64 X9.63 P-256 public key of the device's Secure Enclave DPoP key.
   * Stored with the pairing record so later hellos must prove possession.
   */
  dpopPublicKey?: string | null;
  /**
   * Short-lived, one-time server grant from a desktop-specific pairing link.
   * A PIN and client-asserted desktop metadata alone never authorize runtime
   * RPC or port forwarding.
   */
  runtimeHostGrant?: string | null;
};

export type SyncPairingResultPayload = {
  ok: boolean;
  deviceId?: string;
  secret?: string;
  /**
   * Advisory. Present only when this was a RE-pair that the host staged behind
   * the device's existing secret. Commit-capable clients keep that older secret
   * valid until `pairing_commit` follows hello_ok; legacy clients use
   * hello-as-commit. Hosts predating staged rotation never send this field.
   */
  rotation?: {
    pendingCommit: true;
    expiresInMs: number;
  };
  error?: {
    code:
      | "invalid_pin"
      | "pin_not_set"
      | "relay_account_required"
      | "pairing_failed";
    message: string;
  };
};

export type SyncPairingCommitPayload = {
  deviceId: string;
};

export type SyncPairingCommitResultPayload = {
  ok: boolean;
  error?: {
    code: "no_pending_rotation" | "pairing_commit_failed";
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

export const CRSQL_EXPORT_VERSION_GROUP_TOO_LARGE_CODE = "crsql_export_version_group_too_large";

/**
 * Compact live-change hint for an invalidation-only browser. The browser has
 * no CRR replica and therefore needs table names, never row values. When a
 * table list cannot be represented inside the hard protocol bounds, the host
 * sends `fullRefresh: true` and the browser invalidates every owned domain.
 */
export type SyncInvalidationBatchPayload = {
  fromDbVersion: number;
  toDbVersion: number;
  tables: string[];
  fullRefresh: boolean;
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
  | { action: "listTreeChildren"; args: { workspaceId: string; parentPath: string; offset?: number; limit?: number; includeIgnored?: boolean } }
  | { action: "refreshGitDecorations"; args: { workspaceId: string; forceFresh?: boolean } }
  | { action: "readFile"; args: { workspaceId: string; path: string } }
  | { action: "readFileRange"; args: { workspaceId: string; path: string; offset: number; length?: number } }
  | { action: "gitBlame"; args: { workspaceId: string; path: string; startLine?: number; endLine?: number } }
  | { action: "writeText"; args: { workspaceId: string; path: string; text: string } }
  | { action: "createFile"; args: { workspaceId: string; path: string; content?: string } }
  | { action: "createDirectory"; args: { workspaceId: string; path: string } }
  | { action: "rename"; args: { workspaceId: string; oldPath: string; newPath: string } }
  | { action: "deletePath"; args: { workspaceId: string; path: string } }
  | { action: "watchChanges"; args: { workspaceId: string; includeIgnored?: boolean } }
  | { action: "stopWatching"; args: { workspaceId: string; includeIgnored?: boolean } }
  | { action: "quickOpen"; args: { workspaceId: string; query: string; limit?: number; includeIgnored?: boolean } }
  | { action: "searchText"; args: { workspaceId: string; query: string; limit?: number; includeIgnored?: boolean } }
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
  /**
   * Stable id for this input operation. Hosts advertising terminalInputAck
   * write each id at most once per device/session/retry window and ACK every
   * accepted first delivery, duplicate retry, or terminal rejection. Reusing
   * an id with different data is a protocol conflict.
   */
  inputId?: string;
};

export type SyncTerminalInputAckErrorCode =
  | "invalid_input_id"
  | "not_subscribed"
  | "session_not_live"
  | "project_mismatch"
  | "input_id_conflict"
  | "dedupe_capacity";

export type SyncTerminalInputAckPayload =
  | {
      sessionId: string;
      inputId: string;
      ok: true;
      /** True when this ACK answers a retry whose exact input was already written. */
      duplicate: boolean;
    }
  | {
      sessionId: string | null;
      /** Omitted only when the supplied id was not a bounded non-empty string. */
      inputId?: string;
      ok: false;
      duplicate: false;
      error:
        | {
            /** Re-subscribe, then resend the exact same inputId and bytes. */
            code: "not_subscribed";
            message: string;
            retryable: true;
          }
        | {
            code: Exclude<SyncTerminalInputAckErrorCode, "not_subscribed">;
            message: string;
            retryable: false;
          };
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
  /** Machine-owned chat stream. Personal chat subscribes never require project fields. */
  chatScope?: "project" | "personal";
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
  /**
   * Cross-project "quick look" override. When present and identifying a
   * registered project OTHER than the one this sync socket is scoped to, the
   * host serves this session's transcript + live events from that foreign
   * project read-only (no project switch, no runtime boot) — see the
   * `crossProjectChat` feature flag. Absent for ordinary same-project
   * subscribes, which stay scoped to the socket's active project.
   */
  projectId?: string;
  projectRootPath?: string;
};

export type SyncChatSubscribeSnapshotPayload = {
  sessionId: string;
  capturedAt: string;
  truncated: boolean;
  /** Logical byte cursor for the first event represented by this tail. */
  tailStartOffset?: number;
  /** Authoritative older-page availability for this snapshot. */
  hasOlderHistory?: boolean;
  /** Additive cursor discriminator for future non-file transcript stores. */
  cursorKind?: "byte";
  events: AgentChatEventEnvelope[];
  /**
   * True when the host honored `sinceSeq` and replayed buffered events
   * instead of producing a snapshot. `events` is empty in that case — the
   * replayed history arrives as ordinary `chat_event` envelopes. Clients must
   * reset any stored seq watermark when this is absent/false because the host
   * is providing an authoritative snapshot rather than proving a gap-free
   * replay. Current hosts keep seq monotonic across host rehydration; resetting
   * remains safe and preserves compatibility with older hosts that used epochs.
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
  /** Mirrors SyncChatSubscribePayload.chatScope. */
  chatScope?: "project" | "personal";
  /** Cross-project override, mirrors SyncChatSubscribePayload.projectId. */
  projectId?: string;
  projectRootPath?: string;
};

export type SyncChatHistoryRequestPayload = SyncChatUnsubscribePayload & {
  beforeOffset: number;
  maxBytes?: number;
};

export type SyncChatHistoryResponsePayload = AgentChatEventHistoryPage;

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
  /** Mirrors `SyncHelloOkPayload.cloudRelayWssUrl` for connected clients. */
  cloudRelayWssUrl?: string | null;
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
  fastMode?: boolean | null;
  /** @deprecated Use fastMode. Accepted for older callers. */
  codexFastMode?: boolean | null;
};

export type SyncStartCliSessionResult = {
  sessionId: string;
  ptyId: string | null;
  session: TerminalSessionSummary | null;
};

export type SyncListExternalSessionsArgs = ExternalSessionListArgs;
export type SyncListExternalSessionsResult = ExternalSessionSummary[];

export type SyncImportExternalSessionArgs = ExternalSessionImportArgs;
export type SyncImportExternalSessionResult = ExternalSessionImportResult;

export type SyncSendToSessionArgs = {
  sessionId: string;
  text: string;
  cols?: number | null;
  rows?: number | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  permissionMode?: AgentChatPermissionMode | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy | null;
  codexSandbox?: AgentChatCodexSandbox | null;
  codexConfigSource?: AgentChatCodexConfigSource | null;
};

export type SyncSendToSessionResult = PtySendToSessionResult;

export type CtoStartLinearMobileOAuthArgs = Record<string, never>;

export type CtoStartLinearMobileOAuthResult = {
  sessionId: string;
  authorizeUrl: string;
  expiresAt: string;
};

export type CtoCompleteLinearMobileOAuthArgs = {
  sessionId: string;
  code: string;
  state: string;
};

export type CtoCompleteLinearMobileOAuthResult = LinearConnectionStatus;

export type CtoSetLinearTokenSyncArgs = {
  token: string;
};

export type CtoSetLinearTokenResult = LinearConnectionStatus;

export type CtoClearLinearTokenArgs = Record<string, never>;

export type CtoClearLinearTokenResult = LinearConnectionStatus;

export type SyncRemoteCommandAction =
  | "analytics.capture"
  | "analytics.flush"
  | "analytics.getStatus"
  | "analytics.setClientEnabled"
  | "usage.getAdeStats"
  | "usage.getQuotaSnapshot"
  | "usage.refreshQuota"
  | PersonalChatRemoteCommandAction
  | "lanes.list"
  | "lanes.listDeleteProgress"
  | "lanes.presence.announce"
  | "lanes.presence.release"
  | "lanes.refreshSnapshots"
  | "lanes.getDetail"
  | "lanes.create"
  | "lanes.suggestName"
  | "lanes.createChild"
  | "lanes.createFromUnstaged"
  | "lanes.importBranch"
  | "lanes.previewBranchSwitch"
  | "lanes.getBranchDrift"
  | "lanes.resolveBranchDrift"
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
  | "lanes.saveTemplate"
  | "lanes.deleteTemplate"
  | "lanes.setDefaultTemplate"
  | "lanes.getDeleteRisk"
  | "lanes.getReclaimRisk"
  | "lanes.initEnv"
  | "lanes.getEnvStatus"
  | "lanes.applyTemplate"
  | "work.getSession"
  | "work.deleteSession"
  | "work.getSessionDelta"
  | "work.listSessions"
  | "work.updateSessionMeta"
  // Session-lifecycle mutations live under their own `session.*` namespace —
  // the same domain name the ADE action registry uses — because mobile and the
  // web client feature-detect them independently of the `work.*` read surface.
  | "session.settleSession"
  | "session.unsettleSession"
  | "session.settleSessions"
  | "session.unsettleSessions"
  | "session.snoozeSession"
  | "session.snoozeSessions"
  | "session.wakeSession"
  | "session.wakeSessions"
  | "session.setSettleOverride"
  | "session.clearWokeMarker"
  | "work.runQuickCommand"
  | "work.startCliSession"
  | "work.resumeCliSession"
  | "work.listExternalSessions"
  | "work.importExternalSession"
  | "work.sendToSession"
  | "work.stopRuntime"
  | "chat.getSlashCommands"
  | "chat.resolveSmartLinkPreview"
  | "chat.getParallelLaunchState"
  | "chat.setParallelLaunchState"
  | "chat.handoff"
  | "chat.prepareCrossMachineHandoff"
  | "chat.validateCrossMachineSource"
  | "chat.preflightCrossMachineDestination"
  | "chat.fastForwardCrossMachineHandoffLane"
  | "chat.acceptCrossMachineHandoff"
  | "chat.markCrossMachineHandoff"
  | "chat.getContextUsage"
  | "chat.rewindFiles"
  | "chat.getTurnFileDiff"
  | "chat.saveTempAttachment"
  | "chat.warmupModel"
  | "chat.launch"
  | "chat.launchCli"
  | "chat.generateAutoLaneIdentity"
  | "chat.getImageDataUrl"
  | "chat.listSessions"
  | "chat.getSummary"
  | "chat.createScheduledWork"
  | "chat.listScheduledWork"
  | "chat.cancelScheduledWork"
  | "chat.setScheduledWorkPaused"
  | "chat.getTranscript"
  | "chat.getChatEventHistory"
  | "chat.listSubagents"
  | "chat.getSubagentTranscript"
  | "chat.getMainTranscript"
  | "chat.create"
  | "chat.send"
  | "chat.interrupt"
  | "chat.recoverCodexTurn"
  | "chat.recoverTurn"
  | "chat.resolveUnprocessedMessage"
  | "chat.steer"
  | "chat.cancelSteer"
  | "chat.editSteer"
  | "chat.dispatchSteer"
  | "chat.cancelDispatchedSteer"
  | "chat.interruptWithQueueMode"
  | "chat.restoreCancelledQueue"
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
  | "cto.ensureSession"
  | "cto.getState"
  | "cto.getMemory"
  | "cto.getAttention"
  | "cto.getLinearConnectionStatus"
  | "cto.startLinearMobileOAuth"
  | "cto.completeLinearMobileOAuth"
  | "cto.setLinearToken"
  | "cto.clearLinearToken"
  | "cto.getLinearQuickView"
  | "cto.getLinearIssuePickerData"
  | "cto.searchLinearIssues"
  | "cto.getLinearIssueComments"
  | "cto.updateIdentity"
  | "git.getChanges"
  | "git.getFile"
  | "git.getFilePatch"
  | "git.getUserIdentity"
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
  | "git.getCommit"
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
  | "git.stashClear"
  | "git.fetch"
  | "git.pull"
  | "git.undoLastHeadChange"
  | "git.redoLastHeadChange"
  | "git.getSyncStatus"
  | "git.getOriginRemote"
  | "git.getOpenPrForBranch"
  | "git.sync"
  | "git.push"
  | "git.getConflictState"
  | "git.rebaseContinue"
  | "git.rebaseAbort"
  | "git.mergeContinue"
  | "git.mergeAbort"
  | "git.listBranches"
  | "git.checkoutBranch"
  | "terminal.list"
  | "terminal.activeForChat"
  | "conflicts.getLaneStatus"
  | "conflicts.listOverlaps"
  | "conflicts.getBatchAssessment"
  | "rebase.scanNeeds"
  | "rebase.execute"
  | "history.listOperations"
  | "github.getStatus"
  | "github.getRemoteStatus"
  | "github.publishCurrentProject"
  | "projectConfig.get"
  | "projectConfig.save"
  | "ai.getStatus"
  | "ai.updateConfig"
  | "ai.deleteApiKey"
  | "orchestration.runCreate"
  | "prs.list"
  | "prs.listOpenForRepo"
  | "prs.refresh"
  | "prs.getForLane"
  | "prs.syncLanePr"
  | "prs.reconcileOnFocus"
  | "prs.getDetail"
  | "prs.postReviewComment"
  | "prs.getAiSummary"
  | "prs.regenerateAiSummary"
  | "prs.getIntegrationResolutionState"
  | "prs.delete"
  | "prs.cleanupBranch"
  | "prs.listProposals"
  | "prs.getMergeContext"
  | "prs.getMergeContexts"
  | "prs.listWithConflicts"
  | "prs.listSnapshots"
  | "prs.getStatus"
  | "prs.getChecks"
  | "prs.getReviews"
  | "prs.getComments"
  | "prs.getFiles"
  | "prs.getGitHubSnapshot"
  | "prs.getReviewThreads"
  | "prs.getActionRuns"
  | "prs.getActivity"
  | "prs.getWorkflowGraph"
  | "prs.getCheckLog"
  | "prs.getDeployments"
  | "prs.getDetailByGithub"
  | "prs.getFilesByGithub"
  | "prs.getCommitsByGithub"
  | "prs.getActionRunsByGithub"
  | "prs.getActivityByGithub"
  | "prs.getStatusByGithub"
  | "prs.getChecksByGithub"
  | "prs.getReviewsByGithub"
  | "prs.getCommentsByGithub"
  | "prs.getReviewThreadsByGithub"
  | "prs.listGithubStacks"
  | "prs.syncGithubStacks"
  | "prs.createFromLane"
  | "prs.createGithubStack"
  | "prs.addGithubStackPullRequests"
  | "prs.unstackGithubStack"
  | "prs.linkToLane"
  | "prs.preflightCreateLaneFromPrBranch"
  | "prs.createLaneFromPrBranch"
  | "prs.draftDescription"
  | "prs.land"
  | "prs.updateBranch"
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
  | "prs.aiResolutionGetSession"
  | "prs.aiResolutionStart"
  | "prs.recheckIntegrationStep"
  | "prs.getMobileSnapshot"
  | "prs.getMobileGithubDetail"
  | "attention.getMachineSnapshot"
  | "attention.acknowledgeMachine"
  | "sync.getWebPairingInfo"
  | "sync.getDesktopPairingInfo"
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
      compression: "gzip" | "deflate";
      payloadEncoding: "base64";
      payload: string;
      uncompressedBytes: number;
    });

export type SyncHelloEnvelope = SyncEnvelopeWithPayload<"hello", SyncHelloPayload>;
export type SyncHelloOkEnvelope = SyncEnvelopeWithPayload<
  "hello_ok",
  SyncHelloOkPayload | SyncSealedHelloOkPayload
>;
export type SyncHelloErrorEnvelope = SyncEnvelopeWithPayload<"hello_error", SyncHelloErrorPayload>;
export type SyncAccountChallengeEnvelope = SyncEnvelopeWithPayload<
  "account_challenge",
  SyncAccountChallengePayload
>;
export type SyncAccountChallengeOkEnvelope = SyncEnvelopeWithPayload<
  "account_challenge_ok",
  SyncAccountChallengeOkPayload
>;
export type SyncAccountChallengeErrorEnvelope = SyncEnvelopeWithPayload<
  "account_challenge_error",
  SyncAccountChallengeErrorPayload
>;
export type SyncRelayReauthorizeEnvelope = SyncEnvelopeWithPayload<"relay_reauthorize", SyncRelayReauthorizePayload>;
export type SyncRelayReauthorizeResultEnvelope = SyncEnvelopeWithPayload<"relay_reauthorize_result", SyncRelayReauthorizeResultPayload>;
export type SyncProjectCatalogRequestEnvelope = SyncEnvelopeWithPayload<"project_catalog_request", Record<string, never>>;
export type SyncProjectCatalogEnvelope = SyncEnvelopeWithPayload<"project_catalog", SyncProjectCatalogPayload>;
export type SyncProjectCatalogChunkEnvelope = SyncEnvelopeWithPayload<"project_catalog_chunk", SyncProjectCatalogChunkPayload>;
export type SyncProjectSwitchRequestEnvelope = SyncEnvelopeWithPayload<"project_switch_request", SyncProjectSwitchRequestPayload>;
export type SyncProjectSwitchResultEnvelope = SyncEnvelopeWithPayload<"project_switch_result", SyncProjectSwitchResultPayload>;
export type SyncProjectForgetRequestEnvelope = SyncEnvelopeWithPayload<"project_forget_request", SyncProjectForgetRequestPayload>;
export type SyncProjectForgetResultEnvelope = SyncEnvelopeWithPayload<"project_forget_result", SyncProjectForgetResultPayload>;
export type SyncProjectBrowseRequestEnvelope = SyncEnvelopeWithPayload<"project_browse_request", ProjectBrowseInput>;
export type SyncProjectBrowseResultEnvelope = SyncEnvelopeWithPayload<"project_browse_result", SyncProjectBrowseResultPayload>;
export type SyncProjectDefaultParentDirRequestEnvelope = SyncEnvelopeWithPayload<"project_default_parent_dir_request", Record<string, never>>;
export type SyncProjectDefaultParentDirEnvelope = SyncEnvelopeWithPayload<"project_default_parent_dir", SyncProjectDefaultParentDirPayload>;
export type SyncProjectOpenRequestEnvelope = SyncEnvelopeWithPayload<"project_open_request", SyncProjectOpenRequestPayload>;
export type SyncProjectOpenResultEnvelope = SyncEnvelopeWithPayload<"project_open_result", SyncProjectActionResultPayload>;
export type SyncProjectCreateRequestEnvelope = SyncEnvelopeWithPayload<"project_create_request", CreateProjectInput>;
export type SyncProjectCreateResultEnvelope = SyncEnvelopeWithPayload<"project_create_result", SyncProjectActionResultPayload>;
export type SyncProjectCloneRequestEnvelope = SyncEnvelopeWithPayload<"project_clone_request", CloneProjectInput>;
export type SyncProjectCloneResultEnvelope = SyncEnvelopeWithPayload<"project_clone_result", SyncProjectActionResultPayload>;
export type SyncProjectListMyGitHubReposRequestEnvelope = SyncEnvelopeWithPayload<"project_list_my_github_repos_request", ListMyGitHubReposInput>;
export type SyncProjectListMyGitHubReposResultEnvelope = SyncEnvelopeWithPayload<"project_list_my_github_repos_result", SyncProjectListMyGitHubReposResultPayload>;
export type SyncPairingRequestEnvelope = SyncEnvelopeWithPayload<"pairing_request", SyncPairingRequestPayload>;
export type SyncPairingResultEnvelope = SyncEnvelopeWithPayload<"pairing_result", SyncPairingResultPayload>;
export type SyncPairingCommitEnvelope = SyncEnvelopeWithPayload<"pairing_commit", SyncPairingCommitPayload>;
export type SyncPairingCommitResultEnvelope = SyncEnvelopeWithPayload<"pairing_commit_result", SyncPairingCommitResultPayload>;
export type SyncChangesetBatchEnvelope = SyncEnvelopeWithPayload<"changeset_batch", SyncChangesetBatchPayload>;
export type SyncInvalidationBatchEnvelope = SyncEnvelopeWithPayload<"invalidation_batch", SyncInvalidationBatchPayload>;
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
export type SyncTerminalInputAckEnvelope = SyncEnvelopeWithPayload<"terminal_input_ack", SyncTerminalInputAckPayload>;
export type SyncTerminalResizeEnvelope = SyncEnvelopeWithPayload<"terminal_resize", SyncTerminalResizePayload>;
export type SyncTerminalHistoryEnvelope = SyncEnvelopeWithPayload<"terminal_history", SyncTerminalHistoryRequestPayload | SyncTerminalHistoryResponsePayload>;
export type SyncChatSubscribeEnvelope = SyncEnvelopeWithPayload<"chat_subscribe", SyncChatSubscribePayload | SyncChatSubscribeSnapshotPayload>;
export type SyncChatUnsubscribeEnvelope = SyncEnvelopeWithPayload<"chat_unsubscribe", SyncChatUnsubscribePayload>;
export type SyncChatEventEnvelope = SyncEnvelopeWithPayload<"chat_event", SyncChatEventPayload>;
export type SyncChatHistoryEnvelope = SyncEnvelopeWithPayload<
  "chat_history",
  SyncChatHistoryRequestPayload | SyncChatHistoryResponsePayload
>;
export type SyncBrainStatusEnvelope = SyncEnvelopeWithPayload<"brain_status", SyncBrainStatusPayload>;
export type SyncPrsUpdatedEnvelope = SyncEnvelopeWithPayload<"prs_updated", { updatedAt: string }>;
export type SyncRosterSubscribeEnvelope = SyncEnvelopeWithPayload<"roster_subscribe", SyncRosterSubscribePayload>;
export type SyncRosterUnsubscribeEnvelope = SyncEnvelopeWithPayload<"roster_unsubscribe", SyncRosterUnsubscribePayload>;
export type SyncRosterSnapshotEnvelope = SyncEnvelopeWithPayload<"roster_snapshot", SyncRosterSnapshotPayload>;
export type SyncRosterDeltaEnvelope = SyncEnvelopeWithPayload<"roster_delta", SyncRosterDeltaPayload>;
export type SyncCommandEnvelope = SyncEnvelopeWithPayload<"command", SyncCommandPayload>;
export type SyncCommandAckEnvelope = SyncEnvelopeWithPayload<"command_ack", SyncCommandAckPayload>;
export type SyncCommandResultEnvelope = SyncEnvelopeWithPayload<"command_result", SyncCommandResultPayload>;
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
  | SyncAccountChallengeEnvelope
  | SyncAccountChallengeOkEnvelope
  | SyncAccountChallengeErrorEnvelope
  | SyncRelayReauthorizeEnvelope
  | SyncRelayReauthorizeResultEnvelope
  | SyncProjectCatalogRequestEnvelope
  | SyncProjectCatalogEnvelope
  | SyncProjectCatalogChunkEnvelope
  | SyncProjectSwitchRequestEnvelope
  | SyncProjectSwitchResultEnvelope
  | SyncProjectForgetRequestEnvelope
  | SyncProjectForgetResultEnvelope
  | SyncProjectBrowseRequestEnvelope
  | SyncProjectBrowseResultEnvelope
  | SyncProjectDefaultParentDirRequestEnvelope
  | SyncProjectDefaultParentDirEnvelope
  | SyncProjectOpenRequestEnvelope
  | SyncProjectOpenResultEnvelope
  | SyncProjectCreateRequestEnvelope
  | SyncProjectCreateResultEnvelope
  | SyncProjectCloneRequestEnvelope
  | SyncProjectCloneResultEnvelope
  | SyncProjectListMyGitHubReposRequestEnvelope
  | SyncProjectListMyGitHubReposResultEnvelope
  | SyncPairingRequestEnvelope
  | SyncPairingResultEnvelope
  | SyncPairingCommitEnvelope
  | SyncPairingCommitResultEnvelope
  | SyncChangesetBatchEnvelope
  | SyncInvalidationBatchEnvelope
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
  | SyncTerminalInputAckEnvelope
  | SyncTerminalResizeEnvelope
  | SyncTerminalHistoryEnvelope
  | SyncChatSubscribeEnvelope
  | SyncChatUnsubscribeEnvelope
  | SyncChatEventEnvelope
  | SyncChatHistoryEnvelope
  | SyncBrainStatusEnvelope
  | SyncPrsUpdatedEnvelope
  | SyncRosterSubscribeEnvelope
  | SyncRosterUnsubscribeEnvelope
  | SyncRosterSnapshotEnvelope
  | SyncRosterDeltaEnvelope
  | SyncCommandEnvelope
  | SyncCommandAckEnvelope
  | SyncCommandResultEnvelope
  | SyncEnvelopeChunkEnvelope
  | PairedRuntimeSyncEnvelope;
