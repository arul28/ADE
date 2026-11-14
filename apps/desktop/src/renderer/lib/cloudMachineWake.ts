import { useSyncExternalStore } from "react";
import { savedChatsMachineKey } from "../../shared/cloudSavedChats";
import { adeCloudLaneComputerForMachine } from "../state/adeCloudLaneIndex";
import { showToast } from "../components/app/toast/toastStore";
import { connectMachine } from "./machineConnect";

/** Wakes in flight, by machine key: a second open of the same computer does not ask again. */
let wakesInFlight: ReadonlySet<string> = new Set<string>();
const listeners = new Set<() => void>();

function setWakeInFlight(machineKey: string, inFlight: boolean): void {
  if (wakesInFlight.has(machineKey) === inFlight) return;
  const next = new Set(wakesInFlight);
  if (inFlight) next.add(machineKey);
  else next.delete(machineKey);
  wakesInFlight = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether an open from a list is waking this ADE Cloud computer now. */
export function useCloudMachineWakeInFlight(machineKey: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (machineKey ? wakesInFlight.has(machineKey) : false));
}

export type RestingCloudMachine = {
  machineId: string;
  machineName: string;
  hostname: string | null;
};

/** The account key of the ADE Cloud computer behind a machine, or null for any other machine. */
export function restingCloudMachineKey(machine: Pick<RestingCloudMachine, "machineId" | "hostname">): string | null {
  // A saved-chats copy names its computer's account key itself, so a cloud
  // computer made without a lane (absent from the lane index) still wakes.
  const savedKey = savedChatsMachineKey(machine.machineId);
  if (savedKey) return savedKey;
  return adeCloudLaneComputerForMachine({ hostname: machine.hostname })?.machineKey ?? null;
}

/**
 * Opening work of an ADE Cloud computer that is asleep or not connected here
 * reaches the computer by its account key (contract C2), which wakes and
 * connects it. Its lanes and chats then come from the computer itself. Any
 * other machine is left alone: nothing here can start it. The opened view
 * shows the progress (`useCloudMachineWakeInFlight`); a failure says why in a
 * toast.
 */
export function wakeRestingCloudMachine(machine: RestingCloudMachine): void {
  const machineKey = restingCloudMachineKey(machine);
  if (!machineKey || wakesInFlight.has(machineKey)) return;
  setWakeInFlight(machineKey, true);
  void connectMachine(machineKey)
    .catch((error: unknown) => {
      showToast({
        title: `Couldn't wake ${machine.machineName}`,
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    })
    .finally(() => setWakeInFlight(machineKey, false));
}
