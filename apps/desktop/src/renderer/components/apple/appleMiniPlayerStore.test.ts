/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLE_MINI_PLAYER_POSTER_TTL_MS,
  APPLE_STREAM_HANDOVER_HOLD_MS,
  closeAppleMiniPlayer,
  getAppleMiniPlayerLaneDevice,
  getAppleMiniPlayerTarget,
  handoffAppleMiniPlayer,
  handoffAppleMiniPlayerAsync,
  isAppleMiniPlayerDismissed,
  noteAppleMiniPlayerLaneDevice,
  noteAppleMiniPlayerPoster,
  openAppleMiniPlayer,
  releaseAppleMiniPlayerHandoverHold,
  resetAppleMiniPlayerForTests,
  retakeAppleMiniPlayer,
  suppressAppleMiniPlayerHandoff,
  takeAppleMiniPlayerPoster,
} from "./appleMiniPlayerStore";
import {
  acquireAppleStreamLease,
  appleStreamLeaseCount,
  appleStreamLeaseKey,
  releaseAppleStreamLease,
  resetAppleStreamLeases,
} from "./appleStreamLease";
import {
  isWorkLivePreviewEnabled,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";

const LANE = "lane-1";
const UDID = "device-1";
const KEY = appleStreamLeaseKey({ pinKey: null, laneId: LANE, deviceUdid: UDID });

const LANE_DEVICE = {
  laneId: LANE,
  udid: UDID,
  name: "ADE Repro",
  origin: "attached",
  family: "iphone",
  runtime: "iOS 26.3",
  createdAt: new Date(0).toISOString(),
  templateUdid: null,
};

function installDeviceList(state: "Booted" | "Shutdown" | null) {
  const deviceList = vi.fn(async () => (state === null ? { installed: [], lane: null } : {
    installed: [{
      udid: UDID,
      name: "ADE Repro",
      runtime: "iOS 26.3",
      state,
      isAvailable: true,
      family: "iphone",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
    }],
    lane: LANE_DEVICE,
  }));
  const stopStream = vi.fn(async () => undefined);
  (window as unknown as { ade: unknown }).ade = { iosSimulator: { deviceList, stopStream } };
  return { deviceList, stopStream };
}

/** The pane, open on a live device: a stream lease plus the cached name. */
function paneIsStreaming() {
  acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: null });
  noteAppleMiniPlayerLaneDevice(LANE, { udid: UDID, name: "ADE Repro", runtime: "iOS 26.3", family: "iphone" });
}

const handoff = () => handoffAppleMiniPlayer({ laneId: LANE, chatSessionId: "chat-1", runtimePin: null });
const handoffAsync = () => handoffAppleMiniPlayerAsync({ laneId: LANE, chatSessionId: "chat-1", runtimePin: null });

beforeEach(() => {
  resetAppleStreamLeases();
});

