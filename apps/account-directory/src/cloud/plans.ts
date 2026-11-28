import { CLOUD_CREDIT_SCALE_V3, CLOUD_MAC_SHAPE, type CloudCatalog, type CloudMacOffer, type CloudNextPlan, type CloudPaidPlanId, type CloudPlanFacts, type CloudPlanId, type CloudTierId } from "./contract";

export type { CloudPaidPlanId };

/**
 * Sizes, plans and the arithmetic of hours, disk and cost (Pricing v2,
 * `docs/features/ade-cloud/README.md`, "Plans, credits and sizes"). Hours
 * are integer thousandths of a Medium-hour, and Small computers use none;
 * money is integer millionths of a dollar ("micros").
 */

/** `mac`: a DAEX Cloud Mac (`macProvider.ts`), never in the catalog's `sizes`. */
export type CloudComputerType = "default" | "vm" | "mac";

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

/** Small's CPU and memory (`default` type): the one size Free may run without hours. */
export const SMALL_SHAPE = { cpu: 2, memoryGb: 4 } as const;

/**
 * Small's rate on Free while the account shows no sponsored cards and the
 * ad switch reaches the account (`gravity.ts` `smallUsesNoHours`):
 * half a Medium-hour an hour, as Small costs half of a Medium (owner, 2026-11-23).
 */
export const SMALL_NO_CARDS_RATE_MILLI = 500;

/* ---- Pricing v3: the credit scale and the ad price (`adPrice.ts`) ---- */

/**
 * The scale apps show under Pricing v3: shown credits = milli / 1000 x 10.
 * Storage stays in milli. The website builds its numbers from these exports.
 */
export const CREDIT_SCALE = CLOUD_CREDIT_SCALE_V3;
/** Thousandths in one shown credit at `CREDIT_SCALE`: every v3 rate is a whole number of these. */
export const SHOWN_CREDIT_MILLI = 1000 / CREDIT_SCALE;
/** The DAEX Cloud iPhone under Pricing v3: 5 credits a minute (500 thousandths), half its Pricing v2 rate. */
export const PHONE_MILLI_PER_MINUTE_V3 = 500;
/** The cloud Mac's full rate under Pricing v3: 5 credits a minute. Its computer row carries it an hour (x 60). */
export const MAC_MILLI_PER_MINUTE = 500;
/** The ad price's discount before the owner changes `ad_discount_pct`. */
export const AD_DISCOUNT_PCT_DEFAULT = 20;
/** How long a message or a finished reply keeps the ad price before the owner changes `ad_window_minutes`. */
export const AD_WINDOW_MINUTES_DEFAULT = 60;

/**
 * Pure: the ad rate of a full rate (thousandths an hour or a minute) at
 * `discountPct`, rounded down to a whole shown credit, so the discount is
 * never less than it says: Medium 1000 -> 800, Large 2500 -> 2000, X-Large
 * 4000 -> 3200, the iPhone and the Mac 500 -> 400 at 20%. At 0% it is the
 * full rate, and apps show no second price.
 */
export function adRateMilli(fullMilli: number, discountPct: number): number {
  const pct = Math.min(100, Math.max(0, discountPct));
  return Math.floor((fullMilli * (100 - pct)) / 100 / SHOWN_CREDIT_MILLI) * SHOWN_CREDIT_MILLI;
}

/**
 * Pure: a size's full rate under Pricing v3, a whole shown credit, rounded
 * down so nobody pays more than before (the four unlisted shapes: 1650 ->
 * 1600, 1250 -> 1200, 7250 -> 7200). The main four are already whole.
 */
export const v3FullRateMilli = (multiplierMilli: number): number => Math.floor(multiplierMilli / SHOWN_CREDIT_MILLI) * SHOWN_CREDIT_MILLI;

/** One product's two prices under Pricing v3, in thousandths an hour (sizes) or a minute (`phone`, `mac`). */
export type V3Rate = { fullMilli: number; adMilli: number };

/**
 * Pure: the Pricing v3 table every surface and the website show, at a
 * discount: the four sizes of the main list (Small on Free: 5 credits an hour,
 * free with ads; Small on a paid plan: free either way), the iPhone and the
 * Mac. Thousandths; shown credits are `milli / SHOWN_CREDIT_MILLI`.
 */
