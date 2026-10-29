/**
 * One-shots on ADE's pinned copy of a provider CLI that has no SDK: Qwen,
 * Kimi, Grok, Droid, Devin, Pi and Antigravity. Each runs one prompt, prints
 * the answer and exits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requirePinnedProviderExecutable } from "./pinnedProviderTools";
import { GROK_NO_AUTO_UPDATE_ARG, providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import {
  resolveAntigravityExecutable,
  resolveGrokExecutable,
  resolveKimiExecutable,
  resolveQwenExecutable,
  type AcpExecutableResolution,
} from "./acpExecutables";
import { parseStructuredOutput } from "./utils";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import { openProviderTaskMcpOff } from "../mcp/providerTaskMcpOff";
import {
  resolveDevinCliModelForLaunch,
  resolveGrokCliModelForLaunch,
  resolveKimiCliModelForLaunch,
  resolvePiCliModelForLaunch,
  resolveQwenCliModelForLaunch,
  piThinkingLevel,
} from "../../../shared/cliLaunch";
import { requirePinnedProviderCli } from "../pty/pinnedProviderCli";
import { inspectAntigravityCredentials } from "./antigravityAuth";
import { runAcpOneShotPrompt } from "../chat/acpHost/acpOneShotPrompt";
import { resolvePiInstallation } from "./piInstallation";
import { buildPiWorkerEnvironment } from "../chat/piSdkEnvironment";
import {
  appendStructuredOutputInstruction,
  describeCliFailure,
  resolveTaskReasoningEffort,
  runCommand,
  type ProviderTaskRunnerArgs,
  type ProviderTaskRunnerResult,
} from "./providerTaskCommon";

/** Run an ADE-owned metadata prompt through ADE's pinned copy of a provider's CLI. */
async function runAcpOneShotTask(
  args: ProviderTaskRunnerArgs,
  config: {
    provider: "qwen" | "kimi" | "grok";
    resolved: AcpExecutableResolution;
    argv: string[];
    providerLabel: string;
    stdinText?: string;
  },
): Promise<ProviderTaskRunnerResult> {
  const env = providerSelfUpdateEnv(config.provider);
  // Kimi and Grok start their config's MCP servers at launch, and a trusted
  // project's too, so they run on a copy without them in the scratch cwd.
  // Qwen's safe mode starts none.
  const mcpOff = config.provider === "qwen"
    ? null
    : openProviderTaskMcpOff(config.provider, { ...userProcessEnv(), ...env });
  const result = await runCommand({
    command: config.resolved.path,
    // Qwen's pin is a Node plus its script; the script comes first.
    argv: [...(config.resolved.args ?? []), ...config.argv],
    cwd: config.provider === "qwen" ? args.cwd : oneShotScratchCwd(),
    timeoutMs: args.timeoutMs,
    stdinText: config.stdinText,
    env: { ...env, ...mcpOff?.env },
  }).finally(() => mcpOff?.close());
  if (result.exitCode !== 0) {
    throw new Error(describeCliFailure(config.providerLabel, result));
  }
  const text = result.stdout.trim();
  return {
    text,
    structuredOutput: args.jsonSchema ? parseStructuredOutput(text) : null,
    sessionId: null,
  };
}

export function rejectUnsupportedAcpTaskImages(args: ProviderTaskRunnerArgs, providerLabel: string): void {
  if ((args.imagePaths?.length ?? 0) > 0) {
    throw new Error(
      "Image input is not supported with "
        + providerLabel
        + " native metadata tasks; retry with a provider that supports image input.",
    );
  }
}

export async function runQwenTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Qwen");
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;
  // Qwen's ACP session supports permission modes through
  // `session/set_config_option`, but Qwen 0.22.x does not expose the older
  // `--approval-mode` flag on its one-shot CLI. Safe mode keeps this metadata
  // task away from project customizations and MCP while the prompt remains
  // provider-native.
  const cliArgs = ["--safe-mode", "--output-format", "text"];
  const model = resolveQwenCliModelForLaunch(args.descriptor.providerModelId);
  if (model) cliArgs.push("--model", model);
  const resolved = await requirePinnedProviderExecutable("qwen", () => resolveQwenExecutable());
  return await runAcpOneShotTask(args, {
    provider: "qwen",
    resolved,
    argv: cliArgs,
    providerLabel: "Qwen",
    stdinText: combinedPrompt,
  });
}

