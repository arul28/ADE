import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
// Deep import rather than the `services/tools` barrel: the barrel pulls the
// whole fetch/install stack with it.
import { pinnedToolDownload } from "../../../../../ade-cli/src/services/tools/onDemand";
import { providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { pinnedToolNotReadyError } from "./pinnedProviderTools";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import {
  isExecutablePath,
  resolveClaudeCodeExecutable,
} from "./claudeCodeExecutable";
import {
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeFailure,
  reportProviderRuntimeReady,
} from "./providerRuntimeHealth";
import { noteClaudeCodeInit } from "./claudeCodeInit";
import { handleClaudeVersionRejection } from "./claudeFallForward";
import {
  detectClaudeVersionRejectionInError,
  detectClaudeVersionRejectionInMessage,
  type ClaudeVersionRejection,
} from "./providerVersionRejection";

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CACHE_TTL_MS = 30_000;
export const CLAUDE_RUNTIME_AUTH_ERROR =
  "Claude Code is detected, but ADE chat could not authenticate it. Run `claude auth login` in a terminal or configure ANTHROPIC_API_KEY, then refresh AI settings.";
const DEFAULT_RUNTIME_FAILURE =
  "ADE could not confirm that its Claude Code runtime can start from this app session.";
/**
 * First run on a cold tools cache: nothing is wrong, the pinned runtime is
 * simply still coming down. Surfacing the SDK's raw "not found" there reads as
 * a broken install, which it is not.
 */
export const CLAUDE_RUNTIME_FETCH_PENDING_ERROR =
  "ADE is still downloading the Claude Code runtime for this machine. "
  + "Start the chat again when it finishes.";
/** The pinned tool that backs the Claude runtime, as named in the tools manifest. */
const CLAUDE_TOOL_NAME = "claude-code";

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

  // No copy of ADE's pinned Claude Code here yet: start (or join) its
  // download and spawn nothing. The connection status already reports the
  // download state, so this is neither cached nor published as runtime health,
  // which would outlive the download.
  const claudeExecutable = resolveClaudeCodeExecutable();
  if (claudeExecutable.source === "fallback-command") {
    const downloading = pinnedToolDownload(CLAUDE_TOOL_NAME) != null;
    args.logger?.info?.("ai.claude_runtime_probe.skipped_not_downloaded", {
      projectRoot,
      message: downloading ? CLAUDE_RUNTIME_FETCH_PENDING_ERROR : pinnedToolNotReadyError(CLAUDE_TOOL_NAME, "Claude Code").message,
    });
    return;
  }

  // Anthropic refusing this build as too old, if the probe saw it.
  const seen: { versionRejection: ClaudeVersionRejection | null } = { versionRejection: null };
  const probe = (async (): Promise<ClaudeRuntimeProbeResult> => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
    let stream: ReturnType<typeof claudeQuery> | null = null;

    try {
      stream = claudeQuery({
        prompt: "System initialization check. Respond with only the word READY.",
        options: {
          cwd: projectRoot,
          permissionMode: "plan",
          tools: [],
          abortController,
          pathToClaudeCodeExecutable: claudeExecutable.path,
          env: { ...process.env, ...providerSelfUpdateEnv("claude") },
          // This probe only answers "can the runtime start and authenticate". Left
          // unisolated it boots the user's entire MCP fleet and writes a session file on
          // every cache miss, which is slow and makes a broken MCP server look like a
          // broken Claude runtime. Slash commands are discovered separately by
          // claudeSlashCommandDiscovery, so nothing here needs filesystem settings.
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
        },
      });

      for await (const message of stream) {
        if (message.type === "system" && message.subtype === "init") noteClaudeCodeInit(message);
        seen.versionRejection ??= detectClaudeVersionRejectionInMessage(message);
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
      seen.versionRejection ??= detectClaudeVersionRejectionInError(error);
      const missingMessageIsFalseNegative = isExecutablePath(claudeExecutable.path)
        && normalizeErrorMessage(error).toLowerCase().includes("native binary not found");
      const runtimeFailureMessage = missingMessageIsFalseNegative
        ? `Claude runtime failed to spawn resolved executable ${claudeExecutable.path}: ${normalizeErrorMessage(error)}`
        : normalizeErrorMessage(error);
      const result = isClaudeRuntimeAuthError(error)
        ? { state: "auth-failed", message: CLAUDE_RUNTIME_AUTH_ERROR } satisfies ClaudeRuntimeProbeResult
        : { state: "runtime-failed", message: runtimeFailureMessage } satisfies ClaudeRuntimeProbeResult;
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
    if (seen.versionRejection) {
      // Move to Anthropic's newest build in the background; once it runs, the
      // cached failure is stale.
      void handleClaudeVersionRejection({ rejection: seen.versionRejection, rejected: claudeExecutable, logger: args.logger })
        .then((outcome) => {
          if (outcome.switched) probeCache.delete(projectRoot);
        });
    }
    if (result.state === "ready") {
      args.logger?.info?.("ai.claude_runtime_probe.ready", { projectRoot });
    } else {
      args.logger?.warn?.("ai.claude_runtime_probe.failed", {
        projectRoot,
        state: result.state,
        message: result.message,
      });
    }
  } finally {
    inFlightProbes.delete(projectRoot);
  }
}
