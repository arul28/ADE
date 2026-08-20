import type {
  GitHubAppUserAuthCredentialState,
  GitHubAuthFailure,
  GitHubRateLimitState,
} from "../../../shared/types";
import {
  isDefinitiveGitHubOAuthError,
  isGitHubOAuthError,
  type GitHubOAuthError,
} from "./githubAppUserAuth";
import type { RefreshFailureKind, StoredRefreshFailure } from "./githubAppUserAuthLedger";
import { classifyGitHubAuthFailure } from "./githubRateLimit";
import type { GitHubAppUserAuthUnavailable } from "./githubRelayConfig";

/**
 * Why ADE cannot hand out a GitHub App user token, and what every caller does
 * with that answer.
 *
 * Split out of the service because the two consumers — the desktop GitHub
 * service and its headless CLI twin — need the classification without needing
 * the service that produced it.
 */

/**
 * A classified refresh failure before it is stamped with the instant it
 * happened, plus the verdict that decides whether the credential is worth
 * retrying.
 */
export type RefreshFailure = Omit<StoredRefreshFailure, "at"> & { dead: boolean };

/**
 * Why ADE cannot hand out an App user token right now, in terms the UI can
 * render without guessing.
 */
export class GitHubAppUserAuthError extends Error {
  constructor(
    message: string,
    readonly credentialState: Exclude<GitHubAppUserAuthCredentialState, "authorized">,
    readonly retryAt: string | null,
    /** The refresh failure behind this state, when one was recorded. */
    readonly failure: Pick<StoredRefreshFailure, "kind" | "status" | "oauthError"> | null,
  ) {
    super(message);
    this.name = "GitHubAppUserAuthError";
  }
}

/**
 * Turns a failed refresh POST into a verdict, and above all into an answer to
 * one question: is this credential worth trying again?
 *
 * A credential is declared dead ONLY on an explicit 401 or an OAuth error code
 * that names the grant as rejected. Everything else keeps the credential and
 * backs off, because the cost is asymmetric — a wasted retry costs one request,
 * while writing off a live credential costs the user their connection until
 * they notice and re-authorize by hand. GitHub's secondary rate limits answer
 * 403, sometimes with no `retry-after` and no error body at all, so a bare 403
 * was the exact shape that used to be mistaken for a dead grant.
 */
export function classifyRefreshFailure(error: unknown): RefreshFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (isGitHubOAuthError(error)) {
    const status = typeof error.status === "number" ? error.status : null;
    const oauthError = error.oauthError ?? null;
    const retryAfterSec = error.retryAfterSec ?? null;
    if (isDefinitiveGitHubOAuthError(oauthError) || status === 401) {
      return { kind: "dead_token", message, status, oauthError, retryAfterSec, dead: true };
    }
    if (
      status === 429
      || status === 403
      || oauthError === "too_many_requests"
      || retryAfterSec != null
    ) {
      return { kind: "rate_limited", message, status, oauthError, retryAfterSec, dead: false };
    }
    if (status != null && status >= 500) {
      return { kind: "outage", message, status, oauthError, retryAfterSec, dead: false };
    }
    return { kind: "unknown", message, status, oauthError, retryAfterSec, dead: false };
  }
  return { kind: "network", message, status: null, oauthError: null, retryAfterSec: null, dead: false };
}

/**
 * The parts of a failed token lookup a caller needs to classify it, whether the
 * failure came from the auth service or straight from the OAuth transport.
 *
 * Duck-typed for the same reason `githubAuthFailureKindOf` is: the desktop
 * service and the headless twin both call this, and an `instanceof` check
 * answers wrong across module instances.
 */
