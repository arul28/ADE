/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  appleStreamLeaseCount,
  appleStreamLeaseEpoch,
  appleStreamLeaseKey,
  acquireAppleStreamLease,
  forgetAppleStreamLeasesForLane,
  releaseAppleStreamLease,
  resetAppleStreamLeases,
} from "./appleStreamLease";
import { useAppleDeviceStream } from "./useAppleDeviceStream";
import {
  handoffAppleMiniPlayer,
  noteAppleMiniPlayerLaneDevice,
  releaseAppleMiniPlayerHandoverHold,
  resetAppleMiniPlayerForTests,
  retakeAppleMiniPlayer,
} from "./appleMiniPlayerStore";
import { closeWorkToolForReal } from "../terminals/closeWorkToolForReal";

/**
 * The bug this file exists for: open the Apple tool, close it, open it again in
 * the same page session, and the pane sat on "Connecting video" for ever while
 * `getStreamStatus` reported `running: true`.
 *
 * Nothing had leaked — the count really did reach zero. What went wrong is
 * WHEN it reached zero: the floating player and the pane hand the device to
 * each other, and the one going away releases AFTER the one arriving has
 * started. The departing release was therefore the last one, and fired a
 * lane-scoped `stopStream` at the capture the arriving pane had just adopted.
 * The service kept saying `running: true` (so its own short-circuit refused to
 * start another), the helper had stopped encoding, and only a renderer reload
 * cleared it.
 */

const LANE = "lane-1";
const UDID = "UDID-1";
const KEY = appleStreamLeaseKey({ pinKey: null, laneId: LANE, deviceUdid: UDID });

let calls: string[] = [];

function installApi() {
  const api = {
    startStream: vi.fn(async () => {
      calls.push("start");
      return {
        deviceUdid: UDID, running: true, backend: "helper-h264", fps: null, targetFps: 30,
        frameCount: null, startedAt: "", lastFrameAt: null, lastError: null,
        streamUrl: "http://127.0.0.1:1/s",
        transport: { url: "http://127.0.0.1:1/s", port: 1, token: "t", codec: null, width: 10, height: 20 },
      };
    }),
    stopStream: vi.fn(async () => { calls.push("stop"); return {}; }),
    // The tab close powers the device OFF (`deviceStop` → `simctl shutdown`),
    // rather than merely releasing this chat's session.
    deviceStop: vi.fn(async () => {
      calls.push("deviceStop");
      return { udid: UDID, poweredOff: true, previousState: "Booted", released: true, stillRegistered: true };
    }),
    getStreamStatus: vi.fn(async () => ({ running: true })),
    resolveStreamUrl: vi.fn(async (url: string | null) => ({ url, forwarded: false, error: null })),
    deviceList: vi.fn(async () => ({ lane: null, installed: [] })),
  };
  (window as unknown as { ade: unknown }).ade = { iosSimulator: api };
  return api;
}

let latestUrl: string | null = null;

/** One viewer of the lane's stream — the pane's column, or the floating player. */
function Viewer() {
  const pinRef = useRef<OpenProjectBinding | null>(null);
  const stream = useAppleDeviceStream({
    deviceUdid: UDID, laneId: LANE, chatSessionId: "chat-1",
    enabled: true, hidden: false, machineName: null, bitrateKbpsCap: null,
    runtimePinRef: pinRef, onError: () => {},
  });
  latestUrl = stream.url;
  return <div data-testid="viewer" data-url={stream.url ?? ""} />;
}

/** What `WorkIosTool` does on mount, in the order React runs it. */
function mountPane() {
  act(() => { retakeAppleMiniPlayer(); });
  const view = render(<Viewer />);
  act(() => { releaseAppleMiniPlayerHandoverHold(); });
  return view;
}

beforeEach(() => {
  calls = [];
  latestUrl = null;
  resetAppleStreamLeases();
  resetAppleMiniPlayerForTests();
  installApi();
  noteAppleMiniPlayerLaneDevice(LANE, { udid: UDID, name: "ADE Repro", runtime: null, family: "iphone" });
});

afterEach(() => {
  cleanup();
  resetAppleStreamLeases();
  resetAppleMiniPlayerForTests();
});

