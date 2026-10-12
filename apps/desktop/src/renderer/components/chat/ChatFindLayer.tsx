/**
 * Find in a chat (⌘F).
 *
 * The bar counts matches over the whole transcript this pane holds
 * (`chatFind.ts`), not over the page: the list is virtualized and turns fold,
 * so most rows are not mounted. Moving to a match asks the list to reveal its
 * row (opening a fold when it has to), then finds the words in the mounted row
 * and scrolls them into view. Highlights use the CSS Custom Highlight API on
 * the mounted rows only, so the reply's DOM is never touched.
 *
 * Closed, the layer does no work: it neither reads rows nor watches the DOM.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { claimAppMenuCommands } from "../../lib/appMenuCommands";
import { findScopeOwnsTarget, installFindTargetTracking, isFindChord, FIND_SCOPE_ATTRIBUTE } from "../../lib/findScope";
import { findCountLabel, findTextRanges, foldFindCase, publishFindHighlights } from "../../lib/findText";
import { isInParkedSurface } from "../../lib/parkedSurface";
import { cssZoomOf } from "../../lib/webZoom";
import { FindBar, focusFindInput } from "../shared/FindBar";
import {
  ChatFindIndex,
  chatFindIndexOf,
  chatFindMatchAt,
  chatFindStartIndex,
  computeChatFindMatches,
  stepChatFindIndex,
  type ChatFindMatches,
} from "./chatFind";
import {
  markChatFindTargetActive,
  onPendingChatFind,
  registerChatFindTarget,
  takePendingChatFind,
  type ChatFindTarget,
} from "./chatFindTargets";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

/** What the list hands the layer: its rows, without re-rendering the layer on every delta. */
export type ChatFindSourceSnapshot = {
  /** Rows before folding, in transcript order. */
  rows: readonly ChatTranscriptGroupedEnvelope[];
  /** Rows the list never draws (an earlier copy of a turn's answer). */
  excludedKeys: ReadonlySet<string>;
  /** Older history is still being paged in, so counts may grow. */
  hasOlderHistory: boolean;
};

export type ChatFindSource = {
  get: () => ChatFindSourceSnapshot;
  subscribe: (listener: () => void) => () => void;
};

/** Pane scope attribute value: the whole chat pane, composer included. */
export const CHAT_PANE_FIND_SCOPE = "chat-pane";
/** Marks the elements of a row whose text find searches and paints. */
export const CHAT_FIND_TEXT_ATTRIBUTE = "data-chat-find-text";

const EMPTY_MATCHES: ChatFindMatches = { entries: [], total: 0 };
/** Slice of markdown parsing per task while building the index (under one 240 Hz frame). */
const INDEX_SLICE_MS = 3;
/** Streaming re-counts at most this often. */
const LIVE_RECOUNT_MS = 300;
/** Give up placing a match whose row never mounts (a fold that did not open). */
const REVEAL_TIMEOUT_MS = 1_500;
/** Paints that re-check a revealed match's placement while its rows settle. */
const SETTLE_PAINTS = 3;

let nextSurfaceId = 0;

