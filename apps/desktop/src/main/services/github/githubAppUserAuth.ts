export const ADE_GITHUB_APP_CLIENT_ID = "Iv23liy35Ed4L0oQODtl";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

export type GitHubAppUserTokenRecord = {
  accessToken: string;
  tokenType: string;
  scope: string | null;
  expiresAt: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
  userLogin: string | null;
  updatedAt: string;
};

export type GitHubAppDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  intervalSec: number;
};

export type GitHubAppDevicePollResult =
  | {
      status: "pending" | "slow_down";
      intervalSec: number;
      message: string | null;
    }
  | {
      status: "authorized";
      token: GitHubAppUserTokenRecord;
    }
  | {
      status: "expired" | "denied" | "error";
      message: string;
    };

type FetchImpl = typeof fetch;

/** Which GitHub OAuth endpoint produced a failure. */
export type GitHubOAuthEndpoint = "device_code" | "token";

/**
 * A GitHub OAuth failure with the parts a caller has to act on.
 *
 * GitHub answers a rejected refresh token with HTTP 200 and an `error` field, so
 * the transport cannot report failure by status alone; and it answers a
 * rate-limited client with 429 plus `retry-after`, which is the only honest
 * source for how long to wait. A bare `Error` carrying a string threw both away,
 * which is how a dead refresh token became an unbounded retry loop.
 */
export class GitHubOAuthError extends Error {
  constructor(
    message: string,
    readonly endpoint: GitHubOAuthEndpoint,
    readonly status: number,
    readonly oauthError: string | null,
    readonly errorDescription: string | null,
    readonly retryAfterSec: number | null,
  ) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

/**
 * OAuth error codes that mean "this credential will never work again".
 *
 * Everything outside this set is treated as transient, because retrying a
 * transient failure costs a request while giving up on a live credential costs
 * the user their connection.
 */
const DEFINITIVE_OAUTH_ERRORS: ReadonlySet<string> = new Set([
  "bad_refresh_token",
  "incorrect_client_credentials",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
]);

export function isDefinitiveGitHubOAuthError(oauthError: string | null | undefined): boolean {
  return typeof oauthError === "string" && DEFINITIVE_OAUTH_ERRORS.has(oauthError.trim());
}

function parseRetryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds));
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoFromExpiresIn(seconds: number | null, now = Date.now()): string | null {
  if (seconds == null || seconds <= 0) return null;
  return new Date(now + Math.trunc(seconds) * 1000).toISOString();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function postGitHubOAuthForm(args: {
  fetchImpl: FetchImpl;
  url: string;
  endpoint: GitHubOAuthEndpoint;
  userAgent: string;
  body: Record<string, string>;
}): Promise<{ payload: Record<string, unknown>; status: number; retryAfterSec: number | null }> {
  const response = await args.fetchImpl(args.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": args.userAgent,
    },
    body: new URLSearchParams(args.body).toString(),
  });
  const payload = parseJsonRecord(await response.json().catch(() => ({})));
  const retryAfterSec = parseRetryAfterSeconds(response);
  if (!response.ok) {
    const oauthError = readString(payload, "error") || null;
    const errorDescription = readString(payload, "error_description") || null;
    throw new GitHubOAuthError(
      errorDescription
        || oauthError
        || `GitHub OAuth request failed (${response.status})`,
      args.endpoint,
      response.status,
      oauthError,
      errorDescription,
      retryAfterSec,
    );
  }
  // An OK response keeps its payload: the device flow reads `error` itself to
  // tell "still waiting" from "denied", and only the refresh path treats an
  // error field as a failure.
  return { payload, status: response.status, retryAfterSec };
}

export async function startGitHubAppDeviceFlow(args: {
  clientId?: string | null;
  fetchImpl?: FetchImpl;
  userAgent: string;
}): Promise<GitHubAppDeviceCode> {
  const clientId = args.clientId?.trim() || ADE_GITHUB_APP_CLIENT_ID;
  const { payload } = await postGitHubOAuthForm({
    fetchImpl: args.fetchImpl ?? fetch,
    url: GITHUB_DEVICE_CODE_URL,
    endpoint: "device_code",
    userAgent: args.userAgent,
    body: { client_id: clientId },
  });
  const deviceCode = readString(payload, "device_code");
  const userCode = readString(payload, "user_code");
  const verificationUri = readString(payload, "verification_uri");
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("GitHub device authorization response was missing required fields.");
  }
  const expiresIn = readNumber(payload, "expires_in") ?? 900;
  const intervalSec = Math.max(1, readNumber(payload, "interval") ?? 5);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: readString(payload, "verification_uri_complete") || null,
    expiresAt: isoFromExpiresIn(expiresIn) ?? new Date(Date.now() + expiresIn * 1000).toISOString(),
    intervalSec,
  };
}

