import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safeStorage } from "electron";
import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import type {
  GitHubAuthFailure,
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubAutolink,
  GitHubRateLimitState,
  GitHubRepoRef,
  GitHubStatus,
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { parseGithubRemoteUrl } from "../../../shared/githubRemote";
import { getGitHubTokenAccessState, parseGitHubScopeHeaders } from "../../../shared/githubScopes";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import {
  githubOperationCredentialCandidates,
  selectGithubOperationCredential,
  type GithubOperationCredentialCapability,
} from "../../../shared/githubOperationCredential";
import { mergePathEntries, resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import { fetchGitHubAppInstallationStatus, type GitHubRelaySecretReader } from "./githubRelayConfig";
import { createGitHubAppUserAuthService } from "./githubAppUserAuthService";
import { GITHUB_REST_API_VERSION } from "./githubApiVersion";
import {
  classifyGitHubAuthFailure,
  classifyGitHubGraphqlCredentialFailure,
  GitHubRateLimitError,
  githubRateLimitResourceForPath,
  githubRateLimitRetryAtMs,
  isTransientGithubProbeFailure,
  readGitHubRateLimitState,
} from "./githubRateLimit";
import {
  clearGithubCredentialHealth,
  githubBackgroundRequestPauseUntilMs,
  githubCredentialCooldown,
  githubCredentialStates,
  githubCredentialTokenDigest,
  recordGithubCredentialFailure,
  recordGithubCredentialProbeSuccess,
  recordGithubCredentialSuccess,
  registerGithubCredentialIdentity,
  type GithubCredentialCandidate,
} from "./githubCredentialHealth";

import { nowIso, asString } from "../shared/utils";

export { fetchAdeLatestRelease } from "./adeReleaseFeed";

const AUTH_STORE_FILE_NAME = "github-token.v1.bin";
const MACHINE_TOKEN_KEY = "github.token.v1";
const GITHUB_API_TIMEOUT_MS = 20_000;
export const GITHUB_API_BODY_TIMEOUT_MS = 30_000;
const GH_AUTH_TOKEN_CACHE_TTL_MS = 30_000;
const GH_HOSTS_TOKEN_CACHE_MAX_ENTRIES = 32;
const GITHUB_STATUS_FAILURE_COOLDOWN_MS = 30_000;
const execFileAsync = promisify(execFile);
const processGhHostsTokenCache = new Map<string, { expiresAt: number; token: string | null }>();

function cacheGhHostsToken(hostsPath: string, token: string | null): void {
  processGhHostsTokenCache.delete(hostsPath);
  processGhHostsTokenCache.set(hostsPath, {
    expiresAt: Date.now() + GH_AUTH_TOKEN_CACHE_TTL_MS,
    token,
  });
  while (processGhHostsTokenCache.size > GH_HOSTS_TOKEN_CACHE_MAX_ENTRIES) {
    const oldest = processGhHostsTokenCache.keys().next().value as string | undefined;
    if (!oldest) break;
    processGhHostsTokenCache.delete(oldest);
  }
}

type GitHubAuthSource = GitHubStatus["authSource"];

type GitHubCliAuthResult = {
  token: string | null;
  ghCliPath: string | null;
  ghAuthError: string | null;
};

type GitHubCliAuthProvider = () => GitHubCliAuthResult | Promise<GitHubCliAuthResult>;

type SharedGithubStatusProbe = {
  validated: {
    userLogin: string | null;
    scopes: string[];
    tokenType: GitHubStatus["tokenType"];
    rateLimit: GitHubRateLimitState | null;
  };
  repoAccessOk: boolean | null;
  repoAccessError: string | null;
};

type SharedGithubStatusProbeResult =
  | { ok: true; value: SharedGithubStatusProbe }
  | {
      ok: false;
      error: string;
      authFailure: GitHubAuthFailure;
      rateLimit: GitHubRateLimitState | null;
      value?: SharedGithubStatusProbe;
    };

type ProcessGithubAuthState = {
  authCache: (GitHubCliAuthResult & { expiresAt: number }) | null;
  authInFlight: Promise<GitHubCliAuthResult> | null;
  statusCache: Map<string, { expiresAt: number; result: SharedGithubStatusProbeResult }>;
  statusInFlight: Map<string, Promise<SharedGithubStatusProbeResult>>;
};

const processGithubAuthStates = new WeakMap<GitHubCliAuthProvider, ProcessGithubAuthState>();

class GitHubTokenValidationError extends Error {
  constructor(
    message: string,
    readonly authFailure: GitHubAuthFailure,
    readonly rateLimit: GitHubRateLimitState | null,
  ) {
    super(message);
    this.name = "GitHubTokenValidationError";
  }
}

function processGithubAuthState(provider: GitHubCliAuthProvider): ProcessGithubAuthState {
  const existing = processGithubAuthStates.get(provider);
  if (existing) return existing;
  const created: ProcessGithubAuthState = {
    authCache: null,
    authInFlight: null,
    statusCache: new Map(),
    statusInFlight: new Map(),
  };
  processGithubAuthStates.set(provider, created);
  return created;
}

function githubStatusProbeKey(token: string, repo: GitHubRepoRef | null): string {
  const tokenDigest = githubCredentialTokenDigest(token);
  return `${tokenDigest}:${repo ? `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}` : "no-repo"}`;
}

type GitHubTokenLookup = GitHubCliAuthResult & {
  source: GitHubAuthSource;
  patTokenStored: boolean;
};

type GitHubTokenCandidate = GitHubTokenLookup & GithubCredentialCandidate & {
  token: string;
};

type GitHubCredentialInventory = {
  candidates: GitHubTokenCandidate[];
  availableSources: Set<GitHubTokenCandidate["source"]>;
  patTokenStored: boolean;
  ghCliPath: string | null;
  ghAuthError: string | null;
};

class GithubCredentialAttemptError extends Error {
  constructor(
    message: string,
    readonly authFailure: GitHubAuthFailure,
    readonly rateLimit: GitHubRateLimitState | null,
  ) {
    super(message);
    this.name = "GithubCredentialAttemptError";
  }
}

/**
 * Read the gh CLI's stored oauth token directly from its hosts.yml. gh keeps
 * file-based tokens here (keychain-stored ones won't appear — those need the
 * gh binary). This is the only auth path that works reliably in headless
 * contexts (the launchd brain) where spawning gh has proven fragile.
 */
function readGhHostsFileToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const configDir = env.GH_CONFIG_DIR?.trim()
    || path.join(env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "gh");
  const hostsPath = path.join(configDir, "hosts.yml");
  const cached = processGhHostsTokenCache.get(hostsPath);
  if (cached && cached.expiresAt > Date.now()) {
    processGhHostsTokenCache.delete(hostsPath);
    processGhHostsTokenCache.set(hostsPath, cached);
    return cached.token;
  }
  try {
    const raw = fs.readFileSync(hostsPath, "utf8");
    const lines = raw.split(/\r?\n/);
    let inGithubHost = false;
    for (const line of lines) {
      if (/^\S/.test(line)) {
        inGithubHost = /^github\.com\s*:/.test(line.trim());
        continue;
      }
      if (!inGithubHost) continue;
      const match = line.match(/^\s+oauth_token\s*:\s*(\S+)\s*$/);
      if (match) {
        const token = match[1].replace(/^["']|["']$/g, "").trim();
        if (token) {
          cacheGhHostsToken(hostsPath, token);
          return token;
        }
      }
    }
  } catch {
    // No hosts.yml or unreadable — fall through.
  }
  cacheGhHostsToken(hostsPath, null);
  return null;
}

async function readGitHubCliAuthToken(): Promise<GitHubCliAuthResult> {
  if (process.env.ADE_DISABLE_GH_AUTH_FALLBACK === "1") {
    return { token: null, ghCliPath: null, ghAuthError: null };
  }

  const hostsToken = readGhHostsFileToken();
  if (hostsToken) {
    return { token: hostsToken, ghCliPath: null, ghAuthError: null };
  }

  const resolved = resolveExecutableFromKnownLocations("gh");
  if (!resolved?.path) {
    return {
      token: null,
      ghCliPath: null,
      ghAuthError: "GitHub CLI was not found. Install gh or add a personal access token.",
    };
  }

  try {
    const { stdout } = await execFileAsync(resolved.path, ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        PATH: mergePathEntries(process.env.PATH, path.dirname(resolved.path)),
      },
    });
    const token = stdout.trim();
    if (token.length > 0) {
      return { token, ghCliPath: resolved.path, ghAuthError: null };
    }
    const hostsToken = readGhHostsFileToken();
    if (hostsToken) {
      return { token: hostsToken, ghCliPath: resolved.path, ghAuthError: null };
    }
    return {
      token: null,
      ghCliPath: resolved.path,
      ghAuthError: "GitHub CLI is installed, but `gh auth token` did not return a token.",
    };
  } catch (error) {
    const hostsToken = readGhHostsFileToken();
    if (hostsToken) {
      return { token: hostsToken, ghCliPath: resolved.path, ghAuthError: null };
    }
    return {
      token: null,
      ghCliPath: resolved.path,
      ghAuthError: error instanceof Error ? error.message : String(error),
    };
  }
}

