import type { AdeRuntime, AdeRuntimeSyncOptions } from "../../bootstrap";
import type { SyncCommandPayload } from "../../../../desktop/src/shared/types";
import { ProjectRegistry, type ProjectId, type ProjectRecord } from "./projectRegistry";

export class ProjectScope {
  readonly registryProjectId: ProjectId;
  readonly record: ProjectRecord;
  readonly runtime: AdeRuntime;

  constructor(args: {
    registryProjectId: ProjectId;
    record: ProjectRecord;
    runtime: AdeRuntime;
  }) {
    this.registryProjectId = args.registryProjectId;
    this.record = args.record;
    this.runtime = args.runtime;
  }

  dispose(): void {
    this.runtime.dispose();
  }
}

export class ProjectScopeRegistry {
  private readonly scopes = new Map<ProjectId, Promise<ProjectScope>>();
  private readonly disposeListeners = new Set<(projectId: ProjectId) => void>();
  private syncHostProjectId: ProjectId | null = null;
  private readonly remoteCommandExecutor = {
    execute: async (payload: SyncCommandPayload): Promise<unknown> => {
      return await this.executeRemoteCommand(payload);
    },
  };

  constructor(
    private readonly projectRegistry: ProjectRegistry,
    private readonly options: {
      syncRuntime?: AdeRuntimeSyncOptions;
      runtimeCapabilities?: {
        memory?: boolean;
      };
      onDisposeProject?: (projectId: ProjectId) => void;
    } = {},
  ) {}

  onDispose(listener: (projectId: ProjectId) => void): () => void {
    this.disposeListeners.add(listener);
    return () => {
      this.disposeListeners.delete(listener);
    };
  }

  async get(projectId: ProjectId): Promise<ProjectScope> {
    const cached = this.scopes.get(projectId);
    if (cached) return await cached;

    const record = this.projectRegistry.get(projectId);
    if (!record) {
      throw new Error(`Unknown projectId: ${projectId}`);
    }

    const pending = (async () => {
      this.projectRegistry.touch(projectId);
      const syncRuntime = this.buildSyncRuntimeOptions(projectId);
      const { createAdeRuntime } = await import("../../bootstrap");
      const runtime = await createAdeRuntime({
        projectRoot: record.rootPath,
        workspaceRoot: record.rootPath,
        chatRuntime: "agent",
        capabilities: this.options.runtimeCapabilities,
        ...(syncRuntime ? { syncRuntime } : {}),
      });
      return new ProjectScope({
        registryProjectId: projectId,
        record,
        runtime,
      });
    })();
    this.scopes.set(projectId, pending);

    try {
      return await pending;
    } catch (error) {
      this.scopes.delete(projectId);
      if (this.syncHostProjectId === projectId) {
        this.syncHostProjectId = null;
      }
      throw error;
    }
  }

  async dispose(projectId: ProjectId): Promise<void> {
    const cached = this.scopes.get(projectId);
    if (!cached) return;
    this.scopes.delete(projectId);
    const scope = await cached.catch(() => null);
    scope?.dispose();
    if (this.syncHostProjectId === projectId) {
      this.syncHostProjectId = null;
    }
    this.options.onDisposeProject?.(projectId);
    for (const listener of this.disposeListeners) {
      listener(projectId);
    }
  }

  async disposeAll(): Promise<void> {
    const projectIds = [...this.scopes.keys()];
    await Promise.all(projectIds.map((projectId) => this.dispose(projectId)));
  }

  async ensureSyncHost(projectId?: ProjectId): Promise<ProjectScope | null> {
    if (!this.options.syncRuntime?.enabled) return null;
    if (projectId) {
      if (this.scopes.has(projectId) && this.syncHostProjectId !== projectId) {
        await this.dispose(projectId);
      }
      const existingHostId = this.syncHostProjectId;
      if (existingHostId && existingHostId !== projectId) {
        await this.dispose(existingHostId);
      }
      this.syncHostProjectId = projectId;
      return await this.get(projectId);
    }

    const existingHostId = this.syncHostProjectId;
    if (existingHostId) {
      try {
        return await this.get(existingHostId);
      } catch {
        this.syncHostProjectId = null;
      }
    }

    const record = this.projectRegistry
      .list()
      .slice()
      .sort((left, right) => {
        const openedDelta = right.lastOpenedAt - left.lastOpenedAt;
        return openedDelta !== 0 ? openedDelta : right.addedAt - left.addedAt;
      })[0];
    return record ? this.get(record.projectId) : null;
  }

  private buildSyncRuntimeOptions(projectId: ProjectId): AdeRuntimeSyncOptions | null {
    const base = this.options.syncRuntime;
    if (!base?.enabled) return null;
    const isHost = this.syncHostProjectId === null || this.syncHostProjectId === projectId;
    if (isHost && this.syncHostProjectId === null) {
      this.syncHostProjectId = projectId;
    }
    return {
      ...base,
      enabled: true,
      registryProjectId: projectId,
      initializeInBackground: true,
      hostStartupEnabled: isHost ? base.hostStartupEnabled ?? true : false,
      hostDiscoveryEnabled: isHost ? base.hostDiscoveryEnabled ?? true : false,
      remoteCommandExecutor: base.remoteCommandExecutor ?? this.remoteCommandExecutor,
    };
  }

  private async executeRemoteCommand(payload: SyncCommandPayload): Promise<unknown> {
    const projectId = typeof payload.projectId === "string" && payload.projectId.trim()
      ? payload.projectId.trim()
      : null;
    if (!projectId) {
      throw new Error(`Remote command ${payload.action} requires projectId.`);
    }
    const scope = await this.get(projectId);
    const syncService = scope.runtime.syncService;
    if (!syncService) {
      throw new Error(`Phone sync is not available for project ${projectId}.`);
    }
    return await syncService.executeRemoteCommand(payload);
  }
}
