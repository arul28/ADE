import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type {
  SyncApplicationCompressionCodec,
  SyncPeerMetadata,
} from "../../../../desktop/src/shared/types";
import { WEB_CLIENT_BASE_URL } from "../../../../desktop/src/shared/webClientUrl";
import {
  SYNC_PER_MESSAGE_DEFLATE_OPTIONS,
  encodeSyncEnvelope,
  parseSyncEnvelope,
  type ParsedSyncEnvelope,
} from "./syncProtocol";
import type { RelayAuthorizationSnapshot } from "./relayAuthorization";
import {
  generateLoopbackNonce,
  writeAdeLoopbackUpgradeResponse,
  type SyncLoopbackProbeResult,
  type SyncLoopbackValidationStatus,
} from "./syncLoopbackProbe";
import type { SyncListenerPortDiagnosis } from "./syncListenerPortInspect";
import {
  createAttachmentUploadRegistry,
  type AttachmentUploadRegistry,
} from "./attachmentUploadService";
import { APPLE_STREAM_PATH_PREFIX, tryRouteAppleStreamSocket } from "./appleStreamListenerRoute";
import {
  createSyncListenerPortController,
  SYNC_LISTENER_SELF_HEAL_INTERVAL_MS,
  type SharedSyncListenerPortChange,
} from "./syncListenerPortController";

// Re-exported so existing importers (and `ade doctor`) keep their entry point.
export {
  buildWindowsListeningPortHolderQueryArgs,
  buildWindowsPortHolderQueryArgs,
  parseWindowsPortHolders,
  type WindowsPortHolder,
} from "./windowsPortHolders";
export {
  inspectSyncListenerPort,
  type SyncListenerPortDiagnosis,
} from "./syncListenerPortInspect";
// These declarations moved to the port controller; the names stay here so
// existing importers keep their entry point.
export {
  SYNC_LISTENER_SELF_HEAL_INTERVAL_MS,
  type SharedSyncListenerPortChange,
} from "./syncListenerPortController";

// Bind the sync host on all interfaces by default so phones on the same
// wifi/LAN can reach it without Tailscale. 0.0.0.0 is a superset of loopback,
// so local desktop clients (and the unix RPC socket, which is separate)
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

