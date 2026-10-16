// Caller authentication shared by the relay routers: ADE account tokens
// (Clerk JWTs) and Linear viewer-organization tokens.

import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { isRecord, json, readNested, readString, type RelayEnv, sha256Hex } from "./shared";

type LinearViewerOrganizationResult =
  | { authorized: true; organizationId: string }
  | { authorized: false; response: Response };

export const LINEAR_AUTH_CACHE_TTL_MS = 5 * 60_000;
export const MAX_LINEAR_AUTH_CACHE_ENTRIES = 1_000;
export const ACCOUNT_TOKEN_HEADER = "x-ade-account-token";
const linearOrganizationByTokenHash = new Map<string, { organizationId: string; expiresAt: number }>();
const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function readBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? "";
}

export function readAuthorizationHeader(request: Request): string {
  return request.headers.get("authorization")?.trim() ?? "";
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

function isAllowedAccountToken(payload: JWTPayload, oauthClientIds: string[]): boolean {
  // Clerk OAuth access tokens name their client in `client_id` (RFC 9068), not
  // in `aud`/`azp`; checking only those rejected every desktop account token.
  const clientId = typeof (payload as Record<string, unknown>).client_id === "string"
    ? String((payload as Record<string, unknown>).client_id)
    : null;
  return oauthClientIds.some((id) =>
    audienceIncludes(payload.aud, id) || payload.azp === id || clientId === id);
}

type ClerkAccountTokenConfig = {
  issuer: string;
  jwksUrl: string;
  oauthClientId: string;
  /** More public OAuth client ids accepted for this issuer (`CLERK_EXTRA_OAUTH_CLIENT_IDS`). */
  extraClientIds?: string[];
};

function readClerkAccountTokenConfigs(env: RelayEnv): ClerkAccountTokenConfig[] {
  const primary = {
    issuer: env.CLERK_ISSUER?.trim() ?? "",
    jwksUrl: env.CLERK_JWKS_URL?.trim() ?? "",
    oauthClientId: env.CLERK_OAUTH_CLIENT_ID?.trim() ?? "",
  };
  if (!primary.issuer || !primary.jwksUrl || !primary.oauthClientId) {
    throw new Error("Clerk authentication is not configured");
  }
  const extraClientIds = (env.CLERK_EXTRA_OAUTH_CLIENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (extraClientIds.length > 0) (primary as ClerkAccountTokenConfig).extraClientIds = extraClientIds;

  const secondary = {
    issuer: env.CLERK_SECONDARY_ISSUER?.trim() ?? "",
    jwksUrl: env.CLERK_SECONDARY_JWKS_URL?.trim() ?? "",
    oauthClientId: env.CLERK_SECONDARY_OAUTH_CLIENT_ID?.trim() ?? "",
  };
  const hasSecondaryValue = Boolean(secondary.issuer || secondary.jwksUrl || secondary.oauthClientId);
  if (hasSecondaryValue && (!secondary.issuer || !secondary.jwksUrl || !secondary.oauthClientId)) {
    throw new Error("Secondary Clerk authentication is only partially configured");
  }

  return hasSecondaryValue ? [primary, secondary] : [primary];
}

async function verifyAccountTokenWithConfig(
  token: string,
  config: ClerkAccountTokenConfig,
): Promise<string> {
  const { payload } = await jwtVerify(token, getRemoteJwks(config.jwksUrl), {
    issuer: config.issuer,
    algorithms: ["RS256"],
    clockTolerance: 5,
    requiredClaims: ["sub", "exp"],
  });
  if (typeof payload.sub !== "string" || !payload.sub.trim()) throw new Error("Token subject is required");
  if (!isAllowedAccountToken(payload, [config.oauthClientId, ...(config.extraClientIds ?? [])])) {
    throw new Error("Token audience is not allowed");
  }
  return payload.sub;
}

function looksLikeJwt(value: string): boolean {
  return value.split(".").length === 3;
}

export function accountTokenCandidates(request: Request): string[] {
  const explicit = request.headers.get(ACCOUNT_TOKEN_HEADER)?.trim().replace(/^Bearer\s+/i, "") ?? "";
  const bearer = readBearerToken(request);
  return [...new Set([explicit, bearer].filter((token) => token && looksLikeJwt(token)))];
}

export async function verifyAccountToken(token: string, env: RelayEnv): Promise<string> {
  const configs = readClerkAccountTokenConfigs(env);
  const claimedIssuer = decodeJwt(token).iss;
  const config = typeof claimedIssuer === "string"
    ? configs.find((candidate) => candidate.issuer === claimedIssuer)
    : undefined;
  if (!config) throw new Error("Token issuer is not allowed");
  return await verifyAccountTokenWithConfig(token, config);
}

export async function hasValidBearerAccountToken(request: Request, env: RelayEnv): Promise<boolean> {
  const token = readBearerToken(request);
  if (!looksLikeJwt(token)) return false;
  try {
    await verifyAccountToken(token, env);
    return true;
  } catch {
    return false;
  }
}

export async function authenticateAccount(request: Request, env: RelayEnv): Promise<string | null> {
  for (const token of accountTokenCandidates(request)) {
    try {
      return await verifyAccountToken(token, env);
    } catch {
      // Account auth is additive. An invalid or absent account credential must
      // never suppress a successful legacy GitHub/Linear authorization path.
    }
  }
  return null;
}

export function linearGraphqlUrl(env: RelayEnv): string {
  const configured = env.LINEAR_API_BASE_URL?.trim() || "https://api.linear.app/graphql";
  const url = new URL(configured);
  if (url.pathname === "/") url.pathname = "/graphql";
  return url.toString();
}

export async function verifyLinearViewerOrganization(
  request: Request,
  env: RelayEnv,
): Promise<LinearViewerOrganizationResult> {
  const authorization = readAuthorizationHeader(request);
  if (!authorization) {
    return {
      authorized: false,
      response: json({ ok: false, error: "Linear authorization token is required" }, { status: 401 }),
    };
  }
  if (await hasValidBearerAccountToken(request, env)) {
    return {
      authorized: false,
      response: json({ ok: false, error: "Linear authorization token is required" }, { status: 401 }),
    };
  }

  const tokenHash = await sha256Hex(authorization);
  const cached = linearOrganizationByTokenHash.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    return { authorized: true, organizationId: cached.organizationId };
  }
  if (cached) linearOrganizationByTokenHash.delete(tokenHash);

  let response: Response;
  try {
    response = await fetch(linearGraphqlUrl(env), {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "query { viewer { organization { id } } }" }),
    });
  } catch {
    return {
      authorized: false,
      response: json({ ok: false, error: "Linear authorization check failed" }, { status: 502 }),
    };
  }

  const payload = await response.json().catch(() => null) as unknown;
  const record = isRecord(payload) ? payload : null;
  const data = readNested(record, "data");
  const viewer = readNested(data, "viewer");
  const organization = readNested(viewer, "organization");
  const organizationId = readString(organization, "id");
  if (!response.ok || !organizationId || (Array.isArray(record?.errors) && record.errors.length > 0)) {
    const status = response.status === 401 || response.status === 403 || response.ok ? 401 : 502;
    return {
      authorized: false,
      response: json({ ok: false, error: status === 401 ? "Invalid Linear authorization token" : "Linear authorization check failed" }, { status }),
    };
  }

  linearOrganizationByTokenHash.set(tokenHash, {
    organizationId,
    expiresAt: Date.now() + LINEAR_AUTH_CACHE_TTL_MS,
  });
  if (linearOrganizationByTokenHash.size > MAX_LINEAR_AUTH_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [hash, entry] of linearOrganizationByTokenHash) {
      if (entry.expiresAt <= now) linearOrganizationByTokenHash.delete(hash);
    }
    while (linearOrganizationByTokenHash.size > MAX_LINEAR_AUTH_CACHE_ENTRIES) {
      const oldest = linearOrganizationByTokenHash.keys().next().value as string | undefined;
      if (!oldest) break;
      linearOrganizationByTokenHash.delete(oldest);
    }
  }
  return { authorized: true, organizationId };
}
