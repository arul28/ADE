import { createHash, randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SyncCredentialStore } from "../credentials/credentialStore";

export const ACCOUNT_SESSION_CREDENTIAL_KEY = "account.session.v1";

const LOOPBACK_HOST = "127.0.0.1";
const LOGIN_SESSION_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
const MAX_PENDING_LOGIN_SESSIONS = 5;
const ACCOUNT_TOKEN_ENV_KEY = "ADE_ACCOUNT_TOKEN";
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
  authSource?: Exclude<AccountAuthSource, "env-token" | null>;
};

export type AccountAuthSource = "loopback" | "device" | "env-token" | null;

export type AccountAuthStatus = {
  signedIn: boolean;
  userId: string | null;
  email: string | null;
  name: string | null;
  expiresAt: string | null;
  source?: AccountAuthSource;
};

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
};

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresInSec: number;
};

export type AccountAuthService = {
  startLogin(): Promise<AccountLoginStartResult>;
  pollLogin(sessionId: string): Promise<AccountLoginPollResult>;
  startDeviceLogin(): Promise<AccountDeviceLoginStartResult>;
  pollDeviceLogin(sessionId: string): Promise<AccountDeviceLoginPollResult>;
  getStatus(): AccountAuthStatus;
  getAccessToken(): Promise<string>;
  createToken(): AccountTokenCreateResult;
  cancelLogin(sessionId: string): void;
  signOut(): AccountAuthStatus;
  dispose(): void;
};

export type AccountActionDomainService = {
  startLogin(): Promise<AccountLoginStartResult>;
  pollLogin(args: { sessionId?: string }): Promise<AccountLoginPollResult>;
  startDeviceLogin(): Promise<AccountDeviceLoginStartResult>;
  pollDeviceLogin(args: { sessionId?: string }): Promise<AccountDeviceLoginPollResult>;
  status(): AccountAuthStatus;
  cancelLogin(args: { sessionId?: string }): void;
  signOut(): AccountAuthStatus;
  getToken(): Promise<string>;
  createToken(): AccountTokenCreateResult;
};

