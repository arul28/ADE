import { captureCloudAction, captureCloudIdleCleanup, type CloudIdleCleanupEvent, type CloudWaitUntil } from "./analytics";
import {
  CLOUD_IDLE_CLEANUP_DAYS,
  CLOUD_IGNORED_FILES_MAX_PATHS,
  idleCleanupHeldNext,
  idleCleanupSaveSentence,
  idleCleanupWhen,
  ignoredFilesSentence,
  type CloudIdleCleanupEntry,
  type CloudIgnoredFiles,
} from "./contract";
import { sendCloudEmail } from "./email";
import { cloudAccessAllows } from "./http";
import { laneFactsOf, laneFactsOfRow, markKeepLaneStatement, mergeLaneFacts, namesLane, unmarkKeepLaneStatement } from "./lanesWithoutComputer";
import { cloudSizeFor, isRestingStatus, tierOf } from "./plans";
import { pushAllWork, putBackToRest, type WakeRecord } from "./planCleanup";
import { CloudProviderError, type CloudProvider } from "./provider";
import {
  deleteComputer,
  groupByUser,
  isOutOfHours,
  isPendingId,
  liveUsedMilli,
  logCloud,
  planIdOf,
  reportCloudFailure,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * Idle cleanup (the owner's rules for Cloud 7; it replaces the 30-day delete).
 *
 * A computer nobody used is deleted, its lane kept:
 * - Free: warned at 2 days idle (email and in-app, "deleted in 1 day"), one
 *   more email about 6 hours before, deleted at 3 days.
 * - Paid (Plus, Pro and up; a `past_due` paid plan too): warned at 7 days
 *   ("deleted in 3 days"), then one email a day, deleted at 10 days.
 *
 * Idle counts from the computer's last real use: when it last went to sleep
 * after being awake (`last_awake_at`; a free wake, such as an automatic
 * update or this save, isn't use), the person's "Keep it" (`idle_kept_at`,
 * no wake), or hours coming back after the account ran out. Any of those
 * restarts the clock and voids the warning. An account out of hours is never
 * swept, a computer that is awake is never idle, and neither is one with a
 * timed wake-up booked (`cloud_wakes`: a chat's scheduled wake-up or an
 * automation's schedule, up to 32 days ahead); that wake counts as use.
 *
 * A deadline once announced never moves earlier: on a plan change during a
 * warning, the delete time is the later of the one announced and the new
 * plan's (an upgrade moves it later and warns again at the new plan's warning
 * time; a downgrade keeps the announced one). The first warning always gives
 * the plan's full lead (1 day free, 3 days paid), even if it goes out late.
 *
 * Before the delete the computer saves its work, from the computer itself in
 * a free wake that bills no hours (`pushAllWork`): its ADE stops its agents,
 * saves its chats, commits uncommitted work ("saved by ADE before cleanup";
 * `git add -A` never adds ignored files) and does a normal push of each lane
 * to its own branch (no force, no extra branch), then reads it all again.
 * Anything short of "everything is on GitHub" keeps the computer: the person
 * is told why (in-app and by email) and ADE tries again later, waiting twice
 * as long after each failed try (1, 2, 4 ... days, at most 14). A run that
 * fails after the save (a refused delete) waits 1, 2, 4 ... hours (at most a
 * day) before it tries again. Each email is claimed with a conditional write
 * before it is sent, so overlapping ticks send it once; a send that fails
 * keeps its claim (the in-app warning stands), so it never blocks the steps
 * after it. A person who starts, runs a command on, or signs in on the
 * computer while its save runs marks real use (`recordIdleUse`), and the
 * delete is called off.
 */

const MINUTE = 60_000;
/** "Nov 16", in UTC, as the other cloud emails say dates. */
const formatCloudDate = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type IdleRule = {
  /** Deleted this long after the last use. */
  afterMs: number;
  /** The first warning goes out this long before the delete, and never gives less. */
  leadMs: number;
  /** The last email goes out this long before the delete. */
  lastEmailMs: number;
  /** The delete waits at least this long after the last email went out (a late email is never followed at once by the delete). */
  afterLastEmailMs: number;
  days: number;
};

export const IDLE_CLEANUP: Readonly<Record<"free" | "paid", IdleRule>> = {
  free: { afterMs: CLOUD_IDLE_CLEANUP_DAYS.free * DAY, leadMs: DAY, lastEmailMs: 6 * HOUR, afterLastEmailMs: 5 * HOUR, days: CLOUD_IDLE_CLEANUP_DAYS.free },
  paid: { afterMs: CLOUD_IDLE_CLEANUP_DAYS.paid * DAY, leadMs: 3 * DAY, lastEmailMs: DAY, afterLastEmailMs: 20 * HOUR, days: CLOUD_IDLE_CLEANUP_DAYS.paid },
};

/** The commit message for work the computer hadn't committed. */
export const IDLE_CLEANUP_COMMIT_MESSAGE = "saved by ADE before cleanup";
/** A tick a little early still counts for an email due now. */
const EMAIL_SLACK_MS = 30 * MINUTE;
/** A computer kept because its save failed is tried again after this long, doubled after each failed try, at most `HELD_RETRY_MAX_MS`. */
const HELD_RETRY_MS = DAY;
const HELD_RETRY_MAX_MS = 14 * DAY;
/** A run that failed after the save (a refused delete) is tried again after this long, doubled each time, at most `FAILED_RETRY_MAX_MS`. */
const FAILED_RETRY_MS = HOUR;
const FAILED_RETRY_MAX_MS = DAY;
/** A run that died left its claim; it stops counting after this long. */
const CLAIM_STALE_MS = 20 * MINUTE;
/** Save-and-delete runs one tick starts (each can take minutes on the computer). */
const SAVES_PER_TICK = 3;
/** The youngest idle a computer can have and still need a warning (the free plan's). */
const MIN_IDLE_TO_WARN_MS = Math.min(...Object.values(IDLE_CLEANUP).map((rule) => rule.afterMs - rule.leadMs));
/** Codes for work the person has to deal with (a refused push), not an ADE failure. */
const USER_STATE_CODES = new Set(["push_left_work", "check_left_work"]);

type IdleColumns = Pick<ComputerRow,
  | "last_awake_at" | "created_at" | "awake_since" | "status" | "instance_id"
  | "idle_warned_at" | "idle_deletes_at" | "idle_emailed_at" | "idle_kept_at" | "idle_held_at" | "idle_held_reason" | "idle_held_count"
  | "idle_failed_at" | "idle_failed_count">;

/** The wait after the `count`th failure in a row: `base`, doubled each time, at most `max`. */
const backoffMs = (base: number, max: number, count: number): number => Math.min(max, base * 2 ** Math.min(20, Math.max(0, count - 1)));

/** Free rules for the free plan; a paid plan (one whose payment failed too) keeps the paid rules: never sooner than what the person pays for. */
export function idleRuleOf(account: Pick<AccountRow, "plan">): IdleRule {
  return account.plan === "paid" ? IDLE_CLEANUP.paid : IDLE_CLEANUP.free;
}

/** When the idle clock started: the last real use, a "Keep it", or hours coming back. */
export function idleSinceOf(computer: IdleColumns, account: Pick<AccountRow, "hours_restored_at">): number {
  return Math.max(computer.last_awake_at ?? computer.created_at, account.hours_restored_at ?? 0, computer.idle_kept_at ?? 0);
}

export type IdleState = {
  since: number;
  rule: IdleRule;
  deletesAt: number;
  /** A warning for this idle stretch is out, and its delete time is the one in force. */
  announced: boolean;
  needsWarning: boolean;
  needsFollowUp: boolean;
  deleteReady: boolean;
  /** The save-and-delete should run now: its time came, or a kept computer's retry did. */
  saveDue: boolean;
  /** The save failed and the computer was kept; tried again at `retryAt` (the `count`th failure in a row). */
  held: { at: number; reason: string; retryAt: number; count: number } | null;
};

/**
 * Where a computer stands in the idle cleanup, or null when it isn't idle:
 * awake or on its way there, a timed wake-up booked (`scheduled`), or the
 * account is out of hours (nobody loses a computer just for running out).
 */
export function idleStateOf(computer: IdleColumns, account: AccountRow, liveUsed: number, now: number, scheduled = false): IdleState | null {
  if (scheduled || isPendingId(computer.instance_id) || computer.awake_since != null || !isRestingStatus(computer.status) || isOutOfHours(account, liveUsed)) return null;
  const rule = idleRuleOf(account);
  const since = idleSinceOf(computer, account);
  const ruleDue = since + rule.afterMs;
  const warned = computer.idle_warned_at != null && computer.idle_warned_at >= since && computer.idle_deletes_at != null;
  const announcedAt = warned ? computer.idle_deletes_at! : 0;
  const deletesAt = Math.max(ruleDue, announcedAt);
  const announced = warned && announcedAt >= ruleDue;
  const heldValid = computer.idle_held_at != null && computer.idle_held_at >= since;
  const heldCount = Math.max(1, computer.idle_held_count ?? 1);
  const held = heldValid
    ? { at: computer.idle_held_at!, reason: computer.idle_held_reason ?? "ADE couldn't save its work.", retryAt: computer.idle_held_at! + backoffMs(HELD_RETRY_MS, HELD_RETRY_MAX_MS, heldCount), count: heldCount }
    : null;
  // A run that failed after the save waits before the next one.
  const failedUntil = computer.idle_failed_at != null && computer.idle_failed_at >= since
    ? computer.idle_failed_at + backoffMs(FAILED_RETRY_MS, FAILED_RETRY_MAX_MS, Math.max(1, computer.idle_failed_count ?? 1))
    : 0;
  const lastEmailDue = deletesAt - rule.lastEmailMs;
  const emailed = warned ? computer.idle_emailed_at ?? null : null;
  const needsWarning = !held && !announced && now >= deletesAt - rule.leadMs;
  const needsFollowUp = !held && announced && emailed != null && emailed < lastEmailDue - EMAIL_SLACK_MS && now >= nextEmailAt(lastEmailDue, emailed, rule === IDLE_CLEANUP.paid);
  const deleteReady = !held && announced && now >= deletesAt && now >= failedUntil && emailed != null
    && emailed >= lastEmailDue - EMAIL_SLACK_MS && now - emailed >= rule.afterLastEmailMs;
  const saveDue = deleteReady || (held != null && now >= held.retryAt && now >= failedUntil);
  return { since, rule, deletesAt: Math.max(deletesAt, held?.retryAt ?? 0, failedUntil), announced, needsWarning, needsFollowUp, deleteReady, saveDue, held };
}

/**
 * The next follow-up after an email sent at `emailed`. Free has one, at
 * `lastEmailDue` (6 hours before). Paid (`daily`) has one a day: the first of
 * `lastEmailDue`, `lastEmailDue - 1 day`, `- 2 days` ... after `emailed` (a
 * slot within `EMAIL_SLACK_MS` of it counts as sent), so 2 days and 1 day
 * before. Anchored on the delete time, so a late tick never pulls the next
 * one earlier.
 */
function nextEmailAt(lastEmailDue: number, emailed: number, daily: boolean): number {
  if (!daily) return lastEmailDue;
  const slotsBack = Math.ceil((lastEmailDue - emailed - EMAIL_SLACK_MS) / DAY) - 1;
  return lastEmailDue - Math.max(0, slotsBack) * DAY;
}

/** The account read's warnings: each computer warned about or kept after a failed save, soonest first. */
export function idleCleanupEntries(account: AccountRow, computers: ComputerRow[], liveUsed: number, now: number): CloudIdleCleanupEntry[] {
  return computers
    .flatMap((computer): CloudIdleCleanupEntry[] => {
      const state = idleStateOf(computer, account, liveUsed, now);
      if (!state || (!state.announced && !state.held)) return [];
      return [{
        instanceId: computer.instance_id,
        name: computer.name,
        deletesAt: state.deletesAt,
        laneName: computer.lane_name ?? null,
        branch: computer.lane_branch ?? null,
        warnedAt: computer.idle_warned_at ?? null,
        idleDays: state.rule.days,
        ignoredFiles: ignoredFilesOf(computer),
        held: state.held ? { at: state.held.at, reason: state.held.reason, retryAt: state.held.retryAt } : null,
      }];
    })
    .sort((a, b) => a.deletesAt - b.deletesAt);
}

/* ---- Ignored files, as the computer reports them at its idle step ---- */

const MAX_PATH_CHARS = 200;
const MAX_COUNT = 1_000_000;
/** A report from the future (a skewed clock) is pinned to now. */
const FUTURE_SLACK_MS = 5 * MINUTE;

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;

/** The computer's report, checked; null when it can't be read. Paths past the cap are counted in `more`. */
export function parseIgnoredFiles(raw: unknown, now: number): CloudIgnoredFiles | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const checkedAt = typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) && record.checkedAt > 0
    ? Math.min(Math.round(record.checkedAt), now + FUTURE_SLACK_MS) : null;
  const more = countOf(record.more);
  const rebuildable = countOf(record.rebuildable ?? 0);
  if (checkedAt == null || more == null || rebuildable == null || !Array.isArray(record.paths)) return null;
  if (record.incomplete != null && typeof record.incomplete !== "boolean") return null;
  const paths = record.paths
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, MAX_PATH_CHARS))
    .filter(Boolean);
  if (paths.length !== record.paths.length) return null;
  const kept = paths.slice(0, CLOUD_IGNORED_FILES_MAX_PATHS);
  return { checkedAt, paths: kept, more: more + (paths.length - kept.length), rebuildable, ...(record.incomplete === true ? { incomplete: true } : {}) };
}

