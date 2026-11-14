import { useSyncExternalStore } from "react";
import { savedChatsMachineKey } from "../../shared/cloudSavedChats";
import { adeCloudLaneComputerForMachine } from "../state/adeCloudLaneIndex";
import { showToast } from "../components/app/toast/toastStore";
import { connectMachine } from "./machineConnect";

/**
 * Wakes from a list, by machine key: one under way (a second open of the same
 * computer does not ask again), or why the last one failed.
 */
type ListWake = { readonly state: "waking" } | { readonly state: "failed"; readonly message: string };
const WAKING: ListWake = { state: "waking" };
let listWakes: ReadonlyMap<string, ListWake> = new Map();
const listeners = new Set<() => void>();

function setListWake(machineKey: string, wake: ListWake | null): void {
  if ((listWakes.get(machineKey) ?? null) === wake) return;
  const next = new Map(listWakes);
  if (wake) next.set(machineKey, wake);
  else next.delete(machineKey);
  listWakes = next;
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
  return useSyncExternalStore(subscribe, () => (machineKey ? listWakes.get(machineKey)?.state === "waking" : false));
}

/** Why the last wake from a list of this ADE Cloud computer failed, or null. */
export function useCloudMachineWakeFailure(machineKey: string | null | undefined): string | null {
  return useSyncExternalStore(subscribe, () => {
    const wake = machineKey ? listWakes.get(machineKey) : undefined;
    return wake?.state === "failed" ? wake.message : null;
  });
}

/** Forgets a failed wake from a list: another wake starts, or the computer came online. */
export function clearCloudMachineWakeFailure(machineKey: string): void {
  if (listWakes.get(machineKey)?.state === "failed") setListWake(machineKey, null);
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
 * toast and stays for the opened view (`useCloudMachineWakeFailure`).
 */
export function wakeRestingCloudMachine(machine: RestingCloudMachine): void {
  const machineKey = restingCloudMachineKey(machine);
  if (!machineKey || listWakes.get(machineKey)?.state === "waking") return;
  setListWake(machineKey, WAKING);
  let failure: ListWake | null = null;
  void connectMachine(machineKey)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // The toast has the details; the opened view offers Try again.
      failure = { state: "failed", message: `ADE couldn't wake ${machine.machineName}. Try again.` };
      showToast({ title: `Couldn't wake ${machine.machineName}`, message, tone: "error" });
    })
    .finally(() => setListWake(machineKey, failure));
}
