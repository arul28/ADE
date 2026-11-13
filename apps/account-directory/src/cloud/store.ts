import * as Sentry from "@sentry/cloudflare";
import type { CallerTokenEnv } from "../callerToken";
import { overPlanDiskSentence, type CloudExtraDiskState, type CloudHoursState, type CloudInstance, type CloudPlanFacts, type CloudPlanId } from "./contract";
import type { CloudEmailEnv } from "./email";
import {
  CLOUD_PLANS,
  EXTRA_DISK_MICROS_PER_GB_DAY,
  FREE_INCLUDED_MILLI,
  computeCostMicrosFor,
  type CloudOffers,
  freePeriodFor,
  hoursMilliFor,
  isMeteredStatus,
  isRestingStatus,
  splitByUtcDay,
  utcDay,
  type CloudComputerType,
  type CloudPaidPlanId,
} from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import { keepLaneStatement, laneFactsOf } from "./lanesWithoutComputer";

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
  /** The older name of extra hours' price: a Worker secret in production, so `STRIPE_EXTRA_HOURS_PRICE_ID` (a var) wins. */
  STRIPE_EXTRA_PRICE_ID?: string;
  /** Extra hours' price on its own "Extra hours" product (`scripts/stripe-setup.mjs`). */
  STRIPE_EXTRA_HOURS_PRICE_ID?: string;
  STRIPE_METER_EVENT?: string;
  /** Pro's monthly price (`scripts/stripe-setup.mjs`). Unset: only Plus can be bought. */
  STRIPE_PRO_PRICE_ID?: string;
  /** Extra disk's metered price and meter. Unset: extra disk can't be turned on. */
  STRIPE_DISK_PRICE_ID?: string;
  STRIPE_DISK_METER_EVENT?: string;
  /** The billing portal setup that lets a person switch between Plus and Pro. */
  STRIPE_PORTAL_CONFIG_ID?: string;
  /** Server-side product analytics (`analytics.ts`); unset sends nothing. */
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  /** Saved chats: sealed transcript parts. Created at rollout; missing answers 503. */
  CLOUD_CHATS?: R2Bucket;
  /** 32 random bytes, base64. Seals each user's chat key. Required for saved chats. */
  CLOUD_CHAT_MASTER_KEY?: string;
  /** `production` only in the deployed config (`sentry.ts`). */
  SENTRY_ENVIRONMENT?: string;
  /** The hosted web client's exact origin: the only browser origin `/cloud/*` answers (CORS). */
  WEB_CLIENT_ORIGIN?: string;
  /** The server launcher's join mints the device sign-in link with Clerk's backend key (`deviceAppApproval.ts`). */
  CLERK_SECRET_KEY?: string;
  DEVICE_PAGE_ORIGIN?: string;
  /** The server launcher's join codes are HMACs under this key (`launches.ts`). Unset: a server launch can't start (503). */
  CLOUD_LAUNCH_JOIN_KEY?: string;
  /** The ADE GitHub App (`githubApp/grants.ts`): the free plan's GitHub rules read the account's grant and, once, its GitHub account's age. */
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_TOKEN_KEY?: string;
  GITHUB_WEB_BASE_URL?: string;
  GITHUB_API_BASE_URL?: string;
};

/** The deployed production Worker, where a missing secret or an email that can't be sent is a failure, not a setup. */
export const isProduction = (env: Pick<CloudEnv, "SENTRY_ENVIRONMENT">): boolean => env.SENTRY_ENVIRONMENT?.trim() === "production";

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
  disk_reserved_at: number | null;
  /** While a grow waits for the provider: the size it last confirmed (billed until then). */
  disk_confirmed_gb: number | null;
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
  /** While a move runs: the computer it moves (see `MOVE_GRACE_MS`). */
  moving_from: string | null;
  cold_storage: number;
  free_wake_started_at: number | null;
  free_wake_until: number | null;
  free_wake_used_at: number | null;
  zero_stop_started_at: number | null;
  delete_warned_7d_at: number | null;
  delete_warned_1d_at: number | null;
  /** Updates (migration 0020, `updates.ts`): the channel the computer follows, `stable` or `beta`. */
  channel: string;
  /** The image before the last update, for the rollback. */
  previous_template: string | null;
  /** null, `updating` (waiting for the boot report) or `failed`. */
  update_state: string | null;
  update_started_at: number | null;
  /** `manual`, `idle`, `asleep` or `rollback`. */
  update_reason: string | null;
  /** The last boot report on a new image. */
  updated_at: number | null;
  /** An image this computer failed to start on: never tried again on its own. */
  update_failed_template: string | null;
  update_error: string | null;
  /** Whether the update in flight's image sends a boot report (1/0), saved at its start; null before migration 0020's column. */
  update_expects_report?: number | null;
  /** The lane the computer holds (migration 0021, `lanesWithoutComputer.ts`), kept here so no live read is needed to keep it. */
  lane_id?: string | null;
  lane_name?: string | null;
  lane_project_origin?: string | null;
  lane_branch?: string | null;
  /** `freed`, `inactive` or `plan_limit` while a delete that keeps the lane runs: closing the row writes the lane's row. */
  lane_keep_reason?: string | null;
  /** Use facts (migration 0022, `diskUsage.ts`): the last disk measure, as JSON, and when it was taken. */
  disk_usage_json?: string | null;
  disk_measured_at?: number | null;
  /** When the computer last did work, as it reported at its idle step. */
  last_active_at?: number | null;
  /** Its lane's work (`CloudLaneWork`), as JSON. */
  lane_work_json?: string | null;
};

