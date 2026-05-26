import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Logger } from "../../desktop/src/main/services/logging/logger";
import type { AdeDb } from "../../desktop/src/main/services/state/kvDb";
import type { createLaneService } from "../../desktop/src/main/services/lanes/laneService";
import type { createOperationService } from "../../desktop/src/main/services/history/operationService";
import type { createProjectConfigService } from "../../desktop/src/main/services/config/projectConfigService";
import type { createConflictService } from "../../desktop/src/main/services/conflicts/conflictService";
import type { createWorkerAgentService } from "../../desktop/src/main/services/cto/workerAgentService";
import type { createWorkerBudgetService } from "../../desktop/src/main/services/cto/workerBudgetService";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import type { createProcessService } from "../../desktop/src/main/services/processes/processService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import type { createLinearClient } from "../../desktop/src/main/services/cto/linearClient";
import type { createLinearIssueTracker } from "../../desktop/src/main/services/cto/linearIssueTracker";
import type { createLinearTemplateService } from "../../desktop/src/main/services/cto/linearTemplateService";
import type { createLinearWorkflowFileService } from "../../desktop/src/main/services/cto/linearWorkflowFileService";
import type { createFlowPolicyService } from "../../desktop/src/main/services/cto/flowPolicyService";
import type { createLinearRoutingService } from "../../desktop/src/main/services/cto/linearRoutingService";
import type { createLinearIntakeService } from "../../desktop/src/main/services/cto/linearIntakeService";
import type { createLinearOutboundService } from "../../desktop/src/main/services/cto/linearOutboundService";
import type { createLinearCloseoutService } from "../../desktop/src/main/services/cto/linearCloseoutService";
import type { createLinearDispatcherService } from "../../desktop/src/main/services/cto/linearDispatcherService";
import type { createLinearSyncService } from "../../desktop/src/main/services/cto/linearSyncService";
import type { createLinearIngressService } from "../../desktop/src/main/services/cto/linearIngressService";
import type { createWorkerTaskSessionService } from "../../desktop/src/main/services/cto/workerTaskSessionService";
import type { createWorkerHeartbeatService } from "../../desktop/src/main/services/cto/workerHeartbeatService";
import type { createAutomationSecretService } from "../../desktop/src/main/services/automations/automationSecretService";
import type { ComputerUseArtifactBrokerService } from "../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import type { LinearWorkflowEventPayload } from "../../desktop/src/shared/types/linearSync";
import {
  getModelById,
  getRuntimeModelRefForDescriptor,
  resolveModelAlias,
} from "../../desktop/src/shared/modelRegistry";
import {
  getGitHubTokenAccessState,
  parseGitHubScopeHeaders,
} from "../../desktop/src/shared/githubScopes";
import type { AdeRuntimePaths } from "./bootstrap";
import { createLinearClient as createLinearClientImpl } from "../../desktop/src/main/services/cto/linearClient";
import { createLinearIssueTracker as createLinearIssueTrackerImpl } from "../../desktop/src/main/services/cto/linearIssueTracker";
import { createLinearTemplateService as createLinearTemplateServiceImpl } from "../../desktop/src/main/services/cto/linearTemplateService";
import { createLinearWorkflowFileService as createLinearWorkflowFileServiceImpl } from "../../desktop/src/main/services/cto/linearWorkflowFileService";
import { createFlowPolicyService as createFlowPolicyServiceImpl } from "../../desktop/src/main/services/cto/flowPolicyService";
import { createLinearRoutingService as createLinearRoutingServiceImpl } from "../../desktop/src/main/services/cto/linearRoutingService";
import { createLinearIntakeService as createLinearIntakeServiceImpl } from "../../desktop/src/main/services/cto/linearIntakeService";
import { createLinearOutboundService as createLinearOutboundServiceImpl } from "../../desktop/src/main/services/cto/linearOutboundService";
import { createLinearCloseoutService as createLinearCloseoutServiceImpl } from "../../desktop/src/main/services/cto/linearCloseoutService";
import { createLinearDispatcherService as createLinearDispatcherServiceImpl } from "../../desktop/src/main/services/cto/linearDispatcherService";
import { createLinearSyncService as createLinearSyncServiceImpl } from "../../desktop/src/main/services/cto/linearSyncService";
import { createLinearIngressService as createLinearIngressServiceImpl } from "../../desktop/src/main/services/cto/linearIngressService";
import { createWorkerTaskSessionService as createWorkerTaskSessionServiceImpl } from "../../desktop/src/main/services/cto/workerTaskSessionService";
import { createFileService as createFileServiceImpl } from "../../desktop/src/main/services/files/fileService";
import { createProcessService as createProcessServiceImpl } from "../../desktop/src/main/services/processes/processService";
import { createPrService as createPrServiceImpl } from "../../desktop/src/main/services/prs/prService";
import { createAutomationSecretService as createAutomationSecretServiceImpl } from "../../desktop/src/main/services/automations/automationSecretService";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";

