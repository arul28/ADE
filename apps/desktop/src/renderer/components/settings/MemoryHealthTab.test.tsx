/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MemoryHealthTab } from "./MemoryHealthTab";
import { SettingsPage } from "../app/SettingsPage";
import type {
  AiSettingsStatus,
  MemoryConsolidationResult,
  MemoryConsolidationStatusEventPayload,
  MemoryHealthStats,
  MemoryLifecycleSweepResult,
  MemorySweepStatusEventPayload,
  ProjectConfigSnapshot,
} from "../../../shared/types";

type BridgeOptions = {
  healthStatsSequence?: MemoryHealthStats[];
  runSweep?: () => Promise<MemoryLifecycleSweepResult>;
  runConsolidation?: () => Promise<MemoryConsolidationResult>;
  aiStatus?: AiSettingsStatus;
  projectConfig?: ProjectConfigSnapshot;
};

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

function createSweepResult(overrides: Partial<MemoryLifecycleSweepResult> = {}): MemoryLifecycleSweepResult {
  return {
    sweepId: "sweep-1",
    projectId: "project-1",
    reason: "manual",
    startedAt: "2026-03-08T10:00:00.000Z",
    completedAt: "2026-03-08T10:00:05.000Z",
    halfLifeDays: 30,
    entriesDecayed: 4,
    entriesDemoted: 1,
    entriesPromoted: 2,
    entriesArchived: 3,
    entriesOrphaned: 0,
    durationMs: 5000,
    ...overrides,
  };
}

function createConsolidationResult(overrides: Partial<MemoryConsolidationResult> = {}): MemoryConsolidationResult {
  return {
    consolidationId: "consolidation-1",
    projectId: "project-1",
    reason: "manual",
    startedAt: "2026-03-08T11:00:00.000Z",
    completedAt: "2026-03-08T11:00:08.000Z",
    clustersFound: 3,
    entriesMerged: 9,
    entriesCreated: 3,
    tokensUsed: 222,
    durationMs: 8000,
    ...overrides,
  };
}

function createAiStatus(modelIds: string[] = ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"]): AiSettingsStatus {
  return {
    providers: [],
    configuredProviders: [],
    detectedAuth: [],
    models: { claude: [], codex: [] },
    features: [],
    availableModelIds: modelIds,
  } as unknown as AiSettingsStatus;
}

