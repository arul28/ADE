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
  claimPeriodicRun,
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
  forward_url?: string | null;
  forward_secret?: string | null;
};

// ---- Forwarding (C9: a custom webhook whose automation runs on ADE Cloud) ----
//
// A forwarded hook's deliveries go to the account directory instead of the
// account's machines: one signed POST per delivery, right after it is stored,
// kept here until the directory answers 2xx (the 3-day hold covers an outage)
// and tried again on the hook's next delivery and from the cron. A 410 means
// the rule left ADE Cloud: the forward is cleared, and the machines drain the
// hook again. Machines never list a forwarded hook's deliveries, so a delivery
// runs in one place.

/** ADE's own account directories: the only places a hook forwards to, besides `HOOK_FORWARD_ORIGINS`. */
const HOOK_FORWARD_ORIGINS = [
  "https://ade-account-directory-production.arulsharma1028.workers.dev",
  "https://ade-account-directory.arulsharma1028.workers.dev",
];
const HOOK_FORWARD_PATH = /^\/cloud\/automations\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}\/deliveries$/;
const HOOK_FORWARD_TIMEOUT_MS = 25_000;
/** Held deliveries one pass forwards for one hook, oldest first. */
const HOOK_FORWARDS_PER_PASS = 10;
/** Hooks the cron's retry pass looks at. */
const HOOK_FORWARD_RETRY_HOOKS = 20;
/** The headers the directory reads (`CLOUD_AUTOMATION_HOOK_HEADERS` in the account directory's contract). */
const FORWARD_HEADERS = { hookId: "x-ade-hook-id", timestamp: "x-ade-hook-timestamp", signature: "x-ade-hook-signature" } as const;

/** The forward URL when it is one of ADE's directories' automation routes, else null. */
function forwardTarget(env: RelayEnv, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 400) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const extra = (env.HOOK_FORWARD_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) return null;
  if (![...HOOK_FORWARD_ORIGINS, ...extra].includes(url.origin) || !HOOK_FORWARD_PATH.test(url.pathname)) return null;
  return url.toString();
}

