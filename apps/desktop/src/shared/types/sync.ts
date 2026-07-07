import type { AgentChatEventEnvelope, AgentChatPermissionMode } from "./chat";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
} from "./core";
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
  projectCatalog: {
    enabled: boolean;
  };
  projectActions: {
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

export type SyncHelloAuth =
  | { kind: "bootstrap"; token: string }
  | { kind: "paired"; deviceId: string; secret: string; dpop?: SyncDpopProof | null };

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
  /**
   * Full `wss://…/connect/<machineKey>` cloud tunnel-relay URL for this
   * machine, when the relay is enabled. Lets phones that paired before the
   * relay existed (or via discovery + PIN, where no QR carried it) learn the
   * off-LAN route over the live connection and persist it for reconnects.
   */
  cloudRelayWssUrl?: string | null;
};

export type SyncHelloErrorPayload = {
  code: "auth_failed" | "invalid_hello";
  message: string;
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

/**
 * Machine-level cloud tunnel relay posture. Enabled by default so paired
 * phones stay reachable off LAN/tailnet with zero configuration: the brain
 * keeps an outbound tunnel registered and a `relay`-kind address candidate
 * (a full wss:// URL) is advertised to phones as the lowest-priority
 * transport. Settings > Sync keeps a single quiet kill-switch for operators
 * who never want traffic relayed.
 */
export type SyncCloudRelayStatus = {
  enabled: boolean;
  /** `wss://…/connect/<machineKey>` — what phones dial. */
  relayWssUrl: string;
  machineKey: string;
  /** http(s) base URL of the relay worker. */
  relayUrl: string;
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
};

export type SyncPairingRequestPayload = {
  code: string;
  peer: SyncPeerMetadata;
  /**
   * Base64 X9.63 P-256 public key of the device's Secure Enclave DPoP key.
   * Stored with the pairing record so later hellos must prove possession.
   */
  dpopPublicKey?: string | null;
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
  /** Cross-project override, mirrors SyncChatSubscribePayload.projectId. */
  projectId?: string;
  projectRootPath?: string;
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
  /**
   * Mirrors `SyncHelloOkPayload.cloudRelayWssUrl` so an already-connected
   * phone picks up a relay enable/disable flip without reconnecting.
   */
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
  | "lanes.suggestName"
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
  | "chat.getChatEventHistory"
  | "chat.listSubagents"
  | "chat.getSubagentTranscript"
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
  | "cto.ensureSession"
  | "cto.getState"
  | "cto.getMemory"
  | "cto.getLinearConnectionStatus"
  | "cto.getLinearQuickView"
  | "cto.getLinearIssuePickerData"
  | "cto.searchLinearIssues"
  | "cto.getLinearIssueComments"
  | "cto.updateIdentity"
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
  | "prs.getForLane"
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
  | "prs.getStatusByGithub"
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
  | SyncRosterSubscribeEnvelope
  | SyncRosterUnsubscribeEnvelope
  | SyncRosterSnapshotEnvelope
  | SyncRosterDeltaEnvelope
  | SyncCommandEnvelope
  | SyncCommandAckEnvelope
  | SyncCommandResultEnvelope
  | SyncEnvelopeChunkEnvelope;
