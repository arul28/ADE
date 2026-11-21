import type { CloudCatalog, CloudPaidPlanId, CloudPlanFacts, CloudPlanId, CloudTierId } from "./contract";

export type { CloudPaidPlanId };

/**
 * Sizes, plans and the arithmetic of hours, disk and cost (Pricing v2,
 * `docs/plans/pricing-v2-and-gravity.md`). Hours are integer thousandths of
 * a Medium-hour, and Small computers use none; money is integer millionths
 * of a dollar ("micros").
 */

export type CloudComputerType = "default" | "vm";

export type CloudSize = {
  id: string;
  type: CloudComputerType;
  cpu: number;
  memoryGb: number;
  /** Thousandths of a Medium-hour each hour awake uses: 0 for Small, which never uses hours. */
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
 * provider's own for that shape. Rates are in Medium-hours (owner, 2026-11-21):
 * Medium 1, Large 2.5, X-Large 4, the other four in proportion to their cost
 * against Medium (half their old Small-hour rates); Small uses none.
 */
const CLOUD_SIZES: readonly CloudSize[] = [
  { id: "small", type: "default", cpu: 2, memoryGb: 4, multiplierMilli: 0, tier: "small", label: "Small", diskMaxGb: 12 },
  { id: "medium", type: "default", cpu: 4, memoryGb: 8, multiplierMilli: 1000, tier: "medium", label: "Medium", diskMaxGb: 20 },
  { id: "large", type: "default", cpu: 4, memoryGb: 16, multiplierMilli: 1650, tier: null, label: "Standard 4 CPU, 16 GB", diskMaxGb: 40 },
  { id: "xlarge", type: "default", cpu: 4, memoryGb: 32, multiplierMilli: 2900, tier: null, label: "Standard 4 CPU, 32 GB", diskMaxGb: 80 },
  { id: "vm-small", type: "vm", cpu: 2, memoryGb: 4, multiplierMilli: 1250, tier: null, label: "Full 2 CPU, 4 GB", diskMaxGb: 100 },
  { id: "vm-medium", type: "vm", cpu: 4, memoryGb: 8, multiplierMilli: 2500, tier: "large", label: "Large", diskMaxGb: 50 },
  { id: "vm-large", type: "vm", cpu: 4, memoryGb: 16, multiplierMilli: 4000, tier: "xlarge", label: "X-Large", diskMaxGb: 100 },
  { id: "vm-xlarge", type: "vm", cpu: 4, memoryGb: 32, multiplierMilli: 7250, tier: null, label: "Full 4 CPU, 32 GB", diskMaxGb: 100 },
];

/** Whether a computer at this rate uses hours: every size but Small. */
export const usesHours = (multiplierMilli: number): boolean => multiplierMilli > 0;

/** The Small size's disk maximum: what older builds read as a plan's disk, for each of its computers. */
const SMALL_DISK_MAX_GB = CLOUD_SIZES[0]!.diskMaxGb;

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
 * Pure: the disk a new computer starts at. 4 GB, or the disk this
 * repository's setup grew to before (`rememberedGb`, `cloud_repo_disks`),
 * in whole steps, inside the size's limit and inside the plan's included disk
 * the account's other computers leave (never extra disk, so nothing new is
 * billed or refused). What doesn't fit starts at the most that does.
 */
export function setupStartDiskGb(
  size: Pick<CloudSize, "diskMaxGb">,
  rememberedGb: number | null | undefined,
  otherDiskGb: number,
  planDiskGb: number,
): number {
  if (typeof rememberedGb !== "number" || !Number.isFinite(rememberedGb)) return DISK_ON_CREATE_GB;
  const step = (gb: number) => Math.floor(gb / DISK_STEP_GB) * DISK_STEP_GB;
  const wanted = Math.min(
    Math.ceil(rememberedGb / DISK_STEP_GB) * DISK_STEP_GB,
    step(size.diskMaxGb),
    step(planDiskGb - otherDiskGb),
  );
  return wanted > DISK_ON_CREATE_GB ? wanted : DISK_ON_CREATE_GB;
}

