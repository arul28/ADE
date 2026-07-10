/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  AiSettingsStatus,
  AdeUsageStats,
  BudgetCapConfig,
  UsageSnapshot,
} from "../../../shared/types";
import { HeaderUsageControl } from "./HeaderUsageControl";
import { UsageActivityCarousel } from "./UsageActivityCarousel";
import { UsageQuotaPanel } from "./UsageQuotaPanel";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

type UsageComponentTestBridge = {
  usage: Pick<
    Window["ade"]["usage"],
    "getSnapshot" | "refresh" | "refreshHistory" | "noteDemand" | "getBudgetConfig" | "saveBudgetConfig" | "onUpdate"
  >;
  ai: Pick<Window["ade"]["ai"], "getStatus">;
};

function makeEmptySnapshot(): UsageSnapshot {
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
    pacingByProvider: {},
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-05-21T19:00:00.000Z",
    errors: [],
  };
}

function makeQuotaPanelSnapshot(): UsageSnapshot {
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
    providerStatus: {
      claude: {
        state: "ok",
        source: "oauth",
        lastSuccessAt: "2026-05-08T07:00:00.000Z",
        updatedAt: "2026-05-08T07:00:00.000Z",
      },
      codex: {
        state: "ok",
        source: "http",
        lastSuccessAt: "2026-05-08T07:00:00.000Z",
        updatedAt: "2026-05-08T07:00:00.000Z",
      },
    },
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-05-08T07:00:00.000Z",
    errors: [],
  };
}

function makeActivityStats(): AdeUsageStats {
  return {
    generatedAt: "2026-07-09T12:00:00.000Z",
    range: { preset: "7d", since: "2026-07-03T00:00:00.000Z", until: "2026-07-09T12:00:00.000Z" },
    summary: {
      totalTokens: 3_000,
      chatSessions: 2,
      terminalSessions: 1,
      trackedAdeDurationMs: 3_600_000,
    },
    providers: [],
    models: [],
    adeProviders: [],
    adeModels: [],
    agentProviders: [],
    agentModels: [],
    features: [],
    lanes: [],
    activities: [],
    clients: [
      { client: "desktop", interactions: 8, activeDays: 2, sessions: 2, lastActiveAt: "2026-07-09T12:00:00.000Z" },
      { client: "mobile", interactions: 2, activeDays: 1, sessions: 1, lastActiveAt: "2026-07-09T11:00:00.000Z" },
    ],
    daily: [
      { date: "2026-07-08", inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, commits: 1, prs: 0, insertions: 80, deletions: 10, filesChanged: 2, sessions: 1, interactions: 4 },
      { date: "2026-07-09", inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, commits: 1, prs: 1, insertions: 120, deletions: 20, filesChanged: 4, sessions: 2, interactions: 6 },
    ],
    github: { repo: "ade/ADE", available: true, lastFetchedAt: "2026-07-09T12:00:00.000Z", error: null },
    sourceNotes: [],
  } as unknown as AdeUsageStats;
}

function makeHeaderUsageSnapshot(): UsageSnapshot {
  return {
    ...makeEmptySnapshot(),
    windows: [
      {
        provider: "codex",
        windowType: "five_hour",
        percentUsed: 9,
        resetsAt: "2099-05-21T20:38:05.000Z",
        resetsInMs: 4_600_000,
      },
      {
        provider: "codex",
        windowType: "weekly",
        percentUsed: 19,
        resetsAt: "2099-05-26T18:36:31.000Z",
        resetsInMs: 429_300_000,
      },
    ],
    lastPolledAt: "2026-05-21T19:21:26.424Z",
  };
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
      // Both providers are set up by default so usage components render both cards.
      claude: makeProviderConnection("claude", { runtimeDetected: true, authAvailable: true, usageAvailable: true }),
      codex: makeProviderConnection("codex", { runtimeDetected: true, authAvailable: true, usageAvailable: true }),
      cursor: makeProviderConnection("cursor"),
      droid: makeProviderConnection("droid"),
      ...providerConnections,
    },
  };
}

