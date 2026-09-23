import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModelListPrice, resolveModelDescriptor } from "../../../shared/modelRegistry";
import { forEachModelsDevEntry, MODELS_DEV_API_URL, pickModelsDevEntries, type ModelsDevCost } from "../ai/modelsDevCatalog";
import { getErrorMessage, isRecord } from "../shared/utils";

export type TokenRates = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

/**
 * Per-token rates plus the long-context tiers some vendors charge.
 *
 * OpenAI (GPT-5.4 and later, 272k), xAI (Grok, 200k), Google (Gemini Pro,
 * 200k), Alibaba (Qwen Plus 200k; Qwen3 Coder 32k and 128k) and MiniMax bill a
 * whole request at a higher rate once its prompt passes a threshold. `tiers`
 * are sorted by `aboveContextTokens`, ascending; the base rates apply at or
 * below the first threshold. Anthropic, DeepSeek, Moonshot, Z.ai and Mistral
 * are flat and carry no tiers.
 */
export type TokenPrice = TokenRates & {
  tiers?: Array<{ aboveContextTokens: number } & TokenRates>;
};

type PricingLogger = {
  debug?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
};

const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How old a cached copy of the models.dev rates may be and still be used.
 *
 * The refresh re-fetches after a day and keeps whatever it has when that
 * fails, so without a bound a machine that went offline in March would still
 * price this year's usage at March's rates. Past this age the cache is dropped
 * and prices fall back to the registry (and model manifest) rates.
 */
const PRICING_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ADE_PRICING_CACHE_PATH = path.join(os.homedir(), ".ade", "models-dev-pricing.json");
/**
 * The on-disk cache format. Version 1 had no version field, no long-context
 * tiers, and the old cache-write fill. A cache with any other version is
 * ignored, so the next refresh fetches the rates again.
 */
const PRICING_CACHE_FORMAT_VERSION = 2;

export const WEB_SEARCH_COST_USD = 0.01;
export const ONE_HOUR_CACHE_WRITE_MULTIPLIER = 1.6;

