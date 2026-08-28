import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
import { laneSetupScriptHasWork } from "../../../shared/types";

import type { Logger } from "../logging/logger";
import {
  resolvePathWithinRoot,
  secureCopyPathIntoRoot,
  secureWriteFileWithinRoot,
} from "../shared/utils";
import {
  resolveCliSpawnInvocation,
  resolveWindowsCmdLineInvocation,
  terminateProcessTree,
  type SpawnInvocation,
} from "../shared/processExecution";
import { mergeLaneEnvInitConfig } from "./laneEnvInitMerge";
import {
  resolveSetupScriptConfig,
  unsupportedWindowsScriptPathError,
  type ResolvedSetupScript,
} from "./setupScriptConfig";

/** Resolve a relative path against `root` and throw if it escapes.  Logs a warning on escape. */
function resolveCheckedPath(
  root: string,
  relative: string,
  logger: Logger,
  logTag: string,
  logContext: Record<string, string>,
  opts: { allowMissing?: boolean } = {},
): string {
  try {
    return resolvePathWithinRoot(root, relative, opts);
  } catch (err) {
    if (err instanceof Error && err.message === "Path escapes root") {
      logger.warn(logTag, logContext);
      throw new Error("Path escapes allowed directory");
    }
    throw err;
  }
}

function isPathEscapeError(error: unknown): boolean {
  return error instanceof Error && error.message === "Path escapes allowed directory";
}

function secureWriteTextFile(
  root: string,
  relative: string,
  content: string,
  logger: Logger,
  logTag: string,
  logContext: Record<string, string>,
): void {
  try {
    secureWriteFileWithinRoot(root, relative, content, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message === "Path escapes root") {
      logger.warn(logTag, logContext);
      throw new Error("Path escapes allowed directory");
    }
    throw error;
  }
}

