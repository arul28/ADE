import { trustedHttpsOrigin } from "../trustedOrigin";

/**
 * The GitHub calls this Worker makes for the ADE GitHub App user token:
 * the web-flow code exchange, the refresh, `GET /user`, and the token check
 * and delete of the OAuth applications API.
 *
 * Every function returns a classified result and never throws for an HTTP
 * or network failure. No result, error or log line carries a token, a code,
 * a verifier, or the client secret.
 *
 * GitHub answers a refused token request with HTTP 200 and an `error` field
 * (the desktop reads it the same way: `githubAppUserAuth.ts`), so the body is
 * read before the status is trusted.
 */

export type GithubOAuthConfig = {
  clientId: string;
  /** Null for a refresh of a device-flow token, which GitHub takes with no secret. */
  clientSecret: string | null;
  webBase: string;
  apiBase: string;
};

export type GithubTokens = {
  accessToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
};

export type GithubTokenFailure =
  /** The refresh token is spent, revoked or expired. */
  | { kind: "bad_refresh_token" }
  /** The code, verifier or redirect was refused (a reused code, a PKCE mismatch). */
  | { kind: "refused"; oauthError: string }
  /** The client id or secret is wrong: a Worker setting, not the user's grant. */
  | { kind: "client_credentials"; oauthError: string }
  /** 429, 5xx, a network failure, a timeout, or a 200 with no token. */
  | { kind: "transient"; status: number; retryAfterSec: number | null };

export type GithubTokenResult = { ok: true; tokens: GithubTokens } | ({ ok: false } & GithubTokenFailure);

const USER_AGENT = "ADE-account-directory";
const API_VERSION = "2022-11-28";
/** Below the 45 s lease, so a hung request never outlives the lease that guards it. */
export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
/** A token with no expiry (the App's "expire user tokens" setting off) is served as if it lived this long. */
export const NON_EXPIRING_ACCESS_AT = 8_640_000_000_000;

const DEFAULT_WEB_BASE = "https://github.com";
const DEFAULT_API_BASE = "https://api.github.com";

/** The two base URLs, or null when one is set to something this Worker will not trust. */
export function githubBases(env: { GITHUB_WEB_BASE_URL?: string; GITHUB_API_BASE_URL?: string }): { webBase: string; apiBase: string } | null {
  const webBase = env.GITHUB_WEB_BASE_URL?.trim() ? trustedHttpsOrigin(env.GITHUB_WEB_BASE_URL) : DEFAULT_WEB_BASE;
  const apiBase = env.GITHUB_API_BASE_URL?.trim() ? trustedHttpsOrigin(env.GITHUB_API_BASE_URL) : DEFAULT_API_BASE;
  return webBase && apiBase ? { webBase, apiBase } : null;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 3600);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(3600, Math.ceil((at - Date.now()) / 1000))) : null;
}

const readString = (payload: Record<string, unknown> | null, key: string): string | null =>
  typeof payload?.[key] === "string" && (payload[key] as string).trim() ? (payload[key] as string).trim() : null;

