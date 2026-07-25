import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ADE_PRICING_CACHE_PATH = path.join(os.homedir(), ".ade", "litellm-pricing.json");
const CODEBURN_PRICING_CACHE_PATH = path.join(os.homedir(), ".cache", "codeburn", "litellm-pricing.json");

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

const STATIC_TOKEN_PRICES: Record<string, TokenPrice> = {
  "claude-3-opus": tokenPrice(15, 75, 1.5, 18.75),
  "claude-3-5-haiku": tokenPrice(0.8, 4, 0.08, 1),
  "claude-3-5-sonnet": tokenPrice(3, 15, 0.3, 3.75),
  "claude-3-7-sonnet": tokenPrice(3, 15, 0.3, 3.75),
  "claude-3-haiku": tokenPrice(0.25, 1.25, 0.03, 0.3),
  "claude-fable-5": tokenPrice(10, 50, 1, 12.5),
  "claude-opus-5": tokenPrice(5, 25, 0.5, 6.25),
  "claude-opus-4-1": tokenPrice(15, 75, 1.5, 18.75),
  "claude-opus-4": tokenPrice(15, 75, 1.5, 18.75),
  "claude-opus-4-8": tokenPrice(5, 25, 0.5, 6.25),
  "claude-opus-4-7": tokenPrice(5, 25, 0.5, 6.25),
  "claude-opus-4-6": tokenPrice(5, 25, 0.5, 6.25),
  "claude-opus-4-5": tokenPrice(5, 25, 0.5, 6.25),
  "claude-sonnet-5": tokenPrice(2, 10, 0.2, 2.5),
  "claude-sonnet-4-6": tokenPrice(3, 15, 0.3, 3.75),
  "claude-sonnet-4-5": tokenPrice(3, 15, 0.3, 3.75),
  "claude-sonnet-4": tokenPrice(3, 15, 0.3, 3.75),
  "claude-haiku-4-5": tokenPrice(1, 5, 0.1, 1.25),
  "claude-opus": tokenPrice(5, 25),
  "claude-sonnet": tokenPrice(3, 15),
  "claude-haiku": tokenPrice(1, 5),
  "gpt-5.6-sol": tokenPrice(5, 30, 0.5),
  "gpt-5.6-terra": tokenPrice(2.5, 15, 0.25),
  "gpt-5.6-luna": tokenPrice(1, 6, 0.1),
  "gpt-5.5-pro": tokenPrice(30, 180, 3),
  "gpt-5.5": tokenPrice(5, 30, 0.5),
  "gpt-5.4-pro": tokenPrice(30, 180, 3),
  "gpt-5.4-mini": tokenPrice(0.75, 4.5, 0.075),
  "gpt-5.4-nano": tokenPrice(0.2, 1.25, 0.02),
  "gpt-5.4": tokenPrice(2.5, 15, 0.25),
  "gpt-5.3-codex": tokenPrice(1.75, 14, 0.175),
  "gpt-5.2-pro": tokenPrice(21, 168),
  "gpt-5.1-codex-mini": tokenPrice(0.25, 2, 0.025),
  "gpt-5.1-codex": tokenPrice(1.25, 10, 0.125),
  "gpt-5.1": tokenPrice(1.25, 10, 0.125),
  "gpt-5.2": tokenPrice(1.75, 14, 0.175),
  "gpt-5-pro": tokenPrice(15, 120),
  "gpt-5-mini": tokenPrice(0.25, 2, 0.025),
  "gpt-5-nano": tokenPrice(0.05, 0.4, 0.005),
  "gpt-5": tokenPrice(1.25, 10, 0.125),
  "gpt-4.1-nano": tokenPrice(0.1, 0.4, 0.025),
  "gpt-4.1-mini": tokenPrice(0.4, 1.6, 0.1),
  "gpt-4.1": tokenPrice(2, 8, 0.5),
  "gpt-4o-mini": tokenPrice(0.15, 0.6, 0.075),
  "gpt-4o": tokenPrice(2.5, 10, 1.25),
  "o4-mini": tokenPrice(1.1, 4.4, 0.275),
  "o3": tokenPrice(2, 8, 0.5),
  "codex-mini-latest": tokenPrice(1.5, 6, 0.375),
  "gemini-2.5-pro": tokenPrice(1.25, 10, 0.125),
  "gemini-2.5-flash": tokenPrice(0.3, 2.5, 0.03),
  "gemini-3-pro-preview": tokenPrice(2, 12, 0.2),
  "gemini-3.1-pro-preview": tokenPrice(2, 12, 0.2),
  "gemini-3-flash-preview": tokenPrice(0.5, 3, 0.05),
  "gemini-3.5-flash": tokenPrice(1.5, 9, 0.15),
  "gemini-3.1-flash-image-preview": tokenPrice(0.5, 3, 0.05),
  "gemini-3.1-flash-lite-preview": tokenPrice(0.25, 1.5, 0.025),
  "grok-code-fast-1": tokenPrice(0.2, 1.5, 0.02),
  "grok-code-fast": tokenPrice(0.2, 1.5, 0.02),
  "kimi-k2.5": tokenPrice(0.6, 3, 0.06),
  "kimi-k2-thinking": tokenPrice(0.6, 2.5, 0.15),
  "codex": tokenPrice(1.25, 10, 0.125),
};

