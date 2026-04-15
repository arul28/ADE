/* @vitest-environment jsdom */

import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("./PackedSessionGrid", () => ({
  PackedSessionGrid: ({
    tiles,
    onViewportMouseLeave,
  }: {
    tiles: Array<{ id: string; children: ReactNode; onHover?: () => void; onSelect?: () => void }>;
    onViewportMouseLeave?: () => void;
  }) => {
    latestPackedSessionGridProps = { tiles, onViewportMouseLeave };
    return (
      <div data-testid="packed-session-grid" onMouseLeave={onViewportMouseLeave}>
        {tiles.map((tile) => (
          <div
            key={tile.id}
            data-testid={`packed-session-grid-tile:${tile.id}`}
            onMouseOver={tile.onHover}
            onMouseEnter={tile.onHover}
            onPointerOver={tile.onHover}
            onPointerEnter={tile.onHover}
            onMouseDown={tile.onSelect}
          >
            {tile.children}
          </div>
        ))}
      </div>
    );
  },
}));

let latestPackedSessionGridProps: {
  tiles: Array<{ id: string; children: ReactNode; onHover?: () => void; onSelect?: () => void }>;
  onViewportMouseLeave?: () => void;
} | null = null;

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

  it("focuses the hovered grid tile without persisting selection", async () => {
    const first = makeRunningSession("session-1", "pty-1");
    const second = makeRunningSession("session-2", "pty-2");
    const onSelectItem = vi.fn();

    const { container } = render(
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

    expect(latestPackedSessionGridProps).not.toBeNull();
    await act(async () => {
      latestPackedSessionGridProps?.tiles[1].onHover?.();
    });

    expect(onSelectItem).not.toHaveBeenCalled();
    expect(container.querySelector('[data-session-id="session-1"]')?.getAttribute("data-active")).toBe("false");
    expect(container.querySelector('[data-session-id="session-2"]')?.getAttribute("data-active")).toBe("true");

    await act(async () => {
      latestPackedSessionGridProps?.onViewportMouseLeave?.();
    });

    expect(container.querySelector('[data-session-id="session-1"]')?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector('[data-session-id="session-2"]')?.getAttribute("data-active")).toBe("false");
  });
});
