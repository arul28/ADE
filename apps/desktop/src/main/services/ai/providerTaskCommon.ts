/**
 * The process plumbing every provider one-shot shares: the argument and result
 * shapes, the spawn that kills its whole tree on a timeout, and the prompt and
 * failure text helpers.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import type { DetectedAuth } from "./authDetector";
import type { AgentPermissionMode } from "./agentExecutor";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import { terminateChildProcessTree } from "../shared/utils";
import { userProcessEnv } from "../shared/hostRuntimeEnv";

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

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function isBenignStdinCloseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

export function appendStructuredOutputInstruction(prompt: string, jsonSchema?: unknown): string {
  if (!jsonSchema) return prompt;
  return `${prompt}

Return only valid JSON matching this schema:
${JSON.stringify(jsonSchema, null, 2)}`;
}

/**
 * Codex and Claude reject an effort a model does not advertise, so only forward
 * a tier the descriptor actually lists. An unknown tier falls back to the CLI
 * default rather than failing the whole task.
 */
export function resolveTaskReasoningEffort(args: ProviderTaskRunnerArgs): string | null {
  const effort = String(args.reasoningEffort ?? "").trim();
  if (!effort) return null;
  const tiers = args.descriptor.reasoningTiers;
  if (tiers?.length && !tiers.includes(effort)) return null;
  return effort;
}

export async function runCommand(args: {
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

/** Why a CLI exited non-zero: stderr, else the tail of stdout, else nothing. */
export function describeCliFailure(label: string, result: SpawnResult): string {
  const detail = result.stderr.trim() || result.stdout.trim().slice(-2_000);
  return `${label} exited with code ${result.exitCode ?? "unknown"}${detail ? `\n\n${detail}` : ""}`;
}
