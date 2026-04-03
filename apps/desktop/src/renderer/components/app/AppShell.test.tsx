/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AppShell } from "./AppShell";
import { useAppStore } from "../../state/appStore";

vi.mock("./TopBar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

vi.mock("./TabNav", () => ({
  TabNav: () => <div data-testid="tab-nav" />,
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./RightEdgeFloatingPane", () => ({
  RightEdgeFloatingPane: () => null,
}));

vi.mock("../ui/TabBackground", () => ({
  TabBackground: () => null,
}));

vi.mock("./prToastPresentation", () => ({
  getPrToastHeadline: () => "headline",
  getPrToastMeta: () => "meta",
  getPrToastSummary: () => "summary",
  getPrToastTone: () => "info",
}));

vi.mock("../../lib/sessionListCache", () => ({
  listSessionsCached: vi.fn(async () => []),
}));

vi.mock("../../lib/sessions", () => ({
  isRunOwnedSession: () => false,
}));

vi.mock("../../lib/terminalAttention", () => ({
  summarizeTerminalAttention: () => ({
    runningCount: 0,
    activeCount: 0,
    needsAttentionCount: 0,
    indicator: "none",
    byLaneId: {},
  }),
}));

vi.mock("../../lib/zoom", () => ({
  getStoredZoomLevel: () => 100,
  displayZoomToLevel: () => 0,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function resetStore() {
  useAppStore.setState({
    project: { rootPath: "/Users/arul/ADE", name: "ADE" } as any,
    projectHydrated: true,
    showWelcome: false,
    providerMode: "subscription",
    keybindings: {
      definitions: [],
      overrides: [],
    },
    lanes: [],
    selectedLaneId: null,
    runLaneId: null,
    focusedSessionId: null,
    laneInspectorTabs: {},
    terminalAttention: {
      runningCount: 0,
      activeCount: 0,
      needsAttentionCount: 0,
      indicator: "none",
      byLaneId: {},
    },
    workViewByProject: {},
    laneWorkViewByScope: {},
    refreshLanes: vi.fn(async () => []),
    refreshProviderMode: vi.fn(async () => undefined),
    refreshKeybindings: vi.fn(async () => undefined),
    setTerminalAttention: vi.fn(),
  } as any);
}

describe("AppShell", () => {
  const originalAde = globalThis.window.ade;
  const staleContextStatus = {
    docs: [
      {
        id: "prd_ade",
        label: "PRD (ADE minimized)",
        preferredPath: ".ade/context/PRD.ade.md",
        exists: true,
        sizeBytes: 100,
        updatedAt: "2026-03-31T07:38:11.615Z",
        fingerprint: "prd",
        staleReason: "older_than_canonical_docs",
        fallbackCount: 0,
        health: "stale",
        source: "ai",
      },
    ],
    generation: {
      state: "idle",
      requestedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      source: null,
      event: null,
      reason: null,
      provider: null,
      modelId: null,
      reasoningEffort: null,
    },
  } as const;

  beforeEach(() => {
    resetStore();
    globalThis.window.ade = {
      app: {
        getProject: vi.fn(async () => ({
          rootPath: "/Users/arul/ADE",
          name: "ADE",
        })),
        onProjectChanged: vi.fn(() => () => {}),
      },
      pty: {
        onData: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
      },
      onboarding: {
        getStatus: vi.fn(async () => ({
          completedAt: null,
          dismissedAt: null,
          freshProject: false,
        })),
      },
      project: {
        onMissing: vi.fn(() => () => {}),
      },
      context: {
        getStatus: vi.fn(async () => staleContextStatus),
        onStatusChanged: vi.fn(
          (callback: (status: typeof staleContextStatus) => void) => {
            callback(staleContextStatus);
            return () => {};
          },
        ),
      },
      ai: {
        getStatus: vi.fn(async () => ({
          detectedAuth: ["token"],
          providerConnections: {
            claude: { authAvailable: true },
            codex: { authAvailable: true },
            cursor: { authAvailable: false },
          },
        })),
      },
      github: {
        getStatus: vi.fn(async () => ({ tokenStored: true })),
      },
      zoom: {
        setLevel: vi.fn(),
      },
      cto: {
        onLinearWorkflowEvent: vi.fn(() => () => {}),
      },
      prs: {
        onEvent: vi.fn(() => () => {}),
        openInGitHub: vi.fn(async () => undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("dismisses the stale context banner for the current app session", async () => {
    render(
      <MemoryRouter initialEntries={["/project"]}>
        <AppShell>
          <div>child</div>
        </AppShell>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(/ADE context docs need regeneration/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByTitle("Dismiss for this session"));

    expect(
      screen.queryByText(/ADE context docs need regeneration/i),
    ).toBeNull();
  });

  it("moves project selection flows from run to work", async () => {
    useAppStore.setState({
      project: null,
      showWelcome: true,
    } as any);
    globalThis.window.ade.app.getProject = vi.fn(async () => null);

    render(
      <MemoryRouter initialEntries={["/project"]}>
        <AppShell>
          <LocationProbe />
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("location-probe").textContent).toBe("/project");

    await act(async () => {
      useAppStore.getState().setProject({
        rootPath: "/Users/arul/ADE-next",
        name: "ADE next",
      } as any);
      useAppStore.getState().setShowWelcome(false);
    });

    expect(await screen.findByText("/work")).toBeTruthy();
  });

  it("ignores same-project change events without triggering extra lane refreshes", async () => {
    const getProjectMock = vi.fn(async () => ({
      rootPath: "/Users/arul/ADE",
      name: "ADE",
    }));
    let projectChangedHandler:
      | ((project: { rootPath: string; name: string } | null) => void)
      | null = null;
    const refreshLanesMock = vi.fn(async () => []);
    const refreshKeybindingsMock = vi.fn(async () => undefined);

    useAppStore.setState({
      refreshLanes: refreshLanesMock,
      refreshKeybindings: refreshKeybindingsMock,
    } as any);

    globalThis.window.ade.app.getProject = getProjectMock as any;
    globalThis.window.ade.app.onProjectChanged = vi.fn((cb) => {
      projectChangedHandler = cb;
      return () => {
        projectChangedHandler = null;
      };
    }) as any;

    render(
      <MemoryRouter initialEntries={["/lanes"]}>
        <AppShell>
          <div>child</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(refreshLanesMock).toHaveBeenCalledTimes(0);
    expect(projectChangedHandler).toBeTruthy();

    await act(async () => {
      projectChangedHandler?.({ rootPath: "/Users/arul/ADE", name: "ADE" });
      await Promise.resolve();
    });

    expect(refreshLanesMock).toHaveBeenCalledTimes(0);
  });

  it("waits for AI status before showing the missing provider banner", async () => {
    vi.useFakeTimers();
    try {
      globalThis.window.ade.ai.getStatus = vi.fn(async () => ({
        detectedAuth: [],
        providerConnections: {
          claude: { authAvailable: false },
          codex: { authAvailable: false },
          cursor: { authAvailable: false },
          droid: { authAvailable: false },
        },
        availableProviders: {
          claude: false,
          codex: false,
          cursor: false,
          droid: false,
        },
      })) as any;

      render(
        <MemoryRouter initialEntries={["/work"]}>
          <AppShell>
            <div>child</div>
          </AppShell>
        </MemoryRouter>,
      );

      expect(
        screen.queryByText(/No AI provider is configured yet/i),
      ).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      });

      expect(
        screen.getByText(/No AI provider is configured yet/i),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
