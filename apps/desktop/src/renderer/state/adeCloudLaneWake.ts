/**
 * Doing something on a lane whose ADE Cloud computer is asleep: start the
 * wake, show "Waking your ADE Cloud computer…" on that lane, and run the
 * action once the computer is connected. The caller never waits for the
 * wake (`machines.connect` is never awaited in the UI).
 *
 * Reads never come here: a resting lane reads from the account
 * (`shared/adeCloud/accountReader.ts`) and wakes nothing.
 */

import { useCallback } from "react";
import type { MachineAddress } from "../../shared/machineAddress";
import type { OpenProjectBinding } from "../../shared/types/core";
import {
  clearCloudMachineWakeFailure,
  restingCloudMachineKey,
  useCloudMachineWakeFailure,
  useCloudMachineWakeInFlight,
  wakeRestingCloudMachine,
} from "../lib/cloudMachineWake";
import { rootAppStoreApi } from "./appStore";
import { savedChatLocationForSession } from "./cloudSavedChats";

export type AdeCloudLaneWakeState = "idle" | "waking" | "failed";

/** The account key of the ADE Cloud computer a lane pin names, or null for any other machine. */
export function adeCloudLaneMachineKey(pin: OpenProjectBinding | null | undefined): string | null {
  if (pin?.kind !== "remote") return null;
  return restingCloudMachineKey({ machineId: pin.targetId, hostname: pin.hostname ?? null });
}

/**
 * Starts the wake of the lane's computer and returns at once. `intent` runs
 * with the computer's address when it is connected. False when the pin is not
 * an ADE Cloud computer (the caller does the action the usual way).
 */
export function wakeAdeCloudLane(
  pin: OpenProjectBinding | null | undefined,
  intent?: (address: MachineAddress) => void,
): boolean {
  if (pin?.kind !== "remote") return false;
  const machineKey = adeCloudLaneMachineKey(pin);
  if (!machineKey) return false;
  clearCloudMachineWakeFailure(machineKey);
  wakeRestingCloudMachine({ machineId: pin.targetId, machineName: "your ADE Cloud computer", hostname: pin.hostname ?? null }, intent);
  return true;
}

/**
 * Where a chat on an ADE Cloud computer can move from: "resting" when its
 * computer is asleep (a move wakes it first, then the usual handoff runs),
 * "gone" when its computer was removed (a message continues the chat on a new
 * computer through the account queue), null for a computer that is connected
 * or any other machine (the usual handoff).
 */
export function adeCloudMoveSource(
  pin: OpenProjectBinding | null | undefined,
  sessionId: string,
): "resting" | "gone" | null {
  if (pin?.kind !== "remote") return null;
  const entry = rootAppStoreApi.getState().crossMachineLanesByMachineId[pin.targetId] ?? null;
  if (entry?.online === true) return null;
  if (entry?.computerGone === true || savedChatLocationForSession(sessionId)?.computerGone === true) return "gone";
  return adeCloudLaneMachineKey(pin) ? "resting" : null;
}

/**
 * The wake of one lane's ADE Cloud computer, for the lane's surfaces. Keyed on
 * the pin's key, so a rebuilt pin does not restart anything.
 */
export function useAdeCloudLaneWake(pin: OpenProjectBinding | null | undefined): {
  state: AdeCloudLaneWakeState;
  /** Why the last wake failed; null otherwise. */
  message: string | null;
  /** Starts the wake (never awaited); `intent` runs once the computer is connected. */
  wake: (intent?: (address: MachineAddress) => void) => boolean;
} {
  const machineKey = adeCloudLaneMachineKey(pin);
  const waking = useCloudMachineWakeInFlight(machineKey);
  const failure = useCloudMachineWakeFailure(machineKey);
  const pinKey = pin?.key ?? null;
  const wake = useCallback(
    (intent?: (address: MachineAddress) => void) => wakeAdeCloudLane(pin, intent),
    // The pin's key names the lane's machine; a rebuilt pin with the same key is the same wake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pinKey],
  );
  return {
    state: waking ? "waking" : failure ? "failed" : "idle",
    message: failure,
    wake,
  };
}
