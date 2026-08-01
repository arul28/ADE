import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";

const GITHUB_REST_API_VERSION = "2026-03-10";

export type RelayEnv = {
  DB: D1Database;
  /** One hibernating WebSocket fanout object per lowercased owner/repo. */
  REPO_EVENTS: DurableObjectNamespace;
  GITHUB_WEBHOOK_SECRET: string;
  RELAY_ACCESS_TOKEN?: string;
  EVENT_RETENTION_DAYS?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_API_BASE_URL?: string;
  LINEAR_API_BASE_URL?: string;
  CLERK_JWKS_URL?: string;
  CLERK_ISSUER?: string;
  CLERK_OAUTH_CLIENT_ID?: string;
  CLERK_SECONDARY_JWKS_URL?: string;
  CLERK_SECONDARY_ISSUER?: string;
  CLERK_SECONDARY_OAUTH_CLIENT_ID?: string;
  /**
   * Signing secret of the ADE Linear OAuth application. OAuth-app webhooks
   * sign every workspace's deliveries with this one app-level secret (unlike
   * workspace webhooks, which each carry a per-organization secret registered
   * in D1). Optional until the ADE Linear app exists.
   */
  LINEAR_APP_WEBHOOK_SECRET?: string;
};

type GitHubEventRow = {
  event_seq: number;
  event_id: string;
  github_event: string;
  github_delivery: string | null;
  repository_full_name: string | null;
  summary: string;
  payload_json: string;
  received_at: string;
};

type CursorRow = {
  event_seq: number;
  event_id: string;
};

type LinearEventRow = {
  event_seq: number;
  event_id: string;
  event_type: string;
  action: string;
  received_at: string;
  body: string;
};

type LinearOrganizationRow = {
  webhook_secret: string;
};

type AccountMappingRow = {
  account_id: string | null;
};

type AccountRepositoryRow = {
  repository_full_name: string;
  owner: string;
  name: string;
  installation_id: number | null;
  repository_selection: string | null;
  installed: number;
};

type AccountLinearOrganizationRow = {
  org_id: string;
};

type LinearViewerOrganizationResult =
  | { authorized: true; organizationId: string }
  | { authorized: false; response: Response };

type GitHubRepoAccessStatus =
  | {
      authorized: true;
      repositoryId: number | null;
    }
  | {
      authorized: false;
      response: Response;
    };

type GitHubRepoAccessLevel = "write" | "admin";

type GitHubApiJsonResponse = {
  status: number;
  ok: boolean;
  payload: Record<string, unknown>;
};

type AppRepositoryRow = {
  repository_full_name: string;
  installation_id: number | null;
  repository_selection: string | null;
  installed: number;
  last_seen_at: string;
  removed_at: string | null;
  account_id: string | null;
};

type LatestHookConfigRow = {
  hook_events_json: string | null;
  received_at: string;
};

type LatestWebhookMetaRow = {
  payload_json: string;
  received_at: string;
};

type GitHubAppApiInstallation = {
  id?: unknown;
  repository_selection?: unknown;
};

type GitHubAppApiStatus =
  | {
      configured: true;
      installed: true;
      installationId: number | null;
      repositorySelection: "all" | "selected" | "unknown";
    }
  | {
      configured: true;
      installed: false;
      error: string | null;
    }
  | {
      configured: false;
    };

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_GITHUB_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;
const MAX_LINEAR_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_LINEAR_REGISTRATION_BODY_BYTES = 16 * 1024;
const MAX_LINEAR_WEBHOOK_SECRET_LENGTH = 512;
const LINEAR_WEBHOOK_REPLAY_WINDOW_MS = 60_000;
const LINEAR_AUTH_CACHE_TTL_MS = 5 * 60_000;
const MAX_LINEAR_AUTH_CACHE_ENTRIES = 1_000;
const GITHUB_AUTH_CACHE_TTL_MS = 5 * 60_000;
const MAX_GITHUB_AUTH_CACHE_ENTRIES = 1_000;
const PROJECT_RELAY_TOKEN_PREFIX = "ade_proj_";
const PROJECT_RELAY_TOKEN_CONTEXT = "ade-github-relay-project";
const ACCOUNT_TOKEN_HEADER = "x-ade-account-token";
const encoder = new TextEncoder();
const linearOrganizationByTokenHash = new Map<string, { organizationId: string; expiresAt: number }>();
const linearWebhookAuthorityByTokenHash = new Map<string, { expiresAt: number }>();
const githubRepoAccessByTokenHashAndRepo = new Map<string, { repositoryId: number | null; expiresAt: number }>();
const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function contentLengthExceedsLimit(headers: Headers, limit: number): boolean {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(limit);
  } catch {
    return true;
  }
}

