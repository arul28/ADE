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

  it("a stale restart that a stop overtakes ends stopped and leaves the newer run alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    disposers.push(() => vi.useRealTimers());
    const { streaming, provider } = makeStreaming();
    disposers.push(() => streaming.dispose());
    await streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    // Quiet long enough that a Reconnect restarts the run.
    vi.setSystemTime(Date.now() + 10_000);

    // Hold the stale run's driver stop open, so a stop and a newer ask land
    // while the restart waits on it.
    let finishStop: () => void = () => {};
    provider.stopStream.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    const restart = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1", fresh: true });
    const restartOutcome = restart.then(() => "started", () => "stopped");
    await Promise.resolve();
    // The stop waits for the restart in flight, so the old run is let go
    // while the stop is still waiting.
    const stopping = streaming.stopStream("lane-1", "stopped");
    // The newer ask's driver start is still in flight when the restart
    // resumes, so the restart finds it pending and could join it.
    let finishNewer: () => void = () => {};
    provider.startStream.mockImplementationOnce(() => new Promise<{ port: number }>((resolve) => {
      finishNewer = () => resolve({ port: 2 });
    }));
    const newerAsk = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-2" });
    await Promise.resolve();
    finishStop();
    await stopping;
    finishNewer();
    const newer = await newerAsk;

    expect(await restartOutcome).toBe("stopped");
    expect(newer.running).toBe(true);
    expect(streaming.streamServer.getTransport("lane-1")?.token).toBe(newer.transport?.token);
    expect(streaming.buildStreamStatus("lane-1").viewerChatSessionIds).toEqual(["chat-2"]);
  });

  it("a viewer that leaves during a stale restart leaves no ghost owner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    disposers.push(() => vi.useRealTimers());
    const { streaming, provider } = makeStreaming();
    disposers.push(() => streaming.dispose());
    await streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    vi.setSystemTime(Date.now() + 10_000);

    let finishStop: () => void = () => {};
    provider.stopStream.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    const restart = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1", fresh: true });
    await Promise.resolve();
    // The pane closes while the old run is still ending.
    const releasing = streaming.releaseViewer("lane-1", "chat-1");
    finishStop();
    await restart;
    const released = await releasing;

    expect(released.running).toBe(false);
    expect(streaming.buildStreamStatus("lane-1").viewerChatSessionIds).toEqual([]);
    expect(streaming.streamServer.isStreaming("lane-1")).toBe(false);
  });

  it("a stale restart joins a run another ask started during its wait, with no second driver start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    disposers.push(() => vi.useRealTimers());
    const { streaming, provider } = makeStreaming();
    disposers.push(() => streaming.dispose());
    await streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1" });
    vi.setSystemTime(Date.now() + 10_000);

    let finishStop: () => void = () => {};
    provider.stopStream.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    const restart = streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-1", fresh: true });
    await Promise.resolve();
    const other = await streaming.startStream({ laneId: "lane-1", chatSessionId: "chat-2" });
    finishStop();
    const restarted = await restart;

    // One start for the first run, one for chat-2's run; the restart joined it.
    expect(provider.startStream).toHaveBeenCalledTimes(2);
    expect(restarted.transport?.token).toBe(other.transport?.token);
    expect([...streaming.buildStreamStatus("lane-1").viewerChatSessionIds].sort()).toEqual(["chat-1", "chat-2"]);
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
