import fs from "node:fs";
import path from "node:path";
import type { OrchestratorExecutorAdapter } from "./orchestratorService";
import { createBaseOrchestratorAdapter, shellEscapeArg } from "./baseOrchestratorAdapter";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { resolveClaudeCliModel, resolveCodexCliModel } from "../ai/claudeModelUtils";

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

/**
 * Write a temporary MCP config JSON file for Claude CLI's --mcp-config flag.
 * The config tells Claude CLI to connect to the ADE MCP server via stdio.
 */
function writeMcpConfigFile(args: {
  projectRoot: string;
  runId: string;
  attemptId: string;
  missionId: string;
  stepId: string;
}): string {
  const configDir = path.join(args.projectRoot, ".ade", "orchestrator", "mcp-configs");
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, `worker-${args.attemptId}.json`);

  // Resolve the MCP server entry point
  // Use the built version if available, otherwise use tsx for dev
  const mcpServerDir = path.resolve(args.projectRoot, "apps", "mcp-server");
  const builtEntry = path.join(mcpServerDir, "dist", "index.cjs");
  const srcEntry = path.join(mcpServerDir, "src", "index.ts");

  let command: string;
  let cmdArgs: string[];

  if (fs.existsSync(builtEntry)) {
    command = "node";
    cmdArgs = [builtEntry, "--project-root", args.projectRoot];
  } else {
    command = "npx";
    cmdArgs = ["tsx", srcEntry, "--project-root", args.projectRoot];
  }

  const config = {
    mcpServers: {
      ade: {
        command,
        args: cmdArgs,
        env: {
          ADE_PROJECT_ROOT: args.projectRoot,
          ADE_MISSION_ID: args.missionId,
          ADE_RUN_ID: args.runId,
          ADE_STEP_ID: args.stepId,
          ADE_ATTEMPT_ID: args.attemptId,
          ADE_DEFAULT_ROLE: "agent"
        }
      }
    }
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

/**
 * Resolve the project root from the current working directory.
 * Walks up from cwd looking for package.json with the monorepo marker.
 */
function resolveProjectRoot(): string {
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
  projectRoot: string;
  missionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
}): string[] {
  const mcpServerDir = path.resolve(args.projectRoot, "apps", "mcp-server");
  const builtEntry = path.join(mcpServerDir, "dist", "index.cjs");
  const srcEntry = path.join(mcpServerDir, "src", "index.ts");

  let command: string;
  let cmdArgs: string[];

  if (fs.existsSync(builtEntry)) {
    command = "node";
    cmdArgs = [builtEntry, "--project-root", args.projectRoot];
  } else {
    command = "npx";
    cmdArgs = ["tsx", srcEntry, "--project-root", args.projectRoot];
  }

  // Codex -c flag parses values as TOML
  const argsToml = `[${cmdArgs.map((a) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`;
  const flags: string[] = [
    "-c", `mcp_servers.ade.command="${command}"`,
    "-c", `mcp_servers.ade.args=${argsToml}`,
    "-c", `mcp_servers.ade.env.ADE_PROJECT_ROOT="${args.projectRoot}"`,
    "-c", `mcp_servers.ade.env.ADE_MISSION_ID="${args.missionId}"`,
    "-c", `mcp_servers.ade.env.ADE_RUN_ID="${args.runId}"`,
    "-c", `mcp_servers.ade.env.ADE_STEP_ID="${args.stepId}"`,
    "-c", `mcp_servers.ade.env.ADE_ATTEMPT_ID="${args.attemptId}"`,
    "-c", `mcp_servers.ade.env.ADE_DEFAULT_ROLE="agent"`
  ];
  return flags;
}

/**
 * Remove a single worker MCP config file created by writeMcpConfigFile.
 */
