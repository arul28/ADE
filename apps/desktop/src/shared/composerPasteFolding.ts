/**
 * When a paste is too big to be draft text.
 *
 * Pasting a log or a whole file used to dump thousands of lines into the
 * composer, pushing the caret out of reach and making a steer unreadable. The
 * composer folds a large plain-text paste into a staged attachment instead,
 * using the same chip + preview path as any other file: it is named
 * `pasted-<epoch ms>.<ext>` (see `shared/pastedTextAttachment.ts`) and carries
 * a "Pasted · N lines" chip.
 *
 * The rule itself — the thresholds, the line count, the extension sniffing and
 * the file name — lives in `shared/pastedTextAttachment.ts`, which iOS mirrors
 * exactly, so desktop and phone fold the same paste. This module is the thin
 * composer-side adapter: it builds the `File` and marks it, so a paste that
 * reaches the composer can be told apart from a file the user dropped.
 *
 * Small pastes are untouched: they keep native selection-replace and undo. Only
 * plain text is considered — files, images, and short link pastes never reach
 * this decision, so the existing attachment and smart-link paths are unchanged.
 */

import {
  PASTED_TEXT_FILE_MIN_CHARS_EXCLUSIVE,
  PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE,
  pastedTextFilename,
  shouldPasteTextAsFile,
} from "./pastedTextAttachment";

/** Pasted text at or below this length stays draft text. */
export const PASTE_FOLD_CHAR_THRESHOLD = PASTED_TEXT_FILE_MIN_CHARS_EXCLUSIVE;

/** Pasted text at or below this many lines stays draft text. */
export const PASTE_FOLD_LINE_THRESHOLD = PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE;

/** Pasted text's media type, so the host stages it as a plain text file. */
export const PASTED_TEXT_ATTACHMENT_MIME = "text/plain";

const pastedTextAttachmentFiles = new WeakSet<File>();

/**
 * True when a plain-text paste should become a text attachment rather than
 * draft text. Returns false for empty and small pastes, which is what keeps
 * ordinary typing-adjacent pastes on the native path.
 */
export function shouldFoldPastedText(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return shouldPasteTextAsFile(text);
}

/**
 * Build the File the composer stages for a folded paste. Named
 * `pasted-<epoch ms>.<ext>` so the staged file keeps that name on disk and the
 * agent's `[File #k: <name>]` label matches the chip. Constructed (not read
 * from disk), so the existing base64 staging leg carries it to the host.
 */
export function pastedTextAttachmentFile(text: string): File {
  const file = new File([text], pastedTextFilename(text), {
    type: PASTED_TEXT_ATTACHMENT_MIME,
  });
  pastedTextAttachmentFiles.add(file);
  return file;
}

/** True only for files created from ADE's folded-paste path. */
export function isPastedTextAttachmentFile(file: File): boolean {
  return pastedTextAttachmentFiles.has(file);
}
