/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, OpenProjectBinding } from "../../../shared/types";
import type { CrossMachineMachineLanes } from "../../state/appStore";
import {
  remapDraftLaneToMachine,
  useDraftMachineRouting,
  type RoutedDraftLane,
} from "./useDraftMachineRouting";

/** A complete `LaneSummary`, so the fixtures below type-check as real lanes. */
function laneFixture(lane: Pick<LaneSummary, "id" | "name"> & Partial<LaneSummary>): LaneSummary {
  return {
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef: `refs/heads/${lane.name}`,
    worktreePath: `/tmp/worktrees/${lane.id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...lane,
  };
}

const originalAde = globalThis.window.ade;

afterEach(() => {
  cleanup();
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

describe("useDraftMachineRouting", () => {
  it("clears a stale remote catalog when a later snapshot probe fails", async () => {
    const localBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/tmp/project-under-test",
      rootPath: "/tmp/project-under-test",
      displayName: "project-under-test",
      gitOriginUrl: "https://github.com/acme/project-under-test.git",
    };
    const getConnectionSnapshot = vi.fn()
      .mockResolvedValueOnce({
        connectedCount: 1,
        updatedAt: 1,
        connections: [{
          state: "connected",
          target: { id: "studio", name: "Mac Studio", hostname: "studio.local" },
          projects: [{
            projectId: "project-1",
            rootPath: "/Users/test/project-under-test",
            displayName: "project-under-test",
            gitOriginUrl: localBinding.gitOriginUrl,
          }],
        }],
      })
      .mockRejectedValueOnce(new Error("snapshot unavailable"));
    window.ade = {
      remoteRuntime: {
        getConnectionSnapshot,
        onConnectionSnapshotChanged: vi.fn().mockReturnValue(() => {}),
      },
    } as any;
    const onDraftMachineChange = vi.fn();
    const setError = vi.fn();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDraftMachineRouting({
        enabled,
        projectBinding: localBinding,
        openProjectTabRoots: [localBinding.rootPath],
        crossMachineLanesByMachineId: {},
        lanes: [],
        laneId: null,
        initialDraftMachineId: "studio",
        draftLaunchTargetIsAutoCreate: true,
        onDraftMachineChange,
        setDraftLaunchTargetId: vi.fn(),
        setError,
      }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(result.current.machineOptions.map((option) => option.id)).toEqual(["this-mac", "studio"]);
    });

    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => {
      expect(getConnectionSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.machineOptions.map((option) => option.id)).toEqual(["this-mac"]);
      expect(result.current.selectedMachineId).toBe("this-mac");
    });
    expect(onDraftMachineChange).toHaveBeenCalledWith(null);
    expect(setError).not.toHaveBeenCalled();
  });

  // ── Cross-machine lane routing ────────────────────────────────────────────
  //
  // Lane ids are per-machine: every machine has its own Primary with its own
  // id. A remote-bound tab picking another machine in the composer must
  // re-derive the selection against that machine's catalog instead of carrying
  // the bound machine's lane id across.

  const REMOTE_ORIGIN = "https://github.com/acme/project-under-test.git";

  const remoteBinding: OpenProjectBinding = {
    kind: "remote",
    key: "remote:studio:project-1",
    targetId: "studio",
    runtimeName: "Arul's Mac Studio",
    projectId: "project-1",
    rootPath: "/Volumes/work/project-under-test",
    displayName: "project-under-test",
    gitOriginUrl: REMOTE_ORIGIN,
  };

  const studioLanes: LaneSummary[] = [
    laneFixture({
      id: "studio-primary",
      name: "Primary",
      branchRef: "refs/heads/main",
      laneType: "primary",
    }),
    laneFixture({ id: "studio-feature", name: "feature-work" }),
  ];

  const thisMacLanes: LaneSummary[] = [
    laneFixture({
      id: "mac-primary",
      name: "Primary",
      branchRef: "refs/heads/main",
      laneType: "primary",
    }),
    laneFixture({ id: "mac-feature", name: "feature-work" }),
  ];

  function thisMacSlice(
    lanes: readonly LaneSummary[],
    lastSyncedAtMs: number | null = 1,
    error: string | null = null,
    // Defaults to the general clock so existing rows keep meaning "the lane
    // list was read". Pass `null` explicitly for a slice written by a
    // sessions-only or PR-only merge, where no lane read has happened.
    lanesSyncedAtMs: number | null = lastSyncedAtMs,
  ): Record<string, CrossMachineMachineLanes> {
    return {
      "this-mac": {
        machineId: "this-mac",
        machineName: "This computer",
        targetId: null,
        projectId: null,
        binding: {
          kind: "local",
          key: "local:/Users/test/project-under-test",
          rootPath: "/Users/test/project-under-test",
          displayName: "project-under-test",
          gitOriginUrl: REMOTE_ORIGIN,
        },
        online: true,
        lanes: [...lanes],
        sessions: [],
        prs: [],
        lastSyncedAtMs,
        lanesSyncedAtMs,
        error,
      },
    };
  }

  function installRemoteBoundAde() {
    window.ade = {
      remoteRuntime: {
        getConnectionSnapshot: vi.fn().mockResolvedValue({
          connectedCount: 1,
          updatedAt: 1,
          connections: [{
            state: "connected",
            target: { id: "studio", name: "Arul's Mac Studio", hostname: "studio.local" },
            projects: [{
              projectId: "project-1",
              rootPath: "/Volumes/work/project-under-test",
              displayName: "project-under-test",
              gitOriginUrl: REMOTE_ORIGIN,
            }],
          }],
        }),
        onConnectionSnapshotChanged: vi.fn().mockReturnValue(() => {}),
      },
      project: {
        listRecent: vi.fn().mockResolvedValue([{
          kind: "local",
          rootPath: "/Users/test/project-under-test",
          displayName: "project-under-test",
          gitOriginUrl: REMOTE_ORIGIN,
          exists: true,
        }]),
      },
    } as any;
  }

  /**
   * Same as `installRemoteBoundAde`, plus a second connected remote. Only the
   * per-machine hold test needs two FOREIGN machines; the shared fixture stays
   * at one so the other cases keep asserting their exact machine lists.
   */
  function installTwoForeignAde() {
    installRemoteBoundAde();
    (window.ade as any).remoteRuntime.getConnectionSnapshot = vi.fn().mockResolvedValue({
      connectedCount: 2,
      updatedAt: 1,
      connections: [
        {
          state: "connected",
          target: { id: "studio", name: "Arul's Mac Studio", hostname: "studio.local" },
          projects: [{
            projectId: "project-1",
            rootPath: "/Volumes/work/project-under-test",
            displayName: "project-under-test",
            gitOriginUrl: REMOTE_ORIGIN,
          }],
        },
        {
          state: "connected",
          target: { id: "mini", name: "Mac mini", hostname: "mini.local" },
          projects: [{
            projectId: "project-2",
            rootPath: "/Volumes/work/project-under-test",
            displayName: "project-under-test",
            gitOriginUrl: REMOTE_ORIGIN,
          }],
        },
      ],
    });
  }

  type RoutingProps = {
    crossMachineLanesByMachineId: Record<string, CrossMachineMachineLanes>;
    crossMachineLaneIntendedMachineIds?: readonly string[] | null;
    laneId: string | null;
  };

  function renderRemoteBoundRouting(
    initialProps: RoutingProps,
    handlers: { onLaneChange?: ReturnType<typeof vi.fn> } = {},
  ) {
    return renderHook(
      (props: RoutingProps) => useDraftMachineRouting({
        enabled: true,
        projectBinding: remoteBinding,
        openProjectTabRoots: [],
        crossMachineLanesByMachineId: props.crossMachineLanesByMachineId,
        crossMachineLaneIntendedMachineIds: props.crossMachineLaneIntendedMachineIds ?? null,
        lanes: [],
        availableLanes: studioLanes,
        laneId: props.laneId,
        initialDraftMachineId: null,
        draftLaunchTargetIsAutoCreate: false,
        onDraftMachineChange: vi.fn(),
        onLaneChange: handlers.onLaneChange,
        setDraftLaunchTargetId: vi.fn(),
        setError: vi.fn(),
      }),
      { initialProps },
    );
  }

  it("remaps the selected lane to the picked machine's primary and lists one Primary", async () => {
    installRemoteBoundAde();
    const onLaneChange = vi.fn();
    const { result, rerender } = renderRemoteBoundRouting(
      {
        crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
        laneId: "studio-primary",
      },
      { onLaneChange },
    );

    await waitFor(() => {
      expect(result.current.machineOptions.map((option) => option.id)).toEqual(["studio", "this-mac"]);
    });

    act(() => {
      result.current.handleMachineChange("this-mac");
    });

    await waitFor(() => expect(onLaneChange).toHaveBeenCalledWith("mac-primary"));

    rerender({
      crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
      laneId: "mac-primary",
    });

    // Exactly one Primary, and no preserved foreign row. Two Primary rows in
    // one list is the regression this asserts against.
    const laneNames = result.current.selectorLanes.map((lane) => lane.name);
    expect(laneNames).toEqual(["Auto-create lane", "Primary", "feature-work"]);
    expect(laneNames.some((name) => name.includes("unavailable"))).toBe(false);
    expect(result.current.executionLanes.map((lane) => lane.id)).toEqual(["mac-primary", "mac-feature"]);
    expect(result.current.selectorValue).toBe("mac-primary");
    expect(result.current.laneCatalogLoading).toBe(false);
  });

  it("remaps a non-primary lane to the picked machine's same-named lane", async () => {
    installRemoteBoundAde();
    const onLaneChange = vi.fn();
    const { result } = renderRemoteBoundRouting(
      {
        crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
        laneId: "studio-feature",
      },
      { onLaneChange },
    );

    await waitFor(() => {
      expect(result.current.machineOptions).toHaveLength(2);
    });

    act(() => {
      result.current.handleMachineChange("this-mac");
    });

    await waitFor(() => expect(onLaneChange).toHaveBeenCalledWith("mac-feature"));
  });

  it("holds the lane selection unresolved until the picked machine's catalog lands", async () => {
    installRemoteBoundAde();
    const onLaneChange = vi.fn();
    const { result, rerender } = renderRemoteBoundRouting(
      { crossMachineLanesByMachineId: {}, laneId: "studio-primary" },
      { onLaneChange },
    );

    await waitFor(() => {
      expect(result.current.machineOptions).toHaveLength(2);
    });

    act(() => {
      result.current.handleMachineChange("this-mac");
    });

    // No catalog yet: no foreign lane on screen, no silent remap, and the
    // launch gate reads "loading" rather than "unavailable".
    expect(result.current.laneCatalogLoading).toBe(true);
    expect(result.current.selectorLanes.map((lane) => lane.name)).toEqual(["Auto-create lane"]);
    expect(result.current.selectorValue).toBe("");
    expect(onLaneChange).not.toHaveBeenCalled();

    rerender({
      crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
      laneId: "studio-primary",
    });

    await waitFor(() => expect(onLaneChange).toHaveBeenCalledWith("mac-primary"));
    expect(result.current.laneCatalogLoading).toBe(false);
  });

  it("keeps a lane the user picks on the selected machine", async () => {
    installRemoteBoundAde();
    const onLaneChange = vi.fn();
    const { result, rerender } = renderRemoteBoundRouting(
      {
        crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
        laneId: "studio-primary",
      },
      { onLaneChange },
    );

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));

    act(() => {
      result.current.handleMachineChange("this-mac");
    });
    await waitFor(() => expect(onLaneChange).toHaveBeenCalledWith("mac-primary"));
    rerender({
      crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
      laneId: "mac-primary",
    });

    onLaneChange.mockClear();
    act(() => {
      result.current.handleLaneSelectionChange("mac-feature");
    });
    expect(onLaneChange).toHaveBeenCalledWith("mac-feature");

    rerender({
      crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
      laneId: "mac-feature",
    });
    // The machine did not change, so nothing re-resolves the user's choice.
    expect(onLaneChange).toHaveBeenCalledTimes(1);
    expect(result.current.selectorValue).toBe("mac-feature");
  });

  it("does not remap the lane while the machine stays the same", async () => {
    installRemoteBoundAde();
    const onLaneChange = vi.fn();
    const { result } = renderRemoteBoundRouting(
      {
        crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
        laneId: "lane-only-on-another-machine",
      },
      { onLaneChange },
    );

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));
    expect(onLaneChange).not.toHaveBeenCalled();
    expect(result.current.selectorValue).toBe("");
  });

  it("keeps a persisted machine choice when the draft controls are hidden", async () => {
    installRemoteBoundAde();
    const onDraftMachineChange = vi.fn();
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDraftMachineRouting({
        enabled,
        projectBinding: remoteBinding,
        openProjectTabRoots: [],
        crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
        lanes: [],
        availableLanes: studioLanes,
        laneId: "mac-primary",
        initialDraftMachineId: "this-mac",
        draftLaunchTargetIsAutoCreate: false,
        onDraftMachineChange,
        setDraftLaunchTargetId: vi.fn(),
        setError: vi.fn(),
      }),
      { initialProps: { enabled: true } },
    );

    // Wait on a POSITIVE condition — the catalog actually resolving — before
    // asserting the negative, which would otherwise pass on the first tick.
    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));
    expect(onDraftMachineChange).not.toHaveBeenCalled();
    rerender({ enabled: false });
    // A hidden composer has no machine catalog; it must not read that as "the
    // persisted machine disappeared" and clear the user's choice.
    expect(onDraftMachineChange).not.toHaveBeenCalled();
  });

  it("does not commit a machine switch that resolved no lane", async () => {
    installRemoteBoundAde();
    const onLaneChange = vi.fn();
    const { result, rerender } = renderRemoteBoundRouting(
      {
        // Read, but the catalog decoded to zero lanes: nothing to remap onto.
        crossMachineLanesByMachineId: thisMacSlice([], 1),
        laneId: "studio-primary",
      },
      { onLaneChange },
    );

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));

    act(() => {
      result.current.handleMachineChange("this-mac");
    });

    expect(onLaneChange).not.toHaveBeenCalled();

    // The real lane list lands a tick later. Committing the switch above would
    // have short-circuited the remap effect forever.
    rerender({
      crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
      laneId: "studio-primary",
    });

    await waitFor(() => expect(onLaneChange).toHaveBeenCalledWith("mac-primary"));
  });

  it("does not treat a sessions-only slice as a read lane catalog", async () => {
    installRemoteBoundAde();
    const { result } = renderRemoteBoundRouting({
      // What an optimistic foreign launch writes: sessions merged, lanes never
      // read. `lastSyncedAtMs` advances on ANY merge, so only the lane-specific
      // clock can tell this apart from a catalog that decoded to zero lanes.
      crossMachineLanesByMachineId: thisMacSlice([], Date.now(), null, null),
      laneId: "studio-primary",
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));

    act(() => {
      result.current.handleMachineChange("this-mac");
    });

    // Still reading: mistaking this for a loaded catalog suppresses the
    // pull-forward lane read and remaps the selection against nothing.
    expect(result.current.laneCatalogLoading).toBe(true);
  });

  it("stops claiming to load lanes for a machine the union will never read", async () => {
    installRemoteBoundAde();
    const { result, rerender } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      crossMachineLaneIntendedMachineIds: null,
      laneId: "studio-primary",
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));

    act(() => {
      result.current.handleMachineChange("this-mac");
    });

    // Read set unresolved: a catalog may still be coming.
    expect(result.current.laneCatalogLoading).toBe(true);

    rerender({
      crossMachineLanesByMachineId: {},
      crossMachineLaneIntendedMachineIds: ["studio"],
      laneId: "studio-primary",
    });

    // Resolved, and This computer is not in it: no read will ever arrive, so the
    // launch must show the actionable unavailable message instead of a promise.
    expect(result.current.laneCatalogLoading).toBe(false);
  });

  it("stops claiming to load lanes once the union records a read failure", async () => {
    installRemoteBoundAde();
    const { result, rerender } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      laneId: "studio-primary",
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));

    act(() => {
      result.current.handleMachineChange("this-mac");
    });
    expect(result.current.laneCatalogLoading).toBe(true);

    // The read was attempted and failed (a wedged runtime answering nothing):
    // no lanes, no sync timestamp, an error. Holding "loading" past that
    // promises a catalog that is not coming.
    rerender({
      crossMachineLanesByMachineId: thisMacSlice([], null, "lane.list timed out"),
      laneId: "studio-primary",
    });

    expect(result.current.laneCatalogLoading).toBe(false);
  });

  it("treats an empty intended read set as unresolved rather than a verdict", async () => {
    installRemoteBoundAde();
    const { result } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      // The union's pre-resolution state at project open: the membership needle
      // is seeded from an empty slice map before anything has resolved.
      crossMachineLaneIntendedMachineIds: [],
      laneId: "studio-primary",
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));

    act(() => {
      result.current.handleMachineChange("this-mac");
    });

    // Must not flap to "unavailable" and back while the real read set resolves.
    expect(result.current.laneCatalogLoading).toBe(true);
  });

  it("does not latch a hold expiry recorded while the machine was ineligible", async () => {
    installRemoteBoundAde();
    // The union has resolved a read set that EXCLUDES this-mac, so the hold is
    // not warranted and must not be armed.
    const { result, rerender } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      laneId: "studio-primary",
      crossMachineLaneIntendedMachineIds: ["target-studio"],
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));
    vi.useFakeTimers();
    try {
      act(() => {
        result.current.handleMachineChange("this-mac");
      });
      expect(result.current.laneCatalogLoading).toBe(false);

      // Long enough that a timer armed here would have fired.
      act(() => {
        vi.advanceTimersByTime(13_000);
      });

      // The union now intends to read this-mac after all. A stale expiry from
      // the window above would leave the composer permanently not-loading, so
      // the pull-forward read would never be requested.
      act(() => {
        rerender({
          crossMachineLanesByMachineId: {},
          laneId: "studio-primary",
          crossMachineLaneIntendedMachineIds: ["target-studio", "this-mac"],
        });
      });
      expect(result.current.laneCatalogLoading).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold for a machine the picker does not offer", async () => {
    installRemoteBoundAde();
    const { result } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      laneId: "studio-primary",
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));
    // A machine absent from `machineOptions` cannot be refreshed — the request
    // effect would decline it — so starting a hold for it would expire against
    // a read that never happens and leave the composer permanently silent.
    act(() => {
      result.current.handleMachineChange("ghost-machine");
    });
    expect(result.current.selectedMachineId).not.toBe("ghost-machine");
    expect(result.current.laneCatalogLoading).toBe(false);
  });

  it("gives each foreign machine its own loading hold", async () => {
    installTwoForeignAde();
    const { result } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      laneId: "studio-primary",
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(3));
    vi.useFakeTimers();
    try {
      act(() => {
        result.current.handleMachineChange("this-mac");
      });
      expect(result.current.laneCatalogLoading).toBe(true);

      // Let the FIRST machine's hold lapse.
      act(() => {
        vi.advanceTimersByTime(13_000);
      });
      expect(result.current.laneCatalogLoading).toBe(false);

      // Switching straight to another unread foreign machine must start a fresh
      // hold. Both machines are unresolved, so the hold cannot key on that
      // alone — the expiry belonged to the machine we just left.
      act(() => {
        result.current.handleMachineChange("mini");
      });
      expect(result.current.laneCatalogLoading).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the loading hold for a machine that is never read and never errors", async () => {
    installRemoteBoundAde();
    const { result } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      laneId: "studio-primary",
    });

    // Fake timers only AFTER the connection catalog has resolved: `waitFor`
    // cannot drain the snapshot promise while the clock is frozen.
    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));
    vi.useFakeTimers();
    try {
      act(() => {
        result.current.handleMachineChange("this-mac");
      });
      expect(result.current.laneCatalogLoading).toBe(true);

      act(() => {
        vi.advanceTimersByTime(11_000);
      });
      expect(result.current.laneCatalogLoading).toBe(true);

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      // Past the hold the catalog is not coming: the unavailable message is at
      // least true, where a permanent "loading" refuses every launch forever.
      expect(result.current.laneCatalogLoading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the loading hold when the catalog lands or the machine changes", async () => {
    installRemoteBoundAde();
    const { result, rerender } = renderRemoteBoundRouting({
      crossMachineLanesByMachineId: {},
      laneId: "studio-primary",
    });

    await waitFor(() => expect(result.current.machineOptions).toHaveLength(2));
    vi.useFakeTimers();
    try {
      act(() => {
        result.current.handleMachineChange("this-mac");
      });
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(result.current.laneCatalogLoading).toBe(true);

      // The catalog lands, then the slice goes away again. The hold must restart
      // from here — carrying the first arm's deadline would expire it at 12s of
      // wall clock even though this read only just began.
      rerender({
        crossMachineLanesByMachineId: thisMacSlice(thisMacLanes),
        laneId: "studio-primary",
      });
      expect(result.current.laneCatalogLoading).toBe(false);

      rerender({ crossMachineLanesByMachineId: {}, laneId: "studio-primary" });
      act(() => {
        vi.advanceTimersByTime(7_000);
      });
      expect(result.current.laneCatalogLoading).toBe(true);

      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(result.current.laneCatalogLoading).toBe(false);

      // A different machine gets its own hold: the previous machine's expiry
      // must not leak across and refuse this one before it was ever read.
      act(() => {
        result.current.handleMachineChange("studio");
      });
      act(() => {
        result.current.handleMachineChange("this-mac");
      });
      expect(result.current.laneCatalogLoading).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("remapDraftLaneToMachine", () => {
  const lane = (
    id: string,
    name: string,
    laneType: string,
  ): RoutedDraftLane => ({ id, name, color: null, branchRef: `refs/heads/${name}`, laneType });

  const target = [
    lane("target-primary", "Primary", "primary"),
    lane("target-feature", "feature-work", "worktree"),
  ];

  // One table: every branch of the fallback chain, same fixture, one assertion
  // each. The shadowed-primary case below stays its own test because it is the
  // regression, not just another row.
  it.each([
    ["no previous lane falls back to the target's primary", null, "target-primary"],
    ["a lane id the target also has is kept", lane("target-feature", "renamed-elsewhere", "worktree"), "target-feature"],
    ["a primary lane maps onto the target's own primary", lane("other-primary", "Primary", "primary"), "target-primary"],
    ["an unknown lane maps onto a same-named lane", lane("other-feature", "feature-work", "worktree"), "target-feature"],
    ["nothing matching falls back to the target's primary", lane("other-lane", "unrelated", "worktree"), "target-primary"],
  ] as const)("%s", (_label, previous, expected) => {
    expect(remapDraftLaneToMachine(previous, target)?.id).toBe(expected);
  });

  it("returns null when the target machine has no lanes at all", () => {
    expect(remapDraftLaneToMachine(lane("other-lane", "unrelated", "worktree"), [])).toBeNull();
  });

  it("prefers the real primary over a worktree lane merely NAMED Primary", () => {
    const shadowedTarget = [
      lane("named-primary", "Primary", "worktree"),
      lane("real-primary", "main", "primary"),
    ];
    expect(remapDraftLaneToMachine(null, shadowedTarget)?.id).toBe("real-primary");
    expect(
      remapDraftLaneToMachine(lane("other-primary", "Primary", "primary"), shadowedTarget)?.id,
    ).toBe("real-primary");
  });
});
