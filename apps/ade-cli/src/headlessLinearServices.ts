import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
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
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import type { createLinearClient } from "../../desktop/src/main/services/cto/linearClient";
import type { createLinearCredentialService } from "../../desktop/src/main/services/cto/linearCredentialService";
import type { createLinearIssueTracker } from "../../desktop/src/main/services/cto/linearIssueTracker";
import type { createAutomationSecretService } from "../../desktop/src/main/services/automations/automationSecretService";
import type { ComputerUseArtifactBrokerService } from "../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import { resolveSmartLinkPreview } from "../../desktop/src/main/services/chat/smartLinkPreviewService";
import type { SmartLinkPreview } from "../../desktop/src/shared/smartLinks";
import {
  getModelById,
  getRuntimeModelRefForDescriptor,
  resolveModelAlias,
} from "../../desktop/src/shared/modelRegistry";
import { parseGitHubScopeHeaders } from "../../desktop/src/shared/githubScopes";
import type {
  GitHubAuthFailure,
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppUserAuthStatus,
  GitHubRepoRef,
  GitHubRateLimitState,
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
import {
  requestGithubRawWithCredentialFallback,
  type GithubRawRequestArgs,
} from "../../desktop/src/main/services/github/githubRawRequest";
import {
  classifyGitHubAuthFailure,
  classifyGitHubGraphqlCredentialFailure,
  GitHubRateLimitError,
  githubRateLimitResourceForPath,
  githubRateLimitRetryAtMs,
  readGitHubRateLimitState,
} from "../../desktop/src/main/services/github/githubRateLimit";
import type { AdeRuntimePaths } from "./bootstrap";
import { createLinearClient as createLinearClientImpl } from "../../desktop/src/main/services/cto/linearClient";
import { ADE_LINEAR_APP_CLIENT_ID, type LinearOAuthClientSource } from "../../desktop/src/main/services/cto/linearAppClient";
import { createLinearIssueTracker as createLinearIssueTrackerImpl } from "../../desktop/src/main/services/cto/linearIssueTracker";
import { createFileService as createFileServiceImpl } from "../../desktop/src/main/services/files/fileService";
import { createPrService as createPrServiceImpl } from "../../desktop/src/main/services/prs/prService";
import { createAutomationSecretService as createAutomationSecretServiceImpl } from "../../desktop/src/main/services/automations/automationSecretService";
import { EncryptedFileCredentialStore } from "./services/credentials/credentialStore";
import {
  evaluateGithubCredentialCapabilities,
  githubOperationCredentialCandidates,
  resolveGithubOperationCredentialCandidate,
  resolveGithubStatusCredentials,
  selectGithubOperationCredential,
  type GithubOperationCredentialCapability,
} from "../../desktop/src/shared/githubOperationCredential";
import {
  classifyGitHubRepositoryApiPath,
  createGithubRepositoryRequestFallback,
  isGithubRepositorySpecificAccessDenial,
} from "../../desktop/src/shared/githubApiPath";
import { createGithubConditionalRequestCache } from "../../desktop/src/shared/githubConditionalRequestCache";
import {
  clearGithubCredentialHealth,
  githubBackgroundRequestPauseUntilMs,
  githubCredentialCooldown,
  githubCredentialNonRateLimitCooldown,
  githubCredentialRateLimitCooldown,
  githubCredentialInventoryKey,
  githubCredentialRepositoryAccess,
  githubCredentialStates,
  githubCredentialTokenDigest,
  recordGithubCredentialFailure,
  recordGithubOperationFailure,
  recordGithubCredentialProbeSuccess,
  recordGithubCredentialRepositoryAccess,
  recordGithubCredentialSuccess,
  registerGithubCredentialIdentity,
  type GithubCredentialCandidate,
} from "../../desktop/src/main/services/github/githubCredentialHealth";
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
  process.env.ADE_LINEAR_CLIENT_ID?.trim() || ADE_LINEAR_APP_CLIENT_ID;

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
  getAccountAccessToken?: () => Promise<string | null>;
};

type HeadlessLinearServices = {
  githubService: HeadlessGitHubService;
  linearCredentialService: HeadlessLinearCredentialService;
  linearClient: ReturnType<typeof createLinearClient>;
  linearIssueTracker: ReturnType<typeof createLinearIssueTracker>;
  fileService: ReturnType<typeof createFileService>;
  prService: ReturnType<typeof createPrService>;
  agentChatService: {
    resolveSmartLinkPreview: (args: { url: string }) => Promise<SmartLinkPreview | null>;
    listSessions: () => Promise<HeadlessAgentChatSession[]>;
    getSessionSummary: (
      sessionId: string,
    ) => Promise<Record<string, unknown> | null>;
    /** Mirrors the desktop chat service so `cto_state.getAttention` resolves headlessly. */
    getCtoAttention: () => Promise<{ awaitingInput: boolean; since: string | null }>;
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
    getChatTranscriptPage: (args: {
      sessionId: string;
      beforeOffset?: number;
      limit?: number;
      maxChars?: number;
      signal?: AbortSignal;
    }) => Promise<{
      sessionId: string;
      entries: Array<{
        role: "user" | "assistant";
        text: string;
        timestamp: string;
      }>;
      truncated: boolean;
      totalEntries: number;
      nextCursor: number | null;
      cursorKind: "index";
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
      reason?: "queue_full";
    }>;
    interrupt: (args: { sessionId: string }) => Promise<void>;
    /**
     * Mirrors the desktop chat service so the CTO operator tools
     * (`cancelSteer`) and the `chat.cancelSteer` sync command resolve
     * headlessly instead of throwing "not a function".
     */
    cancelSteer: (args: {
      sessionId: string;
      steerId: string;
      requireQueued?: boolean;
    }) => Promise<void>;
    /** Headless runs spawn no sub-agents; kept so `chat.listSubagents` answers. */
    listSubagents: (args: { sessionId: string }) => Promise<never[]>;
    /** Headless runs never raise approval requests; kept so callers get a real error. */
    approveToolUse: (args: {
      sessionId: string;
      itemId: string;
      decision: "accept" | "accept_for_session" | "decline" | "cancel";
      responseText?: string | null;
    }) => Promise<void>;
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

type HeadlessGitHubTokenCandidate = HeadlessGitHubTokenLookup & GithubCredentialCandidate & {
  token: string;
};

type HeadlessGitHubCredentialInventory = {
  candidates: HeadlessGitHubTokenCandidate[];
  availableSources: Set<HeadlessGitHubTokenCandidate["source"]>;
  patTokenStored: boolean;
  ghCliPath: string | null;
  ghAuthError: string | null;
};

class HeadlessGithubCredentialAttemptError extends Error {
  constructor(
    message: string,
    readonly authFailure: GitHubAuthFailure,
    readonly rateLimit: GitHubRateLimitState | null,
  ) {
    super(message);
    this.name = "HeadlessGithubCredentialAttemptError";
  }
}

class HeadlessGitHubTokenValidationError extends Error {
  constructor(
    message: string,
    readonly authFailure: GitHubAuthFailure,
    readonly rateLimit: GitHubRateLimitState | null,
  ) {
    super(message);
    this.name = "HeadlessGitHubTokenValidationError";
  }
}

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

async function readGhHostsFileTokenAsync(): Promise<string | null> {
  const configDir = process.env.GH_CONFIG_DIR?.trim()
    || path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "gh");
  try {
    const raw = await fs.promises.readFile(path.join(configDir, "hosts.yml"), "utf8");
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

async function resolveGhCliPathAsync(): Promise<string> {
  const candidates = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return "gh";
}

function runCommandAsync(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; maxBuffer?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? Number((error as NodeJS.ErrnoException).code)
            : error
              ? 1
              : 0,
          stdout,
          stderr: stderr || (error ? error.message : ""),
        });
      },
    );
  });
}

