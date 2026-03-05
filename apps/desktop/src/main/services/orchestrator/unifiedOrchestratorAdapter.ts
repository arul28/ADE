import fs from "node:fs";
import path from "node:path";
import type { OrchestratorExecutorAdapter } from "./orchestratorService";
import { createBaseOrchestratorAdapter, shellEscapeArg } from "./baseOrchestratorAdapter";
import {
  classifyWorkerExecutionPath,
  getModelById,
  resolveCliProviderForModel,
  resolveModelAlias,
  resolveModelDescriptor,
} from "../../../shared/modelRegistry";
import { resolveClaudeCliModel, resolveCodexCliModel } from "../ai/claudeModelUtils";
import { mapPermissionToClaude, mapPermissionToCodex } from "./permissionMapping";

/**
 * Build environment variable assignments for worker identity.
 * These env vars allow the MCP server to auto-populate caller context.
 */
function buildWorkerEnvVars(args: {
  missionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
}): string[] {
  return [
    `ADE_MISSION_ID=${shellEscapeArg(args.missionId)}`,
    `ADE_RUN_ID=${shellEscapeArg(args.runId)}`,
    `ADE_STEP_ID=${shellEscapeArg(args.stepId)}`,
    `ADE_ATTEMPT_ID=${shellEscapeArg(args.attemptId)}`,
    `ADE_DEFAULT_ROLE=agent`
  ];
}

export function resolveAdeMcpServerLaunch(args: {
  workspaceRoot: string;
  runtimeRoot: string;
  missionId?: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  defaultRole?: string;
}): {
  command: string;
  cmdArgs: string[];
  env: Record<string, string>;
} {
  const mcpServerDir = path.resolve(args.runtimeRoot, "apps", "mcp-server");
  const builtEntry = path.join(mcpServerDir, "dist", "index.cjs");
  const srcEntry = path.join(mcpServerDir, "src", "index.ts");

  let command: string;
  let cmdArgs: string[];

  if (fs.existsSync(builtEntry)) {
    command = "node";
    cmdArgs = [builtEntry, "--project-root", args.workspaceRoot];
  } else {
    command = "npx";
    cmdArgs = ["tsx", srcEntry, "--project-root", args.workspaceRoot];
  }

  return {
    command,
    cmdArgs,
    env: {
      ADE_PROJECT_ROOT: args.workspaceRoot,
      ADE_MISSION_ID: args.missionId ?? "",
      ADE_RUN_ID: args.runId ?? "",
      ADE_STEP_ID: args.stepId ?? "",
      ADE_ATTEMPT_ID: args.attemptId ?? "",
      ADE_DEFAULT_ROLE: args.defaultRole ?? "agent",
    }
  };
}

export function getUnifiedUnsupportedModelReason(modelRef: string): string | null {
  const descriptor = resolveModelDescriptor(modelRef);
  if (!descriptor) {
    return `Model '${modelRef}' is not registered.`;
  }
  const cliProvider = resolveCliProviderForModel(descriptor);
  if (cliProvider) return null;
  const executionPath = classifyWorkerExecutionPath(descriptor);
  return `Model '${descriptor.id}' requires ${executionPath} execution (${descriptor.family}), but the unified worker adapter currently supports only Claude/Codex CLI models.`;
}

/**
 * Write a temporary MCP config JSON file for Claude CLI's --mcp-config flag.
 * The config tells Claude CLI to connect to the ADE MCP server via stdio.
 */
