import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import {
  handleDeviceAuthorizationRequest,
  type DeviceAuthorizationRequestOptions,
} from "./deviceAuthorization";

export interface Env {
  DB: D1Database;
  CLERK_JWKS_URL: string;
  CLERK_ISSUER: string;
  CLERK_OAUTH_CLIENT_ID: string;
  WEB_CLIENT_ORIGIN?: string;
  ONLINE_WINDOW_MS?: string;
  /**
   * Push relay origin. The relay is a different worker over a different D1, so
   * machine membership changes have to be forwarded to it explicitly: it owns
   * the Activity feed and the roster of machines allowed to publish into it.
   */
  PUSH_RELAY_URL?: string;
  /** Optional service binding used in place of a public fetch to the relay. */
  ACTIVITY_RELAY?: { fetch: typeof fetch };
  /**
   * REQUIRED. Shared secret proving to the relay that a machine membership
   * change came from this worker and not from a machine holding an account
   * token. Set it as a wrangler secret on BOTH workers with the same value:
   * `wrangler secret put DIRECTORY_AUTH_SECRET`. Unset fails closed — machine
   * removal and re-pairing both report a relay failure rather than proceed.
   */
  DIRECTORY_AUTH_SECRET?: string;
}

/** Options a caller (or a test) can inject around the relay hand-off. */
export type ActivityRelayOptions = {
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
};

export type DirectoryRequestOptions = DeviceAuthorizationRequestOptions & {
  activityRelay?: ActivityRelayOptions;
};

type MachineRow = {
  user_id: string;
  machine_key: string;
  device_id: string | null;
  name: string | null;
  custom_name: string | null;
  platform: string | null;
  device_type: string | null;
  pubkey: string | null;
  reachable_endpoints: string | null;
  last_seen_at: number | null;
  created_at: number | null;
};

type ReachableEndpoint = {
  kind: "lan" | "tailnet" | "relay";
  url?: string;
  host?: string;
  port?: number;
};

type RegisterInput = {
  machineKey: string;
  deviceId: string;
  /**
   * A per-account hash of an OS-level machine identifier, when the client can
   * read one. Null on older clients, on hosts with no such identifier, and on
   * any registration made without an account id to salt with.
   *
   * It exists because `deviceId` does NOT survive a `~/.ade` wipe — it lives in
   * the same secrets directory as the machine key — so a reinstall produces two
   * fresh identifiers and dedup has nothing to match. This one is derived from
   * the hardware and the OS install, so it is the same after the wipe.
   *
   * Caller-supplied and therefore forgeable, exactly like `deviceId`: on a
   * plain token it authorizes nothing. See the supersede block in
   * `handleRegister` for the proof bar that makes acting on it safe.
   */
  hardwareId: string | null;
  name: string;
  platform: string;
  deviceType: string;
  pubkey: string | null;
  reachableEndpoints: ReachableEndpoint[];
  retainRelayEndpoints: boolean;
  /**
   * Set only for a deliberate, user-initiated link — never on the periodic
   * heartbeat. It separates "this machine is alive" from "the user is adding
   * this machine back".
   *
   * On its own it is an unauthenticated client boolean and clears nothing: it
   * only lifts a revocation when the caller's token ALSO proves an interactive
   * sign-in within `PAIRING_AUTH_FRESHNESS_MS`.
   */
  pairing: boolean;
  /**
   * Optional second proof for `pairing`, minted by this worker at the end of a
   * `/device/*` sign-in and bound to that user and machine key. Accepted in
   * place of claim freshness so re-pairing cannot be bricked by a token shape
   * that carries no authentication-time claim. Absent on every heartbeat.
   */
  pairingGrant: string | null;
};

type MachineRevocationRow = {
  machine_key: string;
  device_id: string | null;
  revoked_at: number;
};

type MachineRecord = {
  machineKey: string;
  deviceId: string | null;
  name: string | null;
  customName: string | null;
  platform: string | null;
  deviceType: string | null;
  pubkey: string | null;
  reachableEndpoints: ReachableEndpoint[];
  lastSeenAt: number | null;
  createdAt: number | null;
};

type AccountRoute =
  | { kind: "register" }
  | { kind: "list" }
  | { kind: "machine"; machineKey: string };

export const DEFAULT_ONLINE_WINDOW_MS = 90_000;
/**
 * How recent the caller's INTERACTIVE authentication must be for a
 * `pairing: true` registration to be allowed to clear a revocation.
 *
 * `pairing` arrives in the request body, so on its own it is an unauthenticated
 * client boolean: a removed-but-still-signed-in machine can simply set it on
 * its next 30 s heartbeat and the directory would then call the relay's
 * `/pairing` route with its own `DIRECTORY_AUTH_SECRET` — a confused deputy
 * clearing both halves of the removal. Un-revoking therefore has to be bound to
 * a credential a removed machine cannot mint.
 *
 * Authentication TIME is that credential. A background heartbeat carries an old
 * authentication even after its access token is refreshed (a refresh renews
 * `exp`/`iat`, never the moment the human authenticated), while a user who
 * genuinely signs in again carries a new one. Ten minutes is long enough to
 * cover a sign-in followed by the auto-repair and any retry, and short enough
 * that a token sitting on a removed machine never qualifies.
 *
 * This check FAILS CLOSED — a token with no such claim proves nothing — which
 * is why it is not the only way back. See `PAIRING_GRANT_TTL_MS`: a grant this
 * worker mints at the end of a `/device/*` sign-in proves the same fact for
 * token shapes that carry neither claim, so a removal stays durable without
 * becoming permanent.
 */
export const PAIRING_AUTH_FRESHNESS_MS = 10 * 60_000;
/**
 * How long a minted pairing grant stays spendable.
 *
 * Deliberately the same order as `PAIRING_AUTH_FRESHNESS_MS`: both answer "did
 * a human just authenticate?", so a grant must not outlive the claim it stands
 * in for. It covers the sign-in, the automatic re-pair that follows it, and one
 * retry — nothing longer.
 */
export const PAIRING_GRANT_TTL_MS = 10 * 60_000;
/**
 * How long one registration may hold a pairing grant reserved before another is
 * allowed to take it.
 *
 * This is a CRASH-SAFETY bound, not a lease anyone waits on. A reservation is
 * held only across a single activity-relay hand-off — two attempts with a short
 * backoff — so a minute is generous for the happy path. What it actually bounds
 * is the bad path: a worker that dies between reserving a grant and either
 * consuming or releasing it would otherwise strand the row as permanently
 * unspendable until it expired, which is the same lockout the two-phase scheme
 * exists to remove. After this long the reservation simply does not count.
 */
