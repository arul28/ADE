import { captureCloudAction, captureCloudIdleCleanup, type CloudIdleCleanupEvent, type CloudWaitUntil } from "./analytics";
import {
  CLOUD_IGNORED_FILES_MAX_PATHS,
  IDLE_CLEANUP_HELD_NEXT,
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
 * swept, and a computer that is awake is never idle.
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
 * is told why (in-app and by email) and ADE tries again a day later. Each
 * email is claimed with a conditional write before it is sent, so
 * overlapping ticks send it once.
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
  free: { afterMs: 3 * DAY, leadMs: DAY, lastEmailMs: 6 * HOUR, afterLastEmailMs: 5 * HOUR, days: 3 },
  paid: { afterMs: 10 * DAY, leadMs: 3 * DAY, lastEmailMs: DAY, afterLastEmailMs: 20 * HOUR, days: 10 },
};

/** The commit message for work the computer hadn't committed. */
export const IDLE_CLEANUP_COMMIT_MESSAGE = "saved by ADE before cleanup";
/** A tick a little early still counts for an email due now. */
const EMAIL_SLACK_MS = 30 * MINUTE;
/** A computer kept because its save failed is tried again after this long. */
const HELD_RETRY_MS = DAY;
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
  | "idle_warned_at" | "idle_deletes_at" | "idle_emailed_at" | "idle_kept_at" | "idle_held_at" | "idle_held_reason">;

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
  /** The save failed and the computer was kept; tried again at `retryAt`. */
  held: { at: number; reason: string; retryAt: number } | null;
};

/**
 * Where a computer stands in the idle cleanup, or null when it isn't idle:
 * awake or on its way there, or the account is out of hours (nobody loses a
 * computer just for running out).
 */
export function idleStateOf(computer: IdleColumns, account: AccountRow, liveUsed: number, now: number): IdleState | null {
  if (isPendingId(computer.instance_id) || computer.awake_since != null || !isRestingStatus(computer.status) || isOutOfHours(account, liveUsed)) return null;
  const rule = idleRuleOf(account);
  const since = idleSinceOf(computer, account);
  const ruleDue = since + rule.afterMs;
  const warned = computer.idle_warned_at != null && computer.idle_warned_at >= since && computer.idle_deletes_at != null;
  const announcedAt = warned ? computer.idle_deletes_at! : 0;
  const deletesAt = Math.max(ruleDue, announcedAt);
  const announced = warned && announcedAt >= ruleDue;
  const heldValid = computer.idle_held_at != null && computer.idle_held_at >= since;
  const held = heldValid ? { at: computer.idle_held_at!, reason: computer.idle_held_reason ?? "ADE couldn't save its work.", retryAt: computer.idle_held_at! + HELD_RETRY_MS } : null;
  const lastEmailDue = deletesAt - rule.lastEmailMs;
  const emailed = warned ? computer.idle_emailed_at ?? null : null;
  const nextEmailAt = emailed == null ? Infinity : rule === IDLE_CLEANUP.free ? lastEmailDue : emailed + DAY - EMAIL_SLACK_MS;
  const needsWarning = !held && !announced && now >= deletesAt - rule.leadMs;
  const needsFollowUp = !held && announced && emailed != null && emailed < lastEmailDue - EMAIL_SLACK_MS && now >= Math.min(nextEmailAt, lastEmailDue);
  const deleteReady = !held && announced && now >= deletesAt && emailed != null
    && emailed >= lastEmailDue - EMAIL_SLACK_MS && now - emailed >= rule.afterLastEmailMs;
  return { since, rule, deletesAt: held ? Math.max(deletesAt, held.retryAt) : deletesAt, announced, needsWarning, needsFollowUp, deleteReady, held };
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
        held: state.held ? { at: state.held.at, reason: state.held.reason } : null,
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
  const paths = record.paths
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, MAX_PATH_CHARS))
    .filter(Boolean);
  if (paths.length !== record.paths.length) return null;
  const kept = paths.slice(0, CLOUD_IGNORED_FILES_MAX_PATHS);
  return { checkedAt, paths: kept, more: more + (paths.length - kept.length), rebuildable };
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

