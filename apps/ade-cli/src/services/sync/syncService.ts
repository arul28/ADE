import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import {
  createSyncAccountDirectoryHealth,
  type SyncCloudRelayStatus,
  type SyncAccountDirectoryHealth,
  type SyncDesktopConnectionDraft,
  type SyncDeviceRuntimeState,
  type SyncGetStatusArgs,
  type SyncPairingConnectInfo,
  type SyncPeerDeviceType,
  type SyncPeerMetadata,
  type SyncPeerPlatform,
  type PersonalChatScopeContract,
  type SyncRouteHealth,
  type SyncRoleSnapshot,
  type SyncTailnetDiscoveryStatus,
  type SyncTransferBlocker,
  type SyncTransferReadiness,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { createAiIntegrationService } from "../../../../desktop/src/main/services/ai/aiIntegrationService";
import type { createCtoStateService } from "../../../../desktop/src/main/services/cto/ctoStateService";
import type { CtoMemoryService } from "../../../../desktop/src/main/services/cto/ctoMemoryService";
import type { createLinearCredentialService } from "../../../../desktop/src/main/services/cto/linearCredentialService";
import type { createLinearOAuthService } from "../../../../desktop/src/main/services/cto/linearOAuthService";
import type { createLinearIssueTracker } from "../../../../desktop/src/main/services/cto/linearIssueTracker";
import type { createComputerUseArtifactBrokerService } from "../../../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import type { createProjectConfigService } from "../../../../desktop/src/main/services/config/projectConfigService";
import type { createOperationService } from "../../../../desktop/src/main/services/history/operationService";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import type { createDiffService } from "../../../../desktop/src/main/services/diffs/diffService";
import type { createGitOperationsService } from "../../../../desktop/src/main/services/git/gitOperationsService";
import type { createGithubService } from "../../../../desktop/src/main/services/github/githubService";
import type { createConflictService } from "../../../../desktop/src/main/services/conflicts/conflictService";
import type { createLaneEnvironmentService } from "../../../../desktop/src/main/services/lanes/laneEnvironmentService";
import type { createLaneService } from "../../../../desktop/src/main/services/lanes/laneService";
import type { createLaneTemplateService } from "../../../../desktop/src/main/services/lanes/laneTemplateService";
import type { createAutoRebaseService } from "../../../../desktop/src/main/services/lanes/autoRebaseService";
import type { createPortAllocationService } from "../../../../desktop/src/main/services/lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../../../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { createOrchestrationService } from "../../../../desktop/src/main/services/orchestration/orchestrationService";
import type { createPrService } from "../../../../desktop/src/main/services/prs/prService";
import type { createPrSummaryService } from "../../../../desktop/src/main/services/prs/prSummaryService";
import type { createQueueLandingService } from "../../../../desktop/src/main/services/prs/queueLandingService";
import type { createPtyService } from "../../../../desktop/src/main/services/pty/ptyService";
import type { createSessionDeltaService } from "../../../../desktop/src/main/services/sessions/sessionDeltaService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { nowIso, safeJsonParse, sleep, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import { createDeviceRegistryService } from "./deviceRegistryService";
import {
  createSyncHostService,
  SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
  SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
  type SyncHostService,
  type SyncProjectCatalogProvider,
  type SyncRosterProvider,
  type SyncForeignChatTranscriptResolver,
  type SyncRuntimeKind,
} from "./syncHostService";
import { createSyncPairingStore } from "./syncPairingStore";
import { isValidDpopPublicKey } from "./syncPairingStore";
import { createSyncSecurityStore } from "./syncSecurityStore";
import { createSyncCloudRelayStore, type SyncCloudRelayStore } from "./syncCloudRelayStore";
import { createSyncPeerService } from "./syncPeerService";
import { createSyncPinStore } from "./syncPinStore";
import { createSyncRuntimeNameStore } from "./syncRuntimeNameStore";
import { DEFAULT_SYNC_HOST_PORT, SYNC_HOST_MAX_PORT } from "./syncProtocol";
import { createSyncRemoteCommandService, type ExternalSessionsRemoteService, type SyncRemoteCommandService } from "./syncRemoteCommandService";
import {
  buildAddressCandidates,
  buildPairingConnectInfo,
  tailscaleDnsNameFromDevice,
} from "./syncPairingConnectInfo";
import type { PushPublisherService } from "../push/pushPublisherService";
import { acquireSyncHostSingleton, type SyncHostSingletonLease } from "./syncHostSingleton";
import type { SharedSyncListener } from "./sharedSyncListener";
import type { ModelPickerStore } from "../modelPickerStore";
import type { createUsageTrackingService } from "../../../../desktop/src/main/services/usage/usageTrackingService";
import type { ProductAnalyticsService } from "../../../../desktop/src/main/services/analytics/productAnalyticsService";
import type { AccountAuthService } from "../account/accountAuthService";
import {
  getSharedAccountAttestationConfig,
  getSharedAccountAuthService,
  type AccountAttestationConfig,
} from "../account/sharedAccountAuthService";
import type { SyncTunnelClientService } from "./syncTunnelClientService";
import {
  isLoopbackShadowedError,
  type SyncLoopbackProbeResult,
  type SyncLoopbackValidationStatus,
} from "./syncLoopbackProbe";

type SyncServiceArgs = {
  db: AdeDb;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  productAnalyticsService?: ProductAnalyticsService | null;
  logger: Logger;
  getAccountDirectoryHealth?: () => SyncAccountDirectoryHealth;
  requestAccountMachinePublish?: () => void | Promise<void>;
  accountAuthService?: Pick<AccountAuthService, "getStatus" | "getAccessToken">;
  getAccountAttestationConfig?: () => AccountAttestationConfig;
  projectId?: string | null;
  runtimeProjectId?: string | null;
  projectRoot: string;
  appVersion?: string;
  runtimeKind?: SyncRuntimeKind;
  localDeviceIdPath?: string;
  phonePairingStateDir?: string;
  fileService: ReturnType<typeof createFileService>;
  laneService: ReturnType<typeof createLaneService>;
  gitService?: ReturnType<typeof createGitOperationsService>;
  diffService?: ReturnType<typeof createDiffService>;
  conflictService?: ReturnType<typeof createConflictService>;
  operationService?: ReturnType<typeof createOperationService> | null;
  githubService?: ReturnType<typeof createGithubService> | null;
  prService: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
  ptyService: ReturnType<typeof createPtyService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  orchestrationService?: ReturnType<typeof createOrchestrationService> | null;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  portAllocationService?: ReturnType<typeof createPortAllocationService>;
  laneEnvironmentService?: ReturnType<typeof createLaneEnvironmentService>;
  laneTemplateService?: ReturnType<typeof createLaneTemplateService>;
  rebaseSuggestionService?: ReturnType<
    typeof createRebaseSuggestionService
  > | null;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
  computerUseArtifactBrokerService: ReturnType<
    typeof createComputerUseArtifactBrokerService
  >;
  agentChatService: ReturnType<typeof createAgentChatService>;
  personalChatScope?: PersonalChatScopeContract;
  /** Brain→push-relay publisher; threaded to the runtime remote-command service. */
  pushPublisherService?: PushPublisherService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  ctoMemoryService?: CtoMemoryService | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearOAuthService?: ReturnType<typeof createLinearOAuthService> | null;
  /**
   * Resolvers for services that are constructed AFTER createSyncService in
   * main.ts. Using lazy getters lets the sync router forward remote commands
   * to them without requiring a specific init order.
   */
  getLinearIssueTracker?: () => ReturnType<typeof createLinearIssueTracker> | null;
  getExternalSessionsService?: () => ExternalSessionsRemoteService | null;
  /**
   * Brain-level websocket listener shared across hosted-project switches.
   * When provided, the embedded sync host attaches to it instead of binding
   * its own WebSocketServer, so connected phones survive host swaps. The
   * listener's lifecycle is owned by the caller (closed on brain shutdown).
   */
  sharedSyncListener?: SharedSyncListener | null;
  hostStartupEnabled?: boolean;
  hostDiscoveryEnabled?: boolean;
  /**
   * Phone sync is hosted by the local ADE service. When enabled, legacy
   * machine-to-machine viewer state stored in a project DB cannot demote the
   * phone sync surface into viewer mode.
   */
  forceHostRole?: boolean;
  onStatusChanged?: (snapshot: SyncRoleSnapshot) => void;
  /**
   * Shared cloud-relay config store. The daemon passes the machine-level
   * instance it also hands to the tunnel client so both read one file; when
   * absent a store is created under the pairing state dir.
   */
  cloudRelayStore?: SyncCloudRelayStore;
  syncTunnelClientService?: Pick<SyncTunnelClientService, "getStatus">
    & Partial<Pick<SyncTunnelClientService, "runSelfProbe">>
    | null;
  projectCatalogProvider?: SyncProjectCatalogProvider;
  rosterProvider?: SyncRosterProvider;
  foreignChatProvider?: SyncForeignChatTranscriptResolver;
  remoteCommandExecutor?: Pick<SyncRemoteCommandService, "execute">;
  /**
   * Lazy accessor for the model picker store. iOS uses the `modelPicker.*`
   * sync commands to share favorites + recents with desktop and the TUI; the
   * store is backed by the per-project cr-sqlite DB (`db`) so all surfaces
   * converge for a project via CRR replication. Optional — the remote command
   * service falls back to the per-db shared store built from `db` when unset.
   */
  getModelPickerStore?: () => ModelPickerStore | null;
  /**
   * Optional handler for the iOS Send-to-Mac deeplink bounce. Wired up by
   * desktop main.ts; the ade-cli runtime context leaves it unset and the
   * `deeplinks.open` sync command reports unavailable.
   */
  dispatchDeeplinkUrl?: (url: string) => Promise<{ ok: boolean; message?: string }>;
  /** Test seam for self-owned host startup; production uses the HTTP 426 probe. */
  loopbackProbe?: (port: number, expectedNonce: string) => Promise<SyncLoopbackProbeResult>;
};

const DRAFT_FILE = "sync-peer-draft.json";
const TOKEN_FILE = "sync-bootstrap-token";
const PIN_FILE = "sync-pin.json";
const PAIRED_DEVICES_FILE = "sync-paired-devices.json";
const RUNTIME_NAME_FILE = "sync-runtime-name.json";
const SECURITY_FILE = "sync-security.json";
const CLOUD_RELAY_FILE = "sync-cloud-relay.json";

const SSH_PAIRING_PROTOCOL_VERSION = 1 as const;
const SSH_PAIRING_MAX_CAPABILITIES = 32;
const SSH_PAIRING_MAX_TEXT_LENGTH = 256;

type SshPairingDeviceInput = {
  id: string;
  name: string;
  platform: SyncPeerPlatform;
  type: SyncPeerDeviceType;
  siteId?: string;
  dpopPublicKey: string;
  capabilities?: string[];
  appVersion?: string;
  appBuild?: string;
  bundleIdentifier?: string;
};

export type SshPairingRequest = {
  version: typeof SSH_PAIRING_PROTOCOL_VERSION;
  device: SshPairingDeviceInput;
};

function requiredSshPairingText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > SSH_PAIRING_MAX_TEXT_LENGTH) {
    throw new Error(`${label} must be ${SSH_PAIRING_MAX_TEXT_LENGTH} characters or fewer.`);
  }
  return normalized;
}

