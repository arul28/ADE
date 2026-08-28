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
  } | null;
  portAllocationService?: {
    getLease: (laneId: string) => PortLease | null;
    acquire: (laneId: string) => PortLease;
    release: (laneId: string) => void;
  } | null;
  laneProxyService?: {
    removeRoute: (laneId: string) => unknown;
  } | null;
};

async function resolveActiveLane(
  dependencies: Pick<LaneRuntimeLifecycleDependencies, "laneService">,
  laneId: string,
): Promise<LaneSummary> {
  const lanes = await dependencies.laneService.list({
    includeArchived: false,
    includeStatus: false,
  });
  const lane = lanes.find((entry) => entry.id === laneId);
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
  "laneService" | "projectConfigService" | "laneEnvironmentService" | "portAllocationService"
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
 * Context resolution failures are reported and swallow into `undefined`: a lane
 * that cannot be resolved has no environment we can safely act on, and refusing
 * to archive over it would be worse than skipping the compose down.
 */
export async function buildLaneEnvTeardown(
  dependencies: LaneEnvTeardownDependencies,
  laneId: string,
  options: {
    includeArchived?: boolean;
    onContextError?: (error: unknown) => void;
  } = {},
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
    options.onContextError?.(error);
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
 * worktree, and re-running them would overwrite edits the user made.
 *
 * The port lease archive released is re-acquired first, exactly as
 * `restoreRecreatedLaneRuntime` does: compose files are templated with
 * `PORT_RANGE_START`/`PORT`, so bringing the stack up without a lease would
 * bind whatever the fallback range is and leave the proxy pointing elsewhere.
 */
export async function restoreUnarchivedLaneDocker(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
): Promise<void> {
  const lease = await ensureActiveLanePortLease(dependencies, laneId);
  const environmentService = dependencies.laneEnvironmentService;
  const projectConfigService = dependencies.projectConfigService;
  if (!environmentService || !projectConfigService) return;

  const context = await resolveLaneOverlayContext(
    {
      ...dependencies,
      projectConfigService,
      laneEnvironmentService: environmentService,
      portAllocationService: lease ? { getLease: () => lease } : dependencies.portAllocationService,
    },
    laneId,
  );
  const docker = context.envInitConfig?.docker;
  if (!docker) return;
  await environmentService.initLaneEnvironment(context.lane, { docker }, context.overrides);
}

export async function restoreRecreatedLaneRuntime(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
): Promise<void> {
  await resolveActiveLane(dependencies, laneId);
  const lease = await ensureActiveLanePortLease(dependencies, laneId);
  const environmentService = dependencies.laneEnvironmentService;
  const projectConfigService = dependencies.projectConfigService;
  if (!environmentService || !projectConfigService) return;

  const { lane, overrides, envInitConfig } = await resolveLaneOverlayContext(
    {
      ...dependencies,
      projectConfigService,
      laneEnvironmentService: environmentService,
      portAllocationService: lease ? { getLease: () => lease } : dependencies.portAllocationService,
    },
    laneId,
  );
  if (!envInitConfig) return;
  await environmentService.initLaneEnvironment(lane, envInitConfig, overrides);
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
    options.onDockerError?.(error);
  });
}
