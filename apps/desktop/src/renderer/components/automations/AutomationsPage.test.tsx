// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AutomationsPage } from "./AutomationsPage";

function mountPage() {
  return render(
    <MemoryRouter initialEntries={["/automations"]}>
      <Routes>
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/cto" element={<div data-testid="cto-page">CTO Composer</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function buildBridge() {
  const getNightShiftState = vi.fn(async () => ({
    settings: {
      activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York" },
      utilizationPreset: "conservative",
      paused: false,
      updatedAt: "2026-03-05T00:00:00.000Z",
    },
    queue: [
      {
        id: "night-1",
        automationId: "rule-1",
        title: "On session end",
        reviewProfile: "quick",
        executorMode: "automation-bot",
        targetLabel: null,
        scheduledWindow: "22:00-06:00",
        status: "queued",
        position: 0,
        createdAt: "2026-03-05T00:00:00.000Z",
        updatedAt: "2026-03-05T00:00:00.000Z",
      },
    ],
    latestBriefing: {
      id: "briefing-1",
      createdAt: "2026-03-05T08:00:00.000Z",
      completedAt: "2026-03-05T08:00:00.000Z",
      totalRuns: 1,
      succeededRuns: 1,
      failedRuns: 0,
      totalSpendUsd: 0.25,
      cards: [
        {
          queueItemId: "night-1",
          title: "On session end",
          summary: "Completed overnight review cleanly.",
          confidence: { value: 0.9, label: "high", reason: "clean" },
          spendUsd: 0.25,
          suggestedActions: ["accept"],
          procedureSignals: [],
        },
      ],
    },
  }));

  const updateNightShiftSettings = vi.fn(async (next: {
    activeHours?: { start?: string; end?: string; timezone?: string };
    utilizationPreset?: string;
    paused?: boolean;
  }) => ({
    settings: {
      activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York", ...(next.activeHours ?? {}) },
      utilizationPreset: next.utilizationPreset ?? "conservative",
      paused: next.paused ?? false,
      updatedAt: "2026-03-05T00:00:00.000Z",
    },
    queue: [],
    latestBriefing: null,
  }));

  return {
    automations: {
      list: vi.fn(async () => [
        {
          id: "rule-1",
          name: "On session end",
          description: "Review session output and flag follow-up work.",
          enabled: true,
          mode: "review",
          triggers: [{ type: "session-end" }],
          trigger: { type: "session-end" },
          executor: { mode: "automation-bot" },
          reviewProfile: "quick",
          toolPalette: ["repo", "memory", "mission"],
          contextSources: [{ type: "project-memory" }],
          memory: { mode: "automation-plus-project" },
          guardrails: {},
          outputs: { disposition: "comment-only", createArtifact: true },
          verification: { verifyBeforePublish: false, mode: "intervention" },
          billingCode: "auto:test",
          actions: [{ type: "update-packs" }],
          running: false,
          lastRunStatus: "succeeded",
          lastRunAt: "2026-03-05T00:00:00.000Z",
          queueCount: 1,
          paused: false,
          ignoredRunCount: 0,
          confidence: null,
        },
      ]),
      onEvent: vi.fn(() => () => {}),
      toggle: vi.fn(async () => []),
      triggerManually: vi.fn(async () => ({
        id: "run-1",
        automationId: "rule-1",
        missionId: "mission-1",
        workerRunId: null,
        workerAgentId: null,
        queueItemId: null,
        triggerType: "manual",
        startedAt: "2026-03-05T00:00:00.000Z",
        endedAt: "2026-03-05T00:05:00.000Z",
        status: "succeeded",
        queueStatus: "completed-clean",
        executorMode: "automation-bot",
        actionsCompleted: 1,
        actionsTotal: 1,
        errorMessage: null,
        spendUsd: 0.25,
        verificationRequired: false,
        confidence: null,
        triggerMetadata: null,
        summary: "ok",
        billingCode: "auto:test",
      })),
      validateDraft: vi.fn(async () => ({ ok: true, issues: [], requiredConfirmations: [] })),
      saveDraft: vi.fn(async () => ({ rule: { id: "rule-1" } })),
      simulate: vi.fn(async () => ({ notes: [], actions: [], issues: [] })),
      getHistory: vi.fn(async () => []),
      listRuns: vi.fn(async () => []),
      getRunDetail: vi.fn(async () => null),
      listQueueItems: vi.fn(async () => []),
      updateQueueItem: vi.fn(async () => null),
      getNightShiftState,
      mutateNightShiftQueue: vi.fn(async () => getNightShiftState()),
      updateNightShiftSettings,
      getMorningBriefing: vi.fn(async () => null),
      acknowledgeMorningBriefing: vi.fn(async () => null),
      parseNaturalLanguage: vi.fn(async () => ({})),
    },
    projectConfig: {
      get: vi.fn(async () => ({
        trust: { requiresSharedTrust: false, sharedHash: null },
      })),
      confirmTrust: vi.fn(async () => ({})),
    },
    tests: {
      listSuites: vi.fn(async () => []),
    },
    cto: {
      getLinearConnectionStatus: vi.fn(async () => ({
        tokenStored: true,
        connected: true,
        viewerId: "viewer-1",
        viewerName: "Alex",
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: null,
      })),
      getLinearSyncDashboard: vi.fn(async () => ({
        enabled: true,
        running: false,
        ingressMode: "webhook-first",
        reconciliationIntervalSec: 30,
        lastPollAt: "2026-03-05T00:00:00.000Z",
        lastSuccessAt: "2026-03-05T00:05:00.000Z",
        lastError: null,
        queue: { queued: 1, retryWaiting: 1, escalated: 2, dispatched: 0, failed: 0 },
        claimsActive: 0,
      })),
      getFlowPolicy: vi.fn(async () => ({
        version: 1,
        source: "repo",
        settings: {},
        workflows: [{ id: "flow-1", name: "Flow 1", enabled: true }],
        files: [],
        migration: { hasLegacyConfig: false, needsSave: false },
        legacyConfig: null,
      })),
      runLinearSyncNow: vi.fn(async () => ({
        enabled: true,
        running: false,
        ingressMode: "webhook-first",
        reconciliationIntervalSec: 30,
        lastPollAt: "2026-03-05T00:10:00.000Z",
        lastSuccessAt: "2026-03-05T00:10:00.000Z",
        lastError: null,
        queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
        claimsActive: 0,
      })),
      listAgents: vi.fn(async () => []),
    },
    agentTools: {
      detect: vi.fn(async () => []),
    },
    usage: {
      getSnapshot: vi.fn(async () => null),
      refresh: vi.fn(async () => null),
      checkBudget: vi.fn(async () => ({ allowed: true, warnings: [] })),
      getCumulativeUsage: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0, weekKey: "2026-W10" })),
      getBudgetConfig: vi.fn(async () => ({ budgetCaps: [], nightShiftReservePercent: 0 })),
      onUpdate: vi.fn(() => () => {}),
    },
  };
}

