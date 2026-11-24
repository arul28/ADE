/**
 * The ADE Cloud iPhone: an iOS Simulator on NoMac or on Revyl, one per ADE
 * account.
 *
 * Which provider: `CLOUD_PHONE_PROVIDER` (`nomac`, the default, or `revyl`),
 * or the owner's per-account choice on the beta list (testers). A provider
 * with no key set is never picked. Every phone keeps the provider it started
 * on (`cloud_phones.provider`), so a change of setting reaches only new phones.
 * Each provider's side is its own file, one record each behind one seam
 * (`phoneProvider.ts`): NoMac's in `phoneNomac.ts`, Revyl's in `phoneRevyl.ts`.
 * This file keeps the rows, minutes, access and routes, the same for both.
 *
 * The providers' keys live only in their files. A NoMac brain gets a token for
 * one phone (it can drive that phone, never start, list or stop one) and a
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
 * The guard: every NoMac phone starts with NoMac's own spend cap and time
 * limit set to what the account may still use, so it stops by itself there; a
 * Revyl phone has none, so its `stop_at` is set at its start. What the account
 * may use can shrink while it runs (extra minutes off, a lower limit, a new
 * period, access or the account taken away), and NoMac can't lower a running
 * phone's limit, so the phone gets a `stop_at` here and the minute tick stops
 * it then (`enforcePhoneAllowance`, `stopPhonesDue`). ADE never pays for a
 * minute nobody pays for.
 */

import { isCloudBlocked, sendOwnerAlert } from "./blocks";
import { PHONE_CREDIT_MILLI_PER_MINUTE, accountWithUnsettledPhones, creditsAtStart, creditsOnFor, phoneCreditMilliOf, unsettledPhoneMilli } from "./credits";
import { captureCloudPhone, type CloudWaitUntil } from "./analytics";
import { freeCapRefuses } from "./costReport";
import { readComputerSignal, settleFreePlanComputer } from "./freePlan";
import { settleFreePlanGithub } from "./freePlanGithub";
import { CLOUD_PLANS, EXTRA_PHONE_MINUTE_CENTS } from "./plans";
import {
  CLOUD_DELETED_ACCOUNT_PREFIX,
  CLOUD_PATHS,
  CLOUD_PHONE_DEVICES,
  CLOUD_PHONE_PROVIDER_ABILITIES,
  CLOUD_PHONE_PROVIDERS,
  CLOUD_PHONE_RECENT_SHOWN,
  cloudPhoneAbilitiesOf,
  cloudPhoneLacks,
  isCloudPhoneDevice,
  isCloudPhoneProvider,
  type CloudAccountPhone,
  type CloudPhoneAccess,
  type CloudPhoneDevice,
  type CloudPhoneMinutes,
  type CloudPhoneMinutesState,
  type CloudPhoneProvider,
  type CloudPhoneProviderChoice,
  type CloudPhoneProviderChoiceAnswer,
  type CloudPhoneStart,
  type CloudPhoneState,
  type CloudPhoneSummary,
  type CloudPhoneUse,
  type CloudPhoneView,
} from "./contract";
import { readBoundedBody, sha256Hex } from "../sinkUtils";
import { forgetNomacLabel, nomacSignatureValid, phoneLabelFor, sessionOf, userIdOfLabel } from "./phoneNomac";
import { LIVE_STATES, isoMs, sentryCode, type PhoneRead, type PhoneSession, type PhoneWhere } from "./phoneProvider";
import { forgetRevylAccount } from "./phoneRevyl";
import { PHONE_PROVIDERS, UNSURE_START_MS, abilityWords, clientDrives, heldToUnsureStart, nextAbilities, pickedProviderOf, routeOf, startOnRoute } from "./phoneRoute";
import { phoneViewerPage } from "./phoneViewerPage";
import { CLOUD_PHONE_MAX_MINUTES } from "../../../desktop/src/shared/cloudPhone";
import { sendCloudEmail } from "./email";
import { warnHours } from "./hoursWarnings";
import { fail, json, readJson } from "./http";
import {
  PHONE_EXTRA,
  accountRules,
  earnedLeftForLimits,
  extraActiveForLimits,
  hasNoFreePlan,
  hoursState,
  includedMilliOf,
  listComputers,
  liveUsedMilli,
  loadAccount,
  logCloud,
  planIdOf,
  reportCloudFailure,
  type AccountRow,
  type CloudEnv,
} from "./store";

/** Webhook delivery ids are kept this long against repeats. */
const DELIVERY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** The ten-minute check reads at most this many live phones, and accounts to warn, a run. */
const CHECK_BATCH = 200;
/** The minute tick stops at most this many phones whose time ran out. */
const STOPS_PER_TICK = 50;
/** A row still `live` this long after it started is read from NoMac even when recent (a phone runs 2 hours at most). */
const LIVE_STALE_MS = 3 * 60 * 60_000;

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
  /** Who runs it (migration 0057): `nomac` for every phone before then. Text in D1: read it through `whereOfRow`. */
  provider: string;
  /** Revyl's workflow run for the phone, which its device calls name; null for NoMac. */
  provider_ref: string | null;
  /** 1: it started under credits (`credits.ts`, migration 0059) and counts in `used_milli`, never as iPhone minutes. */
  credits: number;
  /** How much of its billed minutes is already in `used_milli` (thousandths of a credit). */
  credited_milli: number;
};

/**
 * A start's claim on its account (`phone_start_claim`) lapses after this: a
 * start that died holding it. Longer than the slowest start's own timeouts
 * (Revyl's: its workspace, active sessions, `start_device`'s two minutes and
 * the read, about five minutes; then a failover to NoMac), so a slow start
 * still holds it while it runs.
 */
const PHONE_START_CLAIM_MS = 8 * 60_000;

/* ---- The providers ---- */

