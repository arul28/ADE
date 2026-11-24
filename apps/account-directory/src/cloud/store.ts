import * as Sentry from "@sentry/cloudflare";
import { PHONE_CREDIT_MILLI_AT_SQL } from "./credits";
import type { CallerTokenEnv } from "../callerToken";
import { cloudflareTransientKindOfText } from "../cloudflareTransient";
import { CLOUD_INTEGRATION_REQUESTS_PER_MINUTE, type CloudExtraDiskState, type CloudHoursState, type CloudInstance, type CloudPlanId } from "./contract";
import { readClerkUser, type CloudEmailEnv } from "./email";
import {
  CLOUD_PLANS,
  FREE_INCLUDED_MILLI,
  PAID_PLAN_RANK,
  computeCostMicrosFor,
  isPaidPlanId,
  usesHours,
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
import { machineCopiesGoneStatements } from "../accountProjects/store";

/**
 * The computers and accounts in D1, and the one place that moves hours. Live
 * hours are `used_milli` plus the open stretches in `cloud_computers`, so a
 * tick writes only when something changed.
 */

export type CloudEnv = CallerTokenEnv & CloudEmailEnv & {
  DB: D1Database;
  AGENT37_API_KEY?: string;
  /** Secret. The provider's status webhook signing secret (`whsec_…`, `computerStatus.ts`). Unset: the webhook answers 503. */
  AGENT37_WEBHOOK_SECRET?: string;
  /** `1`: ADE Cloud makes no new computers or launches (the owner's kill switch); existing computers keep working. */
  CLOUD_CREATES_PAUSED?: string;
  /** Secret. The bearer of the owner's block and unblock routes (`safety.ts`). Unset: those routes answer 503. */
  CLOUD_OWNER_TOKEN?: string;
  /** Secret. NoMac's account key (`nmk_…`) for the ADE Cloud iPhone (`phoneNomac.ts`). Unset: the phone answers `off`. */
  NOMAC_API_KEY?: string;
  /** Secret. NoMac's embed secret (`nme_…`): signs each view link for its account alone. Unset: the link alone is the permission. */
  NOMAC_EMBED_SECRET?: string;
  /** Secret. Signs NoMac's webhook deliveries (`/cloud/nomac/webhook`). Unset: the webhook answers 503 and the ten-minute check settles phones alone. */
  NOMAC_WEBHOOK_SECRET?: string;
  /** Secret. ADE's Revyl partner key for the ADE Cloud iPhone on Revyl (`phoneRevyl.ts`). Unset: no phone starts on Revyl. */
  REVYL_PARTNER_API_KEY?: string;
  /** The highest the `cloud_credits` setting may go (`credits.ts`): `off` (default, a hard off), `testers` or `all`. */
  CLOUD_CREDITS?: string;
  /** The owner's switch for Revyl: `on` lets new phones start there (with the key set). Unset or anything else: NoMac only (`revylEnabled`). */
  CLOUD_PHONE_REVYL?: string;
  /** Who may use the ADE Cloud iPhone: `beta` (default, the owner's list), `all`, or `off` (`phones.ts`). */
  CLOUD_PHONE_ACCESS?: string;
  /** `1`: no new ADE Cloud iPhones (running ones finish). */
  CLOUD_PHONES_PAUSED?: string;
  /** Extra iPhone minutes' metered price and meter (`phoneBilling.ts`). Unset: extra minutes aren't sold. */
  STRIPE_PHONE_MINUTE_PRICE_ID?: string;
  STRIPE_PHONE_METER_EVENT?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PLAN_PRICE_ID?: string;
  /** The older name of the first extra-hours price: a Worker secret in production, so `STRIPE_EXTRA_HOURS_PRICE_ID` (a var) wins. */
  STRIPE_EXTRA_PRICE_ID?: string;
  /**
   * The extra-hours price before Cloud 7 (1 cent, 0.85 after 1,000 hours).
   * Subscriptions that hold it keep it until their next renewal or plan
   * change; it is also what a plan without its own price below uses.
   */
  STRIPE_EXTRA_HOURS_PRICE_ID?: string;
  /** Each paid plan's own extra-hours price, all on the one hours meter (`scripts/stripe-setup.mjs`). */
  STRIPE_EXTRA_HOURS_PLUS_PRICE_ID?: string;
  STRIPE_EXTRA_HOURS_PRO_PRICE_ID?: string;
  STRIPE_EXTRA_HOURS_MAX_PRICE_ID?: string;
  /**
   * Extra-hours prices a plan no longer sells (comma-separated), so a
   * subscription that still holds one is known to have its extra-hours item:
   * a renewal moves it to the plan's price, and turning extra hours on adds
   * no second item on the hours meter. Add a plan's old id here whenever a
   * `scripts/stripe-setup.mjs` rerun replaces it.
   */
  STRIPE_EXTRA_HOURS_RETIRED_PRICE_IDS?: string;
  STRIPE_METER_EVENT?: string;
  /** Pro's monthly price (`scripts/stripe-setup.mjs`). Unset: only Plus can be bought. */
  STRIPE_PRO_PRICE_ID?: string;
  /** Max's monthly price. Unset (or Pro unset): Max isn't sold. */
  STRIPE_MAX_PRICE_ID?: string;
  /** Extra disk's metered price and meter, from before Pricing v2. Unread: extra disk is no longer sold. */
  STRIPE_DISK_PRICE_ID?: string;
  STRIPE_DISK_METER_EVENT?: string;
  /** The billing portal setup (card, cancel at period end, invoices). */
  STRIPE_PORTAL_CONFIG_ID?: string;
  /** A clean https origin on this Worker for Stripe's return pages (`https://account.ade-app.dev`). Unset: the request's own origin. */
  BILLING_RETURN_ORIGIN?: string;
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
  /** When an owner's block cut it off the internet (migration 0037, `safety.ts`); null again on unblock. */
  network_denied_at?: number | null;
  /** The last try at that policy, landed or not (migration 0037). */
  network_deny_tried_at?: number | null;
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
  /** `freed`, `inactive`, `idle_cleanup` or `plan_limit` while a delete that keeps the lane runs: closing the row writes the lane's row. */
  lane_keep_reason?: string | null;
  /** Use facts (migration 0022, `diskUsage.ts`): the last disk measure, as JSON, and when it was taken. */
  disk_usage_json?: string | null;
  disk_measured_at?: number | null;
  /** When the computer last did work, as it reported at its idle step. */
  last_active_at?: number | null;
  /** Its lane's work (`CloudLaneWork`), as JSON. */
  lane_work_json?: string | null;
  /** Idle cleanup (migration 0034, `idleCleanup.ts`): the warning, the delete time it announced, the last email. */
  idle_warned_at?: number | null;
  idle_deletes_at?: number | null;
  idle_emailed_at?: number | null;
  /** The person pressed "Keep it": the idle clock restarts here. */
  idle_kept_at?: number | null;
  /** A save-and-delete run in flight. */
  idle_claimed_at?: number | null;
  /** That run's claim to delete, taken just before the provider delete; "Keep it" is refused after it. */
  idle_deleting_at?: number | null;
  /** The save didn't go through, so the computer was kept: when, and why. */
  idle_held_at?: number | null;
  idle_held_reason?: string | null;
  /** Saves that failed in a row this idle stretch: the next try waits longer each time. */
  idle_held_count?: number | null;
  /** A run that failed after or outside the save (a refused delete): tried again after a wait. */
  idle_failed_at?: number | null;
  idle_failed_count?: number | null;
  /** Files git ignores that a delete would lose (`CloudIgnoredFiles` as JSON). */
  ignored_files_json?: string | null;
  /** The ADE version of its last brain start (migration 0039, `POST .../booted`). */
  ade_version?: string | null;
  ade_version_at?: number | null;
  /** Comma list of `CLOUD_COMPUTER_FEATURES` from the last boot report; null: an older image. */
  ade_features?: string | null;
  /** The computer's last lane backup report (migration 0044, `laneBackups.ts`). */
  backup_report_id?: string | null;
  backup_report_state?: string | null;
  backup_report_at?: number | null;
  backup_problems_json?: string | null;
  /** It went to rest right after a report that saved every lane; any wake clears it. */
  backup_rest_at?: number | null;
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
  /** Unused since Pricing v2 (extra disk is no longer sold). */
  extra_disk_over_limit_at: number | null;
  /** Earned hours (migration 0026, `referrals.ts`): every grant, recomputed from `cloud_earned_hours`. */
  earned_granted_milli: number;
  /** What ended periods drew from earned hours. The balance is granted minus this. */
  earned_used_milli: number;
  /** What the period a failed payment cut short drew from earned hours, given back if that period is restored. */
  past_due_earned_milli: number | null;
  /** Refused the free plan: its computer already gave another account free hours (`freePlan.ts`). Free hours are 0 while set. */
  free_refused_at: number | null;
  /**
   * The ADE Cloud iPhone (migration 0048, `phones.ts`): extra minutes and the
   * minutes warnings. Absent before the migration. `phone_extra_enabled` is
   * one of `PHONE_EXTRA` (on, off, or was on until the plan ended).
   */
  phone_extra_enabled?: number;
  phone_extra_limit_cents?: number | null;
  phone_extra_reported_minutes?: number;
  phone_extra_owed_minutes?: number;
  phone_extra_period_start?: number | null;
  /** The plan's iPhone minutes in that period, for its bill after it ends (`phoneBilling.ts`). */
  phone_extra_included?: number | null;
  phone_warned_80_at?: number | null;
  phone_warned_zero_at?: number | null;
  phone_warned_period_start?: number | null;
  /** A phone start whose answer was lost: the provider and when (migration 0057, `heldToUnsureStart`). */
  phone_start_unsure?: string | null;
  phone_start_unsure_at?: number | null;
  /** When the ADE account was created (Clerk), for the invite code's 30-day window. */
  account_created_at: number | null;
  /** Unused since Pricing v2 (Cloud 7's old plan terms, migration 0033): every new period writes 0. */
  old_plan_terms?: number | null;
  /** Unused since Pricing v2 (migration 0033). */
  old_terms_told_at?: number | null;
  /** Unused since Pricing v2: extra disk is no longer sold (migration 0033). */
  extra_disk_old_price?: number | null;
  /** The hours of the paid period a failed payment cut short, restored with it (`restored_same_period`; migration 0033). */
  past_due_included_milli?: number | null;
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
  /**
   * The account test tool (migration 0056, `ownerAccounts.ts`): the plan the
   * account acts as and its own limits, for testing. Limits, the hours meter
   * and sponsored cards read them; billing never does. Absent before the
   * migration; all null for the real plan.
   */
  test_plan?: string | null;
  test_computers?: number | null;
  test_hours_milli?: number | null;
  /** The iPhone minutes its phone limits count instead of the plan's (migration 0058); billing never reads it. */
  test_phone_minutes?: number | null;
  test_until?: number | null;
  test_note?: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
};

export function logCloud(event: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-account-directory", kind: event, ...meta }));
}

/** `logCloud` at warn: something an owner should see in the Worker's logs. */
export function warnCloud(event: string, meta: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), svc: "ade-account-directory", kind: event, level: "warn", ...meta }));
}

