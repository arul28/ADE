import type { AdeRuntime, AdeRuntimeSyncOptions } from "../../bootstrap";
import type { SyncCommandPayload } from "../../../../desktop/src/shared/types";
import { ProjectRegistry, type ProjectId, type ProjectRecord } from "./projectRegistry";

type SwitchSyncHostOptions = {
  deactivatePreviousHost?: boolean;
};

type PrewarmRecentScopesOptions = {
  excludeProjectId?: ProjectId | null;
  limit?: number;
};

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
  private syncHostTransitionDepth = 0;
  private syncHostTransitionTail: Promise<void> = Promise.resolve();
  private latestSyncHostTransitionId = 0;
  private prewarmStarted = false;
  private disposed = false;
  private readonly remoteCommandExecutor = {
    execute: async (payload: SyncCommandPayload): Promise<unknown> => {
      return await this.executeRemoteCommand(payload);
    },
  };

  constructor(
    private readonly projectRegistry: ProjectRegistry,
    private readonly options: {
      syncRuntime?: AdeRuntimeSyncOptions;
      onDisposeProject?: (projectId: ProjectId) => void;
    } = {},
  ) {}

  onDispose(listener: (projectId: ProjectId) => void): () => void {
    this.disposeListeners.add(listener);
    return () => {
      this.disposeListeners.delete(listener);
    };
  }

  /**
   * Non-booting lookup of an already-booted (or currently-booting) scope.
   * Returns the cached scope promise when one exists, or `null` when the
   * project has never been activated. Unlike `get()` this NEVER boots a scope,
   * so the all-projects roster can overlay live fidelity onto the projects that
   * happen to be running without spinning up a runtime for every project.
   */
  getIfBooted(projectId: ProjectId): Promise<ProjectScope> | null {
    return this.scopes.get(projectId) ?? null;
  }

  async get(
    projectId: ProjectId,
    options: { touch?: boolean } = {},
  ): Promise<ProjectScope> {
    const cached = this.scopes.get(projectId);
    if (cached) return await cached;

    const record = this.projectRegistry.get(projectId);
    if (!record) {
      throw new Error(`Unknown projectId: ${projectId}`);
    }

    const pending = (async () => {
      if (options.touch ?? true) {
        this.projectRegistry.touch(projectId);
      }
      const syncRuntime = this.buildSyncRuntimeOptions(
        projectId,
        this.syncHostProjectId === projectId,
      );
      const { createAdeRuntime } = await import("../../bootstrap");
      const runtime = await createAdeRuntime({
        projectRoot: record.rootPath,
        workspaceRoot: record.rootPath,
        chatRuntime: "agent",
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
    this.disposed = true;
    const projectIds = [...this.scopes.keys()];
    await Promise.all(projectIds.map((projectId) => this.dispose(projectId)));
  }

  /**
   * One-shot background warm-up for at most two MRU project scopes. Warming
   * never changes registry recency and never starts while a sync-host switch
   * is active; the active host is already warm and should be excluded by the
   * startup hook.
   */
  async prewarmRecentScopes(
    options: PrewarmRecentScopesOptions = {},
  ): Promise<ProjectId[]> {
    if (this.prewarmStarted || this.disposed || this.syncHostTransitionDepth > 0) {
      return [];
    }
    this.prewarmStarted = true;
    const limit = Math.min(2, Math.max(0, Math.trunc(options.limit ?? 2)));
    const candidates = this.projectRegistry
      .list()
      .filter((record) => record.catalogVisibility === "recent")
      .filter((record) => record.projectId !== options.excludeProjectId)
      .filter((record) => !this.scopes.has(record.projectId))
      .sort((left, right) => {
        const openedDelta = right.lastOpenedAt - left.lastOpenedAt;
        return openedDelta !== 0 ? openedDelta : right.addedAt - left.addedAt;
      })
      .slice(0, limit);

    const warmed: ProjectId[] = [];
    for (const record of candidates) {
      if (this.disposed || this.syncHostTransitionDepth > 0) break;
      try {
        await this.get(record.projectId, { touch: false });
        warmed.push(record.projectId);
      } catch {
        // Prewarming is opportunistic. A later real project open retries get()
        // normally and surfaces its own actionable error.
      }
    }
    return warmed;
  }

  async ensureSyncHost(
    projectId?: ProjectId,
    options?: SwitchSyncHostOptions,
  ): Promise<ProjectScope | null> {
    return projectId ? this.switchSyncHost(projectId, options) : this.resolveActiveSyncHost();
  }

  getActiveSyncHostProjectId(): ProjectId | null {
    return this.syncHostProjectId;
  }

  async resolveActiveSyncHost(): Promise<ProjectScope | null> {
    if (!this.options.syncRuntime?.enabled) return null;
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
    return record ? this.switchSyncHost(record.projectId) : null;
  }

  async switchSyncHost(
    projectId: ProjectId,
    options: SwitchSyncHostOptions = {},
  ): Promise<ProjectScope | null> {
    if (!this.options.syncRuntime?.enabled) return null;
    const transitionId = ++this.latestSyncHostTransitionId;
    this.syncHostTransitionDepth += 1;
    const work = this.syncHostTransitionTail.then(
      () => this.performSyncHostSwitch(projectId, options, transitionId),
      () => this.performSyncHostSwitch(projectId, options, transitionId),
    );
    this.syncHostTransitionTail = work.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await work;
    } finally {
      this.syncHostTransitionDepth = Math.max(0, this.syncHostTransitionDepth - 1);
    }
  }

  private async performSyncHostSwitch(
    projectId: ProjectId,
    options: SwitchSyncHostOptions,
    transitionId: number,
  ): Promise<ProjectScope> {
    const previousHostId = this.syncHostProjectId;
    const deactivatePreviousHost = options.deactivatePreviousHost ?? true;

    // Boot and initialize the target while the previous project remains the
    // authoritative host. get() sees syncHostProjectId still pointing at the
    // old host, so the new runtime starts with host startup/discovery disabled.
    const scope = await this.get(projectId);
    await scope.runtime.syncService?.initialize();

    // A newer queued selection superseded this one while its cold runtime was
    // booting. Keep the warm scope, but never flap the active listener/peers.
    if (transitionId !== this.latestSyncHostTransitionId) return scope;
    if (previousHostId === projectId) {
      await this.configureSyncHost(scope, true, { initialize: false });
      return scope;
    }

    let previousDeactivated = false;
    try {
      if (previousHostId && deactivatePreviousHost) {
        await this.configureCachedSyncHost(previousHostId, false);
        previousDeactivated = true;
      }
      this.syncHostProjectId = projectId;
      await this.configureSyncHost(scope, true, { initialize: false });
      return scope;
    } catch (error) {
      await this.configureSyncHost(scope, false).catch(() => {});
      this.syncHostProjectId = previousHostId;
      if (previousHostId && previousDeactivated) {
        try {
          const previousScope = await this.get(previousHostId);
          await this.configureSyncHost(previousScope, true);
        } catch {
          this.syncHostProjectId = null;
        }
      }
      throw error;
    }
  }

  async deactivateInactiveSyncHosts(activeProjectId: ProjectId | null = this.syncHostProjectId): Promise<void> {
    if (!activeProjectId) return;
    await Promise.all(
      [...this.scopes.keys()]
        .filter((projectId) => projectId !== activeProjectId)
        .map((projectId) => this.configureCachedSyncHost(projectId, false)),
    );
  }

  private async configureCachedSyncHost(
    projectId: ProjectId,
    enabled: boolean,
  ): Promise<void> {
    const cached = this.scopes.get(projectId);
    if (!cached) return;
    const scope = await cached.catch(() => null);
    if (scope) await this.configureSyncHost(scope, enabled);
  }

  private async configureSyncHost(
    scope: ProjectScope,
    enabled: boolean,
    options: { initialize?: boolean } = {},
  ): Promise<void> {
    const syncService = scope.runtime.syncService;
    if (!syncService) return;
    syncService.setHostDiscoveryEnabled?.(enabled);
    await syncService.setHostStartupEnabled?.(enabled);
    if (enabled && options.initialize !== false) await syncService.initialize();
  }

  private buildSyncRuntimeOptions(projectId: ProjectId, isHost: boolean): AdeRuntimeSyncOptions | null {
    const base = this.options.syncRuntime;
    if (!base?.enabled) return null;
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