/** Why a phone ended, in NoMac's words, once it has. */
const endReasonOf = (session: PhoneSession): string | null => session.ended?.reason ?? session.end_reason ?? session.failure_code ?? null;

/** Where a phone runs, from its row (none: NoMac's). */
const whereOfRow = (row: Pick<PhoneRow, "provider" | "provider_ref" | "device"> | null): PhoneWhere =>
  ({ provider: row?.provider === "revyl" ? "revyl" : "nomac", ref: row?.provider_ref ?? null, device: row?.device ?? null });

/** One phone as its provider answers it now, or null when it can't be read. */
const readPhone = (env: CloudEnv, userId: string, phoneId: string, where: PhoneWhere): Promise<PhoneRead | null> =>
  PHONE_PROVIDERS[where.provider].read(env, userId, phoneId, where);

/** Where a phone this Worker keeps runs, from its row. */
async function phoneWhere(env: Pick<CloudEnv, "DB">, phoneId: string): Promise<PhoneWhere> {
  return whereOfRow(await env.DB.prepare("select provider, provider_ref, device from cloud_phones where phone_id = ?").bind(phoneId).first<Pick<PhoneRow, "provider" | "provider_ref" | "device">>());
}

/* ---- The phones an account started (`cloud_phones`) ---- */

/** The columns NoMac's answer fills, in `savePhone`'s and `updatePhone`'s order. */
function phoneFacts(session: PhoneSession, now: number) {
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

/** How a known row takes a newer answer: an ended phone never goes back to live (and holds no build), billed time and cost only grow. */
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
  build_started_at = case when cloud_phones.state = 'ended' or excluded.state = 'ended' then null else cloud_phones.build_started_at end,
  updated_at = excluded.updated_at`;

/** A credits phone's billed minutes in thousandths of a credit, as SQL on its `cloud_phones` row. */
const BILLED_CREDIT_MILLI_SQL = `(((billed_seconds + 59) / 60) * ${PHONE_CREDIT_MILLI_PER_MINUTE})`;

/**
 * A credits phone's newly billed minutes into its account's credits
 * (`used_milli`): what its billed minutes add past what was already counted
 * (`credited_milli`), so a repeated answer adds nothing. Only for a phone
 * started in the account's current period: one that ran across the turn had
 * its time so far charged to the ending period by the turn
 * (`startFreshPeriod`), and its later minutes are not charged to the new one.
 * Statements for the save's own batch, after its upsert.
 */
function phoneCreditStatements(db: D1Database, phoneId: string, now: number): D1PreparedStatement[] {
  const newMilli = `(select max(0, ${BILLED_CREDIT_MILLI_SQL} - credited_milli) from cloud_phones
    where phone_id = ? and credits = 1 and created_at >= cloud_accounts.period_start)`;
  return [
    db.prepare(`update cloud_accounts set used_milli = used_milli + ${newMilli}, updated_at = ?
      where user_id = (select user_id from cloud_phones where phone_id = ? and credits = 1) and coalesce(${newMilli}, 0) > 0`)
      .bind(phoneId, now, phoneId, phoneId),
    db.prepare(`update cloud_phones set credited_milli = ${BILLED_CREDIT_MILLI_SQL}
      where phone_id = ? and credits = 1 and credited_milli < ${BILLED_CREDIT_MILLI_SQL}`).bind(phoneId),
  ];
}

/**
 * Keeps what NoMac said about a phone this account started. A late or
 * repeated answer can't undo a newer one (`PHONE_MERGE_SQL`). `free` is
 * whether the account was on free rules when the phone started; `credits`,
 * whether credits reached it then (both only for a new row). A credits
 * phone's new billed minutes go into the account's credits in the same write.
 */
async function savePhone(
  env: Pick<CloudEnv, "DB">,
  userId: string,
  session: PhoneSession,
  now: number,
  { free = false, onlyLiveAccount = false, credits = false }: { free?: boolean; onlyLiveAccount?: boolean; credits?: boolean } = {},
): Promise<boolean> {
  const facts = phoneFacts(session, now);
  // `onlyLiveAccount`: a new row only while the account exists, checked in this write, so a deletion
  // that re-keyed its phones meanwhile never gets a row under the person's id back.
  const [saved] = await env.DB.batch([
    env.DB.prepare(`
      insert into cloud_phones (phone_id, user_id, device, state, created_at, ready_at, ended_at, billed_seconds, cost_micros, end_reason, free, updated_at, provider, provider_ref, credits)
      select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      where ? = 0 or exists (select 1 from cloud_accounts where user_id = ? and deleted_at is null)
      on conflict(phone_id) do update set ${PHONE_MERGE_SQL}
    `).bind(
      session.id, userId, facts.device, facts.state, isoMs(session.created_at) ?? now, facts.readyAt, facts.endedAt,
      facts.billedSeconds, facts.costMicros, facts.endReason, free ? 1 : 0, now, session.provider ?? "nomac", session.ref ?? null, credits ? 1 : 0,
      onlyLiveAccount ? 1 : 0, userId,
    ),
    ...phoneCreditStatements(env.DB, session.id, now),
  ]);
  return (saved?.meta.changes ?? 0) > 0;
}

/**
 * NoMac's answer for a phone this Worker keeps. A phone with no row yet (its
 * start's answer was lost, or the save failed) is recovered when its label
 * names a live account this Worker has, so its minutes are still counted; another
 * environment's phones (accounts this Worker doesn't have) are left alone.
 * Answers the row's account and its state before, or null.
 */
async function updatePhone(env: CloudEnv, session: PhoneSession, now: number): Promise<{ userId: string; wasEnded: boolean } | null> {
  const known = await env.DB.prepare("select user_id, state from cloud_phones where phone_id = ?").bind(session.id).first<{ user_id: string; state: string }>();
  if (known) {
    await savePhone(env, known.user_id, session, now);
    return { userId: known.user_id, wasEnded: known.state === "ended" };
  }
  const userId = userIdOfLabel(session.label);
  const account = userId
    ? await env.DB.prepare("select plan, stripe_status, phone_start_credits, phone_start_credits_at from cloud_accounts where user_id = ? and deleted_at is null")
      .bind(userId).first<Pick<AccountRow, "plan" | "stripe_status" | "phone_start_credits" | "phone_start_credits_at">>()
    : null;
  if (!userId || !account) return null;
  if (!(await savePhone(env, userId, session, now, { free: accountRules(account) === "free", onlyLiveAccount: true, credits: await recoveredCredits(env, userId, account, isoMs(session.created_at) ?? now) }))) return null;
  logCloud("cloud.phone_recovered", { userId, phoneId: session.id });
  return { userId, wasEnded: false };
}

/** How far a provider's clock may sit before ours: a phone from the latest start may say it began a little earlier. */
const START_CLOCK_SLACK_MS = 5 * 60_000;

/**
 * Whether a phone found with no row counts in credits: what the start that
 * made it decided (saved with its claim), when it is from the account's
 * latest start; else (one from before that record) the switch at its start.
 */
async function recoveredCredits(
  env: CloudEnv,
  userId: string,
  account: Pick<AccountRow, "phone_start_credits" | "phone_start_credits_at">,
  startedAt: number,
): Promise<boolean> {
  const at = account.phone_start_credits_at;
  if (at != null && account.phone_start_credits != null && startedAt >= at - START_CLOCK_SLACK_MS) return account.phone_start_credits === 1;
  return creditsAtStart(env, userId, startedAt);
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
  const provider = PHONE_PROVIDERS[where.provider];
  const stopped = await provider.stop(env, userId, phoneId, where);
  if (!stopped.ok) {
    // A phone that won't stop keeps costing: Sentry hears of it, per the provider's code.
    const { status, code } = stopped;
    reportCloudFailure(`${provider.stopFailedEvent}${sentryCode(code)}`, { userId, phoneId, why, status, code }, "cloud-phone");
    return false;
  }
  if (stopped.after) await savePhone(env, userId, stopped.after.session, now);
  else if (stopped.status === 404) {
    await env.DB.prepare("update cloud_phones set state = 'ended', ended_at = coalesce(ended_at, ?), end_reason = coalesce(end_reason, 'gone'), build_started_at = null, updated_at = ? where phone_id = ?")
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

/** The phones that count as iPhone minutes: every one but those started under credits (those count in `used_milli`). */
const minutePhones = (rows: readonly PhoneRow[]): PhoneRow[] => rows.filter((row) => row.credits !== 1);

/** NoMac's billed minutes of the minute phones, never an estimate: what billing counts. */
export const settledPhoneMinutes = (rows: readonly PhoneRow[]): number => phoneMinutesUsed(minutePhones(rows), 0, true);

/** The credits the period's credits phones used (thousandths), a running one's time so far included. */
function phoneCreditsUsedOf(rows: readonly PhoneRow[], now: number): number {
  let usedMilli = 0;
  for (const row of rows) if (row.credits === 1) usedMilli += Math.max(phoneCreditMilliOf(row, now), row.credited_milli);
  return usedMilli;
}

/* ---- Who may use it, and how much ---- */

/** The server's switch: `beta` (the owner's list), `all`, or `off`. */
export function phoneAccessSetting(env: Pick<CloudEnv, "CLOUD_PHONE_ACCESS">): "beta" | "all" | "off" {
  const value = env.CLOUD_PHONE_ACCESS?.trim().toLowerCase();
  return value === "all" || value === "off" ? value : "beta";
}

/** Some provider can start phones here. */
const anyProviderConfigured = (env: CloudEnv): boolean => CLOUD_PHONE_PROVIDERS.some((provider) => PHONE_PROVIDERS[provider].canStart(env));

/** Some provider's key is set: phones already running there are still read, held to their minutes and stopped. */
const anyProviderKey = (env: CloudEnv): boolean => CLOUD_PHONE_PROVIDERS.some((provider) => PHONE_PROVIDERS[provider].hasKey(env));

/**
 * Who may use the phone, and for a tester (on the beta list) the provider
 * they picked for their phones (`choice`, `auto` for the fixed order). One
 * read of the beta row, which says both.
 */
export async function phoneAccess(env: CloudEnv, userId: string): Promise<{ access: CloudPhoneAccess; choice: { provider: CloudPhoneProviderChoice; picked: CloudPhoneProvider | null } | null }> {
  // A key, not a start: a provider switched off for new phones (Revyl's) keeps its running ones usable.
  if (!anyProviderKey(env)) return { access: "off", choice: null };
  const setting = phoneAccessSetting(env);
  if (setting === "off") return { access: "off", choice: null };
  const row = await env.DB.prepare("select provider from cloud_phone_beta where user_id = ?").bind(userId).first<{ provider: string | null }>();
  const picked = pickedProviderOf(row?.provider);
  // Not on the list (under `beta`): hidden everywhere (Pricing v2). `soon` is never sent any more.
  return { access: setting === "all" || row ? "on" : "off", choice: row ? { provider: picked ?? "auto", picked } : null };
}

/**
 * `POST /cloud/phone/provider` `{ provider }`: a tester picks the provider
 * every phone of theirs starts on (`auto`: NoMac, then Revyl on a paid plan).
 * Only on the beta list; the live phone keeps its own, the next one follows.
 */
async function setProviderChoice(request: Request, env: CloudEnv, userId: string): Promise<Response> {
  const body = await readJson(request);
  const provider = body?.provider;
  if (provider !== "auto" && !isCloudPhoneProvider(provider)) return fail("bad_request", `provider is auto, ${CLOUD_PHONE_PROVIDERS.join(" or ")}.`, 400);
  const saved = await env.DB.prepare("update cloud_phone_beta set provider = ? where user_id = ?").bind(provider === "auto" ? null : provider, userId).run();
  if ((saved.meta?.changes ?? 0) !== 1) return fail("phone_not_on_account", "Only ADE Cloud iPhone testers can pick a provider.", 403);
  logCloud("cloud.phone_provider_picked", { userId, provider });
  return json({ ok: true, provider } satisfies CloudPhoneProviderChoiceAnswer);
}

/** The plan's minutes: none on a free plan the free-plan checks hold, as with free hours. */
export function includedPhoneMinutes(account: AccountRow): number {
  const plan = planIdOf(account);
  if (plan === "free" && (account.free_refused_at != null || account.free_github_hold != null)) return 0;
  return CLOUD_PLANS[plan].phoneMinutes;
}

/**
 * The minutes the account's limits count: the account test tool's
 * (`test_phone_minutes`), else the plan's. Billing keeps
 * `includedPhoneMinutes`: extra minutes are counted past the real plan's.
 * A test plan alone leaves them the real plan's.
 */
export function phoneMinutesForLimits(account: AccountRow): number {
  return account.test_phone_minutes != null && account.test_phone_minutes >= 0 ? account.test_phone_minutes : includedPhoneMinutes(account);
}

/** Extra minutes are on for the account: offered, a paid account, and turned on. Billing reads this. */
export const phoneExtraOn = (env: CloudEnv, account: AccountRow): boolean =>
  extraPhoneOffered(env) && accountRules(account) === "paid" && account.phone_extra_enabled === PHONE_EXTRA.on;

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
  /** Under credits: the credits the iPhone used this period (thousandths). Null on iPhone minutes. */
  creditsUsedMilli: number | null;
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

/**
 * Credits in force for an account's phone (`credits.ts`): the account's
 * hours used now, computers' running stretches and running credits phones'
 * unsettled minutes included. Null when the phone counts iPhone minutes.
 */
export type PhoneCredits = { liveUsedMilli: number };

/**
 * The account's `PhoneCredits`, or null. `counts`: whether this phone counts
 * in credits, when it is known (a running phone keeps what it started on,
 * `cloud_phones.credits`); left out, whether credits reach the account now
 * (a new phone). `reload`: read the account again (a phone's save since
 * `account` was read may have added to `used_milli`), in one read with the
 * phones' settled marks.
 */
export async function phoneCreditsFor(
  env: CloudEnv,
  account: AccountRow,
  now: number,
  { reload = false, counts }: { reload?: boolean; counts?: boolean } = {},
): Promise<PhoneCredits | null> {
  if (counts === false || (counts === undefined && !(await creditsOnFor(env, account.user_id)))) return null;
  if (reload) {
    const read = await accountWithUnsettledPhones(env, account.user_id, now);
    if (read.liveUsedMilli != null) return { liveUsedMilli: read.liveUsedMilli };
  }
  return { liveUsedMilli: liveUsedMilli(account, await listComputers(env, account.user_id), now) + await unsettledPhoneMilli(env, account, now) };
}

/**
 * Where an account's minutes stand this period. `settledOnly` leaves out the
 * running phone's estimate (for billing).
 *
 * Under credits (`credits` set) the phone has no minutes of its own: what it
 * may use is what the account's credits allow, one credit a minute (the
 * plan's, then earned ones, then any minute while extra hours are on, which
 * bill it as an extra hour). `included` is then what it used plus what it may
 * still use, so an older client's "used of included" still reads right.
 * Minutes of phones from before credits (`minutePhones`) keep their own
 * billing either way.
 */
export function phoneUsageOf(env: CloudEnv, account: AccountRow, rows: readonly PhoneRow[], now: number, settledOnly = false, credits: PhoneCredits | null = null): PhoneUsage {
  const minuteRows = minutePhones(rows);
  // A test's minutes are the whole limit: no extra minutes are offered or used past them.
  const underTest = account.test_phone_minutes != null;
  const limitCents = account.phone_extra_limit_cents ?? null;
  // Extra iPhone minutes billed this period: only minute phones', past the real plan's minutes.
  const minutesUsed = phoneMinutesUsed(minuteRows, now, settledOnly);
  const minutesEnabled = !underTest && phoneExtraOn(env, account);
  const billableMinutes = billableExtraMinutes({ used: minutesUsed, included: includedPhoneMinutes(account), enabled: minutesEnabled, limitCents, owed: inPeriod(account, account.phone_extra_owed_minutes) });
  if (credits) {
    // The hours used now, the running phone's time its provider hasn't billed yet included.
    const live = credits.liveUsedMilli;
    const leftMilli = Math.max(0, includedMilliOf(account) - live) + Math.max(0, earnedLeftForLimits(account, live));
    const left = Math.floor(leftMilli / PHONE_CREDIT_MILLI_PER_MINUTE);
    const extraOn = extraActiveForLimits(account);
    const used = phoneMinutesUsed(rows, now, settledOnly);
    return {
      included: used + left,
      used,
      left,
      // Credits have their own warnings (the hours emails): the phone sends none of its own.
      state: "none",
      creditsUsedMilli: phoneCreditsUsedOf(rows, now),
      extra: { available: false, enabled: false, limitCents: null, billableMinutes, leftMinutes: extraOn ? CLOUD_PHONE_MAX_MINUTES : 0 },
    };
  }
  // What the limits count (a test's minutes) and what billing counts (the plan's) part only under a test.
  const included = phoneMinutesForLimits(account);
  const used = minutesUsed;
  const available = !underTest && extraPhoneOffered(env) && accountRules(account) === "paid";
  const leftMinutes = minutesEnabled ? Math.max(0, extraLimitMinutes(limitCents) - Math.max(0, used - included)) : 0;
  const state: CloudPhoneMinutesState = included > 0 && used >= included ? "zero" : included > 0 && used >= included * 0.8 ? "warn80" : "none";
  return {
    included,
    used,
    left: Math.max(0, included - used),
    state,
    creditsUsedMilli: null,
    extra: { available, enabled: minutesEnabled, limitCents, billableMinutes, leftMinutes: Number.isFinite(leftMinutes) ? leftMinutes : CLOUD_PHONE_MAX_MINUTES },
  };
}

/** Minutes a phone may still run for the account: the plan's left, then extra minutes left. */
const allowedMinutes = (usage: PhoneUsage): number => usage.left + usage.extra.leftMinutes;

const minutesOf = (usage: PhoneUsage): CloudPhoneMinutes => ({ included: usage.included, used: usage.used, left: usage.left });

/**
 * `CloudAccountState.phone`, from D1 alone (no call to NoMac): the account
 * read is polled. `credits`: the account's credits when they reach it (the
 * caller already read its hours).
 */
export async function phoneAccountState(env: CloudEnv, account: AccountRow, now: number, credits: PhoneCredits | null): Promise<CloudAccountPhone> {
  const { access, choice } = await phoneAccess(env, account.user_id);
  const usage = phoneUsageOf(env, account, await periodPhones(env, account.user_id, account.period_start), now, false, credits);
  return {
    access,
    ...(choice ? { providerChoice: choice.provider } : {}),
    ...(usage.creditsUsedMilli != null ? { creditsUsedMilli: usage.creditsUsedMilli } : {}),
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

function summaryOfSession(session: PhoneSession, stopNotice: unknown): CloudPhoneSummary {
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
  live: { session: PhoneSession; stopNotice: unknown; createdAt: number; where: PhoneWhere } | null;
  /** The account's newest phone, live or not: a new start's idempotency key names it. */
  lastPhoneId: string | null;
  /** The live row's phone when NoMac couldn't be read now: a stop still reaches it. */
  liveRowId: string | null;
  /** This period's phone rows, newest first. */
  rows: PhoneRow[];
  /** The account's credits when they reach it (`credits.ts`), or null: the phone counts iPhone minutes. */
  credits: PhoneCredits | null;
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
    const where = whereOfRow(liveRow);
    const read = await readPhone(env, userId, liveRow.phone_id, where);
    if (!read) unreadLiveRowId = liveRow.phone_id;
    if (read) {
      await savePhone(env, userId, read.session, now);
      rows = await periodPhones(env, userId, account.period_start);
      // A stop saved `ended` while this read was in flight: the row's state wins over the older answer.
      const saved = rows.find((row) => row.phone_id === liveRow.phone_id)
        ?? await env.DB.prepare("select state from cloud_phones where phone_id = ?").bind(liveRow.phone_id).first<Pick<PhoneRow, "state">>();
      if (LIVE_STATES.has(read.session.state) && saved?.state === "live") live = { ...read, createdAt: liveRow.created_at, where: { ...where, ref: read.session.ref ?? where.ref } };
    }
  }
  const newest = await env.DB.prepare("select phone_id from cloud_phones where user_id = ? order by created_at desc limit 1").bind(userId).first<{ phone_id: string }>();
  // A running phone is held to what it started on (minutes or credits), whatever the switch says now; a
  // new one, to what reaches the account now. Read after the live phone's save: its new minutes are in by then.
  const stillLive = liveRow != null && (live != null || unreadLiveRowId != null);
  const credits = await phoneCreditsFor(env, account, now, { reload: liveRow != null, counts: stillLive ? liveRow.credits === 1 : undefined });
  return { account, label, usage: phoneUsageOf(env, account, rows, now, false, credits), live, lastPhoneId: newest?.phone_id ?? null, liveRowId: unreadLiveRowId, rows, credits };
}

/** A live phone from an earlier period ran under that period's terms. */
const startedBeforePeriod = (context: PhoneContext): boolean => context.live != null && context.live.createdAt < context.account.period_start;

/** Why the account's live phone must stop now, or null while it may run on. */
async function stopReasonOf(env: CloudEnv, userId: string, context: PhoneContext, now: number): Promise<string | null> {
  if (startedBeforePeriod(context)) return "period_changed";
  // One phone's longest: Revyl's has no limit of its own, so this check is its stop.
  if (context.live && now >= context.live.createdAt + CLOUD_PHONE_MAX_MINUTES * 60_000) return "time_limit";
  if ((await phoneAccess(env, userId)).access !== "on") return "access_removed";
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
  const why = await stopReasonOf(env, userId, context, now);
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
      // A deleted account's phone (its start ended after the deletion and its stop failed): its Revyl
      // workspace, kept under the same key, is disconnected first (that stops its phones; a failure is
      // tried again next tick), then the phone is stopped until it is.
      if (isDeletedAccount(row.user_id)) {
        await forgetRevylAccount(env, row.user_id);
        await stopPhone(env, row.user_id, row.phone_id, now, "account_deleted");
        continue;
      }
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
  if (context.credits) {
    const next = accountRules(account) === "free"
      ? "Pick a plan in Settings › ADE Cloud for more"
      : "Turn on extra credits in Settings › ADE Cloud to keep going";
    return { code: "phone_credits_out", message: `Your ADE Cloud credits are used up, and the iPhone uses one a minute. ${next}, or wait until ${resets}.` };
  }
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
 * `/cloud/phone`, `/cloud/phone/view` and `/cloud/phone/call` for a signed-in
 * caller (`routes.ts` checked the sign-in and the owner's block first).
 */
export async function routePhone(request: Request, path: string, env: CloudEnv, userId: string, now: number, waitUntil?: CloudWaitUntil): Promise<Response | null> {
  if (path !== CLOUD_PATHS.phone && path !== CLOUD_PATHS.phoneView && path !== CLOUD_PATHS.phoneCall && path !== CLOUD_PATHS.phoneProvider) return null;
  const { access, choice } = await phoneAccess(env, userId);
  const picked = choice?.picked ?? null;
  if (path === CLOUD_PATHS.phoneProvider) {
    return request.method === "POST" ? setProviderChoice(request, env, userId) : fail("not_found", "ADE Cloud has no such route.", 404);
  }

  if (path === CLOUD_PATHS.phone && request.method === "GET") {
    if (access !== "on") return json({ access, minutes: null, phone: null } satisfies CloudPhoneState);
    const context = await phoneContext(env, userId, now);
    if (context instanceof Response) return context;
    return json({
      access,
      minutes: minutesOf(context.usage),
      phone: context.live ? summaryOfSession(context.live.session, context.live.stopNotice) : null,
      recent: recentPhonesOf(context.rows, now),
      abilities: context.live ? [...CLOUD_PHONE_PROVIDER_ABILITIES[context.live.where.provider]] : nextAbilities(env, picked),
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
    return anyProviderConfigured(env) && phoneAccessSetting(env) === "beta"
      ? fail("phone_not_on_account", "The ADE Cloud iPhone isn't on this account.", 403)
      : fail("phone_unavailable", "The ADE Cloud iPhone isn't available right now.", 503);
  }
  if (path === CLOUD_PATHS.phoneCall) {
    return request.method === "POST" ? routePhoneCall(request, env, userId, now) : fail("not_found", "ADE Cloud has no such route.", 404);
  }
  const starting = path === CLOUD_PATHS.phone && request.method === "POST";
  // A start is use of the free plan: one free plan per computer and per GitHub account, as a computer's start
  // settles them (`routes.ts`), only once the account may use the phone at all.
  if (starting) {
    const account = await loadAccount(env, userId, now);
    await settleFreePlanComputer(env, account, readComputerSignal(request), "use", { now, waitUntil });
    await settleFreePlanGithub(env, account, { now, waitUntil });
  }
  const context = await phoneContext(env, userId, now);
  if (context instanceof Response) return context;
  if (starting) return startPhone(request, env, userId, now, context, picked, waitUntil);
  if (request.method !== "POST") return fail("not_found", "ADE Cloud has no such route.", 404);

  const live = context.live;
  if (!live) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running. Start it first.", 409);
  const body = await readJson(request);
  // The view: a control link by default (the person uses the phone in the pane).
  const view = await PHONE_PROVIDERS[live.where.provider].view(env, {
    userId,
    phone: { id: live.session.id, ref: live.where.ref },
    label: context.label,
    control: body?.control !== false,
    origin: new URL(request.url).origin,
    now,
  });
  return view instanceof Response ? view : json(view satisfies CloudPhoneView);
}

/**
 * `POST /cloud/phone` `{ device?, attach?, providers?, needs? }`: starts the
 * account's phone or answers its live one. `providers` lists the providers
 * the client can drive (a brain from before Revyl sends none: NoMac only);
 * `needs`, the abilities a running phone must have. A new phone's provider
 * never follows them (`routeOf`): an ability it lacks answers as unavailable.
 */
async function startPhone(request: Request, env: CloudEnv, userId: string, now: number, context: PhoneContext, picked: CloudPhoneProvider | null, waitUntil?: CloudWaitUntil): Promise<Response> {
  const plan = planIdOf(context.account);
  const body = await readJson(request);
  if (!body) return fail("bad_request", "That request could not be read.", 400);
  const device = readDevice(body.device);
  if (device === null) return fail("bad_request", `device is one of ${CLOUD_PHONE_DEVICES.join(", ")}.`, 400);
  const drives = clientDrives(body.providers);
  const needs = cloudPhoneAbilitiesOf(body.needs);
  // A phone from an earlier period ran under that period's terms: it ends, and a new one starts on this period's.
  // Not for `attach` (Keep on): the allowance check ends that phone on its own schedule.
  if (context.live && startedBeforePeriod(context) && body.attach !== true) {
    // A stop the provider refused leaves that phone running: no second one beside it.
    if (!(await stopPhone(env, userId, context.live.session.id, now, "period_changed"))) {
      return fail("phone_unavailable", "Your ADE Cloud iPhone from last period couldn't be stopped yet. Try again in a moment.", 503);
    }
    // The new phone is held to what reaches the account now, not to the stopped one's billing.
    const fresh = await phoneContext(env, userId, now);
    if (fresh instanceof Response) return fresh;
    context = { ...fresh, live: null };
  }
  let session = context.live?.session ?? null;
  let reused = Boolean(session);
  let provider: CloudPhoneProvider = context.live?.where.provider ?? "nomac";
  // `attach`: a token for the live phone only (a brain keeping it on); never a start. A client that can't
  // drive the live phone's provider (an old brain, a Revyl phone) is told it isn't running.
  if (body.attach === true && (!session || !drives(provider))) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running.", 409);
  // A plain start from that client, with such a phone live: it can't drive what it would get (an empty token).
  if (session && !drives(provider)) {
    return fail("phone_needs_update", "Your ADE Cloud iPhone is running somewhere this version of ADE can't drive. Update ADE, or stop the phone first.", 409);
  }
  // A running phone keeps its provider: one that can't do what this start needs is never swapped quietly.
  const lacked = session && body.attach !== true ? cloudPhoneLacks(provider, needs) : [];
  if (lacked.length) {
    return fail("phone_lacks", `Your running ADE Cloud iPhone can't ${abilityWords(lacked)}. Stop it first, then start a new one.`, 409);
  }
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
    // A live phone its provider couldn't answer for now may still be running: a start now could add a
    // second billed phone (at another provider, or one that can do what this one needs). Ask again, or stop it.
    if (context.liveRowId) {
      logCloud("cloud.phone_start_refused", { userId, code: "phone_unreadable", phoneId: context.liveRowId });
      return fail("phone_unavailable", "Your ADE Cloud iPhone isn't answering right now. Try again in a moment, or stop it first.", 503);
    }
    const minutes = Math.min(CLOUD_PHONE_MAX_MINUTES, allowedMinutes(context.usage));
    const routed = routeOf(env, { picked, free: accountRules(context.account) === "free" }, drives);
    if (routed instanceof Response) return routed;
    // One start per account at a time, across providers and machines: two starts that both saw no live phone
    // would each make one (and bill both). The other is told to try again, and then finds this phone.
    const startingElsewhere = (): Response => fail("phone_starting", "Your ADE Cloud iPhone is starting. Try again in a moment.", 409);
    // What this start decides about billing, saved with the claim: a phone found later with no row is billed so.
    // A retry of a start whose answer was lost may get that start's phone back from the provider: in the same
    // write, it keeps that start's decision (and its time), whatever reaches the account now.
    const retryHeldSql = "phone_start_unsure is not null and phone_start_unsure_at > ? and phone_start_credits is not null";
    const since = now - UNSURE_START_MS;
    const claimed = await env.DB.prepare(`update cloud_accounts set phone_start_claim = ?,
      phone_start_credits = case when ${retryHeldSql} then phone_start_credits else ? end,
      phone_start_credits_at = case when ${retryHeldSql} then phone_start_credits_at else ? end
      where user_id = ? and (phone_start_claim is null or phone_start_claim < ?)`)
      .bind(now, since, context.credits != null ? 1 : 0, since, now, userId, now - PHONE_START_CLAIM_MS).run();
    if ((claimed.meta?.changes ?? 0) !== 1) return startingElsewhere();
    let begun: Awaited<ReturnType<typeof startOnRoute>>;
    try {
      // Read after the claim: a start that lost its answer while this one waited holds the route and the billing.
      const held = await env.DB.prepare("select phone_start_unsure, phone_start_unsure_at, phone_start_credits from cloud_accounts where user_id = ?")
        .bind(userId).first<Pick<AccountRow, "phone_start_unsure" | "phone_start_unsure_at" | "phone_start_credits">>();
      const startCredits = held?.phone_start_credits === 1;
      const route = heldToUnsureStart(routed, held ?? {}, now);
      if (route instanceof Response) {
        logCloud("cloud.phone_start_refused", { userId, code: "phone_start_unsure", provider: held?.phone_start_unsure ?? null });
        return route;
      }
      // Needs never pick the provider: the route's first must do them all, and a fallback that can't is
      // left out, so no billed phone starts that can't do what was asked.
      const lacking = cloudPhoneLacks(route.order[0], needs);
      if (lacking.length) {
        logCloud("cloud.phone_start_refused", { userId, code: "phone_lacks", needs: lacking, provider: route.order[0] });
        return fail("phone_lacks", `The ADE Cloud iPhone can't ${abilityWords(lacking)}.`, 409);
      }
      route.order = route.order.filter((provider) => cloudPhoneLacks(provider, needs).length === 0);
      // A start that finished between this request's read and its claim: its phone is the answer next time.
      const another = await env.DB.prepare("select 1 from cloud_phones where user_id = ? and state = 'live' limit 1").bind(userId).first();
      if (another) return startingElsewhere();
      begun = await startOnRoute(env, route, userId, { userId, label: context.label, device, minutes, lastPhoneId: context.lastPhoneId, now });
      // The account was deleted while the provider started it: no row comes back under the person's id,
      // and the phone stops rather than run unbilled.
      if (!(begun instanceof Response) && !(await savePhone(env, userId, begun.started.session, now, { free: accountRules(context.account) === "free", onlyLiveAccount: true, credits: startCredits }))) {
        const { provider: gone, started: { session: orphan } } = begun;
        const stopped = await PHONE_PROVIDERS[gone].stop(env, userId, orphan.id, { provider: gone, ref: orphan.ref ?? null, device: orphan.device ?? null })
          .catch((): { ok: false } => ({ ok: false }));
        // A Revyl workspace this start made after the deletion cleaned up: disconnected too.
        const forgotten = await forgetRevylAccount(env, userId).then(() => true, () => false);
        reportCloudFailure("cloud.phone_start_account_gone", { userId, phoneId: orphan.id, provider: gone, stopped: stopped.ok, forgotten }, "cloud-phone");
        // What failed is kept under the deleted account's key, due now, with the workspace it needs:
        // the minute tick disconnects and stops it until both are done (`stopPhonesDue`).
        if (!stopped.ok || !forgotten) {
          const hashed = `${CLOUD_DELETED_ACCOUNT_PREFIX}${await sha256Hex(userId)}`;
          await env.DB.batch([
            env.DB.prepare(`insert into cloud_phones (phone_id, user_id, device, state, created_at, updated_at, provider, provider_ref, stop_at)
              values (?, ?, ?, 'live', ?, ?, ?, ?, ?) on conflict(phone_id) do nothing`)
              .bind(orphan.id, hashed, orphan.device ?? null, now, now, gone, orphan.ref ?? null, now),
            env.DB.prepare("update cloud_phone_revyl set user_id = ? where user_id = ?").bind(hashed, userId),
          ]);
        }
        return fail("not_found", "This ADE account no longer exists.", 404);
      }
    } finally {
      await env.DB.prepare("update cloud_accounts set phone_start_claim = null where user_id = ? and phone_start_claim = ?").bind(userId, now).run();
    }
    if (begun instanceof Response) return begun;
    const { started, reason } = begun;
    provider = begun.provider;
    ({ session, reused } = started);
    // A phone with no limits of its own (Revyl's): its stop_at is the limit from the start.
    if (!PHONE_PROVIDERS[provider].ownsTimeLimit) {
      await env.DB.prepare("update cloud_phones set stop_at = coalesce(stop_at, ?), updated_at = ? where phone_id = ? and state = 'live'").bind(now + minutes * 60_000, now, session.id).run();
    }
    logCloud("cloud.phone_started", { userId, phoneId: session.id, reused, device: session.device ?? "iphone", minutes, extra: context.usage.left === 0, provider, route: reason, ...(needs.length ? { needs } : {}) });
    if (!reused) {
      captureCloudPhone(env, waitUntil, userId, {
        step: "started",
        plan,
        device: session.device ?? "iphone",
        minutesLeft: context.usage.left,
        extra: context.usage.left === 0,
        provider,
        route: reason,
      }, session.id, now);
    }
  }
  const drive = await PHONE_PROVIDERS[provider].startAnswer(env, session, userId, now);
  if (drive instanceof Response) return drive;
  return json({ phone: summaryOfSession(session, null), reused, token: drive.token, minutes: minutesOf(context.usage), apiBase: drive.apiBase, provider } satisfies CloudPhoneStart);
}

