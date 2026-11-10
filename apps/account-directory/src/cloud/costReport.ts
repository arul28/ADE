import type { ExtraDiskOverLimit } from "./billing";
import { formatCloudCents, type CloudPlanId } from "./contract";
import { sendCloudEmail } from "./email";
import {
  CLOUD_PLANS,
  DISK_COST_MICROS_PER_GB_DAY,
  EXTRA_DISK_MICROS_PER_GB_DAY,
  computeCostMicrosFor,
  extraHoursIncomeMicros,
  utcDay,
} from "./plans";
import {
  accountDiskSql,
  freePlanOverDisk,
  logCloud,
  planIdOf,
  readSetting,
  readTimeSetting,
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
 * (`cloud_disk_days`). Income is the plan's price spread over the month, the
 * extra hours reported to Stripe and the extra disk billed. Both are estimates:
 * Stripe's fees and taxes are not in them, and a day the provider's meter has
 * not reported yet is corrected by the reconcile a day or two later.
 *
 * The owner's hard limit (`cloud_settings.owner_cost_limit_usd`) is compared
 * with this calendar month's estimated cost. At it, no new computer and no
 * disk growth; wakes of existing computers always work. Unset: nothing is
 * enforced.
 */

export const OWNER_LIMIT_KEY = "owner_cost_limit_usd";
const COST_MTD_KEY = "cost_mtd_micros";
const OWNER_LIMIT_ALERT_KEY = "owner_limit_alert_at";
const OWNER_LIMIT_ALERT_REPEAT_MS = 24 * 60 * 60_000;
/** A free account costing more than this in a month is worth a look. */
const FREE_ACCOUNT_ALARM_MICROS = 3_000_000;
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

function readLimitUsd(value: string | null): number | null {
  if (value == null) return null;
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** The owner's limit and this month's estimated cost; one read. */
export async function ownerLimitState(env: CloudEnv): Promise<{ limitUsd: number | null; costMtdMicros: number; reached: boolean }> {
  const rows = await env.DB.prepare("select key, value from cloud_settings where key in (?, ?)")
    .bind(OWNER_LIMIT_KEY, COST_MTD_KEY).all<{ key: string; value: string }>();
  const values = new Map((rows.results ?? []).map((row) => [row.key, row.value]));
  const limitUsd = readLimitUsd(values.get(OWNER_LIMIT_KEY) ?? null);
  const costMtdMicros = Number(values.get(COST_MTD_KEY) ?? 0) || 0;
  return { limitUsd, costMtdMicros, reached: limitUsd != null && costMtdMicros >= limitUsd * 1_000_000 };
}

/**
 * This month's estimated cost so far, kept in `cloud_settings` for the limit
 * check: the settled computer-days, the disk-days, and the stretches running
 * now. D1 only, from the ten-minute owner check. Emails the owner once a day
 * while the limit is reached.
 */
export async function refreshCostEstimate(env: CloudEnv, awake: ComputerRow[], now: number): Promise<void> {
  const monthStart = monthStartDay(now);
  const monthStartMs = Date.parse(`${monthStart}T00:00:00Z`);
  const row = await env.DB.prepare(`
    select (select coalesce(sum(cost_micros), 0) from cloud_computer_days where day >= ?) as compute,
      (select coalesce(sum(peak_gb), 0) from cloud_disk_days where day >= ?) as gb_days
  `).bind(monthStart, monthStart).first<{ compute: number; gb_days: number }>();
  let micros = (row?.compute ?? 0) + (row?.gb_days ?? 0) * DISK_COST_MICROS_PER_GB_DAY;
  for (const computer of awake) {
    if (computer.awake_since == null || computer.awake_since > now) continue;
    micros += computeCostMicrosFor(now - Math.max(computer.awake_since, monthStartMs), { type: computer.type, cpu: computer.cpu, memoryGb: computer.memory_gb });
  }
  await writeSetting(env, COST_MTD_KEY, String(Math.round(micros)), now);

  const limitUsd = readLimitUsd(await readSetting(env, OWNER_LIMIT_KEY));
  if (limitUsd == null || micros < limitUsd * 1_000_000) return;
  const lastAlert = await readTimeSetting(env, OWNER_LIMIT_ALERT_KEY);
  logCloud("cloud.owner_limit_reached", { limitUsd, costMtdMicros: Math.round(micros) });
  if (now - lastAlert < OWNER_LIMIT_ALERT_REPEAT_MS) return;
  await writeSetting(env, OWNER_LIMIT_ALERT_KEY, String(now), now);
  await sendCloudEmail(env, {
    owner: true,
    subject: "ADE Cloud reached your cost limit",
    text: `This month's estimated cost is ${usd(micros)}, at your limit of $${limitUsd}. New computers and disk growth are refused until you raise it. Wakes still work.\nRaise it: update cloud_settings set value = '<dollars>' where key = '${OWNER_LIMIT_KEY}'.`,
  });
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
 * corrects that day; extra disk is billed from the owner check, so a day
 * still being sent counts its income on a later report.
 * `extraDiskOverLimit` lists accounts whose extra disk, kept a month, passes
 * the limit they set (`checkExtraDiskLimits`).
 */
export async function runDailyCostReport(env: CloudEnv, day: string, extraDiskOverLimit: ExtraDiskOverLimit[] = []): Promise<void> {
  const previousDay = utcDay(Date.parse(`${day}T00:00:00Z`) - 86_400_000);
  const [computeRows, diskRows, accountRows, previousRows] = await Promise.all([
    env.DB.prepare("select user_id, coalesce(sum(cost_micros), 0) as cost from cloud_computer_days where day = ? group by user_id")
      .bind(day).all<{ user_id: string; cost: number }>(),
    env.DB.prepare("select user_id, peak_gb, coalesce(billed_gb, 0) as billed_gb from cloud_disk_days where day = ?")
      .bind(day).all<{ user_id: string; peak_gb: number; billed_gb: number }>(),
    env.DB.prepare(`
      select * from cloud_accounts where deleted_at is null and (plan = 'paid'
        or user_id in (select user_id from cloud_computer_days where day = ?)
        or user_id in (select user_id from cloud_disk_days where day = ?))
    `).bind(day, day).all<AccountRow>(),
    env.DB.prepare("select user_id, extra_reported_milli, period_start from cloud_account_days where day = ?")
      .bind(previousDay).all<{ user_id: string; extra_reported_milli: number; period_start: number | null }>(),
  ]);
  // Disk nobody pays for: the free plan (a cancelled plan included) above its disk,
  // or a paid plan above its disk with extra disk off (a move that left its source).
  const overDiskRows = await env.DB.prepare(`
    select * from (
      select a.*, ${accountDiskSql("a.user_id")} as disk_gb
      from cloud_accounts a where a.deleted_at is null
    ) where disk_gb > ?
  `).bind(CLOUD_PLANS.free.diskGb).all<AccountRow & { disk_gb: number }>();
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
    if (before && before.period_start === account.period_start) {
      income += extraHoursIncomeMicros(before.extra_reported_milli, account.extra_reported_milli);
    } else if (!before && account.period_start >= dayStart) {
      income += extraHoursIncomeMicros(0, account.extra_reported_milli);
    }
    income += (diskRow?.billed_gb ?? 0) * EXTRA_DISK_MICROS_PER_GB_DAY;
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
  for (const row of extraDiskOverLimit) {
    alarms.push(`Account ${row.userId} holds ${row.extraGb} GB of extra disk, about ${formatCloudCents(row.monthCents)} a month, over its ${formatCloudCents(row.limitCents)} limit. Billing stops at the limit; the person was told.`);
  }
  for (const row of overDiskRows.results ?? []) {
    const planId = planIdOf(row);
    if (planId !== "free" && row.extra_disk_state !== "on" && row.disk_gb > CLOUD_PLANS[planId].diskGb) {
      alarms.push(`Account ${row.user_id} holds ${row.disk_gb} GB on the ${planId} plan, over its ${CLOUD_PLANS[planId].diskGb} GB, with extra disk off. A move left its old computer; nothing bills the difference.`);
    }
    if (!freePlanOverDisk(row, row.disk_gb)) continue;
    alarms.push(`Account ${row.user_id} is on the free plan with ${row.disk_gb} GB of disk, over the free ${CLOUD_PLANS.free.diskGb} GB. Its computers stay stopped until it deletes some or buys a plan; unused ones are deleted after 30 days.`);
  }
  if (owner.limitUsd == null) logCloud("cloud.owner_limit_unset", { costMtdMicros: owner.costMtdMicros });
  logCloud("cloud.daily_cost_report", { day, accounts: rows.length, dayCostMicros: dayCost, dayIncomeMicros: dayIncome, alarms: alarms.length });
  if (rows.length === 0 && alarms.length === 0) return;

  const worst = [...rows].sort((a, b) => (b.costMicros - b.incomeMicros) - (a.costMicros - a.incomeMicros)).slice(0, WORST_ACCOUNTS);
  const margin = (cost: number, income: number) => income > 0 ? `${Math.round(((income - cost) / income) * 100)}%` : "none";
  const lines = [
    `${day}: cost ${usd(dayCost)}, income ${usd(dayIncome)}, margin ${margin(dayCost, dayIncome)}, ${rows.length} accounts.`,
    `This month so far: cost ${usd(monthCost)}, income ${usd(monthIncome)}, margin ${margin(monthCost, monthIncome)}.`,
    owner.limitUsd == null
      ? `Cost limit: not set, so nothing is refused. Estimated cost this month: ${usd(owner.costMtdMicros)}.`
      : `Cost limit: $${owner.limitUsd}. Estimated cost this month: ${usd(owner.costMtdMicros)}${owner.reached ? " (reached: new computers and disk growth are refused)" : ""}.`,
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