/** Requests one account may make in a minute, per bucket (`takeRequest`). */
const REQUESTS_PER_MINUTE = {
  /** Linear and Jira, with the account's own credentials (`integrations.ts`). */
  integrations: CLOUD_INTEGRATION_REQUESTS_PER_MINUTE,
  /**
   * A computer's saved copies: shell and CLI copies, Git summaries, fork
   * capsule parts and commits. A delete's save sends one capsule per chat,
   * four at a time, from every computer of the account; this stops a loop,
   * never a real save.
   */
  uploads: 1_200,
  /** Agent limits, event-wake topics and the account lane index. */
  settings: 120,
  /** Sponsored cards and the Index (`gravity.ts`): a few per finished reply and open chat; this stops a loop. */
  sponsored: 30,
} as const;

export type CloudRequestBucket = keyof typeof REQUESTS_PER_MINUTE;

/**
 * Counts one request against the account's minute for `bucket`. True when it
 * is within the bucket's limit. One row per account and bucket
 * (`cloud_request_windows`); a new minute resets it.
 */
export async function takeRequest(env: CloudDb, userId: string, bucket: CloudRequestBucket, now: number): Promise<boolean> {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const row = await env.DB.prepare(`
    insert into cloud_request_windows (user_id, bucket, window_start, count) values (?, ?, ?, 1)
    on conflict (user_id, bucket) do update set
      count = case when cloud_request_windows.window_start = excluded.window_start then cloud_request_windows.count + 1 else 1 end,
      window_start = excluded.window_start
    returning count
  `).bind(userId, bucket, windowStart).first<{ count: number }>();
  if ((row?.count ?? 1) <= REQUESTS_PER_MINUTE[bucket]) return true;
  // Once a minute per bucket, at the first refused request.
  if (row?.count === REQUESTS_PER_MINUTE[bucket] + 1) logCloud("cloud.rate_limited", { bucket });
  return false;
}

/** One Sentry issue per failure kind and isolate an hour: these repeat each tick while the cause lasts. */
const FAILURE_REPORT_INTERVAL_MS = 60 * 60_000;
const lastFailureReport = new Map<string, number>();

/** A JSON column of a launch row, or `fallback` when it is empty or unreadable (reported). */
export function parseJsonColumn<T>(text: string | null, fallback: T, where: { launchId: string; column: string }): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    reportCloudFailure("cloud.launch_column_unreadable", { ...where, message: error instanceof Error ? error.message : "unknown" });
    return fallback;
  }
}

/**
 * {@link logCloud} for a failure that's ADE's to fix: the line stays local, the event name reaches Sentry.
 * `area` tags the Sentry issue (`cloud`, `cloud-referrals`, `cloud-free-plan`) so alert rules can pick one.
 */
export function reportCloudFailure(event: string, meta: Record<string, unknown> = {}, area = "cloud"): void {
  // Cloudflare's own short failure (D1 overloaded, a storage reset): the next
  // tick or request runs it again. A burst fails every sweep of a tick at
  // once, which was one Sentry issue per sweep; now all of them share one
  // issue per kind, so a short burst is one event and an outage that lasts
  // still shows (once an hour per isolate).
  const transient = typeof meta.message === "string" ? cloudflareTransientKindOfText(meta.message) : null;
  logCloud(event, transient ? { ...meta, transient } : meta);
  const throttleKey = transient ? `cloudflare-transient:${transient}` : event;
  const now = Date.now();
  if (now - (lastFailureReport.get(throttleKey) ?? 0) < FAILURE_REPORT_INTERVAL_MS) return;
  lastFailureReport.set(throttleKey, now);
  if (transient) {
    Sentry.captureMessage(`Cloudflare transient: ${transient}`, {
      level: "warning",
      fingerprint: ["cloudflare-transient", transient],
      tags: { area, transient, failure_event: event },
    });
    return;
  }
  // The event name, plus the closed codes that say which failure it was:
  // `meta` also carries account and instance ids and free text, which stay in the log.
  Sentry.captureMessage(event, { level: "warning", fingerprint: [event], tags: { area, ...failureCodeTags(meta) } });
}

