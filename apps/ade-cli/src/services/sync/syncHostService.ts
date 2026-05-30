import fs from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { Bonjour, type Service as BonjourService } from "bonjour-service";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import type {
  AgentChatEventEnvelope,
  CrsqlChangeRow,
  DeviceMarker,
  FileContent,
  FileTreeNode,
  FilesQuickOpenItem,
  FilesSearchTextMatch,
  FilesWorkspace,
  LaneDetailPayload,
  LaneListSnapshot,
  LaneSummary,
  PtyDataEvent,
  PtyExitEvent,
  SyncBrainStatusPayload,
  SyncChangesetAckPayload,
  SyncChangesetBatchPayload,
  SyncCommandAckPayload,
  SyncCommandPayload,
  SyncCommandResultPayload,
  SyncEnvelope,
  SyncChatSubscribeSnapshotPayload,
  SyncChatUnsubscribePayload,
  SyncFileBlob,
  SyncFileRequest,
  SyncFileResponsePayload,
  SyncHelloOkPayload,
  SyncHelloPayload,
  SyncMobileProjectSummary,
  SyncPairingRequestPayload,
  SyncPeerConnectionState,
  SyncPeerMetadata,
  SyncProjectCatalogChunkPayload,
  SyncProjectCatalogPayload,
  SyncProjectSwitchRequestPayload,
  SyncProjectSwitchResultPayload,
  SyncRemoteCommandDescriptor,
  SyncTailnetDiscoveryStatus,
  SyncTerminalSnapshotPayload,
} from "../../../../desktop/src/shared/types";
import { parseAgentChatTranscript } from "../../../../desktop/src/shared/chatTranscript";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { createCtoStateService } from "../../../../desktop/src/main/services/cto/ctoStateService";
import type { createFlowPolicyService } from "../../../../desktop/src/main/services/cto/flowPolicyService";
import type { createLinearCredentialService } from "../../../../desktop/src/main/services/cto/linearCredentialService";
import type { createLinearIngressService } from "../../../../desktop/src/main/services/cto/linearIngressService";
import type { createLinearIssueTracker } from "../../../../desktop/src/main/services/cto/linearIssueTracker";
import type { createLinearSyncService } from "../../../../desktop/src/main/services/cto/linearSyncService";
import type { createWorkerAgentService } from "../../../../desktop/src/main/services/cto/workerAgentService";
import type { createWorkerBudgetService } from "../../../../desktop/src/main/services/cto/workerBudgetService";
import type { createWorkerHeartbeatService } from "../../../../desktop/src/main/services/cto/workerHeartbeatService";
import type { createWorkerRevisionService } from "../../../../desktop/src/main/services/cto/workerRevisionService";
import type { createProjectConfigService } from "../../../../desktop/src/main/services/config/projectConfigService";
import type { createConflictService } from "../../../../desktop/src/main/services/conflicts/conflictService";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import type { createDiffService } from "../../../../desktop/src/main/services/diffs/diffService";
import type { createGitOperationsService } from "../../../../desktop/src/main/services/git/gitOperationsService";
import type { createAutoRebaseService } from "../../../../desktop/src/main/services/lanes/autoRebaseService";
import type { createLaneEnvironmentService } from "../../../../desktop/src/main/services/lanes/laneEnvironmentService";
import type { createLaneService } from "../../../../desktop/src/main/services/lanes/laneService";
import type { createLaneTemplateService } from "../../../../desktop/src/main/services/lanes/laneTemplateService";
import type { createPortAllocationService } from "../../../../desktop/src/main/services/lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../../../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { createProcessService } from "../../../../desktop/src/main/services/processes/processService";
import type { createPtyService } from "../../../../desktop/src/main/services/pty/ptyService";
import type { createIssueInventoryService } from "../../../../desktop/src/main/services/prs/issueInventoryService";
import type { PathToMergeOrchestrator } from "../../../../desktop/src/main/services/prs/pathToMergeOrchestrator";
import type { createPrService } from "../../../../desktop/src/main/services/prs/prService";
import type { createQueueLandingService } from "../../../../desktop/src/main/services/prs/queueLandingService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import type { createComputerUseArtifactBrokerService } from "../../../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { hasNullByte, normalizeRelative, nowIso, resolvePathWithinRoot, safeJsonParse, toOptionalString, uniqueStrings, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import type { DeviceRegistryService } from "./deviceRegistryService";
import { createSyncPairingStore } from "./syncPairingStore";
import type { NotificationEventBus } from "../../../../desktop/src/main/services/notifications/notificationEventBus";
import type {
  ApnsEnvironment,
  ApnsPushTokenKind,
  NotificationPreferences,
  SyncInAppNotificationPayload,
  SyncNotificationPrefsPayload,
  SyncRegisterPushTokenPayload,
  SyncSendTestPushPayload,
} from "../../../../desktop/src/shared/types/sync";
import { DEFAULT_NOTIFICATION_PREFERENCES, normalizeNotificationPreferences } from "../../../../desktop/src/shared/types/sync";
import type { SyncPinStore } from "./syncPinStore";
import { DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES, DEFAULT_SYNC_HOST_PORT, encodeSyncEnvelope, mapPlatform, parseSyncEnvelope, wsDataToText } from "./syncProtocol";
import { resolveTailscaleCliPath } from "./resolveTailscaleCliPath";
import { createSyncRemoteCommandService, type SyncRemoteCommandService } from "./syncRemoteCommandService";
const execFileAsync = promisify(execFile);
const DEFAULT_SYNC_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SYNC_HEARTBEAT_MISS_LIMIT = 2;
const MOBILE_SYNC_HEARTBEAT_MISS_LIMIT = 6;
const DEFAULT_SYNC_POLL_INTERVAL_MS = 400;
const DEFAULT_BRAIN_STATUS_INTERVAL_MS = 5_000;
const NATIVE_LAN_DISCOVERY_RECOVERY_DELAY_MS = 1_000;
const NATIVE_LAN_DISCOVERY_FALLBACK_MS = 30_000;
const DEFAULT_TERMINAL_SNAPSHOT_BYTES = 220_000;
const PEER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const MOBILE_COMMAND_RESULT_CACHE_TTL_MS = 30 * 60 * 1000;
const MOBILE_COMMAND_RESULT_CACHE_MAX_ENTRIES = 512;
const CHANGESET_ACK_TIMEOUT_MS = 10_000;
const MAX_CHANGESET_ACK_RETRIES = 6;
const LANE_PRESENCE_TTL_MS = 60_000;
const SYNC_MDNS_SERVICE_TYPE = "ade-sync";
const MAX_PROJECT_CATALOG_ENVELOPE_BYTES = 768 * 1024;
const BONJOUR_PROJECT_TXT_ENTRY_LIMIT = 24;
const BONJOUR_PROJECT_NAME_MAX_LENGTH = 48;
export const SYNC_TAILNET_DISCOVERY_SERVICE_NAME = "svc:ade-sync";
export const SYNC_TAILNET_DISCOVERY_SERVICE_PORT = DEFAULT_SYNC_HOST_PORT;
export type SyncRuntimeKind = "desktop-embedded" | "headless" | "remote-stdio" | "desktop" | "daemon" | "remote";
export type NativeLanDiscoveryProcess = {
  pid: number;
  ppid: number;
  command: string;
};
const MOBILE_MUTATING_FILE_ACTIONS = new Set<SyncFileRequest["action"]>([
  "writeText",
  "createFile",
  "createDirectory",
  "rename",
  "deletePath",
]);

type LanePresenceEntry = {
  marker: DeviceMarker;
  lastAnnouncedAtMs: number;
  source: "local" | "remote";
};

type PeerState = {
  ws: WebSocket;
  metadata: SyncPeerMetadata | null;
  authenticated: boolean;
  authKind: "bootstrap" | "paired" | null;
  pairedDeviceId: string | null;
  connectedAt: string;
  lastSeenAt: string;
  lastAppliedAt: string | null;
  lastKnownServerDbVersion: number;
  latencyMs: number | null;
  awaitingHeartbeatAt: string | null;
  missedHeartbeatCount: number;
  remoteAddress: string | null;
  remotePort: number | null;
  subscribedSessionIds: Set<string>;
  subscribedChatSessionIds: Set<string>;
  chatTranscriptOffsets: Map<string, number>;
  chatEventIdsSent: Map<string, Set<string>>;
  pendingChangesetBatch: PendingChangesetBatch | null;
};

type PendingChangesetBatch = {
  batchId: string;
  fromDbVersion: number;
  toDbVersion: number;
  changes: CrsqlChangeRow[];
  reason: SyncChangesetBatchPayload["reason"];
  sentAtMs: number;
  retryCount: number;
};

type CachedMobileCommandWaiter = {
  peer: PeerState;
  requestId: string | null;
};

type CachedMobileCommand = {
  commandId: string;
  action: string;
  argsKey: string;
  argsFingerprint: string;
  ack: SyncCommandAckPayload;
  result: SyncCommandResultPayload | null;
  waiters: CachedMobileCommandWaiter[];
  acceptedAtMs: number;
  completedAtMs: number | null;
};

type PersistedMobileCommand = {
  key: string;
  projectRoot: string;
  deviceId: string;
  commandId: string;
  action: string;
  argsFingerprint: string;
  ack: SyncCommandAckPayload;
  result: SyncCommandResultPayload;
  acceptedAtMs: number;
  completedAtMs: number;
};

export function selectChangesetBatchChunk(args: {
  changes: CrsqlChangeRow[];
  fromDbVersion: number;
  toDbVersion: number;
  maxRows: number;
  maxBytes: number;
}): { changes: CrsqlChangeRow[]; toDbVersion: number } | null {
  let chunk: CrsqlChangeRow[] = [];
  let chunkBytes = 0;
  let lastIncludedDbVersion: number | null = null;

  for (const change of args.changes) {
    const changeDbVersion = Number(change.db_version ?? args.fromDbVersion);
    const changeBytes = Buffer.byteLength(JSON.stringify(change), "utf8");
    // The host watermark is db_version-only, so rows sharing a db_version must ack together.
    if (
      chunk.length > 0
      && changeDbVersion !== lastIncludedDbVersion
      && (chunk.length >= args.maxRows || chunkBytes + changeBytes > args.maxBytes)
    ) {
      break;
    }
    chunk.push(change);
    chunkBytes += changeBytes;
    lastIncludedDbVersion = changeDbVersion;
  }

  if (chunk.length === 0 && args.changes.length > 0) {
    chunk = [args.changes[0]!];
    lastIncludedDbVersion = Number(chunk[0]!.db_version ?? args.fromDbVersion);
  }
  if (chunk.length === 0 && args.toDbVersion <= args.fromDbVersion) return null;

  const chunkToDbVersion = lastIncludedDbVersion ?? args.toDbVersion;
  return { changes: chunk, toDbVersion: chunkToDbVersion };
}

const PERSISTED_MOBILE_COMMAND_ACTIONS = new Set<string>([
  "lanes.presence.announce",
  "lanes.presence.release",
  "notification_prefs",
  "work.runQuickCommand",
  "work.startCliSession",
  "work.sendToSession",
  "work.stopRuntime",
  "processes.start",
  "processes.stop",
  "processes.kill",
  "chat.interrupt",
  "chat.approve",
  "chat.respondToInput",
  "chat.archive",
  "chat.unarchive",
  "chat.delete",
]);

function stableJsonValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = stableJsonValue(input[key]);
  }
  return output;
}

function stableJsonKey(value: unknown): string {
  return JSON.stringify(stableJsonValue(value)) ?? "null";
}

function mobileCommandArgsFingerprint(argsKey: string): string {
  return createHash("sha256").update(argsKey).digest("hex");
}

function safeObjectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function persistedMobileCommandResult(action: string, result: SyncCommandResultPayload): SyncCommandResultPayload | null {
  if (!PERSISTED_MOBILE_COMMAND_ACTIONS.has(action)) return null;
  if (!result.ok) {
    return {
      commandId: result.commandId,
      ok: false,
      error: {
        code: result.error?.code ?? "command_failed",
        message: "Command failed before reconnect.",
      },
    };
  }
  if (action === "work.runQuickCommand" || action === "work.startCliSession" || action === "work.sendToSession") {
    const raw = safeObjectValue(result.result);
    const replayResult: Record<string, unknown> = {};
    if (typeof raw?.sessionId === "string") replayResult.sessionId = raw.sessionId;
    if (typeof raw?.ptyId === "string") replayResult.ptyId = raw.ptyId;
    if ((action === "work.startCliSession" || action === "work.sendToSession") && safeObjectValue(raw?.session)) {
      replayResult.session = raw?.session;
    }
    return {
      commandId: result.commandId,
      ok: true,
      result: Object.keys(replayResult).length > 0 ? replayResult : { ok: true },
    };
  }
  return {
    commandId: result.commandId,
    ok: true,
    result: { ok: true },
  };
}

function mobileCommandCacheKey(projectScopeKey: string, peer: PeerState, commandId: string): string | null {
  const deviceId = peer.metadata?.deviceId ?? peer.pairedDeviceId;
  if (!deviceId || !commandId) return null;
  return `${projectScopeKey}:${deviceId}:${commandId}`;
}

function addMobileCommandWaiter(record: CachedMobileCommand, peer: PeerState, requestId: string | null): void {
  if (record.waiters.some((waiter) => waiter.peer === peer && waiter.requestId === requestId)) return;
  record.waiters.push({ peer, requestId });
}

type SyncHostServiceArgs = {
  db: AdeDb;
  logger: Logger;
  projectId?: string | null;
  projectRoot: string;
  fileService: ReturnType<typeof createFileService>;
  laneService: ReturnType<typeof createLaneService>;
  gitService?: ReturnType<typeof createGitOperationsService>;
  diffService?: ReturnType<typeof createDiffService>;
  conflictService?: ReturnType<typeof createConflictService>;
  prService: ReturnType<typeof createPrService>;
  issueInventoryService?: ReturnType<typeof createIssueInventoryService> | null;
  /** Optional Path-to-Merge orchestrator (forwarded to remote command service). */
  pathToMergeOrchestrator?: PathToMergeOrchestrator | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  processService?: ReturnType<typeof createProcessService>;
  agentChatService?: ReturnType<typeof createAgentChatService>;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  workerRevisionService?: ReturnType<typeof createWorkerRevisionService> | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  getLinearIngressService?: () => ReturnType<typeof createLinearIngressService> | null;
  getLinearIssueTracker?: () => ReturnType<typeof createLinearIssueTracker> | null;
  getLinearSyncService?: () => ReturnType<typeof createLinearSyncService> | null;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  portAllocationService?: ReturnType<typeof createPortAllocationService>;
  laneEnvironmentService?: ReturnType<typeof createLaneEnvironmentService>;
  laneTemplateService?: ReturnType<typeof createLaneTemplateService>;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService>;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService>;
  /**
   * Optional handler for the `deeplinks.open` sync command (iOS Send-to-Mac).
   * Desktop main.ts passes a wrapper that parses the URL + dispatches via the
   * renderer's navigation service.
   */
  dispatchDeeplinkUrl?: (url: string) => Promise<{ ok: boolean; message?: string }>;
  computerUseArtifactBrokerService: ReturnType<typeof createComputerUseArtifactBrokerService>;
  pinStore: SyncPinStore;
  bootstrapTokenPath?: string;
  pairingSecretsPath?: string;
  port?: number;
  discoveryEnabled?: boolean;
  runtimeKind?: SyncRuntimeKind;
  runtimeVersion?: string;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  brainStatusIntervalMs?: number;
  compressionThresholdBytes?: number;
  deviceRegistryService?: DeviceRegistryService;
  projectCatalogProvider?: {
    listProjects: () => Promise<SyncProjectCatalogPayload>;
    prepareProjectConnection: (args: SyncProjectSwitchRequestPayload) => Promise<SyncProjectSwitchResultPayload>;
    completeProjectConnection?: (
      args: SyncProjectSwitchRequestPayload,
      result: SyncProjectSwitchResultPayload,
    ) => Promise<void>;
  };
  onStateChanged?: () => void;
  notificationEventBus?: NotificationEventBus | null;
  remoteCommandService?: SyncRemoteCommandService;
  remoteCommandExecutor?: Pick<SyncRemoteCommandService, "execute">;
};