const ZERO_PRICE: TokenPrice = Object.freeze({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function tokenPrice(inputPer1M: number, outputPer1M: number, cacheReadPer1M = inputPer1M * 0.1, cacheWritePer1M = inputPer1M * 1.25): TokenPrice {
  return {
    input: inputPer1M / 1_000_000,
    output: outputPer1M / 1_000_000,
    cacheWrite: cacheWritePer1M / 1_000_000,
    cacheRead: cacheReadPer1M / 1_000_000,
  };
}

/**
 * Names one runtime reports mapped onto the rate-card key that prices them.
 *
 * An alias that points at the wrong model is indistinguishable from a wrong
 * price: every `claude-4.6-sonnet` spelling used to resolve to `claude-sonnet-5`
 * and was billed at 2/10 where the rate list prices Sonnet 4.6 at 3/15. Alias a
 * name to the model it actually names; use a *different* model's key only when
 * the name is a genuine "pick one for me" (`auto`, Cursor's `composer-*`).
 */
const BUILTIN_PRICING_ALIASES: Record<string, string> = {
  auto: "claude-sonnet-5",
  fable: "claude-fable-5-1",
  "fable-5.1": "claude-fable-5-1",
  "fable-5-1": "claude-fable-5-1",
  "fable-5": "claude-fable-5-1",
  "fable-5.0": "claude-fable-5-1",
  astra: "gpt-6-astra",
  sol: "gpt-6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-6-luna",
  "anthropic--claude-4.6-opus": "claude-opus-4-6",
  "anthropic--claude-4.6-sonnet": "claude-sonnet-4-6",
  "anthropic--claude-4.5-opus": "claude-opus-4-5",
  "anthropic--claude-4.5-sonnet": "claude-sonnet-4-5",
  "anthropic--claude-4.5-haiku": "claude-haiku-4-5",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.5": "claude-opus-4-5",
  "cursor-auto": "claude-sonnet-4-5",
  "cursor-agent-auto": "claude-sonnet-4-5",
  "copilot-auto": "claude-sonnet-4-5",
  "copilot-openai-auto": "gpt-5.3-codex",
  "copilot-anthropic-auto": "claude-sonnet-4-5",
  "ibm-bob-auto": "claude-sonnet-4-5",
  "kiro-auto": "claude-sonnet-4-5",
  "cline-auto": "claude-sonnet-4-5",
  "openclaw-auto": "claude-sonnet-4-5",
  "qwen-auto": "claude-sonnet-4-5",
  "kimi-auto": "kimi-k2-thinking",
  "kimi-code": "kimi-k2-thinking",
  "kimi-for-coding": "kimi-k2-thinking",
  "claude-4-sonnet": "claude-sonnet-4",
  "claude-4-sonnet-1m": "claude-sonnet-4",
  "claude-4-sonnet-thinking": "claude-sonnet-4-5",
  "claude-4.5-sonnet": "claude-sonnet-4-5",
  "claude-4.5-sonnet-thinking": "claude-sonnet-4-5",
  "claude-4.6-sonnet": "claude-sonnet-4-6",
  "claude-4.6-sonnet-high": "claude-sonnet-4-6",
  "claude-4.6-sonnet-low": "claude-sonnet-4-6",
  "claude-4.6-sonnet-thinking": "claude-sonnet-4-6",
  "claude-4.6-sonnet-high-thinking": "claude-sonnet-4-6",
  "claude-4-opus": "claude-opus-4",
  "claude-4.5-opus": "claude-opus-4-5",
  "claude-4.5-opus-high": "claude-opus-4-5",
  "claude-4.5-opus-low": "claude-opus-4-5",
  "claude-4.5-opus-medium": "claude-opus-4-5",
  "claude-4.5-opus-high-thinking": "claude-opus-4-5",
  "claude-4.6-opus": "claude-opus-4-6",
  "claude-4.6-opus-fast-mode": "claude-opus-4-6",
  "claude-4.6-opus-high": "claude-opus-4-6",
  "claude-4.6-opus-low": "claude-opus-4-6",
  "claude-4.6-opus-medium": "claude-opus-4-6",
  "claude-4.6-opus-high-thinking": "claude-opus-4-6",
  "claude-4.7-opus": "claude-opus-4-7",
  "claude-opus-4-7-thinking-high": "claude-opus-4-7",
  "claude-4.5-haiku": "claude-haiku-4-5",
  "claude-4.6-haiku": "claude-haiku-4-5",
  "composer-1": "claude-sonnet-4-5",
  "composer-1.5": "claude-sonnet-4-5",
  "composer-2": "claude-sonnet-5",
  "composer-2.5": "claude-sonnet-5",
  "composer-latest": "claude-sonnet-5",
  "gpt-5-fast": "gpt-5",
  "gpt-5.2-low": "gpt-5",
  "gpt-5.1-codex-high": "gpt-5.3-codex",
  "gpt-5.3": "gpt-5.3-codex",
  "gpt-5.3-spark": "gpt-5.3-codex",
  "codex-spark": "gpt-5.3-codex",
  spark: "gpt-5.3-codex",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-auto": "gemini-3.1-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "gemini-3.1-pro-high": "gemini-3.1-pro-preview",
  "gemini-3.1-pro-low": "gemini-3.1-pro-preview",
  "gemini-3-flash-agent": "gemini-3-flash-preview",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3.1-flash-image": "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
};

const CURSOR_VARIANT_SUFFIXES = [
  "-high-thinking",
  "-medium-thinking",
  "-low-thinking",
  "-thinking-high",
  "-thinking-medium",
  "-thinking-low",
  "-fast-mode",
  "-thinking",
  "-medium",
  "-high",
  "-low",
  "-fast",
] as const;

let dynamicTokenPricingLoaded = false;
let dynamicTokenPricingTimestamp = 0;
let dynamicTokenPricing = new Map<string, TokenPrice>();
let sortedDynamicPricingKeys: string[] | null = null;
let refreshInFlight: Promise<number> | null = null;
let disableDiskCacheForTest = false;

/**
 * Drop what is not part of the priced model id: a `@version` pin, a `-YYYYMMDD`
 * snapshot date, and Claude Code's `[1m]` context-window tag (left on, a prefix
 * match would price `claude-opus-4-8[1m]` as `claude-opus-4`).
 */
function normalizeModelVersion(model: string): string {
  return model.trim().replace(/@.*$/, "").replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

function canonicalPricingName(model: string): string {
  return normalizeModelVersion(model).replace(/^[^/]+\//, "").toLowerCase();
}

function withProviderPricingName(model: string): string {
  return normalizeModelVersion(model).toLowerCase();
}

function resolveAlias(model: string): string {
  let current = model;
  for (let i = 0; i < 4; i++) {
    const alias = BUILTIN_PRICING_ALIASES[current];
    if (alias) return alias;
    const stripped = stripKnownVariantSuffix(current);
    if (!stripped || stripped === current) break;
    current = stripped;
  }
  return current;
}

function stripKnownVariantSuffix(model: string): string | null {
  for (const suffix of CURSOR_VARIANT_SUFFIXES) {
    if (model.endsWith(suffix) && model.length > suffix.length) {
      return model.slice(0, -suffix.length);
    }
  }
  return null;
}

function safePerTokenRate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value > 1) return 1;
  return value;
}

/**
 * Vendors that bill a first-time cached prefix above the plain input rate:
 * Anthropic (1.25x for the 5-minute TTL) and OpenAI from GPT-5.6 on (1.25x;
 * "no additional charge on earlier models" per OpenAI's prompt-caching guide).
 * Resellers often drop the write rate from these rows, so the premium is keyed
 * on the model, not on whether the row happens to list it.
 */
function chargesCacheWritePremium(modelKey: string | undefined): boolean {
  if (!modelKey) return true;
  // Bedrock names Claude `anthropic.claude-…`, with a region prefix for a
  // cross-region profile (`us.anthropic.claude-…`).
  const bare = (modelKey.split("/").pop()?.toLowerCase() ?? "").replace(/^(?:[a-z]+\.)?anthropic\./, "");
  return /^claude-/.test(bare) || /^gpt-(?:5\.(?:[6-9]|\d{2,})|[6-9])/.test(bare);
}

/**
 * models.dev omits cache rates for some rows.
 *
 * A row that lists a cache-read rate but no cache-write rate, for a vendor
 * that charges no write premium (DeepSeek's disk cache, xAI, Moonshot, Gemini's
 * implicit cache, OpenAI before GPT-5.6), bills a first-time prefix at the plain
 * input rate. A row with neither rate falls back to the conventional 1.25x write
 * / 0.1x read ratios.
 */
function fillMissingPriceFields(
  parts: { input: number; output: number; cacheWrite: number | null; cacheRead: number | null },
  modelKey?: string,
): TokenRates {
  const noWritePremium = parts.cacheWrite == null && parts.cacheRead != null && !chargesCacheWritePremium(modelKey);
  return {
    input: parts.input,
    output: parts.output,
    cacheWrite: parts.cacheWrite ?? (noWritePremium ? parts.input : parts.input * 1.25),
    cacheRead: parts.cacheRead ?? parts.input * 0.1,
  };
}

function perMillionToPerToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? safePerTokenRate(value / 1_000_000) : null;
}

/** One `{ input, output, cache_read?, cache_write? }` block (USD per million) as per-token rates. */
function parseRateBlock(block: unknown, modelKey?: string): TokenRates | null {
  if (!isRecord(block)) return null;
  const input = perMillionToPerToken(block.input);
  const output = perMillionToPerToken(block.output);
  if (input == null || output == null) return null;
  return fillMissingPriceFields({
    input,
    output,
    cacheWrite: perMillionToPerToken(block.cache_write),
    cacheRead: perMillionToPerToken(block.cache_read),
  }, modelKey);
}

/**
 * models.dev long-context pricing. `cost.tiers` carries the real threshold
 * (`{ tier: { type: "context", size: 272000 } }` for GPT-6/5.6); the older
 * `cost.context_over_200k` block is the fallback when a row has no `tiers`, and
 * is a 200k approximation even for vendors whose real threshold differs.
 */
function parseModelsDevTiers(cost: ModelsDevCost, modelKey?: string): TokenPrice["tiers"] {
  const tiers: NonNullable<TokenPrice["tiers"]> = [];
  if (Array.isArray(cost.tiers)) {
    for (const raw of cost.tiers) {
      if (!isRecord(raw) || !isRecord(raw.tier)) continue;
      if (raw.tier.type !== "context") continue;
      const size = raw.tier.size;
      if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) continue;
      const rates = parseRateBlock(raw, modelKey);
      if (rates) tiers.push({ aboveContextTokens: Math.floor(size), ...rates });
    }
  }
  if (tiers.length === 0 && isRecord(cost.context_over_200k)) {
    const rates = parseRateBlock(cost.context_over_200k, modelKey);
    if (rates) tiers.push({ aboveContextTokens: 200_000, ...rates });
  }
  if (tiers.length === 0) return undefined;
  return tiers.sort((a, b) => a.aboveContextTokens - b.aboveContextTokens);
}

