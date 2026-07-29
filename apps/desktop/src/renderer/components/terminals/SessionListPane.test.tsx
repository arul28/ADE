/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { createPendingLaneDeleteProgress } from "../../lib/laneDeleteProgress";
import { useAppStore, type CrossMachineMachineLanes } from "../../state/appStore";
import { resetCrossMachineLaneSyncForTest } from "../../state/crossMachineLanes";
import { SessionListPane } from "./SessionListPane";
import { ADE_WORK_LANE_DND_MIME } from "./workLaneOrder";
import { EMPTY_WORK_SESSION_FILTERS } from "./workSessionFilters";

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
        settledFiltered={[]}
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
    Reflect.deleteProperty(window, "ade");
  });

  it("renders a missing lane as an explicit orphaned-session group", () => {
    const onSelectSession = vi.fn();
    renderPane({ onSelectSession });

    expect(screen.getByRole("heading", {
      name: "Orphaned sessions: Mobile-created lane (1)",
    })).toBeTruthy();
    expect(screen.getByTestId("orphan-session-explanation").textContent).toContain(
      "will not delete sessions, Git branches, worktrees, commits, or pull requests",
    );
    expect((screen.getByRole("button", {
      name: "Refresh lane and session records for Mobile-created lane",
    }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Mobile Tool Streaming UI/ }));
    expect(onSelectSession).toHaveBeenCalledWith(
      "session-mobile",
      expect.anything(),
      ["session-mobile"],
    );
  });

  it("offers non-destructive reconciliation for an orphaned session group", () => {
    const ended = makeSession({
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-04-23T01:00:00.000Z",
      exitCode: 0,
    });
    const onRefreshOrphanSessions = vi.fn();
    renderPane({
      runningFiltered: [],
      endedFiltered: [ended],
      allSessionsUnfiltered: [ended],
      sessionsGroupedByLane: new Map([[ended.laneId, [ended]]]),
      onRefreshOrphanSessions,
    });

    fireEvent.click(screen.getByRole("button", {
      name: "Refresh lane and session records for Mobile-created lane",
    }));

    expect(onRefreshOrphanSessions).toHaveBeenCalledTimes(1);
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

    const view = renderPane({
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

  it("renders a Snoozed group above Settled in the by-status list, with each row's wake time", () => {
    const snoozed = makeSession({
      id: "session-snoozed",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Snoozed chat",
      snoozedUntil: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const settled = makeSession({
      id: "session-settled",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Settled chat",
      status: "completed",
      runtimeState: "exited",
      exitCode: 0,
      settledAt: new Date(Date.now() - 600_000).toISOString(),
    });

    renderPane({
      sessionListOrganization: "all-lanes-by-status",
      runningFiltered: [],
      settledFiltered: [settled],
      snoozedFiltered: [snoozed],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map(),
    });

    const snoozedHeading = screen.getByRole("heading", { name: "Snoozed (1)" });
    expect(snoozedHeading).toBeTruthy();
    expect(screen.getByText("Snoozed chat")).toBeTruthy();
    expect(screen.getByLabelText("Snoozed, wakes in 3h")).toBeTruthy();

    // Snoozed must sit ABOVE Settled in DOM order.
    const settledHeader = screen.getByText("Settled").closest("[data-section-id]");
    expect(snoozedHeading.compareDocumentPosition(settledHeader as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("offers a snooze duration menu from the row hover control", async () => {
    const snoozeSession = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { sessions: { snoozeSession } },
    });

    renderPane();

    fireEvent.click(screen.getAllByRole("button", { name: "Snooze session" })[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Until tomorrow 9am" }));

    await waitFor(() => expect(snoozeSession).toHaveBeenCalledTimes(1));
    const [sessionId, untilIso] = snoozeSession.mock.calls[0]!;
    expect(sessionId).toBe("session-mobile");
    expect(Date.parse(untilIso as string)).toBeGreaterThan(Date.now());
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
          status: "preparing-summary",
          createdAtMs: Date.now(),
        },
      ],
    });

    expect(screen.getByTestId("handoff-launch-placeholder")).toBeTruthy();
    expect(screen.getByText("Handoff to GPT-5.4-Mini")).toBeTruthy();
    expect(screen.getByText("Summarizing chat & creating handoff...")).toBeTruthy();
    expect(screen.getByText("First message: Chat handoff from previous session")).toBeTruthy();
  });

  it("hides an in-flight handoff when its running status is filtered out", () => {
    renderPane({
      workSessionFilters: { status: ["settled"], tool: [], hasPr: false, dirtyLane: false },
      setWorkSessionFilters: vi.fn(),
      handoffJobs: [
        {
          id: "handoff-job-filtered",
          sourceSessionId: "source-session",
          laneId: "lane-known",
          laneName: "Known Lane",
          targetModelId: "openai/gpt-5.4-mini",
          targetModelLabel: "GPT-5.4-Mini",
          targetToolType: "codex-chat",
          status: "preparing-summary",
          createdAtMs: Date.now(),
        },
      ],
    });

    expect(screen.queryByTestId("handoff-launch-placeholder")).toBeNull();
  });

  // ADE-122 regression: while a handoff RPC was in flight, the placeholder and
  // the real created session were both visible ("two new sessions", one
  // vanishing later). Once a matching real row exists, the placeholder must go.
  it("hides a handoff placeholder once the matching real session row is visible", () => {
    const jobCreatedAtMs = Date.parse("2026-07-17T12:00:00.000Z");
    const materialized = makeSession({
      id: "session-handoff-target",
      laneId: "lane-known",
      laneName: "Known Lane",
      toolType: "codex-chat",
      startedAt: "2026-07-17T12:00:05.000Z",
    });
    renderPane({
      runningFiltered: [materialized],
      allSessionsUnfiltered: [materialized],
      sessionsGroupedByLane: new Map([[materialized.laneId, [materialized]]]),
      handoffJobs: [
        {
          id: "handoff-job-2",
          sourceSessionId: "source-session",
          laneId: "lane-known",
          laneName: "Known Lane",
          targetModelId: "openai/gpt-5.4-mini",
          targetModelLabel: "GPT-5.4-Mini",
          targetToolType: "codex-chat",
          status: "preparing-summary",
          createdAtMs: jobCreatedAtMs,
        },
      ],
    });

    expect(screen.queryByTestId("handoff-launch-placeholder")).toBeNull();
  });

  it("lets the user set the group organization from the filter panel", () => {
    const setSessionListOrganization = vi.fn();
    const view = renderPane({ setSessionListOrganization });
    const filterButton = view.container.querySelector('button[data-tour="work.laneFilter"]');
    expect(filterButton).toBeTruthy();

    fireEvent.click(filterButton!);
    fireEvent.click(within(view.container).getByRole("button", { name: "Time" }));

    expect(setSessionListOrganization).toHaveBeenCalledWith("by-time");
    expect(screen.queryByText("Tiers")).toBeNull();
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
          settledFiltered={[]}
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
      // Second line comes from summary/statusNote now — the raw output tail is
      // a sensor, not a rendered row.
      summary: "Ran the latest command",
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

  it("excludes collapsed settled lane tails from range selection until expanded", () => {
    const onSelectSession = vi.fn();
    const active = makeSession({
      id: "session-active-tail",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Active lane work",
    });
    const settled = makeSession({
      id: "session-settled-tail",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });
    const paneProps = {
      runningFiltered: [active],
      settledFiltered: [settled],
      allSessionsUnfiltered: [active, settled],
      sessionsGroupedByLane: new Map([[active.laneId, [active, settled]]]),
      onSelectSession,
    };

    const collapsed = renderPane({
      ...paneProps,
      workCollapsedSectionIds: [],
    });

    fireEvent.click(screen.getByText("Active lane work"), { shiftKey: true });
    expect(onSelectSession).toHaveBeenLastCalledWith(
      active.id,
      expect.objectContaining({ shiftKey: true }),
      [active.id],
    );

    collapsed.unmount();
    onSelectSession.mockClear();
    renderPane({
      ...paneProps,
      workCollapsedSectionIds: ["settled-open:lane-known"],
    });

    expect(screen.getByRole("button", { name: /1 settled/i }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByText("Active lane work"), { shiftKey: true });
    expect(onSelectSession).toHaveBeenLastCalledWith(
      active.id,
      expect.objectContaining({ shiftKey: true }),
      [active.id, settled.id],
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

  it("renders a settled session in the Settled section", () => {
    const settled = makeSession({
      id: "session-settled",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Prepared release checklist",
      manuallyNamed: true,
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    renderPane({
      runningFiltered: [],
      settledFiltered: [settled],
      allSessionsUnfiltered: [settled],
      sessionListOrganization: "all-lanes-by-status",
      sessionsGroupedByLane: new Map([[settled.laneId, [settled]]]),
    });

    expect(screen.getByText("Settled")).toBeTruthy();
    expect(screen.getByText("Prepared release checklist")).toBeTruthy();
  });

  it("keeps settled lane tails reachable but collapsed by default", () => {
    // The lane keeps one active session so it stays a normal lane: an all-quiet
    // lane collapses to the thin header instead and hides its tails entirely.
    const active = makeSession({
      id: "session-active-keeps-lane-loud",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Active lane work",
    });
    const settled = makeSession({
      id: "session-settled-tail",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    const toggleWorkSectionCollapsed = vi.fn();
    renderPane({
      runningFiltered: [active],
      settledFiltered: [settled],
      allSessionsUnfiltered: [active, settled],
      sessionsGroupedByLane: new Map([[settled.laneId, [active, settled]]]),
      toggleWorkSectionCollapsed,
    });

    const tailButton = screen.getByRole("button", { name: /1 settled/i });
    expect(tailButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Finished lane work")).toBeNull();

    fireEvent.click(tailButton);
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith("settled-open:lane-known");
  });

  it("collapses an all-quiet lane to the thin header with inline counts", () => {
    const snoozed = makeSession({
      id: "session-snoozed-quiet",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Snoozed lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const settled = makeSession({
      id: "session-settled-quiet",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    const toggleWorkSectionCollapsed = vi.fn();
    renderPane({
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed, settled]]]),
      toggleWorkSectionCollapsed,
    });

    const laneHeader = document.querySelector('[data-section-id="lane-known"]');
    expect(laneHeader?.getAttribute("data-lane-quiet")).toBe("true");
    // The quiet tails are gone: nothing but the one thin row.
    expect(screen.queryByRole("button", { name: /1 settled/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /1 snoozed/i })).toBeNull();
    expect(screen.queryByText("Finished lane work")).toBeNull();
    expect(screen.queryByText("Snoozed lane work")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Known Lane \(2 quiet\)/i }));
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith("lane-open:lane-known");
  });

  it("renders the full lane header once a quiet lane is explicitly expanded", () => {
    const settled = makeSession({
      id: "session-settled-expanded",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    renderPane({
      runningFiltered: [],
      settledFiltered: [settled],
      allSessionsUnfiltered: [settled],
      sessionsGroupedByLane: new Map([["lane-known", [settled]]]),
      workCollapsedSectionIds: ["lane-open:lane-known"],
    });

    const laneHeader = document.querySelector('[data-section-id="lane-known"]');
    expect(laneHeader?.getAttribute("data-lane-quiet")).toBeNull();
    expect(screen.getByRole("button", { name: /1 settled/i })).toBeTruthy();
  });

  it("does not treat a lane with an attention session as quiet", () => {
    // `isSessionFiledAsSnoozed` yields to needs_you upstream, so a lane holding
    // something that wants the user must never fold into the thin header.
    const awaiting = makeSession({
      id: "session-awaiting-quiet-check",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Needs your input",
    });
    const settled = makeSession({
      id: "session-settled-quiet-check",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    renderPane({
      runningFiltered: [],
      awaitingInputFiltered: [awaiting],
      settledFiltered: [settled],
      allSessionsUnfiltered: [awaiting, settled],
      sessionsGroupedByLane: new Map([["lane-known", [awaiting, settled]]]),
    });

    const laneHeader = document.querySelector('[data-section-id="lane-known"]');
    expect(laneHeader?.getAttribute("data-lane-quiet")).toBeNull();
    expect(screen.getByText("Needs your input")).toBeTruthy();
  });

  it("does not quiet a lane when search hides its needs-you session", () => {
    const hiddenNeedsYou = makeSession({
      id: "session-hidden-needs-you",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Hidden approval",
      pendingInputItemId: "approval-1",
    });
    const visibleSettled = makeSession({
      id: "session-visible-settled",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Matching settled result",
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    renderPane({
      runningFiltered: [],
      settledFiltered: [visibleSettled],
      allSessionsUnfiltered: [hiddenNeedsYou, visibleSettled],
      q: "matching",
      sessionsGroupedByLane: new Map([["lane-known", [visibleSettled]]]),
    });

    const laneHeader = document.querySelector('[data-section-id="lane-known"]');
    expect(laneHeader?.getAttribute("data-lane-quiet")).toBeNull();
    expect(screen.getByRole("button", { name: /1 settled/i })).toBeTruthy();
    expect(screen.queryByText("Hidden approval")).toBeNull();
  });

  it("removes a stale quiet-open marker without claiming a user section toggle", async () => {
    const active = makeSession({
      id: "session-active-after-quiet",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Work resumed",
    });
    const toggleWorkSectionCollapsed = vi.fn();

    renderPane({
      runningFiltered: [active],
      allSessionsUnfiltered: [active],
      workCollapsedSectionIds: ["lane-open:lane-known"],
      sessionsGroupedByLane: new Map([["lane-known", [active]]]),
      toggleWorkSectionCollapsed,
    });

    await waitFor(() => {
      expect(toggleWorkSectionCollapsed).toHaveBeenCalledTimes(1);
    });
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith(
      "lane-open:lane-known",
      { preserveDeeplink: true },
    );
    expect(screen.getByText("Work resumed")).toBeTruthy();
  });

  it("bulk settles selected sessions through the preload surface", async () => {
    const settleMany = vi.fn().mockResolvedValue(["session-ended"]);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        sessions: {
          settleMany,
          unsettleMany: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const ended = makeSession({
      id: "session-ended",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Ended chat",
      status: "disposed",
      runtimeState: "exited",
    });

    renderPane({
      runningFiltered: [],
      endedFiltered: [ended],
      allSessionsUnfiltered: [ended],
      selectedSessionIds: new Set([ended.id]),
      sessionsGroupedByLane: new Map([[ended.laneId, [ended]]]),
    });

    fireEvent.click(screen.getByRole("button", { name: "Settle 1" }));

    await waitFor(() => expect(settleMany).toHaveBeenCalledWith(["session-ended"]));
    expect(screen.getByText("Settled 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("excludes loud Needs-you sessions from selected bulk settle", async () => {
    const settleMany = vi.fn().mockResolvedValue(["session-ended"]);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        sessions: {
          settleMany,
          unsettleMany: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const loud = makeSession({
      id: "session-loud",
      runtimeState: "waiting-input",
      pendingInputItemId: "pending-1",
    });
    const ended = makeSession({
      id: "session-ended",
      status: "disposed",
      runtimeState: "exited",
    });

    renderPane({
      runningFiltered: [],
      awaitingInputFiltered: [loud],
      endedFiltered: [ended],
      allSessionsUnfiltered: [loud, ended],
      selectedSessionIds: new Set([loud.id, ended.id]),
      sessionsGroupedByLane: new Map([["lane-mobile", [loud, ended]]]),
    });

    fireEvent.click(screen.getByRole("button", { name: "Settle 1" }));
    await waitFor(() => expect(settleMany).toHaveBeenCalledWith(["session-ended"]));
  });

  it("Settle all in Your move settles only quiet Ready sessions", async () => {
    const settleMany = vi.fn().mockResolvedValue(["session-ready"]);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        sessions: {
          settleMany,
          unsettleMany: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const loud = makeSession({
      id: "session-loud",
      runtimeState: "waiting-input",
      pendingInputItemId: "pending-1",
    });
    const quiet = makeSession({
      id: "session-ready",
      runtimeState: "idle",
      pendingInputItemId: null,
    });

    renderPane({
      runningFiltered: [],
      awaitingInputFiltered: [loud, quiet],
      allSessionsUnfiltered: [loud, quiet],
      sessionListOrganization: "all-lanes-by-status",
      sessionsGroupedByLane: new Map([["lane-mobile", [loud, quiet]]]),
    });

    fireEvent.click(screen.getByRole("button", { name: "Settle all" }));
    await waitFor(() => expect(settleMany).toHaveBeenCalledWith(["session-ready"]));
  });

  describe("cross-machine union", () => {
    afterEach(() => {
      useAppStore.setState({ crossMachineLanesByMachineId: {}, crossMachineLaneScopeKey: null });
      resetCrossMachineLaneSyncForTest();
    });

    function seedForeignMachine(overrides: Partial<CrossMachineMachineLanes> = {}) {
      useAppStore.setState({
        crossMachineLanesByMachineId: {
          "target-studio": {
            machineId: "target-studio",
            machineName: "Mac Studio (12)",
            targetId: "target-studio",
            projectId: "project-a",
            binding: {
              kind: "remote",
              key: "remote:target-studio:project-a",
              targetId: "target-studio",
              runtimeName: "Mac Studio (12)",
              projectId: "project-a",
              rootPath: "/repo-a",
              displayName: "Repo A",
            },
            online: true,
            lanes: [makeLane({ id: "lane-elsewhere", name: "Elsewhere Lane", branchRef: "feature/elsewhere" })],
            sessions: [
              makeSession({
                id: "session-elsewhere",
                laneId: "lane-elsewhere",
                laneName: "Elsewhere Lane",
                title: "Chat on the other machine",
              }),
            ],
            lastSyncedAtMs: 1,
            error: null,
            ...overrides,
          },
        },
      });
    }

    it("marks only lanes that are not on this machine", () => {
      seedForeignMachine();
      const onSelectSession = vi.fn();
      renderPane({ onSelectSession });

      expect(screen.getByText("Elsewhere Lane")).toBeTruthy();
      expect(screen.getByText("Chat on the other machine")).toBeTruthy();
      expect(document.querySelector('[data-session-id="session-elsewhere"]')).toBeTruthy();

      // One marker, on the foreign lane only — the local lanes stay untouched.
      const markers = document.querySelectorAll("[data-machine-marker-mode]");
      expect(markers).toHaveLength(1);
      const foreignHeader = screen.getByText("Elsewhere Lane").closest(".ade-lane-group-header");
      expect(foreignHeader?.querySelector("[data-machine-marker-mode]")).toBeTruthy();
      const localHeader = screen.getByRole("heading", {
        name: "Orphaned sessions: Mobile-created lane (1)",
      });
      expect(localHeader?.querySelector("[data-machine-marker-mode]")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Chat on the other machine/ }));
      expect(onSelectSession).toHaveBeenCalledWith(
        "session-elsewhere",
        expect.anything(),
        ["session-elsewhere"],
        expect.objectContaining({
          targetId: "target-studio",
          projectId: "project-a",
        }),
      );
    });

    it("applies tool chips to foreign sessions", () => {
      seedForeignMachine();

      renderPane({
        workSessionFilters: { status: [], tool: ["claude"], hasPr: false, dirtyLane: false },
        setWorkSessionFilters: vi.fn(),
      });

      expect(screen.queryByText("Elsewhere Lane")).toBeNull();
      expect(screen.queryByText("Chat on the other machine")).toBeNull();
    });

    it("files settled foreign chats into the same collapsed quiet tail as local chats", () => {
      const active = makeSession({
        id: "session-foreign-active",
        laneId: "lane-elsewhere",
        laneName: "Elsewhere Lane",
        title: "Active foreign chat",
      });
      const settled = makeSession({
        id: "session-foreign-settled",
        laneId: "lane-elsewhere",
        laneName: "Elsewhere Lane",
        title: "Settled foreign chat",
        status: "completed",
        runtimeState: "idle",
        endedAt: "2026-07-28T12:10:00.000Z",
        exitCode: 0,
        settledAt: "2026-07-28T12:11:00.000Z",
        statusNote: "Removed and verified all identified artifacts.",
      });
      seedForeignMachine({ sessions: [active, settled] });

      renderPane();

      expect(screen.getByText("Active foreign chat")).toBeTruthy();
      expect(screen.queryByText("Settled foreign chat")).toBeNull();
      const settledTail = screen.getByRole("button", { name: /1 settled/i });
      expect(settledTail.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[data-session-id="session-foreign-settled"]')).toBeNull();
    });

    it("clears a foreign quiet-lane expansion marker when active work returns", async () => {
      seedForeignMachine();
      const toggleWorkSectionCollapsed = vi.fn();

      renderPane({
        workCollapsedSectionIds: ["lane-open:target-studio:lane-elsewhere"],
        toggleWorkSectionCollapsed,
      });

      await waitFor(() => {
        expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith(
          "lane-open:target-studio:lane-elsewhere",
          { preserveDeeplink: true },
        );
      });
    });

    it("routes a foreign card's context menu through its owning binding", () => {
      seedForeignMachine();
      const onContextMenu = vi.fn();
      renderPane({ onContextMenu });

      const card = document.querySelector(
        '[data-session-id="session-elsewhere"]',
      )!;
      fireEvent.contextMenu(card);

      expect(onContextMenu).toHaveBeenCalledWith(
        expect.objectContaining({ id: "session-elsewhere" }),
        expect.anything(),
        expect.objectContaining({
          targetId: "target-studio",
          projectId: "project-a",
        }),
        "Mac Studio (12)",
      );
    });

    it("offers lane actions from a foreign lane header", () => {
      seedForeignMachine();
      renderPane();

      const header = screen.getByText("Elsewhere Lane").closest(
        ".ade-lane-group-header",
      )!;
      fireEvent.contextMenu(header);

      expect(screen.getByRole("menuitem", { name: "Start chat in lane" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Manage lane" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Open in Lanes" })).toBeTruthy();
    });

    it("routes foreign shell rows through the owning-runtime selector", () => {
      seedForeignMachine({
        sessions: [
          makeSession({
            id: "shell-elsewhere",
            laneId: "lane-elsewhere",
            title: "Shell on the other machine",
            toolType: "shell",
          }),
        ],
      });
      const onSelectSession = vi.fn();
      const onSelectForeignRuntimeSession = vi.fn();
      renderPane({ onSelectSession, onSelectForeignRuntimeSession });

      fireEvent.click(screen.getByRole("button", { name: /Shell on the other machine/ }));

      expect(onSelectSession).not.toHaveBeenCalled();
      expect(onSelectForeignRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: "shell-elsewhere" }),
        expect.objectContaining({
          targetId: "target-studio",
          projectId: "project-a",
        }),
        expect.anything(),
        ["shell-elsewhere"],
      );
    });

    it("shows a hover label for one online foreign machine and the name when it drops", async () => {
      seedForeignMachine();
      const view = renderPane();
      const marker = document.querySelector("[data-machine-marker-mode]")!;
      expect(marker.getAttribute("data-machine-marker-mode")).toBe("glyph");
      expect(screen.queryByText("Mac Studio (12)")).toBeNull();
      fireEvent.mouseEnter(marker.parentElement!);
      expect((await screen.findByRole("tooltip")).textContent).toContain("Mac Studio (12)");
      view.unmount();

      seedForeignMachine({ online: false });
      renderPane();
      // Offline: lanes REMAIN, dimmed, and the machine is named outright.
      expect(screen.getByText("Elsewhere Lane")).toBeTruthy();
      expect(document.querySelector("[data-machine-marker-mode]")?.getAttribute("data-machine-marker-mode"))
        .toBe("name");
      expect(screen.getByText("Mac Studio (12)")).toBeTruthy();
      expect((screen.getByRole("button", { name: /Chat on the other machine/ }) as HTMLButtonElement).disabled)
        .toBe(true);
      expect(screen.getByText("Elsewhere Lane").closest(".ade-lane-group-header")?.parentElement?.className)
        .toContain("opacity");
    });
  });

  it("hides Your move bulk settle when every session needs input", () => {
    const loud = makeSession({
      id: "session-loud",
      runtimeState: "waiting-input",
      pendingInputItemId: "pending-1",
    });

    renderPane({
      runningFiltered: [],
      awaitingInputFiltered: [loud],
      allSessionsUnfiltered: [loud],
      sessionListOrganization: "all-lanes-by-status",
      sessionsGroupedByLane: new Map([["lane-mobile", [loud]]]),
    });

    expect(screen.queryByRole("button", { name: "Settle all" })).toBeNull();
  });
});

describe("SessionListPane lane ordering, pins, chips and drag", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "ade");
  });

  const activeLane = makeLane({ id: "lane-active", name: "Active lane" });
  const quietLane = makeLane({ id: "lane-quiet", name: "Quiet lane" });
  const activeSession = makeSession({
    id: "s-active", laneId: "lane-active", laneName: "Active lane", title: "Working chat",
  });
  const settledSession = makeSession({
    id: "s-settled",
    laneId: "lane-quiet",
    laneName: "Quiet lane",
    title: "Finished chat",
    status: "completed",
    runtimeState: "idle",
    settledAt: "2026-04-22T22:20:00.000Z",
  });
  const secondActiveLane = makeLane({ id: "lane-active-two", name: "Second active lane" });
  const secondActiveSession = makeSession({
    id: "s-active-two", laneId: "lane-active-two", laneName: "Second active lane", title: "Second working chat",
  });

  function renderTwoLanes(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
    const sessions = [activeSession, settledSession];
    return renderPane({
      lanes: [activeLane, quietLane],
      runningFiltered: [activeSession],
      settledFiltered: [settledSession],
      allSessionsUnfiltered: sessions,
      sessionsGroupedByLane: new Map([
        ["lane-active", [activeSession]],
        ["lane-quiet", [settledSession]],
      ]),
      ...props,
    });
  }

  function renderTwoActiveLanes(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
    const sessions = [activeSession, secondActiveSession];
    return renderPane({
      lanes: [activeLane, secondActiveLane],
      runningFiltered: sessions,
      allSessionsUnfiltered: sessions,
      sessionsGroupedByLane: new Map([
        ["lane-active", [activeSession]],
        ["lane-active-two", [secondActiveSession]],
      ]),
      ...props,
    });
  }

  /**
   * jsdom returns an all-zero rect for every element, which would make the
   * midpoint 0 and every drop read as "after". Give lane headers a real box.
   */
  function stubLaneHeaderRect(): () => void {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function stub(this: HTMLElement) {
      if (this.hasAttribute("data-section-id")) {
        return { top: 100, bottom: 140, height: 40, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
      }
      return original.call(this);
    };
    return () => { HTMLElement.prototype.getBoundingClientRect = original; };
  }

  /**
   * jsdom implements no DragEvent, so fireEvent's init drops `clientY` and the
   * handler sees undefined. Dispatch a real MouseEvent with the drag type and
   * hang `dataTransfer` off it, which is what a browser delivers.
   */
  function fireLaneDrag(
    el: HTMLElement,
    type: "dragstart" | "dragover" | "drop" | "dragend",
    init: { clientY?: number; dataTransfer: unknown },
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY: init.clientY ?? 0,
    });
    Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer });
    fireEvent(el, event);
  }

  function laneOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-section-id]"))
      .map((el) => el.getAttribute("data-section-id") ?? "")
      .filter((id) => id.startsWith("lane-"));
  }

  it("sinks a fully settled lane below an active one", () => {
    const { container } = renderTwoLanes();
    expect(laneOrder(container)).toEqual(["lane-active", "lane-quiet"]);
  });

  it("pinning the settled lane lifts it back to the top at full height", () => {
    const { container } = renderTwoLanes({ workPinnedLaneIds: ["lane-quiet"] });
    expect(laneOrder(container)).toEqual(["lane-quiet", "lane-active"]);
    // A pinned lane opts out of the compact quiet treatment entirely, or it
    // would render as a shrunken dimmed row above full-height ones.
    const pinnedHeader = container.querySelector('[data-section-id="lane-quiet"]');
    expect(pinnedHeader?.getAttribute("data-lane-quiet")).toBeNull();
    expect(pinnedHeader?.className).toContain("h-8");
    expect(screen.getByLabelText("Pinned lane")).toBeTruthy();
  });

  it("shows a drop indicator on the half of the lane the pointer is over", () => {
    const { container } = renderTwoActiveLanes({ reorderWorkLanes: vi.fn() });
    const target = container.querySelector('[data-section-id="lane-active-two"]') as HTMLElement;
    const source = container.querySelector('[data-section-id="lane-active"]') as HTMLElement;
    // jsdom zeroes every rect, so the midpoint has to be supplied.
    const restoreRect = stubLaneHeaderRect();

    const dataTransfer = {
      types: [ADE_WORK_LANE_DND_MIME],
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(() => "lane-active"),
    };
    fireLaneDrag(source, "dragstart", { dataTransfer });
    fireLaneDrag(target, "dragover", { dataTransfer, clientY: 105 });
    expect(container.querySelector('[data-testid="lane-drop-indicator-before"]')).toBeTruthy();
    fireLaneDrag(target, "dragover", { dataTransfer, clientY: 135 });
    expect(container.querySelector('[data-testid="lane-drop-indicator-after"]')).toBeTruthy();
    restoreRect();
  });

  it("reorders on drop and ignores a drag that is not a lane", () => {
    const reorderWorkLanes = vi.fn();
    const { container } = renderTwoActiveLanes({ reorderWorkLanes });
    const target = container.querySelector('[data-section-id="lane-active-two"]') as HTMLElement;
    const source = container.querySelector('[data-section-id="lane-active"]') as HTMLElement;
    const restoreRect = stubLaneHeaderRect();

    // A session-card drag carries a different MIME and must light nothing up.
    const foreignTransfer = {
      types: ["application/x-ade-grid-session"],
      effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn(),
    };
    fireLaneDrag(target, "dragover", { dataTransfer: foreignTransfer, clientY: 105 });
    expect(container.querySelector('[data-testid^="lane-drop-indicator"]')).toBeNull();

    const dataTransfer = {
      types: [ADE_WORK_LANE_DND_MIME],
      effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn(() => "lane-active"),
    };
    fireLaneDrag(source, "dragstart", { dataTransfer });
    fireLaneDrag(target, "dragover", { dataTransfer, clientY: 135 });
    fireLaneDrag(target, "drop", { dataTransfer });

    expect(reorderWorkLanes).toHaveBeenCalledWith({
      movedLaneId: "lane-active",
      targetLaneId: "lane-active-two",
      edge: "after",
      renderedLaneIds: ["lane-active", "lane-active-two"],
    });
    restoreRect();
  });

  it("rejects a drop across pinned, active, and quiet filing tiers", () => {
    const reorderWorkLanes = vi.fn();
    const { container } = renderTwoLanes({ reorderWorkLanes });
    const target = container.querySelector('[data-section-id="lane-quiet"]') as HTMLElement;
    const source = container.querySelector('[data-section-id="lane-active"]') as HTMLElement;
    const restoreRect = stubLaneHeaderRect();
    const dataTransfer = {
      types: [ADE_WORK_LANE_DND_MIME],
      effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn(() => "lane-active"),
    };

    fireLaneDrag(source, "dragstart", { dataTransfer });
    fireLaneDrag(target, "dragover", { dataTransfer, clientY: 135 });
    expect(container.querySelector('[data-testid^="lane-drop-indicator"]')).toBeNull();
    fireLaneDrag(target, "drop", { dataTransfer });
    expect(reorderWorkLanes).not.toHaveBeenCalled();
    restoreRect();
  });

  it("keeps the collapse toggle working on a now-draggable lane header", () => {
    const toggleWorkLaneCollapsed = vi.fn();
    renderTwoLanes({ reorderWorkLanes: vi.fn(), toggleWorkLaneCollapsed });
    fireEvent.click(screen.getByText("Active lane"));
    expect(toggleWorkLaneCollapsed).toHaveBeenCalledWith("lane-active");
  });

  it("names the active chips and clears them from the filtered empty state", () => {
    const setWorkSessionFilters = vi.fn();
    renderPane({
      lanes: [activeLane],
      runningFiltered: [],
      settledFiltered: [],
      allSessionsUnfiltered: [],
      sessionsGroupedByLane: new Map(),
      workSessionFilters: { status: ["awaiting-input"], tool: ["claude"], hasPr: false, dirtyLane: false },
      setWorkSessionFilters,
    });

    expect(screen.getByText("No sessions match")).toBeTruthy();
    expect(screen.getByText("Your move · Claude")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear filters"));
    expect(setWorkSessionFilters).toHaveBeenCalledWith(EMPTY_WORK_SESSION_FILTERS);
  });

  it("marks the funnel as active when only chips are set", () => {
    renderTwoLanes({
      workSessionFilters: { status: ["running"], tool: [], hasPr: false, dirtyLane: false },
      setWorkSessionFilters: vi.fn(),
    });
    expect(screen.getByTestId("work-lane-filter-active-indicator")).toBeTruthy();
  });
});
