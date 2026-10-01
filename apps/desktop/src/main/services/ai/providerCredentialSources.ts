import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isRecord, safeJsonParse } from "../shared/utils";
import { killWindowsProcessTree } from "../shared/processExecution";
import { pathKey } from "../shared/pathCompare";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const CODEX_TOKEN_REFRESH_DAYS = 8;
const CLAUDE_CREDENTIAL_MISS_TTL_MS = 60_000;

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

/** `security find-generic-password` exit code for "no such item". */
const KEYCHAIN_ITEM_NOT_FOUND_EXIT = 44;

type ClaudeCredentialSourceRead = {
  credentials: ClaudeLocalAuthCredentials | null;
  /**
   * The Keychain read failed for a reason other than "no such item": the 5 s
   * timeout, a locked Keychain, a cancelled prompt. A miss after that says
   * nothing about the login.
   */
  keychainFailed: boolean;
};

async function readClaudeCredentialSource(
  options: ClaudeCredentialReadOptions,
): Promise<ClaudeCredentialSourceRead> {
  let keychainFailed = false;
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
          return { credentials, keychainFailed: false };
        }
      } else if (result.exitCode !== 0 && result.exitCode !== KEYCHAIN_ITEM_NOT_FOUND_EXIT) {
        keychainFailed = true;
      }
    } catch {
      // Fall back to the local credentials file.
      keychainFailed = true;
    }
  }

  const credentialsPath = claudeCredentialsFile(options.configHome);
  try {
    const raw = await fs.promises.readFile(credentialsPath, "utf8");
    return {
      credentials: parseClaudeCredentials(
        safeJsonParse<Record<string, unknown>>(raw, {}),
        "claude-credentials-file",
      ),
      keychainFailed,
    };
  } catch {
    return { credentials: null, keychainFailed };
  }
}

export async function readClaudeCredentials(
  options: ClaudeCredentialReadOptions = {},
): Promise<ClaudeLocalAuthCredentials | null> {
  return (await readClaudeCredentialSource(options)).credentials;
}

export function isClaudeTokenExpiredOrExpiring(creds: ClaudeLocalAuthCredentials): boolean {
  if (!creds.expiresAt) return false;
  return Date.now() + TOKEN_REFRESH_BUFFER_MS >= creds.expiresAt;
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

/** Clears every account's cache. */
export function clearClaudeCredentialCache(): void {
  claudeCredentialCache.clear();
}

/**
 * Drop only the cached access token so the next read re-reads sources.
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

/**
 * What one Claude account's stored login can do right now.
 *
 * - `ok`: a live access token, returned in `credentials`.
 * - `expired`: the access token expired. The login is still there, and the
 *   Claude CLI refreshes it the next time it runs on this account.
 * - `signed_out`: no login, a login the CLI already cleared, or an expired
 *   token with no refresh token to renew it.
 * - `unreadable`: the Keychain read failed, so this read proves nothing.
 */
export type ClaudeLoginRead =
  | { state: "ok"; credentials: ClaudeLocalAuthCredentials }
  | { state: "expired" }
  | { state: "signed_out" }
  | { state: "unreadable" };

/**
 * Reads one Claude account's login without changing it.
 *
 * ADE never refreshes a Claude token itself. Anthropic rotates the refresh
 * token on every refresh, and the CLI keeps the only saved copy. A refresh
 * here used to spend that copy and keep the new one in memory, so the CLI's
 * next refresh failed and the CLI cleared the login. An idle second account
 * lost its sign-in that way. An expired token is now a state to report: the
 * CLI refreshes it when a chat next runs on the account.
 */
export async function readClaudeLogin(
  options: ClaudeCredentialReadOptions = {},
): Promise<ClaudeLoginRead> {
  const cacheKey = claudeCacheKey(options.configHome);
  const cached = claudeCredentialCache.get(cacheKey);
  if (cached?.credentials && !isClaudeTokenExpiredOrExpiring(cached.credentials)) {
    return { state: "ok", credentials: cached.credentials };
  }

  const skipMissCache = options.skipMissCache ?? (options.allowKeychain !== false);
  if (!skipMissCache && (cached?.missUntilMs ?? 0) > Date.now()) return { state: "signed_out" };

  const { credentials: creds, keychainFailed } = await readClaudeCredentialSource(options);
  if (!creds) {
    if (keychainFailed) return { state: "unreadable" };
    claudeCacheEntry(cacheKey).missUntilMs = Date.now() + CLAUDE_CREDENTIAL_MISS_TTL_MS;
    return { state: "signed_out" };
  }
  claudeCacheEntry(cacheKey).missUntilMs = 0;

  if (!isClaudeTokenExpiredOrExpiring(creds)) {
    cacheClaudeCredentials(creds, options.configHome);
    return { state: "ok", credentials: creds };
  }
  claudeCacheEntry(cacheKey).credentials = null;
  // Without a refresh token the CLI cannot renew it either.
  return creds.refreshToken ? { state: "expired" } : { state: "signed_out" };
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