/** The saved report, or null before the first one (or a row the code can't read). */
export function ignoredFilesOf(computer: Pick<ComputerRow, "ignored_files_json">): CloudIgnoredFiles | null {
  if (!computer.ignored_files_json) return null;
  try {
    return parseIgnoredFiles(JSON.parse(computer.ignored_files_json), Number.MAX_SAFE_INTEGER);
  } catch {
    return null;
  }
}

/** Saves a report; an older one (a report retried late) never replaces a newer one. */
export function ignoredFilesStatement(env: CloudEnv, instanceId: string, ignored: CloudIgnoredFiles): D1PreparedStatement {
  return env.DB.prepare(`
    update cloud_computers set ignored_files_json = ?
    where instance_id = ? and (ignored_files_json is null or coalesce(json_extract(ignored_files_json, '$.checkedAt'), 0) <= ?)
  `).bind(JSON.stringify(ignored), instanceId, ignored.checkedAt);
}

/* ---- Steps ---- */

function logStep(env: CloudEnv, computer: Pick<ComputerRow, "instance_id" | "user_id">, step: CloudIdleCleanupEvent["step"], detail: string | null, now: number): Promise<unknown> {
  return env.DB.prepare("insert into cloud_idle_cleanup_log (instance_id, user_id, step, detail, created_at) values (?, ?, ?, ?, ?)")
    .bind(computer.instance_id, computer.user_id, step, detail, now).run()
    .catch((error: unknown) => reportCloudFailure("cloud.idle_cleanup_log_failed", { message: error instanceof Error ? error.message : "unknown" }));
}

