import type { IncomingMessage } from "node:http";
import { WebSocket, type RawData } from "ws";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  defaultRelayUrl,
  httpToWsUrl,
  signRelayHmacHex,
  type SyncCloudRelayStore,
} from "./syncCloudRelayStore";
import {
  assertAdeLoopbackListener,
  probeAdeLoopbackListener,
  type SyncLoopbackProbeResult,
} from "./syncLoopbackProbe";
import { SYNC_RELAY_BRIDGE_PROOF_HEADER } from "./sharedSyncListener";

type Logger = {
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
  error?: (event: string, data?: Record<string, unknown>) => void;
  debug?: (event: string, data?: Record<string, unknown>) => void;
};

export type SyncTunnelClientStatus = {
  accountLeaseValid?: boolean;
  connected: boolean;
  activeTunnels: number;
  lastError: string | null;
  lastControlError: string | null;
  relayBridgeValidated: boolean;
  validatedPort: number | null;
  lastFailureAt: string | null;
  lastControlOpenAt: string | null;
  lastBridgeValidationAt: string | null;
  relayUrl: string;
  machineKey: string;
};

export type SyncTunnelClientService = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Re-probe the active shared listener without opening a Relay pipe. */
  validateCurrentBridge(): Promise<boolean>;
  getStatus(): SyncTunnelClientStatus;
  dispose(): Promise<void>;
};

type MachineIdentity = { machineKey: string; secret: string };

