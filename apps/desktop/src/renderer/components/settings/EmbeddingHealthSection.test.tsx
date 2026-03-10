/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryHealthTab } from "./MemoryHealthTab";
import type { MemoryHealthStats } from "../../../shared/types";

function createHealthStats(overrides: Partial<MemoryHealthStats> = {}): MemoryHealthStats {
  return {
    scopes: [
      {
        scope: "project",
        current: 0,
        max: 2000,
        counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 },
      },
      {
        scope: "agent",
        current: 0,
        max: 500,
        counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 },
      },
      {
        scope: "mission",
        current: 0,
        max: 200,
        counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 },
      },
    ],
    lastSweep: null,
    lastConsolidation: null,
    embeddings: {
      entriesEmbedded: 0,
      entriesTotal: 0,
      queueDepth: 0,
      processing: false,
      lastBatchProcessedAt: null,
      cacheEntries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      model: {
        modelId: "Xenova/all-MiniLM-L6-v2",
        state: "idle",
        progress: null,
        loaded: null,
        total: null,
        file: null,
        error: null,
      },
    },
    ...overrides,
  };
}

function setupWindowAde(healthStatsSequence: MemoryHealthStats[], downloadResponse?: MemoryHealthStats) {
  const stats = [...healthStatsSequence];
  const fallback = stats[stats.length - 1] ?? createHealthStats();
  const getHealthStats = vi.fn(async () => stats.shift() ?? fallback);
  const downloadEmbeddingModel = vi.fn(async () => downloadResponse ?? getHealthStats());

  (window as any).ade = {
    memory: {
      getHealthStats,
      runSweep: vi.fn(async () => undefined),
      onSweepStatus: vi.fn(() => () => undefined),
      runConsolidation: vi.fn(async () => undefined),
      onConsolidationStatus: vi.fn(() => () => undefined),
      downloadEmbeddingModel,
      getBudget: vi.fn(async () => []),
      getCandidates: vi.fn(async () => []),
      search: vi.fn(async () => []),
      pin: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
      promote: vi.fn(async () => undefined),
    },
    ai: {
      getStatus: vi.fn(async () => ({
        providers: [],
        configuredProviders: [],
        detectedAuth: [],
        models: { claude: [], codex: [] },
        features: [],
        availableModelIds: ["anthropic/claude-haiku-4-5"],
      })),
      updateConfig: vi.fn(async () => undefined),
    },
    projectConfig: {
      get: vi.fn(async () => ({ shared: {}, local: {}, effective: { ai: {} } })),
    },
  };

  return { getHealthStats, downloadEmbeddingModel };
}

describe("EmbeddingHealthSection", () => {
  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the fresh-install embedding empty state alongside the health dashboard", async () => {
    setupWindowAde([createHealthStats()]);

    render(<MemoryHealthTab />);

    expect(await screen.findByText("Memory")).toBeTruthy();
    expect(screen.getByText("STORAGE USAGE")).toBeTruthy();
    expect(screen.getByText("SMART SEARCH")).toBeTruthy();
    expect(screen.getByText("0 / 0 indexed")).toBeTruthy();
    expect(screen.getByText("Not downloaded")).toBeTruthy();
    expect(screen.getByRole("button", { name: /download model/i })).toBeTruthy();

    // Cache stats are inside Advanced section
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    expect(screen.getByText("Cache size")).toBeTruthy();
    expect(screen.getByText("Hit rate")).toBeTruthy();
  });

  it("downloads the embedding model and refreshes progress until the model is ready", async () => {
    vi.useFakeTimers();

    const loadingStats = createHealthStats({
      embeddings: {
        entriesEmbedded: 0,
        entriesTotal: 0,
        queueDepth: 0,
        processing: false,
        lastBatchProcessedAt: null,
        cacheEntries: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheHitRate: 0,
        model: {
          modelId: "Xenova/all-MiniLM-L6-v2",
          state: "loading",
          progress: 48,
          loaded: 12,
          total: 25,
          file: "model.onnx",
          error: null,
        },
      },
    });
    const bridge = setupWindowAde([
      createHealthStats(),
      createHealthStats({
        embeddings: {
          entriesEmbedded: 0,
          entriesTotal: 0,
          queueDepth: 0,
          processing: false,
          lastBatchProcessedAt: null,
          cacheEntries: 0,
          cacheHits: 0,
          cacheMisses: 0,
          cacheHitRate: 0,
          model: {
            modelId: "Xenova/all-MiniLM-L6-v2",
            state: "ready",
            progress: 100,
            loaded: 25,
            total: 25,
            file: "model.onnx",
            error: null,
          },
        },
      }),
    ], loadingStats);

    render(<MemoryHealthTab />);

    await vi.advanceTimersByTimeAsync(0);

    fireEvent.click(screen.getByRole("button", { name: /download model/i }));

    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.downloadEmbeddingModel).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Downloading/i)).toBeTruthy();
    expect(screen.getByText(/48%/i)).toBeTruthy();

    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    expect(screen.getByText(/all-MiniLM-L6-v2 loaded/i)).toBeTruthy();
  });

  it("polls while embeddings are backfilling so the progress counts update", async () => {
    vi.useFakeTimers();

    const bridge = setupWindowAde([
      createHealthStats({
        embeddings: {
          entriesEmbedded: 2,
          entriesTotal: 8,
          queueDepth: 6,
          processing: true,
          lastBatchProcessedAt: null,
          cacheEntries: 2,
          cacheHits: 2,
          cacheMisses: 2,
          cacheHitRate: 0.5,
          model: {
            modelId: "Xenova/all-MiniLM-L6-v2",
            state: "ready",
            progress: 100,
            loaded: 25,
            total: 25,
            file: null,
            error: null,
          },
        },
      }),
      createHealthStats({
        embeddings: {
          entriesEmbedded: 5,
          entriesTotal: 8,
          queueDepth: 3,
          processing: true,
          lastBatchProcessedAt: "2026-03-09T18:45:00.000Z",
          cacheEntries: 5,
          cacheHits: 3,
          cacheMisses: 2,
          cacheHitRate: 0.6,
          model: {
            modelId: "Xenova/all-MiniLM-L6-v2",
            state: "ready",
            progress: 100,
            loaded: 25,
            total: 25,
            file: null,
            error: null,
          },
        },
      }),
    ]);

    render(<MemoryHealthTab />);

    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("2 / 8 indexed")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    expect(screen.getByText("5 / 8 indexed")).toBeTruthy();
    expect(bridge.getHealthStats).toHaveBeenCalledTimes(2);
  });
});