export const PAIRING_GRANT_RESERVATION_MS = 60_000;
/**
 * Most rows one register call may supersede.
 *
 * A device with more phantom keys than this is either pathological or hostile,
 * and either way there is no reason to let a single request delete an unbounded
 * slice of the account's roster. The rest are cleaned up by the next proven
 * re-pair, oldest first.
 */
export const MAX_SUPERSEDED_MACHINES = 5;
const MAX_PUBKEY_CHARS = 128;
const MAX_MACHINE_KEY_CHARS = 128;
/**
 * A hardware anchor is a sha256 hex digest (64 chars); the cap is slack, not a
 * shape check. Validating the shape would buy nothing — the value is
 * caller-supplied either way, and what makes it safe to act on is the pairing
 * proof, not its formatting.
 */
const MAX_HARDWARE_ID_CHARS = 128;
/** A grant is 32 random bytes in base64url (43 chars); the cap is slack, not a shape check. */
const MAX_PAIRING_GRANT_CHARS = 256;
const MAX_CUSTOM_NAME_CHARS = 80;
const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CallerTokenFailureReason =
  | "authentication unavailable"
  | "invalid audience"
  | "invalid issuer"
  | "invalid token"
  | "missing bearer token"
  | "missing token subject"
  | "token expired";

class CallerTokenValidationError extends Error {
  constructor(readonly reason: CallerTokenFailureReason) {
    super(reason);
    this.name = "CallerTokenValidationError";
  }
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function withServerTiming(
  response: Response,
  authDurationMs: number,
  dbDurationMs: number,
): Response {
  const duration = (value: number) => Math.max(0, value).toFixed(2);
  const headers = new Headers(response.headers);
  headers.set(
    "server-timing",
    `auth;dur=${duration(authDurationMs)}, db;dur=${duration(dbDurationMs)}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalString(source: Record<string, unknown>, key: string): string | null | undefined {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseReachableEndpoints(value: unknown): ReachableEndpoint[] | null {
  if (!Array.isArray(value)) return null;
  const endpoints: ReachableEndpoint[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const kind = candidate.kind;
    if (kind !== "lan" && kind !== "tailnet" && kind !== "relay") return null;

    const url = candidate.url === undefined ? undefined : requiredString(candidate, "url") ?? null;
    const host = candidate.host === undefined ? undefined : requiredString(candidate, "host") ?? null;
    if (url === null || host === null || (!url && !host)) return null;

    const rawPort = candidate.port;
    const port = rawPort === undefined
      ? undefined
      : typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535
        ? rawPort
        : null;
    if (port === null) return null;

    endpoints.push({
      kind,
      ...(url ? { url } : {}),
      ...(host ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
    });
  }
  return endpoints;
}

function parseRegisterInput(value: unknown): RegisterInput | null {
  if (!isRecord(value)) return null;
  const machineKey = requiredString(value, "machineKey");
  const deviceId = requiredString(value, "deviceId");
  const hardwareId = optionalString(value, "hardwareId");
  const name = requiredString(value, "name");
  const platform = requiredString(value, "platform");
  const deviceType = requiredString(value, "deviceType");
  const pubkey = optionalString(value, "pubkey");
  const reachableEndpoints = parseReachableEndpoints(value.reachableEndpoints);
  const retainRelayEndpoints = value.retainRelayEndpoints ?? false;
  const pairing = value.pairing ?? false;
  const pairingGrant = optionalString(value, "pairingGrant");
  if (
    !machineKey
    || machineKey.length > MAX_MACHINE_KEY_CHARS
    || !deviceId
    || hardwareId === undefined
    || (hardwareId !== null && hardwareId.length > MAX_HARDWARE_ID_CHARS)
    || !name
    || !platform
    || !deviceType
    || pubkey === undefined
    || (pubkey !== null && pubkey.length > MAX_PUBKEY_CHARS)
    || !reachableEndpoints
    || typeof retainRelayEndpoints !== "boolean"
    || typeof pairing !== "boolean"
    || pairingGrant === undefined
    || (pairingGrant !== null && pairingGrant.length > MAX_PAIRING_GRANT_CHARS)
  ) {
    return null;
  }
  return {
    machineKey,
    deviceId,
    hardwareId,
    name,
    platform,
    deviceType,
    pubkey,
    reachableEndpoints,
    retainRelayEndpoints,
    pairing,
    pairingGrant,
  };
}

function getRemoteJwks(rawUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const url = new URL(rawUrl);
  const cacheKey = url.toString();
  const cached = remoteJwksByUrl.get(cacheKey);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(url);
  remoteJwksByUrl.set(cacheKey, jwks);
  return jwks;
}

function audienceIncludes(audience: JWTPayload["aud"], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : Array.isArray(audience) && audience.includes(expected);
}

function isAllowedCallerToken(payload: JWTPayload, oauthClientId: string): boolean {
  // Clerk's native session tokens have no audience. Their `azp` may be absent,
  // empty, or origin-based, so `azp` alone must not reject that token shape.
  if (payload.aud === undefined) return true;

  // OAuth access tokens are audience/authorized-party bound to the ADE client.
  // Future fixed audiences (for example `ade-relay`) can be added to this list.
  const allowedAudiences = [oauthClientId];
  return allowedAudiences.some((allowed) =>
    audienceIncludes(payload.aud, allowed) || payload.azp === allowed
  );
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

/**
 * Milliseconds since the caller last passed an interactive authentication, or
 * `null` when the verified token carries no authentication-time claim at all.
 *
 * Two shapes are understood, because ADE accepts both Clerk token shapes:
 *
 * - `auth_time` — the standard OIDC claim, seconds since the epoch.
 * - `fva` — Clerk's equivalent ("factor verification age"), a two-element array
 *   of MINUTES since the first- and second-factor verifications. `-1` means the
 *   factor was never verified. Clerk caps the counter at 99, which is far above
 *   the freshness bound, so the cap never turns a stale token into a fresh one.
 *
 * Never derived from `iat`: a background token refresh mints a new `iat` while
 * the human authentication behind it stays exactly as old as it was.
 */
function interactiveAuthenticationAgeMs(payload: JWTPayload, nowMs: number): number | null {
  const authTime = (payload as { auth_time?: unknown }).auth_time;
  if (typeof authTime === "number" && Number.isFinite(authTime) && authTime > 0) {
    return Math.max(0, nowMs - authTime * 1_000);
  }
  const factorVerificationAge = (payload as { fva?: unknown }).fva;
  if (Array.isArray(factorVerificationAge)) {
    const firstFactorMinutes = factorVerificationAge[0];
    if (
      typeof firstFactorMinutes === "number"
      && Number.isFinite(firstFactorMinutes)
      && firstFactorMinutes >= 0
    ) {
      return firstFactorMinutes * 60_000;
    }
  }
  return null;
}

/**
 * Did this token prove an interactive authentication inside the freshness
 * bound? Fails closed: a token with no authentication-time claim is treated as
 * unproven, because the alternative is accepting the client's word for it.
 */
function hasFreshInteractiveAuthentication(payload: JWTPayload, nowMs: number): boolean {
  const ageMs = interactiveAuthenticationAgeMs(payload, nowMs);
  return ageMs !== null && ageMs <= PAIRING_AUTH_FRESHNESS_MS;
}

async function verifyCallerTokenPayload(token: string, env: Env): Promise<JWTPayload> {
  const jwksUrl = typeof env.CLERK_JWKS_URL === "string" ? env.CLERK_JWKS_URL.trim() : "";
  const issuer = typeof env.CLERK_ISSUER === "string" ? env.CLERK_ISSUER.trim() : "";
  const oauthClientId = typeof env.CLERK_OAUTH_CLIENT_ID === "string"
    ? env.CLERK_OAUTH_CLIENT_ID.trim()
    : "";
  if (!jwksUrl || !issuer || !oauthClientId) {
    throw new CallerTokenValidationError("authentication unavailable");
  }

  const { payload } = await jwtVerify(token, getRemoteJwks(jwksUrl), {
    issuer,
    algorithms: ["RS256"],
    clockTolerance: 5,
  });
  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new CallerTokenValidationError("missing token subject");
  }
  if (!isAllowedCallerToken(payload, oauthClientId)) {
    throw new CallerTokenValidationError("invalid audience");
  }
  return payload;
}

export async function verifyCallerToken(token: string, env: Env): Promise<string> {
  const payload = await verifyCallerTokenPayload(token, env);
  return payload.sub as string;
}

function callerTokenFailureReason(error: unknown): CallerTokenFailureReason {
  if (error instanceof CallerTokenValidationError) return error.reason;
  if (error instanceof errors.JWTExpired) return "token expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "exp") return "token expired";
    if (error.claim === "iss") return "invalid issuer";
    if (error.claim === "aud") return "invalid audience";
  }
  return "invalid token";
}

type CallerAuthenticationResult =
  | {
    ok: true;
    userId: string;
    /** Proven-recent interactive sign-in; the only thing `pairing` is honored on. */
    freshInteractiveAuthentication: boolean;
  }
  | { ok: false; reason: CallerTokenFailureReason };

async function authenticate(
  request: Request,
  env: Env,
): Promise<CallerAuthenticationResult> {
  const token = readBearerToken(request);
  if (!token) return { ok: false, reason: "missing bearer token" };
  try {
    const payload = await verifyCallerTokenPayload(token, env);
    return {
      ok: true,
      userId: payload.sub as string,
      freshInteractiveAuthentication: hasFreshInteractiveAuthentication(payload, Date.now()),
    };
  } catch (error) {
    // Return only a fixed classification, never JOSE details or token claims.
    return { ok: false, reason: callerTokenFailureReason(error) };
  }
}

function routeAccount(pathname: string): AccountRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "account" || parts[1] !== "machines") return null;
  if (parts.length === 2) return { kind: "list" };
  if (parts.length === 3 && parts[2] === "register") return { kind: "register" };
  if (parts.length !== 3) return null;
  try {
    const machineKey = decodeURIComponent(parts[2] ?? "").trim();
    return machineKey ? { kind: "machine", machineKey } : null;
  } catch {
    return null;
  }
}

function parseStoredEndpoints(value: string | null): ReachableEndpoint[] {
  if (!value) return [];
  try {
    return parseReachableEndpoints(JSON.parse(value)) ?? [];
  } catch {
    return [];
  }
}

function machineRecord(row: MachineRow): MachineRecord {
  return {
    machineKey: row.machine_key,
    deviceId: row.device_id,
    name: row.name,
    customName: row.custom_name,
    platform: row.platform,
    deviceType: row.device_type,
    pubkey: row.pubkey,
    reachableEndpoints: parseStoredEndpoints(row.reachable_endpoints),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function onlineWindowMs(env: Env): number {
  const configured = Number(env.ONLINE_WINDOW_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_ONLINE_WINDOW_MS;
}

function trustedActivityRelayBaseUrl(env: Env): string | null {
  const raw = env.PUSH_RELAY_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

type ActivityRelayOutcome =
  | { ok: true }
  | { ok: false; reason: string };

function logActivityRelayFailure(args: {
  correlationId: string;
  operation: "purge" | "restore";
  machineKey: string;
  reason: string;
  attempts: number;
}): void {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "ade-account-directory",
    kind: "activity_relay_failed",
    correlationId: args.correlationId,
    operation: args.operation,
    // The machine key is a capability-shaped secret; log only a tail marker.
    machine: args.machineKey.slice(-6),
    attempts: args.attempts,
    reason: args.reason.slice(0, 300),
  }));
}

/**
 * One line per refused machine-membership change.
 *
 * Every refusal on this worker is a user who cannot get their computer back
 * onto their account, and the request that produced it is long gone by the time
 * they ask for help. Support has no other window into that: the client reports
 * only the code, and the D1 tables record what the state IS, never why a call
 * was turned away. So each refusal path emits exactly one line, and the fields
 * are chosen to be joinable — `correlationId` ties it to the request the client
 * logged, `userId` to the account, the prefixes to the specific install.
 *
 * PREFIXES ONLY. A machine key is a capability-shaped secret and a pairing
 * grant is a live credential; eight characters identify a row for a human
 * reading logs and are useless to anyone who reads them. Nothing here ever
 * carries a full key, a token, or a grant in any form.
 */
function logDirectoryRefusal(args: {
  event: "directory.register_refused" | "directory.remove_refused" | "directory.supersede_refused";
  userId: string;
  machineKey: string;
  deviceId: string | null;
  code: string;
  correlationId: string;
  /** Optional finer classification for support; the wire `code` stays the contract. */
  reason?: string;
}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "ade-account-directory",
    event: args.event,
    userId: args.userId,
    machineKeyPrefix: args.machineKey.slice(0, 8),
    deviceIdPrefix: args.deviceId ? args.deviceId.slice(0, 8) : null,
    code: args.code,
    correlationId: args.correlationId,
    ...(args.reason ? { reason: args.reason.slice(0, 300) } : {}),
  }));
}

/**
 * Forward a machine membership change to the push relay.
 *
 * Two credentials travel together, and they answer different questions:
 *
 * - The caller's already-verified bearer token says WHICH ACCOUNT this is for.
 *   The relay re-verifies it and derives its own account id from it, so this
 *   worker can never act on an account it was not called for.
 * - `x-ade-directory-auth` says THIS CAME FROM THE DIRECTORY. A removed machine
 *   keeps a valid account token by design (that is the whole premise of the
 *   revocation tables), so the token alone cannot authorize un-revoking a
 *   machine — otherwise the removed machine clears its own revocation and
 *   resumes publishing. Only the directory knows this secret.
 *
 * The secret is required for both operations rather than only the re-pair, so a
 * half-configured deployment fails loudly on the first machine removal instead
 * of silently leaving the security-critical route unauthenticated. It is sent
 * over whichever transport is configured — the `ACTIVITY_RELAY` service binding
 * or a public HTTPS fetch — because a service binding carries no attestable
 * provenance marker the relay could check on its own.
 *
 * A failure here is never swallowed: it is logged, retried once, and returned
 * so the caller can report it.
 */
async function callActivityRelay(
  request: Request,
  env: Env,
  args: {
    operation: "purge" | "restore";
    machineKey: string;
    correlationId: string;
    options: ActivityRelayOptions;
  },
): Promise<ActivityRelayOutcome> {
  const baseUrl = trustedActivityRelayBaseUrl(env);
  if (!baseUrl) return { ok: false, reason: "activity relay is not configured" };
  const directoryAuth = env.DIRECTORY_AUTH_SECRET?.trim();
  if (!directoryAuth) {
    return { ok: false, reason: "directory relay authentication is not configured" };
  }
  const authorization = request.headers.get("authorization");
  if (!authorization) return { ok: false, reason: "missing caller authorization" };
  const path = `/attention/account/machines/${encodeURIComponent(args.machineKey)}`;
  const url = args.operation === "purge" ? `${baseUrl}${path}` : `${baseUrl}${path}/pairing`;
  const fetchImpl = args.options.fetchImpl
    ?? (env.ACTIVITY_RELAY ? env.ACTIVITY_RELAY.fetch.bind(env.ACTIVITY_RELAY) : fetch);
  const retryDelayMs = Math.max(0, args.options.retryDelayMs ?? 250);
  let reason = "activity relay is unreachable";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1 && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    try {
      const response = await fetchImpl(url, {
        method: args.operation === "purge" ? "DELETE" : "POST",
        headers: {
          accept: "application/json",
          authorization,
          "x-ade-directory-auth": directoryAuth,
          "x-ade-correlation-id": args.correlationId,
        },
        redirect: "error",
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { ok: true };
      reason = `activity relay returned ${response.status}`;
      // A rejected token or a refused request will not heal on a retry.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  logActivityRelayFailure({
    correlationId: args.correlationId,
    operation: args.operation,
    machineKey: args.machineKey,
    reason,
    attempts: 2,
  });
  return { ok: false, reason };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Mint the pairing grant for a just-completed `/device/*` sign-in.
 *
 * `accessToken` is the token this worker itself fetched from Clerk moments ago,
 * but it is re-verified rather than decoded: the user id the grant is bound to
 * decides whose revocation it can lift, and that must come from a signature
 * check, not from a base64 payload. Verification failure yields `null` — the
 * sign-in still succeeds, only the second proof path is unavailable.
 *
 * Only the hash is stored. The plaintext exists in one response body and in the
 * signing-in machine's memory; a dump of this D1 yields nothing spendable.
 */
async function mintPairingGrant(
  env: Env,
  args: { accessToken: string; machineKey: string; nowMs: number },
): Promise<string | null> {
  let userId: string;
  try {
    userId = await verifyCallerToken(args.accessToken, env);
  } catch {
    return null;
  }
  const grant = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(`
    insert into machine_pairing_grants (grant_hash, user_id, machine_key, created_at, expires_at)
    values (?, ?, ?, ?, ?)
    on conflict(grant_hash) do nothing
  `).bind(
    await sha256Base64Url(grant),
    userId,
    args.machineKey,
    args.nowMs,
    args.nowMs + PAIRING_GRANT_TTL_MS,
  ).run();
  return grant;
}

/**
 * Reserve a pairing grant: phase one of spending it.
 *
 * One statement still carries every rule the grant exists to enforce — it must
 * belong to this caller, name this machine, still be inside its TTL, and not
 * already be held by another in-flight registration — because splitting them
 * into a read and a later write would let two concurrent registrations both
 * observe a spendable row. `changes === 1` is therefore the whole proof.
 *
 * What the reservation buys over the plain delete this replaced is a spend that
 * can be undone. The relay hand-off that follows can fail, and destroying the
 * grant before knowing the outcome made a relay outage cost the user their only
 * way back onto the account. A reserved grant can be put back byte for byte
 * (`releaseReservedPairingGrant`) — no fresh expiry, no read-then-write.
 */
async function reservePairingGrant(
  env: Env,
  args: { userId: string; machineKey: string; grant: string; nowMs: number },
): Promise<boolean> {
  const result = await env.DB.prepare(`
    update machine_pairing_grants
       set reserved_at = ?
     where grant_hash = ? and user_id = ? and machine_key = ? and expires_at > ?
       and (reserved_at is null or reserved_at <= ?)
  `).bind(
    args.nowMs,
    await sha256Base64Url(args.grant),
    args.userId,
    args.machineKey,
    args.nowMs,
    args.nowMs - PAIRING_GRANT_RESERVATION_MS,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Phase two, success: the grant is spent for good.
 *
 * `reserved_at` is part of the predicate so this only ever deletes the
 * reservation THIS request took. A stale reservation another registration has
 * since claimed is not ours to consume.
 */
async function consumeReservedPairingGrant(
  env: Env,
  args: { userId: string; machineKey: string; grant: string; reservedAt: number },
): Promise<void> {
  await env.DB.prepare(`
    delete from machine_pairing_grants
     where grant_hash = ? and user_id = ? and machine_key = ? and reserved_at = ?
  `).bind(
    await sha256Base64Url(args.grant),
    args.userId,
    args.machineKey,
    args.reservedAt,
  ).run();
}

/**
 * Phase two, failure: put the grant back exactly as it was.
 *
 * Only `reserved_at` is cleared. `expires_at` is untouched on purpose — an
 * attacker who can force relay failures must not be able to keep a grant alive
 * past the TTL it was minted with, so a release restores spendability without
 * extending the window. Same `reserved_at` predicate as the consume, for the
 * same reason.
 */
async function releaseReservedPairingGrant(
  env: Env,
  args: { userId: string; machineKey: string; grant: string; reservedAt: number },
): Promise<void> {
  await env.DB.prepare(`
    update machine_pairing_grants
       set reserved_at = null
     where grant_hash = ? and user_id = ? and machine_key = ? and reserved_at = ?
  `).bind(
    await sha256Base64Url(args.grant),
    args.userId,
    args.machineKey,
    args.reservedAt,
  ).run();
}

/**
 * How a register call proved that a human just authenticated ON THIS MACHINE.
 *
 * Two privileged operations sit behind this one bar — lifting a revocation, and
 * superseding the rows a rotated machine key left behind — and they must sit
 * behind the SAME bar. Everything else in a register request (`deviceId`,
 * `pairing`, the machine key itself) is caller-supplied and therefore forgeable
 * by exactly the removed machine these gates exist to stop.
 */
type PairingProof =
  /** An `auth_time`/`fva` claim on the caller's own verified token. Costs nothing. */
  | { kind: "claim" }
  /** A grant, reserved and still restorable. Must be consumed or released before the response. */
  | { kind: "grant"; grant: string; reservedAt: number }
  /** A grant already consumed earlier in this request: still proof, no longer spendable. */
  | { kind: "spent_grant" }
  /** Nothing was proven. */
  | { kind: "none" };

/**
 * Establish the proof, spending a grant only if the claim path cannot answer.
 *
 * The claim is checked first so a genuinely fresh sign-in never burns a grant
 * it does not need, and it is honored on any register call because it is a
 * property of the token this worker already verified — no client assertion is
 * involved. The grant is the fallback, and it is honored ONLY on a deliberate
 * `pairing: true` link: it is a single-use credential, and a background
 * heartbeat that happens to still be carrying one must leave it untouched.
 */
async function acquirePairingProof(
  env: Env,
  args: {
    userId: string;
    input: RegisterInput;
    freshInteractiveAuthentication: boolean;
    nowMs: number;
  },
): Promise<PairingProof> {
  if (args.freshInteractiveAuthentication) return { kind: "claim" };
  if (!args.input.pairing || !args.input.pairingGrant) return { kind: "none" };
  const reserved = await reservePairingGrant(env, {
    userId: args.userId,
    machineKey: args.input.machineKey,
    grant: args.input.pairingGrant,
    nowMs: args.nowMs,
  });
  return reserved
    ? { kind: "grant", grant: args.input.pairingGrant, reservedAt: args.nowMs }
    : { kind: "none" };
}

/**
 * Other machine keys this account already has for the SAME physical device.
 *
 * This is the phantom-duplicate query. A reinstall (or any client-side identity
 * rotation) mints a fresh machine key, and rows are keyed `(user_id,
 * machine_key)`, so the old row survives forever as a machine the user never
 * owned twice. Ordered oldest-seen first so that when the cap bites, it is the
 * stalest rows that go.
 *
 * TWO identifiers can name the same device, and the union is the point. The
 * device id catches an in-place reinstall, where `~/.ade/secrets` survived. The
 * hardware anchor catches the case that motivated it — a full `~/.ade` wipe,
 * where the device id was minted fresh alongside the machine key and matches
 * nothing. Either one alone leaves a phantom row behind in the other's case.
 *
 * Null-anchor rows can only ever be matched by device id. That is expected: a
 * row written before this shipped, or by a host that cannot read an identifier,
 * is folded in the first time the same physical machine re-registers with fresh
 * auth AND a surviving device id, and otherwise ages out by hand from the
 * machine list. Nothing here back-fills an anchor onto a row it did not send.
 *
 * One statement rather than two, so `order by`/`limit` apply to the UNION: two
 * capped queries merged in the worker could return six rows, or drop the oldest
 * of one set in favour of a newer row from the other.
 */
async function machineKeysForDevice(
  env: Env,
  args: { userId: string; deviceId: string | null; hardwareId: string | null; machineKey: string },
): Promise<string[]> {
  const rows = (await env.DB.prepare(`
    select machine_key
      from machines
     where user_id = ?
       and machine_key <> ?
       and (device_id = ? or hardware_id = ?)
     order by last_seen_at asc
     limit ?
  `).bind(
    args.userId,
    args.machineKey,
    args.deviceId,
    args.hardwareId,
    MAX_SUPERSEDED_MACHINES,
  ).all<{ machine_key: string }>()).results ?? [];
  return rows.map((row) => row.machine_key);
}

/**
 * Cron sweep: an unspent grant is dead weight the moment it expires.
 *
 * Reservations are ignored on purpose. A grant that expires while a
 * registration holds it reserved was already unspendable by the time the sweep
 * ran — every phase checks `expires_at` — so removing it costs nothing, and the
 * release that follows simply matches no row.
 */
export async function cleanupExpiredPairingGrants(
  env: Pick<Env, "DB">,
  nowMs = Date.now(),
): Promise<number> {
  const result = await env.DB
    .prepare("delete from machine_pairing_grants where expires_at <= ?")
    .bind(nowMs)
    .run();
  return result.meta.changes ?? 0;
}

async function machineRevocation(
  env: Env,
  userId: string,
  machineKey: string,
): Promise<MachineRevocationRow | null> {
  return await env.DB.prepare(`
    select machine_key, device_id, revoked_at
      from revoked_machines
     where user_id = ? and machine_key = ?
  `).bind(userId, machineKey).first<MachineRevocationRow>();
}

async function handleRegister(
  request: Request,
  env: Env,
  userId: string,
  correlationId: string,
  relayOptions: ActivityRelayOptions,
  freshInteractiveAuthentication: boolean,
): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid request body" }, { status: 400 });
  }
  const input = parseRegisterInput(raw);
  if (!input) return json({ error: "invalid request body" }, { status: 400 });

  const nowMs = Date.now();
  const refused = (
    event: "directory.register_refused" | "directory.supersede_refused",
    code: string,
    reason?: string,
  ): void => logDirectoryRefusal({
    event,
    userId,
    machineKey: input.machineKey,
    deviceId: input.deviceId,
    code,
    correlationId,
    reason,
  });

  // Established at most once, and only when something actually needs it: a
  // plain heartbeat — the overwhelming majority of calls — must not touch the
  // grants table at all, and a request that clears a revocation and then
  // supersedes duplicates in the same breath must not pay for the proof twice.
  let pairingProof: PairingProof | null = null;
  const provePairing = async (): Promise<PairingProof> => {
    pairingProof ??= await acquirePairingProof(env, {
      userId,
      input,
      freshInteractiveAuthentication,
      nowMs,
    });
    return pairingProof;
  };

  // Removal is only durable if the removed machine cannot re-register itself.
  // Its heartbeat carries a valid account token for as long as it stays signed
  // in, so the revocation — not the token — is what decides.
  const revocation = await machineRevocation(env, userId, input.machineKey);
  if (revocation) {
    // `pairing` is honored ONLY together with proof of a freshly completed
    // interactive sign-in (either proof below). Everything else in this request
    // — including `deviceId`, which used to carry a "reinstalled machine"
    // recovery clause — is supplied by the caller, so it can be forged by
    // exactly the removed machine this gate exists to stop. A genuine reinstall
    // recovers the same way every other re-pair does: the user signs in and ADE
    // re-pairs immediately after.
    if (!input.pairing) {
      refused("directory.register_refused", "machine_revoked");
      return json({
        error: "machine removed from account",
        code: "machine_revoked",
        revokedAt: revocation.revoked_at,
      }, { status: 403 });
    }
    // Two independent proofs, either of which is sufficient, neither of which a
    // removed machine can produce from the token it is still holding.
    //
    // The claim is the fast path and is checked first so a genuinely fresh
    // sign-in never spends a grant it does not need. The grant is the fallback,
    // and it exists because the claim path fails CLOSED: ADE's brain
    // authenticates with a Clerk OAuth access token, and `auth_time`/`fva` are
    // not in the documented default claim set for that token shape. If they are
    // absent in production, claim-only freshness would make every removal
    // permanent — the original Blocker wearing a different hat.
    const proof = await provePairing();
    if (proof.kind === "none") {
      refused(
        "directory.register_refused",
        "pairing_authentication_required",
        // Support's first question is always which of the two it was: a machine
        // that never presented a grant is a client-side problem, a rejected one
        // is expired, replayed, or minted for another machine.
        input.pairingGrant ? "grant_rejected" : "no_proof",
      );
      return json({
        error: "Sign in again on this computer to reconnect it to your ADE account",
        code: "pairing_authentication_required",
        revokedAt: revocation.revoked_at,
      }, { status: 403 });
    }
    // A grant is RESERVED above, not destroyed, and the reservation is what
    // makes the next three lines recoverable. Reserving is one atomic statement,
    // so single-use is enforced exactly as strictly as the old delete enforced
    // it — two concurrent registrations still cannot both hold it — but a relay
    // outage no longer burns the user's only credential. On failure it goes back
    // with its ORIGINAL expiry, so forcing relay failures buys nothing: the
    // grant still dies at the moment it was always going to die.
    //
    // Clear the relay's revocation first: a machine back on the roster but
    // unable to publish is a worse state than one that retries the re-pair.
    const restored = await callActivityRelay(request, env, {
      operation: "restore",
      machineKey: input.machineKey,
      correlationId,
      options: relayOptions,
    });
    if (!restored.ok) {
      if (proof.kind === "grant") {
        await releaseReservedPairingGrant(env, {
          userId,
          machineKey: input.machineKey,
          grant: proof.grant,
          reservedAt: proof.reservedAt,
        });
        // Nothing is proven any more: the credential is back in circulation.
        pairingProof = { kind: "none" };
      }
      refused("directory.register_refused", "activity_relay_unavailable", restored.reason);
      return json({
        error: "activity relay unavailable",
        code: "activity_relay_unavailable",
        detail: restored.reason,
      }, { status: 503 });
    }
    if (proof.kind === "grant") {
      await consumeReservedPairingGrant(env, {
        userId,
        machineKey: input.machineKey,
        grant: proof.grant,
        reservedAt: proof.reservedAt,
      });
      // Still proof for anything later in this request, never spendable again.
      pairingProof = { kind: "spent_grant" };
    }
    await env.DB
      .prepare("delete from revoked_machines where user_id = ? and machine_key = ?")
      .bind(userId, input.machineKey)
      .run();
  }

  await env.DB.prepare(`
    insert into machines (
      user_id, machine_key, device_id, name, platform, device_type, pubkey,
      reachable_endpoints, last_seen_at, created_at, hardware_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(user_id, machine_key) do update set
      device_id = excluded.device_id,
      -- coalesce, and not excluded.hardware_id: an anchor is optional on every
      -- request, so a single heartbeat from a host that momentarily could not
      -- read one -- a sandbox, a slow probe, a downgrade -- must not erase the
      -- anchor this row already learned. A new non-null value still wins.
      hardware_id = coalesce(excluded.hardware_id, machines.hardware_id),
      name = excluded.name,
      platform = excluded.platform,
      device_type = excluded.device_type,
      pubkey = excluded.pubkey,
      reachable_endpoints = case
        when ? = 1
          and json_valid(machines.reachable_endpoints)
          and exists (
            select 1
              from json_each(machines.reachable_endpoints)
             where json_extract(value, '$.kind') = 'relay'
          )
          and not exists (
            select 1
              from json_each(excluded.reachable_endpoints)
             where json_extract(value, '$.kind') = 'relay'
          )
        then (
          select json_group_array(json(endpoint))
            from (
              select value as endpoint
                from json_each(excluded.reachable_endpoints)
              union all
              select value as endpoint
                from json_each(machines.reachable_endpoints)
               where json_extract(value, '$.kind') = 'relay'
            )
        )
        else excluded.reachable_endpoints
      end,
      last_seen_at = excluded.last_seen_at
  `).bind(
    userId,
    input.machineKey,
    input.deviceId,
    input.name,
    input.platform,
    input.deviceType,
    input.pubkey,
    JSON.stringify(input.reachableEndpoints),
    nowMs,
    nowMs,
    input.hardwareId,
    input.retainRelayEndpoints ? 1 : 0,
  ).run();

  // Phantom duplicates: the OTHER half of the reinstall story.
  //
  // Machines are keyed `(user_id, machine_key)`, so a client that rotates its
  // identity file — a reinstall, a wiped config, a restored backup — lands as a
  // second row for the same physical computer. The user sees a duplicate,
  // removes the one that looks stale, and if they guess wrong they have just
  // revoked the live install. Nothing about that is recoverable by the user, so
  // the directory folds the old rows into the new one instead of letting them
  // accumulate.
  //
  // The gate is the SAME proof that lifts a revocation, for the same reason:
  // `deviceId` is caller-supplied and forgeable, so on a plain token it
  // authorizes nothing — otherwise any machine could claim another's device id
  // and delete that machine's row. With a proven-fresh human behind the call it
  // is exactly the signal we want. `hardwareId` is caller-supplied in exactly
  // the same way and gets exactly the same treatment: it is a better identifier
  // (it survives the `~/.ade` wipe that invalidates the device id), not a more
  // trustworthy one, and nothing about it is attested. The fresh-auth bar is
  // the whole of what makes acting on either of them safe.
  //
  // Superseded keys get NO revocation row. The physical device holds the new
  // key; blocking the old one would trapdoor any client that rolls its identity
  // file back (a restored snapshot, a failed migration) into a permanent
  // refusal. An absent key simply registers again. For the same reason the
  // relay is not called: the device did not leave the account, so its Activity
  // is still the user's own.
  let supersededMachineKeys: string[] = [];
  // Empty identifiers are normalized to null before they reach the query, and
  // that is load-bearing: `device_id = ''` would match every row a future
  // relaxation of the parser let through with an unset device id, while
  // `device_id = null` matches nothing at all. `hardwareId` is already null
  // whenever the client sent none.
  const matchDeviceId = input.deviceId || null;
  const matchHardwareId = input.hardwareId || null;
  if (matchDeviceId || matchHardwareId) {
    const duplicates = await machineKeysForDevice(env, {
      userId,
      deviceId: matchDeviceId,
      hardwareId: matchHardwareId,
      machineKey: input.machineKey,
    });
    if (duplicates.length > 0) {
      const proof = await provePairing();
      if (proof.kind === "none") {
        // Not a refused REGISTRATION — the machine is registered, the duplicate
        // simply stays. Logged because "why is my Mac listed twice" is the
        // support question this whole path exists to answer.
        refused(
          "directory.supersede_refused",
          "supersede_authentication_required",
          `duplicates=${duplicates.length}`,
        );
      } else {
        // Spend before deleting, not after: a consume that failed once the rows
        // were already gone would leave the grant reservable again in a minute,
        // and a credential that can be spent twice is the worse of the two
        // failures. Both are D1 writes on one database, so the window is a
        // hypothetical either way.
        if (proof.kind === "grant") {
          await consumeReservedPairingGrant(env, {
            userId,
            machineKey: input.machineKey,
            grant: proof.grant,
            reservedAt: proof.reservedAt,
          });
          pairingProof = { kind: "spent_grant" };
        }
        for (const machineKey of duplicates) {
          // The identifiers stay in the predicate, and it mirrors the select
          // exactly: the row was chosen a moment ago because it matched one of
          // them, and that match is the only thing that authorized deleting it.
          // A delete narrower than the select (device id alone) would silently
          // leave every anchor-matched row in place.
          await env.DB
            .prepare(`
              delete from machines
               where user_id = ? and machine_key = ? and (device_id = ? or hardware_id = ?)
            `)
            .bind(userId, machineKey, matchDeviceId, matchHardwareId)
            .run();
        }
        supersededMachineKeys = duplicates;
      }
    }
  }

  const row = await env.DB.prepare(`
    select user_id, machine_key, device_id, name, custom_name, platform, device_type, pubkey,
           reachable_endpoints, last_seen_at, created_at
      from machines
     where user_id = ? and machine_key = ?
  `).bind(userId, input.machineKey).first<MachineRow>();
  if (!row) return json({ error: "machine was not stored" }, { status: 500 });
  // `supersededMachineKeys` is additive and omitted when empty, so a heartbeat
  // response is byte-identical to what every deployed client already parses.
  return json({
    ...machineRecord(row),
    ...(supersededMachineKeys.length > 0 ? { supersededMachineKeys } : {}),
  });
}

async function handleList(
  request: Request,
  env: Env,
  userId: string,
  authDurationMs: number,
): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const dbStartedAt = performance.now();
  const rows = (await env.DB.prepare(`
    select user_id, machine_key, device_id, name, custom_name, platform, device_type, pubkey,
           reachable_endpoints, last_seen_at, created_at
      from machines
     where user_id = ?
     -- 500 is the machine-directory cap, matching the client's effective cap.
     order by last_seen_at desc
     limit 500
  `).bind(userId).all<MachineRow>()).results ?? [];
  const dbDurationMs = performance.now() - dbStartedAt;
  const now = Date.now();
  const windowMs = onlineWindowMs(env);
  const machines = rows.map((row) => ({
    ...machineRecord(row),
    online: typeof row.last_seen_at === "number" && now - row.last_seen_at <= windowMs,
  })).sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    return Number(right.lastSeenAt ?? 0) - Number(left.lastSeenAt ?? 0);
  });
  return withServerTiming(json({ machines }), authDurationMs, dbDurationMs);
}

