import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger";
import { isRecord, safeJsonParse } from "../shared/utils";
import { killWindowsProcessTree } from "../shared/processExecution";
import { pathKey } from "../shared/pathCompare";

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
  /**
   * When true, a recent miss does not short-circuit the read. User refreshes
   * pass true. Background polls leave it false so a missing login is not
   * re-probed on every cadence tick.
   */
  skipMissCache?: boolean;
  /**
   * One ADE provider account's config directory (`CLAUDE_CONFIG_DIR`).
   *
   * Absent means this machine's DEFAULT account, and that path is byte-for-byte
   * what this module has always done: `~/.claude/.credentials.json` plus the
   * macOS Keychain. Present means "read exactly this directory and nothing
   * else" — a second login must never fall back to the first one's token. On
   * macOS that includes the Keychain item Claude Code namespaces with this
   * directory (see {@link claudeKeychainServiceName}).
   */
  configHome?: string;
};

/**
 * The macOS Keychain item Claude Code files one account's OAuth credentials in.
 *
 * The Keychain has no notion of a config directory, so Claude Code namespaces
 * the item itself: the default login is the bare `Claude Code-credentials`, and
 * a `CLAUDE_CONFIG_DIR` login appends the first 8 hex characters of the SHA-256
 * of that directory (`Claude Code-credentials-ceba6810` for
 * `/Users/…/provider-homes/claude/1028`). A scoped account on macOS commonly
 * has NO `<configHome>/.credentials.json` — the Keychain item is the only place
 * its login exists — so ADE has to derive the same name to read the login the
 * CLI actually wrote. Pass a config directory the CLI never signed in, and the
 * lookup simply misses; it can never return the default account's token.
 */
