import type { CloudCatalog, CloudTierId as CatalogTierId } from "../../../account-directory/src/cloud/contract";
import { formatCloudHoursRate, type CloudMachine } from "./adeCloud";

/**
 * The four sizes a person picks for an ADE Cloud lane: Small, Medium, Large
 * and X-Large. Each is one size from the server's catalog (`GET
 * /cloud/account`), so its hours rate is the catalog's, never a number here.
 *
 * The server names each tier's size (`tier`), with its `label` and
 * `diskMaxGb`. An older server sends none of these: then a tier is found by
 * its shape (Small is a standard 2 CPU / 4 GB, Medium a standard 4 / 8,
 * Large a full computer 4 / 8, X-Large a full computer 4 / 16), with the
 * labels here and no disk limit.
 */

export type CloudTierId = CatalogTierId;

export const CLOUD_TIER_IDS: readonly CloudTierId[] = ["small", "medium", "large", "xlarge"];

/**
 * The account setting (scope `all`) that holds the size new lanes start
 * with. The app writes it from its preferences (`accountSettingsSync.ts`);
 * a brain reads it for `cloud.status`. Small when nothing is saved.
 */
export const CLOUD_DEFAULT_TIER_SETTING_KEY = "cloudDefaultTier";

export type CloudTier = {
  id: CloudTierId;
  label: string;
  /** The provider type the size runs as: `default` is a standard computer, `vm` a full one. */
  type: "default" | "vm";
  cpu: number;
  memoryGb: number;
  /** Hours of the plan (Medium-hours) this size uses per hour awake, in thousandths (the account's catalog). 0 for Small, unless Free's Small uses hours (sponsored cards off). */
  multiplierMilli: number;
  /** How far the disk may grow at this size, or null from an older server that does not say. */
  diskMaxGb: number | null;
};

type CatalogSize = CloudCatalog["sizes"][number];

const TIER_LABELS: Record<CloudTierId, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "X-Large",
};

/** The labels and shapes each tier has when the catalog does not name tiers. */
const TIER_SHAPES: Record<CloudTierId, Pick<CloudTier, "type" | "cpu" | "memoryGb">> = {
  small: { type: "default", cpu: 2, memoryGb: 4 },
  medium: { type: "default", cpu: 4, memoryGb: 8 },
  large: { type: "vm", cpu: 4, memoryGb: 8 },
  xlarge: { type: "vm", cpu: 4, memoryGb: 16 },
};

export function isCloudTierId(value: unknown): value is CloudTierId {
  return (CLOUD_TIER_IDS as readonly unknown[]).includes(value);
}

/**
 * The tiers this catalog offers, Small first. A tier the catalog has no size
 * for is left out, so a caller never offers a size the server would refuse.
 */
export function cloudTiers(catalog: Pick<CloudCatalog, "sizes">): CloudTier[] {
  const sizes = catalog.sizes as CatalogSize[];
  const named = sizes.some((size) => isCloudTierId(size.tier));
  return CLOUD_TIER_IDS.flatMap((id) => {
    const shape = TIER_SHAPES[id];
    const size = named
      ? sizes.find((entry) => entry.tier === id)
      : sizes.find((entry) => entry.type === shape.type && entry.cpu === shape.cpu && entry.memoryGb === shape.memoryGb);
    if (!size) return [];
    return [{
      id,
      label: size.label?.trim() || TIER_LABELS[id],
      type: size.type,
      cpu: size.cpu,
      memoryGb: size.memoryGb,
      multiplierMilli: size.multiplierMilli,
      diskMaxGb: typeof size.diskMaxGb === "number" ? size.diskMaxGb : null,
    }];
  });
}

/** One tier by id from this catalog, or null when the id is none or the catalog lacks it. */
export function cloudTier(catalog: Pick<CloudCatalog, "sizes">, id: unknown): CloudTier | null {
  if (!isCloudTierId(id)) return null;
  return cloudTiers(catalog).find((tier) => tier.id === id) ?? null;
}

/** A computer's kind and shape, as a tier is found from it. */
export type CloudTierShape = { type: string | null; cpu?: number | null; memoryGb?: number | null };

/**
 * The lane size a computer of this shape runs at, or null when no lane size
 * matches (or there is no shape). A `vm` is a full computer; any other kind
 * a standard one. Callers that rule a kind out (a performance computer) pass null.
 */
export function cloudTierOfShape(shape: CloudTierShape | null, tiers: readonly CloudTier[]): CloudTier | null {
  if (!shape) return null;
  const type = shape.type === "vm" ? "vm" : "default";
  return tiers.find((tier) => tier.type === type && tier.cpu === shape.cpu && tier.memoryGb === shape.memoryGb) ?? null;
}

