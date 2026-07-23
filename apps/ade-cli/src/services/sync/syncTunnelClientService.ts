import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
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
import {
  probeRelayEndToEnd,
  type RelaySelfProbeResult,
} from "./syncRelaySelfProbe";
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
  /** Current-generation pipe/local setup blocker; additive for older consumers. */
  bridgeOpenFailure?: string | null;
  lastControlError: string | null;
  relayBridgeValidated: boolean;
  validatedPort: number | null;
  lastFailureAt: string | null;
  lastControlOpenAt: string | null;
  lastBridgeValidationAt: string | null;
  relayEndToEndVerifiedAt: string | null;
  relayEndToEndFailure: string | null;
  relayEndToEndRoundTripMs: number | null;
  relayUrl: string;
  machineKey: string;
};

export type SyncTunnelClientService = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Re-probe the active shared listener without opening a Relay pipe. */
  validateCurrentBridge(): Promise<boolean>;
  /** Dial Relay exactly like a ready-v2 controller and verify bridge readiness. */
  runSelfProbe(): Promise<{ ok: boolean; detail: string }>;
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
  controlJsonPingIntervalMs?: number;
  controlJsonPongDeadlineMs?: number;
  controlReadyStableMs?: number;
  reconnectBackoffMs?: (attempt: number) => number;
  createWebSocket?: (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  /** Requests a directory refresh when publication-relevant Relay state changes. */
  onPublicationStateChanged?: (
    reason: "identity-rotated" | "route-state-changed",
  ) => void | Promise<void>;
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const ACCOUNT_STATUS_POLL_MS = 1_000;
export const CONTROL_PING_INTERVAL_MS = 30_000;
export const CONTROL_PONG_DEADLINE_MS = 10_000;
export const CONTROL_JSON_PING_INTERVAL_MS = 180_000;
export const CONTROL_JSON_PONG_DEADLINE_MS = 30_000;
export const CONTROL_JSON_INITIAL_PING_DELAY_MS = 1_000;
export const RELAY_CLOSE_PARTNER_CLOSED = 4000;
export const RELAY_CLOSE_HOST_UNAVAILABLE = 4501;
export const RELAY_CLOSE_BRIDGE_REJECTED = 4507;
export const RELAY_CLOSE_FORWARD_FAILED = 4509;
export const RELAY_SIGN_IN_REQUIRED_MESSAGE = "Sign in to ADE to use ADE Relay.";
export const BRIDGE_VALIDATION_LEASE_MS = 2_000;
export const CONTROL_READY_STABLE_MS = 5_000;
export const RELAY_READY_VERSION = 2;
export const RELAY_SELF_PROBE_DEBOUNCE_MS = 2_000;
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

type RelayTransportMode = "epoch" | "legacy";

type BridgeValidationIdentity = {
  key: string;
  port: number | null;
  nonce: string | null;
  accountEligible: boolean;
  accountGeneration: number;
  controlGeneration: number;
};

type PendingBridgeOpen = {
  controlSocket: WebSocket;
  reject: (code: number, reason: string) => void;
};

type BridgeOpenFailureSource = "bridge-open" | "self-probe";

type RelaySelfProbeState = {
  verifiedAtMs: number | null;
  lastFailure: string | null;
  lastFailureAtMs: number | null;
  inFlight: boolean;
};

/**
 * Exponential backoff with full jitter, capped at 60s. Exposed for tests so the
 * reconnect schedule is verifiable without waiting on real timers.
 */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

type ControlOpenMessage = {
  t: "open";
  id: string;
  epoch?: string;
  readyVersion?: typeof RELAY_READY_VERSION;
};

export type ControlMessage = ControlOpenMessage | {
  t: "pong";
};

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
    const epoch = (parsed as { epoch?: unknown }).epoch;
    const readyVersion = (parsed as { readyVersion?: unknown }).readyVersion;
    if (typeof id !== "string" || !/^[a-f0-9]{8,32}$/i.test(id)) return null;
    if (epoch == null && readyVersion == null) return { t: "open", id };
    if (
      typeof epoch !== "string"
      || !/^[a-f0-9]{32}$/i.test(epoch)
      || (readyVersion != null && readyVersion !== RELAY_READY_VERSION)
    ) return null;
    return {
      t: "open",
      id,
      epoch,
      ...(readyVersion === RELAY_READY_VERSION ? { readyVersion } : {}),
    };
  }
  if (t === "pong") return { t: "pong" };
  return null;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function hostSignatureBase(
  machineKey: string,
  timestamp: string,
  mode: RelayTransportMode,
  epoch: string,
): string {
  if (mode === "legacy") return buildHostSignatureBase(machineKey, timestamp);
  return buildHostSignatureBase(machineKey, epoch, timestamp);
}

