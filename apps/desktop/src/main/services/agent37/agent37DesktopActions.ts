/**
 * What only a desktop can do for Agent 37, for a brain to ask over the desktop
 * bridge (`agent37.*`): make, copy and move machines, which sign the new
 * machine in through this app's approval window, and nudge the ready-machine
 * keeper after the CLI changed a project's choice. `registerAgent37Ipc` fills
 * it in; unset, the bridge answers that this desktop can't.
 */

import type { Agent37CreateMachineArgs, Agent37CreateMachineResult, Agent37MachineKind, Agent37ShapeId } from "../../../shared/agent37";
import type { Agent37ReadyStatus } from "../../../shared/agent37Ready";
import type { Agent37MoveResult } from "./agent37MachineCopy";

export type Agent37DesktopActions = {
  create(args: Agent37CreateMachineArgs & { madeByChat?: string | null }): Promise<Agent37CreateMachineResult>;
  copy(args: { instanceId: string; name?: string | null; shape?: Agent37ShapeId | null; madeByChat?: string | null }): Promise<Agent37CreateMachineResult & { copiedFrom: string; forkMs: number }>;
  move(args: { instanceId: string; machineKey?: string | null; to: Agent37MachineKind; shape?: Agent37ShapeId | null; madeByChat?: string | null }): Promise<Agent37MoveResult>;
  readyRefresh(): Promise<Agent37ReadyStatus>;
};

let actions: Agent37DesktopActions | null = null;

export function setAgent37DesktopActions(next: Agent37DesktopActions | null): void {
  actions = next;
}

export function agent37DesktopActions(): Agent37DesktopActions | null {
  return actions;
}