/**
 * Removing a machine is three things, not one: drop it from the roster, stop it
 * publishing again, and take its Activity with it. The feed lives in the push
 * relay (a different worker over a different D1) and its rows carry no expiry,
 * so a delete that stops at this table leaves a de-authorized machine's agents
 * on every surface of the account forever.
 */
async function handleDelete(
  request: Request,
  env: Env,
  userId: string,
  machineKey: string,
  correlationId: string,
  relayOptions: ActivityRelayOptions,
): Promise<Response> {
  if (request.method !== "DELETE") return text("method not allowed", 405);
  const existing = await env.DB.prepare(`
    select user_id, machine_key, device_id, name, custom_name, platform, device_type, pubkey,
           reachable_endpoints, last_seen_at, created_at
      from machines
     where user_id = ? and machine_key = ?
  `).bind(userId, machineKey).first<MachineRow>();
  // Record the revocation before dropping the row: if the write after it fails,
  // the machine is still listed but already blocked, and the user can retry.
  // The reverse order would leave a removed machine free to re-register.
  //
  // `coalesce` and not `excluded.device_id`: the retry the desktop tells the
  // user to run ("try removing it again" after a 502) re-enters here with the
  // `machines` row already gone, so `existing` is null. The first pass captured
  // the real id and later passes must not erase it — it is what the removal
  // audit trail (and support) reads to identify which install was removed.
  // Nothing on the register path branches on it: `deviceId` is caller-supplied,
  // so it can never authorize anything.
  await env.DB.prepare(`
    insert into revoked_machines(user_id, machine_key, device_id, revoked_at)
    values (?, ?, ?, ?)
    on conflict(user_id, machine_key) do update set
      device_id = coalesce(excluded.device_id, revoked_machines.device_id),
      revoked_at = excluded.revoked_at
  `).bind(userId, machineKey, existing?.device_id ?? null, Date.now()).run();
  await env.DB.prepare("delete from machines where user_id = ? and machine_key = ?")
    .bind(userId, machineKey)
    .run();

  const purged = await callActivityRelay(request, env, {
    operation: "purge",
    machineKey,
    correlationId,
    options: relayOptions,
  });
  if (!purged.ok) {
    // The machine is off the roster and blocked, but its Activity is still
    // there. Say so instead of reporting a clean removal the user can see is
    // untrue the next time they open Activity.
    logDirectoryRefusal({
      event: "directory.remove_refused",
      userId,
      machineKey,
      deviceId: existing?.device_id ?? null,
      code: "activity_purge_failed",
      correlationId,
      reason: purged.reason,
    });
    return json({
      ok: false,
      error: "activity purge failed",
      code: "activity_purge_failed",
      machineKey,
      machineRemoved: true,
      activityPurged: false,
      detail: purged.reason,
    }, { status: 502 });
  }
  return json({ ok: true, machineKey });
}