function pipeSignatureBase(
  machineKey: string,
  connectionId: string,
  timestamp: string,
  epoch: string | undefined,
): string {
  if (!epoch) return buildPipeSignatureBase(machineKey, connectionId, timestamp);
  return buildPipeSignatureBase(machineKey, connectionId, epoch, timestamp);
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
  let stopControlJsonKeepalive: (() => void) | null = null;
  let controlReadyTimer: NodeJS.Timeout | null = null;
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
  let bridgeOpenFailure: {
    key: string;
    reason: string;
    source: BridgeOpenFailureSource;
  } | null = null;
  let validatedPort: number | null = null;
  let validatedLoopbackNonce: string | null = null;
  let lastFailureAt: string | null = null;
  let lastControlOpenAt: string | null = null;
  let lastBridgeValidationAt: string | null = null;
  let validatedAtMs = 0;
  let validatedBridgeKey: string | null = null;
  let bridgeValidationInFlight: {
    key: string;
    promise: Promise<boolean>;
  } | null = null;
  let claimedIdentity: { relayOrigin: string; machineKey: string } | null = null;
  let accountLeaseExpiresAtMs: number | null = null;
  let consecutiveAccountLeaseFailures = 0;
  let confirmedConflictRotations = 0;
  let identityRotationPendingPublish = false;
  let accountGeneration = 0;
  let controlGeneration = 0;
  let transportMode: RelayTransportMode = "epoch";
  let transportNegotiationKey: string | null = null;
  let epochFallbackUsed = false;
  let epochControlEstablished = false;
  let controlOpenedAtMs: number | null = null;
  let selfProbeBridgeKey: string | null = null;
  let selfProbeRoundTripMs: number | null = null;
  let selfProbe: RelaySelfProbeState = {
    verifiedAtMs: null,
    lastFailure: null,
    lastFailureAtMs: null,
    inFlight: false,
  };
  let selfProbeDebounceTimer: NodeJS.Timeout | null = null;
  let selfProbeScheduled: {
    key: string;
    promise: Promise<RelaySelfProbeResult>;
    resolve: (result: RelaySelfProbeResult) => void;
  } | null = null;
  let selfProbeInFlight: {
    key: string;
    promise: Promise<RelaySelfProbeResult>;
  } | null = null;
  let selfProbeSocket: WebSocket | null = null;
  const tunnels = new Set<Tunnel>();
  const pendingBridgeOpens = new Set<PendingBridgeOpen>();
  const controlSocketStates = new WeakMap<WebSocket, ControlSocketState>();
  const loopbackProbe = args.loopbackProbe ?? probeAdeLoopbackListener;
  let requestSelfProbe: (
    key: string,
    options?: { debounce?: boolean },
  ) => Promise<RelaySelfProbeResult>;

  const recordFailure = (reason: string): void => {
    lastError = reason;
    lastFailureAt = new Date().toISOString();
  };

  const requestPublicationStatePublish = (
    reason: "identity-rotated" | "route-state-changed",
  ): void => {
    const failureEvent = reason === "identity-rotated"
      ? "sync_tunnel.identity_republish_failed"
      : "sync_tunnel.route_state_republish_failed";
    void Promise.resolve()
      .then(() => args.onPublicationStateChanged?.(reason))
      .catch((error) => {
        log.warn?.(failureEvent, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const clearScheduledSelfProbe = (reason: string): void => {
    if (selfProbeDebounceTimer) {
      clearTimeout(selfProbeDebounceTimer);
      selfProbeDebounceTimer = null;
    }
    const scheduled = selfProbeScheduled;
    selfProbeScheduled = null;
    scheduled?.resolve({ ok: false, reason });
  };

  const resetSelfProbeForControlGeneration = (): void => {
    clearScheduledSelfProbe("Relay bridge identity changed before self-probe.");
    const probeSocket = selfProbeSocket;
    selfProbeSocket = null;
    if (probeSocket) {
      try {
        probeSocket.terminate();
      } catch {
        // already closed
      }
    }
    selfProbeBridgeKey = null;
    selfProbeRoundTripMs = null;
    selfProbe = {
      verifiedAtMs: null,
      // A failed relay verdict remains authoritative until a later generation
      // proves the route healthy; otherwise reconnect would look like benign
      // startup and the directory could retain the stale endpoint.
      lastFailure: selfProbe.lastFailure,
      lastFailureAtMs: selfProbe.lastFailureAtMs,
      inFlight: false,
    };
  };

  const clearBridgeOpenFailure = (
    expectedKey?: string,
    expectedSource?: BridgeOpenFailureSource,
  ): boolean => {
    if (!bridgeOpenFailure) return false;
    if (expectedKey && bridgeOpenFailure.key !== expectedKey) return false;
    if (expectedSource && bridgeOpenFailure.source !== expectedSource) return false;
    const previousFailure = bridgeOpenFailure;
    bridgeOpenFailure = null;
    if (lastError === previousFailure.reason) lastError = null;
    requestPublicationStatePublish("route-state-changed");
    if (
      previousFailure.source === "bridge-open"
      && validatedBridgeKey === previousFailure.key
      && control?.readyState === WebSocket.OPEN
    ) {
      void requestSelfProbe(previousFailure.key);
    }
    return true;
  };

  const clearBridgeValidation = (): void => {
    validatedPort = null;
    validatedLoopbackNonce = null;
    validatedAtMs = 0;
    validatedBridgeKey = null;
  };

  const clearControlReadyTimer = (): void => {
    if (!controlReadyTimer) return;
    clearTimeout(controlReadyTimer);
    controlReadyTimer = null;
  };

  const advanceControlGeneration = (): void => {
    controlGeneration += 1;
    clearControlReadyTimer();
    clearBridgeValidation();
    bridgeOpenFailure = null;
    resetSelfProbeForControlGeneration();
  };

  const recordControlFailure = (reason: string): void => {
    lastControlError = reason;
    recordFailure(reason);
  };

  const publishRotatedIdentityIfReady = (): void => {
    if (!identityRotationPendingPublish || !connected) return;
    identityRotationPendingPublish = false;
    requestPublicationStatePublish("identity-rotated");
  };

  const identity = (): MachineIdentity => {
    const override = args.machineIdentity?.();
    return override ?? args.configStore.getMachineIdentity();
  };

  const relayHttpUrl = (): string => args.configStore.getRelayUrl() || defaultRelayUrl();
  const createWebSocket = args.createWebSocket
    ?? ((url: string, options?: { headers?: Record<string, string> }) => new WebSocket(url, options));
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

  const bridgeValidationIdentity = (): BridgeValidationIdentity => {
    const eligible = accountSignedIn();
    const port = args.getSyncPort();
    const nonce = args.getExpectedLoopbackNonce?.() ?? null;
    return {
      key: JSON.stringify([
        port,
        nonce,
        eligible,
        accountLeaseUserId,
        accountGeneration,
        controlGeneration,
      ]),
      port,
      nonce,
      accountEligible: eligible,
      accountGeneration,
      controlGeneration,
    };
  };

  const bridgeIdentityIsCurrent = (expected: BridgeValidationIdentity): boolean =>
    bridgeValidationIdentity().key === expected.key;

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
    const computedDelay = args.reconnectBackoffMs?.(attempt) ?? computeBackoffMs(attempt);
    const delay = Number.isFinite(computedDelay) ? Math.max(0, Math.floor(computedDelay)) : BACKOFF_CAP_MS;
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

      const negotiationKey = `${relayHttpUrl().replace(/\/+$/, "")}:${id.machineKey}`;
      if (transportNegotiationKey !== negotiationKey) {
        transportNegotiationKey = negotiationKey;
        transportMode = "epoch";
        epochFallbackUsed = false;
        epochControlEstablished = false;
      }
      const socketTransportMode = transportMode;
      const controlEpoch = randomBytes(16).toString("hex");
      const ts = nowSeconds();
      const sig = signRelayHmacHex(
        id.secret,
        hostSignatureBase(id.machineKey, ts, socketTransportMode, controlEpoch),
      );
      const wsBase = httpToWsUrl(relayHttpUrl());
      const url = socketTransportMode === "epoch"
        ? `${wsBase}/host/${id.machineKey}?epoch=${controlEpoch}&ts=${ts}&sig=${sig}`
        : `${wsBase}/host/${id.machineKey}?ts=${ts}&sig=${sig}`;
      let socket: WebSocket;
      try {
        socket = createWebSocket(url);
      } catch (error) {
        if (socketTransportMode === "legacy" && epochFallbackUsed) transportMode = "epoch";
        const reason = error instanceof Error ? error.message : String(error);
        recordControlFailure(reason);
        log.warn?.("sync_tunnel.control_error", { error: reason });
        reconnectAfterAttempt = true;
        return;
      }
      const socketState: ControlSocketState = { opened: false, failureReason: null };
      controlSocketStates.set(socket, socketState);
      advanceControlGeneration();
      const socketControlGeneration = controlGeneration;
      control = socket;
      let socketLivenessStop: (() => void) | null = null;
      let socketJsonKeepaliveStop: (() => void) | null = null;
      let acceptJsonPong: (() => void) | null = null;
      const activateLegacyFallback = (reason: string): boolean => {
        if (
          socketTransportMode !== "epoch"
          || socketState.opened
          || epochControlEstablished
          || epochFallbackUsed
          || transportNegotiationKey !== negotiationKey
        ) return false;
        epochFallbackUsed = true;
        transportMode = "legacy";
        reconnectAfterAttempt = true;
        log.info?.("sync_tunnel.transport_fallback", {
          machineKey: id.machineKey,
          from: "epoch",
          to: "legacy",
          reason,
        });
        return true;
      };
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
        if (socketTransportMode === "epoch") epochControlEstablished = true;
        clearReconnect();
        connected = true;
        lastError = null;
        controlOpenedAtMs = Date.now();
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
        const jsonKeepalive = armControlJsonKeepalive(
          socket,
          () => {
            if (control !== socket) return;
            const reason = "relay control unreachable at relay (zombie socket)";
            socketState.failureReason = reason;
            recordControlFailure(reason);
            const currentBridgeKey = bridgeValidationIdentity().key;
            const verificationStateChanged = selfProbe.lastFailure !== reason
              || selfProbe.verifiedAtMs != null
              || selfProbeBridgeKey !== currentBridgeKey;
            selfProbeBridgeKey = currentBridgeKey;
            selfProbeRoundTripMs = null;
            selfProbe = {
              verifiedAtMs: null,
              lastFailure: reason,
              lastFailureAtMs: Date.now(),
              inFlight: false,
            };
            if (verificationStateChanged) {
              requestPublicationStatePublish("route-state-changed");
            }
            const { machineKey } = identity();
            log.warn?.("sync_tunnel.zombie_control_detected", {
              machineKey,
              controlAgeMs: controlOpenedAtMs == null
                ? null
                : Math.max(0, Date.now() - controlOpenedAtMs),
              transportMode: socketTransportMode,
              source: "json-ping",
            });
            // Product analytics accepts only centrally allowlisted events and
            // is intentionally not widened from this service layer; this
            // incident remains available through the structured lifecycle log.
            try {
              socket.terminate();
            } catch {
              // already dead
            }
          },
          args.controlJsonPingIntervalMs ?? CONTROL_JSON_PING_INTERVAL_MS,
          args.controlJsonPongDeadlineMs ?? CONTROL_JSON_PONG_DEADLINE_MS,
        );
        socketJsonKeepaliveStop = jsonKeepalive.stop;
        acceptJsonPong = jsonKeepalive.acceptPong;
        stopControlJsonKeepalive = socketJsonKeepaliveStop;
        log.info?.("sync_tunnel.control_open", {
          machineKey: id.machineKey,
          openedAt: lastControlOpenAt,
          transportMode: socketTransportMode,
        });
        void validateCurrentBridge().then((validated) => {
          if (
            !validated
            || control !== socket
            || controlGeneration !== socketControlGeneration
            || stopped
            || !accountSignedIn()
          ) return;
          publishRotatedIdentityIfReady();
          const readyIdentity = bridgeValidationIdentity();
          if (validatedBridgeKey !== readyIdentity.key) return;
          void requestSelfProbe(readyIdentity.key);
          clearControlReadyTimer();
          const markStable = (): void => {
            controlReadyTimer = null;
            if (
              control !== socket
              || controlGeneration !== socketControlGeneration
              || stopped
              || !accountSignedIn()
              || validatedBridgeKey !== bridgeValidationIdentity().key
            ) return;
            attempt = 0;
            lastControlError = null;
            log.info?.("sync_tunnel.control_ready", {
              machineKey: id.machineKey,
              controlEpoch: socketTransportMode === "epoch" ? controlEpoch : null,
              transportMode: socketTransportMode,
            });
          };
          const stableMs = args.controlReadyStableMs ?? CONTROL_READY_STABLE_MS;
          if (stableMs <= 0) {
            markStable();
            return;
          }
          controlReadyTimer = setTimeout(markStable, stableMs);
          controlReadyTimer.unref?.();
        });
      });
      socket.on("message", (raw: RawData) => {
        if (control !== socket) return;
        const message = parseControlMessage(rawToText(raw));
        if (message?.t === "pong") {
          acceptJsonPong?.();
          return;
        }
        if (message?.t !== "open") return;
        if (socketTransportMode === "epoch" && message.epoch !== controlEpoch) {
          sendControlReject(
            socket,
            message.id,
            message.epoch,
            RELAY_CLOSE_BRIDGE_REJECTED,
            "stale control epoch",
          );
          return;
        }
        if (socketTransportMode === "legacy" && message.epoch != null) {
          sendControlReject(
            socket,
            message.id,
            message.epoch,
            RELAY_CLOSE_BRIDGE_REJECTED,
            "unexpected control epoch",
          );
          return;
        }
        void openTunnel(id, message, socket);
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
          if ([400, 401, 404, 426].includes(status)) {
            activateLegacyFallback(`control registration rejected with HTTP ${status}`);
          }
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
        socketJsonKeepaliveStop?.();
        if (stopControlJsonKeepalive === socketJsonKeepaliveStop) {
          stopControlJsonKeepalive = null;
        }
        acceptJsonPong = null;
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
        controlOpenedAtMs = null;
        control = null;
        advanceControlGeneration();
        for (const pendingOpen of [...pendingBridgeOpens]) {
          if (pendingOpen.controlSocket === socket) {
            pendingOpen.reject(RELAY_CLOSE_BRIDGE_REJECTED, "relay control unavailable");
          }
        }
        if (socketTransportMode === "legacy" && !socketState.opened && epochFallbackUsed) {
          // The one legacy negotiation attempt did not establish a control.
          // Return to epoch mode without making another downgrade attempt.
          transportMode = "epoch";
        }
        for (const tunnel of [...tunnels]) {
          if (tunnel.controlSocket !== socket || tunnel.ready) continue;
          tunnels.delete(tunnel);
          safeCloseWebSocket(tunnel.pipe, RELAY_CLOSE_BRIDGE_REJECTED, "relay control unavailable");
          safeCloseWebSocket(tunnel.local, RELAY_CLOSE_BRIDGE_REJECTED, "relay control unavailable");
        }
        if (!stopped && accountSignedIn()) {
          const closeReason = reason
            ? `Relay control closed (${code}): ${reason}`
            : `Relay control closed (${code}).`;
          if (!socketState.failureReason) {
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

  const runBridgeValidation = async (identityAtStart: BridgeValidationIdentity): Promise<boolean> => {
    if (!identityAtStart.accountEligible) {
      if (bridgeIdentityIsCurrent(identityAtStart)) {
        clearBridgeValidation();
        recordFailure(RELAY_SIGN_IN_REQUIRED_MESSAGE);
      }
      return false;
    }
    const { port, nonce: expectedLoopbackNonce } = identityAtStart;
    if (port == null) {
      if (bridgeIdentityIsCurrent(identityAtStart)) {
        clearBridgeValidation();
        recordFailure("Relay bridge refused because the ADE sync listener is not bound.");
        log.warn?.("sync_tunnel.no_sync_port");
      }
      return false;
    }
    if (!expectedLoopbackNonce) {
      if (bridgeIdentityIsCurrent(identityAtStart)) {
        clearBridgeValidation();
        recordFailure("Relay bridge refused because the ADE sync listener identity is unavailable.");
        log.warn?.("sync_tunnel.no_loopback_identity", { port });
      }
      return false;
    }
    try {
      const result = await assertAdeLoopbackListener(
        port,
        expectedLoopbackNonce,
        loopbackProbe,
      );
      if (stopped || !bridgeIdentityIsCurrent(identityAtStart)) {
        if (!stopped && !accountSignedIn()) recordFailure(RELAY_SIGN_IN_REQUIRED_MESSAGE);
        return false;
      }
      validatedPort = port;
      validatedLoopbackNonce = expectedLoopbackNonce;
      validatedAtMs = Date.now();
      validatedBridgeKey = identityAtStart.key;
      // A loopback probe alone cannot prove a failed Relay pipe recovered.
      // Only a later tunnel reaching markReady clears a bridge-open failure.
      if (bridgeOpenFailure?.key !== identityAtStart.key) lastError = null;
      lastBridgeValidationAt = result.checkedAt;
      log.debug?.("sync_tunnel.bridge_validated", { port });
      publishRotatedIdentityIfReady();
      // The bridge can validate after the control opened (listener came up
      // later); the end-to-end probe must follow every validation, not only
      // the control-open path, or Relay publication stays fail-closed.
      if (connected && !stopped) void requestSelfProbe(identityAtStart.key);
      return true;
    } catch (error) {
      if (stopped || !bridgeIdentityIsCurrent(identityAtStart)) return false;
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
    const currentIdentity = bridgeValidationIdentity();
    if (bridgeOpenFailure && bridgeOpenFailure.key !== currentIdentity.key) {
      clearBridgeOpenFailure();
    }
    if (validatedBridgeKey != null && validatedBridgeKey !== currentIdentity.key) {
      clearBridgeValidation();
    }
    const validationAgeMs = Date.now() - validatedAtMs;
    if (
      currentIdentity.accountEligible
      && currentIdentity.port != null
      && currentIdentity.nonce != null
      && validatedBridgeKey === currentIdentity.key
      && validationAgeMs >= 0
      && validationAgeMs <= BRIDGE_VALIDATION_LEASE_MS
    ) return Promise.resolve(true);
    if (bridgeValidationInFlight?.key === currentIdentity.key) {
      return bridgeValidationInFlight.promise;
    }
    const current = runBridgeValidation(currentIdentity)
      .catch((error) => {
        if (!bridgeIdentityIsCurrent(currentIdentity)) return false;
        const reason = error instanceof Error ? error.message : String(error);
        recordFailure(reason);
        log.warn?.("sync_tunnel.bridge_validation_failed", { error: reason });
        return false;
      })
      .finally(() => {
        if (bridgeValidationInFlight?.promise === current) bridgeValidationInFlight = null;
      });
    bridgeValidationInFlight = { key: currentIdentity.key, promise: current };
    return current;
  };

  const recordBridgeOpenFailure = (
    reason: string,
    bridgeKey: string,
    failedTunnel?: Tunnel,
    source: BridgeOpenFailureSource = "bridge-open",
  ): void => {
    const hasReadyBridge = source === "bridge-open" && [...tunnels].some(
      (tunnel) => tunnel !== failedTunnel && tunnel.ready && tunnel.bridgeKey === bridgeKey,
    );
    if (hasReadyBridge) {
      lastFailureAt = new Date().toISOString();
      log.warn?.("sync_tunnel.bridge_open_failed", {
        connectionId: failedTunnel?.connectionId ?? null,
        error: reason,
        routeRetained: true,
      });
      return;
    }
    const stateChanged = bridgeOpenFailure?.key !== bridgeKey
      || bridgeOpenFailure?.reason !== reason
      || bridgeOpenFailure?.source !== source;
    bridgeOpenFailure = { key: bridgeKey, reason, source };
    if (
      source === "bridge-open"
      && selfProbeBridgeKey === bridgeKey
      && selfProbe.verifiedAtMs != null
    ) {
      selfProbeRoundTripMs = null;
      selfProbe = { ...selfProbe, verifiedAtMs: null };
    }
    recordFailure(reason);
    log.warn?.("sync_tunnel.bridge_open_failed", {
      connectionId: failedTunnel?.connectionId ?? null,
      error: reason,
      routeRetained: false,
    });
    if (stateChanged) requestPublicationStatePublish("route-state-changed");
  };

  const selfProbeReasonClass = (reason: string): string => {
    if (/timed out/i.test(reason)) return "timeout";
    if (/closed before/i.test(reason)) return "closed_before_ready";
    if (/invalid|binary/i.test(reason)) return "protocol";
    if (/WebSocket error|could not open/i.test(reason)) return "transport";
    return "unknown";
  };

  const prepareSelfProbeKey = (key: string): void => {
    if (selfProbeBridgeKey === key) return;
    selfProbeBridgeKey = key;
    selfProbeRoundTripMs = null;
    selfProbe = {
      verifiedAtMs: null,
      lastFailure: selfProbe.lastFailure,
      lastFailureAtMs: selfProbe.lastFailureAtMs,
      inFlight: false,
    };
  };

  const performSelfProbe = (key: string): Promise<RelaySelfProbeResult> => {
    if (
      stopped
      || !accountSignedIn()
      || control?.readyState !== WebSocket.OPEN
      || validatedBridgeKey !== key
      || bridgeValidationIdentity().key !== key
    ) {
      return Promise.resolve({
        ok: false,
        reason: "Relay self-probe skipped because the current control and bridge are not ready.",
      });
    }
    prepareSelfProbeKey(key);
    const controlSocket = control;
    const machineIdentity = identity();
    selfProbe = { ...selfProbe, inFlight: true };
    const current = probeRelayEndToEnd({
      relayWsBase: httpToWsUrl(relayHttpUrl()),
      machineKey: machineIdentity.machineKey,
      createWebSocket: (url) => {
        const socket = createWebSocket(url);
        selfProbeSocket = socket;
        return socket;
      },
    }).then((result) => {
      if (
        stopped
        || selfProbeBridgeKey !== key
        || validatedBridgeKey !== key
        || bridgeValidationIdentity().key !== key
      ) {
        return result;
      }
      if (result.ok) {
        const verifiedAtMs = Date.now();
        const stateChanged = selfProbe.verifiedAtMs !== verifiedAtMs
          || selfProbe.lastFailure != null
          || selfProbeRoundTripMs !== result.roundTripMs;
        selfProbeRoundTripMs = result.roundTripMs;
        selfProbe = {
          verifiedAtMs,
          lastFailure: null,
          lastFailureAtMs: null,
          inFlight: false,
        };
        const clearedFailure = clearBridgeOpenFailure(key, "self-probe");
        if (stateChanged && !clearedFailure) {
          requestPublicationStatePublish("route-state-changed");
        }
        log.debug?.("sync_tunnel.self_probe_ok", {
          machineKey: machineIdentity.machineKey,
          roundTripMs: result.roundTripMs,
        });
        return result;
      }

      if (result.atCapacity) {
        // The probe could not get a tunnel slot because this machine is at its
        // relay quota. That is inconclusive, not proof of health: a stale
        // control could also be at capacity if clients filled every slot. So we
        // render NO verdict here — neither claim end-to-end verified nor declare
        // a zombie/terminate control. The JSON control keepalive independently
        // owns zombie detection (it pings the control socket directly and does
        // not depend on tunnel slots), so a genuinely dead control is still
        // caught. Prior verification/publication state is left untouched: a
        // relay that verified before filling up stays published; one that never
        // verified stays unpublished.
        selfProbe = { ...selfProbe, inFlight: false };
        log.debug?.("sync_tunnel.self_probe_at_capacity", {
          machineKey: machineIdentity.machineKey,
          reason: result.reason,
        });
        return result;
      }

      const failureAtMs = Date.now();
      selfProbeRoundTripMs = null;
      selfProbe = {
        verifiedAtMs: null,
        lastFailure: result.reason,
        lastFailureAtMs: failureAtMs,
        inFlight: false,
      };
      recordBridgeOpenFailure(result.reason, key, undefined, "self-probe");
      log.warn?.("sync_tunnel.self_probe_failed", {
        machineKey: machineIdentity.machineKey,
        reason: result.reason,
        reasonClass: selfProbeReasonClass(result.reason),
      });
      if (control === controlSocket && controlSocket.readyState === WebSocket.OPEN) {
        const controlFailure = `relay end-to-end self-probe failed: ${result.reason}`;
        const socketState = controlSocketStates.get(controlSocket);
        if (socketState) socketState.failureReason = controlFailure;
        recordControlFailure(controlFailure);
        log.warn?.("sync_tunnel.zombie_control_detected", {
          machineKey: machineIdentity.machineKey,
          controlAgeMs: controlOpenedAtMs == null
            ? null
            : Math.max(0, Date.now() - controlOpenedAtMs),
          transportMode,
          source: "self-probe",
        });
        try {
          controlSocket.terminate();
        } catch {
          // already dead
        }
      }
      return result;
    }).finally(() => {
      if (selfProbeInFlight?.promise === current) selfProbeInFlight = null;
      if (selfProbeInFlight == null) selfProbeSocket = null;
      if (selfProbeBridgeKey === key && selfProbe.inFlight) {
        selfProbe = { ...selfProbe, inFlight: false };
      }
    });
    selfProbeInFlight = { key, promise: current };
    return current;
  };

  requestSelfProbe = (
    key: string,
    options: { debounce?: boolean } = {},
  ): Promise<RelaySelfProbeResult> => {
    prepareSelfProbeKey(key);
    if (selfProbeInFlight) {
      if (selfProbeInFlight.key === key) return selfProbeInFlight.promise;
      return selfProbeInFlight.promise.then(() => {
        if (bridgeValidationIdentity().key !== key) {
          return { ok: false, reason: "Relay bridge identity changed before self-probe." };
        }
        return requestSelfProbe(key, options);
      });
    }
    if (selfProbeScheduled?.key === key) return selfProbeScheduled.promise;
    if (selfProbeScheduled) {
      clearScheduledSelfProbe("Relay bridge identity changed before self-probe.");
    }
    if (options.debounce === false) return performSelfProbe(key);

    let resolveScheduled!: (result: RelaySelfProbeResult) => void;
    const promise = new Promise<RelaySelfProbeResult>((resolve) => {
      resolveScheduled = resolve;
    });
    selfProbeScheduled = { key, promise, resolve: resolveScheduled };
    selfProbeDebounceTimer = setTimeout(() => {
      selfProbeDebounceTimer = null;
      const scheduled = selfProbeScheduled;
      if (!scheduled || scheduled.key !== key) return;
      selfProbeScheduled = null;
      void performSelfProbe(key).then(scheduled.resolve);
    }, RELAY_SELF_PROBE_DEBOUNCE_MS);
    selfProbeDebounceTimer.unref?.();
    return promise;
  };

  const sendControlLifecycle = (
    controlSocket: WebSocket,
    payload: Record<string, unknown>,
    onFailure?: () => void,
  ): boolean => {
    if (controlSocket.readyState !== WebSocket.OPEN) return false;
    let failed = false;
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      const detail = error instanceof Error ? error.message : String(error);
      recordControlFailure(`relay control send failed: ${detail}`);
      safeCloseWebSocket(controlSocket, RELAY_CLOSE_PARTNER_CLOSED, "relay control send failed");
      onFailure?.();
    };
    try {
      controlSocket.send(JSON.stringify(payload), (error) => {
        if (error) fail(error);
      });
      return !failed;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const sendControlReject = (
    controlSocket: WebSocket,
    connectionId: string,
    epoch: string | undefined,
    code: number,
    reason: string,
  ): boolean => sendControlLifecycle(controlSocket, {
    t: "reject",
    id: connectionId,
    ...(epoch ? { epoch } : {}),
    code: applicationCloseCode(code, RELAY_CLOSE_BRIDGE_REJECTED),
    reason: sanitizedCloseReason(reason, "bridge rejected"),
  });

  const sendControlReady = (
    controlSocket: WebSocket,
    connectionId: string,
    epoch: string,
    onFailure: () => void,
  ): boolean => sendControlLifecycle(controlSocket, {
    t: "ready",
    id: connectionId,
    epoch,
  }, onFailure);

  const openTunnel = async (
    id: MachineIdentity,
    message: ControlOpenMessage,
    controlSocket: WebSocket,
  ): Promise<void> => {
    const { id: connectionId, epoch } = message;
    let settled = false;
    const pendingOpen: PendingBridgeOpen = {
      controlSocket,
      reject: (code, reason) => {
        if (settled) return;
        settled = true;
        pendingBridgeOpens.delete(pendingOpen);
        sendControlReject(controlSocket, connectionId, epoch, code, reason);
      },
    };
    const rejectOpen = pendingOpen.reject;
    const acceptOpen = (): void => {
      if (settled) return;
      settled = true;
      pendingBridgeOpens.delete(pendingOpen);
    };
    pendingBridgeOpens.add(pendingOpen);

    if (!await validateCurrentBridge()) {
      rejectOpen(
        args.getSyncPort() == null || !accountSignedIn()
          ? RELAY_CLOSE_HOST_UNAVAILABLE
          : RELAY_CLOSE_BRIDGE_REJECTED,
        args.getSyncPort() == null ? "host sync listener unavailable" : "bridge validation failed",
      );
      return;
    }
    if (settled) return;
    if (control !== controlSocket) {
      rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "control superseded");
      return;
    }

    const port = validatedPort;
    const validatedKey = validatedBridgeKey;
    if (
      port == null
      || validatedKey == null
      || bridgeValidationIdentity().key !== validatedKey
    ) {
      clearBridgeValidation();
      recordFailure("Relay bridge refused because the ADE sync listener changed during validation.");
      rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "bridge identity changed");
      return;
    }
    const relayBridgeProof = args.getRelayBridgeProof();
    if (!relayBridgeProof) {
      clearBridgeValidation();
      recordFailure("Relay bridge refused because the local bridge credential is unavailable.");
      log.warn?.("sync_tunnel.no_bridge_credential", { connectionId, port });
      rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "bridge credential unavailable");
      return;
    }
    const ts = nowSeconds();
    const sig = signRelayHmacHex(id.secret, pipeSignatureBase(id.machineKey, connectionId, ts, epoch));
    const pipeUrl = epoch
      ? `${httpToWsUrl(relayHttpUrl())}/host/${id.machineKey}/pipe/${connectionId}?epoch=${epoch}&ts=${ts}&sig=${sig}`
      : `${httpToWsUrl(relayHttpUrl())}/host/${id.machineKey}/pipe/${connectionId}?ts=${ts}&sig=${sig}`;

    if (control !== controlSocket || bridgeValidationIdentity().key !== validatedKey) {
      rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "control or listener superseded");
      return;
    }
    let pipe: WebSocket | null = null;
    let local: WebSocket | null = null;
    try {
      pipe = createWebSocket(pipeUrl);
      local = createWebSocket(`ws://127.0.0.1:${String(port)}`, {
        headers: { [SYNC_RELAY_BRIDGE_PROOF_HEADER]: relayBridgeProof },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordBridgeOpenFailure(reason, validatedKey);
      if (pipe) safeCloseWebSocket(pipe, RELAY_CLOSE_BRIDGE_REJECTED, "bridge setup failed");
      rejectOpen(
        pipe ? RELAY_CLOSE_HOST_UNAVAILABLE : RELAY_CLOSE_BRIDGE_REJECTED,
        pipe ? "host sync listener unavailable" : "relay pipe unavailable",
      );
      return;
    }

    const tunnel: Tunnel = {
      pipe,
      local,
      connectionId,
      controlSocket,
      bridgeKey: validatedKey,
      ready: false,
    };
    tunnels.add(tunnel);
    let pipeOpen = false;
    let localOpen = false;
    let bridgeFailureReported = false;
    const bridgeReady = (): boolean => pipeOpen && localOpen;
    const reportBridgeFailure = (reason: string): void => {
      if (tunnel.ready || bridgeFailureReported) return;
      bridgeFailureReported = true;
      recordBridgeOpenFailure(reason, validatedKey, tunnel);
    };
    const closeBoth = (sourceCode: number, sourceReason: unknown): void => {
      if (!tunnels.delete(tunnel)) return;
      const code = applicationCloseCode(sourceCode);
      const reason = sanitizedCloseReason(sourceReason, "partner closed");
      safeCloseWebSocket(pipe, code, reason);
      safeCloseWebSocket(local, code, reason);
      log.debug?.("sync_tunnel.closed", { connectionId, code });
    };
    const markReady = (): void => {
      if (!bridgeReady() || settled || tunnel.ready) return;
      if (control !== controlSocket || !accountSignedIn()) {
        rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "control superseded");
        closeBoth(RELAY_CLOSE_BRIDGE_REJECTED, "control superseded");
        return;
      }
      if (
        validatedBridgeKey !== validatedKey
        || bridgeValidationIdentity().key !== validatedKey
      ) {
        clearBridgeValidation();
        recordFailure("Relay bridge refused because the ADE sync listener changed before readiness.");
        rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "bridge identity changed");
        closeBoth(RELAY_CLOSE_BRIDGE_REJECTED, "bridge identity changed");
        return;
      }
      if (epoch) {
        const sent = sendControlReady(controlSocket, connectionId, epoch, () => {
          rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "relay readiness unavailable");
          closeBoth(RELAY_CLOSE_BRIDGE_REJECTED, "relay readiness unavailable");
        });
        if (!sent) {
          rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "relay readiness unavailable");
          closeBoth(RELAY_CLOSE_BRIDGE_REJECTED, "relay readiness unavailable");
          return;
        }
      }
      tunnel.ready = true;
      clearBridgeOpenFailure(validatedKey, "bridge-open");
      acceptOpen();
      log.debug?.("sync_tunnel.ready", {
        connectionId,
        epoch: epoch ?? null,
        transportMode: epoch ? "epoch" : "legacy",
      });
    };

    armOpenDeadline(pipe, () => {
      reportBridgeFailure("relay pipe connect timed out");
      rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "relay pipe unavailable");
    });
    armOpenDeadline(local, () => {
      reportBridgeFailure("local sync socket connect timed out");
      rejectOpen(RELAY_CLOSE_HOST_UNAVAILABLE, "host sync listener unavailable");
    });

    pipe.on("open", () => {
      pipeOpen = true;
      markReady();
    });
    local.on("open", () => {
      localOpen = true;
      markReady();
    });

    // Byte-for-byte forwarding in both directions; the `isBinary` flag preserves
    // text-vs-binary framing so the sync protocol rides through unmodified.
    // Legacy Workers may flush an early hello before the local socket opens;
    // keep one bounded aggregate queue. Ready-v2 Workers wait for markReady.
    const forwardOrBuffer = makeBufferedForwarder((reason) => {
      if (!tunnel.ready) {
        reportBridgeFailure(reason);
        rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, reason);
      }
      closeBoth(RELAY_CLOSE_FORWARD_FAILED, reason);
    });
    pipe.on("message", (data: RawData, isBinary: boolean) => forwardOrBuffer(local, data, isBinary));
    local.on("message", (data: RawData, isBinary: boolean) => forwardOrBuffer(pipe, data, isBinary));
    pipe.on("close", (code: number, reason: Buffer) => {
      if (!tunnel.ready) {
        rejectOpen(applicationCloseCode(code, RELAY_CLOSE_BRIDGE_REJECTED), "relay pipe unavailable");
      }
      closeBoth(code, reason);
    });
    local.on("close", (code: number, reason: Buffer) => {
      if (!tunnel.ready) rejectOpen(RELAY_CLOSE_HOST_UNAVAILABLE, "host sync listener unavailable");
      closeBoth(code, reason);
    });
    pipe.on("error", (error: Error) => {
      if (!tunnel.ready) {
        reportBridgeFailure(error.message);
        rejectOpen(RELAY_CLOSE_BRIDGE_REJECTED, "relay pipe unavailable");
      } else {
        lastFailureAt = new Date().toISOString();
        log.warn?.("sync_tunnel.pipe_error", { connectionId, error: error.message });
      }
      closeBoth(RELAY_CLOSE_PARTNER_CLOSED, "relay pipe error");
    });
    local.on("error", (error: Error) => {
      if (!tunnel.ready) {
        reportBridgeFailure(error.message);
        rejectOpen(RELAY_CLOSE_HOST_UNAVAILABLE, "host sync listener unavailable");
      } else {
        lastFailureAt = new Date().toISOString();
        log.warn?.("sync_tunnel.local_error", { connectionId, error: error.message });
      }
      closeBoth(RELAY_CLOSE_PARTNER_CLOSED, "host sync listener error");
    });

    log.debug?.("sync_tunnel.open", { connectionId });
  };

  const closeRelayConnections = (controlReason: string): void => {
    stopControlLiveness?.();
    stopControlLiveness = null;
    stopControlJsonKeepalive?.();
    stopControlJsonKeepalive = null;
    clearControlReadyTimer();
    const socket = control;
    for (const pendingOpen of [...pendingBridgeOpens]) {
      pendingOpen.reject(RELAY_CLOSE_HOST_UNAVAILABLE, controlReason);
    }
    control = null;
    if (socket) {
      advanceControlGeneration();
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
    controlOpenedAtMs = null;
    clearBridgeValidation();
    if (!socket) resetSelfProbeForControlGeneration();
  };

  const reconcileAccountEligibility = async (): Promise<void> => {
    if (stopped || !started) return;
    const nextEligibility = computeAccountEligibility();
    if (accountEligible != null && accountEligible !== nextEligibility) {
      accountGeneration += 1;
      clearControlReadyTimer();
      clearBridgeValidation();
      bridgeOpenFailure = null;
      resetSelfProbeForControlGeneration();
    }
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
          accountGeneration += 1;
          clearControlReadyTimer();
          clearBridgeValidation();
          bridgeOpenFailure = null;
          resetSelfProbeForControlGeneration();
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
          if (accountLeaseUserId != null) accountGeneration += 1;
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

    async runSelfProbe(): Promise<{ ok: boolean; detail: string }> {
      if (
        stopped
        || !accountSignedIn()
        || control?.readyState !== WebSocket.OPEN
      ) {
        return {
          ok: false,
          detail: "Relay self-probe skipped because the control socket is not connected.",
        };
      }
      if (!await validateCurrentBridge()) {
        return {
          ok: false,
          detail: "Relay self-probe skipped because the local bridge is not validated.",
        };
      }
      const currentIdentity = bridgeValidationIdentity();
      if (validatedBridgeKey !== currentIdentity.key) {
        return {
          ok: false,
          detail: "Relay self-probe skipped because the bridge identity changed.",
        };
      }
      const result = await requestSelfProbe(currentIdentity.key);
      return result.ok
        ? { ok: true, detail: `Relay end-to-end verified in ${result.roundTripMs}ms.` }
        : { ok: false, detail: result.reason };
    },

    getStatus(): SyncTunnelClientStatus {
      const { machineKey } = identity();
      const currentValidationIdentity = bridgeValidationIdentity();
      const currentPort = currentValidationIdentity.port;
      const currentLoopbackNonce = currentValidationIdentity.nonce;
      const eligible = accountSignedIn();
      const currentBridgeOpenFailure = bridgeOpenFailure?.key === currentValidationIdentity.key
        ? bridgeOpenFailure.reason
        : null;
      const currentSelfProbeVerified = selfProbeBridgeKey === currentValidationIdentity.key
        ? selfProbe.verifiedAtMs
        : null;
      const currentSelfProbeRoundTripMs = selfProbeBridgeKey === currentValidationIdentity.key
        ? selfProbeRoundTripMs
        : null;
      return {
        accountLeaseValid: eligible,
        connected: eligible && connected,
        activeTunnels: eligible ? tunnels.size : 0,
        lastError: eligible ? lastError : RELAY_SIGN_IN_REQUIRED_MESSAGE,
        bridgeOpenFailure: eligible ? currentBridgeOpenFailure : null,
        lastControlError,
        relayBridgeValidated: eligible
          && currentPort != null
          && currentLoopbackNonce != null
          && validatedPort === currentPort
          && validatedLoopbackNonce === currentLoopbackNonce
          && validatedBridgeKey === currentValidationIdentity.key,
        validatedPort,
        lastFailureAt,
        lastControlOpenAt,
        lastBridgeValidationAt,
        relayEndToEndVerifiedAt: eligible && currentSelfProbeVerified != null
          ? new Date(currentSelfProbeVerified).toISOString()
          : null,
        relayEndToEndFailure: eligible ? selfProbe.lastFailure : null,
        relayEndToEndRoundTripMs: eligible ? currentSelfProbeRoundTripMs : null,
        relayUrl: relayHttpUrl(),
        machineKey,
      };
    },

    async dispose(): Promise<void> {
      await this.stop();
    },
  };
}

type Tunnel = {
  pipe: WebSocket;
  local: WebSocket;
  connectionId: string;
  controlSocket: WebSocket;
  bridgeKey: string;
  ready: boolean;
};

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

function forward(
  target: WebSocket,
  data: RawData,
  isBinary: boolean,
  bufferedTargets: Set<WebSocket>,
  onFailure: (reason: string) => void,
): boolean {
  if (target.readyState !== WebSocket.OPEN) {
    onFailure("bridge target unavailable");
    return false;
  }
  bufferedTargets.add(target);
  const frameBytes = rawDataByteLength(data);
  if (frameBytes > MAX_RELAY_WEBSOCKET_FRAME_BYTES) {
    onFailure("bridge frame too large");
    return false;
  }
  let bufferedBytes = 0;
  for (const socket of bufferedTargets) {
    const amount = socket.bufferedAmount;
    if (Number.isFinite(amount) && amount > 0) bufferedBytes += amount;
  }
  const bufferWouldOverflow = frameBytes > MAX_BUFFERED_TUNNEL_BYTES
    ? bufferedBytes > 0
    : bufferedBytes > MAX_BUFFERED_TUNNEL_BYTES - frameBytes;
  if (bufferWouldOverflow) {
    onFailure("bridge send buffer overflow");
    return false;
  }
  try {
    target.send(data, { binary: isBinary }, (error) => {
      if (error) onFailure("bridge forwarding failed");
    });
    return true;
  } catch {
    onFailure("bridge forwarding failed");
    return false;
  }
}

function rawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
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

function armControlJsonKeepalive(
  socket: WebSocket,
  onMiss: () => void,
  pingIntervalMs: number,
  pongDeadlineMs: number,
): { stop: () => void; acceptPong: () => void } {
  const normalizedIntervalMs = Math.max(1, Math.floor(pingIntervalMs));
  const normalizedDeadlineMs = Math.max(1, Math.floor(pongDeadlineMs));
  let stopped = false;
  let pongDeadline: NodeJS.Timeout | null = null;
  let initialPingTimer: NodeJS.Timeout | null = null;

  const clearPongDeadline = (): void => {
    if (!pongDeadline) return;
    clearTimeout(pongDeadline);
    pongDeadline = null;
  };
  const miss = (): void => {
    clearPongDeadline();
    if (!stopped) onMiss();
  };
  const sendPing = (): void => {
    if (stopped || socket.readyState !== WebSocket.OPEN || pongDeadline) return;
    pongDeadline = setTimeout(miss, normalizedDeadlineMs);
    pongDeadline.unref?.();
    try {
      socket.send(JSON.stringify({ t: "ping" }), (error) => {
        if (error) miss();
      });
    } catch {
      miss();
    }
  };

  initialPingTimer = setTimeout(() => {
    initialPingTimer = null;
    sendPing();
  }, CONTROL_JSON_INITIAL_PING_DELAY_MS);
  initialPingTimer.unref?.();
  const pingTimer = setInterval(() => {
    // A tick delayed by sleep/wake needs no special handling: sending the ping
    // now is itself the recovery action, and sendPing() no-ops if a deadline is
    // already outstanding.
    sendPing();
  }, normalizedIntervalMs);
  pingTimer.unref?.();

  const acceptPong = (): void => {
    clearPongDeadline();
  };
  const onClose = (): void => {
    stop();
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (initialPingTimer) clearTimeout(initialPingTimer);
    initialPingTimer = null;
    clearInterval(pingTimer);
    clearPongDeadline();
    socket.off("close", onClose);
  };
  socket.once("close", onClose);
  return { stop, acceptPong };
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

/** Aggregate frames buffered across both still-connecting tunnel targets. */
export const MAX_PENDING_TUNNEL_FRAMES = 64;
/** Aggregate bytes buffered across both still-connecting tunnel targets. */
export const MAX_PENDING_TUNNEL_BYTES = 256 * 1024;
/** Aggregate bytes queued by Node across both open tunnel targets. */
export const MAX_BUFFERED_TUNNEL_BYTES = 4 * 1024 * 1024;
/**
 * Cloudflare Workers and Durable Objects reject received WebSocket messages
 * above 32 MiB before ADE code can inspect them. Modern sync peers use
 * `envelope_chunk` well below this boundary; legacy unchunked envelopes larger
 * than this cannot be carried over Relay and must fail locally and explicitly.
 */
export const MAX_RELAY_WEBSOCKET_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * Forwards frames to a target socket, buffering (bounded, in order) while the
 * target is still CONNECTING and flushing on `open`. Any forwarding error,
 * unavailable target, or aggregate frame/byte overflow fails the pair instead
 * of silently dropping a sync frame.
 */
export function makeBufferedForwarder(onFailure: (reason: string) => void) {
  const pending = new Map<WebSocket, Array<{ data: RawData; isBinary: boolean; bytes: number }>>();
  let pendingFrames = 0;
  let pendingBytes = 0;
  const bufferedTargets = new Set<WebSocket>();
  let failed = false;
  const fail = (reason: string): void => {
    if (failed) return;
    failed = true;
    pending.clear();
    pendingFrames = 0;
    pendingBytes = 0;
    onFailure(reason);
  };
  return (target: WebSocket, data: RawData, isBinary: boolean): void => {
    if (failed) return;
    if (target.readyState === WebSocket.OPEN) {
      forward(target, data, isBinary, bufferedTargets, fail);
      return;
    }
    if (target.readyState !== WebSocket.CONNECTING) {
      fail("bridge target unavailable");
      return;
    }
    let queue = pending.get(target);
    if (!queue) {
      queue = [];
      pending.set(target, queue);
      target.once("open", () => {
        const frames = pending.get(target) ?? [];
        pending.delete(target);
        pendingFrames -= frames.length;
        pendingBytes -= frames.reduce((total, frame) => total + frame.bytes, 0);
        for (const frame of frames) {
          if (!forward(target, frame.data, frame.isBinary, bufferedTargets, fail)) return;
        }
      });
    }
    const bytes = rawDataByteLength(data);
    if (
      pendingFrames >= MAX_PENDING_TUNNEL_FRAMES
      || bytes > MAX_PENDING_TUNNEL_BYTES - pendingBytes
    ) {
      fail("bridge frame buffer overflow");
      return;
    }
    queue.push({ data, isBinary, bytes });
    pendingFrames += 1;
    pendingBytes += bytes;
  };
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}
