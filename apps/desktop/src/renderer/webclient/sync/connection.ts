import type {
  SyncBrainStatusPayload,
  SyncChangesetBatchPayload,
  SyncEnvelope,
  SyncDpopProof,
  SyncHeartbeatPayload,
  SyncHelloOkPayload,
  SyncHelloPayload,
  SyncHelloErrorPayload,
  SyncPairingRequestPayload,
  SyncPairingResultPayload,
  SyncPeerMetadata,
  SyncProjectCatalogChunkPayload,
  SyncProjectCatalogPayload,
} from "../../../shared/types/sync";
import { resolveAccountHelloPairing } from "../../../shared/accountDirectory";
import { deriveBrowserSyncEndpoints, type BrowserDialCandidate } from "./endpoints";
import type { WebClientEnvironmentRecord } from "./envStore";
import { signDpopProof } from "./dpop";
import {
  createProjectCatalogChunkAssembler,
  decodeEnvelopeText,
  encodeEnvelopeText,
  type EncodeEnvelopeInput,
} from "./wireProtocol";

const SOCKET_OPEN = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 4_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
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

export type PairAndConnectArgs = {
  endpoints: BrowserDialCandidate[];
  peer: SyncPeerMetadata;
  pin: string;
  dpopPublicKey: string;
  buildEnvironment: (result: SyncPairingResultPayload, endpoint: string) => WebClientEnvironmentRecord;
};

