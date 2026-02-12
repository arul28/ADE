import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import type { GitHubRepoRef, GitHubStatus } from "../../../shared/types";

const AUTH_STORE_FILE_NAME = "github-token.v1.bin";

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
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

export function createGithubService({
  logger,
  adeDir,
  projectRoot
}: {
  logger: Logger;
  adeDir: string;
  projectRoot: string;
}) {
  const githubStateDir = path.join(adeDir, "github");
  const tokenPath = path.join(githubStateDir, AUTH_STORE_FILE_NAME);

  const readStoredToken = (): string | null => {
    if (!fs.existsSync(tokenPath)) return null;
    try {
      const bytes = fs.readFileSync(tokenPath);
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn("github.token_store_unavailable", {
          message: "OS secure storage is unavailable; GitHub token cannot be decrypted."
        });
        return null;
      }
      const decrypted = safeStorage.decryptString(bytes);
      const parsed = JSON.parse(decrypted) as { token?: unknown };
      const token = asString(parsed?.token);
      return token.trim().length ? token.trim() : null;
    } catch (error) {
      logger.warn("github.token_store_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  const persistToken = (token: string | null): void => {
    const clean = (token ?? "").trim();
    if (!clean) {
      try {
        if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
      } catch {
        // ignore
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. Cannot persist GitHub token.");
    }

    fs.mkdirSync(githubStateDir, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({ token: clean }));
    fs.writeFileSync(tokenPath, encrypted);
    try {
      fs.chmodSync(tokenPath, 0o600);
    } catch {
      // ignore best-effort chmod
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

    const scopes = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

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

  const apiRequest = async <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    token?: string;
  }): Promise<{ data: T; response: Response }> => {
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

    const response = await fetch(url.toString(), {
      method: args.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": args.body != null ? "application/json" : "text/plain",
        "user-agent": "ade-desktop"
      },
      body: args.body != null ? JSON.stringify(args.body) : undefined
    });

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
      const rateRemaining = response.headers.get("x-ratelimit-remaining");
      const rateReset = response.headers.get("x-ratelimit-reset");
      throw new Error(
        rateRemaining === "0" && rateReset
          ? `${message} (rate limit exceeded; resets at ${new Date(Number(rateReset) * 1000).toLocaleString()})`
          : message
      );
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
      cachedStatus = null;
      cachedAt = 0;
    },

    clearToken(): void {
      persistToken(null);
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

