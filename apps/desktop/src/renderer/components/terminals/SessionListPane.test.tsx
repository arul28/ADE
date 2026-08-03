/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, PrSummary, TerminalSessionSummary } from "../../../shared/types";
import { createPendingLaneDeleteProgress } from "../../lib/laneDeleteProgress";
import { eventMatchesBinding } from "../../lib/keybindings";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { useAppStore, type CrossMachineMachineLanes } from "../../state/appStore";
import { resetCrossMachineLaneSyncForTest } from "../../state/crossMachineLanes";
import { setLaneNaming } from "../../state/laneNamingStore";
import { SessionListPane } from "./SessionListPane";
import { laneBoundMachineKey, lanePrCompositeKey } from "./useLanePrs";
import { ADE_WORK_LANE_DND_MIME } from "./workLaneOrder";
import { EMPTY_WORK_SESSION_FILTERS } from "./workSessionFilters";

vi.mock("./useSessionDelta", () => ({
  useSessionDelta: () => null,
}));

vi.mock("./ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));

// A pass-through recorder, not a stub: every existing test still renders the
// real card (and queries its real text), while the prop-contract tests below can
// read what this pane actually handed each row.
const { sessionCardPropsForTest } = vi.hoisted(() => ({
  sessionCardPropsForTest: [] as Record<string, unknown>[],
}));
vi.mock("./SessionCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SessionCard")>();
  return {
    ...actual,
    SessionCard: (props: ComponentProps<typeof actual.SessionCard>) => {
      sessionCardPropsForTest.push(props as unknown as Record<string, unknown>);
      return <actual.SessionCard {...props} />;
    },
  };
});

/** Props the pane passed for one session id in the most recent render pass. */
function cardPropsFor(sessionId: string): Record<string, unknown> | undefined {
  return sessionCardPropsForTest.find(
    (props) => (props.session as TerminalSessionSummary | undefined)?.id === sessionId,
  );
}

// The lane-PR hook does its own coalesced IPC read; the header badge only cares
// about the map it returns, so tests seed that map directly.
const { lanePrsByLaneIdForTest } = vi.hoisted(() => ({
  lanePrsByLaneIdForTest: new Map<string, unknown[]>(),
}));
// Only the hook is stubbed; the key/accessor helpers stay REAL so the test seeds
// its map with the same key discipline the component reads it back with.
vi.mock("./useLanePrs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useLanePrs")>()),
  useLanePrsByLaneId: () => lanePrsByLaneIdForTest,
}));

function makePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-known",
    projectId: "project-a",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: 959,
    githubUrl: "https://github.com/acme/ade/pull/959",
    githubNodeId: null,
    title: "Refine the Work sidebar",
    state: "open",
    baseBranch: "main",
    headBranch: "known-lane",
    checksStatus: "pending",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  };
}

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

