import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopSeatProvider } from "../../../shared/types/macDesktop";
import { createMacDesktopStreaming } from "./macDesktopStreaming";

function makeStreaming() {
  const info = vi.fn();
  const logger = { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() };
  const provider = {
    startStream: vi.fn(async () => ({ port: 1 })),
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