async function hmacHex(keyHex: string, message: string): Promise<string> {
  const key = new Uint8Array(keyHex.length / 2);
  for (let index = 0; index < key.length; index += 1) key[index] = parseInt(keyHex.slice(index * 2, index * 2 + 2), 16);
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One delivery to the directory: `sent` (and deleted here), `gone` (the rule left ADE Cloud), or `later`. */
async function forwardOne(env: RelayEnv, hook: Required<Pick<CustomHookRow, "hook_id" | "forward_url" | "forward_secret">>, row: CustomHookEventRow): Promise<"sent" | "gone" | "later"> {
  const body = JSON.stringify(hookRowToEvent(row));
  const timestamp = String(Date.now());
  try {
    const send = env.ACCOUNT_DIRECTORY ? env.ACCOUNT_DIRECTORY.fetch.bind(env.ACCOUNT_DIRECTORY) : fetch;
    const response = await send(hook.forward_url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [FORWARD_HEADERS.hookId]: hook.hook_id,
        [FORWARD_HEADERS.timestamp]: timestamp,
        [FORWARD_HEADERS.signature]: await hmacHex(hook.forward_secret!, `${timestamp}.${body}`),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(HOOK_FORWARD_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) {
      await env.DB.prepare("delete from custom_hook_events where event_id = ? and hook_id = ?").bind(row.event_id, hook.hook_id).run();
      return "sent";
    }
    if (response.status === 410) return "gone";
    console.warn(JSON.stringify({ kind: "hook_forward_refused", status: response.status }));
    return "later";
  } catch (error) {
    console.warn(JSON.stringify({ kind: "hook_forward_failed", error: error instanceof Error ? error.name : "unknown" }));
    return "later";
  }
}

/** Forwards a hook's held deliveries, oldest first, until one isn't taken. */
async function forwardHeld(env: RelayEnv, hook: CustomHookRow): Promise<void> {
  if (!hook.forward_url || !hook.forward_secret) return;
  const rows = (await env.DB
    .prepare(`
      select seq as event_seq, event_id, hook_id, method, query, headers_json, body, body_encoding, received_at
        from custom_hook_events where hook_id = ? and received_at >= ? order by seq asc limit ?
    `)
    .bind(hook.hook_id, hookHoldCutoff(), HOOK_FORWARDS_PER_PASS)
    .all<CustomHookEventRow>()).results ?? [];
  for (const row of rows) {
    const outcome = await forwardOne(env, { hook_id: hook.hook_id, forward_url: hook.forward_url, forward_secret: hook.forward_secret }, row);
    if (outcome === "later") return;
    if (outcome === "gone") {
      // The rule left ADE Cloud: its computer drains what is held, from now on.
      await env.DB.prepare("update custom_hooks set forward_url = null, forward_secret = null where hook_id = ? and forward_url = ?")
        .bind(hook.hook_id, hook.forward_url).run();
      await notifyLinearTopic(env, hookTopic(hook.account_id), { t: "hook_delivery" });
      return;
    }
  }
}

/**
 * From the cron: forwarded hooks still holding deliveries (the directory was
 * down when they came) get another pass. One indexed read when none waits.
 */
export async function retryHookForwards(env: RelayEnv): Promise<void> {
  const hooks = (await env.DB
    .prepare(`
      select hook_id, account_id, token_hash, forward_url, forward_secret from custom_hooks h
       where forward_url is not null and exists (select 1 from custom_hook_events e where e.hook_id = h.hook_id)
       limit ?
    `)
    .bind(HOOK_FORWARD_RETRY_HOOKS)
    .all<CustomHookRow>()).results ?? [];
  for (const hook of hooks) await forwardHeld(env, hook);
}

/**
 * `POST /hooks/forward { hookId, forward: { url, secret } | null }`: the
 * account's brain points its hook at the directory when the hook's rule moves
 * to ADE Cloud (the directory made the key), or back at its machines. The URL
 * token stays as it is, so the hook's public URL keeps working. Held
 * deliveries go on the new path at once.
 */
export async function handleCustomHookForward(request: Request, env: RelayEnv, ctx?: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
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
  const hook = await env.DB
    .prepare("select hook_id, account_id, token_hash, forward_url, forward_secret from custom_hooks where hook_id = ? and account_id = ? limit 1")
    .bind(hookId, accountId)
    .first<CustomHookRow>();
  if (!hook) return json({ ok: false, error: "not_found" }, { status: 404 });
  const forward = payload.forward;
  if (forward === null) {
    await env.DB.prepare("update custom_hooks set forward_url = null, forward_secret = null, updated_at = ? where hook_id = ? and account_id = ?")
      .bind(new Date().toISOString(), hookId, accountId).run();
    // Anything held goes to the machines now.
    await runAfterResponse(ctx, () => notifyLinearTopic(env, hookTopic(accountId), { t: "hook_delivery" }));
    return json({ ok: true, forwarding: false });
  }
  const target = isRecord(forward) ? forwardTarget(env, forward.url) : null;
  const secret = isRecord(forward) && typeof forward.secret === "string" && /^[0-9a-f]{64}$/.test(forward.secret) ? forward.secret : null;
  if (!target || !secret) return json({ ok: false, error: "forward is invalid" }, { status: 400 });
  await env.DB.prepare("update custom_hooks set forward_url = ?, forward_secret = ?, updated_at = ? where hook_id = ? and account_id = ?")
    .bind(target, secret, new Date().toISOString(), hookId, accountId).run();
  await runAfterResponse(ctx, () => forwardHeld(env, { ...hook, forward_url: target, forward_secret: secret }));
  return json({ ok: true, forwarding: true });
}

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
  // At most once per isolate every ten minutes, like the other event sweeps: a
  // delivery is a public request, and each one must not cost a table sweep.
  if (!claimPeriodicRun(env.DB, "prune-hook-events", 10 * 60 * 1000)) return;
  await env.DB.prepare("delete from custom_hook_events where received_at < ?").bind(hookHoldCutoff()).run();
}

function hookHoldCutoff(): string {
  return new Date(Date.now() - HOOK_HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function heldHookRequests(env: RelayEnv, hookId: string): Promise<number> {
  const held = await env.DB
    .prepare("select count(*) as held from custom_hook_events where hook_id = ?")
    .bind(hookId)
    .first<{ held: number }>();
  return Number(held?.held ?? 0);
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
    .prepare("select hook_id, account_id, token_hash, forward_url, forward_secret from custom_hooks where hook_id = ? limit 1")
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

  let held = await heldHookRequests(env, hook.hook_id);
  if (held >= MAX_HELD_REQUESTS_PER_HOOK) {
    // Expired requests count until a sweep removes them, and the sweep runs
    // after a stored delivery. Clear this hook's own before refusing, so an
    // inbox full of expired requests does not stay full.
    await env.DB
      .prepare("delete from custom_hook_events where hook_id = ? and received_at < ?")
      .bind(hook.hook_id, hookHoldCutoff())
      .run();
    held = await heldHookRequests(env, hook.hook_id);
  }
  if (held >= MAX_HELD_REQUESTS_PER_HOOK) {
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
      // A forwarded hook's deliveries go to ADE Cloud; its machines aren't woken for them.
      hook.forward_url ? forwardHeld(env, hook) : notifyLinearTopic(env, hookTopic(hook.account_id), { t: "hook_delivery" }),
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
  const asked = parseHookIds(url.searchParams.get("hooks"));
  if (!asked.length) return json({ events: [], hasMore: false });
  // A forwarded hook's deliveries belong to ADE Cloud: a machine never sees (or acknowledges) them.
  const forwarded = new Set(((await env.DB
    .prepare("select hook_id from custom_hooks where account_id = ? and forward_url is not null")
    .bind(accountId)
    .all<{ hook_id: string }>()).results ?? []).map((row) => row.hook_id));
  const hookIds = asked.filter((hookId) => !forwarded.has(hookId));
  if (!hookIds.length) return json({ events: [], hasMore: false });
  // D1 binds at most 100 values per statement, so a long hook list is read in
  // groups. Each group returns its own first `limit + 1` rows in `seq` order, so
  // the merged first `limit + 1` are exactly what one query would return. This
  // read takes only the ids and body sizes: bodies can be 1 MiB each, and D1
  // refuses a result past its size limit.
  const refGroups = await Promise.all(chunk(hookIds, MAX_BOUND_IDS_PER_STATEMENT).map(async (group) => {
    const placeholders = group.map(() => "?").join(", ");
    return (await env.DB
      .prepare(`
        select seq as event_seq, event_id, length(cast(body as blob)) as body_bytes
          from custom_hook_events
         where account_id = ? and hook_id in (${placeholders})
         order by seq asc
         limit ?
      `)
      .bind(accountId, ...group, limit + 1)
      .all<{ event_seq: number; event_id: string; body_bytes: number }>()).results ?? [];
  }));
  const refs = refGroups.flat()
    .sort((left, right) => Number(left.event_seq) - Number(right.event_seq))
    .slice(0, limit + 1);
  // The page ends at `limit` rows or at the body budget, whichever comes
  // first. It always holds the oldest row, so one large request never blocks
  // the rest.
  const page: typeof refs = [];
  let bodyBytes = 0;
  for (const ref of refs.slice(0, limit)) {
    if (page.length > 0 && bodyBytes + Number(ref.body_bytes) > MAX_LISTED_BODY_BYTES) break;
    page.push(ref);
    bodyBytes += Number(ref.body_bytes);
  }
  const bodyGroups = await Promise.all(chunk(page.map((ref) => ref.event_id), MAX_BOUND_IDS_PER_STATEMENT).map(async (group) => {
    const placeholders = group.map(() => "?").join(", ");
    return (await env.DB
      .prepare(`
        select seq as event_seq, event_id, hook_id, method, query, headers_json, body, body_encoding, received_at
          from custom_hook_events
         where account_id = ? and event_id in (${placeholders})
      `)
      .bind(accountId, ...group)
      .all<CustomHookEventRow>()).results ?? [];
  }));
  const rowsById = new Map(bodyGroups.flat().map((row) => [row.event_id, row]));
  // A row acknowledged between the two reads is gone; it was delivered.
  const events = page.flatMap((ref) => {
    const row = rowsById.get(ref.event_id);
    return row ? [hookRowToEvent(row)] : [];
  });
  return json({ events, hasMore: refs.length > page.length });
}

const MAX_ACK_IDS = 500;
/**
 * Body bytes in one page of held requests, well under D1's result limit. The
 * size is read as a blob: `length` of TEXT counts characters, and a multibyte
 * body is larger than its character count.
 */
const MAX_LISTED_BODY_BYTES = 16 * 1024 * 1024;
/** D1 allows 100 bound values per statement; the account id takes one more. */
const MAX_BOUND_IDS_PER_STATEMENT = 90;

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

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
  // In groups that stay under D1's limit of 100 bound values per statement.
  // ADE acknowledges only ids it has processed, so if a later group fails, the
  // ids already deleted were done, and the client's retry deletes the rest.
  let acknowledged = 0;
  for (const group of chunk(eventIds, MAX_BOUND_IDS_PER_STATEMENT)) {
    const result = await env.DB
      .prepare(`delete from custom_hook_events where account_id = ? and event_id in (${group.map(() => "?").join(", ")})`)
      .bind(accountId, ...group)
      .run();
    acknowledged += Number(result.meta?.changes ?? 0);
  }
  return json({ ok: true, acknowledged });
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
