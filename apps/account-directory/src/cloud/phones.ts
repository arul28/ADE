/**
 * The ADE Cloud iPhone: an iOS Simulator on NoMac or on Revyl, one per ADE
 * account.
 *
 * Which provider: `CLOUD_PHONE_PROVIDER` (`nomac`, the default, or `revyl`),
 * or the owner's per-account choice on the beta list (testers). A provider
 * with no key set is never picked. Every phone keeps the provider it started
 * on (`cloud_phones.provider`), so a change of setting reaches only new phones.
 * Revyl's side is `phoneRevyl.ts`; the rest of this file is the same for both.
 *
 * NoMac's account key (`NOMAC_API_KEY`) lives only here. A brain gets a token
 * for one phone (it can drive that phone, never start, list or stop one) and a
 * person's window gets a view link signed for their account alone. Revyl has
 * no per-phone token, so its calls go through `POST /cloud/phone/call`. See
 * docs/features/apple-device/ade-cloud-iphone.md and
 * docs/plans/ade-cloud-iphone-launch.md.
 *
 * Who may use it: `CLOUD_PHONE_ACCESS` (`beta`, the default: the owner's list
 * in `cloud_phone_beta`; `all`; `off`). `CLOUD_PHONES_PAUSED=1` refuses new
 * phones while running ones finish.
 *
 * Minutes: the plan's `phoneMinutes` a period (0 on a free plan held by the
 * free-plan checks, as free hours are). Each phone is a `cloud_phones` row,
 * counted in the period it started in, settled by NoMac's signed webhook and,
 * for one that was missed, by the ten-minute check. A paid plan with extra
 * iPhone minutes on keeps going past its minutes at `EXTRA_PHONE_MINUTE_CENTS`,
 * up to its monthly limit; the free plan stops (`phoneBilling.ts` bills them).
 *
 * The guard: every phone starts with NoMac's own spend cap and time limit set
 * to what the account may still use, so it stops by itself there. What the
 * account may use can shrink while it runs (extra minutes off, a lower limit,
 * a new period, access or the account taken away), and NoMac can't lower a
 * running phone's limit, so the phone gets a `stop_at` here and the minute tick
 * stops it then (`enforcePhoneAllowance`, `stopPhonesDue`). ADE never pays for
 * a minute nobody pays for.
 */

import { isCloudBlocked, sendOwnerAlert } from "./blocks";
import { captureCloudPhone, type CloudWaitUntil } from "./analytics";
import { freeCapRefuses } from "./costReport";
import { readComputerSignal, settleFreePlanComputer } from "./freePlan";
import { settleFreePlanGithub } from "./freePlanGithub";
import { CLOUD_PLANS, EXTRA_PHONE_MINUTE_CENTS } from "./plans";
import {
  CLOUD_DELETED_ACCOUNT_PREFIX,
  CLOUD_PATHS,
  CLOUD_PHONE_DEVICES,
  CLOUD_PHONE_PROVIDERS,
  CLOUD_PHONE_RECENT_SHOWN,
  isCloudPhoneDevice,
  isCloudPhoneProvider,
  type CloudAccountPhone,
  type CloudPhoneAccess,
  type CloudPhoneDevice,
  type CloudPhoneMinutes,
  type CloudPhoneMinutesState,
  type CloudPhoneProvider,
  type CloudPhoneStart,
  type CloudPhoneState,
  type CloudPhoneSummary,
  type CloudPhoneUse,
  type CloudPhoneView,
} from "./contract";
import { readBoundedBody } from "../sinkUtils";
import {
  forgetRevylAccount,
  readRevylPhone,
  revylConfigured,
  revylEnabled,
  revylViewUrl,
  revylViewerPage,
  routeRevylCall,
  startRevylPhone,
  stopRevylPhone,
} from "./phoneRevyl";
import { CLOUD_PHONE_IDLE_SECONDS, CLOUD_PHONE_MAX_MINUTES } from "../../../desktop/src/shared/cloudPhone";
import { sendCloudEmail } from "./email";
import { fail, json, readJson } from "./http";
import { PHONE_EXTRA, accountRules, loadAccount, logCloud, phoneBetaAddStatement, planIdOf, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

const NOMAC_ORIGIN = "https://nomac.app";
const NOMAC_SIMULATOR_BASE = `${NOMAC_ORIGIN}/api/v1/simulator`;
const REQUEST_TIMEOUT_MS = 20_000;
/** NoMac's price for a phone: $0.90 an hour, billed per whole minute. The spend cap is counted in it. */
const NOMAC_MICROS_PER_MINUTE = 15_000;
/** The token a brain drives the phone with. */
const TOKEN_MINUTES = 120;
/** A view link's life; the visitor signature inside it lives far shorter (NoMac's own ceiling is 15 min). */
const VIEW_MINUTES = 120;
const VISITOR_SECONDS = 600;
/** NoMac's signature on a webhook older than this is refused. */
const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Webhook delivery ids are kept this long against repeats. */
const DELIVERY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** The ten-minute check reads at most this many live phones, and accounts to warn, a run. */
const CHECK_BATCH = 200;
/** The minute tick stops at most this many phones whose time ran out. */
const STOPS_PER_TICK = 50;
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
  /** Who runs it (absent: NoMac), and the provider's own second id for it (Revyl's workflow run). */
  provider?: CloudPhoneProvider;
  ref?: string | null;
};

type NomacAnswer = { status: number; body: Record<string, unknown> | null };

/** A `cloud_phones` row (migration 0048). */
export type PhoneRow = {
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
  /** When the account stops paying for this live phone (ms), or null: its NoMac limits are the stop. */
  stop_at: number | null;
  updated_at: number;
  /** Who runs it (migration 0054): `nomac` for every phone before then. */
  provider: CloudPhoneProvider;
  /** Revyl's workflow run for the phone, which its device calls name; null for NoMac. */
  provider_ref: string | null;
};

/* ---- NoMac ---- */

