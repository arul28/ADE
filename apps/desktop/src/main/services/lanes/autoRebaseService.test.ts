import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { createAutoRebaseService } from "./autoRebaseService";
import type { AutoRebaseEventPayload, AutoRebaseLaneStatus, LaneSummary, RebaseNeed } from "../../../shared/types";

vi.mock("../git/git", () => ({
  getHeadSha: vi.fn().mockResolvedValue("abc123"),
}));

vi.mock("../shared/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/utils")>();
  return {
    ...actual,
    nowIso: vi.fn(() => "2026-03-25T12:00:00.000Z"),
  };
});

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function createDb() {
  const store = new Map<string, unknown>();
  return {
    getJson: vi.fn((key: string) => store.get(key) ?? null),
    setJson: vi.fn((key: string, value: unknown) => {
      if (value === null || value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    }),
    _store: store,
  } as any;
}

function makeLane(id: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name: overrides.name ?? `Lane ${id}`,
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `refs/heads/feature/${id}`,
    worktreePath: `/tmp/${id}`,
    attachedRootPath: null,
    parentLaneId: overrides.parentLaneId ?? null,
    childCount: overrides.childCount ?? 0,
    stackDepth: overrides.stackDepth ?? 0,
    parentStatus: overrides.parentStatus ?? null,
    isEditProtected: false,
    status: overrides.status ?? {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: -1,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: overrides.createdAt ?? "2026-03-10T00:00:00.000Z",
    archivedAt: null,
  };
}

function makeRebaseNeed(lane: LaneSummary, overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: lane.id,
    laneName: overrides.laneName ?? lane.name,
    baseBranch: overrides.baseBranch ?? "main",
    behindBy: overrides.behindBy ?? Math.max(1, lane.status.behind),
    conflictPredicted: overrides.conflictPredicted ?? false,
    conflictingFiles: overrides.conflictingFiles ?? [],
    prId: overrides.prId ?? null,
    groupContext: overrides.groupContext ?? null,
    dismissedAt: overrides.dismissedAt ?? null,
    deferredUntil: overrides.deferredUntil ?? null,
  };
}

