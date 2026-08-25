import type { AdeRuntime, AdeRuntimeSyncOptions } from "../../bootstrap";
import type { SyncCommandPayload } from "../../../../desktop/src/shared/types";
import type { SyncRemoteCommandExecutionContext } from "../sync/syncRemoteCommandService";
import type { ProjectId, ProjectRecord, ProjectRegistry } from "./projectRegistry";

type SwitchSyncHostOptions = {
  deactivatePreviousHost?: boolean;
};

const SYNC_HOST_COLD_BOOT_TIMEOUT_MS = 60_000;
const SYNC_HOST_INITIALIZE_TIMEOUT_MS = 30_000;
const SYNC_HOST_CONFIGURE_TIMEOUT_MS = 10_000;
/**
 * How long the brain waits for a sync-host switch that superseded its own to
 * land before it gives up and retries the whole resolution.
 */
export const SYNC_HOST_ADOPT_TIMEOUT_MS = 30_000;
const SYNC_HOST_ADOPT_POLL_MS = 250;

/**
 * Backoff after a failed project boot.
 *
 * A boot failure used to leave no trace beyond the deleted cache entry, so
 * every caller that asked for the project re-ran a full runtime construction:
 * one field machine did 41 full boots in 49 seconds, each one opening the
 * project database again. The delay is `BASE * 2 ** attempts`, so the first
 * retry waits two seconds and the fifth waits the capped thirty.
 */
const FAILED_SCOPE_BACKOFF_BASE_MS = 1_000;
export const FAILED_SCOPE_BACKOFF_MAX_MS = 30_000;

type FailedScopeBoot = {
  /** The failure itself, rethrown verbatim so callers keep their coded error. */
  error: unknown;
  /** When the boot failed. */
  atMs: number;
  /** How many boots have failed in a row. */
  attempts: number;
};

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
  private readonly failedScopes = new Map<ProjectId, FailedScopeBoot>();
  private readonly disposeListeners = new Set<(projectId: ProjectId) => void>();
  private syncHostProjectId: ProjectId | null = null;
  private syncHostTransitionTail: Promise<void> = Promise.resolve();
  private latestSyncHostTransitionId = 0;
  private latestSyncHostTransitionProjectId: ProjectId | null = null;
  private readonly remoteCommandExecutor = {
    execute: async (
      payload: SyncCommandPayload,
      context?: SyncRemoteCommandExecutionContext,
    ): Promise<unknown> => {
      return await this.executeRemoteCommand(payload, context);
    },
  };

  constructor(
    private readonly projectRegistry: ProjectRegistry,
    private readonly options: {
      syncRuntime?: AdeRuntimeSyncOptions;
      onDisposeProject?: (projectId: ProjectId) => void;
      /** Injectable clock for the failed-boot backoff. Tests only. */
      now?: () => number;
    } = {},
  ) {}

  private nowMs(): number {
    return (this.options.now ?? Date.now)();
  }

  private failedScopeBackoffMs(attempts: number): number {
    return Math.min(
      FAILED_SCOPE_BACKOFF_MAX_MS,
      FAILED_SCOPE_BACKOFF_BASE_MS * 2 ** attempts,
    );
  }

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

    // A project whose boot just failed is very likely to fail the same way
    // again, and a full boot is expensive: it opens the project database and
    // constructs every runtime service. Serve the recorded failure until the
    // backoff expires, so a room full of pollers costs one boot per window
    // instead of one boot per call. The entry survives the expired window so
    // repeated failures keep lengthening the backoff; only a success clears it.
    const failed = this.failedScopes.get(projectId);
    if (failed && this.nowMs() - failed.atMs < this.failedScopeBackoffMs(failed.attempts)) {
      throw failed.error;
    }

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
      const scope = await pending;
      // Only the attempt that still owns the cache entry may clear the
      // backoff; an abandoned boot that succeeds late must not wipe a backoff
      // a newer attempt earned.
      if (this.scopes.get(projectId) === pending) {
        this.failedScopes.delete(projectId);
      }
      return scope;
    } catch (error) {
      // A timed-out cold sync-host boot can be evicted and retried while the
      // original createAdeRuntime() promise is still settling. Never let that
      // stale completion delete a newer retry from the cache, clear a host that
      // the retry successfully promoted, or hold a newer retry off with a
      // backoff earned by the abandoned attempt.
      if (this.scopes.get(projectId) === pending) {
        this.scopes.delete(projectId);
        if (this.syncHostProjectId === projectId) {
          this.syncHostProjectId = null;
        }
        this.failedScopes.set(projectId, {
          error,
          atMs: this.nowMs(),
          attempts: (this.failedScopes.get(projectId)?.attempts ?? 0) + 1,
        });
      }
      throw error;
    }
  }

  async dispose(projectId: ProjectId): Promise<void> {
    // Disposing is how a repair asks for a clean slate, so it also drops the
    // failed-boot backoff: the next `get` must boot rather than replay the
    // failure the repair was meant to fix.
    this.failedScopes.delete(projectId);
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
    // Projects that only ever failed to boot hold no scope, so the loop above
    // never reaches them.
    this.failedScopes.clear();
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

  /**
   * The project a caller most recently asked to host sync, whether or not that
   * switch has completed. `switchSyncHost` returns null both for "superseded by
   * a newer switch" and for a genuinely absent host, and the brain's startup
   * loop must not read the former as "no project, host projectless".
   */
  getRequestedSyncHostProjectId(): ProjectId | null {
    return this.latestSyncHostTransitionProjectId;
  }

  /**
   * Waits for a sync-host switch that superseded ours to land, and adopts its
   * result.
   *
   * `switchSyncHost` returning null when a request is outstanding means
   * "superseded": the RPC socket is published before the brain's startup loop
   * runs, so a desktop that connected meanwhile may have requested its own
   * switch and bumped the transition past ours. That is a project host in
   * progress, not the absence of one — taking the projectless lease now would
   * clobber it. Returns null if nothing lands inside the budget, which the
   * caller retries.
   */
  async adoptRequestedSyncHost(
    timeoutMs: number,
    deps: { sleep?: (ms: number) => Promise<void>; now?: () => number; pollMs?: number } = {},
  ): Promise<ProjectScope | null> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep
      ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const pollMs = Math.max(1, deps.pollMs ?? SYNC_HOST_ADOPT_POLL_MS);
    const deadline = now() + Math.max(0, timeoutMs);
    while (now() < deadline) {
      const activeId = this.getActiveSyncHostProjectId();
      if (activeId) return await this.get(activeId);
      await sleep(pollMs);
    }
    return null;
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

  private async executeRemoteCommand(
    payload: SyncCommandPayload,
    context?: SyncRemoteCommandExecutionContext,
  ): Promise<unknown> {
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
    return await syncService.executeRemoteCommand(payload, context);
  }
}
