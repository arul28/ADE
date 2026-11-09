import type { CallerTokenEnv } from "../callerToken";
import type { CloudAccountState, CloudHoursState } from "./contract";
import type { CloudEmailEnv } from "./email";
import {
  FREE_COMPUTER_LIMIT,
  FREE_INCLUDED_MILLI,
  PAID_COMPUTER_LIMIT,
  PAID_DISK_POOL_GB,
  PAID_INCLUDED_MILLI,
  freePeriodFor,
  hoursMilliFor,
  isMeteredStatus,
  splitByUtcDay,
} from "./plans";

/**
 * The computers and accounts in D1, and the one place that moves hours. Live
 * hours are `used_milli` plus the open stretches in `cloud_computers`, so a
 * tick writes only when something changed.
 */

export type CloudEnv = CallerTokenEnv & CloudEmailEnv & {
  DB: D1Database;
  AGENT37_API_KEY?: string;
  CLOUD_ACCESS_ACCOUNTS?: string;
};

export type ComputerRow = {
  instance_id: string;
  user_id: string;
  request_id: string | null;
  type: string;
  cpu: number;
  memory_gb: number;
  disk_gb: number;
  multiplier_milli: number;
  template_version: string | null;
  machine_key: string | null;
  name: string | null;
  status: string;
  status_changed_at: number;
  awake_since: number | null;
  last_awake_at: number | null;
  created_at: number;
  deleted_at: number | null;
  cold_storage: number;
  free_wake_started_at: number | null;
  free_wake_until: number | null;
  free_wake_used_at: number | null;
  zero_stop_started_at: number | null;
  delete_warned_7d_at: number | null;
  delete_warned_1d_at: number | null;
};

export type AccountRow = {
  user_id: string;
  plan: string;
  included_milli: number;
  used_milli: number;
  period_start: number;
  period_end: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  cancel_at_period_end: number;
  extra_enabled: number;
  extra_reported_milli: number;
  past_due_used_milli: number | null;
  past_due_period_end: number | null;
  warned_80_at: number | null;
  warned_95_at: number | null;
  warned_zero_at: number | null;
  hours_restored_at: number | null;
  created_at: number;
  updated_at: number;
};

export function logCloud(event: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-account-directory", kind: event, ...meta }));
}

const PENDING_PREFIX = "pending:";
export const isPendingId = (id: string): boolean => id.startsWith(PENDING_PREFIX);
export const newPendingId = (): string => `${PENDING_PREFIX}${crypto.randomUUID()}`;

