/**
 * The ADE Cloud iPhone: an iOS Simulator on NoMac, one per ADE account.
 *
 * NoMac's account key (`NOMAC_API_KEY`) lives only here. A brain gets a token
 * for one phone (it can drive that phone, never start, list or stop one) and a
 * person's window gets a view link signed for their account alone. See
 * docs/features/apple-device/ade-cloud-iphone.md and
 * docs/plans/ade-cloud-iphone-launch.md.
 *
 * Who may use it: `CLOUD_PHONE_ACCESS` (`beta`, the default: the owner's list
 * in `cloud_phone_beta`; `all`; `off`). `CLOUD_PHONES_PAUSED=1` refuses new
 * phones while running ones finish.
 *
 * Minutes: the plan's `phoneMinutes` a period (0 on a free plan held by the
 * free-plan checks, as free hours are). Each phone is a `cloud_phones` row,
 * settled by NoMac's signed webhook and, for one that was missed, by the
 * ten-minute check. A paid plan with extra iPhone minutes on keeps going past
 * its minutes at `EXTRA_PHONE_MINUTE_CENTS`, up to its monthly limit; the free
 * plan stops. Every phone starts with NoMac's own spend cap and time limit set
 * to what the account may still use, so it stops by itself there: ADE never
 * pays for a minute nobody pays for.
 */

