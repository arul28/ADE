/* @vitest-environment jsdom */

import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { WorkViewArea } from "./WorkViewArea";

vi.mock("./TerminalView", () => ({
  TerminalView: ({ sessionId, isActive }: { sessionId: string; isActive: boolean }) => (
    <div data-testid="terminal-view" data-session-id={sessionId} data-active={String(isActive)} />
  ),
}));

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: () => <div data-testid="agent-chat-pane" />,
}));

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
