/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, PrSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionListPane } from "./SessionListPane";
import { laneBoundMachineKey } from "./useLanePrs";
import { WORK_BOARD_DND_MIME } from "./WorkKanbanBoard";
import { ADE_WORK_LANE_DND_MIME } from "./workLaneOrder";
import { GRID_SESSION_DND_MIME } from "../../lib/workGrid";
import type { WorkBoardColumn } from "../../../shared/types/chat";
import type { WorkBoardWaitingReason } from "./useWorkSessions";

/* ──────────────────────────────────────────────────────────────────────────
   The board is mounted through `SessionListPane`, never in isolation.

   That is the point of the test: the board's whole design claim is that a
   board card IS a list row — same component, same click, same context menu,
   same chips — and a test that rendered `WorkKanbanBoard` with a hand-written
   `renderCard` would prove only that the columns lay out. Driving the real pane
   proves the wiring: that board mode replaces the list, that the toggle flips
   it, that `renderBoardCard` hands each card the singleton options (lane
   identity + the lane's PR), and that the CTO chip survives the trip.
   ────────────────────────────────────────────────────────────────────────── */

vi.mock("./useSessionDelta", () => ({ useSessionDelta: () => null }));
vi.mock("./ToolLogos", () => ({ ToolLogo: () => <span data-testid="tool-logo" /> }));

const { lanePrsByLaneIdForTest } = vi.hoisted(() => ({
  lanePrsByLaneIdForTest: new Map<string, unknown[]>(),
}));
vi.mock("./useLanePrs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useLanePrs")>()),
  useLanePrsByLaneId: () => lanePrsByLaneIdForTest,
}));

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-a",
    name: "Lane A",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "ade/lane-a",
    worktreePath: "/tmp/lane-a",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: "#7C5CFF",
    icon: null,
    tags: [],
    createdAt: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-a",
    laneName: "Lane A",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: null,
    toolType: "claude-chat",
    title: "Session one",
    status: "running",
    startedAt: "2026-04-22T22:13:02.691Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: "2026-04-22T22:20:00.000Z",
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  };
}

function makePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-ci",
    projectId: "project-a",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: 4242,
    githubUrl: "https://github.com/acme/ade/pull/4242",
    githubNodeId: null,
    title: "Board",
    state: "open",
    baseBranch: "main",
    headBranch: "ade/lane-ci",
    checksStatus: "pending",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-04-22T10:00:00.000Z",
    updatedAt: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * One fixture covering every branch the board has:
 *   Needs you — an ordinary chat
 *   Working   — a chat spawned by the CTO (the lineage chip)
 *   Waiting   — a chat whose lane PR is mid-CI (the PR pill + the reason chip)
 *   Done      — one ended and one settled row
 * plus a deliberately EMPTY column is impossible with four populated ones, so
 * `emptyBoard()` below covers the zero-card header/placeholder case.
 */
const NEEDS_YOU = makeSession({
  id: "s-needs",
  title: "Needs a decision",
  runtimeState: "waiting-input",
  statusNote: "waiting on the schema call",
});
const CTO_CHILD = makeSession({
  id: "s-cto",
  title: "CTO delegated work",
  orchestrationParentSessionId: "cto-session",
  spawnKind: "subagent",
  parentIdentityKey: "cto",
  goal: "Audit the release pipeline for Windows parity",
  modelId: "claude-opus-5",
});
const WAITING_ON_CI = makeSession({
  id: "s-ci",
  laneId: "lane-ci",
  laneName: "Lane CI",
  title: "Waiting on checks",
});
const ENDED = makeSession({
  id: "s-ended",
  title: "Finished run",
  status: "completed",
  runtimeState: "exited",
  endedAt: "2026-04-22T23:00:00.000Z",
});
const SETTLED = makeSession({
  id: "s-settled",
  title: "Filed away",
  status: "completed",
  runtimeState: "exited",
  settledAt: "2026-04-22T23:30:00.000Z",
});

const FULL_BOARD: Record<WorkBoardColumn, TerminalSessionSummary[]> = {
  needs_you: [NEEDS_YOU],
  working: [CTO_CHILD],
  waiting: [WAITING_ON_CI],
  done: [ENDED, SETTLED],
};

const EMPTY_BOARD: Record<WorkBoardColumn, TerminalSessionSummary[]> = {
  needs_you: [],
  working: [],
  waiting: [],
  done: [],
};

const WAITING_REASONS = new Map<string, WorkBoardWaitingReason>([["s-ci", "ci"]]);

