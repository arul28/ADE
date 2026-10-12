/**
 * Find in a diff (⌘F) for AdeDiffViewer's Pierre views.
 *
 * Pierre draws every line of a file's diff into an open shadow root (ADE does
 * not use its virtualized CodeView), so the lines are on the page — but the
 * browser's find does not see into shadow roots, and the desktop app binds ⌘F
 * to its menu. This searches each drawn line's text, paints matches with the
 * CSS Custom Highlight API (the highlight rules live in the diff's own CSS),
 * and scrolls the current one into view.
 *
 * Unchanged stretches longer than the viewer's threshold are collapsed and not
 * drawn. When the file's full text holds a match, the viewer is asked to draw
 * everything (`expandAll`) while the bar is open.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { claimAppMenuCommands } from "../../lib/appMenuCommands";
import { findScopeOwnsTarget, installFindTargetTracking, isFindChord } from "../../lib/findScope";
import { countOccurrences, findCountLabel, findTextRanges, foldFindCase, publishFindHighlights } from "../../lib/findText";
import { isInParkedSurface } from "../../lib/parkedSurface";
import { focusFindInput } from "./FindBar";

const DIFFS_TAG_NAME = "diffs-container";

let nextSurfaceId = 0;

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
 * new), and how many were drawn from each file — so a file holding more
 * matches than were drawn has some in collapsed lines.
 */
function collectRanges(root: Element, needle: string): { ranges: Range[]; oldDrawn: number; newDrawn: number } {
  const found: { range: Range; top: number; left: number }[] = [];
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
      ranges.forEach((range, order) => found.push({ range, top: rect.top, left: rect.left + order }));
    }
  }
  found.sort((a, b) => a.top - b.top || a.left - b.left);
  return { ranges: found.map((entry) => entry.range), oldDrawn, newDrawn };
}

