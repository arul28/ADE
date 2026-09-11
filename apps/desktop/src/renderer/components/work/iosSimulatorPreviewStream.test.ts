/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireIosSimulatorPreviewStream,
  resetIosSimulatorPreviewStreamForTests,
} from "./iosSimulatorPreviewStream";

/**
 * The card must never picture one simulator under another one's name. Both
 * regressions here were device-identity bugs: a lease opened for device A being
 * handed to a caller who asked for B, and a window-source match that fell back
 * to "whatever was first" when the name did not match.
 */

type Source = { id: string; name: string };

function installMocks(options: {
  streamStatus?: { running: boolean; deviceUdid: string | null };
  sources: Source[];
  onStartStream?: (args: { deviceUdid: string }) => void;
  openLeaseDelayMs?: number;
}) {
  const startStream = vi.fn(async (args: { deviceUdid: string }) => {
    options.onStartStream?.(args);
  });
  const listSimulatorWindowSources = vi.fn(async () => {
    if (options.openLeaseDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.openLeaseDelayMs));
    }
    return { sources: options.sources, message: null };
  });
  (window as unknown as { ade: unknown }).ade = {
    iosSimulator: {
      getStreamStatus: vi.fn(async () => options.streamStatus ?? { running: false, deviceUdid: null }),
      startStream,
      stopStream: vi.fn(async () => {}),
      retainWindowParking: vi.fn(async () => true),
      releaseWindowParking: vi.fn(async () => {}),
      listSimulatorWindowSources,
    },
  };
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: vi.fn() }],
  }) as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return { startStream, listSimulatorWindowSources, getUserMedia };
}

beforeEach(() => {
  resetIosSimulatorPreviewStreamForTests();
});

afterEach(() => {
  resetIosSimulatorPreviewStreamForTests();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("acquireIosSimulatorPreviewStream", () => {
  it("starts a stream when a stream is running for a DIFFERENT device", async () => {
    const { startStream } = installMocks({
      streamStatus: { running: true, deviceUdid: "device-a" },
      sources: [{ id: "src-b", name: "iPhone 17 — device-b" }],
    });
    await acquireIosSimulatorPreviewStream({ udid: "device-b", name: "iPhone 17" });
    // Skipping the start here is what left the card capturing device A's window.
    expect(startStream).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUdid: "device-b" }),
    );
  });

  it("does not restart a stream that is already running for the SAME device", async () => {
    const { startStream } = installMocks({
      streamStatus: { running: true, deviceUdid: "device-a" },
      sources: [{ id: "src-a", name: "iPhone 17 — device-a" }],
    });
    await acquireIosSimulatorPreviewStream({ udid: "device-a", name: "iPhone 17" });
    expect(startStream).not.toHaveBeenCalled();
  });

  it("returns nothing rather than the first window when a named device does not match", async () => {
    const { getUserMedia } = installMocks({
      sources: [{ id: "src-a", name: "iPad Pro" }],
    });
    const lease = await acquireIosSimulatorPreviewStream({ udid: "device-b", name: "iPhone 17" });
    expect(lease).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("does not hand a device-A open to a caller asking for device B", async () => {
    const { listSimulatorWindowSources } = installMocks({
      sources: [{ id: "src-a", name: "iPhone 17 — device-a" }],
      openLeaseDelayMs: 10,
    });
    // A's open is in flight when B asks; B must not await and attach to it.
    const a = acquireIosSimulatorPreviewStream({ udid: "device-a", name: "iPhone 17" });
    const b = acquireIosSimulatorPreviewStream({ udid: "device-b", name: "iPad Pro" });
    await Promise.all([a, b]);
    expect(listSimulatorWindowSources).toHaveBeenCalledTimes(2);
    expect(await b).toBeNull();
  });
});
