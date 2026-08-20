import type { GitHubAuthFailure, GitHubRateLimitState } from "../../../shared/types";
import { isGithubServiceUnavailable } from "../../../shared/githubServiceHealth";
import { isDefinitiveGitHubOAuthError } from "./githubAppUserAuth";

export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly rateLimitResetAtMs: number | null,
    readonly rateLimit: GitHubRateLimitState | null = null,
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

function parseHeaderInteger(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function isoFromEpochSeconds(value: string | null): string | null {
  const seconds = parseHeaderInteger(value);
  if (seconds == null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function readGitHubRateLimitState(
  headers: Pick<Headers, "get">,
): GitHubRateLimitState | null {
  const limit = parseHeaderInteger(headers.get("x-ratelimit-limit"));
  const remaining = parseHeaderInteger(headers.get("x-ratelimit-remaining"));
  const used = parseHeaderInteger(headers.get("x-ratelimit-used"));
  const resetAt = isoFromEpochSeconds(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource")?.trim() || null;
  if (limit == null && remaining == null && used == null && resetAt == null && resource == null) {
    return null;
  }
  return { limit, remaining, used, resetAt, resource };
}

function rateLimitRetryAt(
  headers: Pick<Headers, "get">,
  rateLimit: GitHubRateLimitState | null,
): string | null {
  const retryAfterSeconds = parseHeaderInteger(headers.get("retry-after"));
  if (retryAfterSeconds != null) {
    return new Date(Date.now() + retryAfterSeconds * 1_000).toISOString();
  }
  return rateLimit?.resetAt ?? null;
}

export function isTransientGithubProbeFailure(error: string | null): boolean {
  return /timed out|timeout|network|fetch failed|aborted|econn(?:reset|refused|aborted)|enotfound|eai_again|socket|tls|temporarily unavailable/i
    .test(error ?? "");
}

export function classifyGitHubAuthFailure(args: {
  status?: number;
  message: string;
  headers?: Pick<Headers, "get">;
  /**
   * The OAuth `error` code, when the failure came from GitHub's OAuth endpoints.
   * Those answer a rejected refresh token with HTTP 200, so the status alone
   * cannot tell a dead credential from a healthy response.
   */
  oauthError?: string | null;
  /**
   * A deadline the caller already knows — the refresh backoff, typically. It
   * wins over anything derived from headers, because it is the instant ADE will
   * actually try again.
   */
  retryAt?: string | null;
}): { authFailure: GitHubAuthFailure; rateLimit: GitHubRateLimitState | null } {
  const message = args.message.trim() || "GitHub token validation failed.";
  const rateLimit = args.headers ? readGitHubRateLimitState(args.headers) : null;
  const retryAfterSeconds = args.headers ? parseHeaderInteger(args.headers.get("retry-after")) : null;
  const knownRetryAt = args.retryAt?.trim() || null;
  const rateLimited =
    args.status === 429
    || retryAfterSeconds != null
    || args.oauthError === "too_many_requests"
    || rateLimit?.remaining === 0
    || /rate limit|too many requests|abuse detection/i.test(message);
  if (rateLimited) {
    return {
      rateLimit,
      authFailure: {
        kind: "rate_limited",
        message,
        retryAt: knownRetryAt
          ?? (args.headers ? rateLimitRetryAt(args.headers, rateLimit) : rateLimit?.resetAt ?? null),
      },
    };
  }
  if (
    args.status === 401
    || isDefinitiveGitHubOAuthError(args.oauthError)
    || /bad credentials|invalid token|requires authentication/i.test(message)
  ) {
    return {
      rateLimit,
      authFailure: {
        kind: "invalid_token",
        message,
        retryAt: null,
      },
    };
  }
  if (args.status === 403) {
    return {
      rateLimit,
      authFailure: {
        kind: "permission_denied",
        message,
        retryAt: knownRetryAt,
      },
    };
  }
  // Ordered before the transient-network check: GitHub's 503 body contains
  // "temporarily unavailable"-adjacent wording that the transient regex also
  // matches, and "GitHub is down" is the more precise, more actionable answer.
  if (isGithubServiceUnavailable({ status: args.status, message })) {
    return {
      rateLimit,
      authFailure: {
        kind: "service_unavailable",
        message,
        retryAt: knownRetryAt,
      },
    };
  }
  if (isTransientGithubProbeFailure(message)) {
    return {
      rateLimit,
      authFailure: {
        kind: "network",
        message,
        retryAt: knownRetryAt,
      },
    };
  }
  return {
    rateLimit,
    authFailure: {
      kind: "unknown",
      message,
      retryAt: knownRetryAt,
    },
  };
}

export function classifyGitHubGraphqlCredentialFailure(
  payload: unknown,
  headers: Pick<Headers, "get">,
): {
  status: 403 | 404 | 429;
  message: string;
  hasData: boolean;
  authFailure: GitHubAuthFailure;
  rateLimit: GitHubRateLimitState | null;
} | null {
  if (
    !payload
    || typeof payload !== "object"
    || !("errors" in payload)
    || !Array.isArray(payload.errors)
  ) return null;
  const data = "data" in payload ? payload.data : null;
  const hasMeaningfulData = (value: unknown): boolean => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some(hasMeaningfulData);
    if (typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some(hasMeaningfulData);
    }
    return true;
  };
  const hasData = hasMeaningfulData(data);
  const errors: unknown[] = payload.errors;
  const messages = errors.flatMap((error) => {
    if (!error || typeof error !== "object") return [];
    const message = "message" in error ? error.message : null;
    return typeof message === "string" && message.trim() ? [message.trim()] : [];
  });
  const errorTypes = errors.flatMap((error) => {
    if (!error || typeof error !== "object") return [];
    const extensions = "extensions" in error
      && error.extensions
      && typeof error.extensions === "object"
      ? error.extensions
      : null;
    return [
      "type" in error ? error.type : null,
      extensions && "code" in extensions ? extensions.code : null,
      extensions && "type" in extensions ? extensions.type : null,
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toUpperCase());
  });
  const message = messages.join("; ") || "GitHub GraphQL request failed.";
  const rateLimit = readGitHubRateLimitState(headers);
  const rateLimited = rateLimit?.remaining === 0
    || errorTypes.some((type) => type === "RATE_LIMITED" || type === "RATE_LIMIT")
    || /rate limit|too many requests|abuse detection/i.test(message);
  if (rateLimited) {
    return {
      status: 429,
      message,
      hasData,
      ...classifyGitHubAuthFailure({ status: 429, message, headers }),
    };
  }
  const permissionDenied = errorTypes.includes("FORBIDDEN")
    || /forbidden|resource not accessible|not accessible by integration|does not have access/i.test(message);
  if (permissionDenied) {
    return {
      status: 403,
      message,
      hasData,
      ...classifyGitHubAuthFailure({ status: 403, message, headers }),
    };
  }
  const repositoryNotFound = errorTypes.includes("NOT_FOUND")
    && /(?:could not resolve to a|not found).*repository|repository.*not found/i.test(message);
  if (repositoryNotFound) {
    return {
      status: 404,
      message,
      hasData,
      rateLimit,
      authFailure: {
        kind: "permission_denied",
        message,
        retryAt: null,
      },
    };
  }
  return null;
}

/**
 * The classified failure kind carried by a thrown GitHub request error, or null
 * when the error is not one.
 *
 * Duck-typed rather than `instanceof`: the error classes that carry
 * `authFailure` are module-private to their request helpers, and there are two
 * of them (the desktop service and the headless twin), so a nominal check would
 * silently answer null for whichever owner it was not written against.
 */
export function githubAuthFailureKindOf(error: unknown): GitHubAuthFailure["kind"] | null {
  if (error instanceof GitHubRateLimitError) return "rate_limited";
  const kind = (error as { authFailure?: { kind?: unknown } } | null)?.authFailure?.kind;
  return typeof kind === "string" ? kind as GitHubAuthFailure["kind"] : null;
}

export function githubRateLimitResetAtMs(rateLimit: GitHubRateLimitState | null): number | null {
  if (!rateLimit?.resetAt) return null;
  const parsed = Date.parse(rateLimit.resetAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function githubRateLimitRetryAtMs(
  authFailure: GitHubAuthFailure,
  rateLimit: GitHubRateLimitState | null,
): number | null {
  if (authFailure.retryAt) {
    const parsed = Date.parse(authFailure.retryAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return githubRateLimitResetAtMs(rateLimit);
}

export function githubRateLimitResourceForPath(path: string): string {
  if (path === "/graphql" || path.startsWith("/graphql?")) return "graphql";
  if (path.startsWith("/search/")) return "search";
  return "core";
}
