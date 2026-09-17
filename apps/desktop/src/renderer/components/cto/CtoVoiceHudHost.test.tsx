/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { sceneScopeKeyFor } from "../../../shared/chatScene";
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
/** Each filing gets its own uri, the way a real store hands one back. */
let stored = 0;

beforeEach(() => {
  resetSceneStillsForTest();
  stored = 0;
  callState = {
    ...CTO_VOICE_INITIAL_STATE,
    phase: "listening",
    callId: "call-7",
    sessionId: "cto-session-1",
    sceneSource: '<div id="n">3</div>',
    isCallOwner: true,
  };
  // A distinct blob url per document: a constant one made a source swap look
  // like no change at all, so the frame never rearmed its capture.
  let blobs = 0;
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL =
    vi.fn(() => `blob:scene-hud-${++blobs}`);
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
  stubShellRect();
  bridge = stubSceneCaptureBridge({
    storeStill: async () => ({
      uri: `.ade/artifacts/computer-use/call-${++stored}.png`,
      artifactId: `a${stored}`,
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
      // Keyed per VIEW — see the two-views test below — and carrying the bare
      // call id, which is what the finished call's card asks by.
      scopeKey: sceneScopeKeyFor("call-7", '<div id="n">3</div>'),
      voiceCallId: "call-7",
      // The OWNER, and the reason the call state carries a session id at all.
      // This host is mounted at the shell, outside every `ChatRuntimeScope`,
      // so the frame's own scope answers null: the still was filed with no
      // owner, which skips both disk bounds and leaves the finished call's
      // "Views drawn" section — an owner query — with nothing to find.
      sessionId: "cto-session-1",
    });
    // ...and a copy in this window, so the card does not wait for a round trip.
    await waitFor(() => expect(readCallStills("call-7")).toHaveLength(1));
    expect(readCallStills("call-7")[0]?.uri).toBe(".ade/artifacts/computer-use/call-1.png");
  });

  /**
   * A call draws several views over its length and the card shows all of them.
   *
   * This host keeps ONE mounted frame for the whole call and swaps its source
   * each time the CTO draws, and main keeps one still per scope key — so a key
   * that was the bare call id meant filing view two DELETED view one: the call
   * record named a single view and the live card drew broken tiles. The key is
   * per view; the call id stays the call id.
   */
  it("keeps a picture of every view the call draws", async () => {
    const { rerender } = render(<CtoVoiceHudHost />);
    const first = await screen.findByTestId("chat-scene-frame");
    act(() => { for (const type of ["ready", "settled"]) postSceneMessage(first, type); });
    await waitFor(() => expect(bridge.storeStill).toHaveBeenCalledTimes(1));

    callState = { ...callState, sceneSource: '<div id="n">4</div>' };
    rerender(<CtoVoiceHudHost />);
    const second = await screen.findByTestId("chat-scene-frame");
    await waitFor(() => expect(second.getAttribute("src")).toBe("blob:scene-hud-2"));
    act(() => { postSceneMessage(second, "settled"); });
    await waitFor(() => expect(bridge.storeStill).toHaveBeenCalledTimes(2));

    const filed = bridge.storeStill.mock.calls
      .map((call) => call[0] as { scopeKey: string; voiceCallId: string });
    // Two views, two identities — and both still belong to the one call.
    expect(new Set(filed.map((entry) => entry.scopeKey)).size).toBe(2);
    expect(filed.every((entry) => entry.voiceCallId === "call-7")).toBe(true);
    // ...so the card that appears after the HUD is gone has both pictures.
    await waitFor(() => expect(readCallStills("call-7")).toHaveLength(2));
  });

  /** The same view drawn again is the same identity, and supersedes itself. */
  it("gives a redrawn view the key it already had", () => {
    const source = '<div id="n">3</div>';
    expect(sceneScopeKeyFor("call-7", source)).toBe(sceneScopeKeyFor("call-7", source));
    expect(sceneScopeKeyFor("call-7", source)).not.toBe(sceneScopeKeyFor("call-7", "<p>other</p>"));
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
