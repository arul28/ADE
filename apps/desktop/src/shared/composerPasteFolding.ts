/**
 * When a paste is too big to be draft text.
 *
 * Pasting a log or a whole file used to dump thousands of lines into the
 * composer, pushing the caret out of reach and making a steer unreadable. The
 * composer folds a large plain-text paste into a staged `.txt` attachment
 * instead, using the same chip + preview path as any other file.
 *
 * Small pastes are untouched: they keep native selection-replace and undo. Only
 * plain text is considered — files, images, and short link pastes never reach
 * this decision, so the existing attachment and smart-link paths are unchanged.
 */

/** Pasted text at or below this length stays draft text. */
export const PASTE_FOLD_CHAR_THRESHOLD = 2_000;

/** Pasted text at or below this many lines stays draft text. */
export const PASTE_FOLD_LINE_THRESHOLD = 20;

/** The staged attachment's name; the Files viewer picks the type from it. */
export const PASTED_TEXT_ATTACHMENT_FILENAME = "pasted-text.txt";

/** Pasted text's media type, so the host stages it as a plain text file. */
export const PASTED_TEXT_ATTACHMENT_MIME = "text/plain";

/**
 * Lines in pasted text, CRLF and lone-CR normalized, a single trailing newline
 * ignored. A text that ends with one newline is not one line longer than it is.
 */
function countPasteLines(text: string): number {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!normalized) return 0;
  return normalized.split("\n").length;
}

/**
 * True when a plain-text paste should become a text attachment rather than
 * draft text. Returns false for empty and small pastes, which is what keeps
 * ordinary typing-adjacent pastes on the native path.
 */
export function shouldFoldPastedText(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text.length > PASTE_FOLD_CHAR_THRESHOLD) return true;
  return countPasteLines(text) > PASTE_FOLD_LINE_THRESHOLD;
}

/**
 * Build the File the composer stages for a folded paste. Constructed (not read
 * from disk), so the existing base64 staging leg carries it to the host.
 */
export function pastedTextAttachmentFile(text: string): File {
  return new File([text], PASTED_TEXT_ATTACHMENT_FILENAME, {
    type: PASTED_TEXT_ATTACHMENT_MIME,
  });
}