export async function runKimiTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Kimi");
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;
  // Kimi rejects --plan/--auto/--yolo together with --prompt. Metadata
  // generation is non-interactive, so use a temporary agent with no tools
  // instead of relying on a permission flag that the CLI disallows here.
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kimi-task-"));
  const agentPath = path.join(taskDir, "metadata.md");
  fs.writeFileSync(agentPath, [
    "---",
    "name: ade-metadata",
    "description: ADE metadata task with no tool access.",
    "tools: []",
    "---",
    "Return only the requested metadata. Do not use tools.",
    "",
  ].join("\n"), "utf8");

  try {
    const cliArgs: string[] = [];
    const model = resolveKimiCliModelForLaunch(args.descriptor.providerModelId);
    if (model) cliArgs.push("--model", model);
    cliArgs.push("--agent-file", agentPath, "--output-format", "text", "--prompt", combinedPrompt);
    const resolved = await requirePinnedProviderExecutable("kimi", () => resolveKimiExecutable());
    return await runAcpOneShotTask(args, { provider: "kimi", resolved, argv: cliArgs, providerLabel: "Kimi" });
  } finally {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
}

export async function runGrokTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Grok");
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;
  const cliArgs = [GROK_NO_AUTO_UPDATE_ARG, "--permission-mode", "plan", "--no-subagents", "--disable-web-search"];
  const model = resolveGrokCliModelForLaunch(args.descriptor.providerModelId);
  if (model) cliArgs.push("--model", model);
  if (args.jsonSchema) {
    cliArgs.push("--json-schema", JSON.stringify(args.jsonSchema));
  } else {
    cliArgs.push("--output-format", "plain");
  }
  cliArgs.push("--single", combinedPrompt);
  const resolved = await requirePinnedProviderExecutable("grok", () => resolveGrokExecutable());
  return await runAcpOneShotTask(args, { provider: "grok", resolved, argv: cliArgs, providerLabel: "Grok" });
}

function combinedTaskPrompt(args: ProviderTaskRunnerArgs): string {
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  return args.system?.trim() ? `${args.system.trim()}\n\n${prompt}` : prompt;
}

/**
 * The cwd for a one-shot on a CLI that files every run under its directory
 * (Droid, Devin, Antigravity) or loads a trusted project's MCP servers (Kimi,
 * Grok): one fixed ADE directory, so a chat title never lands in the
 * project's own session history or starts its servers, and a job that has
 * everything in its prompt has no workspace to read.
 */
function oneShotScratchCwd(): string {
  const dir = path.join(os.tmpdir(), "ade-provider-task");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run `body` with a private temp directory that is removed afterwards. */
async function withTaskDir<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function textTaskResult(args: ProviderTaskRunnerArgs, text: string, sessionId: string | null = null): ProviderTaskRunnerResult {
  return { text, structuredOutput: args.jsonSchema ? parseStructuredOutput(text) : null, sessionId };
}

/**
 * `droid exec` on ADE's pinned Droid. With no `--auto` it runs read-only, so a
 * title or summary can never change anything. The prompt goes through a file:
 * a transcript excerpt is too long for a Windows command line.
 */
export async function runDroidTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Droid");
  const cli = await requirePinnedProviderCli("droid");
  return await withTaskDir("ade-droid-task-", async (dir) => {
    const promptPath = path.join(dir, "prompt.md");
    fs.writeFileSync(promptPath, combinedTaskPrompt(args), "utf8");
    const cliArgs = [...cli.leadingArgs, "exec", "-m", args.descriptor.providerModelId, "-o", "text"];
    const effort = resolveTaskReasoningEffort(args);
    if (effort) cliArgs.push("-r", effort);
    cliArgs.push("-f", promptPath);
    const mcpOff = openProviderTaskMcpOff("droid", { ...userProcessEnv(), ...cli.env });
    const result = await runCommand({
      command: cli.command,
      argv: cliArgs,
      cwd: oneShotScratchCwd(),
      timeoutMs: args.timeoutMs,
      env: { ...cli.env, ...mcpOff.env },
    }).finally(mcpOff.close);
    if (result.exitCode !== 0) throw new Error(describeCliFailure("Droid", result));
    return textTaskResult(args, result.stdout.trim());
  });
}