export function pricingV3Rates(discountPct: number = AD_DISCOUNT_PCT_DEFAULT): {
  sizes: Array<{ tier: CloudTierId; label: string } & V3Rate>;
  smallFree: V3Rate;
  smallPaid: V3Rate;
  phone: V3Rate;
  mac: V3Rate;
} {
  const sizes = CLOUD_SIZES.filter((size): size is CloudSize & { tier: CloudTierId } => size.tier !== null).map((size) => {
    const full = size.tier === "small" ? SMALL_NO_CARDS_RATE_MILLI : v3FullRateMilli(size.multiplierMilli);
    return { tier: size.tier, label: size.label, fullMilli: full, adMilli: size.tier === "small" ? 0 : adRateMilli(full, discountPct) };
  });
  return {
    sizes,
    smallFree: { fullMilli: SMALL_NO_CARDS_RATE_MILLI, adMilli: 0 },
    smallPaid: { fullMilli: 0, adMilli: 0 },
    phone: { fullMilli: PHONE_MILLI_PER_MINUTE_V3, adMilli: adRateMilli(PHONE_MILLI_PER_MINUTE_V3, discountPct) },
    mac: { fullMilli: MAC_MILLI_PER_MINUTE, adMilli: adRateMilli(MAC_MILLI_PER_MINUTE, discountPct) },
  };
}

/** Whether a computer at this rate uses hours: every size but Small. */
export const usesHours = (multiplierMilli: number): boolean => multiplierMilli > 0;

/** The most disk any size grows to: what an older build's plan disk is built from (`catalogPlan`). */
const LARGEST_DISK_MAX_GB = Math.max(...CLOUD_SIZES.map((size) => size.diskMaxGb));

/** What a Mac minute costs ADE: $0.60 an hour, by the whole minute. */
export const MAC_COST_MICROS_PER_MINUTE = 10_000;

/**
 * The Mac's one size: valid for a computer (the create path, the meter), never
 * listed (an app learns of a Mac from the catalog's `mac`, `cloudMacOffer`).
 */
const MAC_CLOUD_SIZE: CloudSize = { id: "mac", type: "mac", cpu: CLOUD_MAC_SHAPE.cpu, memoryGb: CLOUD_MAC_SHAPE.memoryGb, multiplierMilli: MAC_MILLI_PER_MINUTE * 60, tier: null, label: "Mac", diskMaxGb: CLOUD_MAC_SHAPE.driveGb };

export function cloudSizeFor(type: unknown, cpu: unknown, memoryGb: unknown): CloudSize | null {
  if (type === "mac") return cpu === MAC_CLOUD_SIZE.cpu && memoryGb === MAC_CLOUD_SIZE.memoryGb ? MAC_CLOUD_SIZE : null;
  return CLOUD_SIZES.find((size) => size.type === type && size.cpu === cpu && size.memoryGb === memoryGb) ?? null;
}


/**
 * `CloudCatalog.mac`: sent only while the `mac_computers` switch reaches the
 * account (`macReaches`). `stopAfterIdleMinutes` is the server's setting.
 * `adDiscountPct`: the account's ad discount while Pricing v3 reaches it
 * (`V3CatalogTerms`), which adds the ad price beside the full one; null before.
 */
export function cloudMacOffer(stopAfterIdleMinutes: number, adDiscountPct: number | null = null): CloudMacOffer {
  return {
    label: "Mac",
    cpu: CLOUD_MAC_SHAPE.cpu,
    memoryGb: CLOUD_MAC_SHAPE.memoryGb,
    driveGb: CLOUD_MAC_SHAPE.driveGb,
    creditMilliPerMinute: MAC_MILLI_PER_MINUTE,
    ...(adDiscountPct != null ? { adCreditMilliPerMinute: adRateMilli(MAC_MILLI_PER_MINUTE, adDiscountPct) } : {}),
    stopAfterIdleMinutes,
    startSeconds: { min: 20, max: 45 },
    summary: `macOS with Xcode, ${CLOUD_MAC_SHAPE.cpu} CPU and ${CLOUD_MAC_SHAPE.memoryGb} GB, for Apple builds and the Simulator. Billed by the minute while it runs.`,
    keeps: `When work stops, the Mac stops after ${stopAfterIdleMinutes} minutes and keeps its ${CLOUD_MAC_SHAPE.driveGb} GB drive: the lane, its chats, build caches and Simulator data. Programs installed outside the drive and running servers don't stay.`,
  };
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
 * in whole steps, inside the size's limit (there is no account-wide disk
 * since Pricing v2). What doesn't fit starts at the most that does.
 */
