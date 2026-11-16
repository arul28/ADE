/**
 * ADE Cloud's prices and plan rules for the website (`/pricing`, the home
 * page teaser, the invite page). Every number comes from the account
 * directory's own source, the one the server bills with and the desktop
 * shows: `plans.ts` (plans, sizes, extra disk) and `contract.ts` (the free
 * plan's rules, invites, idle cleanup). Nothing here is typed by hand.
 *
 * Both files are plain data with no Worker code, so the site bundles only
 * the values it uses. `vercel.json`'s ignore step watches them too, so a
 * price change redeploys the site.
 */
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  CLOUD_IDLE_CLEANUP_DAYS,
  CLOUD_REFERRAL_ENTER_DAYS,
  CLOUD_REFERRAL_REWARD_LIMIT,
  CLOUD_REFERRAL_REWARD_MILLI,
  type CloudPlanId,
  type CloudTierId,
} from "../../../account-directory/src/cloud/contract";
import { CLOUD_PLANS, DISK_ON_CREATE_GB, EXTRA_DISK_CENTS_PER_10GB_MONTH, cloudCatalog } from "../../../account-directory/src/cloud/plans";

/** The disk each new computer takes from the plan's shared disk. */
export const COMPUTER_START_DISK_GB = DISK_ON_CREATE_GB;

/** Hours are kept in thousandths of a Small-hour. */
const hoursOf = (milli: number): number => Math.round(milli / 1000);

export type PricingPlan = {
  id: CloudPlanId;
  name: string;
  priceUsd: number;
  hours: number;
  diskGb: number;
  phoneMinutes: number;
  /** What an hour past the plan's costs, or null on Free, where work stops. */
  extraHourCents: number | null;
  /** Days an unused computer is kept before ADE cleans it up. */
  idleDays: number;
  /** One short line on who the plan is for. */
  pitch: string;
};

const PLAN_NAMES: Record<CloudPlanId, string> = { free: "Free", plus: "Plus", pro: "Pro", max: "Max" };
const PLAN_PITCHES: Record<CloudPlanId, string> = {
  free: "Try your agents in the cloud.",
  plus: "A few lanes, most days.",
  pro: "Agents working all day.",
  max: "A whole team of agents.",
};

export const PRICING_PLANS: readonly PricingPlan[] = (["free", "plus", "pro", "max"] as const).map((id) => {
  const plan = CLOUD_PLANS[id];
  return {
    id,
    name: PLAN_NAMES[id],
    priceUsd: plan.priceUsd,
    hours: hoursOf(plan.includedMilli),
    diskGb: plan.diskGb,
    phoneMinutes: plan.phoneMinutes,
    extraHourCents: plan.extraHourCents,
    idleDays: id === "free" ? CLOUD_IDLE_CLEANUP_DAYS.free : CLOUD_IDLE_CLEANUP_DAYS.paid,
    pitch: PLAN_PITCHES[id],
  };
});


export const FREE_PLAN = PRICING_PLANS[0]!;

/** Days an unused computer is kept on every paid plan. */
export const PAID_IDLE_DAYS = CLOUD_IDLE_CLEANUP_DAYS.paid;

export type PricingSize = {
  id: CloudTierId;
  label: string;
  cpu: number;
  memoryGb: number;
  diskMaxGb: number;
  /** Small-hours one hour awake uses: 1, 2, 5, 8. */
  rate: number;
  /** A full computer: Docker and the Android emulator. */
  full: boolean;
  use: string;
};

const SIZE_USES: Record<CloudTierId, string> = {
  small: "Agents, builds and tests",
  medium: "Bigger builds and test suites",
  large: "Docker and the Android emulator",
  xlarge: "Docker, Android and heavy builds",
};

/** The four sizes people pick, Small first: the catalog the desktop reads. */
export const PRICING_SIZES: readonly PricingSize[] = (["small", "medium", "large", "xlarge"] as const).flatMap((id) => {
  const size = cloudCatalog({ pro: true, max: true, extraDisk: true }).sizes.find((entry) => entry.tier === id);
  if (!size) return [];
  return [{
    id,
    label: size.label ?? id,
    cpu: size.cpu,
    memoryGb: size.memoryGb,
    diskMaxGb: size.diskMaxGb ?? 0,
    rate: size.multiplierMilli / 1000,
    full: size.type === "vm",
    use: SIZE_USES[id],
  }];
});

/** "$2" for each 10 GB of disk past the plan's, a month. */
export const EXTRA_DISK_USD_PER_10GB_MONTH = EXTRA_DISK_CENTS_PER_10GB_MONTH / 100;

export const FREE_RULES = {
  /** A GitHub account must be this many days old (a card with no charge skips the wait). */
  githubMinAgeDays: CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
} as const;

