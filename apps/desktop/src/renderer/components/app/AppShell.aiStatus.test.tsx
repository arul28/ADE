/* @vitest-environment jsdom */

import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope, AiSettingsStatus } from "../../../shared/types";
import { getAiStatusCached, invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import {
  invalidateSessionListCache,
  listSessionsCached,
} from "../../lib/sessionListCache";
import { useAppStore } from "../../state/appStore";
import { AppShell } from "./AppShell";

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./TabNav", () => ({
  TabNav: ({ githubStatus }: { githubStatus: unknown }) => (
    <nav data-testid="tab-nav">
      <span data-testid="github-status">{githubStatus ? JSON.stringify(githubStatus) : "none"}</span>
    </nav>
  ),
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
  invalidateSessionListCache: vi.fn(),
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
    projectTransitionError: null,
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
    terminalAttention: {
      runningCount: 0,
      activeCount: 0,
      needsAttentionCount: 0,
      indicator: "none",
      byLaneId: {},
    },
  } as any);
}

describe("AppShell AI provider status", () => {
  const getStatusMock = vi.fn();
  const githubGetStatusMock = vi.fn();
  const analyticsCaptureMock = vi.fn();
  const chatEventListeners = new Set<(envelope: AgentChatEventEnvelope) => void>();
  const syncEventListeners = new Set<(event: any) => void>();
  const syncGetStatusMock = vi.fn();
  let sessionChangedListener: (() => void) | null = null;
  const emitChatEvent = (envelope: AgentChatEventEnvelope) => {
    for (const listener of chatEventListeners) listener(envelope);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
    resetStore();
    invalidateAiDiscoveryCache();
    getStatusMock.mockReset();
    githubGetStatusMock.mockReset();
    syncGetStatusMock.mockReset();
    analyticsCaptureMock.mockReset();
    analyticsCaptureMock.mockResolvedValue({ accepted: true, reason: "accepted" });
    vi.mocked(listSessionsCached).mockClear();
    vi.mocked(listSessionsCached).mockResolvedValue([]);
    vi.mocked(invalidateSessionListCache).mockClear();
    githubGetStatusMock.mockResolvedValue(null);
    syncGetStatusMock.mockResolvedValue({ client: { state: "disconnected" } });
    chatEventListeners.clear();
    syncEventListeners.clear();
    sessionChangedListener = null;
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        analytics: {
          capture: analyticsCaptureMock,
          getStatus: vi.fn(),
          setEnabled: vi.fn(),
        },
        app: {
          getWindowSession: vi.fn(async () => ({ project, binding: null })),
          onProjectChanged: vi.fn(() => () => {}),
          onProjectBindingChanged: vi.fn(() => () => {}),
          setDockBadgeCount: vi.fn(async () => undefined),
        },
        agentChat: {
          onEvent: vi.fn((listener: (envelope: AgentChatEventEnvelope) => void) => {
            chatEventListeners.add(listener);
            return () => {
              chatEventListeners.delete(listener);
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
          onLifecycleEvent: vi.fn(() => () => {}),
          rebaseSubscribe: vi.fn(() => () => {}),
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
        sessions: {
          onChanged: vi.fn((listener: () => void) => {
            sessionChangedListener = listener;
            return () => {
              if (sessionChangedListener === listener) sessionChangedListener = null;
            };
          }),
        },
        sync: {
          getStatus: syncGetStatusMock,
          onEvent: vi.fn((listener: (event: any) => void) => {
            syncEventListeners.add(listener);
            return () => {
              syncEventListeners.delete(listener);
            };
          }),
        },
        zoom: {
          setLevel: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    delete window.__adeWebClient;
    vi.useRealTimers();
  });

  it("captures a normalized route without query strings or route identifiers", async () => {
    window.__adeWebClient = true;
    render(
      <MemoryRouter initialEntries={["/work/session-sensitive?token=secret#private"]}>
        <AppShell>
          <div>Work content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {});

    expect(analyticsCaptureMock).toHaveBeenCalledTimes(3);
    expect(analyticsCaptureMock).toHaveBeenCalledWith({
      event: "ade_screen_viewed",
      properties: {
        screen: "work",
        route_kind: "web",
        source: "renderer_route",
      },
      dedupeKey: "web_screen:work",
      minimumIntervalMs: 2_000,
    });
    expect(analyticsCaptureMock).toHaveBeenCalledWith({
      event: "ade_app_opened",
      properties: {
        entry_point: "hosted_web_client",
        source: "renderer_startup",
      },
      dedupeKey: "web_app_opened",
      minimumIntervalMs: 5 * 60_000,
    });
    expect(analyticsCaptureMock).toHaveBeenCalledWith({
      event: "ade_project_opened",
      properties: {
        route_kind: "web",
        source: "renderer_project",
      },
      minimumIntervalMs: 60 * 60_000,
    });
    expect(JSON.stringify(analyticsCaptureMock.mock.calls)).not.toContain(project.rootPath);
    expect(JSON.stringify(analyticsCaptureMock.mock.calls)).not.toContain("secret");
    for (const [input] of analyticsCaptureMock.mock.calls) {
      expect(input).not.toHaveProperty("surface");
      expect(input.properties).not.toHaveProperty("project_id");
      expect(input.properties).not.toHaveProperty("projectId");
    }
  });

  it("shows the full project error below the top bar and lets the user dismiss it", () => {
    const message = "ADE needs Git to open and manage this project. macOS blocked Apple's Git because the Xcode license has not been accepted.";
    useAppStore.setState({ projectTransitionError: { message } } as any);

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <AppShell>
          <div>Work content</div>
        </AppShell>
      </MemoryRouter>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(alert.querySelector(".truncate")).toBeNull();

    act(() => {
      screen.getByRole("button", { name: "Dismiss project error" }).click();
    });
    expect(useAppStore.getState().projectTransitionError).toBeNull();
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
    expect(screen.getByText(/No AI provider configured/i)).toBeTruthy();

    await act(async () => {
      invalidateAiDiscoveryCache(project.rootPath);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/No AI provider configured/i)).toBeNull();
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
    expect(screen.queryByText(/No AI provider configured/i)).toBeNull();

    await act(async () => {
      emitChatEvent({
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

    expect(screen.getByText(/No AI provider configured/i)).toBeTruthy();
    expect(getStatusMock).toHaveBeenLastCalledWith({
      force: true,
      refreshOpenCodeInventory: false,
    });
  });

  it("refreshes app-wide attention immediately for native structured questions", async () => {
    vi.mocked(listSessionsCached).mockResolvedValue([{
      id: "session-needs-you",
      laneId: "lane-1",
      toolType: "codex-chat",
      status: "running",
      runtimeState: "waiting-input",
      pendingInputItemId: "question-1",
      title: "Plan rollout",
      goal: null,
      startedAt: "2026-07-20T12:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-07-20T12:01:00.000Z",
      lastOutputPreview: null,
    } as any]);

    render(
      <MemoryRouter initialEntries={["/files"]}>
        <AppShell>
          <div>Files content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.mocked(listSessionsCached).mockClear();

    await act(async () => {
      emitChatEvent({
        sessionId: "session-needs-you",
        timestamp: "2026-07-20T12:01:00.000Z",
        event: {
          type: "approval_request",
          itemId: "question-1",
          kind: "tool_call",
          description: "Choose a rollout strategy",
          detail: { request: { kind: "structured_question" } },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(invalidateSessionListCache).toHaveBeenCalledWith({
      projectRoot: project.rootPath,
    });
    expect(listSessionsCached).toHaveBeenCalledWith(
      { limit: 150 },
      { force: true },
    );
    expect(useAppStore.getState().terminalAttention.needsAttentionCount).toBe(1);
    expect(window.ade.app.setDockBadgeCount).toHaveBeenCalledWith(1);
  });

  it("refreshes attention immediately when an explicit ask changes session metadata", async () => {
    vi.mocked(listSessionsCached).mockResolvedValue([{
      id: "session-asked",
      laneId: "lane-1",
      toolType: "claude",
      status: "running",
      runtimeState: "idle",
      attentionRequestedAt: "2026-07-20T12:02:00.000Z",
      attentionMessage: "Which account should I use?",
      title: "Auth migration",
      goal: null,
      startedAt: "2026-07-20T12:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-07-20T12:02:00.000Z",
      lastOutputPreview: null,
    } as any]);

    render(
      <MemoryRouter initialEntries={["/prs"]}>
        <AppShell>
          <div>PR content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.mocked(listSessionsCached).mockClear();

    await act(async () => {
      sessionChangedListener?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(listSessionsCached).toHaveBeenCalledWith(
      { limit: 150 },
      { force: true },
    );
    expect(useAppStore.getState().terminalAttention.needsAttentionCount).toBe(1);
    expect(window.ade.app.setDockBadgeCount).toHaveBeenCalledWith(1);
  });

  it("ignores an in-flight attention refresh after switching projects", async () => {
    let resolveOldProject: ((sessions: any[]) => void) | null = null;
    const oldProjectResult = new Promise<any[]>((resolve) => {
      resolveOldProject = resolve;
    });
    vi.mocked(listSessionsCached)
      .mockImplementationOnce(() => oldProjectResult)
      .mockResolvedValueOnce([{
        id: "new-project-needs-you",
        laneId: "lane-new",
        toolType: "codex-chat",
        status: "running",
        runtimeState: "idle",
        attentionRequestedAt: "2026-07-20T12:02:00.000Z",
        title: "New project work",
        goal: null,
        startedAt: "2026-07-20T12:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-07-20T12:02:00.000Z",
        lastOutputPreview: null,
      } as any]);
    useAppStore.setState({
      project,
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
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(listSessionsCached).toHaveBeenCalledTimes(1);

    act(() => {
      useAppStore.setState({
        project: {
          ...project,
          rootPath: "/tmp/other-project",
          displayName: "Other project",
        },
      } as any);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
      await Promise.resolve();
    });

    expect(listSessionsCached).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().terminalAttention.needsAttentionCount).toBe(1);
    expect(window.ade.app.setDockBadgeCount).toHaveBeenLastCalledWith(1);

    await act(async () => {
      resolveOldProject?.([{
        id: "old-project-needs-you-1",
        laneId: "lane-old",
        toolType: "claude-chat",
        status: "running",
        runtimeState: "idle",
        attentionRequestedAt: "2026-07-20T12:03:00.000Z",
        title: "Old project work 1",
        goal: null,
        startedAt: "2026-07-20T12:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-07-20T12:03:00.000Z",
        lastOutputPreview: null,
      }, {
        id: "old-project-needs-you-2",
        laneId: "lane-old",
        toolType: "claude-chat",
        status: "running",
        runtimeState: "idle",
        attentionRequestedAt: "2026-07-20T12:03:00.000Z",
        title: "Old project work 2",
        goal: null,
        startedAt: "2026-07-20T12:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-07-20T12:03:00.000Z",
        lastOutputPreview: null,
      } as any]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useAppStore.getState().terminalAttention.needsAttentionCount).toBe(1);
    expect(window.ade.app.setDockBadgeCount).not.toHaveBeenCalledWith(2);
  });

  it("clears app-wide attention and the dock badge when the project closes", async () => {
    vi.mocked(listSessionsCached).mockResolvedValue([{
      id: "session-needs-you",
      laneId: "lane-1",
      toolType: "codex-chat",
      status: "running",
      runtimeState: "idle",
      attentionRequestedAt: "2026-07-20T12:02:00.000Z",
      title: "Current project work",
      goal: null,
      startedAt: "2026-07-20T12:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-07-20T12:02:00.000Z",
      lastOutputPreview: null,
    } as any]);
    useAppStore.setState({
      project,
      projectHydrated: true,
      showWelcome: false,
    } as any);

    render(
      <MemoryRouter initialEntries={["/files"]}>
        <AppShell>
          <div>Files content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(useAppStore.getState().terminalAttention.needsAttentionCount).toBe(1);
    expect(window.ade.app.setDockBadgeCount).toHaveBeenLastCalledWith(1);

    act(() => {
      useAppStore.setState({
        project: null,
        projectHydrated: true,
        showWelcome: true,
      } as any);
    });

    expect(useAppStore.getState().terminalAttention.needsAttentionCount).toBe(0);
    expect(window.ade.app.setDockBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it("warms AI status on the main menu before a project is open", async () => {
    getStatusMock.mockResolvedValue(makeAiStatus(true));
    (window.ade.app.getWindowSession as any).mockResolvedValue({
      project: null,
      binding: null,
    });

    render(
      <MemoryRouter initialEntries={["/project"]}>
        <AppShell>
          <div>Main menu</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getStatusMock).toHaveBeenCalledWith({
      force: false,
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

  it("forces one fast GitHub refresh after reconnect without changing later route delays", async () => {
    getStatusMock.mockResolvedValue(makeAiStatus(true));
    const remoteBinding = {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      projectId: "project-1",
      runtimeName: "Mac Studio",
      displayName: "perf pass",
      rootPath: "/Users/admin/Projects/perf pass",
    } as any;
    (window.ade.app.getWindowSession as any).mockResolvedValue({
      project: {
        rootPath: remoteBinding.rootPath,
        displayName: remoteBinding.displayName,
        baseRef: "main",
      },
      binding: remoteBinding,
    });
    useAppStore.setState({
      project,
      projectBinding: remoteBinding,
      projectHydrated: true,
      showWelcome: false,
    } as any);
    const NavigateWithinPrs = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/prs/queue")}>Open queue</button>;
    };

    render(
      <MemoryRouter initialEntries={["/prs"]}>
        <AppShell>
          <NavigateWithinPrs />
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
      for (const listener of syncEventListeners) {
        listener({
          type: "sync-status",
          snapshot: { client: { state: "connected" } },
        });
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });

    expect(githubGetStatusMock).toHaveBeenCalledTimes(1);
    expect(githubGetStatusMock).toHaveBeenLastCalledWith({ forceRefresh: true });

    fireEvent.click(screen.getByRole("button", { name: "Open queue" }));
    await act(async () => {
      vi.advanceTimersByTime(11_999);
      await Promise.resolve();
    });
    expect(githubGetStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(githubGetStatusMock).toHaveBeenCalledTimes(2);
    expect(githubGetStatusMock).toHaveBeenLastCalledWith({ forceRefresh: false });
  });

  it("does not let a failed reconnect refresh clear a newer route status", async () => {
    getStatusMock.mockResolvedValue(makeAiStatus(true));
    useAppStore.setState({
      project,
      projectBinding: null,
      projectHydrated: true,
      showWelcome: false,
    } as any);
    let rejectReconnect: ((error: Error) => void) | null = null;
    githubGetStatusMock
      .mockImplementationOnce(() => new Promise((_, reject) => {
        rejectReconnect = reject;
      }))
      .mockResolvedValue({ authenticated: true, source: "new-route" } as any);
    const NavigateWithinPrs = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/prs/queue")}>Open queue</button>;
    };
    render(
      <MemoryRouter initialEntries={["/prs"]}>
        <AppShell>
          <NavigateWithinPrs />
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
      for (const listener of syncEventListeners) {
        listener({
          type: "sync-status",
          snapshot: { client: { state: "connected" } },
        });
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Open queue" }));
    await act(async () => {
      vi.advanceTimersByTime(12_000);
      await Promise.resolve();
    });
    expect(screen.getByTestId("github-status").textContent).toContain("new-route");

    await act(async () => {
      rejectReconnect?.(new Error("stale reconnect failure"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("github-status").textContent).toContain("new-route");
  });

  it("skips remote shell AI and stale-session polling on Files routes", async () => {
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
    const refreshProviderMode = vi.fn(async () => undefined);
    (window.ade.app.getWindowSession as any).mockResolvedValue({
      project: remoteProject,
      binding: remoteBinding,
    });
    useAppStore.setState({
      project: remoteProject,
      projectBinding: remoteBinding,
      projectHydrated: true,
      showWelcome: false,
      refreshProviderMode,
    } as any);

    render(
      <MemoryRouter initialEntries={["/files"]}>
        <AppShell>
          <div>Files content</div>
        </AppShell>
      </MemoryRouter>,
    );

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getStatusMock).not.toHaveBeenCalled();
    expect(listSessionsCached).toHaveBeenCalledWith(
      { limit: 150 },
      { force: true },
    );
    expect(vi.mocked(listSessionsCached).mock.calls.some(
      ([args]) => (args as { status?: string } | undefined)?.status === "running",
    )).toBe(false);
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
      emitChatEvent({
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