function createProjectConfig(memoryModel = "anthropic/claude-haiku-4-5"): ProjectConfigSnapshot {
  return {
    shared: {},
    local: {},
    effective: {
      ai: {
        featureModelOverrides: {
          memory_consolidation: memoryModel,
        },
      },
    },
  } as unknown as ProjectConfigSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setupWindowAde(options: BridgeOptions = {}) {
  const statsSequence = [...(options.healthStatsSequence ?? [createHealthStats()])];
  const fallbackStats = statsSequence[statsSequence.length - 1] ?? createHealthStats();
  let sweepListener: ((payload: MemorySweepStatusEventPayload) => void) | null = null;
  let consolidationListener: ((payload: MemoryConsolidationStatusEventPayload) => void) | null = null;

  const getHealthStats = vi.fn(async () => statsSequence.shift() ?? fallbackStats);
  const runSweep = vi.fn(options.runSweep ?? (async () => createSweepResult()));
  const runConsolidation = vi.fn(options.runConsolidation ?? (async () => createConsolidationResult()));
  const getStatus = vi.fn(async () => options.aiStatus ?? createAiStatus());
  const updateConfig = vi.fn(async () => undefined);
  const getProjectConfig = vi.fn(async () => options.projectConfig ?? createProjectConfig());

  (window as any).ade = {
    memory: {
      getHealthStats,
      downloadEmbeddingModel: vi.fn(async () => createHealthStats()),
      runSweep,
      runConsolidation,
      onSweepStatus: vi.fn((cb: (payload: MemorySweepStatusEventPayload) => void) => {
        sweepListener = cb;
        return () => {
          sweepListener = null;
        };
      }),
      onConsolidationStatus: vi.fn((cb: (payload: MemoryConsolidationStatusEventPayload) => void) => {
        consolidationListener = cb;
        return () => {
          consolidationListener = null;
        };
      }),
    },
    ai: {
      getStatus,
      updateConfig,
    },
    projectConfig: {
      get: getProjectConfig,
    },
  };

  return {
    getHealthStats,
    runSweep,
    runConsolidation,
    getStatus,
    updateConfig,
    getProjectConfig,
    emitSweepStatus(payload: MemorySweepStatusEventPayload) {
      sweepListener?.(payload);
    },
    emitConsolidationStatus(payload: MemoryConsolidationStatusEventPayload) {
      consolidationListener?.(payload);
    },
  };
}

describe("MemoryHealthTab", () => {
  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    vi.restoreAllMocks();
  });

  it("renders the empty state on first visit", async () => {
    setupWindowAde();
    render(<MemoryHealthTab />);

    expect(await screen.findByText("Project: 0 / 2,000")).toBeTruthy();
    expect(screen.getAllByText("No sweeps yet").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No consolidations yet").length).toBeGreaterThan(0);
    expect(screen.getByText("Project: 0 / 2,000")).toBeTruthy();
    expect(screen.getByText("Agent: 0 / 500")).toBeTruthy();
    expect(screen.getByText("Mission: 0 / 200")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /project hard limit usage/i }).getAttribute("aria-valuenow")).toBe("0");
  });

  it("renders entry counts by scope and tier", async () => {
    setupWindowAde({
      healthStatsSequence: [
        createHealthStats({
          scopes: [
            { scope: "project", current: 10, max: 2000, counts: { tier1: 1, tier2: 2, tier3: 7, archived: 3 } },
            { scope: "agent", current: 4, max: 500, counts: { tier1: 0, tier2: 1, tier3: 3, archived: 2 } },
            { scope: "mission", current: 2, max: 200, counts: { tier1: 0, tier2: 0, tier3: 2, archived: 1 } },
          ],
        }),
      ],
    });

    render(<MemoryHealthTab />);

    const projectCard = await screen.findByLabelText("Project entry counts");
    expect(within(projectCard).getByText("1")).toBeTruthy();
    expect(within(projectCard).getByText("2")).toBeTruthy();
    expect(within(projectCard).getByText("7")).toBeTruthy();
    expect(within(projectCard).getByText("3")).toBeTruthy();
  });

  it("renders last sweep details", async () => {
    setupWindowAde({
      healthStatsSequence: [
        createHealthStats({
          lastSweep: {
            sweepId: "sweep-1",
            projectId: "project-1",
            reason: "manual",
            startedAt: "2026-03-08T10:00:00.000Z",
            completedAt: "2026-03-08T10:00:05.000Z",
            entriesDecayed: 4,
            entriesDemoted: 1,
            entriesPromoted: 2,
            entriesArchived: 3,
            entriesOrphaned: 1,
            durationMs: 5000,
          },
        }),
      ],
    });

    render(<MemoryHealthTab />);

    expect(await screen.findByText(/Decayed 4/i)).toBeTruthy();
    expect(screen.getByText(/Demoted 1/i)).toBeTruthy();
    expect(screen.getByText(/Orphaned 1/i)).toBeTruthy();
  });

  it("renders last consolidation details", async () => {
    setupWindowAde({
      healthStatsSequence: [
        createHealthStats({
          lastConsolidation: {
            consolidationId: "consolidation-1",
            projectId: "project-1",
            reason: "manual",
            startedAt: "2026-03-08T11:00:00.000Z",
            completedAt: "2026-03-08T11:00:08.000Z",
            clustersFound: 3,
            entriesMerged: 9,
            entriesCreated: 3,
            tokensUsed: 222,
            durationMs: 8000,
          },
        }),
      ],
    });

    render(<MemoryHealthTab />);

    expect(await screen.findByText(/Clusters 3/i)).toBeTruthy();
    expect(screen.getByText(/Merged 9/i)).toBeTruthy();
    expect(screen.getByText(/Created 3/i)).toBeTruthy();
  });

  it("runs a sweep and refreshes the dashboard", async () => {
    const bridge = setupWindowAde({
      healthStatsSequence: [
        createHealthStats(),
        createHealthStats({
          lastSweep: {
            sweepId: "sweep-2",
            projectId: "project-1",
            reason: "manual",
            startedAt: "2026-03-08T12:00:00.000Z",
            completedAt: "2026-03-08T12:00:04.000Z",
            entriesDecayed: 1,
            entriesDemoted: 0,
            entriesPromoted: 1,
            entriesArchived: 2,
            entriesOrphaned: 0,
            durationMs: 4000,
          },
        }),
      ],
    });

    render(<MemoryHealthTab />);
    fireEvent.click(await screen.findByRole("button", { name: /run sweep now/i }));

    await waitFor(() => {
      expect(bridge.runSweep).toHaveBeenCalledTimes(1);
      expect(bridge.getHealthStats).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText(/Decayed 1/i)).toBeTruthy();
  });

  it("shows a loading state while a sweep is running", async () => {
    const pendingSweep = deferred<MemoryLifecycleSweepResult>();
    setupWindowAde({ runSweep: () => pendingSweep.promise });

    render(<MemoryHealthTab />);
    const button = await screen.findByRole("button", { name: /run sweep now/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect((screen.getByRole("button", { name: /running sweep/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    pendingSweep.resolve(createSweepResult());
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /run sweep now/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("shows a sweep error and re-enables the button", async () => {
    setupWindowAde({
      runSweep: async () => {
        throw new Error("Sweep exploded.");
      },
    });

    render(<MemoryHealthTab />);
    fireEvent.click(await screen.findByRole("button", { name: /run sweep now/i }));

    expect(await screen.findByText("Sweep exploded.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /run sweep now/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs consolidation and refreshes the dashboard", async () => {
    const bridge = setupWindowAde({
      healthStatsSequence: [
        createHealthStats(),
        createHealthStats({
          lastConsolidation: {
            consolidationId: "consolidation-2",
            projectId: "project-1",
            reason: "manual",
            startedAt: "2026-03-08T13:00:00.000Z",
            completedAt: "2026-03-08T13:00:08.000Z",
            clustersFound: 4,
            entriesMerged: 12,
            entriesCreated: 4,
            tokensUsed: 300,
            durationMs: 8000,
          },
        }),
      ],
    });

    render(<MemoryHealthTab />);
    fireEvent.click(await screen.findByRole("button", { name: /run consolidation now/i }));

    await waitFor(() => {
      expect(bridge.runConsolidation).toHaveBeenCalledTimes(1);
      expect(bridge.getHealthStats).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText(/Clusters 4/i)).toBeTruthy();
  });

  it("shows a loading state while consolidation is running", async () => {
    const pending = deferred<MemoryConsolidationResult>();
    setupWindowAde({ runConsolidation: () => pending.promise });

    render(<MemoryHealthTab />);
    fireEvent.click(await screen.findByRole("button", { name: /run consolidation now/i }));

    await waitFor(() => {
      expect((screen.getByRole("button", { name: /running consolidation/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    pending.resolve(createConsolidationResult());
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /run consolidation now/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("shows a consolidation error and re-enables the button", async () => {
    setupWindowAde({
      runConsolidation: async () => {
        throw new Error("Consolidation failed.");
      },
    });

    render(<MemoryHealthTab />);
    fireEvent.click(await screen.findByRole("button", { name: /run consolidation now/i }));

    expect(await screen.findByText("Consolidation failed.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /run consolidation now/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refreshes after a sweep status completion event", async () => {
    const bridge = setupWindowAde({
      healthStatsSequence: [createHealthStats(), createHealthStats({ lastSweep: { sweepId: "sweep-3", projectId: "project-1", reason: "manual", startedAt: "2026-03-08T14:00:00.000Z", completedAt: "2026-03-08T14:00:03.000Z", entriesDecayed: 2, entriesDemoted: 1, entriesPromoted: 0, entriesArchived: 1, entriesOrphaned: 0, durationMs: 3000 } })],
    });

    render(<MemoryHealthTab />);
    await screen.findByText("Project: 0 / 2,000");

    bridge.emitSweepStatus({
      type: "memory-sweep-started",
      projectId: "project-1",
      reason: "manual",
      sweepId: "sweep-3",
      startedAt: "2026-03-08T14:00:00.000Z",
    });

    await waitFor(() => {
      expect((screen.getByRole("button", { name: /running sweep/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    bridge.emitSweepStatus({
      type: "memory-sweep-completed",
      projectId: "project-1",
      reason: "manual",
      sweepId: "sweep-3",
      startedAt: "2026-03-08T14:00:00.000Z",
      completedAt: "2026-03-08T14:00:03.000Z",
      result: createSweepResult({ sweepId: "sweep-3", entriesDecayed: 2, entriesDemoted: 1, entriesArchived: 1, durationMs: 3000 }),
    });

    await waitFor(() => {
      expect(bridge.getHealthStats).toHaveBeenCalledTimes(2);
      expect((screen.getByRole("button", { name: /run sweep now/i }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByText(/Decayed 2/i)).toBeTruthy();
  });

  it("shows an error from consolidation status failure events", async () => {
    const bridge = setupWindowAde();
    render(<MemoryHealthTab />);
    await screen.findByText("Project: 0 / 2,000");

    bridge.emitConsolidationStatus({
      type: "memory-consolidation-failed",
      projectId: "project-1",
      reason: "manual",
      consolidationId: "consolidation-3",
      startedAt: "2026-03-08T15:00:00.000Z",
      completedAt: "2026-03-08T15:00:02.000Z",
      durationMs: 2000,
      error: "Database locked.",
    });

    expect(await screen.findByText("Database locked.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /run consolidation now/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("loads and saves the consolidation model override", async () => {
    const bridge = setupWindowAde({
      aiStatus: createAiStatus(["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"]),
      projectConfig: createProjectConfig("openai/gpt-5-mini"),
    });

    render(<MemoryHealthTab />);

    const select = await screen.findByLabelText(/consolidation model/i);
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("openai/gpt-5-mini");
    });

    fireEvent.change(select, { target: { value: "anthropic/claude-haiku-4-5" } });

    await waitFor(() => {
      expect(bridge.updateConfig).toHaveBeenCalledWith({
        featureModelOverrides: { memory_consolidation: "anthropic/claude-haiku-4-5" },
      });
    });
  });

  it("is accessible from Settings > Memory navigation", async () => {
    setupWindowAde();

    render(
      <MemoryRouter initialEntries={["/settings?tab=memory"]}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: /memory/i })).toBeTruthy();
    expect(screen.getByText("Memory Health")).toBeTruthy();
  });
});