async function handleRename(
  request: Request,
  env: Env,
  userId: string,
  machineKey: string,
): Promise<Response> {
  if (request.method !== "PATCH") return text("method not allowed", 405);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid request body" }, { status: 400 });
  }
  if (!isRecord(raw) || !Object.hasOwn(raw, "customName")) {
    return json({ error: "invalid request body" }, { status: 400 });
  }
  const customName = optionalString(raw, "customName");
  if (customName === undefined || (customName?.length ?? 0) > MAX_CUSTOM_NAME_CHARS) {
    return json({ error: "invalid request body" }, { status: 400 });
  }

  const result = await env.DB.prepare(`
    update machines
       set custom_name = ?
     where user_id = ? and machine_key = ?
  `).bind(customName, userId, machineKey).run();
  if ((result.meta.changes ?? 0) === 0) {
    return json({ error: "machine not found" }, { status: 404 });
  }

  const row = await env.DB.prepare(`
    select user_id, machine_key, device_id, name, custom_name, platform, device_type, pubkey,
           reachable_endpoints, last_seen_at, created_at
      from machines
     where user_id = ? and machine_key = ?
  `).bind(userId, machineKey).first<MachineRow>();
  if (!row) return json({ error: "machine not found" }, { status: 404 });
  return json({
    ...machineRecord(row),
    online: typeof row.last_seen_at === "number"
      && Date.now() - row.last_seen_at <= onlineWindowMs(env),
  });
}

