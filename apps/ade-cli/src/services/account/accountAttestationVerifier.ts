import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AccountAttestationConfig } from "./sharedAccountAuthService";

const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const VERIFIED_ACCOUNT_ATTESTATION = Symbol("verified-account-attestation");

export type VerifiedAccountAttestation = {
  readonly userId: string;
  /** JWT expiry used only to bound the live Relay socket authorization. */
  readonly expiresAtMs: number;
  readonly [VERIFIED_ACCOUNT_ATTESTATION]: true;
};

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
  return typeof audience === "string"
    ? audience === expected
    : Array.isArray(audience) && audience.includes(expected);
}

function isAllowedCallerToken(payload: JWTPayload, oauthClientId: string): boolean {
  // Clerk native session tokens have no audience. Their azp can be absent,
  // empty, or origin-based, so azp alone must not reject that token shape.
  if (payload.aud === undefined) return true;

  // Daemon OAuth access tokens must be bound to ADE's configured client,
  // either directly through aud or through Clerk's authorized-party claim.
  return audienceIncludes(payload.aud, oauthClientId) || payload.azp === oauthClientId;
}

export async function verifyClerkAccountAttestation(args: {
  token: string;
  expectedUserId: string;
  config: AccountAttestationConfig;
}): Promise<VerifiedAccountAttestation> {
  const token = args.token.trim();
  const expectedUserId = args.expectedUserId.trim();
  const issuer = args.config.issuer.trim();
  const jwksUrl = args.config.jwksUrl.trim();
  const oauthClientId = args.config.oauthClientId.trim();
  if (!token || !expectedUserId) throw new Error("Account attestation is missing required identity data");
  if (!issuer || !jwksUrl || !oauthClientId) throw new Error("Clerk account attestation is not configured");

  const { payload } = await jwtVerify(token, getRemoteJwks(jwksUrl), {
    issuer,
    algorithms: ["RS256"],
    clockTolerance: 5,
    requiredClaims: ["sub", "exp"],
  });
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) throw new Error("Account attestation subject is required");
  if (subject !== expectedUserId) throw new Error("Account attestation subject does not match this machine owner");
  if (!isAllowedCallerToken(payload, oauthClientId)) {
    throw new Error("Account attestation audience is not allowed");
  }
  return Object.freeze({
    userId: subject,
    expiresAtMs: payload.exp! * 1_000,
    [VERIFIED_ACCOUNT_ATTESTATION]: true as const,
  });
}

export function isVerifiedAccountAttestation(value: unknown): value is VerifiedAccountAttestation {
  return Boolean(
    value
    && typeof value === "object"
    && (value as Partial<VerifiedAccountAttestation>)[VERIFIED_ACCOUNT_ATTESTATION] === true,
  );
}
