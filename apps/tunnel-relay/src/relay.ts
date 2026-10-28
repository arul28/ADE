import { TunnelDurableObject } from "./tunnelDo";
import {
  cloudflareTransientKind,
  fetchDurableObject,
  logCloudflareTransient,
  transientUnavailableResponse,
} from "./cloudflareTransient";
import type { SentryEnv } from "./sentry";
import { scrubString } from "./sentryScrub";

export type TunnelRelayEnv = SentryEnv & {
  /** Durable Object namespace; one instance per machineKey via idFromName. */
  TUNNEL: DurableObjectNamespace;
  /** Safe deployment identity exposed by Cloudflare's version metadata binding. */
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** Optional override for the max concurrent tunnels per machine. */
  MAX_TUNNELS_PER_MACHINE?: string;
};

export { TunnelDurableObject };

// A machineKey is an unguessable per-machine identifier the brain generates and
// claims; phones learn it out-of-band (QR). 32-64 hex keeps it copy-paste safe.
export const MACHINE_KEY_PATTERN = /^[a-f0-9]{32,64}$/i;
// Connection ids are minted by the relay, never trusted from a peer; keep them
// short and hex so they round-trip cleanly through the signed pipe path.
export const CONNECTION_ID_PATTERN = /^[a-f0-9]{8,32}$/i;
export const CONTROL_EPOCH_PATTERN = /^[a-f0-9]{32}$/i;
export const SIGNATURE_TIMESTAMP_SKEW_SECONDS = 5 * 60;
export const DEFAULT_MAX_TUNNELS_PER_MACHINE = 16;

const encoder = new TextEncoder();

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Canonical strings every signed WebSocket upgrade commits to. Binding the
 * role, machineKey (and connection id, for pipes) plus a timestamp stops a
 * captured signature from being replayed against a different role/id or after
 * the skew window closes. Identical shape to apps/push-relay's HMAC design.
 */
export function buildHostSignatureBase(machineKey: string, epoch: string, timestamp?: string): string {
  return timestamp == null
    ? `host:${machineKey}:${epoch}`
    : `host:${machineKey}:${epoch}:${timestamp}`;
}

export function buildPipeSignatureBase(machineKey: string, id: string, epoch: string, timestamp?: string): string {
  return timestamp == null
    ? `pipe:${machineKey}:${id}:${epoch}`
    : `pipe:${machineKey}:${id}:${epoch}:${timestamp}`;
}

export function parseTimestampSeconds(raw: string): number | null {
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length === 13 ? Math.floor(numeric / 1000) : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export type SignedQueryResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies a signed WebSocket upgrade: timestamp within skew and the hex HMAC
 * of `base` under `secret` matching `sig`. Pure so it can be unit tested
 * without a live Durable Object.
 */
export async function verifySignedQuery(args: {
  secret: string;
  base: string;
  timestamp: string;
  signature: string;
  nowSeconds?: number;
  skewSeconds?: number;
}): Promise<SignedQueryResult> {
  const { secret, base, timestamp, signature } = args;
  if (!timestamp || !signature) return { ok: false, reason: "missing ts or sig" };
  const timestampSeconds = parseTimestampSeconds(timestamp);
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = args.skewSeconds ?? SIGNATURE_TIMESTAMP_SKEW_SECONDS;
  if (timestampSeconds == null || Math.abs(nowSeconds - timestampSeconds) > skew) {
    return { ok: false, reason: "stale or invalid timestamp" };
  }
  const expected = await hmacSha256Hex(secret, base);
  if (!constantTimeEqual(expected, signature)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

/** 16 hex chars of CSPRNG output — unguessable and matches CONNECTION_ID_PATTERN. */
export function generateConnectionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)).buffer);
}

export type TunnelRoute =
  /**
   * ADE MCP: an HTTP request for a machine's MCP server, forwarded over its
   * control socket. `machineKey` here is the machine's MCP endpoint key, not
   * its relay key (see resolveMcpEndpoint). `path` is what the brain sees.
   */
  | { kind: "mcp"; machineKey: string; path: string }
  /**
   * ADE MCP for a whole ADE account: any of the account's computers with ADE
   * MCP on may answer. `accountKey` (lowercase) names the account object, which
   * lists those computers; `path` is what the brain sees, as for `mcp`.
   */
  | { kind: "mcp-account"; accountKey: string; path: string }
  | { kind: "claim"; machineKey: string }
  | { kind: "host"; machineKey: string }
  | { kind: "pipe"; machineKey: string; id: string }
  | { kind: "connect"; machineKey: string }
  | { kind: "prewarm"; machineKey: string };

