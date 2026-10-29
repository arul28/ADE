import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentPermissionMode } from "./agentExecutor";
import type { DetectedAuth } from "./authDetector";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { claudeFallForwardNotice, handleClaudeVersionRejection } from "./claudeFallForward";
import { resolveClaudeCliModel } from "./claudeModelUtils";
import { resolveCodexExecutable } from "./codexExecutable";
import { codexFallForwardNotice, handleCodexVersionRejection } from "./codexFallForward";
import {
  detectClaudeVersionRejectionInMessage,
  detectClaudeVersionRejectionInOutput,
  detectCodexVersionRejectionInOutput,
  type ClaudeVersionRejection,
} from "./providerVersionRejection";
import { requirePinnedProviderExecutable } from "./pinnedProviderTools";
import { CODEX_NO_UPDATE_CHECK_ARGS, providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { resolveCopilotSdkRuntime } from "./acpExecutables";
import { getApiKey } from "./apiKeyStore";
import { parseStructuredOutput } from "./utils";
import { runOpenCodeTextPrompt } from "../opencode/openCodeSession";
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
  resolveCodexCliModelForLaunch,
} from "../../../shared/cliLaunch";
import { resolveCliProviderForModel } from "../../../shared/modelRegistry";
import type { Item } from "@muse-code/sdk/dist/src/msp.js";
import { isMuseKnownNotification, startPinnedMuseHost } from "../chat/museSdkHost";
import { addUsage, museCompletionUsage, type MuseTurnUsage } from "../chat/museSdkEventMapper";
import { acquireCopilotSdkConnection, releaseCopilotSdkConnection } from "../chat/copilotSdkPool";
import { copilotConfigHome } from "../shared/providerConfigHomes";
import {
  appendStructuredOutputInstruction,
  describeCliFailure,
  resolveTaskReasoningEffort,
  runCommand,
  type ProviderTaskRunnerArgs,
  type ProviderTaskRunnerResult,
  type SpawnResult,
} from "./providerTaskCommon";
import {
  rejectUnsupportedAcpTaskImages,
  runAntigravityTask,
  runDevinTask,
  runDroidTask,
  runGrokTask,
  runKimiTask,
  runPiTask,
  runQwenTask,
} from "./pinnedCliTaskRunners";

export type { ProviderTaskRunnerArgs, ProviderTaskRunnerResult } from "./providerTaskCommon";


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

function buildCodexSandbox(mode: AgentPermissionMode | undefined): "read-only" | "workspace-write" | "danger-full-access" {
  if (mode === "full-auto") return "danger-full-access";
  if (mode === "edit") return "workspace-write";
  return "read-only";
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
    try {
      await host.close();
    } finally {
      mcpOff.close();
    }
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
