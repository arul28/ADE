/**
 * ADE Cloud's prices and plan rules for the website (`/pricing`, the home
 * page, the invite page). Every number comes from the account directory's
 * own source, the one the server bills with and the desktop shows:
 * `plans.ts` (plans, sizes, hours) and `contract.ts` (the offer's sentences,
 * the free plan's rules, invites, idle cleanup). Nothing here is typed by
 * hand. Pricing v2 (`docs/plans/pricing-v2-and-gravity.md`): Small computers
 * never use hours, bigger ones use Medium-hours, each plan has a number of
 * cloud computers, and no surface shows GB.
 *
 * Both files are plain data with no Worker code, so the site bundles only
 * the values it uses. `vercel.json`'s ignore step watches them too, so a
 * price change redeploys the site.
 */
import {
  CLOUD_FREE_GITHUB_MIN_AGE_DAYS,
  CLOUD_HOUR_UNIT_SENTENCE,
  CLOUD_IDLE_CLEANUP_DAYS,
  CLOUD_REFERRAL_ENTER_DAYS,
  CLOUD_REFERRAL_REWARD_LIMIT,
  CLOUD_REFERRAL_REWARD_MILLI,
  CLOUD_SMALL_FAIR_USE_SENTENCE,
  CLOUD_SMALL_UNLIMITED_SENTENCE,
  cloudComputersPhrase,
  type CloudPlanId,
  type CloudTierId,
} from "../../../account-directory/src/cloud/contract";
import { CLOUD_PLANS, cloudSizeForTier } from "../../../account-directory/src/cloud/plans";

export { CLOUD_HOUR_UNIT_SENTENCE, CLOUD_SMALL_FAIR_USE_SENTENCE, CLOUD_SMALL_UNLIMITED_SENTENCE, cloudComputersPhrase };

/**
 * The ADE Cloud iPhone (an iOS Simulator in the cloud, with iPhone minutes)
 * is behind the server's `CLOUD_PHONE_ACCESS` switch, in beta for testers.
 * The website shows it only once that switch is `all`: then set this to true
 * and the "coming soon" card, its minutes line and the home page mention
 * come back (`ComingSoon`, `CloudSection`).
 */
// Flip to true in the same release that sets the server's CLOUD_PHONE_ACCESS to `all`.
export const CLOUD_PHONE_ON_WEBSITE = false;

/**
 * The website's privacy policy and Terms sections about Gravity's sponsored
 * suggestions (`PrivacyPage`, `TermsPage`) show only once ads are live.
 */
// Flip to true in the same release that turns on the server's GRAVITY_ADS switch.
export const GRAVITY_ADS_ON_WEBSITE = false;

/** The Free plan's ad line, on the pricing page and the home page. */
export const ADS_FREE_PLAN_SENTENCE =
  "Free is ad-supported: ADE Cloud chats on Free may show one sponsored suggestion under a reply. Paid plans have no ads. Chats on your own computer never show ads.";

/** The rest of the offer, after `CLOUD_SMALL_UNLIMITED_SENTENCE`. */
export const CLOUD_OFFER_REST_SENTENCE = "Bigger computers use hours, and each plan has a number of cloud computers.";

/** The offer's two sentences apart, for a headline and its second line: "Unlimited Small computers." and "They never use your hours." */
export const CLOUD_SMALL_UNLIMITED_PARTS: readonly [string, string] = (() => {
  const at = CLOUD_SMALL_UNLIMITED_SENTENCE.indexOf(". ");
  return at < 0
    ? [CLOUD_SMALL_UNLIMITED_SENTENCE, ""]
    : [CLOUD_SMALL_UNLIMITED_SENTENCE.slice(0, at + 1), CLOUD_SMALL_UNLIMITED_SENTENCE.slice(at + 2)];
})();

/** The offer's first sentence without its period, for a pill or a link: "Unlimited Small computers". */
export const CLOUD_SMALL_UNLIMITED_SHORT = CLOUD_SMALL_UNLIMITED_PARTS[0].replace(/\.$/, "");

/** Hours are kept in thousandths of a Medium-hour. */
const hoursOf = (milli: number): number => Math.round(milli / 1000);

export type PricingPlan = {
  id: CloudPlanId;
  name: string;
  priceUsd: number;
  /** A month's hours for the sizes bigger than Small, in Medium-hours. */
  hours: number;
  /** How many cloud computers the account may have, asleep or not. */
  computerLimit: number;
  /** Whether outside agents (ADE MCP) may start ADE Cloud work. */
  outsideAgents: boolean;
  /** ADE Cloud iPhone minutes a month; shown only with `CLOUD_PHONE_ON_WEBSITE`. */
  phoneMinutes: number;
  /** What an hour past the plan's costs, or null on Free, where work on the bigger sizes stops. */
  extraHourCents: number | null;
  /** What a minute past the plan's iPhone minutes costs, or null on Free; shown only with `CLOUD_PHONE_ON_WEBSITE`. */
  extraPhoneMinuteCents: number | null;
  /** Whether ADE Cloud chats on the plan may show a sponsored suggestion: only Free. */
  adSupported: boolean;
  /** Days an unused computer is kept before ADE cleans it up. */
  idleDays: number;
  /** One short line on who the plan is for. */
  pitch: string;
};

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
    name: plan.label,
    priceUsd: plan.priceUsd,
    hours: hoursOf(plan.includedMilli),
    computerLimit: plan.computerLimit,
    outsideAgents: plan.outsideAgents,
    phoneMinutes: plan.phoneMinutes,
    extraHourCents: plan.extraHourCents,
    extraPhoneMinuteCents: plan.extraPhoneMinuteCents,
    adSupported: id === "free",
    idleDays: id === "free" ? CLOUD_IDLE_CLEANUP_DAYS.free : CLOUD_IDLE_CLEANUP_DAYS.paid,
    pitch: PLAN_PITCHES[id],
  };
});

