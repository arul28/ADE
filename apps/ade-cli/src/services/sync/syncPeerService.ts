import { WebSocket, type RawData } from "ws";
import type {
  SyncBrainStatusPayload,
  SyncChangesetAckPayload,
  SyncChangesetBatchPayload,
  SyncClientStatus,
  SyncCommandAckPayload,
  SyncCommandResultPayload,
  SyncDesktopConnectionDraft,
  SyncHelloOkPayload,
  SyncRemoteCommandAction,
  SyncPeerMetadata,
  SyncRunQuickCommandArgs,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { nowIso } from "../../../../desktop/src/main/services/shared/utils";
import type { DeviceRegistryService } from "./deviceRegistryService";
import { DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES, encodeSyncEnvelope, parseSyncEnvelope, wsDataToText } from "./syncProtocol";
import {
  buildChangesetBatchPayload,
  DEFAULT_MAX_CHANGESET_BATCH_BYTES,
  DEFAULT_MAX_CHANGESET_BATCH_ROWS,
} from "./changesetPump";

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
  attemptCount: number;
  retryNotBeforeMs: number;
};

const CHANGESET_ACK_TIMEOUT_MS = 10_000;
const MAX_CHANGESET_SEND_ATTEMPTS = 6;
const MAX_OUTBOUND_CHANGESET_BATCH_BYTES = DEFAULT_MAX_CHANGESET_BATCH_BYTES;
const MAX_OUTBOUND_CHANGESET_BATCH_ROWS = DEFAULT_MAX_CHANGESET_BATCH_ROWS;
const MIN_RECOVERY_CHANGESET_BATCH_BYTES = 16 * 1024;
const MIN_RECOVERY_CHANGESET_BATCH_ROWS = 16;
const MAX_CHANGESET_RECOVERY_LEVEL = 4;
const CHANGESET_RECOVERY_BACKOFF_BASE_MS = 250;
const CHANGESET_RECOVERY_BACKOFF_MAX_MS = 4_000;
// See syncHostService SYNC_EXPORT_VERSION_WINDOW.
const OUTBOUND_EXPORT_VERSION_WINDOW = 250_000;
const DEFAULT_PEER_HEARTBEAT_INTERVAL_MS = 60_000;

export function peerHeartbeatFallbackDelayMs(intervalMs: number): number {
  return Math.max(10_000, Math.max(5_000, Math.floor(intervalMs)) * 2);
}

