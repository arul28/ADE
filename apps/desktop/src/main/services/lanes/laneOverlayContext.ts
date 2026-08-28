import type {
  LaneEnvInitConfig,
  LaneOverlayOverrides,
  LaneOverlayPolicy,
  LaneSummary,
  PortLease,
} from "../../../shared/types";
import { matchLaneOverlayPolicies } from "../config/laneOverlayMatcher";

/**
 * One implementation of "resolve the effective env-init context for a lane".
 *
 * Split from the dependency-free merge kernel in `laneEnvInitMerge.ts`: that
 * module is pure data merging and is imported by config parsing, while this one
 * needs lane/config/port services. Keeping the kernel free of service types is
 * what lets `projectConfigService` import it without dragging the lane services
 * (and a cycle) in with it.
 *
 * This resolver used to be hand-copied into `registerIpc`, `adeActions/registry`
 * and the ade-cli `syncRemoteCommandService`, and the copies had drifted over
 * whether an active port lease was folded into the overrides — so two teardowns
 * of the same lane could disagree about which compose file to bring down.
 */

export function applyLeaseToOverrides(
  overrides: LaneOverlayOverrides,
  lease: PortLease | null,
): LaneOverlayOverrides {
  if (!lease || lease.status !== "active" || overrides.portRange) {
    return { ...overrides };
  }
  return {
    ...overrides,
    portRange: { start: lease.rangeStart, end: lease.rangeEnd },
  };
}

export type LaneOverlayContextDependencies = {
  laneService: {
    list: (options: { includeArchived?: boolean; includeStatus: boolean }) => Promise<LaneSummary[]>;
  };
  projectConfigService: {
    getEffective: () => {
      laneEnvInit?: LaneEnvInitConfig;
      laneOverlayPolicies?: LaneOverlayPolicy[];
    };
  };
  portAllocationService?: { getLease: (laneId: string) => PortLease | null } | null;
  laneEnvironmentService?: {
    resolveEnvInitConfig: (
      config: LaneEnvInitConfig | undefined,
      overrides: LaneOverlayOverrides,
    ) => LaneEnvInitConfig | undefined;
  } | null;
};

export type LaneOverlayContext = {
  lane: LaneSummary;
  overrides: LaneOverlayOverrides;
  envInitConfig: LaneEnvInitConfig | undefined;
  lease: PortLease | null;
};

/**
 * Resolve the lane, its overlay overrides (with an active port lease folded in)
 * and the effective env-init config in one place, so archive/delete/reclaim and
 * env-init all see the same answer on every host.
 */
export async function resolveLaneOverlayContext(
  dependencies: LaneOverlayContextDependencies,
  laneId: string,
  options: {
    includeArchived?: boolean;
  } = {},
): Promise<LaneOverlayContext> {
  const lanes = await dependencies.laneService.list({
    includeStatus: false,
    ...(options.includeArchived === true ? { includeArchived: true } : {}),
  });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`Lane not found: ${laneId}`);

  const config = dependencies.projectConfigService.getEffective();
  const overlayOverrides = matchLaneOverlayPolicies(lane, config.laneOverlayPolicies ?? []);
  // The allocator is the single authority on the lane's lease: callers that just
  // acquired one (the restore paths, via `ensureActiveLanePortLease`) already
  // updated it, so asking again cannot be stale — while a caller-supplied lease
  // could be.
  const lease = dependencies.portAllocationService?.getLease(lane.id) ?? null;
  const overrides = applyLeaseToOverrides(overlayOverrides, lease);
  const envInitConfig = dependencies.laneEnvironmentService?.resolveEnvInitConfig(
    config.laneEnvInit,
    overrides,
  );

  return { lane, overrides, envInitConfig, lease };
}
