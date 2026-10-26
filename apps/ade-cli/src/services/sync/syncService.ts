import type { ChatLaunchService } from "../../../../desktop/src/main/services/chat/chatLaunchService";
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import {
  createSyncAccountDirectoryHealth,
  type SyncCloudRelayStatus,
  type SyncAccountDirectoryHealth,
  type SyncDesktopConnectionDraft,
  type SyncDeviceRecord,
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
  type SyncFileRequest,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { createCursorCloudFleetService } from "../../../../desktop/src/main/services/chat/cursorCloudFleetService";
import type { CloudAgentsService } from "../../../../desktop/src/main/services/chat/cloudAgentsService";
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
import type { createJiraService } from "../../../../desktop/src/main/services/jira/jiraService";
import type { createConflictService } from "../../../../desktop/src/main/services/conflicts/conflictService";
import type { createLaneEnvironmentService } from "../../../../desktop/src/main/services/lanes/laneEnvironmentService";
import type { createLaneService } from "../../../../desktop/src/main/services/lanes/laneService";
import type { createLaneTemplateService } from "../../../../desktop/src/main/services/lanes/laneTemplateService";
import type { createAutoRebaseService } from "../../../../desktop/src/main/services/lanes/autoRebaseService";
import type { createPortAllocationService } from "../../../../desktop/src/main/services/lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../../../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { createPrService } from "../../../../desktop/src/main/services/prs/prService";
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
  type SyncHostRemoteCommandExecutor,
} from "./syncHostService";
import { createSyncArtifactReads, runSyncFileServiceRequest } from "./syncFileRequests";
import { createSyncPairingStore } from "./syncPairingStore";
import { isValidDpopPublicKey } from "./syncPairingStore";
import { createSyncSecurityStore } from "./syncSecurityStore";
import {
  createSyncCloudRelayStore,
  type SyncCloudRelayStore,
} from "./syncCloudRelayStore";
import { buildSyncCloudRelayStatus } from "./syncCloudRelayStatus";
import { createSyncPeerService } from "./syncPeerService";
import { createSyncPinStore } from "./syncPinStore";
import { createSyncRuntimeNameStore } from "./syncRuntimeNameStore";
import { DEFAULT_SYNC_HOST_PORT, buildSyncHostPortCandidates } from "./syncProtocol";
import { createSyncRemoteCommandService, type ExternalSessionsRemoteService, type SyncBrowserTabCloser, type SyncRemoteCommandService } from "./syncRemoteCommandService";
import type { WorkToolsStateService } from "../workTools/workToolsStateService";
import type { MacDesktopService } from "../../../../desktop/src/main/services/macDesktop/macDesktopService";
import { createMacDesktopSyncStream } from "../../../../desktop/src/main/services/macDesktop/macDesktopSyncStream";
import { createAppControlSyncStream, type AppControlSyncSource } from "./appControlSyncStream";
import type { AppleDeviceRemoteService, AppleStreamTicketIssuer } from "./appleRemoteCommands";
import {
  buildAddressCandidates,
  buildPairingConnectInfo,
  isLoopbackHost,
  tailscaleDnsNameFromDevice,
} from "./syncPairingConnectInfo";
import { buildRelayRouteHealth, deriveListenerHealth } from "./syncRouteHealth";
import type { PushPublisherService } from "../push/pushPublisherService";
import { acquireSyncHostSingletonAsync, type SyncHostSingletonLease } from "./syncHostSingleton";
import type { SharedSyncListener } from "./sharedSyncListener";
import type { ModelPickerStore } from "../modelPickerStore";
import type { UsageTrackingHost } from "../../../../desktop/src/main/services/usage/usageTrackingService";
import type { JevService } from "../../../../desktop/src/main/services/jev/jevService";
import type { ProductAnalyticsService } from "../../../../desktop/src/main/services/analytics/productAnalyticsService";
import type { AccountAuthService } from "../account/accountAuthService";
import type { AccountSettingsStore } from "../account/accountSettingsStore";
import type { ProxyService } from "../proxy/proxyService";
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
import type { WebhookRemoteSource } from "./webhookRemoteCommands";
import type { AutomationRuleRemoteSource } from "./automationRuleRemoteCommands";