/** NoMac's label for an ADE account: its id, never an email. */
function phoneLabelFor(userId: string): string | null {
  const label = `ade:${userId}`;
  return /^[A-Za-z0-9._:@-]{1,64}$/.test(label) ? label : null;
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

/** NoMac's code as a Sentry event name part: its own closed codes, or `http_<status>`. */
const sentryCode = (code: string): string => code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "unknown";

/**
 * NoMac failed us: logged with its code (never a credential), sent to Sentry
 * per event and code (its phone limit, a 5xx and a refusal each their own
 * issue), and answered as one plain sentence.
 */
function providerFailure(event: string, answer: NomacAnswer, userId: string): Response {
  const { code, message } = errorOf(answer);
  reportCloudFailure(`${event}.${sentryCode(code)}`, { userId, status: answer.status, code }, "cloud-phone");
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

/** Why a phone ended, in NoMac's words, once it has. */
const endReasonOf = (session: NomacSession): string | null => session.ended?.reason ?? session.end_reason ?? session.failure_code ?? null;

/** One phone as NoMac answers it now, or null when it can't be read. */
async function readSession(env: Pick<CloudEnv, "NOMAC_API_KEY">, phoneId: string): Promise<{ session: NomacSession; stopNotice: unknown } | null> {
  // A timeout or a dropped connection is unreadable, like a 5xx: callers fall back to the phone id they know.
  const answer = await nomac(env, "GET", `/api/v1/simulator/sessions/${encodeURIComponent(phoneId)}`).catch((): NomacAnswer => ({ status: 504, body: null }));
  const session = sessionOf(answer.body?.session);
  return answer.status === 200 && session ? { session, stopNotice: answer.body?.stop_notice } : null;
}

/** Where a known phone runs: its row's provider, its second id and its model. */
type PhoneWhere = { provider: CloudPhoneProvider; ref: string | null; device: string | null };

/** One phone as its provider answers it now, or null when it can't be read. */
async function readPhone(env: CloudEnv, userId: string, phoneId: string, where: PhoneWhere): Promise<{ session: NomacSession; stopNotice: unknown } | null> {
  if (where.provider !== "revyl") return readSession(env, phoneId);
  const session = await readRevylPhone(env, userId, phoneId, where.device).catch(() => null);
  return session ? { session: { ...session, provider: "revyl", ref: session.ref ?? where.ref }, stopNotice: null } : null;
}

/** Where a phone this Worker keeps runs, from its row. */
async function phoneWhere(env: Pick<CloudEnv, "DB">, phoneId: string): Promise<PhoneWhere> {
  const row = await env.DB.prepare("select provider, provider_ref, device from cloud_phones where phone_id = ?").bind(phoneId).first<{ provider: string | null; provider_ref: string | null; device: string | null }>();
  return { provider: row?.provider === "revyl" ? "revyl" : "nomac", ref: row?.provider_ref ?? null, device: row?.device ?? null };
}

/* ---- The phones an account started (`cloud_phones`) ---- */

/** The columns NoMac's answer fills, in `savePhone`'s and `updatePhone`'s order. */
function phoneFacts(session: NomacSession, now: number) {
  const ended = !LIVE_STATES.has(session.state);
  return {
    ended,
    device: session.device ?? null,
    state: ended ? "ended" : "live",
    readyAt: isoMs(session.ready_at),
    endedAt: ended ? isoMs(session.ended?.at) ?? isoMs(session.shutdown_at) ?? now : null,
    billedSeconds: Math.max(0, Math.floor(Number(session.cost?.billed_seconds ?? 0)) || 0),
    costMicros: Math.max(0, Math.floor(Number(session.cost?.accrued_microunits ?? 0)) || 0),
    endReason: ended ? endReasonOf(session) : null,
  };
}

/** How a known row takes a newer answer: an ended phone never goes back to live, billed time and cost only grow. */
const PHONE_MERGE_SQL = `
  state = case when cloud_phones.state = 'ended' then 'ended' else excluded.state end,
  device = coalesce(excluded.device, cloud_phones.device),
  ready_at = coalesce(cloud_phones.ready_at, excluded.ready_at),
  ended_at = coalesce(cloud_phones.ended_at, excluded.ended_at),
  billed_seconds = max(cloud_phones.billed_seconds, excluded.billed_seconds),
  cost_micros = max(cloud_phones.cost_micros, excluded.cost_micros),
  end_reason = coalesce(cloud_phones.end_reason, excluded.end_reason),
  free = max(cloud_phones.free, excluded.free),
  provider_ref = coalesce(cloud_phones.provider_ref, excluded.provider_ref),
  updated_at = excluded.updated_at`;

/**
 * Keeps what NoMac said about a phone this account started. A late or
 * repeated answer can't undo a newer one (`PHONE_MERGE_SQL`). `free` is
 * whether the account was on free rules when the phone started.
 */
async function savePhone(env: Pick<CloudEnv, "DB">, userId: string, session: NomacSession, now: number, free = false, onlyLiveAccount = false): Promise<boolean> {
  const facts = phoneFacts(session, now);
  // `onlyLiveAccount`: a new row only while the account exists, checked in this write, so a deletion
  // that re-keyed its phones meanwhile never gets a row under the person's id back.
  const saved = await env.DB.prepare(`
    insert into cloud_phones (phone_id, user_id, device, state, created_at, ready_at, ended_at, billed_seconds, cost_micros, end_reason, free, updated_at, provider, provider_ref)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    where ? = 0 or exists (select 1 from cloud_accounts where user_id = ? and deleted_at is null)
    on conflict(phone_id) do update set ${PHONE_MERGE_SQL}
  `).bind(
    session.id, userId, facts.device, facts.state, isoMs(session.created_at) ?? now, facts.readyAt, facts.endedAt,
    facts.billedSeconds, facts.costMicros, facts.endReason, free ? 1 : 0, now, session.provider ?? "nomac", session.ref ?? null,
    onlyLiveAccount ? 1 : 0, userId,
  ).run();
  return (saved.meta.changes ?? 0) > 0;
}

/** The ADE account a NoMac label names (`ade:<userId>`), or null for a label ADE did not make. */
function userIdOfLabel(label: unknown): string | null {
  return typeof label === "string" && label.startsWith("ade:") && label.length > 4 ? label.slice(4) : null;
}

/**
 * NoMac's answer for a phone this Worker keeps. A phone with no row yet (its
 * start's answer was lost, or the save failed) is recovered when its label
 * names a live account this Worker has, so its minutes are still counted; another
 * environment's phones (accounts this Worker doesn't have) are left alone.
 * Answers the row's account and its state before, or null.
 */
async function updatePhone(env: Pick<CloudEnv, "DB">, session: NomacSession, now: number): Promise<{ userId: string; wasEnded: boolean } | null> {
  const known = await env.DB.prepare("select user_id, state from cloud_phones where phone_id = ?").bind(session.id).first<{ user_id: string; state: string }>();
  if (known) {
    await savePhone(env, known.user_id, session, now);
    return { userId: known.user_id, wasEnded: known.state === "ended" };
  }
  const userId = userIdOfLabel(session.label);
  const account = userId ? await env.DB.prepare("select plan, stripe_status from cloud_accounts where user_id = ? and deleted_at is null").bind(userId).first<Pick<AccountRow, "plan" | "stripe_status">>() : null;
  if (!userId || !account) return null;
  if (!(await savePhone(env, userId, session, now, accountRules(account) === "free", true))) return null;
  logCloud("cloud.phone_recovered", { userId, phoneId: session.id });
  return { userId, wasEnded: false };
}

/** The phones an account started in `[since, before)`. Billing counts only their settled minutes (`settledPhoneMinutes`). */
export async function periodPhones(env: Pick<CloudEnv, "DB">, userId: string, since: number, before = Number.MAX_SAFE_INTEGER): Promise<PhoneRow[]> {
  const rows = await env.DB.prepare("select * from cloud_phones where user_id = ? and created_at >= ? and created_at < ? order by created_at desc")
    .bind(userId, since, before).all<PhoneRow>();
  return rows.results ?? [];
}

/**
 * Minutes the phones used: NoMac's billed minutes, and for one running now,
 * its time so far (whole minutes, up; never past one phone's longest, so a row
 * stuck as live can't grow without end).
 */
function phoneMinutesUsed(rows: readonly PhoneRow[], now: number, settledOnly: boolean): number {
  let minutes = 0;
  for (const row of rows) minutes += rowMinutes(row, now, settledOnly);
  return minutes;
}

/** One phone's minutes: its provider's billed minutes, or for one running now its time so far. */
function rowMinutes(row: PhoneRow, now: number, settledOnly: boolean): number {
  const billed = Math.ceil(row.billed_seconds / 60);
  const running = row.state === "live" && row.ready_at != null && !settledOnly
    ? Math.min(CLOUD_PHONE_MAX_MINUTES, Math.ceil(Math.max(0, now - row.ready_at) / 60_000))
    : 0;
  return Math.max(billed, running);
}

/** The period's phones as a person reads where the minutes went (rows are newest first). */
function recentPhonesOf(rows: readonly PhoneRow[], now: number): CloudPhoneUse[] {
  return rows.slice(0, CLOUD_PHONE_RECENT_SHOWN).map((row) => ({
    startedAt: row.created_at,
    endedAt: row.state === "live" ? null : row.ended_at,
    minutes: rowMinutes(row, now, false),
    device: row.device,
    ended: row.state === "live" ? null : row.end_reason ?? "on_its_own",
  }));
}

/** Stops one phone at its provider and saves its end. Answers false when the provider refused (it is tried again later). */
async function stopPhone(env: CloudEnv, userId: string, phoneId: string, now: number, why: string): Promise<boolean> {
  const where = await phoneWhere(env, phoneId);
  const answer = where.provider === "revyl"
    ? { status: await stopRevylPhone(env, userId, phoneId).catch(() => 504), body: null }
    : await nomac(env, "DELETE", `/api/v1/simulator/sessions/${encodeURIComponent(phoneId)}`).catch((): NomacAnswer => ({ status: 504, body: null }));
  if (answer.status >= 400 && answer.status !== 404) {
    // A phone that won't stop keeps costing: Sentry hears of it, per the provider's code.
    const { code } = errorOf(answer);
    reportCloudFailure(`cloud.phone_stop_failed.${where.provider === "revyl" ? "revyl_" : ""}${sentryCode(code)}`, { userId, phoneId, why, status: answer.status, code }, "cloud-phone");
    return false;
  }
  const after = await readPhone(env, userId, phoneId, where);
  // Revyl reads a phone it just took a stop for as running a few seconds more: it is stopping (ended here).
  if (after && where.provider === "revyl" && answer.status < 300 && LIVE_STATES.has(after.session.state)) {
    after.session.state = "stopping";
    after.session.ended = { reason: "stopped", at: null };
  }
  if (after) await savePhone(env, userId, after.session, now);
  else if (answer.status === 404) {
    await env.DB.prepare("update cloud_phones set state = 'ended', ended_at = coalesce(ended_at, ?), end_reason = coalesce(end_reason, 'gone'), updated_at = ? where phone_id = ?")
      .bind(now, now, phoneId).run();
  }
  logCloud("cloud.phone_stopped", { userId, phoneId, why });
  return true;
}

/** Stops every live phone of an account (a block, a removal from the beta, a deletion). */
export async function stopAccountPhones(env: CloudEnv, userId: string, now: number, why: string): Promise<void> {
  const live = await env.DB.prepare("select phone_id from cloud_phones where user_id = ? and state = 'live'").bind(userId).all<{ phone_id: string }>();
  for (const { phone_id: phoneId } of live.results ?? []) await stopPhone(env, userId, phoneId, now, why);
}

/** NoMac's billed minutes of the phones, never an estimate: what billing counts. */
export const settledPhoneMinutes = (rows: readonly PhoneRow[]): number => phoneMinutesUsed(rows, 0, true);

/* ---- Who may use it, and how much ---- */

/** The server's switch: `beta` (the owner's list), `all`, or `off`. */
function phoneAccessSetting(env: Pick<CloudEnv, "CLOUD_PHONE_ACCESS">): "beta" | "all" | "off" {
  const value = env.CLOUD_PHONE_ACCESS?.trim().toLowerCase();
  return value === "all" || value === "off" ? value : "beta";
}

/** A provider that may start new phones: its key set (and for Revyl, its switch on: `revylEnabled`). */
const providerConfigured = (env: CloudEnv, provider: CloudPhoneProvider): boolean =>
  provider === "revyl" ? revylEnabled(env) : Boolean(env.NOMAC_API_KEY?.trim());

/** Some provider can start phones here. */
const anyProviderConfigured = (env: CloudEnv): boolean => providerConfigured(env, "nomac") || providerConfigured(env, "revyl");

/** Some provider's key is set: phones already running there are still read, held to their minutes and stopped. */
const anyProviderKey = (env: CloudEnv): boolean => Boolean(env.NOMAC_API_KEY?.trim()) || revylConfigured(env);

/**
 * Who runs the account's next phone: the owner's choice for this tester,
 * else `CLOUD_PHONE_PROVIDER`, else NoMac; a choice that can't start phones
 * (no key, or Revyl's switch off) falls to NoMac, and to Revyl only when
 * Revyl is switched on.
 */
async function providerFor(env: CloudEnv, userId: string): Promise<CloudPhoneProvider> {
  const row = await env.DB.prepare("select provider from cloud_phone_beta where user_id = ?").bind(userId).first<{ provider: string | null }>();
  const setting = env.CLOUD_PHONE_PROVIDER?.trim().toLowerCase();
  const wanted: CloudPhoneProvider = row?.provider === "revyl" || row?.provider === "nomac" ? row.provider : setting === "revyl" ? "revyl" : "nomac";
  if (providerConfigured(env, wanted)) return wanted;
  return wanted === "nomac" && providerConfigured(env, "revyl") ? "revyl" : "nomac";
}

async function phoneAccess(env: CloudEnv, userId: string): Promise<CloudPhoneAccess> {
  if (!anyProviderConfigured(env)) return "off";
  const setting = phoneAccessSetting(env);
  if (setting === "off") return "off";
  if (setting === "all") return "on";
  const row = await env.DB.prepare("select 1 as on_list from cloud_phone_beta where user_id = ?").bind(userId).first<{ on_list: number }>();
  // Not on the list: hidden everywhere (Pricing v2). `soon` is never sent any more.
  return row ? "on" : "off";
}

/** The plan's minutes: none on a free plan the free-plan checks hold, as with free hours. */
export function includedPhoneMinutes(account: AccountRow): number {
  const plan = planIdOf(account);
  if (plan === "free" && (account.free_refused_at != null || account.free_github_hold != null)) return 0;
  return CLOUD_PLANS[plan].phoneMinutes;
}

/** Extra minutes are sold once both Stripe settings are set. */
export function extraPhoneOffered(env: Pick<CloudEnv, "STRIPE_PHONE_MINUTE_PRICE_ID" | "STRIPE_PHONE_METER_EVENT">): boolean {
  return Boolean(env.STRIPE_PHONE_MINUTE_PRICE_ID?.trim() && env.STRIPE_PHONE_METER_EVENT?.trim());
}

/** Extra minutes a monthly limit in cents allows (no limit: as many as minutes can be). */
const extraLimitMinutes = (limitCents: number | null | undefined): number =>
  limitCents == null ? Number.POSITIVE_INFINITY : Math.floor(Math.max(0, limitCents) / EXTRA_PHONE_MINUTE_CENTS);

/**
 * Extra minutes billed for a period: past the plan's minutes, up to the
 * limit, while the switch is on; never less than what was owed when it went
 * off in that period (`owed`).
 */
export function billableExtraMinutes(input: { used: number; included: number; enabled: boolean; limitCents: number | null; owed: number }): number {
  const extraUsed = Math.max(0, input.used - input.included);
  const withinLimit = input.enabled ? Math.min(extraUsed, extraLimitMinutes(input.limitCents)) : 0;
  return Math.max(withinLimit, Math.max(0, input.owed));
}

/** This period's own value of a per-period column: a value from another period counts as none. */
function inPeriod(account: AccountRow, value: number | null | undefined): number {
  return account.phone_extra_period_start === account.period_start ? Math.max(0, value ?? 0) : 0;
}

type PhoneUsage = {
  included: number;
  used: number;
  left: number;
  state: CloudPhoneMinutesState;
  extra: {
    available: boolean;
    enabled: boolean;
    limitCents: number | null;
    /** Minutes past the plan that are billed (or will be). */
    billableMinutes: number;
    /** Extra minutes a phone may still use (one phone's longest when there is no limit). */
    leftMinutes: number;
  };
};

/** Where an account's minutes stand this period. `settledOnly` leaves out the running phone's estimate (for billing). */
export function phoneUsageOf(env: CloudEnv, account: AccountRow, rows: readonly PhoneRow[], now: number, settledOnly = false): PhoneUsage {
  const included = includedPhoneMinutes(account);
  const used = phoneMinutesUsed(rows, now, settledOnly);
  const available = extraPhoneOffered(env) && accountRules(account) === "paid";
  const enabled = available && account.phone_extra_enabled === PHONE_EXTRA.on;
  const limitCents = account.phone_extra_limit_cents ?? null;
  const billableMinutes = billableExtraMinutes({ used, included, enabled, limitCents, owed: inPeriod(account, account.phone_extra_owed_minutes) });
  const leftMinutes = enabled ? Math.max(0, extraLimitMinutes(limitCents) - Math.max(0, used - included)) : 0;
  const state: CloudPhoneMinutesState = included > 0 && used >= included ? "zero" : included > 0 && used >= included * 0.8 ? "warn80" : "none";
  return {
    included,
    used,
    left: Math.max(0, included - used),
    state,
    extra: { available, enabled, limitCents, billableMinutes, leftMinutes: Number.isFinite(leftMinutes) ? leftMinutes : CLOUD_PHONE_MAX_MINUTES },
  };
}

/** Minutes a phone may still run for the account: the plan's left, then extra minutes left. */
const allowedMinutes = (usage: PhoneUsage): number => usage.left + usage.extra.leftMinutes;

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
    provider: session.provider ?? "nomac",
    id: session.id,
    state: session.state === "ready" ? "ready" : live ? "starting" : "ended",
    device: session.device ?? "iphone",
    readyAt: isoMs(session.ready_at),
    queueUntil: session.state === "queued" ? isoMs(session.queue_expires_at) : null,
    endReason: live ? null : endReasonOf(session),
    stopNotice: typeof notice?.message === "string" ? notice.message : null,
  };
}

