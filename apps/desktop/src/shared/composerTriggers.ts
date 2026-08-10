// Cursor-relative trigger detection for the prompt composers (desktop chat
// composer, ade-code TUI prompt, mirrored on iOS). A trigger is an in-progress
// `/command` or `@` query that ends exactly at the cursor, so suggestion menus
// can open anywhere in the draft — not just at position 0.

export type ComposerTriggerType = "slash" | "at";

export type ComposerTrigger = {
  type: ComposerTriggerType;
  /** Text typed after the trigger character, up to the cursor. */
  query: string;
  /** Index of the trigger character (`/` or `@`) in the full text. */
  start: number;
};

// Both triggers must sit at a word boundary (start of text or after
// whitespace) and their token must run to the cursor. The slash token is a
// command name only: no whitespace and no `/` inside, so paths like
// `/usr/bin` and fractions like `3/4` never trigger. The `@` token allows `/`
// (file paths) and spaces (chat names are commonly multi-word), but not
// another `@` or a newline, so emails and cross-line prose never trigger.
const AT_TRIGGER_RE = /(?:^|[ \t\r\n])(@([^@\r\n]*))$/;
const SLASH_TRIGGER_RE = /(?:^|\s)(\/([^\s/]*))$/;

export function detectComposerTrigger(text: string, cursorPos: number): ComposerTrigger | null {
  const cursor = Math.max(0, Math.min(Math.floor(cursorPos), text.length));
  const before = text.slice(0, cursor);
  const at = AT_TRIGGER_RE.exec(before);
  const slash = SLASH_TRIGGER_RE.exec(before);
  const atStart = at ? before.length - at[1]!.length : -1;
  const slashStart = slash ? before.length - slash[1]!.length : -1;
  if (atStart < 0 && slashStart < 0) return null;
  // When both match (e.g. "run /a@b"), the trigger typed closest to the cursor wins.
  if (atStart >= slashStart) {
    return { type: "at", query: at![2] ?? "", start: atStart };
  }
  return { type: "slash", query: slash![2] ?? "", start: slashStart };
}

/**
 * Narrow an @ trigger to the selected item's leading label when the user has
 * continued typing prose after it. The menu can keep a prefix suggestion
 * visible while the query grows, but replacing the raw trigger must not erase
 * that prose. Whitespace after the label belongs to the selected trigger so
 * the replacement can add its own single separator.
 */
export function composerTriggerForSelection(
  trigger: ComposerTrigger,
  label: string,
): ComposerTrigger {
  const selectedLabel = label.trim();
  if (trigger.type !== "at" || !selectedLabel) return trigger;

  const matchedPrefix = trigger.query.slice(0, selectedLabel.length);
  if (matchedPrefix.toLowerCase() !== selectedLabel.toLowerCase()) return trigger;

  const remainder = trigger.query.slice(selectedLabel.length);
  if (remainder.length > 0 && !/^[ \t]/.test(remainder)) {
    return trigger;
  }
  const separator = remainder.match(/^[ \t]*/)?.[0] ?? "";
  return {
    ...trigger,
    query: `${matchedPrefix}${separator}`,
  };
}

/**
 * Replace exactly the trigger span (trigger character through the end of the
 * typed query) with `insertion`, leaving surrounding text untouched so
 * multiple tokens can coexist in one draft.
 */
export function replaceComposerTriggerSpan(
  text: string,
  trigger: Pick<ComposerTrigger, "start" | "query">,
  insertion: string,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(trigger.start, text.length));
  const end = Math.min(text.length, start + 1 + trigger.query.length);
  const before = text.slice(0, start);
  return {
    text: `${before}${insertion}${text.slice(end)}`,
    caret: before.length + insertion.length,
  };
}

export type ComposerTokenKind = "file" | "command" | "mention";

export type ComposerTokenRange = {
  start: number;
  end: number;
  kind: ComposerTokenKind;
};

const CONFIRMED_TOKEN_RE = /(^|\s)([@/])(\S+)/g;

/**
 * Find the confirmed chip tokens in a draft: word-boundary `@body` / `/body`
 * runs whose body the caller vouches for (attached file, known command).
 * Offsets are code units into `text`, sorted ascending. Used by the desktop
 * textarea overlay and the TUI prompt renderer to style chips.
 */
export function findConfirmedComposerTokens(
  text: string,
  confirm: {
    isFile: (body: string) => boolean;
    isCommand: (body: string) => boolean;
    /**
     * Optional: `chat:<id>` / `lane:<id>` / `term:<id>` entity pointers. Unlike
     * files these need no side table to confirm — the prefixed grammar is
     * self-identifying — so callers that render mention chips can pass a purely
     * syntactic predicate.
     */
    isMention?: (body: string) => boolean;
  },
): ComposerTokenRange[] {
  if (!text) return [];
  const tokens: ComposerTokenRange[] = [];
  for (const match of text.matchAll(CONFIRMED_TOKEN_RE)) {
    const start = (match.index ?? 0) + match[1]!.length;
    const body = match[3]!;
    const kind: ComposerTokenKind | null = match[2] === "@"
      ? (confirm.isMention?.(body) ? "mention" : confirm.isFile(body) ? "file" : null)
      : (confirm.isCommand(body) ? "command" : null);
    if (kind) tokens.push({ start, end: start + 1 + body.length, kind });
  }
  return tokens;
}

/** True when the trigger token is the only content in the draft. */
export function composerTriggerSpansWholeDraft(
  text: string,
  trigger: Pick<ComposerTrigger, "start" | "query">,
): boolean {
  return text.slice(0, trigger.start).trim() === ""
    && text.slice(trigger.start + 1 + trigger.query.length).trim() === "";
}
