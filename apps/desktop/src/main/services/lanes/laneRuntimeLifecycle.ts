import type {
  LaneEnvInitConfig,
  LaneOverlayOverrides,
  LaneOverlayPolicy,
  LaneSummary,
  PortLease,
} from "../../../shared/types";
import { resolveLaneOverlayContext } from "./laneOverlayContext";

type LaneRuntimeLifecycleDependencies = {
  laneService: {
    list: (options: {
      includeArchived?: boolean;
      includeStatus: boolean;
    }) => Promise<LaneSummary[]>;
  };
  projectConfigService?: {
    getEffective: () => {
      laneEnvInit?: LaneEnvInitConfig;
      laneOverlayPolicies?: LaneOverlayPolicy[];
    };
  } | null;
  laneEnvironmentService?: {
    resolveEnvInitConfig: (
      config: LaneEnvInitConfig | undefined,
      overrides: LaneOverlayOverrides,
    ) => LaneEnvInitConfig | undefined;
    initLaneEnvironment: (
      lane: LaneSummary,
      config: LaneEnvInitConfig,
      overrides: LaneOverlayOverrides,
    ) => Promise<unknown>;
    cleanupLaneEnvironment: (
      lane: LaneSummary,
      config: LaneEnvInitConfig | undefined,
    ) => Promise<void>;
    /**
     * Did the lane's last env init stop before running every planned step?
     * Required, not optional: the docker-only unarchive restore is only correct
     * when the answer is no, so a host that forgot to wire this would silently
     * go back to handing back half-initialized worktrees.
     */
    wasLastInitIncomplete: (laneId: string) => boolean;
  } | null;
  portAllocationService?: {
    getLease: (laneId: string) => PortLease | null;
    acquire: (laneId: string) => PortLease;
    release: (laneId: string) => void;
  } | null;
  laneProxyService?: {
    removeRoute: (laneId: string) => unknown;
  } | null;
  /**
   * Structural on purpose — the ade-cli sync host, the IPC host and the action
   * registry all carry a logger with this shape, and this module has no
   * business importing the desktop logger type to say so.
   */
  logger?: { warn: (event: string, meta?: Record<string, unknown>) => void } | null;
};

async function findActiveLane(
  dependencies: Pick<LaneRuntimeLifecycleDependencies, "laneService">,
  laneId: string,
): Promise<LaneSummary | null> {
  const lanes = await dependencies.laneService.list({
    includeArchived: false,
    includeStatus: false,
  });
  return lanes.find((entry) => entry.id === laneId) ?? null;
}

async function resolveActiveLane(
  dependencies: Pick<LaneRuntimeLifecycleDependencies, "laneService">,
  laneId: string,
): Promise<LaneSummary> {
  const lane = await findActiveLane(dependencies, laneId);
  if (!lane) throw new Error(`Lane not found: ${laneId}`);
  return lane;
}

export async function ensureActiveLanePortLease(
  dependencies: Pick<LaneRuntimeLifecycleDependencies, "laneService" | "portAllocationService">,
  laneId: string,
): Promise<PortLease | null> {
  await resolveActiveLane(dependencies, laneId);
  const allocator = dependencies.portAllocationService;
  if (!allocator) return null;
  const existing = allocator.getLease(laneId);
  if (existing?.status === "active") return existing;
  const acquired = allocator.acquire(laneId);
  if (acquired.status !== "active") {
    throw new Error(`Could not acquire an active port lease for lane ${laneId}`);
  }
  return acquired;
}

export function releaseLaneRuntimeResources(
  dependencies: Pick<LaneRuntimeLifecycleDependencies, "portAllocationService" | "laneProxyService">,
  laneId: string,
): void {
  let routeError: unknown;
  let routeFailed = false;
  try {
    dependencies.laneProxyService?.removeRoute(laneId);
  } catch (error) {
    routeFailed = true;
    routeError = error;
  }
  try {
    const allocator = dependencies.portAllocationService;
    if (allocator?.getLease(laneId)?.status === "active") {
      allocator.release(laneId);
    }
  } catch (releaseError) {
    if (routeFailed) throw routeError;
    throw releaseError;
  }
  if (routeFailed) throw routeError;
}

export type LaneEnvTeardownDependencies = Pick<
  LaneRuntimeLifecycleDependencies,
  | "laneService"
  | "projectConfigService"
  | "laneEnvironmentService"
  | "portAllocationService"
  | "logger"
>;