/** A models.dev `cost` block (USD per million tokens) as per-token rates. */
function parseModelsDevCost(cost: ModelsDevCost | undefined, modelKey?: string): TokenPrice | null {
  if (!cost) return null;
  const base = parseRateBlock(cost, modelKey);
  if (!base) return null;
  const tiers = parseModelsDevTiers(cost, modelKey);
  return tiers ? { ...base, tiers } : base;
}

/**
 * Rates keyed two ways: the bare model id priced at its vendor's own row
 * (`claude-sonnet-4-5`), and `provider/model` for every provider that lists it
 * (`openrouter/anthropic/claude-sonnet-4-5`), so a runtime that reports the
 * route it used is billed at that route's price.
 */
function parseModelsDevPricing(data: unknown): Map<string, TokenPrice> | null {
  const pricing = new Map<string, TokenPrice>();
  forEachModelsDevEntry(data, (providerId, modelKey, entry) => {
    const price = parseModelsDevCost(entry.cost, modelKey);
    if (price) pricing.set(`${providerId}/${modelKey}`.toLowerCase(), price);
  });
  for (const [bareId, { entry }] of pickModelsDevEntries(data)) {
    const price = parseModelsDevCost(entry.cost, bareId);
    if (price) pricing.set(bareId, price);
  }
  return pricing.size > 0 ? pricing : null;
}

