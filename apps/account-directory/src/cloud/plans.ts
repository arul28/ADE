import type { CloudCatalog, CloudPaidPlanId, CloudPlanFacts, CloudPlanId, CloudTierId } from "./contract";

export type { CloudPaidPlanId };

/**
 * Sizes, plans and the arithmetic of hours, disk and cost
 * (`docs/plans/ade-cloud-plans-and-disk.md`). Hours are integer thousandths of
 * a Small-hour; money is integer millionths of a dollar ("micros").
 */

export type CloudComputerType = "default" | "vm";

export type CloudSize = {
  id: string;
  type: CloudComputerType;
  cpu: number;
  memoryGb: number;
  multiplierMilli: number;
  /** One of the four sizes the main list offers, or null for the other four. */
  tier: CloudTierId | null;
  label: string;
  /** How far the disk may grow at this size. */
  diskMaxGb: number;
};

/**
 * The main list is Small, Medium, Large and X-Large. The other four stay valid
 * for computers that exist and for an advanced choice; their disk limit is the
 * provider's own for that shape.
 */
const CLOUD_SIZES: readonly CloudSize[] = [
  { id: "small", type: "default", cpu: 2, memoryGb: 4, multiplierMilli: 1000, tier: "small", label: "Small", diskMaxGb: 12 },
  { id: "medium", type: "default", cpu: 4, memoryGb: 8, multiplierMilli: 2000, tier: "medium", label: "Medium", diskMaxGb: 20 },
  { id: "large", type: "default", cpu: 4, memoryGb: 16, multiplierMilli: 3300, tier: null, label: "Standard 4 CPU, 16 GB", diskMaxGb: 40 },
  { id: "xlarge", type: "default", cpu: 4, memoryGb: 32, multiplierMilli: 5800, tier: null, label: "Standard 4 CPU, 32 GB", diskMaxGb: 80 },
  { id: "vm-small", type: "vm", cpu: 2, memoryGb: 4, multiplierMilli: 2500, tier: null, label: "Full 2 CPU, 4 GB", diskMaxGb: 100 },
  { id: "vm-medium", type: "vm", cpu: 4, memoryGb: 8, multiplierMilli: 5000, tier: "large", label: "Large", diskMaxGb: 50 },
  { id: "vm-large", type: "vm", cpu: 4, memoryGb: 16, multiplierMilli: 8000, tier: "xlarge", label: "X-Large", diskMaxGb: 100 },
  { id: "vm-xlarge", type: "vm", cpu: 4, memoryGb: 32, multiplierMilli: 14500, tier: null, label: "Full 4 CPU, 32 GB", diskMaxGb: 100 },
];

export function cloudSizeFor(type: unknown, cpu: unknown, memoryGb: unknown): CloudSize | null {
  return CLOUD_SIZES.find((size) => size.type === type && size.cpu === cpu && size.memoryGb === memoryGb) ?? null;
}

/** One of the four sizes of the main list by its id (`small`…`xlarge`), or null. */
export function cloudSizeForTier(tier: unknown): CloudSize | null {
  return typeof tier === "string" ? CLOUD_SIZES.find((size) => size.tier === tier) ?? null : null;
}

/** A size's tier for analytics: one of the main four, or `other`. */
export const tierOf = (size: Pick<CloudSize, "tier"> | null): CloudTierId | "other" => size?.tier ?? "other";

export const DISK_ON_CREATE_GB = 4;
/** Disk grows in steps of this many GB. */
export const DISK_STEP_GB = 4;

/**
 * The plans (the owner's table of 2026-11-13). Disk is what the account has
 * at one time, shared by all its computers; hours and phone minutes are a
 * month's. There is no limit on how many computers an account has: only a
 * hidden safety cap on how many are awake at once (`AWAKE_COMPUTER_CAP`),
 * never shown as a plan limit. Phone minutes are shown on the plan table
 * only: nothing meters them yet. `extraHourCents` is what an hour past the
 * plan costs; null on the free plan, where work stops instead.
 */
export const CLOUD_PLANS: Readonly<Record<CloudPlanId, CloudPlanTerms>> = {
  free: { includedMilli: 100_000, diskGb: 12, priceUsd: 0, phoneMinutes: 20, extraHourCents: null },
  plus: { includedMilli: 300_000, diskGb: 30, priceUsd: 5, phoneMinutes: 30, extraHourCents: 2 },
  pro: { includedMilli: 1_600_000, diskGb: 80, priceUsd: 20, phoneMinutes: 160, extraHourCents: 1.5 },
  max: { includedMilli: 5_000_000, diskGb: 175, priceUsd: 50, phoneMinutes: 500, extraHourCents: 1.2 },
};

