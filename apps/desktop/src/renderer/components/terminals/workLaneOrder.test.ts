import { describe, expect, it } from "vitest";
import {
  applyWorkLaneManualMove,
  normalizeWorkLaneSortMode,
  orderWorkLanes,
  workLaneTier,
  type WorkLaneOrderInput,
} from "./workLaneOrder";

function lane(overrides: Partial<WorkLaneOrderInput> & { id: string }): WorkLaneOrderInput {
  return {
    name: overrides.id,
    laneType: "worktree",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityMs: null,
    quiet: false,
    pinned: false,
    ...overrides,
  };
}

const ids = (lanes: readonly WorkLaneOrderInput[]) => lanes.map((l) => l.id);

describe("workLaneTier", () => {
  it("lets a pin outrank quietness", () => {
    expect(workLaneTier({ pinned: true, quiet: true })).toBe("pinned");
    expect(workLaneTier({ pinned: false, quiet: true })).toBe("quiet");
    expect(workLaneTier({ pinned: false, quiet: false })).toBe("active");
  });
});

describe("orderWorkLanes tiers", () => {
  it("sorts pinned above active above quiet", () => {
    const lanes = [
      lane({ id: "quiet", quiet: true }),
      lane({ id: "active" }),
      lane({ id: "pinned", pinned: true }),
    ];
    expect(ids(orderWorkLanes(lanes, "created", []))).toEqual(["pinned", "active", "quiet"]);
  });

  it("keeps a pinned lane above an active one even when it is fully quiet", () => {
    // The whole point of "pins outrank quiet": settling every session in a
    // pinned lane must not sink it.
    const lanes = [
      lane({ id: "active" }),
      lane({ id: "pinned-and-settled", pinned: true, quiet: true }),
    ];
    expect(ids(orderWorkLanes(lanes, "created", []))).toEqual(["pinned-and-settled", "active"]);
  });

  it("puts the primary lane first in every mode, ahead of pins and manual order", () => {
    const lanes = [
      lane({ id: "pinned", pinned: true }),
      lane({ id: "primary", laneType: "primary", quiet: true }),
      lane({ id: "active" }),
    ];
    for (const mode of ["created", "name", "activity", "manual"] as const) {
      expect(ids(orderWorkLanes(lanes, mode, ["active", "pinned", "primary"]))[0])
        .toBe("primary");
    }
  });
});

describe("orderWorkLanes modes", () => {
  const lanes = [
    lane({ id: "b", name: "beta", createdAt: "2026-01-02T00:00:00.000Z", lastActivityMs: 300 }),
    lane({ id: "a", name: "alpha", createdAt: "2026-01-03T00:00:00.000Z", lastActivityMs: 100 }),
    lane({ id: "c", name: "gamma", createdAt: "2026-01-01T00:00:00.000Z", lastActivityMs: 200 }),
  ];

  it("created sorts newest first", () => {
    expect(ids(orderWorkLanes(lanes, "created", []))).toEqual(["a", "b", "c"]);
  });

  it("name sorts alphabetically", () => {
    expect(ids(orderWorkLanes(lanes, "name", []))).toEqual(["a", "b", "c"]);
  });

  it("activity sorts most recent first", () => {
    expect(ids(orderWorkLanes(lanes, "activity", []))).toEqual(["b", "c", "a"]);
  });

  it("activity sorts lanes with no activity last, not first", () => {
    const withIdle = [...lanes, lane({ id: "idle", lastActivityMs: null })];
    expect(ids(orderWorkLanes(withIdle, "activity", [])).at(-1)).toBe("idle");
  });

  it("manual follows the recorded order and appends unlisted lanes", () => {
    expect(ids(orderWorkLanes(lanes, "manual", ["c", "a"]))).toEqual(["c", "a", "b"]);
  });

  it("ignores a recorded id whose lane no longer exists", () => {
    // A deleted lane must not leave a hole or shift everything after it.
    expect(ids(orderWorkLanes(lanes, "manual", ["deleted", "c", "a"]))).toEqual(["c", "a", "b"]);
  });

  it("is idempotent, so the list cannot jitter between renders", () => {
    for (const mode of ["created", "name", "activity", "manual"] as const) {
      const once = orderWorkLanes(lanes, mode, ["c"]);
      const twice = orderWorkLanes(once, mode, ["c"]);
      expect(ids(twice)).toEqual(ids(once));
    }
  });

  it("orders lanes with identical sort keys deterministically", () => {
    const tied = [
      lane({ id: "z", name: "same", createdAt: "bogus" }),
      lane({ id: "y", name: "same", createdAt: "bogus" }),
    ];
    expect(ids(orderWorkLanes(tied, "name", []))).toEqual(["y", "z"]);
    expect(ids(orderWorkLanes([...tied].reverse(), "name", []))).toEqual(["y", "z"]);
  });
});

describe("applyWorkLaneManualMove", () => {
  const order = ["a", "b", "c", "d"];

  it("moves before and after a target", () => {
    expect(applyWorkLaneManualMove({
      currentOrder: order, movedLaneId: "d", targetLaneId: "b", edge: "before",
    })).toEqual(["a", "d", "b", "c"]);
    expect(applyWorkLaneManualMove({
      currentOrder: order, movedLaneId: "a", targetLaneId: "c", edge: "after",
    })).toEqual(["b", "c", "a", "d"]);
  });

  it("returns null for a no-op so the caller skips the write", () => {
    expect(applyWorkLaneManualMove({
      currentOrder: order, movedLaneId: "b", targetLaneId: "b", edge: "before",
    })).toBeNull();
    // "b" is already immediately before "c".
    expect(applyWorkLaneManualMove({
      currentOrder: order, movedLaneId: "b", targetLaneId: "c", edge: "before",
    })).toBeNull();
  });

  it("returns null when either id is unknown", () => {
    expect(applyWorkLaneManualMove({
      currentOrder: order, movedLaneId: "ghost", targetLaneId: "b", edge: "before",
    })).toBeNull();
    expect(applyWorkLaneManualMove({
      currentOrder: order, movedLaneId: "b", targetLaneId: "ghost", edge: "after",
    })).toBeNull();
  });
});

describe("normalizeWorkLaneSortMode", () => {
  it("accepts known modes and falls back to created", () => {
    expect(normalizeWorkLaneSortMode("manual")).toBe("manual");
    expect(normalizeWorkLaneSortMode("activity")).toBe("activity");
    expect(normalizeWorkLaneSortMode("nonsense")).toBe("created");
    expect(normalizeWorkLaneSortMode(undefined)).toBe("created");
  });
});