function optionalSshPairingText(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  return requiredSshPairingText(value, label);
}

function parseSshPairingRequest(value: unknown): SshPairingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SSH pairing request must be a JSON object.");
  }
  const request = value as Record<string, unknown>;
  if (request.version !== SSH_PAIRING_PROTOCOL_VERSION) {
    throw new Error(`Unsupported SSH pairing protocol version: ${String(request.version)}.`);
  }
  if (!request.device || typeof request.device !== "object" || Array.isArray(request.device)) {
    throw new Error("device must be a JSON object.");
  }
  const device = request.device as Record<string, unknown>;
  const platform = requiredSshPairingText(device.platform, "device.platform") as SyncPeerPlatform;
  if (!["macOS", "linux", "windows", "iOS", "unknown"].includes(platform)) {
    throw new Error("device.platform is not supported.");
  }
  const type = requiredSshPairingText(device.type, "device.type") as SyncPeerDeviceType;
  if (!["desktop", "phone", "vps", "browser", "unknown"].includes(type)) {
    throw new Error("device.type is not supported.");
  }
  const dpopPublicKey = requiredSshPairingText(device.dpopPublicKey, "device.dpopPublicKey");
  if (!isValidDpopPublicKey(dpopPublicKey)) {
    throw new Error("device.dpopPublicKey must be a base64 X9.63 P-256 public key.");
  }
  const capabilities = device.capabilities == null
    ? undefined
    : Array.isArray(device.capabilities)
      ? [...new Set(device.capabilities.map((entry, index) => (
          requiredSshPairingText(entry, `device.capabilities[${index}]`)
        )))]
      : null;
  if (capabilities === null) throw new Error("device.capabilities must be an array of strings.");
  if (capabilities && capabilities.length > SSH_PAIRING_MAX_CAPABILITIES) {
    throw new Error(`device.capabilities supports at most ${SSH_PAIRING_MAX_CAPABILITIES} entries.`);
  }
  return {
    version: SSH_PAIRING_PROTOCOL_VERSION,
    device: {
      id: requiredSshPairingText(device.id, "device.id"),
      name: requiredSshPairingText(device.name, "device.name"),
      platform,
      type,
      siteId: optionalSshPairingText(device.siteId, "device.siteId"),
      dpopPublicKey,
      capabilities,
      appVersion: optionalSshPairingText(device.appVersion, "device.appVersion"),
      appBuild: optionalSshPairingText(device.appBuild, "device.appBuild"),
      bundleIdentifier: optionalSshPairingText(device.bundleIdentifier, "device.bundleIdentifier"),
    },
  };
}