type SyncTunnelClientArgs = {
  logger?: Logger;
  /** Local ADE sync WebSocket server port, or null when the host isn't up. */
  getSyncPort: () => number | null;
  /** Expected identity of the active in-process sync listener. */
  getExpectedLoopbackNonce?: () => string | null;
  /** Private proof accepted only by the active in-process sync listener. */
  getRelayBridgeProof: () => string | null;
  /** Relay is usable only while the host has a current ADE account session. */
  isAccountSignedIn?: () => boolean;
  /** Refresh-aware lease; the account token is validated upstream and never retained here. */
  getAccountLease?: () => Promise<{ userId: string; expiresAt?: string | null } | null>;
  configStore: SyncCloudRelayStore;
  /** Overrides the identity from configStore (e.g. a shared machine store). */
  machineIdentity?: () => MachineIdentity | null;
  /** Test seam; production always uses the HTTP 426 loopback probe. */
  loopbackProbe?: (port: number, expectedNonce: string) => Promise<SyncLoopbackProbeResult>;
  /** Test seam for account-session lifecycle reconciliation. */
  accountStatusPollMs?: number;
  /** Test seams; production uses the exported protocol-liveness defaults. */
  controlPingIntervalMs?: number;
  controlPongDeadlineMs?: number;
  /** Requests a fresh directory publication after a confirmed-409 identity rotation opens. */
  onIdentityRotated?: () => void | Promise<void>;
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const ACCOUNT_STATUS_POLL_MS = 1_000;
export const CONTROL_PING_INTERVAL_MS = 30_000;
export const CONTROL_PONG_DEADLINE_MS = 10_000;
export const RELAY_CLOSE_PARTNER_CLOSED = 4000;
export const RELAY_CLOSE_HOST_UNAVAILABLE = 4501;
export const RELAY_CLOSE_BRIDGE_REJECTED = 4507;
export const RELAY_SIGN_IN_REQUIRED_MESSAGE = "Sign in to ADE to use ADE Relay.";
const MAX_UNEXPECTED_RESPONSE_BODY_BYTES = 512;
const MAX_CONFIRMED_CONFLICT_ROTATIONS = 1;

class RelayClaimError extends Error {
  logged = false;

  constructor(
    readonly status: number,
    readonly machineKey: string,
  ) {
    super(`claim failed (${status})`);
    this.name = "RelayClaimError";
  }
}

type ControlSocketState = {
  opened: boolean;
  failureReason: string | null;
};

/**
 * Exponential backoff with full jitter, capped at 60s. Exposed for tests so the
 * reconnect schedule is verifiable without waiting on real timers.
 */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export type ControlMessage = { t: "open"; id: string };

/** Parses a host control frame; returns null for anything unrecognized. */
export function parseControlMessage(raw: string): ControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const t = (parsed as { t?: unknown }).t;
  if (t === "open") {
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" && /^[a-f0-9]{8,32}$/i.test(id) ? { t: "open", id } : null;
  }
  return null;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

const MAX_CLOSE_REASON_BYTES = 123;

function applicationCloseCode(code: unknown, fallback = RELAY_CLOSE_PARTNER_CLOSED): number {
  return typeof code === "number" && Number.isInteger(code) && code >= 4000 && code <= 4999
    ? code
    : fallback;
}

function sanitizedCloseReason(reason: unknown, fallback: string): string {
  const raw = typeof reason === "string" ? reason : Buffer.isBuffer(reason) ? reason.toString("utf8") : "";
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || fallback;
  const encoded = Buffer.from(clean, "utf8");
  if (encoded.byteLength <= MAX_CLOSE_REASON_BYTES) return clean;
  return encoded.subarray(0, MAX_CLOSE_REASON_BYTES).toString("utf8").replace(/\uFFFD$/, "").trimEnd();
}

/**
 * Brain-side tunnel client. While the sync host and account lease are valid,
 * keeps a signed control WebSocket open to the relay; for each `{t:"open", id}`
 * it opens a dedicated pipe socket to the relay and a local socket to the sync
 * server, then pipes bytes 1:1. The sync protocol passes through untouched.
 * The control socket reconnects with jittered exponential backoff.
 */
export function createSyncTunnelClientService(args: SyncTunnelClientArgs): SyncTunnelClientService {
  const log = args.logger ?? {};
  let control: WebSocket | null = null;
  let stopControlLiveness: (() => void) | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let accountStatusTimer: NodeJS.Timeout | null = null;
  let connectingControl = false;
  let accountLeaseCheckInFlight: Promise<void> | null = null;
  let accountLeaseUserId: string | null = args.getAccountLease ? null : "legacy";
  let accountEligible: boolean | null = null;
  let attempt = 0;
  let started = false;
  let stopped = false;
  let connected = false;
  let lastError: string | null = null;
  let lastControlError: string | null = null;
  let validatedPort: number | null = null;
  let validatedLoopbackNonce: string | null = null;
  let lastFailureAt: string | null = null;
  let lastControlOpenAt: string | null = null;
  let lastBridgeValidationAt: string | null = null;
  let bridgeValidationTail: Promise<void> = Promise.resolve();
  let claimedIdentity: { relayOrigin: string; machineKey: string } | null = null;
  let accountLeaseExpiresAtMs: number | null = null;
  let consecutiveAccountLeaseFailures = 0;
  let confirmedConflictRotations = 0;
  let identityRotationPendingPublish = false;
  const tunnels = new Set<Tunnel>();
  const controlSocketStates = new WeakMap<WebSocket, ControlSocketState>();
  const loopbackProbe = args.loopbackProbe ?? probeAdeLoopbackListener;

  const recordFailure = (reason: string): void => {
    lastError = reason;
    lastFailureAt = new Date().toISOString();
  };

  const clearBridgeValidation = (): void => {
    validatedPort = null;
    validatedLoopbackNonce = null;
  };

  const recordControlFailure = (reason: string): void => {
    lastControlError = reason;
    recordFailure(reason);
  };

  const identity = (): MachineIdentity => {
    const override = args.machineIdentity?.();
    return override ?? args.configStore.getMachineIdentity();
  };

  const relayHttpUrl = (): string => args.configStore.getRelayUrl() || defaultRelayUrl();
  const computeAccountEligibility = (): boolean =>
    (args.isAccountSignedIn?.() ?? true)
    && (!args.getAccountLease || accountLeaseUserId != null);
  const accountSignedIn = (): boolean => {
    if (accountEligible !== true) return false;
    try {
      return args.isAccountSignedIn?.() ?? true;
    } catch {
      return false;
    }
  };

  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (
      stopped
      || reconnectTimer
      || control
      || connectingControl
      || !accountSignedIn()
    ) return;
    const delay = computeBackoffMs(attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectControl();
    }, delay);
    reconnectTimer.unref?.();
  };

  const claimOnce = async (id: MachineIdentity): Promise<void> => {
    const relayOrigin = relayHttpUrl().replace(/\/+$/, "");
    if (
      claimedIdentity?.relayOrigin === relayOrigin
      && claimedIdentity.machineKey === id.machineKey
    ) return;
    const url = `${relayOrigin}/machines/${id.machineKey}/claim`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: id.secret }),
      signal: AbortSignal.timeout(CONNECT_DEADLINE_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RelayClaimError(response.status, id.machineKey);
    }
    await response.body?.cancel().catch(() => {});
    claimedIdentity = { relayOrigin, machineKey: id.machineKey };
    log.info?.("sync_tunnel.claimed", {
      machineKey: id.machineKey,
      status: response.status,
    });
  };

  const claimWithConflictRecovery = async (initialIdentity: MachineIdentity): Promise<MachineIdentity> => {
    try {
      await claimOnce(initialIdentity);
      return initialIdentity;
    } catch (error) {
      if (
        !(error instanceof RelayClaimError)
        || error.status !== 409
        || confirmedConflictRotations >= MAX_CONFIRMED_CONFLICT_ROTATIONS
        || args.machineIdentity
      ) {
        throw error;
      }

      error.logged = true;
      log.warn?.("sync_tunnel.claim_failed", {
        error: error.message,
        machineKey: error.machineKey,
        status: error.status,
        identityRotation: "starting",
      });
      const rotated = args.configStore.rotateMachineIdentity(initialIdentity.machineKey);
      if (rotated.machineKey === initialIdentity.machineKey) {
        throw error;
      }
      confirmedConflictRotations += 1;
      identityRotationPendingPublish = true;
      log.info?.("sync_tunnel.identity_rotated", {
        previousMachineKey: initialIdentity.machineKey,
        machineKey: rotated.machineKey,
        triggerStatus: 409,
      });
      await claimOnce(rotated);
      return rotated;
    }
  };

  const connectControl = async (): Promise<void> => {
    if (stopped || control || connectingControl || reconnectTimer) return;
    if (!accountSignedIn()) {
      lastError = RELAY_SIGN_IN_REQUIRED_MESSAGE;
      return;
    }
    connectingControl = true;
    let reconnectAfterAttempt = false;
    try {
      let id = identity();
      try {
        id = await claimWithConflictRecovery(id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordFailure(reason);
        if (!(error instanceof RelayClaimError) || !error.logged) {
          log.warn?.("sync_tunnel.claim_failed", {
            error: reason,
            machineKey: error instanceof RelayClaimError ? error.machineKey : id.machineKey,
            status: error instanceof RelayClaimError ? error.status : null,
          });
        }
        reconnectAfterAttempt = true;
        return;
      }
      if (stopped || !accountSignedIn() || control) return;

      const ts = nowSeconds();
      const sig = signRelayHmacHex(id.secret, buildHostSignatureBase(id.machineKey, ts));
      const wsBase = httpToWsUrl(relayHttpUrl());
      const url = `${wsBase}/host/${id.machineKey}?ts=${ts}&sig=${sig}`;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordControlFailure(reason);
        log.warn?.("sync_tunnel.control_error", { error: reason });
        reconnectAfterAttempt = true;
        return;
      }
      const socketState: ControlSocketState = { opened: false, failureReason: null };
      controlSocketStates.set(socket, socketState);
      control = socket;
      let socketLivenessStop: (() => void) | null = null;
      armOpenDeadline(socket, () => {
        if (control !== socket) return;
        const reason = "relay control socket connect timed out";
        socketState.failureReason = reason;
        recordControlFailure(reason);
      });

      socket.on("open", () => {
        if (stopped || !accountSignedIn() || control !== socket) {
          try {
            socket.close(1000, "account lease unavailable");
          } catch {
            // already closing
          }
          return;
        }
        socketState.opened = true;
        attempt = 0;
        clearReconnect();
        connected = true;
        lastError = null;
        lastControlError = null;
        lastControlOpenAt = new Date().toISOString();
        socketLivenessStop = armControlLiveness(
          socket,
          () => {
            if (control !== socket) return;
            recordControlFailure("relay control socket missed pong");
            log.warn?.("sync_tunnel.control_pong_timeout");
            try {
              socket.terminate();
            } catch {
              // already dead
            }
          },
          args.controlPingIntervalMs ?? CONTROL_PING_INTERVAL_MS,
          args.controlPongDeadlineMs ?? CONTROL_PONG_DEADLINE_MS,
        );
        stopControlLiveness = socketLivenessStop;
        log.info?.("sync_tunnel.control_open", {
          machineKey: id.machineKey,
          openedAt: lastControlOpenAt,
        });
        void validateCurrentBridge();
      });
      socket.on("message", (raw: RawData) => {
        if (control !== socket) return;
        const message = parseControlMessage(rawToText(raw));
        if (message?.t === "open") void openTunnel(id, message.id, socket);
      });
      socket.on("unexpected-response", (request, response) => {
        captureUnexpectedResponseBody(response, (body) => {
          if (control !== socket) {
            try {
              request.destroy();
              socket.terminate();
            } catch {
              // superseded socket is already closed
            }
            return;
          }
          const status = response.statusCode ?? 0;
          const reason = `Relay control upgrade failed with HTTP ${status}${body ? `: ${body}` : "."}`;
          socketState.failureReason = reason;
          recordControlFailure(reason);
          log.warn?.("sync_tunnel.control_error", {
            error: reason,
            status,
            body,
            opened: socketState.opened,
          });
          try {
            request.destroy();
          } catch {
            // request already closed
          }
          try {
            socket.terminate();
          } catch {
            // socket already closed
          }
        });
      });
      socket.on("error", (error: Error) => {
        if (control !== socket) return;
        const reason = socketState.failureReason ?? error.message;
        if (!socketState.failureReason) {
          socketState.failureReason = reason;
          recordControlFailure(reason);
        }
        log.warn?.("sync_tunnel.control_error", {
          error: reason,
          wsError: error.message,
          opened: socketState.opened,
        });
      });
      socket.on("close", (code: number, rawReason: Buffer) => {
        socketLivenessStop?.();
        if (stopControlLiveness === socketLivenessStop) stopControlLiveness = null;
        const reason = rawReason.toString("utf8").trim();
        const wasCurrent = control === socket;
        log.info?.("sync_tunnel.control_close", {
          code,
          reason,
          opened: socketState.opened,
          machineKey: id.machineKey,
        });
        if (!wasCurrent) return;

        connected = false;
        control = null;
        if (!stopped && accountSignedIn()) {
          const closeReason = reason
            ? `Relay control closed (${code}): ${reason}`
            : `Relay control closed (${code}).`;
          if (reason || !socketState.failureReason) {
            socketState.failureReason = closeReason;
            recordControlFailure(closeReason);
          }
          scheduleReconnect();
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordControlFailure(reason);
      log.warn?.("sync_tunnel.control_connect_failed", { error: reason });
      reconnectAfterAttempt = true;
    } finally {
      connectingControl = false;
      if (reconnectAfterAttempt) scheduleReconnect();
    }
  };

  const runBridgeValidation = async (): Promise<boolean> => {
    if (!accountSignedIn()) {
      clearBridgeValidation();
      recordFailure(RELAY_SIGN_IN_REQUIRED_MESSAGE);
      return false;
    }
    const port = args.getSyncPort();
    if (port == null) {
      clearBridgeValidation();
      recordFailure("Relay bridge refused because the ADE sync listener is not bound.");
      log.warn?.("sync_tunnel.no_sync_port");
      return false;
    }
    const expectedLoopbackNonce = args.getExpectedLoopbackNonce?.() ?? null;
    if (!expectedLoopbackNonce) {
      clearBridgeValidation();
      recordFailure("Relay bridge refused because the ADE sync listener identity is unavailable.");
      log.warn?.("sync_tunnel.no_loopback_identity", { port });
      return false;
    }
    try {
      const result = await assertAdeLoopbackListener(
        port,
        expectedLoopbackNonce,
        loopbackProbe,
      );
      if (stopped || !accountSignedIn()) {
        clearBridgeValidation();
        if (!stopped) recordFailure(RELAY_SIGN_IN_REQUIRED_MESSAGE);
        return false;
      }
      if (
        args.getSyncPort() !== port
        || (args.getExpectedLoopbackNonce?.() ?? null) !== expectedLoopbackNonce
      ) {
        clearBridgeValidation();
        recordFailure("Relay bridge refused because the ADE sync listener changed during validation.");
        return false;
      }
      validatedPort = port;
      validatedLoopbackNonce = expectedLoopbackNonce;
      lastError = null;
      lastBridgeValidationAt = result.checkedAt;
      log.debug?.("sync_tunnel.bridge_validated", { port });
      if (identityRotationPendingPublish && connected) {
        identityRotationPendingPublish = false;
        void Promise.resolve()
          .then(() => args.onIdentityRotated?.())
          .catch((error) => {
            log.warn?.("sync_tunnel.identity_republish_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return true;
    } catch (error) {
      clearBridgeValidation();
      const reason = `Relay bridge refused because 127.0.0.1:${port} is not the ADE sync listener: ${error instanceof Error ? error.message : String(error)}`;
      recordFailure(reason);
      log.warn?.("sync_tunnel.loopback_validation_failed", {
        port,
        error: reason,
      });
      return false;
    }
  };

  const validateCurrentBridge = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    // Every caller gets a fresh probe, but probes run one at a time. Inbound
    // opens must never share a cached/in-flight success before constructing the
    // authenticated local socket.
    const current = bridgeValidationTail
      .then(runBridgeValidation, runBridgeValidation)
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        recordFailure(reason);
        log.warn?.("sync_tunnel.bridge_validation_failed", { error: reason });
        return false;
      });
    bridgeValidationTail = current.then(() => undefined, () => undefined);
    return current;
  };

  const sendControlReject = (
    controlSocket: WebSocket,
    connectionId: string,
    code: number,
    reason: string,
  ): void => {
    if (control !== controlSocket || controlSocket.readyState !== WebSocket.OPEN) return;
    try {
      controlSocket.send(JSON.stringify({
        t: "reject",
        id: connectionId,
        code: applicationCloseCode(code, RELAY_CLOSE_BRIDGE_REJECTED),
        reason: sanitizedCloseReason(reason, "bridge rejected"),
      }));
    } catch {
      // A dead control socket is handled by the native ping/pong state machine.
    }
  };

  const openTunnel = async (
    id: MachineIdentity,
    connectionId: string,
    controlSocket: WebSocket,
  ): Promise<void> => {
    if (!await validateCurrentBridge()) {
      sendControlReject(
        controlSocket,
        connectionId,
        args.getSyncPort() == null || !accountSignedIn()
          ? RELAY_CLOSE_HOST_UNAVAILABLE
          : RELAY_CLOSE_BRIDGE_REJECTED,
        args.getSyncPort() == null ? "host sync listener unavailable" : "bridge validation failed",
      );
      return;
    }
    if (control !== controlSocket) return;

    const port = validatedPort;
    if (
      port == null
      || args.getSyncPort() !== port
      || (args.getExpectedLoopbackNonce?.() ?? null) !== validatedLoopbackNonce
      || !accountSignedIn()
    ) {
      clearBridgeValidation();
      recordFailure("Relay bridge refused because the ADE sync listener changed during validation.");
      sendControlReject(controlSocket, connectionId, RELAY_CLOSE_BRIDGE_REJECTED, "bridge identity changed");
      return;
    }
    const relayBridgeProof = args.getRelayBridgeProof();
    if (!relayBridgeProof) {
      clearBridgeValidation();
      recordFailure("Relay bridge refused because the local bridge credential is unavailable.");
      log.warn?.("sync_tunnel.no_bridge_credential", { connectionId, port });
      sendControlReject(controlSocket, connectionId, RELAY_CLOSE_BRIDGE_REJECTED, "bridge credential unavailable");
      return;
    }
    const ts = nowSeconds();
    const sig = signRelayHmacHex(id.secret, buildPipeSignatureBase(id.machineKey, connectionId, ts));
    const pipeUrl = `${httpToWsUrl(relayHttpUrl())}/host/${id.machineKey}/pipe/${connectionId}?ts=${ts}&sig=${sig}`;

    if (control !== controlSocket) return;
    let pipe: WebSocket | null = null;
    let local: WebSocket | null = null;
    try {
      pipe = new WebSocket(pipeUrl);
      local = new WebSocket(`ws://127.0.0.1:${String(port)}`, {
        headers: { [SYNC_RELAY_BRIDGE_PROOF_HEADER]: relayBridgeProof },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordFailure(reason);
      if (pipe) safeCloseWebSocket(pipe, RELAY_CLOSE_BRIDGE_REJECTED, "bridge setup failed");
      sendControlReject(
        controlSocket,
        connectionId,
        pipe ? RELAY_CLOSE_HOST_UNAVAILABLE : RELAY_CLOSE_BRIDGE_REJECTED,
        pipe ? "host sync listener unavailable" : "relay pipe unavailable",
      );
      return;
    }

    const tunnel: Tunnel = { pipe, local, connectionId };
    tunnels.add(tunnel);
    let pipeOpen = false;
    let localOpen = false;
    let rejected = false;
    const bridgeReady = (): boolean => pipeOpen && localOpen;
    const rejectOpen = (code: number, reason: string): void => {
      if (rejected) return;
      rejected = true;
      sendControlReject(controlSocket, connectionId, code, reason);
    };
    const closeBoth = (sourceCode: number, sourceReason: unknown): void => {
      if (!tunnels.delete(tunnel)) return;
      const code = applicationCloseCode(sourceCode);
      const reason = sanitizedCloseReason(sourceReason, "partner closed");
      safeCloseWebSocket(pipe, code, reason);
      safeCloseWebSocket(local, code, reason);
      log.debug?.("sync_tunnel.closed", { connectionId, code });
    };

    armOpenDeadline(pipe, () => {
      recordFailure("relay pipe connect timed out");
      rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "relay pipe unavailable");
    });
    armOpenDeadline(local, () => {
      recordFailure("local sync socket connect timed out");
      rejectOpen(RELAY_CLOSE_HOST_UNAVAILABLE, "host sync listener unavailable");
    });

    pipe.on("open", () => { pipeOpen = true; });
    local.on("open", () => { localOpen = true; });

    // Byte-for-byte forwarding in both directions; the `isBinary` flag preserves
    // text-vs-binary framing so the sync protocol rides through unmodified.
    // The relay flushes the phone's buffered pre-pipe frames (its hello) the
    // instant this pipe opens — usually BEFORE the local socket to the sync
    // host has finished connecting — so each direction buffers until its
    // target opens rather than dropping those first frames.
    const forwardOrBuffer = makeBufferedForwarder(() => {
      if (!bridgeReady()) rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "bridge frame buffer overflow");
      closeBoth(RELAY_CLOSE_BRIDGE_REJECTED, "bridge frame buffer overflow");
    });
    pipe.on("message", (data: RawData, isBinary: boolean) => forwardOrBuffer(local, data, isBinary));
    local.on("message", (data: RawData, isBinary: boolean) => forwardOrBuffer(pipe, data, isBinary));
    pipe.on("close", (code: number, reason: Buffer) => {
      if (!bridgeReady()) {
        rejectOpen(applicationCloseCode(code, RELAY_CLOSE_BRIDGE_REJECTED), "relay pipe unavailable");
      }
      closeBoth(code, reason);
    });
    local.on("close", (code: number, reason: Buffer) => {
      if (!bridgeReady()) rejectOpen(RELAY_CLOSE_HOST_UNAVAILABLE, "host sync listener unavailable");
      closeBoth(code, reason);
    });
    pipe.on("error", (error: Error) => {
      recordFailure(error.message);
      if (!bridgeReady()) rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "relay pipe unavailable");
      closeBoth(RELAY_CLOSE_PARTNER_CLOSED, "relay pipe error");
    });
    local.on("error", (error: Error) => {
      recordFailure(error.message);
      if (!bridgeReady()) rejectOpen(RELAY_CLOSE_HOST_UNAVAILABLE, "host sync listener unavailable");
      closeBoth(RELAY_CLOSE_PARTNER_CLOSED, "host sync listener error");
    });

    log.debug?.("sync_tunnel.open", { connectionId });
  };

  const closeRelayConnections = (controlReason: string): void => {
    stopControlLiveness?.();
    stopControlLiveness = null;
    const socket = control;
    control = null;
    if (socket) {
      const state = controlSocketStates.get(socket);
      if (state && !state.failureReason) state.failureReason = controlReason;
      try {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        } else {
          socket.close(1000, controlReason.slice(0, 123));
        }
      } catch {
        // ignore
      }
    }
    for (const tunnel of [...tunnels]) {
      tunnels.delete(tunnel);
      safeCloseWebSocket(tunnel.pipe, RELAY_CLOSE_PARTNER_CLOSED, "host unavailable");
      safeCloseWebSocket(tunnel.local, RELAY_CLOSE_PARTNER_CLOSED, "host unavailable");
    }
    connected = false;
    clearBridgeValidation();
  };

  const reconcileAccountEligibility = async (): Promise<void> => {
    if (stopped || !started) return;
    const nextEligibility = computeAccountEligibility();
    accountEligible = nextEligibility;
    if (!nextEligibility) {
      clearReconnect();
      lastError = RELAY_SIGN_IN_REQUIRED_MESSAGE;
      closeRelayConnections("account lease unavailable");
      return;
    }
    if (lastError === RELAY_SIGN_IN_REQUIRED_MESSAGE) lastError = null;
    if (!control && !connectingControl && !reconnectTimer) await connectControl();
  };

  const refreshAccountLease = async (): Promise<void> => {
    if (!args.getAccountLease) {
      await reconcileAccountEligibility();
      return;
    }
    if (accountLeaseCheckInFlight) return await accountLeaseCheckInFlight;
    const check = (async () => {
      const previousUserId = accountLeaseUserId;
      try {
        const lease = await args.getAccountLease?.();
        const nextUserId = lease?.userId.trim() || null;
        const parsedExpiry = lease?.expiresAt ? Date.parse(lease.expiresAt) : Number.NaN;
        accountLeaseExpiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : null;
        consecutiveAccountLeaseFailures = 0;
        accountLeaseUserId = nextUserId;
        if (previousUserId !== nextUserId) {
          closeRelayConnections(nextUserId ? "account identity changed" : "account lease unavailable");
        }
      } catch (error) {
        consecutiveAccountLeaseFailures += 1;
        const reason = error instanceof Error ? error.message : String(error);
        const leaseStillCurrent = previousUserId != null
          && accountLeaseExpiresAtMs != null
          && accountLeaseExpiresAtMs > Date.now();
        log.warn?.("sync_tunnel.account_lease_failed", {
          error: reason,
          consecutiveFailures: consecutiveAccountLeaseFailures,
          leaseExpiresAt: accountLeaseExpiresAtMs == null
            ? null
            : new Date(accountLeaseExpiresAtMs).toISOString(),
          retained: leaseStillCurrent,
        });
        if (!leaseStillCurrent) {
          accountLeaseUserId = null;
          closeRelayConnections("account lease refresh failed or expired");
        }
      }
      await reconcileAccountEligibility();
    })();
    accountLeaseCheckInFlight = check;
    try {
      await check;
    } finally {
      if (accountLeaseCheckInFlight === check) accountLeaseCheckInFlight = null;
    }
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;
      accountEligible = null;
      accountStatusTimer = setInterval(
        () => { void refreshAccountLease(); },
        args.accountStatusPollMs ?? ACCOUNT_STATUS_POLL_MS,
      );
      accountStatusTimer.unref?.();
      await refreshAccountLease();
    },

    async stop(): Promise<void> {
      stopped = true;
      started = false;
      clearReconnect();
      if (accountStatusTimer) {
        clearInterval(accountStatusTimer);
        accountStatusTimer = null;
      }
      accountEligible = null;
      closeRelayConnections("service stopped");
    },

    validateCurrentBridge,

    getStatus(): SyncTunnelClientStatus {
      const { machineKey } = identity();
      const currentPort = args.getSyncPort();
      const currentLoopbackNonce = args.getExpectedLoopbackNonce?.() ?? null;
      const eligible = accountSignedIn();
      return {
        accountLeaseValid: eligible,
        connected: eligible && connected,
        activeTunnels: eligible ? tunnels.size : 0,
        lastError: eligible ? lastError : RELAY_SIGN_IN_REQUIRED_MESSAGE,
        lastControlError,
        relayBridgeValidated: eligible
          && currentPort != null
          && currentLoopbackNonce != null
          && validatedPort === currentPort
          && validatedLoopbackNonce === currentLoopbackNonce,
        validatedPort,
        lastFailureAt,
        lastControlOpenAt,
        lastBridgeValidationAt,
        relayUrl: relayHttpUrl(),
        machineKey,
      };
    },

    async dispose(): Promise<void> {
      await this.stop();
    },
  };
}

