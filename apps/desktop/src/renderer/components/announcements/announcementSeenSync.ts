import { useEffect } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { captureError } from "../../../shared/sentry/capture";
import {
  ANNOUNCEMENTS_SEEN_SETTING_KEY,
  normalizeSeenAnnouncements,
  seenAnnouncementsCover,
} from "../../../shared/announcementsSeen";
import { fetchAccountStatus, subscribeAccountStatus } from "../../lib/account";
import { isWebClientMode } from "../../lib/webClientMode";
import { createLocalStore, storedRecord } from "../../onboarding/localStore";
import {
  mergeSeenAnnouncementsFromAccount,
  readSeenAnnouncements,
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
 * The desktop reaches the setting through its brain (`window.ade.accountSettings`).
 * ADE Web reaches it through the connected computer's brain, which answers only
 * for this one key and never for a lane-share guest. Signed out, offline, or
 * with no brain, a pass does nothing and the local copy decides.
 */

/** A pass never holds the in-project showing back longer than this. */
const PASS_TIMEOUT_MS = 8_000;

let running: Promise<void> | null = null;
let rerun = false;
let reportedFailure = false;
/** The account whose settings the desktop brain pulled fresh this session. */
let brainSyncedFor: string | null = null;

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

async function onePass(): Promise<void> {
  const api = window.ade?.accountSettings;
  if (!api?.get || !api.set) return;
  const status = await fetchAccountStatus().catch(() => null);
  const userId = status?.signedIn ? status.userId?.trim() || null : null;
  if (!userId) return;
  const mark = accountMarkFor(userId);
  // The desktop brain's copy can be older than the account (another computer
  // saw a page while this one was closed), and an empty copy written back
  // would drop other computers' pages: pull once per account first. ADE Web
  // asks the connected computer, whose write is a merge, never a replace.
  const web = isWebClientMode();
  if (!web && brainSyncedFor !== userId) {
    const synced = await api.sync().catch(() => null);
    if (synced?.ok) brainSyncedFor = userId;
  }
  const read = await api.get({ scope: ACCOUNT_SCOPE_ALL, key: ANNOUNCEMENTS_SEEN_SETTING_KEY });
  if (!read.ok) return;
  const remote = normalizeSeenAnnouncements(read.value);
  const merged = mergeSeenAnnouncementsFromAccount(remote);
  const foreign = new Set(mark.foreign);
  const own = Object.fromEntries(Object.entries(merged).filter(([id]) => !foreign.has(id) || id in remote));
  if (seenAnnouncementsCover(remote, own)) return;
  if (!web && brainSyncedFor !== userId && Object.keys(remote).length === 0) return;
  // The sync and the read above can span a sign-in change. Write only while
  // the same account is still signed in, so this pass's filter never reaches
  // another account.
  const still = await fetchAccountStatus().catch(() => null);
  if ((still?.signedIn ? still.userId?.trim() || null : null) !== userId) return;
  await api.set({ scope: ACCOUNT_SCOPE_ALL, key: ANNOUNCEMENTS_SEEN_SETTING_KEY, value: own });
}

/**
 * One reconcile with the account. Resolves when it is done, failed, or took
 * too long; never rejects. A call while one runs makes one more pass after it.
 */
export function reconcileSeenAnnouncements(): Promise<void> {
  if (running) {
    rerun = true;
  } else {
    running = startPasses().finally(() => {
      running = null;
    });
  }
  // A caller that joins a pass already running waits no longer than one that
  // started it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PASS_TIMEOUT_MS);
  });
  return Promise.race([running, timeout]).finally(() => clearTimeout(timer));
}

function startPasses(): Promise<void> {
  return (async () => {
    do {
      rerun = false;
      try {
        await onePass();
      } catch (error) {
        // The local copy stands; the next trigger tries again. Report the
        // first failure only: the triggers repeat.
        if (!reportedFailure) {
          reportedFailure = true;
          captureError(error, { fingerprint: ["announcements", "seen-sync"], level: "warning", handled: true });
        }
      }
    } while (rerun);
  })();
}

/**
 * Reconciles when the app opens, when an account signs in, when the brain
 * pulls new account settings, and when this computer marks a page seen.
 */
export function useAnnouncementSeenSync(): void {
  useEffect(() => {
    const reconcile = () => void reconcileSeenAnnouncements();
    reconcile();
    let signedIn: boolean | null = null;
    const stopAccount = subscribeAccountStatus((status) => {
      if (status.signedIn === signedIn) return;
      signedIn = status.signedIn;
      if (status.signedIn) reconcile();
    });
    const stopRemote = window.ade?.accountSettings?.onChanged?.(reconcile);
    const stopLocal = subscribeSeenAnnouncements(reconcile);
    return () => {
      stopAccount();
      stopRemote?.();
      stopLocal();
    };
  }, []);
}
