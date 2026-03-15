import fs from "node:fs";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  SyncDesktopConnectionDraft,
  SyncDeviceRuntimeState,
  SyncRoleSnapshot,
  SyncTransferBlocker,
  SyncTransferReadiness,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import type { createFileService } from "../files/fileService";
import type { createMissionService } from "../missions/missionService";
import type { createProcessService } from "../processes/processService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse, sleep, writeTextAtomic } from "../shared/utils";
import { createDeviceRegistryService } from "./deviceRegistryService";
import { createSyncHostService, type SyncHostService } from "./syncHostService";
import { createSyncPeerService } from "./syncPeerService";
import { DEFAULT_SYNC_HOST_PORT } from "./syncProtocol";

type SyncServiceArgs = {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  fileService: ReturnType<typeof createFileService>;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  computerUseArtifactBrokerService: ReturnType<typeof createComputerUseArtifactBrokerService>;
  missionService: ReturnType<typeof createMissionService>;
  agentChatService: ReturnType<typeof createAgentChatService>;
  processService: ReturnType<typeof createProcessService>;
  onStatusChanged?: (snapshot: SyncRoleSnapshot) => void;
};

const DRAFT_FILE = "sync-peer-draft.json";
const TOKEN_FILE = "sync-bootstrap-token";
const RUNNING_PROCESS_STATES = new Set(["starting", "running", "degraded"]);
const CHAT_TOOL_TYPES = new Set(["codex-chat", "claude-chat", "ai-chat"]);

function sanitizeDraft(raw: unknown, token: string | null): SyncDesktopConnectionDraft | null {
  if (!raw || typeof raw !== "object" || !token) return null;
  const row = raw as Record<string, unknown>;
  const host = typeof row.host === "string" ? row.host.trim() : "";
  const port = Number(row.port ?? 0);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return {
    host,
    port: Math.floor(port),
    token,
    lastRemoteDbVersion: Number.isFinite(row.lastRemoteDbVersion) ? Number(row.lastRemoteDbVersion) : 0,
    lastBrainDeviceId: typeof row.lastBrainDeviceId === "string" ? row.lastBrainDeviceId : null,
  };
}

