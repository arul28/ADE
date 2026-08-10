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

export type ComposerSelectionKind = "file" | "mention";

// Both triggers must sit at a word boundary (start of text or after
// whitespace) and their token must run to the cursor. The slash token is a
// command name only: no whitespace and no `/` inside, so paths like
// `/usr/bin` and fractions like `3/4` never trigger. The `@` token allows `/`
// (file paths) and spaces (chat names are commonly multi-word), but not
// another `@` or a newline, so emails and cross-line prose never trigger.
const AT_TRIGGER_RE = /(?:^|[ \t\r\n])(@([^@\r\n]*))$/;
const SLASH_TRIGGER_RE = /(?:^|\s)(\/([^\s/]*))$/;
// A path with a recognizable extension can be separated from prose without
// making the same assumption for ordinary multiword chat titles. Extensionless
// paths are kept intact; the file index resolves a leading path prefix when
// prose follows it, which also preserves spaces in directory/file names.
const FILE_QUERY_RE = /^(.+?\.[A-Za-z0-9_-]+)(?:[ \t]+.*)?$/;

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
 * Remove trailing prose from an @ file query when a filename extension gives
 * us an unambiguous boundary. Leave extensionless paths and chat-name queries
 * intact; file quick-open handles a path prefix followed by prose.
 */
export function composerFileSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  return FILE_QUERY_RE.exec(trimmed)?.[1] ?? trimmed;
}

function composerPathBasename(pathValue: string): string {
  const separator = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  return separator >= 0 ? pathValue.slice(separator + 1) : pathValue;
}

function composerPathPrefixForSelection(
  query: string,
  selectedLabel: string,
  allowRootLevelFile: boolean,
): string {
  if (!allowRootLevelFile) return "";
  const pathComponents = selectedLabel.split(/[\\/]/).filter(Boolean);
  const words = query.trim().split(/[ \t]+/).filter(Boolean);
  for (let wordCount = words.length - 1; wordCount > 0; wordCount -= 1) {
    const prefix = words.slice(0, wordCount).join(" ");
    const normalizedPrefix = prefix.toLowerCase();
    const matchesPath = /[\\/]/.test(prefix)
      ? selectedLabel.toLowerCase().includes(normalizedPrefix)
      : pathComponents.some((component) => component.toLowerCase().includes(normalizedPrefix));
    if (matchesPath) return prefix;
  }
  return "";
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
  selectionKind: ComposerSelectionKind = "mention",
): ComposerTrigger {
  const selectedLabel = label.trim();
  if (trigger.type !== "at" || !selectedLabel) return trigger;

  const candidateLabels = [selectedLabel];
  const addCandidateLabel = (candidate: string) => {
    if (!candidate || candidateLabels.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) return;
    candidateLabels.push(candidate);
  };
  // File suggestions can be selected from a basename or a shorter path
  // suffix even though the row inserts the full path. Treat those as the
  // selected prefix so prose after the shorthand remains outside the splice.
  addCandidateLabel(composerPathBasename(selectedLabel));
  const searchableQuery = composerFileSearchQuery(trigger.query);
  if (searchableQuery !== trigger.query && selectedLabel.toLowerCase().endsWith(searchableQuery.toLowerCase())) {
    addCandidateLabel(searchableQuery);
  }
  // Extensionless path searches accept the longest space-delimited prefix that
  // exists in the index, so the selected canonical path may continue beyond
  // what the user typed before adding prose (for example, `src/my review`
  // selecting `src/my folder`, or `my review` selecting `src/my/file`). Match
  // against the full path for path-like prefixes and each component for
  // basename/intermediate-component prefixes, without applying this heuristic
  // to ordinary chat titles.
  addCandidateLabel(composerPathPrefixForSelection(
    trigger.query,
    selectedLabel,
    selectionKind === "file",
  ));

  for (const candidateLabel of candidateLabels) {
    const matchedPrefix = trigger.query.slice(0, candidateLabel.length);
    if (matchedPrefix.toLowerCase() !== candidateLabel.toLowerCase()) continue;

    const remainder = trigger.query.slice(candidateLabel.length);
    if (remainder.length > 0 && !/^[ \t]/.test(remainder)) continue;
    const separator = remainder.match(/^[ \t]*/)?.[0] ?? "";
    return {
      ...trigger,
      query: `${matchedPrefix}${separator}`,
    };
  }
  return trigger;
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

const CONFIRMED_TRIGGER_RE = /(^|\s)([@/])/g;

function plainComposerTokenEnd(text: string, start: number, limit: number): number | null {
  let end = start;
  while (end < limit && !/\s/.test(text[end]!)) end += 1;
  return end > start ? end : null;
}

function confirmedFileTokenEnd(
  text: string,
  start: number,
  limit: number,
  isFile: (body: string) => boolean,
): number | null {
  let end = start;
  let bestEnd: number | null = null;
  while (end < limit) {
    const character = text[end]!;
    if (character === "\r" || character === "\n") break;
    if (character === " " || character === "\t") {
      if (isFile(text.slice(start, end))) bestEnd = end;
      end += 1;
      continue;
    }
    end += 1;
  }
  if (end === limit && end > start && isFile(text.slice(start, end))) bestEnd = end;
  return bestEnd;
}

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
  for (const match of text.matchAll(CONFIRMED_TRIGGER_RE)) {
    const start = (match.index ?? 0) + match[1]!.length;
    const bodyStart = start + 1;
    const plainEnd = plainComposerTokenEnd(text, bodyStart, text.length);
    const plainBody = plainEnd == null ? "" : text.slice(bodyStart, plainEnd);
    if (match[2] === "@") {
      if (plainBody && confirm.isMention?.(plainBody)) {
        tokens.push({ start, end: plainEnd!, kind: "mention" });
        continue;
      }
      const fileEnd = confirmedFileTokenEnd(text, bodyStart, text.length, confirm.isFile);
      if (fileEnd != null) tokens.push({ start, end: fileEnd, kind: "file" });
    } else if (plainBody && confirm.isCommand(plainBody)) {
      tokens.push({ start, end: plainEnd!, kind: "command" });
    }
  }
  return tokens;
}

/**
 * True when an @ trigger begins with an already-confirmed file or mention
 * token and the user has typed a separator after it. Confirmed tokens are
 * complete attachments/pointers, not new searches, so the menu must stay
 * closed while the user continues ordinary prose after them.
 */
export function composerTriggerHasConfirmedPrefix(
  text: string,
  trigger: Pick<ComposerTrigger, "type" | "start" | "query">,
  confirm: {
    isFile: (body: string) => boolean;
    isMention?: (body: string) => boolean;
  },
): boolean {
  if (trigger.type !== "at") return false;
  const end = Math.min(text.length, trigger.start + 1 + trigger.query.length);
  const bodyStart = trigger.start + 1;
  const plainEnd = plainComposerTokenEnd(text, bodyStart, end);
  if (plainEnd != null && plainEnd < end) {
    const body = text.slice(bodyStart, plainEnd);
    if (confirm.isFile(body) || confirm.isMention?.(body) === true) return true;
  }
  const fileEnd = confirmedFileTokenEnd(text, bodyStart, end, confirm.isFile);
  return fileEnd != null && fileEnd < end && /[ \t]/.test(text[fileEnd]!);
}

/** True when the trigger token is the only content in the draft. */
export function composerTriggerSpansWholeDraft(
  text: string,
  trigger: Pick<ComposerTrigger, "start" | "query">,
): boolean {
  return text.slice(0, trigger.start).trim() === ""
    && text.slice(trigger.start + 1 + trigger.query.length).trim() === "";
}