/** `meta` fields that hold a closed code (`provider_timeout`, `push`, `free`), never an id or a sentence. */
const FAILURE_CODE_TAG_KEYS = ["code", "kind", "step", "reason"] as const;
const FAILURE_CODE_VALUE = /^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/;

function failureCodeTags(meta: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const key of FAILURE_CODE_TAG_KEYS) {
    const value = meta[key];
    if (typeof value === "string" && FAILURE_CODE_VALUE.test(value)) tags[`failure_${key}`] = value;
  }
  return tags;
}

/**
 * Abuse the owner should see: logged, sent to Sentry at error level every
 * time (no hourly throttle: each one is its own event), and saved as a
 * `cloud_abuse_events` row for the account. `detail` holds counts and closed
 * codes, never a secret. Never throws: a failed write is reported and the caller goes on.
 */
export async function reportCloudAbuse(env: CloudDb, kind: string, userId: string | null, detail: Record<string, unknown> = {}, now = Date.now()): Promise<void> {
  logCloud(`cloud.abuse.${kind}`, { userId, ...detail });
  // Only the kind: the account id stays in the log line and the row.
  Sentry.captureMessage(`cloud.abuse.${kind}`, { level: "error", fingerprint: ["cloud.abuse", kind], tags: { area: "cloud-abuse" } });
  try {
    await env.DB.prepare("insert into cloud_abuse_events (user_id, kind, detail_json, created_at) values (?, ?, ?, ?)")
      .bind(userId, kind, JSON.stringify(detail), now).run();
  } catch (error) {
    reportCloudFailure("cloud.abuse_event_write_failed", { kind, message: error instanceof Error ? error.message : "unknown" });
  }
}

/** A reservation with no computer behind it after this long is given up on. */
export const PENDING_TIMEOUT_MS = 15 * 60_000;
/**
 * What the awake cap counts (`AWAKE_COMPUTER_CAP`): awake, on its way there
 * (`waking`, `starting`), or a reservation still being made. One on its way
 * counts only for `PENDING_TIMEOUT_MS` after it started (the tick reads the
 * provider's status meanwhile), so a lost wake never holds a slot. Binds one
 * `?`, that cutoff (`now - PENDING_TIMEOUT_MS`). Shared by the wake and create
 * checks (`routes.ts`) and the timed wakes (`cloudWake.ts`), so they all
 * count the same computers.
 */
export const AWAKE_CAP_COUNT_SQL = "(status in ('running', 'restarting', 'updating') or (status in ('provisioning', 'waking', 'starting') and (case when status = 'provisioning' then created_at else status_changed_at end) > ?))";
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

/**
 * Where a saved copy moves from `fromMachineKey` to the person's own machine
 * `toMachineKey` with no ADE Cloud computer asking (a kept lane moved to
 * their computer), or why it may not. Everything is read under the caller's
 * own account, so another account's keys answer `not_found`:
 *
 * - the destination is one of the account's machines (signed in, not
 *   revoked) and no ADE Cloud computer's key (a computer moves a copy with
 *   its `instanceId`);
 * - the source is a deleted ADE Cloud computer's key: no live computer of the
 *   account has it, and a deleted one does. A live computer's copies stay
 *   with it.
 *
 * The match is case-insensitive, and the answer is the key as the account
 * registered it: every later read matches the key exactly, so the move
 * writes that spelling.
 */
export async function ownMachineMoveTarget(
  env: CloudDb,
  userId: string,
  fromMachineKey: string,
  toMachineKey: string,
): Promise<{ ok: true; machineKey: string } | { ok: false; code: "not_found" | "wrong_machine" | "computer_exists"; message: string; status: number }> {
  const [machine, revoked, cloudTarget, source] = await Promise.all([
    env.DB.prepare("select machine_key from machines where user_id = ? and lower(machine_key) = lower(?) limit 1").bind(userId, toMachineKey).first<{ machine_key: string }>(),
    env.DB.prepare("select 1 as n from revoked_machines where user_id = ? and lower(machine_key) = lower(?) limit 1").bind(userId, toMachineKey).first<{ n: number }>(),
    env.DB.prepare("select 1 as n from cloud_computers where user_id = ? and lower(machine_key) = lower(?) limit 1").bind(userId, toMachineKey).first<{ n: number }>(),
    env.DB.prepare(`
      select coalesce(sum(case when deleted_at is null then 1 else 0 end), 0) as live,
        coalesce(sum(case when deleted_at is not null then 1 else 0 end), 0) as gone
      from cloud_computers where user_id = ? and lower(machine_key) = lower(?)
    `).bind(userId, fromMachineKey).first<{ live: number; gone: number }>(),
  ]);
  if (!machine || revoked) return { ok: false, code: "not_found", message: "ADE doesn't know that machine of yours.", status: 404 };
  if (cloudTarget) return { ok: false, code: "wrong_machine", message: "An ADE Cloud computer moves a saved copy to itself with its own id.", status: 409 };
  if ((source?.live ?? 0) > 0) return { ok: false, code: "computer_exists", message: "This copy's ADE Cloud computer still exists: move the chat from it instead.", status: 409 };
  if ((source?.gone ?? 0) === 0) return { ok: false, code: "not_found", message: "That saved copy isn't on a deleted ADE Cloud computer.", status: 404 };
  return { ok: true, machineKey: machine.machine_key };
}

/** A queued message to a chat that moves to the person's own machine: no computer drains it there, so it ends as failed and keeps its text. */
export const MOVED_TO_OWN_MACHINE_MESSAGE_ERROR = "This chat moved to your computer before ADE Cloud sent this message. Send it again there.";

/**
 * The queued messages of a moved chat or CLI follow it to `toMachineKey`.
 * To an ADE Cloud computer (`instanceId`), its queue drains them. The
 * person's own machine drains no queue, so a message still queued there
 * ends as failed with `MOVED_TO_OWN_MACHINE_MESSAGE_ERROR` (its text stays,
 * so the person can send it again). A message that rides a launch keeps
 * its launch. `onlyIf`: a condition the move's own batch holds (its claim
 * of the source), so a move that lost re-keys nothing.
 */