const labelOf = (computer: Pick<ComputerRow, "lane_name" | "name">): string =>
  computer.lane_name ? `The computer for ${computer.lane_name}` : computer.name ? `${computer.name}` : "An ADE Cloud computer";

const daysText = (ms: number): string => {
  const days = Math.max(1, Math.floor(ms / DAY));
  return `${days} ${days === 1 ? "day" : "days"}`;
};

/** The warning email (the first and each follow-up): when, what is saved, which ignored files go, how to keep it. */
export function idleWarningEmail(computer: ComputerRow, state: Pick<IdleState, "since" | "deletesAt">, now: number): { subject: string; text: string } {
  const label = labelOf(computer);
  return {
    subject: `${label} will be ${idleCleanupWhen(state.deletesAt, now)}`,
    text: [
      `${label} hasn't been used for ${daysText(now - state.since)}, so ADE Cloud will delete it on ${formatCloudDate(state.deletesAt)} (UTC).`,
      idleCleanupSaveSentence(computer.lane_branch),
      ignoredFilesSentence(ignoredFilesOf(computer)),
      "To keep it, open ADE and choose Keep it in Settings › ADE Cloud, or send a message in the lane.",
    ].join("\n"),
  };
}

/** The email when the save didn't go through and the computer was kept, with when ADE tries again. */
export function idleHeldEmail(computer: ComputerRow, reason: string, retryAt: number, now: number): { subject: string; text: string } {
  const label = labelOf(computer);
  return {
    subject: `ADE Cloud didn't delete ${computer.lane_name ?? computer.name ?? "your computer"}: its work couldn't be saved`,
    text: [
      `${label} was due to be deleted because it hasn't been used, but ADE couldn't commit and push its work to GitHub first, so it kept the computer.`,
      `Why: ${reason}`,
      idleCleanupHeldNext(retryAt, now),
    ].join("\n"),
  };
}

