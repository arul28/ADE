import type { AdeUsageCostSplit, AdeUsageModelDetail } from "../../../shared/types/usage";
import { addCostSplit, emptyCostSplit, finalizeCostSplit } from "../../../shared/usageCostSplit";
import { applyUsageModelAlias, usagePriceOverrideKey, readUsagePriceOverrides } from "./usagePriceOverrides";
import { isZeroTokenPrice, resolveTokenPriceWithSource } from "./usagePricing";

/** One model id's tokens and cost on one local day, as the history scan recorded them. */
export type ModelDetailDayRow = {
  date: string;
  modelId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  costSplit: AdeUsageCostSplit | null;
};

const roundUsd = (value: number) => Math.round(value * 100) / 100;
const perMillion = (value: number) => Math.round(value * 1_000_000 * 1_000_000) / 1_000_000;

/**
 * The model drilldown: totals, daily trend and split over the rows the caller
 * picked (one provider, one display name, one range), the rate ADE prices the
 * model at now, and the "Map to" the user set for it.
 */
export function buildModelDetail(args: {
  provider: string;
  model: string;
  range: AdeUsageModelDetail["range"];
  rows: readonly ModelDetailDayRow[];
}): AdeUsageModelDetail {
  const { provider, model, range, rows } = args;
  const byDate = new Map<string, { costUsd: number; totalTokens: number }>();
  const modelIds = new Set<string>();
  const totals = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const split = emptyCostSplit();
  for (const row of rows) {
    modelIds.add(row.modelId);
    totals.costUsd += row.costUsd;
    totals.input += row.input;
    totals.output += row.output;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite += row.cacheWrite;
    addCostSplit(split, row.costSplit);
    const day = byDate.get(row.date) ?? { costUsd: 0, totalTokens: 0 };
    day.costUsd += row.costUsd;
    day.totalTokens += row.input + row.output + row.cacheRead + row.cacheWrite;
    byDate.set(row.date, day);
  }
  const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;
  const priceId = [...modelIds][0] ?? model;
  const { price, source } = resolveTokenPriceWithSource(priceId);
  const aliasSources = new Set([model, ...modelIds].map(usagePriceOverrideKey));
  const overrides = readUsagePriceOverrides();
  const aliases = overrides.aliases;
  // A custom price is shown as the user typed it, so a blank cache rate stays blank.
  const typed = source === "custom" ? overrides.prices[usagePriceOverrideKey(priceId)] : undefined;
  const mapFrom = [...aliasSources].find((key) => Object.hasOwn(aliases, key));
  const mappedFrom = Object.keys(aliases)
    .filter((source) => !aliasSources.has(source) && aliasSources.has(usagePriceOverrideKey(applyUsageModelAlias(source))))
    .sort();
  const finalSplit = finalizeCostSplit(split);
  return {
    provider,
    model,
    range,
    costUsd: roundUsd(totals.costUsd),
    inputTokens: totals.input,
    outputTokens: totals.output,
    cachedTokens: totals.cacheRead + totals.cacheWrite,
    cacheReadTokens: totals.cacheRead,
    totalTokens,
    costPerMillionUsd: totalTokens > 0 ? Math.round((totals.costUsd / totalTokens) * 1_000_000 * 100) / 100 : null,
    cacheHitRate: inputSide > 0 ? totals.cacheRead / inputSide : null,
    ...(finalSplit ? { costSplit: finalSplit } : {}),
    daily: [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => ({ date, costUsd: Math.round(day.costUsd * 10_000) / 10_000, totalTokens: day.totalTokens })),
    price: typed ? { ...typed, source, unpriced: false } : {
      input: perMillion(price.input),
      output: perMillion(price.output),
      cacheRead: perMillion(price.cacheRead),
      cacheWrite: perMillion(price.cacheWrite),
      source,
      unpriced: isZeroTokenPrice(price),
    },
    modelIds: [...modelIds].sort(),
    mapTo: mapFrom ? aliases[mapFrom] ?? null : null,
    mappedFrom,
  };
}
