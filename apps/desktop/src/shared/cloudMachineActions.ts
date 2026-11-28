/**
 * Sleep, wake, resize, back up and update for one ADE Cloud computer, with the
 * sentence the machine card shows for each result. Shared by the desktop's
 * main process (`cloudMachines.ts`, through its cloud provider) and the web
 * app (through the account server's `/cloud/instances/:id/...` routes), so
 * both say the same thing for the same answer. Delete is not here: the
 * desktop alone runs it, after it checks each lane for work not on GitHub.
 */

import type { CloudInstance } from "../../../account-directory/src/cloud/contract";
import { cloudShape, readCloudComputerLimitDetail, type CloudMachineActionArgs, type CloudMachineActionResult } from "./adeCloud";
import { cloudResourcesOfInstance } from "./cloudMachineOfInstance";
import { BRAND } from "./brand";

/** The calls each side makes for an action. `wake` and `resize` return the computer's status after the call. */
export type CloudMachineLifecycleOps = {
  computer(instanceId: string): Promise<CloudInstance>;
  sleep(instanceId: string): Promise<unknown>;
  /** `origin: "mcp"`: an outside agent asked (the start body's mark). */
  wake(instanceId: string, origin?: "mcp"): Promise<string>;
  /** No `cpu`/`memory`: the size stays as the server has it (a disk-only grow). `origin: "mcp"` as for `wake`. */
  resize(instanceId: string, resources: { cpu?: number; memory?: number; disk?: number }, computerIdle: boolean, origin?: "mcp"): Promise<string>;
  backup(instanceId: string): Promise<unknown>;
  update(instanceId: string): Promise<unknown>;
};

/**
 * A refusal from the server: its sentence, its error code, a disk refusal's
 * reason, and the rest of the server's `error` (a `computer_limit` refusal's
 * `CloudComputerLimitDetail` sits flat on it).
 */
export type CloudMachineRefusal = { message: string; code: string | null; reason: string | null; detail?: unknown };

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
      message: `${BRAND.CLOUD_NAME} takes one backup of a computer every 15 minutes. Try again in a few minutes. It also keeps the last seven nights on its own.`,
    };
  }
  if (code === "out_of_hours" || code === "over_plan_limits") {
    return { ok: false, blocker: code, message };
  }
  // All the plan's computers in use: the card offers the three ways out (free one up, delete a lane, a bigger plan).
  if (code === "computer_limit") {
    return { ok: false, blocker: "computer_limit", message, computerLimit: readCloudComputerLimitDetail(refused.detail) };
  }
  // A disk refusal keeps its reason, so a notice can offer the way out (a bigger size).
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
      return { ok: true, blocker: null, message: "Asleep. It uses no credits until it wakes." };
    case "wake": {
      const status = await ops.wake(instanceId, args.origin === "mcp" ? "mcp" : undefined);
      return {
        ok: true,
        blocker: null,
        message: status === "running" ? `Awake. ${BRAND.NAME} on it is starting.` : `Waking. ${BRAND.CLOUD_NAME} is moving it to a host with room.`,
      };
    }
    case "backup":
      await ops.backup(instanceId);
      return { ok: true, blocker: null, message: `Backed up. ${BRAND.CLOUD_NAME} keeps this one until your next backup, plus the last seven nights.` };
    case "update":
      await ops.update(instanceId);
      return { ok: true, blocker: null, message: "Updating. It restarts and is back in a few minutes." };
    case "resize": {
      const origin = args.origin === "mcp" ? "mcp" : undefined;
      const shape = args.shape === undefined ? null : cloudShape(args.shape);
      const disk = typeof args.disk === "number" && Number.isInteger(args.disk) && args.disk > 0 ? args.disk : null;
      if ((args.shape !== undefined && !shape) || (!shape && disk == null)) return { ok: false, blocker: null, message: "Pick a size." };
      const current = cloudResourcesOfInstance(await ops.computer(instanceId));
      if (!current) return { ok: false, blocker: null, message: `${BRAND.CLOUD_NAME} didn't say how big this computer is, so ${BRAND.NAME} can't resize it.` };
      const growDisk = disk != null && disk > current.diskGb;
      // The server refuses to grow the disk of a running computer unless the person confirmed the restart.
      const computerIdle = growDisk && args.computerIdle === true;
      if (!shape) {
        if (!growDisk) return { ok: true, blocker: null, message: "The disk is already that size." };
        // Same size, bigger disk: the server restarts the computer for it.
        // No size in the request: the server keeps the one it has, never an older read of it.
        const status = await ops.resize(instanceId, { disk }, computerIdle, origin);
        return {
          ok: true,
          blocker: null,
          message: status === "running"
            ? `The disk is ${disk} GB now. ${BRAND.NAME} on it is starting again.`
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
        origin,
      );
      return {
        ok: true,
        blocker: null,
        message: status === "running"
          ? `Resized to ${shape.label}. ${BRAND.NAME} on it is starting again.`
          : `Resizing to ${shape.label}. It is back in a few minutes.`,
      };
    }
    default:
      return null;
  }
}