afterEach(() => {
  resetAppleMiniPlayerForTests();
  resetAppleStreamLeases();
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("handoffAppleMiniPlayer", () => {
  it("floats a live device SYNCHRONOUSLY, with no runtime round trip at all (§B4)", () => {
    const { deviceList } = installDeviceList("Booted");
    paneIsStreaming();
    expect(handoff()).toBe(true);
    expect(getAppleMiniPlayerTarget()).toMatchObject({
      deviceUdid: UDID,
      deviceName: "ADE Repro",
      laneId: LANE,
      family: "iphone",
    });
    // The whole point: the old handoff asked the runtime first, and the player
    // opened one IPC later — on a remote Mac, the latency of the link.
    expect(deviceList).not.toHaveBeenCalled();
  });

  it("keeps the stream alive across the handover, so the capture is never stopped", () => {
    const { stopStream } = installDeviceList("Booted");
    paneIsStreaming();
    expect(appleStreamLeaseCount(KEY)).toBe(1);

    handoff();
    // The handover holds one of its own BEFORE the pane gives its lease back.
    expect(appleStreamLeaseCount(KEY)).toBe(2);

    // The pane's stream hook unmounts (a passive cleanup, after ours).
    expect(releaseAppleStreamLease(KEY).last).toBe(false);
    expect(stopStream).not.toHaveBeenCalled();

    // The player mounts, takes its own, and hands the hold back.
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: null });
    releaseAppleMiniPlayerHandoverHold();
    expect(appleStreamLeaseCount(KEY)).toBe(1);
    expect(stopStream).not.toHaveBeenCalled();
  });

  it("stops the stream itself when the player it was holding for never arrives", async () => {
    vi.useFakeTimers();
    const { stopStream } = installDeviceList("Booted");
    paneIsStreaming();
    handoff();
    releaseAppleStreamLease(KEY);
    expect(stopStream).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(APPLE_STREAM_HANDOVER_HOLD_MS + 1);
    expect(appleStreamLeaseCount(KEY)).toBe(0);
    expect(stopStream).toHaveBeenCalledWith(null, { laneId: LANE, chatSessionId: "chat-1" });
  });

  it("stays quiet for a lane with no live stream", () => {
    installDeviceList("Booted");
    noteAppleMiniPlayerLaneDevice(LANE, { udid: UDID, name: "ADE Repro", runtime: null, family: "iphone" });
    expect(handoff()).toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("floats with a fallback name when the pane never cached one", () => {
    installDeviceList("Booted");
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: null });
    expect(handoff()).toBe(true);
    // The name is only ever read aloud: a missing cache is a worse label, not a
    // worse picture, and the picture is what the handover is for.
    expect(getAppleMiniPlayerTarget()).toMatchObject({ deviceUdid: UDID, deviceName: "Simulator" });
  });

  it("never floats a device the user closed the player for", () => {
    installDeviceList("Booted");
    paneIsStreaming();
    handoff();
    closeAppleMiniPlayer(UDID);
    expect(isAppleMiniPlayerDismissed(UDID)).toBe(true);

    expect(handoff()).toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();

    // Asking for it from the rail is the user changing their mind.
    openAppleMiniPlayer({
      laneId: LANE,
      chatSessionId: "chat-1",
      deviceUdid: UDID,
      deviceName: "ADE Repro",
      deviceRuntime: "iOS 26.3",
      family: "iphone",
      runtimePin: null,
    });
    expect(isAppleMiniPlayerDismissed(UDID)).toBe(false);
  });

  it("taking the device back into the pane is not a dismissal", () => {
    installDeviceList("Booted");
    paneIsStreaming();
    handoff();
    retakeAppleMiniPlayer(UDID);

    expect(getAppleMiniPlayerTarget()).toBeNull();
    expect(isAppleMiniPlayerDismissed(UDID)).toBe(false);
    expect(handoff()).toBe(true);
  });

  /**
   * A4 forbids a parallel store: × on the player and the "Show preview when
   * minimized" toggle in the tool's header are the SAME per-chat marker, so a
   * close here must be visible to the toggle and vice versa.
   */
  it("× writes the chat's shared preview marker, and the toggle clears it", () => {
    installDeviceList("Booted");
    paneIsStreaming();
    handoff();
    closeAppleMiniPlayer(UDID);
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "ios")).toBe(false);
    expect(handoff()).toBe(false);

    // The header toggle, turned back on: the next minimize floats again.
    setWorkLivePreviewEnabledForChat("chat-1", "ios", true);
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "ios")).toBe(true);
    expect(handoff()).toBe(true);
  });

  it("the toggle turned off keeps the pane from floating at all, and takes no hold", () => {
    installDeviceList("Booted");
    paneIsStreaming();
    setWorkLivePreviewEnabledForChat("chat-1", "ios", false);
    expect(handoff()).toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();
    expect(appleStreamLeaseCount(KEY)).toBe(1);
  });

  /**
   * Closing the TAB and closing the PANE unmount the same panel. Only the
   * second is a minimize; the first is a shutdown, and floating a device on its
   * way down leaves a player showing a frozen last frame.
   */
  it("a tab close suppresses exactly one handoff, and drops any hold it was keeping", () => {
    installDeviceList("Booted");
    paneIsStreaming();
    handoff();
    expect(appleStreamLeaseCount(KEY)).toBe(2);
    retakeAppleMiniPlayer();

    suppressAppleMiniPlayerHandoff();
    // The hold goes back at once: the close stops the stream itself, and a
    // later expiry would be a second stop aimed at a device already off.
    expect(appleStreamLeaseCount(KEY)).toBe(1);
    expect(handoff()).toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();

    // …and no more than one: the next real minimize still floats.
    expect(handoff()).toBe(true);
  });

  it("does not replace a player that is already floating", () => {
    installDeviceList("Booted");
    paneIsStreaming();
    expect(handoff()).toBe(true);
    expect(handoff()).toBe(false);
    expect(appleStreamLeaseCount(KEY)).toBe(2);
  });
});

