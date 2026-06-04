/* @vitest-environment jsdom */

import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope, AiSettingsStatus } from "../../../shared/types";
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
  const githubGetStatusMock = vi.fn();
  let chatEventListener: ((envelope: AgentChatEventEnvelope) => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
    resetStore();
    invalidateAiDiscoveryCache();
    getStatusMock.mockReset();
    githubGetStatusMock.mockReset();
    githubGetStatusMock.mockResolvedValue(null);
    chatEventListener = null;
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        app: {
          getWindowSession: vi.fn(async () => ({ project, binding: null })),
          onProjectChanged: vi.fn(() => () => {}),
          onProjectBindingChanged: vi.fn(() => () => {}),
        },
        agentChat: {
          onEvent: vi.fn((listener: (envelope: AgentChatEventEnvelope) => void) => {
            chatEventListener = listener;
            return () => {
              if (chatEventListener === listener) chatEventListener = null;
            };
          }),
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
          getStatus: githubGetStatusMock,
          onStatusChanged: vi.fn(() => () => {}),
        },
        keybindings: {
          get: vi.fn(async () => null),
        },
        lanes: {
          list: vi.fn(async () => []),
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

  it("refreshes provider status on auth-related chat failures after a provider was known", async () => {
    getStatusMock
      .mockResolvedValueOnce(makeAiStatus(true))
      .mockResolvedValueOnce(makeAiStatus(false));
    await getAiStatusCached({ projectRoot: project.rootPath });

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <AppShell>
          <div>Work content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {});
    expect(screen.queryByText(/No AI provider is configured yet/i)).toBeNull();

    await act(async () => {
      chatEventListener?.({
        sessionId: "session-1",
        timestamp: "2026-05-28T12:00:00.000Z",
        event: {
          type: "error",
          message: "Invalid API key.",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/No AI provider is configured yet/i)).toBeTruthy();
    expect(getStatusMock).toHaveBeenLastCalledWith({
      force: true,
      refreshOpenCodeInventory: false,
    });
  });

  it("skips shell GitHub auth discovery on remote Work startup", async () => {
    getStatusMock.mockResolvedValue(makeAiStatus(true));
    useAppStore.setState({
      project,
      projectBinding: {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        projectId: "project-1",
        runtimeName: "Mac Studio",
        displayName: "perf pass",
        rootPath: "/Users/admin/Projects/perf pass",
      },
      projectHydrated: true,
      showWelcome: false,
    } as any);

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <AppShell>
          <div>Work content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(githubGetStatusMock).not.toHaveBeenCalled();
  });

  it("loads shell GitHub auth discovery on remote PR routes", async () => {
    getStatusMock.mockResolvedValue(makeAiStatus(true));
    useAppStore.setState({
      project,
      projectBinding: {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        projectId: "project-1",
        runtimeName: "Mac Studio",
        displayName: "perf pass",
        rootPath: "/Users/admin/Projects/perf pass",
      },
      projectHydrated: true,
      showWelcome: false,
    } as any);

    render(
      <MemoryRouter initialEntries={["/prs"]}>
        <AppShell>
          <div>PR content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      vi.advanceTimersByTime(12_000);
      await Promise.resolve();
    });

    expect(githubGetStatusMock).toHaveBeenCalledTimes(1);
  });

  it("ignores stale auth-related chat history while remote AI status is cached", async () => {
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    getStatusMock.mockResolvedValue(makeAiStatus(true));
    const remoteRoot = "/Users/admin/Projects/perf pass";
    const remoteProject = { rootPath: remoteRoot, displayName: "perf pass", baseRef: "main" } as any;
    const remoteBinding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      projectId: "project-1",
      runtimeName: "Mac Studio",
      displayName: "perf pass",
      rootPath: remoteRoot,
    } as any;
    await getAiStatusCached({ projectRoot: remoteRoot });
    getStatusMock.mockClear();
    (window.ade.app.getWindowSession as any).mockResolvedValue({
      project: remoteProject,
      binding: remoteBinding,
    });
    useAppStore.setState({
      project: remoteProject,
      projectBinding: remoteBinding,
      projectHydrated: true,
      showWelcome: false,
    } as any);

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <AppShell>
          <div>Work content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      chatEventListener?.({
        sessionId: "session-1",
        timestamp: "2026-06-04T11:59:00.000Z",
        event: {
          type: "error",
          message: "not authenticated",
        },
      });
      await Promise.resolve();
    });

    expect(getStatusMock).not.toHaveBeenCalled();
  });
});