type Tunnel = { pipe: WebSocket; local: WebSocket; connectionId: string };

function captureUnexpectedResponseBody(
  response: IncomingMessage,
  onCaptured: (body: string) => void,
): void {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    const body = Buffer.concat(chunks, capturedBytes)
      .toString("utf8")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    onCaptured(body);
  };
  response.on("data", (value: Buffer | string) => {
    if (capturedBytes >= MAX_UNEXPECTED_RESPONSE_BODY_BYTES) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = MAX_UNEXPECTED_RESPONSE_BODY_BYTES - capturedBytes;
    const bounded = chunk.subarray(0, remaining);
    chunks.push(bounded);
    capturedBytes += bounded.length;
    if (capturedBytes >= MAX_UNEXPECTED_RESPONSE_BODY_BYTES) finish();
  });
  response.once("end", finish);
  response.once("aborted", finish);
  response.once("error", finish);
  response.once("close", finish);
}

function forward(target: WebSocket, data: RawData, isBinary: boolean): void {
  if (target.readyState !== WebSocket.OPEN) return;
  try {
    target.send(data, { binary: isBinary });
  } catch {
    // The target is mid-close; its close handler tears the pair down.
  }
}

/** Deadline for the claim POST and every socket to reach OPEN. */
export const CONNECT_DEADLINE_MS = 15_000;