const BUILTIN_PRICING_ALIASES: Record<string, string> = {
  auto: "claude-sonnet-5",
  fable: "claude-fable-5",
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
  "anthropic--claude-4.6-opus": "claude-opus-4-6",
  "anthropic--claude-4.6-sonnet": "claude-sonnet-5",
  "anthropic--claude-4.5-opus": "claude-opus-4-5",
  "anthropic--claude-4.5-sonnet": "claude-sonnet-4-5",
  "anthropic--claude-4.5-haiku": "claude-haiku-4-5",
  "claude-sonnet-4.6": "claude-sonnet-5",
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
  "claude-4.6-sonnet": "claude-sonnet-5",
  "claude-4.6-sonnet-high": "claude-sonnet-5",
  "claude-4.6-sonnet-low": "claude-sonnet-5",
  "claude-4.6-sonnet-thinking": "claude-sonnet-5",
  "claude-4.6-sonnet-high-thinking": "claude-sonnet-5",
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
let sortedStaticPricingKeys: string[] | null = null;
let refreshInFlight: Promise<number> | null = null;
let disableDiskCacheForTest = false;

function normalizeModelVersion(model: string): string {
  return model.trim().replace(/@.*$/, "").replace(/-\d{8}$/, "");
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

function parseLiteLlmEntry(entry: unknown): TokenPrice | null {
  if (!isRecord(entry)) return null;
  const input = safePerTokenRate(entry.input_cost_per_token);
  const output = safePerTokenRate(entry.output_cost_per_token);
  if (input == null || output == null) return null;
  const cacheWrite = safePerTokenRate(entry.cache_creation_input_token_cost) ?? input * 1.25;
  const cacheRead = safePerTokenRate(entry.cache_read_input_token_cost) ?? input * 0.1;
  return { input, output, cacheWrite, cacheRead };
}

function parseCachedTokenPrice(entry: unknown): TokenPrice | null {
  if (!isRecord(entry)) return null;
  const input = safePerTokenRate(entry.inputCostPerToken ?? entry.input);
  const output = safePerTokenRate(entry.outputCostPerToken ?? entry.output);
  if (input == null || output == null) return null;
  const cacheWrite = safePerTokenRate(entry.cacheWriteCostPerToken ?? entry.cacheWrite) ?? input * 1.25;
  const cacheRead = safePerTokenRate(entry.cacheReadCostPerToken ?? entry.cacheRead) ?? input * 0.1;
  return { input, output, cacheWrite, cacheRead };
}

function parsePricingMap(data: unknown): Map<string, TokenPrice> | null {
  if (!isRecord(data)) return null;
  const pricing = new Map<string, TokenPrice>();
  for (const [modelName, rawEntry] of Object.entries(data)) {
    const price = parseCachedTokenPrice(rawEntry) ?? parseLiteLlmEntry(rawEntry);
    if (!price) continue;
    const withPrefix = withProviderPricingName(modelName);
    pricing.set(withPrefix, price);

    const canonical = canonicalPricingName(modelName);
    if (canonical !== withPrefix && !pricing.has(canonical)) {
      pricing.set(canonical, price);
    }
  }
  return pricing.size > 0 ? pricing : null;
}

function readPricingCacheFile(cachePath: string): { timestamp: number; pricing: Map<string, TokenPrice> } | null {
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const timestamp = typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp) ? parsed.timestamp : 0;
    const pricing = parsePricingMap(parsed.data);
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

  const caches = [readPricingCacheFile(ADE_PRICING_CACHE_PATH), readPricingCacheFile(CODEBURN_PRICING_CACHE_PATH)]
    .filter((cache): cache is { timestamp: number; pricing: Map<string, TokenPrice> } => !!cache)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (caches.length === 0) {
    dynamicTokenPricingLoaded = true;
    return 0;
  }

  return installDynamicTokenPricing(caches[0]!.pricing, caches[0]!.timestamp);
}

function ensureDynamicTokenPricingLoaded(): void {
  if (!dynamicTokenPricingLoaded) {
    loadDynamicTokenPricingFromDisk();
  }
}

async function fetchLiteLlmPricing(): Promise<Map<string, TokenPrice>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(LITELLM_PRICING_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    const pricing = parsePricingMap(payload);
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
      const pricing = await fetchLiteLlmPricing();
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

function sortedKeysFor(pricing: Map<string, TokenPrice>, kind: "dynamic" | "static"): string[] {
  if (kind === "dynamic") {
    sortedDynamicPricingKeys ??= Array.from(pricing.keys()).sort((a, b) => b.length - a.length);
    return sortedDynamicPricingKeys;
  }
  sortedStaticPricingKeys ??= Array.from(pricing.keys()).sort((a, b) => b.length - a.length);
  return sortedStaticPricingKeys;
}

function findPriceInMap(pricing: Map<string, TokenPrice>, model: string, kind: "dynamic" | "static"): TokenPrice | null {
  const withPrefix = withProviderPricingName(model);
  const exactWithPrefix = pricing.get(withPrefix);
  if (exactWithPrefix) return exactWithPrefix;

  const rawCanonical = canonicalPricingName(model);
  const exactRawCanonical = pricing.get(rawCanonical);
  if (exactRawCanonical) return exactRawCanonical;

  const canonical = resolveAlias(rawCanonical);
  const exactCanonical = pricing.get(canonical);
  if (exactCanonical) return exactCanonical;

  for (const key of sortedKeysFor(pricing, kind)) {
    if (canonical === key || canonical.startsWith(`${key}-`)) {
      return pricing.get(key) ?? null;
    }
  }
  return null;
}

function getStaticPricingMap(): Map<string, TokenPrice> {
  return new Map(Object.entries(STATIC_TOKEN_PRICES));
}

export function resolveTokenPrice(model: string): TokenPrice {
  ensureDynamicTokenPricingLoaded();
  const dynamicPrice = findPriceInMap(dynamicTokenPricing, model ?? "", "dynamic");
  if (dynamicPrice) return dynamicPrice;

  const staticPrice = findPriceInMap(getStaticPricingMap(), model ?? "", "static");
  if (staticPrice) return staticPrice;

  const canonical = canonicalPricingName(model ?? "");
  if (canonical.includes("opus")) return STATIC_TOKEN_PRICES["claude-opus"] ?? ZERO_PRICE;
  if (canonical.includes("sonnet")) return STATIC_TOKEN_PRICES["claude-sonnet"] ?? ZERO_PRICE;
  if (canonical.includes("haiku")) return STATIC_TOKEN_PRICES["claude-haiku"] ?? ZERO_PRICE;
  if (canonical.includes("codex") || canonical.includes("gpt") || canonical.includes("o3") || canonical.includes("o4")) {
    return STATIC_TOKEN_PRICES.codex ?? ZERO_PRICE;
  }

  return ZERO_PRICE;
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

export const _testing = {
  canonicalPricingName,
  parseLiteLlmEntry,
  parsePricingMap,
  resetDynamicTokenPricingForTest,
  setDynamicTokenPricingForTest,
};
