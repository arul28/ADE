import type {
  AdeActionRegistryEntry,
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  RemoteRuntimeProjectWorkSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeConnectResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimePortForward,
  RemoteRuntimePortForwardRequest,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTrustSshHostKeyResult,
} from "../../../shared/types";
import { coerceProjects } from "./remoteBootstrap";
import type { RemoteConnectionPool } from "./remoteConnectionPool";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";
import {
  getSshHostKeyTrustForTarget,
  trustSshHostKeyForTarget,
} from "./sshTransport";

type StatusPatch = Partial<Omit<RemoteRuntimeConnectionStatus, "target">>;

type RemoteConnectionServiceOptions = {
  autoconnectIntervalMs?: number;
  pingTimeoutMs?: number;
};

type RemoteConnectionDisconnectOptions = {
  manual?: boolean;
};

type RemoteConnectionConnectOptions = {
  explicit?: boolean;
};

const AUTOMATIC_RECONNECT_FAILURE_LIMIT = 10;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function automaticReconnectStoppedMessage(): string {
  return `ADE stopped automatic reconnecting after ${AUTOMATIC_RECONNECT_FAILURE_LIMIT} failed attempts. Press Connect to try again.`;
}

function isImplicitConnectionFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return /remote (?:runtime|ADE service) connection (?:closed|failed|was interrupted)|remote ADE service connection failed recently|timed out waiting for method|stream closed|channel closed|connection lost|socket closed|ECONNRESET|ECONNABORTED|EPIPE|ENOTCONN|remote target is not connected|SSH server at .* closed the connection before ADE could finish the SSH handshake|Timed out while waiting for the SSH handshake/i.test(
    message,
  );
}