function hasValidGitHubSignatureShape(signature: string): boolean {
  return /^sha256=[0-9a-f]{64}$/i.test(signature);
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNested(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

function readBoolean(source: Record<string, unknown> | null | undefined, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === "boolean" ? value : null;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function derLength(length: number): number[] {
  if (length < 128) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derEncode(tag: number, content: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...derLength(content.length), ...content]);
}

function wrapPkcs1RsaPrivateKeyAsPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const privateKey = derEncode(0x04, pkcs1Der);
  return derEncode(0x30, new Uint8Array([...version, ...rsaAlgorithmIdentifier, ...privateKey]));
}

function readPrivateKeyDer(privateKey: string): ArrayBuffer {
  const normalized = privateKey.replace(/\\n/g, "\n").trim();
  const match = normalized.match(/-----BEGIN ([^-]+)-----([\s\S]+?)-----END \1-----/);
  if (!match) throw new Error("GitHub App private key must be a PEM encoded private key.");
  const label = match[1]?.trim();
  const body = match[2]?.replace(/\s+/g, "") ?? "";
  const der = base64ToBytes(body);
  if (label === "PRIVATE KEY") return der.slice().buffer;
  if (label === "RSA PRIVATE KEY") return wrapPkcs1RsaPrivateKeyAsPkcs8(der).slice().buffer;
  throw new Error("GitHub App private key must be a PKCS#8 or RSA PEM private key.");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export async function signGitHubWebhookBody(secret: string, body: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? encoder.encode(body) : body;
  const digest = await crypto.subtle.sign("HMAC", key, data);
  return `sha256=${toHex(digest)}`;
}

export async function signLinearWebhookBody(secret: string, body: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? encoder.encode(body) : body;
  return toHex(await crypto.subtle.sign("HMAC", key, data));
}

async function verifyGitHubSignature(secret: string, body: ArrayBuffer, signature: string): Promise<boolean> {
  if (!secret.trim()) return false;
  if (!signature.startsWith("sha256=")) return false;
  const expected = await signGitHubWebhookBody(secret, body);
  return constantTimeEqual(expected, signature);
}

async function verifyLinearSignature(secret: string, body: ArrayBuffer, signature: string): Promise<boolean> {
  if (!secret.trim() || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = await signLinearWebhookBody(secret, body);
  return constantTimeEqual(expected.toLowerCase(), signature.toLowerCase());
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
}

async function createGitHubAppJwt(appId: string, privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    readPrivateKeyDer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appId,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function deriveProjectRelayAccessToken(rootToken: string, projectId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(rootToken.trim()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${PROJECT_RELAY_TOKEN_CONTEXT}:${projectId.trim()}`),
  );
  return `${PROJECT_RELAY_TOKEN_PREFIX}${toHex(digest)}`;
}

function parseLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? DEFAULT_EVENT_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_EVENT_LIMIT;
  return Math.max(1, Math.min(MAX_EVENT_LIMIT, Math.trunc(raw)));
}

function routeProject(pathname: string): { projectId: string; action: "webhook" | "events" } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 4 && parts[0] === "projects" && parts[2] === "github") {
    if (parts[3] === "webhook") return { projectId: decodeURIComponent(parts[1] ?? ""), action: "webhook" };
    if (parts[3] === "events") return { projectId: decodeURIComponent(parts[1] ?? ""), action: "events" };
  }
  if (parts.length === 2 && parts[0] === "github" && parts[1] === "webhook") {
    return { projectId: "github-app", action: "webhook" };
  }
  if (parts.length === 3 && parts[0] === "github" && parts[1] === "webhook") {
    return { projectId: decodeURIComponent(parts[2] ?? ""), action: "webhook" };
  }
  return null;
}

function routeLinearOrganizationEvents(pathname: string): { organizationId: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "linear" || parts[1] !== "orgs" || parts[3] !== "events") {
    return null;
  }
  const organizationId = decodeURIComponent(parts[2] ?? "").trim();
  return organizationId ? { organizationId } : null;
}

function routeRepoEvents(pathname: string): { owner: string; name: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 5 && parts[0] === "github" && parts[1] === "repos" && parts[4] === "events") {
    const owner = decodeURIComponent(parts[2] ?? "").trim();
    const name = decodeURIComponent(parts[3] ?? "").trim();
    if (owner && name) return { owner, name };
  }
  return null;
}

function routeRepoSubscription(pathname: string): { owner: string; name: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 5 && parts[0] === "github" && parts[1] === "repos" && parts[4] === "subscribe") {
    const owner = decodeURIComponent(parts[2] ?? "").trim();
    const name = decodeURIComponent(parts[3] ?? "").trim();
    if (owner && name) return { owner, name };
  }
  return null;
}

function routeRepoWebhookAdmin(pathname: string): { owner: string; name: string; action: "heal" | "deliveries" } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 6 && parts[0] === "github" && parts[1] === "repos" && parts[4] === "webhook") {
    const owner = decodeURIComponent(parts[2] ?? "").trim();
    const name = decodeURIComponent(parts[3] ?? "").trim();
    if (owner && name && (parts[5] === "heal" || parts[5] === "deliveries")) {
      return { owner, name, action: parts[5] };
    }
  }
  return null;
}

function routeRepoStatus(pathname: string): { projectId: string | null; owner: string; name: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 7 && parts[0] === "projects" && parts[2] === "github" && parts[3] === "repos" && parts[6] === "status") {
    const projectId = decodeURIComponent(parts[1] ?? "").trim();
    const owner = decodeURIComponent(parts[4] ?? "").trim();
    const name = decodeURIComponent(parts[5] ?? "").trim();
    if (projectId && owner && name) return { projectId, owner, name };
  }
  if (parts.length === 5 && parts[0] === "github" && parts[1] === "repos" && parts[4] === "status") {
    const owner = decodeURIComponent(parts[2] ?? "").trim();
    const name = decodeURIComponent(parts[3] ?? "").trim();
    if (owner && name) return { projectId: null, owner, name };
  }
  return null;
}

function readBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? "";
}

function readAuthorizationHeader(request: Request): string {
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

function isAllowedAccountToken(payload: JWTPayload, oauthClientId: string): boolean {
  return audienceIncludes(payload.aud, oauthClientId) || payload.azp === oauthClientId;
}

type ClerkAccountTokenConfig = {
  issuer: string;
  jwksUrl: string;
  oauthClientId: string;
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
  if (!isAllowedAccountToken(payload, config.oauthClientId)) throw new Error("Token audience is not allowed");
  return payload.sub;
}

function looksLikeJwt(value: string): boolean {
  return value.split(".").length === 3;
}

function accountTokenCandidates(request: Request): string[] {
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

async function hasValidBearerAccountToken(request: Request, env: RelayEnv): Promise<boolean> {
  const token = readBearerToken(request);
  if (!looksLikeJwt(token)) return false;
  try {
    await verifyAccountToken(token, env);
    return true;
  } catch {
    return false;
  }
}

async function authenticateAccount(request: Request, env: RelayEnv): Promise<string | null> {
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

async function githubRepositoryAccountMatches(
  env: RelayEnv,
  repo: { owner: string; name: string },
  accountId: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare("select account_id from github_app_repositories where repository_key = ? and installed = 1 limit 1")
    .bind(`${repo.owner}/${repo.name}`.toLowerCase())
    .first<AccountMappingRow>();
  return row?.account_id === accountId;
}

async function linearOrganizationAccountMatches(
  env: RelayEnv,
  organizationId: string,
  accountId: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare("select account_id from linear_organizations where org_id = ? limit 1")
    .bind(organizationId)
    .first<AccountMappingRow>();
  return row?.account_id === accountId;
}

function linearGraphqlUrl(env: RelayEnv): string {
  const configured = env.LINEAR_API_BASE_URL?.trim() || "https://api.linear.app/graphql";
  const url = new URL(configured);
  if (url.pathname === "/") url.pathname = "/graphql";
  return url.toString();
}

async function verifyLinearViewerOrganization(
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

function assertRelayAuthorized(request: Request, env: RelayEnv): Response | null {
  const expected = env.RELAY_ACCESS_TOKEN?.trim();
  if (!expected) return json({ ok: false, error: "relay token is not configured" }, { status: 503 });
  const token = readBearerToken(request) || request.headers.get("x-ade-relay-token")?.trim() || "";
  if (!constantTimeEqual(token, expected)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function assertProjectRelayAuthorized(request: Request, env: RelayEnv, projectId: string): Promise<Response | null> {
  const rootToken = env.RELAY_ACCESS_TOKEN?.trim();
  if (!rootToken) return json({ ok: false, error: "relay token is not configured" }, { status: 503 });
  const token = readBearerToken(request) || request.headers.get("x-ade-relay-token")?.trim() || "";
  const expected = await deriveProjectRelayAccessToken(rootToken, projectId);
  if (!constantTimeEqual(token, expected)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function gitHubRepoAuthCacheKey(tokenHash: string, repo: { owner: string; name: string }): string {
  return `${tokenHash}:${repo.owner}/${repo.name}`.toLowerCase();
}

function cacheGitHubRepoAccess(key: string, repositoryId: number | null): void {
  githubRepoAccessByTokenHashAndRepo.set(key, {
    repositoryId,
    expiresAt: Date.now() + GITHUB_AUTH_CACHE_TTL_MS,
  });
  if (githubRepoAccessByTokenHashAndRepo.size <= MAX_GITHUB_AUTH_CACHE_ENTRIES) return;

  const now = Date.now();
  for (const [candidateKey, entry] of githubRepoAccessByTokenHashAndRepo) {
    if (entry.expiresAt <= now) githubRepoAccessByTokenHashAndRepo.delete(candidateKey);
  }
  while (githubRepoAccessByTokenHashAndRepo.size > MAX_GITHUB_AUTH_CACHE_ENTRIES) {
    const oldest = githubRepoAccessByTokenHashAndRepo.keys().next().value as string | undefined;
    if (!oldest) break;
    githubRepoAccessByTokenHashAndRepo.delete(oldest);
  }
}

/** Keeps isolate-scoped cache state from leaking between unit tests. */
export function clearGitHubRepoAuthCacheForTests(): void {
  githubRepoAccessByTokenHashAndRepo.clear();
}

async function assertGitHubRepoAuthorized(
  request: Request,
  env: RelayEnv,
  repo: { owner: string; name: string },
  level: GitHubRepoAccessLevel = "write",
): Promise<GitHubRepoAccessStatus> {
  const token = readBearerToken(request);
  if (!token) {
    return {
      authorized: false,
      response: json({ ok: false, error: "GitHub auth token is required" }, { status: 401 }),
    };
  }
  if (await hasValidBearerAccountToken(request, env)) {
    return {
      authorized: false,
      response: json({ ok: false, error: "GitHub auth token is required" }, { status: 401 }),
    };
  }

  // Only the normal write-level read check is cached. Admin checks must always
  // go back to GitHub so a previous push/write verdict cannot authorize webhook
  // management. Cache keys contain a token digest, never the credential itself.
  const cacheKey = level === "write"
    ? gitHubRepoAuthCacheKey(await sha256Hex(token), repo)
    : null;
  if (cacheKey) {
    const cached = githubRepoAccessByTokenHashAndRepo.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { authorized: true, repositoryId: cached.repositoryId };
    }
    if (cached) githubRepoAccessByTokenHashAndRepo.delete(cacheKey);
  }

  const apiBaseUrl = (env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
  const repoResponse = await fetchGitHubApiJson(
    apiBaseUrl,
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    token,
  );
  if (repoResponse.ok) {
    const repositoryId = readRepositoryId(repoResponse.payload);
    const permissions = readNested(repoResponse.payload, "permissions");
    if (permissions) {
      if (repoPermissionsAllowAccess(permissions, level)) {
        if (cacheKey) cacheGitHubRepoAccess(cacheKey, repositoryId);
        return { authorized: true, repositoryId };
      }
      return {
        authorized: false,
        response: insufficientRepoPermissionResponse(level),
      };
    }

    const fallback = await fetchAuthenticatedUserRepoPermission(apiBaseUrl, token, repo, level);
    if (fallback === "authorized") {
      if (cacheKey) cacheGitHubRepoAccess(cacheKey, repositoryId);
      return { authorized: true, repositoryId };
    }
    return {
      authorized: false,
      response: insufficientRepoPermissionResponse(level),
    };
  }

  const message = readString(repoResponse.payload, "message")
    || `GitHub repo access check failed with HTTP ${repoResponse.status}.`;
  return {
    authorized: false,
    response: json({ ok: false, error: message }, { status: repoResponse.status === 404 ? 404 : 403 }),
  };
}

async function fetchGitHubApiJson(apiBaseUrl: string, path: string, token: string): Promise<GitHubApiJsonResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "ADE GitHub Webhook Relay",
      "x-github-api-version": GITHUB_REST_API_VERSION,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: response.status,
    ok: response.ok,
    payload: isRecord(payload) ? payload : {},
  };
}

function readRepositoryId(payload: Record<string, unknown>): number | null {
  const raw = Number(payload.id);
  return Number.isFinite(raw) ? Math.trunc(raw) : null;
}

function repoPermissionsAllowAccess(permissions: Record<string, unknown>, level: GitHubRepoAccessLevel): boolean {
  if (level === "admin") return readBoolean(permissions, "admin") === true;
  return readBoolean(permissions, "admin") === true
    || readBoolean(permissions, "push") === true
    || readBoolean(permissions, "maintain") === true;
}

function collaboratorPermissionAllowsAccess(permission: string, level: GitHubRepoAccessLevel): boolean {
  const normalized = permission.trim().toLowerCase();
  if (level === "admin") return normalized === "admin";
  return normalized === "admin" || normalized === "write" || normalized === "maintain";
}

function insufficientRepoPermissionResponse(level: GitHubRepoAccessLevel): Response {
  const error = level === "admin"
    ? "GitHub token must have admin access to manage the ADE webhook for this repository."
    : "GitHub token must have push/write, maintain, or admin access to read ADE webhook deliveries for this repository.";
  return json({ ok: false, error }, { status: 403 });
}

async function fetchAuthenticatedUserRepoPermission(
  apiBaseUrl: string,
  token: string,
  repo: { owner: string; name: string },
  level: GitHubRepoAccessLevel,
): Promise<"authorized" | "denied"> {
  const userResponse = await fetchGitHubApiJson(apiBaseUrl, "/user", token);
  const login = readString(userResponse.payload, "login");
  if (!userResponse.ok || !login) return "denied";

  const permissionResponse = await fetchGitHubApiJson(
    apiBaseUrl,
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/collaborators/${encodeURIComponent(login)}/permission`,
    token,
  );
  if (!permissionResponse.ok) return "denied";

  const permission = readString(permissionResponse.payload, "permission");
  return permission && collaboratorPermissionAllowsAccess(permission, level) ? "authorized" : "denied";
}

function repositoryFullName(payload: Record<string, unknown>): string | null {
  const repository = readNested(payload, "repository");
  const fullName = readString(repository, "full_name");
  if (fullName) return fullName;
  const owner = readString(readNested(repository, "owner"), "login");
  const name = readString(repository, "name");
  return owner && name ? `${owner}/${name}` : null;
}

function installationId(payload: Record<string, unknown>): number | null {
  const raw = readNested(payload, "installation")?.id;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function repositorySelection(payload: Record<string, unknown>): "all" | "selected" | "unknown" {
  const raw = readString(readNested(payload, "installation"), "repository_selection")
    || readString(payload, "repository_selection");
  return raw === "all" || raw === "selected" ? raw : "unknown";
}

type RepositoryRef = {
  owner: string;
  name: string;
  fullName: string;
  key: string;
};

function repositoryRefFromRecord(record: Record<string, unknown>, fallbackOwner = ""): RepositoryRef | null {
  const fullName = readString(record, "full_name");
  if (fullName.includes("/")) {
    const [owner, name] = fullName.split("/");
    if (owner?.trim() && name?.trim()) {
      return {
        owner: owner.trim(),
        name: name.trim(),
        fullName: `${owner.trim()}/${name.trim()}`,
        key: `${owner.trim()}/${name.trim()}`.toLowerCase(),
      };
    }
  }
  const owner = readString(readNested(record, "owner"), "login") || fallbackOwner;
  const name = readString(record, "name");
  if (!owner || !name) return null;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    key: `${owner}/${name}`.toLowerCase(),
  };
}

function repositoryRefFromPayload(payload: Record<string, unknown>): RepositoryRef | null {
  const repository = readNested(payload, "repository");
  return repository ? repositoryRefFromRecord(repository) : null;
}

function accountOwner(payload: Record<string, unknown>): string {
  return readString(readNested(payload, "account"), "login")
    || readString(readNested(readNested(payload, "installation"), "account"), "login")
    || "";
}

function repositoryRefsFromArray(value: unknown, fallbackOwner = ""): RepositoryRef[] {
  if (!Array.isArray(value)) return [];
  const refs: RepositoryRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const ref = repositoryRefFromRecord(entry, fallbackOwner);
    if (!ref || seen.has(ref.key)) continue;
    seen.add(ref.key);
    refs.push(ref);
  }
  return refs;
}

function parseHookEvents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((event): event is string => typeof event === "string")
      .map((event) => event.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readWebhookEventDiagnostics(env: RelayEnv): Promise<{
  webhookEvents: string[];
  missingWebhookEvents: string[];
  webhookState: "active" | "deleted" | "unknown";
  webhookLastSeenAt: string | null;
}> {
  const ping = await env.DB
    .prepare(`
      select json_extract(payload_json, '$.hook.events') as hook_events_json,
             received_at
        from github_events
       where github_event = 'ping'
       order by received_at desc
       limit 1
    `)
    .first<LatestHookConfigRow>();
  const meta = await env.DB
    .prepare(`
      select payload_json, received_at
        from github_events
       where github_event = 'meta'
       order by received_at desc
       limit 1
    `)
    .first<LatestWebhookMetaRow>();
  let webhookState: "active" | "deleted" | "unknown" = ping ? "active" : "unknown";
  let webhookLastSeenAt = ping?.received_at ?? null;
  if (meta) {
    let action = "";
    try {
      const parsed = JSON.parse(meta.payload_json) as unknown;
      if (isRecord(parsed)) action = readString(parsed, "action");
    } catch {
      action = "";
    }
    if (action === "deleted" && (!ping || meta.received_at >= ping.received_at)) {
      webhookState = "deleted";
      webhookLastSeenAt = meta.received_at;
    }
  }
  const webhookEvents = parseHookEvents(ping?.hook_events_json ?? null);
  return {
    webhookEvents,
    // GitHub's install-status events are default GitHub App events and are not
    // shown in the selectable hook.events list, so absence here is not a setup
    // error. Keep the field for future diagnostics without flagging false gaps.
    missingWebhookEvents: [],
    webhookState,
    webhookLastSeenAt,
  };
}

async function upsertAppRepository(
  env: RelayEnv,
  repo: RepositoryRef,
  args: {
    installationId: number | null;
    repositorySelection: string;
    sourceEvent: string;
    seenAt: string;
  },
): Promise<void> {
  await env.DB
    .prepare(`
      insert into github_app_repositories(
        repository_key, repository_full_name, owner, name, installation_id,
        repository_selection, installed, last_seen_at, removed_at, source_event
      ) values (?, ?, ?, ?, ?, ?, 1, ?, null, ?)
      on conflict(repository_key) do update set
        repository_full_name = excluded.repository_full_name,
        owner = excluded.owner,
        name = excluded.name,
        installation_id = coalesce(excluded.installation_id, github_app_repositories.installation_id),
        repository_selection = excluded.repository_selection,
        installed = 1,
        last_seen_at = excluded.last_seen_at,
        removed_at = null,
        source_event = excluded.source_event
    `)
    .bind(
      repo.key,
      repo.fullName,
      repo.owner,
      repo.name,
      args.installationId,
      args.repositorySelection,
      args.seenAt,
      args.sourceEvent,
    )
    .run();
}

async function associateGitHubRepositoryWithAccount(
  env: RelayEnv,
  repositoryKey: string,
  repositoryFullName: string,
  accountId: string,
): Promise<boolean> {
  await env.DB
    .prepare("update github_app_repositories set account_id = ?, unlinked_account_id = null where repository_key = ? and account_id is null and (unlinked_account_id is null or unlinked_account_id <> ?)")
    .bind(accountId, repositoryKey, accountId)
    .run();
  const mapping = await env.DB
    .prepare("select account_id from github_app_repositories where repository_key = ? limit 1")
    .bind(repositoryKey)
    .first<AccountMappingRow>();
  if (mapping?.account_id !== accountId) return false;
  await env.DB
    .prepare(`
      update github_events
         set account_id = ?
       where repository_full_name = ? collate nocase
         and account_id is null
         and exists (
           select 1
             from github_app_repositories
            where repository_key = ? and account_id = ?
         )
    `)
    .bind(accountId, repositoryFullName, repositoryKey, accountId)
    .run();
  return true;
}

function gitHubAppApiConfigured(env: RelayEnv): boolean {
  return Boolean(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim());
}

async function fetchGitHubAppApiStatus(
  env: RelayEnv,
  repo: { owner: string; name: string },
): Promise<GitHubAppApiStatus> {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) return { configured: false };

  let jwt: string;
  try {
    jwt = await createGitHubAppJwt(appId, privateKey);
  } catch (error) {
    return {
      configured: true,
      installed: false,
      error: `GitHub App JWT could not be created: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const apiBaseUrl = (env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
  const url = `${apiBaseUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "ADE GitHub Webhook Relay",
      "x-github-api-version": GITHUB_REST_API_VERSION,
    },
  });
  if (response.status === 404) {
    return { configured: true, installed: false, error: null };
  }
  if (!response.ok) {
    return {
      configured: true,
      installed: false,
      error: `GitHub App installation check failed with HTTP ${response.status}.`,
    };
  }

  const payload = await response.json() as GitHubAppApiInstallation;
  const installationId = Number(payload.id);
  const selection = payload.repository_selection === "all" || payload.repository_selection === "selected"
    ? payload.repository_selection
    : "unknown";
  return {
    configured: true,
    installed: true,
    installationId: Number.isFinite(installationId) ? Math.trunc(installationId) : null,
    repositorySelection: selection,
  };
}

async function markAppRepositoryRemoved(
  env: RelayEnv,
  repo: RepositoryRef,
  args: {
    installationId: number | null;
    repositorySelection: string;
    sourceEvent: string;
    seenAt: string;
  },
): Promise<void> {
  await env.DB
    .prepare(`
      insert into github_app_repositories(
        repository_key, repository_full_name, owner, name, installation_id,
        repository_selection, installed, last_seen_at, removed_at, source_event
      ) values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      on conflict(repository_key) do update set
        repository_full_name = excluded.repository_full_name,
        owner = excluded.owner,
        name = excluded.name,
        installation_id = coalesce(excluded.installation_id, github_app_repositories.installation_id),
        repository_selection = excluded.repository_selection,
        installed = 0,
        last_seen_at = excluded.last_seen_at,
        removed_at = excluded.removed_at,
        source_event = excluded.source_event
    `)
    .bind(
      repo.key,
      repo.fullName,
      repo.owner,
      repo.name,
      args.installationId,
      args.repositorySelection,
      args.seenAt,
      args.seenAt,
      args.sourceEvent,
    )
    .run();
}

async function markInstallationRemoved(env: RelayEnv, installId: number, seenAt: string, sourceEvent: string): Promise<void> {
  await env.DB
    .prepare(`
      update github_app_repositories
         set installed = 0,
             last_seen_at = ?,
             removed_at = ?,
             source_event = ?
       where installation_id = ?
    `)
    .bind(seenAt, seenAt, sourceEvent, installId)
    .run();
}

async function updateAppRepositoryStatus(
  env: RelayEnv,
  githubEvent: string,
  payload: Record<string, unknown>,
  seenAt: string,
): Promise<void> {
  const installId = installationId(payload);
  const selection = repositorySelection(payload);
  const action = readString(payload, "action");
  if (githubEvent === "installation") {
    const repos = repositoryRefsFromArray(payload.repositories, accountOwner(payload));
    if (action === "deleted") {
      if (repos.length > 0) {
        await Promise.all(repos.map((repo) => markAppRepositoryRemoved(env, repo, {
          installationId: installId,
          repositorySelection: selection,
          sourceEvent: githubEvent,
          seenAt,
        })));
      } else if (installId != null) {
        await markInstallationRemoved(env, installId, seenAt, githubEvent);
      }
      return;
    }
    if (repos.length > 0) {
      await Promise.all(repos.map((repo) => upsertAppRepository(env, repo, {
        installationId: installId,
        repositorySelection: selection,
        sourceEvent: githubEvent,
        seenAt,
      })));
    }
    return;
  }

  if (githubEvent === "installation_repositories") {
    const owner = accountOwner(payload);
    const added = repositoryRefsFromArray(payload.repositories_added, owner);
    const removed = repositoryRefsFromArray(payload.repositories_removed, owner);
    await Promise.all([
      ...added.map((repo) => upsertAppRepository(env, repo, {
        installationId: installId,
        repositorySelection: selection,
        sourceEvent: githubEvent,
        seenAt,
      })),
      ...removed.map((repo) => markAppRepositoryRemoved(env, repo, {
        installationId: installId,
        repositorySelection: selection,
        sourceEvent: githubEvent,
        seenAt,
      })),
    ]);
    return;
  }

  const repo = repositoryRefFromPayload(payload);
  if (repo && installId != null) {
    await upsertAppRepository(env, repo, {
      installationId: installId,
      repositorySelection: selection,
      sourceEvent: githubEvent,
      seenAt,
    });
  }
}

function summarizeGitHubEvent(githubEvent: string, payload: Record<string, unknown>): string {
  const action = readString(payload, "action");
  const repo = repositoryFullName(payload);
  const pr = readNested(payload, "pull_request");
  const issue = readNested(payload, "issue");
  const subject = pr ?? issue;
  const number = Number(subject?.number);
  const title = readString(subject, "title");
  return [
    `GitHub ${githubEvent}`,
    action,
    repo,
    Number.isFinite(number) ? `#${number}` : "",
    title,
  ].filter(Boolean).join(" · ");
}

const SLIM_GITHUB_EVENT_TYPES = new Set(["check_run", "check_suite", "workflow_run", "status"]);

/**
 * Check-family payloads dominate storage, so remove only fields proven unused
 * by ADE instead of maintaining a fragile allowlist. We retain `action`,
 * `repository` (full_name/name/owner), `installation`, status sha/context/state,
 * and every check_run/check_suite/workflow_run field including pull_requests,
 * head_sha, status, conclusion, and name. prService uses those repo/PR/SHA
 * references to project or invalidate PRs; automation ingress preserves the
 * remaining raw event. Full payloads are kept for PRs, reviews, comments, and
 * ping. For check-family events only, the avatar-heavy top-level actor/org
 * duplicates are unused, and check_run.output is a large rendered report that
 * clients never inspect.
 */
export function slimGitHubPayloadForStorage(
  githubEvent: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!SLIM_GITHUB_EVENT_TYPES.has(githubEvent)) return payload;

  const {
    organization: _organization,
    enterprise: _enterprise,
    sender: _sender,
    ...slimmed
  } = payload;
  if (githubEvent !== "check_run" || !isRecord(slimmed.check_run)) return slimmed;

  const { output: _output, ...checkRun } = slimmed.check_run;
  return { ...slimmed, check_run: checkRun };
}

async function pruneOldEvents(env: RelayEnv): Promise<void> {
  const days = Number(env.EVENT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from github_events where received_at < ?")
    .bind(cutoff)
    .run();
}

function repoEventsObject(env: RelayEnv, repoFullName: string): DurableObjectStub {
  const id = env.REPO_EVENTS.idFromName(repoFullName.toLowerCase());
  return env.REPO_EVENTS.get(id);
}

async function notifyRepoEvents(env: RelayEnv, repoFullName: string): Promise<void> {
  const stub = repoEventsObject(env, repoFullName);
  const response = await stub.fetch("https://repo-events.internal/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: repoFullName }),
  });
  if (!response.ok) throw new Error(`Repo events Durable Object returned HTTP ${response.status}`);
}

async function handleGitHubWebhook(request: Request, env: RelayEnv, projectId: string): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  const webhookSecret = String(env.GITHUB_WEBHOOK_SECRET ?? "").trim();
  if (!webhookSecret) return json({ ok: false, error: "GitHub webhook secret is not configured" }, { status: 503 });
  const githubEvent = request.headers.get("x-github-event")?.trim() || "";
  const githubDelivery = request.headers.get("x-github-delivery")?.trim() || "";
  if (!githubEvent) return json({ ok: false, error: "missing x-github-event" }, { status: 400 });
  const signature = request.headers.get("x-hub-signature-256")?.trim() || "";
  if (!hasValidGitHubSignatureShape(signature)) {
    return json({ ok: false, error: "missing or invalid signature" }, { status: 401 });
  }
  if (contentLengthExceedsLimit(request.headers, MAX_GITHUB_WEBHOOK_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const verified = await verifyGitHubSignature(webhookSecret, body, signature);
  if (!verified) return json({ ok: false, error: "signature mismatch" }, { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "payload must be an object" }, { status: 400 });

  const rawPayloadJson = JSON.stringify(payload);
  const payloadJson = JSON.stringify(slimGitHubPayloadForStorage(githubEvent, payload));
  const repoFullName = repositoryFullName(payload);
  const eventId = githubDelivery || `sha256:${(await sha256Hex(`${githubEvent}:${rawPayloadJson}`)).slice(0, 32)}`;
  const existing = await env.DB
    .prepare("select event_id from github_events where project_id = ? and event_id = ? limit 1")
    .bind(projectId, eventId)
    .first<{ event_id: string }>();
  if (existing) return json({ ok: true, duplicate: true, eventId }, { status: 202 });

  const accountMapping = repoFullName
    ? await env.DB
      .prepare("select account_id from github_app_repositories where repository_key = ? limit 1")
      .bind(repoFullName.toLowerCase())
      .first<AccountMappingRow>()
    : null;
  const receivedAt = new Date().toISOString();
  await env.DB
    .prepare(`
      insert into github_events(
        project_id, event_id, github_event, github_delivery, repository_full_name,
        installation_id, summary, payload_json, received_at, account_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      projectId,
      eventId,
      githubEvent,
      githubDelivery || null,
      repoFullName,
      installationId(payload),
      summarizeGitHubEvent(githubEvent, payload),
      payloadJson,
      receivedAt,
      accountMapping?.account_id ?? null,
    )
    .run();

  if (repoFullName) {
    try {
      await notifyRepoEvents(env, repoFullName);
    } catch (error) {
      // D1 is the source of truth and the caller's safety poll recovers a
      // dropped wake-up. Never turn a committed delivery into a GitHub retry.
      console.warn(JSON.stringify({
        kind: "github_repo_notify_failed",
        repoHash: (await sha256Hex(repoFullName)).slice(0, 12),
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  await updateAppRepositoryStatus(env, githubEvent, payload, receivedAt);

  await pruneOldEvents(env);

  return json({ ok: true, duplicate: false, eventId }, { status: 202 });
}

function rowToEvent(row: GitHubEventRow): Record<string, unknown> {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (isRecord(parsed)) payload = parsed;
  } catch {
    payload = {};
  }
  const cursor = `seq:${Math.max(0, Math.trunc(Number(row.event_seq) || 0))}`;
  return {
    cursor,
    eventId: row.event_id,
    githubEvent: row.github_event,
    githubDelivery: row.github_delivery,
    repo: row.repository_full_name,
    summary: row.summary,
    createdAt: row.received_at,
    payload,
  };
}

function parseSequenceCursor(after: string): number | null {
  const match = /^seq:(\d+)$/i.exec(after.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nextCursorForRows(rows: GitHubEventRow[], fallback: string): string | null {
  const latest = rows.reduce((max, row) => Math.max(max, Math.trunc(Number(row.event_seq) || 0)), 0);
  if (latest > 0) return `seq:${latest}`;
  return fallback || null;
}

async function handleListEvents(request: Request, env: RelayEnv, projectId: string): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const authError = await assertProjectRelayAuthorized(request, env, projectId);
  if (authError) return authError;

  const url = new URL(request.url);
  const limit = parseLimit(url);
  const after = url.searchParams.get("after")?.trim() || "";
  let rows: GitHubEventRow[];
  let cursorExpired = false;

  if (after) {
    const sequenceCursor = parseSequenceCursor(after);
    if (sequenceCursor != null) {
      rows = (await env.DB
        .prepare(`
          select rowid as event_seq, event_id, github_event, github_delivery, repository_full_name,
                 summary, payload_json, received_at
            from github_events
           where project_id = ?
             and rowid > ?
           order by rowid desc
           limit ?
        `)
        .bind(projectId, sequenceCursor, limit)
        .all<GitHubEventRow>()).results ?? [];
    } else {
      const cursor = await env.DB
        .prepare("select rowid as event_seq, event_id from github_events where project_id = ? and event_id = ? limit 1")
        .bind(projectId, after)
        .first<CursorRow>();
      if (cursor) {
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, github_event, github_delivery, repository_full_name,
                   summary, payload_json, received_at
              from github_events
             where project_id = ?
               and rowid > ?
             order by rowid desc
             limit ?
          `)
          .bind(projectId, cursor.event_seq, limit)
          .all<GitHubEventRow>()).results ?? [];
      } else {
        cursorExpired = true;
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, github_event, github_delivery, repository_full_name,
                   summary, payload_json, received_at
              from github_events
             where project_id = ?
             order by rowid desc
             limit ?
          `)
          .bind(projectId, limit)
          .all<GitHubEventRow>()).results ?? [];
      }
    }
  } else {
    rows = (await env.DB
      .prepare(`
        select rowid as event_seq, event_id, github_event, github_delivery, repository_full_name,
               summary, payload_json, received_at
          from github_events
         where project_id = ?
         order by rowid desc
         limit ?
      `)
      .bind(projectId, limit)
      .all<GitHubEventRow>()).results ?? [];
  }

  return json({
    events: rows.map(rowToEvent),
    nextCursor: nextCursorForRows(rows, after),
    cursorExpired,
  });
}

type RepoEventReadAuthorization =
  | { authorized: true; accountId: string | null }
  | { authorized: false; response: Response };

async function authorizeRepoEventRead(
  request: Request,
  env: RelayEnv,
  repo: { owner: string; name: string },
): Promise<RepoEventReadAuthorization> {
  // Signed-in ADE clients already have a relay account identity whose repo
  // binding was established during GitHub App setup. Check that first so every
  // event poll and WebSocket reconnect does not spend a GitHub REST request on
  // re-proving repository access. The GitHub-token path remains for legacy
  // clients that do not send an ADE account token.
  const accountId = await authenticateAccount(request, env);
  if (accountId && await githubRepositoryAccountMatches(env, repo, accountId)) {
    return { authorized: true, accountId };
  }

  const auth = await assertGitHubRepoAuthorized(request, env, repo);
  if (auth.authorized) return { authorized: true, accountId: null };
  return { authorized: false, response: auth.response };
}

async function handleListRepoEvents(request: Request, env: RelayEnv, repo: { owner: string; name: string }): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const authorization = await authorizeRepoEventRead(request, env, repo);
  if (!authorization.authorized) return authorization.response;
  const accountId = authorization.accountId;

  const url = new URL(request.url);
  const limit = parseLimit(url);
  const ascending = url.searchParams.get("order")?.trim().toLowerCase() === "asc";
  const order = ascending ? "asc" : "desc";
  const queryLimit = ascending ? limit + 1 : limit;
  const after = url.searchParams.get("after")?.trim() || "";
  const repoFullName = `${repo.owner}/${repo.name}`.toLowerCase();
  const accountPredicate = accountId ? " and account_id = ?" : "";
  const accountBinding = accountId ? [accountId] : [];
  let afterSequence: number | null = null;
  let cursorExpired = false;

  if (after) {
    const sequenceCursor = parseSequenceCursor(after);
    if (sequenceCursor != null) {
      afterSequence = sequenceCursor;
    } else {
      const cursor = await env.DB
        .prepare(`select rowid as event_seq, event_id from github_events where repository_full_name = ? collate nocase${accountPredicate} and event_id = ? limit 1`)
        .bind(repoFullName, ...accountBinding, after)
        .first<CursorRow>();
      if (cursor) {
        afterSequence = cursor.event_seq;
      } else {
        cursorExpired = true;
      }
    }
  }

  const cursorPredicate = afterSequence === null ? "" : " and rowid > ?";
  let rows = (await env.DB
    .prepare(`
      select rowid as event_seq, event_id, github_event, github_delivery, repository_full_name,
             summary, payload_json, received_at
        from github_events
       where repository_full_name = ? collate nocase${accountPredicate}${cursorPredicate}
       order by rowid ${order}
       limit ?
    `)
    .bind(
      repoFullName,
      ...accountBinding,
      ...(afterSequence === null ? [] : [afterSequence]),
      queryLimit,
    )
    .all<GitHubEventRow>()).results ?? [];

  const hasMore = ascending && rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  return json({
    events: rows.map(rowToEvent),
    nextCursor: nextCursorForRows(rows, after),
    cursorExpired,
    ...(ascending ? { hasMore } : {}),
  });
}

async function handleRepoSubscription(
  request: Request,
  env: RelayEnv,
  repo: { owner: string; name: string },
): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return text("expected websocket", 426);
  }
  const authorization = await authorizeRepoEventRead(request, env, repo);
  if (!authorization.authorized) return authorization.response;

  const repoFullName = `${repo.owner}/${repo.name}`;
  const stub = repoEventsObject(env, repoFullName);
  return await stub.fetch(
    new Request(`https://repo-events.internal/subscribe?repo=${encodeURIComponent(repoFullName)}`, {
      headers: { upgrade: "websocket" },
    }),
  );
}

