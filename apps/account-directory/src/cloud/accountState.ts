import { timedWakesCancelledOf } from "./accountNotices";
import type { CloudAccountState } from "./contract";
import { RECENT_USE_DAYS, recentUsedMilli } from "./diskUsage";
import { freePlanOf } from "./freePlan";
import { planCleanupState } from "./planCleanup";
import { CENT_MICROS, cloudCatalog, isMeteredStatus } from "./plans";
import { readSummaryRow, referralSummary } from "./referrals";
import {
  DELETION_WARNING_LATE_MS,
  accountRules,
  boughtPlanIdOf,
  cloudOffers,
  computerLimit,
  countedDiskGb,
  deletionDueAt,
  earnedDrawMilli,
  earnedLeftMilli,
  extraActive,
  extraDiskMicrosThisPeriod,
  extraUsedMilli,
  hoursState,
  isPendingId,
  listComputers,
  liveUsedMilli,
  loadAccount,
  percentUsed,
  planFacts,
  reportCloudFailure,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * `GET /cloud/account`: everything the dashboard, `ade cloud status` and MCP
 * read about an account, in one answer. This is the coordinator over the
 * store and the features built on it (free plan, referrals, plan cleanup,
 * timed-wake notices), so none of them imports the others through the store.
 */

const BILLING_RESTORED_NOTICE_MS = 3 * 24 * 60 * 60_000;

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
  const [computers, deletedInstanceIds, recentMilli, growth] = await Promise.all([
    listComputers(env, userId),
    recentlyDeletedInstanceIds(env, userId, now),
    recentUsedMilli(env, userId, now),
    // A summary that can't be read or built (D1, Clerk, a code clash) never costs the account read its answer.
    readSummaryRow(env, userId).catch((error: unknown) => {
      reportCloudFailure("cloud.referral.summary_read_failed", { userId, message: error instanceof Error ? error.message : "unknown" }, "cloud-referrals");
      return null;
    }),
  ]);
  const referral = growth ? await referralSummary(env, account, now, growth).catch((error: unknown) => {
    reportCloudFailure("cloud.referral.summary_failed", { userId, message: error instanceof Error ? error.message : "unknown" }, "cloud-referrals");
    return null;
  }) : null;
  const live = liveUsedMilli(account, computers, now);
  const rules = accountRules(account);
  const plan = planFacts(account);
  // The same total the wake rule and the limits use: a move's source stays out while the move runs.
  const diskUsed = countedDiskGb(computers);
  const offers = cloudOffers(env);
  const extraDiskMicros = offers.extraDisk && rules === "paid" && account.extra_disk_state === "on" ? await extraDiskMicrosThisPeriod(env, account) : 0;
  const due = computers
    .filter((computer) => !isPendingId(computer.instance_id))
    .map((computer) => ({ computer, deletesAt: deletionDueAt(computer, account, live) }))
    .filter((entry): entry is { computer: ComputerRow; deletesAt: number } => entry.deletesAt != null && entry.deletesAt - now <= DELETION_WARNING_LATE_MS)
    .sort((a, b) => a.deletesAt - b.deletesAt)
    .map(({ computer, deletesAt }) => ({ instanceId: computer.instance_id, name: computer.name, deletesAt }));
  return {
    plan: account.plan,
    rules,
    planId: boughtPlanIdOf(account),
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
      usedMilli: extraUsedMilli(account, live),
    },
    earnedHours: {
      leftMilli: earnedLeftMilli(account, live),
      usedThisPeriodMilli: earnedDrawMilli(account, live),
      grantedMilli: account.earned_granted_milli,
    },
    freePlan: freePlanOf(account, growth?.has_claim === 1),
    ...(referral ? { referral } : {}),
    ...(offers.extraDisk ? {
      extraDisk: {
        available: rules === "paid",
        state: account.extra_disk_state,
        monthlyLimitCents: account.extra_disk_limit_cents,
        usedCents: Math.floor(extraDiskMicros / CENT_MICROS),
      },
    } : {}),
    disk: { usedGb: diskUsed, limitGb: plan.diskGb },
    computers: {
      total: computers.length,
      awake: computers.filter((computer) => isMeteredStatus(computer.status)).length,
      limit: computerLimit(account),
    },
    recentUse: { days: RECENT_USE_DAYS, usedMilli: recentMilli },
    dueForDeletion: due,
    deletedInstanceIds,
    catalog: cloudCatalog(offers),
    billing: {
      periodStart: account.period_start,
      periodEnd: account.period_end,
      stripeStatus: account.stripe_status,
      cancelAtPeriodEnd: account.cancel_at_period_end === 1,
      nextPlanId: account.plan === "paid" ? account.paid_plan_next : null,
      notice: billingNotice(account, now),
    },
    // What a cheaper plan's limits free, before and after (`planCleanup.ts`), and cancelled timed wakes.
    ...planCleanupState(env, account, computers, now),
    timedWakesCancelled: timedWakesCancelledOf(account),
  };
}
