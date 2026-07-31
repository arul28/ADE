import type { AdeAccountMachine } from "../../../shared/types/account";
import type {
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeTarget,
} from "../../../shared/types";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { BrowserAccountClient } from "../account/client";
import {
  AdeSyncClient,
  type AdeSyncClientStatus,
  type WebClientEnvironmentRecord,
  type WebRelayAccess,
} from "../sync";

export const WEB_MACHINE_SESSION_LIMIT = 4;

export type WebMachineSessionState =
  | "live"
  | "reconnecting"
  | "parked"
  | "offline";

export type WebMachineSessionSnapshot = {
  targetId: string;
  environment: WebClientEnvironmentRecord;
  status: AdeSyncClientStatus;
  state: WebMachineSessionState;
  projects: SyncMobileProjectSummary[];
  lastUsedAt: number;
  activeProjectId: string | null;
  error: string | null;
};

export type WebMachineWorkspaceSnapshot = {
  sessions: WebMachineSessionSnapshot[];
  environments: WebClientEnvironmentRecord[];
  activeTargetId: string | null;
  updatedAt: number;
};

type SessionRecord = {
  targetId: string;
  environment: WebClientEnvironmentRecord;
  client: AdeSyncClient | null;
  lastStatus: AdeSyncClientStatus;
  projects: SyncMobileProjectSummary[];
  lastUsedAt: number;
  parked: boolean;
  disposers: Array<() => void>;
};

function connectionState(
  session: SessionRecord,
): WebMachineSessionState {
  if (session.parked) return "parked";
  const state = session.client?.getStatus().state ?? session.lastStatus.state;
  if (state === "connected") return "live";
  if (state === "connecting" || state === "reconnecting" || state === "restoring") {
    return "reconnecting";
  }
  return "offline";
}

function remoteTarget(environment: WebClientEnvironmentRecord): RemoteRuntimeTarget {
  return {
    id: environment.envId,
    name: environment.machineName,
    hostname:
      environment.hostIdentity?.name
      ?? environment.addressCandidates[0]?.host
      ?? environment.machineName,
    transport: "paired",
    pairedMachine: environment.hostDeviceId
      ? {
          hostIdentity: environment.hostDeviceId,
          machineKey: null,
        }
      : null,
    accountOwnerUserId: environment.accountOwnerUserId ?? null,
    sshUser: null,
    port: environment.port || null,
    sshKeyPath: null,
    routes: [],
    lastSeenArch: null,
    runtimeBinaryVersion: null,
    lastConnectedAt: environment.lastConnectedAt
      ? Date.parse(environment.lastConnectedAt)
      : null,
    autoConnect: false,
  };
}

function remoteProject(project: SyncMobileProjectSummary): RemoteRuntimeProjectRecord {
  const gitOriginUrl = project.repoOwner && project.repoName
    ? `https://github.com/${project.repoOwner}/${project.repoName}`
    : null;
  return {
    projectId: project.id,
    rootPath: project.rootPath ?? `remote:${project.id}`,
    displayName: project.displayName,
    addedAt: 0,
    lastOpenedAt: project.lastOpenedAt ? Date.parse(project.lastOpenedAt) || 0 : 0,
    gitOriginUrl,
    catalogVisibility: "recent",
    registrationSource: "runtime-auto",
    icon: project.iconDataUrl
      ? { dataUrl: project.iconDataUrl, sourcePath: null, mimeType: null }
      : null,
  };
}