function hasCollapsedContext(root: Element): boolean {
  return shadowRootsUnder(root).some((shadow) => shadow.querySelector("[data-expand-button], [data-unmodified-lines]") != null);
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
  fullText: { old: string; new: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const surfaceIdRef = useRef(`diff-find-${(nextSurfaceId += 1)}`);
  const rangesRef = useRef<Range[]>([]);
  const queryRef = useRef(query);
  queryRef.current = query;
  const activeRef = useRef(activeIndex);
  activeRef.current = activeIndex;
  const openRef = useRef(open);
  openRef.current = open;
  /** The next recompute picks the first match at or below the view instead of keeping the index. */
  const restartRef = useRef(false);
  const scrollToActiveRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const expandAllRef = useRef(expandAll);
  expandAllRef.current = expandAll;
  // Folded once per file text, not per keystroke.
  const foldedFullTextRef = useRef<{ old: string; new: string } | null>(null);
  const foldedSourceRef = useRef<{ old: string; new: string } | null>(null);
  if (fullText?.old !== foldedSourceRef.current?.old || fullText?.new !== foldedSourceRef.current?.new) {
    foldedSourceRef.current = fullText;
    foldedFullTextRef.current = fullText ? { old: foldFindCase(fullText.old), new: foldFindCase(fullText.new) } : null;
  }

  const ensureVisible = useCallback((range: Range) => {
    const scroller = scrollRef.current;
    const rect = range.getBoundingClientRect();
    if (!scroller || (!rect.width && !rect.height)) return;
    const box = scroller.getBoundingClientRect();
    if (rect.top < box.top + 24 || rect.bottom > box.bottom - 24) {
      scroller.scrollTop += rect.top - box.top - box.height * 0.4;
    }
    // Long lines scroll sideways inside their own code column.
    const line = range.startContainer.parentElement?.closest<HTMLElement>("[data-line]");
    let column: HTMLElement | null = line?.parentElement ?? null;
    while (column && column.scrollWidth <= column.clientWidth) column = column.parentElement;
    if (column) {
      const after = range.getBoundingClientRect();
      const columnBox = column.getBoundingClientRect();
      if (after.left < columnBox.left + 16 || after.right > columnBox.right - 16) {
        column.scrollLeft += after.left - columnBox.left - columnBox.width / 3;
      }
    }
  }, [scrollRef]);

  const recompute = useCallback(() => {
    const root = rootRef.current;
    if (!openRef.current || !root || !queryRef.current.trim()) {
      rangesRef.current = [];
      setTotal(0);
      setActiveIndex(null);
      publishFindHighlights(surfaceIdRef.current, null);
      return;
    }
    const needle = foldFindCase(queryRef.current);
    const { ranges, oldDrawn, newDrawn } = collectRanges(root, needle);
    rangesRef.current = ranges;
    // A match in collapsed unchanged lines: draw the whole file while open.
    const full = foldedFullTextRef.current;
    if (!expandAllRef.current && full && hasCollapsedContext(root)
      && (countOccurrences(full.old, needle) > oldDrawn || countOccurrences(full.new, needle) > newDrawn)) {
      expandAllRef.current = true;
      setExpandAll(true);
    }
    setTotal(ranges.length);
    let next = activeRef.current;
    if (restartRef.current || next == null) {
      restartRef.current = false;
      const viewTop = scrollRef.current?.getBoundingClientRect().top ?? 0;
      const firstBelow = ranges.findIndex((range) => range.getBoundingClientRect().bottom > viewTop);
      next = ranges.length ? Math.max(0, firstBelow) : null;
      scrollToActiveRef.current = next != null;
    } else if (next >= ranges.length) {
      next = ranges.length ? ranges.length - 1 : null;
    }
    activeRef.current = next;
    setActiveIndex(next);
    const active = next != null ? ranges[next] ?? null : null;
    publishFindHighlights(surfaceIdRef.current, { all: ranges, active });
    if (active && scrollToActiveRef.current) {
      scrollToActiveRef.current = false;
      ensureVisible(active);
    }
  }, [ensureVisible, rootRef, scrollRef]);

  const frameRef = useRef<number | null>(null);
  const scheduleRecompute = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      recompute();
    });
  }, [recompute]);

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

  useEffect(() => () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    publishFindHighlights(surfaceIdRef.current, null);
  }, []);


  const changeQuery = useCallback((next: string) => {
    queryRef.current = next;
    setQuery(next);
    restartRef.current = true;
  }, []);

  const step = useCallback((direction: 1 | -1) => {
    const ranges = rangesRef.current;
    if (!ranges.length) return;
    const current = activeRef.current;
    const next = current == null
      ? (direction > 0 ? 0 : ranges.length - 1)
      : (((current + direction) % ranges.length) + ranges.length) % ranges.length;
    activeRef.current = next;
    setActiveIndex(next);
    const active = ranges[next]!;
    publishFindHighlights(surfaceIdRef.current, { all: ranges, active });
    ensureVisible(active);
  }, [ensureVisible]);

  const openBar = useCallback(() => {
    if (!openRef.current) {
      const active = document.activeElement;
      restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      openRef.current = true;
      restartRef.current = true;
      setOpen(true);
    }
    focusFindInput(inputRef);
  }, []);

  const closeBar = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    expandAllRef.current = false;
    setExpandAll(false);
    setActiveIndex(null);
    activeRef.current = null;
    rangesRef.current = [];
    publishFindHighlights(surfaceIdRef.current, null);
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, []);

  const ownsFind = useCallback(() => {
    const root = rootRef.current;
    return Boolean(root && root.isConnected && !isInParkedSurface(root) && findScopeOwnsTarget(root));
  }, [rootRef]);

  useEffect(() => {
    installFindTargetTracking();
    return claimAppMenuCommands((command) => {
      if (command !== "find" || !ownsFind()) return false;
      openBar();
      return true;
    });
  }, [openBar, ownsFind]);

  // ⌘G / ⇧⌘G, and Escape from the diff itself, while open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !ownsFind()) return;
      if (event.key === "Escape") {
        const target = event.target;
        const root = rootRef.current;
        if (target !== document.body && !(target instanceof Node && root?.contains(target))) return;
        event.preventDefault();
        closeBar();
        return;
      }
      if (isFindChord(event, "g")) {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeBar, open, ownsFind, rootRef, step]);

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