const githubResponseCleanup = new WeakMap<Response, () => void>();

function githubRequestTimeoutError(phase: "request" | "response body"): Error {
  return new Error(
    `GitHub API ${phase} timed out. Check network access on this machine.`,
  );
}

function wrapGitHubResponseBody(args: {
  response: Response;
  controller: AbortController;
  cleanupUpstreamAbort: () => void;
}): Response {
  let settled = false;
  let timeoutError: Error | null = null;
  const pendingRejects = new Set<(error: Error) => void>();
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    args.controller.signal.removeEventListener("abort", onAbort);
    args.cleanupUpstreamAbort();
    githubResponseCleanup.delete(args.response);
  };
  const onAbort = (): void => {
    const error = timeoutError
      ?? (args.controller.signal.reason instanceof Error
        ? args.controller.signal.reason
        : new Error("GitHub API request aborted."));
    for (const reject of pendingRejects) reject(error);
    pendingRejects.clear();
    finish();
  };
  const timer = setTimeout(() => {
    timeoutError = githubRequestTimeoutError("response body");
    args.controller.abort(timeoutError);
  }, GITHUB_API_BODY_TIMEOUT_MS);
  timer.unref?.();
  args.controller.signal.addEventListener("abort", onAbort, { once: true });

  const wrapBodyReader = <T>(read: () => Promise<T>): (() => Promise<T>) =>
    async (): Promise<T> => {
      if (timeoutError) throw timeoutError;
      if (args.controller.signal.aborted) {
        throw args.controller.signal.reason instanceof Error
          ? args.controller.signal.reason
          : new Error("GitHub API request aborted.");
      }
      return await new Promise<T>((resolve, reject) => {
        const rejectPending = (error: Error): void => reject(error);
        pendingRejects.add(rejectPending);
        Promise.resolve()
          .then(read)
          .then(
            (value) => {
              pendingRejects.delete(rejectPending);
              finish();
              resolve(value);
            },
            (error) => {
              pendingRejects.delete(rejectPending);
              finish();
              reject(error);
            },
          );
      });
    };

  for (const method of ["arrayBuffer", "blob", "formData", "json", "text"] as const) {
    const original = args.response[method];
    if (typeof original !== "function") continue;
    Object.defineProperty(args.response, method, {
      configurable: true,
      value: wrapBodyReader(original.bind(args.response) as () => Promise<unknown>),
    });
  }
  githubResponseCleanup.set(args.response, finish);
  return args.response;
}

function releaseGitHubResponse(response: Response): void {
  githubResponseCleanup.get(response)?.();
  void response.body?.cancel().catch(() => {});
}

