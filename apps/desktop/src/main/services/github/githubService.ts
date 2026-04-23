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

function detectGitHubTokenType(token: string): GitHubStatus["tokenType"] {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "unknown";
}

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

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1] ?? null;
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
    if (token) return token;
    tokenDecryptionFailed = false;
    const envToken = (process.env.GITHUB_TOKEN ?? process.env.ADE_GITHUB_TOKEN ?? "").trim();
    return envToken.length > 0 ? envToken : null;
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

  const validateToken = async (token: string): Promise<{ userLogin: string | null; scopes: string[]; tokenType: GitHubStatus["tokenType"] }> => {
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
      scopes,
      tokenType: detectGitHubTokenType(token),
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
      const body = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
      const message = (body ? asString(body.message) : "") || `GitHub API request failed (HTTP ${response.status})`;
      let detail = "";
      if (body && Array.isArray(body.errors)) {
        const errorMessages = (body.errors as any[])
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

  const apiRequestAllPages = async <T>(args: {
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    token?: string;
  }): Promise<T[]> => {
    const first = await apiRequest<T[]>({ method: "GET", ...args });
    const out = Array.isArray(first.data) ? [...first.data] : [];
    let nextUrl = parseNextLink(first.response?.headers.get("link") ?? null);
    while (nextUrl) {
      const url = new URL(nextUrl);
      const next = await apiRequest<T[]>({
        method: "GET",
        path: `${url.pathname}${url.search}`,
        token: args.token,
      });
      if (Array.isArray(next.data)) out.push(...next.data);
      nextUrl = parseNextLink(next.response?.headers.get("link") ?? null);
    }
    return out;
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
        tokenType: "unknown",
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
        tokenType: validated.tokenType,
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
        tokenType: detectGitHubTokenType(token),
        repo,
        userLogin: null,
        scopes: [],
        checkedAt: nowIso()
      };
      cachedAt = now;
      return cachedStatus;
    }
  };

  const listRepoLabels = async (owner: string, name: string): Promise<GitHubLabel[]> => {
    const { data } = await apiRequest<GitHubLabel[]>({
      method: "GET",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`,
      query: { per_page: 100 },
    });
    return Array.isArray(data) ? data : [];
  };

  const listRepoCollaborators = async (owner: string, name: string): Promise<GitHubUser[]> => {
    const { data } = await apiRequest<GitHubUser[]>({
      method: "GET",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators`,
      query: { per_page: 100 },
    });
    return Array.isArray(data) ? data : [];
  };

  const listRepoIssues = async (
    owner: string,
    name: string,
    opts: { since?: string; state?: "open" | "closed" | "all"; sort?: "created" | "updated"; perPage?: number } = {}
  ): Promise<GitHubIssue[]> => {
    const data = await apiRequestAllPages<GitHubIssue>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
      query: {
        state: opts.state ?? "all",
        sort: opts.sort ?? "updated",
        per_page: opts.perPage ?? 50,
        ...(opts.since ? { since: opts.since } : {}),
      },
    });
    return Array.isArray(data) ? data : [];
  };

  const getIssue = async (owner: string, name: string, number: number): Promise<GitHubIssue | null> => {
    try {
      const { data } = await apiRequest<GitHubIssue>({
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
      });
      return data ?? null;
    } catch (error) {
      logger.warn("github.get_issue_failed", {
        owner, name, number,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const listIssueComments = async (
    owner: string,
    name: string,
    number: number,
    opts: { since?: string } = {}
  ): Promise<GitHubIssueComment[]> => {
    const data = await apiRequestAllPages<GitHubIssueComment>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
      query: {
        per_page: 100,
        ...(opts.since ? { since: opts.since } : {}),
      },
    });
    return Array.isArray(data) ? data : [];
  };

  const listRepoPulls = async (
    owner: string,
    name: string,
    opts: { state?: "open" | "closed" | "all"; sort?: "created" | "updated"; perPage?: number } = {}
  ): Promise<GitHubPullRequest[]> => {
    const data = await apiRequestAllPages<GitHubPullRequest>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
      query: {
        state: opts.state ?? "all",
        sort: opts.sort ?? "updated",
        direction: "desc",
        per_page: opts.perPage ?? 50,
      },
    });
    return Array.isArray(data) ? data : [];
  };

  const listPullRequestReviews = async (
    owner: string,
    name: string,
    number: number,
  ): Promise<GitHubPullRequestReview[]> => {
    const data = await apiRequestAllPages<GitHubPullRequestReview>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/reviews`,
      query: { per_page: 100 },
    });
    return Array.isArray(data) ? data : [];
  };

  // Issue-domain action helpers (used by the automations `issue` domain).
  const addIssueComment = async (owner: string, name: string, number: number, body: string): Promise<GitHubIssueComment | null> => {
    const { data } = await apiRequest<GitHubIssueComment>({
      method: "POST",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
      body: { body },
    });
    return data ?? null;
  };

  const setIssueLabels = async (owner: string, name: string, number: number, labels: string[]): Promise<GitHubLabel[]> => {
    const { data } = await apiRequest<GitHubLabel[]>({
      method: "PUT",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/labels`,
      body: { labels },
    });
    return Array.isArray(data) ? data : [];
  };

  const closeIssue = async (owner: string, name: string, number: number, reason?: "completed" | "not_planned"): Promise<GitHubIssue | null> => {
    const { data } = await apiRequest<GitHubIssue>({
      method: "PATCH",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
      body: { state: "closed", ...(reason ? { state_reason: reason } : {}) },
    });
    return data ?? null;
  };

  const reopenIssue = async (owner: string, name: string, number: number): Promise<GitHubIssue | null> => {
    const { data } = await apiRequest<GitHubIssue>({
      method: "PATCH",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
      body: { state: "open" },
    });
    return data ?? null;
  };

  const assignIssue = async (owner: string, name: string, number: number, assignees: string[]): Promise<GitHubIssue | null> => {
    const { data } = await apiRequest<GitHubIssue>({
      method: "POST",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/assignees`,
      body: { assignees },
    });
    return data ?? null;
  };

  const setIssueTitle = async (owner: string, name: string, number: number, title: string): Promise<GitHubIssue | null> => {
    const { data } = await apiRequest<GitHubIssue>({
      method: "PATCH",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
      body: { title },
    });
    return data ?? null;
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

    detectRepo,
    apiRequest,

    // Polling/picker read helpers
    listRepoLabels,
    listRepoCollaborators,
    listRepoIssues,
    getIssue,
    listIssueComments,
    listRepoPulls,
    listPullRequestReviews,

    // Issue-domain action helpers (exposed via `issue` domain in the
    // automations action registry).
    addIssueComment,
    setIssueLabels,
    closeIssue,
    reopenIssue,
    assignIssue,
    setIssueTitle,
  };
}

export type GitHubLabel = {
  id?: number;
  node_id?: string;
  url?: string;
  name: string;
  color?: string;
  default?: boolean;
  description?: string | null;
};

export type GitHubUser = {
  id?: number;
  login: string;
  avatar_url?: string;
  html_url?: string;
  type?: string;
};

export type GitHubIssueComment = {
  id: number;
  body: string;
  user?: GitHubUser | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
};

export type GitHubIssue = {
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  user?: GitHubUser | null;
  labels?: Array<string | { name: string }>;
  assignees?: GitHubUser[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  html_url?: string;
  comments?: number;
  /**
   * GitHub returns a `pull_request` sub-object on issue rows when the row is
   * actually a PR. Callers should filter those out when fetching issues.
   */
  pull_request?: unknown;
};

export type GitHubPullRequest = {
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
  user?: GitHubUser | null;
  labels?: Array<string | { name: string }>;
  assignees?: GitHubUser[];
  base?: { ref?: string; sha?: string };
  head?: { ref?: string; sha?: string };
  html_url?: string;
  comments?: number;
};

export type GitHubPullRequestReview = {
  id: number;
  body?: string | null;
  state?: string;
  user?: GitHubUser | null;
  submitted_at?: string | null;
  html_url?: string;
};

export type GithubService = ReturnType<typeof createGithubService>;