export async function readSetting(env: CloudEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare("select value from cloud_settings where key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function writeSetting(env: CloudEnv, key: string, value: string, now: number): Promise<void> {
  await env.DB.prepare(`
    insert into cloud_settings (key, value, updated_at) values (?, ?, ?)
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, value, now).run();
}

/* ---- Computers ---- */

export async function ownedComputer(env: CloudEnv, userId: string, instanceId: string): Promise<ComputerRow | null> {
  return env.DB.prepare("select * from cloud_computers where instance_id = ? and user_id = ? and deleted_at is null")
    .bind(instanceId, userId).first<ComputerRow>();
}

export async function listComputers(env: CloudEnv, userId: string): Promise<ComputerRow[]> {
  const rows = await env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null")
    .bind(userId).all<ComputerRow>();
  return rows.results ?? [];
}

/** Closes the part of the open stretch up to `upTo` and charges it. Empty when nothing is open. */
export function settleStatements(env: CloudEnv, computer: ComputerRow, upTo: number): D1PreparedStatement[] {
  const start = computer.awake_since;
  if (start == null) return [];
  const statements: D1PreparedStatement[] = [];
  let chargedMilli = 0;
  for (const { day, ms } of splitByUtcDay(start, upTo)) {
    const milli = hoursMilliFor(ms, computer.multiplier_milli);
    chargedMilli += milli;
    statements.push(env.DB.prepare(`
      insert into cloud_computer_days (instance_id, day, user_id, metered_ms, metered_milli, multiplier_milli)
      values (?, ?, ?, ?, ?, ?)
      on conflict (instance_id, day) do update set
        metered_ms = metered_ms + excluded.metered_ms,
        metered_milli = metered_milli + excluded.metered_milli,
        multiplier_milli = excluded.multiplier_milli
    `).bind(computer.instance_id, day, computer.user_id, ms, milli, computer.multiplier_milli));
  }
  if (chargedMilli > 0) {
    statements.push(env.DB.prepare("update cloud_accounts set used_milli = used_milli + ?, updated_at = ? where user_id = ?")
      .bind(chargedMilli, upTo, computer.user_id));
  }
  return statements;
}

/** The free push-work time of a closing stretch, so the daily reconcile doesn't charge it. */
function freeWakeStatements(env: CloudEnv, computer: ComputerRow, closedAt: number): D1PreparedStatement[] {
  if (computer.free_wake_started_at == null || computer.free_wake_until == null) return [];
  const freeEnd = Math.min(closedAt, computer.free_wake_until);
  return splitByUtcDay(computer.free_wake_started_at, freeEnd).map(({ day, ms }) =>
    env.DB.prepare(`
      insert into cloud_computer_days (instance_id, day, user_id, free_ms, multiplier_milli)
      values (?, ?, ?, ?, ?)
      on conflict (instance_id, day) do update set free_ms = free_ms + excluded.free_ms
    `).bind(computer.instance_id, day, computer.user_id, ms, computer.multiplier_milli));
}

function liveMilli(computer: Pick<ComputerRow, "awake_since" | "multiplier_milli">, now: number): number {
  return computer.awake_since == null ? 0 : hoursMilliFor(now - computer.awake_since, computer.multiplier_milli);
}

/** The power action a status change reads as, or null when it is not one. */
function powerAction(previous: string, next: string): "wake" | "sleep" | "stop" | "start" | null {
  if (next === "sleeping") return "sleep";
  if (next === "stopped") return "stop";
  if (isMeteredStatus(next) && !isMeteredStatus(previous)) {
    return previous === "sleeping" || previous === "waking" ? "wake" : "start";
  }
  return null;
}

export function powerLogStatement(env: CloudEnv, computer: Pick<ComputerRow, "instance_id" | "user_id">, action: string, reason: string, now: number): D1PreparedStatement {
  return env.DB.prepare("insert into cloud_power_log (instance_id, user_id, action, reason, created_at) values (?, ?, ?, ?, ?)")
    .bind(computer.instance_id, computer.user_id, action, reason, now);
}

/**
 * The new status for a computer: settles time on change, opens or closes its
 * stretch, logs the power change, and updates `computer` in place so the rest
 * of a tick sees it. Writes nothing when the status didn't change.
 */
export function statusChangeStatements(env: CloudEnv, computer: ComputerRow, status: string, now: number, reason: string): D1PreparedStatement[] {
  if (computer.status === status) return [];
  const statements: D1PreparedStatement[] = [];
  const previous = computer.status;
  const wasMetered = computer.awake_since != null;
  const nextMetered = isMeteredStatus(status);
  if (wasMetered && !nextMetered) {
    statements.push(...settleStatements(env, computer, now), ...freeWakeStatements(env, computer, now));
    computer.awake_since = null;
    computer.free_wake_started_at = null;
    computer.free_wake_until = null;
    computer.last_awake_at = now;
  } else if (!wasMetered && nextMetered) {
    computer.awake_since = now;
    computer.last_awake_at = now;
    computer.delete_warned_7d_at = null;
    computer.delete_warned_1d_at = null;
  }
  computer.status = status;
  computer.status_changed_at = now;
  computer.cold_storage = 0;
  statements.push(env.DB.prepare(`
    update cloud_computers set status = ?, status_changed_at = ?, awake_since = ?, last_awake_at = ?,
      cold_storage = 0, free_wake_started_at = ?, free_wake_until = ?, delete_warned_7d_at = ?, delete_warned_1d_at = ?
    where instance_id = ?
  `).bind(
    status, now, computer.awake_since, computer.last_awake_at,
    computer.free_wake_started_at, computer.free_wake_until, computer.delete_warned_7d_at, computer.delete_warned_1d_at,
    computer.instance_id,
  ));
  const action = powerAction(previous, status);
  if (action) statements.push(powerLogStatement(env, computer, action, reason, now));
  return statements;
}

export function deleteLogStatement(
  env: CloudEnv,
  computer: Pick<ComputerRow, "instance_id" | "user_id">,
  args: { who: string | null; reason: string; events: unknown[] | null },
  now: number,
): D1PreparedStatement {
  const events = args.events ? JSON.stringify(args.events.slice(-500)) : null;
  return env.DB.prepare("insert into cloud_delete_log (instance_id, user_id, who, reason, events_json, created_at) values (?, ?, ?, ?, ?, ?)")
    .bind(computer.instance_id, computer.user_id, args.who, args.reason, events, now);
}

/** Settles an open stretch and marks the computer deleted, for after the provider's delete. */
export function markDeletedStatements(env: CloudEnv, computer: ComputerRow, now: number): D1PreparedStatement[] {
  const statements = settleStatements(env, computer, now);
  computer.awake_since = null;
  computer.deleted_at = now;
  statements.push(env.DB.prepare("update cloud_computers set deleted_at = ?, awake_since = null, status = 'deleted', status_changed_at = ? where instance_id = ?")
    .bind(now, now, computer.instance_id));
  return statements;
}

/* ---- Accounts ---- */

/** `past_due` puts a paid account on free-plan rules until a paid invoice. */
export function accountRules(account: Pick<AccountRow, "plan" | "stripe_status">): "free" | "paid" {
  return account.plan === "paid" && account.stripe_status !== "past_due" ? "paid" : "free";
}

export function computerLimit(account: AccountRow): number {
  return accountRules(account) === "paid" ? PAID_COMPUTER_LIMIT : FREE_COMPUTER_LIMIT;
}

export function extraActive(account: AccountRow): boolean {
  return accountRules(account) === "paid" && account.extra_enabled === 1;
}

/** Live hours used in thousandths: settled plus every running stretch. */
export function liveUsedMilli(account: AccountRow, computers: ComputerRow[], now: number): number {
  return computers.reduce((sum, computer) => sum + liveMilli(computer, now), account.used_milli);
}

export function isOutOfHours(account: AccountRow, liveUsed: number): boolean {
  return !extraActive(account) && liveUsed >= account.included_milli;
}

/** Whole percent of the included hours used; extra hours can pass 100. */
export function percentUsed(account: AccountRow, liveUsed: number): number {
  if (account.included_milli <= 0) return 100;
  return Math.floor((liveUsed * 100) / account.included_milli);
}

export function hoursState(account: AccountRow, liveUsed: number): CloudHoursState {
  if (isOutOfHours(account, liveUsed)) return "zero";
  const percent = percentUsed(account, liveUsed);
  if (percent >= 95) return "warn95";
  if (percent >= 80) return "warn80";
  return "none";
}

/** Gets the account, creating it (free) on first use and rolling a due period. */
export async function loadAccount(env: CloudEnv, userId: string, now: number): Promise<AccountRow> {
  let account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
  if (!account) {
    const period = freePeriodFor(now);
    await env.DB.prepare(`
      insert or ignore into cloud_accounts (user_id, plan, included_milli, period_start, period_end, created_at, updated_at)
      values (?, 'free', ?, ?, ?, ?, ?)
    `).bind(userId, FREE_INCLUDED_MILLI, period.start, period.end, now, now).run();
    account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
    if (!account) throw new Error("cloud account row missing after insert");
  }
  return rollPeriodIfDue(env, account, now);
}

type FreshPeriod = { plan: "free" | "paid"; start: number; end: number; included: number };

/** Settles what's open into the period that's ending, then starts `next`, resetting warnings. */
async function startFreshPeriod(env: CloudEnv, account: AccountRow, next: FreshPeriod, now: number): Promise<AccountRow> {
  const computers = await listComputers(env, account.user_id);
  const statements: D1PreparedStatement[] = [];
  for (const computer of computers) statements.push(...settleStatements(env, computer, now));
  // Open stretches restart at the boundary (a free push-work wake keeps its future start).
  statements.push(env.DB.prepare(`
    update cloud_computers set awake_since = ? where user_id = ? and awake_since is not null and awake_since <= ?
  `).bind(now, account.user_id, now));
  const restored = account.warned_zero_at != null ? now : account.hours_restored_at;
  statements.push(env.DB.prepare(`
    update cloud_accounts set plan = ?, included_milli = ?, used_milli = 0, period_start = ?, period_end = ?,
      warned_80_at = null, warned_95_at = null, warned_zero_at = null, hours_restored_at = ?, updated_at = ?
    where user_id = ?
  `).bind(next.plan, next.included, next.start, next.end, restored, now, account.user_id));
  await env.DB.batch(statements);
  return {
    ...account,
    plan: next.plan,
    included_milli: next.included,
    used_milli: 0,
    period_start: next.start,
    period_end: next.end,
    warned_80_at: null,
    warned_95_at: null,
    warned_zero_at: null,
    hours_restored_at: restored,
    updated_at: now,
  };
}

/**
 * Free periods (and a paid plan cancelled at its end) roll here. A paid
 * renewal waits for the Stripe webhook so its dates come from Stripe.
 */
export async function rollPeriodIfDue(env: CloudEnv, account: AccountRow, now: number): Promise<AccountRow> {
  if (account.period_end > now) return account;
  const cancelled = account.plan === "paid" && account.cancel_at_period_end === 1;
  if (accountRules(account) === "paid" && !cancelled) return account;
  const period = freePeriodFor(now);
  // `past_due` stays a paid account underneath: only a cancel ends the plan here.
  const nextPlan = cancelled ? "free" : account.plan === "paid" ? "paid" : "free";
  const rolled = await startFreshPeriod(env, account, { plan: nextPlan, start: period.start, end: period.end, included: FREE_INCLUDED_MILLI }, now);
  if (cancelled) {
    await env.DB.prepare(`
      update cloud_accounts set cancel_at_period_end = 0, extra_enabled = 0, stripe_status = null, updated_at = ? where user_id = ?
    `).bind(now, account.user_id).run();
    return { ...rolled, cancel_at_period_end: 0, extra_enabled: 0, stripe_status: null };
  }
  return rolled;
}

export type CloudPlanChange = {
  plan?: "free" | "paid";
  periodStart?: number;
  periodEnd?: number;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeStatus?: string | null;
  cancelAtPeriodEnd?: boolean;
  extraEnabled?: boolean;
};

/**
 * The one place a plan changes; the Stripe webhook calls this. Fields left out
 * keep their value. Free to paid and paid to free each start fresh hours, a
 * renewal (a new `periodStart`) starts a fresh 500, `past_due` drops to free
 * rules with fresh hours and turns extra hours off, and a later paid invoice
 * restores what the account had used if the same period is still running.
 */
export async function applyCloudPlanChange(env: CloudEnv, userId: string, change: CloudPlanChange, now = Date.now()): Promise<AccountRow> {
  let account = await loadAccount(env, userId, now);
  const nextPlan = change.plan ?? (account.plan as "free" | "paid");
  const nextStripeStatus = change.stripeStatus === undefined ? account.stripe_status : change.stripeStatus;
  const wasPastDue = account.stripe_status === "past_due";
  const isPastDue = nextStripeStatus === "past_due";
  const period = freePeriodFor(now);

  const extras: Array<[string, unknown]> = [];
  if (change.stripeCustomerId !== undefined) extras.push(["stripe_customer_id", change.stripeCustomerId]);
  if (change.stripeSubscriptionId !== undefined) extras.push(["stripe_subscription_id", change.stripeSubscriptionId]);
  if (change.stripeStatus !== undefined) extras.push(["stripe_status", change.stripeStatus]);
  if (change.cancelAtPeriodEnd !== undefined) extras.push(["cancel_at_period_end", change.cancelAtPeriodEnd ? 1 : 0]);

  if (!wasPastDue && isPastDue && account.plan === "paid") {
    // Read before the fresh start replaces them: a later paid invoice restores these.
    const stashUsed = liveUsedMilli(account, await listComputers(env, userId), now);
    const stashPeriodEnd = change.periodEnd ?? account.period_end;
    account = await startFreshPeriod(env, account, { plan: "paid", start: period.start, end: period.end, included: FREE_INCLUDED_MILLI }, now);
    extras.push(["past_due_used_milli", stashUsed], ["past_due_period_end", stashPeriodEnd], ["extra_enabled", 0]);
  } else if (wasPastDue && !isPastDue && nextPlan === "paid") {
    const stashEnd = account.past_due_period_end;
    const paidEnd = change.periodEnd ?? stashEnd ?? period.end;
    const stillSamePeriod = change.periodStart === undefined && stashEnd != null && stashEnd > now && paidEnd === stashEnd;
    if (stillSamePeriod) {
      account = await startFreshPeriod(env, account, {
        plan: "paid", start: change.periodStart ?? account.period_start, end: paidEnd, included: PAID_INCLUDED_MILLI,
      }, now);
      await env.DB.prepare("update cloud_accounts set used_milli = ? where user_id = ?").bind(account.past_due_used_milli ?? 0, userId).run();
      account.used_milli = account.past_due_used_milli ?? 0;
    } else {
      account = await startFreshPeriod(env, account, {
        plan: "paid", start: change.periodStart ?? now, end: paidEnd, included: PAID_INCLUDED_MILLI,
      }, now);
    }
    extras.push(["past_due_used_milli", null], ["past_due_period_end", null]);
  } else if (account.plan === "free" && nextPlan === "paid") {
    account = await startFreshPeriod(env, account, {
      plan: "paid", start: change.periodStart ?? now, end: change.periodEnd ?? period.end, included: PAID_INCLUDED_MILLI,
    }, now);
  } else if (account.plan === "paid" && nextPlan === "free") {
    account = await startFreshPeriod(env, account, { plan: "free", start: period.start, end: period.end, included: FREE_INCLUDED_MILLI }, now);
    extras.push(["extra_enabled", 0]);
  } else if (nextPlan === "paid" && change.periodStart !== undefined && change.periodStart !== account.period_start && !isPastDue) {
    account = await startFreshPeriod(env, account, {
      plan: "paid", start: change.periodStart, end: change.periodEnd ?? account.period_end, included: PAID_INCLUDED_MILLI,
    }, now);
  }

  if (change.extraEnabled !== undefined && nextPlan === "paid" && !isPastDue) extras.push(["extra_enabled", change.extraEnabled ? 1 : 0]);
  if (extras.length) {
    const sets = extras.map(([column]) => `${column} = ?`).join(", ");
    await env.DB.prepare(`update cloud_accounts set ${sets}, updated_at = ? where user_id = ?`)
      .bind(...extras.map(([, value]) => value), now, userId).run();
  }
  return (await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>()) ?? account;
}

export const DELETION_AFTER_INACTIVE_MS = 30 * 24 * 60 * 60_000;
export const DELETION_WARNING_LATE_MS = 7 * 24 * 60 * 60_000;

/**
 * When an inactive computer is deleted: 30 days after it was last awake or
 * after hours came back, or null while it's awake or the account is out of
 * hours, because nobody loses a computer just for running out.
 */
export function deletionDueAt(computer: ComputerRow, account: AccountRow, liveUsed: number): number | null {
  if (computer.awake_since != null || computer.status === "provisioning" || isOutOfHours(account, liveUsed)) return null;
  const lastAwake = computer.last_awake_at ?? computer.created_at;
  const since = Math.max(lastAwake, account.hours_restored_at ?? 0);
  return since + DELETION_AFTER_INACTIVE_MS;
}

export async function buildAccountState(env: CloudEnv, userId: string, now: number): Promise<CloudAccountState> {
  const account = await loadAccount(env, userId, now);
  const computers = await listComputers(env, userId);
  const live = liveUsedMilli(account, computers, now);
  const rules = accountRules(account);
  const due = computers
    .filter((computer) => !isPendingId(computer.instance_id))
    .map((computer) => ({ computer, deletesAt: deletionDueAt(computer, account, live) }))
    .filter((entry): entry is { computer: ComputerRow; deletesAt: number } => entry.deletesAt != null && entry.deletesAt - now <= DELETION_WARNING_LATE_MS)
    .sort((a, b) => a.deletesAt - b.deletesAt)
    .map(({ computer, deletesAt }) => ({ instanceId: computer.instance_id, name: computer.name, deletesAt }));
  return {
    plan: account.plan === "paid" ? "paid" : "free",
    rules,
    hours: {
      includedMilli: account.included_milli,
      usedMilli: live,
      leftMilli: Math.max(0, account.included_milli - live),
      percentUsed: percentUsed(account, live),
      state: hoursState(account, live),
    },
    extraHours: {
      available: rules === "paid",
      enabled: extraActive(account),
      usedMilli: Math.max(0, live - account.included_milli),
    },
    disk: {
      usedGb: computers.reduce((sum, computer) => sum + computer.disk_gb, 0),
      limitGb: rules === "paid" ? PAID_DISK_POOL_GB : null,
    },
    computers: {
      total: computers.length,
      awake: computers.filter((computer) => isMeteredStatus(computer.status)).length,
      limit: computerLimit(account),
    },
    dueForDeletion: due,
    billing: {
      periodStart: account.period_start,
      periodEnd: account.period_end,
      stripeStatus: account.stripe_status,
      cancelAtPeriodEnd: account.cancel_at_period_end === 1,
    },
  };
}
