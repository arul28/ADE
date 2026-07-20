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
}

type MachineRow = {
  user_id: string;
  machine_key: string;
  device_id: string | null;
  name: string | null;
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
  name: string;
  platform: string;
  deviceType: string;
  pubkey: string | null;
  reachableEndpoints: ReachableEndpoint[];
};

type MachineRecord = {
  machineKey: string;
  deviceId: string | null;
  name: string | null;
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
  | { kind: "delete"; machineKey: string };

export const DEFAULT_ONLINE_WINDOW_MS = 90_000;
const remoteJwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

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
  const name = requiredString(value, "name");
  const platform = requiredString(value, "platform");
  const deviceType = requiredString(value, "deviceType");
  const pubkey = optionalString(value, "pubkey");
  const reachableEndpoints = parseReachableEndpoints(value.reachableEndpoints);
  if (!machineKey || !deviceId || !name || !platform || !deviceType || pubkey === undefined || !reachableEndpoints) {
    return null;
  }
  return { machineKey, deviceId, name, platform, deviceType, pubkey, reachableEndpoints };
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

export async function verifyCallerToken(token: string, env: Env): Promise<string> {
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
  return payload.sub;
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
  | { ok: true; userId: string }
  | { ok: false; reason: CallerTokenFailureReason };

async function authenticate(
  request: Request,
  env: Env,
): Promise<CallerAuthenticationResult> {
  const token = readBearerToken(request);
  if (!token) return { ok: false, reason: "missing bearer token" };
  try {
    return { ok: true, userId: await verifyCallerToken(token, env) };
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
    return machineKey ? { kind: "delete", machineKey } : null;
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

async function handleRegister(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid request body" }, { status: 400 });
  }
  const input = parseRegisterInput(raw);
  if (!input) return json({ error: "invalid request body" }, { status: 400 });

  const now = Date.now();
  await env.DB.prepare(`
    insert into machines (
      user_id, machine_key, device_id, name, platform, device_type, pubkey,
      reachable_endpoints, last_seen_at, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(user_id, machine_key) do update set
      device_id = excluded.device_id,
      name = excluded.name,
      platform = excluded.platform,
      device_type = excluded.device_type,
      pubkey = excluded.pubkey,
      reachable_endpoints = excluded.reachable_endpoints,
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
    now,
    now,
  ).run();

  const row = await env.DB.prepare(`
    select user_id, machine_key, device_id, name, platform, device_type, pubkey,
           reachable_endpoints, last_seen_at, created_at
      from machines
     where user_id = ? and machine_key = ?
  `).bind(userId, input.machineKey).first<MachineRow>();
  if (!row) return json({ error: "machine was not stored" }, { status: 500 });
  return json(machineRecord(row));
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
    select user_id, machine_key, device_id, name, platform, device_type, pubkey,
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

async function handleDelete(
  request: Request,
  env: Env,
  userId: string,
  machineKey: string,
): Promise<Response> {
  if (request.method !== "DELETE") return text("method not allowed", 405);
  await env.DB.prepare("delete from machines where user_id = ? and machine_key = ?")
    .bind(userId, machineKey)
    .run();
  return json({ ok: true, machineKey });
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
  headers.set("access-control-expose-headers", "Server-Timing");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleRequestCore(
  request: Request,
  env: Env,
  options: DeviceAuthorizationRequestOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return request.method === "GET" ? json({ ok: true }) : text("method not allowed", 405);
  }

  const deviceResponse = await handleDeviceAuthorizationRequest(request, env, options);
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

  if (route.kind === "register") return await handleRegister(request, env, userId);
  if (route.kind === "list") return await handleList(request, env, userId, authDurationMs);
  return await handleDelete(request, env, userId, route.machineKey);
}

export async function handleRequest(
  request: Request,
  env: Env,
  options: DeviceAuthorizationRequestOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedWebClientOrigin(env);
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin
    ? allowedOrigin
    : null;
  if (request.method === "OPTIONS") {
    const route = routeAccount(url.pathname);
    if (!route || route.kind !== "list") return text("not found", 404);
    if (!corsOrigin) return text("origin not allowed", 403);
    if (request.headers.get("access-control-request-method")?.toUpperCase() !== "GET") {
      return text("method not allowed", 405);
    }
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedHeaders.some((header) => header !== "authorization")) {
      return text("headers not allowed", 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  // Daemon/native callers omit Origin. Browser callers must match the one
  // configured hosted client exactly; reject hostile origins before auth or D1.
  if (requestOrigin && routeAccount(url.pathname) && !corsOrigin) {
    return text("origin not allowed", 403);
  }
  const response = await handleRequestCore(request, env, options);
  return corsOrigin ? withCors(response, corsOrigin) : response;
}