export function moveQueuedMessagesStatement(
  env: CloudDb,
  args: { userId: string; fromMachineKey: string; toMachineKey: string; chatId: string; instanceId: string | null; now: number; onlyIf?: { sql: string; binds: Array<string | number> } },
): D1PreparedStatement {
  const { userId, fromMachineKey, toMachineKey, chatId, instanceId, now } = args;
  const onlyIf = args.onlyIf ? ` and ${args.onlyIf.sql}` : "";
  const onlyIfBinds = args.onlyIf?.binds ?? [];
  if (instanceId) {
    return env.DB.prepare(`
      update cloud_chat_messages set machine_key = ?, instance_id = case when via_launch = 0 and state = 'queued' then ? else instance_id end
      where user_id = ? and machine_key = ? and chat_id = ?${onlyIf}
    `).bind(toMachineKey, instanceId, userId, fromMachineKey, chatId, ...onlyIfBinds);
  }
  return env.DB.prepare(`
    update cloud_chat_messages set machine_key = ?,
      state = case when via_launch = 0 and state = 'queued' then 'failed' else state end,
      error = case when via_launch = 0 and state = 'queued' then ? else error end,
      updated_at = case when via_launch = 0 and state = 'queued' then ? else updated_at end
    where user_id = ? and machine_key = ? and chat_id = ?${onlyIf}
  `).bind(toMachineKey, MOVED_TO_OWN_MACHINE_MESSAGE_ERROR, now, userId, fromMachineKey, chatId, ...onlyIfBinds);
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
    // The stretch is stamped with the account's plan as it is now: run on free-plan rules, its cost also counts as free use (the owner's cap).
    statements.push(env.DB.prepare(`
      insert into cloud_computer_days (instance_id, day, user_id, metered_ms, metered_milli, multiplier_milli, cost_micros, free_cost_micros)
      select ?, ?, ?, ?, ?, ?, ?, ${freeShareSql("?", "?")}
      where ${guard ? guard.sql : "1"}
      on conflict (instance_id, day) do update set
        metered_ms = metered_ms + excluded.metered_ms,
        metered_milli = metered_milli + excluded.metered_milli,
        multiplier_milli = excluded.multiplier_milli,
        cost_micros = cost_micros + excluded.cost_micros,
        free_cost_micros = free_cost_micros + excluded.free_cost_micros
    `).bind(computer.instance_id, day, computer.user_id, ms, milli, computer.multiplier_milli, costMicros, computer.user_id, costMicros, ...(guard?.binds ?? [])));
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

/** The free time of a closing stretch (an automatic update's window), so the daily reconcile doesn't charge it. */
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
/** As long as the idle cleanup's claim holds (`CLAIM_STALE_MS` in idleCleanup.ts): a claim older than this died with its request. */
export const SAVED_DELETE_CLAIM_STALE_MS = 20 * 60_000;

/**
 * A wake's side of the delete claim (`claimSavedDelete`, the idle cleanup's
 * `claimDelete`): one conditional write, read fresh in D1, that holds only
 * while no delete claims the row, and that clears the backups it rested with,
 * which every delete claim needs. Of a wake and a delete claim at once,
 * exactly one write passes: a claim first refuses the wake here, and a wake
 * first makes the claim fail. It clears the report too, as a wake's status
 * write does, so a Sleep that saved before this wake can't mark the computer
 * resting with that report after it (`markRestedWithBackups` needs the
 * report). False when a delete holds the computer. A start that then fails
 * leaves the computer resting not saved; its next sleep saves it. Every
 * path that starts a resting computer takes it first: a person's wake, an
 * event wake, a resize, a free's and a move's wake (`frees.ts`, `moves.ts`).
 */
export async function takeFromDeletes(env: CloudEnv, instanceId: string, now: number): Promise<boolean> {
  const taken = await env.DB.prepare(`
    update cloud_computers set backup_rest_at = null, backup_report_state = null, backup_report_id = null
    where instance_id = ? and deleted_at is null and (idle_deleting_at is null or idle_deleting_at < ?)
  `).bind(instanceId, now - SAVED_DELETE_CLAIM_STALE_MS).run();
  return (taken.meta?.changes ?? 0) === 1;
}

/**
 * The account's machine row for a cloud computer that just named its account
 * key takes the computer's name, unless a name was set on it already (the
 * person's, or a move's or copy's). A computer the server made (a launch from
 * the phone or the web) otherwise lists under its instance id: its ADE names
 * its row for its host, and only the desktop renamed it after the sign-in.
 */
export function nameMachineAfterComputerStatement(env: CloudEnv, computer: Pick<ComputerRow, "user_id" | "name">, machineKey: string): D1PreparedStatement | null {
  const name = computer.name?.trim();
  if (!name) return null;
  return env.DB.prepare("update machines set custom_name = ? where user_id = ? and machine_key = ? and custom_name is null").bind(name, computer.user_id, machineKey);
}

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
    // A free wake that didn't count as use (an automatic update's window) leaves
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
    // Awake, its lanes can change: the backups it rested with are not current any more.
    statements.push(clearBackupRestStatement(env, computer.instance_id));
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

/**
 * A computer that wakes may change its lanes, so the backup report it rested
 * with is no longer current (`laneBackups.ts`). Every path that starts a
 * computer runs this with its status write.
 */
export function clearBackupRestStatement(env: CloudDb, instanceId: string): D1PreparedStatement {
  return env.DB.prepare("update cloud_computers set backup_rest_at = null, backup_report_state = null, backup_report_id = null where instance_id = ?").bind(instanceId);
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

/** A launch whose computer was deleted before it finished: it ends with this error, and Retry makes a new computer. */
export const LAUNCH_COMPUTER_DELETED = "This launch's ADE Cloud computer was deleted before it finished. Retry makes a new one.";

/** Settles an open stretch and marks the computer deleted, for after the provider's delete. */
export function markDeletedStatements(env: CloudDb, computer: ComputerRow, now: number): D1PreparedStatement[] {
  // Guarded: two deletes of one computer charge its last stretch once.
  const statements = settleStatements(env, computer, now, statusGuard(computer));
  computer.awake_since = null;
  computer.deleted_at = now;
  // The disk breakdown, the lane's work (branch names, pull request state), the lane's facts, the
  // ignored file names and the backup report (lane names) go with the computer.
  statements.push(env.DB.prepare(`
    update cloud_computers set deleted_at = ?, awake_since = null, status = 'deleted', status_changed_at = ?, disk_usage_json = null, lane_work_json = null,
      lane_id = null, lane_name = null, lane_project_origin = null, lane_branch = null, lane_keep_reason = null,
      idle_held_reason = null, ignored_files_json = null,
      backup_report_id = null, backup_report_state = null, backup_report_at = null, backup_problems_json = null, backup_rest_at = null
    where instance_id = ?
  `).bind(now, now, computer.instance_id));
  // Its unfinished launch ends too, or the web and phone list it as running for good.
  // Not a Retry in flight ('retrying'): that launch is getting a new computer.
  statements.push(env.DB.prepare(`
    update cloud_launches set state = 'failed', error = ?, updated_at = ?
    where instance_id = ? and state in ('making', 'joining', 'needs_approval', 'joined', 'waiting_for_sign_in', 'running')
  `).bind(LAUNCH_COMPUTER_DELETED, now, computer.instance_id));
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
    ...forgetMachineStatements(env, computer, now),
    // The topics that woke it at rest and its last event wake (`eventWakes.ts`) go with it.
    env.DB.prepare("delete from cloud_event_wakes where instance_id = ?").bind(computer.instance_id),
    env.DB.prepare("delete from cloud_event_wake_state where instance_id = ?").bind(computer.instance_id),
    // Its status menu's facts (`computerStatus.ts`): the provider's status changes and its brain's last report.
    env.DB.prepare("delete from cloud_instance_events where instance_id = ?").bind(computer.instance_id),
    env.DB.prepare("delete from cloud_computer_activity where instance_id = ?").bind(computer.instance_id),
  ];
}

/**
 * A deleted computer leaves the account's machine list, as a machine the person
 * removes does: revoked (so its key can't register again), off the roster, its
 * lanes off the account lane index, and its project copies gone (the project list's cursor moves, so every client
 * reads it again). The desktop did this itself after its own deletes; a delete
 * from the web, the phone or the server (idle cleanup, a sign-in that never
 * finished) left it listed as an offline machine. Kept when another live
 * computer of the account carries the same key (a move or a copy of its files).
 */
function forgetMachineStatements(env: CloudDb, computer: ComputerRow, now: number): D1PreparedStatement[] {
  const key = computer.machine_key;
  if (!key) return [];
  const unshared = {
    sql: "not exists (select 1 from cloud_computers where user_id = ? and machine_key = ? and instance_id <> ? and deleted_at is null)",
    binds: [computer.user_id, key, computer.instance_id],
  };
  return [
    ...machineCopiesGoneStatements(env.DB, computer.user_id, key, now, unshared),
    env.DB.prepare(`
      insert into revoked_machines (user_id, machine_key, device_id, revoked_at)
      select user_id, machine_key, device_id, ? from machines where user_id = ? and machine_key = ? and ${unshared.sql}
      on conflict (user_id, machine_key) do update set revoked_at = excluded.revoked_at
    `).bind(now, computer.user_id, key, ...unshared.binds),
    env.DB.prepare(`delete from machines where user_id = ? and machine_key = ? and ${unshared.sql}`)
      .bind(computer.user_id, key, ...unshared.binds),
    // Its lanes leave the account lane index, as `dropAccountLanes` does for a
    // removed machine; kept, every client listed them under a machine that's gone.
    env.DB.prepare(`delete from account_lane_index where user_id = ? and lower(machine_key) = lower(?) and ${unshared.sql}`)
      .bind(computer.user_id, key, ...unshared.binds),
    env.DB.prepare(`delete from account_lane_index_state where user_id = ? and lower(machine_key) = lower(?) and ${unshared.sql}`)
      .bind(computer.user_id, key, ...unshared.binds),
  ];
}

/** A computer the provider no longer has, though nobody here deleted it. */
export function goneFromProviderStatements(env: CloudEnv, computer: ComputerRow, now: number): D1PreparedStatement[] {
  return closedComputerStatements(env, computer, { who: null, reason: "gone_from_provider", events: null }, now);
}

/**
 * The provider deleted the computer, but its row couldn't be closed: the row
 * stays open with what it was marked with (a lane to keep), so a retry of the
 * delete, or the tick finding the computer gone, closes it.
 */
export class ComputerCloseError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "ADE Cloud deleted the computer but couldn't record it. Try again.", { cause });
    this.name = "ComputerCloseError";
  }
}