export function setupStartDiskGb(size: Pick<CloudSize, "diskMaxGb">, rememberedGb: number | null | undefined): number {
  if (typeof rememberedGb !== "number" || !Number.isFinite(rememberedGb)) return DISK_ON_CREATE_GB;
  const wanted = Math.min(
    Math.ceil(rememberedGb / DISK_STEP_GB) * DISK_STEP_GB,
    Math.floor(size.diskMaxGb / DISK_STEP_GB) * DISK_STEP_GB,
  );
  return wanted > DISK_ON_CREATE_GB ? wanted : DISK_ON_CREATE_GB;
}

/**
 * The plans (Pricing v2, the owner's table of 2026-11-21). `computerLimit` is
 * how many cloud computers the account may have, asleep or not; hours
 * (credits: Medium-hours) are a month's, and the ADE Cloud iPhone draws from
 * them at one credit a minute (`credits.ts`).
 * Small computers never use hours. There is no account-wide disk: each size
 * has its own maximum, and the idle cleanup deletes unused computers. A
 * hidden safety cap still holds how many are awake at once
 * (`AWAKE_COMPUTER_CAP`). `extraHourCents` is what a credit past the plan
 * costs; null on the free plan, where
 * work on the bigger sizes stops instead. Outside agents (ADE MCP) may start
 * ADE Cloud work on paid plans only.
 */
export const CLOUD_PLANS: Readonly<Record<CloudPlanId, CloudPlanTerms>> = {
  free: { label: "Free", includedMilli: 50_000, computerLimit: 2, priceUsd: 0, extraHourCents: null, outsideAgents: false },
  plus: { label: "Plus", includedMilli: 100_000, computerLimit: 3, priceUsd: 5, extraHourCents: 4, outsideAgents: true },
  pro: { label: "Pro", includedMilli: 600_000, computerLimit: 10, priceUsd: 20, extraHourCents: 4, outsideAgents: true },
  max: { label: "Max", includedMilli: 2_000_000, computerLimit: 20, priceUsd: 50, extraHourCents: 4, outsideAgents: true },
};

/** A plan as `CLOUD_PLANS` holds it, with its name on this server's own pages; the catalog adds what older builds read (`diskGb`). */
export type CloudPlanTerms = Required<Omit<CloudPlanFacts, "diskGb">> & { label: string };

/** Paid plans, cheapest first: a move to a lower rank is a downgrade (it waits for the period end). */
export const PAID_PLAN_RANK: Readonly<Record<CloudPaidPlanId, number>> = { plus: 1, pro: 2, max: 3 };

/**
 * The plan one step up, for the computer limit's card ("Move to Plus for 3
 * computers"): free → Plus → Pro → Max, none above Max. Only a plan this
 * Worker sells (`cloudOffers`); Plus always is.
 */
export function nextPlanUp(planId: CloudPlanId, offers: CloudOffers): CloudPaidPlanId | null {
  if (planId === "free") return "plus";
  if (planId === "plus") return offers.pro ? "pro" : null;
  if (planId === "pro") return offers.max ? "max" : null;
  return null;
}

/** The plan the computer limit offers (`nextPlanUp`), as the account state and a `computer_limit` refusal both send it. */
export function nextPlanOffer(planId: CloudPlanId, offers: CloudOffers): CloudNextPlan | null {
  const next = nextPlanUp(planId, offers);
  return next ? { planId: next, computerLimit: CLOUD_PLANS[next].computerLimit, priceUsd: CLOUD_PLANS[next].priceUsd } : null;
}

export const isPaidPlanId = (value: unknown): value is CloudPaidPlanId => value === "plus" || value === "pro" || value === "max";

export const FREE_INCLUDED_MILLI = CLOUD_PLANS.free.includedMilli;

