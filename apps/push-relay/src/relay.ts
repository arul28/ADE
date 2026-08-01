import {
  sendApnsPush,
  type ApnsEnvironment,
  type ApnsKeyConfig,
  type ApnsPushType,
  type ApnsSendResult,
} from "./apns";
import { parseFcmServiceAccount } from "./fcm";
import {
  handleAttentionAccountRequest,
  handleAttentionMachinePublish,
  inspectAttentionAuthConfiguration,
  pruneAttentionState,
} from "./attention";

export type PushRelayEnv = {
  DB: D1Database;
  /** PKCS#8 PEM contents of the APNs .p8 signing key (wrangler secret). */
  APNS_KEY?: string;
  /** 10-character APNs Key ID (wrangler secret or var). */
  APNS_KEY_ID?: string;
  /** Apple Developer Team ID (wrangler secret or var). */
  APNS_TEAM_ID?: string;
  /** Fallback apns-topic when a registration has no bundle id (should not happen). */
  APNS_DEFAULT_TOPIC?: string;
  /** Firebase service-account JSON for Android FCM HTTP-v1 delivery. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  REGISTRATION_RETENTION_DAYS?: string;
  MAX_DEVICES_PER_MACHINE?: string;
  /**
   * Hard ceiling on total relay requests per UTC day — the spend backstop.
   * Once exceeded, every request is rejected 429 until midnight UTC. Sized so a
   * full month at the cap stays well under ~$10 of Cloudflare overage; see the
   * `DEFAULT_DAILY_REQUEST_BUDGET` note. Override via `wrangler.jsonc` vars.
   */
  DAILY_REQUEST_BUDGET?: string;
  /** Requests allowed per IP per 60s across all routes (general abuse gate). */
  IP_RATE_LIMIT_PER_MIN?: string;
  /** `/claim` requests allowed per IP per 60s (unauthenticated-write gate). */
  CLAIM_RATE_LIMIT_PER_MIN?: string;
  /** Clerk JWKS endpoint used to verify account-scoped Attention bearer tokens. */
  CLERK_JWKS_URL?: string;
  /** Expected Clerk issuer for account-scoped Attention bearer tokens. */
  CLERK_ISSUER?: string;
  /** OAuth client id accepted as the Attention token audience/authorized party. */
  CLERK_OAUTH_CLIENT_ID?: string;
  /** Optional second Clerk instance (typically development iOS builds). */
  CLERK_SECONDARY_JWKS_URL?: string;
  CLERK_SECONDARY_ISSUER?: string;
  CLERK_SECONDARY_OAUTH_CLIENT_ID?: string;
  /** Exact hosted web-client origin allowed to call account Attention routes. */
  WEB_CLIENT_ORIGIN?: string;
};

type MachineRow = {
  machine_key: string;
  secret: string;
};

type DeviceRow = {
  machine_key: string;
  device_id: string;
  apns_token: string | null;
  push_to_start_token: string | null;
  bundle_id: string;
  aps_environment: string;
  platform: string | null;
  device_name: string | null;
  registered_at: string;
  updated_at: string;
  generation: string | null;
};

type ActivityTokenRow = {
  device_id: string;
  activity_id: string;
  token: string;
};

type SuppressionRow = {
  content_hash: string;
};

export type PushPhase = "running" | "waiting" | "terminal";

type AlertPublishItem = {
  deviceIds: string[] | null;
  /** Empty for a silent badge-only item (badge != null). */
  title: string;
  subtitle: string | null;
  body: string | null;
  deepLink: string | null;
  threadId: string | null;
  sound: string | null;
  interruptionLevel: "passive" | "active" | "time-sensitive" | null;
  collapseId: string | null;
  dedupeKey: string | null;
  phase: PushPhase;
  /** Passed through top-level (like deepLink) so iOS can act without opening. */
  sessionId: string | null;
  itemId: string | null;
  /** aps.category — binds registered UNNotificationActions on the device. */
  category: string | null;
  /** aps.badge — the app icon's awaiting-attention count. */
  badge: number | null;
};

type LiveActivityPublishItem = {
  deviceIds: string[] | null;
  event: "start" | "update" | "end";
  activityId: string;
  attributesType: string | null;
  attributes: Record<string, unknown> | null;
  contentState: Record<string, unknown>;
  staleDate: number | null;
  dismissalDate: number | null;
  relevanceScore: number | null;
  alert: { title: string; body: string | null } | null;
  dedupeKey: string | null;
  phase: PushPhase;
};

type DeliveryOutcome = {
  deviceId: string;
  kind: "alert" | "liveactivity";
  delivered: boolean;
  suppressed: boolean;
  skipped: string | null;
  status: number | null;
  reason: string | null;
};

const MACHINE_KEY_PATTERN = /^[a-f0-9]{32,64}$/i;
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._:-]{4,128}$/;
const APNS_TOKEN_PATTERN = /^[a-f0-9]{32,512}$/i;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PUBLISH_ITEMS = 32;
const MAX_SECRET_LENGTH = 128;
const MIN_SECRET_LENGTH = 32;
const SIGNATURE_TIMESTAMP_SKEW_SECONDS = 5 * 60;
const SUPPRESSION_RETENTION_HOURS = 48;
const DEFAULT_REGISTRATION_RETENTION_DAYS = 120;
const DEFAULT_MAX_DEVICES_PER_MACHINE = 16;