type SharedSyncListenerLogger = {
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

export type SharedSyncListenerConnection = {
  ws: WebSocket;
  remoteAddress: string | null;
  remotePort: number | null;
  transportOrigin: SyncTransportOrigin;
  /**
   * The `X-ADE-Hello` header of a direct upgrade request (a hello sent with
   * the upgrade; see `readSyncUpgradeHello`), or null.
   */
  upgradeHello?: string | null;
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
  /**
   * Bind `port` alongside the current listener, then close the old one.
   * Used to steal 8787 back after a dual-brain split left us on 8788.
   * Returns null when the target is still busy; the existing bind is kept.
   */
  tryMigrateToPort(port: number): Promise<number | null>;
  getPort(): number | null;
  /**
   * The port `127.0.0.1` reaches this listener on: its own port, or a
   * local-only side door when another program holds `127.0.0.1:<port>`.
   * Tailscale Serve forwards here. Null when neither answers as ADE.
   */
  getLoopbackPort(): number | null;
  isListening(): boolean;
  getExpectedLoopbackNonce(): string;
  /** Private in-process credential attached only by the trusted relay tunnel client. */
  getRelayBridgeProof(): string;
  /**
   * Ticket registry backing the streamed attachment-upload route mounted on
   * this listener's http server. The sync host mints tickets against this exact
   * instance, so the WS session that authorized an upload and the HTTP request
   * that performs it share one registry.
   */
  getAttachmentUploadRegistry(): AttachmentUploadRegistry;
  getLoopbackValidationStatus(): SyncLoopbackValidationStatus;
  /** Force-check that loopback still reaches this exact listener instance. */
  revalidateLoopback(): Promise<void>;
  /** Subscribe to successful initial and explicit loopback validations. */
  onLoopbackValidated(handler: () => void): () => void;
  /**
   * Subscribe to every loopback verdict change (validated → shadowed and
   * back). Route health and publication read the status on demand; this is
   * the nudge that makes them re-read it.
   */
  onLoopbackStatusChanged(handler: () => void): () => void;
  /**
   * Subscribe to port moves: a move off a port another program shadowed, or
   * back to the canonical port. Everything that advertises the port (Bonjour,
   * Tailscale Serve, the sync lease, the account directory) re-reads it.
   */
  onPortChanged(handler: (change: SharedSyncListenerPortChange) => void): () => void;
  /**
   * Hand a relay pipe straight to the sync host, in process. The relay never
   * dials this machine's port, so another program holding 127.0.0.1:<port>
   * cannot intercept it. Returns false only once the listener is closed.
   */
  acceptRelayPipe(ws: WebSocket, options?: { path?: string | null }): boolean;
  /** True until the listener is closed; a relay pipe needs no bound port. */
  canAcceptRelayPipes(): boolean;
  /**
   * Check now that loopback still reaches this listener, and move to a free
   * port when another program took it. Also runs on its own every
   * {@link SYNC_LISTENER_SELF_HEAL_INTERVAL_MS} once listening.
   */
  healNow(): Promise<void>;
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
  /** True while a project sync host owns new sockets. */
  hasConnectionHandler(): boolean;
  /**
   * Called each time a project sync host attaches, so the machine-wide
   * fallback can send the project sockets it holds on to that host.
   */
  onConnectionHandlerAttached(listener: () => void): () => void;
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

function rawDataBytes(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) {
    return data.reduce((sum, chunk) => sum + rawDataBytes(chunk), 0);
  }
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.byteLength(String(data), "utf8");
}

/**
 * Hello on the upgrade request. A client on a direct route may put its hello
 * envelope in this header (`v1.` + base64url of `{ requestId, payload }`); a
 * host that reads it answers hello_ok as the first frame after the 101,
 * saving the hello round trip. The client still sends the same hello as its
 * first frame, so an older host (which ignores the header) answers that one,
 * and a newer host drops the duplicate by its request id. A header, not the
 * URL: it carries the paired secret, and URLs are what proxies log.
 */
export const SYNC_UPGRADE_HELLO_HEADER = "x-ade-hello";
export const SYNC_UPGRADE_HELLO_MAX_CHARS = 12 * 1024;

export function readSyncUpgradeHelloHeader(request: http.IncomingMessage): string | null {
  const raw = request.headers[SYNC_UPGRADE_HELLO_HEADER];
  const value = Array.isArray(raw) ? null : raw;
  if (typeof value !== "string" || value.length > SYNC_UPGRADE_HELLO_MAX_CHARS || !value.startsWith("v1.")) return null;
  return value;
}

/** The hello a `X-ADE-Hello` header carries, or null when it is malformed. */
function parseSyncUpgradeHello(value: string | null | undefined): { requestId: string; payload: Record<string, unknown> } | null {
  if (typeof value !== "string" || !value.startsWith("v1.")) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const requestId = typeof record.requestId === "string" ? record.requestId.trim() : "";
    const payload = record.payload;
    if (!requestId || requestId.length > 128 || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return { requestId, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * The hello envelope an `X-ADE-Hello` header carries, as a host queues it
 * first on the socket (it then takes the frame path, checks and limits), or
 * null when the header is absent or malformed.
 */
export function syncUpgradeHelloEnvelope(value: string | null | undefined): ParsedSyncEnvelope | null {
  const hello = parseSyncUpgradeHello(value);
  if (!hello) return null;
  return parseSyncEnvelope(encodeSyncEnvelope({
    type: "hello",
    requestId: hello.requestId,
    payload: hello.payload,
    compressionCodec: "none",
  }));
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
  loopbackProbe?: (port: number, expectedNonce: string, timeoutMs?: number) => Promise<SyncLoopbackProbeResult>;
  /**
   * This machine's own non-loopback addresses the self-check also probes
   * (default: every external IPv4 interface address). A program can bind
   * `<address>:<port>` over the wildcard just as it can loopback.
   */
  localAddresses?: () => string[];
  /** Identity probe against one local address; defaults to an HTTP 426 probe. */
  addressProbe?: (host: string, port: number, expectedNonce: string) => Promise<SyncLoopbackProbeResult>;
  inspectPort?: (port: number) => SyncListenerPortDiagnosis | Promise<SyncListenerPortDiagnosis>;
  activeServicePid?: () => number | null;
  terminatePid?: (pid: number) => Promise<void>;
} = {}): SharedSyncListener {
  const logger = options.logger ?? {};
  const bindHost = options.bindHost ?? SYNC_HOST_BIND_HOST;
  const maxPayloadBytes = options.maxPayloadBytes ?? SYNC_HOST_MAX_PAYLOAD_BYTES;
  const parkedPeerGraceMs = Math.max(50, Math.floor(options.parkedPeerGraceMs ?? DEFAULT_PARKED_PEER_GRACE_MS));
  // One identity per listener instance. Every candidate bind for this
  // instance emits the same nonce, and only in-process validators receive the
  // expected value they must compare against.
  const expectedLoopbackNonce = generateLoopbackNonce();
  // Separate from the public 426-probe nonce: this credential is disclosed
  // only to the in-process tunnel client and rotates with the listener process.
  const relayBridgeProofBytes = randomBytes(32);
  const relayBridgeProof = relayBridgeProofBytes.toString("base64url");
  // One registry per listener instance, shared by every candidate bind: a
  // ticket minted before a port migration is still honoured after it.
  const attachmentUploads = createAttachmentUploadRegistry({ logger });

  let handler: SharedSyncListenerConnectionHandler | null = null;
  let fallbackHandler: SharedSyncListenerConnectionHandler | null = null;
  const handlerAttachedListeners = new Set<() => void>();
  let fallbackSuppressedUntilMs = 0;
  let closed = false;
  const parked = new Map<WebSocket, ParkedEntry>();

  /** Call every subscriber, from a snapshot; one that throws is logged, not fatal. */
  const emit = <T>(handlers: Iterable<(value: T) => void>, value: T, failureEvent: string): void => {
    for (const next of [...handlers]) {
      try {
        next(value);
      } catch (error) {
        logger.warn?.(failureEvent, { error: error instanceof Error ? error.message : String(error) });
      }
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

  // One owner for every new socket, whatever carried it (a direct upgrade or
  // a relay pipe handed over in process): the attached project host, else the
  // machine-wide fallback, else the parking lot until a host attaches.
  const dispatchConnection = (connection: SharedSyncListenerConnection): void => {
    const fallbackSuppressed = fallbackSuppressedUntilMs > Date.now();
    const activeHandler = handler ?? (fallbackSuppressed ? null : fallbackHandler);
    if (activeHandler) {
      activeHandler(connection);
      return;
    }
    park({
      ws: connection.ws,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      transportOrigin: connection.transportOrigin,
      metadata: null,
      authKind: null,
      pairedDeviceId: null,
      connectedAt: new Date().toISOString(),
    });
  };

  /**
   * One http + WebSocket server pair, wired exactly like every other entrance
   * to this listener: the loopback 426 identity, the upload route, the path
   * and Origin policy, the Apple stream route and the one connection dispatch.
   * The connection handler is installed before the caller binds, so a peer
   * that arrives during validation is owned or parked, never orphaned.
   */
  const createServerPair = (): { httpServer: http.Server; wsServer: WebSocketServer } => {
    const pairHttp = http.createServer((request, response) => {
      // WS upgrades never reach here (they are handled on `upgrade`), so the
      // only non-upload request shape left is the loopback 426 probe.
      if (attachmentUploads.handleRequest(request, response)) return;
      writeAdeLoopbackUpgradeResponse(request, response, expectedLoopbackNonce);
    });
    const pairWs = new WebSocketServer({
      server: pairHttp,
      maxPayload: maxPayloadBytes,
      perMessageDeflate: SYNC_PER_MESSAGE_DEFLATE_OPTIONS,
      // Deliberately no `path` option: this listener serves TWO socket
      // shapes — the sync protocol at `/`, and the Apple device video pipe
      // at `/apple/stream/<ticket>`. `ws`'s built-in path filter accepts
      // exactly one, so the check moves here where it can accept both and
      // still refuse everything else at the HTTP layer with a 401.
      verifyClient: (info: { origin?: string; req?: { url?: string | null } }) => {
        const pathname = (info.req?.url ?? SYNC_WEBSOCKET_PATH).split("?")[0] ?? SYNC_WEBSOCKET_PATH;
        if (pathname !== SYNC_WEBSOCKET_PATH && !pathname.startsWith(APPLE_STREAM_PATH_PREFIX)) {
          logger.debug?.("sync_listener.path_rejected", { pathname });
          return false;
        }
        const origin = info.origin?.trim();
        if (!origin || SYNC_BROWSER_ORIGINS.has(origin)) return true;
        logger.debug?.("sync_listener.origin_rejected", { origin });
        return false;
      },
    });
    pairWs.on("connection", (ws, request) => {
      // Apple device video rides a second socket on this listener
      // (`/apple/stream/<ticket>`). Divert it before any host or the parking
      // lot sees it: it is a binary pipe, not a sync peer, and parking one
      // would hand a video socket to the next project's host on a switch.
      if (tryRouteAppleStreamSocket(ws, request)) return;
      // A relay bridge from an older in-process tunnel client (or a test)
      // still dials loopback with the private proof; current clients hand
      // pipes over through acceptRelayPipe instead.
      const transportOrigin = hasValidRelayBridgeProof(request, relayBridgeProofBytes)
        ? "relay-bridge"
        : "direct";
      dispatchConnection({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
        transportOrigin,
        upgradeHello: transportOrigin === "direct" ? readSyncUpgradeHelloHeader(request) : null,
      });
    });
    return { httpServer: pairHttp, wsServer: pairWs };
  };

  // Which port this listener answers on, the local side door that keeps
  // 127.0.0.1 reachable when another program shadows that port, and the
  // self-check that repairs or moves either. Everything here is transport;
  // dispatch, parking, relay handoff and uploads stay in this module.
  const ports = createSyncListenerPortController({
    logger,
    bindHost,
    createServerPair,
    expectedLoopbackNonce,
    hasConnectionHandler: () => handler !== null,
    loopbackProbe: options.loopbackProbe,
    localAddresses: options.localAddresses,
    addressProbe: options.addressProbe,
    inspectPort: options.inspectPort,
    activeServicePid: options.activeServicePid,
    terminatePid: options.terminatePid,
  });

  const api: SharedSyncListener = {
    ensureListening(portCandidates: number[]): Promise<number> {
      return ports.ensureListening(portCandidates);
    },

    tryMigrateToPort(port: number): Promise<number | null> {
      return ports.tryMigrateToPort(port);
    },

    getPort: ports.getPort,

    getLoopbackPort(): number | null {
      return ports.getLoopbackPort();
    },

    isListening(): boolean {
      return ports.isListening();
    },

    getExpectedLoopbackNonce(): string {
      return expectedLoopbackNonce;
    },

    getRelayBridgeProof(): string {
      return relayBridgeProof;
    },

    getAttachmentUploadRegistry(): AttachmentUploadRegistry {
      return attachmentUploads;
    },

    getLoopbackValidationStatus(): SyncLoopbackValidationStatus {
      return ports.getLoopbackValidationStatus();
    },

    revalidateLoopback(): Promise<void> {
      return ports.revalidateLoopback();
    },

    onLoopbackValidated(nextHandler: () => void): () => void {
      return ports.onLoopbackValidated(nextHandler);
    },

    onLoopbackStatusChanged(nextHandler: () => void): () => void {
      return ports.onLoopbackStatusChanged(nextHandler);
    },

    onPortChanged(nextHandler: (change: SharedSyncListenerPortChange) => void): () => void {
      return ports.onPortChanged(nextHandler);
    },

    acceptRelayPipe(ws: WebSocket, options?: { path?: string | null }): boolean {
      if (closed) return false;
      const path = options?.path?.trim() || null;
      // The relay forwards the Apple video pipe on its own path, exactly as a
      // direct upgrade would arrive; its ticket travels in that path.
      if (path && path.startsWith(APPLE_STREAM_PATH_PREFIX)) {
        if (tryRouteAppleStreamSocket(ws, { url: path, headers: {} })) return true;
        try {
          ws.close(1011, "stream unavailable");
        } catch {
          // already closing
        }
        return true;
      }
      dispatchConnection({
        ws,
        // Relay peers have always reached the host from loopback, and the
        // host's per-address limits group them there. Keep that grouping.
        remoteAddress: "127.0.0.1",
        remotePort: null,
        transportOrigin: "relay-bridge",
        upgradeHello: null,
      });
      return true;
    },

    canAcceptRelayPipes(): boolean {
      return !closed;
    },

    healNow: () => ports.healNow(),

    setConnectionHandler(nextHandler: SharedSyncListenerConnectionHandler): () => void {
      handler = nextHandler;
      fallbackSuppressedUntilMs = 0;
      emit(handlerAttachedListeners, undefined, "sync_listener.handler_attached_listener_failed");
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

    hasConnectionHandler(): boolean {
      return handler !== null;
    },

    onConnectionHandlerAttached(listener: () => void): () => void {
      handlerAttachedListeners.add(listener);
      return () => {
        handlerAttachedListeners.delete(listener);
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
      attachmentUploads.dispose();
      handlerAttachedListeners.clear();
      // The controller owns the self-check, the side door, retired servers and
      // the live server. It closes everything up to the parked peers it does
      // not own; those are terminated here, then the live server closes, which
      // keeps final shutdown in the order it has always used.
      await ports.closeEntrances();
      for (const entry of [...parked.values()]) {
        unpark(entry);
        try {
          entry.snapshot.ws.terminate();
        } catch {
          // ignore close failures
        }
      }
      await ports.closeServer();
    },
  };
  return api;
}