/**
 * `devin -p` on ADE's pinned Devin. Print mode auto-approves read-only tools
 * only (`--permission-mode auto`) and cannot ask, so nothing else runs. stdin
 * is closed: signed out, Devin tries an interactive login and gives up at
 * once ("Login canceled") instead of waiting.
 */
export async function runDevinTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Devin");
  const cli = await requirePinnedProviderCli("devin");
  return await withTaskDir("ade-devin-task-", async (dir) => {
    const promptPath = path.join(dir, "prompt.md");
    fs.writeFileSync(promptPath, combinedTaskPrompt(args), "utf8");
    const cliArgs = [...cli.leadingArgs, "-p", "--prompt-file", promptPath, "--permission-mode", "auto"];
    const model = resolveDevinCliModelForLaunch(args.descriptor.providerModelId);
    if (model) cliArgs.push("--model", model);
    // The scratch cwd is not a trusted workspace, and print mode cannot ask.
    cliArgs.push("--respect-workspace-trust", "false");
    // Devin's own servers, and the ones it imports from Claude, Cursor and others.
    const mcpOff = openProviderTaskMcpOff("devin", { ...userProcessEnv(), ...cli.env });
    const result = await runCommand({
      command: cli.command,
      argv: cliArgs,
      cwd: oneShotScratchCwd(),
      timeoutMs: args.timeoutMs,
      env: { ...cli.env, ...mcpOff.env },
    }).finally(mcpOff.close);
    if (result.exitCode !== 0) throw new Error(describeCliFailure("Devin", result));
    return textTaskResult(args, result.stdout.trim());
  });
}

/**
 * `pi -p` on ADE's pinned Node and Pi: no tools, no extensions, skills,
 * prompt templates or context files, no saved session. It sees the same
 * environment and profile directory a Pi chat does (`buildPiWorkerEnvironment`).
 */
export async function runPiTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Pi");
  const cli = await requirePinnedProviderCli("pi");
  const agentDir = resolvePiInstallation().agentDir;
  const cliArgs = [
    ...cli.leadingArgs,
    "-p",
    "--mode",
    "text",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
  ];
  const model = resolvePiCliModelForLaunch(args.descriptor.providerModelId);
  if (model) cliArgs.push("--model", model);
  const thinking = piThinkingLevel(args.reasoningEffort);
  if (thinking) cliArgs.push("--thinking", thinking);
  if (args.system?.trim()) cliArgs.push("--system-prompt", args.system.trim());
  const result = await runCommand({
    command: cli.command,
    argv: cliArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    // Pi reads a piped prompt from stdin in print mode.
    stdinText: appendStructuredOutputInstruction(args.prompt, args.jsonSchema),
    baseEnv: { ...buildPiWorkerEnvironment(userProcessEnv(), agentDir), PI_CODING_AGENT_DIR: agentDir },
    env: cli.env,
  });
  if (result.exitCode !== 0) throw new Error(describeCliFailure("Pi", result));
  return textTaskResult(args, result.stdout.trim());
}

/**
 * Antigravity has no print mode: a short ACP session on ADE's pinned
 * `agy_acp_server`, the chat's model, one prompt, then the process is killed.
 * With no sign-in on this machine it fails before starting the agent.
 */
export async function runAntigravityTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Antigravity");
  const baseEnv = userProcessEnv();
  const credentials = await inspectAntigravityCredentials(baseEnv);
  if (!credentials.authenticated) {
    throw new Error("Antigravity is not signed in on this machine. Sign in from Settings > Providers > Antigravity.");
  }
  const executable = await requirePinnedProviderExecutable("antigravity", () => resolveAntigravityExecutable({ env: baseEnv }));
  const result = await runAcpOneShotPrompt({
    provider: "antigravity",
    executable,
    cwd: oneShotScratchCwd(),
    baseEnv,
    modelToken: args.descriptor.providerModelId.trim() || null,
    prompt: combinedTaskPrompt(args),
    timeoutMs: Math.max(1_000, args.timeoutMs ?? 120_000),
  });
  return textTaskResult(args, result.text, result.sessionId);
}
