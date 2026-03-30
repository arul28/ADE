/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MemoryHealthTab } from "./MemoryHealthTab";

function createHealthStats() {
  return {
    scopes: [
      { scope: "project", current: 2, max: 2000, counts: { tier1: 0, tier2: 2, tier3: 0, archived: 0 } },
      { scope: "agent", current: 0, max: 500, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
      { scope: "mission", current: 0, max: 200, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
    ],
    lastSweep: null,
    lastConsolidation: null,
    embeddings: {
      entriesEmbedded: 0,
      entriesTotal: 2,
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
        cacheDir: null,
        installPath: null,
        progress: null,
        loaded: null,
        total: null,
        file: null,
        error: null,
      },
    },
  };
}

function createMemoryEntries() {
  return [
    {
      id: "mem-skill",
      scope: "project",
      tier: 2,
      pinned: false,
      category: "procedure",
      content: "Imported skill: finalize\n\nRun the final gate checks before review.",
      importance: "high",
      createdAt: "2026-03-25T12:00:00.000Z",
      lastAccessedAt: "2026-03-25T12:05:00.000Z",
      accessCount: 3,
      status: "promoted",
      confidence: 1,
      embedded: false,
      sourceType: "user",
      sourceId: "/Users/admin/Projects/ADE/.claude/commands/finalize.md",
    },
    {
      id: "mem-learned",
      scope: "project",
      tier: 2,
      pinned: false,
      category: "convention",
      content: "Use lane names that map cleanly to the feature branch.",
      importance: "medium",
      createdAt: "2026-03-25T12:10:00.000Z",
      lastAccessedAt: "2026-03-25T12:12:00.000Z",
      accessCount: 1,
      status: "promoted",
      confidence: 0.84,
      embedded: false,
      sourceType: "system",
      sourceId: "digest:lane-convention",
    },
  ];
}

describe("MemoryHealthTab", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    const entries = createMemoryEntries();
    globalThis.window.ade = {
      ai: {
        getStatus: vi.fn().mockResolvedValue({}),
      },
      projectConfig: {
        get: vi.fn().mockResolvedValue({ effective: { ai: {} } }),
      },
      memory: {
        getHealthStats: vi.fn().mockResolvedValue(createHealthStats()),
        getBudget: vi.fn().mockResolvedValue(entries),
        getCandidates: vi.fn().mockResolvedValue([]),
        listProcedures: vi.fn().mockResolvedValue([]),
        listIndexedSkills: vi.fn().mockResolvedValue([
          {
            id: "skill-1",
            path: "/Users/admin/Projects/ADE/.claude/commands/finalize.md",
            kind: "command",
            source: "user",
            memoryId: "mem-skill",
            contentHash: "hash-1",
            lastModifiedAt: "2026-03-25T11:59:00.000Z",
            archivedAt: null,
            createdAt: "2026-03-25T11:59:00.000Z",
            updatedAt: "2026-03-25T11:59:00.000Z",
          },
        ]),
        getKnowledgeSyncStatus: vi.fn().mockResolvedValue({
          syncing: false,
          lastSeenHeadSha: null,
          currentHeadSha: null,
          diverged: false,
          lastDigestAt: null,
          lastDigestMemoryId: null,
          lastError: null,
        }),
        search: vi.fn().mockResolvedValue(entries),
        pin: vi.fn().mockResolvedValue(undefined),
        archive: vi.fn().mockResolvedValue(undefined),
        promote: vi.fn().mockResolvedValue(undefined),
        runSweep: vi.fn().mockResolvedValue(undefined),
        runConsolidation: vi.fn().mockResolvedValue(undefined),
        downloadEmbeddingModel: vi.fn().mockResolvedValue(createHealthStats()),
        syncKnowledge: vi.fn().mockResolvedValue(undefined),
        getProcedureDetail: vi.fn().mockResolvedValue(null),
        onSweepStatus: vi.fn().mockImplementation(() => () => undefined),
        onConsolidationStatus: vi.fn().mockImplementation(() => () => undefined),
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

  it("hides indexed skill-backed memories from Browse All and search results", async () => {
    const ade = window.ade as any;

    render(
      <MemoryRouter initialEntries={["/settings?tab=memory"]}>
        <MemoryHealthTab />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Browse All" }));

    await waitFor(() => {
      expect(screen.getByText("Use lane names that map cleanly to the feature branch.")).toBeTruthy();
    });

    expect(screen.queryByText(/Imported skill: finalize/i)).toBeNull();
    expect(screen.getByText(/ADE is indexing 1 reusable skill file/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Workspace > Skill Files/i }).getAttribute("href")).toBe("/settings?tab=workspace");
    expect(screen.getByText("1 memory")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search memories..."), { target: { value: "final gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(ade.memory.search).toHaveBeenCalledWith({ query: "final gate", limit: 40, mode: "lexical" });
    });

    expect(screen.queryByText(/Imported skill: finalize/i)).toBeNull();
    expect(screen.getByText("1 memory")).toBeTruthy();
  });

  it("treats an on-disk model as unverified until ADE loads it successfully", async () => {
    const ade = window.ade as any;
    ade.memory.getHealthStats.mockResolvedValue({
      ...createHealthStats(),
      embeddings: {
        ...createHealthStats().embeddings,
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

    render(
      <MemoryRouter initialEntries={["/settings?tab=memory"]}>
        <MemoryHealthTab />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Model found on disk/i)).toBeTruthy();
    expect(screen.getByText(/smart search turns active only after a local verification succeeds/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /verify model/i })).toBeTruthy();
  });
});
