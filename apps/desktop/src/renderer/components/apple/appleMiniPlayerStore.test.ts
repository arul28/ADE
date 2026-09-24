/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLE_MINI_PLAYER_POSTER_TTL_MS,
  APPLE_STREAM_HANDOVER_HOLD_MS,
  closeAppleMiniPlayer,
  floatAppleMiniPlayerForChat,
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
import { useAppStore } from "../../state/appStore";

const LANE = "lane-1";
const UDID = "device-1";
const KEY = appleStreamLeaseKey({ pin: null, bound: null, laneId: LANE, deviceUdid: UDID });

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
  acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: "bound" });
  noteAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null }, { udid: UDID, name: "ADE Repro", runtime: "iOS 26.3", family: "iphone" });
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
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: "bound" });
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

  it("the hold's expiry leaves alone a second device the player moved to on the same lane", async () => {
    vi.useFakeTimers();
    const { stopStream } = installDeviceList("Booted");
    paneIsStreaming();
    handoff();
    releaseAppleStreamLease(KEY);
    // The player moves to device B on the same lane while the hold on A is live.
    const other = appleStreamLeaseKey({ pin: null, bound: null, laneId: LANE, deviceUdid: "device-2" });
    acquireAppleStreamLease(other, { laneId: LANE, deviceUdid: "device-2", pinKey: "bound" });

    await vi.advanceTimersByTimeAsync(APPLE_STREAM_HANDOVER_HOLD_MS + 1);
    expect(appleStreamLeaseCount(KEY)).toBe(0);
    expect(appleStreamLeaseCount(other)).toBe(1);
    expect(stopStream).not.toHaveBeenCalled();
  });

  it("stays quiet for a lane with no live stream", () => {
    installDeviceList("Booted");
    noteAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null }, { udid: UDID, name: "ADE Repro", runtime: null, family: "iphone" });
    expect(handoff()).toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("floats with a fallback name when the pane never cached one", () => {
    installDeviceList("Booted");
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: "bound" });
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
    expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })).toEqual({
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

describe("floating on the agent's activity", () => {
  const float = (auto: boolean, laneId: string | null = LANE) => floatAppleMiniPlayerForChat({
    laneId,
    chatSessionId: "chat-1",
    runtimePin: null,
    auto,
  });

  it("floats the chat's lane device by default, asking the runtime which one it is", async () => {
    const { deviceList } = installDeviceList("Booted");
    await expect(float(true)).resolves.toBe(true);
    expect(deviceList).toHaveBeenCalledWith({ laneId: LANE, installed: true }, null);
    expect(getAppleMiniPlayerTarget()).toMatchObject({ laneId: LANE, chatSessionId: "chat-1", deviceUdid: UDID });
  });

  it("stays down while the chat's preview is off, and after × on the player", async () => {
    installDeviceList("Booted");
    setWorkLivePreviewEnabledForChat("chat-1", "ios", false);
    await expect(float(true)).resolves.toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();

    setWorkLivePreviewEnabledForChat("chat-1", "ios", true);
    await expect(float(true)).resolves.toBe(true);
    closeAppleMiniPlayer();
    await expect(float(true)).resolves.toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("an explicit ask opens it anyway and turns the chat's preview back on", async () => {
    installDeviceList("Booted");
    setWorkLivePreviewEnabledForChat("chat-1", "ios", false);
    await expect(float(false)).resolves.toBe(true);
    expect(getAppleMiniPlayerTarget()).not.toBeNull();
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "ios")).toBe(true);
  });

  it("never floats a device that is off on its own, or for a lane with no device", async () => {
    installDeviceList("Shutdown");
    await expect(float(true)).resolves.toBe(false);
    // Not even when the pane's cache still names it: the cache outlives a
    // power-off, so the automatic path always asks.
    noteAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null }, { udid: UDID, name: "ADE Repro", runtime: "iOS 26.3", family: "iphone" });
    await expect(float(true)).resolves.toBe(false);
    installDeviceList(null);
    await expect(float(true)).resolves.toBe(false);
    await expect(float(true, null)).resolves.toBe(false);
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("an explicit ask floats an off device, which then shows its own Off state", async () => {
    installDeviceList("Shutdown");
    await expect(float(false)).resolves.toBe(true);
    expect(getAppleMiniPlayerTarget()).toMatchObject({ deviceUdid: UDID });
  });

  it("does not replace a player another lane's device is using unless asked", async () => {
    installDeviceList("Booted");
    openAppleMiniPlayer({
      laneId: "lane-2",
      chatSessionId: "chat-2",
      deviceUdid: "device-2",
      deviceName: "Other",
      deviceRuntime: null,
      family: "iphone",
      runtimePin: null,
    });
    await expect(float(true)).resolves.toBe(false);
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe("device-2");
    await expect(float(false)).resolves.toBe(true);
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe(UDID);
  });
});

describe("floating on another machine's lane of the same id", () => {
  const STUDIO = { kind: "local", key: "local:/studio", rootPath: "/studio", displayName: "studio" } as const;

  /* Regression (A2-7): the same lane id on another machine is not "already
   * floating here", and its cached device is not this lane's. */
  it("is not already floating, and does not reuse the other machine's cached device", async () => {
    const { deviceList } = installDeviceList("Booted");
    openAppleMiniPlayer({
      laneId: LANE,
      chatSessionId: "chat-1",
      deviceUdid: "studio-device",
      deviceName: "Studio",
      deviceRuntime: null,
      family: "iphone",
      runtimePin: STUDIO,
    });
    noteAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: STUDIO }, { udid: "studio-device", name: "Studio", runtime: null, family: "iphone" });
    // An automatic float does not replace a player it does not own.
    await expect(floatAppleMiniPlayerForChat({ laneId: LANE, chatSessionId: "chat-1", runtimePin: null, auto: true }))
      .resolves.toBe(false);
    // An explicit ask asks this machine which device the lane holds.
    await expect(floatAppleMiniPlayerForChat({ laneId: LANE, chatSessionId: "chat-1", runtimePin: null, auto: false }))
      .resolves.toBe(true);
    expect(deviceList).toHaveBeenCalledWith({ laneId: LANE, installed: true }, null);
    expect(getAppleMiniPlayerTarget()?.deviceUdid).toBe(UDID);
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
    expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })).toBeNull();
    noteAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null }, { udid: UDID, name: "ADE Repro", runtime: null, family: "ipad" });
    expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })?.family).toBe("ipad");
    expect(getAppleMiniPlayerLaneDevice({ laneId: "lane-2", runtimePin: null })).toBeNull();
    expect(getAppleMiniPlayerLaneDevice({ laneId: null, runtimePin: null })).toBeNull();
    noteAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null }, null);
    expect(getAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null })).toBeNull();
  });

  it("gives the floating player the family the pane was drawing", () => {
    installDeviceList("Booted");
    acquireAppleStreamLease(KEY, { laneId: LANE, deviceUdid: UDID, pinKey: "bound" });
    noteAppleMiniPlayerLaneDevice({ laneId: LANE, runtimePin: null }, { udid: UDID, name: "iPad Pro", runtime: "iPadOS 26", family: "ipad" });
    handoff();
    expect(getAppleMiniPlayerTarget()).toMatchObject({ family: "ipad", deviceName: "iPad Pro" });
  });
});

