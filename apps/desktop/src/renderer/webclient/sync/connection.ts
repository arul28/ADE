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
} from "../../../shared/types/sync";
import { resolveAccountHelloPairing } from "../../../shared/accountDirectory";
import {
  browserEndpointRequiresRelayAccess,
  type BrowserDialCandidate,
} from "./endpoints";
import type { WebClientEnvironmentRecord } from "./envStore";
import { signDpopProof } from "./dpop";
import {
  createProjectCatalogChunkAssembler,
  decodeEnvelopeText,
  encodeEnvelopeText,
  type EncodeEnvelopeInput,
} from "./wireProtocol";

const SOCKET_OPEN = 1;
const DEFAULT_TRANSPORT_OPEN_TIMEOUT_MS = 8_000;
const DEFAULT_AUTHENTICATED_HELLO_TIMEOUT_MS = 12_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const INBOUND_STALE_MS = 75_000;
const INBOUND_STALE_CHECK_INTERVAL_MS = 15_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_CONSECUTIVE_AUTH_FAILURES = 5;
const VISIBILITY_RECONNECT_DEBOUNCE_MS = 1_000;

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

export class SyncConnection {
  private ws: WebSocketLike | null = null;
  private environment: WebClientEnvironmentRecord | null = null;
  private endpoints: BrowserDialCandidate[] = [];
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inboundStaleTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private consecutiveAuthFailures = 0;
  private lastDialStartedAtMs = 0;
  private intentionalClose = false;
  private latestHello: SyncHelloOkPayload | null = null;
  private relayAccountTokenProvider: (() => Promise<string>) | null = null;
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

