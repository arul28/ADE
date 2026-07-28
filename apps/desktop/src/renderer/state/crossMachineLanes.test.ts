/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, TerminalSessionSummary } from "../../shared/types";
import { detectPushDivergence } from "../../shared/laneDivergence";
import { THIS_MACHINE_ID } from "../../shared/machineIdentity";
import { useAppStore } from "./appStore";
import {
  buildCrossMachineLaneRows,
  decodeForeignLanes,
  decodeForeignSessions,
  resolveCrossMachineLaneMarkers,
  resolveThisMachineBindingForOrigin,
  resetCrossMachineLaneSyncForTest,
  selectOtherMachineBranchStates,
  startCrossMachineLaneSync,
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

beforeEach(() => {
  useAppStore.setState({
    lanes: [],
    projectBinding: null,
    crossMachineLaneScopeKey: null,
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
    const empty = useAppStore.getState().crossMachineLanesByMachineId;
    useAppStore.getState().applyCrossMachineLaneScope("local:/repo-a");
    expect(useAppStore.getState().crossMachineLanesByMachineId).toBe(empty);
  });
});

describe("This Mac counterpart resolution", () => {
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
          online: true,
          lanes: [activeLane],
          sessions: [makeSession({ id: "session-duplicate", laneId: activeLane.id })],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
        [THIS_MACHINE_ID]: {
          machineId: THIS_MACHINE_ID,
          machineName: "This Mac",
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
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    });
    expect(resolveCrossMachineLaneMarkers(rows).get("target-studio:lane-foreign")?.mode).toBe("name");
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
    expect(markers.get("a:lane-a")?.mode).toBe("name");
    expect(markers.get("b:lane-b")?.mode).toBe("name");
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
    const marker = resolveCrossMachineLaneMarkers(rows).get("a:lane-foreign");
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
          lastSyncedAtMs: Date.now(),
          error: null,
        },
        [THIS_MACHINE_ID]: {
          machineId: THIS_MACHINE_ID,
          machineName: "This Mac",
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
});

describe("cross-machine refresh scheduling", () => {
  it("reads This Mac explicitly while the active tab is bound remotely", async () => {
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
    expect(callAction).toHaveBeenCalledTimes(2);

    // The old setInterval path started another generation after five seconds,
    // invalidating this still-live eight-second read. A settled-chain poll must
    // leave it alone no matter how much wall time passes while it is in flight.
    await vi.advanceTimersByTimeAsync(5_500);
    expect(callAction).toHaveBeenCalledTimes(2);

    pending.splice(0).forEach((resolve, index) => resolve({
      result: index === 0 ? { lanes: [] } : { sessions: [] },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(callAction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(401);
    expect(callAction).toHaveBeenCalledTimes(4);

    stop();
  });
});