function readPairingRecords(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function migrateLegacySyncSecretFile(args: {
  legacyPath: string;
  appPath: string;
  logger: Logger;
  label: string;
}): void {
  if (args.legacyPath === args.appPath) return;
  if (!fs.existsSync(args.legacyPath)) return;
  if (args.label === PAIRED_DEVICES_FILE && fs.existsSync(args.appPath)) {
    const merged = readPairingRecords(args.appPath);
    const legacy = readPairingRecords(args.legacyPath);
    let changed = false;
    for (const [deviceId, record] of Object.entries(legacy)) {
      if (!deviceId.trim() || Object.prototype.hasOwnProperty.call(merged, deviceId)) continue;
      merged[deviceId] = record;
      changed = true;
    }
    if (!changed) return;
    try {
      fs.mkdirSync(path.dirname(args.appPath), { recursive: true });
      fs.writeFileSync(args.appPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      args.logger.info("sync.app_pairing_state_merged", {
        label: args.label,
        legacyPath: args.legacyPath,
        appPath: args.appPath,
      });
    } catch (error) {
      args.logger.warn("sync.app_pairing_state_migration_failed", {
        label: args.label,
        legacyPath: args.legacyPath,
        appPath: args.appPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (fs.existsSync(args.appPath)) return;
  try {
    fs.mkdirSync(path.dirname(args.appPath), { recursive: true });
    fs.copyFileSync(args.legacyPath, args.appPath, fs.constants.COPYFILE_EXCL);
    args.logger.info("sync.app_pairing_state_migrated", {
      label: args.label,
      legacyPath: args.legacyPath,
      appPath: args.appPath,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === "EEXIST") return;
    args.logger.warn("sync.app_pairing_state_migration_failed", {
      label: args.label,
      legacyPath: args.legacyPath,
      appPath: args.appPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
function isChatToolType(toolType: string | null | undefined): boolean {
  const normalized = toolType?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "cursor" || normalized.endsWith("-chat");
}
const LEGACY_SYNC_HOST_PORT_RETRY_WINDOW = 13;
const LEGACY_SYNC_HOST_MAX_PORT = DEFAULT_SYNC_HOST_PORT + LEGACY_SYNC_HOST_PORT_RETRY_WINDOW;
const LOCAL_LANE_PRESENCE_HEARTBEAT_MS = 30_000;
const TRANSFER_READINESS_CACHE_MS = 15_000;
const STALE_BRAIN_LAST_SEEN_MS = 5 * 60_000;
const VIEWER_DRAFT_TRANSPORT_ERROR_CODES = [
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
] as const;
const VIEWER_DRAFT_TRANSPORT_ERROR_CODE_SET = new Set<string>(
  VIEWER_DRAFT_TRANSPORT_ERROR_CODES,
);
const VIEWER_DRAFT_TRANSPORT_ERROR_PATTERN = new RegExp(
  `\\b(?:${VIEWER_DRAFT_TRANSPORT_ERROR_CODES.join("|")})\\b`,
  "i",
);

function generatePairingPin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function buildSkippedTransferReadiness(): SyncTransferReadiness {
  return {
    ready: false,
    blockers: [],
    survivableState: [
      "Transfer readiness was skipped for this lightweight sync status request.",
    ],
  };
}

function sanitizeDraft(
  raw: unknown,
  token: string | null,
): SyncDesktopConnectionDraft | null {
  if (!raw || typeof raw !== "object" || !token) return null;
  const row = raw as Record<string, unknown>;
  const host = typeof row.host === "string" ? row.host.trim() : "";
  const port = Number(row.port ?? 0);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return {
    host,
    port: Math.floor(port),
    token,
    authKind: row.authKind === "paired" ? "paired" : "bootstrap",
    pairedDeviceId:
      typeof row.pairedDeviceId === "string" ? row.pairedDeviceId : null,
    lastRemoteDbVersion: Number.isFinite(row.lastRemoteDbVersion)
      ? Number(row.lastRemoteDbVersion)
      : 0,
  };
}

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const normalized = host.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeHostKey(host: string | null | undefined): string | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  return normalized.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isDraftTargetLocalDevice(
  draft: SyncDesktopConnectionDraft,
  localDevice: SyncRoleSnapshot["localDevice"],
): boolean {
  const draftHost = normalizeHostKey(draft.host);
  if (!draftHost) return false;
  const localHosts = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  for (const host of localDevice.ipAddresses) {
    const key = normalizeHostKey(host);
    if (key) localHosts.add(key);
  }
  for (const host of [
    localDevice.tailscaleIp,
    tailscaleDnsNameFromDevice(localDevice),
    typeof localDevice.metadata?.hostname === "string" ? localDevice.metadata.hostname : null,
  ]) {
    const key = normalizeHostKey(host);
    if (key) localHosts.add(key);
  }
  return localHosts.has(draftHost);
}

function isViewerDraftTransportError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && VIEWER_DRAFT_TRANSPORT_ERROR_CODE_SET.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return VIEWER_DRAFT_TRANSPORT_ERROR_PATTERN.test(message);
}

function isRetryableHostBindError(error: unknown): boolean {
  if (isLoopbackShadowedError(error)) return true;
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? "";
  return code === "EADDRINUSE" || code === "EACCES";
}

// How long to insist on the preferred port before drifting: 8 × 400ms ≈ 3.2s,
// enough for a disposing listener (or a sibling host being replaced) to free
// the port that paired phones have saved.
const PREFERRED_PORT_BIND_ATTEMPTS = 8;
const PREFERRED_PORT_BIND_RETRY_DELAY_MS = 400;

function createInactiveTailnetDiscoveryStatus(
  error: string,
): SyncTailnetDiscoveryStatus {
  return {
    state: "disabled",
    serviceName: SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
    servicePort: SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
    target: null,
    updatedAt: null,
    error,
    stderr: null,
  };
}

function buildHostPortCandidates(preferredPort: number | null | undefined): number[] {
  const parsedPreferred = Number.isFinite(preferredPort)
    ? Math.max(1, Math.min(65_535, Math.floor(Number(preferredPort))))
    : DEFAULT_SYNC_HOST_PORT;
  const preferred = parsedPreferred || DEFAULT_SYNC_HOST_PORT;
  const preferredIsLegacyReachable = preferred >= DEFAULT_SYNC_HOST_PORT
    && preferred <= LEGACY_SYNC_HOST_MAX_PORT;
  const candidates: number[] = [];
  const seen = new Set<number>();
  const add = (port: number) => {
    const normalized = Math.max(0, Math.min(65_535, Math.floor(port)));
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };
  if (preferredIsLegacyReachable) {
    add(preferred);
  } else {
    add(DEFAULT_SYNC_HOST_PORT);
  }
  for (let port = DEFAULT_SYNC_HOST_PORT; port <= SYNC_HOST_MAX_PORT; port += 1) {
    add(port);
  }
  return candidates;
}

export function createSyncService(args: SyncServiceArgs) {
  const layout = resolveAdeLayout(args.projectRoot);
  const pairingStateDir = args.phonePairingStateDir ?? layout.secretsDir;
  const draftPath = path.join(pairingStateDir, DRAFT_FILE);
  const tokenPath = path.join(pairingStateDir, TOKEN_FILE);
  const pinPath = path.join(pairingStateDir, PIN_FILE);
  const runtimeNamePath = path.join(pairingStateDir, RUNTIME_NAME_FILE);
  const pairingSecretsPath = path.join(pairingStateDir, PAIRED_DEVICES_FILE);
  migrateLegacySyncSecretFile({
    legacyPath: path.join(layout.secretsDir, DRAFT_FILE),
    appPath: draftPath,
    logger: args.logger,
    label: DRAFT_FILE,
  });
  migrateLegacySyncSecretFile({
    legacyPath: path.join(layout.secretsDir, TOKEN_FILE),
    appPath: tokenPath,
    logger: args.logger,
    label: TOKEN_FILE,
  });
  migrateLegacySyncSecretFile({
    legacyPath: path.join(layout.secretsDir, PIN_FILE),
    appPath: pinPath,
    logger: args.logger,
    label: PIN_FILE,
  });
  migrateLegacySyncSecretFile({
    legacyPath: path.join(layout.secretsDir, PAIRED_DEVICES_FILE),
    appPath: pairingSecretsPath,
    logger: args.logger,
    label: PAIRED_DEVICES_FILE,
  });
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });

  const pinStore = createSyncPinStore({ filePath: pinPath });
  const runtimeNameStore = createSyncRuntimeNameStore({ filePath: runtimeNamePath });
  const pairingStore = createSyncPairingStore({
    filePath: pairingSecretsPath,
    pinStore,
  });
  const securityStore = createSyncSecurityStore({
    filePath: path.join(pairingStateDir, SECURITY_FILE),
  });
  const cloudRelayStore = args.cloudRelayStore ?? createSyncCloudRelayStore({
    filePath: path.join(pairingStateDir, CLOUD_RELAY_FILE),
  });
  const accountAuthService = args.accountAuthService ?? getSharedAccountAuthService({
    projectRoots: () => [args.projectRoot],
    logger: args.logger,
  });
  const isRelayAccountSignedIn = (): boolean => {
    const status = accountAuthService.getStatus();
    return status.signedIn && Boolean(status.userId?.trim());
  };
  // Governs whether this runtime ADVERTISES a relay URL to phones (pairing
  // connect info, brain_status, hello_ok). A suppressed tunnel has deliberately
  // stopped dialing because another ADE process owns this machine's relay slot,
  // so continuing to hand out the URL points phones at a route that can only
  // fail — and a phone that already saved it never purges the candidate,
  // because the purge is driven by an explicitly null cloudRelayWssUrl.
  //
  // Route health deliberately does NOT use this: `ade doctor` and the desktop
  // banner must still report relay as enabled-but-suppressed rather than
  // silently "disabled", which is how this whole failure stayed invisible.
  const isCloudRelayUsable = (): boolean =>
    isRelayAccountSignedIn()
    && (args.syncTunnelClientService?.getStatus().accountLeaseValid ?? true)
    && args.syncTunnelClientService?.getStatus().controlSuppressed !== true;

  const deviceRegistryService = createDeviceRegistryService({
    db: args.db,
    logger: args.logger,
    projectRoot: args.projectRoot,
    localDeviceIdPath: args.localDeviceIdPath,
  });

  let hostService: SyncHostService | null = null;
  let hostSingletonLease: SyncHostSingletonLease | null = null;
  let listenerValidationHistory: Pick<SyncLoopbackValidationStatus, "lastFailureAt" | "lastSuccessAt"> = {
    lastFailureAt: null,
    lastSuccessAt: null,
  };
  let refreshQueued = false;
  let refreshPromise: Promise<void> | null = null;
  let disposed = false;
  // Mobile project switch can fire `sync.initialize` as a background task and
  // then immediately await `service.initialize()` from the dialog handler.
  // Coalesce concurrent calls so the second await rides the first promise
  // rather than re-running ensureLocalDevice/refreshRoleState in parallel.
  let initializingPromise: Promise<void> | null = null;
  let initialized = false;
  let hostStartupEnabled = args.hostStartupEnabled !== false;
  let hostDiscoveryEnabled = args.hostDiscoveryEnabled !== false;
  let transferReadinessCache: { value: SyncTransferReadiness; expiresAtMs: number } | null = null;
  let transferReadinessInFlight: Promise<SyncTransferReadiness> | null = null;
  const forceHostRole = args.forceHostRole === true;
  const isCrdtSyncAvailable = (): boolean => args.db.sync.isAvailable?.() !== false;
  const assertPhonePairingAvailable = (): void => {
    if (!hostStartupEnabled) {
      throw new Error(
        "Phone pairing is unavailable because the sync host is disabled for this ADE process.",
      );
    }
    if (!isCrdtSyncAvailable()) {
      throw new Error(
        "Phone pairing is unavailable because the CRDT database extension is unavailable on this platform.",
      );
    }
  };
  let activeLocalLanePresenceIds: string[] = [];
  const localLanePresenceHeartbeatTimer = setInterval(() => {
    if (disposed || !hostService || activeLocalLanePresenceIds.length === 0) return;
    hostService.setLocalActiveLanePresence?.(activeLocalLanePresenceIds);
  }, LOCAL_LANE_PRESENCE_HEARTBEAT_MS);

  const readToken = (): string | null => {
    if (!fs.existsSync(tokenPath)) return null;
    const value = fs.readFileSync(tokenPath, "utf8").trim();
    return value.length > 0 ? value : null;
  };

  const writeToken = (token: string): void => {
    writeTextAtomic(tokenPath, `${token.trim()}\n`);
  };

  const readSavedDraft = (): SyncDesktopConnectionDraft | null => {
    if (forceHostRole) return null;
    if (!fs.existsSync(draftPath)) return null;
    const token = readToken();
    return sanitizeDraft(
      safeJsonParse(fs.readFileSync(draftPath, "utf8"), null),
      token,
    );
  };

  const writeSavedDraft = (draft: SyncDesktopConnectionDraft | null): void => {
    if (!draft) {
      try {
        fs.rmSync(draftPath, { force: true });
      } catch {
        // ignore
      }
      return;
    }
    writeToken(draft.token);
    writeTextAtomic(
      draftPath,
      `${JSON.stringify(
        {
          host: draft.host,
          port: draft.port,
          authKind: draft.authKind ?? "bootstrap",
          pairedDeviceId: draft.pairedDeviceId ?? null,
          lastRemoteDbVersion: draft.lastRemoteDbVersion ?? 0,
        },
        null,
        2,
      )}\n`,
    );
  };

  const syncPeerService = createSyncPeerService({
    db: args.db,
    logger: args.logger,
    deviceRegistryService,
    onStatusChange: (status) => {
      if (forceHostRole) return;
      if (status.savedDraft) {
        const token = readToken();
        if (token) {
          writeSavedDraft({
            host: status.savedDraft.host,
            port: status.savedDraft.port,
            token,
            authKind: status.savedDraft.authKind ?? "bootstrap",
            pairedDeviceId: status.savedDraft.pairedDeviceId ?? null,
            lastRemoteDbVersion: status.savedDraft.lastRemoteDbVersion ?? 0,
          });
        }
      }
      void emitStatus();
    },
    onBrainStatus: (payload) => {
      deviceRegistryService.applyBrainStatus(payload);
      void emitStatus();
    },
    onRemoteChangesApplied: () => {
      void refreshRoleState();
    },
  });

  const buildCurrentPairingConnectInfo = (): SyncPairingConnectInfo => {
    const activeHostPort = hostService?.getPort() ?? args.sharedSyncListener?.getPort() ?? null;
    let localDevice = deviceRegistryService.ensureLocalDevice();
    if (activeHostPort != null && localDevice.lastPort !== activeHostPort) {
      localDevice = deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastHost: localDevice.ipAddresses[0] ?? localDevice.tailscaleIp ?? localDevice.lastHost,
        lastPort: activeHostPort,
      });
    }
    return buildPairingConnectInfo({
      localDevice,
      relayWssUrl: isCloudRelayUsable() ? cloudRelayStore.getRelayWssUrl() : null,
    });
  };

  const remoteCommandService = createSyncRemoteCommandService({
    db: args.db,
    usageTrackingService: args.usageTrackingService,
    productAnalyticsService: args.productAnalyticsService,
    projectRoot: args.projectRoot,
    laneService: args.laneService,
    prService: args.prService,
    prSummaryService: args.prSummaryService,
    queueLandingService: args.queueLandingService,
    ptyService: args.ptyService,
    sessionService: args.sessionService,
    sessionDeltaService: args.sessionDeltaService,
    fileService: args.fileService,
    gitService: args.gitService,
    githubService: args.githubService,
    diffService: args.diffService,
    conflictService: args.conflictService,
    operationService: args.operationService,
    aiIntegrationService: args.aiIntegrationService,
    agentChatService: args.agentChatService,
    personalChatScope: args.personalChatScope,
    orchestrationService: args.orchestrationService,
    pushPublisherService: args.pushPublisherService,
    ctoStateService: args.ctoStateService,
    ctoMemoryService: args.ctoMemoryService,
    linearCredentialService: args.linearCredentialService,
    linearOAuthService: args.linearOAuthService,
    getLinearIssueTracker: args.getLinearIssueTracker,
    getExternalSessionsService: args.getExternalSessionsService,
    projectConfigService: args.projectConfigService,
    portAllocationService: args.portAllocationService,
    laneEnvironmentService: args.laneEnvironmentService,
    laneTemplateService: args.laneTemplateService,
    rebaseSuggestionService: args.rebaseSuggestionService ?? undefined,
    autoRebaseService: args.autoRebaseService ?? undefined,
    // Late-bound: the host service starts after this command service exists.
    getLanePresenceStamp: () => hostService?.getLanePresenceStamp() ?? "",
    getModelPickerStore: args.getModelPickerStore,
    dispatchDeeplinkUrl: args.dispatchDeeplinkUrl,
    syncPinStore: pinStore,
    getPairingConnectInfo: buildCurrentPairingConnectInfo,
    issueRuntimeHostPairingGrant: () => pairingStore.issueRuntimeHostGrant(),
    isCloudRelayEnabled: isCloudRelayUsable,
    logger: args.logger,
  });

  const emitStatus = async (): Promise<void> => {
    if (disposed) return;
    args.onStatusChanged?.(await service.getStatus());
  };

  const releaseHostSingletonLease = (): void => {
    const lease = hostSingletonLease;
    hostSingletonLease = null;
    lease?.dispose();
  };

  const startHostIfNeeded = async (): Promise<void> => {
    if (!hostStartupEnabled || !isCrdtSyncAvailable()) {
      if (hostService) {
        await stopHostIfRunning();
      } else {
        releaseHostSingletonLease();
      }
      const currentLocalDevice = deviceRegistryService.ensureLocalDevice();
      deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastHost: currentLocalDevice.ipAddresses[0] ?? currentLocalDevice.tailscaleIp ?? currentLocalDevice.lastHost,
      });
      return;
    }
    if (hostService) {
      const currentLocalDevice = deviceRegistryService.ensureLocalDevice();
      deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastHost: currentLocalDevice.ipAddresses[0] ?? currentLocalDevice.tailscaleIp ?? currentLocalDevice.lastHost,
        lastPort: hostService.getPort(),
      });
      hostService.refreshLanDiscovery?.();
      return;
    }
    const localDevice = deviceRegistryService.ensureLocalDevice();
    const preferredPort = localDevice.lastPort ?? DEFAULT_SYNC_HOST_PORT;
    let lastError: unknown = null;
    hostSingletonLease ??= acquireSyncHostSingleton({ projectRoot: args.projectRoot });
    const buildHostServiceArgs = (port: number): Parameters<typeof createSyncHostService>[0] => ({
      db: args.db,
      logger: args.logger,
      projectId: args.projectId ?? null,
      projectIdAliases: args.runtimeProjectId && args.runtimeProjectId !== args.projectId
        ? [args.runtimeProjectId]
        : [],
      projectRoot: args.projectRoot,
      fileService: args.fileService,
      laneService: args.laneService,
      gitService: args.gitService,
      githubService: args.githubService,
      diffService: args.diffService,
      conflictService: args.conflictService,
      operationService: args.operationService,
      prService: args.prService,
      prSummaryService: args.prSummaryService,
      queueLandingService: args.queueLandingService,
      sessionService: args.sessionService,
      sessionDeltaService: args.sessionDeltaService,
      ptyService: args.ptyService,
      agentChatService: args.agentChatService,
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
      rebaseSuggestionService: args.rebaseSuggestionService ?? undefined,
      autoRebaseService: args.autoRebaseService ?? undefined,
      dispatchDeeplinkUrl: args.dispatchDeeplinkUrl,
      computerUseArtifactBrokerService: args.computerUseArtifactBrokerService,
      pinStore,
      accountAuthService,
      getAccountAttestationConfig: args.getAccountAttestationConfig ?? (() =>
        getSharedAccountAttestationConfig({ projectRoots: () => [args.projectRoot] })),
      runtimeNameStore,
      bootstrapTokenPath: tokenPath,
      pairingSecretsPath,
      port,
      discoveryEnabled: hostDiscoveryEnabled,
      runtimeKind: args.runtimeKind ?? "desktop-embedded",
      runtimeVersion: args.appVersion ?? "",
      deviceRegistryService,
      projectCatalogProvider: args.projectCatalogProvider,
      rosterProvider: args.rosterProvider,
      foreignChatProvider: args.foreignChatProvider,
      personalChatScope: args.personalChatScope,
      remoteCommandService,
      remoteCommandExecutor: args.remoteCommandExecutor,
      productAnalyticsService: args.productAnalyticsService,
      requireDpop: () => securityStore.getRequireDpop(),
      getCloudRelayWssUrl: () =>
        isCloudRelayUsable() ? cloudRelayStore.getRelayWssUrl() : null,
      loopbackProbe: args.loopbackProbe,
      onStateChanged: () => {
        void refreshRoleState();
      },
    });
    const finishHostStartup = (started: SyncHostService, resolvedPort: number): void => {
      const validation = started.getLoopbackValidationStatus();
      listenerValidationHistory = {
        lastFailureAt: validation.lastFailureAt ?? listenerValidationHistory.lastFailureAt,
        lastSuccessAt: validation.lastSuccessAt ?? listenerValidationHistory.lastSuccessAt,
      };
      hostService = started;
      hostSingletonLease?.updatePort(resolvedPort);
      hostService.setLocalActiveLanePresence?.(activeLocalLanePresenceIds);
      deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastHost: localDevice.ipAddresses[0] ?? localDevice.tailscaleIp ?? localDevice.lastHost,
        lastPort: resolvedPort,
      });
      if (localDevice.lastPort != null && localDevice.lastPort !== resolvedPort) {
        args.logger.warn("sync_listener.port_drifted", {
          from: localDevice.lastPort,
          to: resolvedPort,
        });
        void args.requestAccountMachinePublish?.();
      }
    };
    try {
      const portCandidates = buildHostPortCandidates(preferredPort);
      if (args.sharedSyncListener) {
        // The brain-level shared listener binds once and is handed between
        // host services on project switches, so connected phones never see a
        // disconnect. ensureListening is idempotent: the first start binds a
        // candidate port, every later start reuses it.
        const listenerPort = await args.sharedSyncListener.ensureListening(portCandidates);
        const candidateHostService = createSyncHostService({
          ...buildHostServiceArgs(listenerPort),
          sharedListener: args.sharedSyncListener,
        });
        try {
          const resolvedPort = await candidateHostService.waitUntilListening();
          finishHostStartup(candidateHostService, resolvedPort);
          return;
        } catch (error) {
          await candidateHostService.dispose().catch(() => {});
          throw error;
        }
      }
      // A host restart (project switch, role change) can race its own dying
      // listener: the old server's socket may briefly hold the preferred port
      // and a single EADDRINUSE would silently drift the host to port+1 —
      // stranding paired phones that saved the old port. Re-attempt the
      // preferred port for a few seconds before falling back to the scan.
      // The preferred (fixed) port is re-attempted so a dying listener can free
      // it. An ephemeral port (0) is ALSO re-attempted, but because each bind(0)
      // resolves a fresh OS-assigned port a loopback shadow on the first port is
      // escaped by re-binding. Both are bounded by PREFERRED_PORT_BIND_ATTEMPTS.
      const attemptPlan = portCandidates.flatMap((candidatePort, candidateIndex) =>
        candidateIndex === 0 || candidatePort === 0
          ? Array.from({ length: PREFERRED_PORT_BIND_ATTEMPTS }, () => candidatePort)
          : [candidatePort],
      );
      let previousAttemptedPort: number | null = null;
      // Tracks RESOLVED shadowed ports; the literal 0 is never added so an
      // ephemeral shadow does not short-circuit the remaining fresh-port binds.
      const shadowedPorts = new Set<number>();
      for (const attemptedPort of attemptPlan) {
        if (attemptedPort !== 0 && shadowedPorts.has(attemptedPort)) continue;
        // The retry delay lets a dying listener free a FIXED port; an ephemeral
        // re-bind gets a fresh port immediately, so skip the delay for port 0.
        if (previousAttemptedPort === attemptedPort && attemptedPort !== 0) {
          await new Promise((resolve) => setTimeout(resolve, PREFERRED_PORT_BIND_RETRY_DELAY_MS));
        }
        previousAttemptedPort = attemptedPort;
        const candidateHostService = createSyncHostService(buildHostServiceArgs(attemptedPort));
        try {
          const resolvedPort = await candidateHostService.waitUntilListening();
          finishHostStartup(candidateHostService, resolvedPort);
          return;
        } catch (error) {
          lastError = error;
          if (isLoopbackShadowedError(error)) {
            shadowedPorts.add(attemptedPort === 0 ? error.port : attemptedPort);
            listenerValidationHistory = {
              ...listenerValidationHistory,
              lastFailureAt: error.failedAt,
            };
          }
          await candidateHostService.dispose().catch(() => {});
          const retryable = isRetryableHostBindError(error)
            && (attemptedPort !== 0 || isLoopbackShadowedError(error));
          args.logger.warn(
            isLoopbackShadowedError(error)
              ? "sync.host_start_loopback_shadowed"
              : retryable ? "sync.host_start_port_conflict" : "sync.host_start_failed",
            {
              preferredPort,
              attemptedPort,
              error: error instanceof Error ? error.message : String(error),
              code: (error as NodeJS.ErrnoException | null | undefined)?.code ?? null,
            },
          );
          if (!retryable) {
            throw error;
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error("Unable to start the sync host.");
    } catch (error) {
      if (!hostService) releaseHostSingletonLease();
      throw error;
    }
  };

  const stopHostIfRunning = async (): Promise<void> => {
    if (!hostService) {
      releaseHostSingletonLease();
      return;
    }
    const current = hostService;
    hostService = null;
    try {
      await current.dispose();
    } finally {
      releaseHostSingletonLease();
    }
  };

  const resolveViewerDraftFromRegistry =
    (): SyncDesktopConnectionDraft | null => {
      if (forceHostRole) return null;
      const cluster = deviceRegistryService.getClusterState();
      const token = readToken();
      if (!cluster || !token) return null;
      const brain = deviceRegistryService.getDevice(cluster.brainDeviceId);
      const host =
        brain != null ? buildAddressCandidates(brain)[0]?.host ?? null : null;
      const port = brain?.lastPort ?? DEFAULT_SYNC_HOST_PORT;
      if (!host) return null;
      return {
        host,
        port,
        token,
        lastRemoteDbVersion:
          syncPeerService.getStatus().lastRemoteDbVersion ?? 0,
      };
    };

  const isStaleNonLocalBrainCluster = (
    cluster: NonNullable<ReturnType<typeof deviceRegistryService.getClusterState>>,
    localDeviceId: string,
  ): boolean => {
    if (cluster.brainDeviceId === localDeviceId) return false;
    const brain = deviceRegistryService.getDevice(cluster.brainDeviceId);
    if (!brain) return true;
    const lastSeenRaw = brain.lastSeenAt ?? brain.updatedAt;
    const lastSeenMs = Date.parse(lastSeenRaw);
    if (!Number.isFinite(lastSeenMs)) return true;
    return Date.now() - lastSeenMs > STALE_BRAIN_LAST_SEEN_MS;
  };

  const shouldReclaimStaleViewerDraft = (argsIn: {
    cluster: ReturnType<typeof deviceRegistryService.getClusterState>;
    localDevice: SyncRoleSnapshot["localDevice"];
    draft: SyncDesktopConnectionDraft;
    error: unknown;
  }): boolean => {
    if (!hostStartupEnabled || !isCrdtSyncAvailable()) return false;
    if (!isViewerDraftTransportError(argsIn.error)) return false;
    if (!isDraftTargetLocalDevice(argsIn.draft, argsIn.localDevice)) return false;
    return !argsIn.cluster || isStaleNonLocalBrainCluster(argsIn.cluster, argsIn.localDevice.deviceId);
  };

  const refreshRoleState = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    refreshQueued = true;
    if (refreshPromise) return refreshPromise;

    // Every caller joins the same drain promise. In particular, a host-start
    // request immediately followed by a rollback must not report the rollback
    // complete while the first role refresh is still starting the host.
    const work = Promise.resolve().then(async () => {
      try {
      do {
        refreshQueued = false;
        try {
          const savedDraft = readSavedDraft();
          syncPeerService.setSavedDraft(savedDraft);
          const localDevice = deviceRegistryService.ensureLocalDevice();
          let cluster = deviceRegistryService.getClusterState();
          if (forceHostRole) {
            if (!cluster || cluster.brainDeviceId !== localDevice.deviceId) {
              cluster = deviceRegistryService.setClusterState({
                brainDeviceId: localDevice.deviceId,
                brainEpoch: (cluster?.brainEpoch ?? 0) + 1,
                updatedByDeviceId: localDevice.deviceId,
              });
            }
          } else if (!savedDraft) {
            if (!cluster) {
              cluster = deviceRegistryService.bootstrapLocalBrainIfNeeded();
            } else if (isStaleNonLocalBrainCluster(cluster, localDevice.deviceId)) {
              deviceRegistryService.touchLocalDevice({
                lastSeenAt: nowIso(),
                lastHost: localDevice.lastHost,
                lastPort: localDevice.lastPort ?? DEFAULT_SYNC_HOST_PORT,
              });
              cluster = deviceRegistryService.setClusterState({
                brainDeviceId: localDevice.deviceId,
                brainEpoch: (cluster?.brainEpoch ?? 0) + 1,
                updatedByDeviceId: localDevice.deviceId,
              });
            }
          }
          const isLocalBrain = forceHostRole || (cluster
            ? cluster.brainDeviceId === localDevice.deviceId
            : !savedDraft);
          if (isLocalBrain) {
            if (syncPeerService.isConnected()) {
              syncPeerService.disconnect({ preserveDraft: true });
            }
            await startHostIfNeeded();
          } else {
            await stopHostIfRunning();
            if (!isCrdtSyncAvailable()) {
              if (syncPeerService.isConnected()) {
                syncPeerService.disconnect({ preserveDraft: true });
              }
              continue;
            }
            const draft = savedDraft ?? resolveViewerDraftFromRegistry();
            if (draft && !syncPeerService.isConnected()) {
              syncPeerService.setSavedDraft(draft);
              try {
                await syncPeerService.connect(draft);
                deviceRegistryService.touchLocalDevice({ lastSeenAt: nowIso() });
                syncPeerService.flushLocalChanges();
              } catch (error) {
                args.logger.warn("sync.role.viewer_connect_failed", {
                  error: error instanceof Error ? error.message : String(error),
                });
                if (shouldReclaimStaleViewerDraft({ cluster, localDevice, draft, error })) {
                  args.logger.warn("sync.role.viewer_stale_draft_reclaimed", {
                    host: draft.host,
                    port: draft.port,
                    previousBrainDeviceId: cluster?.brainDeviceId ?? null,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  writeSavedDraft(null);
                  syncPeerService.setSavedDraft(null);
                  deviceRegistryService.touchLocalDevice({
                    lastSeenAt: nowIso(),
                    lastHost: localDevice.lastHost,
                    lastPort: localDevice.lastPort ?? DEFAULT_SYNC_HOST_PORT,
                  });
                  cluster = deviceRegistryService.setClusterState({
                    brainDeviceId: localDevice.deviceId,
                    brainEpoch: (cluster?.brainEpoch ?? 0) + 1,
                    updatedByDeviceId: localDevice.deviceId,
                  });
                  await startHostIfNeeded();
                }
              }
            }
          }
        } finally {
          await emitStatus();
        }
      } while (refreshQueued && !disposed);
      } finally {
        if (refreshPromise === work) refreshPromise = null;
      }
    });
    refreshPromise = work;
    return work;
  };

  const listRuntimeDevices = async (): Promise<SyncDeviceRuntimeState[]> => {
    const devices = deviceRegistryService.listDevices();
    const cluster = deviceRegistryService.getClusterState();
    const currentBrainId = cluster?.brainDeviceId ?? null;
    const currentHostId = cluster?.hostDeviceId ?? currentBrainId;
    const peerStates = hostService
      ? hostService.getPeerStates()
      : (syncPeerService.getLatestBrainStatus()?.connectedPeers ?? []);
    const localDeviceId = deviceRegistryService.getLocalDeviceId();
    return devices.map((device) => {
      const peer =
        peerStates.find((entry) => entry.deviceId === device.deviceId) ?? null;
      const isLocal = device.deviceId === localDeviceId;
      return {
        ...device,
        isLocal,
        isBrain: device.deviceId === currentBrainId,
        isHost: device.deviceId === currentHostId,
        connectionState: isLocal ? "self" : peer ? "connected" : "disconnected",
        connectedAt: peer?.connectedAt ?? null,
        lastAppliedAt: peer?.lastAppliedAt ?? null,
        remoteAddress: peer?.remoteAddress ?? null,
        remotePort: peer?.remotePort ?? null,
        latencyMs: peer?.latencyMs ?? null,
        syncLag: peer?.syncLag ?? null,
      };
    });
  };

  const computeTransferReadiness = async (): Promise<SyncTransferReadiness> => {
    const blockers: SyncTransferBlocker[] = [];

    const chats = await args.agentChatService.listSessions(undefined, {
      includeIdentity: true,
      includeAutomation: true,
    });
    const chatSummaries = new Map(
      chats.map((chat) => [chat.sessionId, chat] as const),
    );

    for (const session of args.sessionService.list({
      status: "running",
      limit: 500,
    })) {
      if (isChatToolType(session.toolType)) {
        const chat = chatSummaries.get(session.id);
        if (chat && chat.status !== "active") {
          continue;
        }
        const isCto = chat?.identityKey === "cto";
        blockers.push({
          kind: "chat_runtime",
          id: session.id,
          label: chat?.title || (isCto ? "CTO thread" : session.title),
          detail: isCto
            ? "A running CTO turn must stop before handoff. CTO history and idle threads still transfer."
            : "Live chat sessions do not hot-transfer. Let the turn finish or interrupt it first.",
        });
        continue;
      }
      blockers.push({
        kind: "terminal_session",
        id: session.id,
        label: session.title,
        detail:
          "Running terminal sessions must stop before the host role can move.",
      });
    }

    return {
      ready: blockers.length === 0,
      blockers,
      survivableState: [
        "CTO history and idle threads remain available on the new host.",
        "Idle and ended agent chats remain available and resumable on the new host.",
      ],
    };
  };

  const getTransferReadiness = async (options?: { force?: boolean }): Promise<SyncTransferReadiness> => {
    const now = Date.now();
    if (!options?.force && transferReadinessCache && transferReadinessCache.expiresAtMs > now) {
      return transferReadinessCache.value;
    }
    // `force` should skip the cached value but still share the in-flight
    // promise — otherwise overlapping forced callers each spawn their own
    // computeTransferReadiness() run.
    if (transferReadinessInFlight) return transferReadinessInFlight;
    transferReadinessInFlight = computeTransferReadiness()
      .then((value) => {
        transferReadinessCache = {
          value,
          expiresAtMs: Date.now() + TRANSFER_READINESS_CACHE_MS,
        };
        return value;
      })
      .finally(() => {
        transferReadinessInFlight = null;
      });
    return transferReadinessInFlight;
  };

  const service = {
    async initialize(): Promise<void> {
      if (initialized) return;
      if (initializingPromise) return initializingPromise;
      initializingPromise = (async () => {
        deviceRegistryService.ensureLocalDevice();
        await refreshRoleState();
        initialized = true;
      })().finally(() => {
        initializingPromise = null;
      });
      return initializingPromise;
    },

    async getStatus(options?: SyncGetStatusArgs): Promise<SyncRoleSnapshot> {
      let localDevice = deviceRegistryService.ensureLocalDevice();
      const activeHostPort = hostService?.getPort() ?? null;
      if (activeHostPort != null && localDevice.lastPort !== activeHostPort) {
        localDevice = deviceRegistryService.touchLocalDevice({
          lastSeenAt: nowIso(),
          lastHost: localDevice.ipAddresses[0] ?? localDevice.tailscaleIp ?? localDevice.lastHost,
          lastPort: activeHostPort,
        });
      }
      const cluster = deviceRegistryService.getClusterState();
      const savedDraft = readSavedDraft();
      const rawCurrentBrain = cluster
        ? deviceRegistryService.getDevice(cluster.brainDeviceId)
        : localDevice;
      const currentBrain = rawCurrentBrain?.deviceId === localDevice.deviceId
        ? localDevice
        : rawCurrentBrain;
      const currentHostId = cluster?.hostDeviceId ?? cluster?.brainDeviceId ?? null;
      const rawCurrentHost = currentHostId
        ? deviceRegistryService.getDevice(currentHostId)
        : localDevice;
      const currentRuntime = rawCurrentHost?.deviceId === localDevice.deviceId
        ? localDevice
        : (rawCurrentHost ?? currentBrain);
      const isLocalBrain = forceHostRole || (cluster
        ? cluster.brainDeviceId === localDevice.deviceId
        : !savedDraft && !syncPeerService.isConnected());
      const role = isLocalBrain ? "brain" : "viewer";
      const runtimeRole = isLocalBrain ? "host" : "viewer";
      const crdtSyncAvailable = isCrdtSyncAvailable();
      const canHostPhonePairing = role === "brain" && hostStartupEnabled && crdtSyncAvailable;
      const client = syncPeerService.getStatus();
      const mode =
        role === "viewer"
          ? "viewer"
          : client.state === "connected"
            ? "brain"
            : "standalone";
      const runtimeMode =
        runtimeRole === "viewer"
          ? "viewer"
          : client.state === "connected"
            ? "host"
            : "standalone";
      const connectedPeers = (
        hostService
          ? hostService.getPeerStates()
          : (syncPeerService.getLatestBrainStatus()?.connectedPeers ?? [])
      ).map((peer) => ({
        ...peer,
        isHost: Boolean(peer.isHost ?? peer.isBrain),
      }));
      const tailnetDiscovery = canHostPhonePairing && hostService
        ? hostService.getTailnetDiscoveryStatus()
        : createInactiveTailnetDiscoveryStatus(
            canHostPhonePairing
              ? "Tailnet discovery is waiting for the ADE runtime to start."
              : "Tailnet discovery is only published by the host ADE runtime.",
          );
      const listenerPort = hostService?.getPort() ?? args.sharedSyncListener?.getPort() ?? null;
      const rawListenerValidation = hostService?.getLoopbackValidationStatus()
        ?? args.sharedSyncListener?.getLoopbackValidationStatus()
        ?? {
          port: null,
          loopbackAdeValidated: false,
          lastFailureAt: listenerValidationHistory.lastFailureAt,
          reason: "The ADE sync listener has not started.",
          lastSuccessAt: listenerValidationHistory.lastSuccessAt,
        };
      const listenerBound = listenerPort != null;
      const loopbackAdeValidated = listenerBound
        && rawListenerValidation.port === listenerPort
        && rawListenerValidation.loopbackAdeValidated;
      const listenerReason = !listenerBound
        ? "The ADE sync listener is not bound."
        : loopbackAdeValidated
          ? null
          : rawListenerValidation.reason
            ?? `127.0.0.1:${listenerPort} did not answer as ADE.`;
      const tunnelStatus = args.syncTunnelClientService?.getStatus() ?? null;
      const tailscalePublished = tailnetDiscovery.state === "published";
      const tailscaleEnabled = canHostPhonePairing
        && tailnetDiscovery.state !== "disabled"
        && tailnetDiscovery.state !== "unavailable";
      const tailscaleReachable = tailscalePublished && loopbackAdeValidated;
      const tailscaleReason = !tailscaleEnabled
        ? tailnetDiscovery.error
        : !loopbackAdeValidated
          ? `Tailscale route is unusable because ${listenerReason ?? "the loopback ADE check failed"}`
          : tailscalePublished
            ? null
            : tailnetDiscovery.error ?? `Tailscale Serve is ${tailnetDiscovery.state}.`;
      const relayConfigured = canHostPhonePairing;
      const relayAccountSignedIn = isRelayAccountSignedIn()
        && (tunnelStatus?.accountLeaseValid ?? true);
      const relayEnabled = relayConfigured && relayAccountSignedIn;
      const relayControlConnected = tunnelStatus?.connected === true;
      const relayBridgeValidated = tunnelStatus?.relayBridgeValidated === true;
      const relayReason = relayConfigured && !relayAccountSignedIn
        ? "Sign in to ADE to use ADE Relay."
        : !relayEnabled
        ? null
        : !loopbackAdeValidated
          ? `Relay route is unusable because ${listenerReason ?? "the loopback ADE check failed"}`
          : !tunnelStatus
            ? "Relay tunnel status is unavailable in this ADE process."
            : !relayControlConnected
              // A 4505 eviction is a machine-local ownership conflict, not a
              // network fault, and its reason is the only one that tells the
              // user what to actually do — so it outranks the raw close text.
              ? tunnelStatus.controlSuppressedReason
                ?? tunnelStatus.lastControlError
                ?? tunnelStatus.lastError
                ?? "Relay control is not connected."
              : !relayBridgeValidated
                ? tunnelStatus.lastError ?? `Relay bridge to 127.0.0.1:${listenerPort} has not been validated against the current sync port.`
                : tunnelStatus.bridgeOpenFailure ?? null;
      let accountDirectory: SyncAccountDirectoryHealth;
      try {
        accountDirectory = args.getAccountDirectoryHealth?.() ?? createSyncAccountDirectoryHealth(
          "sync_disabled",
          "Account-directory publishing is not enabled in this runtime.",
        );
      } catch {
        accountDirectory = createSyncAccountDirectoryHealth(
          "transport_error",
          "Account-directory publisher health is unavailable.",
        );
      }
      const relayRouteHealth = {
        enabled: relayEnabled,
        relayControlConnected,
        relayBridgeValidated,
        lastFailureAt: tunnelStatus?.lastFailureAt
          ?? (relayEnabled && relayReason ? rawListenerValidation.lastFailureAt : null),
        skipReason: relayReason,
        lastControlError: tunnelStatus?.lastControlError ?? null,
        lastControlOpenAt: tunnelStatus?.lastControlOpenAt ?? null,
        lastBridgeValidationAt: tunnelStatus?.lastBridgeValidationAt ?? null,
        relayEndToEndVerifiedAt: tunnelStatus?.relayEndToEndVerifiedAt ?? null,
        relayEndToEndFailure: tunnelStatus?.relayEndToEndFailure ?? null,
        relayEndToEndRoundTripMs: tunnelStatus?.relayEndToEndRoundTripMs ?? null,
        relayControlSuppressed: tunnelStatus?.controlSuppressed === true,
        relayControlSuppressedReason: tunnelStatus?.controlSuppressedReason ?? null,
        relayControlFailingSinceMs: tunnelStatus?.controlFailingSinceMs ?? null,
      };
      const routeHealth: SyncRouteHealth = {
        listener: {
          listenerBound,
          loopbackAdeValidated,
          port: listenerPort,
          lastFailureAt: rawListenerValidation.lastFailureAt ?? listenerValidationHistory.lastFailureAt,
          reason: listenerReason,
          lastSuccessAt: rawListenerValidation.lastSuccessAt ?? listenerValidationHistory.lastSuccessAt,
        },
        tailscale: {
          enabled: tailscaleEnabled,
          tailscalePublished,
          tailscaleReachable,
          lastFailureAt: tailscaleEnabled && !tailscaleReachable
            ? (tailnetDiscovery.state === "failed"
                ? tailnetDiscovery.updatedAt
                : rawListenerValidation.lastFailureAt)
            : null,
          reason: tailscaleReason,
          lastSuccessAt: tailscaleReachable ? tailnetDiscovery.updatedAt : null,
        },
        relay: relayRouteHealth,
        accountDirectory,
      };
      return {
        mode,
        role,
        runtimeMode,
        runtimeRole,
        localDevice,
        currentBrain,
        currentRuntime,
        clusterState: cluster,
        bootstrapToken:
          canHostPhonePairing ? readToken() : null,
        pairingPin: canHostPhonePairing ? pinStore.getPin() : null,
        pairingPinConfigured: canHostPhonePairing ? pinStore.hasPin() : false,
        runtimeName: runtimeNameStore.getRuntimeName(),
        pairingConnectInfo:
          canHostPhonePairing
            ? buildPairingConnectInfo({
                localDevice,
                relayWssUrl: isCloudRelayUsable() ? cloudRelayStore.getRelayWssUrl() : null,
              })
            : null,
        connectedPeers,
        tailnetDiscovery,
        routeHealth,
        client,
        transferReadiness: options?.includeTransferReadiness === false
          ? (transferReadinessCache?.value ?? buildSkippedTransferReadiness())
          : await getTransferReadiness({ force: options?.forceTransferReadiness === true }),
        survivableStateText:
          crdtSyncAvailable
            ? "Paused and idle state will remain available on the new host."
            : "Machine sync is disabled because the CRDT database extension is unavailable on this platform.",
        blockingStateText:
          crdtSyncAvailable
            ? "Live chats or terminals must stop first."
            : "Install Windows cr-sqlite support before pairing or syncing devices.",
      };
    },

    async listDevices(): Promise<SyncDeviceRuntimeState[]> {
      return await listRuntimeDevices();
    },

    async refreshDiscovery(): Promise<SyncRoleSnapshot> {
      hostService?.refreshLanDiscovery?.({ forceLan: true, forceTailnet: true });
      const snapshot = await this.getStatus();
      args.onStatusChanged?.(snapshot);
      return snapshot;
    },

    setHostDiscoveryEnabled(enabled: boolean): void {
      if (hostDiscoveryEnabled === enabled) return;
      hostDiscoveryEnabled = enabled;
      hostService?.setDiscoveryEnabled(enabled);
      void emitStatus();
    },

    async setHostStartupEnabled(enabled: boolean): Promise<void> {
      if (hostStartupEnabled === enabled) return;
      hostStartupEnabled = enabled;
      await refreshRoleState();
    },

    async updateLocalDevice(argsIn: {
      name?: string;
      deviceType?: "desktop" | "phone" | "vps" | "browser" | "unknown";
    }) {
      const updated = deviceRegistryService.updateLocalDevice(argsIn);
      hostService?.setLocalActiveLanePresence(activeLocalLanePresenceIds);
      await emitStatus();
      return updated;
    },

    async connectToBrain(
      draft: SyncDesktopConnectionDraft,
    ): Promise<SyncRoleSnapshot> {
      if (!isCrdtSyncAvailable()) {
        throw new Error("Machine sync is unavailable because the CRDT database extension is not loaded.");
      }
      await stopHostIfRunning();
      writeSavedDraft(draft);
      syncPeerService.setSavedDraft(draft);
      try {
        await syncPeerService.connect(draft);
        deviceRegistryService.clearClusterRegistryForViewerJoin();
        syncPeerService.acknowledgeLocalDbVersion();
        deviceRegistryService.touchLocalDevice({ lastSeenAt: nowIso() });
        syncPeerService.flushLocalChanges();
        await sleep(150);
        await refreshRoleState();
        return await this.getStatus();
      } catch (error) {
        writeSavedDraft(null);
        syncPeerService.setSavedDraft(null);
        await refreshRoleState();
        throw error;
      }
    },

    async disconnectFromBrain(): Promise<SyncRoleSnapshot> {
      syncPeerService.disconnect();
      writeSavedDraft(null);
      deviceRegistryService.clearClusterRegistryForViewerJoin();
      await refreshRoleState();
      return await this.getStatus();
    },

    getPin(): string | null {
      return pinStore.getPin();
    },

    async setPin(pin: string): Promise<SyncRoleSnapshot> {
      assertPhonePairingAvailable();
      const current = await service.getStatus();
      if (current.role !== "brain") {
        throw new Error("Phone pairing PINs can only be managed on the host ADE runtime.");
      }
      pinStore.setPin(pin);
      const snapshot = await service.getStatus();
      args.onStatusChanged?.(snapshot);
      return snapshot;
    },

    async generatePin(): Promise<SyncRoleSnapshot> {
      return await service.setPin(generatePairingPin());
    },

    async clearPin(): Promise<SyncRoleSnapshot> {
      assertPhonePairingAvailable();
      const current = await service.getStatus();
      if (current.role !== "brain") {
        throw new Error("Phone pairing PINs can only be managed on the host ADE runtime.");
      }
      pinStore.clearPin();
      const snapshot = await service.getStatus();
      args.onStatusChanged?.(snapshot);
      return snapshot;
    },

    getRuntimeName(): string | null {
      return runtimeNameStore.getRuntimeName();
    },

    async setRuntimeName(name: string): Promise<SyncRoleSnapshot> {
      assertPhonePairingAvailable();
      const current = await service.getStatus();
      if ((current.runtimeRole ?? current.role) !== "host" && current.role !== "brain") {
        throw new Error("The machine name can only be set on the host ADE runtime.");
      }
      runtimeNameStore.setRuntimeName(name);
      const snapshot = await service.getStatus();
      args.onStatusChanged?.(snapshot);
      return snapshot;
    },

    async clearRuntimeName(): Promise<SyncRoleSnapshot> {
      assertPhonePairingAvailable();
      const current = await service.getStatus();
      if ((current.runtimeRole ?? current.role) !== "host" && current.role !== "brain") {
        throw new Error("The machine name can only be cleared on the host ADE runtime.");
      }
      runtimeNameStore.clearRuntimeName();
      const snapshot = await service.getStatus();
      args.onStatusChanged?.(snapshot);
      return snapshot;
    },

    async authorizeSshPairing(value: unknown) {
      assertPhonePairingAvailable();
      const current = await service.getStatus({ includeTransferReadiness: false });
      if ((current.runtimeRole ?? current.role) !== "host" && current.role !== "brain") {
        throw new Error("SSH pairing is only available on the host ADE runtime.");
      }
      const request = parseSshPairingRequest(value);
      const peer: SyncPeerMetadata = {
        deviceId: request.device.id,
        deviceName: request.device.name,
        platform: request.device.platform,
        deviceType: request.device.type,
        siteId: request.device.siteId ?? request.device.id,
        dbVersion: 0,
        ...(request.device.capabilities ? { capabilities: request.device.capabilities } : {}),
        ...(request.device.appVersion ? { appVersion: request.device.appVersion } : {}),
        ...(request.device.appBuild ? { appBuild: request.device.appBuild } : {}),
        ...(request.device.bundleIdentifier ? { bundleIdentifier: request.device.bundleIdentifier } : {}),
      };
      const paired = pairingStore.pairPeerViaLocalTrust(peer, {
        dpopPublicKey: request.device.dpopPublicKey,
      });
      const connectInfo = buildCurrentPairingConnectInfo();
      return {
        version: SSH_PAIRING_PROTOCOL_VERSION,
        ok: true as const,
        machine: connectInfo.hostIdentity,
        pairing: {
          pairedDeviceId: paired.deviceId,
          secret: paired.secret,
        },
        sync: {
          port: connectInfo.port,
          addressCandidates: connectInfo.addressCandidates,
        },
        runtime: {
          name: runtimeNameStore.getRuntimeName(),
          version: args.appVersion ?? null,
          channel: process.env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase() || "stable",
        },
      };
    },

    getRequireDpop(): boolean {
      return securityStore.getRequireDpop();
    },

    setRequireDpop(requireDpop: boolean): boolean {
      securityStore.setRequireDpop(requireDpop);
      // Return the effective value: ADE_SYNC_REQUIRE_DPOP can override the store.
      return securityStore.getRequireDpop();
    },

    getCloudRelayStatus(): SyncCloudRelayStatus {
      const config = cloudRelayStore.getConfig();
      const tunnelStatus = args.syncTunnelClientService?.getStatus() ?? null;
      const accountSignedIn = isRelayAccountSignedIn()
        && (tunnelStatus?.accountLeaseValid ?? true);
      const status = {
        relayWssUrl: cloudRelayStore.getRelayWssUrl(),
        machineKey: config.machineKey,
        relayUrl: cloudRelayStore.getRelayUrl(),
        connected: accountSignedIn && (tunnelStatus?.connected ?? false),
        activeTunnels: accountSignedIn ? (tunnelStatus?.activeTunnels ?? 0) : 0,
        relayBridgeValidated: accountSignedIn && (tunnelStatus?.relayBridgeValidated ?? false),
        lastFailureAt: tunnelStatus?.lastFailureAt ?? null,
        lastControlOpenAt: tunnelStatus?.lastControlOpenAt ?? null,
        lastBridgeValidationAt: tunnelStatus?.lastBridgeValidationAt ?? null,
        relayEndToEndVerifiedAt: tunnelStatus?.relayEndToEndVerifiedAt ?? null,
        relayEndToEndFailure: tunnelStatus?.relayEndToEndFailure ?? null,
        relayEndToEndRoundTripMs: tunnelStatus?.relayEndToEndRoundTripMs ?? null,
        lastControlError: tunnelStatus?.lastControlError ?? null,
        lastError: accountSignedIn
          ? tunnelStatus?.lastError ?? null
          : "Sign in to ADE to use ADE Relay.",
      };
      return status;
    },

    async runSelfProbe(): Promise<{ ok: boolean; detail: string }> {
      if (!args.syncTunnelClientService?.runSelfProbe) {
        return {
          ok: false,
          detail: "Relay self-probe skipped because the tunnel client is unavailable.",
        };
      }
      return await args.syncTunnelClientService.runSelfProbe();
    },

    async setActiveLanePresence(laneIds: string[]): Promise<void> {
      const normalized = Array.isArray(laneIds)
        ? [...new Set(
            laneIds
              .map((laneId) => (typeof laneId === "string" ? laneId.trim() : ""))
              .filter((laneId) => laneId.length > 0),
          )]
        : [];
      activeLocalLanePresenceIds = normalized;
      hostService?.setLocalActiveLanePresence(activeLocalLanePresenceIds);
    },

    async forgetDevice(deviceId: string): Promise<SyncRoleSnapshot> {
      pairingStore.revoke(deviceId);
      hostService?.revokePairedDevice(deviceId);
      deviceRegistryService.forgetDevice(deviceId);
      await emitStatus();
      return await this.getStatus();
    },

    async getTransferReadiness(): Promise<SyncTransferReadiness> {
      return await getTransferReadiness({ force: true });
    },

    async transferBrainToLocal(): Promise<SyncRoleSnapshot> {
      const current = await this.getStatus({ forceTransferReadiness: true });
      if (current.role === "brain") return current;
      if (!current.transferReadiness.ready) {
        throw new Error(
          "Stop live chats and terminals before transferring the host role.",
        );
      }
      const localDevice = deviceRegistryService.ensureLocalDevice();
      const currentCluster = deviceRegistryService.getClusterState();
      deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastHost: localDevice.lastHost,
        lastPort: localDevice.lastPort ?? DEFAULT_SYNC_HOST_PORT,
      });
      deviceRegistryService.setClusterState({
        brainDeviceId: localDevice.deviceId,
        brainEpoch: (currentCluster?.brainEpoch ?? 0) + 1,
        updatedByDeviceId: localDevice.deviceId,
      });
      syncPeerService.flushLocalChanges();
      await sleep(300);
      await refreshRoleState();
      return await this.getStatus();
    },

    handlePtyData(
      event: Parameters<SyncHostService["handlePtyData"]>[0],
    ): void {
      hostService?.handlePtyData(event);
    },

    handlePtyExit(
      event: Parameters<SyncHostService["handlePtyExit"]>[0],
    ): void {
      hostService?.handlePtyExit(event);
    },

    notifyPrsUpdated(): void {
      hostService?.broadcastPrsUpdated();
    },

    getHostService(): SyncHostService | null {
      return hostService;
    },

    getRemoteCommandDescriptor(action: string) {
      return remoteCommandService.getDescriptor(action);
    },

    async executeRemoteCommand(
      payload: Parameters<SyncRemoteCommandService["execute"]>[0],
      context?: Parameters<SyncRemoteCommandService["execute"]>[1],
    ): Promise<unknown> {
      return await remoteCommandService.execute(payload, context);
    },

    getDeviceRegistryService() {
      return deviceRegistryService;
    },

    getRegisteredPeerCount(): number | null {
      return pairingStore.countPairingRecords();
    },

    async dispose(): Promise<void> {
      disposed = true;
      syncPeerService.disconnect();
      clearInterval(localLanePresenceHeartbeatTimer);
      await stopHostIfRunning();
      await syncPeerService.dispose();
    },
  };

  return service;
}

export type SyncService = ReturnType<typeof createSyncService>;
