/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../../../shared/types";
import { UsageQuotaPanel } from "./UsageQuotaPanel";

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const nowIso = new Date().toISOString();
  return {
    windows: [
      {
        provider: "codex",
        windowType: "weekly",
        percentUsed: 63,
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
    pacingByProvider: {},
    costs: [],
    extraUsage: [],
    lastPolledAt: nowIso,
    errors: [],
    ...overrides,
  };
}

describe("UsageQuotaPanel refresh freshness", () => {
  const originalAde = window.ade;

  beforeEach(() => {
    const snapshot = makeSnapshot();
    (window as any).ade = {
      usage: {
        getSnapshot: vi.fn(async () => snapshot),
        refresh: vi.fn(async () => snapshot),
        onUpdate: vi.fn(() => () => {}),
      },
      ai: {
        getStatus: vi.fn(async () => ({
          providerConnections: {
            codex: {
              provider: "codex",
              authAvailable: true,
              runtimeDetected: true,
              runtimeAvailable: true,
              usageAvailable: true,
              path: null,
              blocker: null,
              lastCheckedAt: snapshot.lastPolledAt,
              sources: [],
            },
          },
        })),
      },
    };
  });

  afterEach(() => {
    cleanup();
    window.ade = originalAde;
  });

  it("refreshes a fresh provider-only snapshot once so local cost history loads without a retry loop", async () => {
    const providerOnlySnapshot = makeSnapshot({
      costs: [],
      lastPolledAt: new Date().toISOString(),
    });
    vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(providerOnlySnapshot);
    vi.mocked(window.ade.usage.refresh).mockResolvedValue(providerOnlySnapshot);

    const { unmount } = render(<UsageQuotaPanel />);

    await waitFor(() => {
      expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1);
    });

    unmount();
    render(<UsageQuotaPanel />);
    expect(await screen.findByText("Codex")).toBeTruthy();

    await act(async () => {
      await Promise.resolve();
    });

    expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows signed-out state when usage polling reports missing credentials", async () => {
    const unauthedSnapshot = makeSnapshot({
      windows: [],
      providerStatus: {
        codex: {
          state: "unauthed",
          lastSuccessAt: null,
        },
      },
      lastPolledAt: new Date().toISOString(),
      costsLastPolledAt: new Date().toISOString(),
    });
    vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(unauthedSnapshot);
    vi.mocked(window.ade.usage.refresh).mockResolvedValue(unauthedSnapshot);

    render(<UsageQuotaPanel />);

    expect(await screen.findByText("Not signed in")).toBeTruthy();
    expect(window.ade.usage.refresh).not.toHaveBeenCalled();
  });

  it("skips the mount refresh when provider and cost scans are both fresh", async () => {
    const freshSnapshot = makeSnapshot({
      lastPolledAt: new Date().toISOString(),
      costsLastPolledAt: new Date().toISOString(),
    });
    vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(freshSnapshot);
    vi.mocked(window.ade.usage.refresh).mockResolvedValue(freshSnapshot);

    render(<UsageQuotaPanel />);

    expect(await screen.findByText("Codex")).toBeTruthy();
    expect(await screen.findByText("63.0% used")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });

    expect(window.ade.usage.refresh).not.toHaveBeenCalled();
  });
});
