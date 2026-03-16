import { WebSocket, type RawData } from "ws";
import type {
  SyncBrainStatusPayload,
  SyncChangesetBatchPayload,
  SyncClientStatus,
  SyncCommandAckPayload,
  SyncCommandResultPayload,
  SyncDesktopConnectionDraft,
  SyncRemoteCommandAction,
  SyncPeerMetadata,
  SyncRunQuickCommandArgs,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { nowIso } from "../shared/utils";
import type { DeviceRegistryService } from "./deviceRegistryService";
import { DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES, encodeSyncEnvelope, parseSyncEnvelope, wsDataToText } from "./syncProtocol";

type SyncPeerServiceArgs = {
  db: AdeDb;
  logger: Logger;
  deviceRegistryService: DeviceRegistryService;
  onStatusChange?: (status: SyncClientStatus) => void;
  onBrainStatus?: (payload: SyncBrainStatusPayload) => void;
  onRemoteChangesApplied?: () => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type InternalStatus = SyncClientStatus;

export function createSyncPeerService(args: SyncPeerServiceArgs) {
  let ws: WebSocket | null = null;
  let disposed = false;
  let relayTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let connectionDraft: SyncDesktopConnectionDraft | null = null;
  let latestBrainStatus: SyncBrainStatusPayload | null = null;
  let latestBrainMetadata: SyncPeerMetadata | null = null;
  let outboundLocalDbVersion = args.db.sync.getDbVersion();
  let latestRemoteDbVersion = 0;
  const pendingRequests = new Map<string, PendingRequest>();
  let pendingConnect: { resolve: () => void; reject: (error: Error) => void } | null = null;

  const status: InternalStatus = {
    state: "disconnected",
    host: null,
    port: null,
    connectedAt: null,
    lastSeenAt: null,
    latencyMs: null,
    syncLag: null,
    lastRemoteDbVersion: 0,
    brainDeviceId: null,
    hostName: null,
    error: null,
    message: null,
    savedDraft: null,
  };

  const emitStatus = () => {
    status.lastRemoteDbVersion = latestRemoteDbVersion;
    status.savedDraft = connectionDraft
      ? {
          host: connectionDraft.host,
          port: connectionDraft.port,
          lastRemoteDbVersion: connectionDraft.lastRemoteDbVersion ?? latestRemoteDbVersion,
          lastBrainDeviceId: connectionDraft.lastBrainDeviceId ?? latestBrainMetadata?.deviceId ?? null,
        }
      : null;
    args.onStatusChange?.({ ...status });
  };

  const stopTimers = () => {
    if (relayTimer) {
      clearInterval(relayTimer);
      relayTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearPendingRequests = (message: string) => {
    for (const [requestId, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      pendingRequests.delete(requestId);
    }
  };

  const applyDraft = (draft: SyncDesktopConnectionDraft | null) => {
    connectionDraft = draft
      ? {
          host: draft.host.trim(),
          port: Math.max(1, Math.floor(draft.port)),
          token: draft.token,
          authKind: draft.authKind ?? "bootstrap",
          pairedDeviceId: draft.pairedDeviceId ?? null,
          lastRemoteDbVersion: Math.max(0, Math.floor(draft.lastRemoteDbVersion ?? 0)),
          lastBrainDeviceId: draft.lastBrainDeviceId ?? null,
        }
      : null;
    emitStatus();
  };

  const currentLocalPeerMetadata = (): SyncPeerMetadata => {
    const localDevice = args.deviceRegistryService.ensureLocalDevice();
    return {
      deviceId: localDevice.deviceId,
      deviceName: localDevice.name,
      platform: localDevice.platform,
      deviceType: localDevice.deviceType,
      siteId: localDevice.siteId,
      dbVersion: latestRemoteDbVersion,
    };
  };

  const sendLocalChanges = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const currentDbVersion = args.db.sync.getDbVersion();
    if (currentDbVersion <= outboundLocalDbVersion) return;
    const localSiteId = args.deviceRegistryService.getLocalSiteId();
    const changes = args.db.sync
      .exportChangesSince(outboundLocalDbVersion)
      .filter((change) => change.site_id === localSiteId);
    outboundLocalDbVersion = currentDbVersion;
    if (!changes.length) return;
    ws.send(
      encodeSyncEnvelope({
        type: "changeset_batch",
        payload: {
          reason: "relay",
          fromDbVersion: latestRemoteDbVersion,
          toDbVersion: latestRemoteDbVersion,
          changes,
        },
        compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
      }),
    );
  };

  const startRelay = () => {
    stopTimers();
    relayTimer = setInterval(() => {
      try {
        sendLocalChanges();
      } catch (error) {
        args.logger.warn("sync_peer.relay_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 400);
  };

  const startHeartbeatFallback = () => {
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        encodeSyncEnvelope({
          type: "heartbeat",
          payload: {
            kind: "ping",
            sentAt: nowIso(),
            dbVersion: latestRemoteDbVersion,
          },
        }),
      );
    }, 30_000);
  };

  const disconnectInternal = (state: SyncClientStatus["state"], message: string | null, error: string | null) => {
    stopTimers();
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // ignore
      }
    }
    ws = null;
    latestBrainStatus = null;
    latestBrainMetadata = null;
    status.state = state;
    status.connectedAt = null;
    status.lastSeenAt = null;
    status.latencyMs = null;
    status.syncLag = null;
    status.brainDeviceId = null;
    status.hostName = null;
    status.message = message;
    status.error = error;
    clearPendingRequests(error ?? message ?? "Sync peer disconnected.");
    emitStatus();
  };

  const handleMessage = (raw: RawData) => {
    const envelope = parseSyncEnvelope(wsDataToText(raw));
    status.lastSeenAt = nowIso();
    switch (envelope.type) {
      case "hello_ok": {
        const payload = envelope.payload as {
          brain: SyncPeerMetadata;
          serverDbVersion: number;
        };
        latestBrainMetadata = payload.brain;
        latestRemoteDbVersion = Math.max(0, Math.floor(payload.serverDbVersion ?? 0));
        status.state = "connected";
        status.connectedAt = nowIso();
        status.message = `Connected to host ${payload.brain.deviceName}.`;
        status.error = null;
        status.brainDeviceId = payload.brain.deviceId;
        status.hostName = payload.brain.deviceName;
        if (connectionDraft) {
          connectionDraft.lastRemoteDbVersion = latestRemoteDbVersion;
          connectionDraft.lastBrainDeviceId = payload.brain.deviceId;
        }
        outboundLocalDbVersion = args.db.sync.getDbVersion();
        emitStatus();
        startRelay();
        startHeartbeatFallback();
        pendingConnect?.resolve();
        pendingConnect = null;
        break;
      }
      case "hello_error": {
        const payload = envelope.payload as { message?: string };
        pendingConnect?.reject(new Error(payload?.message ?? "Sync peer authentication failed."));
        pendingConnect = null;
        disconnectInternal("error", null, payload?.message ?? "Sync peer authentication failed.");
        break;
      }
      case "changeset_batch": {
        const payload = (envelope.payload ?? {}) as SyncChangesetBatchPayload;
        const changes = Array.isArray(payload.changes) ? payload.changes : [];
        if (changes.length) {
          args.db.sync.applyChanges(changes);
          args.onRemoteChangesApplied?.();
        }
        latestRemoteDbVersion = Math.max(latestRemoteDbVersion, Math.floor(payload.toDbVersion ?? latestRemoteDbVersion));
        if (connectionDraft) connectionDraft.lastRemoteDbVersion = latestRemoteDbVersion;
        emitStatus();
        break;
      }
      case "brain_status": {
        const payload = envelope.payload as SyncBrainStatusPayload;
        latestBrainStatus = payload;
        latestBrainMetadata = payload.brain;
        status.brainDeviceId = payload.brain.deviceId;
        status.hostName = payload.brain.deviceName;
        const localDeviceId = args.deviceRegistryService.getLocalDeviceId();
        const localPeer = payload.connectedPeers.find((peer) => peer.deviceId === localDeviceId) ?? null;
        status.latencyMs = localPeer?.latencyMs ?? null;
        status.syncLag = localPeer?.syncLag ?? 0;
        args.onBrainStatus?.(payload);
        emitStatus();
        break;
      }
      case "heartbeat": {
        const payload = envelope.payload as { kind?: string; sentAt?: string };
        if (payload?.kind === "ping" && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            encodeSyncEnvelope({
              type: "heartbeat",
              requestId: envelope.requestId ?? null,
              payload: {
                kind: "pong",
                sentAt: payload.sentAt ?? nowIso(),
                dbVersion: latestRemoteDbVersion,
              },
            }),
          );
        }
        break;
      }
      case "command_ack":
      case "command_result": {
        const requestId = envelope.requestId ?? null;
        if (!requestId) break;
        const pending = pendingRequests.get(requestId);
        if (!pending) break;
        if (envelope.type === "command_result") {
          clearTimeout(pending.timer);
          pendingRequests.delete(requestId);
          const payload = envelope.payload as SyncCommandResultPayload;
          if (payload.ok) {
            pending.resolve(payload.result ?? null);
          } else {
            pending.reject(new Error(payload.error?.message ?? "Remote command failed."));
          }
        } else {
          const payload = envelope.payload as SyncCommandAckPayload;
          if (!payload.accepted) {
            clearTimeout(pending.timer);
            pendingRequests.delete(requestId);
            pending.reject(new Error(payload.message ?? "Remote command rejected."));
          }
        }
        break;
      }
      default:
        break;
    }
  };

  return {
    setSavedDraft(draft: SyncDesktopConnectionDraft | null): void {
      applyDraft(draft);
    },

    async connect(draft: SyncDesktopConnectionDraft): Promise<void> {
      if (disposed) {
        throw new Error("Sync peer service is disposed.");
      }
      this.disconnect({ preserveDraft: true });
      applyDraft(draft);
      latestRemoteDbVersion = Math.max(0, Math.floor(draft.lastRemoteDbVersion ?? 0));
      status.state = "connecting";
      status.host = draft.host.trim();
      status.port = Math.max(1, Math.floor(draft.port));
      status.message = `Connecting to ${status.host}:${String(status.port)}...`;
      status.error = null;
      emitStatus();

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${status.host}:${String(status.port)}`);
        ws = socket;
        pendingConnect = { resolve, reject };

        const cleanup = () => {
          socket.removeListener("open", onOpen);
          socket.removeListener("error", onError);
        };

        const onOpen = () => {
          cleanup();
          const peer = currentLocalPeerMetadata();
          const auth = draft.authKind === "paired" && draft.pairedDeviceId
            ? {
                kind: "paired" as const,
                deviceId: draft.pairedDeviceId,
                secret: draft.token,
              }
            : {
                kind: "bootstrap" as const,
                token: draft.token,
              };
          socket.send(
            encodeSyncEnvelope({
              type: "hello",
              requestId: "hello",
              payload: {
                peer,
                auth,
              },
              compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
            }),
          );
        };

        const onError = (error: Error) => {
          cleanup();
          pendingConnect?.reject(error);
          pendingConnect = null;
          disconnectInternal("error", null, error.message);
        };

        socket.once("open", onOpen);
        socket.once("error", onError);
        socket.on("message", (raw) => {
          try {
            handleMessage(raw);
          } catch (error) {
            args.logger.warn("sync_peer.message_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        socket.on("close", () => {
          if (disposed) return;
          if (pendingConnect) {
            pendingConnect.reject(new Error("Connection closed before authentication completed."));
            pendingConnect = null;
          }
          disconnectInternal("disconnected", "Disconnected from host.", null);
        });
      });
    },

    disconnect(options: { preserveDraft?: boolean } = {}): void {
      const nextDraft = options.preserveDraft ? connectionDraft : null;
      disconnectInternal("disconnected", connectionDraft ? "Disconnected from host." : null, null);
      if (!options.preserveDraft) {
        applyDraft(null);
      } else {
        applyDraft(nextDraft);
      }
    },

    getStatus(): SyncClientStatus {
      return { ...status };
    },

    getLatestBrainStatus(): SyncBrainStatusPayload | null {
      return latestBrainStatus ? { ...latestBrainStatus, connectedPeers: [...latestBrainStatus.connectedPeers] } : null;
    },

    getConnectionDraft(): SyncDesktopConnectionDraft | null {
      return connectionDraft ? { ...connectionDraft } : null;
    },

    isConnected(): boolean {
      return status.state === "connected" && Boolean(ws) && ws?.readyState === WebSocket.OPEN;
    },

    flushLocalChanges(): void {
      sendLocalChanges();
    },

    async executeRemoteCommand(action: SyncRemoteCommandAction | (string & {}), commandArgs: Record<string, unknown>): Promise<unknown> {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Not connected to a host device.");
      }
      const requestId = `sync-command-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error("Timed out waiting for remote command result."));
        }, 20_000);
        pendingRequests.set(requestId, { resolve, reject, timer });
      });
      ws.send(
        encodeSyncEnvelope({
          type: "command",
          requestId,
          payload: {
            commandId: requestId,
            action,
            args: commandArgs,
          },
          compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
        }),
      );
      return await promise;
    },

    async runQuickCommand(argsIn: SyncRunQuickCommandArgs): Promise<unknown> {
      return await this.executeRemoteCommand("work.runQuickCommand", argsIn);
    },

    async dispose(): Promise<void> {
      disposed = true;
      this.disconnect();
    },
  };
}

export type SyncPeerService = ReturnType<typeof createSyncPeerService>;
