import {
  CLOUD_MACHINE_DEFAULT_NAME,
  CLOUD_PLAN_LABELS,
  capitalizeCloudPhrase,
  cloudCatalogOf,
  cloudHoursLeftMilli,
  cloudPlanIdOf,
  formatCloudDate,
  type CloudAccountState,
  type CloudDiskUsage,
  type CloudIdleCleanupEntry,
  type CloudLaneWork,
  type CloudMachine,
} from "../../../../shared/adeCloud";
import type { CloudLaneMachine, CloudLaneWithoutComputer } from "../../../../shared/cloudLaneLaunch";
import { cloudTierHoursAt, cloudTierOfMachine, cloudTierRank, cloudTiers, type CloudTier } from "../../../../shared/cloudTiers";
import { cloudUnitWords, type CloudUnitWords } from "../../../../shared/cloudUnitWords";
import { formatAgo } from "../../../lib/format";

/**
 * The ADE Cloud dashboard's facts, from reads already in memory (the account's
 * computer list and the lanes without a computer). Nothing here wakes a
 * computer: disk parts and work come from the computer's own last report.
 */

/**
 * A size's rate as a label beside its name: "Uses 2.5 hours an hour", or in
 * credits the rate table's shorter words ("2.5 credits an hour", "No credits").
 */
function rateLabelOf(rate: number | null, words: CloudUnitWords): string | null {
  if (rate == null) return null;
  if (words.credits) return rate > 0 ? `${words.count(rate)} an hour` : "No credits";
  return capitalizeCloudPhrase(words.rate(rate));
}

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
  /** The idle cleanup's warning for its computer (or its kept-after-a-failed-save state), else null. */
  idle: CloudIdleCleanupEntry | null;
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
  const words = cloudUnitWords(input.account);
  const idle = new Map((input.account?.dueForDeletion ?? []).map((entry) => [entry.instanceId, entry]));
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
        rateLabel: rateLabelOf(tier ? tier.multiplierMilli / 1000 : machine.hoursRate ?? null, words),
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
        idle: idle.get(machine.instanceId) ?? null,
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
        rateLabel: rateLabelOf(tier ? tier.multiplierMilli / 1000 : null, words),
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
        idle: null,
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
  // Never the computer's id: ADE Cloud names lanes, not computers.
  return name && name !== CLOUD_MACHINE_DEFAULT_NAME ? name : "Computer without a lane";
}

/** The plan's name, for the header tag. */
export function planName(account: CloudAccountState): string {
  if (account.plan === "free") return "Free plan";
  return `${CLOUD_PLAN_LABELS[account.planId ?? "plus"] ?? "Paid"} plan`;
}

/**
 * "At this pace your hours last until Nov 24.", from the hours (or credits)
 * the meter charged over the last days, counting earned ones (used after the
 * plan's). Null when the server doesn't send them, or nothing was used (no
 * pace to read). Dates are UTC (`formatCloudDate`): the period ends at
 * midnight UTC.
 */
export function hoursForecast(account: CloudAccountState, now: number, words: CloudUnitWords = cloudUnitWords(account)): string | null {
  const recent = account.recentUse;
  if (!recent || recent.days <= 0 || recent.usedMilli <= 0) return null;
  // Nothing used yet this period (a plan just bought, a month just reset): no pace to speak of.
  if (account.hours.usedMilli <= 0) return null;
  const perDay = recent.usedMilli / recent.days;
  const left = cloudHoursLeftMilli(account);
  if (left <= 0) return null;
  const endsAt = now + (left / perDay) * 86_400_000;
  if (endsAt >= account.billing.periodEnd) return `At this pace your ${words.noun} last until they reset.`;
  return `At this pace your ${words.noun} last until ${formatCloudDate(endsAt)}.`;
}

/** One part of the hero's bar: what used the plan, or what is left. */
export type HeroBarPart = { key: "computers" | "phone" | "used" | "left"; label: string; milli: number };

/**
 * The hero's balance, as the bar and its legend show it: the whole plan,
 * split by what used it (credits: computers and the iPhone; hours: one used
 * part) and what is left. Thousandths, clamped so the parts fill the plan.
 */
