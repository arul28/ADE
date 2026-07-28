import type {
  LaneEnvInitConfig,
  LaneOverlayOverrides,
  LaneOverlayPolicy,
  LaneSummary,
  PortLease,
} from "../../../shared/types";
import { matchLaneOverlayPolicies } from "../config/laneOverlayMatcher";

type LaneRuntimeLifecycleDependencies = {
  laneService: {
    list: (options: {
      includeArchived: boolean;
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

export async function restoreRecreatedLaneRuntime(
  dependencies: LaneRuntimeLifecycleDependencies,
  laneId: string,
): Promise<void> {
  const lane = await resolveActiveLane(dependencies, laneId);
  const lease = await ensureActiveLanePortLease(dependencies, laneId);
  const environmentService = dependencies.laneEnvironmentService;
  const projectConfigService = dependencies.projectConfigService;
  if (!environmentService || !projectConfigService) return;

  const config = projectConfigService.getEffective();
  const overlayOverrides = matchLaneOverlayPolicies(lane, config.laneOverlayPolicies ?? []);
  const overrides = lease && !overlayOverrides.portRange
    ? {
        ...overlayOverrides,
        portRange: { start: lease.rangeStart, end: lease.rangeEnd },
      }
    : overlayOverrides;
  const envInitConfig = environmentService.resolveEnvInitConfig(config.laneEnvInit, overrides);
  if (!envInitConfig) return;
  await environmentService.initLaneEnvironment(lane, envInitConfig, overrides);
}