export function describeGitHubAppUserAuthFailure(error: unknown): {
  message: string;
  status: number | null;
  oauthError: string | null;
  retryAt: string | null;
  credentialState: GitHubAppUserAuthCredentialState | null;
  failureKind: RefreshFailureKind | null;
} {
  const candidate = error as Partial<GitHubAppUserAuthError & GitHubOAuthError> | null;
  // The service carries the OAuth details inside `failure`; the transport error
  // carries them on itself. Read both, service first.
  const failure = candidate?.failure ?? null;
  const status = typeof failure?.status === "number"
    ? failure.status
    : typeof candidate?.status === "number" ? candidate.status : null;
  const oauthError = typeof failure?.oauthError === "string"
    ? failure.oauthError
    : typeof candidate?.oauthError === "string" ? candidate.oauthError : null;
  return {
    message: error instanceof Error ? error.message : String(error),
    status,
    oauthError,
    retryAt: typeof candidate?.retryAt === "string" ? candidate.retryAt : null,
    credentialState: typeof candidate?.credentialState === "string"
      ? candidate.credentialState
      : null,
    failureKind: typeof failure?.kind === "string" ? failure.kind : null,
  };
}

export type AppUserAuthFailure = {
  authFailure: GitHubAuthFailure;
  rateLimit: GitHubRateLimitState | null;
  described: ReturnType<typeof describeGitHubAppUserAuthFailure>;
};

/**
 * Turns a failed App user token lookup into the credential-failure shape the
 * GitHub status surfaces already speak, with the OAuth details that decide the
 * kind carried across instead of being flattened into a message string.
 */
export function classifyAppUserAuthFailure(error: unknown): AppUserAuthFailure {
  const described = describeGitHubAppUserAuthFailure(error);
  const classified = classifyGitHubAuthFailure({
    status: described.status ?? undefined,
    message: described.message,
    oauthError: described.oauthError,
    retryAt: described.retryAt,
  });
  if (described.credentialState === "needs_reauth") {
    // The refresh token is gone, expired, or rejected. Only re-authorization
    // helps, so it must never be reported as a rate limit that will pass.
    return {
      described,
      rateLimit: classified.rateLimit,
      authFailure: { kind: "invalid_token", message: described.message, retryAt: null },
    };
  }
  return { ...classified, described };
}

/**
 * The account problem as the repo axis is allowed to state it.
 *
 * The installation check reports the relay's 401 unless it is handed this, and
 * the relay's wording blames the repository for a problem with ADE's own
 * authorization.
 */
export function describeAppUserAuthUnavailable(
  failure: AppUserAuthFailure | null,
): GitHubAppUserAuthUnavailable | null {
  if (!failure) return null;
  return {
    message: failure.described.message,
    credentialState: failure.described.credentialState,
    retryAt: failure.authFailure.retryAt,
  };
}

/** The App entry a credential inventory carries when the App token is unusable. */
export function appCredentialFailureEntry(
  failure: AppUserAuthFailure | null,
): Array<{
  source: "app";
  authFailure: GitHubAuthFailure;
  rateLimit: GitHubRateLimitState | null;
}> {
  if (!failure) return [];
  return [{
    source: "app" as const,
    authFailure: failure.authFailure,
    rateLimit: failure.rateLimit,
  }];
}

/**
 * Asks for a relay-ready App user token, and keeps the REASON when there is
 * none.
 *
 * Every caller needs the same three things — the token, the classified failure,
 * and one log line naming it — and the reason must never be swallowed: doing
 * that is how "ADE's authorization is paused" reached the user as the relay's
 * own "GitHub auth token is required" 401.
 */
export async function resolveAppUserTokenForRelay(args: {
  appUserAuth: { getValidTokenForRelay(): Promise<string> };
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  /** The log event name, which differs by call site. */
  event: string;
}): Promise<{ token: string | null; failure: AppUserAuthFailure | null }> {
  try {
    return { token: await args.appUserAuth.getValidTokenForRelay(), failure: null };
  } catch (error: unknown) {
    const failure = classifyAppUserAuthFailure(error);
    args.logger.warn(args.event, {
      error: failure.described.message,
      kind: failure.authFailure.kind,
      credentialState: failure.described.credentialState,
      status: failure.described.status,
      oauthError: failure.described.oauthError,
      retryAt: failure.authFailure.retryAt,
    });
    return { token: null, failure };
  }
}
