/**
 * What only a desktop can do for the provider, for a brain to ask over the desktop
 * bridge (`cloud.*`): make, copy and move machines, which sign the new
 * machine in through this app's approval window. `registerCloudIpc` fills
 * it in; unset, the bridge answers that this desktop can't.
 */

import type { CloudAgentMaker, CloudCreateMachineArgs, CloudCreateMachineResult, CloudMachineKind, CloudShapeId } from "../../../shared/adeCloud";
import type { CloudMoveResult } from "./cloudMachineCopy";
import type { CloudApprovalMode, CloudApprovalWindowResult } from "./cloudMachineCreator";

/** A brain's request to sign a new machine in through this app's approval window (a lane launch's join). */
export type CloudApprovalWindowRequest = { id: string; url: string; mode: CloudApprovalMode; title: string };

/** Who asked for a new machine over the bridge: written on it, so the agents' daily limit counts it. */
export type CloudMadeBy = { madeByChat?: string | null; madeByAgent?: CloudAgentMaker | null };

export type CloudDesktopActions = {
  create(args: CloudCreateMachineArgs & CloudMadeBy): Promise<CloudCreateMachineResult>;
  copy(args: { instanceId: string; name?: string | null; shape?: CloudShapeId | null } & CloudMadeBy): Promise<CloudCreateMachineResult & { copiedFrom: string; forkMs: number }>;
  move(args: { instanceId: string; machineKey?: string | null; to: CloudMachineKind; shape?: CloudShapeId | null } & CloudMadeBy): Promise<CloudMoveResult>;
  /**
   * Opens the approval window for a machine a brain is signing in, the way
   * this app's own creates do, and answers how it ended. `closeApprovalWindow`
   * with the same id closes it (the machine signed in another way, or the
   * launch was cancelled).
   */
  approveWindow(args: CloudApprovalWindowRequest): Promise<CloudApprovalWindowResult>;
  closeApprovalWindow(args: { id: string }): void;
};

let actions: CloudDesktopActions | null = null;

export function setCloudDesktopActions(next: CloudDesktopActions | null): void {
  actions = next;
}

export function cloudDesktopActions(): CloudDesktopActions | null {
  return actions;
}