/**
 * Build the "bring this lane's environment down" closure, or `undefined` when
 * there is nothing to tear down.
 *
 * One builder for every caller — archive (through `laneService`'s late-bound
 * hook), delete, and archive-and-reclaim, on all three hosts. They used to
 * hand-roll five near-identical closures that resolved the lane's config
 * differently from the archive path (no port lease folded into the overrides),
 * so two teardowns of the same lane could disagree about which compose file to
 * bring down.
 *
 * Context resolution failures swallow into `undefined`: a lane that cannot be
 * resolved has no environment we can safely act on, and refusing to archive
 * over it would be worse than skipping the compose down. They are logged here
 * rather than through a per-caller callback — that callback was optional, and
 * two of the five call sites (both archive-and-reclaim paths) had quietly
 * forgotten to pass it, so a resolution failure on the destructive path
 * vanished.
 */
export async function buildLaneEnvTeardown(
  dependencies: LaneEnvTeardownDependencies,
  laneId: string,
  options: { includeArchived?: boolean } = {},
): Promise<(() => Promise<void>) | undefined> {
  const environmentService = dependencies.laneEnvironmentService;
  const projectConfigService = dependencies.projectConfigService;
  if (!environmentService || !projectConfigService) return undefined;

  let context;
  try {
    context = await resolveLaneOverlayContext(
      { ...dependencies, projectConfigService, laneEnvironmentService: environmentService },
      laneId,
      options.includeArchived === true ? { includeArchived: true } : {},
    );
  } catch (error) {
    dependencies.logger?.warn("lane_env_cleanup.teardown_context_failed", {
      laneId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  // `cleanupLaneEnvironment` no-ops without a Docker config, so this guard is
  // only about not spawning work that has nothing to do.
  if (!context.envInitConfig?.docker) return undefined;
  const { lane, envInitConfig } = context;
  return async () => {
    await environmentService.cleanupLaneEnvironment(lane, envInitConfig);
  };
}

/**
 * Tear down the environment a lane's init started (Docker Compose stack) when
 * the lane is archived. Called from `laneService.archive` through the late-bound
 * hook, so every archive path — IPC, action domain, sync command, PR service
 * auto-archive, storage auto-archive — gets the same teardown that
 * archive-and-reclaim and delete already ran.
 *
 * Resolved while the lane is still active — the caller runs this before the
 * archived status write — but `includeArchived` is passed anyway, as at every
 * other teardown site: resolution must not start failing if that ordering ever
 * changes, because the compose stack still needs to come down either way.
 */
export async function teardownArchivedLaneEnvironment(
  dependencies: LaneEnvTeardownDependencies,
  laneId: string,
): Promise<void> {
  const teardown = await buildLaneEnvTeardown(dependencies, laneId, { includeArchived: true });
  await teardown?.();
}

/**
 * Bring a plain-unarchived lane's Docker services back up.
 *
 * Archive tears the compose stack down, so without this a plain unarchive (the
 * worktree was never removed, so `restoreRecreatedLaneRuntime` does not run)
 * hands back a lane whose services are gone. Only the Docker step re-runs: env
 * files, dependencies, mounts, copies, and the setup script all survived in the
 * worktree, and re-running them would overwrite edits the user made — unless
 * the lane's last init never finished (cancelled by the archive itself, or
 * failed), in which case they never got written and the whole config re-runs.
 *
 * The port lease archive released is re-acquired, exactly as
 * `restoreRecreatedLaneRuntime` does: compose files are templated with
 * `PORT_RANGE_START`/`PORT`, so bringing the stack up without a lease would
 * bind whatever the fallback range is and leave the proxy pointing elsewhere.
 * Unlike that path it is acquired only once there is Docker work to do.
 */
type LaneEnvironmentService = NonNullable<
  LaneRuntimeLifecycleDependencies["laneEnvironmentService"]
>;

type LaneRestoreContext = {
  lane: LaneSummary;
  overrides: LaneOverlayOverrides;
  envInitConfig: LaneEnvInitConfig | undefined;
  environmentService: LaneEnvironmentService;
};

/**
 * Shared prelude for both restore paths: prove the runtime-backed services are
 * actually wired, then resolve the lane's overlay context.
 *
 * `null` means "there is nothing to restore" — a host that runs without lane
 * env services (remote/CLI contexts where they are legitimately absent) rather
 * than a failure.
 */
async function resolveRestoreContext(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
): Promise<LaneRestoreContext | null> {
  const environmentService = dependencies.laneEnvironmentService;
  const projectConfigService = dependencies.projectConfigService;
  if (!environmentService || !projectConfigService) return null;

  // No lease is threaded through: `ensureActiveLanePortLease` has already
  // updated the allocator, and the allocator's own `getLease` is what
  // `resolveLaneOverlayContext` reads.
  const { lane, overrides, envInitConfig } = await resolveLaneOverlayContext(
    { ...dependencies, projectConfigService, laneEnvironmentService: environmentService },
    laneId,
  );
  return { lane, overrides, envInitConfig, environmentService };
}

/**
 * Hand back a lease taken for a restore that turned out to have nothing to do.
 * Best effort by design: the lane is already gone, and a failing route removal
 * must not mask why the restore aborted.
 */
function releaseAbortedRestoreLease(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
): void {
  try {
    releaseLaneRuntimeResources(dependencies, laneId);
  } catch {
    // Intentionally swallowed — see above.
  }
}

export async function restoreUnarchivedLaneDocker(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
): Promise<void> {
  const context = await resolveRestoreContext(dependencies, laneId);
  if (!context?.envInitConfig) return;
  /**
   * Docker-only is the right restore precisely because the other steps already
   * ran. When the last init was cancelled by a teardown (archive arriving
   * mid-init) or failed on a step, they did not: the worktree is missing env
   * files, dependencies, mounts or its setup script, and re-running only
   * `compose up` would hand that back looking healthy. Run the whole config in
   * that case — there is nothing of the user's to clobber that the interrupted
   * init had not already been told to write.
   */
  const lastInitIncomplete = context.environmentService.wasLastInitIncomplete(laneId);
  // No Docker step and nothing to repair: return before touching the allocator,
  // so a Docker-less unarchive never acquires (and then strands) a port lease it
  // has no use for.
  if (!context.envInitConfig.docker && !lastInitIncomplete) return;

  await ensureActiveLanePortLease(dependencies, laneId);

  // Re-resolve now that the lease exists so it folds into the overrides —
  // compose files are templated with `PORT_RANGE_START`/`PORT`, so bringing the
  // stack up without one would bind the fallback range and leave the proxy
  // pointing elsewhere.
  //
  // This restore is deliberately not awaited by its caller, so an archive can
  // land in the window since the first resolve. Check the lane is still active
  // immediately before starting `compose up` (a 300s job), and give the lease
  // back the way archive does if it is not.
  if ((await findActiveLane(dependencies, laneId)) == null) {
    releaseAbortedRestoreLease(dependencies, laneId);
    return;
  }
  const leased = await resolveRestoreContext(dependencies, laneId);
  const config = leased?.envInitConfig;
  // The full-init branch needs no explicit marker clear: completing the run is
  // what clears it, inside the environment service.
  const restoreConfig: LaneEnvInitConfig | null = !leased || !config
    ? null
    : lastInitIncomplete
      ? config
      : config.docker
        ? { docker: config.docker }
        : null;
  if (!leased || !restoreConfig) {
    releaseAbortedRestoreLease(dependencies, laneId);
    return;
  }
  await leased.environmentService.initLaneEnvironment(leased.lane, restoreConfig, leased.overrides);
}

export async function restoreRecreatedLaneRuntime(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
): Promise<void> {
  // `ensureActiveLanePortLease` resolves (and asserts) the active lane itself,
  // and leaves the lease on the allocator for the overlay context to read.
  await ensureActiveLanePortLease(dependencies, laneId);
  const context = await resolveRestoreContext(dependencies, laneId);
  if (!context?.envInitConfig) return;
  await context.environmentService.initLaneEnvironment(
    context.lane,
    context.envInitConfig,
    context.overrides,
  );
}

/**
 * Restore a lane's runtime after `unarchive`, on every host.
 *
 * The branch used to be copy-pasted into `registerIpc`, `adeActions/registry`
 * and the ade-cli sync host, comment and all.
 *
 * A recreated worktree needs the whole env init and is awaited: the caller is
 * handing back a directory that does not have its env files, dependencies or
 * mounts yet, so reporting "restored" before that finishes would be a lie, and
 * the path is rare enough to afford the wait.
 *
 * The plain path is NOT awaited, deliberately. It only re-runs `docker compose
 * up -d`, which has a 300s budget, while the mobile `lanes.unarchive` command
 * has 30s — awaiting it timed the whole unarchive out on any Docker project and
 * left the desktop's Unarchive button spinning for minutes on a lane that was
 * already back. The lane-env-init progress broadcast is what reports the Docker
 * step to the UI, so nothing is hidden by returning first; `onDockerError`
 * exists only so each host can log a failure in its own voice.
 */
export async function restoreUnarchivedLaneRuntime(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
  options: { worktreeRecreated?: boolean; onDockerError?: (error: unknown) => void } = {},
): Promise<void> {
  if (options.worktreeRecreated === true) {
    await restoreRecreatedLaneRuntime(dependencies, laneId);
    return;
  }
  void restoreUnarchivedLaneDocker(dependencies, laneId).catch((error: unknown) => {
    // The handler is host-supplied logging. It is the last catch on a detached
    // promise, so a throwing logger here would surface as an unhandled
    // rejection (and, in the main process, a crash dialog) instead of a failed
    // Docker restore.
    try {
      options.onDockerError?.(error);
    } catch {
      // Nothing left to report to.
    }
  });
}