import { sendOwnerAlert } from "./blocks";
import { captureCloudPhone, type CloudWaitUntil } from "./analytics";
import { freeCapRefuses } from "./costReport";
import { CLOUD_PLANS, EXTRA_PHONE_MINUTE_CENTS } from "./plans";
import {
  CLOUD_PATHS,
  CLOUD_PHONE_DEVICES,
  type CloudAccountPhone,
  type CloudPhoneAccess,
  type CloudPhoneDevice,
  type CloudPhoneMinutes,
  type CloudPhoneMinutesState,
  type CloudPhoneStart,
  type CloudPhoneState,
  type CloudPhoneSummary,
  type CloudPhoneView,
} from "./contract";
import { sendCloudEmail } from "./email";
import { fail, json, readJson } from "./http";
import { accountRules, loadAccount, logCloud, planIdOf, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

const NOMAC_ORIGIN = "https://nomac.app";
const NOMAC_SIMULATOR_BASE = `${NOMAC_ORIGIN}/api/v1/simulator`;
const REQUEST_TIMEOUT_MS = 20_000;
/** NoMac's price for a phone: $0.90 an hour, billed per whole minute. The spend cap is counted in it. */
const NOMAC_MICROS_PER_MINUTE = 15_000;
/** A phone with no tool call or person's input for this long stops (NoMac counts watching as idle). */
const PHONE_IDLE_SECONDS = 300;
/** The longest one phone runs; a new one starts after (its workspace stays). */
const PHONE_MAX_MINUTES = 120;
/** The token a brain drives the phone with. */
const TOKEN_MINUTES = 120;
/** A view link's life; the visitor signature inside it lives far shorter (NoMac's own ceiling is 15 min). */
const VIEW_MINUTES = 120;
const VISITOR_SECONDS = 600;
/** NoMac's signature on a webhook older than this is refused. */
const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Webhook delivery ids are kept this long against repeats. */
const DELIVERY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** The ten-minute check reads at most this many live phones, and accounts to warn or bill, a run. */
const CHECK_BATCH = 200;
/** A row still `live` this long after it started is read from NoMac even when recent (a phone runs 2 hours at most). */
const LIVE_STALE_MS = 3 * 60 * 60_000;

const LIVE_STATES = new Set(["queued", "provisioning", "ready"]);

type NomacSession = {
  id: string;
  state: string;
  device?: string;
  label?: string | null;
  ready_at?: string | null;
  created_at?: string;
  shutdown_at?: string | null;
  queue_expires_at?: string | null;
  end_reason?: string | null;
  failure_code?: string | null;
  ended?: { reason?: string | null; at?: string | null } | null;
  cost?: { billed_seconds?: number; accrued_microunits?: string };
};

type NomacAnswer = { status: number; body: Record<string, unknown> | null };

/** A `cloud_phones` row (migration 0046). */
type PhoneRow = {
  phone_id: string;
  user_id: string;
  device: string | null;
  state: "live" | "ended";
  created_at: number;
  ready_at: number | null;
  ended_at: number | null;
  billed_seconds: number;
  cost_micros: number;
  end_reason: string | null;
  free: number;
  updated_at: number;
};

export type PhoneEnv = Pick<CloudEnv, "DB" | "NOMAC_API_KEY" | "NOMAC_EMBED_SECRET">;

/* ---- NoMac ---- */

/** NoMac's label for an ADE account: its id, never an email. */
export function phoneLabelFor(userId: string): string | null {
  const label = `ade:${userId}`;
  return /^[A-Za-z0-9._:@-]{1,64}$/.test(label) ? label : null;
}

/** The ADE account a NoMac label names, or null for a label ADE did not make. */
function userIdOfLabel(label: unknown): string | null {
  return typeof label === "string" && label.startsWith("ade:") && label.length > 4 ? label.slice(4) : null;
}

async function nomac(env: Pick<CloudEnv, "NOMAC_API_KEY">, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<NomacAnswer> {
  const key = env.NOMAC_API_KEY?.trim();
  if (!key) return { status: 503, body: null };
  const response = await fetch(`${NOMAC_ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // Workers have no `redirect: "error"`: a redirect is answered as a failure here.
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) return { status: 502, body: null };
  const parsed = await response.json().catch(() => null) as unknown;
  return { status: response.status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
}

function errorOf(answer: NomacAnswer): { code: string; message: string } {
  const error = answer.body?.error as { code?: unknown; message?: unknown } | undefined;
  return {
    code: typeof error?.code === "string" ? error.code : `http_${answer.status}`,
    message: typeof error?.message === "string" ? error.message : "The phone service did not answer.",
  };
}

/** NoMac failed us: logged with its code (never a credential), answered as one plain sentence. */
function providerFailure(event: string, answer: NomacAnswer, userId: string): Response {
  const { code, message } = errorOf(answer);
  logCloud(event, { userId, status: answer.status, code });
  if (code === "start_rate_limited" || answer.status === 429) {
    return fail("phone_busy", "Too many phones started in a row. Wait a minute, then try again.", 429);
  }
  if (code === "insufficient_credit" || code === "credit") {
    reportCloudFailure("cloud.phone_nomac_credit", { status: answer.status });
    return fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. ADE has been told.", 503);
  }
  return fail("phone_unavailable", answer.status >= 500 || answer.status === 503
    ? "The ADE Cloud iPhone isn't answering right now. Try again in a moment."
    : `The ADE Cloud iPhone refused that: ${message}`, answer.status >= 500 ? 502 : 400);
}

const isoMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

function sessionOf(value: unknown): NomacSession | null {
  const session = value as NomacSession | null;
  return session && typeof session.id === "string" && typeof session.state === "string" ? session : null;
}

/** One phone as NoMac answers it now, or null when it can't be read. */
async function readSession(env: Pick<CloudEnv, "NOMAC_API_KEY">, phoneId: string): Promise<{ session: NomacSession; stopNotice: unknown } | null> {
  const answer = await nomac(env, "GET", `/api/v1/simulator/sessions/${encodeURIComponent(phoneId)}`);
  const session = sessionOf(answer.body?.session);
  return answer.status === 200 && session ? { session, stopNotice: answer.body?.stop_notice } : null;
}

/* ---- The phones an account started (`cloud_phones`) ---- */

/**
 * Keeps what NoMac said about a phone. A phone that ended never goes back to
 * live, and its billed time and cost only grow, so a late or repeated
 * delivery can't undo a newer one. `free` is set when the row is made.
 */
async function savePhone(env: Pick<CloudEnv, "DB">, userId: string, session: NomacSession, now: number, free?: boolean): Promise<void> {
  const ended = !LIVE_STATES.has(session.state);
  await env.DB.prepare(`
    insert into cloud_phones (phone_id, user_id, device, state, created_at, ready_at, ended_at, billed_seconds, cost_micros, end_reason, free, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(phone_id) do update set
      state = case when cloud_phones.state = 'ended' then 'ended' else excluded.state end,
      device = coalesce(excluded.device, cloud_phones.device),
      ready_at = coalesce(cloud_phones.ready_at, excluded.ready_at),
      ended_at = coalesce(cloud_phones.ended_at, excluded.ended_at),
      billed_seconds = max(cloud_phones.billed_seconds, excluded.billed_seconds),
      cost_micros = max(cloud_phones.cost_micros, excluded.cost_micros),
      end_reason = coalesce(cloud_phones.end_reason, excluded.end_reason),
      updated_at = excluded.updated_at
  `).bind(
    session.id,
    userId,
    session.device ?? null,
    ended ? "ended" : "live",
    isoMs(session.created_at) ?? now,
    isoMs(session.ready_at),
    ended ? isoMs(session.ended?.at) ?? isoMs(session.shutdown_at) ?? now : null,
    Math.max(0, Math.floor(Number(session.cost?.billed_seconds ?? 0)) || 0),
    Math.max(0, Math.floor(Number(session.cost?.accrued_microunits ?? 0)) || 0),
    ended ? session.ended?.reason ?? session.end_reason ?? session.failure_code ?? null : null,
    free ? 1 : 0,
    now,
  ).run();
}

async function periodPhones(env: Pick<CloudEnv, "DB">, userId: string, since: number): Promise<PhoneRow[]> {
  const rows = await env.DB.prepare("select * from cloud_phones where user_id = ? and created_at >= ? order by created_at desc")
    .bind(userId, since).all<PhoneRow>();
  return rows.results ?? [];
}

/** Minutes a period's phones used: NoMac's billed minutes, and for one running now, its time so far (whole minutes, up). */
function minutesUsed(rows: PhoneRow[], now: number, settledOnly: boolean): number {
  let minutes = 0;
  for (const row of rows) {
    const billed = Math.ceil(row.billed_seconds / 60);
    const running = row.state === "live" && row.ready_at != null && !settledOnly ? Math.ceil(Math.max(0, now - row.ready_at) / 60_000) : 0;
    minutes += Math.max(billed, running);
  }
  return minutes;
}

/* ---- Who may use it, and how much ---- */

/** The server's switch: `beta` (the owner's list), `all`, or `off`. */
export function phoneAccessSetting(env: Pick<CloudEnv, "CLOUD_PHONE_ACCESS">): "beta" | "all" | "off" {
  const value = env.CLOUD_PHONE_ACCESS?.trim().toLowerCase();
  return value === "all" || value === "off" ? value : "beta";
}

/** On the owner's beta list. */
export async function phoneBetaHas(env: Pick<CloudEnv, "DB">, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as on_list from cloud_phone_beta where user_id = ?").bind(userId).first<{ on_list: number }>();
  return row != null;
}

async function phoneAccess(env: CloudEnv, userId: string): Promise<CloudPhoneAccess> {
  if (!env.NOMAC_API_KEY?.trim()) return "off";
  const setting = phoneAccessSetting(env);
  if (setting === "off") return "off";
  if (setting === "all") return "on";
  return (await phoneBetaHas(env, userId)) ? "on" : "soon";
}

/** The plan's minutes: none on a free plan the free-plan checks hold, as with free hours. */
function includedMinutes(account: AccountRow): number {
  const plan = planIdOf(account);
  if (plan === "free" && (account.free_refused_at != null || account.free_github_hold != null)) return 0;
  return CLOUD_PLANS[plan].phoneMinutes;
}

/** Extra minutes are sold once both Stripe settings are set. */
export function extraPhoneOffered(env: Pick<CloudEnv, "STRIPE_PHONE_MINUTE_PRICE_ID" | "STRIPE_PHONE_METER_EVENT">): boolean {
  return Boolean(env.STRIPE_PHONE_MINUTE_PRICE_ID?.trim() && env.STRIPE_PHONE_METER_EVENT?.trim());
}

/** This period's own value of a per-period column: a value from another period counts as none. */
function inPeriod(account: AccountRow, value: number | null | undefined): number {
  return account.phone_extra_period_start === account.period_start ? Math.max(0, value ?? 0) : 0;
}

export type PhoneUsage = {
  included: number;
  used: number;
  left: number;
  state: CloudPhoneMinutesState;
  extra: {
    available: boolean;
    enabled: boolean;
    limitCents: number | null;
    /** Minutes past the plan that are billed (or will be): within the limit while on, what was owed when it went off. */
    billableMinutes: number;
    /** Extra minutes a new phone may still use. */
    leftMinutes: number;
  };
};

/** Where an account's minutes stand. `settledOnly` leaves out the running phone's estimate (for billing). */
export function phoneUsageOf(env: CloudEnv, account: AccountRow, rows: PhoneRow[], now: number, settledOnly = false): PhoneUsage {
  const included = includedMinutes(account);
  const used = minutesUsed(rows, now, settledOnly);
  const available = extraPhoneOffered(env) && accountRules(account) === "paid";
  const enabled = available && account.phone_extra_enabled === 1;
  const limitCents = account.phone_extra_limit_cents ?? null;
  const limitMinutes = limitCents == null ? Number.POSITIVE_INFINITY : Math.floor(limitCents / EXTRA_PHONE_MINUTE_CENTS);
  const extraUsed = Math.max(0, used - included);
  const billableMinutes = enabled ? Math.min(extraUsed, limitMinutes) : inPeriod(account, account.phone_extra_owed_minutes);
  const leftMinutes = enabled ? Math.max(0, limitMinutes - extraUsed) : 0;
  const state: CloudPhoneMinutesState = included > 0 && used >= included ? "zero" : included > 0 && used >= included * 0.8 ? "warn80" : "none";
  return {
    included,
    used,
    left: Math.max(0, included - used),
    state,
    extra: { available, enabled, limitCents, billableMinutes, leftMinutes: Number.isFinite(leftMinutes) ? leftMinutes : PHONE_MAX_MINUTES },
  };
}

const minutesOf = (usage: PhoneUsage): CloudPhoneMinutes => ({ included: usage.included, used: usage.used, left: usage.left });

/** `CloudAccountState.phone`, from D1 alone (no call to NoMac): the account read is polled. */
export async function phoneAccountState(env: CloudEnv, account: AccountRow, now: number): Promise<CloudAccountPhone> {
  const access = await phoneAccess(env, account.user_id);
  const usage = phoneUsageOf(env, account, await periodPhones(env, account.user_id, account.period_start), now);
  return {
    access,
    minutes: access === "on" ? minutesOf(usage) : null,
    state: access === "on" ? usage.state : "none",
    extra: {
      available: usage.extra.available,
      enabled: usage.extra.enabled,
      centsPerMinute: usage.extra.available ? EXTRA_PHONE_MINUTE_CENTS : null,
      monthlyLimitCents: usage.extra.limitCents,
      usedMinutes: usage.extra.billableMinutes,
      usedCents: Math.round(usage.extra.billableMinutes * EXTRA_PHONE_MINUTE_CENTS),
    },
  };
}

/* ---- The phone as ADE shows it ---- */

function summaryOfSession(session: NomacSession, stopNotice: unknown): CloudPhoneSummary {
  const live = LIVE_STATES.has(session.state);
  const notice = stopNotice as { message?: unknown } | null | undefined;
  return {
    id: session.id,
    state: session.state === "ready" ? "ready" : live ? "starting" : "ended",
    device: session.device ?? "iphone",
    readyAt: isoMs(session.ready_at),
    queueUntil: session.state === "queued" ? isoMs(session.queue_expires_at) : null,
    endReason: live ? null : session.ended?.reason ?? session.end_reason ?? session.failure_code ?? null,
    stopNotice: typeof notice?.message === "string" ? notice.message : null,
  };
}

type PhoneContext = {
  account: AccountRow;
  label: string;
  usage: PhoneUsage;
  /** The account's live phone as NoMac answers it now, or null. */
  live: { session: NomacSession; stopNotice: unknown } | null;
};

/** The account, its usage and its live phone: one NoMac read, and only when a phone is live. */
async function phoneContext(env: CloudEnv, userId: string, now: number): Promise<PhoneContext | Response> {
  const label = phoneLabelFor(userId);
  if (!label) {
    logCloud("cloud.phone_label_unusable", { userId });
    return fail("phone_unavailable", "The ADE Cloud iPhone can't be used with this account.", 400);
  }
  const account = await loadAccount(env, userId, now);
  let rows = await periodPhones(env, userId, account.period_start);
  let live: PhoneContext["live"] = null;
  const liveRow = rows.find((row) => row.state === "live") ?? await env.DB.prepare("select * from cloud_phones where user_id = ? and state = 'live' order by created_at desc limit 1").bind(userId).first<PhoneRow>();
  if (liveRow) {
    const read = await readSession(env, liveRow.phone_id);
    if (read) {
      await savePhone(env, userId, read.session, now);
      if (LIVE_STATES.has(read.session.state)) live = read;
      rows = await periodPhones(env, userId, account.period_start);
    }
  }
  return { account, label, usage: phoneUsageOf(env, account, rows, now), live };
}

async function phoneToken(env: PhoneEnv, sessionId: string, userId: string): Promise<{ token: string; expiresAt: number } | Response> {
  const answer = await nomac(env, "POST", `/api/v1/simulator/sessions/${encodeURIComponent(sessionId)}/token`, { minutes: TOKEN_MINUTES });
  const token = answer.body?.token;
  const expiresAt = isoMs(answer.body?.expires_at);
  if (answer.status !== 200 || typeof token !== "string" || !token.startsWith("nmp_") || expiresAt == null) {
    return providerFailure("cloud.phone_token_failed", answer, userId);
  }
  return { token, expiresAt };
}

const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** NoMac's visitor signature (HS256 over `{ sub, sid, iat, exp }` with the `nme_` embed secret). */
export async function signPhoneVisitor(secret: string, sessionId: string, visitor: string, now: number): Promise<string> {
  const encoder = new TextEncoder();
  const issued = Math.floor(now / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({ sub: visitor, sid: sessionId, iat: issued, exp: issued + VISITOR_SECONDS })));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(mac)}`;
}

/* ---- Routes ---- */

function readDevice(value: unknown): CloudPhoneDevice | null | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && (CLOUD_PHONE_DEVICES as readonly string[]).includes(value) ? value as CloudPhoneDevice : null;
}

const formatDay = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** Why a new phone may not start, as the person reads it, or null when it may. */
function startRefusal(context: PhoneContext): Response | null {
  const { usage, account } = context;
  if (usage.left > 0 || usage.extra.leftMinutes > 0) return null;
  const resets = formatDay(account.period_end);
  if (usage.included === 0 && accountRules(account) === "free") {
    return fail("phone_free_held", "The free plan's iPhone minutes need the same check as its free hours. Finish it in Settings › ADE Cloud, or pick a plan.", 402, { minutes: minutesOf(usage) });
  }
  if (usage.extra.enabled) {
    const limit = usage.extra.limitCents != null ? `$${(usage.extra.limitCents / 100).toFixed(0)}` : "your";
    return fail("phone_extra_limit", `Extra iPhone minutes reached ${limit} monthly limit. Raise it in Settings › ADE Cloud, or wait until ${resets}.`, 402, { minutes: minutesOf(usage) });
  }
  const next = usage.extra.available
    ? "Turn on extra iPhone minutes in Settings › ADE Cloud to keep going"
    : accountRules(account) === "free" ? "Pick a plan in Settings › ADE Cloud for more" : "They come back";
  return fail("phone_minutes_out", `Your plan's ${usage.included} ADE Cloud iPhone minutes are used up. ${next}, or wait until ${resets}.`, 402, { minutes: minutesOf(usage) });
}

/**
 * `/cloud/phone`, `/cloud/phone/token`, `/cloud/phone/view` for a signed-in
 * caller (`routes.ts` checked the sign-in and the owner's block first).
 */
export async function routePhone(request: Request, path: string, env: CloudEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  if (path !== CLOUD_PATHS.phone && path !== CLOUD_PATHS.phoneToken && path !== CLOUD_PATHS.phoneView) return null;
  const access = await phoneAccess(env, userId);

  if (path === CLOUD_PATHS.phone && request.method === "GET") {
    if (access !== "on") return json({ access, minutes: null, phone: null } satisfies CloudPhoneState);
    const context = await phoneContext(env, userId, now);
    if (context instanceof Response) return context;
    return json({
      access,
      minutes: minutesOf(context.usage),
      phone: context.live ? summaryOfSession(context.live.session, context.live.stopNotice) : null,
    } satisfies CloudPhoneState);
  }

  if (access === "off") return fail("phone_unavailable", "The ADE Cloud iPhone isn't available right now.", 503);
  if (access === "soon") return fail("phone_not_on_account", "The ADE Cloud iPhone is coming soon. It isn't on this account yet.", 403);
  const context = await phoneContext(env, userId, now);
  if (context instanceof Response) return context;
  const plan = planIdOf(context.account);

  if (path === CLOUD_PATHS.phone && request.method === "DELETE") {
    if (!context.live) return json({ ok: true, stopped: false });
    const phoneId = context.live.session.id;
    const answer = await nomac(env, "DELETE", `/api/v1/simulator/sessions/${encodeURIComponent(phoneId)}`);
    if (answer.status >= 400) return providerFailure("cloud.phone_stop_failed", answer, userId);
    const after = await readSession(env, phoneId);
    if (after) await savePhone(env, userId, after.session, now);
    logCloud("cloud.phone_stopped", { userId, phoneId });
    return json({ ok: true, stopped: true });
  }

  if (path === CLOUD_PATHS.phone && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return fail("bad_request", "That request could not be read.", 400);
    const device = readDevice(body.device);
    if (device === null) return fail("bad_request", `device is one of ${CLOUD_PHONE_DEVICES.join(", ")}.`, 400);
    let session = context.live?.session ?? null;
    let reused = Boolean(session);
    if (session && device && session.device && session.device !== device) {
      return fail("phone_running", `Your ADE Cloud iPhone is already running as ${session.device}. Stop it first to start a ${device}.`, 409);
    }
    if (!session) {
      if (env.CLOUD_PHONES_PAUSED?.trim() === "1") {
        captureCloudPhone(env, waitUntil, userId, { step: "refused", plan, reason: "paused" }, "paused", now);
        return fail("phone_paused", "New ADE Cloud iPhones are paused for a moment. Try again soon.", 503);
      }
      // The owner's free-use cap refuses a new free phone as it refuses a new free computer (never naming why).
      if (await freeCapRefuses(env, context.account, now, waitUntil)) {
        captureCloudPhone(env, waitUntil, userId, { step: "refused", plan, reason: "free_cap" }, "free_cap", now);
        return fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. Try again soon.", 503);
      }
      const refusal = startRefusal(context);
      if (refusal) {
        const code = (await refusal.clone().json().catch(() => null) as { error?: { code?: string } } | null)?.error?.code ?? "refused";
        logCloud("cloud.phone_start_refused", { userId, code, included: context.usage.included, used: context.usage.used });
        captureCloudPhone(env, waitUntil, userId, { step: "refused", plan, reason: code }, code, now);
        return refusal;
      }
      // What this phone may use: the plan's minutes left, then extra minutes, and never more than one phone's longest.
      const minutes = Math.min(PHONE_MAX_MINUTES, context.usage.left + context.usage.extra.leftMinutes);
      const answer = await nomac(env, "POST", "/api/v1/simulator/sessions", {
        label: context.label,
        reuse: true,
        ...(device ? { device } : {}),
        limits: {
          max_duration_seconds: minutes * 60,
          idle_timeout_seconds: PHONE_IDLE_SECONDS,
          spend_cap_microunits: String(minutes * NOMAC_MICROS_PER_MINUTE),
        },
      }, `ade-phone-${userId}-${Math.floor(now / 10_000)}`);
      session = sessionOf(answer.body?.session);
      if (answer.status >= 400 || !session) return providerFailure("cloud.phone_start_failed", answer, userId);
      reused = answer.body?.reused === true;
      await savePhone(env, userId, session, now, accountRules(context.account) === "free");
      logCloud("cloud.phone_started", { userId, phoneId: session.id, reused, device: session.device ?? "iphone", minutes, extra: context.usage.left === 0 });
      if (!reused) {
        captureCloudPhone(env, waitUntil, userId, {
          step: "started",
          plan,
          device: session.device ?? "iphone",
          minutesLeft: context.usage.left,
          extra: context.usage.left === 0,
        }, session.id, now);
      }
    }
    const token = await phoneToken(env, session.id, userId);
    if (token instanceof Response) return token;
    return json({ phone: summaryOfSession(session, null), reused, token, minutes: minutesOf(context.usage), apiBase: NOMAC_SIMULATOR_BASE } satisfies CloudPhoneStart);
  }

  if (request.method !== "POST") return fail("not_found", "ADE Cloud has no such route.", 404);
  const live = context.live?.session ?? null;
  if (!live) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running. Start it first.", 409);

  if (path === CLOUD_PATHS.phoneToken) {
    const token = await phoneToken(env, live.id, userId);
    if (token instanceof Response) return token;
    return json({ phone: summaryOfSession(live, context.live?.stopNotice), reused: true, token, minutes: minutesOf(context.usage), apiBase: NOMAC_SIMULATOR_BASE } satisfies CloudPhoneStart);
  }

  // The view: a control link by default (the person uses the phone in the pane).
  const body = await readJson(request);
  const control = body?.control !== false;
  const secret = env.NOMAC_EMBED_SECRET?.trim() || null;
  const answer = await nomac(env, "POST", `/api/v1/simulator/sessions/${encodeURIComponent(live.id)}/view`, {
    control,
    minutes: VIEW_MINUTES,
    ...(secret ? { visitor: context.label } : {}),
  });
  const url = answer.body?.url;
  const expiresAt = isoMs(answer.body?.expires_at);
  if (answer.status !== 200 || typeof url !== "string" || !url.startsWith(`${NOMAC_ORIGIN}/`) || expiresAt == null) {
    return providerFailure("cloud.phone_view_failed", answer, userId);
  }
  // Signed for this account alone: a copied link opens nothing. Without a secret
  // set up, the link itself is the permission (2 hours, this phone only).
  const signed = secret ? `${url}#visitor=${await signPhoneVisitor(secret, live.id, context.label, now)}` : url;
  return json({ url: signed, expiresAt, control } satisfies CloudPhoneView);
}

/* ---- NoMac's webhook ---- */

export const isNomacWebhookRequest = (path: string, method: string): boolean => path === CLOUD_PATHS.nomacWebhook && method === "POST";

const hexOf = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** `nomac-signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, fresh and matching, compared in constant time. */
async function nomacSignatureValid(secret: string, header: string | null, raw: string, now: number): Promise<boolean> {
  if (!header) return false;
  const parts = new Map(header.split(",").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
  }));
  const t = Number(parts.get("t"));
  const given = parts.get("v1") ?? "";
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hexOf(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.get("t")}.${raw}`)));
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ given.toLowerCase().charCodeAt(index);
  return diff === 0;
}

