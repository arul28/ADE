import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _testing, priceTokenSplitDetailed, ratesForRequest, resolveTokenPrice, tokenPrice } from "./usagePricing";

const PER_M = 1 / 1_000_000;
// Rates are USD per token (~1e-5). Compare them in USD per million: the
// default `toBeCloseTo` precision (0.005) would pass any per-token rate.

function install(payload: unknown): void {
  _testing.installModelsDevPricingForTest(payload);
}

afterEach(() => {
  _testing.resetDynamicTokenPricingForTest({ disableDiskCache: true });
});

describe("long-context tiers", () => {
  it("bills a request above the models.dev tier threshold at the tier rate", () => {
    install({
      openai: {
        models: {
          "gpt-6-sol": {
            cost: {
              input: 2, output: 10, cache_read: 0.2, cache_write: 2.5,
              tiers: [{ input: 4, output: 15, cache_read: 0.4, cache_write: 5, tier: { type: "context", size: 272000 } }],
              context_over_200k: { input: 4, output: 15, cache_read: 0.4, cache_write: 5 },
            },
          },
        },
      },
    });
    const price = resolveTokenPrice("gpt-6-sol");
    expect(price.tiers).toHaveLength(1);
    const tier = price.tiers![0]!;
    expect(tier.aboveContextTokens).toBe(272000);
    expect((tier.input) / PER_M).toBeCloseTo(4);
    expect((tier.output) / PER_M).toBeCloseTo(15);
    expect((tier.cacheRead) / PER_M).toBeCloseTo(0.4);
    expect((tier.cacheWrite) / PER_M).toBeCloseTo(5);
    // `tiers` carries the real 272k threshold; the 200k legacy block is ignored.
    expect((ratesForRequest("gpt-6-sol", price, { contextTokens: 250_000 }).input) / PER_M).toBeCloseTo(2);
    expect((ratesForRequest("gpt-6-sol", price, { contextTokens: 272_000 }).input) / PER_M).toBeCloseTo(2);
    expect((ratesForRequest("gpt-6-sol", price, { contextTokens: 272_001 }).input) / PER_M).toBeCloseTo(4);
    expect((ratesForRequest("gpt-6-sol", price, { contextTokens: 272_001 }).cacheRead) / PER_M).toBeCloseTo(0.4);
  });

  it("falls back to context_over_200k when a row has no tiers", () => {
    install({ xai: { models: { "grok-4.7": { cost: { input: 2, output: 6, cache_read: 0.5, context_over_200k: { input: 4, output: 12, cache_read: 1 } } } } } });
    const price = resolveTokenPrice("grok-4.7");
    expect((ratesForRequest("grok-4.7", price, { contextTokens: 199_999 }).output) / PER_M).toBeCloseTo(6);
    expect((ratesForRequest("grok-4.7", price, { contextTokens: 400_000 }).output) / PER_M).toBeCloseTo(12);
  });

  it("walks multiple tiers in order and ignores an unknown context", () => {
    install({
      alibaba: {
        models: {
          "qwen3-coder-480b-a35b-instruct": {
            cost: {
              input: 1.5, output: 7.5,
              tiers: [
                { input: 4.5, output: 22.5, tier: { type: "context", size: 128000 } },
                { input: 2.7, output: 13.5, tier: { type: "context", size: 32000 } },
              ],
            },
          },
        },
      },
    });
    const price = resolveTokenPrice("qwen3-coder-480b-a35b-instruct");
    expect((ratesForRequest("qwen3-coder-480b-a35b-instruct", price, { contextTokens: 10_000 }).input) / PER_M).toBeCloseTo(1.5);
    expect((ratesForRequest("qwen3-coder-480b-a35b-instruct", price, { contextTokens: 64_000 }).input) / PER_M).toBeCloseTo(2.7);
    expect((ratesForRequest("qwen3-coder-480b-a35b-instruct", price, { contextTokens: 200_000 }).input) / PER_M).toBeCloseTo(4.5);
    // A turn or session aggregate passes no context and keeps the base rate.
    expect((ratesForRequest("qwen3-coder-480b-a35b-instruct", price, {}).input) / PER_M).toBeCloseTo(1.5);
  });

  it("round-trips tiers through the on-disk cache format", () => {
    install({ xai: { models: { "grok-4.6": { cost: { input: 2, output: 6, cache_read: 0.5, context_over_200k: { input: 4, output: 12, cache_read: 1 } } } } } });
    const written = JSON.parse(JSON.stringify({ "grok-4.6": resolveTokenPrice("grok-4.6") }));
    const reread = _testing.parseCachedPricingMap(written)?.get("grok-4.6");
    expect(reread?.tiers?.[0]?.aboveContextTokens).toBe(200_000);
    expect(Number(reread?.tiers?.[0]?.input) / PER_M).toBeCloseTo(4);
  });
});

