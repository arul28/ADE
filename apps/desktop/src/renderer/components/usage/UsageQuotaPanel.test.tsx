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
      claude: {
        binary: { present: false, source: "missing", path: null },
        auth: { ready: false, mode: "none", detail: null },
      },
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
      // Both CLIs detected by default so the panel renders both cards.
      claude: makeProviderConnection("claude", { runtimeDetected: true, authAvailable: true }),
      codex: makeProviderConnection("codex", { runtimeDetected: true, authAvailable: true }),
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

  it("renders the weekly used percent for each authed provider", async () => {
    render(<UsageQuotaPanel />);

    expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
    expect(await screen.findByText("63.0% used")).toBeTruthy();
    expect(screen.queryByText("37.0% remaining")).toBeNull();
  });

  it("renders weekly and monthly windows as separate meters", async () => {
    const snapshot = makeSnapshot();
    snapshot.windows = [
      ...snapshot.windows,
      {
        provider: "codex",
        windowType: "monthly",
        percentUsed: 44,
        resetsAt: "2099-06-01T07:00:00.000Z",
        resetsInMs: 7 * 86_400_000,
      },
    ];
    vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
    vi.mocked(window.ade.usage.refresh).mockResolvedValue(snapshot);

    render(<UsageQuotaPanel />);

    expect((await screen.findAllByText("Weekly")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Monthly")).toBeTruthy();
    expect(await screen.findByText("44.0% used")).toBeTruthy();
  });

  it("auto-refreshes once on mount so the drawer never shows stale data", async () => {
    render(<UsageQuotaPanel />);

    await waitFor(() => {
      expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps live provider polling available through the manual refresh button", async () => {
    render(<UsageQuotaPanel />);

    await waitFor(() => {
      const refreshButton = screen.getByRole("button", { name: /refresh/i }) as HTMLButtonElement;
      expect(refreshButton.disabled).toBe(false);
    });

    const baseline = vi.mocked(window.ade.usage.refresh).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(window.ade.usage.refresh).toHaveBeenCalledTimes(baseline + 1);
    });
  });

  it("hides providers whose CLI is not detected on this machine", async () => {
    vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
      makeAiStatus({
        claude: makeProviderConnection("claude", { runtimeDetected: false, authAvailable: false }),
      }),
    );

    render(<UsageQuotaPanel />);

    // Codex card stays visible.
    expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
    // Claude card is hidden when the CLI is not installed.
    expect(screen.queryByText("Claude")).toBeNull();
  });

  it("dims the provider card when the CLI is installed but not signed in", async () => {
    vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
      makeAiStatus({
        claude: makeProviderConnection("claude", { runtimeDetected: true, authAvailable: false }),
      }),
    );

    render(<UsageQuotaPanel />);

    expect(await screen.findByText("Not signed in")).toBeTruthy();
    // The weekly bar is not rendered for the unauthed provider.
    expect(screen.queryByText("20.0% used")).toBeNull();
  });

  it("never renders a Cursor section", async () => {
    render(<UsageQuotaPanel />);

    await waitFor(() => {
      expect(window.ade.usage.refresh).toHaveBeenCalled();
    });
    expect(screen.queryByText("Cursor")).toBeNull();
    expect(screen.queryByText(/Cursor not detected/i)).toBeNull();
  });
});