  constructor(options: {
    socketFactory?: WebSocketFactory;
    transportOpenTimeoutMs?: number;
    authenticatedHelloTimeoutMs?: number;
    document?: Document | null;
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
    this.relayAccountTokenProvider = args.relayAccountTokenProvider ?? (() => Promise.resolve(args.accountToken));
    this.endpoints = args.endpoints;
    this.consecutiveAuthFailures = 0;
    const dialable = args.endpoints.filter((candidate) => candidate.dialable);
    if (dialable.length === 0) throw new Error("That machine has no secure account connection route.");
    let lastError: Error | null = null;
    for (const candidate of dialable) {
      try {
        const dpop = await args.createDpop();
        return await this.pairWithAccountOnEndpoint(candidate.url, args, dpop);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
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
    this.shouldReconnect = options.reconnect ?? false;
    this.relayAccountTokenProvider = null;
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
    const endpoint = candidate.url;
    const preparedAuth = this.preparePairedHelloAuth(
      environment,
      browserEndpointRequiresRelayAccess(candidate),
    );
    // Authentication preparation starts with the dial. Observe an early
    // rejection until onopen awaits the same promise so it cannot be reported
    // as unhandled while the transport is still opening.
    void preparedAuth.catch(() => undefined);
    const socket = this.socketFactory(endpoint);
    this.ws = socket;
    this.status.endpoint = endpoint;
    this.emit("statusChanged", this.getStatus());
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      let helloTimeout: ReturnType<typeof setTimeout> | null = null;
      const clearDeadlines = () => {
        clearTimeout(openTimeout);
        if (helloTimeout) clearTimeout(helloTimeout);
      };
      const fail = (error: Error, closeReason?: string) => {
        if (settled) return;
        settled = true;
        clearDeadlines();
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
      const openTimeout = setTimeout(() => {
        fail(new Error(`Timed out opening ${endpoint}.`), "Transport open timeout");
      }, this.transportOpenTimeoutMs);

      socket.onopen = () => {
        if (settled) return;
        clearTimeout(openTimeout);
        helloTimeout = setTimeout(() => {
          fail(new Error(`Timed out authenticating with ${endpoint}.`), "Authenticated hello timeout");
        }, this.authenticatedHelloTimeoutMs);
        void this.sendHello(socket, environment, preparedAuth).catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)), "Hello preparation failed");
        });
      };
      socket.onmessage = (event) => {
        void this.handleMessage(asMessageEvent(event.data), {
          onHelloOk: (payload) => {
            if (settled) return;
            if (payload.brain?.deviceId?.trim() !== environment.hostDeviceId) {
              fail(new Error("Connected machine identity did not match the stored pairing."));
              return;
            }
            settled = true;
            clearDeadlines();
            this.finishConnected(environment, endpoint, payload);
            resolve();
          },
          onHelloError: (payload) => {
            if (settled) return;
            fail(this.handleAuthFailure(environment, payload));
          },
        }).catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      };
      socket.onerror = () => {
        fail(new Error(`WebSocket failed for ${endpoint}.`));
      };
      socket.onclose = (event) => {
        if (!settled) {
          fail(this.errorForClose(event));
          return;
        }
        this.handleClose(event);
      };
    });
  }

  private async pairWithAccountOnEndpoint(
    endpoint: string,
    args: AccountPairAndConnectArgs,
    dpop: SyncDpopProof,
  ): Promise<{ environment: WebClientEnvironmentRecord; helloOk: SyncHelloOkPayload; endpoint: string }> {
    const socket = this.socketFactory(endpoint);
    this.ws = socket;
    this.shouldReconnect = false;
    this.setStatus({ state: "connecting", endpoint, error: null });
    let settled = false;
    return await new Promise((resolve, reject) => {
      let helloTimeout: ReturnType<typeof setTimeout> | null = null;
      const clearDeadlines = () => {
        clearTimeout(openTimeout);
        if (helloTimeout) clearTimeout(helloTimeout);
      };
      const fail = (error: Error, closeReason?: string) => {
        if (settled) return;
        settled = true;
        clearDeadlines();
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
      const openTimeout = setTimeout(() => {
        fail(new Error("Timed out opening the account machine connection."), "Account transport open timeout");
      }, this.transportOpenTimeoutMs);

      socket.onopen = () => {
        if (settled) return;
        clearTimeout(openTimeout);
        helloTimeout = setTimeout(() => {
          fail(new Error("Timed out authenticating with the account machine."), "Account hello timeout");
        }, this.authenticatedHelloTimeoutMs);
        const payload: SyncHelloPayload = {
          peer: args.peer,
          auth: {
            kind: "account",
            deviceId: args.peer.deviceId,
            accountToken: args.accountToken,
            dpop,
          },
        };
        socket.send(encodeEnvelopeText({ type: "hello", requestId: "account-hello", payload }));
      };
      socket.onmessage = (event) => {
        void this.handleMessage(asMessageEvent(event.data), {
          onHelloOk: (payload) => {
            if (settled) return;
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
            settled = true;
            clearDeadlines();
            this.finishConnected(environment, endpoint, payload);
            this.shouldReconnect = true;
            resolve({ environment, helloOk: payload, endpoint });
          },
          onHelloError: (payload) => {
            if (settled) return;
            fail(new Error(payload.message || "Account authentication was rejected."));
          },
        }).catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      };
      socket.onerror = () => {
        fail(new Error("The secure machine connection failed."));
      };
      socket.onclose = (event) => {
        if (!settled) {
          fail(this.errorForClose(event));
          return;
        }
        this.handleClose(event);
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
    environment: WebClientEnvironmentRecord,
    preparedAuth: PreparedPairedHelloAuth,
  ): Promise<void> {
    const { dpop, relayAccountToken } = await preparedAuth;
    if (socket !== this.ws || socket.readyState !== SOCKET_OPEN) return;
    const payload: SyncHelloPayload = {
      peer: {
        deviceId: environment.localDeviceId,
        deviceName: environment.localDeviceName,
        platform: platformFromNavigator(),
        deviceType: "browser" as SyncPeerMetadata["deviceType"],
        siteId: environment.siteId,
        dbVersion: 0,
        capabilities: [],
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
    const token = (await this.relayAccountTokenProvider?.() ?? "").trim();
    if (!token) throw new Error("Sign in again to connect through ADE Relay.");
    return token;
  }

  private async handleMessage(
    event: MessageEvent<string>,
    callbacks: {
      onHelloOk?: (payload: SyncHelloOkPayload) => void;
      onHelloError?: (payload: SyncHelloErrorPayload) => void;
    } = {},
  ): Promise<void> {
    const envelope = await decodeEnvelopeText(event.data);
    this.setStatus({ lastSeenAt: nowIso() });
    if (envelope.type === "hello_ok") {
      callbacks.onHelloOk?.(envelope.payload as SyncHelloOkPayload);
    } else if (envelope.type === "hello_error") {
      callbacks.onHelloError?.(envelope.payload as SyncHelloErrorPayload);
    }
    this.routeEnvelope(envelope);
  }

  private routeEnvelope(envelope: SyncEnvelope): void {
    this.emit("envelope", envelope);
    switch (envelope.type) {
      case "heartbeat": {
        const payload = envelope.payload as SyncHeartbeatPayload;
        if (payload.kind === "ping") {
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
      default:
        break;
    }
  }

  private finishConnected(environment: WebClientEnvironmentRecord, endpoint: string, helloOk: SyncHelloOkPayload): void {
    this.environment = environment;
    this.endpoints = [
      ...this.endpoints.filter((candidate) => candidate.url === endpoint),
      ...this.endpoints.filter((candidate) => candidate.url !== endpoint),
    ];
    this.latestHello = helloOk;
    this.backoffMs = BACKOFF_MIN_MS;
    this.consecutiveAuthFailures = 0;
    this.setStatus({
      state: "connected",
      endpoint,
      envId: environment.envId,
      hostDeviceId: environment.hostDeviceId,
      hostName: environment.machineName,
      connectedAt: nowIso(),
      error: null,
    });
    this.startHeartbeat(helloOk.heartbeatIntervalMs);
    this.startInboundStaleWatchdog();
    this.emit("helloOk", helloOk);
    if (helloOk.projects) this.emit("projectCatalog", { projects: helloOk.projects });
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
      this.emit("pairingRejected", { envId: environment.envId, hostDeviceId: environment.hostDeviceId });
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const delay = Math.max(5_000, Math.floor(intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS));
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) return;
      this.send({
        type: "heartbeat",
        payload: {
          kind: "ping",
          sentAt: nowIso(),
          dbVersion: 0,
        } satisfies SyncHeartbeatPayload,
      });
    }, delay);
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
    );
    return true;
  }

  private errorForClose(event: Pick<CloseEvent, "code" | "reason">): SyncConnectionError {
    switch (event.code) {
      case 4501:
        return new SyncConnectionError("This Mac appears to be offline", "relay_host_offline");
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

  private handleClose(event: CloseEvent, bypassBackoff = false): void {
    this.stopTimers();
    this.ws = null;
    this.latestHello = null;
    this.emit("close", { code: event.code, reason: event.reason });
    if (this.intentionalClose) return;
    this.setStatus({
      state: "disconnected",
      connectedAt: null,
      error: this.errorForClose(event).message,
    });
    if (this.shouldReconnect) {
      this.scheduleReconnect(
        bypassBackoff ? this.visibilityReconnectDelayMs() : 0,
        bypassBackoff,
      );
    }
  }

  private scheduleReconnect(minimumDelayMs = 0, bypassBackoff = false): void {
    if (!this.environment || !visible(this.documentRef) || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 350);
    const delay = bypassBackoff
      ? minimumDelayMs
      : Math.max(minimumDelayMs, Math.min(BACKOFF_MAX_MS, this.backoffMs) + jitter);
    if (!bypassBackoff) this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    this.setStatus({ state: "reconnecting" });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.environment || !this.shouldReconnect || !visible(this.documentRef)) return;
      void this.connectWithCandidates(this.environment, this.endpoints).catch(() => {
        if (this.shouldReconnect) this.scheduleReconnect();
      });
    }, delay);
  }

  private visibilityReconnectDelayMs(): number {
    const elapsedSinceDialMs = Date.now() - this.lastDialStartedAtMs;
    return elapsedSinceDialMs < VISIBILITY_RECONNECT_DEBOUNCE_MS
      ? VISIBILITY_RECONNECT_DEBOUNCE_MS - elapsedSinceDialMs
      : 0;
  }

  private readonly handleVisibilityChange = () => {
    if (!visible(this.documentRef)) return;
    if (this.isConnected()) {
      this.closeIfInboundStale(true);
      return;
    }
    if (!this.environment || !this.shouldReconnect) return;
    if (this.reconnectTimer || this.status.state === "connecting" || this.status.state === "reconnecting") return;
    this.scheduleReconnect(this.visibilityReconnectDelayMs());
  };

  private cleanupSocket(): void {
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
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.inboundStaleTimer) {
      clearInterval(this.inboundStaleTimer);
      this.inboundStaleTimer = null;
    }
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