function trustedWebClientOrigin(env: Env): string | null {
  const raw = env.WEB_CLIENT_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.origin !== raw || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set(
    "access-control-expose-headers",
    "Server-Timing, X-ADE-Correlation-ID",
  );
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requestCorrelationId(request: Request): string {
  const provided = request.headers.get("x-ade-correlation-id")?.trim() ?? "";
  return CORRELATION_ID_PATTERN.test(provided)
    ? provided.toLowerCase()
    : crypto.randomUUID();
}

function withCorrelationId(response: Response, correlationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-ade-correlation-id", correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logDirectoryLifecycle(args: {
  correlationId: string;
  route: AccountRoute | null;
  method: string;
  status: number;
  durationMs: number;
}): void {
  const outcome = args.status < 400
    ? "ok"
    : args.status < 500
      ? "client_error"
      : "server_error";
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "ade-account-directory",
    kind: "request_completed",
    correlationId: args.correlationId,
    route: args.route?.kind ?? "other",
    method: args.method,
    status: args.status,
    outcome,
    durationMs: Math.max(0, Math.round(args.durationMs)),
  }));
}

async function handleRequestCore(
  request: Request,
  env: Env,
  options: DirectoryRequestOptions,
  correlationId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return request.method === "GET" ? json({ ok: true }) : text("method not allowed", 405);
  }

  const deviceResponse = await handleDeviceAuthorizationRequest(request, env, {
    ...options,
    // The device flow owns the sign-in; the grant it hands back is this
    // module's concern, so the minting (and the Clerk verification it needs)
    // stays here rather than being duplicated into the device module.
    mintPairingGrant: options.mintPairingGrant ?? ((args) => mintPairingGrant(env, {
      ...args,
      nowMs: (options.now ?? Date.now)(),
    })),
  });
  if (deviceResponse) return deviceResponse;

  const route = routeAccount(url.pathname);
  if (!route) return text("not found", 404);
  const timeMachineList = route.kind === "list" && request.method === "GET";
  const authStartedAt = timeMachineList ? performance.now() : 0;
  const authentication = await authenticate(request, env);
  const authDurationMs = timeMachineList ? performance.now() - authStartedAt : 0;
  if (!authentication.ok) {
    const response = json(
      { error: authentication.reason },
      {
        status: authentication.reason === "authentication unavailable" ? 503 : 401,
      },
    );
    return timeMachineList
      ? withServerTiming(response, authDurationMs, 0)
      : response;
  }
  const userId = authentication.userId;

  const relayOptions = options.activityRelay ?? {};
  if (route.kind === "register") {
    return await handleRegister(
      request,
      env,
      userId,
      correlationId,
      relayOptions,
      authentication.freshInteractiveAuthentication,
    );
  }
  if (route.kind === "list") return await handleList(request, env, userId, authDurationMs);
  if (request.method === "PATCH") {
    return await handleRename(request, env, userId, route.machineKey);
  }
  return await handleDelete(
    request,
    env,
    userId,
    route.machineKey,
    correlationId,
    relayOptions,
  );
}

