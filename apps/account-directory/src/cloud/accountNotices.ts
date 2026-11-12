import { timedWakesCancelledSentence, type CloudTimedWakesCancelled } from "./contract";
import { sendCloudEmail } from "./email";
import type { AccountRow, CloudEnv } from "./store";

/**
 * Timed wake-ups cancelled because an account's computers may not wake (0
 * hours with extra hours off, or the free plan above its disk). A timed wake
 * reaches only a sleeping computer, and these are stopped, so the minute cron
 * deletes them (`settleAccounts`). The person hears once a period, by email,
 * and `GET /cloud/account` carries it (`timedWakesCancelled`) for the app to
 * show while that period runs. A computer sets its next timed wake again the
 * next time it sleeps after it ran, so nothing has to be set up again.
 */

/** Why an account's computers may not wake. */
export type WakeBlock = CloudTimedWakesCancelled["reason"];

/** The notice for `GET /cloud/account`: only while the period it happened in runs. */
export function timedWakesCancelledOf(
  account: Pick<AccountRow, "period_start" | "wakes_cancelled_at" | "wakes_cancelled_count" | "wakes_cancelled_reason">,
): CloudTimedWakesCancelled | null {
  if (account.wakes_cancelled_at == null || account.wakes_cancelled_at < account.period_start) return null;
  const reason = account.wakes_cancelled_reason === "over_plan_disk" ? "over_plan_disk" : "out_of_hours";
  return { at: account.wakes_cancelled_at, count: account.wakes_cancelled_count ?? 0, reason };
}

/**
 * Deletes the timed wakes of `blocked` accounts and tells each account that
 * lost any, once a period. One query when nothing was set.
 */
export async function cancelTimedWakes(env: CloudEnv, blocked: Map<string, WakeBlock>, now: number): Promise<void> {
  if (blocked.size === 0) return;
  const deleted = await env.DB.prepare("delete from cloud_wakes where user_id in (select value from json_each(?)) returning user_id")
    .bind(JSON.stringify([...blocked.keys()])).all<{ user_id: string }>();
  const counts = new Map<string, number>();
  for (const row of deleted.results ?? []) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  for (const [userId, count] of counts) {
    const reason = blocked.get(userId) ?? "out_of_hours";
    // The first cancel of a period is news; later ones in it add to the count quietly.
    const first = await env.DB.prepare(`
      update cloud_accounts set wakes_cancelled_at = ?, wakes_cancelled_count = ?, wakes_cancelled_reason = ?
      where user_id = ? and (wakes_cancelled_at is null or wakes_cancelled_at < period_start)
    `).bind(now, count, reason, userId).run();
    if ((first.meta?.changes ?? 0) === 0) {
      await env.DB.prepare("update cloud_accounts set wakes_cancelled_count = coalesce(wakes_cancelled_count, 0) + ? where user_id = ?").bind(count, userId).run();
      continue;
    }
    await sendCloudEmail(env, {
      userId,
      subject: "Your ADE Cloud timed wake-ups were cancelled",
      text: timedWakesCancelledSentence({ count, reason }),
    });
  }
}
