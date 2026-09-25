import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _testing, ratesForRequest, resolveTokenPrice, tokenPrice } from "./usagePricing";

const PER_M = 1 / 1_000_000;

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
    expect(tier.input).toBeCloseTo(4 * PER_M);
    expect(tier.output).toBeCloseTo(15 * PER_M);
    expect(tier.cacheRead).toBeCloseTo(0.4 * PER_M);
    expect(tier.cacheWrite).toBeCloseTo(5 * PER_M);
    // `tiers` carries the real 272k threshold; the 200k legacy block is ignored.
    expect(ratesForRequest("gpt-6-sol", price, { contextTokens: 250_000 }).input).toBeCloseTo(2 * PER_M);
    expect(ratesForRequest("gpt-6-sol", price, { contextTokens: 272_000 }).input).toBeCloseTo(2 * PER_M);
    expect(ratesForRequest("gpt-6-sol", price, { contextTokens: 272_001 }).input).toBeCloseTo(4 * PER_M);
    expect(ratesForRequest("gpt-6-sol", price, { contextTokens: 272_001 }).cacheRead).toBeCloseTo(0.4 * PER_M);
  });

  it("falls back to context_over_200k when a row has no tiers", () => {
    install({ xai: { models: { "grok-4.7": { cost: { input: 2, output: 6, cache_read: 0.5, context_over_200k: { input: 4, output: 12, cache_read: 1 } } } } } });
    const price = resolveTokenPrice("grok-4.7");
    expect(ratesForRequest("grok-4.7", price, { contextTokens: 199_999 }).output).toBeCloseTo(6 * PER_M);
    expect(ratesForRequest("grok-4.7", price, { contextTokens: 400_000 }).output).toBeCloseTo(12 * PER_M);
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
    expect(ratesForRequest("qwen3-coder-480b-a35b-instruct", price, { contextTokens: 10_000 }).input).toBeCloseTo(1.5 * PER_M);
    expect(ratesForRequest("qwen3-coder-480b-a35b-instruct", price, { contextTokens: 64_000 }).input).toBeCloseTo(2.7 * PER_M);
    expect(ratesForRequest("qwen3-coder-480b-a35b-instruct", price, { contextTokens: 200_000 }).input).toBeCloseTo(4.5 * PER_M);
    // A turn or session aggregate passes no context and keeps the base rate.
    expect(ratesForRequest("qwen3-coder-480b-a35b-instruct", price, {}).input).toBeCloseTo(1.5 * PER_M);
  });

  it("round-trips tiers through the on-disk cache format", () => {
    install({ xai: { models: { "grok-4.6": { cost: { input: 2, output: 6, cache_read: 0.5, context_over_200k: { input: 4, output: 12, cache_read: 1 } } } } } });
    const written = JSON.parse(JSON.stringify({ "grok-4.6": resolveTokenPrice("grok-4.6") }));
    const reread = _testing.parseCachedPricingMap(written)?.get("grok-4.6");
    expect(reread?.tiers?.[0]?.aboveContextTokens).toBe(200_000);
    expect(reread?.tiers?.[0]?.input).toBeCloseTo(4 * PER_M);
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
      expect(read?.pricing.get("zz-cache-model")?.output).toBeCloseTo(10 * PER_M);

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
    expect(price.cacheWrite).toBeCloseTo(0.15 * PER_M);
    expect(price.cacheRead).toBeCloseTo(0.003 * PER_M);
  });

  it("keeps an explicit write rate and the conventional ratios for a row with no cache rates", () => {
    install({
      anthropic: { models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } },
      mistral: { models: { "mistral-large-3": { cost: { input: 2, output: 6 } } } },
    });
    expect(resolveTokenPrice("claude-opus-5-5").cacheWrite).toBeCloseTo(5 * PER_M);
    expect(resolveTokenPrice("mistral-large-3").cacheWrite).toBeCloseTo(2.5 * PER_M);
    expect(resolveTokenPrice("mistral-large-3").cacheRead).toBeCloseTo(0.2 * PER_M);
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
    expect(resolveTokenPrice("amazon-bedrock/us.anthropic.claude-opus-4-6-v1").cacheWrite).toBeCloseTo(6.25 * PER_M);
  });
});