export async function handleRequest(
  request: Request,
  env: Env,
  options: DirectoryRequestOptions = {},
): Promise<Response> {
  const startedAt = performance.now();
  const correlationId = requestCorrelationId(request);
  const url = new URL(request.url);
  const route = routeAccount(url.pathname);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedWebClientOrigin(env);
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin
    ? allowedOrigin
    : null;
  const finish = (response: Response, applyCors = false): Response => {
    const correlatedResponse = withCorrelationId(response, correlationId);
    logDirectoryLifecycle({
      correlationId,
      route,
      method: request.method,
      status: correlatedResponse.status,
      durationMs: performance.now() - startedAt,
    });
    return applyCors && corsOrigin
      ? withCors(correlatedResponse, corsOrigin)
      : correlatedResponse;
  };
  if (request.method === "OPTIONS") {
    const allowedMethod = route?.kind === "list"
      ? "GET"
      : route?.kind === "machine"
        ? request.headers.get("access-control-request-method")?.toUpperCase() === "PATCH"
          ? "PATCH"
          : "DELETE"
        : null;
    if (!allowedMethod) return finish(text("not found", 404));
    if (!corsOrigin) return finish(text("origin not allowed", 403));
    if (request.headers.get("access-control-request-method")?.toUpperCase() !== allowedMethod) {
      return finish(text("method not allowed", 405));
    }
    const allowsJsonBody = allowedMethod === "PATCH";
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedHeaders.some((header) =>
      header !== "authorization"
        && !(allowsJsonBody && header === "content-type")
        && header !== "x-ade-correlation-id"
    )) {
      return finish(text("headers not allowed", 403));
    }
    return finish(new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": allowsJsonBody
          ? "authorization, content-type, x-ade-correlation-id"
          : "authorization, x-ade-correlation-id",
        "access-control-expose-headers": "X-ADE-Correlation-ID",
        "access-control-allow-methods": `${allowedMethod}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    }));
  }
  // Daemon/native callers omit Origin. Browser callers must match the one
  // configured hosted client exactly; reject hostile origins before auth or D1.
  if (requestOrigin && routeAccount(url.pathname) && !corsOrigin) {
    return finish(text("origin not allowed", 403));
  }
  const response = await handleRequestCore(request, env, options, correlationId);
  return finish(response, Boolean(corsOrigin));
}
