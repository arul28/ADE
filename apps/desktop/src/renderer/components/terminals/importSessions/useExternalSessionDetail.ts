import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import type { OpenProjectBinding } from "../../../../shared/types";
import {
  getExternalSessionsApi,
  type ExternalSessionDetail,
  type ExternalSessionSummary,
} from "./contract";
import { eventsFromMessages, previewTranscriptKey, spliceNewestPage } from "./importBrowserModel";

type DetailState = {
  detail: ExternalSessionDetail | null;
  /** Everything shown, oldest to newest: paged-back events plus the newest page. */
  events: AgentChatEventEnvelope[];
  /** Cursor for the page before `events[0]`; null when nothing older exists. */
  olderCursor: string | null;
  /** True once the user paged back; a live update then keeps those events. */
  pagedBack: boolean;
};

const EMPTY_STATE: DetailState = { detail: null, events: [], olderCursor: null, pagedBack: false };

let watchSeq = 0;
/** Short settle delay before loading a preview, so fast keyboard moves stay cheap. */
const PREVIEW_SETTLE_MS = 90;

function pageEvents(detail: ExternalSessionDetail, transcriptKey: string): AgentChatEventEnvelope[] {
  if (Array.isArray(detail.events)) return detail.events;
  return eventsFromMessages(detail.messages ?? [], transcriptKey);
}

function pageCursor(detail: ExternalSessionDetail): string | null {
  return detail.hasOlder && detail.olderCursor ? detail.olderCursor : null;
}

/**
 * Loads one session's transcript for the preview: the newest page first, older
 * pages on scroll-back, and — for sessions on this computer — live updates
 * while the preview is open. A live update replaces the newest page and keeps
 * whatever the user already paged back through.
 */
export function useExternalSessionDetail(
  summary: ExternalSessionSummary,
  runtimePin: OpenProjectBinding | null,
) {
  const transcriptKey = previewTranscriptKey(summary);
  const [state, setState] = useState<DetailState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    const api = getExternalSessionsApi();
    setState(EMPTY_STATE);
    setError(null);
    setOlderError(null);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    if (!api) {
      setError("Couldn't load this conversation.");
      return;
    }
    let cancelled = false;
    const watchId = `import-preview:${summary.provider}:${summary.id}:${++watchSeq}`;
    const apply = (next: ExternalSessionDetail) => {
      if (cancelled) return;
      const newest = pageEvents(next, transcriptKey);
      setState((prev) => {
        if (prev.pagedBack) {
          const spliced = spliceNewestPage(prev.events, newest);
          if (spliced) return { ...prev, detail: next, events: spliced };
        }
        return { detail: next, events: newest, olderCursor: pageCursor(next), pagedBack: false };
      });
    };
    const localWatch = runtimePin?.kind !== "remote" && api.watchDetail ? api.watchDetail : null;
    let watching = false;
    const start = async () => {
      if (cancelled) return;
      watching = localWatch != null;
      try {
        const loaded = localWatch
          ? await localWatch({ provider: summary.provider, sessionId: summary.id, watchId })
          : await api.getDetail?.({ provider: summary.provider, sessionId: summary.id }, runtimePin);
        if (loaded) apply(loaded);
        else if (!cancelled) setError("Couldn't load this conversation.");
      } catch {
        if (!cancelled) setError("Couldn't load this conversation.");
      }
    };
    // Holding ↓ through the list should not parse every transcript it passes.
    const startTimer = setTimeout(() => void start(), PREVIEW_SETTLE_MS);
    const unsubscribe = localWatch
      ? api.onDetailUpdated?.((event) => {
        if (event.watchId === watchId) apply(event.detail);
      })
      : undefined;
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      unsubscribe?.();
      if (watching && localWatch) void Promise.resolve(api.unwatchDetail?.({ watchId })).catch(() => undefined);
    };
  }, [runtimePin, summary.id, summary.provider, transcriptKey]);

  const loadOlder = useCallback(() => {
    const cursor = stateRef.current.olderCursor;
    const api = getExternalSessionsApi();
    if (!cursor || !api?.getDetail || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    void api.getDetail({ provider: summary.provider, sessionId: summary.id, before: cursor }, runtimePin)
      .then((page) => {
        const older = pageEvents(page, transcriptKey);
        setState((prev) => prev.olderCursor !== cursor ? prev : {
          ...prev,
          events: [...older, ...prev.events],
          olderCursor: pageCursor(page),
          pagedBack: true,
        });
      })
      .catch(() => setOlderError("Couldn't load earlier messages."))
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [runtimePin, summary, transcriptKey]);

  const fallbackEvents = useMemo(
    () => eventsFromMessages(summary.messages ?? [], transcriptKey),
    [summary.messages, transcriptKey],
  );

  const loaded = state.detail != null;
  return {
    transcriptKey,
    detail: state.detail,
    loaded,
    // A failed load still shows the sampled messages from the list row.
    events: loaded ? state.events : error ? fallbackEvents : [],
    hasOlder: loaded && state.olderCursor != null && Boolean(getExternalSessionsApi()?.getDetail),
    loadingOlder,
    olderError,
    loadOlder,
    error,
  };
}
