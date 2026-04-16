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
import { resolveCodexExecutable } from "./codexExecutable";
import { resolveCursorAgentExecutable } from "./cursorAgentExecutable";
import { parseStructuredOutput } from "./utils";
import { runOpenCodeTextPrompt } from "../opencode/openCodeRuntime";

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

function appendStructuredOutputInstruction(prompt: string, jsonSchema?: unknown): string {
  if (!jsonSchema) return prompt;
  return `${prompt}

Return only valid JSON matching this schema:
${JSON.stringify(jsonSchema, null, 2)}`;
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

function buildCursorArgsMode(mode: AgentPermissionMode | undefined): "plan" | "ask" | null {
  if (mode === "read-only" || mode == null) return "ask";
  return null;
}

async function runCommand(args: {
  command: string;
  argv: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<SpawnResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Math.max(1_000, args.timeoutMs ?? 120_000);
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Provider task timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
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
    "-p",
    "--model",
    args.descriptor.providerModelId,
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
  cliArgs.push(prompt);

  const resolved = resolveClaudeCodeExecutable({ auth: args.auth });
  const result = await runCommand({
    command: resolved.path,
    argv: cliArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
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
  const prompt = appendStructuredOutputInstruction(args.prompt, args.jsonSchema);
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

  if (args.jsonSchema) {
    const schemaPath = path.join(tmpDir, "schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify(args.jsonSchema, null, 2), "utf8");
    cliArgs.push("--output-schema", schemaPath);
  }

  if (args.system?.trim()) {
    cliArgs.push(`${args.system.trim()}\n\n${prompt}`);
  } else {
    cliArgs.push(prompt);
  }

  const resolved = resolveCodexExecutable({ auth: args.auth });
  try {
    const result = await runCommand({
      command: resolved.path,
      argv: cliArgs,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
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
  const sessionId = args.sessionId?.trim() || null;
  const cliArgs = [
    "--print",
    "--output-format",
    "text",
    "--trust",
    "--workspace",
    args.cwd,
    "--model",
    args.descriptor.providerModelId,
  ];
  const mode = buildCursorArgsMode(args.permissionMode);
  if (mode) {
    cliArgs.push("--mode", mode);
  }
  if (sessionId) {
    cliArgs.push("--resume", sessionId);
  }
  const combinedPrompt = args.system?.trim()
    ? `${args.system.trim()}\n\n${prompt}`
    : prompt;
  cliArgs.push(combinedPrompt);

  const resolved = resolveCursorAgentExecutable({ auth: args.auth });
  const result = await runCommand({
    command: resolved.path,
    argv: cliArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Cursor agent exited with code ${result.exitCode ?? "unknown"}${result.stderr.trim() ? `\n\n${result.stderr.trim()}` : ""}`);
  }
  const text = result.stdout.trim();
  return {
    text,
    structuredOutput: args.jsonSchema ? parseStructuredOutput(text) : null,
    sessionId,
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
