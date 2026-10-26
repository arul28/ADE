import { stripAnsiWithOptions } from "../../utils/ansiStrip";
import type { TerminalWatchMatcher } from "../../../shared/terminalWatch";

/**
 * Turning raw PTY output into what a terminal watch tells an agent.
 *
 * A terminal stream is mostly paint: colors, cursor moves, a spinner redrawn
 * with `\r` forty times a second, a progress bar. None of that is news. This
 * reduces a burst to the lines a person would read, so a watch wakes only on
 * real output and the excerpt it sends is short and legible.
 */

/** Lines with no letter or digit at all (spinners, bars, rules) are paint. */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
/** C0 controls other than tab, plus DEL and stray escape remnants. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Braille and circle spinner frames at the start of a line (not `-`/`|`: those start real lines). */
const LEADING_SPINNER = /^[\u2800-\u28ff◐◓◑◒]+\s+/u;
/** One line longer than this is cut; a minified bundle is not news. */
const LINE_MAX_CHARS = 600;

/**
 * Clean a burst of raw output into display lines.
 *
 * - ANSI/OSC/DCS sequences are stripped.
 * - A `\r` inside a line is a redraw: only the text after the last one stays,
 *   which is what the screen shows.
 * - Lines with no word characters, or that are mostly replacement characters
 *   (binary or a split multibyte sequence), are dropped.
 * - A run of identical lines collapses into one line with a repeat count.
 */
export function cleanTerminalOutput(raw: string): string[] {
  if (!raw) return [];
  const stripped = stripAnsiWithOptions(raw, { preserveCarriageReturns: true });
  const out: string[] = [];
  let previous: string | null = null;
  let repeats = 0;
  const pushRepeatNote = () => {
    if (repeats > 0 && out.length > 0) out[out.length - 1] = `${out[out.length - 1]}  (×${repeats + 1})`;
    repeats = 0;
  };
  for (const physical of stripped.split("\n")) {
    const withoutTrailingCr = physical.replace(/\r+$/, "");
    const lastCr = withoutTrailingCr.lastIndexOf("\r");
    const visible = (lastCr >= 0 ? withoutTrailingCr.slice(lastCr + 1) : withoutTrailingCr)
      .replace(CONTROL_CHARS, "")
      // A spinner glyph in front of its label ("⠙ building") is paint too.
      .replace(LEADING_SPINNER, "")
      .replace(/\s+$/, "");
    if (!visible || !HAS_WORD_CHAR.test(visible)) continue;
    const replacementCount = visible.length - visible.replace(/�/g, "").length;
    if (replacementCount > 0 && replacementCount / visible.length > 0.3) continue;
    const line = visible.length > LINE_MAX_CHARS ? `${visible.slice(0, LINE_MAX_CHARS)}…` : visible;
    if (line === previous) {
      repeats += 1;
      continue;
    }
    pushRepeatNote();
    out.push(line);
    previous = line;
  }
  pushRepeatNote();
  return out;
}

/** Lines of context kept around each matching line. */
const MATCH_CONTEXT_LINES = 2;

export type TerminalWatchExcerpt = {
  /** The text the agent reads; never more than `maxBytes` UTF-8 bytes. */
  text: string;
  /** Cleaned lines that were left out to fit. */
  omittedLines: number;
  matchedLines: number;
};

/**
 * The excerpt a wake carries: the newest lines that fit in `maxBytes`. With a
 * matcher, only matching lines and a little context around each; null when
 * nothing matched.
 */
export function buildTerminalWatchExcerpt(
  lines: readonly string[],
  matcher: TerminalWatchMatcher | null,
  maxBytes: number,
): TerminalWatchExcerpt | null {
  if (lines.length === 0) return null;
  let selected: string[];
  let matchedLines = 0;
  if (matcher) {
    const keep = new Uint8Array(lines.length);
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher.test(lines[index] ?? "")) continue;
      matchedLines += 1;
      const from = Math.max(0, index - MATCH_CONTEXT_LINES);
      const to = Math.min(lines.length - 1, index + MATCH_CONTEXT_LINES);
      for (let k = from; k <= to; k += 1) keep[k] = 1;
    }
    if (matchedLines === 0) return null;
    selected = [];
    let gap = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (keep[index]) {
        if (gap && selected.length > 0) selected.push("…");
        selected.push(lines[index] ?? "");
        gap = false;
      } else {
        gap = true;
      }
    }
  } else {
    selected = [...lines];
  }
  // Newest lines win: walk back from the end until the budget is spent.
  const kept: string[] = [];
  let bytes = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const line = selected[index] ?? "";
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + cost > maxBytes) {
      if (kept.length === 0) {
        // One line bigger than the whole budget: keep its tail.
        kept.unshift(sliceUtf8Tail(line, maxBytes - 1));
      }
      break;
    }
    kept.unshift(line);
    bytes += cost;
  }
  const omittedLines = selected.filter((line) => line !== "…").length - kept.filter((line) => line !== "…").length;
  return { text: kept.join("\n"), omittedLines: Math.max(0, omittedLines), matchedLines };
}

/** The `…` marker is 3 bytes in UTF-8. */
const ELLIPSIS_BYTES = 3;

/** The tail of `text` in at most `maxBytes` UTF-8 bytes, the `…` marker included. */
function sliceUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const room = maxBytes - ELLIPSIS_BYTES;
  if (room <= 0) return "";
  // Drop a split leading multibyte sequence rather than show a replacement char.
  return `…${buffer.subarray(buffer.length - room).toString("utf8").replace(/^\uFFFD+/, "")}`;
}
