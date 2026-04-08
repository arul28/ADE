/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { WorkViewArea } from "./WorkViewArea";

vi.mock("./TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: () => <div data-testid="agent-chat-pane" />,
}));

vi.mock("./WorkStartSurface", () => ({
  WorkStartSurface: () => <div data-testid="work-start-surface" />,
}));

vi.mock("./PackedSessionGrid", () => ({
  PackedSessionGrid: () => <div data-testid="packed-session-grid" />,
}));

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
});
