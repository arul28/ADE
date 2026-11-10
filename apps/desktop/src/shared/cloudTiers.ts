import type { CloudCatalog } from "../../../account-directory/src/cloud/contract";

/**
 * The four sizes a person picks for an ADE Cloud lane: Small, Medium, Large
 * and X-Large. Each is one size from the server's catalog (`GET
 * /cloud/account`), so its hours rate is the catalog's, never a number here.
 *
 * A catalog size may name its tier itself (`tier`). Until the server sends
 * that, a tier is found by its shape: Small is a standard 2 CPU / 4 GB,
 * Medium a standard 4 / 8, Large a full computer 4 / 8, X-Large a full
 * computer 4 / 16.
 */

export type CloudTierId = "small" | "medium" | "large" | "xlarge";

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
  /** Hours of a Small computer this size uses per hour awake, in thousandths (the catalog's). */
  multiplierMilli: number;
};

/** A catalog size, with the optional tier name a newer server adds. */
type CatalogSize = CloudCatalog["sizes"][number] & { tier?: CloudTierId | null };

const TIER_LABELS: Record<CloudTierId, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "X-Large",
};

/** The shape each tier has when the catalog does not name tiers. */
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
    return [{ id, label: TIER_LABELS[id], type: size.type, cpu: size.cpu, memoryGb: size.memoryGb, multiplierMilli: size.multiplierMilli }];
  });
}

/** One tier by id from this catalog, or null when the id is none or the catalog lacks it. */
export function cloudTier(catalog: Pick<CloudCatalog, "sizes">, id: unknown): CloudTier | null {
  if (!isCloudTierId(id)) return null;
  return cloudTiers(catalog).find((tier) => tier.id === id) ?? null;
}
