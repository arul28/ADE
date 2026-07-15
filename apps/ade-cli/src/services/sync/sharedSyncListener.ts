import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import { DEFAULT_SYNC_HOST_PORT } from "./syncProtocol";
import {
  assertAdeLoopbackListener,
  isLoopbackShadowedError,
  probeAdeLoopbackListener,
  type SyncLoopbackProbeResult,
  type SyncLoopbackValidationStatus,
} from "./syncLoopbackProbe";

// Bind the sync host on all interfaces by default so phones on the same
// wifi/LAN can reach it without Tailscale. 0.0.0.0 is a superset of loopback,
// so local TUI/desktop clients (and the unix RPC socket, which is separate)
// keep working unchanged. Operators who want the old loopback-only posture can
// set ADE_SYNC_BIND_HOST=127.0.0.1; that mode also relaxes the PIN requirement
// for new bootstrap-token devices (see the hello handler in syncHostService)
// since loopback is already a trust boundary.
export const SYNC_HOST_BIND_HOST: string = process.env.ADE_SYNC_BIND_HOST?.trim() || "0.0.0.0";
const SYNC_HOST_BIND_HOST_NORMALIZED = SYNC_HOST_BIND_HOST.toLowerCase();
// When the host is bound to loopback only, the OS already restricts connections
// to local processes, so first-pairing can fall back to the historical
// bootstrap-token behaviour. Any non-loopback bind (the LAN default) must gate
// new devices behind the PIN flow.
export const SYNC_HOST_BIND_LOOPBACK_ONLY: boolean =
  SYNC_HOST_BIND_HOST_NORMALIZED === "127.0.0.1"
  || SYNC_HOST_BIND_HOST_NORMALIZED === "::1"
  || SYNC_HOST_BIND_HOST_NORMALIZED === "localhost";

export const SYNC_HOST_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

// How long an unowned socket may sit parked (between sync host services, or
// before the first one attaches) before the listener gives up and closes it.
const DEFAULT_PARKED_PEER_GRACE_MS = 30_000;
// Frames buffered per parked socket while no host owns it. The handshake plus
// a few in-flight requests fit comfortably; anything beyond signals a peer
// flooding an unowned socket.
const PARKED_MESSAGE_BUFFER_LIMIT = 256;
const PARKED_MESSAGE_BUFFER_BYTES = 512 * 1024;
// Mirror of the syncService preferred-port semantics: insist on the first
// candidate for ~3.2s before drifting, so a dying listener from a previous
// brain process can free the port paired phones have saved.
const PREFERRED_PORT_BIND_ATTEMPTS = 8;
const PREFERRED_PORT_BIND_RETRY_DELAY_MS = 400;

