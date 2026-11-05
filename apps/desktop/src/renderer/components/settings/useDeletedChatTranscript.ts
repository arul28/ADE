import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { ExternalSessionDetail, OpenProjectBinding } from "../../../shared/types";
import { eventsFromMessages } from "../terminals/importSessions/importBrowserModel";
import type { SessionTranscriptState } from "../terminals/importSessions/ImportSessionPreview";

/** Short settle delay before loading, so holding ↓ through the list stays cheap. */
const PREVIEW_SETTLE_MS = 90;

function pageEvents(detail: ExternalSessionDetail, transcriptKey: string): AgentChatEventEnvelope[] {
  if (Array.isArray(detail.events)) return detail.events;
  return eventsFromMessages(detail.messages ?? [], transcriptKey);
}

function pageCursor(detail: ExternalSessionDetail): string | null {
  return detail.hasOlder && detail.olderCursor ? detail.olderCursor : null;
}

type State = {
  detail: ExternalSessionDetail | null;
  events: AgentChatEventEnvelope[];
  olderCursor: string | null;
};

const EMPTY: State = { detail: null, events: [], olderCursor: null };

/**
 * One deleted chat's conversation for the Recently deleted preview: the newest
 * page first, older pages on scroll-back. Read from the machine that holds it
 * (`pin`), like every other call on that page.
 */
export function useDeletedChatTranscript(
  chatId: string,
  pin: OpenProjectBinding | null,
): SessionTranscriptState & { detail: ExternalSessionDetail | null } {
  const transcriptKey = `deleted-chat:${chatId}`;
  const [state, setState] = useState<State>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadingOlderRef = useRef(false);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    setState(EMPTY);
    setError(null);
    setOlderError(null);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.ade.agentChat.getDeletedDetail({ id: chatId }, pinRef.current)
        .then((detail) => {
          if (cancelled) return;
          if (!detail.sourcePath && !detail.events?.length && !detail.messages?.length) {
            setError("Couldn't load this conversation.");
            return;
          }
          setState({ detail, events: pageEvents(detail, transcriptKey), olderCursor: pageCursor(detail) });
        })
        .catch(() => {
          if (!cancelled) setError("Couldn't load this conversation.");
        });
    }, PREVIEW_SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chatId, pinKey, transcriptKey]);

  const loadOlder = useCallback(() => {
    const cursor = stateRef.current.olderCursor;
    if (!cursor || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    void window.ade.agentChat.getDeletedDetail({ id: chatId, before: cursor }, pinRef.current)
      .then((page) => {
        setState((prev) => prev.olderCursor !== cursor ? prev : {
          ...prev,
          events: [...pageEvents(page, transcriptKey), ...prev.events],
          olderCursor: pageCursor(page),
        });
      })
      .catch(() => setOlderError("Couldn't load earlier messages."))
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [chatId, transcriptKey]);

  const loaded = state.detail != null;
  return {
    transcriptKey,
    detail: state.detail,
    loaded,
    events: state.events,
    hasOlder: loaded && state.olderCursor != null,
    loadingOlder,
    olderError,
    loadOlder,
    error,
  };
}
