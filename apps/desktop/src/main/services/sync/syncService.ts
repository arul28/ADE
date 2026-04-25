import fs from "node:fs";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  SyncAddressCandidate,
  SyncDesktopConnectionDraft,
  SyncDeviceRuntimeState,
  SyncPairingConnectInfo,
  SyncPairingQrPayload,
  SyncProjectCatalogPayload,
  SyncProjectSwitchRequestPayload,
  SyncProjectSwitchResultPayload,
  SyncRoleSnapshot,
  SyncTailnetDiscoveryStatus,
  SyncTransferBlocker,
  SyncTransferReadiness,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { createFlowPolicyService } from "../cto/flowPolicyService";
import type { createLinearCredentialService } from "../cto/linearCredentialService";
import type { createLinearIngressService } from "../cto/linearIngressService";
import type { createLinearIssueTracker } from "../cto/linearIssueTracker";
import type { createLinearSyncService } from "../cto/linearSyncService";
import type { createWorkerAgentService } from "../cto/workerAgentService";
import type { createWorkerBudgetService } from "../cto/workerBudgetService";
import type { createWorkerHeartbeatService } from "../cto/workerHeartbeatService";
import type { createWorkerRevisionService } from "../cto/workerRevisionService";
import type { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createFileService } from "../files/fileService";
import type { createDiffService } from "../diffs/diffService";
import type { createGitOperationsService } from "../git/gitOperationsService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createLaneEnvironmentService } from "../lanes/laneEnvironmentService";
import type { createLaneService } from "../lanes/laneService";
import type { createLaneTemplateService } from "../lanes/laneTemplateService";
import type { createAutoRebaseService } from "../lanes/autoRebaseService";
import type { createPortAllocationService } from "../lanes/portAllocationService";
import type { createRebaseSuggestionService } from "../lanes/rebaseSuggestionService";
import type { createMissionService } from "../missions/missionService";
import type { createProcessService } from "../processes/processService";
import type { createIssueInventoryService } from "../prs/issueInventoryService";
import type { createPrService } from "../prs/prService";
import type { createQueueLandingService } from "../prs/queueLandingService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";
import type { NotificationEventBus } from "../notifications/notificationEventBus";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse, sleep, writeTextAtomic } from "../shared/utils";
import { createDeviceRegistryService } from "./deviceRegistryService";
import {
  createSyncHostService,
  SYNC_TAILNET_DISCOVERY_SERVICE_NAME,
  SYNC_TAILNET_DISCOVERY_SERVICE_PORT,
  type SyncHostService,
} from "./syncHostService";
import { createSyncPeerService } from "./syncPeerService";
import { createSyncPinStore } from "./syncPinStore";
import { DEFAULT_SYNC_HOST_PORT } from "./syncProtocol";

type SyncServiceArgs = {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  localDeviceIdPath?: string;
  phonePairingStateDir?: string;
  fileService: ReturnType<typeof createFileService>;
  laneService: ReturnType<typeof createLaneService>;
  gitService?: ReturnType<typeof createGitOperationsService>;
  diffService?: ReturnType<typeof createDiffService>;
  conflictService?: ReturnType<typeof createConflictService>;
  prService: ReturnType<typeof createPrService>;
  issueInventoryService?: ReturnType<typeof createIssueInventoryService> | null;
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
  missionService: ReturnType<typeof createMissionService>;
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
  onStatusChanged?: (snapshot: SyncRoleSnapshot) => void;
  /**
   * Optional notification bus forwarded to the sync host. The host publishes
   * chat/PR/mission/system events and invokes `sendInAppNotification` for
   * connected iOS peers.
   */
  notificationEventBus?: NotificationEventBus | null;
  projectCatalogProvider?: {
    listProjects: () => Promise<SyncProjectCatalogPayload>;
    prepareProjectConnection: (args: SyncProjectSwitchRequestPayload) => Promise<SyncProjectSwitchResultPayload>;
  };
};

const DRAFT_FILE = "sync-peer-draft.json";
const TOKEN_FILE = "sync-bootstrap-token";
const PIN_FILE = "sync-pin.json";
const PAIRED_DEVICES_FILE = "sync-paired-devices.json";