describe("DeepSeek peak hours", () => {
  const offPeakPrice = { input: 0.15 * PER_M, output: 0.6 * PER_M, cacheWrite: 0.15 * PER_M, cacheRead: 0.003 * PER_M };

  it("doubles every rate inside the published weekday UTC windows", () => {
    const mondayPeak = Date.UTC(2026, 8, 21, 2, 30); // Mon 02:30 UTC
    const mondayMorningPeak = Date.UTC(2026, 8, 21, 9, 59);
    expect(ratesForRequest("deepseek-flash", offPeakPrice, { timestampMs: mondayPeak }).cacheRead).toBeCloseTo(0.006 * PER_M);
    expect(ratesForRequest("deepseek/deepseek-flash", offPeakPrice, { timestampMs: mondayMorningPeak }).output).toBeCloseTo(1.2 * PER_M);
  });

  it("keeps off-peak rates outside the windows, on weekends, and for other vendors", () => {
    const mondayGap = Date.UTC(2026, 8, 21, 5, 0); // between the two windows
    const saturday = Date.UTC(2026, 8, 26, 2, 30);
    expect(ratesForRequest("deepseek-flash", offPeakPrice, { timestampMs: mondayGap }).input).toBeCloseTo(0.15 * PER_M);
    expect(ratesForRequest("deepseek-flash", offPeakPrice, { timestampMs: saturday }).input).toBeCloseTo(0.15 * PER_M);
    expect(ratesForRequest("kimi-k3", offPeakPrice, { timestampMs: Date.UTC(2026, 8, 21, 2, 30) }).input).toBeCloseTo(0.15 * PER_M);
  });

  it("doubles only DeepSeek's own API, not a reseller route to a DeepSeek model", () => {
    const mondayPeak = Date.UTC(2026, 8, 21, 2, 30);
    expect(ratesForRequest("deepseek-chat", offPeakPrice, { timestampMs: mondayPeak }).input).toBeCloseTo(0.3 * PER_M);
    expect(ratesForRequest("openrouter/deepseek/deepseek-chat", offPeakPrice, { timestampMs: mondayPeak }).input).toBeCloseTo(0.15 * PER_M);
    expect(ratesForRequest("deepseek-ai/DeepSeek-V3", offPeakPrice, { timestampMs: mondayPeak }).input).toBeCloseTo(0.15 * PER_M);
  });
});

describe("Claude fast mode", () => {
  const opus55 = tokenPrice(4, 20, 0.2, 5);

  it("doubles every rate for a fast request and leaves a standard one alone", () => {
    const standard = ratesForRequest("claude-opus-5-5", opus55, {});
    const fast = ratesForRequest("claude-opus-5-5", opus55, { fast: true });
    expect(standard.input).toBeCloseTo(4 * PER_M);
    expect(fast.input).toBeCloseTo(8 * PER_M);
    expect(fast.output).toBeCloseTo(40 * PER_M);
    expect(fast.cacheRead).toBeCloseTo(0.4 * PER_M);
    expect(fast.cacheWrite).toBeCloseTo(10 * PER_M);
  });

  it("composes with a long-context tier rather than replacing it", () => {
    const tiered = {
      input: 4 * PER_M, output: 20 * PER_M, cacheWrite: 5 * PER_M, cacheRead: 0.2 * PER_M,
      tiers: [{ aboveContextTokens: 200_000, input: 8 * PER_M, output: 40 * PER_M, cacheWrite: 10 * PER_M, cacheRead: 0.4 * PER_M }],
    };
    expect(ratesForRequest("claude-opus-5-5", tiered, { contextTokens: 250_000, fast: true }).output)
      .toBeCloseTo(80 * PER_M);
  });
});
