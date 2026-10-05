import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AdeUsageModelPrice } from "../../../shared/types/usage";
import { isRecord, writeTextAtomic } from "../shared/utils";
import type { TokenPrice } from "./usagePricing";

/**
 * Prices the user set and model ids they mapped onto another model, kept on
 * this machine in its ADE home. The ledger worker is a fresh
 * process per scan and reads the file when it starts; the brain re-reads it
 * when a setter writes it.
 */
/** Under the machine's ADE home, so an isolated runtime (`ADE_HOME`) keeps its own prices. */
function priceOverridesPath(): string {
  return path.join(resolveMachineAdeDir(), "usage-price-overrides.json");
}
const PRICE_OVERRIDES_FORMAT_VERSION = 1;

/** USD per million tokens, as the user typed them. */
export type UsagePriceOverride = AdeUsageModelPrice;

export type UsagePriceOverridesFile = {
  version: 1;
  prices: Record<string, UsagePriceOverride>;
  /** `from` model id → the model its usage counts as. */
  aliases: Record<string, string>;
};

type LoadedPriceOverrides = { prices: Map<string, TokenPrice>; aliases: Map<string, string>; file: UsagePriceOverridesFile };

let loadedPriceOverrides: LoadedPriceOverrides | null = null;

/** Override and alias keys match a model id however its runtime spelled it. */
export function usagePriceOverrideKey(model: string): string {
  return (model ?? "").trim().toLowerCase();
}

/**
 * Model ids are keys, and a model id can be any string (`constructor`,
 * `__proto__`), so the records carry no prototype to collide with.
 */
function emptyPriceOverridesFile(): UsagePriceOverridesFile {
  return { version: PRICE_OVERRIDES_FORMAT_VERSION, prices: Object.create(null), aliases: Object.create(null) };
}

function parsePriceOverridesFile(raw: unknown): UsagePriceOverridesFile {
  const file = emptyPriceOverridesFile();
  if (!isRecord(raw) || raw.version !== PRICE_OVERRIDES_FORMAT_VERSION) return file;
  if (isRecord(raw.prices)) {
    for (const [model, value] of Object.entries(raw.prices)) {
      const override = normalizePriceOverride(value);
      const key = usagePriceOverrideKey(model);
      if (override && key) file.prices[key] = override;
    }
  }
  if (isRecord(raw.aliases)) {
    for (const [from, to] of Object.entries(raw.aliases)) {
      const fromKey = usagePriceOverrideKey(from);
      const target = typeof to === "string" ? to.trim() : "";
      if (fromKey && target && usagePriceOverrideKey(target) !== fromKey) file.aliases[fromKey] = target;
    }
  }
  return file;
}

export function normalizePriceOverride(value: unknown): UsagePriceOverride | null {
  if (!isRecord(value)) return null;
  const rate = (field: unknown): number | null => (typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= 1_000_000 ? field : null);
  const input = rate(value.input);
  const output = rate(value.output);
  if (input == null || output == null) return null;
  // A cache rate is optional, but one that was sent and is not a valid rate
  // rejects the price: dropping it would quietly bill those tokens at input.
  const cacheRead = rate(value.cacheRead);
  const cacheWrite = rate(value.cacheWrite);
  if ((value.cacheRead != null && cacheRead == null) || (value.cacheWrite != null && cacheWrite == null)) return null;
  return { input, output, ...(cacheRead != null ? { cacheRead } : {}), ...(cacheWrite != null ? { cacheWrite } : {}) };
}

function loadPriceOverrides(): LoadedPriceOverrides {
  let file = emptyPriceOverridesFile();
  try {
    file = parsePriceOverridesFile(JSON.parse(fs.readFileSync(priceOverridesPath(), "utf8")) as unknown);
  } catch {
    // No file, or an unreadable one: no overrides.
  }
  const prices = new Map<string, TokenPrice>();
  for (const [model, override] of Object.entries(file.prices)) {
    // A blank cache rate bills at the input rate, as the user would expect
    // from leaving it empty; 0 means the tokens are free.
    prices.set(model, {
      input: override.input / 1_000_000,
      output: override.output / 1_000_000,
      cacheRead: (override.cacheRead ?? override.input) / 1_000_000,
      cacheWrite: (override.cacheWrite ?? override.input) / 1_000_000,
    });
  }
  return { prices, aliases: new Map(Object.entries(file.aliases)), file };
}

function usagePriceOverrides(): LoadedPriceOverrides {
  loadedPriceOverrides ??= loadPriceOverrides();
  return loadedPriceOverrides;
}

export function readUsagePriceOverrides(): UsagePriceOverridesFile {
  return usagePriceOverrides().file;
}

/** The price the user set for a model, as per-token rates; null when none. */
export function customTokenPrice(model: string): TokenPrice | null {
  return usagePriceOverrides().prices.get(usagePriceOverrideKey(model)) ?? null;
}

/**
 * The model a usage record counts as. Follows a chain of mappings to its end
 * and stops at a loop, so `a → b → a` leaves `a` as itself.
 */
export function applyUsageModelAlias(model: string): string {
  const aliases = usagePriceOverrides().aliases;
  if (aliases.size === 0) return model;
  let current = model;
  const seen = new Set<string>([usagePriceOverrideKey(model)]);
  for (let hop = 0; hop < 16; hop += 1) {
    const next = aliases.get(usagePriceOverrideKey(current));
    if (!next) break;
    const key = usagePriceOverrideKey(next);
    if (seen.has(key)) return model;
    seen.add(key);
    current = next;
  }
  return current;
}

/**
 * Writes one change to the overrides file and reloads it. `price: null`
 * removes a model's price; `mapTo: null` removes its mapping. Mapping a model
 * drops its own price: its usage is priced as the target from then on.
 *
 * Every model id in `models` gets the same change: one display name can stand
 * for several raw ids (a dated id, a `[1m]` variant). The change is applied to
 * the file as it is on disk now, not this process's copy, so another writer's
 * change made since (the brain and an in-process service, two brains) survives.
 */
export function updateUsagePriceOverrides(change: {
  models: readonly string[];
  price?: UsagePriceOverride | null;
  mapTo?: string | null;
}): UsagePriceOverridesFile {
  const keys = [...new Set(change.models.map(usagePriceOverrideKey).filter(Boolean))];
  if (keys.length === 0) throw new Error("A model id is required.");
  const normalized = change.price ? normalizePriceOverride(change.price) : null;
  if (change.price && !normalized) throw new Error("A price needs input and output rates in USD per million tokens.");
  const target = change.mapTo?.trim() ?? "";
  const file = loadPriceOverrides().file;
  for (const key of keys) {
    if (change.price !== undefined) {
      if (normalized) file.prices[key] = normalized;
      else delete file.prices[key];
    }
    if (change.mapTo !== undefined) {
      if (!target || usagePriceOverrideKey(target) === key) delete file.aliases[key];
      else {
        file.aliases[key] = target;
        delete file.prices[key];
      }
    }
  }
  writeTextAtomic(priceOverridesPath(), `${JSON.stringify(file, null, 2)}\n`);
  loadedPriceOverrides = null;
  return readUsagePriceOverrides();
}
