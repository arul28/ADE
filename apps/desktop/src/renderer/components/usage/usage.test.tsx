/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  AiSettingsStatus,
  AdeUsageDailyPoint,
  AdeUsageStats,
  BudgetCapConfig,
  UsageSnapshot,
} from "../../../shared/types";
import { HeaderUsageControl } from "./HeaderUsageControl";
import { ActivityModule, WorkActivityModule, readActivityPersisted } from "./ActivityModule";
import { AdeUsageSection } from "../settings/AdeUsageSection";
import { UsageQuotaPanel } from "./UsageQuotaPanel";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

type UsageComponentTestBridge = {
  app: Pick<Window["ade"]["app"], "openExternal" | "onProjectBindingChanged">;
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

function makeActivityStats(overrides: Partial<AdeUsageStats> = {}): AdeUsageStats {
  const base = {
    generatedAt: "2026-07-09T12:00:00.000Z",
    range: { preset: "7d", since: "2026-07-03T00:00:00.000Z", until: "2026-07-09T12:00:00.000Z" },
    summary: {
      totalTokens: 3_000,
      observedProviderInputTokens: 2_000,
      observedProviderOutputTokens: 900,
      observedProviderCachedTokens: 100,
      observedProviderCostRangeUsd: 0.42,
      observedProviderCostTodayUsd: 0.12,
      observedProviderCost30dUsd: 1.4,
      chatSessions: 2,
      terminalSessions: 1,
      trackedAdeDurationMs: 3_600_000,
      commitsCreated: 2,
      prsTracked: 1,
      prsMerged: 1,
      prsOpen: 0,
      insertions: 200,
      deletions: 30,
      filesChanged: 6,
      activeDays: 2,
      currentStreakDays: 0,
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
      { date: "2026-07-08", inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, cachedTokens: 200, commits: 1, prs: 0, insertions: 80, deletions: 10, filesChanged: 2, sessions: 1, interactions: 4 },
      { date: "2026-07-09", inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, cachedTokens: 300, commits: 1, prs: 1, insertions: 120, deletions: 20, filesChanged: 4, sessions: 2, interactions: 6 },
    ],
    github: { repo: "ade/ADE", available: true, lastFetchedAt: "2026-07-09T12:00:00.000Z", error: null },
    sourceNotes: [],
  };
  return { ...base, ...overrides } as unknown as AdeUsageStats;
}

function makeEmptyActivityStats(): AdeUsageStats {
  return makeActivityStats({
    summary: {
      totalTokens: 0,
      chatSessions: 0,
      terminalSessions: 0,
      activeDays: 0,
      currentStreakDays: 0,
    },
    clients: [],
    daily: [
      { date: "2026-07-08", inputTokens: 0, outputTokens: 0, totalTokens: 0, commits: 0, prs: 0, insertions: 0, deletions: 0, filesChanged: 0, sessions: 0, interactions: 0 },
    ],
  } as unknown as Partial<AdeUsageStats>);
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
      app: {
        openExternal: vi.fn<[url: string], Promise<void>>(async () => {}),
        onProjectBindingChanged: vi.fn(() => () => {}),
      },
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

    it("opens each provider usage page in the user's browser", async () => {
      render(<UsageQuotaPanel />);

      await screen.findByText("Codex");
      fireEvent.click(screen.getByRole("button", { name: "Open Claude usage in browser" }));
      fireEvent.click(screen.getByRole("button", { name: "Open Codex usage in browser" }));

      expect(window.ade.app.openExternal).toHaveBeenCalledTimes(2);
      expect(window.ade.app.openExternal).toHaveBeenCalledWith("https://claude.ai/new#settings/usage");
      expect(window.ade.app.openExternal).toHaveBeenCalledWith(
        "https://chatgpt.com/codex/cloud/settings/analytics#usage",
      );
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

    it("shows pacing for both Codex windows when both limits are reported", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      const resetsAt = "2099-05-15T07:00:00.000Z";
      snapshot.windows = [
        {
          provider: "codex",
          windowType: "five_hour",
          percentUsed: 48,
          resetsAt,
          resetsInMs: 2.5 * 60 * 60_000,
          windowDurationMs: 5 * 60 * 60_000,
          pacing: {
            status: "on-track",
            projectedWeeklyPercent: 96,
            weekElapsedPercent: 50,
            expectedPercent: 50,
            deltaPercent: -2,
            etaHours: 2.7,
            willLastToReset: true,
            resetsInHours: 2.5,
          },
        },
        {
          provider: "codex",
          windowType: "weekly",
          percentUsed: 63,
          resetsAt,
          resetsInMs: 3.5 * 24 * 60 * 60_000,
          windowDurationMs: 7 * 24 * 60 * 60_000,
          pacing: {
            status: "far-ahead",
            projectedWeeklyPercent: 126,
            weekElapsedPercent: 50,
            expectedPercent: 50,
            deltaPercent: 13,
            etaHours: 49.3,
            willLastToReset: false,
            resetsInHours: 84,
          },
        },
      ];
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);

      render(<UsageQuotaPanel />);

      expect(await screen.findByRole("progressbar", { name: "5-hour: 48.0% used" })).toBeTruthy();
      expect(screen.getByRole("progressbar", { name: "Weekly: 63.0% used" })).toBeTruthy();
      expect(screen.getByText("on track")).toBeTruthy();
      expect(screen.getByText("13% ahead")).toBeTruthy();
      expect(screen.getByText(/trending to 126% by reset/)).toBeTruthy();
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

    it("discards an explicit refresh response after the project binding changes", async () => {
      let onBindingChanged: Parameters<Window["ade"]["app"]["onProjectBindingChanged"]>[0] | null = null;
      const refresh = deferred<UsageSnapshot | null>();
      let currentSnapshot = makeQuotaPanelSnapshot();
      const reboundSnapshot = makeQuotaPanelSnapshot();
      reboundSnapshot.lastPolledAt = "2026-05-08T06:00:00.000Z";
      reboundSnapshot.windows = reboundSnapshot.windows.map((window) =>
        window.provider === "codex" ? { ...window, percentUsed: 42 } : window,
      );
      const oldBindingResponse = makeQuotaPanelSnapshot();
      oldBindingResponse.lastPolledAt = "2026-05-08T08:00:00.000Z";
      oldBindingResponse.windows = oldBindingResponse.windows.map((window) =>
        window.provider === "codex" ? { ...window, percentUsed: 91 } : window,
      );
      vi.mocked(window.ade.app.onProjectBindingChanged).mockImplementation((callback) => {
        onBindingChanged = callback;
        return () => {};
      });
      vi.mocked(window.ade.usage.getSnapshot).mockImplementation(async () => currentSnapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(null);
      vi.mocked(window.ade.usage.refresh).mockReturnValue(refresh.promise);

      render(<UsageQuotaPanel showRefreshControl />);
      expect(await screen.findByText("63.0% used")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }));
      await waitFor(() => expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1));

      currentSnapshot = reboundSnapshot;
      await act(async () => {
        onBindingChanged?.(null);
      });
      expect(await screen.findByText("42.0% used")).toBeTruthy();

      await act(async () => {
        refresh.resolve(oldBindingResponse);
        await refresh.promise;
      });
      expect(screen.getByText("42.0% used")).toBeTruthy();
      expect(screen.queryByText("91.0% used")).toBeNull();
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

    it("ignores an older usage event after a newer machine snapshot", async () => {
      let onUpdate: ((snapshot: UsageSnapshot) => void) | null = null;
      vi.mocked(window.ade.usage.onUpdate).mockImplementation((cb) => {
        onUpdate = cb;
        return () => {};
      });
      const newer = makeHeaderUsageSnapshot();
      newer.lastPolledAt = "2026-05-21T19:22:00.000Z";
      const older = makeHeaderUsageSnapshot();
      older.lastPolledAt = "2026-05-21T19:21:00.000Z";
      older.windows = older.windows.map((window) => ({ ...window, percentUsed: 77 }));

      render(<HeaderUsageControl />);

      await act(async () => {
        onUpdate?.(newer);
        onUpdate?.(older);
      });

      expect(window.ade.usage.onUpdate).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /Codex wk 19%, 5h 9%/ })).toBeTruthy();
      expect(screen.queryByText("77%")).toBeNull();
    });

    it("accepts an older authoritative snapshot after the project binding changes", async () => {
      let onBindingChanged: Parameters<Window["ade"]["app"]["onProjectBindingChanged"]>[0] | null = null;
      vi.mocked(window.ade.app.onProjectBindingChanged).mockImplementation((cb) => {
        onBindingChanged = cb;
        return () => {};
      });
      const newer = makeHeaderUsageSnapshot();
      newer.lastPolledAt = "2026-05-21T19:22:00.000Z";
      const olderMachine = makeHeaderUsageSnapshot();
      olderMachine.lastPolledAt = "2026-05-21T18:00:00.000Z";
      olderMachine.windows = olderMachine.windows.map((window) => ({ ...window, percentUsed: 42 }));
      vi.mocked(window.ade.ai.getStatus)
        .mockResolvedValueOnce(makeAiStatus({
          claude: makeProviderConnection("claude", { runtimeDetected: true, authAvailable: true }),
          codex: makeProviderConnection("codex"),
        }))
        .mockResolvedValueOnce(makeAiStatus({
          claude: makeProviderConnection("claude"),
          codex: makeProviderConnection("codex", { runtimeDetected: true, authAvailable: true }),
        }));
      vi.mocked(window.ade.usage.getSnapshot)
        .mockResolvedValueOnce(newer)
        .mockResolvedValueOnce(olderMachine);

      render(<HeaderUsageControl />);
      expect(await screen.findByRole("button", { name: /Claude wk …, 5h …/ })).toBeTruthy();

      await act(async () => {
        onBindingChanged?.(null);
      });

      expect(await screen.findByText("42%")).toBeTruthy();
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: /Claude wk/ })).toBeNull();
    });

    it("discards a header refresh response after the project binding changes", async () => {
      const bindingCallbacks: Array<Parameters<Window["ade"]["app"]["onProjectBindingChanged"]>[0]> = [];
      const refresh = deferred<UsageSnapshot | null>();
      let currentSnapshot = makeHeaderUsageSnapshot();
      const reboundSnapshot = makeHeaderUsageSnapshot();
      reboundSnapshot.lastPolledAt = "2026-05-21T18:00:00.000Z";
      reboundSnapshot.windows = reboundSnapshot.windows.map((window) => ({ ...window, percentUsed: 42 }));
      const oldBindingResponse = makeHeaderUsageSnapshot();
      oldBindingResponse.lastPolledAt = "2026-05-21T20:00:00.000Z";
      oldBindingResponse.windows = oldBindingResponse.windows.map((window) => ({ ...window, percentUsed: 91 }));
      vi.mocked(window.ade.app.onProjectBindingChanged).mockImplementation((callback) => {
        bindingCallbacks.push(callback);
        return () => {};
      });
      vi.mocked(window.ade.usage.getSnapshot).mockImplementation(async () => currentSnapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(null);
      vi.mocked(window.ade.usage.refresh).mockReturnValue(refresh.promise);

      render(<HeaderUsageControl />);
      fireEvent.click(await screen.findByRole("button", { name: /Codex wk 19%, 5h 9%/ }));
      fireEvent.click(screen.getByTitle("Refresh usage"));
      await waitFor(() => expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1));

      currentSnapshot = reboundSnapshot;
      await act(async () => {
        for (const callback of bindingCallbacks) callback(null);
      });
      expect(await screen.findByRole("button", { name: /Codex wk 42%, 5h 42%/ })).toBeTruthy();

      await act(async () => {
        refresh.resolve(oldBindingResponse);
        await refresh.promise;
      });
      expect(screen.getByRole("button", { name: /Codex wk 42%, 5h 42%/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Codex wk 91%, 5h 91%/ })).toBeNull();
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

  describe("ActivityModule", () => {
    beforeEach(() => localStorage.clear());

    it("defaults new activity views to the all-time range", () => {
      expect(readActivityPersisted()).toEqual({ tab: "activity", preset: "all" });
    });

    it("switches tabs and persists the selection", async () => {
      render(<ActivityModule stats={makeActivityStats()} preset="7d" onPresetChange={vi.fn()} />);

      expect(screen.getByRole("tab", { name: "Activity", selected: true })).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: "Tokens" }));

      await waitFor(() => expect(screen.getByRole("tab", { name: "Tokens", selected: true })).toBeTruthy());
      // The tokens chart shows its legend.
      expect(screen.getByText("Input")).toBeTruthy();
      expect(screen.getByText("Output")).toBeTruthy();
      expect(JSON.parse(localStorage.getItem("ade.activity.module.v1") ?? "{}")).toMatchObject({ tab: "tokens" });
    });
    it("uses the unified range vocabulary and reports changes", () => {
      const onPresetChange = vi.fn();
      render(<ActivityModule stats={makeActivityStats()} variant="full" preset="7d" onPresetChange={onPresetChange} />);

      for (const label of ["Today", "7d", "30d", "Year", "All"]) {
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
      }
      // Legacy Day/Week/Month labels are gone.
      expect(screen.queryByRole("button", { name: "Week" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Month" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Year" }));
      expect(onPresetChange).toHaveBeenCalledWith("year");
    });

    it("shows a day breakdown tooltip when a cell is tapped", () => {
      const { container } = render(<ActivityModule stats={makeActivityStats()} preset="7d" onPresetChange={vi.fn()} />);

      const grid = container.querySelector('[aria-label="Daily activity heatmap"]');
      const cell = grid?.querySelector("span");
      expect(cell).toBeTruthy();
      fireEvent.click(cell as Element);

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.textContent).toContain("Jul 8");
      expect(tooltip.textContent).toContain("1.5K tokens");
    });

    it("renders a warm empty state only when local and GitHub activity are empty", () => {
      const { rerender } = render(<ActivityModule stats={makeEmptyActivityStats()} preset="7d" onPresetChange={vi.fn()} />);
      expect(screen.getByText("Your activity will appear here after your first chat.")).toBeTruthy();

      const githubOnly = makeEmptyActivityStats();
      githubOnly.daily = [{
        ...githubOnly.daily[0]!,
        githubCommits: 1,
        githubPrs: 1,
        githubAdditions: 20,
        githubDeletions: 3,
      }];
      rerender(<ActivityModule stats={githubOnly} preset="7d" onPresetChange={vi.fn()} />);

      expect(screen.queryByText("Your activity will appear here after your first chat.")).toBeNull();
      const activityCell = screen.getByRole("img", { name: "Daily activity heatmap" }).querySelector("span");
      expect((activityCell as HTMLElement).style.background).not.toContain("var(--color-fg) 7%");
      fireEvent.click(screen.getByRole("tab", { name: "Code" }));
      expect(screen.getByRole("img", { name: "Code changes by day, additions and deletions" })).toBeTruthy();
      expect(screen.getByText("GitHub")).toBeTruthy();
    });

    it("counts every activity dimension: local-git-only and github-commit-only days score as active", () => {
      // Each case is a day with ONLY the listed dimensions non-zero (no tokens,
      // no sessions). Both must (a) escape the warm-empty state and (b) score
      // non-zero heatmap intensity — proving the predicate and score share the
      // complete field set.
      const cases: Array<Partial<AdeUsageDailyPoint>> = [
        { commits: 4, prs: 1, filesChanged: 3, insertions: 120, deletions: 8 }, // local git only
        { githubCommits: 5 }, // github commit only (no additions/deletions)
      ];
      for (const overrides of cases) {
        const stats = makeEmptyActivityStats();
        stats.daily = [{ ...stats.daily[0]!, ...overrides }];
        const { container, unmount } = render(<ActivityModule stats={stats} preset="7d" onPresetChange={vi.fn()} />);

        expect(screen.queryByText("Your activity will appear here after your first chat.")).toBeNull();
        const cell = container.querySelector('[aria-label="Daily activity heatmap"]')!.children[0] as HTMLElement;
        expect(Number(cell.getAttribute("data-intensity"))).toBeGreaterThan(0);
        unmount();
      }
    });
    it("shows a streak chip once the streak reaches three days", () => {
      render(<ActivityModule stats={makeActivityStats({ summary: { ...makeActivityStats().summary, currentStreakDays: 5 } })} preset="7d" onPresetChange={vi.fn()} />);
      expect(screen.getByText("5-day streak")).toBeTruthy();
    });

    it("shows the measured all-provider lifetime total on the all-time range", () => {
      const stats = makeActivityStats({
        range: { preset: "all", since: null, until: "2026-07-09T12:00:00.000Z" },
        summary: { ...makeActivityStats().summary, totalTokens: 101_500_000_000, currentStreakDays: 0 },
      });
      render(<ActivityModule stats={stats} preset="all" onPresetChange={vi.fn()} />);
      expect(screen.getByText("101.5B lifetime tokens")).toBeTruthy();
    });

    it("renders bars without motion transitions when reduced motion is preferred", () => {
      const matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("reduce"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      }));
      Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: matchMedia });

      const { container } = render(<ActivityModule stats={makeActivityStats()} preset="7d" onPresetChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("tab", { name: "Tokens" }));

      const bars = container.querySelectorAll('[role="img"] > div');
      expect(bars.length).toBeGreaterThan(0);
      bars.forEach((bar) => expect((bar as HTMLElement).style.transition).toBe(""));

      Reflect.deleteProperty(window, "matchMedia");
    });

    it("renders a compact range select and a full segmented control", () => {
      const { unmount } = render(<ActivityModule stats={makeActivityStats()} variant="compact" preset="7d" onPresetChange={vi.fn()} />);
      // Compact uses a narrow select rather than five buttons.
      expect(screen.getByLabelText("Time range")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "30d" })).toBeNull();
      unmount();

      render(<ActivityModule stats={makeActivityStats()} variant="full" preset="7d" onPresetChange={vi.fn()} />);
      expect(screen.getByRole("button", { name: "30d" })).toBeTruthy();
    });

    it("scales the heatmap to fill the box: one row for short ranges, seven for long", () => {
      const short = makeActivityStats();
      const { rerender, container } = render(<ActivityModule stats={short} preset="7d" onPresetChange={vi.fn()} />);
      const grid1 = container.querySelector('[aria-label="Daily activity heatmap"]')!;
      expect(grid1.getAttribute("data-heatmap-rows")).toBe("1");
      expect(grid1.children.length).toBe(short.daily.length);

      const long = makeActivityStats({
        daily: Array.from({ length: 30 }, (_, i) => ({
          date: `2026-06-${String(i + 1).padStart(2, "0")}`,
          inputTokens: 100 * i, outputTokens: 50 * i, totalTokens: 150 * i, cachedTokens: 0,
          commits: 0, prs: 0, insertions: 0, deletions: 0, filesChanged: 0, sessions: 1, interactions: 1,
        })),
      } as unknown as Partial<AdeUsageStats>);
      rerender(<ActivityModule stats={long} preset="30d" onPresetChange={vi.fn()} />);
      const grid2 = container.querySelector('[aria-label="Daily activity heatmap"]')!;
      expect(grid2.getAttribute("data-heatmap-rows")).toBe("7");
      expect(grid2.children.length).toBe(30);
    });

    it("shows a per-tab hint when the active tab is empty but the module has data", () => {
      const stats = makeActivityStats({
        daily: [
          { date: "2026-07-08", inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedTokens: 0, commits: 0, prs: 0, insertions: 0, deletions: 0, filesChanged: 0, sessions: 1, interactions: 2 },
          { date: "2026-07-09", inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedTokens: 0, commits: 0, prs: 0, insertions: 0, deletions: 0, filesChanged: 0, sessions: 1, interactions: 2 },
        ],
        clients: [],
      } as unknown as Partial<AdeUsageStats>);
      render(<ActivityModule stats={stats} preset="7d" onPresetChange={vi.fn()} />);

      // Global warm-empty must NOT show — the module has token activity.
      expect(screen.queryByText("Your activity will appear here after your first chat.")).toBeNull();

      // Code tab: zeroed code series → hint, but the legend stays.
      fireEvent.click(screen.getByRole("tab", { name: "Code" }));
      expect(screen.getByText("No code changes in this range.")).toBeTruthy();
      expect(screen.getByText("Added")).toBeTruthy();
      expect(screen.getByText("Removed")).toBeTruthy();

      // Clients tab: no client interactions → hint.
      fireEvent.click(screen.getByRole("tab", { name: "Clients" }));
      expect(screen.getByText("No client activity in this range.")).toBeTruthy();
    });
  });

  describe("WorkActivityModule", () => {
    let onUpdate: ((snapshot: UsageSnapshot) => void) | null;

    beforeEach(() => {
      localStorage.clear();
      onUpdate = null;
      Object.assign(window.ade, {
        usage: {
          ...window.ade.usage,
          getAdeStats: vi.fn(async () => makeActivityStats()),
          onUpdate: vi.fn((cb: (snapshot: UsageSnapshot) => void) => {
            onUpdate = cb;
            return () => {};
          }),
        },
      });
    });

    it("re-fetches stats when a background usage update lands", async () => {
      const getAdeStats = vi.mocked(window.ade.usage.getAdeStats);
      getAdeStats.mockResolvedValueOnce(makeActivityStats({ summary: { ...makeActivityStats().summary, totalTokens: 3_000 } }));

      render(<WorkActivityModule />);
      expect(await screen.findByText(/3\.0K/)).toBeTruthy();

      getAdeStats.mockResolvedValue(makeActivityStats({ summary: { ...makeActivityStats().summary, totalTokens: 9_000_000 } }));
      await act(async () => {
        onUpdate?.(makeEmptySnapshot());
      });

      expect(await screen.findByText(/9\.0M/)).toBeTruthy();
    });

    it("requests all-time stats by default", async () => {
      render(<WorkActivityModule />);

      await waitFor(() => {
        expect(window.ade.usage.getAdeStats).toHaveBeenCalledWith({ preset: "all" });
      });
    });
  });

  describe("AdeUsageSection", () => {
    let getAdeStats: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      localStorage.clear();
      getAdeStats = vi.fn(async () => makeActivityStats());
      Object.assign(window.ade, {
        usage: {
          ...window.ade.usage,
          getAdeStats,
          refresh: vi.fn(async () => makeEmptySnapshot()),
          onUpdate: vi.fn(() => () => {}),
        },
        app: {
          getProject: vi.fn(async () => ({ rootPath: "/tmp/project" })),
          onProjectChanged: vi.fn(() => () => {}),
        },
      });
    });

    it("round-trips the scope toggle through getAdeStats and persists it", async () => {
      render(<AdeUsageSection />);
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));

      await waitFor(() => expect(getAdeStats).toHaveBeenCalledWith({ preset: "all", scope: "project" }));

      fireEvent.click(screen.getByRole("button", { name: "This machine" }));

      await waitFor(() => expect(getAdeStats).toHaveBeenCalledWith({ preset: "all", scope: "machine" }));
      expect(localStorage.getItem("ade.stats.scope.v1")).toBe("machine");
    });

    it("composes a meta footer from freshness, estimation, and scope", async () => {
      getAdeStats.mockResolvedValue(makeActivityStats({
        freshness: { state: "fresh", providerUpdatedAt: new Date(Date.now() - 120_000).toISOString(), githubUpdatedAt: null },
        providers: [
          { provider: "cursor", inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, rangeCostUsd: 0, todayCostUsd: 0, last30dCostUsd: 0, estimation: "chars" },
        ],
      }));

      render(<AdeUsageSection />);
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));

      expect(await screen.findByText(/Cursor tokens estimated/)).toBeTruthy();
      expect(screen.getByText(/Provider totals scoped to this project/)).toBeTruthy();
      expect(screen.getByText(/Updated .* ago/)).toBeTruthy();
    });
  });
});