describe("the cold path", () => {
  it("asks the runtime when the lane has no live stream, and caches what it learns", async () => {
    const { deviceList } = installDeviceList("Booted");
    await handoffAsync();
    expect(deviceList).toHaveBeenCalledWith({ laneId: LANE, installed: true }, null);
    expect(getAppleMiniPlayerTarget()).toMatchObject({ deviceUdid: UDID, deviceName: "ADE Repro" });
    expect(getAppleMiniPlayerLaneDevice(LANE)).toEqual({
      udid: UDID, name: "ADE Repro", runtime: "iOS 26.3", family: "iphone",
    });
  });

  it("stays quiet for a device that is not running, and for a lane that owns none", async () => {
    installDeviceList("Shutdown");
    await handoffAsync();
    expect(getAppleMiniPlayerTarget()).toBeNull();
    installDeviceList(null);
    await handoffAsync();
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("never asks at all once the fast path has floated the device", async () => {
    const { deviceList } = installDeviceList("Booted");
    paneIsStreaming();
    await handoffAsync();
    expect(deviceList).not.toHaveBeenCalled();
    expect(getAppleMiniPlayerTarget()).not.toBeNull();
  });

  it("honours a tab close without then asking the runtime behind its back", async () => {
    const { deviceList } = installDeviceList("Booted");
    suppressAppleMiniPlayerHandoff();
    await handoffAsync();
    expect(deviceList).not.toHaveBeenCalled();
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });
});

describe("the handover poster", () => {
  it("is claimed exactly once", () => {
    noteAppleMiniPlayerPoster(UDID, "data:image/jpeg;base64,AAA");
    expect(takeAppleMiniPlayerPoster(UDID)).toBe("data:image/jpeg;base64,AAA");
    // A second player opening later must not paint a photograph of an old
    // session over a device that has moved on.
    expect(takeAppleMiniPlayerPoster(UDID)).toBeNull();
  });

  it("goes stale rather than painting a picture of a screen that has moved on", () => {
    // The panel photographs on EVERY unmount, including a tab close that floats
    // nothing — so a poster can outlive the handover it was taken for.
    noteAppleMiniPlayerPoster(UDID, "data:image/jpeg;base64,AAA", 1_000);
    expect(takeAppleMiniPlayerPoster(UDID, 1_000 + APPLE_MINI_PLAYER_POSTER_TTL_MS)).toBe("data:image/jpeg;base64,AAA");
    noteAppleMiniPlayerPoster(UDID, "data:image/jpeg;base64,AAA", 1_000);
    expect(takeAppleMiniPlayerPoster(UDID, 1_000 + APPLE_MINI_PLAYER_POSTER_TTL_MS + 1)).toBeNull();
  });

  it("is per device, and clearable", () => {
    noteAppleMiniPlayerPoster(UDID, "data:image/jpeg;base64,AAA");
    expect(takeAppleMiniPlayerPoster("other")).toBeNull();
    noteAppleMiniPlayerPoster(UDID, null);
    expect(takeAppleMiniPlayerPoster(UDID)).toBeNull();
  });
});

describe("the lane device cache", () => {
  it("remembers per lane and forgets on null", () => {
    expect(getAppleMiniPlayerLaneDevice(LANE)).toBeNull();
    noteAppleMiniPlayerLaneDevice(LANE, { udid: UDID, name: "ADE Repro", runtime: null, family: "ipad" });
    expect(getAppleMiniPlayerLaneDevice(LANE)?.family).toBe("ipad");
    expect(getAppleMiniPlayerLaneDevice("lane-2")).toBeNull();
    expect(getAppleMiniPlayerLaneDevice(null)).toBeNull();
    noteAppleMiniPlayerLaneDevice(LANE, null);
    expect(getAppleMiniPlayerLaneDevice(LANE)).toBeNull();
  });

  it("gives the floating player the family the pane was drawing", () => {
    installDeviceList("Booted");
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: null });
    noteAppleMiniPlayerLaneDevice(LANE, { udid: UDID, name: "iPad Pro", runtime: "iPadOS 26", family: "ipad" });
    handoff();
    expect(getAppleMiniPlayerTarget()).toMatchObject({ family: "ipad", deviceName: "iPad Pro" });
  });
});
