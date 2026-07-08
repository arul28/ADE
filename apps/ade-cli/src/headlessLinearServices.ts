import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../desktop/src/main/services/logging/logger";
import type { AdeDb } from "../../desktop/src/main/services/state/kvDb";
import type { createLaneService } from "../../desktop/src/main/services/lanes/laneService";
import type { createOperationService } from "../../desktop/src/main/services/history/operationService";
import type { createProjectConfigService } from "../../desktop/src/main/services/config/projectConfigService";
import type { createConflictService } from "../../desktop/src/main/services/conflicts/conflictService";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import type { createProcessService } from "../../desktop/src/main/services/processes/processService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import type { createLinearClient } from "../../desktop/src/main/services/cto/linearClient";
import type { createLinearCredentialService } from "../../desktop/src/main/services/cto/linearCredentialService";
import type { createLinearIssueTracker } from "../../desktop/src/main/services/cto/linearIssueTracker";
import type { createAutomationSecretService } from "../../desktop/src/main/services/automations/automationSecretService";
import type { ComputerUseArtifactBrokerService } from "../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import {
  getModelById,
  getRuntimeModelRefForDescriptor,
  resolveModelAlias,
} from "../../desktop/src/shared/modelRegistry";
import {
  getGitHubTokenAccessState,
  parseGitHubScopeHeaders,
} from "../../desktop/src/shared/githubScopes";
import type {
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppUserAuthStatus,
  GitHubStatus,
} from "../../desktop/src/shared/types";
import type {
  GithubService,
  GitHubIssue,
  GitHubIssueComment,
  GitHubLabel,
  GitHubPullRequest,
  GitHubPullRequestReview,
} from "../../desktop/src/main/services/github/githubService";
import {
  fetchGitHubAppInstallationStatus,
  type GitHubRelaySecretReader,
} from "../../desktop/src/main/services/github/githubRelayConfig";
import { createGitHubAppUserAuthService } from "../../desktop/src/main/services/github/githubAppUserAuthService";
import type { AdeRuntimePaths } from "./bootstrap";
import { createLinearClient as createLinearClientImpl } from "../../desktop/src/main/services/cto/linearClient";
import { createLinearIssueTracker as createLinearIssueTrackerImpl } from "../../desktop/src/main/services/cto/linearIssueTracker";
import { createFileService as createFileServiceImpl } from "../../desktop/src/main/services/files/fileService";
import { createProcessService as createProcessServiceImpl } from "../../desktop/src/main/services/processes/processService";
import { createPrService as createPrServiceImpl } from "../../desktop/src/main/services/prs/prService";
import { createAutomationSecretService as createAutomationSecretServiceImpl } from "../../desktop/src/main/services/automations/automationSecretService";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import {
  linearInvalidGrantLikelyStaleRotation,
  linearTokenNeedsRefresh,
  refreshLinearOAuthAccessToken,
} from "../../desktop/src/main/services/cto/linearTokenRefresh";
import {
  LinearOAuthRefreshLockTimeoutError,
  withLinearOAuthRefreshLock,
} from "../../desktop/src/main/services/cto/linearOAuthRefreshLock";

// Keep headless runtimes aligned with the desktop credential service so packaged
// alpha builds can offer the same PKCE-based Linear sign-in flow.
const BUNDLED_LINEAR_OAUTH_CLIENT_ID =
  process.env.ADE_LINEAR_CLIENT_ID?.trim() || "432fb2ddb16f939ae5d5270e2c86571f";

type HeadlessLinearCredentialService = ReturnType<typeof createLinearCredentialService>;
type HeadlessGitHubStatus = GitHubStatus;
export type HeadlessGitHubService = GithubService;

type HeadlessAgentChatSession = {
  id: string;
  sessionId: string;
  laneId: string;
  provider: "codex";
  model: string;
  modelId: string;
  title: string | null;
  status: "idle" | "ended";
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  identityKey?: string;
  reasoningEffort?: string | null;
  permissionMode?: string;
};

type HeadlessTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

type HeadlessAgentChatMessageKind =
  | "auto"
  | "queue"
  | "wake"
  | "interrupt-replace";

type HeadlessAgentChatMessageArgs = {
  sessionId: string;
  text: string;
  kind?: HeadlessAgentChatMessageKind;
};

type HeadlessLinearDeps = {
  projectRoot: string;
  adeDir: string;
  paths: AdeRuntimePaths;
  projectId: string;
  db: AdeDb;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  laneService: ReturnType<typeof createLaneService>;
  operationService: ReturnType<typeof createOperationService>;
  conflictService: ReturnType<typeof createConflictService>;
  openExternal?: (url: string) => Promise<void>;
  onGitHubStatusChanged?: (status: HeadlessGitHubStatus) => void;
};

type HeadlessLinearServices = {
  githubService: HeadlessGitHubService;
  linearCredentialService: HeadlessLinearCredentialService;
  linearClient: ReturnType<typeof createLinearClient>;
  linearIssueTracker: ReturnType<typeof createLinearIssueTracker>;
  fileService: ReturnType<typeof createFileService>;
  processService: ReturnType<typeof createProcessService>;
  prService: ReturnType<typeof createPrService>;
  agentChatService: {
    listSessions: () => Promise<HeadlessAgentChatSession[]>;
    getSessionSummary: (
      sessionId: string,
    ) => Promise<Record<string, unknown> | null>;
    getChatTranscript: (args: {
      sessionId: string;
      limit?: number;
      maxChars?: number;
    }) => Promise<{
      sessionId: string;
      entries: Array<{
        role: "user" | "assistant";
        text: string;
        timestamp: string;
      }>;
      truncated: boolean;
      totalEntries: number;
    }>;
    previewSessionToolNames: (args?: {
      sessionId?: string | null;
    }) => Promise<string[]>;
    createSession: (args: {
      laneId: string;
      title?: string;
    }) => Promise<HeadlessAgentChatSession>;
    updateSession: (args: {
      sessionId: string;
      title?: string | null;
    }) => Promise<HeadlessAgentChatSession>;
    sendMessage: (args: { sessionId: string; text: string }) => Promise<void>;
    messageSession: (args: HeadlessAgentChatMessageArgs) => Promise<{
      sessionId: string;
      kind: HeadlessAgentChatMessageKind;
      routedAction: "sendMessage" | "steer" | "interrupt-replace";
      statusBefore: HeadlessAgentChatSession["status"];
      awaitingInputBefore: false;
      delivery: "sent" | "delivered" | "queued";
      steerId?: string;
      queued?: boolean;
    }>;
    steer: (args: { sessionId: string; text: string }) => Promise<{
      steerId: string;
      queued: boolean;
    }>;
    interrupt: (args: { sessionId: string }) => Promise<void>;
    resumeSession: (args: {
      sessionId: string;
    }) => Promise<HeadlessAgentChatSession>;
    dispose: (args: { sessionId: string }) => Promise<void>;
    ensureIdentitySession: (args: {
      identityKey: string;
      laneId: string;
      modelId?: string | null;
      reasoningEffort?: string | null;
      reuseExisting?: boolean;
      permissionMode?: string;
    }) => Promise<HeadlessAgentChatSession>;
    setComputerUseArtifactBrokerService: (
      svc: ComputerUseArtifactBrokerService,
    ) => void;
  };
  dispose: () => void;
};