/**
 * What one ADE Cloud iPhone minute past a paid plan costs, in cents (owner,
 * 2026-11-17). NoMac charges ADE 1.5 cents a minute (`NOMAC_MICROS_PER_MINUTE`
 * in `phones.ts`); the free plan has no extra minutes and stops instead.
 */
export const EXTRA_PHONE_MINUTE_CENTS = 2.5;

/**
 * The plans (Pricing v2, the owner's table of 2026-11-21; iPhone minutes of
 * 2026-11-17). `computerLimit` is how many cloud computers the account may
 * have, asleep or not; hours (Medium-hours) and phone minutes are a month's.
 * Small computers never use hours. There is no account-wide disk: each size
 * has its own maximum, and the idle cleanup deletes unused computers. A
 * hidden safety cap still holds how many are awake at once
 * (`AWAKE_COMPUTER_CAP`). `extraHourCents` and `extraPhoneMinuteCents` are
 * what an hour or a minute past the plan costs; null on the free plan, where
 * work on the bigger sizes stops instead. Outside agents (ADE MCP) may start
 * ADE Cloud work on paid plans only.
 */
export const CLOUD_PLANS: Readonly<Record<CloudPlanId, CloudPlanTerms>> = {
  free: { label: "Free", includedMilli: 50_000, computerLimit: 2, priceUsd: 0, phoneMinutes: 60, extraHourCents: null, extraPhoneMinuteCents: null, outsideAgents: false },
  plus: { label: "Plus", includedMilli: 100_000, computerLimit: 3, priceUsd: 5, phoneMinutes: 80, extraHourCents: 2, extraPhoneMinuteCents: EXTRA_PHONE_MINUTE_CENTS, outsideAgents: true },
  pro: { label: "Pro", includedMilli: 600_000, computerLimit: 10, priceUsd: 20, phoneMinutes: 300, extraHourCents: 2, extraPhoneMinuteCents: EXTRA_PHONE_MINUTE_CENTS, outsideAgents: true },
  max: { label: "Max", includedMilli: 1_500_000, computerLimit: 20, priceUsd: 50, phoneMinutes: 800, extraHourCents: 2, extraPhoneMinuteCents: EXTRA_PHONE_MINUTE_CENTS, outsideAgents: true },
};

/** A plan as `CLOUD_PLANS` holds it, with its name on this server's own pages; the catalog adds what older builds read (`diskGb`). */
export type CloudPlanTerms = Required<Omit<CloudPlanFacts, "diskGb">> & { label: string };

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

/** Plus's and Pro's hours before Cloud 7, for a paid period restored after a failed payment (`restored_same_period`). */
const INCLUDED_MILLI_BEFORE_CLOUD_7: Readonly<Partial<Record<CloudPlanId, number>>> = { plus: 500_000, pro: 1_500_000 };

/** `planId`'s hours for an account on the old terms or the new. */
export function planIncludedMilliFor(planId: CloudPlanId, oldTerms: boolean): number {
  return (oldTerms ? INCLUDED_MILLI_BEFORE_CLOUD_7[planId] : undefined) ?? CLOUD_PLANS[planId].includedMilli;
}

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
/**
 * Extra disk before Cloud 7: $1 for each 10 GB. A subscription whose disk item
 * is still on that price (`extra_disk_old_price`, migration 0033) keeps it
 * until its renewal moves it (`moveMeteredItems`), so its limit and its usage
 * are priced at what Stripe actually charges it. An account on the old plan
 * terms with no disk item gets the current price when extra disk turns on.
 */
const EXTRA_DISK_CENTS_PER_10GB_MONTH_BEFORE_CLOUD_7 = 100;
/** One cent in micros (1e-6 USD), the unit money is counted in. */
export const CENT_MICROS = 10_000;
/** A month of extra disk, for "up to $X a month": the limit must hold for a full one. */
export const EXTRA_DISK_MONTH_DAYS = 30;

/**
 * Whose extra disk price applies: an account whose subscription's disk item is
 * on the price from before Cloud 7 pays the old one. Null (or a plan that
 * starts later, with a new period) is the current price.
 */
