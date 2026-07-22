import type {
  SyncBrainStatusPayload,
  SyncChangesetBatchPayload,
  SyncEnvelope,
  SyncDpopProof,
  SyncHeartbeatPayload,
  SyncHelloOkPayload,
  SyncHelloPayload,
  SyncHelloErrorPayload,
  SyncPeerMetadata,
  SyncProjectCatalogChunkPayload,
  SyncProjectCatalogPayload,
  SyncRelayAuthorizationLease,
  SyncRelayClientAccepted,
  SyncRelayClientReady,
  SyncRelayReauthorizePayload,
  SyncRelayReauthorizeResultPayload,
} from "../../../shared/types/sync";
import {
  SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
  SYNC_RELAY_READY_VERSION,
  SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY,
} from "../../../shared/types/sync";
export { SYNC_INVALIDATION_ONLY_V1_CAPABILITY } from "../../../shared/types/sync";
import { resolveAccountHelloPairing } from "../../../shared/accountDirectory";
import {
  browserEndpointRequiresRelayAccess,
  type BrowserDialCandidate,
} from "./endpoints";
import type { WebClientEnvironmentRecord } from "./envStore";
import { signDpopProof, signRelayReauthorizationProof } from "./dpop";
import { randomHex } from "./ids";
import {
  createProjectCatalogChunkAssembler,
  decodeEnvelopeText,
  encodeEnvelopeText,
  type EncodeEnvelopeInput,
} from "./wireProtocol";

const SOCKET_OPEN = 1;
const DEFAULT_TRANSPORT_OPEN_TIMEOUT_MS = 8_000;
const DEFAULT_AUTHENTICATED_HELLO_TIMEOUT_MS = 12_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const INBOUND_STALE_MS = 75_000;
const INBOUND_STALE_CHECK_INTERVAL_MS = 15_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_STABLE_CONNECTED_MS = 10_000;
const MAX_CONSECUTIVE_AUTH_FAILURES = 5;
const VISIBILITY_RECONNECT_DEBOUNCE_MS = 1_000;
const RELAY_REAUTH_RESULT_TIMEOUT_MS = 4_000;
const RELAY_REAUTH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
export const RELAY_READY_NEGOTIATION_WINDOW_MS = 750;
// Keep this as table-shaped names so the web adapter's existing invalidation
// scheduler maps one accepted hello to every UI domain it owns.
const FULL_INVALIDATION_TABLES = [
  "lanes",
  "sessions",
  "agent_chats",
  "pull_requests",
  "files",
  "github",
  "rebase",
] as const;

export type WebSocketLike = {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type SyncConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "restoring"
  | "reconnecting"
  | "disconnected"
  | "auth_failed"
  | "error";

export type SyncConnectionStatus = {
  state: SyncConnectionState;
  endpoint: string | null;
  envId: string | null;
  hostDeviceId: string | null;
  hostName: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  error: string | null;
};

export type SyncConnectionEvents = {
  statusChanged: SyncConnectionStatus;
  envelope: SyncEnvelope;
  helloOk: SyncHelloOkPayload;
  authFailed: { payload: SyncHelloErrorPayload; attributedToPairing: boolean };
  pairingRejected: { envId: string; hostDeviceId: string };
  tablesChanged: Set<string>;
  projectCatalog: SyncProjectCatalogPayload;
  brainStatus: SyncBrainStatusPayload;
  close: { code: number; reason: string };
  error: Error;
};

type PreparedPairedHelloAuth = Promise<{
  dpop: SyncDpopProof | null;
  relayAccountToken: string;
}>;

type RelayRefreshAttempt = {
  generation: number;
  requestId: string;
  payload: SyncRelayReauthorizePayload;
  responseTimer: ReturnType<typeof setTimeout> | null;
};

class StaleSocketAttemptError extends Error {
  constructor() {
    super("Sync connection attempt was superseded.");
    this.name = "StaleSocketAttemptError";
  }
}

class RelayReadyNegotiationTimeoutError extends Error {
  constructor() {
    super("The Relay did not confirm ready-v2 support in time.");
    this.name = "RelayReadyNegotiationTimeoutError";
  }
}

export type AccountPairAndConnectArgs = {
  endpoints: BrowserDialCandidate[];
  peer: SyncPeerMetadata;
  accountToken: string;
  relayAccountTokenProvider?: () => Promise<string>;
  createDpop: () => Promise<SyncDpopProof>;
  expectedHostDeviceId: string;
  existingPairing: { deviceId: string; secret: string } | null;
  buildEnvironment: (
    helloOk: SyncHelloOkPayload,
    endpoint: string,
    pairing: { deviceId: string; secret: string },
  ) => WebClientEnvironmentRecord;
};

type ListenerMap = {
  [K in keyof SyncConnectionEvents]: Set<(payload: SyncConnectionEvents[K]) => void>;
};

export class SyncConnectionError extends Error {
  constructor(message: string, readonly code: string, readonly payload?: SyncHelloErrorPayload) {
    super(message);
  }
}

function createDefaultSocket(url: string): WebSocketLike {
  return new WebSocket(url);
}

function visible(documentRef: Document | null): boolean {
  return !documentRef || documentRef.visibilityState !== "hidden";
}

function dataToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

function nowIso(): string {
  return new Date().toISOString();
}

function asMessageEvent(data: unknown): MessageEvent<string> {
  return { data: dataToText(data) } as MessageEvent<string>;
}

function withRelayReadyNegotiation(endpoint: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("ready", String(SYNC_RELAY_READY_VERSION));
  return url.toString();
}

function relayTransportFrame(data: unknown): SyncRelayClientAccepted | SyncRelayClientReady | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.v !== SYNC_RELAY_READY_VERSION) return null;
    if (parsed.t === "accepted") return { t: "accepted", v: SYNC_RELAY_READY_VERSION };
    if (parsed.t === "ready") return { t: "ready", v: SYNC_RELAY_READY_VERSION };
  } catch {
    // ADE envelopes and binary frames are handled by the normal decoder.
  }
  return null;
}