export type AccountRow = {
  user_id: string;
  plan: "free" | "paid";
  /** Which paid plan; read only while `plan` is `paid`. */
  paid_plan: CloudPaidPlanId;
  /** A downgrade waiting for the next period; `paid_plan` holds until then. */
  paid_plan_next: CloudPaidPlanId | null;
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
  extra_disk_state: CloudExtraDiskState;
  extra_disk_limit_cents: number | null;
  extra_disk_asked_at: number | null;
  /** When the person was told their extra disk, kept a full month, passes their limit; cleared once it fits again. */
  extra_disk_over_limit_at: number | null;
  /** Earned hours (migration 0026, `referrals.ts`): every grant, recomputed from `cloud_earned_hours`. */
  earned_granted_milli: number;
  /** What ended periods drew from earned hours. The balance is granted minus this. */
  earned_used_milli: number;
  /** What the period a failed payment cut short drew from earned hours, given back if that period is restored. */
  past_due_earned_milli: number | null;
  /** Refused the free plan: its computer already gave another account free hours (`freePlan.ts`). Free hours are 0 while set. */
  free_refused_at: number | null;
  /** When the ADE account was created (Clerk), for the invite code's 30-day window. */
  account_created_at: number | null;
  /** Why the GitHub rules hold the free hours at 0 (`freePlanGithub.ts`, migration 0035); null while nothing is held. */
  free_github_hold: string | null;
  /** 1: used ADE Cloud before the GitHub rules shipped, so they don't apply. */
  free_github_exempt: number;
  /** When a card saved with no charge unlocked the free hours for a GitHub account younger than 30 days. */
  free_card_unlocked_at: number | null;
  /** Unused since migration 0032 (the grace design's due time and warned list); always null. */
  plan_cleanup_due_at: number | null;
  plan_cleanup_warned_json: string | null;
  /** The person's pick of computers to free for a cheaper plan, while ADE frees it (migration 0032, `planCleanup.ts` `PlanCleanupChoice`). */
  plan_cleanup_choice_json: string | null;
  /** When the person was told the account is over the plan in force (new computers refused); null while it fits. */
  plan_over_told_at: number | null;
  /** The last pick's outcome so far (`CloudPlanCleanupDone` as JSON), and when it last changed. */
  plan_cleanup_result_json: string | null;
  plan_cleanup_result_at: number | null;
  /** Timed wake-ups cancelled this period (`accountNotices.ts`): when, how many, and why. */
  wakes_cancelled_at: number | null;
  wakes_cancelled_count: number | null;
  wakes_cancelled_reason: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
};

export function logCloud(event: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-account-directory", kind: event, ...meta }));
}

/** One Sentry issue per failure kind and isolate an hour: these repeat each tick while the cause lasts. */
const FAILURE_REPORT_INTERVAL_MS = 60 * 60_000;
const lastFailureReport = new Map<string, number>();

/**
 * {@link logCloud} for a failure that's ADE's to fix: the line stays local, the event name reaches Sentry.
 * `area` tags the Sentry issue (`cloud`, `cloud-referrals`, `cloud-free-plan`) so alert rules can pick one.
 */
