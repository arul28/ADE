/* @vitest-environment jsdom */

import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettingsStatus } from "../../../shared/types";
import { getAiStatusCached, invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { useAppStore } from "../../state/appStore";
import { AppShell } from "./AppShell";

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./TabNav", () => ({
  TabNav: () => <nav data-testid="tab-nav" />,
}));

vi.mock("./TopBar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

vi.mock("../ui/TabBackground", () => ({
  TabBackground: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../lanes/LaneAccentDot", () => ({
  LaneAccentDot: () => <span data-testid="lane-accent-dot" />,
}));

vi.mock("../terminals/TerminalView", () => ({
  disposeTerminalRuntimesForProjectChange: vi.fn(),
}));

vi.mock("../../lib/debugLog", () => ({
  logRendererDebugEvent: vi.fn(),
}));

vi.mock("../../lib/sessionListCache", () => ({
  listSessionsCached: vi.fn(async () => []),
}));

const project = { rootPath: "/tmp/ai-project", displayName: "AI Project", baseRef: "main" } as any;

function makeAiStatus(hasProvider: boolean): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: { present: false, source: "missing", path: null },
        auth: { ready: false, mode: "none", detail: null },
      },
      codex: hasProvider,
      cursor: false,
      droid: false,
    },
    models: { claude: [], codex: [], cursor: [], droid: [] },
    features: [],
  };
}

function resetStore() {
  useAppStore.setState({
    project: null,
    projectBinding: null,
    projectHydrated: false,
    showWelcome: true,
    projectTransition: null,
    lanes: [],
    laneSnapshots: [],
    lanesLoading: false,
    selectedLaneId: null,
    focusedSessionId: null,
    providerMode: "guest",
    keybindings: null,
    dismissedMissingAiBannerRoots: {},
    dismissedGithubBannerRoots: {},
    isNewTabOpen: false,
  } as any);
}

describe("AppShell AI provider status", () => {
  const getStatusMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
    resetStore();
    invalidateAiDiscoveryCache();
    getStatusMock.mockReset();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        app: {
          getWindowSession: vi.fn(async () => ({ project, binding: null })),
          onProjectChanged: vi.fn(() => () => {}),
          onProjectBindingChanged: vi.fn(() => () => {}),
        },
        agentChat: {
          onEvent: vi.fn(() => () => {}),
        },
        ai: {
          getStatus: getStatusMock,
        },
        cto: {
          onLinearWorkflowEvent: vi.fn(() => () => {}),
        },
        feedback: {
          onUpdate: vi.fn(() => () => {}),
        },
        github: {
          getStatus: vi.fn(async () => null),
          onStatusChanged: vi.fn(() => () => {}),
        },
        keybindings: {
          get: vi.fn(async () => null),
        },
        lanes: {
          listSnapshots: vi.fn(async () => []),
        },
        onboarding: {
          getStatus: vi.fn(async () => ({ freshProject: false, completedAt: null, dismissedAt: null })),
        },
        project: {
          onMissing: vi.fn(() => () => {}),
          forgetRecent: vi.fn(async () => []),
        },
        projectConfig: {
          get: vi.fn(async () => ({ effective: { providerMode: "guest" } })),
        },
        prs: {
          onEvent: vi.fn(() => () => {}),
        },
        pty: {
          onData: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
        },
        sync: {
          onEvent: vi.fn(() => () => {}),
        },
        zoom: {
          setLevel: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("refreshes the missing-provider banner when AI status cache is invalidated", async () => {
    getStatusMock
      .mockResolvedValueOnce(makeAiStatus(false))
      .mockResolvedValueOnce(makeAiStatus(true));
    await getAiStatusCached({ projectRoot: project.rootPath });

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <AppShell>
          <div>Work content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {});
    expect(screen.getByText(/No AI provider is configured yet/i)).toBeTruthy();

    await act(async () => {
      invalidateAiDiscoveryCache(project.rootPath);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/No AI provider is configured yet/i)).toBeNull();
    expect(getStatusMock).toHaveBeenLastCalledWith({
      force: true,
      refreshOpenCodeInventory: false,
    });
  });
});
