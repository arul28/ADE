/**
 * The counting half of find in a chat: keeps a `ChatFindIndex` in step with
 * the list's rows while the bar is open, and turns it into match counts.
 *
 * The index exists only while open. Closing releases it (a folded copy of the
 * whole transcript), so a chat that is not being searched holds nothing.
 * Markdown is parsed in short slices so a long chat never holds a 240 Hz
 * frame, and a streaming reply re-counts at most every `LIVE_RECOUNT_MS`.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { ChatFindIndex, computeChatFindMatches, type ChatFindMatches } from "./chatFind";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

/** What the list hands the find layer: its rows, without re-rendering the layer on every delta. */
export type ChatFindSourceSnapshot = {
  /** Rows before folding, in transcript order. */
  rows: readonly ChatTranscriptGroupedEnvelope[];
  /** Rows the list never draws (an earlier copy of a turn's answer). */
  excludedKeys: ReadonlySet<string>;
  /** Older history is still being paged in, so counts may grow. */
  hasOlderHistory: boolean;
};

export type ChatFindSource = {
  /** Find is open: page the rest of the chat in, so every match can be counted. */
  requestCompleteHistory?: () => void;
  get: () => ChatFindSourceSnapshot;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY_CHAT_FIND_MATCHES: ChatFindMatches = { entries: [], total: 0 };
/** Markdown parsing per task while building the index (under one 240 Hz frame). */
const INDEX_SLICE_MS = 3;
/** Streaming re-counts at most this often. */
const LIVE_RECOUNT_MS = 300;

export function useChatFindIndex({
  source,
  open,
  queryRef,
}: {
  source: ChatFindSource;
  open: boolean;
  queryRef: MutableRefObject<string>;
}) {
  const [matches, setMatches] = useState<ChatFindMatches>(EMPTY_CHAT_FIND_MATCHES);
  const matchesRef = useRef(matches);
  const [indexing, setIndexing] = useState(false);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const indexRef = useRef<ChatFindIndex | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const recountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRecountAtRef = useRef(0);

  const publish = useCallback((next: ChatFindMatches) => {
    matchesRef.current = next;
    setMatches(next);
  }, []);

  /** Count now with `query` (the field's latest value by default). */
  const recountNow = useCallback((query: string = queryRef.current): ChatFindMatches => {
    if (recountTimerRef.current) {
      clearTimeout(recountTimerRef.current);
      recountTimerRef.current = null;
    }
    lastRecountAtRef.current = performance.now();
    const next = indexRef.current ? computeChatFindMatches(indexRef.current.docs(), query) : EMPTY_CHAT_FIND_MATCHES;
    publish(next);
    return next;
  }, [publish, queryRef]);

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
    const slice = () => {
      indexTimerRef.current = null;
      const index = indexRef.current;
      if (!openRef.current || !index) return;
      if (index.indexSome(INDEX_SLICE_MS)) {
        setIndexing(false);
        recountNow();
        return;
      }
      setIndexing(true);
      scheduleRecount();
      indexTimerRef.current = setTimeout(slice, 0);
    };
    indexTimerRef.current = setTimeout(slice, 0);
  }, [recountNow, scheduleRecount]);

  const sync = useCallback((first: boolean) => {
    const index = indexRef.current;
    if (!index) return;
    const snapshot = source.get();
    setHasOlderHistory(snapshot.hasOlderHistory);
    if (!index.update(snapshot.rows, snapshot.excludedKeys)) return;
    if (index.hasPending()) {
      // First sync: fold what fits in one slice now so a short chat answers
      // on the first keystroke, then finish in the background.
      if (first) index.indexSome(INDEX_SLICE_MS);
      runIndexing();
    }
    if (first) recountNow();
    else scheduleRecount();
  }, [recountNow, runIndexing, scheduleRecount, source]);

  const clearTimers = useCallback(() => {
    if (recountTimerRef.current) clearTimeout(recountTimerRef.current);
    if (indexTimerRef.current) clearTimeout(indexTimerRef.current);
    // Cleared, not just cancelled: a remount (React's dev double mount, a
    // parked surface coming back) must be able to schedule again.
    recountTimerRef.current = null;
    indexTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    indexRef.current = new ChatFindIndex();
    sync(true);
    const unsubscribe = source.subscribe(() => sync(false));
    return () => {
      unsubscribe();
      clearTimers();
      indexRef.current = null;
      setIndexing(false);
      publish(EMPTY_CHAT_FIND_MATCHES);
    };
  }, [clearTimers, open, publish, source, sync]);

  return {
    matches,
    matchesRef,
    /** Rows are still being folded or older history is still paging in: counts may grow. */
    partial: indexing || hasOlderHistory,
    /**
     * Read now, not from the last render's `partial`: rows are still being
     * folded, so a count of 0 is not final yet.
     */
    rowsStillFolding: () => Boolean(indexRef.current?.hasPending()),
    recountNow,
  };
}
