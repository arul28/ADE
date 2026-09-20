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
 * A host that cannot spend credits answers with its own sentence, either with
 * no status at all or with the catch-all `failure`. Either way that sentence is
 * shown verbatim — "That Codex account is not signed in on this computer." says
 * what to do next, where the generic failure line says nothing — and a reset
 * that did not happen is never reported as one.
 *
 * The same tolerance covers the wire: a newer host may name a status this build
 * has never heard of, and an unrecognized name must never be read as an applied
 * reset. It falls through to the host's own sentence, then to `ok` — which only
 * a host that really did spend the credit sets — and finally to the generic
 * failure line. `workResetCreditOutcomeText` on iOS mirrors this fallthrough.
 */
export type ResetCreditOutcomeKey =
  | keyof typeof RESET_CREDIT_OUTCOME_TEXT
  /** The host answered with its own sentence; there is no table entry for it. */
  | "hostMessage";

/**
 * Which of the outcomes this answer is — decided once, from the wire value, so
 * every caller branches on the same verdict instead of re-deriving it (or, far
 * worse, comparing the rendered sentence).
 */
export function resetCreditOutcomeKey(
  result: UsageResetCreditResult | null,
): ResetCreditOutcomeKey {
  const status = result?.status;
  // `failure` is the "something went wrong" bucket, so it never outranks the
  // host's own explanation; the four real outcomes always phrase themselves.
  // `Object.hasOwn`, not `in`: the status is a wire value, and `in` also
  // answers true for every inherited key, so a host naming `toString` or
  // `constructor` would resolve to a function rather than a sentence.
  if (status && status !== "failure" && Object.hasOwn(RESET_CREDIT_OUTCOME_TEXT, status)) {
    return status;
  }
  if (result && !result.ok && result.message?.trim()) return "hostMessage";
  if (result?.ok && status !== "failure") return "reset";
  return "failure";
}

export function resetCreditOutcomeText(result: UsageResetCreditResult | null): string {
  const key = resetCreditOutcomeKey(result);
  if (key === "hostMessage") {
    return result?.message?.trim() ?? RESET_CREDIT_OUTCOME_TEXT.failure;
  }
  return RESET_CREDIT_OUTCOME_TEXT[key];
}

/**
 * Did the credit actually clear the windows?
 *
 * The verdict reads the outcome key, never the rendered sentence: a surface
 * that tests `text === "Reset applied…"` both stops recognizing a success the
 * moment that copy is reworded, and reports an *applied* reset for a failing
 * host that happens to echo that exact sentence back.
 */
export function resetCreditApplied(result: UsageResetCreditResult | null): boolean {
  return resetCreditOutcomeKey(result) === "reset";
}