describe("usage components", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    const snapshot = makeQuotaPanelSnapshot();
    const bridge = {
      usage: {
        getSnapshot: vi.fn<[], Promise<UsageSnapshot | null>>(async () => snapshot),
        refresh: vi.fn<[], Promise<UsageSnapshot | null>>(async () => snapshot),
        refreshHistory: vi.fn<[], Promise<UsageSnapshot | null>>(async () => snapshot),
        noteDemand: vi.fn<[], Promise<UsageSnapshot | null>>(async () => snapshot),
        getBudgetConfig: vi.fn<[], Promise<BudgetCapConfig>>(async () => ({})),
        saveBudgetConfig: vi.fn<[BudgetCapConfig], Promise<BudgetCapConfig>>(async (config) => config),
        onUpdate: vi.fn<[(snapshot: UsageSnapshot) => void], () => void>(() => () => {}),
      },
      ai: {
        getStatus: vi.fn<[], Promise<AiSettingsStatus>>(async () => makeAiStatus()),
      },
    } satisfies UsageComponentTestBridge;
    Object.assign(globalThis.window, { ade: bridge });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.window.ade = originalAde;
  });

  describe("UsageQuotaPanel", () => {
    it("renders the weekly used percent for each authed provider", async () => {
      render(<UsageQuotaPanel />);

      expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
      expect(await screen.findByText("63.0% used")).toBeTruthy();
      expect(screen.queryByText("37.0% remaining")).toBeNull();
    });

    it("renders weekly and monthly windows as separate meters", async () => {
      const snapshot = makeQuotaPanelSnapshot();
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
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);

      render(<UsageQuotaPanel />);

      expect((await screen.findAllByText("Weekly")).length).toBeGreaterThan(0);
      expect(await screen.findByText("Monthly")).toBeTruthy();
      expect(await screen.findByText("44.0% used")).toBeTruthy();
    });

    it("registers non-interactive quota demand on mount without forcing user auth", async () => {
      render(<UsageQuotaPanel />);

      await waitFor(() => {
        expect(window.ade.usage.noteDemand).toHaveBeenCalledTimes(1);
      });
      expect(window.ade.usage.refresh).not.toHaveBeenCalled();
    });

    it("hides providers whose CLI is not detected on this machine", async () => {
      vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
        makeAiStatus({
          claude: makeProviderConnection("claude", { runtimeDetected: false, authAvailable: false }),
        }),
      );

      render(<UsageQuotaPanel />);

      expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
      expect(screen.queryByText("Claude")).toBeNull();
    });

    it("keeps providers visible when local auth exists before CLI detection warms up", async () => {
      vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
        makeAiStatus({
          claude: makeProviderConnection("claude", {
            runtimeDetected: false,
            runtimeAvailable: false,
            authAvailable: true,
            usageAvailable: true,
          }),
          codex: makeProviderConnection("codex", {
            runtimeDetected: false,
            runtimeAvailable: false,
            authAvailable: true,
            usageAvailable: true,
          }),
        }),
      );

      render(<UsageQuotaPanel />);

      expect((await screen.findAllByText("Claude")).length).toBeGreaterThan(0);
      expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
      expect(screen.queryByText("No provider CLIs detected")).toBeNull();
    });

    it("shows an explicit reconnect state when the CLI is installed but not signed in", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      snapshot.windows = snapshot.windows.filter((window) => window.provider !== "claude");
      snapshot.providerStatus = {
        ...snapshot.providerStatus,
        claude: {
          state: "unauthed",
          source: "oauth",
          lastSuccessAt: null,
          updatedAt: null,
          message: "Claude sign-in required — reconnect to refresh",
        },
      };
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);
      vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
        makeAiStatus({
          claude: makeProviderConnection("claude", { runtimeDetected: true, authAvailable: false }),
        }),
      );

      render(<UsageQuotaPanel />);

      expect(await screen.findByText(/Claude sign-in required/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
      expect(screen.queryByText("20.0% used")).toBeNull();
    });

    it("never renders a Cursor section", async () => {
      render(<UsageQuotaPanel />);

      await waitFor(() => {
        expect(window.ade.usage.noteDemand).toHaveBeenCalled();
      });
      expect(screen.queryByText("Cursor")).toBeNull();
      expect(screen.queryByText(/Cursor not detected/i)).toBeNull();
    });

    it("does not refresh when provider and cost scans are both fresh", async () => {
      const freshSnapshot = makeQuotaPanelSnapshot();
      freshSnapshot.lastPolledAt = new Date().toISOString();
      freshSnapshot.costsLastPolledAt = new Date().toISOString();
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(freshSnapshot);
      vi.mocked(window.ade.usage.refresh).mockResolvedValue(freshSnapshot);

      render(<UsageQuotaPanel />);

      expect(await screen.findByText("63.0% used")).toBeTruthy();
      await act(async () => { await Promise.resolve(); });
      expect(window.ade.usage.refresh).not.toHaveBeenCalled();
    });
  });

  describe("HeaderUsageControl", () => {
    beforeEach(() => {
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(makeEmptySnapshot());
      vi.mocked(window.ade.usage.refresh).mockResolvedValue(makeHeaderUsageSnapshot());
      vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
        makeAiStatus({
          claude: makeProviderConnection("claude", { runtimeDetected: false, authAvailable: false }),
          codex: makeProviderConnection("codex", { runtimeDetected: true, authAvailable: true, usageAvailable: true }),
        }),
      );
    });

    it("renders cached weekly top-bar usage before the drawer is opened", async () => {
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(makeHeaderUsageSnapshot());

      render(<HeaderUsageControl />);

      await waitFor(() => {
        expect(window.ade.usage.getSnapshot).toHaveBeenCalledTimes(1);
      });

      expect(await screen.findByText("19%")).toBeTruthy();
      expect(screen.queryByText("9%")).toBeNull();
      expect(screen.getByRole("button", { name: /Codex wk 19%, 5h 9%/ })).toBeTruthy();
      expect(window.ade.usage.refresh).not.toHaveBeenCalled();
    });

    it("defers the cached usage and provider reads until opened", async () => {
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(makeHeaderUsageSnapshot());

      render(<HeaderUsageControl deferInitialRead />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(window.ade.usage.getSnapshot).not.toHaveBeenCalled();
      expect(window.ade.ai.getStatus).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Usage" }));

      await waitFor(() => {
        expect(window.ade.usage.getSnapshot).toHaveBeenCalled();
        expect(window.ade.ai.getStatus).toHaveBeenCalled();
      });
    });

    it("shows configured auth-only providers in the main-menu row before usage windows load", async () => {
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(makeEmptySnapshot());
      vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
        makeAiStatus({
          claude: makeProviderConnection("claude", {
            runtimeDetected: false,
            runtimeAvailable: false,
            authAvailable: true,
            usageAvailable: true,
          }),
          codex: makeProviderConnection("codex", {
            runtimeDetected: false,
            runtimeAvailable: false,
            authAvailable: true,
            usageAvailable: true,
          }),
        }),
      );

      render(<HeaderUsageControl variant="menu-row" />);

      expect(await screen.findByRole("menuitem", { name: /Claude/ })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: /Codex/ })).toBeTruthy();
    });

    it("applies pushed usage updates without forcing a refresh", async () => {
      let onUpdate: ((snapshot: UsageSnapshot) => void) | null = null;
      vi.mocked(window.ade.usage.onUpdate).mockImplementation((cb) => {
        onUpdate = cb;
        return () => {};
      });

      render(<HeaderUsageControl />);

      await waitFor(() => {
        expect(window.ade.usage.getSnapshot).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        onUpdate?.(makeHeaderUsageSnapshot());
      });

      expect(screen.getByText("19%")).toBeTruthy();
      expect(screen.queryByText("9%")).toBeNull();
      expect(window.ade.usage.refresh).not.toHaveBeenCalled();
    });

    it("keeps a pushed usage update when the startup cache read resolves late", async () => {
      const startupSnapshot = deferred<UsageSnapshot | null>();
      let onUpdate: ((snapshot: UsageSnapshot) => void) | null = null;
      vi.mocked(window.ade.usage.getSnapshot).mockReturnValue(startupSnapshot.promise);
      vi.mocked(window.ade.usage.onUpdate).mockImplementation((cb) => {
        onUpdate = cb;
        return () => {};
      });

      render(<HeaderUsageControl />);

      await act(async () => {
        onUpdate?.(makeHeaderUsageSnapshot());
      });
      expect(screen.getByRole("button", { name: /Codex wk 19%, 5h 9%/ })).toBeTruthy();

      await act(async () => {
        startupSnapshot.resolve(makeEmptySnapshot());
        await startupSnapshot.promise;
      });

      expect(screen.getByRole("button", { name: /Codex wk 19%, 5h 9%/ })).toBeTruthy();
      expect(window.ade.usage.refresh).not.toHaveBeenCalled();
    });

    it("does not poll usage while the drawer stays closed", async () => {
      vi.useFakeTimers();
      render(<HeaderUsageControl />);

      await vi.advanceTimersByTimeAsync(120_000);

      expect(window.ade.usage.refresh).not.toHaveBeenCalled();
    });

    it("occludes the native browser while the usage drawer is open", async () => {
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(makeHeaderUsageSnapshot());
      const events: string[] = [];
      const onStart = () => events.push("start");
      const onEnd = () => events.push("end");
      window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
      window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
      try {
        render(<HeaderUsageControl />);

        fireEvent.click(await screen.findByRole("button", { name: /Usage .* Codex wk 19%, 5h 9%/ }));

        await waitFor(() => expect(events).toEqual(["start"]));

        fireEvent.click(screen.getByTitle("Close usage"));

        await waitFor(() => expect(events).toEqual(["start", "end"]));
      } finally {
        window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
        window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
      }
    });
  });

  describe("UsageActivityCarousel", () => {
    beforeEach(() => localStorage.clear());

    it("cycles through charts and persists the selected chart", async () => {
      render(<UsageActivityCarousel stats={makeActivityStats()} preset="7d" />);
      expect(screen.getByText("ADE activity")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Next activity chart" }));
      await waitFor(() => expect(screen.getByText("AI token flow")).toBeTruthy());
      expect(JSON.parse(localStorage.getItem("ade.stats.carousel.v1") ?? "{}")).toMatchObject({
        slide: "tokens",
        preset: "7d",
      });
    });

    it("switches among the day, week, month, and year contracts", () => {
      const onPresetChange = vi.fn();
      render(<UsageActivityCarousel stats={makeActivityStats()} preset="7d" onPresetChange={onPresetChange} />);

      fireEvent.click(screen.getByRole("button", { name: "Year" }));
      expect(onPresetChange).toHaveBeenCalledWith("year");
      expect(screen.getByRole("button", { name: "Day" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Week" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Month" })).toBeTruthy();
    });
  });
});
