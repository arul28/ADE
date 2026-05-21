/* @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
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
        loading={false}
        filterLaneId="all"
        setFilterLaneId={vi.fn()}
        filterStatus="all"
        setFilterStatus={vi.fn()}
        q=""
        setQ={vi.fn()}
        selectedSessionId={null}
        draftKind="chat"
        showingDraft={false}
        onShowDraftKind={vi.fn()}
        onSelectSession={vi.fn()}
        onInfoClick={vi.fn()}
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
  it("renders by-lane sessions whose lane is missing from the cached lane list", () => {
    renderPane();

    expect(screen.getByText("Mobile-created lane")).toBeTruthy();
    expect(screen.getByText("Mobile Tool Streaming UI")).toBeTruthy();
  });

  it("lets the user set the status filter from the filter panel", () => {
    const setFilterStatus = vi.fn();
    const view = renderPane({ setFilterStatus });
    const filterButton = view.container.querySelector('button[data-tour="work.laneFilter"]');
    expect(filterButton).toBeTruthy();

    fireEvent.click(filterButton!);
    fireEvent.click(within(view.container).getByRole("button", { name: "Running" }));

    expect(setFilterStatus).toHaveBeenCalledWith("running");
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

  it("marks old running CLI and shell sessions", () => {
    const staleSession = makeSession({
      id: "session-stale-shell",
      laneId: "lane-known",
      laneName: "Known Lane",
      toolType: "shell",
      title: "Old shell",
      startedAt: "2026-04-20T10:00:00.000Z",
      status: "running",
      runtimeState: "waiting-input",
    });
    renderPane({
      runningFiltered: [staleSession],
      sessionsGroupedByLane: new Map([[staleSession.laneId, [staleSession]]]),
    });

    expect(screen.getByLabelText("Old running session")).toBeTruthy();
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
});
