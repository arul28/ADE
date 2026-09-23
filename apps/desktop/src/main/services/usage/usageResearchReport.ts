import type { AdeQuotaBurnRate, AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types";
import {
  MAX_USAGE_RESEARCH_APP_VERSION_CHARS,
  MAX_USAGE_RESEARCH_BODY_BYTES,
  MAX_USAGE_RESEARCH_GROUPS,
  MAX_USAGE_RESEARCH_PLATFORM_CHARS,
  USAGE_RESEARCH_HOURS,
  USAGE_RESEARCH_OTHER_PROVIDER,
  USAGE_RESEARCH_SCHEMA_VERSION,
  type UsageResearchAccountKind,
  type UsageResearchBurnRate,
  type UsageResearchDailyBody,
  type UsageResearchDailyReport,
  type UsageResearchGroup,
  type UsageResearchPrice,
  type UsageResearchPriceRates,
  type UsageResearchQuota,
  type UsageResearchRoutedAway,
  type UsageResearchTokens,
  usageResearchEnvelopeText,
  usageResearchUtcOffset,
} from "../../../shared/usageResearch";
import { isServedModelMismatch } from "../chat/servedModelMismatch";
import { sha256Hex } from "../shared/utils";
import { localDayStart } from "./localDay";
import { sameResetInstance } from "./quotaBurnRate";
import { round6 } from "./turnUsageLedger";
import { localUsageAccountId } from "./usageAccountId";
import { isZeroTokenPrice, resolveTokenPrice, tokenPriceSource, type TokenRates } from "./usagePricing";

/**
 * Builds the daily usage research report (`shared/usageResearch.ts`) from one
 * local day of the per-turn ledger.
 *
 * Privacy is by construction: a group copies only the dimensions the contract
 * names, every free-text dimension goes through `researchLabel`, and accounts
 * appear only as a salted hash. Nothing else from a row reaches the body.
 *
 * The output is deterministic: the same rows serialize to the same bytes,
 * whatever order they arrive in.
 */

const ACCOUNT_KINDS: readonly UsageResearchAccountKind[] = ["subscription", "api_key", "local", "unknown"];
const ROUTED_AWAY: readonly UsageResearchRoutedAway[] = ["preset", "endpoint", "cloud"];
const MAX_MODEL_CHARS = 120;
const MAX_LABEL_CHARS = 64;
/** Stands in for a label that looks like a path, an email, or a URL. */
export const USAGE_RESEARCH_REDACTED_LABEL = "_redacted";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The id the report carries for this install, derived from the per-install
 * research salt (`research-uploads.json`). Nothing else ADE sends is derived
 * from that salt, so the id cannot be joined to the analytics installation id
 * or to the account.
 */
export function usageResearchInstallId(salt: string): string {
  return sha256Hex(`ade-usage-research-install:${salt}`).slice(0, 32);
}

/**
 * The account a turn or quota reading belongs to, as a salted hash. Null for
 * the unnamed login (`<provider>:local`), which identifies nothing.
 */
export function usageResearchAccountRef(salt: string, provider: string, accountKey: string | null | undefined): string | null {
  const key = accountKey?.trim();
  if (!key || key === localUsageAccountId(provider)) return null;
  return sha256Hex(`${salt}:${key}`).slice(0, 12);
}

const PATH_LIKE = /^(?:\/|~|\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\\\\)/;
const HOME_PATH = /\/(?:Users|home)\//i;
/** An email; a Vertex model version (`claude-opus-4@20250514`) has no dot after the `@` and stays. */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * A free-text dimension (a model name, a vendor, an effort) made safe to send:
 * trimmed, null when empty, `_redacted` when it looks like a path, an email,
 * or a URL (a local model can be named after its file), and cut to `maxChars`.
 */
export function researchLabel(value: string | null | undefined, maxChars = MAX_LABEL_CHARS): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (PATH_LIKE.test(text) || HOME_PATH.test(text) || EMAIL_LIKE.test(text) || text.includes("\\") || text.includes("://")) {
    return USAGE_RESEARCH_REDACTED_LABEL;
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1] ?? null;
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * What one row adds to the dollar sums: its list-price dollars (null when the
 * row had no list price), and its cost split by who reported it. The day
 * totals and every group add these same numbers.
 */
function rowCosts(row: AdeTurnUsageRecord): { apiEquivalentUsd: number | null; providerCostUsd: number; listPriceCostUsd: number } {
  const priced = row.apiEquivalentUsd != null && Number.isFinite(row.apiEquivalentUsd);
  const cost = count(row.costUsd);
  return {
    apiEquivalentUsd: priced ? Math.max(0, row.apiEquivalentUsd!) : null,
    providerCostUsd: row.costSource === "provider" ? cost : 0,
    listPriceCostUsd: row.costSource === "list_price" ? cost : 0,
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type GroupDimensions = Pick<
  UsageResearchGroup,
  | "provider"
  | "requestedModel"
  | "servedModel"
  | "accountKind"
  | "accountRef"
  | "plan"
  | "routedAway"
  | "upstream"
  | "reasoningEffort"
  | "surface"
  | "subagentChat"
>;

type GroupAccumulator = {
  key: string;
  dims: GroupDimensions;
  turns: number;
  completed: number;
  interrupted: number;
  failed: number;
  tokens: UsageResearchTokens;
  requests: number;
  apiEquivalentUsd: number;
  pricedTurns: number;
  providerCostUsd: number;
  listPriceCostUsd: number;
  planUsage: Map<string, number>;
  contexts: number[];
  windowMax: number | null;
  durations: number[];
  confidence: UsageResearchGroup["confidence"];
  servedMismatches: number;
  compactions: number;
  hours: number[];
  mergedGroups: number;
};

function groupDimensions(row: AdeTurnUsageRecord, salt: string): GroupDimensions {
  const account = row.account;
  const kind = account?.kind;
  const routedAway = account?.routedAway;
  return {
    provider: researchLabel(row.provider) ?? "unknown",
    requestedModel: researchLabel(row.requestedModel, MAX_MODEL_CHARS),
    servedModel: researchLabel(row.servedModel, MAX_MODEL_CHARS),
    accountKind: account ? (kind && ACCOUNT_KINDS.includes(kind) ? kind : "unknown") : null,
    accountRef: usageResearchAccountRef(salt, row.provider, row.accountKey),
    plan: researchLabel(account?.plan),
    routedAway: routedAway && ROUTED_AWAY.includes(routedAway) ? routedAway : null,
    upstream: researchLabel(account?.upstream),
    reasoningEffort: researchLabel(row.reasoningEffort),
    surface: researchLabel(row.surface),
    subagentChat: row.parentSessionId != null,
  };
}

function emptyAccumulator(key: string, dims: GroupDimensions): GroupAccumulator {
  return {
    key,
    dims,
    turns: 0,
    completed: 0,
    interrupted: 0,
    failed: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, subagent: 0 },
    requests: 0,
    apiEquivalentUsd: 0,
    pricedTurns: 0,
    providerCostUsd: 0,
    listPriceCostUsd: 0,
    planUsage: new Map(),
    contexts: [],
    windowMax: null,
    durations: [],
    confidence: { measured: 0, derived: 0, estimated: 0 },
    servedMismatches: 0,
    compactions: 0,
    hours: new Array<number>(USAGE_RESEARCH_HOURS).fill(0),
    mergedGroups: 0,
  };
}

function addRow(acc: GroupAccumulator, row: AdeTurnUsageRecord): void {
  acc.turns += 1;
  if (row.status === "completed") acc.completed += 1;
  else if (row.status === "interrupted") acc.interrupted += 1;
  else if (row.status === "failed") acc.failed += 1;
  acc.tokens.input += count(row.inputTokens);
  acc.tokens.output += count(row.outputTokens);
  acc.tokens.cacheRead += count(row.cacheReadTokens);
  acc.tokens.cacheWrite += count(row.cacheWriteTokens);
  acc.tokens.cacheWrite1h += count(row.cacheWrite1hTokens);
  acc.tokens.reasoning += count(row.reasoningTokens);
  acc.tokens.subagent += count(row.subagentTokens);
  acc.requests += count(row.requestCount);
  const costs = rowCosts(row);
  if (costs.apiEquivalentUsd != null) {
    acc.apiEquivalentUsd += costs.apiEquivalentUsd;
    acc.pricedTurns += 1;
  }
  acc.providerCostUsd += costs.providerCostUsd;
  acc.listPriceCostUsd += costs.listPriceCostUsd;
  for (const entry of row.planUsage ?? []) {
    const unit = researchLabel(entry.unit);
    if (!unit || !Number.isFinite(entry.amount)) continue;
    acc.planUsage.set(unit, (acc.planUsage.get(unit) ?? 0) + entry.amount);
  }
  if (count(row.contextTokens) > 0) acc.contexts.push(Math.round(count(row.contextTokens)));
  const window = count(row.contextWindow);
  if (window > 0) acc.windowMax = Math.max(acc.windowMax ?? 0, Math.round(window));
  if (row.durationMs != null && Number.isFinite(row.durationMs) && row.durationMs >= 0) acc.durations.push(Math.round(row.durationMs));
  if (row.usageConfidence === "measured") acc.confidence.measured += 1;
  else if (row.usageConfidence === "derived") acc.confidence.derived += 1;
  else if (row.usageConfidence === "estimated") acc.confidence.estimated += 1;
  if (isServedModelMismatch(row.requestedModel, row.servedModel)) acc.servedMismatches += 1;
  acc.compactions += count(row.compactions);
  const startedMs = Date.parse(row.startedAt ?? row.at);
  const hour = new Date(Number.isFinite(startedMs) ? startedMs : Date.parse(row.at)).getHours();
  if (hour >= 0 && hour < USAGE_RESEARCH_HOURS) acc.hours[hour]! += 1;
}

function mergeInto(target: GroupAccumulator, source: GroupAccumulator): void {
  target.turns += source.turns;
  target.completed += source.completed;
  target.interrupted += source.interrupted;
  target.failed += source.failed;
  for (const field of Object.keys(target.tokens) as Array<keyof UsageResearchTokens>) {
    target.tokens[field] += source.tokens[field];
  }
  target.requests += source.requests;
  target.apiEquivalentUsd += source.apiEquivalentUsd;
  target.pricedTurns += source.pricedTurns;
  target.providerCostUsd += source.providerCostUsd;
  target.listPriceCostUsd += source.listPriceCostUsd;
  for (const [unit, amount] of source.planUsage) target.planUsage.set(unit, (target.planUsage.get(unit) ?? 0) + amount);
  target.contexts.push(...source.contexts);
  if (source.windowMax != null) target.windowMax = Math.max(target.windowMax ?? 0, source.windowMax);
  target.durations.push(...source.durations);
  target.confidence.measured += source.confidence.measured;
  target.confidence.derived += source.confidence.derived;
  target.confidence.estimated += source.confidence.estimated;
  target.servedMismatches += source.servedMismatches;
  target.compactions += source.compactions;
  for (let hour = 0; hour < USAGE_RESEARCH_HOURS; hour += 1) target.hours[hour]! += source.hours[hour]!;
  target.mergedGroups += Math.max(1, source.mergedGroups);
}

const OTHER_DIMENSIONS: GroupDimensions = {
  provider: USAGE_RESEARCH_OTHER_PROVIDER,
  requestedModel: null,
  servedModel: null,
  accountKind: null,
  accountRef: null,
  plan: null,
  routedAway: null,
  upstream: null,
  reasoningEffort: null,
  surface: null,
  subagentChat: false,
};

function finalizeGroup(acc: GroupAccumulator, options: { hours: boolean }): UsageResearchGroup {
  const contexts = [...acc.contexts].sort((a, b) => a - b);
  const durations = [...acc.durations].sort((a, b) => a - b);
  const planUsage: Record<string, number> = {};
  for (const unit of [...acc.planUsage.keys()].sort()) planUsage[unit] = round6(acc.planUsage.get(unit)!);
  return {
    ...acc.dims,
    turns: acc.turns,
    completed: acc.completed,
    interrupted: acc.interrupted,
    failed: acc.failed,
    tokens: {
      input: Math.round(acc.tokens.input),
      output: Math.round(acc.tokens.output),
      cacheRead: Math.round(acc.tokens.cacheRead),
      cacheWrite: Math.round(acc.tokens.cacheWrite),
      cacheWrite1h: Math.round(acc.tokens.cacheWrite1h),
      reasoning: Math.round(acc.tokens.reasoning),
      subagent: Math.round(acc.tokens.subagent),
    },
    requests: Math.round(acc.requests),
    apiEquivalentUsd: round6(acc.apiEquivalentUsd),
    pricedTurns: acc.pricedTurns,
    providerCostUsd: round6(acc.providerCostUsd),
    listPriceCostUsd: round6(acc.listPriceCostUsd),
    planUsage,
    context: {
      p50: percentile(contexts, 0.5),
      p90: percentile(contexts, 0.9),
      max: contexts.length ? contexts[contexts.length - 1]! : null,
      windowMax: acc.windowMax,
    },
    durationMs: {
      p50: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      sum: durations.reduce((total, value) => total + value, 0),
    },
    confidence: { ...acc.confidence },
    servedMismatches: acc.servedMismatches,
    compactions: Math.round(acc.compactions),
    ...(options.hours ? { hours: [...acc.hours] } : {}),
    ...(acc.mergedGroups > 0 ? { mergedGroups: acc.mergedGroups } : {}),
  };
}

/** Biggest first: list-price dollars, then turns, then the dimensions, so ties never depend on input order. */
function compareGroups(a: GroupAccumulator, b: GroupAccumulator): number {
  return round6(b.apiEquivalentUsd) - round6(a.apiEquivalentUsd)
    || b.turns - a.turns
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Quota, burn rates, prices
// ---------------------------------------------------------------------------

function compareByWindow<T extends { provider: string; windowType: string; accountRef: string | null }>(a: T, b: T): number {
  return a.provider.localeCompare(b.provider)
    || a.windowType.localeCompare(b.windowType)
    || (a.accountRef ?? "").localeCompare(b.accountRef ?? "");
}

function summarizeQuota(samples: readonly AdeQuotaSample[], salt: string): UsageResearchQuota[] {
  const sorted = [...samples].sort((a, b) => a.at.localeCompare(b.at)
    || a.provider.localeCompare(b.provider)
    || a.accountId.localeCompare(b.accountId)
    || a.windowType.localeCompare(b.windowType)
    || a.percentUsed - b.percentUsed);
  const byWindow = new Map<string, AdeQuotaSample[]>();
  for (const sample of sorted) {
    const key = `${sample.provider}|${sample.accountId}|${sample.windowType}`;
    const list = byWindow.get(key) ?? [];
    list.push(sample);
    byWindow.set(key, list);
  }
  const rows: UsageResearchQuota[] = [];
  for (const list of byWindow.values()) {
    const head = list[0]!;
    let resetInstances = 1;
    for (let index = 1; index < list.length; index += 1) {
      if (!sameResetInstance(list[index - 1]!, list[index]!)) resetInstances += 1;
    }
    const percents = list.map((sample) => sample.percentUsed);
    rows.push({
      provider: researchLabel(head.provider) ?? "unknown",
      windowType: researchLabel(head.windowType) ?? "unknown",
      accountRef: usageResearchAccountRef(salt, head.provider, head.accountId),
      minPercent: round2(Math.min(...percents)),
      maxPercent: round2(Math.max(...percents)),
      resetInstances,
      samples: list.length,
    });
  }
  return rows.sort(compareByWindow);
}

function mapBurnRates(rates: readonly AdeQuotaBurnRate[], salt: string): UsageResearchBurnRate[] {
  return rates
    .map((rate) => ({
      provider: researchLabel(rate.provider) ?? "unknown",
      windowType: researchLabel(rate.windowType) ?? "unknown",
      accountRef: usageResearchAccountRef(salt, rate.provider, rate.accountId),
      usdPerPercent: rate.usdPerPercent != null ? round6(rate.usdPerPercent) : null,
      turnsPerPercent: rate.turnsPerPercent != null ? round2(rate.turnsPerPercent) : null,
      observedPercent: round2(rate.observedPercent),
      observedUsd: round6(rate.observedUsd),
      observedTurns: rate.observedTurns,
      confidence: rate.confidence,
    }))
    .sort(compareByWindow);
}

function perMillion(rates: TokenRates): UsageResearchPriceRates {
  return {
    inputPer1M: round6(rates.input * 1_000_000),
    outputPer1M: round6(rates.output * 1_000_000),
    cacheReadPer1M: round6(rates.cacheRead * 1_000_000),
    cacheWritePer1M: round6(rates.cacheWrite * 1_000_000),
  };
}

/** A model's list price for the report, or null when ADE knows no price for it. */
export function usageResearchPrice(model: string): UsageResearchPrice | null {
  const price = resolveTokenPrice(model);
  if (isZeroTokenPrice(price)) return null;
  return {
    ...perMillion(price),
    ...(price.tiers?.length
      ? { tiers: price.tiers.map((tier) => ({ aboveContextTokens: tier.aboveContextTokens, ...perMillion(tier) })) }
      : {}),
    source: tokenPriceSource(model),
  };
}

type PriceCache = Map<string, UsageResearchPrice | null>;

function pricesFor(groups: readonly UsageResearchGroup[], cache: PriceCache): Record<string, UsageResearchPrice> {
  const models = new Set<string>();
  for (const group of groups) {
    const model = group.servedModel ?? group.requestedModel;
    if (model && model !== USAGE_RESEARCH_REDACTED_LABEL) models.add(model);
  }
  const prices: Record<string, UsageResearchPrice> = {};
  for (const model of [...models].sort()) {
    if (!cache.has(model)) cache.set(model, usageResearchPrice(model));
    const price = cache.get(model);
    if (price) prices[model] = price;
  }
  return prices;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type UsageResearchReportInput = {
  /** The day's ledger rows (finished on the day). */
  turns: readonly AdeTurnUsageRecord[];
  /** The day's quota readings. */
  quotaSamples: readonly AdeQuotaSample[];
  /** Burn rates as of the end of the day. */
  burnRates: readonly AdeQuotaBurnRate[];
  /** The per-install salt of `accountRef`. Never sent. */
  salt: string;
};

/** Everything a report needs, before the group cap and the size fit choose what to keep. */
type ReportDraft = {
  totals: UsageResearchDailyReport["totals"];
  groups: GroupAccumulator[];
  quota: UsageResearchQuota[];
  burnRates: UsageResearchBurnRate[];
  /** Prices by model, looked up once however many times the size fit renders the report. */
  prices: PriceCache;
};

function draftReport(input: UsageResearchReportInput): ReportDraft {
  // One fixed row order, so float sums and ties come out the same every time.
  const rows = [...input.turns].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const byKey = new Map<string, GroupAccumulator>();
  let apiEquivalentUsd = 0;
  let providerCostUsd = 0;
  let listPriceCostUsd = 0;
  for (const row of rows) {
    const dims = groupDimensions(row, input.salt);
    const key = JSON.stringify(Object.values(dims));
    let acc = byKey.get(key);
    if (!acc) {
      acc = emptyAccumulator(key, dims);
      byKey.set(key, acc);
    }
    addRow(acc, row);
    const costs = rowCosts(row);
    apiEquivalentUsd += costs.apiEquivalentUsd ?? 0;
    providerCostUsd += costs.providerCostUsd;
    listPriceCostUsd += costs.listPriceCostUsd;
  }
  return {
    totals: {
      turns: rows.length,
      apiEquivalentUsd: round6(apiEquivalentUsd),
      providerCostUsd: round6(providerCostUsd),
      listPriceCostUsd: round6(listPriceCostUsd),
    },
    groups: [...byKey.values()].sort(compareGroups),
    quota: summarizeQuota(input.quotaSamples, input.salt),
    burnRates: mapBurnRates(input.burnRates, input.salt),
    prices: new Map(),
  };
}

/**
 * The report with the first `keep` groups as they are and every later group
 * merged into one `_other` group at the end.
 */
function renderReport(draft: ReportDraft, options: { keep: number; hours: boolean }): UsageResearchDailyReport {
  const keep = Math.max(0, Math.min(options.keep, draft.groups.length));
  const kept = draft.groups.slice(0, keep).map((acc) => finalizeGroup(acc, options));
  const rest = draft.groups.slice(keep);
  const groups = [...kept];
  if (rest.length) {
    const other = emptyAccumulator("_other", OTHER_DIMENSIONS);
    for (const acc of rest) mergeInto(other, acc);
    groups.push(finalizeGroup(other, options));
  }
  return {
    totals: { ...draft.totals },
    groups,
    quota: draft.quota,
    burnRates: draft.burnRates,
    prices: pricesFor(kept, draft.prices),
  };
}

/** How many groups a report keeps whole under the group cap (the rest go to `_other`). */
function groupsUnderCap(total: number, maxGroups: number): number {
  return total <= maxGroups ? total : Math.max(0, maxGroups - 1);
}

/** The day's report with every group kept up to `MAX_USAGE_RESEARCH_GROUPS` and the hour histograms in. */
export function buildUsageResearchDailyReport(
  input: UsageResearchReportInput,
  options: { maxGroups?: number } = {},
): UsageResearchDailyReport {
  const draft = draftReport(input);
  return renderReport(draft, { keep: groupsUnderCap(draft.groups.length, options.maxGroups ?? MAX_USAGE_RESEARCH_GROUPS), hours: true });
}

export type UsageResearchEnvelope = Omit<UsageResearchDailyBody, "schemaVersion" | "report">;

export type EncodedUsageResearchBody =
  | {
      ok: true;
      body: UsageResearchDailyBody;
      json: string;
      bytes: number;
      /** True when the hour histograms were dropped to fit. */
      droppedHours: boolean;
      /** Groups merged into `_other` (for the cap or to fit). */
      mergedGroups: number;
    }
  | { ok: false; reason: "too_large"; bytes: number };

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

type EncodedAttempt = Omit<Extract<EncodedUsageResearchBody, { ok: true }>, "ok">;

/**
 * The encoder the size fit drives: `capped` is how many groups the group cap
 * keeps whole, and `encode(keep, hours)` serializes the day with the first
 * `keep` groups whole and the rest merged into `_other`.
 */
export function usageResearchBodyEncoder(
  envelope: UsageResearchEnvelope,
  input: UsageResearchReportInput,
  options: { maxGroups?: number } = {},
): { capped: number; encode(keep: number, hours: boolean): EncodedAttempt } {
  const draft = draftReport(input);
  return {
    capped: groupsUnderCap(draft.groups.length, options.maxGroups ?? MAX_USAGE_RESEARCH_GROUPS),
    encode(keep, hours) {
      const body: UsageResearchDailyBody = {
        schemaVersion: USAGE_RESEARCH_SCHEMA_VERSION,
        installId: envelope.installId,
        day: envelope.day,
        appVersion: usageResearchEnvelopeText(envelope.appVersion, MAX_USAGE_RESEARCH_APP_VERSION_CHARS),
        platform: usageResearchEnvelopeText(envelope.platform, MAX_USAGE_RESEARCH_PLATFORM_CHARS),
        arch: usageResearchEnvelopeText(envelope.arch, MAX_USAGE_RESEARCH_PLATFORM_CHARS),
        utcOffsetMinutes: usageResearchUtcOffset(envelope.utcOffsetMinutes),
        report: renderReport(draft, { keep, hours }),
      };
      const json = JSON.stringify(body);
      return { body, json, bytes: utf8Bytes(json), droppedHours: !hours, mergedGroups: draft.groups.length - keep };
    },
  };
}

/**
 * The request body for one day, shrunk to fit `maxBytes` when it must: first
 * without the hour histograms, then with the smallest groups merged into
 * `_other`, keeping as many groups whole as fit. `too_large` when even one
 * `_other` group does not fit. The envelope's text fields and offset are cut
 * to the Worker's limits.
 *
 * The fit is a binary search on the number of whole groups. Merging one more
 * group into `_other` removes that group's object and adds at most a few
 * digits and plan-unit keys to `_other`, so the size only shrinks as `keep`
 * goes down, and the search lands on the same `keep` a one-at-a-time walk
 * down from the cap would, in O(log groups) renders instead of O(groups).
 */
export function encodeUsageResearchDailyBody(
  envelope: UsageResearchEnvelope,
  input: UsageResearchReportInput,
  options: { maxBytes?: number; maxGroups?: number } = {},
): EncodedUsageResearchBody {
  const maxBytes = options.maxBytes ?? MAX_USAGE_RESEARCH_BODY_BYTES;
  const { capped, encode } = usageResearchBodyEncoder(envelope, input, options);
  const full = encode(capped, true);
  if (full.bytes <= maxBytes) return { ok: true, ...full };
  const withoutHours = encode(capped, false);
  if (withoutHours.bytes <= maxBytes) return { ok: true, ...withoutHours };
  // Every `keep` below `capped` merges at least one group. Find the largest
  // that fits: `low` fits (or is -1: none does), `high` does not. When none
  // fits, the last attempt that failed is `keep = 0`.
  let low = -1;
  let high = capped;
  let fits: EncodedAttempt | null = null;
  let smallestBytes = withoutHours.bytes;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const attempt = encode(middle, false);
    if (attempt.bytes <= maxBytes) {
      low = middle;
      fits = attempt;
    } else {
      high = middle;
      smallestBytes = attempt.bytes;
    }
  }
  return fits ? { ok: true, ...fits } : { ok: false, reason: "too_large", bytes: smallestBytes };
}

/** Minutes east of UTC at local noon of `day`; 0 for a malformed day. */
export function usageResearchUtcOffsetMinutes(day: string): number {
  const start = localDayStart(day);
  if (!start) return 0;
  const noon = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0, 0);
  return usageResearchUtcOffset(-noon.getTimezoneOffset());
}
