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

/** A size's tier for analytics: one of the main four, or `other`. */
export const tierOf = (size: Pick<CloudSize, "tier"> | null): CloudTierId | "other" => size?.tier ?? "other";

export const DISK_ON_CREATE_GB = 4;
/** Disk grows in steps of this many GB. */
export const DISK_STEP_GB = 4;

/** Every limit is on what exists at one time, never on what a person makes in a month. */
export const CLOUD_PLANS: Readonly<Record<CloudPlanId, CloudPlanFacts>> = {
  free: { includedMilli: 50_000, computerLimit: 3, diskGb: 12, priceUsd: 0 },
  plus: { includedMilli: 500_000, computerLimit: 10, diskGb: 40, priceUsd: 5 },
  pro: { includedMilli: 1_500_000, computerLimit: 30, diskGb: 120, priceUsd: 20 },
};

export const isPaidPlanId = (value: unknown): value is CloudPaidPlanId => value === "plus" || value === "pro";

export const FREE_INCLUDED_MILLI = CLOUD_PLANS.free.includedMilli;

/** What Stripe charges (`scripts/stripe-setup.mjs` makes the prices). */
const EXTRA_HOUR_CENTS = 1;
/** Extra disk: $1 for each 10 GB a month, counted by the day on the GB above the plan's disk. */
export const EXTRA_DISK_CENTS_PER_10GB_MONTH = 100;
/** One cent in micros (1e-6 USD), the unit money is counted in. */
export const CENT_MICROS = 10_000;
/** A month of extra disk, for "up to $X a month": the limit must hold for a full one. */
export const EXTRA_DISK_MONTH_DAYS = 30;
/** One GB-day of extra disk, in micros: a 30-day month of 10 GB is $1. */
export const EXTRA_DISK_MICROS_PER_GB_DAY = Math.round((EXTRA_DISK_CENTS_PER_10GB_MONTH * CENT_MICROS) / 10 / EXTRA_DISK_MONTH_DAYS);

/** What `gb` of extra disk kept a full month costs, in micros: the amount a monthly limit must cover. */
export const extraDiskMonthMicros = (gb: number): number => gb * EXTRA_DISK_MICROS_PER_GB_DAY * EXTRA_DISK_MONTH_DAYS;

/** Whether `gb` of extra disk kept a full month fits a monthly limit of `limitCents`. */
export const extraDiskMonthFits = (gb: number, limitCents: number): boolean => extraDiskMonthMicros(gb) <= limitCents * CENT_MICROS;

/** The GB-days of extra disk a monthly limit of `limitCents` pays for. */
export const extraDiskGbDaysIn = (limitCents: number): number => Math.floor((limitCents * CENT_MICROS) / EXTRA_DISK_MICROS_PER_GB_DAY);
/** Graduated extra-hours price: 1 cent each, 0.85 cents after 1,000 in a period. */
export const EXTRA_HOUR_MICROS = 10_000;
export const EXTRA_HOUR_VOLUME_MICROS = 8_500;
export const EXTRA_HOUR_VOLUME_AFTER = 1_000;

/** What this Worker sells now: Pro and extra disk only once their Stripe prices are set (`cloudOffers`). */
export type CloudOffers = { pro: boolean; extraDisk: boolean };

/**
 * What `GET /cloud/account` tells a client about sizes and plans. Pro and
 * extra disk are left out until they are set up, so no client offers them.
 */
export function cloudCatalog(offers: CloudOffers): CloudCatalog {
  return {
    sizes: CLOUD_SIZES.map(({ type, cpu, memoryGb, multiplierMilli, tier, label, diskMaxGb }) => ({ type, cpu, memoryGb, multiplierMilli, tier, label, diskMaxGb })),
    plans: {
      free: CLOUD_PLANS.free,
      // `paid` is Plus, for builds that know only two plans.
      paid: CLOUD_PLANS.plus,
      ...(offers.pro ? { plus: CLOUD_PLANS.plus, pro: CLOUD_PLANS.pro } : {}),
    },
    diskStepGb: DISK_STEP_GB,
    paidPriceUsd: CLOUD_PLANS.plus.priceUsd,
    extraHourCents: EXTRA_HOUR_CENTS,
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

/** What the extra hours from `fromMilli` to `toMilli` in one period charge, in micros (the graduated price). */
export function extraHoursIncomeMicros(fromMilli: number, toMilli: number): number {
  const at = (milli: number) => {
    const hours = Math.max(0, milli) / 1000;
    const first = Math.min(hours, EXTRA_HOUR_VOLUME_AFTER);
    return first * EXTRA_HOUR_MICROS + Math.max(0, hours - EXTRA_HOUR_VOLUME_AFTER) * EXTRA_HOUR_VOLUME_MICROS;
  };
  return Math.max(0, Math.round(at(toMilli) - at(fromMilli)));
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