/**
 * Deletes a computer on the provider, then logs it and closes its row. Its events
 * go with it, so they're read first. Already gone counts as deleted; any other
 * provider failure throws, with the row left open. A close that fails after
 * the provider's delete throws `ComputerCloseError`.
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
  try {
    await env.DB.batch(closedComputerStatements(env, computer, { ...args, events }, now));
  } catch (error) {
    throw new ComputerCloseError(error);
  }
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
    // An adoption that learns the machine key after the account's machine
    // row exists names that row here (the registration names a row made
    // later, and the tick only names on a key it hasn't seen).
    env.DB.prepare(`
      update machines set custom_name = (select nullif(trim(c.name), '') from cloud_computers c where c.instance_id = ?)
      where custom_name is null and (user_id, machine_key) in (
        select user_id, machine_key from cloud_computers
        where instance_id = ? and deleted_at is null and machine_key is not null and nullif(trim(name), '') is not null
      )
    `).bind(instance.id, instance.id),
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

/**
 * Extra iPhone minutes' switch (`phone_extra_enabled`). `wasOn`: on until the
 * paid plan ended or its payment failed; no new minute uses them, and the
 * ended period is still billed for them (`phoneBilling.ts` turns them off after).
 */
export const PHONE_EXTRA = { off: 0, on: 1, wasOn: 2 } as const;

/** The switch when the paid plan ends or its payment fails: on becomes "was on". The SQL says the same. */
export const phoneExtraEnded = (account: Pick<AccountRow, "phone_extra_enabled">): number =>
  (account.phone_extra_enabled === PHONE_EXTRA.on ? PHONE_EXTRA.wasOn : account.phone_extra_enabled ?? PHONE_EXTRA.off);
const PHONE_EXTRA_ENDED_SQL = `case when phone_extra_enabled = ${PHONE_EXTRA.on} then ${PHONE_EXTRA.wasOn} else phone_extra_enabled end`;

/** {@link accountRules} is `paid`, as SQL on a `cloud_accounts` row. The two must say the same. */
export const PAID_RULES_SQL = "(plan = 'paid' and coalesce(stripe_status, '') <> 'past_due')";

/** `past_due` puts a paid account on free-plan rules until a paid invoice. */
export function accountRules(account: Pick<AccountRow, "plan" | "stripe_status">): "free" | "paid" {
  return account.plan === "paid" && account.stripe_status !== "past_due" ? "paid" : "free";
}

/** Which paid plan the row names (the column defaults to Plus). */
export function paidPlanOf(account: Pick<AccountRow, "paid_plan">): CloudPaidPlanId {
  return account.paid_plan === "pro" || account.paid_plan === "max" ? account.paid_plan : "plus";
}

/** Whether a move from one paid plan to another is a downgrade (it waits for the period end). */
export const isPaidDowngrade = (from: CloudPaidPlanId, to: CloudPaidPlanId): boolean => PAID_PLAN_RANK[to] < PAID_PLAN_RANK[from];

type TestFields = Pick<AccountRow, "test_plan" | "test_computers" | "test_hours_milli" | "test_phone_minutes">;

/** Whether the account test tool has anything in force on this account (`ownerAccounts.ts`). */
export function hasAccountTest(account: Partial<TestFields>): boolean {
  return hasComputerTest(account) || account.test_phone_minutes != null;
}

/** Whether a test changes the account's plan, computers or hours: what the plan cleanup reads (iPhone minutes don't touch computers). */
export function hasComputerTest(account: Partial<TestFields>): boolean {
  return testPlanOf(account) != null || account.test_computers != null || account.test_hours_milli != null;
}

/** The plan the account test tool has the account act as, or null (`ownerAccounts.ts`). */
export function testPlanOf(account: Partial<TestFields>): CloudPlanId | null {
  const plan = account.test_plan;
  return plan === "free" || isPaidPlanId(plan) ? plan : null;
}

/**
 * The plan whose limits are in force: `past_due` is the free plan until a
 * paid invoice. The real plan: billing (iPhone minutes too) reads this. The
 * account test tool's plan reaches only the paths that ask for it
 * (`limitsPlanIdOf`, `shownPlanIdOf`).
 */
export function planIdOf(account: Pick<AccountRow, "plan" | "stripe_status" | "paid_plan">): CloudPlanId {
  return accountRules(account) === "free" ? "free" : paidPlanOf(account);
}

/** `planIdOf`, or the account test tool's plan: for limits only (outside agents), never billing. */
export function limitsPlanIdOf(account: Pick<AccountRow, "plan" | "stripe_status" | "paid_plan"> & Partial<TestFields>): CloudPlanId {
  return testPlanOf(account) ?? planIdOf(account);
}

/**
 * The plan the person sees and its features follow (sponsored cards, the
 * catalog): the bought plan, `past_due` included, or the test plan.
 */
export function shownPlanIdOf(account: Pick<AccountRow, "plan" | "paid_plan"> & Partial<TestFields>): CloudPlanId {
  return testPlanOf(account) ?? boughtPlanIdOf(account);
}

/** Free or paid rules as the person sees them: a test plan's, else `accountRules`. Never for billing. */
export function shownRulesOf(account: Pick<AccountRow, "plan" | "stripe_status"> & Partial<TestFields>): "free" | "paid" {
  const test = testPlanOf(account);
  return test ? (test === "free" ? "free" : "paid") : accountRules(account);
}

/**
 * The plan's hours this period as the limits count them: the account test
 * tool's hours, else a test plan's, else the period's own. Billing (extra
 * hours, earned draws, the period roll) keeps `included_milli`.
 */
