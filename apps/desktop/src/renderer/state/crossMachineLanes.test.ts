/* @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSession, LaneSummary, TerminalSessionSummary } from "../../shared/types";
import { detectPushDivergence } from "../../shared/laneDivergence";
import { THIS_MACHINE_ID } from "../../shared/machineIdentity";
import { useAppStore } from "./appStore";
import {
  buildCrossMachineLaneRows,
  cancelCrossMachineOptimisticChatSession,
  decodeForeignLanes,
  decodeForeignPrs,
  decodeForeignSessions,
  reconcileCrossMachineOptimisticSessions,
  orderCrossMachineRows,
  resolveCrossMachineLaneMarkers,
  resolveThisMachineBindingForOrigin,
  resetCrossMachineLaneSyncForTest,
  seedCrossMachineOptimisticChatSession,
  selectOtherMachineBranchStates,
  startCrossMachineLaneSync,
  useCrossMachineLaneUnion,
} from "./crossMachineLanes";

const originalAde = globalThis.window.ade;

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Lane One",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/one",
    worktreePath: "/tmp/lane-one",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  } as LaneSummary;
}

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Lane One",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: null,
    toolType: "claude-chat",
    title: "Foreign chat",
    status: "running",
    startedAt: "2026-07-20T10:05:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: null,
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  } as TerminalSessionSummary;
}

/** jsdom reports `visible` and has no API to change it. */
function setDocumentVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  setDocumentVisibility("visible");
  useAppStore.setState({
    lanes: [],
    projectBinding: null,
    crossMachineLaneScopeKey: null,
    crossMachineLaneIntendedMachineIds: null,
    crossMachineLanesByMachineId: {},
  });
  resetCrossMachineLaneSyncForTest();
});

afterEach(() => {
  resetCrossMachineLaneSyncForTest();
  vi.useRealTimers();
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

describe("offline machines stay in the sidebar, dimmed", () => {
  it("keeps a dropped machine's lanes and chats, flagged offline", () => {
    const store = useAppStore.getState();
    store.mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      targetId: "target-studio",
      projectId: "project-a",
      online: true,
      lanes: [makeLane({ id: "lane-foreign", name: "Foreign Lane" })],
      sessions: [makeSession({ id: "session-foreign", laneId: "lane-foreign" })],
    });

    // Wifi drops: the snapshot no longer lists the machine as connected.
    useAppStore.getState().setCrossMachineMachinesOnline([]);

    const entry = useAppStore.getState().crossMachineLanesByMachineId["target-studio"];
    expect(entry.online).toBe(false);
    expect(entry.lanes.map((lane) => lane.id)).toEqual(["lane-foreign"]);
    expect(entry.sessions.map((session) => session.id)).toEqual(["session-foreign"]);

    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: useAppStore.getState().crossMachineLanesByMachineId,
    });
    // The machine is unreachable, not gone: the sidebar still renders the row,
    // dimmed, and the push-divergence guard still has its last-known branch state.
    expect(rows).toHaveLength(1);
    expect(rows[0].online).toBe(false);
    expect(rows[0].sessions).toHaveLength(1);
    expect(orderCrossMachineRows(rows)).toHaveLength(1);
  });

  it("sinks offline rows below reachable ones", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          online: false,
          // Newer activity than the reachable machine, and still ranked below it.
          lanes: [makeLane({ id: "lane-offline", createdAt: "2026-07-28T10:00:00.000Z" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
        "target-laptop": {
          machineId: "target-laptop",
          machineName: "MacBook Pro (97)",
          targetId: "target-laptop",
          projectId: "project-a",
          online: true,
          lanes: [makeLane({ id: "lane-online", createdAt: "2026-07-20T10:00:00.000Z" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });
    expect(orderCrossMachineRows(rows).map((row) => row.lane.id))
      .toEqual(["lane-online", "lane-offline"]);
  });

  it("forgets a machine outright only when asked to", () => {
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      online: true,
      lanes: [makeLane({ id: "lane-foreign" })],
    });
    useAppStore.getState().dropCrossMachineLanes(["target-studio"]);
    expect(useAppStore.getState().crossMachineLanesByMachineId["target-studio"]).toBeUndefined();
    expect(useAppStore.getState().crossMachineLaneIntendedMachineIds).toEqual([]);
    const empty = useAppStore.getState().crossMachineLanesByMachineId;
    useAppStore.getState().dropCrossMachineLanes(["target-studio"]);
    expect(useAppStore.getState().crossMachineLanesByMachineId).toBe(empty);
  });

  it("keeps the last known lanes when a read fails", () => {
    const store = useAppStore.getState();
    store.mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      online: true,
      lanes: [makeLane({ id: "lane-foreign" })],
    });
    // A failed read records the error and nothing else.
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      error: "lane.list timed out after 8000ms",
    });

    const entry = useAppStore.getState().crossMachineLanesByMachineId["target-studio"];
    expect(entry.error).toContain("timed out");
    expect(entry.lanes.map((lane) => lane.id)).toEqual(["lane-foreign"]);
  });

  it("keeps identity stable when nothing changed, so selectors don't re-render", () => {
    vi.useFakeTimers();
    const lane = makeLane();
    vi.setSystemTime(new Date("2026-07-27T10:00:00Z"));
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      online: true,
      lanes: [lane],
    });
    const beforeEntry = useAppStore.getState().crossMachineLanesByMachineId["target-studio"];
    vi.setSystemTime(new Date("2026-07-27T10:00:05Z"));
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      online: true,
      lanes: [lane],
    });
    const refreshedEntry = useAppStore.getState().crossMachineLanesByMachineId["target-studio"];
    expect(refreshedEntry.lanes).toBe(beforeEntry.lanes);
    expect(refreshedEntry.lastSyncedAtMs).toBeGreaterThan(beforeEntry.lastSyncedAtMs ?? 0);
    const before = useAppStore.getState().crossMachineLanesByMachineId;
    useAppStore.getState().setCrossMachineMachinesOnline(["target-studio"]);
    expect(useAppStore.getState().crossMachineLanesByMachineId).toBe(before);
  });

  it("reuses decoded lane and session arrays when their content is unchanged", () => {
    const lane = makeLane();
    const session = makeSession();
    const store = useAppStore.getState();
    store.mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      lanes: [lane],
      sessions: [session],
    });
    const before = useAppStore.getState().crossMachineLanesByMachineId["target-studio"];

    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      lanes: [{ ...lane }],
      sessions: [{ ...session }],
    });
    const after = useAppStore.getState().crossMachineLanesByMachineId["target-studio"];

    expect(after.lanes).toBe(before.lanes);
    expect(after.sessions).toBe(before.sessions);
  });

  it("drops the union when the repo scope changes", () => {
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      lanes: [makeLane()],
    });
    useAppStore.getState().applyCrossMachineLaneScope("local:/repo-a");
    expect(useAppStore.getState().crossMachineLanesByMachineId).toEqual({});
    expect(useAppStore.getState().crossMachineLaneIntendedMachineIds).toEqual(["target-studio"]);
    const empty = useAppStore.getState().crossMachineLanesByMachineId;
    const intended = useAppStore.getState().crossMachineLaneIntendedMachineIds;
    useAppStore.getState().applyCrossMachineLaneScope("local:/repo-a");
    expect(useAppStore.getState().crossMachineLanesByMachineId).toBe(empty);
    expect(useAppStore.getState().crossMachineLaneIntendedMachineIds).toBe(intended);
  });
});