function sanitizeRemoteAddress(remoteAddress: string | null | undefined): string | null {
  const value = toOptionalString(remoteAddress);
  if (!value) return null;
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function ensureBootstrapToken(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, randomBytes(24).toString("hex"), { encoding: "utf8", mode: 0o600 });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore chmod failures on platforms that don't support it
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function inferMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".zip":
      return "application/zip";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return null;
  }
}

function fileContentToBlob(filePath: string, content: FileContent): SyncFileBlob {
  return {
    path: filePath,
    size: content.size,
    mimeType: content.mimeType ?? inferMimeType(filePath),
    encoding: content.encoding,
    isBinary: content.isBinary,
    content: content.content,
    languageId: content.languageId,
    ...(content.previewKind ? { previewKind: content.previewKind } : {}),
    ...(content.dataUrl ? { dataUrl: content.dataUrl } : {}),
    ...(typeof content.contentOmitted === "boolean" ? { contentOmitted: content.contentOmitted } : {}),
    ...(content.omittedReason ? { omittedReason: content.omittedReason } : {}),
  };
}

function createBlobFromBuffer(filePath: string, buf: Buffer): SyncFileBlob {
  const isBinary = hasNullByte(buf);
  return {
    path: filePath,
    size: buf.length,
    mimeType: inferMimeType(filePath),
    encoding: isBinary ? "base64" : "utf-8",
    isBinary,
    content: isBinary ? buf.toString("base64") : buf.toString("utf8"),
    languageId: null,
    previewKind: isBinary ? "binary" : "text",
  };
}

function toSyncPeerConnectionState(peer: PeerState, currentServerDbVersion: number): SyncPeerConnectionState | null {
  if (!peer.metadata) return null;
  return {
    ...peer.metadata,
    connectedAt: peer.connectedAt,
    lastSeenAt: peer.lastSeenAt,
    lastAppliedAt: peer.lastAppliedAt,
    remoteAddress: peer.remoteAddress,
    remotePort: peer.remotePort,
    latencyMs: peer.latencyMs,
    syncLag: Math.max(0, currentServerDbVersion - peer.lastKnownServerDbVersion),
    isBrain: false,
    isAuthenticated: peer.authenticated,
  };
}

export function syncHeartbeatMissLimitForPeerMetadata(metadata: Pick<SyncPeerMetadata, "platform" | "deviceType"> | null | undefined): number {
  return metadata?.platform === "iOS" || metadata?.deviceType === "phone"
    ? MOBILE_SYNC_HEARTBEAT_MISS_LIMIT
    : DEFAULT_SYNC_HEARTBEAT_MISS_LIMIT;
}

const SYNC_HOST_PROJECT_SCOPED_INBOUND_ENVELOPE_TYPES = new Set<SyncEnvelope["type"]>([
  "changeset_batch",
  "changeset_ack",
  "file_request",
  "terminal_subscribe",
  "terminal_unsubscribe",
  "terminal_input",
  "terminal_resize",
  "chat_subscribe",
  "chat_unsubscribe",
]);

type SyncHostProjectScopeResolution =
  | {
      ok: true;
      projectId: string | null;
      usedSingleProjectFallback: boolean;
    }
  | {
      ok: false;
      code: "project_not_open" | "project_mismatch";
      message: string;
      expectedProjectId: string | null;
      receivedProjectId: string | null;
    };

export function resolveSyncHostInboundProjectScope(
  type: SyncEnvelope["type"],
  receivedProjectId: string | null | undefined,
  hostProjectId: string | null | undefined,
): SyncHostProjectScopeResolution {
  if (!SYNC_HOST_PROJECT_SCOPED_INBOUND_ENVELOPE_TYPES.has(type)) {
    return { ok: true, projectId: null, usedSingleProjectFallback: false };
  }

  const received = toOptionalString(receivedProjectId);
  const host = toOptionalString(hostProjectId);
  if (!host) {
    return {
      ok: false,
      code: "project_not_open",
      message: "This ADE machine does not have a project open for phone sync.",
      expectedProjectId: null,
      receivedProjectId: received,
    };
  }
  if (!received) {
    return { ok: true, projectId: host, usedSingleProjectFallback: true };
  }
  if (received !== host) {
    return {
      ok: false,
      code: "project_mismatch",
      message: "This ADE machine is hosting a different project. Select the project again and retry.",
      expectedProjectId: host,
      receivedProjectId: received,
    };
  }
  return { ok: true, projectId: host, usedSingleProjectFallback: false };
}

export function buildSyncHostHelloOkPayload(args: {
  peer: SyncPeerMetadata;
  brain: SyncPeerMetadata;
  serverDbVersion: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  projectCatalog: SyncProjectCatalogPayload;
  projectCatalogEnabled: boolean;
  remoteCommandSupportedActions: string[];
  remoteCommandDescriptors: SyncRemoteCommandDescriptor[];
  localCommandDescriptors: SyncRemoteCommandDescriptor[];
  compressionThresholdBytes?: number;
  maxProjectCatalogEnvelopeBytes?: number;
}): SyncHelloOkPayload {
  const actions = [
    ...args.remoteCommandDescriptors,
    ...args.localCommandDescriptors,
  ];
  const payload: SyncHelloOkPayload = {
    peer: args.peer,
    brain: args.brain,
    serverDbVersion: args.serverDbVersion,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    pollIntervalMs: args.pollIntervalMs,
    projects: args.projectCatalog.projects,
    features: {
      fileAccess: true,
      terminalStreaming: true,
      chatStreaming: {
        enabled: true,
      },
      projectCatalog: {
        enabled: args.projectCatalogEnabled,
      },
      changesetAck: {
        enabled: true,
      },
      bootstrapAuth: true,
      pairingAuth: {
        enabled: true,
        pinDigits: 6,
      },
      commandRouting: {
        mode: "allowlisted",
        supportedActions: [
          ...args.remoteCommandSupportedActions,
          ...args.localCommandDescriptors.map((entry) => entry.action),
        ],
        actions,
      },
    },
  };
  const envelopeBytes = Buffer.byteLength(encodeSyncEnvelope({
    type: "hello_ok",
    payload,
    compressionThresholdBytes: args.compressionThresholdBytes,
  }), "utf8");
  return envelopeBytes <= (args.maxProjectCatalogEnvelopeBytes ?? MAX_PROJECT_CATALOG_ENVELOPE_BYTES)
    ? payload
    : { ...payload, projects: [] };
}

function parseHelloPayload(payload: unknown): SyncHelloPayload | null {
  const value = payload as SyncHelloPayload | null;
  const peer = value?.peer;
  if (!peer || typeof peer !== "object") return null;
  if (!toOptionalString(peer.deviceId) || !toOptionalString(peer.deviceName) || !toOptionalString(peer.siteId)) {
    return null;
  }
  const auth = value?.auth;
  let normalizedAuth = auth ?? null;
  if (!normalizedAuth) {
    const token = toOptionalString(value?.token);
    if (!token) return null;
    normalizedAuth = {
      kind: "bootstrap",
      token,
    };
  }
  if (normalizedAuth.kind === "bootstrap") {
    if (!toOptionalString(normalizedAuth.token)) return null;
  } else if (normalizedAuth.kind === "paired") {
    if (!toOptionalString(normalizedAuth.deviceId) || !toOptionalString(normalizedAuth.secret)) return null;
  } else {
    return null;
  }
  return {
    peer: {
      deviceId: String(peer.deviceId).trim(),
      deviceName: String(peer.deviceName).trim(),
      platform: peer.platform ?? "unknown",
      deviceType: peer.deviceType ?? "unknown",
      siteId: String(peer.siteId).trim(),
      dbVersion: Number(peer.dbVersion ?? 0),
      capabilities: Array.isArray(peer.capabilities)
        ? peer.capabilities
          .filter((capability): capability is string => typeof capability === "string")
          .map((capability) => capability.trim())
          .filter(Boolean)
        : [],
    },
    auth: normalizedAuth,
  };
}

function parsePairingRequestPayload(payload: unknown): SyncPairingRequestPayload | null {
  const value = payload as SyncPairingRequestPayload | null;
  const code = toOptionalString(value?.code);
  const peer = value?.peer;
  if (!code || !peer || typeof peer !== "object") return null;
  if (!toOptionalString(peer.deviceId) || !toOptionalString(peer.deviceName) || !toOptionalString(peer.siteId)) {
    return null;
  }
  return {
    code,
    peer: {
      deviceId: String(peer.deviceId).trim(),
      deviceName: String(peer.deviceName).trim(),
      platform: peer.platform ?? "unknown",
      deviceType: peer.deviceType ?? "unknown",
      siteId: String(peer.siteId).trim(),
      dbVersion: Number(peer.dbVersion ?? 0),
    },
  };
}

function shouldAttemptTailnetServiceAdvertise(): boolean {
  if (process.env.ADE_TAILSCALE_SERVE === "0") return false;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return false;
  return process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";
}

export function parseNativeLanDiscoveryProcessList(stdout: string): NativeLanDiscoveryProcess[] {
  const out: NativeLanDiscoveryProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3];
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (!/\bdns-sd\b/.test(command)) continue;
    if (!/\s-R\s+ADE Sync\b/.test(command)) continue;
    if (!/\b_ade-sync\._tcp\b/.test(command)) continue;
    out.push({ pid, ppid, command });
  }
  return out;
}

