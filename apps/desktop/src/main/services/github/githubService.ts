import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import type { GitHubRepoRef, GitHubStatus } from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { parseGitHubScopeHeaders } from "../../../shared/githubScopes";

import { nowIso, asString } from "../shared/utils";

const AUTH_STORE_FILE_NAME = "github-token.v1.bin";

function parseGitHubRepoFromRemoteUrl(remoteUrlRaw: string): GitHubRepoRef | null {
  const remoteUrl = remoteUrlRaw.trim();
  if (!remoteUrl) return null;

  // git@github.com:owner/repo.git
  const sshScp = remoteUrl.match(/^git@github\.com:(.+)$/i);
  if (sshScp) {
    const slug = sshScp[1].replace(/\.git$/i, "").trim();
    const [owner, name] = slug.split("/");
    if (owner && name) return { owner, name };
    return null;
  }

  // ssh://git@github.com/owner/repo.git
  if (remoteUrl.startsWith("ssh://") || remoteUrl.startsWith("https://") || remoteUrl.startsWith("http://")) {
    try {
      const url = new URL(remoteUrl);
      if (!/github\.com$/i.test(url.hostname)) return null;
      const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
      const owner = parts[0]?.trim() ?? "";
      const name = parts[1]?.trim() ?? "";
      if (owner && name) return { owner, name };
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

export function createGithubService({
  logger,
  projectRoot,
  appDataDir,
}: {
  logger: Logger;
  projectRoot: string;
  appDataDir: string;
}) {
  const legacyGithubStateDir = resolveAdeLayout(projectRoot).githubSecretsDir;
  const legacyTokenPath = path.join(legacyGithubStateDir, AUTH_STORE_FILE_NAME);
  const githubStateDir = path.join(appDataDir, "secrets", "github");
  const tokenPath = path.join(githubStateDir, AUTH_STORE_FILE_NAME);

  let tokenDecryptionFailed = false;

  const readEncryptedToken = (candidatePath: string): string | null => {
    if (!fs.existsSync(candidatePath)) return null;
    try {
      const bytes = fs.readFileSync(candidatePath);
      if (!safeStorage.isEncryptionAvailable()) {
        tokenDecryptionFailed = true;
        logger.warn("github.token_decryption_failed", {
          reason: "os_secure_storage_unavailable",
          message: "OS secure storage is unavailable; GitHub token cannot be decrypted. Please re-authenticate."
        });
        return null;
      }
      const decrypted = safeStorage.decryptString(bytes);
      const parsed = JSON.parse(decrypted) as { token?: unknown };
      const token = asString(parsed?.token);
      tokenDecryptionFailed = false;
      return token.trim().length ? token.trim() : null;
    } catch (error) {
      tokenDecryptionFailed = true;
      logger.warn("github.token_decryption_failed", {
        reason: "decrypt_or_parse_error",
        message: "GitHub token exists but could not be decrypted. The token may be corrupted — please re-authenticate.",
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const removeTokenFile = (candidatePath: string): void => {
    try {
      if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath);
    } catch {
      // ignore
    }
  };

  const persistEncryptedToken = (candidatePath: string, token: string | null): void => {
    const clean = (token ?? "").trim();
    if (!clean) {
      removeTokenFile(candidatePath);
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. Cannot persist GitHub token.");
    }

    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({ token: clean }));
    fs.writeFileSync(candidatePath, encrypted);
    try {
      fs.chmodSync(candidatePath, 0o600);
    } catch {
      // ignore best-effort chmod
    }
  };

  let migrationDone = false;
  const migrateLegacyTokenIfNeeded = (): string | null => {
    const globalToken = readEncryptedToken(tokenPath);
    if (globalToken) {
      tokenDecryptionFailed = false;
      migrationDone = true;
      return globalToken;
    }

    if (migrationDone) return null;

    const legacyToken = readEncryptedToken(legacyTokenPath);
    if (!legacyToken) { migrationDone = true; return null; }

    try {
      persistEncryptedToken(tokenPath, legacyToken);
      removeTokenFile(legacyTokenPath);
      logger.info("github.token_migrated_to_global_store", { projectRoot });
    } catch (error) {
      logger.warn("github.token_migration_failed", {
        projectRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    tokenDecryptionFailed = false;
    migrationDone = true;
    return legacyToken;
  };

  const readStoredToken = (): string | null => {
    const token = migrateLegacyTokenIfNeeded();
    if (!token) {
      tokenDecryptionFailed = false;
    }
    return token;
  };

  const persistToken = (token: string | null): void => {
    persistEncryptedToken(tokenPath, token);
    if (!(token ?? "").trim()) {
      removeTokenFile(legacyTokenPath);
    } else if (fs.existsSync(legacyTokenPath)) {
      removeTokenFile(legacyTokenPath);
    }
  };

  const detectRepo = async (): Promise<GitHubRepoRef | null> => {
    const res = await runGit(["remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 8000 });
    if (res.exitCode !== 0) return null;
    return parseGitHubRepoFromRemoteUrl(res.stdout);
  };

  const validateToken = async (token: string): Promise<{ userLogin: string | null; scopes: string[] }> => {
    const response = await fetch("https://api.github.com/user", {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "ade-desktop"
      }
    });

    const scopes = parseGitHubScopeHeaders(response.headers);

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const msg = asString(payload.message) || `GitHub token validation failed (HTTP ${response.status})`;
      throw new Error(msg);
    }

    return {
      userLogin: asString(payload.login) || null,
      scopes
    };
  };

  // ETag cache for conditional GET requests. Responses that return 304 Not Modified
  // don't count against GitHub's rate limit, so this dramatically reduces API usage.
  const etagCache = new Map<string, { etag: string; data: unknown }>();
  const ETAG_CACHE_MAX_SIZE = 200;

  const apiRequest = async <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    token?: string;
  }): Promise<{ data: T; response: Response | null }> => {
    const token = (args.token ?? readStoredToken() ?? "").trim();
    if (!token) {
      throw new Error("GitHub token missing. Set it in Settings.");
    }

    const baseUrl = "https://api.github.com";
    const url = new URL(`${baseUrl}${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }

    const urlKey = url.toString();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": args.body != null ? "application/json" : "text/plain",
      "user-agent": "ade-desktop"
    };

    // For GET requests, send If-None-Match with cached ETag if available.
    // GitHub returns 304 Not Modified for free (no rate limit cost).
    if (args.method === "GET") {
      const cached = etagCache.get(urlKey);
      if (cached) {
        headers["if-none-match"] = cached.etag;
      }
    }

    const response = await fetch(url.toString(), {
      method: args.method,
      headers,
      body: args.body != null ? JSON.stringify(args.body) : undefined
    });

    // 304 Not Modified — return cached data (free, no rate limit cost)
    if (response.status === 304) {
      const cached = etagCache.get(urlKey);
      if (cached) {
        return { data: cached.data as T, response };
      }
    }

    const text = await response.text();
    let data: unknown = text;
    try {
      data = text.trim().length ? JSON.parse(text) : {};
    } catch {
      // keep text
    }

    if (!response.ok) {
      const message =
        (data && typeof data === "object" && !Array.isArray(data) ? asString((data as any).message) : "") ||
        `GitHub API request failed (HTTP ${response.status})`;
      let detail = "";
      if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as any).errors)) {
        const errorMessages = ((data as any).errors as any[])
          .map((e) => (typeof e === "object" && e && typeof e.message === "string" ? e.message : null))
          .filter(Boolean);
        if (errorMessages.length > 0) {
          detail = ": " + errorMessages.join("; ");
        }
      }
      const rateRemaining = response.headers.get("x-ratelimit-remaining");
      const rateReset = response.headers.get("x-ratelimit-reset");
      if (rateRemaining === "0" && rateReset) {
        const resetAtMs = Number(rateReset) * 1000;
        const err = new Error(
          `${message}${detail} (rate limit exceeded; resets at ${new Date(resetAtMs).toLocaleString()})`
        );
        (err as any).rateLimitResetAtMs = resetAtMs;
        throw err;
      }
      throw new Error(message + detail);
    }

    // Cache ETag for future conditional requests
    if (args.method === "GET") {
      const etag = response.headers.get("etag");
      if (etag) {
        // Evict oldest entries if cache is full
        if (etagCache.size >= ETAG_CACHE_MAX_SIZE) {
          const firstKey = etagCache.keys().next().value;
          if (firstKey) etagCache.delete(firstKey);
        }
        etagCache.set(urlKey, { etag, data });
      }
    }

    return { data: data as T, response };
  };

  let cachedStatus: GitHubStatus | null = null;
  let cachedAt = 0;

  const getStatus = async (): Promise<GitHubStatus> => {
    const token = readStoredToken();
    const repo = await detectRepo().catch(() => null);
    if (!token) {
      cachedStatus = {
        tokenStored: false,
        tokenDecryptionFailed,
        storageScope: "app",
        repo,
        userLogin: null,
        scopes: [],
        checkedAt: null
      };
      cachedAt = Date.now();
      return cachedStatus;
    }

    const now = Date.now();
    if (cachedStatus && now - cachedAt < 30_000 && cachedStatus.tokenStored) {
      // Still re-detect repo, it is cheap and reflects changed remotes.
      return { ...cachedStatus, repo };
    }

    try {
      const validated = await validateToken(token);
      cachedStatus = {
        tokenStored: true,
        tokenDecryptionFailed: false,
        storageScope: "app",
        repo,
        userLogin: validated.userLogin,
        scopes: validated.scopes,
        checkedAt: nowIso()
      };
      cachedAt = now;
      return cachedStatus;
    } catch (error) {
      logger.warn("github.token_validation_failed", { error: error instanceof Error ? error.message : String(error) });
      cachedStatus = {
        tokenStored: true,
        tokenDecryptionFailed: false,
        storageScope: "app",
        repo,
        userLogin: null,
        scopes: [],
        checkedAt: nowIso()
      };
      cachedAt = now;
      return cachedStatus;
    }
  };

  return {
    getStatus,

    setToken(token: string): void {
      persistToken(token);
      tokenDecryptionFailed = false;
      cachedStatus = null;
      cachedAt = 0;
    },

    clearToken(): void {
      persistToken(null);
      tokenDecryptionFailed = false;
      cachedStatus = null;
      cachedAt = 0;
    },

    async getRepoOrThrow(): Promise<GitHubRepoRef> {
      const repo = await detectRepo();
      if (!repo) throw new Error("Unable to detect GitHub repo from git remote 'origin'.");
      return repo;
    },

    getTokenOrThrow(): string {
      const token = readStoredToken();
      if (!token) throw new Error("GitHub token missing. Set it in Settings.");
      return token;
    },

    apiRequest
  };
}
