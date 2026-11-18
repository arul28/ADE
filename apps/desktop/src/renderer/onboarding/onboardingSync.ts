import { accountCreatedAtFromUserId } from "../../shared/announcementsSeen";
import {
  mergeOnboardingProgressRecords,
  normalizeOnboardingProgressRecord,
  ONBOARDING_PROGRESS_SETTING_KEY,
  sameOnboardingProgressRecord,
  type OnboardingProgressRecord,
} from "../../shared/onboardingProgressRecord";
import { createAccountValueSync, useAccountValueSync } from "../lib/accountValueSync";
import { createLocalStore, storedRecord } from "./localStore";
import {
  adoptOnboardingProgressRecord,
  onboardingProgressRecord,
  replaceOnboardingProgressRecord,
  subscribeOnboardingProgress,
} from "./onboardingProgress";
import { adoptDoneTipIds, doneTipIds, replaceDoneTipIds, subscribeTipProgress } from "./situationalSuggestions";
import {
  adoptLastUnaskedAt,
  lastUnaskedAt,
  replaceLastUnaskedAt,
  setUnaskedAccountCreatedAt,
  subscribeUnaskedBudget,
} from "./unaskedBudget";

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
 * The local copy is per computer and an account is not. What this computer
 * held before its first account signed in belongs to that account; when
 * another account signs in later, its copy replaces this computer's, so one
 * person's finished tour never reaches another's account (`ownerStore`).
 *
 * The pass loop, the brain pull and the relay are `accountValueSync.ts`'s.
 */

/** A caller waiting on a pass (the web welcome) never waits longer than this. */
const PASS_TIMEOUT_MS = 6_000;
/** Local changes are written a moment later, together; a burst of them is one pass. */
const LOCAL_CHANGE_DELAY_MS = 1_500;

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

function replaceWith(record: OnboardingProgressRecord): void {
  replaceOnboardingProgressRecord(record);
  replaceDoneTipIds(record.tipsDone ?? []);
  replaceLastUnaskedAt(record.lastUnaskedAt);
}

/** The account this computer's copy belongs to (the last one a pass read). */
const ownerStore = createLocalStore<{ userId: string } | null>({
  key: "ade.onboarding.syncedAccount.v1",
  event: "ade:onboarding-synced-account",
  parse: (stored) => {
    const userId = storedRecord(stored)?.userId;
    return typeof userId === "string" && userId ? { userId } : null;
  },
});

const progressSync = createAccountValueSync({
  key: ONBOARDING_PROGRESS_SETTING_KEY,
  timeoutMs: PASS_TIMEOUT_MS,
  fingerprint: ["onboarding", "progress-sync"],
  onAccount: (userId) => setUnaskedAccountCreatedAt(accountCreatedAtFromUserId(userId)),
  reconcile: ({ remote: value, userId, fresh }) => {
    const remote = normalizeOnboardingProgressRecord(value);
    const owner = ownerStore.get()?.userId ?? null;
    if (owner !== userId) {
      // Another account's copy is replaced only by this account's current one, never a stale cache.
      if (owner && !fresh) return { write: null, taken: false };
      if (owner) replaceWith(remote);
      ownerStore.set({ userId });
    }
    const merged = mergeOnboardingProgressRecords(localRecord(), remote);
    adopt(merged);
    return { write: sameOnboardingProgressRecord(remote, merged) ? null : merged };
  },
});

/** One reconcile with the account. Resolves when done, failed or too slow; never rejects. */
export function reconcileOnboardingProgress(): Promise<void> {
  return progressSync.reconcile();
}

/** Whether a pass has read the account's copy for this account (false: the local copy is all there is so far). */
export function onboardingReconciledFor(userId: string | null): boolean {
  return progressSync.reconciledFor(userId);
}

const LOCAL_CHANGES = [subscribeOnboardingProgress, subscribeUnaskedBudget, subscribeTipProgress];

/**
 * Reconciles when the app opens, when an account signs in, when the account
 * settings change elsewhere, and shortly after onboarding moves here.
 */
export function useOnboardingSync(): void {
  useAccountValueSync(progressSync, LOCAL_CHANGES, LOCAL_CHANGE_DELAY_MS);
}