function isConnectionBackoffThrottle(error: unknown): boolean {
  return /^Remote ADE service connection failed recently\b/i.test(
    errorMessage(error),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function coerceConnectionProject(value: unknown): RemoteRuntimeProjectRecord {
  const project = coerceProjects([value])[0];
  if (!project)
    throw new Error("Remote ADE service did not return a project record.");
  return project;
}

function shouldAutoconnectTarget(target: RemoteRuntimeTarget): boolean {
  return target.lastConnectedAt != null && target.manuallyDisconnectedAt == null;
}

export class RemoteConnectionService {
  private readonly statusById = new Map<string, StatusPatch>();
  private readonly manuallyDisconnectedTargetIds = new Set<string>();
  private readonly automaticReconnectFailuresByTargetId = new Map<
    string,
    number
  >();
  private readonly automaticReconnectPausedTargetIds = new Set<string>();
  private readonly disconnectGenerationByTargetId = new Map<string, number>();
  private readonly listeners = new Set<
    (snapshot: RemoteRuntimeConnectionSnapshot) => void
  >();
  private autoconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: RemoteTargetRegistry,
    private readonly pool: RemoteConnectionPool,
    private readonly options: RemoteConnectionServiceOptions = {},
  ) {
    this.pool.onEntryEvicted((targetId, error) => {
      const current = this.statusById.get(targetId);
      if (current?.state !== "connected" && current?.state !== "connecting") {
        return;
      }
      this.mergeStatus(targetId, {
        state: "error",
        lastError: errorMessage(error),
        lastAttemptedAt: Date.now(),
      });
    });
  }

  listTargets(): RemoteRuntimeTarget[] {
    return this.registry.list();
  }

  getTarget(targetId: string): RemoteRuntimeTarget | null {
    return this.registry.get(targetId);
  }

  saveTarget(input: RemoteRuntimeTargetInput): RemoteRuntimeTarget {
    const target = this.registry.save(input);
    this.mergeStatus(target.id, { state: "idle", lastError: null });
    return target;
  }

  removeTarget(targetId: string): boolean {
    this.disconnect(targetId);
    this.manuallyDisconnectedTargetIds.delete(targetId);
    this.clearAutomaticReconnectBudget(targetId);
    this.statusById.delete(targetId);
    const removed = this.registry.remove(targetId);
    this.emit();
    return removed;
  }

  async getSshHostKeyTrust(
    targetId: string,
  ): Promise<RemoteRuntimeSshHostKeyTrustStatus> {
    return await getSshHostKeyTrustForTarget(this.requireTarget(targetId));
  }

  async trustSshHostKey(
    targetId: string,
    fingerprintSha256: string,
  ): Promise<RemoteRuntimeTrustSshHostKeyResult> {
    const fingerprint = fingerprintSha256.trim();
    if (!fingerprint) throw new Error("SSH host key fingerprint is required.");
    return await trustSshHostKeyForTarget(
      this.requireTarget(targetId),
      fingerprint,
    );
  }

  snapshot(): RemoteRuntimeConnectionSnapshot {
    const connections = this.registry
      .list()
      .map((target): RemoteRuntimeConnectionStatus => {
        const status = this.statusById.get(target.id) ?? {};
        return {
          target,
          state: status.state ?? (target.lastConnectedAt ? "idle" : "idle"),
          arch: status.arch ?? target.lastSeenArch,
          version: status.version ?? target.runtimeBinaryVersion,
          ...(status.capabilities ? { capabilities: status.capabilities } : {}),
          ...(status.compatibilityWarnings
            ? { compatibilityWarnings: status.compatibilityWarnings }
            : {}),
          projects: status.projects ?? [],
          lastError: status.lastError ?? null,
          lastAttemptedAt: status.lastAttemptedAt ?? null,
          connectedAt: status.connectedAt ?? target.lastConnectedAt,
        };
      });
    return {
      connections,
      connectedCount: connections.filter((entry) => entry.state === "connected")
        .length,
      updatedAt: Date.now(),
    };
  }

  onSnapshotChanged(
    listener: (snapshot: RemoteRuntimeConnectionSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startAutoconnect(): void {
    for (const target of this.registry.list()) {
      if (!shouldAutoconnectTarget(target)) continue;
      if (this.manuallyDisconnectedTargetIds.has(target.id)) continue;
      if (this.automaticReconnectPausedTargetIds.has(target.id)) continue;
      void this.connect(target.id).catch(() => {});
    }
    if (this.autoconnectTimer) return;
    this.autoconnectTimer = setInterval(() => {
      void this.maintainSavedConnections();
    }, this.options.autoconnectIntervalMs ?? 30_000);
    this.autoconnectTimer.unref?.();
  }

  stopAutoconnect(): void {
    if (!this.autoconnectTimer) return;
    clearInterval(this.autoconnectTimer);
    this.autoconnectTimer = null;
  }

  async connect(
    targetId: string,
    options: RemoteConnectionConnectOptions = {},
  ): Promise<RemoteRuntimeConnectResult> {
    const target = this.requireTarget(targetId);
    const explicit = options.explicit === true;
    if (explicit) {
      this.manuallyDisconnectedTargetIds.delete(target.id);
      this.clearAutomaticReconnectBudget(target.id);
    } else {
      this.assertImplicitReconnectAllowed(target.id);
    }
    const disconnectGeneration = this.getDisconnectGeneration(target.id);
    this.mergeStatus(target.id, {
      state: "connecting",
      lastAttemptedAt: Date.now(),
      lastError: null,
    });
    try {
      const result = explicit
        ? await this.pool.connect(target, { bypassFailureBackoff: true })
        : await this.pool.connect(target);
      if (!this.isDisconnectGenerationCurrent(target.id, disconnectGeneration)) {
        if (this.manuallyDisconnectedTargetIds.has(target.id)) {
          this.pool.disconnect(target.id);
        }
        throw new Error(
          "Remote target was disconnected before ADE finished connecting.",
        );
      }
      const connectedResult =
        explicit && result.target.manuallyDisconnectedAt != null
          ? {
              ...result,
              target: this.registry.update(result.target.id, {
                manuallyDisconnectedAt: null,
              }),
            }
          : result;
      this.mergeStatus(connectedResult.target.id, {
        state: "connected",
        arch: connectedResult.arch,
        version: connectedResult.version,
        capabilities: connectedResult.capabilities,
        compatibilityWarnings: connectedResult.compatibilityWarnings,
        projects: connectedResult.projects,
        connectedAt: connectedResult.target.lastConnectedAt ?? Date.now(),
        lastAttemptedAt: Date.now(),
        lastError: null,
      });
      this.clearAutomaticReconnectBudget(connectedResult.target.id);
      return connectedResult;
    } catch (error) {
      if (!this.isDisconnectGenerationCurrent(target.id, disconnectGeneration)) {
        throw error;
      }
      const lastError = explicit
        ? errorMessage(error)
        : this.recordImplicitFailure(target.id, error);
      this.mergeStatus(target.id, {
        state: "error",
        lastError,
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  disconnect(
    targetId: string,
    options: RemoteConnectionDisconnectOptions = {},
  ): void {
    let persistenceError: unknown = null;
    if (options.manual) {
      this.manuallyDisconnectedTargetIds.add(targetId);
      if (this.registry.get(targetId)) {
        try {
          this.registry.update(targetId, { manuallyDisconnectedAt: Date.now() });
        } catch (error) {
          persistenceError = error;
        }
      }
    }
    this.bumpDisconnectGeneration(targetId);
    this.pool.disconnect(targetId);
    this.mergeStatus(targetId, { state: "idle", lastError: null });
    if (persistenceError) {
      throw persistenceError;
    }
  }

  probeSavedConnections(): void {
    void this.maintainSavedConnections({
      pingTimeoutMs: this.options.pingTimeoutMs ?? 5_000,
    });
  }

  async projects(targetId: string): Promise<RemoteRuntimeProjectRecord[]> {
    const target = this.requireTargetForImplicitUse(targetId);
    try {
      const value = await this.pool.projectsForTarget(target);
      const projects = coerceProjects(value);
      this.mergeStatus(targetId, {
        state: "connected",
        projects,
        lastError: null,
      });
      this.clearAutomaticReconnectBudget(targetId);
      return projects;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async addProject(
    targetId: string,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectRecord> {
    const target = this.requireTargetForImplicitUse(targetId);
    try {
      const value = await this.pool.addProjectForTarget(target, rootPath);
      const project = coerceConnectionProject(value);
      this.upsertProject(targetId, project);
      this.clearAutomaticReconnectBudget(targetId);
      return project;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async ensurePortForward(
    targetId: string,
    request: RemoteRuntimePortForwardRequest,
  ): Promise<RemoteRuntimePortForward> {
    const target = this.requireTargetForImplicitUse(targetId);
    await this.connect(target.id);
    try {
      return await this.pool.ensureLocalPortForward(target.id, request);
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async browseDirectories(
    targetId: string,
    input: ProjectBrowseInput,
  ): Promise<ProjectBrowseResult> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.browseDirectories",
      asRecord(input),
    )) as ProjectBrowseResult;
  }

  async getProjectDetail(
    targetId: string,
    rootPath: string,
  ): Promise<ProjectDetail> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.getDetail",
      { rootPath },
    )) as ProjectDetail;
  }

  async getProjectWorkSummary(
    targetId: string,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectWorkSummary> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.getWorkSummary",
      { rootPath },
    )) as RemoteRuntimeProjectWorkSummary;
  }

  async getDefaultParentDir(targetId: string): Promise<string> {
    const value = await this.callMachine(
      this.requireTarget(targetId),
      "projects.getDefaultParentDir",
      {},
    );
    return typeof value === "string" && value.trim()
      ? value.trim()
      : "~/Projects";
  }

  async createProject(
    targetId: string,
    input: CreateProjectInput,
  ): Promise<RemoteRuntimeProjectRecord> {
    const value = await this.callMachine(
      this.requireTarget(targetId),
      "projects.create",
      asRecord(input),
      { retryOnConnectionError: false },
    );
    const project = coerceConnectionProject(value);
    this.upsertProject(targetId, project);
    return project;
  }

  async cloneProject(
    targetId: string,
    input: CloneProjectInput,
  ): Promise<RemoteRuntimeProjectRecord> {
    const value = await this.callMachine(
      this.requireTarget(targetId),
      "projects.clone",
      asRecord(input),
      { retryOnConnectionError: false },
    );
    const project = coerceConnectionProject(value);
    this.upsertProject(targetId, project);
    return project;
  }

  async listMyGitHubRepos(
    targetId: string,
    input: ListMyGitHubReposInput,
  ): Promise<ListMyGitHubReposResult> {
    return (await this.callMachine(
      this.requireTarget(targetId),
      "projects.listMyGitHubRepos",
      asRecord(input),
    )) as ListMyGitHubReposResult;
  }

  async callAction(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    const target = this.requireTargetForImplicitUse(targetId);
    try {
      const result = await this.pool.callActionForTarget(
        target,
        projectId,
        request,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return result;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async streamEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
  ): Promise<RemoteRuntimeStreamEventsResult> {
    const target = this.requireTargetForImplicitUse(targetId);
    try {
      const result = await this.pool.streamEventsForTarget(
        target,
        projectId,
        request,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return result;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async subscribeEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
    onEvent: (event: RemoteRuntimeBufferedEvent) => void,
    onEnded?: () => void,
  ): Promise<() => void> {
    const target = this.requireTargetForImplicitUse(targetId);
    try {
      const cleanup = await this.pool.subscribeEventsForTarget(
        target,
        projectId,
        request,
        onEvent,
        onEnded,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return cleanup;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async listActionRegistry(
    targetId: string,
    projectId: string,
  ): Promise<AdeActionRegistryEntry[]> {
    const target = this.requireTargetForImplicitUse(targetId);
    try {
      const registry = await this.pool.listActionRegistryForTarget(
        target,
        projectId,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return registry;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async callSync(
    targetId: string,
    projectId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const target = this.requireTargetForImplicitUse(targetId);
    try {
      const result = await this.pool.callSyncForTarget(
        target,
        projectId,
        method,
        params,
      );
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectBudget(targetId);
      return result;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: this.recordImplicitFailure(targetId, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  dispose(): void {
    this.stopAutoconnect();
    this.pool.dispose();
    this.listeners.clear();
  }

  private async maintainSavedConnections(
    options: { pingTimeoutMs?: number } = {},
  ): Promise<void> {
    for (const target of this.registry.list()) {
      if (!shouldAutoconnectTarget(target)) continue;
      if (this.manuallyDisconnectedTargetIds.has(target.id)) continue;
      if (this.automaticReconnectPausedTargetIds.has(target.id)) continue;
      const status = this.statusById.get(target.id);
      if (status?.state === "connecting") continue;
      if (status?.state === "connected") {
        try {
          await this.pool.callMachineForTarget(
            target,
            "ping",
            {},
            {
              timeoutMs: options.pingTimeoutMs,
            },
          );
          continue;
        } catch {
          this.pool.disconnect(target.id);
          this.mergeStatus(target.id, {
            state: "error",
            lastError: "Remote ADE service connection was interrupted.",
          });
        }
      }
      void this.connect(target.id).catch(() => {});
    }
  }

  private async callMachine(
    target: RemoteRuntimeTarget,
    method: string,
    params: Record<string, unknown>,
    options: { retryOnConnectionError?: boolean } = {},
  ): Promise<unknown> {
    this.assertImplicitReconnectAllowed(target.id);
    try {
      const result = await this.pool.callMachineForTarget(
        target,
        method,
        params,
        options,
      );
      const current = this.statusById.get(target.id);
      if (current?.state !== "connected") {
        this.mergeStatus(target.id, { state: "connected", lastError: null });
      }
      this.clearAutomaticReconnectBudget(target.id);
      return result;
    } catch (error) {
      this.mergeStatus(target.id, {
        state: "error",
        lastError: this.recordImplicitFailure(target.id, error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  private requireTarget(targetId: string): RemoteRuntimeTarget {
    const target = this.registry.get(targetId);
    if (!target) throw new Error("Remote target was not found.");
    return target;
  }

  private requireTargetForImplicitUse(targetId: string): RemoteRuntimeTarget {
    const target = this.requireTarget(targetId);
    this.assertImplicitReconnectAllowed(target.id);
    return target;
  }

  private assertImplicitReconnectAllowed(targetId: string): void {
    const target = this.registry.get(targetId);
    if (
      this.manuallyDisconnectedTargetIds.has(targetId) ||
      target?.manuallyDisconnectedAt != null
    ) {
      throw new Error(
        "Remote machine was manually disconnected. Connect again to use this remote project.",
      );
    }
    if (this.automaticReconnectPausedTargetIds.has(targetId)) {
      throw new Error(automaticReconnectStoppedMessage());
    }
  }

  private clearAutomaticReconnectBudget(targetId: string): void {
    this.automaticReconnectFailuresByTargetId.delete(targetId);
    this.automaticReconnectPausedTargetIds.delete(targetId);
  }

  private recordImplicitFailure(targetId: string, error: unknown): string {
    if (!isImplicitConnectionFailure(error)) return errorMessage(error);
    if (isConnectionBackoffThrottle(error)) return errorMessage(error);
    return this.noteAutomaticReconnectFailure(targetId, error);
  }

  private noteAutomaticReconnectFailure(
    targetId: string,
    error: unknown,
  ): string {
    if (this.automaticReconnectPausedTargetIds.has(targetId)) {
      return automaticReconnectStoppedMessage();
    }
    const failureCount =
      (this.automaticReconnectFailuresByTargetId.get(targetId) ?? 0) + 1;
    this.automaticReconnectFailuresByTargetId.set(targetId, failureCount);
    if (failureCount >= AUTOMATIC_RECONNECT_FAILURE_LIMIT) {
      this.automaticReconnectPausedTargetIds.add(targetId);
      return automaticReconnectStoppedMessage();
    }
    return errorMessage(error);
  }

  private upsertProject(
    targetId: string,
    project: RemoteRuntimeProjectRecord,
  ): void {
    const current = this.statusById.get(targetId);
    const projects = [
      project,
      ...(current?.projects ?? []).filter(
        (candidate) => candidate.projectId !== project.projectId,
      ),
    ];
    this.mergeStatus(targetId, {
      state: "connected",
      projects,
      lastError: null,
    });
  }

  private mergeStatus(targetId: string, patch: StatusPatch): void {
    const current = this.statusById.get(targetId) ?? {};
    this.statusById.set(targetId, {
      ...current,
      ...patch,
      state: (patch.state ??
        current.state ??
        "idle") as RemoteRuntimeConnectionState,
    });
    this.emit();
  }

  private getDisconnectGeneration(targetId: string): number {
    return this.disconnectGenerationByTargetId.get(targetId) ?? 0;
  }

  private bumpDisconnectGeneration(targetId: string): void {
    this.disconnectGenerationByTargetId.set(
      targetId,
      this.getDisconnectGeneration(targetId) + 1,
    );
  }

  private isDisconnectGenerationCurrent(
    targetId: string,
    generation: number,
  ): boolean {
    return this.getDisconnectGeneration(targetId) === generation;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }
}
