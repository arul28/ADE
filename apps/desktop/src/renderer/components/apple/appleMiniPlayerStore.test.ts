/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeAppleMiniPlayer,
  getAppleMiniPlayerTarget,
  handoffAppleMiniPlayer,
  isAppleMiniPlayerDismissed,
  openAppleMiniPlayer,
  resetAppleMiniPlayerForTests,
  retakeAppleMiniPlayer,
  suppressAppleMiniPlayerHandoff,
} from "./appleMiniPlayerStore";
import {
  isWorkLivePreviewEnabled,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";

const LANE = "lane-1";
const UDID = "device-1";

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
    lane: {
      laneId: LANE,
      udid: UDID,
      name: "ADE Repro",
      origin: "attached",
      family: "iphone",
      runtime: "iOS 26.3",
      createdAt: new Date(0).toISOString(),
      templateUdid: null,
    },
  }));
  (window as unknown as { ade: unknown }).ade = { iosSimulator: { deviceList } };
  return deviceList;
}

const handoff = () => handoffAppleMiniPlayer({ laneId: LANE, chatSessionId: "chat-1", runtimePin: null });

afterEach(() => {
  resetAppleMiniPlayerForTests();
  window.localStorage.clear();
  resetChatCompanionUiStateCacheForTests();
  vi.clearAllMocks();
});

describe("handoffAppleMiniPlayer", () => {
  it("floats a live device when the tools pane closes on it", async () => {
    // Round 3, A4: closing the pane used to leave a running simulator with
    // nothing on screen — no picture, no controls, no sign it was still up.
    installDeviceList("Booted");
    await handoff();
    expect(getAppleMiniPlayerTarget()).toMatchObject({
      deviceUdid: UDID,
      deviceName: "ADE Repro",
      laneId: LANE,
      family: "iphone",
    });
  });

  it("stays quiet for a device that is not running", async () => {
    installDeviceList("Shutdown");
    await handoff();
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("stays quiet for a lane that owns no device", async () => {
    installDeviceList(null);
    await handoff();
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  it("never floats a device the user closed the player for", async () => {
    installDeviceList("Booted");
    await handoff();
    closeAppleMiniPlayer(UDID);
    expect(isAppleMiniPlayerDismissed(UDID)).toBe(true);

    await handoff();
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

  it("taking the device back into the pane is not a dismissal", async () => {
    installDeviceList("Booted");
    await handoff();
    retakeAppleMiniPlayer(UDID);

    expect(getAppleMiniPlayerTarget()).toBeNull();
    expect(isAppleMiniPlayerDismissed(UDID)).toBe(false);
    await handoff();
    expect(getAppleMiniPlayerTarget()).not.toBeNull();
  });

  /**
   * A4 forbids a parallel store: × on the player and the "Show preview when
   * minimized" toggle in the tool's header are the SAME per-chat marker, so a
   * close here must be visible to the toggle and vice versa.
   */
  it("× writes the chat's shared preview marker, and the toggle clears it", async () => {
    installDeviceList("Booted");
    await handoff();
    closeAppleMiniPlayer(UDID);
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "ios")).toBe(false);

    await handoff();
    expect(getAppleMiniPlayerTarget()).toBeNull();

    // The header toggle, turned back on: the next minimize floats again.
    setWorkLivePreviewEnabledForChat("chat-1", "ios", true);
    expect(isWorkLivePreviewEnabled(readChatCompanionUiState("chat-1"), "ios")).toBe(true);
    await handoff();
    expect(getAppleMiniPlayerTarget()).not.toBeNull();
  });

  it("the toggle turned off keeps the pane from floating at all", async () => {
    installDeviceList("Booted");
    setWorkLivePreviewEnabledForChat("chat-1", "ios", false);
    await handoff();
    expect(getAppleMiniPlayerTarget()).toBeNull();
  });

  /**
   * Closing the TAB and closing the PANE unmount the same panel. Only the
   * second is a minimize; the first is a shutdown, and a `deviceList` that has
   * not caught up yet would otherwise float a device on its way down.
   */
  it("a tab close suppresses exactly one handoff", async () => {
    installDeviceList("Booted");
    suppressAppleMiniPlayerHandoff();
    await handoff();
    expect(getAppleMiniPlayerTarget()).toBeNull();

    // …and no more than one: the next real minimize still floats.
    await handoff();
    expect(getAppleMiniPlayerTarget()).not.toBeNull();
  });

  it("does not replace a player that is already floating", async () => {
    const deviceList = installDeviceList("Booted");
    await handoff();
    await handoff();
    expect(deviceList).toHaveBeenCalledTimes(1);
  });
});