/** The one shared header shape: sticky wrapper + the hairline row inside it. */
function headerRow(sectionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-section-id="${sectionId}"] > div`,
  );
}

/**
 * The quiet shelves default to CLOSED, and record only the explicit expand, so
 * a test that wants to look inside one has to open it the way a user does —
 * `shelf-open:<sectionId>`, not the absence of a collapse entry.
 */
const OPEN_QUIET_SHELVES = [
  "shelf-open:status:snoozed",
  "shelf-open:status:settled",
  "shelf-open:lane-shelf:snoozed",
  "shelf-open:lane-shelf:settled",
];

/** The chevron at the right end of a group header — same toggle as its label. */
function headerChevron(sectionId: string): HTMLElement {
  return screen.getByTestId(`section-chevron-${sectionId}`);
}

describe("SessionListPane", () => {
  afterEach(() => {
    cleanup();
    lanePrsByLaneIdForTest.clear();
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
    // Two rows, so the lane keeps a header to disable: a singleton lane renders
    // its group without one.
    const sibling = makeSession({
      id: "session-sibling",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Sibling chat",
    });
    useAppStore.setState({
      laneDeleteProgressByLaneId: {
        "lane-known": createPendingLaneDeleteProgress("lane-known"),
      },
    });

    renderPane({
      runningFiltered: [session, sibling],
      allSessionsUnfiltered: [session, sibling],
      sessionsGroupedByLane: new Map([[session.laneId, [session, sibling]]]),
      onSelectSession,
    });

    const chatButton = screen.getByRole("button", { name: "Deleting lane chat: Deleting lane" });
    const laneHeaderButton = screen.getByText("Known Lane").closest("button");
    // The card is a `div role="button"`, so it reports inertness with
    // `aria-disabled`; the header's collapse toggle is a real button.
    expect(chatButton.getAttribute("aria-disabled")).toBe("true");
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
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
    });

    const snoozedHeading = screen.getByRole("heading", { name: "Snoozed (1)" });
    expect(snoozedHeading).toBeTruthy();
    expect(screen.getByText("Snoozed chat")).toBeTruthy();
    // The return ticket IS the status now — no separate snoozed chip.
    expect(document.querySelector('[data-session-status="wakes in 3h"]')).toBeTruthy();

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
    // Matched on the label alone: the row's trailing time column is formatted
    // via `toLocaleTimeString`, so an exact accessible name would be brittle.
    fireEvent.click(screen.getByRole("menuitem", { name: /^Tomorrow/ }));

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

  it("weights only the session name in sidebar cards", () => {
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
    // The row is a `div role="button"`: it hosts the in-flow snooze/settle
    // buttons, which cannot legally nest inside a native <button>.
    const row = title.closest('[role="button"]');
    expect(row).toBeTruthy();

    // One weight step between the name and everything under it — the name is
    // the only medium-weight text in the row.
    expect(title.className).toContain("font-medium");
    expect(within(row as HTMLElement).getByText("Ran the latest command").className)
      .not.toContain("font-medium");
  });

  // The long-silent shell used to be marked here with an amber "Idle session"
  // warning glyph. That glyph is gone — amber is now exclusively "your move",
  // and the canonical `stale` phase tells the story through the status label.
  // Its presentation is asserted in SessionCard.test.tsx, where the label lives.

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
    const selectionToolbar = screen.getByTestId("work-session-selection-toolbar");
    expect(selectionToolbar.className).toContain("border-t");
    expect(selectionToolbar.className).not.toContain("ade-chat-drawer-glass");
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
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
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
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
      toggleWorkSectionCollapsed,
    });

    const laneHeader = document.querySelector('[data-section-id="lane-known"]');
    expect(laneHeader?.getAttribute("data-lane-quiet")).toBe("true");
    expect(within(laneHeader as HTMLElement).getByText("Known Lane (2)")).toBeTruthy();
    // The quiet tails are gone: nothing but the one thin row.
    expect(screen.queryByRole("button", { name: /1 settled/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /1 snoozed/i })).toBeNull();
    expect(screen.queryByText("Finished lane work")).toBeNull();
    expect(screen.queryByText("Snoozed lane work")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Known Lane \(2 quiet\)/i }));
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith("lane-open:lane-known");
  });

  it("renders the full lane header once a quiet lane is explicitly expanded", () => {
    const snoozed = makeSession({
      id: "session-snoozed-expanded",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Snoozed lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const settled = makeSession({
      id: "session-settled-expanded",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished lane work",
      manuallyNamed: true,
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    const { container } = renderPane({
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed, settled]]]),
      workCollapsedSectionIds: [...OPEN_QUIET_SHELVES, "lane-open:lane-known"],
    });
    expect(screen.getByText("Known Lane")).toBeTruthy();
    expect(screen.queryByText("Known Lane (2)")).toBeNull();

    const laneHeader = document.querySelector('[data-section-id="lane-known"]');
    expect(laneHeader?.getAttribute("data-lane-quiet")).toBeNull();
    // One snoozed, one settled: fully quiet, so the lane is filed by the
    // dominant kind (a tie goes to Snoozed) and expanding it reaches BOTH rows
    // directly — the shelf above already states the tier, so there is no
    // in-lane subsection left to open.
    expect(container.querySelector('[data-section-id="lane-shelf:snoozed"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: /\d+ (settled|snoozed)/i })).toBeNull();
    const body = container.querySelector('[data-lane-group-body="lane-known"]')!;
    // By id, not title: "Finished lane work" is a low-signal label upstream, so
    // the settled row renders under its tool's default name.
    for (const id of ["session-snoozed-expanded", "session-settled-expanded"]) {
      expect(body.querySelector(`[data-session-id="${id}"]`)).toBeTruthy();
    }
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
      useAppStore.setState({
        crossMachineLanesByMachineId: {},
        crossMachineLaneScopeKey: null,
        projectBinding: null,
      });
      resetCrossMachineLaneSyncForTest();
    });

    /**
     * The reported bug, end to end.
     *
     * Sitting at the MacBook with the project tab bound to the Mac Studio and no
     * other machine contributing rows, NOTHING in the sidebar was badged — the
     * Studio's lanes least of all, even though every one of them was somewhere
     * else. The union computed their markers correctly and then discarded the
     * whole map, because it bailed on "no rows outside the active binding"
     * rather than "no rows outside this machine".
     */
    it("badges the tab's own lanes when the tab is bound to another machine", () => {
      useAppStore.setState({
        projectBinding: {
          kind: "remote",
          key: "remote:target-studio:project-a",
          targetId: "target-studio",
          runtimeName: "Mac Studio (12)",
          projectId: "project-a",
          rootPath: "/repo-a",
          displayName: "Repo A",
        },
        // Deliberately empty: the Studio IS the tab's binding, so it contributes
        // no union row. This is exactly the configuration that used to blank
        // every badge.
        crossMachineLanesByMachineId: {},
        // The union reads the tab's lanes from the STORE, not from the pane's
        // props — that slice is what the binding attributes to its machine.
        lanes: [makeLane({ id: "lane-studio", name: "Studio Lane" })],
      });
      const studioLane = makeLane({ id: "lane-studio", name: "Studio Lane" });
      const first = makeSession({
        id: "session-studio-a", laneId: "lane-studio", laneName: "Studio Lane", title: "First",
      });
      const second = makeSession({
        id: "session-studio-b", laneId: "lane-studio", laneName: "Studio Lane", title: "Second",
      });

      const { container } = renderPane({
        lanes: [studioLane],
        runningFiltered: [first, second],
        allSessionsUnfiltered: [first, second],
        sessionsGroupedByLane: new Map([["lane-studio", [first, second]]]),
      });

      const header = container.querySelector('[data-section-id="lane-studio"]')!;
      const marker = header.querySelector("[data-machine-marker-mode]");
      expect(marker).toBeTruthy();
      expect(marker?.getAttribute("data-machine-marker-mode")).toBe("glyph");
      expect(marker?.getAttribute("aria-label")).toBe("Mac Studio (12)");
      // Named on the header, so the rows below it do not repeat it.
      expect(cardPropsFor("session-studio-a")?.suppressMachineChip).toBe(true);
    });

    it("badges a one-chat lane on the bound machine through its card", () => {
      // Same bug, singleton shape — an auto-created lane with a single chat,
      // which is the common way work starts. It has no header to hang a badge
      // on, and the card's own chip was fed only by foreign rows, so this case
      // stayed blank even once the union kept its markers.
      useAppStore.setState({
        projectBinding: {
          kind: "remote",
          key: "remote:target-studio:project-a",
          targetId: "target-studio",
          runtimeName: "Mac Studio (12)",
          projectId: "project-a",
          rootPath: "/repo-a",
          displayName: "Repo A",
        },
        crossMachineLanesByMachineId: {},
        lanes: [makeLane({ id: "lane-solo", name: "Solo Lane" })],
      });
      const studioLane = makeLane({ id: "lane-solo", name: "Solo Lane" });
      const only = makeSession({
        id: "session-solo", laneId: "lane-solo", laneName: "Solo Lane", title: "Only chat",
      });

      const { container } = renderPane({
        lanes: [studioLane],
        runningFiltered: [only],
        allSessionsUnfiltered: [only],
        sessionsGroupedByLane: new Map([["lane-solo", [only]]]),
      });

      expect(container.querySelector('[data-section-id="lane-solo"]')).toBeNull();
      const badge = container.querySelector(
        '[data-session-id="session-solo"] [data-machine-marker-mode]',
      );
      expect(badge?.getAttribute("data-session-machine")).toBe("Mac Studio (12)");
      expect(badge?.getAttribute("aria-label")).toBe("On Mac Studio (12)");
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
            prs: [],
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

      // One marker, for the foreign lane only — the local lanes stay untouched.
      // The foreign lane has a single chat, so it renders headerless and its
      // card IS the header: the badge lives there, under the same attribute a
      // lane header would use.
      const markers = document.querySelectorAll("[data-machine-marker-mode]");
      expect(markers).toHaveLength(1);
      const foreignCard = document.querySelector('[data-session-id="session-elsewhere"]');
      expect(foreignCard?.querySelector("[data-machine-marker-mode]")).toBeTruthy();
      expect(foreignCard?.querySelector("[data-session-machine]")?.getAttribute("data-session-machine"))
        .toBe("Mac Studio (12)");
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

    /**
     * One session, one row — and the survivor is the LOCAL record. Only the DOM
     * can prove the second half: the local path calls `onSelectSession` with
     * three arguments, the foreign chat path adds a fourth binding, so the
     * arity pins which copy survived. Builder-level coverage lives in
     * `crossMachineLanes.test.ts`.
     */
    it("renders one row when a session id is in both the local roster and the union", () => {
      seedForeignMachine();
      const shared = makeSession({
        id: "session-elsewhere",
        laneId: "lane-elsewhere",
        laneName: "Elsewhere Lane",
        title: "Chat on the other machine",
      });
      const onSelectSession = vi.fn();
      renderPane({
        onSelectSession,
        lanes: [makeLane({ id: "lane-elsewhere", name: "Elsewhere Lane" })],
        runningFiltered: [shared],
        allSessionsUnfiltered: [shared],
        sessionsGroupedByLane: new Map([["lane-elsewhere", [shared]]]),
      });

      expect(document.querySelectorAll('[data-session-id="session-elsewhere"]')).toHaveLength(1);
      expect(screen.getAllByText("Chat on the other machine")).toHaveLength(1);

      // The surviving row is the LOCAL one: clicking it opens on the tab's own
      // binding, with no foreign runtime pin trailing the call.
      fireEvent.click(screen.getByRole("button", { name: /Chat on the other machine/ }));
      expect(onSelectSession).toHaveBeenCalledWith(
        "session-elsewhere",
        expect.anything(),
        ["session-elsewhere"],
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
        // This foreign lane holds one chat, so it renders headerless and the
        // divider that used to own the lane menu is gone. The card carries the
        // lane actions instead — the same rescue a local singleton gets.
        expect.objectContaining({
          laneId: "lane-elsewhere",
          laneName: "Elsewhere Lane",
        }),
      );
    });

    // The bug: a foreign row's PR was looked up against the machine the project
    // TAB is bound to, so a session doing work on another machine showed no PR
    // badge until you switched the global machine selector to that machine.
    it("renders a foreign lane's PR badge from its own machine's answer", () => {
      seedForeignMachine();
      lanePrsByLaneIdForTest.set(
        lanePrCompositeKey("target-studio", "lane-elsewhere"),
        [makePr({ laneId: "lane-elsewhere", githubPrNumber: 91, headBranch: "feature/elsewhere" })],
      );
      renderPane();

      expect(screen.getByText("#91")).toBeTruthy();
    });

    // The other half of the same bug: the bound machine's rows must not answer
    // for a foreign lane either. Cross-machine handoff copies a lane id, so a
    // bare-lane-id lookup would render the wrong machine's PR here.
    it("does not borrow the bound machine's PR for a foreign lane", () => {
      seedForeignMachine();
      lanePrsByLaneIdForTest.set(
        laneBoundMachineKey("lane-elsewhere"),
        [makePr({ laneId: "lane-elsewhere", githubPrNumber: 77, headBranch: "feature/elsewhere" })],
      );
      renderPane();

      expect(screen.queryByText("#77")).toBeNull();
    });

    it("keeps a foreign lane's divider, and its menu, once it holds two chats", () => {
      seedForeignMachine({
        sessions: [
          makeSession({ id: "session-elsewhere", laneId: "lane-elsewhere", laneName: "Elsewhere Lane" }),
          makeSession({ id: "session-elsewhere-2", laneId: "lane-elsewhere", laneName: "Elsewhere Lane" }),
        ],
      });
      renderPane();

      const header = screen.getByText("Elsewhere Lane").closest(
        ".ade-lane-group-header",
      )!;
      fireEvent.contextMenu(header);

      expect(screen.getByRole("menuitem", { name: "Start chat in lane" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Manage lane" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Open in Lanes" })).toBeTruthy();
    });

    it("keeps a foreign parent and child roster under its lane header", () => {
      const parent = makeSession({
        id: "foreign-chat-parent",
        laneId: "lane-elsewhere",
        laneName: "Elsewhere Lane",
        title: "Foreign parent chat",
      });
      const child = makeSession({
        id: "foreign-child-shell",
        laneId: "lane-elsewhere",
        laneName: "Elsewhere Lane",
        title: "Foreign child shell",
        toolType: "shell",
        ptyId: "foreign-child-pty",
        chatSessionId: parent.id,
      });
      seedForeignMachine({ sessions: [parent, child] });

      const { container } = renderPane();

      // Foreign cards do not yet share the local parent/child nesting renderer,
      // so this two-card roster must retain its group header rather than using
      // singleton card decorations for both rows.
      const header = container.querySelector('[data-section-id="target-studio:lane-elsewhere"]');
      expect(header).toBeTruthy();
      expect(header?.querySelector("[data-machine-marker-mode]")).toBeTruthy();
      expect(screen.getByText("Foreign parent chat")).toBeTruthy();
      expect(screen.getByText("Foreign child shell")).toBeTruthy();
      expect(cardPropsFor(parent.id)?.suppressMachineChip).toBe(true);
      expect(cardPropsFor(child.id)?.suppressMachineChip).toBe(true);
      expect(cardPropsFor(child.id)?.laneActions).toBeUndefined();
    });

    it("reaches a headerless foreign lane's menu through its card", () => {
      seedForeignMachine();
      const onContextMenu = vi.fn();
      renderPane({ onContextMenu });

      fireEvent.contextMenu(document.querySelector('[data-session-id="session-elsewhere"]')!);
      const laneActions = onContextMenu.mock.calls[0]![4] as {
        open: (at: { x: number; y: number }) => void;
      };
      // Routed through the FOREIGN lane menu, so its actions stay bound to the
      // machine that owns the lane rather than to the active runtime.
      act(() => laneActions.open({ x: 40, y: 60 }));
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

    it("shows a hover label for one online foreign machine", async () => {
      seedForeignMachine();
      renderPane();
      const marker = document.querySelector("[data-machine-marker-mode]")!;
      expect(marker.getAttribute("data-machine-marker-mode")).toBe("glyph");
      // The compact non-Primary header marker spells nothing out until hover.
      expect(marker.textContent).not.toContain("Mac Studio (12)");
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.mouseEnter(marker.parentElement!);
      expect((await screen.findByRole("tooltip")).textContent).toContain("Mac Studio (12)");
    });

    it("dims an offline machine's lane and folds its chats away instead of removing them", () => {
      seedForeignMachine({ online: false });
      renderPane();

      // The work did not stop existing because the machine went to sleep, so the
      // group stays — named, dimmed, and collapsed rather than presented as live.
      const header = screen.getByText("Elsewhere Lane (1)").closest(
        ".ade-lane-group-header",
      )!;
      expect(header.closest("[data-dimmed]")).not.toBeNull();
      const marker = document.querySelector("[data-machine-marker-mode]")!;
      expect(marker.getAttribute("data-machine-online")).toBe("false");
      // Non-Primary lanes keep the compact tower even while offline; the
      // accessible label and tooltip still name the unreachable machine.
      expect(marker.getAttribute("data-machine-marker-mode")).toBe("glyph");
      expect(marker.getAttribute("aria-label")).toBe("Mac Studio (12), offline");
      expect(screen.queryByText("Mac Studio (12)")).toBeNull();
      expect(document.querySelector('[data-session-id="session-elsewhere"]')).toBeNull();
    });

    it("keeps an expanded offline group open, and its chats inert", async () => {
      seedForeignMachine({ online: false });
      const toggleWorkSectionCollapsed = vi.fn();
      renderPane({
        workCollapsedSectionIds: ["lane-open:target-studio:lane-elsewhere"],
        toggleWorkSectionCollapsed,
      });

      // Reading a dropped machine's last-known work is allowed; acting on it is
      // not, and the card says which machine is gone rather than failing later.
      const card = document.querySelector('[data-session-id="session-elsewhere"]')!;
      expect(card).toBeTruthy();
      expect(screen.getByText("Mac Studio (12) is offline")).toBeTruthy();
      expect(card.querySelector('[role="button"]')?.getAttribute("aria-disabled")).toBe("true");
      // Its chats still LOOK active — that is just the last thing the machine
      // reported — so nothing may treat that as a reason to slam the group shut.
      await waitFor(() => {
        expect(toggleWorkSectionCollapsed).not.toHaveBeenCalled();
      });
    });

    /**
     * The shelves are a rule about how quiet a lane is, not about which machine
     * the lane sits on. These lock that in: a foreign lane used to render
     * through a wholly separate branch that never consulted the shelf at all,
     * so it could not demote no matter how settled it was.
     */
    describe("quiet shelves", () => {
      const foreignSettled = (overrides: Partial<TerminalSessionSummary> = {}) => makeSession({
        id: "session-foreign-done",
        laneId: "lane-elsewhere",
        laneName: "Elsewhere Lane",
        title: "Finished elsewhere",
        status: "completed",
        runtimeState: "idle",
        exitCode: 0,
        settledAt: "2026-07-28T12:11:00.000Z",
        ...overrides,
      });
      const foreignSnoozed = (overrides: Partial<TerminalSessionSummary> = {}) => makeSession({
        id: "session-foreign-dozing",
        laneId: "lane-elsewhere",
        laneName: "Elsewhere Lane",
        title: "Sleeping elsewhere",
        snoozedUntil: "2099-01-01T00:00:00.000Z",
        ...overrides,
      });
      /**
       * The foreign lane's group, addressed by the composite id this pane uses.
       * Reads `data-group-id`, not `data-section-id`: these lanes hold one chat
       * each and so render headerless, and a headerless group draws no header
       * row for a section id to live on.
       */
      const foreignGroup = (container: HTMLElement) => container.querySelector(
        '[data-group-id="target-studio:lane-elsewhere"]',
      );
      const shelfContains = (container: HTMLElement, shelf: "snoozed" | "settled") => {
        const header = container.querySelector(`[data-section-id="lane-shelf:${shelf}"]`);
        const group = foreignGroup(container);
        // The header is a sibling of the collapse body, so the group is the
        // header's parent — a shelved lane has to live inside THAT.
        return Boolean(header && group && header.parentElement!.contains(group));
      };

      it("files a fully settled foreign lane into the Settled shelf, marker intact", () => {
        seedForeignMachine({ sessions: [foreignSettled()] });
        const { container } = renderPane({ workCollapsedSectionIds: OPEN_QUIET_SHELVES });

        expect(shelfContains(container, "settled")).toBe(true);
        // A shelved lane shows nothing but its header, so the header must keep
        // saying which machine the work is on.
        expect(foreignGroup(container)!.querySelector("[data-machine-marker-mode]")).toBeTruthy();
      });

      it("files a fully snoozed foreign lane into the Snoozed shelf", () => {
        seedForeignMachine({ sessions: [foreignSnoozed()] });
        const { container } = renderPane({ workCollapsedSectionIds: OPEN_QUIET_SHELVES });

        expect(shelfContains(container, "snoozed")).toBe(true);
        expect(shelfContains(container, "settled")).toBe(false);
      });

      it("files a mixed-quiet foreign lane by its dominant kind, ties to Snoozed", () => {
        seedForeignMachine({
          sessions: [
            foreignSnoozed(),
            foreignSettled(),
          ],
        });
        const { container } = renderPane({ workCollapsedSectionIds: OPEN_QUIET_SHELVES });

        expect(shelfContains(container, "snoozed")).toBe(true);
      });

      it("keeps a foreign lane with live work in the main list", () => {
        seedForeignMachine({
          sessions: [
            makeSession({
              id: "session-foreign-live",
              laneId: "lane-elsewhere",
              laneName: "Elsewhere Lane",
              title: "Still working elsewhere",
            }),
            foreignSettled(),
          ],
        });
        const { container } = renderPane({ workCollapsedSectionIds: OPEN_QUIET_SHELVES });

        expect(foreignGroup(container)).toBeTruthy();
        // Nothing is fully quiet, so the zone the shelves live in never renders.
        expect(screen.queryByTestId("work-quiet-zone")).toBeNull();
      });

      it("never demotes a pinned foreign lane", () => {
        seedForeignMachine({ sessions: [foreignSettled()] });
        const { container } = renderPane({
          workPinnedLaneIds: ["lane-elsewhere"],
          workCollapsedSectionIds: OPEN_QUIET_SHELVES,
        });

        expect(foreignGroup(container)).toBeTruthy();
        expect(screen.queryByTestId("work-quiet-zone")).toBeNull();
      });

      it("never demotes another machine's Primary", () => {
        seedForeignMachine({
          lanes: [makeLane({ id: "lane-elsewhere", name: "Elsewhere Lane", laneType: "primary" })],
          sessions: [foreignSettled()],
        });
        const { container } = renderPane({ workCollapsedSectionIds: OPEN_QUIET_SHELVES });

        expect(foreignGroup(container)).toBeTruthy();
        expect(screen.queryByTestId("work-quiet-zone")).toBeNull();
      });

      it("shelves an offline machine's lane when every row is quiet", () => {
        // The machine being unreachable says nothing about whether the work is
        // done: all-settled is all-settled whether or not the Mac is awake.
        seedForeignMachine({ online: false, sessions: [foreignSettled()] });
        const { container } = renderPane({ workCollapsedSectionIds: OPEN_QUIET_SHELVES });

        expect(shelfContains(container, "settled")).toBe(true);
      });

      it("does not shelve an offline machine's lane whose rows still read as running", () => {
        // "Running" here is only the last thing that machine reported before it
        // dropped, so offline must not FORCE a demotion either — the group folds
        // shut (it is not live), but it keeps its place in the inbox.
        seedForeignMachine({ online: false });
        const { container } = renderPane({ workCollapsedSectionIds: OPEN_QUIET_SHELVES });

        expect(foreignGroup(container)).toBeTruthy();
        expect(screen.queryByTestId("work-quiet-zone")).toBeNull();
      });
    });
  });

  /**
   * Cause-2 regression guard for LOCAL filing, which turned out to be correct:
   * `canonicalSessionState` ranks a declared settle ABOVE stopped/failed/ended,
   * so a row that is settled AND terminal still lands in the settled bucket and
   * still lets its lane sink. Pinned here because "settled but also failed"
   * looks like the kind of row a future precedence tweak would quietly strand
   * in the inbox.
   */
  it("shelves a local lane whose only row is settled and also failed", () => {
    const lane = makeLane({ id: "lane-dead", name: "Dead lane", branchRef: "dead" });
    const settledAndFailed = makeSession({
      id: "session-dead",
      laneId: "lane-dead",
      laneName: "Dead lane",
      title: "Settled after a crash",
      status: "failed",
      runtimeState: "exited",
      exitCode: 2,
      settledAt: "2026-07-28T12:11:00.000Z",
    });

    const { container } = renderPane({
      lanes: [lane],
      runningFiltered: [],
      settledFiltered: [settledAndFailed],
      allSessionsUnfiltered: [settledAndFailed],
      sessionsGroupedByLane: new Map([["lane-dead", [settledAndFailed]]]),
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
    });

    const shelf = container.querySelector('[data-section-id="lane-shelf:settled"]');
    expect(shelf).toBeTruthy();
    expect(shelf!.parentElement!.contains(screen.getByText("Settled after a crash"))).toBe(true);
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
    setLaneNaming("lane-active", false);
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

  // Manual sort throughout this block: reordering IS manual mode, and manual
  // mode is also the one that keeps every lane's divider (a singleton has no
  // header to grab, so the compact form opts out of drag entirely).
  function renderTwoLanes(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
    const sessions = [activeSession, settledSession];
    return renderPane({
      lanes: [activeLane, quietLane],
      workLaneSortMode: "manual",
      runningFiltered: [activeSession],
      settledFiltered: [settledSession],
      allSessionsUnfiltered: sessions,
      sessionsGroupedByLane: new Map([
        ["lane-active", [activeSession]],
        ["lane-quiet", [settledSession]],
      ]),
      // The demoted lane lives inside the Settled shelf, which is closed by
      // default — these tests are about where it files, so the shelf is open.
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
      ...props,
    });
  }

  function renderTwoActiveLanes(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
    const sessions = [activeSession, secondActiveSession];
    return renderPane({
      lanes: [activeLane, secondActiveLane],
      workLaneSortMode: "manual",
      runningFiltered: sessions,
      allSessionsUnfiltered: sessions,
      sessionsGroupedByLane: new Map([
        ["lane-active", [activeSession]],
        ["lane-active-two", [secondActiveSession]],
      ]),
      ...props,
    });
  }

  it("masks a grouped lane fallback consistently until naming finishes", () => {
    setLaneNaming("lane-active", true);
    const { container } = renderTwoActiveLanes();
    const header = container.querySelector('[data-section-id="lane-active"]') as HTMLElement;

    expect(within(header).getByRole("button", { name: /Naming lane…/i })).toBeTruthy();
    expect(within(header).queryByText("Active lane")).toBeNull();
    expect(header.querySelector('[title="Naming lane… · known-lane"]')).toBeTruthy();

    act(() => setLaneNaming("lane-active", false));
    expect(within(header).getByText("Active lane")).toBeTruthy();
  });

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
      // `lane-shelf:*` are the Snoozed/Settled shelves the quiet lanes file
      // into, not lanes themselves.
      .filter((id) => id.startsWith("lane-") && !id.startsWith("lane-shelf:"));
  }

  it("sinks a fully settled lane below an active one", () => {
    const { container } = renderTwoLanes();
    expect(laneOrder(container)).toEqual(["lane-active", "lane-quiet"]);
  });

  it("pinning the settled lane lifts it back to the top, undemoted", () => {
    const { container } = renderTwoLanes({ workPinnedLaneIds: ["lane-quiet"] });
    expect(laneOrder(container)).toEqual(["lane-quiet", "lane-active"]);
    // A pin outranks both the quiet treatment and the shelf demotion: the lane
    // stays in the inbox at the shared header height, with the pin glyph.
    const pinnedHeader = container.querySelector('[data-section-id="lane-quiet"]');
    expect(pinnedHeader?.getAttribute("data-lane-quiet")).toBeNull();
    expect(headerRow("lane-quiet")?.className).toContain("h-7");
    expect(container.querySelector('[data-section-id="lane-shelf:settled"]')).toBeNull();
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

  it("keeps every divider in manual sort mode, singleton lanes included", () => {
    // Rule 3 of the singleton threshold: a singleton has no header to grab, and
    // the card's own drag gesture belongs to the work grid, so manual reorder
    // opts out of the compact form entirely.
    const { container } = renderTwoActiveLanes();
    expect(container.querySelector('[data-section-id="lane-active"]')).toBeTruthy();
    expect(container.querySelector('[data-section-id="lane-active-two"]')).toBeTruthy();
  });
});

describe("SessionListPane singleton lanes and shelves", () => {
  afterEach(() => {
    cleanup();
    lanePrsByLaneIdForTest.clear();
    useAppStore.setState({ lanes: [] });
    Reflect.deleteProperty(window, "ade");
  });

  const soloLane = makeLane({ id: "lane-solo", name: "Solo lane", branchRef: "solo-lane" });

  function soloSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
    return makeSession({
      id: "session-solo",
      laneId: "lane-solo",
      laneName: "Solo lane",
      title: "The only chat",
      ...overrides,
    });
  }

  it("renders a one-chat lane without a divider", () => {
    const session = soloSession();
    const { container } = renderPane({
      lanes: [soloLane],
      runningFiltered: [session],
      allSessionsUnfiltered: [session],
      sessionsGroupedByLane: new Map([["lane-solo", [session]]]),
    });

    expect(container.querySelector('[data-section-id="lane-solo"]')).toBeNull();
    // The row itself is untouched — only the chrome describing a group of one
    // is gone — and the card now carries the lane identity the divider used to.
    expect(screen.getByText("The only chat")).toBeTruthy();
    expect(container.querySelector('[data-session-lane-identity="Solo lane"]')).toBeTruthy();
  });

  it("hands the lane's PR badge to the lone card once the divider is gone", () => {
    // PR state has to survive everywhere the lane header is minimized or
    // absent; the singleton form was the last hole.
    lanePrsByLaneIdForTest.set(
      laneBoundMachineKey("lane-solo"),
      [makePr({ laneId: "lane-solo", headBranch: "solo-lane" })],
    );
    const session = soloSession();
    const { container } = renderPane({
      lanes: [soloLane],
      runningFiltered: [session],
      allSessionsUnfiltered: [session],
      sessionsGroupedByLane: new Map([["lane-solo", [session]]]),
    });

    expect(container.querySelector('[data-section-id="lane-solo"]')).toBeNull();
    const card = container.querySelector('[data-session-id="session-solo"]') as HTMLElement;
    expect(within(card).getByLabelText("Pull request #959, Open")).toBeTruthy();
  });

  it("carries the lane menu on the lone card's context menu, since no divider can host it", () => {
    const session = soloSession();
    const onContextMenu = vi.fn();
    // `LaneContextMenu` resolves its lane from the store, not from this pane's
    // props, so the lane has to exist there for the menu to fill in.
    useAppStore.setState({ lanes: [soloLane] });
    const { container } = renderPane({
      lanes: [soloLane],
      runningFiltered: [session],
      allSessionsUnfiltered: [session],
      sessionsGroupedByLane: new Map([["lane-solo", [session]]]),
      onContextMenu,
    });

    fireEvent.contextMenu(container.querySelector('[data-session-id="session-solo"]')!);

    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-solo" }),
      expect.anything(),
      undefined,
      undefined,
      expect.objectContaining({ laneId: "lane-solo", laneName: "Solo lane" }),
    );

    // And the handle really opens the shared lane menu, rather than a stub.
    const laneActions = onContextMenu.mock.calls[0]![4] as {
      open: (position: { x: number; y: number }) => void;
    };
    act(() => laneActions.open({ x: 40, y: 60 }));
    expect(screen.getByRole("menuitem", { name: "Start chat in lane" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage Lane" })).toBeTruthy();
  });

  it("leaves lane actions off a row whose lane still has a divider", () => {
    const first = soloSession();
    const second = soloSession({ id: "session-solo-2", title: "The second chat" });
    const onContextMenu = vi.fn();
    const { container } = renderPane({
      lanes: [soloLane],
      runningFiltered: [first, second],
      allSessionsUnfiltered: [first, second],
      sessionsGroupedByLane: new Map([["lane-solo", [first, second]]]),
      onContextMenu,
    });

    fireEvent.contextMenu(container.querySelector('[data-session-id="session-solo"]')!);

    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-solo" }),
      expect.anything(),
      undefined,
      undefined,
      undefined,
    );
  });

  it("restores the divider as soon as the lane holds two chats", () => {
    const first = soloSession();
    const second = soloSession({ id: "session-solo-2", title: "The second chat" });
    const { container } = renderPane({
      lanes: [soloLane],
      runningFiltered: [first, second],
      allSessionsUnfiltered: [first, second],
      sessionsGroupedByLane: new Map([["lane-solo", [first, second]]]),
    });

    expect(container.querySelector('[data-section-id="lane-solo"]')).toBeTruthy();
    expect(screen.getByText("Solo lane")).toBeTruthy();
  });

  it("counts top-level rows only, so a chat with shells stays a singleton", () => {
    const parent = soloSession({ toolType: "codex-chat" });
    const child = soloSession({
      id: "session-solo-shell",
      title: "Drawer shell",
      toolType: "shell",
      ptyId: "pty-solo",
      chatSessionId: parent.id,
    });
    const { container } = renderPane({
      lanes: [soloLane],
      runningFiltered: [parent, child],
      allSessionsUnfiltered: [parent, child],
      sessionsGroupedByLane: new Map([["lane-solo", [parent, child]]]),
    });

    expect(container.querySelector('[data-section-id="lane-solo"]')).toBeNull();
    expect(screen.getByRole("button", { name: /1 shell/i })).toBeTruthy();
  });

  it("keeps the divider off while search narrows a two-chat lane to one row", () => {
    // The threshold reads the UNFILTERED roster, in both directions: a two-chat
    // lane filtered down to one row must NOT lose its header as the user types.
    const first = soloSession();
    const second = soloSession({ id: "session-solo-2", title: "Hidden by search" });
    const { container } = renderPane({
      lanes: [soloLane],
      q: "only",
      runningFiltered: [first],
      allSessionsUnfiltered: [first, second],
      sessionsGroupedByLane: new Map([["lane-solo", [first]]]),
    });

    expect(container.querySelector('[data-section-id="lane-solo"]')).toBeTruthy();
  });

  it("files a settled singleton into the Settled shelf, still without a divider", () => {
    const settled = soloSession({
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });
    const { container } = renderPane({
      lanes: [soloLane],
      runningFiltered: [],
      settledFiltered: [settled],
      allSessionsUnfiltered: [settled],
      sessionsGroupedByLane: new Map([["lane-solo", [settled]]]),
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
    });

    // No lane divider, but the group is still a group: it files into the shelf
    // rather than being flattened out of existence.
    expect(container.querySelector('[data-section-id="lane-solo"]')).toBeNull();
    const shelfHeader = container.querySelector('[data-section-id="lane-shelf:settled"]');
    expect(shelfHeader).toBeTruthy();
    // The header is a sibling of the collapse body, so the group is the header's
    // parent — the row has to live inside THAT.
    expect(shelfHeader!.parentElement!.contains(screen.getByText("The only chat"))).toBe(true);
  });

  it("files an all-snoozed lane into a Snoozed shelf above Settled", () => {
    const snoozedLane = makeLane({ id: "lane-dozing", name: "Dozing lane", branchRef: "dozing" });
    const snoozed = makeSession({
      id: "session-dozing-a",
      laneId: "lane-dozing",
      laneName: "Dozing lane",
      title: "Sleeping chat",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const snoozedTwo = makeSession({
      id: "session-dozing-b",
      laneId: "lane-dozing",
      laneName: "Dozing lane",
      title: "Also sleeping",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const settled = soloSession({
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    const { container } = renderPane({
      lanes: [soloLane, snoozedLane],
      runningFiltered: [],
      snoozedFiltered: [snoozed, snoozedTwo],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, snoozedTwo, settled],
      sessionsGroupedByLane: new Map([
        ["lane-solo", [settled]],
        ["lane-dozing", [snoozed, snoozedTwo]],
      ]),
    });

    const snoozedShelf = container.querySelector('[data-section-id="lane-shelf:snoozed"]')!;
    const settledShelf = container.querySelector('[data-section-id="lane-shelf:settled"]')!;
    expect(snoozedShelf).toBeTruthy();
    expect(snoozedShelf.compareDocumentPosition(settledShelf))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("never demotes a mixed quiet lane, and never demotes one that is asking", () => {
    // Snooze yields to needs_you upstream (`isSessionFiledAsSnoozed`), so a lane
    // where everything is snoozed but one row has raised its hand stays put.
    const raised = makeSession({
      id: "session-raised",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Waiting on you",
      pendingInputItemId: "approval-1",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const asleep = makeSession({
      id: "session-asleep",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Sleeping sibling",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });

    const { container } = renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      awaitingInputFiltered: [raised],
      snoozedFiltered: [asleep],
      allSessionsUnfiltered: [raised, asleep],
      sessionsGroupedByLane: new Map([["lane-known", [raised, asleep]]]),
    });

    expect(container.querySelector('[data-section-id="lane-shelf:snoozed"]')).toBeNull();
    expect(container.querySelector('[data-section-id="lane-known"]')).toBeTruthy();
  });

  /** Two settled rows in one lane: enough to keep a divider, so the lane group
   *  inside the shelf is a real group with a body to inspect. */
  function settledPair() {
    return [
      makeSession({
        id: "session-shelf-a",
        laneId: "lane-known",
        laneName: "Known Lane",
        title: "Shelved first",
        status: "completed",
        runtimeState: "idle",
        settledAt: "2026-07-23T12:00:00.000Z",
      }),
      makeSession({
        id: "session-shelf-b",
        laneId: "lane-known",
        laneName: "Known Lane",
        title: "Shelved second",
        status: "completed",
        runtimeState: "idle",
        settledAt: "2026-07-23T12:05:00.000Z",
      }),
    ];
  }

  it("renders a shelved lane's sessions flat, with no nested quiet sub-header", () => {
    const [first, second] = settledPair();
    const { container } = renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      settledFiltered: [first!, second!],
      allSessionsUnfiltered: [first!, second!],
      sessionsGroupedByLane: new Map([["lane-known", [first!, second!]]]),
      // The lane is quiet, so it records only the explicit expand — and so does
      // the shelf it files into.
      workCollapsedSectionIds: [...OPEN_QUIET_SHELVES, "lane-open:lane-known"],
    });

    expect(container.querySelector('[data-section-id="lane-shelf:settled"]')).toBeTruthy();
    // Expanding the lane reaches the rows directly: the shelf already said
    // "settled" for everything under it, so there is no second SETTLED level.
    const body = container.querySelector('[data-lane-group-body="lane-known"]')!;
    expect(body.contains(screen.getByText("Shelved first"))).toBe(true);
    expect(body.contains(screen.getByText("Shelved second"))).toBe(true);
    expect(screen.queryByText("2 settled")).toBeNull();
    expect(screen.queryByRole("button", { name: /\d+ (settled|snoozed)/i })).toBeNull();
  });

  /**
   * Vertical rhythm inside a shelf. jsdom does no layout, so these pin the
   * resolved classes; the intended VISUAL result, for anyone reading a future
   * diff:
   *  - SETTLED label → first shelved row: one row-gap (4px). The label is a
   *    section heading; the rows have to read as belonging to it.
   *  - Two COLLAPSED shelved lanes: 4px apart, the same as two sibling cards
   *    inside a lane group — they are a list of one-line rows, not sections.
   *  - Two EXPANDED shelved lanes: 4 + 7 + 7 = 18px, i.e. the normal group gap,
   *    because each one now has a body of cards under it.
   *  - Nothing extra at either end (`first:mt-0` / `last:mb-0`), so the shelf
   *    label never gets pushed off its rows and no dead gap opens above the
   *    footer separator.
   * A change that makes any of these equal to `gap-[18px]` across the board is
   * the regression this exists to catch.
   */
  describe("shelf vertical rhythm", () => {
    function twoSettledLanes() {
      const laneOne = makeLane({ id: "lane-shelf-one", name: "Shelf one", branchRef: "shelf-one" });
      const laneTwo = makeLane({ id: "lane-shelf-two", name: "Shelf two", branchRef: "shelf-two" });
      const settledIn = (laneId: string, laneName: string, suffix: string) => [
        makeSession({
          id: `${laneId}-a`,
          laneId,
          laneName,
          title: `First ${suffix}`,
          status: "completed",
          runtimeState: "idle",
          settledAt: "2026-07-23T12:00:00.000Z",
        }),
        makeSession({
          id: `${laneId}-b`,
          laneId,
          laneName,
          title: `Second ${suffix}`,
          status: "completed",
          runtimeState: "idle",
          settledAt: "2026-07-23T12:05:00.000Z",
        }),
      ];
      const one = settledIn("lane-shelf-one", "Shelf one", "one");
      const two = settledIn("lane-shelf-two", "Shelf two", "two");
      return { laneOne, laneTwo, sessions: [...one, ...two], one, two };
    }

    function renderShelf(extraCollapsedSectionIds: string[]) {
      const { laneOne, laneTwo, sessions, one, two } = twoSettledLanes();
      const { container } = renderPane({
        lanes: [laneOne, laneTwo],
        runningFiltered: [],
        settledFiltered: sessions,
        allSessionsUnfiltered: sessions,
        sessionsGroupedByLane: new Map([
          ["lane-shelf-one", one],
          ["lane-shelf-two", two],
        ]),
        workCollapsedSectionIds: [...OPEN_QUIET_SHELVES, ...extraCollapsedSectionIds],
      });
      return container;
    }

    it("puts one row-gap between the shelf label and its first row", () => {
      const container = renderShelf([]);
      const shelfBody = container.querySelector('[data-lane-group-body="lane-shelf:settled"]')!;
      expect(shelfBody).toBeTruthy();
      // 4px under the uppercase label, not the 18px reserved for group breaks.
      expect(shelfBody.className).toContain("mt-1");
      expect(shelfBody.className).not.toContain("gap-[18px]");
    });

    it("spaces two collapsed shelved lanes like sibling rows", () => {
      const container = renderShelf([]);
      const body = container.querySelector('[data-testid="shelf-body-settled"]')!;
      expect(body.className).toContain("gap-1");
      expect(body.className).not.toContain("gap-[18px]");
      for (const laneId of ["lane-shelf-one", "lane-shelf-two"]) {
        const row = container.querySelector(`[data-shelf-row="${laneId}"]`) as HTMLElement;
        expect(row).toBeTruthy();
        expect(row.getAttribute("data-shelf-row-expanded")).toBeNull();
        // No margin of its own: the container's 4px gap is the whole spacing.
        expect(row.className).toBe("");
      }
    });

    it("gives two expanded shelved lanes the group gap back, but not at the ends", () => {
      const container = renderShelf(["lane-open:lane-shelf-one", "lane-open:lane-shelf-two"]);
      for (const laneId of ["lane-shelf-one", "lane-shelf-two"]) {
        const row = container.querySelector(`[data-shelf-row="${laneId}"]`) as HTMLElement;
        expect(row.getAttribute("data-shelf-row-expanded")).toBe("true");
        // 4px gap + 7px + 7px = the 18px group rhythm between the two bodies,
        // zeroed at the first/last child so neither end gains dead space.
        expect(row.className).toBe("my-[7px] first:mt-0 last:mb-0");
      }
    });
  });

  it("keeps the in-lane settled tail for a mixed lane that stays in the main list", () => {
    // Quiet AND live rows in one lane: this is where the subsection actually
    // carries information, so it is untouched by the shelf flattening.
    const working = makeSession({
      id: "session-mixed-live",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Still working",
    });
    const done = makeSession({
      id: "session-mixed-settled",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Already done",
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    const { container } = renderPane({
      lanes: [makeLane()],
      runningFiltered: [working],
      settledFiltered: [done],
      allSessionsUnfiltered: [working, done],
      sessionsGroupedByLane: new Map([["lane-known", [working, done]]]),
    });

    expect(container.querySelector('[data-section-id="lane-shelf:settled"]')).toBeNull();
    const tail = screen.getByRole("button", { name: /1 settled/i });
    expect(tail.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Already done")).toBeNull();
  });

  it("files a lane mixing both quiet kinds by the dominant one, still flat", () => {
    const [settledA, settledB] = settledPair();
    const asleep = makeSession({
      id: "session-shelf-snoozed",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Shelved sleeper",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });

    const { container } = renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      settledFiltered: [settledA!, settledB!],
      snoozedFiltered: [asleep],
      allSessionsUnfiltered: [settledA!, settledB!, asleep],
      sessionsGroupedByLane: new Map([["lane-known", [settledA!, settledB!, asleep]]]),
      workCollapsedSectionIds: [...OPEN_QUIET_SHELVES, "lane-open:lane-known"],
    });

    // Two settled to one snoozed: Settled wins, and the odd row rides along —
    // its own card still states that it is snoozed.
    expect(container.querySelector('[data-section-id="lane-shelf:settled"]')).toBeTruthy();
    expect(container.querySelector('[data-section-id="lane-shelf:snoozed"]')).toBeNull();
    const body = container.querySelector('[data-lane-group-body="lane-known"]')!;
    for (const title of ["Shelved first", "Shelved second", "Shelved sleeper"]) {
      expect(body.contains(screen.getByText(title))).toBe(true);
    }
    expect(screen.queryByRole("button", { name: /\d+ (settled|snoozed)/i })).toBeNull();
  });
});

describe("SessionListPane header shape", () => {
  afterEach(() => {
    cleanup();
    lanePrsByLaneIdForTest.clear();
    Reflect.deleteProperty(window, "ade");
  });

  function twoRowLane(extra: Partial<TerminalSessionSummary> = {}) {
    return [
      makeSession({ id: "session-a", laneId: "lane-known", laneName: "Known Lane", title: "First", ...extra }),
      makeSession({ id: "session-b", laneId: "lane-known", laneName: "Known Lane", title: "Second", ...extra }),
    ];
  }

  it("gives the quiet and active lane headers the same shape", () => {
    const [activeA, activeB] = twoRowLane();
    renderPane({
      lanes: [makeLane()],
      runningFiltered: [activeA!, activeB!],
      allSessionsUnfiltered: [activeA!, activeB!],
      sessionsGroupedByLane: new Map([["lane-known", [activeA!, activeB!]]]),
    });
    const activeClass = headerRow("lane-known")?.className ?? "";
    cleanup();

    const snoozed = makeSession({
      id: "session-a",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "First",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const settled = makeSession({
      id: "session-b",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Second",
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });
    renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed, settled]]]),
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
    });

    const quietWrapper = document.querySelector('[data-section-id="lane-known"]')!;
    expect(quietWrapper.getAttribute("data-lane-quiet")).toBe("true");
    // Identical row markup: the quiet lane differs by opacity on the wrapper and
    // by its inline counts, never by height, border, or layout.
    expect(headerRow("lane-known")?.className).toBe(activeClass);
    expect(quietWrapper.className).toContain("opacity-60");
  });

  it("keeps the PR badge on a collapsed quiet lane header", () => {
    lanePrsByLaneIdForTest.set(laneBoundMachineKey("lane-known"), [makePr()]);
    const snoozed = makeSession({
      id: "session-pr-snoozed",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Sleeping chat",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const settled = makeSession({
      id: "session-pr-settled",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished chat",
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });

    renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed, settled]]]),
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
    });

    // Collapsed and quiet, but "there is an open PR on this" is not redundant
    // with the lane name the way the count pill is.
    const header = document.querySelector('[data-section-id="lane-known"]')!;
    expect(header.getAttribute("data-lane-quiet")).toBe("true");
    expect(within(header as HTMLElement).getByLabelText("Pull request #959, Open")).toBeTruthy();
  });

  it("carries the count inline on a collapsed shelf and drops it when expanded", () => {
    const settled = makeSession({
      id: "session-shelf-count",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished chat",
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-23T12:00:00.000Z",
    });
    const paneProps = {
      lanes: [makeLane()],
      sessionListOrganization: "all-lanes-by-status" as const,
      runningFiltered: [],
      settledFiltered: [settled],
      allSessionsUnfiltered: [settled],
      sessionsGroupedByLane: new Map([["lane-known", [settled]]]),
    };

    const expanded = renderPane({
      ...paneProps,
      workCollapsedSectionIds: ["shelf-open:status:settled"],
    });
    expect(screen.getByText("Settled")).toBeTruthy();
    expanded.unmount();

    // No marker at all: the shelf is closed, which is its default.
    renderPane(paneProps);
    expect(screen.getByText("Settled (1)")).toBeTruthy();
    // The pill is absorbed, not duplicated.
    expect(screen.queryByText("Settled")).toBeNull();
  });

  it("carries a lane count only while that lane is collapsed", () => {
    const sessions = twoRowLane();
    const paneProps = {
      lanes: [makeLane()],
      runningFiltered: sessions,
      allSessionsUnfiltered: sessions,
      sessionsGroupedByLane: new Map([["lane-known", sessions]]),
    };

    const expanded = renderPane(paneProps);
    const expandedHeader = document.querySelector('[data-section-id="lane-known"]') as HTMLElement;
    expect(within(expandedHeader).getByText("Known Lane")).toBeTruthy();
    expect(within(expandedHeader).queryByText("2")).toBeNull();
    expanded.unmount();

    renderPane({ ...paneProps, workCollapsedLaneIds: ["lane-known"] });
    const collapsedHeader = document.querySelector('[data-section-id="lane-known"]') as HTMLElement;
    expect(within(collapsedHeader).getByText("Known Lane (2)")).toBeTruthy();
  });

  it("matches the 32px chat and CLI title rail", () => {
    renderPane();
    const header = screen.getByTestId("work-session-list-header");
    expect(header.className).toContain("h-8");
  });

  it("opens the command palette from the search button instead of filtering inline", () => {
    const setQ = vi.fn();
    renderPane({ setQ });

    // The inline input is gone; search is a palette entry point now.
    expect(document.querySelector("input[placeholder='Search...']")).toBeNull();

    const seen: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event);
    window.addEventListener("keydown", listener);
    fireEvent.click(screen.getByTestId("work-sidebar-search"));
    window.removeEventListener("keydown", listener);

    expect(seen).toHaveLength(1);
    expect(eventMatchesBinding(seen[0]!, "Mod+K")).toBe(true);
    expect(setQ).not.toHaveBeenCalled();
  });

  it("offers New lane as a bare footer button", () => {
    renderPane();
    const newLane = screen.getByRole("button", { name: "New lane" });
    expect(newLane.className).not.toContain("border");
    expect(newLane.className).toContain("hover:bg-white/[0.04]");
  });
});

describe("SessionListPane visual hierarchy", () => {
  afterEach(() => {
    cleanup();
    lanePrsByLaneIdForTest.clear();
    useAppStore.setState({ crossMachineLanesByMachineId: {}, crossMachineLaneScopeKey: null });
    resetCrossMachineLaneSyncForTest();
    Reflect.deleteProperty(window, "ade");
  });

  const tintedLane = makeLane({ id: "lane-known", name: "Known Lane", color: "#34d399" });

  function twoChats() {
    return [
      makeSession({ id: "session-a", laneId: "lane-known", laneName: "Known Lane", title: "First" }),
      makeSession({ id: "session-b", laneId: "lane-known", laneName: "Known Lane", title: "Second" }),
    ];
  }

  it("indents an expanded lane's rows behind a rail in the lane's own colour", () => {
    const [a, b] = twoChats();
    const { container } = renderPane({
      lanes: [tintedLane],
      runningFiltered: [a!, b!],
      allSessionsUnfiltered: [a!, b!],
      sessionsGroupedByLane: new Map([["lane-known", [a!, b!]]]),
    });

    const body = container.querySelector('[data-lane-group-body="lane-known"]') as HTMLElement;
    expect(body.getAttribute("data-indented")).toBe("true");
    expect(body.className).toContain("pl-2");
    const rail = container.querySelector('[data-testid="lane-group-rail-lane-known"]') as HTMLElement;
    // A tint of the lane accent, not the accent itself: the rail binds the group
    // without competing with the cards inside it.
    expect(rail.getAttribute("style")).toMatch(/rgba\(52,\s*211,\s*153,\s*0?\.25\)/);
  });

  it("leaves a singleton lane's card flush-left with no rail", () => {
    const solo = makeSession({
      id: "session-solo", laneId: "lane-known", laneName: "Known Lane", title: "The only chat",
    });
    const { container } = renderPane({
      lanes: [tintedLane],
      runningFiltered: [solo],
      allSessionsUnfiltered: [solo],
      sessionsGroupedByLane: new Map([["lane-known", [solo]]]),
    });

    // Indentation is the cue that says "this belongs to the group above". A
    // singleton has no group above it, so it must not be indented — that
    // equivalence was the whole hierarchy failure.
    const body = container.querySelector('[data-lane-group-body="lane-known"]') as HTMLElement;
    expect(body.getAttribute("data-indented")).toBeNull();
    expect(body.className).not.toContain("pl-2");
    expect(container.querySelector('[data-testid^="lane-group-rail"]')).toBeNull();
  });

  describe("Primary lanes", () => {
    const primaryLane = makeLane({
      id: "lane-primary", name: "Primary", laneType: "primary", branchRef: "main", color: null,
    });
    const primarySession = makeSession({
      id: "session-primary", laneId: "lane-primary", laneName: "Primary", title: "Primary chat",
    });
    const otherLane = makeLane({ id: "lane-other", name: "Other lane" });
    const otherSession = makeSession({
      id: "session-other", laneId: "lane-other", laneName: "Other lane", title: "Other chat",
    });

    function renderWithPrimary(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
      return renderPane({
        lanes: [otherLane, primaryLane],
        workLaneSortMode: "manual",
        runningFiltered: [otherSession, primarySession],
        allSessionsUnfiltered: [otherSession, primarySession],
        sessionsGroupedByLane: new Map([
          ["lane-other", [otherSession]],
          ["lane-primary", [primarySession]],
        ]),
        ...props,
      });
    }

    it("pins Primary above every other lane, pinned ones included", () => {
      const { container } = renderWithPrimary({ workPinnedLaneIds: ["lane-other"] });
      const order = Array.from(container.querySelectorAll("[data-section-id]"))
        .map((el) => el.getAttribute("data-section-id") ?? "")
        .filter((id) => id.startsWith("lane-") && !id.startsWith("lane-shelf:"));
      expect(order).toEqual(["lane-primary", "lane-other"]);
    });

    it("locks Primary to ADE purple even when its row stores no colour", () => {
      const { container } = renderWithPrimary();
      const rail = container.querySelector('[data-testid="lane-group-rail-lane-primary"]');
      expect(rail?.getAttribute("style")).toMatch(/rgba\(167,\s*139,\s*250,\s*0?\.25\)/);
    });

    it("shows no machine badge while only one Primary is visible", () => {
      renderWithPrimary();
      expect(document.querySelector("[data-machine-marker-mode]")).toBeNull();
    });

    it("separates two Primaries by badging only the one that is elsewhere", () => {
      // Every ADE machine has a Primary, so two connected machines put two
      // identically-named, identically-purple rows in one column. This used to
      // need a bespoke badge naming the LOCAL Primary. It no longer does: under
      // the physical-machine rule exactly one Primary on screen can be unbadged
      // — the one on the Mac you're sitting at — so presence versus absence
      // separates the pair on its own.
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
            lanes: [makeLane({
              id: "lane-primary-studio", name: "Primary", laneType: "primary", branchRef: "main",
            })],
            sessions: [makeSession({
              id: "session-primary-studio",
              laneId: "lane-primary-studio",
              laneName: "Primary",
              title: "Primary chat elsewhere",
            })],
            prs: [],
            lastSyncedAtMs: 1,
            error: null,
          },
        },
      });

      const { container } = renderWithPrimary();

      // This machine's Primary: no badge, and no machine name anywhere on it.
      const localHeader = container.querySelector('[data-section-id="lane-primary"]') as HTMLElement;
      expect(localHeader.querySelector("[data-machine-marker-mode]")).toBeNull();
      expect(within(localHeader).queryByText(THIS_MACHINE_NAME)).toBeNull();

      // The Studio's Primary: badged, in the resting glyph form. Primary is no
      // longer an exception to that — its name is on hover like every other
      // lane's. This fixture sorts manually, which opts every lane out of the
      // headerless form, so the badge sits on the header where it always did.
      const foreignGroup = container.querySelector(
        '[data-group-id="target-studio:lane-primary-studio"]',
      ) as HTMLElement;
      const foreignMarker = foreignGroup.querySelector("[data-machine-marker-mode]");
      expect(foreignMarker?.getAttribute("data-machine-marker-mode")).toBe("glyph");
      expect(foreignMarker?.getAttribute("aria-label")).toBe("Mac Studio (12)");
      expect(within(foreignGroup).queryByText("Mac Studio (12)")).toBeNull();
    });

    it("keeps Primary out of the quiet shelves when everything in it has settled", () => {
      const settled = makeSession({
        id: "session-primary-settled",
        laneId: "lane-primary",
        laneName: "Primary",
        title: "Finished primary chat",
        status: "completed",
        runtimeState: "idle",
        settledAt: "2026-07-28T12:00:00.000Z",
      });
      const { container } = renderPane({
        lanes: [primaryLane],
        workLaneSortMode: "manual",
        runningFiltered: [],
        settledFiltered: [settled],
        allSessionsUnfiltered: [settled],
        sessionsGroupedByLane: new Map([["lane-primary", [settled]]]),
      });

      // Primary is the column's fixed landmark; a quiet afternoon must not send
      // it to the bottom of the list.
      expect(container.querySelector('[data-section-id="lane-primary"]')).toBeTruthy();
      expect(container.querySelector('[data-section-id="lane-shelf:settled"]')).toBeNull();
    });
  });

  it("fences Snoozed and Settled off as a quiet zone with no rules of their own", () => {
    const settled = makeSession({
      id: "session-zone-settled",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Finished chat",
      status: "completed",
      runtimeState: "idle",
      settledAt: "2026-07-28T12:00:00.000Z",
    });
    const snoozed = makeSession({
      id: "session-zone-snoozed",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Sleeping chat",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const { container } = renderPane({
      lanes: [tintedLane],
      sessionListOrganization: "all-lanes-by-status",
      runningFiltered: [],
      settledFiltered: [settled],
      snoozedFiltered: [snoozed],
      allSessionsUnfiltered: [settled, snoozed],
      sessionsGroupedByLane: new Map([["lane-known", [settled, snoozed]]]),
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
    });

    // One heavier rule above the whole region...
    const zone = container.querySelector('[data-testid="work-quiet-zone"]') as HTMLElement;
    expect(zone.querySelector('[data-testid="work-quiet-zone-separator"]')).toBeTruthy();

    // ...and inside it, uppercase grey labels with no hairline at all, so a
    // quiet shelf can never be mistaken for a lane divider.
    for (const label of ["Snoozed", "Settled"]) {
      const labelEl = within(zone).getByText(label);
      expect(labelEl.className).toContain("uppercase");
      const toggle = labelEl.closest("button") as HTMLElement;
      expect(toggle.querySelector(".h-px")).toBeNull();
    }
  });
});

describe("SessionListPane machine chip suppression", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ crossMachineLanesByMachineId: {}, crossMachineLaneScopeKey: null });
    resetCrossMachineLaneSyncForTest();
    sessionCardPropsForTest.length = 0;
    Reflect.deleteProperty(window, "ade");
  });

  function seedMachine(lane: LaneSummary, sessions: TerminalSessionSummary[]) {
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
          lanes: [lane],
          sessions,
          prs: [],
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
  }

  it("suppresses the row chip under a machine-labelled lane header, but not for a singleton", () => {
    const foreignLane = makeLane({ id: "lane-elsewhere", name: "Elsewhere Lane", branchRef: "feature/elsewhere" });
    const foreignA = makeSession({
      id: "session-foreign-a",
      laneId: "lane-elsewhere",
      laneName: "Elsewhere Lane",
      title: "Foreign first",
    });
    const foreignB = makeSession({
      id: "session-foreign-b",
      laneId: "lane-elsewhere",
      laneName: "Elsewhere Lane",
      title: "Foreign second",
    });
    seedMachine(foreignLane, [foreignA, foreignB]);
    const local = makeSession({
      id: "session-local-solo",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Local solo chat",
    });

    sessionCardPropsForTest.length = 0;
    const { container } = renderPane({
      lanes: [makeLane()],
      runningFiltered: [local],
      allSessionsUnfiltered: [local],
      sessionsGroupedByLane: new Map([["lane-known", [local]]]),
    });

    // The foreign header names the machine, so its rows stop repeating it.
    const foreignHeader = screen.getByText("Elsewhere Lane").closest(".ade-lane-group-header")!;
    expect(foreignHeader.querySelector("[data-machine-marker-mode]")).toBeTruthy();
    expect(cardPropsFor("session-foreign-a")?.suppressMachineChip).toBe(true);
    expect(cardPropsFor("session-foreign-b")?.suppressMachineChip).toBe(true);

    // The singleton has no header above it at all, so its chip is the only place
    // a machine could ever be named.
    expect(container.querySelector('[data-section-id="lane-known"]')).toBeNull();
    expect(cardPropsFor("session-local-solo")?.suppressMachineChip).toBeFalsy();
  });

  it("leaves a local Primary's rows unchipped even opposite another machine's Primary", () => {
    // The counterpart to "separates two Primaries by badging only the one that
    // is elsewhere". The LOCAL Primary carries no badge at all, so there is no
    // header label for its rows to repeat — and nothing to suppress. Work that
    // is here says so by staying quiet.
    const foreignPrimary = makeLane({ id: "lane-primary-remote", name: "Primary", laneType: "primary" });
    seedMachine(foreignPrimary, [
      makeSession({
        id: "session-remote-primary",
        laneId: "lane-primary-remote",
        laneName: "Primary",
        title: "Remote primary chat",
      }),
    ]);
    const localPrimary = makeLane({ id: "lane-primary-local", name: "Primary", laneType: "primary" });
    const first = makeSession({
      id: "session-primary-a",
      laneId: "lane-primary-local",
      laneName: "Primary",
      title: "Primary first",
    });
    const second = makeSession({
      id: "session-primary-b",
      laneId: "lane-primary-local",
      laneName: "Primary",
      title: "Primary second",
    });

    sessionCardPropsForTest.length = 0;
    const { container } = renderPane({
      lanes: [localPrimary],
      runningFiltered: [first, second],
      allSessionsUnfiltered: [first, second],
      sessionsGroupedByLane: new Map([["lane-primary-local", [first, second]]]),
    });

    const localHeader = container.querySelector('[data-section-id="lane-primary-local"]')!;
    expect(localHeader.querySelector("[data-machine-marker-mode]")).toBeNull();
    expect(localHeader.textContent).not.toContain(THIS_MACHINE_NAME);
    expect(cardPropsFor("session-primary-a")?.suppressMachineChip).toBeFalsy();
    expect(cardPropsFor("session-primary-b")?.suppressMachineChip).toBeFalsy();
    // Unsuppressed but still unbadged: the card renders a glyph only when the
    // union hands it a marker, and a lane on this Mac never gets one.
    expect(
      container.querySelector('[data-session-id="session-primary-a"] [data-machine-marker-mode]'),
    ).toBeNull();
  });
});

describe("SessionListPane quiet-shelf defaults", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "ade");
  });

  const snoozed = makeSession({
    id: "session-default-snoozed",
    laneId: "lane-known",
    laneName: "Known Lane",
    title: "Sleeping chat",
    snoozedUntil: "2099-01-01T00:00:00.000Z",
  });
  const settled = makeSession({
    id: "session-default-settled",
    laneId: "lane-known",
    laneName: "Known Lane",
    title: "Finished chat",
    status: "completed",
    runtimeState: "idle",
    settledAt: "2026-07-23T12:00:00.000Z",
  });

  function renderByStatus(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
    return renderPane({
      lanes: [makeLane()],
      sessionListOrganization: "all-lanes-by-status",
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed, settled]]]),
      workCollapsedSectionIds: [],
      ...props,
    });
  }

  function shelfRows(): string[] {
    return [snoozed.id, settled.id].filter(
      (id) => document.querySelector(`[data-session-id="${id}"]`) != null,
    );
  }

  it("greets a fresh sidebar with both quiet shelves shut", () => {
    renderByStatus();

    // The shelves are there — with their counts folded inline, the collapsed
    // form — but the rows the user told it to hide stay hidden.
    expect(screen.getByText("Snoozed (1)")).toBeTruthy();
    expect(screen.getByText("Settled (1)")).toBeTruthy();
    expect(shelfRows()).toEqual([]);
  });

  it("leaves every other section expanded by default", () => {
    const running = makeSession({
      id: "session-default-running",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Working chat",
    });
    renderByStatus({
      runningFiltered: [running],
      allSessionsUnfiltered: [running, snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [running, snoozed, settled]]]),
    });

    expect(document.querySelector('[data-session-id="session-default-running"]')).toBeTruthy();
  });

  it("round-trips an explicit expand: stored preference beats the collapsed default", () => {
    const toggleWorkSectionCollapsed = vi.fn();
    // 1. Never touched → closed, and opening it records the *expand*, not a
    //    collapse: `shelf-open:` is the only entry that means anything here.
    const closed = renderByStatus({ toggleWorkSectionCollapsed });
    fireEvent.click(screen.getByRole("button", { name: "Snoozed (1)" }));
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith("shelf-open:status:snoozed");
    closed.unmount();

    // 2. That entry is what a reload gets back, and it outranks the default.
    const opened = renderByStatus({
      workCollapsedSectionIds: ["shelf-open:status:snoozed"],
      toggleWorkSectionCollapsed,
    });
    expect(shelfRows()).toEqual([snoozed.id]);

    // 3. Closing it again removes the same entry — leaving the pane back in the
    //    never-touched state, which is the collapsed one.
    fireEvent.click(screen.getByRole("button", { name: "Snoozed (1)" }));
    expect(toggleWorkSectionCollapsed).toHaveBeenLastCalledWith("shelf-open:status:snoozed");
    opened.unmount();

    renderByStatus();
    expect(shelfRows()).toEqual([]);
  });

  it("does not read a legacy collapse entry as an expand", () => {
    // Before the default flipped, `status:settled` in the list meant "the user
    // collapsed this". It still means collapsed — which is now also the default,
    // so the entry is simply inert rather than an inverted signal.
    renderByStatus({ workCollapsedSectionIds: ["status:settled", "status:snoozed"] });
    expect(shelfRows()).toEqual([]);
  });

  it("starts the by-lane Snoozed and Settled shelves shut too", () => {
    const toggleWorkSectionCollapsed = vi.fn();
    const { container } = renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed, settled]]]),
      workCollapsedSectionIds: [],
      toggleWorkSectionCollapsed,
    });

    // The lane files into a shelf, and the shelf is shut, so neither the lane
    // group nor its rows are on screen.
    expect(container.querySelector('[data-section-id="lane-shelf:snoozed"]')).toBeTruthy();
    expect(container.querySelector('[data-section-id="lane-known"]')).toBeNull();
    expect(shelfRows()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Snoozed (1)" }));
    expect(toggleWorkSectionCollapsed).toHaveBeenCalledWith("shelf-open:lane-shelf:snoozed");
  });
});

describe("SessionListPane header chevrons", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "ade");
  });

  /**
   * The chevron and the label are ONE control rendered in two places: whatever
   * a label click does, a chevron click has to do identically — same handler,
   * same argument.
   */
  function expectChevronMatchesLabel(
    sectionId: string,
    labelButton: HTMLElement,
    toggle: ReturnType<typeof vi.fn>,
  ) {
    const before = toggle.mock.calls.length;
    fireEvent.click(labelButton);
    expect(toggle.mock.calls.length).toBe(before + 1);
    fireEvent.click(headerChevron(sectionId));
    expect(toggle.mock.calls.length).toBe(before + 2);
    expect(toggle.mock.calls[before + 1]).toEqual(toggle.mock.calls[before]);
  }

  const laneA = makeSession({
    id: "session-chevron-a", laneId: "lane-known", laneName: "Known Lane", title: "First chat",
  });
  const laneB = makeSession({
    id: "session-chevron-b", laneId: "lane-known", laneName: "Known Lane", title: "Second chat",
  });
  const snoozed = makeSession({
    id: "session-chevron-snoozed",
    laneId: "lane-known",
    laneName: "Known Lane",
    title: "Sleeping chat",
    snoozedUntil: "2099-01-01T00:00:00.000Z",
  });
  const settled = makeSession({
    id: "session-chevron-settled",
    laneId: "lane-known",
    laneName: "Known Lane",
    title: "Finished chat",
    status: "completed",
    runtimeState: "idle",
    settledAt: "2026-07-23T12:00:00.000Z",
  });

  it("toggles an active lane header from its chevron", () => {
    const toggleWorkLaneCollapsed = vi.fn();
    renderPane({
      lanes: [makeLane()],
      runningFiltered: [laneA, laneB],
      allSessionsUnfiltered: [laneA, laneB],
      sessionsGroupedByLane: new Map([["lane-known", [laneA, laneB]]]),
      toggleWorkLaneCollapsed,
    });

    expectChevronMatchesLabel(
      "lane-known",
      screen.getByRole("button", { name: /Known Lane/ }),
      toggleWorkLaneCollapsed,
    );
    expect(toggleWorkLaneCollapsed).toHaveBeenLastCalledWith("lane-known");
  });

  it("toggles a quiet lane header from its chevron", () => {
    const toggleWorkSectionCollapsed = vi.fn();
    renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      settledFiltered: [settled],
      allSessionsUnfiltered: [snoozed, settled],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed, settled]]]),
      workCollapsedSectionIds: OPEN_QUIET_SHELVES,
      toggleWorkSectionCollapsed,
    });

    expect(document.querySelector('[data-section-id="lane-known"]')?.getAttribute("data-lane-quiet"))
      .toBe("true");
    expectChevronMatchesLabel(
      "lane-known",
      screen.getByRole("button", { name: /Known Lane \(2 quiet\)/i }),
      toggleWorkSectionCollapsed,
    );
    expect(toggleWorkSectionCollapsed).toHaveBeenLastCalledWith("lane-open:lane-known");
  });

  it("toggles a by-lane quiet shelf from its chevron", () => {
    const toggleWorkSectionCollapsed = vi.fn();
    renderPane({
      lanes: [makeLane()],
      runningFiltered: [],
      settledFiltered: [settled],
      allSessionsUnfiltered: [settled],
      sessionsGroupedByLane: new Map([["lane-known", [settled]]]),
      toggleWorkSectionCollapsed,
    });

    expectChevronMatchesLabel(
      "lane-shelf:settled",
      screen.getByRole("button", { name: "Settled (1)" }),
      toggleWorkSectionCollapsed,
    );
    expect(toggleWorkSectionCollapsed).toHaveBeenLastCalledWith("shelf-open:lane-shelf:settled");
  });

  it("toggles a by-status quiet shelf from its chevron", () => {
    const toggleWorkSectionCollapsed = vi.fn();
    renderPane({
      lanes: [makeLane()],
      sessionListOrganization: "all-lanes-by-status",
      runningFiltered: [],
      snoozedFiltered: [snoozed],
      allSessionsUnfiltered: [snoozed],
      sessionsGroupedByLane: new Map([["lane-known", [snoozed]]]),
      toggleWorkSectionCollapsed,
    });

    expectChevronMatchesLabel(
      "status:snoozed",
      screen.getByRole("button", { name: "Snoozed (1)" }),
      toggleWorkSectionCollapsed,
    );
    expect(toggleWorkSectionCollapsed).toHaveBeenLastCalledWith("shelf-open:status:snoozed");
  });

  it("toggles a status section header from its chevron", () => {
    const toggleWorkSectionCollapsed = vi.fn();
    renderPane({
      lanes: [makeLane()],
      sessionListOrganization: "all-lanes-by-status",
      runningFiltered: [laneA],
      allSessionsUnfiltered: [laneA],
      sessionsGroupedByLane: new Map([["lane-known", [laneA]]]),
      toggleWorkSectionCollapsed,
    });

    expectChevronMatchesLabel(
      "status:running",
      screen.getByRole("button", { name: /Running/ }),
      toggleWorkSectionCollapsed,
    );
    expect(toggleWorkSectionCollapsed).toHaveBeenLastCalledWith("status:running");
  });

  it("toggles a time section header from its chevron", () => {
    const fresh = makeSession({
      id: "session-chevron-today",
      laneId: "lane-known",
      laneName: "Known Lane",
      title: "Todays chat",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    const toggleWorkSectionCollapsed = vi.fn();
    renderPane({
      lanes: [makeLane()],
      sessionListOrganization: "by-time",
      runningFiltered: [fresh],
      allSessionsUnfiltered: [fresh],
      sessionsGroupedByLane: new Map([["lane-known", [fresh]]]),
      toggleWorkSectionCollapsed,
    });

    // Scoped to the header: a card's own relative timestamp also says "Today".
    const header = document.querySelector('[data-section-id="time:today"]') as HTMLElement;
    expectChevronMatchesLabel(
      "time:today",
      within(header).getByRole("button", { name: /Today/ }),
      toggleWorkSectionCollapsed,
    );
    expect(toggleWorkSectionCollapsed).toHaveBeenLastCalledWith("time:today");
  });

  it("keeps the accessible disclosure on the label, not on the chevron", () => {
    renderPane({
      lanes: [makeLane()],
      runningFiltered: [laneA, laneB],
      allSessionsUnfiltered: [laneA, laneB],
      sessionsGroupedByLane: new Map([["lane-known", [laneA, laneB]]]),
    });

    // One announced control per header: the label carries the name and the
    // state, the chevron is a silent duplicate hit target outside the tab order.
    expect(screen.getByRole("button", { name: /Known Lane/ }).getAttribute("aria-expanded"))
      .toBe("true");
    const chevron = headerChevron("lane-known");
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    expect(chevron.getAttribute("tabindex")).toBe("-1");
  });
});
