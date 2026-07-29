import {
  createRemoteJWKSet,
  decodeJwt,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";

export type AttentionAuthEnv = {
  CLERK_JWKS_URL?: string;
  CLERK_ISSUER?: string;
  CLERK_OAUTH_CLIENT_ID?: string;
  CLERK_SECONDARY_JWKS_URL?: string;
  CLERK_SECONDARY_ISSUER?: string;
  CLERK_SECONDARY_OAUTH_CLIENT_ID?: string;
};

type ClerkVerificationConfiguration = {
  jwksUrl: string;
  issuer: string;
  oauthClientId: string;
};

export type AttentionAuthConfigurationStatus = {
  configured: boolean;
  primaryConfigured: boolean;
  secondaryConfigured: boolean;
  errors: Array<
    | "primary_incomplete"
    | "primary_invalid_url"
    | "secondary_incomplete"
    | "secondary_invalid_url"
    | "issuers_not_distinct"
  >;
};

const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AttentionAuthVerificationUnavailableError extends Error {
  constructor() {
    super("Clerk verification service unavailable");
    this.name = "AttentionAuthVerificationUnavailableError";
  }
}

function audienceIncludes(audience: JWTPayload["aud"], expected: string): boolean {
  return typeof audience === "string"
    ? audience === expected
    : Array.isArray(audience) && audience.includes(expected);
}

function clerkConfiguration(
  values: [string | undefined, string | undefined, string | undefined],
): { configured: boolean; complete: boolean; validUrl: boolean; value: ClerkVerificationConfiguration | null } {
  const [jwksUrl, issuer, oauthClientId] = values.map((value) => value?.trim() ?? "") as [
    string,
    string,
    string,
  ];
  const configured = Boolean(jwksUrl || issuer || oauthClientId);
  const complete = Boolean(jwksUrl && issuer && oauthClientId);
  let validUrl = false;
  if (complete) {
    try {
      validUrl = new URL(jwksUrl).protocol === "https:"
        && new URL(issuer).protocol === "https:";
    } catch {
      validUrl = false;
    }
  }
  return {
    configured,
    complete,
    validUrl,
    value: complete && validUrl ? { jwksUrl, issuer, oauthClientId } : null,
  };
}

export function inspectAttentionAuthConfiguration(
  env: AttentionAuthEnv,
): AttentionAuthConfigurationStatus {
  const primary = clerkConfiguration([
    env.CLERK_JWKS_URL,
    env.CLERK_ISSUER,
    env.CLERK_OAUTH_CLIENT_ID,
  ]);
  const secondary = clerkConfiguration([
    env.CLERK_SECONDARY_JWKS_URL,
    env.CLERK_SECONDARY_ISSUER,
    env.CLERK_SECONDARY_OAUTH_CLIENT_ID,
  ]);
  const errors: AttentionAuthConfigurationStatus["errors"] = [];
  if (!primary.complete) errors.push("primary_incomplete");
  else if (!primary.validUrl) errors.push("primary_invalid_url");
  if (secondary.configured && !secondary.complete) errors.push("secondary_incomplete");
  else if (secondary.complete && !secondary.validUrl) errors.push("secondary_invalid_url");
  if (
    primary.value
    && secondary.value
    && primary.value.issuer === secondary.value.issuer
  ) {
    errors.push("issuers_not_distinct");
  }
  return {
    configured: errors.length === 0,
    primaryConfigured: primary.value != null,
    secondaryConfigured: secondary.value != null,
    errors,
  };
}

function configuredClerkVerifiers(env: AttentionAuthEnv): ClerkVerificationConfiguration[] {
  const primary = clerkConfiguration([
    env.CLERK_JWKS_URL,
    env.CLERK_ISSUER,
    env.CLERK_OAUTH_CLIENT_ID,
  ]).value;
  const secondary = clerkConfiguration([
    env.CLERK_SECONDARY_JWKS_URL,
    env.CLERK_SECONDARY_ISSUER,
    env.CLERK_SECONDARY_OAUTH_CLIENT_ID,
  ]).value;
  return [primary, secondary].filter(
    (configuration): configuration is ClerkVerificationConfiguration => configuration != null,
  );
}

export async function verifyAttentionBearerToken(
  request: Request,
  env: AttentionAuthEnv,
): Promise<string | null> {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  const token = match?.[1];
  if (!token) return null;

  let tokenIssuer: string;
  try {
    const decoded = decodeJwt(token);
    tokenIssuer = typeof decoded.iss === "string"
      ? decoded.iss.trim()
      : "";
  } catch {
    return null;
  }
  const config = configuredClerkVerifiers(env).find(
    (candidate) => candidate.issuer === tokenIssuer,
  );
  if (!config) return null;

  let jwks = remoteJwksByUrl.get(config.jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.jwksUrl));
    remoteJwksByUrl.set(config.jwksUrl, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!subject || subject.length > 256) return null;
    // Clerk native session tokens have no audience; OAuth access tokens are
    // client-bound through aud/azp. This matches ADE account-directory.
    if (
      payload.aud !== undefined
      && !audienceIncludes(payload.aud, config.oauthClientId)
      && payload.azp !== config.oauthClientId
    ) {
      return null;
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${config.issuer}\0${subject}`),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    if (
      error instanceof TypeError
      || error instanceof errors.JWKSTimeout
      || error instanceof errors.JWKSInvalid
      || error instanceof errors.JWKInvalid
      || (
        error instanceof errors.JOSEError
        && error.constructor === errors.JOSEError
      )
    ) {
      throw new AttentionAuthVerificationUnavailableError();
    }
    return null;
  }
}