// Keep headless runtimes aligned with the desktop credential service so packaged
// alpha builds can offer the same PKCE-based Linear sign-in flow.
const BUNDLED_LINEAR_OAUTH_CLIENT_ID =
  process.env.ADE_LINEAR_CLIENT_ID?.trim() || "432fb2ddb16f939ae5d5270e2c86571f";

type HeadlessLinearCredentialService = {
  getStatus: () => {
    tokenStored: boolean;
    tokenDecryptionFailed: boolean;
    storageScope: "app";
    repo: { owner: string; name: string } | null;
    userLogin: string | null;
    scopes: string[];
    checkedAt: string | null;
    authMode?: "manual" | "oauth" | null;
    tokenExpiresAt?: string | null;
    refreshTokenStored?: boolean;
    oauthConfigured?: boolean;
  };
  getTokenOrThrow: () => string;
  setToken: (token: string) => void;
  setOAuthToken: (args: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
  }) => void;
  clearToken: () => void;
  setOAuthClientCredentials: (args: {
    clientId: string;
    clientSecret?: string | null;
  }) => void;
  clearOAuthClientCredentials: () => void;
  getOAuthClientCredentials: () => {
    clientId: string;
    clientSecret: string | null;
  } | null;
};

type HeadlessGitHubStatus = {
  tokenStored: boolean;
  patTokenStored: boolean;
  tokenDecryptionFailed: boolean;
  storageScope: "app";
  authSource: "pat" | "environment" | "gh" | "none";
  tokenType?: "classic" | "fine-grained" | "oauth" | "unknown";
  repo: { owner: string; name: string } | null;
  hasOrigin: boolean;
  userLogin: string | null;
  scopes: string[];
  ghCliPath: string | null;
  ghAuthError: string | null;
  checkedAt: string | null;
  repoAccessOk: boolean | null;
  repoAccessError: string | null;
  connected: boolean;
};

export type HeadlessGitHubService = {
  getStatus: (opts?: {
    forceRefresh?: boolean;
  }) => Promise<HeadlessGitHubStatus>;
  getRemoteStatus: () => Promise<{
    repo: { owner: string; name: string } | null;
    hasOrigin: boolean;
  }>;
  detectRepo: () => Promise<{ owner: string; name: string } | null>;
  getRepoOrThrow: () => Promise<{ owner: string; name: string }>;
  getTokenOrThrow: () => string;
  parseGitHubRepoFromRemoteUrl: typeof parseGitHubRepoFromRemoteUrl;
  apiRequest: <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    token?: string;
  }) => Promise<{ data: T; response: Response | null }>;
  setToken: (token: string) => void;
  clearToken: () => void;
  listRepoAutolinks: (owner: string, name: string) => Promise<unknown[]>;
  createRepoAutolink: (
    owner: string,
    name: string,
    args: { keyPrefix: string; urlTemplate: string; isAlphanumeric?: boolean },
  ) => Promise<unknown>;
  listRepoLabels: (owner: string, name: string) => Promise<unknown[]>;
  listRepoCollaborators: (owner: string, name: string) => Promise<unknown[]>;
  publishCurrentProject: (args: {
    name: string;
    description?: string;
    isPrivate: boolean;
  }) => Promise<{ state: "pushed" | "remote_added"; htmlUrl: string }>;
  addIssueComment: (
    owner: string,
    name: string,
    number: number,
    body: string,
  ) => Promise<unknown>;
  setIssueLabels: (
    owner: string,
    name: string,
    number: number,
    labels: string[],
  ) => Promise<unknown>;
  closeIssue: (
    owner: string,
    name: string,
    number: number,
    reason?: "completed" | "not_planned",
  ) => Promise<unknown>;
  reopenIssue: (
    owner: string,
    name: string,
    number: number,
  ) => Promise<unknown>;
  assignIssue: (
    owner: string,
    name: string,
    number: number,
    assignees: string[],
  ) => Promise<unknown>;
  setIssueTitle: (
    owner: string,
    name: string,
    number: number,
    title: string,
  ) => Promise<unknown>;
};

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
  workerAgentService: ReturnType<typeof createWorkerAgentService>;
  workerBudgetService: ReturnType<typeof createWorkerBudgetService>;
  computerUseArtifactBrokerService: ComputerUseArtifactBrokerService;
  openExternal?: (url: string) => Promise<void>;
  onGitHubStatusChanged?: (status: HeadlessGitHubStatus) => void;
  onLinearWorkflowEvent?: (event: LinearWorkflowEventPayload) => void;
};

