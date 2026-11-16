import { useMemo } from "react";
import { isWebClientMode } from "../lib/webClientMode";
import { isAdeCloudComputer, useAdeCloudLaneComputers } from "./adeCloudLaneIndex";
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
  return useMemo(
    () => machines.filter((machine) => !isAdeCloudComputer({ machineKey: machine.accountMachine?.machineKey ?? null }, index)),
    [index, machines],
  );
}

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
