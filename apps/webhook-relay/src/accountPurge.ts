import type { RelayEnv } from "./shared";

/**
 * Deleted ADE accounts leave this relay too. Rows here carry the raw account
 * ID (Clerk `sub`), and the relay hears of no deletion itself, so each cron
 * run asks both account directories which accounts were deleted in the last
 * day (`GET /cloud/internal/deleted-accounts`, secret `CLOUD_EVENT_WAKE_SECRET`)
 * and purges each one. An account stays on that list for a day. It is
 * purged on the first run after its deletion and again on the first run after
 * each time the directory runs the deletion again (`PURGE_AT_MS`), so rows a
 * sign-in token still valid wrote after the deletion go too. Every statement
 * is safe to repeat.
 *
 * Shared rows stay without the account: a repository or Linear workspace
 * another account can link again keeps its row with the link cleared; a
 * Linear agent install keeps its install with its installer and runner
 * cleared (an install without a runner falls back to replies).
 */

/** The account directory's header and route (`CLOUD_EVENT_WAKE_HEADER`, `CLOUD_EDGE_PATHS.internalDeletedAccounts`). */
const DIRECTORY_SECRET_HEADER = "x-ade-event-wake-secret";
const DELETED_ACCOUNTS_URL = "https://account-directory.internal/cloud/internal/deleted-accounts";
const DIRECTORY_TIMEOUT_MS = 10_000;
const DIRECTORIES = ["ACCOUNT_DIRECTORY_PRODUCTION", "ACCOUNT_DIRECTORY"] as const;
const ACCOUNT_ID_MAX = 256;
/**
 * When an account is purged, from its deletion: right away and after each of
 * the directory's repeats (`ACCOUNT_ERASURE_REPEATS_MS`, but before the last at
 * 24 h, when the account leaves the list). A purge runs on a cron run whose
 * time falls in `PURGE_WINDOW_MS` after one of these. The cron runs every 30
 * minutes, so the 35-minute window catches each point once or, rarely, twice.
 */
const PURGE_AT_MS = [0, 15 * 60_000, 75 * 60_000, 3 * 3_600_000, 23 * 3_600_000] as const;
const PURGE_WINDOW_MS = 35 * 60_000;
/** Accounts purged in one run: 14 statements each, far below the run's query limit. A busy day's rest waits a run. */
const PURGES_PER_RUN = 40;

function purgeIsDue(deletedAt: number, now: number): boolean {
  const age = now - deletedAt;
  return PURGE_AT_MS.some((at) => age >= at && age < at + PURGE_WINDOW_MS);
}

/** The account's rows, in one batch per account: they all go, or none do and the next run tries again. */
function accountPurgeStatements(db: D1Database, accountId: string): D1PreparedStatement[] {
  const one = (sql: string) => db.prepare(sql).bind(accountId);
  const two = (sql: string) => db.prepare(sql).bind(accountId, accountId);
  return [
    one("delete from custom_hook_events where account_id = ?"),
    one("delete from custom_hooks where account_id = ?"),
    one("delete from github_events where account_id = ?"),
    one("update github_app_repositories set account_id = null where account_id = ?"),
    one("update github_app_repositories set unlinked_account_id = null where unlinked_account_id = ?"),
    two("delete from linear_events where account_id = ? or routed_account_id = ?"),
    one("update linear_organizations set account_id = null where account_id = ?"),
    one("update linear_organizations set unlinked_account_id = null where unlinked_account_id = ?"),
    one("delete from linear_agent_members where account_id = ?"),
    one("update linear_agent_sessions set routed_account_id = null where routed_account_id = ?"),
    one("update linear_agent_installs set installed_by_account_id = null where installed_by_account_id = ?"),
    one("update linear_agent_installs set runner_account_id = null where runner_account_id = ?"),
    one("delete from cursor_events where account_id = ?"),
    two("delete from cursor_webhook_secrets where account_id = ? or unlinked_account_id = ?"),
  ];
}

type ListedAccount = { userId: string; deletedAt: number };

async function deletedAccountsOf(binding: { fetch: typeof fetch }, secret: string): Promise<ListedAccount[] | null> {
  const response = await binding.fetch(DELETED_ACCOUNTS_URL, {
    method: "GET",
    headers: { [DIRECTORY_SECRET_HEADER]: secret },
    signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const body = await response.json().catch(() => null) as { accounts?: Array<{ userId?: unknown; deletedAt?: unknown }> } | null;
  if (!Array.isArray(body?.accounts)) return null;
  return body.accounts.flatMap((account) => {
    const userId = typeof account?.userId === "string" ? account.userId.trim() : "";
    const deletedAt = typeof account?.deletedAt === "number" && Number.isFinite(account.deletedAt) ? account.deletedAt : null;
    return userId && userId.length <= ACCOUNT_ID_MAX && deletedAt !== null ? [{ userId, deletedAt }] : [];
  });
}

/**
 * One cron run's purge; answers how many accounts it purged. A directory
 * that does not answer (no route yet, no secret, an outage) is skipped and
 * asked again next run; its accounts stay listed for a day. The production
 * directory's refusal, and a purge that fails, throw after the rest ran, so
 * the cron reports them: without them, no deleted account leaves this relay.
 */
export async function purgeDeletedAccounts(env: RelayEnv, now = Date.now()): Promise<number> {
  const secret = env.CLOUD_EVENT_WAKE_SECRET?.trim();
  if (!secret) return 0;
  const due = new Set<string>();
  let failure: unknown = null;
  for (const name of DIRECTORIES) {
    const binding = env[name];
    if (!binding) continue;
    let listed: ListedAccount[] | null = null;
    let error = "refused";
    try {
      listed = await deletedAccountsOf(binding, secret);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.name : "unknown";
    }
    if (listed === null) {
      console.warn(JSON.stringify({ kind: "account_purge_list_failed", directory: name, error }));
      if (name === "ACCOUNT_DIRECTORY_PRODUCTION") failure ??= new Error("deleted_accounts_list_failed");
      continue;
    }
    for (const account of listed) if (purgeIsDue(account.deletedAt, now)) due.add(account.userId);
  }
  const accounts = [...due].slice(0, PURGES_PER_RUN);
  for (const accountId of accounts) {
    try {
      await env.DB.batch(accountPurgeStatements(env.DB, accountId));
    } catch (error) {
      failure ??= error;
    }
  }
  if (accounts.length > 0) console.log(JSON.stringify({ kind: "account_purge_ran", accounts: accounts.length, waiting: due.size - accounts.length }));
  if (failure) throw failure;
  return accounts.length;
}
