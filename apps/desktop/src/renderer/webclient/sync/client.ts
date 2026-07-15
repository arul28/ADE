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
  SyncPairingQrPayload,
  SyncProjectCatalogPayload,
  SyncProjectSwitchResultPayload,
  SyncRemoteCommandDescriptor,
  SyncRemoteCommandAction,
  SyncTerminalDataPayload,
  SyncTerminalHistoryRequestPayload,
  SyncTerminalHistoryResponsePayload,
  SyncTerminalSnapshotPayload,
} from "../../../shared/types/sync";
import type { AdeAccountMachine } from "../../../shared/types/account";
import {
  accountMachinePairedSyncEndpoints,
  accountMachineSecureSyncEndpoints,
} from "../../../shared/accountDirectory";
import { isTailnetHostname } from "../../../shared/tailnet";
import { exportPublicKeyX963Base64, generateDpopKeyPair, signDpopProof } from "./dpop";
import { deriveBrowserSyncEndpoints } from "./endpoints";
import {
  platformFromNavigator,
  SyncConnection,
  type SyncConnectionStatus,
  type WebSocketFactory,
} from "./connection";
import {
  IndexedDbStorage,
  WebClientEnvStore,
  type WebClientEnvironmentRecord,
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
};

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
};

type PendingCommand = PendingRequest<unknown> & {
  commandId: string;
  acked: boolean;
};

type ChatSubscription = {
  payload: SyncChatSubscribePayload;
  handlers: ChatHandlers;
  sinceSeq: number | null;
};

type TerminalSubscription = {
  sessionId: string;
  maxBytes?: number;
  handlers: TerminalHandlers;
  sinceOffset: number | null;
};

type ClientEvents = {
  status: AdeSyncClientStatus;
  brainStatus: SyncBrainStatusPayload;
  tablesChanged: Set<string>;
  chatEvent: SyncChatEventPayload;
  projectCatalog: SyncProjectCatalogPayload;
};

