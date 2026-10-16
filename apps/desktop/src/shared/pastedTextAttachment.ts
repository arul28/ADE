// ---------------------------------------------------------------------------
// Big pastes become file attachments.
// ---------------------------------------------------------------------------
//
// A 300-line stack trace pasted into the prompt buries the sentence the user
// actually wrote, and the composer turns into a scroll box. Past a threshold
// the paste is staged as a file instead and the prompt gets a
// `[File #k: name]` chip ("Pasted · 212 lines") where the text would have gone.
//
// The thresholds, the line count, the extension sniffing, the file name and
// the chip label match iOS exactly; this is the one TypeScript home for that
// rule. Pure, synchronous, no I/O.

/** A paste with MORE than this many lines becomes a file. */
export const PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE = 40;
/** A paste with MORE than this many characters becomes a file. */
export const PASTED_TEXT_FILE_MIN_CHARS_EXCLUSIVE = 3000;

/** CRLF and lone CR become LF, so every rule below sees one line ending. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function splitPastedLines(text: string): string[] {
  return normalizeLineEndings(text).split("\n");
}

/**
 * Line count as a person reads it: line endings normalized to LF, ONE trailing
 * newline dropped (it ends the last line, it does not open a new one), then
 * split on LF. Empty text is 0 lines.
 */
export function pastedTextLineCount(text: string): number {
  if (!text) return 0;
  const normalized = normalizeLineEndings(text);
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return body.split("\n").length;
}

/** Big means MORE than 40 lines or MORE than 3000 UTF-16 code units. */
export function shouldPasteTextAsFile(text: string): boolean {
  return text.length > PASTED_TEXT_FILE_MIN_CHARS_EXCLUSIVE
    || pastedTextLineCount(text) > PASTED_TEXT_FILE_MIN_LINES_EXCLUSIVE;
}

export type PastedTextExtension = ".txt" | ".diff" | ".json" | ".log";

const LOG_LINE_RE =
  /^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b)/i;

/**
 * Only an unambiguous match changes the extension; everything else is `.txt`.
 * The extension decides how the agent and the preview read the file, so a
 * false `.json` is worse than an honest `.txt`. Checked in order:
 *
 *  - `.diff` — any line starts with `diff --git `, or lines starting with
 *    `--- `, `+++ ` and `@@` are all present.
 *  - `.json` — the trimmed text starts with `{` or `[` and parses as an object
 *    or array.
 *  - `.log` — at least 3 non-empty lines, and at least 60% of them start with a
 *    timestamp or a log level.
 */
export function sniffPastedTextExtension(text: string): PastedTextExtension {
  const lines = splitPastedLines(text);
  if (
    lines.some((line) => line.startsWith("diff --git "))
    || (
      lines.some((line) => line.startsWith("--- "))
      && lines.some((line) => line.startsWith("+++ "))
      && lines.some((line) => line.startsWith("@@"))
    )
  ) {
    return ".diff";
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") return ".json";
    } catch {
      // Not JSON; fall through.
    }
  }
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length >= 3) {
    const logLines = nonEmpty.filter((line) => LOG_LINE_RE.test(line)).length;
    if (logLines / nonEmpty.length >= 0.6) return ".log";
  }
  return ".txt";
}

/** `pasted-<epoch ms>.<ext>`, e.g. `pasted-1792109142144.log`. */
export function pastedTextFilename(text: string, nowMs: number = Date.now()): string {
  return `pasted-${nowMs}${sniffPastedTextExtension(text)}`;
}

/** Chip label for a pasted-text file: `Pasted · 212 lines`. */
export function pastedTextChipLabel(lineCount: number): string {
  return `Pasted · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}
