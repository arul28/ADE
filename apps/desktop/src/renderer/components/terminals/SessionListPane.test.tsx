/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { createPendingLaneDeleteProgress } from "../../lib/laneDeleteProgress";
import { useAppStore } from "../../state/appStore";
import { SessionListPane } from "./SessionListPane";

vi.mock("./useSessionDelta", () => ({
  useSessionDelta: () => null,
}));

vi.mock("./ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-known",
    name: "Known Lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "known-lane",
    worktreePath: "/tmp/known-lane",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-mobile",
    laneId: "lane-mobile",
    laneName: "Mobile-created lane",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: null,
    toolType: "codex-chat",
    title: "Mobile Tool Streaming UI",
    status: "running",
    startedAt: "2026-04-22T22:13:02.691Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: ".ade/transcripts/session-mobile.chat.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  };
}

function renderPane(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
  const session = makeSession();
  return render(
    <MemoryRouter>
      <SessionListPane
        lanes={[makeLane()]}
        runningFiltered={[session]}
        awaitingInputFiltered={[]}
        endedFiltered={[]}
        allSessionsUnfiltered={[session]}
        loading={false}
        filterLaneId="all"
        setFilterLaneId={vi.fn()}
        q=""
        setQ={vi.fn()}
        selectedSessionId={null}
        draftKind="chat"
        showingDraft={false}
        onShowDraftKind={vi.fn()}
        onSelectSession={vi.fn()}
        onContextMenu={vi.fn()}
        sessionListOrganization="by-lane"
        setSessionListOrganization={vi.fn()}
        workCollapsedLaneIds={[]}
        toggleWorkLaneCollapsed={vi.fn()}
        workCollapsedSectionIds={[]}
        toggleWorkSectionCollapsed={vi.fn()}
        sessionsGroupedByLane={new Map([[session.laneId, [session]]])}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("SessionListPane", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ laneDeleteProgressByLaneId: {} });
  });

  it("renders by-lane sessions whose lane is missing from the cached lane list", () => {
    renderPane();

    expect(screen.getByText("Mobile-created lane")).toBeTruthy();
    expect(screen.getByText("Mobile Tool Streaming UI")).toBeTruthy();
  });

  it("disables a lane and its chats while lane deletion is in progress", () => {
    const onSelectSession = vi.fn();
    const session = makeSession({
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Deleting lane chat",
    });
    useAppStore.setState({
      laneDeleteProgressByLaneId: {
        "lane-known": createPendingLaneDeleteProgress("lane-known"),
      },
    });

    renderPane({
      runningFiltered: [session],
      allSessionsUnfiltered: [session],
      sessionsGroupedByLane: new Map([[session.laneId, [session]]]),
      onSelectSession,
    });

    const chatButton = screen.getByRole("button", { name: "Deleting lane chat: Deleting lane" });
    const laneHeaderButton = screen.getByText("Known Lane").closest("button");
    expect((chatButton as HTMLButtonElement).disabled).toBe(true);
    expect((laneHeaderButton as HTMLButtonElement | null)?.disabled).toBe(true);
    fireEvent.click(chatButton);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("renders in-flight handoff placeholders in the matching lane group", () => {
    renderPane({
      runningFiltered: [],
      sessionsGroupedByLane: new Map(),
      handoffJobs: [
        {
          id: "handoff-job-1",
          sourceSessionId: "source-session",
          laneId: "lane-known",
          laneName: "Known Lane",
          targetModelId: "openai/gpt-5.4-mini",
          targetModelLabel: "GPT-5.4-Mini",
          targetToolType: "codex-chat",
          status: "creating-chat",
          createdAtMs: Date.now(),
        },
      ],
    });

    expect(screen.getByTestId("handoff-launch-placeholder")).toBeTruthy();
    expect(screen.getByText("Handoff to GPT-5.4-Mini")).toBeTruthy();
    expect(screen.getByText("Creating chat...")).toBeTruthy();
    expect(screen.getByText("First message: Chat handoff from previous session")).toBeTruthy();
  });

  it("lets the user set the group organization from the filter panel", () => {
    const setSessionListOrganization = vi.fn();
    const view = renderPane({ setSessionListOrganization });
    const filterButton = view.container.querySelector('button[data-tour="work.laneFilter"]');
    expect(filterButton).toBeTruthy();

    fireEvent.click(filterButton!);
    fireEvent.click(within(view.container).getByRole("button", { name: "Time" }));

    expect(setSessionListOrganization).toHaveBeenCalledWith("by-time");
  });

  it("shows an active marker only when the lane filter restricts lanes", () => {
    const { rerender } = renderPane({ filterLaneId: "all" });

    expect(screen.queryByTestId("work-lane-filter-active-indicator")).toBeNull();

    const session = makeSession();
    rerender(
      <MemoryRouter>
        <SessionListPane
          lanes={[makeLane()]}
          runningFiltered={[session]}
          awaitingInputFiltered={[]}
          endedFiltered={[]}
          allSessionsUnfiltered={[session]}
          loading={false}
          filterLaneId="lane-known"
          setFilterLaneId={vi.fn()}
          q=""
          setQ={vi.fn()}
          selectedSessionId={null}
          draftKind="chat"
          showingDraft={false}
          onShowDraftKind={vi.fn()}
          onSelectSession={vi.fn()}
          onContextMenu={vi.fn()}
          sessionListOrganization="by-lane"
          setSessionListOrganization={vi.fn()}
          workCollapsedLaneIds={[]}
          toggleWorkLaneCollapsed={vi.fn()}
          workCollapsedSectionIds={[]}
          toggleWorkSectionCollapsed={vi.fn()}
          sessionsGroupedByLane={new Map([[session.laneId, [session]]])}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Filters, lane filter active" })).toBeTruthy();
    expect(screen.getByTestId("work-lane-filter-active-indicator")).toBeTruthy();
  });

  it("bolds only the session name in sidebar cards", () => {
    const session = makeSession({
      id: "session-style",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Style target session",
      lastOutputPreview: "Ran the latest command",
    });
    renderPane({
      runningFiltered: [session],
      sessionsGroupedByLane: new Map([[session.laneId, [session]]]),
    });

    const title = screen.getByText("Style target session");
    const row = title.closest("button");
    expect(row).toBeTruthy();

    expect(title.className).toContain("font-semibold");
    expect(within(row!).getByText("Ran the latest command").className).not.toContain("font-semibold");
  });

  it("marks idle CLI and shell sessions", () => {
    const staleSession = makeSession({
      id: "session-stale-shell",
      laneId: "lane-known",
      laneName: "Known Lane",
      toolType: "shell",
      title: "Old shell",
      // No activity recorded → idle age falls back to startedAt, which is far
      // enough in the past to clear the 24h idle threshold.
      startedAt: "2026-04-20T10:00:00.000Z",
      lastActivityAt: null,
      status: "running",
      runtimeState: "waiting-input",
    });
    renderPane({
      runningFiltered: [staleSession],
      sessionsGroupedByLane: new Map([[staleSession.laneId, [staleSession]]]),
    });

    expect(screen.getByLabelText("Idle session")).toBeTruthy();
  });

  it("collapses and expands child shell sections under a chat parent", () => {
    const parent = makeSession({
      id: "chat-parent",
      laneId: "lane-known",
      laneName: "Known Lane",
      toolType: "codex-chat",
      title: "Parent chat",
    });
    const child = makeSession({
      id: "child-shell",
      laneId: "lane-known",
      laneName: "Known Lane",
      toolType: "shell",
      title: "Child shell",
      ptyId: "pty-child",
      chatSessionId: parent.id,
    });
    const sessionsGroupedByLane = new Map([[parent.laneId, [parent, child]]]);
    const toggleWorkSectionCollapsed = vi.fn();

    const view = renderPane({
      runningFiltered: [parent, child],
      sessionsGroupedByLane,
      toggleWorkSectionCollapsed,
    });

    expect(screen.getByText("Child shell")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /1 shell/i }));
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith("chat:chat-parent");

    view.unmount();
    renderPane({
      runningFiltered: [parent, child],
      sessionsGroupedByLane,
      workCollapsedSectionIds: ["chat:chat-parent"],
      toggleWorkSectionCollapsed,
    });

    expect(screen.queryByText("Child shell")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 shell/i }));
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledTimes(2);
    expect(toggleWorkSectionCollapsed).toHaveBeenLastCalledWith("chat:chat-parent");
  });

  it("reports rendered session order for range selection", () => {
    const onSelectSession = vi.fn();
    const first = makeSession({
      id: "session-first",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "First session",
    });
    const second = makeSession({
      id: "session-second",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Second session",
    });
    renderPane({
      runningFiltered: [first, second],
      sessionsGroupedByLane: new Map([[first.laneId, [first, second]]]),
      onSelectSession,
    });

    fireEvent.click(screen.getByText("Second session"), { shiftKey: true });

    expect(onSelectSession).toHaveBeenCalledWith(
      "session-second",
      expect.objectContaining({ shiftKey: true }),
      ["session-first", "session-second"],
    );
  });

  it("renders bulk action footer with runtime stop, session delete, and clear handlers", () => {
    const onBulkClose = vi.fn();
    const onBulkDelete = vi.fn();
    const onClearSelection = vi.fn();
    const running = makeSession({
      id: "session-running",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Running shell",
      toolType: "shell",
      status: "running",
    });
    const archivable = makeSession({
      id: "session-archivable",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Active chat",
      toolType: "codex-chat",
      status: "completed",
      runtimeState: "exited",
      archivedAt: null,
    });
    const restorable = makeSession({
      id: "session-restorable",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Archived chat",
      toolType: "claude-chat",
      status: "completed",
      runtimeState: "exited",
      archivedAt: "2026-04-23T12:00:00.000Z",
    });
    const terminalEnded = makeSession({
      id: "session-ended-terminal",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Ended terminal",
      toolType: "shell",
      status: "disposed",
      runtimeState: "exited",
    });

    renderPane({
      runningFiltered: [running],
      endedFiltered: [archivable, restorable, terminalEnded],
      selectedSessionIds: new Set([running.id, archivable.id, restorable.id, terminalEnded.id]),
      sessionsGroupedByLane: new Map([[running.laneId, [running, archivable, restorable, terminalEnded]]]),
      onBulkClose,
      onBulkDelete,
      onClearSelection,
    });

    expect(screen.getByText("4 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^archive \d+$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^restore \d+$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^export$/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /stop 1/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete 3/i }));
    fireEvent.click(screen.getByRole("button", { name: /clear selected sessions/i }));

    expect(onBulkClose).toHaveBeenCalledTimes(1);
    expect(onBulkDelete).toHaveBeenCalledTimes(1);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("offers stop & delete only when the selection includes a running runtime", () => {
    const onBulkStopAndDelete = vi.fn();
    const running = makeSession({
      id: "session-running",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Running shell",
      toolType: "shell",
      status: "running",
    });
    const chat = makeSession({
      id: "session-chat",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Active chat",
      toolType: "codex-chat",
      status: "running",
      ptyId: null,
    });

    renderPane({
      runningFiltered: [running, chat],
      selectedSessionIds: new Set([running.id, chat.id]),
      sessionsGroupedByLane: new Map([[running.laneId, [running, chat]]]),
      onBulkStopAndDelete,
    });

    // Mixed selection: the whole selection (both sessions) is targeted.
    const stopAndDelete = screen.getByRole("button", { name: /stop & delete 2/i });
    fireEvent.click(stopAndDelete);
    expect(onBulkStopAndDelete).toHaveBeenCalledTimes(1);
  });

  it("hides stop & delete when nothing in the selection needs stopping", () => {
    const endedShell = makeSession({
      id: "session-ended",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Ended shell",
      toolType: "shell",
      status: "disposed",
      runtimeState: "exited",
    });
    const chat = makeSession({
      id: "session-chat",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Active chat",
      toolType: "codex-chat",
      status: "running",
      ptyId: null,
    });

    renderPane({
      runningFiltered: [chat],
      endedFiltered: [endedShell],
      selectedSessionIds: new Set([endedShell.id, chat.id]),
      sessionsGroupedByLane: new Map([[chat.laneId, [chat, endedShell]]]),
      onBulkStopAndDelete: vi.fn(),
    });

    expect(screen.queryByRole("button", { name: /stop & delete/i })).toBeNull();
  });
});
