import fs from "node:fs";
import http from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runWithAbortSignal } from "./abortSignal";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  recordUsageInteraction,
  usageClientSurfaceFromPeer,
} from "../../../../desktop/src/main/services/usage/usageStatsStore";
import {
  readHistoryFileRange,
  readHistoryFileSize,
  resolveReadableHistoryPath,
} from "../../../../desktop/src/main/services/storage/historyCompression";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Bonjour, type Service as BonjourService } from "bonjour-service";
import { WebSocketServer, WebSocket } from "ws";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { compactChatEventForWire } from "../../../../desktop/src/shared/chatEventCompaction";
import { parseCodedErrorMessage } from "../../../../desktop/src/shared/codedError";
import {
  MOBILE_SYNC_COMPATIBILITY_CONTRACT_VERSION,
  MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS,
  evaluateMobileSyncCompatibility,
} from "../../../../desktop/src/shared/syncMobileCompatibility";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  CrsqlChangeRow,
  DeviceMarker,
  FileContent,
  FileTreeNode,
  FilesGitBlameResult,
  FilesGitStatusEvent,
  FilesListTreeChildrenResult,
  FilesQuickOpenItem,
  FilesReadFileRangeResult,
  FilesSearchTextMatch,
  FilesWorkspace,
  LaneDetailPayload,
  LaneListSnapshot,
  LaneSummary,
  PtyDataEvent,
  PtyExitEvent,
  PersonalChatScopeContract,
  SyncBrainStatusPayload,
  SyncApplicationCompressionCodec,
  SyncChangesetAckPayload,
  SyncChangesetBatchPayload,
  CloneProjectInput,
  SyncCommandAckPayload,
  SyncCommandPayload,
  SyncCommandResultPayload,
  CreateProjectInput,
  SyncDpopProof,
  SyncEnvelope,
  SyncChatEventPayload,
  SyncChatHistoryRequestPayload,
  SyncChatSubscribePayload,
  SyncChatSubscribeSnapshotPayload,
  SyncChatUnsubscribePayload,
  SyncFileBlob,
  SyncFileRequest,
  SyncFileResponsePayload,
  SyncHelloPayload,
  SyncHelloErrorPayload,
  SyncInvalidationBatchPayload,
  SyncMobileProjectSummary,
  SyncPairingRequestPayload,
  PairedRuntimeHelloOkPayload,
  SyncPeerConnectionState,
  SyncPeerMetadata,
  SyncProjectOpenRequestPayload,
  SyncProjectCatalogChunkPayload,
  SyncProjectCatalogPayload,
  SyncProjectForgetRequestPayload,
  SyncProjectForgetResultPayload,
  SyncProjectSwitchRequestPayload,
  SyncProjectSwitchResultPayload,
  SyncRosterProject,
  SyncRosterSnapshotPayload,
  SyncRosterDeltaPayload,
  SyncRosterSubscribePayload,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
  SyncRemoteCommandDescriptor,
  SyncRelayAuthorizationLease,
  SyncTailnetDiscoveryStatus,
  SyncTerminalHistoryResponsePayload,
  SyncTerminalDataPayload,
  SyncTerminalExitPayload,
  SyncTerminalInputAckPayload,
  SyncTerminalInputPayload,
  SyncTerminalSnapshotPayload,
} from "../../../../desktop/src/shared/types";
import {
  SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES,
  SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
  SYNC_INVALIDATION_BATCH_MAX_ENVELOPE_BYTES,
  SYNC_INVALIDATION_BATCH_MAX_TABLES,
  SYNC_INVALIDATION_TABLE_MAX_BYTES,
  SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
  SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY,
} from "../../../../desktop/src/shared/types";
import { parseAgentChatTranscript } from "../../../../desktop/src/shared/chatTranscript";
import { readTranscriptHistoryPage } from "../../../../desktop/src/main/services/chat/chatTranscriptHistoryPager";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { ProductAnalyticsService } from "../../../../desktop/src/main/services/analytics/productAnalyticsService";
import type { AccountAuthService } from "../account/accountAuthService";
import type { AccountAttestationConfig } from "../account/sharedAccountAuthService";
import { verifyClerkAccountAttestation } from "../account/accountAttestationVerifier";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { createAiIntegrationService } from "../../../../desktop/src/main/services/ai/aiIntegrationService";
import type { createCtoStateService } from "../../../../desktop/src/main/services/cto/ctoStateService";
import type { CtoMemoryService } from "../../../../desktop/src/main/services/cto/ctoMemoryService";
import type { createLinearCredentialService } from "../../../../desktop/src/main/services/cto/linearCredentialService";
import type { createLinearIssueTracker } from "../../../../desktop/src/main/services/cto/linearIssueTracker";
import type { createProjectConfigService } from "../../../../desktop/src/main/services/config/projectConfigService";
import type { createConflictService } from "../../../../desktop/src/main/services/conflicts/conflictService";
import type { createOperationService } from "../../../../desktop/src/main/services/history/operationService";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import type { createDiffService } from "../../../../desktop/src/main/services/diffs/diffService";
import type { createGitOperationsService } from "../../../../desktop/src/main/services/git/gitOperationsService";
import type { createGithubService } from "../../../../desktop/src/main/services/github/githubService";
import type { createAutoRebaseService } from "../../../../desktop/src/main/services/lanes/autoRebaseService";
import type { createLaneEnvironmentService } from "../../../../desktop/src/main/services/lanes/laneEnvironmentService";
import type { createLaneService } from "../../../../desktop/src/main/services/lanes/laneService";
import type { createLaneTemplateService } from "../../../../desktop/src/main/services/lanes/laneTemplateService";
import type { createPortAllocationService } from "../../../../desktop/src/main/services/lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../../../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { createOrchestrationService } from "../../../../desktop/src/main/services/orchestration/orchestrationService";
import type { createPtyService } from "../../../../desktop/src/main/services/pty/ptyService";
import type { createPrService } from "../../../../desktop/src/main/services/prs/prService";
import type { createPrSummaryService } from "../../../../desktop/src/main/services/prs/prSummaryService";
import type { createSessionDeltaService } from "../../../../desktop/src/main/services/sessions/sessionDeltaService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import type { createComputerUseArtifactBrokerService } from "../../../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { hasNullByte, normalizeRelative, nowIso, resolvePathWithinRoot, safeJsonParse, toOptionalString, uniqueStrings, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import type { DeviceRegistryService } from "./deviceRegistryService";
import { createSyncPairingStore, isValidDpopPublicKey, type SyncPairingRecord } from "./syncPairingStore";
import {
  createPairFailureTracker,
  type PairFailureSubject,
} from "./syncPairFailureTracker";
import {
  createSyncDpopNonceCache,
  evaluatePairedHelloDpop,
  syncDpopFailureMessage,
} from "./syncDpop";
import {
  authenticateSyncAccountHello,
  SYNC_REPAIR_REQUIRED_MESSAGE,
} from "./syncAccountHelloAuth";
import {
  createRelayAuthorizationLifecycle,
  SYNC_RELAY_AUTHORIZATION_CLOSE_CODE,
  type RelayAuthorizationLifecycle,
  type RelayAuthorizationSnapshot,
} from "./relayAuthorization";
import {
  createSyncPairedChannelService,
  isPairedRuntimeEnvelopeType,
} from "./syncPairedChannelService";
import type { SyncPinStore } from "./syncPinStore";
import type { SyncRuntimeNameStore } from "./syncRuntimeNameStore";
import {
  ADOPT_CHANNEL_CHALLENGE_TTL_MS,
  buildAdoptChallengeSignatureInput,
  buildAdoptHelloAad,
  buildAdoptHelloOkAad,
  decodeCanonicalBase64,
  deriveAdoptSessionKey,
  generateX25519EphemeralKeyPair,
  negotiateAdoptChannelAead,
  seal,
  signEd25519,
  supportedAdoptChannelAeads,
  unseal,
  type AdoptChannelAead,
} from "../../../../desktop/src/shared/sync/adoptChannelCrypto";
import {
  createMachineIdentitySigningStore,
  type MachineIdentitySigningStore,
} from "./machineIdentitySigningStore";
import {
  createSyncEnvelopeChunkAssembler,
  DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
  DEFAULT_SYNC_HOST_PORT,
  DEFAULT_SYNC_MAX_FRAME_BYTES,
  SYNC_HOST_MAX_PORT,
  encodeSyncEnvelope,
  encodeSyncEnvelopeFrames,
  mapPlatform,
  negotiateSyncApplicationCompression,
  normalizeSyncApplicationCompressionOffer,
  parseSyncEnvelope,
  parseSyncEnvelopeChunkPayload,
  sendSyncProtocolVersionMismatchAndClose,
  SYNC_CHUNKED_ENVELOPES_CAPABILITY,
  SyncProtocolVersionMismatchError,
  SYNC_RUNTIME_ONLY_CAPABILITY,
  wsDataToText,
  type ParsedSyncEnvelope,
} from "./syncProtocol";
// One parser for both ingress paths (this host and the brain's projectless
// fallback handler). See syncHelloProtocol.ts for why the copy had to go.
import {
  parseHelloPayload,
  parsePairingRequestPayload,
} from "./syncHelloProtocol";
import { resolveTailscaleCliPath } from "./resolveTailscaleCliPath";
import { createSyncRemoteCommandService, type SyncRemoteCommandService } from "./syncRemoteCommandService";
import { prepareProductAnalyticsRemoteCommand } from "./productAnalyticsRemoteCommand";
import { buildPairingConnectInfo } from "./syncPairingConnectInfo";
import type { PushPublisherService } from "../push/pushPublisherService";
import { trackBrainLoopWatchdogCommand } from "../runtime/brainLoopWatchdog";
import {
  buildChangesetBatchPayload,
  DEFAULT_MAX_CHANGESET_BATCH_BYTES,
  DEFAULT_MAX_CHANGESET_BATCH_ROWS,
} from "./changesetPump";
import {
  MOBILE_REPLICA_RESEED_MAX_BYTES,
  MOBILE_REPLICA_RESEED_MAX_EMPTY_WINDOWS_PER_POLL,
  MOBILE_REPLICA_RESEED_MAX_ROWS,
  SYNC_HOST_MOBILE_REPLICA_RESEED_GAP,
  advanceMobileReplicaReseedCache,
  buildMobileReplicaReseedPayload,
  createMobileReplicaReseedCache,
  type MobileReplicaReseedCache,
} from "./mobileReplicaReseed";
import {
  SYNC_HOST_BIND_HOST,
  SYNC_HOST_BIND_LOOPBACK_ONLY,
  SYNC_HOST_MAX_PAYLOAD_BYTES,
  type SharedSyncListener,
  type SyncPeerHandoffSnapshot,
  type SyncTransportOrigin,
} from "./sharedSyncListener";
import {
  assertAdeLoopbackListener,
  generateLoopbackNonce,
  isLoopbackShadowedError,
  probeAdeLoopbackListener,
  writeAdeLoopbackUpgradeResponse,
  type SyncLoopbackProbeResult,
  type SyncLoopbackValidationStatus,
} from "./syncLoopbackProbe";
export { selectChangesetBatchChunk } from "./changesetPump";
export { SYNC_HOST_MOBILE_REPLICA_RESEED_GAP } from "./mobileReplicaReseed";
const execFileAsync = promisify(execFile);

/**
 * Sunset this compatibility path once ADE's supported-client floor guarantees
 * every account adopter advertises `supportedAeads`. There is no
 * minSupportedVersion gate in the sync handshake today; removal belongs in the
 * `account_challenge` handler below, where a missing list can then be rejected
 * and the conditional AEAD transcript fields can become unconditional.
 */
export const ALLOW_LEGACY_UNBOUND_ADOPTION_AEAD = true;

// db_version window per pump poll. Large enough to cross sparse version
// ranges quickly (a few polls per million versions), small enough that the
// windowed crsql_changes scan completes in milliseconds.
const SYNC_EXPORT_VERSION_WINDOW = 250_000;

// High-churn / large-row tables the phone never reads (verified against the
// iOS Database.swift query surface). Excluding them from phone changesets is
// a PowerSync-style sync rule: it removes the multi-megabyte transcript and
// operations payloads that froze the iOS main thread (and got the app killed
// by the watchdog mid-apply), and cuts the bulk of backlog churn. The peer's
// ack watermark still advances through the filtered versions.
const MOBILE_CHANGESET_EXCLUDED_TABLES = new Set([
  "attempt_transcripts",
  "operations",
  "ai_usage_log",
  "budget_usage_records",
  "automation_runs",
  "automation_action_results",
  // 11.2 MB of a 28.1 MB synced project database (39.7%) — 258 rows averaging
  // 43 KB, one `files_json` at 1.65 MB — for data the phone was already fetching a second
  // time on its own. iOS reads this table in exactly one SELECT, the per-PR
  // detail query behind `fetchPullRequestSnapshot(prId:)`, and it reaches that
  // data through `prs.refresh` → `replacePullRequestHydration` on demand.
  // `prs.refresh` and `prs.getMobileSnapshot` are both in the REQUIRED remote
  // command set, so no paired build — however old — loses PR detail by not
  // receiving these rows.
  //
  // Lists and badges are unaffected: the slim `pull_requests` rows still sync,
  // and while four iOS projections name this table as an invalidation trigger,
  // no projection query actually reads a column from it.
  //
  // Devices paired before this keep the rows they already have (nothing deletes
  // them), so previously-opened PRs still render offline; they simply stop
  // receiving updates through the changeset pump and refresh on open instead.
  // This also ends a scroll-driven write path: the desktop Lanes page's
  // visible-lane refresh upserts here, so scrolling was pushing changesets to
  // every phone.
  "pull_request_snapshots",
]);

// Tables the host alone is authoritative for. `sync_cluster_state` is the
// replicating CRR that governs brain ownership; a paired peer must never be
// able to author a winning crsql_changes row for it (that would flip
// brain_device_id and make the host abdicate via refreshRoleState). Brain
// handover still happens through the explicit host-transfer RPC, not raw CRR.
const SYNC_HOST_AUTHORITATIVE_TABLES = new Set([
  "sync_cluster_state",
]);

// One rule for both directions: a host-authoritative table never crosses the
// CRR boundary (peers neither receive nor author it over sync).
const isHostAuthoritativeTable = (change: CrsqlChangeRow): boolean =>
  SYNC_HOST_AUTHORITATIVE_TABLES.has(change.table);

const MOBILE_REPLICA_RESEED_EXCLUDED_TABLES = [
  ...MOBILE_CHANGESET_EXCLUDED_TABLES,
  ...SYNC_HOST_AUTHORITATIVE_TABLES,
];

// Inbound peer changeset_batch ceilings. The 25MB envelope is the only other
// bound, so a single huge batch would block the DB inside one BEGIN IMMEDIATE
// transaction. The host's own outbound caps are 250 rows / 256KB; we allow a
// far more generous inbound ceiling (~10k rows / ~10MB) but still reject
// anything that could seize the DB, well under the 25MB envelope.
const MAX_INBOUND_CHANGESET_ROWS = DEFAULT_MAX_CHANGESET_BATCH_ROWS * 40;
const MAX_INBOUND_CHANGESET_BYTES = DEFAULT_MAX_CHANGESET_BATCH_BYTES * 40;

function isMobileChangesetPeer(peer: { metadata: SyncPeerMetadata | null }): boolean {
  return peer.metadata?.deviceType === "phone" || peer.metadata?.platform === "iOS";
}

/**
 * Ports still advertised through `tailscale serve` that ADE published on an
 * earlier run and never tore down.
 *
 * Only ADE's exact signature is reclaimed: a port inside ADE's own sync range
 * forwarding to 127.0.0.1 on the SAME port. A hand-rolled `tailscale serve`
 * that happens to sit in that range — anything forwarding elsewhere — is left
 * strictly alone.
 */
export function staleAdeTailnetServePorts(
  serveStatusJson: string,
  currentPort: number,
): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serveStatusJson);
  } catch {
    return [];
  }
  const tcp = (parsed as { TCP?: unknown } | null)?.TCP;
  if (!tcp || typeof tcp !== "object") return [];
  const stale: number[] = [];
  for (const [key, value] of Object.entries(tcp as Record<string, unknown>)) {
    const port = Number.parseInt(key, 10);
    if (!Number.isInteger(port)) continue;
    if (port < DEFAULT_SYNC_HOST_PORT || port > SYNC_HOST_MAX_PORT) continue;
    if (port === currentPort) continue;
    const forward = (value as { TCPForward?: unknown } | null)?.TCPForward;
    if (forward !== `127.0.0.1:${port}`) continue;
    stale.push(port);
  }
  return stale.sort((left, right) => left - right);
}

export function isRuntimeHostPairingRecord(
  record: SyncPairingRecord | null | undefined,
): boolean {
  return record?.runtimeHostGranted === true;
}

type SyncHostAuthKind = "bootstrap" | "paired" | "account" | null;

function isRecordBackedSyncAuthKind(kind: SyncHostAuthKind): kind is "paired" | "account" {
  return kind === "paired" || kind === "account";
}

export function isRuntimeOnlySyncPeer(args: {
  authKind: SyncHostAuthKind;
  pairingRecord: SyncPairingRecord | null;
  metadata: SyncPeerMetadata | null;
}): boolean {
  return isRecordBackedSyncAuthKind(args.authKind)
    && isRuntimeHostPairingRecord(args.pairingRecord)
    && Array.isArray(args.metadata?.capabilities)
    && args.metadata.capabilities.includes(SYNC_RUNTIME_ONLY_CAPABILITY);
}

const DEFAULT_SYNC_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_SYNC_HEARTBEAT_MISS_LIMIT = 2;
const MOBILE_SYNC_HEARTBEAT_MISS_LIMIT = 6;
const DEFAULT_SYNC_POLL_INTERVAL_MS = 400;
const DEFAULT_BRAIN_STATUS_INTERVAL_MS = 5_000;
const NATIVE_LAN_DISCOVERY_RECOVERY_DELAY_MS = 1_000;
const NATIVE_LAN_DISCOVERY_FALLBACK_MS = 30_000;
const DEFAULT_TERMINAL_SNAPSHOT_BYTES = 220_000;
const DEFAULT_TERMINAL_HISTORY_PAGE_BYTES = 262_144;
const MIN_TERMINAL_HISTORY_PAGE_BYTES = 4_096;
const MAX_TERMINAL_HISTORY_PAGE_BYTES = 524_288;
const MAX_PENDING_TERMINAL_SNAPSHOT_EVENTS = 256;
const MAX_PENDING_TERMINAL_SNAPSHOT_BYTES = 2_000_000;
const MAX_TERMINAL_SNAPSHOT_CAPTURE_ATTEMPTS = 4;
const PEER_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const REQUIRED_SEND_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const SEND_AND_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_SYNC_MESSAGE_TIMEOUT_MS = 60_000;
const DEFAULT_SYNC_SLOW_COMMAND_MS = 5_000;
const MAX_SYNC_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES = 512 * 1024;
export const SYNC_HOST_CHAT_ACTIVE_CHANGESET_BATCH_BYTES = 64 * 1024;
export const SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS = 2_000;
export const SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES = 128 * 1024;
export const SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MOBILE_COMMAND_RESULT_CACHE_TTL_MS = 30 * 60 * 1000;
const MOBILE_COMMAND_RESULT_CACHE_MAX_ENTRIES = 512;
const CHANGESET_ACK_TIMEOUT_MS = 10_000;
const SYNC_HOST_AUTH_TIMEOUT_MS = 15_000;
// All-projects roster (mobile hub) push cadence: trailing-edge debounce, hard
// max-wait cap so a steady event stream still flushes, and a slow safety poll
// that runs only while ≥1 peer is subscribed.
const ROSTER_DEBOUNCE_MS = 250;
const ROSTER_MAX_WAIT_MS = 1_000;
const ROSTER_SAFETY_POLL_MS = 15_000;
// Remote commands that add/remove a roster-visible lane or chat row (possibly
// in a non-active project via projectId routing). A successful one nudges the
// coalesced roster flush; everything else relies on chat events + safety poll.
const ROSTER_DIRTYING_COMMAND_ACTIONS = new Set<string>([
  "chat.create",
  "work.startCliSession",
  "work.resumeCliSession",
  "lanes.create",
  "lanes.createChild",
  "lanes.archive",
  "lanes.delete",
]);
const MAX_CHANGESET_SEND_ATTEMPTS = 6;
const MIN_RECOVERY_CHANGESET_BATCH_ROWS = 16;
const MIN_RECOVERY_CHANGESET_BATCH_BYTES = 16 * 1024;
const MAX_CHANGESET_RECOVERY_LEVEL = 4;
const CHANGESET_RECOVERY_BACKOFF_BASE_MS = 250;
const CHANGESET_RECOVERY_BACKOFF_MAX_MS = 4_000;
const LANE_PRESENCE_TTL_MS = 60_000;
const SYNC_MDNS_SERVICE_TYPE = "ade-sync";
const MAX_PROJECT_CATALOG_ENVELOPE_BYTES = 768 * 1024;
const MAX_PROJECT_CATALOG_CHUNK_BYTES = 192 * 1024;
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

export type SyncProjectCatalogMessage =
  | {
      type: "project_catalog";
      payload: SyncProjectCatalogPayload;
      requestId?: string | null;
    }
  | {
      type: "project_catalog_chunk";
      payload: SyncProjectCatalogChunkPayload;
      requestId?: string | null;
    };

export function splitSyncProjectCatalog(
  projects: SyncMobileProjectSummary[],
  maxChunkBytes = MAX_PROJECT_CATALOG_CHUNK_BYTES,
): SyncMobileProjectSummary[][] {
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
    if (chunk.length > 0 && chunkBytes + projectBytes > maxChunkBytes) {
      flush();
    }
    chunk.push(project);
    chunkBytes += projectBytes;
  }
  flush();
  return chunks;
}

export function buildSyncProjectCatalogMessages(args: {
  projectCatalog: SyncProjectCatalogPayload;
  requestId?: string | null;
  compressionThresholdBytes?: number;
  maxProjectCatalogEnvelopeBytes?: number;
}): SyncProjectCatalogMessage[] {
  const requestId = args.requestId ?? null;
  const envelopeBytes = Buffer.byteLength(encodeSyncEnvelope({
    type: "project_catalog",
    payload: args.projectCatalog,
    requestId,
    compressionThresholdBytes: args.compressionThresholdBytes,
  }), "utf8");
  if (envelopeBytes <= (args.maxProjectCatalogEnvelopeBytes ?? MAX_PROJECT_CATALOG_ENVELOPE_BYTES)) {
    return [{ type: "project_catalog", payload: args.projectCatalog, requestId }];
  }

  const chunks = splitSyncProjectCatalog(args.projectCatalog.projects);
  const total = Math.max(1, chunks.length);
  const catalogId = randomBytes(8).toString("hex");
  if (chunks.length === 0) {
    return [{
      type: "project_catalog_chunk",
      payload: {
        catalogId,
        index: 0,
        total,
        done: true,
        projects: [],
      },
      requestId,
    }];
  }
  return chunks.map((projects, index) => ({
    type: "project_catalog_chunk",
    payload: {
      catalogId,
      index,
      total,
      done: index === total - 1,
      projects,
    },
    requestId,
  }));
}
export function syncFileRequestWorkspaceId(payload: SyncFileRequest): string | null {
  switch (payload.action) {
    case "listTree":
    case "listTreeChildren":
    case "refreshGitDecorations":
    case "readFile":
    case "readFileRange":
    case "gitBlame":
    case "writeText":
    case "createFile":
    case "createDirectory":
    case "rename":
    case "deletePath":
    case "watchChanges":
    case "stopWatching":
    case "quickOpen":
    case "searchText":
      return toOptionalString(payload.args.workspaceId);
    case "listWorkspaces":
    case "readArtifact":
      return null;
    default:
      return null;
  }
}

export function visibleFileWorkspacesForPeer(workspaces: FilesWorkspace[], opts: { isMobile: boolean }): FilesWorkspace[] {
  return opts.isMobile ? workspaces.filter((workspace) => workspace.kind !== "external") : workspaces;
}

export function assertFileRequestWorkspaceVisibleToPeer(args: {
  isMobile: boolean;
  workspace: FilesWorkspace | null;
}): void {
  if (args.isMobile && args.workspace?.kind === "external") {
    throw new Error("External local files are not available on mobile.");
  }
}

/**
 * Concurrency model for the per-peer message queue.
 *
 * Everything used to run on one serialized chain, so a cold search index build
 * or a git blame head-of-line-blocked every other read from the same client.
 * Reads now overlap each other — up to MAX_CONCURRENT_PEER_READS at a time —
 * while every other envelope stays a barrier: a write waits for all preceding
 * work and every later read waits for that write. A read therefore still
 * observes every mutation the peer sent before it, and the only new
 * interleaving is read-with-read, which these services already face from the
 * desktop renderer's parallel IPC calls.
 *
 * Classification is deliberately conservative: file reads by action name, and
 * remote commands whose method segment is a plain accessor (`get*`, `list*`,
 * `read*`, `search*`). Everything else — including verbs that only look
 * harmless, like `git.fetch` — is treated as a write.
 */
const MAX_CONCURRENT_PEER_READS = 4;

const CONCURRENT_READ_FILE_ACTIONS: ReadonlySet<string> = new Set<SyncFileRequest["action"]>([
  "listWorkspaces",
  "listTree",
  "listTreeChildren",
  "refreshGitDecorations",
  "readFile",
  "readFileRange",
  "gitBlame",
  "quickOpen",
  "searchText",
  "readArtifact",
]);

const CONCURRENT_READ_COMMAND_PREFIXES = ["get", "list", "read", "search"] as const;

export function isConcurrentReadCommandAction(action: string): boolean {
  const method = action.slice(action.lastIndexOf(".") + 1);
  return CONCURRENT_READ_COMMAND_PREFIXES.some((prefix) => {
    if (method === prefix) return true;
    if (!method.startsWith(prefix)) return false;
    const next = method[prefix.length];
    return next !== undefined && next === next.toUpperCase() && next !== next.toLowerCase();
  });
}

export function isConcurrentReadEnvelope(envelope: ParsedSyncEnvelope): boolean {
  if (envelope.type === "file_request") {
    const action = toOptionalString((envelope.payload as Partial<SyncFileRequest> | null)?.action);
    return action !== null && CONCURRENT_READ_FILE_ACTIONS.has(action);
  }
  if (envelope.type === "command") {
    const action = toOptionalString((envelope.payload as Partial<SyncCommandPayload> | null)?.action);
    return action !== null && isConcurrentReadCommandAction(action);
  }
  return false;
}

function acquirePeerReadSlot(peer: PeerState): Promise<void> {
  if (peer.activeReadCount < MAX_CONCURRENT_PEER_READS) {
    peer.activeReadCount += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    peer.readSlotWaiters.push(resolve);
  });
}

function releasePeerReadSlot(peer: PeerState): void {
  // Hand the slot straight to the longest-waiting read instead of releasing and
  // re-acquiring it, so the FIFO order of queued reads is preserved.
  const next = peer.readSlotWaiters.shift();
  if (next) {
    next();
    return;
  }
  peer.activeReadCount = Math.max(0, peer.activeReadCount - 1);
}

type LanePresenceEntry = {
  marker: DeviceMarker;
  lastAnnouncedAtMs: number;
  source: "local" | "remote";
};

type ChatSubscriptionScope = "project" | "personal" | "foreign-project";
type ChatSubscriptionBinding =
  | { scope: "project" }
  | { scope: "personal" }
  | {
      scope: "foreign-project";
      transcriptPath: string;
    };
type ChatScopeRequest = Pick<
  SyncChatSubscribePayload,
  "chatScope" | "projectId" | "projectRootPath"
>;

type PendingTerminalSnapshotEvent =
  | {
      kind: "data";
      payload: SyncTerminalDataPayload;
      byteLength: number;
    }
  | {
      kind: "exit";
      payload: SyncTerminalExitPayload;
      byteLength: 0;
    };

type PendingTerminalSnapshotBarrier = {
  generation: number;
  captureAttempt: number;
  requiredCaptureAttempt: number;
  requiredSnapshotEndOffset: number | null;
  events: PendingTerminalSnapshotEvent[];
  queuedBytes: number;
  failed: boolean;
};

type PeerState = {
  ws: WebSocket;
  lifecycleGeneration: number;
  metadata: SyncPeerMetadata | null;
  negotiatedCompression: SyncApplicationCompressionCodec | null;
  envelopeChunks: ReturnType<typeof createSyncEnvelopeChunkAssembler>;
  authenticated: boolean;
  authTimeout: ReturnType<typeof setTimeout> | null;
  authKind: SyncHostAuthKind;
  pairedDeviceId: string | null;
  pairingRecord: SyncPairingRecord | null;
  /** Commit negotiation belongs to the socket that requested this re-pair. */
  pairingCommitOfferedForDeviceId: string | null;
  /** Set only after this socket authenticates with that staged replacement. */
  pendingPairingCommitDeviceId: string | null;
  /** Binds a later commit to the exact rotation this socket authenticated. */
  pendingPairingCommitSecret: string | null;
  connectedAt: string;
  lastSeenAt: string;
  lastAppliedAt: string | null;
  lastKnownServerDbVersion: number;
  latencyMs: number | null;
  awaitingHeartbeatAt: string | null;
  missedHeartbeatCount: number;
  backpressuredSinceMs: number | null;
  changesetPriorityDeferredSinceMs: number | null;
  changesetRecoveryLevel: number;
  changesetRecoveryNotBeforeMs: number;
  remoteAddress: string | null;
  remotePort: number | null;
  /**
   * Frames received from this peer. A peer that closes having sent none never
   * attempted the sync protocol at all — the relay readiness self-probe bridges
   * in and disconnects like this on every poll — so it must not be logged with
   * the same weight as a peer that tried to authenticate and was rejected.
   */
  framesReceived: number;
  transportOrigin: SyncTransportOrigin;
  relayAuthorization: RelayAuthorizationLifecycle | null;
  reportedIncompatibleAdoptCipher: boolean;
  adoptChallenge: {
    sessionKey: Buffer;
    nonce: string;
    hostDeviceId: string;
    expiresAtMs: number;
    aead: AdoptChannelAead;
    aeadBoundToSignature: boolean;
  } | null;
  subscribedSessionIds: Set<string>;
  pendingTerminalSnapshots: Map<string, PendingTerminalSnapshotBarrier>;
  nextTerminalSnapshotGeneration: number;
  subscribedChatSessionIds: Set<string>;
  hydratingChatSessionIds: Set<string>;
  chatSubscriptionBindings: Map<string, ChatSubscriptionBinding>;
  chatTranscriptOffsets: Map<string, number>;
  // Progress while scanning one JSONL record that exceeded a normal bounded
  // transcript-delta read. The durable offset above still advances only after
  // a complete newline boundary is found and a deliverable record is parsed.
  chatTranscriptScanOffsets: Map<string, number>;
  chatEventIdsSent: Map<string, Set<string>>;
  // Subscriptions resolved outside the active project's session service:
  // machine-scoped personal chats and cross-project quick looks. Scope stays
  // separate because only personal chats may survive a project-host handoff.
  resolvedChatTranscriptPaths: Map<string, string>;
  pendingChangesetBatch: PendingChangesetBatch | null;
  mobileReplicaReseedDisabled: boolean;
  // All-projects roster (mobile hub): whether this peer is subscribed, the
  // monotonic seq last sent to THIS peer (per-peer so a peer that skips a
  // no-change flush never sees a seq gap), and the per-project serialized
  // baseline it last received (projectId → JSON) for changed/removed diffing.
  rosterSubscribed: boolean;
  rosterSeq: number;
  rosterBaseline: Map<string, string>;
  /** Settles when every envelope scheduled so far has finished (reads included). */
  messageQueue: Promise<void>;
  /** Settles when the last write-classified envelope finished; reads wait on it. */
  writeQueue: Promise<void>;
  activeReadCount: number;
  readSlotWaiters: Array<() => void>;
  queuedMessageCount: number;
  terminalInputQueue: Promise<void>;
  pendingTerminalOwnershipChanges: number;
  inFlightOperationControllers: Set<AbortController>;
  /** Local consent for this browser/phone; never mutates machine-wide consent. */
  productAnalyticsEnabled: boolean;
};

