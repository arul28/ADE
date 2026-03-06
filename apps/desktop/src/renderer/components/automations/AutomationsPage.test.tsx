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
  return {
    automations: {
      list: vi.fn(async () => [
        {
          id: "rule-1",
          name: "On session end",
          enabled: true,
          trigger: { type: "session-end" },
          actions: [{ type: "update-packs" }],
          running: false,
          lastRunStatus: "passed",
          lastRunAt: "2026-03-05T00:00:00.000Z",
        },
      ]),
      onEvent: vi.fn(() => () => {}),
      toggle: vi.fn(async () => []),
      triggerManually: vi.fn(async () => ({})),
      validateDraft: vi.fn(async () => ({ ok: true, issues: [], requiredConfirmations: [] })),
      saveDraft: vi.fn(async () => ({ rule: { id: "rule-1" } })),
      simulate: vi.fn(async () => ({ notes: [], actions: [], issues: [] })),
      getHistory: vi.fn(async () => []),
      getRunDetail: vi.fn(async () => null),
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
        pollingIntervalSec: 300,
        lastPollAt: "2026-03-05T00:00:00.000Z",
        lastSuccessAt: "2026-03-05T00:05:00.000Z",
        lastError: null,
        queue: { queued: 1, retryWaiting: 1, escalated: 2, dispatched: 0, failed: 0 },
        claimsActive: 0,
      })),
      getFlowPolicy: vi.fn(async () => ({ enabled: true })),
      runLinearSyncNow: vi.fn(async () => ({
        enabled: true,
        running: false,
        pollingIntervalSec: 300,
        lastPollAt: "2026-03-05T00:10:00.000Z",
        lastSuccessAt: "2026-03-05T00:10:00.000Z",
        lastError: null,
        queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
        claimsActive: 0,
      })),
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

  it("renders linear intake policy card with connection and queue status", async () => {
    mountPage();

    await waitFor(() => expect(screen.getByTestId("linear-intake-policy-card")).toBeTruthy());
    expect(screen.getByText("Linear Intake Policy")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Policy Enabled")).toBeTruthy();
    expect(screen.getByText("Queue: 4")).toBeTruthy();
  });

  it("runs sync from card and deep-links to CTO composer", async () => {
    const bridge = (window as any).ade;
    mountPage();

    await waitFor(() => expect(screen.getByTestId("linear-intake-policy-card")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /run sync now/i }));
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
  });
});