function githubApiBaseUrl(env: RelayEnv): string {
  return (env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

async function createAppJwtOrErrorResponse(env: RelayEnv): Promise<{ jwt: string } | { response: Response }> {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) {
    return { response: json({ ok: false, error: "GitHub App credentials are not configured on the relay." }, { status: 503 }) };
  }
  try {
    return { jwt: await createGitHubAppJwt(appId, privateKey) };
  } catch (error) {
    return {
      response: json(
        { ok: false, error: `GitHub App JWT could not be created: ${error instanceof Error ? error.message : String(error)}` },
        { status: 502 },
      ),
    };
  }
}

// Re-syncs the GitHub App's webhook secret to this worker's GITHUB_WEBHOOK_SECRET.
// This is the recovery path for signature-mismatch drift (secret rotated on one
// side only): it can only converge the pair onto the worker's current secret,
// never set an arbitrary value, so repeated calls are idempotent.
async function handleWebhookHeal(request: Request, env: RelayEnv, repo: { owner: string; name: string }): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  const webhookSecret = String(env.GITHUB_WEBHOOK_SECRET ?? "").trim();
  if (!webhookSecret) return json({ ok: false, error: "GitHub webhook secret is not configured" }, { status: 503 });

  const auth = await assertGitHubRepoAuthorized(request, env, repo, "admin");
  if (!auth.authorized) return auth.response;

  const appAuth = await createAppJwtOrErrorResponse(env);
  if ("response" in appAuth) return appAuth.response;

  const appStatus = await fetchGitHubAppApiStatus(env, repo);
  if (!appStatus.configured || !appStatus.installed) {
    const error = appStatus.configured && !appStatus.installed && appStatus.error
      ? appStatus.error
      : "The ADE GitHub App is not installed on this repository.";
    return json({ ok: false, error }, { status: 409 });
  }

  const response = await fetch(`${githubApiBaseUrl(env)}/app/hook/config`, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appAuth.jwt}`,
      "content-type": "application/json",
      "user-agent": "ADE GitHub Webhook Relay",
      "x-github-api-version": GITHUB_REST_API_VERSION,
    },
    body: JSON.stringify({ secret: webhookSecret }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = (isRecord(payload) && readString(payload, "message"))
      || `GitHub App webhook config update failed with HTTP ${response.status}.`;
    return json({ ok: false, error: message }, { status: 502 });
  }
  return json({
    ok: true,
    healed: true,
    webhookUrl: isRecord(payload) ? readString(payload, "url") || null : null,
    contentType: isRecord(payload) ? readString(payload, "content_type") || null : null,
    checkedAt: new Date().toISOString(),
  });
}

// Proxies the GitHub App's webhook delivery log, filtered to the requested
// repository, so delivery failures (signature mismatch, timeouts) are
// observable without access to the GitHub App settings UI.
async function handleWebhookDeliveries(request: Request, env: RelayEnv, repo: { owner: string; name: string }): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);

  const auth = await assertGitHubRepoAuthorized(request, env, repo);
  if (!auth.authorized) return auth.response;

  const appAuth = await createAppJwtOrErrorResponse(env);
  if ("response" in appAuth) return appAuth.response;

  // `limit` bounds the per-repo result, not the GitHub fetch: the delivery log
  // is app-wide, so always pull the max page and apply the caller's limit
  // after the repo filter — otherwise busy sibling repos could starve the
  // requested repo out of a small page.
  const limit = Math.min(100, parseLimit(new URL(request.url)));
  const response = await fetch(`${githubApiBaseUrl(env)}/app/hook/deliveries?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appAuth.jwt}`,
      "user-agent": "ADE GitHub Webhook Relay",
      "x-github-api-version": GITHUB_REST_API_VERSION,
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || !Array.isArray(payload)) {
    const message = (isRecord(payload) && readString(payload, "message"))
      || `GitHub App delivery log fetch failed with HTTP ${response.status}.`;
    return json({ ok: false, error: message }, { status: 502 });
  }

  const deliveries = payload
    .filter(isRecord)
    .filter((item) => {
      // Keep app-level deliveries (ping/meta have no repository) so webhook
      // config issues stay visible alongside repo-scoped deliveries. When a
      // delivery IS repo-scoped, fail closed: drop it unless it provably
      // matches the repo the caller was authorized for.
      if (item.repository_id == null) return true;
      const repositoryId = Number(item.repository_id);
      if (!Number.isFinite(repositoryId)) return false;
      return auth.repositoryId != null && Math.trunc(repositoryId) === auth.repositoryId;
    })
    .map((item) => ({
      id: Number.isFinite(Number(item.id)) ? Math.trunc(Number(item.id)) : null,
      guid: readString(item, "guid") || null,
      event: readString(item, "event") || null,
      action: readString(item, "action") || null,
      status: readString(item, "status") || null,
      statusCode: Number.isFinite(Number(item.status_code)) ? Math.trunc(Number(item.status_code)) : null,
      deliveredAt: readString(item, "delivered_at") || null,
      redelivery: item.redelivery === true,
      installationId: Number.isFinite(Number(item.installation_id)) ? Math.trunc(Number(item.installation_id)) : null,
    }))
    .slice(0, limit);

  return json({ ok: true, deliveries, checkedAt: new Date().toISOString() });
}

async function handleRepoStatus(request: Request, env: RelayEnv, repo: { projectId: string | null; owner: string; name: string }): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  let accountId: string | null = null;
  if (repo.projectId) {
    const authError = await assertProjectRelayAuthorized(request, env, repo.projectId);
    if (authError) return authError;
    accountId = await authenticateAccount(request, env);
  } else {
    const auth = await assertGitHubRepoAuthorized(request, env, repo);
    accountId = await authenticateAccount(request, env);
    if (!auth.authorized && (!accountId || !await githubRepositoryAccountMatches(env, repo, accountId))) {
      return auth.response;
    }
  }

  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  const key = `${repo.owner}/${repo.name}`.toLowerCase();
  const diagnostics = await readWebhookEventDiagnostics(env);
  let row = await env.DB
    .prepare(`
      select repository_full_name, installation_id, repository_selection,
             installed, last_seen_at, removed_at, account_id
        from github_app_repositories
       where repository_key = ?
       limit 1
    `)
    .bind(key)
    .first<AppRepositoryRow>();
  if (accountId && row && row.account_id == null
    && await associateGitHubRepositoryWithAccount(env, key, row.repository_full_name, accountId)) {
    row = { ...row, account_id: accountId };
  }
  const checkedAt = new Date().toISOString();
  const installedFromWebhook = row?.installed === 1 && !row.removed_at;
  if ((forceRefresh || !installedFromWebhook) && gitHubAppApiConfigured(env)) {
    const apiStatus = await fetchGitHubAppApiStatus(env, repo);
    if (apiStatus.configured && apiStatus.installed) {
      const fullName = `${repo.owner}/${repo.name}`;
      await upsertAppRepository(env, {
        owner: repo.owner,
        name: repo.name,
        fullName,
        key,
      }, {
        installationId: apiStatus.installationId,
        repositorySelection: apiStatus.repositorySelection,
        sourceEvent: "github_app_api",
        seenAt: checkedAt,
      });
      if (accountId) {
        await associateGitHubRepositoryWithAccount(env, key, fullName, accountId);
      }
      return json({
        repo: { owner: repo.owner, name: repo.name, fullName },
        installed: true,
        state: "configured",
        installationId: apiStatus.installationId,
        repositorySelection: apiStatus.repositorySelection,
        lastSeenAt: checkedAt,
        webhookEvents: diagnostics.webhookEvents,
        missingWebhookEvents: diagnostics.missingWebhookEvents,
        webhookState: diagnostics.webhookState,
        webhookLastSeenAt: diagnostics.webhookLastSeenAt,
        checkedAt,
        error: null,
      });
    }
    if (apiStatus.configured && apiStatus.error) {
      return json({
        repo: { owner: repo.owner, name: repo.name, fullName: row?.repository_full_name ?? `${repo.owner}/${repo.name}` },
        installed: false,
        state: "error",
        installationId: row?.installation_id ?? null,
        repositorySelection:
          row?.repository_selection === "all" || row?.repository_selection === "selected"
            ? row.repository_selection
            : row?.repository_selection === "unknown"
              ? "unknown"
              : null,
        lastSeenAt: row?.last_seen_at ?? null,
        webhookEvents: diagnostics.webhookEvents,
        missingWebhookEvents: diagnostics.missingWebhookEvents,
        webhookState: diagnostics.webhookState,
        webhookLastSeenAt: diagnostics.webhookLastSeenAt,
        checkedAt,
        error: apiStatus.error,
      }, { status: 502 });
    }
    if (forceRefresh && row) {
      await markAppRepositoryRemoved(env, {
        owner: repo.owner,
        name: repo.name,
        fullName: row.repository_full_name,
        key,
      }, {
        installationId: row.installation_id,
        repositorySelection: row.repository_selection ?? "unknown",
        sourceEvent: "github_app_api",
        seenAt: checkedAt,
      });
      return json({
        repo: { owner: repo.owner, name: repo.name, fullName: row.repository_full_name },
        installed: false,
        state: "not_installed",
        installationId: row.installation_id,
        repositorySelection:
          row.repository_selection === "all" || row.repository_selection === "selected"
            ? row.repository_selection
            : row.repository_selection === "unknown"
              ? "unknown"
              : null,
        lastSeenAt: checkedAt,
        webhookEvents: diagnostics.webhookEvents,
        missingWebhookEvents: diagnostics.missingWebhookEvents,
        webhookState: diagnostics.webhookState,
        webhookLastSeenAt: diagnostics.webhookLastSeenAt,
        checkedAt,
        error: null,
      });
    }
  }
  if (!row) {
    return json({
      repo: { owner: repo.owner, name: repo.name, fullName: `${repo.owner}/${repo.name}` },
      installed: false,
      state: "not_installed",
      installationId: null,
      repositorySelection: null,
      lastSeenAt: null,
      webhookEvents: diagnostics.webhookEvents,
      missingWebhookEvents: diagnostics.missingWebhookEvents,
      webhookState: diagnostics.webhookState,
      webhookLastSeenAt: diagnostics.webhookLastSeenAt,
      checkedAt,
      error: null,
    });
  }

  const installed = installedFromWebhook;
  return json({
    repo: { owner: repo.owner, name: repo.name, fullName: row.repository_full_name },
    installed,
    state: installed ? "configured" : "not_installed",
    installationId: row.installation_id,
    repositorySelection:
      row.repository_selection === "all" || row.repository_selection === "selected"
        ? row.repository_selection
        : "unknown",
    lastSeenAt: row.last_seen_at,
    webhookEvents: diagnostics.webhookEvents,
    missingWebhookEvents: diagnostics.missingWebhookEvents,
    webhookState: diagnostics.webhookState,
    webhookLastSeenAt: diagnostics.webhookLastSeenAt,
    checkedAt,
    error: null,
  });
}

// Only workspace admins (or OAuth tokens carrying the admin scope) may read
// webhooks in Linear. Probing that read is how registration proves the caller
// has webhook authority — without it, any workspace member's token could
// overwrite the org's signing secret and silently break ingest verification.
async function verifyLinearWebhookAuthority(
  request: Request,
  env: RelayEnv,
): Promise<{ authorized: true } | { authorized: false; response: Response }> {
  const authorization = readAuthorizationHeader(request);
  const tokenHash = await sha256Hex(authorization);
  const cached = linearWebhookAuthorityByTokenHash.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    return { authorized: true };
  }
  if (cached) linearWebhookAuthorityByTokenHash.delete(tokenHash);
  let response: Response;
  try {
    response = await fetch(linearGraphqlUrl(env), {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "query { webhooks(first: 1) { nodes { id } } }" }),
    });
  } catch {
    return {
      authorized: false,
      response: json({ ok: false, error: "Unable to verify Linear webhook authority" }, { status: 502 }),
    };
  }
  const payload = await response.json().catch(() => null) as { data?: { webhooks?: unknown }; errors?: unknown[] } | null;
  if (!response.ok || !payload || Array.isArray(payload.errors) && payload.errors.length > 0 || payload.data?.webhooks == null) {
    return {
      authorized: false,
      response: json(
        { ok: false, error: "Linear webhook authority required (workspace admin or admin-scoped token)" },
        { status: 403 },
      ),
    };
  }
  linearWebhookAuthorityByTokenHash.set(tokenHash, { expiresAt: Date.now() + 5 * 60_000 });
  return { authorized: true };
}

async function handleLinearOrganizationRegister(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  const auth = await verifyLinearViewerOrganization(request, env);
  if (!auth.authorized) return auth.response;
  const authority = await verifyLinearWebhookAuthority(request, env);
  if (!authority.authorized) return authority.response;
  const accountId = await authenticateAccount(request, env);
  if (contentLengthExceedsLimit(request.headers, MAX_LINEAR_REGISTRATION_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_LINEAR_REGISTRATION_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid payload");
    payload = parsed;
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const secret = typeof payload.secret === "string" ? payload.secret.trim() : "";
  if (!secret) return json({ ok: false, error: "secret is required" }, { status: 400 });
  if (secret.length > MAX_LINEAR_WEBHOOK_SECRET_LENGTH) {
    return json({ ok: false, error: `secret must be at most ${MAX_LINEAR_WEBHOOK_SECRET_LENGTH} characters` }, { status: 400 });
  }

  const now = new Date().toISOString();
  await env.DB
    .prepare(`
      insert into linear_organizations(org_id, webhook_secret, registered_at, updated_at, account_id)
      values (?, ?, ?, ?, ?)
      on conflict(org_id) do update set
        webhook_secret = excluded.webhook_secret,
        updated_at = excluded.updated_at,
        account_id = case
          when excluded.account_id is null then linear_organizations.account_id
          when linear_organizations.account_id is not null then linear_organizations.account_id
          when linear_organizations.unlinked_account_id = excluded.account_id then null
          else excluded.account_id
        end,
        unlinked_account_id = case
          when excluded.account_id is null then linear_organizations.unlinked_account_id
          when linear_organizations.account_id is not null then linear_organizations.unlinked_account_id
          when linear_organizations.unlinked_account_id = excluded.account_id then linear_organizations.unlinked_account_id
          else null
        end
    `)
    .bind(auth.organizationId, secret, now, now, accountId)
    .run();
  if (accountId) {
    await env.DB
      .prepare(`
        update linear_events
           set account_id = ?
         where org_id = ?
           and account_id is null
           and exists (
             select 1
               from linear_organizations
              where org_id = ? and account_id = ?
           )
      `)
      .bind(accountId, auth.organizationId, auth.organizationId, accountId)
      .run();
  }

  return json({ organizationId: auth.organizationId });
}

/**
 * Bounces Linear's OAuth redirect (an https URL Linear accepts) to the ADE app's
 * custom scheme so `ASWebAuthenticationSession` can capture it. Stateless: the
 * PKCE `state` is validated on the desktop, never here. The authorization `code`
 * is PKCE-bound and useless in transit, but MUST NOT be logged regardless.
 */
function handleLinearOAuthCallback(request: Request): Response {
  if (request.method !== "GET") return text("method not allowed", 405);
  const params = new URL(request.url).searchParams;
  const callback = new URLSearchParams();
  const error = params.get("error");
  if (error) {
    callback.set("error", error);
    const description = params.get("error_description");
    if (description) callback.set("error_description", description);
  } else {
    callback.set("code", params.get("code") ?? "");
  }
  callback.set("state", params.get("state") ?? "");
  // URLSearchParams serializes spaces as "+", but the iOS callback parser reads
  // the custom-scheme URL with URLComponents, which does NOT turn "+" back into
  // a space — so an error like "User declined" would render as "User+declined".
  // Emit %20 for spaces to keep Linear's user-facing error text readable.
  const query = callback.toString().replace(/\+/g, "%20");
  return new Response(null, {
    status: 302,
    headers: { location: `ade://linear-oauth?${query}` },
  });
}