type PhoneContext = {
  account: AccountRow;
  label: string;
  usage: PhoneUsage;
  /** The account's live phone as its provider answers it now, or null. */
  live: { session: NomacSession; stopNotice: unknown; createdAt: number; where: PhoneWhere } | null;
  /** The account's newest phone, live or not: a new start's idempotency key names it. */
  lastPhoneId: string | null;
  /** The live row's phone when NoMac couldn't be read now: a stop still reaches it. */
  liveRowId: string | null;
  /** This period's phone rows, newest first. */
  rows: PhoneRow[];
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
  // The live phone may be from an earlier period (it ran across the turn).
  const liveRow = rows.find((row) => row.state === "live")
    ?? await env.DB.prepare("select * from cloud_phones where user_id = ? and state = 'live' order by created_at desc limit 1").bind(userId).first<PhoneRow>();
  let unreadLiveRowId: string | null = null;
  if (liveRow) {
    const where: PhoneWhere = { provider: liveRow.provider === "revyl" ? "revyl" : "nomac", ref: liveRow.provider_ref ?? null, device: liveRow.device };
    const read = await readPhone(env, userId, liveRow.phone_id, where);
    if (!read) unreadLiveRowId = liveRow.phone_id;
    if (read) {
      await savePhone(env, userId, read.session, now);
      if (LIVE_STATES.has(read.session.state)) live = { ...read, createdAt: liveRow.created_at, where: { ...where, ref: read.session.ref ?? where.ref } };
      rows = await periodPhones(env, userId, account.period_start);
    }
  }
  const newest = await env.DB.prepare("select phone_id from cloud_phones where user_id = ? order by created_at desc limit 1").bind(userId).first<{ phone_id: string }>();
  return { account, label, usage: phoneUsageOf(env, account, rows, now), live, lastPhoneId: newest?.phone_id ?? null, liveRowId: unreadLiveRowId, rows };
}

