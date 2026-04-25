/* @vitest-environment jsdom */

import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { collectLeafIds } from "../ui/paneTreeOps";
import { isChatToolType } from "../../lib/sessions";
import { WorkViewArea } from "./WorkViewArea";

const chatPaneLifecycle = vi.hoisted(() => ({
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
}));

vi.mock("./TerminalView", () => ({
  TerminalView: ({ sessionId, isActive }: { sessionId: string; isActive: boolean }) => (
    <div data-testid="terminal-view" data-session-id={sessionId} data-active={String(isActive)} />
  ),
}));

vi.mock("../chat/AgentChatPane", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    AgentChatPane: ({ lockSessionId }: { lockSessionId?: string | null }) => {
      const sessionId = lockSessionId ?? "draft";
      React.useEffect(() => {
        chatPaneLifecycle.mounts.set(sessionId, (chatPaneLifecycle.mounts.get(sessionId) ?? 0) + 1);
        return () => {
          chatPaneLifecycle.unmounts.set(sessionId, (chatPaneLifecycle.unmounts.get(sessionId) ?? 0) + 1);
        };
      }, [sessionId]);
      return <div data-testid="agent-chat-pane" data-session-id={sessionId} />;
    },
  };
});

vi.mock("./WorkStartSurface", () => ({
  WorkStartSurface: () => <div data-testid="work-start-surface" />,
}));

vi.mock("../ui/PaneTilingLayout", () => ({
  PaneTilingLayout: ({
    layoutId,
    tree,
    panes,
  }: {
    layoutId: string;
    tree: unknown;
    panes: Record<string, { children: ReactNode; onPaneMouseDown?: () => void }>;
  }) => {
    latestPaneTilingLayoutProps = { layoutId, tree, panes };
    return (
      <div data-testid="pane-tiling-layout">
        {Object.entries(panes).map(([paneId, pane]) => (
          <div
            key={paneId}
            data-testid={`pane-tiling-layout-pane:${paneId}`}
            onMouseDown={pane.onPaneMouseDown}
          >
            {pane.children}
          </div>
        ))}
      </div>
    );
  },
}));

let latestPaneTilingLayoutProps: {
  layoutId: string;
  tree: unknown;
  panes: Record<string, { children: ReactNode; onPaneMouseDown?: () => void }>;
} | null = null;

beforeEach(() => {
  latestPaneTilingLayoutProps = null;
  chatPaneLifecycle.mounts.clear();
  chatPaneLifecycle.unmounts.clear();
  vi.mocked(isChatToolType).mockReturnValue(false);
});

vi.mock("./ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));

vi.mock("../../lib/sessions", () => ({
  isChatToolType: vi.fn(() => false),
  primarySessionLabel: vi.fn((session: TerminalSessionSummary) => session.title),
  secondarySessionLabel: vi.fn(() => null),
  truncateSessionLabel: vi.fn((label: string) => label),
}));

vi.mock("../../lib/terminalAttention", () => ({
  sessionStatusDot: vi.fn(() => ({ cls: "ade-status-dot", label: "Idle", spinning: false })),
}));

function makeSession(): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    title: "Existing session",
    goal: null,
    toolType: "shell",
    status: "completed",
    startedAt: "2026-04-06T12:00:00.000Z",
    endedAt: "2026-04-06T12:10:00.000Z",
    exitCode: 0,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
  };
}

function makeRunningSession(id: string, ptyId: string): TerminalSessionSummary {
  return {
    ...makeSession(),
    id,
    ptyId,
    status: "running",
    endedAt: null,
    exitCode: null,
    runtimeState: "running",
  };
}

function makeChatSession(id: string): TerminalSessionSummary {
  return {
    ...makeSession(),
    id,
    ptyId: null,
    toolType: "codex-chat",
    status: "running",
    endedAt: null,
    exitCode: null,
    runtimeState: "running",
  };
}

describe("WorkViewArea", () => {
  it("shows the draft surface when no tab is active, even if tabs are open", () => {
    const session = makeSession();

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={null}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(screen.getByTestId("work-start-surface")).toBeTruthy();
    expect(screen.queryByText("Session ended")).toBeNull();
  });

  it("keeps every running terminal tile mounted in grid mode", () => {
    const first = makeRunningSession("session-1", "pty-1");
    const second = makeRunningSession("session-2", "pty-2");

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[first, second]}
        visibleSessions={[first, second]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={first.id}
        viewMode="grid"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(screen.getAllByTestId("terminal-view")).toHaveLength(2);
  });

  it("keeps the grid tiling tree stable when refreshed session objects keep the same ids", () => {
    const first = makeRunningSession("session-1", "pty-1");
    const second = makeRunningSession("session-2", "pty-2");

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[first, second]}
        visibleSessions={[first, second]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={first.id}
        viewMode="grid"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const initialTree = latestPaneTilingLayoutProps?.tree;

    const refreshedFirst = { ...first, lastOutputPreview: "new output" };
    const refreshedSecond = { ...second, summary: "updated summary" };
    view.rerender(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[refreshedFirst, refreshedSecond]}
        visibleSessions={[refreshedFirst, refreshedSecond]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={first.id}
        viewMode="grid"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(latestPaneTilingLayoutProps?.tree).toBe(initialTree);
  });

  it("keeps chat tiles mounted across metadata-only grid refreshes", () => {
    vi.mocked(isChatToolType).mockImplementation((toolType) => toolType === "codex-chat");
    const first = makeChatSession("chat-1");
    const second = makeChatSession("chat-2");

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[first, second]}
        visibleSessions={[first, second]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={first.id}
        viewMode="grid"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    const refreshedFirst = { ...first, lastOutputPreview: "new output" };
    const refreshedSecond = { ...second, summary: "updated summary" };
    view.rerender(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[refreshedFirst, refreshedSecond]}
        visibleSessions={[refreshedFirst, refreshedSecond]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={first.id}
        viewMode="grid"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(chatPaneLifecycle.mounts.get("chat-1")).toBe(1);
    expect(chatPaneLifecycle.mounts.get("chat-2")).toBe(1);
    expect(chatPaneLifecycle.unmounts.get("chat-1")).toBeUndefined();
    expect(chatPaneLifecycle.unmounts.get("chat-2")).toBeUndefined();
  });

  it("preserves unusual session ids when building the grid tiling tree", () => {
    const session = makeRunningSession("session\u0000with-delimiter", "pty-1");

    render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={session.id}
        viewMode="grid"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(collectLeafIds(latestPaneTilingLayoutProps?.tree as Parameters<typeof collectLeafIds>[0])).toEqual([session.id]);
  });

  it("selects a tiled session when its body is clicked in grid mode", () => {
    const first = makeRunningSession("session-1", "pty-1");
    const second = makeRunningSession("session-2", "pty-2");
    const onSelectItem = vi.fn();

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[{
          id: "lane-1",
          name: "Lane 1",
          laneType: "worktree",
          baseRef: "main",
          branchRef: "lane-1",
          worktreePath: "/tmp/lane-1",
          parentLaneId: null,
          childCount: 0,
          stackDepth: 0,
          parentStatus: null,
          isEditProtected: false,
          status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-06T12:00:00.000Z",
        }]}
        sessions={[first, second]}
        visibleSessions={[first, second]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={first.id}
        viewMode="grid"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={onSelectItem}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({})}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(latestPaneTilingLayoutProps?.layoutId).toBe("work:grid:test");
    fireEvent.mouseDown(within(view.container).getByTestId("pane-tiling-layout-pane:session-2"));
    expect(onSelectItem).toHaveBeenCalledWith("session-2");
  });
});
