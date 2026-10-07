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
 * True at most once per `intervalMs` for a task on one D1 binding. Workers
 * reuse a binding across requests in an isolate, so this limits sweeps that
 * would otherwise run on every webhook.
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

export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
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
