import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopSeatProvider, MacDesktopEventPayload } from "../../../shared/types/macDesktop";
import { createMacDesktopStreaming } from "./macDesktopStreaming";

function makeStreaming(startStream: () => Promise<{ port: number }> = async () => ({ port: 1 })) {
  const info = vi.fn();
  const events: MacDesktopEventPayload[] = [];
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
    emit: (payload) => events.push(payload),
    ensureProvider: async () => provider,
    activeProvider: () => provider,
    requireDisplay: () => {},
    assertPermission: () => {},
    touchDisplay: () => {},
    driverUnavailable: (message) => new Error(message),
  });
  return { streaming, info, events, provider: provider as unknown as { startStream: ReturnType<typeof vi.fn>; stopStream: ReturnType<typeof vi.fn> } };
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
  it("an explicit stop during a start leaves the lane stopped", async () => {
    const driver = deferredDriverStart();
    const { streaming, events } = makeStreaming(driver.start);
    disposers.push(() => streaming.dispose());

    const starting = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    const outcome = starting.then(() => "started", () => "cancelled");
    const stopping = streaming.stopStream("lane-1", "stopped");
    driver.finish();
    await stopping;

    expect(await outcome).toBe("cancelled");
    expect(streaming.streamServer.isStreaming("lane-1")).toBe(false);
    expect(streaming.buildStreamStatus("lane-1").viewerChatSessionIds).toEqual([]);
    expect(events.some((event) => event.type === "stream-started")).toBe(false);
  });

  it("a lane teardown after the run was installed does not open a second run", async () => {
    const { streaming, provider } = makeStreaming();
    disposers.push(() => streaming.dispose());
    const install = streaming.streamServer.start.bind(streaming.streamServer);
    // The display goes away between the run being installed and the start
    // resuming: the token check used to read that as a dead run and retry.
    streaming.streamServer.start = async (args) => {
      const transport = await install(args);
      streaming.forgetLane("lane-1");
      return transport;
    };

    await expect(streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" })).rejects.toThrow(/stopped/);
    expect(provider.startStream).toHaveBeenCalledTimes(1);
    expect(streaming.streamServer.isStreaming("lane-1")).toBe(false);
  });

  it("an ask that arrives after the stop still gets a live run", async () => {
    const driver = deferredDriverStart();
    const { streaming, provider } = makeStreaming(driver.start);
    disposers.push(() => streaming.dispose());

    const first = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    const firstOutcome = first.then(() => "started", () => "cancelled");
    const stopping = streaming.stopStream("lane-1", "stopped");
    const second = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-2" });
    driver.finish();
    await stopping;

    expect(await firstOutcome).toBe("cancelled");
    const joined = await second;
    expect(joined.running).toBe(true);
    expect(joined.transport?.token).toBe(streaming.streamServer.getTransport("lane-1")?.token);
    expect(streaming.buildStreamStatus("lane-1").viewerChatSessionIds).toEqual(["chat-2"]);
    expect(provider.startStream).toHaveBeenCalledTimes(2);
  });
});
