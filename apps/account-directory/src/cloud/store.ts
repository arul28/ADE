import type { CallerTokenEnv } from "../callerToken";
import type { CloudAccountState, CloudHoursState, CloudInstance } from "./contract";
import type { CloudEmailEnv } from "./email";
import {
  FREE_COMPUTER_LIMIT,
  FREE_INCLUDED_MILLI,
  PAID_COMPUTER_LIMIT,
  PAID_DISK_POOL_GB,
  PAID_INCLUDED_MILLI,
  cloudCatalog,
  freePeriodFor,
  hoursMilliFor,
  isMeteredStatus,
  isRestingStatus,
  splitByUtcDay,
  type CloudComputerType,
} from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";

/**
 * The computers and accounts in D1, and the one place that moves hours. Live
 * hours are `used_milli` plus the open stretches in `cloud_computers`, so a
 * tick writes only when something changed.
 */

export type CloudEnv = CallerTokenEnv & CloudEmailEnv & {
  DB: D1Database;
  AGENT37_API_KEY?: string;
  CLOUD_ACCESS_ACCOUNTS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PLAN_PRICE_ID?: string;
  STRIPE_EXTRA_PRICE_ID?: string;
  STRIPE_METER_EVENT?: string;
  /** Saved chats: sealed transcript parts. Created at rollout; missing answers 503. */
  CLOUD_CHATS?: R2Bucket;
  /** 32 random bytes, base64. Seals each user's chat key. Required for saved chats. */
  CLOUD_CHAT_MASTER_KEY?: string;
};

/** What a function needs that only touches the tables. */
export type CloudDb = Pick<CloudEnv, "DB">;

export type ComputerRow = {
  instance_id: string;
  user_id: string;
  request_id: string | null;
  type: CloudComputerType;
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
  plan: "free" | "paid";
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
  extra_owed_milli: number;
  past_due_used_milli: number | null;
  past_due_period_end: number | null;
  warned_80_at: number | null;
  warned_95_at: number | null;
  warned_zero_at: number | null;
  hours_restored_at: number | null;
  billing_restored_at: number | null;
  created_at: number;
  updated_at: number;
};

export function logCloud(event: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-account-directory", kind: event, ...meta }));
}

/** A reservation with no computer behind it after this long is given up on. */
export const PENDING_TIMEOUT_MS = 15 * 60_000;
const PENDING_PREFIX = "pending:";
export const isPendingId = (id: string): boolean => id.startsWith(PENDING_PREFIX);
export const newPendingId = (): string => `${PENDING_PREFIX}${crypto.randomUUID()}`;

