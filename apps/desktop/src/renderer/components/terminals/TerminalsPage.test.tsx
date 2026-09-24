/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatSession,
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import type { AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { TerminalsPage } from "./TerminalsPage";
import { confirmDialog } from "../ui/dialog/confirm";

vi.mock("../ui/dialog/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/dialog/confirm")>()),
  confirmDialog: vi.fn(async () => false),
}));
import {
  ProjectSidebarSlotProvider,
  useProjectSidebarSlotTarget,
} from "../app/projectSidebar/ProjectSidebarSlot";
import { setProjectSidebarHidden } from "../app/projectSidebar/projectSidebarPrefs";
import {
  forgetWorkPtyLaunchPin,
  rememberWorkPtyLaunchPin,
  workPtyLaunchPinFor,
} from "./cliLaunch";
import {
  resetRemoteBrowserOpensForTests,
  takeHeldRemoteBrowserOpen,
} from "../../lib/pendingRemoteBrowserOpens";
import type { BuiltInBrowserRemoteRequest } from "../../../shared/types/builtInBrowserRemote";
import type { WorkToolShowRequest } from "../../../shared/types/workToolShow";
import {
  answerWorkToolShowRequest,
  resetWorkToolShowRequestsForTests,
} from "../../lib/workToolShowRequests";
import {
  noteFloatingWorkSurfaceShown,
  noteWorkSurfaceMounted,
  resetWorkToolOnScreenForTests,
  setDocumentVisibleForTests,
  workSurfaceKey,
} from "../../lib/workToolOnScreen";
import {
  MAC_DESKTOP_CARD_ON_SCREEN_KEY,
  macDesktopCardGrantedAt,
  resetMacDesktopCardGrantsForTests,
} from "../work/macDesktopCardGrants";
import {
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";

/** A tool laid out in a visible pane, as far as a show can measure it. */
function mountTool(tool: string, laneId: string): void {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({ width: 400, height: 600 }) as DOMRect;
  document.body.appendChild(element);
  noteWorkSurfaceMounted(workSurfaceKey(tool, "bound", laneId), element);
}

const crossMachineMocks = vi.hoisted(() => ({
  cancelOptimistic: vi.fn(),
  seedOptimistic: vi.fn(),
}));

vi.mock("../../state/crossMachineLanes", async () => ({
  ...(await vi.importActual<typeof import("../../state/crossMachineLanes")>(
    "../../state/crossMachineLanes",
  )),
  cancelCrossMachineOptimisticChatSession: crossMachineMocks.cancelOptimistic,
  seedCrossMachineOptimisticChatSession: crossMachineMocks.seedOptimistic,
}));

const workMocks = vi.hoisted(() => {
  const makeChatSession = (id: string, laneId: string): AgentChatSession => ({
    id,
    laneId,
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4",
    status: "idle",
    sessionProfile: "workflow",
    reasoningEffort: "xhigh",
    executionMode: "focused",
    createdAt: "2026-05-14T18:00:00.000Z",
    lastActivityAt: "2026-05-14T18:00:00.000Z",
  });
  const makeTerminalSession = (
    id: string,
    laneId: string,
    toolType: TerminalToolType,
    overrides: Partial<TerminalSessionSummary> = {},
  ): TerminalSessionSummary => ({
    id,
    laneId,
    laneName: laneId === "lane-primary" ? "Primary" : "Background lane",
    ptyId: toolType === "codex-chat" ? null : `pty-${id}`,
    tracked: true,
    pinned: false,
    goal: null,
    toolType,
    title: id,
    status: "running",
    startedAt: "2026-05-14T18:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "/tmp/transcript",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  });
  const laneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false };
  const makeLane = (id: string, name: string, laneType: LaneSummary["laneType"] = "worktree"): LaneSummary => ({
    id,
    name,
    description: null,
    laneType,
    baseRef: "main",
    branchRef: id === "lane-primary" ? "main" : `ade/${id}`,
    worktreePath: `/tmp/${id}`,
    attachedRootPath: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    parentLaneId: null,
    color: null,
    icon: null,
    tags: [],
    folder: null,
    status: laneStatus,
    createdAt: "2026-05-14T18:00:00.000Z",
    archivedAt: null,
    activeBranchProfile: null,
    linearIssue: null,
  });

  const fns = {
    selectLane: vi.fn(),
    focusSession: vi.fn(),
    openSessionTab: vi.fn(),
    upsertOptimisticChatSession: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    switchRemoteProject: vi.fn().mockResolvedValue(undefined),
    switchProjectToPath: vi.fn().mockResolvedValue(undefined),
    setWorkViewState: vi.fn(),
    setLaneWorkViewState: vi.fn(),
    setWorkViewMode: vi.fn(),
  };

  const baseWork = {
    lanes: [
      makeLane("lane-primary", "Primary", "primary"),
      makeLane("lane-background", "Background lane"),
    ],
    sessions: [],
    visibleSessions: [],
    tabGroups: [],
    runningFiltered: [],
    awaitingInputFiltered: [],
    endedFiltered: [],
    settledFiltered: [],
    runningSessions: [],
    filtered: [],
    sessionsGroupedByLane: [],
    loading: false,
    canPruneSessionIndex: () => true,
    gridLayoutId: "work-grid",
    gridSets: [],
    setGridSets: vi.fn(),
    activeItemId: null,
    selectedSessionId: null,
    draftKind: "chat",
    draftLaneId: null,
    filterLaneId: "all",
    q: "",
    sessionListOrganization: "by-lane",
    workViewMode: "list",
    workBoardBuckets: {
      needs_you: [], working: [], waiting: [], done: [],
    },
    workBoardWaitingReasons: new Map(),
    workCollapsedLaneIds: [],
    workCollapsedSectionIds: [],
    workSidebarOpen: false,
    workSidebarWidthPct: 36,
    pinnedSessionIds: [],
    closingPtyIds: new Set<string>(),
    setSelectedSessionId: vi.fn(),
    setActiveItemId: vi.fn(),
    closeTab: vi.fn(),
    launchPtySession: vi.fn(),
    setDraftLaneId: vi.fn(),
    showDraftKind: vi.fn(),
    toggleWorkTabGroupCollapsed: vi.fn(),
    setFilterLaneId: vi.fn(),
    setQ: vi.fn(),
    setSessionListOrganization: vi.fn(),
    toggleWorkLaneCollapsed: vi.fn(),
    toggleWorkSectionCollapsed: vi.fn(),
    stopRuntime: vi.fn().mockResolvedValue(undefined),
    removeSessionFromList: vi.fn(),
    setWorkSidebarOpen: vi.fn(),
    setWorkSidebarWidthPct: vi.fn(),
    reorderLaneSessions: vi.fn(),
    togglePinnedSession: vi.fn(),
    ...fns,
  };

  return {
    backgroundSession: makeChatSession("chat-background", "lane-background"),
    foregroundSession: makeChatSession("chat-foreground", "lane-primary"),
    baseWork,
    currentWork: baseWork as any,
    projectRoot: null as string | null,
    projectBinding: null as OpenProjectBinding | null,
    handoffLaunchJobsByScope: {} as Record<string, unknown[]>,
    laneWorkViewByScope: {} as Record<string, unknown>,
    workViewByProject: {} as Record<string, unknown>,
    /** Bindings this window has open besides the active one (per-session pin targets). */
    openRemoteProjectTabs: [] as OpenProjectBinding[],
    /** Cross-machine union slices — lane ownership for `useWorkMachineRouter`. */
    crossMachineLanesByMachineId: {} as Record<string, {
      machineId: string;
      machineName: string;
      targetId: string | null;
      projectId: string | null;
      binding?: OpenProjectBinding | null;
      lanes: LaneSummary[];
      sessions: TerminalSessionSummary[];
      online: boolean;
    }>,
    crossMachineLaneIntendedMachineIds: null as string[] | null,
    fns,
    makeTerminalSession,
  };
});

const sidebarProps = vi.hoisted(() => ({
  latest: null as null | {
    laneId: string | null;
    activeSession: TerminalSessionSummary | null;
    contextTarget: unknown;
    contextDisabledReason: string | null;
  },
}));

type MockSessionListPaneProps = {
  boardHost?: HTMLElement | null;
  runningFiltered: TerminalSessionSummary[];
  awaitingInputFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
  onSelectSession: (id: string, event: React.MouseEvent, visibleSessionIds: string[]) => void;
  onSelectForeignRuntimeSession?: (
    session: TerminalSessionSummary,
    binding: OpenProjectBinding,
    event: React.MouseEvent,
    visibleSessionIds: string[],
  ) => void;
  onBulkDelete?: () => void;
  onBulkStopAndDelete?: () => void;
  onRefreshOrphanSessions?: () => void;
  onContextMenu: (
    session: TerminalSessionSummary,
    event: React.MouseEvent,
    binding?: OpenProjectBinding | null,
    machineName?: string | null,
  ) => void;
};

const sessionListPaneProps = vi.hoisted(() => ({
  latest: null as null | MockSessionListPaneProps,
}));

const workViewAreaProps = vi.hoisted(() => ({
  latest: null as null | {
    resolveSessionRuntimePin?: (session: TerminalSessionSummary) => OpenProjectBinding | null;
  },
}));

vi.mock("../../state/appStore", () => ({
  // The real key builder: the pane's lane scope key is the store's own storage
  // layout, and a mock that reimplemented it would test the mock.
  laneWorkViewScopeKey: (projectRoot: string | null | undefined, laneId: string | null | undefined) => {
    const project = typeof projectRoot === "string" ? projectRoot.trim() : "";
    const lane = typeof laneId === "string" ? laneId.trim() : "";
    return project && lane ? `${project}::${lane}` : "";
  },
  // Same shape the real selectors return: the stored slice, or an empty one.
  // The corner card reads its position/dismissals through these rather than
  // reaching into the maps, so the mock has to answer them.
  selectWorkViewState: (projectKey: string | null | undefined) =>
    (state: { workViewByProject?: Record<string, unknown> }) =>
      (projectKey ? state.workViewByProject?.[projectKey] : null) ?? {},
  selectLaneWorkViewState: (projectKey: string | null | undefined, laneId: string | null | undefined) =>
    (state: { laneWorkViewByScope?: Record<string, unknown> }) => {
      const project = typeof projectKey === "string" ? projectKey.trim() : "";
      const lane = typeof laneId === "string" ? laneId.trim() : "";
      const key = project && lane ? `${project}::${lane}` : "";
      return (key ? state.laneWorkViewByScope?.[key] : null) ?? {};
    },
  selectActiveProjectRoot: (state: {
    projectBinding?: { kind?: string; rootPath?: string | null } | null;
    project?: { rootPath?: string | null } | null;
  }) => {
    if (state.projectBinding?.kind === "remote") return state.projectBinding.rootPath?.trim() || null;
    return state.project?.rootPath?.trim() || null;
  },
  projectStateKeyForBinding: (
    binding: { kind?: string; key?: string | null; rootPath?: string | null } | null | undefined,
    fallbackRoot?: string | null,
  ) => {
    if (binding?.kind === "remote") return (binding.key ?? "").trim();
    return (binding?.rootPath ?? fallbackRoot ?? "").trim();
  },
  selectActiveProjectStateKey: (state: {
    projectBinding?: { kind?: string; key?: string | null } | null;
    project?: { rootPath?: string | null } | null;
  }) => {
    if (state.projectBinding?.kind === "remote") return state.projectBinding.key?.trim() || null;
    return state.project?.rootPath?.trim() || null;
  },
  useAppStore: <T,>(selector: (state: {
    selectedLaneId: string;
    project: { rootPath: string } | null;
    projectBinding: typeof workMocks.projectBinding;
    laneDeleteProgressByLaneId: Record<string, never>;
    switchRemoteProject: typeof workMocks.fns.switchRemoteProject;
    switchProjectToPath: typeof workMocks.fns.switchProjectToPath;
    selectLane: typeof workMocks.fns.selectLane;
    focusSession: typeof workMocks.fns.focusSession;
    setWorkViewState: typeof workMocks.fns.setWorkViewState;
    setLaneWorkViewState: typeof workMocks.fns.setLaneWorkViewState;
    laneWorkViewByScope: Record<string, unknown>;
    workViewByProject: Record<string, unknown>;
    /** Read by `useLanesForPin`, which the page uses to resolve a pinned lane's worktree. */
    laneCacheByProject: Record<string, unknown>;
    lanes: LaneSummary[];
    openRemoteProjectTabs: OpenProjectBinding[];
    openProjectTabRoots: string[];
  }) => T): T =>
    selector({
      selectedLaneId: "lane-primary",
      laneDeleteProgressByLaneId: {},
      projectBinding: workMocks.projectBinding,
      lanes: workMocks.currentWork.lanes,
      openRemoteProjectTabs: workMocks.openRemoteProjectTabs,
      openProjectTabRoots: [],
      switchRemoteProject: workMocks.fns.switchRemoteProject,
      switchProjectToPath: workMocks.fns.switchProjectToPath,
      selectLane: workMocks.fns.selectLane,
      focusSession: workMocks.fns.focusSession,
      setWorkViewState: workMocks.fns.setWorkViewState,
      setLaneWorkViewState: workMocks.fns.setLaneWorkViewState,
      laneWorkViewByScope: workMocks.laneWorkViewByScope,
      workViewByProject: workMocks.workViewByProject,
      laneCacheByProject: {},
      project: workMocks.projectRoot
        ? { rootPath: workMocks.projectRoot }
        : null,
    }),
  useRootAppStore: <T,>(selector: (state: {
    handoffLaunchJobsByScope: typeof workMocks.handoffLaunchJobsByScope;
    crossMachineLanesByMachineId: typeof workMocks.crossMachineLanesByMachineId;
    crossMachineLaneIntendedMachineIds: typeof workMocks.crossMachineLaneIntendedMachineIds;
  }) => T): T =>
    selector({
      handoffLaunchJobsByScope: workMocks.handoffLaunchJobsByScope,
      crossMachineLanesByMachineId: workMocks.crossMachineLanesByMachineId,
      crossMachineLaneIntendedMachineIds: workMocks.crossMachineLaneIntendedMachineIds,
    }),
}));

vi.mock("./useWorkSessions", async () => {
  const { useWorkMachineRouter } = await vi.importActual<typeof import("./useWorkMachineRouter")>(
    "./useWorkMachineRouter",
  );
  const { useRetainedCrossMachineSlices } = await vi.importActual<
    typeof import("../../state/crossMachineLanes")
  >("../../state/crossMachineLanes");
  return {
    useWorkSessions: () => {
      const retainedCrossMachineSlices = useRetainedCrossMachineSlices();
      const machineRouter = useWorkMachineRouter(retainedCrossMachineSlices);
      const sessionsById = workMocks.currentWork.sessionsById
        ?? new Map<string, TerminalSessionSummary>([
          ...workMocks.currentWork.sessions.map((session: TerminalSessionSummary) => [session.id, session] as const),
          ...retainedCrossMachineSlices
            .flatMap((machine) => machine.sessions)
            .map((session) => [session.id, session] as const),
        ]);
      return {
        ...workMocks.currentWork,
        sessionsById,
        machineRouter,
        resolveSessionRuntimePin: machineRouter.pinForSession,
      };
    },
  };
});

vi.mock("./useWorkLaneDeleteProgress", () => ({
  useWorkLaneDeleteProgress: () => undefined,
}));

vi.mock("./SessionListPane", () => ({
  SessionListPane: (props: MockSessionListPaneProps) => {
    sessionListPaneProps.latest = props;
    const visibleSessions = [
      ...props.runningFiltered,
      ...props.awaitingInputFiltered,
      ...props.endedFiltered,
    ];
    const visibleSessionIds = visibleSessions.map((session) => session.id);
    return (
      <div data-testid="session-list-pane">
        {visibleSessions.map((session) => (
          <React.Fragment key={session.id}>
            <button
              type="button"
              onClick={(event) => props.onSelectSession(session.id, event, visibleSessionIds)}
            >
              select {session.id}
            </button>
            <button
              type="button"
              onClick={(event) => props.onContextMenu(session, event)}
            >
              context menu {session.id}
            </button>
          </React.Fragment>
        ))}
        <button type="button" onClick={() => props.onBulkDelete?.()}>
          bulk delete
        </button>
        <button type="button" onClick={() => props.onBulkStopAndDelete?.()}>
          bulk stop and delete
        </button>
        <button
          type="button"
          onClick={() => props.onRefreshOrphanSessions?.()}
        >
          refresh orphaned records
        </button>
      </div>
    );
  },
}));

vi.mock("./WorkSidebar", () => ({
  WorkSidebar: (props: {
    laneId: string | null;
    activeSession: TerminalSessionSummary | null;
    contextTarget: unknown;
    contextDisabledReason: string | null;
  }) => {
    sidebarProps.latest = props;
    return <div data-testid="work-sidebar" />;
  },
}));

vi.mock("./SessionContextMenu", () => ({
  SessionContextMenu: (props: {
    menu: {
      session: TerminalSessionSummary;
      binding?: OpenProjectBinding | null;
    } | null;
    onStopAndDelete: (
      session: TerminalSessionSummary,
      binding?: OpenProjectBinding | null,
    ) => void;
    onDeleteChat: (
      session: TerminalSessionSummary,
      binding?: OpenProjectBinding | null,
    ) => void;
    onSettle: (
      session: TerminalSessionSummary,
      binding?: OpenProjectBinding | null,
    ) => void;
    onOpenChatHandoff: (
      session: TerminalSessionSummary,
      intent: "local" | "remote",
      binding?: OpenProjectBinding | null,
    ) => void;
    onClose: () => void;
  }) => {
    if (!props.menu) return null;
    const session = props.menu.session;
    return (
      <>
        <button
          type="button"
          onClick={() => {
            props.onStopAndDelete(session, props.menu?.binding);
            props.onClose();
          }}
        >
          context stop and delete {session.id}
        </button>
        <button
          type="button"
          onClick={() => props.onDeleteChat(session, props.menu?.binding)}
        >
          context delete chat {session.id}
        </button>
        <button
          type="button"
          onClick={() => props.onSettle(session, props.menu?.binding)}
        >
          context settle {session.id}
        </button>
        <button
          type="button"
          onClick={() => {
            props.onOpenChatHandoff(session, "local", props.menu?.binding);
            props.onClose();
          }}
        >
          context handoff local {session.id}
        </button>
      </>
    );
  },
}));

/**
 * The floating device's own tests own its visibility rule; here the question
 * is only what surface the page hands it.
 */
const miniPlayerProps = vi.hoisted(() => ({
  latest: undefined as undefined | { surface?: unknown },
}));

const floatMocks = vi.hoisted(() => ({
  floatAppleMiniPlayerForChat: vi.fn(async () => true),
}));

vi.mock("../apple/appleMiniPlayerStore", async () => ({
  ...(await vi.importActual<typeof import("../apple/appleMiniPlayerStore")>("../apple/appleMiniPlayerStore")),
  floatAppleMiniPlayerForChat: floatMocks.floatAppleMiniPlayerForChat,
}));

vi.mock("../apple/AppleDeviceMiniPlayer", () => ({
  AppleDeviceMiniPlayer: (props: { surface?: unknown }) => {
    miniPlayerProps.latest = props;
    return null;
  },
}));

vi.mock("./SessionInfoPopover", () => ({
  SessionInfoPopover: () => null,
}));

vi.mock("./WorkViewArea", () => ({
  WorkViewArea: (props: {
    onOpenChatSession: (
      session: AgentChatSession,
      options?: AgentChatSessionCreatedOptions,
    ) => void | Promise<void>;
    onToggleTerminalPane?: () => void;
    onOpenTerminalPane?: () => void;
    terminalPaneOpen?: boolean;
    resolveSessionRuntimePin?: (session: TerminalSessionSummary) => OpenProjectBinding | null;
  }) => {
    workViewAreaProps.latest = props;
    return (
    <div data-testid="work-view-area">
      <button
        type="button"
        onClick={() => props.onOpenChatSession(workMocks.backgroundSession, { activate: false, source: "draft-launch" })}
      >
        create background chat
      </button>
      <button
        type="button"
        onClick={() => props.onOpenChatSession(workMocks.foregroundSession, { activate: true, source: "draft-launch" })}
      >
        create foreground chat
      </button>
      <button
        type="button"
        onClick={() => props.onOpenChatSession(workMocks.foregroundSession, {
          activate: true,
          source: "draft-launch",
          laneName: "Primary",
          runtimePin: {
            kind: "remote",
            key: "remote:target-other:project-other",
            targetId: "target-other",
            runtimeName: "Other Mac",
            projectId: "project-other",
            rootPath: "/repo-other",
            displayName: "Other repo",
          },
        })}
      >
        create foreign chat
      </button>
      <button
        type="button"
        data-terminal-open={props.terminalPaneOpen ? "true" : "false"}
        onClick={() => props.onToggleTerminalPane?.()}
      >
        toggle terminal pane
      </button>
      <button
        type="button"
        onClick={() => props.onOpenTerminalPane?.()}
      >
        open terminal pane
      </button>
    </div>
    );
  },
}));

const STUDIO_BINDING: OpenProjectBinding = {
  kind: "remote",
  key: "remote:target-studio:project-a",
  targetId: "target-studio",
  runtimeName: "Mac Studio",
  projectId: "project-a",
  rootPath: "/remote/repo-a",
  displayName: "repo-a",
};

/** The Mac Studio's cross-machine slice: one lane holding `sessions`. */
function studioMachine(laneId: string, sessions: TerminalSessionSummary[]) {
  return {
    machineId: "target-studio",
    machineName: "Mac Studio",
    targetId: "target-studio",
    projectId: "project-a",
    binding: STUDIO_BINDING,
    lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: laneId }],
    sessions,
    online: true,
  };
}

