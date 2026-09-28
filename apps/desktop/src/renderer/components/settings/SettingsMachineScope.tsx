import React, { createContext, useContext } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";

/**
 * Which machine a settings section under "Machines" reads from and writes to.
 *
 * The Settings page renders the same section components for every machine and
 * hands each subtree its machine through this context, the way
 * `ChatRuntimeScope` does for a chat. A section that supports it passes `pin`
 * to its preload calls; `pin === null` means the tab's own binding, exactly as
 * before this existed.
 *
 * The one rule a section must keep: a plain-IPC call (one that is not a runtime
 * action) always reaches the main process of the computer ADE is running on.
 * It is only correct when `isThisMachine` is true. Everywhere else it would
 * read or write This computer's value while the page says another machine.
 */
export type SettingsMachineScope = {
  machineId: string;
  /** Absolute machine name. Never "remote". */
  machineName: string;
  /** Pass to pin-aware preload calls. Null = the tab's binding. */
  pin: OpenProjectBinding | null;
  /** The physical computer ADE runs on — the only one plain IPC reaches. */
  isThisMachine: boolean;
  /** The machine the project tab is bound to. */
  isBound: boolean;
  online: boolean;
};

/**
 * Outside the Machines group (and in tests) a section behaves as it always
 * did: unpinned calls against the tab's binding, IPC against this computer.
 */
const FALLBACK_SCOPE: SettingsMachineScope = {
  machineId: THIS_MACHINE_ID,
  machineName: THIS_MACHINE_NAME,
  pin: null,
  isThisMachine: true,
  isBound: true,
  online: true,
};

const SettingsMachineScopeContext = createContext<SettingsMachineScope | null>(null);

export function SettingsMachineScopeProvider({
  scope,
  children,
}: {
  scope: SettingsMachineScope;
  children: React.ReactNode;
}) {
  return (
    <SettingsMachineScopeContext.Provider value={scope}>{children}</SettingsMachineScopeContext.Provider>
  );
}

export function useSettingsMachineScope(): SettingsMachineScope {
  return useContext(SettingsMachineScopeContext) ?? FALLBACK_SCOPE;
}