function parseCachedTokenRates(entry: unknown): TokenRates | null {
  if (!isRecord(entry)) return null;
  const input = safePerTokenRate(entry.inputCostPerToken ?? entry.input);
  const output = safePerTokenRate(entry.outputCostPerToken ?? entry.output);
  if (input == null || output == null) return null;
  return fillMissingPriceFields({
    input,
    output,
    cacheWrite: safePerTokenRate(entry.cacheWriteCostPerToken ?? entry.cacheWrite),
    cacheRead: safePerTokenRate(entry.cacheReadCostPerToken ?? entry.cacheRead),
  });
}

function parseCachedTokenPrice(entry: unknown): TokenPrice | null {
  const base = parseCachedTokenRates(entry);
  if (!base || !isRecord(entry) || !Array.isArray(entry.tiers)) return base;
  const tiers: NonNullable<TokenPrice["tiers"]> = [];
  for (const raw of entry.tiers) {
    if (!isRecord(raw)) continue;
    const above = raw.aboveContextTokens;
    if (typeof above !== "number" || !Number.isFinite(above) || above <= 0) continue;
    const rates = parseCachedTokenRates(raw);
    if (rates) tiers.push({ aboveContextTokens: above, ...rates });
  }
  return tiers.length > 0 ? { ...base, tiers: tiers.sort((a, b) => a.aboveContextTokens - b.aboveContextTokens) } : base;
}

