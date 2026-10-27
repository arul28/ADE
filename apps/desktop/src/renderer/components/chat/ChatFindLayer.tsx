/**
 * Find in a chat (⌘F).
 *
 * The bar counts matches over the whole transcript this pane holds
 * (`useChatFindIndex`), not over the page: the list is virtualized and turns
 * fold, so most rows are not mounted. Moving to a match asks the list to reveal
 * its row (opening a fold when it has to), then finds the words in the mounted
 * row and scrolls them into view. Highlights use the CSS Custom Highlight API
 * on the mounted rows only, so the reply's DOM is never touched.
 *
 * Closed, the layer keeps only its ⌘F claim and palette registration: no row
 * subscription, index, DOM observer or timers.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { chatPaneOf, findScopeOwnsTarget } from "../../lib/findScope";
import { captureFindOpened } from "../../lib/findAnalytics";
import { findCountLabel, foldFindCase, publishFindHighlights, scrollRangeIntoView, stepFindIndex } from "../../lib/findText";
import { FindBar } from "../shared/FindBar";
import { useFindSession } from "../shared/useFindSession";
import { chatFindIndexOf, chatFindMatchAt } from "./chatFind";
import {
  CHAT_ROW_SELECTOR,
  chatRowSelectorFor,
  paintedRowRanges,
  startSelection,
  type FindSelection,
} from "./chatFindGeometry";
import {
  markChatFindTargetActive,
  onPendingChatFind,
  registerChatFindTarget,
  takePendingChatFind,
  type ChatFindTarget,
} from "./chatFindTargets";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";
import { useChatFindIndex, type ChatFindSource } from "./useChatFindIndex";

/** Give up placing a match whose row never mounts (a fold that did not open). */
const REVEAL_TIMEOUT_MS = 1_500;
/** Paints that re-check a revealed match's placement while its rows settle. */
const SETTLE_PAINTS = 3;
/** DOM changes (a streaming reply, rows mounting) repaint at most this often. */
const MUTATION_REPAINT_MS = 100;

/** A selection still to be scrolled into view once its row is painted. */
type PendingReveal = { selection: FindSelection; since: number; askedList: boolean; settle: number };
/** What Enter should do once the first count lands: start, step, or nothing yet. */
type PendingStep = 1 | -1 | "start" | null;

/**
 * Memoized: every prop is stable, so the list's per-token re-renders while a
 * reply streams never reach this component.
 */
