/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../../../shared/types";
import { UsageQuotaPanel } from "./UsageQuotaPanel";

function makeSnapshot(): UsageSnapshot {
  return {
    windows: [
      {
        provider: "codex",
        windowType: "weekly",
        percentUsed: 63,
        resetsAt: "2099-05-15T07:00:00.000Z",
        resetsInMs: 86_400_000,
      },
      {
        provider: "claude",
        windowType: "weekly",
        percentUsed: 20,
        resetsAt: "2099-05-15T07:00:00.000Z",
        resetsInMs: 86_400_000,
      },
    ],
    pacing: {
      status: "on-track",
      projectedWeeklyPercent: 63,
      weekElapsedPercent: 50,
      expectedPercent: 50,
      deltaPercent: 13,
      etaHours: null,
      willLastToReset: true,
      resetsInHours: 24,
    },
    pacingByProvider: {
      codex: {
        status: "ahead",
        projectedWeeklyPercent: 70,
        weekElapsedPercent: 50,
        expectedPercent: 50,
        deltaPercent: 13,
        etaHours: null,
        willLastToReset: true,
        resetsInHours: 24,
      },
    },
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-05-08T07:00:00.000Z",
    errors: [],
  };
}

describe("UsageQuotaPanel", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    const snapshot = makeSnapshot();
    globalThis.window.ade = {
      usage: {
        getSnapshot: vi.fn().mockResolvedValue(snapshot),
        refresh: vi.fn().mockResolvedValue(snapshot),
        getBudgetConfig: vi.fn().mockResolvedValue({}),
        saveBudgetConfig: vi.fn().mockResolvedValue({}),
        onUpdate: vi.fn(() => () => {}),
      },
      ai: {
        getStatus: vi.fn().mockResolvedValue({
          providerConnections: {
            claude: null,
            codex: null,
            cursor: null,
            droid: null,
          },
        }),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("shows Codex as percent used, not percent remaining", async () => {
    render(<UsageQuotaPanel />);

    expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
    expect(await screen.findByText("63.0% used")).toBeTruthy();
    expect(screen.queryByText("37.0% remaining")).toBeNull();
  });

  it("keeps live provider polling available through the manual refresh button", async () => {
    render(<UsageQuotaPanel />);

    await waitFor(() => {
      const refreshButton = screen.getByRole("button", { name: /refresh/i }) as HTMLButtonElement;
      expect(refreshButton.disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1);
    });
  });
});
