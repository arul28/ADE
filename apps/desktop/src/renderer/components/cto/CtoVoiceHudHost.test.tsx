/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { CTO_VOICE_INITIAL_STATE, type CtoVoiceStatePayload } from "../../../shared/types/ctoVoice";
import { readCallStills, resetSceneStillsForTest } from "../chat/sceneStillStore";
import { CtoVoiceHudHost } from "./CtoVoiceHudHost";

/**
 * A scene drawn during a call has exactly one chance to leave a picture: this
 * host is unmounted with the HUD the moment the call ends. These pin the
 * forwarding — the still reaches both the store the transcript card reads and
 * the call that writes the CTO's durable record — because the bug they replace
 * was a call whose only answer was a view and whose card showed nothing.
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

const attachStill = vi.fn(async (_args: { still: { uri: string } }) => {});

beforeEach(() => {
  attachStill.mockClear();
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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, width: 400, height: 200, bottom: 200, right: 400,
  } as DOMRect);
  (window as unknown as { ade?: unknown }).ade = {
    scene: {
      snapshot: vi.fn(async () => "data:image/png;base64,STILL"),
      storeStill: vi.fn(async () => ({
        uri: ".ade/artifacts/computer-use/call.png",
        artifactId: "a7",
        title: "Generated view",
      })),
    },
    ctoVoice: { attachStill },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSceneStillsForTest();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("CtoVoiceHudHost", () => {
  it("keeps the still of a scene the call drew, on both sides of the HUD's lifetime", async () => {
    render(<CtoVoiceHudHost />);
    const frame = await screen.findByTestId("chat-scene-frame");
    for (const type of ["ready", "settled"]) {
      window.dispatchEvent(new MessageEvent("message", {
        source: (frame as HTMLIFrameElement).contentWindow,
        data: { __adeScene: 1, type, payload: { height: 200 } },
      }));
    }

    // The store is what the transcript card reads back...
    await waitFor(() => expect(readCallStills("call-7")).toHaveLength(1));
    expect(readCallStills("call-7")[0]?.uri).toBe(".ade/artifacts/computer-use/call.png");
    // ...and the call is what carries it into the CTO's record of the call.
    await waitFor(() => expect(attachStill).toHaveBeenCalledTimes(1));
    expect(attachStill.mock.calls[0]?.[0]).toEqual({
      still: { uri: ".ade/artifacts/computer-use/call.png", artifactId: "a7", title: "Generated view" },
    });
  });

  it("draws no canvas at all when the call has not drawn anything", () => {
    callState = { ...callState, sceneSource: null };
    render(<CtoVoiceHudHost />);
    expect(screen.queryByTestId("chat-scene")).toBeNull();
  });
});
