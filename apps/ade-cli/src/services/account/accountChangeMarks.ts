/**
 * The relay's "newest settings / vault change" marks for an account, as last
 * seen on a machine publish response.
 *
 * Settings and vault used to be polled every 30 s per brain whether or not
 * anything changed. The push relay now piggybacks these marks on the presence
 * heartbeat the brain already sends, so a cache store pulls only when its mark
 * moved. The publisher and the account stores use different relay clients, so
 * the marks travel through this process-wide record, keyed by account.
 */

export type AccountChangeMarkKind = "settings" | "vault";

export type AccountChangeMarks = {
  settings: string | null;
  vault: string | null;
};

type MarkEntry = { marks: AccountChangeMarks; receivedAtMs: number };

type MarkListener = (accountUserId: string, marks: AccountChangeMarks) => void;

const latestByAccount = new Map<string, MarkEntry>();
const listeners = new Set<MarkListener>();

export function recordAccountChangeMarks(
  accountUserId: string,
  marks: AccountChangeMarks,
  nowMs: number = Date.now(),
): void {
  latestByAccount.set(accountUserId, { marks, receivedAtMs: nowMs });
  for (const listener of listeners) {
    try {
      listener(accountUserId, marks);
    } catch {
      // A listener's failure must not stop the others or the publish path.
    }
  }
}

export function readAccountChangeMarks(accountUserId: string): MarkEntry | null {
  return latestByAccount.get(accountUserId) ?? null;
}

export function subscribeAccountChangeMarks(listener: MarkListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
