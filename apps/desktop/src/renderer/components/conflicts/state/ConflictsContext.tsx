import React, { createContext, useContext, useReducer, useEffect, type Dispatch } from "react";
import { conflictsReducer } from "./conflictsReducer";
import { initialConflictsState, type ConflictsState, type ConflictsAction } from "./types";
import { fetchBatchAssessment, fetchRestackSuggestions } from "./conflictsActions";
import type { ConflictEventPayload } from "../../../../shared/types";

/**
 * Split into two contexts so that components which only need `dispatch`
 * (e.g. event handlers, action triggers) do not re-render when state changes.
 * `dispatch` from useReducer is referentially stable, so the DispatchContext
 * value never changes and its consumers never re-render due to state updates.
 */
const ConflictsStateContext = createContext<ConflictsState | null>(null);
const ConflictsDispatchContext = createContext<Dispatch<ConflictsAction> | null>(null);

export function ConflictsProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(conflictsReducer, initialConflictsState);

  // Initial data load
  useEffect(() => {
    fetchBatchAssessment(dispatch);
    fetchRestackSuggestions(dispatch);
  }, []);

  // Subscribe to conflict events for real-time progress updates
  useEffect(() => {
    const unsub = window.ade.conflicts.onEvent((event: ConflictEventPayload) => {
      if (event.type === "prediction-progress") {
        dispatch({
          type: "SET_PROGRESS",
          progress: { completedPairs: event.completedPairs, totalPairs: event.totalPairs },
        });
      }
      if (event.type === "prediction-complete") {
        // Refresh the full batch when predictions complete
        fetchBatchAssessment(dispatch);
      }
    });
    return unsub;
  }, []);

  // Subscribe to restack suggestion events
  useEffect(() => {
    const unsub = window.ade.lanes.onRestackSuggestionsEvent((event) => {
      if (event.type === "restack-suggestions-updated") {
        dispatch({ type: "SET_RESTACK_SUGGESTIONS", suggestions: event.suggestions });
      }
    });
    return unsub;
  }, []);

  return (
    <ConflictsDispatchContext.Provider value={dispatch}>
      <ConflictsStateContext.Provider value={state}>
        {children}
      </ConflictsStateContext.Provider>
    </ConflictsDispatchContext.Provider>
  );
}

export function useConflictsState(): ConflictsState {
  const state = useContext(ConflictsStateContext);
  if (state === null) throw new Error("useConflictsState must be used within ConflictsProvider");
  return state;
}

export function useConflictsDispatch(): Dispatch<ConflictsAction> {
  const dispatch = useContext(ConflictsDispatchContext);
  if (dispatch === null) throw new Error("useConflictsDispatch must be used within ConflictsProvider");
  return dispatch;
}

/** Combined hook for callers that need both state and dispatch. */
export function useConflicts(): { state: ConflictsState; dispatch: Dispatch<ConflictsAction> } {
  return { state: useConflictsState(), dispatch: useConflictsDispatch() };
}