describe("TerminalsPage chat session activation", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(confirmDialog).mockResolvedValue(false);
    workMocks.currentWork = { ...workMocks.baseWork, closingPtyIds: new Set<string>() };
    workMocks.projectRoot = null;
    workMocks.projectBinding = null;
    workMocks.handoffLaunchJobsByScope = {};
    workMocks.openRemoteProjectTabs = [];
    workMocks.crossMachineLanesByMachineId = {};
    workMocks.crossMachineLaneIntendedMachineIds = null;
    workMocks.laneWorkViewByScope = {};
    workMocks.workViewByProject = {};
    sidebarProps.latest = null;
    sessionListPaneProps.latest = null;
    workViewAreaProps.latest = null;
    miniPlayerProps.latest = undefined;
    forgetWorkPtyLaunchPin({ sessionId: "shell-foreign", ptyId: "pty-shell-foreign" });
    forgetWorkPtyLaunchPin({ sessionId: "shell-now-active", ptyId: "pty-shell-now-active" });
    forgetWorkPtyLaunchPin({ sessionId: "chat-foreign" });
    resetRemoteBrowserOpensForTests();
    resetWorkToolShowRequestsForTests();
    resetWorkToolOnScreenForTests();
    vi.clearAllMocks();
  });

  /* ────────────────────────────────────────────────────────────────────────
     The session list lives in the project sidebar. The board needs the full
     width, so it draws in the main area: beside the list while the sidebar
     shows, and as the whole pane when there is no sidebar on screen. Board
     mode never drives `workSidebarWidthPct`, the user's LIST-mode layout.
     ──────────────────────────────────────────────────────────────────────── */

  function SidebarBody() {
    const setTarget = useProjectSidebarSlotTarget();
    return <div data-testid="sidebar-body" ref={setTarget} />;
  }

  function renderWithProjectSidebar() {
    return render(
      <ProjectSidebarSlotProvider>
        <SidebarBody />
        <TerminalsPage />
      </ProjectSidebarSlotProvider>,
    );
  }

  function mockBrowserEvents() {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { builtInBrowser: { onEvent: vi.fn(() => vi.fn()) }, iosSimulator: { onEvent: vi.fn(() => vi.fn()) } },
    });
  }

  it("renders the session list in the project sidebar and only the view in the main area", async () => {
    mockBrowserEvents();

    renderWithProjectSidebar();

    const sidebar = screen.getByTestId("sidebar-body");
    const list = await screen.findByTestId("session-list-pane");
    expect(sidebar.contains(list)).toBe(true);
    expect(sidebar.contains(screen.getByTestId("work-view-area"))).toBe(false);
    expect(screen.queryByTestId("work-board-surface")).toBeNull();
    expect(sessionListPaneProps.latest?.boardHost).toBeUndefined();
  });

  it("keeps the list in the sidebar and portals the board into the main area", async () => {
    workMocks.currentWork = { ...workMocks.baseWork, workViewMode: "board" };
    mockBrowserEvents();

    renderWithProjectSidebar();

    const sidebar = screen.getByTestId("sidebar-body");
    const board = await screen.findByTestId("work-board-surface");
    expect(sidebar.contains(screen.getByTestId("session-list-pane"))).toBe(true);
    expect(sidebar.contains(board)).toBe(false);
    await waitFor(() => expect(sessionListPaneProps.latest?.boardHost).toBe(board));
    // No chat beside the board, and the list-mode tools width is never written.
    expect(screen.queryByTestId("work-view-area")).toBeNull();
    expect(workMocks.currentWork.setWorkSidebarWidthPct).not.toHaveBeenCalled();
  });

  it("gives the board the whole pane while the project sidebar is hidden", async () => {
    workMocks.currentWork = { ...workMocks.baseWork, workViewMode: "board" };
    mockBrowserEvents();
    setProjectSidebarHidden(true);
    try {
      renderWithProjectSidebar();

      const board = await screen.findByTestId("work-board-surface");
      // The pane is the board, toolbar and all, so the List/Board toggle is
      // still reachable without the sidebar.
      expect(board.contains(screen.getByTestId("session-list-pane"))).toBe(true);
      expect(sessionListPaneProps.latest?.boardHost).toBeUndefined();
    } finally {
      setProjectSidebarHidden(false);
    }
  });

  it("keeps a plain list column when there is no project sidebar", async () => {
    mockBrowserEvents();

    render(<TerminalsPage />);

    const column = await screen.findByTestId("work-sessions-column");
    expect(column.contains(screen.getByTestId("session-list-pane"))).toBe(true);
    expect(screen.getByTestId("work-view-area")).toBeTruthy();
    expect(screen.queryByTestId("work-board-surface")).toBeNull();
  });

  it("opening a card from the board selects the session and returns to list mode", async () => {
    const session = workMocks.makeTerminalSession("chat-on-board", "lane-primary", "codex-chat");
    workMocks.currentWork = {
      ...workMocks.baseWork,
      workViewMode: "board",
      runningFiltered: [session],
      sessions: [session],
      visibleSessions: [session],
    };
    mockBrowserEvents();

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "select chat-on-board" }));

    // The board is the overview; clicking a card dives in. Without the mode
    // flip the chat has nowhere to render — the split is not mounted — and the
    // card would highlight and appear to do nothing.
    expect(workMocks.currentWork.setSelectedSessionId).toHaveBeenCalledWith("chat-on-board");
    expect(workMocks.fns.openSessionTab).toHaveBeenCalledWith("chat-on-board");
    expect(workMocks.fns.setWorkViewMode).toHaveBeenCalledWith("list");
  });

  it("does not leave board mode on a multi-select click", async () => {
    const session = workMocks.makeTerminalSession("chat-on-board", "lane-primary", "codex-chat");
    workMocks.currentWork = {
      ...workMocks.baseWork,
      workViewMode: "board",
      runningFiltered: [session],
      sessions: [session],
      visibleSessions: [session],
    };
    mockBrowserEvents();

    render(<TerminalsPage />);

    // Multi-select is something you do WHILE staying on the board — picking
    // several cards to settle in one go. Only a plain open dives out.
    fireEvent.click(await screen.findByRole("button", { name: "select chat-on-board" }), { metaKey: true });
    expect(workMocks.fns.setWorkViewMode).not.toHaveBeenCalled();
  });

  it("tracks background-created chats without stealing Work focus", async () => {
    mockBrowserEvents();

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "create background chat" }));

    await waitFor(() => {
      expect(workMocks.fns.upsertOptimisticChatSession).toHaveBeenCalledWith(workMocks.backgroundSession);
      expect(workMocks.fns.refresh).toHaveBeenCalledWith({ showLoading: false, force: true });
    });
    expect(workMocks.fns.selectLane).not.toHaveBeenCalled();
    expect(workMocks.fns.focusSession).not.toHaveBeenCalled();
    expect(workMocks.fns.openSessionTab).not.toHaveBeenCalled();
  });

  it("opens foreground-created chats in the active Work tab", async () => {
    mockBrowserEvents();

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "create foreground chat" }));

    await waitFor(() => {
      expect(workMocks.fns.upsertOptimisticChatSession).toHaveBeenCalledWith(workMocks.foregroundSession);
      expect(workMocks.fns.selectLane).toHaveBeenCalledWith("lane-primary");
      expect(workMocks.fns.focusSession).toHaveBeenCalledWith("chat-foreground");
      expect(workMocks.fns.openSessionTab).toHaveBeenCalledWith("chat-foreground");
    });
  });

  it("does not invent an active-binding lane for a chat created on another machine", async () => {
    workMocks.projectBinding = {
      kind: "local",
      key: "local:/repo-active",
      rootPath: "/repo-active",
      displayName: "Active repo",
    };
    mockBrowserEvents();

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "create foreign chat" }));

    await waitFor(() => {
      expect(workMocks.fns.refresh).toHaveBeenCalledWith({ showLoading: false, force: true });
      expect(workMocks.fns.focusSession).toHaveBeenCalledWith("chat-foreground");
      expect(workMocks.fns.openSessionTab).toHaveBeenCalledWith("chat-foreground");
    });
    expect(workMocks.fns.upsertOptimisticChatSession).not.toHaveBeenCalled();
    expect(workMocks.fns.selectLane).not.toHaveBeenCalled();
    expect(crossMachineMocks.seedOptimistic).toHaveBeenCalledWith(
      workMocks.foregroundSession,
      expect.objectContaining({ key: "remote:target-other:project-other" }),
      "Primary",
    );
  });

  it("keeps B's runtime pin through an A-before-B scope refill without a launch-registry entry", async () => {
    const studioBinding = STUDIO_BINDING;
    const session = workMocks.makeTerminalSession("shell-foreign", "lane-foreign", "shell");
    const machineABinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:target-a:project-a",
      targetId: "target-a",
      runtimeName: "Machine A",
      projectId: "project-a",
      rootPath: "/remote/repo-a-copy",
      displayName: "repo-a-copy",
    };
    const machineASession = workMocks.makeTerminalSession("shell-a", "lane-a", "shell");
    // This binding is discoverable only through the replace-on-refresh
    // cross-machine scope, matching the production flap.
    workMocks.openRemoteProjectTabs = [];
    workMocks.crossMachineLaneIntendedMachineIds = ["target-a", "target-studio"];
    workMocks.crossMachineLanesByMachineId = {
      "target-a": {
        machineId: "target-a",
        machineName: "Machine A",
        targetId: "target-a",
        projectId: "project-a",
        binding: machineABinding,
        lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: "lane-a" }],
        sessions: [machineASession],
        online: true,
      },
      "target-studio": studioMachine("lane-foreign", [session]),
    };
    mockBrowserEvents();
    const rendered = render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    expect(workPtyLaunchPinFor(session)).toBeNull();
    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(session)?.key).toBe(studioBinding.key);

    workMocks.crossMachineLanesByMachineId = {};
    rendered.rerender(<TerminalsPage />);
    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(session)?.key).toBe(studioBinding.key);

    // A arrives first. B's retained complete slice still owns the restored
    // terminal's session and lane indexes, so hydration/input cannot fall back
    // to the active machine while B remains intended.
    workMocks.crossMachineLanesByMachineId = {
      "target-a": {
        machineId: "target-a",
        machineName: "Machine A",
        targetId: "target-a",
        projectId: "project-a",
        binding: machineABinding,
        lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: "lane-a" }],
        sessions: [{ ...machineASession, lastOutputPreview: "fresh-a" }],
        online: true,
      },
    };
    rendered.rerender(<TerminalsPage />);

    expect(workPtyLaunchPinFor(session)).toBeNull();
    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(session)?.key).toBe(studioBinding.key);
  });

  it("leaves a session on the tab's own machine unpinned", async () => {
    workMocks.projectRoot = "/repo";
    workMocks.projectBinding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "repo",
    };
    // A foreign machine is present, so the lane index is non-empty and the null
    // below is a real "this lane is on the active binding", not an empty map.
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": studioMachine("lane-foreign", []),
    };
    mockBrowserEvents();
    render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    const local = workMocks.makeTerminalSession("shell-local", "lane-primary", "shell");
    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(local)).toBeNull();
  });

  it("drops a remembered pin when that binding is now active", async () => {
    const activeBinding = STUDIO_BINDING;
    const session = workMocks.makeTerminalSession("shell-now-active", "lane-primary", "shell");
    // This pin was remembered while the same binding was foreign. After the
    // project tab rebinds to it, lane routing returns null and the registry is
    // the fallback that must also collapse to the unpinned fast path.
    rememberWorkPtyLaunchPin(session, activeBinding);
    workMocks.projectBinding = activeBinding;
    mockBrowserEvents();

    render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(session)).toBeNull();
  });

  it("opens a foreign CLI session in place even when that checkout is not an open tab", async () => {
    mockBrowserEvents();
    render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    const session = workMocks.makeTerminalSession("shell-foreign", "lane-foreign", "shell");
    const event = { shiftKey: false, metaKey: false, ctrlKey: false } as React.MouseEvent;
    const studioBinding = STUDIO_BINDING;
    sessionListPaneProps.latest?.onSelectForeignRuntimeSession?.(
      session,
      studioBinding,
      event,
      [session.id],
    );

    expect(workMocks.fns.switchRemoteProject).not.toHaveBeenCalled();
    expect(workMocks.fns.switchProjectToPath).not.toHaveBeenCalled();
    expect(workMocks.fns.setWorkViewState).not.toHaveBeenCalled();
    expect(workMocks.currentWork.setSelectedSessionId).toHaveBeenCalledWith("shell-foreign");
    expect(workMocks.currentWork.openSessionTab).toHaveBeenCalledWith("shell-foreign");
    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(session)).toEqual(studioBinding);
  });

  it("focuses chats selected through the Work select-session event", async () => {
    mockBrowserEvents();

    render(<TerminalsPage />);
    await screen.findByTestId("work-view-area");

    window.dispatchEvent(
      new CustomEvent("ade:work:select-session", {
        detail: { sessionId: "chat-worker", laneId: "lane-background" },
      }),
    );

    expect(workMocks.fns.selectLane).toHaveBeenCalledWith("lane-background");
    expect(workMocks.fns.focusSession).toHaveBeenCalledWith("chat-worker");
    expect(workMocks.fns.openSessionTab).toHaveBeenCalledWith("chat-worker");
    expect(workMocks.currentWork.setSelectedSessionId).toHaveBeenCalledWith("chat-worker");
  });

  it("resolves the target lane from the session list when select-session carries no laneId", async () => {
    // Spawn cards and the subagents pane dispatch without a laneId — the
    // listener must look the session up so cross-lane jumps still land.
    workMocks.currentWork.sessions = [
      workMocks.makeTerminalSession("chat-spawned-child", "lane-background", "codex-chat"),
    ];
    mockBrowserEvents();

    render(<TerminalsPage />);
    await screen.findByTestId("work-view-area");

    window.dispatchEvent(
      new CustomEvent("ade:work:select-session", {
        detail: { sessionId: "chat-spawned-child" },
      }),
    );

    expect(workMocks.fns.selectLane).toHaveBeenCalledWith("lane-background");
    expect(workMocks.fns.focusSession).toHaveBeenCalledWith("chat-spawned-child");
    expect(workMocks.fns.openSessionTab).toHaveBeenCalledWith("chat-spawned-child");
    expect(workMocks.currentWork.setSelectedSessionId).toHaveBeenCalledWith("chat-spawned-child");
  });

  it("opens a bindingless foreign select-session target from the union without selecting a local lane", async () => {
    const binding = STUDIO_BINDING;
    const foreign = workMocks.makeTerminalSession("chat-foreign-child", "lane-foreign", "codex-chat");
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": {
        machineId: "target-studio",
        machineName: "Mac Studio",
        targetId: "target-studio",
        projectId: "project-a",
        binding,
        lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: "lane-foreign" }],
        sessions: [foreign],
        online: true,
      },
    };
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [],
      sessionsById: new Map([[foreign.id, foreign]]),
      closingPtyIds: new Set<string>(),
    };
    mockBrowserEvents();

    render(<TerminalsPage />);
    await screen.findByTestId("work-view-area");
    window.dispatchEvent(new CustomEvent("ade:work:select-session", {
      detail: { sessionId: foreign.id },
    }));

    expect(workMocks.fns.selectLane).not.toHaveBeenCalled();
    expect(workMocks.fns.focusSession).toHaveBeenCalledWith(foreign.id);
    expect(workMocks.fns.openSessionTab).toHaveBeenCalledWith(foreign.id);
    expect(workMocks.currentWork.setSelectedSessionId).toHaveBeenCalledWith(foreign.id);
  });

  it("pins a foreign select-session event in place without rebinding the tab", async () => {
    mockBrowserEvents();
    const binding = STUDIO_BINDING;

    render(<TerminalsPage />);
    await screen.findByTestId("work-view-area");
    window.dispatchEvent(
      new CustomEvent("ade:work:select-session", {
        detail: {
          sessionId: "chat-foreign",
          laneId: "lane-foreign",
          binding,
        },
      }),
    );

    expect(workMocks.fns.switchRemoteProject).not.toHaveBeenCalled();
    expect(workMocks.fns.switchProjectToPath).not.toHaveBeenCalled();
    expect(workMocks.fns.setWorkViewState).not.toHaveBeenCalled();
    expect(workMocks.fns.selectLane).not.toHaveBeenCalled();
    expect(workMocks.fns.focusSession).toHaveBeenCalledWith("chat-foreign");
    expect(workMocks.currentWork.openSessionTab).toHaveBeenCalledWith("chat-foreign");
    expect(workMocks.currentWork.setSelectedSessionId).toHaveBeenCalledWith("chat-foreign");
    expect(workPtyLaunchPinFor({ sessionId: "chat-foreign" })).toEqual(binding);
  });

  it("opens the Browser sidebar only for matching project open requests", async () => {
    workMocks.projectRoot = "/repo-one";
    const browserEventListener: {
      current: ((event: { type?: string; status?: unknown }) => void) | null;
    } = { current: null };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        builtInBrowser: {
          onEvent: vi.fn((listener) => {
            browserEventListener.current = listener;
            return vi.fn();
          }),
        },
      },
    });

    render(<TerminalsPage />);

    await waitFor(() => expect(browserEventListener.current).not.toBeNull());
    browserEventListener.current?.({ type: "open-request" });
    browserEventListener.current?.({
      type: "open-request",
      status: { collectionProjectRoot: "/repo-two" },
    });
    expect(workMocks.fns.setLaneWorkViewState).not.toHaveBeenCalled();

    browserEventListener.current?.({
      type: "open-request",
      status: { collectionProjectRoot: "/repo-one" },
    });
    // The active tool is per lane, so the write lands on the lane scope the
    // page resolved, not on the project-wide work view.
    expect(workMocks.fns.setLaneWorkViewState).toHaveBeenCalledWith(
      "/repo-one",
      "lane-primary",
      // The strip is written with it: opening a tool opens its tab.
      { workSidebarTool: "browser", workSidebarOpenTools: ["browser"] },
    );
  });

  it("opens Browser from a remote-pinned session's forwarded open request", async () => {
    const studioBinding = STUDIO_BINDING;
    const foreignSession = workMocks.makeTerminalSession("chat-studio", "lane-studio", "codex-chat");
    workMocks.projectRoot = "/laptop/repo-a";
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": studioMachine("lane-studio", [foreignSession]),
    };
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [],
      sessionsById: new Map([[foreignSession.id, foreignSession]]),
      visibleSessions: [foreignSession],
      activeItemId: foreignSession.id,
      closingPtyIds: new Set<string>(),
    };
    const onEvent = vi.fn(
      (
        _listener: (event: { type?: string }) => void,
        _pin?: OpenProjectBinding | null,
      ) => vi.fn(),
    );
    const remoteRequestListener: {
      current: ((request: BuiltInBrowserRemoteRequest) => void) | null;
    } = { current: null };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        iosSimulator: { onEvent: vi.fn(() => vi.fn()) },
        workTools: { onShowRequest: vi.fn(() => vi.fn()), acknowledgeShow: vi.fn() },
        builtInBrowser: {
          onEvent,
          onRemoteRequest: vi.fn((listener: (request: BuiltInBrowserRemoteRequest) => void) => {
            remoteRequestListener.current = listener;
            return vi.fn();
          }),
        },
      },
    });

    render(<TerminalsPage />);

    await waitFor(() => expect(onEvent).toHaveBeenCalled());
    expect(onEvent.mock.calls[0]?.[1]).toEqual(studioBinding);
    await waitFor(() => expect(remoteRequestListener.current).not.toBeNull());
    const forwardedOpen: BuiltInBrowserRemoteRequest = {
      requestId: "bbr-studio-open",
      url: "http://127.0.0.1:3000/app",
      laneId: "lane-studio",
      chatSessionId: foreignSession.id,
      openPanel: true,
      requestedAt: "2026-09-21T00:00:00.000Z",
    };
    remoteRequestListener.current?.(forwardedOpen);
    expect(workMocks.fns.setLaneWorkViewState).toHaveBeenCalledWith(
      studioBinding.key,
      "lane-studio",
      { workSidebarTool: "browser", workSidebarOpenTools: ["browser"] },
    );
    expect(
      takeHeldRemoteBrowserOpen(studioBinding, {
        sessionId: foreignSession.id,
        laneId: "lane-studio",
      }),
    ).toEqual(forwardedOpen);
  });

  it("holds a forwarded open for an unpinned chat on a remote-bound tab", async () => {
    const studioBinding = STUDIO_BINDING;
    const boundSession = workMocks.makeTerminalSession("chat-bound", "lane-primary", "codex-chat");
    workMocks.projectRoot = "/remote/repo-a";
    workMocks.projectBinding = studioBinding;
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [boundSession],
      sessionsById: new Map([[boundSession.id, boundSession]]),
      visibleSessions: [boundSession],
      activeItemId: boundSession.id,
      closingPtyIds: new Set<string>(),
    };
    const remoteRequestListener: {
      current: ((request: BuiltInBrowserRemoteRequest) => void) | null;
    } = { current: null };
    const onRemoteRequest = vi.fn(
      (
        listener: (request: BuiltInBrowserRemoteRequest) => void,
        _pin?: OpenProjectBinding | null,
      ) => {
        remoteRequestListener.current = listener;
        return vi.fn();
      },
    );
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        iosSimulator: { onEvent: vi.fn(() => vi.fn()) },
        builtInBrowser: {
          onEvent: vi.fn(() => vi.fn()),
          onRemoteRequest,
        },
      },
    });

    render(<TerminalsPage />);

    await waitFor(() => expect(onRemoteRequest).toHaveBeenCalled());
    expect(onRemoteRequest.mock.calls[0]?.[1]).toEqual(studioBinding);
    const forwardedOpen: BuiltInBrowserRemoteRequest = {
      requestId: "bbr-bound-open",
      url: "http://127.0.0.1:5173/",
      laneId: "lane-primary",
      chatSessionId: boundSession.id,
      openPanel: true,
      requestedAt: "2026-09-21T00:00:00.000Z",
    };
    remoteRequestListener.current?.(forwardedOpen);
    expect(workMocks.fns.setLaneWorkViewState).toHaveBeenCalledWith(
      "remote:target-studio:project-a",
      "lane-primary",
      { workSidebarTool: "browser", workSidebarOpenTools: ["browser"] },
    );
    expect(
      takeHeldRemoteBrowserOpen(studioBinding, {
        sessionId: boundSession.id,
        laneId: "lane-primary",
      }),
    ).toEqual(forwardedOpen);
  });

  it("holds a forwarded open for another chat without switching the focused pane", async () => {
    const studioBinding = STUDIO_BINDING;
    const foreignSession = workMocks.makeTerminalSession("chat-studio", "lane-studio", "codex-chat");
    workMocks.projectRoot = "/laptop/repo-a";
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": studioMachine("lane-studio", [foreignSession]),
    };
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [],
      sessionsById: new Map([[foreignSession.id, foreignSession]]),
      visibleSessions: [foreignSession],
      activeItemId: foreignSession.id,
      closingPtyIds: new Set<string>(),
    };
    const remoteRequestListener: {
      current: ((request: BuiltInBrowserRemoteRequest) => void) | null;
    } = { current: null };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        iosSimulator: { onEvent: vi.fn(() => vi.fn()) },
        workTools: { onShowRequest: vi.fn(() => vi.fn()), acknowledgeShow: vi.fn() },
        builtInBrowser: {
          onEvent: vi.fn(() => vi.fn()),
          onRemoteRequest: vi.fn((listener: (request: BuiltInBrowserRemoteRequest) => void) => {
            remoteRequestListener.current = listener;
            return vi.fn();
          }),
        },
      },
    });

    render(<TerminalsPage />);

    await waitFor(() => expect(remoteRequestListener.current).not.toBeNull());
    const forwardedOpen: BuiltInBrowserRemoteRequest = {
      requestId: "bbr-other-open",
      url: "http://127.0.0.1:3000/other",
      laneId: "lane-studio",
      chatSessionId: "chat-other",
      openPanel: true,
      requestedAt: "2026-09-21T00:00:00.000Z",
    };
    remoteRequestListener.current?.(forwardedOpen);
    expect(workMocks.fns.setLaneWorkViewState).not.toHaveBeenCalled();
    expect(
      takeHeldRemoteBrowserOpen(studioBinding, {
        sessionId: "chat-other",
        laneId: "lane-studio",
      }),
    ).toEqual(forwardedOpen);
  });

  it("opens and closes the Work Terminal sidebar from the Work surface", async () => {
    workMocks.projectRoot = "/repo-one";
    mockBrowserEvents();

    const { rerender } = render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "toggle terminal pane" }));
    expect(workMocks.fns.setLaneWorkViewState).toHaveBeenCalledWith(
      "/repo-one",
      "lane-primary",
      { workSidebarTool: "terminal", workSidebarOpenTools: ["terminal"] },
    );

    vi.clearAllMocks();
    workMocks.currentWork = {
      ...workMocks.baseWork,
      workSidebarOpen: true,
      closingPtyIds: new Set<string>(),
    };
    workMocks.laneWorkViewByScope = {
      "/repo-one::lane-primary": { workSidebarTool: "terminal" },
    };
    rerender(<TerminalsPage />);

    expect(screen.getByRole("button", { name: "toggle terminal pane" }).getAttribute("data-terminal-open")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "toggle terminal pane" }));
    expect(workMocks.currentWork.setWorkSidebarOpen).toHaveBeenCalledWith(false);

    vi.clearAllMocks();
    // Already on Terminal: "open terminal pane" must not re-write the scope.
    fireEvent.click(screen.getByRole("button", { name: "open terminal pane" }));
    expect(workMocks.fns.setLaneWorkViewState).not.toHaveBeenCalled();
  });

  it("targets the visible Work draft when no saved session is active", async () => {
    mockBrowserEvents();
    workMocks.currentWork = {
      ...workMocks.baseWork,
      workSidebarOpen: true,
      draftLaneId: "lane-background",
      draftKind: "chat",
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    expect(await screen.findByTestId("work-sidebar")).toBeTruthy();
    expect(sidebarProps.latest).toEqual(expect.objectContaining({
      laneId: "lane-background",
      contextDisabledReason: null,
      contextTarget: {
        kind: "draft",
        draftTargetId: "work:draft:lane-background:chat",
        laneId: "lane-background",
        draftKind: "chat",
      },
    }));
  });

  it("targets active chat sessions and running agent CLI sessions", async () => {
    mockBrowserEvents();
    const chatSession = workMocks.makeTerminalSession("chat-1", "lane-primary", "codex-chat");
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [chatSession],
      visibleSessions: [chatSession],
      activeItemId: "chat-1",
      workSidebarOpen: true,
      closingPtyIds: new Set<string>(),
    };

    const { rerender } = render(<TerminalsPage />);

    expect(await screen.findByTestId("work-sidebar")).toBeTruthy();
    expect(sidebarProps.latest?.contextTarget).toEqual({ kind: "chat", sessionId: "chat-1" });

    const cliSession = workMocks.makeTerminalSession("term-codex", "lane-primary", "codex");
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [cliSession],
      visibleSessions: [cliSession],
      activeItemId: "term-codex",
      workSidebarOpen: true,
      closingPtyIds: new Set<string>(),
    };

    rerender(<TerminalsPage />);

    expect(sidebarProps.latest?.contextTarget).toEqual({
      kind: "pty",
      sessionId: "term-codex",
      ptyId: "pty-term-codex",
      toolType: "codex",
    });
    expect(sidebarProps.latest?.contextDisabledReason).toBeNull();
  });

  /*
   * The owner's 2026-09-23 report: a lane's simulator floated over the
   * new-chat screen. That screen resolves `activeLaneId` to the composer's
   * draft lane, so a surface built from it would call the new chat "the same
   * lane" — the surface must come from the session in front, and there is none.
   */
  it("hands the floating device no surface on the new-chat screen, even with a lane in the composer", async () => {
    mockBrowserEvents();
    workMocks.currentWork = {
      ...workMocks.baseWork,
      activeItemId: null,
      draftLaneId: "lane-background",
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    await screen.findByTestId("work-view-area");
    expect(miniPlayerProps.latest).toBeDefined();
    expect(miniPlayerProps.latest?.surface).toBeNull();
  });

  /*
   * `ade ui show` and the floating device an agent's work brings up. The page
   * takes requests only for the session in front: another lane's chat and the
   * new-chat screen get nothing, and a request for a chat in the background is
   * held for when the user opens it.
   */
  describe("show requests", () => {
    let nextRequest = 1;
    const showRequest = (overrides: Partial<WorkToolShowRequest>): WorkToolShowRequest => ({
      requestId: `wts-${nextRequest++}`,
      surface: "apple",
      chatSessionId: "chat-1",
      laneId: "lane-background",
      auto: false,
      requestedAt: new Date(0).toISOString(),
      ...overrides,
    });
    const renderWithChatInFront = async (overrides: Record<string, unknown> = {}) => {
      mockBrowserEvents();
      workMocks.projectRoot = "/repo";
      const chatSession = workMocks.makeTerminalSession("chat-1", "lane-background", "codex-chat");
      workMocks.currentWork = {
        ...workMocks.baseWork,
        sessions: [chatSession],
        visibleSessions: [chatSession],
        activeItemId: "chat-1",
        closingPtyIds: new Set<string>(),
        ...overrides,
      };
      render(<TerminalsPage />);
      await screen.findByTestId("work-view-area");
    };

    /** The pane, as far as a show can tell: the tool mounts when it is written. */
    const paneMountsWhatIsWritten = () => {
      setDocumentVisibleForTests(true);
      workMocks.fns.setLaneWorkViewState.mockImplementation(
        (_root: string, laneId: string, next: { workSidebarTool?: string | null }) => {
          if (next.workSidebarTool) mountTool(next.workSidebarTool, laneId);
        },
      );
    };

    it("opens the Apple tool, the browser, or Mac Desktop for the chat in front", async () => {
      paneMountsWhatIsWritten();
      await renderWithChatInFront();
      await expect(answerWorkToolShowRequest(showRequest({ surface: "apple" }))).resolves.toEqual({ status: "shown" });
      expect(workMocks.fns.setLaneWorkViewState).toHaveBeenLastCalledWith(
        "/repo",
        "lane-background",
        { workSidebarTool: "ios", workSidebarOpenTools: ["ios"] },
      );
      await expect(answerWorkToolShowRequest(showRequest({ surface: "browser" }))).resolves.toEqual({ status: "shown" });
      expect(workMocks.fns.setLaneWorkViewState).toHaveBeenLastCalledWith(
        "/repo",
        "lane-background",
        expect.objectContaining({ workSidebarTool: "browser" }),
      );
      await expect(answerWorkToolShowRequest(showRequest({ surface: "mac-desktop" }))).resolves.toEqual({ status: "shown" });
      expect(workMocks.fns.setLaneWorkViewState).toHaveBeenLastCalledWith(
        "/repo",
        "lane-background",
        expect.objectContaining({ workSidebarTool: "mac-desktop" }),
      );
    });

    /*
     * Regression, 2026-09-23 (chat 13d65dd4): `apple show` printed "shown"
     * while only the floating player was on screen. "shown" now waits for the
     * Apple tool to mount in a pane the user can see.
     */
    it("answers shown for the Apple tool only once it is on screen", async () => {
      // The pane does not mount on its own here: this test mounts it.
      workMocks.fns.setLaneWorkViewState.mockImplementation(() => undefined);
      setDocumentVisibleForTests(true);
      await renderWithChatInFront();
      let answer: string | null = "pending";
      const pending = answerWorkToolShowRequest(showRequest({ surface: "apple" }))
        .then((reply) => { answer = reply?.status ?? null; });
      await waitFor(() => expect(workMocks.fns.setLaneWorkViewState).toHaveBeenCalledWith(
        "/repo",
        "lane-background",
        expect.objectContaining({ workSidebarTool: "ios" }),
      ));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(answer).toBe("pending");
      // The pane mounts the Apple tool (which takes the device back from the
      // floating player): now it is shown.
      mountTool("ios", "lane-background");
      await pending;
      expect(answer).toBe("shown");
    });

    it("answers held, not shown, when the pane never becomes visible", async () => {
      // A hidden window runs no animation frames: the pane stays a sliver.
      workMocks.fns.setLaneWorkViewState.mockImplementation(() => undefined);
      setDocumentVisibleForTests(false);
      await renderWithChatInFront();
      mountTool("ios", "lane-background");
      await expect(answerWorkToolShowRequest(showRequest({ surface: "apple" }))).resolves.toMatchObject({ status: "held" });
    }, 10_000);

    /* Regression (A2-3 / D3): the hidden window's show opened the tool, so it
     * is spent: re-registering (a tab switch and back) must not reopen it. */
    it("does not replay a show it already opened in a hidden window", async () => {
      workMocks.fns.setLaneWorkViewState.mockImplementation(() => undefined);
      setDocumentVisibleForTests(false);
      await renderWithChatInFront();
      await expect(answerWorkToolShowRequest(showRequest({ surface: "apple" }))).resolves.toMatchObject({ status: "held" });
      workMocks.fns.setLaneWorkViewState.mockClear();
      cleanup();
      render(<TerminalsPage />);
      await screen.findByTestId("work-view-area");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(workMocks.fns.setLaneWorkViewState).not.toHaveBeenCalledWith(
        "/repo",
        "lane-background",
        expect.objectContaining({ workSidebarTool: "ios" }),
      );
    }, 10_000);

    /* Regression (A2-6): a lane-less chat's tools mount under the pane's
     * fallback lane, so "shown" waits on that lane, not on no lane. */
    it("answers shown for a lane-less chat once the tool is on screen in the pane's lane", async () => {
      paneMountsWhatIsWritten();
      await renderWithChatInFront({
        sessions: [workMocks.makeTerminalSession("chat-1", "", "codex-chat")],
        visibleSessions: [workMocks.makeTerminalSession("chat-1", "", "codex-chat")],
      });
      await expect(answerWorkToolShowRequest(showRequest({ surface: "apple", laneId: null }))).resolves.toEqual({ status: "shown" });
      expect(workMocks.fns.setLaneWorkViewState).toHaveBeenLastCalledWith(
        "/repo",
        "lane-primary",
        expect.objectContaining({ workSidebarTool: "ios" }),
      );
    });

    it("answers a lane-less chat's floating device from the pane's lane, and never floats one", async () => {
      setDocumentVisibleForTests(true);
      await renderWithChatInFront({
        sessions: [workMocks.makeTerminalSession("chat-1", "", "codex-chat")],
        visibleSessions: [workMocks.makeTerminalSession("chat-1", "", "codex-chat")],
      });
      // No Apple tool on screen: the player sits only over a chat of its own lane.
      await expect(answerWorkToolShowRequest(showRequest({ surface: "floating-apple", laneId: null })))
        .resolves.toMatchObject({ status: "held" });
      expect(floatMocks.floatAppleMiniPlayerForChat).not.toHaveBeenCalled();
      // The Apple tool is on screen in the pane's lane: that is the device.
      mountTool("ios", "lane-primary");
      await expect(answerWorkToolShowRequest(showRequest({ surface: "floating-apple", laneId: null })))
        .resolves.toEqual({ status: "shown" });
      expect(floatMocks.floatAppleMiniPlayerForChat).not.toHaveBeenCalled();
    });

    it("holds a request for a chat that is not in front without touching this pane", async () => {
      await renderWithChatInFront();
      workMocks.fns.setLaneWorkViewState.mockClear();
      await expect(answerWorkToolShowRequest(showRequest({ chatSessionId: "chat-other" }))).resolves.toMatchObject({ status: "held" });
      expect(workMocks.fns.setLaneWorkViewState).not.toHaveBeenCalled();
    });

    it("floats the device for an agent driving the chat in front", async () => {
      await renderWithChatInFront();
      await answerWorkToolShowRequest(showRequest({ surface: "floating-apple", auto: true }));
      expect(floatMocks.floatAppleMiniPlayerForChat).toHaveBeenCalledWith({
        laneId: "lane-background",
        chatSessionId: "chat-1",
        runtimePin: null,
        auto: true,
      });
    });

    it("floats nothing for another chat's agent, and nothing on the new-chat screen", async () => {
      await renderWithChatInFront();
      await expect(answerWorkToolShowRequest(
        showRequest({ surface: "floating-apple", auto: true, chatSessionId: "chat-other", laneId: "lane-other" }),
      )).resolves.toBeNull();
      expect(floatMocks.floatAppleMiniPlayerForChat).not.toHaveBeenCalled();
      cleanup();

      workMocks.currentWork = {
        ...workMocks.baseWork,
        activeItemId: null,
        draftLaneId: "lane-background",
        closingPtyIds: new Set<string>(),
      };
      render(<TerminalsPage />);
      await screen.findByTestId("work-view-area");
      await expect(answerWorkToolShowRequest(showRequest({ surface: "floating-apple", auto: true })))
        .resolves.toBeNull();
      expect(floatMocks.floatAppleMiniPlayerForChat).not.toHaveBeenCalled();
    });

    it("does not float over the Apple tool when it is on screen, or while it opens", async () => {
      workMocks.laneWorkViewByScope = {
        "/repo::lane-background": { workSidebarTool: "ios", workSidebarOpenTools: ["ios"] },
      };
      await renderWithChatInFront({ workSidebarOpen: true });
      // Opening: written, not yet mounted.
      await expect(answerWorkToolShowRequest(showRequest({ surface: "floating-apple", auto: true })))
        .resolves.toBeNull();
      setDocumentVisibleForTests(true);
      mountTool("ios", "lane-background");
      await expect(answerWorkToolShowRequest(showRequest({ surface: "floating-apple", auto: true })))
        .resolves.toEqual({ status: "shown" });
      expect(floatMocks.floatAppleMiniPlayerForChat).not.toHaveBeenCalled();
    });

    it("opens the Apple tool when `apple launch --open-drawer` names the chat in front", async () => {
      let iosListener: ((event: unknown) => void) | null = null;
      Object.defineProperty(window, "ade", {
        configurable: true,
        value: {
          builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
          iosSimulator: {
            onEvent: vi.fn((listener: (event: unknown) => void) => {
              iosListener = listener;
              return vi.fn();
            }),
          },
        },
      });
      workMocks.projectRoot = "/repo";
      const chatSession = workMocks.makeTerminalSession("chat-1", "lane-background", "codex-chat");
      workMocks.currentWork = {
        ...workMocks.baseWork,
        sessions: [chatSession],
        visibleSessions: [chatSession],
        activeItemId: "chat-1",
        closingPtyIds: new Set<string>(),
      };
      render(<TerminalsPage />);
      await waitFor(() => expect(iosListener).not.toBeNull());
      iosListener!({ type: "drawer-open-requested", action: "launch", mode: "interact", chatSessionId: "chat-other", laneId: null });
      expect(workMocks.fns.setLaneWorkViewState).not.toHaveBeenCalledWith(
        "/repo",
        "lane-background",
        expect.objectContaining({ workSidebarTool: "ios" }),
      );
      iosListener!({ type: "drawer-open-requested", action: "launch", mode: "interact", chatSessionId: "chat-1", laneId: "lane-background" });
      expect(workMocks.fns.setLaneWorkViewState).toHaveBeenCalledWith(
        "/repo",
        "lane-background",
        expect.objectContaining({ workSidebarTool: "ios" }),
      );
    });

    describe("Mac Desktop", () => {
      afterEach(() => {
        resetMacDesktopCardGrantsForTests();
        window.localStorage.clear();
        resetChatCompanionUiStateCacheForTests();
      });

      /*
       * Accessibility-mode input takes no lease and nothing watches yet, so the
       * card never appeared for the chat whose agent drove the display. The
       * agent's activity now authorizes the card, for that chat on that lane.
       */
      it("authorizes the floating card for the chat whose agent drives the display, and no other", async () => {
        await renderWithChatInFront();
        await answerWorkToolShowRequest(showRequest({ surface: "floating-mac-desktop", auto: true }));
        expect(macDesktopCardGrantedAt("lane-background", "chat-1")).not.toBeNull();

        await expect(answerWorkToolShowRequest(showRequest({
          surface: "floating-mac-desktop",
          auto: true,
          chatSessionId: "chat-other",
          laneId: "lane-other",
        }))).resolves.toBeNull();
        expect(macDesktopCardGrantedAt("lane-other", "chat-other")).toBeNull();
        expect(macDesktopCardGrantedAt("lane-background", "chat-other")).toBeNull();
      });

      it("floats nothing automatically while the chat's preview is off, or while the tool opens", async () => {
        setWorkLivePreviewEnabledForChat("chat-1", "mac-desktop", false);
        await renderWithChatInFront();
        await answerWorkToolShowRequest(showRequest({ surface: "floating-mac-desktop", auto: true }));
        expect(macDesktopCardGrantedAt("lane-background", "chat-1")).toBeNull();
        cleanup();

        setWorkLivePreviewEnabledForChat("chat-1", "mac-desktop", true);
        workMocks.laneWorkViewByScope = {
          "/repo::lane-background": { workSidebarTool: "mac-desktop", workSidebarOpenTools: ["mac-desktop"] },
        };
        await renderWithChatInFront({ workSidebarOpen: true });
        await answerWorkToolShowRequest(showRequest({ surface: "floating-mac-desktop", auto: true }));
        expect(macDesktopCardGrantedAt("lane-background", "chat-1")).toBeNull();
      });

      it("floats the card when asked by name, past an earlier ×, and answers shown once it is on screen", async () => {
        setWorkLivePreviewEnabledForChat("chat-1", "mac-desktop", false);
        setDocumentVisibleForTests(true);
        await renderWithChatInFront();
        let answer: string | null = "pending";
        const pending = answerWorkToolShowRequest(showRequest({ surface: "floating-mac-desktop" }))
          .then((result) => { answer = result?.status ?? null; });
        await waitFor(() => expect(macDesktopCardGrantedAt("lane-background", "chat-1")).not.toBeNull());
        expect(readChatCompanionUiState("chat-1").workLiveCardFloating).toContain("mac-desktop");
        expect(readChatCompanionUiState("chat-1").workLiveCardClosedByTool["mac-desktop"]).toBeUndefined();
        expect(answer).toBe("pending");
        // The card mounts over the chat: now it is shown.
        noteFloatingWorkSurfaceShown(workSurfaceKey(MAC_DESKTOP_CARD_ON_SCREEN_KEY, "bound", "lane-background"));
        await pending;
        expect(answer).toBe("shown");
      });
    });
  });

  it("hands the floating device the lane and machine of the session in front", async () => {
    mockBrowserEvents();
    const bound: OpenProjectBinding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "repo",
    };
    workMocks.projectBinding = bound;
    const chatSession = workMocks.makeTerminalSession("chat-1", "lane-background", "codex-chat");
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [chatSession],
      visibleSessions: [chatSession],
      activeItemId: "chat-1",
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    await screen.findByTestId("work-view-area");
    expect(miniPlayerProps.latest?.surface).toEqual({
      laneId: "lane-background",
      runtimePin: null,
      boundBinding: bound,
    });
  });

  it("resolves a foreign active session from the union and routes the tools pane at its machine", async () => {
    const studioBinding = STUDIO_BINDING;
    const foreignSession = workMocks.makeTerminalSession("term-studio", "lane-studio", "codex");
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": studioMachine("lane-studio", [foreignSession]),
    };
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [],
      sessionsById: new Map([[foreignSession.id, foreignSession]]),
      visibleSessions: [foreignSession],
      activeItemId: foreignSession.id,
      workSidebarOpen: true,
      closingPtyIds: new Set<string>(),
    };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        workTools: { onShowRequest: vi.fn(() => vi.fn()), acknowledgeShow: vi.fn() },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        iosSimulator: { onEvent: vi.fn(() => vi.fn()) },
      },
    });

    render(<TerminalsPage />);

    expect(await screen.findByTestId("work-sidebar")).toBeTruthy();
    expect(sidebarProps.latest?.activeSession).toBe(foreignSession);
    // A CLI session's PTY is addressable by pin, so context insertion stays
    // available and every tool in the pane is routed at the studio.
    expect(sidebarProps.latest).toEqual(expect.objectContaining({
      runtimePin: studioBinding,
      contextDisabledReason: null,
      contextTarget: {
        kind: "pty",
        sessionId: foreignSession.id,
        ptyId: foreignSession.ptyId,
        toolType: "codex",
      },
    }));
  });

  it("keeps a foreign grid member through an active-machine-only refresh", async () => {
    const localSession = workMocks.makeTerminalSession("term-local", "lane-primary", "codex");
    const foreignSession = workMocks.makeTerminalSession("term-foreign", "lane-foreign", "codex");
    const gridSets = [{
      id: "grid-1",
      layoutId: "layout-grid-1",
      sessionIds: [localSession.id, foreignSession.id],
    }];
    const setGridSets = vi.fn();
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [localSession],
      sessionsById: new Map([
        [localSession.id, localSession],
        [foreignSession.id, foreignSession],
      ]),
      gridSets,
      setGridSets,
      closingPtyIds: new Set<string>(),
    };
    mockBrowserEvents();
    const rendered = render(<TerminalsPage />);
    await waitFor(() => expect(setGridSets).toHaveBeenCalled());

    setGridSets.mockClear();
    const refreshedLocal = { ...localSession, lastOutputPreview: "refreshed" };
    workMocks.currentWork = {
      ...workMocks.currentWork,
      sessions: [refreshedLocal],
      sessionsById: new Map([
        [refreshedLocal.id, refreshedLocal],
        [foreignSession.id, foreignSession],
      ]),
    };
    rendered.rerender(<TerminalsPage />);

    await waitFor(() => expect(setGridSets).toHaveBeenCalledTimes(1));
    const update = setGridSets.mock.calls[0]?.[0];
    expect(typeof update).toBe("function");
    expect(update(gridSets)).toBe(gridSets);
  });

  it("prunes a foreign grid member missing from its present machine slice", async () => {
    const studioBinding = STUDIO_BINDING;
    const localSession = workMocks.makeTerminalSession("term-local", "lane-primary", "codex");
    const foreignSession = workMocks.makeTerminalSession("term-foreign", "lane-foreign", "codex");
    const gridSets = [{
      id: "grid-1",
      layoutId: "layout-grid-1",
      sessionIds: [localSession.id, foreignSession.id],
    }];
    const setGridSets = vi.fn();
    const foreignMachine = {
      machineId: "target-studio",
      machineName: "Mac Studio",
      targetId: "target-studio",
      projectId: "project-a",
      binding: studioBinding,
      lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: "lane-foreign" }],
      sessions: [foreignSession],
      online: true,
    };
    workMocks.crossMachineLanesByMachineId = { "target-studio": foreignMachine };
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [localSession],
      sessionsById: new Map([
        [localSession.id, localSession],
        [foreignSession.id, foreignSession],
      ]),
      gridSets,
      setGridSets,
      closingPtyIds: new Set<string>(),
    };
    mockBrowserEvents();
    const rendered = render(<TerminalsPage />);
    await waitFor(() => expect(setGridSets).toHaveBeenCalled());

    setGridSets.mockClear();
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": { ...foreignMachine, sessions: [] },
    };
    workMocks.currentWork = {
      ...workMocks.currentWork,
      sessionsById: new Map([[localSession.id, localSession]]),
    };
    rendered.rerender(<TerminalsPage />);

    await waitFor(() => expect(setGridSets).toHaveBeenCalledTimes(1));
    const update = setGridSets.mock.calls[0]?.[0];
    expect(typeof update).toBe("function");
    expect(update(gridSets)).toEqual([]);
  });

  it("prunes a retained grid and runtime pin when scope intent removes a pending machine", async () => {
    const bindingA: OpenProjectBinding = {
      kind: "remote",
      key: "remote:target-a:project-a",
      targetId: "target-a",
      runtimeName: "Machine A",
      projectId: "project-a",
      rootPath: "/repo-a",
      displayName: "Repo A",
    };
    const bindingB: OpenProjectBinding = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      runtimeName: "Machine B",
      projectId: "project-b",
      rootPath: "/repo-b",
      displayName: "Repo B",
    };
    const sessionA = workMocks.makeTerminalSession("term-a", "lane-a", "codex");
    const sessionB = workMocks.makeTerminalSession("term-b", "lane-b", "codex");
    const machineA = {
      machineId: "target-a",
      machineName: "Machine A",
      targetId: "target-a",
      projectId: "project-a",
      binding: bindingA,
      lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: "lane-a" }],
      sessions: [sessionA],
      online: true,
    };
    const machineB = {
      machineId: "target-b",
      machineName: "Machine B",
      targetId: "target-b",
      projectId: "project-b",
      binding: bindingB,
      lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: "lane-b" }],
      sessions: [sessionB],
      online: true,
    };
    const gridSets = [{
      id: "grid-1",
      layoutId: "layout-grid-1",
      sessionIds: [sessionA.id, sessionB.id],
    }];
    const setGridSets = vi.fn();
    workMocks.crossMachineLaneIntendedMachineIds = ["target-a", "target-b"];
    workMocks.crossMachineLanesByMachineId = {
      "target-a": machineA,
      "target-b": machineB,
    };
    workMocks.currentWork = {
      ...workMocks.baseWork,
      gridSets,
      setGridSets,
      closingPtyIds: new Set<string>(),
    };
    mockBrowserEvents();

    const rendered = render(<TerminalsPage />);
    await waitFor(() => expect(setGridSets).toHaveBeenCalled());
    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(sessionB)?.key).toBe(bindingB.key);

    workMocks.crossMachineLanesByMachineId = {};
    rendered.rerender(<TerminalsPage />);
    workMocks.crossMachineLanesByMachineId = { "target-a": machineA };
    rendered.rerender(<TerminalsPage />);
    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(sessionB)?.key).toBe(bindingB.key);

    setGridSets.mockClear();
    workMocks.crossMachineLaneIntendedMachineIds = ["target-a"];
    rendered.rerender(<TerminalsPage />);

    expect(workViewAreaProps.latest?.resolveSessionRuntimePin?.(sessionB)).toBeNull();
    await waitFor(() => expect(setGridSets).toHaveBeenCalledTimes(1));
    const update = setGridSets.mock.calls[0]?.[0];
    expect(typeof update).toBe("function");
    expect(update(gridSets)).toEqual([]);
  });

  it("bulk deletes selected running chat sessions from the session list", async () => {
    const runningCodexChat = workMocks.makeTerminalSession("chat-running-codex", "lane-primary", "codex-chat");
    const runningClaudeChat = workMocks.makeTerminalSession("chat-running-claude", "lane-primary", "claude-chat", {
      ptyId: null,
    });
    const runningShell = workMocks.makeTerminalSession("shell-running", "lane-primary", "shell");
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.mocked(confirmDialog).mockResolvedValue(true);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCodexChat, runningClaudeChat, runningShell],
      visibleSessions: [runningCodexChat, runningClaudeChat, runningShell],
      runningFiltered: [runningCodexChat, runningClaudeChat, runningShell],
      runningSessions: [runningCodexChat, runningClaudeChat, runningShell],
      filtered: [runningCodexChat, runningClaudeChat, runningShell],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCodexChat, runningClaudeChat, runningShell]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "select chat-running-codex" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "select chat-running-claude" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "select shell-running" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "bulk delete" }));

    await waitFor(() => {
      expect(agentChatDelete).toHaveBeenCalledTimes(2);
      expect(agentChatDelete).toHaveBeenCalledWith({ sessionId: "chat-running-codex" });
      expect(agentChatDelete).toHaveBeenCalledWith({ sessionId: "chat-running-claude" });
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-running-codex");
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-running-claude");
    });
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(workMocks.currentWork.removeSessionFromList).not.toHaveBeenCalledWith("shell-running");
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete 2 selected sessions?" }));
    confirmSpy.mockResolvedValue(false);
  });

  it("refreshes orphaned session records without deleting sessions or lanes", async () => {
    const orphanedChat = workMocks.makeTerminalSession("chat-orphaned", "lane-missing", "codex-chat", {
      status: "completed",
      runtimeState: "exited",
    });
    const orphanedShell = workMocks.makeTerminalSession("shell-orphaned", "lane-missing", "shell", {
      status: "completed",
      runtimeState: "exited",
    });
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const laneDelete = vi.fn();
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [orphanedChat, orphanedShell],
      visibleSessions: [orphanedChat, orphanedShell],
      endedFiltered: [orphanedChat, orphanedShell],
      filtered: [orphanedChat, orphanedShell],
      sessionsGroupedByLane: new Map([["lane-missing", [orphanedChat, orphanedShell]]]),
    };
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        lanes: { delete: laneDelete },
        sessions: { delete: sessionDelete },
      },
    });

    render(<TerminalsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "refresh orphaned records" }));

    await waitFor(() => {
      expect(workMocks.currentWork.refresh).toHaveBeenCalledWith({ showLoading: false, force: true });
    });
    expect(agentChatDelete).not.toHaveBeenCalled();
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(laneDelete).not.toHaveBeenCalled();
    expect(workMocks.currentWork.removeSessionFromList).not.toHaveBeenCalled();
  });

  it("stops and deletes a single running CLI session via the context menu", async () => {
    const runningCli = workMocks.makeTerminalSession("cli-single", "lane-primary", "codex");
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.mocked(confirmDialog).mockClear().mockResolvedValue(true);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCli],
      visibleSessions: [runningCli],
      runningFiltered: [runningCli],
      runningSessions: [runningCli],
      filtered: [runningCli],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCli]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    // Open the context menu for the session, then trigger stop-and-delete.
    fireEvent.click(await screen.findByRole("button", { name: "context menu cli-single" }));
    fireEvent.click(await screen.findByRole("button", { name: "context stop and delete cli-single" }));

    // The styled confirmation dialog must gate the destructive single-session action.
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: "Stop and delete session",
      confirmLabel: "Stop & delete",
      destructive: true,
    }));

    await waitFor(() => {
      // The session-delete service stops the runtime and removes the record in one call;
      // the chat-delete path must not be touched for a non-chat session.
      expect(sessionDelete).toHaveBeenCalledWith({ sessionId: "cli-single" });
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("cli-single");
      expect(workMocks.currentWork.closeTab).toHaveBeenCalledWith("cli-single");
    });
    expect(agentChatDelete).not.toHaveBeenCalled();
  });

  it("keeps a foreign runtime pin after the context menu closes for confirmation", async () => {
    const runningCli = workMocks.makeTerminalSession("cli-studio", "lane-primary", "codex");
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    vi.mocked(confirmDialog).mockResolvedValue(true);
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
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: vi.fn() },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCli],
      visibleSessions: [runningCli],
      runningFiltered: [runningCli],
      runningSessions: [runningCli],
      filtered: [runningCli],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCli]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);
    act(() => {
      sessionListPaneProps.latest?.onContextMenu(
        runningCli,
        { clientX: 10, clientY: 20 } as React.MouseEvent,
        binding,
        "Studio",
      );
    });
    fireEvent.click(await screen.findByRole("button", {
      name: "context stop and delete cli-studio",
    }));

    await waitFor(() => {
      expect(sessionDelete).toHaveBeenCalledWith(
        { sessionId: "cli-studio" },
        binding,
      );
    });
  });

  it("clears a foreign optimistic chat after its pinned delete succeeds", async () => {
    const foreignChat = workMocks.makeTerminalSession(
      "chat-studio",
      "lane-primary",
      "codex-chat",
      { ptyId: null },
    );
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
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [foreignChat],
      visibleSessions: [foreignChat],
      runningFiltered: [foreignChat],
      runningSessions: [foreignChat],
      filtered: [foreignChat],
      sessionsGroupedByLane: new Map([["lane-primary", [foreignChat]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);
    act(() => {
      sessionListPaneProps.latest?.onContextMenu(
        foreignChat,
        { clientX: 10, clientY: 20 } as React.MouseEvent,
        binding,
        "Studio",
      );
    });
    fireEvent.click(await screen.findByRole("button", {
      name: "context delete chat chat-studio",
    }));

    await waitFor(() => {
      expect(agentChatDelete).toHaveBeenCalledWith({ sessionId: "chat-studio" }, binding);
      expect(crossMachineMocks.cancelOptimistic).toHaveBeenCalledWith(binding, "chat-studio");
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-studio");
    });
  });

  it("delegates pending-input dismissal and settlement to one backend operation", async () => {
    const pendingChat = workMocks.makeTerminalSession(
      "chat-pending",
      "lane-primary",
      "codex-chat",
      {
        ptyId: null,
        runtimeState: "waiting-input",
        pendingInputItemId: "pending-1",
      },
    );
    const settle = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { settle },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [pendingChat],
      visibleSessions: [pendingChat],
      runningFiltered: [],
      awaitingInputFiltered: [pendingChat],
      runningSessions: [pendingChat],
      filtered: [pendingChat],
      sessionsGroupedByLane: new Map([["lane-primary", [pendingChat]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "context menu chat-pending" }));
    fireEvent.click(await screen.findByRole("button", { name: "context settle chat-pending" }));

    await waitFor(() => {
      expect(settle).toHaveBeenCalledWith("chat-pending", {
        dismissPendingInput: true,
      });
    });
  });

  it("does not delete when the stop-and-delete confirmation is dismissed", async () => {
    const runningCli = workMocks.makeTerminalSession("cli-cancel", "lane-primary", "codex");
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    let resolveConfirm: (accepted: boolean) => void = () => {};
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    const confirmSpy = vi.mocked(confirmDialog).mockClear().mockReturnValueOnce(confirmation);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: vi.fn() },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCli],
      visibleSessions: [runningCli],
      runningFiltered: [runningCli],
      runningSessions: [runningCli],
      filtered: [runningCli],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCli]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "context menu cli-cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "context stop and delete cli-cancel" }));

    // Declined (the mock resolves false): nothing is stopped or deleted.
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Stop and delete session" }),
    ));
    await act(async () => {
      resolveConfirm(false);
      await expect(confirmation).resolves.toBe(false);
    });
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(workMocks.currentWork.removeSessionFromList).not.toHaveBeenCalled();
  });

  it("stops and deletes a mixed selection of running CLI and chat sessions", async () => {
    const runningCli = workMocks.makeTerminalSession("cli-running", "lane-primary", "codex");
    const runningChat = workMocks.makeTerminalSession("chat-running", "lane-primary", "codex-chat", {
      ptyId: null,
    });
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.mocked(confirmDialog).mockClear().mockResolvedValue(true);

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [runningCli, runningChat],
      visibleSessions: [runningCli, runningChat],
      runningFiltered: [runningCli, runningChat],
      runningSessions: [runningCli, runningChat],
      filtered: [runningCli, runningChat],
      sessionsGroupedByLane: new Map([["lane-primary", [runningCli, runningChat]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "select cli-running" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "select chat-running" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "bulk stop and delete" }));

    // The styled confirmation dialog gates the destructive action.
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: "Stop and delete sessions",
      confirmLabel: "Stop & delete",
    })));

    await waitFor(() => {
      // The running CLI session is stopped+deleted via the session-delete service,
      // and the chat is removed via the chat delete flow — both in one action.
      expect(sessionDelete).toHaveBeenCalledWith({ sessionId: "cli-running" });
      expect(agentChatDelete).toHaveBeenCalledWith({ sessionId: "chat-running" });
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("cli-running");
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-running");
    });
  });

  const studioBindingForDelete = STUDIO_BINDING;

  const mountForeignMachine = (sessions: TerminalSessionSummary[]) => {
    workMocks.openRemoteProjectTabs = [studioBindingForDelete];
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": {
        machineId: "target-studio",
        machineName: "Mac Studio",
        targetId: "target-studio",
        projectId: "project-a",
        binding: studioBindingForDelete,
        lanes: [{ ...workMocks.baseWork.lanes[1] as LaneSummary, id: "lane-foreign" }],
        sessions,
        online: true,
      },
    };
  };

  it("routes a delete to the machine that owns the session, not the bound one", async () => {
    // The row carries no binding — exactly what the info popover passes, and what
    // a stale row sitting in the active roster looks like. Ownership still has to
    // come from the session→machine router, or the call lands on the bound
    // machine and comes back "Session '…' was not found."
    const foreignChat = workMocks.makeTerminalSession("chat-foreign-delete", "lane-foreign", "codex-chat", {
      ptyId: null,
    });
    const agentChatDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.mocked(confirmDialog).mockResolvedValue(true);
    mountForeignMachine([foreignChat]);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: vi.fn() },
      },
    });

    render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    const event = { shiftKey: false, metaKey: false, ctrlKey: false } as React.MouseEvent;
    act(() => {
      sessionListPaneProps.latest?.onContextMenu(foreignChat, event);
    });
    fireEvent.click(await screen.findByRole("button", { name: "context delete chat chat-foreign-delete" }));

    await waitFor(() => {
      expect(agentChatDelete).toHaveBeenCalledWith(
        { sessionId: "chat-foreign-delete" },
        expect.objectContaining({ key: studioBindingForDelete.key }),
      );
    });
    confirmSpy.mockResolvedValue(false);
  });

  it("clears a foreign row's woke marker on its own machine when opened via Hand off", async () => {
    // Hand off… selects the row like a plain click, so it must clear the woke
    // marker through the row's own binding. Dropping the binding cleared it
    // against the tab's bound runtime instead, leaving the foreign row "woke".
    const foreignChat = workMocks.makeTerminalSession("chat-foreign-handoff", "lane-foreign", "codex-chat", {
      ptyId: null,
    });
    const clearWokeMarker = vi.fn().mockResolvedValue(undefined);
    mountForeignMachine([foreignChat]);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: vi.fn() },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: vi.fn(), clearWokeMarker },
      },
    });

    render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    const event = { shiftKey: false, metaKey: false, ctrlKey: false } as React.MouseEvent;
    act(() => {
      sessionListPaneProps.latest?.onContextMenu(foreignChat, event, studioBindingForDelete);
    });
    fireEvent.click(await screen.findByRole("button", { name: "context handoff local chat-foreign-handoff" }));

    await waitFor(() => {
      expect(clearWokeMarker).toHaveBeenCalledWith(
        "chat-foreign-handoff",
        expect.objectContaining({ key: studioBindingForDelete.key }),
      );
    });
  });

  it("mass-deletes selected rows that live on another machine", async () => {
    // Bulk selection used to be resolved against the active binding's roster
    // alone, so a selection of foreign rows produced an empty deletable set and
    // the header's Delete button did nothing at all.
    const foreignShell = workMocks.makeTerminalSession("shell-foreign-bulk", "lane-foreign", "shell", {
      status: "completed",
      runtimeState: "exited",
    });
    const sessionDelete = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.mocked(confirmDialog).mockResolvedValue(true);
    mountForeignMachine([foreignShell]);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: vi.fn() },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: sessionDelete },
      },
    });

    render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    const event = { shiftKey: false, metaKey: true, ctrlKey: false } as React.MouseEvent;
    act(() => {
      sessionListPaneProps.latest?.onSelectForeignRuntimeSession?.(
        foreignShell,
        studioBindingForDelete,
        event,
        [foreignShell.id],
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "bulk delete" }));

    await waitFor(() => {
      expect(sessionDelete).toHaveBeenCalledWith(
        { sessionId: "shell-foreign-bulk" },
        expect.objectContaining({ key: studioBindingForDelete.key }),
      );
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("shell-foreign-bulk");
    });
    confirmSpy.mockResolvedValue(false);
  });

  it("finishes a bulk delete past a row that fails, and never shows the IPC channel", async () => {
    const failing = workMocks.makeTerminalSession("chat-stale", "lane-primary", "codex-chat", { ptyId: null });
    const healthy = workMocks.makeTerminalSession("chat-live", "lane-primary", "codex-chat", { ptyId: null });
    const agentChatDelete = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "chat-stale") {
        throw new Error(
          "Error invoking remote method 'ade.localRuntime.callAction': Error: Session 'chat-stale' was not found.",
        );
      }
    });
    const confirmSpy = vi.mocked(confirmDialog).mockResolvedValue(true);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: { delete: agentChatDelete },
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        sessions: { delete: vi.fn() },
      },
    });
    workMocks.currentWork = {
      ...workMocks.baseWork,
      sessions: [failing, healthy],
      visibleSessions: [failing, healthy],
      runningFiltered: [failing, healthy],
      runningSessions: [failing, healthy],
      filtered: [failing, healthy],
      sessionsGroupedByLane: new Map([["lane-primary", [failing, healthy]]]),
      closingPtyIds: new Set<string>(),
    };

    render(<TerminalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "select chat-stale" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "select chat-live" }), { metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "bulk delete" }));

    await waitFor(() => {
      // One bad row must not abort the batch.
      expect(agentChatDelete).toHaveBeenCalledTimes(2);
      expect(workMocks.currentWork.removeSessionFromList).toHaveBeenCalledWith("chat-live");
    });
    expect(workMocks.currentWork.removeSessionFromList).not.toHaveBeenCalledWith("chat-stale");
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("1 of 2 deleted");
    expect(banner.textContent).not.toContain("Error invoking remote method");
    expect(banner.textContent).toContain("Refresh the list");
    confirmSpy.mockResolvedValue(false);
  });

  it("gives the tools-pane splitter a keyboard, not just a mouse", () => {
    workMocks.currentWork = {
      ...workMocks.baseWork,
      workSidebarOpen: true,
      workSidebarWidthPct: 36,
      closingPtyIds: new Set<string>(),
    };
    mockBrowserEvents();

    render(<TerminalsPage />);

    const separator = screen.getByRole("separator", { name: "Resize tools pane" });
    expect(separator.getAttribute("tabindex")).toBe("0");
    expect(separator.getAttribute("aria-valuenow")).toBe("36");
    expect(separator.getAttribute("aria-valuemin")).toBe("26");
    expect(separator.getAttribute("aria-valuemax")).toBe("55");

    // The separator moves, so ArrowLeft widens the pane on its right.
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(workMocks.currentWork.setWorkSidebarWidthPct).toHaveBeenCalledWith(38);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(workMocks.currentWork.setWorkSidebarWidthPct).toHaveBeenCalledWith(26);

    fireEvent.keyDown(separator, { key: "End" });
    expect(workMocks.currentWork.setWorkSidebarWidthPct).toHaveBeenCalledWith(55);
  });

  it("puts the pane back on Escape without writing the abandoned drag to the store", () => {
    // Escape abandons the drag without writing a width to the store.
    workMocks.currentWork = {
      ...workMocks.baseWork,
      workSidebarOpen: true,
      workSidebarWidthPct: 36,
      closingPtyIds: new Set<string>(),
    };
    mockBrowserEvents();

    render(<TerminalsPage />);

    const separator = screen.getByRole("separator", { name: "Resize tools pane" });
    // jsdom lays nothing out, and a zero-width container refuses the drag.
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 0, width: 1000, height: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.mouseDown(separator, { clientX: 600 });

    // Drag left: the separator moves, so the pane on its right widens.
    fireEvent.mouseMove(document, { clientX: 500 });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(workMocks.currentWork.setWorkSidebarWidthPct).not.toHaveBeenCalled();

    // A drag that ENDS normally still persists where it was let go.
    fireEvent.mouseDown(separator, { clientX: 600 });
    fireEvent.mouseUp(document);
    expect(workMocks.currentWork.setWorkSidebarWidthPct).toHaveBeenCalledWith(36);
  });

  it("points the Mac Desktop corner card at the focused chat's machine", async () => {
    // After #1269 the card takes the same session-machine pin the tools pane
    // does: a Studio chat read from a MacBook-bound tab must ask the Studio
    // about its own screen, so the card's reads carry the Studio binding.
    const studioBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:target-studio:project-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio",
      transport: "paired",
      projectId: "project-a",
      rootPath: "/remote/repo-a",
      displayName: "repo-a",
    };
    const chat = workMocks.makeTerminalSession("chat-studio", "lane-studio", "codex-chat");
    workMocks.projectRoot = "/repo";
    workMocks.projectBinding = {
      kind: "local",
      key: "local:/repo",
      rootPath: "/repo",
      displayName: "repo",
    };
    workMocks.openRemoteProjectTabs = [studioBinding];
    workMocks.crossMachineLanesByMachineId = {
      "target-studio": studioMachine("lane-studio", [chat]),
    };
    workMocks.currentWork = {
      ...workMocks.baseWork,
      activeItemId: "chat-studio",
      selectedSessionId: "chat-studio",
      sessions: [chat],
      sessionsById: new Map([[chat.id, chat]]),
      closingPtyIds: new Set<string>(),
    };
    const getStreamStatus = vi.fn(async () => ({
      laneId: "lane-studio",
      running: false,
      fps: 0,
      idle: false,
      bitrateKbps: null,
      transport: null,
      lastError: null,
      clients: 0,
      viewerChatSessionIds: ["chat-studio"],
    }));
    const getStatus = vi.fn(async () => ({
      supported: true,
      display: null,
      lease: null,
      windows: [],
      recording: null,
    }));
    const onEvent = vi.fn(() => () => {});
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        builtInBrowser: { onEvent: vi.fn(() => vi.fn()) },
        // A Studio-pinned chat listens for `ade ui show` and Apple drawer
        // requests on its own pin.
        iosSimulator: { onEvent: vi.fn(() => vi.fn()) },
        workTools: { onShowRequest: vi.fn(() => vi.fn()), acknowledgeShow: vi.fn() },
        macDesktop: { getStatus, getStreamStatus, onEvent },
      },
    });

    render(<TerminalsPage />);
    await screen.findByTestId("session-list-pane");

    await waitFor(() => expect(getStreamStatus).toHaveBeenCalledWith(
      { laneId: "lane-studio" },
      studioBinding,
    ));
    // The capability probe behind the tool's availability asked the same
    // machine — a remote Studio does not hide Mac Desktop, and a local tab
    // does not answer for it.
    expect(getStatus).toHaveBeenCalledWith({}, studioBinding);
    expect(getStatus).toHaveBeenCalledWith(
      { laneId: "lane-studio", chatSessionId: "chat-studio" },
      studioBinding,
    );
    expect(onEvent).toHaveBeenCalledWith(expect.any(Function), studioBinding);
  });

});
