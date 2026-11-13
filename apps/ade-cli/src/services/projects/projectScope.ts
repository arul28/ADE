import type { CrossMachineHandoffTransport } from "../../../../desktop/src/main/services/chat/crossMachineHandoffOrchestrator";
import type { AdeRuntime, AdeRuntimeSyncOptions } from "../../bootstrap";
import type { SyncCommandPayload, SyncFileRequest } from "../../../../desktop/src/shared/types";
import type { SyncRemoteCommandExecutionContext } from "../sync/syncRemoteCommandService";
import type { TerminalInputDedupeLedger } from "../sync/syncHostService";
import type { SyncHostBlocker } from "../sync/syncService";
import type { BrainKeepAwakeService } from "../power/brainKeepAwakeService";
import type { RuntimeDisposeReason } from "../runtime/startupTeardown";
import type { ProjectId, ProjectRecord, ProjectRegistry } from "./projectRegistry";
import { captureProblem, sendSentryLog } from "../../../../desktop/src/shared/sentry/capture";
import { DIAGNOSTIC_ATTACH_TAG } from "../../../../desktop/src/shared/sentry/diagnostics";
import { createReportOnce, PROJECT_REGISTRY_ATTACH, wasRemovedFromRegistry } from "./projectRegistryJournal";
import { createPhaseClock, type PhaseClock } from "../../../../desktop/src/shared/phaseClock";
import { resolveBrainLoopWatchdogThresholdMs, trackBrainLoopWatchdogProjectOpen } from "../runtime/brainLoopWatchdog";
import { logSlowProjectOpen } from "./projectFilesystemKind";
import { QUEUED_OPEN_PHASE, type ProjectOpenStrikes } from "./projectOpenStrikes";

type ScopeLogger = { warn: (event: string, meta?: Record<string, unknown>) => void };

/**
 * How long a cold open waits its turn behind a project opening alone: the
 * freeze guard's threshold on this platform, plus a margin. A freeze longer
 * than that has already been killed; an open still running is not freezing
 * the loop, so the queued open goes ahead (a later kill finds the stuck open
 * in an old step, which the strike rules skip).
 */
const OPEN_TURN_MARGIN_MS = 15_000;

async function waitForOpenTurn(waitFor: Promise<unknown>[], turnMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.allSettled(waitFor),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, turnMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

  /**
   * Tear the runtime down and wait for it (each async disposer is capped).
   * `reason` tells the device services whether to hand their devices to the
   * next brain (`"exit"`, `"close"`) or stop them (`"unregister"`).
   */
  async dispose(reason?: RuntimeDisposeReason): Promise<void> {
    await this.runtime.dispose(reason);
  }
}

/** One project's teardown while it runs, so a later caller can join or strengthen it. */
type InFlightDisposal = {
  /** The strongest reason asked for so far. */
  reason: RuntimeDisposeReason;
  /** The scope, once its boot settled (null if it failed or has not yet). */
  scope: ProjectScope | null;
  /** The reason the runtime's teardown started with; null before it starts or without a scope. */
  runtimeReason: RuntimeDisposeReason | null;
  /** The runtime's teardown has finished. */
  runtimeDone: boolean;
  /** The whole disposal, listeners included. */
  done: Promise<void>;
  /** A removal that joined it: the disposal, then the hand-off clean-up. */
  upgrade: Promise<void> | null;
  /** The project's folder, for the clean-up when no scope booted. */
  rootPath: string | null;
  /** The hand-off clean-up ran (it runs at most once per disposal). */
  devicesCleaned: boolean;
};

