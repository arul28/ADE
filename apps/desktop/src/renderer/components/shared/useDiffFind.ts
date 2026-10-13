/**
 * Find in a diff (⌘F) for AdeDiffViewer's Pierre views.
 *
 * Pierre draws every line of a file's diff into an open shadow root (ADE does
 * not use its virtualized CodeView), so the lines are on the page, but the
 * browser's find does not see into shadow roots, and the desktop app binds ⌘F
 * to its menu. This searches each drawn line's text, paints matches with the
 * CSS Custom Highlight API and scrolls the current one into view. The bar's
 * lifecycle (⌘F claim, focus, ⌘G, Escape) is useFindSession's.
 *
 * Unchanged stretches longer than the viewer's threshold are collapsed and not
 * drawn. When the file's full text holds a match, the viewer is asked to draw
 * everything (`expandAll`) until the bar closes.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { captureFindOpened } from "../../lib/findAnalytics";
import { findScopeOwnsTarget } from "../../lib/findScope";
import {
  countOccurrences,
  findCountLabel,
  findTextRanges,
  foldFindCase,
  publishFindHighlights,
  scrollRangeIntoView,
  stepFindIndex,
} from "../../lib/findText";
import { useFindSession } from "./useFindSession";

/** Pierre's element that wraps one file's diff; its lines live in its open shadow root. */
const DIFFS_TAG_NAME = "diffs-container";

/** The old and new text of one file. */
type FileText = { old: string; new: string };

/** The last full text folded, kept for as long as its source strings are unchanged. */
type FoldedFileTextCache = { source: FileText; folded: FileText };

function shadowRootsUnder(root: Element): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  for (const host of root.querySelectorAll(DIFFS_TAG_NAME)) {
    if (host.shadowRoot) roots.push(host.shadowRoot);
  }
  return roots;
}

/** Which file a drawn line belongs to: the old side, the new side, or both (unchanged context). */
function lineSides(line: Element): { old: boolean; new: boolean } {
  if (line.closest("[data-deletions]")) return { old: true, new: false };
  if (line.closest("[data-additions]")) return { old: false, new: true };
  const type = line.getAttribute("data-line-type") ?? "";
  if (type.includes("deletion")) return { old: true, new: false };
  if (type.includes("addition")) return { old: false, new: true };
  return { old: true, new: true };
}

/**
 * Every match in drawn order (top to bottom, then the old side before the
 * new), and how many were drawn from each file, so a file holding more
 * matches than were drawn has some in collapsed lines.
 */
function collectRanges(root: Element, needle: string): { ranges: Range[]; oldDrawn: number; newDrawn: number } {
  const lines: { ranges: Range[]; top: number; left: number }[] = [];
  let oldDrawn = 0;
  let newDrawn = 0;
  for (const shadow of shadowRootsUnder(root)) {
    for (const line of shadow.querySelectorAll<HTMLElement>("[data-line]")) {
      const ranges = findTextRanges(line, needle);
      if (!ranges.length) continue;
      const sides = lineSides(line);
      if (sides.old) oldDrawn += ranges.length;
      if (sides.new) newDrawn += ranges.length;
      const rect = line.getBoundingClientRect();
      lines.push({ ranges, top: rect.top, left: rect.left });
    }
  }
  // The sort is stable, so the matches of one line keep their order.
  lines.sort((a, b) => a.top - b.top || a.left - b.left);
  return { ranges: lines.flatMap((line) => line.ranges), oldDrawn, newDrawn };
}

function hasCollapsedContext(root: Element): boolean {
  return shadowRootsUnder(root).some((shadow) => shadow.querySelector("[data-expand-button], [data-unmodified-lines]") != null);
}

/** Folds a file's full text once per distinct source string, not per recompute. */
function foldedFileText(source: FileText | null, cacheRef: MutableRefObject<FoldedFileTextCache | null>): FileText | null {
  if (!source) return null;
  const cached = cacheRef.current;
  if (cached && cached.source.old === source.old && cached.source.new === source.new) return cached.folded;
  const folded = { old: foldFindCase(source.old), new: foldFindCase(source.new) };
  cacheRef.current = { source, folded };
  return folded;
}