function writeMcpConfigFile(args: {
  workspaceRoot: string;
  runtimeRoot: string;
  runId: string;
  attemptId: string;
  missionId: string;
  stepId: string;
}): string {
  const configDir = path.join(args.workspaceRoot, ".ade", "orchestrator", "mcp-configs");
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, `worker-${args.attemptId}.json`);

  const launch = resolveAdeMcpServerLaunch({
    workspaceRoot: args.workspaceRoot,
    runtimeRoot: args.runtimeRoot,
    missionId: args.missionId,
    runId: args.runId,
    stepId: args.stepId,
    attemptId: args.attemptId,
    defaultRole: "agent"
  });

  const config = {
    mcpServers: {
      ade: {
        command: launch.command,
        args: launch.cmdArgs,
        env: launch.env
      }
    }
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

function workerLocalMcpConfigFileName(attemptId: string): string {
  const sanitized = attemptId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `.ade-worker-mcp-${sanitized}.json`;
}

/**
 * Resolve the project root from the current working directory.
 * Walks up from cwd looking for package.json with the monorepo marker.
 */
export function resolveUnifiedRuntimeRoot(): string {
  // The adapter runs inside the desktop Electron process.
  // The project root is the monorepo root (parent of apps/).
  // Walk up from __dirname to find the root containing apps/mcp-server.
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "apps", "mcp-server", "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Build Codex CLI `-c` config override flags to inject the ADE MCP server.
 * Codex reads MCP servers from `mcp_servers.<name>` in its config, and the
 * `-c key=value` flag overrides individual dotted TOML paths.
 */
function buildCodexMcpConfigFlags(args: {
  workspaceRoot: string;
  runtimeRoot: string;
  missionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
}): string[] {
  const launch = resolveAdeMcpServerLaunch({
    workspaceRoot: args.workspaceRoot,
    runtimeRoot: args.runtimeRoot,
    missionId: args.missionId,
    runId: args.runId,
    stepId: args.stepId,
    attemptId: args.attemptId,
    defaultRole: "agent"
  });

  // Codex -c flag parses values as TOML
  const argsToml = `[${launch.cmdArgs.map((a) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`;
  const flags: string[] = [
    "-c", `mcp_servers.ade.command="${launch.command}"`,
    "-c", `mcp_servers.ade.args=${argsToml}`,
    "-c", `mcp_servers.ade.env.ADE_PROJECT_ROOT="${launch.env.ADE_PROJECT_ROOT}"`,
    "-c", `mcp_servers.ade.env.ADE_MISSION_ID="${launch.env.ADE_MISSION_ID}"`,
    "-c", `mcp_servers.ade.env.ADE_RUN_ID="${launch.env.ADE_RUN_ID}"`,
    "-c", `mcp_servers.ade.env.ADE_STEP_ID="${launch.env.ADE_STEP_ID}"`,
    "-c", `mcp_servers.ade.env.ADE_ATTEMPT_ID="${launch.env.ADE_ATTEMPT_ID}"`,
    "-c", `mcp_servers.ade.env.ADE_DEFAULT_ROLE="${launch.env.ADE_DEFAULT_ROLE}"`
  ];
  return flags;
}

/**
 * Remove a single worker MCP config file created by writeMcpConfigFile.
 */
export function cleanupMcpConfigFile(projectRoot: string, attemptId: string, laneWorktreePath?: string | null): void {
  const configPath = path.join(projectRoot, ".ade", "orchestrator", "mcp-configs", `worker-${attemptId}.json`);
  try {
    fs.unlinkSync(configPath);
  } catch {
    // Ignore — file may already be removed or never created
  }
  const localConfigName = workerLocalMcpConfigFileName(attemptId);
  if (laneWorktreePath && laneWorktreePath.trim().length > 0) {
    try {
      fs.unlinkSync(path.join(laneWorktreePath, localConfigName));
    } catch {
      // Ignore — lane-local config may not exist.
    }
  }
}

/**
 * Remove all stale MCP config files from previous runs.
 * Called at adapter creation time.
 */
function cleanupStaleMcpConfigFiles(projectRoot: string): void {
  const configDir = path.join(projectRoot, ".ade", "orchestrator", "mcp-configs");
  try {
    const entries = fs.readdirSync(configDir);
    for (const entry of entries) {
      if (entry.startsWith("worker-") && entry.endsWith(".json")) {
        try {
          fs.unlinkSync(path.join(configDir, entry));
        } catch {
          // Ignore individual file removal errors
        }
      }
    }
  } catch {
    // Directory may not exist yet — that's fine
  }
}

/** @deprecated Kept only as fallback when _providers is absent. Prefer per-provider mapping. */
function resolveCliMode(permissionConfig: { cli?: { mode?: "read-only" | "edit" | "full-auto" } } | undefined): "read-only" | "edit" | "full-auto" {
  const mode = permissionConfig?.cli?.mode;
  if (mode === "read-only" || mode === "edit" || mode === "full-auto") return mode;
  return "full-auto";
}

/**
 * Unified orchestrator adapter that handles ALL model providers.
 * For CLI-wrapped models (Claude CLI, Codex CLI), it delegates to the appropriate CLI.
 * For API-key models, it constructs a direct SDK invocation command.
 */
export function createUnifiedOrchestratorAdapter(options?: {
  workspaceRoot?: string;
  runtimeRoot?: string;
}): OrchestratorExecutorAdapter {
  const runtimeRoot = typeof options?.runtimeRoot === "string" && options.runtimeRoot.trim().length
    ? options.runtimeRoot.trim()
    : resolveUnifiedRuntimeRoot();
  const workspaceRoot = typeof options?.workspaceRoot === "string" && options.workspaceRoot.trim().length
    ? options.workspaceRoot.trim()
    : runtimeRoot;

  // Clean up stale MCP config files from previous runs
  cleanupStaleMcpConfigFiles(workspaceRoot);

  return createBaseOrchestratorAdapter({
    executorKind: "unified",
    sessionType: "ai-orchestrated",

    buildOverrideCommand: ({ prompt }) => {
      // For override commands, try to detect the best CLI
      // Default to claude since it's the most common
      return `exec claude -p ${shellEscapeArg(prompt)}`;
    },

    buildStartupCommand: ({ prompt, model, step, run, attempt, permissionConfig, teamRuntime }) => {
      const descriptor = getModelById(model) ?? resolveModelAlias(model);
      const workerEnv = buildWorkerEnvVars({
        missionId: run.missionId,
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id
      });
      const mcpIdentity = {
        workspaceRoot,
        runtimeRoot,
        missionId: run.missionId,
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id
      };

      // Determine which CLI to use based on the model
      if (descriptor?.isCliWrapped && descriptor.family === "anthropic") {
        // Claude CLI path — use per-provider permission when available
        const cliModel = resolveClaudeCliModel(descriptor?.sdkModelId ?? model);
        const claudeProviderMode = permissionConfig?._providers?.claude;
        const mappedClaude = mapPermissionToClaude(claudeProviderMode);
        const dangerouslySkip = mappedClaude === "bypassPermissions";
        const permissionMode = mappedClaude === "bypassPermissions" ? "acceptEdits" : mappedClaude;
        const allowedTools = permissionConfig?._providers?.allowedTools ?? permissionConfig?.cli?.allowedTools ?? [];

        const parts: string[] = ["claude", "--model", shellEscapeArg(cliModel)];

        if (dangerouslySkip) {
          parts.push("--dangerously-skip-permissions");
        } else {
          parts.push("--permission-mode", shellEscapeArg(permissionMode));
        }

        for (const tool of allowedTools) {
          if (tool.trim().length) parts.push("--allowedTools", shellEscapeArg(tool.trim()));
        }

        // Bind ADE MCP server to worker via --mcp-config. Mirror config into worker CWD
        // so Claude native teammates inherit an MCP config path available from that directory.
        const mcpConfigPath = writeMcpConfigFile(mcpIdentity);
        const localMcpConfigName = workerLocalMcpConfigFileName(attempt.id);
        parts.push("--mcp-config", shellEscapeArg(localMcpConfigName));

        parts.push("-p", shellEscapeArg(prompt));

        const envParts: string[] = [...workerEnv];
        if (
          teamRuntime?.enabled
          && teamRuntime.allowClaudeAgentTeams !== false
          && (teamRuntime.targetProvider === "claude" || teamRuntime.targetProvider === "auto")
        ) {
          envParts.push("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
        }

        const cmd = parts.join(" ");
        const copyMcpIntoCwd = `cp ${shellEscapeArg(mcpConfigPath)} ${shellEscapeArg(localMcpConfigName)}`;
        const startup = `${copyMcpIntoCwd} && exec ${cmd}`;
        return envParts.length > 0 ? `${envParts.join(" ")} ${startup}` : startup;
      }

      if (descriptor?.isCliWrapped && descriptor.family === "openai") {
        // Codex CLI path — use per-provider permission when available
        const codexProviderMode = permissionConfig?._providers?.codex;
        const mappedCodex = mapPermissionToCodex(codexProviderMode);
        const approvalPolicy = mappedCodex?.approvalPolicy ?? "untrusted";
        const sandboxMode = permissionConfig?._providers?.codexSandbox ?? permissionConfig?.cli?.sandboxPermissions ?? "workspace-write";
        const writablePaths = permissionConfig?._providers?.writablePaths ?? permissionConfig?.cli?.writablePaths ?? [];

        const parts: string[] = [
          "codex", "--model", shellEscapeArg(resolveCodexCliModel(descriptor.sdkModelId)),
          "-a", shellEscapeArg(approvalPolicy),
          "-s", shellEscapeArg(sandboxMode)
        ];

        // Inject ADE MCP server config via -c overrides
        parts.push(...buildCodexMcpConfigFlags(mcpIdentity));

        parts.push("exec");

        for (const wp of writablePaths) {
          if (wp.trim().length) parts.push("--add-dir", shellEscapeArg(wp.trim()));
        }

        parts.push(shellEscapeArg(prompt));

        const envParts = [...workerEnv];
        const cmd = parts.join(" ");
        return envParts.length > 0 ? `${envParts.join(" ")} exec ${cmd}` : `exec ${cmd}`;
      }

      // Non-CLI or unknown models cannot run via this shell-based adapter.
      const unsupportedReason = getUnifiedUnsupportedModelReason(model) ?? `Model '${model}' is not supported by unified adapter.`;
      const failureMessage = `[ADE] Unified orchestrator adapter currently supports CLI-wrapped Anthropic/OpenAI models only. ${unsupportedReason} Select a CLI model for this worker.`;
      return `printf '%s\\n' ${shellEscapeArg(failureMessage)} >&2; exit 64`;
    },

    buildAcceptedMetadata: ({ model, filePatterns, steeringDirectiveCount, promptLength, reasoningEffort, startupCommandPreview }) => {
      const descriptor = getModelById(model);
      return {
        adapterKind: "unified",
        model,
        modelFamily: descriptor?.family ?? "unknown",
        isCliWrapped: descriptor?.isCliWrapped ?? true,
        reasoningEffort,
        filePatterns: filePatterns.length ? filePatterns : undefined,
        steeringDirectiveCount,
        promptLength,
        startupCommandPreview
      };
    }
  });
}
