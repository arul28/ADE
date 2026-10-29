import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import type { DetectedAuth } from "./authDetector";
import type { AgentPermissionMode } from "./agentExecutor";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { claudeFallForwardNotice, handleClaudeVersionRejection } from "./claudeFallForward";
import { resolveClaudeCliModel } from "./claudeModelUtils";
import { resolveCodexExecutable } from "./codexExecutable";
import { codexFallForwardNotice, handleCodexVersionRejection } from "./codexFallForward";
import { detectCodexVersionRejectionInOutput } from "./providerVersionRejection";
import { requirePinnedProviderExecutable } from "./pinnedProviderTools";
import {
  detectClaudeVersionRejectionInMessage,
  detectClaudeVersionRejectionInOutput,
  type ClaudeVersionRejection,
} from "./providerVersionRejection";
import { CODEX_NO_UPDATE_CHECK_ARGS, GROK_NO_AUTO_UPDATE_ARG, providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import {
  resolveAntigravityExecutable,
  resolveCopilotSdkRuntime,
  resolveGrokExecutable,
  resolveKimiExecutable,
  resolveQwenExecutable,
  type AcpExecutableResolution,
} from "./acpExecutables";
import { getApiKey } from "./apiKeyStore";
import { parseStructuredOutput } from "./utils";
import { runOpenCodeTextPrompt } from "../opencode/openCodeSession";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import { terminateChildProcessTree } from "../shared/utils";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import { assertCursorSdkSupportedOnThisPlatform } from "./cursorSdkLoader";
import { runCursorSdkLocalPrompt } from "../chat/cursorSdkPool";
import { resolveCursorSdkModelSelectionParams } from "../chat/cursorModelSelection";
import { claudeBackgroundUtilityFlags, codexStandardSpeedFlags } from "../../../shared/backgroundUtilityModel";
import { codexDisableConfiguredMcpArgs } from "../mcp/codexMcpOff";
import { openProviderTaskMcpOff } from "../mcp/providerTaskMcpOff";
import {
  claudeRuntimeEffortFlags,
  codexReasoningEffortFlags,
  resolveGrokCliModelForLaunch,
  resolveKimiCliModelForLaunch,
  resolveCodexCliModelForLaunch,
  resolveDevinCliModelForLaunch,
  resolvePiCliModelForLaunch,
  resolveQwenCliModelForLaunch,
  piThinkingLevel,
} from "../../../shared/cliLaunch";
import { resolveCliProviderForModel } from "../../../shared/modelRegistry";
import type { Item } from "@muse-code/sdk/dist/src/msp.js";
import { isMuseKnownNotification, startPinnedMuseHost } from "../chat/museSdkHost";
import { addUsage, museCompletionUsage, type MuseTurnUsage } from "../chat/museSdkEventMapper";
import { acquireCopilotSdkConnection, releaseCopilotSdkConnection } from "../chat/copilotSdkPool";
import { copilotConfigHome } from "../shared/providerConfigHomes";
import { requirePinnedProviderCli } from "../pty/pinnedProviderCli";
import { inspectAntigravityCredentials } from "./antigravityAuth";
import { runAcpOneShotPrompt } from "../chat/acpHost/acpOneShotPrompt";
import { resolvePiInstallation } from "./piInstallation";
import { buildPiWorkerEnvironment } from "../chat/piSdkEnvironment";

export type ProviderTaskRunnerArgs = {
  cwd: string;
  descriptor: ModelDescriptor;
  auth?: DetectedAuth[];
  prompt: string;
  system?: string;
  timeoutMs?: number;
  jsonSchema?: unknown;
  permissionMode?: AgentPermissionMode;
  feature: string;
  sessionId?: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  imagePaths?: string[];
  reasoningEffort?: string | null;
  /**
   * A background text-in, text-out task (names, status lines, summaries) that
   * needs no tools: everything it reads is in the prompt.
   * - Claude: drops every tool and MCP server, runs outside plan mode (plan
   *   mode loads a ~47k-token setup), and asks for JSON in the prompt rather
   *   than through the structured-output tool, which costs extra model turns.
   *   Measured on Haiku 5.5: ~1.7s and ~4k tokens instead of ~4.7s and ~96k.
   * - Codex and Cursor: pinned to standard speed, so a user's global Fast
   *   setting never bills a chat name at Fast rates.
   */
  backgroundUtility?: boolean;
  /**
   * The provider-account env patch (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) for the
   * Claude and Codex CLIs. Without it the CLI reads whatever config home the
   * process environment names, which is not necessarily the account the
   * caller's chat runs on.
   */
  accountEnv?: Record<string, string>;
};

export type ProviderTaskRunnerResult = {
  text: string;
  structuredOutput: unknown;
  sessionId: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function isBenignStdinCloseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function appendStructuredOutputInstruction(prompt: string, jsonSchema?: unknown): string {
  if (!jsonSchema) return prompt;
  return `${prompt}

Return only valid JSON matching this schema:
${JSON.stringify(jsonSchema, null, 2)}`;
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const next = { ...schema };
  const type = next.type;
  if (Array.isArray(type)) {
    next.type = type.includes("null") ? type : [...type, "null"];
  } else if (typeof type === "string") {
    next.type = type === "null" ? type : [type, "null"];
  } else if (!("anyOf" in next) && !("oneOf" in next)) {
    next.type = ["null"];
  }

  if (Array.isArray(next.enum) && !next.enum.includes(null)) {
    next.enum = [...next.enum, null];
  }
  return next;
}

function strictifyJsonSchema(value: unknown, optionalProperty: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => strictifyJsonSchema(entry, false));
  }
  if (!isSchemaRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "properties" || key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf") continue;
    next[key] = strictifyJsonSchema(entry, false);
  }

  if (isSchemaRecord(value.properties)) {
    const originalRequired = new Set(
      Array.isArray(value.required)
        ? value.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const properties: Record<string, unknown> = {};
    for (const [propertyName, propertySchema] of Object.entries(value.properties)) {
      properties[propertyName] = strictifyJsonSchema(propertySchema, !originalRequired.has(propertyName));
    }
    next.properties = properties;
    next.required = Object.keys(properties);
    next.additionalProperties = false;
  }

  if (value.items !== undefined) {
    next.items = strictifyJsonSchema(value.items, false);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(value[key])) {
      next[key] = value[key].map((entry) => strictifyJsonSchema(entry, false));
    }
  }

  const isObjectSchema = next.type === "object"
    || (Array.isArray(next.type) && next.type.includes("object"))
    || isSchemaRecord(next.properties);
  if (isObjectSchema && next.additionalProperties !== false) {
    next.additionalProperties = false;
  }

  return optionalProperty ? nullableSchema(next) : next;
}

