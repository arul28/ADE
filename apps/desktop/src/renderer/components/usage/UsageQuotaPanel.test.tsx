/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  AiSettingsStatus,
  BudgetCapConfig,
  UsageSnapshot,
} from "../../../shared/types";
import { UsageQuotaPanel } from "./UsageQuotaPanel";

type UsageQuotaPanelTestBridge = {
  usage: Pick<
    Window["ade"]["usage"],
    "getSnapshot" | "refresh" | "getBudgetConfig" | "saveBudgetConfig" | "onUpdate"
  >;
  ai: Pick<Window["ade"]["ai"], "getStatus">;
};

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

function makeProviderConnection(
  provider: AiProviderConnectionStatus["provider"],
  overrides: Partial<AiProviderConnectionStatus> = {},
): AiProviderConnectionStatus {
  return {
    provider,
    authAvailable: false,
    runtimeDetected: false,
    runtimeAvailable: false,
    usageAvailable: false,
    path: null,
    blocker: null,
    lastCheckedAt: "2026-05-08T07:00:00.000Z",
    sources: [],
    ...overrides,
  };
}

function makeAiStatus(providerConnections: Partial<AiProviderConnections> = {}): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: {
      claude: false,
      codex: false,
      cursor: false,
      droid: false,
    },
    models: {
      claude: [],
      codex: [],
      cursor: [],
      droid: [],
    },
    features: [],
    providerConnections: {
      claude: makeProviderConnection("claude"),
      codex: makeProviderConnection("codex"),
      cursor: makeProviderConnection("cursor"),
      droid: makeProviderConnection("droid"),
      ...providerConnections,
    },
  };
}

describe("UsageQuotaPanel", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    const snapshot = makeSnapshot();
    const bridge = {
      usage: {
        getSnapshot: vi.fn<[], Promise<UsageSnapshot | null>>(async () => snapshot),
        refresh: vi.fn<[], Promise<UsageSnapshot | null>>(async () => snapshot),
        getBudgetConfig: vi.fn<[], Promise<BudgetCapConfig>>(async () => ({})),
        saveBudgetConfig: vi.fn<[BudgetCapConfig], Promise<BudgetCapConfig>>(async (config) => config),
        onUpdate: vi.fn<[(snapshot: UsageSnapshot) => void], () => void>(() => () => {}),
      },
      ai: {
        getStatus: vi.fn<[], Promise<AiSettingsStatus>>(async () => makeAiStatus()),
      },
    } satisfies UsageQuotaPanelTestBridge;
    Object.assign(globalThis.window, { ade: bridge });
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

  it("labels Cursor Admin API-only auth as usage auth", async () => {
    vi.mocked(window.ade.ai.getStatus).mockResolvedValue(makeAiStatus({
      cursor: makeProviderConnection("cursor", {
          authAvailable: true,
          runtimeDetected: true,
          runtimeAvailable: false,
          usageAvailable: true,
      }),
    }));

    render(<UsageQuotaPanel />);

    expect(await screen.findByText("usage auth only")).toBeTruthy();
    expect(screen.queryByText("sign-in required")).toBeNull();
  });

  it("keeps the empty-window warning hidden when Cursor extra usage exists", async () => {
    const snapshot: UsageSnapshot = {
      ...makeSnapshot(),
      windows: [],
      extraUsage: [{
        provider: "cursor",
        isEnabled: true,
        usedCreditsUsd: 12.5,
        monthlyLimitUsd: 0,
        utilization: null,
        currency: "usd",
      }],
    };
    vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
    vi.mocked(window.ade.ai.getStatus).mockResolvedValue(makeAiStatus({
      cursor: makeProviderConnection("cursor", {
          authAvailable: true,
          runtimeDetected: true,
          runtimeAvailable: false,
          usageAvailable: true,
      }),
    }));

    render(<UsageQuotaPanel />);

    expect(await screen.findByText("Cursor monthly spend")).toBeTruthy();
    expect(screen.queryByText(/Restart ADE/)).toBeNull();
  });

  it("keeps sign-in copy for non-Cursor auth failures", async () => {
    vi.mocked(window.ade.ai.getStatus).mockResolvedValue(makeAiStatus({
      claude: makeProviderConnection("claude", {
          authAvailable: true,
          runtimeDetected: true,
          runtimeAvailable: false,
          usageAvailable: false,
          blocker: "Claude runtime reported that login is still required.",
      }),
    }));

    render(<UsageQuotaPanel />);

    expect(await screen.findByText("sign-in required")).toBeTruthy();
    expect(screen.queryByText("usage auth only")).toBeNull();
  });
});
