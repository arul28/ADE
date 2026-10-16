import React, { createContext, useContext } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";

/**
 * How a settings page reaches its machine.
 *
 * - `this`: This computer through the tab's own binding. Preload calls go
 *   unpinned, and plain IPC reaches the same machine.
 * - `pinned`: any other case, including the tab's own machine when that is
 *   another computer. Every runtime call carries `binding`, so no call can fall
 *   through to plain IPC on This computer while the page names another one.
 */
export type SettingsMachineTarget =
  | { kind: "this" }
  | { kind: "pinned"; binding: OpenProjectBinding };

/**
 * Which machine a settings section under "Machines" reads from and writes to.
 *
 * The Settings page renders the same section components for every machine and
 * hands each subtree its machine through this context, the way
 * `ChatRuntimeScope` does for a chat.
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
  /**
   * How runtime calls reach this machine. Null when none can (no checkout of
   * this repo is reachable): only sections that use plain IPC on This computer
   * are rendered then.
   */
  target: SettingsMachineTarget | null;
  /**
   * The pin for pin-aware preload calls, derived from `target`. It keeps its
   * identity while the machine's binding key is unchanged, so effects may key
   * on it (`useSettingsMachinePage`).
   */
  pin: OpenProjectBinding | null;
  /** The physical computer ADE runs on, the only one plain IPC reaches. */
  isThisMachine: boolean;
  /** The machine the project tab is bound to. */
  isActiveBinding: boolean;
  online: boolean;
};

/** A scope whose `pin` always agrees with its `target`. */
export function settingsMachineScope(input: Omit<SettingsMachineScope, "pin">): SettingsMachineScope {
  return { ...input, pin: input.target?.kind === "pinned" ? input.target.binding : null };
}

/**
 * Outside the Machines group (and in tests) a section keeps its default:
 * unpinned calls against the tab's binding, IPC against this computer.
 */
const FALLBACK_SCOPE: SettingsMachineScope = settingsMachineScope({
  machineId: THIS_MACHINE_ID,
  machineName: THIS_MACHINE_NAME,
  target: { kind: "this" },
  isThisMachine: true,
  isActiveBinding: true,
  online: true,
});

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
