/**
 * Agent37 boxes beside the machine list: which account row is which box, what
 * runs on each one, and what the group costs. Pure functions over data the
 * list already has (account rows, Activity, Agent37's own list).
 */

import {
  formatAgent37HourlyPrice,
  formatAgent37Usd,
  type Agent37Machine,
  type Agent37MachineState,
} from "../../../shared/agent37";
import { buildAccountMachineSnapshot } from "../../../shared/accountMachineSnapshot";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { AttentionItem } from "../../../shared/types/attention";

/**
 * Account row key → its box. A box names its row by `ade_machine_key` (ADE
 * writes it when the box joins); a box made before that, or signed in by hand,
 * is matched by hostname, which on Agent37 is the instance id.
 */
export function matchAgent37Boxes(
  boxes: readonly Agent37Machine[],
  accountMachines: readonly AdeAccountMachine[],
): Map<string, Agent37Machine> {
  const byKey = new Map<string, Agent37Machine>();
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
    const host = machine.name?.trim().toLowerCase() ?? "";
    if (!host) continue;
    const box = boxes.find((candidate) => !taken.has(candidate.instanceId) && candidate.instanceId === host);
    if (box) {
      byKey.set(machine.machineKey, box);
      taken.add(box.instanceId);
    }
  }
  return byKey;
}

export type Agent37BoxWork = {
  /** Lanes with chats on this box, newest first (from account Activity). */
  lanes: Array<{ name: string; projectName: string | null }>;
  /** Chats Activity shows starting or running there right now. */
  runningChats: number;
};

const RUNNING_PHASES = new Set(["starting", "running"]);

/** What account Activity says the box is doing. Last-known for a box that sleeps. */
export function agent37BoxWork(machine: AdeAccountMachine | null, activityItems: readonly AttentionItem[]): Agent37BoxWork {
  if (!machine) return { lanes: [], runningChats: 0 };
  const snapshot = buildAccountMachineSnapshot({ machine, activityItems, recentChatLimit: 200 });
  return {
    lanes: snapshot.lanes,
    runningChats: snapshot.recentChats.filter((chat) => RUNNING_PHASES.has(chat.phase)).length,
  };
}

/** What the box costs per hour in the state it is in now. */
export function agent37CurrentHourlyUsd(box: Agent37Machine): number | null {
  if (box.state === "deleting" || box.state === "error") return null;
  // Suspended time is never billed.
  if (box.pastDue) return 0;
  return box.state === "asleep" || box.state === "stopped" ? box.idleHourlyUsd : box.runningHourlyUsd;
}

/** "0.8¢ an hour" while running; "0.1¢ an hour, disk only" asleep or stopped. */
export function describeAgent37Rate(box: Agent37Machine): string | null {
  const rate = agent37CurrentHourlyUsd(box);
  if (rate == null) return null;
  if (box.pastDue) return "Not billing while suspended";
  const price = formatAgent37HourlyPrice(rate);
  return box.state === "asleep" || box.state === "stopped" ? `${price}, disk only` : price;
}

/** "$0.06 so far" or "$1.20 in 90 days"; null when the spend is unknown. */
export function describeAgent37Spend(box: Agent37Machine): string | null {
  if (box.spentUsd == null) return null;
  return box.spentIsLifetime ? `${formatAgent37Usd(box.spentUsd)} so far` : `${formatAgent37Usd(box.spentUsd)} in 90 days`;
}

export const AGENT37_STATE_LABELS: Record<Agent37MachineState, string> = {
  running: "Running",
  asleep: "Asleep",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  deleting: "Deleting",
  error: "Error",
};

/** The status tag's tone: ok for running, neutral when parked, warn while moving, crit for a failure. */
export function agent37StateTone(box: Agent37Machine): "ok" | "warn" | "crit" | null {
  if (box.pastDue || box.state === "error") return "crit";
  if (box.state === "running") return "ok";
  if (box.state === "starting" || box.state === "stopping" || box.state === "deleting") return "warn";
  return null;
}

export type Agent37GroupTotals = {
  /** What the shown boxes cost per hour right now. */
  hourlyUsd: number;
  /** What they spent in their windows; null when Agent37's usage could not be read. */
  spentUsd: number | null;
  /** What sleeping saved them; null when any box's spend is unknown. */
  savedUsd: number | null;
  running: number;
};

export function agent37GroupTotals(boxes: readonly Agent37Machine[]): Agent37GroupTotals {
  let hourlyUsd = 0;
  let spentUsd: number | null = 0;
  let savedUsd: number | null = 0;
  let running = 0;
  for (const box of boxes) {
    hourlyUsd += agent37CurrentHourlyUsd(box) ?? 0;
    if (box.state === "running" || box.state === "starting") running += 1;
    spentUsd = spentUsd == null || box.spentUsd == null ? null : spentUsd + box.spentUsd;
    savedUsd = savedUsd == null || box.savedUsd == null ? null : savedUsd + box.savedUsd;
  }
  return { hourlyUsd, spentUsd, savedUsd, running };
}

/**
 * How long the wallet lasts at the current rate, as a warning, or null when it
 * is comfortable (more than three days) or unknown.
 */
export function agent37WalletWarning(balanceUsd: number | null, hourlyUsd: number): string | null {
  if (balanceUsd == null || hourlyUsd <= 0) return null;
  if (balanceUsd <= 0) return "Agent 37 suspends these machines at the next hourly settle unless you top it up.";
  const hours = balanceUsd / hourlyUsd;
  if (hours > 72) return null;
  const left = hours < 2 ? "about an hour" : hours < 48 ? `about ${Math.floor(hours)} hours` : `about ${Math.floor(hours / 24)} days`;
  return `Your Agent 37 wallet (${formatAgent37Usd(balanceUsd)}) lasts ${left} at this rate. When it runs out, Agent 37 suspends these machines.`;
}
