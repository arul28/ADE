/**
 * User-authored classifierContext for Claude auto permission mode.
 *
 * Security: only user-authored content may occupy an intent-bearing position.
 * Never tool output, never model or subagent text, never a summary of either.
 * If ADE cannot attribute a statement to the user, it does not relay it.
 *
 * The SDK caps classifierContext at 2000 UTF-16 code units (`string.length`
 * in JS). Hook responses that carry it must be returned on the same
 * PostToolUse completion — a late async value is silently ignored.
 */

export const CLASSIFIER_CONTEXT_MAX_UTF16 = 2000;

/**
 * Approval-without-text. Do not include the proposed command: that would
 * launder model-authored text as user consent.
 */
export const CLASSIFIER_APPROVAL_WITHOUT_TEXT = "The user approved this tool call.";

export type ClassifierContextSource = "typed_consent" | "explicit_approval";

export type UserAuthoredClassifierInput = {
  /**
   * Exact user-typed text. Callers must pass only what the user typed into
   * the approval card — never a tool argument, never a model summary.
   */
  typedText?: string | null;
  /** True when the user explicitly accepted (once or for the session). */
  explicitApproval: boolean;
};

export type ClassifierContextRelay = {
  classifierContext: string;
  source: ClassifierContextSource;
  truncated: boolean;
};

export function clipUtf16(text: string, max: number = CLASSIFIER_CONTEXT_MAX_UTF16): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, max)), truncated: true };
}

/**
 * Build the string ADE will put in an intent-bearing classifierContext slot.
 * Returns null when there is nothing attributable to the user.
 */
export function buildClassifierContext(
  input: UserAuthoredClassifierInput,
): ClassifierContextRelay | null {
  const typed = typeof input.typedText === "string" ? input.typedText.trim() : "";
  if (typed.length > 0) {
    const clipped = clipUtf16(typed);
    return {
      classifierContext: clipped.text,
      source: "typed_consent",
      truncated: clipped.truncated,
    };
  }
  if (input.explicitApproval) {
    return {
      classifierContext: CLASSIFIER_APPROVAL_WITHOUT_TEXT,
      source: "explicit_approval",
      truncated: false,
    };
  }
  return null;
}

export function classifierContextAuditMessage(relay: ClassifierContextRelay): {
  message: string;
  detail?: string;
} {
  const message = relay.source === "typed_consent"
    ? "Relayed user consent to the auto-mode classifier."
    : "Relayed an explicit approval to the auto-mode classifier.";
  const detail = relay.truncated
    ? "Truncated to 2000 characters."
    : undefined;
  return detail ? { message, detail } : { message };
}