export class ProjectScopeRegistry {
  private readonly scopes = new Map<ProjectId, Promise<ProjectScope>>();
  private readonly readyScopes = new Map<ProjectId, ProjectScope>();
  private readonly failedScopes = new Map<ProjectId, FailedAttempt>();
  /** Disposals still waiting on a booting scope, so a second caller waits too. */
  private readonly disposals = new Map<ProjectId, InFlightDisposal>();
  /**
   * Failed sync-host phases, keyed by {@link syncHostPhaseKey}. Same shape and
   * same windows as {@link failedScopes}: a phase that just failed is very
   * likely to fail the same way again, and here it is not merely expensive but
   * self-defeating, because the retry's rollback tears down whatever the
   * previous attempt had started.
   */
  private readonly failedSyncHostPhases = new Map<string, FailedAttempt>();
  private readonly disposeListeners = new Set<(projectId: ProjectId) => void>();
  private readonly syncScopeReadyListeners = new Set<() => void>();
  private readonly reportUnknownProjectIdOnce = createReportOnce();
  private readonly logUnknownPeerProjectIdOnce = createReportOnce();
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
      const scope = await this.get(this.resolvePeerProjectId({ projectId }, `files.${payload?.action ?? "unknown"}`));
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
      /** The brain's phone input ledger, shared with each project's sync host. */
      terminalInputDedupeLedger?: TerminalInputDedupeLedger;
      onDisposeProject?: (projectId: ProjectId) => void;
      /** A project's scope opened (its first open, or a re-open after a dispose). Never awaited; must not throw. */
      onProjectOpened?: (projectRoot: string) => void;
      /**
       * Stops the devices a removed project's earlier teardown handed off:
       * one that a removal joined while it ran, or a brain exit's, when the
       * project is not loaded now (see {@link dispose}). Never throws.
       * Injected so this module does not depend on device code.
       */
      onUnregisterAfterHandOff?: (projectRoot: string) => Promise<void>;
      /**
       * Freeze kills counted against projects (see `projectOpenStrikes.ts`).
       * A project with enough of them is refused here, for every caller: a
       * window, a phone, an automation, a timer, a restart's recovery.
       */
      openStrikes?: ProjectOpenStrikes | null;
      /**
       * The freeze guard's threshold, resolved once by the brain, which bounds
       * how long a cold open waits behind a project opening alone. Defaults to
       * this platform's default threshold.
       */
      freezeThresholdMs?: number;
      /** The brain's log, for `project.open_slow`. */
      logger?: ScopeLogger | null;
      /** Injectable clock for the failed-boot backoff. Tests only. */
      now?: () => number;
    } = {},
  ) {
    this.options.openStrikes?.prewarm((projectId) => this.projectRegistry.get(projectId));
  }

  /** Cold opens in flight, so a project with strikes can open alone. */
  private readonly openingNow = new Set<Promise<unknown>>();
  /** The open running alone, which later cold opens wait for. */
  private soloOpen: Promise<unknown> | null = null;

  /**
   * A person asked to open a refused project again: forget its strikes and the
   * failed-boot backoff, so the next `get` really opens it. Opening it is the
   * caller's next step. Returns whether it was refused.
   */
  retryOpen(projectId: ProjectId): { wasBlocked: boolean; strikesCleared: boolean } {
    const outcome = this.options.openStrikes?.clear(projectId, "retry") ?? { wasBlocked: false, cleared: false };
    this.failedScopes.delete(projectId);
    return { wasBlocked: outcome.wasBlocked, strikesCleared: outcome.cleared };
  }

  /** The `project_folder_too_slow` error opening this project would throw now, or null. */
  openRefusal(projectId: ProjectId): Error | null {
    return this.options.openStrikes?.refusal(projectId, () => this.projectRegistry.get(projectId)) ?? null;
  }

  /**
   * Whether this project is refused right now, for the brain's readers that
   * would otherwise read its folder without opening it (roster, catalog, chat
   * owner lookup, search).
   */
  isOpenBlocked(projectId: ProjectId): boolean {
    return Boolean(this.options.openStrikes?.blocked(projectId));
  }

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
  private reportUnknownProjectId(projectId: ProjectId, requestedBy: string | undefined): void {
    if (!this.reportUnknownProjectIdOnce(projectId)) return;
    try {
      if (wasRemovedFromRegistry(this.projectRegistry.path, projectId)) return;
      const registered = this.projectRegistry.list();
      captureProblem("The brain was asked for a project that is not in its project list", {
        fingerprint: ["brain", "project_id_unknown"],
        tags: { [DIAGNOSTIC_ATTACH_TAG]: PROJECT_REGISTRY_ATTACH },
        extra: {
          projectId,
          // The RPC method that carried the id, when the caller named it.
          requestedBy: requestedBy ?? null,
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
   * A scope that can answer sync calls appeared: a project finished opening,
   * or a project became the sync host. Called synchronously; a listener that
   * throws is logged and never fails the open or the switch.
   */
  onSyncScopeReady(listener: () => void): () => void {
    this.syncScopeReadyListeners.add(listener);
    return () => {
      this.syncScopeReadyListeners.delete(listener);
    };
  }

  private notifySyncScopeReady(): void {
    for (const listener of this.syncScopeReadyListeners) {
      try {
        listener();
      } catch (error) {
        this.options.logger?.warn("project_scope.sync_scope_ready_listener_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
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
    options: { touch?: boolean; requestedBy?: string } = {},
  ): Promise<ProjectScope> {
    const cached = this.scopes.get(projectId);
    if (cached) return await cached;

    // A refused project never reaches `createAdeRuntime`. One in-memory
    // lookup on the healthy path.
    const refusal = this.openRefusal(projectId);
    if (refusal) throw refusal;

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
      this.reportUnknownProjectId(projectId, options.requestedBy);
      throw new Error(`Unknown projectId: ${projectId}`);
    }

    // One clock for the whole open, which also tells the freeze guard each
    // step, so a kill names the project and the step. Started before the first
    // read of the folder: on a hung mount that read is the freeze.
    const openTracker = trackBrainLoopWatchdogProjectOpen(projectId);
    const timing = createPhaseClock<string>("prepare");
    const openClock: PhaseClock<string> = {
      enter: (phase) => {
        timing.enter(phase);
        openTracker.phase(phase);
      },
      current: () => timing.current(),
      timings: () => timing.timings(),
      totalMs: () => timing.totalMs(),
      summary: () => timing.summary(),
    };
    try {
      this.projectRegistry.assertProjectDataAvailable(record);
    } catch (error) {
      openTracker.done();
      // A check that was itself slow (a drive that barely answers) is a slow open too.
      logSlowProjectOpen({
        logger: this.options.logger,
        clock: openClock,
        projectRoot: record.rootPath,
        fields: { projectId, outcome: "failed" },
      });
      throw error;
    }
    // A project with strikes opens alone: other cold opens wait for it, and it
    // waits for those already running, so a freeze during it is its own.
    const solo = this.options.openStrikes?.opensAlone(projectId) ?? false;
    let waitFor: Promise<unknown>[] = [];
    if (solo) {
      waitFor = [...this.openingNow];
    } else if (this.soloOpen) {
      waitFor = [this.soloOpen];
    }
    const pending = (async () => {
      if (waitFor.length > 0) {
        openClock.enter(QUEUED_OPEN_PHASE);
        await waitForOpenTurn(
          waitFor,
          (this.options.freezeThresholdMs ?? resolveBrainLoopWatchdogThresholdMs(undefined)) + OPEN_TURN_MARGIN_MS,
        );
        openClock.enter("prepare");
      }
      // A teardown of this project's previous scope may still be waiting on
      // its disposers (up to the drain's cap); its database closes last, so
      // the new runtime opens the project only after the old one let go.
      // A removal's device clean-up runs after the teardown; wait for it too,
      // or the new runtime adopts emulators the clean-up is stopping.
      const prior = this.disposals.get(projectId);
      const priorDisposal = prior ? (prior.upgrade ?? prior.done) : undefined;
      if (priorDisposal) await priorDisposal.catch(() => undefined);
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
        openClock,
      });
      openClock.enter("identity");
      try {
        this.projectRegistry.recordDatabaseIdentity(projectId);
      } catch (error) {
        await runtime.dispose("close");
        throw error;
      }
      return new ProjectScope({
        registryProjectId: projectId,
        record,
        runtime,
      });
    })();
    this.scopes.set(projectId, pending);
    this.openingNow.add(pending);
    if (solo) this.soloOpen = pending;
    const settle = (outcome: "opened" | "failed"): void => {
      this.openingNow.delete(pending);
      if (this.soloOpen === pending) this.soloOpen = null;
      openTracker.done();
      // Logged here, on the brain's own disk, so failed and killed opens are covered.
      logSlowProjectOpen({
        logger: this.options.logger,
        clock: openClock,
        projectRoot: record.rootPath,
        fields: { projectId, outcome },
      });
    };
    void pending.then(() => settle("opened"), () => settle("failed"));

    try {
      const scope = await pending;
      // Only the attempt that still owns the cache entry may clear the
      // backoff; an abandoned boot that succeeds late must not wipe a backoff
      // a newer attempt earned.
      if (this.scopes.get(projectId) === pending) {
        this.readyScopes.set(projectId, scope);
        this.failedScopes.delete(projectId);
        // It opened, so whatever froze it before is not freezing it now.
        this.options.openStrikes?.clear(projectId, "opened");
        this.notifySyncScopeReady();
        try {
          this.options.onProjectOpened?.(record.rootPath);
        } catch (hookError) {
          // A hook never fails an open.
          this.options.logger?.warn("project_scope.open_hook_failed", {
            error: hookError instanceof Error ? hookError.name : "unknown",
          });
        }
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

  /**
   * Drop a project's scope and wait for its runtime to tear down.
   *
   * `reason` defaults to `"close"` (a repair or a re-boot: the next scope for
   * the project re-adopts what this one hands off). Pass `"unregister"` when
   * the project is leaving this machine, and `"exit"` when the brain is.
   */
  /**
   * `options.rootPath` names the project's folder for a removal whose caller
   * already took it out of the registry; the device clean-up needs it.
   */
  async dispose(
    projectId: ProjectId,
    reason: RuntimeDisposeReason = "close",
    options: { rootPath?: string | null } = {},
  ): Promise<void> {
    const rootPath = options.rootPath ?? this.projectRegistry.get(projectId)?.rootPath ?? null;
    // Disposing is how a repair asks for a clean slate, so it also drops the
    // failed-boot backoff: the next `get` must boot rather than replay the
    // failure the repair was meant to fix. The sync-host phases go with it, for
    // the same reason: a repair that drops the scope must also re-run the
    // activation this project failed.
    this.failedScopes.delete(projectId);
    this.clearSyncHostPhaseBackoff(projectId);
    const cached = this.scopes.get(projectId);
    // Another caller already took the scope and waits for its boot: wait for
    // the same disposal, so "disposed" means its teardown ran.
    if (!cached) {
      const inFlight = this.disposals.get(projectId);
      if (!inFlight) {
        // Not loaded: an earlier brain exit may have handed its devices off
        // for a next runtime, which a removed project will never boot.
        if (reason === "unregister" && rootPath) {
          await this.options.onUnregisterAfterHandOff?.(rootPath).catch(() => undefined);
        }
        return;
      }
      if (reason === "unregister" && inFlight.reason !== "unregister") {
        inFlight.rootPath ??= rootPath;
        inFlight.upgrade = this.upgradeToUnregister(projectId, inFlight);
      }
      // A later removal waits for the clean-up too, not only the teardown.
      return await (inFlight.upgrade ?? inFlight.done);
    }
    this.scopes.delete(projectId);
    this.readyScopes.delete(projectId);
    const entry: InFlightDisposal = {
      reason,
      scope: null,
      runtimeReason: null,
      runtimeDone: false,
      done: Promise.resolve(),
      upgrade: null,
      rootPath,
      devicesCleaned: false,
    };
    const disposal = this.disposeCached(projectId, cached, entry).finally(() => {
      // A removal that joined keeps the entry until its clean-up is done too.
      if (this.disposals.get(projectId) === entry && !entry.upgrade) this.disposals.delete(projectId);
    });
    entry.done = disposal;
    this.disposals.set(projectId, entry);
    await disposal;
  }

  /**
   * A project removed while a weaker teardown of it runs (a repair's
   * `"close"`). Joining alone would drop the removal: that teardown hands the
   * project's devices off for a next runtime that will never come, so they
   * keep running. The releases not yet run get `"unregister"` through the
   * runtime's drain; the device releases have usually run already (they are
   * registered late, so they come off the stack early), so whatever they
   * handed off is stopped afterwards.
   */
  private async upgradeToUnregister(projectId: ProjectId, inFlight: InFlightDisposal): Promise<void> {
    try {
      await this.finishAsUnregister(inFlight);
    } finally {
      if (this.disposals.get(projectId) === inFlight) this.disposals.delete(projectId);
    }
  }

  private async finishAsUnregister(inFlight: InFlightDisposal): Promise<void> {
    // A scope still booting reads this when its teardown starts.
    inFlight.reason = "unregister";
    if (inFlight.scope && !inFlight.runtimeDone) {
      // Joins the running drain; the teardown stack keeps the stronger reason.
      void inFlight.scope.dispose("unregister");
    }
    await inFlight.done;
    // A scope torn down for "unregister" stopped its own devices; any other
    // teardown, or a failed boot, may have left handed-off ones.
    if (inFlight.runtimeReason !== "unregister") {
      // Mac Desktop has the same race, but whether its apps were handed off is
      // the native driver's decision, so only Android is cleaned up here.
      await this.cleanUpHandedOffDevices(inFlight, inFlight.scope?.record.rootPath ?? inFlight.rootPath);
    }
  }

  private async cleanUpHandedOffDevices(entry: InFlightDisposal, rootPath: string | null): Promise<void> {
    if (entry.devicesCleaned || !rootPath) return;
    entry.devicesCleaned = true;
    await this.options.onUnregisterAfterHandOff?.(rootPath).catch(() => undefined);
  }

  private async disposeCached(
    projectId: ProjectId,
    cached: Promise<ProjectScope>,
    entry: InFlightDisposal,
  ): Promise<void> {
    const scope = await cached.catch(() => null);
    entry.scope = scope;
    // Read after the boot: a removal that arrived meanwhile upgraded it.
    entry.runtimeReason = scope ? entry.reason : null;
    // Never throws: each teardown step reports its own failure.
    await scope?.dispose(entry.reason);
    entry.runtimeDone = true;
    if (!scope && entry.reason === "unregister") {
      // The boot failed, so no device service ran this time; an earlier brain
      // exit may still have handed devices off, as for a project not loaded.
      await this.cleanUpHandedOffDevices(entry, entry.rootPath);
    }
    if (this.syncHostProjectId === projectId) {
      this.syncHostProjectId = null;
    }
    this.options.onDisposeProject?.(projectId);
    for (const listener of this.disposeListeners) {
      listener(projectId);
    }
  }

  /** Every scope at once; `reason` as {@link dispose}, usually `"exit"`. */
  async disposeAll(reason: RuntimeDisposeReason = "close"): Promise<void> {
    const projectIds = [...this.scopes.keys()];
    await Promise.all(projectIds.map((projectId) => this.dispose(projectId, reason)));
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
    // A refused project cannot host; asking for it would only be refused again.
    if (existingHostId && !this.isOpenBlocked(existingHostId)) {
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
        if (this.isOpenBlocked(candidate.projectId)) return false;
        if (!this.projectRegistry.isProjectDataMissing(candidate)) return true;
        onSkippedMissingProject?.(candidate);
        return false;
      });
    // This caller reads: it wants whatever owns sync on this machine, and a
    // project that follows another machine is a legitimate answer to that.
    return record ? this.switchSyncHost(record.projectId, { purpose: "serve" }) : null;
  }

  /**
   * A sync scope that has already finished opening, for a sync read. It never
   * boots a scope, never runs host activation and never waits on a scope that
   * is still opening (a read that waited answered late, or with nothing when
   * that open failed while another scope was ready). The known sync host's
   * ready scope wins; then the most recently opened ready scope; then any
   * other ready scope. Null when none is ready.
   */
  resolveReadySyncScope(): ProjectScope | null {
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
      ...this.readyScopes.keys(),
    ];
    for (const projectId of new Set(preferredIds)) {
      if (!projectId) continue;
      const ready = this.getIfReady(projectId);
      if (ready) return ready;
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
      this.notifySyncScopeReady();
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
      (scope) => scope.dispose("close"),
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
      // A peer may still name a project by the id it had before it moved
      // here; the routed file request resolves it the same way.
      projectScopes: {
        getIfBooted: (peerProjectId: string) =>
          this.getIfBooted(this.projectRegistry.resolveMovedProjectId(peerProjectId) ?? peerProjectId),
        ...(this.options.terminalInputDedupeLedger
          ? { terminalInputDedupeLedger: this.options.terminalInputDedupeLedger }
          : {}),
      },
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

  /**
   * The registered project a peer's command or file request names, resolved
   * the way the brain's own command router resolves it: by id (or the id it
   * was moved to), else by root path. A phone, web client or other machine
   * that still holds an id this brain never had (a project that lives on
   * another machine, a stale selection) is answered with `project_not_open`,
   * the code every client already recovers from, and leaves a Sentry log
   * rather than an issue: that is a peer's stale state, not this brain's
   * project list going wrong. A window asking for an unknown id still goes
   * through `get`, which reports it.
   */
  private resolvePeerProjectId(
    target: { projectId: string; projectRootPath?: string | null },
    action: string,
  ): ProjectId {
    const { projectId } = target;
    if (this.scopes.has(projectId) || this.projectRegistry.get(projectId)) return projectId;
    const movedTo = this.projectRegistry.resolveMovedProjectId(projectId);
    if (movedTo) return movedTo;
    const rootPath = typeof target.projectRootPath === "string" && target.projectRootPath.trim()
      ? target.projectRootPath.trim()
      : null;
    const byRoot = rootPath ? this.projectRegistry.findAtRootPath(rootPath) : null;
    if (byRoot) return byRoot.projectId;
    if (this.logUnknownPeerProjectIdOnce(projectId)) {
      sendSentryLog("warn", "brain.peer_unknown_project_id", {
        projectId,
        action,
        hadRootPath: rootPath !== null,
        registeredCount: this.projectRegistry.list().length,
        removedHere: wasRemovedFromRegistry(this.projectRegistry.path, projectId),
      });
    }
    throw Object.assign(
      new Error(`This project is not on this ADE machine (Unknown projectId: ${projectId}). Select the project again and retry.`),
      { code: "project_not_open" },
    );
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
    const resolvedProjectId = this.resolvePeerProjectId({
      projectId,
      projectRootPath: payload.projectRootPath,
    }, payload.action);
    const scope = await this.get(resolvedProjectId);
    const syncService = scope.runtime.syncService;
    if (!syncService) {
      throw new Error(`Phone sync is not available for project ${projectId}.`);
    }
    return await syncService.executeRemoteCommand(
      resolvedProjectId === projectId ? payload : { ...payload, projectId: resolvedProjectId },
      context,
    );
  }
}