function renderBoard(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
  const all = Object.values(FULL_BOARD).flat();
  return render(
    <MemoryRouter>
      <SessionListPane
        lanes={[makeLane(), makeLane({ id: "lane-ci", name: "Lane CI", color: "#33B3A6", branchRef: "ade/lane-ci", worktreePath: "/tmp/lane-ci" })]}
        runningFiltered={[CTO_CHILD, WAITING_ON_CI]}
        awaitingInputFiltered={[NEEDS_YOU]}
        endedFiltered={[ENDED]}
        settledFiltered={[SETTLED]}
        allSessionsUnfiltered={all}
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
        workViewMode="board"
        setWorkViewMode={vi.fn()}
        workBoardBuckets={FULL_BOARD}
        workBoardWaitingReasons={WAITING_REASONS}
        workCollapsedLaneIds={[]}
        toggleWorkLaneCollapsed={vi.fn()}
        workCollapsedSectionIds={[]}
        toggleWorkSectionCollapsed={vi.fn()}
        sessionsGroupedByLane={new Map()}
        {...props}
      />
    </MemoryRouter>,
  );
}

function column(key: WorkBoardColumn): HTMLElement {
  return screen.getByTestId(`work-board-column-${key}`);
}

/**
 * The element a browser actually starts the drag from.
 *
 * NOT the board tile: `draggable` lives on `SessionCard`'s own wrapper (it is
 * the work grid's drag source), and the tile only listens on CAPTURE. Firing at
 * the tile would run the board's handler and silently skip the card's, so the
 * test would never see the two payloads land on one transfer — which is the
 * exact interaction these tests exist to check.
 */
function dragSource(sessionId: string): HTMLElement {
  const el = screen
    .getByTestId(`work-board-card-${sessionId}`)
    .querySelector<HTMLElement>(`[data-session-row][data-session-id="${sessionId}"]`);
  if (!el) throw new Error(`no drag source for ${sessionId}`);
  return el;
}

function fireDrag(
  el: HTMLElement,
  type: "dragstart" | "dragover" | "drop" | "dragend",
  dataTransfer: unknown,
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(el, event);
  return event;
}

function transfer(types: string[] = [WORK_BOARD_DND_MIME]) {
  const store = new Map<string, string>();
  return {
    types,
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn((key: string, value: string) => store.set(key, value)),
    getData: vi.fn((key: string) => store.get(key) ?? ""),
  };
}

/**
 * A DataTransfer that behaves like the browser's: `setData` records the payload
 * AND publishes its MIME into `types`.
 *
 * The stubs above hard-code `types`, which is fine for exercising one handler
 * but useless for the cross-surface test below — that one has to observe what
 * the real components actually wrote onto one shared transfer, not what the
 * test assumed they would.
 */
function recordingTransfer() {
  const store = new Map<string, string>();
  return {
    get types() { return [...store.keys()]; },
    effectAllowed: "",
    dropEffect: "",
    setData(key: string, value: string) { store.set(key, value); },
    getData(key: string) { return store.get(key) ?? ""; },
  };
}

function makeSessionForLane(id: string, laneId: string, laneName: string, title: string) {
  return makeSession({ id, laneId, laneName, title });
}

/** List mode, two draggable lane headers — the shape lane reorder needs. */
function renderListWithTwoLanes(props: Partial<ComponentProps<typeof SessionListPane>> = {}) {
  const one = makeSessionForLane("s-lane-one", "lane-one", "Lane one", "Chat one");
  const two = makeSessionForLane("s-lane-two", "lane-two", "Lane two", "Chat two");
  return render(
    <MemoryRouter>
      <SessionListPane
        lanes={[
          makeLane({ id: "lane-one", name: "Lane one", branchRef: "ade/lane-one", worktreePath: "/tmp/one" }),
          makeLane({ id: "lane-two", name: "Lane two", branchRef: "ade/lane-two", worktreePath: "/tmp/two" }),
        ]}
        runningFiltered={[one, two]}
        awaitingInputFiltered={[]}
        endedFiltered={[]}
        settledFiltered={[]}
        allSessionsUnfiltered={[one, two]}
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
        // Manual sort keeps every lane's divider, so a one-session lane still
        // has a header to grab. Same setup the lane-reorder suite uses.
        workLaneSortMode="manual"
        workViewMode="list"
        setWorkViewMode={vi.fn()}
        workBoardBuckets={FULL_BOARD}
        workBoardWaitingReasons={WAITING_REASONS}
        workCollapsedLaneIds={[]}
        toggleWorkLaneCollapsed={vi.fn()}
        workCollapsedSectionIds={[]}
        toggleWorkSectionCollapsed={vi.fn()}
        sessionsGroupedByLane={new Map([["lane-one", [one]], ["lane-two", [two]]])}
        {...props}
      />
    </MemoryRouter>,
  );
}

