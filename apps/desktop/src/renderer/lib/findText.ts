/**
 * Matching and painting shared by every ⌘F surface (chat transcript, diffs).
 *
 * Matching is plain, case-insensitive substring search, the way a browser's
 * find works: "transcri" finds "transcript", and "run" does not find
 * "running"'s stem. Painting uses the CSS Custom Highlight API, so the page's
 * DOM is never changed and React re-renders or virtualized rows cannot tear a
 * `<mark>` apart.
 */

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

/** Start offsets of every non-overlapping occurrence of `foldedNeedle`. */
export function findOccurrenceOffsets(foldedText: string, foldedNeedle: string): number[] {
  const offsets: number[] = [];
  if (!foldedNeedle || foldedText.length < foldedNeedle.length) return offsets;
  let cursor = 0;
  for (;;) {
    const at = foldedText.indexOf(foldedNeedle, cursor);
    if (at < 0) break;
    offsets.push(at);
    cursor = at + foldedNeedle.length;
  }
  return offsets;
}

export function countOccurrences(foldedText: string, foldedNeedle: string): number {
  if (!foldedNeedle || foldedText.length < foldedNeedle.length) return 0;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const at = foldedText.indexOf(foldedNeedle, cursor);
    if (at < 0) return count;
    count += 1;
    cursor = at + foldedNeedle.length;
  }
}

/** Elements whose text is chrome, not content: never searched. */
const SKIPPED_TAGS = new Set(["BUTTON", "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "SVG", "IFRAME", "NOSCRIPT"]);

/** Block-level tags: a match never runs from one into the next. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION",
  "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
]);

export const FIND_SKIP_ATTRIBUTE = "data-ade-find-skip";

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
    if (node.hasAttribute(FIND_SKIP_ATTRIBUTE) || node.getAttribute("aria-hidden") === "true") return;
    const block = BLOCK_TAGS.has(tag);
    if (block) breakLine();
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    if (block) breakLine();
  };
  visit(root);
  return { text, runs };
}

function locate(runs: TextRun[], offset: number, preferEnd: boolean): { node: Text; offset: number } | null {
  // Binary search for the run holding `offset`.
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const run = runs[mid]!;
    const end = run.start + run.node.data.length;
    if (offset < run.start || (preferEnd ? offset > end : offset >= end)) {
      if (offset < run.start) high = mid - 1;
      else low = mid + 1;
      continue;
    }
    return { node: run.node, offset: offset - run.start };
  }
  return null;
}

/** One Range per occurrence of `foldedNeedle` in the visible text under `root`. */
export function findTextRanges(root: Element, foldedNeedle: string): Range[] {
  if (!foldedNeedle) return [];
  const { text, runs } = collectText(root);
  const ranges: Range[] = [];
  for (const at of findOccurrenceOffsets(foldFindCase(text), foldedNeedle)) {
    const start = locate(runs, at, false);
    const end = locate(runs, at + foldedNeedle.length, true);
    if (!start || !end) continue;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      continue;
    }
    ranges.push(range);
  }
  return ranges;
}

type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const HighlightCtor = (globalThis as { Highlight?: unknown }).Highlight;
  return css?.highlights && typeof HighlightCtor === "function" ? css.highlights : null;
}

export const FIND_HIGHLIGHT = "ade-find";
export const FIND_HIGHLIGHT_ACTIVE = "ade-find-active";

/*
 * `CSS.highlights` is one registry for the whole document, and two chats (or
 * a chat and a diff) can have find open at once. Each surface files its
 * ranges under its own id; the two named highlights are rebuilt from all.
 */
const rangesBySurface = new Map<string, { all: Range[]; active: Range | null }>();

export function publishFindHighlights(surfaceId: string, next: { all: Range[]; active: Range | null } | null): void {
  if (next && (next.all.length || next.active)) rangesBySurface.set(surfaceId, next);
  else if (!rangesBySurface.delete(surfaceId)) return;
  const registry = highlightRegistry();
  if (!registry) return;
  const HighlightCtor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  const all: Range[] = [];
  const active: Range[] = [];
  for (const entry of rangesBySurface.values()) {
    for (const range of entry.all) if (range !== entry.active) all.push(range);
    if (entry.active) active.push(entry.active);
  }
  if (all.length) registry.set(FIND_HIGHLIGHT, new HighlightCtor(...all));
  else registry.delete(FIND_HIGHLIGHT);
  if (active.length) registry.set(FIND_HIGHLIGHT_ACTIVE, new HighlightCtor(...active));
  else registry.delete(FIND_HIGHLIGHT_ACTIVE);
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
