/**
 * Matching, painting and scrolling shared by every ⌘F surface (chat
 * transcript, diffs).
 *
 * Matching is plain, case-insensitive substring search, the way a browser's
 * find works: "transcri" finds "transcript". Painting uses the CSS Custom
 * Highlight API, so the page's DOM is never changed and React re-renders or
 * virtualized rows cannot tear a `<mark>` apart.
 */
import { createHighlightGroup } from "./highlightRegistry";
import { FIND_INCLUDE_ATTRIBUTE, FIND_SKIP_ATTRIBUTE } from "./findScope";
import { cssZoomOf } from "./webZoom";

/**
 * Lower-cases for comparison without changing the string's length, so an
 * offset in the folded text is an offset in the original. Characters whose
 * lower case has a different length (`İ`) keep their own form; final sigma
 * folds to sigma so "ΟΔΟΣ" finds "οδος".
 */
export function foldFindCase(text: string): string {
  const lowered = text.toLowerCase().replace(/ς/g, "σ");
  if (lowered.length === text.length) return lowered;
  let folded = "";
  for (const character of text) {
    const lower = character.toLowerCase().replace(/ς/g, "σ");
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

/** Visit each non-overlapping occurrence of `foldedNeedle`; returns the count. */
function scanOccurrences(foldedText: string, foldedNeedle: string, visit?: (offset: number) => void): number {
  if (!foldedNeedle || foldedText.length < foldedNeedle.length) return 0;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const at = foldedText.indexOf(foldedNeedle, cursor);
    if (at < 0) return count;
    visit?.(at);
    count += 1;
    cursor = at + foldedNeedle.length;
  }
}

export function countOccurrences(foldedText: string, foldedNeedle: string): number {
  return scanOccurrences(foldedText, foldedNeedle);
}

/** Step `delta` matches from `index`, wrapping at both ends; null when there are none. */
export function stepFindIndex(total: number, index: number | null, delta: 1 | -1): number | null {
  if (total <= 0) return null;
  if (index == null) return delta > 0 ? 0 : total - 1;
  return (((index + delta) % total) + total) % total;
}

/** Elements whose text is never content. A button is chrome unless marked `FIND_INCLUDE_ATTRIBUTE`. */
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "SVG", "IFRAME", "NOSCRIPT"]);

/** Block-level tags: a match never runs from one into the next. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION",
  "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
]);

type TextRun = { node: Text; start: number };

/**
 * The visible text under `root`, with block boundaries as "\n" and the text
 * node behind every character, so a match offset maps back to a Range.
 */
function collectText(root: Element): { text: string; runs: TextRun[] } {
  const runs: TextRun[] = [];
  let text = "";
  const breakLine = () => {
    if (text.length && !text.endsWith("\n")) text += "\n";
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node as Text).data;
      if (!value) return;
      runs.push({ node: node as Text, start: text.length });
      text += value;
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) return;
    if (tag === "BUTTON" && !node.hasAttribute(FIND_INCLUDE_ATTRIBUTE)) return;
    if (node.hasAttribute(FIND_SKIP_ATTRIBUTE) || node.getAttribute("aria-hidden") === "true") return;
    const block = BLOCK_TAGS.has(tag);
    if (block) breakLine();
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    if (block) breakLine();
  };
  visit(root);
  return { text, runs };
}

/** The text node holding `offset`; at a node boundary, `preferEnd` picks the earlier node's end. */
function locate(runs: TextRun[], offset: number, preferEnd: boolean): { node: Text; offset: number } | null {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const run = runs[mid]!;
    const end = run.start + run.node.data.length;
    if (offset < run.start) {
      high = mid - 1;
    } else if (preferEnd ? offset > end : offset >= end) {
      low = mid + 1;
    } else {
      return { node: run.node, offset: offset - run.start };
    }
  }
  return null;
}

/** One Range per occurrence of `foldedNeedle` in the visible text under `root`. */
export function findTextRanges(root: Element, foldedNeedle: string): Range[] {
  if (!foldedNeedle) return [];
  const { text, runs } = collectText(root);
  const ranges: Range[] = [];
  scanOccurrences(foldFindCase(text), foldedNeedle, (at) => {
    const start = locate(runs, at, false);
    const end = locate(runs, at + foldedNeedle.length, true);
    if (!start || !end) return;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      return;
    }
    ranges.push(range);
  });
  return ranges;
}

/** Every match amber, the current one gold (index.css; diffs repeat it in their shadow CSS). */
const findHighlights = createHighlightGroup(["ade-find", "ade-find-active"] as const);