describe("openAppleMiniPlayer machine binding", () => {
  it("keeps the device's machine after the window switches machines", () => {
    // A Studio device floated with runtimePin null, meaning "the bound
    // machine". The window then switched to a MacBook project, the null pin
    // started naming the MacBook, and the player floated a black box.
    const studio = { kind: "local", key: "local:/studio/ADE", rootPath: "/studio/ADE", displayName: "ADE" } as const;
    const macbook = {
      kind: "remote",
      key: "remote:macbook:project",
      targetId: "macbook",
      runtimeName: "MacBook Pro",
      transport: "paired",
      projectId: "project",
      rootPath: "/Users/arul/ADE",
      displayName: "ADE",
    } as const;
    const previous = useAppStore.getState().projectBinding;
    useAppStore.setState({ projectBinding: studio });
    try {
      openAppleMiniPlayer({
        laneId: LANE,
        chatSessionId: null,
        deviceUdid: UDID,
        deviceName: "ADE Repro",
        deviceRuntime: "iOS 26.3",
        family: "iphone",
        runtimePin: null,
      });
      useAppStore.setState({ projectBinding: macbook });

      expect(getAppleMiniPlayerTarget()?.runtimePin).toEqual(studio);
    } finally {
      useAppStore.setState({ projectBinding: previous });
    }
  });

  it("keeps an explicit pin as given", () => {
    const pin = { kind: "local", key: "local:/x", rootPath: "/x", displayName: "X" } as const;
    openAppleMiniPlayer({
      laneId: LANE,
      chatSessionId: null,
      deviceUdid: UDID,
      deviceName: "iPhone",
      deviceRuntime: null,
      family: "iphone",
      runtimePin: pin,
    });
    expect(getAppleMiniPlayerTarget()?.runtimePin).toBe(pin);
  });
});

