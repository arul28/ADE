import http from "node:http";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type {
  SyncApplicationCompressionCodec,
  SyncPeerMetadata,
} from "../../../../desktop/src/shared/types";
import { WEB_CLIENT_BASE_URL } from "../../../../desktop/src/shared/webClientUrl";
import { DEFAULT_SYNC_HOST_PORT, SYNC_HOST_MAX_PORT } from "./syncProtocol";
import type { RelayAuthorizationSnapshot } from "./relayAuthorization";
import {
  assertAdeLoopbackListener,
  generateLoopbackNonce,
  isLoopbackShadowedError,
  probeAdeLoopbackListener,
  writeAdeLoopbackUpgradeResponse,
  type SyncLoopbackProbeResult,
  type SyncLoopbackValidationStatus,
} from "./syncLoopbackProbe";
import {
  isStaleChannelServeCommandLine,
  resolveAdeServeCliScriptPath,
  resolveAdeServeCommand,
  terminatePidGracefullyAsync,
} from "../../serviceManager/common";
import { getRuntimeServiceMainPid } from "../../serviceManager";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import { resolveMachineAdeLayout } from "../projects/machineLayout";

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
export const SYNC_RELAY_BRIDGE_PROOF_HEADER = "x-ade-sync-relay-bridge";
export const SYNC_WEBSOCKET_PATH = "/";
export const SYNC_BROWSER_ORIGINS: ReadonlySet<string> = new Set([
  new URL(WEB_CLIENT_BASE_URL).origin,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export type SyncTransportOrigin = "direct" | "relay-bridge";

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
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

export type SyncListenerPortDiagnosis = {
  port: number;
  holders: Array<{
    pid: number;
    command: string | null;
    /** Stable process birth identity used to guard against PID reuse. */
    startTime: string | null;
  }>;
};

export type SharedSyncListenerConnection = {
  ws: WebSocket;
  remoteAddress: string | null;
  remotePort: number | null;
  transportOrigin: SyncTransportOrigin;
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
  transportOrigin: SyncTransportOrigin;
  metadata: SyncPeerMetadata | null;
  /** Negotiated application codec for a live socket crossing a project handoff. */
  negotiatedCompression?: SyncApplicationCompressionCodec | null;
  authKind: "bootstrap" | "paired" | "account" | null;
  pairedDeviceId: string | null;
  connectedAt: string;
  /** Ephemeral Relay account-proof expiry; never contains the bearer. */
  relayAccountExpiresAtMs?: number | null;
  /** Full in-place Relay authorization lease state for capable peer handoff. */
  relayAuthorization?: RelayAuthorizationSnapshot | null;
  /**
   * Bounded terminal-input receipts for this device. Only SHA-256 payload
   * fingerprints are retained; terminal bytes never enter handoff state.
   */
  terminalInputDedupe?: Array<{
    deviceId: string;
    sessionId: string;
    inputId: string;
    dataFingerprint: string;
    recordedAtMs: number;
  }>;
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
  /**
   * Highest host-assigned chat-event sequence for each handed-off
   * subscription. The next project host restores these before it resumes the
   * live socket, so a host rehydration cannot reuse `(sessionId, seq)`.
   */
  chatEventSequences?: Record<string, number>;
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
  getExpectedLoopbackNonce(): string;
  /** Private in-process credential attached only by the trusted relay tunnel client. */
  getRelayBridgeProof(): string;
  getLoopbackValidationStatus(): SyncLoopbackValidationStatus;
  /** Force-check that loopback still reaches this exact listener instance. */
  revalidateLoopback(): Promise<void>;
  /** Subscribe to successful initial and explicit loopback validations. */
  onLoopbackValidated(handler: () => void): () => void;
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

// `lsof`/`ps` answer in a few milliseconds. PowerShell needs to start a
// runtime and load a CIM module first, so the POSIX budget would kill every
// Windows query before it produced a holder.
const PORT_INSPECT_TIMEOUT_MS = 200;
const WINDOWS_PORT_INSPECT_TIMEOUT_MS = 5_000;

function execFileText(
  command: string,
  args: string[],
  timeoutMs: number = PORT_INSPECT_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error ? null : String(stdout ?? ""));
      },
    );
  });
}