/** A live phone from an earlier period ran under that period's terms. */
const startedBeforePeriod = (context: PhoneContext): boolean => context.live != null && context.live.createdAt < context.account.period_start;

/** Why the account's live phone must stop now, or null while it may run on. */
async function stopReasonOf(env: CloudEnv, userId: string, context: PhoneContext): Promise<string | null> {
  if (startedBeforePeriod(context)) return "period_changed";
  if ((await phoneAccess(env, userId)) !== "on") return "access_removed";
  if (await isCloudBlocked(env, userId)) return "account_blocked";
  if (allowedMinutes(context.usage) <= 0) return "minutes_used";
  return null;
}

/**
 * Holds the account's live phone to what the account may use now. It stops at
 * once when the account may use none (minutes used, access or the account
 * taken away, a new period since it started); otherwise it gets a `stop_at`
 * for when its minutes run out, which the minute tick acts on
 * (`stopPhonesDue`). Called whenever what an account may use can shrink, and
 * by the ten-minute check. Answers what happened: `none` (no live phone),
 * `stopped`, `stop_failed` (NoMac refused; tried again later) or `running`
 * (its `stop_at` set).
 */
export async function enforcePhoneAllowance(env: CloudEnv, userId: string, now: number): Promise<"none" | "stopped" | "stop_failed" | "running"> {
  const context = await phoneContext(env, userId, now);
  if (context instanceof Response || !context.live) return "none";
  const live = context.live;
  const why = await stopReasonOf(env, userId, context);
  if (why) {
    // Due now, saved first: if NoMac refuses the stop, the minute tick tries it again.
    await env.DB.prepare("update cloud_phones set stop_at = ?, updated_at = ? where phone_id = ? and state = 'live'").bind(now, now, live.session.id).run();
    return (await stopPhone(env, userId, live.session.id, now, why)) ? "stopped" : "stop_failed";
  }
  // Never past one phone's longest: Revyl's phone has no time limit of its own, so this is its limit.
  await env.DB.prepare("update cloud_phones set stop_at = ?, updated_at = ? where phone_id = ? and state = 'live'")
    .bind(Math.min(now + allowedMinutes(context.usage) * 60_000, live.createdAt + CLOUD_PHONE_MAX_MINUTES * 60_000), now, live.session.id).run();
  return "running";
}

