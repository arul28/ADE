import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopSeatProvider } from "../../../shared/types/macDesktop";
import { createMacDesktopStreaming } from "./macDesktopStreaming";

function makeStreaming(startStream: () => Promise<{ port: number }> = async () => ({ port: 1 })) {
  const info = vi.fn();
  const logger = { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() };
  const provider = {
    startStream: vi.fn(startStream),
    setStreamRate: vi.fn(async () => {}),
    stopStream: vi.fn(async () => {}),
  } as unknown as DesktopSeatProvider;
  const streaming = createMacDesktopStreaming({
    logger: logger as never,
    now: () => Date.now(),
    isDarwin: true,
    emit: () => {},
    ensureProvider: async () => provider,
    activeProvider: () => provider,
    requireDisplay: () => {},
    assertPermission: () => {},
    touchDisplay: () => {},
    driverUnavailable: (message) => new Error(message),
  });
  return { streaming, info };
}

describe("macDesktopStreaming stop logging", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  it("says why a stream stopped and who was still on it", async () => {
    // The owner's 2026-09-24 log had `stream_stopped` with no reason, so a
    // stop by the last viewer leaving and a stop by the last reader dropping
    // could not be told apart.
    const { streaming, info } = makeStreaming();
    disposers.push(() => streaming.dispose());
    await streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });

    await streaming.releaseViewer("lane-1", "chat-1");
    expect(info).toHaveBeenCalledWith("mac_desktop.stream_stop_reason", expect.objectContaining({
      laneId: "lane-1",
      reason: "viewer-left",
      clients: 0,
      viewers: 0,
      sentBytes: false,
    }));

    info.mockClear();
    await streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    await streaming.stopStream("lane-1", "no-clients");
    expect(info).toHaveBeenCalledWith("mac_desktop.stream_stop_reason", expect.objectContaining({
      reason: "no-clients",
      viewers: 1,
    }));

    // A lane with nothing running logs nothing.
    info.mockClear();
    await streaming.stopStream("lane-1", "stopped");
    expect(info).not.toHaveBeenCalledWith("mac_desktop.stream_stop_reason", expect.anything());
  });
});

describe("macDesktopStreaming release during a start", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  /** A driver start the test lets finish when it chooses. */
  function deferredDriverStart() {
    let finish: () => void = () => {};
    const started = new Promise<{ port: number }>((resolve) => {
      finish = () => resolve({ port: 1 });
    });
    return { start: () => started, finish: () => finish() };
  }

  it("a viewer that leaves while its start is in flight leaves no stream and no ghost owner", async () => {
    const driver = deferredDriverStart();
    const { streaming } = makeStreaming(driver.start);
    disposers.push(() => streaming.dispose());

    const starting = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    const releasing = streaming.releaseViewer("lane-1", "chat-1");
    driver.finish();
    await starting;
    const released = await releasing;

    expect(released.running).toBe(false);
    expect(streaming.streamServer.isStreaming("lane-1")).toBe(false);
    expect(streaming.buildStreamStatus("lane-1").viewerChatSessionIds).toEqual([]);
  });

  it("a chat that ends while its start is in flight takes the stream down", async () => {
    const driver = deferredDriverStart();
    const { streaming } = makeStreaming(driver.start);
    disposers.push(() => streaming.dispose());

    const starting = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    const ending = streaming.stopOwnedBy("chat-1");
    driver.finish();
    await starting;
    await ending;

    expect(streaming.streamServer.isStreaming("lane-1")).toBe(false);
    expect(streaming.buildStreamStatus("lane-1").viewerChatSessionIds).toEqual([]);
  });

  it("a subscription that closes while its start is in flight takes the stream down", async () => {
    const driver = deferredDriverStart();
    const { streaming } = makeStreaming(driver.start);
    disposers.push(() => streaming.dispose());

    const starting = streaming.startStreamForSubscription({ laneId: "lane-1", subscriptionId: "sub-1" });
    const ending = streaming.releaseStreamSubscription("sub-1");
    driver.finish();
    await starting;
    await ending;

    expect(streaming.streamServer.isStreaming("lane-1")).toBe(false);
  });

  it("a second asker joining a start that a release then ends gets a live run, not the dead one", async () => {
    const driver = deferredDriverStart();
    const { streaming } = makeStreaming(driver.start);
    disposers.push(() => streaming.dispose());

    const first = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    const releasing = streaming.releaseViewer("lane-1", "chat-1");
    const second = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-2" });
    driver.finish();
    await first;
    await releasing;
    const joined = await second;

    expect(joined.running).toBe(true);
    expect(joined.transport?.token).toBe(streaming.streamServer.getTransport("lane-1")?.token);
    expect(streaming.buildStreamStatus("lane-1").viewerChatSessionIds).toEqual(["chat-2"]);
  });
});