export function claudeKeychainServiceName(configHome?: string): string {
  const scoped = configHome?.trim();
  if (!scoped) return "Claude Code-credentials";
  const digest = createHash("sha256").update(path.resolve(scoped)).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${digest}`;
}

/**
 * Where one account's OAuth credentials live.
 *
 * Deliberately NOT `claudeConfigHome()` for the default account: that helper
 * honours `CLAUDE_CONFIG_DIR`, and adopting it here would silently move the
 * default account's credential file on every install that sets the variable.
 * The default account keeps today's fixed path; a scoped account names its own.
 */
function claudeCredentialsFile(configHome?: string): string {
  const scoped = configHome?.trim();
  return scoped
    ? path.join(path.resolve(scoped), ".credentials.json")
    : path.join(os.homedir(), ".claude", ".credentials.json");
}

/**
 * Cache identity for one account's credentials.
 *
 * `""` is the default account. Scoped accounts fold through `pathKey` so
 * Windows and macOS spellings of one directory share an entry instead of
 * caching the same token twice under two keys.
 */
function claudeCacheKey(configHome?: string): string {
  const scoped = configHome?.trim();
  return scoped ? pathKey(path.resolve(scoped)) : "";
}

export async function readClaudeCredentials(
  options: ClaudeCredentialReadOptions = {},
): Promise<ClaudeLocalAuthCredentials | null> {
  // Claude Code stores OAuth credentials in the macOS Keychain, one item per
  // config directory. Reading the item named after THIS account's directory is
  // what keeps a scoped login readable (and parseable) without ever handing it
  // another account's token; the default account keeps the bare item. Windows
  // and Linux never had this branch — the CLI writes a credentials file in the
  // config home there, which is the fallback below.
  if (process.platform === "darwin" && options.allowKeychain !== false) {
    const service = claudeKeychainServiceName(options.configHome);
    try {
      const result = await runShellCommand(
        `security find-generic-password -s '${service}' -w`,
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
          // Keychain read — under its own account — so background pollers
          // (which must not touch the Keychain) can reuse it instead of the
          // possibly-dead file token.
          if (!isClaudeTokenExpiredOrExpiring(credentials)) {
            cacheClaudeCredentials(credentials, options.configHome);
          }
          return credentials;
        }
      }
    } catch {
      // Fall back to the local credentials file.
    }
  }

  const credentialsPath = claudeCredentialsFile(options.configHome);
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

/**
 * Refresh tokens the endpoint already rejected, and when to stop refusing.
 *
 * Keyed by the token itself rather than held in one slot: a machine with
 * several Claude accounts refreshes several distinct tokens, and a single slot
 * meant account B's failure erased the memory of account A's — which reopens
 * the per-poll refresh storm this map exists to prevent.
 */
const failedClaudeRefreshes = new Map<string, number>();
const MAX_TRACKED_CLAUDE_REFRESH_FAILURES = 32;

function noteClaudeRefreshFailure(refreshToken: string, ttlMs: number): void {
  const now = Date.now();
  for (const [token, untilMs] of failedClaudeRefreshes) {
    if (untilMs <= now) failedClaudeRefreshes.delete(token);
  }
  failedClaudeRefreshes.set(refreshToken, now + ttlMs);
  while (failedClaudeRefreshes.size > MAX_TRACKED_CLAUDE_REFRESH_FAILURES) {
    const oldest = failedClaudeRefreshes.keys().next();
    if (oldest.done) break;
    failedClaudeRefreshes.delete(oldest.value);
  }
}

function isClaudeRefreshBlocked(refreshToken: string): boolean {
  const untilMs = failedClaudeRefreshes.get(refreshToken);
  if (untilMs == null) return false;
  if (Date.now() < untilMs) return true;
  failedClaudeRefreshes.delete(refreshToken);
  return false;
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

    failedClaudeRefreshes.delete(refreshToken);
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

/**
 * Cached credentials PER ACCOUNT config home.
 *
 * One slot used to be enough because the machine had one Claude login. It no
 * longer is: a shared slot hands whichever account polled first its token to
 * whichever account polls next, which reads as "both accounts have the same
 * quota" and, worse, sends one account's bearer token for the other. The key is
 * the config home (see {@link claudeCacheKey}); `""` is the default account.
 */
type ClaudeCredentialCacheEntry = {
  credentials: ClaudeLocalAuthCredentials | null;
  missUntilMs: number;
};
const claudeCredentialCache = new Map<string, ClaudeCredentialCacheEntry>();

function claudeCacheEntry(key: string): ClaudeCredentialCacheEntry {
  const existing = claudeCredentialCache.get(key);
  if (existing) return existing;
  const created: ClaudeCredentialCacheEntry = { credentials: null, missUntilMs: 0 };
  claudeCredentialCache.set(key, created);
  return created;
}

/** Clears every account's cache and the whole refresh-refusal memory. */
export function clearClaudeCredentialCache(): void {
  claudeCredentialCache.clear();
  failedClaudeRefreshes.clear();
}

/**
 * Drop only the cached access token so the next read re-reads sources.
 * Keeps the refresh-token refusal memory intact — a 401 on the usage API
 * must not reopen per-poll refresh attempts for a token the token endpoint
 * already rejected.
 *
 * Scoped to one account when `configHome` is given; the default account
 * otherwise, which is what every pre-instance caller means.
 */
export function invalidateCachedClaudeCredentials(configHome?: string): void {
  claudeCredentialCache.delete(claudeCacheKey(configHome));
}

export function cacheClaudeCredentials(
  credentials: ClaudeLocalAuthCredentials,
  configHome?: string,
): void {
  claudeCredentialCache.set(claudeCacheKey(configHome), { credentials, missUntilMs: 0 });
}

export async function readClaudeCredentialsWithRefresh(
  logger: Logger,
  options: ClaudeCredentialReadOptions = {},
): Promise<ClaudeLocalAuthCredentials | null> {
  const cacheKey = claudeCacheKey(options.configHome);
  const cached = claudeCredentialCache.get(cacheKey);
  if (cached?.credentials && !isClaudeTokenExpiredOrExpiring(cached.credentials)) {
    return cached.credentials;
  }

  const skipMissCache = options.skipMissCache ?? (options.allowKeychain !== false);
  if (!skipMissCache && (cached?.missUntilMs ?? 0) > Date.now()) return null;

  const creds = await readClaudeCredentials(options);
  if (!creds) {
    claudeCacheEntry(cacheKey).missUntilMs = Date.now() + CLAUDE_CREDENTIAL_MISS_TTL_MS;
    return null;
  }
  claudeCacheEntry(cacheKey).missUntilMs = 0;

  if (!isClaudeTokenExpiredOrExpiring(creds)) {
    cacheClaudeCredentials(creds, options.configHome);
    return creds;
  }

  if (creds.refreshToken && !isClaudeRefreshBlocked(creds.refreshToken)) {
    logger.info("usage.token_refresh.attempting", { expiresAt: creds.expiresAt });
    const refreshed = await refreshClaudeCredentials(creds.refreshToken);
    if (refreshed) {
      logger.info("usage.token_refresh.success", {
        expiresIn: refreshed.expiresAt ? Math.round((refreshed.expiresAt - Date.now()) / 1000) : "unknown",
      });
      cacheClaudeCredentials(refreshed, options.configHome);
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
  const entry = claudeCacheEntry(cacheKey);
  entry.credentials = null;
  entry.missUntilMs = Date.now() + CLAUDE_CREDENTIAL_MISS_TTL_MS;
  return null;
}

/**
 * `configHome` names ONE account's `CODEX_HOME`. It outranks the environment
 * variable, which describes this process's own default account — a machine with
 * several logins reads each one by passing its home, never by mutating
 * `process.env`.
 */
export async function readCodexCredentials(
  configHome?: string,
): Promise<CodexLocalAuthCredentials | null> {
  const scoped = configHome?.trim();
  const codexHome = scoped
    ? path.resolve(scoped)
    : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
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