export async function readSetting(env: CloudEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare("select value from cloud_settings where key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** A stored time in ms; 0 when it was never written. */
export async function readTimeSetting(env: CloudEnv, key: string): Promise<number> {
  return Number(await readSetting(env, key) ?? 0);
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

export async function listComputers(env: CloudDb, userId: string): Promise<ComputerRow[]> {
  const rows = await env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null")
    .bind(userId).all<ComputerRow>();
  return rows.results ?? [];
}

/**
 * Holds a statement back unless the row still reads what the caller read, so two
 * requests racing a status change (the idle call and a tick or read) charge once.
 */
export type StatusGuard = { sql: string; binds: Array<string | number> };

export function statusGuard(computer: Pick<ComputerRow, "instance_id" | "status" | "awake_since">): StatusGuard {
  return computer.awake_since == null
    ? { sql: "exists (select 1 from cloud_computers where instance_id = ? and status = ? and awake_since is null)", binds: [computer.instance_id, computer.status] }
    : { sql: "exists (select 1 from cloud_computers where instance_id = ? and status = ? and awake_since = ?)", binds: [computer.instance_id, computer.status, computer.awake_since] };
}

/** Closes the part of the open stretch up to `upTo` and charges it. Empty when nothing is open. */
export function settleStatements(env: CloudDb, computer: ComputerRow, upTo: number, guard?: StatusGuard): D1PreparedStatement[] {
  const start = computer.awake_since;
  if (start == null) return [];
  const statements: D1PreparedStatement[] = [];
  let chargedMilli = 0;
  for (const { day, ms } of splitByUtcDay(start, upTo)) {
    const milli = hoursMilliFor(ms, computer.multiplier_milli);
    chargedMilli += milli;
    statements.push(env.DB.prepare(`
      insert into cloud_computer_days (instance_id, day, user_id, metered_ms, metered_milli, multiplier_milli)
      select ?, ?, ?, ?, ?, ?
      where ${guard ? guard.sql : "1"}
      on conflict (instance_id, day) do update set
        metered_ms = metered_ms + excluded.metered_ms,
        metered_milli = metered_milli + excluded.metered_milli,
        multiplier_milli = excluded.multiplier_milli
    `).bind(computer.instance_id, day, computer.user_id, ms, milli, computer.multiplier_milli, ...(guard?.binds ?? [])));
  }
  if (chargedMilli > 0) {
    statements.push(env.DB.prepare(`update cloud_accounts set used_milli = used_milli + ?, updated_at = ? where user_id = ?${guard ? ` and ${guard.sql}` : ""}`)
      .bind(chargedMilli, upTo, computer.user_id, ...(guard?.binds ?? [])));
  }
  return statements;
}

/** Charges the open stretch up to `now` and starts a new one there, guarded against a status change since this row was read. */
export function restartStretchStatements(env: CloudEnv, computer: ComputerRow, now: number): D1PreparedStatement[] {
  const guard = statusGuard(computer);
  const statements = [
    ...settleStatements(env, computer, now, guard),
    env.DB.prepare(`update cloud_computers set awake_since = ? where instance_id = ? and ${guard.sql}`).bind(now, computer.instance_id, ...guard.binds),
  ];
  computer.awake_since = now;
  return statements;
}

/** The free push-work time of a closing stretch, so the daily reconcile doesn't charge it. */
function freeWakeStatements(env: CloudEnv, computer: ComputerRow, closedAt: number, guard: StatusGuard): D1PreparedStatement[] {
  if (computer.free_wake_started_at == null || computer.free_wake_until == null) return [];
  const freeEnd = Math.min(closedAt, computer.free_wake_until);
  return splitByUtcDay(computer.free_wake_started_at, freeEnd).map(({ day, ms }) =>
    env.DB.prepare(`
      insert into cloud_computer_days (instance_id, day, user_id, free_ms, multiplier_milli)
      select ?, ?, ?, ?, ?
      where ${guard.sql}
      on conflict (instance_id, day) do update set free_ms = free_ms + excluded.free_ms
    `).bind(computer.instance_id, day, computer.user_id, ms, computer.multiplier_milli, ...guard.binds));
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
  // Read before the row changes below: every statement here needs the row as it was read.
  const guard = statusGuard(computer);
  const wasMetered = computer.awake_since != null;
  const nextMetered = isMeteredStatus(status);
  if (wasMetered && !nextMetered) {
    statements.push(...settleStatements(env, computer, now, guard), ...freeWakeStatements(env, computer, now, guard));
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
  const action = powerAction(previous, status);
  if (action) {
    statements.push(env.DB.prepare(`insert into cloud_power_log (instance_id, user_id, action, reason, created_at) select ?, ?, ?, ?, ? where ${guard.sql}`)
      .bind(computer.instance_id, computer.user_id, action, reason, now, ...guard.binds));
  }
  // Last: the writes above read this row through the guard.
  statements.push(env.DB.prepare(`
    update cloud_computers set status = ?, status_changed_at = ?, awake_since = ?, last_awake_at = ?,
      cold_storage = 0, free_wake_started_at = ?, free_wake_until = ?, delete_warned_7d_at = ?, delete_warned_1d_at = ?
    where instance_id = ? and status = ?
  `).bind(
    status, now, computer.awake_since, computer.last_awake_at,
    computer.free_wake_started_at, computer.free_wake_until, computer.delete_warned_7d_at, computer.delete_warned_1d_at,
    computer.instance_id, previous,
  ));
  return statements;
}

export function deleteLogStatement(
  env: CloudDb,
  computer: Pick<ComputerRow, "instance_id" | "user_id">,
  args: { who: string | null; reason: string; events: unknown[] | null },
  now: number,
): D1PreparedStatement {
  const events = args.events ? JSON.stringify(args.events.slice(-500)) : null;
  return env.DB.prepare("insert into cloud_delete_log (instance_id, user_id, who, reason, events_json, created_at) values (?, ?, ?, ?, ?, ?)")
    .bind(computer.instance_id, computer.user_id, args.who, args.reason, events, now);
}

/** Settles an open stretch and marks the computer deleted, for after the provider's delete. */
export function markDeletedStatements(env: CloudDb, computer: ComputerRow, now: number): D1PreparedStatement[] {
  // Guarded: two deletes of one computer charge its last stretch once.
  const statements = settleStatements(env, computer, now, statusGuard(computer));
  computer.awake_since = null;
  computer.deleted_at = now;
  statements.push(env.DB.prepare("update cloud_computers set deleted_at = ?, awake_since = null, status = 'deleted', status_changed_at = ? where instance_id = ?")
    .bind(now, now, computer.instance_id));
  return statements;
}

/** The log entry and the closed row for a computer that's gone. */
export function closedComputerStatements(
  env: CloudDb,
  computer: ComputerRow,
  args: { who: string | null; reason: string; events: unknown[] | null },
  now: number,
): D1PreparedStatement[] {
  return [deleteLogStatement(env, computer, args, now), ...markDeletedStatements(env, computer, now)];
}

/** A computer the provider no longer has, though nobody here deleted it. */
export function goneFromProviderStatements(env: CloudEnv, computer: ComputerRow, now: number): D1PreparedStatement[] {
  return closedComputerStatements(env, computer, { who: null, reason: "gone_from_provider", events: null }, now);
}

/**
 * Deletes a computer on the provider, then logs it and closes its row. Its events
 * go with it, so they're read first. Already gone counts as deleted; any other
 * provider failure throws, with the row left open.
 */
export async function deleteComputer(
  env: CloudDb,
  provider: Pick<CloudProvider, "instanceEvents" | "deleteInstance">,
  computer: ComputerRow,
  args: { who: string | null; reason: string },
  now: number,
): Promise<void> {
  const events = await provider.instanceEvents(computer.instance_id).catch((error: unknown) => {
    logCloud("cloud.delete_events_read_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    return null;
  });
  try {
    await provider.deleteInstance(computer.instance_id);
  } catch (error) {
    if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
  }
  await env.DB.batch(closedComputerStatements(env, computer, { ...args, events }, now));
}

/**
 * A reservation becoming the real row. `not exists`: a deleted row keeps its id,
 * and a clash here must adopt nothing. The log line needs the row this update
 * just wrote, so a reservation another path already adopted logs once.
 */
export function adoptionStatements(
  env: CloudEnv,
  args: { pendingId: string; instance: CloudInstance; machineKey: string | null; now: number; reason: string },
): D1PreparedStatement[] {
  const { pendingId, instance, machineKey, now, reason } = args;
  return [
    env.DB.prepare(`
      update cloud_computers set instance_id = ?, machine_key = coalesce(?, machine_key), status = ?, status_changed_at = ?,
        awake_since = ?, last_awake_at = ?
      where instance_id = ? and not exists (select 1 from cloud_computers where instance_id = ?)
    `).bind(instance.id, machineKey, instance.status, now, isMeteredStatus(instance.status) ? now : null, now, pendingId, instance.id),
    env.DB.prepare(`
      insert into cloud_power_log (instance_id, user_id, action, reason, created_at)
      select ?, user_id, 'start', ?, ? from cloud_computers where instance_id = ? and status_changed_at = ?
    `).bind(instance.id, reason, now, instance.id, now),
  ];
}

export function groupByUser<T extends { user_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.user_id);
    if (list) list.push(row);
    else out.set(row.user_id, [row]);
  }
  return out;
}

/* ---- Accounts ---- */

/** `past_due` puts a paid account on free-plan rules until a paid invoice. */
export function accountRules(account: Pick<AccountRow, "plan" | "stripe_status">): "free" | "paid" {
  return account.plan === "paid" && account.stripe_status !== "past_due" ? "paid" : "free";
}

export function computerLimit(account: AccountRow): number {
  return accountRules(account) === "paid" ? PAID_COMPUTER_LIMIT : FREE_COMPUTER_LIMIT;
}

/** Extra hours already used: what is still billed once the switch goes off. */
export function extraOwedMilli(account: AccountRow, liveUsed: number): number {
  return Math.max(account.extra_owed_milli, liveUsed - account.included_milli, 0);
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

type PlanTransition = {
  kind: "past_due" | "restored_same_period" | "restored_new_period" | "to_paid" | "to_free" | "renewal";
  next: FreshPeriod;
};

/** Which fresh period a plan change starts, or null when it starts none. */
function planTransition(
  account: AccountRow,
  change: CloudPlanChange,
  state: { nextPlan: "free" | "paid"; wasPastDue: boolean; isPastDue: boolean; now: number },
): PlanTransition | null {
  const { nextPlan, wasPastDue, isPastDue, now } = state;
  const free = freePeriodFor(now);
  if (!wasPastDue && isPastDue && account.plan === "paid") {
    return { kind: "past_due", next: { plan: "paid", start: free.start, end: free.end, included: FREE_INCLUDED_MILLI } };
  }
  if (wasPastDue && !isPastDue && nextPlan === "paid") {
    const stashEnd = account.past_due_period_end;
    const end = change.periodEnd ?? stashEnd ?? free.end;
    return stashEnd != null && stashEnd > now && end === stashEnd
      ? { kind: "restored_same_period", next: { plan: "paid", start: change.periodStart ?? account.period_start, end, included: PAID_INCLUDED_MILLI } }
      : { kind: "restored_new_period", next: { plan: "paid", start: change.periodStart ?? now, end, included: PAID_INCLUDED_MILLI } };
  }
  if (account.plan === "free" && nextPlan === "paid") {
    return { kind: "to_paid", next: { plan: "paid", start: change.periodStart ?? now, end: change.periodEnd ?? free.end, included: PAID_INCLUDED_MILLI } };
  }
  if (account.plan === "paid" && nextPlan === "free") {
    return { kind: "to_free", next: { plan: "free", start: free.start, end: free.end, included: FREE_INCLUDED_MILLI } };
  }
  if (nextPlan === "paid" && change.periodStart !== undefined && change.periodStart !== account.period_start && !isPastDue) {
    return { kind: "renewal", next: { plan: "paid", start: change.periodStart, end: change.periodEnd ?? account.period_end, included: PAID_INCLUDED_MILLI } };
  }
  return null;
}

/**
 * The one place a plan changes; the Stripe webhook calls this. Fields left out
 * keep their value. Free to paid and paid to free each start fresh hours, a
 * renewal (a new `periodStart`) starts a fresh 500, `past_due` drops to free
 * rules with fresh hours and turns extra hours off, and a later paid invoice
 * restores what the account had used if the same period is still running.
 */
export async function applyCloudPlanChange(env: CloudEnv, userId: string, change: CloudPlanChange, now = Date.now()): Promise<AccountRow> {
  let account = await loadAccount(env, userId, now);
  const nextPlan = change.plan ?? account.plan;
  const nextStripeStatus = change.stripeStatus === undefined ? account.stripe_status : change.stripeStatus;
  const wasPastDue = account.stripe_status === "past_due";
  const isPastDue = nextStripeStatus === "past_due";
  /** A new billing period: nothing is reported or owed in it yet. */
  const clearExtraReports: Array<[keyof AccountRow, unknown]> = [["extra_reported_milli", 0], ["extra_owed_milli", 0]];

  const extras: Array<[keyof AccountRow, unknown]> = [];
  if (change.stripeCustomerId !== undefined) extras.push(["stripe_customer_id", change.stripeCustomerId]);
  if (change.stripeSubscriptionId !== undefined) extras.push(["stripe_subscription_id", change.stripeSubscriptionId]);
  if (change.stripeStatus !== undefined) extras.push(["stripe_status", change.stripeStatus]);
  if (change.cancelAtPeriodEnd !== undefined) extras.push(["cancel_at_period_end", change.cancelAtPeriodEnd ? 1 : 0]);

  const transition = planTransition(account, change, { nextPlan, wasPastDue, isPastDue, now });
  if (transition?.kind === "past_due") {
    // Read before the fresh start replaces them: a later paid invoice restores these.
    const stashUsed = liveUsedMilli(account, await listComputers(env, userId), now);
    const stashPeriodEnd = change.periodEnd ?? account.period_end;
    // Extra hours go off here, but what was already used is still owed.
    const owed = extraActive(account) ? extraOwedMilli(account, stashUsed) : account.extra_owed_milli;
    extras.push(["past_due_used_milli", stashUsed], ["past_due_period_end", stashPeriodEnd], ["extra_enabled", 0], ["extra_owed_milli", owed]);
  }
  if (transition) account = await startFreshPeriod(env, account, transition.next, now);
  switch (transition?.kind) {
    case "restored_same_period":
      await env.DB.prepare("update cloud_accounts set used_milli = ? where user_id = ?").bind(account.past_due_used_milli ?? 0, userId).run();
      account.used_milli = account.past_due_used_milli ?? 0;
      extras.push(["past_due_used_milli", null], ["past_due_period_end", null]);
      break;
    case "restored_new_period":
      extras.push(...clearExtraReports, ["past_due_used_milli", null], ["past_due_period_end", null]);
      break;
    case "to_paid":
    case "renewal":
      extras.push(...clearExtraReports);
      break;
    case "to_free":
      extras.push(["extra_enabled", 0]);
      break;
  }

  if (change.extraEnabled !== undefined && nextPlan === "paid" && !isPastDue) extras.push(["extra_enabled", change.extraEnabled ? 1 : 0]);
  if (extras.length) {
    const sets = extras.map(([column]) => `${column} = ?`).join(", ");
    await env.DB.prepare(`update cloud_accounts set ${sets}, updated_at = ? where user_id = ?`)
      .bind(...extras.map(([, value]) => value), now, userId).run();
  }
  return (await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>()) ?? account;
}

const BILLING_RESTORED_NOTICE_MS = 3 * 24 * 60 * 60_000;
export const DELETION_AFTER_INACTIVE_MS = 30 * 24 * 60 * 60_000;
export const DELETION_WARNING_LATE_MS = 7 * 24 * 60 * 60_000;

/**
 * When an inactive computer is deleted: 30 days after it was last awake or
 * after hours came back, or null while it's awake or on its way there, or the
 * account is out of hours, because nobody loses a computer just for running out.
 */
export function deletionDueAt(computer: ComputerRow, account: AccountRow, liveUsed: number): number | null {
  if (computer.awake_since != null || !isRestingStatus(computer.status) || isOutOfHours(account, liveUsed)) return null;
  const lastAwake = computer.last_awake_at ?? computer.created_at;
  const since = Math.max(lastAwake, account.hours_restored_at ?? 0);
  return since + DELETION_AFTER_INACTIVE_MS;
}

/** The banner for the account: a failed payment, or a plan that just came back. */
function billingNotice(account: AccountRow, now: number): "past_due" | "restored" | null {
  if (account.plan !== "paid") return null;
  if (account.stripe_status === "past_due") return "past_due";
  return account.billing_restored_at != null && now - account.billing_restored_at < BILLING_RESTORED_NOTICE_MS ? "restored" : null;
}

/** How long a deleted computer's id is still reported, so its leftover ADE row can be explained. */
const DELETED_REPORTED_MS = 90 * 24 * 60 * 60_000;

async function recentlyDeletedInstanceIds(env: CloudEnv, userId: string, now: number): Promise<string[]> {
  const rows = await env.DB.prepare(`
    select c.instance_id from cloud_computers c
    where c.user_id = ? and c.deleted_at is not null and c.deleted_at >= ?
  `).bind(userId, now - DELETED_REPORTED_MS).all<{ instance_id: string }>();
  return (rows.results ?? []).map((row) => row.instance_id);
}

export async function buildAccountState(env: CloudEnv, userId: string, now: number): Promise<CloudAccountState> {
  const account = await loadAccount(env, userId, now);
  const [computers, deletedInstanceIds] = await Promise.all([listComputers(env, userId), recentlyDeletedInstanceIds(env, userId, now)]);
  const live = liveUsedMilli(account, computers, now);
  const rules = accountRules(account);
  const due = computers
    .filter((computer) => !isPendingId(computer.instance_id))
    .map((computer) => ({ computer, deletesAt: deletionDueAt(computer, account, live) }))
    .filter((entry): entry is { computer: ComputerRow; deletesAt: number } => entry.deletesAt != null && entry.deletesAt - now <= DELETION_WARNING_LATE_MS)
    .sort((a, b) => a.deletesAt - b.deletesAt)
    .map(({ computer, deletesAt }) => ({ instanceId: computer.instance_id, name: computer.name, deletesAt }));
  return {
    plan: account.plan,
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
    deletedInstanceIds,
    catalog: cloudCatalog(),
    billing: {
      periodStart: account.period_start,
      periodEnd: account.period_end,
      stripeStatus: account.stripe_status,
      cancelAtPeriodEnd: account.cancel_at_period_end === 1,
      notice: billingNotice(account, now),
    },
  };
}
