import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger";
import { isRecord, safeJsonParse } from "../shared/utils";

const CLAUDE_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const CODEX_TOKEN_REFRESH_DAYS = 8;

export type LocalAuthSource =
  | "macos-keychain"
  | "claude-credentials-file"
  | "codex-auth-file";

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
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
        child.kill("SIGKILL");
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

export async function readClaudeCredentials(): Promise<ClaudeLocalAuthCredentials | null> {
  if (process.platform === "darwin") {
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
        if (credentials) return credentials;
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

export async function refreshClaudeCredentials(refreshToken: string): Promise<ClaudeLocalAuthCredentials | null> {
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
    if (!response.ok) return null;

    const payload = (await response.json()) as ClaudeTokenRefreshResponse;
    if (!payload.access_token) return null;

    const expiresAt =
      payload.expires_in != null
        ? Date.now() + payload.expires_in * 1000
        : undefined;

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
      expiresAt,
      source: "claude-credentials-file",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let cachedClaudeCreds: ClaudeLocalAuthCredentials | null = null;

export function clearClaudeCredentialCache(): void {
  cachedClaudeCreds = null;
}

export async function readClaudeCredentialsWithRefresh(logger: Logger): Promise<ClaudeLocalAuthCredentials | null> {
  if (cachedClaudeCreds && !isClaudeTokenExpiredOrExpiring(cachedClaudeCreds)) {
    return cachedClaudeCreds;
  }

  const creds = await readClaudeCredentials();
  if (!creds) return null;

  if (!isClaudeTokenExpiredOrExpiring(creds)) {
    cachedClaudeCreds = creds;
    return creds;
  }

  if (creds.refreshToken) {
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

  cachedClaudeCreds = creds;
  return creds;
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
