// Custom webhooks: a public "doorbell" URL for any sender (Stripe, Sentry,
// Vercel, a cron job, a plain curl). The relay is a mailbox, not a judge:
//
//   * It checks only the URL token (stored as a SHA-256 hash), never a
//     signature. The signing secret stays on the machine that runs the
//     automation, which verifies it before anything starts.
//   * It holds each delivery until the owning ADE account drains it, so a
//     sleeping laptop loses nothing. ADE acknowledges each one by id once it
//     has processed it, which deletes it, so the relay keeps only undelivered
//     requests, for at most HOOK_HOLD_DAYS.
//   * A hibernating topic object sends a wake-up hint per delivery; D1 stays
//     the durable stream.

import { authenticateAccount } from "./auth";
import { subscribeLinearTopic } from "./linearAgent";
import { notifyLinearTopic, runAfterResponse } from "./linearAgentCore";
import {
  base64Encode,
  constantTimeEqual,
  contentLengthExceedsLimit,
  isRecord,
  json,
  parseLimit,
  readString,
  requireWebSocketUpgrade,
  sha256Hex,
  text,
  type RelayEnv,
} from "./shared";

export const MAX_CUSTOM_HOOK_BODY_BYTES = 1024 * 1024;
const MAX_CUSTOM_HOOK_REGISTRATION_BYTES = 8 * 1024;
/** Undelivered requests per hook. Beyond this the sender gets 503 inbox_full. */
export const MAX_HELD_REQUESTS_PER_HOOK = 200;
/** Hooks one account may register. */
const MAX_HOOKS_PER_ACCOUNT = 100;
export const HOOK_HOLD_DAYS = 3;
const MIN_HOOK_TOKEN_LENGTH = 32;
const MAX_HOOK_TOKEN_LENGTH = 128;
const HOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const ACCEPTED_METHODS = new Set(["GET", "POST", "PUT", "PATCH"]);
/** Never stored or forwarded: transport, proxy and cookie headers. */
const DROPPED_HEADER_PREFIXES = ["cf-", "x-forwarded-", "proxy-"];
const DROPPED_HEADERS = new Set([
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-real-ip",
  "true-client-ip",
  "cdn-loop",
]);

type CustomHookRow = {
  hook_id: string;
  account_id: string;
  token_hash: string;
};

type CustomHookEventRow = {
  event_seq: number;
  event_id: string;
  hook_id: string;
  method: string;
  query: string;
  headers_json: string;
  body: string;
  body_encoding: string;
  received_at: string;
};

export function hookTopic(accountId: string): string {
  return `hooks-account:${accountId}`;
}

