import { closeLaneSharesForAccount } from "./laneShares/routes";
import { deleteAccountProjects } from "./accountProjects/store";
import { deleteGithubAppAccount, type GithubAppEnv } from "./githubApp/grants";
import { deleteCloudAccount } from "./cloud/accountDeletion";
import { CLOUD_EDGE_PATHS } from "./cloud/contract";
import { presentsEventWakeSecret } from "./cloud/eventWakes";
import { fail, json } from "./cloud/http";
import { reportCloudFailure } from "./cloud/store";
import { deleteWelcomeEmailRows } from "./welcomeEmail";
import type { SignupAnalyticsEnv } from "./signupAnalytics";

/**
 * Deleting an account (Clerk `user.deleted`) from this Worker's data, and
 * doing it again until no sign-in token from before the deletion can work.
 *
 * Clerk's tokens are checked offline here (`callerToken.ts`), so a token
 * stays valid until it expires even after Clerk deletes the user: a session
 * token for about a minute, a device sign-in's OAuth token for about an hour.
 * A computer still signed in can write rows again in that time (its machine
 * row on its next heartbeat, its projects, its lanes). So the webhook records
 * the account in `account_erasures`, and the minute cron runs the whole
 * deletion again 15 minutes, 75 minutes, 3 hours and 24 hours after it. Each
 * step is safe to repeat. After the last run the account ID is gone from the
 * list too. The webhook relay reads the list in that day to purge its own
 * rows (`handleDeletedAccountsList`).
 */

export type AccountErasureEnv = SignupAnalyticsEnv & { DB: D1Database };

/** When the deletion runs again, from the moment the account was deleted. */
export const ACCOUNT_ERASURE_REPEATS_MS = [15 * 60_000, 75 * 60_000, 3 * 3_600_000, 24 * 3_600_000] as const;
/** A claimed run holds its account this long; a run that dies is tried again after it. Longer than a tick may run. */
const ERASURE_LEASE_MS = 15 * 60_000;
/** A failed run is tried again after this long, doubled for each failure in a row, up to `ERASURE_RETRY_MAX_MS`. */
const ERASURE_RETRY_MS = 5 * 60_000;
const ERASURE_RETRY_MAX_MS = 6 * 3_600_000;
/** A deletion that still fails this long after it is given up, with one report: a failure that lasts is a setup to fix. */
const ERASURE_GIVE_UP_MS = 7 * 24 * 3_600_000;
/**
 * Accounts the cron runs in one tick. A run is about a hundred statements and
 * shares the tick's query budget with the ADE Cloud cron; deletions are rare,
 * so the rest wait a minute.
 */
const ERASURES_PER_TICK = 2;
/** The most accounts one list answers, newest first; a day of deletions is far below it. */
const DELETED_ACCOUNTS_LIST_MAX = 1_000;

/** The step that failed, as the webhook answers it, so Clerk delivers again. */
export type AccountErasureFailure = { error: string };

type ErasureStep = {
  error: string;
  event: string;
  area?: string;
  /** The failure report names the account (the welcome email's never did). */
  namesUser: boolean;
  run: (env: AccountErasureEnv, userId: string) => Promise<unknown>;
};

/**
 * In this order. Lane shares first: one D1 write that must not wait on the
 * provider calls of the ADE Cloud step. ADE Cloud last: it ends with the push
 * relay's purge, after the computers that could write sign-ins back are gone.
 */
const ERASURE_STEPS: readonly ErasureStep[] = [
  { error: "lane_share_close_failed", event: "lane_share.account_close_failed", namesUser: true, run: (env, userId) => closeLaneSharesForAccount({ DB: env.DB }, userId) },
  // The getting-started email's row and opt-out.
  { error: "welcome_email_delete_failed", event: "welcome_email.account_delete_failed", area: "signup", namesUser: false, run: (env, userId) => deleteWelcomeEmailRows(env.DB, userId) },
  // The project list, folder paths included.
  { error: "account_project_delete_failed", event: "account_project.account_delete_failed", area: "account_projects", namesUser: true, run: (env, userId) => deleteAccountProjects(env.DB, userId) },
  // The GitHub App grant: its token is deleted at GitHub where the secrets allow (best effort), then the rows go.
  { error: "github_app_delete_failed", event: "github_app.account_delete_failed", area: "github_app", namesUser: true, run: (env, userId) => deleteGithubAppAccount(env as GithubAppEnv, userId) },
  { error: "cloud_delete_failed", event: "cloud.account_delete_failed", namesUser: true, run: (env, userId) => deleteCloudAccount(env, userId) },
];

/**
 * Every step, in order. A step that throws is reported, and the rest still
 * run: no step needs an earlier one, and a failure that lasts in one must not
 * keep the others from deleting. The answer names the first failure.
 */