/**
 * Pure path router. Returns the matched tunnel route or null; the machineKey
 * pattern is enforced here so an invalid key never reaches a Durable Object.
 */
export function routeTunnelPath(pathname: string): TunnelRoute | null {
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    // Malformed percent-encoding (e.g. "/host/%") — fail closed to a 404.
    return null;
  }
  if (parts.length === 3 && parts[0] === "machines" && parts[2] === "claim") {
    return validKey(parts[1]) ? { kind: "claim", machineKey: parts[1] } : null;
  }
  if (parts.length === 2 && parts[0] === "host") {
    return validKey(parts[1]) ? { kind: "host", machineKey: parts[1] } : null;
  }
  if (parts.length === 4 && parts[0] === "host" && parts[2] === "pipe") {
    return validKey(parts[1]) && CONNECTION_ID_PATTERN.test(parts[3])
      ? { kind: "pipe", machineKey: parts[1], id: parts[3] }
      : null;
  }
  if (parts.length === 2 && parts[0] === "connect") {
    return validKey(parts[1]) ? { kind: "connect", machineKey: parts[1] } : null;
  }
  if (parts.length === 2 && parts[0] === "prewarm") {
    return validKey(parts[1]) ? { kind: "prewarm", machineKey: parts[1] } : null;
  }
  return null;
}

/**
 * ADE MCP routes. Everything under `/m/<machineKey>/` goes to the
 * brain as is. OAuth discovery puts the well-known segment first (RFC 8414 /
 * RFC 9728 path insertion), so `/.well-known/<kind>/m/<key>[/mcp]` maps onto
 * the brain's own `/.well-known/<kind>`.
 */
const MCP_WELL_KNOWN = new Set(["oauth-protected-resource", "oauth-authorization-server", "openid-configuration"]);

export function routeMcpPath(url: URL): TunnelRoute | null {
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts.some((part) => part === "." || part === ".." || part.includes("/") || part.includes("\\"))) return null;
  // ADE sign-in (Clerk) returns every machine's sign-in to this one registered
  // address; the state names the machine before the dot. The brain checks the
  // rest of the state itself.
  if (parts.length === 2 && parts[0] === "oauth" && parts[1] === "callback") {
    const state = url.searchParams.get("state") ?? "";
    const machineKey = state.slice(0, state.indexOf("."));
    if (!validKey(machineKey)) return null;
    return { kind: "mcp", machineKey, path: `/oauth/account-callback${url.search}` };
  }
  if (parts.length >= 2 && parts[0] === "m") {
    if (!validKey(parts[1])) return null;
    const rest = parts.slice(2);
    return { kind: "mcp", machineKey: parts[1], path: `/${rest.map(encodeURIComponent).join("/")}${url.search}` };
  }
  if (parts.length >= 4 && parts[0] === ".well-known" && MCP_WELL_KNOWN.has(parts[1]!) && parts[2] === "m") {
    if (!validKey(parts[3])) return null;
    const suffix = parts.slice(4);
    return {
      kind: "mcp",
      machineKey: parts[3],
      path: `/.well-known/${parts[1]}${suffix.length ? `/${suffix.map(encodeURIComponent).join("/")}` : ""}${url.search}`,
    };
  }
  // The account address: the same shapes with `a/<accountKey>` in place of
  // `m/<endpointKey>`.
  if (parts.length >= 2 && parts[0] === "a") {
    if (!validKey(parts[1])) return null;
    const rest = parts.slice(2);
    return {
      kind: "mcp-account",
      accountKey: parts[1].toLowerCase(),
      path: `/${rest.map(encodeURIComponent).join("/")}${url.search}`,
    };
  }
  if (parts.length >= 4 && parts[0] === ".well-known" && MCP_WELL_KNOWN.has(parts[1]!) && parts[2] === "a") {
    if (!validKey(parts[3])) return null;
    const suffix = parts.slice(4);
    return {
      kind: "mcp-account",
      accountKey: parts[3].toLowerCase(),
      path: `/.well-known/${parts[1]}${suffix.length ? `/${suffix.map(encodeURIComponent).join("/")}` : ""}${url.search}`,
    };
  }
  return null;
}

/** Either ADE MCP route: answered with MCP_CORS_HEADERS, OPTIONS by the Worker. */
export function isMcpRoute(route: TunnelRoute | null): route is Extract<TunnelRoute, { kind: "mcp" | "mcp-account" }> {
  return route?.kind === "mcp" || route?.kind === "mcp-account";
}

