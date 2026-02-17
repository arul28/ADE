import React, { createContext, useContext, useReducer, useEffect, type Dispatch } from "react";
import { conflictsReducer } from "./conflictsReducer";
import { initialConflictsState, type ConflictsState, type ConflictsAction } from "./types";
import { fetchBatchAssessment, fetchRestackSuggestions } from "./conflictsActions";
import type { ConflictEventPayload } from "../../../../shared/types";

type ConflictsContextValue = {
  state: ConflictsState;
  dispatch: Dispatch<ConflictsAction>;
};

const ConflictsContext = createContext<ConflictsContextValue | null>(null);

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

  const value = React.useMemo(() => ({ state, dispatch }), [state]);

  return <ConflictsContext.Provider value={value}>{children}</ConflictsContext.Provider>;
}

export function useConflicts(): ConflictsContextValue {
  const ctx = useContext(ConflictsContext);
  if (!ctx) throw new Error("useConflicts must be used within ConflictsProvider");
  return ctx;
}

export function useConflictsState(): ConflictsState {
  return useConflicts().state;
}

export function useConflictsDispatch(): Dispatch<ConflictsAction> {
  return useConflicts().dispatch;
}
