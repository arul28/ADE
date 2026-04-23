import fs from "node:fs";
import path from "node:path";
import type { OrchestratorExecutorAdapter } from "./orchestratorService";
import { buildFullPrompt, createBaseOrchestratorAdapter, shellEscapeArg, shellInlineDecodedArg, type AdapterLaunchCommand } from "./baseOrchestratorAdapter";
import {
  classifyWorkerExecutionPath,
  getModelById,
  resolveCliProviderForModel,
  resolveModelAlias,
  resolveModelDescriptor,
  resolveProviderGroupForModel,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import type {
  AgentChatExecutionMode,
  AgentChatPermissionMode,
  TeamRuntimeConfig,
} from "../../../shared/types";
import type { MissionPermissionConfig, MissionProviderPermissions } from "../../../shared/types/missions";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveClaudeCliModel, resolveCodexCliModel } from "../ai/claudeModelUtils";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import type { createAgentChatService } from "../chat/agentChatService";
import {
  mapPermissionToClaude,
  mapPermissionToCodex,
  normalizeMissionPermissions,
  providerPermissionsToLegacyConfig,
} from "./permissionMapping";
import { resolveCliSpawnInvocation } from "../shared/processExecution";

const WORKER_ENV_KEYS = [
  "ADE_MISSION_ID",
  "ADE_RUN_ID",
  "ADE_STEP_ID",
  "ADE_ATTEMPT_ID",
  "ADE_DEFAULT_ROLE",
  "ADE_OWNER_ID",
] as const;

type WorkerEnvKey = typeof WORKER_ENV_KEYS[number];
type WorkerEnvVars = Partial<Record<WorkerEnvKey, string>> & Record<string, string>;

/**
 * Build worker identity env vars. ADE-aware CLIs and child processes use these
 * to resolve caller context without POSIX-only inline assignment syntax.
 */
function buildWorkerEnvVars(args: {
  missionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  ownerId?: string | null;
}): WorkerEnvVars {
  return {
    ADE_MISSION_ID: args.missionId,
    ADE_RUN_ID: args.runId,
    ADE_STEP_ID: args.stepId,
    ADE_ATTEMPT_ID: args.attemptId,
    ADE_DEFAULT_ROLE: "agent",
    ...(args.ownerId ? { ADE_OWNER_ID: args.ownerId } : {}),
  };
}

function previewWorkerEnvVars(env: WorkerEnvVars): string[] {
  const parts: string[] = [];
  for (const key of WORKER_ENV_KEYS) {
    const value = env[key];
    if (!value) continue;
    parts.push(key === "ADE_DEFAULT_ROLE" ? `${key}=agent` : `${key}=${shellEscapeArg(value)}`);
  }
  return parts;
}

function resolveWorkerOwnerId(metadata: Record<string, unknown> | null | undefined): string | null {
  return typeof metadata?.employeeAgentId === "string" && metadata.employeeAgentId.trim().length > 0
    ? metadata.employeeAgentId.trim()
    : null;
}

export function getProviderAdapterUnsupportedModelReason(modelRef: string): string | null {
  const descriptor = resolveModelDescriptor(modelRef);
  if (!descriptor) {
    return `Model '${modelRef}' is not registered.`;
  }
  const cliProvider = resolveCliProviderForModel(descriptor);
  if (cliProvider) return null;
  const executionPath = classifyWorkerExecutionPath(descriptor);
  return `Model '${descriptor.id}' requires ${executionPath} provider-owned execution (${descriptor.family}), but the shell-startup fallback only supports Claude/Codex CLI models. Use the managed OpenCode path for API and local models.`;
}

function workerPromptFilePath(projectRoot: string, attemptId: string): string {
  return path.join(resolveAdeLayout(projectRoot).workerPromptsDir, `worker-${attemptId}.txt`);
}

function workerLaunchFilePath(projectRoot: string, attemptId: string): string {
  return path.join(resolveAdeLayout(projectRoot).workerPromptsDir, `worker-${attemptId}.launch.json`);
}

