import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

/**
 * Clerk token verification, shared by every route that takes a caller bearer.
 *
 * It declares the slice of the Worker env it needs rather than importing the
 * full `Env`, exactly as `deviceAuthorization.ts` does: this module has no
 * business knowing about D1, the relay, or the diagnostics bucket, and keeping
 * it that way is what stops an import cycle back into `directory.ts`.
 */
export interface CallerTokenEnv {
  CLERK_JWKS_URL: string;
  CLERK_ISSUER: string;
  CLERK_OAUTH_CLIENT_ID: string;
}

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

const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type CallerTokenFailureReason =
  | "authentication unavailable"
  | "invalid audience"
  | "invalid issuer"
  | "invalid token"
  | "missing bearer token"
  | "missing token subject"
  | "token expired";

export class CallerTokenValidationError extends Error {
  constructor(readonly reason: CallerTokenFailureReason) {
    super(reason);
    this.name = "CallerTokenValidationError";
  }
}

/**
 * Was the token refused because THIS WORKER is misconfigured?
 *
 * That is a 503 on every route that takes a bearer, never a 401: telling a user
 * their token is invalid when the deployment simply has no JWKS URL sends them
 * to sign in again forever. Exported so the routes outside this module classify
 * it the same way rather than each matching on a message string.
 */
export function isAuthenticationUnavailableError(error: unknown): boolean {
  return error instanceof CallerTokenValidationError
    && error.reason === "authentication unavailable";
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

export function readBearerToken(request: Request): string | null {
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

async function verifyCallerTokenPayload(token: string, env: CallerTokenEnv): Promise<JWTPayload> {
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

export async function verifyCallerToken(token: string, env: CallerTokenEnv): Promise<string> {
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

export type CallerAuthenticationResult =
  | {
    ok: true;
    userId: string;
    /** Proven-recent interactive sign-in; the only thing `pairing` is honored on. */
    freshInteractiveAuthentication: boolean;
  }
  | { ok: false; reason: CallerTokenFailureReason };

export async function authenticate(
  request: Request,
  env: CallerTokenEnv,
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