/**
 * `POST /cloud/phone/call`: one call to the live phone at a provider with no
 * per-phone token. Brains poll it (`wait`), so it reads the live row alone:
 * no account load, no provider read, no write.
 */
async function routePhoneCall(request: Request, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const row = await env.DB.prepare("select phone_id, provider, provider_ref, device, ready_at from cloud_phones where user_id = ? and state = 'live' order by created_at desc limit 1")
    .bind(userId).first<Pick<PhoneRow, "phone_id" | "provider" | "provider_ref" | "device" | "ready_at">>();
  if (!row) return fail("phone_not_running", "Your ADE Cloud iPhone isn't running. Start it first.", 409);
  const body = await readJson(request);
  if (!body) return fail("bad_request", "That request could not be read.", 400);
  // The phone the brain holds (`phoneId`): once another one replaced it, its steps never reach the new phone.
  if (typeof body.phoneId === "string" && body.phoneId !== row.phone_id) {
    return fail("phone_not_running", "The cloud iPhone this command was using has stopped.", 409);
  }
  const where = whereOfRow(row);
  const call = PHONE_PROVIDERS[where.provider].call;
  if (!call) return fail("bad_request", "This phone takes its calls directly.", 400);
  if (row.ready_at == null) return fail("phone_starting", "Your ADE Cloud iPhone is still starting. Try again in a moment.", 409);
  return call(env, userId, { id: row.phone_id, ref: where.ref }, body, now);
}