/**
 * `POST /cloud/nomac/webhook`: NoMac's signed deliveries. A phone's ready and
 * end settle its row (an end with its billed minutes and cost); low credit
 * alerts the owner. Each delivery id is taken once. Answers 2xx quickly:
 * NoMac retries anything else for an hour.
 */
export async function handleNomacWebhook(request: Request, env: CloudEnv, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  const secret = env.NOMAC_WEBHOOK_SECRET?.trim();
  if (!secret) return fail("unavailable", "The NoMac webhook isn't set up.", 503);
  const raw = await request.text();
  if (raw.length > 256_000 || !(await nomacSignatureValid(secret, request.headers.get("nomac-signature"), raw, now))) {
    logCloud("cloud.nomac_webhook_refused", {});
    return fail("unauthorized", "That signature isn't valid.", 401);
  }
  type Delivery = { id?: unknown; type?: unknown; data?: { session?: unknown } };
  const event = ((): Delivery | null => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Delivery : null;
    } catch {
      return null;
    }
  })();
  if (!event) return fail("bad_request", "That delivery could not be read.", 400);
  const id = typeof event?.id === "string" && event.id ? event.id : request.headers.get("nomac-delivery");
  const type = typeof event?.type === "string" ? event.type : "";
  if (!id) return fail("bad_request", "That delivery has no id.", 400);
  const taken = await env.DB.prepare("insert or ignore into cloud_nomac_deliveries (id, received_at) values (?, ?)").bind(id, now).run();
  if ((taken.meta?.changes ?? 0) !== 1) return json({ ok: true, duplicate: true });

  if (type.startsWith("phone.")) {
    const session = sessionOf(event?.data?.session);
    const userId = userIdOfLabel(session?.label);
    if (session && userId) {
      const before = await env.DB.prepare("select state from cloud_phones where phone_id = ?").bind(session.id).first<{ state: string }>();
      await savePhone(env, userId, session, now);
      if (type === "phone.ended" && before?.state !== "ended") {
        const account = await env.DB.prepare("select plan, paid_plan, stripe_status from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
        captureCloudPhone(env, waitUntil, userId, {
          step: "ended",
          plan: account ? planIdOf(account) : "free",
          device: session.device ?? "iphone",
          reason: session.ended?.reason ?? session.end_reason ?? "stopped",
          billedMinutes: Math.ceil(Number(session.cost?.billed_seconds ?? 0) / 60),
        }, session.id, now);
      }
    }
  } else if (type === "credit.low") {
    const day = new Date(now).toISOString().slice(0, 10);
    await sendOwnerAlert(env, {
      key: `nomac_credit_low:${day}`,
      kind: "nomac_credit_low",
      userId: null,
      subject: "ADE Cloud: NoMac credit is low",
      reason: "NoMac's prepaid credit covers less than an hour of the phones running now. Add credit at nomac.app before every ADE Cloud iPhone stops.",
    }, now, waitUntil);
  }
  return json({ ok: true });
}