// Spend backstop. Cloudflare has no native hard billing cap, so we enforce one
// in code. The default accounts for the guards' OWN D1 writes, not just Worker
// requests: every under-cap request does ~2 counter writes (daily budget + the
// per-IP gate). 500,000 requests/day = ~15M/month → requests are ~5M over the
// 10M included ($0.30/M ≈ $1.50), and ~30M counter writes stay under the 50M
// D1 free tier ($0) — so a full month pinned at the cap is ≈ $1.50, safely
// under a ~$10 ceiling with margin, while still ~100–500× realistic
// single/small-team use. (At 1M/day the counter writes alone would cross the
// D1 free tier and push the month toward ~$16.) Tunable via `DAILY_REQUEST_BUDGET`.
const DEFAULT_DAILY_REQUEST_BUDGET = 500_000;
// General per-IP gate: a busy brain makes maybe 10–30 relay calls/min, so 120
// tolerates several machines behind one NAT yet crushes a flood.
const DEFAULT_IP_RATE_LIMIT_PER_MIN = 120;
// Tighter gate on the one unauthenticated *write* path. A machine claims once
// (idempotent reclaims are rare), so 10/min/IP is generous for legit pairing
// bursts and near-zero for a spammer trying to grow the machines table.
const DEFAULT_CLAIM_RATE_LIMIT_PER_MIN = 10;
const RATE_WINDOW_SECONDS = 60;
const RATE_COUNTER_RETENTION_MINUTES = 15;

// Phase-dependent APNs TTLs: a "running" transition is worthless a couple of
// hours later, while "waiting for input" / terminal outcomes stay actionable
// for a day. (Pattern borrowed from the best-in-class agent push relays.)
const PHASE_TTL_SECONDS: Record<PushPhase, number> = {
  running: 2 * 60 * 60,
  waiting: 24 * 60 * 60,
  terminal: 24 * 60 * 60,
};

const encoder = new TextEncoder();

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

function readString(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = readString(source, key);
  return value ? value : null;
}

