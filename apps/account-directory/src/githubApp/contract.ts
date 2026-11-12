/**
 * The ADE GitHub App sign-in that belongs to the account (migration 0031).
 * Paths, request and response shapes, and limits only: nothing here imports
 * the Worker, so the desktop, the brain, the web client and the phone can
 * `import type` it or mirror it.
 *
 * The account directory holds one GitHub App user token chain per ADE
 * account. It keeps the refresh token sealed and renews the access token
 * itself. A client gets the access token only, with a relative deadline
 * (`useForSec`): it stops using the token at `receivedAt + useForSec - 30 s`
 * and asks again. The server refreshes only after that shared deadline, so a
 * refresh never kills a token that a client still uses.
 *
 * Every route takes the account token as a bearer, except the two browser
 * pages (`callback`, `installed`). Errors are `{ error: { code, message } }`,
 * and `message` is one plain sentence. Without the Worker secrets
 * `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_TOKEN_KEY` every bearer route
 * answers 503 `github_app_not_configured`.
 *
 *   POST   /github/app/sign-in          GithubAppSignInStartResponse   (body: GithubAppSignInStartRequest)
 *   GET    /github/app/sign-in/:id      GithubAppSignInReadResponse
 *   GET    /github/app/callback         browser page or redirect (GitHub sends the browser here)
 *   POST   /github/app/token            GithubAppTokenResponse         (body: GithubAppTokenRequest)
 *   GET    /github/app/status           GithubAppStatusResponse
 *   DELETE /github/app/grant            GithubAppDisconnectResponse
 *   POST   /github/app/adopt            GithubAppAdoptResponse         (body: GithubAppAdoptRequest)
 *   POST   /github/app/retire           204                            (body: GithubAppRetireRequest)
 *   GET    /github/app/installed        browser page (the App's Setup URL)
 *
 * Browsers may call `sign-in`, `sign-in/:id`, `token`, `status` and `grant`
 * from the hosted web client's exact origin (`WEB_CLIENT_ORIGIN`). `adopt`
 * and `retire` are for machines only. Native callers send no Origin. Any
 * other Origin is refused before the token is read.
 */

export const GITHUB_APP_PATHS = {
  root: "/github/app",
  signIn: "/github/app/sign-in",
  callback: "/github/app/callback",
  token: "/github/app/token",
  status: "/github/app/status",
  grant: "/github/app/grant",
  adopt: "/github/app/adopt",
  retire: "/github/app/retire",
  installed: "/github/app/installed",
} as const;

/** `/github/app/sign-in/:id`. */
export const githubAppSignInPath = (id: string): string => `${GITHUB_APP_PATHS.signIn}/${encodeURIComponent(id)}`;

/** A sign-in id, made by the server: `gs_` and 32 hex characters. */
export const GITHUB_APP_SIGN_IN_ID_PATTERN = /^gs_[0-9a-f]{32}$/;

export type GithubAppClientKind = "desktop" | "web" | "ios" | "cli";

/** How long a sign-in link works. */
export const GITHUB_APP_SIGN_IN_TTL_MS = 10 * 60_000;
/** The server never hands out a token with less than this left. */
export const GITHUB_APP_TOKEN_MARGIN_MS = 20 * 60_000;
/** A client stops this long before `useForSec` runs out. */
export const GITHUB_APP_CLIENT_SAFETY_SEC = 30;
/** Sign-ins one account may start in ten minutes. */
export const GITHUB_APP_SIGN_IN_LIMIT_PER_10_MIN = 10;
/** Token requests one account may make in an hour. */
export const GITHUB_APP_TOKEN_LIMIT_PER_HOUR = 120;
/** Adopt and retire requests one account may make in an hour (each). */
export const GITHUB_APP_ADOPT_LIMIT_PER_HOUR = 20;
export const GITHUB_APP_RETIRE_LIMIT_PER_HOUR = 20;
/** Largest request body the routes read. */
export const GITHUB_APP_MAX_BODY_BYTES = 16 * 1024;
/** Where a person revokes the whole App authorization (all tokens, every machine). */
export const GITHUB_APP_REVOKE_URL = "https://github.com/settings/apps/authorizations";

