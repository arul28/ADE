import { purgeRelayAccountData, type RelayAccountPurgeEnv } from "../activityRelay";
import { cancelAccountSubscription } from "./billing";
import { deleteAllAccountChats } from "./chats";
import { createCloudProvider } from "./provider";
import {
  deleteComputer,
  isPendingId,
  listComputers,
  type AccountRow,
  type CloudEnv,
} from "./store";

/**
 * Everything ADE Cloud holds for an account being deleted (Clerk `user.deleted`):
 * the plan, its computers, its timed wakes, its lanes without a computer and
 * its saved chats, and then the account's vault and settings on the push
 * relay. A throw means Clerk delivers again, and each step is safe to repeat.
 * A create still running keeps its reservation: the computer it makes is
 * adopted, then the minute cron deletes it because `deleted_at` is set.
 */
export async function deleteCloudAccount(
  env: Pick<CloudEnv, "DB" | "CLOUD_CHATS" | "AGENT37_API_KEY" | "STRIPE_SECRET_KEY"> & RelayAccountPurgeEnv,
  userId: string,
): Promise<void> {
  const now = Date.now();
  const account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
  if (account) {
    // First, so anything that lands while the rest runs is cleaned up too.
    await env.DB.prepare("update cloud_accounts set deleted_at = coalesce(deleted_at, ?) where user_id = ?").bind(now, userId).run();
    await cancelAccountSubscription(env, account, now);
  }

  const real = (await listComputers(env, userId)).filter((computer) => !isPendingId(computer.instance_id));
  if (real.length) {
    const key = env.AGENT37_API_KEY?.trim();
    if (!key) throw new Error("no_provider_key");
    const provider = createCloudProvider(key);
    for (const computer of real) {
      await deleteComputer(env, provider, computer, { who: "system", reason: "account_deleted" }, now);
    }
  }

  await env.DB.prepare("delete from cloud_wakes where user_id = ?").bind(userId).run();
  // Lane names, repository origins and branches of lanes whose computer is gone.
  await env.DB.prepare("delete from cloud_lanes_without_computer where user_id = ?").bind(userId).run();
  await deleteAllAccountChats(env, userId);
  // The invite link stops working and the computers it was seen on go. The free-plan
  // claim stays (re-making the account must not give the computer's free hours again),
  // and so do referral rows and earned-hour grants, which hold no personal data.
  await env.DB.batch([
    env.DB.prepare("delete from cloud_invite_codes where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_account_computers where user_id = ?").bind(userId),
  ]);

  // Last, after the computers: a cloud computer still running holds the
  // account's session and could write its sign-ins back into the vault.
  const relay = await purgeRelayAccountData(env, userId);
  if (!relay.ok) throw new Error(`relay_purge_failed: ${relay.reason}`);
}