/** The email when the save didn't go through and the computer was kept. */
export function idleHeldEmail(computer: ComputerRow, reason: string): { subject: string; text: string } {
  const label = labelOf(computer);
  return {
    subject: `ADE Cloud didn't delete ${computer.lane_name ?? computer.name ?? "your computer"}: its work couldn't be saved`,
    text: [
      `${label} was due to be deleted because it hasn't been used, but ADE couldn't commit and push its work to GitHub first, so it kept the computer.`,
      `Why: ${reason}`,
      IDLE_CLEANUP_HELD_NEXT,
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

async function sendStepEmail(env: CloudEnv, computer: ComputerRow, email: { subject: string; text: string }): Promise<"sent" | "skipped" | "failed"> {
  const result = await sendCloudEmail(env, { userId: computer.user_id, ...email });
  if (result === "failed") reportCloudFailure("cloud.idle_cleanup_email_failed", { instanceId: computer.instance_id });
  return result;
}

/** The first warning, claimed with the row as it was read so overlapping ticks send it once. */
async function warn(env: CloudEnv, waitUntil: CloudWaitUntil, account: AccountRow, computer: ComputerRow, state: IdleState, now: number): Promise<void> {
  // The full lead, even when this tick is late: the person always has the plan's warning time.
  const deletesAt = Math.max(state.deletesAt, now + state.rule.leadMs);
  const claimed = await env.DB.prepare(`
    update cloud_computers set idle_warned_at = ?, idle_deletes_at = ?, idle_emailed_at = ?, idle_held_at = null, idle_held_reason = null
    where instance_id = ? and deleted_at is null and idle_warned_at is ? and idle_deletes_at is ?
  `).bind(now, deletesAt, now, computer.instance_id, computer.idle_warned_at ?? null, computer.idle_deletes_at ?? null).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  computer.idle_warned_at = now;
  computer.idle_deletes_at = deletesAt;
  computer.idle_emailed_at = now;
  logCloud("cloud.idle_cleanup_warned", { instanceId: computer.instance_id, deletesAt });
  await logStep(env, computer, "warned", state.rule === IDLE_CLEANUP.free ? "free" : "paid", now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "warned", plan: planIdOf(account) }, computer.instance_id, now);
  // A failed send keeps the warning (it shows in ADE); the follow-ups and the delete still wait on their own times.
  await sendStepEmail(env, computer, idleWarningEmail(computer, { since: state.since, deletesAt }, now));
}

/** A follow-up email, claimed on the last email's time; a send that fails gives the claim back for the next tick. */
async function followUp(env: CloudEnv, waitUntil: CloudWaitUntil, account: AccountRow, computer: ComputerRow, state: IdleState, now: number): Promise<void> {
  const before = computer.idle_emailed_at ?? null;
  const claimed = await env.DB.prepare("update cloud_computers set idle_emailed_at = ? where instance_id = ? and deleted_at is null and idle_emailed_at is ? and idle_warned_at is ?")
    .bind(now, computer.instance_id, before, computer.idle_warned_at ?? null).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  computer.idle_emailed_at = now;
  const result = await sendStepEmail(env, computer, idleWarningEmail(computer, state, now));
  if (result === "failed") {
    await env.DB.prepare("update cloud_computers set idle_emailed_at = ? where instance_id = ? and idle_emailed_at = ?").bind(before, computer.instance_id, now).run();
    computer.idle_emailed_at = before;
    return;
  }
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
    update cloud_computers set idle_kept_at = ?, idle_warned_at = null, idle_deletes_at = null, idle_emailed_at = null, idle_held_at = null, idle_held_reason = null
    where instance_id = ? and deleted_at is null
  `).bind(now, computer.instance_id).run();
  logCloud("cloud.idle_cleanup_kept", { instanceId: computer.instance_id, how: "button", warned });
  await logStep(env, computer, "kept", "button", now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "kept", plan: planIdOf(account), how: "button" }, computer.instance_id, now);
}

/**
 * A warning or a kept state the person moved past (they used the computer,
 * or hours came back) is cleared, and counted as kept. Free wakes don't move
 * `last_awake_at`, so a save in flight never clears its own warning.
 */
async function clearMovedPast(env: CloudEnv, waitUntil: CloudWaitUntil, now: number): Promise<void> {
  const rows = (await env.DB.prepare(`
    select c.instance_id, c.user_id, c.idle_warned_at, c.idle_held_at, a.plan, a.stripe_status, a.paid_plan,
      case when coalesce(a.hours_restored_at, 0) > coalesce(c.idle_warned_at, c.idle_held_at)
        and coalesce(c.last_awake_at, c.created_at) <= coalesce(c.idle_warned_at, c.idle_held_at) then 'hours_back' else 'used' end as how
    from cloud_computers c join cloud_accounts a on a.user_id = c.user_id
    where c.deleted_at is null and (c.idle_warned_at is not null or c.idle_held_at is not null)
      and (c.idle_claimed_at is null or c.idle_claimed_at < ?)
      and (coalesce(c.last_awake_at, c.created_at) > coalesce(c.idle_warned_at, c.idle_held_at)
        or coalesce(a.hours_restored_at, 0) > coalesce(c.idle_warned_at, c.idle_held_at))
  `).bind(now - CLAIM_STALE_MS).all<{ instance_id: string; user_id: string; idle_warned_at: number | null; idle_held_at: number | null; plan: "free" | "paid"; stripe_status: string | null; paid_plan: AccountRow["paid_plan"]; how: "used" | "hours_back" }>()).results ?? [];
  for (const row of rows) {
    const cleared = await env.DB.prepare(`
      update cloud_computers set idle_warned_at = null, idle_deletes_at = null, idle_emailed_at = null, idle_held_at = null, idle_held_reason = null
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
 * computers whose time came. With no idle computer, two indexed reads.
 */
export async function runIdleCleanup(env: CloudEnv, provider: CloudProvider, now = Date.now(), waitUntil?: CloudWaitUntil): Promise<void> {
  await clearMovedPast(env, waitUntil, now);
  const candidates = ((await env.DB.prepare(`
    select * from cloud_computers
    where deleted_at is null and awake_since is null and coalesce(last_awake_at, created_at) <= ?
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
        else if ((state.deleteReady || (state.held && now >= state.held.retryAt)) && budget > 0) {
          budget -= 1;
          runs.push(saveAndDelete(env, provider, waitUntil, computer, now));
        }
      }
    } catch (error) {
      reportCloudFailure("cloud.idle_cleanup_account_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  await Promise.all(runs);
}

type Fresh = { computer: ComputerRow; account: AccountRow; state: IdleState };

/** The computer and its account read again, when its save is still due: the tick's read can be a minute old. */
async function freshDue(env: CloudEnv, instanceId: string, now: number): Promise<Fresh | null> {
  const computer = await env.DB.prepare("select * from cloud_computers where instance_id = ? and deleted_at is null").bind(instanceId).first<ComputerRow>();
  if (!computer || !cloudAccessAllows(env, computer.user_id)) return null;
  const [account, owned] = await Promise.all([
    env.DB.prepare("select * from cloud_accounts where user_id = ? and deleted_at is null").bind(computer.user_id).first<AccountRow>(),
    env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null").bind(computer.user_id).all<ComputerRow>(),
  ]);
  if (!account) return null;
  const state = idleStateOf(computer, account, liveUsedMilli(account, owned.results ?? [], now), now);
  if (!state || !(state.deleteReady || (state.held && now >= state.held.retryAt))) return null;
  return { computer, account, state };
}

/**
 * Whether the person came back while the save ran: used it (a wake that
 * counts moves `last_awake_at`), pressed Keep it, got hours back, or deleted
 * it. The free wake of the save itself changes none of these.
 */
async function cameBack(env: CloudEnv, fresh: Fresh): Promise<boolean> {
  const [row, account] = await Promise.all([
    env.DB.prepare("select last_awake_at, idle_kept_at, deleted_at from cloud_computers where instance_id = ?").bind(fresh.computer.instance_id)
      .first<Pick<ComputerRow, "last_awake_at" | "idle_kept_at" | "deleted_at">>(),
    env.DB.prepare("select hours_restored_at, deleted_at from cloud_accounts where user_id = ?").bind(fresh.account.user_id)
      .first<Pick<AccountRow, "hours_restored_at" | "deleted_at">>(),
  ]);
  return !row || row.deleted_at != null || !account || account.deleted_at != null
    || (row.last_awake_at ?? null) !== (fresh.computer.last_awake_at ?? null)
    || (row.idle_kept_at ?? null) !== (fresh.computer.idle_kept_at ?? null)
    || (account.hours_restored_at ?? null) !== (fresh.account.hours_restored_at ?? null);
}

/** One computer: claimed, its work saved from the computer itself, then deleted with its lane kept; or kept with the reason. */
async function saveAndDelete(env: CloudEnv, provider: CloudProvider, waitUntil: CloudWaitUntil, snapshot: ComputerRow, now: number): Promise<void> {
  const claimed = await env.DB.prepare(`
    update cloud_computers set idle_claimed_at = ?
    where instance_id = ? and deleted_at is null and (idle_claimed_at is null or idle_claimed_at < ?)
  `).bind(now, snapshot.instance_id, now - CLAIM_STALE_MS).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  const wake: WakeRecord = { woke: false, from: snapshot.status };
  try {
    // Never woken for nothing.
    const fresh = await freshDue(env, snapshot.instance_id, now);
    if (!fresh) return;
    const { computer, account } = fresh;
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
    if (await cameBack(env, fresh)) {
      if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from, "idle_cleanup");
      logCloud("cloud.idle_cleanup_came_back", { instanceId: computer.instance_id });
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
      if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from, "idle_cleanup");
      // Its work is saved; the next tick tries the delete again.
      reportCloudFailure("cloud.idle_cleanup_delete_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      return;
    }
    logCloud("cloud.idle_cleanup_deleted", { instanceId: computer.instance_id, keptLane: laneKept });
    await logStep(env, computer, "deleted", laneKept ? "lane_kept" : null, now);
    captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "deleted", plan }, computer.instance_id, now);
    const size = cloudSizeFor(computer.type, computer.cpu, computer.memory_gb);
    captureCloudAction(env, waitUntil, account.user_id, { action: "delete", plan, origin: "system", tier: tierOf(size) }, computer.instance_id, now);
    await sendStepEmail(env, computer, idleDeletedEmail(computer, lane.branch, laneKept, now - fresh.state.since));
  } catch (error) {
    reportCloudFailure("cloud.idle_cleanup_run_failed", { instanceId: snapshot.instance_id, message: error instanceof Error ? error.message : "unknown" });
    if (wake.woke) await putBackToRest(env, provider, snapshot.instance_id, wake.from, "idle_cleanup");
  } finally {
    await env.DB.prepare("update cloud_computers set idle_claimed_at = null where instance_id = ? and idle_claimed_at = ?").bind(snapshot.instance_id, now).run()
      .catch((error: unknown) => reportCloudFailure("cloud.idle_cleanup_unclaim_failed", { message: error instanceof Error ? error.message : "unknown" }));
  }
}

/**
 * The save didn't go through: the computer stays, goes back to rest if this
 * run woke it, and the person is told why and what to do. The email goes on
 * the first failure only; a retry that fails again just updates the reason.
 */
async function hold(env: CloudEnv, provider: CloudProvider, waitUntil: CloudWaitUntil, fresh: Fresh, reason: string, code: string, wake: WakeRecord, now: number): Promise<void> {
  const { computer, account, state } = fresh;
  if (wake.woke) await putBackToRest(env, provider, computer.instance_id, wake.from, "idle_cleanup");
  const first = state.held == null;
  await env.DB.prepare("update cloud_computers set idle_held_at = ?, idle_held_reason = ? where instance_id = ? and deleted_at is null")
    .bind(now, reason.slice(0, 300), computer.instance_id).run();
  if (USER_STATE_CODES.has(code)) logCloud("cloud.idle_cleanup_held", { instanceId: computer.instance_id, code, first });
  // Every hold is worth a look: a delete that should have happened didn't.
  reportCloudFailure(USER_STATE_CODES.has(code) ? "cloud.idle_cleanup_push_refused" : "cloud.idle_cleanup_save_failed", { instanceId: computer.instance_id, code, first });
  await logStep(env, computer, "push_refused", code, now);
  captureCloudIdleCleanup(env, waitUntil, account.user_id, { step: "push_refused", plan: planIdOf(account), reason: code }, computer.instance_id, now);
  if (first) await sendStepEmail(env, computer, idleHeldEmail(computer, reason));
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
  return `Idle cleanup: ${n("warned")} warned, ${n("emailed")} follow-up emails, ${n("saved")} saved, ${n("deleted")} deleted, ${n("push_refused")} not deleted because the save failed (${held?.n ?? 0} kept now), ${n("kept")} kept by their owner.`;
}
