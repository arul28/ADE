import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import type { DetectedAuth } from "./authDetector";
import type { AgentPermissionMode } from "./agentExecutor";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { resolveClaudeCliModel } from "./claudeModelUtils";
import { resolveCodexExecutable } from "./codexExecutable";
import { getApiKey } from "./apiKeyStore";
import { parseStructuredOutput } from "./utils";
import { runOpenCodeTextPrompt } from "../opencode/openCodeRuntime";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";

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
}): Promise<SpawnResult> {
  return await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      NO_COLOR: "1",
      TERM: "dumb",
    };
    const invocation = resolveCliSpawnInvocation(args.command, args.argv, env);
    const child = spawn(invocation.command, invocation.args, {
      cwd: args.cwd,
      env,
      stdio: [args.stdinText != null ? "pipe" : "ignore", "pipe", "pipe"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Math.max(1_000, args.timeoutMs ?? 120_000);
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child, "SIGTERM");
      reject(new Error(`Provider task timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stdin?.on("error", (error) => {
      if (settled || isBenignStdinCloseError(error)) return;
      settled = true;
      clearTimeout(timeoutHandle);
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
      resolve({ stdout, stderr, exitCode });
    });

    if (args.stdinText != null && child.stdin) {
      child.stdin.end(args.stdinText);
    }
  });
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
  const sessionId = args.sessionId?.trim() || (args.feature === "orchestrator" ? randomUUID() : null);
  const cliArgs = [
    "--model",
    resolveClaudeCliModel(args.descriptor.providerModelId),
    "--output-format",
    args.jsonSchema ? "json" : "text",
    "--permission-mode",
    buildClaudePermissionMode(args.permissionMode),
  ];

  if (args.system?.trim()) {
    cliArgs.push("--system-prompt", args.system.trim());
  }
  if (args.jsonSchema) {
    cliArgs.push("--json-schema", JSON.stringify(args.jsonSchema));
  }
  if (sessionId) {
    cliArgs.push("--session-id", sessionId);
  } else {
    cliArgs.push("--no-session-persistence");
  }
  cliArgs.push("-p");

  const resolved = resolveClaudeCodeExecutable({ auth: args.auth });
  const result = await runCommand({
    command: resolved.path,
    argv: cliArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    stdinText: prompt,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Claude exited with code ${result.exitCode ?? "unknown"}${result.stderr.trim() ? `\n\n${result.stderr.trim()}` : ""}`);
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

  cliArgs.push("-");
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;

  const resolved = resolveCodexExecutable({ auth: args.auth });
  try {
    const result = await runCommand({
      command: resolved.path,
      argv: cliArgs,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      stdinText: combinedPrompt,
    });
    const output = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8").trim() : result.stdout.trim();
    if (result.exitCode !== 0) {
      throw new Error(`Codex exited with code ${result.exitCode ?? "unknown"}${result.stderr.trim() ? `\n\n${result.stderr.trim()}` : ""}`);
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
  const { Agent } = await import("@cursor/sdk");
  const agent = args.sessionId?.trim()
    ? await Agent.resume(args.sessionId.trim(), {
        apiKey,
        model: { id: args.descriptor.providerModelId },
        local: { cwd: args.cwd, sandboxOptions: { enabled: false } },
      })
    : await Agent.create({
        apiKey,
        model: { id: args.descriptor.providerModelId },
        name: `ADE ${args.feature}`,
        local: { cwd: args.cwd, sandboxOptions: { enabled: false } },
      });
  const run = await agent.send(combinedPrompt, {
    model: { id: args.descriptor.providerModelId },
    local: { force: args.permissionMode === "full-auto" },
  });
  const timeoutMs = args.timeoutMs ?? 120_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    run.wait(),
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        run.cancel().catch(() => {});
        reject(new Error(`Cursor SDK task timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
  if (result.status === "error") {
    throw new Error(result.result?.trim() || "Cursor SDK task failed.");
  }
  if (result.status === "cancelled") {
    throw new Error("Cursor SDK task was cancelled.");
  }
  const text = (result.result ?? "").trim();
  return {
    text,
    structuredOutput: args.jsonSchema ? parseStructuredOutput(text) : null,
    sessionId: agent.agentId,
  };
}

async function runOpenCodeTask(args: ProviderTaskRunnerArgs): Promise<ProviderTaskRunnerResult> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error(`OpenCode task timed out after ${timeoutMs}ms.`)), timeoutMs);
  try {
    const result = await runOpenCodeTextPrompt({
      directory: args.cwd,
      title: `ADE ${args.feature}`,
      projectConfig: args.projectConfig,
      modelDescriptor: args.descriptor,
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
  return await runOpenCodeTask(args);
}