/** A plan as `CLOUD_PLANS` holds it; the catalog adds what older builds read. */
export type CloudPlanTerms = Required<Omit<CloudPlanFacts, "computerLimit">>;

/** Paid plans, cheapest first: a move to a lower rank is a downgrade (it waits for the period end). */
export const PAID_PLAN_RANK: Readonly<Record<CloudPaidPlanId, number>> = { plus: 1, pro: 2, max: 3 };

export const isPaidPlanId = (value: unknown): value is CloudPaidPlanId => value === "plus" || value === "pro" || value === "max";

export const FREE_INCLUDED_MILLI = CLOUD_PLANS.free.includedMilli;

/**
 * Plus's and Pro's disk before Cloud 7. An account whose period began before
 * the new plans (`old_plan_terms`, migration 0033) keeps it until its next
 * period, so nobody's disk shrinks mid-period. Hours need no copy: each
 * period stores its own (`included_milli`).
 */
const DISK_GB_BEFORE_CLOUD_7: Readonly<Partial<Record<CloudPlanId, number>>> = { plus: 40, pro: 120 };

/** `planId`'s disk for an account on the old terms or the new. */
export function planDiskGbFor(planId: CloudPlanId, oldTerms: boolean): number {
  return (oldTerms ? DISK_GB_BEFORE_CLOUD_7[planId] : undefined) ?? CLOUD_PLANS[planId].diskGb;
}

/**
 * The most computers one account may have awake at once: a safety cap no real
 * person should reach, never a plan limit. A wake at the cap waits briefly for
 * one to fall asleep, then says so in a plain sentence; a create is refused
 * the same way. Older builds read it as `computers.limit` and a plan's
 * `computerLimit`.
 */
export const AWAKE_COMPUTER_CAP = 25;

/** Extra disk: $2 for each 10 GB a month, counted by the day on the GB above the plan's disk. */
export const EXTRA_DISK_CENTS_PER_10GB_MONTH = 200;
/** One cent in micros (1e-6 USD), the unit money is counted in. */
export const CENT_MICROS = 10_000;
/** A month of extra disk, for "up to $X a month": the limit must hold for a full one. */
export const EXTRA_DISK_MONTH_DAYS = 30;
/**
 * One GB-day of extra disk, in micros: a 30-day month of 10 GB is $2 (6,666.67
 * micros a GB-day). Rounded down, so a limit of $X always admits X/2 × 10 GB
 * for a full month; Stripe bills from its own price, never from this.
 */
export const EXTRA_DISK_MICROS_PER_GB_DAY = Math.floor((EXTRA_DISK_CENTS_PER_10GB_MONTH * CENT_MICROS) / 10 / EXTRA_DISK_MONTH_DAYS);

/** What `gb` of extra disk kept a full month costs, in micros: the amount a monthly limit must cover. */
export const extraDiskMonthMicros = (gb: number): number => gb * EXTRA_DISK_MICROS_PER_GB_DAY * EXTRA_DISK_MONTH_DAYS;

/** Whether `gb` of extra disk kept a full month fits a monthly limit of `limitCents`. */
export const extraDiskMonthFits = (gb: number, limitCents: number): boolean => extraDiskMonthMicros(gb) <= limitCents * CENT_MICROS;

/** The GB-days of extra disk a monthly limit of `limitCents` pays for. */
export const extraDiskGbDaysIn = (limitCents: number): number => Math.floor((limitCents * CENT_MICROS) / EXTRA_DISK_MICROS_PER_GB_DAY);

/** One extra hour on each paid plan, in micros: a flat price per plan, each a bit above that plan's own rate. */
export const EXTRA_HOUR_MICROS: Readonly<Record<CloudPaidPlanId, number>> = {
  plus: Math.round(2 * CENT_MICROS),
  pro: Math.round(1.5 * CENT_MICROS),
  max: Math.round(1.2 * CENT_MICROS),
};

/** What this Worker sells now: Pro, Max and extra disk only once their Stripe prices are set (`cloudOffers`). */
export type CloudOffers = { pro: boolean; max: boolean; extraDisk: boolean };

/** A plan as the catalog sends it: `computerLimit` is the awake cap, for builds that still show a computer count. */
const catalogPlan = (terms: CloudPlanTerms): CloudPlanFacts => ({ ...terms, computerLimit: AWAKE_COMPUTER_CAP });

/**
 * What `GET /cloud/account` tells a client about sizes and plans. Pro, Max and
 * extra disk are left out until they are set up, so no client offers them.
 * `extraHourCents` at the top is for builds that know one price: the
 * account's own plan's, or Plus's for a free account.
 */
