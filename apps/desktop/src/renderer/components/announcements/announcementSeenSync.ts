import { useEffect } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import {
  ANNOUNCEMENTS_SEEN_SETTING_KEY,
  normalizeSeenAnnouncements,
  seenAnnouncementsCover,
} from "../../../shared/announcementsSeen";
import { subscribeAccountStatus } from "../../lib/account";
import { isWebClientMode } from "../../lib/webClientMode";
import {
  mergeSeenAnnouncementsFromAccount,
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
 * The desktop reaches the setting through its brain (`window.ade.accountSettings`).
 * ADE Web reaches it through the connected computer's brain, which answers only
 * for this one key and never for a lane-share guest. Signed out, offline, or
 * with no brain, a pass does nothing and the local copy decides.
 */

/** A pass never holds the in-project showing back longer than this. */
const PASS_TIMEOUT_MS = 8_000;

let running: Promise<void> | null = null;
let rerun = false;
/** The desktop brain merged with the account once this session. */
let brainSynced = false;

async function onePass(): Promise<void> {
  const api = window.ade?.accountSettings;
  if (!api?.get || !api.set) return;
  const read = await api.get({ scope: ACCOUNT_SCOPE_ALL, key: ANNOUNCEMENTS_SEEN_SETTING_KEY });
  if (!read.ok) return;
  const remote = normalizeSeenAnnouncements(read.value);
  const merged = mergeSeenAnnouncementsFromAccount(remote);
  if (seenAnnouncementsCover(remote, merged)) return;
  // The write replaces the account's copy. On the desktop, a brain that has
  // not pulled yet reads an empty copy, and writing over the account then
  // would drop other computers' pages until they write again; so it writes
  // only once the copy it read has something in it, or after one full sync.
  // ADE Web's write is merged into the brain's copy, never replaces it.
  if (!isWebClientMode() && Object.keys(remote).length === 0 && !brainSynced) {
    const synced = await api.sync().catch(() => null);
    if (!synced?.ok) return;
    brainSynced = true;
    rerun = true;
    return;
  }
  await api.set({ scope: ACCOUNT_SCOPE_ALL, key: ANNOUNCEMENTS_SEEN_SETTING_KEY, value: merged });
}

/**
 * One reconcile with the account. Resolves when it is done, failed, or took
 * too long; never rejects. A call while one runs makes one more pass after it.
 */
export function reconcileSeenAnnouncements(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  const pass = (async () => {
    do {
      rerun = false;
      try {
        await onePass();
      } catch {
        // The local copy stands; the next trigger tries again.
      }
    } while (rerun);
  })();
  running = pass.finally(() => {
    running = null;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PASS_TIMEOUT_MS);
  });
  return Promise.race([running, timeout]).finally(() => clearTimeout(timer));
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