function idleDeletedEmail(computer: ComputerRow, branch: string | null, laneKept: boolean, idleMs: number): { subject: string; text: string } {
  const label = labelOf(computer);
  return {
    subject: `${label} was deleted after ${daysText(idleMs)} unused`,
    text: [
      `ADE Cloud deleted ${label.charAt(0).toLowerCase()}${label.slice(1)} after ${daysText(idleMs)} without use. Its work was committed and pushed to ${branch ? `the branch ${branch}` : "its branch"} on GitHub first.`,
      laneKept ? "The lane and its chats stay. Your next message to the lane makes a new computer from the branch." : "",
    ].filter(Boolean).join("\n"),
  };
}

/**
 * Sends one of the cleanup's emails. A failure is reported (Sentry, the log,
 * PostHog) and never retried here: the caller keeps its claim, so a send that
 * keeps failing can't loop every minute or hold up the steps after it.
 */
async function sendStepEmail(
  env: CloudEnv,
  waitUntil: CloudWaitUntil,
  account: Pick<AccountRow, "user_id" | "plan" | "stripe_status" | "paid_plan">,
  computer: ComputerRow,
  kind: "warning" | "follow_up" | "held" | "deleted",
  email: { subject: string; text: string },
  now: number,
): Promise<"sent" | "skipped" | "failed"> {
  const result = await sendCloudEmail(env, { userId: computer.user_id, ...email }).catch((error: unknown) => {
    logCloud("cloud.idle_cleanup_email_threw", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : "unknown" });
    return "failed" as const;
  });
  if (result === "failed") {
    reportCloudFailure("cloud.idle_cleanup_email_failed", { instanceId: computer.instance_id, kind });
    await logStep(env, computer, "failed", `email_${kind}`, now);
    captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "failed", plan: planIdOf(account), reason: "email_failed" }, computer.instance_id, now);
  }
  return result;
}

/**
 * The claim's guard: the row and the account still as the tick read them
 * (not used, kept, given hours back, or booked a timed wake since), so a
 * person who came back between the read and the claim gets no email and no
 * deadline.
 */
function stillIdleGuard(computer: ComputerRow, account: AccountRow): { sql: string; binds: unknown[] } {
  return {
    sql: `awake_since is null and last_awake_at is ? and idle_kept_at is ?
      and not exists (select 1 from cloud_wakes w where w.user_id = cloud_computers.user_id and w.instance_id = cloud_computers.instance_id)
      and coalesce((select hours_restored_at from cloud_accounts a where a.user_id = cloud_computers.user_id), 0) = ?`,
    binds: [computer.last_awake_at ?? null, computer.idle_kept_at ?? null, account.hours_restored_at ?? 0],
  };
}

/** The first warning, claimed with the row as it was read so overlapping ticks send it once. */
async function warn(env: CloudEnv, waitUntil: CloudWaitUntil, account: AccountRow, computer: ComputerRow, state: IdleState, now: number): Promise<void> {
  // The full lead, even when this tick is late: the person always has the plan's warning time.
  const deletesAt = Math.max(state.deletesAt, now + state.rule.leadMs);
  const guard = stillIdleGuard(computer, account);
  const claimed = await env.DB.prepare(`
    update cloud_computers set idle_warned_at = ?, idle_deletes_at = ?, idle_emailed_at = ?, idle_held_at = null, idle_held_reason = null,
      idle_held_count = null, idle_failed_at = null, idle_failed_count = null
    where instance_id = ? and deleted_at is null and idle_warned_at is ? and idle_deletes_at is ? and ${guard.sql}
  `).bind(now, deletesAt, now, computer.instance_id, computer.idle_warned_at ?? null, computer.idle_deletes_at ?? null, ...guard.binds).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  computer.idle_warned_at = now;
  computer.idle_deletes_at = deletesAt;
  computer.idle_emailed_at = now;
  logCloud("cloud.idle_cleanup_warned", { instanceId: computer.instance_id, deletesAt });
  await logStep(env, computer, "warned", state.rule === IDLE_CLEANUP.free ? "free" : "paid", now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "warned", plan: planIdOf(account) }, computer.instance_id, now);
  // A failed send keeps the warning (it shows in ADE); the follow-ups and the delete still wait on their own times.
  await sendStepEmail(env, waitUntil, account, computer, "warning", idleWarningEmail(computer, { since: state.since, deletesAt }, now), now);
}

