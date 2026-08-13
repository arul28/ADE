/**
 * Draft edits as pure string arithmetic.
 *
 * Two paths write into the composer long after the user asked them to:
 * dictation, which lands a transcript when the recording stops, and a plugin
 * `composer-action`, whose handler may record, transcribe or generate for
 * minutes before it responds. Both splice text into a draft the user has been
 * editing the entire time.
 *
 * The arithmetic lives here, out of the 6000-line component, because the rule
 * that matters is a property of the INPUTS: this function is a pure function of
 * the draft and caret it is handed, so "insert against the current draft" is
 * something the caller guarantees by reading a live ref at call time rather
 * than something this can enforce. Making that explicit — and testable — is the
 * point of pulling it out.
 */

export type ComposerCaretInsertion = {
  /** The whole draft after the insert. */
  text: string;
  /** Where the caret belongs afterwards: the end of what was inserted. */
  caret: number;
};

/**
 * Insert at the caret, keeping the words on either side apart.
 *
 * Returns `null` for an insertion that is only whitespace — there is nothing to
 * put in, and moving the caret for it would be a visible no-op.
 *
 * `caret` is clamped into the draft rather than trusted. A caret captured
 * before a long-running action can easily point past the end of a draft the
 * user has since shortened, and appending in that case is the answer that never
 * loses text.
 */
export function insertAtComposerCaret(
  draft: string,
  insertion: string,
  caret: number | null,
): ComposerCaretInsertion | null {
  const trimmed = insertion.trim();
  if (!trimmed) return null;
  const start = Math.max(0, Math.min(caret ?? draft.length, draft.length));
  const before = draft.slice(0, start);
  const after = draft.slice(start);
  // Add a separating space when butting up against existing words.
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const piece = `${needsLeadingSpace ? " " : ""}${trimmed}${needsTrailingSpace ? " " : ""}`;
  return { text: `${before}${piece}${after}`, caret: before.length + piece.length };
}
