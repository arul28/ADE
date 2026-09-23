import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  cancelReconnect,
  readReconnectFlow,
  reconnectAvailable,
  registerReconnectParticipant,
  startReconnect,
  subscribeReconnectFlow,
  type ReconnectThisComputerOptions,
} from "../lib/reconnectThisComputer";
import {
  reconnectActionView,
  type ReconnectActionView,
  type ReconnectOutcome,
} from "../lib/thisComputerRefusal";

/**
 * "Reconnect this computer" for one surface. The flow itself is one per window
 * and lives in `lib/reconnectThisComputer.ts`; this hook subscribes to it and
 * derives the `view` the surface renders, so no two buttons can say or do
 * different things.
 */

export type ReconnectThisComputer = {
  /** False in the hosted web client and on builds without the repair bridge. */
  available: boolean;
  reconnecting: boolean;
  /** The last attempt's outcome, when this surface was on screen for it. */
  outcome: ReconnectOutcome | null;
  reconnect: () => Promise<void>;
  /** The button and line to render, given this surface's idle copy. */
  view: (idle: { label: string; detail?: string }) => ReconnectActionView;
};

/**
 * `reloadMachines` and `isThisMac` come from the instance whose press started
 * the attempt, because they decide its outcome. `onSettled` runs for every
 * mounted instance, so each surface refreshes its own refusal read.
 */
export function useReconnectThisComputer(options: ReconnectThisComputerOptions = {}): ReconnectThisComputer {
  const participant = useRef(options);
  useEffect(() => {
    participant.current = options;
  });
  useEffect(() => registerReconnectParticipant(participant), []);
  const flow = useSyncExternalStore(subscribeReconnectFlow, readReconnectFlow);
  // An outcome is shown only by a surface that was on screen for its attempt.
  // A card opened an hour after a reconnect from the banner must not announce
  // "back on your account" as if it just happened.
  const [lastAttemptBeforeMount] = useState(() => {
    const atMount = readReconnectFlow();
    return atMount.reconnecting ? atMount.attempt - 1 : atMount.attempt;
  });
  const outcome = flow.attempt > lastAttemptBeforeMount ? flow.outcome : null;
  const available = reconnectAvailable();

  const reconnect = useCallback(() => startReconnect(participant.current), []);
  const view = useCallback(
    (idle: { label: string; detail?: string }) =>
      reconnectActionView(
        { reconnecting: flow.reconnecting, signInPrompt: flow.signInPrompt, outcome },
        idle,
        { reconnect: () => void reconnect(), cancel: cancelReconnect },
      ),
    [flow.reconnecting, flow.signInPrompt, outcome, reconnect],
  );

  return {
    available,
    reconnecting: flow.reconnecting,
    outcome,
    reconnect,
    view,
  };
}