async function recoverOrphanedNativeLanDiscoveryProcesses(logger: Logger): Promise<void> {
  if (
    process.platform !== "darwin"
    || process.env.NODE_ENV === "test"
    || process.env.VITEST
    || process.env.VITEST_WORKER_ID
  ) return;
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { timeout: 2_000 });
    for (const proc of parseNativeLanDiscoveryProcessList(stdout)) {
      if (proc.ppid !== 1) continue;
      try {
        process.kill(proc.pid, "SIGKILL");
        logger.warn("sync_host.discovery_native_orphan_recovered", {
          pid: proc.pid,
          ppid: proc.ppid,
        });
      } catch (error) {
        logger.warn("sync_host.discovery_native_orphan_recovery_failed", {
          pid: proc.pid,
          ppid: proc.ppid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logger.warn("sync_host.discovery_native_orphan_scan_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function looksLikePendingTailnetApproval(text: string): boolean {
  return /\b(pending|approval|approve|review)\b/i.test(text);
}

export function createSyncHostService(args: SyncHostServiceArgs) {
  void recoverOrphanedNativeLanDiscoveryProcesses(args.logger);
  const layout = resolveAdeLayout(args.projectRoot);
  const bootstrapTokenPath = args.bootstrapTokenPath ?? path.join(layout.secretsDir, "sync-bootstrap-token");
  const pairingSecretsPath = args.pairingSecretsPath ?? path.join(layout.secretsDir, "sync-paired-devices.json");
  const commandLedgerPath = path.join(layout.cacheDir, "sync-mobile-command-ledger.json");
  const bootstrapToken = ensureBootstrapToken(bootstrapTokenPath);
  const pairingStore = createSyncPairingStore({
    filePath: pairingSecretsPath,
    pinStore: args.pinStore,
  });
  const remoteCommandService = args.remoteCommandService ?? createSyncRemoteCommandService({
    laneService: args.laneService,
    prService: args.prService,
    ptyService: args.ptyService,
    sessionService: args.sessionService,
    fileService: args.fileService,
    gitService: args.gitService,
    diffService: args.diffService,
    conflictService: args.conflictService,
    agentChatService: args.agentChatService,
    workerAgentService: args.workerAgentService,
    workerBudgetService: args.workerBudgetService,
    workerHeartbeatService: args.workerHeartbeatService,
    workerRevisionService: args.workerRevisionService,
    ctoStateService: args.ctoStateService,
    flowPolicyService: args.flowPolicyService,
    linearCredentialService: args.linearCredentialService,
    getLinearIngressService: args.getLinearIngressService,
    getLinearIssueTracker: args.getLinearIssueTracker,
    getLinearSyncService: args.getLinearSyncService,
    issueInventoryService: args.issueInventoryService,
    pathToMergeOrchestrator: args.pathToMergeOrchestrator,
    queueLandingService: args.queueLandingService,
    projectConfigService: args.projectConfigService,
    processService: args.processService,
    portAllocationService: args.portAllocationService,
    laneEnvironmentService: args.laneEnvironmentService,
    laneTemplateService: args.laneTemplateService,
    rebaseSuggestionService: args.rebaseSuggestionService,
    autoRebaseService: args.autoRebaseService,
    dispatchDeeplinkUrl: args.dispatchDeeplinkUrl,
    logger: args.logger,
  });
  const heartbeatIntervalMs = Math.max(5_000, Math.floor(args.heartbeatIntervalMs ?? DEFAULT_SYNC_HEARTBEAT_INTERVAL_MS));
  const pollIntervalMs = Math.max(100, Math.floor(args.pollIntervalMs ?? DEFAULT_SYNC_POLL_INTERVAL_MS));
  const brainStatusIntervalMs = Math.max(1_000, Math.floor(args.brainStatusIntervalMs ?? DEFAULT_BRAIN_STATUS_INTERVAL_MS));
  const compressionThresholdBytes = Math.max(256, Math.floor(args.compressionThresholdBytes ?? DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES));
  const maxChangesetBatchBytes = 256 * 1024;
  const maxChangesetBatchRows = 250;
  const maxProjectCatalogEnvelopeBytes = MAX_PROJECT_CATALOG_ENVELOPE_BYTES;
  const maxProjectCatalogChunkBytes = 192 * 1024;
  const localPresenceCommandDescriptors: SyncRemoteCommandDescriptor[] = [
    {
      action: "lanes.presence.announce",
      scope: "project",
      policy: { viewerAllowed: true },
    },
    {
      action: "lanes.presence.release",
      scope: "project",
      policy: { viewerAllowed: true },
    },
  ];

  const readBrainMetadata = (): SyncPeerMetadata => {
    const localDevice = args.deviceRegistryService?.ensureLocalDevice();
    return {
      deviceId: localDevice?.deviceId ?? args.db.sync.getSiteId(),
      deviceName: localDevice?.name ?? os.hostname(),
      platform: localDevice?.platform ?? mapPlatform(process.platform),
      deviceType: localDevice?.deviceType ?? "desktop",
      siteId: localDevice?.siteId ?? args.db.sync.getSiteId(),
      dbVersion: args.db.sync.getDbVersion(),
    };
  };

  const peers = new Set<PeerState>();
  const mobileCommandResultCache = new Map<string, CachedMobileCommand>();
  let commandReplayCount = 0;
  let commandConflictCount = 0;
  let lastCommandResultLatencyMs: number | null = null;
  let lastChangesetAckLatencyMs: number | null = null;

  const pruneMobileCommandResultCache = (nowMs = Date.now()): void => {
    for (const [key, record] of mobileCommandResultCache) {
      if (record.completedAtMs == null) continue;
      if (nowMs - record.completedAtMs > MOBILE_COMMAND_RESULT_CACHE_TTL_MS) {
        mobileCommandResultCache.delete(key);
      }
    }
    if (mobileCommandResultCache.size <= MOBILE_COMMAND_RESULT_CACHE_MAX_ENTRIES) return;

    const completed = [...mobileCommandResultCache.entries()]
      .filter(([, record]) => record.completedAtMs != null)
      .sort(([, left], [, right]) => (left.completedAtMs ?? left.acceptedAtMs) - (right.completedAtMs ?? right.acceptedAtMs));
    for (const [key] of completed) {
      if (mobileCommandResultCache.size <= MOBILE_COMMAND_RESULT_CACHE_MAX_ENTRIES) break;
      mobileCommandResultCache.delete(key);
    }
  };

  const readPersistedCommandLedger = (): PersistedMobileCommand[] => {
    try {
      if (!fs.existsSync(commandLedgerPath)) return [];
      const parsed = safeJsonParse<{ commands?: PersistedMobileCommand[] }>(
        fs.readFileSync(commandLedgerPath, "utf8"),
        { commands: [] },
      );
      return Array.isArray(parsed.commands) ? parsed.commands : [];
    } catch (error) {
      args.logger.warn("sync_host.command_ledger_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
  const commandLedgerScopeKey = (): string =>
    toOptionalString(args.projectId) ?? args.projectRoot;
  const commandLedgerKeyPrefix = (): string => `${commandLedgerScopeKey()}:`;
  const commandLedgerLegacyRootPrefix = (): string => `${args.projectRoot}:`;
  const writePersistedCommandLedger = (): void => {
    const nowMs = Date.now();
    const commands: PersistedMobileCommand[] = [];
    const prefix = commandLedgerKeyPrefix();
    for (const [key, record] of mobileCommandResultCache) {
      if (!record.result || record.completedAtMs == null) continue;
      const persistedResult = persistedMobileCommandResult(record.action, record.result);
      if (!persistedResult) continue;
      if (!key.startsWith(prefix)) continue;
      if (nowMs - record.completedAtMs > MOBILE_COMMAND_RESULT_CACHE_TTL_MS) continue;
      const deviceId = key.slice(prefix.length).split(":")[0] ?? "";
      commands.push({
        key,
        projectRoot: args.projectRoot,
        deviceId,
        commandId: record.commandId,
        action: record.action,
        argsFingerprint: record.argsFingerprint,
        ack: record.ack,
        result: persistedResult,
        acceptedAtMs: record.acceptedAtMs,
        completedAtMs: record.completedAtMs,
      });
    }
    commands.sort((left, right) => right.completedAtMs - left.completedAtMs);
    writeTextAtomic(commandLedgerPath, `${JSON.stringify({ commands: commands.slice(0, MOBILE_COMMAND_RESULT_CACHE_MAX_ENTRIES) }, null, 2)}\n`);
  };
  const loadPersistedCommandLedger = (): void => {
    const nowMs = Date.now();
    for (const command of readPersistedCommandLedger()) {
      if (command.projectRoot !== args.projectRoot) continue;
      if (nowMs - command.completedAtMs > MOBILE_COMMAND_RESULT_CACHE_TTL_MS) continue;
      const replayResult = persistedMobileCommandResult(command.action, command.result);
      if (!replayResult) continue;
      const legacyArgsKey = (command as { argsKey?: unknown }).argsKey;
      const argsFingerprint = typeof command.argsFingerprint === "string"
        ? command.argsFingerprint
        : typeof legacyArgsKey === "string"
        ? mobileCommandArgsFingerprint(legacyArgsKey)
        : null;
      if (!argsFingerprint) continue;
      const key =
        command.key.startsWith(commandLedgerLegacyRootPrefix()) &&
        commandLedgerScopeKey() !== args.projectRoot
          ? `${commandLedgerKeyPrefix()}${command.key.slice(commandLedgerLegacyRootPrefix().length)}`
          : command.key;
      mobileCommandResultCache.set(key, {
        commandId: command.commandId,
        action: command.action,
        argsKey: argsFingerprint,
        argsFingerprint,
        ack: command.ack,
        result: replayResult,
        waiters: [],
        acceptedAtMs: command.acceptedAtMs,
        completedAtMs: command.completedAtMs,
      });
    }
  };
  const commandLedgerSizeForProject = (): number =>
    [...mobileCommandResultCache.keys()].filter((key) =>
      key.startsWith(commandLedgerKeyPrefix()),
    ).length;
  const dropInFlightCommandRecordsForProject = (): void => {
    for (const [key, record] of mobileCommandResultCache) {
      if (!key.startsWith(commandLedgerKeyPrefix())) continue;
      if (record.result == null) mobileCommandResultCache.delete(key);
    }
  };
  loadPersistedCommandLedger();
  /** Notification preferences keyed by deviceId. The map is a hot cache;
   * device metadata is the restart-safe source for offline push fan-out. */
  const notificationPrefsByDeviceId = new Map<string, NotificationPreferences>();
  const storeNotificationPrefsForDevice = (deviceId: string, prefs: NotificationPreferences): void => {
    const normalizedPrefs = normalizeNotificationPreferences(prefs);
    notificationPrefsByDeviceId.set(deviceId, normalizedPrefs);
    args.deviceRegistryService?.setNotificationPreferences?.(deviceId, normalizedPrefs);
  };
  const readNotificationPrefsForDevice = (deviceId: string): NotificationPreferences => {
    return notificationPrefsByDeviceId.get(deviceId)
      ?? args.deviceRegistryService?.getNotificationPreferences?.(deviceId)
      ?? DEFAULT_NOTIFICATION_PREFERENCES;
  };
  const lanePresenceByLaneId = new Map<string, Map<string, LanePresenceEntry>>();
  let localActiveLaneIds = new Set<string>();
  const PAIR_FAILURE_THRESHOLD = 5;
  const PAIR_COOLDOWN_MS = 10 * 60_000;
  const PAIR_FAILURE_WINDOW_MS = 10 * 60_000;
  const pairFailures = new Map<string, { count: number; cooldownUntilMs: number; updatedAtMs: number }>();
  const pruneExpiredPairFailures = (now = Date.now()): boolean => {
    let changed = false;
    for (const [ip, entry] of pairFailures) {
      const cooldownExpired = entry.cooldownUntilMs > 0 && entry.cooldownUntilMs <= now;
      const failureWindowExpired = entry.updatedAtMs + PAIR_FAILURE_WINDOW_MS <= now;
      if (cooldownExpired || failureWindowExpired) {
        pairFailures.delete(ip);
        changed = true;
      }
    }
    return changed;
  };
  const registerPairFailure = (ip: string | null): void => {
    if (!ip) return;
    const now = Date.now();
    pruneExpiredPairFailures(now);
    const entry = pairFailures.get(ip) ?? { count: 0, cooldownUntilMs: 0, updatedAtMs: now };
    entry.count += 1;
    entry.updatedAtMs = now;
    if (entry.count >= PAIR_FAILURE_THRESHOLD) {
      entry.cooldownUntilMs = now + PAIR_COOLDOWN_MS;
      entry.count = 0;
    }
    pairFailures.set(ip, entry);
  };
  const pairingCooldownMsRemaining = (ip: string | null): number => {
    if (!ip) return 0;
    const entry = pairFailures.get(ip);
    if (!entry) return 0;
    const now = Date.now();
    const remaining = entry.cooldownUntilMs - now;
    if (remaining > 0) return remaining;
    if (
      (entry.cooldownUntilMs > 0 && remaining <= 0)
      || entry.updatedAtMs + PAIR_FAILURE_WINDOW_MS <= now
    ) {
      pairFailures.delete(ip);
    }
    return 0;
  };

  const normalizeLaneId = (laneId: string | null | undefined): string | null => {
    const normalized = toOptionalString(laneId);
    return normalized && normalized.length > 0 ? normalized : null;
  };

  const listLanePresenceMarkers = (laneId: string): DeviceMarker[] => {
    const entries = lanePresenceByLaneId.get(laneId);
    if (!entries) return [];
    return [...entries.values()]
      .map((entry) => entry.marker)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  };

  const upsertLanePresence = (argsIn: {
    laneId: string;
    marker: DeviceMarker;
    source: "local" | "remote";
  }): boolean => {
    const laneId = normalizeLaneId(argsIn.laneId);
    if (!laneId) return false;
    const byDevice = lanePresenceByLaneId.get(laneId) ?? new Map<string, LanePresenceEntry>();
    const existing = byDevice.get(argsIn.marker.deviceId) ?? null;
    const nextEntry: LanePresenceEntry = {
      marker: argsIn.marker,
      lastAnnouncedAtMs: Date.now(),
      source: argsIn.source,
    };
    byDevice.set(argsIn.marker.deviceId, nextEntry);
    lanePresenceByLaneId.set(laneId, byDevice);
    return (
      existing == null
      || existing.source !== nextEntry.source
      || existing.marker.displayName !== nextEntry.marker.displayName
      || existing.marker.platform !== nextEntry.marker.platform
    );
  };

  const removeLanePresence = (laneId: string | null | undefined, deviceId: string | null | undefined): boolean => {
    const normalizedLaneId = normalizeLaneId(laneId);
    const normalizedDeviceId = toOptionalString(deviceId);
    if (!normalizedLaneId || !normalizedDeviceId) return false;
    const byDevice = lanePresenceByLaneId.get(normalizedLaneId);
    if (!byDevice?.delete(normalizedDeviceId)) return false;
    if (byDevice.size === 0) {
      lanePresenceByLaneId.delete(normalizedLaneId);
    }
    return true;
  };

  const removeAllPresenceForDevice = (
    deviceId: string | null | undefined,
    source?: LanePresenceEntry["source"],
  ): boolean => {
    const normalizedDeviceId = toOptionalString(deviceId);
    if (!normalizedDeviceId) return false;
    let changed = false;
    for (const [laneId, byDevice] of lanePresenceByLaneId) {
      const entry = byDevice.get(normalizedDeviceId);
      if (!entry || (source && entry.source !== source)) continue;
      byDevice.delete(normalizedDeviceId);
      changed = true;
      if (byDevice.size === 0) {
        lanePresenceByLaneId.delete(laneId);
      }
    }
    return changed;
  };

  const pruneExpiredLanePresence = (): boolean => {
    const cutoff = Date.now() - LANE_PRESENCE_TTL_MS;
    let changed = false;
    for (const [laneId, byDevice] of lanePresenceByLaneId) {
      for (const [deviceId, entry] of byDevice) {
        if (entry.lastAnnouncedAtMs > cutoff) continue;
        byDevice.delete(deviceId);
        changed = true;
      }
      if (byDevice.size === 0) {
        lanePresenceByLaneId.delete(laneId);
      }
    }
    return changed;
  };

  const readLocalPresenceMarker = (): DeviceMarker | null => {
    const localDevice = args.deviceRegistryService?.ensureLocalDevice() ?? null;
    if (!localDevice) return null;
    return {
      deviceId: localDevice.deviceId,
      displayName: localDevice.name,
      platform: localDevice.platform,
    };
  };

  const refreshLocalLanePresence = (): boolean => {
    if (localActiveLaneIds.size === 0) return false;
    const marker = readLocalPresenceMarker();
    if (!marker) return false;
    let changed = false;
    for (const laneId of localActiveLaneIds) {
      changed = upsertLanePresence({
        laneId,
        marker,
        source: "local",
      }) || changed;
    }
    return changed;
  };

  const setLocalActiveLanePresence = (laneIds: string[]): void => {
    const nextLaneIds = new Set(
      laneIds
        .map((laneId) => normalizeLaneId(laneId))
        .filter((laneId): laneId is string => laneId != null),
    );
    const marker = readLocalPresenceMarker();
    let changed = false;
    if (marker) {
      for (const laneId of localActiveLaneIds) {
        if (!nextLaneIds.has(laneId)) {
          changed = removeLanePresence(laneId, marker.deviceId) || changed;
        }
      }
    }
    localActiveLaneIds = nextLaneIds;
    if (marker) {
      for (const laneId of localActiveLaneIds) {
        changed = upsertLanePresence({ laneId, marker, source: "local" }) || changed;
      }
    }
    if (changed) {
      args.onStateChanged?.();
      broadcastBrainStatus();
    }
  };

  const buildRemotePresenceMarker = (peer: PeerState): DeviceMarker | null => {
    if (!peer.metadata) return null;
    return {
      deviceId: peer.metadata.deviceId,
      displayName: peer.metadata.deviceName,
      platform: peer.metadata.platform,
    };
  };

  const decorateLaneSummary = (lane: LaneSummary): LaneSummary => {
    const devicesOpen = listLanePresenceMarkers(lane.id);
    return devicesOpen.length > 0 ? { ...lane, devicesOpen } : lane;
  };

  const decorateLaneSummaries = (lanes: LaneSummary[]): LaneSummary[] =>
    lanes.map((lane) => decorateLaneSummary(lane));

  const decorateLaneListSnapshots = (snapshots: LaneListSnapshot[]): LaneListSnapshot[] =>
    snapshots.map((snapshot) => ({
      ...snapshot,
      lane: decorateLaneSummary(snapshot.lane),
    }));

  const decorateLaneDetailPayload = (detail: LaneDetailPayload): LaneDetailPayload => ({
    ...detail,
    lane: decorateLaneSummary(detail.lane),
    children: decorateLaneSummaries(detail.children),
  });

  const decorateCommandResult = (
    action: SyncCommandPayload["action"],
    result: unknown,
  ): unknown => {
    pruneExpiredLanePresence();
    switch (action) {
      case "lanes.list":
      case "lanes.getChildren":
        return Array.isArray(result) ? decorateLaneSummaries(result as LaneSummary[]) : result;
      case "lanes.refreshSnapshots": {
        const payload = result as
          | { lanes?: LaneSummary[]; snapshots?: LaneListSnapshot[] }
          | null
          | undefined;
        if (!payload || typeof payload !== "object") return result;
        return {
          ...payload,
          ...(Array.isArray(payload.lanes) ? { lanes: decorateLaneSummaries(payload.lanes) } : {}),
          ...(Array.isArray(payload.snapshots)
            ? { snapshots: decorateLaneListSnapshots(payload.snapshots) }
            : {}),
        };
      }
      case "lanes.getDetail":
        return result && typeof result === "object"
          ? decorateLaneDetailPayload(result as LaneDetailPayload)
          : result;
      case "lanes.create":
      case "lanes.createChild":
      case "lanes.createFromUnstaged":
      case "lanes.importBranch":
      case "lanes.attach":
      case "lanes.adoptAttached":
        return result && typeof result === "object"
          ? decorateLaneSummary(result as LaneSummary)
          : result;
      default:
        return result;
    }
  };
  const server = new WebSocketServer({
    host: "0.0.0.0",
    port: args.port ?? DEFAULT_SYNC_HOST_PORT,
    maxPayload: 25 * 1024 * 1024,
  });

  let disposed = false;
  let startupError: Error | null = null;
  let bonjourInstance: Bonjour | null = null;
  let bonjourAnnouncement: BonjourService | null = null;
  let nativeBonjourProcess: ChildProcess | null = null;
  let nativeBonjourRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeLanDiscoveryFallbackUntilMs = 0;
  let bonjourPort: number | null = null;
  let bonjourSignature: string | null = null;
  let bonjourProjectTxt: { projects: string; projectNames: string; projectCount: string } = {
    projects: typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : "",
    projectNames: typeof args.projectId === "string" && args.projectId.trim() ? "Current project" : "",
    projectCount: typeof args.projectId === "string" && args.projectId.trim() ? "1" : "",
  };
  let bonjourProjectRefreshInFlight = false;
  let tailnetServeSignature: string | null = null;
  let tailnetServeLastFailureSignature: string | null = null;
  let tailnetServePublishSequence = 0;
  let tailnetServeActivePublishToken = 0;
  let discoveryEnabled = args.discoveryEnabled !== false;
  let tailnetDiscoveryStatus: SyncTailnetDiscoveryStatus = {
    state: !discoveryEnabled
      ? "disabled"
      : shouldAttemptTailnetServiceAdvertise() ? "disabled" : "unavailable",
    serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
    servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
    target: null,
    updatedAt: null,
    error: !discoveryEnabled
      ? "Tailnet discovery is disabled for this background project context."
      : shouldAttemptTailnetServiceAdvertise()
      ? "Tailnet discovery has not been published yet."
      : "Tailscale Serve discovery is not available in this ADE process.",
    stderr: null,
  };
  let lastBroadcastAt: string | null = null;
  const startedAtMs = Date.now();

  server.on("error", (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!disposed && !server.address()) {
      startupError = normalized;
    }
    args.logger.warn("sync_host.server_error", {
      error: normalized.message,
      code: (normalized as NodeJS.ErrnoException).code ?? null,
      port: args.port ?? DEFAULT_SYNC_HOST_PORT,
    });
    args.onStateChanged?.();
  });

  const pollTimer = setInterval(() => {
    void pumpChanges().catch((error) => {
      args.logger.warn("sync_host.poll_failed", { error: error instanceof Error ? error.message : String(error) });
    });
    void pumpChatEvents().catch((error) => {
      args.logger.warn("sync_host.chat_poll_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, pollIntervalMs);
  const heartbeatTimer = setInterval(() => {
    pruneExpiredPairFailures();
    const refreshedLocalPresence = refreshLocalLanePresence();
    if (refreshedLocalPresence || pruneExpiredLanePresence()) {
      args.onStateChanged?.();
      broadcastBrainStatus();
    }
    const sentAt = nowIso();
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (isPeerBackpressured(peer)) {
        args.logger.debug("sync_host.heartbeat_deferred_backpressure", {
          peerDeviceId: peer.metadata?.deviceId ?? null,
          bufferedAmount: peer.ws.bufferedAmount,
        });
        continue;
      }
      if (peer.awaitingHeartbeatAt) {
        peer.missedHeartbeatCount += 1;
        if (peer.missedHeartbeatCount >= syncHeartbeatMissLimitForPeerMetadata(peer.metadata)) {
          try {
            peer.ws.close(4001, "Heartbeat timed out");
          } catch {
            // ignore
          }
          continue;
        }
      } else {
        peer.missedHeartbeatCount = 0;
      }
      peer.awaitingHeartbeatAt = sentAt;
      send(peer.ws, "heartbeat", { kind: "ping", sentAt, dbVersion: args.db.sync.getDbVersion() });
    }
  }, heartbeatIntervalMs);
  const brainStatusTimer = setInterval(() => {
    broadcastBrainStatus();
  }, brainStatusIntervalMs);
  const chatEventSubscription = args.agentChatService?.subscribeToEvents(
    (event) => {
      broadcastChatEvent(event);
      // Let the notification bus (mobile push fan-out) observe chat events.
      // Failures here must never break chat delivery to the UI.
      try {
        args.notificationEventBus?.publishChatEvent(event);
      } catch (error) {
        args.logger.warn("sync_host.notification_publish_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  ) ?? null;

  server.on("connection", (ws, request) => {
    const remoteAddress = sanitizeRemoteAddress(request.socket.remoteAddress);
    const peer: PeerState = {
      ws,
      metadata: null,
      authenticated: false,
      authKind: null,
      pairedDeviceId: null,
      connectedAt: nowIso(),
      lastSeenAt: nowIso(),
      lastAppliedAt: null,
      lastKnownServerDbVersion: 0,
      latencyMs: null,
      awaitingHeartbeatAt: null,
      missedHeartbeatCount: 0,
      remoteAddress,
      remotePort: request.socket.remotePort ?? null,
      subscribedSessionIds: new Set(),
      subscribedChatSessionIds: new Set(),
      chatTranscriptOffsets: new Map(),
      chatEventIdsSent: new Map(),
      pendingChangesetBatch: null,
    };
    peers.add(peer);
    ws.on("message", (raw) => {
      void handleMessage(peer, raw).catch((error) => {
        args.logger.warn("sync_host.message_failed", {
          error: error instanceof Error ? error.message : String(error),
          peerDeviceId: peer.metadata?.deviceId ?? null,
        });
      });
    });
    ws.on("close", () => {
      if (removeAllPresenceForDevice(peer.metadata?.deviceId, "remote")) {
        broadcastBrainStatus();
      }
      peers.delete(peer);
      args.onStateChanged?.();
      broadcastBrainStatus();
    });
    ws.on("error", (error) => {
      args.logger.warn("sync_host.socket_error", {
        error: error instanceof Error ? error.message : String(error),
        peerDeviceId: peer.metadata?.deviceId ?? null,
      });
    });
  });

  const clearNativeLanDiscoveryRecovery = (): void => {
    if (!nativeBonjourRecoveryTimer) return;
    clearTimeout(nativeBonjourRecoveryTimer);
    nativeBonjourRecoveryTimer = null;
  };

  const scheduleNativeLanDiscoveryRecovery = (port: number): void => {
    clearNativeLanDiscoveryRecovery();
    if (disposed || !discoveryEnabled || bonjourPort !== port) return;
    nativeBonjourRecoveryTimer = setTimeout(() => {
      nativeBonjourRecoveryTimer = null;
      if (disposed || !discoveryEnabled || bonjourPort !== port) return;
      publishLanDiscovery(port);
    }, NATIVE_LAN_DISCOVERY_RECOVERY_DELAY_MS);
    if (
      typeof nativeBonjourRecoveryTimer === "object"
      && typeof (nativeBonjourRecoveryTimer as { unref?: unknown }).unref === "function"
    ) {
      (nativeBonjourRecoveryTimer as { unref: () => void }).unref();
    }
  };

  const stopNativeLanDiscovery = (): void => {
    clearNativeLanDiscoveryRecovery();
    const child = nativeBonjourProcess;
    if (!child) return;
    nativeBonjourProcess = null;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore cleanup failures
    }
  };

  const stopBonjourAnnouncement = (): void => {
    if (!bonjourAnnouncement) return;
    try {
      bonjourAnnouncement.stop?.();
    } catch {
      // ignore cleanup failures
    }
    bonjourAnnouncement = null;
  };

  const publishNativeLanDiscovery = (
    serviceName: string,
    port: number,
    txt: Record<string, string>,
  ): void => {
    clearNativeLanDiscoveryRecovery();
    stopNativeLanDiscovery();
    const child = spawn("dns-sd", [
      "-R",
      serviceName,
      "_ade-sync._tcp",
      "local",
      String(port),
      ...Object.entries(txt).map(([key, value]) => `${key}=${value}`),
    ], {
      stdio: "ignore",
    });
    nativeBonjourProcess = child;
    child.unref();
    child.once("error", (error) => {
      if (nativeBonjourProcess !== child) return;
      nativeBonjourProcess = null;
      nativeLanDiscoveryFallbackUntilMs = Date.now() + NATIVE_LAN_DISCOVERY_FALLBACK_MS;
      args.logger.warn("sync_host.discovery_native_publish_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleNativeLanDiscoveryRecovery(port);
    });
    child.once("exit", (code, signal) => {
      if (nativeBonjourProcess !== child) return;
      nativeBonjourProcess = null;
      nativeLanDiscoveryFallbackUntilMs = Date.now() + NATIVE_LAN_DISCOVERY_FALLBACK_MS;
      args.logger.warn("sync_host.discovery_native_exited", { code, signal });
      scheduleNativeLanDiscoveryRecovery(port);
    });
  };

  const shouldUseNativeLanDiscovery = (): boolean =>
    process.platform === "darwin"
    && typeof process.versions.electron === "string"
    && Date.now() >= nativeLanDiscoveryFallbackUntilMs;

  const publishLanDiscovery = (port: number, options?: { force?: boolean }): void => {
    if (disposed) return;
    if (!discoveryEnabled) {
      unpublishLanDiscovery();
      return;
    }
    const localDevice = args.deviceRegistryService?.ensureLocalDevice() ?? null;
    const hostName = localDevice?.name ?? os.hostname();
    const tailscaleDnsName =
      typeof localDevice?.metadata?.tailscaleDnsName === "string"
        ? localDevice.metadata.tailscaleDnsName.trim().replace(/\.$/, "").toLowerCase()
        : "";
    const ipAddresses = uniqueStrings([
      ...(localDevice?.ipAddresses ?? []),
      localDevice?.tailscaleIp ?? null,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0));
    const addressesCsv = ipAddresses.length > 0 ? ipAddresses.join(",") : "127.0.0.1";
    const preferredHost = ipAddresses[0] ?? localDevice?.lastHost ?? "";
    const txt = {
      version: "1",
      runtimeKind: args.runtimeKind ?? "desktop-embedded",
      runtimeVersion: args.runtimeVersion ?? "",
      projects: bonjourProjectTxt.projects,
      projectNames: bonjourProjectTxt.projectNames,
      projectCount: bonjourProjectTxt.projectCount,
      deviceId: localDevice?.deviceId ?? "",
      siteId: localDevice?.siteId ?? "",
      deviceName: hostName,
      port: String(port),
      host: preferredHost,
      addresses: addressesCsv,
      tailscaleIp: localDevice?.tailscaleIp ?? "",
      tailscaleDnsName: tailscaleDnsName.endsWith(".ts.net") ? tailscaleDnsName : "",
    };
    const signature = JSON.stringify({ hostName, port, txt });
    const alreadyPublished = bonjourPort === port && bonjourSignature === signature;
    if (!options?.force && alreadyPublished && (bonjourAnnouncement || nativeBonjourProcess)) return;
    const serviceName = `ADE Sync ${hostName} ${port}`;
    if (shouldUseNativeLanDiscovery()) {
      stopBonjourAnnouncement();
      bonjourPort = port;
      bonjourSignature = signature;
      publishNativeLanDiscovery(serviceName, port, txt);
      refreshLanDiscoveryProjects(port);
      return;
    }
    stopNativeLanDiscovery();
    if (!bonjourInstance) {
      bonjourInstance = new Bonjour(undefined, (error: unknown) => {
        args.logger.warn("sync_host.discovery_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    stopBonjourAnnouncement();
    bonjourPort = port;
    bonjourSignature = signature;
    bonjourAnnouncement = bonjourInstance.publish({
      name: serviceName,
      type: SYNC_MDNS_SERVICE_TYPE,
      protocol: "tcp",
      port,
      txt,
      disableIPv6: true,
    });
    bonjourAnnouncement.on("error", (error: unknown) => {
      args.logger.warn("sync_host.discovery_publish_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    refreshLanDiscoveryProjects(port);
  };

  const refreshLanDiscoveryProjects = (port: number, projectCatalog?: SyncProjectCatalogPayload): void => {
    if ((!args.projectCatalogProvider && !projectCatalog) || bonjourProjectRefreshInFlight) return;
    bonjourProjectRefreshInFlight = true;
    void Promise.resolve(projectCatalog ?? buildProjectCatalogPayload())
      .then((catalog) => {
        const projectIds = uniqueStrings(catalog.projects
          .map((project) => project.id)
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0))
          .slice(0, BONJOUR_PROJECT_TXT_ENTRY_LIMIT);
        const projectNames = uniqueStrings(catalog.projects
          .map((project) => typeof project.displayName === "string" ? project.displayName : "")
          .map((value) => value.replace(/[,\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, BONJOUR_PROJECT_NAME_MAX_LENGTH))
          .filter((value) => value.length > 0))
          .slice(0, BONJOUR_PROJECT_TXT_ENTRY_LIMIT);
        const next = {
          projects: projectIds.join(","),
          projectNames: projectNames.join(","),
          projectCount: String(catalog.projects.length),
        };
        if (
          next.projects === bonjourProjectTxt.projects
          && next.projectNames === bonjourProjectTxt.projectNames
          && next.projectCount === bonjourProjectTxt.projectCount
        ) {
          return;
        }
        bonjourProjectTxt = next;
        if (bonjourPort === port) {
          publishLanDiscovery(port);
        }
      })
      .catch((error) => {
        args.logger.warn("sync_host.discovery_project_catalog_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        bonjourProjectRefreshInFlight = false;
      });
  };

  const unpublishLanDiscovery = (): void => {
    stopNativeLanDiscovery();
    stopBonjourAnnouncement();
    bonjourPort = null;
    bonjourSignature = null;
  };

  const updateTailnetDiscoveryStatus = (
    next: SyncTailnetDiscoveryStatus,
  ): void => {
    tailnetDiscoveryStatus = next;
    setTimeout(() => {
      if (!disposed) args.onStateChanged?.();
    }, 0);
  };

  const publishTailnetDiscovery = (
    port: number,
    options?: { force?: boolean },
  ): void => {
    if (disposed) return;
    if (!discoveryEnabled) {
      void unpublishTailnetDiscovery();
      updateTailnetDiscoveryStatus({
        state: "disabled",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
        target: null,
        updatedAt: nowIso(),
        error: "Tailnet discovery is disabled for this background project context.",
        stderr: null,
      });
      return;
    }
    if (!shouldAttemptTailnetServiceAdvertise()) {
      updateTailnetDiscoveryStatus({
        state: "unavailable",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
        target: null,
        updatedAt: nowIso(),
        error: "Tailscale Serve discovery is not available in this ADE process.",
        stderr: null,
      });
      return;
    }
    const cli = resolveTailscaleCliPath();
    const signature = `${SYNC_TAILNET_DISCOVERY_SERVICE_NAME}:${SYNC_TAILNET_DISCOVERY_SERVICE_PORT}->${port}`;
    if (tailnetServeSignature === signature && !options?.force) return;
    if (tailnetServeLastFailureSignature === signature && !options?.force) return;
    const publishToken = ++tailnetServePublishSequence;
    tailnetServeActivePublishToken = publishToken;
    tailnetServeSignature = signature;
    const target = `tcp://127.0.0.1:${port}`;
    updateTailnetDiscoveryStatus({
      state: "publishing",
      serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
      servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
      target,
      updatedAt: nowIso(),
      error: null,
      stderr: null,
    });
    const cliArgs = [
      "serve",
      "--yes",
      `--service=${SYNC_TAILNET_DISCOVERY_SERVICE_NAME}`,
      `--tcp=${SYNC_TAILNET_DISCOVERY_SERVICE_PORT}`,
      target,
    ];
    void execFileAsync(cli, cliArgs, { timeout: 10_000 })
      .then(({ stdout, stderr }) => {
        if (tailnetServeActivePublishToken !== publishToken) return;
        tailnetServeLastFailureSignature = null;
        const stdoutText = stdout.trim();
        const stderrText = stderr.trim();
        const outputText = [stdoutText, stderrText].filter(Boolean).join("\n");
        updateTailnetDiscoveryStatus({
          state: looksLikePendingTailnetApproval(outputText) ? "pending_approval" : "published",
          serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
          target,
          updatedAt: nowIso(),
          error: null,
          stderr: stderrText || null,
        });
        args.logger.info("sync_host.tailnet_discovery_published", {
          service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
          target,
          stdout: stdoutText || null,
          stderr: stderrText || null,
        });
      })
      .catch((error: unknown) => {
        if (tailnetServeActivePublishToken !== publishToken) return;
        if (tailnetServeSignature === signature) {
          tailnetServeSignature = null;
        }
        tailnetServeLastFailureSignature = signature;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? null;
        const stderr = typeof (error as { stderr?: unknown })?.stderr === "string"
          ? String((error as { stderr?: string }).stderr).trim()
          : null;
        const errorText = [errorMessage, stderr].filter(Boolean).join("\n");
        updateTailnetDiscoveryStatus({
          state: code === "ENOENT"
            ? "unavailable"
            : looksLikePendingTailnetApproval(errorText)
              ? "pending_approval"
              : "failed",
          serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
          target,
          updatedAt: nowIso(),
          error: code === "ENOENT" ? "Tailscale CLI was not found." : errorMessage,
          stderr,
        });
        const logPayload = {
          service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
          target,
          error: errorMessage,
          code,
          stderr,
        };
        if (code === "ENOENT") {
          args.logger.info("sync_host.tailnet_discovery_unavailable", logPayload);
        } else {
          args.logger.warn("sync_host.tailnet_discovery_failed", logPayload);
        }
      });
  };

  const unpublishTailnetDiscovery = async (): Promise<void> => {
    if (!tailnetServeSignature) return;
    tailnetServeActivePublishToken = ++tailnetServePublishSequence;
    tailnetServeSignature = null;
    if (!shouldAttemptTailnetServiceAdvertise()) {
      updateTailnetDiscoveryStatus({
        state: "unavailable",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
        target: null,
        updatedAt: nowIso(),
        error: null,
        stderr: null,
      });
      return;
    }
    const cli = resolveTailscaleCliPath();
    try {
      await execFileAsync(
        cli,
        ["serve", "--yes", `--service=${SYNC_TAILNET_DISCOVERY_SERVICE_NAME}`, "off"],
        { timeout: 10_000 },
      );
      updateTailnetDiscoveryStatus({
        state: "disabled",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
        target: null,
        updatedAt: nowIso(),
        error: null,
        stderr: null,
      });
      args.logger.info("sync_host.tailnet_discovery_unpublished", {
        service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? null;
      updateTailnetDiscoveryStatus({
        state: code === "ENOENT" ? "unavailable" : "disabled",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
        target: null,
        updatedAt: nowIso(),
        error: code === "ENOENT" ? "Tailscale CLI was not found." : errorMessage,
        stderr: null,
      });
      args.logger.warn("sync_host.tailnet_discovery_unpublish_failed", {
        service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
        error: errorMessage,
        code,
      });
    }
  };

  function send<TPayload>(target: WebSocket | PeerState, type: SyncEnvelope["type"], payload: TPayload, requestId?: string | null): boolean {
    const ws = target instanceof WebSocket ? target : target.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    // Drop sends to backpressured peers as the default — most envelopes are
    // either replayable (chat events / changesets re-derived from db state) or
    // tolerable to lose (acks, status pings). Routes that *must* deliver under
    // backpressure should call ws.send / sendAndWait directly.
    if (target instanceof WebSocket ? ws.bufferedAmount >= PEER_BACKPRESSURE_BYTES : isPeerBackpressured(target)) {
      return false;
    }
    ws.send(encodeSyncEnvelope({ type, payload, requestId, compressionThresholdBytes }));
    return true;
  }

  function sendRequired<TPayload>(peer: PeerState, type: SyncEnvelope["type"], payload: TPayload, requestId?: string | null): boolean {
    const ws = peer.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encodeSyncEnvelope({ type, payload, requestId, compressionThresholdBytes }), (error) => {
      if (!error) return;
      args.logger.warn("sync_host.required_send_failed", {
        type,
        requestId: requestId ?? null,
        peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
        error: error.message,
      });
    });
    return true;
  }

  function isPeerBackpressured(peer: PeerState): boolean {
    return peer.ws.bufferedAmount >= PEER_BACKPRESSURE_BYTES;
  }

  function sendAndWait<TPayload>(
    ws: WebSocket,
    type: SyncEnvelope["type"],
    payload: TPayload,
    requestId?: string | null,
  ): Promise<void> {
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      return Promise.reject(new Error("Cannot send on closed WebSocket."));
    }
    return new Promise<void>((resolve, reject) => {
      ws.send(
        encodeSyncEnvelope({ type, payload, requestId, compressionThresholdBytes }),
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  function encodedEnvelopeBytes<TPayload>(
    type: SyncEnvelope["type"],
    payload: TPayload,
    requestId?: string | null,
  ): number {
    return Buffer.byteLength(encodeSyncEnvelope({ type, payload, requestId, compressionThresholdBytes }), "utf8");
  }

  function closeExistingPeersForDevice(deviceId: string, currentPeer: PeerState): void {
    const normalized = toOptionalString(deviceId);
    if (!normalized) return;
    for (const peer of peers) {
      if (peer === currentPeer) continue;
      if (peer.metadata?.deviceId !== normalized && peer.pairedDeviceId !== normalized) continue;
      peer.authenticated = false;
      peer.metadata = null;
      peer.authKind = null;
      peer.pairedDeviceId = null;
      try {
        peer.ws.close(4000, "Superseded by a newer connection for this device");
      } catch {
        // ignore close failures
      }
    }
  }

  function makeChangesetBatchId(peer: PeerState, fromDbVersion: number, toDbVersion: number): string {
    const deviceId = peer.metadata?.deviceId ?? peer.pairedDeviceId ?? "peer";
    return `changeset:${deviceId}:${fromDbVersion}:${toDbVersion}:${Date.now()}:${randomBytes(4).toString("hex")}`;
  }

  function peerSupportsChangesetAck(peer: PeerState): boolean {
    return Array.isArray(peer.metadata?.capabilities) && peer.metadata.capabilities.includes("changesetAck");
  }

  function sendNextChangesetBatch(
    peer: PeerState,
    reason: SyncChangesetBatchPayload["reason"],
    fromDbVersion: number,
    toDbVersion: number,
    changes: CrsqlChangeRow[],
  ): PendingChangesetBatch | null {
    const selected = selectChangesetBatchChunk({
      changes,
      fromDbVersion,
      toDbVersion,
      maxRows: maxChangesetBatchRows,
      maxBytes: maxChangesetBatchBytes,
    });
    if (!selected) return null;
    const chunkToDbVersion = selected.toDbVersion;
    const batch: PendingChangesetBatch = {
      batchId: makeChangesetBatchId(peer, fromDbVersion, chunkToDbVersion),
      reason,
      fromDbVersion,
      toDbVersion: chunkToDbVersion,
      changes: selected.changes,
      sentAtMs: Date.now(),
      retryCount: 0,
    };
    const sent = send(peer, "changeset_batch", {
      batchId: batch.batchId,
      reason,
      fromDbVersion,
      toDbVersion: chunkToDbVersion,
      changes: selected.changes,
    });
    return sent ? batch : null;
  }

  function resendPendingChangesetBatch(peer: PeerState): boolean {
    const batch = peer.pendingChangesetBatch;
    if (!batch) return false;
    batch.sentAtMs = Date.now();
    batch.retryCount += 1;
    return send(peer, "changeset_batch", {
      batchId: batch.batchId,
      reason: batch.reason,
      fromDbVersion: batch.fromDbVersion,
      toDbVersion: batch.toDbVersion,
      changes: batch.changes,
    });
  }

  async function buildProjectCatalogPayload(): Promise<SyncProjectCatalogPayload> {
    if (!args.projectCatalogProvider) {
      return { projects: [] };
    }
    try {
      return await args.projectCatalogProvider.listProjects();
    } catch (error) {
      args.logger.warn("sync_host.project_catalog_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { projects: [] };
    }
  }

  function splitProjectCatalog(projects: SyncMobileProjectSummary[]): SyncMobileProjectSummary[][] {
    const chunks: SyncMobileProjectSummary[][] = [];
    let chunk: SyncMobileProjectSummary[] = [];
    let chunkBytes = 0;

    const flush = (): void => {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    };

    for (const project of projects) {
      const projectBytes = Buffer.byteLength(JSON.stringify(project), "utf8");
      if (chunk.length > 0 && chunkBytes + projectBytes > maxProjectCatalogChunkBytes) {
        flush();
      }
      chunk.push(project);
      chunkBytes += projectBytes;
    }
    flush();
    return chunks;
  }

  function sendProjectCatalog(
    peer: PeerState,
    projectCatalog: SyncProjectCatalogPayload,
    requestId?: string | null,
  ): void {
    if (encodedEnvelopeBytes("project_catalog", projectCatalog, requestId) <= maxProjectCatalogEnvelopeBytes) {
      send(peer.ws, "project_catalog", projectCatalog, requestId);
      return;
    }

    const chunks = splitProjectCatalog(projectCatalog.projects);
    const total = Math.max(1, chunks.length);
    const catalogId = randomBytes(8).toString("hex");
    if (chunks.length === 0) {
      send(peer.ws, "project_catalog_chunk", {
        catalogId,
        index: 0,
        total,
        done: true,
        projects: [],
      } satisfies SyncProjectCatalogChunkPayload, requestId);
      return;
    }

    chunks.forEach((projects, index) => {
      send(peer.ws, "project_catalog_chunk", {
        catalogId,
        index,
        total,
        done: index === total - 1,
        projects,
      } satisfies SyncProjectCatalogChunkPayload, requestId);
    });
  }

  async function handleProjectSwitchRequest(
    peer: PeerState,
    requestId: string | null | undefined,
    payload: SyncProjectSwitchRequestPayload | null,
  ): Promise<void> {
    if (!args.projectCatalogProvider) {
      sendRequired(peer, "project_switch_result", {
        ok: false,
        message: "Project switching is not available from this machine.",
      }, requestId);
      return;
    }
    try {
      const result = await args.projectCatalogProvider.prepareProjectConnection(payload ?? {});
      await sendAndWait(peer.ws, "project_switch_result", result, requestId);
      try {
        await args.projectCatalogProvider.completeProjectConnection?.(payload ?? {}, result);
      } catch (completionError) {
        args.logger.warn("sync_host.project_switch_completion_failed", {
          message: completionError instanceof Error ? completionError.message : String(completionError),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger.warn("sync_host.project_switch_failed", { message });
      sendRequired(peer, "project_switch_result", {
        ok: false,
        message,
      }, requestId);
    }
  }

  function buildBrainStatus(): SyncBrainStatusPayload {
    const brainMetadata = readBrainMetadata();
    if (disposed) {
      return {
        brain: brainMetadata,
        connectedPeers: [],
        metrics: {
          connectedPeerCount: 0,
          runningSessionCount: 0,
          dbVersion: brainMetadata.dbVersion,
          uptimeMs: Date.now() - startedAtMs,
          lastBroadcastAt,
          pendingChangesetPeerCount: 0,
          commandLedgerSize: commandLedgerSizeForProject(),
          commandReplayCount,
          commandConflictCount,
          lastCommandResultLatencyMs,
          lastChangesetAckLatencyMs,
        },
      };
    }
    const dbVersion = args.db.sync.getDbVersion();
    const connectedPeers = [...peers]
      .map((peer) => toSyncPeerConnectionState(peer, dbVersion))
      .filter((peer): peer is SyncPeerConnectionState => peer != null);
    return {
      brain: {
        ...brainMetadata,
        dbVersion,
      },
      connectedPeers,
      metrics: {
        connectedPeerCount: connectedPeers.length,
        runningSessionCount: args.sessionService.list({ status: "running", limit: 200 }).length,
        dbVersion,
        uptimeMs: Date.now() - startedAtMs,
        lastBroadcastAt,
        pendingChangesetPeerCount: [...peers].filter((peer) => peer.pendingChangesetBatch != null).length,
        commandLedgerSize: commandLedgerSizeForProject(),
        commandReplayCount,
        commandConflictCount,
        lastCommandResultLatencyMs,
        lastChangesetAckLatencyMs,
      },
    };
  }

  function broadcastBrainStatus(): void {
    if (disposed) return;
    const payload = buildBrainStatus();
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      send(peer.ws, "brain_status", payload);
    }
  }

  async function readChatTranscriptEventsSince(
    transcriptPath: string,
    startOffset: number,
  ): Promise<{ events: AgentChatEventEnvelope[]; nextOffset: number }> {
    let fh: fs.promises.FileHandle | null = null;
    try {
      fh = await fs.promises.open(transcriptPath, "r");
      const stat = await fh.stat();
      const size = stat.size;
      const normalizedStart = Math.max(0, Math.min(startOffset, size));
      if (size <= normalizedStart) {
        return { events: [], nextOffset: size };
      }

      const out = Buffer.alloc(size - normalizedStart);
      await fh.read(out, 0, out.length, normalizedStart);
      const lastNewline = out.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        return { events: [], nextOffset: normalizedStart };
      }

      const completeSlice = out.subarray(0, lastNewline + 1);
      const raw = completeSlice.toString("utf8");
      return {
        events: parseAgentChatTranscript(raw),
        nextOffset: normalizedStart + completeSlice.length,
      };
    } catch {
      return { events: [], nextOffset: Math.max(0, startOffset) };
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  function chatEventDeliveryKey(event: AgentChatEventEnvelope): string {
    return `${event.sessionId}:${event.sequence ?? -1}:${event.timestamp}:${event.event.type}`;
  }

  function rememberChatEventSent(peer: PeerState, event: AgentChatEventEnvelope): boolean {
    const key = chatEventDeliveryKey(event);
    let sent = peer.chatEventIdsSent.get(event.sessionId);
    if (!sent) {
      sent = new Set();
      peer.chatEventIdsSent.set(event.sessionId, sent);
    }
    if (sent.has(key)) return false;
    sent.add(key);
    if (sent.size > 800) {
      const overflow = sent.size - 800;
      let removed = 0;
      for (const existingKey of sent) {
        sent.delete(existingKey);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
    return true;
  }

  async function pumpChatEvents(): Promise<void> {
    if (disposed) return;

    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (isPeerBackpressured(peer)) continue;
      for (const sessionId of peer.subscribedChatSessionIds) {
        const session = args.sessionService.get(sessionId);
        if (!session?.transcriptPath) continue;

        const startOffset = peer.chatTranscriptOffsets.get(sessionId) ?? 0;
        const { events, nextOffset } = await readChatTranscriptEventsSince(session.transcriptPath, startOffset);
        if (nextOffset !== startOffset) {
          peer.chatTranscriptOffsets.set(sessionId, nextOffset);
        }
        for (const event of events) {
          if (!rememberChatEventSent(peer, event)) continue;
          send(peer.ws, "chat_event", event);
        }
      }
    }
  }

  function broadcastChatEvent(event: AgentChatEventEnvelope): void {
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (isPeerBackpressured(peer)) continue;
      if (!peer.subscribedChatSessionIds.has(event.sessionId)) continue;
      if (!rememberChatEventSent(peer, event)) continue;
      send(peer.ws, "chat_event", event);
    }
  }

  async function pumpChanges(): Promise<void> {
    if (disposed) return;
    const currentDbVersion = args.db.sync.getDbVersion();
    const nowMs = Date.now();
    for (const peer of peers) {
      if (!peer.authenticated || !peer.metadata || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (isPeerBackpressured(peer)) continue;
      if (peer.pendingChangesetBatch) {
        if (nowMs - peer.pendingChangesetBatch.sentAtMs >= CHANGESET_ACK_TIMEOUT_MS) {
          const pending = peer.pendingChangesetBatch;
          if (pending.retryCount >= MAX_CHANGESET_ACK_RETRIES) {
            args.logger.warn("sync_host.changeset_ack_timeout", {
              peerDeviceId: peer.metadata.deviceId,
              batchId: pending.batchId,
              fromDbVersion: pending.fromDbVersion,
              toDbVersion: pending.toDbVersion,
              retryCount: pending.retryCount,
            });
            try {
              peer.ws.close(4000, "Changeset acknowledgement timed out");
            } catch {
              // ignore close failures
            }
            continue;
          }
          const resent = resendPendingChangesetBatch(peer);
          args.logger.debug("sync_host.changeset_ack_retry", {
            peerDeviceId: peer.metadata.deviceId,
            batchId: pending.batchId,
            fromDbVersion: pending.fromDbVersion,
            toDbVersion: pending.toDbVersion,
            retryCount: pending.retryCount,
            resent,
          });
        }
        continue;
      }
      if (currentDbVersion <= peer.lastKnownServerDbVersion) continue;
      const changes = args.db.sync
        .exportChangesSince(peer.lastKnownServerDbVersion)
        .filter((change: CrsqlChangeRow) => change.site_id !== peer.metadata?.siteId);
      const pending = sendNextChangesetBatch(peer, "broadcast", peer.lastKnownServerDbVersion, currentDbVersion, changes);
      if (pending) {
        if (peerSupportsChangesetAck(peer)) {
          peer.pendingChangesetBatch = pending;
        } else {
          peer.lastKnownServerDbVersion = Math.max(peer.lastKnownServerDbVersion, pending.toDbVersion);
        }
        lastBroadcastAt = nowIso();
      } else {
        args.logger.debug("sync_host.changeset_deferred_backpressure", {
          peerDeviceId: peer.metadata?.deviceId ?? null,
          fromDbVersion: peer.lastKnownServerDbVersion,
          toDbVersion: currentDbVersion,
          bufferedAmount: peer.ws.bufferedAmount,
        });
      }
    }
  }

  function handleChangesetAck(peer: PeerState, payload: SyncChangesetAckPayload | null | undefined): void {
    const pending = peer.pendingChangesetBatch;
    if (!pending || !payload) return;
    if (payload.batchId !== pending.batchId) {
      args.logger.debug("sync_host.changeset_ack_ignored", {
        peerDeviceId: peer.metadata?.deviceId ?? null,
        expectedBatchId: pending.batchId,
        receivedBatchId: payload.batchId,
      });
      return;
    }
    if (!payload.ok) {
      pending.retryCount += 1;
      pending.sentAtMs = Date.now();
      args.logger.warn("sync_host.changeset_ack_failed", {
        peerDeviceId: peer.metadata?.deviceId ?? null,
        batchId: pending.batchId,
        fromDbVersion: pending.fromDbVersion,
        toDbVersion: pending.toDbVersion,
        retryCount: pending.retryCount,
        error: payload.error?.message ?? "Changeset apply failed.",
      });
      if (pending.retryCount >= MAX_CHANGESET_ACK_RETRIES) {
        try {
          peer.ws.close(4000, "Changeset apply failed repeatedly");
        } catch {
          // ignore close failures
        }
      }
      return;
    }
    if (payload.toDbVersion < pending.toDbVersion) return;
    peer.lastKnownServerDbVersion = Math.max(peer.lastKnownServerDbVersion, pending.toDbVersion);
    peer.pendingChangesetBatch = null;
    peer.lastAppliedAt = nowIso();
    lastChangesetAckLatencyMs = Math.max(0, Date.now() - pending.sentAtMs);
    args.logger.debug("sync_host.changeset_ack_applied", {
      peerDeviceId: peer.metadata?.deviceId ?? null,
      batchId: pending.batchId,
      fromDbVersion: pending.fromDbVersion,
      toDbVersion: pending.toDbVersion,
      latencyMs: lastChangesetAckLatencyMs,
    });
    broadcastBrainStatus();
  }

  function resolveArtifactPath(request: Extract<SyncFileRequest, { action: "readArtifact" }>["args"]): string {
    const artifactId = toOptionalString(request.artifactId);
    const explicitUri = toOptionalString(request.uri) ?? toOptionalString(request.path);
    let candidate = explicitUri;
    if (artifactId) {
      const artifact = args.computerUseArtifactBrokerService.listArtifacts({ artifactId })[0] ?? null;
      candidate = artifact?.uri ?? candidate;
    }
    if (!candidate) {
      throw new Error("Artifact request requires artifactId, uri, or path.");
    }
    if (/^https?:\/\//i.test(candidate)) {
      throw new Error("Remote artifact URLs are not supported by this sync host.");
    }
    if (/^file:\/\//i.test(candidate)) {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        throw new Error("Artifact file URL is invalid.");
      }
    }
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(args.projectRoot, candidate);
    let resolvedArtifactPath: string;
    try {
      resolvedArtifactPath = resolvePathWithinRoot(layout.artifactsDir, absolute);
    } catch {
      throw new Error("Artifact path must resolve within .ade/artifacts.");
    }
    if (!fs.existsSync(resolvedArtifactPath) || !fs.statSync(resolvedArtifactPath).isFile()) {
      throw new Error("Artifact file does not exist.");
    }
    return resolvedArtifactPath;
  }

  function isMobilePeer(peer: PeerState): boolean {
    return peer.metadata?.platform === "iOS" || peer.metadata?.deviceType === "phone";
  }

  function assertMobileFileMutationAllowed(peer: PeerState, payload: SyncFileRequest): void {
    if (!MOBILE_MUTATING_FILE_ACTIONS.has(payload.action)) return;
    if (!isMobilePeer(peer)) return;

    const workspaceId = toOptionalString((payload as { args?: { workspaceId?: unknown } }).args?.workspaceId);
    if (!workspaceId) return;
    const workspace = args.fileService.listWorkspaces({ includeArchived: true })
      .find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.mobileReadOnly === true || workspace.isReadOnlyByDefault) {
      throw new Error("Mobile file access is read-only for this workspace.");
    }
  }

  function isMobileLaneFileMutationBlocked(payload: SyncCommandPayload): boolean {
    const laneId = toOptionalString((payload.args as Record<string, unknown> | null | undefined)?.laneId);
    if (!laneId) return false;
    const workspace = args.fileService.listWorkspaces({ includeArchived: true })
      .find((entry) => entry.laneId === laneId);
    return workspace ? workspace.mobileReadOnly === true || workspace.isReadOnlyByDefault : true;
  }

  async function handleFileRequest(peer: PeerState, requestId: string | null, payload: SyncFileRequest): Promise<void> {
    const respond = (response: SyncFileResponsePayload) => {
      sendRequired(peer, "file_response", response, requestId);
    };

    try {
      assertMobileFileMutationAllowed(peer, payload);
      let result:
        | FilesWorkspace[]
        | FileTreeNode[]
        | FileContent
        | FilesQuickOpenItem[]
        | FilesSearchTextMatch[]
        | SyncFileBlob
        | { ok: true } = { ok: true };

      switch (payload.action) {
        case "listWorkspaces":
          result = args.fileService.listWorkspaces(payload.args ?? {});
          break;
        case "listTree":
          result = await args.fileService.listTree(payload.args);
          break;
        case "readFile":
          result = fileContentToBlob(payload.args.path, args.fileService.readFile(payload.args));
          break;
        case "writeText":
          args.fileService.writeWorkspaceText(payload.args);
          result = { ok: true };
          break;
        case "createFile":
          args.fileService.createFile(payload.args);
          result = { ok: true };
          break;
        case "createDirectory":
          args.fileService.createDirectory(payload.args);
          result = { ok: true };
          break;
        case "rename":
          args.fileService.rename(payload.args);
          result = { ok: true };
          break;
        case "deletePath":
          args.fileService.deletePath(payload.args);
          result = { ok: true };
          break;
        case "quickOpen":
          result = await args.fileService.quickOpen(payload.args);
          break;
        case "searchText":
          result = await args.fileService.searchText(payload.args);
          break;
        case "readArtifact": {
          const artifactPath = resolveArtifactPath(payload.args);
          result = createBlobFromBuffer(normalizeRelative(path.relative(args.projectRoot, artifactPath)), fs.readFileSync(artifactPath));
          break;
        }
        default:
          throw new Error(`Unsupported file action: ${(payload as { action?: string }).action ?? "unknown"}`);
      }

      respond({
        ok: true,
        action: payload.action,
        result,
      });
    } catch (error) {
      respond({
        ok: false,
        action: payload.action,
        error: {
          code: "file_request_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async function handleCommand(peer: PeerState, requestId: string | null, payload: SyncCommandPayload): Promise<void> {
    const commandId = toOptionalString(payload.commandId) ?? requestId ?? `cmd-${Date.now()}`;
    const requestedProjectId = toOptionalString(payload.projectId);
    const hostProjectId = toOptionalString(args.projectId);
    const commandScopeKey = requestedProjectId ?? hostProjectId ?? args.projectRoot;
    const commandCacheKey = mobileCommandCacheKey(commandScopeKey, peer, commandId);
    const commandArgsKey = stableJsonKey(payload.args ?? {});
    const commandArgsFingerprint = mobileCommandArgsFingerprint(commandArgsKey);
    pruneMobileCommandResultCache();

    const sendResult = (record: CachedMobileCommand | null, result: SyncCommandResultPayload) => {
      if (!record) {
        sendRequired(peer, "command_result", result, requestId);
        return;
      }
      record.result = result;
      record.completedAtMs = Date.now();
      lastCommandResultLatencyMs = Math.max(0, record.completedAtMs - record.acceptedAtMs);
      const waiters = record.waiters.splice(0);
      for (const waiter of waiters) {
        sendRequired(waiter.peer, "command_result", result, waiter.requestId);
      }
      pruneMobileCommandResultCache();
      try {
        writePersistedCommandLedger();
      } catch (error) {
        args.logger.warn("sync_host.command_ledger_write_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const startCommandRecord = (ack: SyncCommandAckPayload): CachedMobileCommand | null => {
      sendRequired(peer, "command_ack", ack, requestId);
      if (!commandCacheKey) return null;
      const record: CachedMobileCommand = {
        commandId,
        action: payload.action,
        argsKey: commandArgsKey,
        argsFingerprint: commandArgsFingerprint,
        ack,
        result: null,
        waiters: [{ peer, requestId }],
        acceptedAtMs: Date.now(),
        completedAtMs: null,
      };
      mobileCommandResultCache.set(commandCacheKey, record);
      return record;
    };
    const existingCommand = commandCacheKey ? mobileCommandResultCache.get(commandCacheKey) : null;
    if (existingCommand) {
      if (existingCommand.action !== payload.action || existingCommand.argsFingerprint !== commandArgsFingerprint) {
        commandConflictCount += 1;
        const mismatchResult: SyncCommandResultPayload = {
          commandId,
          ok: false,
          error: {
            code: "duplicate_command_mismatch",
            message: "A command with this id already exists for a different action or payload.",
          },
        };
        sendRequired(peer, "command_ack", {
          commandId,
          accepted: false,
          status: "rejected",
          message: mismatchResult.error?.message ?? null,
        }, requestId);
        sendRequired(peer, "command_result", mismatchResult, requestId);
        return;
      }
      commandReplayCount += 1;
      sendRequired(peer, "command_ack", existingCommand.ack, requestId);
      if (existingCommand.result) {
        sendRequired(peer, "command_result", existingCommand.result, requestId);
      } else {
        addMobileCommandWaiter(existingCommand, peer, requestId);
      }
      return;
    }

    const reject = (message: string, code = "unsupported_command") => {
      const ack: SyncCommandAckPayload = {
        commandId,
        accepted: false,
        status: "rejected",
        message,
      };
      const result: SyncCommandResultPayload = {
        commandId,
        ok: false,
        error: {
          code,
          message,
        },
      };
      sendResult(startCommandRecord(ack), result);
    };

    const descriptor = remoteCommandService.getDescriptor(payload.action);
    const policy = descriptor?.policy ?? null;
    const shouldRouteToProject =
      Boolean(args.remoteCommandExecutor)
      && Boolean(requestedProjectId)
      && requestedProjectId !== hostProjectId;
    if (requestedProjectId && hostProjectId && requestedProjectId !== hostProjectId && !shouldRouteToProject) {
      reject("This ADE machine is hosting a different project. Select the project again and retry.", "project_not_open");
      return;
    }
    if (payload.action === "notification_prefs") {
      // iOS bridges `SyncService.setMutePush` through the command envelope
      // rather than a second `notification_prefs` envelope. We translate by
      // merging `{ muteUntil }` into the device's existing prefs (or the
      // default prefs if none have been uploaded yet) so the notification
      // bus starts gating immediately — the same `isAllowedByPrefs` path the
      // envelope-based update feeds.
      const deviceId = peer.metadata?.deviceId;
      if (!deviceId) {
        reject("notification_prefs requires an authenticated device.", "invalid_command");
        return;
      }
      const rawArgs = (payload.args as Record<string, unknown> | null | undefined) ?? {};
      const rawMute = rawArgs.muteUntil;
      const muteUntil = typeof rawMute === "string" && rawMute.length > 0 ? rawMute : null;
      const existing = readNotificationPrefsForDevice(deviceId);
      storeNotificationPrefsForDevice(deviceId, { ...existing, muteUntil });
      const ack: SyncCommandAckPayload = {
        commandId,
        accepted: true,
        status: "accepted",
        message: muteUntil ? `Muted pushes until ${muteUntil}.` : "Cleared push mute.",
      };
      sendResult(startCommandRecord(ack), {
        commandId,
        ok: true,
        result: { ok: true, muteUntil },
      });
      return;
    }
    if (payload.action === "lanes.presence.announce" || payload.action === "lanes.presence.release") {
      if (requestedProjectId && hostProjectId && requestedProjectId !== hostProjectId) {
        reject("Lane presence is not available for a project that is not open in this phone sync host.", "project_not_open");
        return;
      }
      if (hostProjectId && !requestedProjectId) {
        reject(`${payload.action} requires projectId. Select the project again and retry.`, "missing_project");
        return;
      }
      const laneId = normalizeLaneId((payload.args as Record<string, unknown> | null | undefined)?.laneId as string | null);
      if (!laneId) {
        reject(`${payload.action} requires laneId.`, "invalid_command");
        return;
      }
      const marker = buildRemotePresenceMarker(peer);
      if (!marker) {
        reject("Lane presence requires authenticated peer metadata.", "invalid_command");
        return;
      }
      const changed = payload.action === "lanes.presence.announce"
        ? upsertLanePresence({ laneId, marker, source: "remote" })
        : removeLanePresence(laneId, marker.deviceId);
      if (changed) {
        args.onStateChanged?.();
        broadcastBrainStatus();
      }
      const ack: SyncCommandAckPayload = {
        commandId,
        accepted: true,
        status: "accepted",
        message: payload.action === "lanes.presence.announce"
          ? `Marked ${laneId} as open on ${marker.displayName}.`
          : `Released ${laneId} on ${marker.displayName}.`,
      };
      sendResult(startCommandRecord(ack), {
        commandId,
        ok: true,
        result: { ok: true },
      });
      return;
    }
    if (!policy) {
      reject(`Unsupported remote command: ${payload.action}.`);
      return;
    }
    if (descriptor?.scope === "project") {
      if (hostProjectId && !requestedProjectId) {
        reject(`Remote command ${payload.action} requires projectId. Select the project again and retry.`, "missing_project");
        return;
      }
      if (requestedProjectId && !hostProjectId) {
        reject(`Remote command ${payload.action} requires an open project on this ADE machine.`, "project_not_open");
        return;
      }
    }
    if (!policy.viewerAllowed) {
      reject(`Remote command ${payload.action} is not available to paired controller devices.`, "forbidden_command");
      return;
    }
    if (payload.action === "files.writeTextAtomic" && isMobilePeer(peer) && isMobileLaneFileMutationBlocked(payload)) {
      reject("Mobile file access is read-only for this workspace.", "mobile_read_only");
      return;
    }
    if (policy.localOnly || policy.requiresApproval) {
      reject(`Remote command ${payload.action} requires approval on this machine.`, "approval_required");
      return;
    }

    const acceptedRecord = startCommandRecord({
      commandId,
      accepted: true,
      status: "accepted",
      message: `Executing ${payload.action}.`,
    });

    try {
      const executor = shouldRouteToProject && args.remoteCommandExecutor
        ? args.remoteCommandExecutor
        : remoteCommandService;
      const created = await executor.execute(payload);
      sendResult(acceptedRecord, {
        commandId,
        ok: true,
        result: decorateCommandResult(payload.action, created),
      });
    } catch (error) {
      sendResult(acceptedRecord, {
        commandId,
        ok: false,
        error: {
          code: "command_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  function rejectProjectScopedEnvelope(
    peer: PeerState,
    type: SyncEnvelope["type"],
    requestId: string | null,
    payload: unknown,
    resolution: Extract<SyncHostProjectScopeResolution, { ok: false }>,
  ): void {
    args.logger.warn("sync_host.project_scope_rejected", {
      type,
      requestId,
      code: resolution.code,
      expectedProjectId: resolution.expectedProjectId,
      receivedProjectId: resolution.receivedProjectId,
      peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
    });

    if (type === "changeset_batch") {
      const batchPayload = (payload ?? {}) as Partial<SyncChangesetBatchPayload>;
      sendRequired(peer, "changeset_ack", {
        batchId: toOptionalString(batchPayload.batchId) ?? requestId ?? "",
        fromDbVersion: Number(batchPayload.fromDbVersion ?? 0),
        toDbVersion: Number(batchPayload.toDbVersion ?? 0),
        appliedDbVersion: args.db.sync.getDbVersion(),
        appliedCount: 0,
        ok: false,
        error: {
          code: resolution.code,
          message: resolution.message,
        },
      } satisfies SyncChangesetAckPayload, requestId);
      return;
    }

    if (type === "file_request") {
      const action = toOptionalString((payload as Partial<SyncFileRequest> | null | undefined)?.action) ?? "unknown";
      sendRequired(peer, "file_response", {
        ok: false,
        action: action as SyncFileRequest["action"],
        error: {
          code: resolution.code,
          message: resolution.message,
        },
      } satisfies SyncFileResponsePayload, requestId);
    }
  }

  async function handleMessage(peer: PeerState, raw: RawData): Promise<void> {
    const rawText = wsDataToText(raw);
    const envelope = parseSyncEnvelope(rawText);
    const heartbeatAwaitedAt = peer.awaitingHeartbeatAt;
    peer.lastSeenAt = nowIso();
    peer.awaitingHeartbeatAt = null;
    peer.missedHeartbeatCount = 0;

    if (!peer.authenticated) {
      if (envelope.type !== "hello" && envelope.type !== "pairing_request") {
        send(peer.ws, "hello_error", {
          code: "invalid_hello",
          message: "Authenticate with hello or pairing_request before sending other messages.",
        }, envelope.requestId);
        try {
          peer.ws.close(4003, "Authentication required");
        } catch {
          // ignore
        }
        return;
      }
      if (envelope.type === "pairing_request") {
        const pairing = parsePairingRequestPayload(envelope.payload);
        if (!pairing) {
          send(peer.ws, "pairing_result", {
            ok: false,
            error: {
              code: "pairing_failed",
              message: "Invalid pairing request payload.",
            },
          }, envelope.requestId);
          try { peer.ws.close(4003, "Pairing failed"); } catch { /* ignore */ }
          return;
        }
        const cooldownMs = pairingCooldownMsRemaining(peer.remoteAddress);
        if (cooldownMs > 0) {
          const minutes = Math.ceil(cooldownMs / 60_000);
          send(peer.ws, "pairing_result", {
            ok: false,
            error: {
              code: "pairing_failed",
              message: `Too many failed PIN attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
            },
          }, envelope.requestId);
          try { peer.ws.close(4004, "Pairing cooldown"); } catch { /* ignore */ }
          return;
        }
        try {
          const result = pairingStore.pairPeer(pairing.peer, pairing.code);
          if (peer.remoteAddress) {
            pairFailures.delete(peer.remoteAddress);
          }
          args.deviceRegistryService?.upsertPeerMetadata(pairing.peer, {
            lastSeenAt: nowIso(),
            lastHost: peer.remoteAddress,
            lastPort: peer.remotePort,
          });
          send(peer.ws, "pairing_result", {
            ok: true,
            deviceId: result.deviceId,
            secret: result.secret,
          }, envelope.requestId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const thrownCode = (error as { code?: string } | null)?.code ?? null;
          const resultCode: "pin_not_set" | "invalid_pin" | "pairing_failed" =
            thrownCode === "pin_not_set" || thrownCode === "invalid_pin"
              ? thrownCode
              : "pairing_failed";
          send(peer.ws, "pairing_result", {
            ok: false,
            error: {
              code: resultCode,
              message,
            },
          }, envelope.requestId);
          // Drop the socket after any failed pair so brute-forcing the 6-digit
          // PIN requires a new TCP+WS handshake per attempt, and track per-IP
          // failures so sustained guessers hit a cooldown.
          if (resultCode === "invalid_pin" || resultCode === "pairing_failed") {
            registerPairFailure(peer.remoteAddress);
          }
          try { peer.ws.close(4003, "Pairing failed"); } catch { /* ignore */ }
        }
        return;
      }
      const hello = parseHelloPayload(envelope.payload);
      if (!hello) {
        send(peer.ws, "hello_error", {
          code: "invalid_hello",
          message: "Invalid hello payload.",
        }, envelope.requestId);
        try {
          peer.ws.close(4003, "Authentication failed");
        } catch {
          // ignore
        }
        return;
      }
      const authFailed = (() => {
        if (hello.auth?.kind === "bootstrap") {
          return hello.auth.token !== bootstrapToken;
        }
        if (hello.auth?.kind === "paired") {
          if (hello.auth.deviceId !== hello.peer.deviceId) return true;
          return !pairingStore.authenticate(hello.auth.deviceId, hello.auth.secret);
        }
        return true;
      })();
      if (authFailed) {
        send(peer.ws, "hello_error", {
          code: "auth_failed",
          message: "Sync authentication failed.",
        }, envelope.requestId);
        try {
          peer.ws.close(4003, "Authentication failed");
        } catch {
          // ignore
        }
        return;
      }

      closeExistingPeersForDevice(hello.peer.deviceId, peer);
      peer.authenticated = true;
      peer.metadata = hello.peer;
      const auth = hello.auth ?? { kind: "bootstrap", token: "" };
      peer.authKind = auth.kind;
      peer.pairedDeviceId = auth.kind === "paired" ? auth.deviceId : null;
      peer.lastKnownServerDbVersion = Math.max(0, Math.floor(hello.peer.dbVersion));
      args.deviceRegistryService?.upsertPeerMetadata(hello.peer, {
        lastSeenAt: nowIso(),
        lastHost: peer.remoteAddress,
        lastPort: peer.remotePort,
      });
      const projectCatalog = await buildProjectCatalogPayload();
      send(peer.ws, "hello_ok", buildSyncHostHelloOkPayload({
        peer: hello.peer,
        brain: readBrainMetadata(),
        serverDbVersion: args.db.sync.getDbVersion(),
        heartbeatIntervalMs,
        pollIntervalMs,
        projectCatalog,
        projectCatalogEnabled: Boolean(args.projectCatalogProvider),
        remoteCommandSupportedActions: remoteCommandService.getSupportedActions(),
        remoteCommandDescriptors: remoteCommandService.getDescriptors(),
        localCommandDescriptors: localPresenceCommandDescriptors,
        compressionThresholdBytes,
        maxProjectCatalogEnvelopeBytes,
      }), envelope.requestId);
      args.onStateChanged?.();
      await pumpChanges();
      broadcastBrainStatus();
      return;
    }

    const projectScope = resolveSyncHostInboundProjectScope(envelope.type, envelope.projectId, args.projectId);
    if (!projectScope.ok) {
      rejectProjectScopedEnvelope(peer, envelope.type, envelope.requestId, envelope.payload, projectScope);
      return;
    }
    if (projectScope.usedSingleProjectFallback) {
      args.logger.warn("sync_host.project_scope_missing", {
        type: envelope.type,
        requestId: envelope.requestId,
        resolvedProjectId: projectScope.projectId,
        peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
      });
    }

    switch (envelope.type) {
      case "project_catalog_request": {
        sendProjectCatalog(peer, await buildProjectCatalogPayload(), envelope.requestId);
        break;
      }
      case "project_switch_request": {
        await handleProjectSwitchRequest(peer, envelope.requestId, envelope.payload as SyncProjectSwitchRequestPayload);
        break;
      }
      case "heartbeat": {
        const payload = envelope.payload as { kind?: string; sentAt?: string } | null;
        if (payload?.kind === "ping") {
          send(peer.ws, "heartbeat", {
            kind: "pong",
            sentAt: payload.sentAt ?? nowIso(),
            dbVersion: args.db.sync.getDbVersion(),
          }, envelope.requestId);
        } else if (payload?.kind === "pong" && heartbeatAwaitedAt) {
          const now = Date.now();
          const sentAtMs = Date.parse(heartbeatAwaitedAt);
          peer.latencyMs = Number.isFinite(sentAtMs) ? Math.max(0, now - sentAtMs) : null;
          peer.awaitingHeartbeatAt = null;
        }
        break;
      }
      case "changeset_batch": {
        const payload = (envelope.payload ?? {}) as SyncChangesetBatchPayload;
        const batchId = payload.batchId || envelope.requestId || "";
        const changes = Array.isArray(payload.changes) ? payload.changes as CrsqlChangeRow[] : [];
        try {
          let appliedCount = 0;
          if (changes.length > 0) {
            const applyResult = args.db.sync.applyChanges(changes);
            appliedCount = applyResult.appliedCount;
            peer.lastAppliedAt = nowIso();
            lastBroadcastAt = nowIso();
            args.onStateChanged?.();
            broadcastBrainStatus();
          }
          sendRequired(peer, "changeset_ack", {
            batchId,
            fromDbVersion: Number(payload.fromDbVersion ?? 0),
            toDbVersion: Number(payload.toDbVersion ?? 0),
            appliedDbVersion: args.db.sync.getDbVersion(),
            appliedCount,
            ok: true,
          } satisfies SyncChangesetAckPayload, envelope.requestId);
        } catch (error) {
          sendRequired(peer, "changeset_ack", {
            batchId,
            fromDbVersion: Number(payload.fromDbVersion ?? 0),
            toDbVersion: Number(payload.toDbVersion ?? 0),
            appliedDbVersion: args.db.sync.getDbVersion(),
            appliedCount: 0,
            ok: false,
            error: {
              code: "changeset_apply_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          } satisfies SyncChangesetAckPayload, envelope.requestId);
          throw error;
        }
        break;
      }
      case "changeset_ack": {
        handleChangesetAck(peer, envelope.payload as SyncChangesetAckPayload);
        break;
      }
      case "file_request":
        await handleFileRequest(peer, envelope.requestId, envelope.payload as SyncFileRequest);
        break;
      case "terminal_subscribe": {
        const payload = envelope.payload as { sessionId?: string; maxBytes?: number } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (!sessionId) break;
        peer.subscribedSessionIds.add(sessionId);
        const session = args.sessionService.get(sessionId);
        const transcript = session
          ? await args.ptyService.readTranscriptTail({
              sessionId,
              maxBytes: Math.max(1_024, Math.min(2_000_000, Math.floor(payload?.maxBytes ?? DEFAULT_TERMINAL_SNAPSHOT_BYTES))),
              raw: true,
              alignToLineBoundary: true,
            })
          : "";
        const snapshot: SyncTerminalSnapshotPayload = {
          sessionId,
          transcript,
          status: session?.status ?? null,
          runtimeState: session?.runtimeState ?? null,
          lastOutputPreview: session?.lastOutputPreview ?? null,
          capturedAt: nowIso(),
        };
        sendRequired(peer, "terminal_snapshot", snapshot, envelope.requestId);
        break;
      }
      case "terminal_unsubscribe": {
        const payload = envelope.payload as { sessionId?: string } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (sessionId) {
          peer.subscribedSessionIds.delete(sessionId);
        }
        break;
      }
      case "terminal_input": {
        // Forward keystrokes / pasted text from a mobile client into the
        // active PTY for the named session. We require a prior subscribe so
        // only an attached peer can drive the shell — protects against an
        // attacker who acquired a session id but is not actively viewing.
        const payload = envelope.payload as { sessionId?: string; data?: string } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        const data = typeof payload?.data === "string" ? payload.data : null;
        if (!sessionId || data == null) break;
        if (!peer.subscribedSessionIds.has(sessionId)) {
          args.logger.warn("sync.terminal_input_unsubscribed_session", { sessionId });
          break;
        }
        const accepted = args.ptyService.writeBySessionId(sessionId, data);
        if (!accepted) {
          args.logger.info("sync.terminal_input_no_active_pty", { sessionId });
        }
        break;
      }
      case "terminal_resize": {
        // Mobile clients re-emit this whenever their visible viewport
        // changes (rotation, split view, dynamic font). We forward to the
        // active PTY so command-line apps re-flow correctly. Out-of-bound
        // values are clamped inside ptyService.
        const payload = envelope.payload as { sessionId?: string; cols?: number; rows?: number } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        const cols = typeof payload?.cols === "number" ? Math.floor(payload.cols) : null;
        const rows = typeof payload?.rows === "number" ? Math.floor(payload.rows) : null;
        if (!sessionId || cols == null || rows == null) break;
        if (!peer.subscribedSessionIds.has(sessionId)) break;
        args.ptyService.resizeBySessionId(sessionId, cols, rows);
        break;
      }
      case "chat_subscribe": {
        const payload = envelope.payload as { sessionId?: string; maxBytes?: number } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (!sessionId) break;
        peer.subscribedChatSessionIds.add(sessionId);

        const session = args.sessionService.get(sessionId);
        const maxBytes = Math.max(
          1_024,
          Math.min(2_000_000, Math.floor(typeof payload?.maxBytes === "number" ? payload.maxBytes : DEFAULT_TERMINAL_SNAPSHOT_BYTES)),
        );
        const raw = session?.transcriptPath
          ? await args.sessionService.readTranscriptTail(
              session.transcriptPath,
              maxBytes,
              { raw: true, alignToLineBoundary: true },
            )
          : "";
        const events = parseAgentChatTranscript(raw).filter((event) => event.sessionId === sessionId);
        const transcriptSize = session?.transcriptPath && fs.existsSync(session.transcriptPath)
          ? fs.statSync(session.transcriptPath).size
          : 0;
        peer.chatTranscriptOffsets.set(sessionId, transcriptSize);
        const snapshot: SyncChatSubscribeSnapshotPayload = {
          sessionId,
          capturedAt: nowIso(),
          truncated: transcriptSize > maxBytes,
          events,
        };
        sendRequired(peer, "chat_subscribe", snapshot, envelope.requestId);
        break;
      }
      case "chat_unsubscribe": {
        const payload = envelope.payload as SyncChatUnsubscribePayload | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (sessionId) {
          peer.subscribedChatSessionIds.delete(sessionId);
          peer.chatTranscriptOffsets.delete(sessionId);
          peer.chatEventIdsSent.delete(sessionId);
        }
        break;
      }
      case "command":
        await handleCommand(peer, envelope.requestId, {
          ...(envelope.payload as SyncCommandPayload),
          ...(!toOptionalString((envelope.payload as SyncCommandPayload | null)?.projectId) && envelope.projectId
            ? { projectId: envelope.projectId }
            : {}),
        });
        break;
      case "register_push_token": {
        const payload = envelope.payload as SyncRegisterPushTokenPayload | null;
        handleRegisterPushToken(peer, envelope.requestId, payload);
        break;
      }
      case "notification_prefs": {
        const payload = envelope.payload as SyncNotificationPrefsPayload | null;
        handleNotificationPrefs(peer, payload);
        break;
      }
      case "send_test_push": {
        const payload = envelope.payload as SyncSendTestPushPayload | null;
        await handleSendTestPush(peer, envelope.requestId, payload);
        break;
      }
      default:
        break;
    }
  }

  function handleRegisterPushToken(
    peer: PeerState,
    requestId: string | null | undefined,
    payload: SyncRegisterPushTokenPayload | null,
  ): void {
    const deviceId = peer.metadata?.deviceId;
    if (!deviceId) {
      args.logger.warn("sync_host.push_token_missing_device", {});
      sendRequired(peer, "command_ack", {
        commandId: "push-token:unknown",
        accepted: false,
        status: "missing_device_id",
        message: "Cannot store push token before device registration completes.",
      }, requestId ?? null);
      return;
    }
    if (!payload || typeof payload.token !== "string" || payload.token.trim().length === 0) {
      args.logger.warn("sync_host.push_token_missing", { deviceId });
      sendRequired(peer, "command_ack", {
        commandId: `push-token:${deviceId}:unknown`,
        accepted: false,
        status: "invalid_payload",
        message: "Push token registration did not include a token.",
      }, requestId ?? null);
      return;
    }
    const kind: ApnsPushTokenKind =
      payload.kind === "alert" || payload.kind === "activity-start" || payload.kind === "activity-update"
        ? payload.kind
        : "alert";
    if (kind === "activity-update" && !payload.activityId?.trim()) {
      args.logger.warn("sync_host.push_token_missing_activity_id", { deviceId });
      sendRequired(peer, "command_ack", {
        commandId: `push-token:${deviceId}:${kind}`,
        accepted: false,
        status: "missing_activity_id",
        message: "Live Activity update tokens require an activity id.",
      }, requestId ?? null);
      return;
    }
    const env: ApnsEnvironment = payload.env === "production" ? "production" : "sandbox";
    const stored = args.deviceRegistryService?.setApnsToken?.(deviceId, payload.token.trim(), kind, env, {
      bundleId: payload.bundleId,
      activityId: payload.activityId,
    });
    if (!stored) {
      sendRequired(peer, "command_ack", {
        commandId: `push-token:${deviceId}:${kind}`,
        accepted: false,
        status: "device_not_found",
        message: `Could not store ${kind} push token for ${deviceId}.`,
      }, requestId ?? null);
      return;
    }
    // Optional ack so the client can retry on failure.
    sendRequired(peer, "command_ack", {
      commandId: `push-token:${deviceId}:${kind}`,
      accepted: true,
      status: "accepted",
      message: `Stored ${kind} push token for ${deviceId}.`,
    }, requestId ?? null);
  }

  function handleNotificationPrefs(peer: PeerState, payload: SyncNotificationPrefsPayload | null): void {
    const deviceId = peer.metadata?.deviceId;
    if (!deviceId || !payload || !payload.prefs) return;
    storeNotificationPrefsForDevice(deviceId, normalizeNotificationPreferences(payload.prefs));
  }

  async function handleSendTestPush(
    peer: PeerState,
    requestId: string | null | undefined,
    payload: SyncSendTestPushPayload | null,
  ): Promise<void> {
    const deviceId = peer.metadata?.deviceId;
    if (!deviceId) return;
    const kind = payload?.kind === "activity" ? "activity" : "alert";
    if (!args.notificationEventBus) {
      if (isIosPeerConnected(deviceId)) {
        sendInAppNotification(deviceId, {
          category: "system",
          title: payload?.title?.trim() || "ADE test push",
          body: payload?.body?.trim() || "This device reached its paired ADE machine.",
          collapseId: "ade:test",
        });
        sendRequired(peer, "command_result", {
          commandId: `push-test:${deviceId}:${kind}`,
          ok: true,
          result: {
            mode: "in_app",
            message: "Test notification delivered in app. APNs is not wired in this runtime.",
          },
        }, requestId ?? null);
        return;
      }
      sendRequired(peer, "command_result", {
        commandId: `push-test:${deviceId}:${kind}`,
        ok: false,
        error: {
          code: "test_push_failed",
          message: "Notifications are not wired in this ADE runtime.",
        },
      }, requestId ?? null);
      return;
    }
    const result = await args.notificationEventBus.sendTestPush(deviceId, kind);
    sendRequired(peer, "command_result", {
      commandId: `push-test:${deviceId}:${kind}`,
      ok: result.ok,
      ...(result.ok ? {} : { error: { code: "test_push_failed", message: result.reason ?? "unknown" } }),
    }, requestId ?? null);
  }

  /**
   * Deliver a foreground-only notification to a specific iOS peer over the
   * existing WebSocket. Used by the notification bus when the device is
   * currently connected, in place of (or alongside) an APNs alert.
   */
  function sendInAppNotification(
    deviceId: string,
    payload: Omit<SyncInAppNotificationPayload, "generatedAt">,
  ): void {
    const fullPayload: SyncInAppNotificationPayload = {
      ...payload,
      generatedAt: nowIso(),
    };
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (peer.metadata?.deviceId !== deviceId) continue;
      send(peer.ws, "in_app_notification", fullPayload);
    }
  }

  function getNotificationPrefsForDevice(deviceId: string): NotificationPreferences | null {
    return readNotificationPrefsForDevice(deviceId);
  }

  function isIosPeerConnected(deviceId: string): boolean {
    for (const peer of peers) {
      if (peer.metadata?.deviceId !== deviceId) continue;
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      return true;
    }
    return false;
  }

  const getLanePresenceSnapshot = (): Array<{ laneId: string; devicesOpen: DeviceMarker[] }> => {
    return [...lanePresenceByLaneId.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((laneId) => ({
        laneId,
        devicesOpen: listLanePresenceMarkers(laneId),
      }))
      .filter((entry) => entry.devicesOpen.length > 0);
  };

  return {
    async waitUntilListening(): Promise<number> {
      if (startupError) {
        throw startupError;
      }
      if (server.address()) {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : DEFAULT_SYNC_HOST_PORT;
        publishLanDiscovery(port);
        publishTailnetDiscovery(port);
        return port;
      }
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          cleanup();
          resolve();
        };
        const onError = (error: unknown) => {
          cleanup();
          const normalized = error instanceof Error ? error : new Error(String(error));
          startupError = normalized;
          reject(normalized);
        };
        const cleanup = () => {
          server.off("listening", onListening);
          server.off("error", onError);
        };
        server.on("listening", onListening);
        server.on("error", onError);
        if (startupError) {
          cleanup();
          reject(startupError);
          return;
        }
        if (server.address()) {
          cleanup();
          resolve();
        }
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : DEFAULT_SYNC_HOST_PORT;
      publishLanDiscovery(port);
      publishTailnetDiscovery(port);
      return port;
    },

    getPort(): number | null {
      const address = server.address();
      return typeof address === "object" && address ? address.port : null;
    },

    getBootstrapToken(): string {
      return bootstrapToken;
    },

    setLocalActiveLanePresence(laneIds: string[]): void {
      setLocalActiveLanePresence(laneIds);
    },

    refreshLanDiscovery(options?: { forceLan?: boolean; forceTailnet?: boolean }): void {
      const address = server.address();
      if (typeof address === "object" && address) {
        publishLanDiscovery(address.port, { force: options?.forceLan });
        publishTailnetDiscovery(address.port, { force: options?.forceTailnet });
      }
    },

    setDiscoveryEnabled(enabled: boolean): void {
      if (discoveryEnabled === enabled) return;
      discoveryEnabled = enabled;
      const address = server.address();
      if (!enabled) {
        unpublishLanDiscovery();
        void unpublishTailnetDiscovery();
        updateTailnetDiscoveryStatus({
          state: "disabled",
          serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
          target: null,
          updatedAt: nowIso(),
          error: "Tailnet discovery is disabled for this background project context.",
          stderr: null,
        });
        return;
      }
      if (typeof address === "object" && address) {
        publishLanDiscovery(address.port, { force: true });
        publishTailnetDiscovery(address.port, { force: true });
      }
    },

    revokePairedDevice(deviceId: string): void {
      pairingStore.revoke(deviceId);
      let revokedConnectedPeer = false;
      for (const peer of peers) {
        if (!peer.authenticated || peer.authKind !== "paired" || peer.pairedDeviceId !== deviceId) continue;
        revokedConnectedPeer = true;
        peer.authenticated = false;
        peer.metadata = null;
        peer.authKind = null;
        peer.pairedDeviceId = null;
        try {
          peer.ws.close(4003, "Pairing revoked");
        } catch {
          // ignore close failures
        }
      }
      if (revokedConnectedPeer) {
        args.onStateChanged?.();
        broadcastBrainStatus();
      }
    },

    getPeerStates(): SyncPeerConnectionState[] {
      const dbVersion = args.db.sync.getDbVersion();
      const latestByDevice = new Map<string, SyncPeerConnectionState>();
      for (const peer of [...peers]
        .map((peer) => toSyncPeerConnectionState(peer, dbVersion))
        .filter((peer): peer is SyncPeerConnectionState => peer != null)) {
        const existing = latestByDevice.get(peer.deviceId);
        if (!existing || peer.connectedAt > existing.connectedAt) {
          latestByDevice.set(peer.deviceId, peer);
        }
      }
      return [...latestByDevice.values()];
    },

    getTailnetDiscoveryStatus(): SyncTailnetDiscoveryStatus {
      return { ...tailnetDiscoveryStatus };
    },

    getLanePresenceSnapshot(): Array<{ laneId: string; devicesOpen: DeviceMarker[] }> {
      return getLanePresenceSnapshot();
    },

    getChatSubscriptionSnapshot(): Array<{ deviceId: string; subscribedChatSessionIds: string[] }> {
      return [...peers]
        .map((peer) => {
          if (!peer.metadata) return null;
          return {
            deviceId: peer.metadata.deviceId,
            subscribedChatSessionIds: [...peer.subscribedChatSessionIds].sort(),
          };
        })
        .filter((peer): peer is { deviceId: string; subscribedChatSessionIds: string[] } => peer != null);
    },

    getBrainStatusSnapshot(): SyncBrainStatusPayload {
      return buildBrainStatus();
    },

    async broadcastProjectCatalog(): Promise<void> {
      const payload = await buildProjectCatalogPayload();
      if (bonjourPort != null) {
        refreshLanDiscoveryProjects(bonjourPort, payload);
      }
      for (const peer of peers) {
        if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
        sendProjectCatalog(peer, payload);
      }
    },

    /**
     * Push an in-app notification to a specific iOS peer over the WebSocket.
     * Used by the notification event bus as the foreground-delivery path.
     */
    sendInAppNotification(
      deviceId: string,
      payload: Omit<SyncInAppNotificationPayload, "generatedAt">,
    ): void {
      sendInAppNotification(deviceId, payload);
    },

    /** Returns the latest announced notification prefs for a device, or null. */
    getNotificationPrefsForDevice(deviceId: string): NotificationPreferences | null {
      return getNotificationPrefsForDevice(deviceId);
    },

    /** Whether a given device is currently connected + authenticated. */
    isIosPeerConnected(deviceId: string): boolean {
      return isIosPeerConnected(deviceId);
    },

    handlePtyData(event: PtyDataEvent): void {
      const payload = {
        sessionId: event.sessionId,
        ptyId: event.ptyId,
        data: event.data,
        at: nowIso(),
      };
      for (const peer of peers) {
        if (!peer.authenticated || !peer.subscribedSessionIds.has(event.sessionId) || peer.ws.readyState !== WebSocket.OPEN) continue;
        if (isPeerBackpressured(peer)) continue;
        send(peer.ws, "terminal_data", payload);
      }
    },

    handlePtyExit(event: PtyExitEvent): void {
      const payload = {
        sessionId: event.sessionId,
        ptyId: event.ptyId,
        exitCode: event.exitCode,
        at: nowIso(),
      };
      for (const peer of peers) {
        if (!peer.authenticated || !peer.subscribedSessionIds.has(event.sessionId) || peer.ws.readyState !== WebSocket.OPEN) continue;
        if (isPeerBackpressured(peer)) continue;
        send(peer.ws, "terminal_exit", payload);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      localActiveLaneIds = new Set<string>();
      lanePresenceByLaneId.clear();
      dropInFlightCommandRecordsForProject();
      chatEventSubscription?.();
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      clearInterval(brainStatusTimer);
      unpublishLanDiscovery();
      try {
        await unpublishTailnetDiscovery();
      } catch {
        // Never throw from dispose.
      }
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        for (const peer of peers) {
          try {
            peer.ws.close();
          } catch {
            // ignore
          }
        }
        if (!server.address()) {
          finish();
          return;
        }
        try {
          server.close(() => finish());
        } catch {
          finish();
        }
      });
      if (bonjourAnnouncement) {
        try {
          bonjourAnnouncement.stop?.();
        } catch {
          // ignore cleanup failures
        }
        bonjourAnnouncement = null;
      }
      bonjourPort = null;
      bonjourSignature = null;
      if (bonjourInstance) {
        try {
          bonjourInstance.destroy();
        } catch {
          // ignore cleanup failures
        }
        bonjourInstance = null;
      }
    },
  };
}

export type SyncHostService = ReturnType<typeof createSyncHostService>;
