// Leaf helpers shared by the relay router modules. Imports nothing local.

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
  /** Signing secret of a second Linear OAuth app whose deliveries are also accepted. */
  LINEAR_APP_WEBHOOK_SECRET_ALT?: string;
  /** Comma-separated public Clerk OAuth client ids accepted besides CLERK_OAUTH_CLIENT_ID. */
  CLERK_EXTRA_OAUTH_CLIENT_IDS?: string;
  /**
   * Comma-separated https origins a custom webhook may forward to, besides
   * ADE's own account directories (`HOOK_FORWARD_ORIGINS` in customHooks.ts).
   * Unset in production; for a local directory in development.
   */
  HOOK_FORWARD_ORIGINS?: string;
  /**
   * The account directories, over service bindings. A Worker can't fetch
   * another Worker of the same account on workers.dev (error 1042), so a
   * forward goes through the binding of its URL's origin
   * (`ACCOUNT_DIRECTORY` the default `ade-account-directory`,
   * `ACCOUNT_DIRECTORY_PRODUCTION` `ade-account-directory-production`).
   * A binding ignores the URL's host, so it is never used for another origin.
   */
  ACCOUNT_DIRECTORY?: { fetch: typeof fetch };
  ACCOUNT_DIRECTORY_PRODUCTION?: { fetch: typeof fetch };
  /**
   * Optional worker-level Cursor Cloud webhook signing secret. Tried before
   * per-account secrets registered in D1. Cursor signs with HMAC-SHA256 of the
   * raw body as `X-Webhook-Signature: sha256=<hex>`.
   */
  CURSOR_WEBHOOK_SECRET?: string;
  /**
   * Base64 32-byte AES-GCM key that encrypts Linear agent (actor=app) tokens
   * at rest. Without it the Linear agent routes answer 503 agent_not_configured.
   */
  LINEAR_AGENT_TOKEN_KEY?: string;
  /** Public (PKCE) client id of the ADE Linear app, used to refresh app tokens. */
  LINEAR_APP_CLIENT_ID?: string;
};

export type CursorRow = {
  event_seq: number;
  event_id: string;
};

export type AccountMappingRow = {
  account_id: string | null;
};

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
export const DEFAULT_RETENTION_DAYS = 7;

const lastRunByTask = new WeakMap<object, Map<string, number>>();

/**
 * True at most once per `intervalMs` for a task on one D1 binding, within one
 * isolate. Best effort only: a new isolate or binding object runs the task
 * again, so every throttled query must still be an index seek on its own.
 */
export function claimPeriodicRun(db: object, task: string, intervalMs: number): boolean {
  let byTask = lastRunByTask.get(db);
  if (!byTask) {
    byTask = new Map();
    lastRunByTask.set(db, byTask);
  }
  const now = Date.now();
  if (now - (byTask.get(task) ?? Number.NEGATIVE_INFINITY) < intervalMs) return false;
  byTask.set(task, now);
  return true;
}
export const encoder = new TextEncoder();
export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Subscribe routes accept only a GET that asks for a websocket upgrade. */
export function requireWebSocketUpgrade(request: Request): Response | null {
  if (request.method !== "GET") return text("method not allowed", 405);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return text("expected websocket", 426);
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function contentLengthExceedsLimit(headers: Headers, limit: number): boolean {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(limit);
  } catch {
    return true;
  }
}

const HEXTET = /^[0-9a-f]{1,4}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  const bare = address.trim().toLowerCase().split("%")[0]!;
  if (!bare.includes(":")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const split = (part: string): string[] => (part ? part.split(":") : []);
  const head = split(halves[0]!);
  const tail = halves.length === 2 ? split(halves[1]!) : [];
  // An embedded IPv4 tail (`::ffff:192.0.2.1`) is the last two groups.
  const last = halves.length === 2 ? tail : head;
  const dotted = last.length ? IPV4.exec(last[last.length - 1]!) : null;
  const trailing: number[] = [];
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    last.pop();
    trailing.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
  }
  const written = head.length + tail.length + trailing.length;
  const missing = 8 - written;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!parts.every((part) => HEXTET.test(part))) return null;
  return [...parts.map((part) => parseInt(part, 16)), ...trailing];
}

/**
 * The address a per-caller quota counts, with an IPv6 address cut to its /64.
 * One IPv6 customer is routinely handed a whole /64, so keying on the full
 * address would give a single machine 2^64 fresh quotas. An IPv4 address, and
 * anything that is not an address (`unknown`), is returned unchanged.
 * Keep in step with apps/account-directory/src/sinkUtils.ts, which has the
 * same parser for its own Worker.
 */
export function quotaAddress(address: string): string {
  const groups = ipv6Groups(address);
  if (!groups) return address;
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * Reads the request body, stopping as soon as it would exceed `maxBytes` and
 * returning null so the caller can answer 413. A chunked body carries no
 * content-length to trust, so the cap is enforced on the bytes as they arrive
 * instead of buffering the whole body first. GET stays an empty body.
 */
export async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.method === "GET" || !request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function readString(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function readNested(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

export function readBoolean(source: Record<string, unknown> | null | undefined, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === "boolean" ? value : null;
}

export function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

export async function sha256Hex(value: string | BufferSource): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
}

export function parseLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? DEFAULT_EVENT_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_EVENT_LIMIT;
  return Math.max(1, Math.min(MAX_EVENT_LIMIT, Math.trunc(raw)));
}

export function evictExpiredCacheEntries<T extends { expiresAt: number }>(map: Map<string, T>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const now = Date.now();
  for (const [candidateKey, entry] of map) {
    if (entry.expiresAt <= now) map.delete(candidateKey);
  }
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) break;
    map.delete(oldest);
  }
}

export function parseSequenceCursor(after: string): number | null {
  const match = /^seq:(\d+)$/i.exec(after.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// GitHub-style `sha256=<hex>` HMAC webhook signatures (GitHub and Cursor).
export function hasValidGitHubSignatureShape(signature: string): boolean {
  return /^sha256=[0-9a-f]{64}$/i.test(signature);
}

export async function signGitHubWebhookBody(secret: string, body: string | BufferSource): Promise<string> {
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


export async function verifyGitHubSignature(secret: string, body: BufferSource, signature: string): Promise<boolean> {
  if (!secret.trim()) return false;
  if (!signature.startsWith("sha256=")) return false;
  const expected = await signGitHubWebhookBody(secret, body);
  return constantTimeEqual(expected, signature);
}

