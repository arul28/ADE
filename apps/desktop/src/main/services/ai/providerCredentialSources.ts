import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger";
import { isRecord, safeJsonParse } from "../shared/utils";
import { killWindowsProcessTree } from "../shared/processExecution";

const CLAUDE_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const CODEX_TOKEN_REFRESH_DAYS = 8;
const CLAUDE_CREDENTIAL_MISS_TTL_MS = 60_000;
// A refresh token the endpoint rejected (4xx) is rotated or revoked; retrying
// it on every poll cycle looks like an OAuth storm to Anthropic and gets the
// whole client rate-limited. Remember the rejected token and stop asking.
const CLAUDE_REFRESH_REJECTED_TTL_MS = 24 * 60 * 60_000;
const CLAUDE_REFRESH_TRANSIENT_TTL_MS = 10 * 60_000;

export type LocalAuthSource =
  | "macos-keychain"
  | "claude-credentials-file"
  | "codex-auth-file"
  | "cursor-env";

export type ClaudeLocalAuthCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  plan?: string;
  source?: Extract<LocalAuthSource, "macos-keychain" | "claude-credentials-file">;
};

export type CodexLocalAuthCredentials = {
  accessToken: string;
  lastRefresh?: number;
  source?: Extract<LocalAuthSource, "codex-auth-file">;
};

function extractStringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }
  return undefined;
}

function extractNumberField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof obj[key] === "number") return obj[key] as number;
  }
  return undefined;
}

function extractTimestampField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function parseClaudeCredentials(
  parsed: Record<string, unknown>,
  source: ClaudeLocalAuthCredentials["source"],
): ClaudeLocalAuthCredentials | null {
  const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed;
  const token = extractStringField(oauth, "accessToken", "access_token");
  if (!token) return null;
  return {
    accessToken: token,
    refreshToken: extractStringField(oauth, "refreshToken", "refresh_token"),
    expiresAt: extractNumberField(oauth, "expiresAt", "expires_at"),
    plan: extractStringField(oauth, "plan", "subscriptionType", "rateLimitTier", "rate_limit_tier"),
    source,
  };
}

function parseCodexCredentials(parsed: Record<string, unknown>): CodexLocalAuthCredentials | null {
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : parsed;
  const token = extractStringField(tokens, "access_token", "accessToken");
  if (!token) return null;
  return {
    accessToken: token,
    lastRefresh: extractTimestampField(parsed, "last_refresh", "lastRefresh"),
    source: "codex-auth-file",
  };
}

