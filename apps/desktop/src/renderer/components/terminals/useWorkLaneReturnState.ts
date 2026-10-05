import { useMemo, useRef } from "react";
import {
  EMPTY_WORK_LANE_RETURN_STATE,
  nextWorkLaneReturnState,
  type WorkLaneReturnState,
} from "./workLaneFocus";

/**
 * Which lanes came back out of the Working shelf, and when. The return time is
 * the moment this client saw the lane leave the fold, so it is advanced on
 * render rather than stored. The transition is idempotent for an unchanged
 * folded set, so a repeated render (StrictMode included) settles on the same
 * state. Turning the mode off forgets it, so turning it on again takes a fresh
 * baseline instead of floating every lane at once.
 */
export function useWorkLaneReturnState(
  active: boolean,
  foldedLaneIds: ReadonlySet<string>,
  presentLaneIds: readonly string[],
): WorkLaneReturnState {
  const ref = useRef<WorkLaneReturnState>(EMPTY_WORK_LANE_RETURN_STATE);
  return useMemo(() => {
    const next = active
      ? nextWorkLaneReturnState(ref.current, foldedLaneIds, new Set(presentLaneIds), Date.now())
      : EMPTY_WORK_LANE_RETURN_STATE;
    ref.current = next;
    return next;
  }, [active, foldedLaneIds, presentLaneIds]);
}