function parseCachedPricingMap(data: unknown): Map<string, TokenPrice> | null {
  if (!isRecord(data)) return null;
  const pricing = new Map<string, TokenPrice>();
  for (const [modelName, rawEntry] of Object.entries(data)) {
    const price = parseCachedTokenPrice(rawEntry);
    if (price) pricing.set(modelName, price);
  }
  return pricing.size > 0 ? pricing : null;
}

function readPricingCacheFile(cachePath: string): { timestamp: number; pricing: Map<string, TokenPrice> } | null {
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== PRICING_CACHE_FORMAT_VERSION) return null;
    const timestamp = typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp) ? parsed.timestamp : 0;
    const pricing = parseCachedPricingMap(parsed.data);
    if (!pricing) return null;
    return { timestamp, pricing };
  } catch {
    return null;
  }
}

function installDynamicTokenPricing(pricing: Map<string, TokenPrice>, timestamp: number): number {
  dynamicTokenPricing = pricing;
  dynamicTokenPricingTimestamp = timestamp;
  dynamicTokenPricingLoaded = true;
  sortedDynamicPricingKeys = null;
  return dynamicTokenPricing.size;
}

function loadDynamicTokenPricingFromDisk(): number {
  if (disableDiskCacheForTest) {
    dynamicTokenPricingLoaded = true;
    return 0;
  }

  const oldestUsableTimestamp = Date.now() - PRICING_CACHE_MAX_AGE_MS;
  const caches = [readPricingCacheFile(ADE_PRICING_CACHE_PATH)]
    .filter((cache): cache is { timestamp: number; pricing: Map<string, TokenPrice> } => !!cache)
    // See PRICING_CACHE_MAX_AGE_MS: a long-abandoned cache is dropped rather
    // than pricing this year's usage at last year's rates.
    .filter((cache) => cache.timestamp >= oldestUsableTimestamp);

  if (caches.length === 0) {
    dynamicTokenPricingLoaded = true;
    return 0;
  }

  return installDynamicTokenPricing(caches[0]!.pricing, caches[0]!.timestamp);
}

function ensureDynamicTokenPricingLoaded(): void {
  if (!dynamicTokenPricingLoaded) {
    loadDynamicTokenPricingFromDisk();
    return;
  }
  // A long-lived process whose refreshes all fail must age out the same way a
  // restart would (PRICING_CACHE_MAX_AGE_MS), handing lookups to the registry.
  if (
    dynamicTokenPricing.size > 0
    && dynamicTokenPricingTimestamp > 0
    && Date.now() - dynamicTokenPricingTimestamp > PRICING_CACHE_MAX_AGE_MS
  ) {
    installDynamicTokenPricing(new Map(), 0);
  }
}

async function fetchModelsDevPricing(): Promise<Map<string, TokenPrice>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(MODELS_DEV_API_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    const pricing = parseModelsDevPricing(payload);
    if (!pricing) throw new Error("empty pricing payload");
    return pricing;
  } finally {
    clearTimeout(timer);
  }
}

function pricingCacheFileBody(pricing: Map<string, TokenPrice>, timestamp: number): string {
  return JSON.stringify({ version: PRICING_CACHE_FORMAT_VERSION, timestamp, data: Object.fromEntries(pricing) });
}