export const ChatFindLayer = memo(function ChatFindLayer({
  rootRef,
  contentRef,
  scrollRef,
  source,
  sessionId,
  revealRow,
  scrollContainerTo,
}: {
  rootRef: MutableRefObject<HTMLDivElement | null>;
  contentRef: MutableRefObject<HTMLDivElement | null>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  source: ChatFindSource;
  sessionId: string | null;
  /** Open the fold around a row if needed and scroll it near the top. */
  revealRow: (rowKey: string) => void;
  /** Scroll the transcript to `top`, letting go of bottom-follow like a reader's scroll would. */
  scrollContainerTo: (top: number) => void;
}) {
  const [query, setQuery] = useState("");
  // Null: the bar shows a count but no match is selected (opened from a
  // palette result, before the first Enter).
  const [selection, setSelection] = useState<FindSelection | null>(null);
  const queryRef = useRef(query);
  const selectionRef = useRef(selection);
  const pendingRevealRef = useRef<PendingReveal | null>(null);
  const pendingStepRef = useRef<PendingStep>(null);
  const mutationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The session owns ⌘F, the bar, Escape, focus and the paint frame; it calls
  // back through refs so the callbacks below can use what it returns.
  const handlers = useRef({ step: (_direction: 1 | -1) => {}, reset: () => {}, paint: () => {} });
  const session = useFindSession({
    // This list, or the whole chat pane around it (composer included).
    ownsFind: () => findScopeOwnsTarget(rootRef.current) || findScopeOwnsTarget(chatPaneOf(rootRef.current)),
    onStep: (direction) => handlers.current.step(direction),
    onClosed: () => handlers.current.reset(),
    paint: () => handlers.current.paint(),
    escapeRootRef: rootRef,
    openedByShortcut: () => captureFindOpened("chat_shortcut"),
  });
  const { open, openRef, surfaceId, openBar, closeBar, schedulePaint } = session;
  const { matches, matchesRef, partial, rowsStillFolding, recountNow } = useChatFindIndex({ source, open, queryRef });
  useEffect(() => {
    if (open) source.requestCompleteHistory?.();
  }, [open, source]);

  const select = useCallback((next: FindSelection | null) => {
    selectionRef.current = next;
    setSelection(next);
    pendingRevealRef.current = next ? { selection: next, since: performance.now(), askedList: false, settle: SETTLE_PAINTS } : null;
    if (next) schedulePaint();
  }, [schedulePaint]);

  handlers.current.reset = () => {
    queryRef.current = "";
    setQuery("");
    select(null);
    pendingStepRef.current = null;
  };

  // ── Geometry ──
  /** Each row's position in the transcript, rebuilt only when the row list changes. */
  const rowOrderCacheRef = useRef<{ rows: readonly ChatTranscriptGroupedEnvelope[]; order: Map<string, number> } | null>(null);
  const rowOrder = useCallback((): Map<string, number> => {
    const rows = source.get().rows;
    const cached = rowOrderCacheRef.current;
    if (cached && cached.rows === rows) return cached.order;
    const order = new Map<string, number>();
    rows.forEach((row, position) => order.set(row.key, position));
    rowOrderCacheRef.current = { rows, order };
    return order;
  }, [source]);

  const selectStart = useCallback((counted = matchesRef.current) => {
    select(startSelection({
      counted,
      scroll: scrollRef.current,
      content: contentRef.current,
      order: rowOrder(),
      foldedNeedle: foldFindCase(queryRef.current),
    }));
  }, [contentRef, matchesRef, rowOrder, scrollRef, select]);

  /**
   * Reveal `range` in the part of the transcript a reader can see: below the
   * find bar, and above the composer when the composer floats over the list.
   */
  const revealRange = useCallback((range: Range) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const box = scroll.getBoundingClientRect();
    const bar = session.inputRef.current?.closest("form")?.getBoundingClientRect();
    const composer = chatPaneOf(rootRef.current)?.querySelector("[data-chat-composer-overlay]")?.getBoundingClientRect();
    scrollRangeIntoView(scroll, range, {
      scrollTo: scrollContainerTo,
      covered: {
        top: bar ? Math.max(0, bar.bottom - box.top) : 0,
        bottom: composer ? Math.max(0, box.bottom - composer.top) : 0,
      },
    });
  }, [rootRef, scrollContainerTo, scrollRef, session.inputRef]);

  // ── Paint ──
  handlers.current.paint = () => {
    const content = contentRef.current;
    const needle = foldFindCase(queryRef.current);
    const current = matchesRef.current;
    if (!openRef.current || !content || !needle || current.total === 0) {
      publishFindHighlights(surfaceId, null);
      return;
    }
    const wanted = new Set(current.entries.map((entry) => entry.key));
    const all: Range[] = [];
    let active: Range | null = null;
    const selected = selectionRef.current;
    let selectedRowMounted = false;
    for (const row of content.querySelectorAll<HTMLElement>(CHAT_ROW_SELECTOR)) {
      const key = row.dataset.chatRowKey ?? "";
      if (!wanted.has(key)) continue;
      const ranges = paintedRowRanges(row, needle);
      all.push(...ranges);
      if (selected && key === selected.key) {
        selectedRowMounted = true;
        // The page can show fewer occurrences than the text holds (a path
        // drawn as a short chip): stay on the last one shown.
        active = ranges[Math.min(selected.occurrence, ranges.length - 1)] ?? null;
      }
    }
    publishFindHighlights(surfaceId, { all, active });

    const pending = pendingRevealRef.current;
    if (!pending || !selected || pending.selection !== selected) return;
    if (active) {
      // Newly mounted rows still measure, and a fold reveal re-lands its row
      // for two frames: check the placement again for a few frames.
      revealRange(active);
      pending.settle -= 1;
      if (pending.settle <= 0) pendingRevealRef.current = null;
      else schedulePaint();
      return;
    }
    if (selectedRowMounted) {
      // Mounted but the words are not drawn as text: the row itself is the
      // best we can show.
      pendingRevealRef.current = null;
      const row = content.querySelector<HTMLElement>(chatRowSelectorFor(selected.key));
      if (row) {
        const range = document.createRange();
        range.selectNodeContents(row);
        revealRange(range);
      }
      return;
    }
    if (!pending.askedList) {
      pending.askedList = true;
      revealRow(selected.key);
    } else if (performance.now() - pending.since > REVEAL_TIMEOUT_MS) {
      pendingRevealRef.current = null;
    }
  };

  // Rows mount and unmount as the list scrolls, folds open, replies stream.
  // Repaint at most every MUTATION_REPAINT_MS — at once while a reveal lands.
  useEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    if (!content || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (pendingRevealRef.current) {
        schedulePaint();
        return;
      }
      if (mutationTimerRef.current != null) return;
      mutationTimerRef.current = setTimeout(() => {
        mutationTimerRef.current = null;
        schedulePaint();
      }, MUTATION_REPAINT_MS);
    });
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (mutationTimerRef.current != null) clearTimeout(mutationTimerRef.current);
      // Cleared, not just cancelled, so a reopen can schedule again.
      mutationTimerRef.current = null;
    };
  }, [contentRef, open, schedulePaint]);

  useLayoutEffect(() => {
    if (open) schedulePaint();
  }, [matches, open, query, schedulePaint, selection]);

  // ── Navigation ──
  const step = useCallback((direction: 1 | -1) => {
    const current = matchesRef.current;
    if (!queryRef.current.trim()) return;
    if (current.total === 0) {
      // Still folding older rows: act once the first count lands.
      if (rowsStillFolding()) pendingStepRef.current = direction;
      return;
    }
    const selected = selectionRef.current;
    const at = selected ? chatFindIndexOf(current, selected) : null;
    if (at == null) {
      selectStart();
      return;
    }
    const next = stepFindIndex(current.total, at, direction);
    select(next == null ? null : chatFindMatchAt(current, next));
  }, [rowsStillFolding, matchesRef, select, selectStart]);
  handlers.current.step = step;

  // A navigation asked for while the first count was still coming.
  useEffect(() => {
    const pendingStep = pendingStepRef.current;
    if (pendingStep == null) return;
    if (matches.total === 0) {
      // Counting finished with nothing: a match streamed in later must not move the view.
      if (!partial) pendingStepRef.current = null;
      return;
    }
    pendingStepRef.current = null;
    if (pendingStep === "start") selectStart();
    else step(pendingStep);
  }, [matches, partial, selectStart, step]);

  // Keep the selection on the same words when matches move under it
  // (streaming, a retracted reply); drop it when its row lost every match.
  useEffect(() => {
    const selected = selectionRef.current;
    if (!selected) return;
    const at = chatFindIndexOf(matches, selected);
    if (at == null) {
      select(null);
      return;
    }
    const resolved = chatFindMatchAt(matches, at);
    if (resolved && resolved.occurrence !== selected.occurrence) {
      selectionRef.current = resolved;
      const pending = pendingRevealRef.current;
      if (pending?.selection === selected) pending.selection = resolved;
      setSelection(resolved);
    }
  }, [matches, select]);

  const changeQuery = useCallback((next: string) => {
    queryRef.current = next;
    setQuery(next);
    const counted = recountNow(next);
    if (!next.trim()) {
      select(null);
      pendingStepRef.current = null;
      return;
    }
    // A new query starts at the first match in or below the view.
    if (counted.total > 0) {
      pendingStepRef.current = null;
      selectStart(counted);
    } else {
      select(null);
      if (rowsStillFolding()) pendingStepRef.current = "start";
    }
  }, [rowsStillFolding, recountNow, select, selectStart]);

  /**
   * Open with `nextQuery` filled in, from the palette. `then` is what happens
   * once it is counted: "start" goes to the first match in view, null only
   * shows the count (a palette hit already put the reader on its message).
   */
  const openWithQuery = useCallback((nextQuery: string, then: "start" | null) => {
    openBar();
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    // Already open: count the new words now (opening counts on its own).
    recountNow(nextQuery);
    select(null);
    pendingStepRef.current = then;
  }, [openBar, recountNow, select]);

  // A different chat in this list: the words and position belonged to the old one.
  useEffect(() => {
    if (openRef.current) closeBar();
  }, [closeBar, openRef, sessionId]);

  // The palette's "Find in this chat", and the words a palette result left for this chat.
  const openWithQueryRef = useRef(openWithQuery);
  openWithQueryRef.current = openWithQuery;
  useEffect(() => {
    const target: ChatFindTarget = {
      root: () => rootRef.current,
      open: (nextQuery) => {
        captureFindOpened("chat_palette");
        openWithQueryRef.current(nextQuery, "start");
      },
    };
    const unregister = registerChatFindTarget(target);
    const scope = chatPaneOf(rootRef.current) ?? rootRef.current;
    const markActive = () => markChatFindTargetActive(target);
    scope?.addEventListener("pointerdown", markActive, { capture: true, passive: true });
    scope?.addEventListener("focusin", markActive);
    return () => {
      unregister();
      scope?.removeEventListener("pointerdown", markActive, { capture: true });
      scope?.removeEventListener("focusin", markActive);
    };
  }, [rootRef]);

  useEffect(() => {
    if (!sessionId) return;
    const consume = () => {
      const pendingQuery = takePendingChatFind(sessionId);
      if (!pendingQuery) return;
      captureFindOpened("chat_palette_hit");
      openWithQueryRef.current(pendingQuery, null);
    };
    consume();
    return onPendingChatFind((target) => {
      if (target === sessionId) consume();
    });
  }, [sessionId]);

  // ── Render ──
  const activeIndex = useMemo(
    () => (selection ? chatFindIndexOf(matches, selection) : null),
    [matches, selection],
  );
  if (!open) return null;
  return (
    <FindBar
      inputRef={session.inputRef}
      query={query}
      onQueryChange={changeQuery}
      onStep={step}
      onClose={closeBar}
      status={findCountLabel({ query, total: matches.total, activeIndex, partial })}
      canStep={matches.total > 0 || (partial && Boolean(query.trim()))}
      placeholder="Find in chat"
    />
  );
});