export function heroBalanceParts(account: CloudAccountState, words: CloudUnitWords = cloudUnitWords(account)): HeroBarPart[] {
  const { includedMilli, leftMilli } = account.hours;
  const plan = Math.max(0, includedMilli);
  const left = Math.min(plan, Math.max(0, leftMilli));
  const used = Math.max(0, plan - left);
  if (!words.credits) return [{ key: "used", label: "Used", milli: used }, { key: "left", label: "Left", milli: left }];
  // `phone.creditsUsedMilli` and `hours.usedMilli` count the whole period, past
  // the plan too, while the bar is the plan only. Which credits fell inside
  // the plan isn't known, so the plan's used part is split in proportion to
  // what each used over the period: the parts never go below 0 and always
  // sum to `used` (Computers 600 + iPhone 50 past a 600 plan reads 554 / 46).
  const phoneTotal = Math.max(0, account.phone?.creditsUsedMilli ?? 0);
  const periodTotal = Math.max(phoneTotal, account.hours.usedMilli);
  const phone = periodTotal > 0 ? Math.round((used * phoneTotal) / periodTotal) : 0;
  return [
    { key: "computers", label: "Computers", milli: used - phone },
    { key: "phone", label: "iPhone", milli: phone },
    { key: "left", label: "Left", milli: left },
  ];
}

/**
 * "About 418 iPhone minutes, or 418 hours on a Medium computer.": what the
 * credits left buy, in credits mode only (null in hours mode). The iPhone
 * part only for an account that has it.
 */
export function heroCreditsWorth(account: CloudAccountState, words: CloudUnitWords = cloudUnitWords(account)): string | null {
  if (!words.credits) return null;
  // The plan's own credits left, the hero's big number (earned ones are shown apart).
  const left = Math.max(0, account.hours.leftMilli);
  const medium = cloudTiers(cloudCatalogOf(account)).find((tier) => tier.id === "medium");
  const mediumHours = medium ? cloudTierHoursAt(medium, left).replace(/ h$/, "") : null;
  const onMedium = mediumHours ? `${mediumHours} ${mediumHours === "1" ? "hour" : "hours"} on a Medium computer` : null;
  const phoneOn = account.phone?.access === "on" && words.phoneMilliPerMinute != null;
  const minutes = phoneOn ? Math.floor(left / words.phoneMilliPerMinute!) : null;
  const onPhone = minutes != null ? `${minutes.toLocaleString("en-US")} iPhone ${minutes === 1 ? "minute" : "minutes"}` : null;
  if (onPhone && onMedium) return `About ${onPhone}, or ${onMedium}.`;
  if (onMedium) return `About ${onMedium}.`;
  return onPhone ? `About ${onPhone}.` : null;
}

/** Why a lane has no computer, in a few words (the row's tooltip), or null for one that never had one here. */
export function removedReasonText(lane: DashLane): string | null {
  const reason = lane.without?.reason;
  if (reason === "inactive") return "Removed after 30 days unused";
  if (reason === "idle_cleanup") return "Removed while unused, after its work was pushed";
  if (reason === "plan_limit") return "Removed to fit your plan, after its work was pushed";
  if (reason === "freed") return "Freed to save space";
  return null;
}

/** The last-run phrase a lane row shows: for a lane without a computer, when it went (the reason is the tooltip). */
export function lastRunText(lane: DashLane, now: number): string {
  if (lane.state === "none") {
    const since = lane.without?.since;
    if (since != null && Number.isFinite(since)) return `Removed ${formatAgo(since, now)}`;
    return removedReasonText(lane) ?? "No computer now";
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

/**
 * The hero's period chip: when the plan ends, fails to pay, changes, renews
 * or resets, in that order. `tone` colours the chip; null is the plain one.
 */
export function heroPeriodChip(account: CloudAccountState): { text: string; tone: "warn" | "crit" | null } {
  const { billing } = account;
  const end = formatCloudDate(billing.periodEnd);
  if (billing.cancelAtPeriodEnd) return { text: `Ends ${end}`, tone: "warn" };
  if (billing.notice === "past_due") return { text: "Payment failed", tone: "crit" };
  const nextPlanId = billing.nextPlanId ?? null;
  if (nextPlanId && nextPlanId !== cloudPlanIdOf(account)) return { text: `${CLOUD_PLAN_LABELS[nextPlanId]} from ${end}`, tone: null };
  return { text: `${account.plan === "paid" ? "Renews" : "Resets"} ${end}`, tone: null };
}
