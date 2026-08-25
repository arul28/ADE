import type {
  GitHubAppUserAuthCredentialState,
  GitHubAppUserAuthStatus,
  GitHubAppUserAuthUnavailable,
  GitHubAuthFailure,
  GitHubRateLimitState,
} from "../../../shared/types";
import { GITHUB_APP_USER_AUTH_RENEWING_COPY } from "../../../shared/types";
import { isGitHubOAuthError, type GitHubOAuthError } from "./githubAppUserAuth";
import type { RefreshFailureKind, StoredRefreshFailure } from "./githubAppUserAuthLedger";
import { classifyGitHubAuthFailure, isDefinitiveGitHubOAuthError } from "./githubRateLimit";

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

/** What the two relay-token helpers below write their one log line through. */
type AppUserAuthLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export type AppUserAuthFailure = {
  authFailure: GitHubAuthFailure;
  rateLimit: GitHubRateLimitState | null;
  described: ReturnType<typeof describeGitHubAppUserAuthFailure>;
};

/**
 * The credential-failure kind a classified refresh failure already names, or
 * null when the refresh path did not classify it.
 *
 * The refresh path saw the OAuth response itself, so its verdict is the precise
 * one. Re-deriving the kind from the message and status of the error it threw
 * throws that away: the service reports a paused renewal with the status of the
 * failure BELOW it, and GitHub answers a secondary rate limit with a bare 403 —
 * which the generic classifier reads as "permission denied", an accusation
 * against the account that nothing supports.
 */
function authFailureKindForRefreshKind(
  kind: RefreshFailureKind | null,
): GitHubAuthFailure["kind"] | null {
  switch (kind) {
    case "rate_limited":
      return "rate_limited";
    case "outage":
      return "service_unavailable";
    case "network":
      return "network";
    case "dead_token":
      return "invalid_token";
    default:
      return null;
  }
}

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
  if (described.credentialState === "blocked" && described.failureKind === null) {
    // Blocked with nothing refused is ADE waiting on its own refresh lease: one
    // process on this machine renews the credential and the rest wait a moment.
    // The repo axis already says so; the credential inventory said "GitHub
    // authentication check failed" for the same wait, which reads as a broken
    // account. Carry the same sentence onto both axes.
    return {
      described,
      rateLimit: classified.rateLimit,
      authFailure: {
        kind: "renewing",
        message: GITHUB_APP_USER_AUTH_RENEWING_COPY,
        retryAt: described.retryAt,
      },
    };
  }
  const namedKind = authFailureKindForRefreshKind(described.failureKind);
  if (namedKind) {
    return {
      described,
      rateLimit: classified.rateLimit,
      authFailure: {
        kind: namedKind,
        message: described.message,
        // A dead credential has no deadline to wait for; every other named kind
        // carries the instant ADE will try again.
        retryAt: namedKind === "invalid_token" ? null : described.retryAt,
      },
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
    // Null when GitHub never refused anything — the wait belongs to ADE's own
    // refresh lease, and the copy has to say that instead of blaming GitHub.
    failureKind: failure.described.failureKind,
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
  logger: AppUserAuthLogger;
  /** The log event name, which differs by call site. */
  event: string;
}): Promise<{ token: string | null; failure: AppUserAuthFailure | null }> {
  try {
    return { token: await args.appUserAuth.getValidTokenForRelay(), failure: null };
  } catch (error: unknown) {
    const failure = classifyAppUserAuthFailure(error);
    const meta = {
      error: failure.described.message,
      kind: failure.authFailure.kind,
      credentialState: failure.described.credentialState,
      status: failure.described.status,
      oauthError: failure.described.oauthError,
      retryAt: failure.authFailure.retryAt,
    };
    // A machine that never authorized the App has nothing wrong with it. Warning
    // on every credential read there fills the log of an ordinary install with a
    // problem nobody has.
    if (failure.described.credentialState === "missing") args.logger.info(args.event, meta);
    else args.logger.warn(args.event, meta);
    return { token: null, failure };
  }
}

/**
 * The same lookup, for the callers that must not ask at all when no credential
 * is stored.
 *
 * Building a credential inventory is the hot path — every status read, PR call
 * and relay poll builds one — and asking for a token that was never stored
 * costs a store read and a classified failure per call. The guard is spelled
 * here so both twins gate the same way.
 */
export async function resolveStoredAppUserTokenForRelay(args: {
  status: Pick<GitHubAppUserAuthStatus, "tokenStored">;
  appUserAuth: { getValidTokenForRelay(): Promise<string> };
  logger: AppUserAuthLogger;
  event: string;
}): Promise<{ token: string | null; failure: AppUserAuthFailure | null }> {
  if (!args.status.tokenStored) return { token: null, failure: null };
  return await resolveAppUserTokenForRelay(args);
}