describe("on-disk pricing cache", () => {
  it("reads a cache it wrote and ignores the unversioned cache older builds wrote", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pricing-cache-"));
    try {
      const pricing = new Map([["zz-cache-model", tokenPrice(2, 10)]]);
      const current = path.join(dir, "current.json");
      fs.writeFileSync(current, _testing.pricingCacheFileBody(pricing, 1_000));
      const read = _testing.readPricingCacheFile(current);
      expect(read?.timestamp).toBe(1_000);
      expect(Number(read?.pricing.get("zz-cache-model")?.output) / PER_M).toBeCloseTo(10);

      // Version 1 had no version field, no tiers, and the old write rates.
      const legacy = path.join(dir, "legacy.json");
      fs.writeFileSync(legacy, JSON.stringify({ timestamp: 1_000, data: Object.fromEntries(pricing) }));
      expect(_testing.readPricingCacheFile(legacy)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cache write premium", () => {
  it("charges the plain input rate for a first-time prefix when the vendor lists a read rate but no write rate", () => {
    install({ deepseek: { models: { "deepseek-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } } });
    const price = resolveTokenPrice("deepseek-flash");
    expect((price.cacheWrite) / PER_M).toBeCloseTo(0.15);
    expect((price.cacheRead) / PER_M).toBeCloseTo(0.003);
  });

  it("keeps an explicit write rate and the conventional ratios for a row with no cache rates", () => {
    install({
      anthropic: { models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } },
      mistral: { models: { "mistral-large-3": { cost: { input: 2, output: 6 } } } },
    });
    expect((resolveTokenPrice("claude-opus-5-5").cacheWrite) / PER_M).toBeCloseTo(5);
    expect((resolveTokenPrice("mistral-large-3").cacheWrite) / PER_M).toBeCloseTo(2.5);
    expect((resolveTokenPrice("mistral-large-3").cacheRead) / PER_M).toBeCloseTo(0.2);
  });

  it("keeps the Claude write premium under Bedrock's model keys", () => {
    for (const key of [
      "claude-sonnet-4-5",
      "amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-opus-4-6-v1",
      "global.anthropic.claude-haiku-4-5",
    ]) {
      expect(_testing.chargesCacheWritePremium(key)).toBe(true);
    }
    expect(_testing.chargesCacheWritePremium("deepseek/deepseek-flash")).toBe(false);

    install({ "amazon-bedrock": { models: { "us.anthropic.claude-opus-4-6-v1": { cost: { input: 5, output: 25, cache_read: 0.5 } } } } });
    expect((resolveTokenPrice("amazon-bedrock/us.anthropic.claude-opus-4-6-v1").cacheWrite) / PER_M).toBeCloseTo(6.25);
  });
});

describe("DeepSeek peak hours", () => {
  const offPeakPrice = { input: 0.15 * PER_M, output: 0.6 * PER_M, cacheWrite: 0.15 * PER_M, cacheRead: 0.003 * PER_M };

  it("doubles every rate inside the published weekday UTC windows", () => {
    const mondayPeak = Date.UTC(2026, 8, 21, 2, 30); // Mon 02:30 UTC
    const mondayMorningPeak = Date.UTC(2026, 8, 21, 9, 59);
    expect((ratesForRequest("deepseek-flash", offPeakPrice, { timestampMs: mondayPeak }).cacheRead) / PER_M).toBeCloseTo(0.006);
    expect((ratesForRequest("deepseek/deepseek-flash", offPeakPrice, { timestampMs: mondayMorningPeak }).output) / PER_M).toBeCloseTo(1.2);
  });

  it("keeps off-peak rates outside the windows, on weekends, and for other vendors", () => {
    const mondayGap = Date.UTC(2026, 8, 21, 5, 0); // between the two windows
    const saturday = Date.UTC(2026, 8, 26, 2, 30);
    expect((ratesForRequest("deepseek-flash", offPeakPrice, { timestampMs: mondayGap }).input) / PER_M).toBeCloseTo(0.15);
    expect((ratesForRequest("deepseek-flash", offPeakPrice, { timestampMs: saturday }).input) / PER_M).toBeCloseTo(0.15);
    expect((ratesForRequest("kimi-k3", offPeakPrice, { timestampMs: Date.UTC(2026, 8, 21, 2, 30) }).input) / PER_M).toBeCloseTo(0.15);
  });

  it("doubles only DeepSeek's own API, not a reseller route to a DeepSeek model", () => {
    const mondayPeak = Date.UTC(2026, 8, 21, 2, 30);
    expect((ratesForRequest("deepseek-chat", offPeakPrice, { timestampMs: mondayPeak }).input) / PER_M).toBeCloseTo(0.3);
    expect((ratesForRequest("openrouter/deepseek/deepseek-chat", offPeakPrice, { timestampMs: mondayPeak }).input) / PER_M).toBeCloseTo(0.15);
    expect((ratesForRequest("deepseek-ai/DeepSeek-V3", offPeakPrice, { timestampMs: mondayPeak }).input) / PER_M).toBeCloseTo(0.15);
  });
});

describe("service tiers (Fast / Ultrafast)", () => {
  const models = {
    openai: {
      models: {
        "gpt-astra-test": {
          cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5, tiers: [{ input: 20, output: 75, cache_read: 2, cache_write: 25, tier: { type: "context", size: 272_000 } }] },
          experimental: {
            modes: {
              fast: { cost: { input: 20, output: 100, cache_read: 2, cache_write: 25 }, provider: { body: { service_tier: "priority" } } },
              ultrafast: { cost: { input: 60, output: 300, cache_read: 6, cache_write: 75 }, provider: { body: { service_tier: "ultrafast" } } },
              flex: { cost: { input: 5, output: 25 }, provider: { body: { service_tier: "flex" } } },
            },
          },
        },
        "gpt-plain-test": { cost: { input: 2, output: 10, cache_read: 0.2 } },
      },
    },
    anthropic: {
      models: {
        "claude-opus-test": {
          cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
          experimental: { modes: { fast: { cost: { input: 8, output: 40, cache_read: 0.4, cache_write: 10 }, provider: { body: { speed: "fast" } } } } },
        },
        "claude-sonnet-test": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      },
    },
  };

  it.each([
    { name: "standard keeps the base rate", model: "gpt-astra-test", speed: "standard", context: undefined, input: 10, output: 50 },
    { name: "Fast takes the published priority rate", model: "gpt-astra-test", speed: "fast", context: undefined, input: 20, output: 100 },
    { name: "Ultrafast takes its own published rate", model: "gpt-astra-test", speed: "ultrafast", context: undefined, input: 60, output: 300 },
    { name: "a long-context request scales the tier rate by the same ratio", model: "gpt-astra-test", speed: "ultrafast", context: 300_000, input: 120, output: 450 },
    { name: "Claude fast takes models.dev's fast rate", model: "claude-opus-test", speed: "fast", context: undefined, input: 8, output: 40 },
    { name: "Claude fast with no published rate falls back to 2x", model: "claude-sonnet-test", speed: "fast", context: undefined, input: 6, output: 30 },
    { name: "a tier with no published rate bills at standard", model: "gpt-plain-test", speed: "ultrafast", context: undefined, input: 2, output: 10 },
  ] as const)("$name", ({ model, speed, context, input, output }) => {
    install(models);
    const rates = ratesForRequest(model, resolveTokenPrice(model), { speed, ...(context ? { contextTokens: context } : {}) });
    expect(rates.input / PER_M).toBeCloseTo(input);
    expect(rates.output / PER_M).toBeCloseTo(output);
  });

  it("splits a request's cost by type and names the premium its tier added", () => {
    install(models);
    const detailed = priceTokenSplitDetailed("gpt-astra-test", resolveTokenPrice("gpt-astra-test"), { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 }, { speed: "ultrafast" });
    expect(detailed.byType.input).toBeCloseTo(60);
    expect(detailed.byType.output).toBeCloseTo(30);
    expect(detailed.byType.cacheRead).toBeCloseTo(12);
    expect(detailed.totalUsd).toBeCloseTo(102);
    // Standard would have been 10 + 5 + 2 = 17.
    expect(detailed.speedPremiumUsd).toBeCloseTo(85);
  });

  it("keeps the published tier rates through the on-disk cache", () => {
    install(models);
    const written = JSON.parse(JSON.stringify({ m: resolveTokenPrice("gpt-astra-test") }));
    const reread = _testing.parseCachedPricingMap(written)?.get("m");
    expect(Number(reread?.modes?.ultrafast?.input) / PER_M).toBeCloseTo(60);
    expect(Number(reread?.modes?.fast?.output) / PER_M).toBeCloseTo(100);
  });
});

describe("Claude fast mode", () => {
  const opus55 = tokenPrice(4, 20, 0.2, 5);

  it("doubles every rate for a fast request and leaves a standard one alone", () => {
    const standard = ratesForRequest("claude-opus-5-5", opus55, {});
    const fast = ratesForRequest("claude-opus-5-5", opus55, { speed: "fast" });
    expect((standard.input) / PER_M).toBeCloseTo(4);
    expect((fast.input) / PER_M).toBeCloseTo(8);
    expect((fast.output) / PER_M).toBeCloseTo(40);
    expect((fast.cacheRead) / PER_M).toBeCloseTo(0.4);
    expect((fast.cacheWrite) / PER_M).toBeCloseTo(10);
  });

  it("composes with a long-context tier rather than replacing it", () => {
    const tiered = {
      input: 4 * PER_M, output: 20 * PER_M, cacheWrite: 5 * PER_M, cacheRead: 0.2 * PER_M,
      tiers: [{ aboveContextTokens: 200_000, input: 8 * PER_M, output: 40 * PER_M, cacheWrite: 10 * PER_M, cacheRead: 0.4 * PER_M }],
    };
    expect(ratesForRequest("claude-opus-5-5", tiered, { contextTokens: 250_000, speed: "fast" }).output / PER_M)
      .toBeCloseTo(80);
  });
});