function isRetryableListenerBindError(error: unknown): boolean {
  if (isLoopbackShadowedError(error)) return true;
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? "";
  return code === "EADDRINUSE" || code === "EACCES";
}

async function closeCandidateServer(
  candidateServer: WebSocketServer,
  candidateHttpServer: http.Server,
): Promise<void> {
  for (const client of candidateServer.clients) {
    try {
      client.terminate();
    } catch {
      // ignore cleanup failures on a rejected candidate
    }
  }
  // Closing the WebSocketServer only detaches its listeners from the
  // externally-supplied http server; the http server owns the port and must be
  // closed explicitly so a rejected candidate does not leak the bind. ws's
  // close() for an external server resolves only after every client drains, so
  // close the http server directly (forcing lingering sockets) instead.
  try {
    candidateServer.close();
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => {
    if (!candidateHttpServer.listening) {
      resolve();
      return;
    }
    try {
      candidateHttpServer.close(() => resolve());
      candidateHttpServer.closeAllConnections?.();
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

function hasValidRelayBridgeProof(request: http.IncomingMessage, expectedProof: Buffer): boolean {
  const rawProof = request.headers[SYNC_RELAY_BRIDGE_PROOF_HEADER];
  const proof = Array.isArray(rawProof) ? rawProof[0] : rawProof;
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  const decoded = Buffer.from(proof, "base64url");
  if (decoded.length !== expectedProof.length) {
    timingSafeEqual(expectedProof, Buffer.alloc(expectedProof.length));
    return false;
  }
  return timingSafeEqual(expectedProof, decoded);
}

export function createSharedSyncListener(options: {
  logger?: SharedSyncListenerLogger;
  bindHost?: string;
  maxPayloadBytes?: number;
  parkedPeerGraceMs?: number;
  loopbackProbe?: (port: number, expectedNonce: string) => Promise<SyncLoopbackProbeResult>;
  inspectPort?: (port: number) => SyncListenerPortDiagnosis | Promise<SyncListenerPortDiagnosis>;
  activeServicePid?: () => number | null;
  terminatePid?: (pid: number) => Promise<void>;
} = {}): SharedSyncListener {
  const logger = options.logger ?? {};
  const bindHost = options.bindHost ?? SYNC_HOST_BIND_HOST;
  const maxPayloadBytes = options.maxPayloadBytes ?? SYNC_HOST_MAX_PAYLOAD_BYTES;
  const parkedPeerGraceMs = Math.max(50, Math.floor(options.parkedPeerGraceMs ?? DEFAULT_PARKED_PEER_GRACE_MS));
  const loopbackProbe = options.loopbackProbe ?? probeAdeLoopbackListener;
  const inspectPort = options.inspectPort ?? inspectSyncListenerPort;
  const activeServicePid = options.activeServicePid ?? getRuntimeServiceMainPid;
  const terminatePid = options.terminatePid ?? ((pid) => terminatePidGracefullyAsync(pid));
  const serviceCommand = resolveAdeServeCommand();
  const staleServeMatch = {
    cliScriptPath: resolveAdeServeCliScriptPath(serviceCommand),
    primarySocketPath: resolveMachineAdeLayout().socketPath,
  };
  const findStaleHolder = (
    diagnosis: SyncListenerPortDiagnosis,
  ): SyncListenerPortDiagnosis["holders"][number] | null => {
    const excludedPids = new Set([
      process.pid,
      activeServicePid() ?? -1,
    ]);
    return diagnosis.holders.find((holder) =>
      !excludedPids.has(holder.pid)
      && holder.command != null
      && isStaleChannelServeCommandLine(holder.command, staleServeMatch),
    ) ?? null;
  };
  // One identity per listener instance. Every candidate bind for this
  // instance emits the same nonce, and only in-process validators receive the
  // expected value they must compare against.
  const expectedLoopbackNonce = generateLoopbackNonce();
  // Separate from the public 426-probe nonce: this credential is disclosed
  // only to the in-process tunnel client and rotates with the listener process.
  const relayBridgeProofBytes = randomBytes(32);
  const relayBridgeProof = relayBridgeProofBytes.toString("base64url");

  let server: WebSocketServer | null = null;
  // The http.Server fronting `server`. `ws` does not own/close an
  // externally-supplied server, so we track it to free the port on close.
  let httpServer: http.Server | null = null;
  let listeningPromise: Promise<number> | null = null;
  let handler: SharedSyncListenerConnectionHandler | null = null;
  let fallbackHandler: SharedSyncListenerConnectionHandler | null = null;
  let fallbackSuppressedUntilMs = 0;
  let closed = false;
  const loopbackValidatedHandlers = new Set<() => void>();
  let loopbackValidationStatus: SyncLoopbackValidationStatus = {
    port: null,
    loopbackAdeValidated: false,
    lastFailureAt: null,
    reason: "The shared sync listener has not been validated yet.",
    lastSuccessAt: null,
  };
  const parked = new Map<WebSocket, ParkedEntry>();

  const notifyLoopbackValidated = (): void => {
    for (const next of loopbackValidatedHandlers) {
      try {
        next();
      } catch (error) {
        logger.warn?.("sync_listener.validation_handler_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const validateLoopback = async (port: number): Promise<void> => {
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
    // A fixed preferred port is re-attempted so a dying listener can free it.
    // An ephemeral port (0) is ALSO re-attempted, but for a different reason:
    // each bind(0) yields a fresh OS-assigned port, so a loopback shadow on the
    // first resolved port is escaped simply by re-binding. Both are bounded by
    // PREFERRED_PORT_BIND_ATTEMPTS so a persistent shadow still terminates.
    const attemptPlan = candidates.flatMap((candidatePort, candidateIndex) =>
      (candidateIndex === 0 && candidatePort !== 0) || candidatePort === 0
        ? Array.from({ length: PREFERRED_PORT_BIND_ATTEMPTS }, () => candidatePort)
        : [candidatePort],
    );
    let lastError: unknown = null;
    let previousAttemptedPort: number | null = null;
    // Tracks RESOLVED shadowed ports. For port 0 the literal 0 is never added
    // (each re-bind resolves a different port), so a shadow on one ephemeral
    // port does not short-circuit the remaining fresh-port attempts.
    const shadowedPorts = new Set<number>();
    const occupiedPorts = new Set<number>();
    const loggedConflictPorts = new Set<number>();
    const zombieReapedPorts = new Set<number>();
    const portDiagnoses = new Map<number, SyncListenerPortDiagnosis>();
    const diagnosePort = async (
      port: number,
      refresh = false,
    ): Promise<SyncListenerPortDiagnosis> => {
      if (!refresh) {
        const cached = portDiagnoses.get(port);
        if (cached) return cached;
      }
      const diagnosis = await inspectPort(port);
      portDiagnoses.set(port, diagnosis);
      return diagnosis;
    };
    for (let attemptIndex = 0; attemptIndex < attemptPlan.length; attemptIndex += 1) {
      const attemptedPort = attemptPlan[attemptIndex]!;
      if (closed) throw new Error("The shared sync listener has been closed.");
      if (attemptedPort !== 0 && shadowedPorts.has(attemptedPort)) continue;
      if (attemptedPort !== 0 && occupiedPorts.has(attemptedPort)) continue;
      // The retry delay lets a dying listener free a FIXED port; an ephemeral
      // re-bind gets a fresh port immediately, so skip the delay for port 0.
      if (previousAttemptedPort === attemptedPort && attemptedPort !== 0) {
        await new Promise((resolve) => setTimeout(resolve, PREFERRED_PORT_BIND_RETRY_DELAY_MS));
      }
      previousAttemptedPort = attemptedPort;
      const candidateHttpServer = http.createServer((request, response) => {
        writeAdeLoopbackUpgradeResponse(request, response, expectedLoopbackNonce);
      });
      const candidateServer = new WebSocketServer({
        server: candidateHttpServer,
        maxPayload: maxPayloadBytes,
        path: SYNC_WEBSOCKET_PATH,
        verifyClient: (info: { origin?: string }) => {
          const origin = info.origin?.trim();
          if (!origin || SYNC_BROWSER_ORIGINS.has(origin)) return true;
          logger.debug?.("sync_listener.origin_rejected", { origin });
          return false;
        },
      });
      candidateHttpServer.listen(attemptedPort, bindHost);
      // Install the handler before the validation RTT so a LAN peer that
      // arrives in that narrow window is parked/owned instead of orphaned.
      candidateServer.on("connection", (ws, request) => {
        const connection: SharedSyncListenerConnection = {
          ws,
          remoteAddress: request.socket.remoteAddress ?? null,
          remotePort: request.socket.remotePort ?? null,
          transportOrigin: hasValidRelayBridgeProof(request, relayBridgeProofBytes)
            ? "relay-bridge"
            : "direct",
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
          transportOrigin: connection.transportOrigin,
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
              await validateLoopback(port);
              cleanup();
              resolve(port);
            } catch (error) {
              cleanup();
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
        httpServer = candidateHttpServer;
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
        await closeCandidateServer(candidateServer, candidateHttpServer);
        // Record the RESOLVED port (not the literal 0) so an ephemeral shadow
        // does not poison the remaining fresh-port re-binds.
        if (isLoopbackShadowedError(error)) {
          shadowedPorts.add(attemptedPort === 0 ? error.port : attemptedPort);
        }
        const retryable = isRetryableListenerBindError(error)
          && (attemptedPort !== 0 || isLoopbackShadowedError(error));
        let diagnosis: SyncListenerPortDiagnosis | null = null;
        let reapedStaleHolder = false;
        if (
          (error as NodeJS.ErrnoException | null | undefined)?.code === "EADDRINUSE"
          && attemptedPort > 0
          && !zombieReapedPorts.has(attemptedPort)
        ) {
          diagnosis = await diagnosePort(attemptedPort);
          const staleHolder = attemptedPort >= DEFAULT_SYNC_HOST_PORT
            && attemptedPort <= SYNC_HOST_MAX_PORT
            ? findStaleHolder(diagnosis)
            : null;
          if (staleHolder) {
            // Reconfirm ownership immediately before signaling. The original
            // holder may have exited and its pid may have been reused while
            // the first lsof/ps diagnosis was being assembled.
            const confirmedHolder = findStaleHolder(await diagnosePort(attemptedPort, true));
            if (
              staleHolder.startTime != null
              && confirmedHolder?.pid === staleHolder.pid
              && confirmedHolder.startTime === staleHolder.startTime
            ) {
              zombieReapedPorts.add(attemptedPort);
              await terminatePid(staleHolder.pid);
              reapedStaleHolder = true;
              logger.info?.("sync_listener.zombie_reaped", {
                port: attemptedPort,
                pid: staleHolder.pid,
              });
              // Non-preferred candidates occur only once in the normal plan.
              // Insert exactly one immediate retry for the newly-freed port.
              attemptPlan.splice(attemptIndex + 1, 0, attemptedPort);
            }
          }
          // A confirmed live holder will not disappear during a 3.2 second
          // retry loop. Advance immediately to the next candidate instead of
          // fighting the desktop (or another runtime) and logging eight copies.
          if (!reapedStaleHolder && diagnosis.holders.length > 0) {
            occupiedPorts.add(attemptedPort);
          }
        }
        const event = isLoopbackShadowedError(error)
          ? "sync_listener.loopback_shadowed"
          : retryable ? "sync_listener.bind_port_conflict" : "sync_listener.bind_failed";
        if (event !== "sync_listener.bind_port_conflict" || !loggedConflictPorts.has(attemptedPort)) {
          if (event === "sync_listener.bind_port_conflict") loggedConflictPorts.add(attemptedPort);
          logger.warn?.(event, {
            attemptedPort,
            error: error instanceof Error ? error.message : String(error),
            code: (error as NodeJS.ErrnoException | null | undefined)?.code ?? null,
            ...(diagnosis ? { holderPids: diagnosis.holders.map((holder) => holder.pid) } : {}),
            retriesSkipped: occupiedPorts.has(attemptedPort)
              ? attemptPlan.slice(attemptIndex + 1).filter((port) => port === attemptedPort).length
              : 0,
          });
        }
        if (!retryable) throw error;
      }
    }
    const candidateDiagnosis = await Promise.all(
      [...new Set(candidates)]
        .filter((port) => port > 0)
        .slice(0, 5)
        .map((port) => diagnosePort(port)),
    );
    logger.warn?.("sync_listener.bind_exhausted", {
      candidates: candidateDiagnosis,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
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
      const port = await listeningPromise;
      notifyLoopbackValidated();
      return port;
    },

    getPort(): number | null {
      const address = server?.address();
      return typeof address === "object" && address ? address.port : null;
    },

    isListening(): boolean {
      return server?.address() != null;
    },

    getExpectedLoopbackNonce(): string {
      return expectedLoopbackNonce;
    },

    getRelayBridgeProof(): string {
      return relayBridgeProof;
    },

    getLoopbackValidationStatus(): SyncLoopbackValidationStatus {
      return { ...loopbackValidationStatus };
    },

    async revalidateLoopback(): Promise<void> {
      const address = server?.address();
      if (typeof address !== "object" || !address) {
        throw new Error("The shared sync listener is not listening.");
      }
      await validateLoopback(address.port);
      notifyLoopbackValidated();
    },

    onLoopbackValidated(nextHandler: () => void): () => void {
      loopbackValidatedHandlers.add(nextHandler);
      return () => {
        loopbackValidatedHandlers.delete(nextHandler);
      };
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
      loopbackValidatedHandlers.clear();
      if (listeningPromise) {
        await listeningPromise.catch(() => {});
      }
      for (const entry of [...parked.values()]) {
        unpark(entry);
        try {
          entry.snapshot.ws.terminate();
        } catch {
          // ignore close failures
        }
      }
      const current = server;
      const currentHttp = httpServer;
      server = null;
      httpServer = null;
      if (!current) return;
      // Force-terminate every client. ws's close() for an EXTERNALLY-supplied
      // http server resolves only after every client socket drains, so a single
      // wedged socket would hang final shutdown; terminate side-steps that.
      for (const ws of current.clients) {
        try {
          ws.terminate();
        } catch {
          // ignore close failures
        }
      }
      try {
        // Detach ws's listeners from the http server (external server: this does
        // NOT close the http server, so we close it ourselves below).
        current.close();
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        if (!currentHttp || !currentHttp.listening) {
          resolve();
          return;
        }
        try {
          currentHttp.close(() => resolve());
          // Force any lingering upgraded/keep-alive sockets so close() cannot hang.
          currentHttp.closeAllConnections?.();
        } catch {
          resolve();
        }
      });
    },
  };
}

/**
 * PowerShell that reports every listening owner of `port` as JSON.
 *
 * `Get-NetTCPConnection` is the supported replacement for parsing `netstat`
 * output, and pairing it with `Get-CimInstance Win32_Process` gets the command
 * line and creation time in the SAME invocation — one process spawn instead of
 * the 1 + 2N that the POSIX `lsof`/`ps` path needs.
 */
export function buildWindowsPortHolderQueryArgs(port: number): string[] {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port for the Windows port-holder query: ${String(port)}`);
  }
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `$owners = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`
      + " | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique)",
    "$holders = @(foreach ($owner in $owners) {",
    "  $target = Get-CimInstance Win32_Process -Filter \"ProcessId = $owner\" -ErrorAction SilentlyContinue",
    "  if ($null -eq $target) { continue }",
    "  $startTime = ''",
    "  try { $startTime = ([datetime]$target.CreationDate).ToUniversalTime().ToString('o') } catch { $startTime = '' }",
    "  [ordered]@{ pid = [int]$target.ProcessId; command = [string]$target.CommandLine; startTime = [string]$startTime }",
    "})",
    "[Console]::Out.Write((ConvertTo-Json -InputObject @($holders) -Compress -Depth 3))",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

export function parseWindowsPortHolders(raw: string | null): SyncListenerPortDiagnosis["holders"] {
  const text = raw?.trim();
  // PowerShell emits nothing for an empty collection, which is a legitimate
  // "no holders" answer rather than a parse failure.
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const holders: SyncListenerPortDiagnosis["holders"] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry == null) continue;
    const record = entry as { pid?: unknown; command?: unknown; startTime?: unknown };
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    // A holder owned by another user yields a null CommandLine without
    // elevation. Keep the pid: it still proves the port is genuinely occupied,
    // and `findStaleHolder` already refuses to reap a holder it cannot identify.
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const startTime = typeof record.startTime === "string" ? record.startTime.trim() : "";
    holders.push({ pid, command: command || null, startTime: startTime || null });
  }
  return holders;
}

async function inspectWindowsSyncListenerPort(
  port: number,
  exec: typeof execFileText,
): Promise<SyncListenerPortDiagnosis> {
  let powershell: string;
  let args: string[];
  try {
    powershell = resolveTrustedWindowsTool("powershell");
    args = buildWindowsPortHolderQueryArgs(port);
  } catch {
    return { port, holders: [] };
  }
  const raw = await exec(powershell, args, WINDOWS_PORT_INSPECT_TIMEOUT_MS);
  return { port, holders: parseWindowsPortHolders(raw) };
}

async function inspectPosixSyncListenerPort(
  port: number,
  exec: typeof execFileText,
): Promise<SyncListenerPortDiagnosis> {
  const lsof = await exec(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
  );
  if (lsof == null) return { port, holders: [] };
  const pids = [...new Set(
    lsof
      .split(/\r?\n/)
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number(line.slice(1)))
      .filter((pid) => Number.isFinite(pid) && pid > 0),
  )];
  return {
    port,
    holders: await Promise.all(pids.map(async (pid) => {
      const [commandResult, startResult] = await Promise.all([
        exec("ps", ["-p", String(pid), "-o", "command="]),
        exec("ps", ["-p", String(pid), "-o", "lstart="]),
      ]);
      const command = commandResult?.trim() ?? "";
      const startTime = startResult?.trim() ?? "";
      return {
        pid,
        command: command || null,
        startTime: startTime || null,
      };
    })),
  };
}

/**
 * Processes listening on `port`, dispatched per platform.
 *
 * Both consumers degrade badly when this silently answers "nothing": the
 * stale-port reclaim in `createSharedSyncListener` cannot recognise a wedged
 * same-channel sibling and permanently drifts mobile sync onto a fallback port,
 * and `ade doctor` reports "no holders visible to this user" with advice that
 * only makes sense on macOS.
 */
export async function inspectSyncListenerPort(
  port: number,
  deps: {
    platform?: NodeJS.Platform;
    exec?: typeof execFileText;
  } = {},
): Promise<SyncListenerPortDiagnosis> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? execFileText;
  return platform === "win32"
    ? inspectWindowsSyncListenerPort(port, exec)
    : inspectPosixSyncListenerPort(port, exec);
}
