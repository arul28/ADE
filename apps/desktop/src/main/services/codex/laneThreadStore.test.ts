import { describe, expect, it } from "vitest";
import { createCodexLaneThreadStore } from "./laneThreadStore";

function createDbStub() {
  const kv = new Map<string, unknown>();
  return {
    getJson: <T,>(key: string): T | null => (kv.has(key) ? (kv.get(key) as T) : null),
    setJson: (key: string, value: unknown) => {
      kv.set(key, value);
    }
  } as any;
}

describe("createCodexLaneThreadStore", () => {
  it("remembers recent lane threads and keeps the default mapping", () => {
    const db = createDbStub();
    const store = createCodexLaneThreadStore({ db, maxRecentPerLane: 3 });

    store.rememberThread("lane-a", "thr-1", { setDefault: true });
    store.rememberThread("lane-a", "thr-2");
    store.rememberThread("lane-a", "thr-3");
    store.rememberThread("lane-a", "thr-2");

    const lane = store.getLaneBinding("lane-a");
    expect(lane.defaultThreadId).toBe("thr-1");
    expect(lane.recentThreadIds).toEqual(["thr-2", "thr-3", "thr-1"]);
  });

  it("updates default thread and supports reverse lookup", () => {
    const db = createDbStub();
    const store = createCodexLaneThreadStore({ db });

    store.rememberThread("lane-a", "thr-1", { setDefault: true });
    store.setDefaultThread("lane-a", "thr-9");

    const lane = store.getLaneBinding("lane-a");
    expect(lane.defaultThreadId).toBe("thr-9");
    expect(lane.recentThreadIds[0]).toBe("thr-9");
    expect(store.findLaneForThread("thr-9")).toBe("lane-a");
  });

  it("forgets stale thread ids from default and recents", () => {
    const db = createDbStub();
    const store = createCodexLaneThreadStore({ db });

    store.rememberThread("lane-a", "thr-1", { setDefault: true });
    store.rememberThread("lane-a", "thr-2");
    store.rememberThread("lane-a", "thr-3");
    store.forgetThread("lane-a", "thr-1");
    store.forgetThread("lane-a", "thr-2");

    const lane = store.getLaneBinding("lane-a");
    expect(lane.defaultThreadId).toBe(null);
    expect(lane.recentThreadIds).toEqual(["thr-3"]);
  });
});
