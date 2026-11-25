import { PRIVACY_POLICY_VERSION } from "../../shared/legalLinks";

/**
 * Which privacy policy version this window last told the person about. Kept
 * per window origin (the desktop app, or ADE on the web in one browser), so a
 * person with three computers sees the notice once on each: it is a notice,
 * not a consent, and the agreement itself is the sign-up line and the
 * policy's "if you keep using ADE" clause.
 */
const STORAGE_KEY = "ade.privacyPolicyNotice.seenVersion";

export function privacyPolicyNoticeSeen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === PRIVACY_POLICY_VERSION;
  } catch {
    // No storage (a locked-down browser): never nag on every load.
    return true;
  }
}

/** Also called after a sign-in, whose card showed the agree line for this version. */
export function markPrivacyPolicyNoticeSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, PRIVACY_POLICY_VERSION);
  } catch {
    // Nothing to keep it in.
  }
}
