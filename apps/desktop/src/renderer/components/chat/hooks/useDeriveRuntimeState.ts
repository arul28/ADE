import { useRef } from "react";
import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { derivePendingInputRequests, type DerivedPendingInput } from "../pendingInput";

export interface DerivedRuntimeState {
  turnActive: boolean;
  pendingInputs: DerivedPendingInput[];
}

/**
 * Incrementally derives runtime state (turnActive + pendingInputs) from an
 * event list.  Instead of re-scanning every event on each call, we track the
 * last processed index and only walk new events for the `turnActive` flag.
 *
 * `pendingInputs` still delegates to `derivePendingInputRequests` because that
 * function maintains a Map with deletions (tool_result clearing a prior
 * approval_request) which isn't easily incrementalizable without duplicating
 * the full logic.
 */
export function useDeriveRuntimeState() {
  const lastIndexRef = useRef(0);
  const stateRef = useRef<{ turnActive: boolean }>({ turnActive: false });

  function deriveRuntimeState(events: AgentChatEventEnvelope[]): DerivedRuntimeState {
    // If the event list was replaced or truncated, force a full rescan
    if (events.length < lastIndexRef.current) {
      lastIndexRef.current = 0;
      stateRef.current = { turnActive: false };
    }

    // Walk only the new events for turnActive
    const start = lastIndexRef.current;
    let { turnActive } = stateRef.current;

    for (let i = start; i < events.length; i++) {
      const event = events[i]!.event;

      if (event.type === "status") {
        turnActive = event.turnStatus === "started";
        continue;
      }

      if (event.type === "done") {
        turnActive = false;
        continue;
      }
    }

    lastIndexRef.current = events.length;
    stateRef.current = { turnActive };

    return {
      turnActive,
      pendingInputs: derivePendingInputRequests(events),
    };
  }

  /** Reset tracking so the next call re-scans from scratch. */
  function resetDeriveState() {
    lastIndexRef.current = 0;
    stateRef.current = { turnActive: false };
  }

  return { deriveRuntimeState, resetDeriveState };
}

/**
 * Standalone (non-hook) version used by flushQueuedEvents where we need to
 * derive state for arbitrary session event lists without React hook rules.
 */
export function deriveRuntimeState(events: AgentChatEventEnvelope[]): DerivedRuntimeState {
  let turnActive = false;

  for (const envelope of events) {
    const event = envelope.event;

    if (event.type === "status") {
      turnActive = event.turnStatus === "started";
      continue;
    }

    if (event.type === "done") {
      turnActive = false;
      continue;
    }
  }

  return {
    turnActive,
    pendingInputs: derivePendingInputRequests(events),
  };
}