/**
 * A follow-up email, claimed on the last email's time. A send that fails
 * keeps the claim (reported; the in-app warning stands): retrying it would
 * call Clerk and Resend every minute and hold the delete back for good.
 */
async function followUp(env: CloudEnv, waitUntil: CloudWaitUntil, account: AccountRow, computer: ComputerRow, state: IdleState, now: number): Promise<void> {
  const guard = stillIdleGuard(computer, account);
  const claimed = await env.DB.prepare(`
    update cloud_computers set idle_emailed_at = ?
    where instance_id = ? and deleted_at is null and idle_emailed_at is ? and idle_warned_at is ? and ${guard.sql}
  `).bind(now, computer.instance_id, computer.idle_emailed_at ?? null, computer.idle_warned_at ?? null, ...guard.binds).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  computer.idle_emailed_at = now;
  const result = await sendStepEmail(env, waitUntil, account, computer, "follow_up", idleWarningEmail(computer, state, now), now);
  if (result === "failed") return;
  await logStep(env, computer, "emailed", null, now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "emailed", plan: planIdOf(account) }, computer.instance_id, now);
}

/**
 * "Keep it": the idle clock restarts now, with no wake and no hours. Clears
 * the warning and a kept-after-a-failed-save state; a save already running
 * sees it before its delete and stops.
 */
export async function keepIdleComputer(env: CloudEnv, waitUntil: CloudWaitUntil, account: AccountRow, computer: ComputerRow, now: number): Promise<void> {
  const warned = computer.idle_warned_at != null || computer.idle_held_at != null;
  await env.DB.prepare(`
    update cloud_computers set idle_kept_at = ?, idle_warned_at = null, idle_deletes_at = null, idle_emailed_at = null, idle_held_at = null, idle_held_reason = null,
      idle_held_count = null, idle_failed_at = null, idle_failed_count = null
    where instance_id = ? and deleted_at is null
  `).bind(now, computer.instance_id).run();
  logCloud("cloud.idle_cleanup_kept", { instanceId: computer.instance_id, how: "button", warned });
  await logStep(env, computer, "kept", "button", now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "kept", plan: planIdOf(account), how: "button" }, computer.instance_id, now);
}

/**
 * Real use while a save-and-delete runs (`idle_claimed_at`): the person
 * started the computer, ran a command on it, or signed in on it. During the
 * save's free wake the computer is already running, so a start changes no
 * status and writes nothing else; this moves `last_awake_at`, which calls
 * the delete off (`cameBack`), keeps the computer awake for them, and makes
 * the free wake count as use when it closes. Outside a run it writes nothing:
 * the status change of a wake already counts.
 */
