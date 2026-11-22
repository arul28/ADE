import { pruneSignupIps, signupBurstAlarms, sustainedCpuAlarms } from "./abuseSignals";
import { captureCloudSafety, type CloudSafetyStep, type CloudWaitUntil } from "./analytics";
import { blockCommand, sendOwnerAlert } from "./blocks";
import type { CloudPlanId } from "./contract";
import { sendCloudEmail } from "./email";
import { idleCleanupReportLine } from "./idleCleanup";
import { pruneSponsored, sponsoredReportLines } from "./gravity";
import {
  CLOUD_PLANS,
  DISK_COST_MICROS_PER_GB_DAY,
  computeCostMicrosFor,
  cloudSizeForTier,
  extraHoursIncomeMicros,
  utcDay,
} from "./plans";
import {
  PAID_RULES_SQL,
  accountDiskSql,
  accountRules,
  logCloud,
  planIdOf,
  readSetting,
  reportCloudFailure,
  writeSetting,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * What ADE Cloud costs the owner against what it brings in
 * (`docs/plans/ade-cloud-plans-and-disk.md`, "Cost protection for the owner").
 *
 * Cost is the provider's public price for the awake time of each computer-day
 * (`cloud_computer_days.cost_micros`) plus each day's peak disk
 * (`cloud_disk_days`). Income is the plan's price spread over the month and
 * the extra hours reported to Stripe (no extra disk is sold since Pricing v2).
 * Both are estimates:
 * Stripe's fees and taxes are not in them, and a day the provider's meter has
 * not reported yet is corrected by the reconcile a day or two later.
 *
 * The owner's cap (`cloud_settings.owner_cost_limit_usd`) limits free use
 * only: it is compared with this calendar month's estimated cost of accounts
 * on free-plan rules (each stretch is stamped with the plan it ran on,
 * `cloud_computer_days.free_cost_micros` and `cloud_disk_days.free`). At it,
 * free accounts get no new computer and no disk growth; paid accounts are
 * never refused, and wakes of existing computers always work. The owner is
 * emailed at 50%, 80% and 100% of it, once each a month. Unset: nothing is
 * enforced.
 *
 * Separately, the owner gets one email each time the estimate of all use
 * passes another `OWNER_COST_STEP_USD` in the calendar month (`alertCostStep`).
 */

export const OWNER_LIMIT_KEY = "owner_cost_limit_usd";
const COST_MTD_KEY = "cost_mtd_micros";
/** This month's estimated cost of free use only: what the cap is compared with. */
const FREE_COST_MTD_KEY = "free_cost_mtd_micros";
/** Shares of the cap at which the owner is emailed, once each a month and cap, with each one's analytics step. */
const FREE_CAP_ALERT_STEPS = { 50: "free_cap_50", 80: "free_cap_80", 100: "free_cap_100" } as const satisfies Record<number, CloudSafetyStep>;
const FREE_CAP_ALERT_PERCENTS = [50, 80, 100] as const satisfies ReadonlyArray<keyof typeof FREE_CAP_ALERT_STEPS>;
const FREE_CAP_TOP_ACCOUNTS = 5;
/** An owner email each time this month's estimate passes another step of this many dollars. */
export const OWNER_COST_STEP_USD = 50;
/** The last step alerted, with its month: `2026-11:150`. */
const OWNER_COST_STEP_KEY = "owner_cost_step_alert";
const STEP_ALERT_TOP_ACCOUNTS = 3;
/** A free account costing more than this in a month is worth a look. */
const FREE_ACCOUNT_ALARM_MICROS = 3_000_000;
/** Small's disk maximum. */
const SMALL_DISK_MAX_GB = cloudSizeForTier("small")!.diskMaxGb;
/** A free account holding more disk than its computers at Small's maximum is listed (owner only). */
const FREE_DISK_ALARM_GB = CLOUD_PLANS.free.computerLimit * SMALL_DISK_MAX_GB;
/** A day whose cost passes this many times the 7-day mean, and this floor, is a jump. */
const DAY_JUMP_FACTOR = 2;
const DAY_JUMP_FLOOR_MICROS = 5_000_000;
const WORST_ACCOUNTS = 10;

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

function monthStartDay(now: number): string {
  const date = new Date(now);
  return utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function daysInMonthOf(day: string): number {
  const date = new Date(`${day}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * The accounts that cost the most this month so far (awake time plus peak
 * disk): all accounts, or only use on free-plan rules. Best effort: a failed
 * read is reported and answers none, so the email it feeds still goes.
 */
async function topAccountsThisMonth(env: CloudEnv, monthStart: string, limit: number, use: "all" | "free"): Promise<Array<{ user_id: string; cost: number }>> {
  // The ADE Cloud iPhone's NoMac cost counts as in the month's estimate (`refreshCostEstimate`).
  const sql = use === "free"
    ? `select user_id, free_cost_micros as cost from cloud_computer_days where day >= ? and free_cost_micros > 0
      union all select user_id, peak_gb * ? as cost from cloud_disk_days where day >= ? and free = 1
      union all select user_id, cost_micros as cost from cloud_phones where created_at >= ? and free = 1`
    : `select user_id, cost_micros as cost from cloud_computer_days where day >= ?
      union all select user_id, peak_gb * ? as cost from cloud_disk_days where day >= ?
      union all select user_id, cost_micros as cost from cloud_phones where created_at >= ?`;
  try {
    const rows = await env.DB.prepare(`select user_id, sum(cost) as cost from (${sql}) group by user_id order by cost desc limit ?`)
      .bind(monthStart, DISK_COST_MICROS_PER_GB_DAY, monthStart, Date.parse(`${monthStart}T00:00:00Z`), limit).all<{ user_id: string; cost: number }>();
    return rows.results ?? [];
  } catch (error) {
    reportCloudFailure(use === "free" ? "cloud.free_cap_top_accounts_failed" : "cloud.owner_cost_top_accounts_failed", { message: error instanceof Error ? error.name : "unknown" });
    return [];
  }
}

function readLimitUsd(value: string | null): number | null {
  if (value == null) return null;
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** The owner's cap, this month's estimated cost (all, and free use only), and whether free use reached the cap; one read. */
export async function ownerLimitState(env: CloudEnv): Promise<{ limitUsd: number | null; costMtdMicros: number; freeCostMtdMicros: number; reached: boolean }> {
  const rows = await env.DB.prepare("select key, value from cloud_settings where key in (?, ?, ?)")
    .bind(OWNER_LIMIT_KEY, COST_MTD_KEY, FREE_COST_MTD_KEY).all<{ key: string; value: string }>();
  const values = new Map((rows.results ?? []).map((row) => [row.key, row.value]));
  const limitUsd = readLimitUsd(values.get(OWNER_LIMIT_KEY) ?? null);
  const costMtdMicros = Number(values.get(COST_MTD_KEY) ?? 0) || 0;
  const freeCostMtdMicros = Number(values.get(FREE_COST_MTD_KEY) ?? 0) || 0;
  return { limitUsd, costMtdMicros, freeCostMtdMicros, reached: limitUsd != null && freeCostMtdMicros >= limitUsd * 1_000_000 };
}

/**
 * Whether the cap refuses this account a new computer or a disk grow: only an
 * account on free-plan rules, only once this month's free use reached the cap.
 * A paid account is never refused (and costs no read).
 */
export async function freeCapRefuses(env: CloudEnv, account: Pick<AccountRow, "user_id" | "plan" | "stripe_status">, now: number, waitUntil?: CloudWaitUntil): Promise<boolean> {
  if (accountRules(account) !== "free") return false;
  const state = await ownerLimitState(env);
  if (!state.reached) return false;
  logCloud("cloud.free_cap_refused", { userId: account.user_id, limitUsd: state.limitUsd, freeCostMtdMicros: state.freeCostMtdMicros });
  captureCloudSafety(env, waitUntil, account.user_id, "free_cap_refused", "free_cap", now);
  return true;
}

/**
 * This month's estimated cost so far, all and free use only, kept in
 * `cloud_settings` for the cap check: the settled computer-days, the
 * disk-days, and the stretches running now. D1 only, from the ten-minute
 * owner check. Emails the owner as free use passes 50%, 80% and 100% of the cap.
 */
export async function refreshCostEstimate(env: CloudEnv, awake: ComputerRow[], now: number): Promise<void> {
  const monthStart = monthStartDay(now);
  const monthStartMs = Date.parse(`${monthStart}T00:00:00Z`);
  const row = await env.DB.prepare(`
    select (select coalesce(sum(cost_micros), 0) from cloud_computer_days where day >= ?) as compute,
      (select coalesce(sum(free_cost_micros), 0) from cloud_computer_days where day >= ?) as free_compute,
      (select coalesce(sum(peak_gb), 0) from cloud_disk_days where day >= ?) as gb_days,
      (select coalesce(sum(peak_gb), 0) from cloud_disk_days where day >= ? and free = 1) as free_gb_days,
      (select coalesce(sum(cost_micros), 0) from cloud_phones where created_at >= ?) as phones,
      (select coalesce(sum(cost_micros), 0) from cloud_phones where created_at >= ? and free = 1) as free_phones
  `).bind(monthStart, monthStart, monthStart, monthStart, monthStartMs, monthStartMs).first<{ compute: number; free_compute: number; gb_days: number; free_gb_days: number; phones: number; free_phones: number }>();
  // The ADE Cloud iPhone's NoMac cost counts too, and free-plan phones toward the free-use cap.
  let micros = (row?.compute ?? 0) + (row?.gb_days ?? 0) * DISK_COST_MICROS_PER_GB_DAY + (row?.phones ?? 0);
  let freeMicros = (row?.free_compute ?? 0) + (row?.free_gb_days ?? 0) * DISK_COST_MICROS_PER_GB_DAY + (row?.free_phones ?? 0);
  // The stretches running now count as free unless their account is on paid rules now.
  const running = awake.filter((computer) => computer.awake_since != null && computer.awake_since <= now);
  const paid = running.length
    ? new Set(((await env.DB.prepare(`select user_id from cloud_accounts where user_id in (select value from json_each(?)) and ${PAID_RULES_SQL}`)
      .bind(JSON.stringify([...new Set(running.map((computer) => computer.user_id))])).all<{ user_id: string }>()).results ?? []).map((entry) => entry.user_id))
    : new Set<string>();
  for (const computer of running) {
    const cost = computeCostMicrosFor(now - Math.max(computer.awake_since!, monthStartMs), { type: computer.type, cpu: computer.cpu, memoryGb: computer.memory_gb });
    micros += cost;
    if (!paid.has(computer.user_id)) freeMicros += cost;
  }
  await writeSetting(env, COST_MTD_KEY, String(Math.round(micros)), now);
  await writeSetting(env, FREE_COST_MTD_KEY, String(Math.round(freeMicros)), now);

  const limitUsd = readLimitUsd(await readSetting(env, OWNER_LIMIT_KEY));
  await alertCostStep(env, micros, limitUsd, now);
  if (limitUsd == null) return;
  const percent = (freeMicros / (limitUsd * 1_000_000)) * 100;
  const reached = FREE_CAP_ALERT_PERCENTS.filter((step) => percent >= step);
  if (reached.length === 0) return;
  logCloud("cloud.free_cap_step", { limitUsd, freeCostMtdMicros: Math.round(freeMicros), percent: Math.round(percent) });
  const month = monthStart.slice(0, 7);
  // The free accounts that cost the most this month, each with its block command. Best effort.
  const top = await topAccountsThisMonth(env, monthStart, FREE_CAP_TOP_ACCOUNTS, "free");
  const topLines = top.flatMap((entry) => [`${entry.user_id}: ${usd(entry.cost)}`, `  Block it: ${blockCommand(env, entry.user_id, "free_cap")}`]);
  for (const step of reached) {
    await sendOwnerAlert(env, {
      // The cap is in the key: a raised cap alerts again at its own steps.
      key: `free_cap:${month}:${limitUsd}:${step}`,
      kind: "free_cap",
      userId: null,
      subject: step >= 100 ? `ADE Cloud free use reached your $${limitUsd} cap` : `ADE Cloud free use passed ${step}% of your cap`,
      reason: step >= 100
        ? `Free use this month is ${usd(freeMicros)}, at your cap of $${limitUsd}. Free accounts get no new computers or disk growth until next month or until you raise it. Paid accounts and wakes are not affected.`
        : `Free use this month is ${usd(freeMicros)}, ${Math.round(percent)}% of your $${limitUsd} cap. At the cap, free accounts get no new computers or disk growth; paid accounts never are refused.`,
      counts: { "Free use this month": usd(freeMicros), "All use this month": usd(micros), Cap: `$${limitUsd}`, "Raise it": `update cloud_settings set value = '<dollars>' where key = '${OWNER_LIMIT_KEY}'` },
      more: topLines.length ? ["Free accounts that cost the most this month:", ...topLines] : undefined,
      step: FREE_CAP_ALERT_STEPS[step],
    }, now);
  }
}

/**
 * One owner email when this month's estimate passes a step of
 * `OWNER_COST_STEP_USD` higher than the last one alerted this month (a jump
 * over several sends one, for the highest). It counts all use: the cap counts
 * free use only and has its own alerts, so passing the cap in all use stops
 * nothing here. The check that moves the stored step from what it read sends;
 * an overlapping check finds it moved and sends nothing. A send that fails
 * gives the step back, so the next check (ten minutes on) tries again.
 */
async function alertCostStep(env: CloudEnv, micros: number, limitUsd: number | null, now: number): Promise<void> {
  const step = Math.floor(micros / (OWNER_COST_STEP_USD * 1_000_000)) * OWNER_COST_STEP_USD;
  if (step < OWNER_COST_STEP_USD) return;
  const month = monthStartDay(now).slice(0, 7);
  const stored = await readSetting(env, OWNER_COST_STEP_KEY);
  const [storedMonth, storedStep] = stored?.split(":") ?? [];
  if (step <= (storedMonth === month ? Number(storedStep) || 0 : 0)) return;
  const claimed = `${month}:${step}`;
  const claim = stored == null
    ? await env.DB.prepare("insert into cloud_settings (key, value, updated_at) values (?, ?, ?) on conflict (key) do nothing").bind(OWNER_COST_STEP_KEY, claimed, now).run()
    : await env.DB.prepare("update cloud_settings set value = ?, updated_at = ? where key = ? and value = ?").bind(claimed, now, OWNER_COST_STEP_KEY, stored).run();
  if (claim.meta.changes !== 1) return;
  logCloud("cloud.owner_cost_step", { stepUsd: step, costMtdMicros: Math.round(micros), limitUsd });

  const monthStart = monthStartDay(now);
  // The daily report's cost per account (awake time plus peak disk), summed over the month so far.
  // Best effort: the step is claimed now, so a failed read must not stop its email.
  const top = await topAccountsThisMonth(env, monthStart, STEP_ALERT_TOP_ACCOUNTS, "all");
  const limitLine = limitUsd == null
    ? "No free-use cap is set."
    : `Your free-use cap is $${limitUsd}; it counts free use only and has its own alerts.`;
  const topLines = top.map((row) => `${row.user_id}: ${usd(row.cost)}`);
  const result = await sendCloudEmail(env, {
    owner: true,
    subject: `ADE Cloud passed $${step} this month`,
    text: [
      `This month's estimated cost passed $${step}. It is ${usd(micros)} now.`,
      limitLine,
      ...(topLines.length ? ["The accounts that cost the most this month:", ...topLines] : []),
    ].join("\n"),
  });
  if (result !== "failed") return;
  // Given back only if no later check moved it on.
  const giveBack = stored == null
    ? env.DB.prepare("delete from cloud_settings where key = ? and value = ?").bind(OWNER_COST_STEP_KEY, claimed)
    : env.DB.prepare("update cloud_settings set value = ? where key = ? and value = ?").bind(stored, OWNER_COST_STEP_KEY, claimed);
  await giveBack.run();
}

