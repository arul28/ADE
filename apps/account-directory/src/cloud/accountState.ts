import { PHONE_CREDIT_MILLI_PER_MINUTE, liveUsedWithPhones } from "./credits";
import { requestCountry, smallUsesNoHours, sponsoredAccountState } from "./gravity";
import { timedWakesCancelledOf } from "./accountNotices";
import type { CloudAccountState } from "./contract";
import { RECENT_USE_DAYS, recentUsedMilli } from "./diskUsage";
import { freePlanOf } from "./freePlan";
import { freePlanGithubOf } from "./freePlanGithub";
import { idleCleanupEntries } from "./idleCleanup";
import { planCleanupState } from "./planCleanup";
import { cloudCatalog, isMeteredStatus, nextPlanOffer } from "./plans";
import { readSummaryRow, referralSummary } from "./referrals";
import { phoneAccountState } from "./phones";
import {
  cloudOffers,
  computerLimitOf,
  computerLimitPlanOf,
  countedComputers,
  countedDiskGb,
  earnedDrawMilli,
  earnedLeftForLimits,
  extraActiveForLimits,
  extraUsedMilli,
  hoursState,
  includedMilliOf,
  listComputers,
  liveUsedMilli,
  loadAccount,
  percentUsed,
  reportCloudFailure,
  shownPlanIdOf,
  shownRulesOf,
  type AccountRow,
  type CloudEnv,
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
/** The most deleted ids one account read returns; a heavier churn keeps its newest rows only. */
const DELETED_IDS_LIMIT = 200;

async function recentlyDeletedInstanceIds(env: CloudEnv, userId: string, now: number): Promise<string[]> {
  const rows = await env.DB.prepare(`
    select c.instance_id from cloud_computers c
    where c.user_id = ? and c.deleted_at is not null and c.deleted_at >= ?
    order by c.deleted_at desc
    limit ?
  `).bind(userId, now - DELETED_REPORTED_MS, DELETED_IDS_LIMIT).all<{ instance_id: string }>();
  return (rows.results ?? []).map((row) => row.instance_id);
}

export async function buildAccountState(env: CloudEnv, userId: string, now: number, request?: Request): Promise<CloudAccountState> {
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
  const freeGithub = await freePlanGithubOf(env, account).catch((error: unknown) => {
    reportCloudFailure("cloud.free_plan.github_view_failed", { userId, message: error instanceof Error ? error.message : "unknown" }, "cloud-free-plan");
    return undefined;
  });
  // A running credits phone's minutes its provider hasn't billed yet count now, as the limits count them.
  const live = await liveUsedWithPhones(env, account, now);
  // What the person sees follows the account test tool's plan (`ownerAccounts.ts`); billing below stays the real plan.
  const rules = shownRulesOf(account);
  const shownPlan = shownPlanIdOf(account);
  const included = includedMilliOf(account);
  // The same total the wake rule and the limits use: a move's source stays out while the move runs.
  const diskUsed = countedDiskGb(computers);
  const offers = cloudOffers(env);
  // The idle cleanup's warnings, and computers it kept because their work couldn't be saved.
  const due = idleCleanupEntries(account, computers, live, now);
  // Sponsored cards (`gravity.ts`): left out while the switch doesn't reach the account. A read that fails never costs the account read.
  const sponsored = await sponsoredAccountState(env, account, request ? requestCountry(request) : null, now).catch((error: unknown) => {
    reportCloudFailure("cloud.sponsored.state_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
    return undefined;
  });
  return {
    ...(sponsored ? { sponsored } : {}),
    credits: { phoneMilliPerMinute: PHONE_CREDIT_MILLI_PER_MINUTE },
    plan: shownPlan === "free" ? "free" : "paid",
    rules,
    planId: shownPlan,
    hours: {
      includedMilli: included,
      usedMilli: live,
      leftMilli: Math.max(0, included - live),
      percentUsed: percentUsed(account, live),
      state: hoursState(account, live),
    },
    extraHours: {
      available: rules === "paid",
      enabled: extraActiveForLimits(account),
      usedMilli: extraUsedMilli(account, live),
    },
    earnedHours: {
      leftMilli: earnedLeftForLimits(account, live),
      usedThisPeriodMilli: earnedDrawMilli(account, live),
      grantedMilli: account.earned_granted_milli,
    },
    freePlan: { ...freePlanOf(account, growth?.has_claim === 1), ...(freeGithub ? { github: freeGithub } : {}) },
    ...(referral ? { referral } : {}),
    // D1 only: the account read is polled, and never asks NoMac.
    phone: await phoneAccountState(env, account, now).catch((error: unknown) => {
      reportCloudFailure("cloud.phone_account_state_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
      return undefined;
    }),
    // No account-wide disk since Pricing v2: each size has its own maximum.
    disk: { usedGb: diskUsed, limitGb: null },
    computers: {
      // What the computer limit counts (`accountComputerCountSql`), so the count and a refusal agree.
      total: countedComputers(computers, now),
      awake: computers.filter((computer) => isMeteredStatus(computer.status)).length,
      limit: computerLimitOf(account),
      // What the limit card offers: the same answer a `computer_limit` refusal carries.
      nextPlan: nextPlanOffer(computerLimitPlanOf(account), offers),
    },
    recentUse: { days: RECENT_USE_DAYS, usedMilli: recentMilli },
    dueForDeletion: due,
    deletedInstanceIds,
    // Small's rate is the account's own: half a Medium-hour on Free with no sponsored cards (`gravity.ts` `smallUsesNoHours`).
    catalog: cloudCatalog(offers, shownPlan, { smallUsesHours: !(await smallUsesNoHours(env, account)) }),
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
