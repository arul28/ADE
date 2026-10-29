import type { AccountStaleDelete, AccountWriteResult } from "../push/accountRelayRows";
import type { AccountCachePending, AccountCacheUploadResult } from "./accountCacheStore";
import { errorReason, errorStatus } from "./accountCacheDiagnostics";

/**
 * How an account-synced store sends its queue to the relay: in batches, one
 * refused item never holding back the rest, with the relay's per-item answers
 * (written, rejected, stale) sorted into what `accountCacheStore` clears,
 * parks, and adopts. Settings and the vault differ only in the row they send
 * and the relay call they make; everything else is here once.
 */

/**
 * The relay refused something about the items in a request, not the request:
 * 400 (an item it will not store) or 413 (too many, or too large). Splitting
 * the batch finds which item. An older relay answers this way for a whole
 * batch; a newer one answers per item instead (`itemResults`).
 */
function isAccountItemRejection(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 400 || status === 413;
}

/** The relay's reason for refusing one item: its short error text, never a value. */
function accountItemRejectionReason(error: unknown): string {
  const reason = errorReason(error)?.trim() ?? "";
  return (reason || `HTTP ${errorStatus(error) ?? "error"}`).slice(0, 120);
}

type IsolatedPutResult<T, R> = {
  /** Each request that landed, with the items it carried, in order. */
  landed: Array<{ batch: T[]; result: R }>;
  /** Items the relay refused one by one, with its reason. */
  rejected: Array<{ item: T; reason: string }>;
  /** A request failed for a reason that is not one item's; later items were not sent. */
  error?: unknown;
  /** There was no token to ask with; later items were not sent. */
  couldNotAsk: boolean;
};

/**
 * Sends `items` in batches of at most `maxBatch`, so one item the relay will
 * not take can never hold back the rest. A batch the relay refuses as a whole
 * for an item's sake (an older relay's all-or-nothing 400) is split in halves
 * until the refused items stand alone; the others are sent. A batch-level
 * failure (network, 5xx, 429) stops and leaves the rest for the next pass.
 */
async function putIsolated<T, R>(
  items: readonly T[],
  maxBatch: number,
  put: (batch: T[]) => Promise<R | null>,
): Promise<IsolatedPutResult<T, R>> {
  const outcome: IsolatedPutResult<T, R> = { landed: [], rejected: [], couldNotAsk: false };
  const attempt = async (batch: T[]): Promise<boolean> => {
    let result: R | null;
    try {
      result = await put(batch);
    } catch (error) {
      if (!isAccountItemRejection(error)) {
        outcome.error = error;
        return false;
      }
      if (batch.length === 1) {
        outcome.rejected.push({ item: batch[0]!, reason: accountItemRejectionReason(error) });
        return true;
      }
      const middle = Math.ceil(batch.length / 2);
      return (await attempt(batch.slice(0, middle))) && (await attempt(batch.slice(middle)));
    }
    if (result === null) {
      outcome.couldNotAsk = true;
      return false;
    }
    outcome.landed.push({ batch, result });
    return true;
  };
  const size = Math.max(1, Math.trunc(maxBatch));
  for (let index = 0; index < items.length; index += size) {
    if (!(await attempt(items.slice(index, index + size)))) break;
  }
  return outcome;
}

/** What a relay answers to one PUT: `results` only when it answers per item. */
export type AccountPutAnswer<TRemote> = {
  updatedAt: string | null;
  results?: ReadonlyArray<AccountWriteResult<TRemote>>;
};

/**
 * Upload a store's queue: the writes group by group (`putIsolated` within
 * each), then the deletes one by one. A group the relay could not be asked
 * about, or that failed for a reason not one item's, stops the pass; the rest
 * stays queued. `null` means nothing was settled and there was no token to ask
 * with, so the cache keeps the whole queue and skips the pull.
 */
export async function uploadAccountItems<TPending extends AccountCachePending, TRemote>(args: {
  /** Writes, in the batches they may share (a kind an older relay refuses goes alone). */
  groups: ReadonlyArray<readonly TPending[]>;
  deletes: readonly TPending[];
  maxBatch: number;
  put: (batch: TPending[]) => Promise<AccountPutAnswer<TRemote> | null>;
  del: (entry: TPending) => Promise<boolean | AccountStaleDelete<TRemote> | null>;
  /** Seqs the store already settled without the relay (a value it can never send). */
  completedSeqs?: readonly number[];
}): Promise<AccountCacheUploadResult<TRemote> | null> {
  const completedSeqs: number[] = [...(args.completedSeqs ?? [])];
  const rejected: Array<{ seq: number; reason: string }> = [];
  const superseded: Array<{ seq: number; current: TRemote | null }> = [];
  let uploadedAt: string | null = null;
  let checkedConflicts: boolean | undefined;
  let couldNotAsk = false;
  let error: unknown = undefined;
  for (const group of args.groups) {
    if (!group.length) continue;
    const outcome = await putIsolated(group, args.maxBatch, args.put);
    for (const { batch, result } of outcome.landed) {
      checkedConflicts = Boolean(result.results) || checkedConflicts === true;
      let wrote = false;
      batch.forEach((entry, index) => {
        const answer = result.results ? result.results[index] : { status: "written" as const };
        if (answer?.status === "written") {
          completedSeqs.push(entry.seq);
          wrote = true;
        } else if (answer?.status === "rejected") {
          rejected.push({ seq: entry.seq, reason: answer.reason });
        } else if (answer?.status === "stale") {
          superseded.push({ seq: entry.seq, current: answer.current });
        }
      });
      // Keep the first batch's stamp: a later one would make this machine
      // win over a remote edit that landed between the two PUTs.
      if (wrote) uploadedAt ??= result.updatedAt;
    }
    rejected.push(...outcome.rejected.map(({ item, reason }) => ({ seq: item.seq, reason })));
    if (outcome.couldNotAsk) couldNotAsk = true;
    if (outcome.error !== undefined) error = outcome.error;
    if (couldNotAsk || error !== undefined) break;
  }
  if (!couldNotAsk && error === undefined) {
    for (const entry of args.deletes) {
      let answer: boolean | AccountStaleDelete<TRemote> | null;
      try {
        answer = await args.del(entry);
      } catch (deleteError) {
        // A delete the relay refuses for the item itself (an older relay and a
        // kind or key it does not know) is parked like a write; the deletes
        // queued behind it still go.
        if (isAccountItemRejection(deleteError)) {
          rejected.push({ seq: entry.seq, reason: accountItemRejectionReason(deleteError) });
          continue;
        }
        error = deleteError;
        break;
      }
      if (answer === null) {
        couldNotAsk = true;
        break;
      }
      if (typeof answer === "object") superseded.push({ seq: entry.seq, current: answer.current });
      else completedSeqs.push(entry.seq);
    }
  }
  if (couldNotAsk && !completedSeqs.length && !rejected.length && !superseded.length) return null;
  return {
    updatedAt: uploadedAt,
    completedSeqs,
    rejected,
    superseded,
    ...(checkedConflicts !== undefined ? { checkedConflicts } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
