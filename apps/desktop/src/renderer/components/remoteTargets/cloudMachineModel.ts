/**
 * cloud boxes beside the machine list: which account row is which box, what
 * runs on each one, and what the group costs. Pure functions over data the
 * list already has (account rows, Activity, the provider's own list).
 */

import {
  formatCloudHourlyPrice,
  formatCloudUsd,
  type CloudMachine,
  type CloudMachineState,
} from "../../../shared/adeCloud";
import { buildAccountMachineSnapshot } from "../../../shared/accountMachineSnapshot";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { AttentionItem } from "../../../shared/types/attention";

/** Whether `box` is the one whose hostname is `host`: on the provider a box's hostname is its instance id. */
function cloudBoxHasHost(box: CloudMachine, host: string | null | undefined): boolean {
  const name = host?.trim().toLowerCase() ?? "";
  return name.length > 0 && box.instanceId.toLowerCase() === name;
}

/**
 * The box behind one machine, by the same rule as `matchCloudBoxes`: its
 * machine key first, then its hostname. For a caller that has one machine and
 * no account rows (a paired connection).
 */
export function cloudBoxForMachine(
  boxes: readonly CloudMachine[],
  machine: { machineKey?: string | null; hostname?: string | null },
): CloudMachine | null {
  const key = machine.machineKey ?? null;
  return (key ? boxes.find((box) => box.machineKey === key) : undefined)
    ?? boxes.find((box) => cloudBoxHasHost(box, machine.hostname))
    ?? null;
}

/**
 * Account row key → its box. A box names its row by `ade_machine_key` (ADE
 * writes it when the box joins); a box made before that, or signed in by hand,
 * is matched by hostname, which on the provider is the instance id.
 */
export function matchCloudBoxes(
  boxes: readonly CloudMachine[],
  accountMachines: readonly AdeAccountMachine[],
): Map<string, CloudMachine> {
  const byKey = new Map<string, CloudMachine>();
  const taken = new Set<string>();
  for (const box of boxes) {
    if (!box.machineKey) continue;
    if (accountMachines.some((machine) => machine.machineKey === box.machineKey)) {
      byKey.set(box.machineKey, box);
      taken.add(box.instanceId);
    }
  }
  for (const machine of accountMachines) {
    if (byKey.has(machine.machineKey)) continue;
    const box = boxes.find((candidate) => !taken.has(candidate.instanceId) && cloudBoxHasHost(candidate, machine.name));
    if (box) {
      byKey.set(machine.machineKey, box);
      taken.add(box.instanceId);
    }
  }
  return byKey;
}

/**
 * Whether an account row is a cloud box that no longer exists: an offline
 * Linux row named by the id of an instance that spent in the workspace and is
 * gone from it (a box's hostname is its instance id until someone renames
 * it). That is a box deleted on the provider site, whose row stays on the
 * account until someone removes it. Pass the ids from a list that was read.
 */
export function isDeletedCloudRow(
  machine: AdeAccountMachine,
  deletedInstanceIds: readonly string[],
): boolean {
  if (machine.online || machine.platform?.toLowerCase() !== "linux") return false;
  const host = machine.name?.trim().toLowerCase() ?? "";
  return host.length > 0 && deletedInstanceIds.includes(host);
}

export type CloudBoxWork = {
  /** Lanes with chats on this box, newest first (from account Activity). */
  lanes: Array<{ name: string; projectName: string | null }>;
  /** Chats Activity shows starting or running there right now. */
  runningChats: number;
};

const RUNNING_PHASES = new Set(["starting", "running"]);

/** What account Activity says the box is doing. Last-known for a box that sleeps. */
export function cloudBoxWork(machine: AdeAccountMachine | null, activityItems: readonly AttentionItem[]): CloudBoxWork {
  if (!machine) return { lanes: [], runningChats: 0 };
  const snapshot = buildAccountMachineSnapshot({ machine, activityItems, recentChatLimit: 200 });
  return {
    lanes: snapshot.lanes,
    runningChats: snapshot.recentChats.filter((chat) => RUNNING_PHASES.has(chat.phase)).length,
  };
}

/** What the box costs per hour in the state it is in now. */
function cloudCurrentHourlyUsd(box: CloudMachine): number | null {
  if (box.state === "deleting" || box.state === "error") return null;
  // Suspended time is never billed.
  if (box.pastDue) return 0;
  return box.state === "asleep" || box.state === "stopped" ? box.idleHourlyUsd : box.runningHourlyUsd;
}

/** "0.8¢ an hour" while running; "0.1¢ an hour, disk only" asleep or stopped. */
export function describeCloudRate(box: CloudMachine): string | null {
  const rate = cloudCurrentHourlyUsd(box);
  if (rate == null) return null;
  if (box.pastDue) return "Not billing while suspended";
  const price = formatCloudHourlyPrice(rate);
  return box.state === "asleep" || box.state === "stopped" ? `${price}, disk only` : price;
}

/** "$0.06 so far" or "$1.20 in 90 days"; null when the spend is unknown. */
export function describeCloudSpend(box: CloudMachine): string | null {
  if (box.spentUsd == null) return null;
  return box.spentIsLifetime ? `${formatCloudUsd(box.spentUsd)} so far` : `${formatCloudUsd(box.spentUsd)} in 90 days`;
}

export const CLOUD_STATE_LABELS: Record<CloudMachineState, string> = {
  running: "Running",
  asleep: "Asleep",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  deleting: "Deleting",
  error: "Error",
};

/** The status tag's tone: ok for running, neutral when parked, warn while moving, crit for a failure. */
export function cloudStateTone(box: CloudMachine): "ok" | "warn" | "crit" | null {
  if (box.pastDue || box.state === "error") return "crit";
  if (box.state === "running") return "ok";
  if (box.state === "starting" || box.state === "stopping" || box.state === "deleting") return "warn";
  return null;
}

export type CloudGroupTotals = {
  /** What the shown boxes cost per hour right now. */
  hourlyUsd: number;
  /** What they spent in their windows; null when the provider's usage could not be read. */
  spentUsd: number | null;
  /** What sleeping saved them; null when any box's spend is unknown. */
  savedUsd: number | null;
  running: number;
};

export function cloudGroupTotals(boxes: readonly CloudMachine[]): CloudGroupTotals {
  let hourlyUsd = 0;
  let spentUsd: number | null = 0;
  let savedUsd: number | null = 0;
  let running = 0;
  for (const box of boxes) {
    hourlyUsd += cloudCurrentHourlyUsd(box) ?? 0;
    if (box.state === "running" || box.state === "starting") running += 1;
    spentUsd = spentUsd == null || box.spentUsd == null ? null : spentUsd + box.spentUsd;
    savedUsd = savedUsd == null || box.savedUsd == null ? null : savedUsd + box.savedUsd;
  }
  return { hourlyUsd, spentUsd, savedUsd, running };
}