export function includedMilliOf(account: Pick<AccountRow, "included_milli"> & Partial<TestFields>): number {
  if (account.test_hours_milli != null && account.test_hours_milli >= 0) return account.test_hours_milli;
  const test = testPlanOf(account);
  return test ? CLOUD_PLANS[test].includedMilli : account.included_milli;
}

/** The plan the person pays for, `past_due` included. */
export function boughtPlanIdOf(account: Pick<AccountRow, "plan" | "paid_plan">): CloudPlanId {
  return account.plan === "paid" ? paidPlanOf(account) : "free";
}

/**
 * Pro and Max are sold only once their Stripe prices are set
 * (`scripts/stripe-setup.mjs`). Extra disk is no longer sold (Pricing v2):
 * each size has its own disk maximum instead of a disk the account shares.
 */
export function cloudOffers(env: Pick<CloudEnv, "STRIPE_PLAN_PRICE_ID" | "STRIPE_PRO_PRICE_ID" | "STRIPE_MAX_PRICE_ID">): CloudOffers {
  const pro = Boolean(env.STRIPE_PLAN_PRICE_ID?.trim() && env.STRIPE_PRO_PRICE_ID?.trim());
  return { pro, max: pro && Boolean(env.STRIPE_MAX_PRICE_ID?.trim()) };
}

/**
 * How many cloud computers the account may have, asleep or not (Pricing v2).
 * The plan it pays for, so a `past_due` account keeps its plan's limit while
 * Stripe still tries the card (it is never cleaned either, `cleanupPlanOf`),
 * and a downgrade waiting for the period end keeps the bought plan's limit
 * until then: the person paid for it. Going over the cheaper plan at the
 * switch is the downgrade's cleanup (`planCleanup.ts`).
 */
export function computerLimitOf(account: Pick<AccountRow, "plan" | "paid_plan"> & Partial<TestFields>): number {
  if (account.test_computers != null && account.test_computers >= 0) return account.test_computers;
  return CLOUD_PLANS[computerLimitPlanOf(account)].computerLimit;
}

/** The plan whose computer limit holds now (`computerLimitOf`): the bought plan, until the period ends, or the test plan. */
export function computerLimitPlanOf(account: Pick<AccountRow, "plan" | "paid_plan"> & Partial<TestFields>): CloudPlanId {
  return shownPlanIdOf(account);
}

/**
 * SQL for how many computers count toward the computer limit, as a scalar
 * subquery for the account named by `userIdSql` (a `?` or a column), and the
 * `binds` for its other `?`s, in order after `userIdSql`'s own. `moveFrom` is
 * a computer to leave out (a move's source: the move replaces it); `cutoff`
 * is the reservation cutoff (`now - PENDING_TIMEOUT_MS`).
 * Every computer not deleted counts, asleep, stopped or failed (the person
 * frees or deletes it), and so does a reservation still being made, so two
 * creates at once can't both take the last slot. A reservation older than
 * `PENDING_TIMEOUT_MS` stops counting (the tick adopts or drops it), so a
 * lost create never holds a slot. A move's source and its new computer count
 * once while the move runs: the source is left out only while its new
 * computer counts, so a move whose reservation timed out counts its source
 * again at once, not when the tick cleans it up. Once `endMoves` ends a move
 * that ran past `MOVE_GRACE_MS`, both count.
 *
 * A `moveFrom` is a move's own check: it leaves out its own source (and
 * another move's new computer from that same source, so a second move of one
 * computer answers `computer_busy`, not the limit), and the source of every
 * other move still running counts too. A
 * move's source may outlive the move (the desktop never deletes it), so two
 * moves at once from an account at its limit must not both pass: the second
 * sees the first's pair as two and meets the limit.
 */
export function accountComputerCountSql(userIdSql: string, { moveFrom = null, cutoff }: { moveFrom?: string | null; cutoff: number }): { sql: string; binds: unknown[] } {
  const counts = (alias: string) => `(${alias}.instance_id not like '${PENDING_PREFIX}%' or ${alias}.created_at > ?)`;
  const moveSources = moveFrom != null;
  return {
    sql: `(select count(*) from cloud_computers cc where cc.user_id = ${userIdSql} and cc.deleted_at is null and cc.instance_id <> ?`
      // A move's own check leaves out another move of the same source too, so that one answers `computer_busy`.
      + (moveSources
        ? " and (cc.moving_from is null or cc.moving_from <> ?)"
        : ` and not exists (select 1 from cloud_computers cm where cm.moving_from = cc.instance_id and cm.deleted_at is null and ${counts("cm")})`)
      + ` and ${counts("cc")})`,
    binds: moveSources ? [moveFrom, moveFrom, cutoff] : ["", cutoff, cutoff],
  };
}

/** Whether `computer` (not deleted) counts toward the limit: made, or a reservation still being made. */
const countsTowardLimit = (computer: Pick<ComputerRow, "instance_id" | "created_at">, now: number): boolean =>
  !isPendingId(computer.instance_id) || computer.created_at > now - PENDING_TIMEOUT_MS;

/** The computers `computers` (one account's, not deleted) count toward the limit; as `accountComputerCountSql` with nothing left out. */
export function countedComputers(computers: Pick<ComputerRow, "instance_id" | "moving_from" | "created_at">[], now: number): number {
  const moving = new Set(computers.filter((computer) => computer.moving_from != null && countsTowardLimit(computer, now)).map((computer) => computer.moving_from));
  return computers.filter((computer) => !moving.has(computer.instance_id) && countsTowardLimit(computer, now)).length;
}

/**
 * How many computers count toward the account's limit now. `moveFrom` is a
 * move's own check: that source is left out and other moves' sources count
 * (`accountComputerCountSql` with `moveFrom`).
 */