function migrateLegacySyncSecretFile(args: {
  legacyPath: string;
  appPath: string;
  logger: Logger;
  label: string;
}): void {
  if (args.legacyPath === args.appPath) return;
  if (fs.existsSync(args.appPath) || !fs.existsSync(args.legacyPath)) return;
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
const SYNC_HOST_PORT_RETRY_WINDOW = 12;
const LOCAL_LANE_PRESENCE_HEARTBEAT_MS = 30_000;

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
  const port = argsIn.localDevice.lastPort ?? DEFAULT_SYNC_HOST_PORT;
  const addressCandidates = buildAddressCandidates(argsIn.localDevice);
  const hostIdentity = {
    deviceId: argsIn.localDevice.deviceId,
    siteId: argsIn.localDevice.siteId,
    name: argsIn.localDevice.name,
    platform: argsIn.localDevice.platform,
    deviceType: argsIn.localDevice.deviceType,
  };
  const qrPayload: SyncPairingQrPayload = {
    version: 2,
    hostIdentity,
    port,
    addressCandidates,
  };
  const qrPayloadText = `ade-sync://pair?payload=${encodeURIComponent(JSON.stringify(qrPayload))}`;
  return {
    hostIdentity,
    port,
    addressCandidates,
    qrPayload,
    qrPayloadText,
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
  const preferred = Number.isFinite(preferredPort)
    ? Math.max(0, Math.min(65_535, Math.floor(Number(preferredPort))))
    : DEFAULT_SYNC_HOST_PORT;
  const candidates: number[] = [];
  const seen = new Set<number>();
  const add = (port: number) => {
    const normalized = Math.max(0, Math.min(65_535, Math.floor(port)));
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };
  add(preferred);
  if (preferred !== DEFAULT_SYNC_HOST_PORT) {
    add(DEFAULT_SYNC_HOST_PORT);
  }
  for (let offset = 1; offset <= SYNC_HOST_PORT_RETRY_WINDOW; offset += 1) {
    if (preferred + offset <= 65_535) {
      add(preferred + offset);
    }
  }
  if (preferred !== DEFAULT_SYNC_HOST_PORT) {
    for (let offset = 1; offset <= Math.min(4, SYNC_HOST_PORT_RETRY_WINDOW); offset += 1) {
      if (DEFAULT_SYNC_HOST_PORT + offset <= 65_535) {
        add(DEFAULT_SYNC_HOST_PORT + offset);
      }
    }
  }
  add(0);
  return candidates;
}

export function createSyncService(args: SyncServiceArgs) {
  const layout = resolveAdeLayout(args.projectRoot);
  const pairingStateDir = args.phonePairingStateDir ?? layout.secretsDir;
  const draftPath = path.join(pairingStateDir, DRAFT_FILE);
  const tokenPath = path.join(pairingStateDir, TOKEN_FILE);
  const pinPath = path.join(pairingStateDir, PIN_FILE);
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
  let hostStartupEnabled = args.hostStartupEnabled !== false;
  let hostDiscoveryEnabled = args.hostDiscoveryEnabled !== false;
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
        projectRoot: args.projectRoot,
        fileService: args.fileService,
        laneService: args.laneService,
        gitService: args.gitService,
        diffService: args.diffService,
        conflictService: args.conflictService,
        prService: args.prService,
        issueInventoryService: args.issueInventoryService,
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
        computerUseArtifactBrokerService: args.computerUseArtifactBrokerService,
        pinStore,
        bootstrapTokenPath: tokenPath,
        pairingSecretsPath,
        port: attemptedPort,
        discoveryEnabled: hostDiscoveryEnabled,
        deviceRegistryService,
        notificationEventBus: args.notificationEventBus ?? null,
        projectCatalogProvider: args.projectCatalogProvider,
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
        if (!cluster && !savedDraft) {
          cluster = deviceRegistryService.bootstrapLocalBrainIfNeeded();
        }
        const isLocalBrain = cluster
          ? cluster.brainDeviceId === localDevice.deviceId
          : !savedDraft;
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

  const getTransferReadiness = async (): Promise<SyncTransferReadiness> => {
    const blockers: SyncTransferBlocker[] = [];

    for (const mission of args.missionService.list({
      status: "active",
      limit: 200,
    })) {
      blockers.push({
        kind: "mission_run",
        id: mission.id,
        label: mission.title || mission.id,
        detail: `Mission is ${mission.status}. Paused missions can transfer, but active mission work cannot.`,
      });
    }

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
            : "Live chat runtimes do not hot-transfer. Let the turn finish or interrupt it first.",
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
        "Paused missions remain paused and can resume on the new host.",
        "CTO history and idle threads remain available on the new host.",
        "Idle and ended agent chats remain available and resumable on the new host.",
      ],
    };
  };

  const service = {
    async initialize(): Promise<void> {
      deviceRegistryService.ensureLocalDevice();
      await refreshRoleState();
    },

    async getStatus(): Promise<SyncRoleSnapshot> {
      const localDevice = deviceRegistryService.ensureLocalDevice();
      const cluster = deviceRegistryService.getClusterState();
      const savedDraft = readSavedDraft();
      const currentBrain = cluster
        ? deviceRegistryService.getDevice(cluster.brainDeviceId)
        : localDevice;
      const isLocalBrain = cluster
        ? cluster.brainDeviceId === localDevice.deviceId
        : !savedDraft && !syncPeerService.isConnected();
      const role = isLocalBrain ? "brain" : "viewer";
      const crdtSyncAvailable = isCrdtSyncAvailable();
      const canHostPhonePairing = role === "brain" && hostStartupEnabled && crdtSyncAvailable;
      const client = syncPeerService.getStatus();
      const mode =
        role === "viewer"
          ? "viewer"
          : client.state === "connected"
            ? "brain"
            : "standalone";
      return {
        mode,
        role,
        localDevice,
        currentBrain,
        clusterState: cluster,
        bootstrapToken:
          canHostPhonePairing ? readToken() : null,
        pairingPin: canHostPhonePairing ? pinStore.getPin() : null,
        pairingPinConfigured: canHostPhonePairing ? pinStore.hasPin() : false,
        pairingConnectInfo:
          canHostPhonePairing
            ? buildPairingConnectInfo({ localDevice })
            : null,
        connectedPeers: hostService
          ? hostService.getPeerStates()
          : (syncPeerService.getLatestBrainStatus()?.connectedPeers ?? []),
        tailnetDiscovery: canHostPhonePairing && hostService
          ? hostService.getTailnetDiscoveryStatus()
          : createInactiveTailnetDiscoveryStatus(
              canHostPhonePairing
                ? "Tailnet discovery is waiting for the desktop sync host to start."
                : "Tailnet discovery is only published by the host desktop.",
            ),
        client,
        transferReadiness: await getTransferReadiness(),
        survivableStateText:
          crdtSyncAvailable
            ? "Paused and idle state will remain available on the new host."
            : "Desktop sync is disabled because the CRDT database extension is unavailable on this platform.",
        blockingStateText:
          crdtSyncAvailable
            ? "Live missions, chats, terminals, or run processes must stop first."
            : "Install a Windows cr-sqlite runtime before pairing or syncing devices.",
      };
    },

    async listDevices(): Promise<SyncDeviceRuntimeState[]> {
      return await listRuntimeDevices();
    },

    async refreshDiscovery(): Promise<SyncRoleSnapshot> {
      hostService?.refreshLanDiscovery?.({ forceTailnet: true });
      const snapshot = await this.getStatus();
      args.onStatusChanged?.(snapshot);
      return snapshot;
    },

    setHostDiscoveryEnabled(enabled: boolean): void {
      hostDiscoveryEnabled = enabled;
      hostService?.setDiscoveryEnabled(enabled);
      void emitStatus();
    },

    setHostStartupEnabled(enabled: boolean): void {
      hostStartupEnabled = enabled;
      void refreshRoleState();
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
        throw new Error("Desktop sync is unavailable because the CRDT database extension is not loaded.");
      }
      await stopHostIfRunning();
      deviceRegistryService.clearClusterRegistryForViewerJoin();
      writeSavedDraft(draft);
      syncPeerService.setSavedDraft(draft);
      try {
        await syncPeerService.connect(draft);
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
        throw new Error("Phone pairing PINs can only be managed on the host desktop.");
      }
      pinStore.setPin(pin);
      const snapshot = await service.getStatus();
      args.onStatusChanged?.(snapshot);
      return snapshot;
    },

    async clearPin(): Promise<SyncRoleSnapshot> {
      assertPhonePairingAvailable();
      const current = await service.getStatus();
      if (current.role !== "brain") {
        throw new Error("Phone pairing PINs can only be managed on the host desktop.");
      }
      pinStore.clearPin();
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
      hostService?.revokePairedDevice(deviceId);
      deviceRegistryService.forgetDevice(deviceId);
      await emitStatus();
      return await this.getStatus();
    },

    async getTransferReadiness(): Promise<SyncTransferReadiness> {
      return await getTransferReadiness();
    },

    async transferBrainToLocal(): Promise<SyncRoleSnapshot> {
      const current = await this.getStatus();
      if (current.role === "brain") return current;
      if (!current.transferReadiness.ready) {
        throw new Error(
          "Stop live missions, chats, terminals, and run processes before transferring the host role.",
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