function ghAuthToken(): Pick<HeadlessGitHubTokenLookup, "token" | "ghCliPath" | "ghAuthError"> {
  if (process.env.ADE_DISABLE_GH_AUTH_FALLBACK === "1") {
    return { token: null, ghCliPath: null, ghAuthError: null };
  }
  const hostsToken = readGhHostsFileToken();
  if (hostsToken) {
    return { token: hostsToken, ghCliPath: null, ghAuthError: null };
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
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    return {
      token: null,
      ghCliPath,
      ghAuthError: stderr || "GitHub CLI is installed, but `gh auth token` did not return a token.",
    };
  } catch (error) {
    return {
      token: null,
      ghCliPath: null,
      ghAuthError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ghAuthTokenAsync(): Promise<Pick<
  HeadlessGitHubTokenLookup,
  "token" | "ghCliPath" | "ghAuthError"
>> {
  if (process.env.ADE_DISABLE_GH_AUTH_FALLBACK === "1") {
    return { token: null, ghCliPath: null, ghAuthError: null };
  }
  const hostsToken = await readGhHostsFileTokenAsync();
  if (hostsToken) {
    return { token: hostsToken, ghCliPath: null, ghAuthError: null };
  }
  const ghCliPath = await resolveGhCliPathAsync();
  const result = await runCommandAsync(ghCliPath, ["auth", "token"], {
    timeoutMs: 5_000,
    maxBuffer: 64 * 1024,
  });
  const token = result.exitCode === 0 ? result.stdout.trim() : "";
  if (token) return { token, ghCliPath, ghAuthError: null };
  return {
    token: null,
    ghCliPath,
    ghAuthError: result.stderr.trim()
      || "GitHub CLI is installed, but `gh auth token` did not return a token.",
  };
}

async function readGitOriginAsync(projectRoot: string): Promise<string | null> {
  const result = await runCommandAsync("git", ["remote", "get-url", "origin"], {
    cwd: projectRoot,
    timeoutMs: 2_000,
    maxBuffer: 64 * 1024,
  });
  const remote = result.exitCode === 0 ? result.stdout.trim() : "";
  return remote || null;
}

function runGitHeadlessAsync(
  projectRoot: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommandAsync("git", args, {
    cwd: projectRoot,
    timeoutMs,
  });
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

async function detectGitHubRepoAsync(
  projectRoot: string,
): Promise<{ owner: string; name: string } | null> {
  return parseGitHubRepoFromRemoteUrl(await readGitOriginAsync(projectRoot) ?? "");
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
  const upstreamSignal = init.signal;
  const abortFromUpstream = (): void => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
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
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

export function createHeadlessGitHubService(
  projectRoot: string,
  logger: Logger,
  options: {
    onStatusChanged?: (status: HeadlessGitHubStatus) => void;
    githubRelaySecretReader?: GitHubRelaySecretReader | null;
    getAccountAccessToken?: (() => Promise<string | null>) | null;
    ghAuthTokenProvider?: (() => Pick<
      HeadlessGitHubTokenLookup,
      "token" | "ghCliPath" | "ghAuthError"
    >) | null;
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
  let cachedStatusBinding: string | null = null;
  let tokenOverride: string | null = null;
  let tokenDecryptionFailed = false;
  let statusLookupGeneration = 0;
  let statusLookupInFlight: {
    generation: number;
    binding: string;
    promise: Promise<HeadlessGitHubStatus>;
  } | null = null;

  const invalidateStatusCache = (): void => {
    cachedStatus = null;
    cachedAt = 0;
    cachedStatusBinding = null;
    statusLookupGeneration += 1;
  };

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
    const patTokenStored = Boolean(patToken);
    let ghFallback: HeadlessGitHubTokenLookup = {
      token: null,
      source: "none",
      patTokenStored,
      ghCliPath: null,
      ghAuthError: null,
    };
    return selectGithubOperationCredential<HeadlessGitHubTokenLookup>({
      environment: () => {
        const token = envToken("ADE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN");
        return token
          ? { token, source: "environment", patTokenStored, ghCliPath: null, ghAuthError: null }
          : null;
      },
      app: () => null,
      gh: () => {
        const gh = options.ghAuthTokenProvider?.() ?? ghAuthToken();
        ghFallback = { ...gh, source: "none", patTokenStored };
        return gh.token ? { ...gh, source: "gh", patTokenStored } : null;
      },
      pat: () => patToken
        ? { ...ghFallback, token: patToken, source: "pat", patTokenStored }
        : null,
    }, "write") ?? ghFallback;
  };

  const readStoredPatTokenAsync = async (): Promise<string | null> => {
    if (tokenOverride != null) return tokenOverride;
    try {
      const stored = await credentialStore.get(tokenKey);
      tokenDecryptionFailed = false;
      if (stored?.trim()) return stored.trim();
    } catch {
      tokenDecryptionFailed = true;
    }
    return null;
  };

  const readCredentialInventoryAsync = async (): Promise<HeadlessGitHubCredentialInventory> => {
    const patToken = await readStoredPatTokenAsync();
    const patTokenStored = Boolean(patToken);
    const environmentToken = envToken("ADE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN");
    const appStatus = appUserAuth.getAuthStatus();
    const [appToken, gh] = await Promise.all([
      appStatus.tokenStored
        ? appUserAuth.getValidTokenForRelay().catch(() => null)
        : Promise.resolve(null),
      Promise.resolve(options.ghAuthTokenProvider?.() ?? ghAuthTokenAsync()),
    ]);
    const candidates: HeadlessGitHubTokenCandidate[] = [];
    if (environmentToken) {
      candidates.push({
        token: environmentToken,
        source: "environment",
        patTokenStored,
        ghCliPath: null,
        ghAuthError: null,
        capabilities: ["read", "write"],
      });
    }
    if (appToken) {
      candidates.push({
        token: appToken,
        source: "app",
        patTokenStored,
        ghCliPath: null,
        ghAuthError: null,
        capabilities: ["read"],
        userLogin: appStatus.userLogin,
      });
    }
    if (gh.token) {
      candidates.push({
        token: gh.token,
        source: "gh",
        patTokenStored,
        ghCliPath: gh.ghCliPath,
        ghAuthError: gh.ghAuthError,
        capabilities: ["read", "write"],
      });
    }
    if (patToken) {
      candidates.push({
        token: patToken,
        source: "pat",
        patTokenStored,
        ghCliPath: gh.ghCliPath,
        ghAuthError: gh.ghAuthError,
        capabilities: ["read", "write"],
      });
    }
    return {
      candidates,
      availableSources: new Set(candidates.map((candidate) => candidate.source)),
      patTokenStored,
      ghCliPath: gh.ghCliPath,
      ghAuthError: gh.ghAuthError,
    };
  };

  const readTokenAsync = async (
    capability: GithubOperationCredentialCapability = "write",
  ): Promise<HeadlessGitHubTokenLookup> => {
    const inventory = await readCredentialInventoryAsync();
    return resolveGithubOperationCredentialCandidate({
      candidates: inventory.candidates,
      capability,
      isAvailable: (candidate) => !githubCredentialCooldown(
        candidate,
        Date.now(),
        { resource: "core" },
      ),
    })
      ?? {
        token: null,
        source: "none",
        patTokenStored: inventory.patTokenStored,
        ghCliPath: inventory.ghCliPath,
        ghAuthError: inventory.ghAuthError,
      };
  };

  const readGitTransportTokenAsync = async (): Promise<HeadlessGitHubTokenLookup> => {
    const inventory = await readCredentialInventoryAsync();
    return resolveGithubOperationCredentialCandidate({
      candidates: inventory.candidates,
      capability: "write",
      isAvailable: (candidate) => !githubCredentialNonRateLimitCooldown(
        candidate,
        Date.now(),
        { resource: "core" },
      ),
    }) ?? {
      token: null,
      source: "none",
      patTokenStored: inventory.patTokenStored,
      ghCliPath: inventory.ghCliPath,
      ghAuthError: inventory.ghAuthError,
    };
  };

  const getToken = (): string => readToken().token ?? "";

  const getTokenType = (token: string): NonNullable<HeadlessGitHubStatus["tokenType"]> => {
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
  const validateToken = async (
    token: string,
  ): Promise<{
    userLogin: string | null;
    scopes: string[];
    tokenType: NonNullable<HeadlessGitHubStatus["tokenType"]>;
    rateLimit: GitHubRateLimitState | null;
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
    const rateLimit = readGitHubRateLimitState(response.headers);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = readApiMessage(
        payload,
        `GitHub token validation failed (HTTP ${response.status})`,
      );
      const failure = classifyGitHubAuthFailure({
        status: response.status,
        message,
        headers: response.headers,
      });
      throw new HeadlessGitHubTokenValidationError(
        message,
        failure.authFailure,
        failure.rateLimit,
      );
    }
    const userLogin =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { login?: unknown }).login === "string"
        ? (payload as { login: string }).login
        : null;
    return { userLogin, scopes, tokenType: getTokenType(token), rateLimit };
  };

  type HeadlessGithubStatusProbe = {
    validated: Awaited<ReturnType<typeof validateToken>>;
    repoAccessOk: boolean | null;
    repoAccessError: string | null;
  };
  type HeadlessGithubStatusProbeResult =
    | { ok: true; value: HeadlessGithubStatusProbe }
    | {
        ok: false;
        error: string;
        authFailure: GitHubAuthFailure;
        rateLimit: GitHubRateLimitState | null;
        value?: HeadlessGithubStatusProbe;
      };

  const validatedCredentialCapabilities = (
    candidate: HeadlessGitHubTokenCandidate,
    probe: HeadlessGithubStatusProbe,
    repo: { owner: string; name: string } | null,
  ) => evaluateGithubCredentialCapabilities({
    source: candidate.source,
    tokenType: probe.validated.tokenType,
    scopes: probe.validated.scopes,
    userLogin: probe.validated.userLogin,
    repositoryPresent: repo != null,
    repositoryReadValidated: probe.repoAccessOk,
  });

  const probeRepoAccess = async (
    candidate: HeadlessGitHubTokenCandidate,
    repo: { owner: string; name: string },
    forceRefresh = false,
  ): Promise<{
    ok: boolean;
    error: string | null;
    authFailure: GitHubAuthFailure | null;
    rateLimit: GitHubRateLimitState | null;
  }> => {
    const cachedAccess = forceRefresh
      ? null
      : githubCredentialRepositoryAccess(candidate, repo);
    if (cachedAccess != null) {
      return {
        ok: cachedAccess,
        error: cachedAccess ? null : `This credential cannot access ${repo.owner}/${repo.name}.`,
        authFailure: cachedAccess
          ? null
          : {
              kind: "permission_denied",
              message: `This credential cannot access ${repo.owner}/${repo.name}.`,
              retryAt: null,
            },
        rateLimit: null,
      };
    }
    try {
      const response = await fetchGitHub(
        `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
        {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${candidate.token}`,
            "user-agent": "ade-cli",
          },
        },
      );
      if (response.ok) {
        recordGithubCredentialRepositoryAccess(candidate, repo, true);
        return {
          ok: true,
          error: null,
          authFailure: null,
          rateLimit: readGitHubRateLimitState(response.headers),
        };
      }
      const payload = await response.json().catch(() => ({}));
      const message = readApiMessage(payload, `HTTP ${response.status}`);
      const failure = classifyGitHubAuthFailure({
        status: response.status,
        message,
        headers: response.headers,
      });
      const repositoryAccessDenied = isGithubRepositorySpecificAccessDenial(
        response.status,
        message,
      );
      const authFailure = failure.authFailure.kind === "unknown"
        && (response.status === 403 || response.status === 404)
        ? {
            kind: "permission_denied" as const,
            message: `This credential cannot access ${repo.owner}/${repo.name}.`,
            retryAt: null,
          }
        : failure.authFailure.kind === "unknown"
          ? null
          : failure.authFailure;
      if (authFailure?.kind === "permission_denied" && repositoryAccessDenied) {
        recordGithubCredentialRepositoryAccess(candidate, repo, false);
      }
      return {
        ok: false,
        error: `${response.status}: ${message}`,
        authFailure,
        rateLimit: failure.rateLimit,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        authFailure: classifyGitHubAuthFailure({
          message: error instanceof Error ? error.message : String(error),
        }).authFailure,
        rateLimit: null,
      };
    }
  };

  const probeCandidate = async (
    candidate: HeadlessGitHubTokenCandidate,
    repo: { owner: string; name: string } | null,
    forceRefresh: boolean,
  ): Promise<HeadlessGithubStatusProbeResult> => {
    try {
      const validated = await validateToken(candidate.token);
      let repoAccessOk: boolean | null = null;
      let repoAccessError: string | null = null;
      if (repo && (candidate.source === "app" || validated.tokenType === "fine-grained")) {
        const repoProbe = await probeRepoAccess(candidate, repo, forceRefresh);
        validated.rateLimit = repoProbe.rateLimit ?? validated.rateLimit;
        repoAccessOk = repoProbe.ok;
        repoAccessError = repoProbe.error;
        if (repoProbe.authFailure) {
          return {
            ok: false,
            error: repoProbe.error ?? repoProbe.authFailure.message,
            authFailure: repoProbe.authFailure,
            rateLimit: repoProbe.rateLimit,
            value: { validated, repoAccessOk, repoAccessError },
          };
        }
      }
      return { ok: true, value: { validated, repoAccessOk, repoAccessError } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = error instanceof HeadlessGitHubTokenValidationError
        ? { authFailure: error.authFailure, rateLimit: error.rateLimit }
        : classifyGitHubAuthFailure({ message });
      return { ok: false, error: message, ...classified };
    }
  };

  const conditionalRequestCache = createGithubConditionalRequestCache();

  const requestRawWithCredentialFallback = async (
    args: GithubRawRequestArgs,
  ): Promise<Response> => await requestGithubRawWithCredentialFallback({
    ...args,
    candidates: (await readCredentialInventoryAsync()).candidates,
    fetchImpl: fetchGitHub,
    userAgent: "ade-cli",
    authMissingMessage: "GitHub auth missing. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, run `gh auth login -h github.com -s repo -s workflow`, or add a PAT in Settings.",
    onFallback: ({ capability, fromSource, toSource }) => {
      logger.info("github.credential_fallback_used", {
        capability,
        fromSource,
        toSource,
      });
    },
  });

  const apiRequest = async <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    token?: string;
    accept?: string;
    capability?: GithubOperationCredentialCapability;
    repo?: GitHubRepoRef;
  }): Promise<{ data: T; response: Response | null; linkHeader?: string | null }> => {
    const capability = args.capability ?? (args.method === "GET" ? "read" : "write");
    const explicitToken = args.token?.trim() ?? "";
    const candidates: HeadlessGitHubTokenCandidate[] = explicitToken
      ? [{
          token: explicitToken,
          source: "environment",
          patTokenStored: false,
          ghCliPath: null,
          ghAuthError: null,
          capabilities: [capability],
        }]
      : githubOperationCredentialCandidates(
          (await readCredentialInventoryAsync()).candidates,
          capability,
        );
    if (candidates.length === 0) {
      throw new Error(
        "GitHub auth missing. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, run `gh auth login -h github.com -s repo -s workflow`, or add a PAT in Settings.",
      );
    }
    const url = new URL(`https://api.github.com${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    const accept = args.accept?.trim() || "application/vnd.github+json";
    const rateLimitResource = githubRateLimitResourceForPath(args.path);
    const repositoryPath = classifyGitHubRepositoryApiPath(args.path)
      ?? (args.repo ? { ...args.repo, isRepositoryRoot: true } : null);
    const repositoryFallback = createGithubRepositoryRequestFallback<HeadlessGitHubTokenCandidate>({
      path: repositoryPath,
      readAccess: githubCredentialRepositoryAccess,
      recordAccess: recordGithubCredentialRepositoryAccess,
    });
    let firstUnavailable: {
      failure: GitHubAuthFailure;
      rateLimit: GitHubRateLimitState | null;
    } | null = null;
    let lastAttemptError: HeadlessGithubCredentialAttemptError | null = null;
    let firstRateLimitError: HeadlessGithubCredentialAttemptError | null = null;

    for (const candidate of candidates) {
      if (
        !args.token
        && repositoryPath
        && repositoryFallback.shouldSkip(candidate)
      ) {
        lastAttemptError = new HeadlessGithubCredentialAttemptError(
          `This credential cannot access ${repositoryPath.owner}/${repositoryPath.name}.`,
          {
            kind: "permission_denied",
            message: `This credential cannot access ${repositoryPath.owner}/${repositoryPath.name}.`,
            retryAt: null,
          },
          null,
        );
        continue;
      }
      const cooldown = args.token
        ? null
        : githubCredentialCooldown(candidate, Date.now(), { resource: rateLimitResource });
      if (cooldown) {
        firstUnavailable ??= cooldown;
        continue;
      }
      const cacheKey = `${githubCredentialTokenDigest(candidate.token)}:${accept}:${url.toString()}`;
      const headers: Record<string, string> = {
        accept,
        authorization: `Bearer ${candidate.token}`,
        "user-agent": "ade-cli",
        ...(args.body == null ? {} : { "content-type": "application/json" }),
      };
      let releaseConditionalRequest: (() => void) | null = null;
      if (args.method === "GET") {
        const conditional = conditionalRequestCache.begin(cacheKey);
        if (conditional) {
          headers["if-none-match"] = conditional.entry.etag;
          releaseConditionalRequest = conditional.release;
        }
      }
      let response: Response;
      try {
        response = await fetchGitHub(url, {
          method: args.method,
          headers,
          body: args.body == null ? undefined : JSON.stringify(args.body),
        });
      } finally {
        releaseConditionalRequest?.();
      }
      if (response.status === 304) {
        const cached = conditionalRequestCache.get(cacheKey);
        if (cached) {
          recordGithubCredentialSuccess(candidate, response.headers);
          repositoryFallback.recordSuccess(candidate);
          return { data: cached.data as T, response, linkHeader: cached.linkHeader };
        }
        delete headers["if-none-match"];
        response = await fetchGitHub(url, {
          method: args.method,
          headers,
          body: args.body == null ? undefined : JSON.stringify(args.body),
        });
      }
      const text = await response.text();
      let data: unknown = text;
      try {
        data = text.trim().length ? JSON.parse(text) : {};
      } catch {
        // Keep non-JSON response bodies for callers and error messages.
      }
      if (!response.ok) {
        const message = readApiMessage(
          data,
          `GitHub API request failed (HTTP ${response.status})`,
        );
        const failure = classifyGitHubAuthFailure({
          status: response.status,
          message,
          headers: response.headers,
        });
        const { repositoryNotFound, ambiguousRepositoryNotFound } =
          repositoryFallback.classifyFailure(candidate, response.status);
        if (!repositoryNotFound) {
          recordGithubOperationFailure(candidate, failure.authFailure, failure.rateLimit);
        }
        const attemptError = new HeadlessGithubCredentialAttemptError(
          message,
          failure.authFailure,
          failure.rateLimit,
        );
        lastAttemptError = attemptError;
        if (attemptError.authFailure.kind === "rate_limited") {
          firstRateLimitError ??= attemptError;
        }
        const canTryNext = !args.token
          && (
            response.status === 401
            || response.status === 403
            || response.status === 429
            || ambiguousRepositoryNotFound
          );
        if (canTryNext) {
          continue;
        }
        if (attemptError.authFailure.kind === "rate_limited") {
          const resetAtMs = githubRateLimitRetryAtMs(attemptError.authFailure, attemptError.rateLimit);
          const resetDetail = resetAtMs == null
            ? "rate limit exceeded"
            : `rate limit exceeded; resets at ${new Date(resetAtMs).toLocaleString()}`;
          throw new GitHubRateLimitError(
            `${attemptError.message} (${resetDetail})`,
            resetAtMs,
            attemptError.rateLimit,
          );
        }
        throw attemptError;
      }

      const graphqlFailure = rateLimitResource === "graphql"
        ? classifyGitHubGraphqlCredentialFailure(data, response.headers)
        : null;
      if (graphqlFailure) {
        const { repositoryNotFound } = repositoryFallback.classifyFailure(
          candidate,
          graphqlFailure.status,
        );
        if (!repositoryNotFound) {
          recordGithubOperationFailure(
            candidate,
            graphqlFailure.authFailure,
            graphqlFailure.rateLimit,
          );
        }
        const attemptError = new HeadlessGithubCredentialAttemptError(
          graphqlFailure.message,
          graphqlFailure.authFailure,
          graphqlFailure.rateLimit,
        );
        lastAttemptError = attemptError;
        if (attemptError.authFailure.kind === "rate_limited") {
          firstRateLimitError ??= attemptError;
        }
        const canTryNext = !args.token
          && (capability === "read" || !graphqlFailure.hasData);
        if (canTryNext) continue;
        if (attemptError.authFailure.kind === "rate_limited") {
          const resetAtMs = githubRateLimitRetryAtMs(attemptError.authFailure, attemptError.rateLimit);
          throw new GitHubRateLimitError(attemptError.message, resetAtMs, attemptError.rateLimit);
        }
        throw attemptError;
      }

      recordGithubCredentialSuccess(candidate, response.headers);
      repositoryFallback.recordSuccess(candidate);
      if (candidate !== candidates[0]) {
        logger.info("github.credential_fallback_used", {
          capability,
          fromSource: candidates[0]?.source ?? null,
          toSource: candidate.source,
        });
      }
      const linkHeader = response.headers.get("link");
      if (args.method === "GET") {
        const etag = response.headers.get("etag");
        if (etag) {
          conditionalRequestCache.store(cacheKey, { etag, data, linkHeader });
        }
      }
      return { data: data as T, response, linkHeader };
    }

    const unavailableError = firstUnavailable
      ? new HeadlessGithubCredentialAttemptError(
          firstUnavailable.failure.message,
          firstUnavailable.failure,
          firstUnavailable.rateLimit,
        )
      : null;
    const exhausted = firstRateLimitError
      ?? (unavailableError?.authFailure.kind === "rate_limited" ? unavailableError : null)
      ?? lastAttemptError
      ?? unavailableError;
    if (exhausted?.authFailure.kind === "rate_limited") {
      const resetAtMs = githubRateLimitRetryAtMs(exhausted.authFailure, exhausted.rateLimit);
      const resetDetail = resetAtMs == null
        ? "rate limit exceeded"
        : `rate limit exceeded; resets at ${new Date(resetAtMs).toLocaleString()}`;
      throw new GitHubRateLimitError(
        `${exhausted.message} (${resetDetail})`,
        resetAtMs,
        exhausted.rateLimit,
      );
    }
    if (exhausted) throw exhausted;
    throw new Error("No usable GitHub credential is available for this operation.");
  };

  const apiRequestAllPages = async <T>(args: {
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    token?: string;
  }): Promise<T[]> => {
    const first = await apiRequest<T[]>({ method: "GET", ...args });
    const out = Array.isArray(first.data) ? [...first.data] : [];
    let nextUrl = parseNextGitHubLink(
      first.linkHeader ?? first.response?.headers.get("link") ?? null,
    );
    while (nextUrl) {
      const url = new URL(nextUrl);
      const next = await apiRequest<T[]>({
        method: "GET",
        path: `${url.pathname}${url.search}`,
        token: args.token,
      });
      if (Array.isArray(next.data)) out.push(...next.data);
      nextUrl = parseNextGitHubLink(next.linkHeader ?? next.response?.headers.get("link") ?? null);
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
        invalidateStatusCache();
      }
      const [origin, inventory] = await Promise.all([
        readGitOriginAsync(projectRoot),
        readCredentialInventoryAsync(),
      ]);
      const repo = parseGitHubRepoFromRemoteUrl(origin ?? "");
      const hasOrigin = Boolean(origin);
      const binding = `${githubCredentialInventoryKey(inventory.candidates)}:${repo?.owner ?? ""}/${repo?.name ?? ""}`;
      const now = Date.now();
      if (
        !opts.forceRefresh
        && cachedStatus
        && cachedStatusBinding === binding
        && now - cachedAt < 30_000
      ) {
        const cachedReadCandidate = cachedStatus.authSource === "none"
          ? null
          : inventory.candidates.find(
              (candidate) => candidate.source === cachedStatus?.authSource,
            ) ?? null;
        const cachedWriteSource = cachedStatus.writeAuthSource
          && cachedStatus.writeAuthSource !== "none"
          ? cachedStatus.writeAuthSource
          : null;
        const cachedWriteCandidate = cachedWriteSource == null
          ? null
          : inventory.candidates.find((candidate) => candidate.source === cachedWriteSource) ?? null;
        const cachedReadUnavailable = cachedStatus.authSource !== "none"
          && (!cachedReadCandidate || githubCredentialCooldown(
            cachedReadCandidate,
            now,
            { resource: "core" },
          ) != null);
        const cachedWriteUnavailable = cachedWriteSource != null
          && (!cachedWriteCandidate || githubCredentialCooldown(
            cachedWriteCandidate,
            now,
            { resource: "core" },
          ) != null);
        if (!cachedReadUnavailable && !cachedWriteUnavailable) {
          const readCandidates = githubOperationCredentialCandidates(inventory.candidates, "read");
          const pauseUntilMs = githubBackgroundRequestPauseUntilMs(now, readCandidates);
          return {
            ...cachedStatus,
            repo,
            hasOrigin,
            patTokenStored: inventory.patTokenStored,
            ghCliPath: inventory.ghCliPath ?? cachedStatus.ghCliPath,
            ghAuthError: inventory.ghAuthError,
            credentialStates: githubCredentialStates({
              candidates: inventory.candidates,
              availableSources: inventory.availableSources,
              activeReadSource: cachedStatus.authSource === "none"
                ? null
                : cachedStatus.authSource,
              activeWriteSource: cachedWriteSource,
            }),
            backgroundRefreshPausedUntil: pauseUntilMs == null
              ? null
              : new Date(pauseUntilMs).toISOString(),
          };
        }
        cachedStatus = null;
        cachedAt = 0;
        cachedStatusBinding = null;
      }
      const generation = statusLookupGeneration;
      if (
        statusLookupInFlight?.generation === generation
        && statusLookupInFlight.binding === binding
      ) {
        return await statusLookupInFlight.promise;
      }

      const lookup = (async (): Promise<HeadlessGitHubStatus> => {
        const readCandidates = githubOperationCredentialCandidates(inventory.candidates, "read");
        const writeCandidates = githubOperationCredentialCandidates(inventory.candidates, "write");
        const statusCooldown = (candidate: HeadlessGitHubTokenCandidate) => opts.forceRefresh === true
          ? githubCredentialRateLimitCooldown(candidate, Date.now(), { resource: "core" })
          : githubCredentialCooldown(candidate, Date.now(), { resource: "core" });
        const primaryCandidate = readCandidates[0] ?? null;
        if (!primaryCandidate) {
          return {
            tokenStored: false,
            patTokenStored: inventory.patTokenStored,
            tokenDecryptionFailed,
            storageScope: "app",
            authSource: "none",
            writeAuthSource: "none",
            tokenType: "unknown",
            repo,
            hasOrigin,
            userLogin: null,
            scopes: [],
            ghCliPath: inventory.ghCliPath,
            ghAuthError: inventory.ghAuthError,
            checkedAt: null,
            authFailure: null,
            rateLimit: null,
            credentialStates: githubCredentialStates({
              candidates: inventory.candidates,
              availableSources: inventory.availableSources,
              activeReadSource: null,
              activeWriteSource: null,
            }),
            credentialFallback: null,
            backgroundRefreshPausedUntil: null,
            repoAccessOk: null,
            repoAccessError: null,
            connected: false,
          };
        }

        const { active, activeWriteSource, failures } = await resolveGithubStatusCredentials({
          readCandidates,
          writeCandidates,
          cooldown: statusCooldown,
          probe: (candidate) => probeCandidate(candidate, repo, opts.forceRefresh === true),
          capabilities: (candidate, value) => validatedCredentialCapabilities(
            candidate,
            value,
            repo,
          ),
          isRepositoryAccessFailure: (result) => result.authFailure.kind === "permission_denied"
            && result.value?.repoAccessOk === false,
          onAuthenticatedProbe: (candidate, value) => {
            registerGithubCredentialIdentity(candidate, value.validated.userLogin);
          },
          onUsableProbe: (candidate, value) => {
            recordGithubCredentialProbeSuccess(
              candidate,
              value.validated.rateLimit,
              value.validated.userLogin,
            );
          },
          onRejectedProbe: (candidate, result, context) => {
            if (!context.repositoryAccessFailure) {
              recordGithubCredentialFailure(candidate, result.authFailure, result.rateLimit);
            }
            if (context.phase === "read") {
              logger.warn("github.token_validation_failed", {
                source: candidate.source,
                error: result.error,
                kind: result.authFailure.kind,
                retryAt: result.authFailure.retryAt,
              });
            }
          },
        });
        const pauseUntilMs = githubBackgroundRequestPauseUntilMs(Date.now(), readCandidates);
        if (active) {
          const { candidate, value } = active;
          const { validated, repoAccessOk, repoAccessError } = value;
          return {
            tokenStored: true,
            patTokenStored: inventory.patTokenStored,
            tokenDecryptionFailed: false,
            storageScope: "app",
            authSource: candidate.source,
            writeAuthSource: activeWriteSource ?? "none",
            tokenType: validated.tokenType,
            repo,
            hasOrigin,
            userLogin: validated.userLogin,
            scopes: validated.scopes,
            ghCliPath: inventory.ghCliPath,
            ghAuthError: inventory.ghAuthError,
            checkedAt: new Date(now).toISOString(),
            authFailure: null,
            rateLimit: validated.rateLimit,
            credentialStates: githubCredentialStates({
              candidates: inventory.candidates,
              availableSources: inventory.availableSources,
              activeReadSource: candidate.source,
              activeWriteSource,
            }),
            credentialFallback: failures[0] && failures[0].candidate.source !== candidate.source
              ? {
                  capability: "read",
                  fromSource: failures[0].candidate.source,
                  toSource: candidate.source,
                  reason: failures[0].authFailure.kind,
                  retryAt: failures[0].authFailure.retryAt,
                }
              : null,
            backgroundRefreshPausedUntil: pauseUntilMs == null
              ? null
              : new Date(pauseUntilMs).toISOString(),
            repoAccessOk,
            repoAccessError,
            connected: validatedCredentialCapabilities(candidate, value, repo).read,
          };
        }

        const failure = failures.find((entry) => entry.authFailure.kind === "rate_limited")
          ?? failures[0]
          ?? {
            candidate: primaryCandidate,
            error: "GitHub authentication could not be verified.",
            authFailure: classifyGitHubAuthFailure({ message: "GitHub authentication could not be verified." }).authFailure,
            rateLimit: null,
          };
        return {
          tokenStored: true,
          patTokenStored: inventory.patTokenStored,
          tokenDecryptionFailed: false,
          storageScope: "app",
          authSource: primaryCandidate.source,
          writeAuthSource: "none",
          tokenType: getTokenType(primaryCandidate.token),
          repo,
          hasOrigin,
          userLogin: null,
          scopes: [],
          ghCliPath: inventory.ghCliPath,
          ghAuthError: inventory.ghAuthError,
          checkedAt: new Date(now).toISOString(),
          authFailure: failure.authFailure,
          rateLimit: failure.rateLimit,
          credentialStates: githubCredentialStates({
            candidates: inventory.candidates,
            availableSources: inventory.availableSources,
            activeReadSource: null,
            activeWriteSource: null,
          }),
          credentialFallback: null,
          backgroundRefreshPausedUntil: pauseUntilMs == null
            ? null
            : new Date(pauseUntilMs).toISOString(),
          repoAccessOk: null,
          repoAccessError: null,
          connected: false,
        };
      })();
      statusLookupInFlight = { generation, binding, promise: lookup };
      try {
        const status = await lookup;
        if (statusLookupGeneration === generation) {
          cachedStatus = status;
          cachedAt = Date.now();
          cachedStatusBinding = binding;
        }
        return status;
      } finally {
        if (statusLookupInFlight?.promise === lookup) {
          statusLookupInFlight = null;
        }
      }
    },
    async getBackgroundRequestPauseUntilMs() {
      const inventory = await readCredentialInventoryAsync();
      return githubBackgroundRequestPauseUntilMs(
        Date.now(),
        githubOperationCredentialCandidates(inventory.candidates, "read"),
      );
    },
    async getRemoteStatus() {
      const origin = await readGitOriginAsync(projectRoot);
      return {
        repo: parseGitHubRepoFromRemoteUrl(origin ?? ""),
        hasOrigin: Boolean(origin),
      };
    },
    async detectRepo() {
      return detectGitHubRepoAsync(projectRoot);
    },
    async getAppInstallationStatus(args = {}) {
      const owner = args.owner?.trim();
      const name = args.name?.trim();
      const repo = owner && name ? { owner, name } : await detectGitHubRepoAsync(projectRoot);
      const githubAppUserToken = await appUserAuth.getValidTokenForRelay().catch(() => null);
      const accountAccessToken = options.getAccountAccessToken
        ? await options.getAccountAccessToken().catch(() => null)
        : null;
      return fetchGitHubAppInstallationStatus({
        repo,
        secretReader: options.githubRelaySecretReader,
        forceRefresh: args.forceRefresh === true,
        githubAppUserToken,
        accountAccessToken,
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
      const previousToken = appUserAuth.getStoredTokenForHealth();
      const result = await appUserAuth.pollDeviceAuth(args);
      if (result.status === "authorized") {
        const currentToken = appUserAuth.getStoredTokenForHealth();
        if (previousToken) clearGithubCredentialHealth(previousToken);
        if (currentToken && currentToken !== previousToken) clearGithubCredentialHealth(currentToken);
        invalidateStatusCache();
      }
      return result;
    },
    clearAppUserAuth(): GitHubAppUserAuthStatus {
      const previousToken = appUserAuth.getStoredTokenForHealth();
      const status = appUserAuth.clearAuth();
      if (previousToken) clearGithubCredentialHealth(previousToken);
      invalidateStatusCache();
      return status;
    },
    async getRepoOrThrow() {
      const repo = await detectGitHubRepoAsync(projectRoot);
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
    async getTokenOrThrowAsync() {
      const token = (await readTokenAsync("write")).token ?? "";
      if (!token) {
        throw new Error(
          "GitHub write access is unavailable. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, connect GitHub CLI, or add a PAT in Settings.",
        );
      }
      return token;
    },
    async getReadTokenOrThrowAsync() {
      const token = (await readTokenAsync("read")).token ?? "";
      if (!token) {
        throw new Error(
          "GitHub auth missing. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, run `gh auth login -h github.com -s repo -s workflow`, or add a PAT in Settings.",
        );
      }
      return token;
    },
    async getGitTransportTokenOrThrowAsync() {
      const token = (await readGitTransportTokenAsync()).token ?? "";
      if (!token) {
        throw new Error(
          "GitHub auth missing. Set ADE_GITHUB_TOKEN/GITHUB_TOKEN, run `gh auth login -h github.com -s repo -s workflow`, or add a PAT in Settings.",
        );
      }
      return token;
    },
    async getAppUserTokenForRelay() {
      return await appUserAuth.getValidTokenForRelay();
    },
    parseGitHubRepoFromRemoteUrl,
    parseNextLink: parseNextGitHubLink,
    setToken(nextToken: string) {
      const clean = nextToken.trim();
      const previousToken = readStoredPatToken();
      tokenOverride = clean || null;
      if (clean) {
        credentialStore.setSync(tokenKey, clean);
      } else {
        credentialStore.deleteSync(tokenKey);
      }
      tokenDecryptionFailed = false;
      if (previousToken) clearGithubCredentialHealth(previousToken);
      if (clean && clean !== previousToken) clearGithubCredentialHealth(clean);
      invalidateStatusCache();
      emitStatusChanged();
    },
    clearToken() {
      const previousToken = readStoredPatToken();
      tokenOverride = null;
      credentialStore.deleteSync(tokenKey);
      tokenDecryptionFailed = false;
      if (previousToken) clearGithubCredentialHealth(previousToken);
      invalidateStatusCache();
      emitStatusChanged();
    },
    requestRawWithCredentialFallback,
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
      const token = (await readTokenAsync()).token ?? "";
      if (!token) {
        const err = new Error(
          "GitHub is not connected. Run `gh auth login -h github.com -s repo -s workflow` or add a PAT in Settings.",
        ) as Error & { code?: string };
        err.code = "github_not_connected";
        throw err;
      }

      const existingRemote = await runGitHeadlessAsync(
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

      const cleanupLocalOrigin = async (): Promise<void> => {
        await runGitHeadlessAsync(projectRoot, ["remote", "remove", "origin"], 8_000);
      };

      const remoteAddRes = await runGitHeadlessAsync(
        projectRoot,
        ["remote", "add", "origin", created.cloneUrl],
        8_000,
      );
      if (remoteAddRes.exitCode !== 0) {
        await cleanupLocalOrigin();
        throw new Error(
          `Failed to add origin remote: ${remoteAddRes.stderr.trim() || `exit ${remoteAddRes.exitCode}`}`,
        );
      }

      const headRes = await runGitHeadlessAsync(
        projectRoot,
        ["rev-parse", "--verify", "HEAD"],
        5_000,
      );
      let resultState: "pushed" | "remote_added";
      if (headRes.exitCode === 0) {
        const pushRes = await runGitHeadlessAsync(
          projectRoot,
          ["push", "-u", "origin", "HEAD"],
          5 * 60_000,
        );
        if (pushRes.exitCode !== 0) {
          await cleanupLocalOrigin();
          throw new Error(
            `Failed to push to origin: ${pushRes.stderr.trim() || `exit ${pushRes.exitCode}`}`,
          );
        }
        resultState = "pushed";
      } else {
        resultState = "remote_added";
      }

      invalidateStatusCache();

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
        // The bundled ADE app client makes OAuth always available; a custom
        // client (if configured) takes precedence over it.
        oauthConfigured: true,
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
      // Resolution order lives in readOAuthClientCredentials: user-configured
      // client, then the bundled ADE Linear app (PKCE — no secret ships).
      return readOAuthClientCredentials();
    },
    getOAuthClientSource(): LinearOAuthClientSource {
      // Compare by client id, not by which branch resolved: the bundled id is
      // the ADE app even when a user pasted it in as a "custom" client.
      return readOAuthClientCredentials()?.clientId === BUNDLED_LINEAR_OAUTH_CLIENT_ID ? "ade-app" : "custom";
    },
    ensureFreshToken,
  };
}

function createHeadlessAgentChatService(
  projectRoot: string,
  githubService: HeadlessGitHubService,
  linearIssueTracker: ReturnType<typeof createLinearIssueTracker>,
): HeadlessLinearServices["agentChatService"] {
  const sessions = new Map<string, HeadlessAgentChatSession>();
  const identitySessionIds = new Map<string, string>();
  const transcripts = new Map<string, HeadlessTranscriptEntry[]>();

  const HEADLESS_MODEL_ID = "openai/gpt-5.6-sol";

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
    resolveSmartLinkPreview: ({ url }: { url: string }) => resolveSmartLinkPreview({
      url,
      githubService,
      linearIssueTracker,
    }),
    async listSessions() {
      return Array.from(sessions.values()).sort(
        (left, right) =>
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
      );
    },
    async getSessionSummary(sessionId: string) {
      return sessions.get(sessionId.trim()) ?? null;
    },
    async getCtoAttention() {
      // The `cto_state.getAttention` action calls this unconditionally
      // (`runtime.agentChatService?.getCtoAttention()` only guards a null
      // service, not a missing method), so the headless runtime must answer or
      // `ade actions run cto_state.getAttention` throws a TypeError. Headless
      // sessions never block on user input — there is no turn loop to block —
      // so "not waiting" is the truthful answer, not a placeholder.
      return { awaitingInput: false, since: null };
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
    async getChatTranscriptPage({
      sessionId,
      beforeOffset,
      limit,
      maxChars,
      signal,
    }: {
      sessionId: string;
      beforeOffset?: number;
      limit?: number;
      maxChars?: number;
      signal?: AbortSignal;
    }) {
      signal?.throwIfAborted();
      const source = ensureTranscript(sessionId.trim());
      const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit ?? 200)));
      const safeMaxChars = Math.max(
        200,
        Math.min(2_000_000, Math.floor(maxChars ?? 600_000)),
      );
      const end = Math.max(
        0,
        Math.min(
          source.length,
          typeof beforeOffset === "number" && Number.isFinite(beforeOffset)
            ? Math.floor(beforeOffset)
            : source.length,
        ),
      );
      const byLimit = source.slice(Math.max(0, end - safeLimit), end);
      const newestFirst: typeof byLimit = [];
      let remainingChars = safeMaxChars;
      let contentTruncated = false;
      for (let index = byLimit.length - 1; index >= 0; index -= 1) {
        signal?.throwIfAborted();
        const entry = byLimit[index]!;
        if (remainingChars <= 0) {
          contentTruncated = true;
          break;
        }
        if (entry.text.length > remainingChars) contentTruncated = true;
        newestFirst.push({
          ...entry,
          text: clipText(entry.text, remainingChars),
        });
        remainingChars -= Math.min(entry.text.length, remainingChars);
      }
      const entries = newestFirst.reverse();
      const nextCursor = end - entries.length;
      return {
        sessionId,
        entries,
        truncated: nextCursor > 0 || contentTruncated || entries.length < byLimit.length,
        totalEntries: source.length,
        nextCursor: nextCursor > 0 ? nextCursor : null,
        cursorKind: "index" as const,
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
    async cancelSteer(args: {
      sessionId: string;
      steerId: string;
      requireQueued?: boolean;
    }) {
      // `steerMessage` appends immediately and reports `queued: false`, so a
      // headless steer is never sitting in a queue to pull back. This mirrors
      // the desktop service's "no live runtime" branch exactly: reject only
      // when the caller demanded the steer still be queued.
      if (args.requireQueued) throw new Error("This message is no longer queued.");
      touchSession(args.sessionId);
    },
    async listSubagents(_args: { sessionId: string }) {
      // No turn loop, so no sub-agents are ever tracked. Empty is the truthful
      // answer, not a placeholder.
      return [] as never[];
    },
    async approveToolUse(args: {
      sessionId: string;
      itemId: string;
      decision: "accept" | "accept_for_session" | "decline" | "cancel";
      responseText?: string | null;
    }) {
      // Headless sessions never emit approval requests, so any itemId a caller
      // passes is unresolvable. Throw rather than silently succeed — a caller
      // that believes it approved a tool use would be wrong.
      throw new Error(
        `No pending approval found for item '${args.itemId}' (headless chat runtime raises no approvals).`,
      );
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
      getAccountAccessToken: args.getAccountAccessToken,
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
  const agentChatService = createHeadlessAgentChatService(
    args.projectRoot,
    githubService,
    issueTracker,
  );

  return {
    linearCredentialService,
    githubService,
    linearClient,
    linearIssueTracker: issueTracker,
    fileService,
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
    },
  };
}
