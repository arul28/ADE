/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
        getProject: vi.fn(async () => ({ rootPath: "/Users/arul/ADE", name: "ADE" })),
      },
      pty: {
        onData: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
      },
      onboarding: {
        getStatus: vi.fn(async () => ({ completedAt: null, dismissedAt: null, freshProject: false })),
      },
      project: {
        onMissing: vi.fn(() => () => {}),
      },
      context: {
        getStatus: vi.fn(async () => staleContextStatus),
        onStatusChanged: vi.fn((callback: (status: typeof staleContextStatus) => void) => {
          callback(staleContextStatus);
          return () => {};
        }),
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

    expect(await screen.findByText(/ADE context docs need regeneration/i)).toBeTruthy();

    fireEvent.click(screen.getByTitle("Dismiss for this session"));

    expect(screen.queryByText(/ADE context docs need regeneration/i)).toBeNull();
  });
});