const readNumber = (payload: Record<string, unknown> | null, key: string): number | null => {
  const value = payload?.[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json() as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const CLIENT_CREDENTIAL_ERRORS = new Set(["incorrect_client_credentials", "invalid_client"]);

async function postTokenForm(config: GithubOAuthConfig, form: Record<string, string>, now: number): Promise<GithubTokenResult> {
  let response: Response;
  try {
    response = await fetch(`${config.webBase}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "transient", status: 0, retryAfterSec: null };
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, kind: "transient", status: response.status, retryAfterSec: retryAfterSeconds(response) };
  }
  const payload = await readJson(response);
  const oauthError = readString(payload, "error");
  if (oauthError === "bad_refresh_token") return { ok: false, kind: "bad_refresh_token" };
  if (oauthError && CLIENT_CREDENTIAL_ERRORS.has(oauthError)) return { ok: false, kind: "client_credentials", oauthError };
  if (oauthError) return { ok: false, kind: "refused", oauthError: oauthError.slice(0, 64) };
  const accessToken = readString(payload, "access_token");
  if (!response.ok || !accessToken) {
    return { ok: false, kind: "transient", status: response.ok ? 502 : response.status, retryAfterSec: retryAfterSeconds(response) };
  }
  const expiresIn = readNumber(payload, "expires_in");
  const refreshToken = readString(payload, "refresh_token");
  const refreshExpiresIn = readNumber(payload, "refresh_token_expires_in");
  return {
    ok: true,
    tokens: {
      accessToken,
      accessExpiresAt: expiresIn ? now + expiresIn * 1000 : NON_EXPIRING_ACCESS_AT,
      refreshToken,
      refreshExpiresAt: refreshToken && refreshExpiresIn ? now + refreshExpiresIn * 1000 : null,
    },
  };
}

/** The web-flow code exchange (client secret and PKCE verifier). */
export function exchangeCode(
  config: GithubOAuthConfig & { clientSecret: string },
  args: { code: string; redirectUri: string; codeVerifier: string },
  now: number,
): Promise<GithubTokenResult> {
  return postTokenForm(config, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  }, now);
}

/** A refresh. `clientSecret: null` for a token that came from the device flow. */
export function refreshTokens(config: GithubOAuthConfig, refreshToken: string, now: number): Promise<GithubTokenResult> {
  return postTokenForm(config, {
    client_id: config.clientId,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, now);
}

/** `createdAt`: when the GitHub account was made (ms), when GitHub's answer named it (`GET /user` does; the token check's user doesn't). */
export type GithubUser = { id: number; login: string; createdAt?: number | null };
export type GithubUserResult = { ok: true; user: GithubUser } | { ok: false; kind: "invalid_token" | "transient" };

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function parseUser(value: unknown): GithubUser | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const login = record.login;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof login !== "string" || !LOGIN.test(login)) return null;
  const createdAt = typeof record.created_at === "string" ? Date.parse(record.created_at) : NaN;
  return { id, login, createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null };
}

/** `GET /user` with the user token: the GitHub id and login it belongs to. */
export async function readGithubUser(config: GithubOAuthConfig, accessToken: string): Promise<GithubUserResult> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}/user`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION,
      },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "transient" };
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, kind: "invalid_token" };
  }
  const user = response.ok ? parseUser(await readJson(response)) : null;
  if (!response.ok) await response.body?.cancel().catch(() => {});
  return user ? { ok: true, user } : { ok: false, kind: "transient" };
}

function basicAuth(config: GithubOAuthConfig & { clientSecret: string }): string {
  return `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
}

export type GithubTokenCheck =
  | { kind: "valid"; user: GithubUser | null }
  | { kind: "invalid" }
  | { kind: "transient" };

/**
 * `POST /applications/{client_id}/token`: is this token one of this App's,
 * and still valid? 404 (and 422) mean no.
 */
export async function checkToken(config: GithubOAuthConfig & { clientSecret: string }, accessToken: string): Promise<GithubTokenCheck> {
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: basicAuth(config),
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION,
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "transient" };
  }
  if (response.status === 404 || response.status === 422) {
    await response.body?.cancel().catch(() => {});
    return { kind: "invalid" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { kind: "transient" };
  }
  const payload = await readJson(response);
  return { kind: "valid", user: parseUser(payload?.user) };
}

/**
 * `DELETE /applications/{client_id}/token`: deletes one token, never the
 * whole authorization (other ADE accounts and old machines keep theirs).
 * True when GitHub confirmed it or no longer knows the token.
 */
export async function deleteToken(config: GithubOAuthConfig & { clientSecret: string }, accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${config.apiBase}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: basicAuth(config),
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION,
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.status === 204 || response.status === 404 || response.status === 422;
  } catch {
    return false;
  }
}