export async function recordIdleUse(env: CloudEnv, instanceId: string, now: number): Promise<void> {
  try {
    const marked = await env.DB.prepare("update cloud_computers set last_awake_at = ? where instance_id = ? and deleted_at is null and idle_claimed_at is not null")
      .bind(now, instanceId).run();
    if ((marked.meta?.changes ?? 0) > 0) logCloud("cloud.idle_cleanup_used_during_save", { instanceId });
  } catch (error) {
    // The person's request goes on; the save's own checks still stop at Keep it or a status change.
    reportCloudFailure("cloud.idle_cleanup_use_mark_failed", { instanceId, message: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * A warning or a kept state the person moved past (they used the computer,
 * hours came back, or it booked a timed wake-up) is cleared, and counted as
 * kept. Free wakes don't move `last_awake_at`, so a save in flight never
 * clears its own warning.
 */
async function clearMovedPast(env: CloudEnv, waitUntil: CloudWaitUntil, now: number): Promise<void> {
  const rows = (await env.DB.prepare(`
    select c.instance_id, c.user_id, c.idle_warned_at, c.idle_held_at, a.plan, a.stripe_status, a.paid_plan,
      case when coalesce(c.last_awake_at, c.created_at) > coalesce(c.idle_warned_at, c.idle_held_at) then 'used'
        when coalesce(a.hours_restored_at, 0) > coalesce(c.idle_warned_at, c.idle_held_at) then 'hours_back'
        else 'scheduled' end as how
    from cloud_computers c join cloud_accounts a on a.user_id = c.user_id
    where c.deleted_at is null and (c.idle_warned_at is not null or c.idle_held_at is not null)
      and (c.idle_claimed_at is null or c.idle_claimed_at < ?)
      and (coalesce(c.last_awake_at, c.created_at) > coalesce(c.idle_warned_at, c.idle_held_at)
        or coalesce(a.hours_restored_at, 0) > coalesce(c.idle_warned_at, c.idle_held_at)
        or exists (select 1 from cloud_wakes w where w.user_id = c.user_id and w.instance_id = c.instance_id))
  `).bind(now - CLAIM_STALE_MS).all<{ instance_id: string; user_id: string; idle_warned_at: number | null; idle_held_at: number | null; plan: "free" | "paid"; stripe_status: string | null; paid_plan: AccountRow["paid_plan"]; how: "used" | "hours_back" | "scheduled" }>()).results ?? [];
  for (const row of rows) {
    const cleared = await env.DB.prepare(`
      update cloud_computers set idle_warned_at = null, idle_deletes_at = null, idle_emailed_at = null, idle_held_at = null, idle_held_reason = null,
        idle_held_count = null, idle_failed_at = null, idle_failed_count = null
      where instance_id = ? and idle_warned_at is ? and idle_held_at is ?
    `).bind(row.instance_id, row.idle_warned_at, row.idle_held_at).run();
    if ((cleared.meta?.changes ?? 0) !== 1) continue;
    logCloud("cloud.idle_cleanup_kept", { instanceId: row.instance_id, how: row.how });
    await logStep(env, row, "kept", row.how, now);
    captureCloudIdleCleanup(env, waitUntil, row.user_id, { step: "kept", plan: planIdOf(row), how: row.how }, row.instance_id, now);
  }
}

/**
 * From the minute cron: clears warnings the person moved past, sends the
 * warnings and follow-ups due, and starts up to `SAVES_PER_TICK` saves of
 * computers whose time came (a slot counts only once its claim is taken and
 * the save is still due). With no idle computer, two indexed reads.
 */
export async function runIdleCleanup(env: CloudEnv, provider: CloudProvider, now = Date.now(), waitUntil?: CloudWaitUntil): Promise<void> {
  await clearMovedPast(env, waitUntil, now);
  // A computer with a timed wake-up booked is in use until it fires (that wake counts as use).
  const candidates = ((await env.DB.prepare(`
    select * from cloud_computers c
    where c.deleted_at is null and c.awake_since is null and coalesce(c.last_awake_at, c.created_at) <= ?
      and not exists (select 1 from cloud_wakes w where w.user_id = c.user_id and w.instance_id = c.instance_id)
  `).bind(now - MIN_IDLE_TO_WARN_MS).all<ComputerRow>()).results ?? []).filter((computer) => !isPendingId(computer.instance_id));
  if (candidates.length === 0) return;
  const byUser = groupByUser(candidates);
  const userIds = JSON.stringify([...byUser.keys()]);
  const [accounts, owned] = await Promise.all([
    env.DB.prepare("select * from cloud_accounts where deleted_at is null and user_id in (select value from json_each(?))").bind(userIds).all<AccountRow>(),
    env.DB.prepare("select * from cloud_computers where deleted_at is null and user_id in (select value from json_each(?))").bind(userIds).all<ComputerRow>(),
  ]);
  const ownedBy = groupByUser(owned.results ?? []);
  let budget = SAVES_PER_TICK;
  const runs: Promise<void>[] = [];
  for (const account of accounts.results ?? []) {
    // An account ADE Cloud no longer lets in is left as it is.
    if (!cloudAccessAllows(env, account.user_id)) continue;
    try {
      const all = ownedBy.get(account.user_id) ?? [];
      const liveUsed = liveUsedMilli(account, all, now);
      for (const computer of byUser.get(account.user_id) ?? []) {
        // A move or an update in flight changes which computer holds the lane: wait it out.
        if (computer.moving_from != null || computer.update_state === "updating") continue;
        const state = idleStateOf(computer, account, liveUsed, now);
        if (!state) continue;
        if (state.needsWarning) await warn(env, waitUntil, account, computer, state, now);
        else if (state.needsFollowUp) await followUp(env, waitUntil, account, computer, state, now);
        else if (state.saveDue && budget > 0) {
          const fresh = await claimSave(env, computer.instance_id, now);
          if (!fresh) continue;
          budget -= 1;
          runs.push(saveAndDelete(env, provider, waitUntil, fresh, now));
        }
      }
    } catch (error) {
      reportCloudFailure("cloud.idle_cleanup_account_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  await Promise.all(runs);
}

type Fresh = { computer: ComputerRow; account: AccountRow; state: IdleState };

/** Whether the computer has a timed wake-up booked (a chat's scheduled wake-up, an automation's schedule). */
async function hasTimedWake(env: CloudEnv, computer: Pick<ComputerRow, "instance_id" | "user_id">): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as n from cloud_wakes where user_id = ? and instance_id = ? limit 1").bind(computer.user_id, computer.instance_id).first<{ n: number }>();
  return row != null;
}

/** The computer and its account read again, when its save is still due: the tick's read can be a minute old. */
async function freshDue(env: CloudEnv, instanceId: string, now: number): Promise<Fresh | null> {
  const computer = await env.DB.prepare("select * from cloud_computers where instance_id = ? and deleted_at is null").bind(instanceId).first<ComputerRow>();
  if (!computer || !cloudAccessAllows(env, computer.user_id)) return null;
  const [account, owned, scheduled] = await Promise.all([
    env.DB.prepare("select * from cloud_accounts where user_id = ? and deleted_at is null").bind(computer.user_id).first<AccountRow>(),
    env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null").bind(computer.user_id).all<ComputerRow>(),
    hasTimedWake(env, computer),
  ]);
  if (!account) return null;
  const state = idleStateOf(computer, account, liveUsedMilli(account, owned.results ?? [], now), now, scheduled);
  if (!state?.saveDue) return null;
  return { computer, account, state };
}

const unclaimSave = (env: CloudEnv, instanceId: string, now: number): Promise<unknown> =>
  env.DB.prepare("update cloud_computers set idle_claimed_at = null where instance_id = ? and idle_claimed_at = ?").bind(instanceId, now).run()
    .catch((error: unknown) => reportCloudFailure("cloud.idle_cleanup_unclaim_failed", { instanceId, message: error instanceof Error ? error.message : "unknown" }));

/** The save-and-delete's claim, so overlapping ticks run it once, and the row read again; null (claim given back) when it isn't due after all. */
async function claimSave(env: CloudEnv, instanceId: string, now: number): Promise<Fresh | null> {
  const claimed = await env.DB.prepare(`
    update cloud_computers set idle_claimed_at = ?
    where instance_id = ? and deleted_at is null and (idle_claimed_at is null or idle_claimed_at < ?)
  `).bind(now, instanceId, now - CLAIM_STALE_MS).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return null;
  try {
    // Never woken for nothing.
    const fresh = await freshDue(env, instanceId, now);
    if (fresh) return fresh;
  } catch (error) {
    reportCloudFailure("cloud.idle_cleanup_fresh_read_failed", { instanceId, message: error instanceof Error ? error.message : "unknown" });
  }
  await unclaimSave(env, instanceId, now);
  return null;
}

type CameBack = "used" | "kept" | "hours_back" | "scheduled" | "deleted";

/**
 * Whether the person came back while the save ran, and how: used it (a wake
 * that counts, or a start, command or sign-in during the save's free wake,
 * moves `last_awake_at`), pressed Keep it, got hours back, booked a timed
 * wake-up, or deleted it. The free wake of the save itself changes none of these.
 */
async function cameBack(env: CloudEnv, fresh: Fresh): Promise<CameBack | null> {
  const [row, account, scheduled] = await Promise.all([
    env.DB.prepare("select last_awake_at, idle_kept_at, deleted_at from cloud_computers where instance_id = ?").bind(fresh.computer.instance_id)
      .first<Pick<ComputerRow, "last_awake_at" | "idle_kept_at" | "deleted_at">>(),
    env.DB.prepare("select hours_restored_at, deleted_at from cloud_accounts where user_id = ?").bind(fresh.account.user_id)
      .first<Pick<AccountRow, "hours_restored_at" | "deleted_at">>(),
    hasTimedWake(env, fresh.computer),
  ]);
  if (!row || row.deleted_at != null || !account || account.deleted_at != null) return "deleted";
  if ((row.last_awake_at ?? null) !== (fresh.computer.last_awake_at ?? null)) return "used";
  if ((row.idle_kept_at ?? null) !== (fresh.computer.idle_kept_at ?? null)) return "kept";
  if ((account.hours_restored_at ?? null) !== (fresh.account.hours_restored_at ?? null)) return "hours_back";
  if (scheduled) return "scheduled";
  return null;
}

/**
 * A computer this run woke goes back to rest, unless the person started using
 * it meanwhile (`last_awake_at` moved): then it stays awake for them.
 */
async function restIfUnused(env: CloudEnv, provider: CloudProvider, fresh: Fresh, wake: WakeRecord): Promise<void> {
  if (!wake.woke) return;
  const row = await env.DB.prepare("select last_awake_at from cloud_computers where instance_id = ?").bind(fresh.computer.instance_id)
    .first<Pick<ComputerRow, "last_awake_at">>()
    .catch((error: unknown) => {
      reportCloudFailure("cloud.idle_cleanup_use_read_failed", { instanceId: fresh.computer.instance_id, message: error instanceof Error ? error.message : "unknown" });
      return null;
    });
  if (row && (row.last_awake_at ?? null) !== (fresh.computer.last_awake_at ?? null)) {
    logCloud("cloud.idle_cleanup_left_awake", { instanceId: fresh.computer.instance_id });
    return;
  }
  await putBackToRest(env, provider, fresh.computer.instance_id, wake.from, "idle_cleanup");
}

/**
 * A run that failed outside the save (a refused delete, a throw): marked, so
 * the next tick doesn't redo the whole save at once. Tried again after
 * 1, 2, 4 ... hours (at most a day).
 */
async function markFailed(env: CloudEnv, waitUntil: CloudWaitUntil, fresh: Fresh, code: "delete_failed" | "run_failed", now: number): Promise<void> {
  const { computer, account, state } = fresh;
  try {
    await env.DB.prepare(`
      update cloud_computers set idle_failed_at = ?,
        idle_failed_count = case when idle_failed_at is not null and idle_failed_at >= ? then coalesce(idle_failed_count, 0) + 1 else 1 end
      where instance_id = ? and deleted_at is null
    `).bind(now, state.since, computer.instance_id).run();
  } catch (error) {
    reportCloudFailure("cloud.idle_cleanup_mark_failed_failed", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : "unknown" });
  }
  await logStep(env, computer, "failed", code, now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "failed", plan: planIdOf(account), reason: code }, computer.instance_id, now);
}

/** One computer, already claimed: its work saved from the computer itself, then deleted with its lane kept; or kept with the reason. */
async function saveAndDelete(env: CloudEnv, provider: CloudProvider, waitUntil: CloudWaitUntil, fresh: Fresh, now: number): Promise<void> {
  const { computer, account } = fresh;
  const wake: WakeRecord = { woke: false, from: computer.status };
  try {
    const plan = planIdOf(account);
    let work: Awaited<ReturnType<typeof pushAllWork>>;
    try {
      work = await pushAllWork(env, provider, computer, now, wake, "idle_cleanup", { commitMessage: IDLE_CLEANUP_COMMIT_MESSAGE });
    } catch (error) {
      work = { ok: false, reason: "ADE Cloud couldn't reach the computer to save its work.", code: error instanceof CloudProviderError ? error.code : "unknown" };
    }
    if (!work.ok) {
      await hold(env, provider, waitUntil, fresh, work.reason, work.code, wake, now);
      return;
    }
    await logStep(env, computer, "saved", null, now);
    captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "saved", plan }, computer.instance_id, now);
    // The push took minutes: the person may have come back meanwhile.
    const back = await cameBack(env, fresh);
    if (back) {
      await restIfUnused(env, provider, fresh, wake);
      logCloud("cloud.idle_cleanup_came_back", { instanceId: computer.instance_id, how: back });
      return;
    }
    const lane = mergeLaneFacts(laneFactsOfRow(computer), laneFactsOf(work.metadata));
    const own = work.pushed.lanes?.find((entry) => entry.laneId === lane.laneId) ?? null;
    if (own?.branchRef) lane.branch = own.branchRef;
    const laneKept = namesLane(lane);
    if (laneKept) await markKeepLaneStatement(env, computer, lane, "idle_cleanup").run();
    try {
      await deleteComputer(env, provider, computer, { who: "system", reason: "idle_cleanup" }, Date.now());
    } catch (error) {
      if (laneKept) await unmarkKeepLaneStatement(env, computer.instance_id).run();
      await restIfUnused(env, provider, fresh, wake);
      // Its work is saved; the delete is tried again after a wait, never every minute.
      reportCloudFailure("cloud.idle_cleanup_delete_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      await markFailed(env, waitUntil, fresh, "delete_failed", now);
      return;
    }
    logCloud("cloud.idle_cleanup_deleted", { instanceId: computer.instance_id, keptLane: laneKept });
    await logStep(env, computer, "deleted", laneKept ? "lane_kept" : null, now);
    captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "deleted", plan }, computer.instance_id, now);
    const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
    captureCloudAction(env, waitUntil, account.user_id, { action: "delete", plan, origin: "system", tier: tierOf(size) }, computer.instance_id, now);
    await sendStepEmail(env, waitUntil, account, computer, "deleted", idleDeletedEmail(computer, lane.branch, laneKept, now - fresh.state.since), now);
  } catch (error) {
    reportCloudFailure("cloud.idle_cleanup_run_failed", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : "unknown" });
    await restIfUnused(env, provider, fresh, wake);
    await markFailed(env, waitUntil, fresh, "run_failed", now);
  } finally {
    await unclaimSave(env, computer.instance_id, now);
  }
}