/** jsdom gives every element a zero rect, which makes every drop read "after". */
function stubLaneHeaderRect(): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function stub(this: HTMLElement) {
    if (this.hasAttribute("data-section-id")) {
      return {
        top: 100, bottom: 140, height: 40, left: 0, right: 200,
        width: 200, x: 0, y: 100, toJSON: () => ({}),
      } as DOMRect;
    }
    return original.call(this);
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

function fireLaneDrag(
  el: HTMLElement,
  type: "dragstart" | "dragover" | "drop" | "dragend",
  init: { clientY?: number; dataTransfer: unknown },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: init.clientY ?? 0 });
  Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer });
  fireEvent(el, event);
}

describe("WorkKanbanBoard", () => {
  afterEach(() => {
    cleanup();
    navigateSpy.mockClear();
    lanePrsByLaneIdForTest.clear();
    Reflect.deleteProperty(window, "ade");
  });

  it("renders all four columns with live counts and their accent markers", () => {
    renderBoard();

    expect(screen.getByTestId("work-kanban-board")).toBeTruthy();
    for (const [key, label] of [
      ["needs_you", "Needs you"],
      ["working", "Working"],
      ["waiting", "Waiting"],
      ["done", "Done"],
    ] as const) {
      // Scoped to the HEADER, not the column: a Done card's own status slot
      // also reads "Done", and the header is the thing under test here.
      const header = screen.getByTestId(`work-board-header-${key}`);
      const section = column(key);
      // Name and count carry the meaning, so the accent is never the only cue.
      expect(within(header).getByText(label)).toBeTruthy();
      expect(screen.getByTestId(`work-board-count-${key}`).textContent).toBe(
        String(FULL_BOARD[key].length),
      );
      // Keyboard-reachable, and spoken as what it is.
      expect(section.getAttribute("tabindex")).toBe("0");
      expect(section.getAttribute("aria-label")).toContain(label);
    }
    expect(screen.getByTestId("work-board-count-done").textContent).toBe("2");
  });

  it("puts each fixture session in exactly one column", () => {
    renderBoard();

    expect(within(column("needs_you")).getByTestId("work-board-card-s-needs")).toBeTruthy();
    expect(within(column("working")).getByTestId("work-board-card-s-cto")).toBeTruthy();
    expect(within(column("waiting")).getByTestId("work-board-card-s-ci")).toBeTruthy();
    expect(within(column("done")).getByTestId("work-board-card-s-ended")).toBeTruthy();
    expect(within(column("done")).getByTestId("work-board-card-s-settled")).toBeTruthy();
    expect(screen.getAllByTestId(/^work-board-card-[^r]/)).toHaveLength(5);
  });

  it("gives an empty column its header and one quiet line, not an empty state", () => {
    renderBoard({ workBoardBuckets: EMPTY_BOARD, workBoardWaitingReasons: new Map() });

    for (const key of ["needs_you", "working", "waiting", "done"] as const) {
      expect(column(key)).toBeTruthy();
      expect(screen.getByTestId(`work-board-count-${key}`).textContent).toBe("0");
      const placeholder = screen.getByTestId(`work-board-empty-${key}`);
      expect(placeholder.tagName).toBe("P");
      expect(placeholder.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(screen.queryAllByTestId(/^work-board-card-[^r]/)).toHaveLength(0);
  });

  it("carries the lane rail, the lane name and the PR pill onto a board card", () => {
    lanePrsByLaneIdForTest.set(laneBoundMachineKey("lane-ci"), [makePr()]);
    renderBoard();

    const card = screen.getByTestId("work-board-card-s-ci");
    // The rail is the board's own chrome; the lane NAME still comes from the
    // shared card, so the lane is never identified by colour alone.
    expect(within(card).getByTestId("work-board-card-rail-s-ci")).toBeTruthy();
    expect(card.querySelector('[data-session-lane-identity="Lane CI"]')).toBeTruthy();
    // The PR pill is `LanePrBadge`, reached by handing the card the singleton
    // options — not a second badge built for the board.
    expect(within(card).getByText("#4242")).toBeTruthy();
    // And the reason it is parked, in words.
    expect(within(card).getByTestId("work-board-waiting-s-ci").textContent).toContain("CI running");
  });

  it("keeps every card the same height so the four columns align", () => {
    renderBoard();
    // The footer is unconditional for exactly this reason: a footer that showed
    // up only for parked rows put the Waiting column out of step with the rest.
    for (const id of ["s-needs", "s-cto", "s-ci", "s-ended", "s-settled"]) {
      const card = screen.getByTestId(`work-board-card-${id}`);
      expect(card.querySelector(".h-4")).toBeTruthy();
    }
  });

  it("names the model beside the provider glyph on a board card", () => {
    renderBoard();
    const card = screen.getByTestId("work-board-card-s-cto");
    expect(within(card).getByTestId("session-model-label").textContent).toBe("Claude Opus 5");
    // A row whose provider reported no model shows no chip rather than a blank.
    expect(
      within(screen.getByTestId("work-board-card-s-needs")).queryByTestId("session-model-label"),
    ).toBeNull();
  });

  it("suppresses the per-card status label, which the column already states", () => {
    renderBoard();

    // A green check reading "Done" on a card sitting under the "Needs you"
    // heading does not merely repeat the column — it contradicts it, and the
    // column is the one that is right.
    for (const id of ["s-needs", "s-cto", "s-ci", "s-ended", "s-settled"]) {
      const card = screen.getByTestId(`work-board-card-${id}`);
      expect(card.querySelector("[data-session-status]")).toBeNull();
      expect(within(card).queryByText("Done")).toBeNull();
    }

    // The slot itself survives, because its hover actions (snooze / settle) are
    // a separate layer from the label and are not redundant with anything.
    expect(
      screen.getByTestId("work-board-card-s-needs").querySelector("[data-session-status-slot]"),
    ).toBeTruthy();
  });

  it("keeps the status word in the list, where no column states it", () => {
    // The suppression is board-only: a list row has no heading asserting its
    // status, so removing the word there would delete the fact outright.
    const { container } = renderListWithTwoLanes();
    expect(container.querySelector("[data-session-status]")).toBeTruthy();
  });

  it("gives the four columns equal flexible widths with a floor", () => {
    renderBoard();
    for (const key of ["needs_you", "working", "waiting", "done"] as const) {
      const cls = column(key).className;
      // `basis-0` is what makes them EQUAL: with the default `basis-auto` a
      // column holding a long chat title would claim more than its share.
      expect(cls).toContain("flex-1");
      expect(cls).toContain("basis-0");
      expect(cls).toContain("min-w-[15.5rem]");
      expect(cls).not.toContain("shrink-0");
    }
  });

  it("shows the agent note line on a board card", () => {
    renderBoard();
    const card = screen.getByTestId("work-board-card-s-needs");
    expect(
      card.querySelector('[data-session-preview-source="note"]')?.textContent,
    ).toContain("waiting on the schema call");
  });

  it("renders the CTO chip instead of the Subagent pill and routes it to /cto", () => {
    renderBoard();

    const card = screen.getByTestId("work-board-card-s-cto");
    const chip = within(card).getByTestId("session-cto-lineage");
    expect(chip.textContent).toContain("CTO");
    // The CTO answer is strictly more specific than "Subagent", so the generic
    // lineage pill must not also be there.
    expect(within(card).queryByTestId("session-spawn-lineage")).toBeNull();
    // The excerpt of what the child was asked rides on the chip's title.
    expect(chip.getAttribute("title")).toContain("Audit the release pipeline");

    fireEvent.click(chip);
    expect(navigateSpy).toHaveBeenCalledWith("/cto");
  });

  it("opens the chat on a card click, through the list's own selection path", () => {
    const onSelectSession = vi.fn();
    renderBoard({ onSelectSession });

    fireEvent.click(screen.getByRole("button", { name: "Needs a decision" }));
    expect(onSelectSession).toHaveBeenCalledWith(
      "s-needs",
      expect.anything(),
      // The visible set is the board's reading order: columns left to right.
      ["s-needs", "s-cto", "s-ci", "s-ended", "s-settled"],
    );
  });

  it("opens the shared session context menu on right click", () => {
    const onContextMenu = vi.fn();
    renderBoard({ onContextMenu });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Needs a decision" }));
    expect(onContextMenu).toHaveBeenCalled();
    expect((onContextMenu.mock.calls[0]![0] as TerminalSessionSummary).id).toBe("s-needs");
    // The lane section rides along, exactly as it does for a singleton row —
    // no capability is lost in board mode.
    expect(onContextMenu.mock.calls[0]![4]).toMatchObject({ laneId: "lane-a" });
  });

  it("routes a drop on Done through the one board-move action", () => {
    // Not `sessions.settle`, and deliberately: a board move is a lifecycle
    // write AND the message the agent reacts to, and the host stages them
    // together so neither can land alone. A renderer that wrote the lifecycle
    // half directly would be the divergence the action exists to prevent.
    const moveOnBoard = vi.fn().mockResolvedValue({ ok: true, changed: true, moveId: "move-1" });
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { sessions: { moveOnBoard, undoBoardMove: vi.fn() } },
    });
    renderBoard();

    const dt = transfer();
    fireDrag(dragSource("s-needs"), "dragstart", dt);
    expect(dt.setData).toHaveBeenCalledWith(WORK_BOARD_DND_MIME, "s-needs");

    const over = fireDrag(column("done"), "dragover", dt);
    expect(over.defaultPrevented).toBe(true);
    expect(column("done").getAttribute("data-column-active")).toBe("true");

    // "This column accepts it" AND "it goes here" — the column tint alone does
    // not say where the card lands.
    expect(screen.getByTestId("work-board-drop-indicator-done")).toBeTruthy();

    fireDrag(column("done"), "drop", dt);
    expect(moveOnBoard).toHaveBeenCalledTimes(1);
    expect(moveOnBoard.mock.calls[0]!.slice(0, 2)).toEqual(["s-needs", "done"]);
  });

  it("sends the action's column name for Needs you, not the board's label", () => {
    const moveOnBoard = vi.fn().mockResolvedValue({ ok: true, changed: false, moveId: null });
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { sessions: { moveOnBoard, undoBoardMove: vi.fn() } },
    });
    renderBoard();

    const dt = transfer();
    fireDrag(dragSource("s-ended"), "dragstart", dt);
    fireDrag(column("needs_you"), "dragover", dt);
    fireDrag(column("needs_you"), "drop", dt);
    expect(moveOnBoard.mock.calls[0]!.slice(0, 2)).toEqual(["s-ended", "needs_you"]);
  });

  it("refuses a drop on Waiting and shows no drop affordance over it", () => {
    renderBoard();

    const dt = transfer();
    fireDrag(dragSource("s-needs"), "dragstart", dt);
    const over = fireDrag(column("waiting"), "dragover", dt);

    // Not preventDefault'd → not a drop target at all, so the browser draws
    // "no drop" for free and nothing lights up.
    expect(over.defaultPrevented).toBe(false);
    expect(column("waiting").getAttribute("data-column-active")).toBeNull();
    expect(screen.queryByTestId("work-board-drop-indicator-waiting")).toBeNull();
  });

  it("ignores a drag that is not a board move", () => {
    renderBoard();
    const dt = transfer(["application/x-ade-grid-session"]);
    const over = fireDrag(column("done"), "dragover", dt);
    expect(over.defaultPrevented).toBe(false);
    expect(column("done").getAttribute("data-column-active")).toBeNull();
  });

  it("does not light up the column a card is already in", () => {
    renderBoard();
    const dt = transfer();
    fireDrag(dragSource("s-ended"), "dragstart", dt);
    const over = fireDrag(column("done"), "dragover", dt);
    expect(over.defaultPrevented).toBe(false);
    expect(column("done").getAttribute("data-column-active")).toBeNull();
  });

  it("offers the list/board toggle and reports which half is active", () => {
    const setWorkViewMode = vi.fn();
    renderBoard({ setWorkViewMode });

    const boardButton = screen.getByTestId("work-view-mode-board");
    const listButton = screen.getByTestId("work-view-mode-list");
    expect(boardButton.getAttribute("aria-pressed")).toBe("true");
    expect(listButton.getAttribute("aria-pressed")).toBe("false");
    // Icon-only, so each half has to carry its own accessible name.
    expect(boardButton.getAttribute("aria-label")).toBe("Board view");

    fireEvent.click(listButton);
    expect(setWorkViewMode).toHaveBeenCalledWith("list");
  });

  /* ────────────────────────────────────────────────────────────────────────
     REGRESSION GUARD — the shared DataTransfer must not corrupt lane order.

     One drag gesture now carries two payloads on one `DataTransfer`: the grid
     mime the card has always written, and the board mime the tile adds on
     capture. Lane reorder reads a THIRD mime off the same object. If any of
     those three could be confused for another, a stray drop would rewrite the
     user's manual lane order — strictly worse than any board bug, because lane
     order is persisted state with no undo.
     ──────────────────────────────────────────────────────────────────────── */

  it("writes both the grid and board payloads onto one DataTransfer, and neither is the lane mime", () => {
    renderBoard();
    const dt = recordingTransfer();
    fireDrag(dragSource("s-needs"), "dragstart", dt);

    // The whole "one gesture, two meanings" claim, stated as data.
    expect(dt.types).toContain(GRID_SESSION_DND_MIME);
    expect(dt.types).toContain(WORK_BOARD_DND_MIME);
    expect(dt.getData(GRID_SESSION_DND_MIME)).toBe("s-needs");
    expect(dt.getData(WORK_BOARD_DND_MIME)).toBe("s-needs");
    // And the payload lane reorder keys on is simply not there.
    expect(dt.types).not.toContain(ADE_WORK_LANE_DND_MIME);
    expect(dt.getData(ADE_WORK_LANE_DND_MIME)).toBe("");
  });

  it("leaves lane reorder untouched when a real board drag is dropped on a lane header", () => {
    // Capture what a board card ACTUALLY writes, then replay that exact
    // transfer at a lane-reorder target — the real cross-surface path.
    const board = renderBoard();
    const dt = recordingTransfer();
    fireDrag(dragSource("s-needs"), "dragstart", dt);
    board.unmount();

    const reorderWorkLanes = vi.fn();
    const { container } = renderListWithTwoLanes({ reorderWorkLanes });
    const restoreRect = stubLaneHeaderRect();
    const target = container.querySelector('[data-section-id="lane-two"]') as HTMLElement;
    expect(target).toBeTruthy();

    fireLaneDrag(target, "dragover", { dataTransfer: dt, clientY: 105 });
    // No indicator: `onDragOver` is mime-guarded, so `laneDrop` never gets set,
    // which is what makes the unguarded `onDrop` below a no-op.
    expect(container.querySelector('[data-testid^="lane-drop-indicator"]')).toBeNull();

    fireLaneDrag(target, "drop", { dataTransfer: dt, clientY: 105 });
    expect(reorderWorkLanes).not.toHaveBeenCalled();

    restoreRect();
  });

  it("still reorders lanes normally for a genuine lane drag", () => {
    // The other half of the guard: proving the board did not BREAK lane
    // reorder is only meaningful alongside proving lane reorder still works.
    const reorderWorkLanes = vi.fn();
    const { container } = renderListWithTwoLanes({ reorderWorkLanes });
    const restoreRect = stubLaneHeaderRect();
    const source = container.querySelector('[data-section-id="lane-two"]') as HTMLElement;
    const target = container.querySelector('[data-section-id="lane-one"]') as HTMLElement;

    const dt = recordingTransfer();
    fireLaneDrag(source, "dragstart", { dataTransfer: dt });
    expect(dt.getData(ADE_WORK_LANE_DND_MIME)).toBe("lane-two");

    fireLaneDrag(target, "dragover", { dataTransfer: dt, clientY: 105 });
    expect(container.querySelector('[data-testid="lane-drop-indicator-before"]')).toBeTruthy();

    fireLaneDrag(target, "drop", { dataTransfer: dt, clientY: 105 });
    expect(reorderWorkLanes).toHaveBeenCalledWith({
      movedLaneId: "lane-two",
      targetLaneId: "lane-one",
      edge: "before",
      renderedLaneIds: ["lane-one", "lane-two"],
    });

    restoreRect();
  });

  it("ignores a lane-reorder payload dropped on a board column", () => {
    // The mirror image: a lane drag must not be readable as a board move.
    const settle = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ade", { configurable: true, value: { sessions: { settle } } });
    renderBoard();

    const dt = recordingTransfer();
    dt.setData(ADE_WORK_LANE_DND_MIME, "lane-a");
    const over = fireDrag(column("done"), "dragover", dt);

    expect(over.defaultPrevented).toBe(false);
    expect(column("done").getAttribute("data-column-active")).toBeNull();
    fireDrag(column("done"), "drop", dt);
    expect(settle).not.toHaveBeenCalled();
  });

  it("falls back to the list when board columns were never supplied", () => {
    renderBoard({ workBoardBuckets: undefined });
    expect(screen.queryByTestId("work-kanban-board")).toBeNull();
    // A pane that cannot be handed board data must not advertise a board either.
    expect(screen.queryByTestId("work-view-mode-toggle")).toBeNull();
  });
});