export function useDiffFind({
  rootRef,
  scrollRef,
  fullText,
}: {
  /** The viewer's root; marked as a find scope by the caller. */
  rootRef: MutableRefObject<HTMLElement | null>;
  /** The element that scrolls the diff vertically. */
  scrollRef: MutableRefObject<HTMLElement | null>;
  /** Old and new file text when the viewer has them (not for a bare patch). */
  fullText: FileText | null;
}) {
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const activeRef = useRef(activeIndex);
  activeRef.current = activeIndex;
  const expandAllRef = useRef(expandAll);
  expandAllRef.current = expandAll;
  const rangesRef = useRef<Range[]>([]);
  const fullTextRef = useRef(fullText);
  fullTextRef.current = fullText;
  const foldedFullTextRef = useRef<FoldedFileTextCache | null>(null);
  /** The diff is redrawing with every line: reveal the current match once it lands. */
  const revealAfterExpandRef = useRef(false);

  const ownsFind = useCallback(() => findScopeOwnsTarget(rootRef.current), [rootRef]);

  // The session owns ⌘F, the bar, Escape, focus and the paint frame. These
  // callbacks need the surface id it returns, so it reaches them through refs.
  const handlers = useRef({
    step: (_direction: 1 | -1) => {},
    clearMatches: () => {},
    recompute: () => {},
    reveal: (_range: Range) => {},
  });
  const session = useFindSession({
    ownsFind,
    onStep: (direction) => handlers.current.step(direction),
    onClosed: () => handlers.current.clearMatches(),
    paint: () => handlers.current.recompute(),
    escapeRootRef: rootRef,
    openedByShortcut: () => captureFindOpened("diff_shortcut"),
  });
  const { open, openRef, inputRef, surfaceId, closeBar, schedulePaint: scheduleRecompute } = session;

  /** Reveal a match below the floating bar, which covers the diff's top while scrolled. */
  handlers.current.reveal = (range: Range) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const bar = inputRef.current?.closest("form")?.getBoundingClientRect();
    const top = bar ? Math.max(0, bar.bottom - scroller.getBoundingClientRect().top) : 0;
    scrollRangeIntoView(scroller, range, { covered: { top, bottom: 0 } });
  };

  const recompute = useCallback(() => {
    const root = rootRef.current;
    if (!openRef.current || !root || !queryRef.current.trim()) {
      rangesRef.current = [];
      activeRef.current = null;
      setTotal(0);
      setActiveIndex(null);
      publishFindHighlights(surfaceId, null);
      return;
    }
    const needle = foldFindCase(queryRef.current);
    const { ranges, oldDrawn, newDrawn } = collectRanges(root, needle);
    rangesRef.current = ranges;
    // A match in collapsed unchanged lines: draw the whole file while open.
    if (!expandAllRef.current && hasCollapsedContext(root)) {
      const full = foldedFileText(fullTextRef.current, foldedFullTextRef);
      if (full && (countOccurrences(full.old, needle) > oldDrawn || countOccurrences(full.new, needle) > newDrawn)) {
        expandAllRef.current = true;
        revealAfterExpandRef.current = true;
        setExpandAll(true);
      }
    }
    setTotal(ranges.length);
    // No active match (a new query, or a fresh open) starts at the first match
    // at or below the top of the view; otherwise the current match is kept.
    let next = activeRef.current;
    let revealActive = false;
    // The redraw with every line lands after the expand request: the match the
    // first pass revealed has moved, so reveal it again once all lines are drawn.
    if (revealAfterExpandRef.current && !hasCollapsedContext(root)) {
      revealAfterExpandRef.current = false;
      revealActive = true;
    }
    if (next == null) {
      const viewTop = scrollRef.current?.getBoundingClientRect().top ?? 0;
      const firstBelow = ranges.findIndex((range) => range.getBoundingClientRect().bottom > viewTop);
      next = ranges.length ? Math.max(0, firstBelow) : null;
      revealActive = next != null;
    } else if (next >= ranges.length) {
      next = ranges.length ? ranges.length - 1 : null;
    }
    activeRef.current = next;
    setActiveIndex(next);
    const active = next != null ? ranges[next] ?? null : null;
    publishFindHighlights(surfaceId, { all: ranges, active });
    if (active && revealActive) handlers.current.reveal(active);
  }, [openRef, rootRef, scrollRef, surfaceId]);
  handlers.current.recompute = recompute;

  const step = useCallback((direction: 1 | -1) => {
    const ranges = rangesRef.current;
    const next = stepFindIndex(ranges.length, activeRef.current, direction);
    if (next == null) return;
    const active = ranges[next];
    if (!active) return;
    activeRef.current = next;
    setActiveIndex(next);
    publishFindHighlights(surfaceId, { all: ranges, active });
    handlers.current.reveal(active);
  }, [surfaceId]);
  handlers.current.step = step;

  const clearMatches = useCallback(() => {
    expandAllRef.current = false;
    revealAfterExpandRef.current = false;
    setExpandAll(false);
    activeRef.current = null;
    setActiveIndex(null);
    rangesRef.current = [];
  }, []);
  handlers.current.clearMatches = clearMatches;

  const changeQuery = useCallback((next: string) => {
    queryRef.current = next;
    setQuery(next);
    // A new query starts again at the first match at or below the view.
    activeRef.current = null;
    setActiveIndex(null);
  }, []);

  // Pierre redraws lines after highlighting, on option changes and when
  // context expands: recompute on any change in its shadow roots while open.
  useEffect(() => {
    if (!open) return;
    // The diff body only: the bar's own status text must not re-trigger this.
    const root = scrollRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(scheduleRecompute);
    const observed = new Set<ShadowRoot>();
    const watchShadows = () => {
      for (const shadow of shadowRootsUnder(root)) {
        if (observed.has(shadow)) continue;
        observed.add(shadow);
        observer.observe(shadow, { childList: true, subtree: true, characterData: true });
      }
    };
    watchShadows();
    const hostObserver = new MutationObserver(() => {
      watchShadows();
      scheduleRecompute();
    });
    hostObserver.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      hostObserver.disconnect();
    };
  }, [open, scheduleRecompute, scrollRef]);

  useLayoutEffect(() => {
    if (open) scheduleRecompute();
  }, [open, query, scheduleRecompute]);

  return {
    open,
    expandAll,
    bar: {
      inputRef,
      query,
      onQueryChange: changeQuery,
      onStep: step,
      onClose: closeBar,
      status: findCountLabel({ query, total, activeIndex }),
      canStep: total > 0,
    },
  };
}