describe("This computer counterpart resolution", () => {
  it("joins only an existing local checkout with the same normalized origin", () => {
    expect(resolveThisMachineBindingForOrigin([
      {
        rootPath: "/missing",
        displayName: "Missing",
        lastOpenedAt: "2026-07-20T10:00:00Z",
        exists: false,
        gitOriginUrl: "https://github.com/acme/ADE.git",
      },
      {
        rootPath: "/repo-a",
        displayName: "Repo A",
        lastOpenedAt: "2026-07-20T10:00:00Z",
        exists: true,
        gitOriginUrl: "git@github.com:Acme/ADE.git",
      },
    ], "https://github.com/acme/ade")).toEqual({
      kind: "local",
      key: "local:/repo-a",
      rootPath: "/repo-a",
      displayName: "Repo A",
    });
  });
});

describe("local session dedupe", () => {
  const foreignLane = () => makeLane({ id: "lane-foreign", branchRef: "feature/foreign" });
  const foreignMachine = (sessions: ReturnType<typeof makeSession>[]) => ({
    "target-studio": {
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      targetId: "target-studio",
      projectId: "project-a",
      online: true,
      lanes: [foreignLane()],
      sessions,
      prs: [],
      lastSyncedAtMs: Date.now(),
      error: null,
    },
  });

  /**
   * The reported bug: one newly-started chat rendered as two rows — once bare
   * from the active binding's roster, once under its lane group with a machine
   * badge — each with its own elapsed clock, until the optimistic entry
   * reconciled away. Machine-level exclusion cannot catch it, because the
   * duplicate arrives from a machine that is genuinely not the bound one.
   */
  it("drops a foreign session the local roster already owns", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: foreignMachine([
        makeSession({ id: "session-shared", laneId: "lane-foreign" }),
        makeSession({ id: "session-foreign-only", laneId: "lane-foreign" }),
      ]),
      localSessionIds: new Set(["session-shared"]),
    });
    const foreign = rows.find((row) => row.machineId === "target-studio");
    // Per session, not per lane: work the local roster does not own survives.
    expect(foreign?.sessions.map((session) => session.id)).toEqual(["session-foreign-only"]);
  });

  it("keeps every foreign session when the local roster owns none of them", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: foreignMachine([makeSession({ id: "session-foreign-only", laneId: "lane-foreign" })]),
      localSessionIds: new Set(["session-unrelated"]),
    });
    expect(rows.find((row) => row.machineId === "target-studio")?.sessions).toHaveLength(1);
  });

  it("leaves the union untouched when no local ids are supplied", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: foreignMachine([makeSession({ id: "session-shared", laneId: "lane-foreign" })]),
    });
    expect(rows.find((row) => row.machineId === "target-studio")?.sessions).toHaveLength(1);
  });

  /**
   * Claiming is scoped to lanes the machine actually reports. A slice that
   * lists a session for a lane it does not have renders nothing for it, so
   * claiming it there would block the machine that DOES have that lane — and
   * the session would disappear from the sidebar altogether, which is worse
   * than the duplicate this dedupe exists to remove.
   */
  it("does not let a machine claim a session whose lane it never reported", () => {
    const shared = makeSession({ id: "session-shared", laneId: "lane-foreign" });
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: {
        // Reports the session but not its lane: contributes no row for it.
        "target-laptop": {
          machineId: "target-laptop",
          machineName: "MacBook Pro (97)",
          targetId: "target-laptop",
          projectId: "project-a",
          online: true,
          lanes: [],
          sessions: [shared],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
        ...foreignMachine([shared]),
      },
    });
    expect(rows.find((row) => row.machineId === "target-studio")?.sessions).toHaveLength(1);
  });

  /**
   * The same rule across machines, not just against the local roster: two
   * slices reporting one session must not both render it. The palette's
   * `buildThreadIndex` already worked this way; the union now matches.
   */
  it("gives a session claimed by two machines to the first one only", () => {
    const shared = makeSession({ id: "session-shared", laneId: "lane-foreign" });
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: {
        ...foreignMachine([shared]),
        "target-laptop": {
          machineId: "target-laptop",
          machineName: "MacBook Pro (97)",
          targetId: "target-laptop",
          projectId: "project-a",
          online: true,
          lanes: [foreignLane()],
          sessions: [shared],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });
    expect(rows.find((row) => row.machineId === "target-studio")?.sessions).toHaveLength(1);
    expect(rows.find((row) => row.machineId === "target-laptop")?.sessions).toHaveLength(0);
  });
});

describe("union memo stability", () => {
  afterEach(() => {
    useAppStore.setState({ crossMachineLanesByMachineId: {}, lanes: [], projectBinding: null });
    resetCrossMachineLaneSyncForTest();
  });

  function seedOneForeignMachine() {
    useAppStore.setState({
      lanes: [],
      projectBinding: null,
      crossMachineLanesByMachineId: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          online: true,
          lanes: [makeLane({ id: "lane-foreign", branchRef: "feature/foreign" })],
          sessions: [makeSession({ id: "session-foreign", laneId: "lane-foreign" })],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });
  }

  /**
   * The roster array is replaced wholesale by every session poll (~5s while
   * anything is running). Deriving the suppression set from its identity would
   * rebuild every foreign row, its marker map, and its ordering on a timer — a
   * background CPU cost with nothing on screen changing. This pins the content
   * comparison that prevents it; without it the union churns silently and no
   * other test notices.
   */
  it("returns identical references when a new roster array carries the same ids", () => {
    seedOneForeignMachine();
    const { result, rerender } = renderHook(
      ({ roster }) => useCrossMachineLaneUnion(false, roster),
      { initialProps: { roster: [makeSession({ id: "session-local", laneId: "lane-local" })] } },
    );
    const before = result.current;

    // A poll: brand-new array, brand-new session objects, same ids.
    rerender({ roster: [makeSession({ id: "session-local", laneId: "lane-local" })] });

    expect(result.current).toBe(before);
    expect(result.current.foreignRows).toBe(before.foreignRows);
  });

  it("rebuilds when the roster's ids actually change", () => {
    seedOneForeignMachine();
    const { result, rerender } = renderHook(
      ({ roster }) => useCrossMachineLaneUnion(false, roster),
      { initialProps: { roster: [] as TerminalSessionSummary[] } },
    );
    expect(result.current.foreignRows[0]?.sessions).toHaveLength(1);

    // The local roster adopts that session — it must leave the union.
    rerender({ roster: [makeSession({ id: "session-foreign", laneId: "lane-foreign" })] });

    expect(result.current.foreignRows[0]?.sessions ?? []).toHaveLength(0);
  });
});