export class SyncConnection {
  private ws: WebSocketLike | null = null;
  private environment: WebClientEnvironmentRecord | null = null;
  private endpoints: BrowserDialCandidate[] = [];
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private inboundStaleTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private backoffMs = BACKOFF_MIN_MS;
  private backoffResetTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAttemptCancel: (() => void) | null = null;
  private consecutiveAuthFailures = 0;
  private lastDialStartedAtMs = 0;
  private intentionalClose = false;
  private latestHello: SyncHelloOkPayload | null = null;
  private relayAccountTokenProvider: (() => Promise<string>) | null = null;
  private connectionGeneration = 0;
  private operationGeneration = 0;
  private relayRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private relayRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private relayRefreshAttempt: RelayRefreshAttempt | null = null;
  private relayRefreshPreparation: Promise<void> | null = null;
  private relayRefreshRetryCount = 0;
  private relayAuthorizationTerminalError: string | null = null;
  private readonly listeners: ListenerMap = {
    statusChanged: new Set(),
    envelope: new Set(),
    helloOk: new Set(),
    authFailed: new Set(),
    pairingRejected: new Set(),
    tablesChanged: new Set(),
    projectCatalog: new Set(),
    brainStatus: new Set(),
    close: new Set(),
    error: new Set(),
  };
  private readonly catalogChunks = createProjectCatalogChunkAssembler();
  private status: SyncConnectionStatus = {
    state: "idle",
    endpoint: null,
    envId: null,
    hostDeviceId: null,
    hostName: null,
    connectedAt: null,
    lastSeenAt: null,
    error: null,
  };
  private readonly socketFactory: WebSocketFactory;
  private readonly transportOpenTimeoutMs: number;
  private readonly authenticatedHelloTimeoutMs: number;
  private readonly documentRef: Document | null;
  private readonly relayReauthorizationSigner: typeof signRelayReauthorizationProof;

  constructor(options: {
    socketFactory?: WebSocketFactory;
    transportOpenTimeoutMs?: number;
    authenticatedHelloTimeoutMs?: number;
    document?: Document | null;
    relayReauthorizationSigner?: typeof signRelayReauthorizationProof;
  } = {}) {
    this.socketFactory = options.socketFactory ?? createDefaultSocket;
    this.transportOpenTimeoutMs = Math.max(
      250,
      Math.floor(options.transportOpenTimeoutMs ?? DEFAULT_TRANSPORT_OPEN_TIMEOUT_MS),
    );
    this.authenticatedHelloTimeoutMs = Math.max(
      250,
      Math.floor(options.authenticatedHelloTimeoutMs ?? DEFAULT_AUTHENTICATED_HELLO_TIMEOUT_MS),
    );
    this.documentRef = options.document ?? (typeof document === "undefined" ? null : document);
    this.relayReauthorizationSigner = options.relayReauthorizationSigner
      ?? signRelayReauthorizationProof;
    this.documentRef?.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  on<K extends keyof SyncConnectionEvents>(event: K, listener: (payload: SyncConnectionEvents[K]) => void): () => void {
    this.listeners[event].add(listener as never);
    return () => this.listeners[event].delete(listener as never);
  }

  getStatus(): SyncConnectionStatus {
    return { ...this.status };
  }

  getHelloOk(): SyncHelloOkPayload | null {
    return this.latestHello;
  }

  isConnected(): boolean {
    return this.ws?.readyState === SOCKET_OPEN && this.status.state === "connected";
  }

  async connect(
    environment: WebClientEnvironmentRecord,
    endpoints: BrowserDialCandidate[],
    relayAccountTokenProvider?: () => Promise<string>,
  ): Promise<void> {
    this.disconnect({ reconnect: false, code: 1000, reason: "Reconnect" });
    this.relayAccountTokenProvider = relayAccountTokenProvider ?? null;
    this.environment = environment;
    this.endpoints = endpoints;
    this.shouldReconnect = true;
    this.consecutiveAuthFailures = 0;
    await this.connectWithCandidates(environment, endpoints);
  }

  async pairWithAccount(args: AccountPairAndConnectArgs): Promise<{ environment: WebClientEnvironmentRecord; helloOk: SyncHelloOkPayload; endpoint: string }> {
    this.disconnect({ reconnect: false, code: 1000, reason: "Account pairing" });
    const operationGeneration = this.operationGeneration;
    this.relayAccountTokenProvider = args.relayAccountTokenProvider ?? (() => Promise.resolve(args.accountToken));
    this.endpoints = args.endpoints;
    this.consecutiveAuthFailures = 0;
    const dialable = args.endpoints.filter((candidate) => candidate.dialable);
    if (dialable.length === 0) throw new Error("That machine has no secure account connection route.");
    let lastError: Error | null = null;
    for (const candidate of dialable) {
      try {
        const dpop = await args.createDpop();
        if (operationGeneration !== this.operationGeneration) throw new StaleSocketAttemptError();
        const result = await this.pairWithAccountOnEndpoint(candidate, args, dpop);
        if (operationGeneration !== this.operationGeneration) throw new StaleSocketAttemptError();
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          lastError instanceof StaleSocketAttemptError
          || operationGeneration !== this.operationGeneration
        ) throw new StaleSocketAttemptError();
        this.cleanupSocket();
      }
    }
    throw lastError ?? new Error("Failed to connect to the ADE account machine.");
  }

  send(input: EncodeEnvelopeInput): void {
    if (!this.ws || this.ws.readyState !== SOCKET_OPEN) {
      throw new Error("Sync socket is not connected.");
    }
    this.ws.send(encodeEnvelopeText(input));
  }

  disconnect(options: { reconnect?: boolean; code?: number; reason?: string } = {}): void {
    this.operationGeneration += 1;
    this.pendingAttemptCancel?.();
    this.pendingAttemptCancel = null;
    this.connectionGeneration += 1;
    this.shouldReconnect = options.reconnect ?? false;
    this.relayAccountTokenProvider = null;
    this.relayAuthorizationTerminalError = null;
    this.intentionalClose = true;
    this.stopTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(options.code ?? 1000, options.reason ?? "Client disconnect");
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.latestHello = null;
    this.setStatus({
      state: "disconnected",
      endpoint: null,
      connectedAt: null,
      error: null,
    });
    this.intentionalClose = false;
  }