/** CORS for ADE MCP: browser-based MCP clients call it cross-origin. */
export const MCP_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};

function validKey(value: string | undefined): value is string {
  return typeof value === "string" && MACHINE_KEY_PATTERN.test(value);
}

/** The regions Cloudflare accepts as a Durable Object placement hint. */
export type RelayLocationHint = DurableObjectLocationHint;

/**
 * The subset of `request.cf` this router reads, kept looser than Cloudflare's
 * own types: `wrangler dev` omits `cf` entirely and miniflare will hand back
 * whatever a test supplies.
 */
export type RequestPlacementGeo = {
  continent?: string | null;
  longitude?: string | number | null;
};

function parseLongitude(raw: unknown): number | null {
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(value) && value >= -180 && value <= 180 ? value : null;
}

/**
 * Maps the requester's coarse geography onto a Durable Object location hint.
 * Only the machine's own routes (claim/host) supply one: a Durable Object is
 * placed near whichever request creates it, so without a hint a phone that
 * connects before the brain claims would pin the object next to the phone for
 * the life of the machine key. Cloudflare ignores the hint for an object that
 * already exists, so this only steers brand-new machines.
 */
export function locationHintForGeo(
  geo: RequestPlacementGeo | null | undefined,
): RelayLocationHint | undefined {
  const continent = typeof geo?.continent === "string" ? geo.continent.trim().toUpperCase() : "";
  const longitude = parseLongitude(geo?.longitude);
  // Three continents span more than one Cloudflare region: the Americas and
  // Europe split east/west, and western Asia is served by `me`. Each falls back
  // to its most populous region when the longitude is missing.
  switch (continent) {
    case "NA":
      return longitude != null && longitude <= -100 ? "wnam" : "enam";
    case "SA":
      return "sam";
    case "EU":
      return longitude != null && longitude >= 20 ? "eeur" : "weur";
    case "AF":
      return "afr";
    case "OC":
      return "oc";
    case "AS":
      return longitude != null && longitude < 65 ? "me" : "apac";
    default:
      // Unknown or absent geography: let Cloudflare place the object itself.
      return undefined;
  }
}

/**
 * ADE MCP addresses use an endpoint key, never the relay key: the URL is given
 * to outside AI apps, and the relay key would let its holder open `/connect`
 * tunnels and use up a machine's phone slots. The brain derives the endpoint
 * key from its relay secret and registers it over its signed control socket;
 * the object named `mcp-endpoint:<key>` remembers which machine it belongs to
 * (first writer wins). The mapping never changes, so it is cached per isolate.
 */
export const MCP_ENDPOINT_PATH = "/__mcp-endpoint";
const MAX_CACHED_ENDPOINTS = 1_000;
const endpointCache = new Map<string, string>();

export function mcpEndpointObjectName(endpointKey: string): string {
  return `mcp-endpoint:${endpointKey.toLowerCase()}`;
}

async function resolveMcpEndpoint(env: TunnelRelayEnv, endpointKey: string): Promise<string | null> {
  const cached = endpointCache.get(endpointKey);
  if (cached) return cached;
  const id = env.TUNNEL.idFromName(mcpEndpointObjectName(endpointKey));
  const response = await fetchDurableObject(
    () => env.TUNNEL.get(id),
    new Request(`https://relay.internal${MCP_ENDPOINT_PATH}`),
  );
  if (!response.ok) return null;
  const machineKey = ((await response.json()) as { machineKey?: unknown }).machineKey;
  if (typeof machineKey !== "string" || !validKey(machineKey)) return null;
  if (endpointCache.size >= MAX_CACHED_ENDPOINTS) endpointCache.clear();
  endpointCache.set(endpointKey, machineKey);
  return machineKey;
}

/**
 * ADE MCP for an account. The brain sends its account secret in `mcp_state`;
 * the relay derives the public account key from it (never trusting a key the
 * brain names) and the object named `mcp-account:<accountKey>` lists the
 * machines (relay keys) that serve it. Its internal paths are reached only from
 * inside this Worker: the public routers never produce them.
 */
export const MCP_ACCOUNT_PATH = "/__mcp-account";
export const MCP_ACCOUNT_FRONT_PATH = "/__mcp-account/front";
export const MCP_ACCOUNT_MAX_MEMBERS = 32;
/**
 * Set by the Worker on an account request it forwards to a machine object,
 * after dropping any copy the client sent. Never sent on to the brain: the
 * machine object turns it into the `http` message's `mount`.
 */
