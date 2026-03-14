import { useEffect, useRef } from "react";
import type { OrchestratorThreadEventType } from "../../shared/types";

const DEFAULT_EVENT_TYPES: OrchestratorThreadEventType[] = [
  "message_appended",
  "message_updated",
  "worker_replay",
];

/**
 * Subscribe to orchestrator thread events, debounce-calling `onRefresh` when
 * matching events arrive.  Cleans up subscription and pending timers on unmount.
 */
export function useThreadEventRefresh(opts: {
  missionId: string | null;
  threadId?: string | null;
  onRefresh: () => void;
  debounceMs?: number;
  eventTypes?: OrchestratorThreadEventType[];
}): void {
  const { missionId, threadId, onRefresh, debounceMs = 150, eventTypes = DEFAULT_EVENT_TYPES } = opts;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!missionId) return;

    const unsub = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.missionId !== missionId) return;
      if (!eventTypes.includes(event.type)) return;
      if (threadId !== undefined && threadId !== null && event.threadId && event.threadId !== threadId) return;

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        onRefresh();
      }, debounceMs);
    });

    return () => {
      unsub();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [missionId, threadId, onRefresh, debounceMs, eventTypes]);
}