const WORKER_CLI_LAUNCHER_SCRIPT = `
const fs = require("fs");
const { spawn } = require("child_process");
const specPath = process.argv[1];
let done = false;
function finish(code) {
  if (done) return;
  done = true;
  process.exit(typeof code === "number" ? code : 1);
}
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const childEnv = { ...process.env, ...(spec.env || {}) };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
  cwd: spec.cwd || process.cwd(),
  env: childEnv,
  shell: false,
  stdio: [spec.stdinFilePath ? "pipe" : "inherit", "inherit", "inherit"],
  windowsHide: false,
  windowsVerbatimArguments: !!spec.windowsVerbatimArguments
});
child.on("error", (err) => {
  console.error("[ADE] Failed to launch worker CLI: " + (err && err.message ? err.message : String(err)));
  finish(127);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error("[ADE] Worker CLI exited from signal " + signal + ".");
    finish(1);
    return;
  }
  finish(code == null ? 0 : code);
});
if (spec.stdinFilePath && child.stdin) {
  child.stdin.on("error", () => {});
  const stream = fs.createReadStream(spec.stdinFilePath);
  stream.on("error", (err) => {
    console.error("[ADE] Failed to read worker prompt: " + (err && err.message ? err.message : String(err)));
    try { child.kill(); } catch {}
    finish(1);
  });
  stream.pipe(child.stdin);
}
`;

const CLAUDE_READ_ONLY_NATIVE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
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

export function buildClaudeReadOnlyWorkerAllowedTools(extraToolNames: readonly string[] = []): string[] {
  return dedupeAllowedTools([
    ...CLAUDE_READ_ONLY_NATIVE_TOOLS,
    ...extraToolNames,
  ]);
}

export function writeWorkerPromptFile(args: {
  projectRoot: string;
  attemptId: string;
  prompt: string;
}): string {
  const promptPath = workerPromptFilePath(args.projectRoot, args.attemptId);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, args.prompt, "utf8");
  return promptPath;
}

export function writeWorkerLaunchFile(args: {
  projectRoot: string;
  attemptId: string;
  command: string;
  commandArgs: string[];
  promptFilePath: string;
  env?: Record<string, string>;
}): string {
  const launchPath = workerLaunchFilePath(args.projectRoot, args.attemptId);
  fs.mkdirSync(path.dirname(launchPath), { recursive: true });
  const invocation = resolveCliSpawnInvocation(
    args.command,
    args.commandArgs,
    { ...process.env, ...(args.env ?? {}) },
  );
  fs.writeFileSync(
    launchPath,
    JSON.stringify({
      command: invocation.command,
      args: invocation.args,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
      stdinFilePath: args.promptFilePath,
      env: args.env ?? {},
    }),
    "utf8",
  );
  return launchPath;
}

export function nodeWorkerLaunch(args: {
  startupCommand: string;
  launchFilePath: string;
  env?: Record<string, string>;
}): AdapterLaunchCommand {
  return {
    startupCommand: args.startupCommand,
    command: process.execPath,
    args: ["-e", WORKER_CLI_LAUNCHER_SCRIPT, args.launchFilePath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(args.env ?? {}),
    },
  };
}

