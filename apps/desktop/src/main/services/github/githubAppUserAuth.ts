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
  userAgent: string;
  body: Record<string, string>;
}): Promise<Record<string, unknown>> {
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
  if (!response.ok) {
    const message = readString(payload, "error_description")
      || readString(payload, "error")
      || `GitHub OAuth request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

export async function startGitHubAppDeviceFlow(args: {
  clientId?: string | null;
  fetchImpl?: FetchImpl;
  userAgent: string;
}): Promise<GitHubAppDeviceCode> {
  const clientId = args.clientId?.trim() || ADE_GITHUB_APP_CLIENT_ID;
  const payload = await postGitHubOAuthForm({
    fetchImpl: args.fetchImpl ?? fetch,
    url: GITHUB_DEVICE_CODE_URL,
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
  const payload = await postGitHubOAuthForm({
    fetchImpl: args.fetchImpl ?? fetch,
    url: GITHUB_OAUTH_TOKEN_URL,
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
  const payload = await postGitHubOAuthForm({
    fetchImpl: args.fetchImpl ?? fetch,
    url: GITHUB_OAUTH_TOKEN_URL,
    userAgent: args.userAgent,
    body: {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    },
  });
  const accessToken = readString(payload, "access_token");
  if (!accessToken) throw new Error("GitHub did not return a refreshed user access token.");
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

