import type {
  LaneDockerConfig,
  LaneEnvInitConfig,
  LaneOverlayOverrides,
  LaneOverlayPolicy,
  LaneSummary,
  PortLease,
} from "../../../shared/types";
import { matchLaneOverlayPolicies } from "../config/laneOverlayMatcher";

/**
 * One implementation of "merge two lane env-init configs" and one of "resolve
 * the effective env-init context for a lane".
 *
 * These used to be hand-copied into four files (`laneEnvironmentService`,
 * `registerIpc`, `adeActions/registry`, and the ade-cli
 * `syncRemoteCommandService`). Every field added to `LaneEnvInitConfig` had to
 * be added four times, and the copies had already drifted — `copyPaths` and
 * `setupScript` reached some merges and not others. The ade-cli already imports
 * desktop lane services through `bootstrap.ts`, so a single desktop-side module
 * is reachable from every host.
 */

function cloneDockerConfig(config: LaneDockerConfig): LaneDockerConfig {
  return config.services ? { ...config, services: [...config.services] } : { ...config };
}

export function mergeLaneDockerConfig(
  current: LaneDockerConfig | undefined,
  next: LaneDockerConfig | undefined,
): LaneDockerConfig | undefined {
  if (!current && !next) return undefined;
  if (!current) return next ? cloneDockerConfig(next) : undefined;
  if (!next) return cloneDockerConfig(current);
  const services = next.services ?? current.services;
  return {
    ...current,
    ...next,
    ...(services ? { services: [...services] } : {}),
  };
}

export function cloneLaneEnvInitConfig(config: LaneEnvInitConfig): LaneEnvInitConfig {
  const docker = mergeLaneDockerConfig(undefined, config.docker);
  return {
    ...(config.envFiles ? { envFiles: [...config.envFiles] } : {}),
    ...(docker ? { docker } : {}),
    ...(config.dependencies ? { dependencies: [...config.dependencies] } : {}),
    ...(config.mountPoints ? { mountPoints: [...config.mountPoints] } : {}),
    ...(config.copyPaths ? { copyPaths: [...config.copyPaths] } : {}),
    ...(config.setupScript ? { setupScript: { ...config.setupScript } } : {}),
  };
}

export function mergeLaneEnvInitConfig(
  current: LaneEnvInitConfig | undefined,
  next: LaneEnvInitConfig | undefined,
): LaneEnvInitConfig | undefined {
  if (!current && !next) return undefined;
  if (!current) return next ? cloneLaneEnvInitConfig(next) : undefined;
  if (!next) return cloneLaneEnvInitConfig(current);
  const docker = mergeLaneDockerConfig(current.docker, next.docker);
  // A lane runs one setup script; the more specific config (overlay/template) wins.
  const setupScript = next.setupScript ?? current.setupScript;
  return {
    envFiles: [...(current.envFiles ?? []), ...(next.envFiles ?? [])],
    ...(docker ? { docker } : {}),
    dependencies: [...(current.dependencies ?? []), ...(next.dependencies ?? [])],
    mountPoints: [...(current.mountPoints ?? []), ...(next.mountPoints ?? [])],
    copyPaths: [...(current.copyPaths ?? []), ...(next.copyPaths ?? [])],
    ...(setupScript ? { setupScript: { ...setupScript } } : {}),
  };
}

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
  options: { includeArchived?: boolean } = {},
): Promise<LaneOverlayContext> {
  const lanes = await dependencies.laneService.list({
    includeStatus: false,
    ...(options.includeArchived === true ? { includeArchived: true } : {}),
  });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`Lane not found: ${laneId}`);

  const config = dependencies.projectConfigService.getEffective();
  const overlayOverrides = matchLaneOverlayPolicies(lane, config.laneOverlayPolicies ?? []);
  const lease = dependencies.portAllocationService?.getLease(lane.id) ?? null;
  const overrides = applyLeaseToOverrides(overlayOverrides, lease);
  const envInitConfig = dependencies.laneEnvironmentService?.resolveEnvInitConfig(
    config.laneEnvInit,
    overrides,
  );

  return { lane, overrides, envInitConfig, lease };
}
