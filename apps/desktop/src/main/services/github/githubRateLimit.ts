import type { GitHubAuthFailure, GitHubRateLimitState } from "../../../shared/types";

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
}): { authFailure: GitHubAuthFailure; rateLimit: GitHubRateLimitState | null } {
  const message = args.message.trim() || "GitHub token validation failed.";
  const rateLimit = args.headers ? readGitHubRateLimitState(args.headers) : null;
  const rateLimited =
    args.status === 429
    || rateLimit?.remaining === 0
    || /rate limit|too many requests|abuse detection/i.test(message);
  if (rateLimited) {
    return {
      rateLimit,
      authFailure: {
        kind: "rate_limited",
        message,
        retryAt: args.headers ? rateLimitRetryAt(args.headers, rateLimit) : rateLimit?.resetAt ?? null,
      },
    };
  }
  if (args.status === 401 || /bad credentials|invalid token|requires authentication/i.test(message)) {
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
        retryAt: null,
      },
    };
  }
  if (isTransientGithubProbeFailure(message)) {
    return {
      rateLimit,
      authFailure: {
        kind: "network",
        message,
        retryAt: null,
      },
    };
  }
  return {
    rateLimit,
    authFailure: {
      kind: "unknown",
      message,
      retryAt: null,
    },
  };
}

export function classifyGitHubGraphqlCredentialFailure(
  payload: unknown,
  headers: Pick<Headers, "get">,
): {
  status: 403 | 429;
  message: string;
  authFailure: GitHubAuthFailure;
  rateLimit: GitHubRateLimitState | null;
} | null {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { errors?: unknown }).errors)) {
    return null;
  }
  const errors = (payload as { errors: unknown[] }).errors;
  const messages = errors.flatMap((error) => {
    if (!error || typeof error !== "object") return [];
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.trim() ? [message.trim()] : [];
  });
  const errorTypes = errors.flatMap((error) => {
    if (!error || typeof error !== "object") return [];
    const record = error as {
      type?: unknown;
      extensions?: { code?: unknown; type?: unknown };
    };
    return [record.type, record.extensions?.code, record.extensions?.type]
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
      ...classifyGitHubAuthFailure({ status: 429, message, headers }),
    };
  }
  const permissionDenied = errorTypes.includes("FORBIDDEN")
    || /forbidden|resource not accessible|not accessible by integration|does not have access/i.test(message);
  if (permissionDenied) {
    return {
      status: 403,
      message,
      ...classifyGitHubAuthFailure({ status: 403, message, headers }),
    };
  }
  return null;
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