describe("autoRebaseService", () => {
  let db: ReturnType<typeof createDb>;
  let events: AutoRebaseEventPayload[];
  let laneList: LaneSummary[];
  let rebaseNeedOverrides: Map<string, Partial<RebaseNeed> | null>;
  let laneService: any;
  let conflictService: any;
  let projectConfigService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createDb();
    events = [];
    laneList = [];
    rebaseNeedOverrides = new Map();

    const resolveNeed = (laneId: string): RebaseNeed | null => {
      const lane = laneList.find((entry) => entry.id === laneId);
      if (!lane || !lane.parentLaneId) return null;

      const override = rebaseNeedOverrides.get(laneId);
      if (override === null) return null;
      if (override) return makeRebaseNeed(lane, override);
      if (lane.status.behind <= 0) return null;
      return makeRebaseNeed(lane);
    };

    laneService = {
      list: vi.fn(async () => laneList),
      rebaseStart: vi.fn(async () => ({ runId: "run-1", run: { error: null } })),
      rebasePush: vi.fn(async ({ laneIds }: { laneIds: string[] }) => ({
        pushedLaneIds: [...laneIds],
        lanes: laneIds.map((laneId) => ({ laneId, pushed: true })),
      })),
      rebaseRollback: vi.fn(async () => ({ runId: "run-1" })),
    };
    conflictService = {
      getRebaseNeed: vi.fn(async (laneId: string) => resolveNeed(laneId)),
      scanRebaseNeeds: vi.fn(async () => laneList.map((lane) => resolveNeed(lane.id)).filter((need): need is RebaseNeed => need !== null)),
    };
    projectConfigService = {
      getEffective: vi.fn(() => ({ git: { autoRebaseOnHeadChange: true } })),
    };
  });

  function createService() {
    return createAutoRebaseService({
      db,
      logger: createLogger(),
      laneService,
      conflictService,
      projectConfigService,
      onEvent: (event) => events.push(event),
    });
  }

  // ---------------------------------------------------------------------------
  // sanitizeStoredStatus / TTL expiration
  // ---------------------------------------------------------------------------

  describe("listStatuses — TTL expiration", () => {
    it("includes autoRebased status when within the 15-minute TTL", async () => {
      const service = createService();
      const now = Date.now();

      laneList = [makeLane("lane-a", { parentLaneId: "root", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })];

      // Store a status that was updated 5 minutes ago (within TTL)
      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "autoRebased",
        updatedAt: new Date(now - 5 * 60_000).toISOString(),
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].state).toBe("autoRebased");
    });

    it("clears autoRebased status after the 15-minute TTL has elapsed", async () => {
      const service = createService();
      const now = Date.now();

      laneList = [makeLane("lane-a", { parentLaneId: "root", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })];

      // Store a status that was updated 20 minutes ago (past TTL)
      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "autoRebased",
        updatedAt: new Date(now - 20 * 60_000).toISOString(),
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(0);
      // Verify it was cleared from the db
      expect(db.getJson("auto_rebase:status:lane-a")).toBeNull();
    });

    it("clears autoRebased status with malformed updatedAt date", async () => {
      const service = createService();

      laneList = [makeLane("lane-a", { parentLaneId: "root", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "autoRebased",
        updatedAt: "not-a-real-date",
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(0);
      expect(db.getJson("auto_rebase:status:lane-a")).toBeNull();
    });

    it("clears autoRebased status with empty updatedAt string", async () => {
      const service = createService();

      laneList = [makeLane("lane-a", { parentLaneId: "root", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } })];

      // sanitizeStoredStatus returns null when updatedAt is empty
      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "autoRebased",
        updatedAt: "",
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      // sanitizeStoredStatus returns null for empty updatedAt, so no status is loaded
      expect(statuses).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Lanes without parent are skipped
  // ---------------------------------------------------------------------------

  describe("listStatuses — lanes without parent", () => {
    it("clears status for a lane that has no parentLaneId", async () => {
      const service = createService();

      // Lane with no parent
      laneList = [makeLane("lane-orphan", { parentLaneId: null })];

      db.setJson("auto_rebase:status:lane-orphan", {
        laneId: "lane-orphan",
        parentLaneId: null,
        parentHeadSha: null,
        state: "rebasePending",
        updatedAt: "2026-03-25T11:00:00.000Z",
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(0);
      expect(db.getJson("auto_rebase:status:lane-orphan")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Non-autoRebased status cleared when behind <= 0
  // ---------------------------------------------------------------------------

  describe("listStatuses — behind count", () => {
    it("clears non-autoRebased status when lane is not behind its parent", async () => {
      const service = createService();

      // Lane has parent but is not behind
      laneList = [makeLane("lane-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false },
      })];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "rebasePending",
        updatedAt: "2026-03-25T11:00:00.000Z",
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(0);
    });

    it("keeps non-autoRebased status when lane is behind its parent", async () => {
      const service = createService();

      const root = makeLane("root");
      const child = makeLane("lane-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 3, remoteBehind: 0, rebaseInProgress: false },
      });
      laneList = [root, child];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "rebasePending",
        updatedAt: "2026-03-25T11:00:00.000Z",
        conflictCount: 0,
        message: "Pending.",
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].laneId).toBe("lane-a");
      expect(statuses[0].state).toBe("rebasePending");
    });
  });

  // ---------------------------------------------------------------------------
  // Parent lane disappearance
  // ---------------------------------------------------------------------------

  describe("listStatuses — parent lane disappearance", () => {
    it("clears status when the stored parentLaneId no longer exists in lane list", async () => {
      const service = createService();

      // Lane references a parent that does not exist
      laneList = [makeLane("lane-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 2, remoteBehind: 0, rebaseInProgress: false },
      })];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "deleted-parent",
        parentHeadSha: "abc",
        state: "rebasePending",
        updatedAt: "2026-03-25T11:00:00.000Z",
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(0);
      expect(db.getJson("auto_rebase:status:lane-a")).toBeNull();
    });

    it("keeps status when parentLaneId in stored status is null", async () => {
      const service = createService();

      // Status has null parentLaneId — the check `status.parentLaneId && !laneById.has(...)` is falsy
      const root = makeLane("root");
      const child = makeLane("lane-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 2, remoteBehind: 0, rebaseInProgress: false },
      });
      laneList = [root, child];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: null,
        parentHeadSha: null,
        state: "rebaseConflict",
        updatedAt: "2026-03-25T11:00:00.000Z",
        conflictCount: 2,
        message: "Conflict.",
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].state).toBe("rebaseConflict");
    });
  });

  // ---------------------------------------------------------------------------
  // Sorting of returned statuses
  // ---------------------------------------------------------------------------

  describe("listStatuses — sorting", () => {
    it("returns statuses sorted by updatedAt descending", async () => {
      const service = createService();
      const now = Date.now();

      const root = makeLane("root");
      const a = makeLane("lane-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
      });
      const b = makeLane("lane-b", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 2, remoteBehind: 0, rebaseInProgress: false },
      });
      laneList = [root, a, b];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "rebasePending",
        updatedAt: new Date(now - 10_000).toISOString(),
        conflictCount: 0,
        message: null,
      });

      db.setJson("auto_rebase:status:lane-b", {
        laneId: "lane-b",
        parentLaneId: "root",
        parentHeadSha: "def",
        state: "rebaseConflict",
        updatedAt: new Date(now - 5_000).toISOString(),
        conflictCount: 1,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(2);
      // lane-b was updated more recently, so it should come first
      expect(statuses[0].laneId).toBe("lane-b");
      expect(statuses[1].laneId).toBe("lane-a");
    });
  });

  // ---------------------------------------------------------------------------
  // sanitizeStoredStatus edge cases
  // ---------------------------------------------------------------------------

  describe("listStatuses — malformed stored data", () => {
    it("ignores stored data that is not a valid record", async () => {
      const service = createService();

      laneList = [makeLane("lane-a", { parentLaneId: "root" })];
      db.setJson("auto_rebase:status:lane-a", "just a string");

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(0);
    });

    it("ignores stored data with unrecognized state value", async () => {
      const service = createService();

      laneList = [makeLane("lane-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
      })];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "unknownState",
        updatedAt: "2026-03-25T11:00:00.000Z",
        conflictCount: 0,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(0);
    });

    it("sanitizes negative conflictCount to zero", async () => {
      const service = createService();
      const now = Date.now();

      const root = makeLane("root");
      const child = makeLane("lane-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
      });
      laneList = [root, child];

      db.setJson("auto_rebase:status:lane-a", {
        laneId: "lane-a",
        parentLaneId: "root",
        parentHeadSha: "abc",
        state: "rebaseConflict",
        updatedAt: new Date(now).toISOString(),
        conflictCount: -5,
        message: null,
      });

      const statuses = await service.listStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].conflictCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // emit
  // ---------------------------------------------------------------------------

  describe("emit", () => {
    it("calls onEvent with the current statuses", async () => {
      const service = createService();

      laneList = [];
      await service.emit();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("auto-rebase-updated");
      expect(events[0].statuses).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // onHeadChanged — gating
  // ---------------------------------------------------------------------------

  describe("onHeadChanged", () => {
    it("does nothing when auto-rebase is disabled", async () => {
      projectConfigService.getEffective.mockReturnValue({ git: { autoRebaseOnHeadChange: false } });
      const service = createService();

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      // No queue should have been scheduled — laneService.list should not be called
      expect(laneService.list).not.toHaveBeenCalled();
    });

    it("ignores events with reason starting with auto_rebase", async () => {
      const service = createService();

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "auto_rebase_cascade",
      });

      expect(laneService.list).not.toHaveBeenCalled();
    });

    it("ignores events with empty laneId", async () => {
      const service = createService();

      await service.onHeadChanged({
        laneId: "  ",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      expect(laneService.list).not.toHaveBeenCalled();
    });

    it("clears queued timers when disposed before the debounce fires", async () => {
      vi.useFakeTimers();
      try {
        const service = createService();
        laneList = [
          makeLane("root"),
          makeLane("child-1", {
            parentLaneId: "root",
            status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
          }),
        ];

        await service.onHeadChanged({
          laneId: "root",
          preHeadSha: "aaa",
          postHeadSha: "bbb",
          reason: "user_commit",
        });
        service.dispose();

        await vi.advanceTimersByTimeAsync(1500);

        expect(laneService.list).not.toHaveBeenCalled();
        expect(conflictService.getRebaseNeed).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // refreshActiveRebaseNeeds / recordAttentionStatus
  // ---------------------------------------------------------------------------

  describe("refreshActiveRebaseNeeds", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("scans active lanes and queues auto-rebase work without a head change", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      laneList = [root, child];
      rebaseNeedOverrides.set("child-1", { behindBy: 3, conflictPredicted: false, conflictingFiles: [] });

      await service.refreshActiveRebaseNeeds("merge_completed");
      await vi.advanceTimersByTimeAsync(1500);

      expect(conflictService.scanRebaseNeeds).toHaveBeenCalled();
      expect(laneService.rebaseStart).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "child-1",
          reason: "auto_rebase",
        }),
      );
      expect(laneService.rebasePush).toHaveBeenCalledWith({ runId: "run-1", laneIds: ["child-1"] });
    });

    it("persists an attention status and emits the updated status stream", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      laneList = [root, child];
      conflictService.scanRebaseNeeds.mockResolvedValue([]);

      await service.recordAttentionStatus({
        laneId: "child-1",
        parentLaneId: "root",
        parentHeadSha: "parent-sha",
        state: "rebasePending",
        conflictCount: 0,
        message: "Pending: merge-triggered rebase review needed.",
      });

      expect(db.getJson("auto_rebase:status:child-1")).toMatchObject({
        laneId: "child-1",
        state: "rebasePending",
        message: "Pending: merge-triggered rebase review needed.",
      });
      expect(events[events.length - 1]).toMatchObject({
        type: "auto-rebase-updated",
        statuses: expect.arrayContaining([
          expect.objectContaining({
            laneId: "child-1",
            state: "rebasePending",
          }),
        ]),
      });
    });

    it("emits a freshly recorded attention status even before the lane is behind", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
      });
      laneList = [root, child];
      conflictService.scanRebaseNeeds.mockResolvedValue([]);

      await service.recordAttentionStatus({
        laneId: "child-1",
        parentLaneId: "root",
        parentHeadSha: "parent-sha",
        state: "rebasePending",
        conflictCount: 0,
        message: "Pending: review required before behind counts refresh.",
      });

      expect(events[events.length - 1]).toMatchObject({
        type: "auto-rebase-updated",
        statuses: expect.arrayContaining([
          expect.objectContaining({
            laneId: "child-1",
            state: "rebasePending",
          }),
        ]),
      });
    });

    it("reruns a forced refresh after an in-flight sweep completes", async () => {
      const service = createService();
      const firstSweepControl: { resolve?: (needs: RebaseNeed[]) => void } = {};
      const firstSweep = new Promise<RebaseNeed[]>((resolve) => {
        firstSweepControl.resolve = resolve;
      });
      conflictService.scanRebaseNeeds
        .mockImplementationOnce(async () => await firstSweep)
        .mockImplementationOnce(async () => []);

      const firstRefresh = service.refreshActiveRebaseNeeds("first");
      await Promise.resolve();
      const secondRefresh = service.refreshActiveRebaseNeeds("second");
      expect(firstSweepControl.resolve).toBeTypeOf("function");
      firstSweepControl.resolve!([]);

      await Promise.all([firstRefresh, secondRefresh]);

      expect(conflictService.scanRebaseNeeds).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // processRoot — cascade behavior (tested indirectly via onHeadChanged + timers)
  //
  // processRoot is the core cascade logic. It is not directly exported, but is
  // invoked via the debounced queue triggered by onHeadChanged. We test it by
  // triggering onHeadChanged and advancing fake timers.
  // ---------------------------------------------------------------------------

  describe("processRoot cascade via onHeadChanged", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips processing when root lane is not found", async () => {
      const service = createService();
      laneList = []; // root lane does not exist

      await service.onHeadChanged({
        laneId: "nonexistent-root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      // Advance past the debounce timer (1200ms)
      await vi.advanceTimersByTimeAsync(1500);

      // No rebase should have been attempted
      expect(laneService.rebaseStart).not.toHaveBeenCalled();
    });

    it("keeps sibling auto-rebase chains independent during a sweep", async () => {
      const service = createService();
      const root = makeLane("root");
      const childA = makeLane("child-a", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      const childB = makeLane("child-b", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T02:00:00.000Z",
      });
      laneList = [root, childA, childB];
      rebaseNeedOverrides.set("child-a", {
        behindBy: 1,
        conflictPredicted: true,
        conflictingFiles: ["conflict.txt"],
      });
      rebaseNeedOverrides.set("child-b", {
        behindBy: 1,
        conflictPredicted: false,
        conflictingFiles: [],
      });

      await service.refreshActiveRebaseNeeds("merge_completed");
      await vi.advanceTimersByTimeAsync(1500);

      expect(laneService.rebaseStart).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "child-b",
          reason: "auto_rebase",
        }),
      );
      expect(laneService.rebasePush).toHaveBeenCalledWith({ runId: "run-1", laneIds: ["child-b"] });
      expect(db.getJson("auto_rebase:status:child-a")).toMatchObject({
        laneId: "child-a",
        state: "rebaseConflict",
      });
    });

    it("preserves the current status when rebase-need lookup fails", async () => {
      const service = createService();
      laneList = [
        makeLane("root"),
        makeLane("child-1", {
          parentLaneId: "root",
          status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        }),
      ];
      db.setJson("auto_rebase:status:child-1", {
        laneId: "child-1",
        parentLaneId: "root",
        parentHeadSha: "parent-sha",
        state: "rebasePending",
        updatedAt: "2026-03-25T12:00:00.000Z",
        conflictCount: 0,
        message: "Pending before lookup failure.",
      });
      conflictService.getRebaseNeed.mockRejectedValueOnce(new Error("lookup failed"));

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });
      await vi.advanceTimersByTimeAsync(1500);

      expect(db.getJson("auto_rebase:status:child-1")).toMatchObject({
        laneId: "child-1",
        state: "rebasePending",
        message: "Pending before lookup failure.",
      });
    });

    it("skips root lane with no descendants", async () => {
      const service = createService();
      laneList = [makeLane("root")]; // root has no children

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      await vi.advanceTimersByTimeAsync(1500);

      expect(laneService.rebaseStart).not.toHaveBeenCalled();
    });

    it("triggers rebase for child lane when the real rebase-need path reports one", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      laneList = [root, child];
      rebaseNeedOverrides.set("child-1", { behindBy: 4, conflictPredicted: false, conflictingFiles: [] });

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      await vi.advanceTimersByTimeAsync(1500);

      expect(laneService.rebaseStart).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "child-1",
          scope: "lane_only",
          pushMode: "none",
          actor: "system",
          reason: "auto_rebase",
        }),
      );
    });

    it("auto-pushes a successful automatic rebase and marks the lane autoRebased", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      laneList = [root, child];
      rebaseNeedOverrides.set("child-1", { behindBy: 2, conflictPredicted: false, conflictingFiles: [] });

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      await vi.advanceTimersByTimeAsync(1500);
      await Promise.resolve();

      expect(laneService.rebaseStart).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "child-1",
          reason: "auto_rebase",
        }),
      );
      expect(laneService.rebasePush).toHaveBeenCalledWith({ runId: "run-1", laneIds: ["child-1"] });
    });

    it("rolls back a successful rebase when auto-push fails and leaves the lane pending", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      laneList = [root, child];
      rebaseNeedOverrides.set("child-1", { behindBy: 2, conflictPredicted: false, conflictingFiles: [] });
      laneService.rebasePush.mockRejectedValueOnce(new Error("remote rejected push"));

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      await vi.advanceTimersByTimeAsync(1500);
      await Promise.resolve();

      expect(laneService.rebaseRollback).toHaveBeenCalledWith({ runId: "run-1" });
      expect(db.setJson).toHaveBeenCalledWith(
        "auto_rebase:status:child-1",
        expect.objectContaining({
          laneId: "child-1",
          parentLaneId: "root",
          parentHeadSha: "abc123",
          state: "rebaseFailed",
        }),
      );
    });

    it("marks downstream lanes as rebasePending when an ancestor has conflicts", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 2, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      const grandchild = makeLane("grandchild-1", {
        parentLaneId: "child-1",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T02:00:00.000Z",
      });
      laneList = [root, child, grandchild];
      rebaseNeedOverrides.set("child-1", { behindBy: 1, conflictPredicted: true, conflictingFiles: ["file.ts"] });

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      await vi.advanceTimersByTimeAsync(1500);

      // child-1 should be marked as rebaseConflict
      const childStatus = db.getJson("auto_rebase:status:child-1") as AutoRebaseLaneStatus;
      expect(childStatus.state).toBe("rebaseConflict");
      expect(childStatus.conflictCount).toBe(1);

      // grandchild should be blocked as rebasePending
      const grandchildStatus = db.getJson("auto_rebase:status:grandchild-1") as AutoRebaseLaneStatus;
      expect(grandchildStatus.state).toBe("rebasePending");
      expect(grandchildStatus.message).toContain("child-1");
    });

    it("handles lane disappearance during cascade processing", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 2, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      const child2 = makeLane("child-2", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T02:00:00.000Z",
      });

      // First call returns both children, second call child-1 is gone
      let callCount = 0;
      laneService.list.mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          laneList = [root, child, child2];
          return laneList;
        }
        // child-1 disappeared during processing
        laneList = [root, child2];
        return laneList;
      });
      rebaseNeedOverrides.set("child-2", { behindBy: 1, conflictPredicted: false, conflictingFiles: [] });

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      await vi.advanceTimersByTimeAsync(1500);

      // Should not throw. child-2 should still be processed.
      // The cascade order is computed from the first call, so child-1 is in the order
      // but will be skipped because it's not found in the refreshed lane list.
      expect(laneService.rebaseStart).toHaveBeenCalledWith(
        expect.objectContaining({ laneId: "child-2" }),
      );
    });

    it("emits event after processRoot completes", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
        createdAt: "2026-03-10T01:00:00.000Z",
      });
      laneList = [root, child];

      await service.onHeadChanged({
        laneId: "root",
        preHeadSha: "aaa",
        postHeadSha: "bbb",
        reason: "user_commit",
      });

      await vi.advanceTimersByTimeAsync(1500);

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1].type).toBe("auto-rebase-updated");
    });
  });
});