export async function eraseAccountData(env: AccountErasureEnv, userId: string): Promise<AccountErasureFailure | null> {
  let failure: AccountErasureFailure | null = null;
  for (const step of ERASURE_STEPS) {
    try {
      await step.run(env, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      reportCloudFailure(step.event, step.namesUser ? { userId, message } : { message }, step.area);
      failure ??= { error: step.error };
    }
  }
  return failure;
}

/** The webhook's record of a deletion, before its first run. A repeat delivery keeps the first. */
export async function recordAccountErasure(db: D1Database, userId: string, now: number): Promise<void> {
  await db.prepare("insert or ignore into account_erasures (user_id, deleted_at, runs, next_run_at) values (?, ?, 0, ?)")
    .bind(userId, now, now + ACCOUNT_ERASURE_REPEATS_MS[0]).run();
}

type ErasureRow = { user_id: string; deleted_at: number; runs: number; next_run_at: number; failures: number };

/**
 * The minute cron's share: the accounts whose next run is due. Each is
 * claimed first (its next run moves on by `ERASURE_LEASE_MS`), so two
 * overlapping ticks never run one account twice, and a tick that dies
 * mid-run leaves it due again later. A failed run waits longer each time;
 * after `ERASURE_GIVE_UP_MS` the account leaves the list with one report.
 * One indexed read when none is due.
 */
export async function runAccountErasureRepeats(env: AccountErasureEnv, now: number): Promise<void> {
  const due = (await env.DB.prepare(`
    select user_id, deleted_at, runs, next_run_at, failures from account_erasures
    where next_run_at is not null and next_run_at <= ? order by next_run_at limit ?
  `).bind(now, ERASURES_PER_TICK).all<ErasureRow>()).results ?? [];
  for (const row of due) {
    const claimed = await env.DB.prepare("update account_erasures set next_run_at = ? where user_id = ? and next_run_at = ?")
      .bind(now + ERASURE_LEASE_MS, row.user_id, row.next_run_at).run();
    if ((claimed.meta?.changes ?? 0) === 0) continue;
    const failure = await eraseAccountData(env, row.user_id);
    if (failure) {
      if (now - row.deleted_at >= ERASURE_GIVE_UP_MS) {
        reportCloudFailure("account.erasure_gave_up", { userId: row.user_id, error: failure.error, failures: row.failures + 1 });
        await env.DB.prepare("delete from account_erasures where user_id = ?").bind(row.user_id).run();
        continue;
      }
      const wait = Math.min(ERASURE_RETRY_MS * 2 ** Math.min(row.failures, 16), ERASURE_RETRY_MAX_MS);
      await env.DB.prepare("update account_erasures set failures = failures + 1, next_run_at = ? where user_id = ?")
        .bind(now + wait, row.user_id).run();
      continue;
    }
    const runs = row.runs + 1;
    const next = ACCOUNT_ERASURE_REPEATS_MS[runs];
    if (next === undefined) {
      await env.DB.prepare("delete from account_erasures where user_id = ?").bind(row.user_id).run();
    } else {
      await env.DB.prepare("update account_erasures set runs = ?, failures = 0, next_run_at = ? where user_id = ?")
        .bind(runs, Math.max(row.deleted_at + next, now + 60_000), row.user_id).run();
    }
  }
}

export function isDeletedAccountsListRequest(path: string): boolean {
  return path === CLOUD_EDGE_PATHS.internalDeletedAccounts;
}

/**
 * `GET /cloud/internal/deleted-accounts` from the webhook relay, which keeps
 * rows by account ID (repository and Linear links, Cursor secrets, custom
 * hooks) and has no way to hear of a deletion itself. It purges each account
 * right away and again after each repeat here, so a write by a token still
 * valid goes too. No account token: the shared secret
 * `CLOUD_EVENT_WAKE_SECRET` is the proof. Unset secret: 503, never open.
 */
export async function handleDeletedAccountsList(request: Request, env: { DB: D1Database; CLOUD_EVENT_WAKE_SECRET?: string }): Promise<Response> {
  const proven = presentsEventWakeSecret(request, env);
  if (proven === null) return fail("unavailable", "Deleted accounts are not shared on this server.", 503);
  if (request.method !== "GET" || !proven) return fail("not_found", "Daex Cloud has no such route.", 404);
  const rows = (await env.DB.prepare("select user_id, deleted_at from account_erasures order by deleted_at desc limit ?")
    .bind(DELETED_ACCOUNTS_LIST_MAX).all<{ user_id: string; deleted_at: number }>()).results ?? [];
  return json({ accounts: rows.map((row) => ({ userId: row.user_id, deletedAt: row.deleted_at })) });
}
