import { useEffect } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../shared/accountSettingsScope";
import { accountCreatedAtFromUserId } from "../../shared/announcementsSeen";
import {
  mergeOnboardingProgressRecords,
  normalizeOnboardingProgressRecord,
  ONBOARDING_PROGRESS_SETTING_KEY,
  sameOnboardingProgressRecord,
  type OnboardingProgressRecord,
} from "../../shared/onboardingProgressRecord";
import { captureError } from "../../shared/sentry/capture";
import { fetchAccountStatus, subscribeAccountStatus } from "../lib/account";
import { isWebClientMode } from "../lib/webClientMode";
import {
  adoptOnboardingProgressRecord,
  onboardingProgressRecord,
  subscribeOnboardingProgress,
} from "./onboardingProgress";
import { adoptDoneTipIds, doneTipIds } from "./situationalSuggestions";
import { adoptLastUnaskedAt, lastUnaskedAt, setUnaskedAccountCreatedAt, subscribeUnaskedBudget } from "./unaskedBudget";

/**
 * Keeps onboarding on the account (`onboarding.progress`, account-wide), so
 * the desktop, ADE Web and every other computer agree on it: the tour,
 * the hints, the tips already offered, and the shared unasked budget.
 *
 * A pass reads the account's copy, combines it with this computer's
 * (`mergeOnboardingProgressRecords`: answers only move forward), takes the
 * result here, and writes it back when the account lacked something. Two
 * writers at once can drop one answer from the account copy; each one's next
 * pass puts it back, and neither local copy forgets it.
 *
 * The desktop reaches the setting through its brain; ADE Web through the
 * account relay, with or without a computer. Signed out, offline, or with no
 * settings bridge, a pass does nothing and this computer's copy decides.
 */

/** A caller waiting on a pass (the web welcome) never waits longer than this. */
const PASS_TIMEOUT_MS = 6_000;

let running: Promise<void> | null = null;
let rerun = false;
let reportedFailure = false;
/** The account whose settings the desktop brain pulled fresh this session. */
let brainSyncedFor: string | null = null;
/** The account the last pass finished for: callers can tell a known answer from none yet. */
let reconciledFor: string | null = null;

function localRecord(): OnboardingProgressRecord {
  const record = onboardingProgressRecord();
  const tips = [...doneTipIds()];
  if (tips.length) record.tipsDone = tips;
  const last = lastUnaskedAt();
  if (last) record.lastUnaskedAt = last;
  return normalizeOnboardingProgressRecord(record);
}

function adopt(merged: OnboardingProgressRecord): void {
  adoptOnboardingProgressRecord(merged);
  if (merged.tipsDone?.length) adoptDoneTipIds(merged.tipsDone);
  adoptLastUnaskedAt(merged.lastUnaskedAt);
}

async function onePass(): Promise<void> {
  const status = await fetchAccountStatus().catch(() => null);
  const userId = status?.signedIn ? status.userId?.trim() || null : null;
  setUnaskedAccountCreatedAt(accountCreatedAtFromUserId(userId));
  const api = window.ade?.accountSettings;
  if (!userId || !api?.get || !api.set) return;
  const web = isWebClientMode();
  // The brain's copy can be older than the account (another computer moved on
  // while this one was closed): pull once per account first, so an old copy
  // is never written back over newer answers.
  if (!web && brainSyncedFor !== userId && api.sync) {
    const synced = await api.sync().catch(() => null);
    if (synced?.ok) brainSyncedFor = userId;
  }
  const read = await api.get({ scope: ACCOUNT_SCOPE_ALL, key: ONBOARDING_PROGRESS_SETTING_KEY });
  if (!read.ok) return;
  const remote = normalizeOnboardingProgressRecord(read.value);
  const merged = mergeOnboardingProgressRecords(localRecord(), remote);
  adopt(merged);
  reconciledFor = userId;
  if (sameOnboardingProgressRecord(remote, merged)) return;
  // Not pulled fresh and the account looks empty: it may only be this brain's stale copy. Wait for a pass that pulled.
  if (!web && brainSyncedFor !== userId && Object.keys(remote).length === 0) return;
  const still = await fetchAccountStatus().catch(() => null);
  if ((still?.signedIn ? still.userId?.trim() || null : null) !== userId) return;
  await api.set({ scope: ACCOUNT_SCOPE_ALL, key: ONBOARDING_PROGRESS_SETTING_KEY, value: merged });
}

function startPasses(): Promise<void> {
  return (async () => {
    do {
      rerun = false;
      try {
        await onePass();
      } catch (error) {
        if (!reportedFailure) {
          reportedFailure = true;
          captureError(error, { fingerprint: ["onboarding", "progress-sync"], level: "warning", handled: true });
        }
      }
    } while (rerun);
  })();
}

/** One reconcile with the account. Resolves when done, failed or too slow; never rejects. */
export function reconcileOnboardingProgress(): Promise<void> {
  if (running) {
    rerun = true;
  } else {
    running = startPasses().finally(() => {
      running = null;
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PASS_TIMEOUT_MS);
  });
  return Promise.race([running, timeout]).finally(() => clearTimeout(timer));
}

/** Whether a pass has read the account's copy for this account (false: the local copy is all there is so far). */
export function onboardingReconciledFor(userId: string | null): boolean {
  return userId != null && reconciledFor === userId;
}

/** Local changes are written a moment later, together; a burst of them is one pass. */
const LOCAL_CHANGE_DELAY_MS = 1_500;

/**
 * Reconciles when the app opens, when an account signs in, when the account
 * settings change elsewhere, and shortly after onboarding moves here.
 */
export function useOnboardingSync(): void {
  useEffect(() => {
    const reconcile = () => void reconcileOnboardingProgress();
    reconcile();
    let signedIn: boolean | null = null;
    const stopAccount = subscribeAccountStatus((status) => {
      if (status.signedIn === signedIn) return;
      signedIn = status.signedIn;
      if (status.signedIn) reconcile();
    });
    const stopRemote = window.ade?.accountSettings?.onChanged?.(reconcile);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        reconcile();
      }, LOCAL_CHANGE_DELAY_MS);
    };
    const stopProgress = subscribeOnboardingProgress(soon);
    const stopBudget = subscribeUnaskedBudget(soon);
    return () => {
      stopAccount();
      stopRemote?.();
      stopProgress();
      stopBudget();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