function readNumber(source: Record<string, unknown> | null | undefined, key: string): number | null {
  // Distinguish an explicit JSON null/absent value from 0 — `Number(null)` is 0,
  // which would (e.g.) turn a null staleDate into the Unix epoch. Mirrors the
  // explicit-null handling the `sound` field uses in parseAlertItems.
  const raw = source?.[key];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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
 * Canonical string every signed call commits to. Binding the method, path and
 * body hash prevents replaying a captured signature against another endpoint
 * or with a mutated body; the timestamp bounds the replay window.
 */
export async function buildSignatureBase(args: {
  timestamp: string;
  method: string;
  pathname: string;
  body: string | ArrayBuffer;
}): Promise<string> {
  const bodyHash = await sha256Hex(args.body);
  return `${args.timestamp}.${args.method.toUpperCase()}.${args.pathname}.${bodyHash}`;
}

export async function signPushRelayRequest(secret: string, args: {
  timestamp: string;
  method: string;
  pathname: string;
  body: string | ArrayBuffer;
}): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, await buildSignatureBase(args))}`;
}

function parseTimestampSeconds(raw: string): number | null {
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length === 13 ? Math.floor(numeric / 1000) : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

async function loadMachine(env: PushRelayEnv, machineKey: string): Promise<MachineRow | null> {
  return await env.DB
    .prepare("select machine_key, secret from machines where machine_key = ? limit 1")
    .bind(machineKey)
    .first<MachineRow>();
}

async function assertMachineAuthorized(
  request: Request,
  env: PushRelayEnv,
  machineKey: string,
  body: ArrayBuffer,
): Promise<{ machine: MachineRow } | { response: Response }> {
  const keyPrefix = machineKey.slice(0, 8);
  const machine = await loadMachine(env, machineKey);
  if (!machine) {
    logEvent("auth_failed", { reason: "unknown_machine", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json({ ok: false, error: "unknown machine" }, { status: 401 }) };
  }
  const timestamp = request.headers.get("x-ade-push-timestamp")?.trim() || "";
  const signature = request.headers.get("x-ade-push-signature")?.trim() || "";
  if (!timestamp || !signature) {
    logEvent("auth_failed", { reason: "missing_signature", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json({ ok: false, error: "missing signature headers" }, { status: 401 }) };
  }
  const timestampSeconds = parseTimestampSeconds(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (timestampSeconds == null || Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TIMESTAMP_SKEW_SECONDS) {
    logEvent("auth_failed", { reason: "stale_timestamp", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json({ ok: false, error: "stale or invalid timestamp" }, { status: 401 }) };
  }
  const expected = await signPushRelayRequest(machine.secret, {
    timestamp,
    method: request.method,
    pathname: new URL(request.url).pathname,
    body,
  });
  if (!constantTimeEqual(expected, signature)) {
    logEvent("auth_failed", { reason: "bad_signature", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  await env.DB
    .prepare("update machines set last_seen_at = ? where machine_key = ?")
    .bind(new Date().toISOString(), machineKey)
    .run();
  return { machine };
}

function apnsConfig(env: PushRelayEnv): ApnsKeyConfig | null {
  const keyPem = env.APNS_KEY?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  if (!keyPem || !keyId || !teamId) return null;
  return { keyPem, keyId, teamId };
}

function parseBodyJson(body: ArrayBuffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEnvironment(raw: string): ApnsEnvironment | null {
  if (raw === "sandbox" || raw === "production") return raw;
  if (raw === "development") return "sandbox";
  return null;
}

function normalizePhase(raw: string): PushPhase {
  return raw === "running" || raw === "waiting" || raw === "terminal" ? raw : "waiting";
}

function readDeviceIds(source: Record<string, unknown>): string[] | null {
  const raw = source.deviceIds;
  // Absent (not an array) means "no restriction → all devices"; a present but
  // empty/invalid array must target zero devices, not silently broadcast.
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => DEVICE_ID_PATTERN.test(value));
}

function parseAlertItems(raw: unknown): AlertPublishItem[] {
  if (!Array.isArray(raw)) return [];
  const items: AlertPublishItem[] = [];
  for (const entry of raw.slice(0, MAX_PUBLISH_ITEMS)) {
    if (!isRecord(entry)) continue;
    const title = readString(entry, "title");
    const badgeRaw = readNumber(entry, "badge");
    const badge = badgeRaw != null && badgeRaw >= 0 ? Math.floor(badgeRaw) : null;
    // A title-less item is valid only as a silent badge sync.
    if (!title && badge == null) continue;
    const interruption = readString(entry, "interruptionLevel");
    items.push({
      deviceIds: readDeviceIds(entry),
      title,
      subtitle: readOptionalString(entry, "subtitle"),
      body: readOptionalString(entry, "body"),
      deepLink: readOptionalString(entry, "deepLink"),
      threadId: readOptionalString(entry, "threadId"),
      sound: entry.sound === null ? null : readOptionalString(entry, "sound") ?? "default",
      interruptionLevel:
        interruption === "passive" || interruption === "active" || interruption === "time-sensitive"
          ? interruption
          : null,
      collapseId: readOptionalString(entry, "collapseId"),
      dedupeKey: readOptionalString(entry, "dedupeKey"),
      phase: normalizePhase(readString(entry, "phase")),
      sessionId: readOptionalString(entry, "sessionId"),
      itemId: readOptionalString(entry, "itemId"),
      category: readOptionalString(entry, "category"),
      badge,
    });
  }
  return items;
}

function parseLiveActivityItems(raw: unknown): LiveActivityPublishItem[] {
  if (!Array.isArray(raw)) return [];
  const items: LiveActivityPublishItem[] = [];
  for (const entry of raw.slice(0, MAX_PUBLISH_ITEMS)) {
    if (!isRecord(entry)) continue;
    const event = readString(entry, "event");
    const activityId = readString(entry, "activityId");
    const contentState = isRecord(entry.contentState) ? entry.contentState : null;
    if ((event !== "start" && event !== "update" && event !== "end") || !activityId || !contentState) continue;
    const alert = isRecord(entry.alert) && readString(entry.alert, "title")
      ? { title: readString(entry.alert, "title"), body: readOptionalString(entry.alert, "body") }
      : null;
    items.push({
      deviceIds: readDeviceIds(entry),
      event,
      activityId,
      attributesType: readOptionalString(entry, "attributesType"),
      attributes: isRecord(entry.attributes) ? entry.attributes : null,
      contentState,
      staleDate: readNumber(entry, "staleDate"),
      dismissalDate: readNumber(entry, "dismissalDate"),
      relevanceScore: readNumber(entry, "relevanceScore"),
      alert,
      dedupeKey: readOptionalString(entry, "dedupeKey"),
      phase: normalizePhase(readString(entry, "phase")),
    });
  }
  return items;
}

async function listMachineDevices(env: PushRelayEnv, machineKey: string): Promise<DeviceRow[]> {
  return (await env.DB
    .prepare(`
      select machine_key, device_id, apns_token, push_to_start_token, bundle_id,
             aps_environment, platform, device_name, registered_at, updated_at,
             generation
        from device_registrations
       where machine_key = ?
       order by updated_at desc
    `)
    .bind(machineKey)
    .all<DeviceRow>()).results ?? [];
}

async function loadActivityTokens(
  env: PushRelayEnv,
  machineKey: string,
  activityId: string,
): Promise<ActivityTokenRow[]> {
  return (await env.DB
    .prepare(`
      select device_id, activity_id, token
        from live_activity_tokens
       where machine_key = ? and activity_id = ?
    `)
    .bind(machineKey, activityId)
    .all<ActivityTokenRow>()).results ?? [];
}

async function shouldSuppress(
  env: PushRelayEnv,
  machineKey: string,
  dedupeKey: string,
  contentHash: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare("select content_hash from publish_suppression where machine_key = ? and suppression_key = ? limit 1")
    .bind(machineKey, dedupeKey)
    .first<SuppressionRow>();
  return row != null && row.content_hash === contentHash;
}

async function recordSuppression(
  env: PushRelayEnv,
  machineKey: string,
  dedupeKey: string,
  contentHash: string,
): Promise<void> {
  await env.DB
    .prepare(`
      insert into publish_suppression(machine_key, suppression_key, content_hash, published_at)
      values (?, ?, ?, ?)
      on conflict(machine_key, suppression_key) do update set
        content_hash = excluded.content_hash,
        published_at = excluded.published_at
    `)
    .bind(machineKey, dedupeKey, contentHash, new Date().toISOString())
    .run();
}

function liveActivitySuppressionKey(dedupeKey: string, deviceId: string): string {
  return `liveactivity:${deviceId.length}:${deviceId}:${dedupeKey}`;
}

function liveActivitySuppressionPrefix(deviceId: string): string {
  return `liveactivity:${deviceId.length}:${deviceId}:`;
}

async function recordLiveActivitySuppressionIfCurrent(
  env: PushRelayEnv,
  machineKey: string,
  device: DeviceRow,
  dedupeKey: string,
  contentHash: string,
): Promise<void> {
  await env.DB.prepare(`
    insert into publish_suppression(
      machine_key, suppression_key, content_hash, published_at
    )
    select ?, ?, ?, ?
    where exists (
      select 1
      from device_registrations
      where machine_key = ?
        and device_id = ?
        and generation = ?
    )
    on conflict(machine_key, suppression_key) do update set
      content_hash = excluded.content_hash,
      published_at = excluded.published_at
  `).bind(
    machineKey,
    liveActivitySuppressionKey(dedupeKey, device.device_id),
    contentHash,
    new Date().toISOString(),
    machineKey,
    device.device_id,
    device.generation,
  ).run();
}

async function clearInvalidToken(
  env: PushRelayEnv,
  machineKey: string,
  deviceId: string,
  column: "apns_token" | "push_to_start_token",
): Promise<void> {
  await env.DB
    .prepare(`update device_registrations set ${column} = null, updated_at = ? where machine_key = ? and device_id = ?`)
    .bind(new Date().toISOString(), machineKey, deviceId)
    .run();
}

async function deleteActivityToken(env: PushRelayEnv, machineKey: string, deviceId: string, activityId: string): Promise<void> {
  await env.DB
    .prepare("delete from live_activity_tokens where machine_key = ? and device_id = ? and activity_id = ?")
    .bind(machineKey, deviceId, activityId)
    .run();
}

/**
 * Structured single-line log. View live with `wrangler tail ade-push-relay`, or
 * enable Workers Logs (observability) in the dashboard for persistent, queryable
 * history. Every abuse/limit/error event goes through here so "what's going
 * wrong" is answerable from one filtered stream.
 */
function logEvent(kind: string, fields: Record<string, unknown> = {}): void {
  try {
    // `kind` is spread LAST so a caller field named `kind` can never clobber
    // the event name that log filters key on.
    console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-push-relay", ...fields, kind }));
  } catch {
    console.log(`ade-push-relay ${kind}`);
  }
}

/** Real client IP (Cloudflare sets and overrides this — clients cannot spoof it). */
function clientIp(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip && ip.length > 0 ? ip : "unknown";
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function rateLimitedResponse(): Response {
  return json({ ok: false, error: "rate limited" }, { status: 429, headers: { "retry-after": "60" } });
}

function budgetExceededResponse(): Response {
  return json({ ok: false, error: "relay daily budget reached" }, { status: 429, headers: { "retry-after": "3600" } });
}

/**
 * Fixed-window per-key limiter backed by the `rate_counters` D1 table. A single
 * atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` both admits
 * and counts:
 *  - a `WHERE` guard on the DO UPDATE means an already-over-limit window is a
 *    no-op — no write, and `RETURNING` yields no row, so a sustained flood costs
 *    a read (not a write) per rejected hit and the limiter never amplifies the
 *    spend it exists to bound;
 *  - because it is one statement, a parallel burst at a window boundary cannot
 *    all observe a below-limit count and all be admitted.
 */