const sharedTunnelClients = new Map<string, SyncTunnelClientService>();

/**
 * Machine-level singleton keyed by the relay config file path. Every project
 * scope in the multi-project daemon shares ONE tunnel client — a per-scope
 * instance would re-register the same machineKey with the relay on every
 * project open and churn the host connection paired phones dial through.
 */
export function getSharedSyncTunnelClientService(
  key: string,
  make: () => SyncTunnelClientService,
): SyncTunnelClientService {
  let existing = sharedTunnelClients.get(key);
  if (!existing) {
    existing = make();
    sharedTunnelClients.set(key, existing);
  }
  return existing;
}

/** Shutdown-path lookup: never mints a client just to stop it. */
export function peekSharedSyncTunnelClientService(key: string): SyncTunnelClientService | undefined {
  return sharedTunnelClients.get(key);
}

/**
 * Terminates a socket that has not opened within the deadline so a stalled
 * relay or dead local sync port surfaces as an error + reconnect instead of a
 * silently hung tunnel. No-op once the socket opens or closes first.
 */
function armOpenDeadline(socket: WebSocket, onTimeout: () => void): void {
  const timer = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      onTimeout();
      try {
        socket.terminate();
      } catch {
        // already dead
      }
    }
  }, CONNECT_DEADLINE_MS);
  timer.unref?.();
  const clear = () => clearTimeout(timer);
  socket.once("open", clear);
  socket.once("close", clear);
  socket.once("error", clear);
}

