import { useEffect, useRef, useState } from "react";
import {
  takeWorkDraftLaneRequest,
  WORK_DRAFT_LANE_REQUESTED_EVENT,
  type WorkDraftLaneRequest,
} from "../../lib/workDraft";

/**
 * Runs `onRequest` when a "New chat in this lane" request for this project is
 * waiting, once `ready` (the Work draft composer, after its saved draft has
 * been restored, so the restore cannot undo what `onRequest` clears).
 */
export function useWorkDraftLaneRequest({
  ready,
  projectStateKey,
  onRequest,
}: {
  ready: boolean;
  projectStateKey: string | null;
  onRequest: (request: WorkDraftLaneRequest) => void;
}): void {
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;
  // A request made while this composer is ready arrives as an event; one made
  // before (Work not mounted yet, draft still restoring) is read once it is.
  const [requestTick, setRequestTick] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const onLaneRequested = () => setRequestTick((tick) => tick + 1);
    window.addEventListener(WORK_DRAFT_LANE_REQUESTED_EVENT, onLaneRequested);
    return () => window.removeEventListener(WORK_DRAFT_LANE_REQUESTED_EVENT, onLaneRequested);
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const request = takeWorkDraftLaneRequest(projectStateKey);
    if (request) onRequestRef.current(request);
  }, [projectStateKey, ready, requestTick]);
}
