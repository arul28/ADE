import fs from "node:fs";
import path from "node:path";
import type { OrchestratorExecutorAdapter } from "./orchestratorService";
import { buildFullPrompt, createBaseOrchestratorAdapter, shellEscapeArg, shellInlineDecodedArg } from "./baseOrchestratorAdapter";
import {
  classifyWorkerExecutionPath,
  getModelById,
  resolveCliProviderForModel,
  resolveModelAlias,
  resolveModelDescriptor,
} from "../../../shared/modelRegistry";
import type {
  AgentChatExecutionMode,
  AgentChatPermissionMode,
  ComputerUsePolicy,
  TeamRuntimeConfig,
} from "../../../shared/types";
import type { MissionPermissionConfig, MissionProviderPermissions } from "../../../shared/types/missions";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { resolveClaudeCliModel, resolveCodexCliModel } from "../ai/claudeModelUtils";
import type { createAgentChatService } from "../chat/agentChatService";
import {
  mapPermissionToClaude,
  mapPermissionToCodex,
  normalizeMissionPermissions,
  providerPermissionsToLegacyConfig,
} from "./permissionMapping";

/**
 * Build environment variable assignments for worker identity.
 * These env vars allow the MCP server to auto-populate caller context.
 */
function buildWorkerEnvVars(args: {
  missionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  ownerId?: string | null;
}): string[] {
  return [
    `ADE_MISSION_ID=${shellEscapeArg(args.missionId)}`,
    `ADE_RUN_ID=${shellEscapeArg(args.runId)}`,
    `ADE_STEP_ID=${shellEscapeArg(args.stepId)}`,
    `ADE_ATTEMPT_ID=${shellEscapeArg(args.attemptId)}`,
    `ADE_DEFAULT_ROLE=agent`,
    ...(args.ownerId ? [`ADE_OWNER_ID=${shellEscapeArg(args.ownerId)}`] : []),
  ];
}

function resolveWorkerOwnerId(metadata: Record<string, unknown> | null | undefined): string | null {
  return typeof metadata?.employeeAgentId === "string" && metadata.employeeAgentId.trim().length > 0
    ? metadata.employeeAgentId.trim()
    : null;
}

