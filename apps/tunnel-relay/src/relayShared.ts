import type { SentryEnv } from "./sentry";

/**
 * Leaf helpers shared by the Worker (relay.ts) and the Durable Object
 * (tunnelDo.ts and its MCP modules). Imports nothing from either, so the
 * Durable Object side never depends on the Worker entry point.
 */

export type TunnelRelayEnv = SentryEnv & {
  /** Durable Object namespace; one instance per machineKey via idFromName. */
  TUNNEL: DurableObjectNamespace;
  /** Safe deployment identity exposed by Cloudflare's version metadata binding. */
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** Optional override for the max concurrent tunnels per machine. */
  MAX_TUNNELS_PER_MACHINE?: string;
};

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

/**
 * Structured single-line log. View live with `wrangler tail ade-tunnel-relay`,
 * or in the dashboard (observability enabled in wrangler.jsonc). Only lifecycle
 * and rejection events are logged — never per-frame — so a busy tunnel stays
 * cheap and the stream stays diagnosable.
 */
export function logTunnel(kind: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-tunnel-relay", kind, ...fields }));
  } catch {
    console.log(`ade-tunnel-relay ${kind}`);
  }
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
  const machine = mcpMountRoute(parts, "m", url.search);
  if (machine) return { kind: "mcp", machineKey: machine.key, path: machine.path };
  // The account address: the same shapes with `a/<accountKey>` in place of
  // `m/<endpointKey>`.
  const account = mcpMountRoute(parts, "a", url.search);
  if (account) return { kind: "mcp-account", accountKey: account.key.toLowerCase(), path: account.path };
  return null;
}

/**
 * `/<prefix>/<key>/<rest>` → brain path `/<rest>`, and
 * `/.well-known/<kind>/<prefix>/<key>[/<suffix>]` → `/.well-known/<kind>[/<suffix>]`.
 */
function mcpMountRoute(parts: string[], prefix: "m" | "a", search: string): { key: string; path: string } | null {
  const encode = (segments: string[]): string => segments.map(encodeURIComponent).join("/");
  if (parts.length >= 2 && parts[0] === prefix) {
    return validKey(parts[1]) ? { key: parts[1], path: `/${encode(parts.slice(2))}${search}` } : null;
  }
  if (parts.length >= 4 && parts[0] === ".well-known" && MCP_WELL_KNOWN.has(parts[1]!) && parts[2] === prefix) {
    if (!validKey(parts[3])) return null;
    const suffix = parts.slice(4);
    return { key: parts[3], path: `/.well-known/${parts[1]}${suffix.length ? `/${encode(suffix)}` : ""}${search}` };
  }
  return null;
}

/** CORS for ADE MCP: browser-based MCP clients call it cross-origin. */
export const MCP_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};

export function validKey(value: string | undefined): value is string {
  return typeof value === "string" && MACHINE_KEY_PATTERN.test(value);
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
export function mcpEndpointObjectName(endpointKey: string): string {
  return `mcp-endpoint:${endpointKey.toLowerCase()}`;
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

export const MCP_MACHINE_OFF_DESCRIPTION =
  "ADE MCP is off on that computer. Turn it on in ADE Settings → ADE MCP.";
export const MCP_MACHINE_OFFLINE_DESCRIPTION = "That computer is offline, or ADE isn't running on it.";

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

/**
 * A request body's bytes, or null once it passes `maxBytes`. Read as a stream,
 * so a body with no content-length (chunked) is never buffered whole.
 */
export async function readBytesCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<ArrayBuffer | null> {
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
