import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModelListPrice, resolveModelDescriptor } from "../../../shared/modelRegistry";
import { forEachModelsDevEntry, MODELS_DEV_API_URL, pickModelsDevEntries, type ModelsDevCost } from "../ai/modelsDevCatalog";
import { isRecord } from "../shared/utils";

export type TokenPrice = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
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

/** models.dev omits cache rates for some rows; use the conventional ratios. */
function fillMissingPriceFields(
  parts: { input: number; output: number; cacheWrite: number | null; cacheRead: number | null },
): TokenPrice {
  return {
    input: parts.input,
    output: parts.output,
    cacheWrite: parts.cacheWrite ?? parts.input * 1.25,
    cacheRead: parts.cacheRead ?? parts.input * 0.1,
  };
}

/** A models.dev `cost` block (USD per million tokens) as per-token rates. */
function parseModelsDevCost(cost: ModelsDevCost | undefined): TokenPrice | null {
  if (!cost) return null;
  const perToken = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? safePerTokenRate(value / 1_000_000) : null;
  const input = perToken(cost.input);
  const output = perToken(cost.output);
  if (input == null || output == null) return null;
  return fillMissingPriceFields({
    input,
    output,
    cacheWrite: perToken(cost.cache_write),
    cacheRead: perToken(cost.cache_read),
  });
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
    const price = parseModelsDevCost(entry.cost);
    if (price) pricing.set(`${providerId}/${modelKey}`.toLowerCase(), price);
  });
  for (const [bareId, { entry }] of pickModelsDevEntries(data)) {
    const price = parseModelsDevCost(entry.cost);
    if (price) pricing.set(bareId, price);
  }
  return pricing.size > 0 ? pricing : null;
}

function parseCachedTokenPrice(entry: unknown): TokenPrice | null {
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
    if (!isRecord(parsed)) return null;
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

async function writeAdePricingCache(pricing: Map<string, TokenPrice>, timestamp: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(ADE_PRICING_CACHE_PATH), { recursive: true });
  await fs.promises.writeFile(ADE_PRICING_CACHE_PATH, JSON.stringify({ timestamp, data: Object.fromEntries(pricing) }));
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
        logger?.debug?.("usage.pricing.cache_write_failed", { error: error instanceof Error ? error.message : String(error) });
      });
      return installDynamicTokenPricing(pricing, timestamp);
    } catch (error) {
      logger?.debug?.("usage.pricing.refresh_failed", { error: error instanceof Error ? error.message : String(error) });
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
  installModelsDevPricingForTest,
  parseModelsDevPricing,
  resetDynamicTokenPricingForTest,
  setDynamicTokenPricingForTest,
};