export function resolveAdeMcpServerLaunch(args: {
  projectRoot?: string;
  workspaceRoot: string;
  runtimeRoot: string;
  missionId?: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  defaultRole?: string;
  ownerId?: string;
  computerUsePolicy?: ComputerUsePolicy | null;
}): {
  command: string;
  cmdArgs: string[];
  env: Record<string, string>;
} {
  const canonicalProjectRoot = typeof args.projectRoot === "string" && args.projectRoot.trim().length > 0
    ? path.resolve(args.projectRoot)
    : path.resolve(args.workspaceRoot);
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const mcpServerDir = path.resolve(args.runtimeRoot, "apps", "mcp-server");
  const builtEntry = path.join(mcpServerDir, "dist", "index.cjs");
  const srcEntry = path.join(mcpServerDir, "src", "index.ts");

  let command: string;
  let cmdArgs: string[];

  if (fs.existsSync(builtEntry)) {
    command = "node";
    cmdArgs = [builtEntry, "--project-root", canonicalProjectRoot, "--workspace-root", workspaceRoot];
  } else {
    command = "npx";
    cmdArgs = ["tsx", srcEntry, "--project-root", canonicalProjectRoot, "--workspace-root", workspaceRoot];
  }

  return {
    command,
    cmdArgs,
    env: {
      ADE_PROJECT_ROOT: canonicalProjectRoot,
      ADE_WORKSPACE_ROOT: workspaceRoot,
      ADE_MISSION_ID: args.missionId ?? "",
      ADE_RUN_ID: args.runId ?? "",
      ADE_STEP_ID: args.stepId ?? "",
      ADE_ATTEMPT_ID: args.attemptId ?? "",
      ADE_DEFAULT_ROLE: args.defaultRole ?? "agent",
      ADE_OWNER_ID: args.ownerId ?? "",
      ADE_COMPUTER_USE_MODE: args.computerUsePolicy?.mode ?? "",
      ADE_COMPUTER_USE_ALLOW_LOCAL_FALLBACK:
        typeof args.computerUsePolicy?.allowLocalFallback === "boolean"
          ? (args.computerUsePolicy.allowLocalFallback ? "1" : "0")
          : "",
      ADE_COMPUTER_USE_RETAIN_ARTIFACTS:
        typeof args.computerUsePolicy?.retainArtifacts === "boolean"
          ? (args.computerUsePolicy.retainArtifacts ? "1" : "0")
          : "",
      ADE_COMPUTER_USE_PREFERRED_BACKEND: args.computerUsePolicy?.preferredBackend ?? "",
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
  projectRoot: string;
  workspaceRoot: string;
  runtimeRoot: string;
  runId: string;
  attemptId: string;
  missionId: string;
  stepId: string;
  ownerId?: string | null;
}): string {
  const configDir = resolveAdeLayout(args.projectRoot).mcpConfigsDir;
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, `worker-${args.attemptId}.json`);

  const launch = resolveAdeMcpServerLaunch({
    projectRoot: args.projectRoot,
    workspaceRoot: args.workspaceRoot,
    runtimeRoot: args.runtimeRoot,
    missionId: args.missionId,
    runId: args.runId,
    stepId: args.stepId,
    attemptId: args.attemptId,
    defaultRole: "agent",
    ownerId: args.ownerId ?? undefined,
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

function workerPromptFilePath(projectRoot: string, attemptId: string): string {
  return path.join(resolveAdeLayout(projectRoot).workerPromptsDir, `worker-${attemptId}.txt`);
}

const CLAUDE_READ_ONLY_NATIVE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
] as const;

const CLAUDE_READ_ONLY_WORKER_MCP_TOOLS = [
  "mcp__ade__get_mission",
  "mcp__ade__get_run_graph",
  "mcp__ade__stream_events",
  "mcp__ade__get_timeline",
  "mcp__ade__get_pending_messages",
  "mcp__ade__get_computer_use_backend_status",
  "mcp__ade__list_computer_use_artifacts",
  "mcp__ade__ingest_computer_use_artifacts",
  "mcp__ade__report_status",
  "mcp__ade__report_result",
  "mcp__ade__ask_user",
  "mcp__ade__memory_search",
  "mcp__ade__memory_add",
] as const;

function dedupeAllowedTools(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed.length || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function buildClaudeReadOnlyWorkerAllowedTools(serverName = "ade", extraToolNames: readonly string[] = []): string[] {
  const trimmedServerName = serverName.trim();
  const resolvedServerName = trimmedServerName.length > 0 ? trimmedServerName : "ade";
  const mcpTools = CLAUDE_READ_ONLY_WORKER_MCP_TOOLS.map((tool) =>
    tool.replace("mcp__ade__", `mcp__${resolvedServerName}__`),
  );
  return dedupeAllowedTools([
    ...CLAUDE_READ_ONLY_NATIVE_TOOLS,
    ...mcpTools,
    ...extraToolNames.map((tool) => `mcp__${resolvedServerName}__${tool}`),
  ]);
}

function writeWorkerPromptFile(args: {
  projectRoot: string;
  attemptId: string;
  prompt: string;
}): string {
  const promptPath = workerPromptFilePath(args.projectRoot, args.attemptId);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, args.prompt, "utf8");
  return promptPath;
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
export function buildCodexMcpConfigFlags(args: {
  projectRoot?: string;
  workspaceRoot: string;
  runtimeRoot: string;
  missionId?: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  ownerId?: string | null;
  defaultRole?: string;
}): string[] {
  const launch = resolveAdeMcpServerLaunch({
    projectRoot: args.projectRoot,
    workspaceRoot: args.workspaceRoot,
    runtimeRoot: args.runtimeRoot,
    missionId: args.missionId,
    runId: args.runId,
    stepId: args.stepId,
    attemptId: args.attemptId,
    defaultRole: args.defaultRole ?? "agent",
    ownerId: args.ownerId ?? undefined,
  });

  // Codex -c flag parses values as TOML
  const argsToml = `[${launch.cmdArgs.map((a) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`;
  const flags: string[] = [
    "-c", shellEscapeArg(`mcp_servers.ade.command="${launch.command}"`),
    "-c", shellEscapeArg(`mcp_servers.ade.args=${argsToml}`),
    "-c", shellEscapeArg(`mcp_servers.ade.env.ADE_PROJECT_ROOT="${launch.env.ADE_PROJECT_ROOT}"`),
    "-c", shellEscapeArg(`mcp_servers.ade.env.ADE_WORKSPACE_ROOT="${launch.env.ADE_WORKSPACE_ROOT}"`),
    "-c", shellEscapeArg(`mcp_servers.ade.env.ADE_MISSION_ID="${launch.env.ADE_MISSION_ID}"`),
    "-c", shellEscapeArg(`mcp_servers.ade.env.ADE_RUN_ID="${launch.env.ADE_RUN_ID}"`),
    "-c", shellEscapeArg(`mcp_servers.ade.env.ADE_STEP_ID="${launch.env.ADE_STEP_ID}"`),
    "-c", shellEscapeArg(`mcp_servers.ade.env.ADE_ATTEMPT_ID="${launch.env.ADE_ATTEMPT_ID}"`),
    "-c", shellEscapeArg(`mcp_servers.ade.env.ADE_DEFAULT_ROLE="${launch.env.ADE_DEFAULT_ROLE}"`)
  ];
  if (launch.env.ADE_OWNER_ID?.trim()) {
    flags.push("-c", shellEscapeArg(`mcp_servers.ade.env.ADE_OWNER_ID="${launch.env.ADE_OWNER_ID}"`));
  }
  return flags;
}

/**
 * Remove a single worker MCP config file created by writeMcpConfigFile.
 */
export function cleanupMcpConfigFile(projectRoot: string, attemptId: string, laneWorktreePath?: string | null): void {
  const configPath = path.join(resolveAdeLayout(projectRoot).mcpConfigsDir, `worker-${attemptId}.json`);
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
  try {
    fs.unlinkSync(workerPromptFilePath(projectRoot, attemptId));
  } catch {
    // Ignore — prompt file may already be removed or never created.
  }
}

/**
 * Remove all stale MCP config files from previous runs.
 * Called at adapter creation time.
 */
function cleanupStaleFilesInDir(dir: string, prefix: string, suffix: string): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix) && entry.endsWith(suffix)) {
        try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

function cleanupStaleMcpConfigFiles(projectRoot: string): void {
  const layout = resolveAdeLayout(projectRoot);
  cleanupStaleFilesInDir(
    layout.mcpConfigsDir,
    "worker-", ".json",
  );
  cleanupStaleFilesInDir(
    layout.workerPromptsDir,
    "worker-", ".txt",
  );
}

function resolveManagedPermissionMode(args: {
  provider: "claude" | "codex" | "unified";
  permissionConfig: LegacyPermissionConfig | undefined;
  readOnlyExecution: boolean;
}): AgentChatPermissionMode | undefined {
  if (args.readOnlyExecution) return "plan";
  const providers = args.permissionConfig?._providers;
  let candidate: unknown;
  if (args.provider === "claude") candidate = providers?.claude;
  else if (args.provider === "codex") candidate = providers?.codex;
  else candidate = providers?.unified;
  return candidate === "default"
    || candidate === "plan"
    || candidate === "edit"
    || candidate === "full-auto"
    || candidate === "config-toml"
    ? candidate
    : undefined;
}

function resolveManagedExecutionMode(args: {
  provider: "claude" | "codex" | "unified";
  teamRuntime?: TeamRuntimeConfig;
}): AgentChatExecutionMode {
  if (args.provider === "claude") {
    if (
      args.teamRuntime?.enabled
      && args.teamRuntime.allowClaudeAgentTeams !== false
      && (args.teamRuntime.targetProvider === "claude" || args.teamRuntime.targetProvider === "auto")
    ) {
      return "teams";
    }
    return args.teamRuntime?.allowSubAgents === false ? "focused" : "subagents";
  }
  if (args.provider === "codex") {
    return args.teamRuntime?.allowParallelAgents === false ? "focused" : "parallel";
  }
  return "focused";
}

type LegacyPermissionConfig = {
  cli?: {
    mode?: "read-only" | "edit" | "full-auto";
    sandboxPermissions?: "read-only" | "workspace-write" | "danger-full-access";
    writablePaths?: string[];
    allowedTools?: string[];
  };
  inProcess?: {
    mode?: "plan" | "edit" | "full-auto";
  };
  _providers?: MissionProviderPermissions;
};

export function forceReadOnlyPermissionConfig(
  permissionConfig: LegacyPermissionConfig | undefined,
  readOnlyExecution: boolean,
): LegacyPermissionConfig | undefined {
  if (!readOnlyExecution) return permissionConfig;
  const providers = normalizeMissionPermissions(permissionConfig as MissionPermissionConfig | undefined);
  return providerPermissionsToLegacyConfig({
    ...providers,
    claude: "default",
    codex: "plan",
    unified: "plan",
    codexSandbox: "read-only",
    writablePaths: [],
  });
}

/**
 * Unified orchestrator adapter that handles ALL model providers.
 * For CLI-wrapped models (Claude CLI, Codex CLI), it delegates to the appropriate CLI.
 * For API-key models, it constructs a direct SDK invocation command.
 */
export function createUnifiedOrchestratorAdapter(options?: {
  projectRoot?: string;
  workspaceRoot?: string;
  runtimeRoot?: string;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  externalMcpService?: {
    getSnapshots: () => Array<{ tools: Array<{ namespacedName: string; enabled: boolean; safety: "read" | "write" | "unknown" }> }>;
  } | null;
}): OrchestratorExecutorAdapter {
  const runtimeRoot = typeof options?.runtimeRoot === "string" && options.runtimeRoot.trim().length
    ? options.runtimeRoot.trim()
    : resolveUnifiedRuntimeRoot();
  const projectRoot = typeof options?.projectRoot === "string" && options.projectRoot.trim().length
    ? options.projectRoot.trim()
    : undefined;
  const workspaceRoot = typeof options?.workspaceRoot === "string" && options.workspaceRoot.trim().length
    ? options.workspaceRoot.trim()
    : (projectRoot ?? runtimeRoot);
  const canonicalProjectRoot = projectRoot ?? workspaceRoot;
  const externalMcpService = options?.externalMcpService ?? null;

  // Clean up stale MCP config files from previous runs
  cleanupStaleMcpConfigFiles(canonicalProjectRoot);

  const shellAdapter = createBaseOrchestratorAdapter({
    executorKind: "unified",
    sessionType: "ai-orchestrated",

    buildOverrideCommand: ({ prompt }) => {
      // For override commands, try to detect the best CLI
      // Default to claude since it's the most common
      return `exec claude -p ${shellInlineDecodedArg(prompt)}`;
    },

    buildStartupCommand: ({ prompt, model, step, run, attempt, permissionConfig, teamRuntime }) => {
      const descriptor = getModelById(model) ?? resolveModelAlias(model);
      const requiresPlanApproval =
        step.metadata?.requiresPlanApproval === true || step.metadata?.coordinationPattern === "plan_then_implement";
      const readOnlyExecution = step.metadata?.readOnlyExecution === true || requiresPlanApproval;
      const effectivePermissionConfig = forceReadOnlyPermissionConfig(permissionConfig, readOnlyExecution);
      const workerEnv = buildWorkerEnvVars({
        missionId: run.missionId,
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id,
        ownerId: resolveWorkerOwnerId(run.metadata),
      });
      const workerOwnerId = resolveWorkerOwnerId(run.metadata);
      const laneWorkspaceRoot = typeof step.metadata?.laneWorktreePath === "string" && step.metadata.laneWorktreePath.trim().length > 0
        ? step.metadata.laneWorktreePath.trim()
        : workspaceRoot;
      const mcpIdentity = {
        projectRoot: canonicalProjectRoot,
        workspaceRoot: laneWorkspaceRoot,
        runtimeRoot,
        missionId: run.missionId,
        runId: run.id,
        stepId: step.id,
        attemptId: attempt.id,
        ownerId: workerOwnerId,
      };

      // Determine which CLI to use based on the model
      if (descriptor?.isCliWrapped && descriptor.family === "anthropic") {
        // Claude CLI path — use per-provider permission when available
        const cliModel = resolveClaudeCliModel(descriptor?.sdkModelId ?? model);
        const claudeProviderMode = effectivePermissionConfig?._providers?.claude;
        const mappedClaude = mapPermissionToClaude(claudeProviderMode);
        const dangerouslySkip = !readOnlyExecution && mappedClaude === "bypassPermissions";
        const permissionMode = mappedClaude === "bypassPermissions"
          ? "acceptEdits"
          : mappedClaude;
        const configuredAllowedTools =
          effectivePermissionConfig?._providers?.allowedTools ?? effectivePermissionConfig?.cli?.allowedTools ?? [];
        const readOnlyExternalTools = externalMcpService
          ? externalMcpService
              .getSnapshots()
              .flatMap((snapshot) => snapshot.tools)
              .filter((tool) => tool.enabled && tool.safety !== "write")
              .map((tool) => tool.namespacedName)
          : [];
        const allowedTools = readOnlyExecution
          ? buildClaudeReadOnlyWorkerAllowedTools("ade", readOnlyExternalTools)
          : dedupeAllowedTools(configuredAllowedTools);

        const parts: string[] = ["claude", "--model", shellEscapeArg(cliModel)];

        if (dangerouslySkip) {
          parts.push("--dangerously-skip-permissions");
        } else {
          parts.push("--permission-mode", shellEscapeArg(permissionMode));
        }

        if (allowedTools.length > 0) {
          parts.push("--allowedTools", shellEscapeArg(allowedTools.join(",")));
        }

        // Bind ADE MCP server to worker via --mcp-config. Mirror config into worker CWD
        // so Claude native teammates inherit an MCP config path available from that directory.
        const mcpConfigPath = writeMcpConfigFile(mcpIdentity);
        const localMcpConfigName = workerLocalMcpConfigFileName(attempt.id);
        const promptFilePath = writeWorkerPromptFile({
          projectRoot: canonicalProjectRoot,
          attemptId: attempt.id,
          prompt,
        });
        parts.push("--mcp-config", shellEscapeArg(localMcpConfigName));
        parts.push("-p", `"$(cat ${shellEscapeArg(promptFilePath)})"`);

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
        const codexProviderMode = effectivePermissionConfig?._providers?.codex;
        const mappedCodex = mapPermissionToCodex(codexProviderMode);
        const approvalPolicy = mappedCodex?.approvalPolicy ?? "untrusted";
        const sandboxMode = readOnlyExecution
          ? "read-only"
          : effectivePermissionConfig?._providers?.codexSandbox ?? effectivePermissionConfig?.cli?.sandboxPermissions ?? "workspace-write";
        const writablePaths = effectivePermissionConfig?._providers?.writablePaths ?? effectivePermissionConfig?.cli?.writablePaths ?? [];

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

        parts.push("-");

        const envParts = [...workerEnv];
        const cmd = parts.join(" ");
        const promptFilePath = writeWorkerPromptFile({
          projectRoot: canonicalProjectRoot,
          attemptId: attempt.id,
          prompt,
        });
        const startup = `${envParts.length > 0 ? `${envParts.join(" ")} ` : ""}exec ${cmd} < ${shellEscapeArg(promptFilePath)}`;
        return startup;
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

  const agentChatService = options?.agentChatService ?? null;

  if (!agentChatService) {
    return {
      ...shellAdapter,
      requiresLaneId: true,
    };
  }

  return {
    kind: "unified",
    requiresLaneId: true,
    async start(args) {
      const rawStartup = typeof args.step.metadata?.startupCommand === "string" ? args.step.metadata.startupCommand.trim() : "";
      if (rawStartup.length > 0) {
        return shellAdapter.start(args);
      }

      if (!args.step.laneId) {
        return {
          status: "failed",
          errorClass: "policy",
          errorMessage: "Unified executor requires step.laneId to create worker sessions."
        };
      }

      const modelRef = typeof args.step.metadata?.modelId === "string" ? args.step.metadata.modelId.trim() : "";
      if (!modelRef.length) {
        return {
          status: "failed",
          errorClass: "policy",
          errorMessage: `Step '${args.step.stepKey}' is missing required metadata.modelId for unified execution.`
        };
      }

      const descriptor = getModelById(modelRef) ?? resolveModelAlias(modelRef);
      if (!descriptor) {
        return {
          status: "failed",
          errorClass: "policy",
          errorMessage: `Model '${modelRef}' is not registered.`
        };
      }

      const teamRuntime = args.run.metadata && typeof args.run.metadata === "object" && !Array.isArray(args.run.metadata)
        ? (args.run.metadata as Record<string, unknown>).teamRuntime as TeamRuntimeConfig | undefined
        : undefined;
      const requiresPlanApproval =
        args.step.metadata?.requiresPlanApproval === true || args.step.metadata?.coordinationPattern === "plan_then_implement";
      const readOnlyExecution = args.step.metadata?.readOnlyExecution === true || requiresPlanApproval;
      const effectivePermissionConfig = forceReadOnlyPermissionConfig(args.permissionConfig, readOnlyExecution);
      const { prompt, filePatterns, steeringDirectiveCount } = buildFullPrompt(args, "unified", {
        memoryService: args.memoryService as any,
        projectId: args.memoryProjectId,
        workerRuntime: "in_process",
        memoryBriefing: args.memoryBriefing,
      });
      let provider: "claude" | "codex" | "unified" = "unified";
      if (descriptor.isCliWrapped) {
        if (descriptor.family === "openai") provider = "codex";
        else if (descriptor.family === "anthropic") provider = "claude";
      }
      const model = descriptor.isCliWrapped ? descriptor.shortId : descriptor.id;
      const reasoningEffort =
        typeof args.step.metadata?.reasoningEffort === "string" && args.step.metadata.reasoningEffort.trim().length > 0
          ? args.step.metadata.reasoningEffort.trim()
          : undefined;
      const permissionMode = resolveManagedPermissionMode({
        provider,
        permissionConfig: effectivePermissionConfig,
        readOnlyExecution,
      });
      const executionMode = resolveManagedExecutionMode({
        provider,
        teamRuntime,
      });
      const workerOwnerId = resolveWorkerOwnerId(args.run.metadata);

      try {
        const session = await agentChatService.createSession({
          laneId: args.step.laneId,
          provider,
          model,
          modelId: descriptor.id,
          reasoningEffort: reasoningEffort ?? null,
          permissionMode,
          ...(workerOwnerId ? { identityKey: `agent:${workerOwnerId}` as const } : {}),
        });
        return {
          status: "accepted",
          sessionId: session.id,
          launch: {
            prompt,
            displayText: `Execute worker step "${args.step.title}".`,
            reasoningEffort: reasoningEffort ?? null,
            executionMode,
            permissionMode: permissionMode ?? null,
          },
          metadata: {
            adapterKind: "unified",
            workerSessionKind: "managed_chat",
            workerStreamSource: "agent_chat",
            model: descriptor.id,
            modelFamily: descriptor.family ?? "unknown",
            isCliWrapped: descriptor.isCliWrapped ?? false,
            reasoningEffort,
            executionMode,
            permissionMode,
            filePatterns: filePatterns.length > 0 ? filePatterns : undefined,
            steeringDirectiveCount,
            promptLength: prompt.length,
            startupCommandPreview: "[managed chat session]",
          }
        };
      } catch (error) {
        return {
          status: "failed",
          errorClass: "startup_failure",
          errorMessage: error instanceof Error ? error.message : String(error),
          metadata: {
            adapterKind: "unified",
            workerSessionKind: "managed_chat",
            workerStreamSource: "agent_chat",
            adapterState: "managed_chat_session_create_failed",
          }
        };
      }
    },
  };
}
