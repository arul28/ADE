import {
  CLOUD_MACHINE_DEFAULT_NAME,
  CLOUD_PLAN_LABELS,
  cloudCatalogOf,
  cloudHoursLeftMilli,
  formatCloudDate,
  formatCloudHoursRate,
  type CloudAccountState,
  type CloudDiskUsage,
  type CloudLaneWork,
  type CloudMachine,
} from "../../../../shared/adeCloud";
import type { CloudLaneMachine, CloudLaneWithoutComputer } from "../../../../shared/cloudLaneLaunch";
import { cloudTierOfMachine, cloudTierRank, cloudTierRateLabel, cloudTiers, type CloudTier } from "../../../../shared/cloudTiers";
import { formatAgo } from "../../../lib/format";

/**
 * The ADE Cloud dashboard's facts, from reads already in memory (the account's
 * computer list and the lanes without a computer). Nothing here wakes a
 * computer: disk parts and work come from the computer's own last report.
 */

/** A lane not used for this long gets the "not used for a long time" mark. */
const CLOUD_LANE_OLD_MS = 14 * 86_400_000;

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
  /** A computer the account pays for that holds no lane (made before lanes had their own computer). */
  noLane: boolean;
};

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
function laneSafety(work: CloudLaneWork | null | undefined): boolean | null {
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
  // Every computer the account pays for: a lane's own, and one that holds no lane.
  const withComputer = input.machines
    .map((machine): DashLane => {
      const tier = cloudTierOfMachine(machine, tiers);
      const lastActiveAt = machine.lastActiveAtMs ?? null;
      return {
        key: machine.instanceId,
        instanceId: machine.instanceId,
        name: machine.lane?.laneName ?? noLaneName(machine),
        tier,
        tierRank: tier ? cloudTierRank(tier.id) : 1,
        rateLabel: tier ? cloudTierRateLabel(tier) : machine.hoursRate != null ? formatCloudHoursRate(machine.hoursRate) : null,
        diskGb: machine.resources?.diskGb ?? 0,
        state: stateOf(machine),
        lastActiveAt,
        old: lastActiveAt != null ? input.now - lastActiveAt >= CLOUD_LANE_OLD_MS : machine.createdAtMs != null && input.now - machine.createdAtMs >= CLOUD_LANE_OLD_MS,
        usage: machine.diskUsage ?? null,
        work: machine.laneWork ?? null,
        safe: laneSafety(machine.laneWork),
        machine,
        without: null,
        noLane: !machine.lane,
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
        tierRank: tier ? cloudTierRank(tier.id) : 1,
        rateLabel: tier ? cloudTierRateLabel(tier) : null,
        diskGb: 0,
        state: "none",
        lastActiveAt: null,
        old: false,
        usage: null,
        work: null,
        safe: null,
        machine: null,
        without: lane,
        noLane: false,
      };
    });
  // Lanes first (awake, then the most recent), then lanes without a computer, then computers with no lane.
  const sorted = withComputer.slice().sort((left, right) => Number(right.state === "awake") - Number(left.state === "awake")
    || (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0));
  return [...sorted.filter((lane) => !lane.noLane), ...withoutComputer, ...sorted.filter((lane) => lane.noLane)];
}

/** A computer with no lane: its own name when ADE gave it one, else its short id. */
function noLaneName(machine: CloudMachine): string {
  const name = machine.name?.trim();
  return name && name !== CLOUD_MACHINE_DEFAULT_NAME ? name : `Computer ${machine.instanceId.slice(0, 6)}`;
}

/** The plan's name, for the header tag. */
export function planName(account: CloudAccountState): string {
  if (account.plan === "free") return "Free plan";
  return `${CLOUD_PLAN_LABELS[account.planId ?? "plus"] ?? "Paid"} plan`;
}

/**
 * "At this pace your hours last until Nov 24", from the hours the meter
 * charged over the last days, counting earned hours (used after the plan's).
 * Null when the server doesn't send them, or nothing was used (no pace to
 * read). Dates are UTC (`formatCloudDate`): the period ends at midnight UTC.
 */
export function hoursForecast(account: CloudAccountState, now: number): string | null {
  const recent = account.recentUse;
  if (!recent || recent.days <= 0 || recent.usedMilli <= 0) return null;
  const perDay = recent.usedMilli / recent.days;
  const left = cloudHoursLeftMilli(account);
  if (left <= 0) return null;
  const endsAt = now + (left / perDay) * 86_400_000;
  if (endsAt >= account.billing.periodEnd) return "At this pace your hours last until they reset";
  return `At this pace your hours last until ${formatCloudDate(endsAt)}`;
}

/** The last-run phrase a lane row shows. */
export function lastRunText(lane: DashLane, now: number): string {
  if (lane.state === "none") {
    const reason = lane.without?.reason;
    if (reason === "inactive") return "Computer removed after 30 days";
    if (reason === "plan_limit") return "Computer removed to fit your plan";
    return "No computer now";
  }
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