export const MCP_MOUNT_HEADER = "x-ade-mcp-mount";
/**
 * Set by a machine object on an account request it refused before the brain
 * could see it (`offline` or `ade_mcp_off`), so the Worker may try the next
 * computer. Never returned to a client.
 */
export const MCP_UNDELIVERED_HEADER = "x-ade-mcp-undelivered";
export const MCP_MAX_REQUEST_BYTES = 1024 * 1024;
// 32 random bytes in base64url is 43 characters; allow optional padding and
// longer secrets, never a short or non-base64url one.
const MCP_ACCOUNT_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}={0,2}$/;

export function mcpAccountObjectName(accountKey: string): string {
  return `mcp-account:${accountKey.toLowerCase()}`;
}

/**
 * The account key for an account secret, or null for a secret of the wrong
 * shape: hex(HMAC-SHA256(utf8(secret), "ade-mcp-account")), first 40 chars.
 */
export async function mcpAccountKeyForSecret(secret: unknown): Promise<string | null> {
  if (typeof secret !== "string" || !MCP_ACCOUNT_SECRET_PATTERN.test(secret)) return null;
  return (await hmacSha256Hex(secret, "ade-mcp-account")).slice(0, 40);
}

export type McpAccountState = { members: string[]; front: string | null };

/** Machines to try for an account request: the front first, then newest-first. */
export function mcpAccountCandidates(state: McpAccountState): string[] {
  const newestFirst = [...state.members].reverse();
  if (!state.front || !newestFirst.includes(state.front)) return newestFirst;
  return [state.front, ...newestFirst.filter((key) => key !== state.front)];
}

export function mcpErrorResponse(
  status: number,
  error: string,
  description: string,
  extra: Record<string, string> = {},
): Response {
  return jsonResponse(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store", ...MCP_CORS_HEADERS, ...extra } },
  );
}

/** The request body, or null once it passes `maxBytes` (read as a stream). */
async function readBytesCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

const MCP_ACCOUNT_OFF_DESCRIPTION =
  "ADE MCP is off for this account. Turn it on in ADE Settings → ADE MCP on one of your computers.";
const MCP_ACCOUNT_OFFLINE_DESCRIPTION =
  "None of your computers with ADE MCP on are online. Open ADE on one of them, or try again shortly.";

/**
 * An account request. Each computer on the account is tried in turn (the one
 * that last answered first, then the newest), and the next is tried only when
 * a machine object refused before its brain could see the request (offline,
 * or ADE MCP off there). Any other answer is final: a request a brain may have
 * received is never sent to a second one. The body is buffered (1 MiB cap) so
 * it can be resent.
 */
async function handleAccountMcp(
  request: Request,
  env: TunnelRelayEnv,
  accountKey: string,
  ctx: WaitUntil | undefined,
): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_REQUEST_BYTES) {
    return mcpErrorResponse(413, "too_large", "Request too large.");
  }
  // Only a POST body ever reaches the brain; the machine object answers other
  // methods without reading theirs.
  let body: ArrayBuffer | null = null;
  if (request.method === "POST" && request.body) {
    body = await readBytesCapped(request.body, MCP_MAX_REQUEST_BYTES);
    if (body === null) return mcpErrorResponse(413, "too_large", "Request too large.");
  }

  const accountId = env.TUNNEL.idFromName(mcpAccountObjectName(accountKey));
  const stateResponse = await fetchDurableObject(
    () => env.TUNNEL.get(accountId),
    new Request(`https://relay.internal${MCP_ACCOUNT_PATH}`),
  );
  if (!stateResponse.ok) return transientUnavailableResponse(MCP_CORS_HEADERS);
  const state = (await stateResponse.json()) as McpAccountState;
  const candidates = mcpAccountCandidates(state);

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set(MCP_MOUNT_HEADER, `a/${accountKey}`);
  let sawOffline = false;
  for (const machineKey of candidates) {
    if (!validKey(machineKey)) continue;
    const id = env.TUNNEL.idFromName(machineKey);
    const forwarded = new Request(request.url, { method: request.method, headers, body });
    // May reach a brain: never sent twice, whatever its method.
    const response = await fetchDurableObject(() => env.TUNNEL.get(id), forwarded, { retry: "never" });
    const undelivered = response.headers.get(MCP_UNDELIVERED_HEADER);
    if ((response.status === 503 && undelivered === "offline") || (response.status === 404 && undelivered === "ade_mcp_off")) {
      if (undelivered === "offline") sawOffline = true;
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (machineKey !== state.front) {
      const recordFront = fetchDurableObject(
        () => env.TUNNEL.get(accountId),
        new Request(`https://relay.internal${MCP_ACCOUNT_FRONT_PATH}`, {
          method: "POST",
          body: JSON.stringify({ machineKey }),
        }),
        { retry: "replayable" },
      ).then((answer) => answer.body?.cancel(), () => undefined);
      if (ctx) ctx.waitUntil(recordFront);
    }
    return response;
  }
  return sawOffline
    ? mcpErrorResponse(503, "offline", MCP_ACCOUNT_OFFLINE_DESCRIPTION, { "retry-after": "30" })
    : mcpErrorResponse(404, "ade_mcp_off", MCP_ACCOUNT_OFF_DESCRIPTION);
}

