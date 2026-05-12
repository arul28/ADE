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
  "native cli binary",
  "native binary not found",
  "without --omit=optional",
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

export function getClaudeNativeBinaryPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin" && arch === "arm64") return "@anthropic-ai/claude-agent-sdk-darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@anthropic-ai/claude-agent-sdk-darwin-x64";
  if (platform === "linux" && arch === "arm64") return "@anthropic-ai/claude-agent-sdk-linux-arm64";
  if (platform === "linux" && arch === "x64") return "@anthropic-ai/claude-agent-sdk-linux-x64";
  if (platform === "win32" && arch === "x64") return "@anthropic-ai/claude-agent-sdk-win32-x64";
  if (platform === "win32" && arch === "arm64") return "@anthropic-ai/claude-agent-sdk-win32-arm64";
  return null;
}

export function getClaudeNativeBinaryFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

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
): Exclude<ClaudeStartupProbeResult, { state: "ready"; message: null }> {
  const message = errorMessage(input).trim() || "Claude startup probe returned an error result.";
  if (isClaudeAuthFailureMessage(message)) {
    return {
      state: "auth-failed",
      message,
    };
  }
  if (isClaudeBinaryMissingMessage(message)) {
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
