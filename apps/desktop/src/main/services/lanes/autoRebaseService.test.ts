import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { createAutoRebaseService } from "./autoRebaseService";
import type { AutoRebaseEventPayload, AutoRebaseLaneStatus, LaneSummary } from "../../../shared/types";

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

describe("autoRebaseService", () => {
  let db: ReturnType<typeof createDb>;
  let events: AutoRebaseEventPayload[];
  let laneList: LaneSummary[];
  let laneService: any;
  let conflictService: any;
  let projectConfigService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createDb();
    events = [];
    laneList = [];
    laneService = {
      list: vi.fn(async () => laneList),
      rebaseStart: vi.fn(async () => ({ run: { error: null } })),
    };
    conflictService = {
      simulateMerge: vi.fn(async () => ({ outcome: "clean", conflictingFiles: [] })),
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

    it("triggers rebase for child lane that is behind", async () => {
      const service = createService();
      const root = makeLane("root");
      const child = makeLane("child-1", {
        parentLaneId: "root",
        status: { dirty: false, ahead: 1, behind: 3, remoteBehind: 0, rebaseInProgress: false },
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

      // Simulate merge conflict on child-1
      conflictService.simulateMerge.mockResolvedValue({
        outcome: "conflict",
        conflictingFiles: ["file.ts"],
      });

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
        if (callCount <= 1) return [root, child, child2];
        // child-1 disappeared during processing
        return [root, child2];
      });

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
