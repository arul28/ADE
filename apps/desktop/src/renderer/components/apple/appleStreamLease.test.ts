import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireAppleStreamLease,
  appleStreamLeaseCount,
  appleStreamLeaseKey,
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