type SharedSyncListenerLogger = {
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

export type SharedSyncListenerConnection = {
  ws: WebSocket;
  remoteAddress: string | null;
  remotePort: number | null;
};

export type SharedSyncListenerConnectionHandler = (connection: SharedSyncListenerConnection) => void;

/**
 * Authenticated peer state exported by a sync host service on dispose so the
 * NEXT hosted project's sync host can adopt the live socket without the phone
 * ever observing a disconnect. `bufferedMessages` are frames that arrived
 * while no host owned the socket; the adopting host replays them after
 * attaching its own listeners.
 */
export type SyncPeerHandoffSnapshot = {
  ws: WebSocket;
  remoteAddress: string | null;
  remotePort: number | null;
  metadata: SyncPeerMetadata | null;
  authKind: "bootstrap" | "paired" | "account" | null;
  pairedDeviceId: string | null;
  connectedAt: string;
  /**
   * Site id of the project DB the depositing host was serving plus the peer's
   * live ack watermark on that DB. When the adopting host serves the SAME DB
   * (e.g. a same-project host restart) this is fresher than the hello-time
   * `metadata.dbVersionBySite` snapshot and avoids re-draining the backlog.
   */
  serverDbSiteId?: string | null;
  lastKnownServerDbVersion?: number;
  /** Live terminal/chat subscriptions to restore on adoption so streaming
   * does not silently stop for peers that never observe a disconnect. */
  subscribedSessionIds?: string[];
  /**
   * Chat subscriptions that are safe to restore on a different hosted
   * project. Personal chats are machine-scoped, so they survive a project
   * host handoff; foreign-project quick-look subscriptions do not.
   */
  chatSubscriptions?: Array<{
    sessionId: string;
    scope: "project" | "personal";
  }>;
  /** Legacy project-chat handoff shape. */
  subscribedChatSessionIds?: string[];
  chatTranscriptOffsets?: Record<string, number>;
  /** All-projects roster (mobile hub) subscription, restored on adoption so a
   * hosted-project switch does not silently stop the hub feed. */
  rosterSubscribed?: boolean;
  /** Peer-local product analytics consent survives only live socket handoffs. */
  productAnalyticsEnabled?: boolean;
  bufferedMessages?: Array<{ data: RawData; isBinary: boolean }>;
};

export type SharedSyncListener = {
  /**
   * Bind the websocket server once. Subsequent calls return the existing
   * port — project switches never rebind, so connected peers survive them.
   */
  ensureListening(portCandidates: number[]): Promise<number>;
  getPort(): number | null;
  isListening(): boolean;
  getLoopbackValidationStatus(): SyncLoopbackValidationStatus;
  /**
   * Install the connection handler for NEW sockets. Returns a detach function
   * that only clears the handler if it has not been superseded by a newer
   * host service.
   */
  setConnectionHandler(handler: SharedSyncListenerConnectionHandler): () => void;
  /**
   * Machine-wide handler used when no project sync host currently owns new
   * sockets. Project hosts still take precedence once they attach.
   */
  setFallbackConnectionHandler(handler: SharedSyncListenerConnectionHandler | null): () => void;
  /** Park live peer sockets for adoption by the next host service. */
  depositPeers(snapshots: SyncPeerHandoffSnapshot[]): void;
  /** Claim every parked socket (deposited peers + connections that arrived handler-less). */
  takePeers(): SyncPeerHandoffSnapshot[];
  /** Final shutdown: closes every socket (parked and connected) and the server. */
  close(): Promise<void>;
};

type ParkedEntry = {
  snapshot: SyncPeerHandoffSnapshot;
  bufferedMessages: Array<{ data: RawData; isBinary: boolean }>;
  bufferedBytes: number;
  onMessage: (data: RawData, isBinary: boolean) => void;
  onClose: () => void;
  onError: (error: Error) => void;
  expireTimer: ReturnType<typeof setTimeout>;
};

function isRetryableListenerBindError(error: unknown): boolean {
  if (isLoopbackShadowedError(error)) return true;
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? "";
  return code === "EADDRINUSE" || code === "EACCES";
}

async function closeCandidateServer(candidateServer: WebSocketServer): Promise<void> {
  for (const client of candidateServer.clients) {
    try {
      client.terminate();
    } catch {
      // ignore cleanup failures on a rejected candidate
    }
  }
  await new Promise<void>((resolve) => {
    try {
      candidateServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function rawDataBytes(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) {
    return data.reduce((sum, chunk) => sum + rawDataBytes(chunk), 0);
  }
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.byteLength(String(data), "utf8");
}

export function createSharedSyncListener(options: {
  logger?: SharedSyncListenerLogger;
  bindHost?: string;
  maxPayloadBytes?: number;
  parkedPeerGraceMs?: number;
  loopbackProbe?: (port: number) => Promise<SyncLoopbackProbeResult>;
} = {}): SharedSyncListener {
  const logger = options.logger ?? {};
  const bindHost = options.bindHost ?? SYNC_HOST_BIND_HOST;
  const maxPayloadBytes = options.maxPayloadBytes ?? SYNC_HOST_MAX_PAYLOAD_BYTES;
  const parkedPeerGraceMs = Math.max(50, Math.floor(options.parkedPeerGraceMs ?? DEFAULT_PARKED_PEER_GRACE_MS));
  const loopbackProbe = options.loopbackProbe ?? probeAdeLoopbackListener;

  let server: WebSocketServer | null = null;
  let listeningPromise: Promise<number> | null = null;
  let handler: SharedSyncListenerConnectionHandler | null = null;
  let fallbackHandler: SharedSyncListenerConnectionHandler | null = null;
  let fallbackSuppressedUntilMs = 0;
  let closed = false;
  let loopbackValidationStatus: SyncLoopbackValidationStatus = {
    port: null,
    loopbackAdeValidated: false,
    lastFailureAt: null,
    reason: "The shared sync listener has not been validated yet.",
    lastSuccessAt: null,
  };
  const parked = new Map<WebSocket, ParkedEntry>();

  const unpark = (entry: ParkedEntry): void => {
    clearTimeout(entry.expireTimer);
    entry.snapshot.ws.off("message", entry.onMessage);
    entry.snapshot.ws.off("close", entry.onClose);
    entry.snapshot.ws.off("error", entry.onError);
    parked.delete(entry.snapshot.ws);
  };

  const park = (snapshot: SyncPeerHandoffSnapshot): void => {
    const ws = snapshot.ws;
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      // The depositing host already stripped its listeners; without an error
      // handler a late transport error on the dying socket would crash the
      // process.
      ws.on("error", () => {});
      try {
        ws.close();
      } catch {
        // ignore close failures
      }
      return;
    }
    const bufferedMessages: Array<{ data: RawData; isBinary: boolean }> = [];
    let bufferedBytes = 0;
    for (const message of snapshot.bufferedMessages ?? []) {
      const messageBytes = rawDataBytes(message.data);
      if (
        bufferedMessages.length >= PARKED_MESSAGE_BUFFER_LIMIT ||
        bufferedBytes + messageBytes > PARKED_MESSAGE_BUFFER_BYTES
      ) {
        try {
          ws.close(4002, "Sync host handoff buffer exceeded");
        } catch {}
        return;
      }
      bufferedMessages.push(message);
      bufferedBytes += messageBytes;
    }
    const entry: ParkedEntry = {
      snapshot: { ...snapshot, bufferedMessages },
      bufferedMessages,
      bufferedBytes,
      onMessage: (data, isBinary) => {
        // Buffer frames that arrive while no host owns the socket so the
        // adopting host can replay them (e.g. a hello sent mid-handoff).
        const messageBytes = rawDataBytes(data);
        if (
          bufferedMessages.length >= PARKED_MESSAGE_BUFFER_LIMIT ||
          entry.bufferedBytes + messageBytes > PARKED_MESSAGE_BUFFER_BYTES
        ) {
          unpark(entry);
          logger.warn?.("sync_listener.parked_peer_buffer_overflow", {
            peerDeviceId: snapshot.metadata?.deviceId ?? snapshot.pairedDeviceId ?? null,
            bufferedMessages: bufferedMessages.length,
            bufferedBytes: entry.bufferedBytes,
            nextMessageBytes: messageBytes,
          });
          try {
            ws.close(4002, "Sync host handoff buffer exceeded");
          } catch {
            // ignore close failures
          }
          return;
        }
        bufferedMessages.push({ data, isBinary });
        entry.bufferedBytes += messageBytes;
      },
      onClose: () => {
        const existing = parked.get(ws);
        if (existing) unpark(existing);
      },
      onError: (error: Error) => {
        // A parked socket has no other error listener; without this handler an
        // emitted 'error' would crash the process.
        logger.warn?.("sync_listener.parked_socket_error", {
          error: error.message,
          peerDeviceId: snapshot.metadata?.deviceId ?? snapshot.pairedDeviceId ?? null,
        });
      },
      expireTimer: setTimeout(() => {
        const existing = parked.get(ws);
        if (!existing) return;
        unpark(existing);
        logger.info?.("sync_listener.parked_peer_expired", {
          peerDeviceId: snapshot.metadata?.deviceId ?? snapshot.pairedDeviceId ?? null,
          remoteAddress: snapshot.remoteAddress ?? null,
        });
        try {
          ws.close(4002, "Sync host changed projects");
        } catch {
          // ignore close failures
        }
      }, parkedPeerGraceMs),
    };
    entry.expireTimer.unref?.();
    ws.on("message", entry.onMessage);
    ws.on("close", entry.onClose);
    ws.on("error", entry.onError);
    parked.set(ws, entry);
  };

  const bindOnce = async (portCandidates: number[]): Promise<number> => {
    const candidates = portCandidates.length > 0 ? portCandidates : [DEFAULT_SYNC_HOST_PORT];
    const attemptPlan = candidates.flatMap((candidatePort, candidateIndex) =>
      candidateIndex === 0 && candidatePort !== 0
        ? Array.from({ length: PREFERRED_PORT_BIND_ATTEMPTS }, () => candidatePort)
        : [candidatePort],
    );
    let lastError: unknown = null;
    let previousAttemptedPort: number | null = null;
    const shadowedPorts = new Set<number>();
    for (const attemptedPort of attemptPlan) {
      if (closed) throw new Error("The shared sync listener has been closed.");
      if (shadowedPorts.has(attemptedPort)) continue;
      if (previousAttemptedPort === attemptedPort) {
        await new Promise((resolve) => setTimeout(resolve, PREFERRED_PORT_BIND_RETRY_DELAY_MS));
      }
      previousAttemptedPort = attemptedPort;
      const candidateServer = new WebSocketServer({
        host: bindHost,
        port: attemptedPort,
        maxPayload: maxPayloadBytes,
      });
      // Install the handler before the validation RTT so a LAN peer that
      // arrives in that narrow window is parked/owned instead of orphaned.
      candidateServer.on("connection", (ws, request) => {
        const connection: SharedSyncListenerConnection = {
          ws,
          remoteAddress: request.socket.remoteAddress ?? null,
          remotePort: request.socket.remotePort ?? null,
        };
        const fallbackSuppressed = fallbackSuppressedUntilMs > Date.now();
        const activeHandler = handler ?? (fallbackSuppressed ? null : fallbackHandler);
        if (activeHandler) {
          activeHandler(connection);
          return;
        }
        park({
          ws,
          remoteAddress: connection.remoteAddress,
          remotePort: connection.remotePort,
          metadata: null,
          authKind: null,
          pairedDeviceId: null,
          connectedAt: new Date().toISOString(),
        });
      });
      try {
        const resolvedPort = await new Promise<number>((resolve, reject) => {
          const onListening = async () => {
            const address = candidateServer.address();
            const port = typeof address === "object" && address ? address.port : attemptedPort;
            try {
              const result = await assertAdeLoopbackListener(port, loopbackProbe);
              cleanup();
              loopbackValidationStatus = {
                port,
                loopbackAdeValidated: true,
                lastFailureAt: loopbackValidationStatus.lastFailureAt,
                reason: null,
                lastSuccessAt: result.checkedAt,
              };
              resolve(port);
            } catch (error) {
              cleanup();
              if (isLoopbackShadowedError(error)) {
                loopbackValidationStatus = {
                  port,
                  loopbackAdeValidated: false,
                  lastFailureAt: error.failedAt,
                  reason: error.message,
                  lastSuccessAt: loopbackValidationStatus.lastSuccessAt,
                };
              }
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
          const onError = (error: unknown) => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          };
          const handleListening = () => {
            void onListening();
          };
          const cleanup = () => {
            candidateServer.off("listening", handleListening);
            candidateServer.off("error", onError);
          };
          candidateServer.on("listening", handleListening);
          candidateServer.on("error", onError);
        });
        server = candidateServer;
        server.on("error", (error: unknown) => {
          logger.warn?.("sync_listener.server_error", {
            error: error instanceof Error ? error.message : String(error),
            code: (error as NodeJS.ErrnoException | null | undefined)?.code ?? null,
            port: resolvedPort,
          });
        });
        return resolvedPort;
      } catch (error) {
        lastError = error;
        await closeCandidateServer(candidateServer);
        if (isLoopbackShadowedError(error)) shadowedPorts.add(attemptedPort);
        const retryable = isRetryableListenerBindError(error)
          && (attemptedPort !== 0 || isLoopbackShadowedError(error));
        logger.warn?.(
          isLoopbackShadowedError(error)
            ? "sync_listener.loopback_shadowed"
            : retryable ? "sync_listener.bind_port_conflict" : "sync_listener.bind_failed",
          {
            attemptedPort,
            error: error instanceof Error ? error.message : String(error),
            code: (error as NodeJS.ErrnoException | null | undefined)?.code ?? null,
          },
        );
        if (!retryable) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to bind the shared sync listener.");
  };

  return {
    async ensureListening(portCandidates: number[]): Promise<number> {
      if (closed) throw new Error("The shared sync listener has been closed.");
      if (!listeningPromise) {
        listeningPromise = bindOnce(portCandidates).catch((error) => {
          // A failed bind must not poison future attempts.
          listeningPromise = null;
          throw error;
        });
      }
      return await listeningPromise;
    },

    getPort(): number | null {
      const address = server?.address();
      return typeof address === "object" && address ? address.port : null;
    },

    isListening(): boolean {
      return server?.address() != null;
    },

    getLoopbackValidationStatus(): SyncLoopbackValidationStatus {
      return { ...loopbackValidationStatus };
    },

    setConnectionHandler(nextHandler: SharedSyncListenerConnectionHandler): () => void {
      handler = nextHandler;
      fallbackSuppressedUntilMs = 0;
      return () => {
        if (handler === nextHandler) {
          handler = null;
          fallbackSuppressedUntilMs = Date.now() + parkedPeerGraceMs;
        }
      };
    },

    setFallbackConnectionHandler(nextHandler: SharedSyncListenerConnectionHandler | null): () => void {
      fallbackHandler = nextHandler;
      return () => {
        if (fallbackHandler === nextHandler) {
          fallbackHandler = null;
        }
      };
    },

    depositPeers(snapshots: SyncPeerHandoffSnapshot[]): void {
      if (closed) {
        for (const snapshot of snapshots) {
          try {
            snapshot.ws.close();
          } catch {
            // ignore close failures
          }
        }
        return;
      }
      for (const snapshot of snapshots) {
        park(snapshot);
      }
    },

    takePeers(): SyncPeerHandoffSnapshot[] {
      const snapshots: SyncPeerHandoffSnapshot[] = [];
      for (const entry of [...parked.values()]) {
        unpark(entry);
        snapshots.push(entry.snapshot);
      }
      return snapshots;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      handler = null;
      fallbackHandler = null;
      if (listeningPromise) {
        await listeningPromise.catch(() => {});
      }
      for (const entry of [...parked.values()]) {
        unpark(entry);
        try {
          entry.snapshot.ws.close();
        } catch {
          // ignore close failures
        }
      }
      const current = server;
      server = null;
      if (!current) return;
      for (const ws of current.clients) {
        try {
          ws.close();
        } catch {
          // ignore close failures
        }
      }
      await new Promise<void>((resolve) => {
        try {
          current.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
