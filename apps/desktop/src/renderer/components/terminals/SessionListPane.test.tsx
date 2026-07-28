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
      runningFiltered: [],
      settledFiltered: [settled],
      allSessionsUnfiltered: [settled],
      sessionsGroupedByLane: new Map([[settled.laneId, [settled]]]),
      toggleWorkSectionCollapsed,
    });

    const tailButton = screen.getByRole("button", { name: /1 settled/i });
    expect(tailButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Finished lane work")).toBeNull();

    fireEvent.click(tailButton);
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith("settled-open:lane-known");
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
      const localHeader = screen.getByText("Mobile-created lane").closest(".ade-lane-group-header");
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
