/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenProjectBinding } from "../../../shared/types";

import {
  MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
  MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY,
  MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS,
  acquireMacDesktopLiveViewLease,
  macDesktopLiveViewLeaseState,
  resetMacDesktopLiveViewLeasesForTests,
} from "./macDesktopLiveViewLease";

const stopStream = vi.fn(async () => ({
  laneId: "lane-1",
  running: false,
  fps: 0,
  idle: false,
  bitrateKbps: null,
  transport: null,
  lastError: null,
  clients: 0,
  viewerChatSessionIds: [],
}));

/** Lets every viewer stop that is waiting out its grace go to the service. */
function passGrace(): void {
  vi.advanceTimersByTime(MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS + 10);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetMacDesktopLiveViewLeasesForTests();
  stopStream.mockClear();
  (window as unknown as { ade: unknown }).ade = { macDesktop: { stopStream } };
});

afterEach(() => {
  resetMacDesktopLiveViewLeasesForTests();
  vi.useRealTimers();
});

describe("macDesktopLiveViewLease", () => {
  it("makes the first holder the decoder owner", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    expect(pane.ownsDecoder()).toBe(true);
    expect(macDesktopLiveViewLeaseState("lane-1")).toEqual({ holders: 1, decoderOwnerId: 1 });
    pane.release();
  });

  it("keeps the card passive while the pane holds the lane", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    const cardChanges: boolean[] = [];
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
      onDecoderOwnershipChange: (owns) => cardChanges.push(owns),
    });
    expect(pane.ownsDecoder()).toBe(true);
    expect(card.ownsDecoder()).toBe(false);
    expect(cardChanges).toEqual([]);
    pane.release();
    card.release();
  });

  it("promotes the remaining holder when the pane releases, without stopping the stream", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    const cardChanges: boolean[] = [];
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
      onDecoderOwnershipChange: (owns) => cardChanges.push(owns),
    });

    pane.release();
    // The hand-off is the whole point: the card is told to start decoding and
    // the encoder is never asked to stop while anyone still holds the lane.
    expect(cardChanges).toEqual([true]);
    expect(card.ownsDecoder()).toBe(true);
    passGrace();
    expect(stopStream).not.toHaveBeenCalled();

    card.release();
    expect(macDesktopLiveViewLeaseState("lane-1")).toBeNull();
    // The last viewer's stop waits out the grace, then says only "I left".
    expect(stopStream).not.toHaveBeenCalled();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: null, localViewer: true }, null);
  });

  it("lets a reopened pane take the decoder back from the card", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    const cardChanges: boolean[] = [];
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
      onDecoderOwnershipChange: (owns) => cardChanges.push(owns),
    });
    pane.release();
    expect(card.ownsDecoder()).toBe(true);

    const reopenedPaneChanges: boolean[] = [];
    const reopenedPane = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY,
      onDecoderOwnershipChange: (owns) => reopenedPaneChanges.push(owns),
    });
    // Highest priority wins, so the card is demoted instead of holding a
    // decoder the pane cannot draw into.
    expect(reopenedPaneChanges).toEqual([true]);
    expect(cardChanges).toEqual([true, false]);
    expect(reopenedPane.ownsDecoder()).toBe(true);
    expect(card.ownsDecoder()).toBe(false);

    reopenedPane.release();
    expect(cardChanges).toEqual([true, false, true]);
    expect(card.ownsDecoder()).toBe(true);
    passGrace();
    expect(stopStream).not.toHaveBeenCalled();
    card.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);
  });

  it("keeps two lanes independent", () => {
    const a = acquireMacDesktopLiveViewLease({ laneId: "lane-a" });
    const b = acquireMacDesktopLiveViewLease({ laneId: "lane-b" });
    expect(a.ownsDecoder()).toBe(true);
    expect(b.ownsDecoder()).toBe(true);
    a.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledWith({ laneId: "lane-a", chatSessionId: null, localViewer: true }, null);
    expect(b.ownsDecoder()).toBe(true);
    b.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(2);
  });

  it("is inert after release, so a double release cannot free someone else's stream", () => {
    const first = acquireMacDesktopLiveViewLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    first.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);

    const second = acquireMacDesktopLiveViewLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    expect(second.ownsDecoder()).toBe(true);
    first.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(second.ownsDecoder()).toBe(true);
    second.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(2);
  });

  it("regression: a viewer arriving inside the grace joins the capture instead of stopping it", () => {
    // The card can go a beat before the pane mounts. Stopping at once cut the
    // capture in that gap, and the pane had to open a new one.
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
    });
    card.release();
    vi.advanceTimersByTime(MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS / 2);
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    passGrace();
    passGrace();
    expect(stopStream).not.toHaveBeenCalled();
    expect(macDesktopLiveViewLeaseState("lane-1")?.holders).toBe(1);
    pane.release();
  });

  it("tells the service once when both viewers of one chat leave inside the grace", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1", chatSessionId: "chat-1" });
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
    });
    pane.release();
    vi.advanceTimersByTime(MAC_DESKTOP_LIVE_VIEW_STOP_GRACE_MS / 2);
    card.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-1", localViewer: true }, null);
  });

  it("drops a chat from the viewer list when its viewer leaves, while the lane stays up", () => {
    // The floating card authorizes a chat by the service's viewer list, so a
    // chat that looked once must not stay on it after its viewer is gone.
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1", chatSessionId: "chat-a" });
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      chatSessionId: " chat-b ",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
    });
    pane.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-a", localViewer: true }, null);

    // Another holder of the same chat keeps that chat on the list.
    const second = acquireMacDesktopLiveViewLease({ laneId: "lane-1", chatSessionId: "chat-b" });
    card.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);
    second.release();
    passGrace();
    expect(stopStream).toHaveBeenLastCalledWith({ laneId: "lane-1", chatSessionId: "chat-b", localViewer: true }, null);
  });

  it("keeps the pane and the card in one bucket whatever pin each one carries", () => {
    // The Apple tool's 2026-09-23 bug: the pane keyed by its null pin and the
    // floating player by the resolved binding, so each one was the "last
    // viewer" of its own bucket. The Mac Desktop lease keys by lane only.
    const resolved = { kind: "local", key: "local:/repo" } as unknown as OpenProjectBinding;
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
      runtimePin: resolved,
    });
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1", chatSessionId: "chat-1", runtimePin: null });
    expect(macDesktopLiveViewLeaseState("lane-1")).toEqual({ holders: 2, decoderOwnerId: 2 });
    expect(card.ownsDecoder()).toBe(false);

    card.release();
    passGrace();
    expect(stopStream).not.toHaveBeenCalled();
    pane.release();
    passGrace();
    expect(stopStream).toHaveBeenCalledTimes(1);
  });
});
