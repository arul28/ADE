/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryInspectorPanel } from "./MemoryInspector";
import { useAppStore } from "../../state/appStore";
import type { MemoryHealthStats } from "../../../shared/types";

function createHealthStats(overrides: Partial<MemoryHealthStats> = {}): MemoryHealthStats {
  return {
    scopes: [
      {
        scope: "project",
        current: 2,
        max: 2000,
        counts: { tier1: 0, tier2: 2, tier3: 0, archived: 0 },
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
      entriesEmbedded: 1,
      entriesTotal: 2,
      queueDepth: 0,
      processing: false,
      lastBatchProcessedAt: "2026-03-09T18:45:00.000Z",
      cacheEntries: 1,
      cacheHits: 1,
      cacheMisses: 1,
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
    ...overrides,
  };
}

type SetupOptions = {
  healthStats?: MemoryHealthStats;
};

function setupWindowAde(options: SetupOptions = {}) {
  const search = vi.fn(async () => [
    {
      id: "memory-1",
      scope: "project",
      tier: 2,
      pinned: false,
      category: "fact",
      content: "Hybrid search keeps semantic matches in view.",
      importance: "medium",
      createdAt: "2026-03-09T18:00:00.000Z",
      lastAccessedAt: "2026-03-09T18:30:00.000Z",
      accessCount: 2,
      status: "promoted",
      confidence: 0.9,
      embedded: true,
    },
  ]);

  (window as any).ade = {
    memory: {
      getBudget: vi.fn(async () => [
        {
          id: "memory-1",
          scope: "project",
          tier: 2,
          pinned: false,
          category: "fact",
          content: "Embeddings are ready for semantic search.",
          importance: "medium",
          createdAt: "2026-03-09T18:00:00.000Z",
          lastAccessedAt: "2026-03-09T18:30:00.000Z",
          accessCount: 2,
          status: "promoted",
          confidence: 0.9,
          embedded: true,
        },
        {
          id: "memory-2",
          scope: "project",
          tier: 2,
          pinned: false,
          category: "fact",
          content: "Fresh entries may still be waiting for backfill.",
          importance: "medium",
          createdAt: "2026-03-09T18:05:00.000Z",
          lastAccessedAt: "2026-03-09T18:35:00.000Z",
          accessCount: 1,
          status: "promoted",
          confidence: 0.7,
          embedded: false,
        },
      ]),
      getCandidates: vi.fn(async () => []),
      search,
      getHealthStats: vi.fn(async () => options.healthStats ?? createHealthStats()),
      promote: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined),
    },
  };

  return { search };
}

describe("MemoryInspector", () => {
  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    vi.restoreAllMocks();
    useAppStore.setState({ lanes: [] });
  });

  it("defaults to hybrid mode when embeddings are available", async () => {
    setupWindowAde();

    render(<MemoryInspectorPanel showDocsSection={false} />);

    const hybridToggle = await screen.findByRole("button", { name: /hybrid \(recommended\)/i });
    expect(hybridToggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("defaults to lexical mode when embeddings are unavailable", async () => {
    setupWindowAde({
      healthStats: createHealthStats({
        embeddings: {
          entriesEmbedded: 0,
          entriesTotal: 2,
          queueDepth: 2,
          processing: false,
          lastBatchProcessedAt: null,
          cacheEntries: 0,
          cacheHits: 0,
          cacheMisses: 0,
          cacheHitRate: 0,
          model: {
            modelId: "Xenova/all-MiniLM-L6-v2",
            state: "unavailable",
            progress: null,
            loaded: null,
            total: null,
            file: null,
            error: "not downloaded",
          },
        },
      }),
    });

    render(<MemoryInspectorPanel showDocsSection={false} />);

    const lexicalToggle = await screen.findByRole("button", { name: /lexical only/i });
    expect(lexicalToggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("passes the selected search mode to memory search", async () => {
    const bridge = setupWindowAde();

    render(<MemoryInspectorPanel showDocsSection={false} />);

    fireEvent.click(await screen.findByRole("button", { name: /lexical only/i }));
    fireEvent.change(screen.getByPlaceholderText(/search project memory/i), { target: { value: "semantic" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => {
      expect(bridge.search).toHaveBeenCalledWith(expect.objectContaining({
        query: "semantic",
        mode: "lexical",
      }));
    });

    fireEvent.click(screen.getByRole("button", { name: /hybrid \(recommended\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => {
      expect(bridge.search).toHaveBeenLastCalledWith(expect.objectContaining({
        query: "semantic",
        mode: "hybrid",
      }));
    });
  });

  it("shows an embedded column with checkmarks and dashes in the full inspector list", async () => {
    setupWindowAde();

    render(<MemoryInspectorPanel showDocsSection={false} />);

    expect(await screen.findByRole("columnheader", { name: /embedded/i })).toBeTruthy();
    expect(screen.getAllByText("✓").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
