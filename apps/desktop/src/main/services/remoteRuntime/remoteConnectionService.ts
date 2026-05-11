import type {
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
  RemoteRuntimeProjectRecord,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
} from "../../../shared/types";
import { coerceProjects } from "./remoteBootstrap";
import type { RemoteConnectionPool } from "./remoteConnectionPool";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

type StatusPatch = Partial<Omit<RemoteRuntimeConnectionStatus, "target">>;

type RemoteConnectionServiceOptions = {
  autoconnectIntervalMs?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export class RemoteConnectionService {
  private readonly statusById = new Map<string, StatusPatch>();
  private readonly listeners = new Set<
    (snapshot: RemoteRuntimeConnectionSnapshot) => void
  >();
  private autoconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: RemoteTargetRegistry,
    private readonly pool: RemoteConnectionPool,
    private readonly options: RemoteConnectionServiceOptions = {},
  ) {}

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
    this.statusById.delete(targetId);
    const removed = this.registry.remove(targetId);
    this.emit();
    return removed;
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

  async connect(targetId: string): Promise<RemoteRuntimeConnectResult> {
    const target = this.requireTarget(targetId);
    this.mergeStatus(target.id, {
      state: "connecting",
      lastAttemptedAt: Date.now(),
      lastError: null,
    });
    try {
      const result = await this.pool.connect(target);
      this.mergeStatus(result.target.id, {
        state: "connected",
        arch: result.arch,
        version: result.version,
        projects: result.projects,
        connectedAt: result.target.lastConnectedAt ?? Date.now(),
        lastAttemptedAt: Date.now(),
        lastError: null,
      });
      return result;
    } catch (error) {
      this.mergeStatus(target.id, {
        state: "error",
        lastError: errorMessage(error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  disconnect(targetId: string): void {
    this.pool.disconnect(targetId);
    this.mergeStatus(targetId, { state: "idle", lastError: null });
  }

  async projects(targetId: string): Promise<RemoteRuntimeProjectRecord[]> {
    const target = this.requireTarget(targetId);
    try {
      const value = await this.pool.projectsForTarget(target);
      const projects = coerceProjects(value);
      this.mergeStatus(targetId, {
        state: "connected",
        projects,
        lastError: null,
      });
      return projects;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: errorMessage(error),
        lastAttemptedAt: Date.now(),
      });
      throw error;
    }
  }

  async addProject(
    targetId: string,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectRecord> {
    const target = this.requireTarget(targetId);
    try {
      const value = await this.pool.addProjectForTarget(target, rootPath);
      const project = coerceConnectionProject(value);
      this.upsertProject(targetId, project);
      return project;
    } catch (error) {
      this.mergeStatus(targetId, {
        state: "error",
        lastError: errorMessage(error),
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

  dispose(): void {
    this.stopAutoconnect();
    this.pool.dispose();
    this.listeners.clear();
  }

  private async maintainSavedConnections(): Promise<void> {
    for (const target of this.registry.list()) {
      const status = this.statusById.get(target.id);
      if (status?.state === "connecting") continue;
      if (status?.state === "connected") {
        try {
          await this.pool.callMachineForTarget(target, "ping", {});
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
      return result;
    } catch (error) {
      this.mergeStatus(target.id, {
        state: "error",
        lastError: errorMessage(error),
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

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }
}
