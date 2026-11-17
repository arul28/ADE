import { useEffect, useMemo } from "react";
import { isWebClientMode } from "../lib/webClientMode";
import { isAdeCloudComputer, useAdeCloudLaneComputers } from "./adeCloudLaneIndex";
import { refreshCloudMachines } from "../components/remoteTargets/useCloudMachines";
import { useOptionalWebWorkspace, useWebMachines } from "../webclient/workspace/WebWorkspaceContext";
import type { WebMachineEntry } from "../webclient/workspace/webWorkspaceModel";

/**
 * The machines of the account that are the person's own computers: every
 * web machine row that is not one of the account's ADE Cloud computers.
 * Empty on the desktop (the desktop is a computer of its own).
 */
export function useOwnWebComputers(): WebMachineEntry[] {
  const machines = useWebMachines();
  const index = useAdeCloudLaneComputers();
  const own = useMemo(
    () => machines.filter((machine) =>
      // A machine this browser only remembers (no longer on the account) counts while it is connected.
      (!machine.rememberedOnly || machine.status === "live")
      && !isAdeCloudComputer({ machineKey: machine.accountMachine?.machineKey ?? null }, index)),
    [index, machines],
  );
  // A cloud computer made since the last read of the account's computers (a
  // launch from this page, the phone, another window) is not in the index yet
  // and would count as the person's own: read the list again, once per key.
  useEffect(() => {
    let unseen = false;
    for (const machine of own) {
      const key = machine.accountMachine?.machineKey?.trim();
      if (!key || checkedMachineKeys.has(key)) continue;
      checkedMachineKeys.add(key);
      unseen = true;
    }
    if (unseen) refreshCloudMachines();
  }, [own]);
  return own;
}

/** Machine keys the account's cloud computers were read again for (`useOwnWebComputers`). */
const checkedMachineKeys = new Set<string>();

/**
 * Whether the person has a computer of their own on this client: always on
 * the desktop; on the web, a machine of the account that is not ADE Cloud.
 * Features that run on such a computer (a chat with no project) hide
 * without one; nothing says a computer is needed.
 */
export function useHasOwnComputer(): boolean {
  const workspace = useOptionalWebWorkspace();
  const own = useOwnWebComputers();
  if (!isWebClientMode() || !workspace) return true;
  return own.length > 0;
}
