// ---------------------------------------------------------------------------
// Composer clipboard payload — how a chip survives copy and paste.
// ---------------------------------------------------------------------------
//
// A composer chip is a `contentEditable=false` span whose DOM text is the LABEL
// while its serialized form lives in `data-composer-chip-text`. A native copy
// reads the DOM, so it yields "owner/repo#123" or a chat title and loses the URL
// or the `@chat:<id>` pointer. File chips survived only by accident: their label
// and their token are the same string.
//
// So copy and cut write two flavours of the same selection:
//
//   text/plain          canonical tokens — what a terminal, a commit message,
//                       or another app receives. Always meaningful on its own.
//   text/x-ade-composer this payload — the same text plus the label for each
//                       token, so the receiving composer can rebuild the pills
//                       with their human names instead of raw pointers.
//
// The labels are the reason the custom type exists. `@chat:9e2315e8-…` is a
// valid pointer anywhere, but only the chat that owns it knows it is called
// "Lane B — composer". Carrying the label with the text is what lets a chip
// paste into a DIFFERENT chat, or a different lane, and still read as a chip.
//
// Anything unparseable degrades to the plain text, which is always present.

export const COMPOSER_CLIPBOARD_MIME = "text/x-ade-composer";

const MAX_CHIPS = 64;
/** Cap on entries examined, so rejects cannot be used to burn paste-path time. */
const MAX_RAW_CHIP_ENTRIES = MAX_CHIPS * 8;
const MAX_LABEL_CHARS = 256;
const MAX_TEXT_CHARS = 100_000;

export type ComposerClipboardChip = {
  /** Canonical serialized form, exactly as it appears in `text`. */
  token: string;
  /** Human label the source composer was displaying. */
  label: string;
};

export type ComposerClipboardPayload = {
  version: 1;
  /** The plain-text form of the selection, tokens included. */
  text: string;
  /** Label for each chip in `text`. Order follows first appearance. */
  chips: ComposerClipboardChip[];
};

export function serializeComposerClipboard(payload: ComposerClipboardPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse a clipboard payload. Defensive on purpose: the clipboard is shared with
 * every app on the machine, so a value of this MIME type may come from an older
 * ADE, a newer ADE, or something else entirely. A payload that does not parse
 * is not an error — the caller falls back to `text/plain`.
 */
export function parseComposerClipboard(raw: string | null | undefined): ComposerClipboardPayload | null {
  if (!raw) return null;
  if (raw.length > MAX_TEXT_CHARS * 2) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.text !== "string" || record.text.length > MAX_TEXT_CHARS) return null;

  const chips: ComposerClipboardChip[] = [];
  const rawChips = Array.isArray(record.chips) ? record.chips : [];
  const seen = new Set<string>();
  // Bound the ITERATIONS, not just the accepted chips: every rejected entry
  // still costs an `includes` scan over the pasted text, and the clipboard is
  // writable by every app on the machine. Thousands of rejects against a large
  // text is real work on the paste path.
  let examined = 0;
  for (const entry of rawChips) {
    if (chips.length >= MAX_CHIPS) break;
    if (examined >= MAX_RAW_CHIP_ENTRIES) break;
    examined += 1;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const chip = entry as Record<string, unknown>;
    const token = typeof chip.token === "string" ? chip.token.trim() : "";
    const label = typeof chip.label === "string" ? chip.label.trim() : "";
    if (!token || !label || seen.has(token)) continue;
    // A label that does not appear in the text describes nothing in this paste.
    if (!record.text.includes(token)) continue;
    seen.add(token);
    chips.push({ token, label: label.slice(0, MAX_LABEL_CHARS) });
  }

  return { version: 1, text: record.text, chips };
}

/** Build a payload from the plain text plus whatever labels the source knows. */
export function buildComposerClipboardPayload(
  text: string,
  labelForToken: ReadonlyMap<string, string>,
): ComposerClipboardPayload {
  const chips: ComposerClipboardChip[] = [];
  for (const [token, label] of labelForToken) {
    if (chips.length >= MAX_CHIPS) break;
    const trimmedLabel = label?.trim();
    if (!token || !trimmedLabel || !text.includes(token)) continue;
    chips.push({ token, label: trimmedLabel.slice(0, MAX_LABEL_CHARS) });
  }
  return { version: 1, text: text.slice(0, MAX_TEXT_CHARS), chips };
}