export async function accountComputerCount(env: CloudDb, userId: string, now: number, moveFrom: string | null = null): Promise<number> {
  const count = accountComputerCountSql("?", { moveFrom, cutoff: now - PENDING_TIMEOUT_MS });
  const row = await env.DB.prepare(`select ${count.sql} as n`).bind(userId, ...count.binds).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * How long a move's source may stay without counting toward the disk. The
 * desktop deletes it when the files are across (at most about 45 minutes); one
 * still there after this counts again, so a move can't keep two copies free.
 */
export const MOVE_GRACE_MS = 2 * 60 * 60_000;

/**
 * SQL for the free share of a cost: `costSql` when the account named by
 * `userIdSql` (a `?` or a column) is on free-plan rules now, else 0. Stamps
 * each stretch with the plan it ran on, for the owner's cap on free use.
 */
export function freeShareSql(userIdSql: string, costSql: string): string {
  return `case when exists (select 1 from cloud_accounts where user_id = ${userIdSql} and ${PAID_RULES_SQL}) then 0 else ${costSql} end`;
}

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

export type DiskDayAccount = Pick<AccountRow, "user_id" | "plan" | "stripe_status">;

/**
 * Raises today's peak disk for the account to what its computers hold now.
 * Run once the provider has made every change that adds disk (a reservation
 * alone counts nothing), after every plan change, and when a move runs past
 * `MOVE_GRACE_MS`; the daily run writes each day's starting row. The rows
 * feed the owner's cost report only: there is no account-wide disk and no
 * extra disk since Pricing v2, so `plan_gb` and `billable` are always 0 (the
 * columns stay for the days billed before). A day counts as free use (`free`)
 * only if the account was on free rules at every write, so a paid account
 * that drops to free mid-day doesn't charge its paid peak to free use.
 */
export function diskDayStatement(env: CloudDb, account: DiskDayAccount, now: number): D1PreparedStatement {
  return env.DB.prepare(`
    insert into cloud_disk_days (user_id, day, peak_gb, plan_gb, billable, free)
    values (?, ?, ${accountDiskSql("?", { billable: true })}, 0, 0, ?)
    on conflict (user_id, day) do update set
      peak_gb = max(peak_gb, excluded.peak_gb),
      billable = 0,
      free = min(free, excluded.free)
  `).bind(account.user_id, utcDay(now), account.user_id, accountRules(account) === "free" ? 1 : 0);
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

/** `extraActive` as the limits see it: a test Free plan has no extra hours. Never for billing. */
export function extraActiveForLimits(account: AccountRow): boolean {
  return extraActive(account) && testPlanOf(account) !== "free";
}

/**
 * Earned hours left as the limits count them: `earnedLeftMilli` against the
 * hours in force (`includedMilliOf`). The same as it with no test.
 */
export function earnedLeftForLimits(account: AccountRow, liveUsed: number): number {
  const pastPlan = Math.max(0, liveUsed - includedMilliOf(account));
  return earnedBalanceMilli(account) - Math.min(earnedBalanceMilli(account), Math.max(0, pastPlan - billedExtraMilli(account)));
}

/** Live hours used in thousandths: settled plus every running stretch. */
export function liveUsedMilli(account: AccountRow, computers: ComputerRow[], now: number): number {
  return computers.reduce((sum, computer) => sum + liveMilli(computer, now), account.used_milli);
}

/** Out once the plan's hours and every earned hour are used, unless extra hours are on. */
export function isOutOfHours(account: AccountRow, liveUsed: number): boolean {
  return !extraActiveForLimits(account) && liveUsed >= includedMilliOf(account) && earnedLeftForLimits(account, liveUsed) <= 0;
}

/**
 * An account with no free plan: refused it (`free_refused_at`, one free plan
 * per computer) or held by the GitHub rules (`free_github_hold`). Its free
 * hours are 0, and once its earned hours are used it runs nothing, Small
 * computers included (`isOutOfHoursFor`).
 */
export function hasNoFreePlan(account: Pick<AccountRow, "plan" | "free_refused_at" | "free_github_hold">): boolean {
  return account.plan === "free" && (account.free_refused_at != null || account.free_github_hold != null);
}

/**
 * Whether a computer at `multiplierMilli` may not run for lack of hours
 * (Pricing v2): only sizes that use hours stop at 0 hours, and a Small
 * computer keeps working, except on an account with no free plan
 * (`hasNoFreePlan`), which runs nothing once it is out.
 */
export function isOutOfHoursFor(account: AccountRow, liveUsed: number, multiplierMilli: number): boolean {
  return isOutOfHours(account, liveUsed) && (usesHours(multiplierMilli) || hasNoFreePlan(account));
}

/** Whole percent of the included hours used; extra hours can pass 100. */
export function percentUsed(account: AccountRow, liveUsed: number): number {
  const included = includedMilliOf(account);
  if (included <= 0) return 100;
  return Math.floor((liveUsed * 100) / included);
}

/**
 * Whole percent of everything this period may use before it runs out: the
 * plan's hours and the earned hours it can draw. What the 80% and 95%
 * warnings read, so earned hours push them back.
 */
export function allowancePercentUsed(account: AccountRow, liveUsed: number): number {
  const allowance = includedMilliOf(account) + earnedBalanceMilli(account);
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
    // Only on the account's first appearance, and only while the owner has testers waiting.
    if (account.created_at === now) await claimPhoneBetaInvite(env, userId, now);
  }
  return raiseFreeHours(env, await rollPeriodIfDue(env, account, now), now);
}

/**
 * Puts `userId` on the ADE Cloud iPhone beta list, keeping `email` (the
 * address the owner typed) when one is given and the one it had otherwise.
 * Shared by the owner's add, a waiting email's claim and its hourly retry.
 * `whilePending`: a claim adds only while that waiting email is still there,
 * in the same write, so an owner's remove during the Clerk lookup holds. The
 * row's `provider` is the tester's own pick (`phones.ts`): never set here.
 */
export function phoneBetaAddStatement(db: D1Database, userId: string, email: string | null, now: number, { whilePending = false }: { whilePending?: boolean } = {}): D1PreparedStatement {
  const upsert = "on conflict(user_id) do update set email = coalesce(excluded.email, cloud_phone_beta.email)";
  return whilePending
    ? db.prepare(`insert into cloud_phone_beta (user_id, email, added_at) select ?, ?, ? from cloud_phone_beta_pending where email = ? ${upsert}`)
      .bind(userId, email, now, email)
    : db.prepare(`insert into cloud_phone_beta (user_id, email, added_at) values (?, ?, ?) ${upsert}`).bind(userId, email, now);
}

/**
 * The owner adds ADE Cloud iPhone testers by email, before or after they sign
 * up (`POST /cloud/owner/phone-beta`). An email no ADE account had yet waits
 * in `cloud_phone_beta_pending` (migration 0052); the account that first
 * appears with it moves onto the beta list here. Its email is read from Clerk
 * once, and only while some email waits, so an account read never asks Clerk.
 * Best effort: a failure leaves the email waiting and reports it; the owner
 * check asks Clerk again for each waiting email (`resolvePendingPhoneBeta` in
 * `phoneBeta.ts`), so a failed read or an address verified later still lands.
 */
async function claimPhoneBetaInvite(env: CloudEnv, userId: string, now: number): Promise<void> {
  try {
    const waiting = await env.DB.prepare("select 1 as waiting from cloud_phone_beta_pending limit 1").first<{ waiting: number }>();
    if (!waiting) return;
    const user = await readClerkUser(env, userId);
    const emails = (user?.emails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    const found = await env.DB.prepare("select email from cloud_phone_beta_pending where email in (select value from json_each(?)) limit 1")
      .bind(JSON.stringify(emails)).first<{ email: string }>();
    if (!found) return;
    await env.DB.batch([
      phoneBetaAddStatement(env.DB, userId, found.email, now, { whilePending: true }),
      env.DB.prepare("delete from cloud_phone_beta_pending where email = ?").bind(found.email),
    ]);
    logCloud("cloud.phone_beta_claimed", { userId });
  } catch (error) {
    reportCloudFailure("cloud.phone_beta_claim_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * A free period that began on fewer hours than the free plan has now (a
 * release raised them, as Cloud 7 did from 50 to 100) gets the new number at
 * once: more hours never hurt, and the plan line and the hours line then
 * agree. Only an account with the free plan's hours: one refused them or held
 * by the GitHub rules has 0 and keeps it. Its hour warnings clear: they
 * were for the smaller number. Paid periods keep their own hours
 * (`old_plan_terms`). Held to the row it read, so a refusal written meanwhile
 * wins.
 */
async function raiseFreeHours(env: CloudEnv, account: AccountRow, now: number): Promise<AccountRow> {
  if (account.plan !== "free" || account.free_refused_at != null || account.free_github_hold != null) return account;
  if (account.included_milli <= 0 || account.included_milli >= FREE_INCLUDED_MILLI) return account;
  const raised = await env.DB.prepare(`
    update cloud_accounts set included_milli = ?,
      warned_80_at = null, warned_95_at = null, warned_zero_at = null, hours_restored_at = case when warned_zero_at is not null then ? else hours_restored_at end, updated_at = ?
    where user_id = ? and plan = 'free' and free_refused_at is null and free_github_hold is null and included_milli = ? and period_start = ?
  `).bind(FREE_INCLUDED_MILLI, now, now, account.user_id, account.included_milli, account.period_start).run();
  if ((raised.meta?.changes ?? 0) !== 1) return account;
  logCloud("cloud.free_hours_raised", { userId: account.user_id, from: account.included_milli, to: FREE_INCLUDED_MILLI });
  return {
    ...account,
    included_milli: FREE_INCLUDED_MILLI,
    warned_80_at: null,
    warned_95_at: null,
    warned_zero_at: null,
    hours_restored_at: account.warned_zero_at != null ? now : account.hours_restored_at,
    updated_at: now,
  };
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
  // Open stretches restart at the boundary (a free update window keeps its future start).
  statements.push(env.DB.prepare(`
    update cloud_computers set awake_since = ? where user_id = ? and awake_since is not null and awake_since <= ?
  `).bind(now, account.user_id, now));
  // A running credits phone's minutes its provider hasn't billed yet go into the ending period, at its time
  // so far, before the earned draw reads `used_milli`; its later answers add nothing to the new period
  // (`phoneCreditStatements` counts a phone only in the period it started). Held to the period read, so
  // two racing rolls add them once; the phones' marks only grow.
  const phonePeriod = [account.user_id, account.period_start] as const;
  statements.push(env.DB.prepare(`
    update cloud_accounts set used_milli = used_milli + coalesce((
      select sum(max(0, ${PHONE_CREDIT_MILLI_AT_SQL} - credited_milli)) from cloud_phones
      where user_id = ? and state = 'live' and credits = 1 and created_at >= ?
    ), 0)
    where user_id = ? and period_start = ?
  `).bind(now, ...phonePeriod, ...phonePeriod));
  statements.push(env.DB.prepare(`
    update cloud_phones set credited_milli = max(credited_milli, ${PHONE_CREDIT_MILLI_AT_SQL})
    where user_id = ? and state = 'live' and credits = 1 and created_at >= ?
  `).bind(now, ...phonePeriod));
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
      used_milli = 0, period_start = ?, period_end = ?, old_plan_terms = 0,
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
    old_plan_terms: 0,
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
    env.DB.prepare(`update cloud_accounts set cancel_at_period_end = 0, extra_enabled = 0, stripe_status = null,
      phone_extra_enabled = ${PHONE_EXTRA_ENDED_SQL}, updated_at = ? where user_id = ?`).bind(now, account.user_id),
  ] : []);
  return cancelled
    ? { ...rolled, cancel_at_period_end: 0, extra_enabled: 0, stripe_status: null, phone_extra_enabled: phoneExtraEnded(account) }
    : rolled;
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
      // The same period comes back with the hours it had when the payment failed (an upgrade
      // mid-period changed them); a stash from before that column falls back to the plan's.
      ? { kind: "restored_same_period", next: { plan: "paid", start: change.periodStart ?? account.period_start, end, included: account.past_due_included_milli ?? CLOUD_PLANS[nextPaidPlan].includedMilli } }
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
  // A downgrade waits for the next period: the person paid for the higher plan's hours and disk until then.
  const newPeriod = change.periodStart !== undefined && change.periodStart !== account.period_start;
  const deferDowngrade = account.plan === "paid" && nextPlan === "paid" && !wasPastDue && !isPastDue
    && isPaidDowngrade(currentPaidPlan, requestedPaidPlan) && !newPeriod;
  const nextPaidPlan: CloudPaidPlanId = deferDowngrade ? currentPaidPlan : requestedPaidPlan;
  /** A new billing period: nothing is reported or owed in it yet. */
  const clearExtraReports: Array<[keyof AccountRow, unknown]> = [["extra_reported_milli", 0], ["extra_owed_milli", 0]];

  const extras: Array<[keyof AccountRow, unknown]> = [];
  if (change.stripeCustomerId !== undefined) extras.push(["stripe_customer_id", change.stripeCustomerId]);
  if (change.stripeSubscriptionId !== undefined) extras.push(["stripe_subscription_id", change.stripeSubscriptionId]);
  if (change.stripeStatus !== undefined) extras.push(["stripe_status", change.stripeStatus]);
  if (change.cancelAtPeriodEnd !== undefined) extras.push(["cancel_at_period_end", change.cancelAtPeriodEnd ? 1 : 0]);
  if (nextPaidPlan !== account.paid_plan) extras.push(["paid_plan", nextPaidPlan]);
  if (deferDowngrade) {
    if (account.paid_plan_next !== requestedPaidPlan) extras.push(["paid_plan_next", requestedPaidPlan]);
  } else if ((change.paidPlan !== undefined || nextPlan === "free") && account.paid_plan_next != null) {
    // The new period began, the person went back to the higher plan, or the plan ended.
    extras.push(["paid_plan_next", null]);
  }

  const transition = planTransition(account, change, { nextPlan, nextPaidPlan, wasPastDue, isPastDue, now });
  if (transition?.kind === "past_due") {
    // Read before the fresh start replaces them: a later paid invoice restores these.
    const stashUsed = liveUsedMilli(account, await listComputers(env, userId), now);
    const stashPeriodEnd = change.periodEnd ?? account.period_end;
    // Extra hours go off here, but what was already used is still owed.
    const owed = extraActive(account) ? extraOwedMilli(account, stashUsed) : account.extra_owed_milli;
    extras.push(["past_due_used_milli", stashUsed], ["past_due_period_end", stashPeriodEnd], ["past_due_included_milli", account.included_milli], ["extra_enabled", 0], ["extra_owed_milli", owed]);
    extras.push(["phone_extra_enabled", phoneExtraEnded(account)]);
  }
  const updates: D1PreparedStatement[] = [];
  switch (transition?.kind) {
    case "restored_same_period":
      updates.push(env.DB.prepare("update cloud_accounts set used_milli = ? where user_id = ?").bind(account.past_due_used_milli ?? 0, userId));
      // The restored hours draw from earned hours again when this period ends, so what the cut drew comes back.
      updates.push(env.DB.prepare("update cloud_accounts set earned_used_milli = max(0, earned_used_milli - coalesce(past_due_earned_milli, 0)), past_due_earned_milli = null where user_id = ?").bind(userId));
      extras.push(["past_due_used_milli", null], ["past_due_period_end", null], ["past_due_included_milli", null], ["billing_restored_at", now]);
      break;
    case "restored_new_period":
      extras.push(...clearExtraReports, ["past_due_used_milli", null], ["past_due_period_end", null], ["past_due_included_milli", null], ["past_due_earned_milli", null], ["billing_restored_at", now]);
      break;
    case "to_paid":
    case "renewal":
      extras.push(...clearExtraReports);
      break;
    case "to_free":
      // Extra iPhone minutes are billed for the ended period, then off.
      extras.push(["extra_enabled", 0], ["phone_extra_enabled", phoneExtraEnded(account)]);
      break;
  }
  // An upgrade, or back to the higher plan, inside a running period (no new period start): the
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
  if (transition) {
    await startFreshPeriod(env, account, transition.next, now, updates, { stashEarnedDraw: transition.kind === "past_due" });
  }
  else if (updates.length) await env.DB.batch(updates);
  const after = (await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>()) ?? account;
  // Today's disk-day follows the plan as it is now (its free-use mark, for the owner's cost report).
  if (transition || nextPaidPlan !== account.paid_plan || nextStripeStatus !== account.stripe_status) {
    await diskDayStatement(env, after, now).run();
  }
  return after;
}