export async function getSignedInAccountAccessToken(
  service: Pick<AccountAuthService, "getStatus" | "getAccessToken">,
): Promise<string | null> {
  const status = service.getStatus();
  if (!status.signedIn || !status.userId) return null;
  try {
    return (await service.getAccessToken()).trim() || null;
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
  return new Date(Math.trunc(exp * 1000)).toISOString();
}

function classifyEnvCredential(token: string): "access_token" | "refresh_token" {
  const payload = decodeJwtPayload(token);
  if (!payload) return "refresh_token";
  const tokenUse = readNonEmptyString(payload.token_use ?? payload.typ ?? payload.type)?.toLowerCase();
  return tokenUse?.includes("refresh") ? "refresh_token" : "access_token";
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
} {
  try {
    const claims = decodeJwtPayload(accessToken);
    if (!claims) return { userId: null, email: null, name: null };
    const givenName = readNonEmptyString(claims.given_name ?? claims.first_name);
    const familyName = readNonEmptyString(claims.family_name ?? claims.last_name);
    const derivedName = [givenName, familyName].filter(Boolean).join(" ") || null;
    return {
      userId: readNonEmptyString(claims.sub),
      email: readNonEmptyString(claims.email ?? claims.primary_email ?? claims.email_address),
      name: readNonEmptyString(claims.name) ?? derivedName,
    };
  } catch {
    return { userId: null, email: null, name: null };
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
    return {
      accessToken,
      refreshToken: readNonEmptyString(parsed.refreshToken),
      tokenType: readNonEmptyString(parsed.tokenType) ?? "Bearer",
      expiresAt,
      obtainedAt,
      userId: readNonEmptyString(parsed.userId),
      email: readNonEmptyString(parsed.email),
      name: readNonEmptyString(parsed.name),
      authSource: readAuthSource(parsed.authSource),
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
    const message = readNonEmptyString(payload.error_description)
      ?? readNonEmptyString(payload.error)
      ?? `ADE account token request failed (${response.status}).`;
    throw new Error(message);
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
  return {
    signedIn: Boolean(record?.accessToken),
    userId: record?.userId ?? null,
    email: record?.email ?? null,
    name: record?.name ?? null,
    expiresAt: record?.expiresAt ?? null,
    source: record ? record.authSource ?? "loopback" : null,
  };
}

export function createAccountActionDomainService(
  service: AccountAuthService,
): AccountActionDomainService {
  return {
    startLogin: () => service.startLogin(),
    pollLogin: (args) => service.pollLogin(readNonEmptyString(args?.sessionId) ?? ""),
    startDeviceLogin: () => service.startDeviceLogin(),
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
    result = await domain.startDeviceLogin();
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
    result = domain.createToken();
  }
  return { domain: "account", action: args.action, result, statusHints: {} };
}

export function createAccountAuthService(args: {
  credentialStore: SyncCredentialStore;
  getOAuthConfig: () => AccountOAuthConfig | Promise<AccountOAuthConfig>;
  getDeviceBridgeUrl?: () => string | Promise<string>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
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
  const pendingSessions = new Map<string, PendingLoginSession>();
  const pendingDeviceSessions = new Map<string, PendingDeviceLoginSession>();
  let refreshInFlight: Promise<AccountSessionRecord> | null = null;
  let envRefreshInFlight: Promise<AccountSessionRecord> | null = null;
  let envSession: AccountSessionRecord | null = null;
  let envSessionCredential: string | null = null;
  let envRefreshToken: string | null = null;
  let authEpoch = 0;

  const readEnvCredential = (): string | null => readNonEmptyString(env[ACCOUNT_TOKEN_ENV_KEY]);

  const resetEnvSessionIfCredentialChanged = (credential: string): void => {
    if (envSessionCredential === credential) return;
    envSessionCredential = credential;
    envSession = null;
    envRefreshInFlight = null;
    envRefreshToken = credential;
  };

  const envCredentialStatus = (credential: string): AccountAuthStatus => {
    resetEnvSessionIfCredentialChanged(credential);
    if (envSession) return { ...toStatus(envSession), source: "env-token" };
    const expiresAt = classifyEnvCredential(credential) === "access_token"
      ? accessTokenExpiresAt(credential)
      : null;
    const claims = expiresAt ? decodeAccountClaims(credential) : { userId: null, email: null, name: null };
    return {
      signedIn: true,
      userId: claims.userId,
      email: claims.email,
      name: claims.name,
      expiresAt,
      source: "env-token",
    };
  };

  const readSession = (): AccountSessionRecord | null => {
    try {
      return parseStoredSession(args.credentialStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY));
    } catch (error) {
      logger.warn("account.session_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const persistSession = (record: AccountSessionRecord | null): void => {
    if (record) {
      args.credentialStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(record));
    } else {
      args.credentialStore.deleteSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
    }
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

  const buildSessionRecord = (
    token: TokenResponse,
    previous?: AccountSessionRecord | null,
    authSource: AccountSessionRecord["authSource"] = previous?.authSource ?? "loopback",
  ): AccountSessionRecord => {
    const obtainedAtMs = now();
    const claims = decodeAccountClaims(token.accessToken);
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? previous?.refreshToken ?? null,
      tokenType: token.tokenType,
      expiresAt: new Date(obtainedAtMs + Math.trunc(token.expiresInSec * 1000)).toISOString(),
      obtainedAt: new Date(obtainedAtMs).toISOString(),
      userId: claims.userId ?? previous?.userId ?? null,
      email: claims.email ?? previous?.email ?? null,
      name: claims.name ?? previous?.name ?? null,
      authSource,
    };
  };

  const exchangeAuthorizationCode = async (
    session: PendingLoginSession,
    code: string,
  ): Promise<AccountSessionRecord> => {
    const config = normalizeOAuthConfig(await args.getOAuthConfig());
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
    return buildSessionRecord(token, null, "loopback");
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

    const config = normalizeOAuthConfig(await args.getOAuthConfig());
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

  const resolveDeviceBridgeUrl = async (): Promise<string> => normalizeDeviceBridgeUrl(
    args.getDeviceBridgeUrl
      ? await args.getDeviceBridgeUrl()
      : env.ADE_ACCOUNT_DIRECTORY_URL ?? "",
  );

  const startDeviceLogin = async (): Promise<AccountDeviceLoginStartResult> => {
    if (readEnvCredential()) {
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
    const response = await fetchImpl(`${bridgeUrl}/device/code`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ device_secret: deviceSecret }),
    });
    const payload = asRecord(await response.json().catch(() => ({})));
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

  const pollDeviceLogin = async (sessionId: string): Promise<AccountDeviceLoginPollResult> => {
    const normalizedSessionId = sessionId.trim();
    const session = pendingDeviceSessions.get(normalizedSessionId);
    if (!normalizedSessionId || !session) {
      return {
        status: "error",
        message: normalizedSessionId
          ? "ADE account device sign-in session was not found."
          : "ADE account device sign-in session id is required.",
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

    const epochAtPoll = authEpoch;
    const response = await fetchImpl(`${session.bridgeUrl}/device/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        device_code: session.deviceCode,
        device_secret: session.deviceSecret,
      }),
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      const errorCode = readNonEmptyString(payload.error);
      const intervalSec = readPositiveNumber(payload.interval) ?? session.intervalSec;
      if (errorCode === "authorization_pending" || errorCode === "slow_down") {
        session.intervalSec = intervalSec;
        return {
          status: errorCode === "slow_down" ? "slow_down" : "pending",
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
    const record = buildSessionRecord({
      accessToken,
      refreshToken: readNonEmptyString(payload.refresh_token),
      tokenType: readNonEmptyString(payload.token_type) ?? "Bearer",
      expiresInSec,
    }, null, "device");
    persistSession(record);
    authEpoch += 1;
    pendingDeviceSessions.delete(normalizedSessionId);
    logger.info("account.device_login_completed");
    return {
      status: "signed_in",
      message: null,
      intervalSec: null,
      authStatus: toStatus(record),
    };
  };

  const getStatus = (): AccountAuthStatus => {
    const envCredential = readEnvCredential();
    return envCredential ? envCredentialStatus(envCredential) : toStatus(readSession());
  };

  const getAccessToken = async (): Promise<string> => {
    const envCredential = readEnvCredential();
    if (envCredential) {
      resetEnvSessionIfCredentialChanged(envCredential);
      const directExpiresAt = accessTokenExpiresAt(envCredential);
      if (classifyEnvCredential(envCredential) === "access_token") {
        if (!directExpiresAt) {
          throw new Error(
            "ADE_ACCOUNT_TOKEN access token does not contain a usable expiration claim. Replace it with a current access token or a durable refresh token.",
          );
        }
        const expiresAtMs = Date.parse(directExpiresAt);
        if (expiresAtMs > now()) return envCredential;
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
        envRefreshInFlight = (async () => {
          const config = normalizeOAuthConfig(await args.getOAuthConfig());
          const token = await postTokenForm({
            fetchImpl,
            tokenUrl: `${config.issuer}/oauth/token`,
            body: {
              grant_type: "refresh_token",
              refresh_token: envRefreshToken ?? envCredential,
              client_id: config.clientId,
            },
          });
          envRefreshToken = token.refreshToken ?? envRefreshToken ?? envCredential;
          const refreshed = buildSessionRecord(token, envSession, "loopback");
          envSession = refreshed;
          return refreshed;
        })().finally(() => {
          envRefreshInFlight = null;
        });
      }
      return (await envRefreshInFlight).accessToken;
    }

    const record = readSession();
    if (!record?.accessToken) {
      throw new Error("ADE is not signed in. Run `ade login` to sign in.");
    }
    const expiresAtMs = Date.parse(record.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
      return record.accessToken;
    }
    if (!record.refreshToken) {
      throw new Error("ADE account session expired. Run `ade login` again.");
    }

    const epochAtJoin = authEpoch;
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const config = normalizeOAuthConfig(await args.getOAuthConfig());
        const token = await postTokenForm({
          fetchImpl,
          tokenUrl: `${config.issuer}/oauth/token`,
          body: {
            grant_type: "refresh_token",
            refresh_token: record.refreshToken!,
            client_id: config.clientId,
          },
        });
        const refreshed = buildSessionRecord(token, record);
        if (authEpoch === epochAtJoin) persistSession(refreshed);
        return refreshed;
      })().finally(() => {
        refreshInFlight = null;
      });
    }

    const refreshed = await refreshInFlight;
    if (authEpoch !== epochAtJoin) {
      return getAccessToken();
    }
    return refreshed.accessToken;
  };

  const createToken = (): AccountTokenCreateResult => {
    if (readEnvCredential()) {
      throw new Error(
        "ADE is using ADE_ACCOUNT_TOKEN. Unset it and sign in interactively before creating a new durable account token.",
      );
    }
    const record = readSession();
    if (!record?.refreshToken) {
      throw new Error("The current ADE account session has no refresh token. Run `ade login` again, then retry.");
    }
    return {
      token: record.refreshToken,
      source: "refresh_token",
      guidance: "Set this secret as ADE_ACCOUNT_TOKEN in the agent or CI environment. Store it in a secret manager; do not commit or log it.",
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

  const dispose = (): void => {
    for (const session of pendingSessions.values()) {
      clearTimeout(session.expiryTimer);
      closeServer(session.server);
    }
    pendingSessions.clear();
    pendingDeviceSessions.clear();
  };

  return {
    startLogin,
    pollLogin,
    startDeviceLogin,
    pollDeviceLogin,
    getStatus,
    getAccessToken,
    createToken,
    cancelLogin,
    signOut,
    dispose,
  };
}