export const FREE_PLAN = PRICING_PLANS[0]!;

/** The most cloud computers any plan allows. */
export const MOST_COMPUTERS = Math.max(...PRICING_PLANS.map((plan) => plan.computerLimit));

/** Days an unused computer is kept on every paid plan. */
export const PAID_IDLE_DAYS = CLOUD_IDLE_CLEANUP_DAYS.paid;

export type PricingSize = {
  id: CloudTierId;
  label: string;
  cpu: number;
  memoryGb: number;
  /** Medium-hours one hour awake uses: 0 (Small never uses hours), 1, 2.5, 4. Never shown as a multiplier. */
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

/** The four sizes people pick, Small first: the sizes the server's catalog sends the desktop. */
export const PRICING_SIZES: readonly PricingSize[] = (["small", "medium", "large", "xlarge"] as const).flatMap((id) => {
  const size = cloudSizeForTier(id);
  if (!size) return [];
  return [{
    id,
    label: size.label,
    cpu: size.cpu,
    memoryGb: size.memoryGb,
    rate: size.multiplierMilli / 1000,
    full: size.type === "vm",
    use: SIZE_USES[id],
  }];
});

export const SMALL_SIZE = PRICING_SIZES.find((size) => size.rate === 0) ?? PRICING_SIZES[0]!;
/** The sizes that use hours, smallest first. */
export const HOURLY_SIZES: readonly PricingSize[] = PRICING_SIZES.filter((size) => size.rate > 0);

/** How many hours `hours` of the plan last on `size`, whole hours; null for Small, which never uses them. */
export function hoursOnSize(hours: number, size: PricingSize): number | null {
  return size.rate > 0 ? Math.floor(hours / size.rate) : null;
}

/** "a Medium", "an X-Large". */
const withArticle = (label: string): string => `${/^[AEIOUX]/i.test(label) ? "an" : "a"} ${label}`;

/**
 * A plan's hours as time on each size that uses them, never a multiplier:
 * "50 hours on a Medium · 20 on a Large · 12 on an X-Large" (or joined by
 * `separator`, such as ", " in a sentence).
 */
export function hoursOnSizesLine(hours: number, separator = " · "): string {
  return HOURLY_SIZES.map((size, index) => {
    const count = hoursOnSize(hours, size) ?? 0;
    const unit = index === 0 ? ` ${count === 1 ? "hour" : "hours"}` : "";
    return `${formatCount(count)}${unit} on ${withArticle(size.label)}`;
  }).join(separator);
}

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
};

/**
 * What a month of `hours` (Medium-hours: Small computers use none) on
 * `computers` cloud computers costs on each plan that can run it, cheapest
 * first. A plan runs it only if it has that many computers. Free can run it
 * only inside its own hours (work on the bigger sizes stops there); a paid
 * plan runs past its hours with extra hours turned on.
 */
export function planCostsFor(hours: number, computers = 1): PlanCost[] {
  const needed = Math.max(0, hours);
  return PRICING_PLANS.flatMap((plan): PlanCost[] => {
    if (computers > plan.computerLimit) return [];
    const extraHours = Math.max(0, needed - plan.hours);
    if (extraHours > 0 && plan.extraHourCents == null) return [];
    const costUsd = plan.priceUsd + (extraHours * (plan.extraHourCents ?? 0)) / 100;
    return [{ plan, costUsd, extraHours, spareHours: Math.max(0, plan.hours - needed) }];
  }).sort((a, b) => a.costUsd - b.costUsd || b.spareHours - a.spareHours);
}

/** "$5", "$13.40". Rounded to the cent first, so plan arithmetic's float noise never shows. */
export const formatUsd = (usd: number): string => {
  const cents = Math.round(usd * 100) / 100;
  return Number.isInteger(cents) ? `$${cents}` : `$${cents.toFixed(2)}`;
};

/**
 * The plan the finder suggests for a month of `hours` on `computers`
 * computers, and the other plan worth naming. A plan that covers the month
 * with its own hours wins over a cheaper one that runs on extra hours, unless
 * it costs more than $5 or 30% more: a person rarely wants a bill that grows
 * with every hour to save a dollar or two.
 */
export function suggestPlan(hours: number, computers = 1): { pick: PlanCost; other: PlanCost | null } | null {
  const costs = planCostsFor(hours, computers);
  const cheapest = costs[0];
  if (!cheapest) return null;
  const covered = costs.find((cost) => cost.extraHours === 0) ?? null;
  if (cheapest.extraHours === 0 || !covered) return { pick: cheapest, other: null };
  const gap = covered.costUsd - cheapest.costUsd;
  return gap <= Math.max(5, cheapest.costUsd * 0.3)
    ? { pick: covered, other: cheapest }
    : { pick: cheapest, other: covered };
}

/** "Plus, Pro and Max". */
export function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
}