type HeadlessLinearServices = {
  githubService: HeadlessGitHubService;
  linearCredentialService: HeadlessLinearCredentialService;
  linearClient: ReturnType<typeof createLinearClient>;
  linearIssueTracker: ReturnType<typeof createLinearIssueTracker>;
  linearTemplateService: ReturnType<typeof createLinearTemplateService>;
  linearWorkflowFileService: ReturnType<typeof createLinearWorkflowFileService>;
  flowPolicyService: ReturnType<typeof createFlowPolicyService>;
  linearRoutingService: ReturnType<typeof createLinearRoutingService>;
  linearIntakeService: ReturnType<typeof createLinearIntakeService>;
  linearOutboundService: ReturnType<typeof createLinearOutboundService>;
  linearCloseoutService: ReturnType<typeof createLinearCloseoutService>;
  linearDispatcherService: ReturnType<typeof createLinearDispatcherService>;
  linearSyncService: ReturnType<typeof createLinearSyncService>;
  linearIngressService: ReturnType<typeof createLinearIngressService>;
  fileService: ReturnType<typeof createFileService>;
  processService: ReturnType<typeof createProcessService>;
  prService: ReturnType<typeof createPrService>;
  agentChatService: {
    listSessions: () => Promise<Array<Record<string, unknown>>>;
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
  workerTaskSessionService: ReturnType<typeof createWorkerTaskSessionService>;
  workerHeartbeatService: ReturnType<typeof createWorkerHeartbeatService>;
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

function ghAuthToken(): Pick<HeadlessGitHubTokenLookup, "token" | "ghCliPath" | "ghAuthError"> {
  if (process.env.ADE_DISABLE_GH_AUTH_FALLBACK === "1") {
    return { token: null, ghCliPath: null, ghAuthError: null };
  }
  try {
    const result = spawnSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      return {
        token: null,
        ghCliPath: "gh",
        ghAuthError: stderr || "GitHub CLI is installed, but `gh auth token` did not return a token.",
      };
    }
    const token = result.stdout?.trim() ?? "";
    return {
      token: token.length > 0 ? token : null,
      ghCliPath: "gh",
      ghAuthError: token.length > 0 ? null : "GitHub CLI is installed, but `gh auth token` did not return a token.",
    };
  } catch (error) {
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
  } = {},
): HeadlessGitHubService {
  const credentialStore = new EncryptedFileCredentialStore();
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

  const apiRequest: HeadlessGitHubService["apiRequest"] = async (args) => {
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
    return { data: data as never, response };
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

  const createRepository = async (args: {
    name: string;
    description?: string;
    isPrivate: boolean;
  }): Promise<{
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
    const { data } = await apiRequest<Record<string, unknown>>({
      method: "POST",
      path: "/user/repos",
      body,
    });
    return {
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
    return {
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
    parseGitHubRepoFromRemoteUrl,
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
        cloneUrl: string;
        sshUrl: string;
        htmlUrl: string;
        defaultBranch: string;
      };
      try {
        created = await createRepository(args);
      } catch (createErr) {
        const message =
          createErr instanceof Error ? createErr.message : String(createErr);
        const isNameTaken = /already exists/i.test(message);
        if (!isNameTaken) throw createErr;

        const validated = await validateToken(token).catch(() => ({
          userLogin: null as string | null,
        }));
        const owner = validated.userLogin;
        if (!owner) throw createErr;

        const existing = await getRepository(owner, args.name);
        if (existing.size > 0) {
          const taken = new Error(
            `A GitHub repo named '${args.name}' already exists on your account and contains commits. Pick a different name.`,
          ) as Error & { code?: string };
          taken.code = "repo_name_taken";
          throw taken;
        }
        created = {
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

      return { state: resultState, htmlUrl: created.htmlUrl };
    },
    async addIssueComment(owner, name, number, body) {
      return (
        await apiRequest({
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
          body: { body },
        })
      ).data;
    },
    async setIssueLabels(owner, name, number, labels) {
      return (
        await apiRequest({
          method: "PUT",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/labels`,
          body: { labels },
        })
      ).data;
    },
    async closeIssue(owner, name, number, reason) {
      return (
        await apiRequest({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: {
            state: "closed",
            ...(reason ? { state_reason: reason } : {}),
          },
        })
      ).data;
    },
    async reopenIssue(owner, name, number) {
      return (
        await apiRequest({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: { state: "open" },
        })
      ).data;
    },
    async assignIssue(owner, name, number, assignees) {
      return (
        await apiRequest({
          method: "POST",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/assignees`,
          body: { assignees },
        })
      ).data;
    },
    async setIssueTitle(owner, name, number, title) {
      return (
        await apiRequest({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
          body: { title },
        })
      ).data;
    },
  };
  return service;
}

function createHeadlessLinearCredentialService(): HeadlessLinearCredentialService {
  const credentialStore = new EncryptedFileCredentialStore();
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

  return {
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
      const sessionId = args.sessionId.trim();
      const existing = sessions.get(sessionId);
      if (existing) {
        ensureTranscript(sessionId).push({
          role: "user",
          text: args.text,
          timestamp: new Date().toISOString(),
        });
        sessions.set(sessionId, {
          ...existing,
          lastActivityAt: new Date().toISOString(),
        });
      }
    },
    async interrupt(args: { sessionId: string }) {
      const existing = sessions.get(args.sessionId);
      if (existing)
        sessions.set(args.sessionId, {
          ...existing,
          lastActivityAt: new Date().toISOString(),
        });
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

function createHeadlessWorkerHeartbeatService(): ReturnType<
  typeof createWorkerHeartbeatService
> {
  const runs: Array<{
    id: string;
    agentId: string;
    status: "failed";
    wakeupReason: string;
    taskKey: string | null;
    issueKey: string | null;
    context: Record<string, unknown>;
    errorMessage: string;
    startedAt: string;
    finishedAt: string;
    createdAt: string;
    updatedAt: string;
  }> = [];

  return {
    listRuns({ limit }: { limit?: number } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(limit ?? 50)));
      return runs.slice(0, safeLimit).map((run) => ({
        ...run,
        executionRunId: null,
        executionLockedAt: null,
        result: null,
      }));
    },
    async triggerWakeup(args: {
      agentId: string;
      reason?: string;
      taskKey?: string | null;
      issueKey?: string | null;
      context?: Record<string, unknown>;
    }) {
      const runId = `wake-${randomUUID()}`;
      const now = new Date().toISOString();
      runs.unshift({
        id: runId,
        agentId: args.agentId,
        status: "failed",
        wakeupReason: args.reason ?? "api",
        taskKey: args.taskKey ?? null,
        issueKey: args.issueKey ?? null,
        context: args.context ?? {},
        errorMessage:
          "Headless ADE mode does not support worker-backed Linear targets yet.",
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { runId, status: "failed" };
    },
    dispose() {
      runs.length = 0;
    },
    start() {
      return;
    },
    stop() {
      return;
    },
  } as unknown as ReturnType<typeof createWorkerHeartbeatService>;
}

export function createHeadlessLinearServices(
  args: HeadlessLinearDeps,
): HeadlessLinearServices {
  const automationSecretService = createAutomationSecretServiceImpl({
    adeDir: args.adeDir,
    logger: args.logger,
  });
  const linearCredentialService =
    createHeadlessLinearCredentialService() as any;
  const githubService = createHeadlessGitHubService(
    args.projectRoot,
    args.logger,
    { onStatusChanged: args.onGitHubStatusChanged },
  );
  const linearClient = createLinearClientImpl({
    credentials: linearCredentialService as any,
    logger: args.logger,
  });
  const issueTracker = createLinearIssueTrackerImpl({ client: linearClient });
  const templateService = createLinearTemplateServiceImpl({
    adeDir: args.adeDir,
  });
  const workflowFileService = createLinearWorkflowFileServiceImpl({
    projectRoot: args.projectRoot,
  });
  const flowPolicyService = createFlowPolicyServiceImpl({
    db: args.db,
    projectId: args.projectId,
    projectConfigService: args.projectConfigService,
    workflowFileService,
  });
  const routingService = createLinearRoutingServiceImpl({
    flowPolicyService,
    workerAgentService: args.workerAgentService,
  });
  const intakeService = createLinearIntakeServiceImpl({
    db: args.db,
    projectId: args.projectId,
    issueTracker,
  });
  const outboundService = createLinearOutboundServiceImpl({
    db: args.db,
    projectId: args.projectId,
    projectRoot: args.projectRoot,
    issueTracker,
    logger: args.logger,
  });
  const fileService = createFileServiceImpl({
    laneService: args.laneService,
    onLaneWorktreeMutation: () => {},
  });
  const sessionService = {
    get: () => null,
  } as any;
  const ptyService = {
    create: async () => {
      throw new Error(
        "PTY-backed run commands are unavailable in headless Linear services.",
      );
    },
    dispose: () => {},
    onData: () => () => {},
    onExit: () => () => {},
  } as any;
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
    githubService: githubService as any,
    projectConfigService: args.projectConfigService,
    conflictService: args.conflictService,
    openExternal: args.openExternal ?? (async () => {}),
  } as any);
  const workerTaskSessionService = createWorkerTaskSessionServiceImpl({
    db: args.db,
    projectId: args.projectId,
  });
  const workerHeartbeatService = createHeadlessWorkerHeartbeatService();
  const agentChatService = createHeadlessAgentChatService(args.projectRoot);
  if (
    typeof (prService as { setAgentChatService?: (svc: unknown) => void })
      .setAgentChatService === "function"
  ) {
    (
      prService as { setAgentChatService: (svc: unknown) => void }
    ).setAgentChatService(agentChatService as never);
  }
  const closeoutService = createLinearCloseoutServiceImpl({
    issueTracker,
    outboundService,
    prService,
    computerUseArtifactBrokerService: args.computerUseArtifactBrokerService,
  } as Parameters<typeof createLinearCloseoutServiceImpl>[0]);
  const dispatcherService = createLinearDispatcherServiceImpl({
    db: args.db,
    projectId: args.projectId,
    issueTracker,
    workerAgentService: args.workerAgentService,
    workerHeartbeatService,
    agentChatService: agentChatService as never,
    laneService: args.laneService,
    templateService,
    closeoutService,
    outboundService,
    workerTaskSessionService,
    prService,
    onEvent: args.onLinearWorkflowEvent ?? (() => {}),
  } as Parameters<typeof createLinearDispatcherServiceImpl>[0]);
  const syncService = createLinearSyncServiceImpl({
    db: args.db,
    logger: args.logger,
    projectId: args.projectId,
    flowPolicyService,
    routingService,
    intakeService,
    issueTracker,
    dispatcherService,
    autoStart: false,
    hasCredentials: () => linearCredentialService.getStatus().tokenStored,
  });
  const handleIngressEvent = async (event: { issueId?: string | null }) => {
    const issueId =
      typeof event.issueId === "string" ? event.issueId.trim() : "";
    if (!issueId) return;
    await syncService.processIssueUpdate(issueId);
  };
  const ingressService = createLinearIngressServiceImpl({
    db: args.db,
    logger: args.logger,
    projectId: args.projectId,
    linearClient,
    secretService: automationSecretService as ReturnType<
      typeof createAutomationSecretService
    >,
    onEvent: handleIngressEvent,
  });

  return {
    linearCredentialService,
    githubService,
    linearClient,
    linearIssueTracker: issueTracker,
    linearTemplateService: templateService,
    linearWorkflowFileService: workflowFileService,
    flowPolicyService,
    linearRoutingService: routingService,
    linearIntakeService: intakeService,
    linearOutboundService: outboundService,
    linearCloseoutService: closeoutService,
    linearDispatcherService: dispatcherService,
    linearSyncService: syncService,
    linearIngressService: ingressService,
    fileService,
    processService,
    prService,
    agentChatService,
    workerTaskSessionService,
    workerHeartbeatService,
    dispose: () => {
      const swallow = (fn: () => void) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      };
      swallow(() => syncService.dispose());
      swallow(() => ingressService.dispose());
      swallow(() => fileService.dispose());
      swallow(() => processService.disposeAll());
      swallow(() => workerHeartbeatService.dispose());
    },
  };
}
