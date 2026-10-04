import type { AdeUsageCostSplit } from "../../../shared/types";

/**
 * The arithmetic for `AdeUsageCostSplit`: where a cost figure's dollars went,
 * by token type and by the premium a faster service tier added. Pure, so the
 * ledger scan, the stats aggregation and the account rollup add splits the
 * same way.
 */

const SPLIT_FIELDS = ["input", "cacheRead", "cacheWrite", "output", "other", "fastPremium", "ultrafastPremium"] as const;

export function emptyCostSplit(): AdeUsageCostSplit {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0, fastPremium: 0, ultrafastPremium: 0 };
}

/** Adds `source` (times `scale`) into `target` in place. A missing source adds nothing. */
export function addCostSplit(target: AdeUsageCostSplit, source: AdeUsageCostSplit | null | undefined, scale = 1): AdeUsageCostSplit {
  if (!source) return target;
  for (const field of SPLIT_FIELDS) {
    const value = Number(source[field]);
    if (Number.isFinite(value) && value > 0) target[field] += value * scale;
  }
  return target;
}

/** The dollars the split accounts for: its five type fields. */
export function costSplitTotal(split: AdeUsageCostSplit): number {
  return split.input + split.cacheRead + split.cacheWrite + split.output + split.other;
}

/** Rounded to micro-dollars for transport; a split of all zeros is dropped. */
export function finalizeCostSplit(split: AdeUsageCostSplit | null | undefined): AdeUsageCostSplit | undefined {
  if (!split) return undefined;
  const rounded = emptyCostSplit();
  let any = false;
  for (const field of SPLIT_FIELDS) {
    const value = Math.round(Math.max(0, split[field]) * 1_000_000) / 1_000_000;
    rounded[field] = value;
    if (value > 0) any = true;
  }
  return any ? rounded : undefined;
}

/** Reads a split off the wire or a cache, or null when it is not one. */
export function parseCostSplit(value: unknown): AdeUsageCostSplit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const split = emptyCostSplit();
  for (const field of SPLIT_FIELDS) {
    const number = Number(record[field] ?? 0);
    split[field] = Number.isFinite(number) && number > 0 ? number : 0;
  }
  return split;
}