/**
 * The most computers one account may have awake at once: a safety cap no real
 * person should reach, never a plan limit (the plan's limit is
 * `computerLimit`, on every computer, asleep or not). A wake at the cap waits
 * briefly for one to fall asleep, then says so in a plain sentence; a create
 * is refused the same way.
 */
export const AWAKE_COMPUTER_CAP = 25;

/** One cent in micros (1e-6 USD), the unit money is counted in. */
export const CENT_MICROS = 10_000;

/** One extra hour (a Medium-hour) on each paid plan, in micros: 4 cents on every paid plan (since 2026-11-26). */
export const EXTRA_HOUR_MICROS: Readonly<Record<CloudPaidPlanId, number>> = {
  plus: Math.round(CLOUD_PLANS.plus.extraHourCents! * CENT_MICROS),
  pro: Math.round(CLOUD_PLANS.pro.extraHourCents! * CENT_MICROS),
  max: Math.round(CLOUD_PLANS.max.extraHourCents! * CENT_MICROS),
};

/** What this Worker sells now: Pro and Max only once their Stripe prices are set (`cloudOffers`). Extra disk is no longer sold. */
export type CloudOffers = {
  pro: boolean;
  max: boolean;
};

/**
 * A plan as the catalog sends it. `diskGb` is for builds before Pricing v2,
 * which show it as the plan's shared disk and check their own grows against
 * it: `computerLimit` x the largest size's `diskMaxGb`, so such a build never
 * refuses a grow this server allows. It is no limit here.
 */
// The label stays on this server's pages: the catalog's plans keep their shape.
const catalogPlan = ({ label: _label, ...terms }: CloudPlanTerms): CloudPlanFacts => ({ ...terms, diskGb: terms.computerLimit * LARGEST_DISK_MAX_GB });

/** The catalog's Pricing v3 terms for one account (`adPrice.ts` `pricingAccountState`): the discount, and Small's full rate. */
export type V3CatalogTerms = { discountPct: number; smallFullMilli: number; freeSmallMilli: number };

/**
 * What `GET /cloud/account` tells a client about sizes and plans. Pro and Max
 * are left out until they are set up, so no client offers them. Extra disk
 * is no longer sold, so `extraDiskCentsPer10GbMonth` is never sent.
 * `extraHourCents` at the top is for builds that know one price: the
 * account's own plan's, or Plus's for a free account.
 */
export function cloudCatalog(
  offers: CloudOffers,
  planId: CloudPlanId = "free",
  { smallUsesHours = false, v3 }: { smallUsesHours?: boolean; v3?: V3CatalogTerms } = {},
): CloudCatalog {
  return {
    // Linux sizes only (the Mac is never in the catalog's `sizes`; it has its own `mac` entry).
    sizes: CLOUD_SIZES.flatMap(({ type, cpu, memoryGb, multiplierMilli, tier, label, diskMaxGb }) => {
      if (type === "mac") return [];
      if (v3) {
        // Pricing v3 (`adPrice.ts`): the full price, and the ad price beside it. Small: 500 on Free
        // while the ad switch reaches the account, free with ads; free on paid plans.
        const full = tier === "small" ? v3.smallFullMilli : v3FullRateMilli(multiplierMilli);
        return [{ type, cpu, memoryGb, tier, label, diskMaxGb, multiplierMilli: full, adMultiplierMilli: tier === "small" ? 0 : adRateMilli(full, v3.discountPct) }];
      }
      // Free's Small with no sponsored cards uses hours (`gravity.ts` `smallUsesNoHours`): clients show and count it so.
      return [{ type, cpu, memoryGb, tier, label, diskMaxGb, multiplierMilli: tier === "small" && smallUsesHours ? SMALL_NO_CARDS_RATE_MILLI : multiplierMilli }];
    }),
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
    ...(v3 ? {
      creditScale: CREDIT_SCALE,
      phone: { milliPerMinute: PHONE_MILLI_PER_MINUTE_V3, adMilliPerMinute: adRateMilli(PHONE_MILLI_PER_MINUTE_V3, v3.discountPct) },
      freeSmallMilli: v3.freeSmallMilli,
    } : {}),
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
  // NoMac bills by the minute; a stretch's own rounding to whole minutes is the meter's (`settleStatements`).
  if (shape.type === "mac") return Math.round((ms * MAC_COST_MICROS_PER_MINUTE) / 60_000);
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
