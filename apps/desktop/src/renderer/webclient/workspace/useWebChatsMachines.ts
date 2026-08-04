/**
 * The Chats page's machine picker, in the browser.
 *
 * Desktop already ships this control: `/chats` runs on whichever machine the
 * window is bound to, and its picker rebinds the window — "This computer" resolving
 * through `chat/thisMachineProjectRoot.ts`. The hosted client keeps the same
 * control and the same meaning, with one substitution: a browser has no "This
 * computer", so the options are the account's machines and rebinding means pointing the
 * federated adapter's chats surface at one of them.
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
};

function entryTargetIds(machine: WebMachineEntry): string[] {
  const ids: string[] = [];
  if (machine.session?.targetId) ids.push(machine.session.targetId);
  if (machine.environment?.envId) ids.push(machine.environment.envId);
  return ids;
}

/** Null on the desktop, where the window's own binding is the picker's subject. */
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
    return {
      machineId: current?.key ?? null,
      machineLabel: current?.name ?? null,
      options: machines.map((machine) => ({ id: machine.key, name: machine.name })),
      select,
    };
  }, [machines, select, workspace]);
}
