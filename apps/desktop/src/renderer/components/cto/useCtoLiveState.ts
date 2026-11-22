import { useEffect, useReducer } from "react";
import type { AgentChatEventEnvelope, OpenProjectBinding } from "../../../shared/types";
import { ctoStepWords } from "../chat/cto/ctoToolWords";

export type CtoLiveState = {
  turnActive: boolean;
  streamingText: boolean;
  awaitingInput: boolean;
  lastTurnFailed: boolean;
  /** Bumped when a turn ends well; the avatar's happy blip keys on it. */
  finishedCount: number;
  /** The running step in plain words ("Checking PR #12"), while a turn runs. */
  step: string | null;
};

const IDLE: CtoLiveState = {
  turnActive: false,
  streamingText: false,
  awaitingInput: false,
  lastTurnFailed: false,
  finishedCount: 0,
  step: null,
};

type Action =
  | { type: "reset" }
  | { type: "summary"; turnActive: boolean; awaitingInput: boolean }
  | { type: "event"; envelope: AgentChatEventEnvelope };

function patch(state: CtoLiveState, next: Partial<CtoLiveState>): CtoLiveState {
  for (const key of Object.keys(next) as Array<keyof CtoLiveState>) {
    if (state[key] !== next[key]) return { ...state, ...next };
  }
  return state;
}

function reduce(state: CtoLiveState, action: Action): CtoLiveState {
  if (action.type === "reset") return IDLE;
  if (action.type === "summary") {
    return patch(state, { turnActive: action.turnActive, awaitingInput: action.awaitingInput });
  }
  const event = action.envelope.event;
  switch (event.type) {
    case "status":
      if (event.turnStatus === "started") {
        return patch(state, { turnActive: true, streamingText: false, lastTurnFailed: false, step: null });
      }
      return patch(state, { turnActive: false, streamingText: false, step: null });
    case "done":
      if (event.status === "completed") {
        return { ...state, turnActive: false, streamingText: false, step: null, lastTurnFailed: false, finishedCount: state.finishedCount + 1 };
      }
      return patch(state, { turnActive: false, streamingText: false, step: null, lastTurnFailed: event.status === "failed" });
    case "text":
      return patch(state, { turnActive: true, streamingText: true });
    case "tool_call":
      return patch(state, {
        turnActive: true,
        streamingText: false,
        step: ctoStepWords(event.mcp?.tool ?? event.tool, event.args) ?? state.step,
      });
    case "activity":
      return event.activity === "thinking" ? state : patch(state, { turnActive: true, streamingText: false });
    case "approval_request":
    case "structured_question":
      return patch(state, { awaitingInput: true });
    case "pending_input_resolved":
      return patch(state, { awaitingInput: false });
    default:
      return state;
  }
}

/** The event kinds this hook reads; every streaming delta of another kind is skipped before dispatch. */
const LIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "status",
  "done",
  "text",
  "tool_call",
  "activity",
  "approval_request",
  "structured_question",
  "pending_input_resolved",
]);

/**
 * What the CTO is doing right now, for its avatar and the one status phrase.
 *
 * Seeded from the session summary on the CTO's home machine, then kept current
 * from that machine's chat events for this one session. Every call goes to
 * `pin` (the CTO's home), and the effect is keyed on `pin.key`, so a rebuilt
 * pin for the same machine does not resubscribe.
 */
export function useCtoLiveState(sessionId: string | null, pin: OpenProjectBinding | null, active: boolean): CtoLiveState {
  const [state, dispatch] = useReducer(reduce, IDLE);
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!active || !sessionId || !pin) return;
    let cancelled = false;
    void window.ade?.agentChat?.getSummary?.({ sessionId }, pin)
      .then((summary) => {
        if (cancelled || !summary) return;
        dispatch({
          type: "summary",
          turnActive: summary.status === "active" || Boolean(summary.currentTurnStartedAt),
          awaitingInput: summary.awaitingInput === true,
        });
      })
      .catch(() => {});
    const unsubscribe = window.ade?.agentChat?.onEvent?.((envelope) => {
      if (envelope.sessionId !== sessionId || !LIVE_EVENT_TYPES.has(envelope.event.type)) return;
      dispatch({ type: "event", envelope });
    }, pin);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // Keyed on the pin's key, not the object (a rebuilt pin restarts nothing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pinKey, sessionId]);

  return state;
}
