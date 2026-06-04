/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  AiSettingsStatus,
  BudgetCapConfig,
  UsageSnapshot,
} from "../../../shared/types";
import { HeaderUsageControl } from "./HeaderUsageControl";
import { UsageQuotaPanel } from "./UsageQuotaPanel";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

type UsageComponentTestBridge = {
  usage: Pick<
    Window["ade"]["usage"],
    "getSnapshot" | "refresh" | "getBudgetConfig" | "saveBudgetConfig" | "onUpdate"
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
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-05-08T07:00:00.000Z",
    errors: [],
  };
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

    it("dims the provider card when the CLI is installed but not signed in", async () => {
      vi.mocked(window.ade.ai.getStatus).mockResolvedValue(
        makeAiStatus({
          claude: makeProviderConnection("claude", { runtimeDetected: true, authAvailable: false }),
        }),
      );

      render(<UsageQuotaPanel />);

      expect(await screen.findByText("Not signed in")).toBeTruthy();
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
});
