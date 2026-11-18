import { createLocalStore, finiteNumber } from "./localStore";

/**
 * One budget for everything ADE shows that the person did not ask for:
 * "What's new" opening by itself, feature tip cards and surveys. Each keeps
 * its own pace too; this is the cap over all of them together, so a day
 * never brings a What's new, a tip and a survey on top of each other.
 *
 * - **At most one a day**, whichever kind it is. A situational suggestion
 *   (a real signal, like usage running low) is never held back by the
 *   budget, but it spends it, so nothing else follows it that day.
 * - **A new account's first three days are quiet.** The person is learning
 *   ADE; the tour and their own work come first.
 *
 * The last showing follows the account (`onboardingSync.ts`), so the desktop
 * and ADE Web share one budget. Until the account is known, this computer's
 * copy decides and a new account is not assumed.
 */

/** A little under a day, so a daily habit is not missed by minutes. */
const UNASKED_GAP_MS = 20 * 3_600_000;
/** A new account sees nothing unasked for this long. */
const NEW_ACCOUNT_QUIET_MS = 3 * 24 * 3_600_000;

const lastShownStore = createLocalStore({
  key: "ade.unasked.lastShownAt.v1",
  event: "ade:unasked-last-shown",
  parse: (stored) => finiteNumber(stored) ?? 0,
});

/** When the signed-in account was created; null when signed out or unknown. */
let accountCreatedAt: number | null = null;

/** Set by the onboarding sync pass, from the signed-in account's id. */
export function setUnaskedAccountCreatedAt(createdAt: number | null): void {
  if (accountCreatedAt === createdAt) return;
  accountCreatedAt = createdAt;
  // A timer armed before the account was known re-plans with its quiet days.
  lastShownStore.notify();
}

export function lastUnaskedAt(): number {
  return lastShownStore.get();
}

/** Takes a later showing from another computer or ADE Web. */
export function adoptLastUnaskedAt(at: number | undefined): void {
  if (at !== undefined && at > lastShownStore.get()) lastShownStore.set(at);
}

/** Another account signed in here: its last showing replaces this computer's. */
export function replaceLastUnaskedAt(at: number | undefined): void {
  lastShownStore.set(at ?? 0);
}

/** The earliest time something unasked may show (0: now); `last`: the last showing to count from. */
export function nextUnaskedAt(last = lastShownStore.get()): number {
  const afterGap = last ? last + UNASKED_GAP_MS : 0;
  const afterQuiet = accountCreatedAt != null ? accountCreatedAt + NEW_ACCOUNT_QUIET_MS : 0;
  return Math.max(afterGap, afterQuiet);
}

export function unaskedAllowed(now = Date.now(), last = lastShownStore.get()): boolean {
  return now >= nextUnaskedAt(last);
}

/** Something unasked showed: nothing else unasked for a day. */
export function markUnaskedShown(now = Date.now()): void {
  if (now > lastShownStore.get()) lastShownStore.set(now);
}

export function subscribeUnaskedBudget(listener: () => void): () => void {
  return lastShownStore.subscribe(listener);
}
