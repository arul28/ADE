/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmbeddingsSection } from "./EmbeddingsSection";

function createHealthStats(overrides: Partial<any> = {}) {
  return {
    scopes: [
      { scope: "project", current: 0, max: 2000, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
      { scope: "agent", current: 0, max: 500, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
      { scope: "mission", current: 0, max: 200, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
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
        activity: "idle",
        installState: "missing",
        cacheDir: "/tmp/mock-transformers-cache",
        installPath: "/tmp/mock-transformers-cache/Xenova/all-MiniLM-L6-v2",
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

describe("EmbeddingsSection", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    globalThis.window.ade = {
      memory: {
        getHealthStats: vi.fn().mockResolvedValue(createHealthStats()),
        downloadEmbeddingModel: vi.fn().mockResolvedValue(createHealthStats()),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("shows the machine-wide install path when the model is already installed", async () => {
    const memoryApi = window.ade?.memory as any;
    const installedStats = createHealthStats({
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
          activity: "idle",
          installState: "installed",
          cacheDir: "/tmp/mock-transformers-cache",
          installPath: "/tmp/mock-transformers-cache/Xenova/all-MiniLM-L6-v2",
          progress: null,
          loaded: null,
          total: null,
          file: null,
          error: null,
        },
      },
    });
    memoryApi.getHealthStats.mockResolvedValue(installedStats);

    render(<EmbeddingsSection />);

    expect(await screen.findByText(/Smart search only shows Ready after the model loads and passes a local verification check/i)).toBeTruthy();
    expect(screen.getByText("/tmp/mock-transformers-cache/Xenova/all-MiniLM-L6-v2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /verify model/i }));
    expect(memoryApi.downloadEmbeddingModel).toHaveBeenCalledTimes(1);
  });

  it("describes a local cache load instead of a fresh download", async () => {
    const memoryApi = window.ade?.memory as any;
    const loadingLocalStats = createHealthStats({
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
          activity: "loading-local",
          installState: "installed",
          cacheDir: "/tmp/mock-transformers-cache",
          installPath: "/tmp/mock-transformers-cache/Xenova/all-MiniLM-L6-v2",
          progress: 100,
          loaded: 1024,
          total: 1024,
          file: "tokenizer.json",
          error: null,
        },
      },
    });
    memoryApi.getHealthStats.mockResolvedValue(loadingLocalStats);

    render(<EmbeddingsSection />);

    expect(await screen.findByText(/ADE is loading it from local cache/i)).toBeTruthy();
    expect(screen.queryByText(/Downloading model files/i)).toBeNull();
  });

  it("still treats a fully installed model as local loading even if activity is stale", async () => {
    const memoryApi = window.ade?.memory as any;
    const contradictoryStats = createHealthStats({
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
          activity: "downloading",
          installState: "installed",
          cacheDir: "/tmp/mock-transformers-cache",
          installPath: "/tmp/mock-transformers-cache/Xenova/all-MiniLM-L6-v2",
          progress: 100,
          loaded: 695 * 1024,
          total: 695 * 1024,
          file: "tokenizer.json",
          error: null,
        },
      },
    });
    memoryApi.getHealthStats.mockResolvedValue(contradictoryStats);

    render(<EmbeddingsSection />);

    expect(await screen.findByText(/without downloading it again/i)).toBeTruthy();
    expect(screen.queryByText(/Downloading tokenizer\.json/i)).toBeNull();
  });
});
