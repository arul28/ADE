import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type {
  LaneEnvInitConfig,
  LaneEnvInitProgress,
  LaneEnvInitStep,
  LaneEnvInitStepKind,
  LaneEnvInitEvent,
  LaneEnvFileConfig,
  LaneDependencyInstallConfig,
  LaneMountPointConfig,
  LaneCopyPathConfig,
  LaneDockerConfig,
  LaneOverlayOverrides,
  LaneSummary
} from "../../../shared/types";

import type { Logger } from "../logging/logger";

function cloneDockerConfig(config: LaneDockerConfig): LaneDockerConfig {
  return config.services
    ? { ...config, services: [...config.services] }
    : { ...config };
}

function mergeDockerConfig(
  current: LaneDockerConfig | undefined,
  next: LaneDockerConfig | undefined
): LaneDockerConfig | undefined {
  if (!current && !next) return undefined;
  if (!current) return next ? cloneDockerConfig(next) : undefined;
  if (!next) return cloneDockerConfig(current);
  const services = next.services ?? current.services;
  return {
    ...current,
    ...next,
    ...(services ? { services: [...services] } : {})
  };
}

function cloneEnvInitConfig(config: LaneEnvInitConfig): LaneEnvInitConfig {
  const docker = mergeDockerConfig(undefined, config.docker);
  return {
    ...(config.envFiles ? { envFiles: [...config.envFiles] } : {}),
    ...(docker ? { docker } : {}),
    ...(config.dependencies ? { dependencies: [...config.dependencies] } : {}),
    ...(config.mountPoints ? { mountPoints: [...config.mountPoints] } : {}),
    ...(config.copyPaths ? { copyPaths: [...config.copyPaths] } : {})
  };
}