/** Native protocol ping/pong liveness; no JSON frames reach or wake the DO. */
function armControlLiveness(
  socket: WebSocket,
  onMiss: () => void,
  pingIntervalMs: number,
  pongDeadlineMs: number,
): () => void {
  let stopped = false;
  let pongDeadline: NodeJS.Timeout | null = null;
  const clearPongDeadline = (): void => {
    if (!pongDeadline) return;
    clearTimeout(pongDeadline);
    pongDeadline = null;
  };
  const onPong = (): void => {
    clearPongDeadline();
  };
  const pingTimer = setInterval(() => {
    if (stopped || socket.readyState !== WebSocket.OPEN || pongDeadline) return;
    pongDeadline = setTimeout(() => {
      pongDeadline = null;
      if (!stopped) onMiss();
    }, pongDeadlineMs);
    pongDeadline.unref?.();
    try {
      socket.ping();
    } catch {
      clearPongDeadline();
      onMiss();
    }
  }, pingIntervalMs);
  pingTimer.unref?.();
  socket.on("pong", onPong);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(pingTimer);
    clearPongDeadline();
    socket.off("pong", onPong);
  };
  socket.once("close", stop);
  return stop;
}

function safeCloseWebSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(applicationCloseCode(code), sanitizedCloseReason(reason, "partner closed"));
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  } catch {
    // already closing/dead
  }
}