async function checkRateLimit(
  env: PushRelayEnv,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; count: number }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  const row = await env.DB
    .prepare(
      `insert into rate_counters(bucket, window_start, count, updated_at)
       values (?1, ?2, 1, ?3)
       on conflict(bucket) do update set
         window_start = case when ?2 - window_start >= ?4 then ?2 else window_start end,
         count        = case when ?2 - window_start >= ?4 then 1  else count + 1 end,
         updated_at   = ?3
         where (?2 - window_start >= ?4) or (count < ?5)
       returning count`,
    )
    .bind(bucket, nowSeconds, nowIso, windowSeconds, limit)
    .first<{ count: number }>();
  // No returned row ⇒ the WHERE guard suppressed the update (window still open
  // and already at the limit) ⇒ rejected, with no D1 write.
  if (!row) return { allowed: false, count: limit };
  return { allowed: true, count: row.count };
}

// Per-isolate memory: once this isolate has seen the daily budget blown, reject
// every further request for free (no D1) until the UTC day rolls over.
let budgetTrippedUntilMs = 0;

/** Cheap memory check — true when this isolate already saw today's budget blown. */
function budgetTrippedNow(): boolean {
  return Date.now() < budgetTrippedUntilMs;
}

/** Test hook: clears the in-isolate budget latch so cases don't leak state. */
export function resetSpendGuardsForTests(): void {
  budgetTrippedUntilMs = 0;
}

/**
 * Increments the global daily request counter and returns whether we are still
 * under the configured budget. On the first over-budget request the isolate
 * latches `budgetTrippedUntilMs` to end-of-day so subsequent checks short-circuit
 * in memory (see `budgetTrippedNow`).
 */
async function recordDailyBudget(env: PushRelayEnv): Promise<{ allowed: boolean }> {
  const nowMs = Date.now();
  const budget = positiveIntEnv(env.DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const bucket = `budget:${day}`;
  // Atomic increment-and-read in a single statement (`returning`), so a request
  // never evaluates a count staler than its own increment. Cross-request
  // boundary overshoot is still possible but bounded by in-flight concurrency
  // (a handful of requests ≈ fractions of a cent against a 1M/day cap) — this
  // is a coarse spend backstop, not an exact quota.
  const row = await env.DB
    .prepare(
      `insert into rate_counters(bucket, window_start, count, updated_at)
       values (?, ?, 1, ?)
       on conflict(bucket) do update set count = rate_counters.count + 1,
                                         updated_at = excluded.updated_at
       returning count`,
    )
    .bind(bucket, Math.floor(nowMs / 1000), new Date(nowMs).toISOString())
    .first<{ count: number }>();
  const count = row?.count ?? 0;
  if (count > budget) {
    budgetTrippedUntilMs = Date.parse(`${day}T23:59:59.999Z`);
    logEvent("budget_exceeded", { day, count, budget });
    return { allowed: false };
  }
  return { allowed: true };
}

export async function pruneRelayState(env: PushRelayEnv): Promise<void> {
  const suppressionCutoff = new Date(Date.now() - SUPPRESSION_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from publish_suppression where published_at < ?")
    .bind(suppressionCutoff)
    .run();
  const days = Number(env.REGISTRATION_RETENTION_DAYS ?? DEFAULT_REGISTRATION_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) ? Math.max(7, Math.trunc(days)) : DEFAULT_REGISTRATION_RETENTION_DAYS;
  const registrationCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from device_registrations where updated_at < ?")
    .bind(registrationCutoff)
    .run();
  // Rate-limit windows are ephemeral; drop stale ones. Budget rows (bucket
  // `budget:<day>`) are kept a couple of days so a quiet period mid-day can
  // never prune away the running daily count and silently reset the cap.
  const rateCutoff = new Date(Date.now() - RATE_COUNTER_RETENTION_MINUTES * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from rate_counters where bucket not like 'budget:%' and updated_at < ?")
    .bind(rateCutoff)
    .run();
  const budgetCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare("delete from rate_counters where bucket like 'budget:%' and updated_at < ?")
    .bind(budgetCutoff)
    .run();
  await pruneAttentionState(env);
}

function phaseExpiration(phase: PushPhase, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + PHASE_TTL_SECONDS[phase];
}

function alertApnsPayload(item: AlertPublishItem): Record<string, unknown> {
  const aps: Record<string, unknown> = {};
  if (item.title) {
    aps.alert = {
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(item.body ? { body: item.body } : {}),
    };
  }
  if (item.sound) aps.sound = item.sound;
  if (item.threadId) aps["thread-id"] = item.threadId;
  if (item.interruptionLevel) aps["interruption-level"] = item.interruptionLevel;
  if (item.category) aps.category = item.category;
  if (item.badge != null) aps.badge = item.badge;
  return {
    aps,
    ...(item.deepLink ? { deepLink: item.deepLink } : {}),
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.itemId ? { itemId: item.itemId } : {}),
  };
}

// Too-short stale dates dim healthy-but-quiet activities (updates are
// event-driven, not periodic); 10 minutes is the proven sweet spot.
const DEFAULT_STALE_AFTER_SECONDS = 10 * 60;

function liveActivityApnsPayload(item: LiveActivityPublishItem, nowSeconds: number): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: nowSeconds,
    event: item.event,
    "content-state": item.contentState,
  };
  if (item.event !== "end") {
    aps["stale-date"] = item.staleDate != null ? Math.floor(item.staleDate) : nowSeconds + DEFAULT_STALE_AFTER_SECONDS;
  } else if (item.staleDate != null) {
    aps["stale-date"] = Math.floor(item.staleDate);
  }
  if (item.relevanceScore != null) aps["relevance-score"] = item.relevanceScore;
  if (item.event === "start") {
    // Asks APNs/ActivityKit to mint and deliver the per-activity update token.
    aps["input-push-token"] = 1;
    if (item.attributesType) aps["attributes-type"] = item.attributesType;
    if (item.attributes) aps.attributes = item.attributes;
    if (item.alert) {
      aps.alert = { title: item.alert.title, ...(item.alert.body ? { body: item.alert.body } : {}) };
    }
  }
  if (item.event === "end" && item.dismissalDate != null) {
    aps["dismissal-date"] = Math.floor(item.dismissalDate);
  }
  return { aps };
}