export function reportCloudFailure(event: string, meta: Record<string, unknown> = {}, area = "cloud"): void {
  logCloud(event, meta);
  const now = Date.now();
  if (now - (lastFailureReport.get(event) ?? 0) < FAILURE_REPORT_INTERVAL_MS) return;
  lastFailureReport.set(event, now);
  // Only the event name: `meta` carries account and instance ids.
  Sentry.captureMessage(event, { level: "warning", fingerprint: [event], tags: { area } });
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
  const shape = { type: computer.type, cpu: computer.cpu, memoryGb: computer.memory_gb };
  for (const { day, ms } of splitByUtcDay(start, upTo)) {
    const milli = hoursMilliFor(ms, computer.multiplier_milli);
    chargedMilli += milli;
    // What the provider charges for this stretch, for the owner's daily report.
    const costMicros = computeCostMicrosFor(ms, shape);
    statements.push(env.DB.prepare(`
      insert into cloud_computer_days (instance_id, day, user_id, metered_ms, metered_milli, multiplier_milli, cost_micros)
      select ?, ?, ?, ?, ?, ?, ?
      where ${guard ? guard.sql : "1"}
      on conflict (instance_id, day) do update set
        metered_ms = metered_ms + excluded.metered_ms,
        metered_milli = metered_milli + excluded.metered_milli,
        multiplier_milli = excluded.multiplier_milli,
        cost_micros = cost_micros + excluded.cost_micros
    `).bind(computer.instance_id, day, computer.user_id, ms, milli, computer.multiplier_milli, costMicros, ...(guard?.binds ?? [])));
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
export function freeWakeStatements(env: CloudEnv, computer: ComputerRow, closedAt: number, guard: StatusGuard): D1PreparedStatement[] {
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
    // A free wake that didn't count as use (over the plan's disk, see handleStart) leaves
    // `last_awake_at` before its start; closing it keeps the 30-day delete clock where it was.
    const freeWakeNotUse = computer.free_wake_started_at != null
      && (computer.last_awake_at == null || computer.last_awake_at < computer.free_wake_started_at);
    computer.awake_since = null;
    computer.free_wake_started_at = null;
    computer.free_wake_until = null;
    if (!freeWakeNotUse) computer.last_awake_at = now;
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
  // The disk breakdown, the lane's work (branch names, pull request state) and the lane's facts go with the computer.
  statements.push(env.DB.prepare(`
    update cloud_computers set deleted_at = ?, awake_since = null, status = 'deleted', status_changed_at = ?, disk_usage_json = null, lane_work_json = null,
      lane_id = null, lane_name = null, lane_project_origin = null, lane_branch = null, lane_keep_reason = null
    where instance_id = ?
  `).bind(now, now, computer.instance_id));
  return statements;
}

/**
 * The log entry and the closed row for a computer that's gone. A row marked to
 * keep its lane (`lane_keep_reason`, set just before the delete) writes the
 * lane's row in the same batch, read from the row as stored, so a close after a
 * crash (the tick finding the computer gone) keeps it too. An account being
 * deleted keeps nothing.
 */
export function closedComputerStatements(
  env: CloudDb,
  computer: ComputerRow,
  args: { who: string | null; reason: string; events: unknown[] | null },
  now: number,
): D1PreparedStatement[] {
  return [
    deleteLogStatement(env, computer, args, now),
    // Before the close below clears the lane's facts.
    ...(args.reason === "account_deleted" ? [] : [keepLaneStatement(env, computer.instance_id, now)]),
    ...markDeletedStatements(env, computer, now),
  ];
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
    reportCloudFailure("cloud.delete_events_read_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
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
  // A reservation made before the row kept lane facts gets them from the instance.
  const lane = laneFactsOf(instance.metadata);
  return [
    env.DB.prepare(`
      update cloud_computers set instance_id = ?, machine_key = coalesce(?, machine_key), status = ?, status_changed_at = ?,
        awake_since = ?, last_awake_at = ?,
        lane_id = coalesce(lane_id, ?), lane_name = coalesce(lane_name, ?), lane_project_origin = coalesce(lane_project_origin, ?),
        lane_branch = coalesce(?, lane_branch)
      where instance_id = ? and not exists (select 1 from cloud_computers where instance_id = ?)
    `).bind(
      instance.id, machineKey, instance.status, now, isMeteredStatus(instance.status) ? now : null, now,
      lane.laneId, lane.laneName, lane.projectOrigin, lane.branch,
      pendingId, instance.id,
    ),
    // The lane this computer is for has a computer again. In the adoption's
    // batch, and safe to repeat, so a create that died after it (or a replay
    // of it) can't leave the lane listed twice.
    env.DB.prepare(`
      delete from cloud_lanes_without_computer
      where (user_id, lane_id) in (select user_id, lane_id from cloud_computers where instance_id = ? and deleted_at is null and lane_id is not null)
    `).bind(instance.id),
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

/** {@link accountRules} is `paid`, as SQL on a `cloud_accounts` row. The two must say the same. */
export const PAID_RULES_SQL = "(plan = 'paid' and coalesce(stripe_status, '') <> 'past_due')";

/** `past_due` puts a paid account on free-plan rules until a paid invoice. */
export function accountRules(account: Pick<AccountRow, "plan" | "stripe_status">): "free" | "paid" {
  return account.plan === "paid" && account.stripe_status !== "past_due" ? "paid" : "free";
}

/** Which paid plan the row names (the column defaults to Plus). */
export function paidPlanOf(account: Pick<AccountRow, "paid_plan">): CloudPaidPlanId {
  return account.paid_plan === "pro" ? "pro" : "plus";
}

/** The plan whose limits are in force: `past_due` is the free plan until a paid invoice. */
export function planIdOf(account: Pick<AccountRow, "plan" | "stripe_status" | "paid_plan">): CloudPlanId {
  return accountRules(account) === "free" ? "free" : paidPlanOf(account);
}

/** The plan the person pays for, `past_due` included. */
export function boughtPlanIdOf(account: Pick<AccountRow, "plan" | "paid_plan">): CloudPlanId {
  return account.plan === "paid" ? paidPlanOf(account) : "free";
}

/** Pro and extra disk are sold only once their Stripe prices are set (`scripts/stripe-setup.mjs`). */
export function cloudOffers(env: Pick<CloudEnv, "STRIPE_PLAN_PRICE_ID" | "STRIPE_PRO_PRICE_ID" | "STRIPE_DISK_PRICE_ID" | "STRIPE_DISK_METER_EVENT">): CloudOffers {
  return {
    pro: Boolean(env.STRIPE_PLAN_PRICE_ID?.trim() && env.STRIPE_PRO_PRICE_ID?.trim()),
    extraDisk: Boolean(env.STRIPE_DISK_PRICE_ID?.trim() && env.STRIPE_DISK_METER_EVENT?.trim()),
  };
}

/**
 * On the free plan (a cancelled plan rolls to it) with more disk than the
 * free plan has: nothing pays for that disk, so its computers stay stopped
 * (only the short push-work wake) until a computer is deleted or a plan is
 * bought. A `past_due` account is not in this state: Stripe is still trying
 * the card, and its computers and timed wakes keep working.
 */
export function freePlanOverDisk(account: Pick<AccountRow, "plan">, diskGb: number): boolean {
  return account.plan === "free" && diskGb > CLOUD_PLANS.free.diskGb;
}

/**
 * The plan disk that counts for what may stay: `base`'s disk, or the next
 * plan's when a downgrade waits for the period end and has less. Grows,
 * turning extra disk off, the downgrade check and the daily limit check all
 * read it, so nothing grows into disk the next plan won't cover.
 */
export function countedPlanDiskGb(
  account: Pick<AccountRow, "plan" | "stripe_status" | "paid_plan" | "paid_plan_next">,
  base: CloudPlanId = planIdOf(account),
  next: CloudPaidPlanId | null = account.paid_plan_next,
): number {
  const baseGb = CLOUD_PLANS[base].diskGb;
  return next && base !== "free" ? Math.min(baseGb, CLOUD_PLANS[next].diskGb) : baseGb;
}

export const overPlanDiskMessage = (diskGb: number): string => overPlanDiskSentence(diskGb, CLOUD_PLANS.free.diskGb);

export function planFacts(account: Pick<AccountRow, "plan" | "stripe_status" | "paid_plan">): CloudPlanFacts {
  return CLOUD_PLANS[planIdOf(account)];
}

export function computerLimit(account: AccountRow): number {
  return planFacts(account).computerLimit;
}

/**
 * How long a move's source may stay without counting toward the disk. The
 * desktop deletes it when the files are across (at most about 45 minutes); one
 * still there after this counts again, so a move can't keep two copies free.
 */
export const MOVE_GRACE_MS = 2 * 60 * 60_000;

/**
 * SQL for the disk an account's computers hold now, as a scalar subquery for
 * the account named by `userIdSql` (a `?` or a column). A move's source is
 * left out while its move runs (`moving_from`). With `except`, it takes one
 * more `?`: an instance to leave out (a move about to start, or a computer
 * about to change size). `billable` counts only disk the provider made: a
 * create or copy not yet adopted (`pending:`) counts nothing, and a computer
 * whose grow it hasn't confirmed (`disk_reserved_at`) counts its confirmed size.
 */
export function accountDiskSql(userIdSql: string, options: { except?: boolean; billable?: boolean } = {}): string {
  const disk = options.billable ? "case when dc.disk_reserved_at is null then dc.disk_gb else coalesce(dc.disk_confirmed_gb, dc.disk_gb) end" : "dc.disk_gb";
  return `(select coalesce(sum(${disk}), 0) from cloud_computers dc where dc.user_id = ${userIdSql} and dc.deleted_at is null`
    + " and not exists (select 1 from cloud_computers dm where dm.moving_from = dc.instance_id and dm.deleted_at is null)"
    + `${options.billable ? ` and dc.instance_id not like '${PENDING_PREFIX}%'` : ""}${options.except ? " and dc.instance_id <> ?" : ""})`;
}

/** The disk `computers` (one account's, not deleted) count toward the plan; as `accountDiskSql`. */
export function countedDiskGb(computers: Pick<ComputerRow, "instance_id" | "disk_gb" | "moving_from">[]): number {
  const moving = new Set(computers.map((computer) => computer.moving_from).filter((id) => id != null));
  return computers.reduce((sum, computer) => (moving.has(computer.instance_id) ? sum : sum + computer.disk_gb), 0);
}

/** Disk the account's computers hold now, reservations included; `except` leaves one computer out. */
export async function accountDiskGb(env: CloudDb, userId: string, except = ""): Promise<number> {
  const row = await env.DB.prepare(`select ${accountDiskSql("?", { except: true })} as gb`)
    .bind(userId, except).first<{ gb: number }>();
  return row?.gb ?? 0;
}

/** Whether a disk-day written now may be billed: a paid plan in good standing, with extra disk on. */
function diskDayBillable(account: Pick<AccountRow, "plan" | "stripe_status" | "extra_disk_state" | "stripe_customer_id" | "stripe_subscription_id">): boolean {
  return accountRules(account) === "paid" && account.extra_disk_state === "on"
    && Boolean(account.stripe_customer_id && account.stripe_subscription_id);
}

export type DiskDayAccount = Pick<AccountRow, "user_id" | "plan" | "paid_plan" | "stripe_status" | "extra_disk_state" | "stripe_customer_id" | "stripe_subscription_id">;

/**
 * Raises today's peak disk for the account to what its computers hold now,
 * with the bought plan's disk and whether the day may be billed, as they are
 * now. Run once the provider has made every change that adds disk (a
 * reservation alone is never billed), after every plan change, and when a
 * move runs past `MOVE_GRACE_MS`; the daily run writes each day's starting
 * row. Extra disk is billed from these rows
 * only. A day keeps the most plan disk it saw (an upgrade raises it) and is
 * billable only if it was billable all day (a `past_due` moment, or extra
 * disk off, makes the whole day free).
 */
export function diskDayStatement(env: CloudDb, account: DiskDayAccount, now: number): D1PreparedStatement {
  return env.DB.prepare(`
    insert into cloud_disk_days (user_id, day, peak_gb, plan_gb, billable)
    values (?, ?, ${accountDiskSql("?", { billable: true })}, ?, ?)
    on conflict (user_id, day) do update set
      peak_gb = max(peak_gb, excluded.peak_gb),
      plan_gb = max(plan_gb, excluded.plan_gb),
      billable = min(billable, excluded.billable)
  `).bind(account.user_id, utcDay(now), account.user_id, CLOUD_PLANS[boughtPlanIdOf(account)].diskGb, diskDayBillable(account) ? 1 : 0);
}

/** This period's billable extra disk so far, in micros: the days already billed plus the ones not yet reported. */
export async function extraDiskMicrosThisPeriod(env: CloudDb, account: Pick<AccountRow, "user_id" | "period_start">): Promise<number> {
  const row = await env.DB.prepare(`
    select coalesce(sum(case when billable = 1 then coalesce(billed_gb, max(0, peak_gb - plan_gb)) else 0 end), 0) as gb_days
    from cloud_disk_days where user_id = ? and day >= ?
  `).bind(account.user_id, utcDay(account.period_start)).first<{ gb_days: number }>();
  return (row?.gb_days ?? 0) * EXTRA_DISK_MICROS_PER_GB_DAY;
}

/*
 * ---- Earned hours (migration 0026, `referrals.ts`) ----
 *
 * Order of use in a period: the plan's hours, then earned hours, then paid
 * extra hours. A period draws from earned hours only what it used past the
 * plan's hours and past the extra hours already billed or owed in it (a grant
 * that lands after extra hours were billed covers only what comes next, so
 * nothing is both billed and drawn). The draw is live while the period runs
 * and is settled into `earned_used_milli` when the period ends
 * (`startFreshPeriod`). Earned hours never expire.
 */

type EarnedAccount = Pick<AccountRow, "plan" | "stripe_status" | "included_milli" | "extra_reported_milli" | "extra_owed_milli" | "earned_granted_milli" | "earned_used_milli">;

/** Earned hours this period may draw from: every grant minus what ended periods drew. */
export function earnedBalanceMilli(account: Pick<AccountRow, "earned_granted_milli" | "earned_used_milli">): number {
  return Math.max(0, account.earned_granted_milli - account.earned_used_milli);
}

/** Extra hours this period already billed or owes: never drawn from earned hours. Only paid rules bill them. */
function billedExtraMilli(account: Pick<AccountRow, "plan" | "stripe_status" | "extra_reported_milli" | "extra_owed_milli">): number {
  return accountRules(account) === "paid" ? Math.max(account.extra_reported_milli, account.extra_owed_milli, 0) : 0;
}

/** What this period draws from earned hours with `liveUsed` used. */
export function earnedDrawMilli(account: EarnedAccount, liveUsed: number): number {
  const pastPlan = Math.max(0, liveUsed - account.included_milli);
  return Math.min(earnedBalanceMilli(account), Math.max(0, pastPlan - billedExtraMilli(account)));
}

/** Earned hours left now. */
export function earnedLeftMilli(account: EarnedAccount, liveUsed: number): number {
  return earnedBalanceMilli(account) - earnedDrawMilli(account, liveUsed);
}

/**
 * {@link earnedDrawMilli} as SQL on a `cloud_accounts` row with its settled
 * `used_milli`, for the statement that ends a period.
 */
const EARNED_DRAW_SQL = `min(max(0, earned_granted_milli - earned_used_milli), max(0, used_milli - included_milli - (case
  when ${PAID_RULES_SQL} then max(extra_reported_milli, extra_owed_milli, 0) else 0 end)))`;

/** The hours past the plan's that extra hours bill: what earned hours don't cover. */
export function extraUsedMilli(account: EarnedAccount, liveUsed: number): number {
  return Math.max(0, liveUsed - account.included_milli - earnedDrawMilli(account, liveUsed));
}

/** Extra hours already used: what is still billed once the switch goes off. */
export function extraOwedMilli(account: AccountRow, liveUsed: number): number {
  return Math.max(account.extra_owed_milli, extraUsedMilli(account, liveUsed), 0);
}

export function extraActive(account: AccountRow): boolean {
  return accountRules(account) === "paid" && account.extra_enabled === 1;
}

/** Live hours used in thousandths: settled plus every running stretch. */
export function liveUsedMilli(account: AccountRow, computers: ComputerRow[], now: number): number {
  return computers.reduce((sum, computer) => sum + liveMilli(computer, now), account.used_milli);
}

/** Out once the plan's hours and every earned hour are used, unless extra hours are on. */
export function isOutOfHours(account: AccountRow, liveUsed: number): boolean {
  return !extraActive(account) && liveUsed >= account.included_milli && earnedLeftMilli(account, liveUsed) <= 0;
}

/** Whole percent of the included hours used; extra hours can pass 100. */
export function percentUsed(account: AccountRow, liveUsed: number): number {
  if (account.included_milli <= 0) return 100;
  return Math.floor((liveUsed * 100) / account.included_milli);
}

/**
 * Whole percent of everything this period may use before it runs out: the
 * plan's hours and the earned hours it can draw. What the 80% and 95%
 * warnings read, so earned hours push them back.
 */
export function allowancePercentUsed(account: AccountRow, liveUsed: number): number {
  const allowance = account.included_milli + earnedBalanceMilli(account);
  if (allowance <= 0) return 100;
  return Math.floor((liveUsed * 100) / allowance);
}

export function hoursState(account: AccountRow, liveUsed: number): CloudHoursState {
  if (isOutOfHours(account, liveUsed)) return "zero";
  const percent = allowancePercentUsed(account, liveUsed);
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

/** `included: "free"`: the free plan's hours, which an account refused the free plan doesn't get (`freePlan.ts`). */
type FreshPeriod = { plan: "free" | "paid"; start: number; end: number; included: "free" | number };

/**
 * Settles what's open into the period that's ending, then starts `next`,
 * resetting warnings. What the ending period drew from earned hours is
 * settled in the same batch, once: the statement is held to the period it
 * read, so two rolls racing each other draw once. `stashEarnedDraw` keeps that
 * draw aside too, for a failed payment whose period may still be restored.
 */
async function startFreshPeriod(
  env: CloudEnv,
  account: AccountRow,
  next: FreshPeriod,
  now: number,
  alongside: D1PreparedStatement[] = [],
  options: { stashEarnedDraw?: boolean } = {},
): Promise<AccountRow> {
  const computers = await listComputers(env, account.user_id);
  const statements: D1PreparedStatement[] = [];
  for (const computer of computers) statements.push(...settleStatements(env, computer, now));
  // Open stretches restart at the boundary (a free push-work wake keeps its future start).
  statements.push(env.DB.prepare(`
    update cloud_computers set awake_since = ? where user_id = ? and awake_since is not null and awake_since <= ?
  `).bind(now, account.user_id, now));
  // After the settles above, before `used_milli` resets below; both columns read the row as it was.
  statements.push(env.DB.prepare(`
    update cloud_accounts set earned_used_milli = earned_used_milli + ${EARNED_DRAW_SQL}
      ${options.stashEarnedDraw ? `, past_due_earned_milli = ${EARNED_DRAW_SQL}` : ""}
    where user_id = ? and period_start = ?
  `).bind(account.user_id, account.period_start));
  const restored = account.warned_zero_at != null ? now : account.hours_restored_at;
  // A refusal written since `account` was read still holds: the free hours are read from the row.
  const included = next.included === "free" ? `case when free_refused_at is not null or free_github_hold is not null then 0 else ${FREE_INCLUDED_MILLI} end` : "?";
  statements.push(env.DB.prepare(`
    update cloud_accounts set plan = ?, included_milli = ${included},
      used_milli = 0, period_start = ?, period_end = ?,
      warned_80_at = null, warned_95_at = null, warned_zero_at = null, hours_restored_at = ?, updated_at = ?
    where user_id = ?
  `).bind(next.plan, ...(next.included === "free" ? [] : [next.included]), next.start, next.end, restored, now, account.user_id));
  // One batch: a retry decides from these columns, so half of a change could never be finished.
  await env.DB.batch([...statements, ...alongside]);
  const after = await env.DB.prepare("select earned_used_milli, past_due_earned_milli, included_milli from cloud_accounts where user_id = ?")
    .bind(account.user_id).first<Pick<AccountRow, "earned_used_milli" | "past_due_earned_milli" | "included_milli">>();
  // The batch just wrote this row.
  if (!after) throw new Error("cloud account row missing after a period start");
  return {
    ...account,
    plan: next.plan,
    included_milli: after.included_milli,
    earned_used_milli: after.earned_used_milli,
    past_due_earned_milli: after.past_due_earned_milli,
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
  const rolled = await startFreshPeriod(env, account, { plan: nextPlan, start: period.start, end: period.end, included: "free" }, now, cancelled ? [
    env.DB.prepare("update cloud_accounts set cancel_at_period_end = 0, extra_enabled = 0, extra_disk_state = 'off', stripe_status = null, updated_at = ? where user_id = ?").bind(now, account.user_id),
  ] : []);
  return cancelled ? { ...rolled, cancel_at_period_end: 0, extra_enabled: 0, extra_disk_state: "off", stripe_status: null } : rolled;
}

export type CloudPlanChange = {
  plan?: "free" | "paid";
  /** Which paid plan the subscription's plan item is. */
  paidPlan?: CloudPaidPlanId;
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
  state: { nextPlan: "free" | "paid"; nextPaidPlan: CloudPaidPlanId; wasPastDue: boolean; isPastDue: boolean; now: number },
): PlanTransition | null {
  const { nextPlan, nextPaidPlan, wasPastDue, isPastDue, now } = state;
  const paidIncluded = CLOUD_PLANS[nextPaidPlan].includedMilli;
  const free = freePeriodFor(now);
  if (!wasPastDue && isPastDue && account.plan === "paid") {
    return { kind: "past_due", next: { plan: "paid", start: free.start, end: free.end, included: "free" } };
  }
  if (wasPastDue && !isPastDue && nextPlan === "paid") {
    const stashEnd = account.past_due_period_end;
    const end = change.periodEnd ?? stashEnd ?? free.end;
    return stashEnd != null && stashEnd > now && end === stashEnd
      ? { kind: "restored_same_period", next: { plan: "paid", start: change.periodStart ?? account.period_start, end, included: paidIncluded } }
      : { kind: "restored_new_period", next: { plan: "paid", start: change.periodStart ?? now, end, included: paidIncluded } };
  }
  if (account.plan === "free" && nextPlan === "paid") {
    return { kind: "to_paid", next: { plan: "paid", start: change.periodStart ?? now, end: change.periodEnd ?? free.end, included: paidIncluded } };
  }
  if (account.plan === "paid" && nextPlan === "free") {
    return { kind: "to_free", next: { plan: "free", start: free.start, end: free.end, included: "free" } };
  }
  if (nextPlan === "paid" && change.periodStart !== undefined && change.periodStart !== account.period_start && !isPastDue) {
    return { kind: "renewal", next: { plan: "paid", start: change.periodStart, end: change.periodEnd ?? account.period_end, included: paidIncluded } };
  }
  return null;
}

/**
 * The one place a plan changes; the Stripe webhook calls this. Fields left out
 * keep their value. Free to paid and paid to free each start fresh hours, a
 * renewal (a new `periodStart`) starts the plan's fresh hours, `past_due`
 * drops to free rules with fresh hours and turns extra hours off, and a later
 * paid invoice restores what the account had used if the same period is still
 * running. Plus to Pro gives Pro's hours now and keeps the hours used; Pro to
 * Plus waits for the next period (`paid_plan_next`).
 */
export async function applyCloudPlanChange(env: CloudEnv, userId: string, change: CloudPlanChange, now = Date.now()): Promise<AccountRow> {
  const account = await loadAccount(env, userId, now);
  const nextPlan = change.plan ?? account.plan;
  const nextStripeStatus = change.stripeStatus === undefined ? account.stripe_status : change.stripeStatus;
  const wasPastDue = account.stripe_status === "past_due";
  const isPastDue = nextStripeStatus === "past_due";
  const currentPaidPlan = paidPlanOf(account);
  const requestedPaidPlan = change.paidPlan ?? currentPaidPlan;
  // Pro to Plus waits for the next period: the person paid for Pro's hours and limits until then.
  const newPeriod = change.periodStart !== undefined && change.periodStart !== account.period_start;
  const deferDowngrade = account.plan === "paid" && nextPlan === "paid" && !wasPastDue && !isPastDue
    && currentPaidPlan === "pro" && requestedPaidPlan === "plus" && !newPeriod;
  const nextPaidPlan: CloudPaidPlanId = deferDowngrade ? "pro" : requestedPaidPlan;
  /** A new billing period: nothing is reported or owed in it yet. */
  const clearExtraReports: Array<[keyof AccountRow, unknown]> = [["extra_reported_milli", 0], ["extra_owed_milli", 0]];

  const extras: Array<[keyof AccountRow, unknown]> = [];
  if (change.stripeCustomerId !== undefined) extras.push(["stripe_customer_id", change.stripeCustomerId]);
  if (change.stripeSubscriptionId !== undefined) extras.push(["stripe_subscription_id", change.stripeSubscriptionId]);
  if (change.stripeStatus !== undefined) extras.push(["stripe_status", change.stripeStatus]);
  if (change.cancelAtPeriodEnd !== undefined) extras.push(["cancel_at_period_end", change.cancelAtPeriodEnd ? 1 : 0]);
  if (nextPaidPlan !== account.paid_plan) extras.push(["paid_plan", nextPaidPlan]);
  if (deferDowngrade) {
    if (account.paid_plan_next !== "plus") extras.push(["paid_plan_next", "plus"]);
  } else if ((change.paidPlan !== undefined || nextPlan === "free") && account.paid_plan_next != null) {
    // The new period began, the person went back to Pro, or the plan ended.
    extras.push(["paid_plan_next", null]);
  }

  const transition = planTransition(account, change, { nextPlan, nextPaidPlan, wasPastDue, isPastDue, now });
  if (transition?.kind === "past_due") {
    // Read before the fresh start replaces them: a later paid invoice restores these.
    const stashUsed = liveUsedMilli(account, await listComputers(env, userId), now);
    const stashPeriodEnd = change.periodEnd ?? account.period_end;
    // Extra hours go off here, but what was already used is still owed.
    const owed = extraActive(account) ? extraOwedMilli(account, stashUsed) : account.extra_owed_milli;
    extras.push(["past_due_used_milli", stashUsed], ["past_due_period_end", stashPeriodEnd], ["extra_enabled", 0], ["extra_owed_milli", owed]);
  }
  const updates: D1PreparedStatement[] = [];
  switch (transition?.kind) {
    case "restored_same_period":
      updates.push(env.DB.prepare("update cloud_accounts set used_milli = ? where user_id = ?").bind(account.past_due_used_milli ?? 0, userId));
      // The restored hours draw from earned hours again when this period ends, so what the cut drew comes back.
      updates.push(env.DB.prepare("update cloud_accounts set earned_used_milli = max(0, earned_used_milli - coalesce(past_due_earned_milli, 0)), past_due_earned_milli = null where user_id = ?").bind(userId));
      extras.push(["past_due_used_milli", null], ["past_due_period_end", null], ["billing_restored_at", now]);
      break;
    case "restored_new_period":
      extras.push(...clearExtraReports, ["past_due_used_milli", null], ["past_due_period_end", null], ["past_due_earned_milli", null], ["billing_restored_at", now]);
      break;
    case "to_paid":
    case "renewal":
      extras.push(...clearExtraReports);
      break;
    case "to_free":
      // Bought again later, extra disk asks again.
      extras.push(["extra_enabled", 0], ["extra_disk_state", "off"]);
      break;
  }
  // Plus to Pro or back inside a running period (no new period start): the
  // hours used stay, and the plan's hours change now. An upgrade at 0 hours
  // gives hours back, so the warnings start over.
  if (!transition && nextPlan === "paid" && account.plan === "paid" && !isPastDue && nextPaidPlan !== account.paid_plan) {
    const included = CLOUD_PLANS[nextPaidPlan].includedMilli;
    extras.push(["included_milli", included]);
    if (included > account.included_milli) {
      extras.push(["warned_80_at", null], ["warned_95_at", null], ["warned_zero_at", null]);
      if (account.warned_zero_at != null) extras.push(["hours_restored_at", now]);
    }
  }

  if (change.extraEnabled !== undefined && nextPlan === "paid" && !isPastDue) extras.push(["extra_enabled", change.extraEnabled ? 1 : 0]);
  if (extras.length) {
    const sets = extras.map(([column]) => `${column} = ?`).join(", ");
    updates.push(env.DB.prepare(`update cloud_accounts set ${sets}, updated_at = ? where user_id = ?`)
      .bind(...extras.map(([, value]) => value), now, userId));
  }
  if (transition) await startFreshPeriod(env, account, transition.next, now, updates, { stashEarnedDraw: transition.kind === "past_due" });
  else if (updates.length) await env.DB.batch(updates);
  const after = (await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>()) ?? account;
  // Today's disk-day follows the plan as it is now: an upgrade raises its plan disk, `past_due` makes it unbillable.
  if (transition || nextPaidPlan !== account.paid_plan || nextStripeStatus !== account.stripe_status) {
    await diskDayStatement(env, after, now).run();
  }
  return after;
}

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