async function pruneOldLinearEvents(env: RelayEnv): Promise<void> {
  const days = Number(env.EVENT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from linear_events where received_at < ?")
    .bind(cutoff)
    .run();
}

async function handleLinearWebhook(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (contentLengthExceedsLimit(request.headers, MAX_LINEAR_WEBHOOK_BODY_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_LINEAR_WEBHOOK_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  const rawBody = new TextDecoder().decode(body);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid payload");
    payload = parsed;
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const organizationId = readString(payload, "organizationId");
  if (!organizationId) return json({ ok: false, error: "organizationId is required" }, { status: 400 });
  const organization = await env.DB
    .prepare("select webhook_secret from linear_organizations where org_id = ? limit 1")
    .bind(organizationId)
    .first<LinearOrganizationRow>();

  // Two legitimate signers: the per-organization secret registered by a
  // workspace webhook, and the ADE Linear OAuth app's single app-level
  // secret (Linear signs every workspace's app deliveries with it, so app
  // deliveries need no prior per-org registration).
  const signature = request.headers.get("linear-signature")?.trim() ?? "";
  const appSecret = env.LINEAR_APP_WEBHOOK_SECRET?.trim() || null;
  const signedByOrganization = organization
    ? await verifyLinearSignature(organization.webhook_secret, body, signature)
    : false;
  const signedByApp = !signedByOrganization && appSecret
    ? await verifyLinearSignature(appSecret, body, signature)
    : false;
  if (!signedByOrganization && !signedByApp) {
    if (!organization) {
      // Indistinguishable from an accepted delivery so unauthenticated callers
      // cannot probe which organizations have registered ADE ingestion. Nothing
      // is stored; the registration status endpoint is the debugging surface.
      return json({ ok: true });
    }
    return json({ ok: false, error: "signature mismatch" }, { status: 401 });
  }

  const webhookTimestamp = typeof payload.webhookTimestamp === "number"
    ? payload.webhookTimestamp
    : Number(payload.webhookTimestamp);
  if (!Number.isFinite(webhookTimestamp) || Math.abs(Date.now() - webhookTimestamp) > LINEAR_WEBHOOK_REPLAY_WINDOW_MS) {
    return json({ ok: false, error: "stale webhook timestamp" }, { status: 401 });
  }

  const eventType = request.headers.get("linear-event")?.trim() || readString(payload, "type");
  const action = readString(payload, "action");
  if (!eventType || !action) {
    return json({ ok: false, error: "event type and action are required" }, { status: 400 });
  }
  const eventId = request.headers.get("linear-delivery")?.trim() || `sha256:${await sha256Hex(body)}`;
  const existing = await env.DB
    .prepare("select event_id from linear_events where org_id = ? and event_id = ? limit 1")
    .bind(organizationId, eventId)
    .first<{ event_id: string }>();
  if (existing) return json({ ok: true, duplicate: true, eventId });

  const accountMapping = organization
    ? await env.DB
      .prepare("select account_id from linear_organizations where org_id = ? limit 1")
      .bind(organizationId)
      .first<AccountMappingRow>()
    : null;
  const receivedAt = new Date().toISOString();
  await env.DB
    .prepare(`
      insert or ignore into linear_events(org_id, event_id, event_type, action, received_at, body, account_id)
      values (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(organizationId, eventId, eventType, action, receivedAt, rawBody, accountMapping?.account_id ?? null)
    .run();
  await pruneOldLinearEvents(env);

  return json({ ok: true, duplicate: false, eventId });
}

function linearRowToEvent(row: LinearEventRow): Record<string, unknown> {
  const cursor = `seq:${Math.max(0, Math.trunc(Number(row.event_seq) || 0))}`;
  return {
    cursor,
    eventId: row.event_id,
    eventType: row.event_type,
    action: row.action,
    createdAt: row.received_at,
    body: row.body,
  };
}

function nextLinearCursor(rows: LinearEventRow[], fallback: string): string | null {
  const latest = rows.reduce((max, row) => Math.max(max, Math.trunc(Number(row.event_seq) || 0)), 0);
  return latest > 0 ? `seq:${latest}` : fallback || null;
}

async function handleListLinearEvents(
  request: Request,
  env: RelayEnv,
  organizationId: string,
): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const auth = await verifyLinearViewerOrganization(request, env);
  let legacyError: Response | null = null;
  let accountId: string | null = null;
  if (!auth.authorized) {
    legacyError = auth.response;
  } else if (auth.organizationId !== organizationId) {
    legacyError = json({ ok: false, error: "forbidden" }, { status: 403 });
  } else {
    // Membership alone must not expose the org-wide backlog: app-delivered
    // events can include private-team payloads a plain member cannot see in
    // Linear. Reads require the same webhook authority as registration.
    const authority = await verifyLinearWebhookAuthority(request, env);
    if (!authority.authorized) legacyError = authority.response;
  }
  if (legacyError) {
    accountId = await authenticateAccount(request, env);
    if (!accountId || !await linearOrganizationAccountMatches(env, organizationId, accountId)) {
      return legacyError;
    }
  }

  const url = new URL(request.url);
  const limit = parseLimit(url);
  const after = url.searchParams.get("after")?.trim() || "";
  const accountPredicate = accountId ? " and account_id = ?" : "";
  const accountBinding = accountId ? [accountId] : [];
  let rows: LinearEventRow[];
  let cursorExpired = false;

  if (after) {
    const sequenceCursor = parseSequenceCursor(after);
    if (sequenceCursor != null) {
      // Cursored reads page OLDEST-first: with desc ordering a page larger
      // than `limit` would advance the cursor past rows it never returned,
      // silently dropping them. Ascending pages + max-seq cursor drain the
      // backlog without gaps.
      rows = (await env.DB
        .prepare(`
          select rowid as event_seq, event_id, event_type, action, received_at, body
            from linear_events
           where org_id = ?${accountPredicate} and rowid > ?
           order by rowid asc
           limit ?
        `)
        .bind(organizationId, ...accountBinding, sequenceCursor, limit)
        .all<LinearEventRow>()).results ?? [];
    } else {
      const cursor = await env.DB
        .prepare(`select rowid as event_seq, event_id from linear_events where org_id = ?${accountPredicate} and event_id = ? limit 1`)
        .bind(organizationId, ...accountBinding, after)
        .first<CursorRow>();
      if (cursor) {
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, event_type, action, received_at, body
              from linear_events
             where org_id = ?${accountPredicate} and rowid > ?
             order by rowid asc
             limit ?
          `)
          .bind(organizationId, ...accountBinding, cursor.event_seq, limit)
          .all<LinearEventRow>()).results ?? [];
      } else {
        cursorExpired = true;
        rows = (await env.DB
          .prepare(`
            select rowid as event_seq, event_id, event_type, action, received_at, body
              from linear_events
             where org_id = ?${accountPredicate}
             order by rowid desc
             limit ?
          `)
          .bind(organizationId, ...accountBinding, limit)
          .all<LinearEventRow>()).results ?? [];
      }
    }
  } else {
    rows = (await env.DB
      .prepare(`
        select rowid as event_seq, event_id, event_type, action, received_at, body
          from linear_events
         where org_id = ?${accountPredicate}
         order by rowid desc
         limit ?
      `)
      .bind(organizationId, ...accountBinding, limit)
      .all<LinearEventRow>()).results ?? [];
  }

  return json({
    events: rows.map(linearRowToEvent),
    nextCursor: nextLinearCursor(rows, after),
    cursorExpired,
  });
}

