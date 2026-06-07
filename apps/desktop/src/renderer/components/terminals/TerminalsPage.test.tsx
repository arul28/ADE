/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSession, LaneSummary, TerminalSessionSummary, TerminalToolType } from "../../../shared/types";
import type { AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { TerminalsPage } from "./TerminalsPage";

const workMocks = vi.hoisted(() => {
  const makeChatSession = (id: string, laneId: string): AgentChatSession => ({
    id,
    laneId,
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4",
    status: "idle",
    sessionProfile: "workflow",
    reasoningEffort: "xhigh",
    executionMode: "focused",
    createdAt: "2026-05-14T18:00:00.000Z",
    lastActivityAt: "2026-05-14T18:00:00.000Z",
  });
  const makeTerminalSession = (
    id: string,
    laneId: string,
    toolType: TerminalToolType,
    overrides: Partial<TerminalSessionSummary> = {},
  ): TerminalSessionSummary => ({
    id,
    laneId,
    laneName: laneId === "lane-primary" ? "Primary" : "Background lane",
    ptyId: toolType === "codex-chat" ? null : `pty-${id}`,
    tracked: true,
    pinned: false,
    goal: null,
    toolType,
    title: id,
    status: "running",
    startedAt: "2026-05-14T18:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "/tmp/transcript",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  });
  const laneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false };
  const makeLane = (id: string, name: string, laneType: LaneSummary["laneType"] = "worktree"): LaneSummary => ({
    id,
    name,
    description: null,
    laneType,
    baseRef: "main",
    branchRef: id === "lane-primary" ? "main" : `ade/${id}`,
    worktreePath: `/tmp/${id}`,
    attachedRootPath: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    parentLaneId: null,
    color: null,
    icon: null,
    tags: [],
    folder: null,
    status: laneStatus,
    createdAt: "2026-05-14T18:00:00.000Z",
    archivedAt: null,
    activeBranchProfile: null,
    linearIssue: null,
  });

  const fns = {
    selectLane: vi.fn(),
    focusSession: vi.fn(),
    openSessionTab: vi.fn(),
    upsertOptimisticChatSession: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
  };

  const baseWork = {
    lanes: [
      makeLane("lane-primary", "Primary", "primary"),
      makeLane("lane-background", "Background lane"),
    ],
    sessions: [],
    visibleSessions: [],
    tabGroups: [],
    runningFiltered: [],
    awaitingInputFiltered: [],
    endedFiltered: [],
    runningSessions: [],
    filtered: [],
    sessionsGroupedByLane: [],
    loading: false,
    gridLayoutId: "work-grid",
    gridSets: [],
    setGridSets: vi.fn(),
    activeItemId: null,
    selectedSessionId: null,
    draftKind: "chat",
    draftLaneId: null,
    filterLaneId: "all",
    filterStatus: "all",
    q: "",
    sessionListOrganization: "by-lane",
    workCollapsedLaneIds: [],
    workCollapsedSectionIds: [],
    workFocusSessionsHidden: false,
    workSidebarOpen: false,
    workSidebarTab: "git",
    workSidebarWidthPct: 36,
    pinnedSessionIds: [],
    closingPtyIds: new Set<string>(),
    setSelectedSessionId: vi.fn(),
    setActiveItemId: vi.fn(),
    closeTab: vi.fn(),
    launchPtySession: vi.fn(),
    setDraftLaneId: vi.fn(),
    showDraftKind: vi.fn(),
    toggleWorkTabGroupCollapsed: vi.fn(),
    setFilterLaneId: vi.fn(),
    setFilterStatus: vi.fn(),
    setQ: vi.fn(),
    setSessionListOrganization: vi.fn(),
    toggleWorkLaneCollapsed: vi.fn(),
    toggleWorkSectionCollapsed: vi.fn(),
    stopRuntime: vi.fn().mockResolvedValue(undefined),
    removeSessionFromList: vi.fn(),
    setWorkFocusSessionsHidden: vi.fn(),
    setWorkSidebarOpen: vi.fn(),
    setWorkSidebarTab: vi.fn(),
    setWorkSidebarWidthPct: vi.fn(),
    reorderLaneSessions: vi.fn(),
    togglePinnedSession: vi.fn(),
    ...fns,
  };

  return {
    backgroundSession: makeChatSession("chat-background", "lane-background"),
    foregroundSession: makeChatSession("chat-foreground", "lane-primary"),
    baseWork,
    currentWork: baseWork as any,
    projectRoot: null as string | null,
    projectBinding: null as null | {
      kind: "remote";
      rootPath: string;
    },
    fns,
    makeTerminalSession,
  };
});

const sidebarProps = vi.hoisted(() => ({
  latest: null as null | {
    laneId: string | null;
    contextTarget: unknown;
    contextDisabledReason: string | null;
  },
}));

type MockSessionListPaneProps = {
  runningFiltered: TerminalSessionSummary[];
  awaitingInputFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
  onSelectSession: (id: string, event: React.MouseEvent, visibleSessionIds: string[]) => void;
  onBulkDelete?: () => void;
  onBulkStopAndDelete?: () => void;
  onContextMenu: (session: TerminalSessionSummary, event: React.MouseEvent) => void;
};

const sessionListPaneProps = vi.hoisted(() => ({
  latest: null as null | MockSessionListPaneProps,
}));

vi.mock("../../state/appStore", () => ({
  selectActiveProjectRoot: (state: {
    projectBinding?: { kind?: string; rootPath?: string | null } | null;
    project?: { rootPath?: string | null } | null;
  }) => {
    if (state.projectBinding?.kind === "remote") return state.projectBinding.rootPath?.trim() || null;
    return state.project?.rootPath?.trim() || null;
  },
  useAppStore: <T,>(selector: (state: {
    selectedLaneId: string;
    project: { rootPath: string } | null;
    projectBinding: typeof workMocks.projectBinding;
  }) => T): T =>
    selector({
      selectedLaneId: "lane-primary",
      projectBinding: workMocks.projectBinding,
      project: workMocks.projectRoot
        ? { rootPath: workMocks.projectRoot }
        : null,
    }),
}));

vi.mock("./useWorkSessions", () => ({
  useWorkSessions: () => workMocks.currentWork,
}));

vi.mock("../ui/PaneTilingLayout", () => ({
  PaneTilingLayout: ({ panes }: { panes: Record<string, { children: React.ReactNode }> }) => (
    <div data-testid="pane-tiling-layout">
      {Object.entries(panes).map(([id, pane]) => (
        <section key={id} data-testid={`pane:${id}`}>{pane.children}</section>
      ))}
    </div>
  ),
}));

vi.mock("./SessionListPane", () => ({
  SessionListPane: (props: MockSessionListPaneProps) => {
    sessionListPaneProps.latest = props;
    const visibleSessions = [
      ...props.runningFiltered,
      ...props.awaitingInputFiltered,
      ...props.endedFiltered,
    ];
    const visibleSessionIds = visibleSessions.map((session) => session.id);
    return (
      <div data-testid="session-list-pane">
        {visibleSessions.map((session) => (
          <React.Fragment key={session.id}>
            <button
              type="button"
              onClick={(event) => props.onSelectSession(session.id, event, visibleSessionIds)}
            >
              select {session.id}
            </button>
            <button
              type="button"
              onClick={(event) => props.onContextMenu(session, event)}
            >
              context menu {session.id}
            </button>
          </React.Fragment>
        ))}
        <button type="button" onClick={() => props.onBulkDelete?.()}>
          bulk delete
        </button>
        <button type="button" onClick={() => props.onBulkStopAndDelete?.()}>
          bulk stop and delete
        </button>
      </div>
    );
  },
}));

vi.mock("./WorkSidebar", () => ({
  WorkSidebar: (props: {
    laneId: string | null;
    contextTarget: unknown;
    contextDisabledReason: string | null;
  }) => {
    sidebarProps.latest = props;
    return <div data-testid="work-sidebar" />;
  },
}));

vi.mock("./SessionContextMenu", () => ({
  SessionContextMenu: (props: {
    menu: { session: TerminalSessionSummary } | null;
    onStopAndDelete: (session: TerminalSessionSummary) => void;
  }) => {
    if (!props.menu) return null;
    const session = props.menu.session;
    return (
      <button type="button" onClick={() => props.onStopAndDelete(session)}>
        context stop and delete {session.id}
      </button>
    );
  },
}));

vi.mock("./SessionInfoPopover", () => ({
  SessionInfoPopover: () => null,
}));

vi.mock("./WorkViewArea", () => ({
  WorkViewArea: (props: {
    onOpenChatSession: (
      session: AgentChatSession,
      options?: AgentChatSessionCreatedOptions,
    ) => void | Promise<void>;
  }) => (
    <div data-testid="work-view-area">
      <button
        type="button"
        onClick={() => props.onOpenChatSession(workMocks.backgroundSession, { activate: false, source: "draft-launch" })}
      >
        create background chat
      </button>
      <button
        type="button"
        onClick={() => props.onOpenChatSession(workMocks.foregroundSession, { activate: true, source: "draft-launch" })}
      >
        create foreground chat
      </button>
    </div>
  ),
}));

describe("TerminalsPage chat session activation", () => {
  afterEach(() => {
    cleanup();
    workMocks.currentWork = { ...workMocks.baseWork, closingPtyIds: new Set<string>() };
    workMocks.projectRoot = null;
    workMocks.projectBinding = null;
    sidebarProps.latest = null;
    sessionListPaneProps.latest = null;
    vi.clearAllMocks();
  });

  it("tracks background-created chats without stealing Work focus", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { builtInBrowser: { onEvent: vi.fn(() => vi.fn()) } },
    });

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "create background chat" }));

    await waitFor(() => {
      expect(workMocks.fns.upsertOptimisticChatSession).toHaveBeenCalledWith(workMocks.backgroundSession);
      expect(workMocks.fns.refresh).toHaveBeenCalledWith({ showLoading: false, force: true });
    });
    expect(workMocks.fns.selectLane).not.toHaveBeenCalled();
    expect(workMocks.fns.focusSession).not.toHaveBeenCalled();
    expect(workMocks.fns.openSessionTab).not.toHaveBeenCalled();
  });

  it("opens foreground-created chats in the active Work tab", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { builtInBrowser: { onEvent: vi.fn(() => vi.fn()) } },
    });

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "create foreground chat" }));

    await waitFor(() => {
      expect(workMocks.fns.upsertOptimisticChatSession).toHaveBeenCalledWith(workMocks.foregroundSession);
      expect(workMocks.fns.selectLane).toHaveBeenCalledWith("lane-primary");
      expect(workMocks.fns.focusSession).toHaveBeenCalledWith("chat-foreground");
      expect(workMocks.fns.openSessionTab).toHaveBeenCalledWith("chat-foreground");
    });
  });

  it("opens the Browser sidebar only for matching project open requests", async () => {
    workMocks.projectRoot = "/repo-one";
    const browserEventListener: {
      current: ((event: { type?: string; status?: unknown }) => void) | null;
    } = { current: null };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        builtInBrowser: {
          onEvent: vi.fn((listener) => {
            browserEventListener.current = listener;
            return vi.fn();
          }),
        },
      },
    });

    render(<TerminalsPage />);

    await waitFor(() => expect(browserEventListener.current).not.toBeNull());
    browserEventListener.current?.({ type: "open-request" });
    browserEventListener.current?.({
      type: "open-request",
      status: { profileProjectRoot: "/repo-two" },
    });
    expect(workMocks.currentWork.setWorkSidebarTab).not.toHaveBeenCalled();

    browserEventListener.current?.({
      type: "open-request",
      status: { profileProjectRoot: "/repo-one" },
    });
    expect(workMocks.currentWork.setWorkSidebarTab).toHaveBeenCalledWith("browser");
  });

  it("ignores Browser sidebar open requests for remote projects", async () => {
    workMocks.projectRoot = "/repo-one";
    workMocks.projectBinding = {
      kind: "remote",
      rootPath: "/repo-one",
    };
    const browserEventListener: {
      current: ((event: { type?: string; status?: unknown }) => void) | null;
    } = { current: null };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        builtInBrowser: {
          onEvent: vi.fn((listener) => {
            browserEventListener.current = listener;
            return vi.fn();
          }),
        },
      },
    });

    render(<TerminalsPage />);

    await waitFor(() => expect(browserEventListener.current).not.toBeNull());
    browserEventListener.current?.({
      type: "open-request",
      status: { profileProjectRoot: "/repo-one" },
    });
    // (work-tab viewMode/grid was removed by this lane's overhaul; the remote
    // guard now just suppresses the browser-sidebar open.)
    expect(workMocks.currentWork.setWorkSidebarTab).not.toHaveBeenCalled();
  });

  it("targets the visible Work draft when no saved session is active", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { builtInBrowser: { onEvent: vi.fn(() => vi.fn()) } },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      workSidebarOpen: true,
      workSidebarTab: "browser",
      draftLaneId: "lane-background",
      draftKind: "chat",
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    expect(await screen.findByTestId("work-sidebar")).toBeTruthy();
    expect(sidebarProps.latest).toEqual(expect.objectContaining({
      laneId: "lane-background",
      contextDisabledReason: null,
      contextTarget: {
        kind: "draft",
        draftTargetId: "work:draft:lane-background:chat",
        laneId: "lane-background",
        draftKind: "chat",
      },
    }));
  });

  it("targets active chat sessions and running agent CLI sessions", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { builtInBrowser: { onEvent: vi.fn(() => vi.fn()) } },
    });
    const chatSession = workMocks.makeTerminalSession("chat-1", "lane-primary", "codex-chat");
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [chatSession],
      visibleSessions: [chatSession],
      activeItemId: "chat-1",
      workSidebarOpen: true,
      closingPtyIds: new Set<string>(),
    };

    const { rerender } = render(<TerminalsPage />);

    expect(await screen.findByTestId("work-sidebar")).toBeTruthy();
    expect(sidebarProps.latest?.contextTarget).toEqual({ kind: "chat", sessionId: "chat-1" });

    const cliSession = workMocks.makeTerminalSession("term-codex", "lane-primary", "codex");
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [cliSession],
      visibleSessions: [cliSession],
      activeItemId: "term-codex",
      workSidebarOpen: true,
      closingPtyIds: new Set<string>(),
    };

    rerender(<TerminalsPage />);

    expect(sidebarProps.latest?.contextTarget).toEqual({
      kind: "pty",
      sessionId: "term-codex",
      ptyId: "pty-term-codex",
      toolType: "codex",
    });
    expect(sidebarProps.latest?.contextDisabledReason).toBeNull();
  });

  it("bulk deletes selected running chat sessions from the session list", async () => {
    const runningCodexChat = workMocks.makeTerminalSession("chat-running-codex", "lane-primary", "codex-chat");
    const runningClaudeChat = workMocks.makeTerminalSession("chat-running-claude", "lane-primary", "claude-chat", {
      ptyId: null,
    });
    const runningShell = workMocks.makeTerminalSession("shell-running", "lane-primary", "shell");
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCodexChat, runningClaudeChat, runningShell],
      visibleSessions: [runningCodexChat, runningClaudeChat, runningShell],
      runningFiltered: [runningCodexChat, runningClaudeChat, runningShell],
      runningSessions: [runningCodexChat, runningClaudeChat, runningShell],
      filtered: [runningCodexChat, runningClaudeChat, runningShell],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCodexChat, runningClaudeChat, runningShell]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "select chat-running-codex" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "select chat-running-claude" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "select shell-running" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "bulk delete" }));

    await waitFor(() => {
      expect(agentChatDelete).toHaveBeenCalledTimes(2);
      expect(agentChatDelete).toHaveBeenCalledWith({ sessionId: "chat-running-codex" });
      expect(agentChatDelete).toHaveBeenCalledWith({ sessionId: "chat-running-claude" });
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-running-codex");
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-running-claude");
    });
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(workMocks.currentWork.removeSessionFromList).not.toHaveBeenCalledWith("shell-running");
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Delete 2 selected sessions?"));
    confirmSpy.mockRestore();
  });

  it("stops and deletes a single running CLI session via the context menu", async () => {
    const runningCli = workMocks.makeTerminalSession("cli-single", "lane-primary", "codex");
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCli],
      visibleSessions: [runningCli],
      runningFiltered: [runningCli],
      runningSessions: [runningCli],
      filtered: [runningCli],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCli]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    // Open the context menu for the session, then trigger stop-and-delete.
    fireEvent.click(await screen.findByRole("button", { name: "context menu cli-single" }));
    fireEvent.click(await screen.findByRole("button", { name: "context stop and delete cli-single" }));

    // The styled confirmation dialog must gate the destructive single-session action.
    fireEvent.click(await screen.findByRole("button", { name: "Stop & delete" }));

    await waitFor(() => {
      // The session-delete service stops the runtime and removes the record in one call;
      // the chat-delete path must not be touched for a non-chat session.
      expect(sessionDelete).toHaveBeenCalledWith({ sessionId: "cli-single" });
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("cli-single");
      expect(workMocks.currentWork.closeTab).toHaveBeenCalledWith("cli-single");
    });
    expect(agentChatDelete).not.toHaveBeenCalled();
  });

  it("does not delete when the stop-and-delete confirmation is dismissed", async () => {
    const runningCli = workMocks.makeTerminalSession("cli-cancel", "lane-primary", "codex");
    const sessionDelete = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: vi.fn() },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCli],
      visibleSessions: [runningCli],
      runningFiltered: [runningCli],
      runningSessions: [runningCli],
      filtered: [runningCli],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCli]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "context menu cli-cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "context stop and delete cli-cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "CANCEL" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop & delete" })).toBeNull(),
    );
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(workMocks.currentWork.removeSessionFromList).not.toHaveBeenCalled();
  });

  it("stops and deletes a mixed selection of running CLI and chat sessions", async () => {
    const runningCli = workMocks.makeTerminalSession("cli-running", "lane-primary", "codex");
    const runningChat = workMocks.makeTerminalSession("chat-running", "lane-primary", "codex-chat", {
      ptyId: null,
    });
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    const sessionDelete = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCli, runningChat],
      visibleSessions: [runningCli, runningChat],
      runningFiltered: [runningCli, runningChat],
      runningSessions: [runningCli, runningChat],
      filtered: [runningCli, runningChat],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCli, runningChat]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "select cli-running" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "select chat-running" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "bulk stop and delete" }));

    // The styled confirmation dialog gates the destructive action.
    fireEvent.click(await screen.findByRole("button", { name: "Stop & delete" }));

    await waitFor(() => {
      // The running CLI session is stopped+deleted via the session-delete service,
      // and the chat is removed via the chat delete flow — both in one action.
      expect(sessionDelete).toHaveBeenCalledWith({ sessionId: "cli-running" });
      expect(agentChatDelete).toHaveBeenCalledWith({ sessionId: "chat-running" });
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("cli-running");
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-running");
    });
  });
});
