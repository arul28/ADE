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
import {
  CREDENTIAL_STORE_LOCK_TIMEOUT_MS,
  type CredentialStoreReadFailureReason,
  type SyncCredentialStore,
} from "../credentials/credentialStore";
import { runWithAbortSignal } from "../sync/abortSignal";
import { createRotationJournal } from "./accountSessionRotationJournal";

export const ACCOUNT_SESSION_CREDENTIAL_KEY = "account.session.v1";
export { ACCOUNT_SESSION_ROTATION_JOURNAL_KEY } from "./accountSessionRotationJournal";

const LOOPBACK_HOST = "127.0.0.1";
const LOGIN_SESSION_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
const MAX_PENDING_LOGIN_SESSIONS = 5;
const DEVICE_BRIDGE_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Local lifetime of a directory-minted pairing grant. Mirrors the directory's
 * own `PAIRING_GRANT_TTL_MS`; if the two ever drift, the shorter one wins and
 * the only cost is a grant the machine declines to send.
 */
const PAIRING_GRANT_TTL_MS = 10 * 60_000;
const USERINFO_REQUEST_TIMEOUT_MS = 5_000;
// The desktop and CLI brain can refresh the same rotating Clerk grant from
// separate processes. Give the winning process enough time to receive and
// durably compare-and-swap its replacement before a loser marks the old grant
// dead after invalid_grant. This path only runs after a definitive rejection.
//
// The window MUST out-wait the credential store's own lock timeout. The winner
// persists its replacement through that lock, so a wait shorter than the lock
// timeout can expire while the winner is still legitimately queued — and the
// loser would then declare a live session dead. Lock timeout plus a margin for
// the write itself is the floor.
const REFRESH_ROTATION_WAIT_MARGIN_MS = 5_000;
export const DEFAULT_REFRESH_ROTATION_WAIT_MS =
  CREDENTIAL_STORE_LOCK_TIMEOUT_MS + REFRESH_ROTATION_WAIT_MARGIN_MS;
const REFRESH_ROTATION_WAIT_MS = DEFAULT_REFRESH_ROTATION_WAIT_MS;
const REFRESH_ROTATION_POLL_MS = 50;
// Upper bound for the process-wide coalesced token exchange. It is owned by
// the service, not by any caller, so one caller's abort cannot cancel the
// refresh other callers are awaiting.
const SHARED_REFRESH_TIMEOUT_MS = 30_000;
/**
 * Headroom the shared exchange needs on top of its own rotation waits.
 *
 * The invalid_grant path can spend up to two rotation windows (the second one
 * only after an interrupted journal). If the shared timeout cut those windows
 * short, the widened wait would be decorative. Individual callers are never
 * held hostage by it — each races its own signal and `timeoutMs` at the join.
 */
const SHARED_REFRESH_ROTATION_HEADROOM_MS = 15_000;
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
  /**
   * Set when the identity provider definitively rejected this grant. The record
   * is kept in place rather than deleted: erasing it makes every process on the
   * machine silently forget an account the user never signed out of, and takes
   * the host's relay tunnel and directory row down with it. A marked record
   * renders as "signed out — sign in again" everywhere, and the next successful
   * sign-in overwrites it.
   */
  rejectedAt?: string;
  /** Companion to `rejectedAt`, for humans reading the credential file. */
  needsReauth?: true;
  /** The OAuth error code that condemned the grant, when there was one. */
  rejectedReason?: string;
};

export type AccountAnalyticsIdentity = {
  identifyAccount(userId: string | null | undefined): unknown;
  resetAccountIdentity(): unknown;
};

export type AccountAuthSource = "loopback" | "device" | "env-token" | null;

export type AccountIdentityProvider = "github" | "google" | "apple" | "email";

/**
 * Why `signedIn` is false, for surfaces that need different words for each.
 *
 * Additive and optional: every existing consumer keeps reading `signedIn`
 * alone, and the desktop wire shape is unchanged.
 * - `active` — signed in.
 * - `signed_out` — no session on this machine; offer sign-in.
 * - `expired` — a session exists but the provider rejected its grant. Offer
 *   sign-in, and say the session expired rather than pretending it never was.
 * - `unreadable` — the credential store could not be read. Nothing about the
 *   account changed; do NOT invite the user to sign in over a valid session.
 */
export type AccountSessionState = "active" | "signed_out" | "expired" | "unreadable";

export type AccountAuthStatus = {
  signedIn: boolean;
  userId: string | null;
  email: string | null;
  name: string | null;
  expiresAt: string | null;
  source?: AccountAuthSource;
  provider?: AccountIdentityProvider | null;
  imageUrl?: string | null;
  sessionState?: AccountSessionState;
};

export type AccountSessionReadState = "available" | "missing" | "unreadable";

/** Which process mutated the stored session, for attributed audit logging. */
export type AccountSessionMutationSource = "brain" | "cli" | "desktop";

/** Every distinct mutation of the machine-shared account session record. */
export type AccountSessionMutationAction =
  | "persist"
  | "rotate"
  | "delete"
  | "mark_dead"
  | "sign_out"
  | "rotation_journal_begin"
  | "rotation_journal_clear"
  | "rotation_journal_interrupted";

/**
 * Which read path produced an "unreadable" session. Coarse and closed so it can
 * be reported as a product-analytics property.
 */
export type AccountSessionReadFailureReason =
  /** Everything the credential store itself can report (decrypt/key-material/format). */
  | CredentialStoreReadFailureReason
  /** The credential decrypted but the stored session record did not parse. */
  | "session_parse"
  /** The credential store threw while being read. */
  | "read_error";

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
  /** Why the last read was unreadable, or null when it was not. */
  getSessionReadFailureReason(): AccountSessionReadFailureReason | null;
  /**
   * Coarse lifecycle of the persisted session, refreshed by the same reads.
   * Optional so existing test doubles and remote proxies stay valid; the same
   * value also rides on `AccountAuthStatus.sessionState`.
   */
  getSessionState?(): AccountSessionState;
  getAccessToken(options?: AccountAccessTokenOptions): Promise<string>;
  createToken(): Promise<AccountTokenCreateResult>;
  cancelLogin(sessionId: string): void;
  signOut(): AccountAuthStatus;
  /** Notification emitted after a local or externally persisted sign-in. */
  onSignedIn(listener: () => void): () => void;
  /**
   * Take the single-use pairing grant the directory minted when this machine
   * last completed a `/device/*` sign-in, or `null` when there is none.
   *
   * Reading it consumes it: a grant is spendable exactly once server-side, so
   * holding it locally past the attempt that spends it only creates a second
   * copy of a dead secret. Deliberately NOT an `account.call` action — it is a
   * seam between the auth service and this machine's own publisher, and nothing
   * that crosses the RPC boundary should be able to ask for it.
   */
  consumePairingGrant(): string | null;
  dispose(): void;
};

