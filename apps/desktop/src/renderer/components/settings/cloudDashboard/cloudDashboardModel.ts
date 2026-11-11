import {
  CLOUD_PLAN_LABELS,
  cloudCatalogOf,
  formatCloudHoursRate,
  type CloudAccountState,
  type CloudDiskUsage,
  type CloudLaneWork,
  type CloudMachine,
} from "../../../../shared/adeCloud";
import type { CloudLaneMachine, CloudLaneWithoutComputer } from "../../../../shared/cloudLaneLaunch";
import { cloudTiers, type CloudTier, type CloudTierId } from "../../../../shared/cloudTiers";

/**
 * The ADE Cloud dashboard's facts, from reads already in memory (the account's
 * computer list and the lanes without a computer). Nothing here wakes a
 * computer: disk parts and work come from the computer's own last report.
 */

/** A lane not used for this long gets the "not used for a long time" mark. */
export const CLOUD_LANE_OLD_MS = 14 * 86_400_000;
/** At this share of the plan's disk, the dashboard warns and offers "Free up space". */
export const CLOUD_DISK_WARN_SHARE = 0.8;

export type DashLaneState = "awake" | "asleep" | "updating" | "starting" | "failed" | "none";

export type DashLane = {
  /** The computer id, or `none:<laneId>` for a lane without a computer. */
  key: string;
  instanceId: string | null;
  name: string;
  tier: CloudTier | null;
  /** 1 (Small) to 4 (X-Large); 1 when the size is unknown. */
  tierRank: number;
  rateLabel: string | null;
  /** The disk it holds against the plan (its size), or 0 for a lane without a computer. */
  diskGb: number;
  state: DashLaneState;
  lastActiveAt: number | null;
  old: boolean;
  usage: CloudDiskUsage | null;
  work: CloudLaneWork | null;
  /** Pull request merged and nothing unpushed, as the computer last read it; null when it hasn't said. */
  safe: boolean | null;
  machine: CloudLaneMachine | null;
  without: CloudLaneWithoutComputer | null;
};

const TIER_RANK: Record<CloudTierId, number> = { small: 1, medium: 2, large: 3, xlarge: 4 };

export function tierOfMachine(machine: CloudMachine, tiers: readonly CloudTier[]): CloudTier | null {
  if (!machine.resources || machine.type === "performance") return null;
  const type = machine.type === "vm" ? "vm" : "default";
  return tiers.find((tier) => tier.type === type && tier.cpu === machine.resources!.cpu && tier.memoryGb === machine.resources!.memoryGb) ?? null;
}

function stateOf(machine: CloudMachine): DashLaneState {
  if (machine.update?.state === "updating") return "updating";
  switch (machine.state) {
    case "running":
      return "awake";
    case "asleep":
    case "stopped":
      return "asleep";
    case "starting":
    case "stopping":
    case "deleting":
      return "starting";
    default:
      return "failed";
  }
}

/** Safe to delete: the pull request is merged and nothing is only on the computer. */
export function laneSafety(work: CloudLaneWork | null | undefined): boolean | null {
  if (!work) return null;
  return work.prState === "merged" && !work.unpushed;
}