/**
 * The daily report's safety lines for `day`: new sign-ups, cloud hours used,
 * blocks, abuse events and owner alerts sent. `active` when anything
 * happened, so a quiet day with sign-ups still sends the report.
 */
async function safetyReportLines(env: CloudEnv, day: string, dayStart: number): Promise<{ lines: string[]; active: boolean }> {
  const dayEnd = dayStart + 86_400_000;
  const row = await env.DB.prepare(`
    select
      (select count(*) from cloud_signup_ips where signed_up_at >= ? and signed_up_at < ?) as signups,
      (select coalesce(sum(metered_milli), 0) from cloud_computer_days where day = ?) as metered_milli,
      (select count(distinct user_id) from cloud_computer_days where day = ? and metered_milli > 0) as active_accounts,
      (select count(*) from cloud_blocks where created_at >= ? and created_at < ?) as blocks_today,
      (select count(distinct user_id) from cloud_blocks where user_id is not null) as blocked_accounts,
      (select count(*) from cloud_abuse_events where created_at >= ? and created_at < ?) as abuse_events,
      (select count(*) from cloud_owner_alerts where sent_at >= ? and sent_at < ?) as alerts_sent
  `).bind(dayStart, dayEnd, day, day, dayStart, dayEnd, dayStart, dayEnd, dayStart, dayEnd).first<{
    signups: number; metered_milli: number; active_accounts: number; blocks_today: number; blocked_accounts: number; abuse_events: number; alerts_sent: number;
  }>();
  if (!row) return { lines: [], active: false };
  const hours = Math.round(row.metered_milli / 100) / 10;
  return {
    lines: [
      `Sign-ups: ${row.signups} (counted from sign-ups with a recorded address).`,
      `Cloud hours used: ${hours} across ${row.active_accounts} account${row.active_accounts === 1 ? "" : "s"}.`,
      `Blocks: ${row.blocks_today} new, ${row.blocked_accounts} account${row.blocked_accounts === 1 ? "" : "s"} blocked in all. Abuse events: ${row.abuse_events}. Owner alerts sent: ${row.alerts_sent}.`,
    ],
    active: row.signups > 0 || row.blocks_today > 0 || row.abuse_events > 0 || row.alerts_sent > 0,
  };
}