export function cloudCatalog(offers: CloudOffers, planId: CloudPlanId = "free"): CloudCatalog {
  return {
    sizes: CLOUD_SIZES.map(({ type, cpu, memoryGb, multiplierMilli, tier, label, diskMaxGb }) => ({ type, cpu, memoryGb, multiplierMilli, tier, label, diskMaxGb })),
    plans: {
      free: catalogPlan(CLOUD_PLANS.free),
      // `paid` is Plus, for builds that know only two plans.
      paid: catalogPlan(CLOUD_PLANS.plus),
      ...(offers.pro ? { plus: catalogPlan(CLOUD_PLANS.plus), pro: catalogPlan(CLOUD_PLANS.pro) } : {}),
      ...(offers.pro && offers.max ? { max: catalogPlan(CLOUD_PLANS.max) } : {}),
    },
    diskStepGb: DISK_STEP_GB,
    paidPriceUsd: CLOUD_PLANS.plus.priceUsd,
    extraHourCents: CLOUD_PLANS[planId === "free" ? "plus" : planId].extraHourCents ?? 2,
    ...(offers.extraDisk ? { extraDiskCentsPer10GbMonth: EXTRA_DISK_CENTS_PER_10GB_MONTH } : {}),
  };
}

/* ---- What ADE Cloud costs the owner (provider's public prices, 2026-11-10) ---- */

/** Per month: each vCPU and each GB of memory, while awake. A full computer bills both at 2.5x. */
const CPU_MICROS_PER_MONTH = 800_000;
const MEMORY_MICROS_PER_GB_MONTH = 700_000;
const FULL_COMPUTER_FACTOR = 2.5;
const HOURS_PER_MONTH = 730;
/** Disk bills always, asleep too: $0.09 per reserved GB a month. */
export const DISK_COST_MICROS_PER_GB_DAY = Math.round(90_000 / 30);

/** What `ms` awake at this shape costs the owner, in micros. */
export function computeCostMicrosFor(ms: number, shape: { type: string; cpu: number; memoryGb: number }): number {
  if (ms <= 0) return 0;
  const perMonth = (shape.cpu * CPU_MICROS_PER_MONTH + shape.memoryGb * MEMORY_MICROS_PER_GB_MONTH) * (shape.type === "vm" ? FULL_COMPUTER_FACTOR : 1);
  return Math.round((perMonth * ms) / (HOURS_PER_MONTH * 3_600_000));
}

/** What the extra hours from `fromMilli` to `toMilli` in one period on `planId` charge, in micros: the plan's flat price. */
export function extraHoursIncomeMicros(planId: CloudPaidPlanId, fromMilli: number, toMilli: number): number {
  const hours = (Math.max(0, toMilli) - Math.max(0, fromMilli)) / 1000;
  return Math.max(0, Math.round(hours * EXTRA_HOUR_MICROS[planId]));
}

/** ADE's wake URL (`CLOUD_WAKE_PORT` on the desktop): the only public port allowed. */
export const WAKE_PORT = 7337;

/** What the meter counts as awake, and `cloudKeepAwake`'s "running" side of a stretch. */
const METERED_STATUSES = new Set(["running", "restarting", "updating"]);
export function isMeteredStatus(status: string): boolean {
  return METERED_STATUSES.has(status);
}

/** Not awake and not on its way there: the only states the 30-day delete may touch. */
const RESTING_STATUSES = new Set(["sleeping", "stopped", "failed"]);
export function isRestingStatus(status: string): boolean {
  return RESTING_STATUSES.has(status);
}

/** Thousandths of a Small-hour for `ms` of awake time at this size. */
export function hoursMilliFor(ms: number, multiplierMilli: number): number {
  if (ms <= 0) return 0;
  return Math.round((ms * multiplierMilli) / 3_600_000);
}

/** `YYYY-MM-DD` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Splits `[from, to)` by UTC day, oldest first. */
export function splitByUtcDay(from: number, to: number): Array<{ day: string; ms: number }> {
  if (to <= from) return [];
  const out: Array<{ day: string; ms: number }> = [];
  let start = from;
  while (start < to) {
    const nextMidnight = Date.UTC(
      new Date(start).getUTCFullYear(),
      new Date(start).getUTCMonth(),
      new Date(start).getUTCDate() + 1,
    );
    const end = Math.min(nextMidnight, to);
    out.push({ day: utcDay(start), ms: end - start });
    start = end;
  }
  return out;
}

/** Whole days left in a period from `now`, today included. */
export function daysLeftIn(periodEnd: number, now: number): number {
  return Math.max(1, Math.ceil((periodEnd - now) / 86_400_000));
}

/** The free period holding `now`: the current UTC month. */
export function freePeriodFor(now: number): { start: number; end: number } {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}
