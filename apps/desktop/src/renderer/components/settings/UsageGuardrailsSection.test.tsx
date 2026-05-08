/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "../../../shared/types";
import { UsageGuardrailsSection } from "./UsageGuardrailsSection";

function makeSnapshot(): UsageSnapshot {
  return {
    windows: [],
    pacing: {
      status: "on-track",
      projectedWeeklyPercent: 0,
      weekElapsedPercent: 0,
      expectedPercent: 0,
      deltaPercent: 0,
      etaHours: null,
      willLastToReset: true,
      resetsInHours: 0,
    },
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-05-08T07:00:00.000Z",
    errors: [],
  };
}

describe("UsageGuardrailsSection", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    globalThis.window.ade = {
      usage: {
        getSnapshot: vi.fn().mockResolvedValue(makeSnapshot()),
        refresh: vi.fn().mockResolvedValue(makeSnapshot()),
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

  it("hydrates from the cached snapshot on mount instead of forcing a live usage poll", async () => {
    render(<UsageGuardrailsSection />);

    await waitFor(() => {
      expect(window.ade.usage.getSnapshot).toHaveBeenCalledTimes(1);
      expect(window.ade.usage.getBudgetConfig).toHaveBeenCalledTimes(1);
    });
    expect(window.ade.usage.refresh).not.toHaveBeenCalled();
  });

  it("keeps live provider polling available through the manual refresh button", async () => {
    render(<UsageGuardrailsSection />);

    await waitFor(() => {
      expect(window.ade.usage.getSnapshot).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1);
    });
  });
});