/**
 * Durable Objects restart under Cloudflare now and then ("storage is no longer
 * accessible", "instance is no longer active", "internal error; reference =
 * …"). A request that can be sent twice gets one more try on a fresh stub
 * (`fetchDurableObject`); anything still failing, including every WebSocket
 * upgrade, is answered 503 with Retry-After instead of an unhandled 500. The
 * brain's control socket and the phone both reconnect on a failed upgrade with
 * their usual backoff, whatever its status.
 */
export async function handleRequest(request: Request, env: TunnelRelayEnv, ctx?: WaitUntil): Promise<Response> {
  try {
    return await routeRequest(request, env, ctx);
  } catch (error) {
    const kind = cloudflareTransientKind(error);
    if (!kind) throw error;
    const url = new URL(request.url);
    logCloudflareTransient("ade-tunnel-relay", kind, scrubString(url.pathname), error);
    const mcp = isMcpRoute(routeTunnelPath(url.pathname) ?? routeMcpPath(url));
    return transientUnavailableResponse(mcp ? MCP_CORS_HEADERS : {});
  }
}

async function routeRequest(request: Request, env: TunnelRelayEnv, ctx?: WaitUntil): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    const { id, tag, timestamp } = env.CF_VERSION_METADATA;
    return jsonResponse({
      ok: true,
      service: "ade-tunnel-relay",
      protocolVersion: 2,
      workerVersion: { id, tag, timestamp },
    });
  }

  const route = routeTunnelPath(url.pathname) ?? routeMcpPath(url);
  if (!route) return textResponse("not found", 404);
  if (isMcpRoute(route) && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
  }
  // The mount header is the Worker's own; a client's copy never goes further.
  if (isMcpRoute(route) && request.headers.has(MCP_MOUNT_HEADER)) {
    const headers = new Headers(request.headers);
    headers.delete(MCP_MOUNT_HEADER);
    request = new Request(request, { headers });
  }
  if (route.kind === "mcp-account") return await handleAccountMcp(request, env, route.accountKey, ctx);
  if (route.kind === "mcp") {
    const machineKey = await resolveMcpEndpoint(env, route.machineKey);
    if (!machineKey) {
      return jsonResponse(
        { error: "ade_mcp_off", error_description: "ADE MCP is off on that computer. Turn it on in ADE Settings → ADE MCP." },
        { status: 404, headers: { "cache-control": "no-store", ...MCP_CORS_HEADERS } },
      );
    }
    // An MCP call is forwarded to the brain and may run a tool or open a
    // stream, whatever its method: never sent twice.
    const id = env.TUNNEL.idFromName(machineKey);
    return await fetchDurableObject(() => env.TUNNEL.get(id), request, { retry: "never" });
  }

  // Every route is scoped to a single machine → a single Durable Object
  // instance. The DO owns the claim secret, signature verification, and the
  // per-connection socket pairing; the worker is a thin, stateless router.
  const id = env.TUNNEL.idFromName(route.machineKey);
  // Only the machine's own routes may influence placement — a travelling phone
  // must never drag a machine's object across the planet.
  const locationHint = route.kind === "claim" || route.kind === "host"
    ? locationHintForGeo((request as { cf?: RequestPlacementGeo | null }).cf)
    : undefined;
  // A claim stores the secret first-writer-wins, so sending it twice is safe.
  return await fetchDurableObject(
    () => (locationHint ? env.TUNNEL.get(id, { locationHint }) : env.TUNNEL.get(id)),
    request,
    route.kind === "claim" ? { retry: "replayable" } : {},
  );
}