  dispose(): void {
    this.disconnect({ reconnect: false, code: 1000, reason: "Disposed" });
    this.documentRef?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    for (const listeners of Object.values(this.listeners)) listeners.clear();
  }

  private async connectWithCandidates(environment: WebClientEnvironmentRecord, endpoints: BrowserDialCandidate[]): Promise<void> {
    this.lastDialStartedAtMs = Date.now();
    const dialable = endpoints.filter((candidate) => candidate.dialable);
    if (dialable.length === 0) throw new Error("No dialable sync endpoint is available.");
    this.setStatus({
      state: this.status.state === "connected" ? "reconnecting" : "connecting",
      envId: environment.envId,
      hostDeviceId: environment.hostDeviceId,
      hostName: environment.machineName,
      error: null,
    });
    let lastError: Error | null = null;
    for (const candidate of dialable) {
      try {
        await this.connectEndpoint(environment, candidate);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError instanceof StaleSocketAttemptError) throw lastError;
        this.cleanupSocket();
        if (
          error instanceof SyncConnectionError
          && (error.code === "attributed_auth_failed" || error.code === "terminal_auth_failed")
        ) {
          break;
        }
      }
    }
    const message = lastError?.message ?? "Failed to connect to ADE machine.";
    if (
      lastError instanceof SyncConnectionError
      && (lastError.code === "attributed_auth_failed" || lastError.code === "terminal_auth_failed")
    ) {
      this.emit("error", lastError);
      throw lastError;
    }
    this.setStatus({ state: "error", error: message, endpoint: null, connectedAt: null });
    this.emit("error", lastError ?? new Error(message));
    if (this.shouldReconnect) this.scheduleReconnect();
    throw lastError ?? new Error(message);
  }

  private async connectEndpoint(environment: WebClientEnvironmentRecord, candidate: BrowserDialCandidate): Promise<void> {
    const throughRelay = browserEndpointRequiresRelayAccess(candidate);
    try {
      await this.connectEndpointAttempt(environment, candidate, throughRelay);
    } catch (error) {
      if (!throughRelay || !(error instanceof RelayReadyNegotiationTimeoutError)) throw error;
      await this.connectEndpointAttempt(environment, candidate, false);
    }
  }

  private async connectEndpointAttempt(
    environment: WebClientEnvironmentRecord,
    candidate: BrowserDialCandidate,
    useRelayReadyV2: boolean,
  ): Promise<void> {
    const generation = ++this.connectionGeneration;
    const endpoint = candidate.url;
    const throughRelay = browserEndpointRequiresRelayAccess(candidate);
    const preparedAuth = this.preparePairedHelloAuth(
      environment,
      throughRelay,
    );
    // Authentication preparation starts with the dial. Observe an early
    // rejection until onopen awaits the same promise so it cannot be reported
    // as unhandled while the transport is still opening.
    void preparedAuth.catch(() => undefined);
    const socket = this.socketFactory(useRelayReadyV2 ? withRelayReadyNegotiation(endpoint) : endpoint);
    this.ws = socket;
    this.status.endpoint = endpoint;
    this.emit("statusChanged", this.getStatus());
    if (!this.isCurrentSocket(socket, generation)) throw new StaleSocketAttemptError();
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      let helloTimeout: ReturnType<typeof setTimeout> | null = null;
      let relayNegotiationTimeout: ReturnType<typeof setTimeout> | null = null;
      let helloStarted = false;
      let relayAccepted = false;
      let cancelAttempt: () => void = () => {};
      const clearDeadlines = () => {
        clearTimeout(openTimeout);
        if (helloTimeout) clearTimeout(helloTimeout);
        if (relayNegotiationTimeout) clearTimeout(relayNegotiationTimeout);
      };
      const startHello = () => {
        if (settled || helloStarted || !this.isCurrentSocket(socket, generation)) return;
        helloStarted = true;
        if (relayNegotiationTimeout) clearTimeout(relayNegotiationTimeout);
        relayNegotiationTimeout = null;
        void this.sendHello(socket, generation, environment, preparedAuth).catch((error) => {
          if (!this.isCurrentSocket(socket, generation)) return;
          fail(error instanceof Error ? error : new Error(String(error)), "Hello preparation failed");
        });
      };
      const fail = (error: Error, closeReason?: string) => {
        if (settled) return;
        settled = true;
        clearDeadlines();
        if (this.pendingAttemptCancel === cancelAttempt) this.pendingAttemptCancel = null;
        if (closeReason) {
          socket.onclose = null;
          try {
            socket.close(4000, closeReason);
          } catch {
            // Ignore close failures while abandoning this candidate.
          }
        }
        reject(error);
      };
      cancelAttempt = () => fail(new StaleSocketAttemptError(), "Connection attempt superseded");
      this.pendingAttemptCancel = cancelAttempt;
      const openTimeout = setTimeout(() => {
        fail(new Error(`Timed out opening ${endpoint}.`), "Transport open timeout");
      }, this.transportOpenTimeoutMs);

      socket.onopen = () => {
        if (settled || !this.isCurrentSocket(socket, generation)) return;
        clearTimeout(openTimeout);
        helloTimeout = setTimeout(() => {
          fail(new Error(`Timed out authenticating with ${endpoint}.`), "Authenticated hello timeout");
        }, this.authenticatedHelloTimeoutMs);
        if (!useRelayReadyV2) {
          startHello();
          return;
        }
        relayNegotiationTimeout = setTimeout(() => {
          relayNegotiationTimeout = null;
          // Never send ADE data on a socket that requested ready-v2: a delayed
          // accepted frame would make the Worker reject that data as pre-ready.
          // Retry the same route on a fresh, explicitly legacy socket instead.
          fail(new RelayReadyNegotiationTimeoutError(), "Relay readiness negotiation timeout");
        }, RELAY_READY_NEGOTIATION_WINDOW_MS);
      };
      socket.onmessage = (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        const transport = throughRelay ? relayTransportFrame(event.data) : null;
        if (transport) {
          if (relayNegotiationTimeout) clearTimeout(relayNegotiationTimeout);
          relayNegotiationTimeout = null;
          if (transport.t === "accepted") {
            relayAccepted = true;
          } else if (relayAccepted) {
            startHello();
          }
          // accepted means this Worker enforces readiness. Keep waiting for
          // final ready within the existing overall authenticated-hello budget.
          return;
        }
        void this.handleMessage(asMessageEvent(event.data), socket, generation, {
          onHelloOk: (payload) => {
            if (settled || !this.isCurrentSocket(socket, generation)) return;
            if (payload.brain?.deviceId?.trim() !== environment.hostDeviceId) {
              fail(new Error("Connected machine identity did not match the stored pairing."));
              return;
            }
            if (!this.finishConnected(socket, environment, endpoint, payload, generation)) {
              fail(new StaleSocketAttemptError(), "Connection attempt superseded");
              return;
            }
            settled = true;
            clearDeadlines();
            if (this.pendingAttemptCancel === cancelAttempt) this.pendingAttemptCancel = null;
            resolve();
          },
          onHelloError: (payload) => {
            if (settled || !this.isCurrentSocket(socket, generation)) return;
            const error = this.handleAuthFailure(environment, payload);
            fail(error);
            if (error.code === "attributed_auth_failed") {
              this.emit("pairingRejected", {
                envId: environment.envId,
                hostDeviceId: environment.hostDeviceId,
              });
            }
          },
        }).catch((error) => {
          if (!this.isCurrentSocket(socket, generation)) return;
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      };
      socket.onerror = () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        fail(new Error(`WebSocket failed for ${endpoint}.`));
      };
      socket.onclose = (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        if (!settled) {
          fail(this.errorForClose(event));
          return;
        }
        this.handleClose(event, false, socket, generation);
      };
    });
  }

  private async pairWithAccountOnEndpoint(
    candidate: BrowserDialCandidate,
    args: AccountPairAndConnectArgs,
    dpop: SyncDpopProof,
  ): Promise<{ environment: WebClientEnvironmentRecord; helloOk: SyncHelloOkPayload; endpoint: string }> {
    const throughRelay = browserEndpointRequiresRelayAccess(candidate);
    try {
      return await this.pairWithAccountOnEndpointAttempt(candidate, args, dpop, throughRelay);
    } catch (error) {
      if (!throughRelay || !(error instanceof RelayReadyNegotiationTimeoutError)) throw error;
      return this.pairWithAccountOnEndpointAttempt(candidate, args, dpop, false);
    }
  }

  private async pairWithAccountOnEndpointAttempt(
    candidate: BrowserDialCandidate,
    args: AccountPairAndConnectArgs,
    dpop: SyncDpopProof,
    useRelayReadyV2: boolean,
  ): Promise<{ environment: WebClientEnvironmentRecord; helloOk: SyncHelloOkPayload; endpoint: string }> {
    const generation = ++this.connectionGeneration;
    const endpoint = candidate.url;
    const throughRelay = browserEndpointRequiresRelayAccess(candidate);
    const socket = this.socketFactory(useRelayReadyV2 ? withRelayReadyNegotiation(endpoint) : endpoint);
    this.ws = socket;
    this.shouldReconnect = false;
    this.setStatus({ state: "connecting", endpoint, error: null });
    if (!this.isCurrentSocket(socket, generation)) throw new StaleSocketAttemptError();
    let settled = false;
    return await new Promise((resolve, reject) => {
      let helloTimeout: ReturnType<typeof setTimeout> | null = null;
      let relayNegotiationTimeout: ReturnType<typeof setTimeout> | null = null;
      let helloStarted = false;
      let relayAccepted = false;
      let cancelAttempt: () => void = () => {};
      const clearDeadlines = () => {
        clearTimeout(openTimeout);
        if (helloTimeout) clearTimeout(helloTimeout);
        if (relayNegotiationTimeout) clearTimeout(relayNegotiationTimeout);
      };
      const startHello = () => {
        if (settled || helloStarted || !this.isCurrentSocket(socket, generation)) return;
        helloStarted = true;
        if (relayNegotiationTimeout) clearTimeout(relayNegotiationTimeout);
        relayNegotiationTimeout = null;
        const payload: SyncHelloPayload = {
          peer: {
            ...args.peer,
            capabilities: [
              ...(args.peer.capabilities ?? []).filter(
                (capability) => (
                  capability !== SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY
                  && capability !== SYNC_INVALIDATION_ONLY_V1_CAPABILITY
                ),
              ),
              SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY,
              SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
            ],
          },
          auth: {
            kind: "account",
            deviceId: args.peer.deviceId,
            accountToken: args.accountToken,
            dpop,
          },
        };
        socket.send(encodeEnvelopeText({ type: "hello", requestId: "account-hello", payload }));
      };
      const fail = (error: Error, closeReason?: string) => {
        if (settled) return;
        settled = true;
        clearDeadlines();
        if (this.pendingAttemptCancel === cancelAttempt) this.pendingAttemptCancel = null;
        if (closeReason) {
          socket.onclose = null;
          try {
            socket.close(4000, closeReason);
          } catch {
            // Ignore close failures after a deadline.
          }
        }
        reject(error);
      };
      cancelAttempt = () => fail(new StaleSocketAttemptError(), "Connection attempt superseded");
      this.pendingAttemptCancel = cancelAttempt;
      const openTimeout = setTimeout(() => {
        fail(new Error("Timed out opening the account machine connection."), "Account transport open timeout");
      }, this.transportOpenTimeoutMs);

      socket.onopen = () => {
        if (settled || !this.isCurrentSocket(socket, generation)) return;
        clearTimeout(openTimeout);
        helloTimeout = setTimeout(() => {
          fail(new Error("Timed out authenticating with the account machine."), "Account hello timeout");
        }, this.authenticatedHelloTimeoutMs);
        if (!useRelayReadyV2) {
          startHello();
          return;
        }
        relayNegotiationTimeout = setTimeout(() => {
          relayNegotiationTimeout = null;
          fail(new RelayReadyNegotiationTimeoutError(), "Relay readiness negotiation timeout");
        }, RELAY_READY_NEGOTIATION_WINDOW_MS);
      };
      socket.onmessage = (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        const transport = throughRelay ? relayTransportFrame(event.data) : null;
        if (transport) {
          if (relayNegotiationTimeout) clearTimeout(relayNegotiationTimeout);
          relayNegotiationTimeout = null;
          if (transport.t === "accepted") {
            relayAccepted = true;
          } else if (relayAccepted) {
            startHello();
          }
          return;
        }
        void this.handleMessage(asMessageEvent(event.data), socket, generation, {
          onHelloOk: (payload) => {
            if (settled || !this.isCurrentSocket(socket, generation)) return;
            const hostDeviceId = payload.brain?.deviceId?.trim();
            const pairing = resolveAccountHelloPairing({
              accountPairing: payload.accountPairing,
              existingPairing: args.existingPairing,
              expectedDeviceId: args.peer.deviceId,
            });
            if (
              hostDeviceId !== args.expectedHostDeviceId
              || !pairing
            ) {
              fail(new Error("Account machine identity did not match the verified directory record."));
              return;
            }
            let environment: WebClientEnvironmentRecord;
            try {
              environment = args.buildEnvironment(payload, endpoint, pairing);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            if (!this.finishConnected(socket, environment, endpoint, payload, generation)) {
              fail(new StaleSocketAttemptError(), "Connection attempt superseded");
              return;
            }
            settled = true;
            clearDeadlines();
            if (this.pendingAttemptCancel === cancelAttempt) this.pendingAttemptCancel = null;
            this.shouldReconnect = true;
            resolve({ environment, helloOk: payload, endpoint });
          },
          onHelloError: (payload) => {
            if (settled || !this.isCurrentSocket(socket, generation)) return;
            fail(new Error(payload.message || "Account authentication was rejected."));
          },
        }).catch((error) => {
          if (!this.isCurrentSocket(socket, generation)) return;
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      };
      socket.onerror = () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        fail(new Error("The secure machine connection failed."));
      };
      socket.onclose = (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        if (!settled) {
          fail(this.errorForClose(event));
          return;
        }
        this.handleClose(event, false, socket, generation);
      };
    });
  }

  private preparePairedHelloAuth(
    environment: WebClientEnvironmentRecord,
    throughRelay: boolean,
  ): PreparedPairedHelloAuth {
    const dpop = environment.dpopPublicKeyX963
      ? signDpopProof({
          privateKey: environment.dpopKeys.privateKey,
          publicKeyX963Base64: environment.dpopPublicKeyX963,
          deviceId: environment.pairedDeviceId,
          secret: environment.secret,
        })
      : Promise.resolve(null);
    const relayAccountToken = this.getRelayAccountToken(throughRelay);
    return Promise.all([dpop, relayAccountToken]).then(([preparedDpop, preparedRelayAccountToken]) => ({
      dpop: preparedDpop,
      relayAccountToken: preparedRelayAccountToken,
    }));
  }

  private async sendHello(
    socket: WebSocketLike,
    generation: number,
    environment: WebClientEnvironmentRecord,
    preparedAuth: PreparedPairedHelloAuth,
  ): Promise<void> {
    const { dpop, relayAccountToken } = await preparedAuth;
    if (!this.isCurrentSocket(socket, generation) || socket.readyState !== SOCKET_OPEN) return;
    const payload: SyncHelloPayload = {
      peer: {
        deviceId: environment.localDeviceId,
        deviceName: environment.localDeviceName,
        platform: platformFromNavigator(),
        deviceType: "browser" as SyncPeerMetadata["deviceType"],
        siteId: environment.siteId,
        dbVersion: 0,
        capabilities: [
          SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY,
          SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
        ],
      },
      auth: {
        kind: "paired",
        deviceId: environment.pairedDeviceId,
        secret: environment.secret,
        ...(dpop ? { dpop } : {}),
        ...(relayAccountToken ? { relayAccountToken } : {}),
      },
    };
    socket.send(encodeEnvelopeText({ type: "hello", requestId: "hello", payload }));
  }

  private async getRelayAccountToken(throughRelay: boolean): Promise<string> {
    if (!throughRelay) return "";
    const token = await this.relayAccountTokenProvider?.() ?? "";
    if (!token.trim()) throw new Error("Sign in again to connect through ADE Relay.");
    return token;
  }

  private async handleMessage(
    event: MessageEvent<string>,
    socket: WebSocketLike,
    generation: number,
    callbacks: {
      onHelloOk?: (payload: SyncHelloOkPayload) => void;
      onHelloError?: (payload: SyncHelloErrorPayload) => void;
    } = {},
  ): Promise<void> {
    const envelope = await decodeEnvelopeText(event.data);
    if (!this.isCurrentSocket(socket, generation)) return;
    this.setStatus({ lastSeenAt: nowIso() });
    if (envelope.type === "hello_ok") {
      callbacks.onHelloOk?.(envelope.payload as SyncHelloOkPayload);
    } else if (envelope.type === "hello_error") {
      callbacks.onHelloError?.(envelope.payload as SyncHelloErrorPayload);
    }
    if (!this.isCurrentSocket(socket, generation)) return;
    this.routeEnvelope(envelope, socket, generation);
    if (!this.isCurrentSocket(socket, generation)) return;
    if (this.isConnected()) {
      this.scheduleHeartbeatFallback();
    }
  }

  private routeEnvelope(envelope: SyncEnvelope, socket: WebSocketLike, generation: number): void {
    this.emit("envelope", envelope);
    if (!this.isCurrentSocket(socket, generation)) return;
    switch (envelope.type) {
      case "heartbeat": {
        const payload = envelope.payload as SyncHeartbeatPayload;
        if (payload.kind === "ping") {
          if (!this.isCurrentSocket(socket, generation)) return;
          this.send({
            type: "heartbeat",
            requestId: envelope.requestId ?? null,
            payload: {
              kind: "pong",
              sentAt: payload.sentAt ?? nowIso(),
              dbVersion: 0,
            } satisfies SyncHeartbeatPayload,
          });
        }
        break;
      }
      case "changeset_batch": {
        const payload = envelope.payload as SyncChangesetBatchPayload;
        const tables = new Set(payload.changes.map((change) => change.table).filter(Boolean));
        if (tables.size > 0) this.emit("tablesChanged", tables);
        break;
      }
      case "brain_status":
        this.emit("brainStatus", envelope.payload as SyncBrainStatusPayload);
        break;
      case "project_catalog":
        this.emit("projectCatalog", envelope.payload as SyncProjectCatalogPayload);
        break;
      case "project_catalog_chunk": {
        const catalog = this.catalogChunks.add(envelope.payload as SyncProjectCatalogChunkPayload);
        if (catalog) this.emit("projectCatalog", catalog);
        break;
      }
      case "relay_reauthorize_result":
        this.handleRelayReauthorizeResult(
          envelope.payload as SyncRelayReauthorizeResultPayload,
          envelope.requestId ?? null,
        );
        break;
      default:
        break;
    }
  }

  private finishConnected(
    socket: WebSocketLike,
    environment: WebClientEnvironmentRecord,
    endpoint: string,
    helloOk: SyncHelloOkPayload,
    generation: number,
  ): boolean {
    if (!this.isCurrentSocket(socket, generation)) return false;
    this.environment = environment;
    this.endpoints = [
      ...this.endpoints.filter((candidate) => candidate.url === endpoint),
      ...this.endpoints.filter((candidate) => candidate.url !== endpoint),
    ];
    this.latestHello = helloOk;
    this.consecutiveAuthFailures = 0;
    this.relayAuthorizationTerminalError = null;
    this.setStatus({
      state: "connected",
      endpoint,
      envId: environment.envId,
      hostDeviceId: environment.hostDeviceId,
      hostName: environment.machineName,
      connectedAt: nowIso(),
      error: null,
    });
    if (!this.isCurrentSocket(socket, generation)) return false;
    this.startHeartbeat(helloOk.heartbeatIntervalMs);
    this.startInboundStaleWatchdog();
    this.scheduleStableBackoffReset(generation);
    this.scheduleRelayAuthorizationRefresh(generation, helloOk.relayAuthorization ?? null, true);
    this.emit("helloOk", helloOk);
    if (!this.isCurrentSocket(socket, generation)) return false;
    this.emit("tablesChanged", new Set(FULL_INVALIDATION_TABLES));
    if (!this.isCurrentSocket(socket, generation)) return false;
    if (helloOk.projects) {
      this.emit("projectCatalog", { projects: helloOk.projects });
      if (!this.isCurrentSocket(socket, generation)) return false;
    }
    return true;
  }

  private scheduleRelayAuthorizationRefresh(
    generation: number,
    lease: SyncRelayAuthorizationLease | null,
    resetRetries: boolean,
  ): void {
    if (this.relayRefreshTimer) clearTimeout(this.relayRefreshTimer);
    this.relayRefreshTimer = null;
    if (resetRetries) this.relayRefreshRetryCount = 0;
    if (!lease || generation !== this.connectionGeneration) return;
    const delayMs = Math.max(0, lease.refreshAfter - Date.now());
    this.relayRefreshTimer = setTimeout(() => {
      this.relayRefreshTimer = null;
      if (!visible(this.documentRef)) return;
      this.beginRelayAuthorizationRefresh(generation);
    }, delayMs);
  }

  private beginRelayAuthorizationRefresh(generation: number): void {
    if (
      generation !== this.connectionGeneration
      || !this.isConnected()
      || this.relayRefreshAttempt
      || this.relayRefreshPreparation
    ) {
      return;
    }
    const environment = this.environment;
    const lease = this.latestHello?.relayAuthorization ?? null;
    const provider = this.relayAccountTokenProvider;
    if (!environment || !lease || !provider) return;

    const preparation = (async () => {
      try {
        const relayAccountToken = await provider();
        if (!relayAccountToken.trim()) throw new Error("Sign in again to continue through ADE Relay.");
        const proof = await this.relayReauthorizationSigner({
          privateKey: environment.dpopKeys.privateKey,
          deviceId: environment.pairedDeviceId,
          relayAccountToken,
          challenge: lease.challenge,
        });
        if (generation !== this.connectionGeneration || !this.isConnected()) return;
        const attempt: RelayRefreshAttempt = {
          generation,
          requestId: `relay-reauth-${generation}-${randomHex(8)}`,
          payload: {
            deviceId: environment.pairedDeviceId,
            relayAccountToken,
            proof,
          },
          responseTimer: null,
        };
        this.relayRefreshAttempt = attempt;
        this.sendRelayAuthorizationAttempt(attempt);
      } catch {
        this.scheduleRelayAuthorizationRetry(generation, false);
      }
    })();
    this.relayRefreshPreparation = preparation;
    void preparation.finally(() => {
      if (this.relayRefreshPreparation === preparation) this.relayRefreshPreparation = null;
    });
  }

  private sendRelayAuthorizationAttempt(attempt: RelayRefreshAttempt): void {
    if (
      this.relayRefreshAttempt !== attempt
      || attempt.generation !== this.connectionGeneration
      || !this.isConnected()
    ) {
      return;
    }
    if (attempt.responseTimer) clearTimeout(attempt.responseTimer);
    try {
      this.send({
        type: "relay_reauthorize",
        requestId: attempt.requestId,
        payload: attempt.payload,
      });
    } catch {
      this.scheduleRelayAuthorizationRetry(attempt.generation, true);
      return;
    }
    attempt.responseTimer = setTimeout(() => {
      attempt.responseTimer = null;
      if (this.relayRefreshAttempt !== attempt) return;
      this.scheduleRelayAuthorizationRetry(attempt.generation, true);
    }, RELAY_REAUTH_RESULT_TIMEOUT_MS);
  }

  private scheduleRelayAuthorizationRetry(generation: number, reuseAttempt: boolean): void {
    if (generation !== this.connectionGeneration || this.relayRefreshRetryTimer) return;
    const lease = this.latestHello?.relayAuthorization ?? null;
    const delayMs = RELAY_REAUTH_RETRY_DELAYS_MS[
      Math.min(this.relayRefreshRetryCount, RELAY_REAUTH_RETRY_DELAYS_MS.length - 1)
    ];
    if (!lease || Date.now() + delayMs > lease.expiresAt + lease.graceMs) return;
    this.relayRefreshRetryCount += 1;
    const attempt = reuseAttempt ? this.relayRefreshAttempt : null;
    if (attempt?.responseTimer) {
      clearTimeout(attempt.responseTimer);
      attempt.responseTimer = null;
    }
    if (!reuseAttempt) this.relayRefreshAttempt = null;
    this.relayRefreshRetryTimer = setTimeout(() => {
      this.relayRefreshRetryTimer = null;
      if (generation !== this.connectionGeneration || !this.isConnected()) return;
      if (attempt && this.relayRefreshAttempt === attempt) {
        this.sendRelayAuthorizationAttempt(attempt);
        return;
      }
      this.beginRelayAuthorizationRefresh(generation);
    }, delayMs);
  }

  private handleRelayReauthorizeResult(
    payload: SyncRelayReauthorizeResultPayload,
    requestId: string | null,
  ): void {
    const attempt = this.relayRefreshAttempt;
    if (!attempt || requestId !== attempt.requestId || attempt.generation !== this.connectionGeneration) return;
    if (attempt.responseTimer) clearTimeout(attempt.responseTimer);
    attempt.responseTimer = null;
    if (this.relayRefreshRetryTimer) clearTimeout(this.relayRefreshRetryTimer);
    this.relayRefreshRetryTimer = null;

    if (payload.ok) {
      this.relayRefreshAttempt = null;
      this.relayRefreshRetryCount = 0;
      if (this.latestHello) {
        this.latestHello = {
          ...this.latestHello,
          relayAuthorization: payload.relayAuthorization,
        };
      }
      this.scheduleRelayAuthorizationRefresh(
        attempt.generation,
        payload.relayAuthorization,
        true,
      );
      return;
    }

    if (payload.error.code === "relay_account_changed") {
      const socket = this.ws;
      this.relayRefreshAttempt = null;
      this.shouldReconnect = false;
      this.relayAuthorizationTerminalError = payload.error.message;
      this.setStatus({ state: "auth_failed", error: payload.error.message });
      try {
        socket?.close(4003, "ADE account session changed");
      } catch {
        // The terminal state is already recorded even if close throws.
      }
      return;
    }
    if (!payload.error.retryable) {
      this.relayRefreshAttempt = null;
      return;
    }
    const requiresFreshToken = payload.error.code === "token_not_advanced"
      || payload.error.code === "token_too_short"
      || payload.error.code === "token_expired";
    this.scheduleRelayAuthorizationRetry(attempt.generation, !requiresFreshToken);
  }

  private handleAuthFailure(environment: WebClientEnvironmentRecord, payload: SyncHelloErrorPayload): SyncConnectionError {
    if (payload.code === "relay_account_required") {
      this.shouldReconnect = false;
      this.setStatus({ state: "error", error: payload.message });
      return new SyncConnectionError(payload.message, "relay_account_required", payload);
    }
    const attributedToPairing = payload.host?.deviceId === environment.hostDeviceId;
    this.consecutiveAuthFailures += 1;
    this.emit("authFailed", { payload, attributedToPairing });
    if (attributedToPairing) {
      this.shouldReconnect = false;
      this.setStatus({ state: "auth_failed", error: payload.message });
      return new SyncConnectionError(payload.message, "attributed_auth_failed", payload);
    }
    if (this.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
      this.shouldReconnect = false;
      this.setStatus({
        state: "auth_failed",
        error: "Pairing invalid. Pair this browser with your ADE machine again.",
      });
      return new SyncConnectionError(payload.message, "terminal_auth_failed", payload);
    }
    this.setStatus({ state: "error", error: payload.message });
    return new SyncConnectionError(payload.message, "auth_failed", payload);
  }

  private startHeartbeat(intervalMs: number | undefined): void {
    this.heartbeatIntervalMs = Math.max(
      5_000,
      Math.floor(intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
    );
    this.scheduleHeartbeatFallback();
  }

  private scheduleHeartbeatFallback(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (!this.isConnected()) return;
      this.send({
        type: "heartbeat",
        payload: {
          kind: "ping",
          sentAt: nowIso(),
          dbVersion: 0,
        } satisfies SyncHeartbeatPayload,
      });
      this.scheduleHeartbeatFallback();
    }, this.heartbeatIntervalMs * 2);
  }

  private startInboundStaleWatchdog(): void {
    if (this.inboundStaleTimer) clearInterval(this.inboundStaleTimer);
    this.inboundStaleTimer = setInterval(() => {
      this.closeIfInboundStale(false);
    }, INBOUND_STALE_CHECK_INTERVAL_MS);
  }

  private closeIfInboundStale(bypassBackoff: boolean): boolean {
    if (!this.isConnected() || !visible(this.documentRef)) return false;
    const lastSeenAtMs = this.status.lastSeenAt ? Date.parse(this.status.lastSeenAt) : Number.NaN;
    if (!Number.isFinite(lastSeenAtMs) || Date.now() - lastSeenAtMs < INBOUND_STALE_MS) return false;
    const socket = this.ws;
    if (!socket) return false;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(4008, "Inbound connection stale");
    } catch {
      // The local close is still authoritative for reconnect bookkeeping.
    }
    this.handleClose(
      { code: 4008, reason: "Inbound connection stale" } as CloseEvent,
      bypassBackoff,
      socket,
      this.connectionGeneration,
    );
    return true;
  }

  private errorForClose(event: Pick<CloseEvent, "code" | "reason">): SyncConnectionError {
    switch (event.code) {
      case 4501:
        return new SyncConnectionError("Can't reach this Mac. Retrying…", "relay_host_offline");
      case 4507:
        return new SyncConnectionError("Your Mac couldn't accept the connection. Retrying…", "relay_bridge_rejected");
      case 4508:
        return new SyncConnectionError("Connection setup expired. Reconnecting.", "relay_stale_pipe");
      case 4509:
        return new SyncConnectionError("Connection forwarding failed. Reconnecting.", "relay_forward_failed");
      case 4510:
        return new SyncConnectionError("Connection was not ready. Reconnecting.", "relay_not_ready");
      case 4503:
        return new SyncConnectionError("Too many active connections to this Mac", "relay_capacity");
      case 4502:
        return new SyncConnectionError("Connection lost. Reconnecting.", "relay_idle");
      case 4505:
        return new SyncConnectionError("Connection lost. Reconnecting.", "relay_superseded");
      case 4506:
        return new SyncConnectionError("Connection lost. Reconnecting.", "relay_buffer_overflow");
      case 4000:
        return new SyncConnectionError("Connection lost. Reconnecting.", "relay_partner_closed");
      case 4008:
        return new SyncConnectionError("Connection became unresponsive. Reconnecting.", "connection_stale");
      default:
        return new SyncConnectionError(event.reason || "Connection lost. Reconnecting.", "connection_closed");
    }
  }

  private handleClose(
    event: CloseEvent,
    bypassBackoff = false,
    socket: WebSocketLike | null = this.ws,
    generation = this.connectionGeneration,
  ): void {
    if (!socket || !this.isCurrentSocket(socket, generation)) return;
    const terminalError = this.relayAuthorizationTerminalError;
    const closeGeneration = ++this.connectionGeneration;
    this.stopTimers();
    this.ws = null;
    this.latestHello = null;
    this.emit("close", { code: event.code, reason: event.reason });
    if (this.connectionGeneration !== closeGeneration || this.ws !== null) return;
    if (this.intentionalClose) return;
    this.setStatus({
      state: terminalError ? "auth_failed" : "disconnected",
      connectedAt: null,
      error: terminalError ?? this.errorForClose(event).message,
    });
    if (this.connectionGeneration !== closeGeneration || this.ws !== null) return;
    if (this.shouldReconnect) {
      this.scheduleReconnect(
        bypassBackoff ? this.visibilityReconnectDelayMs() : 0,
        bypassBackoff,
      );
    }
  }

  private scheduleReconnect(minimumDelayMs = 0, bypassBackoff = false): void {
    if (!this.environment || !visible(this.documentRef) || this.reconnectTimer) return;
    const generation = this.connectionGeneration;
    const socket = this.ws;
    const jitter = Math.floor(Math.random() * 350);
    const delay = bypassBackoff
      ? minimumDelayMs
      : Math.max(minimumDelayMs, Math.min(BACKOFF_MAX_MS, this.backoffMs) + jitter);
    if (!bypassBackoff) this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    this.setStatus({ state: "reconnecting" });
    if (this.connectionGeneration !== generation || this.ws !== socket) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.environment || !this.shouldReconnect || !visible(this.documentRef)) return;
      void this.connectWithCandidates(this.environment, this.endpoints).catch(() => {
        if (this.shouldReconnect) this.scheduleReconnect();
      });
    }, delay);
  }

  private scheduleStableBackoffReset(generation: number): void {
    if (this.backoffResetTimer) clearTimeout(this.backoffResetTimer);
    this.backoffResetTimer = setTimeout(() => {
      this.backoffResetTimer = null;
      if (generation !== this.connectionGeneration || !this.isConnected()) return;
      this.backoffMs = BACKOFF_MIN_MS;
    }, BACKOFF_STABLE_CONNECTED_MS);
  }

  private visibilityReconnectDelayMs(): number {
    const elapsedSinceDialMs = Date.now() - this.lastDialStartedAtMs;
    return elapsedSinceDialMs < VISIBILITY_RECONNECT_DEBOUNCE_MS
      ? VISIBILITY_RECONNECT_DEBOUNCE_MS - elapsedSinceDialMs
      : 0;
  }

  private isCurrentSocket(socket: WebSocketLike, generation: number): boolean {
    return this.ws === socket && this.connectionGeneration === generation;
  }

  private readonly handleVisibilityChange = () => {
    if (!visible(this.documentRef)) return;
    if (this.isConnected()) {
      if (this.closeIfInboundStale(true)) return;
      const lease = this.latestHello?.relayAuthorization ?? null;
      if (lease && Date.now() >= lease.refreshAfter) {
        this.beginRelayAuthorizationRefresh(this.connectionGeneration);
      }
      return;
    }
    if (!this.environment || !this.shouldReconnect) return;
    if (this.reconnectTimer || this.status.state === "connecting" || this.status.state === "reconnecting") return;
    this.scheduleReconnect(this.visibilityReconnectDelayMs());
  };

  private cleanupSocket(): void {
    this.connectionGeneration += 1;
    this.stopTimers();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close(1000, "Next candidate");
      } catch {
        // ignore
      }
    }
    this.ws = null;
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.inboundStaleTimer) {
      clearInterval(this.inboundStaleTimer);
      this.inboundStaleTimer = null;
    }
    if (this.backoffResetTimer) {
      clearTimeout(this.backoffResetTimer);
      this.backoffResetTimer = null;
    }
    if (this.relayRefreshTimer) {
      clearTimeout(this.relayRefreshTimer);
      this.relayRefreshTimer = null;
    }
    if (this.relayRefreshRetryTimer) {
      clearTimeout(this.relayRefreshRetryTimer);
      this.relayRefreshRetryTimer = null;
    }
    if (this.relayRefreshAttempt?.responseTimer) {
      clearTimeout(this.relayRefreshAttempt.responseTimer);
    }
    this.relayRefreshAttempt = null;
    this.relayRefreshPreparation = null;
    this.relayRefreshRetryCount = 0;
  }

  private setStatus(patch: Partial<SyncConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("statusChanged", this.getStatus());
  }

  private emit<K extends keyof SyncConnectionEvents>(event: K, payload: SyncConnectionEvents[K]): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }
}

export function platformFromNavigator(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): SyncPeerMetadata["platform"] {
  const value = userAgent.toLowerCase();
  if (value.includes("mac os") || value.includes("macintosh")) return "macOS";
  if (value.includes("windows")) return "windows";
  if (value.includes("linux")) return "linux";
  return "unknown";
}
