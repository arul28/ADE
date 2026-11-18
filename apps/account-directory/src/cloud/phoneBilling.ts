/**
 * Extra ADE Cloud iPhone minutes past a paid plan (`phones.ts`): the switch
 * and its monthly limit, and the minutes to Stripe's meter.
 *
 * What is billed for a period is its settled minutes (NoMac's billed minutes,
 * never an estimate) past the plan's, up to the limit while the switch is on,
 * and never less than what was owed when it went off. Each report carries the
 * minutes not sent yet and is identified by where it starts, so a resend after
 * a crash is the same report (Stripe drops it): a minute is never billed twice.
 *
 * A period that has ended is billed after it ends, once none of its phones
 * still runs: the renewal, a cancel or a paid plan's failed payment starts a
 * new period while minutes of the old one may still settle. The old period is
 * billed at its own plan's minutes (`phone_extra_included`, kept fresh each
 * tick, and never fewer than the plan the account buys now), so a downgrade at
 * the renewal can't bill minutes the old plan included. A `past_due` account is
 * left until it pays or ends: the old period comes back on a paid invoice.
 */

import { CloudBillingError, StripeRequestError, isDuplicateReport, stripeRequest, subscriptionItems, unavailable } from "./billing";
import {
  billableExtraMinutes,
  enforcePhoneAllowance,
  includedPhoneMinutes,
  periodPhones,
  phoneUsageOf,
  settledPhoneMinutes,
} from "./phones";
import { CLOUD_PLANS } from "./plans";
import { PHONE_EXTRA, accountRules, boughtPlanIdOf, loadAccount, logCloud, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

/**
 * Makes sure the subscription bills extra iPhone minutes. Read again after a
 * 5xx and tried once more under a key of its own, as the extra-hours item is.
 */
async function ensurePhoneMinutesItem(env: CloudEnv, account: AccountRow, now: number): Promise<void> {
  const subscriptionId = account.stripe_subscription_id;
  const price = env.STRIPE_PHONE_MINUTE_PRICE_ID?.trim();
  if (!subscriptionId || !price || !env.STRIPE_PHONE_METER_EVENT?.trim()) {
    reportCloudFailure("cloud.extra_phone_not_configured", { userId: account.user_id });
    throw unavailable();
  }
  const holds = async () => (await subscriptionItems(env, subscriptionId)).some((item) => item.price === price);
  try {
    if (await holds()) return;
    const key = `ade-cloud-phone-item-${subscriptionId}-${price}`;
    const create = (idempotencyKey: string) => stripeRequest(env, "POST", "/subscription_items", { subscription: subscriptionId, price }, idempotencyKey);
    await create(key).catch(async (error: unknown) => {
      if (!(error instanceof StripeRequestError) || error.status < 500) throw error;
      if (await holds()) return;
      await create(`${key}-${now}`);
    });
    logCloud("cloud.extra_phone_item_added", { userId: account.user_id, subscriptionId });
  } catch (error) {
    if (error instanceof StripeRequestError) {
      if (error.status === 409 && await holds()) return;
      reportCloudFailure("cloud.extra_phone_item_failed", { status: error.status, message: error.stripeMessage });
      throw unavailable();
    }
    throw error;
  }
}

/** Whether the account still tracks a period that has ended (its minutes may not be billed yet). */
const tracksEndedPeriod = (account: AccountRow): boolean =>
  account.phone_extra_period_start != null && account.phone_extra_period_start < account.period_start;

/** Settled extra minutes this period, as billed now. */
async function billableThisPeriod(env: CloudEnv, account: AccountRow, now: number): Promise<number> {
  const rows = await periodPhones(env, account.user_id, account.period_start);
  return phoneUsageOf(env, account, rows, now, true).extra.billableMinutes;
}

/**
 * Extra iPhone minutes on (paid plans only), with a monthly limit in cents or
 * none, or off. Turning them off keeps what was already used past the plan
 * owed for this period, so it is still billed; nothing new is used after. A
 * running phone is held to the new choice at once (`enforcePhoneAllowance`).
 */
export async function setExtraPhoneMinutes(
  env: CloudEnv,
  userId: string,
  choice: { enabled: true; monthlyLimitCents: number | null } | { enabled: false },
  now: number,
): Promise<void> {
  let account = await loadAccount(env, userId, now);
  // A failed payment: the period it stopped may come back with the payment, so nothing is settled or changed until then.
  if (account.stripe_status === "past_due") {
    throw new CloudBillingError("needs_paid_plan", "Extra iPhone minutes change once your last payment goes through.", 403);
  }
  // An ended period still tracked is billed first, at its own settings, so this choice starts clean on the
  // current one: its running phone stops, then its minutes go out. Until they have, the choice waits.
  if (tracksEndedPeriod(account)) {
    await enforcePhoneAllowance(env, userId, now);
    await settleEndedPeriod(env, account, now);
    account = await loadAccount(env, userId, now);
    if (tracksEndedPeriod(account)) {
      throw new CloudBillingError("billing_busy", "ADE Cloud is closing last period's iPhone minutes. Try again in a minute.", 409);
    }
  }
  // What was used under the settings before this change, kept owed after it (`keepOwedUnderOldSettings`).
  // "Was on" counts: a payment that failed and came back leaves the period's earlier minutes owed.
  const wasEnabled = account.phone_extra_enabled === PHONE_EXTRA.on || account.phone_extra_enabled === PHONE_EXTRA.wasOn;
  const before = { enabled: wasEnabled && accountRules(account) === "paid", limitCents: account.phone_extra_limit_cents ?? null };
  // Saved before the switch moves, so a failure after it never leaves used minutes unowed (a retry reads the new switch).
  if (before.enabled) await keepOwedUnderOldSettings(env, userId, before, now);
  if (choice.enabled) {
    if (accountRules(account) !== "paid") throw new CloudBillingError("needs_paid_plan", "Extra iPhone minutes need a paid plan.", 403);
    await ensurePhoneMinutesItem(env, account, now);
    // What was sent and owed in this period stays: turning it on again bills no minute twice and drops none owed.
    await env.DB.prepare(`
      update cloud_accounts set phone_extra_enabled = ${PHONE_EXTRA.on}, phone_extra_limit_cents = ?,
        phone_extra_period_start = coalesce(phone_extra_period_start, ?),
        phone_extra_included = ?, updated_at = ?
      where user_id = ?
    `).bind(choice.monthlyLimitCents, account.period_start, includedPhoneMinutes(account), now, userId).run();
    logCloud("cloud.extra_phone_on", { userId, limitCents: choice.monthlyLimitCents });
  } else {
    await env.DB.prepare(`
      update cloud_accounts set phone_extra_enabled = ${PHONE_EXTRA.off}, phone_extra_period_start = coalesce(phone_extra_period_start, ?), updated_at = ?
      where user_id = ?
    `).bind(account.period_start, now, userId).run();
    logCloud("cloud.extra_phone_off", { userId });
  }
  // The running phone first: held to the new choice, a phone past it stops and its last minutes settle.
  try {
    await enforcePhoneAllowance(env, userId, now);
  } catch (error) {
    reportCloudFailure("cloud.extra_phone_enforce_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
  }
  if (before.enabled) await keepOwedUnderOldSettings(env, userId, before, now);
}

/**
 * Minutes already used under the settings before a change stay owed: a lower
 * limit, or the switch off, stops further use and never erases a minute used
 * while the old settings allowed it. Read after the running phone was held to
 * the new choice, so a phone it stopped counts its last minutes.
 */
async function keepOwedUnderOldSettings(env: CloudEnv, userId: string, before: { enabled: boolean; limitCents: number | null }, now: number): Promise<void> {
  const account = await loadAccount(env, userId, now);
  if (account.phone_extra_period_start !== account.period_start) return;
  const rows = await periodPhones(env, userId, account.period_start);
  const owed = billableExtraMinutes({
    used: settledPhoneMinutes(rows),
    included: includedPhoneMinutes(account),
    enabled: before.enabled,
    limitCents: before.limitCents,
    owed: account.phone_extra_owed_minutes ?? 0,
  });
  await env.DB.prepare("update cloud_accounts set phone_extra_owed_minutes = max(phone_extra_owed_minutes, ?), updated_at = ? where user_id = ? and phone_extra_period_start = ?")
    .bind(owed, now, userId, account.period_start).run();
}

/** Stripe takes meter events up to 35 days old; an older one is dated a day inside that. */
const METER_OLDEST_MS = 34 * 24 * 60 * 60_000;

/**
 * One meter report: the minutes past what was sent, identified by where it
 * starts, dated inside the period they were used in (`usedBefore`, its end),
 * so a report that goes out after the period ended still lands on that
 * period's invoice while Stripe holds it open. Only the customer is needed:
 * a subscription that ended has its id cleared, and its last period is still
 * billed. Answers false when it must be tried again.
 */
async function sendPhoneMinutes(env: CloudEnv, account: AccountRow, eventName: string, periodStart: number, from: number, to: number, now: number, usedBefore: number): Promise<boolean> {
  if (to <= from) return true;
  const at = Math.max(now - METER_OLDEST_MS, Math.min(now, usedBefore - 1000));
  try {
    await stripeRequest(env, "POST", "/billing/meter_events", {
      event_name: eventName,
      // The customer, not the subscription: it stays when a plan ends, so a retry after a cancellation is still the same report.
      identifier: `ade-phone:${account.stripe_customer_id}:${periodStart}:from-${from}`,
      timestamp: String(Math.floor(at / 1000)),
      "payload[stripe_customer_id]": account.stripe_customer_id as string,
      "payload[value]": String(to - from),
    });
    return true;
  } catch (error) {
    if (isDuplicateReport(error)) return true;
    reportCloudFailure("cloud.phone_meter_report_failed", { userId: account.user_id, status: error instanceof StripeRequestError ? error.status : null });
    return false;
  }
}

/**
 * The period the account still tracks has ended: its settled extra minutes go
 * to the meter, then tracking moves to the current period. Waits while one of
 * its phones still runs (the checks stop it). A plan that is no longer paid
 * has its switch turned off once the old period is billed.
 */
async function settleEndedPeriod(env: CloudEnv, account: AccountRow, now: number): Promise<void> {
  const tracked = account.phone_extra_period_start;
  if (tracked == null || tracked >= account.period_start) return;
  // past_due starts a free period that ends when the payment comes back (the same period may return): left alone until then.
  if (account.stripe_status === "past_due") return;
  const rows = await periodPhones(env, account.user_id, tracked, account.period_start);
  if (rows.some((row) => row.state === "live")) return;
  const reported = account.phone_extra_reported_minutes ?? 0;
  const eventName = env.STRIPE_PHONE_METER_EVENT?.trim();
  // The customer stays when a subscription ends (only its id is cleared), so a cancelled plan's last period is billed too.
  if (eventName && account.stripe_customer_id) {
    const included = Math.max(account.phone_extra_included ?? 0, CLOUD_PLANS[boughtPlanIdOf(account)].phoneMinutes);
    const billable = billableExtraMinutes({
      used: settledPhoneMinutes(rows),
      included,
      // On, or on until the plan ended (2): either way the old period used them.
      enabled: account.phone_extra_enabled === PHONE_EXTRA.on || account.phone_extra_enabled === PHONE_EXTRA.wasOn,
      limitCents: account.phone_extra_limit_cents ?? null,
      owed: account.phone_extra_owed_minutes ?? 0,
    });
    // The tracked period ended where the current one starts.
    if (!(await sendPhoneMinutes(env, account, eventName, tracked, reported, billable, now, account.period_start))) return;
  }
  // Compare first: a report or a choice that moved the row meanwhile wins, and this is done next tick.
  await env.DB.prepare(`
    update cloud_accounts set phone_extra_period_start = ?, phone_extra_reported_minutes = 0, phone_extra_owed_minutes = 0,
      phone_extra_included = ?, phone_extra_enabled = ?, updated_at = ?
    where user_id = ? and phone_extra_period_start = ? and phone_extra_reported_minutes = ?
  `).bind(
    account.period_start,
    includedPhoneMinutes(account),
    accountRules(account) === "paid" && account.phone_extra_enabled === PHONE_EXTRA.on ? PHONE_EXTRA.on : PHONE_EXTRA.off,
    now,
    account.user_id,
    tracked,
    reported,
  ).run();
  logCloud("cloud.extra_phone_period_settled", { userId: account.user_id });
}

/**
 * Every ten minutes (`cron.ts`): each account with extra minutes on, owed, or
 * an ended period still tracked. An ended period is billed first
 * (`settleEndedPeriod`); the current one sends the settled minutes not sent
 * yet. The row is compared before it is saved: a renewal that reset the
 * period meanwhile wins.
 */
export async function reportExtraPhoneMinutes(env: CloudEnv, now = Date.now()): Promise<void> {
  const eventName = env.STRIPE_PHONE_METER_EVENT?.trim();
  if (!eventName || !env.STRIPE_SECRET_KEY?.trim()) return;
  const rows = await env.DB.prepare(`
    select * from cloud_accounts
    where (phone_extra_enabled = ${PHONE_EXTRA.on} or phone_extra_owed_minutes > 0 or phone_extra_period_start < period_start)
      and coalesce(stripe_status, '') <> 'past_due'
  `).all<AccountRow>();
  for (const account of rows.results ?? []) {
    try {
      // An ended period is billed to the customer (a cancelled plan's too), then closed.
      if (tracksEndedPeriod(account)) {
        await settleEndedPeriod(env, account, now);
        continue;
      }
      if (accountRules(account) !== "paid" || !account.stripe_customer_id || !account.stripe_subscription_id) continue;
      if (account.phone_extra_period_start != null && account.phone_extra_period_start > account.period_start) {
        // Tracking ahead of the period (a period that came back): no report and no reset, so nothing sent repeats.
        reportCloudFailure("cloud.phone_meter_period_ahead", { userId: account.user_id });
        continue;
      }
      const samePeriod = account.phone_extra_period_start === account.period_start;
      const reported = samePeriod ? account.phone_extra_reported_minutes ?? 0 : 0;
      const billable = await billableThisPeriod(env, account, now);
      const included = includedPhoneMinutes(account);
      if (billable > reported) {
        const periodEnd = account.period_end > account.period_start ? account.period_end : now + 1000;
        if (!(await sendPhoneMinutes(env, account, eventName, account.period_start, reported, billable, now, periodEnd))) continue;
        await env.DB.prepare(`
          update cloud_accounts set phone_extra_reported_minutes = ?, phone_extra_period_start = ?,
            phone_extra_owed_minutes = case when phone_extra_period_start is ? then phone_extra_owed_minutes else 0 end,
            phone_extra_included = ?, updated_at = ?
          where user_id = ? and period_start = ? and phone_extra_period_start is ? and phone_extra_reported_minutes = ?
        `).bind(
          billable,
          account.period_start,
          account.period_start,
          included,
          now,
          account.user_id,
          account.period_start,
          account.phone_extra_period_start ?? null,
          account.phone_extra_reported_minutes ?? 0,
        ).run();
      } else if (account.phone_extra_included !== included || !samePeriod) {
        // The plan's minutes this period, kept fresh (an upgrade raises them) for the bill after it ends.
        await env.DB.prepare(`
          update cloud_accounts set phone_extra_included = ?, phone_extra_period_start = ?,
            phone_extra_reported_minutes = ?,
            phone_extra_owed_minutes = case when phone_extra_period_start is ? then phone_extra_owed_minutes else 0 end,
            updated_at = ?
          where user_id = ? and phone_extra_period_start is ?
        `).bind(
          included,
          account.period_start,
          reported,
          account.period_start,
          now,
          account.user_id,
          account.phone_extra_period_start ?? null,
        ).run();
      }
    } catch (error) {
      reportCloudFailure("cloud.phone_meter_account_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
}
