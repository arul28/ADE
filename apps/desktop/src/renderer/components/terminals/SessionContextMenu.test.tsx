/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { LaneSummary, OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { SUBMENU_CLOSE_DELAY_MS, SUBMENU_OPEN_DELAY_MS } from "../ui/MenuSubmenu";
import {
  SessionContextMenu,
  type SessionContextMenuLaneActions,
} from "./SessionContextMenu";

/**
 * The lane submenu reads the lane out of the store rather than being handed a
 * copy, so the store is the fixture for anything that renders it.
 */
const soloLane = {
  id: "lane-solo",
  name: "Solo lane",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "refs/heads/solo-lane",
  worktreePath: "/tmp/solo-lane",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  color: null,
  icon: null,
  tags: [],
  createdAt: "2026-07-10T10:00:00.000Z",
} satisfies LaneSummary;

let storeLanes: LaneSummary[] = [soloLane];

const { setWorkViewState, selectLane, refreshLanes } = vi.hoisted(() => ({
  setWorkViewState: vi.fn(),
  selectLane: vi.fn(),
  refreshLanes: vi.fn(),
}));

vi.mock("../../state/appStore", async () => {
  const actual = await vi.importActual<typeof import("../../state/appStore")>("../../state/appStore");
  return {
    ...actual,
    useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        lanes: storeLanes,
        project: { rootPath: "/project" },
        projectBinding: { kind: "local", key: "/project", rootPath: "/project" },
        selectLane,
        setWorkViewState,
        refreshLanes,
      }),
  };
});

/** React routes pointer enter/leave through pointerover/pointerout. */
function hover(element: Element) {
  fireEvent.pointerOver(element);
}
function unhover(element: Element, to: Element | null = null) {
  fireEvent.pointerOut(element, { relatedTarget: to });
}

afterEach(() => {
  cleanup();
  storeLanes = [soloLane];
  setWorkViewState.mockReset();
  selectLane.mockReset();
  refreshLanes.mockReset();
});

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "chat-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat",
    title: "Claude chat",
    status: "running",
    startedAt: "2026-07-10T12:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
    ...overrides,
  };
}

function renderMenu(
  session: TerminalSessionSummary,
  {
    onSetChatTag = vi.fn(),
    onSettle = vi.fn(),
    binding,
    laneActions,
    onRegenerateMetadata,
    laneType,
  }: {
    onSetChatTag?: ReturnType<typeof vi.fn>;
    onSettle?: ReturnType<typeof vi.fn>;
    binding?: OpenProjectBinding | null;
    laneActions?: SessionContextMenuLaneActions | null;
    onRegenerateMetadata?: ReturnType<typeof vi.fn>;
    laneType?: LaneSummary["laneType"] | null;
  } = {},
) {
  const onClose = vi.fn();
  const onCopySessionId = vi.fn();
  const onCopySessionDeepLink = vi.fn();
  const onGoToLane = vi.fn();
  const onRename = vi.fn();
  render(
    <MemoryRouter>
      <SessionContextMenu
        menu={{ session, binding, laneActions, laneType, x: 20, y: 20 }}
        onClose={onClose}
        onStopRuntime={vi.fn()}
        onStopAndDelete={vi.fn()}
        onDeleteChat={vi.fn()}
        onDeleteSession={vi.fn()}
        deletingSessionId={null}
        onGoToLane={onGoToLane}
        onCopySessionId={onCopySessionId}
        onCopySessionDeepLink={onCopySessionDeepLink}
        onRename={onRename}
        onRegenerateMetadata={onRegenerateMetadata}
        onSetChatTag={onSetChatTag}
        onSettle={onSettle}
      />
    </MemoryRouter>,
  );
  return {
    onClose,
    onSetChatTag,
    onSettle,
    onCopySessionId,
    onCopySessionDeepLink,
    onGoToLane,
    onRename,
    onRegenerateMetadata,
  };
}

/** Opens a submenu the way a pointer user would: hover, then wait out the intent delay. */
function openSubmenuByHover(trigger: Element) {
  hover(trigger);
  act(() => { vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS + 10); });
}