export class WebMachineSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly environments = new Map<string, WebClientEnvironmentRecord>();
  private readonly listeners = new Set<(snapshot: WebMachineWorkspaceSnapshot) => void>();
  private activeTargetId: string | null = null;
  private relayAccess: WebRelayAccess = { kind: "signed_out" };
  private updatedAt = Date.now();
  private readonly allClients = new Set<AdeSyncClient>();
  private readonly availableClients: AdeSyncClient[] = [];
  private readonly authCleanupInFlight = new Set<string>();
  private readonly environmentConnects = new Map<string, Promise<WebMachineSessionSnapshot>>();
  private readonly accountMachineConnects = new Map<string, Promise<WebMachineSessionSnapshot>>();
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly primaryClient: AdeSyncClient,
    private readonly accountClient: BrowserAccountClient,
    private readonly clientFactory: () => AdeSyncClient = () => new AdeSyncClient(),
  ) {
    this.allClients.add(primaryClient);
    this.availableClients.push(primaryClient);
  }

  setRelayAccess(relayAccess: WebRelayAccess): void {
    this.relayAccess = relayAccess;
  }

  getRelayAccess(): WebRelayAccess {
    return this.relayAccess;
  }

  async refreshEnvironments(): Promise<WebClientEnvironmentRecord[]> {
    return await this.primaryClient.listEnvironments();
  }

  replaceEnvironments(environments: WebClientEnvironmentRecord[]): void {
    this.environments.clear();
    for (const environment of environments) {
      this.environments.set(environment.envId, environment);
      const existing = this.sessions.get(environment.envId);
      if (existing) existing.environment = environment;
    }
    for (const targetId of [...this.sessions.keys()]) {
      if (!this.environments.has(targetId)) this.disposeSession(targetId);
    }
    this.emit();
  }

  listEnvironments(): WebClientEnvironmentRecord[] {
    return [...this.environments.values()];
  }

  getSession(targetId: string): WebMachineSessionSnapshot | null {
    const session = this.sessions.get(targetId);
    return session ? this.snapshotSession(session) : null;
  }

  getClient(targetId: string): AdeSyncClient | null {
    return this.sessions.get(targetId)?.client ?? null;
  }

  getCatalog(targetId: string): SyncMobileProjectSummary[] {
    return this.sessions.get(targetId)?.projects.slice() ?? [];
  }

  getActiveTargetId(): string | null {
    return this.activeTargetId;
  }

  subscribe(listener: (snapshot: WebMachineWorkspaceSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): WebMachineWorkspaceSnapshot {
    return {
      sessions: [...this.sessions.values()]
        .map((session) => this.snapshotSession(session))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt),
      environments: this.listEnvironments(),
      activeTargetId: this.activeTargetId,
      updatedAt: this.updatedAt,
    };
  }

  getConnectionSnapshot(
    extraProjectsByTarget: ReadonlyMap<string, RemoteRuntimeProjectRecord[]> = new Map(),
  ): RemoteRuntimeConnectionSnapshot {
    const connections: RemoteRuntimeConnectionStatus[] = this.listEnvironments().map((environment) => {
      const session = this.sessions.get(environment.envId);
      const state = session ? connectionState(session) : "offline";
      const status = session?.client?.getStatus() ?? session?.lastStatus ?? null;
      const projects = session?.projects.map(remoteProject)
        ?? extraProjectsByTarget.get(environment.envId)
        ?? [];
      return {
        target: remoteTarget(environment),
        state:
          state === "live"
            ? "connected"
            : state === "reconnecting"
              ? "connecting"
              : state === "parked"
                ? "parked"
                : "idle",
        arch: null,
        version: null,
        route: status?.endpoint
          ? {
              kind: status.endpoint.startsWith("wss://") ? "relay" : "lan",
              endpoint: status.endpoint,
            }
          : undefined,
        capabilities: {
          projects: true,
          machineProjects: {},
        },
        projects,
        lastError: status?.error ?? null,
        lastAttemptedAt: session?.lastUsedAt ?? null,
        connectedAt: state === "live" ? session?.lastUsedAt ?? null : null,
      };
    });
    return {
      connections,
      connectedCount: connections.filter((entry) => entry.state === "connected").length,
      updatedAt: this.updatedAt,
    };
  }

  async connectEnvironment(targetId: string): Promise<WebMachineSessionSnapshot> {
    const inFlight = this.environmentConnects.get(targetId);
    if (inFlight) return await inFlight;
    const connecting = this.connectEnvironmentInternal(targetId);
    this.environmentConnects.set(targetId, connecting);
    try {
      return await connecting;
    } finally {
      if (this.environmentConnects.get(targetId) === connecting) {
        this.environmentConnects.delete(targetId);
      }
    }
  }

  private async connectEnvironmentInternal(targetId: string): Promise<WebMachineSessionSnapshot> {
    const environment = this.environments.get(targetId);
    if (!environment) throw new Error("That machine is no longer saved in this browser.");
    const session = await this.withAdmission(async () => {
      const existing = this.sessions.get(targetId);
      if (existing && connectionState(existing) === "live") {
        existing.parked = false;
        this.touch(existing);
        this.activeTargetId = targetId;
        this.emit();
        return existing;
      }
      await this.makeRoom(targetId);
      const admitted = existing ?? this.createSession(environment);
      if (!admitted.client) this.attachClient(admitted, this.takeClient());
      admitted.parked = false;
      this.touch(admitted);
      this.activeTargetId = targetId;
      this.emit();
      return admitted;
    });
    if (connectionState(session) === "live") return this.snapshotSession(session);
    const sessionClient = session.client;
    if (!sessionClient) throw new Error("No browser machine session is available.");
    try {
      await sessionClient.connect(environment.envId, this.relayAccess);
      session.projects = (await sessionClient.getProjectCatalog()).projects;
      session.lastStatus = sessionClient.getStatus();
    } catch (error) {
      session.lastStatus = sessionClient.getStatus();
      this.releaseClient(session);
      session.parked = false;
      if (this.activeTargetId === targetId) this.activeTargetId = null;
      this.emit();
      throw error;
    }
    this.touch(session);
    this.emit();
    return this.snapshotSession(session);
  }

  async connectAccountMachine(machine: AdeAccountMachine): Promise<WebMachineSessionSnapshot> {
    const inFlight = this.accountMachineConnects.get(machine.machineKey);
    if (inFlight) return await inFlight;
    const connecting = this.connectAccountMachineInternal(machine);
    this.accountMachineConnects.set(machine.machineKey, connecting);
    try {
      return await connecting;
    } finally {
      if (this.accountMachineConnects.get(machine.machineKey) === connecting) {
        this.accountMachineConnects.delete(machine.machineKey);
      }
    }
  }

  private async connectAccountMachineInternal(
    machine: AdeAccountMachine,
  ): Promise<WebMachineSessionSnapshot> {
    const existingEnvironment = this.listEnvironments().find(
      (environment) => environment.hostDeviceId === machine.deviceId,
    );
    if (existingEnvironment) return await this.connectEnvironment(existingEnvironment.envId);

    const client = await this.withAdmission(async () => {
      await this.makeRoom(null);
      return this.takeClient();
    });
    let pairedSession: SessionRecord | null = null;
    try {
      const accessToken = await this.accountClient.getAccessToken();
      const accountSessionLease = this.accountClient.captureSessionLease();
      if (!accountSessionLease) throw new Error("Sign in again to connect this machine.");
      const environment = await client.pairWithAccountMachine({
        machine,
        accessToken,
        accountSessionLease,
        isAccountSessionLeaseCurrent: (lease) => this.accountClient.isSessionLeaseCurrent(lease),
        deviceName: `ADE Web on ${window.location.hostname || "browser"}`,
        relayBaseUrls: this.accountClient.getRelayBaseUrls(),
        getRelayAccountToken: () => this.accountClient.getAccessToken(),
      });
      this.environments.set(environment.envId, environment);
      const session = this.createSession(environment, client);
      pairedSession = session;
      session.projects = (await client.getProjectCatalog()).projects;
      session.lastStatus = client.getStatus();
      this.activeTargetId = environment.envId;
      this.touch(session);
      this.emit();
      return this.snapshotSession(session);
    } catch (error) {
      if (pairedSession) {
        pairedSession.lastStatus = client.getStatus();
        this.releaseClient(pairedSession);
        pairedSession.parked = false;
        this.emit();
      } else {
        this.releaseUnusedClient(client);
      }
      throw error;
    }
  }

  async openProject(
    targetId: string,
    projectId: string,
  ): Promise<{ session: WebMachineSessionSnapshot; project: SyncMobileProjectSummary }> {
    let session = await this.connectEnvironment(targetId);
    let project = session.projects.find((entry) => entry.id === projectId) ?? null;
    if (!project) throw new Error("That project is no longer available on this machine.");
    if (session.activeProjectId !== projectId) {
      const record = this.sessions.get(targetId);
      const recordClient = record?.client;
      if (!record || !recordClient) throw new Error("The machine session was closed.");
      const result = await recordClient.switchProject(projectId);
      if (!result.ok) {
        throw new Error(result.message?.trim() || `Could not open ${project.displayName}.`);
      }
      record.projects = (await recordClient.getProjectCatalog()).projects;
      record.lastStatus = recordClient.getStatus();
      project = record.projects.find((entry) => entry.id === projectId) ?? project;
      this.touch(record);
      this.activeTargetId = targetId;
      this.emit();
      session = this.snapshotSession(record);
    }
    return { session, project };
  }

  async park(targetId: string): Promise<void> {
    const session = this.sessions.get(targetId);
    if (!session || session.parked) return;
    this.releaseClient(session);
    session.parked = true;
    if (this.activeTargetId === targetId) this.activeTargetId = null;
    this.emit();
  }

  async forgetEnvironment(targetId: string): Promise<void> {
    const session = this.sessions.get(targetId);
    const client = session?.client ?? this.primaryClient;
    await client.removeEnvironment(targetId);
    this.environments.delete(targetId);
    this.disposeSession(targetId);
    this.emit();
  }

  dispose(): void {
    for (const targetId of [...this.sessions.keys()]) this.disposeSession(targetId);
    for (const client of this.allClients) client.disconnect();
    this.availableClients.length = 0;
    this.allClients.clear();
    this.listeners.clear();
  }

  private createSession(
    environment: WebClientEnvironmentRecord,
    providedClient?: AdeSyncClient,
  ): SessionRecord {
    const client = providedClient ?? this.takeClient();
    const session: SessionRecord = {
      targetId: environment.envId,
      environment,
      client,
      lastStatus: client.getStatus(),
      projects: [],
      lastUsedAt: Date.now(),
      parked: false,
      disposers: [],
    };
    this.attachClient(session, client);
    this.sessions.set(environment.envId, session);
    return session;
  }

  private attachClient(session: SessionRecord, client: AdeSyncClient): void {
    session.client = client;
    session.lastStatus = client.getStatus();
    session.disposers.push(
      client.subscribe(() => {
        if (session.client !== client) return;
        session.lastStatus = client.getStatus();
        this.touch(session, false);
        this.emit();
        if (
          session.lastStatus.state === "auth_failed"
          && !this.authCleanupInFlight.has(session.targetId)
        ) {
          this.authCleanupInFlight.add(session.targetId);
          void this.forgetEnvironment(session.targetId)
            .catch(() => undefined)
            .finally(() => this.authCleanupInFlight.delete(session.targetId));
        }
      }),
      client.onProjectCatalog((payload) => {
        if (session.client !== client) return;
        session.projects = payload.projects;
        this.emit();
      }),
    );
  }

  private takeClient(): AdeSyncClient {
    const available = this.availableClients.pop();
    if (available) return available;
    if (this.allClients.size >= WEB_MACHINE_SESSION_LIMIT) {
      throw new Error("All four browser machine sessions are currently active.");
    }
    const client = this.clientFactory();
    this.allClients.add(client);
    return client;
  }

  private async makeRoom(nextTargetId: string | null): Promise<void> {
    const liveSessions = [...this.sessions.values()].filter(
      (session) => session.client !== null,
    );
    if (liveSessions.length < WEB_MACHINE_SESSION_LIMIT) return;
    const candidate = liveSessions
      .filter((session) => (
        session.targetId !== this.activeTargetId
        && session.targetId !== nextTargetId
        && !this.environmentConnects.has(session.targetId)
      ))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!candidate) throw new Error("All four machine sessions are currently active.");
    await this.park(candidate.targetId);
  }

  private async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private snapshotSession(session: SessionRecord): WebMachineSessionSnapshot {
    const status = session.client?.getStatus() ?? session.lastStatus;
    return {
      targetId: session.targetId,
      environment: session.environment,
      status,
      state: connectionState(session),
      projects: session.projects.slice(),
      lastUsedAt: session.lastUsedAt,
      activeProjectId: status.activeProjectId,
      error: status.error,
    };
  }

  private touch(session: SessionRecord, updateTime = true): void {
    if (updateTime) session.lastUsedAt = Date.now();
  }

  private disposeSession(targetId: string): void {
    const session = this.sessions.get(targetId);
    if (!session) return;
    this.releaseClient(session);
    this.sessions.delete(targetId);
    if (this.activeTargetId === targetId) this.activeTargetId = null;
  }

  private releaseClient(session: SessionRecord): void {
    const client = session.client;
    if (!client) return;
    session.lastStatus = client.getStatus();
    for (const dispose of session.disposers.splice(0)) dispose();
    session.client = null;
    this.releaseUnusedClient(client);
  }

  private releaseUnusedClient(client: AdeSyncClient): void {
    client.disconnect();
    if (!this.availableClients.includes(client)) this.availableClients.push(client);
  }

  private emit(): void {
    this.updatedAt = Date.now();
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