function mergeLaneEnvInitConfig(
  current: LaneEnvInitConfig | undefined,
  next: LaneEnvInitConfig | undefined
): LaneEnvInitConfig | undefined {
  if (!current && !next) return undefined;
  if (!current) return next ? cloneEnvInitConfig(next) : undefined;
  if (!next) return cloneEnvInitConfig(current);
  const docker = mergeDockerConfig(current.docker, next.docker);
  return {
    envFiles: [...(current.envFiles ?? []), ...(next.envFiles ?? [])],
    ...(docker ? { docker } : {}),
    dependencies: [...(current.dependencies ?? []), ...(next.dependencies ?? [])],
    mountPoints: [...(current.mountPoints ?? []), ...(next.mountPoints ?? [])],
    copyPaths: [...(current.copyPaths ?? []), ...(next.copyPaths ?? [])]
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function sanitizeLaneToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "lane";
}

function buildDockerProjectName(laneId: string, projectPrefix = "ade"): string {
  return `${projectPrefix}-${sanitizeLaneToken(laneId)}`;
}

export function createLaneEnvironmentService({
  projectRoot,
  adeDir,
  logger,
  broadcastEvent
}: {
  projectRoot: string;
  adeDir: string;
  logger: Logger;
  broadcastEvent: (ev: LaneEnvInitEvent) => void;
}) {
  // Track in-progress and completed init progress per lane
  const progressMap = new Map<string, LaneEnvInitProgress>();

  function makeStep(kind: LaneEnvInitStepKind, label: string): LaneEnvInitStep {
    return { kind, label, status: "pending" };
  }

  function updateStep(
    progress: LaneEnvInitProgress,
    kind: LaneEnvInitStepKind,
    update: Partial<LaneEnvInitStep>
  ): void {
    const step = progress.steps.find((s) => s.kind === kind);
    if (step) Object.assign(step, update);
    broadcastEvent({ type: "lane-env-init", progress: { ...progress, steps: [...progress.steps] } });
  }

  function markFailed(progress: LaneEnvInitProgress, laneId: string): void {
    progress.overallStatus = "failed";
    progress.completedAt = new Date().toISOString();
    progressMap.set(laneId, progress);
    broadcastEvent({ type: "lane-env-init", progress });
  }

  /**
   * Run a single init step with timing, status updates, and error handling.
   * Returns true on success, false on failure (progress already marked failed).
   */
  async function runStep(
    progress: LaneEnvInitProgress,
    laneId: string,
    kind: LaneEnvInitStepKind,
    action: () => Promise<string | null>
  ): Promise<boolean> {
    const startTime = Date.now();
    updateStep(progress, kind, { status: "running" });
    try {
      const errorMessage = await action();
      if (errorMessage) {
        updateStep(progress, kind, { status: "failed", error: errorMessage, durationMs: Date.now() - startTime });
        markFailed(progress, laneId);
        return false;
      }
      updateStep(progress, kind, { status: "completed", durationMs: Date.now() - startTime });
      return true;
    } catch (err: any) {
      updateStep(progress, kind, {
        status: "failed",
        error: err?.message ?? String(err),
        durationMs: Date.now() - startTime
      });
      markFailed(progress, laneId);
      return false;
    }
  }

  function execCommand(
    command: string[],
    cwd: string,
    timeoutMs = 120_000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const [cmd, ...args] = command;
      execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        const exitCode = error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1;
        resolve({
          exitCode: error ? exitCode : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? ""
        });
      });
    });
  }

  async function copyEnvFiles(
    worktreePath: string,
    envFiles: LaneEnvFileConfig[],
    laneVars: Record<string, string>
  ): Promise<void> {
    for (const file of envFiles) {
      const sourcePath = path.resolve(projectRoot, file.source);
      const destPath = path.resolve(worktreePath, file.dest);

      // Ensure destination directory exists
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      if (!fs.existsSync(sourcePath)) {
        logger.warn("lane_env_init.env_file_missing", { source: file.source });
        continue;
      }

      let content = fs.readFileSync(sourcePath, "utf-8");

      // Apply template variables: merge file-level vars with lane-level vars
      const vars: Record<string, string> = { ...laneVars, ...(file.vars ?? {}) };
      for (const [key, value] of Object.entries(vars)) {
        // Replace {{key}} patterns
        content = content.replace(new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, "g"), value);
      }

      fs.writeFileSync(destPath, content, "utf-8");
      logger.debug("lane_env_init.env_file_copied", { source: file.source, dest: file.dest });
    }
  }

  async function startDocker(
    worktreePath: string,
    docker: LaneDockerConfig,
    laneId: string
  ): Promise<{ exitCode: number; stderr: string }> {
    if (!docker.composePath?.trim()) {
      logger.warn("lane_env_init.docker_compose_missing", { path: docker.composePath ?? "" });
      return { exitCode: 0, stderr: "" };
    }
    const composePath = path.resolve(projectRoot, docker.composePath);
    if (!fs.existsSync(composePath)) {
      logger.warn("lane_env_init.docker_compose_missing", { path: docker.composePath });
      return { exitCode: 0, stderr: "" };
    }

    const projectName = buildDockerProjectName(laneId, docker.projectPrefix);
    const args = [
      "compose",
      "-f", composePath,
      "-p", projectName,
      "up", "-d"
    ];

    if (docker.services?.length) {
      args.push(...docker.services);
    }

    return execCommand(["docker", ...args], worktreePath, 300_000);
  }

  async function installDependencies(
    worktreePath: string,
    deps: LaneDependencyInstallConfig[]
  ): Promise<{ failures: string[] }> {
    const failures: string[] = [];
    for (const dep of deps) {
      const cwd = dep.cwd ? path.resolve(worktreePath, dep.cwd) : worktreePath;
      const result = await execCommand(dep.command, cwd);
      if (result.exitCode !== 0) {
        failures.push(`${dep.command.join(" ")}: ${result.stderr.slice(0, 500)}`);
        logger.warn("lane_env_init.dependency_install_failed", {
          command: dep.command.join(" "),
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 500)
        });
      }
    }
    return { failures };
  }

  function setupMountPoints(
    worktreePath: string,
    mountPoints: LaneMountPointConfig[]
  ): void {
    for (const mp of mountPoints) {
      const sourcePath = path.resolve(adeDir, mp.source);
      const destPath = path.resolve(worktreePath, mp.dest);

      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      if (!fs.existsSync(sourcePath)) {
        logger.warn("lane_env_init.mount_source_missing", { source: mp.source });
        continue;
      }

      // Copy file (not symlink, to avoid cross-worktree issues)
      fs.copyFileSync(sourcePath, destPath);
      logger.debug("lane_env_init.mount_point_setup", { source: mp.source, dest: mp.dest });
    }
  }

  function setupCopyPaths(
    worktreePath: string,
    copyPaths: LaneCopyPathConfig[]
  ): void {
    for (const cp of copyPaths) {
      const sourcePath = path.resolve(projectRoot, cp.source);
      const dest = cp.dest ?? cp.source;
      const destPath = path.resolve(worktreePath, dest);

      if (!fs.existsSync(sourcePath)) {
        logger.warn("lane_env_init.copy_path_missing", { source: cp.source });
        continue;
      }

      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        // Recursive directory copy
        fs.cpSync(sourcePath, destPath, { recursive: true, force: true });
        logger.debug("lane_env_init.copy_path_dir", { source: cp.source, dest });
      } else {
        // Single file copy
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(sourcePath, destPath);
        logger.debug("lane_env_init.copy_path_file", { source: cp.source, dest });
      }
    }
  }

  function buildLaneVars(lane: LaneSummary, overrides: LaneOverlayOverrides): Record<string, string> {
    const slug = lane.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "lane";
    const portStart = overrides.portRange?.start ?? 3000;
    const portEnd = overrides.portRange?.end ?? 3099;
    const hostname = overrides.proxyHostname ?? `${slug}.localhost`;

    return {
      LANE_ID: lane.id,
      LANE_NAME: lane.name,
      LANE_SLUG: slug,
      LANE_BRANCH: lane.branchRef,
      LANE_WORKTREE: lane.worktreePath,
      PORT_RANGE_START: String(portStart),
      PORT_RANGE_END: String(portEnd),
      PORT: String(portStart),
      HOSTNAME: hostname,
      PROXY_HOSTNAME: hostname,
      ...(overrides.env ?? {})
    };
  }

  function normalizeEnvInitConfig(config: LaneEnvInitConfig): LaneEnvInitConfig | undefined {
    const normalized: LaneEnvInitConfig = {
      ...(config.envFiles?.length ? { envFiles: config.envFiles } : {}),
      ...(config.docker ? { docker: config.docker } : {}),
      ...(config.dependencies?.length ? { dependencies: config.dependencies } : {}),
      ...(config.mountPoints?.length ? { mountPoints: config.mountPoints } : {}),
      ...(config.copyPaths?.length ? { copyPaths: config.copyPaths } : {})
    };

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  return {
    /**
     * Initialize environment for a newly created lane.
     * Runs env file templating, Docker startup, dependency install, and mount points.
     */
    async initLaneEnvironment(
      lane: LaneSummary,
      config: LaneEnvInitConfig,
      overrides: LaneOverlayOverrides
    ): Promise<LaneEnvInitProgress> {
      const steps: LaneEnvInitStep[] = [];
      if (config.envFiles && config.envFiles.length > 0) {
        steps.push(makeStep("env-files", `Copy ${config.envFiles.length} env file(s)`));
      }
      if (config.docker) {
        steps.push(makeStep("docker", "Start Docker services"));
      }
      if (config.dependencies && config.dependencies.length > 0) {
        steps.push(makeStep("dependencies", `Install dependencies (${config.dependencies.length} command(s))`));
      }
      if (config.mountPoints && config.mountPoints.length > 0) {
        steps.push(makeStep("mount-points", `Setup ${config.mountPoints.length} mount point(s)`));
      }
      if (config.copyPaths && config.copyPaths.length > 0) {
        steps.push(makeStep("copy-paths", `Copy ${config.copyPaths.length} path(s)`));
      }

      if (steps.length === 0) {
        const progress: LaneEnvInitProgress = {
          laneId: lane.id,
          steps: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          overallStatus: "completed"
        };
        progressMap.set(lane.id, progress);
        return progress;
      }

      const progress: LaneEnvInitProgress = {
        laneId: lane.id,
        steps,
        startedAt: new Date().toISOString(),
        overallStatus: "running"
      };
      progressMap.set(lane.id, progress);
      broadcastEvent({ type: "lane-env-init", progress });

      const laneVars = buildLaneVars(lane, overrides);

      // Step 1: Env files
      if (config.envFiles && config.envFiles.length > 0) {
        const ok = await runStep(progress, lane.id, "env-files", async () => {
          await copyEnvFiles(lane.worktreePath, config.envFiles!, laneVars);
          return null;
        });
        if (!ok) return progress;
      }

      // Step 2: Docker
      if (config.docker) {
        const docker = config.docker;
        const ok = await runStep(progress, lane.id, "docker", async () => {
          const result = await startDocker(lane.worktreePath, docker, lane.id);
          return result.exitCode !== 0 ? result.stderr.slice(0, 500) : null;
        });
        if (!ok) return progress;
      }

      // Step 3: Dependencies
      if (config.dependencies && config.dependencies.length > 0) {
        const deps = config.dependencies;
        const ok = await runStep(progress, lane.id, "dependencies", async () => {
          const { failures } = await installDependencies(lane.worktreePath, deps);
          return failures.length > 0 ? failures.join("; ") : null;
        });
        if (!ok) return progress;
      }

      // Step 4: Mount points
      if (config.mountPoints && config.mountPoints.length > 0) {
        const mounts = config.mountPoints;
        const ok = await runStep(progress, lane.id, "mount-points", async () => {
          setupMountPoints(lane.worktreePath, mounts);
          return null;
        });
        if (!ok) return progress;
      }

      // Step 5: Copy paths (files and directories from project root)
      if (config.copyPaths && config.copyPaths.length > 0) {
        const paths = config.copyPaths;
        const ok = await runStep(progress, lane.id, "copy-paths", async () => {
          setupCopyPaths(lane.worktreePath, paths);
          return null;
        });
        if (!ok) return progress;
      }

      progress.overallStatus = "completed";
      progress.completedAt = new Date().toISOString();
      progressMap.set(lane.id, progress);
      broadcastEvent({ type: "lane-env-init", progress });
      logger.info("lane_env_init.completed", { laneId: lane.id, steps: steps.length });
      return progress;
    },

    /**
     * Get the current or last env init progress for a lane.
     */
    getProgress(laneId: string): LaneEnvInitProgress | null {
      return progressMap.get(laneId) ?? null;
    },

    /**
     * Clean up Docker resources for a lane (called on lane deletion).
     */
    async cleanupLaneEnvironment(
      lane: LaneSummary,
      config: LaneEnvInitConfig | undefined
    ): Promise<void> {
      if (!config?.docker) return;
      if (!config.docker.composePath?.trim()) {
        logger.warn("lane_env_cleanup.docker_compose_missing", { laneId: lane.id, path: config.docker.composePath ?? "" });
        progressMap.delete(lane.id);
        return;
      }
      const projectName = buildDockerProjectName(lane.id, config.docker.projectPrefix);
      const composePath = path.resolve(projectRoot, config.docker.composePath);
      if (!fs.existsSync(composePath)) {
        logger.warn("lane_env_cleanup.docker_compose_missing", { laneId: lane.id, path: config.docker.composePath });
        progressMap.delete(lane.id);
        return;
      }
      try {
        await execCommand(
          ["docker", "compose", "-f", composePath, "-p", projectName, "down", "--remove-orphans"],
          projectRoot,
          60_000
        );
        logger.info("lane_env_cleanup.docker_down", { laneId: lane.id, projectName });
      } catch (err: any) {
        logger.warn("lane_env_cleanup.docker_down_failed", { laneId: lane.id, error: err?.message });
      }
      progressMap.delete(lane.id);
    },

    /**
     * Resolve the effective env init config for a lane, merging project defaults with overlay overrides.
     */
    resolveEnvInitConfig(
      projectDefault: LaneEnvInitConfig | undefined,
      overlayOverrides: LaneOverlayOverrides
    ): LaneEnvInitConfig | undefined {
      const normalizedDefault = projectDefault ? normalizeEnvInitConfig(projectDefault) : undefined;
      return mergeLaneEnvInitConfig(normalizedDefault, overlayOverrides.envInit);
    },

    dispose(): void {
      progressMap.clear();
    }
  };
}