type SyncServiceArgs = {
  db: AdeDb;
  usageTrackingService?: UsageTrackingHost | null;
  getProxyService?: () => Pick<ProxyService, "status"> | null;
  accountSettingsStore?: AccountSettingsStore | null;
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
  sessionService: ReturnType<typeof createSessionService>;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
  ptyService: ReturnType<typeof createPtyService>;
  /** False when this runtime has no RPC endpoint that accepts activity reports. */
  sessionActivityReportingEnabled?: boolean;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  jevService?: Pick<JevService, "decide" | "status"> | null;
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
  chatLaunchService?: ChatLaunchService | null;
  cursorCloudFleetService?: ReturnType<typeof createCursorCloudFleetService> | null;
  cloudAgentsService?: CloudAgentsService | null;
  personalChatScope?: PersonalChatScopeContract;
  /** Brain→push-relay publisher; threaded to the runtime remote-command service. */
  pushPublisherService?: PushPublisherService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  ctoMemoryService?: CtoMemoryService | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearOAuthService?: ReturnType<typeof createLinearOAuthService> | null;
  getJiraService?: () => ReturnType<typeof createJiraService> | null;
  /**
   * Resolvers for services that are constructed AFTER createSyncService in
   * main.ts. Using lazy getters lets the sync router forward remote commands
   * to them without requiring a specific init order.
   */
  getLinearIssueTracker?: () => ReturnType<typeof createLinearIssueTracker> | null;
  getExternalSessionsService?: () => ExternalSessionsRemoteService | null;
  /**
   * Read-only Work tools-pane state (active tool, browser tabs, App Control)
   * served to iOS and the hosted web client through `workTools.*`.
   */
  workToolsStateService?: WorkToolsStateService | null;
  /** The desktop browser bridge, for `workTools.closeBrowserTab`. */
  builtInBrowserService?: SyncBrowserTabCloser | null;
  /** Apple device environment for remote surfaces; absent off macOS. */
  appleDeviceService?: AppleDeviceRemoteService | null;
  /** Webhook automations for remote surfaces (read-only). */
  getWebhookAutomations?: () => WebhookRemoteSource | null;
  /** Auto-handoff rules for the phone's session menu; null when automations are off. */
  getAutomationRules?: () => AutomationRuleRemoteSource | null;
  appleStreamRelay?: AppleStreamTicketIssuer | null;
  getAppleRemoteBitrateKbpsCap?: () => number | null;
  /**
   * The runtime's Mac Desktop service, when this runtime can hold a display.
   * Serves `macDesktop.*` to paired viewers and supplies the loopback transport
   * the live-view fan-out reads.
   */
  macDesktopService?: MacDesktopService | null;
  /**
   * App Control, for the live view on phones and the hosted web client. Only
   * the status read and the event stream are used; the host never drives the
   * app from here. Absent on a chat-only runtime.
   */
  appControl?: AppControlSyncSource | null;
  /**
   * Brain-level websocket listener shared across hosted-project switches.
   * When provided, the embedded sync host attaches to it instead of binding
   * its own WebSocketServer, so connected phones survive host swaps. The
   * listener's lifecycle is owned by the caller (closed on brain shutdown).
   */
  sharedSyncListener?: SharedSyncListener | null;
  hostStartupEnabled?: boolean;
  /**
   * Whether this runtime may write the cluster record as its brain while it is
   * not the selected host. Fixed at construction; only the machine's own ADE
   * home sets it. Its project scopes boot with host startup off until one is
   * selected, and must still claim a missing or dead record at startup. Every
   * other runtime claims only while its host startup is on, so a runtime that
   * cannot host (the desktop in-process runtime) never writes the record.
   */
  mayClaimCluster?: boolean;
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
  remoteCommandExecutor?: SyncHostRemoteCommandExecutor;
  projectScopes?: { getIfBooted(projectId: string): Promise<unknown> | null };
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
const LOCAL_LANE_PRESENCE_HEARTBEAT_MS = 30_000;
const CANONICAL_SYNC_PORT_MIGRATE_FIRST_MS = 2_000;
const CANONICAL_SYNC_PORT_MIGRATE_MS = 15_000;
const TRANSFER_READINESS_CACHE_MS = 15_000;
const LIGHTWEIGHT_TRANSFER_READINESS_WAIT_MS = 2_000;
const TRANSFER_READINESS_RETRY_COOLDOWN_MS = 5_000;
const STALE_BRAIN_LAST_SEEN_MS = 5 * 60_000;
const STALE_VIEWER_DRAFT_BRAIN_LAST_SEEN_MS = 3 * 24 * 60 * 60_000;
const GHOST_BRAIN_LAST_SEEN_MS = 60 * 60_000;

/**
 * This project follows another machine's sync brain, so this machine cannot
 * host it. `saved_connection` is an explicit join; `cluster_record` is a
 * replicated cluster row that names a brain seen in the last few minutes.
 */
export type SyncHostBlocker = {
  reason: "saved_connection" | "cluster_record";
  host: string | null;
  port: number | null;
};
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

export function shouldReclaimStaleViewerDraftAfterTransportFailure(args: {
  hostStartupEnabled: boolean;
  crdtSyncAvailable: boolean;
  cluster: { brainDeviceId: string } | null;
  localDevice: SyncRoleSnapshot["localDevice"];
  brain: { lastSeenAt: string | null; updatedAt: string; metadata: Record<string, unknown> } | null;
  draft: SyncDesktopConnectionDraft;
  error: unknown;
  now?: number;
}): boolean {
  if (!args.hostStartupEnabled || !args.crdtSyncAvailable) return false;
  if (!isViewerDraftTransportError(args.error)) return false;
  const originalLastSeenRaw = args.brain?.lastSeenAt ?? args.brain?.updatedAt;
  const originalLastSeenMs = originalLastSeenRaw ? Date.parse(originalLastSeenRaw) : Number.NaN;
  const lastSeenMs = args.brain?.lastSeenAt ? Date.parse(args.brain.lastSeenAt) : Number.NaN;
  const staleByOriginalRule = args.cluster != null
    && args.cluster.brainDeviceId !== args.localDevice.deviceId
    && (!args.brain || !Number.isFinite(originalLastSeenMs)
      || (args.now ?? Date.now()) - originalLastSeenMs > STALE_BRAIN_LAST_SEEN_MS);
  // Preserve the original recovery for a draft that explicitly points back
  // to this device; no cluster or the original stale check is enough.
  if (isDraftTargetLocalDevice(args.draft, args.localDevice) && (!args.cluster || staleByOriginalRule)) return true;
  if (!args.cluster) return false;
  if (args.cluster.brainDeviceId === args.localDevice.deviceId) return false;
  const localHostname = normalizeHostKey(
    typeof args.localDevice.metadata?.hostname === "string" ? args.localDevice.metadata.hostname : null,
  );
  const brainHostname = normalizeHostKey(
    typeof args.brain?.metadata.hostname === "string" ? args.brain.metadata.hostname : null,
  );
  const unseenForMs = Number.isFinite(lastSeenMs) ? (args.now ?? Date.now()) - lastSeenMs : Number.NaN;
  // Default macOS hostnames collide, so require a distinct device id and a
  // full hour without a heartbeat before treating a matching name as a ghost.
  if (
    localHostname
    && brainHostname === localHostname
    && args.cluster.brainDeviceId !== args.localDevice.deviceId
    && unseenForMs >= GHOST_BRAIN_LAST_SEEN_MS
  ) return true;
  // A remote machine may be offline for hours; the longer threshold avoids
  // disrupting ordinary reconnects while still clearing abandoned clusters.
  return Number.isFinite(unseenForMs)
    && unseenForMs > STALE_VIEWER_DRAFT_BRAIN_LAST_SEEN_MS;
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

export function createSyncService(args: SyncServiceArgs) {
  const layout = resolveAdeLayout(args.projectRoot);
  const artifactReads = createSyncArtifactReads({
    projectRoot: args.projectRoot,
    artifactsDir: layout.artifactsDir,
    findArtifactUri: (artifactId) => args.computerUseArtifactBrokerService.listArtifacts({ artifactId })[0]?.uri ?? null,
  });
  const pairingStateDir = args.phonePairingStateDir ?? layout.secretsDir;
  const draftPath = path.join(pairingStateDir, DRAFT_FILE);
  const tokenPath = path.join(pairingStateDir, TOKEN_FILE);
  const pinPath = path.join(pairingStateDir, PIN_FILE);
  const runtimeNamePath = path.join(pairingStateDir, RUNTIME_NAME_FILE);
  const pairingSecretsPath = path.join(pairingStateDir, PAIRED_DEVICES_FILE);
  // The project's own pre-tag draft. It is not copied up front: copying it into the
  // shared file made one project's draft the machine's connection for every project.
  // It is adopted on read, only by the project whose cluster record names its brain.
  const legacyProjectDraftPath = path.join(layout.secretsDir, DRAFT_FILE);
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
    // Identity mints, rotations, and backup recoveries are logged wherever the
    // store is built: a machine key that changes with no record is how a live
    // computer turned into a phantom row its owner deleted.
    logger: args.logger,
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
  // Writing the cluster record as this device is allowed only for the machine
  // brain (`mayClaimCluster`) or while this runtime is starting its own host.
  // Read at each claim, never cached: `hostStartupEnabled` changes at runtime.
  const mayClaimCluster = args.mayClaimCluster === true;
  const canClaimCluster = (): boolean => mayClaimCluster || hostStartupEnabled;
  let hostDiscoveryEnabled = args.hostDiscoveryEnabled !== false;
  let transferReadinessCache: { value: SyncTransferReadiness; expiresAtMs: number } | null = null;
  let transferReadinessInFlight: Promise<SyncTransferReadiness> | null = null;
  // Set when a computation fails. Awaiting light reads do not start another one
  // before this passes, so a readiness that keeps throwing is not re-enumerated
  // on every poll.
  let transferReadinessRetryAtMs = 0;
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

  // The draft file lives in the machine-wide pairing directory, but joining
  // another brain is a decision about ONE project database. The draft records
  // the site id of the project that made it, and every other project ignores
  // it. A draft from before that tag applies only to a project whose cluster
  // record names the same brain address the draft dials: a project that never
  // joined anything, or follows a different machine, must not be redirected by
  // a draft another project left behind.
  const projectSiteId = deviceRegistryService.getLocalSiteId();

  const legacyDraftNamesClusterBrain = (raw: unknown): boolean => {
    const row = raw as Record<string, unknown>;
    const host = typeof row.host === "string" ? normalizeHostKey(row.host) : null;
    const port = Number(row.port ?? 0);
    if (!host || !Number.isFinite(port) || port <= 0) return false;
    const cluster = deviceRegistryService.getClusterState();
    if (!cluster || cluster.brainDeviceId === deviceRegistryService.getLocalDeviceId()) return false;
    const brain = deviceRegistryService.getDevice(cluster.brainDeviceId);
    if (!brain || Math.floor(port) !== (brain.lastPort ?? DEFAULT_SYNC_HOST_PORT)) return false;
    // The brain is remote here: the local device returned above.
    return buildAddressCandidates(brain, { isLocalDevice: false }).some(
      (candidate) => candidate.kind !== "loopback" && normalizeHostKey(candidate.host) === host,
    );
  };

  const savedDraftAppliesToProject = (raw: unknown): boolean => {
    const owner = (raw as { projectSiteId?: unknown } | null)?.projectSiteId;
    if (typeof owner === "string" && owner.trim()) {
      return owner.trim() === projectSiteId;
    }
    return legacyDraftNamesClusterBrain(raw);
  };

  const readSavedDraftFile = (): unknown => {
    if (!fs.existsSync(draftPath)) return null;
    return safeJsonParse(fs.readFileSync(draftPath, "utf8"), null);
  };

  let legacyDraftSkipLogged = false;
  // Adopts this project's own pre-tag draft into the shared file, tagged with
  // this project's site id. It runs only while the shared file is absent:
  // writing over a draft another project saved would disconnect that project.
  const adoptLegacyProjectDraft = (): unknown => {
    if (legacyProjectDraftPath === draftPath || fs.existsSync(draftPath)) return null;
    if (!fs.existsSync(legacyProjectDraftPath)) return null;
    const raw = safeJsonParse(fs.readFileSync(legacyProjectDraftPath, "utf8"), null) as Record<string, unknown> | null;
    const tagged = typeof raw?.projectSiteId === "string" && raw.projectSiteId.trim().length > 0;
    if (!raw || tagged || !legacyDraftNamesClusterBrain(raw)) {
      if (!legacyDraftSkipLogged) {
        legacyDraftSkipLogged = true;
        args.logger.info("sync.legacy_draft_skipped", { path: legacyProjectDraftPath });
      }
      return null;
    }
    const adopted = { ...raw, projectSiteId };
    writeTextAtomic(draftPath, `${JSON.stringify(adopted, null, 2)}\n`);
    args.logger.info("sync.legacy_draft_adopted", { path: legacyProjectDraftPath, host: raw.host, port: raw.port });
    return adopted;
  };

  // A draft saved before the loopback fix can still name 127.0.0.1 while the
  // cluster brain is another machine, and dialing it reaches this machine's own
  // listener. Only the dial ignores such a draft: the file is user state and
  // stays, and the viewer falls back to the brain's registry address (or dials
  // nothing) through resolveViewerDraftFromRegistry.
  const savedDraftDialsOwnListener = (draft: SyncDesktopConnectionDraft): boolean => {
    const cluster = deviceRegistryService.getClusterState();
    if (!cluster || cluster.brainDeviceId === deviceRegistryService.getLocalDeviceId()) return false;
    const host = normalizeHostKey(draft.host);
    return host != null && isLoopbackHost(host);
  };

  let loopbackDraftSkipLogged = false;
  const readSavedDraft = (): SyncDesktopConnectionDraft | null => {
    if (forceHostRole) return null;
    const raw = readSavedDraftFile() ?? adoptLegacyProjectDraft();
    if (!raw || !savedDraftAppliesToProject(raw)) return null;
    const draft = sanitizeDraft(raw, readToken());
    if (!draft || !savedDraftDialsOwnListener(draft)) return draft;
    if (!loopbackDraftSkipLogged) {
      loopbackDraftSkipLogged = true;
      args.logger.warn("sync.role.saved_draft_loopback_ignored", { host: draft.host, port: draft.port });
    }
    return null;
  };

  const writeSavedDraft = (draft: SyncDesktopConnectionDraft | null): void => {
    if (!draft) {
      // Clearing is scoped the same way: a project that does not own the
      // machine's draft must not delete the connection another project made.
      const raw = readSavedDraftFile();
      if (raw && !savedDraftAppliesToProject(raw)) return;
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
          projectSiteId,
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
      scheduleStatusEmit();
    },
    onBrainStatus: (payload) => {
      deviceRegistryService.applyBrainStatus(payload);
      scheduleStatusEmit();
    },
    onRemoteChangesApplied: () => {
      refreshRoleStateInBackground();
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

  // One fan-out for the whole host: the `macDesktop.*` command handlers push
  // through it, and the host releases a subscription when its socket closes.
  const macDesktopService = args.macDesktopService ?? null;
  const macDesktopSyncStream = macDesktopService
    ? createMacDesktopSyncStream({
        logger: args.logger,
        startStream: async ({ laneId, ownerId }) => {
          const status = await macDesktopService.startStreamForSubscription({
            laneId,
            subscriptionId: ownerId,
          });
          const transport = status.transport;
          if (!transport?.url) {
            throw new Error("The Mac Desktop stream did not hand back a loopback URL.");
          }
          return {
            url: transport.url,
            width: transport.width,
            height: transport.height,
            codec: transport.codec,
          };
        },
        releaseOwner: (ownerId) => macDesktopService.releaseStreamSubscription(ownerId),
        subscribeEvents: (listener) => macDesktopService.subscribe(listener),
        // A browser or phone that keeps receiving records is watching: count
        // it as activity so the lane does not fall to the idle rate under a
        // passive viewer.
        noteActivity: (laneId) => macDesktopService.noteStreamActivity(laneId),
      })
    : null;

  // One App Control frame fan-out for the whole host, shared by the command
  // handlers and the host's connection-close cleanup, like the one above.
  const appControlSyncStream = args.appControl
    ? createAppControlSyncStream({ logger: args.logger, source: args.appControl })
    : null;

  const remoteCommandService = createSyncRemoteCommandService({
    db: args.db,
    usageTrackingService: args.usageTrackingService,
    getProxyService: args.getProxyService,
    accountSettingsStore: args.accountSettingsStore,
    productAnalyticsService: args.productAnalyticsService,
    projectRoot: args.projectRoot,
    laneService: args.laneService,
    prService: args.prService,
    ptyService: args.ptyService,
    sessionActivityReportingEnabled: args.sessionActivityReportingEnabled,
    sessionService: args.sessionService,
    sessionDeltaService: args.sessionDeltaService,
    fileService: args.fileService,
    gitService: args.gitService,
    githubService: args.githubService,
    diffService: args.diffService,
    conflictService: args.conflictService,
    operationService: args.operationService,
    aiIntegrationService: args.aiIntegrationService,
    jevService: args.jevService,
    agentChatService: args.agentChatService,
    chatLaunchService: args.chatLaunchService,
    cursorCloudFleetService: args.cursorCloudFleetService,
    cloudAgentsService: args.cloudAgentsService,
    personalChatScope: args.personalChatScope,
    pushPublisherService: args.pushPublisherService,
    ctoStateService: args.ctoStateService,
    ctoMemoryService: args.ctoMemoryService,
    linearCredentialService: args.linearCredentialService,
    linearOAuthService: args.linearOAuthService,
    getLinearIssueTracker: args.getLinearIssueTracker,
    getJiraService: args.getJiraService,
    getExternalSessionsService: args.getExternalSessionsService,
    workToolsStateService: args.workToolsStateService,
    builtInBrowserService: args.builtInBrowserService ?? null,
    // `computerUse.listArtifacts` registers only with a broker. Without it no
    // host answered it, so phones and the web client could not list the proof
    // of a chat in a project the phone had not opened.
    computerUseArtifactBrokerService: args.computerUseArtifactBrokerService,
    macDesktopService,
    macDesktopSyncStream,
    appControlSyncStream,
    appleDeviceService: args.appleDeviceService,
    appleStreamRelay: args.appleStreamRelay,
    getAppleRemoteBitrateKbpsCap: args.getAppleRemoteBitrateKbpsCap,
    getWebhookAutomations: args.getWebhookAutomations,
    getAutomationRules: args.getAutomationRules,
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
    const snapshot = await service.getStatus();
    // The snapshot awaits chat and session reads; a dispose in that window
    // already told listeners the service is gone.
    if (disposed) return;
    args.onStatusChanged?.(snapshot);
  };

  /**
   * Offer a status snapshot without making the caller wait for it.
   *
   * `emitStatus` builds a whole `SyncRoleSnapshot`, and building one is not
   * free: `getStatus` awaits `getTransferReadiness`, which enumerates
   * `agentChatService.listSessions` and `sessionService.list`. `refreshRoleState`
   * is the shared drain every role change joins, and `projectScope.ts` calls it
   * as the sync-host "activation" phase under a 10 s budget, so a slow snapshot
   * was reported as "Sync host activation … timed out" even when the host was
   * up. The drain now finishes reaching the role and offers the snapshot after
   * it; a caller that wants a snapshot reads `getStatus()` itself, which is what
   * every one of them already did.
   *
   * The snapshot is still the same snapshot: the first offer calls
   * `getStatus()` synchronously, at the exact point `await emitStatus()` used
   * to, so it reads the same state and is built no later than before. Offers are
   * serialized and coalesced, so a burst of role changes cannot run several
   * enumerations at once and a listener never sees an older snapshot after a
   * newer one — dropping a superseded snapshot is what `syncStatusEventPublisher`
   * already does with them downstream.
   */
  let statusEmitInFlight: Promise<void> | null = null;
  let statusEmitQueued = false;
  const scheduleStatusEmit = (): void => {
    if (statusEmitInFlight) {
      statusEmitQueued = true;
      return;
    }
    statusEmitInFlight = emitStatus()
      .catch((error) => {
        // A dispose closes the project database under a snapshot that is
        // still reading it. Nobody listens any more, so that is not a failure.
        if (disposed) return;
        // Reaching the role succeeded; only the notification failed. Failing
        // the caller for it is the confusion this path exists to remove.
        args.logger.warn("sync.status_emit_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        statusEmitInFlight = null;
        if (!statusEmitQueued || disposed) return;
        statusEmitQueued = false;
        scheduleStatusEmit();
      });
  };

  const releaseHostSingletonLease = (): void => {
    const lease = hostSingletonLease;
    hostSingletonLease = null;
    lease?.dispose();
  };

  let canonicalPortMigrateTimer: ReturnType<typeof setTimeout> | null = null;

  const stopCanonicalPortMigrateTimer = (): void => {
    if (!canonicalPortMigrateTimer) return;
    clearTimeout(canonicalPortMigrateTimer);
    canonicalPortMigrateTimer = null;
  };

  const scheduleCanonicalPortMigrate = (delayMs: number): void => {
    if (!args.sharedSyncListener || disposed) return;
    stopCanonicalPortMigrateTimer();
    canonicalPortMigrateTimer = setTimeout(() => {
      canonicalPortMigrateTimer = null;
      void attemptCanonicalPortMigrate();
    }, delayMs);
    canonicalPortMigrateTimer.unref?.();
  };

  const attemptCanonicalPortMigrate = async (): Promise<void> => {
    const listener = args.sharedSyncListener;
    if (disposed || !listener) return;
    const currentPort = listener.getPort();
    if (currentPort == null || currentPort === DEFAULT_SYNC_HOST_PORT) return;
    try {
      const migrated = await listener.tryMigrateToPort(DEFAULT_SYNC_HOST_PORT);
      // Migration awaits a bind + close; dispose can land during that window.
      if (disposed) return;
      if (migrated !== DEFAULT_SYNC_HOST_PORT) {
        scheduleCanonicalPortMigrate(CANONICAL_SYNC_PORT_MIGRATE_MS);
        return;
      }
      hostSingletonLease?.updatePort(migrated);
      deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastPort: migrated,
      });
      args.logger.warn("sync_listener.port_drifted", {
        from: currentPort,
        to: migrated,
      });
      hostService?.refreshLanDiscovery({ forceLan: true, forceTailnet: true });
      void args.requestAccountMachinePublish?.();
    } catch (error) {
      args.logger.debug("sync_listener.canonical_port_migrate_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!disposed) scheduleCanonicalPortMigrate(CANONICAL_SYNC_PORT_MIGRATE_MS);
    }
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
      const activePort = hostService.getPort();
      deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastHost: currentLocalDevice.ipAddresses[0] ?? currentLocalDevice.tailscaleIp ?? currentLocalDevice.lastHost,
        lastPort: activePort,
      });
      hostService.refreshLanDiscovery?.();
      if (activePort != null && activePort !== DEFAULT_SYNC_HOST_PORT) {
        scheduleCanonicalPortMigrate(CANONICAL_SYNC_PORT_MIGRATE_FIRST_MS);
      } else {
        stopCanonicalPortMigrateTimer();
      }
      return;
    }
    const localDevice = deviceRegistryService.ensureLocalDevice();
    const preferredPort = localDevice.lastPort ?? DEFAULT_SYNC_HOST_PORT;
    let lastError: unknown = null;
    if (!hostSingletonLease) {
      const lease = await acquireSyncHostSingletonAsync({ projectRoot: args.projectRoot });
      // On Windows the acquire waits on PowerShell probes. A dispose that ran
      // meanwhile already released nothing, so this lease is released here.
      if (disposed) {
        lease.dispose();
        return;
      }
      hostSingletonLease = lease;
    }
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
      sessionService: args.sessionService,
      sessionDeltaService: args.sessionDeltaService,
      ptyService: args.ptyService,
      sessionActivityReportingEnabled: args.sessionActivityReportingEnabled,
      agentChatService: args.agentChatService,
      chatLaunchService: args.chatLaunchService,
      cursorCloudFleetService: args.cursorCloudFleetService,
      cloudAgentsService: args.cloudAgentsService,
      aiIntegrationService: args.aiIntegrationService,
      jevService: args.jevService,
      accountSettingsStore: args.accountSettingsStore,
      pushPublisherService: args.pushPublisherService,
      ctoStateService: args.ctoStateService,
      ctoMemoryService: args.ctoMemoryService,
      linearCredentialService: args.linearCredentialService,
      getLinearIssueTracker: args.getLinearIssueTracker,
      // Production always supplies `remoteCommandService` below, so the host's
      // own fallback never builds one — but pass this anyway, or the day a
      // caller omits that service the fallback silently advertises an action set
      // without `workTools.*`, which is a mobile capability disappearing with no
      // error anywhere.
      workToolsStateService: args.workToolsStateService,
      builtInBrowserService: args.builtInBrowserService ?? null,
      macDesktopService,
      getWebhookAutomations: args.getWebhookAutomations,
      macDesktopSyncStream,
      appControlSyncStream,
      appleDeviceService: args.appleDeviceService,
      appleStreamRelay: args.appleStreamRelay,
      getAppleRemoteBitrateKbpsCap: args.getAppleRemoteBitrateKbpsCap,
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
      projectScopes: args.projectScopes,
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
        refreshRoleStateInBackground();
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
      if (resolvedPort === DEFAULT_SYNC_HOST_PORT) {
        stopCanonicalPortMigrateTimer();
      } else {
        scheduleCanonicalPortMigrate(CANONICAL_SYNC_PORT_MIGRATE_FIRST_MS);
      }
    };
    try {
      const portCandidates = buildSyncHostPortCandidates(preferredPort);
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

  // The host a viewer dials for a brain: its best address candidate. Loopback is
  // offered only when the brain is this device, so a remote brain with no
  // address yields null instead of this machine's own listener.
  const brainDialHost = (brain: SyncDeviceRecord): string | null =>
    buildAddressCandidates(brain, {
      isLocalDevice: brain.deviceId === deviceRegistryService.getLocalDeviceId(),
    })[0]?.host ?? null;

  const resolveViewerDraftFromRegistry =
    (): SyncDesktopConnectionDraft | null => {
      if (forceHostRole) return null;
      const cluster = deviceRegistryService.getClusterState();
      const token = readToken();
      if (!cluster || !token) return null;
      const brain = deviceRegistryService.getDevice(cluster.brainDeviceId);
      const host = brain != null ? brainDialHost(brain) : null;
      const port = brain?.lastPort ?? DEFAULT_SYNC_HOST_PORT;
      if (!host) {
        args.logger.warn("sync.role.viewer_no_reachable_address", {
          brainDeviceId: cluster.brainDeviceId,
          brainRecordKnown: brain != null,
        });
        return null;
      }
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
    const brain = argsIn.cluster
      ? deviceRegistryService.getDevice(argsIn.cluster.brainDeviceId)
      : null;
    return shouldReclaimStaleViewerDraftAfterTransportFailure({
      hostStartupEnabled,
      crdtSyncAvailable: isCrdtSyncAvailable(),
      cluster: argsIn.cluster,
      localDevice: argsIn.localDevice,
      brain,
      draft: argsIn.draft,
      error: argsIn.error,
    });
  };

  /**
   * Why this project would follow another machine instead of hosting, or null
   * when enabling the host makes this machine its sync host. It mirrors the
   * decision `refreshRoleState` makes, without dialing anything, so a caller
   * can refuse a project switch BEFORE the current host is torn down.
   */
  const describeHostBlocker = (): SyncHostBlocker | null => {
    if (forceHostRole) return null;
    const localDevice = deviceRegistryService.ensureLocalDevice();
    const cluster = deviceRegistryService.getClusterState();
    if (cluster?.brainDeviceId === localDevice.deviceId) return null;
    const savedDraft = readSavedDraft();
    if (savedDraft) {
      // A failed viewer dial may lead this project to host. Use the same
      // stale-host criteria as refresh so the pre-switch guard agrees.
      if (shouldReclaimStaleViewerDraftAfterTransportFailure({
        hostStartupEnabled,
        crdtSyncAvailable: isCrdtSyncAvailable(),
        cluster,
        localDevice,
        brain: cluster ? deviceRegistryService.getDevice(cluster.brainDeviceId) : null,
        draft: savedDraft,
        error: Object.assign(new Error("Synthetic transport failure for blocker evaluation."), {
          code: "ECONNREFUSED",
        }),
      })) return null;
      return {
        reason: "saved_connection",
        host: savedDraft.host,
        port: savedDraft.port,
      };
    }
    // No record: the refresh bootstraps this machine as the brain. A stale
    // record naming another machine: the refresh reclaims it.
    if (!cluster || isStaleNonLocalBrainCluster(cluster, localDevice.deviceId)) return null;
    const brain = deviceRegistryService.getDevice(cluster.brainDeviceId);
    return {
      reason: "cluster_record",
      host: brain ? brainDialHost(brain) : null,
      port: brain?.lastPort ?? null,
    };
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
          } else if (!savedDraft && canClaimCluster()) {
            // Only a runtime that may claim writes the cluster record. A runtime
            // that cannot host and still claimed would make peers follow a brain
            // that never serves sync.
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
                if (canClaimCluster() && shouldReclaimStaleViewerDraft({ cluster, localDevice, draft, error })) {
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
          // Offered, not awaited: reaching the role is what a caller of this
          // drain is waiting for, and the snapshot is a notification about it.
          scheduleStatusEmit();
        }
      } while (refreshQueued && !disposed);
      } finally {
        if (refreshPromise === work) refreshPromise = null;
      }
    });
    refreshPromise = work;
    return work;
  };

  /**
   * A role refresh nobody awaits: a peer or host event asked for it. Its
   * failure must not become an unhandled rejection, and one that a dispose
   * caused (the database closed under it) is not worth a warning.
   */
  const refreshRoleStateInBackground = (): void => {
    refreshRoleState().catch((error: unknown) => {
      if (disposed) return;
      args.logger.warn("sync.role_refresh_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
      .catch((error: unknown) => {
        transferReadinessRetryAtMs = Date.now() + TRANSFER_READINESS_RETRY_COOLDOWN_MS;
        throw error;
      })
      .finally(() => {
        transferReadinessInFlight = null;
      });
    return transferReadinessInFlight;
  };

  /**
   * Lightweight status reads take the cached value. Before the first computation
   * lands there is no cache, and the skipped placeholder reads "not ready".
   *
   * A read that acts on `ready` (`awaitTransferReadiness`: `ade sync status`)
   * joins the running computation, or starts one, and waits for it. The wait is
   * bounded: the computation waits on the chat scheduler and summarizes every
   * chat, and a status read must not hang on that. Past the bound the read
   * returns the placeholder, and the computation still fills the cache for the
   * next read. A computation that just failed is not started again by these
   * reads until the retry cooldown passes.
   *
   * Every other lightweight read (the desktop top bar's) keeps the behavior it
   * had before this option: the cache, the computation already running, or the
   * placeholder. It never starts a computation, so it cannot wait on a cold one.
   */
  const getLightweightTransferReadiness = async (
    awaitReadiness: boolean,
  ): Promise<SyncTransferReadiness> => {
    if (transferReadinessCache) return transferReadinessCache.value;
    if (!awaitReadiness) {
      if (transferReadinessInFlight) {
        return transferReadinessInFlight.catch(() => buildSkippedTransferReadiness());
      }
      return buildSkippedTransferReadiness();
    }
    if (!transferReadinessInFlight && Date.now() < transferReadinessRetryAtMs) {
      return buildSkippedTransferReadiness();
    }
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const bound = new Promise<SyncTransferReadiness>((resolve) => {
      timeoutId = setTimeout(
        () => resolve(buildSkippedTransferReadiness()),
        LIGHTWEIGHT_TRANSFER_READINESS_WAIT_MS,
      );
    });
    try {
      return await Promise.race([
        getTransferReadiness().catch(() => buildSkippedTransferReadiness()),
        bound,
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
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
      // A saved draft makes this runtime a viewer on purpose; without one, a
      // viewer is following the cluster record `refreshRoleState` reclaims
      // once its brain goes stale.
      const viewerReason: SyncRoleSnapshot["viewerReason"] = isLocalBrain
        ? undefined
        : cluster && !savedDraft ? "cluster_record" : "saved_connection";
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
      const {
        loopbackAdeValidated,
        listenerReason,
        listener: listenerRouteHealth,
      } = deriveListenerHealth({
        listenerPort,
        rawValidation: rawListenerValidation,
        bound: listenerPort != null,
        notBoundReason: "The ADE sync listener is not bound.",
        validationHistory: listenerValidationHistory,
      });
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
      let accountDirectory: SyncAccountDirectoryHealth;
      try {
        accountDirectory = args.getAccountDirectoryHealth?.() ?? createSyncAccountDirectoryHealth(
          "sync_not_started",
          "Account-directory publishing is not enabled in this runtime.",
        );
      } catch {
        accountDirectory = createSyncAccountDirectoryHealth(
          "transport_error",
          "Account-directory publisher health is unavailable.",
        );
      }
      const relayRouteHealth = buildRelayRouteHealth({
        relayConfigured: canHostPhonePairing,
        relayAccountSignedIn: isRelayAccountSignedIn()
          && (tunnelStatus?.accountLeaseValid ?? true),
        loopbackAdeValidated,
        listenerReason,
        listenerPort,
        tunnelStatus,
        lastFailureAtFallback: rawListenerValidation.lastFailureAt,
      });
      const routeHealth: SyncRouteHealth = {
        listener: listenerRouteHealth,
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
        ...(viewerReason ? { viewerReason } : {}),
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
          ? await getLightweightTransferReadiness(options?.awaitTransferReadiness === true)
          : await getTransferReadiness({ force: options?.forceTransferReadiness === true }),
        crdtSyncAvailable,
        survivableStateText:
          crdtSyncAvailable
            ? "Paused and idle state will remain available on the new host."
            : "Machine sync is disabled because the CRDT database extension is unavailable on this platform.",
        blockingStateText:
          crdtSyncAvailable
            ? "Live chats or terminals must stop first."
            // `crdtSyncAvailable` is false for two different reasons: the
            // extension never loaded, or it loaded and failed its runtime
            // usability check. Naming the DLL asserts the first, so on the
            // second the user reinstalls ADE and nothing changes. Describe the
            // capability, and keep the actionable next step.
            : process.platform === "win32"
              ? "Phone sync is unavailable because CR-SQLite support could not be initialized. Reinstall ADE, then restart it before pairing a device."
              : "Phone pairing is unavailable because the CRDT database extension is unavailable on this platform.",
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
      scheduleStatusEmit();
    },

    getHostBlocker(): SyncHostBlocker | null {
      return describeHostBlocker();
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
      // Only a viewer has a brain to leave. On the brain this would also clear
      // its own devices and cluster record, which the phones and other machines
      // still depend on.
      if ((await this.getStatus()).role === "brain") {
        throw new Error("This project is the sync brain, so it has no brain to disconnect from. Its devices and cluster record are kept.");
      }
      syncPeerService.disconnect();
      writeSavedDraft(null);
      deviceRegistryService.clearClusterRegistryForViewerJoin();
      await refreshRoleState();
      return await this.getStatus();
    },

    getPin(): string | null {
      return pinStore.getPin();
    },

    /** This computer's sync device id — the key for per-device account settings. */
    getLocalDeviceId(): string {
      return deviceRegistryService.getLocalDeviceId();
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
      const tunnelStatus = args.syncTunnelClientService?.getStatus() ?? null;
      return buildSyncCloudRelayStatus({
        cloudRelayStore,
        tunnelStatus,
        accountSignedIn: isRelayAccountSignedIn()
          && (tunnelStatus?.accountLeaseValid ?? true),
      });
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
      // Refused before any write: a runtime that cannot host would claim the
      // record here, peers would follow it, and it would never serve sync.
      if (!canClaimCluster()) {
        throw new Error(
          "This ADE runtime cannot host sync, so it cannot take the host role. Make this project the host from the machine's ADE runtime.",
        );
      }
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

    /**
     * Push a fresh status snapshot to subscribers now.
     *
     * The relay tunnel is machine-level and changes state (notably 4505
     * suppression) without any project-scoped activity, so on an idle machine
     * nothing would otherwise emit a snapshot and the desktop banner would stay
     * hidden until some unrelated sync event happened along.
     */
    notifyRouteStateChanged(): void {
      scheduleStatusEmit();
    },

    getHostService(): SyncHostService | null {
      return hostService;
    },

    /**
     * Run the host/viewer decision again now.
     *
     * The decision is otherwise re-made only on events (a host-startup toggle,
     * remote changes applied). A scope that decided "viewer" because another
     * device was brain a moment ago -- a brain force-killed seconds before this
     * one started still looks fresh for `STALE_BRAIN_LAST_SEEN_MS` -- and whose
     * viewer connect then failed never received another event, so it stayed a
     * viewer of a dead brain and nobody hosted sync until a restart. The brain's
     * sync-host startup loop calls this on every retry.
     */
    async reevaluateHostRole(): Promise<void> {
      await refreshRoleState();
    },

    getRemoteCommandDescriptor(action: string) {
      return remoteCommandService.getDescriptor(action);
    },

    /** Every registered remote-command descriptor, for a routing ingress to advertise. */
    getRemoteCommandDescriptors() {
      return remoteCommandService.getDescriptors();
    },

    /**
     * Ends every Mac Desktop and App Control viewer a closed sync socket held
     * on this project, and gives back the Mac Desktop input leases it took
     * here. The socket may belong to another project's host, which routed
     * commands here, so its close handler fans this out to every booted
     * project scope.
     */
    releaseStreamConnection(connectionId: string): void {
      // Idempotent: the host project also releases its own leases directly.
      remoteCommandService.releaseMacDesktopConnection(connectionId);
      for (const stream of [macDesktopSyncStream, appControlSyncStream]) {
        try {
          stream?.releaseConnection(connectionId);
        } catch (error) {
          args.logger.warn("sync.stream_release_connection_failed", {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    async executeRemoteCommand(
      payload: Parameters<SyncRemoteCommandService["execute"]>[0],
      context?: Parameters<SyncRemoteCommandService["execute"]>[1],
    ): Promise<unknown> {
      return await remoteCommandService.execute(payload, context);
    },

    /** A `file_request` routed here from the brain's sync host. */
    async executeRemoteFileRequest(payload: SyncFileRequest, context: { isMobile: boolean }): Promise<unknown> {
      // Proof reads included: a phone shows the proof of a chat in this
      // project while another project hosts sync.
      return await runSyncFileServiceRequest(args.fileService, payload, { ...context, artifacts: artifactReads });
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
      stopCanonicalPortMigrateTimer();
      await stopHostIfRunning();
      // After the host stops, so no pushed record can outlive its socket.
      macDesktopSyncStream?.dispose();
      appControlSyncStream?.dispose();
      await syncPeerService.dispose();
    },
  };

  return service;
}

export type SyncService = ReturnType<typeof createSyncService>;
