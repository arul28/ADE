import type {
  SyncBrainStatusPayload,
  SyncChatEventPayload,
  SyncChatSubscribePayload,
  SyncChatSubscribeSnapshotPayload,
  SyncCommandAckPayload,
  SyncCommandResultPayload,
  SyncEnvelope,
  SyncFileRequest,
  SyncFileResponsePayload,
  SyncHelloOkPayload,
  SyncMobileProjectSummary,
  SyncProjectCatalogPayload,
  SyncProjectSwitchResultPayload,
  SyncRemoteCommandDescriptor,
  SyncRemoteCommandAction,
  SyncTerminalDataPayload,
  SyncTerminalHistoryRequestPayload,
  SyncTerminalHistoryResponsePayload,
  SyncTerminalInputAckPayload,
  SyncTerminalSnapshotPayload,
} from "../../../shared/types/sync";
import type { AdeAccountMachine } from "../../../shared/types/account";
import {
  accountMachineDisplayName,
  accountMachinePairedSyncEndpoints,
  accountMachineSecureSyncEndpoints,
} from "../../../shared/accountDirectory";
import { isTailnetHostname } from "../../../shared/tailnet";
import { exportPublicKeyX963Base64, generateDpopKeyPair, signDpopProof } from "./dpop";
import { deriveBrowserSyncEndpoints } from "./endpoints";
import {
  filterEnvironmentEndpoints,
  requireDialableAuthorizedEndpoint,
  SIGNED_OUT_RELAY_ACCESS,
  WebRelayAuthRequiredError,
  type WebRelayAccess,
} from "./relayPolicy";
import {
  platformFromNavigator,
  SyncConnection,
  SyncConnectionError,
  type SyncConnectionStatus,
  type WebSocketFactory,
} from "./connection";
import {
  IndexedDbStorage,
  WebClientEnvStore,
  type WebClientEnvironmentRecord,
  type WebClientEnvironmentPruneResult,
  type WebClientStorage,
} from "./envStore";
import { randomHex, uuid } from "./ids";

export class AdeSyncError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) {
    super(message);
  }
}

export type AdeSyncClientStatus = SyncConnectionStatus & {
  activeProjectId: string | null;
  selectedEnvId: string | null;
  /** Application readiness, which intentionally lags the transport hello. */
  readiness: "disconnected" | "restoring" | "ready" | "failed";
};

export type AdeSyncActiveProjectChange = Readonly<{
  previousProjectId: string | null;
  project: SyncMobileProjectSummary;
  catalog: SyncProjectCatalogPayload;
}>;

export type WebAccountSessionLease = Readonly<{
  userId: string;
  generation: number;
}>;

export type SendCommandOptions = {
  projectId?: string | null;
  timeoutMs?: number;
};

export type FileRequestOptions = {
  projectId?: string | null;
  timeoutMs?: number;
};

export type SupportedFileAction = Exclude<SyncFileRequest["action"], "watchChanges" | "stopWatching">;
export type FileArgsFor<TAction extends SupportedFileAction> =
  Extract<SyncFileRequest, { action: TAction }> extends { args?: infer TArgs } ? TArgs : never;

export type ChatHandlers = {
  snapshot?: (payload: SyncChatSubscribeSnapshotPayload) => void;
  event?: (payload: SyncChatEventPayload) => void;
  error?: (error: Error) => void;
};

export type TerminalHandlers = {
  snapshot?: (payload: SyncTerminalSnapshotPayload) => void;
  data?: (payload: SyncTerminalDataPayload) => void;
  exit?: (payload: unknown) => void;
  error?: (error: Error) => void;
};

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  generation: number;
};

type PendingCommand = PendingRequest<unknown> & {
  commandId: string;
  acked: boolean;
};

type ChatSubscription = {
  payload: SyncChatSubscribePayload;
  handlers: ChatHandlers;
  sinceSeq: number | null;
  bindsActiveProject: boolean;
};

type TerminalSubscription = {
  sessionId: string;
  maxBytes?: number;
  handlers: TerminalHandlers;
  sinceOffset: number | null;
  recoveryInFlight: boolean;
};

type TerminalInputOperation = {
  inputId: string;
  sessionId: string;
  data: string;
  byteLength: number;
  attempts: number;
  attemptGeneration: number;
  firstSentAtMs: number | null;
  retryWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  resolve: () => void;
  reject: (error: Error) => void;
};

type ClientEvents = {
  status: AdeSyncClientStatus;
  brainStatus: SyncBrainStatusPayload;
  tablesChanged: Set<string>;
  chatEvent: SyncChatEventPayload;
  projectCatalog: SyncProjectCatalogPayload;
  activeProjectChanged: AdeSyncActiveProjectChange;
};