async function handleAccountIntegrations(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "DELETE") return text("method not allowed", 405);
  const accountId = await authenticateAccount(request, env);
  if (!accountId) return json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (request.method === "DELETE") {
    await env.DB.prepare("update github_app_repositories set unlinked_account_id = account_id, account_id = null where account_id = ?")
      .bind(accountId)
      .run();
    await env.DB.prepare("update github_events set account_id = null where account_id = ?")
      .bind(accountId)
      .run();
    await env.DB.prepare("update linear_organizations set unlinked_account_id = account_id, account_id = null where account_id = ?")
      .bind(accountId)
      .run();
    await env.DB.prepare("update linear_events set account_id = null where account_id = ?")
      .bind(accountId)
      .run();
    return json({ ok: true });
  }

  const repositories = (await env.DB.prepare(`
    select repository_full_name, owner, name, installation_id,
           repository_selection, installed
      from github_app_repositories
     where account_id = ?
     order by repository_full_name collate nocase
  `).bind(accountId).all<AccountRepositoryRow>()).results ?? [];
  const linearOrganizations = (await env.DB.prepare(`
    select org_id
      from linear_organizations
     where account_id = ?
     order by org_id
  `).bind(accountId).all<AccountLinearOrganizationRow>()).results ?? [];
  return json({
    repositories: repositories.map((row) => ({
      owner: row.owner,
      name: row.name,
      fullName: row.repository_full_name,
      installationId: row.installation_id,
      repositorySelection: row.repository_selection,
      installed: row.installed === 1,
    })),
    linearOrganizations: linearOrganizations.map((row) => ({ organizationId: row.org_id })),
  });
}