function liveActivityTopic(bundleId: string): string {
  return `${bundleId}.push-type.liveactivity`;
}

function selectTargets(devices: DeviceRow[], requested: string[] | null): DeviceRow[] {
  if (!requested) return devices;
  const wanted = new Set(requested);
  return devices.filter((device) => wanted.has(device.device_id));
}

async function deliverAlertItem(
  env: PushRelayEnv,
  config: ApnsKeyConfig,
  machineKey: string,
  devices: DeviceRow[],
  item: AlertPublishItem,
  defaultTopic: string,
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  const targets = selectTargets(devices, item.deviceIds).filter((device) => device.apns_token);
  if (targets.length === 0) return outcomes;

  let suppressionHash: string | null = null;
  if (item.dedupeKey) {
    suppressionHash = await sha256Hex(JSON.stringify(alertApnsPayload(item)));
    if (await shouldSuppress(env, machineKey, item.dedupeKey, suppressionHash)) {
      return targets.map((device) => ({
        deviceId: device.device_id,
        kind: "alert" as const,
        delivered: false,
        suppressed: true,
        skipped: null,
        status: null,
        reason: null,
      }));
    }
  }

  const expiration = phaseExpiration(item.phase);
  for (const device of targets) {
    const environment = normalizeEnvironment(device.aps_environment) ?? "production";
    const result: ApnsSendResult = await sendApnsPush(config, {
      environment,
      deviceToken: device.apns_token as string,
      topic: device.bundle_id || defaultTopic,
      pushType: "alert",
      priority: 10,
      expiration,
      collapseId: item.collapseId,
      payload: alertApnsPayload(item),
    });
    if (result.tokenInvalid) {
      await clearInvalidToken(env, machineKey, device.device_id, "apns_token");
    }
    if (!result.ok) {
      logEvent("apns_error", { push: "alert", device: device.device_id.slice(-6), status: result.status, reason: result.reason, tokenInvalid: result.tokenInvalid });
    }
    outcomes.push({
      deviceId: device.device_id,
      kind: "alert",
      delivered: result.ok,
      suppressed: false,
      skipped: null,
      status: result.status,
      reason: result.reason,
    });
  }
  // Only a delivered publish counts for future suppression — recording before
  // the send would turn a transient APNs failure into a permanently-suppressed
  // retry of the same content.
  if (item.dedupeKey && suppressionHash && outcomes.some((outcome) => outcome.delivered)) {
    await recordSuppression(env, machineKey, item.dedupeKey, suppressionHash);
  }
  return outcomes;
}