/**
 * The save didn't go through: the computer stays, goes back to rest if this
 * run woke it (and nobody started using it meanwhile), and the person is told
 * why and what to do. Each failure in a row doubles the wait before the next
 * try (1, 2, 4 ... days, at most 14). The email goes on the first failure
 * only; a retry that fails again just updates the reason and the next try.
 */
async function hold(env: CloudEnv, provider: CloudProvider, waitUntil: CloudWaitUntil, fresh: Fresh, reason: string, code: string, wake: WakeRecord, now: number): Promise<void> {
  const { computer, account, state } = fresh;
  await restIfUnused(env, provider, fresh, wake);
  const first = state.held == null;
  const count = (state.held?.count ?? 0) + 1;
  await env.DB.prepare(`
    update cloud_computers set idle_held_at = ?, idle_held_reason = ?, idle_held_count = ?, idle_failed_at = null, idle_failed_count = null
    where instance_id = ? and deleted_at is null
  `).bind(now, reason.slice(0, 300), count, computer.instance_id).run();
  const retryAt = now + backoffMs(HELD_RETRY_MS, HELD_RETRY_MAX_MS, count);
  if (USER_STATE_CODES.has(code)) logCloud("cloud.idle_cleanup_held", { instanceId: computer.instance_id, code, first, count });
  // Every hold is worth a look: a delete that should have happened didn't.
  reportCloudFailure(USER_STATE_CODES.has(code) ? "cloud.idle_cleanup_push_refused" : "cloud.idle_cleanup_save_failed", { instanceId: computer.instance_id, code, first, count });
  await logStep(env, computer, "push_refused", code, now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "push_refused", plan: planIdOf(account), reason: code }, computer.instance_id, now);
  if (first) await sendStepEmail(env, waitUntil, account, computer, "held", idleHeldEmail(computer, reason, retryAt, now), now);
}

/** The owner's daily report line: what the idle cleanup did on `day`, and how many computers it keeps now because their save failed. */
export async function idleCleanupReportLine(env: CloudEnv, day: string): Promise<string> {
  const start = Date.parse(`${day}T00:00:00Z`);
  const [steps, held] = await Promise.all([
    env.DB.prepare("select step, count(*) as n from cloud_idle_cleanup_log where created_at >= ? and created_at < ? group by step")
      .bind(start, start + DAY).all<{ step: string; n: number }>(),
    env.DB.prepare("select count(*) as n from cloud_computers where deleted_at is null and idle_held_at is not null").first<{ n: number }>(),
  ]);
  const count = new Map((steps.results ?? []).map((row) => [row.step, row.n]));
  const n = (step: string) => count.get(step) ?? 0;
  return `Idle cleanup: ${n("warned")} warned, ${n("emailed")} follow-up emails, ${n("saved")} saved, ${n("deleted")} deleted, ${n("push_refused")} not deleted because the save failed (${held?.n ?? 0} kept now), ${n("kept")} kept by their owner, ${n("failed")} ADE failures (an email or a delete; retried later).`;
}
