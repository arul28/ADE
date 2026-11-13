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
import { CLOUD_PLANS, EXTRA_DISK_CENTS_PER_10GB_MONTH, cloudCatalog } from "../../../account-directory/src/cloud/plans";

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

/** The plan the page points people to. */
export const HIGHLIGHTED_PLAN: CloudPlanId = "pro";

export const FREE_PLAN = PRICING_PLANS[0]!;

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
