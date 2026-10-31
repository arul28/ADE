import { formatBytes } from "../../lib/format";
import type { MachineStats } from "../../../shared/types/machineStats";
import type { LaneMachineOption } from "./laneMachines";

/** "CPU 8% · 21 GB memory free · 2 builds · On battery" — what a machine is doing now; null before it answers. */
export function machineLoadSummary(stats: MachineStats | null | undefined): string | null {
  if (!stats) return null;
  const builds = stats.builds?.reduce((sum, build) => sum + build.count, 0) ?? 0;
  return [
    stats.cpu.busyPercent != null ? `CPU ${stats.cpu.busyPercent}%` : null,
    `${formatBytes(stats.memory.availableBytes)} memory free`,
    builds > 0 ? (builds === 1 ? "1 build" : `${builds} builds`) : null,
    stats.power?.onBattery ? "On battery" : null,
  ].filter(Boolean).join(" · ");
}

/** The sub-line of a "Least loaded" choice: which machine and why. */
export function autoPickSummary(machine: LaneMachineOption): string {
  const stats = machine.stats;
  if (!stats) return `Picks ${machine.name} right now`;
  const why = [
    stats.cpu.busyPercent != null ? `CPU ${stats.cpu.busyPercent}%` : null,
    `${formatBytes(stats.memory.availableBytes)} free`,
    machine.preference === "prefer" ? "preferred" : null,
  ].filter(Boolean).join(", ");
  return `Picks ${machine.name} · ${why}`;
}

/** "Manual only" / "Preferred" / "Less often" beside a machine; null for Normal. */
export function placementTag(machine: Pick<LaneMachineOption, "preference">): string | null {
  if (machine.preference === "manual") return "Manual only";
  if (machine.preference === "prefer") return "Preferred";
  if (machine.preference === "less-often") return "Less often";
  return null;
}
