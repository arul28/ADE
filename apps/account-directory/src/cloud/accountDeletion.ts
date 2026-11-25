import { deleteAccountPhone } from "./phones";
import { purgeRelayAccountData, type RelayAccountPurgeEnv } from "../activityRelay";
import { cancelAccountSubscription } from "./billing";
import { deleteAllAccountChats } from "./chats";
import { deleteAccountLaunches } from "./launches";
import { deleteAccountAutomations } from "./automations";
import { createCloudProvider } from "./provider";
import { CLOUD_DELETED_ACCOUNT_PREFIX, CLOUD_REFERRAL_FRIEND_REASON, CLOUD_REFERRAL_REFERRER_REASON } from "./contract";
import { sha256Hex } from "../sinkUtils";
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
  env: Pick<CloudEnv, "DB" | "CLOUD_CHATS" | "AGENT37_API_KEY" | "STRIPE_SECRET_KEY" | "NOMAC_API_KEY" | "REVYL_PARTNER_API_KEY" | "CLOUD_PHONE_ACCESS"> & RelayAccountPurgeEnv,
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

  // The ADE Cloud iPhone's saved states, replays and workspace at NoMac, and the beta list.
  // NoMac being down must not hold back the rest: its failure is thrown at the end, so Clerk's
  // retry runs it again (it lists the phones at NoMac by the account's label, not from D1).
  let phoneFailure: unknown = null;
  try {
    await deleteAccountPhone(env, userId);
  } catch (error) {
    phoneFailure = error;
  }
  await env.DB.prepare("delete from cloud_wakes where user_id = ?").bind(userId).run();
  // The topics that wake a computer at rest, their state, and the request counts of the Linear and Jira reads.
  await env.DB.batch([
    env.DB.prepare("delete from cloud_event_wakes where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_event_wake_state where user_id = ?").bind(userId),
    // Status-menu facts of any computer whose close above left them (they carry no user id).
    env.DB.prepare("delete from cloud_instance_events where instance_id in (select instance_id from cloud_computers where user_id = ?)").bind(userId),
    env.DB.prepare("delete from cloud_computer_activity where instance_id in (select instance_id from cloud_computers where user_id = ?)").bind(userId),
    env.DB.prepare("delete from cloud_request_windows where user_id = ?").bind(userId),
    // Sealed Linear grants that wait for their publish.
    env.DB.prepare("delete from cloud_linear_renewals where user_id = ?").bind(userId),
  ]);
  // Lane names, repository origins and branches of lanes whose computer is gone.
  await env.DB.prepare("delete from cloud_lanes_without_computer where user_id = ?").bind(userId).run();
  // Saved chats, their queued messages, CLI and shell copies, Git summaries and fork capsules, then the key.
  await deleteAllAccountChats(env, userId);
  // The account lane index: every machine's lane names, branches and PR numbers.
  await env.DB.batch([
    env.DB.prepare("delete from account_lane_index where user_id = ?").bind(userId),
    env.DB.prepare("delete from account_lane_index_state where user_id = ?").bind(userId),
  ]);
  // Launch facts (first messages, lane names) and their files; project delete jobs.
  await deleteAccountLaunches(env, userId);
  await env.DB.prepare("delete from cloud_project_deletes where user_id = ?").bind(userId).run();
  // Repository origins whose setup needed a bigger size.
  await env.DB.prepare("delete from cloud_repo_sizes where user_id = ?").bind(userId).run();
  // And whose setup grew its disk.
  await env.DB.prepare("delete from cloud_repo_disks where user_id = ?").bind(userId).run();
  // Automations on ADE Cloud (their prompts and names) and their run history.
  await deleteAccountAutomations(env, userId);
  // The invite link stops working and the computers it was seen on go. The free-plan
  // claim stays (re-making the account must not give the computer's free hours again),
  // and so do referral rows and earned-hour grants (the referral cap and the friends'
  // rewards are counted from them), each re-keyed to a hash so none names the person.
  const gone = await deletedAccountKey(userId);
  await env.DB.batch([
    env.DB.prepare("delete from cloud_invite_codes where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_account_computers where user_id = ?").bind(userId),
    env.DB.prepare("update cloud_free_plan_claims set user_id = ? where user_id = ?").bind(gone, userId),
    // The GitHub account's claim stays too, for the same reason; the hashed sign-up address goes.
    env.DB.prepare("update cloud_free_github_claims set user_id = ? where user_id = ?").bind(gone, userId),
    env.DB.prepare("delete from cloud_signup_ips where user_id = ?").bind(userId),
    // Safety (`safety.ts`): a card's free unlock and a block stay, so a re-made account can't use the card or come back
    // unblocked; abuse events and owner alerts stay for the owner. All re-keyed to the hash.
    env.DB.prepare("update cloud_free_card_claims set user_id = ? where user_id = ?").bind(gone, userId),
    env.DB.prepare("update cloud_blocks set user_id = ? where user_id = ?").bind(gone, userId),
    // The ADE Cloud iPhone's phones stay for the cost report, under the hash, and none counts as running
    // (`deleteAccountPhone` stopped them at NoMac above, or does on the retry).
    // Until NoMac's cleanup succeeded they stay under the account, so Clerk's retry still finds them.
    env.DB.prepare("update cloud_phones set user_id = ?, state = 'ended', stop_at = null, ended_at = coalesce(ended_at, ?) where user_id = ? and ? = 0").bind(gone, Date.now(), userId, phoneFailure ? 1 : 0),
    env.DB.prepare("update cloud_abuse_events set user_id = ? where user_id = ?").bind(gone, userId),
    env.DB.prepare("update cloud_owner_alerts set user_id = ? where user_id = ?").bind(gone, userId),
    env.DB.prepare("delete from cloud_cpu_reports where user_id = ?").bind(userId),
    // Sponsored cards (`gravity.ts`): the answer, the watch rows, the cards, the format. The account's day counts go; the totals stay.
    env.DB.prepare("delete from cloud_sponsored_consent where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_sponsored_testers where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_sponsored_viewers where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_sponsored_turns where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_sponsored_formats where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_sponsored_days where user_id = ?").bind(userId),
    // The owner's change log of the account test tool (`ownerAccounts.ts`).
    env.DB.prepare("delete from cloud_owner_log where user_id = ?").bind(userId),
    env.DB.prepare("update cloud_referrals set friend_user_id = ? where friend_user_id = ?").bind(gone, userId),
    env.DB.prepare("update cloud_referrals set referrer_user_id = ? where referrer_user_id = ?").bind(gone, userId),
    env.DB.prepare("update cloud_earned_hours set user_id = ? where user_id = ?").bind(gone, userId),
    // A referral grant's reference is the friend's account.
    env.DB.prepare(`update cloud_earned_hours set reference = ? where reference = ? and reason in ('${CLOUD_REFERRAL_REFERRER_REASON}', '${CLOUD_REFERRAL_FRIEND_REASON}')`).bind(gone, userId),
  ]);

  await forgetDeletedAccountComputers(env, userId);

  // Last, after the computers: a cloud computer still running holds the
  // account's session and could write its sign-ins back into the vault.
  const relay = await purgeRelayAccountData(env, userId);
  if (!relay.ok) throw new Error(`relay_purge_failed: ${relay.reason}`);
  if (phoneFailure) throw phoneFailure;
}

