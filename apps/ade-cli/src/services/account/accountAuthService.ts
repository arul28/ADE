import { createHash, randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  isClerkDevelopmentIssuer,
  isClerkDevelopmentOAuthClientId,
  shouldIgnoreDevelopmentAccountDirectoryUrl,
  shouldIgnoreDevelopmentClerkConfiguration,
  warnDevelopmentClerkIgnored,
} from "../../../../desktop/src/shared/accountDirectory";
import type { SyncCredentialStore } from "../credentials/credentialStore";

export const ACCOUNT_SESSION_CREDENTIAL_KEY = "account.session.v1";

const LOOPBACK_HOST = "127.0.0.1";
const LOGIN_SESSION_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
const MAX_PENDING_LOGIN_SESSIONS = 5;
const DEVICE_BRIDGE_REQUEST_TIMEOUT_MS = 15_000;
const USERINFO_REQUEST_TIMEOUT_MS = 5_000;
const ACCOUNT_TOKEN_ENV_KEY = "ADE_ACCOUNT_TOKEN";
const PROVISIONED_ACCOUNT_TOKEN_PREFIX = "ade_account_v1.";
const SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Signed in to ADE</title>
  </head>
  <body>
    <main>
      <h1>Signed in to ADE</h1>
      <p>You can close this tab — signed in to ADE.</p>
    </main>
  </body>
</html>`;
const FAILURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ADE sign-in failed</title>
  </head>
  <body>
    <main>
      <h1>ADE sign-in failed</h1>
      <p>Return to ADE and try signing in again.</p>
    </main>
  </body>
</html>`;

export type AccountOAuthConfig = {
  issuer: string;
  clientId: string;
};

export type AccountSessionRecord = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string;
  obtainedAt: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  provider?: AccountIdentityProvider | null;
  imageUrl?: string | null;
  authSource?: Exclude<AccountAuthSource, "env-token" | null>;
  suppressEnvCredential?: true;
  oauthConfig?: AccountOAuthConfig;
};

export type AccountAuthSource = "loopback" | "device" | "env-token" | null;

export type AccountIdentityProvider = "github" | "google" | "apple" | "email";

export type AccountAuthStatus = {
  signedIn: boolean;
  userId: string | null;
  email: string | null;
  name: string | null;
  expiresAt: string | null;
  source?: AccountAuthSource;
  provider?: AccountIdentityProvider | null;
  imageUrl?: string | null;
};

export type AccountSessionReadState = "available" | "missing" | "unreadable";

export type AccountLoginStartResult = {
  sessionId: string;
  authorizeUrl: string;
  expiresAt: string;
};

export type AccountLoginPollResult = {
  status: "pending" | "signed_in" | "expired" | "error";
  message: string | null;
  authStatus: AccountAuthStatus;
};

export type AccountDeviceLoginStartResult = {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  intervalSec: number;
};

export type AccountDeviceLoginPollResult = {
  status: "pending" | "slow_down" | "signed_in" | "expired" | "error";
  message: string | null;
  intervalSec: number | null;
  authStatus: AccountAuthStatus;
};

export type AccountTokenCreateResult = {
  token: string;
  source: "refresh_token";
  guidance: string;
};

type AccountAuthLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

type PendingLoginSession = {
  sessionId: string;
  oauthConfig: AccountOAuthConfig;
  codeVerifier: string;
  oauthState: string;
  redirectUri: string;
  expiresAtMs: number;
  server: Server;
  expiryTimer: NodeJS.Timeout;
  phase: "pending" | "exchanging" | "signed_in" | "expired" | "error";
  message: string | null;
};

type PendingDeviceLoginSession = {
  sessionId: string;
  bridgeUrl: string;
  deviceCode: string;
  deviceSecret: string;
  expiresAtMs: number;
  intervalSec: number;
  suppressEnvCredential: boolean;
};

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresInSec: number;
};

class AccountTokenRequestError extends Error {
  constructor(
    message: string,
    readonly oauthErrorCode: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountTokenRequestError";
  }
}

export type AccountAuthService = {
  startLogin(): Promise<AccountLoginStartResult>;
  pollLogin(sessionId: string): Promise<AccountLoginPollResult>;
  startDeviceLogin(options?: { ignoreEnvCredential?: boolean }): Promise<AccountDeviceLoginStartResult>;
  pollDeviceLogin(sessionId: string): Promise<AccountDeviceLoginPollResult>;
  getStatus(): AccountAuthStatus;
  /** Last persisted-session read result, refreshed by getStatus/getAccessToken. */
  getSessionReadState(): AccountSessionReadState;
  getAccessToken(): Promise<string>;
  createToken(): Promise<AccountTokenCreateResult>;
  cancelLogin(sessionId: string): void;
  signOut(): AccountAuthStatus;
  /** Notification emitted after a local or externally persisted sign-in. */
  onSignedIn(listener: () => void): () => void;
  dispose(): void;
};

export type AccountActionDomainService = {
  startLogin(): Promise<AccountLoginStartResult>;
  pollLogin(args: { sessionId?: string }): Promise<AccountLoginPollResult>;
  startDeviceLogin(args?: { ignoreEnvCredential?: boolean }): Promise<AccountDeviceLoginStartResult>;
  pollDeviceLogin(args: { sessionId?: string }): Promise<AccountDeviceLoginPollResult>;
  status(): AccountAuthStatus;
  cancelLogin(args: { sessionId?: string }): void;
  signOut(): AccountAuthStatus;
  getToken(): Promise<string>;
  createToken(): Promise<AccountTokenCreateResult>;
};

export async function getSignedInAccountAccessToken(
  service: Pick<AccountAuthService, "getStatus" | "getAccessToken">,
): Promise<string | null> {
  const status = service.getStatus();
  if (!status.signedIn && status.source !== "env-token") return null;
  try {
    const accessToken = (await service.getAccessToken()).trim();
    return accessToken && service.getStatus().userId ? accessToken : null;
  } catch {
    // Relay account credentials are additive. An unavailable refresh must not
    // block the independent GitHub, Linear, or ade_proj_ authorization path.
    return null;
  }
}

export const ACCOUNT_ACTION_NAMES = [
  "startLogin",
  "pollLogin",
  "startDeviceLogin",
  "pollDeviceLogin",
  "status",
  "cancelLogin",
  "signOut",
  "getToken",
  "createToken",
] as const;

type AccountActionName = (typeof ACCOUNT_ACTION_NAMES)[number];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readAuthSource(value: unknown): AccountSessionRecord["authSource"] {
  return value === "device" ? "device" : value === "loopback" ? "loopback" : undefined;
}