export function cleanupMcpConfigFile(projectRoot: string, attemptId: string): void {
  const configPath = path.join(projectRoot, ".ade", "orchestrator", "mcp-configs", `worker-${attemptId}.json`);
  try {
    fs.unlinkSync(configPath);
  } catch {
    // Ignore — file may already be removed or never created
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

/**
 * Unified orchestrator adapter that handles ALL model providers.
 * For CLI-wrapped models (Claude CLI, Codex CLI), it delegates to the appropriate CLI.
 * For API-key models, it constructs a direct SDK invocation command.
 */
export function createUnifiedOrchestratorAdapter(): OrchestratorExecutorAdapter {
  const projectRoot = resolveProjectRoot();

  // Clean up stale MCP config files from previous runs
  cleanupStaleMcpConfigFiles(projectRoot);

  return createBaseOrchestratorAdapter({
    executorKind: "unified",
    sessionType: "ai-orchestrated",
    defaultModel: "anthropic/claude-sonnet-4-6",

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
        projectRoot,
        missionId: run.missionId,
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id
      };

      // Determine which CLI to use based on the model
      if (descriptor?.isCliWrapped && descriptor.family === "anthropic") {
        // Claude CLI path
        const cliModel = resolveClaudeCliModel(descriptor?.sdkModelId ?? model);
        const permissionMode =
          typeof step.metadata?.permissionMode === "string" && step.metadata.permissionMode.trim().length
            ? step.metadata.permissionMode.trim()
            : permissionConfig?.claude?.permissionMode ?? "acceptEdits";

        const dangerouslySkip = permissionConfig?.claude?.dangerouslySkipPermissions === true;
        const allowedTools = permissionConfig?.claude?.allowedTools ?? [];

        const parts: string[] = ["claude", "--model", shellEscapeArg(cliModel)];

        if (dangerouslySkip) {
          parts.push("--dangerously-skip-permissions");
        } else {
          parts.push("--permission-mode", shellEscapeArg(permissionMode));
        }

        for (const tool of allowedTools) {
          if (tool.trim().length) parts.push("--allowedTools", shellEscapeArg(tool.trim()));
        }

        // Bind ADE MCP server to worker via --mcp-config
        const mcpConfigPath = writeMcpConfigFile(mcpIdentity);
        parts.push("--mcp-config", shellEscapeArg(mcpConfigPath));

        parts.push("-p", shellEscapeArg(prompt));

        const envParts: string[] = [...workerEnv];
        if (teamRuntime?.enabled && (teamRuntime.targetProvider === "claude" || teamRuntime.targetProvider === "auto")) {
          envParts.push("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
        }

        const cmd = parts.join(" ");
        return envParts.length > 0 ? `${envParts.join(" ")} exec ${cmd}` : `exec ${cmd}`;
      }

      if (descriptor?.isCliWrapped && descriptor.family === "openai") {
        // Codex CLI path — inject ADE MCP server via -c config overrides
        const approvalMode =
          typeof step.metadata?.approvalMode === "string" && step.metadata.approvalMode.trim().length
            ? step.metadata.approvalMode.trim()
            : permissionConfig?.codex?.approvalMode ?? "full-auto";

        const approvalPolicy =
          approvalMode === "suggest" ? "untrusted" :
          approvalMode === "auto-edit" ? "on-request" : "never";

        const sandboxMode =
          typeof step.metadata?.sandboxPermissions === "string" && step.metadata.sandboxPermissions.trim().length
            ? step.metadata.sandboxPermissions.trim()
            : permissionConfig?.codex?.sandboxPermissions ?? "workspace-write";

        const writablePaths = permissionConfig?.codex?.writablePaths ?? [];

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
      const unsupportedReason = !descriptor
        ? `Model '${model}' is not registered.`
        : `Model '${descriptor.id}' is not CLI-wrapped (${descriptor.family}).`;
      const failureMessage = `[ADE] Unified orchestrator adapter currently supports CLI-wrapped Anthropic/OpenAI models only. ${unsupportedReason} Select a CLI model for this worker.`;
      return `printf '%s\\n' ${shellEscapeArg(failureMessage)} >&2; exit 64`;
    },

    buildAcceptedMetadata: ({ model, step, permissionConfig, filePatterns, steeringDirectiveCount, promptLength, reasoningEffort, startupCommandPreview }) => {
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
