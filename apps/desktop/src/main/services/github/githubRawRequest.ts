import {
  githubOperationCredentialCandidates,
  type GithubOperationCredentialCapability,
} from "../../../shared/githubOperationCredential";
import {
  classifyGitHubRepositoryApiPath,
  createGithubRepositoryRequestFallback,
} from "../../../shared/githubApiPath";
import type {
  GitHubAuthFailure,
  GitHubRateLimitState,
  GitHubRepoRef,
} from "../../../shared/types/git";
import {
  githubCredentialCooldown,
  githubCredentialRepositoryAccess,
  recordGithubOperationFailure,
  recordGithubCredentialRepositoryAccess,
  recordGithubCredentialSuccess,
  type GithubCredentialCandidate,
} from "./githubCredentialHealth";
import {
  classifyGitHubAuthFailure,
  GitHubRateLimitError,
  githubRateLimitResourceForPath,
  githubRateLimitRetryAtMs,
} from "./githubRateLimit";

export type GithubRawRequestArgs = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
  capability?: GithubOperationCredentialCapability;
  repo?: GitHubRepoRef;
};

class GithubRawCredentialAttemptError extends Error {
  constructor(
    message: string,
    readonly authFailure: GitHubAuthFailure,
    readonly rateLimit: GitHubRateLimitState | null,
  ) {
    super(message);
    this.name = "GithubCredentialAttemptError";
  }
}

function responseMessage(text: string, status: number): string {
  const fallback = `GitHub API request failed (HTTP ${status})`;
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
      if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    }
    return fallback;
  } catch {
    return trimmed;
  }
}

export async function requestGithubRawWithCredentialFallback(args: GithubRawRequestArgs & {
  candidates: readonly GithubCredentialCandidate[];
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  userAgent: string;
  defaultHeaders?: Record<string, string>;
  authMissingMessage: string;
  onFallback?: (args: {
    capability: GithubOperationCredentialCapability;
    fromSource: GithubCredentialCandidate["source"] | null;
    toSource: GithubCredentialCandidate["source"];
  }) => void;
}): Promise<Response> {
  const capability = args.capability ?? "read";
  const candidates = githubOperationCredentialCandidates(args.candidates, capability);
  if (candidates.length === 0) throw new Error(args.authMissingMessage);

  const parsedUrl = new URL(args.url);
  const rateLimitResource = githubRateLimitResourceForPath(parsedUrl.pathname);
  const repositoryPath = classifyGitHubRepositoryApiPath(parsedUrl.pathname)
    ?? (args.repo ? { ...args.repo, isRepositoryRoot: true } : null);
  const repositoryFallback = createGithubRepositoryRequestFallback<GithubCredentialCandidate>({
    path: repositoryPath,
    readAccess: githubCredentialRepositoryAccess,
    recordAccess: recordGithubCredentialRepositoryAccess,
  });
  let firstUnavailable: {
    failure: GitHubAuthFailure;
    rateLimit: GitHubRateLimitState | null;
  } | null = null;
  let lastAttemptError: GithubRawCredentialAttemptError | null = null;
  let firstRateLimitError: GithubRawCredentialAttemptError | null = null;

  for (const candidate of candidates) {
    if (repositoryFallback.shouldSkip(candidate)) {
      const message = `This credential cannot access ${repositoryPath?.owner}/${repositoryPath?.name}.`;
      lastAttemptError = new GithubRawCredentialAttemptError(
        message,
        { kind: "permission_denied", message, retryAt: null },
        null,
      );
      continue;
    }
    const cooldown = githubCredentialCooldown(candidate, Date.now(), {
      resource: rateLimitResource,
    });
    if (cooldown) {
      firstUnavailable ??= cooldown;
      continue;
    }

    const headers = new Headers(args.headers);
    for (const [key, value] of Object.entries(args.defaultHeaders ?? {})) headers.set(key, value);
    headers.set("authorization", `Bearer ${candidate.token}`);
    headers.set("user-agent", args.userAgent);
    const response = await args.fetchImpl(args.url, {
      method: args.method ?? "GET",
      headers,
      redirect: args.redirect,
      signal: args.signal,
    });
    const manualRedirect = args.redirect === "manual"
      && response.status >= 300
      && response.status < 400;
    if (response.ok || manualRedirect) {
      recordGithubCredentialSuccess(candidate, response.headers);
      repositoryFallback.recordSuccess(candidate);
      if (candidate !== candidates[0]) {
        args.onFallback?.({
          capability,
          fromSource: candidates[0]?.source ?? null,
          toSource: candidate.source,
        });
      }
      return response;
    }

    const { repositoryNotFound, ambiguousRepositoryNotFound } =
      repositoryFallback.classifyFailure(candidate, response.status);
    const canTryNext = response.status === 401
      || response.status === 403
      || response.status === 429
      || ambiguousRepositoryNotFound;
    if (!canTryNext) return response;

    const message = responseMessage(await response.text().catch(() => ""), response.status);
    const failure = classifyGitHubAuthFailure({
      status: response.status,
      message,
      headers: response.headers,
    });
    if (!repositoryNotFound) {
      recordGithubOperationFailure(candidate, failure.authFailure, failure.rateLimit);
    }
    const attemptError = new GithubRawCredentialAttemptError(
      message,
      failure.authFailure,
      failure.rateLimit,
    );
    lastAttemptError = attemptError;
    if (attemptError.authFailure.kind === "rate_limited") firstRateLimitError ??= attemptError;
  }

  const unavailableError = firstUnavailable
    ? new GithubRawCredentialAttemptError(
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
    throw new GitHubRateLimitError(exhausted.message, resetAtMs, exhausted.rateLimit);
  }
  if (exhausted) throw exhausted;
  throw new Error("No usable GitHub credential is available for this operation.");
}