type ListenerMap = {
  [K in keyof ClientEvents]: Set<(payload: ClientEvents[K]) => void>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 65_000;
const DEFAULT_RESTORATION_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINAL_INPUT_ACK_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINAL_INPUT_MAX_ATTEMPTS = 4;
const DEFAULT_TERMINAL_INPUT_RETRY_WINDOW_MS = 30_000;
const MAX_QUEUED_TERMINAL_INPUTS = 128;
const MAX_QUEUED_TERMINAL_INPUT_BYTES = 512 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

const terminalTextEncoder = new TextEncoder();
const terminalTextDecoder = new TextDecoder();

function terminalUtf8Bytes(value: string): Uint8Array {
  return terminalTextEncoder.encode(value);
}

function trimTerminalUtf8Prefix(value: string, byteCount: number): { value: string; trimmedBytes: number } {
  const bytes = terminalUtf8Bytes(value);
  let start = Math.max(0, Math.min(bytes.byteLength, Math.floor(byteCount)));
  while (start < bytes.byteLength && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return {
    value: terminalTextDecoder.decode(bytes.subarray(start)),
    trimmedBytes: start,
  };
}

function terminalPayloadRange(
  data: string,
  startOffset: number | null | undefined,
  endOffset: number | null | undefined,
): { startOffset: number; endOffset: number } | null {
  if (!Number.isSafeInteger(endOffset) || (endOffset as number) < 0) return null;
  const byteLength = terminalUtf8Bytes(data).byteLength;
  const inferredStart = (endOffset as number) - byteLength;
  if (inferredStart < 0) return null;
  if (Number.isSafeInteger(startOffset) && startOffset === inferredStart) {
    return { startOffset, endOffset: endOffset as number };
  }
  return { startOffset: inferredStart, endOffset: endOffset as number };
}

function openProjectFromCatalog(projects: SyncMobileProjectSummary[] | undefined): string | null {
  return projects?.find((project) => project.isOpen)?.id ?? projects?.[0]?.id ?? null;
}

function commandError(payload: SyncCommandResultPayload): AdeSyncError {
  const code = payload.error?.code ?? "command_failed";
  return new AdeSyncError(payload.error?.message ?? "Remote command failed.", code, payload.error ?? payload);
}

function mapRelayAuthError(error: unknown): never {
  if (error instanceof SyncConnectionError && error.code === "relay_account_required") {
    throw new WebRelayAuthRequiredError(error.message);
  }
  throw error;
}

function timeout<T>(pending: PendingRequest<T>, requests: Map<string, PendingRequest<T>>, requestId: string): void {
  requests.delete(requestId);
  pending.reject(new AdeSyncError("Timed out waiting for ADE machine response.", "timeout"));
}

export class AdeSyncClient {
  private readonly envStore: WebClientEnvStore;
  private readonly connection: SyncConnection;
  private selectedEnvId: string | null = null;
  private activeProjectId: string | null = null;
  private currentCatalog: SyncProjectCatalogPayload | null = null;
  private latestHello: SyncHelloOkPayload | null = null;
  private readiness: AdeSyncClientStatus["readiness"] = "disconnected";
  private readinessError: Error | null = null;
  private clientGeneration = 0;
  private restorationPromise: Promise<void> | null = null;
  private lastTransportState: SyncConnectionStatus["state"] = "idle";
  private relayAccess: WebRelayAccess = SIGNED_OUT_RELAY_ACCESS;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly pendingFiles = new Map<string, PendingRequest<unknown>>();
  private readonly pendingTerminalHistory = new Map<string, PendingRequest<SyncTerminalHistoryResponsePayload>>();
  private readonly pendingProjectCatalog: PendingRequest<SyncProjectCatalogPayload>[] = [];
  private readonly pendingProjectSwitches = new Map<string, PendingRequest<SyncProjectSwitchResultPayload>>();
  private readonly chatSubscriptions = new Map<string, ChatSubscription>();
  private readonly terminalSubscriptions = new Map<string, TerminalSubscription>();
  private readonly terminalInputQueue: TerminalInputOperation[] = [];
  private terminalInputQueueBytes = 0;
  private streamSubscriptionsPaused = false;
  private environmentPersistenceTail: Promise<void> = Promise.resolve();
  private readonly restorationTimeoutMs: number;
  private readonly terminalInputAckTimeoutMs: number;
  private readonly terminalInputMaxAttempts: number;
  private readonly listeners: ListenerMap = {
    status: new Set(),
    brainStatus: new Set(),
    tablesChanged: new Set(),
    chatEvent: new Set(),
    projectCatalog: new Set(),
    activeProjectChanged: new Set(),
  };

  constructor(options: {
    storage?: WebClientStorage;
    socketFactory?: WebSocketFactory;
    connection?: SyncConnection;
    transportOpenTimeoutMs?: number;
    authenticatedHelloTimeoutMs?: number;
    restorationTimeoutMs?: number;
    terminalInputAckTimeoutMs?: number;
    terminalInputMaxAttempts?: number;
    document?: Document | null;
  } = {}) {
    this.envStore = new WebClientEnvStore(options.storage ?? new IndexedDbStorage());
    this.connection = options.connection ?? new SyncConnection({
      socketFactory: options.socketFactory,
      transportOpenTimeoutMs: options.transportOpenTimeoutMs,
      authenticatedHelloTimeoutMs: options.authenticatedHelloTimeoutMs,
      document: options.document,
    });
    this.restorationTimeoutMs = Math.max(
      250,
      Math.floor(options.restorationTimeoutMs ?? DEFAULT_RESTORATION_TIMEOUT_MS),
    );
    this.terminalInputAckTimeoutMs = Math.max(
      50,
      Math.floor(options.terminalInputAckTimeoutMs ?? DEFAULT_TERMINAL_INPUT_ACK_TIMEOUT_MS),
    );
    this.terminalInputMaxAttempts = Math.max(
      1,
      Math.floor(options.terminalInputMaxAttempts ?? DEFAULT_TERMINAL_INPUT_MAX_ATTEMPTS),
    );
    this.lastTransportState = this.connection.getStatus().state;
    this.connection.on("statusChanged", (transportStatus) => {
      if (transportStatus.state === "connected" && this.lastTransportState !== "connected") {
        // A successful WebSocket hello only makes the restoration protocol
        // available. Cached app state remains mounted, but commands are held
        // until the catalog and stream registrations are restored below.
        this.readiness = "restoring";
        this.readinessError = null;
      } else if (transportStatus.state !== "connected" && this.lastTransportState === "connected") {
        this.readiness = "disconnected";
      }
      this.lastTransportState = transportStatus.state;
      this.emitStatus();
    });
    this.connection.on("envelope", (envelope) => this.handleEnvelope(envelope));
    this.connection.on("helloOk", (payload) => {
      this.beginRestoration(payload);
    });
    this.connection.on("pairingRejected", ({ envId }) => {
      void this.removeEnvironment(envId);
    });
    this.connection.on("close", ({ code, reason }) => {
      this.invalidateGeneration(new AdeSyncError(
        "Connection lost — outcome unknown. Check the current state before retrying.",
        "connection_lost_outcome_unknown",
        { closeCode: code, reason },
      ), { preserveTerminalInputs: true });
    });
    this.connection.on("brainStatus", (payload) => this.emit("brainStatus", payload));
    this.connection.on("tablesChanged", (tables) => this.emit("tablesChanged", tables));
    this.connection.on("projectCatalog", (payload) => {
      this.currentCatalog = payload;
      this.resolveProjectCatalog(payload, this.clientGeneration);
      this.emit("projectCatalog", payload);
      const openProject = payload.projects.find((project) => project.isOpen) ?? null;
      if (openProject && openProject.id !== this.activeProjectId) {
        const previousProjectId = this.activeProjectId;
        this.activeProjectId = openProject.id;
        if (this.readiness === "restoring") {
          this.rejectTerminalInputQueue(this.activeProjectChangedError());
        } else {
          this.advanceActiveProjectBoundary();
        }
        this.retireActiveProjectStreams();
        this.rebindForeignProjectStreams();
        this.publishActiveProjectBoundary(previousProjectId, openProject, payload);
      }
      if (this.readiness === "failed" && this.latestHello && this.connection.isConnected()) {
        this.beginRestoration({ ...this.latestHello, projects: payload.projects });
      }
    });
  }

  async pairWithAccountMachine(args: {
    machine: AdeAccountMachine;
    accessToken: string;
    accountSessionLease: WebAccountSessionLease;
    isAccountSessionLeaseCurrent: (lease: WebAccountSessionLease) => boolean;
    deviceName: string;
    relayBaseUrls?: readonly string[];
    getRelayAccountToken?: () => Promise<string>;
  }): Promise<WebClientEnvironmentRecord> {
    const accessToken = args.accessToken.trim();
    const accountOwnerUserId = args.accountSessionLease.userId.trim();
    this.relayAccess = {
      kind: "signed_in",
      userId: accountOwnerUserId,
      hostDeviceIds: args.machine.deviceId ? [args.machine.deviceId] : [],
      getAccessToken: args.getRelayAccountToken ?? (() => Promise.resolve(accessToken)),
    };
    const deviceName = args.deviceName.trim();
    const expectedHostDeviceId = args.machine.deviceId?.trim() ?? "";
    if (!accessToken) throw new AdeSyncError("ADE account sign-in is required.", "account_signed_out");
    if (!accountOwnerUserId) throw new AdeSyncError("Sign in again to connect this machine.", "account_signed_out");
    if (!args.isAccountSessionLeaseCurrent(args.accountSessionLease)) {
      this.disconnect();
      throw new AdeSyncError(
        "Your ADE account changed while connecting. Sign in again.",
        "account_session_changed",
      );
    }
    if (!expectedHostDeviceId) throw new AdeSyncError("That machine is missing a stable device id.", "invalid_machine");
    if (!deviceName) throw new AdeSyncError("Browser device name is required.", "invalid_device_name");

    // Clerk bearer credentials are allowed only on an exact WSS relay URL
    // supplied by the verified account directory. Direct/LAN routes are saved
    // below only after the host returns an ordinary paired secret.
    const accountRelayEndpoints = accountMachineSecureSyncEndpoints(
      args.machine,
      args.relayBaseUrls,
    );
    if (accountRelayEndpoints.length === 0) {
      throw new AdeSyncError(
        "That machine has no directory-verified secure relay route.",
        "secure_relay_unavailable",
      );
    }
    const savedCandidate = await this.envStore.findByHostDeviceId(expectedHostDeviceId);
    const existing = savedCandidate?.accountOwnerUserId == null
      || savedCandidate.accountOwnerUserId === accountOwnerUserId
      ? savedCandidate
      : null;
    const selectedEnvIdBeforePairing = this.selectedEnvId;
    const dpopKeys = existing?.dpopKeys ?? await generateDpopKeyPair();
    const dpopPublicKeyX963 = existing?.dpopPublicKeyX963
      ?? await exportPublicKeyX963Base64(dpopKeys.publicKey);
    const localDeviceId = existing?.localDeviceId ?? uuid();
    const siteId = existing?.siteId ?? randomHex(16);
    const peer = {
      deviceId: localDeviceId,
      deviceName,
      platform: platformFromNavigator(),
      deviceType: "browser" as const,
      siteId,
      dbVersion: 0,
      capabilities: [],
    };
    const pairedRoutes = accountMachinePairedSyncEndpoints(
      args.machine,
      args.relayBaseUrls,
    );
    const validatedDirectUrls = pairedRoutes.flatMap((candidate) => {
      try {
        const url = new URL(candidate);
        return url.protocol === "ws:" ? [url] : [];
      } catch {
        return [];
      }
    });
    const directPort = validatedDirectUrls[0]
      ? Number.parseInt(validatedDirectUrls[0].port || "80", 10)
      : 0;
    const addressCandidates = validatedDirectUrls
      .filter((url) => Number.parseInt(url.port || "80", 10) === directPort)
      .map((url) => ({
        host: url.hostname.replace(/^\[|\]$/g, ""),
        kind: isTailnetHostname(url.hostname) ? "tailscale" as const : "lan" as const,
      }));
    const paired = await this.connection.pairWithAccount({
      endpoints: accountRelayEndpoints.map((url) => ({
        url,
        kind: "relay" as const,
        dialable: true,
      })),
      peer,
      accountToken: accessToken,
      relayAccountTokenProvider: args.getRelayAccountToken,
      createDpop: async () => await signDpopProof({
        privateKey: dpopKeys.privateKey,
        publicKeyX963Base64: dpopPublicKeyX963,
        deviceId: localDeviceId,
        secret: accessToken,
      }),
      expectedHostDeviceId,
      existingPairing: existing
        ? { deviceId: existing.pairedDeviceId, secret: existing.secret }
        : null,
      buildEnvironment: (helloOk, endpoint, pairing) => {
        const explicitWssEndpoints = [...new Set([
          ...pairedRoutes.filter((candidate) => candidate.startsWith("wss://")),
          endpoint,
          ...(helloOk.cloudRelayWssUrl?.startsWith("wss://") ? [helloOk.cloudRelayWssUrl] : []),
        ])];
        return {
          envId: existing?.envId ?? uuid(),
          machineName: accountMachineDisplayName(args.machine) ?? helloOk.brain.deviceName,
          hostDeviceId: expectedHostDeviceId,
          accountOwnerUserId: existing?.accountOwnerUserId == null && existing
            ? null
            : accountOwnerUserId,
          relayUrl: helloOk.cloudRelayWssUrl ?? endpoint,
          machineKeyUrl: endpoint,
          addressCandidates,
          explicitWssEndpoints,
          port: directPort,
          pairedDeviceId: pairing.deviceId,
          secret: pairing.secret,
          dpopKeys,
          dpopPublicKeyX963,
          siteId,
          localDeviceId,
          localDeviceName: deviceName,
          createdAt: existing?.createdAt ?? nowIso(),
          lastConnectedAt: nowIso(),
          lastGoodEndpoint: endpoint,
          activeProjectId: existing?.activeProjectId ?? null,
          hostIdentity: {
            deviceId: helloOk.brain.deviceId,
            siteId: helloOk.brain.siteId,
            name: helloOk.brain.deviceName,
            platform: helloOk.brain.platform,
            deviceType: helloOk.brain.deviceType,
          },
        };
      },
    });
    const accountSessionChangedError = () => new AdeSyncError(
      "Your ADE account changed while connecting. Sign in again.",
      "account_session_changed",
    );
    const accountSessionIsCurrent = () => args.isAccountSessionLeaseCurrent(
      args.accountSessionLease,
    );
    const rollbackSavedEnvironment = async () => {
      if (existing?.accountOwnerUserId == null && existing) {
        await this.envStore.saveEnvironment(existing);
        await this.envStore.setSelectedEnvId(
          selectedEnvIdBeforePairing === existing.envId ? existing.envId : null,
        );
        return;
      }
      await this.envStore.removeEnvironment(paired.environment.envId);
    };
    if (!accountSessionIsCurrent()) {
      this.disconnect();
      throw accountSessionChangedError();
    }
    paired.environment.activeProjectId = openProjectFromCatalog(paired.helloOk.projects)
      ?? paired.environment.activeProjectId
      ?? null;
    if (!accountSessionIsCurrent()) {
      this.disconnect();
      throw accountSessionChangedError();
    }
    await this.envStore.saveEnvironment(paired.environment);
    if (!accountSessionIsCurrent()) {
      this.disconnect();
      await rollbackSavedEnvironment();
      throw accountSessionChangedError();
    }
    await this.envStore.setSelectedEnvId(paired.environment.envId);
    if (!accountSessionIsCurrent()) {
      this.disconnect();
      await rollbackSavedEnvironment();
      throw accountSessionChangedError();
    }
    this.selectedEnvId = paired.environment.envId;
    this.activeProjectId = paired.environment.activeProjectId ?? null;
    await this.awaitCurrentRestoration();
    this.emitStatus();
    return paired.environment;
  }

  async removeAccountOwnedEnvironments(ownerUserId: string): Promise<string[]> {
    await this.drainEnvironmentPersistence();
    const removedIds = await this.envStore.removeAccountOwnedEnvironments(ownerUserId);
    return await this.finishAccountEnvironmentRemoval(removedIds);
  }

  async pruneAccountOwnedEnvironments(
    currentOwnerUserId: string | null,
  ): Promise<WebClientEnvironmentPruneResult> {
    await this.drainEnvironmentPersistence();
    const result = await this.envStore.pruneAccountOwnedEnvironments(
      currentOwnerUserId,
    );
    await this.finishAccountEnvironmentRemoval(result.removedIds);
    return result;
  }

  private async finishAccountEnvironmentRemoval(
    removedIds: string[],
  ): Promise<string[]> {
    if (!this.selectedEnvId || !removedIds.includes(this.selectedEnvId)) {
      return removedIds;
    }
    this.disconnect();
    this.selectedEnvId = null;
    this.activeProjectId = null;
    await this.envStore.setSelectedEnvId(null);
    this.emitStatus();
    return removedIds;
  }

  async connect(
    envId: string,
    relayAccess: WebRelayAccess = SIGNED_OUT_RELAY_ACCESS,
  ): Promise<void> {
    const environment = await this.envStore.getEnvironment(envId);
    if (!environment) throw new AdeSyncError(`Unknown ADE web-client environment: ${envId}`, "unknown_environment");
    const originalEndpoints = deriveBrowserSyncEndpoints({ environment });
    const endpoints = filterEnvironmentEndpoints(environment, originalEndpoints, relayAccess);
    requireDialableAuthorizedEndpoint(originalEndpoints, endpoints);
    this.relayAccess = relayAccess;
    this.selectedEnvId = envId;
    this.activeProjectId = environment.activeProjectId ?? null;
    this.currentCatalog = null;
    this.invalidateGeneration(new AdeSyncError("Connection replaced.", "disconnected"));
    await this.envStore.setSelectedEnvId(envId);
    await this.connection.connect(
      environment,
      endpoints,
      relayAccess.kind === "signed_in" ? relayAccess.getAccessToken : undefined,
    ).catch(mapRelayAuthError);
    await this.awaitCurrentRestoration();
  }

  disconnect(): void {
    this.connection.disconnect({ reconnect: false });
    this.relayAccess = SIGNED_OUT_RELAY_ACCESS;
    this.currentCatalog = null;
    this.latestHello = null;
    this.invalidateGeneration(new AdeSyncError("Disconnected from ADE machine.", "disconnected"));
    this.emitStatus();
  }

  async switchEnvironment(
    envId: string,
    relayAccess: WebRelayAccess = SIGNED_OUT_RELAY_ACCESS,
  ): Promise<void> {
    this.disconnect();
    await this.connect(envId, relayAccess);
  }

  async listEnvironments(): Promise<WebClientEnvironmentRecord[]> {
    return await this.envStore.listEnvironments();
  }

  async removeEnvironment(envId: string): Promise<void> {
    if (this.selectedEnvId === envId) {
      this.disconnect();
      this.selectedEnvId = null;
      this.activeProjectId = null;
    }
    await this.drainEnvironmentPersistence();
    await this.envStore.removeEnvironment(envId);
    this.emitStatus();
  }

  getStatus(): AdeSyncClientStatus {
    const transportStatus = this.connection.getStatus();
    const state = transportStatus.state === "connected"
      ? this.readiness === "ready"
        ? "connected"
        : this.readiness === "failed"
          ? "error"
          : "restoring"
      : transportStatus.state;
    return {
      ...transportStatus,
      state,
      error: this.readiness === "failed"
        ? this.readinessError?.message ?? "Can't reach this computer."
        : transportStatus.error,
      activeProjectId: this.activeProjectId,
      selectedEnvId: this.selectedEnvId,
      readiness: this.readiness,
    };
  }

  subscribe(listener: (status: AdeSyncClientStatus) => void): () => void {
    return this.on("status", listener);
  }

  async sendCommand(
    action: SyncRemoteCommandAction | (string & {}),
    args: Record<string, unknown>,
    opts: SendCommandOptions = {},
  ): Promise<unknown> {
    const generation = this.requireReadyGeneration();
    const commandId = uuid();
    const projectId = opts.projectId ?? this.activeProjectId;
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingCommand = {
        commandId,
        acked: false,
        resolve,
        reject,
        generation,
        timer: setTimeout(() => {
          this.pendingCommands.delete(commandId);
          reject(new AdeSyncError("Timed out waiting for remote command result.", "timeout"));
        }, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      };
      this.pendingCommands.set(commandId, pending);
    });
    try {
      this.connection.send({
        type: "command",
        requestId: commandId,
        projectId,
        payload: {
          commandId,
          projectId,
          action,
          args,
        },
      });
    } catch (error) {
      this.rejectPending(this.pendingCommands, commandId, this.connectionError(error));
    }
    return await promise;
  }

  async requestFile<TAction extends SupportedFileAction>(
    action: TAction,
    args: FileArgsFor<TAction>,
    opts: FileRequestOptions = {},
  ): Promise<unknown> {
    const generation = this.requireReadyGeneration();
    const requestId = uuid();
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest<unknown> = {
        resolve,
        reject,
        generation,
        timer: setTimeout(() => timeout(pending, this.pendingFiles, requestId), opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      };
      this.pendingFiles.set(requestId, pending);
    });
    try {
      this.connection.send({
        type: "file_request",
        requestId,
        projectId: opts.projectId ?? this.activeProjectId,
        payload: { action, args } as SyncFileRequest,
      });
    } catch (error) {
      this.rejectPending(this.pendingFiles, requestId, this.connectionError(error));
    }
    return await promise;
  }

  subscribeChat(sessionId: string, opts: Omit<SyncChatSubscribePayload, "sessionId" | "sinceSeq"> = {}, handlers: ChatHandlers = {}): () => void {
    const existing = this.chatSubscriptions.get(sessionId);
    const subscription: ChatSubscription = {
      payload: { ...opts, sessionId },
      handlers,
      sinceSeq: existing?.sinceSeq ?? null,
      bindsActiveProject: opts.projectId == null && opts.chatScope !== "personal",
    };
    this.chatSubscriptions.set(sessionId, subscription);
    if (!this.streamSubscriptionsPaused) this.sendChatSubscribe(subscription);
    return () => this.unsubscribeChat(sessionId);
  }

  unsubscribeChat(sessionId: string): void {
    const subscription = this.chatSubscriptions.get(sessionId);
    this.chatSubscriptions.delete(sessionId);
    if (!subscription || !this.connection.isConnected()) return;
    this.connection.send({
      type: "chat_unsubscribe",
      projectId: subscription.bindsActiveProject
        ? this.activeProjectId
        : subscription.payload.projectId ?? null,
      payload: {
        sessionId,
        projectId: subscription.payload.projectId,
        projectRootPath: subscription.payload.projectRootPath,
      },
    });
  }

  subscribeTerminal(sessionId: string, opts: { maxBytes?: number } = {}, handlers: TerminalHandlers = {}): () => void {
    const existing = this.terminalSubscriptions.get(sessionId);
    const subscription: TerminalSubscription = {
      sessionId,
      maxBytes: opts.maxBytes,
      handlers,
      sinceOffset: existing?.sinceOffset ?? null,
      recoveryInFlight: existing?.recoveryInFlight ?? false,
    };
    this.terminalSubscriptions.set(sessionId, subscription);
    if (!this.streamSubscriptionsPaused) this.sendTerminalSubscribe(subscription);
    return () => this.unsubscribeTerminal(sessionId);
  }

  unsubscribeTerminal(sessionId: string): void {
    this.terminalSubscriptions.delete(sessionId);
    if (!this.connection.isConnected()) return;
    this.connection.send({
      type: "terminal_unsubscribe",
      projectId: this.activeProjectId,
      payload: { sessionId },
    });
  }

  async sendTerminalInput(sessionId: string, data: string): Promise<void> {
    const generation = this.requireReadyGeneration();
    if (!this.terminalInputAcksSupported()) {
      // Older hosts do not expose a dedupe/ACK contract. Preserve their
      // original best-effort payload exactly, including the absence of an id.
      this.connection.send({
        type: "terminal_input",
        projectId: this.activeProjectId,
        payload: { sessionId, data },
      });
      return;
    }

    const byteLength = terminalUtf8Bytes(data).byteLength;
    if (
      this.terminalInputQueue.length >= MAX_QUEUED_TERMINAL_INPUTS
      || this.terminalInputQueueBytes + byteLength > MAX_QUEUED_TERMINAL_INPUT_BYTES
    ) {
      throw new AdeSyncError(
        "Terminal input is waiting for this computer to catch up. Try again in a moment.",
        "terminal_input_queue_full",
      );
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.terminalInputQueue.push({
        inputId: uuid(),
        sessionId,
        data,
        byteLength,
        attempts: 0,
        attemptGeneration: generation,
        firstSentAtMs: null,
        retryWindowMs: this.terminalInputRetryWindowMs(),
        timer: null,
        deadlineTimer: null,
        resolve,
        reject,
      });
      this.terminalInputQueueBytes += byteLength;
    });
    this.pumpTerminalInputQueue();
    return promise;
  }

  sendTerminalResize(sessionId: string, cols: number, rows: number): void {
    this.requireReadyGeneration();
    this.connection.send({
      type: "terminal_resize",
      projectId: this.activeProjectId,
      payload: { sessionId, cols, rows },
    });
  }

  async requestTerminalHistory(payload: SyncTerminalHistoryRequestPayload, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<SyncTerminalHistoryResponsePayload> {
    const generation = this.requireReadyGeneration();
    const requestId = uuid();
    const promise = new Promise<SyncTerminalHistoryResponsePayload>((resolve, reject) => {
      const pending: PendingRequest<SyncTerminalHistoryResponsePayload> = {
        resolve,
        reject,
        generation,
        timer: setTimeout(() => timeout(pending, this.pendingTerminalHistory, requestId), timeoutMs),
      };
      this.pendingTerminalHistory.set(requestId, pending);
    });
    try {
      this.connection.send({
        type: "terminal_history",
        requestId,
        projectId: this.activeProjectId,
        payload,
      });
    } catch (error) {
      this.rejectPending(this.pendingTerminalHistory, requestId, this.connectionError(error));
    }
    return await promise;
  }

  async getProjectCatalog(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<SyncProjectCatalogPayload> {
    if (this.currentCatalog) return this.currentCatalog;
    this.requireReadyGeneration();
    return await this.requestProjectCatalog(timeoutMs);
  }

  private async requestProjectCatalog(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<SyncProjectCatalogPayload> {
    const generation = this.clientGeneration;
    const shouldSendRequest = this.pendingProjectCatalog.length === 0;
    const promise = new Promise<SyncProjectCatalogPayload>((resolve, reject) => {
      const pending: PendingRequest<SyncProjectCatalogPayload> = {
        resolve,
        reject,
        generation,
        timer: setTimeout(() => {
          const index = this.pendingProjectCatalog.indexOf(pending);
          if (index >= 0) this.pendingProjectCatalog.splice(index, 1);
          reject(new AdeSyncError("Timed out waiting for project catalog.", "timeout"));
        }, timeoutMs),
      };
      this.pendingProjectCatalog.push(pending);
    });
    if (shouldSendRequest) {
      try {
        this.connection.send({
          type: "project_catalog_request",
          requestId: uuid(),
          payload: {},
        });
      } catch (error) {
        this.rejectPendingProjectCatalog(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return await promise;
  }

  /**
   * `rootPath` is optional and additive: the host resolver already accepts
   * either identity, and an Activity item carries the owning machine's local
   * project uuid, which the host's registry cannot match by id alone.
   */
  async switchProject(
    projectId: string,
    rootPath: string | null = null,
  ): Promise<SyncProjectSwitchResultPayload> {
    const generation = this.requireReadyGeneration();
    const requestId = uuid();
    const promise = new Promise<SyncProjectSwitchResultPayload>((resolve, reject) => {
      const pending: PendingRequest<SyncProjectSwitchResultPayload> = {
        resolve,
        reject,
        generation,
        timer: setTimeout(() => timeout(pending, this.pendingProjectSwitches, requestId), DEFAULT_REQUEST_TIMEOUT_MS),
      };
      this.pendingProjectSwitches.set(requestId, pending);
    });
    try {
      this.connection.send({
        type: "project_switch_request",
        requestId,
        payload: { projectId, ...(rootPath ? { rootPath } : {}) },
      });
    } catch (error) {
      this.rejectPending(this.pendingProjectSwitches, requestId, this.connectionError(error));
    }
    const result = await promise;
    if (result.ok) {
      const envId = this.selectedEnvId;
      this.streamSubscriptionsPaused = true;
      try {
        this.activeProjectId = result.project?.id ?? projectId;
        if (envId) {
          this.connection.disconnect({ reconnect: false, code: 1000, reason: "Project switch" });
          this.currentCatalog = null;
        }
        this.invalidateGeneration(new AdeSyncError("Project connection changed.", "disconnected"));
        this.retireActiveProjectStreams();
        await this.persistCurrentEnvironment((environment) => ({
          ...environment,
          port: result.connection?.port ?? environment.port,
          addressCandidates: result.connection?.addressCandidates ?? environment.addressCandidates,
          hostIdentity: result.connection?.hostIdentity ?? environment.hostIdentity,
          activeProjectId: this.activeProjectId,
        }));
        if (envId) {
          await this.connect(envId, this.relayAccess);
        }
      } finally {
        this.streamSubscriptionsPaused = false;
      }
    }
    return result;
  }

  getCommandDescriptors(): SyncRemoteCommandDescriptor[] {
    return this.latestHello?.features.commandRouting.actions ?? [];
  }

  onBrainStatus(listener: (payload: SyncBrainStatusPayload) => void): () => void {
    return this.on("brainStatus", listener);
  }

  onTablesChanged(listener: (tables: Set<string>) => void): () => void {
    return this.on("tablesChanged", listener);
  }

  onChatEvent(listener: (payload: SyncChatEventPayload) => void): () => void {
    return this.on("chatEvent", listener);
  }

  onProjectCatalog(listener: (payload: SyncProjectCatalogPayload) => void): () => void {
    return this.on("projectCatalog", listener);
  }

  onActiveProjectChanged(listener: (payload: AdeSyncActiveProjectChange) => void): () => void {
    return this.on("activeProjectChanged", listener);
  }

  dispose(): void {
    this.disconnect();
    this.connection.dispose();
    for (const listeners of Object.values(this.listeners)) listeners.clear();
  }

  private beginRestoration(payload: SyncHelloOkPayload): void {
    this.rejectAllPending(new AdeSyncError(
      "Connection changed before the request completed.",
      "connection_lost_outcome_unknown",
    ));
    const generation = ++this.clientGeneration;
    this.readiness = "restoring";
    this.readinessError = null;
    this.latestHello = payload;
    if (!this.terminalInputAcksSupported() && this.terminalInputQueue.length > 0) {
      this.rejectTerminalInputQueue(new AdeSyncError(
        "The reconnected computer cannot safely confirm pending terminal input.",
        "terminal_input_ack_unavailable",
      ));
    }
    const restoredProject = payload.projects?.find((project) => project.isOpen)
      ?? payload.projects?.[0]
      ?? null;
    const previousProjectId = this.activeProjectId;
    const crossedProjectBoundary = Boolean(
      restoredProject && restoredProject.id !== previousProjectId,
    );
    if (restoredProject && crossedProjectBoundary) {
      this.activeProjectId = restoredProject.id;
      this.retireActiveProjectStreams();
      this.rejectTerminalInputQueue(this.activeProjectChangedError());
    }

    const restoration = (async () => {
      if (payload.projects !== undefined) {
        const catalog = { projects: payload.projects } satisfies SyncProjectCatalogPayload;
        this.currentCatalog = catalog;
        this.resolveProjectCatalog(catalog, generation);
        if (restoredProject && crossedProjectBoundary) {
          this.publishActiveProjectBoundary(previousProjectId, restoredProject, catalog);
        }
      } else {
        await this.requestProjectCatalog(this.restorationTimeoutMs);
      }

      // Local persistence is useful bookkeeping, not a connectivity barrier.
      // IndexedDB may be slow or unavailable in private/embedded contexts, so
      // do not let it hold an otherwise healthy live connection in restoring.
      void this.persistCurrentEnvironment((environment) => ({
        ...environment,
        activeProjectId: this.activeProjectId,
        lastConnectedAt: nowIso(),
        lastGoodEndpoint: this.connection.getStatus().endpoint,
      }), this.connection.getStatus().envId).catch(() => undefined);

      if (generation !== this.clientGeneration || !this.connection.isConnected()) {
        throw new AdeSyncError("Connection changed while restoring.", "disconnected");
      }
      // The host serializes inbound envelopes, so sending subscriptions before
      // marking the app ready guarantees a queued terminal_input cannot be
      // handled before its terminal_subscribe on this transport generation.
      this.resubscribeStreams();
      if (generation !== this.clientGeneration || !this.connection.isConnected()) {
        throw new AdeSyncError("Connection changed while restoring.", "disconnected");
      }
      this.readiness = "ready";
      this.readinessError = null;
      this.pumpTerminalInputQueue();
      this.emitStatus();
    })();
    this.restorationPromise = restoration;
    void restoration.catch((error) => {
      if (generation !== this.clientGeneration) return;
      this.readiness = "failed";
      this.readinessError = error instanceof Error ? error : new Error(String(error));
      this.emitStatus();
    });
    this.emitStatus();
  }

  private async awaitCurrentRestoration(): Promise<void> {
    const restoration = this.restorationPromise;
    if (!restoration) {
      throw new AdeSyncError("The computer connected without restoring the workspace.", "restoration_missing");
    }
    await restoration;
  }

  private handleEnvelope(envelope: SyncEnvelope): void {
    switch (envelope.type) {
      case "terminal_input_ack":
        this.handleTerminalInputAck(envelope.payload as SyncTerminalInputAckPayload);
        break;
      case "command_ack":
        this.handleCommandAck(envelope.payload as SyncCommandAckPayload);
        break;
      case "command_result":
        this.handleCommandResult(envelope.payload as SyncCommandResultPayload);
        break;
      case "file_response":
        this.handleFileResponse(envelope.requestId ?? null, envelope.payload as SyncFileResponsePayload);
        break;
      case "chat_subscribe":
        this.handleChatSnapshot(envelope.payload as SyncChatSubscribeSnapshotPayload);
        break;
      case "chat_event":
        this.handleChatEvent(envelope.payload as SyncChatEventPayload);
        break;
      case "terminal_snapshot":
        this.handleTerminalSnapshot(envelope.payload as SyncTerminalSnapshotPayload);
        break;
      case "terminal_data":
        this.handleTerminalData(envelope.payload as SyncTerminalDataPayload);
        break;
      case "terminal_exit": {
        const payload = envelope.payload as { sessionId?: string };
        if (payload.sessionId) this.terminalSubscriptions.get(payload.sessionId)?.handlers.exit?.(envelope.payload);
        break;
      }
      case "terminal_history":
        this.handleTerminalHistory(envelope.requestId ?? null, envelope.payload as SyncTerminalHistoryResponsePayload);
        break;
      case "project_switch_result":
        this.handleProjectSwitchResult(envelope.requestId ?? null, envelope.payload as SyncProjectSwitchResultPayload);
        break;
      default:
        break;
    }
  }

  private handleCommandAck(payload: SyncCommandAckPayload): void {
    const pending = this.pendingCommands.get(payload.commandId);
    if (!pending || pending.generation !== this.clientGeneration) return;
    if (!payload.accepted) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(payload.commandId);
      pending.reject(new AdeSyncError(payload.message ?? "Remote command rejected.", "command_rejected", payload));
      return;
    }
    pending.acked = true;
  }

  private handleCommandResult(payload: SyncCommandResultPayload): void {
    const pending = this.pendingCommands.get(payload.commandId);
    if (!pending || pending.generation !== this.clientGeneration) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(payload.commandId);
    if (payload.ok) {
      pending.resolve(payload.result ?? null);
    } else {
      pending.reject(commandError(payload));
    }
  }

  private handleFileResponse(requestId: string | null, payload: SyncFileResponsePayload): void {
    if (!requestId) return;
    const pending = this.pendingFiles.get(requestId);
    if (!pending || pending.generation !== this.clientGeneration) return;
    clearTimeout(pending.timer);
    this.pendingFiles.delete(requestId);
    if (payload.ok) {
      pending.resolve(payload.result ?? null);
    } else {
      pending.reject(new AdeSyncError(payload.error?.message ?? "File request failed.", payload.error?.code ?? "file_request_failed", payload.error ?? payload));
    }
  }

  private handleChatSnapshot(payload: SyncChatSubscribeSnapshotPayload): void {
    const subscription = this.chatSubscriptions.get(payload.sessionId);
    if (!subscription) return;
    if (!payload.resumed) subscription.sinceSeq = null;
    for (const event of payload.events) {
      const seq = (event as SyncChatEventPayload).seq;
      if (typeof seq === "number") subscription.sinceSeq = Math.max(subscription.sinceSeq ?? 0, seq);
    }
    subscription.handlers.snapshot?.(payload);
  }

  private handleChatEvent(payload: SyncChatEventPayload): void {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
    if (!sessionId) return;
    const subscription = this.chatSubscriptions.get(sessionId);
    // A project handoff retires the old project's subscription ownership
    // before rebinding the UI. A late poll result from that host must not leak
    // through the global adapter listener into the newly mounted project.
    if (!subscription) return;
    if (typeof payload.seq === "number") {
      subscription.sinceSeq = Math.max(subscription.sinceSeq ?? 0, payload.seq);
    }
    subscription.handlers.event?.(payload);
    this.emit("chatEvent", payload);
  }

  private handleTerminalSnapshot(payload: SyncTerminalSnapshotPayload): void {
    const subscription = this.terminalSubscriptions.get(payload.sessionId);
    if (!subscription) return;
    subscription.recoveryInFlight = false;

    // A non-delta snapshot is authoritative even when its end offset equals
    // our watermark. The adapter uses it to replace xterm state after a host
    // restart or when the missed range fell outside the snapshot budget.
    if (payload.delta !== true) {
      subscription.sinceOffset = Number.isSafeInteger(payload.endOffset) && (payload.endOffset as number) >= 0
        ? payload.endOffset as number
        : null;
      subscription.handlers.snapshot?.(payload);
      return;
    }

    const range = terminalPayloadRange(payload.transcript, payload.startOffset, payload.endOffset);
    if (!range) {
      // Older hosts may omit offsets. Preserve their append-only behavior,
      // but do not invent a reconnect watermark that could skip later bytes.
      subscription.handlers.snapshot?.(payload);
      return;
    }

    const watermark = subscription.sinceOffset;
    if (watermark == null) {
      subscription.sinceOffset = range.endOffset;
      subscription.handlers.snapshot?.({
        ...payload,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
      });
      return;
    }
    if (range.endOffset <= watermark) return;
    if (range.startOffset > watermark) {
      this.requestTerminalRecovery(subscription);
      return;
    }

    const trimmed = trimTerminalUtf8Prefix(payload.transcript, watermark - range.startOffset);
    subscription.sinceOffset = range.endOffset;
    if (!trimmed.value) return;
    subscription.handlers.snapshot?.({
      ...payload,
      transcript: trimmed.value,
      startOffset: range.startOffset + trimmed.trimmedBytes,
      endOffset: range.endOffset,
    });
  }

  private handleTerminalData(payload: SyncTerminalDataPayload): void {
    const subscription = this.terminalSubscriptions.get(payload.sessionId);
    if (!subscription) return;
    const range = terminalPayloadRange(payload.data, null, payload.offset);
    if (!range) {
      // Offsets are optional for legacy/untracked streams. Deliver those
      // chunks as before, without allowing them to corrupt a numeric watermark.
      subscription.handlers.data?.(payload);
      return;
    }

    const watermark = subscription.sinceOffset;
    if (watermark == null) {
      subscription.sinceOffset = range.endOffset;
      subscription.handlers.data?.(payload);
      return;
    }
    if (range.endOffset <= watermark) return;
    if (range.startOffset > watermark) {
      this.requestTerminalRecovery(subscription);
      return;
    }

    const trimmed = trimTerminalUtf8Prefix(payload.data, watermark - range.startOffset);
    subscription.sinceOffset = range.endOffset;
    if (!trimmed.value) return;
    subscription.handlers.data?.({
      ...payload,
      data: trimmed.value,
      offset: range.endOffset,
    });
  }

  private handleTerminalInputAck(payload: SyncTerminalInputAckPayload): void {
    const operation = this.terminalInputQueue[0];
    if (
      !operation
      || payload.inputId !== operation.inputId
      || (payload.sessionId != null && payload.sessionId !== operation.sessionId)
    ) {
      return;
    }
    if (operation.timer) clearTimeout(operation.timer);
    operation.timer = null;
    if (!payload.ok) {
      const rawError = (payload as { error?: unknown }).error;
      if (!rawError || typeof rawError !== "object") {
        this.failTerminalInput(operation, new AdeSyncError(
          "This computer returned an invalid terminal input response.",
          "terminal_input_invalid_ack",
        ));
        return;
      }
      const inputError = rawError as { code?: unknown; message?: unknown; retryable?: unknown };
      const code = typeof inputError.code === "string" ? inputError.code : "rejected";
      const retryable = inputError.retryable === true;
      const subscription = this.terminalSubscriptions.get(operation.sessionId);
      if (
        retryable
        && code === "not_subscribed"
        && subscription
        && operation.attempts < this.terminalInputMaxAttempts
      ) {
        // Retry only the protocol's explicit subscription race. Re-establish
        // the attachment first, then resend the same dedupe id. All other
        // terminal failures are definitive and advance the FIFO immediately.
        try {
          this.sendTerminalSubscribe(subscription, true);
          this.pumpTerminalInputQueue();
        } catch (error) {
          this.failTerminalInput(operation, this.connectionError(error));
        }
        return;
      }
      this.failTerminalInput(operation, new AdeSyncError(
        typeof inputError.message === "string" && inputError.message.trim()
          ? inputError.message
          : "This computer rejected terminal input.",
        `terminal_input_${code}`,
        { retryable },
      ));
      return;
    }
    this.terminalInputQueue.shift();
    this.terminalInputQueueBytes = Math.max(0, this.terminalInputQueueBytes - operation.byteLength);
    if (operation.deadlineTimer) clearTimeout(operation.deadlineTimer);
    operation.resolve();
    this.pumpTerminalInputQueue();
  }

  private handleTerminalHistory(requestId: string | null, payload: SyncTerminalHistoryResponsePayload): void {
    if (!requestId) return;
    const pending = this.pendingTerminalHistory.get(requestId);
    if (!pending || pending.generation !== this.clientGeneration) return;
    clearTimeout(pending.timer);
    this.pendingTerminalHistory.delete(requestId);
    pending.resolve(payload);
  }

  private handleProjectSwitchResult(requestId: string | null, payload: SyncProjectSwitchResultPayload): void {
    if (!requestId) return;
    const pending = this.pendingProjectSwitches.get(requestId);
    if (!pending || pending.generation !== this.clientGeneration) return;
    clearTimeout(pending.timer);
    this.pendingProjectSwitches.delete(requestId);
    if (payload.ok) pending.resolve(payload);
    else pending.reject(new AdeSyncError(payload.message ?? "Project switch failed.", "project_switch_failed", payload));
  }

  private sendChatSubscribe(subscription: ChatSubscription, throwOnFailure = false): void {
    if (!this.connection.isConnected()) return;
    try {
      this.connection.send({
        type: "chat_subscribe",
        projectId: subscription.bindsActiveProject
          ? this.activeProjectId
          : subscription.payload.projectId ?? null,
        payload: {
          ...subscription.payload,
          ...(subscription.sinceSeq != null ? { sinceSeq: subscription.sinceSeq } : {}),
        },
      });
    } catch (error) {
      const normalized = this.connectionError(error);
      subscription.handlers.error?.(normalized);
      if (throwOnFailure) throw normalized;
    }
  }

  private sendTerminalSubscribe(subscription: TerminalSubscription, throwOnFailure = false): void {
    if (!this.connection.isConnected()) return;
    try {
      this.connection.send({
        type: "terminal_subscribe",
        projectId: this.activeProjectId,
        payload: {
          sessionId: subscription.sessionId,
          ...(subscription.maxBytes ? { maxBytes: subscription.maxBytes } : {}),
          ...(subscription.sinceOffset != null ? { sinceOffset: subscription.sinceOffset } : {}),
        },
      });
    } catch (error) {
      const normalized = this.connectionError(error);
      subscription.handlers.error?.(normalized);
      if (throwOnFailure) throw normalized;
    }
  }

  private requestTerminalRecovery(subscription: TerminalSubscription): void {
    if (subscription.recoveryInFlight || !this.connection.isConnected()) return;
    subscription.recoveryInFlight = true;
    try {
      this.sendTerminalSubscribe(subscription, true);
    } catch {
      subscription.recoveryInFlight = false;
    }
  }

  private resubscribeStreams(): void {
    for (const subscription of this.chatSubscriptions.values()) this.sendChatSubscribe(subscription, true);
    for (const subscription of this.terminalSubscriptions.values()) {
      subscription.recoveryInFlight = false;
      this.sendTerminalSubscribe(subscription, true);
    }
  }

  private terminalInputAcksSupported(): boolean {
    return this.latestHello?.features.terminalInputAck?.enabled === true;
  }

  private terminalInputRetryWindowMs(): number {
    const advertised = this.latestHello?.features.terminalInputAck?.retryWindowMs;
    return typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0
      ? Math.floor(advertised)
      : DEFAULT_TERMINAL_INPUT_RETRY_WINDOW_MS;
  }

  private pumpTerminalInputQueue(): void {
    const operation = this.terminalInputQueue[0];
    if (
      !operation
      || operation.timer
      || this.readiness !== "ready"
      || !this.connection.isConnected()
      || !this.terminalInputAcksSupported()
    ) {
      return;
    }
    if (operation.attemptGeneration !== this.clientGeneration) {
      operation.attemptGeneration = this.clientGeneration;
      operation.attempts = 0;
    }
    if (
      operation.firstSentAtMs != null
      && Date.now() - operation.firstSentAtMs >= operation.retryWindowMs
    ) {
      this.failTerminalInput(operation, new AdeSyncError(
        "Terminal input could not be safely retried after reconnecting. Check the terminal before retrying.",
        "terminal_input_retry_window_expired",
      ));
      return;
    }
    if (operation.attempts >= this.terminalInputMaxAttempts) {
      this.failTerminalInput(operation, new AdeSyncError(
        "This computer did not confirm terminal input. Check the terminal before retrying.",
        "terminal_input_ack_timeout",
        { attempts: operation.attempts },
      ));
      return;
    }

    operation.attempts += 1;
    if (operation.firstSentAtMs == null) {
      operation.firstSentAtMs = Date.now();
      operation.deadlineTimer = setTimeout(() => {
        operation.deadlineTimer = null;
        this.failTerminalInput(operation, new AdeSyncError(
          "Terminal input could not be safely retried after reconnecting. Check the terminal before retrying.",
          "terminal_input_retry_window_expired",
        ));
      }, operation.retryWindowMs);
    }
    const payload = {
      sessionId: operation.sessionId,
      data: operation.data,
      inputId: operation.inputId,
    };
    const retryDelayMs = Math.max(
      10,
      Math.min(
        this.terminalInputAckTimeoutMs,
        Math.floor(operation.retryWindowMs / Math.max(1, this.terminalInputMaxAttempts)),
      ),
    );
    operation.timer = setTimeout(() => {
      operation.timer = null;
      if (this.terminalInputQueue[0] !== operation) return;
      this.pumpTerminalInputQueue();
    }, retryDelayMs);
    try {
      this.connection.send({
        type: "terminal_input",
        requestId: operation.inputId,
        projectId: this.activeProjectId,
        payload,
      });
    } catch {
      // A concurrent close will pause the queue. If the socket has not emitted
      // close yet, the bounded ACK timer below retries with the same dedupe id.
    }
  }

  private pauseTerminalInputQueue(): void {
    for (const operation of this.terminalInputQueue) {
      if (operation.timer) clearTimeout(operation.timer);
      operation.timer = null;
    }
  }

  private rejectTerminalInputQueue(error: Error): void {
    const pending = this.terminalInputQueue.splice(0);
    this.terminalInputQueueBytes = 0;
    for (const operation of pending) {
      if (operation.timer) clearTimeout(operation.timer);
      if (operation.deadlineTimer) clearTimeout(operation.deadlineTimer);
      operation.reject(error);
    }
  }

  private failTerminalInput(operation: TerminalInputOperation, error: Error): void {
    if (this.terminalInputQueue[0] !== operation) return;
    if (operation.timer) clearTimeout(operation.timer);
    if (operation.deadlineTimer) clearTimeout(operation.deadlineTimer);
    this.terminalInputQueue.shift();
    this.terminalInputQueueBytes = Math.max(0, this.terminalInputQueueBytes - operation.byteLength);
    operation.reject(error);
    this.pumpTerminalInputQueue();
  }

  private retireActiveProjectStreams(): void {
    for (const [sessionId, subscription] of [...this.chatSubscriptions]) {
      if (subscription.bindsActiveProject) this.unsubscribeChat(sessionId);
    }
    for (const sessionId of [...this.terminalSubscriptions.keys()]) {
      this.unsubscribeTerminal(sessionId);
    }
  }

  private rebindForeignProjectStreams(): void {
    if (this.readiness !== "ready" || !this.connection.isConnected()) return;
    for (const subscription of this.chatSubscriptions.values()) {
      const isForeignProject = !subscription.bindsActiveProject
        && subscription.payload.chatScope !== "personal"
        && Boolean(subscription.payload.projectId);
      if (!isForeignProject) continue;
      // The shared-listener handoff deliberately carries only the new active
      // project's stream state. Re-open explicit foreign-project quick looks
      // from a full snapshot; their prior cursor belongs to the old host.
      subscription.sinceSeq = null;
      this.sendChatSubscribe(subscription);
    }
  }

  private advanceActiveProjectBoundary(): void {
    const error = this.activeProjectChangedError();
    this.clientGeneration += 1;
    this.rejectPendingCommands(error);
    for (const [requestId, pending] of this.pendingFiles) {
      clearTimeout(pending.timer);
      this.pendingFiles.delete(requestId);
      pending.reject(error);
    }
    for (const [requestId, pending] of this.pendingTerminalHistory) {
      clearTimeout(pending.timer);
      this.pendingTerminalHistory.delete(requestId);
      pending.reject(error);
    }
    for (const [requestId, pending] of this.pendingProjectSwitches) {
      clearTimeout(pending.timer);
      this.pendingProjectSwitches.delete(requestId);
      pending.reject(error);
    }
    this.rejectTerminalInputQueue(error);
  }

  private activeProjectChangedError(): AdeSyncError {
    return new AdeSyncError(
      "The active project changed before the request completed.",
      "project_changed",
    );
  }

  private publishActiveProjectBoundary(
    previousProjectId: string | null,
    project: SyncMobileProjectSummary,
    catalog: SyncProjectCatalogPayload,
  ): void {
    this.emit("activeProjectChanged", {
      previousProjectId,
      project,
      catalog,
    });
    this.emitStatus();
    void this.persistCurrentEnvironment((environment) => ({
      ...environment,
      activeProjectId: project.id,
    })).catch(() => undefined);
  }

  private resolveProjectCatalog(payload: SyncProjectCatalogPayload, generation: number): void {
    const pending = this.pendingProjectCatalog.splice(0);
    for (const request of pending) {
      clearTimeout(request.timer);
      if (request.generation === generation) request.resolve(payload);
      else request.reject(new AdeSyncError("Connection changed before the catalog arrived.", "disconnected"));
    }
  }

  private rejectPendingProjectCatalog(error: Error): void {
    const pending = this.pendingProjectCatalog.splice(0);
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private rejectAllPending(error: Error): void {
    this.rejectPendingCommands(error);
    for (const [requestId, pending] of this.pendingFiles) {
      clearTimeout(pending.timer);
      this.pendingFiles.delete(requestId);
      pending.reject(error);
    }
    for (const [requestId, pending] of this.pendingTerminalHistory) {
      clearTimeout(pending.timer);
      this.pendingTerminalHistory.delete(requestId);
      pending.reject(error);
    }
    for (const [requestId, pending] of this.pendingProjectSwitches) {
      clearTimeout(pending.timer);
      this.pendingProjectSwitches.delete(requestId);
      pending.reject(error);
    }
    this.rejectPendingProjectCatalog(error);
  }

  private rejectPendingCommands(error: Error): void {
    for (const [requestId, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }
  }

  private rejectPending<T>(requests: Map<string, PendingRequest<T>>, requestId: string, error: Error): void {
    const pending = requests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    requests.delete(requestId);
    pending.reject(error);
  }

  private invalidateGeneration(
    error: Error,
    options: { preserveTerminalInputs?: boolean } = {},
  ): void {
    this.clientGeneration += 1;
    this.readiness = "disconnected";
    this.readinessError = null;
    this.restorationPromise = null;
    this.rejectAllPending(error);
    if (options.preserveTerminalInputs) this.pauseTerminalInputQueue();
    else this.rejectTerminalInputQueue(error);
  }

  private requireReadyGeneration(): number {
    if (this.readiness !== "ready" || !this.connection.isConnected()) {
      throw new AdeSyncError("Reconnecting to this computer. Try again when connected.", "not_connected");
    }
    return this.clientGeneration;
  }

  private connectionError(error: unknown): Error {
    return error instanceof AdeSyncError
      ? error
      : new AdeSyncError(
          error instanceof Error ? error.message : "Connection to this computer was lost.",
          "not_connected",
          error,
        );
  }

  private async persistCurrentEnvironment(
    update: (environment: WebClientEnvironmentRecord) => WebClientEnvironmentRecord,
    envId = this.selectedEnvId,
  ): Promise<void> {
    if (!envId) return;
    const persistence = this.environmentPersistenceTail
      .catch(() => undefined)
      .then(async () => {
        const current = await this.envStore.getEnvironment(envId);
        if (!current) return;
        await this.envStore.saveEnvironment(update(current));
      });
    this.environmentPersistenceTail = persistence;
    await persistence;
  }

  private async drainEnvironmentPersistence(): Promise<void> {
    await this.environmentPersistenceTail.catch(() => undefined);
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }

  private on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void {
    this.listeners[event].add(listener as never);
    return () => this.listeners[event].delete(listener as never);
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }
}