export function createSyncPeerService(args: SyncPeerServiceArgs) {
  let ws: WebSocket | null = null;
  let disposed = false;
  let relayTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatIntervalMs = DEFAULT_PEER_HEARTBEAT_INTERVAL_MS;
  let connectionDraft: SyncDesktopConnectionDraft | null = null;
  let latestBrainStatus: SyncBrainStatusPayload | null = null;
  let outboundLocalDbVersion = args.db.sync.getDbVersion();
  let latestRemoteDbVersion = 0;
  let pendingOutboundChangeset: PendingChangesetBatch | null = null;
  let outboundChangesetRecoveryLevel = 0;
  let outboundChangesetRecoveryNotBeforeMs = 0;
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
    hostDeviceId: null,
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
      clearTimeout(heartbeatTimer);
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
    try {
      ws.send(
        encodeSyncEnvelope({
          type: "changeset_batch",
          requestId: pending.batchId,
          payload: pending.payload,
          compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
        }),
      );
      return true;
    } catch {
      return false;
    }
  };

  const changesetRecoveryBackoffMs = (level: number): number => {
    const boundedLevel = Math.max(1, Math.min(MAX_CHANGESET_RECOVERY_LEVEL, Math.floor(level)));
    return Math.min(
      CHANGESET_RECOVERY_BACKOFF_MAX_MS,
      CHANGESET_RECOVERY_BACKOFF_BASE_MS * (2 ** (boundedLevel - 1)),
    );
  };

  const outboundChangesetBatchLimits = (): { maxRows: number; maxBytes: number } => {
    const divisor = 2 ** Math.max(0, outboundChangesetRecoveryLevel);
    return {
      maxRows: Math.max(MIN_RECOVERY_CHANGESET_BATCH_ROWS, Math.floor(MAX_OUTBOUND_CHANGESET_BATCH_ROWS / divisor)),
      maxBytes: Math.max(MIN_RECOVERY_CHANGESET_BATCH_BYTES, Math.floor(MAX_OUTBOUND_CHANGESET_BATCH_BYTES / divisor)),
    };
  };

  const abandonPendingOutboundChangeset = (
    reason: "ack_timeout" | "ack_failed",
    nowMs: number,
    error: string | null = null,
  ): void => {
    const pending = pendingOutboundChangeset;
    if (!pending) return;
    pendingOutboundChangeset = null;
    outboundChangesetRecoveryLevel = Math.min(
      MAX_CHANGESET_RECOVERY_LEVEL,
      outboundChangesetRecoveryLevel + 1,
    );
    const backoffMs = changesetRecoveryBackoffMs(outboundChangesetRecoveryLevel);
    outboundChangesetRecoveryNotBeforeMs = nowMs + backoffMs;
    const limits = outboundChangesetBatchLimits();
    args.logger.warn("sync_peer.changeset_recovery_started", {
      abandonedBatchId: pending.batchId,
      fromDbVersion: pending.payload.fromDbVersion,
      toDbVersion: pending.payload.toDbVersion,
      attemptCount: pending.attemptCount,
      reason,
      error,
      recoveryLevel: outboundChangesetRecoveryLevel,
      backoffMs,
      maxRows: limits.maxRows,
      maxBytes: limits.maxBytes,
    });
  };

  const resendPendingOutboundChangeset = (pending: PendingChangesetBatch): boolean => {
    if (!sendOutboundChangeset(pending)) return false;
    pending.sentAtMs = Date.now();
    pending.attemptCount += 1;
    pending.retryNotBeforeMs = 0;
    return true;
  };

  const sendLocalChanges = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const nowMs = Date.now();
    if (pendingOutboundChangeset) {
      const pending = pendingOutboundChangeset;
      const rejectedRetryDue = pending.retryNotBeforeMs > 0 && nowMs >= pending.retryNotBeforeMs;
      const ackTimedOut = pending.retryNotBeforeMs === 0
        && nowMs - pending.sentAtMs >= CHANGESET_ACK_TIMEOUT_MS;
      if (rejectedRetryDue || ackTimedOut) {
        if (pending.attemptCount >= MAX_CHANGESET_SEND_ATTEMPTS) {
          abandonPendingOutboundChangeset(ackTimedOut ? "ack_timeout" : "ack_failed", nowMs);
          return;
        }
        if (resendPendingOutboundChangeset(pending)) {
          args.logger.debug("sync_peer.changeset_ack_retry", {
            batchId: pending.batchId,
            attemptCount: pending.attemptCount,
            trigger: ackTimedOut ? "timeout" : "rejected",
          });
        }
      }
      return;
    }
    if (nowMs < outboundChangesetRecoveryNotBeforeMs) return;
    const currentDbVersion = args.db.sync.getDbVersion();
    if (currentDbVersion <= outboundLocalDbVersion) return;
    const localSiteId = args.deviceRegistryService.getLocalSiteId();
    const batchLimits = outboundChangesetBatchLimits();
    // Bounded export — scan a db_version window, not the whole backlog. An
    // open-ended scan of a deep backlog aborts under concurrent writes
    // (SQLITE_ABORT), permanently stalling the relay; empty windows advance
    // the cursor so sparse ranges are crossed in a few ticks.
    const scanThroughDbVersion = Math.min(
      outboundLocalDbVersion + OUTBOUND_EXPORT_VERSION_WINDOW,
      currentDbVersion,
    );
    const exported = args.db.sync.exportChangesSince(
      outboundLocalDbVersion,
      { maxRows: batchLimits.maxRows * 4, throughDbVersion: scanThroughDbVersion },
    );
    const exportedThroughDbVersion = exported.length > 0
      ? Number(exported[exported.length - 1].db_version)
      : scanThroughDbVersion;
    const changes = exported.filter((change) => change.site_id === localSiteId);
    const previousDbVersion = outboundLocalDbVersion;
    if (!changes.length) {
      outboundLocalDbVersion = exportedThroughDbVersion;
      return;
    }
    const payload = buildChangesetBatchPayload({
      deviceId: currentLocalPeerMetadata().deviceId,
      reason: "relay",
      fromDbVersion: previousDbVersion,
      toDbVersion: exportedThroughDbVersion,
      changes,
      maxRows: batchLimits.maxRows,
      maxBytes: batchLimits.maxBytes,
    });
    if (!payload) return;
    const pending: PendingChangesetBatch = {
      batchId: payload.batchId,
      payload,
      sentAtMs: 0,
      attemptCount: 0,
      retryNotBeforeMs: 0,
    };
    if (!sendOutboundChangeset(pending)) return;
    pending.sentAtMs = Date.now();
    pending.attemptCount = 1;
    outboundChangesetRecoveryNotBeforeMs = 0;
    pendingOutboundChangeset = pending;
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

  const scheduleHeartbeatFallback = (nextIntervalMs = heartbeatIntervalMs) => {
    heartbeatIntervalMs = Math.max(5_000, Math.floor(nextIntervalMs));
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
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
      scheduleHeartbeatFallback();
    }, peerHeartbeatFallbackDelayMs(heartbeatIntervalMs));
    heartbeatTimer.unref?.();
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
    outboundChangesetRecoveryLevel = 0;
    outboundChangesetRecoveryNotBeforeMs = 0;
    latestBrainStatus = null;
    status.state = state;
    status.connectedAt = null;
    status.lastSeenAt = null;
    status.latencyMs = null;
    status.syncLag = null;
    status.brainDeviceId = null;
    status.hostDeviceId = null;
    status.hostName = null;
    status.message = message;
    status.error = error;
    clearPendingRequests(error ?? message ?? "Sync peer disconnected.");
    emitStatus();
  };

  const handleMessage = (raw: RawData) => {
    const envelope = parseSyncEnvelope(wsDataToText(raw));
    status.lastSeenAt = nowIso();
    if (status.state === "connected") scheduleHeartbeatFallback();
    switch (envelope.type) {
      case "hello_ok": {
        const payload = envelope.payload as SyncHelloOkPayload & { host?: SyncPeerMetadata };
        const host = payload.host ?? payload.brain;
        latestRemoteDbVersion = Math.max(0, Math.floor(payload.serverDbVersion ?? 0));
        status.state = "connected";
        status.connectedAt = nowIso();
        status.message = `Connected to host ${host.deviceName}.`;
        status.error = null;
        status.brainDeviceId = payload.brain.deviceId;
        status.hostDeviceId = host.deviceId;
        status.hostName = host.deviceName;
        if (connectionDraft) {
          connectionDraft.lastRemoteDbVersion = latestRemoteDbVersion;
        }
        outboundLocalDbVersion = Math.max(outboundLocalDbVersion, args.db.sync.getDbVersion());
        emitStatus();
        startRelay();
        scheduleHeartbeatFallback(payload.heartbeatIntervalMs);
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
          const nowMs = Date.now();
          const message = payload.error?.message ?? "Changeset apply failed.";
          if (pendingOutboundChangeset.attemptCount >= MAX_CHANGESET_SEND_ATTEMPTS) {
            abandonPendingOutboundChangeset("ack_failed", nowMs, message);
            break;
          }
          const retryInMs = changesetRecoveryBackoffMs(pendingOutboundChangeset.attemptCount);
          pendingOutboundChangeset.retryNotBeforeMs = nowMs + retryInMs;
          args.logger.warn("sync_peer.changeset_ack_failed", {
            batchId: pendingOutboundChangeset.batchId,
            attemptCount: pendingOutboundChangeset.attemptCount,
            retryInMs,
            error: message,
          });
          break;
        }
        if (payload.toDbVersion < pendingOutboundChangeset.payload.toDbVersion) break;
        const recoveryLevel = outboundChangesetRecoveryLevel;
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
        outboundChangesetRecoveryLevel = 0;
        outboundChangesetRecoveryNotBeforeMs = 0;
        if (recoveryLevel > 0) {
          args.logger.debug("sync_peer.changeset_recovery_reset", {
            previousRecoveryLevel: recoveryLevel,
          });
        }
        emitStatus();
        break;
      }
      case "brain_status": {
        const payload = envelope.payload as SyncBrainStatusPayload;
        const host = payload.host ?? payload.brain;
        latestBrainStatus = payload;
        status.brainDeviceId = payload.brain.deviceId;
        status.hostDeviceId = host.deviceId;
        status.hostName = host.deviceName;
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
      outboundChangesetRecoveryLevel = 0;
      outboundChangesetRecoveryNotBeforeMs = 0;
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