type ListenerMap = {
  [K in keyof ClientEvents]: Set<(payload: ClientEvents[K]) => void>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 65_000;

function nowIso(): string {
  return new Date().toISOString();
}

function openProjectFromCatalog(projects: SyncMobileProjectSummary[] | undefined): string | null {
  return projects?.find((project) => project.isOpen)?.id ?? projects?.[0]?.id ?? null;
}

function commandError(payload: SyncCommandResultPayload): AdeSyncError {
  const code = payload.error?.code ?? "command_failed";
  return new AdeSyncError(payload.error?.message ?? "Remote command failed.", code, payload.error ?? payload);
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
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly pendingFiles = new Map<string, PendingRequest<unknown>>();
  private readonly pendingTerminalHistory = new Map<string, PendingRequest<SyncTerminalHistoryResponsePayload>>();
  private readonly pendingProjectCatalog: PendingRequest<SyncProjectCatalogPayload>[] = [];
  private readonly pendingProjectSwitches = new Map<string, PendingRequest<SyncProjectSwitchResultPayload>>();
  private readonly chatSubscriptions = new Map<string, ChatSubscription>();
  private readonly terminalSubscriptions = new Map<string, TerminalSubscription>();
  private streamSubscriptionsPaused = false;
  private readonly listeners: ListenerMap = {
    status: new Set(),
    brainStatus: new Set(),
    tablesChanged: new Set(),
    chatEvent: new Set(),
    projectCatalog: new Set(),
  };

  constructor(options: {
    storage?: WebClientStorage;
    socketFactory?: WebSocketFactory;
    connection?: SyncConnection;
    connectTimeoutMs?: number;
    document?: Document | null;
  } = {}) {
    this.envStore = new WebClientEnvStore(options.storage ?? new IndexedDbStorage());
    this.connection = options.connection ?? new SyncConnection({
      socketFactory: options.socketFactory,
      connectTimeoutMs: options.connectTimeoutMs,
      document: options.document,
    });
    this.connection.on("statusChanged", () => this.emitStatus());
    this.connection.on("envelope", (envelope) => this.handleEnvelope(envelope));
    this.connection.on("helloOk", (payload) => {
      this.latestHello = payload;
      this.activeProjectId = openProjectFromCatalog(payload.projects) ?? this.activeProjectId;
      void this.persistCurrentEnvironment((environment) => ({
        ...environment,
        activeProjectId: this.activeProjectId,
        lastConnectedAt: nowIso(),
        lastGoodEndpoint: this.connection.getStatus().endpoint,
      }));
      this.resubscribeStreams();
      this.emitStatus();
    });
    this.connection.on("pairingRejected", ({ envId }) => {
      void this.removeEnvironment(envId);
    });
    this.connection.on("brainStatus", (payload) => this.emit("brainStatus", payload));
    this.connection.on("tablesChanged", (tables) => this.emit("tablesChanged", tables));
    this.connection.on("projectCatalog", (payload) => {
      this.currentCatalog = payload;
      this.resolveProjectCatalog(payload);
      this.emit("projectCatalog", payload);
    });
  }

  async pair(args: {
    payload: SyncPairingQrPayload;
    pin: string;
    deviceName: string;
  }): Promise<WebClientEnvironmentRecord> {
    const existing = await this.envStore.findByHostDeviceId(args.payload.hostIdentity.deviceId);
    const dpopKeys = await generateDpopKeyPair();
    const dpopPublicKeyX963 = await exportPublicKeyX963Base64(dpopKeys.publicKey);
    const localDeviceId = existing?.localDeviceId ?? uuid();
    const siteId = existing?.siteId ?? randomHex(16);
    const peer = {
      deviceId: localDeviceId,
      deviceName: args.deviceName,
      platform: platformFromNavigator(),
      deviceType: "browser" as const,
      siteId,
      dbVersion: 0,
      capabilities: [],
    };
    const endpoints = deriveBrowserSyncEndpoints({ payload: args.payload });
    const paired = await this.connection.pairAndConnect({
      endpoints,
      peer,
      pin: args.pin,
      dpopPublicKey: dpopPublicKeyX963,
      buildEnvironment: (result, endpoint) => {
        if (!result.secret) throw new AdeSyncError("Pairing succeeded without a secret.", "pairing_failed", result);
        return {
          envId: existing?.envId ?? uuid(),
          machineName: args.payload.hostIdentity.name,
          hostDeviceId: args.payload.hostIdentity.deviceId,
          relayUrl: args.payload.relayUrl ?? existing?.relayUrl ?? null,
          machineKeyUrl: existing?.machineKeyUrl ?? null,
          addressCandidates: args.payload.addressCandidates,
          explicitWssEndpoints: existing?.explicitWssEndpoints ?? [],
          port: args.payload.port,
          pairedDeviceId: result.deviceId ?? localDeviceId,
          secret: result.secret,
          dpopKeys,
          dpopPublicKeyX963,
          siteId,
          localDeviceId,
          localDeviceName: args.deviceName,
          createdAt: existing?.createdAt ?? nowIso(),
          lastConnectedAt: nowIso(),
          lastGoodEndpoint: endpoint,
          activeProjectId: existing?.activeProjectId ?? null,
          hostIdentity: args.payload.hostIdentity,
        };
      },
    });
    paired.environment.activeProjectId = openProjectFromCatalog(paired.helloOk.projects) ?? paired.environment.activeProjectId ?? null;
    paired.environment.lastConnectedAt = nowIso();
    paired.environment.lastGoodEndpoint = paired.endpoint;
    await this.envStore.saveEnvironment(paired.environment);
    await this.envStore.setSelectedEnvId(paired.environment.envId);
    this.selectedEnvId = paired.environment.envId;
    this.activeProjectId = paired.environment.activeProjectId ?? null;
    this.emitStatus();
    return paired.environment;
  }

  async pairWithAccountMachine(args: {
    machine: AdeAccountMachine;
    accessToken: string;
    deviceName: string;
    relayBaseUrls?: readonly string[];
  }): Promise<WebClientEnvironmentRecord> {
    const accessToken = args.accessToken.trim();
    const deviceName = args.deviceName.trim();
    const expectedHostDeviceId = args.machine.deviceId?.trim() ?? "";
    if (!args.machine.online) throw new AdeSyncError("That account machine is offline.", "machine_offline");
    if (!accessToken) throw new AdeSyncError("ADE account sign-in is required.", "account_signed_out");
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
    const existing = await this.envStore.findByHostDeviceId(expectedHostDeviceId);
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
    const dpop = await signDpopProof({
      privateKey: dpopKeys.privateKey,
      publicKeyX963Base64: dpopPublicKeyX963,
      deviceId: localDeviceId,
      secret: accessToken,
    });
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
      dpop,
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
          machineName: args.machine.name ?? helloOk.brain.deviceName,
          hostDeviceId: expectedHostDeviceId,
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
    paired.environment.activeProjectId = openProjectFromCatalog(paired.helloOk.projects)
      ?? paired.environment.activeProjectId
      ?? null;
    await this.envStore.saveEnvironment(paired.environment);
    await this.envStore.setSelectedEnvId(paired.environment.envId);
    this.selectedEnvId = paired.environment.envId;
    this.activeProjectId = paired.environment.activeProjectId ?? null;
    this.emitStatus();
    return paired.environment;
  }

  async connect(envId: string): Promise<void> {
    const environment = await this.envStore.getEnvironment(envId);
    if (!environment) throw new AdeSyncError(`Unknown ADE web-client environment: ${envId}`, "unknown_environment");
    this.selectedEnvId = envId;
    this.activeProjectId = environment.activeProjectId ?? null;
    this.currentCatalog = null;
    await this.envStore.setSelectedEnvId(envId);
    const endpoints = deriveBrowserSyncEndpoints({ environment });
    await this.connection.connect(environment, endpoints);
  }

  disconnect(): void {
    this.connection.disconnect({ reconnect: false });
    this.currentCatalog = null;
    this.rejectAllPending(new AdeSyncError("Disconnected from ADE machine.", "disconnected"));
    this.emitStatus();
  }

  async switchEnvironment(envId: string): Promise<void> {
    this.disconnect();
    await this.connect(envId);
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
    await this.envStore.removeEnvironment(envId);
    this.emitStatus();
  }

  getStatus(): AdeSyncClientStatus {
    return {
      ...this.connection.getStatus(),
      activeProjectId: this.activeProjectId,
      selectedEnvId: this.selectedEnvId,
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
    const commandId = uuid();
    const projectId = opts.projectId ?? this.activeProjectId;
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingCommand = {
        commandId,
        acked: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingCommands.delete(commandId);
          reject(new AdeSyncError("Timed out waiting for remote command result.", "timeout"));
        }, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      };
      this.pendingCommands.set(commandId, pending);
    });
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
    return await promise;
  }

  async requestFile<TAction extends SupportedFileAction>(
    action: TAction,
    args: FileArgsFor<TAction>,
    opts: FileRequestOptions = {},
  ): Promise<unknown> {
    const requestId = uuid();
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest<unknown> = {
        resolve,
        reject,
        timer: setTimeout(() => timeout(pending, this.pendingFiles, requestId), opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      };
      this.pendingFiles.set(requestId, pending);
    });
    this.connection.send({
      type: "file_request",
      requestId,
      projectId: opts.projectId ?? this.activeProjectId,
      payload: { action, args } as SyncFileRequest,
    });
    return await promise;
  }

  subscribeChat(sessionId: string, opts: Omit<SyncChatSubscribePayload, "sessionId" | "sinceSeq"> = {}, handlers: ChatHandlers = {}): () => void {
    if (this.streamSubscriptionsPaused) return () => undefined;
    const existing = this.chatSubscriptions.get(sessionId);
    const subscription: ChatSubscription = {
      payload: { ...opts, sessionId },
      handlers,
      sinceSeq: existing?.sinceSeq ?? null,
    };
    this.chatSubscriptions.set(sessionId, subscription);
    this.sendChatSubscribe(subscription);
    return () => this.unsubscribeChat(sessionId);
  }

  unsubscribeChat(sessionId: string): void {
    const subscription = this.chatSubscriptions.get(sessionId);
    this.chatSubscriptions.delete(sessionId);
    if (!subscription || !this.connection.isConnected()) return;
    this.connection.send({
      type: "chat_unsubscribe",
      projectId: subscription.payload.projectId ?? this.activeProjectId,
      payload: {
        sessionId,
        projectId: subscription.payload.projectId,
        projectRootPath: subscription.payload.projectRootPath,
      },
    });
  }

  subscribeTerminal(sessionId: string, opts: { maxBytes?: number } = {}, handlers: TerminalHandlers = {}): () => void {
    if (this.streamSubscriptionsPaused) return () => undefined;
    const existing = this.terminalSubscriptions.get(sessionId);
    const subscription: TerminalSubscription = {
      sessionId,
      maxBytes: opts.maxBytes,
      handlers,
      sinceOffset: existing?.sinceOffset ?? null,
    };
    this.terminalSubscriptions.set(sessionId, subscription);
    this.sendTerminalSubscribe(subscription);
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

  sendTerminalInput(sessionId: string, data: string): void {
    this.connection.send({
      type: "terminal_input",
      projectId: this.activeProjectId,
      payload: { sessionId, data },
    });
  }

  sendTerminalResize(sessionId: string, cols: number, rows: number): void {
    this.connection.send({
      type: "terminal_resize",
      projectId: this.activeProjectId,
      payload: { sessionId, cols, rows },
    });
  }

  async requestTerminalHistory(payload: SyncTerminalHistoryRequestPayload, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<SyncTerminalHistoryResponsePayload> {
    const requestId = uuid();
    const promise = new Promise<SyncTerminalHistoryResponsePayload>((resolve, reject) => {
      const pending: PendingRequest<SyncTerminalHistoryResponsePayload> = {
        resolve,
        reject,
        timer: setTimeout(() => timeout(pending, this.pendingTerminalHistory, requestId), timeoutMs),
      };
      this.pendingTerminalHistory.set(requestId, pending);
    });
    this.connection.send({
      type: "terminal_history",
      requestId,
      projectId: this.activeProjectId,
      payload,
    });
    return await promise;
  }

  async getProjectCatalog(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<SyncProjectCatalogPayload> {
    if (this.currentCatalog) return this.currentCatalog;
    const shouldSendRequest = this.pendingProjectCatalog.length === 0;
    const promise = new Promise<SyncProjectCatalogPayload>((resolve, reject) => {
      const pending: PendingRequest<SyncProjectCatalogPayload> = {
        resolve,
        reject,
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

  async switchProject(projectId: string): Promise<SyncProjectSwitchResultPayload> {
    const requestId = uuid();
    const promise = new Promise<SyncProjectSwitchResultPayload>((resolve, reject) => {
      const pending: PendingRequest<SyncProjectSwitchResultPayload> = {
        resolve,
        reject,
        timer: setTimeout(() => timeout(pending, this.pendingProjectSwitches, requestId), DEFAULT_REQUEST_TIMEOUT_MS),
      };
      this.pendingProjectSwitches.set(requestId, pending);
    });
    this.connection.send({
      type: "project_switch_request",
      requestId,
      payload: { projectId },
    });
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
        this.clearStreamSubscriptions();
        await this.persistCurrentEnvironment((environment) => ({
          ...environment,
          port: result.connection?.port ?? environment.port,
          addressCandidates: result.connection?.addressCandidates ?? environment.addressCandidates,
          hostIdentity: result.connection?.hostIdentity ?? environment.hostIdentity,
          activeProjectId: this.activeProjectId,
        }));
        if (envId) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await this.connect(envId);
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

  dispose(): void {
    this.disconnect();
    this.connection.dispose();
    for (const listeners of Object.values(this.listeners)) listeners.clear();
  }

  private handleEnvelope(envelope: SyncEnvelope): void {
    switch (envelope.type) {
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
    if (!pending) return;
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
    if (!pending) return;
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
    if (!pending) return;
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
    if (sessionId) {
      const subscription = this.chatSubscriptions.get(sessionId);
      if (subscription && typeof payload.seq === "number") {
        subscription.sinceSeq = Math.max(subscription.sinceSeq ?? 0, payload.seq);
      }
      subscription?.handlers.event?.(payload);
    }
    this.emit("chatEvent", payload);
  }

  private handleTerminalSnapshot(payload: SyncTerminalSnapshotPayload): void {
    const subscription = this.terminalSubscriptions.get(payload.sessionId);
    if (!subscription) return;
    if (typeof payload.endOffset === "number") subscription.sinceOffset = payload.endOffset;
    subscription.handlers.snapshot?.(payload);
  }

  private handleTerminalData(payload: SyncTerminalDataPayload): void {
    const subscription = this.terminalSubscriptions.get(payload.sessionId);
    if (!subscription) return;
    if (typeof payload.offset === "number") subscription.sinceOffset = payload.offset;
    subscription.handlers.data?.(payload);
  }

  private handleTerminalHistory(requestId: string | null, payload: SyncTerminalHistoryResponsePayload): void {
    if (!requestId) return;
    const pending = this.pendingTerminalHistory.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTerminalHistory.delete(requestId);
    pending.resolve(payload);
  }

  private handleProjectSwitchResult(requestId: string | null, payload: SyncProjectSwitchResultPayload): void {
    if (!requestId) return;
    const pending = this.pendingProjectSwitches.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingProjectSwitches.delete(requestId);
    if (payload.ok) pending.resolve(payload);
    else pending.reject(new AdeSyncError(payload.message ?? "Project switch failed.", "project_switch_failed", payload));
  }

  private sendChatSubscribe(subscription: ChatSubscription): void {
    if (!this.connection.isConnected()) return;
    this.connection.send({
      type: "chat_subscribe",
      projectId: subscription.payload.projectId ?? this.activeProjectId,
      payload: {
        ...subscription.payload,
        ...(subscription.sinceSeq != null ? { sinceSeq: subscription.sinceSeq } : {}),
      },
    });
  }

  private sendTerminalSubscribe(subscription: TerminalSubscription): void {
    if (!this.connection.isConnected()) return;
    this.connection.send({
      type: "terminal_subscribe",
      projectId: this.activeProjectId,
      payload: {
        sessionId: subscription.sessionId,
        ...(subscription.maxBytes ? { maxBytes: subscription.maxBytes } : {}),
        ...(subscription.sinceOffset != null ? { sinceOffset: subscription.sinceOffset } : {}),
      },
    });
  }

  private resubscribeStreams(): void {
    for (const subscription of this.chatSubscriptions.values()) this.sendChatSubscribe(subscription);
    for (const subscription of this.terminalSubscriptions.values()) this.sendTerminalSubscribe(subscription);
  }

  private clearStreamSubscriptions(): void {
    this.chatSubscriptions.clear();
    this.terminalSubscriptions.clear();
  }

  private resolveProjectCatalog(payload: SyncProjectCatalogPayload): void {
    const pending = this.pendingProjectCatalog.splice(0);
    for (const request of pending) {
      clearTimeout(request.timer);
      request.resolve(payload);
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
    for (const [requestId, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }
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

  private async persistCurrentEnvironment(
    update: (environment: WebClientEnvironmentRecord) => WebClientEnvironmentRecord,
  ): Promise<void> {
    if (!this.selectedEnvId) return;
    const current = await this.envStore.getEnvironment(this.selectedEnvId);
    if (!current) return;
    await this.envStore.saveEnvironment(update(current));
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