describe("open → close → open again", () => {
  it("reaches a running stream with a URL, and never stops the capture on the way", async () => {
    const pane = mountPane();
    await waitFor(() => expect(latestUrl).toBe("http://127.0.0.1:1/s"));
    expect(appleStreamLeaseCount(KEY)).toBe(1);

    // Close the tools pane: the handover holds the stream, the player takes it.
    act(() => { handoffAppleMiniPlayer({ laneId: LANE, chatSessionId: "chat-1", runtimePin: null }); });
    expect(appleStreamLeaseCount(KEY)).toBe(2);
    pane.unmount();
    const player = render(<Viewer />);
    act(() => { releaseAppleMiniPlayerHandoverHold(); });
    await waitFor(() => expect(latestUrl).toBe("http://127.0.0.1:1/s"));

    // Open it again: the pane takes the device back off the player.
    act(() => { retakeAppleMiniPlayer(); });
    player.unmount();
    const reopened = render(<Viewer />);
    act(() => { releaseAppleMiniPlayerHandoverHold(); });

    await waitFor(() => expect(latestUrl).toBe("http://127.0.0.1:1/s"));
    expect(reopened.getByTestId("viewer").getAttribute("data-url")).toBe("http://127.0.0.1:1/s");
    // One viewer left holding it, and the capture was never stopped: a `stop`
    // anywhere in here is the bug, because the service would then refuse to
    // start another and the pane would wait for frames for ever.
    expect(appleStreamLeaseCount(KEY)).toBe(1);
    expect(calls).not.toContain("stop");
  });

  it("returns the count to zero when the last viewer really does go", async () => {
    const pane = mountPane();
    await waitFor(() => expect(calls).toContain("start"));
    pane.unmount();
    await waitFor(() => expect(calls).toContain("stop"));
    expect(appleStreamLeaseCount(KEY)).toBe(0);
    expect(appleStreamLeaseEpoch(KEY)).toBe(0);
  });

  it("returns the count to zero on the tab-close route, and leaves nothing behind for the next device", async () => {
    const pane = mountPane();
    await waitFor(() => expect(calls).toContain("start"));

    // Closing the TAB: the tool stops for real and the device powers off.
    act(() => {
      closeWorkToolForReal("ios", { laneId: LANE, chatSessionId: "chat-1", runtimePin: null });
    });
    // The device is going away, so the bookkeeping that described its stream
    // goes with it — before the pane has even unmounted.
    expect(appleStreamLeaseCount(KEY)).toBe(0);
    pane.unmount();
    expect(appleStreamLeaseCount(KEY)).toBe(0);
    await waitFor(() => expect(calls).toContain("deviceStop"));

    // A device started afterwards is seen as a first viewer, not a second one.
    expect(acquireAppleStreamLease(KEY).first).toBe(true);
  });
});

describe("a release from a stream that has already ended", () => {
  it("cannot stop the one running now", () => {
    const stale = acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: null });
    expect(stale.first).toBe(true);
    // That run ends…
    expect(releaseAppleStreamLease(KEY, stale.epoch).last).toBe(true);
    // …and a new one starts.
    const fresh = acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: null });
    expect(fresh.first).toBe(true);
    expect(fresh.epoch).not.toBe(stale.epoch);

    // The old viewer's unmount finally lands. It must not be `last`, and it
    // must not take the new run's count down with it.
    expect(releaseAppleStreamLease(KEY, stale.epoch).last).toBe(false);
    expect(appleStreamLeaseCount(KEY)).toBe(1);
    expect(releaseAppleStreamLease(KEY, fresh.epoch).last).toBe(true);
  });

  it("still lets an unstamped caller release, so nothing that predates the epoch breaks", () => {
    acquireAppleStreamLease(KEY);
    expect(releaseAppleStreamLease(KEY).last).toBe(true);
  });
});

describe("forgetting a lane's leases", () => {
  it("drops viewers and parked holds for that lane only, and stops nothing", () => {
    const other = appleStreamLeaseKey({ pinKey: null, laneId: "lane-2", deviceUdid: "UDID-2" });
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: null });
    acquireAppleStreamLease(KEY); // a parked hold: a count with no viewer
    acquireAppleStreamLease(other, { laneId: "lane-2", deviceUdid: "UDID-2", pinKey: null });

    forgetAppleStreamLeasesForLane(LANE);
    expect(appleStreamLeaseCount(KEY)).toBe(0);
    expect(appleStreamLeaseCount(other)).toBe(1);
    expect(calls).not.toContain("stop");

    forgetAppleStreamLeasesForLane(null);
    expect(appleStreamLeaseCount(other)).toBe(1);
  });
});