function secureCopyPath(
  sourceRoot: string,
  sourceRelative: string,
  destRoot: string,
  destRelative: string,
  logger: Logger,
  sourceLogTag: string,
  sourceLogContext: Record<string, string>,
  destLogTag: string,
  destLogContext: Record<string, string>,
): void {
  const sourcePath = resolveCheckedPath(sourceRoot, sourceRelative, logger, sourceLogTag, sourceLogContext, { allowMissing: true });
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  try {
    secureCopyPathIntoRoot(destRoot, destRelative, sourcePath);
  } catch (error) {
    if (error instanceof Error && error.message === "Path escapes root") {
      logger.warn(destLogTag, destLogContext);
      throw new Error("Path escapes allowed directory");
    }
    throw error;
  }
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

/**
 * Free-form setup COMMANDS are user-authored shell lines, not argv — they
 * legitimately use pipes, `&&`, and variable expansion — so they run through
 * the platform shell rather than a bare spawn. Windows goes through the
 * canonical `resolveWindowsCmdLineInvocation` helper (ComSpec + `/d /s /c` +
 * `windowsVerbatimArguments`) so `%VAR%` expands the way the template UI
 * promises.
 */
function resolveShellInvocation(commandLine: string, env: NodeJS.ProcessEnv): SpawnInvocation {
  if (process.platform === "win32") return resolveWindowsCmdLineInvocation(commandLine, env);
  return { command: "/bin/sh", args: ["-c", commandLine], windowsVerbatimArguments: false };
}

/** Timeout per setup command / script, matching the Docker step's budget. */
const SETUP_SCRIPT_TIMEOUT_MS = 300_000;

/**
 * Shown when the project's shared (repo-committed) config has not been trusted
 * yet. Setup scripts run unrestricted shell, and `.ade/ade.yaml` is a file any
 * contributor can push, so an untrusted shared config fails the step rather
 * than executing it — or silently skipping, which would look like success.
 */
const SHARED_CONFIG_UNTRUSTED_MESSAGE =
  "This project's shared configuration isn't trusted yet. Trust it in ADE's desktop Settings to run setup scripts.";

export function createLaneEnvironmentService({
  projectRoot,
  adeDir,
  logger,
  broadcastEvent,
  projectConfigService
}: {
  projectRoot: string;
  adeDir: string;
  logger: Logger;
  broadcastEvent: (ev: LaneEnvInitEvent) => void;
  /**
   * Trust gate for the setup-script step. `laneEnvInit` and `laneTemplates`
   * both merge in from `.ade/ade.yaml`, which is repo-committed and therefore
   * attacker-supplied on any clone, so the shell the setup step runs must be
   * gated the same way test suites are (`getExecutableConfig` throws
   * `ADE_TRUST_REQUIRED` while the shared config is untrusted).
   *
   * Required, not optional: a security gate whose default is "off" is one
   * forgotten wiring away from running an untrusted repo's shell. Tests that do
   * not exercise trust pass `{ getExecutableConfig: () => ({}) }`.
   */
  projectConfigService: { getExecutableConfig: () => unknown };
}) {
  // Track in-progress and completed init progress per lane
  const progressMap = new Map<string, LaneEnvInitProgress>();

  /**
   * Lanes whose most recent env init did not finish — cancelled by a teardown
   * or failed on a step.
   *
   * `restoreUnarchivedLaneDocker` re-runs only the Docker step after a plain
   * unarchive, on the premise that env files, dependencies, mounts, copies and
   * the setup script all completed and would only be clobbered by a re-run.
   * That premise is false for a lane archived mid-init, and the evidence is
   * gone by the time anyone could look: cancellation marks the remaining steps
   * `skipped`, and `cleanupLaneEnvironment` ends with `progressMap.delete`.
   *
   * Durable rather than in-memory because the gap it covers is measured in
   * days: a lane can be archived today and unarchived after a restart. The file
   * lives under `.ade/`, which is local runtime state and gitignored, next to
   * the rest of the per-project state. Entries are removed when a later init
   * for that lane completes; a lane deleted while marked leaves one stale id
   * behind, which is inert (nothing ever unarchives it).
   */
  const incompleteInitMarkerPath = path.join(adeDir, "lane-env-init-incomplete.json");
  let incompleteInitLanes: Set<string> | null = null;

  function loadIncompleteInitLanes(): Set<string> {
    if (incompleteInitLanes) return incompleteInitLanes;
    const loaded = new Set<string>();
    try {
      if (fs.existsSync(incompleteInitMarkerPath)) {
        const parsed = JSON.parse(fs.readFileSync(incompleteInitMarkerPath, "utf8"));
        const laneIds = Array.isArray(parsed?.laneIds) ? parsed.laneIds : [];
        for (const laneId of laneIds) {
          if (typeof laneId === "string" && laneId.length > 0) loaded.add(laneId);
        }
      }
    } catch (error) {
      // A corrupt or unreadable marker file must not break init: treat it as
      // "nothing known incomplete" and let the next write replace it.
      logger.warn("lane_env_init.incomplete_marker_read_failed", {
        path: incompleteInitMarkerPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    incompleteInitLanes = loaded;
    return loaded;
  }

  function persistIncompleteInitLanes(laneIds: Set<string>): void {
    try {
      fs.mkdirSync(path.dirname(incompleteInitMarkerPath), { recursive: true });
      if (laneIds.size === 0) {
        fs.rmSync(incompleteInitMarkerPath, { force: true });
        return;
      }
      fs.writeFileSync(
        incompleteInitMarkerPath,
        JSON.stringify({ laneIds: [...laneIds] }, null, 2),
        "utf8",
      );
    } catch (error) {
      // Best effort: losing the marker degrades unarchive back to docker-only,
      // it must never fail the init or the teardown that triggered it.
      logger.warn("lane_env_init.incomplete_marker_write_failed", {
        path: incompleteInitMarkerPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function markInitIncomplete(laneId: string): void {
    const laneIds = loadIncompleteInitLanes();
    if (laneIds.has(laneId)) return;
    laneIds.add(laneId);
    persistIncompleteInitLanes(laneIds);
  }

  function clearInitIncomplete(laneId: string): void {
    const laneIds = loadIncompleteInitLanes();
    if (!laneIds.delete(laneId)) return;
    persistIncompleteInitLanes(laneIds);
  }

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
    // Only a run that never reached some of its steps left the worktree
    // half-built. A failure on the LAST step still wrote everything before
    // it — marking that incomplete would make a later unarchive re-template
    // env files and re-copy paths over whatever the user has since edited.
    if (progress.steps.some((step) => step.status === "pending")) markInitIncomplete(laneId);
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

  function runSpawn(
    invocation: SpawnInvocation,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const maxBuffer = 10 * 1024 * 1024;
      const timer = setTimeout(() => {
        if (settled) return;
        terminateProcessTree(child);
      }, timeoutMs);
      const append = (current: string, chunk: Buffer): string =>
        current.length >= maxBuffer
          ? current
          : current + chunk.toString("utf8").slice(0, maxBuffer - current.length);
      child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr: error instanceof Error ? error.message : String(error) });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }

  function execCommand(
    command: string[],
    cwd: string,
    timeoutMs = 120_000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [cmd, ...args] = command;
    if (!cmd) {
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Missing command" });
    }
    return runSpawn(resolveCliSpawnInvocation(cmd, args, process.env), cwd, process.env, timeoutMs);
  }

  async function copyEnvFiles(
    worktreePath: string,
    envFiles: LaneEnvFileConfig[],
    laneVars: Record<string, string>
  ): Promise<void> {
    for (const file of envFiles) {
      const sourcePath = resolveCheckedPath(projectRoot, file.source, logger, "lane_env_init.env_file_source_escape", { source: file.source, projectRoot }, { allowMissing: true });

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

      secureWriteTextFile(
        worktreePath,
        file.dest,
        content,
        logger,
        "lane_env_init.env_file_path_escape",
        { dest: file.dest, worktreePath },
      );
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
    const composePath = resolveCheckedPath(projectRoot, docker.composePath, logger, "lane_env_init.docker_compose_escape", { path: docker.composePath, projectRoot }, { allowMissing: true });
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

  const ALLOWED_INSTALL_COMMANDS = new Set([
    "npm", "yarn", "pnpm", "pip", "pip3", "bundle", "cargo", "go", "composer", "poetry", "pipenv", "bun"
  ]);

  async function installDependencies(
    worktreePath: string,
    deps: LaneDependencyInstallConfig[]
  ): Promise<{ failures: string[] }> {
    const failures: string[] = [];
    for (const dep of deps) {
      const baseCommand = dep.command[0];
      if (!ALLOWED_INSTALL_COMMANDS.has(baseCommand)) {
        logger.warn("lane_env_init.dependency_command_not_allowed", { command: baseCommand });
        continue;
      }
      const cwd = resolveCheckedPath(worktreePath, dep.cwd ?? ".", logger, "lane_env_init.dependency_cwd_escape", { cwd: dep.cwd ?? ".", worktreePath });
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
      const sourcePath = resolveCheckedPath(adeDir, mp.source, logger, "lane_env_init.mount_source_path_escape", { source: mp.source, adeDir }, { allowMissing: true });

      if (!fs.existsSync(sourcePath)) {
        logger.warn("lane_env_init.mount_source_missing", { source: mp.source });
        continue;
      }

      // Copy file (not symlink, to avoid cross-worktree issues)
      secureCopyPath(
        adeDir,
        mp.source,
        worktreePath,
        mp.dest,
        logger,
        "lane_env_init.mount_source_path_escape",
        { source: mp.source, adeDir },
        "lane_env_init.mount_dest_path_escape",
        { dest: mp.dest, worktreePath },
      );
      logger.debug("lane_env_init.mount_point_setup", { source: mp.source, dest: mp.dest });
    }
  }

  function setupCopyPaths(
    worktreePath: string,
    copyPaths: LaneCopyPathConfig[]
  ): void {
    for (const cp of copyPaths) {
      const sourcePath = resolveCheckedPath(projectRoot, cp.source, logger, "lane_env_init.copy_source_path_escape", { source: cp.source, projectRoot }, { allowMissing: true });
      const dest = cp.dest ?? cp.source;

      if (!fs.existsSync(sourcePath)) {
        logger.warn("lane_env_init.copy_path_missing", { source: cp.source });
        continue;
      }

      secureCopyPath(
        projectRoot,
        cp.source,
        worktreePath,
        dest,
        logger,
        "lane_env_init.copy_source_path_escape",
        { source: cp.source, projectRoot },
        "lane_env_init.copy_dest_path_escape",
        { dest, worktreePath },
      );
      let sourceIsDirectory = false;
      try {
        sourceIsDirectory = fs.statSync(sourcePath).isDirectory();
      } catch {
        sourceIsDirectory = false;
      }
      logger.debug(sourceIsDirectory ? "lane_env_init.copy_path_dir" : "lane_env_init.copy_path_file", { source: cp.source, dest });
    }
  }

  /**
   * Refuse to execute setup scripts while the project's shared config is
   * untrusted. Returns an operator-facing message to fail the step with, or
   * null when execution is allowed. Non-trust config errors (a malformed
   * `ade.yaml`) propagate and fail the step with their own message.
   */
  function blockedBySharedConfigTrust(laneId: string): string | null {
    try {
      projectConfigService.getExecutableConfig();
      return null;
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "ADE_TRUST_REQUIRED") {
        logger.warn("lane_env_init.setup_script_untrusted", { laneId });
        return SHARED_CONFIG_UNTRUSTED_MESSAGE;
      }
      throw error;
    }
  }

  /**
   * Run the template's setup script as the final init step: each configured
   * command in order, then the script file if one is configured. Fail-fast like
   * every other step — the first non-zero exit returns an error excerpt.
   *
   * Takes the already-resolved script: the caller resolved it to decide whether
   * to emit the step at all, and resolving twice invites the two answers to
   * disagree.
   */
  async function runSetupScript(
    worktreePath: string,
    resolved: ResolvedSetupScript,
    laneVars: Record<string, string>,
    laneId: string
  ): Promise<string | null> {
    const untrusted = blockedBySharedConfigTrust(laneId);
    if (untrusted) return untrusted;

    const env: NodeJS.ProcessEnv = { ...process.env, ...laneVars };
    if (resolved.injectPrimaryPath) {
      // The primary lane's root is the project checkout ADE manages lanes from.
      env.PRIMARY_WORKTREE_PATH = projectRoot;
    }

    const steps: { label: string; invocation: SpawnInvocation }[] = resolved.commands.map(
      (line) => ({ label: line, invocation: resolveShellInvocation(line, env) }),
    );

    if (resolved.scriptPath) {
      const unsupported = unsupportedWindowsScriptPathError(resolved.scriptPath);
      if (unsupported) {
        logger.warn("lane_env_init.setup_script_not_runnable_on_windows", {
          laneId,
          scriptPath: resolved.scriptPath,
        });
        return unsupported;
      }
      const scriptPath = resolveCheckedPath(
        projectRoot,
        resolved.scriptPath,
        logger,
        "lane_env_init.setup_script_path_escape",
        { scriptPath: resolved.scriptPath, projectRoot },
        { allowMissing: true },
      );
      if (!fs.existsSync(scriptPath)) {
        logger.warn("lane_env_init.setup_script_missing", { laneId, scriptPath: resolved.scriptPath });
        return `Setup script not found: ${resolved.scriptPath}`;
      }
      // A configured setup SCRIPT FILE is a path, not a command line, so it gets
      // a real `SpawnInvocation` instead of being pasted into a shell string.
      // `resolveCliSpawnInvocation` is the repo's one answer for "spawn this
      // file": `.ps1` goes through an absolutely-resolved PowerShell
      // (`windows-quirks.md` §3/§8) rather than a PATH-relative
      // `powershell.exe` that a file at the lane worktree root could shadow,
      // `.cmd`/`.bat` go through ComSpec, and POSIX keeps invoking the script
      // path directly — which requires the script to be executable and carry a
      // shebang.
      steps.push({ label: scriptPath, invocation: resolveCliSpawnInvocation(scriptPath, [], env) });
    }

    for (const step of steps) {
      const result = await runSpawn(step.invocation, worktreePath, env, SETUP_SCRIPT_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
        logger.warn("lane_env_init.setup_script_failed", {
          laneId,
          command: step.label,
          exitCode: result.exitCode,
          stderr: detail,
        });
        return `${step.label}: ${detail || `exited with code ${result.exitCode}`}`;
      }
      logger.debug("lane_env_init.setup_script_command_ok", { laneId, command: step.label });
    }
    return null;
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
      ...(config.copyPaths?.length ? { copyPaths: config.copyPaths } : {}),
      // Platform-agnostic on purpose: `resolveSetupScriptConfig` answers "is
      // there work for THIS platform", so using it here dropped a
      // windowsCommands-only script out of the normalized config on macOS —
      // and the normalized config is what merges, persists, and ships to other
      // hosts. `laneSetupScriptHasWork` is the configured-at-all predicate.
      ...(laneSetupScriptHasWork(config.setupScript) ? { setupScript: config.setupScript } : {})
    };

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  /**
   * One promise tail per lane, so init and cleanup for the SAME lane can never
   * interleave.
   *
   * The unarchive Docker restore is deliberately not awaited by its caller
   * (`docker compose up` has a 300s budget and the mobile unarchive command has
   * 30s), so a quick archive/delete right after an unarchive used to run
   * `compose down` while `compose up` was still bringing the stack up — leaving
   * an archived lane with live containers. Different lanes stay fully parallel.
   */
  const laneQueues = new Map<string, Promise<unknown>>();

  /**
   * Lanes whose cleanup is waiting behind an in-flight init.
   *
   * Serializing is not enough on its own: a full init can legitimately run for
   * minutes (dependency installs and `docker compose up` have 120s/300s budgets
   * each, and lane creation kicks init off detached), so an archive or delete
   * arriving mid-init would sit in the queue that whole time with no signal.
   * The cleanup wrapper raises the flag before it enqueues and `runPlannedInit`
   * reads it at every step boundary, so init stops at the next boundary instead
   * of running the rest of a sequence whose lane is about to go away.
   *
   * Cooperative by design: already-spawned children keep their own timeouts,
   * they are not killed here.
   */
  const cleanupRequested = new Set<string>();

  /** Inits that have been enqueued and not yet settled, per lane. */
  const inFlightInits = new Map<string, number>();

  // "Torn down", not "archived": the same cancellation fires for delete and
  // archive-and-reclaim, and naming only archive was wrong for two of the three.
  const CANCELLED_FOR_CLEANUP_MESSAGE = "Cancelled: lane is being torn down";

  /**
   * Stop an init whose lane is being torn down: every step that has not run is
   * marked `skipped` with the cancellation reason, and the run ends as `failed`
   * because it did not do what it set out to do.
   */
  function abortInitForCleanup(
    progress: LaneEnvInitProgress,
    laneId: string,
  ): LaneEnvInitProgress {
    for (const step of progress.steps) {
      if (step.status === "pending") {
        step.status = "skipped";
        step.error = CANCELLED_FOR_CLEANUP_MESSAGE;
      }
    }
    progress.overallStatus = "failed";
    progress.completedAt = new Date().toISOString();
    progressMap.set(laneId, progress);
    // Outlives both this progress entry (the teardown deletes it) and the
    // process, so a later unarchive knows the worktree was left half-built.
    markInitIncomplete(laneId);
    broadcastEvent({ type: "lane-env-init", progress: { ...progress, steps: [...progress.steps] } });
    logger.warn("lane_env_init.cancelled_for_cleanup", {
      laneId,
      skipped: progress.steps.filter((step) => step.status === "skipped").length,
    });
    return progress;
  }

  function withLaneQueue<T>(laneId: string, task: () => Promise<T>): Promise<T> {
    const previous = laneQueues.get(laneId) ?? Promise.resolve();
    // `then(task, task)` — a failed predecessor must not cancel the follower.
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    laneQueues.set(laneId, tail);
    void tail.then(() => {
      // Only the current tail clears the entry; a later enqueue owns it now.
      if (laneQueues.get(laneId) === tail) laneQueues.delete(laneId);
    });
    return run;
  }

  const service = {
    /**
     * Initialize environment for a newly created lane.
     * Runs env file templating, Docker startup, dependency install, and mount points.
     */
    async initLaneEnvironment(
      lane: LaneSummary,
      config: LaneEnvInitConfig,
      overrides: LaneOverlayOverrides
    ): Promise<LaneEnvInitProgress> {
      const laneVars = buildLaneVars(lane, overrides);

      /**
       * The steps to announce and the work each one does, planned together so
       * the two can't disagree about which steps exist — and so the run loop has
       * exactly one boundary at which to honour a queued cleanup.
       *
       * Order is the contract: the setup script runs last, after env files,
       * services, dependencies, mounts and copies are in place.
       */
      const planned: {
        kind: LaneEnvInitStepKind;
        label: string;
        run: () => Promise<string | null>;
      }[] = [];

      const envFiles = config.envFiles;
      if (envFiles && envFiles.length > 0) {
        planned.push({
          kind: "env-files",
          label: `Copy ${envFiles.length} env file(s)`,
          run: async () => {
            await copyEnvFiles(lane.worktreePath, envFiles, laneVars);
            return null;
          },
        });
      }
      const docker = config.docker;
      if (docker) {
        planned.push({
          kind: "docker",
          label: "Start Docker services",
          run: async () => {
            const result = await startDocker(lane.worktreePath, docker, lane.id);
            return result.exitCode !== 0 ? result.stderr.slice(0, 500) : null;
          },
        });
      }
      const dependencies = config.dependencies;
      if (dependencies && dependencies.length > 0) {
        planned.push({
          kind: "dependencies",
          label: `Install dependencies (${dependencies.length} command(s))`,
          run: async () => {
            const { failures } = await installDependencies(lane.worktreePath, dependencies);
            return failures.length > 0 ? failures.join("; ") : null;
          },
        });
      }
      const mountPoints = config.mountPoints;
      if (mountPoints && mountPoints.length > 0) {
        planned.push({
          kind: "mount-points",
          label: `Setup ${mountPoints.length} mount point(s)`,
          run: async () => {
            setupMountPoints(lane.worktreePath, mountPoints);
            return null;
          },
        });
      }
      const copyPaths = config.copyPaths;
      if (copyPaths && copyPaths.length > 0) {
        planned.push({
          kind: "copy-paths",
          label: `Copy ${copyPaths.length} path(s)`,
          run: async () => {
            setupCopyPaths(lane.worktreePath, copyPaths);
            return null;
          },
        });
      }
      // Resolved up front so an unconfigured (or platform-empty) setup script
      // never shows up as an empty step.
      const resolvedSetupScript = resolveSetupScriptConfig(config.setupScript);
      if (resolvedSetupScript) {
        const commandCount = resolvedSetupScript.commands.length + (resolvedSetupScript.scriptPath ? 1 : 0);
        planned.push({
          kind: "setup-script",
          label: `Run setup script (${commandCount} command(s))`,
          run: () => runSetupScript(lane.worktreePath, resolvedSetupScript, laneVars, lane.id),
        });
      }

      const steps: LaneEnvInitStep[] = planned.map((entry) => makeStep(entry.kind, entry.label));

      if (steps.length === 0) {
        const progress: LaneEnvInitProgress = {
          laneId: lane.id,
          steps: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          overallStatus: "completed"
        };
        progressMap.set(lane.id, progress);
        clearInitIncomplete(lane.id);
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

      for (const entry of planned) {
        // Cooperative cancellation point: a queued archive/delete must not wait
        // out the rest of a multi-minute sequence for a lane that is going away.
        if (cleanupRequested.has(lane.id)) return abortInitForCleanup(progress, lane.id);
        const ok = await runStep(progress, lane.id, entry.kind, entry.run);
        if (!ok) return progress;
      }

      progress.overallStatus = "completed";
      progress.completedAt = new Date().toISOString();
      progressMap.set(lane.id, progress);
      // Every planned step ran: whatever was left half-built by an earlier
      // cancelled or failed init has now been redone.
      clearInitIncomplete(lane.id);
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
     * Did this lane's last env init stop before running every planned step?
     *
     * Read by `restoreUnarchivedLaneDocker` to decide between the docker-only
     * restore and a full re-init. Cannot be answered from `getProgress`: the
     * teardown that cancels an init also deletes its progress entry.
     */
    wasLastInitIncomplete(laneId: string): boolean {
      return loadIncompleteInitLanes().has(laneId);
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
      let composePath: string;
      let skipExistsCheck = false;
      try {
        composePath = resolveCheckedPath(
          projectRoot,
          config.docker.composePath,
          logger,
          "lane_env_cleanup.docker_compose_escape",
          { laneId: lane.id, path: config.docker.composePath, projectRoot },
          { allowMissing: true },
        );
      } catch (error) {
        if (isPathEscapeError(error)) {
          progressMap.delete(lane.id);
          return;
        }
        logger.warn("lane_env_cleanup.docker_compose_path_validation_failed", {
          laneId: lane.id,
          path: config.docker.composePath,
          error: error instanceof Error ? error.message : String(error),
        });
        composePath = path.isAbsolute(config.docker.composePath)
          ? config.docker.composePath
          : path.resolve(projectRoot, config.docker.composePath);
        skipExistsCheck = true;
      }
      if (!skipExistsCheck && !fs.existsSync(composePath)) {
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
      laneQueues.clear();
      cleanupRequested.clear();
      inFlightInits.clear();
      // Only the cache is dropped — the on-disk marker is the point.
      incompleteInitLanes = null;
    }
  };

  function noteInitSettled(laneId: string): void {
    const remaining = (inFlightInits.get(laneId) ?? 1) - 1;
    if (remaining > 0) inFlightInits.set(laneId, remaining);
    else inFlightInits.delete(laneId);
  }

  return {
    ...service,
    initLaneEnvironment: (
      lane: LaneSummary,
      config: LaneEnvInitConfig,
      overrides: LaneOverlayOverrides,
    ): Promise<LaneEnvInitProgress> => {
      inFlightInits.set(lane.id, (inFlightInits.get(lane.id) ?? 0) + 1);
      return withLaneQueue(lane.id, () =>
        service.initLaneEnvironment(lane, config, overrides),
      ).finally(() => noteInitSettled(lane.id));
    },
    cleanupLaneEnvironment: (lane: LaneSummary, config: LaneEnvInitConfig | undefined): Promise<void> => {
      // Raised BEFORE enqueuing so an init already running for this lane sees it
      // at its next step boundary rather than after the whole sequence.
      if (inFlightInits.has(lane.id)) {
        cleanupRequested.add(lane.id);
        logger.warn("lane_env_cleanup.waiting_for_inflight_init", { laneId: lane.id });
      }
      return withLaneQueue(lane.id, () => {
        // Cleared as cleanup starts: a later init for this lane (unarchive,
        // re-init) must not inherit a cancellation meant for this teardown.
        cleanupRequested.delete(lane.id);
        return service.cleanupLaneEnvironment(lane, config);
      });
    },
  };
}