/* ---- The ten-minute check (`cron.ts`) ---- */

const PHONE_WARNINGS: Record<Exclude<CloudPhoneMinutesState, "none">, { column: "phone_warned_80_at" | "phone_warned_zero_at"; subject: string }> = {
  warn80: { column: "phone_warned_80_at", subject: "You've used 80% of your ADE Cloud iPhone minutes" },
  zero: { column: "phone_warned_zero_at", subject: "You're out of ADE Cloud iPhone minutes" },
};

function warningText(state: Exclude<CloudPhoneMinutesState, "none">, usage: PhoneUsage, account: AccountRow): string {
  const resets = formatDay(account.period_end);
  if (usage.extra.enabled) {
    return state === "zero"
      ? `Extra iPhone minutes are on, so your iPhone keeps going at ${EXTRA_PHONE_MINUTE_CENTS}¢ a minute${usage.extra.limitCents != null ? ` up to your $${(usage.extra.limitCents / 100).toFixed(0)} monthly limit` : ""}. Your minutes reset on ${resets}.`
      : `Extra iPhone minutes are on, so your iPhone keeps going past your plan. Your minutes reset on ${resets}.`;
  }
  const more = usage.extra.available ? " or you turn on extra iPhone minutes in Settings › ADE Cloud" : "";
  return state === "zero"
    ? `Your ADE Cloud iPhone stops until your minutes reset on ${resets}${more}.`
    : `Your iPhone keeps working for now. When your minutes run out, it stops until they reset on ${resets}${more}.`;
}