export function createSyncService(args: SyncServiceArgs) {
  const layout = resolveAdeLayout(args.projectRoot);
  const draftPath = path.join(layout.secretsDir, DRAFT_FILE);
  const tokenPath = path.join(layout.secretsDir, TOKEN_FILE);
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });

  const deviceRegistryService = createDeviceRegistryService({
    db: args.db,
    logger: args.logger,
    projectRoot: args.projectRoot,
  });

  let hostService: SyncHostService | null = null;
  let refreshRunning = false;
  let refreshQueued = false;
  let disposed = false;

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
    return sanitizeDraft(safeJsonParse(fs.readFileSync(draftPath, "utf8"), null), token);
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
      `${JSON.stringify({
        host: draft.host,
        port: draft.port,
        lastRemoteDbVersion: draft.lastRemoteDbVersion ?? 0,
        lastBrainDeviceId: draft.lastBrainDeviceId ?? null,
      }, null, 2)}\n`,
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
            lastRemoteDbVersion: status.savedDraft.lastRemoteDbVersion ?? 0,
            lastBrainDeviceId: status.savedDraft.lastBrainDeviceId ?? null,
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
    if (hostService) {
      deviceRegistryService.touchLocalDevice({
        lastSeenAt: nowIso(),
        lastPort: hostService.getPort(),
      });
      return;
    }
    const localDevice = deviceRegistryService.ensureLocalDevice();
    hostService = createSyncHostService({
      db: args.db,
      logger: args.logger,
      projectRoot: args.projectRoot,
      fileService: args.fileService,
      sessionService: args.sessionService,
      ptyService: args.ptyService,
      computerUseArtifactBrokerService: args.computerUseArtifactBrokerService,
      bootstrapTokenPath: tokenPath,
      port: localDevice.lastPort ?? DEFAULT_SYNC_HOST_PORT,
      deviceRegistryService,
      onStateChanged: () => {
        void refreshRoleState();
      },
    });
    const port = await hostService.waitUntilListening();
    deviceRegistryService.touchLocalDevice({
      lastSeenAt: nowIso(),
      lastHost: localDevice.lastHost,
      lastPort: port,
    });
  };

  const stopHostIfRunning = async (): Promise<void> => {
    if (!hostService) return;
    const current = hostService;
    hostService = null;
    await current.dispose();
  };

  const resolveViewerDraftFromRegistry = (): SyncDesktopConnectionDraft | null => {
    const cluster = deviceRegistryService.getClusterState();
    const token = readToken();
    if (!cluster || !token) return null;
    const brain = deviceRegistryService.getDevice(cluster.brainDeviceId);
    if (!brain?.lastHost || !brain.lastPort) return null;
    return {
      host: brain.lastHost,
      port: brain.lastPort,
      token,
      lastRemoteDbVersion: syncPeerService.getStatus().lastRemoteDbVersion ?? 0,
      lastBrainDeviceId: brain.deviceId,
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
        const isLocalBrain = cluster ? cluster.brainDeviceId === localDevice.deviceId : !savedDraft;
        if (isLocalBrain) {
          if (syncPeerService.isConnected()) {
            syncPeerService.disconnect({ preserveDraft: true });
          }
          await startHostIfNeeded();
        } else {
          await stopHostIfRunning();
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
      const peer = peerStates.find((entry) => entry.deviceId === device.deviceId) ?? null;
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

    for (const mission of args.missionService.list({ status: "active", limit: 200 })) {
      blockers.push({
        kind: "mission_run",
        id: mission.id,
        label: mission.title || mission.id,
        detail: `Mission is ${mission.status}. Paused missions can transfer, but active mission work cannot.`,
      });
    }

    const chats = await args.agentChatService.listSessions(undefined, { includeIdentity: true, includeAutomation: true });
    const chatSummaries = new Map(chats.map((chat) => [chat.sessionId, chat] as const));

    for (const session of args.sessionService.list({ status: "running", limit: 500 })) {
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
        detail: "Running terminal sessions must stop before the brain role can move.",
      });
    }

    const lanes = args.db.all<{ id: string }>("select id from lanes where status != 'archived'");
    for (const lane of lanes) {
      for (const runtime of args.processService.listRuntime(lane.id)) {
        if (!RUNNING_PROCESS_STATES.has(runtime.status)) continue;
        blockers.push({
          kind: "managed_process",
          id: `${lane.id}:${runtime.processId}`,
          label: runtime.processId,
          detail: "Managed run processes must stop before the brain role can move.",
        });
      }
    }

    return {
      ready: blockers.length === 0,
      blockers,
      survivableState: [
        "Paused missions remain paused and can resume on the new brain.",
        "CTO history and idle threads remain available on the new brain.",
        "Idle and ended agent chats remain available and resumable on the new brain.",
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
      const currentBrain = cluster ? deviceRegistryService.getDevice(cluster.brainDeviceId) : localDevice;
      const role = cluster
        ? (cluster.brainDeviceId !== localDevice.deviceId ? "viewer" : "brain")
        : (savedDraft || syncPeerService.isConnected() ? "viewer" : "brain");
      const client = syncPeerService.getStatus();
      return {
        mode: role === "brain"
          ? (client.state === "connected" ? "brain" : "standalone")
          : "viewer",
        role,
        localDevice,
        currentBrain,
        clusterState: cluster,
        bootstrapToken: role === "brain" ? readToken() : null,
        connectedPeers: hostService
          ? hostService.getPeerStates()
          : (syncPeerService.getLatestBrainStatus()?.connectedPeers ?? []),
        client,
        transferReadiness: await getTransferReadiness(),
        survivableStateText: "Paused/idle state will remain available on the new brain.",
        blockingStateText: "Live missions, chats, terminals, or run processes must stop first.",
      };
    },

    async listDevices(): Promise<SyncDeviceRuntimeState[]> {
      return await listRuntimeDevices();
    },

    async updateLocalDevice(argsIn: { name?: string; deviceType?: "desktop" | "phone" | "vps" | "unknown" }) {
      const updated = deviceRegistryService.updateLocalDevice(argsIn);
      await emitStatus();
      return updated;
    },

    async connectToBrain(draft: SyncDesktopConnectionDraft): Promise<SyncRoleSnapshot> {
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

    async forgetDevice(deviceId: string): Promise<SyncRoleSnapshot> {
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
        throw new Error("Stop live missions, chats, terminals, and run processes before transferring the brain role.");
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

    handlePtyData(event: Parameters<SyncHostService["handlePtyData"]>[0]): void {
      hostService?.handlePtyData(event);
    },

    handlePtyExit(event: Parameters<SyncHostService["handlePtyExit"]>[0]): void {
      hostService?.handlePtyExit(event);
    },

    getHostService(): SyncHostService | null {
      return hostService;
    },

    async dispose(): Promise<void> {
      disposed = true;
      syncPeerService.disconnect();
      await stopHostIfRunning();
      await syncPeerService.dispose();
    },
  };

  return service;
}

export type SyncService = ReturnType<typeof createSyncService>;