export function resolveOpenCodeRuntimeRoot(): string {
  const startPoints = [
    process.cwd(),
    typeof __dirname === "string" ? __dirname : null,
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", ".."),
  ];

  for (const start of startPoints) {
    if (!start) continue;
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i += 1) {
      if (fs.existsSync(path.join(dir, "apps", "ade-cli", "package.json"))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return path.resolve(process.cwd());
}

export function cleanupWorkerRuntimeFiles(projectRoot: string, attemptId: string, _laneWorktreePath?: string | null): void {
  try {
    fs.unlinkSync(workerPromptFilePath(projectRoot, attemptId));
  } catch {
    // Ignore — prompt file may already be removed or never created.
  }
  try {
    fs.unlinkSync(workerLaunchFilePath(projectRoot, attemptId));
  } catch {
    // Ignore — launch file may already be removed or never created.
  }
}

/**
 * Remove stale worker prompt files from previous runs.
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

function cleanupStaleWorkerRuntimeFiles(projectRoot: string): void {
  const layout = resolveAdeLayout(projectRoot);
  cleanupStaleFilesInDir(
    layout.workerPromptsDir,
    "worker-", ".txt",
  );
  cleanupStaleFilesInDir(
    layout.workerPromptsDir,
    "worker-", ".launch.json",
  );
}

const VALID_PERMISSION_MODES = new Set<string>(["default", "plan", "edit", "full-auto", "config-toml"]);

function resolveManagedPermissionMode(args: {
  provider: "claude" | "codex" | "opencode" | "cursor";
  descriptor?: ModelDescriptor;
  permissionConfig: LegacyPermissionConfig | undefined;
  readOnlyExecution: boolean;
}): AgentChatPermissionMode | undefined {
  if (args.readOnlyExecution) return "plan";
  const providers = args.permissionConfig?._providers;
  const candidate =
    args.provider === "cursor"
      ? ((providers?.cursor ?? providers?.opencode) as string | undefined)
      : (providers?.[args.provider] as string | undefined);
  const normalizedCandidate = typeof candidate === "string" && VALID_PERMISSION_MODES.has(candidate)
    ? candidate as AgentChatPermissionMode
    : undefined;
  if (args.descriptor?.authTypes?.includes("local")) {
    if (args.descriptor.harnessProfile === "read_only") return "plan";
    if (args.descriptor.harnessProfile === "guarded") return "plan";
  }
  return normalizedCandidate;
}

function mapPermissionModeToNativeFields(
  provider: "claude" | "codex" | "opencode" | "cursor",
  mode: AgentChatPermissionMode | undefined,
): Partial<Pick<import("../../../shared/types").AgentChatCreateArgs, "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "opencodePermissionMode">> {
  if (!mode) return {};
  // "config-toml" means the worker should inherit permissions from the
  // provider/repo config (e.g. a .toml settings file). Don't rewrite it
  // into explicit native permission fields — pass through with no overrides
  // so the managed session respects the config it was supposed to inherit.
  if (mode === "config-toml") return {};
  if (provider === "claude") {
    const map: Record<string, import("../../../shared/types").AgentChatClaudePermissionMode> = {
      "full-auto": "bypassPermissions",
      "edit": "acceptEdits",
      "plan": "plan",
      "default": "default",
    };
    return { claudePermissionMode: map[mode] ?? "default" };
  }
  if (provider === "codex") {
    if (mode === "full-auto") return { codexApprovalPolicy: "never", codexSandbox: "danger-full-access" };
    if (mode === "edit") return { codexApprovalPolicy: "untrusted", codexSandbox: "workspace-write" };
    if (mode === "default") return { codexApprovalPolicy: "on-request", codexSandbox: "workspace-write" };
    return { codexApprovalPolicy: "on-request", codexSandbox: "read-only" };
  }
  const umap: Record<string, import("../../../shared/types").AgentChatOpenCodePermissionMode> = {
    "full-auto": "full-auto",
    "edit": "edit",
    "plan": "plan",
  };
  return { opencodePermissionMode: umap[mode] ?? "edit" };
}

function resolveManagedExecutionMode(args: {
  provider: "claude" | "codex" | "opencode" | "cursor";
  teamRuntime?: TeamRuntimeConfig;
}): AgentChatExecutionMode {
  if (args.provider === "cursor") {
    return "focused";
  }
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
    opencode: "plan",
    codexSandbox: "read-only",
    writablePaths: [],
  });
}

/**
 * Provider orchestrator adapter that handles all ADE-owned worker providers.
 * For CLI-wrapped models (Claude CLI, Codex CLI), it delegates to the appropriate CLI.
 * For API-key models, it constructs a direct SDK invocation command.
 */
export function createProviderOrchestratorAdapter(options?: {
  projectRoot?: string;
  workspaceRoot?: string;
  runtimeRoot?: string;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
}): OrchestratorExecutorAdapter {
  const runtimeRoot = typeof options?.runtimeRoot === "string" && options.runtimeRoot.trim().length
    ? options.runtimeRoot.trim()
    : resolveOpenCodeRuntimeRoot();
  const projectRoot = typeof options?.projectRoot === "string" && options.projectRoot.trim().length
    ? options.projectRoot.trim()
    : undefined;
  const workspaceRoot = typeof options?.workspaceRoot === "string" && options.workspaceRoot.trim().length
    ? options.workspaceRoot.trim()
    : (projectRoot ?? runtimeRoot);
  const canonicalProjectRoot = projectRoot ?? workspaceRoot;
  cleanupStaleWorkerRuntimeFiles(canonicalProjectRoot);

  const shellAdapter = createBaseOrchestratorAdapter({
    executorKind: "opencode",
    sessionType: "opencode-orchestrated",

    buildOverrideCommand: ({ prompt }) => {
      // For override commands, try to detect the best CLI
      // Default to claude since it's the most common
      const resolvedClaude = resolveClaudeCodeExecutable();
      return {
        startupCommand: `exec claude -p ${shellInlineDecodedArg(prompt)}`,
        command: resolvedClaude.path,
        args: ["-p", prompt],
      };
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
      // Determine which CLI to use based on the model
      if (descriptor?.isCliWrapped && descriptor.family === "anthropic") {
        // Claude CLI path — use per-provider permission when available
        const cliModel = resolveClaudeCliModel(descriptor?.providerModelId ?? model);
        const claudeProviderMode = effectivePermissionConfig?._providers?.claude;
        const mappedClaude = mapPermissionToClaude(claudeProviderMode);
        const dangerouslySkip = !readOnlyExecution && mappedClaude === "bypassPermissions";
        const permissionMode = mappedClaude === "bypassPermissions"
          ? "acceptEdits"
          : mappedClaude;
        const configuredAllowedTools =
          effectivePermissionConfig?._providers?.allowedTools ?? effectivePermissionConfig?.cli?.allowedTools ?? [];
        const allowedTools = readOnlyExecution
          ? buildClaudeReadOnlyWorkerAllowedTools()
          : dedupeAllowedTools(configuredAllowedTools);

        const resolvedClaude = resolveClaudeCodeExecutable();
        const commandArgs: string[] = ["--model", cliModel];
        const previewParts: string[] = ["claude", "--model", shellEscapeArg(cliModel)];

        if (dangerouslySkip) {
          commandArgs.push("--dangerously-skip-permissions");
          previewParts.push("--dangerously-skip-permissions");
        } else {
          commandArgs.push("--permission-mode", permissionMode);
          previewParts.push("--permission-mode", shellEscapeArg(permissionMode));
        }

        if (allowedTools.length > 0) {
          commandArgs.push("--allowedTools", allowedTools.join(","));
          previewParts.push("--allowedTools", shellEscapeArg(allowedTools.join(",")));
        }

        const promptFilePath = writeWorkerPromptFile({
          projectRoot: canonicalProjectRoot,
          attemptId: attempt.id,
          prompt,
        });
        commandArgs.push("-p");
        previewParts.push("-p");

        const launchEnv: Record<string, string> = { ...workerEnv };
        const envParts = previewWorkerEnvVars(workerEnv);
        if (
          teamRuntime?.enabled
          && teamRuntime.allowClaudeAgentTeams !== false
          && (teamRuntime.targetProvider === "claude" || teamRuntime.targetProvider === "auto")
        ) {
          launchEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
          envParts.push("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
        }

        const cmd = previewParts.join(" ");
        const startup = `exec ${cmd} < ${shellEscapeArg(promptFilePath)}`;
        const startupCommand = envParts.length > 0 ? `${envParts.join(" ")} ${startup}` : startup;
        const launchFilePath = writeWorkerLaunchFile({
          projectRoot: canonicalProjectRoot,
          attemptId: attempt.id,
          command: resolvedClaude.path,
          commandArgs,
          promptFilePath,
          env: launchEnv,
        });
        return nodeWorkerLaunch({
          startupCommand,
          launchFilePath,
          env: launchEnv,
        });
      }

      if (descriptor?.isCliWrapped && descriptor.family === "openai") {
        // Codex CLI path — use per-provider permission when available
        const codexProviderMode = effectivePermissionConfig?._providers?.codex;
        const mappedCodex = mapPermissionToCodex(codexProviderMode);
        const useCodexConfig = codexProviderMode === "config-toml" || mappedCodex == null;
        const approvalPolicy = mappedCodex?.approvalPolicy ?? "on-request";
        const sandboxMode = readOnlyExecution
          ? "read-only"
          : codexProviderMode === "full-auto"
            ? mappedCodex?.sandbox ?? "danger-full-access"
            : mappedCodex?.sandbox ?? effectivePermissionConfig?._providers?.codexSandbox ?? effectivePermissionConfig?.cli?.sandboxPermissions ?? "workspace-write";
        const writablePaths = effectivePermissionConfig?._providers?.writablePaths ?? effectivePermissionConfig?.cli?.writablePaths ?? [];

        const resolvedCodex = resolveCodexExecutable();
        const commandArgs: string[] = ["--model", resolveCodexCliModel(descriptor.providerModelId)];
        const previewParts: string[] = [
          "codex", "--model", shellEscapeArg(resolveCodexCliModel(descriptor.providerModelId)),
        ];
        if (!useCodexConfig) {
          commandArgs.push("-a", approvalPolicy, "-s", sandboxMode);
          previewParts.push("-a", shellEscapeArg(approvalPolicy), "-s", shellEscapeArg(sandboxMode));
        }

        commandArgs.push("exec");
        previewParts.push("exec");

        for (const wp of writablePaths) {
          if (!wp.trim().length) continue;
          commandArgs.push("--add-dir", wp.trim());
          previewParts.push("--add-dir", shellEscapeArg(wp.trim()));
        }

        commandArgs.push("-");
        previewParts.push("-");

        const launchEnv: Record<string, string> = { ...workerEnv };
        const envParts = previewWorkerEnvVars(workerEnv);
        const cmd = previewParts.join(" ");
        const promptFilePath = writeWorkerPromptFile({
          projectRoot: canonicalProjectRoot,
          attemptId: attempt.id,
          prompt,
        });
        const startupCommand = `${envParts.length > 0 ? `${envParts.join(" ")} ` : ""}exec ${cmd} < ${shellEscapeArg(promptFilePath)}`;
        const launchFilePath = writeWorkerLaunchFile({
          projectRoot: canonicalProjectRoot,
          attemptId: attempt.id,
          command: resolvedCodex.path,
          commandArgs,
          promptFilePath,
          env: launchEnv,
        });
        return nodeWorkerLaunch({
          startupCommand,
          launchFilePath,
          env: launchEnv,
        });
      }

      // Non-CLI or unknown models can still run via the managed chat path.
      // This shell fallback only exists for CLI-wrapped workers.
      const unsupportedReason = getProviderAdapterUnsupportedModelReason(model) ?? `Model '${model}' is not supported by the provider adapter.`;
      const failureMessage = `[ADE] Shell-startup fallback for the provider adapter only supports CLI-wrapped Anthropic/OpenAI models. ${unsupportedReason}`;
      return {
        startupCommand: `printf '%s\\n' ${shellEscapeArg(failureMessage)} >&2; exit 64`,
        command: process.execPath,
        args: ["-e", "console.error(process.argv[1]); process.exit(64);", failureMessage],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    },

    buildAcceptedMetadata: ({ model, filePatterns, steeringDirectiveCount, promptLength, reasoningEffort, startupCommandPreview }) => {
      const descriptor = getModelById(model);
      return {
        adapterKind: "opencode",
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
    kind: "opencode",
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
          errorMessage: "Provider executor requires step.laneId to create worker sessions."
        };
      }

      const modelRef = typeof args.step.metadata?.modelId === "string" ? args.step.metadata.modelId.trim() : "";
      if (!modelRef.length) {
        return {
          status: "failed",
          errorClass: "policy",
          errorMessage: `Step '${args.step.stepKey}' is missing required metadata.modelId for provider execution.`
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
      const { prompt, filePatterns, steeringDirectiveCount } = buildFullPrompt(args, "opencode", {
        memoryService: args.memoryService as any,
        projectId: args.memoryProjectId,
        workerRuntime: "in_process",
        memoryBriefing: args.memoryBriefing,
      });
      const provider = resolveProviderGroupForModel(descriptor);
      const model = descriptor.isCliWrapped ? descriptor.providerModelId : descriptor.id;
      const reasoningEffort =
        typeof args.step.metadata?.reasoningEffort === "string" && args.step.metadata.reasoningEffort.trim().length > 0
          ? args.step.metadata.reasoningEffort.trim()
          : undefined;
      const permissionMode = resolveManagedPermissionMode({
        provider,
        descriptor,
        permissionConfig: effectivePermissionConfig,
        readOnlyExecution,
      });
      const executionMode = resolveManagedExecutionMode({
        provider,
        teamRuntime,
      });
      const workerOwnerId = resolveWorkerOwnerId(args.run.metadata);

      try {
        const configTomlFields = provider === "codex" && permissionMode === "config-toml"
          ? { permissionMode, codexConfigSource: "config-toml" as const }
          : {};
        const session = await agentChatService.createSession({
          laneId: args.step.laneId,
          provider,
          model,
          modelId: descriptor.id,
          reasoningEffort: reasoningEffort ?? null,
          ...mapPermissionModeToNativeFields(provider, permissionMode),
          ...configTomlFields,
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
            adapterKind: "opencode",
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
            adapterKind: "opencode",
            workerSessionKind: "managed_chat",
            workerStreamSource: "agent_chat",
            adapterState: "managed_chat_session_create_failed",
          }
        };
      }
    },
  };
}
