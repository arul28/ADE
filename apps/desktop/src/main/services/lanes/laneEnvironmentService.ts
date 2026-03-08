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
  LaneDockerConfig,
  LaneOverlayOverrides,
  LaneSummary
} from "../../../shared/types";

import type { Logger } from "../logging/logger";

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

  function execCommand(
    command: string[],
    cwd: string,
    timeoutMs = 120_000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const [cmd, ...args] = command;
      const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (error as any).code ?? 1 : 0,
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
        content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      }

      fs.writeFileSync(destPath, content, "utf-8");
      logger.debug("lane_env_init.env_file_copied", { source: file.source, dest: file.dest });
    }
  }

  async function startDocker(
    worktreePath: string,
    docker: LaneDockerConfig,
    laneSlug: string
  ): Promise<{ exitCode: number; stderr: string }> {
    const composePath = path.resolve(projectRoot, docker.composePath);
    if (!fs.existsSync(composePath)) {
      logger.warn("lane_env_init.docker_compose_missing", { path: docker.composePath });
      return { exitCode: 0, stderr: "" };
    }

    const projectName = `${docker.projectPrefix ?? "ade"}-${laneSlug}`;
    const args = [
      "compose",
      "-f", composePath,
      "-p", projectName,
      "up", "-d"
    ];

    if (docker.services && docker.services.length > 0) {
      args.push(...docker.services);
    }

    return await execCommand(["docker", ...args], worktreePath, 300_000);
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
        const startTime = Date.now();
        updateStep(progress, "env-files", { status: "running" });
        try {
          await copyEnvFiles(lane.worktreePath, config.envFiles, laneVars);
          updateStep(progress, "env-files", { status: "completed", durationMs: Date.now() - startTime });
        } catch (err: any) {
          updateStep(progress, "env-files", {
            status: "failed",
            error: err?.message ?? String(err),
            durationMs: Date.now() - startTime
          });
          progress.overallStatus = "failed";
          progress.completedAt = new Date().toISOString();
          progressMap.set(lane.id, progress);
          broadcastEvent({ type: "lane-env-init", progress });
          return progress;
        }
      }

      // Step 2: Docker
      if (config.docker) {
        const startTime = Date.now();
        updateStep(progress, "docker", { status: "running" });
        try {
          const slug = laneVars.LANE_SLUG;
          const result = await startDocker(lane.worktreePath, config.docker, slug);
          if (result.exitCode !== 0) {
            updateStep(progress, "docker", {
              status: "failed",
              error: result.stderr.slice(0, 500),
              durationMs: Date.now() - startTime
            });
            progress.overallStatus = "failed";
            progress.completedAt = new Date().toISOString();
            progressMap.set(lane.id, progress);
            broadcastEvent({ type: "lane-env-init", progress });
            return progress;
          }
          updateStep(progress, "docker", { status: "completed", durationMs: Date.now() - startTime });
        } catch (err: any) {
          updateStep(progress, "docker", {
            status: "failed",
            error: err?.message ?? String(err),
            durationMs: Date.now() - startTime
          });
          progress.overallStatus = "failed";
          progress.completedAt = new Date().toISOString();
          progressMap.set(lane.id, progress);
          broadcastEvent({ type: "lane-env-init", progress });
          return progress;
        }
      }

      // Step 3: Dependencies
      if (config.dependencies && config.dependencies.length > 0) {
        const startTime = Date.now();
        updateStep(progress, "dependencies", { status: "running" });
        try {
          const { failures } = await installDependencies(lane.worktreePath, config.dependencies);
          if (failures.length > 0) {
            updateStep(progress, "dependencies", {
              status: "failed",
              error: failures.join("; "),
              durationMs: Date.now() - startTime
            });
            progress.overallStatus = "failed";
            progress.completedAt = new Date().toISOString();
            progressMap.set(lane.id, progress);
            broadcastEvent({ type: "lane-env-init", progress });
            return progress;
          }
          updateStep(progress, "dependencies", { status: "completed", durationMs: Date.now() - startTime });
        } catch (err: any) {
          updateStep(progress, "dependencies", {
            status: "failed",
            error: err?.message ?? String(err),
            durationMs: Date.now() - startTime
          });
          progress.overallStatus = "failed";
          progress.completedAt = new Date().toISOString();
          progressMap.set(lane.id, progress);
          broadcastEvent({ type: "lane-env-init", progress });
          return progress;
        }
      }

      // Step 4: Mount points
      if (config.mountPoints && config.mountPoints.length > 0) {
        const startTime = Date.now();
        updateStep(progress, "mount-points", { status: "running" });
        try {
          setupMountPoints(lane.worktreePath, config.mountPoints);
          updateStep(progress, "mount-points", { status: "completed", durationMs: Date.now() - startTime });
        } catch (err: any) {
          updateStep(progress, "mount-points", {
            status: "failed",
            error: err?.message ?? String(err),
            durationMs: Date.now() - startTime
          });
          progress.overallStatus = "failed";
          progress.completedAt = new Date().toISOString();
          progressMap.set(lane.id, progress);
          broadcastEvent({ type: "lane-env-init", progress });
          return progress;
        }
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
      const slug = lane.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "lane";
      const projectName = `${config.docker.projectPrefix ?? "ade"}-${slug}`;
      try {
        await execCommand(
          ["docker", "compose", "-p", projectName, "down", "--remove-orphans"],
          lane.worktreePath,
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
      const overlayInit = overlayOverrides.envInit;
      if (!projectDefault && !overlayInit) return undefined;
      if (!projectDefault) return overlayInit;
      if (!overlayInit) return projectDefault;

      // Merge: overlay extends project defaults
      return {
        envFiles: [...(projectDefault.envFiles ?? []), ...(overlayInit.envFiles ?? [])],
        docker: overlayInit.docker ?? projectDefault.docker,
        dependencies: [...(projectDefault.dependencies ?? []), ...(overlayInit.dependencies ?? [])],
        mountPoints: [...(projectDefault.mountPoints ?? []), ...(overlayInit.mountPoints ?? [])]
      };
    },

    dispose(): void {
      progressMap.clear();
    }
  };
}