export async function pollGitHubAppDeviceFlow(args: {
  clientId?: string | null;
  deviceCode: string;
  intervalSec: number;
  fetchImpl?: FetchImpl;
  userAgent: string;
  fetchUserLogin?: (accessToken: string) => Promise<string | null>;
}): Promise<GitHubAppDevicePollResult> {
  const clientId = args.clientId?.trim() || ADE_GITHUB_APP_CLIENT_ID;
  const { payload } = await postGitHubOAuthForm({
    fetchImpl: args.fetchImpl ?? fetch,
    url: GITHUB_OAUTH_TOKEN_URL,
    endpoint: "token",
    userAgent: args.userAgent,
    body: {
      client_id: clientId,
      device_code: args.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
  const error = readString(payload, "error");
  if (error === "authorization_pending") {
    return { status: "pending", intervalSec: args.intervalSec, message: null };
  }
  if (error === "slow_down") {
    return {
      status: "slow_down",
      intervalSec: args.intervalSec + 5,
      message: readString(payload, "error_description") || "GitHub asked ADE to slow down polling.",
    };
  }
  if (error === "expired_token") {
    return { status: "expired", message: readString(payload, "error_description") || "GitHub device authorization expired." };
  }
  if (error === "access_denied") {
    return { status: "denied", message: readString(payload, "error_description") || "GitHub authorization was denied." };
  }
  if (error) {
    return { status: "error", message: readString(payload, "error_description") || error };
  }

  const accessToken = readString(payload, "access_token");
  if (!accessToken) return { status: "error", message: "GitHub did not return a user access token." };
  const userLogin = args.fetchUserLogin ? await args.fetchUserLogin(accessToken).catch(() => null) : null;
  return {
    status: "authorized",
    token: {
      accessToken,
      tokenType: readString(payload, "token_type") || "bearer",
      scope: readString(payload, "scope") || null,
      expiresAt: isoFromExpiresIn(readNumber(payload, "expires_in")),
      refreshToken: readString(payload, "refresh_token") || null,
      refreshTokenExpiresAt: isoFromExpiresIn(readNumber(payload, "refresh_token_expires_in")),
      userLogin,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function refreshGitHubAppUserToken(args: {
  clientId?: string | null;
  refreshToken: string;
  fetchImpl?: FetchImpl;
  userAgent: string;
  fetchUserLogin?: (accessToken: string) => Promise<string | null>;
}): Promise<GitHubAppUserTokenRecord> {
  const clientId = args.clientId?.trim() || ADE_GITHUB_APP_CLIENT_ID;
  const { payload, status, retryAfterSec } = await postGitHubOAuthForm({
    fetchImpl: args.fetchImpl ?? fetch,
    url: GITHUB_OAUTH_TOKEN_URL,
    endpoint: "token",
    userAgent: args.userAgent,
    body: {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    },
  });
  // GitHub reports a rejected refresh token as HTTP 200 with an error body. It
  // has to be read here, or a dead credential looks exactly like a malformed
  // response and gets retried forever.
  const oauthError = readString(payload, "error");
  if (oauthError) {
    const errorDescription = readString(payload, "error_description") || null;
    throw new GitHubOAuthError(
      errorDescription || `GitHub rejected the refresh token (${oauthError}).`,
      "token",
      status,
      oauthError,
      errorDescription,
      retryAfterSec,
    );
  }
  const accessToken = readString(payload, "access_token");
  if (!accessToken) {
    throw new GitHubOAuthError(
      "GitHub did not return a refreshed user access token.",
      "token",
      status,
      null,
      null,
      retryAfterSec,
    );
  }
  const userLogin = args.fetchUserLogin ? await args.fetchUserLogin(accessToken).catch(() => null) : null;
  return {
    accessToken,
    tokenType: readString(payload, "token_type") || "bearer",
    scope: readString(payload, "scope") || null,
    expiresAt: isoFromExpiresIn(readNumber(payload, "expires_in")),
    refreshToken: readString(payload, "refresh_token") || args.refreshToken,
    refreshTokenExpiresAt: isoFromExpiresIn(readNumber(payload, "refresh_token_expires_in")),
    userLogin,
    updatedAt: new Date().toISOString(),
  };
}