describe("AutomationsPage", () => {
  beforeEach(() => {
    const bridge = buildBridge();
    (window as any).ade = bridge;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders tab bar with all tabs", async () => {
    mountPage();
    await waitFor(() => expect(screen.getAllByText("Rules").length).toBeGreaterThan(0));
    expect(screen.getByText("Templates")).toBeTruthy();
    expect(screen.getByText("History")).toBeTruthy();
    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.getByText("Night Shift")).toBeTruthy();
  });

  it("uses shared theme classes instead of hard-coded page colors", async () => {
    mountPage();
    await waitFor(() => expect(screen.getByTestId("automations-page")).toBeTruthy());
    expect(screen.getByTestId("automations-page").className).toContain("bg-bg");
    expect(screen.getByTestId("automations-page").className).toContain("text-fg");
  });

  it("renders linear intake policy card with connection and queue status", async () => {
    mountPage();

    await waitFor(() => expect(screen.getByTestId("linear-intake-policy-card")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Policy Enabled")).toBeTruthy());
    expect(screen.getByText("Linear Intake Policy")).toBeTruthy();
    expect(
      screen.getByText(/CTO > Linear is where you configure assignee \+ label driven Linear issue workflows\./i)
    ).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Queue: 4")).toBeTruthy();
  });

  it("runs sync from card and deep-links to CTO composer", async () => {
    const bridge = (window as any).ade;
    mountPage();

    await waitFor(() => expect(screen.getByTestId("linear-intake-policy-card")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Policy Enabled")).toBeTruthy());
    const runSyncButton = screen.getByRole("button", { name: /run sync now/i });
    await waitFor(() => expect(runSyncButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(runSyncButton);
    await waitFor(() => expect(bridge.cto.runLinearSyncNow).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /open in cto/i }));
    await waitFor(() => expect(screen.getByTestId("cto-page")).toBeTruthy());
  });

  it("switches to Usage tab", async () => {
    mountPage();
    await waitFor(() => expect(screen.getAllByText("Rules").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Usage"));
    await waitFor(() => expect(screen.getByText("Usage Dashboard")).toBeTruthy());
  });

  it("switches to Templates tab", async () => {
    mountPage();
    await waitFor(() => expect(screen.getByText("Templates")).toBeTruthy());
    fireEvent.click(screen.getByText("Templates"));
    await waitFor(() => expect(screen.getByText("Security Audit")).toBeTruthy());
  });

  it("switches to Night Shift tab", async () => {
    mountPage();
    await waitFor(() => expect(screen.getByText("Night Shift")).toBeTruthy());
    fireEvent.click(screen.getByText("Night Shift"));
    await waitFor(() => expect(screen.getByText("Night Shift Queue")).toBeTruthy());
    expect(screen.getAllByText("On session end").length).toBeGreaterThan(0);
  });

  it("opens the morning briefing modal when an unacknowledged briefing exists", async () => {
    const bridge = buildBridge();
    bridge.automations.getMorningBriefing = vi.fn(async () => ({
      id: "briefing-1",
      createdAt: "2026-03-05T08:00:00.000Z",
      completedAt: "2026-03-05T08:00:00.000Z",
      totalRuns: 2,
      succeededRuns: 1,
      failedRuns: 1,
      totalSpendUsd: 1.5,
      cards: [
        {
          queueItemId: "night-1",
          title: "Overnight follow-up",
          summary: "Prepared a publish draft for review.",
          confidence: { value: 0.8, label: "high", reason: "clear signal" },
          spendUsd: 1.5,
          suggestedActions: ["accept"],
          procedureSignals: ["release-risk"],
        },
      ],
    })) as any;
    (window as any).ade = bridge;

    mountPage();

    await waitFor(() => expect(screen.getByText("Morning Briefing")).toBeTruthy());
    expect(screen.getByText("Overnight follow-up")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /acknowledge/i }));
    await waitFor(() => expect(bridge.automations.acknowledgeMorningBriefing).toHaveBeenCalledTimes(1));
  });
});