type Selection = { key: string; occurrence: number };

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
  /** Scroll the transcript to `top`, leaving bottom-follow like a user scroll would. */
  scrollContainerTo: (top: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ChatFindMatches>(EMPTY_MATCHES);
  const [indexing, setIndexing] = useState(false);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  // Null: the bar shows a count but no match is selected (opened from a
  // palette result, before the first Enter).
  const [selection, setSelection] = useState<Selection | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const indexRef = useRef<ChatFindIndex | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const openRef = useRef(open);
  openRef.current = open;
  const surfaceIdRef = useRef(`chat-find-${(nextSurfaceId += 1)}`);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** A selection that still has to be scrolled into view once its row is painted. */
  const pendingRevealRef = useRef<{ selection: Selection; since: number; askedList: boolean; settle: number } | null>(null);
  /** Navigation asked for before the index was ready (Enter while "Searching…"). */
  const pendingStepRef = useRef<1 | -1 | "start" | null>(null);

  const index = () => {
    if (!indexRef.current) indexRef.current = new ChatFindIndex();
    return indexRef.current;
  };

  /** The scope ⌘F answers for: the chat pane when there is one, else this list. */
  const scopeElement = useCallback((): Element | null => {
    const root = rootRef.current;
    if (!root) return null;
    const pane = root.closest(`[${FIND_SCOPE_ATTRIBUTE}="${CHAT_PANE_FIND_SCOPE}"]`);
    return pane ?? root;
  }, [rootRef]);

  const ownsFind = useCallback((): boolean => {
    const root = rootRef.current;
    if (!root || !root.isConnected || isInParkedSurface(root)) return false;
    if (findScopeOwnsTarget(root)) return true;
    const scope = scopeElement();
    return scope !== root && findScopeOwnsTarget(scope);
  }, [rootRef, scopeElement]);

  // ── Recount ──
  const recountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRecountAtRef = useRef(0);
  const indexTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recountNow = useCallback(() => {
    if (recountTimerRef.current) {
      clearTimeout(recountTimerRef.current);
      recountTimerRef.current = null;
    }
    lastRecountAtRef.current = performance.now();
    const next = computeChatFindMatches(index().docs(), queryRef.current);
    setMatches(next);
  }, []);

  const scheduleRecount = useCallback(() => {
    if (recountTimerRef.current) return;
    const wait = Math.max(0, LIVE_RECOUNT_MS - (performance.now() - lastRecountAtRef.current));
    recountTimerRef.current = setTimeout(() => {
      recountTimerRef.current = null;
      if (openRef.current) recountNow();
    }, wait);
  }, [recountNow]);

  /** Fold rows in slices until the index is complete, recounting as it fills. */
  const runIndexing = useCallback(() => {
    if (indexTimerRef.current) return;
    const step = () => {
      indexTimerRef.current = null;
      if (!openRef.current) return;
      const done = index().indexSome(INDEX_SLICE_MS);
      if (done) {
        setIndexing(false);
        recountNow();
        return;
      }
      setIndexing(true);
      scheduleRecount();
      indexTimerRef.current = setTimeout(step, 0);
    };
    indexTimerRef.current = setTimeout(step, 0);
  }, [recountNow, scheduleRecount]);

  const syncFromSource = useCallback((options?: { immediate?: boolean }) => {
    const snapshot = source.get();
    setHasOlderHistory(snapshot.hasOlderHistory);
    const changed = index().update(snapshot.rows, snapshot.excludedKeys);
    if (!changed) return;
    if (index().pending) {
      if (options?.immediate) {
        // First open: fold what fits in one slice now so short chats answer
        // on the first keystroke, then finish in the background.
        index().indexSome(INDEX_SLICE_MS);
      }
      runIndexing();
    }
    if (options?.immediate) recountNow();
    else scheduleRecount();
  }, [recountNow, runIndexing, scheduleRecount, source]);

  // Subscribe to the list's rows only while open.
  useEffect(() => {
    if (!open) return;
    syncFromSource({ immediate: true });
    return source.subscribe(() => syncFromSource());
  }, [open, source, syncFromSource]);

  // Handles are cleared, not just cancelled: a remount (React's dev double
  // mount, a parked surface coming back) must be able to schedule again.
  useEffect(() => () => {
    if (recountTimerRef.current) clearTimeout(recountTimerRef.current);
    if (indexTimerRef.current) clearTimeout(indexTimerRef.current);
    recountTimerRef.current = null;
    indexTimerRef.current = null;
    publishFindHighlights(surfaceIdRef.current, null);
  }, []);

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

  /** Position of the first transcript row in or below the view, for "first match below". */
  const firstVisibleRowOrder = useCallback((): number | null => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return null;
    const viewTop = scroll.getBoundingClientRect().top;
    const order = rowOrder();
    for (const element of content.querySelectorAll<HTMLElement>("[data-chat-row-key]")) {
      if (element.getBoundingClientRect().bottom <= viewTop + 1) continue;
      // A drawn row that is not a transcript row (a fold, a merged run): the
      // next transcript row below it stands in.
      const position = order.get(element.dataset.chatRowKey ?? "");
      if (position !== undefined) return position;
    }
    return null;
  }, [contentRef, rowOrder, scrollRef]);

  const orderOf = useCallback((key: string): number | undefined => rowOrder().get(key), [rowOrder]);

  /** The painted occurrences in one mounted row, in reading order. */
  const rowRanges = useCallback((row: Element, needle: string): Range[] => {
    const ranges: Range[] = [];
    for (const scope of row.querySelectorAll<HTMLElement>(`[${CHAT_FIND_TEXT_ATTRIBUTE}]`)) {
      ranges.push(...findTextRanges(scope, needle));
    }
    return ranges;
  }, []);

  /**
   * The first match in or below the view. Inside a long reply that starts
   * above the view, that is the first occurrence on screen, not the reply's
   * first one; a reply whose matches are all above the view hands over to the
   * next match.
   */
  const startSelection = useCallback((counted: ChatFindMatches): Selection | null => {
    const at = chatFindStartIndex(counted, firstVisibleRowOrder(), orderOf);
    const first = at == null ? null : chatFindMatchAt(counted, at);
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!first || !scroll || !content) return first;
    const row = content.querySelector(`[data-chat-row-key="${CSS.escape(first.key)}"]`);
    if (!row) return first;
    const viewTop = scroll.getBoundingClientRect().top;
    const ranges = rowRanges(row, foldFindCase(queryRef.current));
    const onScreen = ranges.findIndex((range) => range.getBoundingClientRect().bottom > viewTop);
    if (onScreen >= 0) return { key: first.key, occurrence: onScreen };
    if (!ranges.length) return first;
    const entry = counted.entries.find((candidate) => candidate.key === first.key);
    const after = entry ? entry.start + entry.count : 0;
    return chatFindMatchAt(counted, after < counted.total ? after : 0);
  }, [contentRef, firstVisibleRowOrder, orderOf, rowRanges, scrollRef]);

  /** Scroll so `range` sits in the reading band; no scroll when already there. */
  const ensureRangeVisible = useCallback((range: Range) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const rect = range.getBoundingClientRect();
    if (!rect.height && !rect.width) return;
    const box = scroll.getBoundingClientRect();
    const margin = Math.min(80, box.height / 4);
    if (rect.top >= box.top + margin && rect.bottom <= box.bottom - margin) return;
    const zoom = cssZoomOf(scroll) || 1;
    const delta = (rect.top - box.top - box.height * 0.35) / zoom;
    scrollContainerTo(scroll.scrollTop + delta);
  }, [scrollContainerTo, scrollRef]);

  // ── Paint ──
  const paintFrameRef = useRef<number | null>(null);
  const paint = useCallback(() => {
    paintFrameRef.current = null;
    const content = contentRef.current;
    const needle = foldFindCase(queryRef.current);
    const current = matchesRef.current;
    if (!openRef.current || !content || !queryRef.current.trim() || current.total === 0) {
      publishFindHighlights(surfaceIdRef.current, null);
      return;
    }
    const wanted = new Set(current.entries.map((entry) => entry.key));
    const all: Range[] = [];
    let active: Range | null = null;
    const selected = selectionRef.current;
    let selectedRowMounted = false;
    for (const row of content.querySelectorAll<HTMLElement>("[data-chat-row-key]")) {
      const key = row.dataset.chatRowKey ?? "";
      if (!wanted.has(key)) continue;
      const ranges = rowRanges(row, needle);
      all.push(...ranges);
      if (selected && key === selected.key) {
        selectedRowMounted = true;
        // The page can show fewer occurrences than the text holds (a path
        // drawn as a short chip): stay on the last one shown.
        active = ranges[Math.min(selected.occurrence, ranges.length - 1)] ?? null;
      }
    }
    publishFindHighlights(surfaceIdRef.current, { all, active });

    const pending = pendingRevealRef.current;
    if (!pending || !selected || pending.selection !== selected) return;
    if (active) {
      // Newly mounted rows still measure, and a fold reveal re-lands its row
      // for two frames: check the placement again for a few frames.
      ensureRangeVisible(active);
      pending.settle -= 1;
      if (pending.settle <= 0) pendingRevealRef.current = null;
      else paintFrameRef.current = requestAnimationFrame(paint);
      return;
    }
    if (selectedRowMounted) {
      // Mounted but the words are not drawn as text: the row itself is the
      // best we can show.
      pendingRevealRef.current = null;
      const row = content.querySelector<HTMLElement>(`[data-chat-row-key="${CSS.escape(selected.key)}"]`);
      if (row) {
        const range = document.createRange();
        range.selectNodeContents(row);
        ensureRangeVisible(range);
      }
      return;
    }
    if (!pending.askedList) {
      pending.askedList = true;
      revealRow(selected.key);
    } else if (performance.now() - pending.since > REVEAL_TIMEOUT_MS) {
      pendingRevealRef.current = null;
    }
  }, [contentRef, ensureRangeVisible, revealRow, rowRanges]);

  const schedulePaint = useCallback(() => {
    if (paintFrameRef.current != null) return;
    paintFrameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(() => () => {
    if (paintFrameRef.current != null) cancelAnimationFrame(paintFrameRef.current);
    paintFrameRef.current = null;
  }, []);

  // Rows mount and unmount as the list scrolls, folds open, replies stream:
  // repaint on any change under the transcript, once per frame, while open.
  useEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    if (!content || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(schedulePaint);
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [contentRef, open, schedulePaint]);

  useLayoutEffect(() => {
    if (open) schedulePaint();
    else publishFindHighlights(surfaceIdRef.current, null);
  }, [matches, open, query, schedulePaint, selection]);

  // ── Navigation ──
  const select = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelection(next);
    pendingRevealRef.current = next ? { selection: next, since: performance.now(), askedList: false, settle: SETTLE_PAINTS } : null;
    schedulePaint();
  }, [schedulePaint]);

  const selectAt = useCallback((at: number | null) => {
    select(at == null ? null : chatFindMatchAt(matchesRef.current, at));
  }, [select]);

  const goToStart = useCallback(() => {
    select(startSelection(matchesRef.current));
  }, [select, startSelection]);

  const step = useCallback((direction: 1 | -1) => {
    const current = matchesRef.current;
    if (!queryRef.current.trim()) return;
    if (current.total === 0) {
      // Still folding older rows: act once the first count lands.
      if (indexRef.current?.pending) pendingStepRef.current = direction;
      return;
    }
    const selected = selectionRef.current;
    const at = selected ? chatFindIndexOf(current, selected) : null;
    if (at == null) {
      goToStart();
      return;
    }
    selectAt(stepChatFindIndex(current.total, at, direction));
  }, [goToStart, selectAt]);

  // A navigation asked for while the first count was still coming.
  useEffect(() => {
    const pendingStep = pendingStepRef.current;
    if (pendingStep == null || matches.total === 0) return;
    pendingStepRef.current = null;
    if (pendingStep === "start") goToStart();
    else step(pendingStep);
  }, [goToStart, matches, step]);

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
    const counted = computeChatFindMatches(index().docs(), next);
    matchesRef.current = counted;
    setMatches(counted);
    if (!next.trim()) {
      select(null);
      pendingStepRef.current = null;
      return;
    }
    // A new query starts at the first match in or below the view.
    if (counted.total > 0) {
      pendingStepRef.current = null;
      select(startSelection(counted));
    } else {
      select(null);
      if (indexRef.current?.pending) pendingStepRef.current = "start";
    }
  }, [select, startSelection]);

  // ── Open / close ──
  const focusInput = useCallback(() => {
    focusFindInput(inputRef);
  }, []);

  const openBar = useCallback((options?: { query?: string; passive?: boolean }) => {
    if (!openRef.current) {
      const active = document.activeElement;
      restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      openRef.current = true;
      setOpen(true);
    }
    if (options?.query !== undefined) {
      const next = options.query;
      queryRef.current = next;
      setQuery(next);
      // Counted when the subscription syncs; navigation waits for the count.
      select(null);
      pendingStepRef.current = options.passive ? null : "start";
      if (indexRef.current) recountNow();
    }
    focusInput();
  }, [focusInput, recountNow, select]);

  const closeBar = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    select(null);
    pendingStepRef.current = null;
    publishFindHighlights(surfaceIdRef.current, null);
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, [select]);

  // A different chat in this list: start over.
  useEffect(() => {
    indexRef.current = null;
    setMatches(EMPTY_MATCHES);
    select(null);
    if (openRef.current) closeBar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ⌘F from the native menu (and the web client's key handler).
  useEffect(() => {
    installFindTargetTracking();
    return claimAppMenuCommands((command) => {
      if (command !== "find" || !ownsFind()) return false;
      openBar();
      return true;
    });
  }, [openBar, ownsFind]);

  // ⌘G / ⇧⌘G and Escape while the bar is open and this chat is where the user is.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        // Escape from the transcript itself (the field handles its own).
        const target = event.target;
        const root = rootRef.current;
        const fromTranscript = target === document.body || (target instanceof Node && Boolean(root?.contains(target)));
        if (!fromTranscript || !ownsFind()) return;
        event.preventDefault();
        closeBar();
        return;
      }
      if (isFindChord(event, "g")) {
        if (!ownsFind()) return;
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeBar, open, ownsFind, rootRef, step]);

  // The palette's "Find in this chat", and the words left by a palette result.
  const openBarRef = useRef(openBar);
  openBarRef.current = openBar;
  useEffect(() => {
    const target: ChatFindTarget = {
      sessionId,
      root: () => rootRef.current,
      open: (nextQuery) => openBarRef.current({ query: nextQuery }),
    };
    const unregister = registerChatFindTarget(target);
    const scope = scopeElement();
    const markActive = () => markChatFindTargetActive(target);
    scope?.addEventListener("pointerdown", markActive, { capture: true, passive: true });
    scope?.addEventListener("focusin", markActive);
    return () => {
      unregister();
      scope?.removeEventListener("pointerdown", markActive, { capture: true });
      scope?.removeEventListener("focusin", markActive);
    };
  }, [rootRef, scopeElement, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const consume = () => {
      const pendingQuery = takePendingChatFind(sessionId);
      if (pendingQuery) openBarRef.current({ query: pendingQuery, passive: true });
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
  const partial = indexing || hasOlderHistory;
  const status = findCountLabel({ query, total: matches.total, activeIndex, partial });

  if (!open) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-end px-3">
      <FindBar
        inputRef={inputRef}
        query={query}
        onQueryChange={changeQuery}
        onStep={step}
        onClose={closeBar}
        status={status}
        canStep={matches.total > 0 || (partial && Boolean(query.trim()))}
        placeholder="Find in chat"
        className="pointer-events-auto w-[min(360px,100%)]"
      />
    </div>
  );
});
