import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enrichMocks = vi.hoisted(() => ({
  updateModelPricing: vi.fn(() => 1),
  enrichModelRegistry: vi.fn(() => 1),
}));

vi.mock("../../../shared/modelProfiles", () => ({
  updateModelPricing: enrichMocks.updateModelPricing,
}));
vi.mock("../../../shared/modelRegistry", () => ({
  enrichModelRegistry: enrichMocks.enrichModelRegistry,
}));

// Keep cache writes off disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
  };
});

const API_RESPONSE = {
  moonshotai: {
    id: "moonshotai",
    name: "Moonshot",
    models: {
      "kimi-k2.5": {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        cost: { input: 1, output: 2 },
        limit: { context: 200000, output: 8000 },
        reasoning: true,
        tool_call: true,
      },
    },
  },
};

import * as modelsDev from "./modelsDevService";

beforeEach(() => {
  modelsDev.shutdown();
  enrichMocks.updateModelPricing.mockClear();
  enrichMocks.enrichModelRegistry.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => API_RESPONSE,
  })) as unknown as typeof fetch;
});

afterEach(() => {
  modelsDev.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("modelsDevService", () => {
  it("enriches after the initial fetch and records lastFetchedAt", async () => {
    await modelsDev.initialize();
    expect(enrichMocks.updateModelPricing).toHaveBeenCalledTimes(1);
    expect(enrichMocks.enrichModelRegistry).toHaveBeenCalledTimes(1);
    expect(modelsDev.getLastFetchedAt()).toBe(Date.parse("2026-07-17T00:00:00.000Z"));
  });

  it("re-applies enrichment on the periodic 6h refresh", async () => {
    await modelsDev.initialize();
    enrichMocks.updateModelPricing.mockClear();
    enrichMocks.enrichModelRegistry.mockClear();

    // Advancing fake timers also advances the clock; the 6h timer fires at 06:00.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(enrichMocks.updateModelPricing).toHaveBeenCalledTimes(1);
    expect(enrichMocks.enrichModelRegistry).toHaveBeenCalledTimes(1);
    expect(modelsDev.getLastFetchedAt()).toBe(Date.parse("2026-07-17T06:00:00.000Z"));
  });

  it("refreshNow re-fetches, re-enriches, and updates lastFetchedAt", async () => {
    await modelsDev.initialize();
    enrichMocks.updateModelPricing.mockClear();
    enrichMocks.enrichModelRegistry.mockClear();

    vi.setSystemTime(new Date("2026-07-17T03:30:00.000Z"));
    await modelsDev.refreshNow();

    expect(enrichMocks.updateModelPricing).toHaveBeenCalledTimes(1);
    expect(enrichMocks.enrichModelRegistry).toHaveBeenCalledTimes(1);
    expect(modelsDev.getLastFetchedAt()).toBe(Date.parse("2026-07-17T03:30:00.000Z"));
  });
});