async function deliverLiveActivityItem(
  env: PushRelayEnv,
  config: ApnsKeyConfig,
  machineKey: string,
  devices: DeviceRow[],
  item: LiveActivityPublishItem,
  defaultTopic: string,
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = liveActivityApnsPayload(item, nowSeconds);
  const expiration = phaseExpiration(item.phase, nowSeconds);
  const targets = selectTargets(devices, item.deviceIds);

  const suppressionHash = item.dedupeKey
    ? await sha256Hex(JSON.stringify({ event: item.event, contentState: item.contentState }))
    : null;
  const isSuppressedForDevice = async (deviceId: string): Promise<boolean> => {
    return Boolean(
      item.dedupeKey
      && suppressionHash
      && await shouldSuppress(
        env,
        machineKey,
        liveActivitySuppressionKey(item.dedupeKey, deviceId),
        suppressionHash,
      ),
    );
  };
  const recordDeliveredForDevice = async (device: DeviceRow): Promise<void> => {
    if (!item.dedupeKey || !suppressionHash) return;
    await recordLiveActivitySuppressionIfCurrent(
      env,
      machineKey,
      device,
      item.dedupeKey,
      suppressionHash,
    );
  };

  if (item.event === "start") {
    for (const device of targets) {
      if (await isSuppressedForDevice(device.device_id)) {
        outcomes.push({
          deviceId: device.device_id,
          kind: "liveactivity",
          delivered: false,
          suppressed: true,
          skipped: null,
          status: null,
          reason: null,
        });
        continue;
      }
      if (!device.push_to_start_token) {
        outcomes.push({
          deviceId: device.device_id,
          kind: "liveactivity",
          delivered: false,
          suppressed: false,
          skipped: "no push-to-start token",
          status: null,
          reason: null,
        });
        continue;
      }
      const environment = normalizeEnvironment(device.aps_environment) ?? "production";
      const result = await sendApnsPush(config, {
        environment,
        deviceToken: device.push_to_start_token,
        topic: liveActivityTopic(device.bundle_id || defaultTopic),
        pushType: "liveactivity",
        priority: 10,
        expiration,
        collapseId: item.activityId,
        payload,
      });
      if (result.tokenInvalid) {
        await clearInvalidToken(env, machineKey, device.device_id, "push_to_start_token");
      }
      if (!result.ok) {
        logEvent("apns_error", { push: "la_start", device: device.device_id.slice(-6), status: result.status, reason: result.reason, tokenInvalid: result.tokenInvalid });
      } else {
        await recordDeliveredForDevice(device);
      }
      outcomes.push({
        deviceId: device.device_id,
        kind: "liveactivity",
        delivered: result.ok,
        suppressed: false,
        skipped: null,
        status: result.status,
        reason: result.reason,
      });
    }
    return outcomes;
  }

  // update / end target the per-activity tokens the phones reported.
  const activityTokens = await loadActivityTokens(env, machineKey, item.activityId);
  const deviceById = new Map(devices.map((device) => [device.device_id, device]));
  const wanted = item.deviceIds ? new Set(item.deviceIds) : null;
  for (const tokenRow of activityTokens) {
    if (wanted && !wanted.has(tokenRow.device_id)) continue;
    const device = deviceById.get(tokenRow.device_id);
    if (!device) continue;
    if (await isSuppressedForDevice(tokenRow.device_id)) {
      outcomes.push({
        deviceId: tokenRow.device_id,
        kind: "liveactivity",
        delivered: false,
        suppressed: true,
        skipped: null,
        status: null,
        reason: null,
      });
      continue;
    }
    const environment = normalizeEnvironment(device.aps_environment) ?? "production";
    const result = await sendApnsPush(config, {
      environment,
      deviceToken: tokenRow.token,
      topic: liveActivityTopic(device.bundle_id || defaultTopic),
      pushType: "liveactivity",
      priority: item.event === "end" || item.phase === "waiting" ? 10 : 5,
      expiration,
      collapseId: item.activityId,
      payload,
    });
    if (result.tokenInvalid || (item.event === "end" && result.ok)) {
      await deleteActivityToken(env, machineKey, tokenRow.device_id, item.activityId);
    }
    if (!result.ok) {
      logEvent("apns_error", { push: `la_${item.event}`, device: tokenRow.device_id.slice(-6), status: result.status, reason: result.reason, tokenInvalid: result.tokenInvalid });
    } else {
      await recordDeliveredForDevice(device);
    }
    outcomes.push({
      deviceId: tokenRow.device_id,
      kind: "liveactivity",
      delivered: result.ok,
      suppressed: false,
      skipped: null,
      status: result.status,
      reason: result.reason,
    });
  }
  return outcomes;
}

