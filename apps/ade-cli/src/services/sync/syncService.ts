import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import type {
  SyncAddressCandidate,
  SyncDesktopConnectionDraft,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPairingConnectInfo,
  SyncProjectCatalogPayload,
  SyncProjectSwitchRequestPayload,
  SyncProjectSwitchResultPayload,
  SyncRoleSnapshot,
  SyncTailnetDiscoveryStatus,
  SyncTransferBlocker,
  SyncTransferReadiness,
} from "../../../../desktop/src/shared/types";
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
import type { createComputerUseArtifactBrokerService } from "../../../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import type { createProjectConfigService } from "../../../../desktop/src/main/services/config/projectConfigService";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import type { createDiffService } from "../../../../desktop/src/main/services/diffs/diffService";
import type { createGitOperationsService } from "../../../../desktop/src/main/services/git/gitOperationsService";
import type { createConflictService } from "../../../../desktop/src/main/services/conflicts/conflictService";
import type { createLaneEnvironmentService } from "../../../../desktop/src/main/services/lanes/laneEnvironmentService";
import type { createLaneService } from "../../../../desktop/src/main/services/lanes/laneService";
import type { createLaneTemplateService } from "../../../../desktop/src/main/services/lanes/laneTemplateService";
import type { createAutoRebaseService } from "../../../../desktop/src/main/services/lanes/autoRebaseService";
import type { createPortAllocationService } from "../../../../desktop/src/main/services/lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../../../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { createProcessService } from "../../../../desktop/src/main/services/processes/processService";
import type { createIssueInventoryService } from "../../../../desktop/src/main/services/prs/issueInventoryService";
import type { PathToMergeOrchestrator } from "../../../../desktop/src/main/services/prs/pathToMergeOrchestrator";
import type { createPrService } from "../../../../desktop/src/main/services/prs/prService";
import type { createQueueLandingService } from "../../../../desktop/src/main/services/prs/queueLandingService";
import type { createPtyService } from "../../../../desktop/src/main/services/pty/ptyService";
import type { createSessionService } from "../../../../desktop/src/main/services/sessions/sessionService";
import type { NotificationEventBus } from "../../../../desktop/src/main/services/notifications/notificationEventBus";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { nowIso, safeJsonParse, sleep, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import { createDeviceRegistryService } from "./deviceRegistryService";
import {
  createSyncHostService,
  SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
  SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
  type SyncHostService,
  type SyncRuntimeKind,
} from "./syncHostService";
import { createSyncPairingStore } from "./syncPairingStore";
import { createSyncPeerService } from "./syncPeerService";
import { createSyncPinStore } from "./syncPinStore";
import { createSyncRuntimeNameStore } from "./syncRuntimeNameStore";
import { DEFAULT_SYNC_HOST_PORT } from "./syncProtocol";
import { createSyncRemoteCommandService, type SyncRemoteCommandService } from "./syncRemoteCommandService";
import type { ModelPickerStore } from "../modelPickerStore";

type SyncServiceArgs = {
  db: AdeDb;
  logger: Logger;
  projectId?: string | null;
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
  prService: ReturnType<typeof createPrService>;
  issueInventoryService?: ReturnType<typeof createIssueInventoryService> | null;
  /**
   * Optional Path-to-Merge orchestrator forwarded to the embedded sync host so
   * iOS callers can drive the convergence loop via remote commands.
   */
  pathToMergeOrchestrator?: PathToMergeOrchestrator | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
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
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  workerRevisionService?: ReturnType<typeof createWorkerRevisionService> | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  /**
   * Resolvers for services that are constructed AFTER createSyncService in
   * main.ts. Using lazy getters lets the sync router forward remote commands
   * to them without requiring a specific init order.
   */
  getLinearIngressService?: () => ReturnType<typeof createLinearIngressService> | null;
  getLinearIssueTracker?: () => ReturnType<typeof createLinearIssueTracker> | null;
  getLinearSyncService?: () => ReturnType<typeof createLinearSyncService> | null;
  processService: ReturnType<typeof createProcessService>;
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
   * Optional notification bus forwarded to the sync host. The host publishes
   * chat/PR/system events and invokes `sendInAppNotification` for
   * connected iOS peers.
   */
  notificationEventBus?: NotificationEventBus | null;
  projectCatalogProvider?: {
    listProjects: () => Promise<SyncProjectCatalogPayload>;
    prepareProjectConnection: (args: SyncProjectSwitchRequestPayload) => Promise<SyncProjectSwitchResultPayload>;
    completeProjectConnection?: (
      args: SyncProjectSwitchRequestPayload,
      result: SyncProjectSwitchResultPayload,
    ) => Promise<void>;
  };
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
};

const DRAFT_FILE = "sync-peer-draft.json";
const TOKEN_FILE = "sync-bootstrap-token";
const PIN_FILE = "sync-pin.json";
const PAIRED_DEVICES_FILE = "sync-paired-devices.json";
const RUNTIME_NAME_FILE = "sync-runtime-name.json";

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
const RUNNING_PROCESS_STATES = new Set(["starting", "running", "degraded"]);
const CHAT_TOOL_TYPES = new Set(["codex-chat", "claude-chat", "opencode-chat"]);
const LEGACY_SYNC_HOST_PORT_RETRY_WINDOW = 13;
const SYNC_HOST_PORT_RETRY_WINDOW = 8999 - DEFAULT_SYNC_HOST_PORT;
const LEGACY_SYNC_HOST_MAX_PORT = DEFAULT_SYNC_HOST_PORT + LEGACY_SYNC_HOST_PORT_RETRY_WINDOW;
const SYNC_HOST_MAX_PORT = DEFAULT_SYNC_HOST_PORT + SYNC_HOST_PORT_RETRY_WINDOW;
const LOCAL_LANE_PRESENCE_HEARTBEAT_MS = 30_000;
const TRANSFER_READINESS_CACHE_MS = 15_000;
const STALE_BRAIN_LAST_SEEN_MS = 5 * 60_000;

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

function tailscaleDnsNameFromDevice(
  localDevice: SyncRoleSnapshot["localDevice"],
): string | null {
  const value = localDevice.metadata?.tailscaleDnsName;
  return typeof value === "string" && value.trim().toLowerCase().endsWith(".ts.net")
    ? value.trim().replace(/\.$/, "").toLowerCase()
    : null;
}

function buildAddressCandidates(
  localDevice: SyncRoleSnapshot["localDevice"],
): SyncAddressCandidate[] {
  const candidates: SyncAddressCandidate[] = [];
  const seen = new Set<string>();
  const append = (
    host: string | null | undefined,
    kind: SyncAddressCandidate["kind"],
  ) => {
    const normalized = normalizeHost(host);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ host: normalized, kind });
  };
  const preferredSavedHost = normalizeHost(localDevice.lastHost);
  const preferredSavedHostIsCurrent = preferredSavedHost != null && (
    localDevice.ipAddresses.some((host) => normalizeHost(host) === preferredSavedHost)
    || normalizeHost(localDevice.tailscaleIp) === preferredSavedHost
    || tailscaleDnsNameFromDevice(localDevice) === preferredSavedHost
  );
  if (preferredSavedHostIsCurrent) {
    append(localDevice.lastHost, "saved");
  }
  for (const lanAddress of localDevice.ipAddresses) {
    append(lanAddress, "lan");
  }
  if (!preferredSavedHostIsCurrent) {
    append(localDevice.lastHost, "saved");
  }
  append(tailscaleDnsNameFromDevice(localDevice), "tailscale");
  append(localDevice.tailscaleIp, "tailscale");
  append("127.0.0.1", "loopback");
  return candidates;
}