export async function handleRequest(request: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ ok: true });
  }

  if (url.pathname === "/account/integrations") return await handleAccountIntegrations(request, env);
  if (url.pathname === "/linear/orgs/register") return await handleLinearOrganizationRegister(request, env);
  if (url.pathname === "/linear/webhook") return await handleLinearWebhook(request, env);
  if (url.pathname === "/linear/oauth/callback") return handleLinearOAuthCallback(request);
  const linearOrganizationEvents = routeLinearOrganizationEvents(url.pathname);
  if (linearOrganizationEvents) {
    return await handleListLinearEvents(request, env, linearOrganizationEvents.organizationId);
  }

  const repoWebhookAdmin = routeRepoWebhookAdmin(url.pathname);
  if (repoWebhookAdmin?.action === "heal") return await handleWebhookHeal(request, env, repoWebhookAdmin);
  if (repoWebhookAdmin?.action === "deliveries") return await handleWebhookDeliveries(request, env, repoWebhookAdmin);

  const repoSubscription = routeRepoSubscription(url.pathname);
  if (repoSubscription) return await handleRepoSubscription(request, env, repoSubscription);

  const repoEvents = routeRepoEvents(url.pathname);
  if (repoEvents) return await handleListRepoEvents(request, env, repoEvents);

  const repoStatus = routeRepoStatus(url.pathname);
  if (repoStatus) return await handleRepoStatus(request, env, repoStatus);

  const route = routeProject(url.pathname);
  if (!route?.projectId) return text("not found", 404);
  if (route.action === "webhook") return await handleGitHubWebhook(request, env, route.projectId);
  return await handleListEvents(request, env, route.projectId);
}