/** `/hooks/:hookId/:token` — two segments, so it never collides with the account routes. */
export function routeCustomHookDelivery(pathname: string): { hookId: string; token: string } | null {
  const match = /^\/hooks\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return { hookId: decodeURIComponent(match[1]!), token: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

function keepHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (DROPPED_HEADERS.has(lower)) return false;
  return !DROPPED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function decodeBody(bytes: Uint8Array): { body: string; encoding: "utf8" | "base64" } {
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return { body: base64Encode(bytes), encoding: "base64" };
  }
}

/**
 * Reads the request body, stopping as soon as it would exceed `maxBytes` and
 * returning null so the caller can answer 413. A chunked body carries no
 * content-length to trust, so the cap is enforced on the bytes as they arrive
 * instead of buffering the whole body first. GET stays an empty body.
 */
async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<Uint8Array | null> {
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

async function pruneExpiredHookEvents(env: RelayEnv): Promise<void> {
  const cutoff = new Date(Date.now() - HOOK_HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("delete from custom_hook_events where received_at < ?").bind(cutoff).run();
}

/**
 * The public doorbell. Answers 404 for an unknown hook and a wrong token alike,
 * so the URL space does not reveal which hooks exist.
 */
export async function handleCustomHookDelivery(
  request: Request,
  env: RelayEnv,
  route: { hookId: string; token: string },
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!ACCEPTED_METHODS.has(request.method)) return text("not found", 404);
  const notFound = () => json({ ok: false, error: "not_found" }, { status: 404 });
  if (!HOOK_ID_PATTERN.test(route.hookId) || route.token.length < MIN_HOOK_TOKEN_LENGTH) return notFound();

  const hook = await env.DB
    .prepare("select hook_id, account_id, token_hash from custom_hooks where hook_id = ? limit 1")
    .bind(route.hookId)
    .first<CustomHookRow>();
  const presentedHash = await sha256Hex(route.token);
  if (!hook || !constantTimeEqual(presentedHash, hook.token_hash)) return notFound();

  if (contentLengthExceedsLimit(request.headers, MAX_CUSTOM_HOOK_BODY_BYTES)) {
    return json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  const bytes = await readBodyWithinLimit(request, MAX_CUSTOM_HOOK_BODY_BYTES);
  if (!bytes) {
    return json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  const held = await env.DB
    .prepare("select count(*) as held from custom_hook_events where hook_id = ?")
    .bind(hook.hook_id)
    .first<{ held: number }>();
  if (Number(held?.held ?? 0) >= MAX_HELD_REQUESTS_PER_HOOK) {
    return json({ ok: false, error: "inbox_full" }, { status: 503, headers: { "retry-after": "300" } });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (keepHeader(name)) headers[name.toLowerCase()] = value;
  });
  const { body, encoding } = decodeBody(bytes);
  const eventId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const query = new URL(request.url).search.replace(/^\?/, "");
  await env.DB
    .prepare(`
      insert into custom_hook_events(event_id, hook_id, account_id, method, query, headers_json, body, body_encoding, received_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(eventId, hook.hook_id, hook.account_id, request.method, query, JSON.stringify(headers), body, encoding, receivedAt)
    .run();

  await runAfterResponse(ctx, async () => {
    await Promise.all([
      notifyLinearTopic(env, hookTopic(hook.account_id), { t: "hook_delivery" }),
      pruneExpiredHookEvents(env),
    ]);
  });
  // 202 before ADE runs anything: senders with short timeouts are never held up.
  return json({ ok: true, queued: true, deliveryId: eventId }, { status: 202 });
}

/**
 * POST registers or rotates a hook (the token is replaced; the old URL stops
 * working at once). DELETE removes it with everything it still holds.
 */
export async function handleCustomHookRegister(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") return text("method not allowed", 405);
  const accountId = await authenticateAccount(request, env);
  if (!accountId) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (contentLengthExceedsLimit(request.headers, MAX_CUSTOM_HOOK_REGISTRATION_BYTES)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid payload");
    payload = parsed;
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const hookId = readString(payload, "hookId");
  if (!HOOK_ID_PATTERN.test(hookId)) return json({ ok: false, error: "hookId is invalid" }, { status: 400 });

  const existing = await env.DB
    .prepare("select hook_id, account_id, token_hash from custom_hooks where hook_id = ? limit 1")
    .bind(hookId)
    .first<CustomHookRow>();
  if (existing && existing.account_id !== accountId) {
    // Same answer as "absent" for delete, a conflict for create: hook ids are random,
    // so a collision means someone is probing.
    return json({ ok: false, error: "hook belongs to another account" }, { status: 409 });
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("delete from custom_hook_events where hook_id = ? and account_id = ?").bind(hookId, accountId).run();
    await env.DB.prepare("delete from custom_hooks where hook_id = ? and account_id = ?").bind(hookId, accountId).run();
    return json({ ok: true, removed: Boolean(existing) });
  }

  const token = readString(payload, "token");
  if (token.length < MIN_HOOK_TOKEN_LENGTH || token.length > MAX_HOOK_TOKEN_LENGTH) {
    return json({ ok: false, error: `token must be ${MIN_HOOK_TOKEN_LENGTH}-${MAX_HOOK_TOKEN_LENGTH} characters` }, { status: 400 });
  }
  if (!existing) {
    const owned = await env.DB
      .prepare("select count(*) as owned from custom_hooks where account_id = ?")
      .bind(accountId)
      .first<{ owned: number }>();
    if (Number(owned?.owned ?? 0) >= MAX_HOOKS_PER_ACCOUNT) {
      return json({ ok: false, error: "too many webhooks on this account" }, { status: 429 });
    }
  }
  const label = readString(payload, "label").slice(0, 120) || null;
  const now = new Date().toISOString();
  await env.DB
    .prepare(`
      insert into custom_hooks(hook_id, account_id, token_hash, label, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(hook_id) do update set
        token_hash = excluded.token_hash,
        label = coalesce(excluded.label, custom_hooks.label),
        updated_at = excluded.updated_at
    `)
    .bind(hookId, accountId, await sha256Hex(token), label, now, now)
    .run();
  return json({ ok: true, hookId, path: `/hooks/${hookId}/` });
}

function hookRowToEvent(row: CustomHookEventRow): Record<string, unknown> {
  let headers: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.headers_json) as unknown;
    if (isRecord(parsed)) headers = parsed as Record<string, string>;
  } catch {
    // A row we wrote ourselves; an unreadable one still delivers its body.
  }
  return {
    eventId: row.event_id,
    hookId: row.hook_id,
    method: row.method,
    query: row.query,
    headers,
    body: row.body,
    bodyEncoding: row.body_encoding,
    receivedAt: row.received_at,
  };
}

/**
 * Held deliveries for the caller's hooks, oldest first. Everything still here
 * is undelivered: ADE acknowledges each delivery by id once it has processed it
 * (`handleAckCustomHookEvents`), and that deletes it. There is no cursor to go
 * stale, so a reset sequence or a lost cursor can neither skip nor delete a
 * request ADE has not seen.
 */
export async function handleListCustomHookEvents(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const accountId = await authenticateAccount(request, env);
  if (!accountId) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const hookIds = parseHookIds(url.searchParams.get("hooks"));
  if (!hookIds.length) return json({ events: [], hasMore: false });
  const placeholders = hookIds.map(() => "?").join(", ");
  const rows = (await env.DB
    .prepare(`
      select seq as event_seq, event_id, hook_id, method, query, headers_json, body, body_encoding, received_at
        from custom_hook_events
       where account_id = ? and hook_id in (${placeholders})
       order by seq asc
       limit ?
    `)
    .bind(accountId, ...hookIds, limit + 1)
    .all<CustomHookEventRow>()).results ?? [];
  return json({ events: rows.slice(0, limit).map(hookRowToEvent), hasMore: rows.length > limit });
}

const MAX_ACK_IDS = 500;

/** `POST /hooks/ack {eventIds}`: ADE has processed these; the relay forgets them. */
export async function handleAckCustomHookEvents(request: Request, env: RelayEnv): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  const accountId = await authenticateAccount(request, env);
  if (!accountId) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (contentLengthExceedsLimit(request.headers, 64 * 1024)) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  let eventIds: string[] = [];
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    const raw = isRecord(parsed) && Array.isArray(parsed.eventIds) ? parsed.eventIds : [];
    eventIds = raw.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 64);
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!eventIds.length) return json({ ok: true, acknowledged: 0 });
  if (eventIds.length > MAX_ACK_IDS) return json({ ok: false, error: `at most ${MAX_ACK_IDS} ids per call` }, { status: 400 });
  const placeholders = eventIds.map(() => "?").join(", ");
  const result = await env.DB
    .prepare(`delete from custom_hook_events where account_id = ? and event_id in (${placeholders})`)
    .bind(accountId, ...eventIds)
    .run();
  return json({ ok: true, acknowledged: Number(result.meta?.changes ?? 0) });
}

function parseHookIds(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => HOOK_ID_PATTERN.test(value))
    .slice(0, MAX_HOOKS_PER_ACCOUNT);
}

export async function handleCustomHookSubscription(request: Request, env: RelayEnv): Promise<Response> {
  const upgradeRequired = requireWebSocketUpgrade(request);
  if (upgradeRequired) return upgradeRequired;
  const accountId = await authenticateAccount(request, env);
  if (!accountId) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  return await subscribeLinearTopic(env, hookTopic(accountId));
}

/** Account unlink: hooks are account-owned, so they go with the account. */
export async function removeCustomHooksForAccount(env: RelayEnv, accountId: string): Promise<void> {
  await env.DB.prepare("delete from custom_hook_events where account_id = ?").bind(accountId).run();
  await env.DB.prepare("delete from custom_hooks where account_id = ?").bind(accountId).run();
}
