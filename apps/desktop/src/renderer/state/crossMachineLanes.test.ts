/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../shared/types";
import { detectPushDivergence } from "../../shared/laneDivergence";
import { THIS_MACHINE_ID } from "../../shared/machineIdentity";
import { useAppStore } from "./appStore";
import {
  buildCrossMachineLaneRows,
  decodeForeignLanes,
  decodeForeignSessions,
  resolveCrossMachineLaneMarkers,
  resetCrossMachineLaneSyncForTest,
  selectOtherMachineBranchStates,
} from "./crossMachineLanes";

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

beforeEach(() => {
  useAppStore.setState({
    lanes: [],
    crossMachineLaneScopeKey: null,
    crossMachineLanesByMachineId: {},
  });
  resetCrossMachineLaneSyncForTest();
});

afterEach(() => {
  resetCrossMachineLaneSyncForTest();
});

describe("offline machines keep their lanes", () => {
  it("dims a machine that drops instead of removing its lanes", () => {
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
    expect(rows).toHaveLength(1);
    expect(rows[0].online).toBe(false);
    expect(rows[0].sessions).toHaveLength(1);
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
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      online: true,
      lanes: [makeLane()],
    });
    const before = useAppStore.getState().crossMachineLanesByMachineId;
    useAppStore.getState().setCrossMachineMachinesOnline(["target-studio"]);
    expect(useAppStore.getState().crossMachineLanesByMachineId).toBe(before);
  });

  it("drops the union when the repo scope changes", () => {
    useAppStore.getState().mergeCrossMachineLanes({
      machineId: "target-studio",
      machineName: "Mac Studio (12)",
      lanes: [makeLane()],
    });
    useAppStore.getState().applyCrossMachineLaneScope("local:/repo-a");
    expect(useAppStore.getState().crossMachineLanesByMachineId).toEqual({});
    const empty = useAppStore.getState().crossMachineLanesByMachineId;
    useAppStore.getState().applyCrossMachineLaneScope("local:/repo-a");
    expect(useAppStore.getState().crossMachineLanesByMachineId).toBe(empty);
  });
});

describe("adaptive machine marker", () => {
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
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    const markers = resolveCrossMachineLaneMarkers(rows);
    expect(markers.has("lane-local")).toBe(false);
    expect(markers.get("lane-foreign")?.machineName).toBe("Mac Studio (12)");
    expect(markers.get("lane-foreign")?.mode).toBe("glyph");
  });

  it("renders no markers at all on a single-machine setup", () => {
    const rows = buildCrossMachineLaneRows({ localLanes: [localRow()], machines: {} });
    expect(rows.every((row) => row.machineId === THIS_MACHINE_ID)).toBe(true);
    expect(resolveCrossMachineLaneMarkers(rows).size).toBe(0);
  });

  it("names the machine when it is offline", () => {
    const rows = buildCrossMachineLaneRows({
      localLanes: [],
      machines: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Mac Studio (12)",
          targetId: "target-studio",
          projectId: "project-a",
          online: false,
          lanes: [makeLane({ id: "lane-foreign", branchRef: "feature/foreign" })],
          sessions: [],
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    expect(resolveCrossMachineLaneMarkers(rows).get("lane-foreign")?.mode).toBe("name");
  });

  it("names machines when two distinct foreign machines are visible at once", () => {
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
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    const markers = resolveCrossMachineLaneMarkers(rows);
    expect(markers.get("lane-a")?.mode).toBe("name");
    expect(markers.get("lane-b")?.mode).toBe("name");
  });

  it("names the machine when the same branch exists here too", () => {
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
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    const marker = resolveCrossMachineLaneMarkers(rows).get("lane-foreign");
    expect(marker?.sameBranchElsewhere).toBe(true);
    expect(marker?.mode).toBe("name");
    // The name is always reachable, glyph mode included.
    expect(marker?.title).toBe("Mac Studio (12)");
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
        machineName: "This Mac",
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
          lastSyncedAtMs: 1,
          error: null,
        },
      },
    });
    expect(selectOtherMachineBranchStates(useAppStore.getState(), "lane-local")).toHaveLength(1);
  });
});

describe("foreign payload decoding", () => {
  it("drops entries that are not lane- or session-shaped", () => {
    expect(decodeForeignLanes([{ id: "a", name: "A", branchRef: "b" }, { id: "" }, null])).toHaveLength(1);
    expect(decodeForeignLanes({ lanes: [{ id: "a", name: "A", branchRef: "b" }] })).toHaveLength(1);
    expect(decodeForeignSessions([{ id: "s", laneId: "l" }, { id: "s2" }])).toHaveLength(1);
    expect(decodeForeignSessions("nope")).toEqual([]);
  });
});