export const INVITE_RULES = {
  /** Extra hours an invite gives each person. */
  rewardHours: hoursOf(CLOUD_REFERRAL_REWARD_MILLI),
  /** Invite rewards one account can earn. */
  rewardLimit: CLOUD_REFERRAL_REWARD_LIMIT,
  /** Days after signing up that a friend's code can be entered. */
  enterDays: CLOUD_REFERRAL_ENTER_DAYS,
} as const;

/** "2¢", "1.5¢". */
export const formatCents = (cents: number): string => `${Number(cents.toFixed(2))}¢`;

/** "1,600". */
export const formatCount = (value: number): string => value.toLocaleString("en-US");

/** The month the plan finder counts in. */
export const FINDER_DAYS_A_MONTH = 30;

export type PlanCost = {
  plan: PricingPlan;
  /** What the month costs on this plan, extra hours included. */
  costUsd: number;
  /** Hours past the plan's own that the month needs. */
  extraHours: number;
  /** Hours of the plan left unused. */
  spareHours: number;
  /** GB past the plan's shared disk that the computers need, bought as extra disk. */
  extraDiskGb: number;
};

/**
 * What a month of `hours` costs on each plan that can run it, cheapest
 * first. Free can run it only inside its own hours (work stops there); a
 * paid plan runs past its hours with extra hours turned on.
 */
export function planCostsFor(hours: number, diskGb = 0): PlanCost[] {
  const needed = Math.max(0, hours);
  return PRICING_PLANS.flatMap((plan): PlanCost[] => {
    const extraHours = Math.max(0, needed - plan.hours);
    // Free can buy neither: past its hours or its disk, it doesn't run the month.
    if (extraHours > 0 && plan.extraHourCents == null) return [];
    const extraDiskGb = Math.max(0, diskGb - plan.diskGb);
    if (extraDiskGb > 0 && plan.extraHourCents == null) return [];
    // Extra disk bills by the GB, at its price for each 10 GB.
    const extraDiskUsd = (extraDiskGb / 10) * EXTRA_DISK_USD_PER_10GB_MONTH;
    const costUsd = plan.priceUsd + (extraHours * (plan.extraHourCents ?? 0)) / 100 + extraDiskUsd;
    return [{ plan, costUsd, extraHours, spareHours: Math.max(0, plan.hours - needed), extraDiskGb }];
  }).sort((a, b) => a.costUsd - b.costUsd || b.spareHours - a.spareHours);
}

/** "$5", "$13.40". Rounded to the cent first, so plan arithmetic's float noise never shows. */
export const formatUsd = (usd: number): string => {
  const cents = Math.round(usd * 100) / 100;
  return Number.isInteger(cents) ? `$${cents}` : `$${cents.toFixed(2)}`;
};

/**
 * The plan the finder suggests for a month of `hours`, and the other plan
 * worth naming. A plan that covers the month with its own hours wins over a
 * cheaper one that runs on extra hours, unless it costs more than $5 or 30%
 * more: a person rarely wants a bill that grows with every hour to save a
 * dollar or two.
 */
export function suggestPlan(hours: number, diskGb = 0): { pick: PlanCost; other: PlanCost | null } | null {
  const costs = planCostsFor(hours, diskGb);
  const cheapest = costs[0];
  if (!cheapest) return null;
  const covered = costs.find((cost) => cost.extraHours === 0) ?? null;
  if (cheapest.extraHours === 0 || !covered) return { pick: cheapest, other: null };
  const gap = covered.costUsd - cheapest.costUsd;
  return gap <= Math.max(5, cheapest.costUsd * 0.3)
    ? { pick: covered, other: cheapest }
    : { pick: cheapest, other: covered };
}

/** What one included hour costs on a paid plan, in cents: "1.7¢". Null on Free. */
export function centsPerIncludedHour(plan: PricingPlan): string | null {
  if (plan.priceUsd === 0 || plan.hours === 0) return null;
  return `${Number(((plan.priceUsd * 100) / plan.hours).toFixed(1))}¢`;
}

/**
 * A month of the plan's hours as a day of work: "3 hours a day" while one
 * computer could do it, then "7 agents, day and night".
 */
export function planDayLine(plan: PricingPlan): string {
  const perDay = plan.hours / FINDER_DAYS_A_MONTH;
  if (perDay <= 24) {
    const rounded = Math.max(1, Math.round(perDay));
    return `${rounded} ${rounded === 1 ? "hour" : "hours"} a day`;
  }
  const agents = Math.round(perDay / 24);
  return `${agents} ${agents === 1 ? "agent" : "agents"}, day and night`;
}
