import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireAppleStreamLease,
  appleStreamLeaseCount,
  appleStreamLeaseKey,
  appleStreamViewerForLane,
  releaseAppleStreamLease,
  resetAppleStreamLeases,
} from "./appleStreamLease";

beforeEach(() => resetAppleStreamLeases());

describe("appleStreamLeaseKey", () => {
  it("separates the same lane on two machines", () => {
    const here = appleStreamLeaseKey({ pinKey: null, laneId: "lane-1", deviceUdid: "UDID-1" });
    const there = appleStreamLeaseKey({ pinKey: "remote:studio", laneId: "lane-1", deviceUdid: "UDID-1" });
    expect(here).not.toBe(there);
    expect(here).toBe("bound::lane-1::UDID-1");
  });
});

describe("apple stream leases", () => {
  it("only the first acquire starts and only the last release stops", () => {
    const key = appleStreamLeaseKey({ pinKey: null, laneId: "lane-1", deviceUdid: "UDID-1" });
    expect(acquireAppleStreamLease(key).first).toBe(true);
    expect(acquireAppleStreamLease(key).first).toBe(false);
    expect(appleStreamLeaseCount(key)).toBe(2);
    expect(releaseAppleStreamLease(key).last).toBe(false);
    expect(releaseAppleStreamLease(key).last).toBe(true);
    expect(appleStreamLeaseCount(key)).toBe(0);
  });

  it("a double release cannot stop a later viewer's stream", () => {
    const key = appleStreamLeaseKey({ pinKey: null, laneId: "lane-1", deviceUdid: "UDID-1" });
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
  const key = (laneId: string | null) => appleStreamLeaseKey({ pinKey: null, laneId, deviceUdid: "UDID-1" });

  it("is null until a viewer holds a lease with a descriptor", () => {
    expect(appleStreamViewerForLane("lane-1")).toBeNull();
    acquireAppleStreamLease(key("lane-1"));
    // A lease without a descriptor is a parked count (the handover's own hold),
    // not a viewer anyone can hand a picture to.
    expect(appleStreamViewerForLane("lane-1")).toBeNull();

    resetAppleStreamLeases();
    acquireAppleStreamLease(key("lane-1"), { laneId: "lane-1", deviceUdid: "UDID-1", pinKey: null });
    expect(appleStreamViewerForLane("lane-1")).toEqual({
      laneId: "lane-1",
      deviceUdid: "UDID-1",
      pinKey: null,
      key: "bound::lane-1::UDID-1",
    });
  });

  it("answers for the lane that asked, and for no other", () => {
    acquireAppleStreamLease(key("lane-1"), { laneId: "lane-1", deviceUdid: "UDID-1", pinKey: null });
    expect(appleStreamViewerForLane("lane-2")).toBeNull();
    expect(appleStreamViewerForLane(null)).toBeNull();
    expect(appleStreamViewerForLane("  ")).toBeNull();
  });

  it("forgets the viewer when the last lease goes back", () => {
    const laneKey = key("lane-1");
    acquireAppleStreamLease(laneKey, { laneId: "lane-1", deviceUdid: "UDID-1", pinKey: null });
    acquireAppleStreamLease(laneKey);
    releaseAppleStreamLease(laneKey);
    // Still held by the first viewer.
    expect(appleStreamViewerForLane("lane-1")).not.toBeNull();
    releaseAppleStreamLease(laneKey);
    expect(appleStreamViewerForLane("lane-1")).toBeNull();
    expect(appleStreamLeaseCount(laneKey)).toBe(0);
  });
});