export function makeCodexCompatibleJsonSchema(schema: unknown): unknown {
  return strictifyJsonSchema(schema, false);
}

function buildClaudePermissionMode(mode: AgentPermissionMode | undefined): string {
  if (mode === "full-auto") return "bypassPermissions";
  if (mode === "edit") return "acceptEdits";
  return "plan";
}

/**
 * Codex and Claude reject an effort a model does not advertise, so only forward
 * a tier the descriptor actually lists. An unknown tier falls back to the CLI
 * default rather than failing the whole task.
 */
function resolveTaskReasoningEffort(args: ProviderTaskRunnerArgs): string | null {
  const effort = String(args.reasoningEffort ?? "").trim();
  if (!effort) return null;
  const tiers = args.descriptor.reasoningTiers;
  if (tiers?.length && !tiers.includes(effort)) return null;
  return effort;
}

function buildCodexSandbox(mode: AgentPermissionMode | undefined): "read-only" | "workspace-write" | "danger-full-access" {
  if (mode === "full-auto") return "danger-full-access";
  if (mode === "edit") return "workspace-write";
  return "read-only";
}

async function runCommand(args: {
  command: string;
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  stdinText?: string;
  env?: Record<string, string>;
  /** The environment to build on; the user's process environment when omitted. */
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<SpawnResult> {
  // The CLI leads its own process group (POSIX), so a timeout kills the whole
  // tree: SIGTERM, then SIGKILL if anything is still there. Windows kills the
  // tree with `taskkill /T /F`.
  return await new Promise((resolve, reject) => {
    const env = {
      ...(args.baseEnv ?? userProcessEnv()),
      ...args.env,
      NO_COLOR: "1",
      TERM: "dumb",
    };
    const invocation = resolveCliSpawnInvocation(args.command, args.argv, env);
    const child = spawn(invocation.command, invocation.args, {
      cwd: args.cwd,
      env,
      stdio: [args.stdinText != null ? "pipe" : "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
    });
    const killTree = () => {
      terminateChildProcessTree(child).unref?.();
    };

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Math.max(1_000, args.timeoutMs ?? 120_000);
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      reject(new Error(`Provider task timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    // A decoder per stream keeps a UTF-8 character split across two chunks
    // (the "·" in Claude's usage-limit message) intact.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : String(chunk);
    });
    child.stdin?.on("error", (error) => {
      if (settled || isBenignStdinCloseError(error)) return;
      settled = true;
      clearTimeout(timeoutHandle);
      killTree();
      reject(error);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ stdout: stdout + stdoutDecoder.end(), stderr: stderr + stderrDecoder.end(), exitCode });
    });

    if (args.stdinText != null && child.stdin) {
      child.stdin.end(args.stdinText);
    }
  });
}

/**
 * The message Claude reports for a failed print-mode run. With
 * `--output-format json` an API failure (a 429 usage limit, an auth error)
 * arrives on stdout as `{"is_error":true,"result":"...","api_error_status":429}`
 * with an empty stderr, so the exit code alone hides the cause.
 */
function extractClaudeError(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.is_error !== true) return null;
    const message = typeof parsed.result === "string" && parsed.result.trim()
      ? parsed.result.trim()
      : "Claude reported an error";
    const status = typeof parsed.api_error_status === "number" ? parsed.api_error_status : null;
    return status ? `${message} (HTTP ${status})` : message;
  } catch {
    return null;
  }
}

/** Anthropic refusing the run's Claude Code as too old: the JSON result, or the exit and its output. */
function claudeTaskVersionRejection(result: SpawnResult): ClaudeVersionRejection | null {
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const rejection = detectClaudeVersionRejectionInMessage(JSON.parse(trimmed));
      if (rejection) return rejection;
    } catch {
      // Not a JSON result; read it as text below.
    }
  }
  return detectClaudeVersionRejectionInOutput(result);
}

/** Why a CLI exited non-zero: stderr, else the tail of stdout, else nothing. */
function describeCliFailure(label: string, result: SpawnResult): string {
  const detail = result.stderr.trim() || result.stdout.trim().slice(-2_000);
  return `${label} exited with code ${result.exitCode ?? "unknown"}${detail ? `\n\n${detail}` : ""}`;
}

function extractClaudeText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.result === "string") {
      return parsed.result.trim();
    }
    if (parsed.result != null) {
      return JSON.stringify(parsed.result);
    }
  } catch {
    // Fall back to raw output.
  }
  return trimmed;
}

async function runClaudeTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  const sessionId = args.sessionId?.trim() || null;
  const backgroundUtility = args.backgroundUtility === true;
  const cliArgs = [
    "--model",
    resolveClaudeCliModel(args.descriptor.providerModelId),
    "--output-format",
    args.jsonSchema ? "json" : "text",
    "--permission-mode",
    // With no tools there is nothing to permit; plan mode would only swap models.
    backgroundUtility ? "default" : buildClaudePermissionMode(args.permissionMode),
  ];
  if (backgroundUtility) cliArgs.push(...claudeBackgroundUtilityFlags());

  if (args.system?.trim()) {
    cliArgs.push("--system-prompt", args.system.trim());
  }
  if (args.jsonSchema && !backgroundUtility) {
    cliArgs.push("--json-schema", JSON.stringify(args.jsonSchema));
  }
  if (args.descriptor.capabilities?.reasoning !== false) {
    cliArgs.push(...claudeRuntimeEffortFlags(resolveTaskReasoningEffort(args)));
  }
  if (sessionId) {
    cliArgs.push("--session-id", sessionId);
  } else {
    cliArgs.push("--no-session-persistence");
  }
  cliArgs.push("-p");

  const resolved = await requirePinnedProviderExecutable("claude", () => resolveClaudeCodeExecutable());
  const run = (command: string) => runCommand({
    command,
    argv: cliArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    stdinText: prompt,
    env: { ...providerSelfUpdateEnv("claude"), ...args.accountEnv },
  });
  let result = await run(resolved.path);
  const versionRejection = claudeTaskVersionRejection(result);
  if (versionRejection) {
    // Anthropic refused this build as too old. Once ADE has moved to the
    // newest build the task runs again there, once: a refusal ran nothing,
    // except that an API refusal may have opened the named session already.
    const outcome = await handleClaudeVersionRejection({ rejection: versionRejection, rejected: resolved });
    const rerun = outcome.switched && (versionRejection.signal !== "api_min_version" || !sessionId);
    if (!rerun) {
      throw new Error(`Claude failed: ${versionRejection.message} ${claudeFallForwardNotice(outcome, { after: "retry" })}`);
    }
    result = await run(resolveClaudeCodeExecutable().path);
  }
  const reportedError = extractClaudeError(result.stdout);
  if (reportedError) {
    throw new Error(`Claude failed: ${reportedError}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(describeCliFailure("Claude", result));
  }
  const text = extractClaudeText(result.stdout);
  return {
    text,
    structuredOutput: args.jsonSchema ? parseStructuredOutput(text) : null,
    sessionId,
  };
}

async function runCodexTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  const codexJsonSchema = args.jsonSchema ? makeCodexCompatibleJsonSchema(args.jsonSchema) : undefined;
  const prompt = appendStructuredOutputInstruction(args.prompt, codexJsonSchema);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-task-"));
  const outPath = path.join(tmpDir, "out.txt");
  const cliArgs = [
    "exec",
    ...CODEX_NO_UPDATE_CHECK_ARGS,
    "--color",
    "never",
    "--sandbox",
    buildCodexSandbox(args.permissionMode),
    "--cd",
    args.cwd,
    "--skip-git-repo-check",
    "--output-last-message",
    outPath,
  ];

  // Without these the CLI silently runs whatever ~/.codex/config.toml defaults
  // to, so every ADE model/effort selection on the Codex path was inert.
  const codexModel = resolveCodexCliModelForLaunch(args.descriptor.providerModelId);
  if (codexModel) {
    cliArgs.push("--model", codexModel);
  }
  cliArgs.push(...codexReasoningEffortFlags(resolveTaskReasoningEffort(args)));
  if (args.backgroundUtility) cliArgs.push(...codexStandardSpeedFlags(), ...codexDisableConfiguredMcpArgs({ ...process.env, ...args.accountEnv }, args.cwd));

  if (args.permissionMode === "full-auto") {
    cliArgs.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    cliArgs.push("--ephemeral");
  }

  if (codexJsonSchema) {
    const schemaPath = path.join(tmpDir, "schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify(codexJsonSchema, null, 2), "utf8");
    cliArgs.push("--output-schema", schemaPath);
  }
  for (const imagePath of args.imagePaths ?? []) {
    cliArgs.push("--image", imagePath);
  }

  cliArgs.push("-");
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;

  let resolved: ReturnType<typeof resolveCodexExecutable>;
  try {
    resolved = await requirePinnedProviderExecutable("codex", () => resolveCodexExecutable());
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
  try {
    const run = (command: string) => runCommand({
      command,
      argv: cliArgs,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      stdinText: combinedPrompt,
      env: args.accountEnv,
    });
    let result = await run(resolved.path);
    const versionRejection = detectCodexVersionRejectionInOutput({ ...result, requestedModel: codexModel });
    if (versionRejection) {
      // OpenAI refused the model for this Codex. A refused request ran
      // nothing, so once ADE has moved to a newer Codex that OpenAI accepts
      // for it, the task runs again there, once.
      const outcome = await handleCodexVersionRejection({
        rejection: versionRejection,
        rejected: resolved,
        accountEnv: { ...userProcessEnv(), ...args.accountEnv },
      });
      if (!outcome.switched) {
        throw new Error(`Codex failed: ${versionRejection.message} ${codexFallForwardNotice(outcome, { after: "retry" })}`);
      }
      result = await run(resolveCodexExecutable().path);
    }
    const output = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8").trim() : result.stdout.trim();
    if (result.exitCode !== 0) {
      throw new Error(describeCliFailure("Codex", result));
    }
    return {
      text: output,
      structuredOutput: args.jsonSchema ? parseStructuredOutput(output) : null,
      sessionId: null,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Run a one-off Cursor task on the same forked SDK worker pool every other
 * Cursor feature uses.
 *
 * Every Cursor one-off runs on the pooled worker: it gets worker isolation, the
 * sandbox-unsupported fallback, agent retries, trimmed setting sources, a
 * throwaway state root, and an agent that is closed instead of leaked. Never
 * call `Agent.create` in the host process.
 *
 * A one-shot is a tool-less text task, so it always runs under the pool's fixed
 * `CURSOR_SDK_ONESHOT_POLICY` and `args.permissionMode` decides nothing here.
 *
 * `args.sessionId` is deliberately ignored here. It exists for the Claude
 * branch's `--session-id`, no caller feeds a previous Cursor agent id back in,
 * and a one-shot must not resume a conversation.
 */
async function runCursorTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;
  const apiKey = args.auth?.find(
    (entry): entry is Extract<DetectedAuth, { type: "api-key" }> =>
      entry.type === "api-key" && entry.provider === "cursor",
  )?.key?.trim() || getApiKey("cursor")?.trim();
  if (!apiKey) {
    throw new Error("Cursor tasks require a Cursor API key. Add one in Settings > AI Providers.");
  }
  // The pool forks a worker before it can report an unsupported platform, so
  // keep the win32-arm64 blocker on the near side of the fork.
  assertCursorSdkSupportedOnThisPlatform();
  // Standard speed for background tasks. The in-memory catalog maps it to the
  // model's own speed parameter; a model without one (or no catalog loaded
  // yet) sends nothing, and a chat name never waits on a catalog fetch.
  const modelParams = args.backgroundUtility
    ? resolveCursorSdkModelSelectionParams({
      modelSdkId: args.descriptor.providerModelId,
      serviceTier: "standard",
    })
    : undefined;
  const result = await runCursorSdkLocalPrompt({
    projectRoot: args.cwd,
    workspacePath: args.cwd,
    apiKey,
    modelSdkId: args.descriptor.providerModelId,
    ...(modelParams?.length ? { modelParams } : {}),
    promptText: combinedPrompt,
    feature: args.feature,
    timeoutMs: args.timeoutMs ?? 120_000,
  });
  return {
    text: result.text,
    structuredOutput: args.jsonSchema ? parseStructuredOutput(result.text) : null,
    sessionId: result.agentId,
  };
}

/**
 * One prompt through a short-lived `muse serve` host: start a session, run a
 * single turn, collect the reply, close. Read-only tasks select Muse's
 * `denyUnmatched` mode, so a title or summary can never touch the workspace.
 */
async function runMuseTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  const combinedPrompt = args.system?.trim() ? `${args.system.trim()}\n\n${prompt}` : prompt;
  const baseEnv = { ...userProcessEnv(), ...(args.accountEnv ?? {}) };
  // Muse starts its settings' MCP servers with every session; this job uses none.
  const mcpOff = openProviderTaskMcpOff("muse", baseEnv);
  const host = await startPinnedMuseHost({
    baseEnv: { ...baseEnv, ...mcpOff.env },
    noSessionLog: true,
    cwd: args.cwd,
    clientVersion: "ade",
    userInputDialogs: false,
  }).catch((error: unknown) => {
    mcpOff.close();
    throw error;
  });
  try {
    // Nobody watches a one-shot task, so it can never answer an approval or a
    // question: Muse refuses anything its rules do not already allow, and the
    // host says it has no question dialogs (`userInputDialogs: false`).
    const started = await host.command<{ session: { sessionId: string } }>("session/start", {
      workspaceRoot: args.cwd,
      modelId: args.descriptor.providerModelId,
      approvalMode: "denyUnmatched",
    });
    const sessionId = started.session.sessionId;
    const texts = new Map<string, string>();
    // Filled in by the subscription callback below.
    const tally: { usage: MuseTurnUsage | null } = { usage: null };
    const turnId = host.mintCommandId();
    const completed = new Promise<{ terminal: string; message?: string }>((resolve) => {
      host.subscribe(sessionId, (notification) => {
        if (!isMuseKnownNotification(notification)) return;
        switch (notification.method) {
          case "item/completed": {
            const item: Item | undefined = notification.params.item;
            if (item?.kind === "agentMessage" && item.itemId && item.turnId === turnId) {
              texts.set(item.itemId, item.text ?? "");
            }
            return;
          }
          case "session/tokenUsage": {
            if (notification.params.turnId !== turnId) return;
            // Uncached input from MSP's counted-once `promptTokens`.
            tally.usage = addUsage(tally.usage, museCompletionUsage(notification.params));
            return;
          }
          case "turn/completed": {
            if (notification.params.turnId !== turnId) return;
            const error = notification.params.error;
            resolve({ terminal: String(notification.params.terminal ?? "completed"), ...(error?.message ? { message: error.message } : {}) });
            return;
          }
          default:
            return;
        }
      });
      host.onExit(() => resolve({ terminal: "failed", message: host.stderrTail().slice(-4).join("\n") || "Muse stopped." }));
    });
    await host.command("turn/start", {
      sessionId,
      input: [{ type: "text", text: combinedPrompt }],
      ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    }, { commandId: turnId });
    const timeoutMs = args.timeoutMs ?? 120_000;
    let timer: NodeJS.Timeout | null = null;
    const outcome = await Promise.race([
      completed,
      new Promise<{ terminal: string; message: string }>((resolve) => {
        timer = setTimeout(() => resolve({ terminal: "failed", message: `Muse did not answer within ${timeoutMs} ms.` }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.terminal !== "completed") throw new Error(outcome.message ?? `Muse turn ${outcome.terminal}.`);
    const text = [...texts.values()].join("\n").trim();
    const counted = tally.usage;
    return {
      text,
      structuredOutput: args.jsonSchema ? parseStructuredOutput(text) : null,
      sessionId,
      inputTokens: counted?.inputTokens ?? null,
      outputTokens: counted?.outputTokens ?? null,
    };
  } finally {
    await host.close();
    mcpOff.close();
  }
}

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
  // Kimi and Grok start their config's MCP servers at launch; Qwen's safe mode starts none.
  const mcpOff = config.provider === "qwen"
    ? null
    : openProviderTaskMcpOff(config.provider, { ...userProcessEnv(), ...env });
  const result = await runCommand({
    command: config.resolved.path,
    // Qwen's pin is a Node plus its script; the script comes first.
    argv: [...(config.resolved.args ?? []), ...config.argv],
    cwd: args.cwd,
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

function rejectUnsupportedAcpTaskImages(args: ProviderTaskRunnerArgs, providerLabel: string): void {
  if ((args.imagePaths?.length ?? 0) > 0) {
    throw new Error(
      "Image input is not supported with "
        + providerLabel
        + " native metadata tasks; retry with a provider that supports image input.",
    );
  }
}

async function runCopilotTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  rejectUnsupportedAcpTaskImages(args, "Copilot");
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;
  const resolved = await requirePinnedProviderExecutable("copilot", () => resolveCopilotSdkRuntime());
  const baseEnv = userProcessEnv({ ...process.env, ...providerSelfUpdateEnv("copilot"), ...(args.accountEnv ?? {}) });
  const baseDirectory = copilotConfigHome({ env: baseEnv });
  const acquired = await acquireCopilotSdkConnection({
    cliPath: resolved.path,
    baseDirectory,
    baseEnv,
  });
  try {
    const response = await acquired.pooled.utility({
      cwd: args.cwd,
      prompt: combinedPrompt,
      model: args.descriptor.providerModelId === "auto" ? undefined : args.descriptor.providerModelId,
      systemMessage: "Return only the requested metadata. Do not use tools or access external resources.",
    });
    const record = response && typeof response === "object" ? response as Record<string, unknown> : {};
    const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
    const text = typeof data.content === "string"
      ? data.content
      : typeof record.content === "string"
        ? record.content
        : typeof record.message === "string" ? record.message : "";
    return { text: text.trim(), structuredOutput: args.jsonSchema ? parseStructuredOutput(text) : null, sessionId: null };
  } finally {
    releaseCopilotSdkConnection(acquired.poolKey, acquired.generation);
  }
}

async function runQwenTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
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

async function runKimiTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
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

async function runGrokTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
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
 * (Droid, Devin, Antigravity): one fixed ADE directory, so a chat title never
 * lands in the project's own session history, and a job that has everything
 * in its prompt has no workspace to read.
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
async function runDroidTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
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
async function runDevinTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
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
async function runPiTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
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
async function runAntigravityTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
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

async function runOpenCodeTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error(`OpenCode task timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    const result = await runOpenCodeTextPrompt({
      config: { projectConfig: args.projectConfig },
      directory: args.cwd,
      modelDescriptor: args.descriptor,
      ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
      prompt: appendStructuredOutputInstruction(args.prompt, args.jsonSchema),
      system: args.system,
      signal: controller.signal,
    });
    return {
      text: result.text,
      structuredOutput: args.jsonSchema ? parseStructuredOutput(result.text) : null,
      sessionId: null,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function runProviderTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  if (args.descriptor.family === "anthropic" && args.descriptor.isCliWrapped) {
    return await runClaudeTask(args);
  }
  if (args.descriptor.family === "openai" && args.descriptor.isCliWrapped) {
    return await runCodexTask(args);
  }
  if (args.descriptor.family === "cursor") {
    return await runCursorTask(args);
  }
  if (args.descriptor.family === "muse") {
    return await runMuseTask(args);
  }
  // Every provider runs its own models on its own pinned runtime. OpenCode
  // runs only what is OpenCode's: API-key, OpenRouter and local models.
  const cliProvider = resolveCliProviderForModel(args.descriptor);
  switch (cliProvider) {
    case null:
      return await runOpenCodeTask(args);
    case "qwen":
      return await runQwenTask(args);
    case "kimi":
      return await runKimiTask(args);
    case "grok":
      return await runGrokTask(args);
    case "copilot":
      return await runCopilotTask(args);
    case "droid":
      return await runDroidTask(args);
    case "devin":
      return await runDevinTask(args);
    case "pi":
      return await runPiTask(args);
    case "antigravity":
      return await runAntigravityTask(args);
    default:
      // Claude, Codex, Cursor and Muse were routed above by family.
      throw new Error(`ADE has no one-shot runner for ${cliProvider} model '${args.descriptor.id}'.`);
  }
}
