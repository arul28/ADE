import type {
  LaneDockerConfig,
  LaneEnvInitConfig,
  LaneOverlayOverrides,
} from "../../../shared/types";

/**
 * The lane env-init merge kernel: pure data merging, no service dependencies.
 *
 * These used to be hand-copied into five files (`laneEnvironmentService`,
 * `projectConfigService`, `registerIpc`, `adeActions/registry`, and the ade-cli
 * `syncRemoteCommandService`). Every field added to `LaneEnvInitConfig` had to
 * be added five times, and the copies had already drifted — `copyPaths` and
 * `setupScript` reached some merges and not others. The ade-cli already imports
 * desktop lane services through `bootstrap.ts`, so a single desktop-side module
 * is reachable from every host.
 *
 * Keep this module dependency-free: `projectConfigService` imports it, and the
 * service-dependent overlay resolver lives in `laneOverlayContext.ts` precisely
 * so config parsing does not have to pull the lane services in.
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

/**
 * Layer a partial set of overlay overrides (a template being applied) onto the
 * lane's resolved overrides: scalars from `next` win, `env` maps union, and the
 * env-init configs merge through the kernel above.
 *
 * Byte-identical in all three hosts before this move, which is how the IPC host
 * and the sync host could have drifted on what applying a template means.
 */
export function mergeLaneOverrides(
  base: LaneOverlayOverrides,
  next: Partial<LaneOverlayOverrides>,
): LaneOverlayOverrides {
  const envInit = mergeLaneEnvInitConfig(base.envInit, next.envInit);
  return {
    ...base,
    ...next,
    ...(base.env || next.env ? { env: { ...(base.env ?? {}), ...(next.env ?? {}) } } : {}),
    ...(base.testSuiteIds || next.testSuiteIds
      ? { testSuiteIds: [...(next.testSuiteIds ?? base.testSuiteIds ?? [])] }
      : {}),
    ...(envInit ? { envInit } : {}),
  };
}