/** The lane size an ADE Cloud computer runs at, or null (no shape, a performance computer, a size no lane uses). */
export function cloudTierOfMachine(machine: Pick<CloudMachine, "type" | "resources">, tiers: readonly CloudTier[]): CloudTier | null {
  if (!machine.resources || machine.type === "performance") return null;
  return cloudTierOfShape({ type: machine.type, cpu: machine.resources.cpu, memoryGb: machine.resources.memoryGb }, tiers);
}

/** A tier's place, Small first (1 to 4). */
export function cloudTierRank(id: CloudTierId): number {
  return CLOUD_TIER_IDS.indexOf(id) + 1;
}

/** The size's hours rate from the catalog, in words: "uses no hours" (Small), "uses 2.5 hours an hour" (`formatCloudHoursRate`). */
export function cloudTierRateLabel(tier: Pick<CloudTier, "multiplierMilli">): string {
  return formatCloudHoursRate(tier.multiplierMilli / 1000);
}

/** Whether this size uses the plan's hours: every size but Small, and Small too when the account's catalog rates it (Free, sponsored cards off). */
export function cloudTierUsesHours(tier: Pick<CloudTier, "multiplierMilli">): boolean {
  return tier.multiplierMilli > 0;
}

/** "a Medium", "an X-Large". */
function withArticle(label: string): string {
  return `${/^[aeiouxAEIOUX]/.test(label) ? "an" : "a"} ${label}`;
}

/**
 * A month's hours as time on each size that uses them, never as a
 * multiplier: "50 hours on a Medium · 20 on a Large · 12 on an X-Large".
 * Every number is the catalog's (`includedMilli` and each size's rate).
 * Empty when no size uses hours. A plan's line, so never Small: a plan's
 * Small is unlimited, even when this account's Free Small uses hours.
 */
export function cloudHoursOnSizesLine(includedMilli: number, tiers: readonly CloudTier[]): string {
  return tiers
    .filter((tier) => tier.id !== "small" && cloudTierUsesHours(tier))
    .map((tier, index) => {
      const hours = cloudTierHoursAt(tier, includedMilli).replace(/ h$/, "");
      return index === 0 ? `${hours} ${hours === "1" ? "hour" : "hours"} on ${withArticle(tier.label)}` : `${hours} on ${withArticle(tier.label)}`;
    })
    .join(" · ");
}

/** "2 CPU · 4 GB" for a size row. */
export function cloudTierShapeLabel(tier: Pick<CloudTier, "cpu" | "memoryGb">): string {
  return `${tier.cpu} CPU · ${tier.memoryGb} GB`;
}

/**
 * What a size is for, in plain words: what it can run, and what one hour of
 * work there costs. One source for the dashboard's size cards, the size menu
 * by the prompt box and the iPhone (which mirrors the words).
 *
 * A standard computer (Small, Medium) runs agents, builds and tests; a full
 * computer (Large, X-Large) adds Docker and the Android emulator.
 */
export type CloudTierFacts = {
  /** "2 CPU", "4 GB memory". No disk: it shows only when one computer's disk is nearly full. */
  specs: string[];
  /** One plain line on what it runs. */
  runs: string;
  /** True for a full computer: Docker and the Android emulator. */
  full: boolean;
  /** "Never uses your hours" (Small), "1 hour of work uses 2.5 hours of your plan". */
  rateLine: string;
  /** Hours of the plan per hour awake (Medium-hours); 0 for Small. */
  rate: number;
};

const TIER_RUNS: Record<CloudTierId, string> = {
  small: "Agents, builds and tests",
  medium: "Bigger builds and test suites",
  large: "Docker and the Android emulator",
  xlarge: "Docker, Android and heavy builds",
};

export function cloudTierFacts(tier: CloudTier): CloudTierFacts {
  const rate = tier.multiplierMilli / 1000;
  const hours = (value: number) => `${value} hour${value === 1 ? "" : "s"}`;
  return {
    specs: [
      `${tier.cpu} CPU`,
      `${tier.memoryGb} GB memory`,
      // Every size: the template ships the lane screen's packages for each kind.
      "A desktop screen the agent can use",
    ],
    runs: TIER_RUNS[tier.id],
    full: tier.type === "vm",
    rateLine: rate > 0 ? `1 hour of work uses ${hours(rate)} of your plan` : "Never uses your hours",
    rate,
  };
}

/**
 * "41 h", "7.5 h": how long `leftMilli` hours last at this size, rounded down,
 * to a tenth under 10 h and to whole hours from 10 up. "Unlimited" for Small,
 * which never uses hours. Every surface that shows this number uses it, and
 * adds its own words.
 */
export function cloudTierHoursAt(tier: Pick<CloudTier, "multiplierMilli">, leftMilli: number): string {
  if (!cloudTierUsesHours(tier)) return "Unlimited";
  const hours = Math.max(0, leftMilli) / tier.multiplierMilli;
  const shown = hours >= 10 ? Math.floor(hours) : Math.floor(hours * 10) / 10;
  return `${shown.toLocaleString("en-US")} h`;
}
