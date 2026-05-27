/* @vitest-environment jsdom */

import { useState, type ReactNode } from "react";
import type * as ReactNamespace from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { collectLeafIds } from "../ui/paneTreeOps";
import { FloatingPane } from "../ui/FloatingPane";
import { isChatToolType } from "../../lib/sessions";
import { WorkViewArea } from "./WorkViewArea";

const chatPaneLifecycle = vi.hoisted(() => ({
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
}));

vi.mock("@emoji-mart/data", () => ({
  default: { categories: [], emojis: {}, aliases: {}, sheet: { cols: 0, rows: 0 } },
}));

vi.mock("@emoji-mart/data/sets/15/native.json", () => ({
  default: { categories: [], emojis: {}, aliases: {}, sheet: { cols: 0, rows: 0 } },
}));

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Anthropic: brand(),
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    Gemini: brand(),
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    Kimi: brand(),
    LmStudio: brand(),
    Ollama: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    XAI: brand(),
  };
});

vi.mock("./TerminalView", () => ({
  TerminalView: ({ sessionId, isActive }: { sessionId: string; isActive: boolean }) => (
    <div data-testid="terminal-view" data-session-id={sessionId} data-active={String(isActive)} />
  ),
}));

// The Work-tab lane context menu hook depends on react-router's useNavigate.
// These tests render WorkViewArea bare (no router), so stub the hook out.
vi.mock("./useWorkLaneContextMenu", () => ({
  useWorkLaneContextMenu: () => ({ trigger: () => {}, menu: null }),
}));

vi.mock("./WorkCliSessionHeader", () => ({
  WorkCliSessionHeader: ({
    session,
  }: {
    session: TerminalSessionSummary;
  }) => (
    <div data-testid="work-cli-session-header" data-session-id={session.id} />
  ),
}));