describe("SessionContextMenu Claude tags", () => {
  it("opens an inline input and treats an empty submit as clearing the tag", () => {
    const session = makeSession({ claudeTag: "review-ready" });
    const { onClose, onSetChatTag } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Set tag…" }));
    const input = screen.getByRole("textbox", { name: "Set Claude session tag" }) as HTMLInputElement;
    expect(input.value).toBe("review-ready");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetChatTag).toHaveBeenCalledWith(session, null, null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits a non-empty tag for the session", () => {
    const session = makeSession();
    const { onClose, onSetChatTag } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Set tag…" }));
    const input = screen.getByRole("textbox", { name: "Set Claude session tag" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "review-ready" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetChatTag).toHaveBeenCalledWith(session, "review-ready", null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer SDK tags for non-Claude chat sessions", () => {
    renderMenu(makeSession({ toolType: "codex-chat" }));
    expect(screen.queryByRole("button", { name: "Set tag…" })).toBeNull();
  });

  it("does not offer SDK tags for ended Claude sessions", () => {
    // Tag writes need a live Claude SDK runtime; the menu gates on running.
    renderMenu(makeSession({ status: "disposed", endedAt: "2026-07-10T13:00:00.000Z" }));
    expect(screen.queryByRole("button", { name: "Set tag…" })).toBeNull();
  });
});

describe("SessionContextMenu lane section", () => {
  const laneActions: SessionContextMenuLaneActions = {
    laneId: "lane-solo",
    laneName: "Solo lane",
    open: vi.fn(),
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("expands the real lane menu items in a submenu rather than a second menu", () => {
    renderMenu(makeSession(), { laneActions });

    const entry = screen.getByTestId("session-menu-lane-actions");
    // Names the lane, so a menu opened from a card still says which lane it acts on.
    expect(entry.textContent).toContain("Solo lane");

    openSubmenuByHover(entry);

    // These come from `buildLaneMenuGroups`, the same source the lane divider's
    // own menu renders — the assertion is that the submenu is that menu, not a
    // transcription of it.
    expect(screen.getByRole("menuitem", { name: "Start chat in lane" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage Lane" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Open in web" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Select All Lanes/ })).toBeTruthy();
    // Colour palette survived the move into the submenu.
    expect(screen.getAllByRole("button", { name: /Rainbow|Sky|Amber|Rose/ }).length).toBeGreaterThan(0);
  });

  it("keeps the deep lane copy links reachable through a nested submenu", () => {
    renderMenu(makeSession(), { laneActions });

    openSubmenuByHover(screen.getByTestId("session-menu-lane-actions"));
    openSubmenuByHover(screen.getByRole("menuitem", { name: "Copy" }));

    expect(screen.getByRole("menuitem", { name: "Copy ADE Lane Link" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy Branch Link (Cross-Machine)" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy Path" })).toBeTruthy();
  });

  it("falls back to the real lane menu portal for a lane it cannot resolve", () => {
    // A lane with neither a store row nor a passed-in summary still has to
    // hand off to the portal that owns it.
    storeLanes = [];
    const open = vi.fn();
    const { onClose } = renderMenu(
      makeSession(),
      { laneActions: { laneId: "lane-solo", laneName: "Solo lane", open } },
    );

    openSubmenuByHover(screen.getByTestId("session-menu-lane-actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open lane menu…" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ x: 20, y: 20 });
  });

  it("renders the full lane menu for a foreign lane passed in by the host", () => {
    storeLanes = [];
    const foreignLane = {
      ...soloLane,
      id: "lane-studio",
      name: "Studio lane",
      worktreePath: "/Users/studio/ADE/.ade/worktrees/studio-lane",
    } satisfies LaneSummary;
    const binding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:ade",
      targetId: "studio",
      projectId: "ade",
      rootPath: "/Users/studio/ADE",
      displayName: "ADE",
      runtimeName: "Studio",
      hostname: "studio.local",
    };
    renderMenu(makeSession(), {
      laneActions: {
        laneId: foreignLane.id,
        laneName: foreignLane.name,
        lane: foreignLane,
        binding,
        machineId: "studio",
        open: vi.fn(),
      },
    });

    openSubmenuByHover(screen.getByTestId("session-menu-lane-actions"));

    expect(screen.getByRole("menuitem", { name: "Start chat in lane" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage Lane" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open lane menu…" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Select All Lanes/ })).toBeNull();
  });

  it("starts a chat draft on the owning machine from the Lane submenu", () => {
    storeLanes = [];
    const foreignLane = {
      ...soloLane,
      id: "lane-studio",
      name: "Studio lane",
    } satisfies LaneSummary;
    renderMenu(makeSession(), {
      laneActions: {
        laneId: foreignLane.id,
        laneName: foreignLane.name,
        lane: foreignLane,
        binding: {
          kind: "remote",
          key: "remote:studio:ade",
          targetId: "studio",
          projectId: "ade",
          rootPath: "/Users/studio/ADE",
          displayName: "ADE",
          runtimeName: "Studio",
        },
        machineId: "studio",
        open: vi.fn(),
      },
    });

    openSubmenuByHover(screen.getByTestId("session-menu-lane-actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start chat in lane" }));

    expect(setWorkViewState).toHaveBeenCalled();
    const updater = setWorkViewState.mock.calls[0]?.[1] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(updater({})).toMatchObject({
      draftKind: "chat",
      draftLaneId: "lane-studio",
      draftMachineId: "studio",
      activeItemId: null,
    });
    expect(selectLane).not.toHaveBeenCalled();
  });

  it("puts a glanceable icon on every top-level action", () => {
    renderMenu(makeSession());
    for (const name of ["Rename", "Go to lane", "Snooze…", "Delete chat"]) {
      expect(screen.getByRole("button", { name }).querySelector("[data-menu-icon]")).toBeTruthy();
    }
  });

  it("omits the lane section for a row whose lane still has a divider", () => {
    // Not a singleton: the lane header is on screen and owns lane management,
    // so duplicating it into every row's session menu would be pure noise.
    renderMenu(makeSession());
    expect(screen.queryByTestId("session-menu-lane-actions")).toBeNull();
  });
});

describe("SessionContextMenu submenu interaction", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits out the intent delay instead of firing on a pass-over", () => {
    renderMenu(makeSession());
    const trigger = screen.getByRole("button", { name: "Snooze…" });

    hover(trigger);
    act(() => { vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS - 40); });
    // Still nothing: the cursor merely crossed the row on its way somewhere else.
    expect(screen.queryByRole("button", { name: /^In 1 hour/ })).toBeNull();

    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.getByRole("button", { name: /^In 1 hour/ })).toBeTruthy();
  });

  it("cancels the pending open when the pointer leaves before the delay", () => {
    renderMenu(makeSession());
    const trigger = screen.getByRole("button", { name: "Snooze…" });

    hover(trigger);
    act(() => { vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS - 40); });
    unhover(trigger);
    act(() => { vi.advanceTimersByTime(500); });

    expect(screen.queryByRole("button", { name: /^In 1 hour/ })).toBeNull();
  });

  it("stays open while the pointer travels diagonally from the row to the panel", () => {
    renderMenu(makeSession());
    const trigger = screen.getByRole("button", { name: "Snooze…" });
    openSubmenuByHover(trigger);
    const panel = screen.getByRole("button", { name: /^In 1 hour/ }).closest("[role=menu]")!;

    // The diagonal crosses rows that are neither the trigger nor the panel, so
    // the panel has to survive a gap with the pointer over nothing.
    unhover(trigger);
    act(() => { vi.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS - 60); });
    hover(panel);
    act(() => { vi.advanceTimersByTime(1_000); });

    expect(screen.getByRole("button", { name: /^In 1 hour/ })).toBeTruthy();
  });

  it("closes once the pointer has left both the row and the panel", () => {
    renderMenu(makeSession());
    const trigger = screen.getByRole("button", { name: "Snooze…" });
    openSubmenuByHover(trigger);
    const panel = screen.getByRole("button", { name: /^In 1 hour/ }).closest("[role=menu]")!;

    unhover(panel);
    act(() => { vi.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS + 20); });

    expect(screen.queryByRole("button", { name: /^In 1 hour/ })).toBeNull();
  });

  it("opens on ArrowRight and closes on Escape without dismissing the parent menu", () => {
    const { onClose } = renderMenu(makeSession());
    const trigger = screen.getByRole("button", { name: "Snooze…" });

    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const first = screen.getByRole("button", { name: /^In 1 hour/ });
    expect(first).toBeTruthy();
    // Keyboard opens move focus into the panel; pointer opens deliberately do not.
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /^In 1 hour/ })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // Escape belongs to the submenu it closed, not to the menu behind it.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus between panel rows with the arrow keys", () => {
    renderMenu(makeSession());
    fireEvent.keyDown(screen.getByRole("button", { name: "Snooze…" }), { key: "ArrowRight" });
    const rows = screen.getAllByRole("button").filter((button) =>
      button.closest("[role=menu]") !== null);

    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
  });
});