async function writeAdePricingCache(pricing: Map<string, TokenPrice>, timestamp: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(ADE_PRICING_CACHE_PATH), { recursive: true });
  await fs.promises.writeFile(ADE_PRICING_CACHE_PATH, pricingCacheFileBody(pricing, timestamp));
}

export async function refreshDynamicTokenPricing(logger?: PricingLogger): Promise<number> {
  ensureDynamicTokenPricingLoaded();
  if (dynamicTokenPricing.size > 0 && Date.now() - dynamicTokenPricingTimestamp < PRICING_CACHE_TTL_MS) {
    return dynamicTokenPricing.size;
  }
  if (refreshInFlight) return await refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const pricing = await fetchModelsDevPricing();
      const timestamp = Date.now();
      await writeAdePricingCache(pricing, timestamp).catch((error: unknown) => {
        logger?.debug?.("usage.pricing.cache_write_failed", { error: getErrorMessage(error) });
      });
      return installDynamicTokenPricing(pricing, timestamp);
    } catch (error) {
      logger?.debug?.("usage.pricing.refresh_failed", { error: getErrorMessage(error) });
      return dynamicTokenPricing.size;
    } finally {
      refreshInFlight = null;
    }
  })();

  return await refreshInFlight;
}

function sortedDynamicKeys(): string[] {
  sortedDynamicPricingKeys ??= Array.from(dynamicTokenPricing.keys()).sort((a, b) => b.length - a.length);
  return sortedDynamicPricingKeys;
}

function findDynamicPrice(model: string, options?: { exactOnly?: boolean }): TokenPrice | null {
  const pricing = dynamicTokenPricing;
  const rawCanonical = canonicalPricingName(model);
  const canonical = resolveAlias(rawCanonical);
  // ADE's own aliases name the model a runtime actually ran, so they outrank a
  // reseller row that happens to share the raw name (models.dev lists a model
  // literally called `auto`, and a reseller's `gemini-3-flash`).
  const withPrefix = withProviderPricingName(model);
  if (canonical !== rawCanonical) {
    // `venice/claude-sonnet-4-5-thinking` → venice's own `claude-sonnet-4-5` row first.
    const routePrefix = withPrefix.endsWith(rawCanonical) ? withPrefix.slice(0, withPrefix.length - rawCanonical.length) : "";
    const aliased = (routePrefix ? pricing.get(`${routePrefix}${canonical}`) : undefined) ?? pricing.get(canonical);
    if (aliased) return aliased;
  }

  const exactWithPrefix = pricing.get(withPrefix);
  if (exactWithPrefix) return exactWithPrefix;

  const exactRawCanonical = pricing.get(rawCanonical);
  if (exactRawCanonical) return exactRawCanonical;

  const exactCanonical = pricing.get(canonical);
  if (exactCanonical) return exactCanonical;
  if (options?.exactOnly) return null;

  // A provider-qualified variant (`openrouter/anthropic/claude-sonnet-4-5-thinking`)
  // takes that provider's row before the bare vendor row.
  if (withPrefix.includes("/")) {
    for (const key of sortedDynamicKeys()) {
      if (!key.includes("/") || !withPrefix.startsWith(`${key}-`)) continue;
      if (/^\d/.test(withPrefix.slice(key.length + 1))) continue;
      return pricing.get(key) ?? null;
    }
  }

  for (const key of sortedDynamicKeys()) {
    if (canonical === key) return pricing.get(key) ?? null;
    if (!canonical.startsWith(`${key}-`)) continue;
    // `-<digit>` after a key is a different version, not a variant:
    // `claude-opus-5` is a prefix of `claude-opus-5-5` but not its price.
    if (/^\d/.test(canonical.slice(key.length + 1))) continue;
    return pricing.get(key) ?? null;
  }
  return null;
}