function readIdentityProvider(value: unknown): AccountIdentityProvider | null {
  const normalized = readNonEmptyString(value)?.toLowerCase().replace(/^oauth_/, "");
  if (
    normalized === "github"
    || normalized === "google"
    || normalized === "apple"
    || normalized === "email"
  ) {
    return normalized;
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    return asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function accessTokenExpiresAt(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  const expiresAt = new Date(Math.trunc(exp * 1000));
  return Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null;
}

function accessTokenIssuer(token: string): string | null {
  return readNonEmptyString(decodeJwtPayload(token)?.iss);
}

function isDevelopmentOAuthConfig(
  config: AccountOAuthConfig | null | undefined,
): boolean {
  return isClerkDevelopmentIssuer(config?.issuer)
    || isClerkDevelopmentOAuthClientId(config?.clientId);
}

function shouldRejectDevelopmentAccountMaterial(args: {
  env: NodeJS.ProcessEnv;
  accessToken?: string | null;
  oauthConfig?: AccountOAuthConfig | null;
}): boolean {
  return shouldIgnoreDevelopmentClerkConfiguration(args.env)
    && (
      isDevelopmentOAuthConfig(args.oauthConfig)
      || isClerkDevelopmentIssuer(
        args.accessToken ? accessTokenIssuer(args.accessToken) : null,
      )
    );
}

function classifyEnvCredential(token: string): "access_token" | "refresh_token" {
  const payload = decodeJwtPayload(token);
  if (!payload) return "refresh_token";
  const tokenUse = readNonEmptyString(payload.token_use ?? payload.typ ?? payload.type)?.toLowerCase();
  return tokenUse?.includes("refresh") ? "refresh_token" : "access_token";
}

type EnvCredential =
  | { kind: "access_token"; token: string }
  | { kind: "refresh_token"; token: string; oauthConfig: AccountOAuthConfig | null }
  | { kind: "invalid" };

function provisionedAccountToken(args: {
  refreshToken: string;
  oauthConfig: AccountOAuthConfig;
}): string {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    refreshToken: args.refreshToken,
    issuer: args.oauthConfig.issuer,
    clientId: args.oauthConfig.clientId,
  }), "utf8").toString("base64url");
  return `${PROVISIONED_ACCOUNT_TOKEN_PREFIX}${payload}`;
}

