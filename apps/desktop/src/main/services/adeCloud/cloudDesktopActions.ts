/**
 * What only a desktop can do for the provider, for a brain to ask over the desktop
 * bridge (`cloud.*`): make, copy and move machines, which sign the new
 * machine in through this app's approval window, and nudge the ready-machine
 * keeper after the CLI changed a project's choice. `registerCloudIpc` fills
 * it in; unset, the bridge answers that this desktop can't.
 */

import type { CloudCreateMachineArgs, CloudCreateMachineResult, CloudMachineKind, CloudShapeId } from "../../../shared/adeCloud";
import type { CloudReadyStatus } from "../../../shared/cloudReady";
import type { CloudMoveResult } from "./cloudMachineCopy";

export type CloudDesktopActions = {
  create(args: CloudCreateMachineArgs & { madeByChat?: string | null }): Promise<CloudCreateMachineResult>;
  copy(args: { instanceId: string; name?: string | null; shape?: CloudShapeId | null; madeByChat?: string | null }): Promise<CloudCreateMachineResult & { copiedFrom: string; forkMs: number }>;
  move(args: { instanceId: string; machineKey?: string | null; to: CloudMachineKind; shape?: CloudShapeId | null; madeByChat?: string | null }): Promise<CloudMoveResult>;
  readyRefresh(): Promise<CloudReadyStatus>;
};

let actions: CloudDesktopActions | null = null;

export function setCloudDesktopActions(next: CloudDesktopActions | null): void {
  actions = next;
}

export function cloudDesktopActions(): CloudDesktopActions | null {
  return actions;
}