async function handleMachineClaim(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (!MACHINE_KEY_PATTERN.test(machineKey)) {
    return json({ ok: false, error: "machine key must be 32-64 hex characters" }, { status: 400 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const payload = parseBodyJson(body);
  const secret = payload ? readString(payload, "secret") : "";
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
    return json({ ok: false, error: `secret must be ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters` }, { status: 400 });
  }
  // `machine_key` is the primary key, so a plain read-then-insert races: two
  // concurrent first claims can both pass the read and one insert then throws a
  // unique-constraint 500. Insert atomically (ON CONFLICT DO NOTHING) and read
  // back the winner to decide idempotent-reclaim vs conflict.
  const existingBefore = await loadMachine(env, machineKey);
  const now = new Date().toISOString();
  await env.DB
    .prepare("insert into machines(machine_key, secret, created_at, last_seen_at) values (?, ?, ?, ?) on conflict(machine_key) do nothing")
    .bind(machineKey, secret, now, now)
    .run();
  const stored = await loadMachine(env, machineKey);
  if (!stored) {
    return json({ ok: false, error: "claim failed" }, { status: 500 });
  }
  if (!constantTimeEqual(stored.secret, secret)) {
    logEvent("claim_conflict", { machineKey: machineKey.slice(0, 8), ip: clientIp(request) });
    return json({ ok: false, error: "machine key is already claimed" }, { status: 409 });
  }
  return existingBefore
    ? json({ ok: true, claimed: false })
    : json({ ok: true, claimed: true }, { status: 201 });
}

async function handleDeviceUpsert(
  request: Request,
  env: PushRelayEnv,
  machineKey: string,
  deviceId: string,
): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return json({ ok: false, error: "invalid device id" }, { status: 400 });
  }
  const payload = parseBodyJson(body);
  if (!payload) return json({ ok: false, error: "invalid json" }, { status: 400 });

  const bundleId = readString(payload, "bundleId");
  const environment = normalizeEnvironment(readString(payload, "apsEnvironment"));
  if (!bundleId || !environment) {
    return json({ ok: false, error: "bundleId and apsEnvironment (sandbox|production) are required" }, { status: 400 });
  }
  const apnsToken = readOptionalString(payload, "apnsToken");
  const pushToStartToken = readOptionalString(payload, "pushToStartToken");
  const clearPushToStartToken = payload.clearPushToStartToken === true;
  if (pushToStartToken && clearPushToStartToken) {
    return json(
      { ok: false, error: "pushToStartToken cannot be set and cleared together" },
      { status: 400 },
    );
  }
  if (apnsToken && !APNS_TOKEN_PATTERN.test(apnsToken)) {
    return json({ ok: false, error: "invalid apnsToken" }, { status: 400 });
  }
  if (pushToStartToken && !APNS_TOKEN_PATTERN.test(pushToStartToken)) {
    return json({ ok: false, error: "invalid pushToStartToken" }, { status: 400 });
  }

  const devices = await listMachineDevices(env, machineKey);
  const maxDevicesRaw = Number(env.MAX_DEVICES_PER_MACHINE ?? DEFAULT_MAX_DEVICES_PER_MACHINE);
  const maxDevices = Number.isFinite(maxDevicesRaw) ? Math.max(1, Math.trunc(maxDevicesRaw)) : DEFAULT_MAX_DEVICES_PER_MACHINE;
  const isExisting = devices.some((device) => device.device_id === deviceId);
  if (!isExisting && devices.length >= maxDevices) {
    return json({ ok: false, error: "device limit reached for this machine" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const generation = crypto.randomUUID();
  const registrationStatement = env.DB.prepare(`
      insert into device_registrations(
        machine_key, device_id, apns_token, push_to_start_token, bundle_id,
        aps_environment, platform, device_name, registered_at, updated_at,
        generation
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(machine_key, device_id) do update set
        apns_token = coalesce(excluded.apns_token, device_registrations.apns_token),
        push_to_start_token = case
          when ? then null
          else coalesce(excluded.push_to_start_token, device_registrations.push_to_start_token)
        end,
        bundle_id = excluded.bundle_id,
        aps_environment = excluded.aps_environment,
        platform = coalesce(excluded.platform, device_registrations.platform),
        device_name = coalesce(excluded.device_name, device_registrations.device_name),
        updated_at = excluded.updated_at,
        generation = excluded.generation
    `)
    .bind(
      machineKey,
      deviceId,
      apnsToken,
      pushToStartToken,
      bundleId,
      environment,
      readOptionalString(payload, "platform"),
      readOptionalString(payload, "deviceName"),
      now,
      now,
      generation,
      clearPushToStartToken ? 1 : 0,
    );
  if (clearPushToStartToken) {
    const suppressionPrefix = liveActivitySuppressionPrefix(deviceId);
    await env.DB.batch([
      registrationStatement,
      env.DB.prepare(
        "delete from publish_suppression where machine_key = ? and substr(suppression_key, 1, ?) = ?",
      ).bind(machineKey, suppressionPrefix.length, suppressionPrefix),
      env.DB.prepare(
        "delete from live_activity_tokens where machine_key = ? and device_id = ?",
      ).bind(machineKey, deviceId),
    ]);
  } else {
    await registrationStatement.run();
  }
  await pruneRelayState(env);
  return json({ ok: true, deviceId, updatedAt: now });
}

async function handleDeviceDelete(
  request: Request,
  env: PushRelayEnv,
  machineKey: string,
  deviceId: string,
): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  await env.DB
    .prepare("delete from device_registrations where machine_key = ? and device_id = ?")
    .bind(machineKey, deviceId)
    .run();
  await env.DB
    .prepare("delete from live_activity_tokens where machine_key = ? and device_id = ?")
    .bind(machineKey, deviceId)
    .run();
  return json({ ok: true, deviceId });
}

async function handleDeviceList(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const devices = await listMachineDevices(env, machineKey);
  return json({
    ok: true,
    devices: devices.map((device) => ({
      deviceId: device.device_id,
      hasApnsToken: Boolean(device.apns_token),
      hasPushToStartToken: Boolean(device.push_to_start_token),
      bundleId: device.bundle_id,
      apsEnvironment: device.aps_environment,
      platform: device.platform,
      deviceName: device.device_name,
      registeredAt: device.registered_at,
      updatedAt: device.updated_at,
    })),
  });
}

async function handleActivityTokenUpsert(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const payload = parseBodyJson(body);
  if (!payload) return json({ ok: false, error: "invalid json" }, { status: 400 });
  const deviceId = readString(payload, "deviceId");
  const activityId = readString(payload, "activityId");
  const token = readString(payload, "token");
  if (!DEVICE_ID_PATTERN.test(deviceId) || !activityId) {
    return json({ ok: false, error: "deviceId and activityId are required" }, { status: 400 });
  }
  if (!token) {
    await deleteActivityToken(env, machineKey, deviceId, activityId);
    return json({ ok: true, removed: true });
  }
  if (!APNS_TOKEN_PATTERN.test(token)) {
    return json({ ok: false, error: "invalid activity token" }, { status: 400 });
  }
  await env.DB
    .prepare(`
      insert into live_activity_tokens(machine_key, device_id, activity_id, token, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(machine_key, device_id, activity_id) do update set
        token = excluded.token,
        updated_at = excluded.updated_at
    `)
    .bind(machineKey, deviceId, activityId, token, new Date().toISOString())
    .run();
  return json({ ok: true, removed: false });
}

async function handlePublish(request: Request, env: PushRelayEnv, machineKey: string): Promise<Response> {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const config = apnsConfig(env);
  if (!config) {
    return json({ ok: false, error: "APNs signing key is not configured on the relay" }, { status: 503 });
  }
  const payload = parseBodyJson(body);
  if (!payload) return json({ ok: false, error: "invalid json" }, { status: 400 });

  const alerts = parseAlertItems(payload.notifications);
  const liveActivities = parseLiveActivityItems(payload.liveActivity);
  if (alerts.length === 0 && liveActivities.length === 0) {
    return json({ ok: false, error: "nothing to publish" }, { status: 400 });
  }

  const devices = await listMachineDevices(env, machineKey);
  const defaultTopic = env.APNS_DEFAULT_TOPIC?.trim() || "";
  const outcomes: DeliveryOutcome[] = [];
  for (const item of alerts) {
    outcomes.push(...await deliverAlertItem(env, config, machineKey, devices, item, defaultTopic));
  }
  for (const item of liveActivities) {
    outcomes.push(...await deliverLiveActivityItem(env, config, machineKey, devices, item, defaultTopic));
  }
  // Publishes far outnumber device re-registrations, so prune here too or a
  // chatty machine holds expired suppression rows past their retention.
  await pruneRelayState(env);

  return json({
    ok: true,
    delivered: outcomes.filter((outcome) => outcome.delivered).length,
    suppressed: outcomes.filter((outcome) => outcome.suppressed).length,
    failed: outcomes.filter((outcome) => !outcome.delivered && !outcome.suppressed && !outcome.skipped).length,
    outcomes,
  });
}

function routeMachine(pathname: string): { machineKey: string; rest: string[] } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0] === "machines") {
    return { machineKey: decodeURIComponent(parts[1] ?? ""), rest: parts.slice(2) };
  }
  return null;
}

