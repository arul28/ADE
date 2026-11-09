import { cancelAccountSubscription } from "./billing";
import { deleteAllAccountChats } from "./chats";
import { CloudProviderError, createCloudProvider } from "./provider";
import {
  deleteLogStatement,
  isPendingId,
  listComputers,
  logCloud,
  markDeletedStatements,
  type AccountRow,
  type CloudEnv,
} from "./store";

/**
 * Everything ADE Cloud holds for an account being deleted (Clerk `user.deleted`):
 * the plan, its computers, its timed wakes and its saved chats. A throw means
 * Clerk delivers again, and each step is safe to repeat.
 */
export async function deleteCloudAccount(env: CloudEnv, userId: string): Promise<void> {
  const now = Date.now();
  const account = await env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId).first<AccountRow>();
  if (account) await cancelAccountSubscription(env, account, now);

  const computers = await listComputers(env, userId);
  const pending = computers.filter((computer) => isPendingId(computer.instance_id));
  const real = computers.filter((computer) => !isPendingId(computer.instance_id));
  if (pending.length) {
    await env.DB.batch(pending.map((computer) => env.DB.prepare("delete from cloud_computers where instance_id = ?").bind(computer.instance_id)));
  }
  if (real.length) {
    const key = env.AGENT37_API_KEY?.trim();
    if (!key) throw new Error("no_provider_key");
    const provider = createCloudProvider(key);
    for (const computer of real) {
      const events = await provider.instanceEvents(computer.instance_id).catch((error: unknown) => {
        logCloud("cloud.delete_events_read_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
        return null;
      });
      try {
        await provider.deleteInstance(computer.instance_id);
      } catch (error) {
        if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
      }
      await env.DB.batch([
        deleteLogStatement(env, computer, { who: "system", reason: "account_deleted", events }, now),
        ...markDeletedStatements(env, computer, now),
      ]);
    }
  }

  await env.DB.prepare("delete from cloud_wakes where user_id = ?").bind(userId).run();
  await deleteAllAccountChats(env, userId);
}
