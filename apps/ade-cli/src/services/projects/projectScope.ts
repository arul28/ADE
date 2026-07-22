import type { AdeRuntime, AdeRuntimeSyncOptions } from "../../bootstrap";
import type { SyncCommandPayload } from "../../../../desktop/src/shared/types";
import type { ProjectId, ProjectRecord, ProjectRegistry } from "./projectRegistry";

type SwitchSyncHostOptions = {
  deactivatePreviousHost?: boolean;
};

const SYNC_HOST_COLD_BOOT_TIMEOUT_MS = 60_000;
const SYNC_HOST_INITIALIZE_TIMEOUT_MS = 30_000;
const SYNC_HOST_CONFIGURE_TIMEOUT_MS = 10_000;

class SyncHostPhaseTimeoutError extends Error {}

async function runSyncHostPhase<T>(
  phase: string,
  projectId: ProjectId,
  timeoutMs: number,
  operation: () => T | Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const work = Promise.resolve().then(operation);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SyncHostPhaseTimeoutError(
        `Sync host ${phase} for ${projectId} timed out after ${timeoutMs}ms.`,
      ));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  private syncHostTransitionTail: Promise<void> = Promise.resolve();
  private latestSyncHostTransitionId = 0;
  private latestSyncHostTransitionProjectId: ProjectId | null = null;
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
      // A timed-out cold sync-host boot can be evicted and retried while the
      // original createAdeRuntime() promise is still settling. Never let that
      // stale completion delete a newer retry from the cache or clear a host
      // that the retry successfully promoted.
      if (this.scopes.get(projectId) === pending) {
        this.scopes.delete(projectId);
        if (this.syncHostProjectId === projectId) {
          this.syncHostProjectId = null;
        }
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
    this.latestSyncHostTransitionProjectId = projectId;

    // Coalesce calls made in one turn before any cold runtime work begins.
    // Once booting has started it stays outside the authority-mutation tail,
    // so a slow obsolete target cannot delay a newer ready target.
    await Promise.resolve();
    if (transitionId !== this.latestSyncHostTransitionId) return null;

    const scopePromiseBeforeBoot = this.scopes.get(projectId) ?? null;
    const scopeOperation = this.get(projectId);
    const scopePromise = this.scopes.get(projectId) ?? scopePromiseBeforeBoot;
    let scope: ProjectScope;
    try {
      scope = await runSyncHostPhase(
        "cold boot",
        projectId,
        SYNC_HOST_COLD_BOOT_TIMEOUT_MS,
        () => scopeOperation,
      );
    } catch (error) {
      if (
        error instanceof SyncHostPhaseTimeoutError
        && !scopePromiseBeforeBoot
        && this.canAbandonTransitionScope(projectId, transitionId)
      ) {
        this.abandonTransitionScope(projectId, scopePromise);
      }
      throw error;
    }
    if (transitionId !== this.latestSyncHostTransitionId) return null;

    try {
      await runSyncHostPhase(
        "initialization",
        projectId,
        SYNC_HOST_INITIALIZE_TIMEOUT_MS,
        async () => await scope.runtime.syncService?.initialize(),
      );
    } catch (error) {
      if (
        error instanceof SyncHostPhaseTimeoutError
        && !scopePromiseBeforeBoot
        && this.canAbandonTransitionScope(projectId, transitionId)
      ) {
        this.abandonTransitionScope(projectId, scopePromise);
      }
      throw error;
    }
    if (transitionId !== this.latestSyncHostTransitionId) return null;

    const work = this.syncHostTransitionTail.then(
      () => transitionId === this.latestSyncHostTransitionId
        ? this.performSyncHostSwitch(scope, options, transitionId)
        : null,
      () => transitionId === this.latestSyncHostTransitionId
        ? this.performSyncHostSwitch(scope, options, transitionId)
        : null,
    );
    this.syncHostTransitionTail = work.then(
      () => undefined,
      () => undefined,
    );
    return await work;
  }

  private async performSyncHostSwitch(
    scope: ProjectScope,
    options: SwitchSyncHostOptions,
    transitionId: number,
  ): Promise<ProjectScope | null> {
    const projectId = scope.registryProjectId;
    const previousHostId = this.syncHostProjectId;
    const deactivatePreviousHost = options.deactivatePreviousHost ?? true;

    if (transitionId !== this.latestSyncHostTransitionId) return null;
    if (previousHostId === projectId) {
      await this.configureSyncHostWithTimeout(scope, true, "activation");
      return scope;
    }

    let previousDeactivationAttempted = false;
    let targetActivationAttempted = false;
    const rollback = async (): Promise<void> => {
      if (targetActivationAttempted) {
        await this.configureSyncHostWithTimeout(scope, false, "rollback deactivation")
          .catch(() => {});
      }
      if (previousHostId && previousDeactivationAttempted) {
        try {
          const previousScope = await this.getCachedScopeWithinTimeout(previousHostId);
          if (!previousScope) {
            this.syncHostProjectId = null;
            return;
          }
          await this.configureSyncHostWithTimeout(previousScope, true, "rollback restoration");
        } catch {
          this.syncHostProjectId = null;
        }
      }
    };

    try {
      if (previousHostId && deactivatePreviousHost) {
        previousDeactivationAttempted = true;
        const previousScope = await this.getCachedScopeWithinTimeout(previousHostId);
        if (previousScope) {
          await this.configureSyncHostWithTimeout(previousScope, false, "previous-host deactivation");
        }
      }
      if (transitionId !== this.latestSyncHostTransitionId) {
        await rollback();
        return null;
      }

      targetActivationAttempted = true;
      await this.configureSyncHostWithTimeout(scope, true, "activation");
      if (transitionId !== this.latestSyncHostTransitionId) {
        await rollback();
        return null;
      }

      // Publish authority only after the target has fully activated. Until
      // this assignment every failure/timeout still resolves to the old host.
      this.syncHostProjectId = projectId;
      return scope;
    } catch (error) {
      await rollback();
      throw error;
    }
  }

  private canAbandonTransitionScope(projectId: ProjectId, transitionId: number): boolean {
    return transitionId === this.latestSyncHostTransitionId
      || this.latestSyncHostTransitionProjectId !== projectId;
  }

  private abandonTransitionScope(
    projectId: ProjectId,
    pending: Promise<ProjectScope> | null,
  ): void {
    if (!pending || this.scopes.get(projectId) !== pending) return;
    this.scopes.delete(projectId);
    void pending.then(
      (scope) => scope.dispose(),
      () => undefined,
    );
  }

  private async getCachedScopeWithinTimeout(projectId: ProjectId): Promise<ProjectScope | null> {
    const cached = this.scopes.get(projectId);
    if (!cached) return null;
    return await runSyncHostPhase(
      "cached-scope lookup",
      projectId,
      SYNC_HOST_CONFIGURE_TIMEOUT_MS,
      () => cached,
    );
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
    const scope = await runSyncHostPhase(
      "cached-scope lookup",
      projectId,
      SYNC_HOST_CONFIGURE_TIMEOUT_MS,
      () => cached,
    ).catch(() => null);
    if (scope) {
      await this.configureSyncHostWithTimeout(
        scope,
        enabled,
        enabled ? "activation" : "deactivation",
      );
    }
  }

  private async configureSyncHostWithTimeout(
    scope: ProjectScope,
    enabled: boolean,
    phase: string,
  ): Promise<void> {
    await runSyncHostPhase(
      phase,
      scope.registryProjectId,
      SYNC_HOST_CONFIGURE_TIMEOUT_MS,
      () => this.configureSyncHost(scope, enabled, { initialize: false }),
    );
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
