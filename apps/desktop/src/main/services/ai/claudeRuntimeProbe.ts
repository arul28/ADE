import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import {
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeFailure,
  reportProviderRuntimeReady,
} from "./providerRuntimeHealth";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { normalizeCliMcpServers } from "./cliMcpConfig";
import { resolveDesktopAdeMcpLaunch, resolveRepoRuntimeRoot } from "../runtime/adeMcpLaunch";

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CACHE_TTL_MS = 30_000;
export const CLAUDE_RUNTIME_AUTH_ERROR =
  "Claude Code is detected, but ADE chat could not authenticate it. Run /login in chat or sign in with `claude auth login`, then refresh AI settings.";
const DEFAULT_RUNTIME_FAILURE =
  "Claude Code is installed, but ADE could not confirm that the Claude chat runtime can start from this app session.";

type ClaudeRuntimeProbeResult =
  | { state: "ready"; message: null }
  | { state: "auth-failed"; message: string }
  | { state: "runtime-failed"; message: string };

/** Cache and in-flight probe keyed by projectRoot to avoid cross-project contamination. */
const probeCache = new Map<string, { checkedAtMs: number; result: ClaudeRuntimeProbeResult }>();
const inFlightProbes = new Map<string, Promise<ClaudeRuntimeProbeResult>>();

function normalizeErrorMessage(error: unknown): string {
  const text = getErrorMessage(error).trim();
  return text.length > 0 ? text : DEFAULT_RUNTIME_FAILURE;
}

export function isClaudeRuntimeAuthError(input: unknown): boolean {
  const lower = normalizeErrorMessage(input).toLowerCase();
  return (
    lower.includes("not authenticated")
    || lower.includes("not logged in")
    || lower.includes("authentication required")
    || lower.includes("authentication error")
    || lower.includes("authentication_error")
    || lower.includes("login required")
    || lower.includes("sign in")
    || lower.includes("claude auth login")
    || lower.includes("/login")
    || lower.includes("authentication_failed")
    || lower.includes("invalid authentication credentials")
    || lower.includes("invalid api key")
    || lower.includes("api error: 401")
    || lower.includes("status code: 401")
    || lower.includes("status 401")
  );
}

function resultFromSdkMessage(message: SDKMessage): ClaudeRuntimeProbeResult | null {
  if (message.type === "auth_status" && message.error) {
    return { state: "auth-failed", message: CLAUDE_RUNTIME_AUTH_ERROR };
  }

  if (message.type === "assistant" && message.error === "authentication_failed") {
    return { state: "auth-failed", message: CLAUDE_RUNTIME_AUTH_ERROR };
  }

  if (message.type !== "result") {
    return null;
  }

  if (!message.is_error) {
    return { state: "ready", message: null };
  }

  const errors = "errors" in message && Array.isArray(message.errors)
    ? message.errors.filter(Boolean).join(" ")
    : "";
  if (isClaudeRuntimeAuthError(errors)) {
    return { state: "auth-failed", message: CLAUDE_RUNTIME_AUTH_ERROR };
  }

  return {
    state: "runtime-failed",
    message: errors.trim() || DEFAULT_RUNTIME_FAILURE,
  };
}

function cacheResult(projectRoot: string, result: ClaudeRuntimeProbeResult): ClaudeRuntimeProbeResult {
  probeCache.set(projectRoot, { checkedAtMs: Date.now(), result });
  return result;
}

function resolveProbeMcpServers(projectRoot: string): Record<string, Record<string, unknown>> | undefined {
  const launch = resolveDesktopAdeMcpLaunch({
    projectRoot,
    workspaceRoot: projectRoot,
    runtimeRoot: resolveRepoRuntimeRoot(),
    defaultRole: "external",
  });
  return normalizeCliMcpServers("claude", {
    ade: {
      command: launch.command,
      args: launch.cmdArgs,
      env: launch.env,
    },
  });
}

function publishResult(result: ClaudeRuntimeProbeResult): void {
  switch (result.state) {
    case "ready":
      reportProviderRuntimeReady("claude");
      break;
    case "auth-failed":
      reportProviderRuntimeAuthFailure("claude", result.message);
      break;
    case "runtime-failed":
      reportProviderRuntimeFailure("claude", result.message);
      break;
  }
}

export function resetClaudeRuntimeProbeCache(): void {
  probeCache.clear();
}

export async function probeClaudeRuntimeHealth(args: {
  projectRoot: string;
  logger?: Pick<Logger, "info" | "warn">;
  force?: boolean;
}): Promise<void> {
  const { projectRoot } = args;
  const now = Date.now();
  const cached = probeCache.get(projectRoot);
  if (!args.force && cached && now - cached.checkedAtMs < PROBE_CACHE_TTL_MS) {
    publishResult(cached.result);
    return;
  }

  const existing = inFlightProbes.get(projectRoot);
  if (!args.force && existing) {
    publishResult(await existing);
    return;
  }

  let claudeExecutablePath: string | null = null;

  const probe = (async (): Promise<ClaudeRuntimeProbeResult> => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
    let stream: ReturnType<typeof claudeQuery> | null = null;

    try {
      const claudeExecutable = resolveClaudeCodeExecutable();
      claudeExecutablePath = claudeExecutable.path;
      stream = claudeQuery({
        prompt: "System initialization check. Respond with only the word READY.",
        options: {
          cwd: projectRoot,
          permissionMode: "plan",
          tools: [],
          pathToClaudeCodeExecutable: claudeExecutable.path,
          mcpServers: resolveProbeMcpServers(projectRoot) as any,
          abortController,
        },
      });

      for await (const message of stream) {
        const result = resultFromSdkMessage(message);
        if (result) {
          return cacheResult(projectRoot, result);
        }
      }
      return cacheResult(projectRoot, {
        state: "runtime-failed",
        message: DEFAULT_RUNTIME_FAILURE,
      });
    } catch (error) {
      const result = isClaudeRuntimeAuthError(error)
        ? { state: "auth-failed", message: CLAUDE_RUNTIME_AUTH_ERROR } satisfies ClaudeRuntimeProbeResult
        : {
            state: "runtime-failed",
            message: normalizeErrorMessage(error),
          } satisfies ClaudeRuntimeProbeResult;
      return cacheResult(projectRoot, result);
    } finally {
      clearTimeout(timeout);
      try {
        stream?.close();
      } catch {
        // Best effort cleanup — avoid leaving the probe subprocess running.
      }
    }
  })();
  inFlightProbes.set(projectRoot, probe);

  try {
    const result = await probe;
    publishResult(result);
    if (result.state === "ready") {
      args.logger?.info?.("ai.claude_runtime_probe.ready", { projectRoot });
    } else {
      args.logger?.warn?.("ai.claude_runtime_probe.failed", {
        projectRoot,
        state: result.state,
        message: result.message,
        claudeExecutablePath,
      });
    }
  } finally {
    inFlightProbes.delete(projectRoot);
  }
}