export type ExtraDiskTerms = { extra_disk_old_price?: number | null };

/** The extra disk price an account pays, in cents for each 10 GB a month. */
export const extraDiskCentsPer10GbMonthOf = (terms?: ExtraDiskTerms | null): number =>
  terms?.extra_disk_old_price === 1 ? EXTRA_DISK_CENTS_PER_10GB_MONTH_BEFORE_CLOUD_7 : EXTRA_DISK_CENTS_PER_10GB_MONTH;

/**
 * One GB-day of extra disk, in micros: a 30-day month of 10 GB is $2 (6,666.67
 * micros a GB-day). Rounded down, so a limit of $X always admits X/2 × 10 GB
 * for a full month; Stripe bills from its own price, never from this.
 */
export const extraDiskMicrosPerGbDayOf = (terms?: ExtraDiskTerms | null): number =>
  Math.floor((extraDiskCentsPer10GbMonthOf(terms) * CENT_MICROS) / 10 / EXTRA_DISK_MONTH_DAYS);

/** What `gb` of extra disk kept a full month costs, in micros: the amount a monthly limit must cover. */
export const extraDiskMonthMicros = (gb: number, terms?: ExtraDiskTerms | null): number => gb * extraDiskMicrosPerGbDayOf(terms) * EXTRA_DISK_MONTH_DAYS;

/** Whether `gb` of extra disk kept a full month fits a monthly limit of `limitCents`. */
export const extraDiskMonthFits = (gb: number, limitCents: number, terms?: ExtraDiskTerms | null): boolean => extraDiskMonthMicros(gb, terms) <= limitCents * CENT_MICROS;

/** The most extra disk, in whole GB, that a monthly limit of `limitCents` keeps for a full month. */
export const extraDiskMonthMaxGb = (limitCents: number, terms?: ExtraDiskTerms | null): number =>
  Math.max(0, Math.floor((limitCents * CENT_MICROS) / (extraDiskMicrosPerGbDayOf(terms) * EXTRA_DISK_MONTH_DAYS)));

/** The GB-days of extra disk a monthly limit of `limitCents` pays for. */
export const extraDiskGbDaysIn = (limitCents: number, terms?: ExtraDiskTerms | null): number => Math.floor((limitCents * CENT_MICROS) / extraDiskMicrosPerGbDayOf(terms));

/** One extra hour (a Medium-hour) on each paid plan, in micros: 2 cents on every paid plan (Pricing v2). */
export const EXTRA_HOUR_MICROS: Readonly<Record<CloudPaidPlanId, number>> = {
  plus: Math.round(CLOUD_PLANS.plus.extraHourCents! * CENT_MICROS),
  pro: Math.round(CLOUD_PLANS.pro.extraHourCents! * CENT_MICROS),
  max: Math.round(CLOUD_PLANS.max.extraHourCents! * CENT_MICROS),
};

/** What this Worker sells now: Pro, Max and extra disk only once their Stripe prices are set (`cloudOffers`). */
export type CloudOffers = { pro: boolean; max: boolean; extraDisk: boolean };

/** A plan as the catalog sends it, with `diskGb` for older builds (its computers at the Small disk; never a limit). */
// The label stays on this server's pages: the catalog's plans keep their shape.
const catalogPlan = ({ label: _label, ...terms }: CloudPlanTerms): CloudPlanFacts => ({ ...terms, diskGb: terms.computerLimit * SMALL_DISK_MAX_GB });

/**
 * What `GET /cloud/account` tells a client about sizes and plans. Pro, Max and
 * extra disk are left out until they are set up, so no client offers them.
 * `extraHourCents` at the top is for builds that know one price: the
 * account's own plan's, or Plus's for a free account.
 */
export function cloudCatalog(offers: CloudOffers, planId: CloudPlanId = "free", terms?: ExtraDiskTerms | null): CloudCatalog {
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
    hourUnit: "medium",
    ...(offers.extraDisk ? { extraDiskCentsPer10GbMonth: extraDiskCentsPer10GbMonthOf(terms) } : {}),
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

/** Thousandths of a Medium-hour for `ms` of awake time at this size: 0 for Small. */
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
