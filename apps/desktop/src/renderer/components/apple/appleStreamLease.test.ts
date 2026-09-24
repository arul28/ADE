import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireAppleStreamLease,
  appleStreamLaneLeaseCount,
  appleStreamLeaseCount,
  appleStreamLeaseKey,
  appleStreamViewerForLane,
  releaseAppleStreamLease,
  resetAppleStreamLeases,
} from "./appleStreamLease";

beforeEach(() => resetAppleStreamLeases());

const LOCAL = { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" } as const;
const STUDIO = { kind: "local", key: "local:/studio", rootPath: "/studio", displayName: "studio" } as const;

describe("appleStreamLeaseKey", () => {
  it("separates the same lane on two machines", () => {
    const here = appleStreamLeaseKey({ pin: null, bound: null, laneId: "lane-1", deviceUdid: "UDID-1" });
    const there = appleStreamLeaseKey({ pin: STUDIO, bound: null, laneId: "lane-1", deviceUdid: "UDID-1" });
    expect(here.id).not.toBe(there.id);
    expect(here.laneScope).not.toBe(there.laneScope);
    expect(here).toEqual({ id: "bound::lane-1::UDID-1", laneScope: "bound::lane-1", laneId: "lane-1" });
  });

  it("spells a null pin and the same machine resolved as one key", () => {
    expect(appleStreamLeaseKey({ pin: null, bound: LOCAL, laneId: "lane-1", deviceUdid: "UDID-1" }))
      .toEqual(appleStreamLeaseKey({ pin: LOCAL, bound: STUDIO, laneId: "lane-1", deviceUdid: "UDID-1" }));
  });
});

describe("appleStreamLaneLeaseCount", () => {
  it("counts every device on the same lane and machine, and nothing else", () => {
    const a = appleStreamLeaseKey({ pin: null, bound: null, laneId: "lane-1", deviceUdid: "A" });
    const b = appleStreamLeaseKey({ pin: null, bound: null, laneId: "lane-1", deviceUdid: "B" });
    const otherLane = appleStreamLeaseKey({ pin: null, bound: null, laneId: "lane-2", deviceUdid: "A" });
    const otherMachine = appleStreamLeaseKey({ pin: STUDIO, bound: null, laneId: "lane-1", deviceUdid: "A" });
    acquireAppleStreamLease(b);
    acquireAppleStreamLease(otherLane);
    acquireAppleStreamLease(otherMachine);
    expect(appleStreamLaneLeaseCount(a)).toBe(1);
    releaseAppleStreamLease(b);
    expect(appleStreamLaneLeaseCount(a)).toBe(0);
  });
});

describe("apple stream leases", () => {
  it("only the first acquire starts and only the last release stops", () => {
    const key = appleStreamLeaseKey({ pin: null, bound: null, laneId: "lane-1", deviceUdid: "UDID-1" });
    expect(acquireAppleStreamLease(key).first).toBe(true);
    expect(acquireAppleStreamLease(key).first).toBe(false);
    expect(appleStreamLeaseCount(key)).toBe(2);
    expect(releaseAppleStreamLease(key).last).toBe(false);
    expect(releaseAppleStreamLease(key).last).toBe(true);
    expect(appleStreamLeaseCount(key)).toBe(0);
  });

  it("a double release cannot stop a later viewer's stream", () => {
    const key = appleStreamLeaseKey({ pin: null, bound: null, laneId: "lane-1", deviceUdid: "UDID-1" });
    acquireAppleStreamLease(key);
    expect(releaseAppleStreamLease(key).last).toBe(true);
    // The stale unmount fires again, after a new viewer has taken a lease.
    acquireAppleStreamLease(key);
    expect(releaseAppleStreamLease(key).last).toBe(true);
    acquireAppleStreamLease(key);
    resetAppleStreamLeases();
    expect(releaseAppleStreamLease(key).last).toBe(false);
  });
});

/**
 * Round 4 §B4. The handover has to know, SYNCHRONOUSLY and in an unmount
 * cleanup, whether a lane has frames to hand over — a question the leases
 * already answer, and one an IPC round trip answers a visible moment late.
 */
describe("the live viewer for a lane", () => {
  const key = (laneId: string | null) => appleStreamLeaseKey({ pin: null, bound: null, laneId, deviceUdid: "UDID-1" });

  it("is null until a viewer holds a lease with a descriptor", () => {
    expect(appleStreamViewerForLane("lane-1", "bound")).toBeNull();
    acquireAppleStreamLease(key("lane-1"));
    // A lease without a descriptor is a parked count (the handover's own hold),
    // not a viewer anyone can hand a picture to.
    expect(appleStreamViewerForLane("lane-1", "bound")).toBeNull();

    resetAppleStreamLeases();
    acquireAppleStreamLease(key("lane-1"), { laneId: "lane-1", deviceUdid: "UDID-1", pinKey: "bound" });
    expect(appleStreamViewerForLane("lane-1", "bound")).toEqual({
      laneId: "lane-1",
      deviceUdid: "UDID-1",
      pinKey: "bound",
      key: { id: "bound::lane-1::UDID-1", laneScope: "bound::lane-1", laneId: "lane-1" },
    });
  });

  it("answers for the lane that asked, and for no other", () => {
    acquireAppleStreamLease(key("lane-1"), { laneId: "lane-1", deviceUdid: "UDID-1", pinKey: "bound" });
    expect(appleStreamViewerForLane("lane-2", "bound")).toBeNull();
    expect(appleStreamViewerForLane(null, "bound")).toBeNull();
    expect(appleStreamViewerForLane("  ", "bound")).toBeNull();
  });

  it("forgets the viewer when the last lease goes back", () => {
    const laneKey = key("lane-1");
    acquireAppleStreamLease(laneKey, { laneId: "lane-1", deviceUdid: "UDID-1", pinKey: "bound" });
    acquireAppleStreamLease(laneKey);
    releaseAppleStreamLease(laneKey);
    // Still held by the first viewer.
    expect(appleStreamViewerForLane("lane-1", "bound")).not.toBeNull();
    releaseAppleStreamLease(laneKey);
    expect(appleStreamViewerForLane("lane-1", "bound")).toBeNull();
    expect(appleStreamLeaseCount(laneKey)).toBe(0);
  });
});