/** The 80% and out-of-minutes emails, once each a period. */
async function warnPhoneMinutes(env: CloudEnv, account: AccountRow, usage: PhoneUsage, now: number): Promise<void> {
  if (usage.state === "none" || usage.included === 0) return;
  if (account.phone_warned_period_start !== account.period_start) {
    await env.DB.prepare("update cloud_accounts set phone_warned_80_at = null, phone_warned_zero_at = null, phone_warned_period_start = ? where user_id = ? and phone_warned_period_start is not ?")
      .bind(account.period_start, account.user_id, account.period_start).run();
    account = { ...account, phone_warned_80_at: null, phone_warned_zero_at: null, phone_warned_period_start: account.period_start };
  }
  const warning = PHONE_WARNINGS[usage.state];
  if (account[warning.column] != null) return;
  const claimed = await env.DB.prepare(`update cloud_accounts set ${warning.column} = ?, updated_at = ? where user_id = ? and ${warning.column} is null`)
    .bind(now, now, account.user_id).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  await sendCloudEmail(env, { userId: account.user_id, subject: warning.subject, text: warningText(usage.state, usage, account) });
  logCloud("cloud.phone_minutes_warned", { userId: account.user_id, state: usage.state });
}

/**
 * Every ten minutes: live phones are read from NoMac (a missed webhook can't
 * leave one counted forever), each account that used its phone in the last
 * day is warned at 80% and at its end, and old delivery ids are dropped.
 * Extra minutes go to Stripe from `billing.ts` (`reportExtraPhoneMinutes`).
 */