function envToken(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim() ?? "";
    if (value.length) return value;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type HeadlessGitHubTokenLookup = {
  token: string | null;
  source: HeadlessGitHubStatus["authSource"];
  patTokenStored: boolean;
  ghCliPath: string | null;
  ghAuthError: string | null;
};

/**
 * gh's file-based credential store. The launchd brain has a minimal PATH (no
 * Homebrew) and spawning bare "gh" fails silently, which left every headless
 * GitHub call reporting "auth missing" while the desktop worked — reading
 * hosts.yml directly is the only auth path that is reliable headless.
 * Handles both layouts: host-level `oauth_token:` and the newer nested
 * `users:<login>:oauth_token:`.
 */
function readGhHostsFileToken(): string | null {
  const configDir = process.env.GH_CONFIG_DIR?.trim()
    || path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "gh");
  try {
    const raw = fs.readFileSync(path.join(configDir, "hosts.yml"), "utf8");
    let inGithubHost = false;
    for (const line of raw.split(/\r?\n/)) {
      if (/^\S/.test(line)) {
        inGithubHost = /^github\.com\s*:/.test(line.trim());
        continue;
      }
      if (!inGithubHost) continue;
      const match = line.match(/^\s+oauth_token\s*:\s*(\S+)\s*$/);
      if (match) {
        const token = match[1].replace(/^["']|["']$/g, "").trim();
        if (token) return token;
      }
    }
  } catch {
    // No hosts.yml (keychain-stored creds or gh absent) — fall through.
  }
  return null;
}

function resolveGhCliPath(): string {
  const candidates = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return "gh";
}

function ghAuthToken(): Pick<HeadlessGitHubTokenLookup, "token" | "ghCliPath" | "ghAuthError"> {
  if (process.env.ADE_DISABLE_GH_AUTH_FALLBACK === "1") {
    return { token: null, ghCliPath: null, ghAuthError: null };
  }
  const ghCliPath = resolveGhCliPath();
  try {
    const result = spawnSync(ghCliPath, ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const token = result.status === 0 ? (result.stdout?.trim() ?? "") : "";
    if (token.length > 0) {
      return { token, ghCliPath, ghAuthError: null };
    }
    const hostsToken = readGhHostsFileToken();
    if (hostsToken) {
      return { token: hostsToken, ghCliPath, ghAuthError: null };
    }
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    return {
      token: null,
      ghCliPath,
      ghAuthError: stderr || "GitHub CLI is installed, but `gh auth token` did not return a token.",
    };
  } catch (error) {
    const hostsToken = readGhHostsFileToken();
    if (hostsToken) {
      return { token: hostsToken, ghCliPath, ghAuthError: null };
    }
    return {
      token: null,
      ghCliPath: null,
      ghAuthError: error instanceof Error ? error.message : String(error),
    };
  }
}

function readGitOrigin(projectRoot: string): string | null {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (result.error) return null;
    const remote = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return remote.length > 0 ? remote : null;
  } catch {
    return null;
  }
}

function runGitHeadless(
  projectRoot: string,
  args: string[],
  timeoutMs: number,
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return {
      exitCode: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseGitHubRepoFromRemoteUrl(
  remoteUrlRaw: string,
): { owner: string; name: string } | null {
  const remote = remoteUrlRaw.trim();
  if (!remote) return null;
  const ssh = remote.match(/^git@github\.com:(.+)$/i);
  if (ssh) {
    const [owner, name] = ssh[1]!.replace(/\.git$/i, "").split("/");
    if (owner && name) return { owner, name };
  }
  try {
    const url = new URL(remote);
    if (!/github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "")
      .split("/");
    const owner = parts[0]?.trim() ?? "";
    const name = parts[1]?.trim() ?? "";
    return owner && name ? { owner, name } : null;
  } catch {
    return null;
  }
}

function repoIdentityFromGitHubResponse(
  data: Record<string, unknown>,
  fallbackOwner: string,
  fallbackName: string,
): { owner: string; name: string; fullName: string } {
  const fullName = asString(data.full_name).trim();
  const fullNameParts = fullName.split("/");
  const repoFromFullName =
    fullNameParts.length >= 2
      ? { owner: fullNameParts[0]!.trim(), name: fullNameParts[1]!.trim() }
      : null;
  const repoFromUrl =
    parseGitHubRepoFromRemoteUrl(asString(data.clone_url)) ??
    parseGitHubRepoFromRemoteUrl(asString(data.html_url)) ??
    null;
  const owner =
    asString((data.owner as Record<string, unknown> | undefined)?.login).trim() ||
    repoFromFullName?.owner ||
    repoFromUrl?.owner ||
    fallbackOwner;
  const name =
    asString(data.name).trim() ||
    repoFromFullName?.name ||
    repoFromUrl?.name ||
    fallbackName;
  return {
    owner,
    name,
    fullName: fullName || (owner ? `${owner}/${name}` : name),
  };
}

function detectGitHubRepo(
  projectRoot: string,
): { owner: string; name: string } | null {
  return parseGitHubRepoFromRemoteUrl(readGitOrigin(projectRoot) ?? "");
}

function parseNextGitHubLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1] ?? null;
  }
  return null;
}

const GITHUB_API_TIMEOUT_MS = 20_000;

async function fetchGitHub(input: string | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        "GitHub API request timed out. Check network access on this machine.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createHeadlessGitHubService(
  projectRoot: string,
  logger: Logger,
  options: {
    onStatusChanged?: (status: HeadlessGitHubStatus) => void;
    githubRelaySecretReader?: GitHubRelaySecretReader | null;
  } = {},
): HeadlessGitHubService {
  const credentialStore = new EncryptedFileCredentialStore();
  const appUserAuth = createGitHubAppUserAuthService({
    credentialStore,
    logger,
    fetchImpl: (input, init) => fetchGitHub(input, init ?? {}),
    userAgent: "ade-cli",
  });
  const tokenKey = "github.token.v1";
  let cachedStatus: Awaited<
    ReturnType<HeadlessGitHubService["getStatus"]>
  > | null = null;
  let cachedAt = 0;
  let tokenOverride: string | null = null;
  let tokenDecryptionFailed = false;

  const readStoredPatToken = (): string | null => {
    if (tokenOverride != null) return tokenOverride;
    try {
      const stored = credentialStore.getSync(tokenKey);
      tokenDecryptionFailed = false;
      if (stored?.trim()) return stored.trim();
    } catch {
      tokenDecryptionFailed = true;
    }
    return null;
  };

  const readToken = (): HeadlessGitHubTokenLookup => {
    const patToken = readStoredPatToken();
    if (patToken) {
      return {
        token: patToken,
        source: "pat",
        patTokenStored: true,
        ghCliPath: null,
        ghAuthError: null,
      };
    }
    const env = envToken("ADE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN");
    if (env) {
      return {
        token: env,
        source: "environment",
        patTokenStored: false,
        ghCliPath: null,
        ghAuthError: null,
      };
    }
    const gh = ghAuthToken();
    return {
      ...gh,
      source: gh.token ? "gh" : "none",
      patTokenStored: false,
    };
  };

  const getToken = (): string => readToken().token ?? "";

  const getTokenType = (token: string): HeadlessGitHubStatus["tokenType"] => {
    if (token.startsWith("github_pat_")) return "fine-grained";
    if (token.startsWith("ghp_")) return "classic";
    if (/^gh[ousr]_/.test(token)) return "oauth";
    return "unknown";
  };
  const readApiMessage = (payload: unknown, fallback: string): string => {
    if (
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof (payload as { message?: unknown }).message === "string"
    ) {
      return String((payload as { message: string }).message);
    }
    return fallback;
  };
  const computeConnected = (args: {
    tokenStored: boolean;
    userLogin: string | null;
    tokenType: HeadlessGitHubStatus["tokenType"];
    scopes: string[];
    repo: { owner: string; name: string } | null;
    repoAccessOk: boolean | null;
  }): boolean => {
    if (!args.tokenStored || !args.userLogin) return false;
    if (args.tokenType === "fine-grained") {
      return args.repo ? args.repoAccessOk === true : true;
    }
    if (args.tokenType === "classic" || args.tokenType === "oauth" || args.scopes.length > 0) {
      return getGitHubTokenAccessState(args.scopes).hasRequiredAccess;
    }
    return true;
  };
  const validateToken = async (
    token: string,
  ): Promise<{
    userLogin: string | null;
    scopes: string[];
    tokenType: HeadlessGitHubStatus["tokenType"];
  }> => {
    const response = await fetchGitHub("https://api.github.com/user", {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "ade-cli",
      },
    });
    const scopes = parseGitHubScopeHeaders(response.headers);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        readApiMessage(
          payload,
          `GitHub token validation failed (HTTP ${response.status})`,
        ),
      );
    }
    const userLogin =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { login?: unknown }).login === "string"
        ? (payload as { login: string }).login
        : null;
    return { userLogin, scopes, tokenType: getTokenType(token) };
  };
  const probeRepoAccess = async (
    token: string,
    repo: { owner: string; name: string },
  ): Promise<{ ok: boolean; error: string | null }> => {
    try {
      const response = await fetchGitHub(
        `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
        {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "ade-cli",
          },
        },
      );
      if (response.ok) return { ok: true, error: null };
      const payload = await response.json().catch(() => ({}));
      return {
        ok: false,
        error: `${response.status}: ${readApiMessage(payload, `HTTP ${response.status}`)}`,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const apiRequest = async <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    token?: string;
  }): Promise<{ data: T; response: Response | null; linkHeader?: string | null }> => {
    const token = (args.token ?? getToken()).trim();
    if (!token) {
      throw new Error(
        "GitHub auth missing. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, run `gh auth login -h github.com -s repo -s workflow`, or add a PAT in Settings.",
      );
    }
    const url = new URL(`https://api.github.com${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    const response = await fetchGitHub(url, {
      method: args.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "ade-cli",
        ...(args.body == null ? {} : { "content-type": "application/json" }),
      },
      body: args.body == null ? undefined : JSON.stringify(args.body),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text.trim().length ? JSON.parse(text) : {};
    } catch {
      // keep text payload
    }
    if (!response.ok) {
      const message =
        typeof data === "object" &&
        data &&
        "message" in data &&
        typeof (data as { message?: unknown }).message === "string"
          ? String((data as { message?: unknown }).message)
          : `GitHub API request failed (HTTP ${response.status})`;
      throw new Error(message);
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
    let nextUrl = parseNextGitHubLink(
      first.response?.headers.get("link") ?? null,
    );
    while (nextUrl) {
      const url = new URL(nextUrl);
      const next = await apiRequest<T[]>({
        method: "GET",
        path: `${url.pathname}${url.search}`,
        token: args.token,
      });
      if (Array.isArray(next.data)) out.push(...next.data);
      nextUrl = parseNextGitHubLink(next.response?.headers.get("link") ?? null);
    }
    return out;
  };

  const normalizeAutolink = (raw: unknown) => {
    const record = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return {
      id: typeof record.id === "number" && Number.isFinite(record.id) ? record.id : 0,
      keyPrefix: asString(record.key_prefix) || asString(record.keyPrefix),
      urlTemplate: asString(record.url_template) || asString(record.urlTemplate),
      isAlphanumeric: Boolean(record.is_alphanumeric ?? record.isAlphanumeric),
    };
  };

  const listRepoIssues: HeadlessGitHubService["listRepoIssues"] = async (
    owner,
    name,
    opts = {},
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

  const getIssue: HeadlessGitHubService["getIssue"] = async (
    owner,
    name,
    number,
  ): Promise<GitHubIssue | null> => {
    try {
      const { data } = await apiRequest<GitHubIssue>({
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
      });
      return data ?? null;
    } catch (error) {
      logger.warn("github.get_issue_failed", {
        owner,
        name,
        number,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const listIssueComments: HeadlessGitHubService["listIssueComments"] = async (
    owner,
    name,
    number,
    opts = {},
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

  const listRepoPulls: HeadlessGitHubService["listRepoPulls"] = async (
    owner,
    name,
    opts = {},
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

  const listPullRequestReviews: HeadlessGitHubService["listPullRequestReviews"] = async (
    owner,
    name,
    number,
  ): Promise<GitHubPullRequestReview[]> => {
    const data = await apiRequestAllPages<GitHubPullRequestReview>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/reviews`,
      query: { per_page: 100 },
    });
    return Array.isArray(data) ? data : [];
  };

  const createRepository = async (args: {
    owner?: string | null;
    name: string;
    description?: string;
    isPrivate: boolean;
  }): Promise<{
    owner: string;
    name: string;
    fullName: string;
    cloneUrl: string;
    sshUrl: string;
    htmlUrl: string;
    defaultBranch: string;
  }> => {
    const body: Record<string, unknown> = {
      name: args.name,
      private: args.isPrivate,
      auto_init: false,
    };
    if (args.description != null && args.description.trim().length > 0) {
      body.description = args.description.trim();
    }
    const owner = asString(args.owner).trim();
    const { data } = await apiRequest<Record<string, unknown>>({
      method: "POST",
      path: owner ? `/orgs/${encodeURIComponent(owner)}/repos` : "/user/repos",
      body,
    });
    const identity = repoIdentityFromGitHubResponse(data, owner, args.name);
    return {
      owner: identity.owner,
      name: identity.name,
      fullName: identity.fullName,
      cloneUrl: asString(data.clone_url),
      sshUrl: asString(data.ssh_url),
      htmlUrl: asString(data.html_url),
      defaultBranch: asString(data.default_branch) || "main",
    };
  };

  const getRepository = async (
    owner: string,
    name: string,
  ): Promise<{
    owner: string;
    name: string;
    fullName: string;
    cloneUrl: string;
    sshUrl: string;
    htmlUrl: string;
    defaultBranch: string;
    size: number;
  }> => {
    const { data } = await apiRequest<Record<string, unknown>>({
      method: "GET",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    });
    const identity = repoIdentityFromGitHubResponse(data, owner, name);
    return {
      owner: identity.owner,
      name: identity.name,
      fullName: identity.fullName,
      cloneUrl: asString(data.clone_url),
      sshUrl: asString(data.ssh_url),
      htmlUrl: asString(data.html_url),
      defaultBranch: asString(data.default_branch) || "main",
      size: typeof data.size === "number" ? data.size : 0,
    };
  };

  let service: HeadlessGitHubService;
  const emitStatusChanged = (): void => {
    const onStatusChanged = options.onStatusChanged;
    if (!onStatusChanged) return;
    void service
      .getStatus({ forceRefresh: true })
      .then(onStatusChanged)
      .catch((error) => {
        logger.warn("github.status_change_emit_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  service = {
    async getStatus(opts: { forceRefresh?: boolean } = {}) {
      if (opts.forceRefresh) {
        cachedStatus = null;
        cachedAt = 0;
      }
      const now = Date.now();
      const repo = detectGitHubRepo(projectRoot);
      const hasOrigin = Boolean(readGitOrigin(projectRoot));
      const tokenLookup = readToken();
      if (cachedStatus && now - cachedAt < 30_000) {
        const repoChanged =
          (cachedStatus.repo?.owner ?? null) !== (repo?.owner ?? null) ||
          (cachedStatus.repo?.name ?? null) !== (repo?.name ?? null);
        const authSourceChanged =
          cachedStatus.authSource !== tokenLookup.source ||
          cachedStatus.patTokenStored !== tokenLookup.patTokenStored;
        if (!authSourceChanged) {
          const repoAccessOk = repoChanged ? null : cachedStatus.repoAccessOk;
          const repoAccessError = repoChanged
            ? null
            : cachedStatus.repoAccessError;
          return {
            ...cachedStatus,
            repo,
            hasOrigin,
            ghCliPath: tokenLookup.ghCliPath ?? cachedStatus.ghCliPath,
            ghAuthError: tokenLookup.ghAuthError,
            repoAccessOk,
            repoAccessError,
            connected: computeConnected({
              tokenStored: cachedStatus.tokenStored,
              userLogin: cachedStatus.userLogin,
              tokenType: cachedStatus.tokenType,
              scopes: cachedStatus.scopes,
              repo,
              repoAccessOk,
            }),
          };
        }
      }
      const token = tokenLookup.token;
      if (!token) {
        const status: HeadlessGitHubStatus = {
          tokenStored: false,
          patTokenStored: tokenLookup.patTokenStored,
          tokenDecryptionFailed,
          storageScope: "app",
          authSource: "none",
          tokenType: "unknown",
          repo,
          hasOrigin,
          userLogin: null,
          scopes: [],
          ghCliPath: tokenLookup.ghCliPath,
          ghAuthError: tokenLookup.ghAuthError,
          checkedAt: null,
          repoAccessOk: null,
          repoAccessError: null,
          connected: false,
        };
        cachedStatus = status;
        cachedAt = now;
        return status;
      }

      try {
        const validated = await validateToken(token);
        let repoAccessOk: boolean | null = null;
        let repoAccessError: string | null = null;
        if (repo) {
          const probe = await probeRepoAccess(token, repo);
          repoAccessOk = probe.ok;
          repoAccessError = probe.error;
          if (!probe.ok) {
            logger.warn("github.repo_probe_failed", {
              repo: `${repo.owner}/${repo.name}`,
              tokenType: validated.tokenType,
              error: probe.error,
            });
          }
        }
        const status: HeadlessGitHubStatus = {
          tokenStored: true,
          patTokenStored: tokenLookup.patTokenStored,
          tokenDecryptionFailed: false,
          storageScope: "app",
          authSource: tokenLookup.source,
          tokenType: validated.tokenType,
          repo,
          hasOrigin,
          userLogin: validated.userLogin,
          scopes: validated.scopes,
          ghCliPath: tokenLookup.ghCliPath,
          ghAuthError: tokenLookup.ghAuthError,
          checkedAt: new Date(now).toISOString(),
          repoAccessOk,
          repoAccessError,
          connected: computeConnected({
            tokenStored: true,
            userLogin: validated.userLogin,
            tokenType: validated.tokenType,
            scopes: validated.scopes,
            repo,
            repoAccessOk,
          }),
        };
        cachedStatus = status;
        cachedAt = now;
        return status;
      } catch (error) {
        logger.warn("github.token_validation_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        const status: HeadlessGitHubStatus = {
          tokenStored: true,
          patTokenStored: tokenLookup.patTokenStored,
          tokenDecryptionFailed: false,
          storageScope: "app",
          authSource: tokenLookup.source,
          tokenType: getTokenType(token),
          repo,
          hasOrigin,
          userLogin: null,
          scopes: [],
          ghCliPath: tokenLookup.ghCliPath,
          ghAuthError: tokenLookup.ghAuthError,
          checkedAt: new Date(now).toISOString(),
          repoAccessOk: null,
          repoAccessError: null,
          connected: false,
        };
        cachedStatus = status;
        cachedAt = now;
        return status;
      }
    },
    async getRemoteStatus() {
      return {
        repo: detectGitHubRepo(projectRoot),
        hasOrigin: Boolean(readGitOrigin(projectRoot)),
      };
    },
    async detectRepo() {
      return detectGitHubRepo(projectRoot);
    },
    async getAppInstallationStatus(args = {}) {
      const owner = args.owner?.trim();
      const name = args.name?.trim();
      const repo = owner && name ? { owner, name } : detectGitHubRepo(projectRoot);
      const githubAppUserToken = await appUserAuth.getValidTokenForRelay().catch(() => null);
      return fetchGitHubAppInstallationStatus({
        repo,
        secretReader: options.githubRelaySecretReader,
        forceRefresh: args.forceRefresh === true,
        githubAppUserToken,
        auditLog: appUserAuth.auditLog,
      });
    },
    getAppUserAuthStatus(): GitHubAppUserAuthStatus {
      return appUserAuth.getAuthStatus();
    },
    async startAppUserDeviceAuth(): Promise<GitHubAppDeviceAuthStartResult> {
      return await appUserAuth.startDeviceAuth();
    },
    async pollAppUserDeviceAuth(args: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult> {
      return await appUserAuth.pollDeviceAuth(args);
    },
    clearAppUserAuth(): GitHubAppUserAuthStatus {
      return appUserAuth.clearAuth();
    },
    async getRepoOrThrow() {
      const repo = detectGitHubRepo(projectRoot);
      if (!repo)
        throw new Error(
          "Unable to detect GitHub repo from git remote 'origin'.",
        );
      return repo;
    },
    getTokenOrThrow() {
      const token = getToken();
      if (!token)
        throw new Error(
          "GitHub auth missing. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, run `gh auth login -h github.com -s repo -s workflow`, or add a PAT in Settings.",
        );
      return token;
    },
    async getAppUserTokenForRelay() {
      return await appUserAuth.getValidTokenForRelay();
    },
    parseGitHubRepoFromRemoteUrl,
    parseNextLink: parseNextGitHubLink,
    setToken(nextToken: string) {
      const clean = nextToken.trim();
      tokenOverride = clean || null;
      if (clean) {
        credentialStore.setSync(tokenKey, clean);
      } else {
        credentialStore.deleteSync(tokenKey);
      }
      tokenDecryptionFailed = false;
      cachedStatus = null;
      cachedAt = 0;
      emitStatusChanged();
    },
    clearToken() {
      tokenOverride = null;
      credentialStore.deleteSync(tokenKey);
      tokenDecryptionFailed = false;
      cachedStatus = null;
      cachedAt = 0;
      emitStatusChanged();
    },
    apiRequest,
    createRepository,
    getRepository,
    async createSecretGist(args) {
      const files: Record<string, { content: string }> = {};
      for (const [filename, file] of Object.entries(args.files ?? {})) {
        const normalizedFilename = filename.trim();
        if (!normalizedFilename || typeof file?.content !== "string") continue;
        files[normalizedFilename] = { content: file.content };
      }
      if (!Object.keys(files).length) {
        throw new Error("At least one gist file is required.");
      }
      const { data } = await apiRequest<Record<string, unknown>>({
        method: "POST",
        path: "/gists",
        body: {
          description: args.description?.trim() || "ADE PR chat transcript",
          public: false,
          files,
        },
      });
      return {
        id: asString(data.id),
        htmlUrl: asString(data.html_url),
      };
    },
    async listRepoLabels(owner, name) {
      return apiRequestAllPages({
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`,
        query: { per_page: 100 },
      });
    },
    async listRepoAutolinks(owner, name) {
      const rows = await apiRequestAllPages({
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/autolinks`,
        query: { per_page: 100 },
      });
      return rows.map(normalizeAutolink).filter((entry) => entry.keyPrefix && entry.urlTemplate);
    },
    async createRepoAutolink(owner, name, args) {
      const { data } = await apiRequest({
        method: "POST",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/autolinks`,
        body: {
          key_prefix: args.keyPrefix,
          url_template: args.urlTemplate,
          is_alphanumeric: args.isAlphanumeric === true,
        },
      });
      return normalizeAutolink(data);
    },
    async listRepoCollaborators(owner, name) {
      return apiRequestAllPages({
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators`,
        query: { per_page: 100 },
      });
    },
    listRepoIssues,
    getIssue,
    listIssueComments,
    listRepoPulls,
    listPullRequestReviews,
    async publishCurrentProject(args) {
      const token = getToken();
      if (!token) {
        const err = new Error(
          "GitHub is not connected. Run `gh auth login -h github.com -s repo -s workflow` or add a PAT in Settings.",
        ) as Error & { code?: string };
        err.code = "github_not_connected";
        throw err;
      }

      const existingRemote = runGitHeadless(
        projectRoot,
        ["remote", "get-url", "origin"],
        8_000,
      );
      if (
        existingRemote.exitCode === 0 &&
        existingRemote.stdout.trim().length > 0
      ) {
        const err = new Error(
          "This project already has a GitHub remote named 'origin'.",
        ) as Error & { code?: string };
        err.code = "remote_already_exists";
        throw err;
      }

      let created: {
        owner: string;
        name: string;
        fullName: string;
        cloneUrl: string;
        sshUrl: string;
        htmlUrl: string;
        defaultBranch: string;
      };
      const requestedOwner = asString(args.owner).trim() || null;
      try {
        created = await createRepository({
          ...args,
          owner: requestedOwner,
        });
      } catch (createErr) {
        const message =
          createErr instanceof Error ? createErr.message : String(createErr);
        const isNameTaken = /already exists/i.test(message);
        if (!isNameTaken) throw createErr;

        const validated = requestedOwner
          ? null
          : await validateToken(token).catch(() => ({
              userLogin: null as string | null,
            }));
        const owner = requestedOwner || validated?.userLogin;
        if (!owner) throw createErr;

        const existing = await getRepository(owner, args.name);
        if (existing.size > 0) {
          const taken = new Error(
            `A GitHub repo named '${owner}/${args.name}' already exists and contains commits. Pick a different name.`,
          ) as Error & { code?: string };
          taken.code = "repo_name_taken";
          throw taken;
        }
        created = {
          owner: existing.owner,
          name: existing.name,
          fullName: existing.fullName,
          cloneUrl: existing.cloneUrl,
          sshUrl: existing.sshUrl,
          htmlUrl: existing.htmlUrl,
          defaultBranch: existing.defaultBranch,
        };
      }

      const cleanupLocalOrigin = (): void => {
        runGitHeadless(projectRoot, ["remote", "remove", "origin"], 8_000);
      };

      const remoteAddRes = runGitHeadless(
        projectRoot,
        ["remote", "add", "origin", created.cloneUrl],
        8_000,
      );
      if (remoteAddRes.exitCode !== 0) {
        cleanupLocalOrigin();
        throw new Error(
          `Failed to add origin remote: ${remoteAddRes.stderr.trim() || `exit ${remoteAddRes.exitCode}`}`,
        );
      }

      const headRes = runGitHeadless(
        projectRoot,
        ["rev-parse", "--verify", "HEAD"],
        5_000,
      );
      let resultState: "pushed" | "remote_added";
      if (headRes.exitCode === 0) {
        const pushRes = runGitHeadless(
          projectRoot,
          ["push", "-u", "origin", "HEAD"],
          5 * 60_000,
        );
        if (pushRes.exitCode !== 0) {
          cleanupLocalOrigin();
          throw new Error(
            `Failed to push to origin: ${pushRes.stderr.trim() || `exit ${pushRes.exitCode}`}`,
          );
        }
        resultState = "pushed";
      } else {
        resultState = "remote_added";
      }

      cachedStatus = null;
      cachedAt = 0;

      return {
        state: resultState,
        owner: created.owner,
        name: created.name,
        fullName: created.fullName,
        htmlUrl: created.htmlUrl,
      };
    },
    async addIssueComment(owner, name, number, body) {
      return (
        await apiRequest<GitHubIssueComment>({
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
          body: { body },
        })
      ).data ?? null;
    },
    async updateIssueComment(owner, name, commentId, body) {
      return (
        await apiRequest<GitHubIssueComment>({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${commentId}`,
          body: { body },
        })
      ).data ?? null;
    },
    async setIssueLabels(owner, name, number, labels) {
      const { data } = await apiRequest<GitHubLabel[]>({
          method: "PUT",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/labels`,
          body: { labels },
      });
      return Array.isArray(data) ? data : [];
    },
    async closeIssue(owner, name, number, reason) {
      return (
        await apiRequest<GitHubIssue>({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: {
            state: "closed",
            ...(reason ? { state_reason: reason } : {}),
          },
        })
      ).data ?? null;
    },
    async reopenIssue(owner, name, number) {
      return (
        await apiRequest<GitHubIssue>({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: { state: "open" },
        })
      ).data ?? null;
    },
    async assignIssue(owner, name, number, assignees) {
      return (
        await apiRequest<GitHubIssue>({
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/assignees`,
          body: { assignees },
        })
      ).data ?? null;
    },
    async setIssueTitle(owner, name, number, title) {
      return (
        await apiRequest<GitHubIssue>({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: { title },
        })
      ).data ?? null;
    },
  };
  return service;
}

function createHeadlessLinearCredentialService(args: {
  adeDir: string;
  logger?: Logger;
}): HeadlessLinearCredentialService {
  const secretsDir = path.join(args.adeDir, "secrets");
  const credentialStore = new EncryptedFileCredentialStore({
    secretsDir,
  });
  const tokenKey = "linear.token.v1";
  const authModeKey = "linear.authMode.v1";
  const tokenExpiresAtKey = "linear.tokenExpiresAt.v1";
  const refreshTokenKey = "linear.refreshToken.v1";
  const oauthClientKey = "linear.oauthClient.v1";
  let tokenOverride: string | null = null;
  let tokenDecryptionFailed = false;

  const readCredential = (key: string): string | null => {
    try {
      const stored = credentialStore.getSync(key);
      tokenDecryptionFailed = false;
      return stored?.trim() || null;
    } catch {
      tokenDecryptionFailed = true;
      return null;
    }
  };

  const writeCredential = (
    key: string,
    value: string | null | undefined,
  ): void => {
    if (value?.trim()) {
      credentialStore.setSync(key, value.trim());
    } else {
      credentialStore.deleteSync(key);
    }
    tokenDecryptionFailed = false;
  };

  const readToken = (): {
    token: string;
    source: "stored" | "env" | "override" | null;
  } => {
    if (tokenOverride != null) {
      return {
        token: tokenOverride,
        source: tokenOverride.trim().length > 0 ? "override" : null,
      };
    }
    const stored = readCredential(tokenKey);
    if (stored) return { token: stored, source: "stored" };
    const envValue =
      envToken(
        "ADE_LINEAR_API",
        "LINEAR_API_KEY",
        "ADE_LINEAR_TOKEN",
        "LINEAR_TOKEN",
      ) ?? "";
    return {
      token: envValue,
      source: envValue.trim().length > 0 ? "env" : null,
    };
  };

  const readOAuthClientCredentials = (): {
    clientId: string;
    clientSecret: string | null;
  } | null => {
    const raw = readCredential(oauthClientKey);
    if (!raw) {
      return BUNDLED_LINEAR_OAUTH_CLIENT_ID
        ? { clientId: BUNDLED_LINEAR_OAUTH_CLIENT_ID, clientSecret: null }
        : null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
      const record = parsed as Record<string, unknown>;
      const clientId =
        typeof record.clientId === "string" ? record.clientId.trim() : "";
      if (!clientId) return null;
      return {
        clientId,
        clientSecret:
          typeof record.clientSecret === "string" &&
          record.clientSecret.trim().length > 0
            ? record.clientSecret.trim()
            : null,
      };
    } catch {
      return null;
    }
  };

  // Refresh an OAuth access token near expiry (parity with the desktop service)
  // so headless `ade serve` Linear connections survive past Linear's ~24h token
  // lifetime. No-op for manual tokens / env tokens / when no refresh token.
  let refreshInFlight: Promise<void> | null = null;
  const ensureFreshToken = async (opts?: { force?: boolean }): Promise<void> => {
    if (readCredential(authModeKey) !== "oauth") return;
    const refreshToken = readCredential(refreshTokenKey);
    if (!refreshToken) return;
    if (!opts?.force && !linearTokenNeedsRefresh(readCredential(tokenExpiresAtKey), Date.now())) return;
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }
    const client = readOAuthClientCredentials();
    if (!client) return;
    refreshInFlight = (async () => {
      const performRefresh = async (tokenToRefresh: string): Promise<void> => {
        const result = await refreshLinearOAuthAccessToken({
          refreshToken: tokenToRefresh,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
        });
        if (result.ok) {
          tokenOverride = result.accessToken;
          writeCredential(tokenKey, result.accessToken);
          writeCredential(authModeKey, "oauth");
          writeCredential(refreshTokenKey, result.refreshToken ?? tokenToRefresh);
          writeCredential(tokenExpiresAtKey, result.expiresAt);
          return;
        }
        if (result.invalidGrant) {
          const rereadRefresh = readCredential(refreshTokenKey);
          const rereadExpires = readCredential(tokenExpiresAtKey);
          if (
            linearInvalidGrantLikelyStaleRotation({
              attemptedRefreshToken: tokenToRefresh,
              rereadRefreshToken: rereadRefresh,
              rereadExpiresAt: rereadExpires,
              trustFreshExpiresAt: !opts?.force,
            })
          ) {
            tokenOverride = readCredential(tokenKey);
            return;
          }
          tokenOverride = "";
          writeCredential(tokenKey, null);
          writeCredential(authModeKey, null);
          writeCredential(refreshTokenKey, null);
          writeCredential(tokenExpiresAtKey, null);
          return;
        }
      };

      try {
        await withLinearOAuthRefreshLock(secretsDir, async () => {
          const latestRefresh = readCredential(refreshTokenKey);
          if (!latestRefresh) return;
          if (
            !opts?.force
            && !linearTokenNeedsRefresh(readCredential(tokenExpiresAtKey), Date.now())
          ) {
            return;
          }
          await performRefresh(latestRefresh);
        });
      } catch (error: unknown) {
        if (!(error instanceof LinearOAuthRefreshLockTimeoutError)) throw error;
        args.logger?.warn("linear_sync.oauth_refresh_lock_timeout", {
          message: error.message,
        });
      }
    })().finally(() => {
      refreshInFlight = null;
    });
    await refreshInFlight;
  };

  return {
    getToken() {
      const { token } = readToken();
      return token.trim() || null;
    },
    getStatus() {
      const { token, source } = readToken();
      const authMode =
        source === "stored" || source === "override"
          ? readCredential(authModeKey) === "oauth"
            ? "oauth"
            : "manual"
          : token.trim().length > 0
            ? "manual"
            : null;
      return {
        tokenStored: token.trim().length > 0,
        tokenDecryptionFailed,
        storageScope: "app",
        repo: null,
        userLogin: null,
        scopes: [],
        checkedAt: token.trim().length > 0 ? new Date().toISOString() : null,
        authMode,
        tokenExpiresAt: readCredential(tokenExpiresAtKey),
        refreshTokenStored: Boolean(readCredential(refreshTokenKey)),
        oauthConfigured: readOAuthClientCredentials() != null,
      };
    },
    getTokenOrThrow() {
      const { token } = readToken();
      if (!token.trim()) {
        throw new Error(
          "Linear token missing. Set ADE_LINEAR_API, LINEAR_API_KEY, ADE_LINEAR_TOKEN, or LINEAR_TOKEN for headless mode.",
        );
      }
      return token.trim();
    },
    setToken(nextToken: string) {
      tokenOverride = nextToken.trim();
      writeCredential(tokenKey, tokenOverride);
      writeCredential(authModeKey, "manual");
      writeCredential(refreshTokenKey, null);
      writeCredential(tokenExpiresAtKey, null);
    },
    setOAuthToken(args: {
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
    }) {
      tokenOverride = args.accessToken.trim();
      writeCredential(tokenKey, tokenOverride);
      writeCredential(authModeKey, "oauth");
      writeCredential(refreshTokenKey, args.refreshToken);
      writeCredential(tokenExpiresAtKey, args.expiresAt);
    },
    clearToken() {
      tokenOverride = "";
      writeCredential(tokenKey, null);
      writeCredential(authModeKey, null);
      writeCredential(refreshTokenKey, null);
      writeCredential(tokenExpiresAtKey, null);
    },
    setOAuthClientCredentials(args: {
      clientId: string;
      clientSecret?: string | null;
    }) {
      const clientId = args.clientId.trim();
      if (!clientId.length) {
        throw new Error("A Linear OAuth client ID is required.");
      }
      writeCredential(
        oauthClientKey,
        JSON.stringify({
          clientId,
          clientSecret: args.clientSecret?.trim() || null,
        }),
      );
    },
    clearOAuthClientCredentials() {
      writeCredential(oauthClientKey, null);
    },
    getOAuthClientCredentials() {
      return readOAuthClientCredentials();
    },
    ensureFreshToken,
  };
}

function createHeadlessAgentChatService(
  projectRoot: string,
): HeadlessLinearServices["agentChatService"] {
  const sessions = new Map<string, HeadlessAgentChatSession>();
  const identitySessionIds = new Map<string, string>();
  const transcripts = new Map<string, HeadlessTranscriptEntry[]>();

  const HEADLESS_MODEL_ID = "openai/gpt-5.5";

  const clipText = (value: string, maxChars: number): string => {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  };

  const defaultTitle = (identityKey?: string): string => {
    if (identityKey === "cto") return "CTO Headless Session";
    if (identityKey) return "Headless Employee Session";
    return "Headless Work Chat";
  };

  const defaultSummary = (identityKey?: string): string =>
    identityKey
      ? `Headless ADE session for ${identityKey}. Automatic agent execution is not available in this runtime.`
      : "Headless ADE chat session. Automatic agent execution is not available in this runtime.";

  const resolveHeadlessModel = (
    modelId?: string | null,
  ): { modelId: string; model: string } => {
    const requested = modelId?.trim() || HEADLESS_MODEL_ID;
    const descriptor = getModelById(requested) ?? resolveModelAlias(requested);
    if (descriptor) {
      return {
        modelId: descriptor.id,
        model: getRuntimeModelRefForDescriptor(descriptor),
      };
    }
    return {
      modelId: requested,
      model: requested,
    };
  };

  const ensureTranscript = (sessionId: string): HeadlessTranscriptEntry[] => {
    const existing = transcripts.get(sessionId);
    if (existing) return existing;
    const created: HeadlessTranscriptEntry[] = [];
    transcripts.set(sessionId, created);
    return created;
  };

  const ensureSession = (args: {
    sessionId?: string;
    laneId: string;
    title?: string | null;
    identityKey?: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: string;
    status?: "idle" | "ended";
    endedAt?: string | null;
  }): HeadlessAgentChatSession => {
    const sessionId = args.sessionId?.trim() || `chat-${randomUUID()}`;
    const now = new Date().toISOString();
    const resolvedModel = resolveHeadlessModel(args.modelId);
    const existing = sessions.get(sessionId);
    if (existing) {
      const updated = {
        ...existing,
        laneId: existing.laneId || args.laneId,
        title: args.title?.trim() || existing.title,
        model: resolvedModel.model,
        modelId: resolvedModel.modelId,
        status: args.status ?? existing.status,
        endedAt: args.endedAt === undefined ? existing.endedAt : args.endedAt,
        identityKey: args.identityKey ?? existing.identityKey,
        reasoningEffort:
          args.reasoningEffort ?? existing.reasoningEffort ?? null,
        permissionMode: args.permissionMode ?? existing.permissionMode,
        summary:
          existing.summary ??
          defaultSummary(args.identityKey ?? existing.identityKey),
        lastActivityAt: now,
      };
      sessions.set(sessionId, updated);
      ensureTranscript(sessionId);
      if (updated.identityKey) {
        identitySessionIds.set(updated.identityKey, sessionId);
      }
      return updated;
    }
    const created: HeadlessAgentChatSession = {
      id: sessionId,
      sessionId,
      laneId: args.laneId,
      provider: "codex",
      model: resolvedModel.model,
      modelId: resolvedModel.modelId,
      title: args.title?.trim() || defaultTitle(args.identityKey),
      status: args.status ?? "idle",
      startedAt: now,
      endedAt: args.endedAt ?? null,
      createdAt: now,
      lastActivityAt: now,
      lastOutputPreview: null,
      summary: defaultSummary(args.identityKey),
      ...(args.identityKey ? { identityKey: args.identityKey } : {}),
      ...(args.reasoningEffort !== undefined
        ? { reasoningEffort: args.reasoningEffort }
        : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    };
    sessions.set(sessionId, created);
    ensureTranscript(sessionId);
    if (created.identityKey) {
      identitySessionIds.set(created.identityKey, sessionId);
    }
    return created;
  };

  const appendUserMessage = (args: {
    sessionId: string;
    text: string;
  }): HeadlessAgentChatSession | null => {
    const sessionId = args.sessionId.trim();
    const existing = sessions.get(sessionId);
    if (!existing) return null;
    const now = new Date().toISOString();
    ensureTranscript(sessionId).push({
      role: "user",
      text: args.text,
      timestamp: now,
    });
    const updated = {
      ...existing,
      lastActivityAt: now,
    };
    sessions.set(sessionId, updated);
    return updated;
  };

  const touchSession = (sessionId: string): void => {
    const trimmedSessionId = sessionId.trim();
    const existing = sessions.get(trimmedSessionId);
    if (!existing) return;
    sessions.set(trimmedSessionId, {
      ...existing,
      lastActivityAt: new Date().toISOString(),
    });
  };

  const normalizeMessageKind = (
    kind: HeadlessAgentChatMessageKind | undefined,
  ): HeadlessAgentChatMessageKind => {
    if (kind == null || kind === "auto") return "auto";
    if (kind === "queue" || kind === "wake" || kind === "interrupt-replace") {
      return kind;
    }
    throw new Error(`Unsupported chat message kind: ${String(kind)}`);
  };

  const steerMessage = (args: { sessionId: string; text: string }) => {
    appendUserMessage(args);
    return {
      steerId: `steer-${randomUUID()}`,
      queued: false,
    };
  };

  return {
    async listSessions() {
      return Array.from(sessions.values()).sort(
        (left, right) =>
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
      );
    },
    async getSessionSummary(sessionId: string) {
      return sessions.get(sessionId.trim()) ?? null;
    },
    async getChatTranscript({
      sessionId,
      limit,
      maxChars,
    }: {
      sessionId: string;
      limit?: number;
      maxChars?: number;
    }) {
      const safeLimit = Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
      const safeMaxChars = Math.max(
        32,
        Math.min(20_000, Math.floor(maxChars ?? 4_000)),
      );
      const source = ensureTranscript(sessionId.trim());
      const entries = source.slice(-safeLimit).map((entry) => ({
        ...entry,
        text: clipText(entry.text, safeMaxChars),
      }));
      return {
        sessionId,
        entries,
        truncated:
          source.length > entries.length ||
          entries.some((entry) => entry.text.length >= safeMaxChars),
        totalEntries: source.length,
      };
    },
    async previewSessionToolNames() {
      return [];
    },
    async createSession(args: { laneId: string; title?: string }) {
      return ensureSession({ laneId: args.laneId, title: args.title });
    },
    async updateSession(args: { sessionId: string; title?: string | null }) {
      const existing =
        sessions.get(args.sessionId) ??
        ensureSession({ sessionId: args.sessionId, laneId: "lane-headless" });
      return ensureSession({
        sessionId: existing.id,
        laneId: existing.laneId,
        title: args.title ?? existing.title,
      });
    },
    async sendMessage(args: { sessionId: string; text: string }) {
      appendUserMessage(args);
    },
    async messageSession(args: HeadlessAgentChatMessageArgs) {
      const sessionId = args.sessionId.trim();
      const statusBefore = sessions.get(sessionId)?.status ?? "idle";
      const kind = normalizeMessageKind(args.kind);
      if (kind === "queue") {
        const result = steerMessage({ sessionId, text: args.text });
        return {
          sessionId,
          kind,
          routedAction: "steer",
          statusBefore,
          awaitingInputBefore: false,
          delivery: "queued",
          steerId: result.steerId,
          queued: true,
        };
      }
      if (kind === "interrupt-replace") {
        touchSession(sessionId);
        appendUserMessage({ sessionId, text: args.text });
        return {
          sessionId,
          kind,
          routedAction: "interrupt-replace",
          statusBefore,
          awaitingInputBefore: false,
          delivery: "sent",
        };
      }
      appendUserMessage({ sessionId, text: args.text });
      return {
        sessionId,
        kind,
        routedAction: "sendMessage",
        statusBefore,
        awaitingInputBefore: false,
        delivery: "sent",
      };
    },
    async steer(args: { sessionId: string; text: string }) {
      return steerMessage(args);
    },
    async interrupt(args: { sessionId: string }) {
      touchSession(args.sessionId);
    },
    async resumeSession(args: { sessionId: string }) {
      return ensureSession({
        sessionId: args.sessionId,
        laneId: sessions.get(args.sessionId)?.laneId ?? "lane-headless",
        status: "idle",
        endedAt: null,
      });
    },
    async dispose(args: { sessionId: string }) {
      const existing = sessions.get(args.sessionId);
      sessions.delete(args.sessionId);
      transcripts.delete(args.sessionId);
      if (
        existing?.identityKey &&
        identitySessionIds.get(existing.identityKey) === args.sessionId
      ) {
        identitySessionIds.delete(existing.identityKey);
      }
    },
    async ensureIdentitySession(args: {
      identityKey: string;
      laneId: string;
      modelId?: string | null;
      reasoningEffort?: string | null;
      reuseExisting?: boolean;
      permissionMode?: string;
    }) {
      const identityKey = args.identityKey.trim();
      const existingSessionId = identitySessionIds.get(identityKey);
      if (args.reuseExisting !== false && existingSessionId) {
        const existing = sessions.get(existingSessionId);
        if (existing) {
          return ensureSession({
            sessionId: existingSessionId,
            laneId: existing.laneId,
            title: existing.title,
            identityKey,
            modelId: args.modelId,
            reasoningEffort: args.reasoningEffort,
            permissionMode: args.permissionMode,
          });
        }
      }
      return ensureSession({
        laneId: args.laneId,
        title: defaultTitle(identityKey),
        identityKey,
        modelId: args.modelId,
        reasoningEffort: args.reasoningEffort,
        permissionMode: args.permissionMode,
      });
    },
    setComputerUseArtifactBrokerService() {
      // no-op in headless mode
      void projectRoot;
    },
  };
}

export function createHeadlessLinearServices(
  args: HeadlessLinearDeps,
): HeadlessLinearServices {
  const automationSecretService = createAutomationSecretServiceImpl({
    adeDir: args.adeDir,
    logger: args.logger,
  });
  const linearCredentialService =
    createHeadlessLinearCredentialService({
      adeDir: args.adeDir,
      logger: args.logger,
    });
  const githubService = createHeadlessGitHubService(
    args.projectRoot,
    args.logger,
    {
      onStatusChanged: args.onGitHubStatusChanged,
      githubRelaySecretReader: (ref) => automationSecretService.getSecret(ref),
    },
  );
  const linearClient = createLinearClientImpl({
    credentials: linearCredentialService,
    logger: args.logger,
  });
  const issueTracker = createLinearIssueTrackerImpl({ client: linearClient });
  const fileService = createFileServiceImpl({
    laneService: args.laneService,
    onLaneWorktreeMutation: () => {},
  });
  const sessionService = {
    get: () => null,
  };
  const ptyService = {
    create: async () => {
      throw new Error(
        "PTY-backed run commands are unavailable in headless Linear services.",
      );
    },
    dispose: () => ({ disposed: false as const, reason: "missing" as const }),
    onData: () => () => {},
    onExit: () => () => {},
  };
  const processService = createProcessServiceImpl({
    db: args.db,
    projectId: args.projectId,
    logger: args.logger,
    laneService: args.laneService,
    projectConfigService: args.projectConfigService,
    sessionService,
    ptyService,
    broadcastEvent: () => {},
  });
  const prService = createPrServiceImpl({
    db: args.db,
    logger: args.logger,
    projectId: args.projectId,
    projectRoot: args.projectRoot,
    laneService: args.laneService,
    operationService: args.operationService,
    githubService,
    projectConfigService: args.projectConfigService,
    conflictService: args.conflictService,
    openExternal: args.openExternal ?? (async () => {}),
  });
  const agentChatService = createHeadlessAgentChatService(args.projectRoot);

  return {
    linearCredentialService,
    githubService,
    linearClient,
    linearIssueTracker: issueTracker,
    fileService,
    processService,
    prService,
    agentChatService,
    dispose: () => {
      const swallow = (fn: () => void) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      };
      swallow(() => fileService.dispose());
      swallow(() => processService.disposeAll());
    },
  };
}