/** The minute tick: live phones whose `stop_at` passed stop now. Rows only until one is due. */
export async function stopPhonesDue(env: CloudEnv, now: number): Promise<void> {
  if (!anyProviderKey(env)) return;
  const due = await env.DB.prepare("select phone_id, user_id from cloud_phones where state = 'live' and stop_at is not null and stop_at <= ? limit ?")
    .bind(now, STOPS_PER_TICK).all<{ phone_id: string; user_id: string }>();
  for (const row of due.results ?? []) {
    try {
      // Held to what the account may use now: given more since (extra minutes back on), it gets a later stop_at and runs on.
      const outcome = await enforcePhoneAllowance(env, row.user_id, now);
      // NoMac couldn't read the phone (no live phone found): the row's own stop_at still stops it.
      if (outcome === "none") {
        // Still due: a later stop_at written meanwhile (extra minutes back on) wins.
        const still = await env.DB.prepare("select 1 from cloud_phones where phone_id = ? and state = 'live' and stop_at is not null and stop_at <= ?").bind(row.phone_id, now).first();
        if (still) await stopPhone(env, row.user_id, row.phone_id, now, "stop_at");
      }
    } catch (error) {
      reportCloudFailure("cloud.phone_stop_due_failed", { userId: row.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
}

async function phoneToken(env: CloudEnv, sessionId: string, userId: string): Promise<{ token: string; expiresAt: number } | Response> {
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
async function signPhoneVisitor(secret: string, sessionId: string, visitor: string, now: number): Promise<string> {
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
  return isCloudPhoneDevice(value) ? value : null;
}

const formatDay = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** Why a new phone may not start, as the person reads it, or null when it may. */
function startRefusal(context: PhoneContext): { code: string; message: string } | null {
  const { usage, account } = context;
  if (allowedMinutes(usage) > 0) return null;
  const resets = formatDay(account.period_end);
  if (usage.included === 0 && accountRules(account) === "free") {
    return { code: "phone_free_held", message: "The free plan's iPhone minutes need the same check as its free hours. Finish it in Settings › ADE Cloud, or pick a plan." };
  }
  if (usage.extra.enabled) {
    const limit = usage.extra.limitCents != null ? `$${(usage.extra.limitCents / 100).toFixed(0)}` : "your";
    return { code: "phone_extra_limit", message: `Extra iPhone minutes reached ${limit} monthly limit. Raise it in Settings › ADE Cloud, or wait until ${resets}.` };
  }
  const next = usage.extra.available
    ? "Turn on extra iPhone minutes in Settings › ADE Cloud to keep going"
    : accountRules(account) === "free" ? "Pick a plan in Settings › ADE Cloud for more" : "They come back";
  return { code: "phone_minutes_out", message: `Your plan's ${usage.included} ADE Cloud iPhone minutes are used up. ${next}, or wait until ${resets}.` };
}

/**
 * `/cloud/phone` and `/cloud/phone/view` for a signed-in caller (`routes.ts`
 * checked the sign-in and the owner's block first).
 */
export async function routePhone(request: Request, path: string, env: CloudEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  if (path !== CLOUD_PATHS.phone && path !== CLOUD_PATHS.phoneView && path !== CLOUD_PATHS.phoneCall) return null;
  const access = await phoneAccess(env, userId);

  if (path === CLOUD_PATHS.phone && request.method === "GET") {
    if (access !== "on") return json({ access, minutes: null, phone: null } satisfies CloudPhoneState);
    const context = await phoneContext(env, userId, now);
    if (context instanceof Response) return context;
    return json({
      access,
      minutes: minutesOf(context.usage),
      phone: context.live ? summaryOfSession(context.live.session, context.live.stopNotice) : null,
      recent: recentPhonesOf(context.rows, now),
    } satisfies CloudPhoneState);
  }

  // Stopping your own phone is always allowed, whatever the access says now.
  if (path === CLOUD_PATHS.phone && request.method === "DELETE") {
    if (!anyProviderKey(env)) return json({ ok: true, stopped: false });
    const context = await phoneContext(env, userId, now);
    if (context instanceof Response) return context;
    const phoneId = context.live?.session.id ?? context.liveRowId;
    if (!phoneId) return json({ ok: true, stopped: false });
    if (!(await stopPhone(env, userId, phoneId, now, "person"))) {
      return fail("phone_unavailable", "The ADE Cloud iPhone isn't answering right now. Try again in a moment.", 502);
    }
    return json({ ok: true, stopped: true });
  }

  if (access !== "on") {
    // Set up, but this account isn't on the beta list: the one answer that isn't "try again".
    return env.NOMAC_API_KEY?.trim() && phoneAccessSetting(env) === "beta"
      ? fail("phone_not_on_account", "The ADE Cloud iPhone isn't on this account.", 403)
      : fail("phone_unavailable", "The ADE Cloud iPhone isn't available right now.", 503);
  }
  // A start is use of the free plan: one free plan per computer and per GitHub account, as a computer's start
  // settles them (`routes.ts`), only once the account may use the phone at all.
  if (path === CLOUD_PATHS.phone && request.method === "POST") {
    const account = await loadAccount(env, userId, now);
    await settleFreePlanComputer(env, account, readComputerSignal(request), "use", { now, waitUntil });
    await settleFreePlanGithub(env, account, { now, waitUntil });
  }
  const context = await phoneContext(env, userId, now);
  if (context instanceof Response) return context;
  const plan = planIdOf(context.account);

  if (path === CLOUD_PATHS.phone && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return fail("bad_request", "That request could not be read.", 400);
    const device = readDevice(body.device);
    if (device === null) return fail("bad_request", `device is one of ${CLOUD_PHONE_DEVICES.join(", ")}.`, 400);
    // A phone from an earlier period ran under that period's terms: it ends, and a new one starts on this period's.
    // Not for `attach` (Keep on): the allowance check ends that phone on its own schedule.
    if (context.live && startedBeforePeriod(context) && body.attach !== true) {
      await stopPhone(env, userId, context.live.session.id, now, "period_changed");
      context.live = null;
    }
    let session = context.live?.session ?? null;
    let reused = Boolean(session);
    // `attach`: a token for the live phone only (a brain keeping it on); never a start.
    if (!session && body.attach === true) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running.", 409);
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
        logCloud("cloud.phone_start_refused", { userId, code: refusal.code, included: context.usage.included, used: context.usage.used });
        captureCloudPhone(env, waitUntil, userId, { step: "refused", plan, reason: refusal.code }, refusal.code, now);
        return fail(refusal.code, refusal.message, 402, { minutes: minutesOf(context.usage) });
      }
      // What this phone may use: the plan's minutes left, then extra minutes, and never more than one phone's longest.
      const minutes = Math.min(CLOUD_PHONE_MAX_MINUTES, allowedMinutes(context.usage));
      const provider = await providerFor(env, userId);
      if (provider === "revyl") {
        const started = await startRevylPhone(env, userId, device, CLOUD_PHONE_IDLE_SECONDS, now);
        if (started instanceof Response) return started;
        session = { ...started.session, provider: "revyl" };
        reused = started.reused;
      } else {
        const answer = await nomac(env, "POST", "/api/v1/simulator/sessions", {
          label: context.label,
          reuse: true,
          ...(device ? { device } : {}),
          limits: {
            max_duration_seconds: minutes * 60,
            idle_timeout_seconds: CLOUD_PHONE_IDLE_SECONDS,
            spend_cap_microunits: String(minutes * NOMAC_MICROS_PER_MINUTE),
          },
          // A retry of this start reaches the same phone; a start after that phone (a stop, then start) is a new one.
        }, `ade-phone-${userId}-${context.lastPhoneId ?? "first"}-${Math.floor(now / 10_000)}`);
        session = sessionOf(answer.body?.session);
        if (answer.status >= 400 || !session) return providerFailure("cloud.phone_start_failed", answer, userId);
        reused = answer.body?.reused === true;
      }
      await savePhone(env, userId, session, now, accountRules(context.account) === "free");
      // Revyl's phone has no limits of its own: its stop_at is the limit from the start.
      if (provider === "revyl") {
        await env.DB.prepare("update cloud_phones set stop_at = coalesce(stop_at, ?), updated_at = ? where phone_id = ? and state = 'live'").bind(now + minutes * 60_000, now, session.id).run();
      }
      logCloud("cloud.phone_started", { userId, phoneId: session.id, reused, device: session.device ?? "iphone", minutes, extra: context.usage.left === 0, provider });
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
    if (session.provider === "revyl") {
      // No per-phone token at Revyl: the brain calls the phone through `/cloud/phone/call`, as itself.
      return json({
        phone: summaryOfSession(session, null),
        reused,
        token: { token: "", expiresAt: now + TOKEN_MINUTES * 60_000 },
        minutes: minutesOf(context.usage),
        apiBase: "",
        provider: "revyl",
      } satisfies CloudPhoneStart);
    }
    const token = await phoneToken(env, session.id, userId);
    if (token instanceof Response) return token;
    return json({ phone: summaryOfSession(session, null), reused, token, minutes: minutesOf(context.usage), apiBase: NOMAC_SIMULATOR_BASE, provider: "nomac" } satisfies CloudPhoneStart);
  }

  if (request.method !== "POST") return fail("not_found", "ADE Cloud has no such route.", 404);
  const live = context.live?.session ?? null;
  if (!live) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running. Start it first.", 409);
  const where = context.live!.where;
  const body = await readJson(request);

  // A call to the live phone at a provider with no per-phone token.
  if (path === CLOUD_PATHS.phoneCall) {
    if (!body) return fail("bad_request", "That request could not be read.", 400);
    if (where.provider !== "revyl") return fail("bad_request", "This phone takes its calls directly.", 400);
    if (live.state !== "ready") return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
    return routeRevylCall(env, userId, { id: live.id, ref: where.ref }, body, now);
  }

  // The view: a control link by default (the person uses the phone in the pane).
  const control = body?.control !== false;
  if (where.provider === "revyl") {
    if (!where.ref) return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
    const view = await revylViewUrl(env, userId, where.ref, new URL(request.url).origin, control);
    if (view instanceof Response) return view;
    // The stream link lasts the phone's life; the pane asks again before this.
    return json({ url: view.url, expiresAt: now + VIEW_MINUTES * 60_000, control, provider: "revyl" } satisfies CloudPhoneView);
  }
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
  return json({ url: signed, expiresAt, control, provider: "nomac" } satisfies CloudPhoneView);
}

/** `GET /cloud/phone/viewer`: ADE's page for a phone streamed over WebRTC (Revyl's). Static; the link's `#` part names the phone. */
export const isPhoneViewerRequest = (path: string, method: string): boolean => path === CLOUD_PATHS.phoneViewer && method === "GET";
export const handlePhoneViewer = (): Response => revylViewerPage();

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
 * end settle its row (an end with its billed minutes and cost), for phones
 * this Worker started only; low credit alerts the owner. Each delivery id is
 * taken once, and given back when its work fails so NoMac's retry is done.
 * Answers 2xx quickly: NoMac retries anything else for an hour.
 */
export async function handleNomacWebhook(request: Request, env: CloudEnv, now: number, waitUntil?: CloudWaitUntil): Promise<Response> {
  const secret = env.NOMAC_WEBHOOK_SECRET?.trim();
  if (!secret) return fail("unavailable", "The NoMac webhook isn't set up.", 503);
  // Read with a cap, never whole: an unsigned sender could otherwise make the Worker buffer any size.
  const read = await readBoundedBody(request, 256_000);
  if (!read.ok) {
    logCloud("cloud.nomac_webhook_refused", { reason: "too_large" });
    return fail("bad_request", "That delivery is too large.", 413);
  }
  const raw = read.text;
  if (!(await nomacSignatureValid(secret, request.headers.get("nomac-signature"), raw, now))) {
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

  try {
    if (type.startsWith("phone.")) {
      const session = sessionOf(event?.data?.session);
      const known = session ? await updatePhone(env, session, now) : null;
      if (session && known && type === "phone.ended" && !known.wasEnded) {
        const account = await env.DB.prepare("select plan, paid_plan, stripe_status from cloud_accounts where user_id = ?")
          .bind(known.userId).first<Pick<AccountRow, "plan" | "paid_plan" | "stripe_status">>();
        captureCloudPhone(env, waitUntil, known.userId, {
          step: "ended",
          plan: account ? planIdOf(account) : "free",
          device: session.device ?? "iphone",
          reason: endReasonOf(session) ?? "stopped",
          billedMinutes: Math.ceil(Number(session.cost?.billed_seconds ?? 0) / 60),
        }, session.id, now);
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
  } catch (error) {
    // Given back, so NoMac's retry of this delivery is done rather than taken as a repeat.
    await env.DB.prepare("delete from cloud_nomac_deliveries where id = ?").bind(id).run().catch(() => undefined);
    reportCloudFailure("cloud.nomac_webhook_failed", { type, message: error instanceof Error ? error.message : "unknown" });
    return fail("unavailable", "That delivery could not be saved. Send it again.", 503);
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

/** A deleted account's rows keep its hash for the cost report; nothing acts for it. */
const isDeletedAccount = (userId: string): boolean => userId.startsWith(CLOUD_DELETED_ACCOUNT_PREFIX);

/**
 * Every ten minutes: live phones are read from NoMac (a missed webhook can't
 * leave one counted forever) and held to what their account may use now
 * (`enforcePhoneAllowance`); each account that used its phone in the last day
 * is warned at 80% and at its end; old delivery ids are dropped. Extra minutes
 * go to Stripe from `phoneBilling.ts`.
 */
export async function runPhoneChecks(env: CloudEnv, now: number): Promise<void> {
  if (!anyProviderKey(env)) return;
  const live = await env.DB.prepare("select phone_id, user_id, created_at, updated_at, provider, provider_ref, device from cloud_phones where state = 'live' order by updated_at limit ?")
    .bind(CHECK_BATCH).all<Pick<PhoneRow, "phone_id" | "user_id" | "created_at" | "updated_at" | "provider" | "provider_ref" | "device">>();
  for (const row of live.results ?? []) {
    if (isDeletedAccount(row.user_id)) continue;
    // A phone read in the last few minutes (a pane open, a webhook) is fresh enough.
    if (now - row.updated_at < 5 * 60_000 && now - row.created_at < LIVE_STALE_MS) continue;
    try {
      const read = await readPhone(env, row.user_id, row.phone_id, { provider: row.provider === "revyl" ? "revyl" : "nomac", ref: row.provider_ref, device: row.device });
      if (read) await savePhone(env, row.user_id, read.session, now);
    } catch (error) {
      reportCloudFailure("cloud.phone_check_read_failed", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  for (const userId of new Set((live.results ?? []).map((row) => row.user_id))) {
    if (isDeletedAccount(userId)) continue;
    try {
      await enforcePhoneAllowance(env, userId, now);
    } catch (error) {
      reportCloudFailure("cloud.phone_allowance_check_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  const active = await env.DB.prepare("select distinct user_id from cloud_phones where updated_at >= ? limit ?").bind(now - 24 * 60 * 60_000, CHECK_BATCH).all<{ user_id: string }>();
  for (const { user_id: userId } of active.results ?? []) {
    if (isDeletedAccount(userId)) continue;
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

/* ---- The owner's beta list ---- */

export const OWNER_PHONE_BETA_PATH = "/cloud/owner/phone-beta";

const CLERK_USERS_URL = "https://api.clerk.com/v1/users";

/**
 * The Clerk user ids that have this address verified, or null when Clerk
 * can't be asked. Verified only, as `readClerkUser`: an address someone
 * added but never proved is not theirs, so it must not put them on the list.
 */
async function clerkUserIdsFor(env: Pick<CloudEnv, "CLERK_SECRET_KEY">, email: string): Promise<string[] | null> {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return null;
  const response = await fetch(`${CLERK_USERS_URL}?email_address=${encodeURIComponent(email)}&limit=10`, {
    headers: { authorization: `Bearer ${secretKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const users = await response.json().catch(() => null) as unknown;
  if (!Array.isArray(users)) return null;
  const wanted = email.trim().toLowerCase();
  return users.flatMap((user) => {
    const { id, email_addresses: addresses } = (user ?? {}) as { id?: unknown; email_addresses?: unknown };
    const verified = Array.isArray(addresses) && addresses.some((address: { email_address?: unknown; verification?: { status?: unknown } | null } | null) =>
      typeof address?.email_address === "string" && address.email_address.trim().toLowerCase() === wanted && address.verification?.status === "verified");
    return typeof id === "string" && verified ? [id] : [];
  });
}

/** How many waiting tester emails one run asks Clerk about, and how long one waits before it is asked again. */
const PENDING_BETA_BATCH = 10;
const PENDING_BETA_RECHECK_MS = 60 * 60_000;

/**
 * The owner check's retry for waiting tester emails (`cloud_phone_beta_pending`):
 * an account's own claim (`claimPhoneBetaInvite` in `store.ts`) runs once,
 * when its row is made, so a Clerk read that failed then, or an address
 * verified later, would leave the email waiting for good. Each email is asked
 * again about once an hour, at most `PENDING_BETA_BATCH` a run, oldest asked
 * first; an empty table costs one read. Clerk not answering stops the run,
 * and that batch is asked again next hour.
 */
export async function resolvePendingPhoneBeta(env: CloudEnv, now: number): Promise<void> {
  // No Clerk key (a development Worker): nothing can be looked up.
  if (!env.CLERK_SECRET_KEY?.trim()) return;
  const due = await env.DB.prepare(`
    select email from cloud_phone_beta_pending where coalesce(checked_at, 0) < ? order by coalesce(checked_at, 0), added_at limit ?
  `).bind(now - PENDING_BETA_RECHECK_MS, PENDING_BETA_BATCH).all<{ email: string }>();
  for (const { email } of due.results ?? []) {
    let failure: string | null = null;
    const found = await clerkUserIdsFor(env, email).catch((error: unknown) => {
      failure = error instanceof Error ? error.message : "unknown";
      return null;
    });
    if (found == null) {
      // The whole batch waits its hour, so a Clerk outage is reported once a run, never once a minute.
      const emails = (due.results ?? []).map((row) => row.email);
      await env.DB.prepare("update cloud_phone_beta_pending set checked_at = ? where email in (select value from json_each(?))").bind(now, JSON.stringify(emails)).run();
      reportCloudFailure("cloud.phone_beta_pending_check_failed", { waiting: emails.length, message: failure ?? "Clerk did not answer" });
      return;
    }
    if (!found.length) {
      await env.DB.prepare("update cloud_phone_beta_pending set checked_at = ? where email = ?").bind(now, email).run();
      continue;
    }
    await env.DB.batch([
      ...found.map((userId) => phoneBetaAddStatement(env.DB, userId, email, now, { whilePending: true })),
      env.DB.prepare("delete from cloud_phone_beta_pending where email = ?").bind(email),
    ]);
    logCloud("cloud.phone_beta_claimed", { count: found.length, retried: true });
  }
}

/**
 * `POST /cloud/owner/phone-beta` `{ email? | userId?, enabled? }` adds (or with
 * `enabled: false` removes) an account; `{}` lists the list and the emails
 * still waiting. `safety.ts` checked the owner's token before this runs. An
 * email is looked up in Clerk once; the list keeps the user id (and the
 * address the owner typed, for the owner's own reading). An email no ADE
 * account has yet waits (`pending: true`, `cloud_phone_beta_pending`) until
 * an account with it first appears (`claimPhoneBetaInvite` in `store.ts`), or
 * the owner check finds it in Clerk (`resolvePendingPhoneBeta`).
 * Removing an email removes a waiting one too. With `CLOUD_PHONE_ACCESS=all`
 * the list no longer matters.
 */
export async function handleOwnerPhoneBeta(env: CloudEnv, body: Record<string, unknown>, now: number): Promise<Response> {
  const typedEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const typedUserId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!typedEmail && !typedUserId) {
    const rows = await env.DB.prepare("select user_id, email, added_at, provider from cloud_phone_beta order by added_at").all<{ user_id: string; email: string | null; added_at: number; provider: string | null }>();
    const pending = await env.DB.prepare("select email, added_at from cloud_phone_beta_pending order by added_at").all<{ email: string; added_at: number }>();
    return json({ ok: true, access: phoneAccessSetting(env), provider: env.CLOUD_PHONE_PROVIDER?.trim().toLowerCase() === "revyl" ? "revyl" : "nomac", users: rows.results ?? [], pending: pending.results ?? [] });
  }
  // `provider`: this tester's phones run there (`nomac`, `revyl`); `null` goes back to the server's setting.
  const provider = body.provider === null ? null : body.provider === undefined ? undefined : isCloudPhoneProvider(body.provider) ? body.provider : false;
  if (provider === false) return fail("bad_request", `provider is ${CLOUD_PHONE_PROVIDERS.join(" or ")}, or null.`, 400);
  if (typedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail)) return fail("bad_request", "That email isn't valid.", 400);
  if (typedUserId && !/^[A-Za-z0-9_-]{1,100}$/.test(typedUserId)) return fail("bad_request", "That userId isn't valid.", 400);
  let userIds = typedUserId ? [typedUserId] : [];
  if (!userIds.length) {
    const found = await clerkUserIdsFor(env, typedEmail);
    if (found == null) return fail("unavailable", "Clerk could not be asked for that email. Try again, or pass userId.", 503);
    if (!found.length) {
      // No ADE account has it yet: the email waits for the account that signs up with it.
      if (body.enabled === false) {
        const removed = await env.DB.prepare("delete from cloud_phone_beta_pending where email = ?").bind(typedEmail).run();
        if ((removed.meta?.changes ?? 0) === 0) return fail("not_found", "No ADE account or waiting tester has that email.", 404);
        logCloud("cloud.phone_beta_pending_removed");
        return json({ ok: true, removed: [], pending: true });
      }
      await env.DB.prepare("insert into cloud_phone_beta_pending (email, added_at) values (?, ?) on conflict(email) do nothing").bind(typedEmail, now).run();
      logCloud("cloud.phone_beta_pending_added");
      return json({ ok: true, added: [], pending: true });
    }
    userIds = found;
  }
  // The account exists now: no email of it needs to wait.
  if (typedEmail) await env.DB.prepare("delete from cloud_phone_beta_pending where email = ?").bind(typedEmail).run();
  if (body.enabled === false) {
    for (const userId of userIds) {
      await env.DB.prepare("delete from cloud_phone_beta where user_id = ?").bind(userId).run();
      // Off the list is off now: a running phone stops (under `all`, the list doesn't matter).
      if (phoneAccessSetting(env) === "beta") await stopAccountPhones(env, userId, now, "access_removed");
    }
    logCloud("cloud.phone_beta_removed", { count: userIds.length });
    return json({ ok: true, removed: userIds });
  }
  for (const userId of userIds) {
    await phoneBetaAddStatement(env.DB, userId, typedEmail || null, now).run();
    // A provider change reaches the next phone; the live one keeps its own.
    if (provider !== undefined) await env.DB.prepare("update cloud_phone_beta set provider = ? where user_id = ?").bind(provider, userId).run();
  }
  logCloud("cloud.phone_beta_added", { count: userIds.length, ...(provider !== undefined ? { provider } : {}) });
  return json({ ok: true, added: userIds, ...(provider !== undefined ? { provider } : {}) });
}

/**
 * An account's deletion: its phone stops, NoMac forgets what it kept for the
 * label (saved states, replays, workspace), and it leaves the beta list. Its
 * `cloud_phones` rows are re-keyed by `accountDeletion.ts` (the cost report
 * keeps them). NoMac's billing records stay under the label (an id, never an
 * email). Throws while NoMac still saves the last phone's replay, so the
 * deletion is retried.
 */
export async function deleteAccountPhone(env: Pick<CloudEnv, "DB" | "NOMAC_API_KEY" | "REVYL_PARTNER_API_KEY" | "CLOUD_PHONE_ACCESS">, userId: string): Promise<void> {
  // Revyl first: disconnecting the workspace stops its phones and revokes its credentials.
  await forgetRevylAccount(env, userId);
  const hadPhone = await env.DB.prepare("select 1 from cloud_phones where user_id = ? and provider = 'nomac' limit 1").bind(userId).first();
  const inBeta = await env.DB.prepare("select 1 from cloud_phone_beta where user_id = ?").bind(userId).first();
  await env.DB.prepare("delete from cloud_phone_beta where user_id = ?").bind(userId).run();
  const label = phoneLabelFor(userId);
  if (!label) return;
  // NoMac is skipped only for an account that could never have started a phone. One that could
  // may have a phone with no row (its start's answer was lost), so its label is always cleaned.
  if (!hadPhone && !inBeta && phoneAccessSetting(env) !== "all") return;
  // No key: a phone with a row means data at NoMac, tried again later; none means no phone could start here.
  if (!env.NOMAC_API_KEY?.trim()) {
    if (hadPhone) throw new Error("phone_cleanup_no_key");
    return;
  }
  const listed = await nomac(env, "GET", `/api/v1/simulator/sessions?${new URLSearchParams({ label, limit: "100" }).toString()}`);
  // Unread is not "none": the deletion is tried again rather than leaving a phone or its data behind.
  if (listed.status !== 200) throw new Error(`phone_list_${errorOf(listed).code}`);
  const sessions = Array.isArray(listed.body?.sessions) ? (listed.body.sessions as unknown[]).map(sessionOf) : [];
  for (const session of sessions) {
    if (!session || !LIVE_STATES.has(session.state)) continue;
    const stopped = await nomac(env, "DELETE", `/api/v1/simulator/sessions/${encodeURIComponent(session.id)}`);
    if (stopped.status >= 400 && stopped.status !== 404) throw new Error(`phone_stop_${errorOf(stopped).code}`);
  }
  // The label goes whether or not a phone is listed: its saved states, replays and workspace outlive the phones.
  const answer = await nomac(env, "DELETE", `/api/v1/simulator/labels/${encodeURIComponent(label)}`);
  if (answer.status >= 400 && answer.status !== 404) throw new Error(`phone_label_delete_${errorOf(answer).code}`);
}