type PendingChangesetBatch = {
  batchId: string;
  fromDbVersion: number;
  toDbVersion: number;
  changes: CrsqlChangeRow[];
  reason: SyncChangesetBatchPayload["reason"];
  sentAtMs: number;
  attemptCount: number;
  retryNotBeforeMs: number;
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

const PERSISTED_MOBILE_COMMAND_ACTIONS = new Set<string>([
  "lanes.presence.announce",
  "lanes.presence.release",
  "work.runQuickCommand",
  "work.startCliSession",
  "work.sendToSession",
  "work.stopRuntime",
  "chat.send",
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

export type SyncProjectCatalogProvider = {
  listProjects: () => Promise<SyncProjectCatalogPayload>;
  prepareProjectConnection: (args: SyncProjectSwitchRequestPayload) => Promise<SyncProjectSwitchResultPayload>;
  completeProjectConnection?: (
    args: SyncProjectSwitchRequestPayload,
    result: SyncProjectSwitchResultPayload,
  ) => Promise<void>;
  browseDirectories?: (args: ProjectBrowseInput) => Promise<ProjectBrowseResult>;
  getDefaultParentDir?: () => Promise<string>;
  openProject?: (args: SyncProjectOpenRequestPayload) => Promise<SyncMobileProjectSummary>;
  createProject?: (args: CreateProjectInput) => Promise<SyncMobileProjectSummary>;
  cloneProject?: (args: CloneProjectInput) => Promise<SyncMobileProjectSummary>;
  listMyGitHubRepos?: (args: ListMyGitHubReposInput) => Promise<ListMyGitHubReposResult>;
  forgetProject?: (args: SyncProjectForgetRequestPayload) => Promise<SyncProjectForgetResultPayload>;
};

/**
 * Builds the machine-wide all-projects chat roster (mobile hub). Lives where
 * the project registry + project scope registry are both in scope (ade-cli
 * brain). Optional: a host without a roster provider (e.g. single-project
 * desktop) simply never answers `roster_subscribe`, so the phone falls back to
 * the project catalog with no cross-project chats.
 */
export type SyncRosterProvider = {
  buildSnapshot: () => Promise<SyncRosterProject[]>;
};

/**
 * Resolves the on-disk chat transcript path for a session in a REGISTERED
 * FOREIGN project so the host can stream a cross-project "quick look" without
 * switching the socket's active project or booting that project's runtime.
 * Lives where the project registry is in scope (ade-cli brain / multi-project
 * server). Optional: a host without a foreign-chat provider (e.g. single
 * project desktop) simply never advertises `crossProjectChat`, so the phone
 * falls back to a full project activation.
 *
 * The resolver is the SECURITY BOUNDARY: it must validate that the requested
 * project is registered and only return paths inside that project's `.ade`
 * transcripts dir, returning null for anything unknown or unsafe.
 */
export type SyncForeignChatTranscriptResolver = {
  resolveTranscriptPath: (args: {
    projectId?: string | null;
    projectRootPath?: string | null;
    sessionId: string;
  }) => string | null;
};

type SyncHostServiceArgs = {
  db: AdeDb;
  logger: Logger;
  projectId?: string | null;
  projectIdAliases?: string[];
  projectRoot: string;
  fileService: ReturnType<typeof createFileService>;
  laneService: ReturnType<typeof createLaneService>;
  gitService?: ReturnType<typeof createGitOperationsService>;
  githubService?: ReturnType<typeof createGithubService> | null;
  diffService?: ReturnType<typeof createDiffService>;
  conflictService?: ReturnType<typeof createConflictService>;
  operationService?: ReturnType<typeof createOperationService> | null;
  prService: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
  ptyService: ReturnType<typeof createPtyService>;
  agentChatService?: ReturnType<typeof createAgentChatService>;
  personalChatScope?: Pick<
    PersonalChatScopeContract,
    "call" | "streamEvents" | "transcriptPath" | "isTurnActive"
  >;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  orchestrationService?: ReturnType<typeof createOrchestrationService> | null;
  /** Brain→push-relay publisher; forwarded to the default remote-command service. */
  pushPublisherService?: PushPublisherService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  ctoMemoryService?: CtoMemoryService | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  getLinearIssueTracker?: () => ReturnType<typeof createLinearIssueTracker> | null;
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
  /** Test/integration seam for serialized pairing commit verification. */
  pairingStore?: ReturnType<typeof createSyncPairingStore>;
  /** Test seam; production lazily creates the machine-wide signing key. */
  machineIdentitySigningStore?: MachineIdentitySigningStore;
  /** Test seam for adoption challenge timestamps and expiry. */
  adoptNow?: () => number;
  accountAuthService?: Pick<AccountAuthService, "getStatus" | "getAccessToken">;
  getAccountAttestationConfig?: () => AccountAttestationConfig;
  /** Test seam for controlling an in-flight account attestation. */
  verifyAccountAttestation?: typeof verifyClerkAccountAttestation;
  /** Test seam for account-session lease reconciliation. */
  accountLeasePollMs?: number;
  runtimeNameStore?: SyncRuntimeNameStore;
  bootstrapTokenPath?: string;
  pairingSecretsPath?: string;
  port?: number;
  /**
   * Brain-level websocket listener shared across hosted-project switches.
   * When provided, this host service does NOT own a WebSocketServer: it
   * attaches as the listener's connection handler, adopts peers handed off
   * by the previous host service, and on dispose hands its own peers back
   * to the listener instead of closing them.
   */
  sharedListener?: SharedSyncListener | null;
  discoveryEnabled?: boolean;
  runtimeKind?: SyncRuntimeKind;
  runtimeVersion?: string;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  authTimeoutMs?: number;
  messageTimeoutMs?: number;
  /** Test seam; production warns for commands taking at least five seconds. */
  slowCommandThresholdMs?: number;
  brainStatusIntervalMs?: number;
  compressionThresholdBytes?: number;
  deviceRegistryService?: DeviceRegistryService;
  projectCatalogProvider?: SyncProjectCatalogProvider;
  rosterProvider?: SyncRosterProvider;
  foreignChatProvider?: SyncForeignChatTranscriptResolver;
  onStateChanged?: () => void;
  remoteCommandService?: SyncRemoteCommandService;
  remoteCommandExecutor?: Pick<SyncRemoteCommandService, "execute">;
  productAnalyticsService?: ProductAnalyticsService | null;
  /**
   * When true, paired hellos from devices WITHOUT a registered DPoP key are
   * rejected (forces a re-pair that registers one). Devices with a key on
   * record always require a valid proof regardless of this flag.
   */
  requireDpop?: () => boolean;
  /**
   * Live cloud tunnel-relay connect URL (`wss://…/connect/<machineKey>`), or
   * null when the relay is unavailable. Advertised in `hello_ok` and
   * `brain_status` so already-paired phones learn the off-LAN route without
   * re-scanning a QR.
   */
  getCloudRelayWssUrl?: () => string | null;
  /** Test seam; production always uses the HTTP 426 loopback probe. */
  loopbackProbe?: (port: number, expectedNonce: string) => Promise<SyncLoopbackProbeResult>;
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
    isHost: false,
    isAuthenticated: peer.authenticated,
  };
}

export function syncHeartbeatMissLimitForPeerMetadata(metadata: Pick<SyncPeerMetadata, "platform" | "deviceType"> | null | undefined): number {
  return metadata?.platform === "iOS" || metadata?.deviceType === "phone"
    ? MOBILE_SYNC_HEARTBEAT_MISS_LIMIT
    : DEFAULT_SYNC_HEARTBEAT_MISS_LIMIT;
}

export function initialSyncHostCursorForPeer(args: {
  peer: Pick<SyncPeerMetadata, "deviceType" | "dbVersion" | "dbVersionBySite" | "capabilities">;
  serverDbSiteId: string;
  serverDbVersion: number;
}): number {
  // A browser may explicitly negotiate an invalidation-only contract: it has
  // no SQLite replica, fully refetches its query domains after hello, and uses
  // only post-connect sync messages as invalidation hints. Starting that peer at
  // the current watermark avoids replaying CRR history it cannot apply. Keep
  // legacy browsers on replica semantics unless they declare the capability.
  if (isInvalidationOnlyBrowserPeer(args.peer)) {
    return Math.max(0, Math.floor(args.serverDbVersion));
  }
  const cursorForThisDb = args.peer.dbVersionBySite?.[args.serverDbSiteId]
    ?? (args.peer.dbVersionBySite ? 0 : args.peer.dbVersion);
  return Math.max(0, Math.floor(cursorForThisDb));
}

export function adoptedSyncHostCursorForPeer(args: {
  peer: Pick<SyncPeerMetadata, "deviceType" | "dbVersion" | "dbVersionBySite" | "capabilities">;
  serverDbSiteId: string;
  serverDbVersion: number;
  snapshotServerDbSiteId?: string | null;
  snapshotLastKnownServerDbVersion?: number | null;
}): number {
  const initialCursor = initialSyncHostCursorForPeer(args);
  if (
    args.snapshotServerDbSiteId !== args.serverDbSiteId
    || typeof args.snapshotLastKnownServerDbVersion !== "number"
    || !Number.isFinite(args.snapshotLastKnownServerDbVersion)
  ) {
    return initialCursor;
  }
  const snapshotCursor = Math.max(0, Math.floor(args.snapshotLastKnownServerDbVersion));
  // Invalidation-only browsers have no replica cursor to merge. On a
  // same-DB seamless adoption, the deposited cursor is the exact boundary:
  // writes committed while the socket is parked must be exported by the new
  // owner. A different DB still starts at that DB's current watermark.
  if (isInvalidationOnlyBrowserPeer(args.peer)) {
    return Math.min(Math.max(0, Math.floor(args.serverDbVersion)), snapshotCursor);
  }
  // Replica peers may have advertised a newer durable per-site cursor than
  // the depositing host had observed, so retain the fresher same-DB value.
  return Math.max(initialCursor, snapshotCursor);
}

function isInvalidationOnlyBrowserPeer(
  peer: Pick<SyncPeerMetadata, "deviceType" | "capabilities"> | null | undefined,
): boolean {
  return peer?.deviceType === "browser"
    && peer.capabilities?.includes(SYNC_INVALIDATION_ONLY_V1_CAPABILITY) === true;
}

function isCompactInvalidationBrowserPeer(
  peer: Pick<SyncPeerMetadata, "deviceType" | "capabilities"> | null | undefined,
): boolean {
  return isInvalidationOnlyBrowserPeer(peer)
    && peer?.capabilities?.includes(SYNC_COMPACT_INVALIDATION_V1_CAPABILITY) === true;
}

export function buildSyncInvalidationBatchPayload(args: {
  fromDbVersion: number;
  toDbVersion: number;
  changes: readonly CrsqlChangeRow[];
  compressionThresholdBytes?: number;
}): SyncInvalidationBatchPayload {
  const fromDbVersion = Number.isFinite(args.fromDbVersion)
    ? Math.max(0, Math.floor(args.fromDbVersion))
    : 0;
  const toDbVersion = Number.isFinite(args.toDbVersion)
    ? Math.max(fromDbVersion, Math.floor(args.toDbVersion))
    : fromDbVersion;
  const fullRefresh = (): SyncInvalidationBatchPayload => ({
    fromDbVersion,
    toDbVersion,
    tables: [],
    fullRefresh: true,
  });
  if (args.changes.length === 0) return fullRefresh();
  const tables = new Set<string>();
  for (const change of args.changes) {
    const table = typeof change.table === "string" ? change.table : "";
    if (
      !table
      || table.trim() !== table
      || table.includes("\0")
      || Buffer.byteLength(table, "utf8") > SYNC_INVALIDATION_TABLE_MAX_BYTES
    ) {
      return fullRefresh();
    }
    tables.add(table);
    if (tables.size > SYNC_INVALIDATION_BATCH_MAX_TABLES) return fullRefresh();
  }
  const payload: SyncInvalidationBatchPayload = {
    fromDbVersion,
    toDbVersion,
    tables: [...tables].sort(),
    fullRefresh: false,
  };
  const envelopeBytes = Buffer.byteLength(encodeSyncEnvelope({
    type: "invalidation_batch",
    payload,
    compressionThresholdBytes: args.compressionThresholdBytes,
  }), "utf8");
  return envelopeBytes <= SYNC_INVALIDATION_BATCH_MAX_ENVELOPE_BYTES
    ? payload
    : fullRefresh();
}

export function shouldDeferSyncHostBackgroundChangesForChat(args: {
  subscribedChatSessionCount: number;
  bufferedAmount: number;
}): boolean {
  return args.subscribedChatSessionCount > 0
    && args.bufferedAmount >= SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES;
}

export function syncHostChangesetBatchOptionsForChat(args: {
  subscribedChatSessionCount: number;
  maxRows: number;
  maxBytes: number;
}): { maxRows?: number; maxBytes?: number } | undefined {
  if (args.subscribedChatSessionCount <= 0) return undefined;
  return {
    maxRows: Math.min(args.maxRows, 64),
    maxBytes: Math.min(args.maxBytes, SYNC_HOST_CHAT_ACTIVE_CHANGESET_BATCH_BYTES),
  };
}

const SYNC_HOST_PROJECT_SCOPED_INBOUND_ENVELOPE_TYPES = new Set<SyncEnvelope["type"]>([
  "changeset_batch",
  "changeset_ack",
  "file_request",
  "terminal_subscribe",
  "terminal_unsubscribe",
  "terminal_input",
  "terminal_resize",
  "terminal_history",
  "chat_subscribe",
  "chat_unsubscribe",
  "chat_history",
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

function projectIdMatchesHost(
  receivedProjectId: string | null | undefined,
  hostProjectId: string | null | undefined,
  hostProjectIdAliases: readonly (string | null | undefined)[] = [],
): boolean {
  const received = toOptionalString(receivedProjectId);
  const host = toOptionalString(hostProjectId);
  if (!received || !host) return false;
  return received === host || hostProjectIdAliases.some((alias) => toOptionalString(alias) === received);
}

export function resolveSyncHostInboundProjectScope(
  type: SyncEnvelope["type"],
  receivedProjectId: string | null | undefined,
  hostProjectId: string | null | undefined,
  hostProjectIdAliases: readonly (string | null | undefined)[] = [],
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
  if (!projectIdMatchesHost(received, host, hostProjectIdAliases)) {
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

export function syncConnectionTransportForOrigin(origin: SyncTransportOrigin): "direct" | "relay" {
  return origin === "relay-bridge" ? "relay" : "direct";
}

export function buildSyncHostHelloOkPayload(args: {
  peer: SyncPeerMetadata;
  brain: SyncPeerMetadata;
  serverDbVersion: number;
  serverDbSiteId?: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  compression?: SyncApplicationCompressionCodec | null;
  chunkedEnvelopes?: boolean;
  projectCatalog: SyncProjectCatalogPayload;
  projectCatalogEnabled: boolean;
  projectActionsEnabled: boolean;
  crossProjectChatEnabled: boolean;
  remoteCommandSupportedActions: string[];
  remoteCommandDescriptors: SyncRemoteCommandDescriptor[];
  localCommandDescriptors: SyncRemoteCommandDescriptor[];
  compressionThresholdBytes?: number;
  maxProjectCatalogEnvelopeBytes?: number;
  cloudRelayWssUrl?: string | null;
  relayAuthorization?: SyncRelayAuthorizationLease | null;
  connectionTransport?: "direct" | "relay";
  /** Advertise only when this concrete handler accepts terminal_input. */
  terminalInputAckEnabled?: boolean;
  /**
   * Whether this peer is authorized to use the paired runtime RPC channel and
   * loopback port-forwarding (paired AND a desktop runtime-host). Defaults to
   * false so non-desktop paired devices (phones/browsers) never see the
   * feature advertised as available.
   */
  runtimeChannelEnabled?: boolean;
  /** Fresh secret returned only for first-time verified account adoption. */
  accountPairing?: { deviceId: string; secret: string } | null;
}): PairedRuntimeHelloOkPayload {
  const runtimeChannelEnabled = args.runtimeChannelEnabled === true;
  const actions = [
    ...args.remoteCommandDescriptors,
    ...args.localCommandDescriptors,
  ];
  const supportedActions = [
    ...args.remoteCommandSupportedActions,
    ...args.localCommandDescriptors.map((entry) => entry.action),
  ];
  const mobileCompatibility = evaluateMobileSyncCompatibility(supportedActions);
  const payload: PairedRuntimeHelloOkPayload = {
    peer: args.peer,
    brain: args.brain,
    serverDbVersion: args.serverDbVersion,
    ...(args.serverDbSiteId ? { serverDbSiteId: args.serverDbSiteId } : {}),
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    pollIntervalMs: args.pollIntervalMs,
    ...(args.compression
      ? {
          compression: {
            codec: args.compression,
            thresholdBytes: SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES,
          },
        }
      : {}),
    projects: args.projectCatalog.projects,
    // Explicit null (relay unavailable) must reach the wire: clients treat an
    // ABSENT key as "older host — keep saved relay routes", and the brain
    // fallback handler never sends brain_status, so hello_ok is the only
    // clear signal on that path. Omit only when the caller didn't supply
    // the argument at all.
    ...(args.cloudRelayWssUrl !== undefined ? { cloudRelayWssUrl: args.cloudRelayWssUrl } : {}),
    ...(args.relayAuthorization ? { relayAuthorization: args.relayAuthorization } : {}),
    ...(args.connectionTransport ? { connectionTransport: args.connectionTransport } : {}),
    ...(args.accountPairing ? { accountPairing: args.accountPairing } : {}),
    features: {
      fileAccess: true,
      terminalStreaming: true,
      chatStreaming: {
        enabled: true,
      },
      chatHistoryPaging: {
        enabled: true,
      },
      ...(isInvalidationOnlyBrowserPeer(args.peer)
        ? {
            invalidationOnlyV1: {
              enabled: true,
            },
          }
        : {}),
      ...(isCompactInvalidationBrowserPeer(args.peer)
        ? {
            compactInvalidationV1: {
              enabled: true as const,
            },
          }
        : {}),
      crossProjectChat: {
        enabled: args.crossProjectChatEnabled,
      },
      projectCatalog: {
        enabled: args.projectCatalogEnabled,
      },
      projectActions: {
        enabled: args.projectActionsEnabled,
      },
      changesetAck: {
        enabled: true,
      },
      ...(args.chunkedEnvelopes
        ? {
            chunkedEnvelopes: {
              enabled: true as const,
              maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
            },
          }
        : {}),
      ...(args.terminalInputAckEnabled
        ? {
            terminalInputAck: {
              enabled: true,
              retryWindowMs: TERMINAL_INPUT_RETRY_WINDOW_MS,
              maxOutstanding: TERMINAL_INPUT_MAX_OUTSTANDING,
            },
          }
        : {}),
      bootstrapAuth: true,
      pairingAuth: {
        enabled: true,
        pinDigits: 6,
      },
      commandRouting: {
        mode: "allowlisted",
        supportedActions,
        actions,
      },
      mobileCompatibility: {
        contractVersion: MOBILE_SYNC_COMPATIBILITY_CONTRACT_VERSION,
        mode: mobileCompatibility.mode,
        requiredActions: [...MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS],
        missingActions: mobileCompatibility.missingActions,
      },
      rpcChannel: runtimeChannelEnabled,
      portForward: runtimeChannelEnabled,
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

type ParsedAccountChallenge = {
  nonce: string;
  nonceBytes: Buffer;
  clientEphemeralPublicKey: string;
  clientEphemeralPublicKeyBytes: Buffer;
  supportedAeads: string[] | null;
};

function parseAccountChallengePayload(payload: unknown): ParsedAccountChallenge | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.v !== 1) return null;
  const nonceBytes = decodeCanonicalBase64(value.nonce, 32);
  const clientEphemeralPublicKeyBytes = decodeCanonicalBase64(
    value.clientEphemeralPublicKey,
    32,
  );
  const supportedAeads = value.supportedAeads === undefined
    ? null
    : value.supportedAeads;
  if (
    !nonceBytes
    || !clientEphemeralPublicKeyBytes
    || typeof value.nonce !== "string"
    || typeof value.clientEphemeralPublicKey !== "string"
    || (
      supportedAeads !== null
      && (
        !Array.isArray(supportedAeads)
        || supportedAeads.some((entry) => typeof entry !== "string")
      )
    )
  ) {
    return null;
  }
  return {
    nonce: value.nonce,
    nonceBytes,
    clientEphemeralPublicKey: value.clientEphemeralPublicKey,
    clientEphemeralPublicKeyBytes,
    supportedAeads,
  };
}

function parseUnsealedAccountAuth(value: unknown): Extract<
  SyncHelloPayload["auth"],
  { kind: "account" }
> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const account = value as Record<string, unknown>;
  const deviceId = toOptionalString(account.deviceId);
  const accountToken = toOptionalString(account.accountToken);
  if (!deviceId || !accountToken) return null;
  if (
    account.dpop != null
    && (typeof account.dpop !== "object" || Array.isArray(account.dpop))
  ) return null;
  const runtimeHostGrant = account.runtimeHostGrant == null
    ? null
    : toOptionalString(account.runtimeHostGrant);
  if (account.runtimeHostGrant != null && !runtimeHostGrant) return null;
  return {
    kind: "account",
    deviceId,
    accountToken,
    dpop: account.dpop as SyncDpopProof | null | undefined,
    ...(runtimeHostGrant ? { runtimeHostGrant } : {}),
  };
}

function safeStringEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    timingSafeEqual(expectedBuffer, Buffer.alloc(expectedBuffer.length));
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function isMobilePairingRecord(record: SyncPairingRecord | null): boolean {
  return record?.peerPlatform === "iOS" || record?.peerDeviceType === "phone";
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

// ---------------------------------------------------------------------------
// Resumable chat event streams.
//
// The host assigns each broadcast chat event a per-session, monotonically
// increasing `seq` and keeps a bounded ring buffer of recent events. When a
// phone reconnects it passes the last seq it applied (`sinceSeq` on
// chat_subscribe); if the buffer still covers `sinceSeq + 1 .. latest` the
// host replays exactly the missed events instead of re-sending a large
// maxBytes-capped snapshot.
// ---------------------------------------------------------------------------

export const CHAT_EVENT_REPLAY_MAX_EVENTS = 500;
export const CHAT_EVENT_REPLAY_MAX_BYTES = 2_000_000;
export const TERMINAL_INPUT_DEDUPE_MAX_ENTRIES = 2_048;
export const TERMINAL_INPUT_ID_MAX_CHARS = 128;
export const TERMINAL_INPUT_RETRY_WINDOW_MS = 60_000;
export const TERMINAL_INPUT_MAX_OUTSTANDING = 64;
export const ACCOUNT_AUTH_TRANSIENT_IDENTITY_GRACE_MS = 5 * 60_000;
export const CONNECTION_ATTEMPT_RESERVATION_TTL_MS = 30_000;
// Delivery-key dedupe map cap. Must exceed CHAT_EVENT_REPLAY_MAX_EVENTS so a
// buffered event's key cannot be evicted while the event itself is still in
// the ring buffer (which could double-assign a seq to the same event).
const CHAT_EVENT_REPLAY_MAX_KEYS = 1_500;
// Bound the number of sessions with live replay buffers (LRU-evicted).
const CHAT_EVENT_REPLAY_MAX_SESSIONS = 64;

type TerminalInputDedupeEntry = {
  deviceId: string;
  sessionId: string;
  inputId: string;
  dataFingerprint: string;
  recordedAtMs: number;
};

export function createTerminalInputDedupeLedger(options: {
  maxEntries?: number;
  retryWindowMs?: number;
  now?: () => number;
} = {}) {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? TERMINAL_INPUT_DEDUPE_MAX_ENTRIES));
  const retryWindowMs = Math.max(1_000, Math.floor(options.retryWindowMs ?? TERMINAL_INPUT_RETRY_WINDOW_MS));
  const now = options.now ?? Date.now;
  const devices = new Map<string, Map<string, Map<string, TerminalInputDedupeEntry>>>();
  const insertionOrder = new Set<TerminalInputDedupeEntry>();

  const entriesFor = (deviceId: string, sessionId: string): Map<string, TerminalInputDedupeEntry> | undefined =>
    devices.get(deviceId)?.get(sessionId);

  const remove = (entry: TerminalInputDedupeEntry): void => {
    const sessions = devices.get(entry.deviceId);
    const entries = sessions?.get(entry.sessionId);
    if (!sessions || !entries || entries.get(entry.inputId) !== entry) return;
    entries.delete(entry.inputId);
    insertionOrder.delete(entry);
    if (entries.size === 0) sessions.delete(entry.sessionId);
    if (sessions.size === 0) devices.delete(entry.deviceId);
  };

  const pruneExpired = (): void => {
    const cutoff = now() - retryWindowMs;
    for (const entry of insertionOrder) {
      if (entry.recordedAtMs <= cutoff) remove(entry);
    }
  };

  const remember = (
    deviceId: string,
    sessionId: string,
    inputId: string,
    dataFingerprint: string,
    recordedAtMs = now(),
  ): "recorded" | "duplicate" | "capacity" => {
    pruneExpired();
    if (entriesFor(deviceId, sessionId)?.has(inputId)) return "duplicate";
    // Never evict a still-eligible receipt: if the bounded ledger is full, the
    // new operation is explicitly rejected and the client keeps its ordered
    // queue intact until an older retry window expires.
    if (insertionOrder.size >= maxEntries) return "capacity";
    let sessions = devices.get(deviceId);
    if (!sessions) {
      sessions = new Map();
      devices.set(deviceId, sessions);
    }
    let entries = sessions.get(sessionId);
    if (!entries) {
      entries = new Map();
      sessions.set(sessionId, entries);
    }
    const entry = { deviceId, sessionId, inputId, dataFingerprint, recordedAtMs };
    entries.set(inputId, entry);
    insertionOrder.add(entry);
    return "recorded";
  };

  return {
    fingerprint(deviceId: string, sessionId: string, inputId: string): string | null {
      pruneExpired();
      return entriesFor(deviceId, sessionId)?.get(inputId)?.dataFingerprint ?? null;
    },

    hasCapacity(): boolean {
      pruneExpired();
      return insertionOrder.size < maxEntries;
    },

    remember,

    restore(entriesToRestore: TerminalInputDedupeEntry[]): void {
      for (const entry of entriesToRestore) {
        if (
          !entry
          || typeof entry.deviceId !== "string"
          || !entry.deviceId
          || typeof entry.sessionId !== "string"
          || !entry.sessionId
          || typeof entry.inputId !== "string"
          || !entry.inputId
          || typeof entry.dataFingerprint !== "string"
          || !/^[a-f0-9]{64}$/i.test(entry.dataFingerprint)
          || typeof entry.recordedAtMs !== "number"
          || !Number.isFinite(entry.recordedAtMs)
        ) continue;
        if (entry.recordedAtMs <= now() - retryWindowMs) continue;
        remember(
          entry.deviceId,
          entry.sessionId,
          entry.inputId,
          entry.dataFingerprint,
          entry.recordedAtMs,
        );
      }
    },

    snapshotForDevice(deviceId: string): TerminalInputDedupeEntry[] {
      pruneExpired();
      const sessions = devices.get(deviceId);
      if (!sessions) return [];
      const snapshots: TerminalInputDedupeEntry[] = [];
      for (const entries of sessions.values()) {
        for (const entry of entries.values()) snapshots.push({ ...entry });
      }
      return snapshots;
    },

    get size(): number {
      pruneExpired();
      return insertionOrder.size;
    },
  };
}

function normalizeTerminalInputId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const inputId = value.trim();
  if (!inputId || inputId.length > TERMINAL_INPUT_ID_MAX_CHARS) return null;
  return inputId;
}

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

export type ChatEventReplayBufferEntry = {
  seq: number;
  bytes: number;
  event: AgentChatEventEnvelope;
};

export type ChatEventReplayBuffer = {
  /** Highest seq assigned for this session (0 when no events recorded yet). */
  latestSeq: number;
  /** Oldest-first ring buffer of recently broadcast events. */
  entries: ChatEventReplayBufferEntry[];
  totalBytes: number;
  /** Delivery-key → assigned seq, so live + transcript-pump duplicates share one seq. */
  seqByKey: Map<string, number>;
};

export function createChatEventReplayBuffer(initialSequence = 0): ChatEventReplayBuffer {
  const latestSeq = typeof initialSequence === "number"
    && Number.isFinite(initialSequence)
    && initialSequence > 0
    ? Math.floor(initialSequence)
    : 0;
  return { latestSeq, entries: [], totalBytes: 0, seqByKey: new Map() };
}

function chatEventDeliveryKey(event: AgentChatEventEnvelope): string {
  return `${event.sessionId}:${event.sequence ?? -1}:${event.timestamp}:${event.event.type}`;
}

/**
 * Assign (or look up) the per-session seq for `event` and retain it in the
 * ring buffer for replay. Returns the seq to stamp on the outgoing
 * `chat_event` payload. The same logical event observed via both the live
 * subscription and the transcript pump resolves to a single seq.
 */
export function recordChatEventInReplayBuffer(
  buffer: ChatEventReplayBuffer,
  event: AgentChatEventEnvelope,
): number {
  const key = chatEventDeliveryKey(event);
  const existing = buffer.seqByKey.get(key);
  if (existing != null) return existing;
  // The chat service persists its per-session eventSequence high-water mark
  // and restores it from metadata + transcript history. Use that durable
  // sequence as a floor, while retaining a host-local increment for legacy
  // envelopes that omit it. Together with the handoff high-water map below,
  // this prevents a recreated sync host from reusing `(sessionId, seq)`.
  const eventSequence = typeof event.sequence === "number"
    && Number.isFinite(event.sequence)
    && event.sequence > 0
    ? Math.floor(event.sequence)
    : 0;
  const seq = Math.max(buffer.latestSeq + 1, eventSequence);
  buffer.latestSeq = seq;
  buffer.seqByKey.set(key, seq);
  while (buffer.seqByKey.size > CHAT_EVENT_REPLAY_MAX_KEYS) {
    const oldestKey = buffer.seqByKey.keys().next().value;
    if (oldestKey == null) break;
    buffer.seqByKey.delete(oldestKey);
  }
  const syncEvent = compactChatEventEnvelopeForSync(event);
  let bytes = 512;
  try {
    bytes = JSON.stringify(syncEvent).length;
  } catch {
    // keep the conservative default
  }
  buffer.entries.push({ seq, bytes, event: syncEvent });
  buffer.totalBytes += bytes;
  while (
    buffer.entries.length > 0
    && (buffer.entries.length > CHAT_EVENT_REPLAY_MAX_EVENTS || buffer.totalBytes > CHAT_EVENT_REPLAY_MAX_BYTES)
  ) {
    const removed = buffer.entries.shift()!;
    buffer.totalBytes -= removed.bytes;
  }
  return seq;
}

export type ChatEventResumePlan =
  | { mode: "snapshot" }
  | { mode: "replay"; entries: ChatEventReplayBufferEntry[] };

/**
 * Decide how to answer a chat_subscribe: replay the exact missed events when
 * the ring buffer still covers `(sinceSeq, latestSeq]`, otherwise fall back
 * to the legacy snapshot. Fresh subscribes (no/invalid sinceSeq), unknown
 * sessions, seqs from a previous host run (sinceSeq > latestSeq), and gaps
 * older than the buffer all yield a snapshot.
 */
export function planChatEventResume(
  buffer: ChatEventReplayBuffer | undefined,
  sinceSeq: unknown,
): ChatEventResumePlan {
  if (typeof sinceSeq !== "number" || !Number.isInteger(sinceSeq) || sinceSeq < 0) {
    return { mode: "snapshot" };
  }
  if (!buffer) return { mode: "snapshot" };
  if (sinceSeq > buffer.latestSeq) {
    // Seq from a different epoch (e.g. host restart) — cannot trust it.
    return { mode: "snapshot" };
  }
  if (sinceSeq === buffer.latestSeq) {
    // Client is already current; nothing to replay and no snapshot needed.
    return { mode: "replay", entries: [] };
  }
  const oldestBuffered = buffer.entries[0]?.seq;
  if (oldestBuffered == null || oldestBuffered > sinceSeq + 1) {
    // Gap not coverable: events between sinceSeq and the buffer were evicted.
    return { mode: "snapshot" };
  }
  return { mode: "replay", entries: buffer.entries.filter((entry) => entry.seq > sinceSeq) };
}

export function createSyncHostService(args: SyncHostServiceArgs) {
  const verifyAccountAttestation = args.verifyAccountAttestation
    ?? verifyClerkAccountAttestation;
  void recoverOrphanedNativeLanDiscoveryProcesses(args.logger);
  const layout = resolveAdeLayout(args.projectRoot);
  const bootstrapTokenPath = args.bootstrapTokenPath ?? path.join(layout.secretsDir, "sync-bootstrap-token");
  const pairingSecretsPath = args.pairingSecretsPath ?? path.join(layout.secretsDir, "sync-paired-devices.json");
  const commandLedgerPath = path.join(layout.cacheDir, "sync-mobile-command-ledger.json");
  const bootstrapToken = ensureBootstrapToken(bootstrapTokenPath);
  const pairingStore = args.pairingStore ?? createSyncPairingStore({
    filePath: pairingSecretsPath,
    pinStore: args.pinStore,
  });
  const machineIdentitySigningStore =
    args.machineIdentitySigningStore
    ?? createMachineIdentitySigningStore({ logger: args.logger });
  const adoptNow = args.adoptNow ?? Date.now;
  const dpopNonceCache = createSyncDpopNonceCache();
  const remoteCommandService = args.remoteCommandService ?? createSyncRemoteCommandService({
    db: args.db,
    productAnalyticsService: args.productAnalyticsService,
    projectRoot: args.projectRoot,
    laneService: args.laneService,
    prService: args.prService,
    prSummaryService: args.prSummaryService,
    ptyService: args.ptyService,
    sessionService: args.sessionService,
    sessionDeltaService: args.sessionDeltaService,
    fileService: args.fileService,
    gitService: args.gitService,
    githubService: args.githubService,
    diffService: args.diffService,
    conflictService: args.conflictService,
    operationService: args.operationService,
    agentChatService: args.agentChatService,
    personalChatScope: args.personalChatScope,
    aiIntegrationService: args.aiIntegrationService,
    orchestrationService: args.orchestrationService,
    pushPublisherService: args.pushPublisherService,
    ctoStateService: args.ctoStateService,
    ctoMemoryService: args.ctoMemoryService,
    linearCredentialService: args.linearCredentialService,
    getLinearIssueTracker: args.getLinearIssueTracker,
    projectConfigService: args.projectConfigService,
    portAllocationService: args.portAllocationService,
    laneEnvironmentService: args.laneEnvironmentService,
    laneTemplateService: args.laneTemplateService,
    rebaseSuggestionService: args.rebaseSuggestionService,
    autoRebaseService: args.autoRebaseService,
    // Lane presence lives in this closure; without the stamp, a presence-only
    // change (devicesOpen) would keep matching ifNoneMatch and serve stale
    // presence via notModified. The injected-service path (syncService.ts)
    // wires the same stamp from the outside.
    getLanePresenceStamp: () => computeLanePresenceStamp(),
    dispatchDeeplinkUrl: args.dispatchDeeplinkUrl,
    syncPinStore: args.pinStore,
    getPairingConnectInfo: args.deviceRegistryService
      ? () => {
        const localDevice = args.deviceRegistryService!.ensureLocalDevice();
        const activePort = getListeningPort() ?? args.port ?? localDevice.lastPort;
        const connectDevice = activePort != null && localDevice.lastPort !== activePort
          ? args.deviceRegistryService!.touchLocalDevice({
            lastSeenAt: nowIso(),
            lastHost: localDevice.ipAddresses[0] ?? localDevice.tailscaleIp ?? localDevice.lastHost,
            lastPort: activePort,
          })
          : localDevice;
        return buildPairingConnectInfo({
          localDevice: connectDevice,
          relayWssUrl: args.getCloudRelayWssUrl?.() ?? null,
        });
      }
      : undefined,
    issueRuntimeHostPairingGrant: () => pairingStore.issueRuntimeHostGrant(),
    isCloudRelayEnabled: () => Boolean(args.getCloudRelayWssUrl?.()),
    logger: args.logger,
  });
  const heartbeatIntervalMs = Math.max(5_000, Math.floor(args.heartbeatIntervalMs ?? DEFAULT_SYNC_HEARTBEAT_INTERVAL_MS));
  const backpressureTimeoutMs = Math.max(heartbeatIntervalMs * 3, 10_000);
  const pollIntervalMs = Math.max(100, Math.floor(args.pollIntervalMs ?? DEFAULT_SYNC_POLL_INTERVAL_MS));
  const brainStatusIntervalMs = Math.max(1_000, Math.floor(args.brainStatusIntervalMs ?? DEFAULT_BRAIN_STATUS_INTERVAL_MS));
  const authTimeoutMs = Math.max(1_000, Math.floor(args.authTimeoutMs ?? SYNC_HOST_AUTH_TIMEOUT_MS));
  const messageTimeoutMs = Math.max(100, Math.floor(args.messageTimeoutMs ?? DEFAULT_SYNC_MESSAGE_TIMEOUT_MS));
  const slowCommandThresholdMs = Math.max(
    1,
    Math.floor(args.slowCommandThresholdMs ?? DEFAULT_SYNC_SLOW_COMMAND_MS),
  );
  const compressionThresholdBytes = Math.max(256, Math.floor(args.compressionThresholdBytes ?? DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES));
  const maxChangesetBatchBytes = DEFAULT_MAX_CHANGESET_BATCH_BYTES;
  const maxChangesetBatchRows = DEFAULT_MAX_CHANGESET_BATCH_ROWS;
  const maxProjectCatalogEnvelopeBytes = MAX_PROJECT_CATALOG_ENVELOPE_BYTES;
  const hostProjectIdAliases = uniqueStrings(
    (args.projectIdAliases ?? [])
      .map((alias) => toOptionalString(alias))
      .filter((alias): alias is string => Boolean(alias) && alias !== toOptionalString(args.projectId)),
  );
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
  const helloCommitQueueByDevice = new Map<string, Promise<void>>();
  const connectionAttemptByDevice = new Map<string, {
    id: string;
    startedAtMs: number;
    reservedAtMs: number;
    winner: PeerState | null;
  }>();
  // Host-scoped rather than peer-scoped so a transport reconnect from the
  // same authenticated device can retry a lost ACK without rewriting input.
  const terminalInputDedupeLedger = createTerminalInputDedupeLedger();
  const terminalInputOperationQueues = new Map<string, Promise<void>>();
  let accountLeaseUserId: string | null = null;
  let accountLeaseGeneration = 0;
  let accountLeaseInitialized = false;
  let accountLeaseContinuityUserId: string | null = null;
  let accountLeaseContinuityUntilMs = 0;
  let accountLeaseCheckInFlight: Promise<{ userId: string | null }> | null = null;

  const closePeerForAccountLease = (peer: PeerState, reason: string): void => {
    peer.relayAuthorization?.dispose();
    peer.relayAuthorization = null;
    const deviceId = peer.metadata?.deviceId ?? peer.pairedDeviceId;
    if (deviceId) removeAllPresenceForDevice(deviceId, "remote");
    pairedChannelService.closePeer(peer.ws, reason, true);
    peer.authenticated = false;
    peer.metadata = null;
    peer.authKind = null;
    peer.pairedDeviceId = null;
    peer.pairingRecord = null;
    try {
      peer.ws.close(SYNC_RELAY_AUTHORIZATION_CLOSE_CODE, reason);
    } catch {
      // ignore close failures
    }
  };

  const applyAccountLease = (nextUserId: string | null): void => {
    const previousUserId = accountLeaseUserId;
    const changed = !accountLeaseInitialized
      || previousUserId !== nextUserId;
    accountLeaseInitialized = true;
    accountLeaseUserId = nextUserId;
    if (!changed) return;
    accountLeaseContinuityUserId = null;
    accountLeaseContinuityUntilMs = 0;
    accountLeaseGeneration += 1;
    const revokedDeviceIds = new Set(pairingStore.revokeAccountOwnedExcept(nextUserId));
    let closedAny = false;
    for (const peer of peers) {
      if (!peer.authenticated) continue;
      const recordOwner = toOptionalString(peer.pairingRecord?.accountOwnerUserId);
      const relayLeaseChanged = peer.transportOrigin === "relay-bridge"
        && previousUserId !== nextUserId;
      const accountTrustRevoked = Boolean(
        recordOwner
        && (recordOwner !== nextUserId || revokedDeviceIds.has(peer.pairedDeviceId ?? "")),
      );
      if (!relayLeaseChanged && !accountTrustRevoked) continue;
      closePeerForAccountLease(peer, "ADE account session changed");
      closedAny = true;
    }
    if (revokedDeviceIds.size > 0 || closedAny) {
      args.logger.info("sync_host.account_trust_revoked", {
        previousUserId,
        nextUserId,
        revokedDeviceCount: revokedDeviceIds.size,
      });
      args.onStateChanged?.();
      broadcastBrainStatus();
    }
  };

  let retainedAccountOwnerUserId: string | null = null;
  /**
   * Ownership, not usability. `signedIn` answers "can this machine call the
   * account API right now"; this answers "is this still the same person's
   * machine". They differ for everything except a deliberate sign-out: an
   * expired grant or an unreadable credential store is an accident, and
   * reading one as a sign-out is what made `applyAccountLease(null)` revoke
   * every account-owned pairing — and close every peer holding one — over a
   * token problem. Only a genuine `signed_out`, or a different user signing
   * in, drops ownership. Anything that needs a live token still gates on the
   * token round trip in `refreshAccountLease`.
   *
   * `ownerUnknown` covers the case retention alone cannot: a brain that BOOTS
   * with a locked keychain has never seen an owner to retain, so it knows
   * nothing rather than knowing the machine is signed out. Applying null there
   * would delete every account-owned pairing on the box because a credential
   * store was briefly unreadable.
   */
  const readExplicitAccountStatus = (): {
    userId: string | null;
    expiresAtMs: number | null;
    retained: boolean;
    ownerUnknown: boolean;
  } => {
    const status = args.accountAuthService?.getStatus();
    const userId = status?.signedIn ? status.userId?.trim() || null : null;
    const expiresAtMs = status?.expiresAt ? Date.parse(status.expiresAt) : Number.NaN;
    if (userId) {
      retainedAccountOwnerUserId = userId;
      return {
        userId,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
        retained: false,
        ownerUnknown: false,
      };
    }
    const sessionState = status?.sessionState;
    if (sessionState === "expired" || sessionState === "unreadable") {
      return {
        userId: retainedAccountOwnerUserId,
        expiresAtMs: null,
        retained: retainedAccountOwnerUserId != null,
        ownerUnknown: retainedAccountOwnerUserId == null,
      };
    }
    retainedAccountOwnerUserId = null;
    return { userId: null, expiresAtMs: null, retained: false, ownerUnknown: false };
  };
  /**
   * Apply a lease read, unless the read said nothing. No information is not a
   * sign-out — only a real `signed_out` state revokes account-owned trust.
   */
  const applyAccountLeaseFromStatus = (
    status: { userId: string | null; ownerUnknown: boolean },
  ): void => {
    if (status.ownerUnknown) return;
    applyAccountLease(status.userId);
  };
  const seedAccountContinuity = (userId: string, expiresAtMs: number | null): void => {
    const nowMs = Date.now();
    const localExpiry = expiresAtMs != null && expiresAtMs > nowMs
      ? expiresAtMs
      : nowMs + ACCOUNT_AUTH_TRANSIENT_IDENTITY_GRACE_MS;
    accountLeaseContinuityUserId = userId;
    accountLeaseContinuityUntilMs = Math.min(
      localExpiry,
      nowMs + ACCOUNT_AUTH_TRANSIENT_IDENTITY_GRACE_MS,
    );
  };

  const refreshAccountLease = async (): Promise<string | null> => {
    if (accountLeaseCheckInFlight) return (await accountLeaseCheckInFlight).userId;
    const check = (async (): Promise<{ userId: string | null }> => {
      const initialStatus = readExplicitAccountStatus();
      const userId = initialStatus.userId;
      applyAccountLeaseFromStatus(initialStatus);
      if (!userId || !args.accountAuthService) return { userId: null };
      // Retained ownership has no live token to prove with, and asking for one
      // would only churn a grant this machine already knows is dead. The
      // identity is unchanged, so already-paired devices keep connecting.
      if (initialStatus.retained) return { userId };
      if (accountLeaseContinuityUserId !== userId) {
        seedAccountContinuity(userId, initialStatus.expiresAtMs);
      }
      try {
        const token = (await args.accountAuthService.getAccessToken()).trim();
        const refreshedStatus = readExplicitAccountStatus();
        const refreshedUserId = refreshedStatus.userId;
        if (refreshedUserId !== accountLeaseUserId) applyAccountLeaseFromStatus(refreshedStatus);
        // The token round trip can itself be what marks the session expired.
        // Re-read ownership so that lands as retained, not as a lost lease.
        if (refreshedStatus.retained && refreshedUserId === userId) return { userId };
        if (!token || refreshedUserId !== userId) return { userId: null };
        seedAccountContinuity(userId, refreshedStatus.expiresAtMs);
        return { userId };
      } catch {
        const refreshedStatus = readExplicitAccountStatus();
        const refreshedUserId = refreshedStatus.userId;
        if (refreshedUserId !== accountLeaseUserId) applyAccountLeaseFromStatus(refreshedStatus);
        if (refreshedStatus.retained && refreshedUserId === userId) return { userId };
        const retainsLastKnownGood = refreshedUserId === userId
          && accountLeaseContinuityUserId === userId
          && Date.now() <= accountLeaseContinuityUntilMs;
        return { userId: retainsLastKnownGood ? userId : null };
      }
    })();
    accountLeaseCheckInFlight = check;
    try {
      const lease = await check;
      return lease.userId;
    } finally {
      if (accountLeaseCheckInFlight === check) accountLeaseCheckInFlight = null;
    }
  };
  const captureAccountAuthorization = async (): Promise<{
    userId: string;
    generation: number;
  } | null> => {
    const userId = await refreshAccountLease();
    return userId ? { userId, generation: accountLeaseGeneration } : null;
  };

  const installRelayAuthorization = (
    peer: PeerState,
    initial: RelayAuthorizationSnapshot | null,
    capableOverride?: boolean,
  ): void => {
    peer.relayAuthorization?.dispose();
    peer.relayAuthorization = null;
    if (!initial || peer.transportOrigin !== "relay-bridge") return;
    const capable = capableOverride ?? Boolean(
      peer.metadata?.capabilities?.includes(SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY),
    );
    const lifecycle = createRelayAuthorizationLifecycle({
      capable,
      deviceId: () => {
        const metadataDeviceId = peer.metadata?.deviceId ?? null;
        return metadataDeviceId && metadataDeviceId === peer.pairedDeviceId
          ? metadataDeviceId
          : null;
      },
      pinnedPublicKey: () => peer.pairingRecord?.dpopPublicKey ?? null,
      captureHostAuthorization: captureAccountAuthorization,
      verifyAccountToken: async (token, expectedUserId) => {
        const config = args.getAccountAttestationConfig?.();
        if (!config) throw new Error("Relay account attestation is unavailable.");
        return verifyAccountAttestation({ token, expectedUserId, config });
      },
      sendResult: (payload, requestId) => {
        sendRequired(peer, "relay_reauthorize_result", payload, requestId);
      },
      close: (reason) => {
        const deviceId = peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null;
        args.logger.warn("sync_host.relay_authorization_closed", {
          reason,
          peerDeviceId: deviceId,
          peerDeviceName: peer.metadata?.deviceName ?? null,
          remoteAddress: peer.remoteAddress ?? null,
          connectedAt: peer.connectedAt,
        });
        if (deviceId) removeAllPresenceForDevice(deviceId, "remote");
        pairedChannelService.closePeer(peer.ws, reason, true);
        peer.authenticated = false;
        try {
          peer.ws.close(SYNC_RELAY_AUTHORIZATION_CLOSE_CODE, reason);
        } catch {
          // ignore close failures
        }
      },
      logger: args.logger,
    });
    lifecycle.initialize(initial);
    peer.relayAuthorization = lifecycle;
  };
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
  const lanePresenceByLaneId = new Map<string, Map<string, LanePresenceEntry>>();
  let localActiveLaneIds = new Set<string>();
  const pairFailureTracker = createPairFailureTracker();
  const registerPairFailure = (subject: PairFailureSubject): void => {
    pairFailureTracker.registerFailure(subject);
  };
  const pairingCooldownMsRemaining = (subject: PairFailureSubject): number =>
    pairFailureTracker.cooldownMsRemaining(subject);
  const clearPairFailuresAfterSuccessfulPair = (subject: PairFailureSubject): void => {
    pairFailureTracker.clearAfterSuccess(subject);
  };
  // Only fed by malformed/anomalous challenges (genuine abuse signals);
  // well-formed challenges deliberately feed no limiter. A separate tracker so
  // a malformed-challenge flood cannot spend the PIN budget, or vice versa.
  const adoptChallengeTracker = createPairFailureTracker();
  const registerAdoptChallengeIssuance = (ip: string | null): void => {
    adoptChallengeTracker.registerFailure({ ip });
  };
  const adoptChallengeCooldownMsRemaining = (ip: string | null): number =>
    adoptChallengeTracker.cooldownMsRemaining({ ip });
  const clearAdoptChallengeIssuancesAfterSuccessfulAuth = (
    ip: string | null,
  ): void => {
    adoptChallengeTracker.clearAfterSuccess({ ip });
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
        // A notModified cache-hit shell carries no lane fields — decorating it
        // would dereference detail.lane and turn the response into command_failed.
        return result && typeof result === "object" && (result as Partial<LaneDetailPayload>).lane
          ? decorateLaneDetailPayload(result as LaneDetailPayload)
          : result;
      case "lanes.create":
      case "lanes.createChild":
      case "lanes.createFromUnstaged":
      case "lanes.importBranch":
        return result && typeof result === "object"
          ? decorateLaneSummary(result as LaneSummary)
          : result;
      default:
        return result;
    }
  };
  const sharedListener = args.sharedListener ?? null;
  const expectedLoopbackNonce = sharedListener?.getExpectedLoopbackNonce()
    ?? generateLoopbackNonce();
  // Self-owned listener (desktop-embedded / standalone): only created when no
  // shared listener is injected. The brain injects a shared listener so the
  // websocket — and every connected phone — survives hosted-project switches.
  //
  // We front the WebSocketServer with an explicit http.Server so the non-upgrade
  // 426 response carries the ADE loopback marker header. `ws`'s built-in `{port}`
  // server owns an un-customizable 426 handler, which a bare/foreign `ws` process
  // matches exactly — the marker is what lets the loopback probe tell ADE apart.
  // Passing `server` (not `port`) means the WS upgrade path still works: `ws`
  // re-emits the http server's `listening`/`error` events and delegates
  // `address()`, so all existing event wiring below is preserved verbatim.
  const httpServer = sharedListener
    ? null
    : http.createServer((request, response) => {
        writeAdeLoopbackUpgradeResponse(request, response, expectedLoopbackNonce);
      });
  const server = sharedListener
    ? null
    : new WebSocketServer({
        server: httpServer!,
        maxPayload: SYNC_HOST_MAX_PAYLOAD_BYTES,
      });
  httpServer?.listen(args.port ?? DEFAULT_SYNC_HOST_PORT, SYNC_HOST_BIND_HOST);

  let disposed = false;
  let startupError: Error | null = null;
  const loopbackProbe = args.loopbackProbe ?? probeAdeLoopbackListener;
  let loopbackValidationStatus: SyncLoopbackValidationStatus = sharedListener
    ? sharedListener.getLoopbackValidationStatus()
    : {
        port: null,
        loopbackAdeValidated: false,
        lastFailureAt: null,
        reason: "The sync host listener has not been validated yet.",
        lastSuccessAt: null,
      };
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
  // Port the last `tailscale serve` was published for, so teardown can target
  // the exact per-node listener (`serve --tcp=<port> off`) instead of a constant.
  let tailnetServePort: number | null = null;
  let tailnetServeLastFailureSignature: string | null = null;
  let tailnetServePublishSequence = 0;
  let tailnetServeActivePublishToken = 0;
  let discoveryEnabled = args.discoveryEnabled !== false;
  // A peer owns one serialized chat -> changeset poll chain. Keeping the
  // in-flight gate per peer prevents a slow transcript filesystem read from
  // blocking unrelated peers or their later ack retries.
  const pollPumpPeersInFlight = new Set<PeerState>();
  // One bounded compact-state build can serve every far-behind phone. The
  // cache is capped at 10k rows / 4 MiB and therefore cannot grow with the
  // database; an oversized replica falls back to incremental replay.
  let mobileReplicaReseedCache: MobileReplicaReseedCache | null = null;
  let mobileReplicaReseedAdvancedPollGeneration = -1;
  // Constructing the cache is shared, but gzip/frame generation happens once
  // per recipient. Admit only one fresh compact send per poll so a reconnect
  // burst cannot monopolize the event loop or outbound socket budget.
  let mobileReplicaReseedLaunchPollGeneration = -1;
  let pollPumpGeneration = 0;
  // All-projects roster (mobile hub) coalescing state. Each subscribed peer
  // carries its own monotonic seq (PeerState.rosterSeq); clients re-snapshot on
  // any seq discontinuity.
  // Chat replay entries are intentionally bounded, but sequence high-water
  // marks must already exist when shared-listener peers are adopted below.
  const chatEventSequenceHighWaterBySession = new Map<string, number>();
  let rosterFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let rosterMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let rosterSafetyPollTimer: ReturnType<typeof setInterval> | null = null;
  let rosterFlushInFlight = false;
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

  server?.on("error", (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!disposed && !server?.address()) {
      startupError = normalized;
    }
    args.logger.warn("sync_host.server_error", {
      error: normalized.message,
      code: (normalized as NodeJS.ErrnoException).code ?? null,
      port: args.port ?? DEFAULT_SYNC_HOST_PORT,
    });
    args.onStateChanged?.();
  });

  const runPollPump = (): void => {
    if (disposed) return;
    const generation = ++pollPumpGeneration;
    for (const peer of peers) {
      if (pollPumpPeersInFlight.has(peer)) continue;
      pollPumpPeersInFlight.add(peer);
      void (async () => {
        try {
          // Preserve chat-first hydration for this peer without making its
          // transcript latency part of any other peer's catch-up path.
          await pumpChatEvents(peer);
        } catch (error) {
          args.logger.warn("sync_host.chat_poll_failed", {
            peerDeviceId: peer.metadata?.deviceId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await pumpChanges(peer, generation);
        } catch (error) {
          args.logger.warn("sync_host.poll_failed", {
            peerDeviceId: peer.metadata?.deviceId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })().finally(() => {
        pollPumpPeersInFlight.delete(peer);
      });
    }
  };

  const pollTimer = setInterval(() => {
    runPollPump();
  }, pollIntervalMs);
  const heartbeatTimer = setInterval(() => {
    pairFailureTracker.pruneExpired();
    adoptChallengeTracker.pruneExpired();
    const refreshedLocalPresence = refreshLocalLanePresence();
    if (refreshedLocalPresence || pruneExpiredLanePresence()) {
      args.onStateChanged?.();
      broadcastBrainStatus();
    }
    const sentAt = nowIso();
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (isPeerBackpressured(peer)) {
        if (isPeerBackpressuredTooLong(peer)) {
          args.logger.warn("sync_host.peer_backpressure_timeout", {
            peerDeviceId: peer.metadata?.deviceId ?? null,
            bufferedAmount: peer.ws.bufferedAmount,
            backpressuredMs: peer.backpressuredSinceMs == null ? null : Date.now() - peer.backpressuredSinceMs,
          });
          closeBackpressuredPeer(peer, "Backpressure timed out");
          continue;
        }
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
  const accountLeaseTimer = setInterval(() => {
    void refreshAccountLease();
  }, Math.max(250, Math.floor(args.accountLeasePollMs ?? 1_000)));
  accountLeaseTimer.unref?.();
  void refreshAccountLease();
  const chatEventSubscription = args.agentChatService?.subscribeToEvents(
    (event) => {
      broadcastChatEvent(event);
    },
  ) ?? null;

  /**
   * Snap a PTY back to the desktop-preferred size once no connected peer is
   * still viewing it (mobile unsubscribe or disconnect). While another peer
   * remains subscribed the mobile size stays — that peer is still actively
   * driving the viewport.
   */
  function restoreDesktopTerminalSizeIfUnwatched(sessionId: string): void {
    for (const other of peers) {
      if (other.subscribedSessionIds.has(sessionId) && other.ws.readyState === WebSocket.OPEN) return;
    }
    try {
      args.ptyService.restoreDesktopSizeBySessionId(sessionId);
    } catch (error) {
      args.logger.warn("sync_host.restore_desktop_terminal_size_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function clearPeerAuthTimeout(peer: PeerState): void {
    if (!peer.authTimeout) return;
    clearTimeout(peer.authTimeout);
    peer.authTimeout = null;
  }

  function abortPeerOperations(peer: PeerState, reason: string): void {
    for (const controller of peer.inFlightOperationControllers) {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    }
    peer.inFlightOperationControllers.clear();
  }

  function isPeerLifecycleCurrent(peer: PeerState, generation: number): boolean {
    return !disposed
      && peers.has(peer)
      && peer.lifecycleGeneration === generation
      && peer.ws.readyState === WebSocket.OPEN;
  }

  function isCurrentTerminalSnapshotBarrier(
    peer: PeerState,
    sessionId: string,
    barrier: PendingTerminalSnapshotBarrier,
    lifecycleGeneration: number,
  ): boolean {
    const currentBarrier = peer.pendingTerminalSnapshots.get(sessionId);
    return isPeerLifecycleCurrent(peer, lifecycleGeneration)
      && currentBarrier === barrier
      && !barrier.failed;
  }

  function clearTerminalSnapshotBarrier(
    peer: PeerState,
    sessionId: string,
    barrier?: PendingTerminalSnapshotBarrier,
  ): void {
    const currentBarrier = peer.pendingTerminalSnapshots.get(sessionId);
    if (barrier && currentBarrier !== barrier) return;
    peer.pendingTerminalSnapshots.delete(sessionId);
  }

  function requireFreshTerminalSnapshot(
    barrier: PendingTerminalSnapshotBarrier,
    endOffset?: number | null,
  ): void {
    barrier.requiredCaptureAttempt = Math.max(
      barrier.requiredCaptureAttempt,
      barrier.captureAttempt + 1,
    );
    if (typeof endOffset === "number" && Number.isSafeInteger(endOffset) && endOffset >= 0) {
      barrier.requiredSnapshotEndOffset = Math.max(
        barrier.requiredSnapshotEndOffset ?? 0,
        endOffset,
      );
    }
  }

  function discardTrackedTerminalDataForRecapture(barrier: PendingTerminalSnapshotBarrier): void {
    const retained: PendingTerminalSnapshotEvent[] = [];
    let queuedBytes = 0;
    for (const event of barrier.events) {
      if (event.kind === "data" && event.payload.offset != null) {
        requireFreshTerminalSnapshot(barrier, event.payload.offset);
        continue;
      }
      retained.push(event);
      queuedBytes += event.byteLength;
    }
    barrier.events = retained;
    barrier.queuedBytes = queuedBytes;
  }

  function failTerminalSnapshotBarrier(
    peer: PeerState,
    sessionId: string,
    barrier: PendingTerminalSnapshotBarrier,
    reason: string,
  ): void {
    if (barrier.failed) return;
    barrier.failed = true;
    args.logger.warn("sync_host.terminal_snapshot_barrier_failed", {
      sessionId,
      reason,
      captureAttempt: barrier.captureAttempt,
      queuedEvents: barrier.events.length,
      queuedBytes: barrier.queuedBytes,
      peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
    });
    try {
      peer.ws.close(4001, "Terminal snapshot catch-up failed");
    } catch {
      // The failed barrier still prevents an out-of-order or lossy flush.
    }
  }

  function enqueueTerminalSnapshotEvent(
    peer: PeerState,
    sessionId: string,
    event: PendingTerminalSnapshotEvent,
  ): boolean {
    const barrier = peer.pendingTerminalSnapshots.get(sessionId);
    if (!barrier) return false;
    if (barrier.failed) return true;

    const exceedsBudget = (): boolean => (
      barrier.events.length >= MAX_PENDING_TERMINAL_SNAPSHOT_EVENTS
      || barrier.queuedBytes + event.byteLength > MAX_PENDING_TERMINAL_SNAPSHOT_BYTES
    );
    if (exceedsBudget()) {
      // Numeric-offset data is durably represented by a fresh authoritative
      // transcript snapshot, so shed only those queued events and require the
      // next capture to cover their highest end offset. Offsetless data and
      // exits are not reconstructable and must remain explicitly queued.
      discardTrackedTerminalDataForRecapture(barrier);
    }
    if (exceedsBudget()) {
      if (event.kind === "data" && event.payload.offset != null) {
        requireFreshTerminalSnapshot(barrier, event.payload.offset);
        return true;
      }
      failTerminalSnapshotBarrier(peer, sessionId, barrier, "unreconstructable_queue_overflow");
      return true;
    }

    if (event.kind === "data" && event.payload.offset == null) {
      requireFreshTerminalSnapshot(barrier);
    }
    barrier.events.push(event);
    barrier.queuedBytes += event.byteLength;
    return true;
  }

  function planTerminalSnapshotFlush(
    barrier: PendingTerminalSnapshotBarrier,
    snapshotEndOffset: number | null,
  ): { needsRecapture: boolean; events: PendingTerminalSnapshotEvent[] } {
    if (
      barrier.requiredCaptureAttempt > barrier.captureAttempt
      || (
        barrier.requiredSnapshotEndOffset != null
        && (snapshotEndOffset == null || snapshotEndOffset < barrier.requiredSnapshotEndOffset)
      )
    ) {
      return { needsRecapture: true, events: [] };
    }

    const planned: PendingTerminalSnapshotEvent[] = [];
    let watermark = snapshotEndOffset;
    let offsetsAreContinuous = watermark != null;
    for (const event of barrier.events) {
      if (event.kind === "exit") {
        planned.push(event);
        continue;
      }
      const endOffset = event.payload.offset;
      const bytes = Buffer.from(event.payload.data, "utf8");
      if (
        !offsetsAreContinuous
        || endOffset == null
        || !Number.isSafeInteger(endOffset)
        || endOffset < bytes.length
      ) {
        planned.push(event);
        offsetsAreContinuous = false;
        continue;
      }
      const startOffset = endOffset - bytes.length;
      if (endOffset <= watermark!) {
        continue;
      }
      if (startOffset > watermark!) {
        requireFreshTerminalSnapshot(barrier, endOffset);
        discardTrackedTerminalDataForRecapture(barrier);
        return { needsRecapture: true, events: [] };
      }
      const overlapBytes = watermark! - startOffset;
      if (
        overlapBytes > 0
        && overlapBytes < bytes.length
        && (bytes[overlapBytes]! & 0b1100_0000) === 0b1000_0000
      ) {
        requireFreshTerminalSnapshot(barrier, endOffset);
        discardTrackedTerminalDataForRecapture(barrier);
        return { needsRecapture: true, events: [] };
      }
      const suffix = overlapBytes === 0 ? bytes : bytes.subarray(overlapBytes);
      planned.push({
        ...event,
        payload: {
          ...event.payload,
          data: suffix.toString("utf8"),
        },
        byteLength: suffix.length,
      });
      watermark = endOffset;
    }
    return { needsRecapture: false, events: planned };
  }

  async function withHelloCommitLock<T>(deviceId: string, work: () => Promise<T> | T): Promise<T> {
    const prior = helloCommitQueueByDevice.get(deviceId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => {}).then(() => held);
    helloCommitQueueByDevice.set(deviceId, tail);
    await prior.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (helloCommitQueueByDevice.get(deviceId) === tail) {
        helloCommitQueueByDevice.delete(deviceId);
      }
    }
  }

  function registerPeer(
    ws: WebSocket,
    remoteAddress: string | null,
    remotePort: number | null,
    transportOrigin: SyncTransportOrigin,
  ): PeerState {
    const peer: PeerState = {
      ws,
      lifecycleGeneration: 0,
      metadata: null,
      negotiatedCompression: null,
      envelopeChunks: createSyncEnvelopeChunkAssembler(),
      authenticated: false,
      authTimeout: null,
      authKind: null,
      pairedDeviceId: null,
      pairingRecord: null,
      pairingCommitOfferedForDeviceId: null,
      pendingPairingCommitDeviceId: null,
      pendingPairingCommitSecret: null,
      connectedAt: nowIso(),
      lastSeenAt: nowIso(),
      framesReceived: 0,
      lastAppliedAt: null,
      lastKnownServerDbVersion: 0,
      latencyMs: null,
      awaitingHeartbeatAt: null,
      missedHeartbeatCount: 0,
      backpressuredSinceMs: null,
      changesetPriorityDeferredSinceMs: null,
      changesetRecoveryLevel: 0,
      changesetRecoveryNotBeforeMs: 0,
      remoteAddress,
      remotePort,
      transportOrigin,
      relayAuthorization: null,
      reportedIncompatibleAdoptCipher: false,
      adoptChallenge: null,
      subscribedSessionIds: new Set(),
      pendingTerminalSnapshots: new Map(),
      nextTerminalSnapshotGeneration: 0,
      subscribedChatSessionIds: new Set(),
      hydratingChatSessionIds: new Set(),
      chatSubscriptionBindings: new Map(),
      chatTranscriptOffsets: new Map(),
      chatTranscriptScanOffsets: new Map(),
      chatEventIdsSent: new Map(),
      resolvedChatTranscriptPaths: new Map(),
      pendingChangesetBatch: null,
      mobileReplicaReseedDisabled: false,
      rosterSubscribed: false,
      rosterSeq: 0,
      rosterBaseline: new Map(),
      messageQueue: Promise.resolve(),
      writeQueue: Promise.resolve(),
      activeReadCount: 0,
      readSlotWaiters: [],
      queuedMessageCount: 0,
      terminalInputQueue: Promise.resolve(),
      pendingTerminalOwnershipChanges: 0,
      inFlightOperationControllers: new Set(),
      // Paired clients own their local preference. Fail closed on every new
      // connection until that client explicitly reasserts consent, so an
      // opted-out reconnect cannot leak an exportable first mutation.
      productAnalyticsEnabled: false,
    };
    peers.add(peer);
    peer.authTimeout = setTimeout(() => {
      if (disposed || peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) return;
      args.logger.warn("sync_host.auth_timeout", {
        remoteAddress: peer.remoteAddress ?? null,
        connectedAt: peer.connectedAt,
      });
      try {
        peer.ws.close(4003, "Authentication timed out");
      } catch {
        // ignore close failures
      }
    }, authTimeoutMs);
    peer.authTimeout.unref?.();
    ws.on("message", (raw) => {
      peer.framesReceived += 1;
      let envelope: ParsedSyncEnvelope;
      try {
        envelope = parseSyncEnvelope(wsDataToText(raw));
        if (
          envelope.type === "envelope_chunk"
          && peer.authenticated
          && peer.metadata?.capabilities?.includes(SYNC_CHUNKED_ENVELOPES_CAPABILITY)
        ) {
          const chunk = parseSyncEnvelopeChunkPayload(envelope.payload);
          if (!chunk) throw new Error("Invalid envelope_chunk payload.");
          const reassembled = peer.envelopeChunks.add(chunk);
          if (!reassembled) return;
          envelope = parseSyncEnvelope(reassembled);
          if (envelope.type === "envelope_chunk") {
            throw new Error("Nested envelope_chunk frames are not allowed.");
          }
        }
      } catch (error) {
        if (error instanceof SyncProtocolVersionMismatchError) {
          const payload = sendSyncProtocolVersionMismatchAndClose(
            peer.ws,
            error,
            () => {
              clearPeerAuthTimeout(peer);
            },
          );
          args.logger.warn("sync_host.protocol_version_mismatch", {
            receivedVersion: payload.receivedVersion,
            currentVersion: payload.currentVersion,
            minSupportedVersion: payload.minSupportedVersion,
            remoteAddress: peer.remoteAddress,
          });
          return;
        }
        args.logger.warn("sync_host.message_parse_failed", {
          error: error instanceof Error ? error.message : String(error),
          peerDeviceId: peer.metadata?.deviceId ?? null,
        });
        return;
      }
      if (handleImmediateControlEnvelope(peer, envelope)) return;
      peer.queuedMessageCount += 1;
      const changesTerminalOwnership = envelope.type === "terminal_subscribe"
        || envelope.type === "terminal_unsubscribe";
      if (changesTerminalOwnership) peer.pendingTerminalOwnershipChanges += 1;
      // The timeout starts when the handler starts, never while the envelope
      // waits its turn — same as the fully serialized queue this replaced.
      const runEnvelope = () => handleMessageWithTimeout(peer, envelope)
        .catch((error) => {
          args.logger.warn("sync_host.message_failed", {
            error: error instanceof Error ? error.message : String(error),
            peerDeviceId: peer.metadata?.deviceId ?? null,
            peerDeviceName: peer.metadata?.deviceName ?? null,
            remoteAddress: peer.remoteAddress ?? null,
            remotePort: peer.remotePort ?? null,
            messageType: envelope.type,
            requestId: envelope.requestId ?? null,
          });
        })
        .finally(() => {
          peer.queuedMessageCount = Math.max(0, peer.queuedMessageCount - 1);
          if (changesTerminalOwnership) {
            peer.pendingTerminalOwnershipChanges = Math.max(0, peer.pendingTerminalOwnershipChanges - 1);
          }
        });
      const previousWork = peer.messageQueue.catch(() => {});
      let scheduled: Promise<void>;
      if (isConcurrentReadEnvelope(envelope)) {
        // Wait for the preceding write barrier BEFORE taking a read slot: a
        // read that held a slot while waiting on a write could starve an
        // earlier read the write is itself waiting on.
        scheduled = peer.writeQueue.catch(() => {}).then(async () => {
          await acquirePeerReadSlot(peer);
          try {
            await runEnvelope();
          } finally {
            releasePeerReadSlot(peer);
          }
        });
      } else {
        scheduled = previousWork.then(runEnvelope);
        peer.writeQueue = scheduled;
      }
      peer.messageQueue = Promise.all([previousWork, scheduled]).then(() => {});
    });
    ws.on("close", (code, reason) => {
      peer.lifecycleGeneration += 1;
      abortPeerOperations(peer, "Sync peer closed.");
      peer.pendingTerminalSnapshots.clear();
      peer.envelopeChunks.reset();
      clearPeerAuthTimeout(peer);
      releaseConnectionAttemptWinner(peer);
      peer.relayAuthorization?.dispose();
      peer.relayAuthorization = null;
      // The close frame is the only record of WHY a peer left: a deliberate
      // client teardown carries a code + reason string ("Network route
      // changed.", "The machine took too long to respond.", …) while 1006
      // means the transport died with no close frame at all. Keep this log —
      // it is the primary tool for diagnosing mobile disconnect loops.
      const closeDetail = {
        code,
        reason: reason.toString("utf8") || null,
        peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
        peerName: peer.metadata?.deviceName ?? null,
        remoteAddress: peer.remoteAddress ?? null,
        connectedAt: peer.connectedAt ?? null,
        authenticated: peer.authenticated,
      };
      // A peer that never sent a frame never attempted the protocol: the relay
      // readiness self-probe bridges in and drops on every poll, and so does a
      // port scan. Logging those at info buried the real signal — a rejected
      // peer looks identical at a glance — so keep them at debug. Anything that
      // actually spoke, including every authentication failure, stays at info.
      if (!peer.authenticated && peer.framesReceived === 0) {
        args.logger.debug("sync_host.peer_closed_without_frames", closeDetail);
      } else {
        args.logger.info("sync_host.peer_closed", closeDetail);
      }
      if (removeAllPresenceForDevice(peer.metadata?.deviceId, "remote")) {
        broadcastBrainStatus();
      }
      peers.delete(peer);
      if (peer.rosterSubscribed && rosterSubscriberPeers().length === 0) {
        stopRosterSafetyPoll();
        clearRosterFlushTimers();
      }
      for (const sessionId of peer.subscribedSessionIds) {
        restoreDesktopTerminalSizeIfUnwatched(sessionId);
      }
      pairedChannelService.closePeer(peer.ws, "Sync socket closed.", false);
      args.onStateChanged?.();
      broadcastBrainStatus();
    });
    ws.on("error", (error) => {
      args.logger.warn("sync_host.socket_error", {
        error: error instanceof Error ? error.message : String(error),
        peerDeviceId: peer.metadata?.deviceId ?? null,
      });
    });
    return peer;
  }

  server?.on("connection", (ws, request) => {
    registerPeer(ws, sanitizeRemoteAddress(request.socket.remoteAddress), request.socket.remotePort ?? null, "direct");
  });

  /**
   * Adopt sockets handed off by the previous host service (plus any
   * connections that arrived while no host owned the shared listener). Peers
   * that were authenticated on the old host stay authenticated: their
   * metadata/auth is carried over, the per-project changeset cursor is
   * recomputed for THIS project's DB from the hello dbVersionBySite map, and
   * a fresh brain_status + project_catalog tells the client the project
   * context changed. Frames buffered during the handoff window are replayed.
   */
  async function adoptHandedOffPeers(): Promise<void> {
    if (!sharedListener || disposed) return;
    const snapshots = sharedListener.takePeers();
    if (snapshots.length === 0) return;
    const adopted: PeerState[] = [];
    for (const snapshot of snapshots) {
      const ws = snapshot.ws;
      if (ws.readyState !== WebSocket.OPEN) {
        // takePeers() already stripped the parked listeners; leave a no-op
        // error handler so a late transport error cannot crash the process.
        ws.removeAllListeners("error");
        ws.on("error", () => {});
        try {
          ws.close();
        } catch {
          // ignore close failures
        }
        continue;
      }
      // The previous owner (host service or listener parking) must leave no
      // listeners behind — this host attaches its own message/close/error
      // handlers via registerPeer.
      ws.removeAllListeners("message");
      ws.removeAllListeners("close");
      ws.removeAllListeners("error");
      const peer = registerPeer(
        ws,
        sanitizeRemoteAddress(snapshot.remoteAddress),
        snapshot.remotePort,
        snapshot.transportOrigin ?? "direct",
      );
      if (snapshot.metadata && snapshot.authKind) {
        const pairingRecord = isRecordBackedSyncAuthKind(snapshot.authKind) && snapshot.pairedDeviceId
          ? pairingStore.getPairingRecord(snapshot.pairedDeviceId)
          : null;
        if (isRecordBackedSyncAuthKind(snapshot.authKind) && !pairingRecord) {
          // Pairing is not valid for this host (revoked or different secrets
          // store) — fail closed and force a fresh authenticated reconnect.
          clearPeerAuthTimeout(peer);
          peers.delete(peer);
          try {
            ws.close(4003, "Authentication required");
          } catch {
            // ignore close failures
          }
          continue;
        }
        peer.authenticated = true;
        clearPeerAuthTimeout(peer);
        peer.metadata = snapshot.metadata;
        peer.negotiatedCompression = snapshot.negotiatedCompression ?? null;
        peer.authKind = snapshot.authKind;
        peer.pairedDeviceId = snapshot.pairedDeviceId;
        peer.pairingRecord = pairingRecord;
        const handedOffAttempt = snapshot.metadata.connectionAttempt;
        if (handedOffAttempt) {
          const accepted = connectionAttemptByDevice.get(snapshot.metadata.deviceId);
          if (!accepted || handedOffAttempt.startedAtMs > accepted.startedAtMs) {
            connectionAttemptByDevice.set(snapshot.metadata.deviceId, {
              ...handedOffAttempt,
              reservedAtMs: Date.now(),
              winner: peer,
            });
          }
        }
        const legacyRelayExpiry = typeof snapshot.relayAccountExpiresAtMs === "number"
          && Number.isFinite(snapshot.relayAccountExpiresAtMs)
          ? snapshot.relayAccountExpiresAtMs
          : null;
        const handedOffRelayAuthorization = snapshot.relayAuthorization
          ?? (peer.transportOrigin === "relay-bridge" && legacyRelayExpiry != null
            ? {
                ownerUserId: pairingRecord?.accountOwnerUserId
                  ?? accountLeaseUserId
                  ?? "legacy-relay-handoff",
                expiresAtMs: legacyRelayExpiry,
                challenge: randomBytes(24).toString("base64url"),
              }
            : null);
        installRelayAuthorization(
          peer,
          handedOffRelayAuthorization,
          snapshot.relayAuthorization ? undefined : false,
        );
        terminalInputDedupeLedger.restore(snapshot.terminalInputDedupe ?? []);
        peer.connectedAt = snapshot.connectedAt;
        const serverDbSiteId = args.db.sync.getSiteId();
        peer.lastKnownServerDbVersion = adoptedSyncHostCursorForPeer({
          peer: snapshot.metadata,
          serverDbSiteId,
          serverDbVersion: args.db.sync.getDbVersion(),
          snapshotServerDbSiteId: snapshot.serverDbSiteId,
          snapshotLastKnownServerDbVersion: snapshot.lastKnownServerDbVersion,
        });
        // Restore live subscriptions so streaming does not silently stop for
        // a peer that never observes a disconnect. Sessions from a different
        // project simply no-op on this host; the phone that REQUESTED a
        // project switch tears down its socket and re-subscribes on its own.
        for (const sessionId of snapshot.subscribedSessionIds ?? []) {
          peer.subscribedSessionIds.add(sessionId);
        }
        for (const [sessionId, offset] of Object.entries(snapshot.chatTranscriptOffsets ?? {})) {
          if (!Number.isFinite(offset)) continue;
          peer.chatTranscriptOffsets.set(sessionId, Math.max(0, Math.floor(offset)));
        }
        for (const [sessionId, eventSequence] of Object.entries(snapshot.chatEventSequences ?? {})) {
          if (!Number.isFinite(eventSequence) || eventSequence <= 0) continue;
          const normalized = Math.floor(eventSequence);
          chatEventSequenceHighWaterBySession.set(
            sessionId,
            Math.max(chatEventSequenceHighWaterBySession.get(sessionId) ?? 0, normalized),
          );
        }
        const handedOffChatSubscriptions = snapshot.chatSubscriptions
          ?? (snapshot.subscribedChatSessionIds ?? []).map((sessionId) => ({
            sessionId,
            scope: "project" as const,
          }));
        for (const subscription of handedOffChatSubscriptions) {
          const { sessionId, scope } = subscription;
          if (scope === "personal") {
            const transcriptPath = await args.personalChatScope?.transcriptPath?.(sessionId).catch(() => null) ?? null;
            if (!transcriptPath) continue;
            peer.resolvedChatTranscriptPaths.set(sessionId, transcriptPath);
          }
          // Re-acknowledge the subscription before enabling its live stream.
          // The host sequence high-water was restored above, so subsequent
          // events continue the same monotonic epoch. A non-resumed ack remains
          // compatible with old clients and lets the transcript pump fill any
          // event gap that occurred while the host owner changed.
          const turnActive = scope === "personal"
            ? await args.personalChatScope?.isTurnActive?.(sessionId).catch(() => false)
            : undefined;
          sendRequired(peer, "chat_subscribe", {
            sessionId,
            capturedAt: nowIso(),
            truncated: false,
            events: [],
            ...(typeof turnActive === "boolean" ? { turnActive } : {}),
          } satisfies SyncChatSubscribeSnapshotPayload);
          peer.subscribedChatSessionIds.add(sessionId);
          peer.chatSubscriptionBindings.set(sessionId, { scope });
        }
        peer.rosterSubscribed = snapshot.rosterSubscribed === true;
        peer.productAnalyticsEnabled = snapshot.productAnalyticsEnabled === true;
        args.deviceRegistryService?.upsertPeerMetadata(snapshot.metadata, {
          lastSeenAt: nowIso(),
          lastHost: peer.remoteAddress,
          lastPort: peer.remotePort,
        });
        adopted.push(peer);
        args.logger.info("sync_host.peer_adopted", {
          peerDeviceId: snapshot.metadata.deviceId,
          peerName: snapshot.metadata.deviceName,
          authKind: snapshot.authKind,
          remoteAddress: peer.remoteAddress ?? null,
          lastKnownServerDbVersion: peer.lastKnownServerDbVersion,
        });
      }
      for (const buffered of snapshot.bufferedMessages ?? []) {
        ws.emit("message", buffered.data, buffered.isBinary);
      }
    }
    args.onStateChanged?.();
    if (adopted.length === 0) return;
    const projectCatalog = await buildProjectCatalogPayload();
    const brainStatus = buildBrainStatus();
    for (const peer of adopted) {
      if (peer.ws.readyState !== WebSocket.OPEN) continue;
      send(peer.ws, "brain_status", brainStatus);
      sendProjectCatalog(peer, projectCatalog);
    }
    // Re-prime any roster subscription carried across the host switch: a fresh
    // snapshot (new seq epoch) re-seeds the peer's baseline on this host.
    if (args.rosterProvider && adopted.some((peer) => peer.rosterSubscribed)) {
      ensureRosterSafetyPoll();
      const projects = await buildRosterProjects();
      if (projects != null) {
        for (const peer of adopted) {
          if (!peer.rosterSubscribed || peer.ws.readyState !== WebSocket.OPEN) continue;
          sendRosterSnapshotToPeer(peer, projects);
        }
      }
    }
    runPollPump();
  }

  let detachSharedListener: (() => void) | null = null;
  if (sharedListener) {
    detachSharedListener = sharedListener.setConnectionHandler((connection) => {
      registerPeer(
        connection.ws,
        sanitizeRemoteAddress(connection.remoteAddress),
        connection.remotePort,
        connection.transportOrigin,
      );
    });
    void adoptHandedOffPeers().catch((error) => {
      args.logger.warn("sync_host.peer_adoption_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

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
    // Loopback-bound hosts are intentionally not advertised on the LAN; remote reachability is handled by explicit/tailnet paths.
    if (SYNC_HOST_BIND_LOOPBACK_ONLY) {
      unpublishLanDiscovery();
      return;
    }
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
      // Advertise whether a pairing PIN exists so a phone can decide, pre-pair,
      // whether to show the PIN-entry screen or a "set a PIN on your Mac first"
      // prompt. Stringified because Bonjour TXT values are strings.
      pairingPinConfigured: args.pinStore.hasPin() ? "true" : "false",
      // Human name for THIS runtime (one per socket/siteId), so the phone can
      // tell two runtimes on the same machine apart. Empty string when unset.
      runtimeName: args.runtimeNameStore?.getRuntimeName() ?? "",
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
        servicePort: port,
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
        servicePort: port,
        target: null,
        updatedAt: nowIso(),
        error: "Tailscale Serve discovery is not available in this ADE process.",
        stderr: null,
      });
      return;
    }
    const cli = resolveTailscaleCliPath();
    // Plain per-node `tailscale serve` on the REAL dynamic socket port. The
    // tagged-node Service form (`--service=...`) requires the node to be tagged
    // and fails with "service hosts must be tagged nodes" on ordinary devices,
    // and it also pinned the listener to a constant port (8787) that never
    // matched the live socket. Per-node serve works on any node and targets the
    // actual port phones must connect to.
    const signature = `serve:${port}`;
    if (tailnetServeSignature === signature && !options?.force) return;
    if (tailnetServeLastFailureSignature === signature && !options?.force) return;
    const publishToken = ++tailnetServePublishSequence;
    tailnetServeActivePublishToken = publishToken;
    tailnetServeSignature = signature;
    tailnetServePort = port;
    const target = `tcp://127.0.0.1:${port}`;
    updateTailnetDiscoveryStatus({
      state: "publishing",
      serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
      servicePort: port,
      target,
      updatedAt: nowIso(),
      error: null,
      stderr: null,
    });
    const cliArgs = [
      "serve",
      "--bg",
      `--tcp=${port}`,
      target,
    ];
    void execFileAsync(cli, cliArgs, { timeout: 10_000, windowsHide: true })
      .then(({ stdout, stderr }) => {
        if (tailnetServeActivePublishToken !== publishToken) return;
        tailnetServeLastFailureSignature = null;
        const stdoutText = stdout.trim();
        const stderrText = stderr.trim();
        const outputText = [stdoutText, stderrText].filter(Boolean).join("\n");
        updateTailnetDiscoveryStatus({
          state: looksLikePendingTailnetApproval(outputText) ? "pending_approval" : "published",
          serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: port,
          target,
          updatedAt: nowIso(),
          error: null,
          stderr: stderrText || null,
        });
        args.logger.info("sync_host.tailnet_discovery_published", {
          service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: port,
          target,
          stdout: stdoutText || null,
          stderr: stderrText || null,
        });
        // Best-effort and deliberately after publish: reclaiming old entries
        // must never delay or endanger advertising the live port.
        if (tailnetServeActivePublishToken === publishToken) {
          void reclaimStaleTailnetServes(port).catch(() => {});
        }
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
          servicePort: port,
          target,
          updatedAt: nowIso(),
          error: code === "ENOENT" ? "Tailscale CLI was not found." : errorMessage,
          stderr,
        });
        const logPayload = {
          service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: port,
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

  // A stranded `tailscale serve` entry forwards to a port nothing listens on.
  // A live one — this host or a sibling ADE — has a real listener behind it.
  const isLocalPortServing = (port: number): Promise<boolean> => new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (serving: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(serving);
    };
    socket.setTimeout(750, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });

  // `serve --bg` outlives the process that registered it, but the port ADE
  // tracks is in-memory only, so every restart — and every force-kill that
  // skips the teardown below — orphans the previous entry. Tailscale keeps it
  // bound on the tailnet address, which makes ADE's own next wildcard bind fail
  // EADDRINUSE against its own leftovers and walk one port higher, leaking
  // another entry. It ratchets forever; one machine had 66 stranded ports and
  // burned ~70 failed binds on every start. Reclaim them whenever we publish.
  const reclaimStaleTailnetServes = async (currentPort: number): Promise<void> => {
    const cli = resolveTailscaleCliPath();
    let stale: number[];
    try {
      const { stdout } = await execFileAsync(
        cli,
        ["serve", "status", "--json"],
        { timeout: 10_000, windowsHide: true },
      );
      stale = staleAdeTailnetServePorts(stdout, currentPort);
    } catch {
      // No Tailscale, no permission, unparseable output: publishing the current
      // port matters more than tidying old ones.
      return;
    }
    if (stale.length === 0) return;
    let reclaimed = 0;
    for (const port of stale) {
      // The snapshot is stale the moment reclaiming starts: turning off a low
      // port frees it, and a host restarting mid-loop prefers exactly those low
      // ports. Without re-checking, this loop can turn off the serve entry a
      // newer host just published and leave the machine with no tailnet route
      // at all, while status still reports "published".
      if (disposed) return;
      if (tailnetServePort != null && port === tailnetServePort) continue;
      // `tailscale serve` is machine-global while the sync-host singleton is
      // uid- and channel-scoped, so a sibling ADE (another channel, another
      // user) can legitimately own one of these ports. Its serve entry is
      // byte-identical to a stale one — same port forwarding to 127.0.0.1 on
      // the same port — so the status output cannot tell them apart. What does
      // is whether anything is actually listening: a stranded entry forwards
      // into nothing. Probe immediately before each teardown, so the window
      // between the snapshot and this `off` is closed too.
      if (await isLocalPortServing(port)) continue;
      try {
        await execFileAsync(
          cli,
          ["serve", `--tcp=${port}`, "off"],
          { timeout: 10_000, windowsHide: true },
        );
        reclaimed += 1;
      } catch {
        // A single stubborn entry must not stop the rest.
      }
    }
    args.logger.info("sync_host.tailnet_serve_reclaimed", {
      currentPort,
      staleCount: stale.length,
      reclaimed,
      ports: stale.slice(0, 20),
    });
  };

  const unpublishTailnetDiscovery = async (): Promise<void> => {
    if (!tailnetServeSignature) return;
    tailnetServeActivePublishToken = ++tailnetServePublishSequence;
    tailnetServeSignature = null;
    // Tear down the exact per-node listener we published. Fall back to the live
    // socket port if we somehow lost track of it.
    const servePort = tailnetServePort ?? SYNC_TAILNET_DISCOVERY_SERVICE_PORT;
    tailnetServePort = null;
    if (!shouldAttemptTailnetServiceAdvertise()) {
      updateTailnetDiscoveryStatus({
        state: "unavailable",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: servePort,
        target: null,
        updatedAt: nowIso(),
        error: null,
        stderr: null,
      });
      return;
    }
    const cli = resolveTailscaleCliPath();
    try {
      // Plain per-node teardown matching the `serve --bg --tcp=<port>` form.
      await execFileAsync(
        cli,
        ["serve", `--tcp=${servePort}`, "off"],
        { timeout: 10_000, windowsHide: true },
      );
      updateTailnetDiscoveryStatus({
        state: "disabled",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: servePort,
        target: null,
        updatedAt: nowIso(),
        error: null,
        stderr: null,
      });
      args.logger.info("sync_host.tailnet_discovery_unpublished", {
        service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: servePort,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? null;
      updateTailnetDiscoveryStatus({
        state: code === "ENOENT" ? "unavailable" : "disabled",
        serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: servePort,
        target: null,
        updatedAt: nowIso(),
        error: code === "ENOENT" ? "Tailscale CLI was not found." : errorMessage,
        stderr: null,
      });
      args.logger.warn("sync_host.tailnet_discovery_unpublish_failed", {
        service: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
        servicePort: servePort,
        error: errorMessage,
        code,
      });
    }
  };

  const validateListeningPort = async (
    port: number,
    options?: { force?: boolean },
  ): Promise<void> => {
    // Re-publish paths pass force:true so a shadow that arose AFTER startup is
    // caught before we (re)advertise the port; the startup path keeps the cheap
    // short-circuit once a port is validated.
    if (
      !options?.force
      && loopbackValidationStatus.port === port
      && loopbackValidationStatus.loopbackAdeValidated
    ) return;
    try {
      const result = await assertAdeLoopbackListener(
        port,
        expectedLoopbackNonce,
        loopbackProbe,
      );
      loopbackValidationStatus = {
        port,
        loopbackAdeValidated: true,
        lastFailureAt: loopbackValidationStatus.lastFailureAt,
        reason: null,
        lastSuccessAt: result.checkedAt,
      };
    } catch (error) {
      if (isLoopbackShadowedError(error)) {
        loopbackValidationStatus = {
          port,
          loopbackAdeValidated: false,
          lastFailureAt: error.failedAt,
          reason: error.message,
          lastSuccessAt: loopbackValidationStatus.lastSuccessAt,
        };
      }
      throw error;
    }
  };

  const publishValidatedDiscovery = async (
    port: number,
    options?: { forceLan?: boolean; forceTailnet?: boolean },
  ): Promise<void> => {
    const lanPortChanged = bonjourPort != null && bonjourPort !== port;
    const tailnetPortChanged = tailnetServePort != null && tailnetServePort !== port;
    if (lanPortChanged) unpublishLanDiscovery();
    if (tailnetPortChanged) await unpublishTailnetDiscovery();
    if (disposed) return;
    publishLanDiscovery(port, { force: options?.forceLan });
    publishTailnetDiscovery(port, { force: options?.forceTailnet });
  };

  function peerForSocket(ws: WebSocket): PeerState | null {
    for (const peer of peers) {
      if (peer.ws === ws) return peer;
    }
    return null;
  }

  // Frame budget for a peer: clients that declared the chunkedEnvelopes hello
  // capability get oversized envelopes split into envelope_chunk frames so no
  // single websocket message can exceed their receive buffer (URLSession kills
  // the connection at ~1 MiB by default). Legacy peers keep full frames.
  function maxFrameBytesForPeer(peer: PeerState | null): number | null {
    return Array.isArray(peer?.metadata?.capabilities)
      && peer.metadata.capabilities.includes(SYNC_CHUNKED_ENVELOPES_CAPABILITY)
      ? DEFAULT_SYNC_MAX_FRAME_BYTES
      : null;
  }

  function encodeFramesFor<TPayload>(
    target: WebSocket | PeerState,
    type: SyncEnvelope["type"],
    payload: TPayload,
    requestId?: string | null,
  ): string[] {
    const peer = target instanceof WebSocket ? peerForSocket(target) : target;
    const negotiatedCompression = peer?.negotiatedCompression ?? null;
    return encodeSyncEnvelopeFrames({
      type,
      payload,
      requestId,
      compressionThresholdBytes: negotiatedCompression
        ? SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES
        : compressionThresholdBytes,
      compressionCodec: negotiatedCompression ?? "gzip",
      maxFrameBytes: maxFrameBytesForPeer(peer),
    });
  }

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
    // The backpressure gate runs once per envelope, not per frame: a chunked
    // envelope must ship every frame or the client's reassembly would stall.
    for (const frame of encodeFramesFor(target, type, payload, requestId)) {
      ws.send(frame);
    }
    return true;
  }

  function sendRequired<TPayload>(peer: PeerState, type: SyncEnvelope["type"], payload: TPayload, requestId?: string | null): boolean {
    const ws = peer.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    const frames = encodeFramesFor(peer, type, payload, requestId);
    const frameBytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame, "utf8"), 0);
    const backpressured = isPeerBackpressured(peer);
    if (
      ws.bufferedAmount + frameBytes > REQUIRED_SEND_MAX_BUFFERED_BYTES ||
      (backpressured && isPeerBackpressuredTooLong(peer))
    ) {
      args.logger.warn("sync_host.required_send_backpressured", {
        type,
        requestId: requestId ?? null,
        peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
        bufferedAmount: ws.bufferedAmount,
        frameBytes,
      });
      closeBackpressuredPeer(peer, "Required sync response backpressured");
      return false;
    }
    let reported = false;
    for (const frame of frames) {
      ws.send(frame, (error) => {
        if (!error || reported) return;
        reported = true;
        args.logger.warn("sync_host.required_send_failed", {
          type,
          requestId: requestId ?? null,
          peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
          error: error.message,
        });
      });
    }
    return true;
  }

  function isPeerBackpressured(peer: PeerState): boolean {
    const backpressured = peer.ws.bufferedAmount >= PEER_BACKPRESSURE_BYTES;
    if (!backpressured) {
      peer.backpressuredSinceMs = null;
      return false;
    }
    peer.backpressuredSinceMs ??= Date.now();
    return true;
  }

  function closeBackpressuredPeer(peer: PeerState, reason: string): void {
    try {
      peer.ws.close(4001, reason);
    } catch {
      // ignore close failures
    }
  }

  function isPeerBackpressuredTooLong(peer: PeerState): boolean {
    if (!isPeerBackpressured(peer)) return false;
    return peer.backpressuredSinceMs != null
      && Date.now() - peer.backpressuredSinceMs >= backpressureTimeoutMs;
  }

  const pairedChannelService = createSyncPairedChannelService<WebSocket>({
    logger: args.logger,
    getBufferedAmount: (ws) => ws.bufferedAmount,
    send: (ws, type, payload) => {
      const peer = peerForSocket(ws);
      return peer ? sendRequired(peer, type, payload) : false;
    },
  });

  function shouldDeferBackgroundChangesForChat(peer: PeerState): boolean {
    return shouldDeferSyncHostBackgroundChangesForChat({
      subscribedChatSessionCount: peer.subscribedChatSessionIds.size,
      bufferedAmount: peer.ws.bufferedAmount,
    });
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
    const frames = encodeFramesFor(ws, type, payload, requestId);
    const frameBytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame, "utf8"), 0);
    if (ws.bufferedAmount + frameBytes > REQUIRED_SEND_MAX_BUFFERED_BYTES) {
      return Promise.reject(new Error("WebSocket send buffer is over the required-send budget."));
    }
    return new Promise<void>((resolve, reject) => {
      let failed = false;
      let remaining = frames.length;
      const timer = setTimeout(() => {
        if (failed) return;
        failed = true;
        reject(new Error(`Timed out sending ${type} after ${SEND_AND_WAIT_TIMEOUT_MS}ms.`));
      }, SEND_AND_WAIT_TIMEOUT_MS);
      for (const frame of frames) {
        ws.send(frame, (error) => {
          if (failed) return;
          if (error) {
            failed = true;
            clearTimeout(timer);
            reject(error);
            return;
          }
          remaining -= 1;
          if (remaining === 0) {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    });
  }

  function closeExistingPeersForDevice(deviceId: string, currentPeer: PeerState): void {
    const normalized = toOptionalString(deviceId);
    if (!normalized) return;
    for (const peer of peers) {
      if (peer === currentPeer) continue;
      if (peer.metadata?.deviceId !== normalized && peer.pairedDeviceId !== normalized) continue;
      const presenceDeviceId = peer.metadata?.deviceId ?? peer.pairedDeviceId ?? normalized;
      const presenceRemoved = removeAllPresenceForDevice(presenceDeviceId, "remote");
      peer.authenticated = false;
      peer.metadata = null;
      peer.authKind = null;
      peer.pairedDeviceId = null;
      peer.pairingRecord = null;
      try {
        peer.ws.close(4000, "Superseded by a newer connection for this device");
      } catch {
        // ignore close failures
      }
      if (presenceRemoved) {
        broadcastBrainStatus();
      }
    }
  }

  function arbitrateConnectionAttempt(deviceId: string, currentPeer: PeerState, metadata: SyncPeerMetadata): boolean {
    const attempt = metadata.connectionAttempt;
    if (!attempt) {
      // Backward compatibility: a legacy hello keeps the historical
      // last-authenticated-hello-wins behavior.
      connectionAttemptByDevice.delete(deviceId);
      closeExistingPeersForDevice(deviceId, currentPeer);
      return true;
    }
    const accepted = connectionAttemptByDevice.get(deviceId);
    if (accepted) {
      const sameAttempt = accepted.id === attempt.id;
      // Arbitration may reserve a winner immediately before pairing/auth state
      // is committed. Treat that OPEN, owned peer as live so a concurrent
      // same-attempt candidate cannot steal the reservation in that gap.
      const liveWinner = Boolean(
        accepted.winner
        && peers.has(accepted.winner)
        && accepted.winner.ws.readyState === WebSocket.OPEN,
      );
      if (sameAttempt && !liveWinner) {
        accepted.winner = currentPeer;
        return true;
      }
      const olderOrEqualAttempt = attempt.startedAtMs <= accepted.startedAtMs;
      const reservationFresh = Date.now() - accepted.reservedAtMs <= CONNECTION_ATTEMPT_RESERVATION_TTL_MS;
      if (sameAttempt || (olderOrEqualAttempt && (liveWinner || reservationFresh))) return false;
    }
    // Authentication has already succeeded. Only now may a genuinely newer
    // attempt supersede the previous winner.
    closeExistingPeersForDevice(deviceId, currentPeer);
    connectionAttemptByDevice.set(deviceId, {
      id: attempt.id,
      startedAtMs: attempt.startedAtMs,
      reservedAtMs: Date.now(),
      winner: currentPeer,
    });
    return true;
  }

  function releaseConnectionAttemptWinner(peer: PeerState): void {
    for (const record of connectionAttemptByDevice.values()) {
      if (record.winner === peer) record.winner = null;
    }
  }

  function peerSupportsChangesetAck(peer: PeerState): boolean {
    return Array.isArray(peer.metadata?.capabilities) && peer.metadata.capabilities.includes("changesetAck");
  }

  function peerSupportsMobileReplicaReseed(peer: PeerState): boolean {
    return isMobileChangesetPeer(peer)
      && peerSupportsChangesetAck(peer)
      && peer.metadata?.capabilities?.includes(SYNC_CHUNKED_ENVELOPES_CAPABILITY) === true;
  }

  function isRuntimeOnlyPairedHost(peer: PeerState): boolean {
    return isRuntimeOnlySyncPeer(peer);
  }

  function sendChangesetBatchPayload(
    peer: PeerState,
    payload: SyncChangesetBatchPayload,
  ): PendingChangesetBatch | null {
    const batch: PendingChangesetBatch = {
      batchId: payload.batchId,
      reason: payload.reason,
      fromDbVersion: payload.fromDbVersion,
      toDbVersion: payload.toDbVersion,
      changes: payload.changes,
      sentAtMs: 0,
      attemptCount: 0,
      retryNotBeforeMs: 0,
    };
    const sent = isCompactInvalidationBrowserPeer(peer.metadata)
      ? send(peer, "invalidation_batch", buildSyncInvalidationBatchPayload({
        fromDbVersion: payload.fromDbVersion,
        toDbVersion: payload.toDbVersion,
        changes: payload.changes,
        compressionThresholdBytes,
      }))
      : send(peer, "changeset_batch", payload);
    if (!sent) return null;
    batch.sentAtMs = Date.now();
    batch.attemptCount = 1;
    return batch;
  }

  function sendNextChangesetBatch(
    peer: PeerState,
    reason: SyncChangesetBatchPayload["reason"],
    fromDbVersion: number,
    toDbVersion: number,
    changes: CrsqlChangeRow[],
    options: { maxRows?: number; maxBytes?: number } = {},
  ): PendingChangesetBatch | null {
    const payload = buildChangesetBatchPayload({
      deviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? "peer",
      reason,
      fromDbVersion,
      toDbVersion,
      changes,
      maxRows: options.maxRows ?? maxChangesetBatchRows,
      maxBytes: options.maxBytes ?? maxChangesetBatchBytes,
    });
    return payload ? sendChangesetBatchPayload(peer, payload) : null;
  }

  function buildMobileReplicaReseedStep(
    targetDbVersion: number,
    peerDbVersion: number,
    pollGeneration: number,
  ): MobileReplicaReseedCache {
    const cachedTargetLag = mobileReplicaReseedCache
      ? targetDbVersion - mobileReplicaReseedCache.targetDbVersion
      : 0;
    if (
      !mobileReplicaReseedCache
      || mobileReplicaReseedCache.targetDbVersion <= peerDbVersion
      || cachedTargetLag > SYNC_HOST_MOBILE_REPLICA_RESEED_GAP
    ) {
      mobileReplicaReseedCache = createMobileReplicaReseedCache(targetDbVersion);
      args.logger.info("sync_host.mobile_replica_reseed_started", {
        targetDbVersion,
        maxRows: MOBILE_REPLICA_RESEED_MAX_ROWS,
        maxBytes: MOBILE_REPLICA_RESEED_MAX_BYTES,
      });
    }

    const cache = mobileReplicaReseedCache;
    if (cache.status !== "building") return cache;
    if (pollGeneration <= mobileReplicaReseedAdvancedPollGeneration) return cache;
    mobileReplicaReseedAdvancedPollGeneration = pollGeneration;
    let advancedCache = cache;
    for (let emptyWindows = 0; emptyWindows < MOBILE_REPLICA_RESEED_MAX_EMPTY_WINDOWS_PER_POLL; emptyWindows += 1) {
      advancedCache = advanceMobileReplicaReseedCache({
        cache: advancedCache,
        versionWindow: SYNC_EXPORT_VERSION_WINDOW,
        exportChangesSince: args.db.sync.exportChangesSince,
        excludeTables: MOBILE_REPLICA_RESEED_EXCLUDED_TABLES,
        includeChange: (change) =>
          !isHostAuthoritativeTable(change)
          && !MOBILE_CHANGESET_EXCLUDED_TABLES.has(change.table),
      });
      if (advancedCache.status !== "building" || !advancedCache.lastAdvanceWasEmpty) break;
    }
    if (advancedCache.status === "too_large") {
      args.logger.info("sync_host.mobile_replica_reseed_skipped", {
        targetDbVersion: advancedCache.targetDbVersion,
        scanFromDbVersion: advancedCache.scanFromDbVersion,
        reason: "compacted_state_too_large",
        maxRows: MOBILE_REPLICA_RESEED_MAX_ROWS,
        maxBytes: MOBILE_REPLICA_RESEED_MAX_BYTES,
      });
    } else if (advancedCache.status === "ready") {
      args.logger.info("sync_host.mobile_replica_reseed_ready", {
        targetDbVersion: advancedCache.targetDbVersion,
        rows: advancedCache.changes.length,
        approximateBytes: advancedCache.approximateBytes,
        buildSteps: advancedCache.buildSteps,
      });
    }
    return advancedCache;
  }

  function sendMobileReplicaReseed(
    peer: PeerState,
    cache: MobileReplicaReseedCache,
  ):
    | { status: "sent"; pending: PendingChangesetBatch }
    | { status: "retry" }
    | { status: "too_large" } {
    const deviceId = peer.metadata?.deviceId ?? peer.pairedDeviceId ?? "peer";
    const payload = buildMobileReplicaReseedPayload({
      cache,
      deviceId,
      fromDbVersion: peer.lastKnownServerDbVersion,
    });
    if (!payload) {
      return { status: "too_large" };
    }
    const pending = sendChangesetBatchPayload(peer, payload);
    if (pending) {
      args.logger.info("sync_host.mobile_replica_reseed_sent", {
        peerDeviceId: deviceId,
        fromDbVersion: payload.fromDbVersion,
        toDbVersion: payload.toDbVersion,
        rows: payload.changes.length,
      });
      return { status: "sent", pending };
    }
    return { status: "retry" };
  }

  function resendPendingChangesetBatch(peer: PeerState): boolean {
    const batch = peer.pendingChangesetBatch;
    if (!batch) return false;
    const sent = send(peer, "changeset_batch", {
      batchId: batch.batchId,
      reason: batch.reason,
      fromDbVersion: batch.fromDbVersion,
      toDbVersion: batch.toDbVersion,
      changes: batch.changes,
    });
    if (!sent) return false;
    batch.sentAtMs = Date.now();
    batch.attemptCount += 1;
    batch.retryNotBeforeMs = 0;
    return true;
  }

  function changesetRecoveryBackoffMs(level: number): number {
    const boundedLevel = Math.max(1, Math.min(MAX_CHANGESET_RECOVERY_LEVEL, Math.floor(level)));
    return Math.min(
      CHANGESET_RECOVERY_BACKOFF_MAX_MS,
      CHANGESET_RECOVERY_BACKOFF_BASE_MS * (2 ** (boundedLevel - 1)),
    );
  }

  function changesetBatchLimits(peer: PeerState): { maxRows: number; maxBytes: number } {
    const divisor = 2 ** Math.max(0, peer.changesetRecoveryLevel);
    return {
      maxRows: Math.max(MIN_RECOVERY_CHANGESET_BATCH_ROWS, Math.floor(maxChangesetBatchRows / divisor)),
      maxBytes: Math.max(MIN_RECOVERY_CHANGESET_BATCH_BYTES, Math.floor(maxChangesetBatchBytes / divisor)),
    };
  }

  function finishChangesetPriorityDeferral(
    peer: PeerState,
    reason: "pressure_relieved" | "no_changes" | "batch_admitted",
    nowMs: number,
  ): void {
    if (peer.changesetPriorityDeferredSinceMs == null) return;
    args.logger.debug("sync_host.changeset_priority_deferral_ended", {
      peerDeviceId: peer.metadata?.deviceId ?? null,
      reason,
      deferredMs: Math.max(0, nowMs - peer.changesetPriorityDeferredSinceMs),
    });
    peer.changesetPriorityDeferredSinceMs = null;
  }

  function abandonPendingChangesetBatch(
    peer: PeerState,
    reason: "ack_timeout" | "ack_failed",
    nowMs: number,
    error: string | null = null,
  ): void {
    const pending = peer.pendingChangesetBatch;
    if (!pending) return;
    peer.pendingChangesetBatch = null;
    if (pending.reason === "catchup") {
      // A compact reseed is disabled while it is in flight so the normal
      // incremental pump cannot race it. If every delivery attempt fails,
      // keep the replica at its old cursor and let the bounded reseed retry
      // after the same recovery backoff as any other abandoned batch.
      peer.mobileReplicaReseedDisabled = false;
    }
    peer.changesetRecoveryLevel = Math.min(
      MAX_CHANGESET_RECOVERY_LEVEL,
      peer.changesetRecoveryLevel + 1,
    );
    const backoffMs = changesetRecoveryBackoffMs(peer.changesetRecoveryLevel);
    peer.changesetRecoveryNotBeforeMs = nowMs + backoffMs;
    const limits = changesetBatchLimits(peer);
    args.logger.warn("sync_host.changeset_recovery_started", {
      peerDeviceId: peer.metadata?.deviceId ?? null,
      abandonedBatchId: pending.batchId,
      fromDbVersion: pending.fromDbVersion,
      toDbVersion: pending.toDbVersion,
      attemptCount: pending.attemptCount,
      reason,
      error,
      recoveryLevel: peer.changesetRecoveryLevel,
      backoffMs,
      maxRows: limits.maxRows,
      maxBytes: limits.maxBytes,
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

  function sendProjectCatalog(
    peer: PeerState,
    projectCatalog: SyncProjectCatalogPayload,
    requestId?: string | null,
	  ): void {
	    for (const message of buildSyncProjectCatalogMessages({
	      projectCatalog,
	      requestId,
	      compressionThresholdBytes,
	      maxProjectCatalogEnvelopeBytes,
	    })) {
	      if (!sendRequired(peer, message.type, message.payload, message.requestId)) break;
	    }
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
    let result: SyncProjectSwitchResultPayload | null = null;
    try {
      result = await args.projectCatalogProvider.prepareProjectConnection(payload ?? {});
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
      // prepareProjectConnection only opens the target scope and reports the
      // current stable port; the actual host swap happens in completion. If
      // preparing succeeded but delivering the result failed (e.g. the phone
      // disconnected first), still run completion so the registry converges
      // on the requested project — the phone's reconnect lands on the same
      // port either way. Completion is idempotent.
      if (result) {
        try {
          await args.projectCatalogProvider.completeProjectConnection?.(payload ?? {}, result);
        } catch (completionError) {
          args.logger.warn("sync_host.project_switch_completion_failed", {
            message: completionError instanceof Error ? completionError.message : String(completionError),
          });
        }
      }
      sendRequired(peer, "project_switch_result", {
        ok: false,
        message,
      }, requestId);
    }
  }

  async function handleProjectForgetRequest(
    peer: PeerState,
    requestId: string | null | undefined,
    payload: SyncProjectForgetRequestPayload | null,
  ): Promise<void> {
    if (!args.projectCatalogProvider?.forgetProject) {
      sendRequired(peer, "project_forget_result", {
        ok: false,
        message: "Removing projects is not available from this machine.",
      } satisfies SyncProjectForgetResultPayload, requestId);
      return;
    }
    try {
      const result = await args.projectCatalogProvider.forgetProject(payload ?? {});
      sendRequired(peer, "project_forget_result", result, requestId);
      if (result.ok) {
        broadcastProjectCatalogToConnectedPeers(await buildProjectCatalogPayload());
      }
    } catch (error) {
      sendRequired(peer, "project_forget_result", {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      } satisfies SyncProjectForgetResultPayload, requestId);
    }
  }

  function broadcastProjectCatalogToConnectedPeers(
    projectCatalog: SyncProjectCatalogPayload,
  ): void {
    if (bonjourPort != null) {
      refreshLanDiscoveryProjects(bonjourPort, projectCatalog);
    }
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      sendProjectCatalog(peer, projectCatalog);
    }
    // A catalog change (open/create/clone/forget/switch) reshapes the roster's
    // project set; recompute + push it too.
    markRosterDirty();
  }

  // --- All-projects roster (mobile hub) --------------------------------------

  function rosterSubscriberPeers(): PeerState[] {
    const subscribers: PeerState[] = [];
    for (const peer of peers) {
      if (peer.rosterSubscribed && peer.authenticated && peer.ws.readyState === WebSocket.OPEN) {
        subscribers.push(peer);
      }
    }
    return subscribers;
  }

  function ensureRosterSafetyPoll(): void {
    if (rosterSafetyPollTimer || disposed) return;
    // While ≥1 peer is subscribed, a slow poll catches out-of-band on-disk
    // changes in un-booted projects (e.g. a direct `ade` CLI run elsewhere)
    // that emit no in-process event.
    rosterSafetyPollTimer = setInterval(() => {
      if (rosterSubscriberPeers().length === 0) {
        stopRosterSafetyPoll();
        return;
      }
      markRosterDirty();
    }, ROSTER_SAFETY_POLL_MS);
    rosterSafetyPollTimer.unref?.();
  }

  function stopRosterSafetyPoll(): void {
    if (!rosterSafetyPollTimer) return;
    clearInterval(rosterSafetyPollTimer);
    rosterSafetyPollTimer = null;
  }

  function clearRosterFlushTimers(): void {
    if (rosterFlushTimer) {
      clearTimeout(rosterFlushTimer);
      rosterFlushTimer = null;
    }
    if (rosterMaxWaitTimer) {
      clearTimeout(rosterMaxWaitTimer);
      rosterMaxWaitTimer = null;
    }
  }

  // Coalesced recompute+push: trailing-edge debounce with a hard max-wait cap
  // so a steady stream of events still flushes at least once per cap.
  function markRosterDirty(): void {
    if (disposed || !args.rosterProvider) return;
    if (rosterSubscriberPeers().length === 0) return;
    if (rosterFlushTimer) clearTimeout(rosterFlushTimer);
    rosterFlushTimer = setTimeout(() => {
      void flushRoster();
    }, ROSTER_DEBOUNCE_MS);
    rosterFlushTimer.unref?.();
    if (!rosterMaxWaitTimer) {
      rosterMaxWaitTimer = setTimeout(() => {
        void flushRoster();
      }, ROSTER_MAX_WAIT_MS);
      rosterMaxWaitTimer.unref?.();
    }
  }

  async function buildRosterProjects(): Promise<SyncRosterProject[] | null> {
    if (!args.rosterProvider) return null;
    try {
      return await args.rosterProvider.buildSnapshot();
    } catch (error) {
      args.logger.warn("sync_host.roster_build_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Send a full snapshot and (re)seed the peer's per-project baseline so the
  // next flush can diff against it. A snapshot resets the peer's seq epoch (the
  // client adopts snapshot.seq as its new watermark), so it is always safe.
  function sendRosterSnapshotToPeer(
    peer: PeerState,
    projects: SyncRosterProject[],
    requestId?: string | null,
  ): void {
    const seq = ++peer.rosterSeq;
    const sent = send(peer.ws, "roster_snapshot", { seq, projects } satisfies SyncRosterSnapshotPayload, requestId);
    if (!sent) {
      // Backpressured/closed: drop the baseline so the next flush re-snapshots.
      peer.rosterBaseline.clear();
      return;
    }
    peer.rosterBaseline = new Map(projects.map((project) => [project.projectId, JSON.stringify(project)]));
  }

  async function flushRoster(): Promise<void> {
    clearRosterFlushTimers();
    if (disposed || rosterFlushInFlight) return;
    const subscribers = rosterSubscriberPeers();
    if (subscribers.length === 0) {
      stopRosterSafetyPoll();
      return;
    }
    rosterFlushInFlight = true;
    try {
      const projects = await buildRosterProjects();
      if (projects == null) return;
      const subscribersNow = rosterSubscriberPeers();
      if (subscribersNow.length === 0) return;
      const serialized = new Map(projects.map((project) => [project.projectId, JSON.stringify(project)]));
      for (const peer of subscribersNow) {
        if (peer.rosterBaseline.size === 0) {
          // No baseline (fresh subscribe / prior drop) → full snapshot.
          sendRosterSnapshotToPeer(peer, projects);
          continue;
        }
        const changed: SyncRosterProject[] = [];
        for (const project of projects) {
          if (peer.rosterBaseline.get(project.projectId) !== serialized.get(project.projectId)) {
            changed.push(project);
          }
        }
        const removed: string[] = [];
        for (const projectId of peer.rosterBaseline.keys()) {
          if (!serialized.has(projectId)) removed.push(projectId);
        }
        if (changed.length === 0 && removed.length === 0) {
          // Nothing changed for this peer: skip the send WITHOUT advancing its
          // seq, so its next delta still arrives as lastSeq+1 (no false gap).
          continue;
        }
        const seq = ++peer.rosterSeq;
        const delta: SyncRosterDeltaPayload = {
          seq,
          ...(changed.length > 0 ? { changed } : {}),
          ...(removed.length > 0 ? { removed } : {}),
        };
        const sent = send(peer.ws, "roster_delta", delta);
        if (!sent) {
          // Backpressured: roll back the seq + force a fresh snapshot next flush.
          peer.rosterSeq -= 1;
          peer.rosterBaseline.clear();
          continue;
        }
        peer.rosterBaseline = new Map(serialized);
      }
    } finally {
      rosterFlushInFlight = false;
    }
  }

  async function handleRosterSubscribe(
    peer: PeerState,
    requestId: string | null | undefined,
    _payload: SyncRosterSubscribePayload | null,
  ): Promise<void> {
    if (!args.rosterProvider) {
      // No roster on this host — stay silent so the phone falls back to the
      // project catalog (the contract treats a non-answering host gracefully).
      return;
    }
    peer.rosterSubscribed = true;
    peer.rosterBaseline.clear();
    ensureRosterSafetyPoll();
    const projects = await buildRosterProjects();
    if (projects == null) return;
    sendRosterSnapshotToPeer(peer, projects, requestId ?? null);
  }

  function handleRosterUnsubscribe(peer: PeerState): void {
    peer.rosterSubscribed = false;
    peer.rosterBaseline.clear();
    if (rosterSubscriberPeers().length === 0) {
      stopRosterSafetyPoll();
      clearRosterFlushTimers();
    }
  }

  async function handleProjectBrowseRequest(
    peer: PeerState,
    requestId: string | null | undefined,
    payload: ProjectBrowseInput | null,
  ): Promise<void> {
    if (!args.projectCatalogProvider?.browseDirectories) {
      sendRequired(peer, "project_browse_result", {
        ok: false,
        message: "Project browsing is not available from this machine.",
      }, requestId);
      return;
    }
    try {
      const result = await args.projectCatalogProvider.browseDirectories(payload ?? {});
      sendRequired(peer, "project_browse_result", { ok: true, result }, requestId);
    } catch (error) {
      sendRequired(peer, "project_browse_result", {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }, requestId);
    }
  }

  async function handleProjectDefaultParentDirRequest(
    peer: PeerState,
    requestId: string | null | undefined,
  ): Promise<void> {
    if (!args.projectCatalogProvider?.getDefaultParentDir) {
      sendRequired(peer, "project_default_parent_dir", {
        ok: false,
        message: "Default project directory is not available from this machine.",
      }, requestId);
      return;
    }
    try {
      const parentDir = await args.projectCatalogProvider.getDefaultParentDir();
      sendRequired(peer, "project_default_parent_dir", { ok: true, parentDir }, requestId);
    } catch (error) {
      sendRequired(peer, "project_default_parent_dir", {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }, requestId);
    }
  }

  async function handleProjectActionRequest<TPayload>(
    peer: PeerState,
    requestId: string | null | undefined,
    resultType: "project_open_result" | "project_create_result" | "project_clone_result",
    unavailableMessage: string,
    payload: TPayload,
    action: ((payload: TPayload) => Promise<SyncMobileProjectSummary>) | undefined,
  ): Promise<void> {
    if (!action) {
      sendRequired(peer, resultType, {
        ok: false,
        message: unavailableMessage,
      }, requestId);
      return;
    }
    try {
      const project = await action(payload);
      sendRequired(peer, resultType, { ok: true, project }, requestId);
      if (args.projectCatalogProvider) {
        broadcastProjectCatalogToConnectedPeers(await buildProjectCatalogPayload());
      }
    } catch (error) {
      sendRequired(peer, resultType, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }, requestId);
    }
  }

  async function handleProjectListMyGitHubReposRequest(
    peer: PeerState,
    requestId: string | null | undefined,
    payload: ListMyGitHubReposInput | null,
  ): Promise<void> {
    if (!args.projectCatalogProvider?.listMyGitHubRepos) {
      sendRequired(peer, "project_list_my_github_repos_result", {
        ok: false,
        message: "GitHub repository listing is not available from this machine.",
      }, requestId);
      return;
    }
    try {
      const result = await args.projectCatalogProvider.listMyGitHubRepos(payload ?? {});
      sendRequired(peer, "project_list_my_github_repos_result", { ok: true, result }, requestId);
    } catch (error) {
      sendRequired(peer, "project_list_my_github_repos_result", {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }, requestId);
    }
  }

  function buildBrainStatus(): SyncBrainStatusPayload {
    const brainMetadata = readBrainMetadata();
    const cloudRelayWssUrl = args.getCloudRelayWssUrl?.() ?? null;
    if (disposed) {
      return {
        brain: brainMetadata,
        host: brainMetadata,
        runtime: brainMetadata,
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
        cloudRelayWssUrl,
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
      host: {
        ...brainMetadata,
        dbVersion,
      },
      runtime: {
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
      cloudRelayWssUrl,
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
    scanOffset: number | null,
  ): Promise<{
    events: AgentChatEventEnvelope[];
    nextOffset: number;
    nextScanOffset: number | null;
    droppedOversizedRecordBytes: number | null;
  }> {
    let fh: fs.promises.FileHandle | null = null;
    try {
      fh = await fs.promises.open(transcriptPath, "r");
      const stat = await fh.stat();
      const size = stat.size;
      const durableStart = Math.max(0, Math.floor(startOffset));
      // A truncation/rotation invalidates both cursors. Restart from the new
      // EOF (the same recovery behavior as the old unbounded reader).
      if (size < durableStart || (scanOffset != null && size < scanOffset)) {
        return {
          events: [],
          nextOffset: size,
          nextScanOffset: null,
          droppedOversizedRecordBytes: null,
        };
      }
      const normalizedScanOffset = scanOffset == null
        ? null
        : Math.max(durableStart, Math.floor(scanOffset));
      const readStart = normalizedScanOffset ?? durableStart;
      if (size <= readStart) {
        return {
          events: [],
          nextOffset: durableStart,
          nextScanOffset: normalizedScanOffset,
          droppedOversizedRecordBytes: null,
        };
      }

      const readLength = Math.min(
        size - readStart,
        SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES,
      );
      const out = Buffer.alloc(readLength);
      const { bytesRead } = await fh.read(out, 0, out.length, readStart);
      const readSlice = out.subarray(0, bytesRead);
      if (normalizedScanOffset != null) {
        const firstNewline = readSlice.indexOf(0x0a);
        if (firstNewline < 0) {
          return {
            events: [],
            nextOffset: durableStart,
            nextScanOffset: readStart + bytesRead,
            droppedOversizedRecordBytes: null,
          };
        }
        const firstRecordEnd = readStart + firstNewline + 1;
        const firstRecordBytes = firstRecordEnd - durableStart;
        const lastNewline = readSlice.lastIndexOf(0x0a);
        if (firstRecordBytes <= SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES) {
          // The long record is still deliverable. Re-read it once, now that a
          // complete boundary is known, together with any later complete rows
          // already present in this bounded scan chunk.
          const completeEnd = readStart + lastNewline + 1;
          const completeBytes = completeEnd - durableStart;
          const completeSlice = Buffer.alloc(completeBytes);
          let rereadBytes = 0;
          while (rereadBytes < completeBytes) {
            const reread = await fh.read(
              completeSlice,
              rereadBytes,
              completeBytes - rereadBytes,
              durableStart + rereadBytes,
            );
            if (reread.bytesRead <= 0) break;
            rereadBytes += reread.bytesRead;
          }
          if (rereadBytes < completeBytes) {
            return {
              events: [],
              nextOffset: durableStart,
              nextScanOffset: normalizedScanOffset,
              droppedOversizedRecordBytes: null,
            };
          }
          return {
            events: parseAgentChatTranscript(completeSlice.toString("utf8")),
            nextOffset: durableStart + completeSlice.length,
            nextScanOffset: null,
            droppedOversizedRecordBytes: null,
          };
        }

        // A single record beyond the explicit one-record ceiling is not safe
        // to materialize. Drop exactly that complete row, surface a structured
        // warning, and recover at its newline; later complete rows still flow.
        const firstCompleteOffset = firstNewline + 1;
        const completeSlice = readSlice.subarray(firstCompleteOffset, lastNewline + 1);
        return {
          events: completeSlice.length > 0
            ? parseAgentChatTranscript(completeSlice.toString("utf8"))
            : [],
          nextOffset: readStart + lastNewline + 1,
          nextScanOffset: null,
          droppedOversizedRecordBytes: firstRecordBytes,
        };
      }

      const lastNewline = readSlice.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        const hitReadBound = bytesRead === SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES;
        return {
          events: [],
          nextOffset: durableStart,
          // A short trailing record may still be mid-write, so retain and
          // retry it. Once one record fills the normal cap, scan for its
          // newline in bounded chunks; a record within the separate hard
          // ceiling is then re-read and delivered intact.
          nextScanOffset: hitReadBound ? readStart + bytesRead : null,
          droppedOversizedRecordBytes: null,
        };
      }

      const completeSlice = readSlice.subarray(0, lastNewline + 1);
      const raw = completeSlice.toString("utf8");
      return {
        events: parseAgentChatTranscript(raw),
        nextOffset: durableStart + completeSlice.length,
        nextScanOffset: null,
        droppedOversizedRecordBytes: null,
      };
    } catch {
      return {
        events: [],
        nextOffset: Math.max(0, startOffset),
        nextScanOffset: scanOffset,
        droppedOversizedRecordBytes: null,
      };
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  // Reads a byte-capped TAIL snapshot of a chat transcript straight off disk —
  // the cross-project analogue of agentChatService.getChatEventHistory, used
  // when the session lives in a foreign project this host has no runtime for.
  // Reuses the same tail-truncation semantics as a local snapshot (a leading
  // partial line at the cut point is dropped by the JSONL parser).
  async function readForeignChatSnapshot(
    transcriptPath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{
    events: AgentChatEventEnvelope[];
    transcriptSize: number;
    truncated: boolean;
    tailStartOffset: number;
  }> {
    try {
      const size = await readHistoryFileSize(transcriptPath);
      const start = Math.max(0, size - Math.max(1_024, maxBytes));
      if (size <= start) {
        return { events: [], transcriptSize: size, truncated: false, tailStartOffset: 0 };
      }
      const out = await readHistoryFileRange(
        transcriptPath,
        start,
        size - start,
        signal,
      );
      // Drop a leading partial line when starting mid-file so the parser never
      // sees a truncated JSON object as the first record. The first complete
      // line's logical offset becomes the paging seam; a page ending there can
      // recover the dropped straddling record without a gap.
      let sliceStart = 0;
      if (start > 0) {
        const firstNewline = out.indexOf(0x0a);
        sliceStart = firstNewline >= 0 ? firstNewline + 1 : out.length;
      }
      const raw = out.subarray(sliceStart).toString("utf8");
      const tailStartOffset = start + sliceStart;
      return {
        events: parseAgentChatTranscript(raw),
        transcriptSize: size,
        truncated: tailStartOffset > 0,
        tailStartOffset,
      };
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // The provider already authorized and sandboxed this path. A session
        // may be registered just before its transcript is created (or rotate
        // between stat/read), so keep the subscription live and let the pump
        // discover the file when it appears.
        return { events: [], transcriptSize: 0, truncated: false, tailStartOffset: 0 };
      }
      throw error;
    }
  }

  async function readTranscriptLogicalSize(transcriptPath: string | null): Promise<number> {
    if (!transcriptPath) return 0;
    const candidates = transcriptPath.endsWith(".gz")
      ? [transcriptPath]
      : [transcriptPath, `${transcriptPath}.gz`];
    for (const candidate of candidates) {
      try {
        return await readHistoryFileSize(candidate);
      } catch {
        // A session row normally points at the plain append target even after
        // storage compression. Try its transparent gzip sibling next.
      }
    }
    return 0;
  }

  function requestedProjectChatScope(
    payload: ChatScopeRequest | null,
  ): "project" | "foreign-project" {
    const requestedProjectId = toOptionalString(payload?.projectId);
    const requestedRootPath = toOptionalString(payload?.projectRootPath);
    if (!requestedProjectId && !requestedRootPath) return "project";
    const projectIdMatches = !requestedProjectId
      || projectIdMatchesHost(requestedProjectId, args.projectId, hostProjectIdAliases);
    const projectRootMatches = !requestedRootPath
      || path.resolve(requestedRootPath) === path.resolve(args.projectRoot);
    return projectIdMatches && projectRootMatches ? "project" : "foreign-project";
  }

  function requestedChatSubscriptionScope(
    payload: ChatScopeRequest | null,
  ): ChatSubscriptionScope {
    return payload?.chatScope === "personal" ? "personal" : requestedProjectChatScope(payload);
  }

  function chatSubscriptionMatchesRequest(
    binding: ChatSubscriptionBinding | undefined,
    payload: ChatScopeRequest | null,
    sessionId: string,
  ): boolean {
    if (!binding) return false;
    const requestedScope = requestedChatSubscriptionScope(payload);
    if (binding.scope !== requestedScope) return false;
    if (binding.scope !== "foreign-project") {
      // Every host id alias and the host root normalize to the same local
      // project binding; personal scope is machine-wide.
      return true;
    }
    // The provider is the project identity/security boundary. Compare its
    // canonical transcript target rather than raw selector fields so project
    // id and root aliases for the same registered project remain equivalent,
    // while colliding session ids from different projects stay isolated.
    const requestedForeignScope = resolveForeignChatScope(payload, sessionId);
    return requestedForeignScope.kind === "foreign"
      && path.resolve(requestedForeignScope.transcriptPath) === binding.transcriptPath;
  }

  function hasExplicitChatSubscriptionScope(
    payload: ChatScopeRequest | null,
  ): boolean {
    return (
      payload?.chatScope === "project"
      || payload?.chatScope === "personal"
      || toOptionalString(payload?.projectId) != null
      || toOptionalString(payload?.projectRootPath) != null
    );
  }

  // Resolve a foreign-project subscription's transcript path via the provider
  // (the security boundary — validates the project is registered and confines
  // the path to that project's `.ade` transcripts). `kind: "local"` means the
  // payload carried no foreign scope (or named this host's own project);
  // `kind: "rejected"` means the payload EXPLICITLY named a foreign project
  // the provider could not confirm — the caller must fail closed rather than
  // fall back to serving whichever local session shares the sessionId.
  function resolveForeignChatScope(
    payload: ChatScopeRequest | null,
    sessionId: string,
  ): { kind: "local" } | { kind: "foreign"; transcriptPath: string } | { kind: "rejected" } {
    const requestedProjectId = toOptionalString(payload?.projectId);
    const requestedRootPath = toOptionalString(payload?.projectRootPath);
    if (requestedProjectChatScope(payload) === "project") return { kind: "local" };
    const transcriptPath = args.foreignChatProvider?.resolveTranscriptPath({
      projectId: requestedProjectId,
      projectRootPath: requestedRootPath,
      sessionId,
    }) ?? null;
    return transcriptPath ? { kind: "foreign", transcriptPath } : { kind: "rejected" };
  }

  // Per-session replay buffers for resumable chat event streams. Map insertion
  // order doubles as the LRU order — recordChatEventSeq re-inserts on touch.
  const chatEventReplayBuffers = new Map<string, ChatEventReplayBuffer>();

  function recordChatEventSeq(event: AgentChatEventEnvelope): number {
    let buffer = chatEventReplayBuffers.get(event.sessionId);
    if (buffer) {
      chatEventReplayBuffers.delete(event.sessionId);
    } else {
      buffer = createChatEventReplayBuffer(
        chatEventSequenceHighWaterBySession.get(event.sessionId) ?? 0,
      );
      while (chatEventReplayBuffers.size >= CHAT_EVENT_REPLAY_MAX_SESSIONS) {
        const oldestSessionId = chatEventReplayBuffers.keys().next().value;
        if (oldestSessionId == null) break;
        chatEventReplayBuffers.delete(oldestSessionId);
      }
    }
    chatEventReplayBuffers.set(event.sessionId, buffer);
    const seq = recordChatEventInReplayBuffer(buffer, event);
    chatEventSequenceHighWaterBySession.set(event.sessionId, seq);
    return seq;
  }

  function chatEventAlreadySent(peer: PeerState, event: AgentChatEventEnvelope): boolean {
    const key = chatEventDeliveryKey(event);
    return peer.chatEventIdsSent.get(event.sessionId)?.has(key) === true;
  }

  function markChatEventSent(peer: PeerState, event: AgentChatEventEnvelope): void {
    const key = chatEventDeliveryKey(event);
    let sent = peer.chatEventIdsSent.get(event.sessionId);
    if (!sent) {
      sent = new Set();
      peer.chatEventIdsSent.set(event.sessionId, sent);
    }
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
  }

  /**
   * Compaction serializes the payload and binary-searches it, so doing it per
   * peer meant one live event paid that cost once for every subscriber. The
   * result depends only on the envelope, so it is memoized against the envelope
   * identity and computed once per event no matter how many peers receive it.
   */
  const compactedSyncEnvelopes = new WeakMap<AgentChatEventEnvelope, AgentChatEventEnvelope>();
  function compactChatEventEnvelopeOnce(event: AgentChatEventEnvelope): AgentChatEventEnvelope {
    const cached = compactedSyncEnvelopes.get(event);
    if (cached) return cached;
    const compacted = compactChatEventEnvelopeForSync(event);
    compactedSyncEnvelopes.set(event, compacted);
    return compacted;
  }

  function sendChatEvent(peer: PeerState, event: AgentChatEventEnvelope, seq: number): "sent" | "already-sent" | "failed" {
    if (chatEventAlreadySent(peer, event)) return "already-sent";
    const syncEvent = compactChatEventEnvelopeOnce(event);
    const sent = send(peer.ws, "chat_event", { ...syncEvent, seq } satisfies SyncChatEventPayload);
    if (sent) markChatEventSent(peer, event);
    return sent ? "sent" : "failed";
  }

  async function pumpChatEvents(peer: PeerState): Promise<void> {
    if (disposed || !peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) return;
    if (isPeerBackpressured(peer)) return;
    for (const sessionId of peer.subscribedChatSessionIds) {
      if (peer.hydratingChatSessionIds.has(sessionId)) continue;
      // A foreign quick-look session has no local row; tail its resolved
      // transcript path directly. Local sessions resolve via sessionService.
      const resolvedTranscriptPath = peer.resolvedChatTranscriptPaths.get(sessionId);
      const configuredTranscriptPath = resolvedTranscriptPath ?? args.sessionService.get(sessionId)?.transcriptPath;
      const transcriptPath = configuredTranscriptPath
        ? resolveReadableHistoryPath(configuredTranscriptPath) ?? configuredTranscriptPath
        : null;
      if (!transcriptPath) continue;
      if (resolvedTranscriptPath && transcriptPath !== resolvedTranscriptPath) {
        peer.resolvedChatTranscriptPaths.set(sessionId, transcriptPath);
      }

      const startOffset = peer.chatTranscriptOffsets.get(sessionId) ?? 0;
      const scanOffset = peer.chatTranscriptScanOffsets.get(sessionId) ?? null;
      const {
        events,
        nextOffset,
        nextScanOffset,
        droppedOversizedRecordBytes,
      } = await readChatTranscriptEventsSince(transcriptPath, startOffset, scanOffset);
      if (droppedOversizedRecordBytes != null) {
        args.logger.warn("sync_host.chat_transcript_record_too_large", {
          peerDeviceId: peer.metadata?.deviceId ?? null,
          sessionId,
          recordBytes: droppedOversizedRecordBytes,
          maxRecordBytes: SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES,
        });
      }
      let allEventsDelivered = true;
      for (const event of events) {
        const seq = recordChatEventSeq(event);
        if (sendChatEvent(peer, event, seq) === "failed") {
          allEventsDelivered = false;
          break;
        }
      }
      if (!allEventsDelivered) continue;
      if (nextOffset !== startOffset) {
        peer.chatTranscriptOffsets.set(sessionId, nextOffset);
      }
      if (nextScanOffset == null) {
        peer.chatTranscriptScanOffsets.delete(sessionId);
      } else {
        peer.chatTranscriptScanOffsets.set(sessionId, nextScanOffset);
      }
    }
  }

  function broadcastChatEvent(event: AgentChatEventEnvelope): void {
    // Record unconditionally (even with no subscribed peers) so the replay
    // buffer can cover events that happened while a phone was disconnected.
    const seq = recordChatEventSeq(event);
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (isPeerBackpressured(peer)) continue;
      if (!peer.subscribedChatSessionIds.has(event.sessionId)) continue;
      if (peer.hydratingChatSessionIds.has(event.sessionId)) continue;
      // Personal and foreign-project subscriptions get events from their
      // resolved transcript paths — never the active project's live broadcast,
      // even when a local session shares the session id.
      if (peer.chatSubscriptionBindings.get(event.sessionId)?.scope !== "project") continue;
      sendChatEvent(peer, event, seq);
    }
    // A chat lifecycle event for the host project updates its roster status
    // live (other booted scopes are covered by the safety poll + live overlay).
    markRosterDirty();
  }

  async function pumpChanges(peer: PeerState, pollGeneration: number): Promise<void> {
    if (disposed) return;
    const currentDbVersion = args.db.sync.getDbVersion();
    const nowMs = Date.now();
      if (!peer.authenticated || !peer.metadata || peer.ws.readyState !== WebSocket.OPEN) return;
      // A paired desktop runtime connection shares this authenticated socket
      // only for rpc/fwd envelopes. The authoritative pairing record remains
      // the gate so a phone/browser cannot suppress its normal CRDT stream by
      // spoofing the hello capability.
      if (isRuntimeOnlyPairedHost(peer)) return;
      // The 4 MiB gate is a hard socket-safety boundary. Fair scheduling may
      // override only the lower chat-priority watermark below.
      if (isPeerBackpressured(peer)) return;
      if (peer.pendingChangesetBatch) {
        const pending = peer.pendingChangesetBatch;
        const rejectedRetryDue = pending.retryNotBeforeMs > 0 && nowMs >= pending.retryNotBeforeMs;
        const ackTimedOut = pending.retryNotBeforeMs === 0
          && nowMs - pending.sentAtMs >= CHANGESET_ACK_TIMEOUT_MS;
        if (rejectedRetryDue || ackTimedOut) {
          if (pending.attemptCount >= MAX_CHANGESET_SEND_ATTEMPTS) {
            abandonPendingChangesetBatch(peer, ackTimedOut ? "ack_timeout" : "ack_failed", nowMs);
            return;
          }
          const resent = resendPendingChangesetBatch(peer);
          if (resent) {
            args.logger.debug("sync_host.changeset_ack_retry", {
              peerDeviceId: peer.metadata.deviceId,
              batchId: pending.batchId,
              fromDbVersion: pending.fromDbVersion,
              toDbVersion: pending.toDbVersion,
              attemptCount: pending.attemptCount,
              trigger: ackTimedOut ? "timeout" : "rejected",
            });
          }
        }
        return;
      }
      if (currentDbVersion <= peer.lastKnownServerDbVersion) {
        finishChangesetPriorityDeferral(peer, "no_changes", nowMs);
        return;
      }
      if (nowMs < peer.changesetRecoveryNotBeforeMs) return;
      const hasQueuedForegroundWork = peer.queuedMessageCount > 0;
      const chatBackpressured = shouldDeferBackgroundChangesForChat(peer);
      if (hasQueuedForegroundWork || chatBackpressured) {
        if (peer.changesetPriorityDeferredSinceMs == null) {
          peer.changesetPriorityDeferredSinceMs = nowMs;
          args.logger.debug("sync_host.changeset_priority_deferral_started", {
            peerDeviceId: peer.metadata.deviceId,
            bufferedAmount: peer.ws.bufferedAmount,
            thresholdBytes: SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES,
            hasQueuedForegroundWork,
            chatBackpressured,
            maxDeferMs: SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS,
          });
        }
        if (nowMs - peer.changesetPriorityDeferredSinceMs < SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS) {
          return;
        }
      } else {
        finishChangesetPriorityDeferral(peer, "pressure_relieved", nowMs);
      }
      const replicaLag = currentDbVersion - peer.lastKnownServerDbVersion;
      if (
        !peer.mobileReplicaReseedDisabled
        && peerSupportsMobileReplicaReseed(peer)
        && replicaLag > SYNC_HOST_MOBILE_REPLICA_RESEED_GAP
      ) {
        const reseed = buildMobileReplicaReseedStep(
          currentDbVersion,
          peer.lastKnownServerDbVersion,
          pollGeneration,
        );
        if (reseed.status === "building") return;
        if (reseed.status === "ready") {
          if (mobileReplicaReseedLaunchPollGeneration === pollGeneration) return;
          mobileReplicaReseedLaunchPollGeneration = pollGeneration;
          const result = sendMobileReplicaReseed(peer, reseed);
          if (result.status === "sent") {
            peer.mobileReplicaReseedDisabled = true;
            peer.pendingChangesetBatch = result.pending;
            finishChangesetPriorityDeferral(peer, "batch_admitted", nowMs);
            lastBroadcastAt = nowIso();
            return;
          }
          if (result.status === "retry") return;
          reseed.status = "too_large";
          reseed.changes = [];
          reseed.approximateBytes = 0;
        }
        peer.mobileReplicaReseedDisabled = true;
        args.logger.info("sync_host.mobile_replica_reseed_fallback", {
          peerDeviceId: peer.metadata.deviceId,
          currentDbVersion,
          lastKnownServerDbVersion: peer.lastKnownServerDbVersion,
          replicaLag,
          reason: "compacted_state_too_large",
        });
      }
      const recoveryLimits = changesetBatchLimits(peer);
      const chatLimits = syncHostChangesetBatchOptionsForChat({
        // Once a foreground queue ages past the deadline, admit only the same
        // small batch used for an active chat. This bounds the synchronous
        // export pause before the peer returns to its serialized messages.
        subscribedChatSessionCount: peer.subscribedChatSessionIds.size + (hasQueuedForegroundWork ? 1 : 0),
        maxRows: recoveryLimits.maxRows,
        maxBytes: recoveryLimits.maxBytes,
      });
      const batchLimits = {
        maxRows: chatLimits?.maxRows ?? recoveryLimits.maxRows,
        maxBytes: chatLimits?.maxBytes ?? recoveryLimits.maxBytes,
      };
      // Bounded export: scan a db_version WINDOW, not the whole backlog. The
      // crsql_changes vtab pushes version-range constraints down to indexed
      // clock tables, while an open-ended ORDER BY scan materializes the full
      // backlog first (a bare LIMIT does not help) — long enough that any
      // concurrent write aborts it with SQLITE_ABORT, permanently starving
      // the peer. Empty windows advance the cursor so sparse version deserts
      // (e.g. compacted operations churn) are crossed in a few polls.
      const scanThroughDbVersion = Math.min(
        peer.lastKnownServerDbVersion + SYNC_EXPORT_VERSION_WINDOW,
        currentDbVersion,
      );
      const exported = args.db.sync.exportChangesSince(
        peer.lastKnownServerDbVersion,
        { maxRows: batchLimits.maxRows * 4, throughDbVersion: scanThroughDbVersion },
      );
      const exportedThroughDbVersion = exported.length > 0
        ? Number(exported[exported.length - 1].db_version)
        : scanThroughDbVersion;
      const mobilePeer = isMobileChangesetPeer(peer);
      const changes = exported
        .filter((change: CrsqlChangeRow) => change.site_id !== peer.metadata?.siteId)
        .filter((change: CrsqlChangeRow) => !isHostAuthoritativeTable(change))
        .filter((change: CrsqlChangeRow) => !mobilePeer || !MOBILE_CHANGESET_EXCLUDED_TABLES.has(change.table));
      if (changes.length === 0) {
        const previousDbVersion = peer.lastKnownServerDbVersion;
        // Only advance through what was actually scanned — with a bounded
        // export, versions past the truncation point have not been seen.
        peer.lastKnownServerDbVersion = exportedThroughDbVersion;
        args.logger.debug("sync_host.changeset_advanced_without_send", {
          peerDeviceId: peer.metadata?.deviceId ?? null,
          fromDbVersion: previousDbVersion,
          toDbVersion: exportedThroughDbVersion,
          reason: "peer_owned_changes_only",
        });
        finishChangesetPriorityDeferral(peer, "no_changes", nowMs);
        return;
      }
      const pending = sendNextChangesetBatch(
        peer,
        "broadcast",
        peer.lastKnownServerDbVersion,
        exportedThroughDbVersion,
        changes,
        batchLimits,
      );
      if (pending) {
        peer.changesetRecoveryNotBeforeMs = 0;
        if (peerSupportsChangesetAck(peer) && !isCompactInvalidationBrowserPeer(peer.metadata)) {
          peer.pendingChangesetBatch = pending;
        } else {
          peer.lastKnownServerDbVersion = Math.max(peer.lastKnownServerDbVersion, pending.toDbVersion);
        }
        finishChangesetPriorityDeferral(peer, "batch_admitted", nowMs);
        lastBroadcastAt = nowIso();
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
      const nowMs = Date.now();
      const message = payload.error?.message ?? "Changeset apply failed.";
      if (pending.attemptCount >= MAX_CHANGESET_SEND_ATTEMPTS) {
        abandonPendingChangesetBatch(peer, "ack_failed", nowMs, message);
        return;
      }
      const retryInMs = changesetRecoveryBackoffMs(pending.attemptCount);
      pending.retryNotBeforeMs = nowMs + retryInMs;
      args.logger.warn("sync_host.changeset_ack_failed", {
        peerDeviceId: peer.metadata?.deviceId ?? null,
        batchId: pending.batchId,
        fromDbVersion: pending.fromDbVersion,
        toDbVersion: pending.toDbVersion,
        attemptCount: pending.attemptCount,
        retryInMs,
        error: message,
      });
      return;
    }
    if (payload.toDbVersion < pending.toDbVersion) return;
    const recoveryLevel = peer.changesetRecoveryLevel;
    peer.lastKnownServerDbVersion = Math.max(peer.lastKnownServerDbVersion, pending.toDbVersion);
    peer.pendingChangesetBatch = null;
    peer.changesetRecoveryLevel = 0;
    peer.changesetRecoveryNotBeforeMs = 0;
    peer.lastAppliedAt = nowIso();
    lastChangesetAckLatencyMs = Math.max(0, Date.now() - pending.sentAtMs);
    args.logger.debug("sync_host.changeset_ack_applied", {
      peerDeviceId: peer.metadata?.deviceId ?? null,
      batchId: pending.batchId,
      fromDbVersion: pending.fromDbVersion,
      toDbVersion: pending.toDbVersion,
      reason: pending.reason,
      latencyMs: lastChangesetAckLatencyMs,
    });
    if (recoveryLevel > 0) {
      args.logger.debug("sync_host.changeset_recovery_reset", {
        peerDeviceId: peer.metadata?.deviceId ?? null,
        previousRecoveryLevel: recoveryLevel,
      });
    }
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
    // Stored URIs use the `ade-artifact://project/<relative>` form the renderer
    // and the remote-command service both understand. Without stripping the
    // scheme here the phone resolves a path that starts with "project/" and
    // every artifact read fails.
    if (/^ade-artifact:\/\/project(?:\/|$)/i.test(candidate)) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname.replace(/^\/+/, ""));
      } catch {
        throw new Error("Artifact URI is invalid.");
      }
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
    return resolvedArtifactPath;
  }

  async function readArtifactBlob(
    request: Extract<SyncFileRequest, { action: "readArtifact" }>["args"],
  ): Promise<SyncFileBlob> {
    const artifactPath = resolveArtifactPath(request);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(artifactPath);
    } catch {
      throw new Error("Artifact file does not exist.");
    }
    if (!stat.isFile()) {
      throw new Error("Artifact file does not exist.");
    }
    if (stat.size > MAX_SYNC_ARTIFACT_BYTES) {
      throw new Error(
        `Artifact is too large to sync (${stat.size} bytes; max ${MAX_SYNC_ARTIFACT_BYTES} bytes).`,
      );
    }
    const buffer = await fs.promises.readFile(artifactPath);
    return createBlobFromBuffer(normalizeRelative(path.relative(args.projectRoot, artifactPath)), buffer);
  }

  function isMobilePeer(peer: PeerState): boolean {
    if (isRecordBackedSyncAuthKind(peer.authKind)) {
      return isMobilePairingRecord(peer.pairingRecord);
    }
    return peer.metadata?.platform === "iOS" || peer.metadata?.deviceType === "phone";
  }

  function workspaceForId(workspaceId: string | null): FilesWorkspace | null {
    if (!workspaceId) return null;
    return args.fileService.listWorkspaces({ includeArchived: true })
      .find((entry) => entry.id === workspaceId) ?? null;
  }

  function assertMobileExternalWorkspaceBlocked(peer: PeerState, payload: SyncFileRequest): void {
    // Only mobile peers can be blocked, and resolving the workspace costs a full
    // roster sweep (fs.existsSync + statSync per external workspace + two DB
    // reads). Settle the peer kind first so browser/desktop file requests never
    // pay for a check that cannot fire.
    if (!isMobilePeer(peer)) return;
    assertFileRequestWorkspaceVisibleToPeer({
      isMobile: true,
      workspace: workspaceForId(syncFileRequestWorkspaceId(payload)),
    });
  }

  async function handleFileRequest(peer: PeerState, requestId: string | null, payload: SyncFileRequest): Promise<void> {
    const respond = (response: SyncFileResponsePayload) => {
      sendRequired(peer, "file_response", response, requestId);
    };

    try {
      assertMobileExternalWorkspaceBlocked(peer, payload);
      let result:
        | FilesWorkspace[]
        | FileTreeNode[]
        | FileContent
        | FilesListTreeChildrenResult
        | FilesGitStatusEvent
        | FilesReadFileRangeResult
        | FilesGitBlameResult
        | FilesQuickOpenItem[]
        | FilesSearchTextMatch[]
        | SyncFileBlob
        | { ok: true } = { ok: true };

      switch (payload.action) {
        case "listWorkspaces":
          result = visibleFileWorkspacesForPeer(args.fileService.listWorkspaces(payload.args ?? {}), {
            isMobile: isMobilePeer(peer),
          });
          break;
        case "listTree":
          result = await args.fileService.listTree(payload.args);
          break;
        case "listTreeChildren":
          result = await args.fileService.listTreeChildren(payload.args);
          break;
        case "refreshGitDecorations":
          result = await args.fileService.refreshGitDecorations(payload.args);
          break;
        case "readFile":
          result = fileContentToBlob(payload.args.path, await args.fileService.readFile(payload.args));
          break;
        case "readFileRange":
          result = await args.fileService.readFileRange(payload.args);
          break;
        case "gitBlame":
          result = await args.fileService.blame(payload.args);
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
        case "watchChanges":
        case "stopWatching":
          throw new Error(`Unsupported file action: ${payload.action}`);
        case "quickOpen":
          result = await args.fileService.quickOpen(payload.args);
          break;
        case "searchText":
          result = await args.fileService.searchText(payload.args);
          break;
        case "readArtifact": {
          result = await readArtifactBlob(payload.args);
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

  async function handleCommand(
    peer: PeerState,
    requestId: string | null,
    payload: SyncCommandPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const commandId = toOptionalString(payload.commandId) ?? requestId ?? `cmd-${Date.now()}`;
    const requestedProjectId = toOptionalString(payload.projectId);
    const hostProjectId = toOptionalString(args.projectId);
    const matchesHostProject = projectIdMatchesHost(requestedProjectId, hostProjectId, hostProjectIdAliases);
    const commandScopeKey = matchesHostProject
      ? hostProjectId ?? args.projectRoot
      : requestedProjectId ?? hostProjectId ?? args.projectRoot;
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
      && !matchesHostProject;
    if (requestedProjectId && hostProjectId && !matchesHostProject && !shouldRouteToProject) {
      reject("This ADE machine is hosting a different project. Select the project again and retry.", "project_not_open");
      return;
    }
    if (payload.action === "lanes.presence.announce" || payload.action === "lanes.presence.release") {
      if (requestedProjectId && hostProjectId && !matchesHostProject) {
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
      const surface = usageClientSurfaceFromPeer(peer.metadata?.deviceType, peer.metadata?.platform);
      const rawCommandArgs = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
        ? payload.args as Record<string, unknown>
        : {};
      const canonicalProjectId = matchesHostProject
        ? hostProjectId
        : requestedProjectId;
      const preparedAnalytics = prepareProductAnalyticsRemoteCommand({
        action: payload.action,
        args: rawCommandArgs,
        surface,
        projectId: canonicalProjectId,
        clientEnabled: peer.productAnalyticsEnabled,
      });
      peer.productAnalyticsEnabled = preparedAnalytics.clientEnabled;
      const surfaceBoundPayload = preparedAnalytics.args === rawCommandArgs
        ? payload
        : { ...payload, args: preparedAnalytics.args };
      const routedPayload = matchesHostProject && hostProjectId
        ? { ...surfaceBoundPayload, projectId: hostProjectId }
        : surfaceBoundPayload;
      const executionStartedAtMs = Date.now();
      const stopTrackingCommand = trackBrainLoopWatchdogCommand(payload.action);
      let created: unknown;
      try {
        created = preparedAnalytics.captureDisabled
          ? { accepted: false, reason: "disabled" }
          : await executor.execute(routedPayload, { signal });
      } finally {
        stopTrackingCommand();
        const durationMs = Math.max(0, Date.now() - executionStartedAtMs);
        if (durationMs >= slowCommandThresholdMs) {
          args.logger.warn("sync_host.command_slow", {
            action: payload.action,
            durationMs,
            peerKind: surface,
          });
        }
      }
      if (
        matchesHostProject
        && !payload.action.startsWith("analytics.")
      ) {
        const commandArgs = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
          ? payload.args as Record<string, unknown>
          : {};
        recordUsageInteraction(args.db, {
          projectId: hostProjectId,
          client: surface,
          action: payload.action,
          feature: payload.action.split(".", 1)[0] ?? "other",
          sessionId: toOptionalString(commandArgs.sessionId),
          analyticsEligible:
            peer.productAnalyticsEnabled
            && args.productAnalyticsService?.getStatus().effective === true,
        });
      }
      // Create-in-place (possibly into another project) adds a lane/chat row the
      // hub must see; nudge the roster (coalesced, no-op without subscribers).
      if (ROSTER_DIRTYING_COMMAND_ACTIONS.has(payload.action)) markRosterDirty();
      sendResult(acceptedRecord, {
        commandId,
        ok: true,
        result: decorateCommandResult(payload.action, created),
      });
    } catch (error) {
      // Coded errors (e.g. laneService attach's lane_already_linked) embed the
      // code in the message so it survives IPC transports. The service runs
      // in-process here, so gate on the Error's real `code` property — parsing
      // the message alone would also mangle legit prefixes like git's "fatal:".
      const rawCode = error instanceof Error ? (error as { code?: unknown }).code : null;
      const directCode = typeof rawCode === "string" && rawCode.length > 0 ? rawCode : null;
      sendResult(acceptedRecord, {
        commandId,
        ok: false,
        error: directCode
          ? { code: directCode, message: parseCodedErrorMessage(error).message }
          : {
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
      return;
    }

    if (type === "terminal_history") {
      const historyPayload = (payload ?? {}) as { sessionId?: string; beforeOffset?: number };
      const sessionId = toOptionalString(historyPayload.sessionId) ?? "";
      const beforeOffset = typeof historyPayload.beforeOffset === "number" && Number.isFinite(historyPayload.beforeOffset)
        ? Math.max(0, Math.floor(historyPayload.beforeOffset))
        : 0;
      sendRequired(peer, "terminal_history", {
        sessionId,
        data: "",
        startOffset: beforeOffset,
        endOffset: beforeOffset,
        atStart: true,
      } satisfies SyncTerminalHistoryResponsePayload, requestId);
      return;
    }

    if (type === "chat_history") {
      const historyPayload = (payload ?? {}) as { sessionId?: string; beforeOffset?: number };
      const sessionId = toOptionalString(historyPayload.sessionId) ?? "";
      const beforeOffset = typeof historyPayload.beforeOffset === "number" && Number.isFinite(historyPayload.beforeOffset)
        ? Math.max(0, Math.floor(historyPayload.beforeOffset))
        : 0;
      sendRequired(peer, "chat_history", {
        sessionId,
        events: [],
        startOffset: beforeOffset,
        hasMore: beforeOffset > 0,
        sessionFound: false,
        unavailable: true,
      } satisfies AgentChatEventHistoryPage, requestId);
    }
  }

  function markPeerMessageSeen(peer: PeerState): string | null {
    const heartbeatAwaitedAt = peer.awaitingHeartbeatAt;
    peer.lastSeenAt = nowIso();
    peer.awaitingHeartbeatAt = null;
    peer.missedHeartbeatCount = 0;
    return heartbeatAwaitedAt;
  }

  function handleHeartbeatEnvelope(
    peer: PeerState,
    envelope: ParsedSyncEnvelope,
    heartbeatAwaitedAt: string | null,
  ): void {
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
  }

  function handleImmediateControlEnvelope(peer: PeerState, envelope: ParsedSyncEnvelope): boolean {
    if (!peer.authenticated) return false;
    if (envelope.type === "relay_reauthorize") {
      markPeerMessageSeen(peer);
      if (!peer.relayAuthorization) {
        sendRequired(peer, "relay_reauthorize_result", {
          ok: false,
          error: {
            code: "invalid_request",
            message: "This connection does not have a refreshable Relay authorization lease.",
            retryable: false,
          },
        }, envelope.requestId);
        return true;
      }
      void peer.relayAuthorization.handle(envelope.payload, envelope.requestId).catch((error) => {
        args.logger.warn("sync_host.relay_reauthorization_failed", {
          error: error instanceof Error ? error.message : String(error),
          peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
          requestId: envelope.requestId,
        });
      });
      return true;
    }
    if (envelope.type === "terminal_input") {
      markPeerMessageSeen(peer);
      const priorInput = peer.terminalInputQueue.catch(() => {});
      // A subscribe/unsubscribe already received on this socket is an ownership
      // barrier. Otherwise terminal input stays independent of the general
      // peer queue, so a slow remote command cannot delay an attached shell.
      const ownershipBarrier = peer.pendingTerminalOwnershipChanges > 0
        ? peer.messageQueue.catch(() => {})
        : Promise.resolve();
      const work = Promise.all([priorInput, ownershipBarrier]).then(async () => {
        if (disposed || !peers.has(peer) || !peer.authenticated) return;
        await handleTerminalInputSerialized(peer, envelope);
      });
      peer.terminalInputQueue = work.catch((error) => {
        args.logger.warn("sync_host.terminal_input_failed", {
          error: error instanceof Error ? error.message : String(error),
          peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
          requestId: envelope.requestId,
        });
      });
      return true;
    }
    if (envelope.type !== "heartbeat") return false;
    const heartbeatAwaitedAt = markPeerMessageSeen(peer);
    handleHeartbeatEnvelope(peer, envelope, heartbeatAwaitedAt);
    return true;
  }

  async function handleTerminalInputSerialized(peer: PeerState, envelope: ParsedSyncEnvelope): Promise<void> {
    const payload = envelope.payload as Partial<SyncTerminalInputPayload> | null;
    const deviceId = toOptionalString(peer.pairedDeviceId) ?? toOptionalString(peer.metadata?.deviceId);
    const sessionId = toOptionalString(payload?.sessionId);
    const inputId = normalizeTerminalInputId(payload?.inputId);
    if (!deviceId || !sessionId || !inputId) {
      handleTerminalInputEnvelope(peer, envelope);
      return;
    }
    const key = `${deviceId}\0${sessionId}\0${inputId}`;
    const prior = terminalInputOperationQueues.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(() => {
      if (disposed || !peers.has(peer) || !peer.authenticated) return;
      handleTerminalInputEnvelope(peer, envelope);
    });
    terminalInputOperationQueues.set(key, operation);
    try {
      await operation;
    } finally {
      if (terminalInputOperationQueues.get(key) === operation) {
        terminalInputOperationQueues.delete(key);
      }
    }
  }

  function handleTerminalInputEnvelope(peer: PeerState, envelope: ParsedSyncEnvelope): void {
    // Forward keystrokes / pasted text from an attached client into the active
    // PTY. An input id is exactly-once only for the same payload bytes; reusing
    // an id for different bytes is a protocol conflict, never a duplicate ACK.
    const payload = envelope.payload as Partial<SyncTerminalInputPayload> | null;
    const sessionId = toOptionalString(payload?.sessionId);
    const data = typeof payload?.data === "string" ? payload.data : null;
    const hasInputId = payload?.inputId != null;
    const inputId = normalizeTerminalInputId(payload?.inputId);
    const sendAck = (ack: SyncTerminalInputAckPayload): void => {
      try {
        if (sendRequired(peer, "terminal_input_ack", ack, envelope.requestId)) return;
        args.logger.warn("sync.terminal_input_ack_not_sent", {
          sessionId: ack.sessionId,
          inputId: ack.inputId ?? null,
          peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
        });
      } catch (error) {
        args.logger.warn("sync.terminal_input_ack_send_failed", {
          sessionId: ack.sessionId,
          inputId: ack.inputId ?? null,
          peerDeviceId: peer.metadata?.deviceId ?? peer.pairedDeviceId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const sendFailure = (
      code: Extract<SyncTerminalInputAckPayload, { ok: false }>["error"]["code"],
      message: string,
    ): void => {
      if (!hasInputId) return;
      const error = code === "not_subscribed"
        ? { code, message, retryable: true as const }
        : { code, message, retryable: false as const };
      sendAck({
        sessionId,
        ...(inputId ? { inputId } : {}),
        ok: false,
        duplicate: false,
        error,
      } satisfies SyncTerminalInputAckPayload);
    };
    if (hasInputId && !inputId) {
      args.logger.warn("sync.terminal_input_invalid_input_id", { sessionId });
      sendFailure("invalid_input_id", "Terminal input id must be a bounded non-empty string.");
      return;
    }
    const projectScope = resolveSyncHostInboundProjectScope(
      envelope.type,
      envelope.projectId,
      args.projectId,
      hostProjectIdAliases,
    );
    if (!projectScope.ok) {
      sendFailure("project_mismatch", "Terminal input does not belong to this hosted project.");
      return;
    }
    if (!sessionId || data == null) {
      sendFailure("project_mismatch", "Terminal input does not belong to this hosted project.");
      return;
    }
    const deviceId = toOptionalString(peer.pairedDeviceId) ?? toOptionalString(peer.metadata?.deviceId);
    const dataFingerprint = inputId
      ? createHash("sha256").update(data, "utf8").digest("hex")
      : null;
    if (inputId && deviceId && dataFingerprint) {
      const recordedFingerprint = terminalInputDedupeLedger.fingerprint(deviceId, sessionId, inputId);
      if (recordedFingerprint) {
        if (recordedFingerprint !== dataFingerprint) {
          args.logger.warn("sync.terminal_input_id_conflict", {
            sessionId,
            peerDeviceId: deviceId,
            inputId,
          });
          sendFailure("input_id_conflict", "This terminal input id was already used for different data.");
          return;
        }
        sendAck({
          sessionId,
          inputId,
          ok: true,
          duplicate: true,
        } satisfies SyncTerminalInputAckPayload);
        return;
      }
    }
    if (!peer.subscribedSessionIds.has(sessionId)) {
      args.logger.warn("sync.terminal_input_unsubscribed_session", { sessionId });
      sendFailure("not_subscribed", "Subscribe to this terminal before sending input.");
      return;
    }
    const session = args.sessionService.get(sessionId);
    if (!session) {
      args.logger.warn("sync.terminal_input_project_mismatch", { sessionId });
      sendFailure("project_mismatch", "This terminal belongs to a different hosted project.");
      return;
    }
    if (!args.ptyService.hasLivePty(sessionId)) {
      args.logger.info("sync.terminal_input_no_active_pty", { sessionId });
      sendFailure("session_not_live", "This terminal session is no longer live.");
      return;
    }
    if (inputId && deviceId && dataFingerprint) {
      if (!terminalInputDedupeLedger.hasCapacity()) {
        sendFailure("dedupe_capacity", "Too many terminal inputs are awaiting retry-window expiry.");
        return;
      }
    }
    const accepted = args.ptyService.writeBySessionId(sessionId, data);
    if (!accepted) {
      args.logger.info("sync.terminal_input_no_active_pty", { sessionId });
      sendFailure("session_not_live", "This terminal session is no longer live.");
      return;
    }
    if (inputId && deviceId && dataFingerprint) {
      const remembered = terminalInputDedupeLedger.remember(deviceId, sessionId, inputId, dataFingerprint);
      if (remembered !== "recorded") {
        // Capacity and duplicate checks run synchronously before the PTY write,
        // so this indicates an internal contract violation. Close rather than
        // acknowledge an untracked write that a retry could duplicate.
        args.logger.warn("sync.terminal_input_receipt_failed", { sessionId, remembered });
        try {
          peer.ws.close(4002, "Terminal input receipt failed");
        } catch {
          // ignore close failures
        }
        return;
      }
      sendAck({
        sessionId,
        inputId,
        ok: true,
        duplicate: false,
      } satisfies SyncTerminalInputAckPayload);
    }
  }

  function handleMessageWithTimeout(peer: PeerState, envelope: ParsedSyncEnvelope): Promise<void> {
    const operationGeneration = peer.lifecycleGeneration;
    const operationController = new AbortController();
    peer.inFlightOperationControllers.add(operationController);
    const operationStartedAtMs = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const durationMs = Math.max(messageTimeoutMs, Date.now() - operationStartedAtMs);
        if (envelope.type === "command") {
          const action = toOptionalString(
            (envelope.payload as Partial<SyncCommandPayload> | null)?.action,
          ) ?? "unknown";
          args.logger.warn("sync_host.command_timed_out", {
            action,
            durationMs,
            peerKind: usageClientSurfaceFromPeer(
              peer.metadata?.deviceType,
              peer.metadata?.platform,
            ),
            timedOut: true,
          });
        }
        operationController.abort(
          new Error(`Timed out handling sync message ${envelope.type} after ${messageTimeoutMs}ms.`),
        );
        if (peer.lifecycleGeneration === operationGeneration) {
          // Invalidate the operation generation and close the peer. Known-slow
          // handlers observe operationController.signal and stop waiting;
          // handlers that cannot safely cancel keep the existing exactly-once
          // ledger behavior and may still publish an eventual replay result.
          peer.lifecycleGeneration += 1;
          try {
            peer.ws.close(4002, "Sync message timed out");
          } catch {
            // The generation barrier remains authoritative if close throws.
          }
        }
        reject(new Error(`Timed out handling sync message ${envelope.type} after ${messageTimeoutMs}ms.`));
      }, messageTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([
      handleMessage(peer, envelope, operationController.signal),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      peer.inFlightOperationControllers.delete(operationController);
    });
  }

  async function handleMessage(
    peer: PeerState,
    envelope: ParsedSyncEnvelope,
    signal: AbortSignal,
  ): Promise<void> {
    const lifecycleGeneration = peer.lifecycleGeneration;
    if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
    const heartbeatAwaitedAt = markPeerMessageSeen(peer);

    if (!peer.authenticated) {
      if (
        envelope.type !== "hello"
        && envelope.type !== "pairing_request"
        && envelope.type !== "account_challenge"
      ) {
        send(peer.ws, "hello_error", {
          code: "invalid_hello",
          message: "Authenticate with hello, pairing_request, or account_challenge before sending other messages.",
        }, envelope.requestId);
        try {
          peer.ws.close(4003, "Authentication required");
        } catch {
          // ignore
        }
        return;
      }
      if (envelope.type === "account_challenge") {
        // No device identity is available before a challenge, so this can only
        // consult the address and global buckets.
        const cooldownMs = Math.max(
          pairingCooldownMsRemaining({ ip: peer.remoteAddress }),
          adoptChallengeCooldownMsRemaining(peer.remoteAddress),
        );
        if (cooldownMs > 0) {
          const minutes = Math.ceil(cooldownMs / 60_000);
          send(peer.ws, "account_challenge_error", {
            message: `Too many failed authentication attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          }, envelope.requestId);
          return;
        }
        if (peer.adoptChallenge) {
          registerAdoptChallengeIssuance(peer.remoteAddress);
          send(peer.ws, "account_challenge_error", {
            message: "An account adoption challenge is already active on this connection.",
          }, envelope.requestId);
          return;
        }
        const challenge = envelope.requestId
          ? parseAccountChallengePayload(envelope.payload)
          : null;
        if (!challenge) {
          peer.adoptChallenge = null;
          registerAdoptChallengeIssuance(peer.remoteAddress);
          send(peer.ws, "account_challenge_error", {
            message: "Invalid account adoption challenge.",
          }, envelope.requestId);
          return;
        }
        const hostSupportedAeads = supportedAdoptChannelAeads();
        if (
          challenge.supportedAeads === null
          && !ALLOW_LEGACY_UNBOUND_ADOPTION_AEAD
        ) {
          send(peer.ws, "account_challenge_error", {
            message:
              "This ADE version must advertise account adoption ciphers. Update ADE on this device.",
          }, envelope.requestId);
          return;
        }
        const adoptAead = negotiateAdoptChannelAead(
          challenge.supportedAeads,
          hostSupportedAeads,
        );
        if (!adoptAead) {
          if (!peer.reportedIncompatibleAdoptCipher) {
            peer.reportedIncompatibleAdoptCipher = true;
            args.logger.warn("sync_host.account_challenge_cipher_incompatible", {
              remoteAddress: peer.remoteAddress,
              transportOrigin: peer.transportOrigin,
              clientAdvertisedAeads: challenge.supportedAeads !== null,
              clientAeadCount: challenge.supportedAeads?.length ?? 0,
              hostSupportedAeads,
            });
          }
          send(peer.ws, "account_challenge_error", {
            message:
              "No compatible account adoption cipher is available. Update ADE on both devices.",
          }, envelope.requestId);
          return;
        }
        // A well-formed challenge only triggers one public signature and is the
        // normal adoption operation, so it feeds no cooldown at all. Signing
        // load is already bounded by the per-connection single-active-challenge
        // guard above and the relay's per-machine connection cap. Crucially,
        // every relay adopter reaches this host from 127.0.0.1 (the relay bridge
        // dials the loopback listener), so charging well-formed challenges to
        // any shared bucket would let a few normal adoptions lock out all relay
        // adoption. Only malformed/anomalous challenges (the branches above and
        // the catch below) count toward the abuse limiter.
        try {
          const identity = machineIdentitySigningStore.getOrCreate();
          const hostDeviceId = readBrainMetadata().deviceId;
          const hostEphemeral = generateX25519EphemeralKeyPair();
          const hostEphemeralPublicKey =
            hostEphemeral.publicKeyRaw.toString("base64");
          const ts = adoptNow();
          const canonical = buildAdoptChallengeSignatureInput({
            hostDeviceId,
            nonce: challenge.nonce,
            clientEphemeralPublicKey: challenge.clientEphemeralPublicKey,
            hostEphemeralPublicKey,
            ts,
            ...(challenge.supportedAeads !== null ? { aead: adoptAead } : {}),
          });
          const sessionKey = deriveAdoptSessionKey({
            privateKey: hostEphemeral.privateKey,
            peerPublicKeyRaw: challenge.clientEphemeralPublicKeyBytes,
            nonce: challenge.nonceBytes,
          });
          peer.adoptChallenge = {
            sessionKey,
            nonce: challenge.nonce,
            hostDeviceId,
            expiresAtMs: ts + ADOPT_CHANNEL_CHALLENGE_TTL_MS,
            aead: adoptAead,
            aeadBoundToSignature: challenge.supportedAeads !== null,
          };
          send(peer.ws, "account_challenge_ok", {
            v: 1,
            hostDeviceId,
            ts,
            hostEphemeralPublicKey,
            signature: signEd25519(identity.privateKey, canonical).toString("base64"),
            ...(challenge.supportedAeads !== null ? { aead: adoptAead } : {}),
          }, envelope.requestId);
        } catch (error) {
          peer.adoptChallenge = null;
          // A signing/derivation failure here means a rejected peer ephemeral
          // (malformed X25519 point) or missing host identity — an anomaly, so
          // it counts globally in addition to the per-IP charge above.
          registerAdoptChallengeIssuance(peer.remoteAddress);
          args.logger.warn("sync_host.account_challenge_failed", {
            remoteAddress: peer.remoteAddress,
            reason: error instanceof Error ? error.message : String(error),
          });
          send(peer.ws, "account_challenge_error", {
            message: "Host identity is unavailable.",
          }, envelope.requestId);
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
        let relayPairingAuthorization: Awaited<ReturnType<typeof captureAccountAuthorization>> = null;
        if (peer.transportOrigin === "relay-bridge") {
          relayPairingAuthorization = await captureAccountAuthorization();
          if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
          const ownerUserId = relayPairingAuthorization?.userId ?? null;
          const relayAccountToken = pairing.relayAccountToken?.trim() ?? "";
          const config = args.getAccountAttestationConfig?.();
          let accepted = Boolean(ownerUserId && relayAccountToken && config);
          if (accepted) {
            try {
              await verifyAccountAttestation({
                token: relayAccountToken,
                expectedUserId: ownerUserId!,
                config: config!,
              });
              if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
            } catch (error) {
              accepted = false;
              args.logger.warn("sync_host.pairing_relay_account_rejected", {
                deviceId: pairing.peer.deviceId,
                reason: typeof (error as { code?: unknown } | null)?.code === "string"
                  ? (error as { code: string }).code
                  : "verification_failed",
              });
            }
          }
          if (!accepted) {
            args.logger.warn("sync_host.pairing_relay_account_required", {
              deviceId: pairing.peer.deviceId,
              hostSignedIn: Boolean(ownerUserId),
              proofPresent: Boolean(relayAccountToken),
            });
            send(peer.ws, "pairing_result", {
              ok: false,
              error: {
                code: "relay_account_required",
                message: "Sign in with the same ADE account on both machines.",
              },
            }, envelope.requestId);
            try { peer.ws.close(4003, "Account sign-in required"); } catch { /* ignore */ }
            return;
          }
        }
        const pairFailureSubject: PairFailureSubject = {
          ip: peer.remoteAddress,
          deviceId: pairing.peer.deviceId,
        };
        const cooldownMs = pairingCooldownMsRemaining(pairFailureSubject);
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
        if (relayPairingAuthorization) {
          const commitAuthorization = await captureAccountAuthorization();
          if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
          if (
            !commitAuthorization
            || commitAuthorization.userId !== relayPairingAuthorization.userId
            || commitAuthorization.generation !== relayPairingAuthorization.generation
          ) {
            send(peer.ws, "pairing_result", {
              ok: false,
              error: {
                code: "relay_account_required",
                message: "Sign in with the same ADE account on both machines.",
              },
            }, envelope.requestId);
            try { peer.ws.close(4003, "Account session changed"); } catch { /* ignore */ }
            return;
          }
        }
        try {
          const result = pairingStore.pairPeer(pairing.peer, pairing.code, {
            dpopPublicKey: pairing.dpopPublicKey ?? null,
            runtimeHostGrant: pairing.runtimeHostGrant ?? null,
            // A correct PIN on a direct LAN/tailnet route is the first-time
            // Nearby authorization gate for desktop runtime access. Relay has
            // a separate same-account proof and never inherits this exception.
            allowDirectPinRuntimeHost: peer.transportOrigin !== "relay-bridge",
          });
          closeExistingPeersForDevice(pairing.peer.deviceId, peer);
          clearPairFailuresAfterSuccessfulPair(pairFailureSubject);
          args.deviceRegistryService?.upsertPeerMetadata(pairing.peer, {
            lastSeenAt: nowIso(),
            lastHost: peer.remoteAddress,
            lastPort: peer.remotePort,
          });
          send(peer.ws, "pairing_result", {
            ok: true,
            deviceId: result.deviceId,
            secret: result.secret,
            // Advisory only. Present when this re-pair was staged behind the
            // device's existing secret, which stays valid until a hello proves
            // the replacement arrived. Clients that ignore it stay correct.
            ...(result.pendingRotationExpiresAtMs != null
              ? {
                  rotation: {
                    pendingCommit: true,
                    expiresInMs: Math.max(0, result.pendingRotationExpiresAtMs - Date.now()),
                  },
                }
              : {}),
          }, envelope.requestId);
          peer.pairingCommitOfferedForDeviceId =
            result.pendingRotationExpiresAtMs != null && pairing.pairingCommitVersion === 1
              ? pairing.peer.deviceId
              : null;
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
            registerPairFailure(pairFailureSubject);
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
      const negotiatedCompression = negotiateSyncApplicationCompression(hello.compression);
      let sealedAdoption: {
        sessionKey: Buffer;
        hostDeviceId: string;
        clientDeviceId: string;
        aead: AdoptChannelAead;
        aeadBoundToSignature: boolean;
      } | null = null;
      if (hello.auth?.kind === "account_sealed") {
        const sealedAuth = hello.auth;
        const challenge = peer.adoptChallenge;
        // A challenge is single-use even when unsealing or validation fails.
        peer.adoptChallenge = null;
        const rejectSealedHello = (message: string): void => {
          send(peer.ws, "hello_error", {
            code: "invalid_hello",
            message,
          } satisfies SyncHelloErrorPayload, envelope.requestId);
          try {
            peer.ws.close(4003, "Invalid sealed account hello");
          } catch {
            // ignore close failures
          }
        };
        if (!challenge) {
          rejectSealedHello("A completed account challenge is required.");
          return;
        }
        if (challenge.expiresAtMs < adoptNow()) {
          rejectSealedHello("The account challenge expired.");
          return;
        }
        if (
          sealedAuth.deviceId !== hello.peer.deviceId
          || !sealedAuth.sealed
        ) {
          rejectSealedHello("The sealed account hello is invalid.");
          return;
        }
        try {
          const plaintext = unseal(
            challenge.sessionKey,
            buildAdoptHelloAad(
              challenge.hostDeviceId,
              sealedAuth.deviceId,
            ),
            sealedAuth.sealed,
            challenge.aead,
          );
          const accountAuth = parseUnsealedAccountAuth(
            JSON.parse(plaintext.toString("utf8")),
          );
          if (
            !accountAuth
            || accountAuth.deviceId !== sealedAuth.deviceId
          ) {
            rejectSealedHello("The sealed account credentials are invalid.");
            return;
          }
          hello.auth = accountAuth;
          sealedAdoption = {
            sessionKey: challenge.sessionKey,
            hostDeviceId: challenge.hostDeviceId,
            clientDeviceId: sealedAuth.deviceId,
            aead: challenge.aead,
            aeadBoundToSignature: challenge.aeadBoundToSignature,
          };
        } catch (error) {
          const errorCode =
            error !== null
            && typeof error === "object"
            && "code" in error
            && typeof error.code === "string"
              ? error.code
              : null;
          args.logger.warn("sync_host.account_sealed_open_failed", {
            remoteAddress: peer.remoteAddress,
            transportOrigin: peer.transportOrigin,
            aead: challenge.aead,
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorCode,
          });
          rejectSealedHello("The sealed account credentials could not be opened.");
          return;
        }
      }
      let authenticatedPairingRecord: SyncPairingRecord | null = null;
      let accountPairing: { deviceId: string; secret: string } | null = null;
      let relayAccountOwnerUserId: string | null = null;
      let relayAccountExpiresAtMs: number | null = null;
      let connectionAttemptReserved = false;
      let connectionAttemptRejected = false;
      let pendingPairingCommitDeviceId: string | null = null;
      let authFailureCode: SyncHelloErrorPayload["code"] = "auth_failed";
      // Every rejection below used to arrive as this one string. The client
      // renders whatever it is handed, so a bare "authentication failed" left
      // the user with no idea whether to re-pair, sign in, update, or give up.
      // Each `authFail(...)` names one cause and one next step; the generic
      // wording survives only as the unreachable default.
      let authFailureMessage = "Sync authentication failed.";
      const authFail = (
        message: string,
        code?: SyncHelloErrorPayload["code"],
      ): true => {
        authFailureMessage = message;
        if (code) authFailureCode = code;
        return true;
      };
      // Return semantics: `true` means authentication FAILED -> the caller below
      // sends a `hello_error` and closes the socket (4003). `false` means the
      // device is authenticated.
      const authFailed = await (async () => {
        if (hello.auth?.kind === "bootstrap") {
          if (peer.transportOrigin === "relay-bridge") {
            args.logger.warn("sync_host.bootstrap_relay_rejected", {
              deviceId: hello.peer.deviceId,
            });
            return authFail(
              "Sign in with the same ADE account on both machines.",
              "relay_account_required",
            );
          }
          // The bootstrap token is a shared, plaintext, never-rotating secret.
          // Once the sync host is bound to the LAN (the new 0.0.0.0 default),
          // anyone who can read it off disk / a previous handshake could pair a
          // brand-new device with NO PIN check. That is unacceptable: the PIN is
          // the security boundary for first pairing.
          //
          // So a bootstrap-token hello may ONLY authenticate a device that has
          // ALREADY completed PIN pairing (has a pairing record). Unknown
          // devices are rejected here and must go through `pairing_request`,
          // which verifies the 6-digit PIN via pinStore. This preserves
          // legitimate already-paired reconnects (which use the token) while
          // forcing every new device through the PIN gate.
          if (!safeStringEquals(bootstrapToken, hello.auth.token)) {
            return authFail(
              "This device's saved setup token does not match this machine. Pair it again.",
            );
          }
          const bootstrapPairingRecord = pairingStore.getPairingRecord(hello.peer.deviceId);
          // A device whose pairing record carries a DPoP key must prove key
          // possession on every connection. Letting it in via the shared
          // bootstrap token would be a downgrade path: a stolen token plus a
          // spoofed deviceId would bypass the enclave binding entirely.
          if (bootstrapPairingRecord?.dpopPublicKey) {
            return authFail(
              "This device must reconnect with its saved pairing secret and device key,"
                + " not the shared setup token. Pair it again.",
            );
          }
          if (SYNC_HOST_BIND_LOOPBACK_ONLY) {
            // Loopback-only hosts (ADE_SYNC_BIND_HOST=127.0.0.1) are already a
            // trust boundary — only local processes can connect — so retain the
            // historical bootstrap-token behaviour there.
            return false;
          }
          // Strict posture: with require-DPoP on, the shared bootstrap token
          // must never satisfy a LAN hello — a keyless legacy pairing would
          // otherwise sidestep the forced re-pair the setting exists to compel.
          if (args.requireDpop?.()) {
            args.logger.warn("sync_host.dpop_required_bootstrap_rejected", {
              deviceId: hello.peer.deviceId,
            });
            return authFail(
              "This machine requires every device to pair with its own security key."
                + " Pair this device again to create one.",
            );
          }
          // LAN-bound default: bootstrap is reconnect-only. A device must already
          // be paired; unknown devices must pair via the PIN flow. Existing
          // paired phones from older releases may not have a host PIN configured
          // yet, and should still be able to reconnect with their stored token.
          if (bootstrapPairingRecord == null) {
            return authFail("This device is not paired with this machine. Pair it with a PIN first.");
          }
          return false;
        }
        if (hello.auth?.kind === "paired") {
          const pairedAuth = hello.auth;
          if (pairedAuth.deviceId !== hello.peer.deviceId) {
            return authFail(
              "The pairing identity in this connection did not match the device that sent it.",
            );
          }
          if (peer.transportOrigin === "relay-bridge") {
            const authorization = await captureAccountAuthorization();
            if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return true;
            const ownerUserId = authorization?.userId ?? null;
            const relayAccountToken = pairedAuth.relayAccountToken?.trim() ?? "";
            const config = args.getAccountAttestationConfig?.();
            if (!ownerUserId || !relayAccountToken || !config) {
              authFailureCode = "relay_account_required";
              authFailureMessage = "Sign in with the same ADE account on both machines.";
              args.logger.warn("sync_host.paired_relay_account_required", {
                deviceId: pairedAuth.deviceId,
                hostSignedIn: Boolean(ownerUserId),
                proofPresent: Boolean(relayAccountToken),
              });
              return true;
            }
            try {
              const attestation = await verifyAccountAttestation({
                token: relayAccountToken,
                expectedUserId: ownerUserId,
                config,
              });
              if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return true;
              relayAccountOwnerUserId = attestation.userId;
              relayAccountExpiresAtMs = attestation.expiresAtMs;
            } catch (error) {
              authFailureCode = "relay_account_required";
              authFailureMessage = "Sign in with the same ADE account on both machines.";
              args.logger.warn("sync_host.paired_relay_account_rejected", {
                deviceId: pairedAuth.deviceId,
                reason: typeof (error as { code?: unknown } | null)?.code === "string"
                  ? (error as { code: string }).code
                  : "verification_failed",
              });
              return true;
            }
            const commitAuthorization = await captureAccountAuthorization();
            if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return true;
            if (
              !authorization
              || !commitAuthorization
              || commitAuthorization.userId !== authorization.userId
              || commitAuthorization.generation !== authorization.generation
            ) {
              authFailureCode = "relay_account_required";
              authFailureMessage = "Sign in with the same ADE account on both machines.";
              return true;
            }
          }
          // This rejection used to be silent on both ends: the host logged
          // nothing and the client showed a bare "authentication". Name it,
          // and tell the client the one thing that actually resolves it.
          const knownRecord = pairingStore.getPairingRecord(pairedAuth.deviceId);
          const presentedSecretState = pairingStore.verifySecret(
            pairedAuth.deviceId,
            pairedAuth.secret,
          );
          const deferPendingCommit =
            presentedSecretState === "pending"
            && peer.pairingCommitOfferedForDeviceId === pairedAuth.deviceId;
          if (!pairingStore.authenticate(
            pairedAuth.deviceId,
            pairedAuth.secret,
            { deferPendingCommit },
          )) {
            // Deliberately identical for both cases. The host knows which it
            // is and logs it below, but telling an UNAUTHENTICATED caller
            // whether a device id exists here turns this into an existence
            // oracle, and the user's next step is the same either way.
            args.logger.warn("sync_host.paired_device_rejected", {
              deviceId: pairedAuth.deviceId,
              reason: knownRecord ? "secret_mismatch" : "unknown_device",
            });
            return authFail(SYNC_REPAIR_REQUIRED_MESSAGE, "repair_required");
          }
          authenticatedPairingRecord = pairingStore.getPairingRecordForSecret(
            pairedAuth.deviceId,
            pairedAuth.secret,
          );
          if (!authenticatedPairingRecord) {
            return authFail("This machine could not read its pairing record for this device. Pair it again.");
          }
          const pairingAccountOwner = toOptionalString(authenticatedPairingRecord.accountOwnerUserId);
          if (pairingAccountOwner) {
            const currentOwner = await refreshAccountLease();
            if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return true;
            if (currentOwner !== pairingAccountOwner) {
              // A LAN client rejected here sees only "authentication"; the
              // account mismatch is the actionable part.
              args.logger.warn("sync_host.paired_account_owner_mismatch", {
                deviceId: pairedAuth.deviceId,
                hasCurrentOwner: Boolean(currentOwner),
                ownerMatches: false,
              });
              return authFail(
                "This machine is signed in to a different ADE account than the one that paired this device.",
              );
            }
          }
          const dpopFailure = evaluatePairedHelloDpop({
            storedPublicKey: authenticatedPairingRecord.dpopPublicKey,
            deviceId: pairedAuth.deviceId,
            secret: pairedAuth.secret,
            proof: pairedAuth.dpop ?? null,
            requireDpop: args.requireDpop?.() ?? false,
            nonceCache: dpopNonceCache,
            adoptPublicKey: (publicKey) => {
              pairingStore.adoptDpopPublicKey(pairedAuth.deviceId, publicKey);
              args.logger.info("sync_host.dpop_adopted", { deviceId: pairedAuth.deviceId });
            },
          });
          if (dpopFailure) {
            args.logger.warn("sync_host.dpop_rejected", {
              deviceId: pairedAuth.deviceId,
              reason: dpopFailure,
            });
            return authFail(syncDpopFailureMessage(dpopFailure));
          }
          // evaluatePairedHelloDpop may TOFU-pin the first DPoP key for a
          // legacy keyless record. Reload it before installing Relay refresh;
          // otherwise this first socket advertises reauthorization while its
          // peer-local record still has no usable key.
          authenticatedPairingRecord = pairingStore.getPairingRecordForSecret(
            pairedAuth.deviceId,
            pairedAuth.secret,
          );
          if (!authenticatedPairingRecord) {
            return authFail("This machine could not read its pairing record for this device. Pair it again.");
          }
          pendingPairingCommitDeviceId = deferPendingCommit ? pairedAuth.deviceId : null;
          return false;
        }
        if (hello.auth?.kind === "account") {
          const accountAuth = hello.auth;
          // Shared with the projectless brain fallback. The divergences that
          // are real — sealed adoption and single-connection arbitration, both
          // of which only the project host serves — ride in as options.
          const accountResult = await authenticateSyncAccountHello({
            auth: accountAuth,
            peer: hello.peer,
            transportOrigin: peer.transportOrigin,
            logger: args.logger,
            logPrefix: "sync_host",
            pairingStore,
            dpopNonceCache,
            captureAccountAuthorization,
            getAccountAttestationConfig: () => args.getAccountAttestationConfig?.() ?? null,
            verifyAccountAttestation,
            withCommitLock: withHelloCommitLock,
            isPeerCurrent: () => isPeerLifecycleCurrent(peer, lifecycleGeneration),
            sealedAdoption: Boolean(sealedAdoption),
            arbitrateConnectionAttempt: () =>
              arbitrateConnectionAttempt(hello.peer.deviceId, peer, hello.peer),
            allowLegacyUpgrade: true,
            pairingCodeNoun: "PIN",
            notSignedInCode: "auth_failed",
          });
          if (accountResult.kind === "stale") return true;
          if (accountResult.kind === "rejected") {
            return authFail(accountResult.message, accountResult.code);
          }
          if (accountResult.kind === "superseded") {
            connectionAttemptRejected = true;
            return false;
          }
          authenticatedPairingRecord = accountResult.pairingRecord;
          accountPairing = accountResult.accountPairing;
          relayAccountOwnerUserId = accountResult.attestation.userId;
          relayAccountExpiresAtMs = accountResult.attestation.expiresAtMs;
          connectionAttemptReserved = accountResult.connectionAttemptReserved;
          return false;
        }
        return authFail(
          "This connection did not present any way to authenticate. Update ADE on this device.",
        );
      })();
      if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
      if (authFailed) {
        // Attribute the rejection: a phone dialing a stale/reused address can
        // reach a stranger machine whose auth check fails. Only when the
        // rejecting machine's identity matches the client's saved pairing may
        // the client safely drop its credentials.
        const rejectingHost = readBrainMetadata();
        send(peer.ws, "hello_error", {
          code: authFailureCode,
          message: authFailureMessage,
          host: {
            deviceId: rejectingHost.deviceId,
            name: rejectingHost.deviceName,
          },
        }, envelope.requestId);
        try {
          peer.ws.close(4003, "Authentication failed");
        } catch {
          // ignore
        }
        return;
      }

      if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
      if (
        connectionAttemptRejected
        || (!connectionAttemptReserved && !arbitrateConnectionAttempt(hello.peer.deviceId, peer, hello.peer))
      ) {
        send(peer.ws, "hello_error", {
          code: "connection_attempt_superseded",
          message: "A newer connection route already won this connection attempt.",
        } satisfies SyncHelloErrorPayload, envelope.requestId);
        try {
          peer.ws.close(4000, "connection_attempt_superseded");
        } catch {
          // ignore close failures
        }
        return;
      }
      peer.authenticated = true;
      if (sealedAdoption) {
        clearAdoptChallengeIssuancesAfterSuccessfulAuth(peer.remoteAddress);
      }
      peer.adoptChallenge = null;
      clearPeerAuthTimeout(peer);
      peer.metadata = hello.peer;
      const auth = hello.auth ?? { kind: "bootstrap", token: "" };
      peer.authKind = auth.kind;
      const recordBackedAuth = auth.kind === "paired" || auth.kind === "account";
      peer.pairedDeviceId = recordBackedAuth ? auth.deviceId : null;
      peer.pairingRecord = recordBackedAuth ? authenticatedPairingRecord : null;
      peer.pendingPairingCommitDeviceId = pendingPairingCommitDeviceId;
      peer.pendingPairingCommitSecret = pendingPairingCommitDeviceId
        ? (auth.kind === "paired" ? auth.secret : null)
        : null;
      installRelayAuthorization(
        peer,
        peer.transportOrigin === "relay-bridge"
          && relayAccountOwnerUserId
          && relayAccountExpiresAtMs != null
          ? {
              ownerUserId: relayAccountOwnerUserId,
              expiresAtMs: relayAccountExpiresAtMs,
              challenge: randomBytes(24).toString("base64url"),
            }
          : null,
      );
      // Prefer the client's cursor for THIS project DB. The legacy single
      // dbVersion is only meaningful when the client last synced this same
      // DB; after a hosted-project change it points into a different DB's
      // version sequence and silently skips (or replays) the entire backlog.
      const ownSiteId = args.db.sync.getSiteId();
      const serverDbVersion = args.db.sync.getDbVersion();
      peer.lastKnownServerDbVersion = initialSyncHostCursorForPeer({
        peer: hello.peer,
        serverDbSiteId: ownSiteId,
        serverDbVersion,
      });
      args.deviceRegistryService?.upsertPeerMetadata(hello.peer, {
        lastSeenAt: nowIso(),
        lastHost: peer.remoteAddress,
        lastPort: peer.remotePort,
      });
      const projectCatalog = await buildProjectCatalogPayload();
      if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
      const projectActionsEnabled = Boolean(
        args.projectCatalogProvider?.browseDirectories
          && args.projectCatalogProvider.getDefaultParentDir
          && args.projectCatalogProvider.openProject
          && args.projectCatalogProvider.createProject
          && args.projectCatalogProvider.cloneProject
          && args.projectCatalogProvider.listMyGitHubRepos,
      );
      const helloOkPayload = buildSyncHostHelloOkPayload({
        peer: hello.peer,
        brain: readBrainMetadata(),
        serverDbVersion,
        serverDbSiteId: ownSiteId,
        heartbeatIntervalMs,
        pollIntervalMs,
        compression: negotiatedCompression,
        chunkedEnvelopes: hello.peer.capabilities?.includes(SYNC_CHUNKED_ENVELOPES_CAPABILITY) === true,
        projectCatalog,
        projectCatalogEnabled: Boolean(args.projectCatalogProvider),
        projectActionsEnabled,
        crossProjectChatEnabled: Boolean(args.foreignChatProvider),
        remoteCommandSupportedActions: remoteCommandService.getSupportedActions(),
        remoteCommandDescriptors: remoteCommandService.getDescriptors(),
        localCommandDescriptors: localPresenceCommandDescriptors,
        compressionThresholdBytes,
        maxProjectCatalogEnvelopeBytes,
        cloudRelayWssUrl: args.getCloudRelayWssUrl?.() ?? null,
        relayAuthorization: peer.relayAuthorization?.metadata() ?? null,
        connectionTransport: syncConnectionTransportForOrigin(peer.transportOrigin),
        terminalInputAckEnabled: true,
        // Runtime RPC channel + port-forward are desktop-runtime-host only,
        // even after successful pairing (phones/browsers stay on the mobile
        // command allowlist).
        runtimeChannelEnabled:
          isRecordBackedSyncAuthKind(auth.kind) && isRuntimeHostPairingRecord(authenticatedPairingRecord),
        accountPairing,
      });
      if (sealedAdoption) {
        send(peer.ws, "hello_ok", {
          v: 1,
          sealed: seal(
            sealedAdoption.sessionKey,
            buildAdoptHelloOkAad(
              sealedAdoption.hostDeviceId,
              sealedAdoption.clientDeviceId,
            ),
            Buffer.from(JSON.stringify(helloOkPayload), "utf8"),
            undefined,
            sealedAdoption.aead,
          ),
        }, envelope.requestId);
        if (!sealedAdoption.aeadBoundToSignature) {
          args.logger.warn("sync_host.legacy_adoption_aead_unbound", {
            deviceId: hello.peer.deviceId,
            clientVersion: hello.peer.appVersion ?? null,
            aead: sealedAdoption.aead,
            transportOrigin: peer.transportOrigin,
          });
        }
      } else {
        send(peer.ws, "hello_ok", helloOkPayload, envelope.requestId);
      }
      // hello_ok itself uses the legacy encoder so the selected codec is never
      // required before the client has observed the negotiation result.
      peer.negotiatedCompression = negotiatedCompression;
      args.onStateChanged?.();
      // Catch-up is background work. The periodic poll starts it after the
      // serialized hello queue has had a chance to admit subscriptions.
      if (!isPeerLifecycleCurrent(peer, lifecycleGeneration)) return;
      broadcastBrainStatus();
      return;
    }

    if (envelope.type === "pairing_commit") {
      const payload = safeObjectValue(envelope.payload);
      const deviceId = toOptionalString(payload?.deviceId);
      if (!deviceId || peer.pendingPairingCommitDeviceId !== deviceId) {
        send(peer.ws, "pairing_commit_result", {
          ok: false,
          error: {
            code: "no_pending_rotation",
            message: "This connection has no staged pairing to commit.",
          },
        }, envelope.requestId);
        return;
      }
      const authenticatedSecret = peer.pendingPairingCommitSecret;
      const committed = authenticatedSecret
        ? pairingStore.commitPendingRotation(deviceId, authenticatedSecret)
        : null;
      if (!committed) {
        peer.pendingPairingCommitDeviceId = null;
        peer.pendingPairingCommitSecret = null;
        send(peer.ws, "pairing_commit_result", {
          ok: false,
          error: {
            code: "pairing_commit_failed",
            message: "The staged pairing expired. Pair this device again.",
          },
        }, envelope.requestId);
        return;
      }
      peer.pairingRecord = committed;
      peer.pendingPairingCommitDeviceId = null;
      peer.pendingPairingCommitSecret = null;
      peer.pairingCommitOfferedForDeviceId = null;
      send(peer.ws, "pairing_commit_result", { ok: true }, envelope.requestId);
      return;
    }

    if (isPairedRuntimeEnvelopeType(envelope.type)) {
      await pairedChannelService.handleEnvelope(
        peer.ws,
        envelope.type,
        envelope.payload,
        isRecordBackedSyncAuthKind(peer.authKind),
        // Gate the runtime RPC channel + port-forward to desktop runtime-host
        // peers; paired phones/browsers get the channel closed with a clear
        // reason instead of reaching the full runtime action registry.
        isRecordBackedSyncAuthKind(peer.authKind) && isRuntimeHostPairingRecord(peer.pairingRecord),
      );
      return;
    }

    const envelopePayload = safeObjectValue(envelope.payload);
    const personalChatEnvelope =
      (
        envelope.type === "chat_subscribe"
        || envelope.type === "chat_unsubscribe"
        || envelope.type === "chat_history"
      )
      && envelopePayload?.chatScope === "personal";
    const projectScope: SyncHostProjectScopeResolution = personalChatEnvelope
      ? { ok: true, projectId: null, usedSingleProjectFallback: false }
      : resolveSyncHostInboundProjectScope(
          envelope.type,
          envelope.projectId,
          args.projectId,
          hostProjectIdAliases,
        );
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
      case "project_forget_request": {
        await handleProjectForgetRequest(peer, envelope.requestId, envelope.payload as SyncProjectForgetRequestPayload);
        break;
      }
      case "project_browse_request": {
        await handleProjectBrowseRequest(peer, envelope.requestId, envelope.payload as ProjectBrowseInput);
        break;
      }
      case "project_default_parent_dir_request": {
        await handleProjectDefaultParentDirRequest(peer, envelope.requestId);
        break;
      }
      case "project_open_request": {
        await handleProjectActionRequest(
          peer,
          envelope.requestId,
          "project_open_result",
          "Opening projects is not available from this machine.",
          (envelope.payload ?? {}) as SyncProjectOpenRequestPayload,
          args.projectCatalogProvider?.openProject,
        );
        break;
      }
      case "project_create_request": {
        await handleProjectActionRequest(
          peer,
          envelope.requestId,
          "project_create_result",
          "Creating projects is not available from this machine.",
          (envelope.payload ?? {}) as CreateProjectInput,
          args.projectCatalogProvider?.createProject,
        );
        break;
      }
      case "project_clone_request": {
        await handleProjectActionRequest(
          peer,
          envelope.requestId,
          "project_clone_result",
          "Cloning projects is not available from this machine.",
          (envelope.payload ?? {}) as CloneProjectInput,
          args.projectCatalogProvider?.cloneProject,
        );
        break;
      }
      case "project_list_my_github_repos_request": {
        await handleProjectListMyGitHubReposRequest(peer, envelope.requestId, envelope.payload as ListMyGitHubReposInput);
        break;
      }
      case "heartbeat": {
        handleHeartbeatEnvelope(peer, envelope, heartbeatAwaitedAt);
        break;
      }
      case "changeset_batch": {
        const payload = (envelope.payload ?? {}) as SyncChangesetBatchPayload;
        const batchId = payload.batchId || envelope.requestId || "";
        const changes = Array.isArray(payload.changes) ? payload.changes as CrsqlChangeRow[] : [];
        // Inbound DoS guard: a single oversized batch would block the DB inside
        // the synchronous BEGIN IMMEDIATE transaction below. Reject before
        // applying anything so the peer can resend in smaller chunks.
        const tooManyRows = changes.length > MAX_INBOUND_CHANGESET_ROWS;
        // Only re-serialize to size-check when the cheap row check passed — avoids
        // a JSON.stringify of every legitimate inbound batch on the hot path.
        const approxBatchBytes = tooManyRows || changes.length === 0
          ? 0
          : Buffer.byteLength(JSON.stringify(changes), "utf8");
        if (tooManyRows || approxBatchBytes > MAX_INBOUND_CHANGESET_BYTES) {
          sendRequired(peer, "changeset_ack", {
            batchId,
            fromDbVersion: Number(payload.fromDbVersion ?? 0),
            toDbVersion: Number(payload.toDbVersion ?? 0),
            appliedDbVersion: args.db.sync.getDbVersion(),
            appliedCount: 0,
            ok: false,
            error: {
              code: "changeset_too_large",
              message: `inbound changeset_batch exceeds cap (${changes.length} rows, ${approxBatchBytes} bytes)`,
            },
          } satisfies SyncChangesetAckPayload, envelope.requestId);
          break;
        }
        // Brain-seizure guard: never let a peer's CRR rows for host-authoritative
        // tables (e.g. sync_cluster_state) win and flip brain ownership.
        const filtered = changes.filter((change) => !isHostAuthoritativeTable(change));
        try {
          let appliedCount = 0;
          if (filtered.length > 0) {
            const applyResult = args.db.sync.applyChanges(filtered);
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
        const payload = envelope.payload as { sessionId?: string; maxBytes?: number; sinceOffset?: number } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (!sessionId) break;
        const barrier: PendingTerminalSnapshotBarrier = {
          generation: ++peer.nextTerminalSnapshotGeneration,
          captureAttempt: 0,
          requiredCaptureAttempt: 0,
          requiredSnapshotEndOffset: null,
          events: [],
          queuedBytes: 0,
          failed: false,
        };
        peer.pendingTerminalSnapshots.set(sessionId, barrier);
        peer.subscribedSessionIds.add(sessionId);
        const maxBytes = Math.max(1_024, Math.min(2_000_000, Math.floor(payload?.maxBytes ?? DEFAULT_TERMINAL_SNAPSHOT_BYTES)));
        const sinceOffset = typeof payload?.sinceOffset === "number" && Number.isInteger(payload.sinceOffset)
          ? payload.sinceOffset
          : null;
        let forceReplacement = false;
        let barrierCompleted = false;
        try {
          while (barrier.captureAttempt < MAX_TERMINAL_SNAPSHOT_CAPTURE_ATTEMPTS) {
            if (!isCurrentTerminalSnapshotBarrier(peer, sessionId, barrier, lifecycleGeneration)) break;
            barrier.captureAttempt += 1;
            const session = args.sessionService.get(sessionId);
            const transcriptSnapshot = session
              ? await runWithAbortSignal(
                  () => args.ptyService.readTranscriptSnapshot({
                    sessionId,
                    maxBytes,
                    alignStartToSafeBoundary: true,
                  }),
                  signal,
                  "Sync operation aborted.",
                )
              : null;
            if (!isCurrentTerminalSnapshotBarrier(peer, sessionId, barrier, lifecycleGeneration)) break;

            const flush = planTerminalSnapshotFlush(
              barrier,
              transcriptSnapshot?.endOffset ?? null,
            );
            if (flush.needsRecapture) {
              forceReplacement = true;
              continue;
            }

            let snapshot: SyncTerminalSnapshotPayload | null = null;
            // Resume fast-path: the PTY snapshot is an exact logical suffix and
            // includes buffered live bytes beyond the flushed file. Slice that
            // authoritative suffix instead of re-reading the physical transcript,
            // otherwise a reconnect can silently miss output that arrived before
            // this subscription while the WriteStream was still draining.
            if (
              !forceReplacement
              && sinceOffset != null
              && transcriptSnapshot
              && sinceOffset >= transcriptSnapshot.startOffset
              // Equality has no delta to deliver. Send the replacing snapshot
              // below so a remounted controller cannot hydrate to an empty screen.
              && sinceOffset < transcriptSnapshot.endOffset
            ) {
              const snapshotBytes = Buffer.from(transcriptSnapshot.data, "utf8");
              const byteStart = sinceOffset - transcriptSnapshot.startOffset;
              const startsAtUtf8Boundary = byteStart >= 0
                && byteStart <= snapshotBytes.length
                && (byteStart === snapshotBytes.length || (snapshotBytes[byteStart]! & 0b1100_0000) !== 0b1000_0000);
              if (
                startsAtUtf8Boundary
                && snapshotBytes.length === transcriptSnapshot.endOffset - transcriptSnapshot.startOffset
              ) {
                snapshot = {
                  sessionId,
                  transcript: snapshotBytes.subarray(byteStart).toString("utf8"),
                  status: session?.status ?? null,
                  runtimeState: session?.runtimeState ?? null,
                  lastOutputPreview: session?.lastOutputPreview ?? null,
                  capturedAt: nowIso(),
                  startOffset: sinceOffset,
                  endOffset: transcriptSnapshot.endOffset,
                  delta: true,
                  live: args.ptyService.hasLivePty(sessionId),
                };
              }
            }
            snapshot ??= {
              sessionId,
              transcript: transcriptSnapshot?.data ?? "",
              status: session?.status ?? null,
              runtimeState: session?.runtimeState ?? null,
              lastOutputPreview: session?.lastOutputPreview ?? null,
              capturedAt: nowIso(),
              startOffset: transcriptSnapshot?.startOffset ?? null,
              endOffset: transcriptSnapshot?.endOffset ?? null,
              live: args.ptyService.hasLivePty(sessionId),
            };
            if (!sendRequired(peer, "terminal_snapshot", snapshot, envelope.requestId)) break;
            barrierCompleted = true;
            for (const event of flush.events) {
              const sent = event.kind === "data"
                ? sendRequired(peer, "terminal_data", event.payload)
                : sendRequired(peer, "terminal_exit", event.payload);
              if (!sent) {
                barrierCompleted = false;
                break;
              }
            }
            break;
          }
          if (
            !barrierCompleted
            && isCurrentTerminalSnapshotBarrier(peer, sessionId, barrier, lifecycleGeneration)
            && barrier.captureAttempt >= MAX_TERMINAL_SNAPSHOT_CAPTURE_ATTEMPTS
          ) {
            failTerminalSnapshotBarrier(peer, sessionId, barrier, "capture_did_not_reach_stable_offset");
          }
        } catch (error) {
          if (peer.pendingTerminalSnapshots.get(sessionId) === barrier) {
            peer.subscribedSessionIds.delete(sessionId);
            restoreDesktopTerminalSizeIfUnwatched(sessionId);
          }
          throw error;
        } finally {
          clearTerminalSnapshotBarrier(peer, sessionId, barrier);
        }
        break;
      }
      case "terminal_unsubscribe": {
        const payload = envelope.payload as { sessionId?: string } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (sessionId) {
          clearTerminalSnapshotBarrier(peer, sessionId);
          peer.subscribedSessionIds.delete(sessionId);
          restoreDesktopTerminalSizeIfUnwatched(sessionId);
        }
        break;
      }
      case "terminal_history": {
        // Pull-to-load-older paging over the transcript file. Reuses the
        // terminal_input access gate: only a peer with a live subscribe for
        // the session may read its history.
        const payload = envelope.payload as { sessionId?: string; beforeOffset?: number; maxBytes?: number } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (!sessionId) break;
        const beforeOffset = typeof payload?.beforeOffset === "number" && Number.isFinite(payload.beforeOffset)
          ? Math.max(0, Math.floor(payload.beforeOffset))
          : 0;
        const refused: SyncTerminalHistoryResponsePayload = {
          sessionId,
          data: "",
          startOffset: beforeOffset,
          endOffset: beforeOffset,
          atStart: true,
        };
        const session = args.sessionService.get(sessionId);
        if (!peer.subscribedSessionIds.has(sessionId) || !session) {
          args.logger.warn("sync.terminal_history_unsubscribed_session", { sessionId });
          sendRequired(peer, "terminal_history", refused, envelope.requestId);
          break;
        }
        const pageBytes = Math.max(
          MIN_TERMINAL_HISTORY_PAGE_BYTES,
          Math.min(
            MAX_TERMINAL_HISTORY_PAGE_BYTES,
            Math.floor(typeof payload?.maxBytes === "number" ? payload.maxBytes : DEFAULT_TERMINAL_HISTORY_PAGE_BYTES),
          ),
        );
        const transcriptWindow = args.ptyService.getTranscriptWindow(sessionId);
        if (!transcriptWindow) {
          sendRequired(peer, "terminal_history", refused, envelope.requestId);
          break;
        }
        const endOffset = Math.max(
          transcriptWindow.startOffset,
          Math.min(beforeOffset, transcriptWindow.endOffset),
        );
        const requestedStartOffset = Math.max(transcriptWindow.startOffset, endOffset - pageBytes);
        const range = await runWithAbortSignal(
          () => args.ptyService.readTranscriptRange({
            sessionId,
            startOffset: requestedStartOffset,
            endOffset,
            alignStartToSafeBoundary: true,
          }),
          signal,
          "Sync operation aborted.",
        );
        if (!range) {
          sendRequired(peer, "terminal_history", refused, envelope.requestId);
          break;
        }
        sendRequired(peer, "terminal_history", {
          sessionId,
          data: range.data,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          // Alignment can move the returned start past the retained base. The
          // unaligned/clamped request still tells the client whether any older
          // bytes exist; using the returned boundary causes an empty paging
          // loop after transcript rollover.
          atStart: requestedStartOffset <= transcriptWindow.startOffset,
        } satisfies SyncTerminalHistoryResponsePayload, envelope.requestId);
        break;
      }
      case "terminal_input": {
        handleTerminalInputEnvelope(peer, envelope);
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
        // Tagged as mobile so the phone's viewport never becomes the
        // desktop-preferred size — it is restored when the phone detaches.
        args.ptyService.resizeBySessionId(sessionId, cols, rows, { source: "mobile" });
        break;
      }
      case "chat_history": {
        const payload = envelope.payload as SyncChatHistoryRequestPayload | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (!sessionId) break;
        const beforeOffset = typeof payload?.beforeOffset === "number" && Number.isFinite(payload.beforeOffset)
          ? Math.max(0, Math.floor(payload.beforeOffset))
          : 0;
        const unavailablePage = (): AgentChatEventHistoryPage => ({
          sessionId,
          events: [],
          startOffset: beforeOffset,
          hasMore: beforeOffset > 0,
          sessionFound: false,
          unavailable: true,
        });
        const subscribedBinding = peer.chatSubscriptionBindings.get(sessionId);
        const requestedScope = requestedChatSubscriptionScope(payload);
        if (
          !peer.subscribedChatSessionIds.has(sessionId)
          || !chatSubscriptionMatchesRequest(subscribedBinding, payload, sessionId)
        ) {
          args.logger.warn("sync.chat_history_unsubscribed_or_scope_mismatch", {
            sessionId,
            subscribedScope: subscribedBinding?.scope ?? null,
            requestedScope,
          });
          sendRequired(peer, "chat_history", unavailablePage(), envelope.requestId);
          break;
        }
        try {
          let page: AgentChatEventHistoryPage;
          const subscribedTranscriptPath = peer.resolvedChatTranscriptPaths.get(sessionId);
          if (subscribedTranscriptPath) {
            const read = await runWithAbortSignal(
              () => readTranscriptHistoryPage({
                transcriptPath: subscribedTranscriptPath,
                sessionId,
                beforeOffset,
                maxBytes: payload?.maxBytes,
                signal,
              }),
              signal,
              "Sync operation aborted.",
            );
            page = {
              sessionId,
              events: read.envelopes,
              startOffset: read.startOffset,
              hasMore: read.hasMore,
              sessionFound: true,
            };
          } else if (args.agentChatService) {
            page = await args.agentChatService.getChatEventHistoryPage(sessionId, {
              beforeOffset,
              ...(typeof payload?.maxBytes === "number" ? { maxBytes: payload.maxBytes } : {}),
              ...(signal ? { signal } : {}),
            });
          } else {
            page = unavailablePage();
          }
          sendRequired(peer, "chat_history", page, envelope.requestId);
        } catch (error) {
          args.logger.warn("sync.chat_history_failed", {
            sessionId,
            beforeOffset,
            error: error instanceof Error ? error.message : String(error),
          });
          sendRequired(peer, "chat_history", unavailablePage(), envelope.requestId);
        }
        break;
      }
      case "chat_subscribe": {
        const payload = envelope.payload as SyncChatSubscribePayload | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (!sessionId) break;
        const requestedScope = requestedChatSubscriptionScope(payload);
        const personalChatRequested = requestedScope === "personal";
        const priorSubscription = {
          subscribed: peer.subscribedChatSessionIds.has(sessionId),
          binding: peer.chatSubscriptionBindings.get(sessionId),
          transcriptPath: peer.resolvedChatTranscriptPaths.get(sessionId),
          offset: peer.chatTranscriptOffsets.get(sessionId),
          scanOffset: peer.chatTranscriptScanOffsets.get(sessionId),
          sentIds: peer.chatEventIdsSent.get(sessionId),
        };
        let hydrationSucceeded = false;
        peer.hydratingChatSessionIds.add(sessionId);
        try {

        // Cross-project "quick look": a payload targeting a registered FOREIGN
        // project is served read-only from that project's `.ade` transcript
        // JSONL — no local session row, no runtime boot. The pump tails the
        // same path for live events. The provider is the security boundary
        // (validates the project, sandboxes the path). An explicitly-foreign
        // scope the provider can't confirm fails CLOSED (served as unknown),
        // never falls back to a local session that happens to share the id —
        // including in the pump: a rejected scope must not register a live
        // subscription at all, or the periodic pump would stream the ACTIVE
        // project's transcript for the same session id after the empty ack.
        const personalTranscriptPath = personalChatRequested
          ? await runWithAbortSignal(
              () => args.personalChatScope?.transcriptPath?.(sessionId).catch(() => null) ?? null,
              signal,
              "Sync operation aborted.",
            )
          : null;
        const foreignScope = personalChatRequested
          ? personalTranscriptPath
            ? { kind: "foreign" as const, transcriptPath: personalTranscriptPath }
            : { kind: "rejected" as const }
          : resolveForeignChatScope(payload, sessionId);
        const foreignTranscriptPath = foreignScope.kind === "foreign" ? foreignScope.transcriptPath : null;
        if (foreignScope.kind === "rejected") {
          peer.subscribedChatSessionIds.delete(sessionId);
          peer.chatSubscriptionBindings.delete(sessionId);
        } else {
          peer.subscribedChatSessionIds.add(sessionId);
          if (foreignScope.kind === "foreign" && requestedScope === "foreign-project") {
            peer.chatSubscriptionBindings.set(sessionId, {
              scope: "foreign-project",
              transcriptPath: path.resolve(foreignScope.transcriptPath),
            });
          } else if (requestedScope === "personal") {
            peer.chatSubscriptionBindings.set(sessionId, { scope: "personal" });
          } else {
            peer.chatSubscriptionBindings.set(sessionId, { scope: "project" });
          }
        }
        if (foreignTranscriptPath) {
          peer.resolvedChatTranscriptPaths.set(sessionId, foreignTranscriptPath);
        } else {
          peer.resolvedChatTranscriptPaths.delete(sessionId);
        }

        const session = foreignScope.kind === "local" ? args.sessionService.get(sessionId) : null;
        const transcriptPath = foreignTranscriptPath ?? session?.transcriptPath ?? null;
        // Establish the durable handoff boundary before any async snapshot
        // work. The pump stays behind the hydration barrier until after the
        // ack, then starts here so appends that race the snapshot are replayed
        // (snapshot overlap is removed by the normal delivery-key dedupe).
        const hydrationStartOffset = await readTranscriptLogicalSize(transcriptPath);
        // Snapshots are byte-capped transcript tails — a long-running turn's
        // `status: started` event can sit outside the tail, leaving a client
        // that subscribes mid-turn unable to tell the session is streaming.
        // Ship the live turn state on the ack so clients don't depend on the
        // (slower) changeset pump for running/stop affordances. Resolved
        // immediately before each send (getSessionSummary is microtask-only):
        // computing it earlier leaves an I/O window (readTranscriptTail) where
        // a terminal chat_event could overtake a stale `turnActive: true`.
        // Foreign quick-looks have no live agent chat service here, so they
        // derive turn state from the streamed status events instead.
        const resolveLiveStatusFields = async (): Promise<{ turnActive?: boolean }> => {
          if (personalChatRequested) {
            const turnActive = await runWithAbortSignal(
              () => args.personalChatScope?.isTurnActive?.(sessionId).catch(() => false) ?? false,
              signal,
              "Sync operation aborted.",
            );
            return typeof turnActive === "boolean" ? { turnActive } : {};
          }
          if (foreignScope.kind !== "local") return {};
          const liveSummary = await runWithAbortSignal(
            () => args.agentChatService?.getSessionSummary(sessionId).catch(() => null) ?? null,
            signal,
            "Sync operation aborted.",
          );
          return liveSummary ? { turnActive: liveSummary.status === "active" } : {};
        };
        // Replay buffers hold the ACTIVE project's live events — a foreign
        // quick-look whose session id collides with a local session must never
        // resume from them (it would splice local events into the foreign feed).
        const resumePlan = planChatEventResume(
          foreignScope.kind === "local" ? chatEventReplayBuffers.get(sessionId) : undefined,
          payload?.sinceSeq,
        );
        if (resumePlan.mode === "replay") {
          // The replay buffer covers everything the peer missed: skip the
          // snapshot, fast-forward the transcript pump past content the
          // replay already carries, and re-send just the missed events as
          // ordinary chat_event envelopes (in order, after the ack).
          peer.chatTranscriptOffsets.set(sessionId, hydrationStartOffset);
          peer.chatTranscriptScanOffsets.delete(sessionId);
          const resumeAck: SyncChatSubscribeSnapshotPayload = {
            sessionId,
            capturedAt: nowIso(),
            truncated: false,
            events: [],
            resumed: true,
            ...(await resolveLiveStatusFields()),
          };
          sendRequired(peer, "chat_subscribe", resumeAck, envelope.requestId);
          hydrationSucceeded = true;
          for (const entry of resumePlan.entries) {
            // Skip events already delivered on this connection — TCP ordering
            // guarantees the peer has (or will get) them.
            if (sendChatEvent(peer, entry.event, entry.seq) === "failed") break;
          }
          args.logger.debug("sync_host.chat_subscribe_resumed", {
            sessionId,
            sinceSeq: payload?.sinceSeq,
            replayedEventCount: resumePlan.entries.length,
          });
          break;
        }
        const maxBytes = Math.max(
          1_024,
          Math.min(2_000_000, Math.floor(typeof payload?.maxBytes === "number" ? payload.maxBytes : DEFAULT_TERMINAL_SNAPSHOT_BYTES)),
        );
        let events: AgentChatEventEnvelope[];
        let truncated: boolean;
        let transcriptSize: number;
        let tailStartOffset = 0;
        let hasOlderHistory = false;
        if (foreignTranscriptPath) {
          const foreignSnapshot = await runWithAbortSignal(
            () => readForeignChatSnapshot(foreignTranscriptPath, maxBytes, signal),
            signal,
            "Sync operation aborted.",
          );
          events = foreignSnapshot.events;
          truncated = foreignSnapshot.truncated;
          transcriptSize = foreignSnapshot.transcriptSize;
          tailStartOffset = foreignSnapshot.tailStartOffset;
          hasOlderHistory = foreignSnapshot.tailStartOffset > 0;
        } else if (foreignScope.kind === "rejected") {
          // Unresolvable explicit-foreign scope: serve an empty snapshot, never
          // this host's local history for the same session id.
          events = [];
          truncated = false;
          transcriptSize = 0;
        } else {
          const history: AgentChatEventHistorySnapshot | null = args.agentChatService
            ? await args.agentChatService.getChatEventHistory(sessionId, {
              maxEvents: CHAT_EVENT_REPLAY_MAX_EVENTS,
              maxBytes,
              ...(signal ? { signal } : {}),
              })
            : null;
          events = history?.events ?? [];
          transcriptSize = await readTranscriptLogicalSize(transcriptPath);
          truncated = history?.truncated ?? (transcriptSize > maxBytes);
          tailStartOffset = history?.tailStartOffset ?? 0;
          hasOlderHistory = history?.hasOlderHistory
            ?? (history?.truncated === true && tailStartOffset > 0);
        }
        events = events.map(compactChatEventEnvelopeForSync);
        peer.chatTranscriptOffsets.set(sessionId, hydrationStartOffset);
        peer.chatTranscriptScanOffsets.delete(sessionId);
        const snapshot: SyncChatSubscribeSnapshotPayload = {
          sessionId,
          capturedAt: nowIso(),
          truncated,
          tailStartOffset,
          hasOlderHistory,
          cursorKind: "byte",
          events,
          ...(await resolveLiveStatusFields()),
        };
        sendRequired(peer, "chat_subscribe", snapshot, envelope.requestId);
        for (const event of events) {
          markChatEventSent(peer, event);
        }
        hydrationSucceeded = true;
        } finally {
          peer.hydratingChatSessionIds.delete(sessionId);
          if (!hydrationSucceeded) {
            // A failed snapshot must not leave a half-subscribed peer behind.
            // Otherwise the pump resumes from its default offset and can
            // replay the entire transcript as live traffic after no ack. A
            // refresh of an existing subscription restores its exact prior
            // cursor/dedupe state so one transient snapshot failure cannot
            // silently disconnect a client that was already receiving events.
            if (priorSubscription.subscribed) peer.subscribedChatSessionIds.add(sessionId);
            else peer.subscribedChatSessionIds.delete(sessionId);
            if (priorSubscription.binding !== undefined) {
              peer.chatSubscriptionBindings.set(sessionId, priorSubscription.binding);
            } else {
              peer.chatSubscriptionBindings.delete(sessionId);
            }
            if (priorSubscription.transcriptPath !== undefined) {
              peer.resolvedChatTranscriptPaths.set(sessionId, priorSubscription.transcriptPath);
            } else {
              peer.resolvedChatTranscriptPaths.delete(sessionId);
            }
            if (priorSubscription.offset !== undefined) {
              peer.chatTranscriptOffsets.set(sessionId, priorSubscription.offset);
            } else {
              peer.chatTranscriptOffsets.delete(sessionId);
            }
            if (priorSubscription.scanOffset !== undefined) {
              peer.chatTranscriptScanOffsets.set(sessionId, priorSubscription.scanOffset);
            } else {
              peer.chatTranscriptScanOffsets.delete(sessionId);
            }
            if (priorSubscription.sentIds !== undefined) {
              peer.chatEventIdsSent.set(sessionId, priorSubscription.sentIds);
            } else {
              peer.chatEventIdsSent.delete(sessionId);
            }
          }
        }
        break;
      }
      case "chat_unsubscribe": {
        const payload = envelope.payload as SyncChatUnsubscribePayload | null;
        const sessionId = toOptionalString(payload?.sessionId);
        const subscribedBinding = sessionId ? peer.chatSubscriptionBindings.get(sessionId) : undefined;
        if (
          sessionId
          && (
            !hasExplicitChatSubscriptionScope(payload)
            || chatSubscriptionMatchesRequest(subscribedBinding, payload, sessionId)
          )
        ) {
          peer.subscribedChatSessionIds.delete(sessionId);
          peer.hydratingChatSessionIds.delete(sessionId);
          peer.chatSubscriptionBindings.delete(sessionId);
          peer.chatTranscriptOffsets.delete(sessionId);
          peer.chatTranscriptScanOffsets.delete(sessionId);
          peer.chatEventIdsSent.delete(sessionId);
          peer.resolvedChatTranscriptPaths.delete(sessionId);
        }
        break;
      }
      case "roster_subscribe": {
        await handleRosterSubscribe(peer, envelope.requestId, envelope.payload as SyncRosterSubscribePayload | null);
        break;
      }
      case "roster_unsubscribe": {
        handleRosterUnsubscribe(peer);
        break;
      }
      case "command":
        await handleCommand(peer, envelope.requestId, {
          ...(envelope.payload as SyncCommandPayload),
          ...(!toOptionalString((envelope.payload as SyncCommandPayload | null)?.projectId) && envelope.projectId
            ? { projectId: envelope.projectId }
            : {}),
        }, signal);
        break;
      default:
        break;
    }
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

  // Hoisted so the fallback remoteCommandService args (declared earlier in
  // this closure) can reference it lazily without TDZ concerns.
  function computeLanePresenceStamp(): string {
    return getLanePresenceSnapshot()
      .map((entry) => `${entry.laneId}:${entry.devicesOpen.map((d) => `${d.deviceId}|${d.displayName}|${d.platform}`).sort().join(",")}`)
      .sort()
      .join(";");
  }

  function getListeningPort(): number | null {
    if (!server) return sharedListener?.getPort() ?? null;
    const address = server.address();
    return typeof address === "object" && address ? address.port : null;
  }

  return {
    async waitUntilListening(): Promise<number> {
      if (!server) {
        // Shared listener: binding happened (or happens) at the brain level;
        // ensureListening is idempotent and returns the existing port.
        const port = sharedListener!.getPort()
          ?? await sharedListener!.ensureListening([args.port ?? DEFAULT_SYNC_HOST_PORT]);
        try {
          // A project-host handoff may happen long after the listener's bind
          // probe. Force a fresh identity check before this host republishes
          // LAN/Tailscale discovery for the shared port.
          await sharedListener!.revalidateLoopback();
        } finally {
          loopbackValidationStatus = sharedListener!.getLoopbackValidationStatus();
        }
        if (!loopbackValidationStatus.loopbackAdeValidated || loopbackValidationStatus.port !== port) {
          throw new Error(`The shared sync listener on 127.0.0.1:${port} was not ADE-validated.`);
        }
        await publishValidatedDiscovery(port);
        return port;
      }
      if (startupError) {
        throw startupError;
      }
      if (server.address()) {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : DEFAULT_SYNC_HOST_PORT;
        await validateListeningPort(port);
        await publishValidatedDiscovery(port);
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
      await validateListeningPort(port);
      await publishValidatedDiscovery(port);
      return port;
    },

    getPort(): number | null {
      return getListeningPort();
    },

    getBootstrapToken(): string {
      return bootstrapToken;
    },

    setLocalActiveLanePresence(laneIds: string[]): void {
      setLocalActiveLanePresence(laneIds);
    },

    refreshLanDiscovery(options?: { forceLan?: boolean; forceTailnet?: boolean }): void {
      const port = getListeningPort();
      if (port != null) {
        // Re-validate the loopback listener before republishing so a post-startup
        // shadow cannot re-advertise a stale port. On failure validateListeningPort
        // marks the route unvalidated and throws, so we skip the publish.
        void (async () => {
          await validateListeningPort(port, { force: true });
          await publishValidatedDiscovery(port, options);
        })().catch((error) => {
          args.logger.warn("sync_host.discovery_refresh_failed", {
            port,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },

    setDiscoveryEnabled(enabled: boolean): void {
      if (discoveryEnabled === enabled) return;
      discoveryEnabled = enabled;
      const port = getListeningPort();
      if (!enabled) {
        unpublishLanDiscovery();
        void unpublishTailnetDiscovery();
        updateTailnetDiscoveryStatus({
          state: "disabled",
          serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
          servicePort: port ?? SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
          target: null,
          updatedAt: nowIso(),
          error: "Tailnet discovery is disabled for this background project context.",
          stderr: null,
        });
        return;
      }
      if (port != null) {
        // Re-enabling discovery must also re-validate the loopback listener so a
        // shadow that appeared while discovery was off cannot be published.
        void (async () => {
          await validateListeningPort(port, { force: true });
          publishLanDiscovery(port, { force: true });
          publishTailnetDiscovery(port, { force: true });
        })().catch((error) => {
          args.logger.warn("sync_host.discovery_refresh_failed", {
            port,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },

    revokePairedDevice(deviceId: string): void {
      pairingStore.revoke(deviceId);
      let revokedConnectedPeer = false;
      for (const peer of peers) {
        if (
          !peer.authenticated
          || !isRecordBackedSyncAuthKind(peer.authKind)
          || peer.pairedDeviceId !== deviceId
        ) continue;
        revokedConnectedPeer = true;
        const presenceDeviceId = peer.metadata?.deviceId ?? peer.pairedDeviceId ?? deviceId;
        const presenceRemoved = removeAllPresenceForDevice(presenceDeviceId, "remote");
        pairedChannelService.closePeer(peer.ws, "Pairing revoked.", true);
        peer.authenticated = false;
        peer.metadata = null;
        peer.authKind = null;
        peer.pairedDeviceId = null;
        peer.pairingRecord = null;
        try {
          peer.ws.close(4003, "Pairing revoked");
        } catch {
          // ignore close failures
        }
        if (presenceRemoved) revokedConnectedPeer = true;
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

    getLoopbackValidationStatus(): SyncLoopbackValidationStatus {
      return { ...loopbackValidationStatus };
    },

    getLanePresenceSnapshot(): Array<{ laneId: string; devicesOpen: DeviceMarker[] }> {
      return getLanePresenceSnapshot();
    },

    // Deterministic digest of lane presence for conditional-response
    // signatures (see SyncRemoteCommandServiceArgs.getLanePresenceStamp).
    getLanePresenceStamp(): string {
      return computeLanePresenceStamp();
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

    /**
     * Push a fresh `brain_status` to every connected peer. Used when a value
     * it advertises changes outside the normal broadcast cadence, so phones
     * don't wait a full interval.
     */
    broadcastBrainStatusNow(): void {
      broadcastBrainStatus();
    },

    /**
     * Tell connected controllers that the host's cached GitHub projection has
     * changed. The payload is intentionally tiny; clients fetch the newest
     * projected snapshot once, while the normal CRR stream continues to carry
     * mapped PR rows. This covers unmapped webhook updates without polling.
     */
    broadcastPrsUpdated(): void {
      const payload = { updatedAt: nowIso() };
      for (const peer of peers) {
        if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
        send(peer.ws, "prs_updated", payload);
      }
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

    handlePtyData(event: PtyDataEvent): void {
      const payload = {
        sessionId: event.sessionId,
        ptyId: event.ptyId,
        data: event.data,
        at: nowIso(),
        offset: event.offset ?? null,
      } satisfies SyncTerminalDataPayload;
      for (const peer of peers) {
        if (!peer.authenticated || !peer.subscribedSessionIds.has(event.sessionId) || peer.ws.readyState !== WebSocket.OPEN) continue;
        if (enqueueTerminalSnapshotEvent(peer, event.sessionId, {
          kind: "data",
          payload,
          byteLength: Buffer.byteLength(event.data, "utf8"),
        })) continue;
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
      } satisfies SyncTerminalExitPayload;
      for (const peer of peers) {
        if (!peer.authenticated || !peer.subscribedSessionIds.has(event.sessionId) || peer.ws.readyState !== WebSocket.OPEN) continue;
        if (enqueueTerminalSnapshotEvent(peer, event.sessionId, {
          kind: "exit",
          payload,
          byteLength: 0,
        })) continue;
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
      clearInterval(accountLeaseTimer);
      stopRosterSafetyPoll();
      clearRosterFlushTimers();
      unpublishLanDiscovery();
      try {
        await unpublishTailnetDiscovery();
      } catch {
        // Never throw from dispose.
      }
      if (!server) {
        // Shared listener: do NOT close the server or the peer sockets this
        // host does not own. Detach the connection handler and hand every
        // open, authenticated socket back to the listener so the next hosted
        // project's sync host can adopt it without the phone reconnecting.
        // If no host adopts in time (e.g. the brain is shutting down or sync
        // was disabled), the listener closes them after a grace period.
        detachSharedListener?.();
        detachSharedListener = null;
        const snapshots: SyncPeerHandoffSnapshot[] = [];
        for (const peer of peers) {
          abortPeerOperations(peer, "Sync host changed.");
          pairedChannelService.closePeer(peer.ws, "Sync host changed.", true);
          clearPeerAuthTimeout(peer);
          const relayAuthorizationSnapshot = peer.relayAuthorization?.snapshot() ?? null;
          peer.relayAuthorization?.dispose();
          peer.relayAuthorization = null;
          peer.envelopeChunks.reset();
          peer.ws.removeAllListeners("message");
          peer.ws.removeAllListeners("close");
          peer.ws.removeAllListeners("error");
          // No new terminal input can enter after listener detachment. Drain
          // the dedicated synchronous-input queue before exporting receipts so
          // a write and its dedupe record move to the next host atomically.
          await peer.terminalInputQueue.catch(() => {});
          if (peer.ws.readyState !== WebSocket.OPEN) {
            // Not handed off — re-attach a no-op error handler so a late
            // transport error on the dying socket cannot crash the process.
            peer.ws.on("error", () => {});
            try {
              peer.ws.close();
            } catch {
              // ignore close failures
            }
            continue;
          }
          const chatSubscriptions = [...peer.subscribedChatSessionIds].flatMap((sessionId) => {
            const scope = peer.chatSubscriptionBindings.get(sessionId)?.scope ?? "project";
            return scope === "foreign-project" ? [] : [{ sessionId, scope }];
          });
          const handedOffChatSessionIds = new Set(chatSubscriptions.map(({ sessionId }) => sessionId));
          snapshots.push({
            ws: peer.ws,
            remoteAddress: peer.remoteAddress,
            remotePort: peer.remotePort,
            transportOrigin: peer.transportOrigin,
            metadata: peer.metadata,
            negotiatedCompression: peer.negotiatedCompression,
            authKind: peer.authKind,
            pairedDeviceId: peer.pairedDeviceId,
            connectedAt: peer.connectedAt,
            relayAccountExpiresAtMs: relayAuthorizationSnapshot?.expiresAtMs ?? null,
            relayAuthorization: relayAuthorizationSnapshot,
            terminalInputDedupe: terminalInputDedupeLedger.snapshotForDevice(
              peer.pairedDeviceId ?? peer.metadata?.deviceId ?? "",
            ),
            serverDbSiteId: args.db.sync.getSiteId(),
            lastKnownServerDbVersion: peer.lastKnownServerDbVersion,
            subscribedSessionIds: [...peer.subscribedSessionIds],
            // Project and machine-scoped personal chats survive. A foreign
            // quick-look does not: restoring its bare session id would make
            // the new host fall back to a same-id local session. The client
            // re-subscribes to that project scope after handoff.
            chatSubscriptions,
            subscribedChatSessionIds: chatSubscriptions
              .filter(({ scope }) => scope === "project")
              .map(({ sessionId }) => sessionId),
            chatTranscriptOffsets: Object.fromEntries(
              [...peer.chatTranscriptOffsets]
                .filter(([sessionId]) => handedOffChatSessionIds.has(sessionId)),
            ),
            chatEventSequences: Object.fromEntries(
              [...handedOffChatSessionIds].flatMap((sessionId) => {
                const eventSequence = chatEventSequenceHighWaterBySession.get(sessionId);
                return eventSequence == null ? [] : [[sessionId, eventSequence]];
              }),
            ),
            rosterSubscribed: peer.rosterSubscribed,
            productAnalyticsEnabled: peer.productAnalyticsEnabled,
          });
        }
        peers.clear();
        if (snapshots.length > 0) {
          sharedListener!.depositPeers(snapshots);
        }
      } else {
        await new Promise<void>((resolve) => {
          const finish = () => resolve();
          for (const peer of peers) {
            abortPeerOperations(peer, "Sync host stopped.");
            pairedChannelService.closePeer(peer.ws, "Sync host stopped.", false);
            clearPeerAuthTimeout(peer);
            try {
              peer.ws.close();
            } catch {
              // ignore
            }
          }
          // Graceful close frames were sent to peers above. ws's close() for an
          // externally-supplied http server resolves only after every client
          // socket drains — a wedged socket would hang dispose — and it does NOT
          // close the http server (which owns the port). So detach ws's
          // listeners, then close the http server directly, forcing any lingering
          // sockets so the port frees deterministically.
          try {
            server.close();
          } catch {
            // ignore: we free the port via the http server below
          }
          if (!httpServer || !httpServer.listening) {
            finish();
            return;
          }
          try {
            httpServer.close(() => finish());
            httpServer.closeAllConnections?.();
          } catch {
            finish();
          }
        });
      }
      pairedChannelService.dispose();
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