export function runShellCommand(
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const useCmd = process.platform === "win32";
    const executable = useCmd ? (process.env.ComSpec?.trim() || "cmd.exe") : "sh";
    const args = useCmd ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsVerbatimArguments: useCmd,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, 50_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 10_000);
    });

    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") {
          killWindowsProcessTree(child.pid ?? 0, (detail) => {
            console.warn("provider_credentials.taskkill_failed", detail);
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export type ClaudeCredentialReadOptions = {
  /** Keychain reads can display macOS UI. Automatic/background callers must disable them. */
  allowKeychain?: boolean;
};

export async function readClaudeCredentials(
  options: ClaudeCredentialReadOptions = {},
): Promise<ClaudeLocalAuthCredentials | null> {
  if (process.platform === "darwin" && options.allowKeychain !== false) {
    try {
      const result = await runShellCommand(
        "security find-generic-password -s 'Claude Code-credentials' -w",
        5_000,
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        const credentials = parseClaudeCredentials(
          safeJsonParse<Record<string, unknown>>(result.stdout.trim(), {}),
          "macos-keychain",
        );
        if (credentials) {
          // The Keychain holds the CLI's live login while the credentials file
          // can be a stale leftover from an older install. Cache every valid
          // Keychain read so background pollers (which must not touch the
          // Keychain) can reuse it instead of the possibly-dead file token.
          if (!isClaudeTokenExpiredOrExpiring(credentials)) {
            cacheClaudeCredentials(credentials);
          }
          return credentials;
        }
      }
    } catch {
      // Fall back to the local credentials file.
    }
  }

  const credentialsPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const raw = await fs.promises.readFile(credentialsPath, "utf8");
    return parseClaudeCredentials(
      safeJsonParse<Record<string, unknown>>(raw, {}),
      "claude-credentials-file",
    );
  } catch {
    return null;
  }
}

export function isClaudeTokenExpiredOrExpiring(creds: ClaudeLocalAuthCredentials): boolean {
  if (!creds.expiresAt) return false;
  return Date.now() + TOKEN_REFRESH_BUFFER_MS >= creds.expiresAt;
}

type ClaudeTokenRefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

let failedClaudeRefresh: { refreshToken: string; untilMs: number } | null = null;

function noteClaudeRefreshFailure(refreshToken: string, ttlMs: number): void {
  failedClaudeRefresh = { refreshToken, untilMs: Date.now() + ttlMs };
}

function isClaudeRefreshBlocked(refreshToken: string): boolean {
  return failedClaudeRefresh != null
    && failedClaudeRefresh.refreshToken === refreshToken
    && Date.now() < failedClaudeRefresh.untilMs;
}

export async function refreshClaudeCredentials(refreshToken: string): Promise<ClaudeLocalAuthCredentials | null> {
  if (isClaudeRefreshBlocked(refreshToken)) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      // 5xx/429/408 are transient endpoint conditions; other 4xx mean the
      // token itself was rejected (rotated or revoked) and will never work.
      const transient = response.status >= 500 || response.status === 429 || response.status === 408;
      noteClaudeRefreshFailure(
        refreshToken,
        transient ? CLAUDE_REFRESH_TRANSIENT_TTL_MS : CLAUDE_REFRESH_REJECTED_TTL_MS,
      );
      return null;
    }

    const payload = (await response.json()) as ClaudeTokenRefreshResponse;
    if (!payload.access_token) {
      noteClaudeRefreshFailure(refreshToken, CLAUDE_REFRESH_REJECTED_TTL_MS);
      return null;
    }

    const expiresAt =
      payload.expires_in != null
        ? Date.now() + payload.expires_in * 1000
        : undefined;

    failedClaudeRefresh = null;
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
      expiresAt,
      source: "claude-credentials-file",
    };
  } catch {
    noteClaudeRefreshFailure(refreshToken, CLAUDE_REFRESH_TRANSIENT_TTL_MS);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let cachedClaudeCreds: ClaudeLocalAuthCredentials | null = null;
let cachedClaudeMissUntilMs = 0;

export function clearClaudeCredentialCache(): void {
  cachedClaudeCreds = null;
  cachedClaudeMissUntilMs = 0;
  failedClaudeRefresh = null;
}

/**
 * Drop only the cached access token so the next read re-reads sources.
 * Keeps the refresh-token refusal memory intact — a 401 on the usage API
 * must not reopen per-poll refresh attempts for a token the token endpoint
 * already rejected.
 */
export function invalidateCachedClaudeCredentials(): void {
  cachedClaudeCreds = null;
  cachedClaudeMissUntilMs = 0;
}

export function cacheClaudeCredentials(credentials: ClaudeLocalAuthCredentials): void {
  cachedClaudeCreds = credentials;
  cachedClaudeMissUntilMs = 0;
}

export async function readClaudeCredentialsWithRefresh(
  logger: Logger,
  options: ClaudeCredentialReadOptions = {},
): Promise<ClaudeLocalAuthCredentials | null> {
  if (cachedClaudeCreds && !isClaudeTokenExpiredOrExpiring(cachedClaudeCreds)) {
    return cachedClaudeCreds;
  }

  const userInitiated = options.allowKeychain !== false;
  if (!userInitiated && cachedClaudeMissUntilMs > Date.now()) return null;

  const creds = await readClaudeCredentials(options);
  if (!creds) {
    cachedClaudeMissUntilMs = Date.now() + CLAUDE_CREDENTIAL_MISS_TTL_MS;
    return null;
  }
  cachedClaudeMissUntilMs = 0;

  if (!isClaudeTokenExpiredOrExpiring(creds)) {
    cachedClaudeCreds = creds;
    return creds;
  }

  if (creds.refreshToken && !isClaudeRefreshBlocked(creds.refreshToken)) {
    logger.info("usage.token_refresh.attempting", { expiresAt: creds.expiresAt });
    const refreshed = await refreshClaudeCredentials(creds.refreshToken);
    if (refreshed) {
      logger.info("usage.token_refresh.success", {
        expiresIn: refreshed.expiresAt ? Math.round((refreshed.expiresAt - Date.now()) / 1000) : "unknown",
      });
      cachedClaudeCreds = refreshed;
      return refreshed;
    }
    logger.warn("usage.token_refresh.failed", {
      message: "refresh endpoint returned no token",
    });
  }

  // The token is expired and could not be refreshed. Returning it anyway
  // guarantees a 401 (and another doomed refresh attempt) on every poll —
  // enough of those and Anthropic rate-limits the whole client. Report
  // "no usable credentials" instead so callers surface a reconnect state.
  cachedClaudeMissUntilMs = Date.now() + CLAUDE_CREDENTIAL_MISS_TTL_MS;
  return null;
}

export async function readCodexCredentials(): Promise<CodexLocalAuthCredentials | null> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = await fs.promises.readFile(authPath, "utf8");
    return parseCodexCredentials(safeJsonParse<Record<string, unknown>>(raw, {}));
  } catch {
    return null;
  }
}

export function isCodexTokenStale(creds: CodexLocalAuthCredentials): boolean {
  if (!creds.lastRefresh) return false;
  const ageMs = Date.now() - creds.lastRefresh;
  return ageMs > CODEX_TOKEN_REFRESH_DAYS * 24 * 60 * 60 * 1000;
}

export const _testing = {
  runShellCommand,
  parseClaudeCredentials,
  parseCodexCredentials,
};