/** `GET /cloud/phone/viewer`: ADE's page for a phone streamed over WebRTC (Revyl's). Static; the link's `#` part names the phone. */
export const isPhoneViewerRequest = (path: string, method: string): boolean => path === CLOUD_PATHS.phoneViewer && method === "GET";
export const handlePhoneViewer = (): Response => phoneViewerPage();

/* ---- NoMac's webhook ---- */

export const isNomacWebhookRequest = (path: string, method: string): boolean => path === CLOUD_PATHS.nomacWebhook && method === "POST";

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
      const read = await readPhone(env, row.user_id, row.phone_id, whereOfRow(row));
      if (read) await savePhone(env, row.user_id, read.session, now);
    } catch (error) {
      reportCloudFailure("cloud.phone_check_read_failed", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  // A Revyl phone saved as ended on its stop had only an estimate then: its final time is read once more.
  const settling = await env.DB.prepare("select phone_id, user_id, created_at, updated_at, provider, provider_ref, device from cloud_phones where state = 'ended' and provider = 'revyl' and ended_at >= ? limit ?")
    .bind(now - 15 * 60_000, CHECK_BATCH).all<Pick<PhoneRow, "phone_id" | "user_id" | "created_at" | "updated_at" | "provider" | "provider_ref" | "device">>();
  for (const row of settling.results ?? []) {
    if (isDeletedAccount(row.user_id)) continue;
    try {
      const read = await readPhone(env, row.user_id, row.phone_id, whereOfRow(row));
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
      if ((await phoneAccess(env, userId)).access !== "on") continue;
      // Under credits the phone has no minutes of its own: the balance's emails warn (an account with
      // no computer in the minute tick hears them only from here).
      const credits = await phoneCreditsFor(env, account, now);
      if (credits) {
        await warnHours(env, account, hoursState(account, credits.liveUsedMilli), credits.liveUsedMilli, now, hasNoFreePlan(account));
        continue;
      }
      const usage = phoneUsageOf(env, account, await periodPhones(env, userId, account.period_start), now);
      await warnPhoneMinutes(env, account, usage, now);
    } catch (error) {
      reportCloudFailure("cloud.phone_warning_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  await env.DB.prepare("delete from cloud_nomac_deliveries where received_at < ?").bind(now - DELIVERY_KEEP_MS).run();
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
  // Revyl first: disconnecting the workspace stops its phones and revokes its credentials. Its failure
  // never blocks NoMac's cleanup; it is thrown after, so the deletion is retried.
  let revylFailure: unknown = null;
  await forgetRevylAccount(env, userId).catch((error: unknown) => {
    revylFailure = error;
  });
  const hadPhone = await env.DB.prepare("select 1 from cloud_phones where user_id = ? and provider = 'nomac' limit 1").bind(userId).first();
  const inBeta = await env.DB.prepare("select 1 from cloud_phone_beta where user_id = ?").bind(userId).first();
  const label = phoneLabelFor(userId);
  // NoMac is skipped only for an account that could never have started a phone. One that could
  // may have a phone with no row (its start's answer was lost), so its label is always cleaned.
  if (label && (hadPhone || inBeta || phoneAccessSetting(env) === "all")) {
    // No key: a phone with a row means data at NoMac, tried again later; none means no phone could start here.
    if (env.NOMAC_API_KEY?.trim()) await forgetNomacLabel(env, label);
    else if (hadPhone) throw new Error("phone_cleanup_no_key");
  }
  // The beta row is what sends a retry to NoMac: it goes only once NoMac's cleanup is done.
  await env.DB.prepare("delete from cloud_phone_beta where user_id = ?").bind(userId).run();
  if (revylFailure) throw revylFailure;
}