export async function runPhoneChecks(env: CloudEnv, now: number): Promise<void> {
  if (!env.NOMAC_API_KEY?.trim()) return;
  const live = await env.DB.prepare("select phone_id, user_id, created_at, updated_at from cloud_phones where state = 'live' order by updated_at limit ?")
    .bind(CHECK_BATCH).all<Pick<PhoneRow, "phone_id" | "user_id" | "created_at" | "updated_at">>();
  for (const row of live.results ?? []) {
    // A phone read in the last few minutes (a pane open, a webhook) is fresh enough.
    if (now - row.updated_at < 5 * 60_000 && now - row.created_at < LIVE_STALE_MS) continue;
    try {
      const read = await readSession(env, row.phone_id);
      if (read) await savePhone(env, row.user_id, read.session, now);
    } catch (error) {
      reportCloudFailure("cloud.phone_check_read_failed", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  // A live phone past what its account may use now ends (`stopPhoneOverAllowance`).
  for (const userId of new Set((live.results ?? []).map((row) => row.user_id))) {
    try {
      const account = await loadAccount(env, userId, now);
      const usage = phoneUsageOf(env, account, await periodPhones(env, userId, account.period_start), now);
      if (usage.left === 0 && usage.extra.leftMinutes === 0) await stopPhoneOverAllowance(env, userId, now);
    } catch (error) {
      reportCloudFailure("cloud.phone_allowance_check_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  const active = await env.DB.prepare("select distinct user_id from cloud_phones where updated_at >= ? limit ?").bind(now - 24 * 60 * 60_000, CHECK_BATCH).all<{ user_id: string }>();
  for (const { user_id: userId } of active.results ?? []) {
    try {
      const account = await loadAccount(env, userId, now);
      if ((await phoneAccess(env, userId)) !== "on") continue;
      const usage = phoneUsageOf(env, account, await periodPhones(env, userId, account.period_start), now);
      await warnPhoneMinutes(env, account, usage, now);
    } catch (error) {
      reportCloudFailure("cloud.phone_warning_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  await env.DB.prepare("delete from cloud_nomac_deliveries where received_at < ?").bind(now - DELIVERY_KEEP_MS).run();
}

/**
 * Stops the account's live phone once the account may use no more minutes:
 * the plan's are used and extra minutes are off or at their limit. A phone's
 * NoMac limits are set when it starts, so this is what ends one after extra
 * minutes go off or their limit drops: no minute runs that nobody pays for.
 * Reads the phone from NoMac first, so its minutes are current. Answers
 * whether it stopped one.
 */
export async function stopPhoneOverAllowance(env: CloudEnv, userId: string, now: number): Promise<boolean> {
  const context = await phoneContext(env, userId, now);
  if (context instanceof Response || !context.live) return false;
  if (context.usage.left > 0 || context.usage.extra.leftMinutes > 0) return false;
  const phoneId = context.live.session.id;
  const answer = await nomac(env, "DELETE", `/api/v1/simulator/sessions/${encodeURIComponent(phoneId)}`);
  if (answer.status >= 400 && answer.status !== 404) {
    logCloud("cloud.phone_over_allowance_stop_failed", { userId, phoneId, status: answer.status });
    return false;
  }
  const after = await readSession(env, phoneId);
  if (after) await savePhone(env, userId, after.session, now);
  logCloud("cloud.phone_over_allowance_stopped", { userId, phoneId, used: context.usage.used, included: context.usage.included });
  return true;
}

/** The settled usage `billing.ts` bills from: NoMac's billed minutes only, never an estimate. */
export async function settledPhoneUsage(env: CloudEnv, account: AccountRow, now: number): Promise<PhoneUsage> {
  return phoneUsageOf(env, account, await periodPhones(env, account.user_id, account.period_start), now, true);
}

/* ---- The owner's beta list ---- */

export const OWNER_PHONE_BETA_PATH = "/cloud/owner/phone-beta";

const CLERK_USERS_URL = "https://api.clerk.com/v1/users";

/** The Clerk user ids with this address, or null when Clerk can't be asked. */
async function clerkUserIdsFor(env: Pick<CloudEnv, "CLERK_SECRET_KEY">, email: string): Promise<string[] | null> {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return null;
  const response = await fetch(`${CLERK_USERS_URL}?email_address=${encodeURIComponent(email)}&limit=10`, {
    headers: { authorization: `Bearer ${secretKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const users = await response.json().catch(() => null) as unknown;
  return Array.isArray(users) ? users.flatMap((user) => typeof (user as { id?: unknown })?.id === "string" ? [(user as { id: string }).id] : []) : null;
}

/**
 * `POST /cloud/owner/phone-beta` `{ email? | userId?, enabled? }` adds (or with
 * `enabled: false` removes) an account; `{}` lists the list. `safety.ts`
 * checked the owner's token before this runs. An email is looked up in Clerk
 * once; the list keeps the user id (and the address the owner typed, for the
 * owner's own reading). With `CLOUD_PHONE_ACCESS=all` the list no longer
 * matters.
 */
export async function handleOwnerPhoneBeta(env: CloudEnv, body: Record<string, unknown>, now: number): Promise<Response> {
  const typedEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const typedUserId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!typedEmail && !typedUserId) {
    const rows = await env.DB.prepare("select user_id, email, added_at from cloud_phone_beta order by added_at").all<{ user_id: string; email: string | null; added_at: number }>();
    return json({ ok: true, access: phoneAccessSetting(env), users: rows.results ?? [] });
  }
  if (typedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail)) return fail("bad_request", "That email isn't valid.", 400);
  if (typedUserId && !/^[A-Za-z0-9_-]{1,100}$/.test(typedUserId)) return fail("bad_request", "That userId isn't valid.", 400);
  let userIds = typedUserId ? [typedUserId] : [];
  if (!userIds.length) {
    const found = await clerkUserIdsFor(env, typedEmail);
    if (found == null) return fail("unavailable", "Clerk could not be asked for that email. Try again, or pass userId.", 503);
    if (!found.length) return fail("not_found", "No ADE account has that email.", 404);
    userIds = found;
  }
  if (body.enabled === false) {
    for (const userId of userIds) await env.DB.prepare("delete from cloud_phone_beta where user_id = ?").bind(userId).run();
    logCloud("cloud.phone_beta_removed", { count: userIds.length });
    return json({ ok: true, removed: userIds });
  }
  for (const userId of userIds) {
    await env.DB.prepare("insert into cloud_phone_beta (user_id, email, added_at) values (?, ?, ?) on conflict(user_id) do update set email = coalesce(excluded.email, cloud_phone_beta.email)")
      .bind(userId, typedEmail || null, now).run();
  }
  logCloud("cloud.phone_beta_added", { count: userIds.length });
  return json({ ok: true, added: userIds });
}

/**
 * An account's deletion: its phone stops, NoMac forgets what it kept for the
 * label (saved states, replays, workspace), and it leaves the beta list. Its
 * `cloud_phones` rows are re-keyed by `accountDeletion.ts` (the cost report
 * keeps them). NoMac's billing records stay under the label (an id, never an
 * email). Throws while NoMac still saves the last phone's replay, so the
 * deletion is retried.
 */
export async function deleteAccountPhone(env: Pick<CloudEnv, "DB" | "NOMAC_API_KEY">, userId: string): Promise<void> {
  await env.DB.prepare("delete from cloud_phone_beta where user_id = ?").bind(userId).run();
  const label = phoneLabelFor(userId);
  if (!label || !env.NOMAC_API_KEY?.trim()) return;
  const listed = await nomac(env, "GET", `/api/v1/simulator/sessions?${new URLSearchParams({ label, limit: "100" }).toString()}`);
  const sessions = Array.isArray(listed.body?.sessions) ? (listed.body.sessions as unknown[]).map(sessionOf) : [];
  for (const session of sessions) {
    if (session && LIVE_STATES.has(session.state)) await nomac(env, "DELETE", `/api/v1/simulator/sessions/${encodeURIComponent(session.id)}`);
  }
  if (!sessions.length) return;
  const answer = await nomac(env, "DELETE", `/api/v1/simulator/labels/${encodeURIComponent(label)}`);
  if (answer.status >= 400 && answer.status !== 404) throw new Error(`phone_label_delete_${errorOf(answer).code}`);
}