function inspectEnvCredential(credential: string): EnvCredential {
  if (credential.startsWith(PROVISIONED_ACCOUNT_TOKEN_PREFIX)) {
    try {
      const encoded = credential.slice(PROVISIONED_ACCOUNT_TOKEN_PREFIX.length);
      const payload = asRecord(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      const refreshToken = readNonEmptyString(payload.refreshToken);
      const issuer = readNonEmptyString(payload.issuer);
      const clientId = readNonEmptyString(payload.clientId);
      if (payload.version !== 1 || !refreshToken || !issuer || !clientId) return { kind: "invalid" };
      return {
        kind: "refresh_token",
        token: refreshToken,
        oauthConfig: { issuer, clientId },
      };
    } catch {
      return { kind: "invalid" };
    }
  }
  return classifyEnvCredential(credential) === "access_token"
    ? { kind: "access_token", token: credential }
    : { kind: "refresh_token", token: credential, oauthConfig: null };
}

function isLoopbackIssuerHost(hostname: string): boolean {
  // `new URL("http://[::1]/").hostname` returns "[::1]" (brackets included), so
  // accept both bracketed and bare IPv6 loopback forms.
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

function normalizeOAuthConfig(config: AccountOAuthConfig): AccountOAuthConfig {
  const issuer = config.issuer.trim().replace(/\/+$/, "");
  const clientId = config.clientId.trim();
  if (!issuer || !clientId) {
    throw new Error(
      "ADE account login is not configured. Set CLERK_ISSUER and CLERK_OAUTH_CLIENT_ID in ADE project secrets or the daemon environment.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error("CLERK_ISSUER must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("CLERK_ISSUER must be a valid HTTP(S) URL.");
  }
  // Plaintext http exposes the authorization code / bearer tokens on the wire,
  // so only permit it against a loopback/local-dev issuer; everything else must
  // use https.
  if (parsed.protocol === "http:" && !isLoopbackIssuerHost(parsed.hostname)) {
    throw new Error("CLERK_ISSUER must use https (http is only allowed for localhost).");
  }
  return { issuer, clientId };
}

function normalizeRuntimeOAuthConfig(
  config: AccountOAuthConfig,
  env: NodeJS.ProcessEnv,
): AccountOAuthConfig {
  if (
    shouldIgnoreDevelopmentClerkConfiguration(env)
    && isDevelopmentOAuthConfig(config)
  ) {
    warnDevelopmentClerkIgnored();
    return normalizeOAuthConfig({
      issuer: DEFAULT_ADE_CLERK_ISSUER,
      clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
    });
  }
  return normalizeOAuthConfig(config);
}

function normalizeOptionalOAuthConfig(args: {
  present: boolean;
  issuer: unknown;
  clientId: unknown;
}): AccountOAuthConfig | null {
  if (!args.present) return null;
  const issuer = readNonEmptyString(args.issuer);
  const clientId = readNonEmptyString(args.clientId);
  if (!issuer || !clientId) {
    throw new Error("ADE account OAuth context was incomplete.");
  }
  return normalizeOAuthConfig({ issuer, clientId });
}

function normalizeDeviceBridgeUrl(rawUrl: string): string {
  const normalized = rawUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error(
      "ADE account device login is not configured. Set ADE_ACCOUNT_DIRECTORY_URL in ADE project secrets or the daemon environment.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("ADE_ACCOUNT_DIRECTORY_URL must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackIssuerHost(parsed.hostname))) {
    throw new Error("ADE_ACCOUNT_DIRECTORY_URL must use https (http is only allowed for localhost).");
  }
  return normalized;
}

export function derivePkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

function encodeAuthorizeQuery(entries: Array<[string, string]>): string {
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function buildAuthorizeUrl(args: {
  config: AccountOAuthConfig;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const query = encodeAuthorizeQuery([
    ["response_type", "code"],
    ["client_id", args.config.clientId],
    ["redirect_uri", args.redirectUri],
    ["code_challenge", args.codeChallenge],
    ["code_challenge_method", "S256"],
    ["state", args.state],
    ["scope", "openid profile email offline_access"],
  ]);
  return `${args.config.issuer}/oauth/authorize?${query}`;
}

function isMatchingState(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function closeServer(server: Server): void {
  try {
    server.close();
  } catch {
    // The listener may already be closed by a completed callback.
  }
}

function respondHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    connection: "close",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

function decodeAccountClaims(accessToken: string): {
  userId: string | null;
  email: string | null;
  name: string | null;
  provider: AccountIdentityProvider | null;
  imageUrl: string | null;
} {
  try {
    const claims = decodeJwtPayload(accessToken);
    if (!claims) {
      return { userId: null, email: null, name: null, provider: null, imageUrl: null };
    }
    const givenName = readNonEmptyString(claims.given_name ?? claims.first_name);
    const familyName = readNonEmptyString(claims.family_name ?? claims.last_name);
    const derivedName = [givenName, familyName].filter(Boolean).join(" ") || null;
    return {
      userId: readNonEmptyString(claims.sub),
      email: readNonEmptyString(claims.email ?? claims.primary_email ?? claims.email_address),
      name: readNonEmptyString(claims.name) ?? derivedName,
      provider: readIdentityProvider(
        claims.provider ?? claims.identity_provider ?? claims.idp,
      ),
      imageUrl: readNonEmptyString(claims.picture ?? claims.image_url ?? claims.avatar_url),
    };
  } catch {
    return { userId: null, email: null, name: null, provider: null, imageUrl: null };
  }
}

function parseStoredSession(raw: string | null | undefined): AccountSessionRecord | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = asRecord(JSON.parse(raw));
    const accessToken = readNonEmptyString(parsed.accessToken);
    const expiresAt = readNonEmptyString(parsed.expiresAt);
    const obtainedAt = readNonEmptyString(parsed.obtainedAt);
    if (!accessToken || !expiresAt || !obtainedAt) return null;
    const storedOAuthConfig = asRecord(parsed.oauthConfig);
    const oauthConfig = normalizeOptionalOAuthConfig({
      present: Object.prototype.hasOwnProperty.call(parsed, "oauthConfig"),
      issuer: storedOAuthConfig.issuer,
      clientId: storedOAuthConfig.clientId,
    });
    return {
      accessToken,
      refreshToken: readNonEmptyString(parsed.refreshToken),
      tokenType: readNonEmptyString(parsed.tokenType) ?? "Bearer",
      expiresAt,
      obtainedAt,
      userId: readNonEmptyString(parsed.userId),
      email: readNonEmptyString(parsed.email),
      name: readNonEmptyString(parsed.name),
      provider: readIdentityProvider(parsed.provider),
      imageUrl: readNonEmptyString(parsed.imageUrl),
      authSource: readAuthSource(parsed.authSource),
      ...(parsed.suppressEnvCredential === true ? { suppressEnvCredential: true } : {}),
      ...(oauthConfig ? { oauthConfig } : {}),
    };
  } catch {
    return null;
  }
}

async function postTokenForm(args: {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  tokenUrl: string;
  body: Record<string, string>;
}): Promise<TokenResponse> {
  const response = await args.fetchImpl(args.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(args.body).toString(),
  });
  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const oauthErrorCode = readNonEmptyString(payload.error);
    const message = readNonEmptyString(payload.error_description)
      ?? oauthErrorCode
      ?? `ADE account token request failed (${response.status}).`;
    throw new AccountTokenRequestError(message, oauthErrorCode, response.status);
  }
  const accessToken = readNonEmptyString(payload.access_token);
  const expiresInSec = readPositiveNumber(payload.expires_in);
  if (!accessToken || expiresInSec == null) {
    throw new Error("ADE account token response was missing required fields.");
  }
  return {
    accessToken,
    refreshToken: readNonEmptyString(payload.refresh_token),
    tokenType: readNonEmptyString(payload.token_type) ?? "Bearer",
    expiresInSec,
  };
}

function toStatus(record: AccountSessionRecord | null): AccountAuthStatus {
  const expiresAt = record
    ? accessTokenExpiresAt(record.accessToken) ?? record.expiresAt
    : null;
  return {
    signedIn: Boolean(record?.accessToken),
    userId: record?.userId ?? null,
    email: record?.email ?? null,
    name: record?.name ?? null,
    expiresAt,
    source: record ? record.authSource ?? "loopback" : null,
    ...(record?.provider ? { provider: record.provider } : {}),
    ...(record?.imageUrl ? { imageUrl: record.imageUrl } : {}),
  };
}

export function createAccountActionDomainService(
  service: AccountAuthService,
): AccountActionDomainService {
  return {
    startLogin: () => service.startLogin(),
    pollLogin: (args) => service.pollLogin(readNonEmptyString(args?.sessionId) ?? ""),
    startDeviceLogin: (args) => service.startDeviceLogin({
      ignoreEnvCredential: args?.ignoreEnvCredential === true,
    }),
    pollDeviceLogin: (args) => service.pollDeviceLogin(readNonEmptyString(args?.sessionId) ?? ""),
    status: () => service.getStatus(),
    cancelLogin: (args) => service.cancelLogin(readNonEmptyString(args?.sessionId) ?? ""),
    signOut: () => service.signOut(),
    getToken: () => service.getAccessToken(),
    createToken: () => service.createToken(),
  };
}

export async function callAccountAction(args: {
  service: AccountAuthService;
  action: string;
  actionArgs?: Record<string, unknown>;
}): Promise<{
  domain: "account";
  action: string;
  result: unknown;
  statusHints: Record<string, never>;
}> {
  const action = args.action as AccountActionName;
  const domain = createAccountActionDomainService(args.service);
  if (!ACCOUNT_ACTION_NAMES.includes(action)) {
    throw new Error(`Action 'account.${args.action}' is not callable.`);
  }
  const actionArgs = args.actionArgs ?? {};
  let result: unknown;
  if (action === "pollLogin") {
    result = await domain.pollLogin({ sessionId: readNonEmptyString(actionArgs.sessionId) ?? undefined });
  } else if (action === "pollDeviceLogin") {
    result = await domain.pollDeviceLogin({ sessionId: readNonEmptyString(actionArgs.sessionId) ?? undefined });
  } else if (action === "startLogin") {
    result = await domain.startLogin();
  } else if (action === "startDeviceLogin") {
    result = await domain.startDeviceLogin({
      ignoreEnvCredential: actionArgs.ignoreEnvCredential === true,
    });
  } else if (action === "status") {
    result = domain.status();
  } else if (action === "cancelLogin") {
    domain.cancelLogin({ sessionId: readNonEmptyString(actionArgs.sessionId) ?? undefined });
    result = domain.status();
  } else if (action === "signOut") {
    result = domain.signOut();
  } else if (action === "getToken") {
    result = await domain.getToken();
  } else {
    result = await domain.createToken();
  }
  return { domain: "account", action: args.action, result, statusHints: {} };
}

export function createAccountAuthService(args: {
  credentialStore: SyncCredentialStore;
  getOAuthConfig: () => AccountOAuthConfig | Promise<AccountOAuthConfig>;
  getDeviceBridgeUrl?: () => string | Promise<string>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  deviceBridgeRequestTimeoutMs?: number;
  userinfoRequestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
  logger?: AccountAuthLogger;
}): AccountAuthService {
  const fetchImpl = args.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = args.now ?? Date.now;
  const randomBytes = args.randomBytes ?? nodeRandomBytes;
  const randomUUID = args.randomUUID ?? nodeRandomUUID;
  const logger = args.logger ?? { info: () => {}, warn: () => {} };
  const env = args.env ?? process.env;
  const requestedDeviceBridgeTimeoutMs = args.deviceBridgeRequestTimeoutMs;
  const deviceBridgeRequestTimeoutMs = typeof requestedDeviceBridgeTimeoutMs === "number"
    && Number.isFinite(requestedDeviceBridgeTimeoutMs)
    && requestedDeviceBridgeTimeoutMs > 0
    ? Math.trunc(requestedDeviceBridgeTimeoutMs)
    : DEVICE_BRIDGE_REQUEST_TIMEOUT_MS;
  const requestedUserinfoTimeoutMs = args.userinfoRequestTimeoutMs;
  const userinfoRequestTimeoutMs = typeof requestedUserinfoTimeoutMs === "number"
    && Number.isFinite(requestedUserinfoTimeoutMs)
    && requestedUserinfoTimeoutMs > 0
    ? Math.trunc(requestedUserinfoTimeoutMs)
    : USERINFO_REQUEST_TIMEOUT_MS;
  const pendingSessions = new Map<string, PendingLoginSession>();
  const pendingDeviceSessions = new Map<string, PendingDeviceLoginSession>();
  const devicePollsInFlight = new Map<string, Promise<AccountDeviceLoginPollResult>>();
  let refreshInFlight: Promise<AccountSessionRecord | null> | null = null;
  let envRefreshInFlight: Promise<string> | null = null;
  let envSession: AccountSessionRecord | null = null;
  let envSessionCredential: string | null = null;
  let envRefreshToken: string | null = null;
  let envCredentialEpoch = 0;
  let authEpoch = 0;
  let sessionReadState: AccountSessionReadState = "missing";
  let lastObservedSignedIn: boolean | null = null;
  const signedInListeners = new Set<() => void>();

  const readEnvCredential = (): string | null => readNonEmptyString(env[ACCOUNT_TOKEN_ENV_KEY]);

  const resolveOAuthConfig = async (): Promise<AccountOAuthConfig> =>
    normalizeRuntimeOAuthConfig(await args.getOAuthConfig(), env);

  const resetEnvSessionIfCredentialChanged = (
    credential: string,
    inspected: EnvCredential,
  ): void => {
    if (envSessionCredential === credential) return;
    envCredentialEpoch += 1;
    envSessionCredential = credential;
    envSession = null;
    envRefreshInFlight = null;
    envRefreshToken = inspected.kind === "refresh_token" ? inspected.token : null;
  };

  const rejectDevelopmentEnvCredential = (inspected: EnvCredential): boolean => {
    const oauthConfig = inspected.kind === "refresh_token" ? inspected.oauthConfig : null;
    if (!shouldRejectDevelopmentAccountMaterial({
      env,
      accessToken: inspected.kind === "invalid" ? null : inspected.token,
      oauthConfig,
    })) {
      return false;
    }
    if (envSession || envRefreshInFlight) envCredentialEpoch += 1;
    envSession = null;
    envRefreshInFlight = null;
    envRefreshToken = null;
    warnDevelopmentClerkIgnored();
    return true;
  };

  const envCredentialStatus = (credential: string): AccountAuthStatus => {
    const inspected = inspectEnvCredential(credential);
    resetEnvSessionIfCredentialChanged(credential, inspected);
    if (rejectDevelopmentEnvCredential(inspected)) {
      return {
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
        source: "env-token",
      };
    }
    if (envSession) return { ...toStatus(envSession), source: "env-token" };
    const isAccessToken = inspected.kind === "access_token";
    const accessToken = inspected.kind === "access_token" ? inspected.token : null;
    const expiresAt = accessToken ? accessTokenExpiresAt(accessToken) : null;
    const claims = expiresAt && accessToken
      ? decodeAccountClaims(accessToken)
      : { userId: null, email: null, name: null, provider: null, imageUrl: null };
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    return {
      signedIn: isAccessToken && Number.isFinite(expiresAtMs) && expiresAtMs > now(),
      userId: claims.userId,
      email: claims.email,
      name: claims.name,
      expiresAt,
      source: "env-token",
      ...(claims.provider ? { provider: claims.provider } : {}),
      ...(claims.imageUrl ? { imageUrl: claims.imageUrl } : {}),
    };
  };

  const persistSession = (record: AccountSessionRecord | null): void => {
    if (record) {
      args.credentialStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(record));
    } else {
      args.credentialStore.deleteSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
    }
    lastObservedSignedIn = record != null;
  };

  const invalidateStoredSessionIfCurrent = (raw: string): boolean => {
    const updateSync = args.credentialStore.updateSync;
    let invalidated = false;
    if (updateSync) {
      updateSync.call(args.credentialStore, (values) => {
        if (values[ACCOUNT_SESSION_CREDENTIAL_KEY] !== raw) return false;
        delete values[ACCOUNT_SESSION_CREDENTIAL_KEY];
        invalidated = true;
        return true;
      });
    } else if (args.credentialStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY) === raw) {
      args.credentialStore.deleteSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
      invalidated = true;
    }
    if (invalidated) {
      authEpoch += 1;
      lastObservedSignedIn = false;
      sessionReadState = "missing";
      warnDevelopmentClerkIgnored();
    }
    return invalidated;
  };

  const readSession = (): AccountSessionRecord | null => {
    try {
      // A peer process may replace the credential between the read and the
      // atomic delete. Retry once so we never clear or surface that newer
      // session merely because an older development session was observed.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const stored = args.credentialStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
        const session = parseStoredSession(stored);
        sessionReadState = stored == null
          ? args.credentialStore.getLastReadState?.() === "unreadable"
            ? "unreadable"
            : "missing"
          : session
            ? "available"
            : "unreadable";
        if (!session || !stored) return session;
        if (!shouldRejectDevelopmentAccountMaterial({
          env,
          accessToken: session.accessToken,
          oauthConfig: session.oauthConfig,
        })) {
          return session;
        }
        if (invalidateStoredSessionIfCurrent(stored)) return null;
      }
      sessionReadState = "unreadable";
      return null;
    } catch (error) {
      sessionReadState = "unreadable";
      logger.warn("account.session_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const notifySignedIn = (): void => {
    for (const listener of signedInListeners) {
      try {
        listener();
      } catch {
        // Account persistence has already succeeded. Observers are best-effort.
      }
    }
  };

  const persistRefreshedSessionIfCurrent = (
    refreshed: AccountSessionRecord,
    refreshSource: AccountSessionRecord,
  ): boolean => {
    const matchesRefreshSource = (candidate: AccountSessionRecord | null): boolean =>
      candidate?.refreshToken === refreshSource.refreshToken
      && candidate?.obtainedAt === refreshSource.obtainedAt;
    const updateSync = args.credentialStore.updateSync;
    if (!updateSync) {
      if (!matchesRefreshSource(readSession())) return false;
      persistSession(refreshed);
      return true;
    }

    let persisted = false;
    updateSync.call(args.credentialStore, (values) => {
      const latest = parseStoredSession(values[ACCOUNT_SESSION_CREDENTIAL_KEY]);
      if (!matchesRefreshSource(latest)) return false;
      values[ACCOUNT_SESSION_CREDENTIAL_KEY] = JSON.stringify(refreshed);
      persisted = true;
      return true;
    });
    if (persisted) lastObservedSignedIn = true;
    return persisted;
  };

  const finishPendingSession = (
    session: PendingLoginSession,
    phase: PendingLoginSession["phase"],
    message: string | null,
  ): void => {
    session.phase = phase;
    session.message = message;
    clearTimeout(session.expiryTimer);
    closeServer(session.server);
  };

  const expirePendingSession = (session: PendingLoginSession): void => {
    if (session.phase !== "pending" && session.phase !== "exchanging") return;
    finishPendingSession(session, "expired", "ADE account sign-in expired.");
  };

  const pruneFinishedSessions = (): void => {
    for (const [sessionId, session] of pendingSessions) {
      if (session.phase === "pending" || session.phase === "exchanging") {
        if (session.expiresAtMs <= now()) expirePendingSession(session);
        continue;
      }
      pendingSessions.delete(sessionId);
    }
  };

  const fetchUserinfoProfile = async (
    token: TokenResponse,
    oauthConfig: AccountOAuthConfig | null,
  ): Promise<ReturnType<typeof decodeAccountClaims> | null> => {
    if (!oauthConfig) return null;
    if (shouldRejectDevelopmentAccountMaterial({
      env,
      accessToken: token.accessToken,
      oauthConfig,
    })) {
      warnDevelopmentClerkIgnored();
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), userinfoRequestTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${oauthConfig.issuer}/oauth/userinfo`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token.accessToken}`,
        },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const profile = asRecord(await response.json().catch(() => ({})));
      const givenName = readNonEmptyString(profile.given_name ?? profile.first_name);
      const familyName = readNonEmptyString(profile.family_name ?? profile.last_name);
      const derivedName = [givenName, familyName].filter(Boolean).join(" ") || null;
      return {
        userId: readNonEmptyString(profile.sub),
        email: readNonEmptyString(
          profile.email ?? profile.primary_email ?? profile.email_address,
        ),
        name: readNonEmptyString(profile.name) ?? derivedName,
        provider: readIdentityProvider(
          profile.provider ?? profile.identity_provider ?? profile.idp,
        ),
        imageUrl: readNonEmptyString(
          profile.picture ?? profile.image_url ?? profile.avatar_url,
        ),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const buildSessionRecord = async (
    token: TokenResponse,
    previous?: AccountSessionRecord | null,
    authSource: AccountSessionRecord["authSource"] = previous?.authSource ?? "loopback",
    oauthConfig: AccountOAuthConfig | null = previous?.oauthConfig ?? null,
  ): Promise<AccountSessionRecord> => {
    if (shouldRejectDevelopmentAccountMaterial({
      env,
      accessToken: token.accessToken,
      oauthConfig,
    })) {
      warnDevelopmentClerkIgnored();
      throw new Error(
        "ADE rejected development Clerk session material in this packaged build. Sign in again to use ADE production.",
      );
    }
    const obtainedAtMs = now();
    const claims = decodeAccountClaims(token.accessToken);
    const claimedExpiresAt = accessTokenExpiresAt(token.accessToken);
    const userinfo = await fetchUserinfoProfile(token, oauthConfig);
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? previous?.refreshToken ?? null,
      tokenType: token.tokenType,
      // The access-token claim is authoritative when it is present. OAuth
      // expires_in can describe a broader session lifetime than the JWT that
      // is actually sent to the directory.
      expiresAt: claimedExpiresAt
        ?? new Date(obtainedAtMs + Math.trunc(token.expiresInSec * 1000)).toISOString(),
      obtainedAt: new Date(obtainedAtMs).toISOString(),
      userId: claims.userId ?? userinfo?.userId ?? previous?.userId ?? null,
      email: claims.email ?? userinfo?.email ?? previous?.email ?? null,
      name: claims.name ?? userinfo?.name ?? previous?.name ?? null,
      provider: claims.provider ?? userinfo?.provider ?? previous?.provider ?? null,
      imageUrl: userinfo?.imageUrl ?? claims.imageUrl ?? previous?.imageUrl ?? null,
      authSource,
      ...(previous?.suppressEnvCredential ? { suppressEnvCredential: true } : {}),
      ...(oauthConfig ? { oauthConfig } : {}),
    };
  };

  const exchangeAuthorizationCode = async (
    session: PendingLoginSession,
    code: string,
  ): Promise<AccountSessionRecord> => {
    const config = session.oauthConfig;
    const token = await postTokenForm({
      fetchImpl,
      tokenUrl: `${config.issuer}/oauth/token`,
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: session.codeVerifier,
        client_id: config.clientId,
        redirect_uri: session.redirectUri,
      },
    });
    return await buildSessionRecord(token, null, "loopback", config);
  };

  const handleLoopbackRequest = async (
    session: PendingLoginSession,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (request.method !== "GET" || requestUrl.pathname !== "/callback") {
      respondHtml(response, 404, FAILURE_HTML);
      return;
    }
    if (session.expiresAtMs <= now()) {
      expirePendingSession(session);
      respondHtml(response, 410, FAILURE_HTML);
      return;
    }
    if (!isMatchingState(requestUrl.searchParams.get("state"), session.oauthState)) {
      respondHtml(response, 400, FAILURE_HTML);
      return;
    }
    if (session.phase !== "pending") {
      respondHtml(response, 409, session.phase === "signed_in" ? SUCCESS_HTML : FAILURE_HTML);
      return;
    }
    const oauthError = requestUrl.searchParams.get("error");
    const code = readNonEmptyString(requestUrl.searchParams.get("code"));
    if (oauthError || !code) {
      finishPendingSession(session, "error", "ADE account sign-in was not completed.");
      respondHtml(response, 400, FAILURE_HTML);
      return;
    }

    session.phase = "exchanging";
    const epochAtExchange = authEpoch;
    try {
      const record = await exchangeAuthorizationCode(session, code);
      if (
        authEpoch !== epochAtExchange
        || pendingSessions.get(session.sessionId) !== session
        || session.phase !== "exchanging"
        || session.expiresAtMs <= now()
      ) {
        finishPendingSession(session, "error", "ADE account sign-in was cancelled.");
        respondHtml(response, 409, FAILURE_HTML);
        return;
      }
      persistSession(record);
      authEpoch += 1;
      notifySignedIn();
      finishPendingSession(session, "signed_in", null);
      logger.info("account.login_completed");
      respondHtml(response, 200, SUCCESS_HTML);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishPendingSession(session, "error", message);
      logger.warn("account.login_exchange_failed", { error: message });
      respondHtml(response, 502, FAILURE_HTML);
    }
  };

  const startLogin = async (): Promise<AccountLoginStartResult> => {
    if (readEnvCredential()) {
      throw new Error("ADE_ACCOUNT_TOKEN is already providing account authentication; no interactive sign-in is required.");
    }
    pruneFinishedSessions();
    while (pendingSessions.size >= MAX_PENDING_LOGIN_SESSIONS) {
      const oldestId = pendingSessions.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = pendingSessions.get(oldestId);
      if (oldest) {
        finishPendingSession(oldest, "error", "ADE account sign-in was replaced by a newer attempt.");
      }
      pendingSessions.delete(oldestId);
    }

    const config = await resolveOAuthConfig();
    const codeVerifier = randomBytes(32).toString("base64url");
    const oauthState = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAtMs = now() + LOGIN_SESSION_TTL_MS;
    let session: PendingLoginSession | null = null;
    const server = createServer((request, response) => {
      if (!session) {
        respondHtml(response, 503, FAILURE_HTML);
        return;
      }
      void handleLoopbackRequest(session, request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, LOOPBACK_HOST);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      closeServer(server);
      throw new Error("ADE account loopback listener did not provide a TCP port.");
    }
    const redirectUri = `http://${LOOPBACK_HOST}:${address.port}/callback`;
    const expiryTimer = setTimeout(() => {
      if (session) expirePendingSession(session);
    }, LOGIN_SESSION_TTL_MS);
    expiryTimer.unref?.();
    session = {
      sessionId,
      oauthConfig: config,
      codeVerifier,
      oauthState,
      redirectUri,
      expiresAtMs,
      server,
      expiryTimer,
      phase: "pending",
      message: null,
    };
    pendingSessions.set(sessionId, session);

    return {
      sessionId,
      authorizeUrl: buildAuthorizeUrl({
        config,
        redirectUri,
        codeChallenge: derivePkceChallenge(codeVerifier),
        state: oauthState,
      }),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  };

  const pollLogin = async (sessionId: string): Promise<AccountLoginPollResult> => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return {
        status: "error",
        message: "ADE account sign-in session id is required.",
        authStatus: toStatus(readSession()),
      };
    }
    const session = pendingSessions.get(normalizedSessionId);
    if (!session) {
      return {
        status: "error",
        message: "ADE account sign-in session was not found.",
        authStatus: toStatus(readSession()),
      };
    }
    if (session.expiresAtMs <= now()) expirePendingSession(session);
    if (session.phase === "pending" || session.phase === "exchanging") {
      return { status: "pending", message: null, authStatus: toStatus(readSession()) };
    }
    pendingSessions.delete(normalizedSessionId);
    if (session.phase === "signed_in") {
      return { status: "signed_in", message: null, authStatus: toStatus(readSession()) };
    }
    return {
      status: session.phase,
      message: session.message,
      authStatus: toStatus(readSession()),
    };
  };

  const resolveDeviceBridgeUrl = async (): Promise<string> => {
    const rawUrl = args.getDeviceBridgeUrl
      ? await args.getDeviceBridgeUrl()
      : env.ADE_ACCOUNT_DIRECTORY_URL ?? "";
    if (shouldIgnoreDevelopmentAccountDirectoryUrl(rawUrl, env)) {
      warnDevelopmentClerkIgnored();
      return normalizeDeviceBridgeUrl(DEFAULT_ADE_ACCOUNT_DIRECTORY_URL);
    }
    return normalizeDeviceBridgeUrl(rawUrl);
  };

  const requestDeviceBridge = (
    url: string,
    init: RequestInit,
  ): Promise<Response> => fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(deviceBridgeRequestTimeoutMs),
  });

  const deviceBridgeStartError = (error: unknown): Error => {
    const errorName = error instanceof Error ? error.name : "";
    return new Error(
      errorName === "TimeoutError" || errorName === "AbortError"
        ? "ADE account device service timed out. Check the account directory connection and retry."
        : "ADE account device service could not be reached. Check the account directory connection and retry.",
    );
  };

  const startDeviceLogin = async (
    options: { ignoreEnvCredential?: boolean } = {},
  ): Promise<AccountDeviceLoginStartResult> => {
    if (readEnvCredential() && !options.ignoreEnvCredential) {
      throw new Error("ADE_ACCOUNT_TOKEN is already providing account authentication; no interactive sign-in is required.");
    }
    for (const [sessionId, session] of pendingDeviceSessions) {
      if (session.expiresAtMs <= now()) pendingDeviceSessions.delete(sessionId);
    }
    while (pendingDeviceSessions.size >= MAX_PENDING_LOGIN_SESSIONS) {
      const oldestId = pendingDeviceSessions.keys().next().value as string | undefined;
      if (!oldestId) break;
      pendingDeviceSessions.delete(oldestId);
    }
    const deviceSecret = randomBytes(32).toString("base64url");
    const bridgeUrl = await resolveDeviceBridgeUrl();
    let response: Response;
    try {
      response = await requestDeviceBridge(`${bridgeUrl}/device/code`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ device_secret: deviceSecret }),
      });
    } catch (error) {
      throw deviceBridgeStartError(error);
    }
    let payload: Record<string, unknown>;
    try {
      payload = asRecord(await response.json());
    } catch (error) {
      throw deviceBridgeStartError(error);
    }
    if (!response.ok) {
      throw new Error(
        readNonEmptyString(payload.error_description)
          ?? readNonEmptyString(payload.error)
          ?? `ADE account device login failed to start (${response.status}).`,
      );
    }
    const deviceCode = readNonEmptyString(payload.device_code);
    const userCode = readNonEmptyString(payload.user_code);
    const verificationUri = readNonEmptyString(payload.verification_uri);
    const expiresInSec = readPositiveNumber(payload.expires_in);
    const intervalSec = readPositiveNumber(payload.interval) ?? 5;
    if (!deviceCode || !userCode || !verificationUri || expiresInSec == null) {
      throw new Error("ADE account device login response was missing required fields.");
    }
    const sessionId = randomUUID();
    const expiresAtMs = now() + Math.trunc(expiresInSec * 1000);
    pendingDeviceSessions.set(sessionId, {
      sessionId,
      bridgeUrl,
      deviceCode,
      deviceSecret,
      expiresAtMs,
      intervalSec,
      suppressEnvCredential: options.ignoreEnvCredential === true,
    });
    return {
      sessionId,
      userCode,
      verificationUri,
      verificationUriComplete: readNonEmptyString(payload.verification_uri_complete),
      expiresAt: new Date(expiresAtMs).toISOString(),
      intervalSec,
    };
  };

  const pollDeviceLoginOnce = async (
    normalizedSessionId: string,
    session: PendingDeviceLoginSession,
  ): Promise<AccountDeviceLoginPollResult> => {
    const epochAtPoll = authEpoch;
    let response: Response;
    try {
      response = await requestDeviceBridge(`${session.bridgeUrl}/device/token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          device_code: session.deviceCode,
          device_secret: session.deviceSecret,
        }),
      });
    } catch {
      if (pendingDeviceSessions.get(normalizedSessionId) !== session) {
        return {
          status: "error",
          message: "ADE account device sign-in was cancelled.",
          intervalSec: null,
          authStatus: toStatus(readSession()),
        };
      }
      if (session.expiresAtMs <= now()) {
        pendingDeviceSessions.delete(normalizedSessionId);
        return {
          status: "expired",
          message: "ADE account device sign-in expired.",
          intervalSec: null,
          authStatus: toStatus(readSession()),
        };
      }
      return {
        status: "pending",
        message: null,
        intervalSec: session.intervalSec,
        authStatus: toStatus(readSession()),
      };
    }
    let payload: Record<string, unknown>;
    try {
      payload = asRecord(await response.json());
    } catch {
      if (pendingDeviceSessions.get(normalizedSessionId) !== session) {
        return {
          status: "error",
          message: "ADE account device sign-in was cancelled.",
          intervalSec: null,
          authStatus: toStatus(readSession()),
        };
      }
      return {
        status: "pending",
        message: null,
        intervalSec: session.intervalSec,
        authStatus: toStatus(readSession()),
      };
    }
    if (
      authEpoch !== epochAtPoll
      || pendingDeviceSessions.get(normalizedSessionId) !== session
    ) {
      return {
        status: "error",
        message: "ADE account device sign-in was cancelled.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }
    if (!response.ok) {
      const errorCode = readNonEmptyString(payload.error);
      const retryableResponse = response.status === 429 || response.status >= 500;
      const intervalSec = readPositiveNumber(payload.interval)
        ?? (response.status === 429 ? session.intervalSec + 5 : session.intervalSec);
      if (errorCode === "authorization_pending" || errorCode === "slow_down" || retryableResponse) {
        session.intervalSec = intervalSec;
        return {
          status: errorCode === "slow_down" || response.status === 429 ? "slow_down" : "pending",
          message: null,
          intervalSec,
          authStatus: toStatus(readSession()),
        };
      }
      pendingDeviceSessions.delete(normalizedSessionId);
      if (errorCode === "expired" || errorCode === "expired_token") {
        return {
          status: "expired",
          message: "ADE account device sign-in expired.",
          intervalSec: null,
          authStatus: toStatus(readSession()),
        };
      }
      return {
        status: "error",
        message: readNonEmptyString(payload.error_description)
          ?? (errorCode === "invalid_grant"
            ? "ADE account device sign-in could not be redeemed."
            : errorCode ?? `ADE account device token request failed (${response.status}).`),
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }

    const accessToken = readNonEmptyString(payload.access_token);
    const expiresInSec = readPositiveNumber(payload.expires_in);
    if (!accessToken || expiresInSec == null) {
      pendingDeviceSessions.delete(normalizedSessionId);
      return {
        status: "error",
        message: "ADE account device token response was missing required fields.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }
    let oauthConfig: AccountOAuthConfig | null;
    try {
      oauthConfig = normalizeOptionalOAuthConfig({
        present: Object.prototype.hasOwnProperty.call(payload, "oauth_issuer")
          || Object.prototype.hasOwnProperty.call(payload, "oauth_client_id"),
        issuer: payload.oauth_issuer,
        clientId: payload.oauth_client_id,
      });
    } catch {
      pendingDeviceSessions.delete(normalizedSessionId);
      return {
        status: "error",
        message: "ADE account device token response included invalid OAuth context.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }
    if (
      authEpoch !== epochAtPoll
      || pendingDeviceSessions.get(normalizedSessionId) !== session
      || session.expiresAtMs <= now()
    ) {
      pendingDeviceSessions.delete(normalizedSessionId);
      return {
        status: "error",
        message: "ADE account device sign-in was cancelled.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }
    let baseRecord: AccountSessionRecord;
    try {
      baseRecord = await buildSessionRecord({
        accessToken,
        refreshToken: readNonEmptyString(payload.refresh_token),
        tokenType: readNonEmptyString(payload.token_type) ?? "Bearer",
        expiresInSec,
      }, null, "device", oauthConfig);
    } catch (error) {
      pendingDeviceSessions.delete(normalizedSessionId);
      return {
        status: "error",
        message: error instanceof Error ? error.message : "ADE account device token could not be accepted.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }
    const record: AccountSessionRecord = session.suppressEnvCredential
      ? { ...baseRecord, suppressEnvCredential: true }
      : baseRecord;
    persistSession(record);
    authEpoch += 1;
    notifySignedIn();
    pendingDeviceSessions.delete(normalizedSessionId);
    logger.info("account.device_login_completed");
    return {
      status: "signed_in",
      message: null,
      intervalSec: null,
      authStatus: toStatus(record),
    };
  };

  const pollDeviceLogin = async (sessionId: string): Promise<AccountDeviceLoginPollResult> => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return {
        status: "error",
        message: "ADE account device sign-in session id is required.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }
    const inFlight = devicePollsInFlight.get(normalizedSessionId);
    if (inFlight) return inFlight;

    const session = pendingDeviceSessions.get(normalizedSessionId);
    if (!session) {
      return {
        status: "error",
        message: "ADE account device sign-in session was not found.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }
    if (session.expiresAtMs <= now()) {
      pendingDeviceSessions.delete(normalizedSessionId);
      return {
        status: "expired",
        message: "ADE account device sign-in expired.",
        intervalSec: null,
        authStatus: toStatus(readSession()),
      };
    }

    const poll = pollDeviceLoginOnce(normalizedSessionId, session);
    devicePollsInFlight.set(normalizedSessionId, poll);
    try {
      return await poll;
    } finally {
      if (devicePollsInFlight.get(normalizedSessionId) === poll) {
        devicePollsInFlight.delete(normalizedSessionId);
      }
    }
  };

  const getStatus = (): AccountAuthStatus => {
    const record = readSession();
    if (record?.suppressEnvCredential) return toStatus(record);
    const envCredential = readEnvCredential();
    return envCredential ? envCredentialStatus(envCredential) : toStatus(record);
  };

  const getAccessToken = async (): Promise<string> => {
    const record = readSession();
    const envCredential = readEnvCredential();
    if (envCredential && !record?.suppressEnvCredential) {
      const inspected = inspectEnvCredential(envCredential);
      resetEnvSessionIfCredentialChanged(envCredential, inspected);
      if (rejectDevelopmentEnvCredential(inspected)) {
        throw new Error(
          "ADE_ACCOUNT_TOKEN uses development Clerk and is disabled in this packaged build. Replace it with an ADE production token.",
        );
      }
      if (inspected.kind === "invalid") {
        throw new Error(
          "ADE_ACCOUNT_TOKEN is not a valid provisioned account token. Recreate it with `ade account token create`.",
        );
      }
      const directExpiresAt = inspected.kind === "access_token"
        ? accessTokenExpiresAt(inspected.token)
        : null;
      if (inspected.kind === "access_token") {
        if (!directExpiresAt) {
          throw new Error(
            "ADE_ACCOUNT_TOKEN access token does not contain a usable expiration claim. Replace it with a current access token or a durable refresh token.",
          );
        }
        const expiresAtMs = Date.parse(directExpiresAt);
        if (expiresAtMs > now()) return inspected.token;
        throw new Error(
          `ADE_ACCOUNT_TOKEN access token expired at ${directExpiresAt}. Replace it with a current access token or a durable refresh token.`,
        );
      }
      if (envSession) {
        const expiresAtMs = Date.parse(envSession.expiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs > now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
          return envSession.accessToken;
        }
      }
      if (!envRefreshInFlight) {
        const credentialAtRefresh = envCredential;
        const epochAtRefresh = envCredentialEpoch;
        const refreshTokenAtRefresh = envRefreshToken ?? inspected.token;
        let refreshPromise: Promise<string> | null = null;
        refreshPromise = (async (): Promise<string> => {
          let config: AccountOAuthConfig;
          if (inspected.oauthConfig) {
            config = normalizeOAuthConfig(inspected.oauthConfig);
          } else {
            try {
              config = await resolveOAuthConfig();
            } catch {
              throw new Error(
                "Legacy ADE_ACCOUNT_TOKEN refresh tokens require local CLERK_ISSUER and CLERK_OAUTH_CLIENT_ID. Recreate the token with `ade account token create` to make it self-contained.",
              );
            }
          }
          let token: TokenResponse;
          try {
            token = await postTokenForm({
              fetchImpl,
              tokenUrl: `${config.issuer}/oauth/token`,
              body: {
                grant_type: "refresh_token",
                refresh_token: refreshTokenAtRefresh,
                client_id: config.clientId,
              },
            });
          } catch {
            throw new Error(
              "ADE_ACCOUNT_TOKEN refresh failed. Replace it with a newly provisioned token from `ade account token create`.",
            );
          }
          if (
            envCredentialEpoch !== epochAtRefresh
            || envSessionCredential !== credentialAtRefresh
            || readEnvCredential() !== credentialAtRefresh
            || envRefreshInFlight !== refreshPromise
          ) {
            return getAccessToken();
          }
          envRefreshToken = token.refreshToken ?? refreshTokenAtRefresh;
          const refreshed = await buildSessionRecord(token, envSession, "loopback", config);
          envSession = refreshed;
          return refreshed.accessToken;
        })();
        envRefreshInFlight = refreshPromise;
      }
      const refreshPromise = envRefreshInFlight;
      try {
        return await refreshPromise;
      } finally {
        if (envRefreshInFlight === refreshPromise) envRefreshInFlight = null;
      }
    }

    if (!record?.accessToken) {
      throw new Error("ADE is not signed in. Run `ade login` to sign in.");
    }
    const claimedExpiresAt = accessTokenExpiresAt(record.accessToken);
    const expiresAtMs = Date.parse(claimedExpiresAt ?? record.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
      return record.accessToken;
    }
    if (!record.refreshToken) {
      throw new Error("ADE account session expired. Run `ade login` again.");
    }

    const epochAtJoin = authEpoch;
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        let refreshRecord = record;
        let token: TokenResponse | null = null;
        let config: AccountOAuthConfig | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          config = refreshRecord.oauthConfig
            ? normalizeOAuthConfig(refreshRecord.oauthConfig)
            : await resolveOAuthConfig();
          try {
            token = await postTokenForm({
              fetchImpl,
              tokenUrl: `${config.issuer}/oauth/token`,
              body: {
                grant_type: "refresh_token",
                refresh_token: refreshRecord.refreshToken!,
                client_id: config.clientId,
              },
            });
            break;
          } catch (error) {
            if (
              attempt > 0
              || !(error instanceof AccountTokenRequestError)
              || error.oauthErrorCode !== "invalid_grant"
            ) {
              throw error;
            }
            // The desktop and brain share this credential. If the peer won a
            // rotating refresh-token exchange, retry once with the newer
            // persisted token instead of treating the session as expired.
            const latest = readSession();
            if (
              !latest?.refreshToken
              || latest.refreshToken === refreshRecord.refreshToken
            ) {
              throw error;
            }
            refreshRecord = latest;
          }
        }
        if (!token || !config) {
          throw new Error("ADE account session expired. Run `ade login` again.");
        }
        const refreshed = await buildSessionRecord(token, refreshRecord, undefined, config);
        if (authEpoch !== epochAtJoin) return null;
        return persistRefreshedSessionIfCurrent(refreshed, refreshRecord)
          ? refreshed
          : null;
      })().finally(() => {
        refreshInFlight = null;
      });
    }

    const refreshed = await refreshInFlight;
    if (authEpoch !== epochAtJoin || !refreshed) {
      return getAccessToken();
    }
    return refreshed.accessToken;
  };

  const createToken = async (): Promise<AccountTokenCreateResult> => {
    const record = readSession();
    if (readEnvCredential() && !record?.suppressEnvCredential) {
      throw new Error(
        "ADE is using ADE_ACCOUNT_TOKEN. Unset it and sign in interactively before creating a new durable account token.",
      );
    }
    if (!record?.refreshToken) {
      throw new Error("The current ADE account session has no refresh token. Run `ade login` again, then retry.");
    }
    const oauthConfig = record.oauthConfig
      ? normalizeOAuthConfig(record.oauthConfig)
      : await resolveOAuthConfig();
    return {
      token: provisionedAccountToken({ refreshToken: record.refreshToken, oauthConfig }),
      source: "refresh_token",
      guidance: "Set this self-contained secret as ADE_ACCOUNT_TOKEN in the agent or CI environment. Store it in a secret manager; do not commit or log it.",
    };
  };

  // Cancel a single pending login (e.g. `ade login --max-wait` timed out) without
  // signing the machine out. This closes the loopback listener so a browser tab
  // that completes AFTER the CLI gave up can no longer exchange the code and
  // silently persist a session. Unlike signOut it MUST NOT bump authEpoch or wipe
  // the persisted account. Idempotent: a no-op if the session is unknown or done.
  const cancelLogin = (sessionId: string): void => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    const session = pendingSessions.get(normalizedSessionId);
    if (session) {
      finishPendingSession(session, "error", "ADE account sign-in was cancelled.");
      pendingSessions.delete(normalizedSessionId);
      logger.info("account.login_cancelled");
      return;
    }
    if (pendingDeviceSessions.delete(normalizedSessionId)) {
      logger.info("account.device_login_cancelled");
    }
  };

  const signOut = (): AccountAuthStatus => {
    authEpoch += 1;
    persistSession(null);
    for (const session of pendingSessions.values()) {
      finishPendingSession(session, "error", "ADE account sign-in was cancelled.");
    }
    pendingSessions.clear();
    pendingDeviceSessions.clear();
    logger.info("account.signed_out");
    return getStatus();
  };

  let credentialChangeTimer: ReturnType<typeof setTimeout> | null = null;
  lastObservedSignedIn = getStatus().signedIn;
  const unsubscribeCredentialChanges = args.credentialStore.onDidChange?.(() => {
    if (credentialChangeTimer) clearTimeout(credentialChangeTimer);
    credentialChangeTimer = setTimeout(() => {
      credentialChangeTimer = null;
      const signedIn = getStatus().signedIn;
      if (signedIn && lastObservedSignedIn === false) notifySignedIn();
      lastObservedSignedIn = signedIn;
    }, 25);
    credentialChangeTimer.unref?.();
  }) ?? (() => {});

  const dispose = (): void => {
    for (const session of pendingSessions.values()) {
      clearTimeout(session.expiryTimer);
      closeServer(session.server);
    }
    pendingSessions.clear();
    pendingDeviceSessions.clear();
    if (credentialChangeTimer) clearTimeout(credentialChangeTimer);
    credentialChangeTimer = null;
    unsubscribeCredentialChanges();
    signedInListeners.clear();
  };

  return {
    startLogin,
    pollLogin,
    startDeviceLogin,
    pollDeviceLogin,
    getStatus,
    getSessionReadState: () => sessionReadState,
    getAccessToken,
    createToken,
    cancelLogin,
    signOut,
    onSignedIn: (listener: () => void) => {
      signedInListeners.add(listener);
      return () => signedInListeners.delete(listener);
    },
    dispose,
  };
}
