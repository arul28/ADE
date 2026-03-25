import type { ClaudeCodeExecutableResolution } from "./services/ai/claudeCodeExecutable";

const AUTH_FAILURE_PATTERNS = [
  "not authenticated",
  "not logged in",
  "authentication required",
  "authentication error",
  "authentication_error",
  "login required",
  "sign in",
  "claude auth login",
  "/login",
  "authentication_failed",
  "invalid authentication credentials",
  "invalid api key",
  "api error: 401",
  "status code: 401",
  "status 401",
];

const BINARY_MISSING_PATTERNS = [
  "claude code native binary not found",
  "native binary not found",
  "spawn enoent",
  "enoent",
  "no such file or directory",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ClaudeStartupProbeResult =
  | { state: "ready"; message: null }
  | { state: "auth-failed"; message: string }
  | { state: "binary-missing"; message: string }
  | { state: "runtime-failed"; message: string };

export function isClaudeAuthFailureMessage(input: unknown): boolean {
  const lower = errorMessage(input).toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function isClaudeBinaryMissingMessage(input: unknown): boolean {
  const lower = errorMessage(input).toLowerCase();
  return BINARY_MISSING_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function classifyClaudeStartupFailure(
  input: unknown,
  executableSource: ClaudeCodeExecutableResolution["source"],
): Exclude<ClaudeStartupProbeResult, { state: "ready"; message: null }> {
  const message = errorMessage(input).trim() || "Claude startup probe returned an error result.";
  if (isClaudeAuthFailureMessage(message)) {
    return {
      state: "auth-failed",
      message,
    };
  }
  if (executableSource === "fallback-command" && isClaudeBinaryMissingMessage(message)) {
    return {
      state: "binary-missing",
      message,
    };
  }
  return {
    state: "runtime-failed",
    message,
  };
}