function trustedWebClientOrigin(env: PushRelayEnv): string | null {
  const raw = env.WEB_CLIENT_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.origin !== raw || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function withAccountCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "Content-Type");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleRequest(request: Request, env: PushRelayEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    const accountAuth = inspectAttentionAuthConfiguration(env);
    return json({
      ok: true,
      apnsConfigured: apnsConfig(env) != null,
      fcmConfigured: parseFcmServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON) != null,
      accountAuthConfigured: accountAuth.configured,
      primaryAccountAuthConfigured: accountAuth.primaryConfigured,
      secondaryAccountAuthConfigured: accountAuth.secondaryConfigured,
      accountAuthConfigurationErrors: accountAuth.errors,
    });
  }
  const accountAttentionRoute = url.pathname.startsWith("/attention/account/");
  const requestOrigin = request.headers.get("origin");
  const configuredWebOrigin = trustedWebClientOrigin(env);
  const corsOrigin = requestOrigin && configuredWebOrigin === requestOrigin
    ? requestOrigin
    : null;
  const withAllowedAccountCors = (response: Response): Response =>
    accountAttentionRoute && corsOrigin
      ? withAccountCors(response, corsOrigin)
      : response;
  if (accountAttentionRoute && request.method === "OPTIONS") {
    if (!corsOrigin) return text("origin not allowed", 403);
    const requestedMethod = request.headers
      .get("access-control-request-method")
      ?.toUpperCase();
    if (!requestedMethod || !["GET", "POST", "PUT"].includes(requestedMethod)) {
      return text("method not allowed", 405);
    }
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedHeaders.some((header) =>
      header !== "authorization" && header !== "content-type"
    )) {
      return text("headers not allowed", 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-expose-headers": "Content-Type",
        "access-control-allow-methods": `${requestedMethod}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  // Native clients omit Origin. Browser callers must match the configured ADE
  // Web origin before authentication or D1 work begins.
  if (accountAttentionRoute && requestOrigin && !corsOrigin) {
    return text("origin not allowed", 403);
  }
  if (contentLengthExceeds(request.headers, MAX_BODY_BYTES)) {
    return withAllowedAccountCors(
      json({ ok: false, error: "payload too large" }, { status: 413 }),
    );
  }

  // Spend + abuse gates, cheapest first: (1) if the daily budget is already
  // blown for this isolate, reject for free; (2) reject a per-IP flood on a
  // cheap read before it can touch the budget counter; (3) otherwise account
  // one request against the global daily budget.
  if (budgetTrippedNow()) {
    return withAllowedAccountCors(budgetExceededResponse());
  }
  // Count EVERY billable request against the daily budget before any gate can
  // reject it: a rejected request still ran the Worker (and a D1 read), so it
  // must advance the spend cap — otherwise a single abusive IP could generate
  // unbounded billable 429s the cap never sees.
  const budget = await recordDailyBudget(env);
  if (!budget.allowed) {
    return withAllowedAccountCors(budgetExceededResponse());
  }
  // Per-IP gates apply on every route. On the real Cloudflare edge
  // cf-connecting-ip is always set; when it is absent (local `wrangler dev`,
  // service bindings) callers share one `unknown` bucket — fail-closed, so the
  // limits are never bypassed off-edge. A dev machine never approaches them.
  const ip = clientIp(request);
  const ipLimit = positiveIntEnv(env.IP_RATE_LIMIT_PER_MIN, DEFAULT_IP_RATE_LIMIT_PER_MIN);
  const ipGate = await checkRateLimit(env, `ip:${ip}`, ipLimit, RATE_WINDOW_SECONDS);
  if (!ipGate.allowed) {
    logEvent("rate_limited", { scope: "ip", ip, count: ipGate.count, limit: ipLimit, path: url.pathname });
    return withAllowedAccountCors(rateLimitedResponse());
  }

  const attentionAccountResponse = await handleAttentionAccountRequest(request, env, url);
  if (attentionAccountResponse) {
    return withAllowedAccountCors(attentionAccountResponse);
  }

  const route = routeMachine(url.pathname);
  if (!route || !MACHINE_KEY_PATTERN.test(route.machineKey)) return text("not found", 404);
  const { machineKey, rest } = route;

  if (rest.length === 1 && rest[0] === "claim") {
    // Tighter gate on the one unauthenticated write path — closes the
    // machines-table-growth vector without touching the signed endpoints.
    const claimLimit = positiveIntEnv(env.CLAIM_RATE_LIMIT_PER_MIN, DEFAULT_CLAIM_RATE_LIMIT_PER_MIN);
    const claimGate = await checkRateLimit(env, `claim:${ip}`, claimLimit, RATE_WINDOW_SECONDS);
    if (!claimGate.allowed) {
      logEvent("rate_limited", { scope: "claim", ip, count: claimGate.count, limit: claimLimit });
      return rateLimitedResponse();
    }
    return await handleMachineClaim(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "devices" && request.method === "GET") {
    return await handleDeviceList(request, env, machineKey);
  }
  if (rest.length === 2 && rest[0] === "devices") {
    const deviceId = decodeURIComponent(rest[1] ?? "");
    if (request.method === "PUT" || request.method === "POST") {
      return await handleDeviceUpsert(request, env, machineKey, deviceId);
    }
    if (request.method === "DELETE") {
      return await handleDeviceDelete(request, env, machineKey, deviceId);
    }
    return text("method not allowed", 405);
  }
  if (rest.length === 1 && rest[0] === "live-activity-tokens" && request.method === "POST") {
    return await handleActivityTokenUpsert(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "publish" && request.method === "POST") {
    return await handlePublish(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "attention" && request.method === "POST") {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "payload too large" }, { status: 413 });
    }
    const auth = await assertMachineAuthorized(request, env, machineKey, body);
    if ("response" in auth) return auth.response;
    return await handleAttentionMachinePublish(request, env, machineKey, body);
  }
  return text("not found", 404);
}

function contentLengthExceeds(headers: Headers, limit: number): boolean {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(limit);
  } catch {
    return true;
  }
}
