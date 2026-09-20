import type { UsageResetCreditResult } from "./types";

/**
 * What spending a reset credit did, in the user's words.
 *
 * Shared because two surfaces phrase the same four outcomes — the usage popup's
 * account row and the chat's "a reset credit is banked" notice — and a person
 * who clicks one after the other must not be told two different things about
 * the same server answer.
 */
export const RESET_CREDIT_OUTCOME_TEXT = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
  failure: "Could not use the reset credit.",
} as const;

/**
 * A host that cannot spend credits answers with its own sentence and no status.
 * That sentence is shown verbatim; a reset that did not happen is never
 * reported as one.
 */
export function resetCreditOutcomeText(result: UsageResetCreditResult | null): string {
  const status = result?.status;
  if (status && status in RESET_CREDIT_OUTCOME_TEXT) return RESET_CREDIT_OUTCOME_TEXT[status];
  if (result && !result.ok && result.message) return result.message;
  if (result?.ok) return RESET_CREDIT_OUTCOME_TEXT.reset;
  return RESET_CREDIT_OUTCOME_TEXT.failure;
}
