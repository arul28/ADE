/**
 * Sleep, wake, resize, back up and update for one ADE Cloud computer, with the
 * sentence the machine card shows for each result. Shared by the desktop's
 * main process (`cloudMachines.ts`, through its cloud provider) and the web
 * app (through the account server's `/cloud/instances/:id/...` routes), so
 * both say the same thing for the same answer. Delete is not here: the
 * desktop alone runs it, after it checks each lane for work not on GitHub.
 */

import type { CloudInstance } from "../../../account-directory/src/cloud/contract";
import { cloudShape, type CloudMachineActionArgs, type CloudMachineActionResult } from "./adeCloud";
import { cloudResourcesOfInstance } from "./cloudMachineOfInstance";

/** The calls each side makes for an action. `wake` and `resize` return the computer's status after the call. */
export type CloudMachineLifecycleOps = {
  computer(instanceId: string): Promise<CloudInstance>;
  sleep(instanceId: string): Promise<unknown>;
  wake(instanceId: string): Promise<string>;
  resize(instanceId: string, resources: { cpu: number; memory: number; disk?: number }, computerIdle: boolean): Promise<string>;
  backup(instanceId: string): Promise<unknown>;
  update(instanceId: string): Promise<unknown>;
};

/** A refusal from the server: its sentence, its error code, and a disk refusal's reason. */
export type CloudMachineRefusal = { message: string; code: string | null; reason: string | null };

/** The sentence and the way out for a refused action: plans and hours, the backup window, a disk refusal's reason. */
export function cloudMachineRefusal(
  action: CloudMachineActionArgs["action"],
  refused: CloudMachineRefusal,
): CloudMachineActionResult {
  const { message, code } = refused;
  if (code === "rate_limited" && action === "backup") {
    return {
      ok: false,
      blocker: "rate_limited",
      message: "ADE Cloud takes one backup of a computer every 15 minutes. Try again in a few minutes. It also keeps the last seven nights on its own.",
    };
  }
  if (code === "out_of_hours" || code === "over_plan_disk" || code === "over_plan_limits") {
    return { ok: false, blocker: code, message };
  }
  // A disk refusal keeps its reason, so a notice can offer the way out (extra disk, a bigger size).
  const reason = code === "disk_limit" || code === "needs_paid_plan"
    ? refused.reason ?? (code === "needs_paid_plan" ? "plan_disk" : null)
    : null;
  return reason
    ? { ok: false, blocker: null, message, diskRefusal: { reason } }
    : { ok: false, blocker: null, message };
}

/**
 * Runs a lifecycle action. Returns null for an action this does not run
 * (`delete`), so the caller handles it. A thrown error goes to the caller,
 * which logs it and maps it with `cloudMachineRefusal`.
 */
export async function runCloudMachineLifecycleAction(
  ops: CloudMachineLifecycleOps,
  instanceId: string,
  args: CloudMachineActionArgs,
): Promise<CloudMachineActionResult | null> {
  switch (args.action) {
    case "sleep":
      await ops.sleep(instanceId);
      return { ok: true, blocker: null, message: "Asleep. It uses no hours until it wakes." };
    case "wake": {
      const status = await ops.wake(instanceId);
      return {
        ok: true,
        blocker: null,
        message: status === "running" ? "Awake. ADE on it is starting." : "Waking. ADE Cloud is moving it to a host with room.",
      };
    }
    case "backup":
      await ops.backup(instanceId);
      return { ok: true, blocker: null, message: "Backed up. ADE Cloud keeps this one until your next backup, plus the last seven nights." };
    case "update":
      await ops.update(instanceId);
      return { ok: true, blocker: null, message: "Updating. It restarts and is back in a few minutes." };
    case "resize": {
      const shape = args.shape === undefined ? null : cloudShape(args.shape);
      const disk = typeof args.disk === "number" && Number.isInteger(args.disk) && args.disk > 0 ? args.disk : null;
      if ((args.shape !== undefined && !shape) || (!shape && disk == null)) return { ok: false, blocker: null, message: "Pick a size." };
      const current = cloudResourcesOfInstance(await ops.computer(instanceId));
      if (!current) return { ok: false, blocker: null, message: "ADE Cloud didn't say how big this computer is, so ADE can't resize it." };
      const growDisk = disk != null && disk > current.diskGb;
      // The server refuses to grow the disk of a running computer unless the person confirmed the restart.
      const computerIdle = growDisk && args.computerIdle === true;
      if (!shape) {
        if (!growDisk) return { ok: true, blocker: null, message: "The disk is already that size." };
        // Same size, bigger disk: the server restarts the computer for it.
        const status = await ops.resize(instanceId, { cpu: current.cpu, memory: current.memoryGb, disk }, computerIdle);
        return {
          ok: true,
          blocker: null,
          message: status === "running"
            ? `The disk is ${disk} GB now. ADE on it is starting again.`
            : `Growing the disk to ${disk} GB. The computer restarts and is back in a few minutes.`,
        };
      }
      if (current.cpu === shape.cpu && current.memoryGb === shape.memoryGb && !growDisk) {
        return { ok: true, blocker: null, message: "It's already that size." };
      }
      const status = await ops.resize(
        instanceId,
        { cpu: shape.cpu, memory: shape.memoryGb, ...(growDisk ? { disk } : {}) },
        computerIdle,
      );
      return {
        ok: true,
        blocker: null,
        message: status === "running"
          ? `Resized to ${shape.label}. ADE on it is starting again.`
          : `Resizing to ${shape.label}. It is back in a few minutes.`,
      };
    }
    default:
      return null;
  }
}
