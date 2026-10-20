/**
 * The Chats page's machines, in the browser.
 *
 * The Chats rail lists the chats of every live machine at once
 * (`liveMachines`, by target id). The picker beside the composer chooses where
 * a new chat runs; a browser has no "This computer", so its options are the
 * account's machines, and picking one points the federated adapter's chats
 * surface at it.
 *
 * Options are keyed by `machineCatalogKey`, not by target id, because a machine
 * this browser has never dialled has no target id yet. Selecting one connects
 * it first and hands the resolved target to `activateChats`.
 */

import { useCallback, useMemo } from "react";
import { useOptionalWebWorkspace, useWebMachines } from "./WebWorkspaceContext";
import type { WebMachineEntry } from "./webWorkspaceModel";

export type WebChatsMachineOption = { id: string; name: string };

export type WebChatsMachinePicker = {
  /** `machineCatalogKey` of the machine the Chats surface is addressing. */
  machineId: string | null;
  machineLabel: string | null;
  options: WebChatsMachineOption[];
  /** Resolves to an error message, or null when the switch landed. */
  select(machineId: string): Promise<string | null>;
  /** Target id of the machine the Chats surface addresses: where a new chat runs. */
  targetId: string | null;
  /** Every connected machine by target id: the Chats rail lists all of their chats. */
  liveMachines: Array<{ id: string; name: string }>;
};

function entryTargetIds(machine: WebMachineEntry): string[] {
  const ids: string[] = [];
  if (machine.session?.targetId) ids.push(machine.session.targetId);
  if (machine.environment?.envId) ids.push(machine.environment.envId);
  return ids;
}

/** Null on the desktop, which lists This computer and its connected remote runtimes instead. */
export function useWebChatsMachines(): WebChatsMachinePicker | null {
  const workspace = useOptionalWebWorkspace();

  const machines = useWebMachines();

  const select = useCallback(async (machineId: string): Promise<string | null> => {
    if (!workspace) return null;
    const machine = machines.find((entry) => entry.key === machineId);
    if (!machine) return "That machine is no longer on this account.";
    try {
      const targetId = await workspace.connectMachineEntry(machine);
      await workspace.adapter.activateChats(targetId);
      return null;
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }
  }, [machines, workspace]);

  return useMemo(() => {
    if (!workspace) return null;
    // The chats surface names its own target; a chats route reached while a
    // project tab is still bound addresses that tab's machine instead.
    const targetId = workspace.adapter.getSelectedChatsTargetId()
      ?? workspace.adapter.getActiveBinding()?.targetId
      ?? null;
    const current = targetId
      ? machines.find((machine) => entryTargetIds(machine).includes(targetId)) ?? null
      : null;
    const liveMachines: Array<{ id: string; name: string }> = [];
    for (const machine of machines) {
      const liveTargetId = machine.status === "live" ? machine.session?.targetId : null;
      if (liveTargetId && !liveMachines.some((entry) => entry.id === liveTargetId)) {
        liveMachines.push({ id: liveTargetId, name: machine.name });
      }
    }
    // The addressed machine is connected even before its row reads "live".
    if (targetId && current && !liveMachines.some((entry) => entry.id === targetId)) {
      liveMachines.unshift({ id: targetId, name: current.name });
    }
    return {
      machineId: current?.key ?? null,
      machineLabel: current?.name ?? null,
      options: machines.map((machine) => ({ id: machine.key, name: machine.name })),
      select,
      targetId,
      liveMachines,
    };
  }, [machines, select, workspace]);
}
