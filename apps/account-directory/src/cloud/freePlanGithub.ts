import { readGithubUser, type GithubUser } from "../githubApp/oauth";
import { githubAppRuntime, serveToken, type GithubAppEnv } from "../githubApp/grants";
import { captureCloudFreePlan, type CloudFreePlanStep, type CloudWaitUntil } from "./analytics";
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  cloudFreeGithubSentence,
  type CloudFreePlanGithub,
  type CloudFreePlanGithubState,
} from "./contract";
import { CLOUD_PLANS, FREE_INCLUDED_MILLI } from "./plans";
import { PAID_RULES_SQL, accountRules, isProduction, logCloud, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

/**
 * The GitHub rules of the free plan (README, "Referrals and the free plan"),
 * beside one free plan per computer (`freePlan.ts`):
 *
 * - Free hours need a connected GitHub account at least
 *   {@link CLOUD_FREE_GITHUB_MIN_AGE_DAYS} days old. ADE Cloud needs GitHub
 *   to clone anyway. No GitHub connected: no free hours yet.
 * - One free plan per GitHub account. `cloud_free_github_claims` has both
 *   keys unique, like the computer claims: a GitHub account gives its free
 *   plan to one ADE account, and an ADE account claims one GitHub account, so
 *   connecting another GitHub account later changes nothing (the first stays
 *   claimed, the second stays free for someone else).
 * - A card saved with no charge (`billing.ts` `createFreeUnlockUrl`)
 *   unlocks the hours early for a GitHub account that is too new. A paid plan
 *   before (a subscription on file) counts as a card.
 *
 * While a rule fails, the account's `free_github_hold` names it and the free
 * plan's hours are 0 (paid plans, earned hours and extra hours are untouched),
 * exactly as `free_refused_at` does for a shared computer. The hold is
 * settled on the account read, the referral read, and each create, copy, wake
 * and launch; the GitHub identity is the server's own (the grant), so a read
 * may claim too. When it clears, the free hours come back for this period.
 *
 * Edge cases:
 * - GitHub's `created_at` is read once and stored (`github_account_ages`):
 *   at the GitHub sign-in when `GET /user` names it, else at the first settle
 *   with the account's own token. A failed read is tried again with a backoff
 *   (5 minutes, doubling, at most 6 hours), and the account waits as
 *   `github_checking` meanwhile: never refused forever, never granted forever.
 * - A deleted or revoked GitHub account turns the grant `needs_reauth`: with
 *   no stored age that is `no_github` ("connect GitHub again"); an account
 *   that already claimed keeps its claim and its hours.
 * - Accounts that used ADE Cloud before these rules shipped are exempt
 *   (migration 0035 `free_github_exempt`); they still claim their GitHub
 *   account when they connect one, so it can't feed a new free plan.
 * - Two ADE accounts claiming one GitHub account at once settle to one claim
 *   (the primary key); the loser is held as `github_used`.
 * - A card removed, or a dispute, after an unlock changes nothing: the unlock
 *   stays (the GitHub claim still limits it to one free plan).
 * - Without the GitHub App configured (development, tests) nobody can connect
 *   GitHub, so the rules are off; in production that is reported.
 */

const DAY_MS = 24 * 60 * 60_000;
export const CLOUD_FREE_GITHUB_MIN_AGE_MS = CLOUD_FREE_GITHUB_MIN_AGE_DAYS * DAY_MS;
/** After a failed read of the GitHub account's age, the next try waits this long, doubling per failure. */
const AGE_RETRY_MIN_MS = 5 * 60_000;
const AGE_RETRY_MAX_MS = 6 * 60 * 60_000;

export type FreeGithubHold = "no_github" | "github_too_new" | "github_used" | "github_checking";
const HOLDS = new Set<string>(["no_github", "github_too_new", "github_used", "github_checking"]);

const FREE_RULES_SQL = `not ${PAID_RULES_SQL}`;

type Ctx = { now: number; waitUntil: CloudWaitUntil };

/** Stores a GitHub account's creation time; it never changes, so the first one stays. */
export async function recordGithubAccountCreated(db: D1Database, user: GithubUser, now: number): Promise<void> {
  if (user.createdAt == null) return;
  await db.prepare(`
    insert into github_account_ages (github_user_id, github_created_at, checked_at, next_check_at, failures) values (?, ?, ?, null, 0)
    on conflict (github_user_id) do update set github_created_at = coalesce(github_account_ages.github_created_at, excluded.github_created_at),
      checked_at = excluded.checked_at, next_check_at = null, failures = 0
  `).bind(user.id, user.createdAt, now).run();
}

type Facts = {
  own: number | null;
  github_user_id: number | null;
  github_login: string | null;
  grant_state: string | null;
  holder: string | null;
  github_created_at: number | null;
  next_check_at: number | null;
  failures: number | null;
};

async function readFacts(env: CloudEnv, userId: string): Promise<Facts> {
  const row = await env.DB.prepare(`
    select
      (select github_user_id from cloud_free_github_claims where user_id = ?) as own,
      g.github_user_id, g.github_login, g.state as grant_state,
      (select user_id from cloud_free_github_claims where github_user_id = g.github_user_id) as holder,
      a.github_created_at, a.next_check_at, a.failures
    from (select 1) one
    left join github_app_grants g on g.user_id = ?
    left join github_account_ages a on a.github_user_id = g.github_user_id
  `).bind(userId, userId).first<Facts>();
  return row ?? { own: null, github_user_id: null, github_login: null, grant_state: null, holder: null, github_created_at: null, next_check_at: null, failures: null };
}

let notConfiguredReported = false;

/** Whether the rules apply here: only where people can connect GitHub (the GitHub App is configured). */
async function rulesOn(env: CloudEnv): Promise<boolean> {
  const runtime = await githubAppRuntime(env as unknown as GithubAppEnv).catch(() => null);
  if (runtime) return true;
  if (isProduction(env) && !notConfiguredReported) {
    notConfiguredReported = true;
    reportCloudFailure("cloud.free_plan.github_not_configured", {}, "cloud-free-plan");
  }
  return false;
}

/** Whether the account's GitHub grant still gives a token: `unknown` when GitHub couldn't be asked. */
async function githubConnected(env: CloudEnv, userId: string, now: number): Promise<"live" | "disconnected" | "unknown"> {
  try {
    const runtime = await githubAppRuntime(env as unknown as GithubAppEnv);
    if (!runtime) return "unknown";
    const outcome = await serveToken(runtime, userId, { rejectedSha256: null }, now);
    if (outcome.kind === "token") return "live";
    if (outcome.kind === "not_connected" || outcome.kind === "needs_reauth") return "disconnected";
    return "unknown";
  } catch (error) {
    logCloud("cloud.free_plan.github_connected_check_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
    return "unknown";
  }
}

/**
 * Reads the GitHub account's creation time with the account's own token when
 * it isn't stored yet and a try is due. `null` when still unknown;
 * `"disconnected"` when the grant can't give a token (revoked, deleted).
 */
async function fetchGithubAge(env: CloudEnv, userId: string, facts: Facts, now: number): Promise<number | null | "disconnected"> {
  if (facts.github_user_id == null) return null;
  if (facts.next_check_at != null && facts.next_check_at > now) return null;
  const runtime = await githubAppRuntime(env as unknown as GithubAppEnv);
  if (!runtime) return null;
  const outcome = await serveToken(runtime, userId, { rejectedSha256: null }, now);
  if (outcome.kind === "not_connected" || outcome.kind === "needs_reauth") return "disconnected";
  let failure: string;
  if (outcome.kind === "token") {
    const read = await readGithubUser(runtime.config, outcome.token.accessToken);
    if (read.ok && read.user.id === facts.github_user_id && read.user.createdAt != null) {
      await recordGithubAccountCreated(env.DB, read.user, now);
      logCloud("cloud.free_plan.github_age_read", { userId });
      return read.user.createdAt;
    }
    if (read.ok && read.user.id !== facts.github_user_id) failure = "other_user";
    else failure = read.ok ? "no_created_at" : read.kind;
    if (!read.ok && read.kind === "invalid_token") return "disconnected";
  } else {
    failure = outcome.kind;
  }
  const failures = (facts.failures ?? 0) + 1;
  const wait = Math.min(AGE_RETRY_MAX_MS, AGE_RETRY_MIN_MS * 2 ** (failures - 1));
  await env.DB.prepare(`
    insert into github_account_ages (github_user_id, github_created_at, checked_at, next_check_at, failures) values (?, null, ?, ?, ?)
    on conflict (github_user_id) do update set checked_at = excluded.checked_at, next_check_at = excluded.next_check_at, failures = excluded.failures
    where github_account_ages.github_created_at is null
  `).bind(facts.github_user_id, now, now + wait, failures).run();
  reportCloudFailure("cloud.free_plan.github_age_failed", { userId, failure, failures }, "cloud-free-plan");
  return null;
}

const STEP_OF: Record<FreeGithubHold, CloudFreePlanStep> = {
  no_github: "github_missing",
  github_too_new: "github_too_new",
  github_used: "github_used",
  github_checking: "github_check_failed",
};

/** Moves the hold to `next` (and the free hours with it), once; logs and counts the change. */
async function applyHold(env: CloudEnv, account: AccountRow, next: FreeGithubHold | null, { now, waitUntil }: Ctx): Promise<void> {
  if ((account.free_github_hold ?? null) === next) return;
  const result = next
    ? await env.DB.prepare(`
      update cloud_accounts set free_github_hold = ?, included_milli = case when ${FREE_RULES_SQL} then 0 else included_milli end, updated_at = ?
      where user_id = ? and free_github_hold is not ?
    `).bind(next, now, account.user_id, next).run()
    : await env.DB.prepare(`
      update cloud_accounts set free_github_hold = null,
        included_milli = case when ${FREE_RULES_SQL} and free_refused_at is null then ? else included_milli end,
        warned_zero_at = null, hours_restored_at = case when warned_zero_at is not null then ? else hours_restored_at end, updated_at = ?
      where user_id = ? and free_github_hold is not null
    `).bind(FREE_INCLUDED_MILLI, now, now, account.user_id).run();
  if ((result.meta.changes ?? 0) !== 1) return;
  account.free_github_hold = next;
  logCloud(next ? "cloud.free_plan.github_held" : "cloud.free_plan.github_released", { userId: account.user_id, hold: next });
  captureCloudFreePlan(env, waitUntil, account.user_id, next ? STEP_OF[next] : "github_released", null, now);
}

/** Claims the account's GitHub account for its free plan. True when this account holds it after. */
async function claimGithub(env: CloudEnv, account: AccountRow, githubUserId: number, ctx: Ctx): Promise<boolean> {
  const inserted = await env.DB.prepare(`
    insert into cloud_free_github_claims (github_user_id, user_id, claimed_at) values (?, ?, ?)
    on conflict do nothing
  `).bind(githubUserId, account.user_id, ctx.now).run();
  const holder = await env.DB.prepare("select user_id from cloud_free_github_claims where github_user_id = ?").bind(githubUserId).first<{ user_id: string }>();
  const won = holder?.user_id === account.user_id;
  if (won && (inserted.meta.changes ?? 0) === 1) {
    logCloud("cloud.free_plan.github_claimed", { userId: account.user_id });
    captureCloudFreePlan(env, ctx.waitUntil, account.user_id, "github_claimed", null, ctx.now);
  }
  return won;
}

/**
 * Settles the GitHub rules for an account (see the top of this file). Runs
 * after the computer's settle and before the request's own hours check.
 * Never throws: a failure is reported and the request goes on as it would have.
 */
export async function settleFreePlanGithub(env: CloudEnv, account: AccountRow, ctx: Ctx): Promise<void> {
  try {
    await settle(env, account, ctx);
  } catch (error) {
    reportCloudFailure("cloud.free_plan.github_settle_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" }, "cloud-free-plan");
  }
}

async function settle(env: CloudEnv, account: AccountRow, ctx: Ctx): Promise<void> {
  // Paid accounts use no free hours: nothing to claim or hold. A hold left from the free plan stays until it is settled there.
  if (accountRules(account) !== "free") return;
  if (!(await rulesOn(env))) {
    // Turned off (no GitHub App here): a hold from before gives its hours back.
    if (account.free_github_hold != null) await applyHold(env, account, null, ctx);
    return;
  }
  const facts = await readFacts(env, account.user_id);
  if (facts.own != null) return applyHold(env, account, null, ctx);
  if (account.free_github_exempt === 1) {
    // Grandfathered: keeps its hours, and claims its GitHub account when free, so it can't feed a new free plan.
    if (facts.github_user_id != null && facts.holder == null) await claimGithub(env, account, facts.github_user_id, ctx);
    return applyHold(env, account, null, ctx);
  }
  if (facts.github_user_id == null) return applyHold(env, account, "no_github", ctx);
  if (facts.holder != null && facts.holder !== account.user_id) return applyHold(env, account, "github_used", ctx);
  let createdAt: number | null | "disconnected" = facts.github_created_at;
  if (createdAt == null) createdAt = await fetchGithubAge(env, account.user_id, facts, ctx.now);
  if (createdAt === "disconnected") return applyHold(env, account, "no_github", ctx);
  if (createdAt == null) return applyHold(env, account, facts.grant_state === "active" ? "github_checking" : "no_github", ctx);
  const cardOnFile = account.free_card_unlocked_at != null || account.stripe_subscription_id != null;
  if (ctx.now - createdAt < CLOUD_FREE_GITHUB_MIN_AGE_MS && !cardOnFile) return applyHold(env, account, "github_too_new", ctx);
  // A stored age outlives the connection: before the claim, the GitHub account must still be connected (not revoked or deleted).
  if (facts.grant_state !== "active") return applyHold(env, account, "no_github", ctx);
  const live = await githubConnected(env, account.user_id, ctx.now);
  if (live === "disconnected") return applyHold(env, account, "no_github", ctx);
  if (live === "unknown") return applyHold(env, account, "github_checking", ctx);
  // Old enough (or unlocked by a card): claim. Lost a race to another account at the same moment: refused.
  if (!(await claimGithub(env, account, facts.github_user_id, ctx))) return applyHold(env, account, "github_used", ctx);
  return applyHold(env, account, null, ctx);
}

/**
 * The dashboard's view of the GitHub rules, from what is stored (no GitHub
 * call). `ok` for a paid plan, an exempt account, and one that claimed.
 */
export async function freePlanGithubOf(env: CloudEnv, account: AccountRow): Promise<CloudFreePlanGithub> {
  const hold = account.free_github_hold != null && HOLDS.has(account.free_github_hold) ? account.free_github_hold as FreeGithubHold : null;
  if (!hold || accountRules(account) !== "free") {
    return { state: "ok", oldEnoughAt: null, canUnlockWithCard: false, githubLogin: null, sentence: null };
  }
  const state: CloudFreePlanGithubState = hold === "no_github" ? "no_github" : hold === "github_too_new" ? "too_new" : hold === "github_used" ? "used" : "checking";
  const facts = state === "too_new" || state === "used" ? await readFacts(env, account.user_id) : null;
  const oldEnoughAt = state === "too_new" && facts?.github_created_at != null ? facts.github_created_at + CLOUD_FREE_GITHUB_MIN_AGE_MS : null;
  return {
    state,
    oldEnoughAt,
    canUnlockWithCard: state === "too_new",
    githubLogin: facts?.github_login ?? null,
    sentence: cloudFreeGithubSentence(state, { oldEnoughAt, plusIncludedMilli: CLOUD_PLANS.plus.includedMilli }),
  };
}

/** Marks the account unlocked by a saved card (once), then settles the rules so the hours come back now. */
export async function unlockFreePlanWithCard(env: CloudEnv, account: AccountRow, source: "checkout" | "card_on_file", ctx: Ctx): Promise<boolean> {
  const result = await env.DB.prepare("update cloud_accounts set free_card_unlocked_at = ?, updated_at = ? where user_id = ? and free_card_unlocked_at is null")
    .bind(ctx.now, ctx.now, account.user_id).run();
  const changed = (result.meta.changes ?? 0) === 1;
  if (changed) {
    account.free_card_unlocked_at = ctx.now;
    logCloud("cloud.free_plan.card_unlocked", { userId: account.user_id, source });
    captureCloudFreePlan(env, ctx.waitUntil, account.user_id, "card_unlocked", null, ctx.now);
  }
  await settleFreePlanGithub(env, account, ctx);
  return changed;
}