export type GithubAppSignInStartRequest = {
  client: GithubAppClientKind;
  /** Web only: must start with `WEB_CLIENT_ORIGIN + "/"`. Ignored for other clients. */
  returnTo?: string;
};

export type GithubAppSignInStartResponse = {
  signInId: string;
  /** Open this in the system browser (desktop, CLI), the same tab (web), or ASWebAuthenticationSession (phone). */
  authorizeUrl: string;
  /** Epoch ms. */
  expiresAt: number;
};

/**
 * `pending`: the person has not finished at GitHub yet. `done`: the grant is
 * saved. `failed`: they cancelled (`resultCode: "denied"`) or GitHub refused
 * (`"error"`). `expired`: the link ran out.
 */
export type GithubAppSignInStatus = "pending" | "done" | "failed" | "expired";

export type GithubAppSignInReadResponse = {
  status: GithubAppSignInStatus;
  resultCode: "ok" | "denied" | "error" | null;
  githubLogin: string | null;
};

/**
 * `expired`: the cached token passed its `useForSec`. `rejected`: GitHub
 * answered 401 to it; send its SHA-256 (lowercase hex) so the server can tell
 * a stale copy from a revoked token.
 */
export type GithubAppTokenRequest = {
  reason?: "expired" | "rejected";
  rejectedTokenSha256?: string;
};

export type GithubAppTokenResponse = {
  accessToken: string;
  /** Epoch ms when GitHub stops taking the token. Informational: obey `useForSec`. */
  expiresAt: number;
  /** Seconds from receipt. Stop using the token at `receivedAt + useForSec - 30 s`. */
  useForSec: number;
  githubLogin: string;
  githubUserId: number;
  /** +1 on every refresh or new sign-in. */
  generation: number;
  /** Only after `rejected`: GitHub says the token is valid, so the 401 came from something else (SAML, a repo rule). */
  verified?: boolean;
  /** The server could not renew (GitHub down or rate limited) and serves the old token for a short time. */
  degraded?: boolean;
};

/**
 * Error codes of `POST /github/app/token`:
 * 404 `not_connected`; 409 `needs_reauth` with `reason`;
 * 503 `renewing` or `github_unavailable` with `retry-after` (seconds);
 * 429 `rate_limited` with `retry-after`.
 */
export type GithubAppNeedsReauthReason = "bad_refresh_token" | "refresh_expired" | "unpersisted_refresh" | "revoked";

export type GithubAppStatusResponse = {
  connected: boolean;
  state: "active" | "needs_reauth" | null;
  stateReason: GithubAppNeedsReauthReason | null;
  githubLogin: string | null;
  githubUserId: number | null;
  /** Epoch ms of the sign-in or adoption that made this grant. */
  connectedAt: number | null;
  /** Epoch ms; the grant ends then unless something asks for a token first. */
  refreshExpiresAt: number | null;
  origin: "web_flow" | "adopted_device_flow" | null;
};

export type GithubAppDisconnectResponse = {
  ok: true;
  /** Whether GitHub confirmed the token delete. False when GitHub was not reachable. */
  deletedAtGitHub: boolean;
  revokeAtGitHubUrl: string;
};

/** A device-flow record from a machine's credential store (`github.appUserToken.v1`). Times are ISO strings or epoch ms. */
export type GithubAppAdoptRequest = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string | number;
  refreshTokenExpiresAt: string | number;
};

/**
 * 201 `{ adopted: true, githubLogin, generation }`.
 * 409 `already_connected` with `githubLogin` (the account's login; compare it
 * with the local record's). 400 `not_this_app` when GitHub does not know the
 * token as one of this App's.
 */
export type GithubAppAdoptResponse = {
  adopted: true;
  githubLogin: string;
  generation: number;
};

export type GithubAppRetireRequest = {
  accessToken: string;
};
