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
import {
  ActivityModule,
  WorkActivityModule,
  readActivityPersisted,
} from "./ActivityModule";
import { computeHeatmapLayout, fillMissingDays, weekAlignment } from "./ActivityHeatmap";
import { AdeUsageSection } from "../settings/AdeUsageSection";
import { UsageLimitsBand } from "./UsageLimitsBand";
import { useUsageSnapshot } from "./useUsageSnapshot";
import {
  bucketActivityIntensity,
  describeActivityInsight,
  scoreActivityDays,
  trimLeadingInactiveDays,
} from "./activityIntensity";
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

function makeActivityDay(
  date: string,
  overrides: Partial<AdeUsageDailyPoint> = {},
): AdeUsageDailyPoint {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    commits: 0,
    prs: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
    sessions: 0,
    interactions: 0,
    ...overrides,
  };
}

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

  /**
   * The band as its only caller mounts it: presentational, over one
   * `useUsageSnapshot`.
   *
   * The band used to own that subscription itself, which is why these tests
   * could render it bare. It no longer does — the popover owns it and passes
   * the snapshot down — so the harness composes the two exactly as
   * `HeaderUsageControl` does. Every assertion below is unchanged; what they
   * exercise is now the hook and the band together, which is the pair that
   * actually ships.
   */
  function MountedBand() {
    const usage = useUsageSnapshot({ noteDemand: true });
    // The popover seeds its clock at open and ticks it; a single mount is one
    // tick, which is all any assertion here reads.
    const [nowMs] = React.useState(() => Date.now());
    return <UsageLimitsBand nowMs={nowMs} usage={usage} />;
  }

  describe("UsageLimitsBand", () => {
    it("renders the weekly used percent for each authed provider", async () => {
      render(<MountedBand />);

      expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
      expect(await screen.findByText(/63\.0% used/)).toBeTruthy();
      expect(screen.queryByText("37.0% remaining")).toBeNull();
    });

    it("opens each provider usage page in the user's browser", async () => {
      render(<MountedBand />);

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

      render(<MountedBand />);

      expect((await screen.findAllByText("Weekly")).length).toBeGreaterThan(0);
      expect(await screen.findByText("Monthly")).toBeTruthy();
      expect(await screen.findByText(/44\.0% used/)).toBeTruthy();
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

      render(<MountedBand />);

      expect(await screen.findByRole("progressbar", { name: "5-hour: 48.0% used" })).toBeTruthy();
      expect(screen.getByRole("progressbar", { name: "Weekly: 63.0% used" })).toBeTruthy();
      expect(screen.getByText("on track")).toBeTruthy();
      expect(screen.getByText("13% ahead")).toBeTruthy();
      expect(screen.getByText(/trending to 126% by reset/)).toBeTruthy();
    });

    it("registers non-interactive quota demand on mount without forcing user auth", async () => {
      render(<MountedBand />);

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

      render(<MountedBand />);

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

      render(<MountedBand />);

      expect((await screen.findAllByText("Claude")).length).toBeGreaterThan(0);
      expect((await screen.findAllByText("Codex")).length).toBeGreaterThan(0);
      expect(screen.queryByText("No provider CLIs detected")).toBeNull();
    });

    /**
     * The band is rendered onto the popover's bare surface, so the card is the
     * only thing giving the provider stack — and the empty state — an edge of
     * their own. Nothing pinned these classes, so a cleanup pass dropped them
     * and shipped green: the stack floated on the popover background.
     */
    it("draws the provider stack and the empty state on their own card surface", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      snapshot.extraUsage = [{
        provider: "claude",
        isEnabled: true,
        usedCreditsUsd: 12.5,
        monthlyLimitUsd: 50,
        utilization: 0.25,
        currency: "USD",
      }];
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);

      const { unmount } = render(<MountedBand />);
      const stack = (await screen.findAllByText("Codex"))[0].closest(".rounded-xl.bg-surface-raised");
      expect(stack).toBeTruthy();
      expect(stack?.className).toContain("shadow-panel");
      // The extra-usage card is already padded; the grid holding it must not
      // add a second inset inside the popover's own padding.
      const extraGrid = screen.getByText("$12.50").closest(".grid");
      expect(extraGrid).toBeTruthy();
      expect(extraGrid?.className).not.toContain("px-4");
      unmount();

      vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
        makeAiStatus({
          claude: makeProviderConnection("claude"),
          codex: makeProviderConnection("codex"),
        }),
      );
      render(<MountedBand />);
      const empty = (await screen.findByText("No provider CLIs detected")).closest(".rounded-xl");
      expect(empty?.className).toContain("bg-surface-raised");
      expect(empty?.className).toContain("shadow-panel");
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

      render(<MountedBand />);

      expect(await screen.findByText(/Claude sign-in required/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
      expect(screen.queryByText(/20\.0% used/)).toBeNull();
    });

    // `Intl` throws a RangeError on a currency that is not a well-formed ISO
    // 4217 code, and that throw happens during render — it took the whole band
    // down, not just the one card, for a value that arrives from a provider.
    it("still renders the band when a provider reports a malformed currency", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      snapshot.extraUsage = [
        {
          provider: "claude",
          isEnabled: true,
          usedCreditsUsd: 12.5,
          monthlyLimitUsd: 50,
          utilization: 0.25,
          currency: "dollars",
        },
        {
          provider: "codex",
          isEnabled: true,
          usedCreditsUsd: 3,
          monthlyLimitUsd: 20,
          utilization: 0.15,
          currency: undefined as unknown as string,
        },
      ];
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);

      render(<MountedBand />);

      // The rest of the band is intact...
      expect(await screen.findByText(/63\.0% used/)).toBeTruthy();
      // ...and both bad-currency cards fall back to USD rather than throwing.
      expect(screen.getByText("$12.50")).toBeTruthy();
      expect(screen.getByText("$3.00")).toBeTruthy();
    });

    // A failed refresh used to take a full-width bar inside the provider's
    // card, above pace bars that were still showing live readings, and it never
    // went away. The pass after that demoted it to three words with the
    // provider's own sentence hidden in a `title` — legible to nobody. It now
    // shows the real message, says the figures below are still good, and can be
    // dismissed.
    it("shows the provider's own failure message beside the readings it did not invalidate", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      snapshot.providerStatus = {
        claude: {
          state: "stale",
          source: "oauth",
          message: "Couldn't refresh Claude — showing last reading",
          updatedAt: "2026-05-21T19:00:00.000Z",
        },
      } as UsageSnapshot["providerStatus"];
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);

      render(<MountedBand />);

      // The readings are still on screen, and the provider's sentence is real
      // text rather than a tooltip.
      expect(await screen.findByText(/20\.0% used/)).toBeTruthy();
      expect(screen.getByText("Couldn't refresh Claude — showing last reading")).toBeTruthy();
      // And it never implies the numbers below are gone.
      expect(screen.getByText(/Figures below are the last good reading/)).toBeTruthy();
      expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    });

    // The Retry the user reported as dead: with a rate-limited provider the
    // service honours its backoff even for a user-initiated refresh, skips the
    // poll, and carries the previous status forward verbatim — so the button
    // could not have changed anything. Say when the next attempt happens
    // instead of offering an action that cannot work.
    it("disables Retry while the provider is still under rate-limit backoff", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      snapshot.providerStatus = {
        claude: {
          state: "stale",
          source: "oauth",
          errorKind: "rate_limited",
          nextRetryAt: new Date(Date.now() + 8 * 60_000).toISOString(),
          message: "Couldn't refresh Claude — showing last reading",
          updatedAt: "2026-05-21T19:00:00.000Z",
        },
      } as UsageSnapshot["providerStatus"];
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);

      render(<MountedBand />);

      const retry = await screen.findByRole("button", { name: /Retry/ });
      expect((retry as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/Retries again in 8 min/)).toBeTruthy();
    });

    // A Retry that resolves with the provider still failing must say so. The
    // previous version resolved silently, which is indistinguishable from a
    // button that is not wired to anything.
    it("reports that a retry failed when the provider is still not ok", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      snapshot.providerStatus = {
        claude: {
          state: "stale",
          source: "oauth",
          message: "Couldn't refresh Claude — showing last reading",
          updatedAt: "2026-05-21T19:00:00.000Z",
        },
      } as UsageSnapshot["providerStatus"];
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.refresh).mockResolvedValue(snapshot);

      render(<MountedBand />);

      const retry = await screen.findByRole("button", { name: /Retry/ });
      fireEvent.click(retry);

      expect(await screen.findByText(/still failing/i)).toBeTruthy();
    });

    // The user's escape hatch: gone for this visit, back on the next one.
    it("dismisses the failure notice for the life of the mount", async () => {
      const snapshot = makeQuotaPanelSnapshot();
      snapshot.providerStatus = {
        claude: {
          state: "stale",
          source: "oauth",
          message: "Couldn't refresh Claude — showing last reading",
          updatedAt: "2026-05-21T19:00:00.000Z",
        },
      } as UsageSnapshot["providerStatus"];
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(snapshot);
      vi.mocked(window.ade.usage.noteDemand).mockResolvedValue(snapshot);

      const { unmount } = render(<MountedBand />);

      fireEvent.click(await screen.findByRole("button", { name: "Dismiss this warning" }));
      expect(screen.queryByText("Couldn't refresh Claude — showing last reading")).toBeNull();
      // The readings it was sitting above are untouched.
      expect(screen.getByText(/20\.0% used/)).toBeTruthy();

      // Nothing is persisted, so the next open shows it again.
      unmount();
      render(<MountedBand />);
      expect(
        await screen.findByText("Couldn't refresh Claude — showing last reading"),
      ).toBeTruthy();
    });

    it("never renders a Cursor section", async () => {
      render(<MountedBand />);

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

      render(<MountedBand />);

      expect(await screen.findByText(/63\.0% used/)).toBeTruthy();
      await act(async () => { await Promise.resolve(); });
      expect(window.ade.usage.refresh).not.toHaveBeenCalled();
    });

    /**
     * Retargeted, not weakened.
     *
     * This drove the band's own "Refresh limits" button, which lived behind a
     * `showRefreshControl` prop no production caller ever passed. The popover's
     * header Refresh is the control that actually ships and it runs the very
     * same `refreshNow`, so the whole flow is exercised through the real
     * surface: open the popover, refresh, rebind underneath it, and prove the
     * in-flight response for the old binding is discarded.
     */
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

      render(<HeaderUsageControl />);
      fireEvent.click(screen.getByRole("button", { name: /^Usage/ }));
      expect(await screen.findByText(/63\.0% used/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
      await waitFor(() => expect(window.ade.usage.refresh).toHaveBeenCalledTimes(1));

      currentSnapshot = reboundSnapshot;
      await act(async () => {
        onBindingChanged?.(null);
      });
      expect(await screen.findByText(/42\.0% used/)).toBeTruthy();

      await act(async () => {
        refresh.resolve(oldBindingResponse);
        await refresh.promise;
      });
      expect(screen.getByText(/42\.0% used/)).toBeTruthy();
      expect(screen.queryByText(/91\.0% used/)).toBeNull();
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

    /**
     * Which provider CLIs are configured is answered by whichever runtime the
     * project is bound to, so a rebind has to re-ask — the dependency that
     * drives it is a bare `void bindingRevision;`, load-bearing and easy to
     * mistake for dead code. And until the new answer lands the old runtime's
     * chips must come down: they describe a machine this window is no longer
     * looking at.
     */
    it("re-reads provider connections on rebind and drops the old runtime's chips first", async () => {
      let onBindingChanged: Parameters<Window["ade"]["app"]["onProjectBindingChanged"]>[0] | null = null;
      vi.mocked(window.ade.app.onProjectBindingChanged).mockImplementation((callback) => {
        onBindingChanged = callback;
        return () => {};
      });
      // The snapshot only ever reports Codex; Claude is on screen purely
      // because the first runtime said it was configured.
      vi.mocked(window.ade.usage.getSnapshot).mockResolvedValue(makeHeaderUsageSnapshot());
      const rebound = deferred<AiSettingsStatus>();
      vi.mocked(window.ade.ai.getStatus)
        .mockResolvedValueOnce(makeAiStatus({
          claude: makeProviderConnection("claude", { runtimeDetected: true, authAvailable: true }),
          codex: makeProviderConnection("codex"),
        }))
        .mockReturnValueOnce(rebound.promise);

      render(<HeaderUsageControl />);
      expect(await screen.findByRole("button", { name: /Claude wk/ })).toBeTruthy();

      await act(async () => {
        onBindingChanged?.(null);
      });

      // The rebind re-asked...
      expect(window.ade.ai.getStatus).toHaveBeenCalledTimes(2);
      // ...and while that answer is in flight the previous runtime's Claude
      // chip is gone rather than lingering over the new project.
      expect(screen.queryByRole("button", { name: /Claude wk/ })).toBeNull();

      await act(async () => {
        rebound.resolve(makeAiStatus({
          claude: makeProviderConnection("claude"),
          codex: makeProviderConnection("codex", { runtimeDetected: true, authAvailable: true }),
        }));
        await rebound.promise;
      });

      expect(await screen.findByRole("button", { name: /Codex wk/ })).toBeTruthy();
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
        expect(Number(cell.getAttribute("data-level"))).toBeGreaterThan(0);
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

    it("lays the heatmap out as square cells: one row for short ranges, seven for long", () => {
      const short = makeActivityStats();
      const { rerender, container } = render(<ActivityModule stats={short} preset="7d" onPresetChange={vi.fn()} />);
      const grid1 = container.querySelector('[aria-label="Daily activity heatmap"]')! as HTMLElement;
      expect(grid1.getAttribute("data-heatmap-rows")).toBe("1");
      expect(grid1.children.length).toBe(short.daily.length);
      // Height derives from the square cell size, not from a fixed chart band.
      expect(grid1.getAttribute("data-heatmap-cell")).toBe("16");
      expect(grid1.style.height).toBe("16px");

      const long = makeActivityStats({
        daily: Array.from({ length: 30 }, (_, i) => ({
          date: `2026-06-${String(i + 1).padStart(2, "0")}`,
          inputTokens: 100 * i, outputTokens: 50 * i, totalTokens: 150 * i, cachedTokens: 0,
          commits: 0, prs: 0, insertions: 0, deletions: 0, filesChanged: 0, sessions: 1, interactions: 1,
        })),
      } as unknown as Partial<AdeUsageStats>);
      rerender(<ActivityModule stats={long} preset="30d" onPresetChange={vi.fn()} />);
      const grid2 = container.querySelector('[aria-label="Daily activity heatmap"]')! as HTMLElement;
      expect(grid2.getAttribute("data-heatmap-rows")).toBe("7");
      expect(grid2.children.length).toBe(30);
      // 7 rows of 16px cells plus six 3px gaps.
      expect(grid2.style.height).toBe("130px");
    });

    it("lays the heatmap out by date: gaps become cells, and week one starts on its own weekday", () => {
      // Two active days nineteen days apart. Laid out by array index these were
      // adjacent cells; laid out by date the gap is eighteen empty days wide.
      const daily = [
        makeActivityDay("2026-06-01", { totalTokens: 1_000, sessions: 1 }),
        makeActivityDay("2026-06-20", { totalTokens: 900_000, sessions: 4 }),
      ];
      const { container } = render(
        <ActivityModule stats={makeActivityStats({ daily } as unknown as Partial<AdeUsageStats>)} preset="year" onPresetChange={vi.fn()} />,
      );

      const grid = container.querySelector('[aria-label="Daily activity heatmap"]')! as HTMLElement;
      const cells = Array.from(grid.children) as HTMLElement[];
      expect(cells.length).toBe(20);
      expect(cells.map((cell) => cell.getAttribute("data-level")).slice(0, 3)).toEqual(["1", "0", "0"]);
      expect(cells.at(-1)!.getAttribute("data-level")).toBe("4");
      // 2026-06-01 is a Monday, so the first cell sits on row 2 of the column
      // and every later cell keeps its real weekday row.
      expect(cells[0]!.style.gridRowStart).toBe("2");
      expect(cells[1]!.style.gridRowStart).toBe("");
    });

    it("clamps the heatmap window to the first active day", () => {
      const daily = Array.from({ length: 20 }, (_, i) =>
        makeActivityDay(`2026-06-${String(i + 1).padStart(2, "0")}`),
      );
      // Active on the 16th and the 20th; the 17th-19th gap must survive.
      daily[15] = { ...daily[15]!, totalTokens: 1_500, sessions: 1, interactions: 2 };
      daily[19] = { ...daily[19]!, totalTokens: 900_000, sessions: 4, interactions: 30 };
      const { container } = render(
        <ActivityModule stats={makeActivityStats({ daily } as unknown as Partial<AdeUsageStats>)} preset="30d" onPresetChange={vi.fn()} />,
      );

      const grid = container.querySelector('[aria-label="Daily activity heatmap"]')!;
      expect(grid.children.length).toBe(5);
      expect(Array.from(grid.children, (cell) => cell.getAttribute("data-level"))).toEqual(["1", "0", "0", "0", "4"]);
    });

    it("draws each intensity level in its own colour rather than one hue at five opacities", () => {
      // Twelve days spanning the whole quartile range, with one interior idle
      // day, so every level from empty to peak appears in the grid.
      const daily = Array.from({ length: 12 }, (_, i) =>
        makeActivityDay(`2026-06-${String(i + 1).padStart(2, "0")}`, {
          totalTokens: i === 5 ? 0 : (i + 1) * (i + 1) * 5_000,
        }),
      );
      const { container } = render(
        <ActivityModule stats={makeActivityStats({ daily } as unknown as Partial<AdeUsageStats>)} preset="30d" onPresetChange={vi.fn()} />,
      );

      const cells = Array.from(
        container.querySelector('[aria-label="Daily activity heatmap"]')!.children,
      ) as HTMLElement[];
      // jsdom drops `color-mix()` from the parsed `background` shorthand, so
      // the raw style attribute is what carries the declared value here.
      const byLevel = new Map<string, string>();
      for (const cell of cells) byLevel.set(cell.getAttribute("data-level")!, cell.getAttribute("style") ?? "");

      // All five levels present, each with its own colour value: a single-hue
      // opacity ramp would repeat one token five times.
      expect([...byLevel.keys()].sort()).toEqual(["0", "1", "2", "3", "4"]);
      const backgrounds = [...byLevel.values()].map((style) => /background:\s*([^;]+)/.exec(style)?.[1] ?? "");
      expect(new Set(backgrounds).size).toBe(5);
      // Only the empty level is a theme-mix of the foreground; the active
      // levels carry real ramp colours, and none of them is the accent the
      // flat single-hue version leaned on.
      expect(byLevel.get("0")).toContain("var(--color-fg)");
      for (const level of ["1", "2", "3", "4"]) {
        expect(byLevel.get(level)).not.toContain("var(--color-fg)");
        expect(byLevel.get(level)).not.toContain("var(--color-accent)");
      }
    });

    it("rings today's cell so the grid has an anchor", () => {
      const today = new Date();
      const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const daily = [
        makeActivityDay("2026-01-01", { totalTokens: 1_000, sessions: 1 }),
        makeActivityDay(key, { totalTokens: 5_000, sessions: 2 }),
      ];
      const { container } = render(
        <ActivityModule stats={makeActivityStats({ daily } as unknown as Partial<AdeUsageStats>)} preset="30d" onPresetChange={vi.fn()} />,
      );

      const cells = Array.from(
        container.querySelector('[aria-label="Daily activity heatmap"]')!.children,
      ) as HTMLElement[];
      const marked = cells.filter((cell) => cell.getAttribute("data-today") === "true");
      expect(marked.length).toBe(1);
      expect(marked[0]!.getAttribute("style")).toContain("1.5px");
      expect(cells[0]!.getAttribute("data-today")).toBeNull();
      expect(cells[0]!.getAttribute("style")).not.toContain("1.5px");
    });

    it("leads with one plain-language fact about the range", () => {
      // Two flat weeks then a doubled week: a trend callout, not a record.
      const daily = Array.from({ length: 21 }, (_, i) =>
        makeActivityDay(`2026-06-${String(i + 1).padStart(2, "0")}`, {
          totalTokens: i < 14 ? 10_000 : 30_000,
        }),
      );
      render(
        <ActivityModule stats={makeActivityStats({ daily } as unknown as Partial<AdeUsageStats>)} preset="30d" onPresetChange={vi.fn()} />,
      );

      expect(screen.getByText(/This week/)).toBeTruthy();
      expect(screen.getByText("+200%")).toBeTruthy();
    });

    it("computes a content-sized heatmap layout, shrinking cells when the natural width does not fit", () => {
      // Unmeasured: natural size at the max cell, nothing dropped.
      expect(computeHeatmapLayout({ cellCount: 30, maxCell: 13, availableWidth: 0 })).toEqual({
        rows: 7, cols: 5, cell: 13, width: 5 * 13 + 4 * 3, visible: 30,
      });

      // Fits with room to spare: cells stay at max and the grid stops short of
      // the available width — the card is what shrinks, not the cells.
      const roomy = computeHeatmapLayout({ cellCount: 30, maxCell: 13, availableWidth: 800 });
      expect(roomy).toMatchObject({ cell: 13, cols: 5, visible: 30 });
      expect(roomy.width).toBeLessThan(800);

      // Natural width exceeds available: cells shrink toward the floor, every
      // day still renders, and the grid fits.
      const tight = computeHeatmapLayout({ cellCount: 371, maxCell: 13, availableWidth: 800 });
      expect(tight.cell).toBeLessThan(13);
      expect(tight.cell).toBeGreaterThanOrEqual(6);
      expect(tight.visible).toBe(371);
      expect(tight.width).toBeLessThanOrEqual(800);

      // Past the floor: oldest columns are dropped rather than overflowing.
      const overflowing = computeHeatmapLayout({ cellCount: 900, maxCell: 13, availableWidth: 800 });
      expect(overflowing.cell).toBe(6);
      expect(overflowing.visible).toBeLessThan(900);
      expect(overflowing.visible % 7).toBe(0);
      expect(overflowing.width).toBeLessThanOrEqual(800);
    });

    it("sizes the card to the heatmap grid instead of stretching it across the slot", () => {
      const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
      class TestResizeObserver implements ResizeObserver {
        private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: [] };
          observers.push(this.entry);
        }
        observe(target: Element): void { this.entry.targets.push(target); }
        unobserve(): void {}
        disconnect(): void {}
      }
      const original = globalThis.ResizeObserver;
      Object.assign(globalThis, { ResizeObserver: TestResizeObserver });
      const emit = (width: number) => {
        for (const observer of observers) {
          observer.callback(
            observer.targets.map((target) => ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry),
            {} as ResizeObserver,
          );
        }
      };
      const dailyFrom = (days: number) =>
        Array.from({ length: days }, (_, index) => {
          const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
          return makeActivityDay(date, {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            sessions: 1,
            interactions: 1,
          });
        });

      try {
        const { container, rerender } = render(
          <ActivityModule
            stats={makeActivityStats({ daily: dailyFrom(400) } as unknown as Partial<AdeUsageStats>)}
            variant="compact"
            preset="all"
            onPresetChange={vi.fn()}
            className="w-full max-w-[820px]"
          />,
        );
        act(() => emit(820));

        const card = container.querySelector("[data-activity-module]") as HTMLElement;
        const grid = container.querySelector('[aria-label="Daily activity heatmap"]') as HTMLElement;
        const cardWidth = Number.parseFloat(card.style.width);
        const gridWidth = Number.parseFloat(grid.style.width);
        // Card = grid + its own padding, and it stops short of the 820px slot:
        // the leftover becomes centring margin, not dead space inside the card.
        expect(gridWidth).toBeGreaterThan(0);
        expect(cardWidth).toBe(gridWidth + 20);
        expect(cardWidth).toBeLessThan(820);
        expect(Number(grid.getAttribute("data-heatmap-cell"))).toBeLessThanOrEqual(13);
        expect(grid.children.length).toBe(400);

        // Far past the natural fit: cells bottom out at the floor, the grid
        // still fits the slot, and the oldest columns are dropped.
        rerender(
          <ActivityModule
            stats={makeActivityStats({ daily: dailyFrom(900) } as unknown as Partial<AdeUsageStats>)}
            variant="compact"
            preset="all"
            onPresetChange={vi.fn()}
            className="w-full max-w-[820px]"
          />,
        );
        const wide = container.querySelector('[aria-label="Daily activity heatmap"]') as HTMLElement;
        expect(wide.getAttribute("data-heatmap-cell")).toBe("6");
        expect(Number.parseFloat(wide.style.width)).toBeLessThanOrEqual(800);
        expect(wide.children.length).toBeLessThan(900);
      } finally {
        if (original) Object.assign(globalThis, { ResizeObserver: original });
        else Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
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

    // The page is a single scroll now, so stats load on mount rather than
    // behind an "Activity" tab, and the scope control gained an account option.
    it("round-trips the scope toggle through getAdeStats and persists it", async () => {
      render(<AdeUsageSection />);

      await waitFor(() => expect(getAdeStats).toHaveBeenCalledWith({ preset: "all", scope: "project" }));

      fireEvent.click(screen.getByRole("button", { name: "This machine" }));

      await waitFor(() => expect(getAdeStats).toHaveBeenCalledWith({ preset: "all", scope: "machine" }));
      expect(localStorage.getItem("ade.stats.scope.v1")).toBe("machine");

      fireEvent.click(screen.getByRole("button", { name: "All machines" }));

      await waitFor(() => expect(getAdeStats).toHaveBeenCalledWith({ preset: "all", scope: "account" }));
      expect(localStorage.getItem("ade.stats.scope.v1")).toBe("account");
    });

    // The meta footer was replaced by three targeted disclosures: freshness in
    // the header, estimation on the cost hero's asterisk, and scope stated by
    // the control itself. Host source notes are still surfaced verbatim.
    it("discloses freshness, estimation, and host source notes", async () => {
      getAdeStats.mockResolvedValue(makeActivityStats({
        freshness: { state: "fresh", providerUpdatedAt: new Date(Date.now() - 120_000).toISOString(), githubUpdatedAt: null },
        providers: [
          { provider: "cursor", inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, rangeCostUsd: 0, todayCostUsd: 0, last30dCostUsd: 0, estimation: "chars" },
        ],
        sourceNotes: ["Cursor ledger covers this machine only."],
      }));

      render(<AdeUsageSection />);

      // Freshness moved into the page subtitle.
      expect(await screen.findByText(/updated .* ago/i)).toBeTruthy();

      // The asterisk names how many providers are estimated, and its tooltip
      // names which one and why.
      const footnote = screen.getByText(/if billed at full API rate/);
      expect(footnote.textContent).toMatch(/one provider is estimated/);
      const explained = screen.getByTitle(/counted from text length/);
      expect(explained.getAttribute("title")).toMatch(/Cursor/);

      // Scope is stated by the control rather than restated in prose.
      expect(screen.getByRole("button", { name: "This project" }).getAttribute("aria-pressed")).toBe("true");

      expect(screen.getByText(/Cursor ledger covers this machine only\./)).toBeTruthy();
    });

    // The Settings shell prints the page title and its description above this
    // component. Printing them again gave the page two "Usage" headings.
    it("leaves the page title to the Settings shell", async () => {
      render(<AdeUsageSection />);

      await waitFor(() => expect(getAdeStats).toHaveBeenCalled());
      expect(screen.queryByRole("heading", { name: "Usage" })).toBeNull();
      // The range and freshness line is this component's to draw — the shell
      // has no idea what is on screen.
      expect(screen.getByText(/updated .* ago/i)).toBeTruthy();
    });

    // "Daily cost needs a newer host" named the wrong cause: the commonest way
    // a current machine loses its per-provider daily split is the default
    // project scope, where ledgers that cannot attribute a row to a project are
    // dropped entirely. Say that, and offer the scope that has the data.
    it("explains a missing daily cost split by scope instead of blaming the host", async () => {
      // Daily points with tokens but no `byProvider` — exactly what the ADE-DB
      // gap-fill produces once the provider ledgers drop out.
      getAdeStats.mockResolvedValue(makeActivityStats({
        daily: [
          makeActivityDay("2026-07-08", { totalTokens: 1_500 }),
          makeActivityDay("2026-07-09", { totalTokens: 2_500 }),
        ],
      } as unknown as Partial<AdeUsageStats>));

      render(<AdeUsageSection />);

      expect(await screen.findByText(/Cost isn't tracked per project/)).toBeTruthy();
      expect(screen.queryByText(/newer host/i)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Show this machine" }));

      await waitFor(() => expect(getAdeStats).toHaveBeenCalledWith({ preset: "all", scope: "machine" }));
      expect(await screen.findByText(/No cost by day in this range/)).toBeTruthy();
    });

    // `range.since`/`until` are full ISO timestamps, not bare YYYY-MM-DD days.
    // Treating them as days produced `...ZT00:00:00` -> Invalid Date, which
    // rendered "Invalid Date – Invalid Date" in the subheader and, through the
    // same mistake in the day enumerator, left the daily chart empty on every
    // preset. Nothing asserted either, so it survived to review.
    it("renders a real date range from ISO range bounds", async () => {
      getAdeStats.mockResolvedValue(makeActivityStats({
        range: {
          preset: "7d",
          since: "2026-07-03T00:00:00.000Z",
          until: "2026-07-09T12:00:00.000Z",
        },
      }));

      render(<AdeUsageSection />);

      const subheader = await screen.findByText(/–/);
      expect(subheader.textContent).not.toMatch(/Invalid Date/);
      expect(subheader.textContent).toMatch(/Jul/);
    });

    // On the `all` preset the ledger scan appends a point for every date it
    // ever saw (up to 3650 days back), which sorts ahead of the gap-free
    // skeleton. The chart spaces columns by index, so a sparse multi-year tail
    // renders at the same pitch as the dense recent window — quiet years drawn
    // as busy as this week. Nothing errors, which is why it needs a test.
    it("drops the sparse pre-skeleton tail from the daily axis", async () => {
      getAdeStats.mockResolvedValue(makeActivityStats({
        range: { preset: "all", since: null, until: "2026-07-09T12:00:00.000Z" },
        daily: [
          // Two isolated days from years ago, then a contiguous recent run.
          makeActivityDay("2024-02-03", { totalTokens: 900 }),
          makeActivityDay("2024-09-17", { totalTokens: 400 }),
          makeActivityDay("2026-07-07", { totalTokens: 100 }),
          makeActivityDay("2026-07-08", { totalTokens: 200 }),
          makeActivityDay("2026-07-09", { totalTokens: 300 }),
        ],
      }));

      const { container } = render(<AdeUsageSection />);

      await waitFor(() => {
        const chart = container.querySelector('svg[role="img"]');
        expect(chart).toBeTruthy();
        // Three contiguous days, not the five the host emitted: the 2024
        // outliers sit before a gap and are cut from the axis.
        expect(chart?.getAttribute("aria-label")).toMatch(/across 3 days/);
      });
    });

    // Live quota is the top-bar meter's job, full stop. It used to sit in the
    // middle of this page; then at the foot behind a disclosure. Both were a
    // second copy of a number that is already on screen in every tab, on a page
    // that exists for spend and history. There is no quota here now — and no
    // drawer state to persist, so the old `ade.stats.liveLimits.open.v1` key is
    // deliberately gone.
    // The strip used to put ADE-DB code movement next to GitHub pull-request
    // counts with nothing saying which was which, and its code-movement tile
    // read `summary.insertions + deletions` — ADE's own `session_deltas`, which
    // on a real machine had been all zeros for weeks while GitHub reported
    // thousands of changed lines. Both numbers now name their source, and the
    // tile prefers the labeled `githubActivity` split that was already computed
    // and never rendered.
    it("names each metric's source and takes code movement from GitHub PR lines", async () => {
      getAdeStats.mockResolvedValue(makeActivityStats({
        summary: {
          ...makeActivityStats().summary,
          // The permanently-zero local source that used to drive the tile.
          insertions: 0,
          deletions: 0,
          filesChanged: 0,
        },
        githubActivity: {
          commits: 33,
          prsTracked: 7,
          prsOpen: 2,
          prsMerged: 4,
          prsClosed: 1,
          prAdditions: 9_106,
          prDeletions: 2_894,
        },
        localActivity: {
          commits: 0,
          pushOperations: 0,
          prLandings: 0,
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
        },
      } as unknown as Partial<AdeUsageStats>));

      render(<AdeUsageSection />);

      expect(await screen.findByText("Lines changed")).toBeTruthy();
      expect(screen.getByText("12,000")).toBeTruthy();
      expect(screen.getByText("+9,106 / −2,894 in pull requests")).toBeTruthy();
      // Pull requests read from the same labeled group, not the flat summary.
      expect(screen.getByText("4 merged")).toBeTruthy();
      expect(screen.getAllByText("GitHub").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Providers").length).toBe(3);
    });

    it("falls back to local code movement, and shows no number when neither source measured anything", async () => {
      getAdeStats.mockResolvedValue(makeActivityStats({
        localActivity: {
          commits: 2, pushOperations: 1, prLandings: 1, filesChanged: 6, insertions: 200, deletions: 30,
        },
        githubActivity: {
          commits: 0, prsTracked: 0, prsOpen: 0, prsMerged: 0, prsClosed: 0, prAdditions: 0, prDeletions: 0,
        },
      } as unknown as Partial<AdeUsageStats>));
      const { unmount } = render(<AdeUsageSection />);

      expect(await screen.findByText("+200 / −30 across 6 files")).toBeTruthy();
      expect(screen.getByText("Local git")).toBeTruthy();
      unmount();

      getAdeStats.mockResolvedValue(makeActivityStats({
        summary: { ...makeActivityStats().summary, insertions: 0, deletions: 0, filesChanged: 0 },
        localActivity: {
          commits: 0, pushOperations: 0, prLandings: 0, filesChanged: 0, insertions: 0, deletions: 0,
        },
        githubActivity: {
          commits: 0, prsTracked: 0, prsOpen: 0, prsMerged: 0, prsClosed: 0, prAdditions: 0, prDeletions: 0,
        },
      } as unknown as Partial<AdeUsageStats>));
      render(<AdeUsageSection />);

      // A permanently-zero metric is worse than no metric: say nothing was
      // measured rather than assert a confident 0.
      expect(await screen.findByText("no code changes recorded in this range")).toBeTruthy();
    });

    /**
     * A full ledger scan can outrun any budget in front of it. When it did, the
     * forced-refresh path deleted the cache, cleared the stats and rendered the
     * rejection verbatim — so pressing Refresh on a slow machine blanked the
     * page and printed `IPC handler for 'ade.usage.refreshHistory' timed out
     * after 30000ms` at the user.
     */
    it("keeps the numbers on screen when a forced refresh fails, and never shows the raw error", async () => {
      render(<AdeUsageSection />);
      expect(await screen.findByText("Estimated cost")).toBeTruthy();

      const timeout = new Error("IPC handler for 'ade.usage.refreshHistory' timed out after 30000ms");
      Object.assign(window.ade.usage, {
        refreshHistory: vi.fn(async () => { throw timeout; }),
      });

      fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));

      expect(await screen.findByText("Couldn't refresh. Showing the last numbers.")).toBeTruthy();
      // The page still has its numbers...
      expect(screen.getByText("Estimated cost")).toBeTruthy();
      // ...and the internal timeout stays in the log, not on screen.
      expect(screen.queryByText(/timed out after 30000ms/)).toBeNull();
      expect(screen.queryByText(/ade\.usage\./)).toBeNull();
    });

    /**
     * `usageStatsCache` has no TTL and no invalidation, so once a key has
     * loaded, a non-forced failure used to render the fully-populated stale
     * copy with no error at all — a permanently broken backend was
     * indistinguishable from a healthy page. Quiet, but never silent.
     */
    it("marks the numbers stale when a background load fails, without blanking the page", async () => {
      render(<AdeUsageSection />);
      expect(await screen.findByText("Estimated cost")).toBeTruthy();

      // Populate a second key, then come back to the first. Returning to an
      // already-cached key is what exercises the stale branch — switching to a
      // *new* preset has nothing cached to fall back on, so it takes the
      // blank-and-report path instead.
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      await waitFor(() =>
        expect(getAdeStats).toHaveBeenCalledWith(expect.objectContaining({ preset: "7d" })),
      );

      Object.assign(window.ade.usage, {
        getAdeStats: vi.fn(async () => { throw new Error("ade.usage.getAdeStats timed out"); }),
      });

      fireEvent.click(screen.getByRole("button", { name: "All" }));

      expect(await screen.findByText("Couldn't check for new usage. Showing the last numbers.")).toBeTruthy();
      expect(screen.getByText("Estimated cost")).toBeTruthy();
      expect(screen.queryByText(/timed out/)).toBeNull();
    });

    it("carries no live quota band and no drawer state", async () => {
      render(<AdeUsageSection />);

      // The page itself rendered.
      expect(await screen.findByText("Estimated cost")).toBeTruthy();

      expect(screen.queryByRole("button", { name: /Live limits/ })).toBeNull();
      expect(screen.queryByText(/63\.0% used/)).toBeNull();
      expect(localStorage.getItem("ade.stats.liveLimits.open.v1")).toBeNull();
    });

    // The machine list previously read a locally-declared shape through a
    // structural cast, so every field name silently missed what the merge
    // actually emits: keys were undefined and the dedupe explanation could
    // never render. This pins the real contract.
    it("renders contributing machines from the shared contract", async () => {
      getAdeStats.mockResolvedValue(makeActivityStats({
        machines: [
          {
            machineKey: "acct:studio",
            label: "Studio Mac",
            platform: "darwin",
            isLocal: true,
            state: "live",
            lastReportedAt: new Date().toISOString(),
            totalTokens: 1_500,
            costUsd: 0.3,
          },
          {
            machineKey: "acct:laptop",
            label: "Laptop",
            platform: "darwin",
            isLocal: false,
            state: "deduped",
            lastReportedAt: new Date().toISOString(),
            // A machine *key*, which is what the shared contract carries — not
            // the display label. Pinning a label here would defeat the point of
            // a test that exists to catch field-shape drift.
            dedupedAgainstMachineKey: "acct:studio",
            totalTokens: 0,
            costUsd: 0,
          },
          {
            machineKey: "acct:linux-box",
            label: "Linux Box",
            platform: "linux",
            isLocal: false,
            state: "failed",
            lastReportedAt: null,
            message: "Couldn't reach this computer",
            totalTokens: 0,
            costUsd: 0,
          },
        ],
      } as unknown as Partial<AdeUsageStats>));

      render(<AdeUsageSection />);

      expect(await screen.findByText("Studio Mac")).toBeTruthy();
      // The UI prints the raw key today; resolving it to the peer's label would
      // be a product improvement, so this asserts what actually renders rather
      // than pretending the lookup already happens.
      expect(screen.getByText(/counted once with acct:studio/)).toBeTruthy();
      // A machine that could not report says so in the merge's own words.
      expect(screen.getByText(/Couldn't reach this computer/)).toBeTruthy();
    });
  });
});

describe("activity heatmap intensity", () => {
  it("spreads an outlier-dominated distribution across all four levels", () => {
    const levels = bucketActivityIntensity([
      1_000, 4_000, 9_000, 20_000, 60_000, 150_000, 400_000, 35_900_000_000,
    ]);

    expect(levels).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(new Set(levels).size).toBe(4);
  });

  it.each([
    [[500, 500, 500, 500], [4, 4, 4, 4]],
    [[0, 0, 7, 0], [0, 0, 4, 0]],
    [[0, 0, 0], [0, 0, 0]],
    [[], []],
  ])("maps $0 to $1", (values, expected) => {
    expect(bucketActivityIntensity(values)).toEqual(expected);
  });

  it("ignores empty days when computing quartiles and keeps the busiest day at level 4", () => {
    const dense = bucketActivityIntensity([10, 20, 30, 40]);
    const sparse = bucketActivityIntensity([0, 10, 0, 20, 0, 30, 0, 40, 0]);

    expect(sparse.filter((level) => level > 0)).toEqual(dense);
    expect(bucketActivityIntensity([1, 100]).at(-1)).toBe(4);
    expect(bucketActivityIntensity([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).at(-1)).toBe(4);
  });

  it("trims only leading inactive days and preserves interior and trailing gaps", () => {
    const points = [
      makeActivityDay("2026-01-01"),
      makeActivityDay("2026-01-02"),
      makeActivityDay("2026-01-03", { totalTokens: 1_000 }),
      makeActivityDay("2026-01-04"),
      makeActivityDay("2026-01-05", { commits: 2 }),
      makeActivityDay("2026-01-06"),
    ];

    expect(trimLeadingInactiveDays(points).map((point) => point.date)).toEqual([
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
    ]);
  });

  it("normalizes each dimension, so a hands-on day is not erased by one huge batch day", () => {
    // Raw-summed (the previous behaviour) the batch day wins by four orders of
    // magnitude and everything else is rounding noise: 10^10 tokens against a
    // few thousand points of session/interaction weight.
    const batch = makeActivityDay("2026-06-01", { totalTokens: 10_000_000_000, sessions: 1 });
    const handsOn = makeActivityDay("2026-06-02", {
      totalTokens: 2_000_000,
      sessions: 20,
      interactions: 300,
      commits: 9,
      insertions: 1_200,
      deletions: 400,
      filesChanged: 40,
    });

    const [batchScore, handsOnScore] = scoreActivityDays([batch, handsOn]);
    expect(handsOnScore).toBeGreaterThan(batchScore!);
    // And the token dimension still counts — it is the largest single weight.
    expect(batchScore).toBeGreaterThan(0);
    expect(bucketActivityIntensity([batchScore!, handsOnScore!])).toEqual([1, 4]);
  });

  it("fills date gaps so a cell's position means its date", () => {
    const filled = fillMissingDays([
      makeActivityDay("2026-01-01", { sessions: 1 }),
      makeActivityDay("2026-01-05", { sessions: 2 }),
    ]);

    expect(filled.map((point) => point.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ]);
    // Filled days are real zero days, not copies of their neighbours.
    expect(filled[2]).toMatchObject({ sessions: 0, totalTokens: 0, commits: 0 });
    expect(weekAlignment(filled.map((point) => ({ point, level: 0 as const }))))
      .toEqual({ leading: 4, trailing: 5 });
  });

  it("picks the most actionable single fact, in priority order", () => {
    const day = (index: number, score: number) =>
      makeActivityDay(`2026-06-${String(index + 1).padStart(2, "0")}`, { totalTokens: score });

    // Record: the latest day beats a long run behind it, but not the all-time
    // high sitting at the start of the series — so it is dated, not absolute.
    const record = Array.from({ length: 30 }, (_, i) =>
      day(i, i === 0 ? 2_000_000 : i === 29 ? 900_000 : 10_000),
    );
    expect(describeActivityInsight(record)).toEqual({ kind: "record", weeks: 4 });

    // Record with nothing above it anywhere in the series.
    expect(describeActivityInsight(Array.from({ length: 20 }, (_, i) => day(i, (i + 1) * 1_000))))
      .toEqual({ kind: "record", weeks: null });

    // Trend: no record, but the week moved enough to be worth saying.
    const trend = Array.from({ length: 20 }, (_, i) => day(i, i < 13 ? 10_000 : 20_000));
    expect(describeActivityInsight(trend)).toMatchObject({ kind: "trend" });

    // Peak: too little history for either claim, so point at the high day.
    expect(describeActivityInsight([day(0, 1_000), day(1, 8_000), day(2, 2_000)]))
      .toEqual({ kind: "peak", date: "2026-06-02" });

    // Nothing at all stays silent rather than inventing a fact.
    expect(describeActivityInsight([])).toBeNull();
    expect(describeActivityInsight([day(0, 0), day(1, 0)])).toBeNull();
  });

  it("keeps empty/already-active series stable and counts GitHub-only activity", () => {
    const empty = [makeActivityDay("2026-01-01"), makeActivityDay("2026-01-02")];
    const active = [makeActivityDay("2026-01-01", { sessions: 1 }), makeActivityDay("2026-01-02")];
    const github = [makeActivityDay("2026-01-01"), makeActivityDay("2026-01-02", { githubCommits: 3 })];

    expect(trimLeadingInactiveDays(empty)).toEqual(empty);
    expect(trimLeadingInactiveDays(active)).toBe(active);
    expect(trimLeadingInactiveDays(github).map((point) => point.date)).toEqual(["2026-01-02"]);
  });
});