/** The one-way key that a deleted account's kept rows carry in place of its ID. */
export async function deletedAccountKey(userId: string): Promise<string> {
  return `${CLOUD_DELETED_ACCOUNT_PREFIX}${await sha256Hex(userId)}`;
}

/**
 * The rest of a deleted account's machines and computers. These go: the
 * machine list (names, addresses, folder paths, hardware hashes, device
 * keys), its revocations and pairing grants, the jobs, the bonus days, and
 * the computers' power, delete and idle-cleanup logs. Each deleted
 * computer's row and the daily usage and cost rows stay for the cost report
 * and the provider's late usage (`cron.ts` reconcile), re-keyed to the hash
 * with the names cleared.
 *
 * A computer not deleted yet (a create that still ran) keeps the account ID
 * and its day rows until the minute cron deletes it; the cron runs this
 * again then, and so does each repeat of the deletion (`accountErasure.ts`),
 * which also finds rows a tick wrote after an earlier run. The logs go by
 * account, so a log a racing tick wrote for a computer already re-keyed goes
 * too. The `cloud_accounts` row stays under the account ID, marked deleted: a
 * sign-in token still valid must find it, so the computer it makes is deleted
 * too. Safe to repeat.
 */
export async function forgetDeletedAccountComputers(env: Pick<CloudEnv, "DB">, userId: string): Promise<void> {
  const gone = await deletedAccountKey(userId);
  const liveComputers = "select instance_id from cloud_computers where user_id = ? and deleted_at is null";
  await env.DB.batch([
    env.DB.prepare("delete from machines where user_id = ?").bind(userId),
    env.DB.prepare("delete from revoked_machines where user_id = ?").bind(userId),
    env.DB.prepare("delete from machine_pairing_grants where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_jobs where user_id = ?").bind(userId),
    env.DB.prepare("delete from jev_bonus_days where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_power_log where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_delete_log where user_id = ?").bind(userId),
    env.DB.prepare("delete from cloud_idle_cleanup_log where user_id = ?").bind(userId),
    env.DB.prepare(`update cloud_computer_days set user_id = ? where user_id = ? and instance_id not in (${liveComputers})`).bind(gone, userId, userId),
    // Keyed by account and day: a day the hash already has (written by a late computer after an
    // earlier run) takes the higher peak, then the account's own rows go.
    env.DB.prepare(`
      insert into cloud_disk_days (user_id, day, peak_gb, plan_gb, billable, free)
      select ?, day, peak_gb, plan_gb, billable, free from cloud_disk_days where user_id = ?
      on conflict (user_id, day) do update set peak_gb = max(peak_gb, excluded.peak_gb), free = min(free, excluded.free)
    `).bind(gone, userId),
    env.DB.prepare("delete from cloud_disk_days where user_id = ?").bind(userId),
    // The daily report writes no row for a deleted account, so a day here never meets one under the hash;
    // `or ignore` only keeps a clash from failing the whole deletion.
    env.DB.prepare("update or ignore cloud_account_days set user_id = ? where user_id = ?").bind(gone, userId),
    env.DB.prepare("delete from cloud_account_days where user_id = ?").bind(userId),
    // Last: the day rows above tell the live computers by the account ID.
    env.DB.prepare(`
      update cloud_computers set user_id = ?, name = null, machine_key = null, request_id = null, moving_from = null,
        update_error = null, ade_features = null
      where user_id = ? and deleted_at is not null
    `).bind(gone, userId),
    env.DB.prepare("update cloud_accounts set test_note = null, plan_cleanup_choice_json = null, plan_cleanup_result_json = null, plan_cleanup_warned_json = null where user_id = ?").bind(userId),
  ]);
}