/**
 * Where a model's rate came from.
 *
 * `list` is models.dev (fetched, or read from its cache); `fallback` is the
 * registry / model-manifest price, or zero when nothing prices the model. Reported so a cost figure can say which — the
 * number is the page's headline and an unexplained one has burned users before.
 */
export type TokenPriceSource = "list" | "fallback";

export function tokenPriceSource(model: string): TokenPriceSource {
  return resolveTokenPriceWithSource(model).source;
}

/** When the loaded copy of the rate list was fetched. Null = none loaded. */
export function dynamicTokenPricingUpdatedAt(): number | null {
  ensureDynamicTokenPricingLoaded();
  return dynamicTokenPricing.size > 0 && dynamicTokenPricingTimestamp > 0
    ? dynamicTokenPricingTimestamp
    : null;
}

/**
 * The rate for one model. models.dev is the single source of prices:
 *
 * 1. an exact models.dev match (fetched, or its on-disk cache);
 * 2. the registry's price for that exact model — which the model manifest can
 *    set for a model models.dev has not listed yet (a launch-day model);
 * 3. the closest models.dev prefix (`claude-sonnet-4-5-thinking` → `claude-sonnet-4-5`);
 * 4. for an ADE registry alias (`opus`, `haiku`), steps 1–2 for the provider
 *    model the registry resolves it to;
 * 5. zero, reported as `fallback` so the UI can say the cost is unknown.
 */
export function resolveTokenPrice(model: string): TokenPrice {
  return resolveTokenPriceWithSource(model).price;
}

function resolveTokenPriceWithSource(model: string): { price: TokenPrice; source: TokenPriceSource } {
  ensureDynamicTokenPricingLoaded();
  const name = model ?? "";
  const priced = exactOrRegistryPrice(name);
  if (priced) return priced;

  const prefix = findDynamicPrice(name);
  if (prefix) return { price: prefix, source: "list" };

  // An ADE registry alias no rate list knows (`opus`, `haiku`, `sonnet-5`) is
  // priced as the provider model the registry launches for it. Last, so a name
  // the rate list does price is never re-pointed at a different model.
  const registryModelId = resolveModelDescriptor(name)?.providerModelId;
  if (registryModelId && registryModelId !== name) {
    const aliased = exactOrRegistryPrice(registryModelId);
    if (aliased) return aliased;
  }
  return { price: ZERO_PRICE, source: "fallback" };
}

function exactOrRegistryPrice(model: string): { price: TokenPrice; source: TokenPriceSource } | null {
  const exact = findDynamicPrice(model, { exactOnly: true });
  if (exact) return { price: exact, source: "list" };
  const registryPrice = getModelListPrice(resolveAlias(canonicalPricingName(model)));
  return registryPrice ? { price: tokenPrice(registryPrice.input, registryPrice.output), source: "fallback" } : null;
}

/**
 * DeepSeek's published peak window (UTC, Monday–Friday 01:00–04:00 and
 * 06:00–10:00) bills every rate at twice the off-peak price that models.dev
 * lists. Chinese public holidays are off-peak upstream; ADE does not model
 * them, so a holiday request is priced as peak.
 */