/** Every cloud lane: the lane computers first, then the lanes kept without one. */
export function dashLanes(input: {
  machines: readonly CloudLaneMachine[];
  account: CloudAccountState | null;
  without: readonly CloudLaneWithoutComputer[];
  now: number;
}): DashLane[] {
  const tiers = cloudTiers(cloudCatalogOf(input.account));
  const withComputer = input.machines
    .filter((machine) => machine.lane)
    .map((machine): DashLane => {
      const tier = tierOfMachine(machine, tiers);
      const lastActiveAt = machine.lastActiveAtMs ?? null;
      return {
        key: machine.instanceId,
        instanceId: machine.instanceId,
        name: machine.lane?.laneName ?? machine.name ?? machine.instanceId,
        tier,
        tierRank: tier ? TIER_RANK[tier.id] : 1,
        rateLabel: tier ? formatCloudHoursRate(tier.multiplierMilli / 1000) : machine.hoursRate != null ? formatCloudHoursRate(machine.hoursRate) : null,
        diskGb: machine.resources?.diskGb ?? 0,
        state: stateOf(machine),
        lastActiveAt,
        old: lastActiveAt != null ? input.now - lastActiveAt >= CLOUD_LANE_OLD_MS : machine.createdAtMs != null && input.now - machine.createdAtMs >= CLOUD_LANE_OLD_MS,
        usage: machine.diskUsage ?? null,
        work: machine.laneWork ?? null,
        safe: laneSafety(machine.laneWork),
        machine,
        without: null,
      };
    });
  const known = new Set(withComputer.map((lane) => lane.machine?.lane?.laneId));
  const withoutComputer = input.without
    .filter((lane) => !known.has(lane.laneId))
    .map((lane): DashLane => {
      const tier = tiers.find((entry) => entry.type === lane.type && entry.cpu === lane.cpu && entry.memoryGb === lane.memoryGb) ?? null;
      return {
        key: `none:${lane.laneId}`,
        instanceId: null,
        name: lane.laneName,
        tier,
        tierRank: tier ? TIER_RANK[tier.id] : 1,
        rateLabel: tier ? formatCloudHoursRate(tier.multiplierMilli / 1000) : null,
        diskGb: 0,
        state: "none",
        lastActiveAt: null,
        old: false,
        usage: null,
        work: null,
        safe: null,
        machine: null,
        without: lane,
      };
    });
  return [...withComputer, ...withoutComputer];
}

/** The plan's name, for the header tag. */
export function planName(account: CloudAccountState): string {
  if (account.plan === "free") return "Free plan";
  return `${CLOUD_PLAN_LABELS[account.planId ?? "plus"] ?? "Paid"} plan`;
}

/** Percent of a limit used, 0 to 100; 0 for no limit. */
export function percentOf(used: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function formatShortDate(ms: number): string {
  return shortDate.format(new Date(ms));
}

/**
 * "At this pace your hours last until Nov 24", from the hours the meter
 * charged over the last days. Null when the server doesn't send them, or
 * nothing was used (no pace to read).
 */
export function hoursForecast(account: CloudAccountState, now: number): string | null {
  const recent = account.recentUse;
  if (!recent || recent.days <= 0 || recent.usedMilli <= 0) return null;
  const perDay = recent.usedMilli / recent.days;
  const left = account.hours.leftMilli;
  if (left <= 0) return null;
  const endsAt = now + (left / perDay) * 86_400_000;
  if (endsAt >= account.billing.periodEnd) return "At this pace your hours last until they reset";
  return `At this pace your hours last until ${formatShortDate(endsAt)}`;
}

/** "3.4 GB", "820 MB". */
export function formatGb(gb: number): string {
  if (gb > 0 && gb < 1) return `${Math.max(1, Math.round(gb * 1000))} MB`;
  return `${gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/** "2 min ago", "3 h ago", "16 days ago". */
export function formatAgo(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The last-run phrase a lane row shows. */
export function lastRunText(lane: DashLane, now: number): string {
  if (lane.state === "none") return lane.without?.reason === "inactive" ? "Computer removed after 30 days" : "No computer now";
  if (lane.state === "awake") return "Running now";
  if (lane.lastActiveAt == null) return "Not used yet";
  return `Ran ${formatAgo(lane.lastActiveAt, now)}`;
}

export const STATE_LABEL: Record<DashLaneState, string> = {
  awake: "Awake",
  asleep: "Asleep",
  updating: "Updating",
  starting: "Changing",
  failed: "Needs a look",
  none: "No computer",
};

/** Lanes for "Free up space": biggest first, then the longest unused. */
export function cleanupOrder(lanes: readonly DashLane[]): DashLane[] {
  return lanes
    .filter((lane) => lane.instanceId)
    .slice()
    .sort((left, right) => right.diskGb - left.diskGb || (left.lastActiveAt ?? 0) - (right.lastActiveAt ?? 0));
}

/** Whether the person asked for less motion (the OS, or ADE's own setting). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return document.documentElement.dataset.motion === "reduced" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