type DayAccount = {
  userId: string;
  planId: CloudPlanId;
  costMicros: number;
  incomeMicros: number;
  extraReportedMilli: number;
  periodStart: number | null;
};

/**
 * The owner's daily report for `day` (a finished UTC day): one row per
 * account in `cloud_account_days`, then one email with the totals, the
 * margin, the worst accounts and the alarms. Runs after the reconcile, which
 * corrects that day.
 */
export async function runDailyCostReport(env: CloudEnv, day: string): Promise<void> {
  const previousDay = utcDay(Date.parse(`${day}T00:00:00Z`) - 86_400_000);
  const [computeRows, diskRows, accountRows, previousRows] = await Promise.all([
    env.DB.prepare("select user_id, coalesce(sum(cost_micros), 0) as cost from cloud_computer_days where day = ? group by user_id")
      .bind(day).all<{ user_id: string; cost: number }>(),
    env.DB.prepare("select user_id, peak_gb from cloud_disk_days where day = ?")
      .bind(day).all<{ user_id: string; peak_gb: number }>(),
    env.DB.prepare(`
      select * from cloud_accounts where deleted_at is null and (plan = 'paid'
        or user_id in (select user_id from cloud_computer_days where day = ?)
        or user_id in (select user_id from cloud_disk_days where day = ?))
    `).bind(day, day).all<AccountRow>(),
    env.DB.prepare("select user_id, extra_reported_milli, period_start from cloud_account_days where day = ?")
      .bind(previousDay).all<{ user_id: string; extra_reported_milli: number; period_start: number | null }>(),
  ]);
  // Unusual disk on the free plan: no account-wide disk limits it since Pricing v2
  // (each size has its own maximum), and disk bills asleep too. Owner-only.
  const bigFreeDiskRows = await env.DB.prepare(`
    select * from (
      select a.*, ${accountDiskSql("a.user_id")} as disk_gb
      from cloud_accounts a where a.deleted_at is null and not ${PAID_RULES_SQL}
    ) where disk_gb > ?
  `).bind(FREE_DISK_ALARM_GB).all<AccountRow & { disk_gb: number }>();
  const compute = new Map((computeRows.results ?? []).map((row) => [row.user_id, row.cost]));
  const disk = new Map((diskRows.results ?? []).map((row) => [row.user_id, row]));
  const previous = new Map((previousRows.results ?? []).map((row) => [row.user_id, row]));
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const monthDays = daysInMonthOf(day);

  const rows: DayAccount[] = [];
  for (const account of accountRows.results ?? []) {
    const planId = planIdOf(account);
    const paying = planId !== "free";
    const diskRow = disk.get(account.user_id);
    const cost = (compute.get(account.user_id) ?? 0) + (diskRow?.peak_gb ?? 0) * DISK_COST_MICROS_PER_GB_DAY;
    let income = paying ? Math.round((CLOUD_PLANS[planId].priceUsd * 1_000_000) / monthDays) : 0;
    // Extra hours: what was reported since yesterday's row in the same period.
    // With no row yesterday, the baseline is unknown, so the day counts none.
    const before = previous.get(account.user_id);
    // At the plan's own price (a subscription bought before Cloud 7 pays the first price until its renewal: close enough here).
    if (planId !== "free" && before && before.period_start === account.period_start) {
      income += extraHoursIncomeMicros(planId, before.extra_reported_milli, account.extra_reported_milli);
    } else if (planId !== "free" && !before && account.period_start >= dayStart) {
      income += extraHoursIncomeMicros(planId, 0, account.extra_reported_milli);
    }
    rows.push({ userId: account.user_id, planId, costMicros: cost, incomeMicros: income, extraReportedMilli: account.extra_reported_milli, periodStart: account.period_start });
  }
  if (rows.length) {
    await env.DB.batch(rows.map((row) => env.DB.prepare(`
      insert into cloud_account_days (user_id, day, plan_id, cost_micros, income_micros, extra_reported_milli, period_start)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict (user_id, day) do update set plan_id = excluded.plan_id, cost_micros = excluded.cost_micros,
        income_micros = excluded.income_micros, extra_reported_milli = excluded.extra_reported_milli, period_start = excluded.period_start
    `).bind(row.userId, day, row.planId, row.costMicros, row.incomeMicros, row.extraReportedMilli, row.periodStart)));
  }

  const monthStart = monthStartDay(dayStart);
  const weekStart = utcDay(dayStart - 7 * 86_400_000);
  const [monthRows, weekRows, owner] = await Promise.all([
    env.DB.prepare(`
      select user_id, max(plan_id) as plan_id, sum(cost_micros) as cost, sum(income_micros) as income
      from cloud_account_days where day >= ? and day <= ? group by user_id
    `).bind(monthStart, day).all<{ user_id: string; plan_id: string; cost: number; income: number }>(),
    env.DB.prepare("select day, sum(cost_micros) as cost from cloud_account_days where day >= ? and day < ? group by day")
      .bind(weekStart, day).all<{ day: string; cost: number }>(),
    ownerLimitState(env),
  ]);

  const dayCost = rows.reduce((sum, row) => sum + row.costMicros, 0);
  const dayIncome = rows.reduce((sum, row) => sum + row.incomeMicros, 0);
  const month = monthRows.results ?? [];
  const monthCost = month.reduce((sum, row) => sum + row.cost, 0);
  const monthIncome = month.reduce((sum, row) => sum + row.income, 0);

  const alarms: string[] = [];
  for (const row of month) {
    if (row.plan_id !== "free" && row.cost > row.income) {
      alarms.push(`Account ${row.user_id} (${row.plan_id}) costs more than it pays this month: ${usd(row.cost)} against ${usd(row.income)}.`);
    } else if (row.plan_id === "free" && row.cost > FREE_ACCOUNT_ALARM_MICROS) {
      alarms.push(`Free account ${row.user_id} cost ${usd(row.cost)} this month.`);
    }
  }
  const week = weekRows.results ?? [];
  const weekMean = week.length ? week.reduce((sum, row) => sum + row.cost, 0) / week.length : 0;
  if (week.length && dayCost > DAY_JUMP_FLOOR_MICROS && dayCost > weekMean * DAY_JUMP_FACTOR) {
    alarms.push(`${day} cost ${usd(dayCost)}, over ${DAY_JUMP_FACTOR}x the 7-day mean of ${usd(weekMean)}.`);
  }
  for (const row of bigFreeDiskRows.results ?? []) {
    alarms.push(`Free account ${row.user_id} holds ${row.disk_gb} GB of disk, more than its ${CLOUD_PLANS.free.computerLimit} computers would at Small's ${SMALL_DISK_MAX_GB} GB each (${FREE_DISK_ALARM_GB} GB), about ${usd(row.disk_gb * DISK_COST_MICROS_PER_GB_DAY * 30)} a month asleep. Nothing limits it but each size's own disk and the idle cleanup.`);
  }
  // Abuse signals (`abuseSignals.ts`): best effort, a failed read never costs the report its email.
  const abuse = async (kind: string, read: () => Promise<string[]>): Promise<string[]> => read().catch((error: unknown) => {
    reportCloudFailure("cloud.abuse_signal_read_failed", { kind, message: error instanceof Error ? error.message : "unknown" });
    return [];
  });
  alarms.push(...await abuse("cpu", () => sustainedCpuAlarms(env, day)), ...await abuse("signups", () => signupBurstAlarms(env, day)));
  await pruneSignupIps(env, dayStart + 86_400_000).catch((error: unknown) => {
    reportCloudFailure("cloud.signup_ip_prune_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
  if (owner.limitUsd == null) logCloud("cloud.owner_limit_unset", { costMtdMicros: owner.costMtdMicros });
  // A line that can't be read never costs the report.
  const idleLine = await idleCleanupReportLine(env, day).catch((error: unknown) => {
    reportCloudFailure("cloud.idle_cleanup_report_failed", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  });
  // The safety lines (README, "ADE Cloud safety"): best effort, a failed read never costs the report.
  const safety = await safetyReportLines(env, day, dayStart).catch((error: unknown) => {
    reportCloudFailure("cloud.safety_report_failed", { message: error instanceof Error ? error.message : "unknown" });
    return { lines: [] as string[], active: false };
  });
  // Sponsored cards and the Index (`gravity.ts`): ADE's counts and what Gravity paid, against free use. Best effort.
  // The day's free use as it was counted then, so an account that changed plan since counts on the right side.
  const freeDay = await env.DB.prepare(`
    select (select coalesce(sum(free_cost_micros), 0) from cloud_computer_days where day = ?) as compute,
      (select coalesce(sum(peak_gb), 0) from cloud_disk_days where day = ? and free = 1) as gb_days
  `).bind(day, day).first<{ compute: number; gb_days: number }>();
  const freeDayCost = (freeDay?.compute ?? 0) + (freeDay?.gb_days ?? 0) * DISK_COST_MICROS_PER_GB_DAY;
  await pruneSponsored(env, dayStart + 86_400_000).catch((error: unknown) => {
    reportCloudFailure("cloud.sponsored_prune_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
  const sponsored = await sponsoredReportLines(env, day, freeDayCost).catch((error: unknown) => {
    reportCloudFailure("cloud.sponsored_report_failed", { message: error instanceof Error ? error.message : "unknown" });
    return [] as string[];
  });
  logCloud("cloud.daily_cost_report", { day, accounts: rows.length, dayCostMicros: dayCost, dayIncomeMicros: dayIncome, alarms: alarms.length });
  if (rows.length === 0 && alarms.length === 0 && !safety.active && sponsored.length === 0) return;

  const worst = [...rows].sort((a, b) => (b.costMicros - b.incomeMicros) - (a.costMicros - a.incomeMicros)).slice(0, WORST_ACCOUNTS);
  const margin = (cost: number, income: number) => income > 0 ? `${Math.round(((income - cost) / income) * 100)}%` : "none";
  const lines = [
    `${day}: cost ${usd(dayCost)}, income ${usd(dayIncome)}, margin ${margin(dayCost, dayIncome)}, ${rows.length} accounts.`,
    `This month so far: cost ${usd(monthCost)}, income ${usd(monthIncome)}, margin ${margin(monthCost, monthIncome)}.`,
    `Estimated cost this month: ${usd(owner.costMtdMicros)}, of which free use ${usd(owner.freeCostMtdMicros)} and paid use ${usd(Math.max(0, owner.costMtdMicros - owner.freeCostMtdMicros))}.`,
    owner.limitUsd == null
      ? "Free-use cap: not set, so nothing is refused."
      : `Free-use cap: $${owner.limitUsd}, ${Math.round((owner.freeCostMtdMicros / (owner.limitUsd * 1_000_000)) * 100)}% used${owner.reached ? " (reached: free accounts get no new computers or disk growth; paid accounts are not affected)" : ""}.`,
    ...(idleLine ? [idleLine] : []),
    ...safety.lines,
    ...sponsored,
    "",
    alarms.length ? "Alarms:" : "No alarms.",
    ...alarms,
    "",
    "Accounts that cost the most against what they pay (day):",
    ...worst.map((row) => `${row.userId} (${row.planId}): cost ${usd(row.costMicros)}, income ${usd(row.incomeMicros)}`),
    "",
    "Estimates at public prices, before Stripe's fees and taxes.",
  ];
  await sendCloudEmail(env, {
    owner: true,
    subject: alarms.length ? `ADE Cloud daily report: ${alarms.length} alarm${alarms.length === 1 ? "" : "s"}` : "ADE Cloud daily report",
    text: lines.join("\n"),
  });
}