function isDeepSeekPeak(timestampMs: number): boolean {
  const at = new Date(timestampMs);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * DeepSeek's own API only. The peak window is DeepSeek's pricing, so a
 * reseller route (`openrouter/deepseek/…`, `deepseek-ai/…` on Together) keeps
 * the reseller's flat rate.
 */
function isFirstPartyDeepSeekModel(model: string): boolean {
  const key = withProviderPricingName(model);
  const slash = key.indexOf("/");
  return slash < 0 ? key.startsWith("deepseek-") : key.slice(0, slash) === "deepseek";
}

function scaleRates(rates: TokenRates, factor: number): TokenRates {
  return {
    input: rates.input * factor,
    output: rates.output * factor,
    cacheWrite: rates.cacheWrite * factor,
    cacheRead: rates.cacheRead * factor,
  };
}

/**
 * The rates that bill ONE model request: the long-context tier its context
 * lands in (only when the caller knows the request's own context size — a
 * turn or session total must not be passed here, or it would be billed at the
 * long rate), then DeepSeek's peak-hour doubling when a timestamp is given.
 */
export function ratesForRequest(
  model: string,
  price: TokenPrice,
  request: { contextTokens?: number | null; timestampMs?: number | null } = {},
): TokenRates {
  let rates: TokenRates = { input: price.input, output: price.output, cacheWrite: price.cacheWrite, cacheRead: price.cacheRead };
  const context = request.contextTokens;
  if (price.tiers?.length && typeof context === "number" && Number.isFinite(context) && context > 0) {
    for (const tier of price.tiers) {
      if (context > tier.aboveContextTokens) {
        rates = { input: tier.input, output: tier.output, cacheWrite: tier.cacheWrite, cacheRead: tier.cacheRead };
      }
    }
  }
  const at = request.timestampMs;
  if (typeof at === "number" && Number.isFinite(at) && at > 0 && isFirstPartyDeepSeekModel(model) && isDeepSeekPeak(at)) {
    rates = scaleRates(rates, 2);
  }
  return rates;
}

/** Token counts for one priced request or turn; `cacheWrite1h` is a subset of `cacheWrite`. */
export type PricedTokenSplit = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
};

/**
 * Dollars for a token split at the given rates. The one formula the Usage tab
 * and the per-turn ledger share: a one-hour cache write costs
 * `ONE_HOUR_CACHE_WRITE_MULTIPLIER` times a five-minute one.
 */
export function priceTokenSplit(rates: TokenRates, split: PricedTokenSplit): number {
  const cacheWrite = Math.max(0, split.cacheWrite);
  const oneHour = Math.min(Math.max(0, split.cacheWrite1h ?? 0), cacheWrite);
  return (
    Math.max(0, split.input) * rates.input
    + Math.max(0, split.output) * rates.output
    + (cacheWrite - oneHour) * rates.cacheWrite
    + oneHour * rates.cacheWrite * ONE_HOUR_CACHE_WRITE_MULTIPLIER
    + Math.max(0, split.cacheRead) * rates.cacheRead
  );
}

export function isZeroTokenPrice(price: TokenPrice): boolean {
  return price.input === 0 && price.output === 0 && price.cacheWrite === 0 && price.cacheRead === 0;
}

export function resetDynamicTokenPricingForTest(options?: { disableDiskCache?: boolean }): void {
  dynamicTokenPricingLoaded = false;
  dynamicTokenPricingTimestamp = 0;
  dynamicTokenPricing = new Map();
  sortedDynamicPricingKeys = null;
  refreshInFlight = null;
  disableDiskCacheForTest = options?.disableDiskCache ?? false;
}

export function setDynamicTokenPricingForTest(entries: Record<string, TokenPrice>): void {
  disableDiskCacheForTest = true;
  const pricing = new Map<string, TokenPrice>();
  for (const [modelName, price] of Object.entries(entries)) {
    pricing.set(withProviderPricingName(modelName), price);
    pricing.set(canonicalPricingName(modelName), price);
  }
  installDynamicTokenPricing(pricing, Date.now());
}

/** Install a models.dev payload exactly as a successful fetch would. */
export function installModelsDevPricingForTest(payload: unknown): number {
  disableDiskCacheForTest = true;
  return installDynamicTokenPricing(parseModelsDevPricing(payload) ?? new Map(), Date.now());
}

export const _testing = {
  canonicalPricingName,
  chargesCacheWritePremium,
  isDeepSeekPeak,
  parseCachedPricingMap,
  pricingCacheFileBody,
  readPricingCacheFile,
  installModelsDevPricingForTest,
  parseModelsDevPricing,
  resetDynamicTokenPricingForTest,
  setDynamicTokenPricingForTest,
};