export type AccountAccessTokenOptions = {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
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
  options?: AccountAccessTokenOptions,
): Promise<string | null> {
  const status = service.getStatus();
  if (!status.signedIn && status.source !== "env-token") return null;
  try {
    const accessToken = (await service.getAccessToken(options)).trim();
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

export function shouldRejectDevelopmentEnvCredential(
  env: NodeJS.ProcessEnv,
  credential: string,
): boolean {
  const inspected = inspectEnvCredential(credential);
  return shouldRejectDevelopmentAccountMaterial({
    env,
    accessToken: inspected.kind === "invalid" ? null : inspected.token,
    oauthConfig: inspected.kind === "refresh_token" ? inspected.oauthConfig : null,
  });
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
    const claims = decodeAccountClaims(accessToken);
    const storedUserId = readNonEmptyString(parsed.userId);
    if (storedUserId && claims.userId && storedUserId !== claims.userId) return null;
    // `needsReauth` alone is enough to condemn the record: a marker written by a
    // future/older peer without a parsable timestamp must still be honored.
    const rejectedAt = readNonEmptyString(parsed.rejectedAt)
      ?? (parsed.needsReauth === true ? obtainedAt : null);
    const rejectedReason = readNonEmptyString(parsed.rejectedReason);
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
      userId: storedUserId ?? claims.userId,
      email: readNonEmptyString(parsed.email),
      name: readNonEmptyString(parsed.name),
      provider: readIdentityProvider(parsed.provider),
      imageUrl: readNonEmptyString(parsed.imageUrl),
      authSource: readAuthSource(parsed.authSource),
      ...(parsed.suppressEnvCredential === true ? { suppressEnvCredential: true } : {}),
      ...(oauthConfig ? { oauthConfig } : {}),
      ...(rejectedAt ? { rejectedAt, needsReauth: true as const } : {}),
      ...(rejectedAt && rejectedReason ? { rejectedReason } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Stable, non-reversible identifier for a refresh-token generation.
 *
 * Used by the rotation journal and by every audit log line, so an operator can
 * follow one grant across processes without any token material reaching a log
 * file or a journal entry.
 */
export function accountTokenGeneration(token: string | null | undefined): string | null {
  const normalized = token?.trim();
  if (!normalized) return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
}

/**
 * Which process this is, for attributed audit logging.
 *
 * The brain is `ade serve`; the desktop is Electron proper (its own child
 * processes run with ELECTRON_RUN_AS_NODE=1 and are the brain or a CLI);
 * everything else is an `ade` invocation.
 */
export function deriveAccountSessionMutationSource(
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = process.argv,
): AccountSessionMutationSource | null {
  const explicit = readNonEmptyString(env.ADE_ACCOUNT_SESSION_SOURCE)?.toLowerCase();
  if (explicit === "brain" || explicit === "cli" || explicit === "desktop") return explicit;
  if (argv.slice(1).includes("serve")) return "brain";
  if (process.versions.electron && env.ELECTRON_RUN_AS_NODE !== "1") return "desktop";
  return "cli";
}

async function postTokenForm(args: {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  tokenUrl: string;
  body: Record<string, string>;
  signal?: AbortSignal;
}): Promise<TokenResponse> {
  const response = await args.fetchImpl(args.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(args.body).toString(),
    signal: args.signal,
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
  const signedIn = Boolean(record?.accessToken && record.userId);
  const expiresAt = record
    ? accessTokenExpiresAt(record.accessToken) ?? record.expiresAt
    : null;
  return {
    // A usable account session always has a stable verified subject. Never
    // expose a half-session as signed in: account-owned trust is keyed by this
    // identity throughout the directory, relay, and pairing flows.
    signedIn,
    userId: signedIn ? record?.userId ?? null : null,
    email: signedIn ? record?.email ?? null : null,
    name: signedIn ? record?.name ?? null : null,
    expiresAt: signedIn ? expiresAt : null,
    source: signedIn && record ? record.authSource ?? "loopback" : null,
    ...(signedIn && record?.provider ? { provider: record.provider } : {}),
    ...(signedIn && record?.imageUrl ? { imageUrl: record.imageUrl } : {}),
  };
}

/**
 * Whether this machine is still THIS user's, even though the session cannot be
 * used right now.
 *
 * `signedIn` answers "can I call the API"; this answers "is this still their
 * machine". The two are only the same for a deliberate sign-out. An expired
 * grant or an unreadable credential store is an accident, and reading it as a
 * sign-out is what took every remote route to a paired machine down with a
 * token problem. Reachability that a paired device already has must survive it;
 * anything that needs a live token must still gate on `signedIn`.
 */
export function accountSessionRetainsMachineOwnership(
  status: Pick<AccountAuthStatus, "signedIn" | "userId" | "sessionState">,
): boolean {
  if (status.signedIn) return Boolean(status.userId?.trim());
  return status.sessionState === "expired" || status.sessionState === "unreadable";
}

export function syncAccountAnalyticsIdentity(
  status: AccountAuthStatus,
  analytics?: AccountAnalyticsIdentity,
): AccountAuthStatus {
  if (status.signedIn) {
    analytics?.identifyAccount(status.userId);
  } else {
    analytics?.resetAccountIdentity();
  }
  return status;
}

export function createAccountActionDomainService(
  service: AccountAuthService,
  analytics?: AccountAnalyticsIdentity,
): AccountActionDomainService {
  return {
    startLogin: () => service.startLogin(),
    pollLogin: async (args) => {
      const result = await service.pollLogin(readNonEmptyString(args?.sessionId) ?? "");
      syncAccountAnalyticsIdentity(result.authStatus, analytics);
      return result;
    },
    startDeviceLogin: (args) => service.startDeviceLogin({
      ignoreEnvCredential: args?.ignoreEnvCredential === true,
    }),
    pollDeviceLogin: async (args) => {
      const result = await service.pollDeviceLogin(readNonEmptyString(args?.sessionId) ?? "");
      syncAccountAnalyticsIdentity(result.authStatus, analytics);
      return result;
    },
    status: () => syncAccountAnalyticsIdentity(service.getStatus(), analytics),
    cancelLogin: (args) => service.cancelLogin(readNonEmptyString(args?.sessionId) ?? ""),
    signOut: () => {
      const status = service.signOut();
      analytics?.resetAccountIdentity();
      return status;
    },
    getToken: () => service.getAccessToken(),
    createToken: () => service.createToken(),
  };
}

export async function callAccountAction(args: {
  service: AccountAuthService;
  analytics?: AccountAnalyticsIdentity;
  action: string;
  actionArgs?: Record<string, unknown>;
}): Promise<{
  domain: "account";
  action: string;
  result: unknown;
  statusHints: Record<string, never>;
}> {
  const action = args.action as AccountActionName;
  const domain = createAccountActionDomainService(args.service, args.analytics);
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
  /**
   * This machine's sync machine key — the same identity the account directory
   * files it under. Sent when a device login starts so the grant minted at the
   * end of that sign-in can be bound to this machine and no other. Optional:
   * without it the login still works and the grant path is simply unavailable.
   */
  getMachineKey?: () => string | null;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  deviceBridgeRequestTimeoutMs?: number;
  userinfoRequestTimeoutMs?: number;
  refreshRotationWaitMs?: number;
  refreshRotationPollMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
  logger?: AccountAuthLogger;
  /** Overrides the derived brain/cli/desktop attribution on audit log lines. */
  sessionMutationSource?: AccountSessionMutationSource | null;
  /** Overrides `process.pid` on audit log lines and journal entries. */
  pid?: number;
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
  const refreshRotationWaitMs = typeof args.refreshRotationWaitMs === "number"
    && Number.isFinite(args.refreshRotationWaitMs)
    && args.refreshRotationWaitMs >= 0
    ? Math.trunc(args.refreshRotationWaitMs)
    : REFRESH_ROTATION_WAIT_MS;
  const refreshRotationPollMs = typeof args.refreshRotationPollMs === "number"
    && Number.isFinite(args.refreshRotationPollMs)
    && args.refreshRotationPollMs > 0
    ? Math.trunc(args.refreshRotationPollMs)
    : REFRESH_ROTATION_POLL_MS;
  const sharedRefreshTimeoutMs = Math.max(
    SHARED_REFRESH_TIMEOUT_MS,
    refreshRotationWaitMs * 2 + SHARED_REFRESH_ROTATION_HEADROOM_MS,
  );
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
  /**
   * Single-use pairing grant from the last completed device sign-in, held only
   * until this machine's publisher spends it (or it expires). The local expiry
   * mirrors the directory's, so a grant the server would already refuse is
   * never put on the wire.
   */
  let pairingGrant: { value: string; expiresAtMs: number } | null = null;
  let sessionReadState: AccountSessionReadState = "missing";
  let sessionReadFailureReason: AccountSessionReadFailureReason | null = null;
  const setSessionReadState = (
    state: AccountSessionReadState,
    reason: AccountSessionReadFailureReason | null = null,
  ): void => {
    sessionReadState = state;
    sessionReadFailureReason = state === "unreadable" ? reason : null;
  };
  let lastObservedSignedIn: boolean | null = null;
  let locallyRejectedSessionRaw: string | null = null;
  /**
   * Why the locally-rejected raw record is rejected. A grant the provider
   * condemned reads as `expired` (offer sign-in, say why); development material
   * a packaged build refuses reads as plain `signed_out`, exactly as before.
   */
  let locallyRejectedSessionState: Extract<AccountSessionState, "expired" | "signed_out"> = "signed_out";
  /** Whether the last read observed a persisted record marked needs-re-auth. */
  let storedSessionRejected = false;
  const signedInListeners = new Set<() => void>();
  const mutationPid = typeof args.pid === "number" && Number.isSafeInteger(args.pid)
    ? args.pid
    : process.pid;
  const mutationSource = args.sessionMutationSource === undefined
    ? deriveAccountSessionMutationSource(env)
    : args.sessionMutationSource;

  /**
   * One attributed line per mutation of the machine-shared session record.
   *
   * The 2026-08-05 "randomly signed out" incident had an empty account.* log:
   * the deletion that erased the session for every process on the machine left
   * no trace at all. Every write, rotation, rejection and sign-out now names
   * itself, its reason, its process, and the token generation it acted on.
   */
  const logSessionMutation = (entry: {
    action: AccountSessionMutationAction;
    reason: string;
    level?: "info" | "warn";
    oauthErrorCode?: string | null;
    tokenGeneration?: string | null;
    outcome?: string;
  }): void => {
    const meta: Record<string, unknown> = {
      action: entry.action,
      reason: entry.reason,
      pid: mutationPid,
      source: mutationSource,
      tokenGeneration: entry.tokenGeneration ?? null,
    };
    if (entry.oauthErrorCode) meta.oauthErrorCode = entry.oauthErrorCode;
    if (entry.outcome) meta.outcome = entry.outcome;
    if (entry.level === "warn") logger.warn("account.session_mutation", meta);
    else logger.info("account.session_mutation", meta);
  };

  const readRawEnvCredential = (): string | null => readNonEmptyString(env[ACCOUNT_TOKEN_ENV_KEY]);

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

  const readAcceptedEnvCredential = (): {
    credential: string;
    inspected: EnvCredential;
  } | null => {
    const credential = readRawEnvCredential();
    if (!credential) return null;
    const inspected = inspectEnvCredential(credential);
    resetEnvSessionIfCredentialChanged(credential, inspected);
    return rejectDevelopmentEnvCredential(inspected)
      ? null
      : { credential, inspected };
  };

  const envCredentialStatus = (inspected: EnvCredential): AccountAuthStatus => {
    if (envSession) return { ...currentStatus(envSession), source: "env-token" };
    const isAccessToken = inspected.kind === "access_token";
    const accessToken = inspected.kind === "access_token" ? inspected.token : null;
    const expiresAt = accessToken ? accessTokenExpiresAt(accessToken) : null;
    const claims = expiresAt && accessToken
      ? decodeAccountClaims(accessToken)
      : { userId: null, email: null, name: null, provider: null, imageUrl: null };
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    return withSessionState({
      signedIn: isAccessToken
        && Boolean(claims.userId)
        && Number.isFinite(expiresAtMs)
        && expiresAtMs > now(),
      userId: claims.userId,
      email: claims.email,
      name: claims.name,
      expiresAt,
      source: "env-token",
      ...(claims.provider ? { provider: claims.provider } : {}),
      ...(claims.imageUrl ? { imageUrl: claims.imageUrl } : {}),
    });
  };

  const rotationJournal = createRotationJournal({
    credentialStore: args.credentialStore,
    now,
    pid: mutationPid,
    source: mutationSource,
    log: logSessionMutation,
  });

  const persistSession = (
    record: AccountSessionRecord | null,
    reason: string,
    action?: AccountSessionMutationAction,
  ): void => {
    locallyRejectedSessionRaw = null;
    locallyRejectedSessionState = "signed_out";
    storedSessionRejected = false;
    if (record) {
      args.credentialStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(record));
      // A successful sign-in is the definitive end of any prior rotation: the
      // journal describes a refresh token that no longer exists.
      rotationJournal.clear("session_replaced");
    } else {
      args.credentialStore.deleteSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
      rotationJournal.clear("session_removed");
    }
    lastObservedSignedIn = record != null;
    logSessionMutation({
      action: action ?? (record ? "persist" : "delete"),
      reason,
      level: record ? "info" : "warn",
      tokenGeneration: accountTokenGeneration(record?.refreshToken),
    });
  };

  const invalidateStoredSessionIfCurrent = (raw: string): void => {
    const updateSync = args.credentialStore.updateSync;
    if (updateSync) {
      // Atomic compare-and-delete: remove only the development session we
      // observed, so a production credential a peer wrote after our read is
      // never clobbered.
      updateSync.call(args.credentialStore, (values) => {
        if (values[ACCOUNT_SESSION_CREDENTIAL_KEY] !== raw) return false;
        delete values[ACCOUNT_SESSION_CREDENTIAL_KEY];
        return true;
      });
    }
    // Without atomic compare-and-delete we do NOT get-then-delete — that races a
    // peer-written production replacement. The development session is simply
    // rejected on every read instead of being erased.
    authEpoch += 1;
    lastObservedSignedIn = false;
    setSessionReadState("missing");
    logSessionMutation({
      action: "delete",
      reason: "development_material_rejected",
      level: "warn",
      outcome: args.credentialStore.updateSync ? "erased" : "rejected_locally",
    });
    warnDevelopmentClerkIgnored();
  };

  type AccountSessionSnapshot = {
    raw: string | null;
    session: AccountSessionRecord | null;
  };

  const readSessionSnapshot = (): AccountSessionSnapshot => {
    try {
      // A peer process may replace the credential between the read and the
      // atomic delete. Retry once so we never clear or surface that newer
      // session merely because an older development session was observed.
      const readStoredSession = (): AccountSessionSnapshot => {
        const stored = args.credentialStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
        const locallyRejected = locallyRejectedSessionRaw != null && stored === locallyRejectedSessionRaw;
        const parsed = locallyRejected ? null : parseStoredSession(stored);
        // A record the provider condemned stays on disk so no process silently
        // forgets the account, but it is never a usable session: everything
        // downstream sees "no session", with `expired` as the reason why.
        const markedDead = parsed?.rejectedAt != null;
        storedSessionRejected = markedDead
          || (locallyRejected && locallyRejectedSessionState === "expired");
        const session = markedDead ? null : parsed;
        if (locallyRejected || markedDead) {
          setSessionReadState("missing");
        } else if (stored == null) {
          const storeUnreadable = args.credentialStore.getLastReadState?.() === "unreadable";
          setSessionReadState(
            storeUnreadable ? "unreadable" : "missing",
            storeUnreadable
              ? args.credentialStore.getLastReadFailureReason?.() ?? null
              : null,
          );
        } else {
          setSessionReadState(session ? "available" : "unreadable", "session_parse");
        }
        return { raw: stored, session };
      };

      const observed = readStoredSession();
      if (!observed.session || !observed.raw) return observed;
      if (!shouldRejectDevelopmentAccountMaterial({
        env,
        accessToken: observed.session.accessToken,
        oauthConfig: observed.session.oauthConfig,
      })) {
        return observed;
      }

      invalidateStoredSessionIfCurrent(observed.raw);
      const retry = readStoredSession();
      if (!retry.session || !retry.raw) return { raw: retry.raw, session: null };
      if (shouldRejectDevelopmentAccountMaterial({
        env,
        accessToken: retry.session.accessToken,
        oauthConfig: retry.session.oauthConfig,
      })) {
        setSessionReadState("missing");
        return { raw: retry.raw, session: null };
      }
      return retry;
    } catch (error) {
      setSessionReadState("unreadable", "read_error");
      logger.warn("account.session_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { raw: null, session: null };
    }
  };

  const readSession = (): AccountSessionRecord | null => readSessionSnapshot().session;

  /**
   * Attach the reason `signedIn: false` is false. Additive only — `signedIn`
   * keeps its exact previous meaning for every existing consumer.
   */
  const withSessionState = (status: AccountAuthStatus): AccountAuthStatus => ({
    ...status,
    sessionState: status.signedIn
      ? "active"
      : sessionReadState === "unreadable"
        ? "unreadable"
        : storedSessionRejected
          ? "expired"
          : "signed_out",
  });

  const currentStatus = (record: AccountSessionRecord | null): AccountAuthStatus =>
    withSessionState(toStatus(record));

  /**
   * Mark the exact rejected record needs-re-auth IN PLACE. Never delete it.
   *
   * Deleting was the 2026-08-05 incident: one process losing a rotating grant
   * erased the shared credential, so the desktop, the brain and the CLI all
   * went from "signed in" to "no account" at once, and the host dropped its
   * relay tunnel and directory row with it. The record survives instead — every
   * process renders a deliberate "signed out — sign in again", `getStatus()`
   * reports `expired`, and the next successful sign-in overwrites the marker.
   */
  const markStoredSessionRejectedIfExact = (
    raw: string,
    session: AccountSessionRecord,
    oauthErrorCode: string | null,
  ): boolean => {
    locallyRejectedSessionRaw = raw;
    locallyRejectedSessionState = "expired";
    storedSessionRejected = true;
    const rejected: AccountSessionRecord = {
      ...session,
      rejectedAt: new Date(now()).toISOString(),
      needsReauth: true,
      ...(oauthErrorCode ? { rejectedReason: oauthErrorCode } : {}),
    };
    const updateSync = args.credentialStore.updateSync;
    let marked = false;
    if (updateSync) {
      // Compare-and-swap on the exact bytes we were rejected for: a replacement
      // a peer persisted after our read must never be condemned.
      updateSync.call(args.credentialStore, (values) => {
        if (values[ACCOUNT_SESSION_CREDENTIAL_KEY] !== raw) return false;
        values[ACCOUNT_SESSION_CREDENTIAL_KEY] = JSON.stringify(rejected);
        marked = true;
        return true;
      });
    }
    // Without compare-and-swap the marker cannot be written safely, but this
    // process must still stop serving the dead grant. It is rejected on every
    // local read instead.
    authEpoch += 1;
    lastObservedSignedIn = false;
    setSessionReadState("missing");
    rotationJournal.clear("grant_rejected", accountTokenGeneration(session.refreshToken));
    logSessionMutation({
      action: "mark_dead",
      reason: "refresh_grant_rejected",
      level: "warn",
      oauthErrorCode,
      tokenGeneration: accountTokenGeneration(session.refreshToken),
      outcome: marked ? "marked_needs_reauth" : "rejected_locally",
    });
    return marked;
  };

  const waitForRefreshRotation = async (
    rejected: { raw: string; session: AccountSessionRecord },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "rotated"; snapshot: { raw: string; session: AccountSessionRecord } }
    | { kind: "superseded" }
    | { kind: "unchanged" }
  > => {
    let waitedMs = 0;
    while (true) {
      signal?.throwIfAborted();
      const latest = readSessionSnapshot();
      if (latest.raw !== rejected.raw) {
        if (
          latest.raw
          && latest.session?.refreshToken
          && latest.session.refreshToken !== rejected.session.refreshToken
          && latest.session.userId === rejected.session.userId
        ) {
          return {
            kind: "rotated",
            snapshot: { raw: latest.raw, session: latest.session },
          };
        }
        return { kind: "superseded" };
      }
      if (waitedMs >= refreshRotationWaitMs) return { kind: "unchanged" };
      const delayMs = Math.min(refreshRotationPollMs, refreshRotationWaitMs - waitedMs);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("The account token request was aborted.", "AbortError"),
          );
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      waitedMs += delayMs;
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
    expectedRaw: string,
    reason: string,
    /** Generation this exchange journaled, so only our own entry is cleared. */
    journaledTokenGeneration?: string | null,
  ): boolean => {
    const updateSync = args.credentialStore.updateSync;
    if (!updateSync) {
      if (args.credentialStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY) !== expectedRaw) {
        // A peer persisted first, but our exchange is still over — the
        // generation we journaled is spent either way. Scoped, so a peer's
        // newer entry survives. Without this the entry outlives the rotation
        // and makes the next refresh wait on a rotation nobody is running.
        // Truthiness, not `!== undefined`: an explicit null would clear the
        // journal UNSCOPED and could delete a peer's newer entry.
        if (journaledTokenGeneration) {
          rotationJournal.clear("rotation_superseded", journaledTokenGeneration);
        }
        return false;
      }
      // persistSession clears the journal on the way through.
      persistSession(refreshed, reason);
      return true;
    }

    let persisted = false;
    updateSync.call(args.credentialStore, (values) => {
      if (values[ACCOUNT_SESSION_CREDENTIAL_KEY] !== expectedRaw) return false;
      values[ACCOUNT_SESSION_CREDENTIAL_KEY] = JSON.stringify(refreshed);
      persisted = true;
      return true;
    });
    if (persisted) {
      lastObservedSignedIn = true;
      locallyRejectedSessionRaw = null;
      locallyRejectedSessionState = "signed_out";
      storedSessionRejected = false;
    }
    // The exchange completed either way: our journaled generation is spent, so
    // its entry has nothing left to protect. A peer's newer entry is untouched.
    if (journaledTokenGeneration) {
      rotationJournal.clear(
        persisted ? "rotation_persisted" : "rotation_superseded",
        journaledTokenGeneration,
      );
    }
    logSessionMutation({
      action: "rotate",
      reason,
      tokenGeneration: accountTokenGeneration(refreshed.refreshToken),
      outcome: persisted ? "persisted" : "superseded_by_peer",
    });
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
    signal?: AbortSignal,
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
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new DOMException("The account userinfo request timed out.", "TimeoutError"));
    }, userinfoRequestTimeoutMs);
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
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  };

  const buildSessionRecord = async (
    token: TokenResponse,
    previous?: AccountSessionRecord | null,
    authSource: AccountSessionRecord["authSource"] = previous?.authSource ?? "loopback",
    oauthConfig: AccountOAuthConfig | null = previous?.oauthConfig ?? null,
    options: {
      fetchUserinfo?: boolean;
      obtainedAtMs?: number;
      signal?: AbortSignal;
    } = {},
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
    const obtainedAtMs = options.obtainedAtMs ?? now();
    const claims = decodeAccountClaims(token.accessToken);
    const claimedExpiresAt = accessTokenExpiresAt(token.accessToken);
    if (
      previous?.userId
      && claims.userId
      && previous.userId !== claims.userId
    ) {
      throw new Error("ADE account refresh returned a different account identity. Sign in again.");
    }
    const userinfo = options.fetchUserinfo === false
      ? null
      : await fetchUserinfoProfile(token, oauthConfig, options.signal);
    if (
      userinfo?.userId
      && (
        (previous?.userId && previous.userId !== userinfo.userId)
        || (claims.userId && claims.userId !== userinfo.userId)
      )
    ) {
      throw new Error("ADE account userinfo returned a different account identity. Sign in again.");
    }
    const userId = previous?.userId ?? claims.userId ?? userinfo?.userId ?? null;
    if (!userId) {
      throw new Error("ADE account sign-in did not return a stable user identity. Sign in again.");
    }
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
      userId,
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
      persistSession(record, "loopback_login_completed");
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
    if (readAcceptedEnvCredential()) {
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
        authStatus: currentStatus(readSession()),
      };
    }
    const session = pendingSessions.get(normalizedSessionId);
    if (!session) {
      return {
        status: "error",
        message: "ADE account sign-in session was not found.",
        authStatus: currentStatus(readSession()),
      };
    }
    if (session.expiresAtMs <= now()) expirePendingSession(session);
    if (session.phase === "pending" || session.phase === "exchanging") {
      return { status: "pending", message: null, authStatus: currentStatus(readSession()) };
    }
    pendingSessions.delete(normalizedSessionId);
    if (session.phase === "signed_in") {
      return { status: "signed_in", message: null, authStatus: currentStatus(readSession()) };
    }
    return {
      status: session.phase,
      message: session.message,
      authStatus: currentStatus(readSession()),
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
    if (readAcceptedEnvCredential() && !options.ignoreEnvCredential) {
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
    let machineKey: string | null = null;
    try {
      machineKey = args.getMachineKey?.()?.trim() || null;
    } catch {
      // An unreadable machine identity costs the grant, never the sign-in.
      machineKey = null;
    }
    let response: Response;
    try {
      response = await requestDeviceBridge(`${bridgeUrl}/device/code`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          device_secret: deviceSecret,
          ...(machineKey ? { machine_key: machineKey } : {}),
        }),
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
          authStatus: currentStatus(readSession()),
        };
      }
      if (session.expiresAtMs <= now()) {
        pendingDeviceSessions.delete(normalizedSessionId);
        return {
          status: "expired",
          message: "ADE account device sign-in expired.",
          intervalSec: null,
          authStatus: currentStatus(readSession()),
        };
      }
      return {
        status: "pending",
        message: null,
        intervalSec: session.intervalSec,
        authStatus: currentStatus(readSession()),
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
          authStatus: currentStatus(readSession()),
        };
      }
      return {
        status: "pending",
        message: null,
        intervalSec: session.intervalSec,
        authStatus: currentStatus(readSession()),
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
        authStatus: currentStatus(readSession()),
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
          authStatus: currentStatus(readSession()),
        };
      }
      pendingDeviceSessions.delete(normalizedSessionId);
      if (errorCode === "expired" || errorCode === "expired_token") {
        return {
          status: "expired",
          message: "ADE account device sign-in expired.",
          intervalSec: null,
          authStatus: currentStatus(readSession()),
        };
      }
      return {
        status: "error",
        message: readNonEmptyString(payload.error_description)
          ?? (errorCode === "invalid_grant"
            ? "ADE account device sign-in could not be redeemed."
            : errorCode ?? `ADE account device token request failed (${response.status}).`),
        intervalSec: null,
        authStatus: currentStatus(readSession()),
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
        authStatus: currentStatus(readSession()),
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
        authStatus: currentStatus(readSession()),
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
        authStatus: currentStatus(readSession()),
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
        authStatus: currentStatus(readSession()),
      };
    }
    // The directory's proof that a human just signed in on THIS machine, for
    // the case where the access token carries no authentication-time claim the
    // directory could check instead. Kept in memory only: it is a bearer secret
    // with a minutes-long life whose one consumer — this machine's publisher —
    // runs in this same process, so writing it to disk would widen its blast
    // radius without extending its usefulness.
    const grant = readNonEmptyString(payload.pairing_grant);
    pairingGrant = grant ? { value: grant, expiresAtMs: now() + PAIRING_GRANT_TTL_MS } : null;
    const record: AccountSessionRecord = session.suppressEnvCredential
      ? { ...baseRecord, suppressEnvCredential: true }
      : baseRecord;
    persistSession(record, "device_login_completed");
    authEpoch += 1;
    notifySignedIn();
    pendingDeviceSessions.delete(normalizedSessionId);
    logger.info("account.device_login_completed");
    return {
      status: "signed_in",
      message: null,
      intervalSec: null,
      authStatus: currentStatus(record),
    };
  };

  const pollDeviceLogin = async (sessionId: string): Promise<AccountDeviceLoginPollResult> => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return {
        status: "error",
        message: "ADE account device sign-in session id is required.",
        intervalSec: null,
        authStatus: currentStatus(readSession()),
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
        authStatus: currentStatus(readSession()),
      };
    }
    if (session.expiresAtMs <= now()) {
      pendingDeviceSessions.delete(normalizedSessionId);
      return {
        status: "expired",
        message: "ADE account device sign-in expired.",
        intervalSec: null,
        authStatus: currentStatus(readSession()),
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
    if (record?.suppressEnvCredential) return currentStatus(record);
    const envCredential = readAcceptedEnvCredential();
    return envCredential ? envCredentialStatus(envCredential.inspected) : currentStatus(record);
  };

  const getAccessTokenWithSignal = async (
    options: Pick<AccountAccessTokenOptions, "forceRefresh">,
    signal?: AbortSignal,
  ): Promise<string> => {
    signal?.throwIfAborted();
    const sessionSnapshot = readSessionSnapshot();
    const record = sessionSnapshot.session;
    const acceptedEnvCredential = readAcceptedEnvCredential();
    if (acceptedEnvCredential && !record?.suppressEnvCredential) {
      const { credential: envCredential, inspected } = acceptedEnvCredential;
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
        if (expiresAtMs > now()) {
          if (!decodeAccountClaims(inspected.token).userId) {
            throw new Error(
              "ADE_ACCOUNT_TOKEN access token does not contain a stable account identity.",
            );
          }
          return inspected.token;
        }
        throw new Error(
          `ADE_ACCOUNT_TOKEN access token expired at ${directExpiresAt}. Replace it with a current access token or a durable refresh token.`,
        );
      }
      if (envSession && options.forceRefresh !== true) {
        const expiresAtMs = Date.parse(envSession.expiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs > now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
          return envSession.accessToken;
        }
      }
      if (!envRefreshInFlight) {
        const credentialAtRefresh = envCredential;
        const epochAtRefresh = envCredentialEpoch;
        const refreshTokenAtRefresh = envRefreshToken ?? inspected.token;
        // Same caller-isolation rule as the session refresh below: the shared
        // env-token exchange runs under service-owned cancellation.
        const envSharedRefresh = new AbortController();
        const envSharedTimer = setTimeout(
          () => envSharedRefresh.abort(new Error("The shared ADE_ACCOUNT_TOKEN refresh timed out.")),
          sharedRefreshTimeoutMs,
        );
        envSharedTimer.unref?.();
        const envSharedSignal = envSharedRefresh.signal;
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
              signal: envSharedSignal,
              body: {
                grant_type: "refresh_token",
                refresh_token: refreshTokenAtRefresh,
                client_id: config.clientId,
              },
            });
          } catch {
            envSharedSignal.throwIfAborted();
            throw new Error(
              "ADE_ACCOUNT_TOKEN refresh failed. Replace it with a newly provisioned token from `ade account token create`.",
            );
          }
          if (
            envCredentialEpoch !== epochAtRefresh
            || envSessionCredential !== credentialAtRefresh
            || readRawEnvCredential() !== credentialAtRefresh
            || envRefreshInFlight !== refreshPromise
          ) {
            // The credential changed while this process was refreshing. The
            // replacement is already newer than the request we started, so
            // consume it normally instead of force-rotating it again.
            return getAccessTokenWithSignal({}, signal);
          }
          envRefreshToken = token.refreshToken ?? refreshTokenAtRefresh;
          const refreshed = await buildSessionRecord(
            token,
            envSession,
            "loopback",
            config,
            { signal: envSharedSignal },
          );
          envSession = refreshed;
          return refreshed.accessToken;
        })().finally(() => {
          clearTimeout(envSharedTimer);
          // Single-flight must be released by the SHARED exchange settling,
          // never by an individual caller aborting out of the join below —
          // otherwise a second caller starts a competing OAuth exchange with
          // the same rotating refresh token.
          if (envRefreshInFlight === refreshPromise) envRefreshInFlight = null;
        });
        envRefreshInFlight = refreshPromise;
      }
      const refreshPromise = envRefreshInFlight;
      // Race the caller's own signal; the shared exchange keeps running for
      // every other caller when this one aborts.
      return await runWithAbortSignal(
        () => refreshPromise,
        signal ?? undefined,
        "The account token request was aborted.",
      );
    }

    if (!record?.accessToken || !record.userId) {
      // A session the provider condemned is still on disk. Say it expired
      // rather than pretending the machine was never signed in — the words
      // decide whether the user looks for a bug or just signs in again.
      throw new Error(
        storedSessionRejected
          ? "ADE account session expired. Run `ade login` again."
          : "ADE is not signed in. Run `ade login` to sign in.",
      );
    }
    const claimedExpiresAt = accessTokenExpiresAt(record.accessToken);
    const expiresAtMs = Date.parse(claimedExpiresAt ?? record.expiresAt);
    if (
      options.forceRefresh !== true
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > now() + ACCESS_TOKEN_REFRESH_SKEW_MS
    ) {
      return record.accessToken;
    }
    if (!record.refreshToken) {
      throw new Error("ADE account session expired. Run `ade login` again.");
    }

    const epochAtJoin = authEpoch;
    if (!refreshInFlight) {
      // The coalesced exchange is shared by every caller; a single caller's
      // abort must not cancel it for the rest. It runs under service-owned
      // cancellation, and each caller races its own signal at the join below.
      const sharedRefresh = new AbortController();
      const sharedRefreshTimer = setTimeout(
        () => sharedRefresh.abort(new Error("The shared account token refresh timed out.")),
        sharedRefreshTimeoutMs,
      );
      sharedRefreshTimer.unref?.();
      const sharedSignal = sharedRefresh.signal;
      refreshInFlight = (async () => {
        if (!sessionSnapshot.raw) return null;
        let refreshSnapshot = {
          raw: sessionSnapshot.raw,
          session: record,
        };
        let token: TokenResponse | null = null;
        let config: AccountOAuthConfig | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const refreshRecord = refreshSnapshot.session;
          config = refreshRecord.oauthConfig
            ? normalizeOAuthConfig(refreshRecord.oauthConfig)
            : await resolveOAuthConfig();
          const tokenGeneration = accountTokenGeneration(refreshRecord.refreshToken) ?? "";
          // Read the journal BEFORE writing ours: an entry still naming this
          // exact token generation means some process already started an
          // exchange against it and never finished. The `invalid_grant` that
          // follows is then explainable by that interruption, not proof that
          // the grant is dead, so it must not condemn the session.
          const priorJournal = rotationJournal.read();
          const interruptedRotation = priorJournal != null
            && priorJournal.oldRefreshTokenHash === tokenGeneration;
          if (interruptedRotation) {
            logSessionMutation({
              action: "rotation_journal_interrupted",
              reason: "unfinished_rotation_observed",
              level: "warn",
              tokenGeneration,
              outcome: `started_at:${priorJournal.startedAt} pid:${priorJournal.pid} source:${priorJournal.source ?? "unknown"}`,
            });
          }
          rotationJournal.write({
            oldRefreshTokenHash: tokenGeneration,
            userId: refreshRecord.userId,
          });
          try {
            token = await postTokenForm({
              fetchImpl,
              tokenUrl: `${config.issuer}/oauth/token`,
              signal: sharedSignal,
              body: {
                grant_type: "refresh_token",
                refresh_token: refreshRecord.refreshToken!,
                client_id: config.clientId,
              },
            });
            break;
          } catch (error) {
            if (
              !(error instanceof AccountTokenRequestError)
              || error.oauthErrorCode !== "invalid_grant"
            ) {
              throw error;
            }
            // The desktop and brain share this credential. A peer that won a
            // rotating refresh exchange may not have persisted its replacement
            // by the time Clerk rejects our old token, so poll before declaring
            // the grant dead. The window out-waits the credential store's lock
            // timeout, so a winner still queued for the lock cannot lose.
            let rotation = await waitForRefreshRotation(refreshSnapshot, sharedSignal);
            if (rotation.kind === "rotated" && attempt === 0) {
              refreshSnapshot = rotation.snapshot;
              continue;
            }
            if (rotation.kind !== "unchanged") return null;
            if (interruptedRotation) {
              // An interrupted journal makes this rejection ambiguous: the
              // stored token may already have been spent by the process that
              // died. Spend one more rotation-wait cycle, then give up for this
              // attempt WITHOUT condemning the session. Clearing the journal
              // makes the next refresh definitive, so an actually-dead grant
              // still reaches the needs-re-auth state one attempt later.
              rotation = await waitForRefreshRotation(refreshSnapshot, sharedSignal);
              if (rotation.kind === "rotated" && attempt === 0) {
                refreshSnapshot = rotation.snapshot;
                continue;
              }
              if (rotation.kind !== "unchanged") return null;
              rotationJournal.clear("interrupted_rotation_inconclusive", tokenGeneration);
              logSessionMutation({
                action: "rotation_journal_interrupted",
                reason: "invalid_grant_not_definitive",
                level: "warn",
                oauthErrorCode: error.oauthErrorCode,
                tokenGeneration,
                outcome: "session_preserved",
              });
              throw error;
            }
            const marked = markStoredSessionRejectedIfExact(
              refreshSnapshot.raw,
              refreshSnapshot.session,
              error.oauthErrorCode,
            );
            if (!marked && readSessionSnapshot().raw !== refreshSnapshot.raw) {
              return null;
            }
            throw error;
          }
        }
        if (!token || !config) {
          throw new Error("ADE account session expired. Run `ade login` again.");
        }
        if (authEpoch !== epochAtJoin) return null;
        const obtainedAtMs = now();
        const refreshed = await buildSessionRecord(
          token,
          refreshSnapshot.session,
          undefined,
          config,
          { fetchUserinfo: false, obtainedAtMs, signal: sharedSignal },
        );
        if (authEpoch !== epochAtJoin) return null;
        if (!persistRefreshedSessionIfCurrent(
          refreshed,
          refreshSnapshot.raw,
          "refresh_token_rotated",
          accountTokenGeneration(refreshSnapshot.session.refreshToken),
        )) {
          return null;
        }

        // The rotated access/refresh pair is durable before optional profile
        // enrichment. Identity is carried from the previously verified subject,
        // so avoidable userinfo latency cannot expose a stale refresh token to a
        // second process.
        let enriched: AccountSessionRecord;
        try {
          enriched = await buildSessionRecord(
            token,
            refreshSnapshot.session,
            undefined,
            config,
            { obtainedAtMs, signal: sharedSignal },
          );
        } catch (error) {
          if (sharedSignal.aborted) throw error;
          // The rotated credential and verified prior subject are already
          // durable. Optional profile enrichment must not make that successful
          // refresh unusable.
          return readSession() ?? refreshed;
        }
        if (authEpoch !== epochAtJoin) return null;
        const refreshedRaw = JSON.stringify(refreshed);
        return persistRefreshedSessionIfCurrent(
          enriched,
          refreshedRaw,
          "refresh_profile_enriched",
        )
          ? enriched
          : readSession();
      })().finally(() => {
        clearTimeout(sharedRefreshTimer);
        refreshInFlight = null;
      });
    }

    // Join the shared exchange but race the caller's own signal: an aborting
    // caller leaves; the refresh keeps running for everyone else.
    const joinedRefresh = refreshInFlight;
    const refreshed = await runWithAbortSignal(
      () => joinedRefresh,
      signal,
      "The account token request was aborted.",
    );
    if (authEpoch !== epochAtJoin || !refreshed) {
      // A peer process may have won the refresh CAS. Its replacement token
      // satisfies this forced refresh; forcing another exchange here would
      // immediately consume the newly rotated refresh token and recreate the
      // cross-process race this path is designed to avoid.
      return getAccessTokenWithSignal({}, signal);
    }
    return refreshed.accessToken;
  };

  const getAccessToken = async (
    options: AccountAccessTokenOptions = {},
  ): Promise<string> => {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const requestedTimeoutMs = options.timeoutMs;
    const timeoutMs = typeof requestedTimeoutMs === "number"
      && Number.isFinite(requestedTimeoutMs)
      && requestedTimeoutMs > 0
      ? Math.trunc(requestedTimeoutMs)
      : null;
    const timeout = timeoutMs == null
      ? null
      : setTimeout(() => {
          controller.abort(new DOMException("The account token request timed out.", "TimeoutError"));
        }, timeoutMs);
    timeout?.unref?.();
    let rejectOnAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new DOMException("The account token request was aborted.", "AbortError"),
      );
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    try {
      return await Promise.race([
        getAccessTokenWithSignal(
          { ...(options.forceRefresh ? { forceRefresh: true } : {}) },
          controller.signal,
        ),
        aborted,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (rejectOnAbort) {
        controller.signal.removeEventListener("abort", rejectOnAbort);
      }
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  };

  const createToken = async (): Promise<AccountTokenCreateResult> => {
    const record = readSession();
    if (readAcceptedEnvCredential() && !record?.suppressEnvCredential) {
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
  //
  // Serves BOTH sign-in flows — it checks the loopback `pendingSessions` map and
  // then the `pendingDeviceSessions` map — so there is no separate device-flow
  // canceller. The desktop's `cancelDeviceLogin` bridge method routes here, to
  // this same `"cancelLogin"` brain action; grepping the brain for
  // `cancelDeviceLogin` finds nothing by design.
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

  const consumePairingGrant = (): string | null => {
    const held = pairingGrant;
    pairingGrant = null;
    return held && held.expiresAtMs > now() ? held.value : null;
  };

  const signOut = (): AccountAuthStatus => {
    authEpoch += 1;
    // A grant belongs to the session that earned it. Signing out ends that
    // session, so anything still holding one is holding a stale claim about a
    // user who is no longer here.
    pairingGrant = null;
    persistSession(null, "user_signed_out", "sign_out");
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
    getSessionReadFailureReason: () => sessionReadFailureReason,
    getSessionState: () => getStatus().sessionState ?? "signed_out",
    getAccessToken,
    createToken,
    cancelLogin,
    signOut,
    onSignedIn: (listener: () => void) => {
      signedInListeners.add(listener);
      return () => signedInListeners.delete(listener);
    },
    consumePairingGrant,
    dispose,
  };
}