/** Frames buffered per still-connecting target before the pair is torn down. */
export const MAX_PENDING_TUNNEL_FRAMES = 64;

/**
 * Forwards frames to a target socket, buffering (bounded, in order) while the
 * target is still CONNECTING and flushing on `open`. A closed/closing target
 * or an overflowing buffer tears the pair down via `onOverflow` — dropping
 * frames mid-stream would corrupt the sync protocol.
 */
export function makeBufferedForwarder(onOverflow: () => void) {
  const pending = new Map<WebSocket, Array<{ data: RawData; isBinary: boolean }>>();
  return (target: WebSocket, data: RawData, isBinary: boolean): void => {
    if (target.readyState === WebSocket.OPEN) {
      forward(target, data, isBinary);
      return;
    }
    if (target.readyState !== WebSocket.CONNECTING) return;
    let queue = pending.get(target);
    if (!queue) {
      queue = [];
      pending.set(target, queue);
      target.once("open", () => {
        const frames = pending.get(target) ?? [];
        pending.delete(target);
        for (const frame of frames) forward(target, frame.data, frame.isBinary);
      });
    }
    if (queue.length >= MAX_PENDING_TUNNEL_FRAMES) {
      pending.delete(target);
      onOverflow();
      return;
    }
    queue.push({ data, isBinary });
  };
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}