/** Paint one surface's matches; null clears them. */
export function publishFindHighlights(surfaceId: string, next: { all: readonly Range[]; active: Range | null } | null): void {
  findHighlights.publish(
    surfaceId,
    next && (next.all.length || next.active)
      ? { "ade-find": next.all.filter((range) => range !== next.active), "ade-find-active": next.active ? [next.active] : [] }
      : null,
  );
}

/** "3 of 17", "No results", or nothing for an empty query. */
export function findCountLabel(input: {
  query: string;
  total: number;
  activeIndex: number | null;
  /** More text may still arrive (older chat history still loading). */
  partial?: boolean;
}): string {
  if (!input.query.trim()) return "";
  const totalText = `${input.total}${input.partial ? "+" : ""}`;
  if (input.total === 0) return input.partial ? "Searching…" : "No results";
  if (input.activeIndex == null) return `${totalText} ${input.total === 1 && !input.partial ? "match" : "matches"}`;
  return `${input.activeIndex + 1} of ${totalText}`;
}

/** Where a revealed match sits: this fraction of the scroller's height from its top. */
const REVEAL_ANCHOR = 0.35;
/** A match closer than this to the scroller's top or bottom edge is re-centred. */
const REVEAL_EDGE_MARGIN_PX = 48;
/** In a small scroller the edge margin shrinks to this fraction of its size. */
const REVEAL_EDGE_MARGIN_MAX_FRACTION = 1 / 4;
/** A long line scrolled sideways puts its match this far across the column. */
const REVEAL_SIDEWAYS_ANCHOR = 1 / 3;

/**
 * Scroll `range` into the reading band of `scroller`, vertically and (for a
 * long code line) sideways; no scroll when it is already comfortably visible.
 * `covered` is chrome floating over the scroller's edges (a find bar at the
 * top, a chat composer at the bottom), in viewport pixels; the band excludes
 * it. Rect deltas are divided by the CSS zoom the hosted web client applies to
 * `body`, because `scrollTop` is in layout pixels.
 */
export function scrollRangeIntoView(
  scroller: HTMLElement,
  range: Range,
  options: { scrollTo?: (top: number) => void; covered?: { top: number; bottom: number } } = {},
): void {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const zoom = cssZoomOf(scroller) || 1;
  const scrollerBox = scroller.getBoundingClientRect();
  const top = scrollerBox.top + (options.covered?.top ?? 0);
  const bottom = Math.max(top + 1, scrollerBox.bottom - (options.covered?.bottom ?? 0));
  const height = bottom - top;
  const margin = Math.min(REVEAL_EDGE_MARGIN_PX, height * REVEAL_EDGE_MARGIN_MAX_FRACTION);
  if (rect.top < top + margin || rect.bottom > bottom - margin) {
    const target = scroller.scrollTop + (rect.top - top - height * REVEAL_ANCHOR) / zoom;
    if (options.scrollTo) options.scrollTo(target);
    else scroller.scrollTop = target;
  }
  // Long lines scroll sideways inside their own column.
  const host = range.startContainer.parentElement;
  let column: HTMLElement | null = host;
  while (column && column !== scroller && column.scrollWidth <= column.clientWidth) column = column.parentElement;
  if (!column || column === scroller) return;
  const after = range.getBoundingClientRect();
  const columnBox = column.getBoundingClientRect();
  const sideMargin = Math.min(REVEAL_EDGE_MARGIN_PX, columnBox.width * REVEAL_EDGE_MARGIN_MAX_FRACTION);
  if (after.left < columnBox.left + sideMargin || after.right > columnBox.right - sideMargin) {
    column.scrollLeft += (after.left - columnBox.left - columnBox.width * REVEAL_SIDEWAYS_ANCHOR) / zoom;
  }
}

/** How long an opening bar keeps trying to take focus while its surface settles. */
const FOCUS_RETRY_MS = 1_500;

/**
 * Put the caret in a find field that is opening. The field may mount while its
 * surface is still settling (a chat that a palette result is switching to is
 * parked until the switch lands), so keep trying for a moment. It takes focus
 * from anywhere (⌘F was pressed in the composer) and stops trying once the
 * field has it, so a later click elsewhere is not overridden.
 */
export function focusFindInput(inputRef: { current: HTMLInputElement | null }): void {
  const start = performance.now();
  let focusedOnce = false;
  const attempt = () => {
    const input = inputRef.current;
    const active = document.activeElement;
    if (input && active === input) {
      focusedOnce = true;
      return;
    }
    const free = !active || active === document.body || active === document.documentElement;
    if (input?.isConnected && (free || !focusedOnce) && !input.closest("[inert]")) {
      input.focus();
      input.select();
      if (document.activeElement === input) focusedOnce = true;
    }
    if (performance.now() - start < FOCUS_RETRY_MS) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