async function fetchGitHub(input: string | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const onUpstreamAbort = (): void => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) onUpstreamAbort();
  else upstreamSignal?.addEventListener("abort", onUpstreamAbort, { once: true });
  const cleanupUpstreamAbort = (): void => {
    upstreamSignal?.removeEventListener("abort", onUpstreamAbort);
  };
  let headerTimedOut = false;
  const timer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort(githubRequestTimeoutError("request"));
  }, GITHUB_API_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return wrapGitHubResponseBody({
      response,
      controller,
      cleanupUpstreamAbort,
    });
  } catch (error) {
    cleanupUpstreamAbort();
    if (headerTimedOut) {
      throw githubRequestTimeoutError("request");
    }
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function detectGitHubTokenType(token: string): GitHubStatus["tokenType"] {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  if (/^gh[ousr]_/.test(token)) return "oauth";
  return "unknown";
}

export function parseGitHubRepoFromRemoteUrl(remoteUrlRaw: string): GitHubRepoRef | null {
  const repo = parseGithubRemoteUrl(remoteUrlRaw);
  return repo ? { owner: repo.owner, name: repo.repo } : null;
}

function repoIdentityFromGitHubResponse(
  data: Record<string, unknown>,
  fallbackOwner: string,
  fallbackName: string,
): { owner: string; name: string; fullName: string } {
  const fullName = asString(data.full_name).trim();
  const fullNameParts = fullName.split("/");
  const repoFromFullName = fullNameParts.length >= 2
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

function readOriginUrlFromConfig(configPath: string): string | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf8");
    let inOriginSection = false;
    for (const line of raw.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (section) {
        inOriginSection = /^remote\s+"origin"$/i.test(section[1]?.trim() ?? "");
        continue;
      }
      if (!inOriginSection) continue;
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (url?.[1]?.trim()) return url[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

function resolveGitDir(projectRoot: string): string | null {
  try {
    const gitPath = path.join(projectRoot, ".git");
    if (!fs.existsSync(gitPath)) return null;
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return null;
    const raw = fs.readFileSync(gitPath, "utf8");
    const match = raw.match(/^gitdir:\s*(.+)\s*$/im);
    if (!match?.[1]) return null;
    return path.resolve(projectRoot, match[1].trim());
  } catch {
    return null;
  }
}

function resolveCommonGitDir(gitDir: string): string {
  try {
    const commonDirPath = path.join(gitDir, "commondir");
    if (!fs.existsSync(commonDirPath)) return gitDir;
    const raw = fs.readFileSync(commonDirPath, "utf8").trim();
    if (!raw) return gitDir;
    return path.resolve(gitDir, raw);
  } catch {
    return gitDir;
  }
}

function readOriginUrlFromGitConfig(projectRoot: string): string | null {
  const gitDir = resolveGitDir(projectRoot);
  if (!gitDir) return null;
  const commonGitDir = resolveCommonGitDir(gitDir);
  return (
    readOriginUrlFromConfig(path.join(gitDir, "config.worktree")) ??
    readOriginUrlFromConfig(path.join(commonGitDir, "config")) ??
    readOriginUrlFromConfig(path.join(gitDir, "config"))
  );
}

export function parseNextLink(linkHeader: string | null): string | null {
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
  credentialStore,
  ghAuthTokenProvider,
  githubRelaySecretReader,
  getAccountAccessToken,
}: {
  logger: Logger;
  projectRoot: string;
  appDataDir: string;
  credentialStore?: SyncCredentialStore | null;
  ghAuthTokenProvider?: GitHubCliAuthProvider | null;
  githubRelaySecretReader?: GitHubRelaySecretReader | null;
  getAccountAccessToken?: (() => Promise<string | null>) | null;
}) {
  const legacyGithubStateDir = resolveAdeLayout(projectRoot).githubSecretsDir;
  const legacyTokenPath = path.join(legacyGithubStateDir, AUTH_STORE_FILE_NAME);
  const githubStateDir = path.join(appDataDir, "secrets", "github");
  const tokenPath = path.join(githubStateDir, AUTH_STORE_FILE_NAME);
  const appUserAuth = createGitHubAppUserAuthService({
    credentialStore,
    logger,
    fetchImpl: (input, init) => fetchGitHub(input, init ?? {}),
    userAgent: "ade-desktop",
  });

  let tokenDecryptionFailed = false;
  let machineTokenReadFailed = false;
  const ghAuthProvider = ghAuthTokenProvider ?? readGitHubCliAuthToken;
  const sharedGhAuth = processGithubAuthState(ghAuthProvider);
  let statusInFlight: Promise<GitHubStatus> | null = null;
  let cachedStatusTokenDigest: string | null = null;

  const readMachineToken = (): string | null => {
    if (!credentialStore) return null;
    try {
      const token = credentialStore.getSync(MACHINE_TOKEN_KEY)?.trim() ?? "";
      machineTokenReadFailed = false;
      return token.length > 0 ? token : null;
    } catch (error) {
      machineTokenReadFailed = true;
      logger.warn("github.machine_token_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const persistMachineToken = (token: string | null): void => {
    if (!credentialStore) return;
    try {
      const clean = (token ?? "").trim();
      if (clean) {
        credentialStore.setSync(MACHINE_TOKEN_KEY, clean);
      } else {
        credentialStore.deleteSync(MACHINE_TOKEN_KEY);
      }
      machineTokenReadFailed = false;
    } catch (error) {
      machineTokenReadFailed = true;
      logger.warn("github.machine_token_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const syncMachineToken = (token: string | null): void => {
    try {
      persistMachineToken(token);
    } catch {
      // persistMachineToken already logged the write failure.
    }
  };

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
      syncMachineToken(globalToken);
      tokenDecryptionFailed = false;
      migrationDone = true;
      return globalToken;
    }

    if (migrationDone) return null;

    const legacyToken = readEncryptedToken(legacyTokenPath);
    if (!legacyToken) { migrationDone = true; return null; }

    try {
      persistEncryptedToken(tokenPath, legacyToken);
      syncMachineToken(legacyToken);
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

  const readStoredPatToken = (): string | null => {
    const machineToken = readMachineToken();
    if (machineToken) {
      tokenDecryptionFailed = false;
      return machineToken;
    }
    const token = migrateLegacyTokenIfNeeded();
    if (token) return token;
    tokenDecryptionFailed = machineTokenReadFailed;
    return null;
  };

  const readEnvToken = (): string | null => {
    const envToken = (
      process.env.ADE_GITHUB_TOKEN ??
      process.env.GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      ""
    ).trim();
    return envToken.length > 0 ? envToken : null;
  };

  const readGhAuthToken = async (): Promise<GitHubCliAuthResult> => {
    if (process.env.ADE_DISABLE_GH_AUTH_FALLBACK === "1") {
      sharedGhAuth.authCache = null;
      return { token: null, ghCliPath: null, ghAuthError: null };
    }
    const now = Date.now();
    if (sharedGhAuth.authCache && sharedGhAuth.authCache.expiresAt > now) {
      return {
        token: sharedGhAuth.authCache.token,
        ghCliPath: sharedGhAuth.authCache.ghCliPath,
        ghAuthError: sharedGhAuth.authCache.ghAuthError,
      };
    }
    if (sharedGhAuth.authInFlight) return await sharedGhAuth.authInFlight;
    const work = Promise.resolve().then(() => ghAuthProvider());
    sharedGhAuth.authInFlight = work;
    try {
      const result = await work;
      sharedGhAuth.authCache = { ...result, expiresAt: Date.now() + GH_AUTH_TOKEN_CACHE_TTL_MS };
      return result;
    } finally {
      if (sharedGhAuth.authInFlight === work) sharedGhAuth.authInFlight = null;
    }
  };

  const readEnvironmentAuthToken = (): GitHubTokenLookup | null => {
    const envToken = readEnvToken();
    return envToken
      ? {
          token: envToken,
          source: "environment",
          patTokenStored: false,
          ghCliPath: null,
          ghAuthError: null,
        }
      : null;
  };

  const readPatAuthToken = (): GitHubTokenLookup | null => {
    const patToken = readStoredPatToken();
    return patToken
      ? {
          token: patToken,
          source: "pat",
          patTokenStored: true,
          ghCliPath: null,
          ghAuthError: null,
        }
      : null;
  };

  const readCredentialInventory = async (): Promise<GitHubCredentialInventory> => {
    const patLookup = readPatAuthToken();
    const patTokenStored = Boolean(patLookup);
    const environment = readEnvironmentAuthToken();
    const appStatus = appUserAuth.getAuthStatus();
    const [appToken, gh] = await Promise.all([
      appStatus.tokenStored
        ? appUserAuth.getValidTokenForRelay().catch(() => null)
        : Promise.resolve(null),
      readGhAuthToken(),
    ]);
    const candidates: GitHubTokenCandidate[] = [];
    if (environment?.token) {
      candidates.push({
        ...environment,
        token: environment.token,
        source: "environment",
        patTokenStored,
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
        ...gh,
        token: gh.token,
        source: "gh",
        patTokenStored,
        capabilities: ["read", "write"],
      });
    }
    if (patLookup?.token) {
      candidates.push({
        ...patLookup,
        token: patLookup.token,
        source: "pat",
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

  const readAuthToken = async (
    capability: GithubOperationCredentialCapability = "read",
  ): Promise<GitHubTokenLookup> => {
    const inventory = await readCredentialInventory();
    const candidates = githubOperationCredentialCandidates(inventory.candidates, capability);
    const selected = candidates.find((candidate) => !githubCredentialCooldown(
      candidate,
      Date.now(),
      { resource: "core" },
    ))
      ?? candidates[0]
      ?? null;
    return selected ?? {
      token: null,
      source: "none",
      patTokenStored: inventory.patTokenStored,
      ghCliPath: inventory.ghCliPath,
      ghAuthError: inventory.ghAuthError,
    };
  };

  const readAuthTokenSync = (): GitHubTokenLookup => {
    const patLookup = readPatAuthToken();
    const patTokenStored = Boolean(patLookup);
    let ghFallback: GitHubTokenLookup = {
      token: null,
      source: "none",
      patTokenStored,
      ghCliPath: null,
      ghAuthError: null,
    };
    return selectGithubOperationCredential<GitHubTokenLookup>({
      environment: () => {
        const environment = readEnvironmentAuthToken();
        return environment ? { ...environment, patTokenStored } : null;
      },
      app: () => null,
      gh: () => {
        if (process.env.ADE_DISABLE_GH_AUTH_FALLBACK === "1") {
          sharedGhAuth.authCache = null;
          return null;
        }
        const cachedGh = sharedGhAuth.authCache && sharedGhAuth.authCache.expiresAt > Date.now()
          ? sharedGhAuth.authCache
          : null;
        const hostsToken = cachedGh?.token ? null : readGhHostsFileToken();
        const gh: GitHubCliAuthResult = cachedGh ?? {
          token: hostsToken,
          ghCliPath: null,
          ghAuthError: hostsToken ? null : "GitHub auth has not been resolved yet.",
        };
        ghFallback = { ...gh, source: "none", patTokenStored };
        return gh.token ? { ...gh, source: "gh", patTokenStored } : null;
      },
      pat: () => patLookup,
    }, "write") ?? ghFallback;
  };

  const persistToken = (token: string | null): void => {
    persistEncryptedToken(tokenPath, token);
    persistMachineToken(token);
    if (!(token ?? "").trim()) {
      removeTokenFile(legacyTokenPath);
    } else if (fs.existsSync(legacyTokenPath)) {
      removeTokenFile(legacyTokenPath);
    }
  };

  const detectRepo = async (): Promise<GitHubRepoRef | null> => {
    const configOriginUrl = readOriginUrlFromGitConfig(projectRoot);
    if (configOriginUrl) {
      const repo = parseGitHubRepoFromRemoteUrl(configOriginUrl);
      if (repo) return repo;
    }
    const res = await runGit(["remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 8000 });
    if (res.exitCode !== 0) return null;
    return parseGitHubRepoFromRemoteUrl(res.stdout);
  };

  // Returns `{ repo, hasOrigin }` in one git invocation. `hasOrigin` is true
  // for ANY `origin` remote (GitLab/Bitbucket/etc.), while `repo` is populated
  // only when origin parses as GitHub. Callers use `hasOrigin` to hide the
  // Publish-to-GitHub CTA on projects with non-GitHub remotes.
  const detectOrigin = async (): Promise<{ repo: GitHubRepoRef | null; hasOrigin: boolean }> => {
    const configOriginUrl = readOriginUrlFromGitConfig(projectRoot);
    if (configOriginUrl) {
      const repo = parseGitHubRepoFromRemoteUrl(configOriginUrl);
      if (repo) return { repo, hasOrigin: true };
      // `git remote get-url` applies url.*.insteadOf rewrites that raw config
      // parsing cannot see, so fall through once before treating it as non-GitHub.
      const res = await runGit(["remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 8000 });
      if (res.exitCode !== 0) return { repo: null, hasOrigin: true };
      return { repo: parseGitHubRepoFromRemoteUrl(res.stdout), hasOrigin: true };
    }
    const res = await runGit(["remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 8000 });
    if (res.exitCode !== 0) return { repo: null, hasOrigin: false };
    const url = res.stdout.trim();
    if (!url) return { repo: null, hasOrigin: false };
    return { repo: parseGitHubRepoFromRemoteUrl(url), hasOrigin: true };
  };

  const validateToken = async (token: string): Promise<{
    userLogin: string | null;
    scopes: string[];
    tokenType: GitHubStatus["tokenType"];
    rateLimit: GitHubRateLimitState | null;
  }> => {
    const response = await fetchGitHub("https://api.github.com/user", {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "ade-desktop",
        "x-github-api-version": GITHUB_REST_API_VERSION,
      }
    });

    const scopes = parseGitHubScopeHeaders(response.headers);
    const rateLimit = readGitHubRateLimitState(response.headers);

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const msg = asString(payload.message) || `GitHub token validation failed (HTTP ${response.status})`;
      const failure = classifyGitHubAuthFailure({
        status: response.status,
        message: msg,
        headers: response.headers,
      });
      throw new GitHubTokenValidationError(msg, failure.authFailure, failure.rateLimit);
    }

    return {
      userLogin: asString(payload.login) || null,
      scopes,
      tokenType: detectGitHubTokenType(token),
      rateLimit,
    };
  };

  // Verifies the active token actually has access to the active repo by hitting
  // /repos/{owner}/{name} (cheapest endpoint that requires Metadata: Read on
  // fine-grained tokens; classic tokens with `repo` scope also pass). This is
  // the only reliable connectivity check for fine-grained tokens, which never
  // return x-oauth-scopes and so cannot be introspected via headers.
  const probeRepoAccess = async (
    token: string,
    repo: GitHubRepoRef,
  ): Promise<{
    ok: boolean;
    error: string | null;
    authFailure: GitHubAuthFailure | null;
    rateLimit: GitHubRateLimitState | null;
  }> => {
    try {
      const response = await fetchGitHub(
        `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
        {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "ade-desktop",
            "x-github-api-version": GITHUB_REST_API_VERSION,
          },
        },
      );
      if (response.ok) {
        releaseGitHubResponse(response);
        return {
          ok: true,
          error: null,
          authFailure: null,
          rateLimit: readGitHubRateLimitState(response.headers),
        };
      }
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message = asString(payload.message) || `HTTP ${response.status}`;
      const failure = classifyGitHubAuthFailure({
        status: response.status,
        message,
        headers: response.headers,
      });
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
      return {
        ok: false,
        error: `${response.status}: ${message}`,
        authFailure,
        rateLimit: failure.rateLimit,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = classifyGitHubAuthFailure({ message });
      return {
        ok: false,
        error: message,
        authFailure: failure.authFailure.kind === "unknown" ? null : failure.authFailure,
        rateLimit: failure.rateLimit,
      };
    }
  };

  const computeGithubStatusProbe = async (
    token: string,
    repo: GitHubRepoRef | null,
    authSource: GitHubStatus["authSource"],
  ): Promise<SharedGithubStatusProbeResult> => {
    try {
      const validated = await validateToken(token);
      let repoAccessOk: boolean | null = null;
      let repoAccessError: string | null = null;
      if (repo && (authSource === "app" || validated.tokenType === "fine-grained")) {
        const probe = await probeRepoAccess(token, repo);
        validated.rateLimit = probe.rateLimit ?? validated.rateLimit;
        if (probe.authFailure) {
          return {
            ok: false,
            error: probe.error ?? probe.authFailure.message,
            authFailure: probe.authFailure,
            rateLimit: probe.rateLimit,
            value: { validated, repoAccessOk: probe.ok, repoAccessError: probe.error },
          };
        }
        repoAccessOk = probe.ok;
        repoAccessError = probe.error;
      }
      return { ok: true, value: { validated, repoAccessOk, repoAccessError } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof GitHubTokenValidationError) {
        return {
          ok: false,
          error: message,
          authFailure: error.authFailure,
          rateLimit: error.rateLimit,
        };
      }
      const failure = classifyGitHubAuthFailure({ message });
      return {
        ok: false,
        error: message,
        authFailure: failure.authFailure,
        rateLimit: failure.rateLimit,
      };
    }
  };

  const readSharedGithubStatusProbe = async (
    token: string,
    repo: GitHubRepoRef | null,
    forceRefresh: boolean,
  ): Promise<SharedGithubStatusProbeResult> => {
    const key = githubStatusProbeKey(token, repo);
    if (forceRefresh) {
      const existing = sharedGhAuth.statusInFlight.get(key);
      if (existing) await existing.catch(() => {});
      const newer = sharedGhAuth.statusInFlight.get(key);
      if (newer && newer !== existing) return await newer;
      sharedGhAuth.statusCache.delete(key);
    } else {
      const cached = sharedGhAuth.statusCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.result;
      const inFlight = sharedGhAuth.statusInFlight.get(key);
      if (inFlight) return await inFlight;
    }

    const work = computeGithubStatusProbe(token, repo, "gh");
    sharedGhAuth.statusInFlight.set(key, work);
    try {
      const result = await work;
      let isNetworkFailure = false;
      if (!result.ok) {
        isNetworkFailure = isTransientGithubProbeFailure(result.error);
      } else if (result.value.repoAccessOk === false) {
        isNetworkFailure = isTransientGithubProbeFailure(result.value.repoAccessError);
      }
      sharedGhAuth.statusCache.set(key, {
        expiresAt: Date.now() + (isNetworkFailure
          ? GITHUB_STATUS_FAILURE_COOLDOWN_MS
          : GH_AUTH_TOKEN_CACHE_TTL_MS),
        result,
      });
      if (isNetworkFailure && sharedGhAuth.authCache?.token === token) {
        sharedGhAuth.authCache.expiresAt = Math.max(
          sharedGhAuth.authCache.expiresAt,
          Date.now() + GITHUB_STATUS_FAILURE_COOLDOWN_MS,
        );
      }
      while (sharedGhAuth.statusCache.size > 32) {
        const oldest = sharedGhAuth.statusCache.keys().next().value as string | undefined;
        if (!oldest) break;
        sharedGhAuth.statusCache.delete(oldest);
      }
      return result;
    } finally {
      if (sharedGhAuth.statusInFlight.get(key) === work) {
        sharedGhAuth.statusInFlight.delete(key);
      }
    }
  };

  // ETag cache for conditional GET requests. Responses that return 304 Not Modified
  // don't count against GitHub's rate limit, so this dramatically reduces API usage.
  const etagCache = new Map<string, { etag: string; data: unknown; linkHeader: string | null }>();
  const ETAG_CACHE_MAX_SIZE = 200;
  const inFlightConditionalGetKeys = new Set<string>();

  const evictOldestEtagCacheEntry = (protectedKeys: ReadonlySet<string>): void => {
    for (const key of etagCache.keys()) {
      if (protectedKeys.has(key)) continue;
      etagCache.delete(key);
      return;
    }
  };

  const apiRequest = async <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
    token?: string;
    capability?: GithubOperationCredentialCapability;
    /**
     * Override the default `Accept` header. Used to request GitHub schema
     * previews (e.g. `application/vnd.github.merge-info-preview+json` for the
     * GraphQL `mergeStateStatus` field). Ignored when blank.
     */
    accept?: string;
  }): Promise<{ data: T; response: Response | null; linkHeader?: string | null }> => {
    const capability = args.capability ?? (args.method === "GET" ? "read" : "write");
    const explicitToken = args.token?.trim() ?? "";
    const candidates: GitHubTokenCandidate[] = explicitToken
      ? [{
          token: explicitToken,
          source: "environment",
          patTokenStored: false,
          ghCliPath: null,
          ghAuthError: null,
          capabilities: [capability],
        }]
      : githubOperationCredentialCandidates(
          (await readCredentialInventory()).candidates,
          capability,
        );
    if (candidates.length === 0) {
      throw new Error("GitHub auth missing. Run `gh auth login -h github.com -s repo -s workflow` or add a personal access token in Settings.");
    }

    const baseUrl = "https://api.github.com";
    const url = new URL(`${baseUrl}${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }

    const accept = args.accept?.trim() || "application/vnd.github+json";
    const rateLimitResource = githubRateLimitResourceForPath(args.path);
    let firstUnavailable: {
      failure: GitHubAuthFailure;
      rateLimit: GitHubRateLimitState | null;
    } | null = null;
    let lastAttemptError: GithubCredentialAttemptError | null = null;

    for (const candidate of candidates) {
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
        "content-type": args.body != null ? "application/json" : "text/plain",
        "user-agent": "ade-desktop",
        "x-github-api-version": GITHUB_REST_API_VERSION,
      };
      let sentConditionalGet = false;
      if (args.method === "GET") {
        const cached = etagCache.get(cacheKey);
        if (cached) {
          headers["if-none-match"] = cached.etag;
          sentConditionalGet = true;
          inFlightConditionalGetKeys.add(cacheKey);
        }
      }

      let response: Response;
      try {
        response = await fetchGitHub(url.toString(), {
          method: args.method,
          headers,
          body: args.body != null ? JSON.stringify(args.body) : undefined,
        });
      } finally {
        if (sentConditionalGet) inFlightConditionalGetKeys.delete(cacheKey);
      }

      if (response.status === 304) {
        const cached = etagCache.get(cacheKey);
        if (cached) {
          recordGithubCredentialSuccess(candidate, response.headers);
          releaseGitHubResponse(response);
          return { data: cached.data as T, response, linkHeader: cached.linkHeader };
        }
      }

      const text = await response.text();
      let data: unknown = text;
      try {
        data = text.trim().length ? JSON.parse(text) : {};
      } catch {
        // Keep non-JSON response bodies for callers and error messages.
      }

      if (!response.ok) {
        const body = data && typeof data === "object" && !Array.isArray(data)
          ? data as Record<string, unknown>
          : null;
        const message = (body ? asString(body.message) : "")
          || `GitHub API request failed (HTTP ${response.status})`;
        const errorMessages = body && Array.isArray(body.errors)
          ? body.errors
              .map((error) => typeof error === "object" && error && "message" in error
                ? asString((error as { message?: unknown }).message)
                : "")
              .filter(Boolean)
          : [];
        const detail = errorMessages.length > 0 ? `: ${errorMessages.join("; ")}` : "";
        const failure = classifyGitHubAuthFailure({
          status: response.status,
          message,
          headers: response.headers,
        });
        recordGithubCredentialFailure(candidate, failure.authFailure, failure.rateLimit);
        const attemptError = new GithubCredentialAttemptError(
          message + detail,
          failure.authFailure,
          failure.rateLimit,
        );
        lastAttemptError = attemptError;
        const canTryNext = !args.token
          && (response.status === 401 || response.status === 403 || response.status === 429);
        if (canTryNext) continue;
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
        recordGithubCredentialFailure(
          candidate,
          graphqlFailure.authFailure,
          graphqlFailure.rateLimit,
        );
        const attemptError = new GithubCredentialAttemptError(
          graphqlFailure.message,
          graphqlFailure.authFailure,
          graphqlFailure.rateLimit,
        );
        lastAttemptError = attemptError;
        if (!args.token) continue;
        if (attemptError.authFailure.kind === "rate_limited") {
          const resetAtMs = githubRateLimitRetryAtMs(attemptError.authFailure, attemptError.rateLimit);
          throw new GitHubRateLimitError(attemptError.message, resetAtMs, attemptError.rateLimit);
        }
        throw attemptError;
      }

      recordGithubCredentialSuccess(candidate, response.headers);
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
          while (etagCache.size >= ETAG_CACHE_MAX_SIZE && !etagCache.has(cacheKey)) {
            const before = etagCache.size;
            evictOldestEtagCacheEntry(inFlightConditionalGetKeys);
            if (etagCache.size === before) break;
          }
          etagCache.set(cacheKey, { etag, data, linkHeader });
        }
      }
      return { data: data as T, response, linkHeader };
    }

    const exhausted = lastAttemptError ?? (firstUnavailable
      ? new GithubCredentialAttemptError(
          firstUnavailable.failure.message,
          firstUnavailable.failure,
          firstUnavailable.rateLimit,
        )
      : null);
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
    let nextUrl = parseNextLink(first.linkHeader ?? first.response?.headers.get("link") ?? null);
    while (nextUrl) {
      const url = new URL(nextUrl);
      const next = await apiRequest<T[]>({
        method: "GET",
        path: `${url.pathname}${url.search}`,
        token: args.token,
      });
      if (Array.isArray(next.data)) out.push(...next.data);
      nextUrl = parseNextLink(next.linkHeader ?? next.response?.headers.get("link") ?? null);
    }
    return out;
  };

  let cachedStatus: GitHubStatus | null = null;
  let cachedAt = 0;

  // Decides whether the saved token is actually usable for the project. Classic
  // tokens require both required scopes; fine-grained tokens require a successful
  // repo probe (since their permissions are not introspectable via headers).
  const computeConnected = (args: {
    tokenStored: boolean;
    userLogin: string | null;
    authSource: GitHubStatus["authSource"];
    tokenType: GitHubStatus["tokenType"];
    scopes: string[];
    repo: GitHubRepoRef | null;
    repoAccessOk: boolean | null;
  }): boolean => {
    if (!args.tokenStored || !args.userLogin) return false;
    if (args.authSource === "app") {
      return args.repo ? args.repoAccessOk === true : true;
    }
    if (args.tokenType === "fine-grained") {
      // No repo to probe (e.g. project without a GitHub remote): a fine-grained
      // token that authenticates as a user is the best signal we have.
      if (!args.repo) return true;
      return args.repoAccessOk === true;
    }
    if (args.tokenType === "classic" || args.tokenType === "oauth" || args.scopes.length > 0) {
      const access = getGitHubTokenAccessState(args.scopes);
      return access.hasRequiredAccess;
    }
    // Unknown prefix — fall back to "user lookup worked" (best-effort).
    return Boolean(args.userLogin);
  };

  const computeStatus = async (opts: { forceRefresh?: boolean } = {}): Promise<GitHubStatus> => {
    if (opts.forceRefresh) {
      cachedStatus = null;
      cachedAt = 0;
      cachedStatusTokenDigest = null;
      sharedGhAuth.authCache = null;
      sharedGhAuth.statusCache.clear();
      processGhHostsTokenCache.clear();
    }
    const [inventory, origin] = await Promise.all([
      readCredentialInventory(),
      detectOrigin().catch(() => ({ repo: null, hasOrigin: false })),
    ]);
    const { repo, hasOrigin } = origin;
    const readCandidates = githubOperationCredentialCandidates(inventory.candidates, "read");
    const primaryCandidate = readCandidates[0] ?? null;
    const writeCandidates = githubOperationCredentialCandidates(inventory.candidates, "write");
    const statusCooldown = (candidate: GitHubTokenCandidate) => githubCredentialCooldown(
      candidate,
      Date.now(),
      { resource: "core", ignoreNonRateLimit: opts.forceRefresh === true },
    );
    const currentWriteCandidate = writeCandidates.find((candidate) => !statusCooldown(candidate))
      ?? null;
    if (!primaryCandidate) {
      cachedStatus = {
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
      cachedAt = Date.now();
      cachedStatusTokenDigest = null;
      return cachedStatus;
    }

    const now = Date.now();
    const primaryTokenDigest = githubCredentialTokenDigest(primaryCandidate.token);
    if (cachedStatus && now - cachedAt < 30_000 && cachedStatus.tokenStored) {
      const repoChanged =
        (cachedStatus.repo?.owner ?? null) !== (repo?.owner ?? null) ||
        (cachedStatus.repo?.name ?? null) !== (repo?.name ?? null);
      if (repoChanged || cachedStatusTokenDigest !== primaryTokenDigest) {
        cachedStatus = null;
        cachedAt = 0;
        cachedStatusTokenDigest = null;
      } else {
        const activeReadSource = cachedStatus.authSource === "none" ? null : cachedStatus.authSource;
        const activeWriteSource = currentWriteCandidate?.source === "app"
          ? null
          : currentWriteCandidate?.source ?? null;
        const pauseUntilMs = githubBackgroundRequestPauseUntilMs(Date.now(), readCandidates);
        return {
          ...cachedStatus,
          repo,
          hasOrigin,
          patTokenStored: inventory.patTokenStored,
          ghCliPath: inventory.ghCliPath ?? cachedStatus.ghCliPath,
          ghAuthError: inventory.ghAuthError,
          writeAuthSource: activeWriteSource ?? "none",
          credentialStates: githubCredentialStates({
            candidates: inventory.candidates,
            availableSources: inventory.availableSources,
            activeReadSource,
            activeWriteSource,
          }),
          backgroundRefreshPausedUntil: pauseUntilMs == null
            ? null
            : new Date(pauseUntilMs).toISOString(),
        };
      }
    }

    const failures: Array<{
      candidate: GitHubTokenCandidate;
      error: string;
      authFailure: GitHubAuthFailure;
      rateLimit: GitHubRateLimitState | null;
    }> = [];
    let active: {
      candidate: GitHubTokenCandidate;
      value: SharedGithubStatusProbe;
    } | null = null;

    for (const [candidateIndex, candidate] of readCandidates.entries()) {
      const cooldown = statusCooldown(candidate);
      if (cooldown) {
        failures.push({
          candidate,
          error: cooldown.failure.message,
          authFailure: cooldown.failure,
          rateLimit: cooldown.rateLimit,
        });
        continue;
      }
      const statusProbe = candidate.source === "gh"
        ? await readSharedGithubStatusProbe(candidate.token, repo, opts.forceRefresh === true)
        : await computeGithubStatusProbe(candidate.token, repo, candidate.source);
      if (!statusProbe.ok) {
        const hasFallbackCandidate = readCandidates
          .slice(candidateIndex + 1)
          .some((nextCandidate) => !statusCooldown(nextCandidate));
        if (
          statusProbe.authFailure.kind === "permission_denied"
          && statusProbe.value
          && !hasFallbackCandidate
        ) {
          active = { candidate, value: statusProbe.value };
          registerGithubCredentialIdentity(candidate, statusProbe.value.validated.userLogin);
          break;
        }
        recordGithubCredentialFailure(candidate, statusProbe.authFailure, statusProbe.rateLimit);
        failures.push({ candidate, ...statusProbe });
        logger.warn("github.token_validation_failed", {
          source: candidate.source,
          error: statusProbe.error,
          kind: statusProbe.authFailure.kind,
          retryAt: statusProbe.authFailure.retryAt,
        });
        if (
          statusProbe.authFailure.kind === "network"
          || statusProbe.authFailure.kind === "unknown"
        ) {
          break;
        }
        continue;
      }
      active = { candidate, value: statusProbe.value };
      registerGithubCredentialIdentity(candidate, statusProbe.value.validated.userLogin);
      recordGithubCredentialProbeSuccess(
        candidate,
        statusProbe.value.validated.rateLimit,
        statusProbe.value.validated.userLogin,
      );
      break;
    }

    const activeWriteCandidate = writeCandidates.find((candidate) => !statusCooldown(candidate))
      ?? null;
    const pauseUntilMs = githubBackgroundRequestPauseUntilMs(Date.now(), readCandidates);
    if (active) {
      const { candidate, value } = active;
      const { validated, repoAccessOk, repoAccessError } = value;
      // Classic PATs and gh OAuth tokens expose scopes in the /user response.
      // Fine-grained tokens do not expose selected repos and need a repo probe.
      if (repo && validated.tokenType === "fine-grained" && repoAccessOk === false) {
        logger.warn("github.repo_probe_failed", {
          repo: `${repo.owner}/${repo.name}`,
          tokenType: validated.tokenType,
          error: repoAccessError,
        });
      }
      const connected = computeConnected({
        tokenStored: true,
        userLogin: validated.userLogin,
        authSource: candidate.source,
        tokenType: validated.tokenType,
        scopes: validated.scopes,
        repo,
        repoAccessOk,
      });
      cachedStatus = {
        tokenStored: true,
        patTokenStored: inventory.patTokenStored,
        tokenDecryptionFailed: false,
        storageScope: "app",
        authSource: candidate.source,
        writeAuthSource: activeWriteCandidate?.source === "app"
          ? "none"
          : activeWriteCandidate?.source ?? "none",
        tokenType: validated.tokenType,
        repo,
        hasOrigin,
        userLogin: validated.userLogin,
        scopes: validated.scopes,
        ghCliPath: inventory.ghCliPath,
        ghAuthError: inventory.ghAuthError,
        checkedAt: nowIso(),
        authFailure: null,
        rateLimit: validated.rateLimit,
        credentialStates: githubCredentialStates({
          candidates: inventory.candidates,
          availableSources: inventory.availableSources,
          activeReadSource: candidate.source,
          activeWriteSource: activeWriteCandidate?.source === "app"
            ? null
            : activeWriteCandidate?.source ?? null,
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
        connected,
      };
      cachedAt = now;
      // Track the precedence head, not the fallback, so a source appearing or
      // disappearing invalidates this cache immediately.
      cachedStatusTokenDigest = primaryTokenDigest;
      return cachedStatus;
    }

    const failure = failures.find((entry) => entry.authFailure.kind === "rate_limited")
      ?? failures[0]
      ?? {
        candidate: primaryCandidate,
        error: "GitHub authentication could not be verified.",
        authFailure: classifyGitHubAuthFailure({ message: "GitHub authentication could not be verified." }).authFailure,
        rateLimit: null,
      };
    cachedStatus = {
      tokenStored: true,
      patTokenStored: inventory.patTokenStored,
      tokenDecryptionFailed: false,
      storageScope: "app",
      authSource: primaryCandidate.source,
      writeAuthSource: activeWriteCandidate?.source === "app"
        ? "none"
        : activeWriteCandidate?.source ?? "none",
      tokenType: detectGitHubTokenType(primaryCandidate.token),
      repo,
      hasOrigin,
      userLogin: null,
      scopes: [],
      ghCliPath: inventory.ghCliPath,
      ghAuthError: inventory.ghAuthError,
      checkedAt: nowIso(),
      authFailure: failure.authFailure,
      rateLimit: failure.rateLimit,
      credentialStates: githubCredentialStates({
        candidates: inventory.candidates,
        availableSources: inventory.availableSources,
        activeReadSource: null,
        activeWriteSource: activeWriteCandidate?.source === "app"
          ? null
          : activeWriteCandidate?.source ?? null,
      }),
      credentialFallback: null,
      backgroundRefreshPausedUntil: pauseUntilMs == null
        ? null
        : new Date(pauseUntilMs).toISOString(),
      repoAccessOk: null,
      repoAccessError: null,
      connected: false,
    };
    cachedAt = now;
    cachedStatusTokenDigest = primaryTokenDigest;
    return cachedStatus;
  };

  const getStatus = async (opts: { forceRefresh?: boolean } = {}): Promise<GitHubStatus> => {
    if (statusInFlight) {
      if (!opts.forceRefresh) return await statusInFlight;
      await statusInFlight.catch(() => {});
    }
    const work = computeStatus(opts);
    statusInFlight = work;
    try {
      return await work;
    } finally {
      if (statusInFlight === work) statusInFlight = null;
    }
  };

  const listRepoLabels = async (owner: string, name: string): Promise<GitHubLabel[]> => {
    return await apiRequestAllPages<GitHubLabel>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`,
      query: { per_page: 100 },
    });
  };

  const normalizeAutolink = (raw: Record<string, unknown>): GitHubAutolink => ({
    id: typeof raw.id === "number" && Number.isFinite(raw.id) ? raw.id : 0,
    keyPrefix: asString(raw.key_prefix),
    urlTemplate: asString(raw.url_template),
    isAlphanumeric: Boolean(raw.is_alphanumeric),
  });

  const listRepoAutolinks = async (owner: string, name: string): Promise<GitHubAutolink[]> => {
    const data = await apiRequestAllPages<Record<string, unknown>>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/autolinks`,
      query: { per_page: 100 },
    });
    return data.map(normalizeAutolink).filter((entry) => entry.keyPrefix && entry.urlTemplate);
  };

  const createRepoAutolink = async (
    owner: string,
    name: string,
    args: { keyPrefix: string; urlTemplate: string; isAlphanumeric?: boolean },
  ): Promise<GitHubAutolink> => {
    const autolinksPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/autolinks`;
    const { data } = await apiRequest<Record<string, unknown>>({
      method: "POST",
      path: autolinksPath,
      body: {
        key_prefix: args.keyPrefix,
        url_template: args.urlTemplate,
        is_alphanumeric: args.isAlphanumeric === true,
      },
    });
    for (const cacheKey of etagCache.keys()) {
      if (cacheKey.includes(autolinksPath)) etagCache.delete(cacheKey);
    }
    return normalizeAutolink(data);
  };

  const listRepoCollaborators = async (owner: string, name: string): Promise<GitHubUser[]> => {
    return await apiRequestAllPages<GitHubUser>({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators`,
      query: { per_page: 100 },
    });
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

  const getAppInstallationStatus = async (
    args: { owner?: string; name?: string; forceRefresh?: boolean } = {},
  ): Promise<GitHubAppInstallationStatus> => {
    const owner = args.owner?.trim();
    const name = args.name?.trim();
    const repo = owner && name ? { owner, name } : await detectRepo();
    const githubAppUserToken = await appUserAuth.getValidTokenForRelay().catch(() => null);
    const accountAccessToken = getAccountAccessToken
      ? await getAccountAccessToken().catch(() => null)
      : null;
    return fetchGitHubAppInstallationStatus({
      repo,
      secretReader: githubRelaySecretReader,
      forceRefresh: args.forceRefresh === true,
      githubAppUserToken,
      accountAccessToken,
      auditLog: appUserAuth.auditLog,
    });
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

  const createSecretGist = async (args: {
    description?: string | null;
    files: Record<string, { content: string }>;
  }): Promise<{ id: string; htmlUrl: string }> => {
    const files: Record<string, { content: string }> = {};
    for (const [filename, file] of Object.entries(args.files)) {
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

  // Edits an existing issue comment in place. `commentId` is the GitHub issue
  // comment id (NOT the PR number) returned by addIssueComment.
  const updateIssueComment = async (owner: string, name: string, commentId: number, body: string): Promise<GitHubIssueComment | null> => {
    const { data } = await apiRequest<GitHubIssueComment>({
      method: "PATCH",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${commentId}`,
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

  const createRepository = async (args: {
    owner?: string | null;
    name: string;
    description?: string;
    isPrivate: boolean;
  }): Promise<{ owner: string; name: string; fullName: string; cloneUrl: string; sshUrl: string; htmlUrl: string; defaultBranch: string }> => {
    const body: Record<string, unknown> = {
      name: args.name,
      private: args.isPrivate,
      auto_init: false,
    };
    if (args.description != null && args.description.trim().length > 0) {
      body.description = args.description.trim();
    }
    const owner = asString(args.owner).trim();
    // GitHub's `/orgs/{owner}/repos` route only accepts organization owners; a
    // personal account (the authenticated user's own login) must use
    // `/user/repos`. The renderer now populates `owner` from the connected
    // login, so detect that case and avoid the org route for personal publishes.
    const authenticatedLogin = owner
      ? ((await validateToken((await readAuthToken("write")).token ?? "").catch(() => ({ userLogin: null as string | null }))).userLogin?.trim() || null)
      : null;
    // Only take the org route when we POSITIVELY resolved the authenticated
    // login and it differs from `owner`. If token validation failed (transient
    // network error / rate limit), `authenticatedLogin` is null and we must not
    // assume an org — fall back to `/user/repos`, since `owner` is almost always
    // the pre-populated personal login. Routing a personal publish through the
    // org-only endpoint would hard-fail.
    const useOrgRoute = owner.length > 0 && authenticatedLogin != null && owner.toLowerCase() !== authenticatedLogin.toLowerCase();
    const { data } = await apiRequest<Record<string, unknown>>({
      method: "POST",
      path: useOrgRoute ? `/orgs/${encodeURIComponent(owner)}/repos` : "/user/repos",
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

  const publishCurrentProject = async (
    args: { owner?: string; name: string; description?: string; isPrivate: boolean },
  ): Promise<{ state: "pushed" | "remote_added"; owner: string; name: string; fullName: string; htmlUrl: string }> => {
    const token = (await readAuthToken("write")).token;
    if (!token) {
      const err = new Error("GitHub is not connected. Run `gh auth login -h github.com -s repo -s workflow` or add a personal access token in Settings.") as Error & { code?: string };
      err.code = "github_not_connected";
      throw err;
    }

    const existingRemote = await runGit(["remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 8_000 });
    if (existingRemote.exitCode === 0 && existingRemote.stdout.trim().length > 0) {
      const err = new Error("This project already has a GitHub remote named 'origin'.") as Error & { code?: string };
      err.code = "remote_already_exists";
      throw err;
    }

    // If a previous publish attempt created the GitHub repo but then failed
    // before push (auth/network), `createRepository` will 422 with "name
    // already exists". Recover by GETting the existing repo and reusing its
    // cloneUrl — but only when it's empty (size=0), so we never overwrite
    // an unrelated user repo with the same name.
    const requestedOwner = asString(args.owner).trim() || null;
    let created: { owner: string; name: string; fullName: string; cloneUrl: string; sshUrl: string; htmlUrl: string; defaultBranch: string };
    try {
      created = await createRepository({
        owner: requestedOwner,
        name: args.name,
        description: args.description,
        isPrivate: args.isPrivate,
      });
    } catch (createErr) {
      const message = createErr instanceof Error ? createErr.message : String(createErr);
      const isNameTaken = /already exists/i.test(message);
      if (!isNameTaken) throw createErr;

      const validated = requestedOwner
        ? null
        : await validateToken(token).catch(() => ({ userLogin: null as string | null }));
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

    // After createRepository succeeds, the GitHub repo exists. If we then
    // fail to add the local origin or push to it, we must remove the local
    // origin we may have added so that a retry isn't blocked by the
    // remote_already_exists guard at the top of this function.
    const cleanupLocalOrigin = async (): Promise<void> => {
      try {
        await runGit(["remote", "remove", "origin"], { cwd: projectRoot, timeoutMs: 8_000 });
      } catch {
        // best-effort
      }
    };

    const remoteAddRes = await runGit(["remote", "add", "origin", created.cloneUrl], {
      cwd: projectRoot,
      timeoutMs: 8_000,
    });
    if (remoteAddRes.exitCode !== 0) {
      await cleanupLocalOrigin();
      throw new Error(`Failed to add origin remote: ${remoteAddRes.stderr.trim() || `exit ${remoteAddRes.exitCode}`}`);
    }

    const headRes = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: projectRoot, timeoutMs: 5_000 });
    let resultState: "pushed" | "remote_added";
    if (headRes.exitCode === 0) {
      const pushRes = await runGit(["push", "-u", "origin", "HEAD"], { cwd: projectRoot, timeoutMs: 5 * 60_000 });
      if (pushRes.exitCode !== 0) {
        await cleanupLocalOrigin();
        throw new Error(`Failed to push to origin: ${pushRes.stderr.trim() || `exit ${pushRes.exitCode}`}`);
      }
      resultState = "pushed";
    } else {
      resultState = "remote_added";
    }

    cachedStatus = null;
    cachedAt = 0;
    cachedStatusTokenDigest = null;

    return {
      state: resultState,
      owner: created.owner,
      name: created.name,
      fullName: created.fullName,
      htmlUrl: created.htmlUrl,
    };
  };

  return {
    getRemoteStatus: detectOrigin,

    getStatus,

    async getBackgroundRequestPauseUntilMs(): Promise<number | null> {
      const inventory = await readCredentialInventory();
      return githubBackgroundRequestPauseUntilMs(
        Date.now(),
        githubOperationCredentialCandidates(inventory.candidates, "read"),
      );
    },

    getAppUserAuthStatus(): GitHubAppUserAuthStatus {
      return appUserAuth.getAuthStatus();
    },

    async startAppUserDeviceAuth(): Promise<GitHubAppDeviceAuthStartResult> {
      return await appUserAuth.startDeviceAuth();
    },

    async pollAppUserDeviceAuth(args: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult> {
      const result = await appUserAuth.pollDeviceAuth(args);
      if (result.status === "authorized") {
        clearGithubCredentialHealth();
        cachedStatus = null;
        cachedAt = 0;
        cachedStatusTokenDigest = null;
      }
      return result;
    },

    clearAppUserAuth(): GitHubAppUserAuthStatus {
      const status = appUserAuth.clearAuth();
      clearGithubCredentialHealth();
      cachedStatus = null;
      cachedAt = 0;
      cachedStatusTokenDigest = null;
      return status;
    },

    setToken(token: string): void {
      persistToken(token);
      tokenDecryptionFailed = false;
      cachedStatus = null;
      cachedAt = 0;
      cachedStatusTokenDigest = null;
      sharedGhAuth.authCache = null;
      sharedGhAuth.statusCache.clear();
      clearGithubCredentialHealth();
    },

    clearToken(): void {
      persistToken(null);
      tokenDecryptionFailed = false;
      cachedStatus = null;
      cachedAt = 0;
      cachedStatusTokenDigest = null;
      sharedGhAuth.authCache = null;
      sharedGhAuth.statusCache.clear();
      clearGithubCredentialHealth();
    },

    async getRepoOrThrow(): Promise<GitHubRepoRef> {
      const repo = await detectRepo();
      if (!repo) throw new Error("Unable to detect GitHub repo from git remote 'origin'.");
      return repo;
    },

    getTokenOrThrow(): string {
      const token = readAuthTokenSync().token;
      if (!token) throw new Error("GitHub auth missing. Run `gh auth login -h github.com -s repo -s workflow` or add a personal access token in Settings.");
      return token;
    },

    async getTokenOrThrowAsync(): Promise<string> {
      const token = (await readAuthToken("write")).token;
      if (!token) throw new Error("GitHub auth missing. Run `gh auth login -h github.com -s repo -s workflow` or add a personal access token in Settings.");
      return token;
    },

    async getAppUserTokenForRelay(): Promise<string> {
      return await appUserAuth.getValidTokenForRelay();
    },

    detectRepo,
    getAppInstallationStatus,
    apiRequest,
    parseNextLink,
    parseGitHubRepoFromRemoteUrl,

    // Repo creation + publish
    createRepository,
    getRepository,
    publishCurrentProject,

    // Polling/picker read helpers
    listRepoAutolinks,
    createRepoAutolink,
    listRepoLabels,
    listRepoCollaborators,
    listRepoIssues,
    getIssue,
    listIssueComments,
    listRepoPulls,
    listPullRequestReviews,
    createSecretGist,

    // Issue-domain action helpers (exposed via `issue` domain in the
    // automations action registry).
    addIssueComment,
    updateIssueComment,
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