function buildPairingConnectInfo(argsIn: {
  localDevice: SyncRoleSnapshot["localDevice"];
}): SyncPairingConnectInfo {
  const port = normalizeSyncHostPort(argsIn.localDevice.lastPort);
  const addressCandidates = buildAddressCandidates(argsIn.localDevice);
  const hostIdentity = {
    deviceId: argsIn.localDevice.deviceId,
    siteId: argsIn.localDevice.siteId,
    name: argsIn.localDevice.name,
    platform: argsIn.localDevice.platform,
    deviceType: argsIn.localDevice.deviceType,
  };
  return {
    hostIdentity,
    port,
    addressCandidates,
  };
}

function isRetryableHostBindError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? "";
  return code === "EADDRINUSE" || code === "EACCES";
}

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

function normalizeSyncHostPort(port: number | null | undefined): number {
  const parsed = Number.isFinite(port)
    ? Math.max(1, Math.min(65_535, Math.floor(Number(port))))
    : DEFAULT_SYNC_HOST_PORT;
  return parsed >= DEFAULT_SYNC_HOST_PORT && parsed <= SYNC_HOST_MAX_PORT
    ? parsed
    : DEFAULT_SYNC_HOST_PORT;
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

  const deviceRegistryService = createDeviceRegistryService({
    db: args.db,
    logger: args.logger,
    projectRoot: args.projectRoot,
    localDeviceIdPath: args.localDeviceIdPath,
  });

  let hostService: SyncHostService | null = null;
  let refreshRunning = false;
  let refreshQueued = false;
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

  const remoteCommandService = createSyncRemoteCommandService({
    db: args.db,
    laneService: args.laneService,
    prService: args.prService,
    issueInventoryService: args.issueInventoryService,
    pathToMergeOrchestrator: args.pathToMergeOrchestrator,
    queueLandingService: args.queueLandingService,
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
    projectConfigService: args.projectConfigService,
    processService: args.processService,
    portAllocationService: args.portAllocationService,
    laneEnvironmentService: args.laneEnvironmentService,
    laneTemplateService: args.laneTemplateService,
    rebaseSuggestionService: args.rebaseSuggestionService ?? undefined,
    autoRebaseService: args.autoRebaseService ?? undefined,
    getModelPickerStore: args.getModelPickerStore,
    dispatchDeeplinkUrl: args.dispatchDeeplinkUrl,
    logger: args.logger,
  });

  const emitStatus = async (): Promise<void> => {
    if (disposed) return;
    args.onStatusChanged?.(await service.getStatus());
  };

  const startHostIfNeeded = async (): Promise<void> => {
    if (!hostStartupEnabled || !isCrdtSyncAvailable()) {
      if (hostService) {
        await stopHostIfRunning();
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
    for (const attemptedPort of buildHostPortCandidates(preferredPort)) {
      const candidateHostService = createSyncHostService({
        db: args.db,
        logger: args.logger,
        projectId: args.projectId ?? null,
        projectRoot: args.projectRoot,
        fileService: args.fileService,
        laneService: args.laneService,
        gitService: args.gitService,
        diffService: args.diffService,
        conflictService: args.conflictService,
        prService: args.prService,
        issueInventoryService: args.issueInventoryService,
        pathToMergeOrchestrator: args.pathToMergeOrchestrator,
        queueLandingService: args.queueLandingService,
        sessionService: args.sessionService,
        ptyService: args.ptyService,
        processService: args.processService,
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
        projectConfigService: args.projectConfigService,
        portAllocationService: args.portAllocationService,
        laneEnvironmentService: args.laneEnvironmentService,
        laneTemplateService: args.laneTemplateService,
        rebaseSuggestionService: args.rebaseSuggestionService ?? undefined,
        autoRebaseService: args.autoRebaseService ?? undefined,
        dispatchDeeplinkUrl: args.dispatchDeeplinkUrl,
        computerUseArtifactBrokerService: args.computerUseArtifactBrokerService,
        pinStore,
        runtimeNameStore,
        bootstrapTokenPath: tokenPath,
        pairingSecretsPath,
        port: attemptedPort,
        discoveryEnabled: hostDiscoveryEnabled,
        runtimeKind: args.runtimeKind ?? "desktop-embedded",
        runtimeVersion: args.appVersion ?? "",
        deviceRegistryService,
        notificationEventBus: args.notificationEventBus ?? null,
        projectCatalogProvider: args.projectCatalogProvider,
        remoteCommandService,
        remoteCommandExecutor: args.remoteCommandExecutor,
        onStateChanged: () => {
          void refreshRoleState();
        },
      });
      try {
        const resolvedPort = await candidateHostService.waitUntilListening();
        hostService = candidateHostService;
        hostService.setLocalActiveLanePresence?.(activeLocalLanePresenceIds);
        deviceRegistryService.touchLocalDevice({
          lastSeenAt: nowIso(),
          lastHost: localDevice.ipAddresses[0] ?? localDevice.tailscaleIp ?? localDevice.lastHost,
          lastPort: resolvedPort,
        });
        return;
      } catch (error) {
        lastError = error;
        await candidateHostService.dispose().catch(() => {});
        const retryable = isRetryableHostBindError(error) && attemptedPort !== 0;
        args.logger.warn(
          retryable ? "sync.host_start_port_conflict" : "sync.host_start_failed",
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
  };

  const stopHostIfRunning = async (): Promise<void> => {
    if (!hostService) return;
    const current = hostService;
    hostService = null;
    await current.dispose();
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

  const refreshRoleState = async (): Promise<void> => {
    if (disposed) return;
    if (refreshRunning) {
      refreshQueued = true;
      return;
    }
    refreshRunning = true;
    try {
      do {
        refreshQueued = false;
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
            }
          }
        }
      } while (refreshQueued);
    } finally {
      refreshRunning = false;
      await emitStatus();
    }
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
      if (CHAT_TOOL_TYPES.has(session.toolType ?? "")) {
        const chat = chatSummaries.get(session.id);
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

    const lanes = args.db.all<{ id: string }>(
      "select id from lanes where status != 'archived'",
    );
    for (const lane of lanes) {
      for (const runtime of args.processService.listRuntime(lane.id)) {
        if (!RUNNING_PROCESS_STATES.has(runtime.status)) continue;
        blockers.push({
          kind: "managed_process",
          id: `${lane.id}:${runtime.processId}`,
          label: runtime.processId,
          detail:
            "Managed run processes must stop before the host role can move.",
        });
      }
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
            ? buildPairingConnectInfo({ localDevice })
            : null,
        connectedPeers,
        tailnetDiscovery: canHostPhonePairing && hostService
          ? hostService.getTailnetDiscoveryStatus()
          : createInactiveTailnetDiscoveryStatus(
              canHostPhonePairing
                ? "Tailnet discovery is waiting for the ADE runtime to start."
                : "Tailnet discovery is only published by the host ADE runtime.",
            ),
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
            ? "Live chats, terminals, or run processes must stop first."
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
      deviceType?: "desktop" | "phone" | "vps" | "unknown";
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
          "Stop live chats, terminals, and run processes before transferring the host role.",
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

    getHostService(): SyncHostService | null {
      return hostService;
    },

    getRemoteCommandDescriptor(action: string) {
      return remoteCommandService.getDescriptor(action);
    },

    async executeRemoteCommand(payload: Parameters<SyncRemoteCommandService["execute"]>[0]): Promise<unknown> {
      return await remoteCommandService.execute(payload);
    },

    getDeviceRegistryService() {
      return deviceRegistryService;
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