export type AccountPairAndConnectArgs = {
  endpoints: BrowserDialCandidate[];
  peer: SyncPeerMetadata;
  accountToken: string;
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

class SyncConnectionError extends Error {
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
  private backoffMs = BACKOFF_MIN_MS;
  private consecutiveAuthFailures = 0;
  private lastDialStartedAtMs = 0;
  private intentionalClose = false;
  private latestHello: SyncHelloOkPayload | null = null;
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
  private readonly connectTimeoutMs: number;
  private readonly documentRef: Document | null;

  constructor(options: {
    socketFactory?: WebSocketFactory;
    connectTimeoutMs?: number;
    document?: Document | null;
  } = {}) {
    this.socketFactory = options.socketFactory ?? createDefaultSocket;
    this.connectTimeoutMs = Math.max(250, Math.floor(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS));
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

  async connect(environment: WebClientEnvironmentRecord, endpoints: BrowserDialCandidate[]): Promise<void> {
    this.disconnect({ reconnect: false, code: 1000, reason: "Reconnect" });
    this.environment = environment;
    this.endpoints = endpoints;
    this.shouldReconnect = true;
    this.consecutiveAuthFailures = 0;
    await this.connectWithCandidates(environment, endpoints);
  }

  async pairAndConnect(args: PairAndConnectArgs): Promise<{ environment: WebClientEnvironmentRecord; helloOk: SyncHelloOkPayload; endpoint: string }> {
    this.disconnect({ reconnect: false, code: 1000, reason: "Pairing" });
    this.endpoints = args.endpoints;
    this.consecutiveAuthFailures = 0;
    const dialable = args.endpoints.filter((candidate) => candidate.dialable);
    if (dialable.length === 0) throw new Error("No dialable sync endpoint is available.");
    let lastError: Error | null = null;
    for (const candidate of dialable) {
      try {
        return await this.pairOnEndpoint(candidate.url, args);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.cleanupSocket();
      }
    }
    throw lastError ?? new Error("Failed to pair with ADE machine.");
  }

  async pairWithAccount(args: AccountPairAndConnectArgs): Promise<{ environment: WebClientEnvironmentRecord; helloOk: SyncHelloOkPayload; endpoint: string }> {
    this.disconnect({ reconnect: false, code: 1000, reason: "Account pairing" });
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
    this.intentionalClose = true;
    this.stopTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(options.code ?? 1000, options.reason ?? "Client disconnect");
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
        await this.connectEndpoint(environment, candidate.url);
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

  private async connectEndpoint(environment: WebClientEnvironmentRecord, endpoint: string): Promise<void> {
    const socket = this.socketFactory(endpoint);
    this.ws = socket;
    this.status.endpoint = endpoint;
    this.emit("statusChanged", this.getStatus());
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to ${endpoint}.`));
        try {
          socket.close(4000, "Connect timeout");
        } catch {
          // ignore
        }
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        void this.sendHello(environment).catch(reject);
      };
      socket.onmessage = (event) => {
        void this.handleMessage(asMessageEvent(event.data), {
          onHelloOk: (payload) => {
            if (settled) return;
            if (payload.brain?.deviceId?.trim() !== environment.hostDeviceId) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error("Connected machine identity did not match the stored pairing."));
              return;
            }
            settled = true;
            clearTimeout(timeout);
            this.finishConnected(environment, endpoint, payload);
            resolve();
          },
          onHelloError: (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(this.handleAuthFailure(environment, payload));
          },
        });
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`WebSocket failed for ${endpoint}.`));
        }
      };
      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Connection closed before authentication completed."));
          return;
        }
        this.handleClose(event);
      };
    });
  }

  private async pairOnEndpoint(endpoint: string, args: PairAndConnectArgs): Promise<{ environment: WebClientEnvironmentRecord; helloOk: SyncHelloOkPayload; endpoint: string }> {
    const socket = this.socketFactory(endpoint);
    this.ws = socket;
    this.shouldReconnect = true;
    this.setStatus({ state: "connecting", endpoint, error: null });
    let pairedEnvironment: WebClientEnvironmentRecord | null = null;
    let settled = false;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out pairing with ${endpoint}.`));
        try {
          socket.close(4000, "Pairing timeout");
        } catch {
          // ignore
        }
      }, this.connectTimeoutMs * 2);

      socket.onopen = () => {
        const payload: SyncPairingRequestPayload = {
          code: args.pin,
          peer: args.peer,
          dpopPublicKey: args.dpopPublicKey,
        };
        socket.send(encodeEnvelopeText({ type: "pairing_request", requestId: "pairing", payload }));
      };
      socket.onmessage = (event) => {
        void this.handleMessage(asMessageEvent(event.data), {
          onPairingResult: (payload) => {
            if (!payload.ok) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error(payload.error?.message ?? "Pairing failed."));
              return;
            }
            pairedEnvironment = args.buildEnvironment(payload, endpoint);
            this.environment = pairedEnvironment;
            void this.sendHello(pairedEnvironment).catch((error) => {
              settled = true;
              clearTimeout(timeout);
              reject(error);
            });
          },
          onHelloOk: (payload) => {
            if (!pairedEnvironment || settled) return;
            settled = true;
            clearTimeout(timeout);
            this.finishConnected(pairedEnvironment, endpoint, payload);
            resolve({ environment: pairedEnvironment, helloOk: payload, endpoint });
          },
          onHelloError: (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(pairedEnvironment ? this.handleAuthFailure(pairedEnvironment, payload) : new Error(payload.message));
          },
        });
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`WebSocket failed for ${endpoint}.`));
        }
      };
      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Connection closed before pairing completed."));
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
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out connecting to the account machine."));
        try {
          socket.close(4000, "Account pairing timeout");
        } catch {
          // Ignore close failures after timeout.
        }
      }, this.connectTimeoutMs * 2);

      socket.onopen = () => {
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
              settled = true;
              clearTimeout(timeout);
              reject(new Error("Account machine identity did not match the verified directory record."));
              return;
            }
            let environment: WebClientEnvironmentRecord;
            try {
              environment = args.buildEnvironment(payload, endpoint, pairing);
            } catch (error) {
              settled = true;
              clearTimeout(timeout);
              reject(error);
              return;
            }
            settled = true;
            clearTimeout(timeout);
            this.finishConnected(environment, endpoint, payload);
            this.shouldReconnect = true;
            resolve({ environment, helloOk: payload, endpoint });
          },
          onHelloError: (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error(payload.message || "Account authentication was rejected."));
          },
        });
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("The secure machine connection failed."));
      };
      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Connection closed before account authentication completed."));
          return;
        }
        this.handleClose(event);
      };
    });
  }

  private async sendHello(environment: WebClientEnvironmentRecord): Promise<void> {
    if (!this.ws || this.ws.readyState !== SOCKET_OPEN) return;
    const dpop = environment.dpopPublicKeyX963
      ? await signDpopProof({
          privateKey: environment.dpopKeys.privateKey,
          publicKeyX963Base64: environment.dpopPublicKeyX963,
          deviceId: environment.pairedDeviceId,
          secret: environment.secret,
        })
      : null;
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
      },
    };
    this.ws.send(encodeEnvelopeText({ type: "hello", requestId: "hello", payload }));
  }

  private async handleMessage(
    event: MessageEvent<string>,
    callbacks: {
      onHelloOk?: (payload: SyncHelloOkPayload) => void;
      onHelloError?: (payload: SyncHelloErrorPayload) => void;
      onPairingResult?: (payload: SyncPairingResultPayload) => void;
    } = {},
  ): Promise<void> {
    const envelope = await decodeEnvelopeText(event.data);
    this.setStatus({ lastSeenAt: nowIso() });
    if (envelope.type === "hello_ok") {
      callbacks.onHelloOk?.(envelope.payload as SyncHelloOkPayload);
    } else if (envelope.type === "hello_error") {
      callbacks.onHelloError?.(envelope.payload as SyncHelloErrorPayload);
    } else if (envelope.type === "pairing_result") {
      callbacks.onPairingResult?.(envelope.payload as SyncPairingResultPayload);
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
    this.endpoints = deriveBrowserSyncEndpoints({ environment });
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
    this.emit("helloOk", helloOk);
    if (helloOk.projects) this.emit("projectCatalog", { projects: helloOk.projects });
  }

  private handleAuthFailure(environment: WebClientEnvironmentRecord, payload: SyncHelloErrorPayload): SyncConnectionError {
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

  private handleClose(event: CloseEvent): void {
    this.stopTimers();
    this.ws = null;
    this.latestHello = null;
    this.emit("close", { code: event.code, reason: event.reason });
    if (this.intentionalClose) return;
    this.setStatus({ state: "disconnected", connectedAt: null, error: event.reason || null });
    if (this.shouldReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(minimumDelayMs = 0): void {
    if (!this.environment || !visible(this.documentRef) || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 350);
    const delay = Math.max(minimumDelayMs, Math.min(BACKOFF_MAX_MS, this.backoffMs) + jitter);
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    this.setStatus({ state: "reconnecting" });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.environment || !this.shouldReconnect || !visible(this.documentRef)) return;
      void this.connectWithCandidates(this.environment, this.endpoints).catch(() => {
        if (this.shouldReconnect) this.scheduleReconnect();
      });
    }, delay);
  }

  private readonly handleVisibilityChange = () => {
    if (!visible(this.documentRef) || this.isConnected() || !this.environment || !this.shouldReconnect) return;
    if (this.reconnectTimer || this.status.state === "connecting" || this.status.state === "reconnecting") return;
    const elapsedSinceDialMs = Date.now() - this.lastDialStartedAtMs;
    const debounceDelayMs = elapsedSinceDialMs < VISIBILITY_RECONNECT_DEBOUNCE_MS
      ? VISIBILITY_RECONNECT_DEBOUNCE_MS - elapsedSinceDialMs
      : 0;
    this.scheduleReconnect(debounceDelayMs);
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