vi.mock("../chat/AgentChatPane", async () => {
  const React = await vi.importActual("react") as typeof ReactNamespace;
  return {
    AgentChatPane: ({
      lockSessionId,
      isTileActive,
      isTileVisible,
    }: {
      lockSessionId?: string | null;
      isTileActive?: boolean;
      isTileVisible?: boolean;
    }) => {
      const sessionId = lockSessionId ?? "draft";
      React.useEffect(() => {
        chatPaneLifecycle.mounts.set(sessionId, (chatPaneLifecycle.mounts.get(sessionId) ?? 0) + 1);
        return () => {
          chatPaneLifecycle.unmounts.set(sessionId, (chatPaneLifecycle.unmounts.get(sessionId) ?? 0) + 1);
        };
      }, [sessionId]);
      return (
        <div
          data-testid="agent-chat-pane"
          data-session-id={sessionId}
          data-tile-active={String(isTileActive)}
          data-tile-visible={String(isTileVisible)}
        />
      );
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
const terminalPreviewMock = vi.fn();
const slashCommandsMock = vi.fn();
const modelsMock = vi.fn();
const sendToSessionMock = vi.fn();
const resolvePtyLaunch = async () => ({ sessionId: "test-session", ptyId: "test-pty", pid: null });

beforeEach(() => {
  latestPaneTilingLayoutProps = null;
  chatPaneLifecycle.mounts.clear();
  chatPaneLifecycle.unmounts.clear();
  terminalPreviewMock.mockReset();
  terminalPreviewMock.mockResolvedValue({
    terminalId: "session-1",
    source: "empty",
    snapshot: null,
    transcript: null,
    capturedAt: "2026-04-06T12:10:00.000Z",
  });
  slashCommandsMock.mockReset();
  slashCommandsMock.mockResolvedValue([]);
  modelsMock.mockReset();
  modelsMock.mockImplementation(({ provider }: { provider: string }) => {
    if (provider === "codex") {
      return Promise.resolve([
        { id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true },
        { id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", isDefault: false },
      ]);
    }
    return Promise.resolve([
      { id: "sonnet", displayName: "Claude Sonnet 4.6", isDefault: true },
      { id: "haiku", displayName: "Claude Haiku 4.5", isDefault: false },
    ]);
  });
  sendToSessionMock.mockReset();
  sendToSessionMock.mockResolvedValue({ sessionId: "session-1", ptyId: "pty-1", pid: 123, session: null, resumed: true, reusedExistingRuntime: false });
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      agentChat: {
        models: modelsMock,
        slashCommands: slashCommandsMock,
      },
      pty: {
        sendToSession: sendToSessionMock,
      },
      terminal: {
        preview: terminalPreviewMock,
      },
    },
  });
  vi.mocked(isChatToolType).mockReturnValue(false);
});

afterEach(() => {
  cleanup();
});

vi.mock("./ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));

vi.mock("../../lib/sessions", () => ({
  isChatToolType: vi.fn(() => false),
  primarySessionLabel: vi.fn((session: TerminalSessionSummary) => session.title),
  secondarySessionLabel: vi.fn(() => null),
  stripTerminalLabelControls: vi.fn((raw: string) => raw
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[\(\)][0-9A-Za-z]/g, "")
    .replace(/\u001b(?:[@-Z\\-_]|[0-9=>])/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")),
  truncateSessionLabel: vi.fn((label: string) => label),
  formatToolTypeLabel: vi.fn((toolType: string | null | undefined) => toolType ?? "Tool"),
  chatToolTypeForProvider: vi.fn(() => "opencode-chat"),
}));

vi.mock("../../lib/terminalAttention", () => ({
  sessionStatusDot: vi.fn(() => ({ cls: "ade-status-dot", label: "Idle", spinning: false })),
  sessionStatusBucket: vi.fn(() => "running"),
  sessionNeedsChatTabHighlight: vi.fn(() => false),
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
  it("shows only Chat and CLI start modes on the empty Work surface", () => {
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
        sessions={[]}
        visibleSessions={[]}
        tabGroups={[]}
        tabVisibleSessionIds={[]}
        activeItemId={null}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CLI" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Orchestrator" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Shell" })).toBeNull();
  });

  it("keeps the Chat start mode selected for orchestrator drafts", () => {
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
        sessions={[]}
        visibleSessions={[]}
        tabGroups={[]}
        tabVisibleSessionIds={[]}
        activeItemId={null}
        viewMode="tabs"
        draftKind="chat-orchestrator"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={async () => ({ ptyId: "pty-1", sessionId: "sess-1", pid: 1234 })}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(screen.getByRole("button", { name: "Chat" }).className).toContain("ade-work-tab-active");
    expect(screen.getByRole("button", { name: "CLI" }).className).not.toContain("ade-work-tab-active");
  });

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
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(screen.getByTestId("work-start-surface")).toBeTruthy();
    expect(screen.queryByText("Session ended")).toBeNull();
  });

  it("minimizes and expands through embedded floating-pane chrome", () => {
    const session = makeSession();

    function EmbeddedWorkPane() {
      const [minimized, setMinimized] = useState(false);
      return (
        <FloatingPane
          id="work-pane"
          title="Work"
          minimized={minimized}
          onMinimizeToggle={() => setMinimized((current) => !current)}
          hideHeaderWhenExpanded
        >
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
            onLaunchPtySession={resolvePtyLaunch}
            onShowDraftKind={() => {}}
            onToggleTabGroupCollapsed={() => {}}
            closingPtyIds={new Set()}
          />
        </FloatingPane>
      );
    }

    const view = render(<EmbeddedWorkPane />);
    const local = within(view.container);
    const pane = () => view.container.querySelector('[data-pane-id="work-pane"]') as HTMLElement;

    expect(local.getByTestId("work-start-surface")).toBeTruthy();
    fireEvent.click(local.getByLabelText("Minimize pane"));

    expect(pane().getAttribute("data-minimized")).toBe("true");
    fireEvent.click(local.getByLabelText("Expand pane"));

    expect(pane().getAttribute("data-minimized")).toBe("false");
    expect(local.getByTestId("work-start-surface")).toBeTruthy();
    expect(local.getByLabelText("Minimize pane")).toBeTruthy();
  });

  it("closes an ended work tab from the tab strip", () => {
    const session = makeSession();
    const onCloseItem = vi.fn();

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
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={onCloseItem}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    const closeTabs = Array.from(
      view.container.querySelectorAll<HTMLElement>('[data-close-tab-session-id="session-1"]'),
    );
    expect(closeTabs.length).toBeGreaterThan(0);
    const closeTab = closeTabs.find((node) => node.closest('[role="tab"]')) ?? closeTabs[closeTabs.length - 1]!;
    fireEvent.click(closeTab);

    expect(onCloseItem).toHaveBeenCalledTimes(1);
    expect(onCloseItem).toHaveBeenCalledWith("session-1");
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
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(screen.getAllByTestId("terminal-view")).toHaveLength(2);
  });

  it("adds the CLI session header above agent PTY sessions", () => {
    const session = { ...makeRunningSession("session-1", "pty-1"), toolType: "claude" as const };

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
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    const header = within(view.container).getByTestId("work-cli-session-header");
    const terminals = within(view.container).getAllByTestId("terminal-view");
    expect(header.getAttribute("data-session-id")).toBe("session-1");
    expect(terminals.map((terminal) => terminal.getAttribute("data-session-id"))).toContain("session-1");
  });

  it("shows the transcript for closed agent CLI sessions instead of the generic ended card", async () => {
    terminalPreviewMock.mockResolvedValueOnce({
      terminalId: "session-1",
      source: "snapshot",
      transcript: "\u001b7older output\rfinal answer\nResume this session with:\nclaude --resume abc123\n",
      capturedAt: "2026-04-06T12:10:00.000Z",
      snapshot: {
        version: 1,
        terminalId: "session-1",
        cols: 24,
        rows: 2,
        capturedAt: "2026-04-06T12:10:00.000Z",
        status: "completed",
        runtimeState: "exited",
        bufferType: "normal",
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: [{
          text: "Resume this session with:",
          wrapped: false,
          cells: "Resume this session with:".split("").map((text) => ({
            text,
            fg: 2,
            bg: null,
            fgMode: "palette" as const,
            bgMode: "default" as const,
          })),
        }],
      },
    });
    const session = {
      ...makeSession(),
      toolType: "claude" as const,
      resumeCommand: "claude --resume abc123",
      resumeMetadata: {
        provider: "claude" as const,
        targetKind: "session" as const,
        targetId: "abc123",
        launch: { permissionMode: "default" as const },
      },
    };

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
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const local = within(view.container);

    expect(await local.findByText(/older output/)).toBeTruthy();
    expect(local.getByText(/final answer/)).toBeTruthy();
    expect(local.queryByText("Resume this session with:")).toBeNull();
    expect(local.getByLabelText("Continue Claude Code session")).toBeTruthy();
    expect(local.queryByRole("button", { name: /Select model/i })).toBeNull();
    expect(local.queryByLabelText("Claude Code permission mode")).toBeNull();
    expect(local.queryByText("Resume")).toBeNull();
    expect(local.getAllByTestId("work-cli-session-header").some((header) => header.getAttribute("data-session-id") === "session-1")).toBe(true);
    expect(local.queryAllByTestId("terminal-view")).toHaveLength(0);
    expect(terminalPreviewMock).toHaveBeenCalledWith({ terminalId: "session-1", maxBytes: 160_000 });
    expect(slashCommandsMock).toHaveBeenCalledWith({ laneId: "lane-1", provider: "claude" });
    expect(modelsMock).not.toHaveBeenCalled();
  });

  it("does not hydrate hidden tab session previews or continuation commands", async () => {
    const activeSession = {
      ...makeSession(),
      id: "session-active",
      toolType: "claude" as const,
      resumeCommand: "claude --resume active-thread",
      resumeMetadata: {
        provider: "claude" as const,
        targetKind: "session" as const,
        targetId: "active-thread",
        launch: { permissionMode: "default" as const },
      },
    };
    const hiddenSession = {
      ...makeSession(),
      id: "session-hidden",
      title: "Hidden session",
      toolType: "claude" as const,
      resumeCommand: "claude --resume hidden-thread",
      resumeMetadata: {
        provider: "claude" as const,
        targetKind: "session" as const,
        targetId: "hidden-thread",
        launch: { permissionMode: "default" as const },
      },
    };

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[]}
        sessions={[activeSession, hiddenSession]}
        visibleSessions={[activeSession, hiddenSession]}
        tabGroups={[]}
        tabVisibleSessionIds={[activeSession.id, hiddenSession.id]}
        activeItemId={activeSession.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const local = within(view.container);

    expect(await local.findByLabelText("Continue Claude Code session")).toBeTruthy();
    expect(local.getAllByText("Existing session").length).toBeGreaterThan(0);
    expect(local.getByText("Hidden session")).toBeTruthy();
    expect(terminalPreviewMock).toHaveBeenCalledTimes(1);
    expect(terminalPreviewMock).toHaveBeenCalledWith({ terminalId: "session-active", maxBytes: 160_000 });
    expect(slashCommandsMock).toHaveBeenCalledTimes(1);
    expect(slashCommandsMock).toHaveBeenCalledWith({ laneId: "lane-1", provider: "claude" });
  });

  it("uses colored terminal snapshots for closed TUI sessions", async () => {
    const plainCell = (text: string) => ({
      text,
      fg: null,
      bg: null,
      fgMode: "default" as const,
      bgMode: "default" as const,
    });
    const claudeCell = (text: string) => ({
      text,
      fg: 0xd77757,
      bg: null,
      fgMode: "rgb" as const,
      bgMode: "default" as const,
      bold: true,
    });
    terminalPreviewMock.mockResolvedValueOnce({
      terminalId: "session-1",
      source: "snapshot",
      transcript: "\u001b[38;2;215;119;87mplain transcript fallback\u001b[0m\n",
      capturedAt: "2026-04-06T12:10:00.000Z",
      snapshot: {
        version: 1,
        terminalId: "session-1",
        cols: 24,
        rows: 3,
        capturedAt: "2026-04-06T12:10:00.000Z",
        status: "completed",
        runtimeState: "exited",
        bufferType: "normal",
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: [
          {
            text: "╭─Claude Code─╮",
            wrapped: false,
            cells: [
              ...Array.from("╭─", plainCell),
              ...Array.from("Claude Code", claudeCell),
              ...Array.from("─╮", plainCell),
            ],
          },
          {
            text: "│ Ready       │",
            wrapped: false,
            cells: Array.from("│ Ready       │", plainCell),
          },
          {
            text: "╰─────────────╯",
            wrapped: false,
            cells: Array.from("╰─────────────╯", plainCell),
          },
        ],
      },
    });
    const session = {
      ...makeSession(),
      toolType: "claude" as const,
      resumeCommand: "claude --resume abc123",
      resumeMetadata: {
        provider: "claude" as const,
        targetKind: "session" as const,
        targetId: "abc123",
        launch: { permissionMode: "default" as const },
      },
    };

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const local = within(view.container);

    await local.findByText("Claude Code");
    const coloredLabel = Array.from(view.container.querySelectorAll("span"))
      .find((node) => (
        node.textContent === "Claude Code"
        && (node as HTMLElement).style.color === "rgb(215, 119, 87)"
      )) as HTMLElement | undefined;
    expect(coloredLabel).toBeTruthy();
    expect(coloredLabel?.style.fontWeight).toBe("700");
    expect(local.getByText(/Ready/)).toBeTruthy();
    expect(local.queryByText(/plain transcript fallback/)).toBeNull();
    expect(local.queryAllByTestId("terminal-view")).toHaveLength(0);
  });

  it("treats background-styled spaces as visible TUI snapshot cells", async () => {
    const plainCell = (text: string) => ({
      text,
      fg: null,
      bg: null,
      fgMode: "default" as const,
      bgMode: "default" as const,
    });
    const bgCell = () => ({
      text: " ",
      fg: null,
      bg: 0x17324d,
      fgMode: "default" as const,
      bgMode: "rgb" as const,
    });
    terminalPreviewMock.mockResolvedValueOnce({
      terminalId: "session-1",
      source: "snapshot",
      transcript: "plain transcript fallback\n",
      capturedAt: "2026-04-06T12:10:00.000Z",
      snapshot: {
        version: 1,
        terminalId: "session-1",
        cols: 8,
        rows: 3,
        capturedAt: "2026-04-06T12:10:00.000Z",
        status: "completed",
        runtimeState: "exited",
        bufferType: "normal",
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: ["A", "B", "C"].map((label) => ({
          text: `${label}     `,
          wrapped: false,
          cells: [plainCell(label), ...Array.from({ length: 5 }, bgCell)],
        })),
      },
    });
    const session = {
      ...makeSession(),
      toolType: "codex" as const,
      resumeCommand: "codex resume thread-1",
      resumeMetadata: {
        provider: "codex" as const,
        targetKind: "thread" as const,
        targetId: "thread-1",
        launch: { permissionMode: "plan" as const },
      },
    };

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const local = within(view.container);

    expect(await local.findByText("A")).toBeTruthy();
    expect(local.getByText("B")).toBeTruthy();
    expect(local.getByText("C")).toBeTruthy();
    expect(local.queryByText(/plain transcript fallback/)).toBeNull();
    expect(local.queryAllByTestId("terminal-view")).toHaveLength(0);
  });

  it("shows unreachable agent CLI sessions as ended with continuation controls", async () => {
    terminalPreviewMock.mockResolvedValueOnce({
      terminalId: "session-1",
      source: "transcript",
      transcript: "peer-owned transcript\n",
      capturedAt: "2026-04-06T12:10:00.000Z",
      snapshot: null,
    });
    const session = {
      ...makeSession(),
      toolType: "codex" as const,
      status: "detached" as const,
      endedAt: null,
      runtimeState: "exited" as const,
      resumeCommand: "codex resume thread-1",
      resumeMetadata: {
        provider: "codex" as const,
        targetKind: "thread" as const,
        targetId: "thread-1",
        launch: { permissionMode: "plan" as const },
      },
    };

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const local = within(view.container);

    expect(await local.findByText("Session ended")).toBeTruthy();
    expect(local.getByText(/peer-owned transcript/)).toBeTruthy();
    expect(local.getByLabelText("Continue Codex session")).toBeTruthy();
    expect(local.queryAllByTestId("terminal-view")).toHaveLength(0);
  });

  it("treats fully styled blank snapshot rows as TUI content", async () => {
    const bgCell = () => ({
      text: " ",
      fg: null,
      bg: 0x17324d,
      fgMode: "default" as const,
      bgMode: "rgb" as const,
    });
    terminalPreviewMock.mockResolvedValueOnce({
      terminalId: "session-1",
      source: "snapshot",
      transcript: "plain transcript fallback\n",
      capturedAt: "2026-04-06T12:10:00.000Z",
      snapshot: {
        version: 1,
        terminalId: "session-1",
        cols: 8,
        rows: 3,
        capturedAt: "2026-04-06T12:10:00.000Z",
        status: "completed",
        runtimeState: "exited",
        bufferType: "normal",
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: Array.from({ length: 3 }, () => ({
          text: "     ",
          wrapped: false,
          cells: Array.from({ length: 5 }, bgCell),
        })),
      },
    });
    const session = {
      ...makeSession(),
      toolType: "codex" as const,
      resumeCommand: "codex resume thread-1",
      resumeMetadata: {
        provider: "codex" as const,
        targetKind: "thread" as const,
        targetId: "thread-1",
        launch: { permissionMode: "plan" as const },
      },
    };

    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const local = within(view.container);

    await waitFor(() => {
      expect(local.queryByText(/plain transcript fallback/)).toBeNull();
      expect(local.queryAllByTestId("terminal-view")).toHaveLength(0);
    });
  });

  it("submits continuation text for ended agent CLI sessions", async () => {
    const onContinue = vi.fn().mockResolvedValue(undefined);
    const session = {
      ...makeSession(),
      toolType: "codex" as const,
      resumeCommand: "codex resume thread-1",
      resumeMetadata: {
        provider: "codex" as const,
        targetKind: "thread" as const,
        targetId: "thread-1",
        launch: { permissionMode: "plan" as const },
      },
    };

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
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
        onContinueCliSession={onContinue}
      />,
    );

    const textarea = await within(view.container).findByLabelText("Continue Codex session");
    fireEvent.change(textarea, { target: { value: "fix the test" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onContinue).toHaveBeenCalledWith(session, "fix the test"));
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("does not show resume-time model or permission controls", async () => {
    const session = {
      ...makeSession(),
      toolType: "codex" as const,
      resumeCommand: "codex resume thread-1",
      resumeMetadata: {
        provider: "codex" as const,
        targetKind: "thread" as const,
        targetId: "thread-1",
        launch: { permissionMode: "plan" as const },
      },
    };
    const view = render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );
    const local = within(view.container);

    expect(await local.findByLabelText("Continue Codex session")).toBeTruthy();
    expect(local.queryByRole("button", { name: /Select model/i })).toBeNull();
    expect(local.queryByLabelText("Codex permission mode")).toBeNull();
  });

  it("shows provider-specific slash command suggestions in the continuation composer", async () => {
    slashCommandsMock.mockResolvedValue([
      { name: "/status", description: "Show status", source: "sdk" },
    ]);
    const session = {
      ...makeSession(),
      toolType: "claude" as const,
      resumeCommand: "claude --resume abc123",
      resumeMetadata: {
        provider: "claude" as const,
        targetKind: "session" as const,
        targetId: "abc123",
        launch: { permissionMode: "default" as const },
      },
    };

    render(
      <WorkViewArea
        gridLayoutId="work:grid:test"
        lanes={[]}
        sessions={[session]}
        visibleSessions={[session]}
        tabGroups={[]}
        tabVisibleSessionIds={[session.id]}
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    await waitFor(() => expect(slashCommandsMock).toHaveBeenCalledWith({ laneId: "lane-1", provider: "claude" }));
    const textareas = await screen.findAllByLabelText("Continue Claude Code session");
    const textarea = textareas.at(-1);
    expect(textarea).toBeTruthy();
    fireEvent.focus(textarea!);
    fireEvent.change(textarea!, { target: { value: "/st", selectionStart: 3 } });

    expect(await screen.findByText("/status")).toBeTruthy();
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
        onLaunchPtySession={resolvePtyLaunch}
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
        onLaunchPtySession={resolvePtyLaunch}
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
        onLaunchPtySession={resolvePtyLaunch}
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
        onLaunchPtySession={resolvePtyLaunch}
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

  it("marks every chat tile visible in grid mode while only the selected tile is active", () => {
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
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    const tiles = within(view.container).getAllByTestId("agent-chat-pane");
    const firstTile = tiles.find((el) => el.getAttribute("data-session-id") === "chat-1");
    const secondTile = tiles.find((el) => el.getAttribute("data-session-id") === "chat-2");
    expect(firstTile?.getAttribute("data-tile-active")).toBe("true");
    expect(firstTile?.getAttribute("data-tile-visible")).toBe("true");
    expect(secondTile?.getAttribute("data-tile-active")).toBe("false");
    expect(secondTile?.getAttribute("data-tile-visible")).toBe("true");
  });

  it("keeps chat panes mounted but inactive while the Work page is parked", () => {
    vi.mocked(isChatToolType).mockImplementation((toolType) => toolType === "codex-chat");
    const session = makeChatSession("chat-1");

    const view = render(
      <WorkViewArea
        pageActive={false}
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
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    const pane = within(view.container).getByTestId("agent-chat-pane");
    expect(pane.getAttribute("data-tile-active")).toBe("false");
    expect(pane.getAttribute("data-tile-visible")).toBe("false");
    expect(chatPaneLifecycle.mounts.get("chat-1")).toBe(1);
    expect(chatPaneLifecycle.unmounts.get("chat-1")).toBeUndefined();
  });

  it("keeps open chat tabs mounted while switching the active tab", () => {
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
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(within(view.container).getAllByTestId("agent-chat-pane")).toHaveLength(2);
    expect(chatPaneLifecycle.mounts.get("chat-1")).toBe(1);
    expect(chatPaneLifecycle.mounts.get("chat-2")).toBe(1);

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
        sessions={[first, second]}
        visibleSessions={[first, second]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={second.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
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

  it("keeps active chat mounted when its tab group is collapsed", () => {
    vi.mocked(isChatToolType).mockImplementation((toolType) => toolType === "codex-chat");
    const session = makeChatSession("chat-1");

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
        tabGroups={[{
          id: "lane:lane-1",
          label: "Lane 1",
          kind: "lane",
          laneColor: null,
          collapsed: true,
          sessionIds: [session.id],
          sessions: [session],
        }]}
        tabVisibleSessionIds={[]}
        activeItemId={session.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    expect(within(view.container).getByTestId("agent-chat-pane")).toBeTruthy();
    expect(chatPaneLifecycle.mounts.get("chat-1")).toBe(1);
    expect(chatPaneLifecycle.unmounts.get("chat-1")).toBeUndefined();
  });

  it("keeps every running terminal tile mounted in tabs mode while switching active tab", () => {
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
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    const terminals = within(view.container).getAllByTestId("terminal-view");
    expect(terminals).toHaveLength(2);
    const firstTerminal = terminals.find((el) => el.getAttribute("data-session-id") === "session-1");
    const secondTerminal = terminals.find((el) => el.getAttribute("data-session-id") === "session-2");
    expect(firstTerminal?.getAttribute("data-active")).toBe("true");
    expect(secondTerminal?.getAttribute("data-active")).toBe("false");
    expect(firstTerminal?.closest("[hidden]")).toBeNull();
    expect(secondTerminal?.closest("[hidden]")).not.toBeNull();

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
        sessions={[first, second]}
        visibleSessions={[first, second]}
        tabGroups={[]}
        tabVisibleSessionIds={[first.id, second.id]}
        activeItemId={second.id}
        viewMode="tabs"
        draftKind="chat"
        setViewMode={() => {}}
        onSelectItem={() => {}}
        onCloseItem={() => {}}
        onOpenChatSession={() => {}}
        onLaunchPtySession={resolvePtyLaunch}
        onShowDraftKind={() => {}}
        onToggleTabGroupCollapsed={() => {}}
        closingPtyIds={new Set()}
      />,
    );

    const terminalsAfter = within(view.container).getAllByTestId("terminal-view");
    expect(terminalsAfter).toHaveLength(2);
    const firstAfter = terminalsAfter.find((el) => el.getAttribute("data-session-id") === "session-1");
    const secondAfter = terminalsAfter.find((el) => el.getAttribute("data-session-id") === "session-2");
    expect(firstAfter?.getAttribute("data-active")).toBe("false");
    expect(secondAfter?.getAttribute("data-active")).toBe("true");
    expect(firstAfter?.closest("[hidden]")).not.toBeNull();
    expect(secondAfter?.closest("[hidden]")).toBeNull();
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
        onLaunchPtySession={resolvePtyLaunch}
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
        onLaunchPtySession={resolvePtyLaunch}
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
