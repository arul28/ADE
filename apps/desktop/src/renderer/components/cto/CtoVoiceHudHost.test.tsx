/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { CTO_VOICE_INITIAL_STATE, type CtoVoiceStatePayload } from "../../../shared/types/ctoVoice";
import { readCallStills, resetSceneStillsForTest } from "../chat/sceneStillStore";
import {
  postSceneMessage,
  stubSceneCaptureBridge,
  stubShellRect,
} from "../chat/sceneStillTestHarness";
import { CtoVoiceHudHost } from "./CtoVoiceHudHost";

/**
 * A scene drawn during a call has exactly one chance to leave a picture: this
 * host is unmounted with the HUD the moment the call ends. These pin what the
 * still is filed WITH — the call id, which is how the finished call's card
 * finds its pictures again — because the bug they replace was a call whose only
 * answer was a view and whose card showed nothing.
 */

let callState: CtoVoiceStatePayload = { ...CTO_VOICE_INITIAL_STATE, isCallOwner: true };
const end = vi.fn(async () => {});

vi.mock("./useCtoVoiceCall", () => ({
  useCtoVoiceCall: () => ({
    state: callState,
    end,
    toggleMute: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
  }),
  useCtoVoiceAudioOwner: () => {},
}));

/** The HUD is a whole surface; this suite is about what the scene leaves behind. */
vi.mock("./CtoVoiceHud", () => ({
  CtoVoiceHud: ({ canvas }: { canvas: React.ReactNode }) => <div data-testid="hud">{canvas}</div>,
}));

let bridge: ReturnType<typeof stubSceneCaptureBridge>;

beforeEach(() => {
  resetSceneStillsForTest();
  callState = {
    ...CTO_VOICE_INITIAL_STATE,
    phase: "listening",
    callId: "call-7",
    sceneSource: '<div id="n">3</div>',
    isCallOwner: true,
  };
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => "blob:scene-hud");
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
  stubShellRect();
  bridge = stubSceneCaptureBridge({
    storeStill: async () => ({
      uri: ".ade/artifacts/computer-use/call.png",
      artifactId: "a7",
      title: "Generated view",
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSceneStillsForTest();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("CtoVoiceHudHost", () => {
  it("files the still under the call, and keeps a copy for the card", async () => {
    render(<CtoVoiceHudHost />);
    const frame = await screen.findByTestId("chat-scene-frame");
    for (const type of ["ready", "settled"]) postSceneMessage(frame, type);

    // Filed WITH the call id: that is the durable half — the card that appears
    // after the HUD is gone finds its pictures by asking for them.
    await waitFor(() => expect(bridge.storeStill).toHaveBeenCalledTimes(1));
    expect(bridge.storeStill.mock.calls[0]?.[0]).toMatchObject({
      scopeKey: "call-7",
      voiceCallId: "call-7",
    });
    // ...and a copy in this window, so the card does not wait for a round trip.
    await waitFor(() => expect(readCallStills("call-7")).toHaveLength(1));
    expect(readCallStills("call-7")[0]?.uri).toBe(".ade/artifacts/computer-use/call.png");
  });

  /**
   * No call id is no identity to file under. A fallback scope key put every
   * id-less scene on top of the same still.
   */
  it("stores nothing for a scene drawn outside a call", async () => {
    callState = { ...callState, callId: null };
    render(<CtoVoiceHudHost />);
    const frame = await screen.findByTestId("chat-scene-frame");
    for (const type of ["ready", "settled"]) postSceneMessage(frame, type);
    await waitFor(() => expect(bridge.snapshot).toHaveBeenCalledTimes(1));
    expect(bridge.storeStill).not.toHaveBeenCalled();
  });

  it("draws no canvas at all when the call has not drawn anything", () => {
    callState = { ...callState, sceneSource: null };
    render(<CtoVoiceHudHost />);
    expect(screen.queryByTestId("chat-scene")).toBeNull();
  });
});
