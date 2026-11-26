import type { AdeAccountStatus } from "../../shared/types";
import { accountSessionState, fetchAccountStatus, subscribeAccountStatus } from "../lib/account";
import { isWebClientMode } from "../lib/webClientMode";

/**
 * Copies of account data kept in this computer's localStorage (the ADE Cloud
 * lane index, the lanes kept without a computer, ADE Cloud's state), one
 * account at a time. A computer or a browser can be shared: one person signs
 * out and another signs in.
 *
 * - A copy names the account it was read for. A window reads it back only
 *   once the account status says that account is the one signed in here;
 *   until then the store starts empty.
 * - A sign-out or another account drops the copy, in memory (`forget`) and
 *   in storage.
 * - ADE Web keeps no copy (memory only), and drops one an older build left.
 *
 * The account comes from the renderer's one account status (`lib/account.ts`):
 * one status read when the first copy is made, then that store's own reads
 * (sign-in, sign-out, window focus). No timer, no read of its own after that.
 */

/** The account signed in here: its user id, null while signed out, undefined until a status says. */
type Scope = string | null | undefined;

type Copy = {
  key: string;
  restore: (saved: unknown) => void;
  forget: () => void;
  /** A save made before the account was known: written once it is. */
  unsaved: { value: unknown } | null;
};

export type AccountScopedCopy = {
  /** Keeps `value` for the account signed in now (never on ADE Web). */
  save(value: unknown): void;
  /** Drops the stored copy (the store keeps its memory). */
  clear(): void;
};

const copies: Copy[] = [];
let scope: Scope = undefined;
let watching = false;
/** Moves on when the account is first known and at each sign-out or change of account (see `accountScopeGeneration`). */
let generation = 0;
const changeListeners = new Set<() => void>();

function scopeOf(status: AdeAccountStatus): Scope {
  if (status.signedIn) return status.userId?.trim() || undefined;
  // A session that could not be read is no answer: the same account may still be signed in.
  return accountSessionState(status) === "unreadable" ? undefined : null;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

function write(key: string, userId: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify({ v: 1, userId, value }));
  } catch {
    // A full or blocked storage costs only the copy; the next read fills the store again.
  }
}

/** The stored value when it was kept for `userId`; any other copy (another account's, an older build's) is dropped. */
function readFor(key: string, userId: string): { value: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(key) ?? "null");
    const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    if (row?.v === 1 && row.userId === userId && "value" in row) return { value: row.value };
  } catch {
    // Unreadable: dropped below.
  }
  remove(key);
  return null;
}

/** The first answer: this account's copy comes back, any other goes. */
function settle(copy: Copy): void {
  const unsaved = copy.unsaved;
  copy.unsaved = null;
  if (isWebClientMode() || scope === undefined) return;
  if (scope === null) {
    remove(copy.key);
    return;
  }
  // A read that landed before the answer is newer than the stored copy.
  if (unsaved) write(copy.key, scope, unsaved.value);
  else {
    const saved = readFor(copy.key, scope);
    if (saved) copy.restore(saved.value);
  }
}

function noteScope(next: Scope): void {
  if (next === undefined || next === scope) return;
  const previous = scope;
  scope = next;
  // A read still on its way started before this answer: its account is not known.
  generation += 1;
  for (const copy of copies) {
    if (previous === undefined) {
      settle(copy);
      continue;
    }
    // Another account, or none: what the last one left goes.
    copy.unsaved = null;
    remove(copy.key);
    copy.forget();
  }
  if (previous !== undefined) {
    for (const listener of changeListeners) listener();
  }
}

function watch(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  // Only a real answer counts: a missing bridge or a failed read answers with a
  // made-up "signed out", which `fetchAccountStatus` resolves with but never publishes.
  subscribeAccountStatus((status) => noteScope(scopeOf(status)));
  if (typeof window.ade?.account?.status !== "function") return;
  void fetchAccountStatus({ force: true });
  // A sign-in or sign-out in another window says so only through ADE Cloud's
  // change signal (`cloudAccountChanged`): ask whose account this is again, so
  // a read for the new account is never kept under the last one.
  window.ade?.cloud?.onStatusChanged?.(() => void fetchAccountStatus({ force: true }));
}

/**
 * Moves on each time the account signed in here changes or signs out. A read
 * that started before a change answers for the last account: its caller
 * compares this before and after, and drops the answer when it moved.
 */
export function accountScopeGeneration(): number {
  return generation;
}

/**
 * Runs after another account signs in here, or the account signs out, for a
 * store that holds account data in memory only. Answers the unsubscribe.
 */
export function onAccountScopeChange(listener: () => void): () => void {
  changeListeners.add(listener);
  watch();
  return () => changeListeners.delete(listener);
}

/**
 * One store's copy in localStorage under `key`. `restore` gets the stored
 * value once the account it was kept for is known to be signed in here (the
 * store parses it and ignores it when a read already filled the store).
 * `forget` runs on a sign-out or another account: the store drops what it
 * holds in memory.
 */
export function accountScopedCopy(options: {
  key: string;
  restore: (saved: unknown) => void;
  forget: () => void;
}): AccountScopedCopy {
  const copy: Copy = { ...options, unsaved: null };
  copies.push(copy);
  // ADE Web keeps no copy: drop one an older build left.
  if (isWebClientMode()) remove(copy.key);
  else if (scope !== undefined) settle(copy);
  watch();
  return {
    save(value) {
      if (isWebClientMode()) return;
      if (scope === undefined) copy.unsaved = { value };
      else if (scope === null) remove(copy.key);
      else write(copy.key, scope, value);
    },
    clear() {
      copy.unsaved = null;
      remove(copy.key);
    },
  };
}
