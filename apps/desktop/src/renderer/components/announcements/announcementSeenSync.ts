import {
  accountCreatedAtFromUserId,
  ANNOUNCEMENTS_SEEN_SETTING_KEY,
  normalizeSeenAnnouncements,
  seenAnnouncementsCover,
} from "../../../shared/announcementsSeen";
import { createAccountValueSync, useAccountValueSync } from "../../lib/accountValueSync";
import { createLocalStore, storedRecord } from "../../onboarding/localStore";
import { setUnaskedAccountCreatedAt } from "../../onboarding/unaskedBudget";
import {
  mergeSeenAnnouncementsFromAccount,
  readSeenAnnouncements,
  setAnnouncementsAccountCreatedAt,
  subscribeSeenAnnouncements,
} from "./announcementSeen";

/**
 * Keeps the "What's new" seen pages on the account, so a page seen on the
 * desktop does not show again in ADE Web or on another computer.
 *
 * One account setting (`announcements.seen`, account-wide) holds the union of
 * every computer's seen pages. A pass reads it, adds what it holds to this
 * computer's copy, and writes the union back when this computer knows a page
 * the account does not. So a local "seen" always wins, and nothing is ever
 * taken away. Two computers that write at once can drop one page from the
 * account copy; each one's next pass puts it back, and its own local copy
 * never forgets it.
 *
 * The local copy is per computer and an account is not: pages this computer
 * saw under another account stay seen here but are never written to this one
 * (`accountMarkStore`).
 *
 * The pass loop, the brain pull and the relay are `accountValueSync.ts`'s.
 */

/** A pass never holds the in-project showing back longer than this. */
const PASS_TIMEOUT_MS = 8_000;

/**
 * The account this computer last reconciled with, and the pages it already
 * held when that account signed in in place of another: those belong to the
 * other account, so they are not written to this one.
 */
type AccountMark = { userId: string; foreign: string[] };
const accountMarkStore = createLocalStore<AccountMark | null>({
  key: "ade.announcements.seenAccount.v1",
  event: "ade:announcements-seen-account",
  parse: (stored) => {
    const record = storedRecord(stored);
    const userId = typeof record?.userId === "string" ? record.userId : "";
    if (!userId) return null;
    const foreign = Array.isArray(record?.foreign) ? record.foreign.filter((id): id is string => typeof id === "string") : [];
    return { userId, foreign };
  },
});

/** This account's mark, written first when the account changed. */
function accountMarkFor(userId: string): AccountMark {
  const mark = accountMarkStore.get();
  if (mark?.userId === userId) return mark;
  // The first account here owns the pages seen before any sign-in; a later
  // account owns none of the pages already here.
  const next = { userId, foreign: mark ? Object.keys(readSeenAnnouncements()) : [] };
  accountMarkStore.set(next);
  return next;
}

const seenSync = createAccountValueSync({
  key: ANNOUNCEMENTS_SEEN_SETTING_KEY,
  timeoutMs: PASS_TIMEOUT_MS,
  fingerprint: ["announcements", "seen-sync"],
  onAccount: (userId) => {
    // First: the showing waits for this pass, and a page from before the
    // account was created must not show to a new one.
    setAnnouncementsAccountCreatedAt(accountCreatedAtFromUserId(userId));
    setUnaskedAccountCreatedAt(accountCreatedAtFromUserId(userId));
    if (userId) accountMarkFor(userId);
  },
  reconcile: ({ remote: value, userId }) => {
    const remote = normalizeSeenAnnouncements(value);
    const merged = mergeSeenAnnouncementsFromAccount(remote);
    const foreign = new Set(accountMarkFor(userId).foreign);
    const own = Object.fromEntries(Object.entries(merged).filter(([id]) => !foreign.has(id) || id in remote));
    return { write: seenAnnouncementsCover(remote, own) ? null : own };
  },
});

const LOCAL_CHANGES = [subscribeSeenAnnouncements];

/**
 * One reconcile with the account. Resolves when it is done, failed, or took
 * too long; never rejects. A call while one runs makes one more pass after it.
 */
export function reconcileSeenAnnouncements(): Promise<void> {
  return seenSync.reconcile();
}

/**
 * Reconciles when the app opens, when an account signs in, when the brain
 * pulls new account settings, and when this computer marks a page seen.
 */
export function useAnnouncementSeenSync(): void {
  useAccountValueSync(seenSync, LOCAL_CHANGES);
}
