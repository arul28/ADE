/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSession, LaneSummary } from "../../../shared/types";
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
    missionId: null,
    laneRole: null,
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
    tabVisibleSessionIds: [],
    runningFiltered: [],
    awaitingInputFiltered: [],
    endedFiltered: [],
    runningSessions: [],
    filtered: [],
    sessionsGroupedByLane: [],
    loading: false,
    gridLayoutId: "work-grid",
    activeItemId: null,
    selectedSessionId: null,
    viewMode: "tabs",
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
    setViewMode: vi.fn(),
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
    currentWork: baseWork,
    fns,
  };
});

vi.mock("../../state/appStore", () => ({
  useAppStore: <T,>(selector: (state: { selectedLaneId: string }) => T): T =>
    selector({ selectedLaneId: "lane-primary" }),
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
  SessionListPane: () => <div data-testid="session-list-pane" />,
}));

vi.mock("./WorkSidebar", () => ({
  WorkSidebar: () => <div data-testid="work-sidebar" />,
}));

vi.mock("./SessionContextMenu", () => ({
  SessionContextMenu: () => null,
}));

vi.mock("./SessionInfoPopover", () => ({
  SessionInfoPopover: () => null,
}));

vi.mock("./WorkViewArea", () => ({
  WorkViewArea: (props: {
    onOpenChatSession: (session: AgentChatSession, options?: { activate?: boolean; source?: "chat" | "draft-launch" | "handoff" }) => void | Promise<void>;
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
});