describe("machine marker", () => {
  const localRow = () => makeLane({ id: "lane-local", branchRef: "feature/local" });

  it("marks only lanes that are not on this machine", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [localRow()],
      machines: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          online: true,
          lanes: [makeLane({ id: "lane-foreign", branchRef: "feature/foreign" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });
    const markers = resolveCrossMachineLaneMarkers(rows);
    expect(markers.has("lane-local")).toBe(false);
    expect(markers.get("target-studio:lane-foreign")?.machineName).toBe("Mac Studio (12)");
    expect(markers.get("target-studio:lane-foreign")?.mode).toBe("glyph");
  });

  it("renders no markers at all on a single-machine setup", () => {
    const rows = buildCrossMachineLaneRows({ localLanes: [localRow()], machines: {} });
    expect(rows.every((row) => row.machineId === THIS_MACHINE_ID)).toBe(true);
    expect(resolveCrossMachineLaneMarkers(rows).size).toBe(0);
  });

  it("attributes the active lane slice to its remote binding without duplicating it", () => {
    const activeBinding = {
      kind: "remote" as const,
      key: "remote:target-studio:project-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio (12)",
      projectId: "project-a",
      rootPath: "/repo-a",
      displayName: "Repo A",
    };
    const activeLane = makeLane({ id: "lane-active", branchRef: "feature/active" });
    const thisMacLane = makeLane({ id: "lane-this-mac", branchRef: "feature/local" });
    const rows = buildCrossMachineLaneRows({
      localLanes: [activeLane],
      activeBinding,
      machines: {
        // A retained refresh of the active remote must not duplicate the live
        // active slice.
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          binding: activeBinding,
          // The active target stays represented by its primary list, but its
          // retained slice remains the reachability source of truth.
          online: false,
          lanes: [activeLane],
          sessions: [makeSession({ id: "session-duplicate", laneId: activeLane.id })],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
        [THIS_MACHINE_ID]: {
          machineId: THIS_MACHINE_ID,
          machineName: "This computer",
          targetId: null,
          projectId: null,
          binding: {
            kind: "local",
            key: "local:/repo-a",
            rootPath: "/repo-a",
            displayName: "Repo A",
          },
          online: true,
          lanes: [thisMacLane],
          sessions: [makeSession({ id: "session-local", laneId: thisMacLane.id })],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      lane: activeLane,
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      online: false,
      isThisMachine: false,
      isActiveBinding: true,
    });
    expect(rows[1]).toMatchObject({
      lane: thisMacLane,
      machineId: THIS_MACHINE_ID,
      isThisMachine: true,
      isActiveBinding: false,
      sessions: [{ id: "session-local" }],
    });
    expect(resolveCrossMachineLaneMarkers(rows).has("lane-active")).toBe(true);
  });

  it("marks an offline machine by name, and still counts its branch as elsewhere", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          online: false,
          lanes: [makeLane({ id: "lane-offline", branchRef: "feature/shared" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
        "target-laptop": {
          machineId: "target-laptop",
          machineName: "MacBook Pro (97)",
          targetId: "target-laptop",
          projectId: "project-a",
          online: true,
          lanes: [makeLane({ id: "lane-online", branchRef: "feature/shared" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });

    const markers = resolveCrossMachineLaneMarkers(rows);
    // Offline is carried by `online`, which dims the glyph and the whole row.
    // The form does NOT change with it: a marker that grew a name when a machine
    // dropped made the row reflow for a reason the reader could not see.
    expect(markers.get("target-studio:lane-offline")).toMatchObject({
      online: false,
      mode: "glyph",
    });
    // Commits stranded on a machine you cannot reach are exactly the ones worth
    // naming, so its branch still counts toward "same branch elsewhere".
    expect(markers.get("target-laptop:lane-online")).toMatchObject({
      online: true,
      mode: "glyph",
      sameBranchElsewhere: true,
    });
  });

  it("keeps the glyph form when two distinct foreign machines are visible at once", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: {
        a: {
          machineId: "a",
          machineName: "Mac Studio (12)",
          targetId: "a",
          projectId: "p",
          online: true,
          lanes: [makeLane({ id: "lane-a", branchRef: "feature/a" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: 1,
          error: null,
        },
        b: {
          machineId: "b",
          machineName: "MacBook Pro (97)",
          targetId: "b",
          projectId: "p",
          online: true,
          lanes: [makeLane({ id: "lane-b", branchRef: "feature/b" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    const markers = resolveCrossMachineLaneMarkers(rows);
    // Two foreign machines used to promote both names inline. They now stay
    // glyphs and are told apart on hover: a resting form that never moves beat
    // one that reflowed the column as machines came and went.
    expect(markers.get("a:lane-a")).toMatchObject({ mode: "glyph", title: "Mac Studio (12)" });
    expect(markers.get("b:lane-b")).toMatchObject({ mode: "glyph", title: "MacBook Pro (97)" });
  });

  it("flags a branch held on another machine without changing the marker's form", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [makeLane({ id: "lane-local", branchRef: "refs/heads/feature/shared" })],
      machines: {
        a: {
          machineId: "a",
          machineName: "Mac Studio (12)",
          targetId: "a",
          projectId: "p",
          online: true,
          lanes: [makeLane({ id: "lane-foreign", branchRef: "feature/shared" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    const marker = resolveCrossMachineLaneMarkers(rows).get("a:lane-foreign");
    // Still computed — the push-divergence guard reasons about the same
    // condition — but it no longer promotes the name.
    expect(marker?.sameBranchElsewhere).toBe(true);
    expect(marker?.mode).toBe("glyph");
    // The name is always reachable, glyph mode included.
    expect(marker?.title).toBe("Mac Studio (12)");
  });
});

describe("cross-machine optimistic chats", () => {
  it("seeds the owning machine slice immediately and replaces the same session id", () => {
    const binding = {
      kind: "remote" as const,
      key: "remote:target-studio:project-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio (12)",
      projectId: "project-a",
      rootPath: "/repo-a",
      displayName: "Repo A",
    };
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      targetId: "target-studio",
      projectId: "project-a",
      binding,
      online: true,
      lanes: [makeLane({ id: "lane-primary", name: "Primary" })],
      sessions: [makeSession({ id: "existing-chat", laneId: "lane-primary" })],
    });
    const session: AgentChatSession = {
      id: "new-chat",
      laneId: "lane-primary",
      provider: "codex",
      model: "gpt-5.4",
      status: "idle",
      createdAt: "2026-07-28T12:00:00.000Z",
      lastActivityAt: "2026-07-28T12:00:00.000Z",
    };

    seedCrossMachineOptimisticChatSession(session, binding, "Primary");
    seedCrossMachineOptimisticChatSession(
      { ...session, status: "active", lastActivityAt: "2026-07-28T12:00:01.000Z" },
      binding,
      "Primary",
    );

    const entry = useAppStore.getState().crossMachineLanesByMachineId["target-studio"];
    expect(entry?.sessions.map((candidate) => candidate.id)).toEqual([
      "new-chat",
      "existing-chat",
    ]);
    expect(entry?.sessions[0]).toEqual(expect.objectContaining({
      id: "new-chat",
      laneId: "lane-primary",
      laneName: "Primary",
      runtimeState: "running",
    }));

    const afterStaleRefresh = reconcileCrossMachineOptimisticSessions(binding, []);
    expect(afterStaleRefresh.map((candidate) => candidate.id)).toEqual(["new-chat"]);

    cancelCrossMachineOptimisticChatSession(binding, "new-chat");
    expect(reconcileCrossMachineOptimisticSessions(binding, [])).toEqual([]);
    expect(
      useAppStore.getState().crossMachineLanesByMachineId["target-studio"]?.sessions
        .map((candidate) => candidate.id),
    ).toEqual(["existing-chat"]);

    seedCrossMachineOptimisticChatSession(session, binding, "Primary");
    const authoritative = makeSession({
      id: "new-chat",
      laneId: "lane-primary",
      laneName: "Primary",
      title: "Named on the owning machine",
    });
    expect(reconcileCrossMachineOptimisticSessions(binding, [authoritative])).toEqual([
      authoritative,
    ]);
    expect(reconcileCrossMachineOptimisticSessions(binding, [])).toEqual([]);
  });
});

describe("selectOtherMachineBranchStates", () => {
  it("produces the branch state the push-divergence guard needs", () => {
    useAppStore.setState({
      lanes: [makeLane({ id: "lane-local", branchRef: "refs/heads/feature/shared" })],
      crossMachineLanesByMachineId: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          online: true,
          lanes: [
            makeLane({
              id: "lane-foreign",
              branchRef: "feature/shared",
              status: { dirty: false, ahead: 3, behind: 0, remoteBehind: 0, rebaseInProgress: false },
            }),
          ],
          sessions: [],
          prs: [],
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });

    const others = selectOtherMachineBranchStates(useAppStore.getState(), "lane-local");
    expect(others).toEqual([
      {
        machineId: "target-studio",
        machineName: "Mac Studio (12)",
        branchRef: "feature/shared",
        headSha: null,
        ahead: 3,
        behind: 0,
      },
    ]);

    const warning = detectPushDivergence({
      current: {
        machineId: THIS_MACHINE_ID,
        machineName: "This computer",
        branchRef: "feature/shared",
        headSha: null,
        ahead: 1,
        behind: 0,
      },
      others,
    });
    expect(warning).toEqual({
      machineName: "Mac Studio (12)",
      aheadBy: 3,
      branchRef: "feature/shared",
    });
  });

  it("ignores lanes on other branches and memoizes its answer", () => {
    useAppStore.setState({
      lanes: [makeLane({ id: "lane-local", branchRef: "feature/local-only" })],
      crossMachineLanesByMachineId: {
        a: {
          machineId: "a",
          machineName: "Mac Studio (12)",
          targetId: "a",
          projectId: "p",
          online: true,
          lanes: [makeLane({ id: "lane-foreign", branchRef: "feature/other" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    const first = selectOtherMachineBranchStates(useAppStore.getState(), "lane-local");
    expect(first).toHaveLength(0);
    expect(selectOtherMachineBranchStates(useAppStore.getState(), "lane-local")).toBe(first);
  });

  it("includes an offline machine — unreachable commits are the ones most worth naming", () => {
    useAppStore.setState({
      lanes: [makeLane({ id: "lane-local", branchRef: "feature/shared" })],
      crossMachineLanesByMachineId: {
        a: {
          machineId: "a",
          machineName: "Mac Studio (12)",
          targetId: "a",
          projectId: "p",
          online: false,
          lanes: [
            makeLane({
              id: "lane-foreign",
              branchRef: "feature/shared",
              status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
            }),
          ],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });
    expect(selectOtherMachineBranchStates(useAppStore.getState(), "lane-local")).toHaveLength(1);
  });

  it("ignores offline branch state that was never synced", () => {
    useAppStore.setState({
      lanes: [makeLane({ id: "lane-local", branchRef: "feature/shared" })],
      crossMachineLanesByMachineId: {
        a: {
          machineId: "a",
          machineName: "Mac Studio (12)",
          targetId: "a",
          projectId: "p",
          online: false,
          lanes: [makeLane({ id: "lane-foreign", branchRef: "feature/shared" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: null,
          error: "not yet reachable",
        },
      },
    });

    expect(selectOtherMachineBranchStates(useAppStore.getState(), "lane-local")).toHaveLength(0);
  });

  it("attributes active remote lanes correctly and ignores a retained duplicate", () => {
    const activeBinding = {
      kind: "remote" as const,
      key: "remote:target-studio:project-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio (12)",
      projectId: "project-a",
      rootPath: "/repo-a",
      displayName: "Repo A",
    };
    const activeLane = makeLane({ id: "lane-active", branchRef: "feature/shared" });
    useAppStore.setState({
      projectBinding: activeBinding,
      lanes: [activeLane],
      crossMachineLanesByMachineId: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          binding: activeBinding,
          online: true,
          lanes: [activeLane],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
        [THIS_MACHINE_ID]: {
          machineId: THIS_MACHINE_ID,
          machineName: "This computer",
          targetId: null,
          projectId: null,
          online: true,
          lanes: [
            makeLane({
              id: "lane-this-mac",
              branchRef: "feature/shared",
              status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
            }),
          ],
          sessions: [],
          prs: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });

    expect(selectOtherMachineBranchStates(useAppStore.getState(), "lane-active")).toEqual([
      expect.objectContaining({
        machineId: THIS_MACHINE_ID,
        branchRef: "feature/shared",
        ahead: 2,
      }),
    ]);
  });

  it("expires memoized offline branch state without a store update", () => {
    vi.useFakeTimers();
    const syncedAtMs = Date.parse("2026-07-27T10:00:00Z");
    vi.setSystemTime(syncedAtMs);
    useAppStore.setState({
      projectBinding: null,
      lanes: [makeLane({ id: "lane-local", branchRef: "feature/shared" })],
      crossMachineLanesByMachineId: {
        a: {
          machineId: "a",
          machineName: "Mac Studio (12)",
          targetId: "a",
          projectId: "p",
          online: false,
          lanes: [makeLane({ id: "lane-foreign", branchRef: "feature/shared" })],
          sessions: [],
          prs: [],
          lastSyncedAtMs: syncedAtMs,
          error: "offline",
        },
      },
    });

    expect(selectOtherMachineBranchStates(useAppStore.getState(), "lane-local")).toHaveLength(1);
    vi.advanceTimersByTime(60_001);
    expect(selectOtherMachineBranchStates(useAppStore.getState(), "lane-local")).toHaveLength(0);
  });
});

describe("foreign payload decoding", () => {
  it("drops entries that are not lane- or session-shaped", () => {
    expect(decodeForeignLanes([{ id: "a", name: "A", branchRef: "b" }, { id: "" }, null])).toHaveLength(1);
    expect(decodeForeignLanes({ lanes: [{ id: "a", name: "A", branchRef: "b" }] })).toHaveLength(1);
    expect(decodeForeignSessions([{ id: "s", laneId: "l" }, { id: "s2" }])).toHaveLength(1);
    expect(decodeForeignSessions("nope")).toEqual([]);
  });

  it("defaults an unprojected foreign chat to idle without masking explicit activity", () => {
    const [quiet, active, waiting, cli] = decodeForeignSessions([
      {
        id: "chat-quiet",
        laneId: "lane-1",
        status: "running",
        toolType: "claude-chat",
        currentTurnStartedAt: "2026-08-06T12:00:00.000Z",
      },
      {
        id: "chat-active",
        laneId: "lane-1",
        status: "running",
        toolType: "claude-chat",
        runtimeState: "running",
      },
      {
        id: "chat-waiting",
        laneId: "lane-1",
        status: "running",
        toolType: "claude-chat",
        pendingInputItemId: "approval-1",
      },
      {
        id: "cli-session",
        laneId: "lane-1",
        status: "running",
        toolType: "codex",
      },
    ]);

    expect(quiet).toEqual(expect.objectContaining({
      runtimeState: "idle",
      currentTurnStartedAt: null,
      chatIdleSinceAt: null,
    }));
    expect(active?.runtimeState).toBe("running");
    expect(waiting?.runtimeState).toBe("waiting-input");
    expect(cli?.runtimeState).toBeUndefined();
  });

  // A half-decoded PR renders "PR #undefined", or a badge whose click is a
  // silent no-op because the foreign click-through has nowhere to go. Dropping
  // the row shows no badge, which is honest.
  it("drops PR rows missing any field the foreign badge renders", () => {
    const complete = {
      id: "pr-1",
      laneId: "lane-1",
      headBranch: "feature/x",
      githubPrNumber: 91,
      githubUrl: "https://github.com/arul28/ADE/pull/91",
      state: "open",
    };

    expect(decodeForeignPrs([complete])).toHaveLength(1);
    expect(decodeForeignPrs({ prs: [complete] })).toHaveLength(1);
    expect(decodeForeignPrs([
      { ...complete, githubPrNumber: undefined },
      { ...complete, githubUrl: "" },
      { ...complete, laneId: "" },
      { ...complete, state: undefined },
      { ...complete, id: "" },
      null,
    ])).toEqual([]);
    expect(decodeForeignPrs("nope")).toEqual([]);
  });
});

describe("cross-machine refresh scheduling", () => {
  it("reads This computer explicitly while the active tab is bound remotely", async () => {
    vi.useFakeTimers();
    const localBinding = {
      kind: "local" as const,
      key: "local:/repo-a",
      rootPath: "/repo-a",
      displayName: "Repo A",
    };
    const listLanes = vi.fn(async () => [
      makeLane({ id: "lane-this-mac", branchRef: "feature/local" }),
    ]);
    const listSessions = vi.fn(async () => [
      makeSession({ id: "session-this-mac", laneId: "lane-this-mac" }),
    ]);
    window.ade = {
      lanes: { list: listLanes },
      sessions: { list: listSessions },
      remoteRuntime: {
        callAction: vi.fn(),
        getConnectionSnapshot: vi.fn(async () => ({
          connections: [{
            state: "connected",
            target: { id: "target-studio", name: "Mac Studio (12)", hostname: "studio" },
            projects: [{
              projectId: "project-a",
              rootPath: "/repo-a",
              displayName: "Repo A",
              gitOriginUrl: "git@github.com:acme/repo-a.git",
            }],
          }],
          connectedCount: 1,
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const stop = startCrossMachineLaneSync({
      scopeKey: "remote:target-studio:project-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: "target-studio",
      boundProjectId: "project-a",
      thisMachineBinding: localBinding,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);

    expect(listLanes).toHaveBeenCalledWith(
      { includeArchived: false, includeStatus: true },
      localBinding,
    );
    expect(listSessions).toHaveBeenCalledWith({ limit: 60 }, localBinding);
    expect(useAppStore.getState().crossMachineLanesByMachineId[THIS_MACHINE_ID])
      .toMatchObject({
        machineId: THIS_MACHINE_ID,
        binding: localBinding,
        lanes: [{ id: "lane-this-mac" }],
        sessions: [{ id: "session-this-mac" }],
      });

    stop();
  });

  it("waits for a slow refresh to settle before scheduling the next poll", async () => {
    vi.useFakeTimers();
    const pending: Array<(value: { result: unknown }) => void> = [];
    const callAction = vi.fn(
      () => new Promise<{ result: unknown }>((resolve) => pending.push(resolve)),
    );
    window.ade = {
      remoteRuntime: {
        callAction,
        getConnectionSnapshot: vi.fn(async () => ({
          connections: [{
            state: "connected",
            target: { id: "target-studio", name: "Mac Studio (12)", hostname: "studio" },
            projects: [{
              projectId: "project-a",
              rootPath: "/repo-a",
              displayName: "Repo A",
              gitOriginUrl: "git@github.com:acme/repo-a.git",
            }],
          }],
          connectedCount: 1,
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    // Three reads go out TOGETHER on a lane-cadence tick: lanes, chats and PRs.
    // PRs ride the lane cadence (a PR is only rendered by joining it to a lane)
    // and must be issued in parallel — reading them after the lane read would
    // hold this machine's lanes and chats behind a second 8s timeout and stall
    // every other machine's cadence with it.
    expect(callAction).toHaveBeenCalledTimes(3);

    // The old setInterval path started another generation on its own cadence,
    // invalidating this still-live read. A settled-chain poll must leave it alone
    // for as long as the read's own timeout allows it to run.
    await vi.advanceTimersByTimeAsync(7_500);
    expect(callAction).toHaveBeenCalledTimes(3);

    pending.splice(0).forEach((resolve, index) => resolve({
      result: index === 0 ? { lanes: [] } : index === 1 ? { sessions: [] } : { prs: [] },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(callAction).toHaveBeenCalledTimes(3);
    // The next tick reads chats only: the lane list (and with it the PR list)
    // has its own 30s cadence, and no chat referenced a lane this machine has
    // not already reported.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callAction).toHaveBeenCalledTimes(4);
    expect(callAction).toHaveBeenLastCalledWith(
      "target-studio",
      "project-a",
      expect.objectContaining({ domain: "session", action: "list" }),
    );

    stop();
  });

  it("re-reads lanes on their own slow cadence, and immediately for an unseen lane", async () => {
    vi.useFakeTimers();
    const requests: Array<{ domain: string; action: string }> = [];
    let sessionLaneId = "lane-known";
    const callAction = vi.fn(async (
      _targetId: string,
      _projectId: string,
      request: { domain: string; action: string },
    ) => {
      requests.push({ domain: request.domain, action: request.action });
      return request.domain === "lane"
        ? { result: { lanes: [{ id: "lane-known", name: "Known", branchRef: "feature/known" }] } }
        : { result: { sessions: [{ id: "session-1", laneId: sessionLaneId }] } };
    });
    window.ade = {
      remoteRuntime: {
        callAction,
        getConnectionSnapshot: vi.fn(async () => ({
          connections: [{
            state: "connected",
            target: { id: "target-studio", name: "Mac Studio (12)", hostname: "studio" },
            projects: [{
              projectId: "project-a",
              rootPath: "/repo-a",
              displayName: "Repo A",
              gitOriginUrl: "git@github.com:acme/repo-a.git",
            }],
          }],
          connectedCount: 1,
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    expect(requests.filter((entry) => entry.domain === "lane")).toHaveLength(1);

    // Two more ticks inside the lane window: chats only.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(requests.filter((entry) => entry.domain === "lane")).toHaveLength(1);
    expect(requests.filter((entry) => entry.domain === "session").length).toBeGreaterThan(1);

    // A chat on a lane we have never seen cannot be rendered without its lane
    // row, so it forces the read the slow cadence would have deferred.
    sessionLaneId = "lane-brand-new";
    await vi.advanceTimersByTimeAsync(10_500);
    expect(requests.filter((entry) => entry.domain === "lane")).toHaveLength(2);

    // That lane read did not explain it — `session.list` does not filter on lane
    // status while `lane.list` excludes archived lanes, so a chat on an archived
    // lane is permanently unresolvable. Asking again every tick would cost more
    // than the cadence this test exists to prove.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(requests.filter((entry) => entry.domain === "lane")).toHaveLength(2);

    stop();
  });

  // The bug this whole change exists to fix: a foreign machine's PR rows live in
  // ITS database, so they were never fetched and its cards/headers rendered no
  // PR badge until the project tab was rebound to that machine.
  it("stores a foreign machine's PRs on its slice, and fetches them for a catch-up lane", async () => {
    vi.useFakeTimers();
    const requests: Array<{ domain: string; action: string }> = [];
    let sessionLaneId = "lane-known";
    const callAction = vi.fn(async (
      _targetId: string,
      _projectId: string,
      request: { domain: string; action: string },
    ) => {
      requests.push({ domain: request.domain, action: request.action });
      if (request.domain === "lane") {
        return { result: { lanes: [
          { id: "lane-known", name: "Known", branchRef: "feature/known" },
          { id: "lane-brand-new", name: "New", branchRef: "feature/new" },
        ] } };
      }
      if (request.domain === "pr") {
        return { result: { prs: [{
          id: "pr-foreign",
          laneId: "lane-known",
          headBranch: "feature/known",
          githubPrNumber: 91,
          githubUrl: "https://github.com/acme/repo-a/pull/91",
          state: "open",
        }] } };
      }
      return { result: { sessions: [{ id: "session-1", laneId: sessionLaneId }] } };
    });
    window.ade = {
      remoteRuntime: {
        callAction,
        getConnectionSnapshot: vi.fn(async () => ({
          connections: [{
            state: "connected",
            target: { id: "target-studio", name: "Mac Studio (12)", hostname: "studio" },
            projects: [{
              projectId: "project-a",
              rootPath: "/repo-a",
              displayName: "Repo A",
              gitOriginUrl: "git@github.com:acme/repo-a.git",
            }],
          }],
          connectedCount: 1,
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);

    const slice = () => useAppStore.getState().crossMachineLanesByMachineId["target-studio"];
    expect(requests.filter((entry) => entry.domain === "pr")).toHaveLength(1);
    expect(slice()?.prs).toEqual([expect.objectContaining({ id: "pr-foreign", laneId: "lane-known" })]);

    // Chat-only ticks inside the lane window must not re-read PRs: they ride the
    // lane cadence, not the 10s chat cadence.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(requests.filter((entry) => entry.domain === "pr")).toHaveLength(1);
    expect(slice()?.prs).toHaveLength(1);

    // A chat on a lane we have never seen forces an off-cadence lane read. That
    // lane must arrive WITH its PR, or it renders blank for a full 30s cadence.
    sessionLaneId = "lane-brand-new";
    await vi.advanceTimersByTimeAsync(10_500);
    expect(requests.filter((entry) => entry.domain === "pr")).toHaveLength(2);

    stop();
  });

  it("does not let a late catch-up read suppress a new scope's first lane read", async () => {
    vi.useFakeTimers();
    const requests: Array<{ domain: string; action: string }> = [];
    const pendingLaneReads: Array<(value: { result: unknown }) => void> = [];
    let holdLaneReads = false;
    let sessionLaneId = "lane-one";
    const callAction = vi.fn((
      _targetId: string,
      _projectId: string,
      request: { domain: string; action: string },
    ) => {
      requests.push({ domain: request.domain, action: request.action });
      if (request.domain === "lane") {
        if (holdLaneReads) {
          return new Promise<{ result: unknown }>((resolve) => pendingLaneReads.push(resolve));
        }
        return Promise.resolve({ result: { lanes: [] } });
      }
      return Promise.resolve({ result: { sessions: [{ id: "session-1", laneId: sessionLaneId }] } });
    });
    const connections = [{
      state: "connected",
      target: { id: "target-studio", name: "Mac Studio (12)", hostname: "studio" },
      projects: [{
        projectId: "project-a",
        rootPath: "/repo-a",
        displayName: "Repo A",
        gitOriginUrl: "git@github.com:acme/repo-a.git",
      }],
    }];
    window.ade = {
      remoteRuntime: {
        callAction,
        getConnectionSnapshot: vi.fn(async () => ({ connections, connectedCount: 1 })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const scope = {
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    };
    const first = startCrossMachineLaneSync({ ...scope, scopeKey: "local:/repo-a" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    const laneReadsBefore = requests.filter((entry) => entry.domain === "lane").length;
    expect(laneReadsBefore).toBeGreaterThan(0);

    // A chat appears on a lane the machine has never listed, which forces the
    // catch-up read — and that read is still in flight when the user switches to
    // another checkout of the same repository.
    holdLaneReads = true;
    sessionLaneId = "lane-unlisted";
    await vi.advanceTimersByTimeAsync(10_500);
    expect(pendingLaneReads).toHaveLength(1);

    const second = startCrossMachineLaneSync({ ...scope, scopeKey: "local:/repo-a-copy" });
    first();
    holdLaneReads = false;
    pendingLaneReads.splice(0).forEach((resolve) => resolve({ result: { lanes: [] } }));
    await Promise.resolve();
    await Promise.resolve();

    // Stamping the cadence from that stale read would leave the new scope
    // without a lane list — and so without a single row — for a full cadence.
    const laneReadsAfterSwitch = requests.filter((entry) => entry.domain === "lane").length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests.filter((entry) => entry.domain === "lane").length)
      .toBeGreaterThan(laneReadsAfterSwitch);

    second();
  });

  it("stops polling while the window is hidden and refreshes on the way back", async () => {
    vi.useFakeTimers();
    const callAction = vi.fn(async () => ({ result: { sessions: [] } }));
    window.ade = {
      remoteRuntime: {
        callAction,
        getConnectionSnapshot: vi.fn(async () => ({
          connections: [{
            state: "connected",
            target: { id: "target-studio", name: "Mac Studio (12)", hostname: "studio" },
            projects: [{
              projectId: "project-a",
              rootPath: "/repo-a",
              displayName: "Repo A",
              gitOriginUrl: "git@github.com:acme/repo-a.git",
            }],
          }],
          connectedCount: 1,
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    const whileVisible = callAction.mock.calls.length;
    expect(whileVisible).toBeGreaterThan(0);

    setDocumentVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callAction).toHaveBeenCalledTimes(whileVisible);

    setDocumentVisibility("visible");
    await vi.advanceTimersByTimeAsync(400);
    expect(callAction.mock.calls.length).toBeGreaterThan(whileVisible);

    stop();
  });
});

describe("believing a drop before a machine dims", () => {
  const CONNECTED_TARGET = {
    id: "target-studio",
    name: "Mac Studio (12)",
    hostname: "studio",
  };
  const PROJECTS = [{
    projectId: "project-a",
    rootPath: "/repo-a",
    displayName: "Repo A",
    gitOriginUrl: "git@github.com:acme/repo-a.git",
  }];

  function snapshot(state: string) {
    return {
      connections: [{ state, target: CONNECTED_TARGET, projects: PROJECTS }],
      connectedCount: state === "connected" ? 1 : 0,
    };
  }

  /** Connected, but the machine no longer has a checkout of this repository. */
  function snapshotWithoutRepo() {
    return {
      connections: [{
        state: "connected",
        target: CONNECTED_TARGET,
        projects: [{
          projectId: "project-z",
          rootPath: "/some-other-repo",
          displayName: "Other Repo",
          gitOriginUrl: "git@github.com:acme/other-repo.git",
        }],
      }],
      connectedCount: 1,
    };
  }

  /** The target itself is gone — unpaired, or removed from the registry. */
  function emptySnapshot() {
    return { connections: [], connectedCount: 0 };
  }

  function startWithSnapshots(): {
    stop: () => void;
    push: (next: unknown) => void;
    pushState: (state: string) => void;
  } {
    let emit: ((next: unknown) => void) | null = null;
    // The snapshot read reports the machine's CURRENT state, the way the real
    // one does — a remount must not be told the machine is back.
    let latest: unknown = snapshot("connected");
    window.ade = {
      remoteRuntime: {
        // Reads never resolve: this suite is about reachability, not lane data.
        callAction: vi.fn(() => new Promise(() => {})),
        getConnectionSnapshot: vi.fn(async () => latest),
        onConnectionSnapshotChanged: vi.fn((listener: (next: unknown) => void) => {
          emit = listener;
          return () => { emit = null; };
        }),
      },
    } as unknown as typeof window.ade;
    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    return {
      stop,
      push: (next) => { latest = next; emit?.(next); },
      pushState: (state) => { latest = snapshot(state); emit?.(latest); },
    };
  }

  const entry = () =>
    useAppStore.getState().crossMachineLanesByMachineId["target-studio"];
  const isOnline = () => entry()?.online;

  // Seeded AFTER the sync starts: `startCrossMachineLaneSync` applies its repo
  // scope, which clears slices carried over from another scope.
  function seedMachine(): void {
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      targetId: "target-studio",
      projectId: "project-a",
      online: true,
      lanes: [makeLane({ id: "lane-foreign" })],
      sessions: [makeSession({ id: "session-foreign", laneId: "lane-foreign" })],
    });
  }

  async function startSeeded() {
    const handle = startWithSnapshots();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    seedMachine();
    expect(isOnline()).toBe(true);
    return handle;
  }

  it("dims only after a reconnect attempt has completed and failed", async () => {
    vi.useFakeTimers();
    const { stop, pushState } = await startSeeded();

    // `connect()` publishes `connecting` before every automatic redial, and one
    // failed liveness ping publishes `error`. Neither may dim the group on its own.
    pushState("connecting");
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    pushState("error");
    // The dial has now failed, but a single failed dial inside the floor is still
    // a blip: one connect candidate alone is allowed ten seconds.
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(isOnline()).toBe(true);

    // 45s after the FIRST drop, not after the latest snapshot.
    await vi.advanceTimersByTimeAsync(22_100);
    expect(isOnline()).toBe(false);
    // Dimmed, not deleted: the lanes and chats are still there to render.
    expect(entry().lanes).toHaveLength(1);
    expect(entry().sessions).toHaveLength(1);

    stop();
  });

  it("holds a machine that never finishes a dial until the ceiling", async () => {
    vi.useFakeTimers();
    const { stop, pushState } = await startSeeded();

    // A dial wedged past its own timeout: `connecting` forever, no verdict.
    pushState("connecting");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(isOnline()).toBe(false);

    stop();
  });

  it("dims a manually disconnected machine at the floor, with no attempt to wait for", async () => {
    vi.useFakeTimers();
    const { stop, pushState } = await startSeeded();

    // `idle` means nothing is dialing and nothing will start on its own, so
    // waiting for a failed attempt would wait forever.
    pushState("idle");
    await vi.advanceTimersByTimeAsync(44_000);
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(isOnline()).toBe(false);

    stop();
  });

  it("forgets a machine that has left the connection registry", async () => {
    vi.useFakeTimers();
    const { stop, push } = await startSeeded();

    push(emptySnapshot());
    // Nothing will ever refresh it again, so retaining rows would be a promise
    // ADE cannot keep.
    expect(entry()).toBeUndefined();

    stop();
  });

  it("forgets a machine that reconnects without a checkout of this repository", async () => {
    vi.useFakeTimers();
    const { stop, push } = await startSeeded();

    // Still "connected" — but the repo is provably gone from that machine, so it
    // is no longer a read target. Left to raw connection state it would stay
    // visible forever while never being refreshed again: permanently stale.
    push(snapshotWithoutRepo());
    expect(entry()).toBeUndefined();

    stop();
  });

  it("forgets a machine that has been unreachable for a full day", async () => {
    vi.useFakeTimers();
    const { stop, pushState } = await startSeeded();

    pushState("connecting");
    pushState("error");
    await vi.advanceTimersByTimeAsync(46_000);
    expect(isOnline()).toBe(false);
    expect(entry()).toBeDefined();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(entry()).toBeUndefined();

    stop();
  });

  it("keeps a dimmed machine dimmed across a remount", async () => {
    vi.useFakeTimers();
    const { stop, pushState } = await startSeeded();

    pushState("connecting");
    pushState("error");
    await vi.advanceTimersByTimeAsync(46_000);
    expect(isOnline()).toBe(false);

    // Leaving Work and coming back tears the shared runtime down, taking its
    // drop records with it while the store slice survives. Re-deriving a fresh
    // drop would restart the floor and flash the machine back to live, with its
    // group re-expanded and every action on it re-enabled.
    stop();
    const restarted = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(isOnline()).toBe(false);

    restarted();
  });

  it("dims a connected machine whose repository it can no longer prove", async () => {
    vi.useFakeTimers();
    const { stop, push } = await startSeeded();

    // Connected, folder name still matches, but the origin is gone from its
    // project record — so identity is `unknown`, not `missing`. It must not be
    // deleted, and it must not stay bright either: nothing is reading it.
    push({
      connections: [{
        state: "connected",
        target: CONNECTED_TARGET,
        projects: [{ ...PROJECTS[0], gitOriginUrl: null }],
      }],
      connectedCount: 1,
    });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(isOnline()).toBe(false);
    expect(entry()).toBeDefined();

    stop();
  });

  it("keeps a machine whose repository cannot be proven absent without an origin", async () => {
    vi.useFakeTimers();
    const snapshots: { emit: ((next: unknown) => void) | null } = { emit: null };
    window.ade = {
      remoteRuntime: {
        callAction: vi.fn(() => new Promise(() => {})),
        getConnectionSnapshot: vi.fn(async () => snapshot("connected")),
        onConnectionSnapshotChanged: vi.fn((listener: (next: unknown) => void) => {
          snapshots.emit = listener;
          return () => { snapshots.emit = null; };
        }),
      },
    } as unknown as typeof window.ade;
    // No origin for this scope, so a folder-name mismatch is the only evidence
    // available — and a name is not an identity. Deleting rows on that is not
    // recoverable, so the machine is held instead.
    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: null,
      boundTargetId: null,
      boundProjectId: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    seedMachine();

    snapshots.emit?.({
      connections: [{
        state: "connected",
        target: CONNECTED_TARGET,
        projects: [{
          projectId: "project-z",
          rootPath: "/elsewhere/some-other-name",
          displayName: "Some Other Name",
          gitOriginUrl: null,
        }],
      }],
      connectedCount: 1,
    });
    expect(entry()).toBeDefined();

    stop();
  });

  it("does not let a read that was in flight across a disconnect resurrect the machine", async () => {
    vi.useFakeTimers();
    const pendingReads: Array<(value: { result: unknown }) => void> = [];
    const snapshots: { emit: ((next: unknown) => void) | null } = { emit: null };
    window.ade = {
      remoteRuntime: {
        callAction: vi.fn(
          () => new Promise<{ result: unknown }>((resolve) => pendingReads.push(resolve)),
        ),
        getConnectionSnapshot: vi.fn(async () => snapshot("connected")),
        onConnectionSnapshotChanged: vi.fn((listener: (next: unknown) => void) => {
          snapshots.emit = listener;
          return () => { snapshots.emit = null; };
        }),
      },
    } as unknown as typeof window.ade;
    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    seedMachine();

    // Machine drops while its lane/session read is still in flight, and its
    // reconnect attempt fails.
    snapshots.emit?.(snapshot("connecting"));
    snapshots.emit?.(snapshot("error"));
    await vi.advanceTimersByTimeAsync(46_000);
    expect(isOnline()).toBe(false);

    // The read finally lands. It must not flip the machine back on: nothing
    // would dim it again until an unrelated snapshot happened to fire.
    pendingReads.splice(0).forEach((resolve, index) => resolve({
      result: index % 2 === 0 ? { lanes: [] } : { sessions: [] },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(isOnline()).toBe(false);

    stop();
  });

  it("keeps a first snapshot that resolves after the coalesced refresh has already run", async () => {
    vi.useFakeTimers();
    const pending: { release: (() => void) | null } = { release: null };
    window.ade = {
      remoteRuntime: {
        callAction: vi.fn(() => new Promise(() => {})),
        // Slower than REFRESH_COALESCE_MS, so the scheduled refresh bumps the
        // refresh generation before this resolves. Guarding the first read on
        // that generation would discard it, leaving `runtime.connections` empty
        // and no foreign machine ever discovered.
        getConnectionSnapshot: vi.fn(() => new Promise((resolve) => {
          pending.release = () => resolve(snapshot("connecting"));
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const stop = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    seedMachine();
    pending.release?.();
    await vi.advanceTimersByTimeAsync(100);
    // The snapshot survived, so its verdict applies: the machine is held while
    // the dial is outstanding and dims at the ceiling. A discarded snapshot
    // leaves `runtime.connections` empty and nothing ever flips it.
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(isOnline()).toBe(false);

    stop();
  });

  it("keeps the pending first snapshot when overlapping consumers change scope", async () => {
    vi.useFakeTimers();
    const pending: { release: (() => void) | null } = { release: null };
    window.ade = {
      remoteRuntime: {
        callAction: vi.fn(() => new Promise(() => {})),
        getConnectionSnapshot: vi.fn(() => new Promise((resolve) => {
          pending.release = () => resolve(snapshot("connecting"));
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;

    const first = startCrossMachineLaneSync({
      scopeKey: "local:/repo-a",
      repoDisplayName: "Repo A",
      repoOriginUrl: "git@github.com:acme/repo-a.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    // A project-tab transition: the new consumer mounts and retargets the shared
    // runtime before the old one's effect cleanup runs, so refCount never hits
    // zero and no second snapshot read is issued. The in-flight one is all there
    // is — and connections are machine-global, so the scope change does not make
    // it stale.
    const second = startCrossMachineLaneSync({
      scopeKey: "local:/repo-b",
      repoDisplayName: "Repo B",
      repoOriginUrl: "git@github.com:acme/repo-b.git",
      boundTargetId: null,
      boundProjectId: null,
    });
    first();
    await vi.advanceTimersByTimeAsync(500);
    seedMachine();
    pending.release?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(isOnline()).toBe(false);

    second();
  });

  it("restores a machine that reconnects inside the window without ever dimming it", async () => {
    vi.useFakeTimers();
    const { stop, pushState } = await startSeeded();

    pushState("connecting");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(isOnline()).toBe(true);
    pushState("connected");
    await vi.advanceTimersByTimeAsync(60_000);
    // The deadline armed by the blip must not fire against the healed machine.
    expect(isOnline()).toBe(true);

    // A second drop gets a FULL window, not the remainder of the first one.
    pushState("connecting");
    pushState("error");
    await vi.advanceTimersByTimeAsync(44_000);
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(isOnline()).toBe(false);

    stop();
  });
});
