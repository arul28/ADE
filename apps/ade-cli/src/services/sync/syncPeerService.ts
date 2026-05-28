import { WebSocket, type RawData } from "ws";
import type {
  SyncBrainStatusPayload,
  SyncChangesetAckPayload,
  SyncChangesetBatchPayload,
  SyncClientStatus,
  SyncCommandAckPayload,
  SyncCommandResultPayload,
  SyncDesktopConnectionDraft,
  SyncRemoteCommandAction,
  SyncPeerMetadata,
  SyncRunQuickCommandArgs,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { nowIso } from "../../../../desktop/src/main/services/shared/utils";
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
type PendingChangesetBatch = {
  batchId: string;
  payload: SyncChangesetBatchPayload;
  sentAtMs: number;
  retryCount: number;
};

const CHANGESET_ACK_TIMEOUT_MS = 10_000;
const MAX_CHANGESET_ACK_RETRIES = 6;

export function createSyncPeerService(args: SyncPeerServiceArgs) {
  let ws: WebSocket | null = null;
  let disposed = false;
  let relayTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let connectionDraft: SyncDesktopConnectionDraft | null = null;
  let latestBrainStatus: SyncBrainStatusPayload | null = null;
  let outboundLocalDbVersion = args.db.sync.getDbVersion();
  let latestRemoteDbVersion = 0;
  let pendingOutboundChangeset: PendingChangesetBatch | null = null;
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
          authKind: connectionDraft.authKind ?? "bootstrap",
          pairedDeviceId: connectionDraft.pairedDeviceId ?? null,
          lastRemoteDbVersion: connectionDraft.lastRemoteDbVersion ?? latestRemoteDbVersion,
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
      capabilities: ["changesetAck"],
    };
  };

  const sendChangesetAck = (
    batch: SyncChangesetBatchPayload,
    ok: boolean,
    appliedDbVersion: number,
    appliedCount: number,
    error?: unknown,
  ) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload: SyncChangesetAckPayload = {
      batchId: batch.batchId,
      fromDbVersion: Number(batch.fromDbVersion ?? 0),
      toDbVersion: Number(batch.toDbVersion ?? 0),
      appliedDbVersion,
      appliedCount,
      ok,
      ...(error
        ? { error: { code: "changeset_apply_failed", message: error instanceof Error ? error.message : String(error) } }
        : {}),
    };
    ws.send(
      encodeSyncEnvelope({
        type: "changeset_ack",
        requestId: batch.batchId,
        payload,
        compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
      }),
    );
  };

  const sendOutboundChangeset = (pending: PendingChangesetBatch) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(
      encodeSyncEnvelope({
        type: "changeset_batch",
        requestId: pending.batchId,
        payload: pending.payload,
        compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
      }),
    );
    return true;
  };

  const sendLocalChanges = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const nowMs = Date.now();
    if (pendingOutboundChangeset) {
      if (nowMs - pendingOutboundChangeset.sentAtMs >= CHANGESET_ACK_TIMEOUT_MS) {
        if (pendingOutboundChangeset.retryCount >= MAX_CHANGESET_ACK_RETRIES) {
          args.logger.warn("sync_peer.changeset_ack_timeout_exhausted", {
            batchId: pendingOutboundChangeset.batchId,
            retryCount: pendingOutboundChangeset.retryCount,
          });
          disconnectInternal("error", null, "Changeset acknowledgement timed out.");
          return;
        }
        pendingOutboundChangeset.sentAtMs = nowMs;
        pendingOutboundChangeset.retryCount += 1;
        sendOutboundChangeset(pendingOutboundChangeset);
      }
      return;
    }
    const currentDbVersion = args.db.sync.getDbVersion();
    if (currentDbVersion <= outboundLocalDbVersion) return;
    const localSiteId = args.deviceRegistryService.getLocalSiteId();
    const changes = args.db.sync
      .exportChangesSince(outboundLocalDbVersion)
      .filter((change) => change.site_id === localSiteId);
    const previousDbVersion = outboundLocalDbVersion;
    if (!changes.length) {
      outboundLocalDbVersion = currentDbVersion;
      return;
    }
    const batchId = `changeset:${currentLocalPeerMetadata().deviceId}:${previousDbVersion}:${currentDbVersion}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    pendingOutboundChangeset = {
      batchId,
      payload: {
        batchId,
        reason: "relay",
        fromDbVersion: previousDbVersion,
        toDbVersion: currentDbVersion,
        changes,
      },
      sentAtMs: nowMs,
      retryCount: 0,
    };
    sendOutboundChangeset(pendingOutboundChangeset);
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
    pendingOutboundChangeset = null;
    latestBrainStatus = null;
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
        latestRemoteDbVersion = Math.max(0, Math.floor(payload.serverDbVersion ?? 0));
        status.state = "connected";
        status.connectedAt = nowIso();
        status.message = `Connected to host ${payload.brain.deviceName}.`;
        status.error = null;
        status.brainDeviceId = payload.brain.deviceId;
        status.hostName = payload.brain.deviceName;
        if (connectionDraft) {
          connectionDraft.lastRemoteDbVersion = latestRemoteDbVersion;
        }
        outboundLocalDbVersion = Math.max(outboundLocalDbVersion, args.db.sync.getDbVersion());
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
        try {
          let appliedCount = 0;
          if (changes.length) {
            const applyResult = args.db.sync.applyChanges(changes);
            appliedCount = applyResult.appliedCount;
            args.onRemoteChangesApplied?.();
          }
          latestRemoteDbVersion = Math.max(latestRemoteDbVersion, Math.floor(payload.toDbVersion ?? latestRemoteDbVersion));
          if (connectionDraft) connectionDraft.lastRemoteDbVersion = latestRemoteDbVersion;
          sendChangesetAck(payload, true, args.db.sync.getDbVersion(), appliedCount);
          emitStatus();
        } catch (error) {
          sendChangesetAck(payload, false, args.db.sync.getDbVersion(), 0, error);
          throw error;
        }
        break;
      }
      case "changeset_ack": {
        const payload = envelope.payload as SyncChangesetAckPayload;
        if (!pendingOutboundChangeset || payload.batchId !== pendingOutboundChangeset.batchId) break;
        if (!payload.ok) {
          if (pendingOutboundChangeset.retryCount >= MAX_CHANGESET_ACK_RETRIES) {
            const message = payload.error?.message ?? "Changeset apply failed repeatedly.";
            args.logger.warn("sync_peer.changeset_ack_failed_exhausted", {
              batchId: pendingOutboundChangeset.batchId,
              retryCount: pendingOutboundChangeset.retryCount,
              error: message,
            });
            disconnectInternal("error", null, message);
            break;
          }
          pendingOutboundChangeset.sentAtMs = Date.now();
          pendingOutboundChangeset.retryCount += 1;
          args.logger.warn("sync_peer.changeset_ack_failed", {
            batchId: pendingOutboundChangeset.batchId,
            error: payload.error?.message ?? "Changeset apply failed.",
          });
          break;
        }
        if (payload.toDbVersion < pendingOutboundChangeset.payload.toDbVersion) break;
        const acknowledgedRemoteVersion = Math.max(
          latestRemoteDbVersion,
          pendingOutboundChangeset.payload.toDbVersion,
          Math.floor(payload.toDbVersion ?? 0),
        );
        latestRemoteDbVersion = acknowledgedRemoteVersion;
        if (connectionDraft) {
          connectionDraft.lastRemoteDbVersion = acknowledgedRemoteVersion;
        }
        outboundLocalDbVersion = Math.max(outboundLocalDbVersion, pendingOutboundChangeset.payload.toDbVersion);
        pendingOutboundChangeset = null;
        emitStatus();
        break;
      }
      case "brain_status": {
        const payload = envelope.payload as SyncBrainStatusPayload;
        latestBrainStatus = payload;
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

    acknowledgeLocalDbVersion(): void {
      pendingOutboundChangeset = null;
      outboundLocalDbVersion = args.db.sync.getDbVersion();
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
