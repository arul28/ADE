import type { CrossMachineHandoffTransport } from "../../../../desktop/src/main/services/chat/crossMachineHandoffOrchestrator";
import type { AdeRuntime, AdeRuntimeSyncOptions } from "../../bootstrap";
import type { SyncCommandPayload, SyncFileRequest } from "../../../../desktop/src/shared/types";
import type { SyncRemoteCommandExecutionContext } from "../sync/syncRemoteCommandService";
import type { SyncHostBlocker } from "../sync/syncService";
import type { BrainKeepAwakeService } from "../power/brainKeepAwakeService";
import type { ProjectId, ProjectRecord, ProjectRegistry } from "./projectRegistry";
import { captureProblem } from "../../../../desktop/src/shared/sentry/capture";
import { DIAGNOSTIC_ATTACH_TAG } from "../../../../desktop/src/shared/sentry/diagnostics";
import { createReportOnce, PROJECT_REGISTRY_ATTACH, wasRemovedFromRegistry } from "./projectRegistryJournal";

type SwitchSyncHostOptions = {
  deactivatePreviousHost?: boolean;
  /**
   * What the caller is asking this machine to do with the project.
   *
   * `"host"` (the default) is "make this project the sync host here". A project
   * that follows another machine cannot do that, so the switch is refused with
   * {@link SyncHostRoleBlockedError} before any drain is paid.
   *
   * `"serve"` is "hand me the scope that owns sync here" — status, roster and
   * document reads. A project that follows another machine already owns sync
   * here, as a viewer, and a laptop following a desktop is a supported,
   * working configuration; refusing it would break reads that work today. So
   * it is adopted as-is: nothing is refused and no host is brought up for it,
   * because there is no host to bring up.
   */
  purpose?: "host" | "serve";
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

type FailedAttempt = {
  /** The failure itself, rethrown verbatim so callers keep their coded error. */
  error: unknown;
  /** When the attempt failed. */
  atMs: number;
  /** How many attempts have failed in a row. */
  attempts: number;
};

/**
 * The sync-host phases whose failure is remembered and replayed for a backoff
 * window, keyed by project and phase.
 *
 * `activation` is the phase every sync-host caller re-enters, and its budget is
 * the whole shared role-refresh drain (host bring-up, listener validation and a
 * full status snapshot). On 2026-10-16 a brain whose project could not activate
 * re-ran that drain for every roster, lane-list and status poll: 48 attempts
 * over an hour, each one paying a 10-second activation timeout AND the rollback
 * that undid it. `initialization` can await the same drain for a host scope,
 * so it times out the same way (one such timeout is in the same log). A
 * `serve` lookup of a viewer skips this explicit phase; cold runtime creation
 * still initializes sync in the background.
 *
 * The corrective phases are deliberately NOT backed off. The two rollbacks, the
 * previous-host deactivation and `deactivation` exist to put state back, so a
 * replay must never stand in for one. They are rate-limited by this set instead:
 * `performSyncHostSwitch` consults the target's activation before it touches the
 * previous host, so a replay never reaches a rollback at all. `cold boot` is not
 * backed off either: `get()` owns that failure keyed by project alone.
 */
const BACKOFF_SYNC_HOST_PHASES = new Set(["initialization", "activation"]);

class SyncHostPhaseTimeoutError extends Error {}

/** One key space for the phase backoff, so the separator has a single home. */
function syncHostPhaseKey(projectId: ProjectId, phase: string): string {
  return `${projectId}\u0000${phase}`;
}

/** What a client is told when it asks to open a project that follows another machine. */
export function describeSyncHostBlocker(blocker: SyncHostBlocker): string {
  const target = blocker.host
    ? ` at ${blocker.host}${blocker.port != null ? `:${blocker.port}` : ""}`
    : "";
  return `This project is set to follow another ADE machine${target}, so this machine cannot open it for sync. Open it on that machine, or stop following it on this computer: in Connections, under This computer, choose Stop following.`;
}

/** The target project follows another machine, so this machine cannot host it. */
export class SyncHostRoleBlockedError extends Error {
  constructor(blocker: SyncHostBlocker) {
    super(describeSyncHostBlocker(blocker));
    this.name = "SyncHostRoleBlockedError";
  }
}

/** Null when enabling the target's host makes this machine its sync host. */
export function getSyncHostBlocker(scope: ProjectScope): SyncHostBlocker | null {
  return scope.runtime.syncService?.getHostBlocker?.() ?? null;
}

async function runSyncHostPhaseWithTimeout<T>(
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
  private readonly readyScopes = new Map<ProjectId, ProjectScope>();
  private readonly failedScopes = new Map<ProjectId, FailedAttempt>();
  /**
   * Failed sync-host phases, keyed by {@link syncHostPhaseKey}. Same shape and
   * same windows as {@link failedScopes}: a phase that just failed is very
   * likely to fail the same way again, and here it is not merely expensive but
   * self-defeating, because the retry's rollback tears down whatever the
   * previous attempt had started.
   */
  private readonly failedSyncHostPhases = new Map<string, FailedAttempt>();
  private readonly disposeListeners = new Set<(projectId: ProjectId) => void>();
  private readonly reportUnknownProjectIdOnce = createReportOnce();
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
    releaseStreamConnection: (connectionId: string): void => {
      this.releaseStreamConnection(connectionId);
    },
    executeFileRequest: async (
      projectId: string,
      payload: SyncFileRequest,
      context: { isMobile: boolean },
    ): Promise<unknown> => {
      const scope = await this.get(projectId);
      const syncService = scope.runtime.syncService;
      if (!syncService) {
        throw new Error(`Phone sync is not available for project ${projectId}.`);
      }
      return await syncService.executeRemoteFileRequest(payload, context);
    },
  };

  constructor(
    private readonly projectRegistry: ProjectRegistry,
    private readonly options: {
      syncRuntime?: AdeRuntimeSyncOptions;
      /** Socket endpoint shared by every project scope in this brain. */
      runtimeSocketPath?: string | null;
      /**
       * How each project's chat service moves a chat to another machine. One
       * per brain (it owns the agents' paired connections); late-bound because
       * the bridge is built after this registry.
       */
      crossMachineHandoffTransport?: () => CrossMachineHandoffTransport | null;
      /** One machine service shared by all scopes hosted by this brain. */
      keepAwakeService?: BrainKeepAwakeService | null;
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

  /**
   * The recorded failure a backoff is still holding, or null when the attempt
   * may run. Entries outlive their window so repeated failures keep lengthening
   * the backoff; only a success clears one.
   */
  private heldBackoff(failed: FailedAttempt | undefined): FailedAttempt | null {
    if (!failed) return null;
    return this.nowMs() - failed.atMs < this.failedScopeBackoffMs(failed.attempts)
      ? failed
      : null;
  }

  /** Record one more consecutive failure for a key, lengthening its window. */
  private recordFailure<T>(map: Map<T, FailedAttempt>, key: T, error: unknown): void {
    map.set(key, {
      error,
      atMs: this.nowMs(),
      attempts: (map.get(key)?.attempts ?? 0) + 1,
    });
  }

  /** The failure a backed-off phase is holding for this project, or null. */
  private heldSyncHostPhase(projectId: ProjectId, phase: string): FailedAttempt | null {
    if (!BACKOFF_SYNC_HOST_PHASES.has(phase)) return null;
    return this.heldBackoff(this.failedSyncHostPhases.get(syncHostPhaseKey(projectId, phase)));
  }

  /**
   * Forget the recorded sync-host phase failures, for one project or for all.
   *
   * Called for a user requested repair: "Fix connection", "Start sync" and
   * "Reconnect this computer" must re-run activation rather than be served
   * the failure the backoff is still holding. The periodic startup retry keeps
   * the backoff intact so it cannot turn into a tight retry loop.
   */
  clearSyncHostPhaseBackoff(projectId?: ProjectId): void {
    if (!projectId) {
      this.failedSyncHostPhases.clear();
      return;
    }
    // The map's key space is exactly this project's backed-off phases, so there
    // is nothing to scan for.
    for (const phase of BACKOFF_SYNC_HOST_PHASES) {
      this.failedSyncHostPhases.delete(syncHostPhaseKey(projectId, phase));
    }
  }

  /**
   * One sync-host phase, with the failed-boot backoff applied to the phases
   * that a repeated caller re-enters (see {@link BACKOFF_SYNC_HOST_PHASES}).
   *
   * The work itself is not cancelled and not retried here — the caller still
   * gets the recorded failure, verbatim, exactly as a failed cold boot gives it
   * — so a phase that is still running in the background keeps its chance to
   * finish and be picked up by the next real attempt. Rethrowing verbatim, and
   * not invoking the operation at all, is what lets the caller keep the coded
   * error (`code`, `errno`, `path`) its own error handling keys on.
   */
  private async runSyncHostPhase<T>(
    phase: string,
    projectId: ProjectId,
    timeoutMs: number,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const phaseKey = syncHostPhaseKey(projectId, phase);
    const backedOff = BACKOFF_SYNC_HOST_PHASES.has(phase);
    if (backedOff) {
      const held = this.heldSyncHostPhase(projectId, phase);
      if (held) throw held.error;
    }
    try {
      const value = await runSyncHostPhaseWithTimeout(phase, projectId, timeoutMs, operation);
      if (backedOff) {
        this.failedSyncHostPhases.delete(phaseKey);
        // An activated scope is hosting again, so every failure recorded for
        // this project describes a host that no longer exists.
        if (phase === "activation") this.clearSyncHostPhaseBackoff(projectId);
      }
      return value;
    } catch (error) {
      if (backedOff) this.recordFailure(this.failedSyncHostPhases, phaseKey, error);
      throw error;
    }
  }

  /**
   * The brain's own report when a caller names a project it does not have.
   * The caller (a window, a phone) reports only "the brain said no"; this one
   * says what the brain knew at that moment, with the project list and its
   * journal attached. Once per id per process: every poll after the first
   * adds nothing. A project the user removed is not a failure: a window or
   * phone that still holds its id is told so and moves on.
   */
  private reportUnknownProjectId(projectId: ProjectId): void {
    if (!this.reportUnknownProjectIdOnce(projectId)) return;
    try {
      if (wasRemovedFromRegistry(this.projectRegistry.path, projectId)) return;
      const registered = this.projectRegistry.list();
      captureProblem("The brain was asked for a project that is not in its project list", {
        fingerprint: ["brain", "project_id_unknown"],
        tags: { [DIAGNOSTIC_ATTACH_TAG]: PROJECT_REGISTRY_ATTACH },
        extra: {
          projectId,
          // This machine opened the project's database before, so the
          // project was registered here once and has since gone from the list.
          openedHereBefore: this.projectRegistry.readDatabaseIdentity(projectId) !== null,
          registeredCount: registered.length,
          registered: registered.map((record) => ({ projectId: record.projectId, rootPath: record.rootPath })),
          bootedScopes: [...this.scopes.keys()],
          syncHostProjectId: this.syncHostProjectId,
          brainUptimeSec: Math.round(process.uptime()),
        },
      });
    } catch {
      // Reporting must never change the answer.
    }
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

  /** What a brain report says about this brain's projects (`brain_state` context). */
  diagnosticSnapshot(): Record<string, unknown> {
    return {
      registeredProjects: this.projectRegistry.list().length,
      bootingOrBootedScopes: this.scopes.size,
      readyScopes: [...this.readyScopes.keys()],
      failedScopes: [...this.failedScopes.keys()],
      syncHostProjectId: this.syncHostProjectId,
    };
  }

  /** Return only a scope whose boot has already completed. */
  getIfReady(projectId: ProjectId): ProjectScope | null {
    return this.readyScopes.get(projectId) ?? null;
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
    // instead of one boot per call.
    const held = this.heldBackoff(this.failedScopes.get(projectId));
    if (held) throw held.error;

    const record = this.projectRegistry.get(projectId);
    if (!record) {
      // A project's id is a hash of its folder, so a move gives it a new one.
      // A window, phone or link that still holds the old id is sent on to the
      // project it now names instead of being told the project is unknown.
      const movedTo = this.projectRegistry.resolveMovedProjectId(projectId);
      if (movedTo && movedTo !== projectId) return await this.get(movedTo, options);
      this.reportUnknownProjectId(projectId);
      throw new Error(`Unknown projectId: ${projectId}`);
    }

    this.projectRegistry.assertProjectDataAvailable(record);
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
        ...(this.options.runtimeSocketPath ? { runtimeSocketPath: this.options.runtimeSocketPath } : {}),
        ...(syncRuntime ? { syncRuntime } : {}),
        ...(this.options.crossMachineHandoffTransport
          ? { crossMachineHandoffTransport: this.options.crossMachineHandoffTransport }
          : {}),
        ...(this.options.keepAwakeService
          ? { keepAwakeService: this.options.keepAwakeService }
          : {}),
      });
      try {
        this.projectRegistry.recordDatabaseIdentity(projectId);
      } catch (error) {
        runtime.dispose();
        throw error;
      }
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
        this.readyScopes.set(projectId, scope);
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
        this.readyScopes.delete(projectId);
        if (this.syncHostProjectId === projectId) {
          this.syncHostProjectId = null;
        }
        this.recordFailure(this.failedScopes, projectId, error);
      }
      throw error;
    }
  }

  async dispose(projectId: ProjectId): Promise<void> {
    // Disposing is how a repair asks for a clean slate, so it also drops the
    // failed-boot backoff: the next `get` must boot rather than replay the
    // failure the repair was meant to fix. The sync-host phases go with it, for
    // the same reason: a repair that drops the scope must also re-run the
    // activation this project failed.
    this.failedScopes.delete(projectId);
    this.clearSyncHostPhaseBackoff(projectId);
    const cached = this.scopes.get(projectId);
    if (!cached) return;
    this.scopes.delete(projectId);
    this.readyScopes.delete(projectId);
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
    this.clearSyncHostPhaseBackoff();
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

  /** Most recently failed sync-host activation/initialization still in backoff. */
  getMostRecentFailingSyncHostProjectId(): ProjectId | null {
    let latest: { projectId: ProjectId; atMs: number } | null = null;
    for (const [key, failure] of this.failedSyncHostPhases) {
      if (!this.heldBackoff(failure)) continue;
      const separator = key.indexOf("\u0000");
      if (separator < 0) continue;
      const projectId = key.slice(0, separator);
      if (!latest || failure.atMs > latest.atMs) latest = { projectId, atMs: failure.atMs };
    }
    return latest?.projectId ?? null;
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

  /**
   * @param onSkippedMissingProject told about each recent project passed over
   *   because its folder or ADE data is gone, so the caller can say why.
   */
  async resolveActiveSyncHost(
    onSkippedMissingProject?: (record: ProjectRecord) => void,
  ): Promise<ProjectScope | null> {
    if (!this.options.syncRuntime?.enabled) return null;
    const existingHostId = this.syncHostProjectId;
    if (existingHostId) {
      try {
        return await this.get(existingHostId);
      } catch {
        this.syncHostProjectId = null;
      }
    }

    // The newest project whose folder is still there. A scratch project in a
    // folder a restart wiped (/tmp) used to be retried forever here, and phones
    // and other machines had no sync until some other project happened to open.
    // With none left, the caller hosts machine-level sync without a project.
    const record = this.projectRegistry
      .list()
      .slice()
      .sort((left, right) => {
        const openedDelta = right.lastOpenedAt - left.lastOpenedAt;
        return openedDelta !== 0 ? openedDelta : right.addedAt - left.addedAt;
      })
      .find((candidate) => {
        if (!this.projectRegistry.isProjectDataMissing(candidate)) return true;
        onSkippedMissingProject?.(candidate);
        return false;
      });
    // This caller reads: it wants whatever owns sync on this machine, and a
    // project that follows another machine is a legitimate answer to that.
    return record ? this.switchSyncHost(record.projectId, { purpose: "serve" }) : null;
  }

  /** Return a cached sync scope without booting it or running host activation. */
  async resolveBootedSyncScope(): Promise<ProjectScope | null> {
    if (!this.options.syncRuntime?.enabled) return null;
    const preferredIds = [
      this.syncHostProjectId,
      ...this.projectRegistry.list()
        .slice()
        .sort((left, right) => {
          const openedDelta = right.lastOpenedAt - left.lastOpenedAt;
          return openedDelta !== 0 ? openedDelta : right.addedAt - left.addedAt;
        })
        .map((record) => record.projectId),
    ];
    for (const projectId of new Set(preferredIds)) {
      if (!projectId) continue;
      const cached = this.getIfBooted(projectId);
      if (cached) return await cached;
    }
    return null;
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
      scope = await this.runSyncHostPhase(
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

    // Read once, here: the scope is in hand and nothing has dialed yet, because
    // host initialization and activation below await the same role-refresh
    // drain. For a project that follows another machine that drain DIALS the
    // other machine. That dial is bounded to 5s (`VIEWER_CONNECT_TIMEOUT_MS` in
    // syncPeerService.ts), but it was not always: an unanswered connect ran to
    // the macOS SYN timeout (75s), which is why a brain retried one project 670
    // times over 18 hours and every attempt was reported as "Sync host
    // activation ... timed out after 10000ms": the drain's budget, never the
    // reason. `getHostBlocker()` mirrors the decision the drain would make
    // without dialing anything, so the answer costs nothing and arrives before
    // the wait.
    //
    // Checked before the previous host is touched: deactivating it releases the
    // machine-wide sync lease, so refusing here leaves the current host, its
    // lease, and every connected client as they were.
    const blocker = getSyncHostBlocker(scope);
    if (blocker && options.purpose !== "serve") {
      throw new SyncHostRoleBlockedError(blocker);
    }

    try {
      // Cold runtime creation starts sync initialization in the background.
      // Avoid invoking the same unbounded peer dial again in this explicit
      // phase; the background initialization may still be in flight.
      if (!(blocker && options.purpose === "serve")) {
        await this.runSyncHostPhase(
          "initialization",
          projectId,
          SYNC_HOST_INITIALIZE_TIMEOUT_MS,
          async () => await scope.runtime.syncService?.initialize(),
        );
      }
    } catch (error) {
      if (
        error instanceof SyncHostPhaseTimeoutError
        && !scopePromiseBeforeBoot
        && this.canAbandonTransitionScope(projectId, transitionId)
      ) {
        this.abandonTransitionScope(projectId, scopePromise);
      }
      // A superseded transition reports "superseded" (null), never a failure:
      // that is what tells the caller to adopt the winner instead of retrying.
      // A real initialization run lasts long enough for the check after the
      // phase to see the newer transition, but a backed-off one is refused
      // instantly, so it has to ask the same question before it reports.
      if (transitionId !== this.latestSyncHostTransitionId) return null;
      throw error;
    }
    if (transitionId !== this.latestSyncHostTransitionId) return null;

    const work = this.syncHostTransitionTail.then(
      () => transitionId === this.latestSyncHostTransitionId
        ? this.performSyncHostSwitch(scope, options, transitionId, blocker)
        : null,
      () => transitionId === this.latestSyncHostTransitionId
        ? this.performSyncHostSwitch(scope, options, transitionId, blocker)
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
    // Why this project follows another machine, or null when it can host here.
    // {@link switchSyncHost} read it before either phase, so that the drain is
    // never paid to find out.
    blocker: SyncHostBlocker | null,
  ): Promise<ProjectScope | null> {
    const projectId = scope.registryProjectId;
    const previousHostId = this.syncHostProjectId;
    const deactivatePreviousHost = options.deactivatePreviousHost ?? true;

    if (transitionId !== this.latestSyncHostTransitionId) return null;
    if (previousHostId === projectId) {
      if (blocker && options.purpose === "serve") return scope;
      // Re-activating the project that already hosts. Both `setHostDiscovery-
      // Enabled(true)` and `setHostStartupEnabled(true)` return at once when
      // their flag is already set — which it is for the active host — so this
      // pays no drain. (The rollback paths below call
      // `configureSyncHostWithTimeout` directly, never through here.)
      await this.configureSyncHostWithTimeout(scope, true, "activation");
      return scope;
    }
    // Consulted before the previous host is touched, for the same reason the
    // refusal above is: a target whose activation a backoff is still holding
    // cannot take over, so replaying it must cost nothing and change nothing
    // rather than deactivate the current host and then put it back. This is
    // also what rate-limits the corrective phases, which are not backed off
    // themselves.
    const heldActivation = this.heldSyncHostPhase(projectId, "activation");
    if (heldActivation) throw heldActivation.error;

    // A `serve` switch to a project that follows another machine must not
    // displace a live host: it is adopted read-only (see `purpose` on
    // SwitchSyncHostOptions), so return before the previous host is deactivated.
    // The previous host keeps its lease and discovery, and `syncHostProjectId`
    // is unchanged. With no previous host there is nothing to displace, so the
    // reader is published as before, and `resolveActiveSyncHost` answers from
    // `syncHostProjectId` without switching again.
    if (blocker && options.purpose === "serve" && previousHostId) return scope;

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

      // The flag is raised from inside the operation, which the phase wrapper
      // only invokes once it has let the attempt through. A backoff that starts
      // holding between the check above and this call therefore leaves the flag
      // down, and `rollback` knows there is nothing of ours on the target to
      // undo — only the previous host, if this switch already let it go.
      //
      // Skipped when this project follows another machine: "activation" is
      // `setHostStartupEnabled(true)`, and there is no host here to start. The
      // caller asked for "serve", so it wants the scope that owns sync — which
      // a viewer already is. This skips host activation, though a cold runtime
      // may still be initializing its saved peer in the background. Nothing is
      // reported as hosting that is not: a project with a blocker is a viewer
      // by its own record.
      if (!blocker) {
        await this.configureSyncHostWithTimeout(scope, true, "activation", () => {
          targetActivationAttempted = true;
        });
      }
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
    // The scope this project failed to boot is gone, so the phases recorded
    // against it describe a host that no longer exists. Same reason `dispose`
    // clears them.
    this.clearSyncHostPhaseBackoff(projectId);
    void pending.then(
      (scope) => scope.dispose(),
      () => undefined,
    );
  }

  private async getCachedScopeWithinTimeout(projectId: ProjectId): Promise<ProjectScope | null> {
    const cached = this.scopes.get(projectId);
    if (!cached) return null;
    return await this.runSyncHostPhase(
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
    const scope = await this.runSyncHostPhase(
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

  /**
   * Runs one phase against a scope under the configure budget. `onAttempt`
   * fires from inside the operation, so a caller can record that the phase
   * really ran without also recording a refusal by the backoff.
   */
  private async configureSyncHostWithTimeout(
    scope: ProjectScope,
    enabled: boolean,
    phase: string,
    onAttempt?: () => void,
  ): Promise<void> {
    await this.runSyncHostPhase(
      phase,
      scope.registryProjectId,
      SYNC_HOST_CONFIGURE_TIMEOUT_MS,
      () => {
        onAttempt?.();
        return this.configureSyncHost(scope, enabled, { initialize: false });
      },
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
      projectScopes: this,
    };
  }

  /**
   * A sync socket closed: end its live Mac Desktop and App Control viewers in
   * every booted project, not only the host's. One scope failing (or still
   * booting and then failing) never blocks the others.
   */
  private releaseStreamConnection(connectionId: string): void {
    for (const scopePromise of this.scopes.values()) {
      void scopePromise
        .then((scope) => {
          scope.runtime.syncService?.releaseStreamConnection(connectionId);
        })
        .catch(() => {
          // A scope that failed to boot holds no viewers; one whose release
          // threw is logged by the sync service itself.
        });
    }
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