describe("SessionContextMenu grouped actions", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps every copy action invocable behind the Copy submenu", () => {
    const session = makeSession();
    const { onCopySessionId, onCopySessionDeepLink } = renderMenu(session);

    openSubmenuByHover(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Session ID" }));
    expect(onCopySessionId).toHaveBeenCalledWith("chat-1");

    openSubmenuByHover(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Session deep link" }));
    expect(onCopySessionDeepLink).toHaveBeenCalledWith(session);
  });

  it("keeps the flat menu's top-level actions on the top level", () => {
    const session = makeSession();
    const { onGoToLane } = renderMenu(session);

    for (const name of ["Rename", "Go to lane", "Snooze…", "Delete chat"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Go to lane" }));
    expect(onGoToLane).toHaveBeenCalledWith(session, null);
  });

  it("groups manual rename and the three AI metadata choices together", () => {
    const session = makeSession();
    const onRegenerateMetadata = vi.fn();
    const { onClose } = renderMenu(session, { onRegenerateMetadata });

    openSubmenuByHover(screen.getByTestId("session-menu-name-status"));

    expect(screen.getByRole("button", { name: "Rename…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate chat title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate lane name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate status line" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate all three" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Generate all three" }));

    expect(onRegenerateMetadata).toHaveBeenCalledWith(
      session,
      ["title", "laneName", "statusLine"],
      null,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps manual rename in the Name & status submenu", () => {
    const session = makeSession();
    const onRegenerateMetadata = vi.fn();
    const { onClose, onRename } = renderMenu(session, { onRegenerateMetadata });

    openSubmenuByHover(screen.getByTestId("session-menu-name-status"));
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));

    const input = screen.getByRole("textbox", { name: "Rename session" });
    expect(screen.queryByRole("button", { name: "Generate all three" })).toBeNull();
    fireEvent.change(input, { target: { value: "A clearer title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith(session, "A clearer title", null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("explains why lane-name generation is disabled for the primary lane", () => {
    const onRegenerateMetadata = vi.fn();
    renderMenu(makeSession(), { onRegenerateMetadata, laneType: "primary" });

    openSubmenuByHover(screen.getByTestId("session-menu-name-status"));
    const laneNameButton = screen.getByRole("button", { name: "Generate lane name" });

    expect((laneNameButton as HTMLButtonElement).disabled).toBe(true);
    expect(laneNameButton.getAttribute("title")).toBe("The primary lane keeps its name");
    expect(onRegenerateMetadata).not.toHaveBeenCalled();
  });

  it("omits the immutable primary lane name from combined generation", () => {
    const session = makeSession();
    const onRegenerateMetadata = vi.fn();
    const { onClose } = renderMenu(session, { onRegenerateMetadata, laneType: "primary" });

    openSubmenuByHover(screen.getByTestId("session-menu-name-status"));
    expect(screen.getByRole("button", { name: "Generate title & status" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate all three" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Generate title & status" }));

    expect(onRegenerateMetadata).toHaveBeenCalledWith(session, ["title", "statusLine"], null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-resolves the snooze presets every time the submenu opens", () => {
    // 09:00 offers "This evening"; 21:00 must not, because it would silently
    // mean tomorrow. The presets are a snapshot of the clock at open time, so
    // re-opening after the boundary has to produce the later list.
    vi.setSystemTime(new Date("2026-07-30T09:00:00"));
    renderMenu(makeSession());
    const trigger = screen.getByRole("button", { name: "Snooze…" });

    openSubmenuByHover(trigger);
    expect(screen.queryByRole("button", { name: /^This evening/ })).toBeTruthy();

    unhover(trigger);
    act(() => { vi.advanceTimersByTime(SUBMENU_CLOSE_DELAY_MS + 20); });
    vi.setSystemTime(new Date("2026-07-30T21:00:00"));
    openSubmenuByHover(trigger);

    expect(screen.queryByRole("button", { name: /^This evening/ })).toBeNull();
  });
});

describe("SessionContextMenu settle safety", () => {
  it("offers Dismiss & settle when a chat is waiting on input", () => {
    const session = makeSession({
      runtimeState: "waiting-input",
      pendingInputItemId: "pending-1",
    });
    const { onSettle } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss & settle" }));
    expect(onSettle).toHaveBeenCalledWith(session, null);
  });

  it("does not infer dismissible input from a provider runtime marker", () => {
    renderMenu(makeSession({
      toolType: "codex-chat",
      runtimeState: "waiting-input",
      pendingInputItemId: null,
    }));
    expect(screen.queryByRole("button", { name: "Dismiss & settle" })).toBeNull();
  });

  it("passes the owning machine binding directly to deferred lifecycle actions", () => {
    const session = makeSession({
      runtimeState: "waiting-input",
      pendingInputItemId: "pending-1",
    });
    const binding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:ade",
      targetId: "studio",
      projectId: "ade",
      rootPath: "/Users/studio/ADE",
      displayName: "ADE",
      runtimeName: "Studio",
      hostname: "studio.local",
    };
    const onSettle = vi.fn();
    renderMenu(session, { onSettle, binding });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss & settle" }));

    expect(onSettle).toHaveBeenCalledWith(session, binding);
  });

  it("allows an explicit agent ask to settle because settling clears the marker", () => {
    renderMenu(makeSession({
      runtimeState: "waiting-input",
      pendingInputItemId: null,
      attentionRequestedAt: "2026-07-23T12:00:00.000Z",
      attentionMessage: "Review this result?",
    }));

    expect(screen.getByRole("button", { name: "Dismiss & settle" })).toBeTruthy();
  });

  it("does not infer a native CLI prompt from the runtime marker", () => {
    const onSettle = vi.fn();
    renderMenu(makeSession({
      toolType: "codex",
      runtimeState: "waiting-input",
      pendingInputItemId: null,
      attentionRequestedAt: null,
    }), { onSettle });

    expect(screen.queryByRole("button", { name: "Resolve input to settle" })).toBeNull();
    expect(onSettle).not.toHaveBeenCalled();
  });
});

describe("SessionContextMenu snooze and explicit-settle lifecycle", () => {
  let sessionsApi: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    sessionsApi = {
      setSettleOverride: vi.fn().mockResolvedValue(true),
      snoozeSession: vi.fn().mockResolvedValue(true),
      wakeSession: vi.fn().mockResolvedValue(true),
      unsettle: vi.fn().mockResolvedValue(undefined),
    };
    (window as unknown as { ade: unknown }).ade = { sessions: sessionsApi };
  });

  afterEach(() => {
    delete (window as unknown as { ade?: unknown }).ade;
    vi.clearAllMocks();
  });

  it("keeps the declared-settle path for settledAt rows and adds a keep-active pin", async () => {
    const session = makeSession({
      toolType: "shell",
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-07-10T12:30:00.000Z",
      exitCode: 0,
      settledAt: "2026-07-10T12:31:00.000Z",
    });
    renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Unsettle" }));
    await waitFor(() => expect(sessionsApi.unsettle).toHaveBeenCalledWith("chat-1"));
    expect(sessionsApi.setSettleOverride).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep active" }));
    await waitFor(() => {
      expect(sessionsApi.setSettleOverride).toHaveBeenCalledWith("chat-1", "active");
    });
  });

  it("expands Snooze into concrete durations and sends an ISO deadline", async () => {
    renderMenu(makeSession());

    fireEvent.click(screen.getByRole("button", { name: "Snooze…" }));
    // Prefix match on the label: presets may carry a locale-formatted time
    // alongside it, which an exact accessible name would make brittle.
    fireEvent.click(screen.getByRole("button", { name: /^In 1 hour/ }));

    await waitFor(() => expect(sessionsApi.snoozeSession).toHaveBeenCalledTimes(1));
    const [sessionId, untilIso] = sessionsApi.snoozeSession.mock.calls[0]!;
    expect(sessionId).toBe("chat-1");
    expect(Date.parse(untilIso as string)).toBeGreaterThan(Date.now());
  });

  it("replaces Snooze with Wake now while the row is snoozed", async () => {
    renderMenu(makeSession({
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    expect(screen.queryByRole("button", { name: "Snooze…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Wake now/ }));

    await waitFor(() => {
      expect(sessionsApi.wakeSession).toHaveBeenCalledWith("chat-1", "manual");
    });
  });
});

describe("SessionContextMenu spawn kind", () => {
  let updateSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateSession = vi.fn().mockResolvedValue({ spawnKind: "peer" });
    (window as unknown as { ade: unknown }).ade = {
      agentChat: { updateSession },
      sessions: {},
    };
  });

  afterEach(() => {
    delete (window as unknown as { ade?: unknown }).ade;
    vi.clearAllMocks();
  });

  it("offers Demote to peer on a subagent child and writes spawnKind peer", async () => {
    const session = makeSession({
      orchestrationParentSessionId: "parent-1",
      spawnKind: "subagent",
    });
    const { onClose } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Demote to peer" }));
    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(
        { sessionId: "chat-1", spawnKind: "peer" },
      );
    });
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Promote to subagent" })).toBeNull();
  });

  it("offers Promote to subagent on a peer child", async () => {
    const session = makeSession({
      orchestrationParentSessionId: "parent-1",
      spawnKind: "peer",
    });
    renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Promote to subagent" }));
    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(
        { sessionId: "chat-1", spawnKind: "subagent" },
      );
    });
    expect(screen.queryByRole("button", { name: "Demote to peer" })).toBeNull();
  });

  it("hides demote and promote on a chat with no parent", () => {
    renderMenu(makeSession({ spawnKind: "subagent" }));
    expect(screen.queryByRole("button", { name: "Demote to peer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Promote to subagent" })).toBeNull();
  });
});
